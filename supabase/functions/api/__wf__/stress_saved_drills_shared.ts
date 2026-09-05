// Shared pieces of the DELETE /v1/me/saved-drills/:slug fuzz/boundary campaign:
// seeded PRNG, the request generator (path / method / headers / body / auth /
// upstream-fault families), an INDEPENDENT oracle for what the handler must
// answer, and the response invariants every iteration is held to.
//
// Two test files drive it:
//   stress_route_delete_saved_drills_fuzz.test.ts  — real handler, stubbed
//     Supabase Auth + PostgREST (routesHarness.ts) — the ≥3000-request lens.
//   stress_route_delete_saved_drills_pg.test.ts    — real handler → real
//     PostgREST → real postgres:16 with every migration (stress_pg_up.sh).
//
// Env: STRESS_SEED (campaign seed), STRESS_ITER (iterations; small default so
// the file lives in the normal suite), STRESS_REPLAY=<iteration seed> (run
// exactly one iteration), STRESS_OUT_DIR (JSON seed → outcome table).

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

export const STRESS_SEED = envInt("STRESS_SEED", 20260905);
export const STRESS_REPLAY = Deno.env.get("STRESS_REPLAY") ?? "";

export function outDir(): string {
  const configured = Deno.env.get("STRESS_OUT_DIR");
  if (configured) return configured.replace(/\/+$/, "");
  const here = new URL(".", import.meta.url).pathname;
  return `${here}../../../../artifacts/stress/route-delete-saved-drills`;
}

/** mulberry32 — deterministic; every iteration derives its own seed from the
 * campaign seed so a single case replays without re-running its predecessors. */
export class Prng {
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
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  range(min: number, maxInclusive: number): number {
    return min + this.int(maxInclusive - min + 1);
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  /** Weighted pick: [[weight, value], ...]. */
  weighted<T>(entries: ReadonlyArray<readonly [number, T]>): T {
    const total = entries.reduce((sum, [w]) => sum + w, 0);
    let roll = this.next() * total;
    for (const [w, value] of entries) {
      roll -= w;
      if (roll < 0) return value;
    }
    return entries[entries.length - 1][1];
  }
  chars(alphabet: string, length: number): string {
    let out = "";
    for (let i = 0; i < length; i += 1) out += alphabet[this.int(alphabet.length)];
    return out;
  }
  uuid(): string {
    const hex = "0123456789abcdef";
    const v = this.chars(hex, 32).split("");
    v[12] = "4";
    v[16] = "89ab"[this.int(4)];
    const s = v.join("");
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  }
}

export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export const iterationSeed = (campaignSeed: number, iteration: number): number =>
  fnv1a(`${campaignSeed}:${iteration}`);

// ── users ────────────────────────────────────────────────────────────────────

export interface PoolUser {
  id: string;
  googleToken: string;
  appleToken: string;
  /** Supabase-issued access token (a stub string in the fuzz file, a signed
   * HS256 JWT in the pg file). */
  sessionToken: string;
  /** What the (stubbed) PostgREST call must bear for this user. */
  accessTokenForProvider: string;
}

export function providerIdToken(
  issuer: "https://accounts.google.com" | "https://appleid.apple.com",
  sub: string,
  exp: number,
): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iss: issuer, sub, exp }));
  return `${header}.${payload}.sig`;
}

// ── generated case ───────────────────────────────────────────────────────────

export type AuthKind =
  | "google"
  | "apple"
  | "session"
  | "session-fresh"
  | "google-random-sub"
  | "none"
  | "empty"
  | "bearer-only"
  | "bearer-space"
  | "lowercase-bearer"
  | "basic"
  | "two-segments"
  | "four-segments"
  | "junk-payload"
  | "non-object-payload"
  | "no-iss"
  | "foreign-iss"
  | "http-google-iss"
  | "trailing-slash-iss"
  | "bare-google-iss"
  | "expired-provider"
  | "expired-session"
  | "exp-zero"
  | "exp-string"
  | "unknown-session"
  | "session-no-provider"
  | "huge-token"
  | "double-space-bearer"
  | "trailing-junk-token";

export type FaultKind =
  | "pgrst-400"
  | "pgrst-401"
  | "pgrst-403"
  | "pgrst-404"
  | "pgrst-409"
  | "pgrst-500-html"
  | "pgrst-502-empty"
  | "pgrst-503-retry"
  | "pgrst-200-garbage"
  | "pgrst-network"
  | "auth-user-503"
  | "auth-user-502-html"
  | "auth-user-200-garbage"
  | "auth-token-500";

export interface FuzzCase {
  iteration: number;
  seed: number;
  family: string;
  method: string;
  /** Mount prefix the gateway may present. */
  base: string;
  /** Raw path (+query/fragment) appended to the base. */
  rawPath: string;
  headers: Record<string, string>;
  bodyKind: string;
  bodyBytes: number;
  auth: { kind: AuthKind; userIndex: number; token: string | null };
  fault: FaultKind | null;
}

export interface Expectation {
  kind: "ok" | "reject" | "fault" | "read";
  /** Statuses the handler may answer. */
  statuses: number[];
  reason: string;
  userId?: string;
  slug?: string;
  /** Bearer the PostgREST call must carry when kind === "ok" / "fault". */
  dbBearer?: string;
  /** PostgREST writes the handler must issue: 0 unless the request reaches
   * the route's DELETE. */
  writes: 0 | 1;
}

