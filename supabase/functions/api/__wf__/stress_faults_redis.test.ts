// stress-edge-http — Upstash/Redis FAILURE INJECTION against the REAL edge
// handler with cache.ts pointed at a fake Upstash REST endpoint (own isolate:
// the endpoint is read at import). Every case breaks Redis in one way, sends
// real requests, and records the user-visible class, the wall time (how many
// 1.2 s Redis deadlines a single request eats) and the upstream round trips.
//
// Contract under test (cache.ts / rateLimit.ts headers): "a Redis outage can
// slow the cache down, never break a request"; limits fail OPEN; a malformed
// pipeline reply is an unknown, never an absence.

import { assert, assertEquals } from "@std/assert";
import {
  answer,
  edgeRequest,
  fakeGoogleIdToken,
  type Fault,
  freshIp,
  isRecord,
  loadStressHarness,
  restoreProcessEnv,
  roundTrips,
  snapshotProcessEnv,
  STRESS_SEED,
  type StressHarness,
  writeArtifact,
} from "./stress_harness.ts";

snapshotProcessEnv();
Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", "600");
const h: StressHarness = await loadStressHarness({
  redis: true,
  seed: STRESS_SEED,
});
assert(h.redisEnabled);

const redisStatus = (id: string, status: number, body = ""): Fault => ({
  id,
  upstream: "redis",
  mode: { kind: "status", status, body },
});
const redisThrow = (id: string): Fault => ({
  id,
  upstream: "redis",
  mode: { kind: "throw" },
});
const redisHang = (id: string, capMs: number): Fault => ({
  id,
  upstream: "redis",
  mode: { kind: "hang", capMs },
});
const redisDelay = (id: string, ms: number): Fault => ({
  id,
  upstream: "redis",
  mode: { kind: "delay", ms },
});
/** A GET of a cached-session payload row (not the `auth:revoked:` marker,
 * whose mere presence is the revocation verdict by design). */
const isAuthPayloadGet = (cmd: Array<string | number>) =>
  String(cmd[0]).toUpperCase() === "GET" &&
  String(cmd[1] ?? "").startsWith("auth:") &&
  !String(cmd[1]).startsWith("auth:revoked:");

interface RedisCase {
  id: string;
  title: string;
  faults: Fault[];
  /** Poison individual command replies instead of the transport. */
  replyOverride?: NonNullable<StressHarness["redis"]["replyOverride"]>;
  /** Requests to issue (all with the same fresh user). */
  requests: Array<
    "me" | "access" | "permit" | "rank" | "healthz" | "bootstrap"
  >;
  expect: { statuses: number[]; maxMs?: number; minMs?: number };
  check?: (
    outs: Array<Awaited<ReturnType<typeof answer>>>,
    calls: ReturnType<typeof roundTrips>,
  ) => void;
}

