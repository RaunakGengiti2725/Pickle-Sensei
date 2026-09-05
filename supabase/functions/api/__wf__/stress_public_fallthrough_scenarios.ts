// Scenario bodies for the public/fallthrough concurrency campaign. Shared by
// stress_public_fallthrough_memory.test.ts (per-isolate limiter) and
// stress_public_fallthrough_redis.test.ts (fake Upstash with seeded latency
// and seeded outages). See stress_public_fallthrough_lib.ts for the model.

import { assertEquals } from "@std/assert";
import {
  apiRequest,
  freshIp,
  type SessionHarness,
  withClockOffset,
} from "./sessionHarness.ts";
import {
  type Actor,
  AUTH_FAILURE_LIMIT,
  type BearerKind,
  budgetIp,
  type CampaignReport,
  checkCommon,
  checkFallthrough,
  checkPublicBudget,
  type ExpectedClass,
  forwardedFor,
  GENERAL_USER_LIMIT,
  histogram,
  isPublicRead,
  type IterationRow,
  ITERATIONS,
  iterationSeed,
  mintActor,
  type PlannedRequest,
  Prng,
  PUBLIC_PAGE_LIMIT,
  PUBLIC_SUFFIXES,
  publicPath,
  record,
  replayCommand,
  runBurst,
  sleep,
  STRESS_SEED,
  unknownPath,
  upstreamHistogram,
  type Violation,
  WINDOW_SECONDS,
} from "./stress_public_fallthrough_lib.ts";

/** Upper bound on one burst's wall time (deadlock / livelock guard). Sized
 * for ≤ 200 in-process requests plus seeded launch jitter and fake latency. */
export const BURST_WALL_MS = 8_000;

export interface ScenarioContext {
  h: SessionHarness;
  report: CampaignReport;
  file: string;
  /** Redis file: reseed the fake-Upstash latency/outage schedule for this
   * iteration (keeps every row replayable from its seed). */
  onIteration?: (seed: number) => Record<string, unknown>;
  /** Redis file: fake-Upstash traffic since onIteration(). */
  iterationStats?: () => { redisCalls: number; redisOutages: number };
}

const NO_STATS = { redisCalls: 0, redisOutages: 0 };

/** Start of every iteration: reseed the transport and report its knobs. */
function begin(ctx: ScenarioContext, seed: number): Record<string, unknown> {
  return ctx.onIteration?.(seed) ?? {};
}

/** End of every iteration: transport metrics + whether Redis failed open at
 * least once (which legitimately splits a budget across L2 and the memory
 * fallback, so exact-count invariants become bounds). */
function end(
  ctx: ScenarioContext,
): { stats: { redisCalls: number; redisOutages: number }; lossy: boolean } {
  const stats = ctx.iterationStats?.() ?? NO_STATS;
  return { stats, lossy: stats.redisOutages > 0 };
}

function ipHeaders(rng: Prng, ip: string): { ip: string; cfIp: string } {
  const f = forwardedFor(rng, ip);
  return { ip: f.xff, cfIp: f.cfIp };
}

let ipSerial = 0;
function stressIp(): string {
  ipSerial += 1;
  // 203.0.113.0/24 is TEST-NET-3; spread across a /16-sized synthetic range.
  return `203.${(ipSerial >> 8) & 255}.${ipSerial & 255}.${
    1 + (ipSerial % 200)
  }`;
}

function requestIdFor(rng: Prng): { id: string; valid: boolean } {
  const roll = rng.int(0, 9);
  if (roll < 6) return { id: "", valid: false };
  if (roll < 9) return { id: `req-${rng.hex(8)}`, valid: true };
  // Invalid shapes: too short / forbidden chars / too long.
  return {
    id: rng.pick(["short", "has space id", "x".repeat(65), "bad/slash/id"]),
    valid: false,
  };
}

function classify(
  method: string,
  fullPath: string,
  bearer: BearerKind,
  routePath: string,
): ExpectedClass {
  const suffix = isPublicRead(method, fullPath);
  if (suffix) return { kind: "public", scope: PUBLIC_SUFFIXES[suffix], suffix };
  switch (bearer) {
    case "none":
    case "garbage":
    case "expired-session":
      return { kind: "auth-refused-local" };
    case "forged-session":
    case "revoked-session":
      return { kind: "auth-refused-upstream" };
    case "valid-session":
      return { kind: "unknown-route", route: `${method} ${routePath}` };
  }
}

