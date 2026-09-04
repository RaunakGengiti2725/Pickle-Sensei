// Concurrency stress campaign for POST /v1/auth/logout with the SHARED cache
// tier on: the real edge handler over sessionHarness.ts (stateful fake GoTrue
// + fake Upstash REST), so the revocation fence is published to L2 and every
// authenticated read pays the L2 round trip that widens the race windows
// (getUser() verdict → revocation re-check → cache write). Own module because
// cache.ts reads UPSTASH_* at import time.
//
// On top of the seeded lane offsets and upstream latency, each round draws a
// Redis fault rate: a faulted pipeline call is answered HTTP 500 or fails at
// the socket. The contract (cache.ts header, fenceRevokedSession): a Redis
// outage may slow a request down, never break it or sign anyone out —
// logout stays 204 with the session fenced at least in this isolate, and
// with Redis healthy the marker `auth:revoked:<session_id>` is in L2 with a
// TTL that outlives any cached verification.
//
// Companion of stress_route_post_v1_auth_logout_concurrency.test.ts (same
// knobs: STRESS_ITER, STRESS_SEED, STRESS_SEEDS, STRESS_LATENCY_MS,
// STRESS_OUT_DIR); results in
// artifacts/stress-route-post-v1-auth-logout-concurrency/latest/
// stress_route_post_v1_auth_logout_concurrency_redis.json.

import { assertEquals } from "@std/assert";
import {
  apiRequest,
  loadSessionHarness,
  REDIS_URL,
  type SessionHarness,
} from "./sessionHarness.ts";
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
  sleep,
  STRESS_LATENCY_MS,
} from "./stress_logout_support.ts";

const FILE = "stress_route_post_v1_auth_logout_concurrency_redis.test.ts";
const campaign = new Campaign(FILE);
const REVOKED_MESSAGE = "The session is no longer valid. Sign in again.";
const REVOCATION_TTL_SECONDS = 600 + 60;

// ── Seeded latency + Redis faults in front of the session fake ──────────────

interface WirePlan {
  rng: Rng;
  latencyMs: number;
  redisFaultRate: number;
  redisFaults: number;
  redisCalls: number;
}
let wire: WirePlan = {
  rng: new Rng(1),
  latencyMs: 0,
  redisFaultRate: 0,
  redisFaults: 0,
  redisCalls: 0,
};
let wrapperInstalled = false;

function installWire(): void {
  if (wrapperInstalled) return;
  wrapperInstalled = true;
  const inner = globalThis.fetch;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const isRedis = request.url.startsWith(REDIS_URL);
    if (isRedis) wire.redisCalls += 1;
    if (wire.latencyMs > 0) await sleep(wire.rng.int(0, wire.latencyMs));
    if (
      isRedis && wire.redisFaultRate > 0 &&
      wire.rng.chance(wire.redisFaultRate)
    ) {
      wire.redisFaults += 1;
      if (wire.rng.chance(0.5)) {
        throw new TypeError("stress: redis unreachable");
      }
      return new Response("upstream error", { status: 500 });
    }
    return inner(request);
  }) as typeof fetch;
}

// ── Round plumbing ───────────────────────────────────────────────────────────

interface Ctx {
  h: SessionHarness;
  rng: Rng;
  seed: number;
  round: number;
  checks: Checks;
  inputs: Record<string, unknown>;
  observations: Record<string, unknown>;
  lanes: LaneResult[];
  ip(lane: number): string;
}

const logoutRequest = (token: string, ip: string): Request =>
  apiRequest("POST", "/v1/auth/logout", { token, ip });
const meRequest = (token: string, ip: string): Request =>
  apiRequest("GET", "/v1/me", { token, ip });
const refreshRequest = (refreshToken: string, ip: string): Request =>
  apiRequest("POST", "/v1/auth/refresh", {
    token: null,
    ip,
    body: { refreshToken },
  });

function newUser(ctx: Ctx): string {
  const id = ctx.rng.uuid();
  ctx.h.registerUser({
    id,
    email: `${id.slice(0, 8)}@example.com`,
    provider: "google",
  });
  return id;
}

