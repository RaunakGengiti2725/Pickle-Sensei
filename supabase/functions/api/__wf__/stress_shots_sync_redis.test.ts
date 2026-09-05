/**
 * stress — FAILURE INJECTION for `POST /v1/shots:sync` with the Upstash tier
 * enabled (UPSTASH_REDIS_REST_URL/TOKEN set before the real handler loads;
 * this file runs in its own isolate so the memory-tier suite is unaffected).
 *
 * Redis is a cache and a shared counter store: no Redis fault may change the
 * verdict of a sync, lose or duplicate a shot, or sign the user out. What a
 * fault MAY cost is extra Auth round trips (cache miss) and latency (each
 * pipeline waits up to cache.ts REDIS_TIMEOUT_MS = 1 200 ms).
 *
 *   STRESS_ITER / STRESS_SEED / STRESS_SLOW / STRESS_OUT_DIR as in
 *   stress_shots_sync_failure.test.ts.
 */
import { assert, assertEquals } from "@std/assert";
import {
  type BatchShot,
  type CaseRow,
  caseSeed,
  classifyForShot,
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
  STRESS_ITER,
  STRESS_SEED,
  STRESS_SLOW,
  type StressHarness,
  type StressUser,
  type SyncOutcome,
  syncRequest,
  writeJson,
} from "./stress_shots_sync_harness.ts";

const SUITE = "failure.redis-tier";
/** cache.ts REDIS_TIMEOUT_MS — the AbortSignal.timeout on every pipeline. */
const REDIS_TIMEOUT_MS = 1_200;
/** Redis pipelines a WARM sync issues, sequentially: ip INCR, authfail GET,
 * auth-cache probe (GET marker + TTL), route INCR, and the rank/progress
 * generation-bump + DEL after an accepted write. */
const WARM_REDIS_TRIPS = 5;

interface World {
  prng: Prng;
  user: StressUser;
  batch: BatchShot[];
}