function baseRow(
  scenario: string,
  seed: number,
  iteration: number,
  file: string,
): IterationRow {
  return {
    scenario,
    seed,
    iteration,
    replay: replayCommand(file, seed, scenario),
    composition: {},
    statuses: {},
    wallMs: 0,
    upstreamCalls: {},
    metrics: {},
    violations: [],
    outcome: "HELD",
  };
}

function finish(
  row: IterationRow,
  violations: Violation[],
  wallMs: number,
): IterationRow {
  if (wallMs > BURST_WALL_MS) {
    violations.push({
      invariant: "bounded-wall-time",
      detail: `${wallMs}ms > ${BURST_WALL_MS}ms`,
    });
  }
  row.violations = violations;
  row.wallMs = wallMs;
  row.outcome = violations.length ? "BROKEN" : "HELD";
  return row;
}

// ─── S1: one IP, mixed public pages, GET/HEAD, jitter, aborts ────────────────

export const S1 = "S1 public burst single IP";
export async function s1(
  ctx: ScenarioContext,
  scenarioIndex: number,
): Promise<void> {
  for (let i = 0; i < ITERATIONS; i += 1) {
    const seed = iterationSeed(STRESS_SEED, scenarioIndex, i);
    const rng = new Prng(seed);
    const transport = begin(ctx, seed);
    const ip = stressIp();
    const n = rng.int(40, 160);
    const suffixes = Object.keys(PUBLIC_SUFFIXES);
    const plan: PlannedRequest[] = [];
    for (let k = 0; k < n; k += 1) {
      const suffix = rng.pick(suffixes);
      const method = rng.chance(0.2) ? "HEAD" : "GET";
      const fullPath = publicPath(rng, suffix);
      const rid = requestIdFor(rng);
      plan.push({
        index: k,
        method,
        fullPath,
        ...ipHeaders(rng, ip),
        bearer: rng.chance(0.15)
          ? rng.pick<BearerKind>(["garbage", "forged-session"])
          : "none",
        requestId: rid.id,
        requestIdValid: rid.valid,
        delayMs: rng.chance(0.3) ? rng.int(1, 4) : 0,
        abort: rng.chance(0.05),
        expect: { kind: "public", scope: PUBLIC_SUFFIXES[suffix], suffix },
      });
    }
    const callsBefore = ctx.h.calls.length;
    const row = baseRow(S1, seed, i, ctx.file);
    const { observed, logs, wallMs } = await withClockOffset(
      rng.int(0, 59_000),
      () => runBurst(plan, rng, { h: ctx.h, actor: null }),
    );
    const { stats, lossy } = end(ctx);
    const violations = checkCommon(plan, observed, logs);
    for (const scope of ["healthz", "legal"] as const) {
      const idx = plan.filter((p) =>
        p.expect.kind === "public" && p.expect.scope === scope
      ).map((p) => p.index);
      violations.push(
        ...checkPublicBudget(
          scope,
          plan,
          idx.map((k) => observed[k]),
          PUBLIC_PAGE_LIMIT,
          lossy,
        ),
      );
    }
    // Public pages never consult Supabase Auth / PostgREST, even with a bearer.
    const upstream = upstreamHistogram(ctx.h, callsBefore);
    const nonRedis = Object.keys(upstream).filter((k) =>
      !k.includes("/pipeline")
    );
    if (nonRedis.length) {
      violations.push({
        invariant: "public-no-upstream",
        detail: JSON.stringify(upstream),
      });
    }
    // HEAD carries no body once served by Deno.serve; in-process the handler
    // returns the same Response as GET — record, do not assert.
    row.composition = {
      transport,
      ip,
      n,
      methods: histogram(plan.map((p) => p.method)),
      suffixes: histogram(
        plan.map((p) => (p.expect.kind === "public" ? p.expect.suffix : "?")),
      ),
      bearers: histogram(plan.map((p) => p.bearer)),
      aborted: plan.filter((p) => p.abort).length,
      jittered: plan.filter((p) => p.delayMs > 0).length,
    };
    row.statuses = histogram(observed.map((o) => o.status));
    row.upstreamCalls = upstream;
    row.metrics = {
      ...stats,
      headBodyBytes: histogram(
        observed.filter((o) => plan[o.index].method === "HEAD").map((o) =>
          o.bodyBytes
        ),
      ),
    };
    record(ctx.report, finish(row, violations, wallMs), n);
  }
}

// ─── S2: several IPs interleaved — no cross-IP bleed, no lost update ────────

