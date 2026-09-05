// STRESS — POST /v1/auth/refresh — with Upstash Redis configured (L2 limiter).
//
// Own isolate on purpose: `cache.ts` reads UPSTASH_REDIS_REST_URL/TOKEN at
// import, so redis mode is fixed for the life of the module. Here every
// Upstash pipeline is answered by the harness's fake (or by a scripted fault),
// so the campaign proves:
//
//   • the hot path's exact upstream round trips with Redis on (3 Upstash
//     pipelines + 1 GoTrue call per 200; a 4th pipeline charges the
//     auth-failure budget on a 401) and that the refresh route never writes
//     the auth cache (INCR/EXPIRE/GET only — no SET);
//   • ≥ 14 Upstash fault shapes (5xx, 401, malformed, non-numeric, poisoned
//     counters, socket errors, hangs, slow) → the client-visible class and
//     whether the limiter FAILED CLOSED (memory fallback) or open;
//   • the extra latency an Upstash hang costs (REDIS_TIMEOUT_MS × pipelines).
//
// Evidence: artifacts/stress-auth-refresh/latest/upstash_*.json.

import { assert, assertEquals } from "@std/assert";
import {
  abortError,
  awaitWindowHeadroom,
  freshIp,
  GOTRUE_REFUSAL,
  histogram,
  ipFor,
  jsonResponse,
  latencySummary,
  loadStressHarness,
  muteConsole,
  type Observed,
  rawResponse,
  refresh,
  refreshRequest,
  runRedisCommand,
  sleepUnlessAborted,
  STRESS_LOAD_N,
  type StressHarness,
  type UpstashBehaviour,
  writeReport,
} from "./stress_auth_refresh_harness.ts";

/** `cache.ts` REDIS_TIMEOUT_MS — every pipeline is bounded by this. */
const REDIS_TIMEOUT_MS = 1_200;
const REFRESH_LIMIT = 30;
/** ≤ 25 refreshes per IP per campaign keeps every request under the 30/min budget. */
const PER_IP = 25;

const upstashHang: UpstashBehaviour = (ctx) =>
  new Promise<Response>((_, reject) => {
    if (ctx.signal.aborted) return reject(abortError());
    ctx.signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });

const upstashThrow: UpstashBehaviour = () => {
  throw new TypeError("error sending request for url: connection reset");
};

const upstashSlow =
  (ms: number, h: StressHarness): UpstashBehaviour =>
  async (ctx) => {
    await sleepUnlessAborted(ms, ctx.signal);
    if (ctx.signal.aborted) throw abortError();
    return jsonResponse(
      200,
      ctx.commands.map((command) => runRedisCommand(h, command)),
    );
  };

/** Every INCR answers `count`; everything else is faithful. */
const upstashPoisoned =
  (count: unknown, h: StressHarness): UpstashBehaviour =>
  (ctx) =>
    jsonResponse(
      200,
      ctx.commands.map((command) =>
        String(command[0]) === "INCR" ? { result: count } : runRedisCommand(h, command),
      ),
    );

interface UpstashFault {
  id: string;
  description: string;
  behaviour: (h: StressHarness) => UpstashBehaviour;
  /** Client-visible answer for an otherwise-valid refresh. */
  expectStatus: 200 | 429 | 503;
  /** Does the limiter still stop the 31st refresh (memory fallback)? */
  expectFailClosed: boolean;
  minLatencyMs?: number;
  maxLatencyMs: number;
  /** A reproduced deviation from the contract that is tracked as a finding:
   * the row is reported BROKEN in the JSON table, and the test asserts the
   * deviation is STILL present so a fix makes this line stale on purpose. */
  knownFinding?: string;
}

