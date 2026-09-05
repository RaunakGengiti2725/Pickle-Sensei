// Seeded fuzz / boundary campaign for POST /v1/auth/logout against the REAL
// edge handler (routesHarness: Deno.serve captured, Supabase Auth + PostgREST
// + RevenueCat stubbed at the fetch layer, Upstash unset → in-memory limits).
//
// Every iteration derives a 32-bit seed from STRESS_SEED and builds ONE
// request (method, path shape, query, bearer, request id, client ip, body,
// content-type, content-length) plus ONE upstream fault plan (GET
// /auth/v1/user, POST /auth/v1/logout, POST /auth/v1/token) from that seed
// alone, so any row of the results table replays with STRESS_REPLAY=<seed>.
//
//   fast (in-suite default, 150 iterations):
//     deno test -A --no-check --config deno.json stress_auth_logout_fuzz.test.ts
//   full campaign with a JSON results table:
//     STRESS_ITER=3000 STRESS_OUT=/tmp/logout_fuzz.json deno test -A --no-check --config deno.json stress_auth_logout_fuzz.test.ts
//   replay one or more seeds:
//     STRESS_REPLAY=123456789,987654321 deno test -A --no-check --config deno.json stress_auth_logout_fuzz.test.ts
//   promote the two KNOWN gaps from tagged rows to failures (see `knownGaps`):
//     STRESS_STRICT=1 ...
//   opt-in probe for a never-answering upstream logout (bounded by
//   STRESS_PROBE_HANG_MS, default 3000):
//     STRESS_PROBE_HANG=1 deno test -A --no-check --config deno.json stress_auth_logout_fuzz.test.ts --filter PROBE
//
// Invariants asserted on EVERY response (primary request and follow-up probe):
//   - status ∈ {204, 400, 401, 403, 404, 405, 413, 415, 429, 503} (200 for the
//     probe); never 500, never anything else;
//   - 503 only when THIS iteration injected an upstream fault, with the exact
//     generic body and no detail (no stack, no upstream text, no URL, no token);
//   - the response carries x-request-id: the client's value when it matched
//     [A-Za-z0-9._-]{8,64} after trim, otherwise a fresh UUID;
//   - error bodies are {error:{message}} JSON with the security headers; 204
//     has an empty body; nothing in the body echoes the query, body or header
//     canaries or the bearer;
//   - pre-verification rejections (bad bearer, 413, 429) make NO upstream call
//     at all; POST /auth/v1/logout is called exactly once iff the edge answered
//     204 or the Sign-out 503, with scope=local and the caller's exact bearer;
//     the route never touches PostgREST;
//   - after 204 the bearer's session is fenced (follow-up GET → 401, answered
//     locally); a session bearer WITHOUT session_id only loses its cache row
//     (follow-up re-verifies upstream); after a Sign-out 503 or a 404 the
//     session is NOT fenced (follow-up GET → 200 from the cache);
//   - 429 only for a client ip that other iterations shared (auth-failure or
//     per-ip budget), with Retry-After;
//   - server-side console output never contains the bearer.

import { assert, assertEquals } from "@std/assert";
import { captureAccessLog, clientIp } from "../http.ts";
import { loadHarness, SUPABASE_URL } from "./routesHarness.ts";
import type { Harness } from "./routesHarness.ts";

// ── Knobs ────────────────────────────────────────────────────────────────────

function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

const STRESS_ITER = envInt("STRESS_ITER", 150);
const STRESS_SEED = envInt("STRESS_SEED", 1592533542);
const STRESS_REPLAY = (Deno.env.get("STRESS_REPLAY") ?? "")
  .split(",")
  .map((part) => part.trim())
  .filter(Boolean)
  .map((part) => {
    const seed = Number(part);
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
      throw new Error(`STRESS_REPLAY seed out of range: ${part}`);
    }
    return seed;
  });
const STRESS_OUT = Deno.env.get("STRESS_OUT") ?? "";
const STRICT = Boolean(Deno.env.get("STRESS_STRICT"));
const PROBE_HANG = Boolean(Deno.env.get("STRESS_PROBE_HANG"));
const PROBE_HANG_MS = envInt("STRESS_PROBE_HANG_MS", 3000);

/** Short Auth deadline so the `hang` and `throw` faults resolve quickly. */
const AUTH_DEADLINE_MS = 300;
/** Any single edge answer slower than this is recorded as a violation. */
const LATENCY_BUDGET_MS = 2500;

const MAX_JSON_BODY_BYTES = 5_000_000;
const LOGOUT_UPSTREAM = `${SUPABASE_URL}/auth/v1/logout?scope=local`;
const ANON_KEY = "anon-test-key";
const ALLOWED_PRIMARY = new Set([204, 400, 401, 403, 404, 405, 413, 415, 429, 503]);
const ALLOWED_PROBE = new Set([200, 401, 429, 503]);
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GENERIC_503 = new Set([
  "Session verification is temporarily unavailable. Please try again.",
  "Sign-out is temporarily unavailable. Please try again.",
]);
const LEAK_MARKERS = [
  "    at ",
  "index.ts",
  "TypeError",
  "Error:",
  "stack",
  SUPABASE_URL,
  ANON_KEY,
  "supabase.test",
  "unexpected fetch",
  "upstream",
];

// ── Deterministic RNG ────────────────────────────────────────────────────────

function mix32(input: number): number {
  let x = input >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/** Seed of iteration `index` under campaign seed `base` (never 0). */
export function iterationSeed(base: number, index: number): number {
  const seed = mix32((mix32(base) + Math.imul(index + 1, 0x9e3779b9)) >>> 0);
  return seed === 0 ? 1 : seed;
}

class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  /** mulberry32 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }
  float(): number {
    return this.next() / 4294967296;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.float() * (max - min + 1));
  }
  chance(probability: number): boolean {
    return this.float() < probability;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }
  weighted<T>(table: ReadonlyArray<readonly [number, T]>): T {
    const total = table.reduce((sum, [weight]) => sum + weight, 0);
    let roll = this.float() * total;
    for (const [weight, value] of table) {
      roll -= weight;
      if (roll < 0) return value;
    }
    return table[table.length - 1][1];
  }
  string(alphabet: string, length: number): string {
    let out = "";
    for (let i = 0; i < length; i += 1) out += alphabet[this.int(0, alphabet.length - 1)];
    return out;
  }
  hex(length: number): string {
    return this.string("0123456789abcdef", length);
  }
  uuid(): string {
    const h = this.hex(32).split("");
    h[12] = "4";
    h[16] = "89ab"[this.int(0, 3)];
    const s = h.join("");
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  }
}

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const PRINTABLE = `${ALNUM} !"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~`;
/** Header-safe non-ASCII (ByteString range; Headers reject > 0xFF). */
const LATIN1_HIGH = "\u00a1\u00bf\u00c9\u00e9\u00f1\u00fc\u00ff\u0080\u009f";

// ── Token builders ───────────────────────────────────────────────────────────

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const JWT_HEADER = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));

function jwt(payload: unknown, rng: Rng): string {
  return `${JWT_HEADER}.${b64url(JSON.stringify(payload))}.${rng.hex(rng.int(8, 43))}`;
}

interface Bearer {
  kind: string;
  /** Full Authorization header value(s); null → header absent. */
  header: string[] | null;
  /** The token exactly as bearerOf() will see it ("" when there is none). */
  token: string;
  /** Pre-upstream verdict the edge must reach on its own (index.ts authenticate). */
  verdict: "reject" | "session" | "provider";
  /** Whether a successful verification is cached (ttl ≥ 60 s). */
  cacheable: boolean;
  sessionId: string | null;
  userId: string;
}

