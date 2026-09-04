/**
 * STRESS / FUZZ-BOUNDARY — `GET /v1/me/saved-drills` (index.ts listSavedDrills).
 *
 * Drives the REAL edge handler in-process (routesHarness.ts captures the
 * Deno.serve callback and stubs Supabase Auth, PostgREST, RevenueCat; Upstash
 * is unset so caches/limits are per-isolate memory) with seeded, replayable
 * generated requests: methods, paths/mount prefixes/query strings, bearer
 * shapes and JWT claims, request-id / proxy / content-length headers, bodies
 * on non-GET methods, plus upstream faults (PostgREST error statuses, malformed
 * row shapes, GoTrue outages) behind the same route.
 *
 * Invariants asserted on EVERY response:
 *   - client bad input answers ONLY 400/401/403/404/405/413/415/429 (never 5xx)
 *   - a 5xx (only reachable via an upstream fault) carries the generic body,
 *     never a DB message, table name, PostgREST code or stack frame
 *   - `x-request-id` is present; a well-formed client id is echoed, anything
 *     else is replaced by a UUID; the access log carries the same id + status
 *   - JSON security headers on every JSON response
 *   - zero upstream writes (POST/PATCH/PUT/DELETE to /rest/v1, any rpc/) —
 *     the route is read-only, rejected or not
 *   - no upstream call at all when the bearer is missing/malformed (pre-auth)
 *   - every accepted request queries PostgREST exactly once, scoped
 *     `user_id=eq.<authenticated user>` regardless of query-string noise
 *
 * Knobs (all optional):
 *   STRESS_ITER   generated requests in the main campaign (default 300 — small
 *                 enough for the suite; the recorded campaign used 3000)
 *   STRESS_SEED   master seed (default 20260904); iteration i uses
 *                 iterSeed(STRESS_SEED, i), and every request is a pure
 *                 function of its iteration seed
 *   STRESS_REPLAY comma-separated iteration seeds to run INSTEAD of the sweep
 *   STRESS_REPEAT repeat each iteration N times (flake rate)
 *   STRESS_OUT    write the JSON result table (seed → outcome) to this path
 *
 * Replay one failing seed:
 *   STRESS_REPLAY=<seed> STRESS_REPEAT=10 deno test -A --no-check --config deno.json \
 *     stress_saved_drills_fuzz.test.ts
 */
import { assert, assertEquals } from "@std/assert";
import { captureAccessLog } from "../http.ts";
import { drillCatalog } from "../drills.ts";
import { loadHarness, SUPABASE_URL, type Harness } from "./routesHarness.ts";

// ── Knobs ────────────────────────────────────────────────────────────────────

function envInt(name: string, fallback: number): number {
  const raw = Number(Deno.env.get(name));
  return Number.isInteger(raw) && raw >= 0 ? raw : fallback;
}

const STRESS_ITER = envInt("STRESS_ITER", 300);
const STRESS_SEED = envInt("STRESS_SEED", 20260904);
const STRESS_REPEAT = Math.max(1, envInt("STRESS_REPEAT", 1));
const STRESS_OUT = Deno.env.get("STRESS_OUT") ?? "";
const STRESS_REPLAY = (Deno.env.get("STRESS_REPLAY") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number)
  .filter((n) => Number.isInteger(n) && n >= 0);

const ROUTE_PATH = "/v1/me/saved-drills";
const BASE = "http://edge.test";
const ALLOWED_BAD_INPUT = new Set([400, 401, 403, 404, 405, 413, 415, 429]);
const MAX_JSON_BODY_BYTES = 5_000_000;
const DRILL_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,119}$/i;
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERIC_5XX_RE =
  /^(Something went wrong\. Please try again\.|[A-Za-z ]+ is temporarily unavailable\. Please try again\.)$/;
/** Anything a 4xx/5xx body must never contain (internal detail / stack). */
const LEAK_MARKERS = [
  "    at ",
  "index.ts",
  "drills.ts",
  "TypeError",
  "ReferenceError",
  "RangeError",
  "SyntaxError",
  "stack",
  "PGRST",
  "42501",
  "42P01",
  "user_saved_drills",
  "permission denied",
  "supabase.test",
  "/rest/v1/",
  "/auth/v1/",
  "postgrest",
  "GoTrue",
];

// ── Seeded RNG ───────────────────────────────────────────────────────────────

/** mulberry32 */
class Prng {
  private state: number;
  constructor(public readonly seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }
  weighted<T>(entries: ReadonlyArray<readonly [number, T]>): T {
    const total = entries.reduce((sum, [w]) => sum + w, 0);
    let roll = this.next() * total;
    for (const [w, value] of entries) {
      roll -= w;
      if (roll < 0) return value;
    }
    return entries[entries.length - 1][1];
  }
  uuid(): string {
    const hex = () => this.int(0, 15).toString(16);
    const h = (n: number) => Array.from({ length: n }, hex).join("");
    return `${h(8)}-${h(4)}-4${h(3)}-${"89ab"[this.int(0, 3)]}${h(3)}-${h(12)}`;
  }
  string(alphabet: string, length: number): string {
    const glyphs = [...alphabet]; // by code point — never split a surrogate pair
    let out = "";
    for (let i = 0; i < length; i++) out += glyphs[this.int(0, glyphs.length - 1)];
    return out;
  }
  ipv4(): string {
    return `10.${this.int(0, 255)}.${this.int(0, 255)}.${this.int(1, 254)}`;
  }
}

