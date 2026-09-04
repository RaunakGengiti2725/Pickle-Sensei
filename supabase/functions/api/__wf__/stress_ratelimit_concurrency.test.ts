// Stress — rateLimit.ts under CONCURRENCY (module level, real rateLimit.ts +
// cache.ts loaded per isolate via harness.loadIsolate; Redis = SeededUpstash).
//
// Campaign U1 (seeded scheduler): every iteration draws a mode
// (memory / redis healthy / redis flaky / redis hang / redis cmd-error /
// redis short-reply / redis expire-only-error), 1–3 isolates sharing one
// Redis, 1–4 keys, a limit, a window, N ≥ limit enforce calls per key spread
// across isolates with seeded pre-delays, interleaved peek calls, and fires
// them all with Promise.all. Invariants: exactly-the-budget admission per key
// (memory: per isolate; Redis: across isolates), every admitted call sees a
// DISTINCT counter value (no lost update), denied ⇒ remaining=0, Retry-After
// within [1, window], peeks never charge, no exception, bounded wall time,
// every Redis window key carries a TTL.
// Campaign U2 (clock skew): Date.now is replaced by a seeded skewed/jittered
// clock; per-bucket admission never exceeds the limit and Retry-After stays
// in range even when the clock jumps across a window boundary mid-burst.
// Campaign U3 (memory cardinality): STRESS_KEYS (default 100_000) distinct
// ids without Redis — heap stays bounded, wall time bounded, and the
// documented eviction defect (a full map clears LIVE windows) is measured.
//
// Replay a row: copy its `replay` field (STRESS_SEED=<seed> STRESS_ITER=1 …).

import { loadIsolate, type RateLimitModule } from "./harness.ts";
import {
  HEALTHY,
  STRESS_ITER,
  STRESS_KEYS,
  STRESS_STRICT,
  type UpstashFaults,
  assertTableHeld,
  configureRedis,
  heapNow,
  histogram,
  inv,
  iterationSeed,
  outDir,
  pickWeighted,
  runCampaign,
  seededUpstash,
  sleep,
} from "./stress_ratelimit_harness.ts";

const FILE = "stress_ratelimit_concurrency.test.ts";

type Mode =
  | "memory"
  | "redis"
  | "redis-flaky"
  | "redis-hang"
  | "redis-cmderr"
  | "redis-short"
  | "redis-expire-err";

type RateLimitResult = Awaited<ReturnType<RateLimitModule["enforceRateLimit"]>>;

interface Call {
  kind: "enforce" | "peek";
  isolate: number;
  key: number;
  delayMs: number;
}

function faultsFor(mode: Mode, latencyMax: number, flakyP: number): UpstashFaults {
  const base: UpstashFaults = {
    ...HEALTHY,
    requestLatencyMaxMs: latencyMax,
    responseLatencyMaxMs: latencyMax,
  };
  switch (mode) {
    case "memory":
    case "redis":
      return base;
    case "redis-flaky":
      return { ...base, httpFailP: flakyP };
    case "redis-hang":
      return { ...base, hangP: 1 };
    case "redis-cmderr":
      return { ...base, commandErrorP: 1 };
    case "redis-short":
      return { ...base, shortReplyP: 1 };
    case "redis-expire-err":
      return { ...base, expireOnlyError: true };
  }
}

