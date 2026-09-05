// Fuzz/boundary campaign for the router's public-read and fallthrough surface:
// GET|HEAD /healthz, /privacy, /terms (+ /support), unknown paths, unknown or
// unsupported methods, malformed parameterized segments, hostile headers and
// bodies — all against the REAL handler in-process (routesHarness: Supabase
// Auth/PostgREST/RevenueCat stubbed at the fetch layer, no port, no network).
//
// Every iteration is derived from a 32-bit seed (mixed from STRESS_SEED and the
// iteration index) and is replayable on its own:
//
//   STRESS_ITER=3000 STRESS_SEED=20260905 STRESS_OUT=/tmp/fuzz.json deno task test --filter stress
//   STRESS_REPLAY=123456789,987654321 STRESS_REPLAY_TIMES=10 deno task test --filter stress
//
// Invariants asserted per request (the "oracle" mirrors index.ts routing):
//   - status ∈ the expected set for that input class (public read → 200/429;
//     oversized declared body → 413; no/invalid bearer → 401/429; malformed
//     parameterized segment → 400/429; anything else → 404/429). Any 5xx is a
//     failure and its seed is recorded.
//   - x-request-id present on every response (echoed only when well-formed).
//   - error bodies are {error:{message}} JSON, carry no stack trace / file
//     path / stub leak; 5xx (if any) must be one of the generic messages.
//   - hardening headers present; 429 carries Retry-After.
//   - the stubbed backend saw NO PostgREST/RPC call (only Supabase Auth may be
//     consulted for a bearer) — i.e. no write on rejection.
//   - exactly one structured access-log line per request, correlated by id.
//
// STRESS_ITER defaults to a suite-friendly 300 in-process requests and
// STRESS_SOCKET_ITER to 40 raw HTTP/1.1 requests over a loopback Deno.serve
// (wire-level path/method/header fuzz that the Request constructor cannot
// express). Set STRESS_ITER=3000 for the full campaign.

import { assert, assertEquals } from "@std/assert";
import { captureAccessLog } from "../http.ts";
import { PRIVACY_POLICY_TEXT, SUPPORT_TEXT, TERMS_TEXT } from "../legal.ts";
import { fakeAppleIdToken, fakeGoogleIdToken, loadHarness, SUPABASE_URL } from "./routesHarness.ts";

// ───────────────────────────── configuration ─────────────────────────────

const envInt = (name: string, fallback: number): number => {
  const raw = Deno.env.get(name);
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
};

const STRESS_ITER = envInt("STRESS_ITER", 300);
const STRESS_SEED = envInt("STRESS_SEED", 20260905);
const STRESS_SOCKET_ITER = envInt("STRESS_SOCKET_ITER", 40);
const STRESS_REPLAY_TIMES = envInt("STRESS_REPLAY_TIMES", 1);
const STRESS_REPLAY = (Deno.env.get("STRESS_REPLAY") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => Number(s) >>> 0);
const STRESS_OUT = Deno.env.get("STRESS_OUT") ?? "";

const MAX_JSON_BODY_BYTES = 5_000_000;
const ORIGIN = "http://edge.test";

// ───────────────────────────── seeded RNG ─────────────────────────────

