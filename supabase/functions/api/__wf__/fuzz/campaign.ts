// Deterministic adversarial campaign against the real edge handler.
//
// A case is fully determined by (seed, index): the same pair rebuilds the
// same method/url/headers/body bytes, so every failure is replayable with
//   deno run -A fuzz/run.ts --replay <seed>:<index>
// Time-dependent material (token `exp`) is fixed once per process from
// `CampaignOptions.epochSeconds` and written into the manifest.

import { captureAccessLog } from "../../http.ts";
import { type Harness, WEBHOOK_SECRET } from "../routesHarness.ts";
import { caseLabel, Prng } from "./prng.ts";
import {
  hostileAuthorization,
  hostileHeaderValue,
  hostileKey,
  hostilePathSegment,
  hostileString,
  hostileValue,
  invalidUtf8Bytes,
  oversizedBodyText,
  PROTO_KEYS,
  protoPollutionObject,
  rawMalformedBody,
  toHeaderSafe,
} from "./generators.ts";
import {
  type FuzzUser,
  isUuid,
  KNOWN_PATHS,
  PUBLIC_PREFIX,
  REJECT_STATUSES,
  ROUTES,
  type RouteSpec,
  V1_PREFIX,
  validShot,
  validTrial,
  type Verdict,
} from "./routes.ts";
import { type ClassifiedCall, type FuzzUpstream, WRITE_KINDS } from "./upstream.ts";

export const MAX_JSON_BODY_BYTES = 5_000_000;
const ORIGIN = "https://edge.fuzz.test";
const SUPABASE_ISS = "http://supabase.test/auth/v1";

export const STRATEGIES = [
  "baseline",
  "body.required",
  "body.entry",
  "body.optional",
  "body.extra",
  "body.raw",
  "body.oversized",
  "body.length_spoof",
  "body.invalid_utf8",
  "body.stream",
  "path.hostile",
  "route.unknown",
  "route.method",
  "auth.hostile",
  "header.hostile",
  "query.hostile",
] as const;
export type Strategy = (typeof STRATEGIES)[number];

const STRATEGY_WEIGHTS: ReadonlyArray<readonly [number, Strategy]> = [
  [6, "baseline"],
  [20, "body.required"],
  [8, "body.entry"],
  [8, "body.optional"],
  [8, "body.extra"],
  [10, "body.raw"],
  [1.5, "body.oversized"],
  [1.5, "body.length_spoof"],
  [1.5, "body.invalid_utf8"],
  [1, "body.stream"],
  [8, "path.hostile"],
  [5, "route.unknown"],
  [3, "route.method"],
  [8, "auth.hostile"],
  [6, "header.hostile"],
  [4.5, "query.hostile"],
];

export type BodySpec =
  | { kind: "none" }
  | { kind: "text"; text: string; description: string }
  | { kind: "bytes"; bytes: Uint8Array; description: string }
  | { kind: "stream"; text: string; chunk: number; description: string };

export interface CaseSpec {
  seed: string;
  index: number;
  label: string;
  strategy: Strategy;
  routeId: string;
  user: FuzzUser;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: BodySpec;
  /** What the server's readBody() would yield (for the oracle). */
  serverBody: Record<string, unknown>;
  pathParam: string | null;
  verdict: Verdict;
  notes: string[];
}

export interface CaseResult {
  index: number;
  label: string;
  strategy: Strategy;
  routeId: string;
  method: string;
  url: string;
  urlBytes: number;
  bodyBytes: number;
  bodyDescription: string;
  verdict: Verdict["kind"];
  verdictReason: string;
  expectedStatuses: readonly number[];
  status: number | null;
  durationMs: number;
  requestId: string | null;
  contentType: string | null;
  responseBytes: number;
  upstreamCalls: number;
  writes: string[];
  accessLog: { status: number; route: string; requestId: string } | null;
  consoleLines: number;
  failures: string[];
  anomalies: string[];
}

export interface FailureRecord {
  result: CaseResult;
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: { kind: string; description: string; bytes: number; sha256: string; preview: string };
  };
  response: { status: number | null; headers: Record<string, string>; bodyPreview: string } | null;
  error: string | null;
  upstream: ClassifiedCall[];
  console: string[];
  replay: string;
}

export interface CampaignOptions {
  seed: string;
  count: number;
  startIndex?: number;
  epochSeconds: number;
  users?: number;
  /** Called after every case; use for progress/heap sampling. */
  onCase?(result: CaseResult, index: number): void;
}

const LEAK_RE =
  /(\bat\s+[\w$.<>]+\s*\((?:file|https?|ext|node|deno|jsr|npm):[^)]*\)|\n\s+at\s+|TypeError|ReferenceError|RangeError|SyntaxError|Deno\.\w+|file:\/\/|\/functions\/api\/\w+\.ts|postgres|PGRST\d{3}|service[_ -]role|SUPABASE_|REVENUECAT_|APPLE_SIGN_IN|permission denied|relation ".*" does not exist|duplicate key value|violates (?:check|foreign key|not-null|unique) constraint|Unexpected token|JSON\.parse|is not a function|Cannot read propert|undefined is not|Maximum call stack)/i;

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

// ─── Tokens ──────────────────────────────────────────────────────────────────

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function sessionJwt(user: FuzzUser, epochSeconds: number): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: SUPABASE_ISS,
      sub: user.id,
      aud: "authenticated",
      role: "authenticated",
      exp: epochSeconds + 6 * 3600,
      iat: epochSeconds,
      session_id: `fuzz-${user.id.slice(0, 8)}`,
    }),
  );
  return `${header}.${payload}.fuzz-signature`;
}

/** Provider ID tokens pinned to the campaign epoch (the routesHarness
 * builders stamp Date.now(), which would make replays byte-different). */
