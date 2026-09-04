// Concurrency stress campaign for POST /v1/auth/logout — the REAL edge handler
// (../index.ts) over the stateful fake Supabase in xc_concurrency_harness.ts,
// per-isolate cache only (no Upstash; the L2 variant lives in
// stress_route_post_v1_auth_logout_concurrency_redis.test.ts).
//
// Every scenario runs STRESS_ITER seeded rounds; a round is one Promise.all
// interleaving whose lane count, start offsets, upstream latencies and
// injected faults are all drawn from the round seed. The contract asserted
// (AGENTS.md "Auth sessions" + the logoutRoute / fenceRevokedSession /
// authenticate comments in ../index.ts):
//
//   idempotent      duplicate logouts of one bearer: every lane 204 or 401,
//                   never 5xx; exactly one upstream logout per 204; a logout
//                   after the fence costs no upstream call
//   revoked means   once ANY lane got 204 the session is revoked upstream
//   revoked         and EVERY access token of it (the bearer, its pre-refresh
//                   sibling, a token rotated during the race) is refused at
//                   this edge from the next request on, with no GoTrue
//                   re-verification (the session_id fence)
//   scope=local     the user's OTHER session (another device) is never
//                   touched — not one 401 for it, concurrently or after
//   nothing evicted a logout Supabase Auth could not perform (5xx/network)
//                   is a retryable 503 with a generic body and leaves the
//                   bearer working; a mix of failed and successful lanes ends
//                   revoked (never half-signed-out)
//   bounded         a round completes inside ROUND_BOUND_MS; a stalled
//                   upstream is answered within the Auth deadline
//   no PostgREST    the route never touches the database
//
// Results: one row per round (seed → HELD/BROKEN, statuses, inputs,
// violations, replay command) in
// artifacts/stress-route-post-v1-auth-logout-concurrency/latest/
// stress_route_post_v1_auth_logout_concurrency.json.
//
//   cd supabase/functions/api/__wf__ && deno task test stress_route_post_v1_auth_logout_concurrency.test.ts
//   STRESS_ITER=80 deno test -A --no-check --config deno.json stress_route_post_v1_auth_logout_concurrency.test.ts

import { assert, assertEquals } from "@std/assert";
import {
  bootstrap,
  edgeRequest,
  jwtPayload,
  loadXcHarness,
  readJson,
  type XcHarness,
} from "./xc_concurrency_harness.ts";
import {
  Campaign,
  Checks,
  errorMessageOf,
  fnv1a,
  histogram,
  type Lane,
  laneIp,
  type LaneResult,
  replayCommand,
  Rng,
  ROUND_BOUND_MS,
  roundSeeds,
  runLanes,
  shiftClock,
  sleep,
  STRESS_LATENCY_MS,
} from "./stress_logout_support.ts";

const FILE = "stress_route_post_v1_auth_logout_concurrency.test.ts";
const campaign = new Campaign(FILE);

const LOGOUT_503_MESSAGE =
  "Sign-out is temporarily unavailable. Please try again.";
const REVOKED_MESSAGE = "The session is no longer valid. Sign in again.";
const EXPIRED_MESSAGE = "The session token has expired.";

// ── Fault injection in front of the xc fake ─────────────────────────────────
//
// loadXcHarness() installs the fake as globalThis.fetch once; this wrapper
// sits in front of it so a scenario can fail or stall upstream logout calls
// per seeded plan. Upstream calls the wrapper answers never reach the fake.

type Fault = "ok" | "500" | "502" | "throw" | "gone401" | "gone403";
let logoutFaultPlan: Fault[] = [];
const appliedFaults: Fault[] = [];
let wrapperInstalled = false;

function installFaultWrapper(): void {
  if (wrapperInstalled) return;
  wrapperInstalled = true;
  const inner = globalThis.fetch;
  globalThis.fetch =
    ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      if (
        request.url.includes("/auth/v1/logout") && logoutFaultPlan.length > 0
      ) {
        const fault = logoutFaultPlan.shift()!;
        appliedFaults.push(fault);
        if (fault === "throw") {
          return Promise.reject(
            new TypeError("stress: simulated network failure"),
          );
        }
        if (fault === "500" || fault === "502") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                code: Number(fault),
                msg: "forced upstream failure",
              }),
              {
                status: Number(fault),
                headers: { "Content-Type": "application/json" },
              },
            ),
          );
        }
        if (fault === "gone401" || fault === "gone403") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                code: Number(fault.slice(4)),
                error_code: "session_not_found",
              }),
              {
                status: Number(fault.slice(4)),
                headers: { "Content-Type": "application/json" },
              },
            ),
          );
        }
      }
      return inner(request);
    }) as typeof fetch;
}

// ── Round plumbing ───────────────────────────────────────────────────────────