export const S2 = "S2 public burst multi IP interleaved";
export async function s2(
  ctx: ScenarioContext,
  scenarioIndex: number,
): Promise<void> {
  for (let i = 0; i < ITERATIONS; i += 1) {
    const seed = iterationSeed(STRESS_SEED, scenarioIndex, i);
    const rng = new Prng(seed);
    const transport = begin(ctx, seed);
    const actors = rng.int(2, 6);
    const ips = Array.from({ length: actors }, () => stressIp());
    const perIp = ips.map(() => rng.int(20, 90));
    const plan: PlannedRequest[] = [];
    ips.forEach((ip, a) => {
      for (let k = 0; k < perIp[a]; k += 1) {
        const suffix = rng.chance(0.5)
          ? "/healthz"
          : rng.pick(["/privacy", "/terms", "/support"]);
        const rid = requestIdFor(rng);
        plan.push({
          index: 0,
          method: rng.chance(0.15) ? "HEAD" : "GET",
          fullPath: publicPath(rng, suffix),
          ...ipHeaders(rng, ip),
          bearer: "none",
          requestId: rid.id,
          requestIdValid: rid.valid,
          delayMs: rng.chance(0.4) ? rng.int(1, 5) : 0,
          abort: rng.chance(0.03),
          expect: { kind: "public", scope: PUBLIC_SUFFIXES[suffix], suffix },
        });
      }
    });
    rng.shuffle(plan).forEach((p, idx) => (p.index = idx));
    const callsBefore = ctx.h.calls.length;
    const row = baseRow(S2, seed, i, ctx.file);
    const { observed, logs, wallMs } = await withClockOffset(
      rng.int(0, 59_000),
      () => runBurst(plan, rng, { h: ctx.h, actor: null }),
    );
    const { stats, lossy } = end(ctx);
    const violations = checkCommon(plan, observed, logs);
    for (const ip of ips) {
      for (const scope of ["healthz", "legal"] as const) {
        const idx = plan
          .filter((p) =>
            budgetIp(p) === ip && p.expect.kind === "public" &&
            p.expect.scope === scope
          )
          .map((p) => p.index);
        violations.push(
          ...checkPublicBudget(
            `${ip}/${scope}`,
            plan,
            idx.map((k) => observed[k]),
            PUBLIC_PAGE_LIMIT,
            lossy,
          ),
        );
      }
    }
    row.composition = { transport, ips, perIp, n: plan.length };
    row.metrics = { ...stats };
    row.statuses = histogram(observed.map((o) => o.status));
    row.upstreamCalls = upstreamHistogram(ctx.h, callsBefore);
    record(ctx.report, finish(row, violations, wallMs), plan.length);
  }
}

// ─── S3: unknown paths / unsupported methods, every bearer kind ─────────────