/** Iteration seed: murmur3-style finalizer over (master, index). */
function iterSeed(master: number, index: number): number {
  let h = (master ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

// ── Alphabets ────────────────────────────────────────────────────────────────

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const SLUGISH = "abcdefghijklmnopqrstuvwxyz0123456789-_";
const REQUEST_ID_OK = `${ALNUM}._-`;
/** Header-safe byte string (Latin-1 printable + tab), never CR/LF/NUL. */
const HEADER_SAFE = `${ALNUM} !"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~\t\u00a0\u00e9\u00fc\u00ff`;
const URLISH = `${ALNUM}-._~!$&'()*+,;=:@%/?#[]{}|\\^\`<> \u00e9\u4e2d\ud83c\udfd3`;
const B64URL = `${ALNUM}-_`;

const b64url = (value: string): string =>
  btoa(unescape(encodeURIComponent(value)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

// ── Spec (a request + the world it runs in + what must come back) ────────────

type Kind = "client" | "upstream";

interface DbBehaviour {
  /** rows: harness serves h.tables rows; error: PostgREST error status+body;
   * raw: arbitrary 200 body text; throw: fetch rejects (socket-level fault) */
  mode: "rows" | "error" | "raw" | "throw";
  rows: unknown[];
  status?: number;
  body?: string;
  contentType?: string;
  retryAfter?: string;
}

interface AuthUserBehaviour {
  /** what GET /auth/v1/user answers for a Supabase-issued bearer */
  mode: "ok" | "refused" | "fault";
  status: number;
  body: string;
  contentType: string;
  provider?: string;
}

interface Spec {
  seed: number;
  cls: string;
  kind: Kind;
  method: string;
  url: string;
  headers: Array<[string, string]>;
  body: string | Uint8Array | null;
  /** x-request-id the client sent (raw, untrimmed) or null */
  sentRequestId: string | null;
  /** the user id the handler should authenticate as (null → auth must fail) */
  authedUserId: string | null;
  preAuthReject: boolean;
  expected: number[];
  /** the route must be reached and answer 200 with these rows */
  expectItems: boolean;
  db: DbBehaviour;
  authUser: AuthUserBehaviour | null;
  notes: string[];
}

interface UpstreamCall {
  method: string;
  url: string;
}

interface Outcome {
  seed: number;
  cls: string;
  kind: Kind;
  method: string;
  url: string;
  headerNames: string[];
  bodyBytes: number;
  expected: number[];
  status: number;
  errorCode: string | null;
  errorMessage: string | null;
  requestId: string | null;
  sentRequestId: string | null;
  upstream: { auth: number; rest: number; writes: number; other: number };
  accessLogStatus: number | null;
  latencyMs: number;
  verdict: "HELD" | "BROKEN" | "UNCONSTRUCTIBLE";
  violations: string[];
  notes: string[];
  replay: string;
}

const replayCommand = (seed: number): string =>
  `cd supabase/functions/api/__wf__ && STRESS_REPLAY=${seed} STRESS_REPEAT=10 deno test -A --no-check --config deno.json stress_saved_drills_fuzz.test.ts`;

// ── Generators ───────────────────────────────────────────────────────────────

let catalogSlugs: string[] = [];

function jwt(
  rng: Prng,
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "RS256", typ: "JWT" },
): string {
  const sig = rng.string(B64URL, rng.int(8, 86));
  return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}.${sig}`;
}

function providerToken(rng: Prng, sub: string, provider: "google" | "apple" = "google"): string {
  const iss = provider === "google" ? "https://accounts.google.com" : "https://appleid.apple.com";
  return jwt(rng, {
    iss,
    sub,
    aud: "com.picklesensei",
    exp: Math.floor(Date.now() / 1000) + rng.int(60, 86_400),
    iat: Math.floor(Date.now() / 1000) - rng.int(0, 600),
    jti: rng.uuid(),
  });
}

function sessionToken(rng: Prng, sub: string, withSessionId: boolean): string {
  return jwt(rng, {
    iss: `${SUPABASE_URL}/auth/v1`,
    sub,
    aud: "authenticated",
    role: "authenticated",
    exp: Math.floor(Date.now() / 1000) + rng.int(60, 3600),
    ...(withSessionId ? { session_id: rng.uuid() } : {}),
    jti: rng.uuid(),
  });
}

function wellFormedRows(rng: Prng): Array<Record<string, unknown>> {
  const count = rng.weighted([
    [3, 0],
    [8, rng.int(1, 5)],
    [3, rng.int(6, 25)],
    [1, rng.int(26, 120)],
  ] as const);
  const rows: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  let t = Date.now() - rng.int(0, 1_000_000);
  for (let i = 0; i < count; i++) {
    let slug: string;
    if (rng.chance(0.6) && catalogSlugs.length) slug = rng.pick(catalogSlugs);
    else {
      slug = rng.string(SLUGISH, rng.int(1, 120));
      if (!DRILL_SLUG_RE.test(slug)) slug = `d${slug.slice(1)}`;
    }
    if (seen.has(slug)) continue;
    seen.add(slug);
    t -= rng.int(1, 100_000);
    rows.push({ slug, saved_at: new Date(t).toISOString() });
  }
  return rows;
}

function weirdRows(rng: Prng, notes: string[]): unknown[] {
  const count = rng.weighted([
    [6, rng.int(1, 6)],
    [1, rng.int(50, 500)],
  ] as const);
  const rows: unknown[] = [];
  for (let i = 0; i < count; i++) {
    const shape = rng.weighted([
      [6, "object"],
      [1, "null"],
      [1, "number"],
      [1, "string"],
      [1, "array"],
    ] as const);
    if (shape !== "object") {
      notes.push(`row[${i}] is a ${shape}`);
      rows.push(
        shape === "null"
          ? null
          : shape === "number"
            ? rng.int(0, 99)
            : shape === "string"
              ? "x"
              : [],
      );
      continue;
    }
    const slug = rng.weighted<unknown>([
      [4, catalogSlugs.length ? rng.pick(catalogSlugs) : "wall-dink-rally"],
      [3, rng.string(SLUGISH, rng.int(1, 40))],
      [1, ""],
      [1, null],
      [1, undefined],
      [1, rng.int(-5, 99999)],
      [1, true],
      [1, {}],
      [1, ["a", "b"]],
      [1, rng.string(ALNUM, rng.int(1_000, 20_000))],
      [1, "\u0000ctrl\u0007\u001f"],
      [1, "<script>alert(1)</script>"],
      [1, "../../etc/passwd"],
      [1, "\ud83c\udfd3 pickle \u4e2d\u6587"],
      [1, "null"],
    ] as const);
    const savedAt = rng.weighted<unknown>([
      [5, new Date(Date.now() - rng.int(0, 1e9)).toISOString()],
      [1, null],
      [1, undefined],
      [1, rng.int(0, 2e12)],
      [1, "not-a-date"],
      [1, {}],
      [1, ""],
    ] as const);
    const row: Record<string, unknown> = {};
    if (slug !== undefined) row.slug = slug;
    if (savedAt !== undefined) row.saved_at = savedAt;
    if (rng.chance(0.3)) row.user_id = rng.uuid();
    if (rng.chance(0.2)) row[rng.string(ALNUM, 6)] = rng.string(ALNUM, 12);
    rows.push(row);
  }
  return rows;
}

function randomQuery(rng: Prng): string {
  const variant = rng.weighted([
    [5, "none"],
    [3, "benign"],
    [1, "scope-abuse"],
    [1, "junk"],
    [1, "huge"],
  ] as const);
  switch (variant) {
    case "none":
      return "";
    case "benign":
      return `?${rng.string(ALNUM, rng.int(1, 8))}=${rng.string(ALNUM, rng.int(0, 12))}`;
    case "scope-abuse":
      return rng.pick([
        `?user_id=${rng.uuid()}`,
        `?user_id=eq.${rng.uuid()}`,
        `?select=*`,
        `?slug=${rng.string(SLUGISH, 10)}`,
        `?order=saved_at.asc`,
        `?limit=0`,
        `?apikey=${rng.string(ALNUM, 30)}`,
        `?Authorization=Bearer%20x`,
      ]);
    case "junk":
      return `?${encodeURIComponent(rng.string(URLISH, rng.int(1, 60)))}`;
    case "huge":
      return `?${rng.string(ALNUM, 4)}=${rng.string(ALNUM, rng.int(8_000, 16_000))}`;
  }
}

/** The gateway may present any of these mount prefixes; routing keys off the
 * LAST "/v1/" segment. */
function mountPrefix(rng: Prng): string {
  return rng.weighted([
    [5, "/functions/v1/api"],
    [3, ""],
    [2, "/api"],
    [1, "/functions/v1/api/v1/x"],
    [1, `/${rng.string(ALNUM, rng.int(1, 12))}`],
  ] as const);
}

/** Emulates index.ts routing for a GET: pathname → last "/v1/" slice → exact
 * match, so the generator can predict 200 vs 404 for path/mount variants. */
function pathRoutesToSavedDrills(url: string): boolean {
  const pathname = new URL(url).pathname;
  const v1 = pathname.lastIndexOf("/v1/");
  const path = v1 >= 0 ? pathname.slice(v1) : pathname;
  return path === ROUTE_PATH;
}

function requestIdVariant(rng: Prng): string | null {
  return rng.weighted([
    [5, null],
    [4, rng.string(REQUEST_ID_OK, rng.int(8, 64))],
    [1, rng.string(REQUEST_ID_OK, 7)],
    [1, rng.string(REQUEST_ID_OK, 65)],
    [1, rng.string(REQUEST_ID_OK, rng.int(100, 4_000))],
    [1, `  ${rng.string(REQUEST_ID_OK, rng.int(8, 40))}  `],
    [1, ""],
    [1, "   "],
    [1, rng.string(HEADER_SAFE, rng.int(8, 64))],
    [1, `${rng.string(ALNUM, 10)} ${rng.string(ALNUM, 10)}`],
    [1, "<script>alert(1)</script>"],
    [1, rng.uuid()],
  ] as const);
}

function proxyHeaders(rng: Prng, notes: string[]): Array<[string, string]> {
  const variant = rng.weighted([
    [7, "xff-single"],
    [2, "cf"],
    [1, "xff-chain"],
    [1, "xff-junk"],
    [1, "xff-ipv6"],
    [1, "both"],
  ] as const);
  switch (variant) {
    case "xff-single":
      return [["x-forwarded-for", rng.ipv4()]];
    case "cf":
      return [["cf-connecting-ip", rng.ipv4()]];
    case "xff-chain": {
      const hops = Array.from({ length: rng.int(2, 40) }, () => rng.ipv4());
      return [["x-forwarded-for", hops.join(rng.pick([", ", ",", " , "]))]];
    }
    case "xff-junk":
      notes.push("junk x-forwarded-for");
      // still unique per iteration so the shared-ip budgets never trip
      return [["x-forwarded-for", `${rng.string(HEADER_SAFE, rng.int(1, 60))}, ${rng.ipv4()}`]];
    case "xff-ipv6":
      return [
        [
          "x-forwarded-for",
          `2001:db8:${rng.int(0, 0xffff).toString(16)}::${rng.int(1, 0xffff).toString(16)}`,
        ],
      ];
    case "both":
      return [
        ["x-forwarded-for", rng.ipv4()],
        ["cf-connecting-ip", rng.ipv4()],
      ];
  }
}

function benignHeaders(rng: Prng): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (rng.chance(0.5)) out.push(["accept", rng.pick(["application/json", "*/*", "text/html", ""])]);
  if (rng.chance(0.4))
    out.push(["user-agent", `PickleSensei/${rng.int(1, 9)}.${rng.int(0, 99)} iOS`]);
  if (rng.chance(0.3)) out.push(["accept-language", rng.pick(["en-US", "de", "*", "x-klingon"])]);
  if (rng.chance(0.2))
    out.push(["content-type", rng.pick(["application/json", "text/plain", "x/y"])]);
  if (rng.chance(0.2)) out.push(["origin", rng.pick(["https://evil.example", "null", "file://"])]);
  return out;
}

function okAuthUser(
  rng: Prng,
  sub: string,
  provider = rng.pick(["google", "apple"]),
): AuthUserBehaviour {
  return {
    mode: "ok",
    status: 200,
    contentType: "application/json",
    provider,
    body: JSON.stringify({
      id: sub,
      aud: "authenticated",
      role: "authenticated",
      email: `${rng.string(ALNUM, 6)}@example.com`,
      app_metadata: { provider, providers: [provider] },
      user_metadata: {},
      created_at: new Date().toISOString(),
    }),
  };
}

function bodyVariant(rng: Prng, notes: string[]): string | Uint8Array | null {
  const variant = rng.weighted([
    [3, "none"],
    [3, "json-object"],
    [1, "json-array"],
    [1, "invalid-json"],
    [1, "empty"],
    [1, "binary"],
    [1, "big"],
    [1, "unicode"],
  ] as const);
  notes.push(`body:${variant}`);
  switch (variant) {
    case "none":
      return null;
    case "json-object":
      return JSON.stringify({ slug: rng.string(SLUGISH, rng.int(0, 200)), saved: rng.chance(0.5) });
    case "json-array":
      return JSON.stringify(Array.from({ length: rng.int(0, 20) }, () => rng.string(ALNUM, 5)));
    case "invalid-json":
      return rng.pick(["{", '{"a":', "nope", "\u0000\u0001", "]", '{"a":1}}']);
    case "empty":
      return "";
    case "binary":
      return new Uint8Array(Array.from({ length: rng.int(1, 4096) }, () => rng.int(0, 255)));
    case "big":
      return `{"pad":"${rng.string(ALNUM, rng.int(60_000, 200_000))}"}`;
    case "unicode":
      return JSON.stringify({ s: rng.string(URLISH, rng.int(1, 300)) });
  }
}

const CLASSES = [
  [22, "valid"],
  [8, "auth-missing"],
  [10, "auth-garbage"],
  [10, "auth-claims"],
  [8, "session"],
  [8, "method"],
  [10, "path"],
  [10, "headers"],
  [6, "db-error"],
  [8, "db-shape"],
] as const;

function generate(seed: number): Spec {
  const rng = new Prng(seed);
  const cls = rng.weighted(CLASSES);
  const notes: string[] = [];
  const sub = rng.uuid();
  const headers: Array<[string, string]> = [...proxyHeaders(rng, notes), ...benignHeaders(rng)];
  const sentRequestId = requestIdVariant(rng);
  if (sentRequestId !== null) headers.push(["x-request-id", sentRequestId]);

  const spec: Spec = {
    seed,
    cls,
    kind: "client",
    method: "GET",
    url: `${BASE}${mountPrefix(rng)}${ROUTE_PATH}${randomQuery(rng)}`,
    headers,
    body: null,
    sentRequestId,
    authedUserId: sub,
    preAuthReject: false,
    expected: [200],
    expectItems: true,
    db: { mode: "rows", rows: wellFormedRows(rng) },
    authUser: null,
    notes,
  };
  const bearer = (token: string) => headers.push(["authorization", `Bearer ${token}`]);
  const authFails = (why: string) => {
    notes.push(why);
    spec.authedUserId = null;
    spec.expected = [401];
    spec.expectItems = false;
  };

  switch (cls) {
    case "valid": {
      bearer(providerToken(rng, sub, rng.pick(["google", "apple"])));
      break;
    }
    case "auth-missing": {
      const variant = rng.weighted([
        [4, "absent"],
        [1, "empty"],
        [1, "bare-bearer"],
        [1, "bearer-space"],
        [1, "lowercase"],
        [1, "basic"],
        [1, "token-scheme"],
        [1, "bearer-tab"],
      ] as const);
      const values: Record<typeof variant, string | null> = {
        absent: null,
        empty: "",
        "bare-bearer": "Bearer",
        "bearer-space": "Bearer ",
        lowercase: `bearer ${providerToken(rng, sub)}`,
        basic: `Basic ${btoa("user:pass")}`,
        "token-scheme": `Token ${rng.string(ALNUM, 20)}`,
        "bearer-tab": `Bearer\t${providerToken(rng, sub)}`,
      };
      const value = values[variant];
      if (value !== null) headers.push(["authorization", value]);
      authFails(`auth-missing:${variant}`);
      spec.preAuthReject = true;
      break;
    }
    case "auth-garbage": {
      const variant = rng.weighted([
        [3, "random"],
        [1, "two-segments"],
        [1, "four-segments"],
        [1, "bad-base64"],
        [1, "non-json-payload"],
        [1, "json-array-payload"],
        [1, "json-string-payload"],
        [1, "json-number-payload"],
        [1, "huge"],
        [1, "dots-only"],
        [1, "latin1"],
      ] as const);
      const alphabet = `${ALNUM}.-_=+/`;
      const token = {
        random: rng.string(alphabet, rng.int(1, 300)),
        "two-segments": `${b64url("{}")}.${b64url('{"iss":"https://accounts.google.com"}')}`,
        "four-segments": `${providerToken(rng, sub)}.${rng.string(B64URL, 10)}`,
        "bad-base64": `${b64url("{}")}.!!!not-base64!!!.${rng.string(B64URL, 10)}`,
        "non-json-payload": `${b64url("{}")}.${b64url("iss=accounts.google.com")}.${rng.string(B64URL, 10)}`,
        "json-array-payload": `${b64url("{}")}.${b64url('["https://accounts.google.com"]')}.sig`,
        "json-string-payload": `${b64url("{}")}.${b64url('"https://accounts.google.com"')}.sig`,
        "json-number-payload": `${b64url("{}")}.${b64url("12345")}.sig`,
        huge: rng.string(alphabet, rng.int(20_000, 70_000)),
        "dots-only": ".".repeat(rng.int(1, 10)),
        latin1: rng.string(HEADER_SAFE, rng.int(1, 80)),
      }[variant];
      bearer(token);
      authFails(`auth-garbage:${variant}`);
      spec.preAuthReject = true;
      break;
    }
    case "auth-claims": {
      const now = Math.floor(Date.now() / 1000);
      const issVariant = rng.weighted([
        [3, "google"],
        [2, "apple"],
        [1, "google-bare"],
        [1, "google-slash"],
        [1, "google-evil"],
        [1, "supabase-foreign"],
        [1, "missing"],
        [1, "empty"],
        [1, "number"],
        [1, "array"],
        [1, "null"],
        [1, "http"],
      ] as const);
      const iss: unknown = {
        google: "https://accounts.google.com",
        apple: "https://appleid.apple.com",
        "google-bare": "accounts.google.com",
        "google-slash": "https://accounts.google.com/",
        "google-evil": "https://accounts.google.com.evil.example",
        "supabase-foreign": "https://evil.example/auth/v1",
        missing: undefined,
        empty: "",
        number: 42,
        array: ["https://accounts.google.com"],
        null: null,
        http: "http://accounts.google.com",
      }[issVariant];
      const expVariant = rng.weighted([
        [4, "future"],
        [2, "past"],
        [1, "zero"],
        [1, "negative"],
        [1, "string"],
        [1, "float"],
        [1, "huge"],
        [1, "missing"],
        [1, "null"],
        [1, "boundary-now"],
      ] as const);
      const exp: unknown = {
        future: now + rng.int(1, 10_000_000),
        past: now - rng.int(1, 10_000_000),
        zero: 0,
        negative: -rng.int(1, 1e9),
        string: String(now + 3600),
        float: now + 3600.5,
        huge: 1e15,
        missing: undefined,
        null: null,
        "boundary-now": now,
      }[expVariant];
      const subVariant = rng.weighted([
        [5, "uuid"],
        [1, "missing"],
        [1, "empty"],
        [1, "number"],
        [1, "long"],
        [1, "object"],
      ] as const);
      const subValue: unknown = {
        uuid: sub,
        missing: undefined,
        empty: "",
        number: rng.int(1, 1e9),
        long: rng.string(ALNUM, 5_000),
        object: { id: sub },
      }[subVariant];
      const payload: Record<string, unknown> = { jti: rng.uuid(), aud: "com.picklesensei" };
      if (iss !== undefined) payload.iss = iss;
      if (exp !== undefined) payload.exp = exp;
      if (subValue !== undefined) payload.sub = subValue;
      notes.push(`iss:${issVariant}`, `exp:${expVariant}`, `sub:${subVariant}`);
      bearer(jwt(rng, payload));

      // Predict (mirrors authenticate(): issuer gate, then exp gate).
      const issStr = typeof iss === "string" ? iss.replace(/^https:\/\//, "") : "";
      const provider =
        issStr === "accounts.google.com"
          ? "google"
          : issStr === "appleid.apple.com"
            ? "apple"
            : null;
      const supabaseIssued = typeof iss === "string" && iss.endsWith("/auth/v1");
      if (!provider && !supabaseIssued) {
        authFails("issuer refused");
        spec.preAuthReject = true;
      } else if (typeof exp === "number" && exp * 1000 <= Date.now()) {
        authFails("expired");
        spec.preAuthReject = true;
      } else if (provider) {
        // The Auth stub accepts any provider token and echoes `sub` (default
        // TEST_USER_ID) as the user id — the route must then answer 200.
        spec.authedUserId = null; // unknown scoping id (stub-derived); skip the user_id check
        notes.push("provider token accepted by Auth stub");
      } else {
        // Foreign "/auth/v1" issuer → verified via GET /auth/v1/user, refused.
        spec.authUser = {
          mode: "refused",
          status: rng.pick([401, 403]),
          contentType: "application/json",
          body: JSON.stringify({ code: 401, error_code: "bad_jwt", msg: "invalid JWT" }),
        };
        authFails("session refused by Auth");
      }
      break;
    }
    case "session": {
      const withSessionId = rng.chance(0.7);
      bearer(sessionToken(rng, sub, withSessionId));
      const variant = rng.weighted([
        [5, "ok"],
        [2, "refused-401"],
        [1, "refused-403"],
        [1, "refused-400"],
        [1, "no-provider"],
        [1, "fault-500"],
        [1, "fault-502-html"],
        [1, "fault-503-retry"],
        [1, "fault-200-nonjson"],
        [1, "fault-200-empty-object"],
        [1, "fault-204"],
        [1, "fault-429"],
      ] as const);
      notes.push(`auth-user:${variant}`);
      if (variant === "ok") {
        spec.authUser = okAuthUser(rng, sub);
      } else if (variant.startsWith("refused")) {
        spec.authUser = {
          mode: "refused",
          status: Number(variant.slice("refused-".length)),
          contentType: "application/json",
          body: JSON.stringify({
            code: 401,
            error_code: "session_not_found",
            msg: "Session not found",
          }),
        };
        authFails(variant);
      } else if (variant === "no-provider") {
        spec.authUser = {
          ...okAuthUser(rng, sub),
          body: JSON.stringify({
            id: sub,
            aud: "authenticated",
            app_metadata: { provider: "email" },
          }),
        };
        authFails(variant);
      } else {
        spec.kind = "upstream";
        spec.authedUserId = null;
        spec.expectItems = false;
        spec.expected = [503];
        const faults: Record<string, AuthUserBehaviour> = {
          "fault-500": {
            mode: "fault",
            status: 500,
            contentType: "application/json",
            body: '{"msg":"boom"}',
          },
          "fault-502-html": {
            mode: "fault",
            status: 502,
            contentType: "text/html",
            body: "<html>502 Bad Gateway</html>",
          },
          "fault-503-retry": {
            mode: "fault",
            status: 503,
            contentType: "application/json",
            body: "{}",
          },
          "fault-200-nonjson": {
            mode: "fault",
            status: 200,
            contentType: "text/html",
            body: "<html>ok</html>",
          },
          "fault-200-empty-object": {
            mode: "fault",
            status: 200,
            contentType: "application/json",
            body: "{}",
          },
          "fault-204": { mode: "fault", status: 204, contentType: "application/json", body: "" },
          "fault-429": {
            mode: "fault",
            status: 429,
            contentType: "application/json",
            body: '{"msg":"rate"}',
          },
        };
        spec.authUser = faults[variant];
      }
      break;
    }
    case "method": {
      const method = rng.weighted([
        [3, "POST"],
        [3, "PUT"],
        [3, "DELETE"],
        [2, "PATCH"],
        [2, "HEAD"],
        [2, "OPTIONS"],
        [1, "PROPFIND"],
        [1, "FOO"],
        [1, "get"],
      ] as const);
      spec.method = method;
      notes.push(`method:${method}`);
      const authOk = rng.chance(0.75);
      if (authOk) bearer(providerToken(rng, sub));
      else authFails("bad bearer on odd method");
      if (method !== "HEAD" && method !== "get") {
        spec.body = bodyVariant(rng, notes);
        if (spec.body !== null && rng.chance(0.4)) {
          headers.push([
            "content-type",
            rng.pick([
              "application/json",
              "text/plain",
              "application/octet-stream",
              "multipart/form-data; boundary=x",
              "",
            ]),
          ]);
        }
      }
      const oversize = rng.chance(0.15);
      if (oversize) {
        headers.push(["content-length", String(MAX_JSON_BODY_BYTES + rng.int(1, 1e9))]);
        notes.push("declared oversize content-length");
        spec.expected = [413];
        spec.expectItems = false;
        spec.authedUserId = null;
        spec.preAuthReject = true;
      } else if (authOk && method === "get") {
        // Request normalises "get" → GET, so this IS the route.
        notes.push("method case-normalised to GET");
      } else if (authOk) {
        spec.expectItems = false;
        spec.authedUserId = null; // authenticated but the route is not reached
        spec.expected = [404, 405];
        notes.push("authenticated; no such route for this method");
      }
      break;
    }
    case "path": {
      bearer(providerToken(rng, sub));
      const variant = rng.weighted([
        [2, "trailing-slash"],
        [2, "double-slash"],
        [2, "upper-case"],
        [2, "slug-appended"],
        [2, "dot-segments"],
        [2, "encoded-slash"],
        [2, "malformed-percent"],
        [2, "nested-v1"],
        [1, "unicode"],
        [1, "very-long"],
        [1, "semicolon"],
        [1, "backslash"],
        [1, "null-byte"],
        [1, "fragment"],
        [1, "missing-v1"],
        [1, "query-only-v1"],
      ] as const);
      notes.push(`path:${variant}`);
      const prefix = mountPrefix(rng);
      const path = {
        "trailing-slash": `${prefix}${ROUTE_PATH}/`,
        "double-slash": `${prefix}//v1//me//saved-drills`,
        "upper-case": `${prefix}/V1/ME/SAVED-DRILLS`,
        "slug-appended": `${prefix}${ROUTE_PATH}/${rng.string(SLUGISH, rng.int(1, 40))}`,
        "dot-segments": `${prefix}/v1/me/../me/./saved-drills`,
        "encoded-slash": `${prefix}/v1/me%2Fsaved-drills`,
        "malformed-percent": `${prefix}${ROUTE_PATH}/%ZZ%`,
        "nested-v1": `${prefix}/v1/me/saved-drills/v1/me/saved-drills`,
        unicode: `${prefix}/v1/me/saved-drills\u4e2d`,
        "very-long": `${prefix}${ROUTE_PATH}/${rng.string(ALNUM, rng.int(4_000, 12_000))}`,
        semicolon: `${prefix}${ROUTE_PATH};x=1`,
        backslash: `${prefix}\\v1\\me\\saved-drills`,
        "null-byte": `${prefix}${ROUTE_PATH}%00`,
        fragment: `${prefix}${ROUTE_PATH}#${rng.string(ALNUM, 8)}`,
        "missing-v1": `${prefix}/me/saved-drills`,
        "query-only-v1": `${prefix}/me/saved-drills?x=/v1/me/saved-drills`,
      }[variant];
      spec.url = `${BASE}${path}${variant === "query-only-v1" ? "" : randomQuery(rng)}`;
      if (pathRoutesToSavedDrills(spec.url)) {
        notes.push("normalizes to the route");
      } else {
        spec.expected = [400, 404];
        spec.expectItems = false;
        spec.authedUserId = null;
      }
      break;
    }
    case "headers": {
      bearer(providerToken(rng, sub));
      const variant = rng.weighted([
        [3, "content-length"],
        [2, "many-headers"],
        [2, "long-header"],
        [2, "duplicate-auth"],
        [1, "empty-xff"],
        [1, "host-override"],
        [1, "transfer-encoding"],
        [1, "expect-100"],
        [1, "range"],
        [1, "if-none-match"],
      ] as const);
      notes.push(`headers:${variant}`);
      switch (variant) {
        case "content-length": {
          const value = rng.pick([
            "0",
            "-1",
            "abc",
            "NaN",
            "Infinity",
            "1e7",
            "0x5F5E100",
            " 6000000",
            "6000000 ",
            "5000000",
            "5000001",
            String(MAX_JSON_BODY_BYTES + rng.int(1, 1e12)),
            "99999999999999999999999",
            "4999999.9",
            "1,000,000,000",
          ]);
          headers.push(["content-length", value]);
          notes.push(`content-length:${JSON.stringify(value)}`);
          const n = Number(value);
          if (Number.isFinite(n) && n > MAX_JSON_BODY_BYTES) {
            spec.expected = [413];
            spec.expectItems = false;
            spec.authedUserId = null;
            spec.preAuthReject = true;
          }
          break;
        }
        case "many-headers":
          for (let i = 0; i < rng.int(50, 150); i++) {
            headers.push([
              `x-fuzz-${rng.string(ALNUM, 6)}`,
              rng.string(HEADER_SAFE, rng.int(0, 40)),
            ]);
          }
          break;
        case "long-header":
          headers.push([
            `x-${rng.string(ALNUM, 4)}`,
            rng.string(HEADER_SAFE, rng.int(8_000, 32_000)),
          ]);
          break;
        case "duplicate-auth":
          // Headers#append joins duplicates with ", " → "Bearer a, Bearer b" is
          // one unverifiable token → 401 (never a crash, never the first one).
          headers.push(["authorization", `Bearer ${providerToken(rng, rng.uuid())}`]);
          authFails("duplicate authorization header");
          break;
        case "empty-xff": {
          // clientIp() → "unknown"; the pre-auth budgets then share one bucket
          // across the whole campaign, so 429 is a legitimate answer here.
          const idx = headers.findIndex(
            ([k]) => k === "x-forwarded-for" || k === "cf-connecting-ip",
          );
          if (idx >= 0) headers.splice(idx, 1);
          headers.push(["x-forwarded-for", rng.pick(["", " ", ",", ", ,"])]);
          spec.expected = [200, 429];
          break;
        }
        case "host-override":
          headers.push(["host", rng.pick(["evil.example", "localhost:8000", "", "a".repeat(300)])]);
          break;
        case "transfer-encoding":
          headers.push(["transfer-encoding", rng.pick(["chunked", "gzip", "identity"])]);
          break;
        case "expect-100":
          headers.push(["expect", "100-continue"]);
          break;
        case "range":
          headers.push(["range", rng.pick(["bytes=0-10", "bytes=-1", "garbage"])]);
          break;
        case "if-none-match":
          headers.push(["if-none-match", rng.pick(["*", '"abc"', 'W/"x"'])]);
          break;
      }
      break;
    }
    case "db-error": {
      bearer(providerToken(rng, sub));
      spec.kind = "upstream";
      spec.expectItems = false;
      spec.expected = [503];
      const status = rng.pick([400, 401, 403, 404, 406, 409, 416, 500, 502, 503, 504, 520, 0]);
      const bodyKind = rng.weighted([
        [4, "pgrst"],
        [1, "html"],
        [1, "empty"],
        [1, "text"],
      ] as const);
      if (status === 0) {
        // socket-level fault: fetch rejects (postgrest-js retries GETs on this too)
        spec.db = { mode: "throw", rows: [], retryAfter: "0" };
        notes.push("postgrest:fetch-throws");
        break;
      }
      const body = {
        pgrst: JSON.stringify({
          code: rng.pick(["42501", "42P01", "PGRST301", "57014", "22P02"]),
          message: rng.pick([
            "permission denied for table user_saved_drills",
            'relation "public.user_saved_drills" does not exist',
            "JWT expired",
            "canceling statement due to statement timeout",
          ]),
          details: null,
          hint: null,
        }),
        html: "<html><body>upstream error at index.ts:2485</body></html>",
        empty: "",
        text: "TypeError: boom\n    at listSavedDrills (index.ts:2485:9)",
      }[bodyKind];
      // 503/520 are RETRIED by postgrest-js (3×, 1s/2s/4s backoff unless
      // Retry-After says otherwise) — mostly answer Retry-After: 0 so the
      // campaign stays fast; the stall itself is measured by a dedicated step.
      const retryAfter =
        status === 503 || status === 520
          ? rng.weighted([
              [6, "0"],
              [1, "1"],
              [1, undefined],
            ] as const)
          : undefined;
      spec.db = {
        mode: "error",
        rows: [],
        status,
        body,
        contentType:
          bodyKind === "pgrst"
            ? "application/json"
            : bodyKind === "html"
              ? "text/html"
              : "text/plain",
        retryAfter,
      };
      notes.push(
        `postgrest:${status}:${bodyKind}${retryAfter !== undefined ? `:retry-after=${retryAfter}` : ""}`,
      );
      if (status === 404 && bodyKind === "empty") {
        // postgrest-js processResponse(): a 404 with an EMPTY body is
        // rewritten to 204 No Content / error=null, so the route cannot see
        // the fault and answers 200 {items: []} (seed 1823129439, 10/10).
        // Characterised, not hidden: the response must still be the
        // well-formed empty list with exactly one read and no writes.
        spec.expected = [200];
        spec.expectItems = true;
        notes.push("postgrest-js maps 404+empty body → 204 success → 200 {items: []}");
      }
      break;
    }
    case "db-shape": {
      bearer(providerToken(rng, sub));
      spec.kind = "upstream";
      const variant = rng.weighted([
        [6, "weird-rows"],
        [1, "object-not-array"],
        [1, "string-body"],
        [1, "number-body"],
        [1, "null-body"],
        [1, "non-json"],
        [1, "empty-body"],
        [1, "nested-array"],
      ] as const);
      notes.push(`db-shape:${variant}`);
      if (variant === "weird-rows") {
        spec.db = { mode: "rows", rows: weirdRows(rng, notes) };
        spec.expectItems = true;
        spec.expected = [200, 500];
      } else {
        const raw = {
          "object-not-array": JSON.stringify({ slug: "x", saved_at: "y" }),
          "string-body": JSON.stringify("wall-dink-rally"),
          "number-body": "42",
          "null-body": "null",
          "non-json": "<html>not json</html>",
          "empty-body": "",
          "nested-array": JSON.stringify([[{ slug: "a", saved_at: "b" }]]),
        }[variant];
        spec.db = {
          mode: "raw",
          rows: [],
          status: 200,
          body: raw,
          contentType: "application/json",
        };
        spec.expectItems = false;
        spec.expected = [200, 500, 503];
      }
      break;
    }
  }
  return spec;
}