async function probe(ctx: Ctx, token: string, lane: number): Promise<number> {
  const response = await ctx.h.handler(meRequest(token, ctx.ip(lane)));
  await response.body?.cancel();
  return response.status;
}

async function refresh(
  ctx: Ctx,
  refreshToken: string,
  lane: number,
): Promise<number> {
  const response = await ctx.h.handler(
    refreshRequest(refreshToken, ctx.ip(lane)),
  );
  await response.body?.cancel();
  return response.status;
}

const getUserCalls = (h: SessionHarness): number =>
  h.callsTo("/auth/v1/user").length;
const logoutCalls = (h: SessionHarness): number =>
  h.callsTo("/auth/v1/logout").length;

function redisMarker(h: SessionHarness, sessionId: string) {
  return h.redis.get(`auth:revoked:${sessionId}`) ?? null;
}
function redisAuthRowsFor(h: SessionHarness, token: string): number {
  let n = 0;
  for (const entry of h.redis.values()) {
    if (entry.value.includes(`"accessToken":"${token}"`)) n += 1;
  }
  return n;
}

async function expectFenced(
  ctx: Ctx,
  tokens: Array<{ label: string; token: string }>,
  refreshTokens: Array<{ label: string; token: string }>,
  laneBase: number,
): Promise<void> {
  let lane = laneBase;
  for (const { label, token } of tokens) {
    const before = getUserCalls(ctx.h);
    for (let i = 0; i < 2; i += 1) {
      ctx.checks.equal(
        await probe(ctx, token, lane += 1),
        401,
        `${label} probe ${i + 1}`,
      );
    }
    ctx.checks.equal(
      getUserCalls(ctx.h) - before,
      0,
      `${label}: GoTrue re-verifications after logout`,
    );
  }
  for (const { label, token } of refreshTokens) {
    ctx.checks.equal(
      await refresh(ctx, token, lane += 1),
      401,
      `${label} refresh after logout`,
    );
  }
}

function noServerErrors(ctx: Ctx, results: LaneResult[]): void {
  for (const r of results) {
    ctx.checks.that(
      r.status < 500,
      `${r.lane}: 5xx ${r.status} ${r.body.slice(0, 120)}`,
    );
  }
}

const statusesOf = (results: LaneResult[], prefix: string): number[] =>
  results.filter((r) => r.lane.startsWith(prefix)).map((r) => r.status);

function scenario(name: string, run: (ctx: Ctx) => Promise<void>): void {
  Deno.test(`stress logout redis ${name}`, async () => {
    const h = await loadSessionHarness({ redis: true });
    installWire();
    const seeds = roundSeeds(name);
    const failing: number[] = [];
    for (const [round, seed] of seeds.entries()) {
      h.reset();
      const rng = new Rng((seed ^ fnv1a(name)) >>> 0);
      const redisFaultRate = rng.pick([0, 0, 0, 0.25, 0.5, 1]);
      wire = {
        rng: new Rng((seed ^ 0x5bd1e995) >>> 0),
        latencyMs: STRESS_LATENCY_MS,
        redisFaultRate,
        redisFaults: 0,
        redisCalls: 0,
      };
      const ctx: Ctx = {
        h,
        rng,
        seed,
        round,
        checks: new Checks(),
        inputs: { redisFaultRate },
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
      if (outcome === "BROKEN") failing.push(seed);
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
        observations: {
          ...ctx.observations,
          redisCalls: wire.redisCalls,
          redisFaults: wire.redisFaults,
          getUserCalls: getUserCalls(h),
          logoutCalls: logoutCalls(h),
        },
        violations: ctx.checks.violations,
        replay: replayCommand(FILE, name, seed),
      });
    }
    wire = { ...wire, latencyMs: 0, redisFaultRate: 0 };
    const path = await campaign.write();
    console.log(
      `[stress logout redis] ${name}: ${seeds.length} rounds, ${failing.length} broken → ${path}`,
    );
    assertEquals(
      failing.length,
      0,
      `${failing.length}/${seeds.length} rounds violated the logout contract — seeds ${
        failing.join(", ")
      }; table: ${path}`,
    );
  });
}