export const S3 = "S3 fallthrough unknown paths and methods";
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
export async function s3(
  ctx: ScenarioContext,
  scenarioIndex: number,
): Promise<void> {
  for (let i = 0; i < ITERATIONS; i += 1) {
    const seed = iterationSeed(STRESS_SEED, scenarioIndex, i);
    const rng = new Prng(seed);
    const transport = begin(ctx, seed);
    const ip = stressIp();
    const actor: Actor = mintActor(ctx.h, rng);
    const n = rng.int(20, 90);
    const plan: PlannedRequest[] = [];
    for (let k = 0; k < n; k += 1) {
      const method = rng.pick(METHODS);
      const { fullPath, routePath } = unknownPath(rng, method);
      const bearer = rng.pick<BearerKind>([
        "none",
        "garbage",
        "expired-session",
        "forged-session",
        "valid-session",
        "valid-session",
      ]);
      const rid = requestIdFor(rng);
      plan.push({
        index: k,
        method,
        fullPath,
        ...ipHeaders(rng, ip),
        bearer,
        requestId: rid.id,
        requestIdValid: rid.valid,
        delayMs: rng.chance(0.35) ? rng.int(1, 4) : 0,
        abort: rng.chance(0.04),
        expect: classify(method, fullPath, bearer, routePath),
      });
    }
    const callsBefore = ctx.h.calls.length;
    const row = baseRow(S3, seed, i, ctx.file);
    const { observed, logs, wallMs, probeStatus } = await withClockOffset(
      rng.int(0, 59_000),
      async () => {
        const burst = await runBurst(plan, rng, { h: ctx.h, actor });
        // Auth-failure accounting probe (same window, same IP, after the burst
        // has fully settled): the budget must reflect EVERY 401 the burst
        // produced — no lost update between concurrent chargers.
        const probe = await ctx.h.handler(
          apiRequest("GET", "/api/v1/zz-probe", { ip, token: "not-a-jwt" }),
        );
        await probe.body?.cancel();
        return { ...burst, probeStatus: probe.status };
      },
    );
    const { stats, lossy } = end(ctx);
    const violations = checkCommon(plan, observed, logs);
    const failures = observed.filter((o) => o.status === 401).length;
    const expectedProbe = failures >= AUTH_FAILURE_LIMIT ? 429 : 401;
    if (!lossy && probeStatus !== expectedProbe) {
      violations.push({
        invariant: "authfail-counter-no-lost-update",
        detail:
          `${failures} 401s charged, probe → ${probeStatus}, expected ${expectedProbe}`,
      });
    }
    violations.push(...checkFallthrough(plan, observed));
    const publicIdx = plan.filter((p) => p.expect.kind === "public").map((p) =>
      p.index
    );
    for (const scope of ["healthz", "legal"] as const) {
      const idx = publicIdx.filter((k) =>
        plan[k].expect.kind === "public" &&
        (plan[k].expect as { scope: string }).scope === scope
      );
      violations.push(
        ...checkPublicBudget(
          scope,
          plan,
          idx.map((k) => observed[k]),
          PUBLIC_PAGE_LIMIT,
          lossy,
        ),
      );
    }
    // Non-public requests: 429 is only legitimate once the auth-failure peek
    // trips (≥ 30 prior 401s charged) — n ≤ 90 keeps the IP budget (1200) and
    // the fresh user's budget (240) out of reach.
    const nonPublic = observed.filter((o) =>
      plan[o.index].expect.kind !== "public"
    );
    const limited = nonPublic.filter((o) => o.status === 429).length;
    if (!lossy && limited && failures < AUTH_FAILURE_LIMIT) {
      violations.push({
        invariant: "fallthrough-429-only-after-authfail-trip",
        detail: `${limited} 429s with ${failures} 401s`,
      });
    }
    // No fallthrough request may reach PostgREST: unknown routes do no DB work.
    const upstream = upstreamHistogram(ctx.h, callsBefore);
    for (const key of Object.keys(upstream)) {
      if (key.includes("/rest/v1/")) {
        violations.push({ invariant: "fallthrough-no-db", detail: key });
      }
    }
    row.composition = {
      transport,
      ip,
      userId: actor.userId,
      n,
      methods: histogram(plan.map((p) => p.method)),
      bearers: histogram(plan.map((p) => p.bearer)),
      classes: histogram(plan.map((p) => p.expect.kind)),
      aborted: plan.filter((p) => p.abort).length,
    };
    row.statuses = histogram(observed.map((o) => o.status));
    row.upstreamCalls = upstream;
    row.metrics = {
      ...stats,
      probeStatus,
      failures401: failures,
      getUserCalls: upstream["GET /auth/v1/user"] ?? 0,
    };
    record(ctx.report, finish(row, violations, wallMs), n);
  }
}

// ─── S3b: auth-failure budget under a concurrent bad-bearer burst ───────────

