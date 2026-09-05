/**
 * stress — FAILURE INJECTION for `POST /v1/shots:sync` (no Upstash tier;
 * cache + rate limits on per-isolate memory, as in the fallback deployment).
 *
 * For every fault case: seed → fresh world (user, permits, batch) → optional
 * warm-up so the auth cache holds the bearer → the faulted request → the
 * client's verdict per shot (apps/mobile/src/data/sync.ts classes) → the
 * fault is lifted and the SAME batch is re-sent, exactly as the outbox does.
 *
 * HELD means: the user-visible class matches the contract (retryable faults
 * never burn the outbox budget, verdicts do), the replay converges (every
 * shot ends with exactly ONE row and a finalized permit), and no fault ever
 * makes the edge acknowledge a shot that was not written (that is the data
 * loss case) or write it twice (double delivery / double spend).
 *
 *   STRESS_ITER=N   iterations (fresh seed) per case         (default 1)
 *   STRESS_SEED=S   base seed                                (default 20260904)
 *   STRESS_SLOW=1   also run the multi-second cases (supabase-js backoff,
 *                   deadline-less hangs)                     (default off)
 *   STRESS_OUT_DIR  where the JSON evidence lands
 *
 * Replay one case:  STRESS_SEED=<seed> deno test -A --filter "<case id>" stress_shots_sync_failure.test.ts
 */
import { assert, assertEquals } from "@std/assert";
import {
  type BatchShot,
  type CaseRow,
  caseSeed,
  classifyForShot,
  type ClientClass,
  drive,
  type FaultAction,
  type FaultPlan,
  loadStressHarness,
  makeBatch,
  mintUser,
  permitStatus,
  Prng,
  recoverable,
  shotRows,
  STRESS_AUTH_TIMEOUT_MS,
  STRESS_ITER,
  STRESS_SEED,
  STRESS_SLOW,
  type StressHarness,
  type StressUser,
  type SyncOutcome,
  syncRequest,
  type Upstream,
  writeJson,
} from "./stress_shots_sync_harness.ts";

const SUITE = "failure.memory-tier";

interface World {
  prng: Prng;
  user: StressUser;
  batch: BatchShot[];
}

interface Expectation {
  /** Expected HTTP status of the faulted request. */
  status: number;
  /** Expected client class for every shot of the batch (or per index). */
  shotClass: ClientClass | ((index: number) => ClientClass);
  /** Expected Retry-After presence on the faulted answer. */
  retryAfter?: "present" | "absent";
  /** Expected error.code on a non-200 answer. */
  errorCode?: string;
  /** Round-trip predicate on the faulted request. */
  roundTrips?: (rt: Record<Upstream, number>) => boolean;
  roundTripsNote?: string;
  /** Minimum latency of the faulted request (ms) — deadline evidence. */
  minLatencyMs?: number;
  /** Maximum latency of the faulted request (ms) — deadline evidence. */
  maxLatencyMs?: number;
}

interface FaultCase {
  id: string;
  upstream: string;
  fault: string;
  /** Multi-second case; only with STRESS_SLOW=1. */
  slow?: boolean;
  /** Shots per batch; default drawn from the seed in [1, 4]. */
  batch?: number;
  /** Warm the auth cache before the faulted request (default: not for
   * gotrue cases, yes otherwise). */
  warm?: boolean;
  plan: (world: World) => FaultPlan;
  expect: Expectation;
  /** After lifting the fault, replay the same batch and require convergence
   * (default true). `false` for verdict cases where the replay must keep
   * returning the same verdict. */
  replayConverges?: boolean;
  /** A fault plan for an INTERMEDIATE replay (the outbox retrying while the
   * backend is still degraded) with its expected status; the clean replay
   * follows. */
  degradedReplay?: { plan: FaultPlan; status: number };
  /** Documented deviation this case pins (reported as a finding, not HELD). */
  finding?: string;
  /** Extra model invariants after the replay. */
  after?: (
    h: StressHarness,
    world: World,
    faulted: SyncOutcome,
    replay: SyncOutcome | null,
  ) => Array<{ name: string; holds: boolean; detail: string }>;
}

const http = (
  status: number,
  body: string,
  headers?: Record<string, string>,
): FaultAction => ({
  kind: "http",
  status,
  body,
  headers,
});
const always = (upstream: Upstream, action: FaultAction): FaultPlan => (call) =>
  call.upstream === upstream ? action : null;
const nth =
  (upstream: Upstream, index: number, action: FaultAction): FaultPlan =>
  (call) => call.upstream === upstream && call.nth === index ? action : null;
const first = (upstream: Upstream, action: FaultAction): FaultPlan =>
  nth(upstream, 0, action);

const GOTRUE_500 = JSON.stringify({ code: 500, msg: "Internal server error" });
const HTML_502 = "<html><body><h1>502 Bad Gateway</h1></body></html>";
const PGRST_500 = JSON.stringify({
  code: "XX000",
  message: "internal_error",
  details: null,
  hint: null,
});
const PGRST_503 = JSON.stringify({
  code: "PGRST002",
  message: "schema cache not loaded",
});
const PGRST_401 = JSON.stringify({ code: "PGRST301", message: "JWT expired" });
const PGRST_404_TABLE = JSON.stringify({
  code: "PGRST205",
  message: "relation not found",
});
const PGRST_404_FN = JSON.stringify({
  code: "PGRST202",
  message: "Could not find the function public.apply_synced_shot(shot)",
});
const PG_42501 = JSON.stringify({
  code: "42501",
  message: "permission denied for table shots",
});
const PG_57014 = JSON.stringify({
  code: "57014",
  message: "canceling statement due to statement timeout",
});
const PG_40P01 = JSON.stringify({
  code: "40P01",
  message: "deadlock detected",
});
const PG_53300 = JSON.stringify({
  code: "53300",
  message: "too many connections",
});