// ── Execution ────────────────────────────────────────────────────────────────

interface World {
  h: Harness;
  current: Spec | null;
  calls: UpstreamCall[];
  accessLines: string[];
  stderr: string[];
}

let world: World | null = null;

async function bootWorld(): Promise<World> {
  if (world) {
    world.h.reset();
    return world;
  }
  const h = await loadHarness();
  catalogSlugs = (await drillCatalog()).map((d) => d.slug);
  const w: World = { h, current: null, calls: [], accessLines: [], stderr: [] };
  const harnessFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    w.calls.push({ method: request.method, url: request.url });
    const spec = w.current;
    if (spec?.authUser && request.url.startsWith(`${SUPABASE_URL}/auth/v1/user`)) {
      const a = spec.authUser;
      return new Response(a.status === 204 ? null : a.body, {
        status: a.status,
        headers: {
          "Content-Type": a.contentType,
          ...(a.status === 503 ? { "Retry-After": "7" } : {}),
        },
      });
    }
    if (
      spec &&
      spec.db.mode !== "rows" &&
      request.method === "GET" &&
      request.url.startsWith(`${SUPABASE_URL}/rest/v1/user_saved_drills`)
    ) {
      if (spec.db.mode === "throw")
        throw new TypeError("error sending request for url (stubbed socket fault)");
      return new Response(spec.db.body ?? "", {
        status: spec.db.status ?? 200,
        headers: {
          "Content-Type": spec.db.contentType ?? "application/json",
          ...(spec.db.retryAfter !== undefined ? { "Retry-After": spec.db.retryAfter } : {}),
        },
      });
    }
    return await harnessFetch(request);
  }) as typeof fetch;
  world = w;
  return w;
}