/** mulberry32 — small, fast, deterministic. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Per-iteration seed: murmur3-style finalizer over (master, index). */
export function iterationSeed(master: number, index: number): number {
  let h = (master ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  range(min: number, maxInclusive: number): number {
    return min + this.int(maxInclusive - min + 1);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
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
  str(alphabet: string, length: number): string {
    let out = "";
    for (let i = 0; i < length; i++) out += alphabet[this.int(alphabet.length)];
    return out;
  }
  bytes(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = this.int(256);
    return out;
  }
}

// ───────────────────────────── vocab ─────────────────────────────

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const PATH_PUNCT = "-._~!$&'()*+,;=:@%";
const HEADER_VALUE_ALPHABET =
  ALNUM + " \t!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~" + "\u00a0\u00e9\u00ff\u0080\u00c3\u00bf";
const UNICODE_SAMPLES = [
  "é",
  "ß",
  "日本",
  "😀",
  "\u202e",
  "\u0000",
  "\ufeff",
  "\u00ad",
  "\ud800",
  "𝔘",
];

const DOC_SUFFIXES = ["/healthz", "/support", "/privacy", "/terms"] as const;
const DOC_BODIES: Record<(typeof DOC_SUFFIXES)[number], string> = {
  "/healthz": JSON.stringify({ ok: true }),
  "/support": SUPPORT_TEXT,
  "/privacy": PRIVACY_POLICY_TEXT,
  "/terms": TERMS_TEXT,
};

const MOUNT_PREFIXES = [
  "",
  "/functions/v1/api",
  "/api",
  "/functions/v1/api/v1",
  "/v1",
  "/v1/me",
  "/x/y/z",
  "/functions/v1/api/v1/me",
];

const ROUTE_WORDS = [
  "v1",
  "me",
  "healthz",
  "privacy",
  "terms",
  "support",
  "webhooks",
  "revenuecat",
  "sessions",
  "shots:sync",
  "analysis-permits",
  "finalize",
  "catalog",
  "drills",
  "saved-drills",
  "auth",
  "refresh",
  "logout",
  "bootstrap",
  "account",
  "progress",
  "rank",
  "training-plans",
  "current",
  "consent",
  "status",
  "grant",
  "withdraw",
  "delete-request",
  "delete-confirm",
  "evaluation",
  "trials",
  "billing",
  "sync",
  "access",
  "onboarding",
  "analyses",
  "feedback",
  "admin",
  "internal",
  "debug",
  "graphql",
  ".env",
  "..",
  ".",
  "HEALTHZ",
  "Healthz",
  "healthz.json",
  "healthz%00",
  "health%7A",
  "%2e%2e",
  "%2F",
  "%ZZ",
  "%E0%A4%A",
  "%",
  "%%",
  "%C0%AF",
  "%FF",
];

// Exact routes the switch/pre-auth handlers own (regardless of bearer) —
// generated combos that resolve to one of these are OUT of this unit and are
// re-rolled. Parameterized templates are handled by `paramRouteVerdict`.
const KNOWN_EXACT_ROUTES = new Set([
  "POST /v1/account/bootstrap",
  "POST /v1/auth/refresh",
  "POST /v1/auth/logout",
  "GET /v1/me",
  "PUT /v1/me/onboarding",
  "GET /v1/me/access",
  "POST /v1/billing/sync",
  "POST /v1/analysis-permits",
  "POST /v1/shots:sync",
  "POST /v1/sessions",
  "POST /v1/me/evaluation/trials",
  "GET /v1/progress",
  "GET /v1/rank",
  "GET /v1/me/consent/status",
  "POST /v1/me/consent/grant",
  "POST /v1/me/consent/withdraw",
  "POST /v1/me/delete-request",
  "POST /v1/me/delete-confirm",
  "GET /v1/me/saved-drills",
  "GET /v1/training-plans/current",
  "POST /v1/training-plans",
  "GET /v1/catalog/drills",
]);

// Request() normalizes these (case-insensitively) to upper case; every other
// token (e.g. "patch", "FOO") is kept verbatim. CONNECT/TRACE/TRACK throw.
const NORMALIZED_METHODS = ["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"];
const METHOD_POOL = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "get",
  "head",
  "post",
  "patch",
  "Get",
  "PROPFIND",
  "PURGE",
  "FOO",
  "GETT",
  "G3T",
  "M-SEARCH",
  "LOCK",
  "REPORT",
  "QUERY",
];

// ───────────────────────────── case model ─────────────────────────────

type AuthClass =
  | "none"
  | "non-bearer"
  | "garbage"
  | "jwt-random"
  | "provider-expired"
  | "provider-valid"
  | "session-shaped";

type Kind =
  | "public-read"
  | "public-wrong-method"
  | "unknown-path"
  | "param-bad-segment"
  | "header-fuzz"
  | "body-fuzz";

interface FuzzCase {
  seed: number;
  kind: Kind;
  method: string;
  /** method after Request() normalization — what the router sees */
  routerMethod: string;
  url: string;
  headers: Array<[string, string]>;
  body: string | Uint8Array | null;
  authClass: AuthClass;
  expected: number[];
  /** the doc suffix served when this is a public read */
  doc: (typeof DOC_SUFFIXES)[number] | null;
  requestId: string | null;
  note: string;
}

interface CaseResult {
  seed: number;
  kind: Kind;
  method: string;
  url: string;
  urlLength: number;
  authClass: AuthClass;
  headers: Record<string, string>;
  bodyBytes: number;
  expected: number[];
  status: number | null;
  requestId: string | null;
  outcome: "HELD" | "BROKEN" | "UNCONSTRUCTIBLE";
  reasons: string[];
  restCalls: number;
  authCalls: number;
  durationMs: number;
  note: string;
}

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** encodeURIComponent that survives lone surrogates (URIError otherwise). */
const encodeLoose = (value: string): string => {
  try {
    return encodeURIComponent(value);
  } catch {
    return encodeURIComponent(value.toWellFormed());
  }
};

const clip = (value: string, max = 240): string =>
  value.length > max ? `${value.slice(0, max)}…(+${value.length - max})` : value;

// Mirrors index.ts decodeJwtPayload / providerForIssuer / bearerExpired so the
// oracle predicts whether authenticate() will treat a fuzzed bearer as a
// provider token that the stubbed Auth exchange accepts.
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  try {
    const base64 = segments[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(base64)) as Record<string, unknown>;
  } catch {
    return null;
  }
}
function providerForIssuer(issuer: unknown): "google" | "apple" | null {
  if (typeof issuer !== "string") return null;
  const iss = issuer.replace(/^https:\/\//, "");
  if (iss === "accounts.google.com") return "google";
  if (iss === "appleid.apple.com") return "apple";
  return null;
}
function bearerExpired(payload: Record<string, unknown> | null): boolean {
  return typeof payload?.exp === "number" && payload.exp * 1_000 <= Date.now();
}
function bearerOf(headers: Headers): string {
  const authorization = headers.get("Authorization") ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
}
/** What authenticate() will conclude for this bearer under the stub. */
function bearerVerdict(headers: Headers): "valid" | "reject" {
  const token = bearerOf(headers);
  if (!token) return "reject";
  const payload = decodeJwtPayload(token);
  const provider = providerForIssuer(payload?.iss);
  if (!provider) return "reject"; // session-shaped bearers are refused by our /auth/v1/user stub
  if (bearerExpired(payload)) return "reject";
  return "valid";
}

const USER_POOL = Array.from(
  { length: 64 },
  (_, i) => `${(0x10000000 + i).toString(16)}-0000-4000-8000-${String(i).padStart(12, "0")}`,
);

function genAuth(rng: Rng): { cls: AuthClass; header: string | null } {
  const cls = rng.weighted<AuthClass>([
    [22, "none"],
    [5, "non-bearer"],
    [10, "garbage"],
    [16, "jwt-random"],
    [5, "provider-expired"],
    [34, "provider-valid"],
    [8, "session-shaped"],
  ]);
  const now = Math.floor(Date.now() / 1000);
  switch (cls) {
    case "none":
      return { cls, header: null };
    case "non-bearer":
      return {
        cls,
        header: rng.pick([
          `Basic ${b64url("user:pass")}`,
          `bearer ${fakeGoogleIdToken()}`,
          `Token ${rng.str(ALNUM, 24)}`,
          `Bearer`,
          `Bearer ${" ".repeat(rng.range(1, 4))}`,
          fakeGoogleIdToken(),
        ]),
      };
    case "garbage":
      return {
        cls,
        header: `Bearer ${rng.pick([
          rng.str(ALNUM + ".", rng.range(1, 40)),
          rng.str(HEADER_VALUE_ALPHABET, rng.range(1, 200)),
          "a".repeat(rng.range(1000, 60_000)),
          "..",
          "...",
          "x.y",
          "x..y",
          `${b64url("{}")}.${b64url("{}")}.${b64url("{}")}.${b64url("{}")}`,
        ])}`,
      };
    case "jwt-random": {
      const header = b64url(
        JSON.stringify({ alg: rng.pick(["none", "RS256", "HS256"]), typ: "JWT" }),
      );
      const issuer = rng.pick([
        "https://accounts.google.com",
        "accounts.google.com",
        "https://appleid.apple.com",
        "https://accounts.google.com.evil.example",
        "https://evil.example/auth/v1",
        `${SUPABASE_URL}/auth/v1`,
        "",
        null,
        42,
        ["https://accounts.google.com"],
        { iss: "https://accounts.google.com" },
      ]);
      const exp = rng.pick<unknown>([
        now + 3600,
        now - 3600,
        now + 5,
        now - 5,
        0,
        -1,
        1e308,
        -1e308,
        "9999999999",
        String(now + 3600),
        null,
        [now + 3600],
        Number.NaN,
        undefined,
      ]);
      const sub = rng.pick<unknown>([
        rng.pick(USER_POOL),
        "",
        null,
        12345,
        { $ne: null },
        "a".repeat(rng.range(1, 5000)),
        undefined,
      ]);
      const payloadValue: unknown = rng.pick<unknown>([
        { iss: issuer, sub, exp },
        { iss: issuer, sub, exp, session_id: rng.str(ALNUM, 16) },
        { iss: issuer, sub, exp, aud: "authenticated", role: "service_role" },
        null,
        [1, 2],
        "string",
        123,
        true,
        {},
      ]);
      const payloadSegment = rng.chance(0.85)
        ? b64url(JSON.stringify(payloadValue))
        : rng.pick(["", "!!!", "%%%", rng.str(ALNUM, 7), b64url("{not json")]);
      return {
        cls,
        header: `Bearer ${header}.${payloadSegment}.${rng.pick(["sig", "", rng.str(ALNUM, 43)])}`,
      };
    }
    case "provider-expired": {
      const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
      const payload = b64url(
        JSON.stringify({
          iss: rng.pick(["https://accounts.google.com", "https://appleid.apple.com"]),
          sub: rng.pick(USER_POOL),
          exp: now - rng.range(5, 10_000_000),
        }),
      );
      return { cls, header: `Bearer ${header}.${payload}.sig` };
    }
    case "provider-valid": {
      const sub = rng.pick(USER_POOL);
      const token = rng.chance(0.5) ? fakeGoogleIdToken(sub) : fakeAppleIdToken(sub);
      return {
        cls,
        header: `Bearer ${rng.chance(0.1) ? "  " : ""}${token}${rng.chance(0.1) ? " " : ""}`,
      };
    }
    case "session-shaped": {
      const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
      const payload = b64url(
        JSON.stringify({
          iss: `${SUPABASE_URL}/auth/v1`,
          sub: rng.pick(USER_POOL),
          exp: now + 3600,
          session_id: rng.str(ALNUM, 12),
          aud: "authenticated",
        }),
      );
      return { cls, header: `Bearer ${header}.${payload}.${rng.str(ALNUM, 43)}` };
    }
  }
}

function genIpHeaders(rng: Rng, hot: boolean): Array<[string, string]> {
  if (hot) return [["cf-connecting-ip", "198.51.100.77"]];
  const ip = `10.${rng.int(256)}.${rng.int(256)}.${rng.int(256)}`;
  switch (rng.int(6)) {
    case 0:
      return [["cf-connecting-ip", ip]];
    case 1:
      return [["cf-connecting-ip", `  ${ip}\t`]];
    case 2:
      return [["x-forwarded-for", ip]];
    case 3:
      return [["x-forwarded-for", `${rng.str("0123456789.", 12)}, ${ip}`]];
    case 4:
      return [
        ["x-forwarded-for", `${ip}, `],
        ["cf-connecting-ip", ""],
      ];
    default:
      return [["x-forwarded-for", `1.1.1.1,,,  , ${ip}`]];
  }
}

function genPathSegment(rng: Rng): string {
  return rng.weighted<() => string>([
    [40, () => rng.pick(ROUTE_WORDS)],
    [15, () => rng.str(ALNUM, rng.range(1, 12))],
    [10, () => rng.str(ALNUM + PATH_PUNCT, rng.range(1, 24))],
    [8, () => encodeLoose(rng.pick(UNICODE_SAMPLES))],
    [6, () => rng.pick(UNICODE_SAMPLES)],
    [6, () => `%${rng.str("0123456789ABCDEFabcdefGZ", 2)}`],
    [5, () => rng.str(ALNUM, rng.range(200, 8000))],
    [4, () => rng.pick(["", " ", "%20", "%2e", "%2E%2E", "%2f", "%5c", "\\", "~", "*"])],
    [3, () => rng.str(ALNUM, rng.range(50_000, 120_000))],
    [3, () => rng.pick(["00000000-0000-4000-8000-000000000000", "123456789", "0", "-1"])],
  ])();
}

function genQuery(rng: Rng): string {
  if (rng.chance(0.55)) return "";
  const n = rng.range(1, 6);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const key = rng.pick([
      "q",
      "healthz",
      "path",
      "__proto__",
      "constructor",
      rng.str(ALNUM, 5),
      "",
    ]);
    const value = rng.weighted<string>([
      [5, rng.str(ALNUM, rng.range(0, 20))],
      [2, encodeLoose(rng.pick(UNICODE_SAMPLES))],
      [2, rng.pick(["%ZZ", "%00", "%", "<script>", "'", '"', "\\"])],
      [1, rng.str(ALNUM, rng.range(2000, 20_000))],
    ]);
    parts.push(rng.chance(0.15) ? key : `${key}=${value}`);
  }
  return `?${parts.join(rng.pick(["&", "&", ";", "&&"]))}`;
}

