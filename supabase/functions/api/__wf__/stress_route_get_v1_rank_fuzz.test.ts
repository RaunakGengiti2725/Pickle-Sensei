/**
 * STRESS / FUZZ-BOUNDARY — edge route `GET /v1/rank` (index.ts getPlayerRank).
 *
 * Drives the REAL Deno.serve handler in-process (routesHarness.ts: Supabase
 * Auth, PostgREST and RevenueCat stubbed at fetch level, Upstash disabled) with
 * seeded, replayable generated requests across five dimensions:
 *
 *   auth     — bearer shapes (missing / malformed JWT / wrong issuer / expired /
 *              odd claim types / oversized / Supabase session tokens whose
 *              GoTrue verification answers ok, 401/403, 5xx, HTML, garbage or
 *              a socket fault)
 *   path     — mount prefixes, case, trailing slash, extra segments, encoded
 *              and malformed escapes, dot segments, long query strings, other
 *              methods on the route
 *   headers  — x-request-id / x-forwarded-for / cf-connecting-ip /
 *              content-length / content-type / accept junk, many or huge headers
 *   db       — PostgREST answers for player_technique_rating +
 *              player_rank_state: in-domain rows (oracle: exact payload and the
 *              form-weighted rating formula), out-of-domain rows (types the
 *              table constraints forbid), and transport faults (5xx, 401/403,
 *              HTML gateway page, non-JSON 2xx, null/object bodies, fetch throw)
 *   method   — non-GET methods with random / oversized bodies on /v1/rank
 *
 * Invariants asserted on EVERY response:
 *   - status ∈ {200} for a well-formed authenticated request against a healthy
 *     backend, otherwise ∈ {400,401,403,404,405,413,415,429} for bad input;
 *     5xx is only tolerated for a deliberately injected upstream fault and
 *     must then be generic (fixed message, no stack trace, no upstream detail)
 *   - every response carries a valid `x-request-id` (echoed when the client's
 *     was valid, freshly minted otherwise)
 *   - no PostgREST / RPC write ever happens on this read route (any method)
 *   - canary strings placed in bearer/headers/query/upstream errors never
 *     appear in a response body
 *   - JSON responses carry the security headers (nosniff, no-store)
 *   - a 200 payload parses with the mobile contract (parsePlayerRank) when the
 *     upstream rows were inside the table constraints, and rating/tier/rows
 *     equal the oracle
 *   - exactly one access-log line per request, whose requestId/status match
 *
 * Knobs (env):
 *   STRESS_ITER=<n>      generated iterations (default 200; campaign: 3000+)
 *   STRESS_SEED=<n>      base seed (default 20260905); iteration seed =
 *                        mix32(base, i) — printed with every failure
 *   STRESS_REPLAY=<s,..> run only these iteration seeds (replay a failure)
 *   STRESS_OUT=<path>    write the seed → outcome JSON table here
 *
 * Replay one seed:
 *   STRESS_REPLAY=123456789 deno test -A --no-check --config deno.json \
 *     stress_route_get_v1_rank_fuzz.test.ts
 */
import { assert, assertEquals } from "@std/assert";
import { captureAccessLog } from "../http.ts";
import {
  fakeAppleIdToken,
  fakeGoogleIdToken,
  type Harness,
  loadHarness,
  SUPABASE_URL,
} from "./routesHarness.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic RNG
// ─────────────────────────────────────────────────────────────────────────────

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