const UPSTASH_FAULTS: UpstashFault[] = [
  {
    id: "upstash_500",
    description: "HTTP 500 on every pipeline",
    behaviour: () => () => jsonResponse(500, { error: "internal" }),
    expectStatus: 200,
    expectFailClosed: true,
    maxLatencyMs: 200,
  },
  {
    id: "upstash_502_html",
    description: "502 with an HTML body",
    behaviour: () => () =>
      rawResponse(502, "<html>bad gateway</html>", { "Content-Type": "text/html" }),
    expectStatus: 200,
    expectFailClosed: true,
    maxLatencyMs: 200,
  },
  {
    id: "upstash_401_bad_token",
    description: "401 Unauthorized (rotated token)",
    behaviour: () => () => jsonResponse(401, { error: "Unauthorized" }),
    expectStatus: 200,
    expectFailClosed: true,
    maxLatencyMs: 200,
  },
  {
    id: "upstash_429",
    description: "Upstash itself rate limits (429)",
    behaviour: () => () => jsonResponse(429, { error: "max requests" }),
    expectStatus: 200,
    expectFailClosed: true,
    maxLatencyMs: 200,
  },
  {
    id: "upstash_200_not_json",
    description: "200 with a non-JSON body",
    behaviour: () => () => rawResponse(200, "OK", { "Content-Type": "text/plain" }),
    expectStatus: 200,
    expectFailClosed: true,
    maxLatencyMs: 200,
  },
  {
    id: "upstash_200_object",
    description: "200 with a JSON object instead of a result array",
    behaviour: () => () => jsonResponse(200, { result: 1 }),
    expectStatus: 200,
    expectFailClosed: true,
    maxLatencyMs: 200,
  },
  {
    id: "upstash_200_empty_array",
    description: "200 with an empty result array",
    behaviour: () => () => jsonResponse(200, []),
    expectStatus: 200,
    expectFailClosed: true,
    maxLatencyMs: 200,
  },
  {
    id: "upstash_200_error_entries",
    description: "200 whose entries are Redis errors",
    behaviour: () => () =>
      jsonResponse(200, [{ error: "ERR max memory" }, { error: "ERR max memory" }]),
    expectStatus: 200,
    expectFailClosed: true,
    maxLatencyMs: 200,
  },
  {
    id: "upstash_incr_string",
    description: "INCR result is a non-numeric string",
    behaviour: (h) => upstashPoisoned("many", h),
    expectStatus: 200,
    expectFailClosed: true,
    maxLatencyMs: 200,
  },
  {
    id: "upstash_incr_null",
    description: "INCR result is null (malformed pipeline answer)",
    behaviour: (h) => upstashPoisoned(null, h),
    expectStatus: 200,
    expectFailClosed: true,
    maxLatencyMs: 200,
    knownFinding:
      "cache.ts redisWindowIncr: Number(null) === 0 is a finite count, so a null INCR result is trusted as 0 (limiter fails open) instead of falling back to the in-memory window like undefined/NaN do",
  },
  {
    id: "upstash_incr_zero",
    description: "INCR result is 0 (never increments)",
    behaviour: (h) => upstashPoisoned(0, h),
    expectStatus: 200,
    expectFailClosed: false,
    maxLatencyMs: 200,
  },
  {
    id: "upstash_incr_negative",
    description: "INCR result is negative",
    behaviour: (h) => upstashPoisoned(-5, h),
    expectStatus: 200,
    expectFailClosed: false,
    maxLatencyMs: 200,
  },
  {
    id: "upstash_incr_huge",
    description: "INCR result is a huge count (poisoned store)",
    behaviour: (h) => upstashPoisoned(1e9, h),
    expectStatus: 429,
    expectFailClosed: true,
    maxLatencyMs: 200,
  },
  {
    id: "upstash_incr_float_string",
    description: 'INCR result is "1.5"',
    behaviour: (h) => upstashPoisoned("1.5", h),
    expectStatus: 200,
    expectFailClosed: false,
    maxLatencyMs: 200,
  },
  {
    id: "upstash_socket_throw",
    description: "fetch throws (connection reset)",
    behaviour: () => upstashThrow,
    expectStatus: 200,
    expectFailClosed: true,
    maxLatencyMs: 200,
  },
  {
    id: "upstash_slow_300ms",
    description: "every pipeline answers after 300ms (3 pipelines on the path)",
    behaviour: (h) => upstashSlow(300, h),
    expectStatus: 200,
    expectFailClosed: true,
    minLatencyMs: 890,
    maxLatencyMs: 1_500,
  },
  {
    id: "upstash_hang",
    description: "never answers — REDIS_TIMEOUT_MS × 3 pipelines before GoTrue",
    behaviour: () => upstashHang,
    expectStatus: 200,
    expectFailClosed: true,
    minLatencyMs: REDIS_TIMEOUT_MS * 3 - 20,
    maxLatencyMs: REDIS_TIMEOUT_MS * 3 + 800,
  },
];

