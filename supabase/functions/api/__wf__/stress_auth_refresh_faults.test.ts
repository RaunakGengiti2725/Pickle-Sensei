// STRESS — POST /v1/auth/refresh — failure injection (no Upstash: the
// function's per-isolate memory limiter is in play, as when UPSTASH_* is unset).
//
// 1. The deterministic catalogue (stress_auth_refresh_cases.ts, 100+ cases):
//    every GoTrue status/body/header/transport fault, every client body shape,
//    PostgREST/RevenueCat failing underneath — each judged against the oracle
//    and followed by a recovery probe (the same IP refreshes fine afterwards).
// 2. A seeded random campaign (STRESS_ITER iterations, default 40): each
//    iteration is `generate(seed)`; replay ONE with
//      STRESS_REPLAY_SEED=<seed> deno test -A --no-check --config deno.json \
//        stress_auth_refresh_faults.test.ts --filter "seeded"
// 3. Budget semantics: per-IP refresh limit, auth-failure budget charged by
//    401 only, x-forwarded-for attribution, duplicate delivery.
//
// Evidence: JSON tables under artifacts/stress-auth-refresh/latest/.

import { assert, assertEquals } from "@std/assert";
import { CATALOGUE, type FaultCase, generate, judge } from "./stress_auth_refresh_cases.ts";
import {
  awaitWindowHeadroom,
  defaultRefreshGrant,
  freshIp,
  GOTRUE_REFUSAL,
  histogram,
  jsonResponse,
  latencySummary,
  loadStressHarness,
  muteConsole,
  type Observed,
  Prng,
  refresh,
  refreshRequest,
  STRESS_ITER,
  STRESS_SEED,
  type StressHarness,
  validSession,
  withAuthTimeout,
  writeReport,
} from "./stress_auth_refresh_harness.ts";

interface CaseRow {
  id: string;
  seed?: number;
  family: string;
  description: string;
  params?: Record<string, unknown>;
  expected: FaultCase["expect"];
  observed: Omit<Observed, "body"> & { bodyKeys: string[]; upstreamToken?: string };
  recovery: { status: number; gotrueAttempts: number } | null;
  holds: boolean;
  mismatches: string[];
  replay: string;
}

const REPLAY = (seed: number) =>
  `STRESS_REPLAY_SEED=${seed} deno test -A --no-check --config deno.json stress_auth_refresh_faults.test.ts --filter "seeded"`;

async function runCase(h: StressHarness, c: FaultCase, seed?: number): Promise<CaseRow> {
  h.reset();
  h.gotrue = c.gotrue ?? null;
  h.postgrest = c.postgrest ?? null;
  h.revenuecat = c.revenuecat ?? null;
  const ip = freshIp();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const observed = await withAuthTimeout(c.authTimeoutMs, () => refresh(h, c.request(ip)));
  const lastGotrue = h.callsTo("gotrue").at(-1);
  const upstreamBody = lastGotrue?.body;
  const upstreamToken =
    upstreamBody && typeof upstreamBody === "object" && !Array.isArray(upstreamBody)
      ? (upstreamBody as Record<string, unknown>).refresh_token
      : undefined;
  const verdict = judge(c, observed, {
    upstreamToken: typeof upstreamToken === "string" ? upstreamToken : undefined,
    nowSeconds,
  });
  // Recovery: the fault is gone; the SAME client IP must be able to refresh.
  h.gotrue = null;
  h.postgrest = null;
  h.revenuecat = null;
  let recovery: CaseRow["recovery"] = null;
  if (c.expect.status !== 429) {
    const again = await withAuthTimeout(null, () => refresh(h, refreshRequest({ ip })));
    recovery = { status: again.status, gotrueAttempts: again.gotrueAttempts };
    if (again.status !== 200 || again.gotrueAttempts !== 1) {
      verdict.holds = false;
      verdict.mismatches.push(
        `recovery refresh from the same IP → ${again.status} (${again.gotrueAttempts} GoTrue calls)`,
      );
    }
  }
  const { body: _body, ...rest } = observed;
  return {
    id: c.id,
    seed,
    family: c.family,
    description: c.description,
    params: c.params,
    expected: c.expect,
    observed: {
      ...rest,
      bodyKeys: Object.keys(observed.body),
      upstreamToken: typeof upstreamToken === "string" ? upstreamToken.slice(0, 80) : undefined,
    },
    recovery,
    holds: verdict.holds,
    mismatches: verdict.mismatches,
    replay:
      seed === undefined
        ? `deno test -A --no-check --config deno.json stress_auth_refresh_faults.test.ts --filter "catalogue" (case ${c.id})`
        : REPLAY(seed),
  };
}

