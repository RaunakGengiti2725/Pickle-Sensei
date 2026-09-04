// Adversarial probes against rateLimit.ts / cache.ts behaviour that the
// existing suite does not measure: fixed-window boundary bursts, Retry-After
// exactness across a whole window, Redis-outage latency amplification, and
// the budget an attacker regains when Redis flaps.
//
//   deno run -A tools/adversarial/rate-limit-dos/limiter_attacks.ts
//
// Nothing here mutates production code: each scenario loads its own isolate
// of cache.ts + rateLimit.ts through the repo's existing test harness.

import {
  configureRedis,
  fakeUpstash,
  loadIsolate,
} from "../../../supabase/functions/api/__wf__/harness.ts";
import { outPath, println, writeReport } from "./report.ts";

const OUT = outPath("artifacts/xc-rate-limit-dos/limiter_attacks.json");

const SEED = 0x5eed_1337;
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

/** Freeze/advance the clock the limiter reads (Date.now is called per hit). */
const realNow = Date.now;
let fakeNowMs: number | null = null;
Date.now = () => (fakeNowMs === null ? realNow() : fakeNowMs);
function setClock(ms: number): void {
  fakeNowMs = ms;
}
function releaseClock(): void {
  fakeNowMs = null;
}

// ── 1. Fixed-window boundary burst ───────────────────────────────────────────
// Aligned buckets mean the budget resets on the wall clock, not per client, so
// a client that waits for the boundary gets `2 × limit` inside one window
// length. This measures the worst-case burst for the real production budgets.
async function windowBoundaryBurst(scope: string, limit: number, windowSeconds: number) {
  configureRedis(false);
  const iso = await loadIsolate();
  const windowMs = windowSeconds * 1_000;
  // Land 1 ms before a bucket boundary.
  const boundary = Math.floor(1_780_000_000_000 / windowMs) * windowMs + windowMs;
  setClock(boundary - 1);
  let allowedBefore = 0;
  for (let i = 0; i < limit + 5; i += 1) {
    const r = await iso.rateLimit.enforceRateLimit(scope, "burst-client", limit, windowSeconds);
    if (r.allowed) allowedBefore += 1;
  }
  const denied = await iso.rateLimit.enforceRateLimit(scope, "burst-client", limit, windowSeconds);
  const retryAfterAtBoundary = denied.retryAfterSeconds;
  // The very next millisecond is a new bucket.
  setClock(boundary);
  let allowedAfter = 0;
  for (let i = 0; i < limit + 5; i += 1) {
    const r = await iso.rateLimit.enforceRateLimit(scope, "burst-client", limit, windowSeconds);
    if (r.allowed) allowedAfter += 1;
  }
  releaseClock();
  return {
    scope,
    limit,
    windowSeconds,
    allowedJustBeforeBoundary: allowedBefore,
    allowedJustAfterBoundary: allowedAfter,
    allowedInsideTwoMilliseconds: allowedBefore + allowedAfter,
    burstFactorVsLimit: Number(((allowedBefore + allowedAfter) / limit).toFixed(2)),
    retryAfterSecondsWhenBlocked1msBeforeReset: retryAfterAtBoundary,
  };
}

// ── 2. Retry-After exactness across a full window ────────────────────────────
// Retry-After must never overshoot the bucket (a client that waits it out must
// find the budget reset) and never be < 1 s.
async function retryAfterSweep(windowSeconds: number, samples: number) {
  configureRedis(false);
  const iso = await loadIsolate();
  const windowMs = windowSeconds * 1_000;
  const base = Math.floor(1_780_000_000_000 / windowMs) * windowMs;
  const rnd = lcg(SEED);
  let maxOvershootSeconds = 0;
  let minRetryAfter = Number.POSITIVE_INFINITY;
  let maxRetryAfter = 0;
  let belowOne = 0;
  let waitStillBlocked = 0;
  const offsets: number[] = [];
  for (let s = 0; s < samples; s += 1) {
    const offsetMs = s === 0 ? 0 : s === 1 ? windowMs - 1 : rnd() % windowMs;
    offsets.push(offsetMs);
    const id = `sweep-${s}`;
    setClock(base + offsetMs);
    await iso.rateLimit.enforceRateLimit("sweep", id, 1, windowSeconds);
    const blocked = await iso.rateLimit.enforceRateLimit("sweep", id, 1, windowSeconds);
    if (blocked.allowed) {
      throw new Error("sweep: second hit against a limit of 1 was allowed");
    }
    const retryAfter = blocked.retryAfterSeconds;
    if (retryAfter < 1) belowOne += 1;
    minRetryAfter = Math.min(minRetryAfter, retryAfter);
    maxRetryAfter = Math.max(maxRetryAfter, retryAfter);
    const trueRemainingSeconds = (windowMs - offsetMs) / 1_000;
    maxOvershootSeconds = Math.max(maxOvershootSeconds, retryAfter - trueRemainingSeconds);
    // Honour the header: wait exactly Retry-After seconds, then retry.
    setClock(base + offsetMs + retryAfter * 1_000);
    const after = await iso.rateLimit.enforceRateLimit("sweep", id, 1, windowSeconds);
    if (!after.allowed) waitStillBlocked += 1;
  }
  releaseClock();
  return {
    windowSeconds,
    samples,
    seed: SEED,
    firstOffsetsMs: offsets.slice(0, 8),
    minRetryAfterSeconds: minRetryAfter,
    maxRetryAfterSeconds: maxRetryAfter,
    retryAfterBelowOneSecond: belowOne,
    maxOvershootSecondsPastBucketEnd: Number(maxOvershootSeconds.toFixed(3)),
    clientsStillBlockedAfterHonouringRetryAfter: waitStillBlocked,
  };
}

