/**
 * stress: PUT /v1/me/onboarding — LOAD + payload fuzz + L1 memory (Redis OFF).
 *
 * Redis is deliberately absent here so every cache / rate-limit path runs on
 * the per-isolate memory fallback (cache.ts L1, rateLimit.ts windows) — the
 * mode a production isolate is in whenever Upstash is unset or unreachable.
 *
 *   1. fuzz   — STRESS_ITER seeded payloads (mostly hostile) through the real
 *               handler; an oracle mirroring the route contract says what the
 *               status, message and PATCH body must be. 400s must write nothing.
 *   2. load   — STRESS_ITER sequential + concurrent requests over 8 warm users:
 *               p50/p95/p99 latency, Supabase round trips per request (>3 is a
 *               finding), memory-window growth.
 *   3. users  — STRESS_USERS distinct sessions (20 000 in the campaign): heap
 *               before/after, L1 auth-cache hit rate on the second pass (the L1
 *               is capped at 5 000 entries, so ≥ users-5000 re-verifications are
 *               expected), rate-limit memory-window eviction behaviour.
 *
 *   deno test -A --no-check --config deno.json stress_onboarding_load.test.ts
 *   STRESS_ITER=1000 STRESS_USERS=20000 deno test -A --no-check --config deno.json --v8-flags=--expose-gc stress_onboarding_load.test.ts
 */
import { assert, assertEquals } from "@std/assert";
import { withFrozenClock } from "./sessionHarness.ts";
import {
  countRoundTrips,
  expectedFor,
  fuzzOnboardingBody,
  heapUsedBytes,
  histogram,
  type Invariant,
  ipAt,
  latencyStats,
  stressTest,
  onboardingRequest,
  Prng,
  provisionUser,
  replayCommand,
  round,
  runOnce,
  STRESS_ITER,
  STRESS_SEED,
  STRESS_USERS,
  tryGc,
  userIdAt,
  validOnboardingBody,
  writeReport,
} from "./stress_onboarding_harness.ts";

const FILE = "stress_onboarding_load.test.ts";

// ── 1. Payload fuzz against the contract oracle ──────────────────────────────

interface FuzzRow {
  i: number;
  seed: number;
  body: unknown;
  expected: { status: number; message: string };
  observed: {
    status: number;
    message: string;
    patchSent: boolean;
    patchMatches: boolean;
    echoMatches: boolean;
    ms: number;
  };
  outcome: "HELD" | "BROKEN";
  detail?: string;
}