const transientAll = (
  status: number,
  extra: Partial<Expectation> = {},
): Expectation => ({
  status,
  shotClass: "retry.transient",
  ...extra,
});
const itemTransient = (extra: Partial<Expectation> = {}): Expectation => ({
  status: 200,
  shotClass: "retry.transient-item",
  ...extra,
});

/** Cold path (no warm-up): getUser + SELECT + one RPC per shot. */
const coldTrips = (n: number) => (rt: Record<Upstream, number>) =>
  rt["gotrue.user"] === 1 && rt["rest.select"] === 1 && rt["rest.rpc"] === n;
/** Warm path: SELECT + one RPC per shot; no Auth call. */
const warmTrips = (n: number) => (rt: Record<Upstream, number>) =>
  rt["gotrue.user"] === 0 && rt["rest.select"] === 1 && rt["rest.rpc"] === n;
const noDb = (rt: Record<Upstream, number>) =>
  rt["rest.select"] === 0 && rt["rest.rpc"] === 0;

const CASES: FaultCase[] = [
  // ── Supabase Auth (GoTrue GET /auth/v1/user) ────────────────────────────
  {
    id: "auth-500-json",
    upstream: "gotrue.user",
    fault: "HTTP 500 JSON",
    plan: () => always("gotrue.user", http(500, GOTRUE_500)),
    expect: transientAll(503, { retryAfter: "present", roundTrips: noDb }),
  },
  {
    id: "auth-502-html",
    upstream: "gotrue.user",
    fault: "HTTP 502 HTML gateway page",
    plan: () =>
      always(
        "gotrue.user",
        http(502, HTML_502, { "Content-Type": "text/html" }),
      ),
    expect: transientAll(503, { retryAfter: "present", roundTrips: noDb }),
  },
  {
    id: "auth-503-retry-after",
    upstream: "gotrue.user",
    fault: "HTTP 503 + Retry-After: 7",
    plan: () => always("gotrue.user", http(503, "{}", { "Retry-After": "7" })),
    expect: transientAll(503, { retryAfter: "present", roundTrips: noDb }),
    after: (_h, _w, faulted) => [
      {
        name: "upstream Retry-After forwarded",
        holds: faulted.retryAfter === "7",
        detail: `Retry-After=${faulted.retryAfter}`,
      },
    ],
  },
  {
    id: "auth-504",
    upstream: "gotrue.user",
    fault: "HTTP 504",
    plan: () => always("gotrue.user", http(504, "")),
    expect: transientAll(503, { retryAfter: "present", roundTrips: noDb }),
  },
  {
    id: "auth-429",
    upstream: "gotrue.user",
    fault: "HTTP 429 + Retry-After: 3 (GoTrue rate limit)",
    plan: () =>
      always(
        "gotrue.user",
        http(429, JSON.stringify({ msg: "rate limit" }), {
          "Retry-After": "3",
        }),
      ),
    expect: transientAll(503, { retryAfter: "present", roundTrips: noDb }),
    after: (_h, _w, faulted) => [
      {
        name: "GoTrue 429 is the service, not the credential (503 not 401)",
        holds: faulted.status === 503 && faulted.retryAfter === "3",
        detail: `status=${faulted.status} Retry-After=${faulted.retryAfter}`,
      },
    ],
  },
  {
    id: "auth-401-bad-jwt",
    upstream: "gotrue.user",
    fault: "HTTP 401 invalid JWT (credential refused)",
    plan: () =>
      always(
        "gotrue.user",
        http(401, JSON.stringify({ code: 401, msg: "invalid JWT" })),
      ),
    expect: transientAll(401, { roundTrips: noDb }),
  },
  {
    id: "auth-403-session-gone",
    upstream: "gotrue.user",
    fault: "HTTP 403 session_not_found",
    plan: () =>
      always(
        "gotrue.user",
        http(403, JSON.stringify({ error_code: "session_not_found" })),
      ),
    expect: transientAll(401, { roundTrips: noDb }),
  },
  {
    id: "auth-400",
    upstream: "gotrue.user",
    fault: "HTTP 400 (refusal status)",
    plan: () =>
      always(
        "gotrue.user",
        http(400, JSON.stringify({ error: "invalid_request" })),
      ),
    expect: transientAll(401, { roundTrips: noDb }),
  },
  {
    id: "auth-200-non-json",
    upstream: "gotrue.user",
    fault: "HTTP 200 non-JSON body",
    plan: () => always("gotrue.user", http(200, "<!doctype html>ok")),
    expect: transientAll(503, { retryAfter: "present", roundTrips: noDb }),
  },
  {
    id: "auth-200-empty-object",
    upstream: "gotrue.user",
    fault: "HTTP 200 {} (no user id)",
    plan: () => always("gotrue.user", http(200, "{}")),
    expect: transientAll(503, { retryAfter: "present", roundTrips: noDb }),
  },
  {
    id: "auth-200-array",
    upstream: "gotrue.user",
    fault: "HTTP 200 [] (wrong shape)",
    plan: () => always("gotrue.user", http(200, "[]")),
    expect: transientAll(503, { retryAfter: "present", roundTrips: noDb }),
  },
  {
    id: "auth-200-empty-body",
    upstream: "gotrue.user",
    fault: "HTTP 200 empty body",
    plan: () => always("gotrue.user", http(200, "")),
    expect: transientAll(503, { retryAfter: "present", roundTrips: noDb }),
  },
  {
    id: "auth-200-other-users-id",
    upstream: "gotrue.user",
    fault: "HTTP 200 user record of ANOTHER user (upstream confusion)",
    batch: 1,
    plan: ({ prng }) => {
      const other = prng.uuid();
      return always(
        "gotrue.user",
        http(
          200,
          JSON.stringify({
            id: other,
            aud: "authenticated",
            role: "authenticated",
            email: "other@example.com",
            app_metadata: { provider: "google", providers: ["google"] },
            user_metadata: {},
          }),
        ),
      );
    },
    // PostgREST derives auth.uid() from the BEARER, not from GoTrue's answer,
    // so the replay SELECT (filtered on the confused id) finds nothing and
    // the RPC writes under the true owner. The row lands where it belongs;
    // only the edge-side cache keys (rank/progress invalidation, auth cache
    // identity) are computed for the wrong id.
    expect: { status: 200, shotClass: "accepted", roundTrips: coldTrips(1) },
    after: (h, world) => [
      {
        name:
          "row written for the bearer's owner (RLS follows the JWT, not GoTrue's body)",
        holds: h.fake.tables.shots.length === 1 &&
          h.fake.tables.shots[0].user_id === world.user.id,
        detail: `shots=${h.fake.tables.shots.length} owner=${
          String(h.fake.tables.shots[0]?.user_id ?? "none").slice(0, 8)
        } jwt=${world.user.id.slice(0, 8)}`,
      },
    ],
  },
  {
    id: "auth-throw-once",
    upstream: "gotrue.user",
    fault: "connection reset on the 1st attempt, healthy after",
    batch: 1,
    plan: () =>
      first("gotrue.user", {
        kind: "throw",
        message: "connection reset by peer",
      }),
    // The edge re-sends inside its own deadline: the request succeeds and
    // the user never sees the blip.
    expect: {
      status: 200,
      shotClass: "accepted",
      roundTrips: (rt) =>
        rt["gotrue.user"] === 2 && rt["rest.select"] === 1 &&
        rt["rest.rpc"] === 1,
      roundTripsNote: "2 Auth attempts (1 retry after 100 ms backoff)",
      minLatencyMs: 90,
    },
  },
  {
    id: "auth-throw-always",
    upstream: "gotrue.user",
    fault: "connection refused on every attempt",
    plan: () =>
      always("gotrue.user", { kind: "throw", message: "connection refused" }),
    expect: transientAll(503, {
      retryAfter: "present",
      roundTrips: (rt) =>
        rt["gotrue.user"] >= 2 && rt["gotrue.user"] <= 4 && noDb(rt),
      roundTripsNote:
        `backoff 100+200 ms inside the ${STRESS_AUTH_TIMEOUT_MS} ms deadline`,
      minLatencyMs: 250,
      maxLatencyMs: STRESS_AUTH_TIMEOUT_MS + 400,
    }),
  },
  {
    id: "auth-hang",
    upstream: "gotrue.user",
    fault:
      `socket accepted, no answer (edge deadline ${STRESS_AUTH_TIMEOUT_MS} ms)`,
    plan: () =>
      always("gotrue.user", { kind: "hang", ms: STRESS_AUTH_TIMEOUT_MS * 4 }),
    expect: transientAll(503, {
      retryAfter: "present",
      roundTrips: (rt) => rt["gotrue.user"] === 1 && noDb(rt),
      minLatencyMs: STRESS_AUTH_TIMEOUT_MS - 20,
      maxLatencyMs: STRESS_AUTH_TIMEOUT_MS + 400,
    }),
  },
  {
    id: "auth-slow-under-deadline",
    upstream: "gotrue.user",
    fault: `answers after ${
      Math.round(STRESS_AUTH_TIMEOUT_MS / 3)
    } ms (inside deadline)`,
    batch: 1,
    plan: () =>
      always("gotrue.user", {
        kind: "slow",
        ms: Math.round(STRESS_AUTH_TIMEOUT_MS / 3),
      }),
    expect: {
      status: 200,
      shotClass: "accepted",
      roundTrips: coldTrips(1),
      minLatencyMs: Math.round(STRESS_AUTH_TIMEOUT_MS / 3) - 20,
    },
  },

  // ── Supabase DB / PostgREST — replay SELECT ──────────────────────────────
  {
    id: "select-500",
    upstream: "rest.select",
    fault: "HTTP 500 PostgREST error body",
    plan: () => always("rest.select", http(500, PGRST_500)),
    expect: transientAll(503, {
      roundTrips: (rt) => rt["rest.select"] === 1 && rt["rest.rpc"] === 0,
      roundTripsNote: "500 is not retried by supabase-js; no RPC issued",
    }),
  },
  {
    id: "select-42501",
    upstream: "rest.select",
    fault: "HTTP 403 42501 permission denied (grant drift)",
    plan: () => always("rest.select", http(403, PG_42501)),
    expect: transientAll(503, {
      roundTrips: (rt) => rt["rest.select"] === 1 && rt["rest.rpc"] === 0,
    }),
  },
  {
    id: "select-401-jwt-expired",
    upstream: "rest.select",
    fault: "HTTP 401 PGRST301 JWT expired at PostgREST",
    plan: () => always("rest.select", http(401, PGRST_401)),
    expect: transientAll(503, {
      roundTrips: (rt) => rt["rest.select"] === 1 && rt["rest.rpc"] === 0,
    }),
  },
  {
    id: "select-404-schema-cache",
    upstream: "rest.select",
    fault: "HTTP 404 PGRST205 relation not in schema cache",
    plan: () => always("rest.select", http(404, PGRST_404_TABLE)),
    expect: transientAll(503, {
      roundTrips: (rt) => rt["rest.select"] === 1 && rt["rest.rpc"] === 0,
    }),
  },
  {
    id: "select-503-retry-after-0",
    upstream: "rest.select",
    fault: "HTTP 503 + Retry-After: 0 (supabase-js retries GET 3×)",
    plan: () =>
      always("rest.select", http(503, PGRST_503, { "Retry-After": "0" })),
    expect: transientAll(503, {
      roundTrips: (rt) => rt["rest.select"] === 4 && rt["rest.rpc"] === 0,
      roundTripsNote: "1 + 3 supabase-js retries",
    }),
  },
  {
    id: "select-503-retry-after-1",
    upstream: "rest.select",
    fault: "HTTP 503 + Retry-After: 1 (edge stalls 3 s in supabase-js backoff)",
    slow: true,
    plan: () =>
      always("rest.select", http(503, PGRST_503, { "Retry-After": "1" })),
    expect: transientAll(503, {
      roundTrips: (rt) => rt["rest.select"] === 4 && rt["rest.rpc"] === 0,
      minLatencyMs: 2_900,
    }),
  },
  {
    id: "select-520",
    upstream: "rest.select",
    fault: "HTTP 520 (Cloudflare) no Retry-After (1+2+4 s backoff)",
    slow: true,
    plan: () => always("rest.select", http(520, "")),
    expect: transientAll(503, {
      roundTrips: (rt) => rt["rest.select"] === 4 && rt["rest.rpc"] === 0,
      minLatencyMs: 6_900,
    }),
  },
  {
    id: "select-throw",
    upstream: "rest.select",
    fault:
      "connection failure on every attempt (GET retried 3× with 1+2+4 s backoff)",
    slow: true,
    plan: () =>
      always("rest.select", { kind: "throw", message: "connection reset" }),
    expect: transientAll(503, {
      roundTrips: (rt) => rt["rest.select"] === 4 && rt["rest.rpc"] === 0,
      minLatencyMs: 6_900,
    }),
  },
  {
    id: "select-throw-once",
    upstream: "rest.select",
    fault: "connection failure once, healthy after (1 s supabase-js backoff)",
    slow: true,
    plan: () =>
      first("rest.select", { kind: "throw", message: "connection reset" }),
    expect: {
      status: 200,
      shotClass: "accepted",
      roundTrips: (rt) => rt["rest.select"] === 2 && rt["gotrue.user"] === 0,
      minLatencyMs: 950,
    },
  },
  {
    id: "select-200-non-json",
    upstream: "rest.select",
    fault: "HTTP 200 non-JSON body",
    plan: () => always("rest.select", http(200, "<html>proxy</html>")),
    expect: transientAll(503, {
      roundTrips: (rt) => rt["rest.select"] === 1 && rt["rest.rpc"] === 0,
    }),
  },
  {
    id: "select-200-object",
    upstream: "rest.select",
    fault: "HTTP 200 {} (object where an array is due)",
    plan: () => always("rest.select", http(200, "{}")),
    // `.map` on a non-array throws inside the route → generic 500. Still
    // retryable for the client (5xx), but the class is a crash, not a 503.
    expect: transientAll(500, {
      roundTrips: (rt) => rt["rest.select"] === 1 && rt["rest.rpc"] === 0,
    }),
    finding:
      "non-array 2xx from PostgREST crashes the route (500 without Retry-After) instead of the 503 every other malformed answer gets",
  },
  {
    id: "select-200-null",
    upstream: "rest.select",
    fault: "HTTP 200 null body",
    plan: () => always("rest.select", http(200, "null")),
    // No replays known → every shot goes to the RPC, which is itself
    // idempotent, so the batch still converges.
    expect: { status: 200, shotClass: "accepted" },
  },
  {
    id: "select-200-numeric-ids",
    upstream: "rest.select",
    fault: "HTTP 200 rows with numeric ids",
    plan: () =>
      always("rest.select", http(200, JSON.stringify([{ id: 1 }, { id: 2 }]))),
    expect: { status: 200, shotClass: "accepted" },
  },
  {
    id: "select-200-foreign-ids",
    upstream: "rest.select",
    fault: "HTTP 200 rows of unrelated shot ids",
    plan: ({ prng }) =>
      always(
        "rest.select",
        http(200, JSON.stringify([{ id: prng.uuid() }, { id: prng.uuid() }])),
      ),
    expect: { status: 200, shotClass: "accepted" },
  },
  {
    id: "select-slow-no-deadline",
    upstream: "rest.select",
    fault: "answers after 1500 ms — the edge has no deadline on PostgREST",
    slow: true,
    batch: 1,
    plan: () => always("rest.select", { kind: "slow", ms: 1_500 }),
    expect: {
      status: 200,
      shotClass: "accepted",
      minLatencyMs: 1_450,
      roundTrips: warmTrips(1),
    },
  },

  // ── Supabase DB / PostgREST — apply_synced_shot RPC ──────────────────────
  {
    id: "rpc-500",
    upstream: "rest.rpc",
    fault: "HTTP 500 PostgREST error body",
    plan: () => always("rest.rpc", http(500, PGRST_500)),
    expect: itemTransient({
      roundTripsNote: "POST is never retried by supabase-js",
    }),
  },
  {
    id: "rpc-503",
    upstream: "rest.rpc",
    fault: "HTTP 503 (POST: no supabase-js retry)",
    plan: () =>
      always("rest.rpc", http(503, PGRST_503, { "Retry-After": "1" })),
    expect: itemTransient({ maxLatencyMs: 500 }),
  },
  {
    id: "rpc-401-jwt-expired",
    upstream: "rest.rpc",
    fault: "HTTP 401 PGRST301 JWT expired",
    plan: () => always("rest.rpc", http(401, PGRST_401)),
    expect: itemTransient(),
  },
  {
    id: "rpc-404-function-missing",
    upstream: "rest.rpc",
    fault: "HTTP 404 PGRST202 function not found (migration drift)",
    plan: () => always("rest.rpc", http(404, PGRST_404_FN)),
    expect: itemTransient(),
  },
  {
    id: "rpc-statement-timeout",
    upstream: "rest.rpc",
    fault: "HTTP 500 57014 statement timeout",
    plan: () => always("rest.rpc", http(500, PG_57014)),
    expect: itemTransient(),
  },
  {
    id: "rpc-deadlock",
    upstream: "rest.rpc",
    fault: "HTTP 500 40P01 deadlock detected",
    plan: () => always("rest.rpc", http(500, PG_40P01)),
    expect: itemTransient(),
  },
  {
    id: "rpc-too-many-connections",
    upstream: "rest.rpc",
    fault: "HTTP 503 53300 too many connections",
    plan: () => always("rest.rpc", http(503, PG_53300)),
    expect: itemTransient(),
  },
  {
    id: "rpc-throw",
    upstream: "rest.rpc",
    fault: "connection failure (POST: not retried)",
    plan: () =>
      always("rest.rpc", { kind: "throw", message: "connection reset" }),
    expect: itemTransient(),
  },
  {
    id: "rpc-200-non-json",
    upstream: "rest.rpc",
    fault: "HTTP 200 non-JSON body",
    plan: () => always("rest.rpc", http(200, "<html>proxy</html>")),
    expect: itemTransient(),
  },
  {
    id: "rpc-200-empty-body",
    upstream: "rest.rpc",
    fault: "HTTP 200 empty body",
    plan: () => always("rest.rpc", http(200, "")),
    expect: itemTransient(),
  },
  {
    id: "rpc-200-null",
    upstream: "rest.rpc",
    fault: "HTTP 200 null",
    plan: () => always("rest.rpc", http(200, "null")),
    expect: itemTransient(),
  },
  {
    id: "rpc-200-object",
    upstream: "rest.rpc",
    fault: "HTTP 200 {} (object where a text scalar is due)",
    plan: () => always("rest.rpc", http(200, "{}")),
    expect: itemTransient(),
  },
  {
    id: "rpc-200-accepted-with-space",
    upstream: "rest.rpc",
    fault: 'HTTP 200 "accepted " (near-miss status)',
    plan: () => always("rest.rpc", http(200, JSON.stringify("accepted "))),
    expect: itemTransient(),
  },
  {
    id: "rpc-200-unknown-status",
    upstream: "rest.rpc",
    fault: 'HTTP 200 "totally.unknown_status"',
    plan: () =>
      always("rest.rpc", http(200, JSON.stringify("totally.unknown_status"))),
    expect: itemTransient(),
  },
  {
    id: "rpc-200-write-failed-sqlstate",
    upstream: "rest.rpc",
    fault: 'HTTP 200 "shot.write_failed:23514" (RPC-side exception handler)',
    plan: () =>
      always("rest.rpc", http(200, JSON.stringify("shot.write_failed:23514"))),
    expect: itemTransient(),
  },
  {
    id: "rpc-200-array-wrapped-accepted",
    upstream: "rest.rpc",
    fault: 'HTTP 200 ["accepted"] with NO write performed',
    batch: 1,
    plan: () => always("rest.rpc", http(200, JSON.stringify(["accepted"]))),
    // String(["accepted"]) === "accepted": the edge acknowledges a shot the
    // database never wrote. Documented laxity; the body shape cannot come
    // from a `returns text` function through PostgREST.
    expect: { status: 200, shotClass: "accepted" },
    replayConverges: false,
    finding:
      'String(applied.data) accepts ["accepted"] as the accepted status: an array-wrapped answer acknowledges a shot the DB never wrote',
    after: (h, world) => [
      {
        name:
          "observed: acknowledged without a row (parser accepts array-wrapped status)",
        holds: shotRows(h, world.batch[0].id) === 0,
        detail: `rows=${shotRows(h, world.batch[0].id)}`,
      },
    ],
  },
  {
    id: "rpc-200-prototype-key-status",
    upstream: "rest.rpc",
    fault: 'HTTP 200 "toString" (Object.prototype key passes `in` lookup)',
    batch: 1,
    plan: () => always("rest.rpc", http(200, JSON.stringify("toString"))),
    // `"toString" in SYNC_STATUS_MESSAGES` is true, so the shot is rejected
    // with code "toString" and no message — a permanent verdict for the
    // client instead of the transient shot.write_failed every other unknown
    // status gets.
    expect: { status: 200, shotClass: "reject.permanent-item" },
    replayConverges: true,
    finding:
      '`status in SYNC_STATUS_MESSAGES` is true for Object.prototype keys: a "toString" status is rejected with code "toString" and no message (permanent for the client) instead of the transient shot.write_failed',
    after: (_h, _w, faulted) => [
      {
        name: "observed: rejection code is the prototype key with no message",
        holds: faulted.rejected[0]?.code === "toString" &&
          faulted.rejected[0]?.message === undefined,
        detail: JSON.stringify(faulted.rejected[0] ?? null),
      },
    ],
  },
  {
    id: "rpc-200-paywall-verdict",
    upstream: "rest.rpc",
    fault: 'HTTP 200 "access.paywall_required" (contract verdict)',
    plan: () =>
      always("rest.rpc", http(200, JSON.stringify("access.paywall_required"))),
    expect: { status: 200, shotClass: "reject.permanent-item" },
  },
  {
    id: "rpc-200-permit-not-found-verdict",
    upstream: "rest.rpc",
    fault: 'HTTP 200 "access.permit_not_found" (contract verdict)',
    plan: () =>
      always("rest.rpc", http(200, JSON.stringify("access.permit_not_found"))),
    expect: { status: 200, shotClass: "reject.permanent-item" },
  },
  {
    id: "rpc-200-session-not-found",
    upstream: "rest.rpc",
    fault: 'HTTP 200 "shot.session_not_found" (transient by contract)',
    plan: () =>
      always("rest.rpc", http(200, JSON.stringify("shot.session_not_found"))),
    expect: itemTransient(),
  },
  {
    id: "rpc-hang-no-deadline",
    upstream: "rest.rpc",
    fault: "answers after 1500 ms — the edge has no deadline on the RPC",
    slow: true,
    batch: 1,
    plan: () => always("rest.rpc", { kind: "slow", ms: 1_500 }),
    expect: {
      status: 200,
      shotClass: "accepted",
      minLatencyMs: 1_450,
      roundTrips: warmTrips(1),
    },
  },
  {
    id: "rpc-after-commit-500",
    upstream: "rest.rpc",
    fault: "DB committed, answer replaced by HTTP 500 (response lost)",
    plan: () =>
      always("rest.rpc", { kind: "after-commit", then: http(500, PGRST_500) }),
    expect: itemTransient(),
    after: (h, world, _f, replay) => [
      {
        name: "replay acknowledged via SELECT, no second RPC per shot",
        holds: replay !== null && replay.roundTrips["rest.rpc"] === 0 &&
          replay.roundTrips["rest.select"] === 1,
        detail: JSON.stringify(replay?.roundTrips ?? null),
      },
      ...world.batch.map((shot) => ({
        name: `P0 idempotency: exactly one row for ${shot.id.slice(0, 8)}`,
        holds: shotRows(h, shot.id) === 1,
        detail: `rows=${shotRows(h, shot.id)}`,
      })),
    ],
  },
  {
    id: "rpc-after-commit-throw",
    upstream: "rest.rpc",
    fault: "DB committed, socket dropped before the answer",
    plan: () =>
      always("rest.rpc", {
        kind: "after-commit",
        then: { kind: "throw", message: "socket hang up" },
      }),
    expect: itemTransient(),
  },
  {
    id: "rpc-after-commit-malformed",
    upstream: "rest.rpc",
    fault: "DB committed, answer body truncated (non-JSON)",
    plan: () =>
      always("rest.rpc", { kind: "after-commit", then: http(200, '"acce') }),
    expect: itemTransient(),
  },
  {
    id: "rpc-after-commit-then-select-500",
    upstream: "rest.rpc+rest.select",
    fault:
      "DB committed + answer lost; the first replay's SELECT then fails (503), the second converges",
    plan: () =>
      always("rest.rpc", { kind: "after-commit", then: http(500, PGRST_500) }),
    degradedReplay: {
      plan: always("rest.select", http(500, PGRST_500)),
      status: 503,
    },
    batch: 1,
    expect: itemTransient(),
    after: (h, world) => [
      {
        name: "P0 idempotency: exactly one row",
        holds: shotRows(h, world.batch[0].id) === 1,
        detail: `rows=${shotRows(h, world.batch[0].id)}`,
      },
    ],
  },
  {
    id: "rpc-after-commit-then-select-null",
    upstream: "rest.rpc+rest.select",
    fault:
      "DB committed + answer lost; the replay's SELECT answers null (no replay ids) so the RPC re-runs",
    plan: () =>
      always("rest.rpc", { kind: "after-commit", then: { kind: "throw" } }),
    degradedReplay: {
      plan: always("rest.select", http(200, "null")),
      status: 200,
    },
    batch: 2,
    expect: itemTransient(),
    // Second line of defence: apply_synced_shot itself answers "accepted" for
    // a row the user already owns instead of writing it twice.
    after: (h, world) =>
      world.batch.map((shot) => ({
        name: `P0 idempotency (RPC-level replay): exactly one row ${
          shot.id.slice(0, 8)
        }`,
        holds: shotRows(h, shot.id) === 1,
        detail: `rows=${shotRows(h, shot.id)}`,
      })),
  },
  {
    id: "rpc-mixed-batch-one-fault",
    upstream: "rest.rpc",
    fault: "HTTP 500 on ONE seed-chosen shot of a 6-shot batch",
    batch: 6,
    plan: ({ prng }) => {
      const victim = prng.int(0, 5);
      return nth("rest.rpc", victim, http(500, PGRST_500));
    },
    expect: {
      status: 200,
      shotClass: () => "accepted",
      roundTrips: warmTrips(6),
    },
    after: (_h, _w, faulted) => [
      {
        name:
          "partial batch: 5 accepted + 1 transient rejection, nothing unacknowledged",
        holds: faulted.acceptedIds.length === 5 &&
          faulted.rejected.length === 1 &&
          faulted.rejected[0].code === "shot.write_failed",
        detail: `accepted=${faulted.acceptedIds.length} rejected=${
          JSON.stringify(faulted.rejected.map((r) => r.code))
        }`,
      },
    ],
  },
  {
    id: "rpc-flapping",
    upstream: "rest.rpc",
    fault:
      "every other RPC call fails (flapping backend) across a 4-shot batch",
    batch: 4,
    plan: () =>
    (
      call,
    ) => (call.upstream === "rest.rpc" && call.nth % 2 === 1
      ? http(500, PGRST_500)
      : null),
    expect: {
      status: 200,
      shotClass: () => "accepted",
      roundTrips: warmTrips(4),
    },
    after: (_h, _w, faulted) => [
      {
        name: "2 accepted + 2 transient",
        holds: faulted.acceptedIds.length === 2 &&
          faulted.rejected.length === 2,
        detail:
          `accepted=${faulted.acceptedIds.length} rejected=${faulted.rejected.length}`,
      },
    ],
  },

  // ── Client-side malformed input never reaches an upstream ────────────────
  {
    id: "body-shot-invalid-one-of-batch",
    upstream: "none",
    fault: "one shot of 3 fails validation (score out of range)",
    batch: 3,
    plan: () => () => null,
    expect: {
      status: 200,
      shotClass: () => "accepted",
      roundTrips: warmTrips(2),
    },
    replayConverges: false,
    after: (h, world, faulted) => [
      {
        name:
          "1 permanent validation rejection, 2 accepted, malformed row never queried",
        holds: faulted.acceptedIds.length === 2 &&
          faulted.rejected.length === 1 &&
          faulted.rejected[0].code === "shot.invalid_payload" &&
          shotRows(h, world.batch[0].id) === 0,
        detail: JSON.stringify(faulted.rejected),
      },
    ],
  },

  // ── RevenueCat — provably not on this path ───────────────────────────────
  {
    id: "revenuecat-500",
    upstream: "revenuecat",
    fault: "HTTP 500 on every RevenueCat call",
    plan: () => always("revenuecat", http(500, "{}")),
    expect: {
      status: 200,
      shotClass: "accepted",
      roundTrips: (rt) => rt.revenuecat === 0,
    },
  },
  {
    id: "revenuecat-throw",
    upstream: "revenuecat",
    fault: "connection failure on every RevenueCat call",
    plan: () => always("revenuecat", { kind: "throw" }),
    expect: {
      status: 200,
      shotClass: "accepted",
      roundTrips: (rt) => rt.revenuecat === 0,
    },
  },
  {
    id: "revenuecat-hang",
    upstream: "revenuecat",
    fault: "RevenueCat never answers",
    plan: () => always("revenuecat", { kind: "hang", ms: 30_000 }),
    expect: {
      status: 200,
      shotClass: "accepted",
      roundTrips: (rt) => rt.revenuecat === 0,
    },
  },
];

