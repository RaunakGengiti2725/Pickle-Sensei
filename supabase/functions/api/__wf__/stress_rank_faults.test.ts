/**
 * stress-route-get-v1-rank / lens failure-load — FAULT INJECTION half.
 *
 * Drives the REAL `GET /v1/rank` handler (../index.ts, in-process) while each
 * upstream in turn — Supabase Auth, PostgREST (both rank reads), Upstash
 * Redis, RevenueCat — fails, stalls or answers malformed. For every case the
 * matrix records the user-visible error class (status + generic body + no
 * upstream detail leaked) and then PROVES recoverability: the fault is
 * cleared and the very next request must succeed with the seeded rating,
 * i.e. the failure must not have poisoned the L1/L2 cache, the auth cache or
 * the single-flight table.
 *
 *   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json stress_rank_faults.test.ts
 *   STRESS_SEED=<seed> … --filter "<case id>"      # replay one case
 *   STRESS_OUT_DIR=/tmp/out …                      # where faults_<seed>.json lands
 *
 * Redis (Upstash) is CONFIGURED in this file (the L2 faults need it);
 * stress_rank_load.test.ts covers the memory-only fallback.
 *
 * Cases carrying `knownBroken` reproduce a recorded defect (stress report
 * findings RANK-F1: empty/non-array PostgREST body cached as "unranked" for
 * 60s; RANK-F2: no deadline on PostgREST reads; RANK-F3: an Upstash stall
 * costs one 1.2s timeout PER pipeline, 4–9 per request). They are written to
 * the artifact as BROKEN and the test passes only while the defect still
 * reproduces — once fixed, the pin fails loudly and must be removed.
 */
import { assert, assertEquals } from "@std/assert";
import {
  caseSeed,
  forgedSessionToken,
  histogram,
  isRecord,
  loadStressHarness,
  Prng,
  rankRequest,
  readJson,
  type RecordedCall,
  seedUser,
  sleep,
  STRESS_SEED,
  type StressHarness,
  writeArtifact,
} from "./stressRankHarness.ts";

const h = await loadStressHarness({ redis: true });

/** Upstream status the injected fault answered with — must NEVER reach the
 * client body (5xx bodies are generic; detail is for function logs only). */
const LEAK_MARKERS = [
  "injected",
  "connection reset",
  "PGRST",
  "42501",
  "bad_jwt",
  "stack",
  "TypeError",
];

interface Ctx {
  prng: Prng;
  userId: string;
  token: string;
  ip: string;
  rating: number | null;
}

interface FaultCase {
  id: string;
  upstream:
    | "auth"
    | "postgrest"
    | "redis"
    | "revenuecat"
    | "client"
    | "combined";
  what: string;
  /** Override the seeded user (e.g. no technique rows). */
  user?: { techniques?: number; withState?: boolean };
  /** Pre-request warm-up (auth cache warm, rank cache warm…). */
  warm?: (h: StressHarness, ctx: Ctx) => Promise<void>;
  arm: (h: StressHarness, ctx: Ctx) => void;
  /** Per-case env (read per call by index.ts — e.g. AUTH_UPSTREAM_TIMEOUT_MS). */
  env?: Record<string, string>;
  expectStatus: number[];
  /** Extra check on the faulted response body; return a reason when wrong. */
  expectBody?: (
    body: Record<string, unknown>,
    response: Response,
  ) => string | null;
  /** Upper bound on the faulted request's wall time (bounded degradation). */
  maxLatencyMs?: number;
  /** Treat a request that has not answered within this many ms as HUNG
   * (recorded, then released). Only for `hang` faults without a deadline. */
  hangProbeMs?: number;
  /** Whether a clean request after the fault must return the seeded rank
   * (default true). `false` for faults that are the caller's fault. */
  recover?: boolean;
  /** Upstream round trips a client-caused refusal may legitimately cost. */
  allowedRoundTrips?: { auth: number; rest: number };
  /** Recovery must re-read PostgREST (proves the failure was not cached).
   * Default: true when the faulted request was not a 200. */
  recoveryMustReadPostgrest?: boolean;
  /** Reproduced production defect (finding id, see the stress report). The
   * case is recorded BROKEN in the artifact with its full reasons; the Deno
   * test passes only WHILE the defect still reproduces, so the pin has to be
   * removed the moment the fix lands. */
  knownBroken?: string;
}

interface Outcome {
  id: string;
  seed: number;
  upstream: string;
  what: string;
  status: number | "hung";
  errorMessage: string | null;
  errorCode: string | null;
  retryAfter: string | null;
  requestId: string | null;
  latencyMs: number;
  roundTrips: { auth: number; rest: number; redis: number; rc: number };
  faultHits: number;
  leaked: string | null;
  bodySnippet: string;
  recovery: {
    status: number | null;
    rating: unknown;
    restReads: number;
    authReads: number;
    ok: boolean;
    detail: string | null;
  } | null;
  verdict: "HELD" | "BROKEN";
  knownBroken: string | null;
  reasons: string[];
  replay: string;
}

const results: Outcome[] = [];

function roundTrips(calls: RecordedCall[]): Outcome["roundTrips"] {
  return {
    auth: calls.filter((c) => c.target === "auth").length,
    rest: calls.filter((c) => c.target === "rest").length,
    redis: calls.filter((c) => c.target === "redis").length,
    rc: calls.filter((c) => c.target === "rc").length,
  };
}

function errorOf(
  body: Record<string, unknown>,
): { message: string | null; code: string | null } {
  const error = isRecord(body.error) ? body.error : null;
  return {
    message: typeof error?.message === "string" ? error.message : null,
    code: typeof error?.code === "string" ? error.code : null,
  };
}

function generic5xx(body: Record<string, unknown>): string | null {
  const { message } = errorOf(body);
  if (!message) return "5xx body has no error.message";
  if (!/temporarily unavailable|Something went wrong/.test(message)) {
    return `5xx message is not the generic copy: ${message}`;
  }
  return null;
}

function leakIn(text: string): string | null {
  const lower = text.toLowerCase();
  for (const marker of LEAK_MARKERS) {
    if (lower.includes(marker.toLowerCase())) return marker;
  }
  return null;
}

const rankOk =
  (rating: number | null) => (body: Record<string, unknown>): string | null => {
    if (rating === null) {
      return body.rank === null
        ? null
        : `expected rank:null, got ${JSON.stringify(body.rank)}`;
    }
    const rank = isRecord(body.rank) ? body.rank : null;
    if (!rank) return `expected rank object, got ${JSON.stringify(body.rank)}`;
    if (rank.rating !== rating) {
      return `rating ${String(rank.rating)} !== seeded ${rating}`;
    }
    return null;
  };