function providerIdToken(
  provider: "apple" | "google",
  user: FuzzUser,
  epochSeconds: number,
): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: provider === "apple" ? "https://appleid.apple.com" : "https://accounts.google.com",
      sub: user.id,
      exp: epochSeconds + 6 * 3600,
    }),
  );
  return `${header}.${payload}.sig`;
}

function anyProviderIdToken(rng: Prng, user: FuzzUser, epochSeconds: number): string {
  return providerIdToken(rng.bool() ? "google" : "apple", user, epochSeconds);
}

/** Would the fuzz auth fixture accept this Authorization header? Mirrors the
 * server's shape checks + upstream.ts verifiedSubject so the oracle knows
 * when a "hostile" header is in fact a well-formed unsigned token. */
function fixtureWouldAuthenticate(authorization: string, epochSeconds: number): boolean {
  if (!authorization.startsWith("Bearer ")) return false;
  const token = authorization.slice(7).trim();
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const raw = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(raw + "=".repeat((4 - (raw.length % 4)) % 4))) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    const p = payload as Record<string, unknown>;
    const iss = typeof p.iss === "string" ? p.iss : "";
    const knownIssuer =
      iss === "https://accounts.google.com" ||
      iss === "accounts.google.com" ||
      iss === "https://appleid.apple.com" ||
      iss.endsWith("/auth/v1");
    return (
      knownIssuer &&
      isUuid(p.sub) &&
      typeof p.exp === "number" &&
      Number.isFinite(p.exp) &&
      p.exp > epochSeconds
    );
  } catch {
    return false;
  }
}

// ─── Users / network identity ────────────────────────────────────────────────

export function makeUsers(seed: string, count: number): FuzzUser[] {
  const rng = new Prng(`fuzz-edge:${seed}:users`);
  return Array.from({ length: count }, (_, i) => ({
    id: rng.uuid(),
    ip: `198.51.100.${(i % 254) + 1}`,
  }));
}

// ─── Case construction ───────────────────────────────────────────────────────

const utf8 = new TextEncoder();
const byteLength = (text: string): number => utf8.encode(text).byteLength;

/** encodeURIComponent that survives lone surrogates (they become an invalid
 * %XXXX escape, which is itself a useful hostile input). */
function safeEncode(value: string): string {
  try {
    return encodeURIComponent(value);
  } catch {
    return Array.from(value, (ch) => {
      try {
        return encodeURIComponent(ch);
      } catch {
        return `%${ch.charCodeAt(0).toString(16)}`;
      }
    }).join("");
  }
}

/** What readBody() yields: request.text() decodes UTF-8 and drops a leading
 * BOM; malformed / non-object JSON collapses to {}. */