interface FaultRow {
  id: string;
  description: string;
  expected: Omit<UpstashFault, "behaviour">;
  observed: Omit<Observed, "body"> & { bodyKeys: string[] };
  failClosed: {
    statusesFirst30: Record<string, number>;
    thirtyFirst: number;
    gotrueOn31st: number;
  };
  recovery: { status: number; upstashCalls: number };
  holds: boolean;
  mismatches: string[];
}

Deno.test(
  "stress refresh upstash: Redis on — exact round trips per refresh, no auth-cache writes, p50/p95",
  async () => {
    const h = await loadStressHarness({ redis: true });
    const mute = muteConsole();
    h.reset();
    const rows: Array<{
      i: number;
      status: number;
      latencyMs: number;
      gotrue: number;
      upstash: number;
    }> = [];
    const n = STRESS_LOAD_N;
    const started = performance.now();
    try {
      for (let i = 0; i < n; i += 1) {
        const kind = i % 10 === 9 ? "refusal" : "ok";
        h.gotrue = kind === "refusal" ? () => GOTRUE_REFUSAL() : null;
        const o = await refresh(
          h,
          refreshRequest({ ip: ipFor(200_000 + Math.floor(i / PER_IP)), token: `rt-redis-${i}` }),
        );
        rows.push({
          i,
          status: o.status,
          latencyMs: o.latencyMs,
          gotrue: o.gotrueAttempts,
          upstash: o.upstashCalls,
        });
      }
    } finally {
      h.gotrue = null;
      mute.restore();
    }
    const ops = histogram(h.redisCommands.map((c) => String(c[0])));
    const summary = {
      requests: n,
      wallMs: Math.round(performance.now() - started),
      statuses: histogram(rows.map((r) => r.status)),
      latencyMs: latencySummary(rows.map((r) => r.latencyMs)),
      supabaseRoundTripsPerRequest: histogram(rows.map((r) => r.gotrue)),
      upstashPipelinesPerRequest: {
        on200: histogram(rows.filter((r) => r.status === 200).map((r) => r.upstash)),
        on401: histogram(rows.filter((r) => r.status === 401).map((r) => r.upstash)),
      },
      redisOps: ops,
      redisKeyPrefixes: histogram(
        [...h.redis.keys()].map((k) => k.split(":").slice(0, 2).join(":")),
      ),
    };
    const path = await writeReport("upstash_round_trips", {
      campaign: "upstash_round_trips",
      mode: "upstash",
      summary,
      rows,
    });
    console.log(
      `[stress] upstash round trips: ${JSON.stringify(summary.upstashPipelinesPerRequest)} gotrue ${JSON.stringify(summary.supabaseRoundTripsPerRequest)} p50=${summary.latencyMs.p50} p95=${summary.latencyMs.p95} → ${path}`,
    );
    const refusals = rows.filter((r) => r.status === 401).length;
    assertEquals(summary.statuses, { "200": n - refusals, "401": refusals });
    assertEquals(
      summary.supabaseRoundTripsPerRequest,
      { "1": n },
      "ONE Supabase round trip per refresh with Redis on",
    );
    assertEquals(
      summary.upstashPipelinesPerRequest.on200,
      { "3": n - refusals },
      "ip INCR, authfail GET, auth_refresh INCR",
    );
    assertEquals(
      summary.upstashPipelinesPerRequest.on401,
      { "4": refusals },
      "+1 pipeline charging the auth-failure budget",
    );
    assertEquals(
      Object.keys(ops).sort(),
      ["EXPIRE", "GET", "INCR"],
      "refresh never writes the auth cache (no SET/DEL)",
    );
    assertEquals(Object.keys(summary.redisKeyPrefixes).sort(), [
      "rl:auth_refresh",
      "rl:authfail",
      "rl:ip",
    ]);
  },
);