function genDocPath(rng: Rng): { path: string; doc: (typeof DOC_SUFFIXES)[number] | null } {
  const doc = rng.pick(DOC_SUFFIXES);
  const prefix = rng.pick(MOUNT_PREFIXES);
  const exact = rng.chance(0.55);
  if (exact) {
    // Shapes the URL parser normalizes back to the exact suffix.
    const shape = rng.pick([
      `${prefix}${doc}`,
      `${prefix}${doc}`,
      `${prefix}/${doc}`, // double slash
      `${prefix}/./${doc.slice(1)}`,
      `${prefix}/x/..${doc}`,
      `${prefix}${doc}#frag`,
      `/v1/me/..${doc}`,
    ]);
    return { path: shape, doc };
  }
  const mutated = rng.pick([
    `${prefix}${doc.toUpperCase()}`,
    `${prefix}${doc}/`,
    `${prefix}${doc}.json`,
    `${prefix}${doc}%00`,
    `${prefix}${doc}%20`,
    `${prefix}${doc};jsessionid=1`,
    `${prefix}${doc}${rng.pick(UNICODE_SAMPLES)}`,
    `${prefix}/${doc.slice(1, 3)}%${doc.slice(3).charCodeAt(0).toString(16)}${doc.slice(4)}`,
    `${prefix}/a${doc.slice(1)}`,
    `${prefix}${doc}${doc}x`,
    `${prefix}/${encodeURIComponent(doc.slice(1))}z`,
    `${prefix}${doc.replace(/[a-z]$/, (c) => c.toUpperCase())}`,
    `${prefix}/%2F${doc.slice(1)}`,
  ]);
  return { path: mutated, doc: null };
}

function genUnknownPath(rng: Rng): string {
  const prefix = rng.chance(0.5) ? rng.pick(MOUNT_PREFIXES) : "";
  const n = rng.range(1, 6);
  const segments: string[] = [];
  for (let i = 0; i < n; i++) segments.push(genPathSegment(rng));
  let path = `${prefix}/${segments.join("/")}`;
  if (rng.chance(0.2)) path += "/";
  if (rng.chance(0.1)) path = path.replace(/\//, "//");
  return path;
}

const PARAM_TEMPLATES: Array<{ method: string; build: (seg: string) => string }> = [
  { method: "POST", build: (s) => `/v1/analysis-permits/${s}/finalize` },
  { method: "POST", build: (s) => `/v1/sessions/${s}/finalize` },
  { method: "POST", build: (s) => `/v1/analyses/${s}/feedback` },
  { method: "PUT", build: (s) => `/v1/me/saved-drills/${s}` },
  { method: "DELETE", build: (s) => `/v1/me/saved-drills/${s}` },
  { method: "GET", build: (s) => `/v1/catalog/drills/${s}` },
];
const BAD_SEGMENTS = [
  "%ZZ",
  "%E0%A4%A",
  "%",
  "%%",
  "%C0%AF",
  "%FF",
  "%ED%A0%80",
  "%2",
  "a%",
  "%G0%00",
];

function genContentType(rng: Rng): string {
  return rng.pick([
    "application/json",
    "application/json; charset=utf-8",
    "text/plain",
    "application/x-www-form-urlencoded",
    "multipart/form-data; boundary=----x",
    "application/octet-stream",
    "",
    "application/json\u00ff",
    rng.str(HEADER_VALUE_ALPHABET, rng.range(1, 300)),
    `application/json; charset=${rng.str(ALNUM, 20)}`,
  ]);
}

function genBody(rng: Rng): string | Uint8Array {
  return rng.weighted<() => string | Uint8Array>([
    [20, () => JSON.stringify({ [rng.str(ALNUM, 5)]: rng.str(ALNUM, rng.range(0, 40)) })],
    [8, () => "{"],
    [8, () => rng.pick(["", " ", "null", "[]", "1e999", '""', '{"__proto__":{"x":1}}'])],
    [10, () => rng.bytes(rng.range(1, 4096))],
    [8, () => rng.str(ALNUM, rng.range(10_000, 200_000))],
    [6, () => JSON.stringify(Array.from({ length: rng.range(1, 5000) }, () => rng.int(10)))],
    [4, () => "[".repeat(rng.range(1000, 100_000))],
    [3, () => rng.pick(UNICODE_SAMPLES).repeat(rng.range(1, 3000))],
    [1, () => new Uint8Array(MAX_JSON_BODY_BYTES + 1)],
  ])();
}

function genExtraHeaders(rng: Rng): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const n = rng.range(0, 5);
  for (let i = 0; i < n; i++) {
    out.push(
      rng.weighted<[string, string]>([
        [3, ["accept", rng.pick(["*/*", "application/json", "text/html", "", rng.str(ALNUM, 50)])]],
        [
          3,
          [
            "content-length",
            rng.pick([
              "abc",
              "-1",
              "0x10",
              "1e7",
              " 6000000 ",
              "5000000",
              "5000001",
              "Infinity",
              "NaN",
              "0",
              "999999999999999999999",
              "1,2",
            ]),
          ],
        ],
        [2, ["content-type", genContentType(rng)]],
        [2, ["host", rng.pick(["evil.example", "", "localhost:8000", rng.str(ALNUM, 300)])]],
        [2, ["origin", rng.pick(["https://evil.example", "null", ""])]],
        [2, ["x-forwarded-host", rng.str(ALNUM, 40)]],
        [2, ["x-forwarded-proto", rng.pick(["http", "https", "gopher"])]],
        [2, ["accept-encoding", rng.pick(["gzip", "br", "identity;q=0", rng.str(ALNUM, 100)])]],
        [2, ["range", rng.pick(["bytes=0-", "bytes=-1", "bytes=999999999999-", "x"])]],
        [2, ["if-none-match", rng.pick(["*", '"abc"', 'W/""'])]],
        [2, ["cookie", rng.str(HEADER_VALUE_ALPHABET.replace(/[;,]/g, ""), rng.range(0, 4000))]],
        [2, ["user-agent", rng.str(HEADER_VALUE_ALPHABET, rng.range(0, 3000))]],
        [2, ["x-request-id", rng.str(HEADER_VALUE_ALPHABET, rng.range(0, 100))]],
        [1, ["transfer-encoding", rng.pick(["chunked", "gzip", "identity"])]],
        [1, ["expect", "100-continue"]],
        [1, ["upgrade", "websocket"]],
        [1, ["connection", rng.pick(["close", "keep-alive", "upgrade"])]],
        [
          1,
          [
            `x-${rng.str("abcdefghijklmnopqrstuvwxyz-", rng.range(1, 30))}`,
            rng.str(HEADER_VALUE_ALPHABET, rng.range(0, 8000)),
          ],
        ],
        [1, ["x-huge", "h".repeat(rng.range(8000, 64_000))]],
      ]),
    );
  }
  return out;
}

