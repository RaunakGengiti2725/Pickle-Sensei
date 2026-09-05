/**
 * stress — LOAD + MEMORY for `POST /v1/shots:sync` through the real handler
 * (memory tier: no Upstash, per-isolate L1 + memory rate windows).
 *
 *   A. seeded sequential campaign (STRESS_LOAD_REQ requests, default 1000):
 *      per-request latency, Supabase round trips (GoTrue + PostgREST) and
 *      the >3-round-trip hot-path census, realistic outbox-drain batch mix,
 *      idempotent replays, and 429 route-budget behaviour.
 *   B. concurrent burst (same size, fan-out STRESS_LOAD_CONC=16): p50/p95
 *      under concurrency, aggregate round trips per request.
 *   C. L1 / rate-window memory under STRESS_USERS distinct users (default
 *      2000; the evidence run uses 20000): heap curve, plateau check, and the
 *      memory-window saturation behaviour of rateLimit.ts.
 *
 *   STRESS_UPSTREAM_MS — max seeded latency per fake upstream call (default 0;
 *   set 4 to make round trips visible in p50/p95). Run with
 *   `--v8-flags=--expose-gc` for GC-forced heap numbers.
 */
import { assert } from "@std/assert";
import {
  awaitMinuteBucket,
  type BatchShot,
  drive,
  emptyRoundTrips,
  heapNow,
  latencyStats,
  loadStressHarness,
  makeBatch,
  mintUser,
  minuteBucket,
  Prng,
  shotRows,
  STRESS_SEED,
  type StressHarness,
  type StressUser,
  syncRequest,
  type Upstream,
  writeJson,
} from "./stress_shots_sync_harness.ts";

const envInt = (name: string, fallback: number): number => {
  const raw = Deno.env.get(name);
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};
const LOAD_REQ = envInt("STRESS_LOAD_REQ", 1000);
const LOAD_CONC = envInt("STRESS_LOAD_CONC", 16);
const USERS = envInt("STRESS_USERS", 2000);
const UPSTREAM_MS = envInt("STRESS_UPSTREAM_MS", 0);
/** Route budget for shots:sync (index.ts ROUTE_LIMITS) and the memory
 * rate-window cap (rateLimit.ts MEMORY_WINDOW_MAX). */
const ROUTE_LIMIT = 30;
const MEMORY_WINDOW_MAX = 20_000;
/** L1 cache cap (cache.ts L1_MAX_ENTRIES). */
const L1_MAX_ENTRIES = 5_000;
/** A hot path spending more than this many Supabase round trips is a finding. */
const HOT_PATH_BUDGET = 3;

const SUPABASE_UPSTREAMS: Upstream[] = [
  "gotrue.user",
  "gotrue.other",
  "rest.select",
  "rest.rpc",
  "rest.other",
];
const supabaseTrips = (rt: Record<Upstream, number>): number =>
  SUPABASE_UPSTREAMS.reduce((acc, u) => acc + rt[u], 0);

/** Outbox-drain batch mix (mobile reads ≤ 50 rows per drain). */
function pickBatchSize(prng: Prng): number {
  const r = prng.int(0, 99);
  if (r < 60) return 1;
  if (r < 85) return prng.int(2, 5);
  if (r < 95) return prng.int(6, 20);
  return 50;
}

let harness: StressHarness | null = null;
const h = async () => (harness ??= await loadStressHarness({ redis: false }));

interface LoadRow {
  i: number;
  seed: number;
  user: number;
  kind: "new" | "replay" | "mixed" | "over-budget";
  batch: number;
  newShots: number;
  status: number;
  accepted: number;
  rejected: number;
  latencyMs: number;
  supabaseTrips: number;
  roundTrips: Record<Upstream, number>;
}

