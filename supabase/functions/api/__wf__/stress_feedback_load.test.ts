// Stress lens `failure-load`, part 2 — LOAD + FAN-OUT + L1 MEMORY for
// POST /v1/analyses/:id/feedback, driven through the REAL handler in-process
// (no Upstash configured → per-isolate L1 cache + memory rate limits).
//
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json stress_feedback_load.test.ts
//
// Knobs (all optional):
//   STRESS_LOAD_N      requests in the hot-path campaign      (default 1000)
//   STRESS_USERS       distinct users in the L1 memory campaign (default 2000; the
//                      reported run uses 20000)
//   STRESS_SEED        campaign seed — every request is replayable from
//                      seed + index (default 20260905)
//   STRESS_OUT_DIR     where load.json is written
//   --v8-flags=--expose-gc  makes the heap table GC-stable (globalThis.gc)
//
// What is asserted (contract):
//   * every well-formed request answers 201 with a complete body, or 409 on
//     the idempotent resend — never 5xx, never a duplicate row;
//   * a WARM request (auth cached) does exactly 3 Supabase round trips
//     (shots GET, consent GET, feedback POST); a COLD one does 4 (+GoTrue);
//   * the L1 auth cache is bounded: after STRESS_USERS distinct users the
//     earliest user is re-verified against GoTrue (evicted) while a recent
//     one is still served from memory (MEMORY_MAX_ENTRIES = 5000 in cache.ts);
//   * the request keeps answering at the same status/round-trip profile after
//     the rate-limit window map has been through its 20 000-entry reset.
// Latency percentiles and heap numbers are RECORDED (load.json), not asserted:
// they are in-process numbers on the runner, not Supabase edge numbers.

import { assert, assertEquals } from "@std/assert";
import {
  drive,
  envInt,
  feedbackRequest,
  latencySummary,
  loadStressHarness,
  Prng,
  STRESS_SEED,
  writeJson,
} from "./stress_feedback_harness.ts";

const LOAD_N = envInt("STRESS_LOAD_N", 1_000);
const USERS = envInt("STRESS_USERS", 2_000);
/** cache.ts MEMORY_MAX_ENTRIES — the L1 bound the campaign expects to see enforced. */
const L1_MAX_ENTRIES = 5_000;
const HOT_PATH_MAX_ROUND_TRIPS = 3;

const gc: (() => void) | undefined = (globalThis as { gc?: () => void }).gc;
function heap() {
  gc?.();
  const m = Deno.memoryUsage();
  return {
    rss: m.rss,
    heapTotal: m.heapTotal,
    heapUsed: m.heapUsed,
    external: m.external,
  };
}

interface LoadRow {
  i: number;
  seed: number;
  user: number;
  status: number;
  code?: string;
  ms: number;
  roundTrips: number;
  auth: number;
  shots: number;
  consent: number;
  insert: number;
  other: number;
  warm: boolean;
}