export const ALLOWED_REJECT_STATUSES = [400, 401, 403, 404, 405, 413, 415, 429];
export const MAX_JSON_BODY_BYTES = 5_000_000;
export const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";
const SLUG_ALPHABET = `${LOWER}${DIGITS}-_`;
const LATIN1_PRINTABLE = (() => {
  let s = "";
  for (let c = 0x20; c < 0x7f; c += 1) s += String.fromCharCode(c);
  for (let c = 0xa0; c <= 0xff; c += 1) s += String.fromCharCode(c);
  return s;
})();

export const SECOND_USER_UUID_PLACEHOLDER = "{other}";

function validSlug(rng: Prng, length?: number, vocabulary?: readonly string[]): string {
  if (length === undefined && vocabulary && vocabulary.length > 0 && rng.chance(0.7)) {
    return rng.pick(vocabulary);
  }
  const len =
    length ??
    rng.weighted([
      [6, rng.range(1, 30)],
      [2, rng.range(31, 120)],
      [1, 1],
      [1, 120],
    ]);
  const first = rng.chars(`${LOWER}${DIGITS}`, 1);
  return first + rng.chars(SLUG_ALPHABET, len - 1);
}

/** Slug-segment families. `{other}` is replaced with another pool user's id
 * so injection attempts target a real second tenant. */
function slugSegment(rng: Prng, vocabulary?: readonly string[]): { text: string; family: string } {
  return rng.weighted<{ text: string; family: string }>([
    [30, { text: validSlug(rng, undefined, vocabulary), family: "slug-valid" }],
    [3, { text: validSlug(rng, 121), family: "slug-len-121" }],
    [3, { text: validSlug(rng, rng.range(122, 1_000)), family: "slug-len-1k" }],
    [2, { text: validSlug(rng, rng.range(1_001, 8_000)), family: "slug-len-8k" }],
    [1, { text: validSlug(rng, rng.range(8_001, 65_000)), family: "slug-len-64k" }],
    [3, { text: validSlug(rng, undefined, vocabulary).toUpperCase(), family: "slug-upper" }],
    [
      4,
      {
        text: rng.pick([
          "café",
          "ドリル",
          "🏓dink",
          "drill\u200b",
          "a\u0301b",
          "עברית",
          "ﬁ",
          "Ⅸ",
          "ǅ",
        ]),
        family: "slug-unicode-raw",
      },
    ],
    [
      4,
      {
        text: rng.pick([
          "a%20b",
          "a%2Fb",
          "a%2E",
          "%2E%2E",
          "a%25b",
          "a%3Fb",
          "a%23b",
          "a%26b",
          "a%3Db",
          "a%2Cb",
          "%2A",
          "%C3%A9",
          "%F0%9F%8F%93",
          "%E2%80%8B",
          "%EF%BB%BF",
          "%E2%80%AE",
        ]),
        family: "slug-pct-valid",
      },
    ],
    [
      4,
      {
        text: rng.pick([
          "%00",
          "a%00b",
          "%01",
          "%0A",
          "%0D%0A",
          "%09",
          "%7F",
          "%1B%5B31m",
          "%C2%85",
        ]),
        family: "slug-pct-control",
      },
    ],
    [
      5,
      {
        text: rng.pick([
          "%",
          "%2",
          "%G1",
          "%zz",
          "a%",
          "%%20",
          "%E0%A4%A",
          "%C0%AF",
          "%ED%A0%80",
          "%FF",
          "%80",
          "%C3",
          "%F8%88%80%80%80",
          "%ED%BF%BF",
        ]),
        family: "slug-pct-malformed",
      },
    ],
    [
      5,
      {
        text: rng.pick([
          "eq.x",
          "in.(a,b)",
          "*",
          "a,b",
          "not.eq.x",
          `x&user_id=eq.${SECOND_USER_UUID_PLACEHOLDER}`,
          `x%26user_id%3Deq.${SECOND_USER_UUID_PLACEHOLDER}`,
          "x&select=*",
          "a.b.c",
          '"quoted"',
          "is.null",
          "x&slug=neq.zzz",
          "%2A",
          "like.%2A",
          "x&or=(slug.neq.zzz)",
        ]),
        family: "slug-pgrst-syntax",
      },
    ],
    [
      3,
      {
        text: rng.pick([
          "' OR '1'='1",
          "x'; DROP TABLE user_saved_drills;--",
          "$1",
          "{}",
          "[]",
          "<script>alert(1)</script>",
          "\\",
          "x\\y",
          "x\\..\\y",
          "$(id)",
          "`id`",
          "x;y",
          "x|y",
          "\u0000".repeat(3),
        ]),
        family: "slug-sqlish",
      },
    ],
    [
      3,
      {
        text: rng.pick(["..", ".", "...", "%2e%2e", "%2e", "x/../y", "../x", "./x", "%2e%2e%2fx"]),
        family: "slug-dots",
      },
    ],
    [
      2,
      {
        text: rng.pick(["x y", " x", "x ", "\tx", "x\n", "x%20", "%20", "x\u00a0y"]),
        family: "slug-whitespace",
      },
    ],
    [2, { text: rng.chars(LATIN1_PRINTABLE, rng.range(1, 40)), family: "slug-latin1-random" }],
    [
      1,
      { text: rng.chars("%0123456789abcdefABCDEF", rng.range(1, 60)), family: "slug-pct-random" },
    ],
  ]);
}