function serverView(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text.replace(/^\ufeff/, "")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function textBody(value: unknown, description: string): BodySpec {
  return { kind: "text", text: JSON.stringify(value), description };
}

function baseHeaders(
  route: RouteSpec,
  user: FuzzUser,
  rng: Prng,
  epochSeconds: number,
): Record<string, string> {
  const headers: Record<string, string> = {
    "x-forwarded-for": user.ip,
    "user-agent": "PickleSensei/1.2.3 (iPhone; iOS 18.6) fuzz",
    accept: "application/json",
  };
  switch (route.auth) {
    case "session":
      headers.authorization = rng.bool(0.8)
        ? `Bearer ${sessionJwt(user, epochSeconds)}`
        : `Bearer ${anyProviderIdToken(rng, user, epochSeconds)}`;
      break;
    case "provider":
      headers.authorization = `Bearer ${anyProviderIdToken(rng, user, epochSeconds)}`;
      break;
    case "webhook":
      headers.authorization = WEBHOOK_SECRET;
      break;
    case "none":
      break;
  }
  return headers;
}

const routesWith = (predicate: (route: RouteSpec) => boolean): RouteSpec[] =>
  ROUTES.filter(predicate);
const BODY_ROUTES = routesWith((r) => r.body !== undefined);
const REQUIRED_ROUTES = routesWith((r) => r.requiredKeys.length > 0);
const OPTIONAL_ROUTES = routesWith((r) => r.optionalKeys.length > 0);
const ENTRY_ROUTES = routesWith(
  (r) => r.id === "POST /v1/shots:sync" || r.id === "POST /v1/me/evaluation/trials",
);
const PARAM_ROUTES = routesWith((r) => r.pathParam !== undefined);
const AUTHED_ROUTES = routesWith((r) => r.auth !== "none");
const GET_ROUTES = routesWith((r) => r.method === "GET" || r.method === "HEAD");
const BOOTSTRAP_ROUTE_ID = "POST /v1/account/bootstrap";
/** Routes whose handler calls readBody(); bootstrap only reads it for Apple
 * sign-ins (index.ts bootstrapAccount). Handlers that never touch the body
 * cannot trip the byte cap unless Content-Length is declared. */
const readsBody = (route: RouteSpec): boolean => {
  if (route.method === "GET" || route.method === "HEAD") return false;
  return (
    route.id !== "POST /v1/auth/logout" &&
    route.id !== "POST /v1/billing/sync" &&
    route.id !== "POST /v1/training-plans" &&
    route.id !== "POST /v1/sessions/:id/finalize" &&
    !route.id.includes("saved-drills")
  );
};
const READS_BODY_ROUTES = BODY_ROUTES.filter(readsBody);

/** Pick a body-reading route for the byte-cap strategies. Bootstrap reads the
 * body only on the Apple path, so it is forced onto an Apple ID token; that
 * path also re-stamps the caller's own profile provider BEFORE reading the
 * body (bootstrapAccount), which is the one write the cap can never prevent. */
function bodyCapRoute(
  rng: Prng,
  user: FuzzUser,
  headers: Record<string, string>,
  epochSeconds: number,
  notes: string[],
): { route: RouteSpec; headers: Record<string, string>; capWrites: string[] } {
  const route = rng.pick(READS_BODY_ROUTES);
  const built = { ...headers, ...baseHeaders(route, user, rng, epochSeconds) };
  if (route.id !== BOOTSTRAP_ROUTE_ID) return { route, headers: built, capWrites: [] };
  built.authorization = `Bearer ${providerIdToken("apple", user, epochSeconds)}`;
  notes.push("bootstrap forced onto the Apple path (the only one that reads the body)");
  return { route, headers: built, capWrites: ["table:profiles"] };
}

/** Mutate `body[key]` (or delete it) with a hostile value. */
function mutateKey(rng: Prng, body: Record<string, unknown>, key: string, notes: string[]): void {
  const mode = rng.weighted<"delete" | "null" | "hostile" | "wrongType" | "nested">([
    [1, "delete"],
    [1, "null"],
    [5, "hostile"],
    [2, "wrongType"],
    [1, "nested"],
  ]);
  switch (mode) {
    case "delete":
      delete body[key];
      notes.push(`${key}: deleted`);
      return;
    case "null":
      body[key] = null;
      notes.push(`${key}: null`);
      return;
    case "hostile":
      body[key] = hostileValue(rng);
      notes.push(`${key}: hostileValue`);
      return;
    case "wrongType": {
      const current = body[key];
      body[key] =
        typeof current === "string"
          ? rng.pick<unknown>([0, -1, 1e308, true, [], {}, ["a"], { a: 1 }])
          : hostileString(rng, { maxLength: 4096 });
      notes.push(`${key}: wrongType`);
      return;
    }
    case "nested":
      body[key] = { [key]: body[key], ...protoPollutionObject(rng) };
      notes.push(`${key}: wrapped+proto`);
      return;
  }
}

/** Mutate fields inside a shots/trials entry (or the entry itself). */
function mutateEntry(rng: Prng, entry: Record<string, unknown>, notes: string[]): unknown {
  if (rng.bool(0.15)) {
    const replacement = hostileValue(rng);
    notes.push("entry: replaced");
    return replacement;
  }
  const keys = Object.keys(entry);
  const count = rng.int(1, 3);
  for (let i = 0; i < count; i += 1) {
    const key = rng.pick(keys);
    const value = entry[key];
    if (value && typeof value === "object" && !Array.isArray(value) && rng.bool(0.6)) {
      const inner = value as Record<string, unknown>;
      const innerKeys = Object.keys(inner);
      if (innerKeys.length > 0) {
        const innerKey = rng.pick(innerKeys);
        mutateKey(rng, inner, innerKey, notes);
        notes.push(`entry.${key}.${innerKey}`);
        continue;
      }
    }
    if (Array.isArray(value) && value.length > 0 && rng.bool(0.6)) {
      const item = value[rng.int(0, value.length - 1)];
      if (
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        Object.keys(item).length > 0
      ) {
        const rec = item as Record<string, unknown>;
        const innerKey = rng.pick(Object.keys(rec));
        mutateKey(rng, rec, innerKey, notes);
        notes.push(`entry.${key}[].${innerKey}`);
        continue;
      }
    }
    mutateKey(rng, entry, key, notes);
    notes.push(`entry.${key}`);
  }
  return entry;
}

function hostileQuery(rng: Prng, keys: readonly string[]): string {
  const params: string[] = [];
  const n = rng.int(1, 6);
  for (let i = 0; i < n; i += 1) {
    const key = rng.weighted<string>([
      [3, keys.length > 0 ? rng.pick(keys) : "q"],
      [1, rng.pick(PROTO_KEYS)],
      [1, hostileKey(rng)],
      [
        1,
        rng.pick(["q[]", "q[0]", "q[__proto__]", "limit", "offset", "select", "order", "apikey"]),
      ],
    ]);
    const value = rng.weighted<string>([
      [4, hostileString(rng, { maxLength: 512 })],
      [1, hostileString(rng, { maxLength: 20_000 })],
      [1, String(rng.int(-1e9, 1e9))],
      [1, ""],
    ]);
    params.push(
      rng.bool(0.7)
        ? `${safeEncode(key)}=${safeEncode(value)}`
        : `${key.replace(/[#\s]/g, "_")}=${value.replace(/[#\s]/g, "_")}`,
    );
  }
  return params.join(rng.bool(0.9) ? "&" : ";");
}

const HOSTILE_HEADER_NAMES = [
  "x-forwarded-for",
  "x-forwarded-for",
  "cf-connecting-ip",
  "x-real-ip",
  "x-request-id",
  "x-request-id",
  "content-type",
  "content-type",
  "content-length",
  "accept",
  "accept-encoding",
  "accept-language",
  "origin",
  "referer",
  "user-agent",
  "cookie",
  "x-apple-revocation-protocol",
  "prefer",
  "range",
  "x-http-method-override",
  "x-client-info",
  "apikey",
  "if-none-match",
  "authorization",
] as const;

interface Pool {
  users: FuzzUser[];
  epochSeconds: number;
}

export function buildCase(seed: string, index: number, pool: Pool): CaseSpec {
  const label = caseLabel(seed, index);
  const rng = new Prng(label);
  const strategy = rng.weighted(STRATEGY_WEIGHTS);
  const user = rng.pick(pool.users);
  const notes: string[] = [];

  const spec: CaseSpec = {
    seed,
    index,
    label,
    strategy,
    routeId: "",
    user,
    method: "GET",
    url: "",
    headers: {},
    body: { kind: "none" },
    serverBody: {},
    pathParam: null,
    verdict: { kind: "invalid", statuses: REJECT_STATUSES, writeTargets: [], reason: "" },
    notes,
  };

  const finish = (
    route: RouteSpec,
    path: string,
    body: BodySpec,
    param: string | null,
    verdict?: Verdict,
  ) => {
    spec.routeId = route.id;
    spec.method = route.method;
    spec.url = `${ORIGIN}${path}`;
    spec.body = body;
    spec.pathParam = param;
    if (body.kind === "text" || body.kind === "stream") {
      spec.serverBody = serverView(body.text);
      spec.headers["content-type"] = "application/json";
      if (body.kind === "text") spec.headers["content-length"] = String(byteLength(body.text));
    } else if (body.kind === "bytes") {
      spec.headers["content-type"] = "application/json";
      spec.headers["content-length"] = String(body.bytes.byteLength);
    }
    spec.verdict = verdict ?? route.oracle(spec.serverBody, user, param);
    return spec;
  };

  const validBody = (route: RouteSpec): Record<string, unknown> =>
    route.body ? route.body(rng.fork("body"), user) : {};

  switch (strategy) {
    case "baseline": {
      const route = rng.pick(ROUTES);
      spec.headers = baseHeaders(route, user, rng, pool.epochSeconds);
      const body = route.body
        ? textBody(validBody(route), "valid baseline body")
        : ({ kind: "none" } as BodySpec);
      return finish(route, route.path(rng, user), body, null);
    }

    case "body.required": {
      const route = rng.pick(REQUIRED_ROUTES);
      spec.headers = baseHeaders(route, user, rng, pool.epochSeconds);
      const body = validBody(route);
      const targets = rng
        .shuffle(route.requiredKeys)
        .slice(0, rng.int(1, route.requiredKeys.length));
      for (const key of targets) mutateKey(rng, body, key, notes);
      return finish(
        route,
        route.path(rng, user),
        textBody(body, `required keys mutated: ${notes.join("; ")}`),
        null,
      );
    }

    case "body.entry": {
      const route = rng.pick(ENTRY_ROUTES);
      spec.headers = baseHeaders(route, user, rng, pool.epochSeconds);
      const isShots = route.id === "POST /v1/shots:sync";
      const n = rng.weighted<number>([
        [6, 1],
        [3, rng.int(2, 8)],
        [1, rng.int(150, 210)],
      ]);
      const entries: unknown[] = [];
      for (let i = 0; i < n; i += 1) {
        const entry = isShots ? validShot(rng.fork(`shot${i}`)) : validTrial(rng.fork(`trial${i}`));
        entries.push(rng.bool(0.85) ? mutateEntry(rng, entry, notes) : entry);
      }
      const body = isShots ? { shots: entries } : { trials: entries };
      return finish(
        route,
        route.path(rng, user),
        textBody(body, `${n} entries; ${notes.slice(0, 12).join("; ")}`),
        null,
      );
    }

    case "body.optional": {
      const route = rng.pick(OPTIONAL_ROUTES);
      spec.headers = baseHeaders(route, user, rng, pool.epochSeconds);
      const body = validBody(route);
      const targets = rng
        .shuffle(route.optionalKeys)
        .slice(0, rng.int(1, route.optionalKeys.length));
      for (const key of targets) {
        if (key === "survey") {
          body.survey = rng.bool(0.5)
            ? {
                reason: rng.bool() ? "not_useful" : hostileValue(rng),
                wanted: hostileValue(rng),
                details: hostileString(rng, { maxLength: 6000 }),
                platform: hostileValue(rng),
                appVersion: hostileString(rng, { maxLength: 300 }),
                ...protoPollutionObject(rng),
              }
            : hostileValue(rng);
          notes.push("survey: hostile");
          continue;
        }
        body[key] = rng.bool(0.7) ? hostileString(rng, { maxLength: 8000 }) : hostileValue(rng);
        notes.push(`${key}: hostile`);
      }
      return finish(
        route,
        route.path(rng, user),
        textBody(body, `optional keys hostile: ${notes.join("; ")}`),
        null,
      );
    }

    case "body.extra": {
      const route = rng.pick(BODY_ROUTES);
      spec.headers = baseHeaders(route, user, rng, pool.epochSeconds);
      const body = validBody(route);
      const extras = rng.int(1, 6);
      for (let i = 0; i < extras; i += 1) {
        const key = rng.weighted<string>([
          [3, rng.pick(PROTO_KEYS)],
          [3, hostileKey(rng)],
          [1, hostileString(rng, { maxLength: 50_000 })],
        ]);
        body[key] = rng.bool(0.5) ? protoPollutionObject(rng) : hostileValue(rng);
        notes.push(`extra:${key.slice(0, 24)}`);
      }
      // Nested pollution inside the first array entry when there is one.
      for (const value of Object.values(body)) {
        if (Array.isArray(value) && value[0] && typeof value[0] === "object") {
          Object.assign(value[0] as Record<string, unknown>, protoPollutionObject(rng));
          notes.push("entry[0]+proto");
          break;
        }
      }
      // Text-level duplicate/`__proto__` keys survive JSON.stringify as own keys.
      let text = JSON.stringify(body);
      if (rng.bool(0.3)) {
        text = `{"__proto__":{"polluted":"${label}"},${text.slice(1)}`;
        notes.push("text-level __proto__ first");
      }
      return finish(
        route,
        route.path(rng, user),
        { kind: "text", text, description: `extra keys: ${notes.join("; ")}` },
        null,
      );
    }

    case "body.raw": {
      const route = rng.pick(BODY_ROUTES);
      spec.headers = baseHeaders(route, user, rng, pool.epochSeconds);
      const raw = rawMalformedBody(rng, JSON.stringify(validBody(route)));
      return finish(
        route,
        route.path(rng, user),
        { kind: "text", text: raw.text, description: `raw: ${raw.description}` },
        null,
      );
    }

    case "body.oversized": {
      const cap = bodyCapRoute(rng, user, spec.headers, pool.epochSeconds, notes);
      const route = cap.route;
      spec.headers = cap.headers;
      const big = oversizedBodyText(rng);
      const declare = rng.bool(0.7);
      const body: BodySpec = {
        kind: "text",
        text: big.text,
        description: `oversized: ${big.description}`,
      };
      const built = finish(route, route.path(rng, user), body, null, {
        kind: "invalid",
        statuses: [413, 429],
        writeTargets: cap.capWrites,
        reason: declare ? "declared length over cap" : "streamed body over cap",
      });
      if (!declare) {
        delete built.headers["content-length"];
        notes.push("no content-length (streamed cap)");
      }
      return built;
    }

    case "body.length_spoof": {
      const cap = bodyCapRoute(rng, user, spec.headers, pool.epochSeconds, notes);
      const route = cap.route;
      spec.headers = cap.headers;
      const body = validBody(route);
      const built = finish(
        route,
        route.path(rng, user),
        textBody(body, "valid body, spoofed content-length"),
        null,
      );
      const spoof = rng.pick([
        String(MAX_JSON_BODY_BYTES + 1),
        "9999999999999999999999",
        "1e309",
        "-1",
        "0",
        "abc",
        "",
        "5000000, 5000000",
        "0x10",
        "Infinity",
        "NaN",
        "１２３",
      ]);
      built.headers["content-length"] = spoof;
      notes.push(`content-length=${JSON.stringify(spoof)}`);
      const declared = Number(spoof);
      built.verdict =
        Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES
          ? {
              kind: "invalid",
              statuses: [413, 429],
              writeTargets: cap.capWrites,
              reason: "declared length over cap",
            }
          : { ...built.verdict, statuses: [...built.verdict.statuses, 400, 413] };
      return built;
    }

    case "body.invalid_utf8": {
      const route = rng.pick(BODY_ROUTES);
      spec.headers = baseHeaders(route, user, rng, pool.epochSeconds);
      const bytes = invalidUtf8Bytes(rng, JSON.stringify(validBody(route)));
      const built = finish(
        route,
        route.path(rng, user),
        { kind: "bytes", bytes, description: "invalid UTF-8 body" },
        null,
      );
      // The decoder replaces bad sequences with U+FFFD; the oracle sees the
      // decoded text exactly as request.text() will produce it.
      built.serverBody = serverView(new TextDecoder().decode(bytes));
      built.verdict = route.oracle(built.serverBody, user, null);
      return built;
    }

    case "body.stream": {
      const cap = bodyCapRoute(rng, user, spec.headers, pool.epochSeconds, notes);
      const route = cap.route;
      spec.headers = cap.headers;
      const oversized = rng.bool(0.5);
      const text = oversized ? oversizedBodyText(rng).text : JSON.stringify(validBody(route));
      const built = finish(
        route,
        route.path(rng, user),
        {
          kind: "stream",
          text,
          chunk: rng.pick([1, 7, 1024, 65_536, 1_048_576]),
          description: oversized
            ? "streamed oversized body, no content-length"
            : "streamed valid body, no content-length",
        },
        null,
        oversized
          ? {
              kind: "invalid",
              statuses: [413, 429],
              writeTargets: cap.capWrites,
              reason: "streamed body exceeds cap",
            }
          : undefined,
      );
      return built;
    }

    case "path.hostile": {
      const route = rng.pick(PARAM_ROUTES);
      spec.headers = baseHeaders(route, user, rng, pool.epochSeconds);
      const segment = hostilePathSegment(rng);
      const rawSegment = segment.encode ? safeEncode(segment.raw) : segment.raw;
      const path = route.pathParam!.build(rawSegment);
      notes.push(`segment: ${segment.description}`);
      const body = route.body
        ? textBody(validBody(route), "valid body")
        : ({ kind: "none" } as BodySpec);
      // Work out what the router will see for this parameter.
      let param: string | null = null;
      let unroutable = false;
      let undecodable = false;
      try {
        const pathname = new URL(`${ORIGIN}${path}`).pathname;
        const template = route.pathParam!.build("\u0000");
        const [prefix, suffix] = template.split("\u0000");
        const m = new RegExp(`^${escapeRe(prefix)}([^/]+)${escapeRe(suffix)}$`).exec(pathname);
        if (!m) unroutable = true;
        else {
          try {
            param = decodeURIComponent(m[1]);
          } catch {
            undecodable = true;
          }
        }
      } catch {
        unroutable = true;
      }
      const built = finish(route, path, body, param);
      if (unroutable)
        built.verdict = {
          kind: "invalid",
          statuses: [404, 401, 400, 429],
          writeTargets: [],
          reason: "segment breaks the route",
        };
      else if (undecodable)
        built.verdict = {
          kind: "invalid",
          statuses: [400, 429],
          writeTargets: [],
          reason: "malformed percent-encoding",
        };
      // Segments that normalise to a valid id are legitimately processed.
      return built;
    }

    case "route.unknown": {
      const method = rng.pick([
        "GET",
        "POST",
        "PUT",
        "DELETE",
        "PATCH",
        "OPTIONS",
        "HEAD",
        "TRACE",
        "PROPFIND",
        "get",
      ]);
      const depth = rng.int(1, 4);
      const segments: string[] = [];
      for (let i = 0; i < depth; i += 1) {
        const s = hostilePathSegment(rng);
        segments.push(s.encode ? safeEncode(s.raw) : s.raw);
      }
      const prefix = rng.weighted<string>([
        [5, `${V1_PREFIX}/`],
        [2, `${PUBLIC_PREFIX}/`],
        [1, "/"],
        [1, `${V1_PREFIX}/me/`],
        [1, `${V1_PREFIX}/catalog/drills/`],
      ]);
      const path = prefix + segments.join("/") + (rng.bool(0.3) ? `?${hostileQuery(rng, [])}` : "");
      const authed = rng.bool(0.7);
      const pseudo: RouteSpec = {
        ...ROUTES[0],
        id: "unknown",
        method,
        auth: authed ? "session" : "none",
      };
      spec.headers = baseHeaders(pseudo, user, rng, pool.epochSeconds);
      const body = rng.bool(0.5)
        ? textBody(hostileValue(rng), "hostile body on unknown route")
        : ({ kind: "none" } as BodySpec);
      let statuses: number[] = [404, 401, 400, 429, 405];
      try {
        const pathname = new URL(`${ORIGIN}${path}`).pathname;
        if (/^(GET|HEAD)$/.test(method) && /\/(healthz|support|privacy|terms)$/.test(pathname))
          statuses = [200, ...statuses];
      } catch {
        // an unparsable URL fails at Request construction and is recorded as such
      }
      return finish(pseudo, path, body, null, {
        kind: "invalid",
        statuses,
        writeTargets: [],
        reason: "unknown route",
      });
    }

    case "route.method": {
      const path = rng.pick(KNOWN_PATHS);
      const allowed = new Set(
        ROUTES.filter((r) => !r.pathParam && r.path(rng, user) === path).map((r) => r.method),
      );
      const candidates = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"].filter(
        (m) => !allowed.has(m),
      );
      const method = rng.pick(candidates);
      const pseudo: RouteSpec = {
        ...ROUTES[0],
        id: "method-confusion",
        method,
        auth: rng.bool(0.7) ? "session" : "none",
      };
      spec.headers = baseHeaders(pseudo, user, rng, pool.epochSeconds);
      const body =
        method === "GET" || method === "HEAD"
          ? ({ kind: "none" } as BodySpec)
          : textBody(hostileValue(rng), "hostile body, wrong method");
      const pathname = new URL(`${ORIGIN}${path}`).pathname;
      const publicPage =
        /\/(healthz|support|privacy|terms)$/.test(pathname) &&
        (method === "GET" || method === "HEAD");
      return finish(pseudo, path, body, null, {
        kind: "invalid",
        statuses: publicPage ? [200, 404, 401, 429] : [404, 401, 400, 405, 429],
        writeTargets: [],
        reason: "method not routed",
      });
    }

    case "auth.hostile": {
      const route = rng.pick(AUTHED_ROUTES);
      spec.headers = baseHeaders(route, user, rng, pool.epochSeconds);
      const realJwt = () =>
        rng.bool()
          ? sessionJwt(user, pool.epochSeconds)
          : providerIdToken("google", user, pool.epochSeconds);
      const auth = toHeaderSafe(hostileAuthorization(rng, realJwt, pool.epochSeconds));
      spec.headers.authorization = auth;
      notes.push(`authorization: ${JSON.stringify(auth.slice(0, 80))}`);
      const body = route.body
        ? textBody(validBody(route), "valid body, hostile authorization")
        : ({ kind: "none" } as BodySpec);
      const built = finish(route, route.path(rng, user), body, null);
      const wouldAuth =
        route.auth === "webhook"
          ? auth === WEBHOOK_SECRET
          : fixtureWouldAuthenticate(auth, pool.epochSeconds);
      if (wouldAuth) {
        notes.push("well-formed unsigned token: fixture authenticates it");
        built.verdict = { ...built.verdict, statuses: [...built.verdict.statuses, 401] };
      } else {
        built.verdict = {
          kind: "invalid",
          statuses: [401, 429],
          writeTargets: [],
          reason: "hostile credentials",
        };
      }
      return built;
    }

    case "header.hostile": {
      const route = rng.pick(ROUTES);
      spec.headers = baseHeaders(route, user, rng, pool.epochSeconds);
      const body = route.body
        ? textBody(validBody(route), "valid body, hostile headers")
        : ({ kind: "none" } as BodySpec);
      const built = finish(route, route.path(rng, user), body, null);
      const n = rng.int(1, 3);
      let lengthOverCap = false;
      for (let i = 0; i < n; i += 1) {
        let name: string = rng.pick(HOSTILE_HEADER_NAMES);
        if (name === "authorization" && route.auth !== "none") name = "x-request-id";
        const value = toHeaderSafe(hostileHeaderValue(rng));
        built.headers[name] = value;
        notes.push(`${name}=${JSON.stringify(value.slice(0, 60))}`);
        if (name === "content-length") {
          const declared = Number(value);
          if (Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES) lengthOverCap = true;
        }
      }
      built.verdict = lengthOverCap
        ? {
            kind: "invalid",
            statuses: [413, 429],
            writeTargets: [],
            reason: "hostile content-length over cap",
          }
        : { ...built.verdict, statuses: [...built.verdict.statuses, 400, 413] };
      return built;
    }

    case "query.hostile": {
      const route = rng.pick(rng.bool(0.6) ? GET_ROUTES : ROUTES);
      spec.headers = baseHeaders(route, user, rng, pool.epochSeconds);
      const body = route.body
        ? textBody(validBody(route), "valid body, hostile query")
        : ({ kind: "none" } as BodySpec);
      const query = hostileQuery(rng, route.queryKeys);
      notes.push(`query: ${query.slice(0, 80)}`);
      const built = finish(route, `${route.path(rng, user)}?${query}`, body, null);
      built.verdict = { ...built.verdict, statuses: [...built.verdict.statuses, 400, 414] };
      return built;
    }
  }
}