function buildBearer(rng: Rng): Bearer {
  const now = Math.floor(Date.now() / 1000);
  const userId = rng.uuid();
  const sessionId = `sess-${rng.hex(16)}`;
  const sessionIss = `${SUPABASE_URL}/auth/v1`;
  const base = (over: Record<string, unknown>) => ({
    iss: sessionIss,
    sub: userId,
    aud: "authenticated",
    role: "authenticated",
    session_id: sessionId,
    exp: now + 3600,
    iat: now,
    ...over,
  });
  const session = (
    kind: string,
    payload: unknown,
    extra: Partial<Bearer> = {},
    wrap: (token: string) => string = (t) => `Bearer ${t}`,
  ): Bearer => {
    const token = jwt(payload, rng);
    return {
      kind,
      header: [wrap(token)],
      token,
      verdict: "session",
      cacheable: true,
      sessionId,
      userId,
      ...extra,
    };
  };
  const reject = (kind: string, header: string[] | null, token = ""): Bearer => ({
    kind,
    header,
    token,
    verdict: "reject",
    cacheable: false,
    sessionId: null,
    userId,
  });
  const providerIss = rng.pick([
    ["google", "https://accounts.google.com"],
    ["google", "accounts.google.com"],
    ["apple", "https://appleid.apple.com"],
    ["apple", "appleid.apple.com"],
  ] as const);

  return rng.weighted<() => Bearer>([
    [30, () => session("session_ok", base({}))],
    [3, () => session("session_short_exp", base({ exp: now + 5 }), { cacheable: false })],
    [
      3,
      () => {
        const payload = base({});
        delete (payload as Record<string, unknown>).session_id;
        return session("session_no_session_id", payload, { sessionId: null });
      },
    ],
    [
      2,
      () =>
        session(
          "session_odd_session_id",
          base({ session_id: rng.pick([42, "", {}, [], null, true]) }),
          {
            sessionId: null,
          },
        ),
    ],
    [
      2,
      () =>
        session(
          "session_exp_nonnumber",
          base({ exp: rng.pick(["9999999999", null, true, {}, []]) }),
        ),
    ],
    [
      2,
      () =>
        session(
          "session_foreign_iss",
          base({ iss: rng.pick(["https://other.supabase.co/auth/v1", "/auth/v1", "x/auth/v1"]) }),
        ),
    ],
    [2, () => session("session_huge", base({ pad: rng.string(ALNUM, rng.int(16_000, 60_000)) }))],
    [
      2,
      () =>
        session("session_extra_ws", base({}), {}, (t) =>
          rng.pick([`Bearer   ${t}`, `Bearer ${t}   `, `Bearer ${t}\t`, `  Bearer ${t}`]),
        ),
    ],
    [2, () => session("session_huge_exp", base({ exp: rng.pick([1e300, 2 ** 53, 4102444800]) }))],
    [
      8,
      () => {
        const [provider, iss] = providerIss;
        const token = jwt(
          { iss, sub: userId, aud: "com.picklesensei", exp: now + 3600, iat: now },
          rng,
        );
        return {
          kind: `provider_${provider}`,
          header: [`Bearer ${token}`],
          token,
          verdict: "provider",
          cacheable: true,
          sessionId: null,
          userId,
        };
      },
    ],
    [
      5,
      () => {
        const token = jwt(base({ exp: rng.pick([now, now - 1, now - 86_400, 0, -5, 1]) }), rng);
        return reject("session_expired", [`Bearer ${token}`], token);
      },
    ],
    [
      2,
      () => {
        const [, iss] = providerIss;
        const token = jwt({ iss, sub: userId, exp: now - rng.int(0, 99_999) }, rng);
        return reject("provider_expired", [`Bearer ${token}`], token);
      },
    ],
    [6, () => reject("missing", null)],
    [3, () => reject("empty", [rng.pick(["Bearer", "Bearer ", "Bearer    ", "Bearer\t"])])],
    [
      4,
      () => {
        const token = jwt(base({}), rng);
        const header = rng.pick([
          `bearer ${token}`,
          `BEARER ${token}`,
          `Basic ${btoa("user:pass")}`,
          `Token ${token}`,
          `Bearer\t${token}`,
          `Bearer:${token}`,
          token,
        ]);
        return reject("wrong_scheme", [header]);
      },
    ],
    [
      5,
      () => {
        const token = rng.pick([
          rng.string(PRINTABLE.replace(/,/g, ""), rng.int(1, 64)),
          rng.string(ALNUM + LATIN1_HIGH, rng.int(1, 64)),
          rng.string(ALNUM, rng.int(20_000, 40_000)),
          "..",
          "a.b",
          "a.b.c.d",
          "...",
          ".",
          "=.=.=",
        ]);
        return reject("garbage", [`Bearer ${token}`], token);
      },
    ],
    [
      4,
      () => {
        const payload = rng.pick([
          "!!!",
          b64url("hello"),
          b64url("[1]"),
          b64url('"x"'),
          b64url("null"),
          b64url("123"),
          b64url("true"),
          "A",
          b64url("{"),
        ]);
        const token = `${JWT_HEADER}.${payload}.${rng.hex(8)}`;
        return reject("bad_payload", [`Bearer ${token}`], token);
      },
    ],
    [
      3,
      () => {
        const payload = rng.pick<Record<string, unknown>>([
          { sub: userId, exp: now + 3600 },
          { iss: null, sub: userId, exp: now + 3600 },
          { iss: 123, exp: now + 3600 },
          { iss: ["https://accounts.google.com"], exp: now + 3600 },
          { iss: {}, exp: now + 3600 },
          {},
        ]);
        const token = jwt(payload, rng);
        return reject("no_iss", [`Bearer ${token}`], token);
      },
    ],
    [
      4,
      () => {
        const iss = rng.pick([
          "https://evil.example",
          "https://accounts.google.com.evil",
          "accounts.google.com/",
          "http://accounts.google.com",
          "https://appleid.apple.com/auth/v1x",
          "auth/v1",
          `${SUPABASE_URL}/auth/v1/`,
          "",
          "https://ACCOUNTS.GOOGLE.COM",
          " accounts.google.com",
        ]);
        const token = jwt(base({ iss }), rng);
        return reject("iss_unknown", [`Bearer ${token}`], token);
      },
    ],
    [
      2,
      () => {
        const first = jwt(base({}), rng);
        const second = jwt(base({}), rng);
        return reject(
          "duplicate_header",
          [`Bearer ${first}`, `Bearer ${second}`],
          `${first}, Bearer ${second}`,
        );
      },
    ],
  ])();
}

// ── Upstream fault plans ─────────────────────────────────────────────────────

type UserFault =
  | "healthy"
  | "healthy_providers_list"
  | "refused_400"
  | "refused_401"
  | "refused_403"
  | "status_404"
  | "status_429"
  | "status_500"
  | "status_502"
  | "status_503"
  | "throw"
  | "hang"
  | "ok_nonjson"
  | "ok_no_id"
  | "ok_provider_email"
  | "ok_no_app_metadata"
  | "status_500_echo_auth";

type LogoutFault =
  | "status_204"
  | "status_200"
  | "status_401"
  | "status_403"
  | "status_404"
  | "status_400"
  | "status_405"
  | "status_408"
  | "status_422"
  | "status_429"
  | "status_500"
  | "status_502"
  | "status_503"
  | "status_504"
  | "throw"
  | "slow_204";

type TokenFault = "healthy" | "status_400" | "status_401" | "status_500" | "throw";

interface FaultPlan {
  user: UserFault;
  logout: LogoutFault;
  token: TokenFault;
}