const warmAuthOnly = async (h: StressHarness, ctx: Ctx): Promise<void> => {
  // Warm the auth cache through a route that does not touch the rank cache.
  await h.handler(
    new Request("http://edge.test/functions/v1/api/v1/me", {
      headers: {
        Authorization: `Bearer ${ctx.token}`,
        "x-forwarded-for": ctx.ip,
      },
    }),
  );
};

const warmRank = async (h: StressHarness, ctx: Ctx): Promise<void> => {
  const response = await h.handler(rankRequest(ctx.token, ctx.ip));
  assertEquals(response.status, 200, "warm-up rank read must succeed");
};

const AUTH_JSON = { "Content-Type": "application/json" };

// ── The matrix ──────────────────────────────────────────────────────────────

const cases: FaultCase[] = [
  // ─ Supabase Auth (GET /auth/v1/user, cold auth cache) ─
  {
    id: "auth-500",
    upstream: "auth",
    what: "GoTrue answers 500",
    arm: (h) => h.injectFault("auth", { kind: "http", status: 500 }),
    expectStatus: [503],
    expectBody: (b, r) =>
      generic5xx(b) ??
        (r.headers.get("Retry-After") ? null : "503 without Retry-After"),
  },
  {
    id: "auth-502",
    upstream: "auth",
    what: "GoTrue answers 502 (gateway)",
    arm: (h) =>
      h.injectFault("auth", {
        kind: "http",
        status: 502,
        body: "<html>bad gateway</html>",
      }),
    expectStatus: [503],
    expectBody: generic5xx,
  },
  {
    id: "auth-503-retry-after",
    upstream: "auth",
    what: "GoTrue answers 503 with Retry-After: 7",
    arm: (h) =>
      h.injectFault("auth", {
        kind: "http",
        status: 503,
        headers: { "Retry-After": "7" },
      }),
    expectStatus: [503],
    expectBody: (b, r) =>
      generic5xx(b) ??
        (r.headers.get("Retry-After") === "7"
          ? null
          : `Retry-After not propagated: ${r.headers.get("Retry-After")}`),
  },
  {
    id: "auth-504",
    upstream: "auth",
    what: "GoTrue answers 504",
    arm: (h) => h.injectFault("auth", { kind: "http", status: 504 }),
    expectStatus: [503],
    expectBody: generic5xx,
  },
  {
    id: "auth-429",
    upstream: "auth",
    what: "GoTrue rate-limits us (429)",
    arm: (h) =>
      h.injectFault("auth", {
        kind: "http",
        status: 429,
        headers: { "Retry-After": "3" },
      }),
    expectStatus: [503],
    expectBody: (b, r) =>
      generic5xx(b) ??
        (r.headers.get("Retry-After") === "3"
          ? null
          : `Retry-After not propagated: ${r.headers.get("Retry-After")}`),
  },
  {
    id: "auth-401",
    upstream: "auth",
    what: "GoTrue refuses the bearer (401)",
    arm: (h) =>
      h.injectFault("auth", {
        kind: "http",
        status: 401,
        body: JSON.stringify({
          code: 401,
          msg: "invalid JWT",
          error_code: "bad_jwt",
        }),
      }),
    expectStatus: [401],
    expectBody: (
      b,
    ) => (errorOf(b).message?.includes("Sign in again")
      ? null
      : `unexpected 401 copy: ${errorOf(b).message}`),
  },
  {
    id: "auth-403",
    upstream: "auth",
    what: "GoTrue answers 403",
    arm: (h) => h.injectFault("auth", { kind: "http", status: 403 }),
    expectStatus: [401],
  },
  {
    id: "auth-400",
    upstream: "auth",
    what: "GoTrue answers 400",
    arm: (h) => h.injectFault("auth", { kind: "http", status: 400 }),
    expectStatus: [401],
  },
  {
    id: "auth-404",
    upstream: "auth",
    what: "GoTrue answers 404 (route missing)",
    arm: (h) => h.injectFault("auth", { kind: "http", status: 404 }),
    expectStatus: [503],
    expectBody: generic5xx,
  },
  {
    id: "auth-200-html",
    upstream: "auth",
    what: "GoTrue 200 with an HTML body",
    arm: (h) =>
      h.injectFault("auth", {
        kind: "http",
        status: 200,
        body: "<html>ok</html>",
        headers: { "Content-Type": "text/html" },
      }),
    expectStatus: [503],
    expectBody: generic5xx,
  },
  {
    id: "auth-200-empty",
    upstream: "auth",
    what: "GoTrue 200 with an empty body",
    arm: (h) => h.injectFault("auth", { kind: "http", status: 200, body: "" }),
    expectStatus: [503],
    expectBody: generic5xx,
  },
  {
    id: "auth-200-truncated",
    upstream: "auth",
    what: "GoTrue 200 with truncated JSON",
    arm: (h) =>
      h.injectFault("auth", {
        kind: "http",
        status: 200,
        body: '{"id":"1111',
        headers: AUTH_JSON,
      }),
    expectStatus: [503],
    expectBody: generic5xx,
  },
  {
    id: "auth-200-object-without-id",
    upstream: "auth",
    what: "GoTrue 200 with {} (no user id)",
    arm: (h) =>
      h.injectFault("auth", {
        kind: "http",
        status: 200,
        body: "{}",
        headers: AUTH_JSON,
      }),
    expectStatus: [503],
    expectBody: generic5xx,
  },
  {
    id: "auth-200-array",
    upstream: "auth",
    what: "GoTrue 200 with a JSON array",
    arm: (h) =>
      h.injectFault("auth", {
        kind: "http",
        status: 200,
        body: "[]",
        headers: AUTH_JSON,
      }),
    expectStatus: [503],
    expectBody: generic5xx,
  },
  {
    id: "auth-200-empty-id",
    upstream: "auth",
    what: 'GoTrue 200 with {"id":""}',
    arm: (h) =>
      h.injectFault("auth", {
        kind: "http",
        status: 200,
        body: JSON.stringify({ id: "" }),
        headers: AUTH_JSON,
      }),
    expectStatus: [503],
    expectBody: generic5xx,
  },
  {
    id: "auth-200-no-provider",
    upstream: "auth",
    what: "GoTrue 200 user without app_metadata.provider",
    arm: (h, ctx) =>
      h.injectFault("auth", {
        kind: "http",
        status: 200,
        body: JSON.stringify({ id: ctx.userId, email: "x@example.com" }),
        headers: AUTH_JSON,
      }),
    expectStatus: [401],
    recover: true,
  },
  {
    id: "auth-200-email-provider",
    upstream: "auth",
    what: "GoTrue 200 user with provider=email (not Google/Apple)",
    arm: (h, ctx) =>
      h.injectFault("auth", {
        kind: "http",
        status: 200,
        body: JSON.stringify({
          id: ctx.userId,
          app_metadata: { provider: "email" },
        }),
        headers: AUTH_JSON,
      }),
    expectStatus: [401],
  },
  {
    id: "auth-200-other-user",
    upstream: "auth",
    what: "GoTrue 200 with a DIFFERENT user id than the bearer's sub",
    arm: (h, _ctx) =>
      h.injectFault("auth", {
        kind: "http",
        status: 200,
        body: JSON.stringify({
          id: "99999999-9999-4999-8999-999999999999",
          app_metadata: { provider: "google" },
        }),
        headers: AUTH_JSON,
      }),
    // GoTrue is the identity authority: the bearer's `sub` is unverified
    // client data, so the handler serving the GoTrue-asserted user's rank
    // (and caching that identity for the token) is the correct outcome.
    // Recorded, not asserted beyond "a rank-shaped 200 or a refusal".
    expectStatus: [200, 401, 503],
    expectBody: (
      b,
    ) => (b.rank === undefined || isRecord(b.rank) || b.rank === null ||
        isRecord(b.error)
      ? null
      : "unexpected body"),
    recover: false,
  },
  {
    id: "auth-throw-connect",
    upstream: "auth",
    what: "GoTrue connection refused (fetch rejects, every attempt)",
    env: { AUTH_UPSTREAM_TIMEOUT_MS: "600" },
    arm: (h) => h.injectFault("auth", { kind: "throw" }),
    expectStatus: [503],
    expectBody: generic5xx,
    maxLatencyMs: 1_500,
  },
  {
    id: "auth-throw-once",
    upstream: "auth",
    what: "GoTrue connection reset ONCE, then healthy (in-request retry)",
    env: { AUTH_UPSTREAM_TIMEOUT_MS: "2000" },
    arm: (h) => h.injectFault("auth", { kind: "throw" }, { times: 1 }),
    expectStatus: [200],
    recoveryMustReadPostgrest: false,
  },
  {
    id: "auth-hang",
    upstream: "auth",
    what: "GoTrue never answers (deadline 400ms)",
    env: { AUTH_UPSTREAM_TIMEOUT_MS: "400" },
    arm: (h) => h.injectFault("auth", { kind: "hang" }),
    expectStatus: [503],
    expectBody: generic5xx,
    maxLatencyMs: 1_200,
  },
  {
    id: "auth-slow-then-ok",
    upstream: "auth",
    what: "GoTrue answers after 150ms (inside deadline)",
    arm: (h) => h.injectFault("auth", { kind: "delay", ms: 150 }),
    expectStatus: [200],
    recoveryMustReadPostgrest: false,
  },

  // ─ PostgREST (auth healthy) ─
  {
    id: "rest-techniques-500",
    upstream: "postgrest",
    what: "player_technique_rating read → 500",
    arm: (h) =>
      h.injectFault("rest", {
        kind: "http",
        status: 500,
        body: JSON.stringify({
          code: "XX000",
          message: "injected internal_error",
        }),
      }, { table: "player_technique_rating" }),
    expectStatus: [503],
    expectBody: generic5xx,
  },
  {
    id: "rest-techniques-503",
    upstream: "postgrest",
    what: "player_technique_rating read → 503 (pool exhausted)",
    arm: (h) =>
      h.injectFault("rest", {
        kind: "http",
        status: 503,
        body: JSON.stringify({
          code: "53300",
          message: "injected too_many_connections",
        }),
      }, { table: "player_technique_rating" }),
    expectStatus: [503],
    expectBody: generic5xx,
  },
  {
    id: "rest-techniques-401-jwt",
    upstream: "postgrest",
    what:
      "player_technique_rating read → 401 PGRST301 (JWT rejected at PostgREST)",
    arm: (h) =>
      h.injectFault("rest", {
        kind: "http",
        status: 401,
        body: JSON.stringify({ code: "PGRST301", message: "JWT expired" }),
      }, { table: "player_technique_rating" }),
    expectStatus: [401, 503],
    expectBody: (b) => (errorOf(b).message ? null : "no error message"),
  },
  {
    id: "rest-techniques-403-grant",
    upstream: "postgrest",
    what: "player_technique_rating read → 403 42501 (grant missing)",
    arm: (h) =>
      h.injectFault("rest", {
        kind: "http",
        status: 403,
        body: JSON.stringify({
          code: "42501",
          message: "permission denied for view player_technique_rating",
        }),
      }, { table: "player_technique_rating" }),
    expectStatus: [503],
    expectBody: generic5xx,
  },
  {
    id: "rest-techniques-404-json",
    upstream: "postgrest",
    what: "player_technique_rating read → 404 PGRST205 (relation missing)",
    arm: (h) =>
      h.injectFault("rest", {
        kind: "http",
        status: 404,
        body: JSON.stringify({
          code: "PGRST205",
          message: "Could not find the table",
        }),
      }, { table: "player_technique_rating" }),
    expectStatus: [503],
    expectBody: generic5xx,
  },
  {
    id: "rest-techniques-404-empty",
    upstream: "postgrest",
    what: "player_technique_rating read → 404 with EMPTY body (gateway)",
    arm: (h) =>
      h.injectFault("rest", { kind: "http", status: 404, body: "" }, {
        table: "player_technique_rating",
      }),
    expectStatus: [503],
    expectBody: generic5xx,
    // postgrest-js maps 404+empty to {data:null,error:null,status:204}; the
    // handler then serves AND caches `{rank:null}` for 60s.
    knownBroken: "RANK-F1",
  },
  {
    id: "rest-techniques-429",
    upstream: "postgrest",
    what: "player_technique_rating read → 429",
    arm: (h) =>
      h.injectFault("rest", {
        kind: "http",
        status: 429,
        headers: { "Retry-After": "2" },
      }, { table: "player_technique_rating" }),
    expectStatus: [503],
    expectBody: generic5xx,
  },
  {
    id: "rest-techniques-200-html",
    upstream: "postgrest",
    what: "player_technique_rating → 200 with HTML body",
    arm: (h) =>
      h.injectFault("rest", {
        kind: "http",
        status: 200,
        body: "<html>maintenance</html>",
      }, { table: "player_technique_rating" }),
    expectStatus: [503],
    expectBody: generic5xx,
  },
  {
    id: "rest-techniques-200-empty",
    upstream: "postgrest",
    what: "player_technique_rating → 200 with EMPTY body",
    arm: (h) =>
      h.injectFault("rest", { kind: "http", status: 200, body: "" }, {
        table: "player_technique_rating",
      }),
    expectStatus: [503],
    expectBody: generic5xx,
    knownBroken: "RANK-F1",
  },
  {
    id: "rest-techniques-200-null",
    upstream: "postgrest",
    what: "player_technique_rating → 200 `null`",
    arm: (h) =>
      h.injectFault("rest", { kind: "http", status: 200, body: "null" }, {
        table: "player_technique_rating",
      }),
    expectStatus: [503],
    expectBody: generic5xx,
    knownBroken: "RANK-F1",
  },
  {
    id: "rest-techniques-200-object",
    upstream: "postgrest",
    what: "player_technique_rating → 200 `{}` (object, not array)",
    arm: (h) =>
      h.injectFault("rest", { kind: "http", status: 200, body: "{}" }, {
        table: "player_technique_rating",
      }),
    // `{}` has no `.map` → TypeError → the top-level catch answers a generic
    // 500 (nothing cached, next request rebuilds). Same user-visible class
    // as the 503 path; recorded as-is.
    expectStatus: [500, 503],
    expectBody: generic5xx,
  },
  {
    id: "rest-techniques-200-truncated",
    upstream: "postgrest",
    what: "player_technique_rating → 200 truncated JSON",
    arm: (h) =>
      h.injectFault("rest", {
        kind: "http",
        status: 200,
        body: '[{"shot_type":"dink","score":7.',
      }, { table: "player_technique_rating" }),
    expectStatus: [503],
    expectBody: generic5xx,
  },
  {
    id: "rest-techniques-200-garbage-rows",
    upstream: "postgrest",
    what: "player_technique_rating → 200 rows with non-numeric scores",
    arm: (h, ctx) =>
      h.injectFault("rest", {
        kind: "http",
        status: 200,
        body: JSON.stringify([{
          user_id: ctx.userId,
          shot_type: "dink",
          score: "abc",
          captured_at: "x",
          sampled_count: 1,
          confidence_weight: 1,
        }]),
      }, { table: "player_technique_rating" }),
    // Dropping the row is fine; caching the resulting "unranked" answer for
    // 60s over a user who HAS a rank is not (recovery fails: L1 hit).
    expectStatus: [200, 503],
    expectBody: (
      b,
    ) => (b.rank === null || isRecord(b.error)
      ? null
      : `garbage rows produced ${JSON.stringify(b.rank)}`),
    knownBroken: "RANK-F1",
  },
  {
    id: "rest-techniques-200-string-numbers",
    upstream: "postgrest",
    what: "player_technique_rating → numeric fields serialized as strings",
    arm: (h, ctx) =>
      h.injectFault("rest", {
        kind: "http",
        status: 200,
        body: JSON.stringify(
          (h.tables.player_technique_rating ?? [])
            .filter((row) => row.user_id === ctx.userId)
            .map((row) => ({
              ...row,
              score: String(row.score),
              sampled_count: String(row.sampled_count),
              confidence_weight: String(row.confidence_weight),
            })),
        ),
      }, { table: "player_technique_rating" }),
    expectStatus: [200],
    expectBody: (
      b,
    ) => (isRecord(b.rank)
      ? null
      : `expected rank object, got ${JSON.stringify(b.rank)}`),
    recoveryMustReadPostgrest: false,
  },
  {
    id: "rest-state-500",
    upstream: "postgrest",
    what: "player_rank_state read → 500 (techniques healthy)",
    arm: (h) =>
      h.injectFault("rest", { kind: "http", status: 500 }, {
        table: "player_rank_state",
      }),
    expectStatus: [503],
    expectBody: generic5xx,
  },
  {
    id: "rest-state-500-unranked-user",
    upstream: "postgrest",
    what: "player_rank_state → 500 for a user WITHOUT technique rows",
    user: { techniques: 0 },
    arm: (h) =>
      h.injectFault("rest", { kind: "http", status: 500 }, {
        table: "player_rank_state",
      }),
    // No evidence → {rank:null} regardless of the state read.
    expectStatus: [200],
    expectBody: (b) => (b.rank === null ? null : "expected rank:null"),
    recoveryMustReadPostgrest: false,
  },
  {
    id: "rest-state-406-missing",
    upstream: "postgrest",
    what: "player_rank_state → 406 PGRST116 (no saved state; inline fallback)",
    user: { withState: false },
    arm: () => {},
    expectStatus: [200],
    recoveryMustReadPostgrest: false,
  },
  {
    id: "rest-state-200-two-rows",
    upstream: "postgrest",
    what: "player_rank_state → 200 with TWO rows (maybeSingle violated)",
    arm: (h, ctx) =>
      h.injectFault("rest", {
        kind: "http",
        status: 200,
        body: JSON.stringify([{
          user_id: ctx.userId,
          rating: 1,
          tier: "bronze",
          technique_count: 1,
          scored_shot_count: 1,
          updated_at: "x",
        }, {
          user_id: ctx.userId,
          rating: 9,
          tier: "diamond",
          technique_count: 1,
          scored_shot_count: 1,
          updated_at: "x",
        }]),
      }, { table: "player_rank_state" }),
    expectStatus: [503],
    expectBody: generic5xx,
  },
  {
    id: "rest-state-200-garbage",
    upstream: "postgrest",
    what: "player_rank_state → 200 row with rating:null / tier:42",
    arm: (h, ctx) =>
      h.injectFault("rest", {
        kind: "http",
        status: 200,
        body: JSON.stringify([{
          user_id: ctx.userId,
          rating: null,
          tier: 42,
          technique_count: "x",
          scored_shot_count: null,
          updated_at: 7,
        }]),
      }, { table: "player_rank_state" }),
    // `player_rank_state.rating` is `numeric(4,2) not null` (20260829150000)
    // so this shape is unreachable from Postgres; the case RECORDS what a
    // malformed row does (`Number(null)` is 0 → served as rating 0.00 and
    // cached 60s) without asserting the seeded rating comes back.
    expectStatus: [200],
    expectBody: (
      b,
    ) => (isRecord(b.rank) && typeof b.rank.rating === "number" &&
        Number.isFinite(b.rank.rating)
      ? null
      : `garbage state served: ${JSON.stringify(b.rank)}`),
    recover: false,
  },
  {
    id: "rest-state-200-html",
    upstream: "postgrest",
    what: "player_rank_state → 200 HTML body",
    arm: (h) =>
      h.injectFault("rest", { kind: "http", status: 200, body: "<html/>" }, {
        table: "player_rank_state",
      }),
    expectStatus: [503],
    expectBody: generic5xx,
  },
  {
    id: "rest-techniques-throw",
    upstream: "postgrest",
    what: "player_technique_rating fetch rejects (connection reset)",
    arm: (h) =>
      h.injectFault("rest", { kind: "throw" }, {
        table: "player_technique_rating",
      }),
    expectStatus: [503],
    expectBody: generic5xx,
  },
  {
    id: "rest-state-throw",
    upstream: "postgrest",
    what: "player_rank_state fetch rejects (connection reset)",
    arm: (h) =>
      h.injectFault("rest", { kind: "throw" }, { table: "player_rank_state" }),
    expectStatus: [503],
    expectBody: generic5xx,
  },
  {
    id: "rest-both-500",
    upstream: "postgrest",
    what: "both rank reads → 500",
    arm: (h) => h.injectFault("rest", { kind: "http", status: 500 }),
    expectStatus: [503],
    expectBody: generic5xx,
  },
  {
    id: "rest-techniques-500-once",
    upstream: "postgrest",
    what: "player_technique_rating → 500 for exactly one call",
    arm: (h) =>
      h.injectFault("rest", { kind: "http", status: 500 }, {
        table: "player_technique_rating",
        times: 1,
      }),
    expectStatus: [503],
    expectBody: generic5xx,
  },
  {
    id: "rest-techniques-hang",
    upstream: "postgrest",
    what:
      "player_technique_rating never answers (no deadline on PostgREST reads)",
    arm: (h) =>
      h.injectFault("rest", { kind: "hang" }, {
        table: "player_technique_rating",
      }),
    expectStatus: [503],
    expectBody: generic5xx,
    hangProbeMs: 2_500,
    // Once the hang is released the build completes and is (correctly)
    // cached — recovery from L1 is the intended path, not a poisoned cache.
    recoveryMustReadPostgrest: false,
    knownBroken: "RANK-F2",
  },
  {
    id: "rest-state-hang",
    upstream: "postgrest",
    what: "player_rank_state never answers",
    arm: (h) =>
      h.injectFault("rest", { kind: "hang" }, { table: "player_rank_state" }),
    expectStatus: [503],
    expectBody: generic5xx,
    hangProbeMs: 2_500,
    recoveryMustReadPostgrest: false,
    knownBroken: "RANK-F2",
  },
  {
    id: "rest-techniques-slow",
    upstream: "postgrest",
    what: "player_technique_rating answers after 200ms",
    arm: (h) =>
      h.injectFault("rest", { kind: "delay", ms: 200 }, {
        table: "player_technique_rating",
      }),
    expectStatus: [200],
    recoveryMustReadPostgrest: false,
  },
  {
    id: "rest-techniques-1000-rows",
    upstream: "postgrest",
    what: "player_technique_rating returns 1000 rows (view bug / no cap)",
    arm: (h, ctx) =>
      h.injectFault("rest", {
        kind: "http",
        status: 200,
        body: JSON.stringify(
          Array.from(
            { length: 1000 },
            (_, i) => ({
              user_id: ctx.userId,
              shot_type: `type_${i}`,
              score: (i % 100) / 10,
              captured_at: "2026-09-01T00:00:00Z",
              sampled_count: 1,
              confidence_weight: 1,
            }),
          ),
        ),
      }, { table: "player_technique_rating" }),
    expectStatus: [200],
    expectBody: (
      b,
    ) => (isRecord(b.rank) && Array.isArray(b.rank.techniques)
      ? null
      : "no techniques array"),
    recoveryMustReadPostgrest: false,
  },

  // ─ Upstash Redis (L2 cache + shared rate limits) ─
  {
    id: "redis-500",
    upstream: "redis",
    what: "Upstash pipeline → 500 on every call",
    arm: (h) => h.injectFault("redis", { kind: "http", status: 500 }),
    expectStatus: [200],
    maxLatencyMs: 500,
    recoveryMustReadPostgrest: false,
  },
  {
    id: "redis-401",
    upstream: "redis",
    what: "Upstash pipeline → 401 (token rotated)",
    arm: (h) =>
      h.injectFault("redis", {
        kind: "http",
        status: 401,
        body: JSON.stringify({ error: "Unauthorized" }),
      }),
    expectStatus: [200],
    maxLatencyMs: 500,
    recoveryMustReadPostgrest: false,
  },
  {
    id: "redis-throw",
    upstream: "redis",
    what: "Upstash unreachable (fetch rejects)",
    arm: (h) => h.injectFault("redis", { kind: "throw" }),
    expectStatus: [200],
    maxLatencyMs: 500,
    recoveryMustReadPostgrest: false,
  },
  {
    id: "redis-hang",
    upstream: "redis",
    what:
      "Upstash never answers (per-pipeline 1.2s timeout, N pipelines per request)",
    arm: (h) => h.injectFault("redis", { kind: "hang" }),
    expectStatus: [200],
    // One request must not spend more than ~2 Redis timeouts stalled.
    maxLatencyMs: 2_500,
    recoveryMustReadPostgrest: false,
    knownBroken: "RANK-F3",
  },
  {
    id: "redis-hang-warm",
    upstream: "redis",
    what:
      "Upstash never answers while auth + rank are already in L1 (fully warm request)",
    warm: warmRank,
    arm: (h) => h.injectFault("redis", { kind: "hang" }),
    expectStatus: [200],
    maxLatencyMs: 2_500,
    recoveryMustReadPostgrest: false,
    knownBroken: "RANK-F3",
  },
  {
    id: "redis-200-html",
    upstream: "redis",
    what: "Upstash 200 with non-JSON body",
    arm: (h) =>
      h.injectFault("redis", { kind: "raw", body: "<html>edge</html>" }),
    expectStatus: [200],
    recoveryMustReadPostgrest: false,
  },
  {
    id: "redis-200-object",
    upstream: "redis",
    what: "Upstash 200 `{}` instead of results array",
    arm: (h) => h.injectFault("redis", { kind: "raw", body: "{}" }),
    expectStatus: [200],
    recoveryMustReadPostgrest: false,
  },
  {
    id: "redis-200-short",
    upstream: "redis",
    what: "Upstash 200 `[]` (fewer results than commands)",
    arm: (h) => h.injectFault("redis", { kind: "raw", body: "[]" }),
    expectStatus: [200],
    recoveryMustReadPostgrest: false,
  },
  {
    id: "redis-per-command-errors",
    upstream: "redis",
    what: "every Redis command answers {error}",
    arm: (h) =>
      h.injectFault("redis", {
        kind: "redis",
        results: (cmds) =>
          cmds.map(() => ({ error: "ERR max requests limit exceeded" })),
      }),
    expectStatus: [200],
    recoveryMustReadPostgrest: false,
  },
  {
    id: "redis-rank-garbage-string",
    upstream: "redis",
    what: "L2 GET rank:<user> returns a non-JSON string",
    arm: (h) =>
      h.injectFault("redis", {
        kind: "redis",
        results: (cmds) =>
          cmds.map((c) => (c[0] === "GET" && String(c[1]).startsWith("rank:")
            ? { result: "not json at all" }
            : (c[0] === "TTL" ? { result: 30 } : { result: null }))
          ),
      }),
    expectStatus: [200],
    expectBody: (
      b,
    ) => (isRecord(b.rank)
      ? null
      : `garbage L2 broke the read: ${JSON.stringify(b)}`),
    recoveryMustReadPostgrest: false,
  },
  {
    id: "redis-rank-wrong-shape",
    upstream: "redis",
    what: "L2 GET rank:<user> returns valid JSON of the wrong shape",
    arm: (h) =>
      h.injectFault("redis", {
        kind: "redis",
        results: (cmds) =>
          cmds.map((c) => (c[0] === "GET" && String(c[1]).startsWith("rank:")
            ? {
              result: JSON.stringify({
                rank: { rating: "nine", techniques: "none" },
              }),
            }
            : (c[0] === "TTL" ? { result: 30 } : { result: null }))
          ),
      }),
    // Shared cache is a trusted store written only by this function; the
    // matrix RECORDS what a corrupt entry does (served as-is vs. rebuilt).
    expectStatus: [200],
    expectBody: () => null,
    recover: false,
  },
  {
    id: "redis-incr-huge",
    upstream: "redis",
    what: "Redis INCR answers 10^6 (shared rate limit says: over budget)",
    arm: (h) =>
      h.injectFault("redis", {
        kind: "redis",
        results: (cmds) =>
          cmds.map((
            c,
          ) => (c[0] === "INCR" ? { result: 1_000_000 } : { result: null })),
      }),
    expectStatus: [429],
    expectBody: (
      b,
      r,
    ) => (errorOf(b).code === "rate_limited" && r.headers.get("Retry-After")
      ? null
      : `429 without code/Retry-After: ${JSON.stringify(b)}`),
  },
  {
    id: "redis-incr-nan",
    upstream: "redis",
    what: "Redis INCR answers a non-number",
    arm: (h) =>
      h.injectFault("redis", {
        kind: "redis",
        results: (cmds) =>
          cmds.map((
            c,
          ) => (c[0] === "INCR" ? { result: "abc" } : { result: null })),
      }),
    expectStatus: [200],
    recoveryMustReadPostgrest: false,
  },
  {
    id: "redis-set-error",
    upstream: "redis",
    what: "Redis SET (cache writes) fail, reads work",
    arm: (h) =>
      h.injectFault("redis", {
        kind: "redis",
        results: (cmds) =>
          cmds.map((c) => (c[0] === "SET"
            ? { error: "OOM command not allowed" }
            : c[0] === "INCR"
            ? { result: 1 }
            : { result: null })
          ),
      }),
    expectStatus: [200],
    recoveryMustReadPostgrest: false,
  },
  {
    id: "redis-revoked-marker",
    upstream: "redis",
    what: "L2 says this session is revoked (auth:revoked:<sid> = 1)",
    arm: (h) =>
      h.injectFault("redis", {
        kind: "redis",
        results: (cmds) =>
          cmds.map((
            c,
          ) => (c[0] === "GET" && String(c[1]).startsWith("auth:revoked:")
            ? { result: "1" }
            : c[0] === "INCR"
            ? { result: 1 }
            : { result: null })
          ),
      }),
    expectStatus: [401],
    expectBody: (
      b,
    ) => (errorOf(b).message?.includes("Sign in again")
      ? null
      : `unexpected 401 copy: ${errorOf(b).message}`),
    // Fail-closed by design: the read-through copies the revocation marker
    // into L1, so the bearer stays refused on this isolate after Redis heals
    // (a revoked session must never come back). Recovery is not expected.
    recover: false,
  },
  {
    id: "redis-slow-100ms",
    upstream: "redis",
    what:
      "every Upstash pipeline takes 100ms (latency budget = pipelines/request)",
    arm: (h) => h.injectFault("redis", { kind: "delay", ms: 100 }),
    expectStatus: [200],
    recoveryMustReadPostgrest: false,
  },
  {
    id: "redis-down-warm-l1",
    upstream: "redis",
    what: "Redis dies AFTER a warm read — L1 must still serve the rank",
    warm: warmRank,
    arm: (h) => h.injectFault("redis", { kind: "throw" }),
    expectStatus: [200],
    maxLatencyMs: 500,
    recoveryMustReadPostgrest: false,
  },

  // ─ RevenueCat (must never be on this path) ─
  {
    id: "rc-500",
    upstream: "revenuecat",
    what: "RevenueCat 500 — GET /v1/rank must not care (0 RC calls)",
    arm: (h) => h.injectFault("rc", { kind: "http", status: 500 }),
    expectStatus: [200],
    recoveryMustReadPostgrest: false,
  },
  {
    id: "rc-hang",
    upstream: "revenuecat",
    what: "RevenueCat stalls — GET /v1/rank must not care (0 RC calls)",
    arm: (h) => h.injectFault("rc", { kind: "hang" }),
    expectStatus: [200],
    maxLatencyMs: 500,
    recoveryMustReadPostgrest: false,
  },

  // ─ Combined outages ─
  {
    id: "combined-auth-500-redis-down",
    upstream: "combined",
    what: "GoTrue 500 + Upstash unreachable",
    arm: (h) => {
      h.injectFault("auth", { kind: "http", status: 500 });
      h.injectFault("redis", { kind: "throw" });
    },
    expectStatus: [503],
    expectBody: generic5xx,
  },
  {
    id: "combined-rest-500-redis-down",
    upstream: "combined",
    what: "PostgREST 500 + Upstash unreachable",
    arm: (h) => {
      h.injectFault("rest", { kind: "http", status: 500 });
      h.injectFault("redis", { kind: "throw" });
    },
    expectStatus: [503],
    expectBody: generic5xx,
  },
  {
    id: "combined-everything-down",
    upstream: "combined",
    what: "GoTrue + PostgREST + Upstash + RevenueCat all fail",
    env: { AUTH_UPSTREAM_TIMEOUT_MS: "300" },
    arm: (h) => {
      h.injectFault("auth", { kind: "throw" });
      h.injectFault("rest", { kind: "throw" });
      h.injectFault("redis", { kind: "throw" });
      h.injectFault("rc", { kind: "throw" });
    },
    expectStatus: [503],
    expectBody: generic5xx,
    maxLatencyMs: 1_500,
  },
  {
    id: "combined-warm-auth-redis-down-rest-ok",
    upstream: "combined",
    what:
      "auth cache warm, Redis down, PostgREST healthy → 200 from memory-only path",
    warm: warmAuthOnly,
    arm: (h) => h.injectFault("redis", { kind: "throw" }),
    expectStatus: [200],
    recoveryMustReadPostgrest: false,
  },

  // ─ Client-side faults (no upstream may be consulted) ─
  {
    id: "client-expired-bearer",
    upstream: "client",
    what: "expired session bearer → 401 with ZERO upstream round trips",
    arm: (_h, ctx) => {
      ctx.token = forgedSessionToken(ctx.userId, -60);
    },
    expectStatus: [401],
    recover: false,
  },
  {
    id: "client-garbage-bearer",
    upstream: "client",
    what: "non-JWT bearer → 401 with ZERO upstream round trips",
    arm: (_h, ctx) => {
      ctx.token = "not-a-jwt";
    },
    expectStatus: [401],
    recover: false,
  },
  {
    id: "client-forged-bearer",
    upstream: "client",
    what: "well-formed Supabase-shaped bearer GoTrue never issued → 401",
    arm: (_h, ctx) => {
      ctx.token = forgedSessionToken(ctx.userId);
    },
    expectStatus: [401],
    // The signature is not verified locally, so GoTrue must be asked once.
    allowedRoundTrips: { auth: 1, rest: 0 },
    recover: false,
  },
];