interface Ctx {
  h: XcHarness;
  rng: Rng;
  seed: number;
  round: number;
  scenario: string;
  checks: Checks;
  inputs: Record<string, unknown>;
  observations: Record<string, unknown>;
  lanes: LaneResult[];
  ip(lane: number): string;
}

const sessionIdOf = (token: string): string =>
  String(jwtPayload(token)?.session_id ?? "");
const sessionOf = (h: XcHarness, token: string) =>
  h.fake.sessions.get(sessionIdOf(token));
const counter = (h: XcHarness, key: string): number =>
  h.fake.counters[key] ?? 0;
const restCalls = (h: XcHarness): number =>
  h.upstreamCalls.filter((call) => call.url.includes("/rest/v1/")).length;

const logoutRequest = (
  token: string,
  ip: string,
  signal?: AbortSignal,
): Request => {
  const request = edgeRequest("POST", "/v1/auth/logout", { token, ip });
  return signal ? new Request(request, { signal }) : request;
};
const accessRequest = (token: string, ip: string): Request =>
  edgeRequest("GET", "/v1/me/access", { token, ip });
const refreshRequest = (refreshToken: string, ip: string): Request =>
  edgeRequest("POST", "/v1/auth/refresh", { ip, body: { refreshToken } });

async function signIn(ctx: Ctx, lane: number, sub = ctx.rng.uuid()) {
  const boot = await bootstrap(ctx.h, sub, ctx.ip(lane));
  ctx.checks.equal(boot.status, 200, `bootstrap for ${sub.slice(0, 8)}`);
  return { sub, ...boot };
}

/** GET /v1/me/access with `token` from a fresh IP; returns the status. */
async function probe(ctx: Ctx, token: string, lane: number): Promise<number> {
  const response = await ctx.h.handler(accessRequest(token, ctx.ip(lane)));
  await response.body?.cancel();
  return response.status;
}

async function refresh(
  ctx: Ctx,
  refreshToken: string,
  lane: number,
): Promise<{ status: number; accessToken: string; refreshToken: string }> {
  const response = await ctx.h.handler(
    refreshRequest(refreshToken, ctx.ip(lane)),
  );
  const body = await readJson(response);
  const session = (body.session ?? {}) as Record<string, unknown>;
  return {
    status: response.status,
    accessToken: String(session.accessToken ?? ""),
    refreshToken: String(session.refreshToken ?? ""),
  };
}

/** After a logout took effect: every listed token is refused twice from
 * fresh IPs WITHOUT GoTrue being consulted again (the fence answers), and
 * every listed refresh token is refused. */
async function expectFenced(
  ctx: Ctx,
  tokens: Array<{ label: string; token: string }>,
  refreshTokens: Array<{ label: string; token: string }>,
  laneBase: number,
): Promise<void> {
  let lane = laneBase;
  for (const { label, token } of tokens) {
    const getUserBefore = counter(ctx.h, "gotrue.get_user");
    for (let i = 0; i < 2; i += 1) {
      const status = await probe(ctx, token, lane += 1);
      ctx.checks.equal(status, 401, `${label} probe ${i + 1} after logout`);
    }
    ctx.checks.equal(
      counter(ctx.h, "gotrue.get_user") - getUserBefore,
      0,
      `${label}: GoTrue re-verifications after logout`,
    );
  }
  for (const { label, token } of refreshTokens) {
    const rotated = await refresh(ctx, token, lane += 1);
    ctx.checks.equal(rotated.status, 401, `${label} refresh after logout`);
  }
}

function statusesOf(results: LaneResult[], prefix: string): number[] {
  return results.filter((r) => r.lane.startsWith(prefix)).map((r) => r.status);
}

function noServerErrors(ctx: Ctx, results: LaneResult[]): void {
  for (const r of results) {
    ctx.checks.that(
      r.status < 500,
      `${r.lane}: 5xx ${r.status} ${r.body.slice(0, 120)}`,
    );
  }
}