const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ─── Request materialisation ─────────────────────────────────────────────────

export function toRequest(spec: CaseSpec): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(spec.headers)) {
    try {
      headers.set(name, value);
    } catch {
      headers.set(name, toHeaderSafe(value));
    }
  }
  let body: BodyInit | null = null;
  switch (spec.body.kind) {
    case "none":
      break;
    case "text":
      body = spec.body.text;
      break;
    case "bytes":
      body = spec.body.bytes.slice();
      break;
    case "stream": {
      const bytes = utf8.encode(spec.body.text);
      const chunk = spec.body.chunk;
      let offset = 0;
      body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= bytes.byteLength) {
            controller.close();
            return;
          }
          controller.enqueue(bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunk)));
          offset += chunk;
        },
      });
      break;
    }
  }
  const method = spec.method.toUpperCase();
  const init: RequestInit = { method: spec.method, headers };
  if (body !== null && method !== "GET" && method !== "HEAD") init.body = body;
  return new Request(spec.url, init);
}

// ─── Execution ───────────────────────────────────────────────────────────────

interface Sinks {
  logs: string[];
  console: string[];
}

// The handler's access log and error reporting go through the global console;
// the campaign swaps its four methods so every line lands in the case record.
const CONSOLE_LEVELS = ["error", "warn", "log", "info"] as const;
type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];
type ConsoleMethod = (...args: unknown[]) => void;