function buildFaults(rng: Rng): FaultPlan {
  const user = rng.weighted<UserFault>([
    [60, "healthy"],
    [3, "healthy_providers_list"],
    [3, "refused_400"],
    [6, "refused_401"],
    [5, "refused_403"],
    [2, "status_404"],
    [3, "status_429"],
    [3, "status_500"],
    [3, "status_502"],
    [2, "status_503"],
    [3, "throw"],
    [1, "hang"],
    [2, "ok_nonjson"],
    [2, "ok_no_id"],
    [2, "ok_provider_email"],
    [1, "ok_no_app_metadata"],
    [1, "status_500_echo_auth"],
  ]);
  const logout = rng.weighted<LogoutFault>([
    [50, "status_204"],
    [8, "status_200"],
    [6, "status_401"],
    [5, "status_403"],
    [5, "status_404"],
    [3, "status_400"],
    [1, "status_405"],
    [1, "status_408"],
    [1, "status_422"],
    [3, "status_429"],
    [4, "status_500"],
    [4, "status_502"],
    [3, "status_503"],
    [1, "status_504"],
    [3, "throw"],
    [2, "slow_204"],
  ]);
  const token = rng.weighted<TokenFault>([
    [75, "healthy"],
    [10, "status_400"],
    [4, "status_401"],
    [7, "status_500"],
    [4, "throw"],
  ]);
  return { user, logout, token };
}

const statusOf = (fault: string): number => Number(fault.split("_")[1]);

// ── Request shape ────────────────────────────────────────────────────────────

interface Scenario {
  seed: number;
  method: string;
  pathKind: string;
  url: string;
  /** Whether the router normalizes this path to /v1/auth/logout. */
  routeHits: boolean;
  bearer: Bearer;
  requestIdKind: string;
  requestId: string | null;
  ipKind: string;
  /** clientIp() of the built request; `sharedIp` when other iterations may use it. */
  resolvedIp: string;
  sharedIp: boolean;
  bodyKind: string;
  body: string | Uint8Array | null;
  contentType: string | null;
  contentLength: string | null;
  declaredTooLarge: boolean;
  headers: Array<[string, string]>;
  faults: FaultPlan;
  canaries: string[];
}

const SHARED_IPS = ["203.0.113.7", "203.0.113.8", "203.0.113.9"];

const PATH_SHAPES: ReadonlyArray<readonly [number, string, (rng: Rng) => string]> = [
  [30, "gateway", () => "/functions/v1/api/v1/auth/logout"],
  [8, "stripped", () => "/api/v1/auth/logout"],
  [8, "bare", () => "/v1/auth/logout"],
  [2, "double_v1", () => "/x/v1/y/v1/auth/logout"],
  [2, "dot_segment", () => "/functions/v1/api/v1/auth/nope/../logout"],
  [2, "backslash", () => "/functions/v1/api/v1/auth\\logout"],
  [3, "trailing_slash", () => "/functions/v1/api/v1/auth/logout/"],
  [2, "double_slash", () => "/functions/v1/api/v1/auth//logout"],
  [2, "case", () => "/functions/v1/api/v1/Auth/Logout"],
  [2, "pct_encoded", () => "/functions/v1/api/v1/auth/%6Cogout"],
  [2, "pct_space", () => "/functions/v1/api/v1/auth/logout%20"],
  [2, "truncated", () => "/functions/v1/api/v1/auth/logou"],
  [2, "suffix", () => "/functions/v1/api/v1/auth/logoutx"],
  [1, "param", () => "/functions/v1/api/v1/auth/logout;jsessionid=1"],
  [1, "v2", () => "/functions/v1/api/v2/auth/logout"],
  [1, "no_v1", () => "/auth/logout"],
  [1, "unicode", () => "/functions/v1/api/v1/auth/logout\u00e9"],
  [1, "null_byte", () => "/functions/v1/api/v1/auth/logout%00"],
  [
    2,
    "long_tail",
    (rng) => `/functions/v1/api/v1/auth/logout/${rng.string(ALNUM, rng.int(1000, 8000))}`,
  ],
  [
    2,
    "random_tail",
    (rng) =>
      `/functions/v1/api/v1/auth/logout${rng.string(PRINTABLE.replace(/[#?\\]/g, ""), rng.int(1, 12))}`,
  ],
  [1, "root", () => "/"],
  [1, "empty_v1", () => "/v1/"],
];

function lastV1Route(pathname: string): string {
  const v1 = pathname.lastIndexOf("/v1/");
  return v1 >= 0 ? pathname.slice(v1) : pathname;
}