Deno.test(
  "stress refresh upstash: the auth-failure budget is charged in Redis (shared across isolates) by 401s only",
  async () => {
    const h = await loadStressHarness({ redis: true });
    const mute = muteConsole();
    h.reset();
    try {
      await awaitWindowHeadroom(60, 2_000);
      const refusedIp = freshIp();
      h.gotrue = () => GOTRUE_REFUSAL();
      for (let i = 0; i < REFRESH_LIMIT; i += 1)
        await refresh(h, refreshRequest({ ip: refusedIp }));
      h.gotrue = null;
      const authfailKey = [...h.redis.keys()].find(
        (k) => k.startsWith("rl:authfail:") && k.endsWith(`:${refusedIp}`),
      );
      const charged = authfailKey ? Number(h.redis.get(authfailKey)?.value) : null;
      const probe = await refresh(h, refreshRequest({ ip: refusedIp }));

      const outageIp = freshIp();
      h.gotrue = () => jsonResponse(502, { msg: "down" });
      for (let i = 0; i < REFRESH_LIMIT; i += 1) await refresh(h, refreshRequest({ ip: outageIp }));
      h.gotrue = null;
      const outageCharged = [...h.redis.keys()].some(
        (k) => k.startsWith("rl:authfail:") && k.endsWith(`:${outageIp}`),
      );

      await writeReport("upstash_authfail_budget", {
        refusedIp,
        authfailKey,
        charged,
        probeAfterRefusals: probe.status,
        outageIp,
        outageCharged,
      });
      assertEquals(charged, REFRESH_LIMIT, "30 refusals → authfail counter 30 in Redis");
      assertEquals(probe.status, 429);
      assertEquals(probe.gotrueAttempts, 0, "budget-tripped IP never reaches GoTrue");
      assertEquals(outageCharged, false, "503s never touch the auth-failure counter");
    } finally {
      h.gotrue = null;
      mute.restore();
    }
  },
);