export const S3B = "S3b auth-failure budget concurrency";
export async function s3b(
  ctx: ScenarioContext,
  scenarioIndex: number,
): Promise<void> {
  for (let i = 0; i < ITERATIONS; i += 1) {
    const seed = iterationSeed(STRESS_SEED, scenarioIndex, i);
    const rng = new Prng(seed);
    const transport = begin(ctx, seed);
    const ip = stressIp();
    // Two waves: wave A charges failures concurrently; wave B (launched after
    // A settles, same window) must see the peek trip exactly at 30.
    const nA = rng.int(10, 60);
    const nB = rng.int(5, 40);
    const mk = (index: number, bearer: BearerKind): PlannedRequest => {
      const method = rng.pick(["GET", "POST", "DELETE", "OPTIONS"]);
      const { fullPath, routePath } = unknownPath(rng, method);
      return {
        index,
        method,
        fullPath: isPublicRead(method, fullPath)
          ? `/api/v1/zz-x${index}`
          : fullPath,
        ...ipHeaders(rng, ip),
        bearer,
        requestId: "",
        requestIdValid: false,
        delayMs: rng.chance(0.3) ? rng.int(1, 3) : 0,
        abort: false,
        expect: classify(method, fullPath, bearer, routePath),
      };
    };
    const planA = Array.from(
      { length: nA },
      (_, k) =>
        mk(
          k,
          rng.pick<BearerKind>([
            "garbage",
            "expired-session",
            "forged-session",
          ]),
        ),
    );
    const planB = Array.from(
      { length: nB },
      (_, k) =>
        mk(k, rng.pick<BearerKind>(["garbage", "none", "forged-session"])),
    );
    const row = baseRow(S3B, seed, i, ctx.file);
    const callsBefore = ctx.h.calls.length;
    const result = await withClockOffset(rng.int(0, 200_000), async () => {
      const a = await runBurst(planA, rng, { h: ctx.h, actor: null });
      const b = await runBurst(planB, rng, { h: ctx.h, actor: null });
      return { a, b };
    });
    const { stats, lossy } = end(ctx);
    const violations = [
      ...checkCommon(planA, result.a.observed, result.a.logs),
      ...checkCommon(planB, result.b.observed, result.b.logs),
    ];
    const a401 = result.a.observed.filter((o) => o.status === 401).length;
    const a429 = result.a.observed.filter((o) => o.status === 429).length;
    // Wave A: every request passed the peek before any charge landed, so the
    // CONTRACT allows either 401 (charged) or 429 (peek saw ≥ 30); nothing else.
    if (a401 + a429 !== nA) {
      violations.push({
        invariant: "authfail-wave-a-status-set",
        detail: JSON.stringify(
          histogram(result.a.observed.map((o) => o.status)),
        ),
      });
    }
    // Wave B: with `charged` failures already recorded, the first
    // max(0, 30 - charged) requests may still be charged (401); once the
    // window holds ≥ 30 failures every later request must be 429 — and the
    // count of 401s in B is exactly min(nB, max(0, 30 - a401)) when B is
    // sequentially consistent, but B is concurrent too, so assert the bound:
    // total 401s across both waves ≤ 30 + (concurrent in-flight escapes of
    // wave B) and wave B has NO 401 once a401 ≥ 30.
    const b401 = result.b.observed.filter((o) => o.status === 401).length;
    const b429 = result.b.observed.filter((o) => o.status === 429).length;
    if (b401 + b429 !== nB) {
      violations.push({
        invariant: "authfail-wave-b-status-set",
        detail: JSON.stringify(
          histogram(result.b.observed.map((o) => o.status)),
        ),
      });
    }
    if (!lossy && a401 >= AUTH_FAILURE_LIMIT && b401 !== 0) {
      violations.push({
        invariant: "authfail-tripped-blocks-all",
        detail:
          `wave A charged ${a401} ≥ 30 but wave B still produced ${b401} 401s`,
      });
    }
    if (!lossy && a401 < AUTH_FAILURE_LIMIT && a429 !== 0) {
      violations.push({
        invariant: "authfail-no-premature-429",
        detail: `wave A: ${a429} 429s with only ${a401} failures charged`,
      });
    }
    row.composition = {
      transport,
      ip,
      nA,
      nB,
      bearersA: histogram(planA.map((p) => p.bearer)),
      bearersB: histogram(planB.map((p) => p.bearer)),
    };
    row.statuses = histogram(
      [...result.a.observed, ...result.b.observed].map((o) => o.status),
    );
    row.upstreamCalls = upstreamHistogram(ctx.h, callsBefore);
    row.metrics = {
      ...stats,
      a401,
      a429,
      b401,
      b429,
      escapedBeyondBudget: Math.max(0, a401 + b401 - AUTH_FAILURE_LIMIT),
    };
    record(
      ctx.report,
      finish(row, violations, result.a.wallMs + result.b.wallMs),
      nA + nB,
    );
  }
}

// ─── S4: logout while an unknown-route burst is in flight ───────────────────