/** Iteration seed from (base, index): stable across runs, well spread. */
function mix32(base: number, index: number): number {
  let h = (base ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (index + 0x7f4a7c15), 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  int(min: number, maxInclusive: number): number {
    return min + Math.floor(this.next() * (maxInclusive - min + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }
  hex(n: number): string {
    let out = "";
    for (let i = 0; i < n; i++) out += this.int(0, 15).toString(16);
    return out;
  }
  uuid(): string {
    return `${this.hex(8)}-${this.hex(4)}-4${this.hex(3)}-${
      this.pick(["8", "9", "a", "b"])
    }${this.hex(3)}-${this.hex(12)}`;
  }
  ip(): string {
    return `${this.int(1, 223)}.${this.int(0, 255)}.${this.int(0, 255)}.${
      this.int(1, 254)
    }`;
  }
  string(
    n: number,
    alphabet =
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.~:/?#[]@!$&'()*+,;=%",
  ): string {
    let out = "";
    for (let i = 0; i < n; i++) {
      out += alphabet[this.int(0, alphabet.length - 1)];
    }
    return out;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Case model
// ─────────────────────────────────────────────────────────────────────────────

type Category = "auth" | "path" | "headers" | "db" | "method";

type AuthUpstream =
  | "ok"
  | "refuse401"
  | "refuse403"
  | "http500"
  | "html502"
  | "nonjson200"
  | "throw"
  | "user_no_provider"
  | "user_no_id";

type PgrstFault =
  | "ok"
  | "http500"
  | "http503"
  | "http401"
  | "http403"
  | "html502"
  | "nonjson200"
  | "null200"
  | "object200"
  | "empty200"
  | "throw";

interface TechniqueRow {
  shot_type: unknown;
  score: unknown;
  captured_at: unknown;
  sampled_count?: unknown;
  confidence_weight?: unknown;
}

interface DbPlan {
  techniques: unknown[];
  state: unknown[];
  techniquesFault: PgrstFault;
  stateFault: PgrstFault;
  /** true when every row respects the table/view constraints. */
  inDomain: boolean;
}

interface Expectation {
  /** "ok" → must be 200; "bad" → must be ∈ BAD_INPUT_STATUSES; "upstream" →
   * 5xx allowed but must be generic (or a 200/401 verdict when the fault is
   * legitimately a verdict). */
  kind: "ok" | "bad" | "upstream";
  statuses: number[];
  /** For kind ok with in-domain rows: exact oracle payload. */
  oracle?: unknown;
  /** parsePlayerRank must accept the body. */
  parseable?: boolean;
  /** Request id the response must echo (valid client id). */
  echoRequestId?: string;
}

interface FuzzCase {
  seed: number;
  category: Category;
  desc: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | null;
  userId: string;
  ip: string;
  auth: AuthUpstream;
  db: DbPlan;
  canaries: string[];
  expect: Expectation;
}

const BAD_INPUT_STATUSES = new Set([400, 401, 403, 404, 405, 413, 415, 429]);
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GENERIC_5XX_RE =
  /^(?:[A-Za-z ]+ is temporarily unavailable\. Please try again\.|Something went wrong\. Please try again\.)$/;
const MAX_JSON_BODY_BYTES = 5_000_000;
const TECHNIQUES = [
  "dink",
  "serve",
  "drive",
  "third_shot_drop",
  "volley",
  "lob",
  "reset",
  "overhead",
] as const;
const TIERS: ReadonlyArray<{ key: string; min: number }> = [
  { key: "bronze", min: 0 },
  { key: "silver", min: 3.5 },
  { key: "gold", min: 5 },
  { key: "platinum", min: 6.5 },
  { key: "diamond", min: 7.5 },
];

const b64url = (input: string): string =>
  btoa(unescape(encodeURIComponent(input))).replace(/\+/g, "-").replace(
    /\//g,
    "_",
  ).replace(/=+$/, "");

function jwt(
  payload: unknown,
  opts: { segments?: number; badPayload?: string } = {},
): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = opts.badPayload ?? b64url(JSON.stringify(payload));
  const sig = "sig-" + b64url("x".repeat(16));
  const parts = [header, body, sig];
  if (opts.segments !== undefined) {
    while (parts.length > opts.segments) parts.pop();
    while (parts.length < opts.segments) parts.push("extra");
  }
  return parts.join(".");
}

const nowSec = () => Math.floor(Date.now() / 1000);

function sessionToken(
  userId: string,
  rng: Rng,
  mutate: Record<string, unknown> = {},
): string {
  return jwt({
    iss: "https://ucqnaiwq-test.supabase.test/auth/v1",
    sub: userId,
    aud: "authenticated",
    role: "authenticated",
    exp: nowSec() + 3600,
    session_id: rng.uuid(),
    ...mutate,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Oracle (mirrors the documented formula; computed independently here)
// ─────────────────────────────────────────────────────────────────────────────

function tierFor(rating: number): string {
  let current = TIERS[0]!.key;
  for (const tier of TIERS) if (rating >= tier.min) current = tier.key;
  return current;
}

interface DomainTechnique {
  shot_type: string;
  score: number;
  captured_at: string;
  sampled_count: number;
  confidence_weight: number;
}

interface DomainState {
  rating: number;
  tier: string;
  technique_count: number;
  scored_shot_count: number;
  updated_at: string;
}

function oraclePayload(
  techniques: DomainTechnique[],
  state: DomainState | null,
): unknown {
  if (techniques.length === 0) return { rank: null };
  const sorted = [...techniques].sort((a, b) =>
    b.score - a.score || (a.shot_type < b.shot_type ? -1 : 1)
  );
  let rating: number;
  let tier: string;
  let scoredShotCount: number | null;
  let updatedAt: string | null;
  if (state) {
    rating = state.rating;
    tier = state.tier;
    scoredShotCount = state.scored_shot_count;
    updatedAt = state.updated_at;
  } else {
    let weightSum = 0;
    let hundredths = 0;
    for (const t of sorted) {
      const w = t.confidence_weight >= 1
        ? t.confidence_weight
        : Math.min(Math.max(t.sampled_count, 1), 5);
      weightSum += w;
      hundredths += w * Math.round(t.score * 100);
    }
    rating = Math.round(hundredths / weightSum) / 100;
    tier = tierFor(rating);
    scoredShotCount = null;
    updatedAt = null;
  }
  return {
    rank: {
      rating,
      tier,
      techniqueCount: sorted.length,
      scoredShotCount,
      updatedAt,
      techniques: sorted.map((t) => ({
        shot_type: t.shot_type,
        score: t.score,
        captured_at: t.captured_at,
        sampled_count: t.sampled_count,
      })),
    },
  };
}

/** apps/mobile/src/progress/playerRank.ts parsePlayerRank, transcribed. */
function mobileParses(payload: unknown): boolean {
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    Boolean(v) && typeof v === "object" && !Array.isArray(v);
  const finite = (v: unknown): number | null => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  if (!isRecord(payload) || !("rank" in payload)) return false;
  const rank = payload.rank;
  if (rank === null) return true;
  if (!isRecord(rank) || !Array.isArray(rank.techniques)) return false;
  const rating = finite(rank.rating);
  const techniqueCount = finite(rank.techniqueCount);
  if (
    rating === null || rating < 0 || rating > 10 || techniqueCount === null ||
    typeof rank.tier !== "string"
  ) {
    return false;
  }
  for (const row of rank.techniques) {
    if (!isRecord(row)) return false;
    if (
      typeof row.shot_type !== "string" || finite(row.score) === null ||
      typeof row.captured_at !== "string"
    ) {
      return false;
    }
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Generators
// ─────────────────────────────────────────────────────────────────────────────

function domainTechniques(rng: Rng): DomainTechnique[] {
  const count = rng.int(0, TECHNIQUES.length);
  const types = [...TECHNIQUES].sort(() => rng.float() - 0.5).slice(0, count);
  return types.map((shot_type) => {
    const sampled = rng.int(1, 8);
    const total = sampled + rng.int(0, 20);
    return {
      shot_type,
      score: rng.chance(0.5) ? rng.int(0, 100) / 10 : rng.int(0, 1000) / 100,
      captured_at: new Date(Date.UTC(2026, 0, 1) + rng.int(0, 200 * 86_400_000))
        .toISOString(),
      sampled_count: sampled,
      confidence_weight: Math.min(total, 5),
    };
  });
}

function domainState(
  rng: Rng,
  techniques: DomainTechnique[],
): DomainState | null {
  if (techniques.length === 0 || rng.chance(0.5)) return null;
  const rating = rng.int(0, 1000) / 100;
  return {
    rating,
    tier: tierFor(rating),
    technique_count: techniques.length,
    scored_shot_count: rng.int(techniques.length, 200),
    updated_at: new Date(Date.UTC(2026, 5, 1) + rng.int(0, 50 * 86_400_000))
      .toISOString(),
  };
}

const JUNK_VALUES: readonly unknown[] = [
  null,
  undefined,
  "",
  "abc",
  "7.5",
  "NaN",
  "1e308",
  -1,
  0,
  10.001,
  99,
  1e308,
  -1e308,
  1e-320,
  true,
  false,
  [],
  [1, 2],
  {},
  { nested: { deep: true } },
  "\u0000",
  "𝔘𝔫𝔦𝔠𝔬𝔡𝔢",
  "<script>alert(1)</script>",
  "' or 1=1 --",
];

function junkTechniques(rng: Rng, canary: string): unknown[] {
  const kind = rng.int(0, 5);
  if (kind === 0) {
    return Array.from({ length: rng.int(1000, 3000) }, (_, i) => ({
      shot_type: `t${i}`,
      score: rng.int(0, 1000) / 100,
      captured_at: "2026-01-01T00:00:00.000Z",
      sampled_count: 3,
      confidence_weight: 3,
    }));
  }
  if (kind === 1) return [rng.pick(JUNK_VALUES), rng.pick(JUNK_VALUES)];
  const rows: TechniqueRow[] = [];
  for (let i = 0; i < rng.int(1, 6); i++) {
    const row: TechniqueRow = {
      shot_type: rng.chance(0.3) ? rng.pick(JUNK_VALUES) : rng.pick(TECHNIQUES),
      score: rng.chance(0.4) ? rng.pick(JUNK_VALUES) : rng.int(0, 1000) / 100,
      captured_at: rng.chance(0.3)
        ? rng.pick(JUNK_VALUES)
        : "2026-02-02T02:02:02.000Z",
    };
    if (rng.chance(0.7)) {
      row.sampled_count = rng.chance(0.4)
        ? rng.pick(JUNK_VALUES)
        : rng.int(1, 8);
    }
    if (rng.chance(0.7)) {
      row.confidence_weight = rng.chance(0.4)
        ? rng.pick(JUNK_VALUES)
        : rng.int(1, 5);
    }
    if (rng.chance(0.2)) {
      (row as unknown as Record<string, unknown>)[`extra_${canary}`] =
        "extra-column";
    }
    rows.push(row);
  }
  if (kind === 5) rows.push(rows[0]!); // duplicate shot_type
  return rows;
}

function junkState(rng: Rng, canary: string): unknown[] {
  if (rng.chance(0.2)) return [rng.pick(JUNK_VALUES)];
  return [{
    rating: rng.chance(0.6) ? rng.pick(JUNK_VALUES) : rng.int(0, 1000) / 100,
    tier: rng.chance(0.5) ? rng.pick(JUNK_VALUES) : rng.pick(TIERS).key,
    technique_count: rng.pick(JUNK_VALUES),
    scored_shot_count: rng.pick(JUNK_VALUES),
    updated_at: rng.chance(0.5) ? rng.pick(JUNK_VALUES) : "not-a-timestamp",
    [`extra_${canary}`]: "extra-column",
  }];
}

/** Random-campaign faults. `throw` and `http503` are excluded here because
 * postgrest-js retries them with a 1s+2s+4s backoff (7 s per request) — they
 * get a dedicated, timed test below instead. */
const PGRST_FAULTS: readonly PgrstFault[] = [
  "http500",
  "http401",
  "http403",
  "html502",
  "nonjson200",
  "null200",
  "object200",
  "empty200",
];

function healthyDb(rng: Rng): DbPlan {
  const techniques = domainTechniques(rng);
  const state = domainState(rng, techniques);
  return {
    techniques,
    state: state ? [state] : [],
    techniquesFault: "ok",
    stateFault: "ok",
    inDomain: true,
  };
}

function validRequestHeaders(
  token: string,
  ip: string,
): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "x-forwarded-for": ip,
    accept: "application/json",
  };
}

const PUBLIC_SUFFIXES = ["/healthz", "/support", "/privacy", "/terms"];

/** What the router should do with `method` + `pathname` (already URL-normalized). */
function routeExpectation(
  method: string,
  pathname: string,
): "rank" | "public" | "other" {
  if (
    (method === "GET" || method === "HEAD") &&
    PUBLIC_SUFFIXES.some((s) => pathname.endsWith(s))
  ) {
    return "public";
  }
  const v1 = pathname.lastIndexOf("/v1/");
  const path = v1 >= 0 ? pathname.slice(v1) : pathname;
  return method === "GET" && path === "/v1/rank" ? "rank" : "other";
}

function genCase(seed: number): FuzzCase {
  const rng = new Rng(seed);
  const userId = rng.uuid();
  const ip = rng.ip();
  const canary = `CANARY${seed.toString(36)}${rng.hex(6)}`;
  const category: Category = rng.pick<Category>([
    "auth",
    "auth",
    "path",
    "path",
    "headers",
    "headers",
    "db",
    "db",
    "db",
    "method",
  ]);
  const base: Omit<
    FuzzCase,
    "desc" | "method" | "path" | "headers" | "body" | "expect" | "auth" | "db"
  > = {
    seed,
    category,
    userId,
    ip,
    canaries: [canary],
  };
  const validToken = rng.chance(0.5)
    ? fakeGoogleIdToken(userId)
    : fakeAppleIdToken(userId);

  if (category === "auth") return genAuthCase(rng, base, canary);
  if (category === "path") return genPathCase(rng, base, canary, validToken);
  if (category === "headers") {
    return genHeaderCase(rng, base, canary, validToken);
  }
  if (category === "db") return genDbCase(rng, base, canary, validToken);
  return genMethodCase(rng, base, canary, validToken);
}

type Base = Omit<
  FuzzCase,
  "desc" | "method" | "path" | "headers" | "body" | "expect" | "auth" | "db"
>;

function finish(
  base: Base,
  fields: Pick<
    FuzzCase,
    "desc" | "method" | "path" | "headers" | "body" | "expect" | "auth" | "db"
  >,
): FuzzCase {
  return { ...base, ...fields };
}

function genAuthCase(rng: Rng, base: Base, canary: string): FuzzCase {
  const db = healthyDb(new Rng(base.seed ^ 0x5bd1e995));
  const ok = (auth: AuthUpstream = "ok"): Expectation => ({
    kind: "ok",
    statuses: [200],
    oracle: oraclePayload(
      db.techniques as DomainTechnique[],
      (db.state[0] as DomainState | undefined) ?? null,
    ),
    parseable: true,
    ...(auth === "ok" ? {} : {}),
  });
  const bad: Expectation = { kind: "bad", statuses: [401] };
  const upstream: Expectation = { kind: "upstream", statuses: [503] };
  const variant = rng.int(0, 27);
  let authorization: string | null;
  let desc: string;
  let expect: Expectation = bad;
  let auth: AuthUpstream = "ok";
  const uid = base.userId;
  switch (variant) {
    case 0:
      authorization = null;
      desc = "no Authorization header";
      break;
    case 1:
      authorization = "";
      desc = "empty Authorization";
      break;
    case 2:
      authorization = "Bearer";
      desc = "Bearer without token";
      break;
    case 3:
      authorization = "Bearer ";
      desc = "Bearer with only a space";
      break;
    case 4:
      authorization = `bearer ${fakeGoogleIdToken(uid)}`;
      desc = "lowercase bearer scheme";
      break;
    case 5:
      authorization = `Basic ${b64url(`${canary}:${canary}`)}`;
      desc = "Basic scheme";
      break;
    case 6:
      authorization = `Bearer ${canary}${rng.string(rng.int(0, 200))}`;
      desc = "opaque non-JWT token";
      break;
    case 7:
      authorization = `Bearer ${
        jwt({
          iss: "https://accounts.google.com",
          sub: uid,
          exp: nowSec() + 60,
        }, { segments: rng.pick([1, 2, 4, 5]) })
      }`;
      desc = "JWT with wrong segment count";
      break;
    case 8:
      authorization = `Bearer ${
        jwt(null, { badPayload: "!!not-base64!!" + canary })
      }`;
      desc = "JWT payload not base64";
      break;
    case 9:
      authorization = `Bearer ${
        jwt(null, { badPayload: b64url("{not json" + canary) })
      }`;
      desc = "JWT payload not JSON";
      break;
    case 10:
      authorization = `Bearer ${
        jwt(rng.pick([null, 42, "str", [1, 2], true]))
      }`;
      desc = "JWT payload JSON but not an object";
      break;
    case 11:
      authorization = `Bearer ${
        jwt({ iss: canary, sub: uid, exp: nowSec() + 60 })
      }`;
      desc = "unknown issuer";
      break;
    case 12:
      authorization = `Bearer ${
        jwt({
          iss: rng.pick([null, 12, ["accounts.google.com"], { v: 1 }]),
          sub: uid,
          exp: nowSec() + 60,
        })
      }`;
      desc = "issuer with a non-string type";
      break;
    case 13:
      authorization = `Bearer ${
        jwt({
          iss: rng.pick([
            "https://accounts.google.com",
            "accounts.google.com",
            "https://appleid.apple.com",
          ]),
          sub: uid,
          exp: nowSec() - rng.int(1, 100_000),
        })
      }`;
      desc = "expired provider token";
      break;
    case 14:
      authorization = `Bearer ${
        jwt({
          iss: "https://accounts.google.com",
          sub: uid,
          exp: rng.pick([
            "9999999999",
            String(nowSec() - 10),
            "abc",
            null,
            true,
            [nowSec() + 60],
          ]),
        })
      }`;
      desc =
        "provider token with non-numeric exp (passes exp check, verified upstream)";
      expect = ok();
      break;
    case 15:
      authorization = `Bearer ${
        jwt({
          iss: "https://accounts.google.com",
          sub: uid,
          exp: rng.pick([Number.MAX_SAFE_INTEGER, 1e300, 4102444800]),
        })
      }`;
      desc = "provider token with a far-future/huge exp";
      expect = ok();
      break;
    case 16:
      authorization = `Bearer ${
        jwt({
          iss: "https://accounts.google.com",
          sub: uid,
          exp: nowSec() + 3600,
          pad: "x".repeat(rng.int(20_000, 120_000)),
        })
      }`;
      desc = "provider token with a 20-120 KB payload";
      expect = ok();
      break;
    case 17:
      authorization = `Bearer ${
        jwt({
          iss: "https://accounts.google.com",
          sub: uid,
          exp: nowSec() + 3600,
          [canary]: canary,
          nbf: "soon",
          aud: [1, 2, 3],
        })
      }`;
      desc = "provider token with junk extra claims";
      expect = ok();
      break;
    case 18:
      authorization = `Bearer ${
        jwt({
          iss: "https://appleid.apple.com",
          sub: uid,
          exp: nowSec() + 3600,
        })
      }`;
      desc = "valid Apple provider token";
      expect = ok();
      break;
    case 19:
      authorization = `Bearer ${sessionToken(uid, rng)}`;
      desc = "valid Supabase session token, GoTrue ok";
      expect = ok();
      break;
    case 20:
      authorization = `Bearer ${sessionToken(uid, rng)}`;
      auth = rng.pick<AuthUpstream>(["refuse401", "refuse403"]);
      desc = `Supabase session token, GoTrue ${auth}`;
      break;
    case 21:
      authorization = `Bearer ${sessionToken(uid, rng)}`;
      auth = rng.pick<AuthUpstream>(["http500", "html502", "nonjson200"]);
      desc = `Supabase session token, GoTrue ${auth}`;
      expect = upstream;
      break;
    case 22:
      authorization = `Bearer ${sessionToken(uid, rng)}`;
      auth = rng.pick<AuthUpstream>(["user_no_provider", "user_no_id"]);
      desc = `Supabase session token, GoTrue user ${auth}`;
      expect = auth === "user_no_provider" ? bad : upstream;
      break;
    case 23:
      authorization = `Bearer ${
        sessionToken(uid, rng, { exp: nowSec() - rng.int(1, 999_999) })
      }`;
      desc = "expired Supabase session token";
      break;
    case 24:
      authorization = `Bearer ${
        sessionToken(uid, rng, {
          session_id: rng.pick([null, 7, "", ["a"], { x: 1 }]),
        })
      }`;
      desc = "Supabase session token with a non-string session_id";
      expect = ok();
      break;
    case 25:
      authorization = `Bearer ${
        jwt({
          iss: "https://evil.example/auth/v1/../",
          sub: uid,
          exp: nowSec() + 3600,
        })
      }`;
      desc = "issuer that merely contains /auth/v1";
      break;
    case 26:
      authorization = `Bearer  ${fakeGoogleIdToken(uid)}`;
      desc = "two spaces after Bearer (trimmed by bearerOf)";
      expect = ok();
      break;
    default:
      authorization = `Bearer ${sessionToken(uid, rng)}`;
      auth = "throw";
      desc = "Supabase session token, GoTrue socket fault";
      expect = upstream;
      break;
  }
  if (auth === "throw" && rng.chance(0.66)) {
    // The transitional provider-token branch under the same outage classes.
    auth = rng.pick<AuthUpstream>(["throw", "http500"]);
    authorization = `Bearer ${fakeGoogleIdToken(uid)}`;
    desc = `provider token, GoTrue ${
      auth === "throw" ? "socket fault" : "HTTP 500"
    }`;
    expect = upstream;
  }
  if (
    rng.chance(0.15) && expect.kind === "bad" && variant !== 20 &&
    variant !== 22 && variant !== 23
  ) {
    auth = rng.pick<AuthUpstream>(["http500", "throw"]);
    desc += " (+ upstream fault that must not be reached)";
  }
  const headers: Record<string, string> = {
    "x-forwarded-for": base.ip,
    accept: "application/json",
  };
  if (authorization !== null) headers.authorization = authorization;
  return finish(base, {
    desc,
    method: "GET",
    path: "/v1/rank",
    headers,
    body: null,
    auth,
    db,
    expect,
  });
}

function genPathCase(
  rng: Rng,
  base: Base,
  canary: string,
  token: string,
): FuzzCase {
  const db = healthyDb(new Rng(base.seed ^ 0x5bd1e995));
  const okPayload = oraclePayload(
    db.techniques as DomainTechnique[],
    (db.state[0] as DomainState | undefined) ?? null,
  );
  const variant = rng.int(0, 21);
  let path: string;
  let method = "GET";
  switch (variant) {
    case 0:
      path = "/v1/rank";
      break;
    case 1:
      path = "/functions/v1/api/v1/rank";
      break;
    case 2:
      path = "/api/v1/rank";
      break;
    case 3:
      path = `/v1/rank?${rng.string(rng.int(1, 40), "abcxyz=&%")}=${
        encodeURIComponent(canary)
      }`;
      break;
    case 4:
      path = `/v1/rank?q=${"a".repeat(rng.int(10_000, 60_000))}`;
      break;
    case 5:
      path = "/v1/rank/";
      break;
    case 6:
      path = `/v1/rank/${encodeURIComponent(canary)}`;
      break;
    case 7:
      path = "/v1/RANK";
      break;
    case 8:
      path = "/v1/rank%2F";
      break;
    case 9:
      path = "/v1/rank%";
      break;
    case 10:
      path = `/v1/${rng.pick(["ran%6b", "r%61nk", "%72ank"])}`;
      break;
    case 11:
      path = "/v1//rank";
      break;
    case 12:
      path = "/v1/rank/../rank";
      break;
    case 13:
      path = `/v1/rank/../${
        rng.pick(["healthz", "support", "privacy", "terms"])
      }`;
      break;
    case 14:
      path = "/v1/rank#frag";
      break;
    case 15:
      path = `/v1/${
        rng.string(rng.int(1, 30), "abcdefghijklmnopqrstuvwxyz-_")
      }`;
      break;
    case 16:
      path = "/v2/rank";
      break;
    case 17:
      path = "/rank";
      break;
    case 18:
      path = `/${"v1/".repeat(rng.int(2, 30))}rank`;
      break;
    case 19:
      path = `/v1/rank/${"x".repeat(rng.int(2_000, 30_000))}`;
      break;
    case 20:
      path = `/v1/rank?${encodeURIComponent(canary)}=${
        "%zz".repeat(rng.int(1, 5))
      }`;
      break;
    default:
      method = rng.pick(["HEAD", "OPTIONS", "TRACE"]);
      path = "/v1/rank";
      break;
  }
  const url = new URL(`http://edge.test${path}`);
  const kind = routeExpectation(method, url.pathname);
  const expect: Expectation = kind === "rank"
    ? { kind: "ok", statuses: [200], oracle: okPayload, parseable: true }
    : kind === "public"
    ? { kind: "ok", statuses: [200] }
    : { kind: "bad", statuses: [404, 400, 405] };
  return finish(base, {
    desc: `${method} ${
      path.length > 80 ? path.slice(0, 77) + "..." : path
    } (${kind})`,
    method,
    path,
    headers: validRequestHeaders(token, base.ip),
    body: null,
    auth: "ok",
    db,
    expect,
  });
}

function genHeaderCase(
  rng: Rng,
  base: Base,
  canary: string,
  token: string,
): FuzzCase {
  const db = healthyDb(new Rng(base.seed ^ 0x5bd1e995));
  const okPayload = oraclePayload(
    db.techniques as DomainTechnique[],
    (db.state[0] as DomainState | undefined) ?? null,
  );
  const headers = validRequestHeaders(token, base.ip);
  const expect: Expectation = {
    kind: "ok",
    statuses: [200],
    oracle: okPayload,
    parseable: true,
  };
  const variant = rng.int(0, 13);
  let desc: string;
  switch (variant) {
    case 0: {
      const id = rng.string(
        rng.int(8, 64),
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-",
      );
      headers["x-request-id"] = id;
      expect.echoRequestId = id;
      desc = "valid client x-request-id (must be echoed)";
      break;
    }
    case 1:
      headers["x-request-id"] = rng.pick([
        "short",
        "x".repeat(65),
        "x".repeat(rng.int(65, 5000)),
        `${canary} ${canary}`,
        `${canary}/../..`,
        "ünïcödé-request-id",
        "",
        "        ",
      ]);
      desc = "invalid client x-request-id (must be replaced)";
      break;
    case 2:
      headers["x-forwarded-for"] = rng.pick([
        "",
        ",,,",
        `${canary}`,
        "999.999.999.999",
        "::1",
        "2001:db8::1, 10.0.0.1",
        Array.from({ length: rng.int(50, 400) }, () => rng.ip()).join(", "),
        "x".repeat(rng.int(10_000, 30_000)),
      ]);
      desc = "junk x-forwarded-for";
      break;
    case 3:
      headers["cf-connecting-ip"] = rng.pick([
        "",
        canary,
        "0.0.0.0",
        "300.1.1.1",
        "\t",
        "1.1.1.1, 2.2.2.2",
      ]);
      desc = "junk cf-connecting-ip";
      break;
    case 4:
      headers["content-length"] = String(
        rng.pick([-1, 0, 1, 4_999_999, 5_000_000]),
      );
      desc = "content-length at/below the cap on a GET";
      break;
    case 5:
      headers["content-length"] = rng.pick([
        "abc",
        "1e3",
        "0x10",
        "",
        " ",
        "NaN",
        "Infinity",
        "-Infinity",
      ]);
      desc = "non-numeric content-length";
      break;
    case 6:
      headers["content-length"] = String(
        rng.pick([5_000_001, 6_000_000, Number.MAX_SAFE_INTEGER, 1e308]),
      );
      expect.kind = "bad";
      expect.statuses = [413];
      delete expect.oracle;
      delete expect.parseable;
      desc = "content-length above the cap → 413 before auth";
      break;
    case 7:
      headers["content-type"] = rng.pick([
        "text/html",
        "application/x-www-form-urlencoded",
        canary,
        "multipart/form-data; boundary=" + canary,
        "application/json; charset=" + rng.string(50),
      ]);
      desc = "odd content-type on a GET";
      break;
    case 8:
      headers["accept"] = rng.pick([
        "text/html",
        "*/*",
        "application/xml",
        canary,
        "",
        "application/json;q=0",
      ]);
      desc = "odd accept";
      break;
    case 9:
      for (let i = 0; i < rng.int(20, 80); i++) {
        headers[`x-fuzz-${i}-${rng.string(6, "abcdefghij")}`] = rng.string(
          rng.int(0, 200),
          "abcdefghijklmnopqrstuvwxyz0123456789 ,;=/",
        );
      }
      desc = "20-80 extra headers";
      break;
    case 10:
      headers[`x-${canary}`] = "v".repeat(rng.int(60_000, 120_000));
      desc = "60-120 KB header value";
      break;
    case 11:
      headers["x-request-id"] = `${canary}-${rng.hex(8)}`;
      expect.echoRequestId = headers["x-request-id"];
      desc =
        "valid x-request-id carrying the canary (echo in header only, never body)";
      break;
    case 12:
      headers["host"] = canary + ".evil.example";
      headers["origin"] = "https://" + canary;
      headers["referer"] = "https://" + canary + "/" + canary;
      desc = "junk host/origin/referer";
      break;
    default:
      headers["accept-encoding"] = rng.pick([
        "gzip",
        "br, gzip",
        canary,
        "identity;q=0",
      ]);
      headers["if-none-match"] = `"${canary}"`;
      headers["range"] = "bytes=0-1";
      desc = "conditional/range/encoding headers";
      break;
  }
  return finish(base, {
    desc,
    method: "GET",
    path: "/v1/rank",
    headers,
    body: null,
    auth: "ok",
    db,
    expect,
  });
}

function genDbCase(
  rng: Rng,
  base: Base,
  canary: string,
  token: string,
): FuzzCase {
  const roll = rng.float();
  let db: DbPlan;
  let expect: Expectation;
  let desc: string;
  if (roll < 0.45) {
    db = healthyDb(rng);
    const state = (db.state[0] as DomainState | undefined) ?? null;
    expect = {
      kind: "ok",
      statuses: [200],
      oracle: oraclePayload(db.techniques as DomainTechnique[], state),
      parseable: true,
    };
    desc = `in-domain rows: ${db.techniques.length} techniques, state ${
      state ? "present" : "absent"
    }`;
  } else if (roll < 0.75) {
    const techniques = rng.chance(0.85)
      ? junkTechniques(rng, canary)
      : domainTechniques(rng);
    const state = rng.chance(0.7) ? junkState(rng, canary) : [];
    db = {
      techniques,
      state,
      techniquesFault: "ok",
      stateFault: "ok",
      inDomain: false,
    };
    expect = { kind: "upstream", statuses: [200, 500] };
    desc = `out-of-domain rows (${techniques.length} technique rows, state ${
      state.length ? "junk" : "absent"
    })`;
  } else {
    const healthy = healthyDb(rng);
    const which = rng.pick(["techniques", "state", "both"] as const);
    const fault = rng.pick(PGRST_FAULTS);
    const fault2 = rng.pick(PGRST_FAULTS);
    db = {
      ...healthy,
      techniquesFault: which === "state" ? "ok" : fault,
      stateFault: which === "techniques"
        ? "ok"
        : which === "both"
        ? fault2
        : fault,
    };
    expect = { kind: "upstream", statuses: [200, 500, 503] };
    desc =
      `PostgREST fault techniques=${db.techniquesFault} state=${db.stateFault}`;
  }
  return finish(base, {
    desc,
    method: "GET",
    path: "/v1/rank",
    headers: validRequestHeaders(token, base.ip),
    body: null,
    auth: "ok",
    db,
    expect,
  });
}

function genMethodCase(
  rng: Rng,
  base: Base,
  canary: string,
  token: string,
): FuzzCase {
  const db = healthyDb(new Rng(base.seed ^ 0x5bd1e995));
  const method = rng.pick([
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS",
    "PROPFIND",
    "PURGE",
  ]);
  const bodyKind = rng.int(0, 6);
  let body: string | null;
  switch (bodyKind) {
    case 0:
      body = null;
      break;
    case 1:
      body = JSON.stringify({ [canary]: canary, rating: 10, tier: "diamond" });
      break;
    case 2:
      body = "{not json" + canary;
      break;
    case 3:
      body = rng.string(rng.int(1, 5000));
      break;
    case 4:
      body = "[" + "1,".repeat(rng.int(1000, 50_000)) + "1]";
      break;
    case 5:
      body = "\u0000\u0001\u0002" + canary;
      break;
    default:
      body = "x".repeat(rng.int(100_000, 400_000));
      break;
  }
  const headers = validRequestHeaders(token, base.ip);
  if (rng.chance(0.5)) {
    headers["content-type"] = rng.pick([
      "application/json",
      "text/plain",
      canary,
    ]);
  }
  let expect: Expectation = { kind: "bad", statuses: [404, 405] };
  if (rng.chance(0.2)) {
    headers["content-length"] = String(
      rng.int(MAX_JSON_BODY_BYTES + 1, MAX_JSON_BODY_BYTES * 3),
    );
    expect = { kind: "bad", statuses: [413] };
  }
  return finish(base, {
    desc: `${method} /v1/rank with body kind ${bodyKind}${
      headers["content-length"] ? " + oversized content-length" : ""
    }`,
    method,
    path: "/v1/rank",
    headers,
    body,
    auth: "ok",
    db,
    expect,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Upstream fault injection layered over routesHarness's fetch stub
// ─────────────────────────────────────────────────────────────────────────────

interface Upstream {
  auth: AuthUpstream;
  db: DbPlan;
  userId: string;
  canary: string;
}

let current: Upstream | null = null;

function faultResponse(
  fault: PgrstFault,
  canary: string,
  list: boolean,
): Response | "throw" | null {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  switch (fault) {
    case "ok":
      return null;
    case "http500":
      return json(500, {
        code: "XX000",
        message: `internal error ${canary} at line 42`,
        details: canary,
        hint: null,
      });
    case "http503":
      return json(503, {
        code: "PGRST001",
        message: `could not connect to database ${canary}`,
      });
    case "http401":
      return json(401, {
        code: "PGRST301",
        message: `JWT expired ${canary}`,
        details: null,
        hint: null,
      });
    case "http403":
      return json(403, {
        code: "42501",
        message: `permission denied for view player_technique_rating ${canary}`,
      });
    case "html502":
      return new Response(
        `<html><body>502 Bad Gateway ${canary}</body></html>`,
        {
          status: 502,
          headers: { "Content-Type": "text/html" },
        },
      );
    case "nonjson200":
      return new Response(`garbage ${canary}`, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    case "null200":
      return json(200, null);
    case "object200":
      return json(
        200,
        list ? { unexpected: canary } : [{ rating: 1 }, { rating: 2 }],
      );
    case "empty200":
      return new Response("", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    case "throw":
      return "throw";
  }
}

/** Wraps the harness fetch with fault injection; the returned function
 * restores it. The suite runs every module in one isolate, so nothing here may
 * outlive the test that installed it. */
function installUpstream(h: Harness): () => void {
  const stub = globalThis.fetch;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = request.url;
    const plan = current;
    if (plan && url.startsWith(`${SUPABASE_URL}/auth/v1/user`)) {
      h.calls.push({ url, method: request.method, headers: {}, body: null });
      switch (plan.auth) {
        case "ok":
        case "user_no_provider":
        case "user_no_id": {
          const user: Record<string, unknown> = {
            id: plan.auth === "user_no_id" ? "" : plan.userId,
            aud: "authenticated",
            email: "user@example.com",
            app_metadata: plan.auth === "user_no_provider"
              ? { provider: "email", providers: ["email"] }
              : { provider: "google", providers: ["google"] },
          };
          return new Response(JSON.stringify(user), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        case "refuse401":
          return new Response(
            JSON.stringify({ code: 401, msg: `invalid JWT ${plan.canary}` }),
            { status: 401 },
          );
        case "refuse403":
          return new Response(
            JSON.stringify({
              code: 403,
              msg: `session not found ${plan.canary}`,
            }),
            { status: 403 },
          );
        case "http500":
          return new Response(
            JSON.stringify({ code: 500, msg: `boom ${plan.canary}` }),
            { status: 500 },
          );
        case "html502":
          return new Response(`<html>502 ${plan.canary}</html>`, {
            status: 502,
            headers: { "Content-Type": "text/html" },
          });
        case "nonjson200":
          return new Response(`not json ${plan.canary}`, { status: 200 });
        case "throw":
          throw new TypeError(`connection refused ${plan.canary}`);
      }
    }
    if (
      plan && url.startsWith(`${SUPABASE_URL}/auth/v1/token`) &&
      plan.auth === "throw"
    ) {
      h.calls.push({ url, method: request.method, headers: {}, body: null });
      throw new TypeError(`connection refused ${plan.canary}`);
    }
    if (
      plan && url.startsWith(`${SUPABASE_URL}/auth/v1/token`) &&
      plan.auth === "http500"
    ) {
      h.calls.push({ url, method: request.method, headers: {}, body: null });
      return new Response(
        JSON.stringify({ code: 500, msg: `boom ${plan.canary}` }),
        { status: 500 },
      );
    }
    if (plan && url.startsWith(`${SUPABASE_URL}/rest/v1/`)) {
      const table = new URL(url).pathname.slice("/rest/v1/".length);
      const fault = table === "player_technique_rating"
        ? plan.db.techniquesFault
        : table === "player_rank_state"
        ? plan.db.stateFault
        : "ok";
      const injected = faultResponse(
        fault,
        plan.canary,
        table === "player_technique_rating",
      );
      if (injected === "throw") {
        h.calls.push({
          url,
          method: request.method,
          headers: {},
          body: null,
        });
        throw new TypeError(`connection reset ${plan.canary}`);
      }
      if (injected) {
        h.calls.push({
          url,
          method: request.method,
          headers: {},
          body: null,
        });
        return injected;
      }
    }
    return await stub(input, init);
  }) as typeof fetch;
  return () => {
    current = null;
    globalThis.fetch = stub;
  };
}

/** Short GoTrue deadline (session-token socket faults retry inside it) for the
 * duration of one test only — restored afterwards, whatever happens. */
async function withStressUpstream<T>(
  h: Harness,
  fn: () => Promise<T>,
): Promise<T> {
  const previousTimeout = Deno.env.get("AUTH_UPSTREAM_TIMEOUT_MS");
  Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", "250");
  const uninstall = installUpstream(h);
  try {
    return await fn();
  } finally {
    uninstall();
    if (previousTimeout === undefined) {
      Deno.env.delete("AUTH_UPSTREAM_TIMEOUT_MS");
    } else Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", previousTimeout);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution + verdict
// ─────────────────────────────────────────────────────────────────────────────

interface Outcome {
  seed: number;
  category: Category;
  desc: string;
  method: string;
  path: string;
  expect: string;
  status: number | null;
  requestId: string | null;
  ms: number;
  verdict: "HELD" | "BROKEN" | "UNCONSTRUCTIBLE";
  violations: string[];
  notes: string[];
  pgrstReads: number;
  authCalls: number;
  writes: number;
  bodyBytes: number;
  handlerErrors: number;
}

interface Captured {
  accessLines: string[];
  errorLines: string[];
}

function buildRequest(c: FuzzCase): Request | null {
  try {
    const init: RequestInit = { method: c.method, headers: c.headers };
    if (c.body !== null && c.method !== "GET" && c.method !== "HEAD") {
      init.body = c.body;
    }
    return new Request(`http://edge.test${c.path}`, init);
  } catch {
    return null;
  }
}

async function runCase(
  h: Harness,
  c: FuzzCase,
  cap: Captured,
): Promise<Outcome> {
  const request = buildRequest(c);
  const out: Outcome = {
    seed: c.seed,
    category: c.category,
    desc: c.desc,
    method: c.method,
    path: c.path.length > 200 ? c.path.slice(0, 197) + "..." : c.path,
    expect: `${c.expect.kind}:${c.expect.statuses.join("|")}`,
    status: null,
    requestId: null,
    ms: 0,
    verdict: "HELD",
    violations: [],
    notes: [],
    pgrstReads: 0,
    authCalls: 0,
    writes: 0,
    bodyBytes: 0,
    handlerErrors: 0,
  };
  if (!request) {
    out.verdict = "UNCONSTRUCTIBLE";
    out.notes.push(
      "Request constructor rejected the generated headers/body (never reaches the handler)",
    );
    return out;
  }
  h.reset();
  h.tables.player_technique_rating = c.db.techniques;
  h.tables.player_rank_state = c.db.state;
  current = {
    auth: c.auth,
    db: c.db,
    userId: c.userId,
    canary: c.canaries[0]!,
  };
  cap.accessLines.length = 0;
  cap.errorLines.length = 0;
  const started = performance.now();
  let response: Response;
  try {
    response = await h.handler(request);
  } catch (error) {
    out.verdict = "BROKEN";
    out.violations.push(
      `handler threw: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    out.ms = performance.now() - started;
    return out;
  }
  out.ms = performance.now() - started;
  const text = await response.text();
  out.status = response.status;
  out.bodyBytes = text.length;
  out.handlerErrors = cap.errorLines.length;
  out.requestId = response.headers.get("x-request-id");
  out.pgrstReads =
    h.calls.filter((call) =>
      call.url.includes("/rest/v1/") && call.method === "GET"
    ).length;
  out.authCalls =
    h.calls.filter((call) => call.url.includes("/auth/v1/")).length;
  out.writes =
    h.calls.filter((call) =>
      call.url.includes("/rest/v1/") && !["GET", "HEAD"].includes(call.method)
    ).length;
  const v = out.violations;

  // request id
  if (!out.requestId || !REQUEST_ID_RE.test(out.requestId)) {
    v.push(`x-request-id missing/invalid: ${out.requestId}`);
  }
  const clientId = c.headers["x-request-id"];
  if (c.expect.echoRequestId && out.requestId !== c.expect.echoRequestId) {
    v.push(`valid client x-request-id not echoed (got ${out.requestId})`);
  }
  if (
    clientId !== undefined && !REQUEST_ID_RE.test(clientId) && out.requestId &&
    !UUID_V4_RE.test(out.requestId)
  ) {
    v.push(
      `invalid client x-request-id was not replaced by a fresh uuid: ${out.requestId}`,
    );
  }

  // writes
  if (out.writes > 0) {
    v.push(`${out.writes} PostgREST write(s) on a read route`);
  }

  // body / headers shape
  let parsed: unknown = undefined;
  let jsonBody = false;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
      jsonBody = true;
    } catch {
      jsonBody = false;
    }
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (jsonBody) {
    if (!contentType.includes("application/json")) {
      v.push(
        `JSON body without application/json content-type (${contentType})`,
      );
    }
    if (response.headers.get("cache-control") !== "no-store") {
      v.push("JSON response missing Cache-Control: no-store");
    }
    if (response.headers.get("x-content-type-options") !== "nosniff") {
      v.push("JSON response missing nosniff");
    }
  } else if (
    response.status !== 204 && c.method !== "HEAD" && text.length === 0 &&
    response.status !== 200
  ) {
    v.push("empty non-JSON error body");
  }

  // canaries never reflected (the 404 body echoes the route; measured as a note)
  for (const canary of c.canaries) {
    if (text.includes(canary)) {
      if (response.status === 404 && c.path.includes(canary)) {
        out.notes.push("404 body reflects the request path (contains canary)");
      } else {
        v.push(`canary ${canary} leaked into response body`);
      }
    }
  }
  if (
    /\bat\s+[\w$.<>]+\s+\(|\.ts:\d+:\d+|TypeError|ReferenceError|stack/i.test(
      text,
    )
  ) v.push("body looks like it carries a stack trace");

  // status class
  const status = response.status;
  if (status >= 500) {
    const message = jsonBody && parsed && typeof parsed === "object" &&
        (parsed as Record<string, unknown>).error
      ? String(
        ((parsed as Record<string, unknown>).error as Record<string, unknown>)
          .message ?? "",
      )
      : "";
    if (!GENERIC_5XX_RE.test(message)) {
      v.push(`5xx body is not the generic message: ${text.slice(0, 200)}`);
    }
    if (
      Object.keys(
        (parsed as Record<string, unknown> | null)?.error as Record<
          string,
          unknown
        > ?? {},
      ).some((k) => !["message", "code"].includes(k))
    ) {
      v.push("5xx error object carries extra keys");
    }
    if (c.expect.kind !== "upstream") {
      v.push(
        `5xx for ${c.expect.kind} request (expected ${
          c.expect.statuses.join("|")
        })`,
      );
    }
  }
  if (c.expect.kind === "ok" && status !== 200) {
    v.push(`expected 200, got ${status}: ${text.slice(0, 160)}`);
  }
  if (c.expect.kind === "bad") {
    if (!BAD_INPUT_STATUSES.has(status)) {
      v.push(
        `bad input answered ${status} (allowed 400/401/403/404/405/413/415/429): ${
          text.slice(0, 160)
        }`,
      );
    } else if (!c.expect.statuses.includes(status)) {
      v.push(
        `bad input answered ${status}, expected ${c.expect.statuses.join("|")}`,
      );
    }
  }
  if (c.expect.kind === "upstream" && !c.expect.statuses.includes(status)) {
    v.push(
      `upstream-fault request answered ${status}, expected ${
        c.expect.statuses.join("|")
      }: ${text.slice(0, 160)}`,
    );
  }
  if (status === 429 && !response.headers.get("retry-after")) {
    v.push("429 without Retry-After");
  }

  // oracle
  if (status === 200 && c.expect.oracle !== undefined && c.method === "GET") {
    if (JSON.stringify(parsed) !== JSON.stringify(c.expect.oracle)) {
      v.push(
        `payload differs from oracle: got ${text.slice(0, 300)} want ${
          JSON.stringify(c.expect.oracle).slice(0, 300)
        }`,
      );
    }
  }
  if (status === 200 && c.expect.parseable && !mobileParses(parsed)) {
    v.push("200 payload rejected by parsePlayerRank contract");
  }
  if (status === 200 && c.category === "db" && !c.db.inDomain) {
    out.notes.push(
      mobileParses(parsed)
        ? "out-of-domain rows → client-parseable payload"
        : "out-of-domain rows → payload the mobile parser rejects",
    );
  }

  // access log: exactly one categorical line matching the response
  if (cap.accessLines.length !== 1) {
    v.push(`${cap.accessLines.length} access-log lines (want 1)`);
  } else {
    try {
      const entry = JSON.parse(cap.accessLines[0]!) as Record<string, unknown>;
      if (entry.requestId !== out.requestId) {
        v.push("access log requestId differs from header");
      }
      if (entry.status !== status) {
        v.push("access log status differs from response");
      }
      if (typeof entry.route === "string" && entry.route.includes("?")) {
        v.push("access log route carries a query string");
      }
      if (typeof entry.route === "string" && entry.route.includes(c.userId)) {
        v.push("access log route carries the user id");
      }
    } catch {
      v.push("access log line is not JSON");
    }
  }
  // upstream isolation: pre-refusable bearers never reach Supabase Auth
  if (
    c.category === "auth" && c.expect.kind === "bad" &&
    c.auth !== "refuse401" && c.auth !== "refuse403" &&
    c.auth !== "user_no_provider" && status === 401 && out.authCalls > 0 &&
    !c.desc.includes("GoTrue")
  ) {
    v.push(
      `${out.authCalls} Supabase Auth call(s) for a bearer refusable offline`,
    );
  }
  // rejection isolation: no PostgREST read when the request was refused pre-route
  if (
    status !== 200 && status < 500 && out.pgrstReads > 0 &&
    c.category !== "path"
  ) {
    v.push(`${out.pgrstReads} PostgREST read(s) on a ${status} rejection`);
  }
  // unhandled-error log lines mean a 500 path was taken
  if (
    cap.errorLines.some((line) => line.includes("unhandled error")) &&
    status !== 500
  ) v.push("unhandled-error log without a 500");
  if (status === 500) {
    out.notes.push(
      `handler error log: ${
        cap.errorLines.map((l) => l.slice(0, 160)).join(" | ")
      }`,
    );
  }

  out.verdict = v.length ? "BROKEN" : "HELD";
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Campaign
// ─────────────────────────────────────────────────────────────────────────────

const ITER = Math.max(1, Number(Deno.env.get("STRESS_ITER") ?? "200") || 200);
const BASE_SEED = Number(Deno.env.get("STRESS_SEED") ?? "20260905") || 20260905;
const REPLAY = (Deno.env.get("STRESS_REPLAY") ?? "").split(",").map((s) =>
  s.trim()
).filter(Boolean).map(Number);
const OUT = Deno.env.get("STRESS_OUT") ?? "";

async function withCapture<T>(fn: (cap: Captured) => Promise<T>): Promise<T> {
  const cap: Captured = { accessLines: [], errorLines: [] };
  const restoreAccess = captureAccessLog((line) => cap.accessLines.push(line));
  const realError = console.error;
  const realWarn = console.warn;
  console.error = (...args: unknown[]) =>
    cap.errorLines.push(
      args.map((
        a,
      ) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(
        " ",
      ),
    );
  console.warn = () => undefined;
  try {
    return await fn(cap);
  } finally {
    restoreAccess();
    console.error = realError;
    console.warn = realWarn;
  }
}

Deno.test({
  name: `stress GET /v1/rank fuzz-boundary: ${
    REPLAY.length
      ? `replay ${REPLAY.join(",")}`
      : `${ITER} seeded requests (base seed ${BASE_SEED})`
  }`,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = await loadHarness();
    const seeds = REPLAY.length
      ? REPLAY
      : Array.from({ length: ITER }, (_, i) => mix32(BASE_SEED, i));
    const outcomes: Outcome[] = [];
    await withStressUpstream(h, () =>
      withCapture(async (cap) => {
        for (const seed of seeds) {
          const c = genCase(seed);
          outcomes.push(await runCase(h, c, cap));
        }
      }));

    const executed = outcomes.filter((o) => o.verdict !== "UNCONSTRUCTIBLE");
    const broken = outcomes.filter((o) => o.verdict === "BROKEN");
    const byCategory: Record<
      string,
      { ran: number; broken: number; statuses: Record<string, number> }
    > = {};
    for (const o of executed) {
      const slot =
        (byCategory[o.category] ??= { ran: 0, broken: 0, statuses: {} });
      slot.ran += 1;
      if (o.verdict === "BROKEN") slot.broken += 1;
      slot.statuses[String(o.status)] = (slot.statuses[String(o.status)] ?? 0) +
        1;
    }
    const fiveXx = executed.filter((o) => (o.status ?? 0) >= 500).map((o) => ({
      seed: o.seed,
      status: o.status,
      desc: o.desc,
      verdict: o.verdict,
    }));
    const summary = {
      baseSeed: BASE_SEED,
      requested: seeds.length,
      executed: executed.length,
      unconstructible: outcomes.length - executed.length,
      held: executed.length - broken.length,
      broken: broken.length,
      brokenSeeds: broken.map((o) => o.seed),
      fiveXx,
      byCategory,
      p50ms: percentile(executed.map((o) => o.ms), 0.5),
      p99ms: percentile(executed.map((o) => o.ms), 0.99),
      maxMs: Math.max(...executed.map((o) => o.ms)),
    };
    console.log(
      JSON.stringify({ evt: "stress_rank_fuzz_summary", ...summary }),
    );
    if (OUT) {
      await Deno.writeTextFile(
        OUT,
        JSON.stringify({ summary, outcomes }, null, 1),
      );
      console.log(`[stress] wrote ${outcomes.length} outcomes → ${OUT}`);
    }
    for (const o of broken.slice(0, 25)) {
      console.log(
        `[stress] BROKEN seed=${o.seed} ${o.category} "${o.desc}" status=${o.status} :: ${
          o.violations.join(" ;; ")
        }`,
      );
    }
    assert(
      executed.length >= Math.min(seeds.length, Math.ceil(seeds.length * 0.95)),
      "too many unconstructible cases",
    );
    assertEquals(
      broken.map((o) => o.seed),
      [],
      `${broken.length} BROKEN seed(s); replay with STRESS_REPLAY=<seed>`,
    );
  },
});

/** Fixed windows are clock-aligned; start a sequence only when it cannot
 * straddle a window boundary. */
async function alignWindow(windowMs: number, needMs: number): Promise<void> {
  const into = Date.now() % windowMs;
  if (windowMs - into < needMs) {
    await new Promise((r) => setTimeout(r, windowMs - into + 50));
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(
    sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! * 100,
  ) / 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// PostgREST transport faults that postgrest-js retries internally
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name:
    "stress GET /v1/rank PostgREST socket fault / 503: generic 503 answer, and the wall-clock it costs",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = await loadHarness();
    const rng = new Rng(0xfa17);
    const timings: Array<{ fault: PgrstFault; status: number; ms: number }> =
      [];
    await withStressUpstream(h, () =>
      withCapture(async (cap) => {
        for (const fault of ["throw", "http503"] as const) {
          const seed = mix32(0xfa17, fault === "throw" ? 1 : 2);
          const c = genCase(seed);
          const stalled: FuzzCase = {
            ...c,
            category: "db",
            desc: `PostgREST ${fault} on player_technique_rating`,
            method: "GET",
            path: "/v1/rank",
            headers: validRequestHeaders(fakeGoogleIdToken(c.userId), rng.ip()),
            body: null,
            auth: "ok",
            db: { ...healthyDb(rng), techniquesFault: fault, stateFault: "ok" },
            expect: { kind: "upstream", statuses: [503] },
          };
          const out = await runCase(h, stalled, cap);
          timings.push({
            fault,
            status: out.status ?? 0,
            ms: Math.round(out.ms),
          });
          assertEquals(
            out.violations,
            [],
            `seed ${seed}: ${out.violations.join(" ;; ")}`,
          );
          assertEquals(out.status, 503);
        }
      }));
    console.log(JSON.stringify({ evt: "stress_rank_pgrst_stall", timings }));
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Supabase Auth outage seen through the transitional provider-token bearer
// (minimized form of campaign seed 2952505258)
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name:
    "stress GET /v1/rank Supabase Auth outage: a provider-token bearer gets a retryable 503, not a 401 that burns the IP's auth-failure budget",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = await loadHarness();
    const rng = new Rng(0x0a7a6e);
    await withStressUpstream(h, () =>
      withCapture(async (cap) => {
        await alignWindow(300_000, 5_000);
        const ip = rng.ip();
        const verdicts: Array<
          { fault: AuthUpstream; status: number | null; body: string }
        > = [];
        for (const fault of ["throw", "http500"] as const) {
          const userId = rng.uuid();
          const c = genCase(mix32(0x0a7a6e, fault === "throw" ? 1 : 2));
          const req: FuzzCase = {
            ...c,
            category: "auth",
            desc: `provider token, GoTrue ${fault}`,
            method: "GET",
            path: "/v1/rank",
            headers: validRequestHeaders(fakeGoogleIdToken(userId), ip),
            body: null,
            userId,
            auth: fault,
            db: healthyDb(rng),
            expect: { kind: "upstream", statuses: [503] },
          };
          const out = await runCase(h, req, cap);
          verdicts.push({
            fault,
            status: out.status,
            body: out.violations.join(" ;; "),
          });
        }
        // Second-order effect: 30 such outage answers from one address, then the
        // outage ends — a VALID session bearer from that address must be served.
        const outageUser = rng.uuid();
        for (let i = 0; i < 30; i++) {
          const c = genCase(mix32(0x0a7a6e, 100 + i));
          await runCase(h, {
            ...c,
            category: "auth",
            desc: "provider token during GoTrue outage",
            method: "GET",
            path: "/v1/rank",
            headers: validRequestHeaders(fakeGoogleIdToken(rng.uuid()), ip),
            body: null,
            userId: outageUser,
            auth: "throw",
            db: healthyDb(rng),
            expect: { kind: "upstream", statuses: [503] },
          }, cap);
        }
        const recovered = genCase(mix32(0x0a7a6e, 999));
        const afterOutage = await runCase(h, {
          ...recovered,
          category: "auth",
          desc: "valid session bearer from the same address after the outage",
          method: "GET",
          path: "/v1/rank",
          headers: validRequestHeaders(sessionToken(recovered.userId, rng), ip),
          body: null,
          auth: "ok",
          db: healthyDb(rng),
          expect: { kind: "ok", statuses: [200] },
        }, cap);
        console.log(
          JSON.stringify({
            evt: "stress_rank_auth_outage",
            verdicts,
            afterOutageStatus: afterOutage.status,
            afterOutageViolations: afterOutage.violations,
          }),
        );
        for (const v of verdicts) {
          assertEquals(
            v.status,
            503,
            `GoTrue ${v.fault} for a provider bearer must be a generic 503 (got ${v.status}: ${v.body})`,
          );
        }
        assertEquals(
          afterOutage.status,
          200,
          `address that only saw the outage must be served once Auth is back (got ${afterOutage.status})`,
        );
      }));
  },
});

// The same `signInWithIdToken` verdict mapping serves the live sign-in route;
// probed here because the rank finding is only as important as this twin.
Deno.test({
  name:
    "stress POST /v1/account/bootstrap Supabase Auth outage: sign-in during a GoTrue socket fault / 500 answers 503, not 401",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = await loadHarness();
    const rng = new Rng(0xb007);
    await withStressUpstream(h, () =>
      withCapture(async () => {
        const verdicts: Array<
          { fault: AuthUpstream; status: number; body: string }
        > = [];
        for (const fault of ["throw", "http500"] as const) {
          h.reset();
          const userId = rng.uuid();
          current = {
            auth: fault,
            db: healthyDb(rng),
            userId,
            canary: `CANARYb007${rng.hex(6)}`,
          };
          const res = await h.handler(
            new Request("http://edge.test/v1/account/bootstrap", {
              method: "POST",
              headers: {
                ...validRequestHeaders(fakeGoogleIdToken(userId), rng.ip()),
                "Content-Type": "application/json",
              },
              body: JSON.stringify({}),
            }),
          );
          verdicts.push({
            fault,
            status: res.status,
            body: (await res.text()).slice(0, 200),
          });
        }
        console.log(
          JSON.stringify({ evt: "stress_bootstrap_auth_outage", verdicts }),
        );
        for (const v of verdicts) {
          assertEquals(
            v.status,
            503,
            `GoTrue ${v.fault} during bootstrap must be a generic 503 (got ${v.status}: ${v.body})`,
          );
        }
      }));
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic rate-limit boundaries (sequences, not random draws)
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name:
    "stress GET /v1/rank rate-limit boundaries: per-user 240/min, per-IP auth-failure 30/5min, per-IP 1200/min",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = await loadHarness();
    const rng = new Rng(0x5eed);
    await withStressUpstream(h, () =>
      withCapture(async () => {
        // (a) per-user general budget: 240 allowed, the 241st is 429 + Retry-After, no read on rejection.
        {
          await alignWindow(60_000, 10_000);
          const userId = rng.uuid();
          const token = fakeGoogleIdToken(userId);
          const db = healthyDb(rng);
          current = { auth: "ok", db, userId, canary: "none" };
          h.tables.player_technique_rating = db.techniques;
          h.tables.player_rank_state = db.state;
          const statuses: number[] = [];
          for (let i = 0; i < 245; i++) {
            const ip = rng.ip(); // a fresh IP each time: only the USER budget is shared
            const req = new Request("http://edge.test/v1/rank", {
              headers: validRequestHeaders(token, ip),
            });
            h.calls.length = 0;
            const res = await h.handler(req);
            statuses.push(res.status);
            if (i >= 240) {
              assertEquals(
                res.headers.get("retry-after") !== null,
                true,
                "429 must carry Retry-After",
              );
              assertEquals(
                h.calls.filter((c) => c.url.includes("/rest/v1/")).length,
                0,
                "no PostgREST read on a 429",
              );
              const body = await res.json();
              assertEquals(body.error.code, "rate_limited");
            } else {
              await res.text();
            }
            assert(
              REQUEST_ID_RE.test(res.headers.get("x-request-id") ?? ""),
              "x-request-id on every response",
            );
          }
          assertEquals(
            statuses.slice(0, 240).every((s) => s === 200),
            true,
            "first 240 requests of the window are 200",
          );
          assertEquals(statuses.slice(240), [429, 429, 429, 429, 429]);
        }
        // (b) per-IP auth-failure budget: 30 bad bearers, then even a VALID bearer is refused pre-auth with 429.
        {
          await alignWindow(300_000, 5_000);
          const ip = rng.ip();
          const statuses: number[] = [];
          for (let i = 0; i < 30; i++) {
            const req = new Request("http://edge.test/v1/rank", {
              headers: {
                authorization: `Bearer garbage-${i}`,
                "x-forwarded-for": ip,
              },
            });
            const res = await h.handler(req);
            statuses.push(res.status);
            await res.text();
          }
          assertEquals(
            statuses.every((s) => s === 401),
            true,
            "30 bad bearers → 30 × 401",
          );
          const userId = rng.uuid();
          current = { auth: "ok", db: healthyDb(rng), userId, canary: "none" };
          h.calls.length = 0;
          const valid = await h.handler(
            new Request("http://edge.test/v1/rank", {
              headers: validRequestHeaders(fakeGoogleIdToken(userId), ip),
            }),
          );
          assertEquals(
            valid.status,
            429,
            "IP that burned its auth-failure budget is refused before auth",
          );
          assert(valid.headers.get("retry-after") !== null);
          assertEquals(
            h.calls.length,
            0,
            "no upstream call at all for a throttled IP",
          );
          await valid.text();
        }
        // (c) per-IP global budget: 1200 requests, the 1201st is 429 (users rotate so the user budget never trips).
        {
          await alignWindow(60_000, 25_000);
          const ip = rng.ip();
          let last = 0;
          for (let i = 0; i < 1201; i++) {
            const userId = rng.uuid();
            const db = healthyDb(rng);
            current = { auth: "ok", db, userId, canary: "none" };
            h.tables.player_technique_rating = db.techniques;
            h.tables.player_rank_state = db.state;
            const res = await h.handler(
              new Request("http://edge.test/v1/rank", {
                headers: validRequestHeaders(fakeGoogleIdToken(userId), ip),
              }),
            );
            last = res.status;
            await res.text();
            if (i < 1200) {
              assertEquals(
                res.status,
                200,
                `request ${i + 1} inside the IP budget`,
              );
            }
          }
          assertEquals(last, 429, "1201st request from one IP is throttled");
        }
      }));
  },
});