function pathVariant(rng: Prng, slug: string): { rawPath: string; family: string } {
  const route = "/v1/me/saved-drills";
  return rng.weighted<{ rawPath: string; family: string }>([
    [55, { rawPath: `${route}/${slug}`, family: "path-route" }],
    [3, { rawPath: `${route}/${slug}/`, family: "path-trailing-slash" }],
    [3, { rawPath: `${route}/${slug}/${validSlug(rng)}`, family: "path-extra-segment" }],
    [3, { rawPath: `${route}`, family: "path-no-slug" }],
    [2, { rawPath: `${route}/`, family: "path-empty-slug" }],
    [2, { rawPath: `${route}//${slug}`, family: "path-double-slash" }],
    [2, { rawPath: `/v1/me/Saved-Drills/${slug}`, family: "path-case" }],
    [2, { rawPath: `/v2/me/saved-drills/${slug}`, family: "path-v2" }],
    [2, { rawPath: `/v1/me/saved-drill/${slug}`, family: "path-typo" }],
    [2, { rawPath: `${route}/${slug}${route}/${validSlug(rng)}`, family: "path-repeat-v1" }],
    [2, { rawPath: `/v1/v1/me/saved-drills/${slug}`, family: "path-double-v1" }],
    [3, { rawPath: `${route}/${slug}?slug=${validSlug(rng)}`, family: "path-query-slug" }],
    [
      3,
      {
        rawPath: `${route}/${slug}?user_id=eq.${SECOND_USER_UUID_PLACEHOLDER}&select=*`,
        family: "path-query-injection",
      },
    ],
    [
      2,
      {
        rawPath: `${route}/${slug}?${rng.chars(LATIN1_PRINTABLE, rng.range(1, 200))}`,
        family: "path-query-random",
      },
    ],
    [
      1,
      {
        rawPath: `${route}/${slug}?${"q=".repeat(1)}${rng.chars(SLUG_ALPHABET, 50_000)}`,
        family: "path-query-50k",
      },
    ],
    [2, { rawPath: `${route}/${slug}#frag`, family: "path-fragment" }],
    [
      2,
      {
        rawPath: `${route}/${slug}?_method=PUT&x-http-method-override=PUT`,
        family: "path-method-override-query",
      },
    ],
    [
      1,
      {
        rawPath: `${route}/${"a/".repeat(rng.range(2, 200))}${slug}`,
        family: "path-many-segments",
      },
    ],
    [1, { rawPath: `/v1/me/saved-drills%2F${slug}`, family: "path-encoded-slash" }],
    [1, { rawPath: `${route}/${slug}/..`, family: "path-dotdot-tail" }],
    [1, { rawPath: `${route}/${slug}/../${validSlug(rng)}`, family: "path-dotdot-sibling" }],
  ]);
}

const HEADER_NOISE: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    "content-type",
    [
      "application/json",
      "text/plain",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
      "",
      "\u00e9\u00ff",
      "application/json; charset=utf-16",
    ],
  ],
  ["accept", ["*/*", "application/json", "text/html", "application/vnd.pgrst.object+json", ""]],
  ["x-http-method-override", ["PUT", "GET", "POST", "DELETE", "PATCH"]],
  ["x-original-url", ["/v1/me/saved-drills/other", "/healthz"]],
  ["x-rewrite-url", ["/v1/account/bootstrap"]],
  ["origin", ["https://evil.example", "null", "http://localhost"]],
  ["user-agent", ["", "PickleSensei/1.0", "curl/8", "\u00ff".repeat(300)]],
  ["prefer", ["return=representation", "resolution=merge-duplicates", "count=exact"]],
  ["range", ["0-9", "bytes=0-"]],
  ["if-match", ["*", '"etag"']],
  ["expect", ["100-continue"]],
  ["accept-profile", ["auth", "storage"]],
  ["content-profile", ["auth"]],
  ["apikey", ["service-role-test-key", "anon-test-key", "x"]],
  ["x-client-info", ["supabase-js/2"]],
  ["cookie", ["sb-access-token=abc; other=1"]],
  ["te", ["trailers"]],
  ["x-real-ip", ["10.0.0.1"]],
  ["forwarded", ["for=10.0.0.9"]],
];

function requestIdVariant(rng: Prng): { value: string; valid: boolean; family: string } {
  return rng.weighted<{ value: string; valid: boolean; family: string }>([
    [
      5,
      {
        value: `req-${rng.chars(`${LOWER}${DIGITS}`, rng.range(4, 20))}`,
        valid: true,
        family: "rid-valid",
      },
    ],
    [
      1,
      {
        value: rng.chars("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-", 64),
        valid: true,
        family: "rid-valid-64",
      },
    ],
    [1, { value: rng.chars(LOWER, 8), valid: true, family: "rid-valid-8" }],
    [1, { value: `  ${rng.chars(LOWER, 12)}  `, valid: true, family: "rid-valid-padded" }],
    [1, { value: rng.chars(LOWER, 7), valid: false, family: "rid-short" }],
    [1, { value: rng.chars(LOWER, 65), valid: false, family: "rid-long" }],
    [1, { value: rng.chars(LOWER, 2_000), valid: false, family: "rid-huge" }],
    [1, { value: "abc def ghi", valid: false, family: "rid-space" }],
    [1, { value: "", valid: false, family: "rid-empty" }],
    [1, { value: `${rng.chars(LOWER, 10)}\u00e9`, valid: false, family: "rid-latin1" }],
    [
      1,
      { value: `${rng.chars(LOWER, 10)}\t${rng.chars(LOWER, 4)}`, valid: false, family: "rid-tab" },
    ],
    [1, { value: "<script>alert(1)</script>", valid: false, family: "rid-html" }],
    [1, { value: "../../etc/passwd", valid: false, family: "rid-traversal" }],
    [
      1,
      {
        value: `${rng.chars(LOWER, 10)}, ${rng.chars(LOWER, 10)}`,
        valid: false,
        family: "rid-comma",
      },
    ],
  ]);
}