function scenario(name: string, run: (ctx: Ctx) => Promise<void>): void {
  Deno.test(`stress logout ${name}`, async () => {
    const h = await loadXcHarness();
    installFaultWrapper();
    const seeds = roundSeeds(name);
    const rows: string[] = [];
    let broken = 0;
    for (const [round, seed] of seeds.entries()) {
      h.fake.reset(seed, STRESS_LATENCY_MS);
      h.upstreamCalls.length = 0;
      logoutFaultPlan = [];
      appliedFaults.length = 0;
      const ctx: Ctx = {
        h,
        rng: new Rng((seed ^ fnv1a(name)) >>> 0),
        seed,
        round,
        scenario: name,
        checks: new Checks(),
        inputs: {},
        observations: {},
        lanes: [],
        ip: (lane) => laneIp(name, round, lane),
      };
      const t0 = performance.now();
      try {
        await run(ctx);
      } catch (error) {
        ctx.checks.that(
          false,
          `round threw: ${error instanceof Error ? error.message : error}`,
        );
      }
      const durationMs = Math.round(performance.now() - t0);
      ctx.checks.that(
        durationMs <= ROUND_BOUND_MS,
        `round wall time ${durationMs}ms exceeds ${ROUND_BOUND_MS}ms`,
      );
      const outcome = ctx.checks.violations.length === 0 ? "HELD" : "BROKEN";
      if (outcome === "BROKEN") broken += 1;
      campaign.add({
        scenario: name,
        round,
        seed,
        outcome,
        durationMs,
        lanes: ctx.lanes.length,
        statuses: histogram(
          ctx.lanes.map((r) => `${r.lane.replace(/#\d+$/, "")}:${r.status}`),
        ),
        inputs: ctx.inputs,
        observations: { ...ctx.observations, counters: { ...h.fake.counters } },
        violations: ctx.checks.violations,
        replay: replayCommand(FILE, name, seed),
      });
      rows.push(`${seed}:${outcome}`);
    }
    const path = await campaign.write();
    console.log(
      `[stress logout] ${name}: ${seeds.length} rounds, ${broken} broken → ${path}`,
    );
    assertEquals(
      broken,
      0,
      `${broken}/${seeds.length} rounds violated the logout contract — seeds ${
        rows
          .filter((r) => r.endsWith("BROKEN"))
          .join(", ")
      }; table: ${path}`,
    );
  });
}

// ── Scenarios ────────────────────────────────────────────────────────────────

const L = Math.max(1, STRESS_LATENCY_MS);

scenario(
  "S1 duplicate logout burst — one bearer, N concurrent sign-outs",
  async (ctx) => {
    const { h, rng, checks } = ctx;
    const me = await signIn(ctx, 250);
    const warmed = rng.chance(0.5);
    if (warmed) {
      checks.equal(
        await probe(ctx, me.accessToken, 251),
        200,
        "warm-up read",
      );
    }
    const n = rng.int(2, 8);
    const offsets = Array.from({ length: n }, () => rng.int(0, 3 * L));
    ctx.inputs = { burst: n, offsets, warmed };
    const restBefore = restCalls(h);
    const logoutsBefore = counter(h, "gotrue.logout");

    const lanes: Lane[] = offsets.map((at, i) => ({
      name: `logout#${i}`,
      at,
      run: () => h.handler(logoutRequest(me.accessToken, ctx.ip(i))),
    }));
    const results = await runLanes(lanes);
    ctx.lanes = results;
    noServerErrors(ctx, results);

    const statuses = statusesOf(results, "logout");
    const ok = statuses.filter((s) => s === 204).length;
    checks.that(
      statuses.every((s) => s === 204 || s === 401),
      `logout statuses ${statuses.join(",")} not all 204/401`,
    );
    checks.that(ok >= 1, "at least one lane signed out (204)");
    checks.equal(
      counter(h, "gotrue.logout") - logoutsBefore,
      ok,
      "upstream logout calls == 204 lanes (a fenced duplicate costs no upstream call)",
    );
    for (const r of results) {
      if (r.status === 401) {
        checks.equal(
          errorMessageOf(r.body),
          REVOKED_MESSAGE,
          `${r.lane} 401 body`,
        );
      }
    }
    checks.equal(
      restCalls(h) - restBefore,
      0,
      "PostgREST calls made by logout lanes",
    );
    checks.equal(
      sessionOf(h, me.accessToken)?.revoked,
      true,
      "session revoked upstream",
    );

    await expectFenced(
      ctx,
      [{ label: "bearer", token: me.accessToken }],
      [{ label: "refresh token", token: me.refreshToken }],
      100,
    );
    // One more sign-out after the dust settled: idempotent and free.
    const logoutsAfter = counter(h, "gotrue.logout");
    const again = await h.handler(logoutRequest(me.accessToken, ctx.ip(120)));
    await again.body?.cancel();
    checks.equal(again.status, 401, "logout after logout");
    checks.equal(
      counter(h, "gotrue.logout") - logoutsAfter,
      0,
      "upstream calls for late duplicate",
    );
    ctx.observations = { statuses, ok };
  },
);