// ── 3. Redis outage: latency amplification and fail-open shape ───────────────
// Every Redis call is bounded by REDIS_TIMEOUT_MS = 1 200 (cache.ts:18). A
// blackholed Upstash (TCP accepted, no response) therefore costs that timeout
// on EVERY limiter call, and an authenticated request makes several.
async function redisOutageCost() {
  configureRedis(true);
  const iso = await loadIsolate();
  const fake = fakeUpstash();
  try {
    // (a) hard error → fast fail-open onto the in-memory window
    fake.failStatus = 500;
    const errStart = performance.now();
    const errFirst = await iso.rateLimit.enforceRateLimit("ip", "outage-a", 2, 60);
    await iso.rateLimit.enforceRateLimit("ip", "outage-a", 2, 60);
    const errThird = await iso.rateLimit.enforceRateLimit("ip", "outage-a", 2, 60);
    const errorMsPerCall = (performance.now() - errStart) / 3;

    // (b) blackhole → each call burns the client-side timeout
    fake.failStatus = null;
    fake.hang = true;
    const hangStart = performance.now();
    const hangResult = await iso.rateLimit.enforceRateLimit("ip", "outage-b", 2, 60);
    const hangMsPerCall = performance.now() - hangStart;

    // What a single authenticated request pays: session-cache GET + ip INCR +
    // authfail GET + per-user INCR (index.ts:2892-2968, 352).
    const callsPerAuthedRequest = 4;
    return {
      redisTimeoutMsFromSource: 1_200,
      hardError500: {
        msPerLimiterCall: Number(errorMsPerCall.toFixed(2)),
        firstHitAllowed: errFirst.allowed,
        thirdHitAllowedWithLimit2: errThird.allowed,
        failsOpenGlobally: errThird.allowed,
      },
      blackholeHang: {
        msPerLimiterCall: Number(hangMsPerCall.toFixed(2)),
        hitAllowed: hangResult.allowed,
        estimatedAddedMsPerAuthedRequest: Number(
          (hangMsPerCall * callsPerAuthedRequest).toFixed(2),
        ),
        callsPerAuthedRequest,
      },
      redisCallsObserved: fake.calls,
    };
  } finally {
    fake.hang = false;
    fake.restore();
  }
}

// ── 4. Redis flap: how much budget an attacker regains ───────────────────────
// While Redis is down the limiter counts in PER-ISOLATE memory. Each isolate
// therefore grants a fresh full budget, and the shared Redis counter is frozen
// at its pre-outage value, so it grants another full budget on recovery.
async function redisFlapBudget(limit: number, windowSeconds: number) {
  configureRedis(true);
  const shared = fakeUpstash();
  try {
    const isoA = await loadIsolate();
    const isoB = await loadIsolate();
    const id = "flap-victim";
    let allowedOnline = 0;
    for (let i = 0; i < limit + 5; i += 1) {
      if ((await isoA.rateLimit.enforceRateLimit("authfail", id, limit, windowSeconds)).allowed) {
        allowedOnline += 1;
      }
    }
    const blockedWhileOnline = !(
      await isoB.rateLimit.peekRateLimit("authfail", id, limit, windowSeconds)
    ).allowed;

    // Redis goes away.
    shared.failStatus = 500;
    let allowedDuringOutageIsoA = 0;
    let allowedDuringOutageIsoB = 0;
    for (let i = 0; i < limit + 5; i += 1) {
      if ((await isoA.rateLimit.enforceRateLimit("authfail", id, limit, windowSeconds)).allowed) {
        allowedDuringOutageIsoA += 1;
      }
      if ((await isoB.rateLimit.enforceRateLimit("authfail", id, limit, windowSeconds)).allowed) {
        allowedDuringOutageIsoB += 1;
      }
    }
    const peekDuringOutage = await isoA.rateLimit.peekRateLimit(
      "authfail",
      id,
      limit,
      windowSeconds,
    );

    // Redis comes back inside the SAME window.
    shared.failStatus = null;
    let allowedAfterRecovery = 0;
    for (let i = 0; i < limit + 5; i += 1) {
      if ((await isoA.rateLimit.enforceRateLimit("authfail", id, limit, windowSeconds)).allowed) {
        allowedAfterRecovery += 1;
      }
    }
    return {
      limit,
      windowSeconds,
      allowedWhileRedisOnline: allowedOnline,
      blockedInASecondIsolateWhileOnline: blockedWhileOnline,
      allowedDuringOutageIsolateA: allowedDuringOutageIsoA,
      allowedDuringOutageIsolateB: allowedDuringOutageIsoB,
      peekAllowedDuringOutage: peekDuringOutage.allowed,
      allowedAfterRecoverySameWindow: allowedAfterRecovery,
      totalAllowedInOneWindow:
        allowedOnline + allowedDuringOutageIsoA + allowedDuringOutageIsoB + allowedAfterRecovery,
      budgetInflationFactor: Number(
        (
          (allowedOnline +
            allowedDuringOutageIsoA +
            allowedDuringOutageIsoB +
            allowedAfterRecovery) /
          limit
        ).toFixed(2),
      ),
      note: "each concurrent isolate grants its own full budget while Redis is unavailable",
    };
  } finally {
    shared.restore();
  }
}