function buildRequest(spec: Spec): Request {
  const headers = new Headers();
  for (const [name, value] of spec.headers) headers.append(name, value);
  return new Request(spec.url, {
    method: spec.method,
    headers,
    body: spec.body === null ? undefined : (spec.body as BodyInit),
  });
}

async function runSpec(w: World, spec: Spec): Promise<Outcome> {
  const outcome: Outcome = {
    seed: spec.seed,
    cls: spec.cls,
    kind: spec.kind,
    method: spec.method,
    url: spec.url.length > 300 ? `${spec.url.slice(0, 300)}…(${spec.url.length} chars)` : spec.url,
    headerNames: spec.headers.map(([k]) => k),
    bodyBytes:
      spec.body === null
        ? 0
        : typeof spec.body === "string"
          ? spec.body.length
          : spec.body.byteLength,
    expected: spec.expected,
    status: 0,
    errorCode: null,
    errorMessage: null,
    requestId: null,
    sentRequestId: spec.sentRequestId,
    upstream: { auth: 0, rest: 0, writes: 0, other: 0 },
    accessLogStatus: null,
    latencyMs: 0,
    verdict: "HELD",
    violations: [],
    notes: spec.notes,
    replay: replayCommand(spec.seed),
  };
  const violate = (v: string) => outcome.violations.push(v);

  let request: Request;
  try {
    request = buildRequest(spec);
  } catch (error) {
    outcome.verdict = "UNCONSTRUCTIBLE";
    outcome.notes = [
      ...spec.notes,
      `Request construction: ${error instanceof Error ? error.message : String(error)}`,
    ];
    return outcome;
  }

  w.h.reset();
  w.h.tables["user_saved_drills"] = spec.db.rows;
  w.calls = [];
  w.accessLines = [];
  w.stderr = [];
  w.current = spec;
  const started = performance.now();
  let response: Response;
  try {
    response = await w.h.handler(request);
  } catch (error) {
    // The Deno.serve wrapper must never throw — this is a hard defect.
    w.current = null;
    outcome.latencyMs = Math.round((performance.now() - started) * 100) / 100;
    outcome.status = -1;
    violate(`handler threw: ${error instanceof Error ? error.message : String(error)}`);
    outcome.verdict = "BROKEN";
    return outcome;
  }
  const text = await response.text();
  w.current = null;
  outcome.latencyMs = Math.round((performance.now() - started) * 100) / 100;
  outcome.status = response.status;

  // ── upstream accounting
  for (const call of w.calls) {
    if (call.url.startsWith(`${SUPABASE_URL}/auth/v1/`)) outcome.upstream.auth++;
    else if (call.url.startsWith(`${SUPABASE_URL}/rest/v1/`)) {
      outcome.upstream.rest++;
      if (call.method !== "GET" && call.method !== "HEAD") outcome.upstream.writes++;
      if (call.url.includes("/rest/v1/rpc/")) outcome.upstream.writes++;
    } else outcome.upstream.other++;
  }
  if (outcome.upstream.writes > 0) violate(`upstream write observed (${outcome.upstream.writes})`);
  if (outcome.upstream.other > 0)
    violate(`unexpected upstream host called (${outcome.upstream.other})`);
  if (spec.preAuthReject && w.calls.length > 0) {
    violate(`pre-auth rejection still made ${w.calls.length} upstream call(s)`);
  }

  // ── request id
  const requestId = response.headers.get("x-request-id");
  outcome.requestId = requestId;
  if (!requestId) violate("x-request-id missing");
  else {
    const sent = spec.sentRequestId?.trim() ?? "";
    if (REQUEST_ID_RE.test(sent)) {
      if (requestId !== sent) violate(`well-formed client request id not echoed (${requestId})`);
    } else if (!UUID_RE.test(requestId)) {
      violate(`request id neither client's nor a UUID: ${requestId}`);
    }
  }
  const accessEntries = w.accessLines
    .map((line) => {
      try {
        return JSON.parse(line) as { requestId?: string; status?: number };
      } catch {
        return null;
      }
    })
    .filter((e): e is { requestId?: string; status?: number } => e !== null);
  if (accessEntries.length !== 1)
    violate(`expected 1 access-log line, saw ${accessEntries.length}`);
  else {
    outcome.accessLogStatus = accessEntries[0].status ?? null;
    if (accessEntries[0].requestId !== requestId)
      violate("access-log request id differs from header");
    if (accessEntries[0].status !== response.status)
      violate("access-log status differs from response");
  }

  // ── body / status classes
  const contentType = response.headers.get("content-type") ?? "";
  let json: unknown = null;
  if (contentType.includes("application/json")) {
    try {
      json = JSON.parse(text);
    } catch {
      violate("application/json response is not JSON");
    }
  }
  const errorObj =
    json && typeof json === "object" && "error" in json
      ? ((json as { error?: unknown }).error as Record<string, unknown> | undefined)
      : undefined;
  if (errorObj) {
    outcome.errorCode = typeof errorObj.code === "string" ? errorObj.code : null;
    outcome.errorMessage = typeof errorObj.message === "string" ? errorObj.message : null;
  }

  if (response.status >= 400) {
    if (spec.method !== "HEAD") {
      if (!contentType.includes("application/json"))
        violate(`error response content-type ${contentType || "(none)"}`);
      if (!errorObj || typeof errorObj.message !== "string")
        violate("error body lacks error.message");
    }
    for (const marker of LEAK_MARKERS) {
      if (text.includes(marker)) violate(`error body leaks "${marker}"`);
    }
    if (response.headers.get("x-content-type-options") !== "nosniff")
      violate("nosniff missing on error");
    if (response.headers.get("cache-control") !== "no-store")
      violate("cache-control no-store missing on error");
  }
  if (response.status >= 500) {
    if (spec.kind === "client") violate(`client input produced ${response.status}`);
    if (!outcome.errorMessage || !GENERIC_5XX_RE.test(outcome.errorMessage)) {
      violate(
        `5xx body not generic: ${JSON.stringify(outcome.errorMessage ?? text.slice(0, 200))}`,
      );
    }
    if (
      response.status === 503 &&
      !response.headers.get("retry-after") &&
      spec.authUser?.mode === "fault"
    ) {
      violate("503 from Auth outage without Retry-After");
    }
  } else if (response.status >= 400 && !ALLOWED_BAD_INPUT.has(response.status)) {
    violate(`status ${response.status} outside the allowed bad-input set`);
  }
  if (response.status === 429) {
    if (outcome.errorCode !== "rate_limited") violate("429 without error.code=rate_limited");
    if (!response.headers.get("retry-after")) violate("429 without Retry-After");
  }
  if (!spec.expected.includes(response.status)) {
    violate(`status ${response.status} not in predicted ${JSON.stringify(spec.expected)}`);
  }

  // ── 200 contract
  if (response.status === 200) {
    if (spec.method === "GET" || spec.method === "HEAD") {
      if (response.headers.get("x-content-type-options") !== "nosniff")
        violate("nosniff missing on 200");
      if (response.headers.get("cache-control") !== "no-store")
        violate("cache-control no-store missing on 200");
      if (response.headers.get("referrer-policy") !== "no-referrer")
        violate("referrer-policy missing on 200");
    }
    if (outcome.upstream.rest !== 1)
      violate(`200 with ${outcome.upstream.rest} PostgREST reads (expected 1)`);
    const read = w.calls.find((c) => c.url.startsWith(`${SUPABASE_URL}/rest/v1/user_saved_drills`));
    if (read) {
      const u = new URL(read.url);
      if (
        u.searchParams.get("select") !== "slug, saved_at" &&
        u.searchParams.get("select") !== "slug,saved_at"
      ) {
        violate(`unexpected select: ${u.searchParams.get("select")}`);
      }
      if (u.searchParams.get("order") !== "saved_at.desc")
        violate(`unexpected order: ${u.searchParams.get("order")}`);
      const scope = u.searchParams.get("user_id");
      if (!scope || !scope.startsWith("eq.")) violate("PostgREST read not scoped by user_id=eq.");
      else if (spec.authedUserId && scope !== `eq.${spec.authedUserId}`) {
        violate(`PostgREST read scoped to ${scope}, expected eq.${spec.authedUserId}`);
      }
    }
    const items =
      json && typeof json === "object" ? (json as { items?: unknown }).items : undefined;
    if (!Array.isArray(items)) violate("200 body lacks items[]");
    else if (spec.expectItems && spec.db.mode === "error") {
      if (items.length !== 0) violate(`items.length ${items.length} for a bodiless upstream 404`);
    } else if (spec.expectItems && spec.db.mode === "rows") {
      const rows = spec.db.rows;
      if (items.length !== rows.length)
        violate(`items.length ${items.length} != rows ${rows.length}`);
      else {
        rows.forEach((row, i) => {
          const item = items[i] as Record<string, unknown>;
          const r = row as Record<string, unknown> | null;
          const slug = r && typeof r === "object" ? String(r.slug) : "undefined";
          const savedAt = r && typeof r === "object" ? String(r.saved_at) : "undefined";
          if (!item || typeof item !== "object") violate(`items[${i}] not an object`);
          else {
            if (item.slug !== slug) violate(`items[${i}].slug mismatch`);
            if (item.title !== slug && !catalogSlugs.includes(slug))
              violate(`items[${i}].title not the slug`);
            if (item.saved_at !== savedAt) violate(`items[${i}].saved_at mismatch`);
            if (typeof item.id !== "string" || !UUID_RE.test(item.id))
              violate(`items[${i}].id not a UUID`);
            if (typeof item.description !== "string") violate(`items[${i}].description missing`);
            if (!Array.isArray(item.equipment)) violate(`items[${i}].equipment missing`);
          }
        });
      }
    }
  }
  if (outcome.violations.length > 0) outcome.verdict = "BROKEN";
  return outcome;
}