function genRequestId(rng: Rng): string | null {
  return rng.weighted<string | null>([
    [40, null],
    [20, rng.str(ALNUM + "._-", rng.range(8, 64))],
    [10, rng.str(ALNUM, rng.range(1, 7))],
    [10, rng.str(ALNUM, rng.range(65, 300))],
    [
      10,
      `${rng.str(ALNUM, 12)}${rng.pick([" ", "/", ":", "\u00e9", "\t", "%00", '"', "{"])}${rng.str(ALNUM, 4)}`,
    ],
    [5, ` ${rng.str(ALNUM, 16)} `],
    [5, ""],
  ]);
}

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeMethod(method: string): string {
  const upper = method.toUpperCase();
  return NORMALIZED_METHODS.includes(upper) ? upper : method;
}

/** Route seen by the switch (index.ts: everything from the LAST "/v1/"). */
function routeOf(method: string, pathname: string): { route: string; path: string } {
  const v1 = pathname.lastIndexOf("/v1/");
  const path = v1 >= 0 ? pathname.slice(v1) : pathname;
  return { route: `${method} ${path}`, path };
}

/** Parameterized-route verdict: "known" (valid segment → a real route, out of
 * unit), "bad" (decodeURIComponent throws → 400), or null (not parameterized). */
function paramRouteVerdict(method: string, path: string): "known" | "bad" | null {
  const patterns: Array<[string[], RegExp]> = [
    [["POST"], /^\/v1\/analysis-permits\/([^/]+)\/finalize$/],
    [["POST"], /^\/v1\/sessions\/([^/]+)\/finalize$/],
    [["POST"], /^\/v1\/analyses\/([^/]+)\/feedback$/],
    [["PUT", "DELETE"], /^\/v1\/me\/saved-drills\/([^/]+)$/],
    [["GET"], /^\/v1\/catalog\/drills\/([^/]+)$/],
  ];
  for (const [methods, re] of patterns) {
    if (!methods.includes(method)) continue;
    const m = re.exec(path);
    if (!m) continue;
    try {
      decodeURIComponent(m[1]);
      return "known";
    } catch {
      return "bad";
    }
  }
  return null;
}

interface Oracle {
  expected: number[] | "out-of-unit";
  doc: (typeof DOC_SUFFIXES)[number] | null;
}

/** Predict the acceptable status set for a request the router will see. */
function oracle(routerMethod: string, url: URL, headers: Headers): Oracle {
  const isPublicRead = routerMethod === "GET" || routerMethod === "HEAD";
  if (isPublicRead) {
    for (const doc of DOC_SUFFIXES) {
      if (url.pathname.endsWith(doc)) return { expected: [200, 429], doc };
    }
  }
  if (routerMethod === "POST" && url.pathname.endsWith("/webhooks/revenuecat")) {
    return { expected: "out-of-unit", doc: null };
  }
  const contentLength = Number(headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES) {
    return { expected: [413], doc: null };
  }
  const { route, path } = routeOf(routerMethod, url.pathname);
  if (KNOWN_EXACT_ROUTES.has(route)) return { expected: "out-of-unit", doc: null };
  if (bearerVerdict(headers) === "reject") return { expected: [401, 429], doc: null };
  const param = paramRouteVerdict(routerMethod, path);
  if (param === "known") return { expected: "out-of-unit", doc: null };
  if (param === "bad") return { expected: [400, 429], doc: null };
  return { expected: [404, 429], doc: null };
}