function installConsoleCapture(sink: string[]): () => void {
  const target: Record<ConsoleLevel, ConsoleMethod> = globalThis.console;
  const original = new Map<ConsoleLevel, ConsoleMethod>();
  const capture =
    (level: ConsoleLevel): ConsoleMethod =>
    (...args) => {
      if (sink.length < 40) {
        sink.push(
          `${level}: ${args
            .map((a) =>
              a instanceof Error
                ? `${a.name}: ${a.message}\n${a.stack ?? ""}`
                : typeof a === "string"
                  ? a
                  : safeJson(a),
            )
            .join(" ")
            .slice(0, 2_000)}`,
        );
      }
    };
  for (const level of CONSOLE_LEVELS) {
    original.set(level, target[level]);
    target[level] = capture(level);
  }
  return () => {
    for (const level of CONSOLE_LEVELS) {
      const method = original.get(level);
      if (method) target[level] = method;
    }
  };
}

const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bodyBytesOf(body: BodySpec): Uint8Array {
  switch (body.kind) {
    case "none":
      return new Uint8Array();
    case "bytes":
      return body.bytes;
    case "text":
    case "stream":
      return utf8.encode(body.text);
  }
}

const PROTO_CANARIES = ["polluted", "isAdmin", "admin", "premium", "role", "fuzz"] as const;