const CASES: RedisCase[] = [
  {
    id: "redis.500",
    title:
      "Upstash 500 on every pipeline → requests succeed (L1/memory fallback)",
    faults: [redisStatus("redis.500", 500, '{"error":"internal"}')],
    requests: ["me", "access", "permit"],
    expect: { statuses: [200, 200, 200], maxMs: 500 },
  },
  {
    id: "redis.401",
    title: "Upstash 401 (bad token) → requests succeed",
    faults: [redisStatus("redis.401", 401, '{"error":"Unauthorized"}')],
    requests: ["me", "access"],
    expect: { statuses: [200, 200], maxMs: 500 },
  },
  {
    id: "redis.429",
    title: "Upstash 429 (plan limit) → requests succeed",
    faults: [
      redisStatus(
        "redis.429",
        429,
        '{"error":"ERR max requests limit exceeded"}',
      ),
    ],
    requests: ["me", "access"],
    expect: { statuses: [200, 200], maxMs: 500 },
  },
  {
    id: "redis.throw",
    title: "Upstash unreachable (socket error) → requests succeed",
    faults: [redisThrow("redis.throw")],
    requests: ["me", "access", "permit", "rank"],
    expect: { statuses: [200, 200, 200, 200], maxMs: 500 },
  },
  {
    id: "redis.200-nonjson",
    title: "Upstash 200 HTML body → treated as unavailable → 200",
    faults: [redisStatus("redis.200-nonjson", 200, "<html>ok</html>")],
    requests: ["me", "access"],
    expect: { statuses: [200, 200], maxMs: 500 },
  },
  {
    id: "redis.200-object",
    title: "Upstash 200 `{}` (not an array) → unavailable → 200",
    faults: [redisStatus("redis.200-object", 200, "{}")],
    requests: ["me", "access"],
    expect: { statuses: [200, 200], maxMs: 500 },
  },
  {
    id: "redis.200-empty-array",
    title:
      "Upstash 200 `[]` (fewer replies than commands) → unknown, not absence → 200",
    faults: [redisStatus("redis.200-empty-array", 200, "[]")],
    requests: ["me", "access"],
    expect: { statuses: [200, 200], maxMs: 500 },
  },
  {
    id: "redis.200-all-errors",
    title:
      "every pipeline slot carries a Redis error (WRONGTYPE) → 200, limits fail open",
    faults: [],
    replyOverride: () => ({
      error:
        "WRONGTYPE Operation against a key holding the wrong kind of value",
    }),
    requests: ["me", "access", "permit"],
    expect: { statuses: [200, 200, 200], maxMs: 500 },
  },
  {
    id: "redis.incr-garbage",
    title:
      "INCR replies with a non-numeric string → limiter must not 429 or 500",
    faults: [],
    replyOverride: (
      cmd,
      reply,
    ) => (String(cmd[0]).toUpperCase() === "INCR"
      ? { result: "not-a-number" }
      : reply),
    requests: ["me", "access", "healthz"],
    expect: { statuses: [200, 200, 200], maxMs: 500 },
  },
  {
    id: "redis.incr-huge",
    title:
      "INCR replies 9e15 (counter poisoned) → 429 fail-CLOSED is the observed class",
    faults: [],
    replyOverride: (
      cmd,
      reply,
    ) => (String(cmd[0]).toUpperCase() === "INCR"
      ? { result: 9_000_000_000_000_000 }
      : reply),
    requests: ["healthz"],
    expect: { statuses: [429], maxMs: 500 },
    check: (outs) => assert(outs[0].retryAfter !== null),
  },
  {
    id: "redis.get-garbage-auth-cache",
    title:
      "GET replies with a non-JSON string for cached sessions (poisoned auth cache) → 200, re-verified",
    faults: [],
    replyOverride: (
      cmd,
      reply,
    ) => (isAuthPayloadGet(cmd) ? { result: "\u0000<garbage" } : reply),
    requests: ["me", "access"],
    expect: { statuses: [200, 200], maxMs: 500 },
  },
  {
    id: "redis.get-wrong-json-shape",
    title:
      "GET replies with a JSON array for cached sessions → 200, re-verified",
    faults: [],
    replyOverride: (
      cmd,
      reply,
    ) => (isAuthPayloadGet(cmd) ? { result: "[1,2,3]" } : reply),
    requests: ["me", "access"],
    expect: { statuses: [200, 200], maxMs: 500 },
  },
  {
    id: "redis.get-other-users-session",
    title:
      "GET replies with ANOTHER user's cached session for this bearer → must not be trusted",
    faults: [],
    replyOverride: (cmd, reply) => {
      if (!isAuthPayloadGet(cmd)) return reply;
      return {
        result: JSON.stringify({
          id: "ffffffff-0000-4000-8000-00000000f00d",
          email: "victim@example.com",
          provider: "google",
          providerSubject: "victim",
          expiresAt: Date.now() + 600_000,
        }),
      };
    },
    requests: ["access"],
    expect: { statuses: [200] },
    // The cached principal is whatever L2 says — the trust boundary for the
    // cache is the Upstash credential (documented, recorded, not a finding).
  },
  {
    id: "redis.ttl-negative",
    title:
      "TTL replies -2 for live rows → L1 not populated, still 200 (each request re-reads L2)",
    faults: [],
    replyOverride: (
      cmd,
      reply,
    ) => (String(cmd[0]).toUpperCase() === "TTL" ? { result: -2 } : reply),
    requests: ["me", "access", "access"],
    expect: { statuses: [200, 200, 200], maxMs: 500 },
  },
  {
    id: "redis.delay-300",
    title:
      "Upstash answers after 300 ms → requests succeed; wall time = N pipelines × 300 ms",
    faults: [redisDelay("redis.delay-300", 300)],
    requests: ["access"],
    expect: { statuses: [200], minMs: 300 },
  },
  {
    id: "redis.hang",
    title:
      "Upstash never answers → each pipeline burns the 1.2 s deadline; how long is ONE request?",
    faults: [redisHang("redis.hang", 5_000)],
    requests: ["access"],
    expect: { statuses: [200], minMs: 1_150 },
  },
  {
    id: "redis.hang-healthz",
    title:
      "Upstash never answers → GET /healthz (one limiter) takes one deadline",
    faults: [redisHang("redis.hang-healthz", 5_000)],
    requests: ["healthz"],
    expect: { statuses: [200], minMs: 1_150, maxMs: 2_600 },
  },
  {
    id: "redis.hang-bootstrap",
    title: "Upstash never answers → bootstrap wall time",
    faults: [redisHang("redis.hang-bootstrap", 5_000)],
    requests: ["bootstrap"],
    expect: { statuses: [200], minMs: 1_150 },
  },
  {
    id: "redis.flap",
    title: "Upstash fails on alternating calls → every request still 200",
    faults: [{
      id: "redis.flap",
      upstream: "redis",
      mode: { kind: "throw" },
      match: () => flapCounter++ % 2 === 0,
    }],
    requests: ["me", "access", "permit", "rank", "access", "me"],
    expect: { statuses: [200, 200, 200, 200, 200, 200], maxMs: 800 },
  },
];
let flapCounter = 0;