scenario(
  "S2 logout during in-flight authenticated reads (call-during-call)",
  async (ctx) => {
    const { h, rng, checks } = ctx;
    const me = await signIn(ctx, 250);
    const warmed = rng.chance(0.4);
    if (warmed) {
      checks.equal(
        await probe(ctx, me.accessToken, 251),
        200,
        "warm-up read",
      );
    }
    const reads = rng.int(3, 10);
    const slowVerifyMs = rng.chance(0.6) ? rng.int(1, 3 * L) : 0;
    h.fake.overrides.getUserDelayMs = (
      bearer,
    ) => (bearer === me.accessToken ? slowVerifyMs : 0);
    const readOffsets = Array.from({ length: reads }, () => rng.int(0, 4 * L));
    const logoutAt = rng.int(0, 4 * L);
    ctx.inputs = { reads, readOffsets, logoutAt, slowVerifyMs, warmed };

    const lanes: Lane[] = readOffsets.map((at, i) => ({
      name: `read#${i}`,
      at,
      run: () => h.handler(accessRequest(me.accessToken, ctx.ip(i))),
    }));
    lanes.push({
      name: "logout#0",
      at: logoutAt,
      run: () => h.handler(logoutRequest(me.accessToken, ctx.ip(200))),
    });
    const results = await runLanes(lanes);
    ctx.lanes = results;
    noServerErrors(ctx, results);

    const logout = results.find((r) => r.lane === "logout#0")!;
    checks.equal(logout.status, 204, "logout status");
    for (const r of results) {
      if (!r.lane.startsWith("read")) continue;
      checks.that(
        r.status === 200 || r.status === 401,
        `${r.lane}: status ${r.status}`,
      );
      if (r.startedAt >= logout.endedAt) {
        checks.equal(
          r.status,
          401,
          `${r.lane} started after the logout completed`,
        );
      }
    }
    checks.equal(
      sessionOf(h, me.accessToken)?.revoked,
      true,
      "session revoked upstream",
    );
    await expectFenced(
      ctx,
      [{ label: "bearer", token: me.accessToken }],
      [{ label: "refresh token", token: me.refreshToken }],
      100,
    );
    ctx.observations = {
      reads: histogram(statusesOf(results, "read")),
      readsAfterLogout:
        results.filter((r) =>
          r.lane.startsWith("read") && r.startedAt >= logout.endedAt
        )
          .length,
    };
  },
);

scenario(
  "S3 refresh rotation racing logout of the same session",
  async (ctx) => {
    const { h, rng, checks } = ctx;
    const me = await signIn(ctx, 250);
    const refreshAt = rng.int(0, 3 * L);
    const logoutAt = rng.int(0, 3 * L);
    const withRead = rng.chance(0.5);
    ctx.inputs = { refreshAt, logoutAt, withRead };

    const lanes: Lane[] = [
      {
        name: "refresh#0",
        at: refreshAt,
        run: () => h.handler(refreshRequest(me.refreshToken, ctx.ip(1))),
      },
      {
        name: "logout#0",
        at: logoutAt,
        run: () => h.handler(logoutRequest(me.accessToken, ctx.ip(2))),
      },
    ];
    if (withRead) {
      lanes.push({
        name: "read#0",
        at: rng.int(0, 3 * L),
        run: () => h.handler(accessRequest(me.accessToken, ctx.ip(3))),
      });
    }
    const results = await runLanes(lanes);
    ctx.lanes = results;
    noServerErrors(ctx, results);

    const refreshed = results.find((r) => r.lane === "refresh#0")!;
    const logout = results.find((r) => r.lane === "logout#0")!;
    checks.equal(logout.status, 204, "logout status");
    checks.that(
      refreshed.status === 200 || refreshed.status === 401,
      `refresh status ${refreshed.status}`,
    );
    const session = sessionOf(h, me.accessToken);
    checks.equal(
      session?.revoked,
      true,
      "session revoked upstream whatever the order",
    );

    const fencedTokens = [{ label: "original bearer", token: me.accessToken }];
    const deadRefresh = [{
      label: "original refresh token",
      token: me.refreshToken,
    }];
    if (refreshed.status === 200) {
      const body = JSON.parse(refreshed.body) as {
        session: Record<string, string>;
      };
      checks.equal(
        sessionIdOf(body.session.accessToken),
        sessionIdOf(me.accessToken),
        "rotated token belongs to the same session",
      );
      fencedTokens.push({
        label: "rotated bearer",
        token: body.session.accessToken,
      });
      deadRefresh.push({
        label: "rotated refresh token",
        token: body.session.refreshToken,
      });
    }
    await expectFenced(ctx, fencedTokens, deadRefresh, 100);
    ctx.observations = {
      refresh: refreshed.status,
      rotatedBeforeLogout: refreshed.status === 200,
    };
  },
);