/** Build one deterministic case from a seed (re-rolling out-of-unit combos). */
export function generateCase(seed: number): FuzzCase {
  const rng = new Rng(seed);
  for (let attempt = 0; attempt < 32; attempt++) {
    const kind = rng.weighted<Kind>([
      [24, "public-read"],
      [14, "public-wrong-method"],
      [28, "unknown-path"],
      [8, "param-bad-segment"],
      [14, "header-fuzz"],
      [12, "body-fuzz"],
    ]);
    const hot = rng.chance(0.04);
    const headers: Array<[string, string]> = [...genIpHeaders(rng, hot)];
    const auth = genAuth(rng);
    if (auth.header !== null) headers.push(["authorization", auth.header]);
    const requestId = genRequestId(rng);
    if (requestId !== null) headers.push(["x-request-id", requestId]);

    let method: string;
    let path: string;
    let note = hot ? "hot-ip " : "";
    switch (kind) {
      case "public-read": {
        method = rng.chance(0.75) ? rng.pick(["GET", "get", "Get"]) : rng.pick(["HEAD", "head"]);
        path = genDocPath(rng).path;
        break;
      }
      case "public-wrong-method": {
        method = rng.pick(METHOD_POOL.filter((m) => !/^(get|head)$/i.test(m)));
        path = `${rng.pick(MOUNT_PREFIXES)}${rng.pick(DOC_SUFFIXES)}`;
        break;
      }
      case "unknown-path": {
        method = rng.pick(METHOD_POOL);
        path = genUnknownPath(rng);
        break;
      }
      case "param-bad-segment": {
        const template = rng.pick(PARAM_TEMPLATES);
        method = template.method;
        const seg = rng.chance(0.8)
          ? rng.pick(BAD_SEGMENTS)
          : `${rng.str(ALNUM, 3)}${rng.pick(BAD_SEGMENTS)}`;
        path = `${rng.pick(["", "/functions/v1/api"])}${template.build(seg)}`;
        note += `segment=${seg} `;
        break;
      }
      case "header-fuzz": {
        method = rng.pick(METHOD_POOL);
        path = rng.chance(0.5) ? genDocPath(rng).path : genUnknownPath(rng);
        headers.push(...genExtraHeaders(rng), ...genExtraHeaders(rng));
        break;
      }
      case "body-fuzz": {
        method = rng.pick(METHOD_POOL.filter((m) => !/^(get|head)$/i.test(m)));
        path = rng.chance(0.5)
          ? `${rng.pick(MOUNT_PREFIXES)}${rng.pick(DOC_SUFFIXES)}`
          : genUnknownPath(rng);
        headers.push(["content-type", genContentType(rng)]);
        break;
      }
    }
    if (rng.chance(0.3)) headers.push(...genExtraHeaders(rng));
    const routerMethod = normalizeMethod(method);
    const hasBody =
      routerMethod !== "GET" &&
      routerMethod !== "HEAD" &&
      (kind === "body-fuzz" || rng.chance(0.5));
    const body = hasBody ? genBody(rng) : null;

    let url: URL;
    let headerView: Headers;
    try {
      url = new URL(`${ORIGIN}${path}${genQuery(rng)}`);
      // Duplicate names combine (", ") exactly as the handler will see them.
      headerView = new Headers(headers);
    } catch {
      continue;
    }
    const verdict = oracle(routerMethod, url, headerView);
    if (verdict.expected === "out-of-unit") continue;
    return {
      seed,
      kind,
      method,
      routerMethod,
      url: url.href,
      headers,
      body,
      authClass: auth.cls,
      expected: verdict.expected,
      doc: verdict.doc,
      requestId,
      note: note.trim(),
    };
  }
  // Astronomically unlikely (needs 32 consecutive out-of-unit rolls) — a
  // fixed, always-in-unit fallback keeps every seed executable.
  return {
    seed,
    kind: "unknown-path",
    method: "GET",
    routerMethod: "GET",
    url: `${ORIGIN}/v1/stress/${seed}`,
    headers: [["cf-connecting-ip", "10.9.9.9"]],
    body: null,
    authClass: "none",
    expected: [401, 429],
    doc: null,
    requestId: null,
    note: "fallback",
  };
}

// ───────────────────────────── execution ─────────────────────────────

const STACK_TRACE_RE =
  /\n\s+at\s|\.ts:\d+|file:\/\/|\bTypeError\b|\bReferenceError\b|\bRangeError\b|\bSyntaxError\b|\bURIError\b|\bError:|node_modules|supabase\.test|unexpected fetch in test|service_role/i;
const GENERIC_5XX_RE =
  /^(Something went wrong\. Please try again\.|[A-Za-z ]+ (is|are) temporarily unavailable\. Please try again\.)$/;

interface Sink {
  access: Array<Record<string, unknown>>;
  logs: string[];
}

async function runCase(
  h: Awaited<ReturnType<typeof loadHarness>>,
  fuzz: FuzzCase,
  sink: Sink,
): Promise<CaseResult> {
  const headerRecord: Record<string, string> = {};
  for (const [k, v] of fuzz.headers) headerRecord[k] = clip(v, 120);
  const base: Omit<
    CaseResult,
    "status" | "requestId" | "outcome" | "reasons" | "restCalls" | "authCalls" | "durationMs"
  > = {
    seed: fuzz.seed,
    kind: fuzz.kind,
    method: fuzz.method,
    url: clip(fuzz.url, 300),
    urlLength: fuzz.url.length,
    authClass: fuzz.authClass,
    headers: headerRecord,
    bodyBytes:
      fuzz.body === null
        ? 0
        : typeof fuzz.body === "string"
          ? new TextEncoder().encode(fuzz.body).length
          : fuzz.body.length,
    expected: fuzz.expected,
    note: fuzz.note,
  };

  let request: Request;
  try {
    request = new Request(fuzz.url, {
      method: fuzz.method,
      headers: fuzz.headers,
      body: fuzz.body as BodyInit | null,
    });
  } catch (error) {
    return {
      ...base,
      status: null,
      requestId: null,
      outcome: "UNCONSTRUCTIBLE",
      reasons: [`Request(): ${clip(String(error), 160)}`],
      restCalls: 0,
      authCalls: 0,
      durationMs: 0,
    };
  }

  h.reset();
  sink.access.length = 0;
  sink.logs.length = 0;
  const reasons: string[] = [];
  const startedAt = performance.now();
  let response: Response;
  try {
    response = await h.handler(request);
  } catch (error) {
    return {
      ...base,
      status: null,
      requestId: null,
      outcome: "BROKEN",
      reasons: [`handler threw: ${clip(String(error), 300)}`],
      restCalls: 0,
      authCalls: 0,
      durationMs: performance.now() - startedAt,
    };
  }
  const text = await response.text();
  const durationMs = performance.now() - startedAt;
  const status = response.status;
  const requestId = response.headers.get("x-request-id");
  const contentType = response.headers.get("content-type") ?? "";

  // 1. status class
  if (!fuzz.expected.includes(status)) {
    reasons.push(`status ${status} ∉ [${fuzz.expected.join(",")}]`);
  }
  if (status >= 500) reasons.push(`5xx: ${clip(text, 200)}`);

  // 2. request id
  if (!requestId) reasons.push("missing x-request-id");
  else {
    const supplied = request.headers.get("x-request-id")?.trim() ?? "";
    if (REQUEST_ID_RE.test(supplied)) {
      if (requestId !== supplied) reasons.push(`request id not echoed (${clip(requestId, 80)})`);
    } else if (!UUID_RE.test(requestId)) {
      reasons.push(`minted request id not a UUID / echoed unsafe input: ${clip(requestId, 80)}`);
    }
  }

  // 3. body / headers by status
  if ((response.headers.get("x-content-type-options") ?? "").toLowerCase() !== "nosniff") {
    reasons.push("missing X-Content-Type-Options: nosniff");
  }
  if (status === 200) {
    if (!fuzz.doc) reasons.push("200 on a non-public path");
    else if (text !== DOC_BODIES[fuzz.doc])
      reasons.push(`200 body is not the ${fuzz.doc} document`);
    if (fuzz.doc === "/healthz") {
      if (!contentType.includes("application/json"))
        reasons.push(`healthz content-type ${contentType}`);
    } else if (fuzz.doc && !contentType.startsWith("text/plain")) {
      reasons.push(`legal doc content-type ${contentType}`);
    }
  } else {
    if (!contentType.includes("application/json"))
      reasons.push(`error content-type ${contentType || "(none)"}`);
    if ((response.headers.get("cache-control") ?? "") !== "no-store")
      reasons.push("error response cacheable");
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      reasons.push(`error body not JSON: ${clip(text, 120)}`);
    }
    const message =
      parsed && typeof parsed === "object" && "error" in parsed
        ? (parsed as { error?: { message?: unknown } }).error?.message
        : undefined;
    if (typeof message !== "string" || !message) reasons.push("error body lacks error.message");
    else {
      if (STACK_TRACE_RE.test(message))
        reasons.push(`error message leaks internals: ${clip(message, 160)}`);
      if (status >= 500 && !GENERIC_5XX_RE.test(message))
        reasons.push(`5xx body not generic: ${clip(message, 160)}`);
    }
    if (STACK_TRACE_RE.test(text))
      reasons.push(`raw error body leaks internals: ${clip(text, 160)}`);
    if (status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"));
      if (!(retryAfter > 0)) reasons.push("429 without positive Retry-After");
    }
  }

  // 4. backend side effects — only Supabase Auth may be consulted (bearer
  //    exchange/lookup); PostgREST/RPC must never be reached on these paths.
  const restCalls = h.calls.filter((c) => c.url.startsWith(`${SUPABASE_URL}/rest/v1/`));
  const authCalls = h.calls.filter((c) => c.url.startsWith(`${SUPABASE_URL}/auth/v1/`));
  const foreignCalls = h.calls.filter((c) => !c.url.startsWith(`${SUPABASE_URL}/auth/v1/`));
  if (restCalls.length > 0) {
    reasons.push(
      `PostgREST reached: ${restCalls.map((c) => `${c.method} ${clip(c.url, 80)}`).join(" | ")}`,
    );
  }
  if (foreignCalls.length !== restCalls.length) {
    reasons.push(
      `unexpected outbound call: ${foreignCalls.map((c) => `${c.method} ${clip(c.url, 80)}`).join(" | ")}`,
    );
  }
  if (status === 200 && h.calls.length > 0) reasons.push("public document consulted the backend");

  // 5. exactly one access log line, correlated
  if (sink.access.length !== 1) reasons.push(`${sink.access.length} access-log lines`);
  else {
    const entry = sink.access[0];
    if (entry.requestId !== requestId) reasons.push("access log request id mismatch");
    if (entry.status !== status) reasons.push("access log status mismatch");
    if (entry.method !== request.method) reasons.push("access log method mismatch");
  }
  const unhandled = sink.logs.filter((line) => line.includes("unhandled error"));
  if (unhandled.length > 0)
    reasons.push(`handler logged unhandled error: ${clip(unhandled[0], 200)}`);

  return {
    ...base,
    status,
    requestId,
    outcome: reasons.length === 0 ? "HELD" : "BROKEN",
    reasons,
    restCalls: restCalls.length,
    authCalls: authCalls.length,
    durationMs,
  };
}