interface RedisCase {
  id: string;
  fault: string;
  slow?: boolean;
  batch?: number;
  plan: (world: World) => FaultPlan;
  /** Expected status of the faulted sync. */
  status: number;
  /** Expected per-shot class (uniform). */
  shotClass: "accepted" | "retry.transient";
  /** Extra Auth round trips the fault is allowed to cost on the faulted request. */
  authTrips: (n: number) => boolean;
  authTripsNote: string;
  redisTrips?: (n: number) => boolean;
  minLatencyMs?: number;
  maxLatencyMs?: number;
  /** Expected status of the replay once the fault is lifted (default 200 =
   * convergence). Anything else pins a lingering effect and requires that
   * nothing was written or spent. */
  replayStatus?: number;
  finding?: string;
  after?: (
    h: StressHarness,
    world: World,
    faulted: SyncOutcome,
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
const redisAlways = (action: FaultAction): FaultPlan =>
(
  call,
) => (call.upstream === "redis" ? action : null);
/** Fault only the pipelines that contain a command `op` (GET = auth-cache
 * probe / authfail peek, INCR = counters and generation bumps, DEL = the
 * rank/progress invalidation). */
const redisOp = (op: string, action: FaultAction): FaultPlan => (call) => {
  if (call.upstream !== "redis") return null;
  const commands = Array.isArray(call.body) ? (call.body as unknown[][]) : [];
  return commands.some((c) => c[0] === op) ? action : null;
};
/** Fault only the fixed-window counter pipelines (INCR + EXPIRE … NX). */
const redisCounter = (action: FaultAction): FaultPlan => (call) => {
  if (call.upstream !== "redis") return null;
  const commands = Array.isArray(call.body) ? (call.body as unknown[][]) : [];
  return commands[0]?.[0] === "INCR" &&
      String(commands[0]?.[1] ?? "").startsWith("rl:")
    ? action
    : null;
};
/** Answer with one slot per command, all identical. */
const uniformSlots = (slot: unknown): FaultPlan => (call) => {
  if (call.upstream !== "redis") return null;
  const n = Array.isArray(call.body) ? (call.body as unknown[]).length : 1;
  return http(200, JSON.stringify(Array.from({ length: n }, () => slot)));
};

const noExtraAuth = (n: number) => n === 0;
const oneExtraAuth = (n: number) => n === 1;

const CASES: RedisCase[] = [
  {
    id: "redis-500",
    fault: "HTTP 500 on every pipeline",
    plan: () => redisAlways(http(500, JSON.stringify({ error: "internal" }))),
    status: 200,
    shotClass: "accepted",
    authTrips: noExtraAuth,
    authTripsNote: "L1 still holds the bearer; counters fall back to memory",
    redisTrips: (n) => n === WARM_REDIS_TRIPS,
  },
  {
    id: "redis-401-token-rotated",
    fault: "HTTP 401 Unauthorized (REST token rotated)",
    plan: () =>
      redisAlways(http(401, JSON.stringify({ error: "Unauthorized" }))),
    status: 200,
    shotClass: "accepted",
    authTrips: noExtraAuth,
    authTripsNote: "unavailable ⇒ L1/memory fallback",
  },
  {
    id: "redis-429-quota",
    fault: "HTTP 429 (Upstash quota) + Retry-After",
    plan: () =>
      redisAlways(
        http(429, JSON.stringify({ error: "quota" }), { "Retry-After": "60" }),
      ),
    status: 200,
    shotClass: "accepted",
    authTrips: noExtraAuth,
    authTripsNote:
      "unavailable ⇒ L1/memory fallback; the upstream Retry-After must NOT leak",
    after: (_h, _w, faulted) => [
      {
        name: "no Retry-After leaked from Upstash",
        holds: faulted.retryAfter === null,
        detail: `Retry-After=${faulted.retryAfter}`,
      },
    ],
  },
  {
    id: "redis-throw",
    fault: "connection failure on every pipeline",
    plan: () => redisAlways({ kind: "throw", message: "connection refused" }),
    status: 200,
    shotClass: "accepted",
    authTrips: noExtraAuth,
    authTripsNote: "unavailable ⇒ L1/memory fallback",
  },
  {
    id: "redis-hang",
    fault:
      `never answers — every pipeline waits the full ${REDIS_TIMEOUT_MS} ms timeout`,
    slow: true,
    batch: 1,
    plan: () => redisAlways({ kind: "hang", ms: REDIS_TIMEOUT_MS * 10 }),
    status: 200,
    shotClass: "accepted",
    authTrips: noExtraAuth,
    authTripsNote: "unavailable ⇒ L1/memory fallback",
    redisTrips: (n) => n === WARM_REDIS_TRIPS,
    minLatencyMs: WARM_REDIS_TRIPS * REDIS_TIMEOUT_MS - 100,
    finding:
      `an unresponsive Upstash adds ${WARM_REDIS_TRIPS} × ${REDIS_TIMEOUT_MS} ms ≈ ${
        (WARM_REDIS_TRIPS * REDIS_TIMEOUT_MS / 1000).toFixed(1)
      } s to EVERY sync (sequential pipelines, no circuit breaker / short-circuit after the first timeout)`,
  },
  {
    id: "redis-slow-under-timeout",
    fault:
      "answers after 300 ms (inside the timeout) — the latency is paid per pipeline",
    slow: true,
    batch: 1,
    plan: () => redisAlways({ kind: "slow", ms: 300 }),
    status: 200,
    shotClass: "accepted",
    authTrips: noExtraAuth,
    authTripsNote: "healthy answers",
    redisTrips: (n) => n === WARM_REDIS_TRIPS,
    minLatencyMs: WARM_REDIS_TRIPS * 300 - 50,
  },
  {
    id: "redis-200-non-json",
    fault: "HTTP 200 non-JSON body",
    plan: () => redisAlways(http(200, "<html>upstash</html>")),
    status: 200,
    shotClass: "accepted",
    authTrips: noExtraAuth,
    authTripsNote: "unparseable ⇒ unavailable ⇒ fallback",
  },
  {
    id: "redis-200-object",
    fault: "HTTP 200 {} (object where the pipeline array is due)",
    plan: () => redisAlways(http(200, "{}")),
    status: 200,
    shotClass: "accepted",
    authTrips: noExtraAuth,
    authTripsNote: "not an array ⇒ unavailable ⇒ fallback",
  },
  {
    id: "redis-200-empty-array",
    fault: "HTTP 200 [] (no slots answered)",
    plan: () => redisAlways(http(200, "[]")),
    status: 200,
    shotClass: "accepted",
    authTrips: oneExtraAuth,
    authTripsNote:
      "auth-cache probe slots missing ⇒ treated as unknown ⇒ one re-verification with GoTrue",
  },
  {
    id: "redis-200-error-slots",
    fault: 'HTTP 200 [{"error":"ERR ..."}] on every slot (e.g. MOVED / OOM)',
    plan: () =>
      uniformSlots({
        error: "OOM command not allowed when used memory > 'maxmemory'",
      }),
    status: 200,
    shotClass: "accepted",
    authTrips: oneExtraAuth,
    authTripsNote:
      "error slots are unknowns ⇒ one re-verification with GoTrue; counters fall back",
  },
  {
    id: "redis-200-null-slots",
    fault: 'HTTP 200 [{"result":null}] on every slot',
    plan: () => uniformSlots({ result: null }),
    status: 200,
    shotClass: "accepted",
    authTrips: noExtraAuth,
    authTripsNote:
      "marker null = not revoked; TTL null ⇒ NaN ≠ -2 keeps the L1 copy",
  },
  {
    id: "redis-200-numeric-everywhere",
    fault:
      'HTTP 200 [{"result":12345}] on every slot (numbers where strings are due)',
    plan: () => uniformSlots({ result: 12345 }),
    // The per-IP counter reads 12345 > 1200: the shared store says the IP
    // is over budget, so the edge answers 429 + Retry-After pre-auth.
    status: 429,
    shotClass: "retry.transient",
    authTrips: noExtraAuth,
    authTripsNote: "429 is pre-auth — no Auth or DB call",
  },
  {
    id: "redis-200-string-everywhere",
    fault:
      'HTTP 200 [{"result":"OK"}] on every slot (strings where numbers/markers are due)',
    plan: () => uniformSlots({ result: "OK" }),
    // Counters: Number("OK") = NaN ⇒ memory fallback. Auth probe: the
    // revocation-marker slot is a string ⇒ the session is treated as
    // REVOKED, cached in L1 for 60 s, and the replay stays 401 after Redis
    // recovers.
    status: 401,
    shotClass: "retry.transient",
    authTrips: noExtraAuth,
    authTripsNote: "revoked verdict is final — GoTrue is not consulted",
    replayStatus: 401,
    finding:
      "a uniform garbage string in every pipeline slot (e.g. a proxy answering OK) is read as a revocation marker: 401 for the bearer for 60 s per isolate, surviving Redis recovery",
  },
  {
    id: "redis-200-huge-counter",
    fault: "INCR answers 10^9 (shared counter poisoned)",
    plan: () =>
      redisCounter(
        http(200, JSON.stringify([{ result: 1_000_000_000 }, { result: 1 }])),
      ),
    status: 429,
    shotClass: "retry.transient",
    authTrips: noExtraAuth,
    authTripsNote: "429 is pre-auth (per-IP budget) — no Auth or DB call",
    after: (_h, _w, faulted) => [
      {
        name:
          "429 carries Retry-After (client backs off, keeps the row queued)",
        holds: faulted.retryAfter !== null,
        detail: `Retry-After=${faulted.retryAfter}`,
      },
    ],
  },
  {
    id: "redis-200-negative-counter",
    fault: "INCR answers -5 (counter wrapped)",
    plan: () =>
      redisCounter(http(200, JSON.stringify([{ result: -5 }, { result: 1 }]))),
    status: 200,
    shotClass: "accepted",
    authTrips: noExtraAuth,
    authTripsNote: "-5 ≤ limit ⇒ allowed",
  },
  {
    id: "redis-200-nan-counter",
    fault: 'INCR answers "abc" (NaN)',
    plan: () =>
      redisCounter(
        http(200, JSON.stringify([{ result: "abc" }, { result: 1 }])),
      ),
    status: 200,
    shotClass: "accepted",
    authTrips: noExtraAuth,
    authTripsNote: "NaN ⇒ null ⇒ memory fallback counter",
  },
  {
    id: "redis-get-throws-only",
    fault:
      "only GET pipelines fail (auth probe + authfail peek); counters healthy",
    plan: () => redisOp("GET", { kind: "throw" }),
    status: 200,
    shotClass: "accepted",
    authTrips: noExtraAuth,
    authTripsNote: "probe unavailable ⇒ L1 copy trusted",
  },
  {
    id: "redis-del-fails-only",
    fault: "only the DEL (rank/progress invalidation) fails",
    plan: () => redisOp("DEL", http(500, "{}")),
    status: 200,
    shotClass: "accepted",
    authTrips: noExtraAuth,
    authTripsNote:
      "invalidation is best-effort; the sync verdict is unaffected",
    after: (_h, _w, faulted) => [
      {
        name: "the invalidation pipeline was the only faulted call",
        holds: faulted.faulted === 1,
        detail: `faulted=${faulted.faulted}`,
      },
    ],
  },
  {
    id: "redis-flapping",
    fault: "every other pipeline fails",
    plan: () =>
    (
      call,
    ) => (call.upstream === "redis" && call.nth % 2 === 1
      ? { kind: "throw" }
      : null),
    status: 200,
    shotClass: "accepted",
    authTrips: (n) => n <= 1,
    authTripsNote: "at most one re-verification",
  },
  {
    id: "redis-ttl-gone",
    fault:
      "TTL slot answers -2 for the auth row (L2 row evicted) while GET is healthy",
    plan: () => (call) => {
      if (call.upstream !== "redis") return null;
      const commands = Array.isArray(call.body)
        ? (call.body as unknown[][])
        : [];
      if (!commands.some((c) => c[0] === "TTL")) return null;
      const slots = commands.map((
        c,
      ) => (c[0] === "TTL" ? { result: -2 } : { result: null }));
      return http(200, JSON.stringify(slots));
    },
    status: 200,
    shotClass: "accepted",
    authTrips: oneExtraAuth,
    authTripsNote:
      "L2 says the row is gone ⇒ L1 copy dropped ⇒ one re-verification (revocation safety)",
  },
  {
    id: "redis-revoked-marker-garbage",
    fault:
      'the revocation-marker slot answers a string ("1") for a live session',
    plan: () => (call) => {
      if (call.upstream !== "redis") return null;
      const commands = Array.isArray(call.body)
        ? (call.body as unknown[][])
        : [];
      if (String(commands[0]?.[1] ?? "").startsWith("auth:revoked:")) {
        return http(200, JSON.stringify(commands.map(() => ({ result: "1" }))));
      }
      return null;
    },
    status: 401,
    shotClass: "retry.transient",
    authTrips: noExtraAuth,
    authTripsNote:
      "a revocation marker is trusted without re-verification (that is its purpose)",
    replayStatus: 401,
    finding:
      "any string in the auth:revoked:<session> slot signs the bearer out (401) for L1_READTHROUGH_TTL_SECONDS = 60 s per isolate, without consulting GoTrue; a corrupt/poisoned Redis answer is indistinguishable from a real logout",
  },
];

const rows: CaseRow[] = [];
let scenariosExecuted = 0;
let harness: StressHarness | null = null;
const h = async () => (harness ??= await loadStressHarness({ redis: true }));

async function runCase(
  rc: RedisCase,
  caseIndex: number,
  iteration: number,
): Promise<CaseRow> {
  const H = await h();
  const seed = caseSeed(STRESS_SEED + 7_000_000, caseIndex, iteration);
  const prng = new Prng(seed);
  H.reset(seed);
  const user = mintUser(H, prng);
  const batch = makeBatch(H, prng, user.id, rc.batch ?? prng.int(1, 3));
  const world: World = { prng, user, batch };
  const invariants: CaseRow["invariants"] = [];
  const inv = (name: string, holds: boolean, detail: string) =>
    invariants.push({ name, holds, detail });

  const warmup = await drive(
    H,
    `${rc.id}#${iteration}:warm`,
    syncRequest(user, { shots: [] }),
  );
  inv(
    "warm-up: bearer verified once and cached in L1+L2",
    warmup.status === 400 && warmup.roundTrips["gotrue.user"] === 1 &&
      warmup.roundTrips.redis >= 5,
    `status=${warmup.status} trips=${JSON.stringify(warmup.roundTrips)}`,
  );

  const callsBefore = H.calls.length;
  H.setFault(rc.plan(world));
  const tag = `${rc.id}#${iteration}`;
  const faulted = await drive(H, tag, syncRequest(user, batch));
  scenariosExecuted += 1;
  H.setFault(null);
  const faultedCalls =
    H.calls.slice(callsBefore).filter((c) => c.fault !== null).length;

  inv(
    `status ${rc.status}`,
    faulted.status === rc.status,
    `observed=${faulted.status} code=${faulted.errorCode} msg=${faulted.errorMessage}`,
  );
  const perShot: CaseRow["perShot"] = {};
  for (const shot of batch) {
    const cls = classifyForShot(faulted, shot.id);
    perShot[shot.id] = cls;
    inv(
      `shot ${shot.id.slice(0, 8)} class ${rc.shotClass}`,
      cls === rc.shotClass,
      `observed=${cls}`,
    );
    inv(
      `never more than one row (${shot.id.slice(0, 8)})`,
      shotRows(H, shot.id) <= 1,
      `rows=${shotRows(H, shot.id)}`,
    );
  }
  for (const id of faulted.acceptedIds) {
    inv(
      `acknowledged ⇒ exactly one row (${id.slice(0, 8)})`,
      shotRows(H, id) === 1,
      `rows=${shotRows(H, id)}`,
    );
  }
  inv(
    `Auth round trips: ${rc.authTripsNote || "none"}`,
    rc.authTrips(faulted.roundTrips["gotrue.user"]),
    JSON.stringify(faulted.roundTrips),
  );
  if (rc.redisTrips) {
    inv(
      "Redis pipelines per request",
      rc.redisTrips(faulted.roundTrips.redis),
      `redis=${faulted.roundTrips.redis}`,
    );
  }
  inv(
    "the fault was actually exercised",
    faultedCalls > 0,
    `faultedCalls=${faultedCalls}`,
  );
  if (rc.minLatencyMs !== undefined) {
    inv(
      `latency ≥ ${rc.minLatencyMs} ms`,
      faulted.latencyMs >= rc.minLatencyMs,
      `${faulted.latencyMs} ms`,
    );
  }
  if (rc.maxLatencyMs !== undefined) {
    inv(
      `latency ≤ ${rc.maxLatencyMs} ms`,
      faulted.latencyMs <= rc.maxLatencyMs,
      `${faulted.latencyMs} ms`,
    );
  }

  // Fault lifted: the same batch converges through a healthy Redis — or, for
  // the pinned lingering effects, nothing was written or spent.
  const replay = await drive(H, `${tag}:replay`, syncRequest(user, batch));
  scenariosExecuted += 1;
  const expectedReplay = rc.replayStatus ?? 200;
  inv(
    `replay (fault lifted) → ${expectedReplay}`,
    replay.status === expectedReplay,
    `status=${replay.status}`,
  );
  for (const shot of batch) {
    if (expectedReplay === 200) {
      inv(
        `converged: accepted ${shot.id.slice(0, 8)}`,
        classifyForShot(replay, shot.id) === "accepted",
        classifyForShot(replay, shot.id),
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
    } else {
      inv(
        `lingering: row still queued client-side ${shot.id.slice(0, 8)}`,
        recoverable(classifyForShot(replay, shot.id)),
        classifyForShot(replay, shot.id),
      );
      inv(
        `lingering: nothing written ${shot.id.slice(0, 8)}`,
        shotRows(H, shot.id) === 0,
        `rows=${shotRows(H, shot.id)}`,
      );
      inv(
        `lingering: permit untouched ${shot.permitId.slice(0, 8)}`,
        permitStatus(H, shot.permitId) === "reserved/",
        permitStatus(H, shot.permitId),
      );
    }
  }
  if (rc.after) invariants.push(...rc.after(H, world, faulted));

  return {
    suite: SUITE,
    case: rc.id,
    seed,
    iteration,
    upstream: "redis",
    fault: rc.fault,
    status: faulted.status,
    retryAfter: faulted.retryAfter,
    errorCode: faulted.errorCode,
    errorMessage: faulted.errorMessage,
    perShot,
    classes: Object.values(perShot).reduce<Record<string, number>>((acc, c) => {
      acc[c] = (acc[c] ?? 0) + 1;
      return acc;
    }, {}),
    recoverable: Object.values(perShot).every(recoverable),
    roundTrips: faulted.roundTrips,
    faultedCalls,
    latencyMs: faulted.latencyMs,
    retry: {
      status: replay.status,
      classes: Object.fromEntries(
        batch.map((s) => [classifyForShot(replay, s.id), 1]),
      ),
      roundTrips: replay.roundTrips,
      latencyMs: replay.latencyMs,
    },
    invariants,
    held: invariants.every((i) => i.holds) && !rc.finding,
    finding: rc.finding ?? null,
    replay:
      `STRESS_SEED=${STRESS_SEED} STRESS_SLOW=1 deno test -A --filter "${rc.id}" stress_shots_sync_redis.test.ts`,
  };
}

for (const [caseIndex, rc] of CASES.entries()) {
  Deno.test({
    name: `stress ${SUITE} ${rc.id} — ${rc.fault}`,
    ignore: Boolean(rc.slow) && !STRESS_SLOW,
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      for (let iteration = 0; iteration < STRESS_ITER; iteration++) {
        const row = await runCase(rc, caseIndex, iteration);
        rows.push(row);
        const broken = row.invariants.filter((i) => !i.holds);
        assert(
          broken.length === 0,
          `${rc.id} seed=${row.seed}: ${
            broken.map((i) => `${i.name} [${i.detail}]`).join("; ")
          }\n  replay: ${row.replay}`,
        );
      }
    },
  });
}

Deno.test({
  name: `stress ${SUITE} — Redis-enabled handler, JSON evidence written`,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const H = await h();
    assert(H.redisEnabled, "harness must have booted with the Upstash tier on");
    const ids = new Set(CASES.map((c) => c.id));
    assertEquals(ids.size, CASES.length, "case ids must be unique");
    const path = await writeJson("failure_redis_tier", {
      suite: SUITE,
      seedBase: STRESS_SEED + 7_000_000,
      iterationsPerCase: STRESS_ITER,
      slowCasesIncluded: STRESS_SLOW,
      redisTimeoutMs: REDIS_TIMEOUT_MS,
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
      rows,
    });
    console.log(
      `[stress] ${SUITE}: ${rows.length} rows (${scenariosExecuted} requests) → ${path}`,
    );
  },
});