function prototypeDamage(): string[] {
  const damage: string[] = [];
  const probe: Record<string, unknown> = {};
  for (const key of PROTO_CANARIES) if (key in probe) damage.push(`Object.prototype.${key}`);
  if (Object.keys(Object.prototype).length > 0)
    damage.push(`Object.prototype keys: ${Object.keys(Object.prototype).join(",")}`);
  if (Object.keys(Array.prototype).length > 0)
    damage.push(`Array.prototype keys: ${Object.keys(Array.prototype).join(",")}`);
  if (Object.keys(Function.prototype).length > 0) damage.push(`Function.prototype keys`);
  return damage;
}

function repairPrototypes(): void {
  for (const key of Object.keys(Object.prototype))
    delete (Object.prototype as Record<string, unknown>)[key];
  for (const key of Object.keys(Array.prototype))
    delete (Array.prototype as unknown as Record<string, unknown>)[key];
  for (const key of PROTO_CANARIES) delete (Object.prototype as Record<string, unknown>)[key];
}

export interface Runner {
  run(spec: CaseSpec): Promise<{ result: CaseResult; failure: FailureRecord | null }>;
  dispose(): void;
}

export interface RunnerOptions {
  epochSeconds: number;
  timeoutMs?: number;
}

export function createRunner(
  harness: Harness,
  upstream: FuzzUpstream,
  options: RunnerOptions,
): Runner {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const sinks: Sinks = { logs: [], console: [] };
  const restoreAccessLog = captureAccessLog((line) => {
    if (sinks.logs.length < 20) sinks.logs.push(line);
  });
  const restoreConsole = installConsoleCapture(sinks.console);

  return {
    async run(spec) {
      sinks.logs.length = 0;
      sinks.console.length = 0;
      harness.calls.length = 0;
      upstream.drain();

      const result: CaseResult = {
        index: spec.index,
        label: spec.label,
        strategy: spec.strategy,
        routeId: spec.routeId,
        method: spec.method,
        url:
          spec.url.length > 512 ? `${spec.url.slice(0, 512)}…(${spec.url.length} chars)` : spec.url,
        urlBytes: byteLength(spec.url),
        bodyBytes: bodyBytesOf(spec.body).byteLength,
        bodyDescription: spec.body.kind === "none" ? "(no body)" : spec.body.description,
        verdict: spec.verdict.kind,
        verdictReason: spec.verdict.reason,
        expectedStatuses: spec.verdict.statuses,
        status: null,
        durationMs: 0,
        requestId: null,
        contentType: null,
        responseBytes: 0,
        upstreamCalls: 0,
        writes: [],
        accessLog: null,
        consoleLines: 0,
        failures: [],
        anomalies: [],
      };

      let request: Request | null = null;
      let response: Response | null = null;
      let responseText = "";
      let responseHeaders: Record<string, string> = {};
      let error: string | null = null;
      const started = performance.now();
      try {
        request = toRequest(spec);
      } catch (e) {
        // Not a server fault: the client runtime refused to build the request.
        error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        result.anomalies.push(`request_unconstructible:${error.slice(0, 160)}`);
      }
      if (request) {
        try {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<never>((_, rejectTimeout) => {
            timer = setTimeout(
              () => rejectTimeout(new Error(`handler exceeded ${timeoutMs}ms`)),
              timeoutMs,
            );
          });
          try {
            response = await Promise.race([harness.handler(request), timeout]);
          } finally {
            clearTimeout(timer);
          }
          responseHeaders = Object.fromEntries(response.headers.entries());
          responseText = await response.text();
        } catch (e) {
          error = e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ""}` : String(e);
          result.failures.push(error.includes("exceeded") ? "handler_timeout" : "handler_threw");
        }
      }
      result.durationMs = Math.round((performance.now() - started) * 100) / 100;

      const calls = upstream.drain();
      result.upstreamCalls = calls.length;
      const writes = calls.filter((c) => WRITE_KINDS.has(c.kind));
      result.writes = writes.map((c) => c.target);
      result.consoleLines = sinks.console.length;

      if (response) {
        result.status = response.status;
        result.requestId = responseHeaders["x-request-id"] ?? null;
        result.contentType = responseHeaders["content-type"] ?? null;
        result.responseBytes = byteLength(responseText);

        if (response.status >= 500) result.failures.push("server_error_5xx");
        if (!spec.verdict.statuses.includes(response.status))
          result.failures.push(`status_not_allowed:${response.status}`);
        if (LEAK_RE.test(responseText)) result.failures.push("internal_detail_leak");
        if (!result.requestId) result.failures.push("missing_request_id");
        else if (!REQUEST_ID_RE.test(result.requestId))
          result.failures.push("request_id_not_sanitized");
        const sentRequestId = spec.headers["x-request-id"];
        if (
          sentRequestId &&
          result.requestId === sentRequestId &&
          !REQUEST_ID_RE.test(sentRequestId)
        ) {
          result.failures.push("request_id_reflected_unsanitized");
        }
        if (
          result.contentType?.includes("json") &&
          spec.method.toUpperCase() !== "HEAD" &&
          responseText.length > 0
        ) {
          try {
            JSON.parse(responseText);
          } catch {
            result.failures.push("invalid_json_response");
          }
        }
        if (response.status >= 400 && result.responseBytes > 4_096)
          result.anomalies.push(`large_error_body:${result.responseBytes}`);
        if (response.status === 429 && !responseHeaders["retry-after"])
          result.failures.push("429_without_retry_after");

        if (writes.length > 0) {
          const unexpected = writes.filter((c) => !spec.verdict.writeTargets.includes(c.target));
          const targets = [...new Set(unexpected.map((c) => c.target))].join(",");
          if (response.status === 429) result.failures.push("write_despite_429");
          else if (unexpected.length > 0)
            result.failures.push(
              spec.verdict.kind === "invalid"
                ? `write_on_invalid_input:${targets}`
                : `write_outside_contract:${targets}`,
            );
        }
        // Per-entry routes: an all-rejected batch must accept nothing.
        if (
          spec.verdict.kind === "invalid" &&
          response.status === 200 &&
          /shots:sync|evaluation\/trials/.test(spec.routeId)
        ) {
          try {
            const parsed = JSON.parse(responseText) as Record<string, unknown>;
            const accepted = parsed.acceptedIds ?? parsed.acceptedTrialIds;
            if (Array.isArray(accepted) && accepted.length > 0)
              result.failures.push("accepted_invalid_entries");
          } catch {
            // already flagged as invalid_json_response
          }
        }
        const log = sinks.logs
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .find((e) => e.evt === "api_request");
        if (log) {
          result.accessLog = {
            status: Number(log.status),
            route: String(log.route),
            requestId: String(log.requestId),
          };
          if (Number(log.status) !== response.status)
            result.failures.push("access_log_status_mismatch");
          if (result.requestId && log.requestId !== result.requestId)
            result.failures.push("access_log_request_id_mismatch");
        } else {
          result.failures.push("access_log_missing");
        }
        if (result.durationMs > 2_000) result.anomalies.push(`slow:${result.durationMs}ms`);
        for (const line of sinks.console) {
          if (/\n\s+at\s+/.test(line) && !/\[api\]/.test(line))
            result.anomalies.push("unhandled_stack_logged");
        }
      }

      const damage = prototypeDamage();
      if (damage.length > 0) {
        result.failures.push(`prototype_polluted:${damage.join("|")}`);
        repairPrototypes();
      }

      let failure: FailureRecord | null = null;
      if (result.failures.length > 0) {
        const bytes = bodyBytesOf(spec.body);
        const preview = new TextDecoder().decode(bytes.subarray(0, 600));
        failure = {
          result,
          request: {
            method: spec.method,
            url: spec.url.length > 4_096 ? `${spec.url.slice(0, 4_096)}…` : spec.url,
            headers: Object.fromEntries(
              Object.entries(spec.headers).map(([k, v]) => [
                k,
                v.length > 300 ? `${v.slice(0, 300)}…(${v.length})` : v,
              ]),
            ),
            body: {
              kind: spec.body.kind,
              description: result.bodyDescription,
              bytes: bytes.byteLength,
              sha256: await sha256Hex(bytes),
              preview: preview.length === 600 && bytes.byteLength > 600 ? `${preview}…` : preview,
            },
          },
          response: response
            ? {
                status: response.status,
                headers: responseHeaders,
                bodyPreview: responseText.slice(0, 2_000),
              }
            : null,
          error,
          upstream: calls.slice(0, 50),
          console: [...sinks.console],
          replay: `cd supabase/functions/api/__wf__ && deno run -A fuzz/run.ts --replay ${spec.seed}:${spec.index} --epoch ${options.epochSeconds}`,
        };
      }
      return { result, failure };
    },
    dispose() {
      restoreAccessLog();
      restoreConsole();
    },
  };
}

export const memorySample = (index: number) => {
  const usage = Deno.memoryUsage();
  return {
    index,
    rss: usage.rss,
    heapTotal: usage.heapTotal,
    heapUsed: usage.heapUsed,
    external: usage.external,
    at: new Date().toISOString(),
  };
};