const rows: CaseRow[] = [];
let scenariosExecuted = 0;
let harness: StressHarness | null = null;
const h = async () => (harness ??= await loadStressHarness());

function classesOf(
  outcome: SyncOutcome,
  batch: BatchShot[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const shot of batch) {
    const cls = classifyForShot(outcome, shot.id);
    out[cls] = (out[cls] ?? 0) + 1;
  }
  return out;
}

async function runCase(
  fc: FaultCase,
  caseIndex: number,
  iteration: number,
): Promise<CaseRow> {
  const H = await h();
  const seed = caseSeed(STRESS_SEED, caseIndex, iteration);
  const prng = new Prng(seed);
  H.reset(seed);
  const user = mintUser(H, prng);
  const n = fc.batch ?? prng.int(1, 4);
  const batch = makeBatch(
    H,
    prng,
    user.id,
    n,
    fc.id === "body-shot-invalid-one-of-batch"
      ? (i) => (i === 0 ? { overallScore: 42 } : {})
      : () => ({}),
  );
  const world: World = { prng, user, batch };
  const invariants: CaseRow["invariants"] = [];
  const inv = (name: string, holds: boolean, detail: string) =>
    invariants.push({ name, holds, detail });

  const warm = fc.warm ?? !fc.upstream.startsWith("gotrue");
  if (warm) {
    const warmup = await drive(
      H,
      `${fc.id}#${iteration}:warm`,
      syncRequest(user, { shots: [] }),
    );
    inv(
      "warm-up verified the bearer once (400 validation, 1 Auth round trip)",
      warmup.status === 400 && warmup.roundTrips["gotrue.user"] === 1,
      `status=${warmup.status} trips=${JSON.stringify(warmup.roundTrips)}`,
    );
  }

  H.setFault(fc.plan(world));
  const tag = `${fc.id}#${iteration}`;
  const faulted = await drive(H, tag, syncRequest(user, batch));
  scenariosExecuted += 1;
  H.setFault(null);

  const perShot: Record<string, ClientClass> = {};
  for (const [index, shot] of batch.entries()) {
    const cls = classifyForShot(faulted, shot.id);
    perShot[shot.id] = cls;
    const expected = typeof fc.expect.shotClass === "function"
      ? fc.expect.shotClass(index)
      : fc.expect.shotClass;
    // Batch cases with per-shot variance (mixed / flapping / validation) are
    // checked by their own `after` invariants; the generic check only covers
    // uniform expectations.
    if (typeof fc.expect.shotClass !== "function") {
      inv(
        `shot[${index}] class ${expected}`,
        cls === expected,
        `observed=${cls}`,
      );
    }
  }
  inv(
    `status ${fc.expect.status}`,
    faulted.status === fc.expect.status,
    `observed=${faulted.status} code=${faulted.errorCode} msg=${faulted.errorMessage}`,
  );
  if (fc.expect.retryAfter === "present") {
    inv(
      "Retry-After present",
      faulted.retryAfter !== null,
      `Retry-After=${faulted.retryAfter}`,
    );
  }
  if (fc.expect.errorCode) {
    inv(
      `error.code ${fc.expect.errorCode}`,
      faulted.errorCode === fc.expect.errorCode,
      `observed=${faulted.errorCode}`,
    );
  }
  if (fc.expect.roundTrips) {
    inv(
      `round trips ${fc.expect.roundTripsNote ?? "as expected"}`,
      fc.expect.roundTrips(faulted.roundTrips),
      JSON.stringify(faulted.roundTrips),
    );
  }
  if (fc.expect.minLatencyMs !== undefined) {
    inv(
      `latency ≥ ${fc.expect.minLatencyMs} ms`,
      faulted.latencyMs >= fc.expect.minLatencyMs,
      `${faulted.latencyMs} ms`,
    );
  }
  if (fc.expect.maxLatencyMs !== undefined) {
    inv(
      `latency ≤ ${fc.expect.maxLatencyMs} ms`,
      faulted.latencyMs <= fc.expect.maxLatencyMs,
      `${faulted.latencyMs} ms`,
    );
  }
  if (faulted.status >= 500) {
    inv(
      "5xx body is generic (no upstream detail)",
      faulted.errorMessage !== null &&
        !/PGRST|XX000|57014|42501|stress|reset/.test(faulted.errorMessage),
      `msg=${faulted.errorMessage}`,
    );
  }
  // Data-loss guard: an acknowledged shot must exist exactly once — unless the
  // case documents the acknowledgement laxity it is exercising.
  for (const id of faulted.acceptedIds) {
    if (fc.id === "rpc-200-array-wrapped-accepted") continue;
    inv(
      `acknowledged ⇒ exactly one row (${id.slice(0, 8)})`,
      shotRows(H, id) === 1,
      `rows=${shotRows(H, id)}`,
    );
  }
  for (const shot of batch) {
    inv(
      `never more than one row (${shot.id.slice(0, 8)})`,
      shotRows(H, shot.id) <= 1,
      `rows=${shotRows(H, shot.id)}`,
    );
  }

  let replay: SyncOutcome | null = null;
  if (fc.degradedReplay) {
    H.setFault(fc.degradedReplay.plan);
    const degraded = await drive(
      H,
      `${tag}:degraded-replay`,
      syncRequest(user, batch),
    );
    scenariosExecuted += 1;
    H.setFault(null);
    inv(
      `degraded replay → ${fc.degradedReplay.status}`,
      degraded.status === fc.degradedReplay.status,
      `status=${degraded.status}`,
    );
    for (const shot of batch) {
      inv(
        `degraded replay keeps the row queued (${shot.id.slice(0, 8)})`,
        recoverable(classifyForShot(degraded, shot.id)),
        `class=${classifyForShot(degraded, shot.id)}`,
      );
      inv(
        `degraded replay never duplicates (${shot.id.slice(0, 8)})`,
        shotRows(H, shot.id) <= 1,
        `rows=${shotRows(H, shot.id)}`,
      );
    }
  }
  if (fc.replayConverges ?? true) {
    replay = await drive(H, `${tag}:replay`, syncRequest(user, batch));
    scenariosExecuted += 1;
    inv(
      "replay (fault lifted) → 200",
      replay.status === 200,
      `status=${replay.status}`,
    );
    for (const shot of batch) {
      const cls = classifyForShot(replay, shot.id);
      inv(
        `replay accepted ${shot.id.slice(0, 8)}`,
        cls === "accepted",
        `class=${cls}`,
      );
      inv(
        `converged: one row ${shot.id.slice(0, 8)}`,
        shotRows(H, shot.id) === 1,
        `rows=${shotRows(H, shot.id)}`,
      );
      inv(
        `converged: permit finalized ${shot.permitId.slice(0, 8)}`,
        permitStatus(H, shot.permitId) === "finalized/scored",
        permitStatus(H, shot.permitId),
      );
    }
    if (warm) {
      inv(
        "replay never re-verifies the bearer",
        replay.roundTrips["gotrue.user"] === 0,
        JSON.stringify(replay.roundTrips),
      );
    } else {
      inv(
        "replay verifies the bearer at most once",
        replay.roundTrips["gotrue.user"] <= 1,
        JSON.stringify(replay.roundTrips),
      );
    }
  }
  if (fc.after) invariants.push(...fc.after(H, world, faulted, replay));

  const recoverableAll = Object.values(perShot).every(recoverable);
  return {
    suite: SUITE,
    case: fc.id,
    seed,
    iteration,
    upstream: fc.upstream,
    fault: fc.fault,
    status: faulted.status,
    retryAfter: faulted.retryAfter,
    errorCode: faulted.errorCode,
    errorMessage: faulted.errorMessage,
    perShot,
    classes: classesOf(faulted, batch),
    recoverable: recoverableAll,
    roundTrips: faulted.roundTrips,
    faultedCalls: faulted.faulted,
    latencyMs: faulted.latencyMs,
    retry: replay
      ? {
        status: replay.status,
        classes: classesOf(replay, batch),
        roundTrips: replay.roundTrips,
        latencyMs: replay.latencyMs,
      }
      : null,
    invariants,
    held: invariants.every((i) => i.holds) && !fc.finding,
    finding: fc.finding ?? null,
    replay:
      `STRESS_SEED=${STRESS_SEED} STRESS_SLOW=1 deno test -A --filter "${fc.id}" stress_shots_sync_failure.test.ts`,
  };
}