// ── Runner ──────────────────────────────────────────────────────────────────

const FILE = "stress_rank_faults.test.ts";

async function runCase(c: FaultCase): Promise<Outcome> {
  const seed = caseSeed(STRESS_SEED, c.id);
  const prng = new Prng(seed);
  h.reset();
  const seeded = seedUser(h, prng, c.user);
  const ctx: Ctx = {
    prng,
    userId: seeded.userId,
    token: seeded.token,
    ip: seeded.ip,
    rating: seeded.rating,
  };
  const envBackup: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(c.env ?? {})) {
    envBackup[k] = Deno.env.get(k);
    Deno.env.set(k, v);
  }
  const reasons: string[] = [];
  const outcome: Outcome = {
    id: c.id,
    seed,
    upstream: c.upstream,
    what: c.what,
    status: 0,
    errorMessage: null,
    errorCode: null,
    retryAfter: null,
    requestId: null,
    latencyMs: 0,
    roundTrips: { auth: 0, rest: 0, redis: 0, rc: 0 },
    faultHits: 0,
    leaked: null,
    bodySnippet: "",
    recovery: null,
    verdict: "HELD",
    knownBroken: c.knownBroken ?? null,
    reasons,
    replay:
      `STRESS_SEED=${STRESS_SEED} deno test -A --no-check --config deno.json ${FILE} --filter "${c.id}"`,
  };
  try {
    if (c.warm) await c.warm(h, ctx);
    c.arm(h, ctx);
    const mark = h.calls.length;
    const started = performance.now();
    const pending = h.handler(rankRequest(ctx.token, ctx.ip));
    let response: Response | null = null;
    if (c.hangProbeMs !== undefined) {
      const probe = await Promise.race([
        pending.then((r) => r),
        sleep(c.hangProbeMs).then(() => null),
      ]);
      if (probe === null) {
        outcome.status = "hung";
        outcome.latencyMs = Math.round(performance.now() - started);
        reasons.push(
          `no answer after ${c.hangProbeMs}ms while ${c.what}; expected a bounded ${
            c.expectStatus.join("/")
          }`,
        );
        h.releaseHangs();
        response = await pending;
        outcome.recovery = null;
      } else {
        response = probe;
      }
    } else {
      response = await pending;
    }
    const latency = Math.round((performance.now() - started) * 100) / 100;
    if (outcome.status !== "hung") {
      outcome.status = response.status;
      outcome.latencyMs = latency;
    }
    const faulted = h.callsSince(mark);
    outcome.roundTrips = roundTrips(faulted);
    outcome.faultHits = h.faults.reduce((n, f) => n + f.hits, 0);
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(text) as unknown;
      body = isRecord(parsed) ? parsed : { _value: parsed };
    } catch {
      body = { _raw: text };
    }
    const err = errorOf(body);
    outcome.errorMessage = err.message;
    outcome.errorCode = err.code;
    outcome.retryAfter = response.headers.get("Retry-After");
    outcome.requestId = response.headers.get("x-request-id");
    outcome.leaked = leakIn(text);
    outcome.bodySnippet = text.slice(0, 200);

    if (outcome.status !== "hung") {
      if (!c.expectStatus.includes(response.status)) {
        reasons.push(
          `status ${response.status} not in expected [${
            c.expectStatus.join(", ")
          }] (body: ${text.slice(0, 160)})`,
        );
      }
      if (c.expectBody) {
        const why = c.expectBody(body, response);
        if (why) reasons.push(why);
      }
      if (response.status === 200 && !c.expectBody) {
        const why = rankOk(ctx.rating)(body);
        if (why) reasons.push(`200 body wrong: ${why}`);
      }
      if (c.maxLatencyMs !== undefined && latency > c.maxLatencyMs) {
        reasons.push(`took ${latency}ms > ${c.maxLatencyMs}ms budget`);
      }
    }
    if (outcome.leaked) {
      reasons.push(
        `upstream detail leaked to client body: "${outcome.leaked}"`,
      );
    }
    if (!outcome.requestId) reasons.push("no x-request-id header");
    if (c.upstream === "revenuecat" && outcome.roundTrips.rc > 0) {
      reasons.push("RevenueCat was called on the rank path");
    }
    if (c.upstream === "client") {
      const allowed = c.allowedRoundTrips ?? { auth: 0, rest: 0 };
      if (
        outcome.roundTrips.auth > allowed.auth ||
        outcome.roundTrips.rest > allowed.rest
      ) {
        reasons.push(
          `client-caused 401 cost ${outcome.roundTrips.auth} auth + ${outcome.roundTrips.rest} rest round trips (allowed ${allowed.auth}/${allowed.rest})`,
        );
      }
    }

    // ── Recoverability: clear the fault, next request must be a clean 200 ──
    if (c.recover !== false) {
      h.clearFaults();
      h.releaseHangs();
      for (const [k, v] of Object.entries(envBackup)) {
        if (v === undefined) Deno.env.delete(k);
        else Deno.env.set(k, v);
      }
      const rmark = h.calls.length;
      const recovered = await h.handler(rankRequest(ctx.token, ctx.ip));
      const rbody = await readJson(recovered);
      const rcalls = h.callsSince(rmark);
      const restReads = rcalls.filter((x) => x.target === "rest").length;
      const authReads = rcalls.filter((x) => x.target === "auth").length;
      const rating = isRecord(rbody.rank) ? rbody.rank.rating : rbody.rank;
      let detail: string | null = null;
      if (recovered.status !== 200) {
        detail = `recovery status ${recovered.status}: ${
          JSON.stringify(rbody).slice(0, 160)
        }`;
      } else {
        const why = rankOk(ctx.rating)(rbody);
        if (why) detail = `recovery payload wrong: ${why}`;
      }
      const mustRead = c.recoveryMustReadPostgrest ?? (outcome.status !== 200);
      if (!detail && mustRead && restReads === 0) {
        detail =
          "recovery served from cache without re-reading PostgREST — the failure was cached";
      }
      outcome.recovery = {
        status: recovered.status,
        rating,
        restReads,
        authReads,
        ok: detail === null,
        detail,
      };
      if (detail) reasons.push(detail);
    }
  } finally {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    h.releaseHangs();
    h.clearFaults();
  }
  outcome.verdict = reasons.length === 0 ? "HELD" : "BROKEN";
  results.push(outcome);
  return outcome;
}