Deno.test({
  name:
    `stress load.sequential — ${LOAD_REQ} seeded requests, latency + Supabase round trips per request`,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const H = await h();
    const seed = (STRESS_SEED + 9_000_000) >>> 0;
    const prng = new Prng(seed);
    H.reset(seed);
    H.fake.reset(seed, UPSTREAM_MS);

    // Enough users that the 30/60 s route budget is not the bottleneck
    // (each user carries ≤ 25 requests), warmed so the campaign measures the
    // hot path and not the one-off GoTrue verification.
    const userCount = Math.max(8, Math.ceil(LOAD_REQ / 25));
    const users: StressUser[] = [];
    const perUser: number[] = [];
    const history: BatchShot[][] = [];
    for (let u = 0; u < userCount; u++) {
      const user = mintUser(H, prng);
      users.push(user);
      perUser.push(0);
      const warm = await drive(
        H,
        `load:warm:${u}`,
        syncRequest(user, { shots: [] }),
      );
      assert(
        warm.status === 400 && warm.roundTrips["gotrue.user"] === 1,
        `warm-up ${u}: ${warm.status}`,
      );
    }

    const rows: LoadRow[] = [];
    const allIds = new Set<string>();
    let dupRows = 0;
    for (let i = 0; i < LOAD_REQ; i++) {
      // Pick a user with budget left (25 of the 30-per-minute allowance).
      let u = prng.int(0, userCount - 1);
      for (let tries = 0; perUser[u] >= 25 && tries < userCount; tries++) {
        u = (u + 1) % userCount;
      }
      perUser[u] += 1;
      const user = users[u];
      const roll = prng.int(0, 99);
      let kind: LoadRow["kind"] = "new";
      let batch: BatchShot[];
      if (roll < 15 && history.length > 0) {
        // Exact duplicate delivery of an earlier batch (client retry).
        kind = "replay";
        batch = history[prng.int(0, history.length - 1)];
        if (
          !batch.some((s) =>
            H.fake.tables.shots.some((r) =>
              r.id === s.id && r.user_id === user.id
            )
          )
        ) {
          // Not this user's batch — make it a fresh one instead.
          kind = "new";
          batch = makeBatch(H, prng, user.id, pickBatchSize(prng));
        }
      } else if (roll < 25 && history.length > 0) {
        // Half old, half new — a drain that re-sends unacknowledged rows.
        const old = history[prng.int(0, history.length - 1)].filter((s) =>
          H.fake.tables.shots.some((r) =>
            r.id === s.id && r.user_id === user.id
          )
        );
        const fresh = makeBatch(H, prng, user.id, pickBatchSize(prng));
        batch = [...old, ...fresh];
        kind = old.length > 0 ? "mixed" : "new";
      } else {
        batch = makeBatch(H, prng, user.id, pickBatchSize(prng));
      }
      const newShots = batch.filter((s) => shotRows(H, s.id) === 0).length;
      const out = await drive(H, `load:${i}`, syncRequest(user, batch));
      if (kind === "new" && out.status === 200) history.push(batch);
      for (const s of batch) {
        allIds.add(s.id);
        if (shotRows(H, s.id) > 1) dupRows += 1;
      }
      rows.push({
        i,
        seed,
        user: u,
        kind,
        batch: batch.length,
        newShots,
        status: out.status,
        accepted: out.acceptedIds.length,
        rejected: out.rejected.length,
        latencyMs: out.latencyMs,
        supabaseTrips: supabaseTrips(out.roundTrips),
        roundTrips: out.roundTrips,
      });
      assert(
        out.status === 200,
        `request ${i} (seed ${seed}) → ${out.status} ${out.errorCode}`,
      );
      assert(
        out.acceptedIds.length === batch.length,
        `request ${i}: ${out.rejected.map((r) => r.code).join(",")}`,
      );
      // Round-trip model: 1 batched SELECT + 1 RPC per NEW shot, 0 GoTrue.
      const expectedTrips = 1 + newShots;
      assert(
        supabaseTrips(out.roundTrips) === expectedTrips &&
          out.roundTrips["gotrue.user"] === 0,
        `request ${i}: trips ${
          JSON.stringify(out.roundTrips)
        } expected ${expectedTrips}`,
      );
    }

    // Route budget: the 31st request of a minute is 429 + Retry-After and the
    // 32nd stays 429; the rows stay on the device (nothing written).
    const budgetUser = mintUser(H, prng);
    const budgetBucket = await awaitMinuteBucket(3_000);
    let budgetStatuses: number[] = [];
    let budgetRetryAfter: string | null = null;
    const overBudgetBatch = makeBatch(H, prng, budgetUser.id, 1);
    for (let k = 1; k <= ROUTE_LIMIT + 2; k++) {
      const out = await drive(
        H,
        `load:budget:${k}`,
        syncRequest(
          budgetUser,
          k <= ROUTE_LIMIT
            ? makeBatch(H, prng, budgetUser.id, 1)
            : overBudgetBatch,
        ),
      );
      budgetStatuses.push(out.status);
      if (k === ROUTE_LIMIT + 1) budgetRetryAfter = out.retryAfter;
    }
    budgetStatuses = budgetStatuses.slice(-3);
    assert(
      budgetBucket.bucket === minuteBucket(),
      "inconclusive: route-budget probe straddled a minute boundary; re-run",
    );
    assert(
      budgetStatuses[0] === 200 && budgetStatuses[1] === 429 &&
        budgetStatuses[2] === 429,
      `route budget: ${budgetStatuses.join(",")}`,
    );
    assert(budgetRetryAfter !== null, "429 must carry Retry-After");
    assert(
      shotRows(H, overBudgetBatch[0].id) === 0,
      "a 429'd batch must not be written",
    );

    const latencies = rows.map((r) => r.latencyMs);
    const trips = rows.map((r) => r.supabaseTrips);
    const overBudget = rows.filter((r) => r.supabaseTrips > HOT_PATH_BUDGET);
    const byKind: Record<
      string,
      { n: number; lat: number[]; trips: number[] }
    > = {};
    for (const r of rows) {
      const k = (byKind[r.kind] ??= { n: 0, lat: [], trips: [] });
      k.n += 1;
      k.lat.push(r.latencyMs);
      k.trips.push(r.supabaseTrips);
    }
    const byBatch: Record<
      string,
      { n: number; lat: number[]; trips: number[] }
    > = {};
    for (const r of rows) {
      const bucket = r.newShots === 0
        ? "replay-only"
        : r.newShots === 1
        ? "1 new"
        : r.newShots <= 5
        ? "2-5 new"
        : r.newShots <= 20
        ? "6-20 new"
        : "21-50 new";
      const k = (byBatch[bucket] ??= { n: 0, lat: [], trips: [] });
      k.n += 1;
      k.lat.push(r.latencyMs);
      k.trips.push(r.supabaseTrips);
    }
    const summarize = (
      m: Record<string, { n: number; lat: number[]; trips: number[] }>,
    ) =>
      Object.fromEntries(
        Object.entries(m).map(([k, v]) => [k, {
          n: v.n,
          latency: latencyStats(v.lat),
          supabaseTrips: latencyStats(v.trips),
        }]),
      );

    const report = {
      suite: "load.sequential",
      seed,
      requests: rows.length,
      users: userCount,
      upstreamLatencyMaxMs: UPSTREAM_MS,
      distinctShotIds: allIds.size,
      duplicateShotRows: dupRows,
      allAccepted: rows.every((r) =>
        r.status === 200 && r.accepted === r.batch
      ),
      latencyMs: latencyStats(latencies),
      supabaseTripsPerRequest: latencyStats(trips),
      roundTripModel:
        "1 batched SELECT (replay lookup) + 1 RPC apply_synced_shot per NEW shot, sequential; 0 GoTrue when warm",
      hotPathBudget: HOT_PATH_BUDGET,
      requestsOverBudget: overBudget.length,
      requestsOverBudgetShare:
        Math.round((overBudget.length / rows.length) * 1000) / 10,
      maxTripsRequest: rows.reduce((
        a,
        b,
      ) => (a.supabaseTrips >= b.supabaseTrips ? a : b)),
      byKind: summarize(byKind),
      byNewShots: summarize(byBatch),
      routeBudget: {
        limit: ROUTE_LIMIT,
        last3Statuses: budgetStatuses,
        retryAfter: budgetRetryAfter,
      },
      rows,
    };
    const path = await writeJson("load_sequential", report);
    console.log(
      `[stress] load.sequential: n=${rows.length} p50=${report.latencyMs.p50}ms p95=${report.latencyMs.p95}ms ` +
        `trips p50=${report.supabaseTripsPerRequest.p50} p95=${report.supabaseTripsPerRequest.p95} max=${report.supabaseTripsPerRequest.max} ` +
        `over-${HOT_PATH_BUDGET}=${overBudget.length} (${report.requestsOverBudgetShare}%) → ${path}`,
    );
    assert(dupRows === 0, "duplicate delivery produced a second row");
  },
});