function buildScenario(seed: number): Scenario {
  const rng = new Rng(seed);
  const canaries: string[] = [];
  const canary = (tag: string): string => {
    const value = `cnry${tag}${seed.toString(36)}${rng.hex(6)}`;
    canaries.push(value);
    return value;
  };

  const method = rng.weighted([
    [82, "POST"],
    [4, "GET"],
    [3, "PUT"],
    [3, "DELETE"],
    [3, "PATCH"],
    [2, "HEAD"],
    [2, "OPTIONS"],
    [1, "PURGE"],
  ]);

  const [, pathKind, pathOf] = rng.weighted(PATH_SHAPES.map((row) => [row[0], row] as const));
  const query = rng.weighted<() => string>([
    [50, () => ""],
    [10, () => "?scope=global"],
    [10, () => `?q=${canary("q")}&x=${rng.string(ALNUM, rng.int(0, 20))}`],
    [8, () => `?${rng.string(PRINTABLE.replace(/[#\\]/g, ""), rng.int(1, 200))}`],
    [5, () => `?${rng.string(ALNUM, rng.int(4000, 8000))}`],
    [5, () => "?%00"],
    [5, () => "?a=1&a=2&a[]=3"],
    [4, () => `?${canary("q")}`],
    [3, () => "?"],
  ])();
  const fragment = rng.chance(0.05) ? "#frag" : "";
  const url = new URL(`http://edge.test${pathOf(rng)}${query}${fragment}`);
  const routeHits = lastV1Route(url.pathname) === "/v1/auth/logout";

  const bearer = buildBearer(rng);

  const [requestIdKind, requestId] = rng.weighted<() => [string, string | null]>([
    [35, () => ["absent", null]],
    [35, () => ["valid", rng.string(`${ALNUM}._-`, rng.int(8, 64))]],
    [5, () => ["short", rng.string(ALNUM, rng.int(1, 7))]],
    [5, () => ["long", rng.string(ALNUM, rng.int(65, 300))]],
    [
      8,
      () => [
        "invalid_chars",
        rng.pick([
          `bad id ${rng.hex(8)}`,
          `../../${rng.hex(8)}`,
          `${rng.hex(8)}\u00e9`,
          `${rng.hex(4)}<script>`,
          `${rng.hex(8)}\u000b`,
          `${rng.hex(8)},${rng.hex(8)}`,
        ]),
      ],
    ],
    [5, () => ["padded_valid", `  ${rng.string(ALNUM, rng.int(8, 40))}\t `]],
    [4, () => ["empty", ""]],
    [3, () => ["uuid", rng.uuid()]],
  ])();

  const uniqueIp = `10.${rng.int(0, 255)}.${rng.int(0, 255)}.${rng.int(1, 254)}`;
  const ipHeaders: Array<[string, string]> = [];
  const ipKind = rng.weighted<() => string>([
    [
      62,
      () => {
        ipHeaders.push(["x-forwarded-for", uniqueIp]);
        return "xff_unique";
      },
    ],
    [
      8,
      () => {
        ipHeaders.push(["x-forwarded-for", `1.2.3.4, 5.6.7.8 , ${uniqueIp}`]);
        return "xff_chain";
      },
    ],
    [
      6,
      () => {
        ipHeaders.push(["cf-connecting-ip", ` ${uniqueIp} `]);
        ipHeaders.push([
          "x-forwarded-for",
          rng.string(PRINTABLE.replace(/,/g, ""), rng.int(0, 40)),
        ]);
        return "cf_unique";
      },
    ],
    [
      12,
      () => {
        ipHeaders.push(["x-forwarded-for", rng.pick(SHARED_IPS)]);
        return "shared_pool";
      },
    ],
    [
      5,
      () => {
        ipHeaders.push(["x-forwarded-for", rng.pick(["", " , , ", ",", "   ", ",,,,"])]);
        return "xff_garbage";
      },
    ],
    [
      2,
      () => {
        ipHeaders.push([
          "x-forwarded-for",
          `${"a,".repeat(rng.int(500, 2000))}${rng.pick(["", "a", " "])}`,
        ]);
        return "xff_huge";
      },
    ],
    [3, () => "absent"],
    [
      2,
      () => {
        ipHeaders.push(["x-forwarded-for", `2001:db8::${rng.hex(4)}:${rng.hex(4)}`]);
        return "xff_ipv6";
      },
    ],
  ])();

  const faults = buildFaults(rng);

  const bodyAllowed = method !== "GET" && method !== "HEAD";
  let body: string | Uint8Array | null = null;
  let contentType: string | null = null;
  let contentLength: string | null = null;
  let declaredTooLarge = false;
  const bodyKind = !bodyAllowed
    ? "none"
    : rng.weighted<() => string>([
        [40, () => "none"],
        [
          5,
          () => {
            body = "";
            return "empty_string";
          },
        ],
        [
          10,
          () => {
            body = "{}";
            contentType = "application/json";
            return "empty_object";
          },
        ],
        [
          15,
          () => {
            body = JSON.stringify({
              scope: rng.pick(["local", "global", "others", 1, null]),
              canary: canary("b"),
              nested: { deep: [1, 2, { x: rng.string(ALNUM, 12) }] },
            });
            contentType = "application/json";
            return "json_object";
          },
        ],
        [
          10,
          () => {
            body = rng.pick([
              `{"a":`,
              "[",
              "nope",
              `{"canary":"${canary("b")}"`,
              "\u0000\u0001",
              "{}{}",
            ]);
            contentType = rng.pick(["application/json", "text/plain", null]);
            return "invalid_json";
          },
        ],
        [
          5,
          () => {
            const bytes = new Uint8Array(rng.int(1, 16_384));
            for (let i = 0; i < bytes.length; i += 1) bytes[i] = rng.int(0, 255);
            body = bytes;
            contentType = "application/octet-stream";
            return "random_bytes";
          },
        ],
        [
          3,
          () => {
            body = JSON.stringify({
              pad: rng.string(ALNUM, rng.int(50_000, 70_000)),
              canary: canary("b"),
            });
            contentType = "application/json";
            return "large_json";
          },
        ],
        [
          4,
          () => {
            body = "{}";
            contentLength = rng.pick(["5000001", "1e7", "99999999999999999999", "6000000.5"]);
            declaredTooLarge = true;
            return "declared_too_large";
          },
        ],
        [
          4,
          () => {
            body = "{}";
            contentLength = rng.pick(["abc", "-1", "", "5000000", "Infinity", "NaN", "0x10"]);
            return "declared_odd";
          },
        ],
        [
          4,
          () => {
            body = `scope=${canary("b")}`;
            contentType = rng.pick([
              "application/x-www-form-urlencoded",
              "multipart/form-data; boundary=x",
              "application/json; charset=utf-16",
              "",
              "text/html",
            ]);
            return "odd_content_type";
          },
        ],
      ])();

  const headers: Array<[string, string]> = [...ipHeaders];
  if (requestId !== null) headers.push(["x-request-id", requestId]);
  if (bearer.header) for (const value of bearer.header) headers.push(["authorization", value]);
  if (contentType !== null) headers.push(["content-type", contentType]);
  if (contentLength !== null) headers.push(["content-length", contentLength]);
  if (rng.chance(0.3))
    headers.push(["accept", rng.pick(["application/json", "*/*", "text/html", ""])]);
  if (rng.chance(0.2)) headers.push([`x-fuzz-${rng.hex(4)}`, canary("h")]);
  if (rng.chance(0.1)) headers.push(["x-fuzz-huge", rng.string(ALNUM, rng.int(8000, 16_000))]);
  if (rng.chance(0.1)) headers.push(["origin", rng.pick(["https://evil.example", "null", ""])]);
  if (rng.chance(0.05)) headers.push(["cookie", `sb=${canary("c")}`]);

  const probeRequest = new Request(url, { method: "GET", headers: ipHeaders });
  const resolvedIp = clientIp(probeRequest);

  return {
    seed,
    method,
    pathKind,
    url: url.toString(),
    routeHits,
    bearer,
    requestIdKind,
    requestId,
    ipKind,
    resolvedIp,
    sharedIp: resolvedIp !== uniqueIp,
    bodyKind,
    body,
    contentType,
    contentLength,
    declaredTooLarge,
    headers,
    faults,
    canaries,
  };
}

function buildRequest(scenario: Scenario): Request {
  const headers = new Headers();
  for (const [name, value] of scenario.headers) headers.append(name, value);
  const init: RequestInit = { method: scenario.method, headers };
  if (scenario.body !== null) init.body = scenario.body as BodyInit;
  return new Request(scenario.url, init);
}

// ── Upstream stub (in front of routesHarness' fetch) ─────────────────────────

interface UpstreamCall {
  url: string;
  method: string;
  authorization: string | null;
  apikey: string | null;
}

interface Upstream {
  calls: UpstreamCall[];
  plan: FaultPlan;
  /** Sessions the stubbed GoTrue has revoked: /user refuses their bearers. */
  revokedSessions: Set<string>;
  install(): () => void;
}

const jsonResponse = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