for (const [caseIndex, fc] of CASES.entries()) {
  Deno.test({
    name: `stress ${SUITE} ${fc.id} — ${fc.upstream}: ${fc.fault}`,
    ignore: Boolean(fc.slow) && !STRESS_SLOW,
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      for (let iteration = 0; iteration < STRESS_ITER; iteration++) {
        const row = await runCase(fc, caseIndex, iteration);
        rows.push(row);
        const broken = row.invariants.filter((i) => !i.holds);
        assert(
          broken.length === 0,
          `${fc.id} seed=${row.seed}: ${
            broken.map((i) => `${i.name} [${i.detail}]`).join("; ")
          }\n  replay: ${row.replay}`,
        );
      }
    },
  });
}

Deno.test({
  name: `stress ${SUITE} — ≥40 fault cases defined, JSON evidence written`,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    assert(CASES.length >= 40, `only ${CASES.length} fault cases`);
    const ids = new Set(CASES.map((c) => c.id));
    assertEquals(ids.size, CASES.length, "case ids must be unique");
    const path = await writeJson("failure_memory_tier", {
      suite: SUITE,
      seedBase: STRESS_SEED,
      iterationsPerCase: STRESS_ITER,
      slowCasesIncluded: STRESS_SLOW,
      authTimeoutMs: STRESS_AUTH_TIMEOUT_MS,
      casesDefined: CASES.length,
      casesRun: new Set(rows.map((r) => r.case)).size,
      scenariosExecuted,
      held: rows.filter((r) => r.held).length,
      broken: rows.filter((r) => r.invariants.some((i) => !i.holds)).map((
        r,
      ) => ({ case: r.case, seed: r.seed })),
      pinnedFindings: rows.filter((r) => r.finding).map((r) => ({
        case: r.case,
        seed: r.seed,
        finding: r.finding,
      })),
      byUpstream: Object.fromEntries(
        [...new Set(CASES.map((c) => c.upstream))].map((
          u,
        ) => [u, CASES.filter((c) => c.upstream === u).length]),
      ),
      rows,
    });
    console.log(
      `[stress] ${SUITE}: ${rows.length} rows (${scenariosExecuted} requests) → ${path}`,
    );
  },
});