interface Campaign {
  meta: Record<string, unknown>;
  summary: Record<string, unknown>;
  fiveXx: Outcome[];
  broken: Outcome[];
  unconstructible: Outcome[];
  records: Outcome[];
}

async function runCampaign(seeds: number[], label: string): Promise<Campaign> {
  const w = await bootWorld();
  const restoreLog = captureAccessLog((line) => w.accessLines.push(line));
  const realError = console.error;
  const realWarn = console.warn;
  console.error = (...args: unknown[]) => w.stderr.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => w.stderr.push(args.map(String).join(" "));
  const records: Outcome[] = [];
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  try {
    for (const seed of seeds) {
      const spec = generate(seed);
      for (let r = 0; r < STRESS_REPEAT; r++) {
        records.push(await runSpec(w, spec));
      }
    }
  } finally {
    restoreLog();
    console.error = realError;
    console.warn = realWarn;
  }
  const wallMs = Math.round(performance.now() - t0);
  const executed = records.filter((r) => r.verdict !== "UNCONSTRUCTIBLE");
  const broken = executed.filter((r) => r.verdict === "BROKEN");
  const fiveXx = executed.filter((r) => r.status >= 500 || r.status < 0);
  const hist = (key: (o: Outcome) => string) =>
    executed.reduce<Record<string, number>>(
      (acc, o) => ((acc[key(o)] = (acc[key(o)] ?? 0) + 1), acc),
      {},
    );
  const byClassStatus = executed.reduce<Record<string, Record<string, number>>>((acc, o) => {
    acc[o.cls] ??= {};
    acc[o.cls][String(o.status)] = (acc[o.cls][String(o.status)] ?? 0) + 1;
    return acc;
  }, {});
  const latencies = executed.map((r) => r.latencyMs).sort((a, b) => a - b);
  const pct = (p: number) =>
    latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))] ?? 0;
  return {
    meta: {
      label,
      route: `GET ${ROUTE_PATH}`,
      masterSeed: STRESS_SEED,
      iterations: seeds.length,
      repeat: STRESS_REPEAT,
      replaySeeds: STRESS_REPLAY,
      startedAt,
      wallMs,
      deno: Deno.version.deno,
      seedDerivation: "iterSeed(masterSeed, i) = murmur3-finalizer(master ^ ((i+1) * 0x9e3779b1))",
      replayTemplate: replayCommand(0).replace("STRESS_REPLAY=0", "STRESS_REPLAY=<seed>"),
    },
    summary: {
      executed: executed.length,
      held: executed.length - broken.length,
      broken: broken.length,
      unconstructible: records.length - executed.length,
      fiveXx: fiveXx.length,
      byClass: hist((o) => o.cls),
      byStatus: hist((o) => String(o.status)),
      byVerdict: hist((o) => o.verdict),
      byClassStatus,
      latencyMs: {
        p50: pct(0.5),
        p95: pct(0.95),
        p99: pct(0.99),
        max: latencies[latencies.length - 1] ?? 0,
      },
      totalUpstreamWrites: executed.reduce((n, o) => n + o.upstream.writes, 0),
    },
    fiveXx,
    broken,
    unconstructible: records.filter((r) => r.verdict === "UNCONSTRUCTIBLE"),
    records,
  };
}