stressTest(
  "stress/onboarding fuzz: seeded hostile payloads vs the route contract oracle",
  { redis: false },
  async (ctx) => {
    ctx.faults.clear();
    const startedAt = new Date().toISOString();
    const t0 = performance.now();
    const iterations = Math.max(STRESS_ITER, 16);
    // Spread over enough users that the 240/min general budget never trips.
    const USERS = Math.max(8, Math.ceil(iterations / 200));
    const sessions = Array.from({ length: USERS }, (_, u) =>
      provisionUser(ctx, userIdAt(300_000 + u)),
    );
    const rows: FuzzRow[] = [];
    for (let i = 0; i < iterations; i++) {
      const seed = (STRESS_SEED ^ (i * 0xc2b2ae35)) >>> 0;
      const rng = new Prng(seed);
      const body = fuzzOnboardingBody(rng);
      const expected = expectedFor(body);
      const u = i % USERS;
      const before = ctx.profiles.patches.length;
      // JSON round trip: the oracle sees exactly what the wire carries
      // (undefined keys vanish, __proto__ becomes a plain key).
      const wire = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
      const r = await runOnce(
        ctx,
        onboardingRequest(sessions[u].accessToken, wire, ipAt(70_000 + u)),
      );
      const patch = ctx.profiles.patches.slice(before);
      const patchSent = patch.length > 0;
      let patchMatches = true;
      let echoMatches = true;
      let detail: string | undefined;
      if (expected.status === 200) {
        patchMatches =
          patch.length === 1 &&
          JSON.stringify(patch[0].patch) === JSON.stringify(expected.patch) &&
          patch[0].filter === `eq.${userIdAt(300_000 + u)}`;
        const echoed =
          (r.body as {
            profile?: Record<string, unknown>;
            recommendedCheckpoint?: string;
            plan?: { focusCheckpoint?: string };
          }) ?? {};
        const profile = echoed.profile ?? {};
        echoMatches =
          echoed.recommendedCheckpoint === expected.focus &&
          echoed.plan?.focusCheckpoint === expected.focus &&
          profile.skill_level === expected.patch?.skill_level &&
          profile.primary_goal === expected.patch?.primary_goal &&
          profile.biggest_problem === expected.patch?.biggest_problem &&
          profile.handedness === expected.patch?.handedness &&
          profile.focus_checkpoint === expected.focus &&
          (expected.patch?.first_name === undefined ||
            profile.first_name === expected.patch.first_name) &&
          (expected.patch?.gender === undefined || profile.gender === expected.patch.gender);
        if (!patchMatches)
          detail = `patch ${JSON.stringify(patch.map((p) => p.patch))} ≠ ${JSON.stringify(expected.patch)}`;
        else if (!echoMatches) detail = `echo ${JSON.stringify(echoed)}`;
      } else if (patchSent) {
        detail = `400 still wrote ${JSON.stringify(patch[0].patch)}`;
      }
      const held =
        r.status === expected.status &&
        r.message === expected.message &&
        (expected.status === 200 ? patchMatches && echoMatches : !patchSent) &&
        r.roundTrips.auth + r.roundTrips.rest <= 3 &&
        r.roundTrips.revenuecat === 0;
      rows.push({
        i,
        seed,
        body: wire,
        expected: { status: expected.status, message: expected.message },
        observed: {
          status: r.status,
          message: r.message,
          patchSent,
          patchMatches,
          echoMatches,
          ms: round(r.durationMs),
        },
        outcome: held ? "HELD" : "BROKEN",
        detail,
      });
      if (ctx.h.calls.length > 2_000) ctx.h.calls.length = 0;
    }
    const broken = rows.filter((r) => r.outcome === "BROKEN");
    await writeReport({
      campaign: "onboarding_fuzz",
      seed: STRESS_SEED,
      scale: { iterations: rows.length, users: USERS },
      replay: replayCommand(FILE, "fuzz"),
      redis: false,
      rows,
      aggregates: {
        byStatus: histogram(rows.map((r) => r.observed.status)),
        byExpectedStatus: histogram(rows.map((r) => r.expected.status)),
        byOutcome: histogram(rows.map((r) => r.outcome)),
        latencyMs: latencyStats(rows.map((r) => r.observed.ms)),
        writesOn400: rows.filter((r) => r.expected.status === 400 && r.observed.patchSent).length,
      },
      invariants: [
        {
          name: "every payload matches the oracle",
          holds: broken.length === 0,
          detail: `${broken.length} broken`,
        },
        {
          name: "no 400 ever reaches PostgREST",
          holds: rows.every((r) => r.expected.status !== 400 || !r.observed.patchSent),
          detail: "",
        },
        {
          name: "no 5xx from hostile input",
          holds: rows.every((r) => r.observed.status < 500),
          detail: JSON.stringify(histogram(rows.map((r) => r.observed.status))),
        },
      ],
      broken: broken.map((r) => ({
        i: r.i,
        seed: r.seed,
        body: r.body,
        expected: r.expected,
        observed: r.observed,
        detail: r.detail,
      })),
      startedAt,
      durationMs: round(performance.now() - t0),
    });
    assertEquals(
      broken
        .slice(0, 10)
        .map(
          (r) =>
            `seed=${r.seed} expected ${r.expected.status} "${r.expected.message}" got ${r.observed.status} "${r.observed.message}" ${r.detail ?? ""}`,
        ),
      [],
    );
  },
);

// ── 2. Load: latency + round trips (memory fallback) ─────────────────────────