function payloadOf(token: string): Record<string, unknown> | null {
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  try {
    const raw = segments[1].replace(/-/g, "+").replace(/_/g, "/");
    const parsed = JSON.parse(atob(raw));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function abortable(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_, reject) => {
    const abort = () => reject(new DOMException("The signal has been aborted", "AbortError"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeUpstream(): Upstream {
  const upstream: Upstream = {
    calls: [],
    plan: { user: "healthy", logout: "status_204", token: "healthy" },
    revokedSessions: new Set(),
    install() {
      const base = globalThis.fetch;
      globalThis.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        const request = new Request(input, init);
        const authorization = request.headers.get("authorization");
        upstream.calls.push({
          url: request.url,
          method: request.method,
          authorization,
          apikey: request.headers.get("apikey"),
        });
        const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
        const url = request.url;

        if (url === `${SUPABASE_URL}/auth/v1/user`) {
          const payload = payloadOf(bearer);
          const sessionId = typeof payload?.session_id === "string" ? payload.session_id : null;
          if (sessionId && upstream.revokedSessions.has(sessionId)) {
            return jsonResponse(403, {
              error_code: "session_not_found",
              msg: "Session from session_id claim in JWT does not exist",
            });
          }
          const userId = typeof payload?.sub === "string" && payload.sub ? payload.sub : "no-sub";
          const provider =
            payload && typeof payload.iat === "number" && payload.iat % 2 === 0
              ? "google"
              : "apple";
          const user = {
            id: userId,
            aud: "authenticated",
            role: "authenticated",
            email: "user@example.com",
            app_metadata: { provider, providers: [provider] },
            user_metadata: {},
            created_at: new Date().toISOString(),
          };
          switch (upstream.plan.user) {
            case "healthy":
              return jsonResponse(200, user);
            case "healthy_providers_list":
              return jsonResponse(200, { ...user, app_metadata: { providers: [provider] } });
            case "refused_400":
              return jsonResponse(400, {
                error_code: "bad_jwt",
                msg: "invalid JWT: unable to parse or verify signature",
              });
            case "refused_401":
              return jsonResponse(401, {
                error_code: "bad_jwt",
                msg: "invalid JWT: token is expired",
              });
            case "refused_403":
              return jsonResponse(403, {
                error_code: "session_not_found",
                msg: "Session from session_id claim in JWT does not exist",
              });
            case "status_404":
              return new Response("not found", { status: 404 });
            case "status_429":
              return jsonResponse(
                429,
                { error_code: "over_request_rate_limit", msg: "slow down" },
                {
                  "Retry-After": ["5", "0", "abc", "1e3", "99999999999", ""][
                    upstream.calls.length % 6
                  ],
                },
              );
            case "status_500":
              return jsonResponse(500, { code: 500, msg: "internal error" });
            case "status_502":
              return new Response("<html>bad gateway</html>", { status: 502 });
            case "status_503":
              return new Response("", { status: 503 });
            case "throw":
              throw new TypeError("error sending request: connection reset");
            case "hang":
              return abortable(request.signal);
            case "ok_nonjson":
              return new Response("<html>ok</html>", { status: 200 });
            case "ok_no_id":
              return jsonResponse(
                200,
                [{}, { id: 5 }, [], null, "str", { id: "" }][upstream.calls.length % 6],
              );
            case "ok_provider_email":
              return jsonResponse(200, {
                ...user,
                app_metadata: { provider: "email", providers: ["email"] },
              });
            case "ok_no_app_metadata":
              return jsonResponse(200, { id: userId, email: "user@example.com" });
            case "status_500_echo_auth":
              return jsonResponse(500, { code: "internal", msg: `unexpected: ${authorization}` });
          }
        }

        if (url === LOGOUT_UPSTREAM) {
          const payload = payloadOf(bearer);
          const sessionId = typeof payload?.session_id === "string" ? payload.session_id : null;
          const revoke = () => {
            if (sessionId) upstream.revokedSessions.add(sessionId);
          };
          switch (upstream.plan.logout) {
            case "status_204":
              revoke();
              return new Response(null, { status: 204 });
            case "status_200":
              revoke();
              return jsonResponse(200, {});
            case "slow_204":
              await sleep(50);
              revoke();
              return new Response(null, { status: 204 });
            case "throw":
              throw new TypeError("error sending request: connection refused");
            default: {
              const status = statusOf(upstream.plan.logout);
              // 401/403/404: GoTrue no longer knows the session — it IS gone.
              if (status === 401 || status === 403 || status === 404) revoke();
              return jsonResponse(status, { code: status, msg: `gotrue says ${status}` });
            }
          }
        }

        if (url.startsWith(`${SUPABASE_URL}/auth/v1/token`)) {
          switch (upstream.plan.token) {
            case "healthy":
              return base(request);
            case "throw":
              throw new TypeError("error sending request: connection refused");
            default: {
              const status = statusOf(upstream.plan.token);
              return jsonResponse(status, {
                error: "invalid_grant",
                error_description: `token endpoint ${status}`,
              });
            }
          }
        }

        return base(request);
      }) as typeof fetch;
      return () => {
        globalThis.fetch = base;
      };
    },
  };
  return upstream;
}

// ── Oracle ───────────────────────────────────────────────────────────────────

interface Expectation {
  /** Statuses the edge may answer with for this scenario (429 added when shared ip). */
  statuses: number[];
  /** Whether a 503 is legitimate for this scenario (an upstream fault was injected). */
  faultInjected: boolean;
  /** Whether the edge is expected to have accepted the bearer before routing. */
  authPasses: boolean;
  /** Whether upstream logout should have been called once. */
  logoutCalled: boolean;
  /** Follow-up probe: `fenced` (401, answered locally), `served` (200),
   * `evicted` (the bearer's cache row is gone — re-verified upstream, verdict
   * upstream's), or skipped. */
  probe: "fenced" | "served" | "evicted" | "skip";
  /** Tagged rather than failed unless STRESS_STRICT: upstream 4xx ∉ {401,403,404} → 204. */
  contractGap: boolean;
}

function expect(scenario: Scenario): Expectation {
  const none: Expectation = {
    statuses: [],
    faultInjected: false,
    authPasses: false,
    logoutCalled: false,
    probe: "skip",
    contractGap: false,
  };
  if (scenario.declaredTooLarge) return { ...none, statuses: [413] };

  const { bearer, faults } = scenario;
  if (bearer.verdict === "reject") return { ...none, statuses: [401] };

  if (bearer.verdict === "session") {
    switch (faults.user) {
      case "refused_400":
      case "refused_401":
      case "refused_403":
      case "ok_provider_email":
      case "ok_no_app_metadata":
        return { ...none, statuses: [401] };
      case "healthy":
      case "healthy_providers_list":
        break;
      default:
        return { ...none, statuses: [503], faultInjected: true };
    }
  } else if (faults.token !== "healthy") {
    // supabase-js folds every /token failure into `error` → 401 (transitional
    // provider-token path; see authenticate()). Recorded as a fault so a 503
    // here would also be legitimate.
    return { ...none, statuses: [401, 503], faultInjected: true };
  }

  const hits = scenario.routeHits && scenario.method === "POST";
  if (!hits) {
    return { ...none, statuses: [404], authPasses: true, probe: "served" };
  }
  switch (faults.logout) {
    case "status_204":
    case "status_200":
    case "slow_204":
    case "status_401":
    case "status_403":
    case "status_404":
      return {
        ...none,
        statuses: [204],
        authPasses: true,
        logoutCalled: true,
        probe: bearer.verdict === "session" ? (bearer.sessionId ? "fenced" : "evicted") : "served",
      };
    case "status_400":
    case "status_405":
    case "status_408":
    case "status_422":
    case "status_429":
      return {
        ...none,
        statuses: STRICT ? [503] : [204, 503],
        authPasses: true,
        logoutCalled: true,
        probe: "skip",
        contractGap: true,
      };
    default:
      return {
        ...none,
        statuses: [503],
        faultInjected: true,
        authPasses: true,
        logoutCalled: true,
        probe: "served",
      };
  }
}

// ── One iteration ────────────────────────────────────────────────────────────

interface Outcome {
  seed: number;
  method: string;
  pathKind: string;
  routeHits: boolean;
  bearerKind: string;
  requestIdKind: string;
  ipKind: string;
  sharedIp: boolean;
  bodyKind: string;
  faults: FaultPlan;
  expected: number[];
  status: number;
  requestId: string | null;
  latencyMs: number;
  upstream: { user: number; logout: number; token: number; rest: number };
  probeStatus: number | null;
  probeUserCalls: number | null;
  contractGap: boolean;
  /** Known, tagged gaps (failures only under STRESS_STRICT). */
  knownGaps: string[];
  violations: string[];
}

interface Campaign {
  harness: Harness;
  upstream: Upstream;
  logs: string[];
}

function bodyLeaks(text: string, scenario: Scenario): string[] {
  const found: string[] = [];
  for (const marker of LEAK_MARKERS)
    if (text.includes(marker)) found.push(`body contains ${JSON.stringify(marker)}`);
  for (const canary of scenario.canaries)
    if (text.includes(canary)) found.push(`body echoes canary ${canary}`);
  if (scenario.bearer.token.length >= 8 && text.includes(scenario.bearer.token.slice(0, 64))) {
    found.push("body echoes the bearer");
  }
  return found;
}

async function checkResponse(
  response: Response,
  scenario: Scenario,
  allowed: Set<number>,
  faultInjected: boolean,
  who: string,
): Promise<{ text: string; violations: string[] }> {
  const violations: string[] = [];
  const text = await response.text();
  const push = (message: string) => violations.push(`${who}: ${message}`);

  if (!allowed.has(response.status)) push(`status ${response.status} not in allowlist`);
  if (response.status >= 500 && !faultInjected)
    push(`${response.status} without an injected fault`);

  const requestId = response.headers.get("x-request-id");
  if (!requestId) push("missing x-request-id");
  else if (who === "primary") {
    const incoming = (scenario.requestId ?? "").trim();
    if (REQUEST_ID_RE.test(incoming)) {
      if (requestId !== incoming) push(`request id not echoed (${JSON.stringify(requestId)})`);
    } else if (!UUID_RE.test(requestId)) {
      push(`request id neither echoed nor uuid (${JSON.stringify(requestId)})`);
    }
  }

  if (response.status === 204) {
    if (text !== "") push("204 with a body");
  } else {
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json"))
      push(`non-JSON content-type ${JSON.stringify(contentType)}`);
    if (response.headers.get("x-content-type-options") !== "nosniff") push("missing nosniff");
    if (response.headers.get("cache-control") !== "no-store") push("missing no-store");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      push("body is not JSON");
    }
    if (response.status >= 400) {
      const error = (parsed as { error?: { message?: unknown; code?: unknown } } | undefined)
        ?.error;
      if (!error || typeof error.message !== "string" || !error.message)
        push("error body lacks error.message");
      if (error && error.code !== undefined && typeof error.code !== "string")
        push("error.code not a string");
      if (response.status >= 500) {
        if (!error || !GENERIC_503.has(String(error.message)))
          push(`5xx body not generic: ${text.slice(0, 120)}`);
        if (error && Object.keys(error).length !== 1) push("5xx body carries extra fields");
      }
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after"));
        if (!Number.isInteger(retryAfter) || retryAfter < 1)
          push("429 without integer Retry-After");
      }
    }
    for (const leak of bodyLeaks(text, scenario)) push(leak);
  }
  return { text, violations };
}

async function runIteration(campaign: Campaign, seed: number): Promise<Outcome> {
  const scenario = buildScenario(seed);
  const expectation = expect(scenario);
  const { harness, upstream } = campaign;
  upstream.plan = scenario.faults;
  const callsBefore = upstream.calls.length;
  const harnessCallsBefore = harness.calls.length;

  const startedAt = performance.now();
  const response = await harness.handler(buildRequest(scenario));
  const latencyMs = Math.round(performance.now() - startedAt);

  const { violations } = await checkResponse(
    response,
    scenario,
    ALLOWED_PRIMARY,
    expectation.faultInjected,
    "primary",
  );
  const push = (message: string) => violations.push(`primary: ${message}`);

  const calls = upstream.calls.slice(callsBefore);
  const count = (fragment: string) => calls.filter((call) => call.url.includes(fragment)).length;
  const counts = {
    user: count("/auth/v1/user"),
    logout: calls.filter((call) => call.url === LOGOUT_UPSTREAM).length,
    token: count("/auth/v1/token"),
    rest:
      count("/rest/v1/") +
      harness.calls.slice(harnessCallsBefore).filter((c) => c.url.includes("/rest/v1/")).length,
  };
  const status = response.status;
  const rateLimited = status === 429;

  if (rateLimited) {
    if (!scenario.sharedIp) push("429 for an ip no other iteration shares");
    if (calls.length !== 0) push(`429 after ${calls.length} upstream call(s)`);
  } else {
    if (!expectation.statuses.includes(status)) {
      push(`status ${status}, oracle expected ${expectation.statuses.join("|")}`);
    }
    if (status === 204 && expectation.contractGap && STRICT) {
      push("contract gap: upstream 4xx outside {401,403,404} reported as 204 and fenced");
    }
  }
  if (latencyMs > LATENCY_BUDGET_MS) push(`latency ${latencyMs}ms over budget`);
  if (counts.rest !== 0) push(`${counts.rest} PostgREST call(s) on the logout route`);

  const preVerification =
    scenario.declaredTooLarge || scenario.bearer.verdict === "reject" || rateLimited;
  if (preVerification && calls.length !== 0) {
    push(`${calls.length} upstream call(s) on a pre-verification rejection`);
  }
  if (!rateLimited && !preVerification) {
    if (scenario.bearer.verdict === "session") {
      const cap = scenario.faults.user === "throw" ? 3 : 1;
      if (counts.user < 1 || counts.user > cap)
        push(`${counts.user} getUser call(s), expected 1..${cap}`);
      if (counts.token !== 0) push(`${counts.token} token call(s) for a session bearer`);
      for (const call of calls.filter((c) => c.url.includes("/auth/v1/user"))) {
        if (call.authorization !== `Bearer ${scenario.bearer.token}`)
          push("getUser carried a different bearer");
      }
    } else {
      if (counts.user !== 0) push(`${counts.user} getUser call(s) for a provider bearer`);
      if (counts.token < 1) push("provider bearer without a token exchange");
    }
  }
  const logoutExpected =
    !rateLimited && (status === 204 || (status === 503 && expectation.logoutCalled));
  if (counts.logout !== (logoutExpected ? 1 : 0)) {
    push(
      `${counts.logout} upstream logout call(s), expected ${logoutExpected ? 1 : 0} for status ${status}`,
    );
  }
  for (const call of calls.filter((c) => c.url === LOGOUT_UPSTREAM)) {
    if (call.method !== "POST") push(`upstream logout method ${call.method}`);
    if (call.authorization !== `Bearer ${scenario.bearer.token}`)
      push("upstream logout carried a different bearer");
    if (call.apikey !== ANON_KEY) push("upstream logout without the anon apikey");
  }

  // ── Follow-up probe: is the session fenced (after 204) or intact (otherwise)?
  let probeStatus: number | null = null;
  let probeUserCalls: number | null = null;
  const probeKind = rateLimited
    ? "skip"
    : status === 204
      ? expectation.probe
      : expectation.probe === "fenced" || expectation.probe === "evicted"
        ? "skip"
        : expectation.probe;
  if (probeKind !== "skip" && expectation.authPasses) {
    upstream.plan = { user: "healthy", logout: "status_204", token: "healthy" };
    const headers = new Headers();
    for (const [name, value] of scenario.headers) {
      if (name === "authorization" || name === "x-forwarded-for" || name === "cf-connecting-ip")
        headers.append(name, value);
    }
    const before = upstream.calls.length;
    const probe = await harness.handler(
      new Request("http://edge.test/functions/v1/api/v1/me/saved-drills", {
        method: "GET",
        headers,
      }),
    );
    probeStatus = probe.status;
    probeUserCalls = upstream.calls
      .slice(before)
      .filter((c) => c.url.includes("/auth/v1/user")).length;
    const checked = await checkResponse(probe, scenario, ALLOWED_PROBE, false, "probe");
    violations.push(...checked.violations);
    if (probe.status === 429) {
      if (!scenario.sharedIp) violations.push("probe: 429 for an ip no other iteration shares");
    } else if (probeKind === "fenced") {
      if (probe.status !== 401)
        violations.push(`probe: bearer still served (${probe.status}) after 204`);
    } else if (probeKind === "evicted") {
      if (probe.status !== 200 && probe.status !== 401)
        violations.push(`probe: ${probe.status} after 204 without session_id`);
      if (probeUserCalls !== 1)
        violations.push(`probe: cache row survived logout (${probeUserCalls} re-verifications)`);
    } else if (probe.status !== 200) {
      violations.push(`probe: session not intact (${probe.status}) after ${status}`);
    } else if (
      scenario.bearer.verdict === "session" &&
      scenario.bearer.cacheable &&
      probeUserCalls !== 0
    ) {
      violations.push(
        `probe: re-verified upstream (${probeUserCalls}) despite a cacheable verification`,
      );
    }
  }

  return {
    seed,
    method: scenario.method,
    pathKind: scenario.pathKind,
    routeHits: scenario.routeHits,
    bearerKind: scenario.bearer.kind,
    requestIdKind: scenario.requestIdKind,
    ipKind: scenario.ipKind,
    sharedIp: scenario.sharedIp,
    bodyKind: scenario.bodyKind,
    faults: scenario.faults,
    expected: expectation.statuses,
    status,
    requestId: response.headers.get("x-request-id"),
    latencyMs,
    upstream: counts,
    probeStatus,
    probeUserCalls,
    contractGap: expectation.contractGap && status === 204,
    knownGaps:
      expectation.contractGap && status === 204
        ? ["contract gap: upstream 4xx outside {401,403,404} reported as 204 and fenced"]
        : [],
    violations,
  };
}

/** A window of the bearer that is unique to it (past the shared JWT header
 * and issuer prefix) and short enough to survive the 200-char detail cap. */
function bearerNeedle(token: string): string | null {
  if (token.length < 16) return null;
  // header (37) + `{"iss":"…/auth/v1","sub":"` (≈60 base64 chars) → the sub
  // claim, unique per token, sits around offsets 97–145.
  if (token.length >= 150) return token.slice(100, 140);
  return token.slice(-Math.min(40, token.length));
}

// ── Campaign plumbing ────────────────────────────────────────────────────────

async function withCampaign<T>(run: (campaign: Campaign) => Promise<T>): Promise<T> {
  const harness = await loadHarness();
  const upstream = makeUpstream();
  const restoreFetch = upstream.install();
  const logs: string[] = [];
  const restoreAccessLog = captureAccessLog((line) => logs.push(line));
  const realError = console.error;
  const realWarn = console.warn;
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  const previousTimeout = Deno.env.get("AUTH_UPSTREAM_TIMEOUT_MS");
  Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", String(AUTH_DEADLINE_MS));
  try {
    return await run({ harness, upstream, logs });
  } finally {
    if (previousTimeout === undefined) Deno.env.delete("AUTH_UPSTREAM_TIMEOUT_MS");
    else Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", previousTimeout);
    console.error = realError;
    console.warn = realWarn;
    restoreAccessLog();
    restoreFetch();
  }
}

function tally<T extends string | number>(values: Iterable<T>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[String(value)] = (out[String(value)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

Deno.test("stress: seeded fuzz/boundary campaign against POST /v1/auth/logout", async () => {
  const seeds =
    STRESS_REPLAY.length > 0
      ? STRESS_REPLAY
      : Array.from({ length: STRESS_ITER }, (_, i) => iterationSeed(STRESS_SEED, i));
  const startedAt = Date.now();

  const outcomes = await withCampaign(async (campaign) => {
    const rows: Outcome[] = [];
    for (const seed of seeds) rows.push(await runIteration(campaign, seed));
    // Server-side output (access log + console.error/warn) must never carry a bearer.
    for (const row of rows) {
      const needle = bearerNeedle(buildScenario(row.seed).bearer.token);
      if (needle === null || !campaign.logs.some((line) => line.includes(needle))) continue;
      const message = "logs: server-side output contains the bearer";
      // Known gap: serviceUnavailable() logs upstream error text verbatim
      // (≤200 chars), so an upstream that echoes the Authorization header
      // puts the bearer in the function log.
      if (row.faults.user === "status_500_echo_auth" && row.status === 503 && !STRICT)
        row.knownGaps.push(message);
      else row.violations.push(message);
    }
    return rows;
  });

  const failing = outcomes.filter((row) => row.violations.length > 0);
  const summary = {
    campaignSeed: STRESS_SEED,
    replay: STRESS_REPLAY,
    strict: STRICT,
    iterationsPlanned: seeds.length,
    iterationsExecuted: outcomes.length,
    probesExecuted: outcomes.filter((row) => row.probeStatus !== null).length,
    durationMs: Date.now() - startedAt,
    held: outcomes.length - failing.length,
    broken: failing.length,
    byStatus: tally(outcomes.map((row) => row.status)),
    byBearerKind: tally(outcomes.map((row) => row.bearerKind)),
    byPathKind: tally(outcomes.map((row) => row.pathKind)),
    byMethod: tally(outcomes.map((row) => row.method)),
    byBodyKind: tally(outcomes.map((row) => row.bodyKind)),
    byProbeStatus: tally(
      outcomes.filter((r) => r.probeStatus !== null).map((r) => r.probeStatus as number),
    ),
    fiveXx: outcomes
      .filter((row) => row.status >= 500)
      .map((row) => ({ seed: row.seed, status: row.status, faults: row.faults })),
    contractGapSeeds: outcomes.filter((row) => row.contractGap).map((row) => row.seed),
    knownGapSeeds: outcomes
      .filter((row) => row.knownGaps.length > 0)
      .map((row) => ({ seed: row.seed, gaps: row.knownGaps })),
    fencedAfter204: outcomes.filter((row) => row.status === 204 && row.probeStatus === 401).length,
    fencedLocally: outcomes.filter(
      (row) => row.status === 204 && row.probeStatus === 401 && row.probeUserCalls === 0,
    ).length,
    maxLatencyMs: Math.max(0, ...outcomes.map((row) => row.latencyMs)),
    failingSeeds: failing.map((row) => ({ seed: row.seed, violations: row.violations })),
  };

  if (STRESS_OUT) {
    await Deno.writeTextFile(STRESS_OUT, JSON.stringify({ summary, rows: outcomes }, null, 1));
  }
  console.log(
    `[stress logout] ${JSON.stringify({ ...summary, failingSeeds: summary.failingSeeds.slice(0, 20) })}`,
  );

  assertEquals(outcomes.length, seeds.length, "every planned iteration ran");
  assertEquals(
    failing.length,
    0,
    `${failing.length} failing seed(s): ${JSON.stringify(summary.failingSeeds.slice(0, 10))}`,
  );
});

// ── Deterministic boundary scenarios ─────────────────────────────────────────

function sessionToken(rng: Rng, sessionId: string, userId = rng.uuid()): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt(
    {
      iss: `${SUPABASE_URL}/auth/v1`,
      sub: userId,
      aud: "authenticated",
      role: "authenticated",
      session_id: sessionId,
      exp: now + 3600,
      iat: now,
    },
    rng,
  );
}

function logoutRequest(token: string, ip: string): Request {
  return new Request("http://edge.test/functions/v1/api/v1/auth/logout", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "x-forwarded-for": ip },
  });
}

function readRequest(token: string, ip: string): Request {
  return new Request("http://edge.test/functions/v1/api/v1/me/saved-drills", {
    method: "GET",
    headers: { authorization: `Bearer ${token}`, "x-forwarded-for": ip },
  });
}

Deno.test(
  "stress: logout is idempotent — second call and sibling tokens of the session are refused locally",
  async () => {
    await withCampaign(async ({ harness, upstream }) => {
      const rng = new Rng(iterationSeed(STRESS_SEED, 100_001));
      const sessionId = `sess-${rng.hex(16)}`;
      const userId = rng.uuid();
      const token = sessionToken(rng, sessionId, userId);
      const sibling = sessionToken(rng, sessionId, userId);
      const ip = "198.51.100.10";

      const first = await harness.handler(logoutRequest(token, ip));
      assertEquals(first.status, 204);
      assertEquals(upstream.calls.filter((c) => c.url === LOGOUT_UPSTREAM).length, 1);

      const before = upstream.calls.length;
      const second = await harness.handler(logoutRequest(token, ip));
      assertEquals(second.status, 401, "logged-out bearer is refused");
      const third = await harness.handler(logoutRequest(sibling, ip));
      assertEquals(third.status, 401, "sibling token of the fenced session is refused");
      const read = await harness.handler(readRequest(sibling, ip));
      assertEquals(read.status, 401);
      assertEquals(
        upstream.calls.length,
        before,
        "fenced session refused without any upstream call",
      );
      for (const response of [second, third, read]) {
        assert(UUID_RE.test(response.headers.get("x-request-id") ?? ""), "request id present");
      }
    });
  },
);

Deno.test(
  "stress: concurrent logouts and reads of one session never 5xx and end fenced locally",
  async () => {
    await withCampaign(async ({ harness, upstream }) => {
      for (let round = 0; round < 20; round += 1) {
        const rng = new Rng(iterationSeed(STRESS_SEED, 200_000 + round));
        const sessionId = `sess-${rng.hex(16)}`;
        const token = sessionToken(rng, sessionId);
        const ip = `198.51.100.${20 + round}`;
        const fanout = 8 + rng.int(0, 24);

        const requests: Promise<Response>[] = [];
        for (let i = 0; i < fanout; i += 1) {
          requests.push(
            harness.handler(rng.chance(0.5) ? logoutRequest(token, ip) : readRequest(token, ip)),
          );
        }
        const responses = await Promise.all(requests);
        const statuses = responses.map((r) => r.status);
        await Promise.all(responses.map((r) => r.body?.cancel()));
        for (const status of statuses) {
          assert(
            status === 204 || status === 200 || status === 401,
            `round ${round}: unexpected status ${status} in ${statuses}`,
          );
        }
        assert(
          statuses.includes(204),
          `round ${round}: at least one logout succeeded (${statuses})`,
        );
        assert(upstream.calls.filter((c) => c.url === LOGOUT_UPSTREAM).length >= 1);

        const before = upstream.calls.length;
        const after = await harness.handler(readRequest(token, ip));
        assertEquals(after.status, 401, `round ${round}: session fenced once the race settled`);
        assertEquals(
          upstream.calls.length,
          before,
          `round ${round}: fence answered locally, nothing re-verified`,
        );
        upstream.calls = [];
      }
    });
  },
);

Deno.test(
  "stress: oversized declared body is refused before auth and before any upstream call",
  async () => {
    await withCampaign(async ({ harness, upstream }) => {
      const rng = new Rng(iterationSeed(STRESS_SEED, 300_001));
      const token = sessionToken(rng, `sess-${rng.hex(16)}`);
      for (const declared of [
        "5000001",
        "1e7",
        "99999999999999999999",
        String(MAX_JSON_BODY_BYTES + 1),
      ]) {
        const response = await harness.handler(
          new Request("http://edge.test/functions/v1/api/v1/auth/logout", {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "x-forwarded-for": "198.51.100.50",
              "content-length": declared,
            },
            body: "{}",
          }),
        );
        assertEquals(response.status, 413, `content-length ${declared}`);
        assertEquals(await response.json(), { error: { message: "Request body is too large." } });
      }
      assertEquals(upstream.calls.length, 0, "no upstream traffic for refused bodies");
      // At the cap itself the request proceeds normally.
      const atCap = await harness.handler(
        new Request("http://edge.test/functions/v1/api/v1/auth/logout", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "x-forwarded-for": "198.51.100.50",
            "content-length": String(MAX_JSON_BODY_BYTES),
          },
          body: "{}",
        }),
      );
      assertEquals(atCap.status, 204);
    });
  },
);