Deno.test({
  name: `stress load.concurrent — ${LOAD_REQ} requests, fan-out ${LOAD_CONC}`,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const H = await h();
    const seed = (STRESS_SEED + 9_500_000) >>> 0;
    const prng = new Prng(seed);
    H.reset(seed);
    H.fake.reset(seed, UPSTREAM_MS);
    const userCount = Math.max(LOAD_CONC, Math.ceil(LOAD_REQ / 25));
    const users = Array.from({ length: userCount }, () => mintUser(H, prng));
    for (const [u, user] of users.entries()) {
      await drive(H, `conc:warm:${u}`, syncRequest(user, { shots: [] }));
    }
    // Pre-build every request so the burst measures the handler only.
    const jobs: Array<
      { user: StressUser; batch: BatchShot[]; replayOf: number | null }
    > = [];
    const perUser = new Array(userCount).fill(0);
    for (let i = 0; i < LOAD_REQ; i++) {
      let u = prng.int(0, userCount - 1);
      for (let tries = 0; perUser[u] >= 25 && tries < userCount; tries++) {
        u = (u + 1) % userCount;
      }
      perUser[u] += 1;
      const prior = jobs.map((
        j,
        idx,
      ) => (j.user === users[u] && j.replayOf === null ? idx : -1)).filter((
        x,
      ) => x >= 0);
      if (prior.length > 0 && prng.int(0, 99) < 15) {
        const of = prior[prng.int(0, prior.length - 1)];
        jobs.push({ user: users[u], batch: jobs[of].batch, replayOf: of });
      } else {
        jobs.push({
          user: users[u],
          batch: makeBatch(H, prng, users[u].id, pickBatchSize(prng)),
          replayOf: null,
        });
      }
    }
    const callsBefore = H.calls.length;
    const started = performance.now();
    const results: Array<
      { status: number; accepted: number; batch: number; latencyMs: number }
    > = new Array(jobs.length);
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const i = next++;
        const job = jobs[i];
        const t = performance.now();
        const res = await H.handler(syncRequest(job.user, job.batch));
        const text = await res.text();
        const latencyMs = Math.round((performance.now() - t) * 100) / 100;
        let accepted = 0;
        try {
          const body = JSON.parse(text) as { acceptedIds?: string[] };
          accepted = Array.isArray(body.acceptedIds)
            ? body.acceptedIds.length
            : 0;
        } catch { /* non-JSON */ }
        results[i] = {
          status: res.status,
          accepted,
          batch: job.batch.length,
          latencyMs,
        };
      }
    };
    await Promise.all(Array.from({ length: LOAD_CONC }, worker));
    const wallMs = Math.round(performance.now() - started);
    const calls = H.calls.slice(callsBefore);
    const rt = emptyRoundTrips();
    for (const c of calls) rt[c.upstream] += 1;
    const newShots = new Set(
      jobs.filter((j) => j.replayOf === null).flatMap((j) =>
        j.batch.map((s) => s.id)
      ),
    );
    let dupRows = 0;
    for (const id of newShots) if (shotRows(H, id) !== 1) dupRows += 1;
    const statuses = results.reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});
    const report = {
      suite: "load.concurrent",
      seed,
      requests: results.length,
      concurrency: LOAD_CONC,
      users: userCount,
      upstreamLatencyMaxMs: UPSTREAM_MS,
      wallMs,
      throughputRps: Math.round((results.length / wallMs) * 1000 * 10) / 10,
      statuses,
      allAccepted: results.every((r) =>
        r.status === 200 && r.accepted === r.batch
      ),
      latencyMs: latencyStats(results.map((r) => r.latencyMs)),
      aggregateRoundTrips: rt,
      supabaseTripsPerRequestMean:
        Math.round((supabaseTrips(rt) / results.length) * 100) / 100,
      distinctNewShots: newShots.size,
      shotsWithRowCountNot1: dupRows,
    };
    const path = await writeJson("load_concurrent", report);
    console.log(
      `[stress] load.concurrent: n=${results.length} conc=${LOAD_CONC} p50=${report.latencyMs.p50}ms p95=${report.latencyMs.p95}ms ` +
        `rps=${report.throughputRps} trips/req=${report.supabaseTripsPerRequestMean} → ${path}`,
    );
    assert(report.allAccepted, `statuses ${JSON.stringify(statuses)}`);
    assert(
      dupRows === 0,
      `${dupRows} shots without exactly one row after the burst`,
    );
  },
});