export const S4 = "S4 logout during fallthrough burst";
export async function s4(
  ctx: ScenarioContext,
  scenarioIndex: number,
): Promise<void> {
  for (let i = 0; i < ITERATIONS; i += 1) {
    const seed = iterationSeed(STRESS_SEED, scenarioIndex, i);
    const rng = new Prng(seed);
    const transport = begin(ctx, seed);
    const ip = stressIp();
    const actor = mintActor(ctx.h, rng);
    const n = rng.int(15, 60);
    const logoutAt = rng.int(0, n - 1);
    const plan: PlannedRequest[] = Array.from({ length: n }, (_, k) => {
      const method = rng.pick(["GET", "POST", "PUT", "DELETE"]);
      const { fullPath, routePath } = unknownPath(rng, method);
      return {
        index: k,
        method,
        fullPath: isPublicRead(method, fullPath)
          ? `/api/v1/zz-y${k}`
          : fullPath,
        ...ipHeaders(rng, ip),
        bearer: "valid-session" as BearerKind,
        requestId: "",
        requestIdValid: false,
        delayMs: rng.int(0, 6),
        abort: false,
        expect: {
          kind: "unknown-route",
          route: `${method} ${
            isPublicRead(method, fullPath) ? `/v1/zz-y${k}` : routePath
          }`,
        },
      };
    });
    const row = baseRow(S4, seed, i, ctx.file);
    const callsBefore = ctx.h.calls.length;
    let logoutStatus = 0;
    let logoutDoneAtMs = Infinity;
    const startedAtMs: number[] = [];
    const wall0 = performance.now();
    const burst = await withClockOffset(
      rng.int(0, 59_000),
      () =>
        runBurst(plan, rng, {
          h: ctx.h,
          actor,
          beforeDispatch: (p) => {
            startedAtMs[p.index] = performance.now();
            if (p.index === logoutAt) {
              // Fire logout right beside request `logoutAt` (call-during-call).
              void (async () => {
                await sleep(rng.int(0, 3));
                const res = await ctx.h.handler(
                  apiRequest("POST", "/api/v1/auth/logout", {
                    ip,
                    token: actor.session.accessToken,
                  }),
                );
                await res.body?.cancel();
                logoutStatus = res.status;
                logoutDoneAtMs = performance.now();
              })();
            }
          },
        }),
    );
    // Wait for the logout side-task to settle before judging.
    for (let spins = 0; logoutStatus === 0 && spins < 200; spins += 1) {
      await sleep(5);
    }
    const wallMs = Math.round(performance.now() - wall0);
    const burstLogs = burst.logs.filter((l) =>
      !l.route.endsWith("/auth/logout")
    );
    const { stats } = end(ctx);
    const violations = checkCommon(plan, burst.observed, burstLogs);
    if (logoutStatus !== 204) {
      violations.push({
        invariant: "logout-204",
        detail: `logout → ${logoutStatus}`,
      });
    }
    for (const o of burst.observed) {
      if (o.status !== 404 && o.status !== 401) {
        violations.push({
          invariant: "logout-race-status-set",
          detail: `#${o.index} → ${o.status} ${o.bodyHead}`,
        });
      }
      // Any request DISPATCHED after the logout completed must be refused.
      if (startedAtMs[o.index] > logoutDoneAtMs && o.status !== 401) {
        violations.push({
          invariant: "logout-fence-after-completion",
          detail: `#${o.index} started ${
            Math.round(startedAtMs[o.index] - logoutDoneAtMs)
          }ms after logout → ${o.status}`,
        });
      }
    }
    // Post-condition: bearer refused, sequentially.
    const after = await ctx.h.handler(
      apiRequest("GET", "/api/v1/zz-after", {
        ip,
        token: actor.session.accessToken,
      }),
    );
    await after.body?.cancel();
    // Every refused burst request charged this IP's auth-failure budget, so
    // once ≥ 30 were refused the probe is pre-empted by the 429 peek — still
    // "not served". Anything else (200/404) is a fence bypass.
    const refusedSoFar = burst.observed.filter((o) => o.status === 401).length;
    const okAfter = after.status === 401 ||
      (after.status === 429 && refusedSoFar >= AUTH_FAILURE_LIMIT);
    if (!okAfter) {
      violations.push({
        invariant: "logout-bearer-refused-after",
        detail: `→ ${after.status} (${refusedSoFar} refused before it)`,
      });
    }
    const upstream = upstreamHistogram(ctx.h, callsBefore);
    for (const key of Object.keys(upstream)) {
      if (key.includes("/rest/v1/")) {
        violations.push({ invariant: "fallthrough-no-db", detail: key });
      }
    }
    row.composition = { transport, ip, userId: actor.userId, n, logoutAt };
    row.statuses = histogram(burst.observed.map((o) => o.status));
    row.upstreamCalls = upstream;
    row.metrics = {
      ...stats,
      logoutStatus,
      servedBeforeLogout: burst.observed.filter((o) => o.status === 404).length,
      refused: burst.observed.filter((o) => o.status === 401).length,
    };
    record(ctx.report, finish(row, violations, wallMs), n + 2);
  }
}

// ─── S5: clock skew across a fixed-window boundary ──────────────────────────