Deno.test(
  `stress U1: seeded Promise.all bursts across isolates/keys/modes (${STRESS_ITER} iterations)`,
  async () => {
    const table = await runCampaign(
      FILE,
      "u1_burst_matrix",
      "stress U1",
      STRESS_ITER,
      async ({ prng, params, observations, invariants }) => {
        const mode = pickWeighted<Mode>(prng, [
          ["memory", 25],
          ["redis", 30],
          ["redis-flaky", 20],
          ["redis-hang", 4],
          ["redis-cmderr", 8],
          ["redis-short", 5],
          ["redis-expire-err", 8],
        ]);
        const isolates = prng.int(1, 3);
        const keys = prng.int(1, 4);
        const limit = prng.int(1, 40);
        const windowSeconds = pickWeighted(prng, [
          [2, 1],
          [5, 2],
          [60, 5],
          [300, 3],
          [3600, 2],
        ]);
        const perKey = Array.from({ length: keys }, () => prng.int(limit, 3 * limit));
        const peeks = prng.int(0, Math.ceil(perKey.reduce((a, b) => a + b, 0) / 2));
        const jitterMax = prng.int(0, 8);
        const latencyMax = mode === "memory" ? 0 : prng.int(0, 6);
        const flakyP = mode === "redis-flaky" ? 0.1 + prng.next() * 0.4 : 0;
        Object.assign(params, {
          mode,
          isolates,
          keys,
          limit,
          windowSeconds,
          perKey,
          peeks,
          jitterMax,
          latencyMax,
          flakyP: Math.round(flakyP * 1000) / 1000,
        });

        const calls: Call[] = [];
        perKey.forEach((n, key) => {
          for (let i = 0; i < n; i += 1) {
            calls.push({
              kind: "enforce",
              isolate: prng.int(0, isolates - 1),
              key,
              delayMs: prng.int(0, jitterMax),
            });
          }
        });
        for (let i = 0; i < peeks; i += 1) {
          calls.push({
            kind: "peek",
            isolate: prng.int(0, isolates - 1),
            key: prng.int(0, keys - 1),
            delayMs: prng.int(0, jitterMax),
          });
        }
        const schedule = prng.shuffle(calls);

        configureRedis(mode !== "memory");
        const fake = seededUpstash(prng, faultsFor(mode, latencyMax, flakyP));
        try {
          const modules: RateLimitModule[] = [];
          for (let i = 0; i < isolates; i += 1) modules.push((await loadIsolate()).rateLimit);

          const bucketBefore = Math.floor(Date.now() / 1000 / windowSeconds);
          const t0 = performance.now();
          const settled = await Promise.allSettled(
            schedule.map(async (call) => {
              if (call.delayMs > 0) await sleep(call.delayMs);
              const mod = modules[call.isolate];
              const fn = call.kind === "enforce" ? mod.enforceRateLimit : mod.peekRateLimit;
              const result = await fn("scope", `k${call.key}`, limit, windowSeconds);
              return { call, result };
            }),
          );
          const wallMs = performance.now() - t0;
          const bucketAfter = Math.floor(Date.now() / 1000 / windowSeconds);
          const crossedBoundary = bucketAfter !== bucketBefore;
          observations.wallMs = Math.round(wallMs);
          observations.crossedBoundary = crossedBoundary;
          observations.redis = {
            calls: fake.calls,
            httpFailures: fake.httpFailures,
            hangs: fake.hangs,
            commandErrors: fake.commandErrors,
            shortReplies: fake.shortReplies,
          };

          const rejected = settled.filter((s) => s.status === "rejected");
          inv(
            invariants,
            "no call rejects/throws",
            rejected.length === 0,
            rejected
              .map((r) => String((r as PromiseRejectedResult).reason))
              .slice(0, 3)
              .join(" | "),
          );
          const ok = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));

          // Result-shape invariants on every call.
          let shapeBad = 0;
          const shapeDetail: string[] = [];
          for (const { call, result } of ok) {
            const r: RateLimitResult = result;
            const problems: string[] = [];
            if (r.limit !== limit) problems.push(`limit=${r.limit}`);
            if (!(r.remaining >= 0 && r.remaining <= limit))
              problems.push(`remaining=${r.remaining}`);
            if (!(r.retryAfterSeconds >= 1 && r.retryAfterSeconds <= windowSeconds)) {
              problems.push(`retryAfter=${r.retryAfterSeconds}`);
            }
            if (!r.allowed && r.remaining !== 0)
              problems.push(`denied but remaining=${r.remaining}`);
            if (call.kind === "enforce" && r.allowed && r.remaining >= limit) {
              problems.push(`allowed enforce reports remaining=${r.remaining} (>= limit)`);
            }
            if (problems.length) {
              shapeBad += 1;
              if (shapeDetail.length < 3) shapeDetail.push(problems.join(","));
            }
          }
          inv(
            invariants,
            "result shape: limit echoed, 0≤remaining≤limit, 1≤retryAfter≤window, denied⇒remaining=0",
            shapeBad === 0,
            shapeDetail.join(" | "),
          );

          // Admission accounting per key.
          const degradedToMemory =
            mode === "redis-hang" || mode === "redis-cmderr" || mode === "redis-short";
          const memorySemantics = mode === "memory" || degradedToMemory;
          const admitted: Record<string, number> = {};
          const perIsolate: Record<string, number> = {};
          const countsSeen: Record<string, number[]> = {};
          for (const { call, result } of ok) {
            if (call.kind !== "enforce") continue;
            const k = `k${call.key}`;
            if (result.allowed) {
              admitted[k] = (admitted[k] ?? 0) + 1;
              perIsolate[`${k}/i${call.isolate}`] = (perIsolate[`${k}/i${call.isolate}`] ?? 0) + 1;
              (countsSeen[k] ??= []).push(limit - result.remaining);
            }
          }
          observations.admitted = admitted;
          observations.admittedPerIsolate = perIsolate;

          const enforcePerIsolate: Record<string, number> = {};
          for (const call of schedule) {
            if (call.kind !== "enforce") continue;
            const id = `k${call.key}/i${call.isolate}`;
            enforcePerIsolate[id] = (enforcePerIsolate[id] ?? 0) + 1;
          }

          if (crossedBoundary) {
            // A window rolled over mid-burst: budgets legitimately reset, so the
            // exact figure is unknowable — only the 2× envelope applies.
            const bad = Object.entries(admitted).filter(
              ([k, n]) =>
                n > 2 * limit * (memorySemantics ? isolates : 1) ||
                n < Math.min(limit, perKey[Number(k.slice(1))]),
            );
            inv(
              invariants,
              "admission within [min(N,limit), 2×envelope] (window boundary crossed mid-burst)",
              bad.length === 0,
              JSON.stringify(bad),
            );
            observations.note =
              "window boundary crossed during burst; exact accounting skipped for this seed";
          } else if (memorySemantics) {
            const bad: string[] = [];
            for (const [id, n] of Object.entries(enforcePerIsolate)) {
              const expected = Math.min(n, limit);
              if ((perIsolate[id] ?? 0) !== expected)
                bad.push(`${id}: admitted=${perIsolate[id] ?? 0} expected=${expected}`);
            }
            inv(
              invariants,
              `per-isolate admission == min(N, limit) (${mode} ⇒ per-isolate memory windows)`,
              bad.length === 0,
              bad.join("; "),
            );
          } else if (mode === "redis" || mode === "redis-expire-err") {
            const bad: string[] = [];
            perKey.forEach((n, key) => {
              const k = `k${key}`;
              const expected = Math.min(n, limit);
              if ((admitted[k] ?? 0) !== expected)
                bad.push(`${k}: admitted=${admitted[k] ?? 0} expected=${expected}`);
              const seen = [...(countsSeen[k] ?? [])].sort((a, b) => a - b);
              const distinct = new Set(seen).size === seen.length;
              const contiguous = seen.every((v, i) => v === i + 1);
              if (!distinct || !contiguous)
                bad.push(`${k}: admitted counters not 1..${expected} → ${seen.join(",")}`);
            });
            inv(
              invariants,
              "shared Redis counter: admission == min(N, limit) across isolates AND admitted counters are exactly 1..min(N,limit) (no lost update)",
              bad.length === 0,
              bad.join("; "),
            );
          } else {
            // redis-flaky: documented fail-OPEN — a call whose Redis round trip
            // failed is counted in that isolate's memory window instead, so the
            // worst case is limit (Redis) + limit per isolate (memory).
            const bad: string[] = [];
            perKey.forEach((n, key) => {
              const k = `k${key}`;
              const lo = Math.min(n, limit);
              const hi = Math.min(n, limit * (1 + isolates));
              const got = admitted[k] ?? 0;
              if (got < lo || got > hi) bad.push(`${k}: admitted=${got} outside [${lo},${hi}]`);
            });
            inv(
              invariants,
              "flaky Redis: admission within [min(N,limit), min(N, limit×(1+isolates))] (documented fail-open envelope)",
              bad.length === 0,
              bad.join("; "),
            );
            observations.overAdmission = perKey.map((n, key) =>
              Math.max(0, (admitted[`k${key}`] ?? 0) - Math.min(n, limit)),
            );
          }

          if (mode === "redis" || mode === "redis-flaky") {
            const noTtl = [...fake.store.entries()]
              .filter(([k, v]) => k.startsWith("rl:") && v.expiresAtMs === null)
              .map(([k]) => k);
            inv(
              invariants,
              "every Redis window key carries a TTL",
              noTtl.length === 0,
              noTtl.slice(0, 3).join(","),
            );
          }
          if (mode === "redis-expire-err") {
            const noTtl = [...fake.store.entries()].filter(
              ([k, v]) => k.startsWith("rl:") && v.expiresAtMs === null,
            ).length;
            observations.keysWithoutTtl = noTtl;
            observations.note =
              "EXPIRE errored on every pipeline: INCR result is still trusted (documented in cache.ts redisWindowIncr) — keys observed without TTL recorded, not asserted";
          }

          const hangBudget = mode === "redis-hang" ? 1_500 : 0;
          inv(
            invariants,
            "bounded wall time (no deadlock)",
            wallMs < 5_000 + hangBudget + jitterMax + 2 * latencyMax,
            `${Math.round(wallMs)}ms`,
          );
          observations.statusHistogram = histogram(
            ok.map((x) =>
              x.call.kind === "peek" ? "peek" : x.result.allowed ? "allowed" : "denied",
            ),
          );
        } finally {
          fake.restore();
          configureRedis(false);
        }
      },
      {
        deadlineMs: 15_000,
        totalsFrom: (row) => ({
          calls:
            (row.params.perKey as number[]).reduce((a, b) => a + b, 0) + Number(row.params.peeks),
          isolates: Number(row.params.isolates),
        }),
      },
    );
    console.log(
      `[stress U1] ${table.held} HELD / ${table.broken} BROKEN of ${table.iterations}; calls=${table.totals.calls}; ${table.durationMs}ms`,
    );
    assertTableHeld(table);
  },
);