Deno.test({
  name:
    `stress memory.l1 — ${USERS} distinct users (auth L1 cap ${L1_MAX_ENTRIES}, rate windows cap ${MEMORY_WINDOW_MAX})`,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const H = await h();
    const seed = (STRESS_SEED + 9_900_000) >>> 0;
    const prng = new Prng(seed);
    H.reset(seed);
    H.fake.reset(seed, 0);

    // Sentinel: spends 29 of its 30 route hits BEFORE the flood. If the
    // memory rate windows survive the flood, its 30th hit passes and the
    // 31st is 429. rateLimit.ts clears the WHOLE window map once it holds
    // MEMORY_WINDOW_MAX live entries — every flooded user adds two keys
    // (rl:ip:<ip>, rl:shots_sync:<user>).
    // The sentinel's 31 hits must all land in ONE wall-clock minute bucket.
    const { bucket: bucketStart, waitedMs: waitedForBucketMs } =
      await awaitMinuteBucket(
        Math.min(55_000, 3_000 + USERS * 3),
      );
    const sentinel = mintUser(H, prng);
    for (let k = 0; k < ROUTE_LIMIT - 1; k++) {
      const out = await drive(
        H,
        `mem:sentinel:${k}`,
        syncRequest(sentinel, makeBatch(H, prng, sentinel.id, 1)),
      );
      assert(out.status === 200, `sentinel ${k}: ${out.status}`);
    }

    // Control: mint every user FIRST so the fake model's own footprint (user,
    // session, token rows) is measured apart from the edge's L1 + windows.
    const beforeMint = heapNow();
    const flood: StressUser[] = [];
    for (let u = 0; u < USERS; u++) {
      flood.push(mintUser(H, prng, { premium: false }));
    }
    const baseline = heapNow();
    const modelOnlyDelta = baseline.heapUsed - beforeMint.heapUsed;

    const checkpoints: Array<
      {
        users: number;
        heapUsed: number;
        rss: number;
        deltaFromStart: number;
        heapPerUser: number;
      }
    > = [];
    const every = Math.max(1, Math.floor(USERS / 8));
    let cold = 0;
    const statuses: Record<string, number> = {};
    for (let u = 1; u <= USERS; u++) {
      const user = flood[u - 1];
      // Empty body: authenticates (writes the L1 auth row, counts ip + route
      // windows) and stops at validation — no shot rows.
      const out = await drive(H, `mem:${u}`, syncRequest(user, { shots: [] }));
      statuses[out.status] = (statuses[out.status] ?? 0) + 1;
      if (out.roundTrips["gotrue.user"] === 1) cold += 1;
      if (u % every === 0 || u === USERS) {
        const now = heapNow();
        checkpoints.push({
          users: u,
          heapUsed: now.heapUsed,
          rss: now.rss,
          deltaFromStart: now.heapUsed - baseline.heapUsed,
          heapPerUser: Math.round((now.heapUsed - baseline.heapUsed) / u),
        });
      }
    }
    // Drop the harness call log (it grows with every request and is not the
    // edge's memory) and re-measure.
    const callLogEntries = H.calls.length;
    H.calls.length = 0;
    const afterFlood = heapNow();

    const sentinel30 = await drive(
      H,
      "mem:sentinel:30",
      syncRequest(sentinel, makeBatch(H, prng, sentinel.id, 1)),
    );
    const sentinel31Batch = makeBatch(H, prng, sentinel.id, 1);
    const sentinel31 = await drive(
      H,
      "mem:sentinel:31",
      syncRequest(sentinel, sentinel31Batch),
    );
    const bucketEnd = minuteBucket();
    const liveWindowKeys = 2 * USERS + 2; // flood users × (ip, route) + sentinel's own two
    const saturationExpected = liveWindowKeys >= MEMORY_WINDOW_MAX;
    const windowsSurvived = sentinel30.status === 200 &&
      sentinel31.status === 429;
    const windowsCleared = sentinel30.status === 200 &&
      sentinel31.status === 200;

    const report = {
      suite: "memory.l1",
      seed,
      users: USERS,
      coldVerifications: cold,
      statuses,
      gcForced: baseline.gcForced,
      fakeModelOnly: {
        heapDelta: modelOnlyDelta,
        perUser: Math.round(modelOnlyDelta / USERS),
      },
      baseline: { heapUsed: baseline.heapUsed, rss: baseline.rss },
      checkpoints,
      afterFloodCallLogDropped: {
        heapUsed: afterFlood.heapUsed,
        rss: afterFlood.rss,
        deltaFromStart: afterFlood.heapUsed - baseline.heapUsed,
        callLogEntriesDropped: callLogEntries,
        perUser: Math.round((afterFlood.heapUsed - baseline.heapUsed) / USERS),
      },
      caps: {
        l1MaxEntries: L1_MAX_ENTRIES,
        memoryWindowMax: MEMORY_WINDOW_MAX,
      },
      rateWindowSaturation: {
        liveWindowKeysModelled: liveWindowKeys,
        saturationExpected,
        minuteBucket: {
          start: bucketStart,
          end: bucketEnd,
          sameBucket: bucketStart === bucketEnd,
          waitedForBucketMs,
        },
        sentinelStatuses: {
          hit30: sentinel30.status,
          hit31: sentinel31.status,
          hit31RetryAfter: sentinel31.retryAfter,
        },
        windowsSurvived,
        windowsCleared,
        sentinel31Written: shotRows(H, sentinel31Batch[0].id),
      },
      note:
        "afterFloodCallLogDropped.deltaFromStart is measured after all users were minted: it is the edge's L1 auth rows (capped at l1MaxEntries) + memory rate windows (2 per user, capped at memoryWindowMax) + the fake model's per-request residue (auth log)",
    };
    const path = await writeJson("memory_l1", report);
    console.log(
      `[stress] memory.l1: users=${USERS} cold=${cold} heapΔ=${
        Math.round((afterFlood.heapUsed - baseline.heapUsed) / 1024)
      }KiB ` +
        `(${
          Math.round((afterFlood.heapUsed - baseline.heapUsed) / USERS)
        } B/user, model-only ${
          Math.round(modelOnlyDelta / USERS)
        } B/user, gc=${baseline.gcForced}) ` +
        `windows: 30→${sentinel30.status} 31→${sentinel31.status} saturationExpected=${saturationExpected} → ${path}`,
    );
    assert(
      cold === USERS,
      "every distinct user must be verified with GoTrue exactly once",
    );
    assert(sentinel30.status === 200, `sentinel hit 30 → ${sentinel30.status}`);
    assert(
      bucketStart === bucketEnd,
      `inconclusive: the sentinel's hits straddled a minute boundary (${bucketStart}→${bucketEnd}); re-run`,
    );
    if (saturationExpected) {
      // Pinned deviation: with ≥ MEMORY_WINDOW_MAX live keys the memory tier
      // forgets every counter (fail-open) — the 31st hit passes.
      assert(
        windowsCleared,
        `expected the window map to have been cleared; hit31 → ${sentinel31.status}`,
      );
    } else {
      assert(
        windowsSurvived,
        `expected 429 on hit 31; got ${sentinel31.status}`,
      );
    }
  },
});