function summarize(rows: CaseRow[]) {
  return {
    total: rows.length,
    held: rows.filter((r) => r.holds).length,
    broken: rows
      .filter((r) => !r.holds)
      .map((r) => ({ id: r.id, seed: r.seed, mismatches: r.mismatches, replay: r.replay })),
    byFamily: histogram(rows.map((r) => r.family)),
    byStatus: histogram(rows.map((r) => r.observed.status)),
    byClientClass: histogram(rows.map((r) => r.observed.clientClass)),
    latencyMs: latencySummary(rows.map((r) => r.observed.latencyMs)),
  };
}

Deno.test(
  "stress refresh: deterministic fault catalogue — every case answers its contract class and the IP recovers",
  async () => {
    const h = await loadStressHarness();
    const mute = muteConsole();
    const rows: CaseRow[] = [];
    const started = performance.now();
    try {
      for (const c of CATALOGUE) rows.push(await runCase(h, c));
    } finally {
      mute.restore();
    }
    const summary = summarize(rows);
    const path = await writeReport("faults_catalogue", {
      campaign: "faults_catalogue",
      mode: "memory-limiter",
      durationMs: Math.round(performance.now() - started),
      operatorLogLines: { errors: mute.errors, warns: mute.warns },
      summary,
      rows,
    });
    console.log(`[stress] catalogue: ${summary.held}/${summary.total} held → ${path}`);
    for (const b of summary.broken)
      console.log(`[stress]   BROKEN ${b.id}: ${b.mismatches.join("; ")}`);
    assert(CATALOGUE.length >= 40, `catalogue has ${CATALOGUE.length} cases (< 40)`);
    assertEquals(summary.broken, [], `broken cases: ${summary.broken.map((b) => b.id).join(", ")}`);
  },
);

Deno.test(
  "stress refresh: seeded random fault campaign — every iteration replayable from its seed",
  async () => {
    const h = await loadStressHarness();
    const replay = Deno.env.get("STRESS_REPLAY_SEED");
    const seeds = replay
      ? [Number(replay)]
      : Array.from({ length: STRESS_ITER }, (_, i) => new Prng(STRESS_SEED).child(i));
    const mute = muteConsole();
    const rows: CaseRow[] = [];
    const started = performance.now();
    try {
      for (const seed of seeds) rows.push(await runCase(h, generate(seed), seed));
    } finally {
      mute.restore();
    }
    const summary = summarize(rows);
    const path = await writeReport(replay ? `faults_seeded_replay_${replay}` : "faults_seeded", {
      campaign: "faults_seeded",
      mode: "memory-limiter",
      masterSeed: STRESS_SEED,
      iterations: rows.length,
      durationMs: Math.round(performance.now() - started),
      operatorLogLines: { errors: mute.errors, warns: mute.warns },
      summary,
      rows,
    });
    console.log(
      `[stress] seeded: ${summary.held}/${summary.total} held (master seed ${STRESS_SEED}) → ${path}`,
    );
    for (const b of summary.broken)
      console.log(`[stress]   BROKEN seed=${b.seed}: ${b.mismatches.join("; ")} — ${b.replay}`);
    assertEquals(
      summary.broken,
      [],
      `broken seeds: ${summary.broken.map((b) => b.seed).join(", ")}`,
    );
  },
);

// ── Budgets ──────────────────────────────────────────────────────────────────

const REFRESH_LIMIT = 30;

Deno.test(
  "stress refresh: the 31st refresh from one IP inside a minute is 429 and never reaches GoTrue",
  async () => {
    const h = await loadStressHarness();
    const mute = muteConsole();
    try {
      await refreshBudgetScenario(h);
    } finally {
      mute.restore();
    }
  },
);

async function refreshBudgetScenario(h: StressHarness): Promise<void> {
  await awaitWindowHeadroom(60, 2_000);
  const ip = freshIp();
  const statuses: number[] = [];
  for (let i = 0; i < REFRESH_LIMIT; i += 1)
    statuses.push((await refresh(h, refreshRequest({ ip }))).status);
  const before = h.callsTo("gotrue").length;
  const limited = await refresh(h, refreshRequest({ ip }));
  const rows = {
    ip,
    first30: histogram(statuses),
    limited: { ...limited, body: undefined },
    gotrueCallsOn31st: h.callsTo("gotrue").length - before,
  };
  await writeReport("budget_refresh_per_ip", rows);
  assertEquals(histogram(statuses), { "200": REFRESH_LIMIT });
  assertEquals(limited.status, 429);
  assertEquals(limited.errorCode, "rate_limited");
  assertEquals(limited.clientClass, "retryable");
  assertEquals(rows.gotrueCallsOn31st, 0);
  const retryAfter = Number(limited.retryAfter);
  assert(
    retryAfter >= 1 && retryAfter <= 60,
    `Retry-After ${limited.retryAfter} outside the 60s window`,
  );
}