Deno.test(
  "stress refresh upstash: Upstash fault matrix — client class, fail-closed limiter fallback, and recovery",
  async () => {
    const h = await loadStressHarness({ redis: true });
    const mute = muteConsole();
    const rows: FaultRow[] = [];
    try {
      for (const fault of UPSTASH_FAULTS) {
        await awaitWindowHeadroom(60, 6_000);
        h.reset();
        h.upstash = fault.behaviour(h);
        const ip = freshIp();
        const observed = await refresh(h, refreshRequest({ ip, token: `rt-${fault.id}` }));
        const mismatches: string[] = [];
        if (observed.status !== fault.expectStatus)
          mismatches.push(`status ${observed.status} ≠ ${fault.expectStatus}`);
        if (observed.status === 200 && observed.gotrueAttempts !== 1)
          mismatches.push(`gotrue attempts ${observed.gotrueAttempts} ≠ 1`);
        if (observed.status === 429 && observed.gotrueAttempts !== 0)
          mismatches.push(`429 must not reach GoTrue (${observed.gotrueAttempts})`);
        if (fault.minLatencyMs !== undefined && observed.latencyMs < fault.minLatencyMs)
          mismatches.push(`latency ${observed.latencyMs}ms < ${fault.minLatencyMs}ms`);
        if (observed.latencyMs > fault.maxLatencyMs)
          mismatches.push(`latency ${observed.latencyMs}ms > ${fault.maxLatencyMs}ms`);

        // Fail-closed probe: with the fault persisting, does a fresh IP still
        // get stopped at its 31st refresh (in-memory fallback), or is the
        // budget gone? Skipped for faults that make EVERY request slow.
        const probeIp = freshIp();
        const first30: number[] = [];
        let thirtyFirst: Observed | null = null;
        let gotrueOn31st = 0;
        if (fault.maxLatencyMs <= 200) {
          for (let i = 0; i < REFRESH_LIMIT; i += 1)
            first30.push((await refresh(h, refreshRequest({ ip: probeIp }))).status);
          const before = h.callsTo("gotrue").length;
          thirtyFirst = await refresh(h, refreshRequest({ ip: probeIp }));
          gotrueOn31st = h.callsTo("gotrue").length - before;
          const failedClosed = thirtyFirst.status === 429;
          if (failedClosed !== fault.expectFailClosed)
            mismatches.push(
              `fail-closed ${failedClosed} ≠ ${fault.expectFailClosed} (31st → ${thirtyFirst.status})`,
            );
        }

        // Recovery: Upstash healthy again → the SAME first IP refreshes normally.
        h.upstash = null;
        const recovered = await refresh(h, refreshRequest({ ip, token: `rt-${fault.id}-again` }));
        if (recovered.status !== 200 || recovered.upstashCalls !== 3)
          mismatches.push(
            `recovery → ${recovered.status} with ${recovered.upstashCalls} pipelines`,
          );

        const { body: _body, ...rest } = observed;
        const { behaviour: _b, ...expected } = fault;
        rows.push({
          id: fault.id,
          description: fault.description,
          expected,
          observed: { ...rest, bodyKeys: Object.keys(observed.body) },
          failClosed: {
            statusesFirst30: histogram(first30),
            thirtyFirst: thirtyFirst?.status ?? -1,
            gotrueOn31st,
          },
          recovery: { status: recovered.status, upstashCalls: recovered.upstashCalls },
          holds: mismatches.length === 0,
          mismatches,
        });
      }
    } finally {
      h.upstash = null;
      mute.restore();
    }
    const broken = rows.filter((r) => !r.holds);
    const knownFindings = Object.fromEntries(
      UPSTASH_FAULTS.filter((f) => f.knownFinding).map((f) => [f.id, f.knownFinding]),
    );
    const path = await writeReport("upstash_faults", {
      campaign: "upstash_faults",
      mode: "upstash",
      summary: {
        total: rows.length,
        held: rows.length - broken.length,
        broken: broken.map((r) => ({
          id: r.id,
          mismatches: r.mismatches,
          finding: knownFindings[r.id],
        })),
        knownFindings,
        byStatus: histogram(rows.map((r) => r.observed.status)),
        failOpenCases: rows.filter((r) => r.failClosed.thirtyFirst === 200).map((r) => r.id),
        latencyMs: latencySummary(rows.map((r) => r.observed.latencyMs)),
      },
      rows,
    });
    console.log(
      `[stress] upstash faults: ${rows.length - broken.length}/${rows.length} held (${broken.length} tracked finding(s)) → ${path}`,
    );
    assertEquals(
      broken.map((r) => r.id).sort(),
      Object.keys(knownFindings).sort(),
      "every BROKEN row must be a tracked finding, and every tracked finding must still reproduce",
    );
    for (const r of broken)
      assertEquals(
        r.mismatches,
        [`fail-closed false ≠ true (31st → 200)`],
        `${r.id}: only the tracked deviation`,
      );
    assert(rows.length >= 14);
  },
);