Deno.test("stress load: ≥1000 requests p50/p95 + Supabase round trips per request", async () => {
  const h = await loadStressHarness({ redis: false });
  const up = h.upstream;
  up.reset();
  const prng = new Prng(STRESS_SEED ^ 0x10ad);

  // A pool of users, each with its own analyses; ~5 requests per user so the
  // auth cache is exercised both cold and warm.
  const poolSize = Math.max(1, Math.floor(LOAD_N / 5));
  const pool = Array.from({ length: poolSize }, () => {
    const userId = prng.uuid();
    return {
      userId,
      token: up.mintSession(userId),
      ip: `10.${prng.int(0, 255)}.${prng.int(0, 255)}.${prng.int(1, 254)}`,
      seen: false,
    };
  });
  if (prng.next() < 0.5) up.grantConsent(pool[0].userId, "model_training");

  const rows: LoadRow[] = [];
  const failures: string[] = [];
  for (let i = 0; i < LOAD_N; i++) {
    const seed = (STRESS_SEED * 7919 + i) >>> 0;
    const r = new Prng(seed);
    const userIdx = r.int(0, poolSize - 1);
    const u = pool[userIdx];
    const analysisId = r.uuid();
    up.addShot(u.userId, analysisId);
    const body = r.next() < 0.5
      ? { rating: "accurate" }
      : { rating: "not_quite", category: "other" };
    const warm = u.seen;
    const before = up.calls.length;
    const out = await drive(
      h,
      feedbackRequest(analysisId, { token: u.token, ip: u.ip, body }),
    );
    const calls = up.calls.slice(before);
    const count = (t: string) => calls.filter((c) => c.target === t).length;
    const row: LoadRow = {
      i,
      seed,
      user: userIdx,
      status: out.status,
      code: out.code,
      ms: out.ms,
      roundTrips: up.supabaseRoundTrips(before),
      auth: count("auth"),
      shots: count("shots"),
      consent: count("consent"),
      insert: count("insert"),
      other: count("other") + count("rc") + count("redis"),
      warm,
    };
    rows.push(row);
    if (out.status !== 201) {
      failures.push(
        `#${i} seed=${seed}: status ${out.status} ${
          out.bodyText.slice(0, 120)
        }`,
      );
    }
    if (row.other !== 0) {
      failures.push(
        `#${i} seed=${seed}: unexpected upstream calls ${
          JSON.stringify(calls.filter((c) =>
            !["auth", "shots", "consent", "insert"].includes(c.target)
          ))
        }`,
      );
    }
    if (warm && row.roundTrips !== HOT_PATH_MAX_ROUND_TRIPS) {
      failures.push(
        `#${i} seed=${seed}: warm request did ${row.roundTrips} Supabase round trips`,
      );
    }
    if (!warm && row.roundTrips !== HOT_PATH_MAX_ROUND_TRIPS + 1) {
      failures.push(
        `#${i} seed=${seed}: cold request did ${row.roundTrips} Supabase round trips`,
      );
    }
    if (row.auth > 1) {
      failures.push(
        `#${i} seed=${seed}: ${row.auth} GoTrue calls in one request`,
      );
    }
    u.seen = true;
  }
  assertEquals(up.feedback.length, LOAD_N, "one row per accepted request");

  // Idempotent resend of a seeded slice: every second attempt must be the 409
  // and the row count must not move (duplicate delivery is P0).
  const resend = rows.filter((_, i) => i % 10 === 0);
  const resendResults: Array<
    { i: number; seed: number; status: number; code?: string; ms: number }
  > = [];
  for (const row of resend) {
    const r = new Prng(row.seed);
    r.int(0, poolSize - 1);
    const analysisId = r.uuid();
    const body = r.next() < 0.5
      ? { rating: "accurate" }
      : { rating: "not_quite", category: "other" };
    const u = pool[row.user];
    const out = await drive(
      h,
      feedbackRequest(analysisId, { token: u.token, ip: u.ip, body }),
    );
    resendResults.push({
      i: row.i,
      seed: row.seed,
      status: out.status,
      code: out.code,
      ms: out.ms,
    });
    if (out.status !== 409 || out.code !== "analysis.feedback_exists") {
      failures.push(
        `resend #${row.i} seed=${row.seed}: ${out.status} ${out.code}`,
      );
    }
  }
  assertEquals(up.feedback.length, LOAD_N, "resends must not add rows");

  // Concurrent burst: the same seeded requests fired together (fresh analyses).
  const burstN = Math.min(200, LOAD_N);
  const burstStart = performance.now();
  const burst = await Promise.all(Array.from({ length: burstN }, (_, k) => {
    const seed = (STRESS_SEED * 104729 + k) >>> 0;
    const r = new Prng(seed);
    const u = pool[r.int(0, poolSize - 1)];
    const analysisId = r.uuid();
    up.addShot(u.userId, analysisId);
    return drive(
      h,
      feedbackRequest(analysisId, {
        token: u.token,
        ip: u.ip,
        body: { rating: "accurate" },
      }),
    ).then((o) => ({ k, seed, status: o.status, ms: o.ms }));
  }));
  const burstWallMs = performance.now() - burstStart;
  for (const b of burst) {
    if (b.status !== 201) {
      failures.push(`burst #${b.k} seed=${b.seed}: status ${b.status}`);
    }
  }
  assertEquals(up.feedback.length, LOAD_N + burstN, "burst rows");

  const warmRows = rows.filter((r) => r.warm);
  const coldRows = rows.filter((r) => !r.warm);
  const summary = {
    unit: "POST /v1/analyses/:id/feedback",
    seed: STRESS_SEED,
    requests: LOAD_N,
    resends: resend.length,
    burst: burstN,
    burstWallMs: Math.round(burstWallMs),
    burstThroughputRps: Math.round((burstN / burstWallMs) * 1000),
    latencyMs: {
      all: latencySummary(rows.map((r) => r.ms)),
      warm: latencySummary(warmRows.map((r) => r.ms)),
      cold: latencySummary(coldRows.map((r) => r.ms)),
      resend409: latencySummary(resendResults.map((r) => r.ms)),
      burstConcurrent: latencySummary(burst.map((b) => b.ms)),
    },
    supabaseRoundTrips: {
      hotPathBudget: HOT_PATH_MAX_ROUND_TRIPS,
      warm: histogram(warmRows.map((r) => r.roundTrips)),
      cold: histogram(coldRows.map((r) => r.roundTrips)),
      max: Math.max(...rows.map((r) => r.roundTrips)),
      byTarget: {
        auth: rows.reduce((a, r) => a + r.auth, 0),
        shots: rows.reduce((a, r) => a + r.shots, 0),
        consent: rows.reduce((a, r) => a + r.consent, 0),
        insert: rows.reduce((a, r) => a + r.insert, 0),
      },
    },
    statuses: histogram(rows.map((r) => r.status)),
    failures,
    heap: heap(),
    replay:
      `STRESS_SEED=${STRESS_SEED} STRESS_LOAD_N=${LOAD_N} deno test -A --no-check --config deno.json stress_feedback_load.test.ts`,
  };
  const path = await writeJson("load.json", {
    summary,
    rows,
    resendResults,
    burst,
  });
  console.log(
    `[stress-load] ${LOAD_N} requests p50=${summary.latencyMs.all.p50}ms p95=${summary.latencyMs.all.p95}ms warmRoundTrips=${
      JSON.stringify(summary.supabaseRoundTrips.warm)
    } → ${path}`,
  );
  assert(LOAD_N >= 1000, "campaign must run ≥1000 requests");
  assertEquals(failures, []);
});