stressTest(
  "stress/onboarding load (Redis off): p50/p95 + Supabase round trips per request",
  { redis: false },
  async (ctx) => {
    ctx.faults.clear();
    const startedAt = new Date().toISOString();
    const t0 = performance.now();
    const USERS = 8;
    const iterations = Math.max(STRESS_ITER, 8);
    const sessions = Array.from({ length: USERS }, (_, u) =>
      provisionUser(ctx, userIdAt(400_000 + u)),
    );
    const rows: Array<{
      i: number;
      seed: number;
      user: number;
      status: number;
      ms: number;
      auth: number;
      rest: number;
      redis: number;
    }> = [];
    for (let i = 0; i < iterations; i++) {
      const u = i % USERS;
      const seed = (STRESS_SEED ^ (i * 0x27d4eb2f)) >>> 0;
      ctx.faults.resetCalls();
      const r = await runOnce(
        ctx,
        onboardingRequest(
          sessions[u].accessToken,
          validOnboardingBody(new Prng(seed)),
          ipAt(80_000 + u),
        ),
      );
      rows.push({
        i,
        seed,
        user: u,
        status: r.status,
        ms: round(r.durationMs),
        auth: r.roundTrips.auth,
        rest: r.roundTrips.rest,
        redis: r.roundTrips.redis,
      });
      if (ctx.h.calls.length > 2_000) ctx.h.calls.length = 0;
    }
    // Concurrency: 32 in flight (4 per user), warm cache, 4 waves.
    const waves: Array<{
      wave: number;
      inFlight: number;
      ms: number;
      statuses: Record<string, number>;
      auth: number;
      rest: number;
    }> = [];
    const rng = new Prng(STRESS_SEED ^ 0xb0057);
    for (let wave = 0; wave < 4; wave++) {
      ctx.faults.resetCalls();
      const started = performance.now();
      const responses = await Promise.all(
        Array.from({ length: 32 }, (_, k) => {
          const u = k % USERS;
          return ctx.h.handler(
            onboardingRequest(sessions[u].accessToken, validOnboardingBody(rng), ipAt(80_000 + u)),
          );
        }),
      );
      for (const res of responses) await res.body?.cancel();
      const trips = countRoundTrips(ctx.faults.calls);
      waves.push({
        wave,
        inFlight: 32,
        ms: round(performance.now() - started),
        statuses: histogram(responses.map((r) => r.status)),
        auth: trips.auth,
        rest: trips.rest,
      });
    }
    // Cold-cache stampede: one NEW user, 16 requests at once — how many auth
    // verifications does the isolate issue for a single token?
    const stampedeSession = provisionUser(ctx, userIdAt(400_100));
    ctx.faults.resetCalls();
    const stampede = await Promise.all(
      Array.from({ length: 16 }, () =>
        ctx.h.handler(
          onboardingRequest(stampedeSession.accessToken, validOnboardingBody(rng), ipAt(80_100)),
        ),
      ),
    );
    for (const res of stampede) await res.body?.cancel();
    const stampedeTrips = countRoundTrips(ctx.faults.calls);

    const warm = rows.filter((r) => r.i >= USERS);
    const invariants: Invariant[] = [
      {
        name: "every sequential request 200",
        holds: rows.every((r) => r.status === 200),
        detail: JSON.stringify(histogram(rows.map((r) => r.status))),
      },
      {
        name: "every concurrent request 200",
        holds: waves.every((w) => Object.keys(w.statuses).join() === "200"),
        detail: JSON.stringify(waves.map((w) => w.statuses)),
      },
      {
        name: "warm hot path = 1 Supabase round trip (PATCH), 0 auth, 0 redis",
        holds: warm.every((r) => r.rest === 1 && r.auth === 0 && r.redis === 0),
        detail: JSON.stringify({
          auth: histogram(warm.map((r) => r.auth)),
          rest: histogram(warm.map((r) => r.rest)),
          redis: histogram(warm.map((r) => r.redis)),
        }),
      },
      {
        name: "≤3 Supabase round trips on every request",
        holds: rows.every((r) => r.auth + r.rest <= 3),
        detail: `max=${Math.max(...rows.map((r) => r.auth + r.rest))}`,
      },
      {
        name: "concurrent waves: exactly 32 PATCHes, 0 auth",
        holds: waves.every((w) => w.rest === 32 && w.auth === 0),
        detail: JSON.stringify(waves.map((w) => [w.auth, w.rest])),
      },
      {
        name: "cold stampede: every request completed 200",
        holds: stampede.every((r) => r.status === 200),
        detail: `auth verifications for one cold token × 16 concurrent = ${stampedeTrips.auth}`,
      },
    ];
    const broken = invariants.filter((i) => !i.holds);
    await writeReport({
      campaign: "onboarding_load_redis_off",
      seed: STRESS_SEED,
      scale: { sequential: rows.length, concurrent: waves.length * 32, stampede: 16, users: USERS },
      replay: replayCommand(FILE, "load"),
      redis: false,
      rows,
      aggregates: {
        latencyMsWarm: latencyStats(warm.map((r) => r.ms)),
        latencyMsCold: latencyStats(rows.slice(0, USERS).map((r) => r.ms)),
        concurrentWaves: waves,
        stampede: {
          inFlight: 16,
          roundTrips: stampedeTrips,
          statuses: histogram(stampede.map((r) => r.status)),
        },
        roundTripsPerWarmRequest: {
          auth: histogram(warm.map((r) => r.auth)),
          rest: histogram(warm.map((r) => r.rest)),
        },
        supabaseRoundTripsPerRequestMax: Math.max(...rows.map((r) => r.auth + r.rest)),
      },
      invariants,
      broken,
      startedAt,
      durationMs: round(performance.now() - t0),
    });
    assertEquals(
      broken.map((i) => `${i.name} [${i.detail}]`),
      [],
    );
  },
);