async function probeAuthfail(h: StressHarness, ip: string): Promise<Observed> {
  // Any bearer-authenticated route: 429 here means the auth-failure budget
  // tripped (checked before routing); otherwise the bogus bearer is a 401.
  return await refresh(
    h,
    new Request("http://edge.stress.test/functions/v1/api/v1/me", {
      method: "GET",
      headers: { "x-forwarded-for": ip, Authorization: "Bearer not-a-jwt" },
    }),
  );
}

Deno.test(
  "stress refresh: 401s charge the per-IP auth-failure budget; 503s and 400s do not",
  async () => {
    const h = await loadStressHarness();
    const mute = muteConsole();
    try {
      await awaitWindowHeadroom(60, 2_000);
      // 30 refusals → budget spent → even unrelated routes are 429 for this IP.
      const refusedIp = freshIp();
      h.gotrue = () => GOTRUE_REFUSAL();
      const refused = [];
      for (let i = 0; i < REFRESH_LIMIT; i += 1)
        refused.push((await refresh(h, refreshRequest({ ip: refusedIp }))).status);
      h.gotrue = null;
      const afterRefusals = await probeAuthfail(h, refusedIp);

      // 30 outages → nothing charged → the probe is an ordinary 401.
      const outageIp = freshIp();
      h.gotrue = () => jsonResponse(502, { msg: "down" });
      const outages = [];
      for (let i = 0; i < REFRESH_LIMIT; i += 1)
        outages.push((await refresh(h, refreshRequest({ ip: outageIp }))).status);
      h.gotrue = null;
      const afterOutages = await probeAuthfail(h, outageIp);

      // 30 validation errors → nothing charged either.
      const badBodyIp = freshIp();
      const validations = [];
      for (let i = 0; i < REFRESH_LIMIT; i += 1)
        validations.push((await refresh(h, refreshRequest({ ip: badBodyIp, body: {} }))).status);
      const afterValidations = await probeAuthfail(h, badBodyIp);

      await writeReport("budget_authfail_charging", {
        refused: histogram(refused),
        probeAfterRefusals: afterRefusals.status,
        outages: histogram(outages),
        probeAfterOutages: afterOutages.status,
        validations: histogram(validations),
        probeAfterValidations: afterValidations.status,
      });
      assertEquals(histogram(refused), { "401": REFRESH_LIMIT });
      assertEquals(afterRefusals.status, 429, "auth-failure budget must trip after 30 refusals");
      assertEquals(afterRefusals.errorCode, "rate_limited");
      assertEquals(histogram(outages), { "503": REFRESH_LIMIT });
      assertEquals(afterOutages.status, 401, "outages must not charge the auth-failure budget");
      assertEquals(histogram(validations), { "400": REFRESH_LIMIT });
      assertEquals(
        afterValidations.status,
        401,
        "validation errors must not charge the auth-failure budget",
      );
    } finally {
      mute.restore();
    }
  },
);

Deno.test(
  "stress refresh: budgets attach to the LAST x-forwarded-for hop (or cf-connecting-ip) — a client cannot dodge them by prepending hops",
  async () => {
    const h = await loadStressHarness();
    const mute = muteConsole();
    try {
      await ipAttributionScenario(h);
    } finally {
      mute.restore();
    }
  },
);

async function ipAttributionScenario(h: StressHarness): Promise<void> {
  await awaitWindowHeadroom(60, 2_000);
  const edgeHop = freshIp();
  const statuses: number[] = [];
  for (let i = 0; i < REFRESH_LIMIT; i += 1) {
    statuses.push(
      (
        await refresh(
          h,
          refreshRequest({
            headers: { "x-forwarded-for": `10.0.${Math.floor(i / 250)}.${i % 250}, ${edgeHop}` },
          }),
        )
      ).status,
    );
  }
  const spoofedFirstHop = await refresh(
    h,
    refreshRequest({ headers: { "x-forwarded-for": `9.9.9.9, ${edgeHop}` } }),
  );
  const edgeHopAsFirst = await refresh(
    h,
    refreshRequest({ headers: { "x-forwarded-for": `${edgeHop}, ${freshIp()}` } }),
  );
  const cfIp = freshIp();
  const cfStatuses: number[] = [];
  for (let i = 0; i < REFRESH_LIMIT; i += 1) {
    cfStatuses.push(
      (
        await refresh(
          h,
          refreshRequest({ headers: { "cf-connecting-ip": cfIp, "x-forwarded-for": freshIp() } }),
        )
      ).status,
    );
  }
  const cfLimited = await refresh(
    h,
    refreshRequest({ headers: { "cf-connecting-ip": cfIp, "x-forwarded-for": freshIp() } }),
  );
  await writeReport("budget_ip_attribution", {
    lastHop: {
      first30: histogram(statuses),
      spoofedFirstHop: spoofedFirstHop.status,
      edgeHopAsFirstHop: edgeHopAsFirst.status,
    },
    cfConnectingIp: { first30: histogram(cfStatuses), limited: cfLimited.status },
  });
  assertEquals(histogram(statuses), { "200": REFRESH_LIMIT });
  assertEquals(spoofedFirstHop.status, 429, "prepending a hop must not escape the last-hop budget");
  assertEquals(
    edgeHopAsFirst.status,
    200,
    "the same address as a NON-last hop is a different client",
  );
  assertEquals(histogram(cfStatuses), { "200": REFRESH_LIMIT });
  assertEquals(cfLimited.status, 429, "cf-connecting-ip wins over x-forwarded-for");
}