async function persist(campaign: Campaign, suffix = ""): Promise<void> {
  if (!STRESS_OUT) return;
  const path = suffix ? STRESS_OUT.replace(/(\.json)?$/, `${suffix}$1`) : STRESS_OUT;
  await Deno.writeTextFile(path, JSON.stringify(campaign, null, 2));
}

function brokenSummary(campaign: Campaign): string {
  return campaign.broken
    .slice(0, 25)
    .map(
      (o) =>
        `seed=${o.seed} cls=${o.cls} status=${o.status} :: ${o.violations.join("; ")}\n  replay: ${o.replay}`,
    )
    .join("\n");
}

// ── Tests ────────────────────────────────────────────────────────────────────

Deno.test(
  `stress fuzz-boundary: GET /v1/me/saved-drills — ${STRESS_REPLAY.length ? `replay ${STRESS_REPLAY.length} seed(s)` : `${STRESS_ITER} seeded requests`} (master seed ${STRESS_SEED})`,
  async () => {
    const seeds = STRESS_REPLAY.length
      ? STRESS_REPLAY
      : Array.from({ length: STRESS_ITER }, (_, i) => iterSeed(STRESS_SEED, i));
    const campaign = await runCampaign(seeds, STRESS_REPLAY.length ? "replay" : "sweep");
    await persist(campaign);
    console.log(
      `[stress saved-drills] ${JSON.stringify({ ...campaign.summary, byClassStatus: undefined })}`,
    );
    for (const five of campaign.fiveXx) {
      console.log(
        `[stress saved-drills] 5xx seed=${five.seed} cls=${five.cls} status=${five.status} kind=${five.kind} notes=${five.notes.join("|")}`,
      );
    }
    assert((campaign.summary.executed as number) > 0, "no request executed");
    assertEquals(campaign.broken.length, 0, `BROKEN iterations:\n${brokenSummary(campaign)}`);
  },
);