// ── 3. L1 memory under many distinct users ───────────────────────────────────

stressTest(
  "stress/onboarding L1 memory: distinct users, cache cap, window eviction",
  { redis: false },
  async (ctx) => {
    ctx.faults.clear();
    const startedAt = new Date().toISOString();
    const t0 = performance.now();
    const users = Math.max(STRESS_USERS, 64);
    const IPS = 64; // 1200/min per IP: users/IPS requests per IP per pass must stay under it
    assert(users / IPS <= 1_000, "raise IPS for this many users");
    const body = validOnboardingBody(new Prng(STRESS_SEED ^ 0x11));

    // Pre-mint every session BEFORE the heap baseline so token/session storage
    // (harness state, not the edge function) is excluded from the delta.
    const tokens: string[] = new Array(users);
    for (let u = 0; u < users; u++)
      tokens[u] = provisionUser(ctx, userIdAt(500_000 + u)).accessToken;
    ctx.h.calls.length = 0;
    ctx.faults.resetCalls();

    interface Pass {
      auth: number;
      rest: number;
      statuses: number[];
      ms: number[];
      durationMs: number;
    }
    const runPass = async (): Promise<Pass> => {
      const pass: Pass = { auth: 0, rest: 0, statuses: [], ms: [], durationMs: 0 };
      const flush = () => {
        const trips = countRoundTrips(ctx.faults.calls);
        pass.auth += trips.auth;
        pass.rest += trips.rest;
        ctx.faults.resetCalls();
        ctx.h.calls.length = 0;
        ctx.profiles.patches.length = 0; // harness bookkeeping, not edge-function state
      };
      const started = performance.now();
      for (let u = 0; u < users; u++) {
        const t = performance.now();
        const res = await ctx.h.handler(
          onboardingRequest(tokens[u], body, ipAt(90_000 + (u % IPS))),
        );
        pass.ms.push(performance.now() - t);
        pass.statuses.push(res.status);
        await res.body?.cancel();
        if (ctx.faults.calls.length >= 4_096) flush();
      }
      flush();
      pass.durationMs = performance.now() - started;
      return pass;
    };

    // Rate-limit memory windows: the fallback map is capped at 20 000 keys and
    // CLEARS itself when full. Spend one user's whole general budget (240/min)
    // FIRST, confirm 429, flood with the distinct users, then ask whether the
    // budget survived. The clock is frozen so no window can simply expire.
    const spender = provisionUser(ctx, userIdAt(500_000 + users + 1));
    let spent = 0;
    let first429: number | null = null;
    let afterFloodStatus = 0;
    let pass1!: Pass;
    let pass2!: Pass;
    let heapBefore = 0;
    let heapAfterPass1 = 0;
    let heapAfterPass2 = 0;
    const gcAvailable = tryGc();
    await withFrozenClock(async () => {
      for (let k = 0; k < 260; k++) {
        const res = await ctx.h.handler(
          onboardingRequest(spender.accessToken, body, ipAt(90_500 + (k % 4))),
        );
        await res.body?.cancel();
        spent += 1;
        if (res.status === 429) {
          first429 = k + 1;
          break;
        }
      }
      ctx.faults.resetCalls();
      ctx.h.calls.length = 0;
      tryGc();
      heapBefore = heapUsedBytes();

      // Pass 1: every user once (cold) — one auth verification + one PATCH each.
      pass1 = await runPass();
      tryGc();
      heapAfterPass1 = heapUsedBytes();

      // Pass 2: the same users again — an L1 hit costs 0 auth trips. With the
      // cache capped at 5 000 entries, at most 5 000 of `users` can hit.
      pass2 = await runPass();
      tryGc();
      heapAfterPass2 = heapUsedBytes();

      const afterFlood = await ctx.h.handler(
        onboardingRequest(spender.accessToken, body, ipAt(90_500)),
      );
      await afterFlood.body?.cancel();
      afterFloodStatus = afterFlood.status;
      ctx.faults.resetCalls();
      ctx.h.calls.length = 0;
    });
    const {
      auth: pass1Auth,
      rest: pass1Rest,
      statuses: pass1Status,
      ms: pass1Ms,
      durationMs: pass1Duration,
    } = pass1;
    const {
      auth: pass2Auth,
      rest: pass2Rest,
      statuses: pass2Status,
      ms: pass2Ms,
      durationMs: pass2Duration,
    } = pass2;
    const afterFlood = { status: afterFloodStatus };

    const l1Cap = 5_000;
    const expectedMinReverify = Math.max(0, users - l1Cap);
    const perUserBytesPass1 = (heapAfterPass1 - heapBefore) / users;
    const invariants: Invariant[] = [
      {
        name: "pass 1: every distinct user 200",
        holds: pass1Status.every((s) => s === 200),
        detail: JSON.stringify(histogram(pass1Status)),
      },
      {
        name: "pass 1: exactly 1 auth + 1 PATCH per user",
        holds: pass1Auth === users && pass1Rest === users,
        detail: `auth=${pass1Auth} rest=${pass1Rest} users=${users}`,
      },
      {
        name: "pass 2: every user 200",
        holds: pass2Status.every((s) => s === 200),
        detail: JSON.stringify(histogram(pass2Status)),
      },
      {
        name: "pass 2: re-verifications bounded by the L1 cap (users − 5000 ≤ auth ≤ users)",
        holds: pass2Auth >= expectedMinReverify && pass2Auth <= users && pass2Rest === users,
        detail: `auth=${pass2Auth} (L1 hits=${users - pass2Auth}) rest=${pass2Rest}`,
      },
      {
        name: gcAvailable
          ? "L1 + windows stay bounded: heap growth per distinct user is small (gc forced)"
          : "heap growth per distinct user (observation — run with --v8-flags=--expose-gc to assert)",
        holds: !gcAvailable || perUserBytesPass1 < 8_192,
        detail: `${round(perUserBytesPass1, 0)} B/user over ${users} users; pass2 delta ${round((heapAfterPass2 - heapAfterPass1) / 1024, 0)} KiB`,
      },
      {
        name: "general per-user budget trips at 240 (memory windows)",
        holds: first429 === 241,
        detail: `first 429 after ${first429 ?? "never"} requests (spent ${spent})`,
      },
      {
        name: "rate-limit memory windows: budget state after the flood (observation)",
        holds: true,
        detail: `after ${users} distinct users the spender's next request → ${afterFlood.status} (${afterFlood.status === 429 ? "budget survived" : "budget RESET — the 20k-window map cleared itself (fail-open by design)"})`,
      },
    ];
    const broken = invariants.filter((i) => !i.holds);
    await writeReport({
      campaign: "onboarding_l1_memory",
      seed: STRESS_SEED,
      scale: { users, ips: IPS, requests: users * 2 + spent + 1 },
      replay: replayCommand(FILE, "L1 memory"),
      redis: false,
      rows: [
        {
          pass: 1,
          auth: pass1Auth,
          rest: pass1Rest,
          statuses: histogram(pass1Status),
          latencyMs: latencyStats(pass1Ms),
          durationMs: round(pass1Duration),
        },
        {
          pass: 2,
          auth: pass2Auth,
          rest: pass2Rest,
          statuses: histogram(pass2Status),
          latencyMs: latencyStats(pass2Ms),
          durationMs: round(pass2Duration),
          l1Hits: users - pass2Auth,
        },
      ],
      aggregates: {
        gcAvailable,
        heapUsedBytes: {
          before: heapBefore,
          afterPass1: heapAfterPass1,
          afterPass2: heapAfterPass2,
        },
        heapGrowthBytes: {
          pass1: heapAfterPass1 - heapBefore,
          pass2: heapAfterPass2 - heapAfterPass1,
        },
        heapGrowthPerUserBytesPass1: round(perUserBytesPass1, 0),
        l1CapEntries: l1Cap,
        rateLimit: {
          first429AfterRequests: first429,
          afterFloodStatus: afterFlood.status,
          memoryWindowCap: 20_000,
        },
      },
      invariants,
      broken,
      startedAt,
      durationMs: round(performance.now() - t0),
    });
    assertEquals(
      broken.map((i) => `${i.name} [${i.detail}]`),
      [],
    );
  },
);