// ── U2: clock skew / jitter ───────────────────────────────────────────────────

Deno.test(
  `stress U2: clock skew and non-monotonic jitter across a window boundary (${Math.max(4, Math.ceil(STRESS_ITER / 4))} iterations)`,
  async () => {
    const realNow = Date.now;
    const table = await runCampaign(
      FILE,
      "u2_clock_skew",
      "stress U2",
      Math.max(4, Math.ceil(STRESS_ITER / 4)),
      async ({ prng, params, observations, invariants }) => {
        const mode = pickWeighted<"memory" | "redis">(prng, [
          ["memory", 1],
          ["redis", 1],
        ]);
        const windowSeconds = pickWeighted(prng, [
          [2, 2],
          [5, 2],
          [60, 1],
        ]);
        const limit = prng.int(1, 20);
        const n = prng.int(limit + 1, 4 * limit);
        // Jitter up to 40% of the window: a clock that steps by ≥ half a window
        // between two Date.now() reads inside ONE call is an NTP step, not skew.
        const jitterMs = prng.int(0, Math.floor(windowSeconds * 400));
        // Place the virtual clock just before a boundary so jitter straddles it.
        const base = realNow();
        const boundary = (Math.floor(base / 1000 / windowSeconds) + 1) * windowSeconds * 1000;
        const offset = boundary - base - prng.int(0, jitterMs);
        Object.assign(params, { mode, windowSeconds, limit, n, jitterMs, offset });

        const ticks: number[] = [];
        const skewed = () => {
          const v = realNow() + offset + (jitterMs > 0 ? prng.int(-jitterMs, jitterMs) : 0);
          ticks.push(v);
          return v;
        };
        configureRedis(mode === "redis");
        const fake = seededUpstash(prng, HEALTHY);
        fake.now = () => realNow() + offset; // Redis TTL bookkeeping on the skewed clock
        Date.now = skewed;
        try {
          const { rateLimit } = await loadIsolate();
          const t0 = performance.now();
          // Sequential: every call's first Date.now() is windowKey's, so the bucket
          // each call landed in is recoverable from the tick log.
          const results: Array<{
            bucket: number;
            allowed: boolean;
            retryAfterSeconds: number;
            remaining: number;
          }> = [];
          for (let i = 0; i < n; i += 1) {
            const tickIdx = ticks.length;
            const r = await rateLimit.enforceRateLimit("skew", "id", limit, windowSeconds);
            const bucket = Math.floor(ticks[tickIdx] / 1000 / windowSeconds);
            results.push({
              bucket,
              allowed: r.allowed,
              retryAfterSeconds: r.retryAfterSeconds,
              remaining: r.remaining,
            });
          }
          const wallMs = performance.now() - t0;
          const perBucket: Record<string, number> = {};
          for (const r of results)
            if (r.allowed) perBucket[r.bucket] = (perBucket[r.bucket] ?? 0) + 1;
          observations.admittedPerBucket = perBucket;
          observations.bucketsTouched = Object.keys(histogram(results.map((r) => r.bucket))).length;
          inv(
            invariants,
            "per-bucket admission ≤ limit under a jittering clock",
            Object.values(perBucket).every((v) => v <= limit),
            JSON.stringify(perBucket),
          );
          const retryCeiling = windowSeconds + Math.ceil((2 * jitterMs) / 1000);
          const badRetry = results.filter(
            (r) => !(r.retryAfterSeconds >= 1 && r.retryAfterSeconds <= retryCeiling),
          );
          observations.maxRetryAfter = Math.max(...results.map((r) => r.retryAfterSeconds));
          inv(
            invariants,
            `Retry-After ∈ [1, window + 2×jitter] (${retryCeiling}s) even when the clock jumps between windowKey and toResult`,
            badRetry.length === 0,
            badRetry
              .slice(0, 3)
              .map((r) => r.retryAfterSeconds)
              .join(","),
          );
          // Within a single bucket the admitted sequence must be exactly 1..k.
          const seq: Record<string, number[]> = {};
          for (const r of results) if (r.allowed) (seq[r.bucket] ??= []).push(limit - r.remaining);
          const badSeq = Object.entries(seq).filter(([, s]) => s.some((v, i) => v !== i + 1));
          inv(
            invariants,
            "admitted counters are 1..k per bucket (no lost update, no double count)",
            badSeq.length === 0,
            JSON.stringify(badSeq),
          );
          inv(invariants, "bounded wall time", wallMs < 5_000, `${Math.round(wallMs)}ms`);
        } finally {
          Date.now = realNow;
          fake.restore();
          configureRedis(false);
        }
      },
      { deadlineMs: 15_000, totalsFrom: (row) => ({ calls: Number(row.params.n) }) },
    );
    Date.now = realNow;
    console.log(
      `[stress U2] ${table.held} HELD / ${table.broken} BROKEN of ${table.iterations}; calls=${table.totals.calls}`,
    );
    assertTableHeld(table);
  },
);