scenario(
  "S4 two actors, one session — pre-refresh sibling token logs out",
  async (ctx) => {
    const { h, rng, checks } = ctx;
    const me = await signIn(ctx, 250);
    const rotated = await refresh(ctx, me.refreshToken, 251);
    checks.equal(rotated.status, 200, "rotation before the race");
    checks.equal(
      sessionIdOf(rotated.accessToken),
      sessionIdOf(me.accessToken),
      "rotation keeps the session id",
    );
    const warmSibling = rng.chance(0.6);
    if (warmSibling) {
      checks.equal(
        await probe(ctx, rotated.accessToken, 252),
        200,
        "warm sibling",
      );
    }
    const reads = rng.int(2, 6);
    const readOffsets = Array.from({ length: reads }, () => rng.int(0, 3 * L));
    const logoutAt = rng.int(0, 3 * L);
    const logoutWith = rng.chance(0.5) ? "old" : "new";
    ctx.inputs = { reads, readOffsets, logoutAt, warmSibling, logoutWith };
    const logoutToken = logoutWith === "old"
      ? me.accessToken
      : rotated.accessToken;
    const otherToken = logoutWith === "old"
      ? rotated.accessToken
      : me.accessToken;

    const lanes: Lane[] = readOffsets.map((at, i) => ({
      name: `read#${i}`,
      at,
      run: () => h.handler(accessRequest(otherToken, ctx.ip(i))),
    }));
    lanes.push({
      name: "logout#0",
      at: logoutAt,
      run: () => h.handler(logoutRequest(logoutToken, ctx.ip(200))),
    });
    const results = await runLanes(lanes);
    ctx.lanes = results;
    noServerErrors(ctx, results);

    const logout = results.find((r) => r.lane === "logout#0")!;
    checks.equal(logout.status, 204, "logout status");
    for (const r of results) {
      if (!r.lane.startsWith("read")) continue;
      checks.that(
        r.status === 200 || r.status === 401,
        `${r.lane}: status ${r.status}`,
      );
      if (r.startedAt >= logout.endedAt) {
        checks.equal(
          r.status,
          401,
          `${r.lane} (sibling token) started after the logout completed`,
        );
      }
    }
    checks.equal(
      sessionOf(h, me.accessToken)?.revoked,
      true,
      "session revoked upstream",
    );
    await expectFenced(
      ctx,
      [
        { label: "sibling bearer", token: otherToken },
        { label: "logged-out bearer", token: logoutToken },
      ],
      [{ label: "live refresh token", token: rotated.refreshToken }],
      100,
    );
    const logoutsBefore = counter(h, "gotrue.logout");
    const siblingLogout = await h.handler(
      logoutRequest(otherToken, ctx.ip(230)),
    );
    await siblingLogout.body?.cancel();
    checks.equal(
      siblingLogout.status,
      401,
      "sibling's own logout after the fence",
    );
    checks.equal(
      counter(h, "gotrue.logout") - logoutsBefore,
      0,
      "upstream calls for sibling logout",
    );
    ctx.observations = { reads: histogram(statusesOf(results, "read")) };
  },
);

scenario(
  "S5 two devices, one user — logout of one never touches the other",
  async (ctx) => {
    const { h, rng, checks } = ctx;
    const sub = rng.uuid();
    const deviceA = await signIn(ctx, 250, sub);
    const deviceB = await signIn(ctx, 251, sub);
    checks.that(
      sessionIdOf(deviceA.accessToken) !== sessionIdOf(deviceB.accessToken),
      "two bootstraps mint two sessions",
    );
    if (rng.chance(0.5)) {
      checks.equal(
        await probe(ctx, deviceB.accessToken, 252),
        200,
        "warm B",
      );
    }
    const readsB = rng.int(3, 8);
    const readsA = rng.int(0, 3);
    const logoutAt = rng.int(0, 3 * L);
    ctx.inputs = { readsA, readsB, logoutAt };

    const lanes: Lane[] = [];
    for (let i = 0; i < readsB; i += 1) {
      lanes.push({
        name: `readB#${i}`,
        at: rng.int(0, 4 * L),
        run: () => h.handler(accessRequest(deviceB.accessToken, ctx.ip(i))),
      });
    }
    for (let i = 0; i < readsA; i += 1) {
      lanes.push({
        name: `readA#${i}`,
        at: rng.int(0, 4 * L),
        run: () =>
          h.handler(accessRequest(deviceA.accessToken, ctx.ip(50 + i))),
      });
    }
    lanes.push({
      name: "logoutA#0",
      at: logoutAt,
      run: () => h.handler(logoutRequest(deviceA.accessToken, ctx.ip(200))),
    });
    const results = await runLanes(lanes);
    ctx.lanes = results;
    noServerErrors(ctx, results);

    checks.equal(
      results.find((r) => r.lane === "logoutA#0")!.status,
      204,
      "device A logout",
    );
    for (const r of results) {
      if (r.lane.startsWith("readB")) {
        checks.equal(
          r.status,
          200,
          `${r.lane} (other device)`,
        );
      }
      if (r.lane.startsWith("readA")) {
        checks.that(
          r.status === 200 || r.status === 401,
          `${r.lane}: status ${r.status}`,
        );
      }
    }
    checks.equal(
      sessionOf(h, deviceA.accessToken)?.revoked,
      true,
      "A revoked upstream",
    );
    checks.equal(
      sessionOf(h, deviceB.accessToken)?.revoked,
      false,
      "B untouched upstream",
    );
    checks.equal(
      await probe(ctx, deviceB.accessToken, 101),
      200,
      "B read after A's logout",
    );
    const rotatedB = await refresh(ctx, deviceB.refreshToken, 102);
    checks.equal(rotatedB.status, 200, "B refresh after A's logout");
    checks.equal(
      await probe(ctx, rotatedB.accessToken, 103),
      200,
      "B rotated bearer works",
    );
    await expectFenced(
      ctx,
      [{ label: "device A bearer", token: deviceA.accessToken }],
      [{ label: "device A refresh token", token: deviceA.refreshToken }],
      110,
    );
    ctx.observations = { readsB: histogram(statusesOf(results, "readB")) };
  },
);