Deno.test("stress load: L1 auth cache + rate-limit windows under STRESS_USERS distinct users", async () => {
  const h = await loadStressHarness({ redis: false });
  const up = h.upstream;
  up.reset();
  const prng = new Prng(STRESS_SEED ^ 0x20ad);

  // Populate the fake upstream FIRST so its own growth is excluded from the
  // measured delta (the function's L1 + rate-limit maps are what we want).
  const users = Array.from({ length: USERS }, () => {
    const userId = prng.uuid();
    const analysisId = prng.uuid();
    up.addShot(userId, analysisId);
    return {
      userId,
      analysisId,
      token: up.mintSession(userId),
      ip: `10.${prng.int(0, 255)}.${prng.int(0, 255)}.${prng.int(1, 254)}`,
    };
  });
  const heapBefore = heap();
  const checkpoints: Array<
    { users: number; heapUsed: number; rss: number; calls: number }
  > = [];
  const latencies: number[] = [];
  const failures: string[] = [];
  const statusHist = new Map<number, number>();
  for (let i = 0; i < USERS; i++) {
    const u = users[i];
    const before = up.calls.length;
    const out = await drive(
      h,
      feedbackRequest(u.analysisId, {
        token: u.token,
        ip: u.ip,
        body: { rating: "accurate" },
      }),
    );
    latencies.push(out.ms);
    statusHist.set(out.status, (statusHist.get(out.status) ?? 0) + 1);
    if (out.status !== 201) {
      failures.push(
        `user #${i}: status ${out.status} ${out.bodyText.slice(0, 120)}`,
      );
    }
    if (up.supabaseRoundTrips(before) !== 4) {
      failures.push(
        `user #${i}: cold request did ${
          up.supabaseRoundTrips(before)
        } round trips`,
      );
    }
    if ((i + 1) % 2_500 === 0 || i + 1 === USERS) {
      const hp = heap();
      checkpoints.push({
        users: i + 1,
        heapUsed: hp.heapUsed,
        rss: hp.rss,
        calls: up.calls.length,
      });
    }
    // Keep the HARNESS's own logs bounded so the heap delta is the isolate's
    // (L1 cache + rate-limit windows + the fake DB's one row per user).
    if (up.calls.length > 50_000) up.calls.splice(0, up.calls.length - 1_000);
    if (h.accessLog.length > 1_000) {
      h.accessLog.splice(0, h.accessLog.length - 100);
    }
    if (h.serverLog.length > 1_000) {
      h.serverLog.splice(0, h.serverLog.length - 100);
    }
  }
  const heapAfter = heap();
  const fakeDbRows = up.feedback.length;

  // Eviction probe: earliest user must be re-verified (evicted from L1 once
  // more than MEMORY_MAX_ENTRIES sessions were cached); a recent user must
  // still be served from memory (no GoTrue call).
  const probe = async (u: typeof users[number], label: string) => {
    const before = up.calls.length;
    const out = await drive(
      h,
      feedbackRequest(u.analysisId, {
        token: u.token,
        ip: u.ip,
        body: { rating: "accurate" },
      }),
    );
    const authCalls =
      up.calls.slice(before).filter((c) => c.target === "auth").length;
    return {
      label,
      status: out.status,
      code: out.code,
      authCalls,
      roundTrips: up.supabaseRoundTrips(before),
    };
  };
  const first = await probe(users[0], "first user (expected evicted)");
  const last = await probe(users[USERS - 1], "last user (expected cached)");
  if (first.status !== 409) {
    failures.push(`first-user probe: status ${first.status}`);
  }
  if (last.status !== 409) {
    failures.push(`last-user probe: status ${last.status}`);
  }
  if (USERS > L1_MAX_ENTRIES && first.authCalls !== 1) {
    failures.push(
      `first-user probe: ${first.authCalls} GoTrue calls (expected 1: evicted from a ${L1_MAX_ENTRIES}-entry L1)`,
    );
  }
  if (last.authCalls !== 0) {
    failures.push(
      `last-user probe: ${last.authCalls} GoTrue calls (expected 0: L1 hit)`,
    );
  }

  const summary = {
    unit: "POST /v1/analyses/:id/feedback",
    seed: STRESS_SEED,
    distinctUsers: USERS,
    l1MaxEntries: L1_MAX_ENTRIES,
    gcExposed: Boolean(gc),
    heapBefore,
    heapAfter,
    heapDeltaBytes: {
      heapUsed: heapAfter.heapUsed - heapBefore.heapUsed,
      rss: heapAfter.rss - heapBefore.rss,
    },
    heapDeltaPerUserBytes: Math.round(
      (heapAfter.heapUsed - heapBefore.heapUsed) / USERS,
    ),
    /** Rows the fake analysis_feedback table gained during the run — harness
     * memory that is part of the delta above. */
    fakeDbRows,
    checkpoints,
    latencyMs: latencySummary(latencies),
    statuses: Object.fromEntries(statusHist),
    evictionProbe: { first, last },
    failures,
    replay:
      `STRESS_SEED=${STRESS_SEED} STRESS_USERS=${USERS} deno test -A --no-check --config deno.json --v8-flags=--expose-gc stress_feedback_load.test.ts`,
  };
  const path = await writeJson("l1_memory.json", summary);
  console.log(
    `[stress-l1] ${USERS} users heapUsed ${heapBefore.heapUsed}→${heapAfter.heapUsed} (Δ ${summary.heapDeltaBytes.heapUsed} B, ${summary.heapDeltaPerUserBytes} B/user) probes first.auth=${first.authCalls} last.auth=${last.authCalls} → ${path}`,
  );
  assertEquals(failures, []);
});

function histogram(values: number[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
}