export interface GenerateOptions {
  users: PoolUser[];
  /** IPs shared by well-authenticated requests (budget 1200/min each). */
  ipPool: string[];
  /** Whether upstream faults may be injected (stub mode only). */
  faults: boolean;
  /** Restrict the generator to cases that are safe against a real database
   * (pg mode): DELETE only, decodable paths still allowed, no faults. */
  pgSafe: boolean;
  /** Slugs that exist in the fixture; the valid-slug family draws from them
   * most of the time so accepted requests really delete rows. */
  slugVocabulary?: readonly string[];
}

export function generateCase(iteration: number, seed: number, options: GenerateOptions): FuzzCase {
  const rng = new Prng(seed);
  const families: string[] = [];
  const headers: Record<string, string> = {};

  // ── method
  const method = options.pgSafe
    ? "DELETE"
    : rng.weighted<string>([
        [80, "DELETE"],
        [3, "delete"],
        [3, "GET"],
        [2, "HEAD"],
        [3, "POST"],
        [2, "PATCH"],
        [2, "OPTIONS"],
        [1, "FOO"],
        [1, "PROPFIND"],
        [1, "Delete"],
      ]);
  if (method !== "DELETE") families.push(`method-${method}`);

  // ── path
  const userIndex = rng.int(options.users.length);
  const otherIndex = (userIndex + 1 + rng.int(options.users.length - 1)) % options.users.length;
  const segment = slugSegment(rng, options.slugVocabulary);
  const variant = pathVariant(rng, segment.text);
  const rawPath = variant.rawPath.replaceAll(
    SECOND_USER_UUID_PLACEHOLDER,
    options.users[otherIndex].id,
  );
  families.push(segment.family, variant.family);
  const base = rng.weighted<string>([
    [12, "/functions/v1/api"],
    [2, "/api"],
    [1, ""],
    [1, "/functions/v1/api/"],
  ]);
  if (base !== "/functions/v1/api") families.push(`mount-${base || "root"}`);

  // ── upstream fault (stub mode only). Decided before auth so an Auth fault
  // rides on a token the auth cache has never seen (a cached bearer never
  // reaches Supabase Auth, so the fault would not be exercised).
  let fault: FaultKind | null = null;
  if (options.faults && rng.chance(0.08)) {
    const pgFaults: FaultKind[] = [
      "pgrst-400",
      "pgrst-401",
      "pgrst-403",
      "pgrst-404",
      "pgrst-409",
      "pgrst-500-html",
      "pgrst-502-empty",
      "pgrst-503-retry",
      "pgrst-200-garbage",
      "pgrst-network",
    ];
    const authFaults: FaultKind[] = [
      "auth-user-503",
      "auth-user-502-html",
      "auth-user-200-garbage",
      "auth-token-500",
    ];
    fault = rng.chance(0.75) ? rng.pick(pgFaults) : rng.pick(authFaults);
    families.push(`fault-${fault}`);
  }

  // ── auth
  const user = options.users[userIndex];
  const authKind: AuthKind = fault?.startsWith("auth-user-")
    ? "session-fresh"
    : fault === "auth-token-500"
      ? "google-random-sub"
      : fault !== null
        ? rng.weighted<AuthKind>([
            [3, "google"],
            [1, "apple"],
            [3, "session"],
            [1, "session-fresh"],
            [1, "google-random-sub"],
          ])
        : options.pgSafe
          ? rng.weighted<AuthKind>([
              [6, "google"],
              [3, "apple"],
              [6, "session"],
              [1, "none"],
              [1, "unknown-session"],
              [1, "expired-provider"],
              [1, "two-segments"],
            ])
          : rng.weighted<AuthKind>([
              [30, "google"],
              [12, "apple"],
              [22, "session"],
              [3, "session-fresh"],
              [4, "google-random-sub"],
              [2, "none"],
              [1, "empty"],
              [1, "bearer-only"],
              [1, "bearer-space"],
              [1, "lowercase-bearer"],
              [1, "basic"],
              [1, "two-segments"],
              [1, "four-segments"],
              [1, "junk-payload"],
              [1, "non-object-payload"],
              [1, "no-iss"],
              [1, "foreign-iss"],
              [1, "http-google-iss"],
              [1, "trailing-slash-iss"],
              [1, "bare-google-iss"],
              [1, "expired-provider"],
              [1, "expired-session"],
              [1, "exp-zero"],
              [1, "exp-string"],
              [1, "unknown-session"],
              [1, "session-no-provider"],
              [1, "huge-token"],
              [1, "double-space-bearer"],
              [1, "trailing-junk-token"],
            ]);
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const pastExp = Math.floor(Date.now() / 1000) - 60;
  const google = "https://accounts.google.com";
  const apple = "https://appleid.apple.com";
  const jwt = (payload: unknown, segments = 3): string => {
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const body = typeof payload === "string" ? payload : b64url(JSON.stringify(payload));
    const parts = [header, body, "sig", "extra"].slice(0, segments);
    return parts.join(".");
  };
  let token: string | null = null;
  let authorization: string | null = null;
  switch (authKind) {
    case "google":
      token = user.googleToken;
      break;
    case "apple":
      token = user.appleToken;
      break;
    case "session":
      token = user.sessionToken;
      break;
    case "session-fresh":
    case "session-no-provider":
      token = jwt({
        iss: "http://supabase.test/auth/v1",
        sub: user.id,
        exp: futureExp,
        session_id: rng.uuid(),
        role: "authenticated",
      });
      break;
    case "google-random-sub":
      token = providerIdToken(google, rng.uuid(), futureExp);
      break;
    case "none":
      authorization = null;
      break;
    case "empty":
      authorization = "";
      break;
    case "bearer-only":
      authorization = "Bearer";
      break;
    case "bearer-space":
      authorization = "Bearer ";
      break;
    case "lowercase-bearer":
      authorization = `bearer ${user.googleToken}`;
      break;
    case "basic":
      authorization = `Basic ${b64url("user:pass")}`;
      break;
    case "two-segments":
      token = jwt({ iss: google, sub: user.id, exp: futureExp }, 2);
      break;
    case "four-segments":
      token = jwt({ iss: google, sub: user.id, exp: futureExp }, 4);
      break;
    case "junk-payload":
      token = jwt(rng.chars(`${LOWER}${DIGITS}-_`, rng.range(1, 40)));
      break;
    case "non-object-payload":
      token = jwt(rng.pick([null, 42, "str", [google], true]));
      break;
    case "no-iss":
      token = jwt({ sub: user.id, exp: futureExp });
      break;
    case "foreign-iss":
      token = jwt({
        iss: rng.pick([
          "https://evil.example",
          "https://accounts.google.com.evil.example",
          "https://login.microsoftonline.com/v2.0",
          "supabase",
        ]),
        sub: user.id,
        exp: futureExp,
      });
      break;
    case "http-google-iss":
      token = jwt({ iss: "http://accounts.google.com", sub: user.id, exp: futureExp });
      break;
    case "trailing-slash-iss":
      token = jwt({ iss: `${google}/`, sub: user.id, exp: futureExp });
      break;
    case "bare-google-iss":
      token = jwt({ iss: "accounts.google.com", sub: user.id, exp: futureExp });
      break;
    case "expired-provider":
      token = providerIdToken(rng.chance(0.5) ? google : apple, user.id, pastExp);
      break;
    case "expired-session":
      token = jwt({
        iss: "http://supabase.test/auth/v1",
        sub: user.id,
        exp: pastExp,
        session_id: rng.uuid(),
      });
      break;
    case "exp-zero":
      token = jwt({ iss: google, sub: user.id, exp: 0 });
      break;
    case "exp-string":
      token = jwt({ iss: google, sub: user.id, exp: String(pastExp) });
      break;
    case "unknown-session":
      token = jwt({
        iss: "http://supabase.test/auth/v1",
        sub: rng.uuid(),
        exp: futureExp,
        session_id: rng.uuid(),
        role: "authenticated",
      });
      break;
    case "huge-token":
      token = jwt({ iss: google, sub: user.id, exp: futureExp, pad: rng.chars(LOWER, 40_000) });
      break;
    case "double-space-bearer":
      authorization = `Bearer   ${user.googleToken}`;
      token = user.googleToken;
      break;
    case "trailing-junk-token":
      authorization = `Bearer ${user.googleToken} ${rng.chars(LOWER, 5)}`;
      token = `${user.googleToken} ${"x"}`;
      break;
  }
  if (authorization === null && token !== null) authorization = `Bearer ${token}`;
  if (authorization !== null) headers["authorization"] = authorization;
  const wellAuthed = [
    "google",
    "apple",
    "session",
    "session-fresh",
    "google-random-sub",
    "bare-google-iss",
    "exp-string",
    "double-space-bearer",
    "trailing-junk-token",
  ].includes(authKind);
  if (!wellAuthed) families.push(`auth-${authKind}`);
  if (authKind === "session-no-provider") families.push("auth-session-no-provider");

  // ── client ip: well-authed cases share the pool (per-IP budget 1200/min);
  // everything that can fail auth gets a unique IP (auth-failure budget 30).
  const ip = wellAuthed
    ? rng.pick(options.ipPool)
    : `198.51.${(iteration >> 8) & 0xff}.${iteration & 0xff}`;
  const ipHeader = rng.weighted<string>([
    [12, "xff"],
    [2, "cf"],
    [1, "xff-multi"],
    [1, "xff-garbage"],
  ]);
  if (ipHeader === "cf") {
    headers["cf-connecting-ip"] = ip;
    if (rng.chance(0.5)) headers["x-forwarded-for"] = "1.1.1.1";
  } else if (ipHeader === "xff-multi") {
    headers["x-forwarded-for"] =
      `${rng.chars(LATIN1_PRINTABLE, rng.range(0, 30))}, 10.0.0.${rng.int(255)}, ${ip}`;
  } else if (ipHeader === "xff-garbage" && wellAuthed) {
    headers["x-forwarded-for"] = rng.pick([",,,", " , ", "", ",", "\u00ff\u00fe"]);
    families.push("ip-garbage");
  } else {
    headers["x-forwarded-for"] = ip;
  }

  // ── request id
  if (rng.chance(0.6)) {
    const rid = requestIdVariant(rng);
    headers["x-request-id"] = rid.value;
    families.push(rid.family);
  }

  // ── noise headers (never semantic for this route)
  const noiseCount = rng.weighted<number>([
    [6, 0],
    [3, 1],
    [2, 2],
    [1, 5],
  ]);
  for (let i = 0; i < noiseCount; i += 1) {
    const [name, values] = rng.pick(HEADER_NOISE);
    headers[name] = rng.pick(values);
  }
  if (noiseCount > 0) families.push("headers-noise");

  // ── body + content-length
  const bodyKind =
    method === "GET" || method === "HEAD"
      ? "none"
      : rng.weighted<string>([
          [10, "none"],
          [2, "empty"],
          [3, "json-object"],
          [2, "json-garbage"],
          [2, "binary-1k"],
          [1, "text-100k"],
          [1, "text-1m"],
          [1, "nul-bytes"],
        ]);
  const bodyBytes =
    {
      none: 0,
      empty: 0,
      "json-object": 40,
      "json-garbage": 12,
      "binary-1k": 1_024,
      "text-100k": 100_000,
      "text-1m": 1_000_000,
      "nul-bytes": 64,
    }[bodyKind] ?? 0;
  if (bodyKind !== "none") families.push(`body-${bodyKind}`);
  const clKind = rng.weighted<string>([
    [40, "absent"],
    [1, "over-cap"],
    [1, "exactly-cap"],
    [1, "cap-plus-one"],
    [1, "nan"],
    [1, "negative"],
    [1, "infinity"],
    [1, "exponent-over"],
    [1, "hex"],
    [1, "float-over"],
  ]);
  const cl: Record<string, string | undefined> = {
    absent: undefined,
    "over-cap": "6000000",
    "exactly-cap": String(MAX_JSON_BODY_BYTES),
    "cap-plus-one": String(MAX_JSON_BODY_BYTES + 1),
    nan: "abc",
    negative: "-1",
    infinity: "Infinity",
    "exponent-over": "1e7",
    hex: "0x5F5E100",
    "float-over": "5000000.5",
  };
  if (cl[clKind] !== undefined) {
    headers["content-length"] = cl[clKind] as string;
    families.push(`cl-${clKind}`);
  }

  return {
    iteration,
    seed,
    family: families.join("|"),
    method,
    base,
    rawPath,
    headers,
    bodyKind,
    bodyBytes,
    auth: { kind: authKind, userIndex, token },
    fault,
  };
}

