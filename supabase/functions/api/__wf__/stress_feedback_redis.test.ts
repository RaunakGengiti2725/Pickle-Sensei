// Stress lens `failure-load`, part 3 — UPSTASH (L2 cache + rate limits) faults
// for POST /v1/analyses/:id/feedback. Separate file on purpose: cache.ts reads
// UPSTASH_REDIS_REST_URL/TOKEN at import time, so the Redis-configured isolate
// cannot share a process with the memory-only campaigns.
//
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json stress_feedback_redis.test.ts
//   STRESS_ITER=3 …  → 3 seeds per case
//
// Contract under test: an Upstash outage (HTTP error, socket failure, hang
// past REDIS_TIMEOUT_MS, malformed reply, poisoned cache row) must never turn
// a well-formed feedback submission into an error — the function degrades to
// per-isolate memory — and a Redis-reported over-budget counter must still be
// honoured as a 429 with Retry-After. Redis pipelines per request are counted
// (fan-out) and the hang case records how much latency a dead Redis adds.

import { assert, assertEquals } from "@std/assert";
import {
  drive,
  type FaultMode,
  feedbackRequest,
  latencySummary,
  loadStressHarness,
  seededCase,
  STRESS_ITER,
  STRESS_SEED,
  writeJson,
} from "./stress_feedback_harness.ts";

interface RedisCase {
  id: string;
  title: string;
  fault: FaultMode;
  /** Status the faulted request must answer with (201 = degraded-but-served). */
  expectStatus: number;
  expectCode?: string;
  /** Expected recovery status after the fault clears (same request resent). */
  expectRecovery: number;
  /** Whether the auth verification must still reach GoTrue exactly once. */
  authCalls?: number;
}

const CANARY = "STRESS_CANARY_7f3a";
const REDIS_TIMEOUT_MS = 1_200;