Deno.test(
  "stress: streamed body over the cap on the logout route is not read and does not block sign-out",
  async () => {
    await withCampaign(async ({ harness }) => {
      const rng = new Rng(iterationSeed(STRESS_SEED, 300_002));
      const token = sessionToken(rng, `sess-${rng.hex(16)}`);
      const chunk = new Uint8Array(1_000_000).fill(0x7b);
      let pulled = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          if (pulled > 8) controller.close();
          else controller.enqueue(chunk);
        },
      });
      const response = await harness.handler(
        new Request("http://edge.test/functions/v1/api/v1/auth/logout", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "x-forwarded-for": "198.51.100.51" },
          body: stream,
        }),
      );
      // The route ignores its body: an 8 MB chunked body neither 413s nor 500s.
      assertEquals(response.status, 204);
      assert(pulled <= 9, `body was not drained beyond need (pulled ${pulled} chunks)`);
    });
  },
);

Deno.test(
  "stress: auth-failure budget trips to 429 with Retry-After and stops upstream traffic",
  async () => {
    await withCampaign(async ({ harness, upstream }) => {
      const rng = new Rng(iterationSeed(STRESS_SEED, 400_001));
      const ip = "198.51.100.77";
      let tripped = -1;
      for (let i = 0; i < 40; i += 1) {
        const garbage = `Bearer ${rng.string(ALNUM, 24)}`;
        const response = await harness.handler(
          new Request("http://edge.test/functions/v1/api/v1/auth/logout", {
            method: "POST",
            headers: { authorization: garbage, "x-forwarded-for": ip },
          }),
        );
        await response.body?.cancel();
        if (response.status === 429) {
          tripped = i;
          assert(Number(response.headers.get("retry-after")) >= 1);
          break;
        }
        assertEquals(response.status, 401);
      }
      assertEquals(tripped, 30, "the 31st failed bearer from one ip is throttled");
      assertEquals(upstream.calls.length, 0, "structurally invalid bearers never reached upstream");

      // A VALID bearer from the tripped ip is throttled too — before any upstream call.
      const token = sessionToken(rng, `sess-${rng.hex(16)}`);
      const throttled = await harness.handler(logoutRequest(token, ip));
      assertEquals(throttled.status, 429);
      assertEquals(upstream.calls.length, 0);
      // …but the same bearer from another ip signs out normally.
      const ok = await harness.handler(logoutRequest(token, "198.51.100.78"));
      assertEquals(ok.status, 204);
    });
  },
);