export function bodyFor(fuzz: FuzzCase, rng: Prng): BodyInit | undefined {
  switch (fuzz.bodyKind) {
    case "none":
      return undefined;
    case "empty":
      return "";
    case "json-object":
      return JSON.stringify({ slug: "other-slug", saved: false, user_id: rng.uuid() });
    case "json-garbage":
      return '{"slug": ';
    case "binary-1k": {
      const bytes = new Uint8Array(1_024);
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = rng.int(256);
      return bytes;
    }
    case "text-100k":
      return "x".repeat(100_000);
    case "text-1m":
      return "y".repeat(1_000_000);
    case "nul-bytes":
      return new Uint8Array(64);
    default:
      return undefined;
  }
}

/** Build the Request; returns null when the platform refuses to construct it
 * (an unconstructible case never reaches the handler and is not counted). */
export function buildRequest(fuzz: FuzzCase): { request: Request; url: URL } | { error: string } {
  try {
    const url = new URL(`${fuzz.base}${fuzz.rawPath}`, "http://edge.test");
    const headers = new Headers();
    for (const [name, value] of Object.entries(fuzz.headers)) headers.set(name, value);
    const body = bodyFor(fuzz, new Prng(fuzz.seed ^ 0x5bd1e995));
    const request = new Request(url, { method: fuzz.method, headers, body });
    return { request, url };
  } catch (error) {
    return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

// ── oracle ───────────────────────────────────────────────────────────────────

const NORMALIZED_METHODS = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"]);
export function normalizedMethod(method: string): string {
  const upper = method.toUpperCase();
  return NORMALIZED_METHODS.has(upper) ? upper : method;
}

function decodePayload(token: string): Record<string, unknown> | null | "invalid" {
  const segments = token.split(".");
  if (segments.length !== 3) return "invalid";
  try {
    const base64 = segments[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(base64)) as Record<string, unknown> | null;
  } catch {
    return "invalid";
  }
}

function providerForIssuer(issuer: unknown): "google" | "apple" | null {
  if (typeof issuer !== "string") return null;
  const iss = issuer.replace(/^https:\/\//, "");
  if (iss === "accounts.google.com") return "google";
  if (iss === "appleid.apple.com") return "apple";
  return null;
}

export interface OracleContext {
  users: PoolUser[];
  /** Session tokens the (stubbed or real) Auth accepts → user id. */
  sessionUsers: Map<string, { id: string; provider: "google" | "apple" | null }>;
  /** Access token PostgREST must see for a given provider-token subject. */
  providerAccessToken: (sub: string) => string;
  defaultProviderSub: string;
  /** Real-PostgREST mode: a decoded slug longer than this many characters may
   * also be answered with the generic 503 (the upstream refuses the request
   * line). Tolerated, tagged and counted separately — it is a recorded
   * finding, not a pass. */
  oversizedSlugMayFail?: number;
}

/** What the handler must answer, derived independently from the request the
 * platform actually built (URL normalisation included). */
export function expectation(fuzz: FuzzCase, url: URL, ctx: OracleContext): Expectation {
  const method = normalizedMethod(fuzz.method);
  const h = (name: string): string | undefined => fuzz.headers[name];
  const pathname = url.pathname;
  const reject = (status: number, reason: string): Expectation => ({
    kind: "reject",
    statuses: [status],
    reason,
    writes: 0,
  });

  const declared = Number(h("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES)
    return reject(413, "content-length over cap");

  // authenticate()
  const authorization = h("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!token) return reject(401, "missing bearer");
  const payload = decodePayload(token);
  const record = payload !== "invalid" && isRecord(payload) ? payload : null;
  const provider = providerForIssuer(record?.iss);
  const supabaseIssued = typeof record?.iss === "string" && record.iss.endsWith("/auth/v1");
  if (!provider && !supabaseIssued) return reject(401, "bearer neither provider nor session token");
  if (typeof record?.exp === "number" && record.exp * 1000 <= Date.now())
    return reject(401, "bearer expired");

  let userId: string;
  let dbBearer: string;
  if (provider) {
    if (fuzz.fault === "auth-token-500")
      return reject(401, "signInWithIdToken failed → 401 (transitional provider-token path)");
    const sub = record?.sub;
    userId = sub === undefined || sub === null ? ctx.defaultProviderSub : String(sub);
    dbBearer = ctx.providerAccessToken(userId);
  } else {
    if (fuzz.fault?.startsWith("auth-user-")) {
      return { kind: "fault", statuses: [503], reason: `Supabase Auth ${fuzz.fault}`, writes: 0 };
    }
    const session = ctx.sessionUsers.get(token);
    if (!session) return reject(401, "session token refused by Auth");
    if (fuzz.auth.kind === "session-no-provider" || !session.provider)
      return reject(401, "session without provider");
    userId = session.id;
    dbBearer = token;
  }

  // routing
  const v1 = pathname.lastIndexOf("/v1/");
  const path = v1 >= 0 ? pathname.slice(v1) : pathname;
  if (method === "GET" && path === "/v1/me/saved-drills") {
    return { kind: "read", statuses: [200], reason: "sibling list route", userId, writes: 0 };
  }
  if (method !== "DELETE") return reject(404, `unknown endpoint ${method} ${path}`);
  const m = /^\/v1\/me\/saved-drills\/([^/]+)$/.exec(path);
  if (!m) return reject(404, `unknown endpoint DELETE ${path}`);
  let slug: string;
  try {
    slug = decodeURIComponent(m[1]);
  } catch {
    return reject(400, "malformed path segment");
  }
  if (fuzz.fault?.startsWith("pgrst-")) {
    return {
      kind: "fault",
      statuses: [503],
      reason: `PostgREST ${fuzz.fault}`,
      userId,
      slug,
      dbBearer,
      writes: 1,
    };
  }
  if (ctx.oversizedSlugMayFail !== undefined && slug.length > ctx.oversizedSlugMayFail) {
    return {
      kind: "ok",
      statuses: [204, 503],
      reason: `delete (slug ${slug.length} chars > ${ctx.oversizedSlugMayFail}: upstream may refuse the request line → generic 503; KNOWN BOUNDARY)`,
      userId,
      slug,
      dbBearer,
      writes: 1,
    };
  }
  return { kind: "ok", statuses: [204], reason: "delete", userId, slug, dbBearer, writes: 1 };
}

// ── response invariants ──────────────────────────────────────────────────────

const LEAK_MARKERS = [
  "\n    at ",
  "    at file:",
  "file://",
  "index.ts",
  "TypeError",
  "URIError",
  "SyntaxError",
  "ReferenceError",
  "PGRST",
  "42501",
  "22021",
  "user_saved_drills",
  "supabase.test",
  "/rest/v1/",
  "postgres",
  "stack",
  "connection refused",
  "ECONNREFUSED",
];

export const GENERIC_5XX_RE =
  /^(Something went wrong\. Please try again\.|[A-Za-z][A-Za-z ]* is temporarily unavailable\. Please try again\.)$/;

export interface Observed {
  status: number;
  requestId: string | null;
  contentType: string | null;
  bodyText: string;
  bodyJson: unknown;
  retryAfter: string | null;
  dbWrites: Array<{
    method: string;
    url: string;
    authorization: string | null;
    apikey: string | null;
  }>;
}

export function checkInvariants(fuzz: FuzzCase, expect: Expectation, seen: Observed): string[] {
  const violations: string[] = [];
  const h = fuzz.headers;

  // request id: always present, always well-formed, honoured iff well-formed
  if (!seen.requestId || !REQUEST_ID_RE.test(seen.requestId)) {
    violations.push(`x-request-id missing or malformed: ${JSON.stringify(seen.requestId)}`);
  } else if (h["x-request-id"] !== undefined) {
    const incoming = h["x-request-id"].trim();
    if (REQUEST_ID_RE.test(incoming) && seen.requestId !== incoming) {
      violations.push(
        `well-formed client x-request-id not honoured (${incoming} → ${seen.requestId})`,
      );
    }
    if (!REQUEST_ID_RE.test(incoming) && seen.requestId === incoming) {
      violations.push("malformed client x-request-id echoed verbatim");
    }
  }

  // status class
  if (!expect.statuses.includes(seen.status)) {
    violations.push(
      `status ${seen.status} not in expected ${JSON.stringify(expect.statuses)} (${expect.reason})`,
    );
  }
  if (expect.kind === "reject" && !ALLOWED_REJECT_STATUSES.includes(seen.status)) {
    violations.push(
      `bad input answered ${seen.status}, allowed ${ALLOWED_REJECT_STATUSES.join("/")}`,
    );
  }
  if (seen.status >= 500 && expect.kind !== "fault" && !expect.statuses.includes(seen.status)) {
    violations.push(`5xx (${seen.status}) without an injected upstream fault`);
  }

  // error bodies: JSON envelope, hardened headers, no internals
  if (seen.status >= 400) {
    if (!(seen.contentType ?? "").includes("application/json")) {
      violations.push(
        `error content-type ${JSON.stringify(seen.contentType)} is not application/json`,
      );
    }
    const message =
      isRecord(seen.bodyJson) && isRecord(seen.bodyJson.error)
        ? seen.bodyJson.error.message
        : undefined;
    if (typeof message !== "string" || !message) {
      violations.push(`error body lacks error.message: ${seen.bodyText.slice(0, 120)}`);
    }
    if (seen.status >= 500 && typeof message === "string" && !GENERIC_5XX_RE.test(message)) {
      violations.push(`5xx body is not the generic message: ${message.slice(0, 160)}`);
    }
    const lower = seen.bodyText.toLowerCase();
    for (const marker of LEAK_MARKERS) {
      if (lower.includes(marker.toLowerCase())) {
        // The 404 body echoes the requested route; a marker the CLIENT put in
        // the path is reflection, reported separately, not an internal leak.
        const clientSent = `${fuzz.base}${fuzz.rawPath}`
          .toLowerCase()
          .includes(marker.toLowerCase());
        if (!clientSent) violations.push(`body leaks internal marker ${JSON.stringify(marker)}`);
      }
    }
  }

  // writes
  if (expect.writes === 0) {
    if (seen.dbWrites.length > 0) {
      violations.push(
        `${seen.dbWrites.length} PostgREST write(s) on a ${expect.kind} (${expect.reason}): ${seen.dbWrites
          .map((w) => `${w.method} ${w.url}`)
          .join("; ")
          .slice(0, 300)}`,
      );
    }
  } else {
    if (seen.dbWrites.length !== 1) {
      violations.push(`expected exactly one PostgREST DELETE, saw ${seen.dbWrites.length}`);
    }
    for (const write of seen.dbWrites) {
      const target = new URL(write.url);
      if (write.method !== "DELETE")
        violations.push(`PostgREST write method ${write.method} !== DELETE`);
      if (
        !target.pathname.endsWith("/rest/v1/user_saved_drills") &&
        !target.pathname.endsWith("/user_saved_drills")
      ) {
        violations.push(`PostgREST write targets ${target.pathname}`);
      }
      const params = target.searchParams;
      if (params.get("user_id") !== `eq.${expect.userId}`) {
        violations.push(
          `user_id filter ${JSON.stringify(params.get("user_id"))} !== eq.${expect.userId}`,
        );
      }
      if (params.get("slug") !== `eq.${expect.slug}`) {
        violations.push(
          `slug filter ${JSON.stringify(params.get("slug"))} !== eq.${JSON.stringify(expect.slug)}`,
        );
      }
      const extra = [...params.keys()].filter((k) => k !== "user_id" && k !== "slug");
      if (extra.length > 0) violations.push(`unexpected filter params ${JSON.stringify(extra)}`);
      if (expect.dbBearer && write.authorization !== `Bearer ${expect.dbBearer}`) {
        violations.push(`PostgREST bearer is not the user's own access token`);
      }
      if (write.apikey && write.apikey.includes("service"))
        violations.push("PostgREST call carries the service-role key");
    }
  }
  if (seen.status === 204 && seen.bodyText !== "") violations.push("204 with a body");
  return violations;
}

// ── report ───────────────────────────────────────────────────────────────────

export interface IterationRow {
  iteration: number;
  seed: number;
  family: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyKind: string;
  authKind: AuthKind;
  fault: FaultKind | null;
  expected: { kind: string; statuses: number[]; reason: string };
  status: number | null;
  requestId: string | null;
  bodyPreview: string;
  dbWrites: number;
  durationMs: number;
  violations: string[];
  /** Platform refused to build the Request (never reached the handler). */
  unconstructible?: string;
}

export function truncateHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers))
    out[k] = v.length > 200 ? `${v.slice(0, 200)}…(${v.length} chars)` : v;
  return out;
}

export function truncateUrl(url: string): string {
  return url.length > 400 ? `${url.slice(0, 400)}…(${url.length} chars)` : url;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2));
}

export function summarize(rows: IterationRow[]): Record<string, unknown> {
  const byStatus: Record<string, number> = {};
  const byExpected: Record<string, number> = {};
  const byFamily: Record<string, number> = {};
  let executed = 0;
  let unconstructible = 0;
  for (const row of rows) {
    if (row.unconstructible) {
      unconstructible += 1;
      continue;
    }
    executed += 1;
    byStatus[String(row.status)] = (byStatus[String(row.status)] ?? 0) + 1;
    byExpected[row.expected.kind] = (byExpected[row.expected.kind] ?? 0) + 1;
    for (const f of row.family.split("|")) byFamily[f] = (byFamily[f] ?? 0) + 1;
  }
  const failing = rows.filter((r) => r.violations.length > 0);
  const fiveXx = rows.filter((r) => (r.status ?? 0) >= 500);
  const uninjected5xx = fiveXx.filter((r) => r.fault === null);
  return {
    executed,
    unconstructible,
    failing: failing.length,
    uninjected5xx: uninjected5xx.map((r) => ({
      iteration: r.iteration,
      seed: r.seed,
      family: r.family,
      status: r.status,
      reason: r.expected.reason,
      url: r.url.slice(0, 120),
    })),
    failingSeeds: failing.map((r) => ({
      iteration: r.iteration,
      seed: r.seed,
      family: r.family,
      status: r.status,
      violations: r.violations,
    })),
    fiveXx: fiveXx.map((r) => ({
      iteration: r.iteration,
      seed: r.seed,
      family: r.family,
      status: r.status,
      fault: r.fault,
      injected: r.fault !== null,
    })),
    byStatus,
    byExpected,
    byFamily,
  };
}