// ── U3: memory cardinality (STRESS_KEYS distinct ids, no Redis) ──────────────

Deno.test(
  `stress U3: ${STRESS_KEYS} distinct keys on the memory path — bounded heap and wall time; eviction behaviour measured`,
  async () => {
    configureRedis(false);
    const seed = iterationSeed(0);
    const { rateLimit } = await loadIsolate();
    const MEMORY_WINDOW_MAX = 20_000; // rateLimit.ts
    const invariants: Parameters<typeof inv>[0] = [];
    const observations: Record<string, unknown> = {};

    // A limited victim whose LIVE window must survive unrelated traffic.
    for (let i = 0; i < 3; i += 1) await rateLimit.enforceRateLimit("ip", "victim", 3, 60);
    const victimLimitedBefore = !(await rateLimit.enforceRateLimit("ip", "victim", 3, 60)).allowed;

    const heapBefore = heapNow();
    const t0 = performance.now();
    let allowed = 0;
    let victimReopenedAt: number | null = null;
    const checkpoints: Array<{ keys: number; heapUsed: number; victimAllowed: boolean }> = [];
    for (let i = 0; i < STRESS_KEYS; i += 1) {
      const r = await rateLimit.enforceRateLimit("ip", `flood-${seed}-${i}`, 300, 60);
      if (r.allowed) allowed += 1;
      if ((i + 1) % MEMORY_WINDOW_MAX === 0) {
        const victim = await rateLimit.peekRateLimit("ip", "victim", 3, 60);
        checkpoints.push({
          keys: i + 1,
          heapUsed: heapNow().heapUsed,
          victimAllowed: victim.allowed,
        });
        if (victim.allowed && victimReopenedAt === null) victimReopenedAt = i + 1;
      }
    }
    const wallMs = performance.now() - t0;
    const heapAfter = heapNow();
    const victimAfter = await rateLimit.peekRateLimit("ip", "victim", 3, 60);

    Object.assign(observations, {
      keys: STRESS_KEYS,
      allowed,
      wallMs: Math.round(wallMs),
      heapBefore,
      heapAfter,
      heapDeltaMB:
        Math.round(((heapAfter.heapUsed - heapBefore.heapUsed) / 1024 / 1024) * 100) / 100,
      checkpoints,
      victimLimitedBefore,
      victimAllowedAfter: victimAfter.allowed,
      victimReopenedAtKeys: victimReopenedAt,
    });

    inv(invariants, "precondition: victim is limited before the flood", victimLimitedBefore);
    inv(
      invariants,
      `every one of ${STRESS_KEYS} fresh keys is admitted (first hit each)`,
      allowed === STRESS_KEYS,
      `allowed=${allowed}`,
    );
    inv(
      invariants,
      "heap growth bounded (< 64 MB for the whole flood; map capped at 20k entries)",
      heapAfter.heapUsed - heapBefore.heapUsed < 64 * 1024 * 1024,
      `${observations.heapDeltaMB} MB`,
    );
    inv(invariants, "bounded wall time (< 10 s)", wallMs < 10_000, `${Math.round(wallMs)}ms`);
    // Pinned defect (rateLimit.test.ts "[defect] memory fallback: 20 000
    // distinct ids wipe EVERY live window"): a full map with no expired entries
    // is CLEARED, releasing every live window on this isolate. The suite run
    // records it as an observation; STRESS_STRICT=1 asserts the header's
    // "still stops any single runaway client" claim and fails on it.
    inv(
      invariants,
      `${STRESS_STRICT ? "" : "observation only (known defect, STRESS_STRICT=1 asserts it): "}a limited victim stays refused across ${STRESS_KEYS} unrelated keys`,
      STRESS_STRICT ? !victimAfter.allowed : true,
      `victimAllowedAfter=${victimAfter.allowed} reopenedAt=${victimReopenedAt ?? "never"} keys`,
    );

    const out = outDir();
    await Deno.mkdir(out, { recursive: true });
    await Deno.writeTextFile(
      `${out}u3_memory_cardinality.json`,
      JSON.stringify(
        {
          campaign: "u3_memory_cardinality",
          file: FILE,
          seed,
          generatedAt: new Date().toISOString(),
          deno: Deno.version.deno,
          params: {
            STRESS_KEYS,
            MEMORY_WINDOW_MAX,
            victimLimit: 3,
            floodLimit: 300,
            windowSeconds: 60,
          },
          observations,
          invariants,
          outcome: invariants.every((x) => x.holds) ? "HELD" : "BROKEN",
          replay: `STRESS_SEED=${seed} STRESS_KEYS=${STRESS_KEYS} STRESS_STRICT=${STRESS_STRICT ? 1 : 0} deno test -A --no-check --config deno.json ${FILE} --filter "stress U3"`,
        },
        null,
        2,
      ),
    );
    console.log(
      `[stress U3] keys=${STRESS_KEYS} wall=${Math.round(wallMs)}ms heapΔ=${observations.heapDeltaMB}MB victimReopenedAt=${victimReopenedAt}`,
    );
    const broken = invariants.filter((x) => !x.holds);
    if (broken.length) throw new Error(broken.map((x) => `${x.name}: ${x.detail}`).join("\n"));
  },
);