Deno.test({
  name: "PROBE stress: upstream logout that never answers is bounded (STRESS_PROBE_HANG=1)",
  ignore: !PROBE_HANG,
  async fn() {
    await withCampaign(async ({ harness, upstream }) => {
      const rng = new Rng(iterationSeed(STRESS_SEED, 500_001));
      const token = sessionToken(rng, `sess-${rng.hex(16)}`);
      const base = globalThis.fetch;
      let released: (() => void) | null = null;
      globalThis.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        const request = new Request(input, init);
        if (request.url === LOGOUT_UPSTREAM) {
          upstream.calls.push({
            url: request.url,
            method: request.method,
            authorization: null,
            apikey: null,
          });
          await new Promise<void>((resolve) => {
            released = resolve;
          });
          return new Response(null, { status: 204 });
        }
        return base(request);
      }) as typeof fetch;
      try {
        const startedAt = performance.now();
        const answer = await Promise.race([
          harness.handler(logoutRequest(token, "198.51.100.90")).then((r) => r.status),
          sleep(PROBE_HANG_MS).then(() => "timeout" as const),
        ]);
        const elapsed = Math.round(performance.now() - startedAt);
        console.log(
          `[stress logout] hang probe: ${answer} after ${elapsed}ms (auth deadline ${AUTH_DEADLINE_MS}ms)`,
        );
        assertEquals(upstream.calls.filter((c) => c.url === LOGOUT_UPSTREAM).length, 1);
        assert(
          answer !== "timeout",
          `edge did not answer within ${PROBE_HANG_MS}ms while upstream logout hung (authRequest deadline is ${AUTH_DEADLINE_MS}ms)`,
        );
      } finally {
        (released as (() => void) | null)?.();
        globalThis.fetch = base;
      }
    });
  },
});