scenario(
  "S6 upstream faults during duplicate logouts — 503 evicts nothing",
  async (ctx) => {
    const { h, rng, checks } = ctx;
    const me = await signIn(ctx, 250);
    if (rng.chance(0.5)) {
      checks.equal(
        await probe(ctx, me.accessToken, 251),
        200,
        "warm-up read",
      );
    }
    const n = rng.int(2, 6);
    const faults: Fault[] = Array.from({ length: n }, () =>
      rng.pick<Fault>([
        "ok",
        "ok",
        "500",
        "502",
        "throw",
        "throw",
        "gone401",
        "gone403",
      ]));
    const offsets = Array.from({ length: n }, () => rng.int(0, 3 * L));
    ctx.inputs = { burst: n, faults, offsets };
    logoutFaultPlan = [...faults];

    const lanes: Lane[] = offsets.map((at, i) => ({
      name: `logout#${i}`,
      at,
      run: () => h.handler(logoutRequest(me.accessToken, ctx.ip(i))),
    }));
    const results = await runLanes(lanes);
    ctx.lanes = results;
    const applied = [...appliedFaults];
    logoutFaultPlan = [];

    const statuses = statusesOf(results, "logout");
    checks.that(
      statuses.every((s) => s === 204 || s === 401 || s === 503),
      `logout statuses ${statuses.join(",")} not all 204/401/503`,
    );
    const failed =
      applied.filter((f) => f === "500" || f === "502" || f === "throw").length;
    const succeeded = applied.filter((f) => f === "ok").length;
    const gone =
      applied.filter((f) => f === "gone401" || f === "gone403").length;
    checks.equal(
      statuses.filter((s) => s === 503).length,
      failed,
      "503 lanes == failed upstream calls",
    );
    checks.equal(
      statuses.filter((s) => s === 204).length,
      succeeded + gone,
      "204 lanes == upstream calls answered 204 or already-gone",
    );
    for (const r of results) {
      if (r.status !== 503) continue;
      checks.equal(
        errorMessageOf(r.body),
        LOGOUT_503_MESSAGE,
        `${r.lane} 503 body is generic`,
      );
      checks.that(
        !/forced|simulated|50[02]/.test(r.body),
        `${r.lane} 503 body leaks upstream detail: ${r.body}`,
      );
      checks.that(r.body.length < 200, `${r.lane} 503 body unexpectedly large`);
    }
    const session = sessionOf(h, me.accessToken);
    if (succeeded > 0) {
      checks.equal(
        session?.revoked,
        true,
        "session revoked upstream (some lane succeeded)",
      );
      await expectFenced(
        ctx,
        [{ label: "bearer", token: me.accessToken }],
        [{ label: "refresh token", token: me.refreshToken }],
        100,
      );
    } else if (gone > 0) {
      // Upstream said the session is already gone: fenced here regardless.
      await expectFenced(
        ctx,
        [{ label: "bearer", token: me.accessToken }],
        [],
        100,
      );
    } else {
      checks.equal(
        session?.revoked,
        false,
        "nothing revoked upstream (every lane failed)",
      );
      checks.equal(
        await probe(ctx, me.accessToken, 101),
        200,
        "bearer still works after 503s",
      );
      const rotated = await refresh(ctx, me.refreshToken, 102);
      checks.equal(rotated.status, 200, "refresh token still works after 503s");
      // …and a retry now signs out for real.
      const retry = await h.handler(logoutRequest(me.accessToken, ctx.ip(103)));
      await retry.body?.cancel();
      checks.equal(retry.status, 204, "retry after 503s");
      checks.equal(
        sessionOf(h, me.accessToken)?.revoked,
        true,
        "retry revoked the session",
      );
      await expectFenced(
        ctx,
        [
          { label: "bearer", token: me.accessToken },
          { label: "rotated bearer", token: rotated.accessToken },
        ],
        [{ label: "rotated refresh token", token: rotated.refreshToken }],
        110,
      );
    }
    ctx.observations = { statuses, applied, failed, succeeded, gone };
  },
);