export const S5 = "S5 clock skew across window boundary";
export async function s5(
  ctx: ScenarioContext,
  scenarioIndex: number,
): Promise<void> {
  for (let i = 0; i < ITERATIONS; i += 1) {
    const seed = iterationSeed(STRESS_SEED, scenarioIndex, i);
    const rng = new Prng(seed);
    const transport = begin(ctx, seed);
    const ip = stressIp();
    const nA = rng.int(30, 100);
    const nB = rng.int(30, 100);
    const suffix = rng.pick(["/healthz", "/privacy"]);
    const scope = PUBLIC_SUFFIXES[suffix];
    const mk = (index: number): PlannedRequest => ({
      index,
      method: "GET",
      fullPath: publicPath(rng, suffix),
      ...ipHeaders(rng, ip),
      bearer: "none",
      requestId: "",
      requestIdValid: false,
      delayMs: 0,
      abort: false,
      expect: { kind: "public", scope, suffix },
    });
    const plan = Array.from({ length: nA + nB }, (_, k) => mk(k));
    // Freeze the clock just before a window edge; requests with index ≥ nA are
    // dispatched after the clock jumps across it (forward or backward skew).
    const realNow = Date.now;
    const base = realNow();
    const bucketStart = Math.floor(base / (WINDOW_SECONDS * 1000)) *
      WINDOW_SECONDS * 1000;
    const edge = bucketStart + WINDOW_SECONDS * 1000;
    const backward = rng.chance(0.5);
    const tA = backward ? edge + rng.int(1, 500) : edge - rng.int(1, 500);
    const tB = backward ? edge - rng.int(1, 500) : edge + rng.int(1, 500);
    let clock = tA;
    Date.now = () => clock;
    const row = baseRow(S5, seed, i, ctx.file);
    let result;
    try {
      result = await runBurst(plan, rng, {
        h: ctx.h,
        actor: null,
        beforeDispatch: (p) => {
          if (p.index === nA) clock = tB;
        },
      });
    } finally {
      Date.now = realNow;
    }
    const { stats, lossy } = end(ctx);
    const violations = checkCommon(plan, result.observed, result.logs);
    const a = result.observed.filter((o) => o.index < nA);
    const b = result.observed.filter((o) => o.index >= nA);
    violations.push(
      ...checkPublicBudget("bucket-A", plan, a, PUBLIC_PAGE_LIMIT, lossy),
    );
    violations.push(
      ...checkPublicBudget("bucket-B", plan, b, PUBLIC_PAGE_LIMIT, lossy),
    );
    // Retry-After on a 429 in bucket A points at the edge (≤ 1s away), never
    // at a whole extra window.
    for (const o of backward || lossy ? [] : a) {
      if (o.status === 429 && Number(o.retryAfter) > 1) {
        violations.push({
          invariant: "retry-after-tracks-edge",
          detail: `#${o.index} Retry-After=${o.retryAfter} with ${
            edge - tA
          }ms to the edge`,
        });
      }
    }
    row.composition = {
      transport,
      ip,
      nA,
      nB,
      suffix,
      backward,
      msToEdgeA: edge - tA,
      msPastEdgeB: tB - edge,
    };
    row.statuses = histogram(result.observed.map((o) => o.status));
    row.metrics = {
      ...stats,
      admittedA: a.filter((o) => o.status === 200).length,
      admittedB: b.filter((o) => o.status === 200).length,
    };
    record(ctx.report, finish(row, violations, result.wallMs), nA + nB);
  }
}

// ─── S6: duplicate calls are idempotent (byte-identical public bodies) ──────

export const S6 = "S6 duplicate public calls idempotent";
export async function s6(
  ctx: ScenarioContext,
  scenarioIndex: number,
): Promise<void> {
  for (let i = 0; i < ITERATIONS; i += 1) {
    const seed = iterationSeed(STRESS_SEED, scenarioIndex, i);
    const rng = new Prng(seed);
    const transport = begin(ctx, seed);
    const suffix = rng.pick(Object.keys(PUBLIC_SUFFIXES));
    const dup = rng.int(2, 8);
    const ips = Array.from({ length: rng.int(1, 3) }, () => stressIp());
    const rid = `dup-${rng.hex(6)}`;
    const plan: PlannedRequest[] = [];
    for (const ip of ips) {
      const fullPath = publicPath(rng, suffix);
      for (let d = 0; d < dup; d += 1) {
        plan.push({
          index: plan.length,
          method: "GET",
          fullPath,
          ip,
          cfIp: "",
          bearer: "none",
          requestId: rng.chance(0.5) ? "" : rid,
          requestIdValid: false,
          delayMs: rng.chance(0.5) ? rng.int(0, 2) : 0,
          abort: false,
          expect: { kind: "public", scope: PUBLIC_SUFFIXES[suffix], suffix },
        });
      }
    }
    // Duplicate client ids are legitimate retries: the id echoes for each.
    for (const p of plan) if (p.requestId) p.requestIdValid = true;
    const row = baseRow(S6, seed, i, ctx.file);
    const result = await withClockOffset(
      rng.int(0, 59_000),
      () => runBurst(plan, rng, { h: ctx.h, actor: null }),
    );
    const { stats } = end(ctx);
    const violations = checkCommon(plan, result.observed, result.logs).filter(
      (v) => v.invariant !== "x-request-id-unique",
    );
    const admitted = result.observed.filter((o) => o.status === 200);
    if (admitted.length !== plan.length) {
      violations.push({
        invariant: "dup-all-admitted",
        detail: JSON.stringify(histogram(result.observed.map((o) => o.status))),
      });
    }
    const bodies = new Set(admitted.map((o) => `${o.bodyBytes}:${o.bodyHead}`));
    if (bodies.size !== 1) {
      violations.push({
        invariant: "dup-byte-identical",
        detail: [...bodies].join(" | "),
      });
    }
    row.composition = { transport, suffix, dup, ips, requestIdShared: rid };
    row.statuses = histogram(result.observed.map((o) => o.status));
    record(ctx.report, finish(row, violations, result.wallMs), plan.length);
  }
}