const CASES: RedisCase[] = [
  {
    id: "RD01",
    title: "control: healthy Upstash",
    fault: { kind: "ok" },
    expectStatus: 201,
    expectRecovery: 409,
    authCalls: 1,
  },
  {
    id: "RD02",
    title: "Upstash 500",
    fault: { kind: "http", status: 500 },
    expectStatus: 201,
    expectRecovery: 409,
    authCalls: 1,
  },
  {
    id: "RD03",
    title: "Upstash 401 (bad token)",
    fault: { kind: "http", status: 401 },
    expectStatus: 201,
    expectRecovery: 409,
    authCalls: 1,
  },
  {
    id: "RD04",
    title: "Upstash 429 (Upstash quota)",
    fault: { kind: "http", status: 429, headers: { "Retry-After": "30" } },
    expectStatus: 201,
    expectRecovery: 409,
    authCalls: 1,
  },
  {
    id: "RD05",
    title: "Upstash 503",
    fault: { kind: "http", status: 503 },
    expectStatus: 201,
    expectRecovery: 409,
    authCalls: 1,
  },
  {
    id: "RD06",
    title: "Upstash socket failure",
    fault: { kind: "throw" },
    expectStatus: 201,
    expectRecovery: 409,
    authCalls: 1,
  },
  {
    id: "RD07",
    title:
      `Upstash hangs past REDIS_TIMEOUT_MS (${REDIS_TIMEOUT_MS} ms per pipeline)`,
    fault: { kind: "hang", ms: REDIS_TIMEOUT_MS + 800 },
    expectStatus: 201,
    expectRecovery: 409,
    authCalls: 1,
  },
  {
    id: "RD08",
    title: "Upstash 200 non-JSON",
    fault: { kind: "malformed" },
    expectStatus: 201,
    expectRecovery: 409,
    authCalls: 1,
  },
  {
    id: "RD09",
    title: "Upstash 200 empty body",
    fault: { kind: "empty" },
    expectStatus: 201,
    expectRecovery: 409,
    authCalls: 1,
  },
  {
    id: "RD10",
    title: "Upstash 200 object instead of array",
    fault: { kind: "shape", body: { result: "OK" } },
    expectStatus: 201,
    expectRecovery: 409,
    authCalls: 1,
  },
  {
    id: "RD11",
    title: "Upstash 200 every slot is an error",
    fault: {
      kind: "shape",
      body: [{ error: `ERR ${CANARY}` }, { error: `ERR ${CANARY}` }, {
        error: `ERR ${CANARY}`,
      }],
    },
    expectStatus: 201,
    expectRecovery: 409,
    authCalls: 1,
  },
  {
    id: "RD12",
    title: "Upstash 200 slots of the wrong type",
    fault: {
      kind: "shape",
      body: [{ result: 7 }, { result: true }, { result: { nested: CANARY } }],
    },
    expectStatus: 201,
    expectRecovery: 409,
    authCalls: 1,
  },
  {
    id: "RD13",
    title: "Upstash 200 fewer slots than commands",
    fault: { kind: "shape", body: [] },
    expectStatus: 201,
    expectRecovery: 409,
    authCalls: 1,
  },
  {
    id: "RD14",
    title: "Upstash 200 `null`",
    fault: { kind: "shape", body: null },
    expectStatus: 201,
    expectRecovery: 409,
    authCalls: 1,
  },
  {
    id: "RD15",
    title: "Upstash 500 with 100 KB body",
    fault: { kind: "http", status: 500, body: CANARY.repeat(7_000) },
    expectStatus: 201,
    expectRecovery: 409,
    authCalls: 1,
  },
  {
    id: "RD16",
    title: "Upstash reports the per-user budget exhausted (INCR → 10 000)",
    fault: {
      kind: "shape",
      body: [{ result: 10_000 }, { result: 1 }, { result: null }],
    },
    expectStatus: 429,
    expectCode: "rate_limited",
    expectRecovery: 201,
  },
  {
    id: "RD17",
    title: "Upstash answers INCR with a string count",
    fault: {
      kind: "shape",
      body: [{ result: "9999" }, { result: 1 }, { result: null }],
    },
    expectStatus: 429,
    expectCode: "rate_limited",
    expectRecovery: 201,
  },
  {
    id: "RD18",
    title:
      "Upstash answers every slot with an object (INCR → NaN must fall back to memory)",
    fault: {
      kind: "shape",
      body: [{ result: {} }, { result: {} }, { result: {} }],
    },
    expectStatus: 201,
    expectRecovery: 409,
    authCalls: 1,
  },
  // Any string in the revocation-marker slot is trusted as "revoked" and pinned
  // in L1 for L1_READTHROUGH_TTL_SECONDS: fail-closed by design, so the resend
  // after Upstash recovers is still refused at this isolate (recorded, not a
  // BROKEN verdict — see the findings table).
  {
    id: "RD19",
    title:
      "Upstash answers every slot with a string (revocation marker read as set → 401, pinned in L1 60 s)",
    fault: {
      kind: "shape",
      body: [{ result: "lots" }, { result: "lots" }, { result: "lots" }],
    },
    expectStatus: 401,
    expectRecovery: 401,
    authCalls: 0,
  },
];

interface Row {
  id: string;
  title: string;
  seed: number;
  fault: FaultMode;
  faulted: {
    status: number;
    code?: string;
    retryAfter: string | null;
    ms: number;
    redisPipelines: number;
    redisCommands: number;
    authCalls: number;
    supabaseRoundTrips: number;
    bodyText: string;
  };
  recovered: {
    status: number;
    code?: string;
    ms: number;
    redisPipelines: number;
    authCalls: number;
  } | null;
  expected: {
    status: number;
    code?: string;
    recovery: number;
    authCalls?: number;
  };
  verdict: "HELD" | "BROKEN";
  failures: string[];
  replay: string;
}