interface CampaignSummary {
  master_seed: number;
  iterations_requested: number;
  executed: number;
  unconstructible: number;
  held: number;
  broken: number;
  by_status: Record<string, number>;
  by_kind: Record<string, number>;
  by_auth: Record<string, number>;
  seeds_broken: number[];
  seeds_5xx: number[];
  p50_ms: number;
  p99_ms: number;
  max_ms: number;
}

function summarize(master: number, requested: number, results: CaseResult[]): CampaignSummary {
  const executed = results.filter((r) => r.outcome !== "UNCONSTRUCTIBLE");
  const count = (key: (r: CaseResult) => string) =>
    executed.reduce<Record<string, number>>((acc, r) => {
      const k = key(r);
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
  const durations = executed.map((r) => r.durationMs).sort((a, b) => a - b);
  const pct = (p: number) =>
    durations.length
      ? durations[Math.min(durations.length - 1, Math.floor(p * durations.length))]
      : 0;
  return {
    master_seed: master,
    iterations_requested: requested,
    executed: executed.length,
    unconstructible: results.length - executed.length,
    held: executed.filter((r) => r.outcome === "HELD").length,
    broken: executed.filter((r) => r.outcome === "BROKEN").length,
    by_status: count((r) => String(r.status)),
    by_kind: count((r) => r.kind),
    by_auth: count((r) => r.authClass),
    seeds_broken: executed.filter((r) => r.outcome === "BROKEN").map((r) => r.seed),
    seeds_5xx: executed
      .filter((r) => (r.status ?? 0) >= 500 || r.status === null)
      .map((r) => r.seed),
    p50_ms: Number(pct(0.5).toFixed(2)),
    p99_ms: Number(pct(0.99).toFixed(2)),
    max_ms: Number((durations[durations.length - 1] ?? 0).toFixed(2)),
  };
}

async function withCapturedLogs<T>(sink: Sink, fn: () => Promise<T>): Promise<T> {
  const realError = console.error;
  const realWarn = console.warn;
  const realLog = console.log;
  console.error = (...args: unknown[]) => sink.logs.push(`error: ${args.map(String).join(" ")}`);
  console.warn = (...args: unknown[]) => sink.logs.push(`warn: ${args.map(String).join(" ")}`);
  console.log = (...args: unknown[]) => sink.logs.push(`log: ${args.map(String).join(" ")}`);
  const restoreAccess = captureAccessLog((line) => {
    try {
      sink.access.push(JSON.parse(line));
    } catch {
      sink.logs.push(`access(unparseable): ${line}`);
    }
  });
  try {
    return await fn();
  } finally {
    restoreAccess();
    console.error = realError;
    console.warn = realWarn;
    console.log = realLog;
  }
}

/** Session-shaped bearers reach Supabase Auth's getUser(); a real Auth refuses
 * an unsigned token with 401. The harness default (599) would surface as a
 * 503 that is a stub artefact, not router behaviour — answer like Auth does. */
function installAuthUserStub(h: Awaited<ReturnType<typeof loadHarness>>): () => void {
  const previous = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(`${SUPABASE_URL}/auth/v1/user`)) {
      h.calls.push({ url, method: init?.method ?? "GET", headers: {}, body: null });
      return Promise.resolve(
        new Response(
          JSON.stringify({ code: 401, msg: "invalid JWT: unable to parse or verify signature" }),
          {
            status: 401,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    }
    return previous(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = previous;
  };
}

async function writeArtifact(name: string, payload: unknown): Promise<void> {
  if (!STRESS_OUT) return;
  const path = STRESS_OUT.endsWith(".json")
    ? STRESS_OUT.replace(/\.json$/, `.${name}.json`)
    : `${STRESS_OUT}.${name}.json`;
  await Deno.writeTextFile(path, JSON.stringify(payload, null, 2));
}

Deno.test(
  `stress fuzz-boundary: public reads + router fallthrough, in-process (STRESS_ITER=${STRESS_ITER}, STRESS_SEED=${STRESS_SEED})`,
  async () => {
    const h = await loadHarness();
    const restoreFetch = installAuthUserStub(h);
    const sink: Sink = { access: [], logs: [] };
    const seeds: number[] =
      STRESS_REPLAY.length > 0
        ? STRESS_REPLAY.flatMap((s) =>
            Array.from({ length: Math.max(1, STRESS_REPLAY_TIMES) }, () => s),
          )
        : Array.from({ length: STRESS_ITER }, (_, i) => iterationSeed(STRESS_SEED, i));
    const results: CaseResult[] = [];
    try {
      await withCapturedLogs(sink, async () => {
        for (const seed of seeds) {
          results.push(await runCase(h, generateCase(seed), sink));
        }
      });
    } finally {
      restoreFetch();
      h.reset();
    }
    const summary = summarize(STRESS_SEED, seeds.length, results);
    await writeArtifact("inprocess", { summary, results });

    const broken = results.filter((r) => r.outcome === "BROKEN");
    const report = broken
      .slice(0, 12)
      .map(
        (r) =>
          `seed=${r.seed} ${r.method} ${r.url} auth=${r.authClass} status=${r.status} → ${r.reasons.join("; ")}`,
      )
      .join("\n");
    assert(summary.executed > 0, "no iteration executed");
    assertEquals(
      broken.length,
      0,
      `${broken.length}/${summary.executed} iterations broke an invariant (replay: STRESS_REPLAY=${broken
        .slice(0, 12)
        .map((r) => r.seed)
        .join(",")}):\n${report}`,
    );
    // The campaign must actually exercise the unit, not just get throttled.
    const nonThrottled = summary.executed - (summary.by_status["429"] ?? 0);
    assert(
      nonThrottled >= summary.executed * 0.5,
      `too many 429s to be meaningful: ${JSON.stringify(summary.by_status)}`,
    );
  },
);

// ───────────────────────────── wire-level campaign ─────────────────────────────
//
// Raw HTTP/1.1 over loopback through the REAL Deno.serve (captured handler),
// for shapes Request() refuses to build: invalid method tokens, absolute-form
// and garbage request-targets, raw control bytes, duplicate/contradictory
// Content-Length, oversized header blocks. Requests the HTTP parser rejects
// never reach the handler (no access-log line) and are recorded as
// "parser-rejected"; anything the handler answered is held to the same
// request-id / generic-body / no-write invariants.

interface WireResult {
  seed: number;
  requestLine: string;
  headers: string[];
  headerBytes: number;
  bodyBytes: number;
  status: number | null;
  reached_handler: boolean;
  outcome: "HELD" | "BROKEN" | "PARSER_REJECTED" | "CLOSED_NO_RESPONSE" | "TIMEOUT_NO_RESPONSE";
  reasons: string[];
  responseHead: string;
}

function genWireRequest(rng: Rng): { requestLine: string; headers: string[]; body: Uint8Array } {
  const method = rng.weighted<string>([
    [14, rng.pick(METHOD_POOL)],
    [2, rng.pick(["TRACE", "CONNECT", "TRACK"])],
    [2, rng.str(ALNUM + "!#$%&'*+-.^_`|~", rng.range(1, 12))],
    [1, rng.pick(["G ET", "GET\tX", "", "GET;", "\x01GET", "GÉT", "G\x7fT"])],
  ]);
  const doc = rng.pick(DOC_SUFFIXES);
  const target = rng.weighted<string>([
    [10, `${rng.pick(MOUNT_PREFIXES)}${doc}`],
    [8, genUnknownPath(rng)],
    [2, `http://edge.test${rng.pick(MOUNT_PREFIXES)}${doc}`],
    [2, `http://evil.example${doc}`],
    [1, "*"],
    [1, "edge.test:80"],
    [1, `${doc} HTTP/1.1\r\nX-Smuggled: 1\r\n`],
    [1, `${doc}${rng.pick([" ", "\t", "\x00", "\x7f", "\xff", "é", "#frag", "?a=b c"])}`],
    [1, `/${rng.str(ALNUM, rng.range(20_000, 70_000))}`],
    [1, "//edge.test/healthz"],
    [1, `${doc}%`],
    [1, ""],
  ]);
  const version = rng.weighted<string>([
    [24, "HTTP/1.1"],
    [4, "HTTP/1.0"],
    [1, "HTTP/2.0"],
    [1, "HTTP/1.2"],
    [1, "HTTP/9.9"],
    [1, "HTTQ/1.1"],
    [1, ""],
  ]);
  const requestLine = `${method} ${target} ${version}`.replace(/ +$/, version === "" ? "" : "$&");
  const headers: string[] = [
    `Host: ${rng.weighted<string>([
      [6, "edge.test"],
      [1, ""],
      [1, "evil.example:99"],
      [1, rng.str(ALNUM, 300)],
    ])}`,
  ];
  const wantBody = rng.chance(0.4) && !/^(GET|HEAD)$/.test(method);
  const body = wantBody
    ? new TextEncoder().encode(rng.pick(["{}", "{", rng.str(ALNUM, rng.range(1, 4000)), "x"]))
    : new Uint8Array(0);
  if (wantBody) {
    const cl = rng.weighted<string>([
      [6, String(body.length)],
      [1, String(body.length + 10)],
      [1, String(Math.max(0, body.length - 1))],
      [1, "-1"],
      [1, "abc"],
      [1, "0x10"],
      [1, "6000000"],
      [1, "5000001"],
      [1, "99999999999999999999"],
    ]);
    headers.push(`Content-Length: ${cl}`);
    if (rng.chance(0.15)) headers.push(`Content-Length: ${body.length}`);
    if (rng.chance(0.15)) headers.push("Transfer-Encoding: chunked");
    if (rng.chance(0.5))
      headers.push(`Content-Type: ${genContentType(rng).replace(/[\r\n]/g, "")}`);
  }
  const authClass = genAuth(rng);
  if (authClass.header !== null && rng.chance(0.7))
    headers.push(
      `Authorization: ${stripChars(authClass.header, (code) => code === 0 || code === 10 || code === 13)}`,
    );
  if (rng.chance(0.5))
    headers.push(`X-Forwarded-For: 10.${rng.int(256)}.${rng.int(256)}.${rng.int(256)}`);
  if (rng.chance(0.3))
    headers.push(
      `X-Request-Id: ${rng.pick([rng.str(ALNUM, 16), rng.str(ALNUM, 3), "a b", "x".repeat(300), ""])}`,
    );
  const extra = rng.range(0, 4);
  for (let i = 0; i < extra; i++) {
    headers.push(
      rng.weighted<string>([
        [
          8,
          `X-${rng.str("abcdefghijklmnopqrstuvwxyz-", rng.range(1, 20))}: ${rng.str(ALNUM + " ", rng.range(0, 2000))}`,
        ],
        [1, `X-Huge: ${"h".repeat(rng.range(30_000, 70_000))}`],
        [1, `${rng.str(ALNUM, 5)} : bad-name-space`],
        [1, `X-Ctl: a\x01b`],
        [1, `X-Utf8: é日本`],
        [1, "Connection: keep-alive"],
        [1, "Expect: 100-continue"],
        [1, "Upgrade: h2c"],
        [1, `Cookie: ${rng.str(ALNUM + "=;", rng.range(0, 3000))}`],
      ]),
    );
  }
  headers.push("Connection: close");
  return { requestLine, headers, body };
}

const stripChars = (value: string, drop: (code: number) => boolean): string =>
  Array.from(value)
    .filter((c) => !drop(c.charCodeAt(0)))
    .join("");

const escapeControl = (value: string): string =>
  Array.from(value)
    .map((c) => {
      const code = c.charCodeAt(0);
      return code < 0x20 || code === 0x7f ? `\\x${code.toString(16).padStart(2, "0")}` : c;
    })
    .join("");

/** Strip HTTP/1.1 interim (1xx) responses so the final status line is judged. */
function finalResponse(text: string): string {
  let out = text;
  for (;;) {
    const m = /^HTTP\/1\.[01] 1\d\d[^\r\n]*\r\n/.exec(out);
    if (!m) return out;
    const end = out.indexOf("\r\n\r\n");
    if (end < 0) return out;
    out = out.slice(end + 4);
  }
}

interface WireRead {
  bytes: Uint8Array;
  ended: "eof" | "timeout" | "error";
}

async function readAll(conn: Deno.Conn, timeoutMs: number): Promise<WireRead> {
  const chunks: Uint8Array[] = [];
  const buffer = new Uint8Array(65_536);
  const deadline = Date.now() + timeoutMs;
  let ended: WireRead["ended"] = "timeout";
  while (Date.now() < deadline) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), Math.max(1, deadline - Date.now()));
    });
    // A read still pending when the deadline fires rejects once the socket is
    // closed below; that rejection is expected, not a test failure.
    const pending = conn.read(buffer).catch(() => "error" as const);
    const read = await Promise.race([pending, timeout]);
    clearTimeout(timer);
    if (read === "timeout") break;
    if (read === "error") {
      ended = "error";
      break;
    }
    if (read === null) {
      ended = "eof";
      break;
    }
    chunks.push(buffer.slice(0, read));
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return { bytes, ended };
}