// ─── S7: memory-window eviction under distinct spoofed IPs (contract) ───────

export const S7 = "S7 window map flood must not unblock a limited IP";
/** 20 000 distinct X-Forwarded-For values from ONE client against /healthz,
 * then the previously limited victim IP again. CONTRACT: a budget that was
 * exhausted inside its window stays exhausted (fixed window). Cost: ~20k
 * in-process requests — the campaign's slowest cell, one iteration. */
export async function s7(
  ctx: ScenarioContext,
  scenarioIndex: number,
): Promise<void> {
  const seed = iterationSeed(STRESS_SEED, scenarioIndex, 0);
  const rng = new Prng(seed);
  const victim = stressIp();
  const row = baseRow(S7, seed, 0, ctx.file);
  const wall0 = performance.now();
  const violations: Violation[] = [];
  let exhausted = 0;
  let floodStatuses: Record<string, number> = {};
  let afterStatus = 0;
  await withClockOffset(rng.int(0, 30_000), async () => {
    const first = await Promise.all(
      Array.from(
        { length: PUBLIC_PAGE_LIMIT + 5 },
        () =>
          ctx.h.handler(apiRequest("GET", "/api/healthz", { ip: victim })).then(
            async (r) => {
              await r.body?.cancel();
              return r.status;
            },
          ),
      ),
    );
    exhausted = first.filter((s) => s === 429).length;
    if (exhausted !== 5) {
      violations.push({
        invariant: "public-budget-exact",
        detail: `victim: ${exhausted} 429s of 65`,
      });
    }
    const flood: number[] = [];
    for (let batch = 0; batch < 200; batch += 1) {
      const statuses = await Promise.all(
        Array.from({ length: 100 }, (_, k) =>
          ctx.h
            .handler(
              apiRequest("GET", "/api/healthz", {
                ip: `10.${batch}.${Math.floor(k / 200)}.${k + 1}`,
              }),
            )
            .then(async (r) => {
              await r.body?.cancel();
              return r.status;
            })),
      );
      flood.push(...statuses);
    }
    floodStatuses = histogram(flood);
    const after = await ctx.h.handler(
      apiRequest("GET", "/api/healthz", { ip: victim }),
    );
    await after.body?.cancel();
    afterStatus = after.status;
  });
  if (afterStatus !== 429) {
    violations.push({
      invariant: "limited-ip-stays-limited-within-window",
      detail:
        `victim exhausted its 60/min budget (${exhausted} 429s), 20 000 distinct spoofed IPs later it is served ${afterStatus}`,
    });
  }
  row.composition = { victim, floodDistinctIps: 20_000 };
  row.statuses = { ...floodStatuses, victimAfter: afterStatus };
  row.metrics = { exhausted429: exhausted };
  const wallMs = Math.round(performance.now() - wall0);
  row.wallMs = wallMs;
  row.violations = violations;
  row.outcome = violations.length ? "BROKEN" : "HELD";
  record(ctx.report, row, PUBLIC_PAGE_LIMIT + 5 + 20_000 + 1);
}

// ─── shared sanity: the harness answers at all ──────────────────────────────

export async function smoke(h: SessionHarness): Promise<void> {
  const res = await h.handler(
    apiRequest("GET", "/api/healthz", { ip: freshIp() }),
  );
  assertEquals(res.status, 200);
  await res.body?.cancel();
  const unknown = await h.handler(
    apiRequest("GET", "/api/v1/zz-smoke", { ip: freshIp(), token: null }),
  );
  assertEquals(unknown.status, 401);
  await unknown.body?.cancel();
}

export { GENERAL_USER_LIMIT };