Deno.test("stress redis: Upstash faults × STRESS_ITER seeds against POST /v1/analyses/:id/feedback", async () => {
  const h = await loadStressHarness({ redis: true });
  const up = h.upstream;
  const rows: Row[] = [];

  for (const c of CASES) {
    for (let i = 0; i < STRESS_ITER; i++) {
      const seed =
        (STRESS_SEED * 1_000 + 500_000 + CASES.indexOf(c) * 100 + i) >>> 0;
      up.reset();
      const s = seededCase(seed);
      const token = up.mintSession(s.userId);
      up.addShot(s.userId, s.analysisId);
      if (s.consentGranted) up.grantConsent(s.userId, "model_training");

      const failures: string[] = [];
      up.plan = { redis: c.fault };
      const before = up.calls.length;
      const beforeCmds = up.redisCommands.length;
      const out = await drive(
        h,
        feedbackRequest(s.analysisId, { token, ip: s.ip, body: s.body }),
      );
      const calls = up.calls.slice(before);
      const faulted = {
        status: out.status,
        code: out.code,
        retryAfter: out.retryAfter,
        ms: out.ms,
        redisPipelines: calls.filter((x) => x.target === "redis").length,
        redisCommands: up.redisCommands.length - beforeCmds,
        authCalls: calls.filter((x) => x.target === "auth").length,
        supabaseRoundTrips: up.supabaseRoundTrips(before),
        bodyText: out.bodyText.slice(0, 400),
      };
      if (out.status !== c.expectStatus) {
        failures.push(`status ${out.status} ≠ ${c.expectStatus}`);
      }
      if (c.expectCode && out.code !== c.expectCode) {
        failures.push(`code ${out.code} ≠ ${c.expectCode}`);
      }
      if (out.status === 429 && !out.retryAfter) {
        failures.push("429 without Retry-After");
      }
      if (
        out.bodyText.includes(CANARY) || /upstash|redis/i.test(out.bodyText)
      ) {
        failures.push(`upstream detail leaked: ${out.bodyText.slice(0, 200)}`);
      }
      if (c.authCalls !== undefined && faulted.authCalls !== c.authCalls) {
        failures.push(`${faulted.authCalls} GoTrue calls ≠ ${c.authCalls}`);
      }
      if (out.status === 201 && up.feedback.length !== 1) {
        failures.push(`${up.feedback.length} rows after a 201`);
      }
      if (out.status !== 201 && up.feedback.length !== 0) {
        failures.push(`${up.feedback.length} rows after a ${out.status}`);
      }
      if (out.status === 201) {
        const parsed = JSON.parse(out.bodyText) as {
          feedback?: { reviewEligible?: boolean };
        };
        if (parsed.feedback?.reviewEligible !== s.consentGranted) {
          failures.push(
            `reviewEligible ${parsed.feedback?.reviewEligible} ≠ ${s.consentGranted}`,
          );
        }
      }

      // Recovery: Upstash healthy again, identical resend.
      up.plan = {};
      const before2 = up.calls.length;
      const out2 = await drive(
        h,
        feedbackRequest(s.analysisId, { token, ip: s.ip, body: s.body }),
      );
      const calls2 = up.calls.slice(before2);
      const recovered = {
        status: out2.status,
        code: out2.code,
        ms: out2.ms,
        redisPipelines: calls2.filter((x) => x.target === "redis").length,
        authCalls: calls2.filter((x) => x.target === "auth").length,
      };
      if (out2.status !== c.expectRecovery) {
        failures.push(`recovery status ${out2.status} ≠ ${c.expectRecovery}`);
      }
      const expectedRows = c.expectRecovery === 401 ? 0 : 1;
      if (up.feedback.length !== expectedRows) {
        failures.push(
          `${up.feedback.length} rows after recovery (expected exactly ${expectedRows})`,
        );
      }

      rows.push({
        id: c.id,
        title: c.title,
        seed,
        fault: c.fault,
        faulted,
        recovered,
        expected: {
          status: c.expectStatus,
          code: c.expectCode,
          recovery: c.expectRecovery,
          authCalls: c.authCalls,
        },
        verdict: failures.length === 0 ? "HELD" : "BROKEN",
        failures,
        replay:
          `STRESS_SEED=${STRESS_SEED} STRESS_ITER=${STRESS_ITER} deno test -A --no-check --config deno.json stress_feedback_redis.test.ts  # case ${c.id} seed ${seed}`,
      });
    }
  }

  // Fan-out under a healthy Upstash: how many pipelines does a cold and a
  // warm request issue? (recorded; a warm request must not re-read GoTrue)
  up.reset();
  up.plan = {};
  const s = seededCase(STRESS_SEED ^ 0xfa0);
  const token = up.mintSession(s.userId);
  const analyses = Array.from({ length: 4 }, (_, k) => {
    const id = seededCase(seed32(STRESS_SEED, k)).analysisId;
    up.addShot(s.userId, id);
    return id;
  });
  const fanout: Array<
    {
      warm: boolean;
      status: number;
      ms: number;
      redisPipelines: number;
      redisCommands: string[];
      authCalls: number;
      supabaseRoundTrips: number;
    }
  > = [];
  for (const [k, id] of analyses.entries()) {
    const before = up.calls.length;
    const beforeCmds = up.redisCommands.length;
    const out = await drive(
      h,
      feedbackRequest(id, { token, ip: s.ip, body: { rating: "accurate" } }),
    );
    const calls = up.calls.slice(before);
    fanout.push({
      warm: k > 0,
      status: out.status,
      ms: out.ms,
      redisPipelines: calls.filter((x) => x.target === "redis").length,
      redisCommands: up.redisCommands.slice(beforeCmds).map((cmd) =>
        String(cmd[0])
      ),
      authCalls: calls.filter((x) => x.target === "auth").length,
      supabaseRoundTrips: up.supabaseRoundTrips(before),
    });
  }
  const fanoutFailures: string[] = [];
  for (const f of fanout) {
    if (f.status !== 201) {
      fanoutFailures.push(`fan-out probe status ${f.status}`);
    }
    if (f.warm && f.authCalls !== 0) {
      fanoutFailures.push(
        `warm request re-verified with GoTrue (${f.authCalls})`,
      );
    }
    if (f.supabaseRoundTrips !== (f.warm ? 3 : 4)) {
      fanoutFailures.push(
        `${
          f.warm ? "warm" : "cold"
        } request did ${f.supabaseRoundTrips} Supabase round trips`,
      );
    }
  }

  const broken = rows.filter((r) => r.verdict === "BROKEN");
  const summary = {
    unit: "POST /v1/analyses/:id/feedback (Upstash configured)",
    cases: CASES.length,
    seedsPerCase: STRESS_ITER,
    executedRequests: rows.length * 2 + fanout.length,
    held: rows.length - broken.length,
    broken: broken.length,
    brokenIds: broken.map((r) => `${r.id}@${r.seed}`),
    hangCaseLatencyMs: latencySummary(
      rows.filter((r) => r.id === "RD07").map((r) => r.faulted.ms),
    ),
    hangCasePipelines: rows.filter((r) => r.id === "RD07").map((r) =>
      r.faulted.redisPipelines
    ),
    healthyLatencyMs: latencySummary(
      rows.filter((r) => r.id === "RD01").map((r) => r.faulted.ms),
    ),
    fanout,
    fanoutFailures,
    replay:
      `STRESS_SEED=${STRESS_SEED} STRESS_ITER=${STRESS_ITER} deno test -A --no-check --config deno.json stress_feedback_redis.test.ts`,
  };
  const path = await writeJson("redis_faults.json", {
    summary,
    rows,
    serverLogTail: h.serverLog.slice(-40),
  });
  console.log(
    `[stress-redis] ${rows.length} iterations: held=${summary.held} broken=${summary.broken} hangCase=${
      JSON.stringify(summary.hangCaseLatencyMs)
    } pipelines/req(cold,warm)=${
      fanout.map((f) => f.redisPipelines).join(",")
    } → ${path}`,
  );
  for (const r of broken) {
    console.log(
      `[stress-redis]   BROKEN ${r.id} seed=${r.seed}: ${
        r.failures.join("; ")
      }`,
    );
  }

  assert(CASES.length >= 15, "redis matrix must stay ≥15 cases");
  assertEquals(fanoutFailures, []);
  assertEquals(summary.brokenIds, []);
});

function seed32(base: number, k: number): number {
  return ((base * 2_654_435_761) ^ (k * 40_503)) >>> 0;
}