scenario("S7 client aborts mid-call — state stays consistent", async (ctx) => {
  const { h, rng, checks } = ctx;
  const me = await signIn(ctx, 250);
  const n = rng.int(2, 5);
  const plan = Array.from({ length: n }, () => ({
    at: rng.int(0, 2 * L),
    abortAfter: rng.chance(0.75) ? rng.int(0, 2 * L) : null,
  }));
  ctx.inputs = { burst: n, plan };
  const logoutsBefore = counter(h, "gotrue.logout");

  const lanes: Lane[] = plan.map((p, i) => ({
    name: `logout#${i}`,
    at: p.at,
    run: async () => {
      const controller = new AbortController();
      const pending = h.handler(
        logoutRequest(me.accessToken, ctx.ip(i), controller.signal),
      );
      if (p.abortAfter !== null) {
        await sleep(p.abortAfter);
        controller.abort(new DOMException("client went away", "AbortError"));
      }
      return await pending;
    },
  }));
  lanes.push({
    name: "read#0",
    at: rng.int(0, 2 * L),
    run: () => h.handler(accessRequest(me.accessToken, ctx.ip(100))),
  });
  const results = await runLanes(lanes);
  ctx.lanes = results;
  noServerErrors(ctx, results);

  const statuses = statusesOf(results, "logout");
  const ok = statuses.filter((s) => s === 204).length;
  checks.that(
    statuses.every((s) => s === 204 || s === 401),
    `logout statuses ${statuses.join(",")} not all 204/401`,
  );
  checks.that(ok >= 1, "at least one sign-out completed");
  checks.equal(
    counter(h, "gotrue.logout") - logoutsBefore,
    ok,
    "upstream logout calls == 204 lanes",
  );
  checks.equal(
    sessionOf(h, me.accessToken)?.revoked,
    true,
    "session revoked upstream",
  );
  await expectFenced(
    ctx,
    [{ label: "bearer", token: me.accessToken }],
    [{ label: "refresh token", token: me.refreshToken }],
    110,
  );
  ctx.observations = { statuses, ok };
});

scenario(
  "S8 clock skew around the burst — expired bearers, marker/row TTL edges",
  async (ctx) => {
    const { h, rng, checks } = ctx;
    const me = await signIn(ctx, 250);
    const warmed = rng.chance(0.5);
    if (warmed) {
      checks.equal(await probe(ctx, me.accessToken, 251), 200, "warm-up read");
    }
    const skewMs = rng.pick([
      -300_000,
      -5_000,
      5_000,
      120_000,
      599_000,
      3_601_000,
    ]);
    const skewAt = rng.chance(0.5) ? 0 : rng.int(1, 3 * L);
    const n = rng.int(2, 5);
    const reads = rng.int(1, 4);
    const logoutOffsets = Array.from({ length: n }, () => rng.int(0, 3 * L));
    const readOffsets = Array.from({ length: reads }, () => rng.int(0, 3 * L));
    ctx.inputs = { skewMs, skewAt, warmed, logoutOffsets, readOffsets };
    const logoutsBefore = counter(h, "gotrue.logout");

    let restore: (() => void) | null = null;
    const lanes: Lane[] = [
      {
        name: "clock#0",
        at: skewAt,
        run: () => {
          restore = shiftClock(skewMs);
          return Promise.resolve(new Response(null, { status: 200 }));
        },
      },
      ...logoutOffsets.map((at, i) => ({
        name: `logout#${i}`,
        at,
        run: () => h.handler(logoutRequest(me.accessToken, ctx.ip(i))),
      })),
      ...readOffsets.map((at, i) => ({
        name: `read#${i}`,
        at,
        run: () => h.handler(accessRequest(me.accessToken, ctx.ip(50 + i))),
      })),
    ];
    let results: LaneResult[];
    try {
      results = await runLanes(lanes);
    } finally {
      if (restore) (restore as () => void)();
    }
    ctx.lanes = results.filter((r) => r.lane !== "clock#0");
    noServerErrors(ctx, ctx.lanes);

    const statuses = statusesOf(results, "logout");
    const ok = statuses.filter((s) => s === 204).length;
    checks.that(
      statuses.every((s) => s === 204 || s === 401),
      `logout statuses ${statuses.join(",")} not all 204/401`,
    );
    checks.equal(
      counter(h, "gotrue.logout") - logoutsBefore,
      ok,
      "upstream logout calls == 204 lanes",
    );
    for (const r of results) {
      if (r.lane.startsWith("read")) {
        checks.that(
          r.status === 200 || r.status === 401,
          `${r.lane}: status ${r.status}`,
        );
      }
    }
    const session = sessionOf(h, me.accessToken);
    checks.equal(
      session?.revoked,
      ok > 0,
      "revoked upstream iff some lane got 204",
    );
    if (ok > 0) {
      await expectFenced(
        ctx,
        [{ label: "bearer", token: me.accessToken }],
        [{ label: "refresh token", token: me.refreshToken }],
        100,
      );
    } else {
      // Nothing was revoked: only an expired bearer may have been refused, and
      // with the clock back the session is intact.
      for (const r of results) {
        if (r.lane.startsWith("logout")) {
          checks.equal(
            errorMessageOf(r.body),
            EXPIRED_MESSAGE,
            `${r.lane} refusal reason`,
          );
        }
      }
      checks.equal(
        await probe(ctx, me.accessToken, 101),
        200,
        "bearer still works (clock restored)",
      );
      const rotated = await refresh(ctx, me.refreshToken, 102);
      checks.equal(
        rotated.status,
        200,
        "refresh still works (nothing revoked)",
      );
    }
    ctx.observations = {
      statuses,
      ok,
      reads: histogram(statusesOf(results, "read")),
    };
  },
);