Deno.test(
  "stress refresh: duplicate delivery of ONE refresh token — the edge forwards both; GoTrue's rotation policy decides (strict: exactly one 200, the loser 401; reuse window: both 200)",
  async () => {
    const h = await loadStressHarness();
    const mute = muteConsole();
    try {
      const outcomes: Record<string, unknown> = {};
      for (const policy of ["strict", "reuse-window"] as const) {
        const spent = new Map<string, Record<string, unknown>>();
        h.gotrue = (ctx) => {
          const presented = String(ctx.body.refresh_token ?? "");
          const prior = spent.get(presented);
          if (prior) {
            return policy === "strict"
              ? GOTRUE_REFUSAL("refresh_token_already_used")
              : jsonResponse(200, prior);
          }
          const session = validSession("22222222-2222-4222-8222-222222222222");
          spent.set(presented, session);
          return jsonResponse(200, session);
        };
        const ip = freshIp();
        const token = `rt-dup-${policy}`;
        const gotrueBefore = h.callsTo("gotrue").length;
        const results = await Promise.all(
          Array.from({ length: 4 }, () => refresh(h, refreshRequest({ ip, token }))),
        );
        const sessions = new Set(
          results.filter((r) => r.status === 200).map((r) => JSON.stringify(r.body.session)),
        );
        outcomes[policy] = {
          statuses: histogram(results.map((r) => r.status)),
          clientClasses: histogram(results.map((r) => r.clientClass)),
          distinctSessionsReturned: sessions.size,
          gotrueCalls: h.callsTo("gotrue").length - gotrueBefore,
        };
        assertEquals(
          h.callsTo("gotrue").length - gotrueBefore,
          4,
          "every duplicate is forwarded exactly once",
        );
        if (policy === "strict") {
          assertEquals(histogram(results.map((r) => r.status)), { "200": 1, "401": 3 });
        } else {
          assertEquals(histogram(results.map((r) => r.status)), { "200": 4 });
          assertEquals(
            sessions.size,
            1,
            "reuse window hands every duplicate the SAME rotated pair",
          );
        }
      }
      await writeReport("duplicate_delivery", outcomes);
    } finally {
      mute.restore();
      h.gotrue = null;
    }
  },
);

Deno.test(
  "stress refresh: a burst of refreshes mid-outage costs nothing lasting — once GoTrue answers, the same tokens rotate",
  async () => {
    const h = await loadStressHarness();
    const mute = muteConsole();
    try {
      const ip = freshIp();
      const tokens = Array.from({ length: 10 }, (_, i) => `rt-outage-${i}`);
      h.gotrue = () => {
        throw new TypeError("connection refused");
      };
      const during = await withAuthTimeout(400, () =>
        Promise.all(tokens.map((token) => refresh(h, refreshRequest({ ip, token })))),
      );
      h.gotrue = defaultRefreshGrant;
      const after = await Promise.all(
        tokens.map((token) => refresh(h, refreshRequest({ ip, token }))),
      );
      await writeReport("outage_then_recovery", {
        during: {
          statuses: histogram(during.map((r) => r.status)),
          retryAfter: histogram(during.map((r) => String(r.retryAfter))),
          attempts: histogram(during.map((r) => r.gotrueAttempts)),
        },
        after: { statuses: histogram(after.map((r) => r.status)) },
      });
      assertEquals(histogram(during.map((r) => r.status)), { "503": 10 });
      assertEquals(histogram(during.map((r) => r.clientClass)), { retryable: 10 });
      assertEquals(
        histogram(during.map((r) => r.gotrueAttempts)),
        { "3": 10 },
        "400ms deadline fits attempts at 0/100/300ms",
      );
      assertEquals(histogram(after.map((r) => r.status)), { "200": 10 });
    } finally {
      mute.restore();
      h.gotrue = null;
    }
  },
);