for (const c of cases) {
  Deno.test(`stress-rank-fault ${c.id} — ${c.what}`, async () => {
    const outcome = await runCase(c);
    if (c.knownBroken) {
      if (outcome.verdict === "HELD") {
        throw new Error(
          `${c.id} (seed ${outcome.seed}) is pinned as ${c.knownBroken} but now HELD — the defect is fixed; remove the knownBroken pin`,
        );
      }
      console.log(
        `[stress-rank-faults] ${c.id} reproduces ${c.knownBroken}: ${
          outcome.reasons.join(" | ")
        }`,
      );
      return;
    }
    if (outcome.verdict === "BROKEN") {
      throw new Error(
        `${c.id} (seed ${outcome.seed}) BROKEN:\n  - ${
          outcome.reasons.join("\n  - ")
        }\n  replay: ${outcome.replay}`,
      );
    }
  });
}

// Extra: a concurrent burst hitting the fault (single-flight must fail the
// whole burst ONCE and leave no stuck in-flight entry behind).
Deno.test("stress-rank-fault burst-500-coalesced — 12 concurrent misses share one failing build, then recover", async () => {
  const seed = caseSeed(STRESS_SEED, "burst-500-coalesced");
  const prng = new Prng(seed);
  h.reset();
  const u = seedUser(h, prng);
  await warmAuthOnly(h, { prng, ...u });
  h.injectFault("rest", { kind: "delay", ms: 40 }, {
    table: "player_rank_state",
  });
  h.injectFault("rest", { kind: "http", status: 500 }, {
    table: "player_technique_rating",
  });
  const mark = h.calls.length;
  const burst = await Promise.all(
    Array.from({ length: 12 }, () => h.handler(rankRequest(u.token, u.ip))),
  );
  const statuses = burst.map((r) => r.status);
  await Promise.all(burst.map((r) => r.text()));
  const restCalls = h.callsSince(mark).filter((c) => c.target === "rest");
  const techniqueReads =
    restCalls.filter((c) => c.detail === "player_technique_rating").length;
  h.clearFaults();
  const rmark = h.calls.length;
  const recovered = await h.handler(rankRequest(u.token, u.ip));
  const rbody = await readJson(recovered);
  const outcome = {
    id: "burst-500-coalesced",
    seed,
    statuses: histogram(statuses),
    techniqueReadsDuringBurst: techniqueReads,
    recoveryStatus: recovered.status,
    recoveryRestReads:
      h.callsSince(rmark).filter((c) => c.target === "rest").length,
    recoveryRating: isRecord(rbody.rank) ? rbody.rank.rating : rbody.rank,
    replay:
      `STRESS_SEED=${STRESS_SEED} deno test -A --no-check --config deno.json ${FILE} --filter "burst-500-coalesced"`,
  };
  results.push({
    ...outcome,
    upstream: "postgrest",
    what: "12 concurrent misses during a 500",
    status: statuses[0],
    errorMessage: null,
    errorCode: null,
    retryAfter: null,
    requestId: null,
    latencyMs: 0,
    roundTrips: roundTrips(h.callsSince(mark)),
    faultHits: techniqueReads,
    leaked: null,
    bodySnippet: "",
    recovery: {
      status: recovered.status,
      rating: outcome.recoveryRating,
      restReads: outcome.recoveryRestReads,
      authReads: 0,
      ok: recovered.status === 200,
      detail: null,
    },
    verdict: statuses.every((s) =>
        s === 503
      ) && techniqueReads === 1 && recovered.status === 200
      ? "HELD"
      : "BROKEN",
    knownBroken: null,
    reasons: [],
  } as Outcome);
  assert(
    statuses.every((s) => s === 503),
    `burst statuses ${JSON.stringify(histogram(statuses))}`,
  );
  assertEquals(
    techniqueReads,
    1,
    "single-flight: one failing PostgREST read for the whole burst",
  );
  assertEquals(recovered.status, 200);
  assertEquals(isRecord(rbody.rank) ? rbody.rank.rating : null, u.rating);
});

Deno.test("stress-rank-fault matrix — write faults_<seed>.json (≥40 cases executed)", async () => {
  const path = await writeArtifact(`faults_${STRESS_SEED}`, {
    file: FILE,
    seed: STRESS_SEED,
    executed: results.length,
    verdicts: histogram(results.map((r) => r.verdict)),
    byUpstream: histogram(results.map((r) => r.upstream)),
    statuses: histogram(results.map((r) => String(r.status))),
    broken: results.filter((r) => r.verdict === "BROKEN").map((r) => ({
      id: r.id,
      seed: r.seed,
      finding: r.knownBroken,
      reasons: r.reasons,
      replay: r.replay,
    })),
    unpinnedBroken: results.filter((r) =>
      r.verdict === "BROKEN" && r.knownBroken === null
    ).map((r) => r.id),
    cases: results,
  });
  console.log(`[stress-rank-faults] ${results.length} cases → ${path}`);
  assert(results.length >= 40, `matrix executed ${results.length} < 40 cases`);
});