const L = Math.max(1, STRESS_LATENCY_MS);

// ── Scenarios ────────────────────────────────────────────────────────────────

scenario(
  "R1 duplicate logout burst with Redis latency and faults",
  async (ctx) => {
    const { h, rng, checks } = ctx;
    const user = newUser(ctx);
    const me = h.mintSession(user);
    const sessionId = h.sessionIdOf(me.accessToken);
    const warmed = rng.chance(0.6);
    if (warmed) {
      checks.equal(
        await probe(ctx, me.accessToken, 251),
        200,
        "warm-up read",
      );
    }
    const n = rng.int(2, 8);
    const offsets = Array.from({ length: n }, () => rng.int(0, 3 * L));
    ctx.inputs = { ...ctx.inputs, burst: n, offsets, warmed };
    const logoutsBefore = logoutCalls(h);

    const results = await runLanes(
      offsets.map((at, i): Lane => ({
        name: `logout#${i}`,
        at,
        run: () => h.handler(logoutRequest(me.accessToken, ctx.ip(i))),
      })),
    );
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
      logoutCalls(h) - logoutsBefore,
      ok,
      "upstream logout calls == 204 lanes",
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
      h.sessions.get(me.accessToken)?.revoked,
      true,
      "session revoked upstream",
    );

    const faultsDuringBurst = wire.redisFaults;
    if (faultsDuringBurst === 0) {
      const marker = redisMarker(h, sessionId);
      checks.that(marker !== null, "revocation marker published to Redis");
      if (marker) {
        const ttl = (marker.expiresAtMs - Date.now()) / 1000;
        checks.that(
          ttl > REVOCATION_TTL_SECONDS - 5 && ttl <= REVOCATION_TTL_SECONDS,
          `marker TTL ${
            ttl.toFixed(1)
          }s (expected ≈${REVOCATION_TTL_SECONDS}s)`,
        );
      }
      checks.equal(
        redisAuthRowsFor(h, me.accessToken),
        0,
        "bearer's auth row left in Redis",
      );
    }
    // From here the wire is healthy: the fence must hold whether or not it
    // reached L2 (L1 has it either way in this isolate).
    wire.redisFaultRate = 0;
    await expectFenced(
      ctx,
      [{ label: "bearer", token: me.accessToken }],
      [{ label: "refresh token", token: me.refreshToken }],
      100,
    );
    ctx.observations = {
      statuses,
      ok,
      faultsDuringBurst,
      markerInRedis: redisMarker(h, sessionId) !== null,
    };
  },
);