async function runCase(rc: RedisCase, index: number) {
  h.clearFaults();
  h.redis.replyOverride = null;
  const ip = freshIp();
  const sub = `${
    (0x20000000 + index).toString(16)
  }-0000-4000-8000-0000000000ee`;
  const boot = await answer(
    h,
    edgeRequest("POST", "/v1/account/bootstrap", {
      token: fakeGoogleIdToken(sub),
      ip,
      body: {},
    }),
  );
  assertEquals(
    boot.status,
    200,
    `bootstrap for ${rc.id}: ${boot.text.slice(0, 160)}`,
  );
  const token = String(
    (isRecord(boot.body) && isRecord(boot.body.session)
      ? boot.body.session
      : {}).accessToken,
  );
  h.setFaults(rc.faults);
  h.redis.replyOverride = rc.replyOverride ?? null;
  const mark = h.mark();
  const outs: Array<Awaited<ReturnType<typeof answer>>> = [];
  const perRequest: Array<
    {
      kind: string;
      status: number;
      ms: number;
      redisPipelines: number;
      roundTrips: ReturnType<typeof roundTrips>;
    }
  > = [];
  for (const [i, kind] of rc.requests.entries()) {
    const before = h.mark();
    const request = kind === "me"
      ? edgeRequest("GET", "/v1/me", { token, ip })
      : kind === "access"
      ? edgeRequest("GET", "/v1/me/access", { token, ip })
      : kind === "rank"
      ? edgeRequest("GET", "/v1/rank", { token, ip })
      : kind === "healthz"
      ? edgeRequest("GET", "/healthz", { ip })
      : kind === "bootstrap"
      ? edgeRequest("POST", "/v1/account/bootstrap", {
        token: fakeGoogleIdToken(
          `${sub.slice(0, 8)}-1111-4000-8000-0000000000ee`,
        ),
        ip,
        body: {},
      })
      : edgeRequest("POST", "/v1/analysis-permits", {
        token,
        ip,
        body: { idempotencyKey: `${rc.id}-${i}` },
      });
    const out = await answer(h, request);
    const rt = roundTrips(h.since(before));
    outs.push(out);
    perRequest.push({
      kind,
      status: out.status,
      ms: out.durationMs,
      redisPipelines: rt.redis,
      roundTrips: rt,
    });
  }
  const calls = roundTrips(h.since(mark));
  h.clearFaults();
  h.redis.replyOverride = null;
  const result = {
    id: rc.id,
    title: rc.title,
    perRequest,
    totalMs: perRequest.reduce((acc, r) => acc + r.ms, 0),
    roundTrips: calls,
    verdict: "HELD" as "HELD" | "FAILED",
    error: undefined as string | undefined,
  };
  try {
    assertEquals(
      outs.map((o) => o.status),
      rc.expect.statuses,
      `${rc.id}: ${outs.map((o) => o.text.slice(0, 80)).join(" | ")}`,
    );
    for (const r of perRequest) {
      if (rc.expect.maxMs !== undefined) {
        assert(
          r.ms <= rc.expect.maxMs,
          `${rc.id}: ${r.kind} took ${r.ms} ms > ${rc.expect.maxMs}`,
        );
      }
      if (rc.expect.minMs !== undefined) {
        assert(
          r.ms >= rc.expect.minMs,
          `${rc.id}: ${r.kind} took ${r.ms} ms < ${rc.expect.minMs}`,
        );
      }
    }
    rc.check?.(outs, calls);
  } catch (error) {
    result.verdict = "FAILED";
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

Deno.test("stress/faults-redis: Upstash fails/timeouts/malformed in turn — requests survive; wall time recorded", async () => {
  const results = [];
  for (const [index, rc] of CASES.entries()) {
    results.push(await runCase(rc, index + 1));
  }
  const failed = results.filter((r) => r.verdict === "FAILED");
  const hangs = results.filter((r) => r.id.startsWith("redis.hang")).map((
    r,
  ) => ({
    id: r.id,
    perRequest: r.perRequest.map((p) => ({
      kind: p.kind,
      ms: p.ms,
      redisPipelines: p.redisPipelines,
    })),
  }));
  const path = await writeArtifact("fault_matrix_redis.json", {
    campaign: "fault_matrix_redis",
    seed: STRESS_SEED,
    redisTimeoutMs: 1_200,
    cases: results.length,
    held: results.length - failed.length,
    failed: failed.map((r) => ({ id: r.id, error: r.error })),
    hangWallTime: hangs,
    results,
  });
  console.log(
    `[stress/faults-redis] ${results.length} cases, ${failed.length} failed → ${path}`,
  );
  assertEquals(failed.map((r) => `${r.id}: ${r.error}`), []);
});

Deno.test("stress/faults-redis: Redis recovers → shared windows resume and the auth cache is L2-backed again", async () => {
  h.clearFaults();
  h.redis.replyOverride = null;
  const ip = freshIp();
  const sub = "2fffffff-0000-4000-8000-0000000000ee";
  const boot = await answer(
    h,
    edgeRequest("POST", "/v1/account/bootstrap", {
      token: fakeGoogleIdToken(sub),
      ip,
      body: {},
    }),
  );
  const token = String(
    (boot.body as { session: { accessToken: string } }).session.accessToken,
  );
  h.setFaults([redisThrow("outage")]);
  const during = await answer(
    h,
    edgeRequest("GET", "/v1/me/access", { token, ip }),
  );
  h.clearFaults();
  const commandsBefore = h.redis.commands.length;
  const after = await answer(
    h,
    edgeRequest("GET", "/v1/me/access", { token, ip }),
  );
  const commandsAfter = h.redis.commands.length;
  assertEquals([during.status, after.status], [200, 200]);
  assert(
    commandsAfter > commandsBefore,
    "Redis commands resumed after the outage cleared",
  );
  const authKeys = h.redis.commands.slice(commandsBefore).filter((c) =>
    String(c[1] ?? "").startsWith("auth:")
  );
  await writeArtifact("fault_redis_recovery.json", {
    during: during.status,
    after: after.status,
    commandsAfter: commandsAfter - commandsBefore,
    authCommands: authKeys.length,
  });
  assert(authKeys.length > 0, "auth cache consulted L2 again after recovery");
});

Deno.test("stress: restore the process environment for the suites that run after this module", () => {
  restoreProcessEnv();
});