// ── 5. Key flood with Redis CONFIGURED (does the wipe still apply?) ──────────
async function redisKeyFlood(keys: number) {
  configureRedis(true);
  const fake = fakeUpstash();
  try {
    const iso = await loadIsolate();
    const victim = "203.0.113.7";
    for (let i = 0; i < 3; i += 1) {
      await iso.rateLimit.enforceRateLimit("ip", victim, 3, 60);
    }
    const deniedBefore = !(await iso.rateLimit.peekRateLimit("ip", victim, 3, 60)).allowed;
    const rnd = lcg(SEED);
    for (let i = 0; i < keys; i += 1) {
      await iso.rateLimit.enforceRateLimit(
        "ip",
        `${(rnd() % 4294967295).toString(16)}-${i}`,
        1_200,
        60,
      );
    }
    const after = await iso.rateLimit.peekRateLimit("ip", victim, 3, 60);
    return {
      keys,
      victimDeniedBeforeFlood: deniedBefore,
      victimAllowedAfterFlood: after.allowed,
      redisKeysHeld: fake.store.size,
      note: "with Upstash configured the limiter never touches the memory map, so the clear() wipe does not apply; the flood becomes Redis keyspace instead",
    };
  } finally {
    fake.restore();
  }
}

const report = {
  harness: "tools/adversarial/rate-limit-dos/limiter_attacks.ts",
  target: "supabase/functions/api/rateLimit.ts + cache.ts",
  deno: Deno.version.deno,
  seed: SEED,
  measuredAt: new Date().toISOString(),
  windowBoundaryBursts: [
    await windowBoundaryBurst("ip", 1_200, 60),
    await windowBoundaryBurst("authfail", 30, 300),
    await windowBoundaryBurst("auth_refresh", 30, 60),
    await windowBoundaryBurst("user", 240, 60),
    await windowBoundaryBurst("delete_request", 3, 3_600),
  ],
  retryAfterSweeps: [
    await retryAfterSweep(60, 600),
    await retryAfterSweep(300, 600),
    await retryAfterSweep(3_600, 600),
  ],
  redisOutage: await redisOutageCost(),
  redisFlap: await redisFlapBudget(30, 300),
  redisKeyFlood: await redisKeyFlood(25_000),
};

for (const b of report.windowBoundaryBursts) {
  println(
    `boundary burst ${b.scope} ${b.limit}/${b.windowSeconds}s: ${b.allowedInsideTwoMilliseconds} ` +
      `allowed across the reset (${b.burstFactorVsLimit}× limit), ` +
      `Retry-After 1 ms before reset = ${b.retryAfterSecondsWhenBlocked1msBeforeReset}s`,
  );
}
for (const s of report.retryAfterSweeps) {
  println(
    `retry-after ${s.windowSeconds}s window: min ${s.minRetryAfterSeconds}s max ` +
      `${s.maxRetryAfterSeconds}s, overshoot ${s.maxOvershootSecondsPastBucketEnd}s, ` +
      `<1s ${s.retryAfterBelowOneSecond}, still-blocked-after-waiting ` +
      `${s.clientsStillBlockedAfterHonouringRetryAfter}`,
  );
}
println(
  `redis 500: ${report.redisOutage.hardError500.msPerLimiterCall} ms/call, fails open globally ` +
    `${report.redisOutage.hardError500.failsOpenGlobally}; blackhole: ` +
    `${report.redisOutage.blackholeHang.msPerLimiterCall} ms/call ≈ ` +
    `${report.redisOutage.blackholeHang.estimatedAddedMsPerAuthedRequest} ms/request`,
);
println(
  `redis flap: ${report.redisFlap.totalAllowedInOneWindow} auth failures allowed in one ` +
    `${report.redisFlap.windowSeconds}s window against a limit of ${report.redisFlap.limit} ` +
    `(${report.redisFlap.budgetInflationFactor}×)`,
);
println(
  `redis keyflood ${report.redisKeyFlood.keys}: victim unblocked = ` +
    `${report.redisKeyFlood.victimAllowedAfterFlood}, redis keys held = ` +
    `${report.redisKeyFlood.redisKeysHeld}`,
);
await writeReport(OUT, report);