// ── Bounded completion under a stalled upstream ──────────────────────────────
//
// authenticate()/refresh bound every GoTrue round trip by authUpstreamTimeoutMs
// (AUTH_UPSTREAM_TIMEOUT_MS, default 6 s) and answer a retryable 503 when it
// passes. The contract for logout is the same bounded completion: a sign-out
// whose upstream call stalls must be answered inside that deadline (with a
// 503 the app retries) rather than holding the request open for as long as
// the stall lasts.

Deno.test("stress logout S9 stalled upstream — logout is answered within the Auth deadline", async () => {
  const h = await loadXcHarness();
  installFaultWrapper();
  const name = "S9 stalled upstream";
  const seed = roundSeeds(name)[0];
  const deadlineMs = 1_000;
  const stallMs = 2_500;
  const marginMs = 500;
  Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", String(deadlineMs));
  const checks = new Checks();
  const observations: Record<string, unknown> = {};
  const t0 = performance.now();
  try {
    h.fake.reset(seed, 0);
    const rng = new Rng(seed);
    const ip = (lane: number) => laneIp(name, 0, lane);
    const sub = rng.uuid();
    const me = await bootstrap(h, sub, ip(250));
    checks.equal(me.status, 200, "bootstrap");
    const other = await bootstrap(h, rng.uuid(), ip(251));
    checks.equal(other.status, 200, "bootstrap (verification control)");

    // Control: a stalled getUser() is cut off at the deadline with a 503.
    h.fake.overrides.getUserDelayMs = (
      bearer,
    ) => (bearer === other.accessToken ? stallMs : 0);
    const verifyStart = performance.now();
    const verify = await h.handler(accessRequest(other.accessToken, ip(1)));
    await verify.body?.cancel();
    const verifyMs = Math.round(performance.now() - verifyStart);
    checks.equal(verify.status, 503, "stalled verification → 503");
    checks.that(
      verifyMs <= deadlineMs + marginMs,
      `stalled verification answered in ${verifyMs}ms (deadline ${deadlineMs}ms)`,
    );

    // Unit under test: a stalled upstream logout.
    h.fake.overrides.getUserDelayMs = undefined;
    h.fake.overrides.logoutDelayMs = stallMs;
    const logoutStart = performance.now();
    const logout = await h.handler(logoutRequest(me.accessToken, ip(2)));
    await logout.body?.cancel();
    const logoutMs = Math.round(performance.now() - logoutStart);
    observations.verifyMs = verifyMs;
    observations.verifyStatus = verify.status;
    observations.logoutMs = logoutMs;
    observations.logoutStatus = logout.status;
    checks.that(
      logout.status === 204 || logout.status === 503,
      `stalled logout status ${logout.status}`,
    );
    checks.that(
      logoutMs <= deadlineMs + marginMs,
      `stalled logout held the request ${logoutMs}ms — no deadline bounds it (verification: ${verifyMs}ms, deadline ${deadlineMs}ms)`,
    );
    // Let the fake's stalled getUser timer drain so no op leaks past the test.
    const remaining = stallMs + 100 -
      Math.round(performance.now() - verifyStart);
    if (remaining > 0) await sleep(remaining);
  } finally {
    Deno.env.delete("AUTH_UPSTREAM_TIMEOUT_MS");
    h.fake.overrides = {};
  }
  const durationMs = Math.round(performance.now() - t0);
  const outcome = checks.violations.length === 0 ? "HELD" : "BROKEN";
  campaign.add({
    scenario: name,
    round: 0,
    seed,
    outcome,
    durationMs,
    lanes: 2,
    statuses: {
      [`verify:${observations.verifyStatus}`]: 1,
      [`logout:${observations.logoutStatus}`]: 1,
    },
    inputs: { deadlineMs, stallMs, marginMs },
    observations,
    violations: checks.violations,
    replay: replayCommand(FILE, name, seed),
  });
  const path = await campaign.write();
  console.log(`[stress logout] ${name}: ${outcome} → ${path}`);
  assert(
    outcome === "HELD",
    `${checks.violations.join("; ")} — table: ${path}`,
  );
});