/** Characterises what ONE PostgREST fault costs the caller: postgrest-js
 * (pinned 2.112.4) retries idempotent reads on 503/520 and on socket errors up
 * to 3 more times, sleeping 1s/2s/4s (or `Retry-After` seconds) between them,
 * and listSavedDrills passes neither `.retry(false)` nor an AbortSignal. The
 * contract asserted here is the generic-503/no-write/request-id invariant plus
 * a 20s ceiling (the mobile api.ts budget); the measured stall and upstream
 * hit count are recorded in the JSON artifact for the finding. */
Deno.test({
  name: "stress upstream-fault: PostgREST 503 / socket fault → generic 503, no writes; stall + retry amplification measured (STRESS_ITER >= 1000 only)",
  ignore: STRESS_ITER < 1000 || STRESS_REPLAY.length > 0,
  async fn() {
    const w = await bootWorld();
    const rng = new Prng(iterSeed(STRESS_SEED, 0x503503));
    const restoreLog = captureAccessLog(() => undefined);
    const realError = console.error;
    console.error = () => undefined;
    const measurements: Array<Record<string, unknown>> = [];
    try {
      const cases: Array<{ name: string; db: DbBehaviour }> = [
        {
          name: "503 no Retry-After",
          db: {
            mode: "error",
            rows: [],
            status: 503,
            body: '{"message":"schema cache"}',
            contentType: "application/json",
          },
        },
        {
          name: "503 Retry-After: 2",
          db: {
            mode: "error",
            rows: [],
            status: 503,
            body: "{}",
            contentType: "application/json",
            retryAfter: "2",
          },
        },
        {
          name: "520 no Retry-After",
          db: { mode: "error", rows: [], status: 520, body: "", contentType: "text/plain" },
        },
        { name: "socket fault (fetch rejects)", db: { mode: "throw", rows: [] } },
        {
          name: "500 (not retried)",
          db: {
            mode: "error",
            rows: [],
            status: 500,
            body: '{"message":"boom"}',
            contentType: "application/json",
          },
        },
      ];
      for (const c of cases) {
        const sub = rng.uuid();
        const spec: Spec = {
          ...generate(iterSeed(STRESS_SEED, 1)),
          seed: 0,
          cls: "stall",
          kind: "upstream",
          method: "GET",
          url: `${BASE}/functions/v1/api${ROUTE_PATH}`,
          headers: [
            ["authorization", `Bearer ${providerToken(rng, sub)}`],
            ["x-forwarded-for", rng.ipv4()],
          ],
          body: null,
          sentRequestId: null,
          authedUserId: sub,
          preAuthReject: false,
          expected: [503],
          expectItems: false,
          db: c.db,
          authUser: null,
          notes: [c.name],
        };
        w.h.reset();
        w.h.tables["user_saved_drills"] = [];
        w.calls = [];
        w.current = spec;
        const t0 = performance.now();
        const res = await w.h.handler(buildRequest(spec));
        const body = await res.json();
        w.current = null;
        const latencyMs = Math.round(performance.now() - t0);
        const restHits = w.calls.filter((k) => k.url.startsWith(`${SUPABASE_URL}/rest/v1/`)).length;
        const writes = w.calls.filter(
          (k) => k.url.includes("/rest/v1/") && k.method !== "GET",
        ).length;
        measurements.push({
          case: c.name,
          status: res.status,
          message: body?.error?.message,
          restHits,
          writes,
          latencyMs,
          requestId: res.headers.get("x-request-id"),
        });
        assertEquals(res.status, 503, c.name);
        assert(
          GENERIC_5XX_RE.test(String(body?.error?.message)),
          `${c.name}: body not generic: ${JSON.stringify(body)}`,
        );
        assert(res.headers.get("x-request-id"), `${c.name}: x-request-id missing`);
        assertEquals(writes, 0, `${c.name}: upstream write observed`);
        assert(
          latencyMs < 20_000,
          `${c.name}: ${latencyMs}ms exceeds the mobile 20s request budget`,
        );
      }
    } finally {
      w.current = null;
      console.error = realError;
      restoreLog();
    }
    console.log(
      `[stress saved-drills] upstream-fault stall table: ${JSON.stringify(measurements)}`,
    );
    if (STRESS_OUT) {
      await Deno.writeTextFile(
        STRESS_OUT.replace(/(\.json)?$/, "-upstream-stall$1"),
        JSON.stringify(
          { route: `GET ${ROUTE_PATH}`, postgrestJs: "2.112.4 (deno.lock)", measurements },
          null,
          2,
        ),
      );
    }
  },
});