Deno.test(
  `stress fuzz-boundary: raw HTTP/1.1 wire fuzz through Deno.serve (STRESS_SOCKET_ITER=${STRESS_SOCKET_ITER})`,
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    if (STRESS_SOCKET_ITER === 0) return;
    const h = await loadHarness();
    const restoreFetch = installAuthUserStub(h);
    const sink: Sink = { access: [], logs: [] };
    const ready = Promise.withResolvers<number>();
    const server = h.realServe(
      {
        hostname: "127.0.0.1",
        port: 0,
        onListen: ({ port }) => ready.resolve(port),
        onError: (error) => {
          sink.logs.push(`serve onError: ${String(error)}`);
          return new Response(null, { status: 500 });
        },
      },
      (request) => h.handler(request),
    );
    const port = await ready.promise;
    const results: WireResult[] = [];
    const decoder = new TextDecoder();
    try {
      await withCapturedLogs(sink, async () => {
        for (let i = 0; i < STRESS_SOCKET_ITER; i++) {
          const seed = iterationSeed(STRESS_SEED ^ 0x5a5a5a5a, i);
          const rng = new Rng(seed);
          const wire = genWireRequest(rng);
          sink.access.length = 0;
          sink.logs.length = 0;
          h.reset();
          const head = `${wire.requestLine}\r\n${wire.headers.join("\r\n")}\r\n\r\n`;
          const headBytes = new TextEncoder().encode(head);
          const conn = await Deno.connect({ hostname: "127.0.0.1", port });
          let raw: WireRead = { bytes: new Uint8Array(0), ended: "error" };
          try {
            await conn.write(headBytes);
            if (wire.body.length > 0) await conn.write(wire.body);
            raw = await readAll(conn, 1500);
          } catch (error) {
            sink.logs.push(`socket: ${String(error)}`);
          } finally {
            try {
              conn.close();
            } catch {
              // already closed by the server
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 2));
          const responseText = raw.bytes.length > 0 ? finalResponse(decoder.decode(raw.bytes)) : "";
          const statusMatch = /^HTTP\/1\.[01] (\d{3})/.exec(responseText);
          const status = statusMatch ? Number(statusMatch[1]) : null;
          const reached = sink.access.length > 0;
          const reasons: string[] = [];
          const headerEnd = responseText.indexOf("\r\n\r\n");
          const responseHead = headerEnd >= 0 ? responseText.slice(0, headerEnd) : responseText;
          const responseBody = headerEnd >= 0 ? responseText.slice(headerEnd + 4) : "";
          let outcome: WireResult["outcome"];
          if (raw.bytes.length === 0) {
            // The server dropped or stalled the connection without answering.
            // Legitimate for a request its HTTP parser refuses, a bug if the
            // handler had already run for it.
            outcome = raw.ended === "timeout" ? "TIMEOUT_NO_RESPONSE" : "CLOSED_NO_RESPONSE";
            if (reached)
              reasons.push(
                `handler ran (${sink.access.length} access-log lines) but client got no response`,
              );
          } else if (!reached) {
            outcome = "PARSER_REJECTED";
            if (status === null || status < 400 || status >= 500)
              reasons.push(`parser-level response ${status}`);
          } else {
            if (status === null) reasons.push("handler ran but no parseable status line");
            else if (![200, 400, 401, 403, 404, 405, 413, 415, 429].includes(status))
              reasons.push(`status ${status}`);
            if (!/^x-request-id: \S+$/im.test(responseHead)) reasons.push("missing x-request-id");
            if (STACK_TRACE_RE.test(responseBody))
              reasons.push(`body leaks internals: ${clip(responseBody, 160)}`);
            if (sink.access.length !== 1) reasons.push(`${sink.access.length} access-log lines`);
            const restCalls = h.calls.filter((c) => c.url.startsWith(`${SUPABASE_URL}/rest/v1/`));
            if (restCalls.length > 0) reasons.push(`PostgREST reached: ${restCalls.length}`);
            if (
              sink.logs.some((l) => l.includes("unhandled error") || l.startsWith("serve onError"))
            ) {
              reasons.push(`handler error logged: ${clip(sink.logs.join(" || "), 200)}`);
            }
            outcome = reasons.length === 0 ? "HELD" : "BROKEN";
          }
          if (outcome !== "HELD" && outcome !== "BROKEN" && reasons.length > 0) outcome = "BROKEN";
          results.push({
            seed,
            requestLine: clip(escapeControl(wire.requestLine), 200),
            headers: wire.headers.map((line) => clip(escapeControl(line), 120)),
            headerBytes: headBytes.length,
            bodyBytes: wire.body.length,
            status,
            reached_handler: reached,
            outcome,
            reasons,
            responseHead: clip(responseHead, 400),
          });
        }
      });
    } finally {
      restoreFetch();
      h.reset();
      await server.shutdown();
    }
    const tally = results.reduce<Record<string, number>>((acc, r) => {
      acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
      return acc;
    }, {});
    await writeArtifact("wire", {
      master_seed: STRESS_SEED,
      iterations: STRESS_SOCKET_ITER,
      tally,
      results,
    });
    const broken = results.filter((r) => r.outcome === "BROKEN");
    assertEquals(
      broken.length,
      0,
      `${broken.length} wire iterations broke an invariant:\n${broken
        .slice(0, 12)
        .map((r) => `seed=${r.seed} ${r.requestLine} status=${r.status} → ${r.reasons.join("; ")}`)
        .join("\n")}`,
    );
    assert(
      results.some((r) => r.reached_handler),
      `no wire request reached the handler: ${JSON.stringify(tally)}`,
    );
  },
);

Deno.test("stress fuzz-boundary: generator is deterministic per seed", () => {
  for (let i = 0; i < 50; i++) {
    const seed = iterationSeed(STRESS_SEED, i);
    const a = generateCase(seed);
    const b = generateCase(seed);
    assertEquals(a.url, b.url);
    assertEquals(a.method, b.method);
    assertEquals(a.headers, b.headers);
    assertEquals(a.expected, b.expected);
    assertEquals(
      typeof a.body === "string"
        ? a.body
        : a.body === null
          ? null
          : Array.from(a.body.slice(0, 64)),
      typeof b.body === "string"
        ? b.body
        : b.body === null
          ? null
          : Array.from(b.body.slice(0, 64)),
    );
  }
});