scenario(
  "R2 logout during in-flight reads — L2 round trips widen the verify→cache window",
  async (ctx) => {
    const { h, rng, checks } = ctx;
    const user = newUser(ctx);
    const me = h.mintSession(user);
    const sessionId = h.sessionIdOf(me.accessToken);
    const reads = rng.int(3, 10);
    const readOffsets = Array.from({ length: reads }, () => rng.int(0, 4 * L));
    const logoutAt = rng.int(0, 4 * L);
    ctx.inputs = { ...ctx.inputs, reads, readOffsets, logoutAt };

    const lanes: Lane[] = readOffsets.map((at, i) => ({
      name: `read#${i}`,
      at,
      run: () => h.handler(meRequest(me.accessToken, ctx.ip(i))),
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
      h.sessions.get(me.accessToken)?.revoked,
      true,
      "session revoked upstream",
    );
    const faultsDuringBurst = wire.redisFaults;
    const rowsAfterRace = redisAuthRowsFor(h, me.accessToken);
    const markerInRedis = redisMarker(h, sessionId) !== null;
    if (faultsDuringBurst === 0) {
      checks.that(markerInRedis, "revocation marker published to Redis");
    }
    // A row re-cached in L2 after the DEL is only safe for OTHER isolates when
    // the marker made it to L2 as well.
    if (rowsAfterRace > 0 && faultsDuringBurst === 0) {
      checks.that(
        markerInRedis,
        "bearer re-cached in Redis after the fence without a marker",
      );
    }
    wire.redisFaultRate = 0;
    await expectFenced(
      ctx,
      [{ label: "bearer", token: me.accessToken }],
      [{ label: "refresh token", token: me.refreshToken }],
      100,
    );
    ctx.observations = {
      reads: histogram(statusesOf(results, "read")),
      faultsDuringBurst,
      markerInRedis,
      // A read that raced the fence may have re-cached the bearer AFTER the
      // DEL; the marker is what refuses it.
      authRowsRecachedAfterFence: rowsAfterRace,
    };
  },
);

scenario(
  "R3 sibling access token of the same session under L2",
  async (ctx) => {
    const { h, rng, checks } = ctx;
    const user = newUser(ctx);
    const first = h.mintSession(user);
    const sessionId = h.sessionIdOf(first.accessToken);
    const sibling = h.mintSession(user, 3600, { sessionId });
    const warmSibling = rng.chance(0.6);
    if (warmSibling) {
      checks.equal(
        await probe(ctx, sibling.accessToken, 251),
        200,
        "warm sibling",
      );
    }
    const reads = rng.int(2, 6);
    const readOffsets = Array.from({ length: reads }, () => rng.int(0, 3 * L));
    const logoutAt = rng.int(0, 3 * L);
    ctx.inputs = { ...ctx.inputs, reads, readOffsets, logoutAt, warmSibling };

    const lanes: Lane[] = readOffsets.map((at, i) => ({
      name: `read#${i}`,
      at,
      run: () => h.handler(meRequest(sibling.accessToken, ctx.ip(i))),
    }));
    lanes.push({
      name: "logout#0",
      at: logoutAt,
      run: () => h.handler(logoutRequest(first.accessToken, ctx.ip(200))),
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
          `${r.lane} (sibling) started after the logout completed`,
        );
      }
    }
    checks.equal(
      h.sessions.get(first.accessToken)?.revoked,
      true,
      "session revoked upstream",
    );
    // scope=local in the fake revokes exactly the bearer's session row; the
    // sibling row shares the session_id and is refused by the edge fence.
    wire.redisFaultRate = 0;
    await expectFenced(
      ctx,
      [
        { label: "sibling bearer", token: sibling.accessToken },
        { label: "logged-out bearer", token: first.accessToken },
      ],
      [{ label: "refresh token", token: first.refreshToken }],
      100,
    );
    ctx.observations = {
      reads: histogram(statusesOf(results, "read")),
      faults: wire.redisFaults,
    };
  },
);

scenario(
  "R4 two devices, one user, shared cache — scope=local holds",
  async (ctx) => {
    const { h, rng, checks } = ctx;
    const user = newUser(ctx);
    const deviceA = h.mintSession(user);
    const deviceB = h.mintSession(user);
    if (rng.chance(0.5)) {
      checks.equal(
        await probe(ctx, deviceB.accessToken, 252),
        200,
        "warm B",
      );
    }
    const readsB = rng.int(3, 8);
    const logoutAt = rng.int(0, 3 * L);
    ctx.inputs = { ...ctx.inputs, readsB, logoutAt };

    const lanes: Lane[] = [];
    for (let i = 0; i < readsB; i += 1) {
      lanes.push({
        name: `readB#${i}`,
        at: rng.int(0, 4 * L),
        run: () => h.handler(meRequest(deviceB.accessToken, ctx.ip(i))),
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
    }
    checks.equal(
      h.sessions.get(deviceA.accessToken)?.revoked,
      true,
      "A revoked upstream",
    );
    checks.equal(
      h.sessions.get(deviceB.accessToken)?.revoked,
      false,
      "B untouched upstream",
    );
    wire.redisFaultRate = 0;
    checks.equal(
      await probe(ctx, deviceB.accessToken, 101),
      200,
      "B read after A's logout",
    );
    checks.equal(
      await refresh(ctx, deviceB.refreshToken, 102),
      200,
      "B refresh after A's logout",
    );
    await expectFenced(
      ctx,
      [{ label: "device A bearer", token: deviceA.accessToken }],
      [{ label: "device A refresh token", token: deviceA.refreshToken }],
      110,
    );
    ctx.observations = {
      readsB: histogram(statusesOf(results, "readB")),
      faults: wire.redisFaults,
    };
  },
);