/** Wait until the current aligned window has at least `minRemainingMs` left,
 * so a burst never straddles a window boundary (which would legitimately
 * reset the count mid-burst). */
async function alignWindow(windowSeconds: number, minRemainingMs: number): Promise<void> {
  const windowMs = windowSeconds * 1000;
  const remaining = windowMs - (Date.now() % windowMs);
  if (remaining < minRemainingMs) await new Promise((r) => setTimeout(r, remaining + 50));
}

Deno.test(
  "stress rate-limit: 241st request of one user inside a minute is 429 with Retry-After (no writes)",
  async () => {
    if (STRESS_REPLAY.length) return;
    const w = await bootWorld();
    const rng = new Prng(iterSeed(STRESS_SEED, 0xa11ce));
    const sub = rng.uuid();
    const token = providerToken(rng, sub);
    await alignWindow(60, 6_000);
    const restoreLog = captureAccessLog(() => undefined);
    const statuses: number[] = [];
    let writes = 0;
    try {
      for (let i = 0; i < 241; i++) {
        w.h.reset();
        w.h.tables["user_saved_drills"] = [];
        w.calls = [];
        const res = await w.h.handler(
          new Request(`${BASE}/functions/v1/api${ROUTE_PATH}`, {
            headers: { authorization: `Bearer ${token}`, "x-forwarded-for": rng.ipv4() },
          }),
        );
        statuses.push(res.status);
        writes += w.calls.filter((c) => c.url.includes("/rest/v1/") && c.method !== "GET").length;
        if (i === 240) {
          assertEquals(res.status, 429);
          assert(res.headers.get("retry-after"), "Retry-After missing");
          assertEquals(res.headers.get("ratelimit-limit"), "240");
          assertEquals(res.headers.get("ratelimit-remaining"), "0");
          assert(res.headers.get("x-request-id"), "x-request-id missing on 429");
          assertEquals((await res.json()).error.code, "rate_limited");
        } else {
          await res.body?.cancel();
        }
      }
    } finally {
      restoreLog();
    }
    assertEquals(
      statuses.slice(0, 240).every((s) => s === 200),
      true,
      `statuses: ${JSON.stringify(statuses)}`,
    );
    assertEquals(writes, 0);
    console.log(
      `[stress saved-drills] rate-limit user budget: 240×200 then 429 (${statuses.length} requests)`,
    );
  },
);

Deno.test(
  "stress rate-limit: 31st bad bearer from one IP inside 5 minutes is 429 (auth-failure budget) and never reaches Auth",
  async () => {
    if (STRESS_REPLAY.length) return;
    const w = await bootWorld();
    const rng = new Prng(iterSeed(STRESS_SEED, 0xbadbad));
    const ip = rng.ipv4();
    await alignWindow(300, 6_000);
    const restoreLog = captureAccessLog(() => undefined);
    const statuses: number[] = [];
    let upstream = 0;
    try {
      for (let i = 0; i < 31; i++) {
        w.h.reset();
        w.calls = [];
        const res = await w.h.handler(
          new Request(`${BASE}/functions/v1/api${ROUTE_PATH}`, {
            headers: {
              authorization: `Bearer ${rng.string(ALNUM, rng.int(5, 60))}`,
              "x-forwarded-for": ip,
            },
          }),
        );
        statuses.push(res.status);
        upstream += w.calls.length;
        await res.body?.cancel();
      }
    } finally {
      restoreLog();
    }
    assertEquals(
      statuses.slice(0, 30).every((s) => s === 401),
      true,
      `statuses: ${JSON.stringify(statuses)}`,
    );
    assertEquals(statuses[30], 429);
    assertEquals(upstream, 0, "malformed bearers must never reach Supabase Auth");
    console.log(
      `[stress saved-drills] auth-failure budget: 30×401 then 429 (${statuses.length} requests)`,
    );
  },
);

Deno.test({
  name: "stress rate-limit: 1201st request from one IP inside a minute is 429 (per-IP budget; STRESS_ITER >= 1200 only)",
  ignore: STRESS_ITER < 1200 || STRESS_REPLAY.length > 0,
  async fn() {
    const w = await bootWorld();
    const rng = new Prng(iterSeed(STRESS_SEED, 0x1b1b1b));
    const ip = rng.ipv4();
    await alignWindow(60, 15_000);
    const restoreLog = captureAccessLog(() => undefined);
    const statuses: number[] = [];
    try {
      for (let i = 0; i < 1201; i++) {
        w.h.reset();
        w.h.tables["user_saved_drills"] = [];
        const res = await w.h.handler(
          new Request(`${BASE}/functions/v1/api${ROUTE_PATH}`, {
            headers: {
              authorization: `Bearer ${providerToken(rng, rng.uuid())}`,
              "x-forwarded-for": ip,
            },
          }),
        );
        statuses.push(res.status);
        await res.body?.cancel();
      }
    } finally {
      restoreLog();
    }
    assertEquals(
      statuses.slice(0, 1200).every((s) => s === 200),
      true,
      `non-200 before the cap: ${JSON.stringify(
        statuses
          .map((s, i) => [i, s])
          .filter(([, s]) => s !== 200)
          .slice(0, 10),
      )}`,
    );
    assertEquals(statuses[1200], 429);
    console.log(`[stress saved-drills] ip budget: 1200×200 then 429 (${statuses.length} requests)`);
  },
});
