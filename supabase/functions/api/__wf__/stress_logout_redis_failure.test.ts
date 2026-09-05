// STRESS — POST /v1/auth/logout — Upstash (L2 cache) failure injection.
//
// Lives in its own module because cache.ts reads UPSTASH_* at import time: the
// real handler is booted here WITH the fake Upstash REST endpoint wired
// (sessionHarness `redis: true`) and the stress fault layer answers Redis
// pipelines with HTTP errors / garbage / short replies / per-command errors /
// socket errors / hangs, per operation or across the board.
//
// Contract under test (index.ts fenceRevokedSession + cache.ts): Redis is a
// cache, never a source of truth — a Redis failure must NOT fail the sign-out
// (upstream GoTrue already revoked the session), must NOT sign anyone else out,
// and the calling isolate must still refuse the revoked session from L1. What
// Redis failure DOES cost is the cross-isolate fence: another isolate only
// learns of the revocation through the shared marker. A second real isolate
// (stress_logout_isolate_worker.ts, a Web Worker with its own L1) is seeded
// from this isolate's fake Upstash to measure exactly that.
//
// Reports: artifacts/stress-route-post-v1-auth-logout/latest/redis.json (+ redis_load.json).
// Scale: STRESS_ITER iterations of the matrix (default 1), STRESS_LOAD/4 Redis-backed
// logouts for the round-trip table.

import { assert, assertEquals } from "@std/assert";
import {
  always,
  check,
  drain,
  jsonAnswer,
  loadStressHarness,
  logoutRequest,
  meRequest,
  mintUser,
  percentile,
  Prng,
  redisOp,
  replayCommand,
  siblingToken,
  STRESS_ITER,
  STRESS_LOAD,
  STRESS_SEED,
  textAnswer,
  verdict,
  writeReport,
  type CaseOutcome,
  type Check,
  type Fault,
  type StressHarness,
  type UpstreamCall,
  withAuthUpstreamTimeout,
} from "./stress_logout_harness.ts";
import type { FakeSession } from "./sessionHarness.ts";
import type { IsolateCommand, IsolateReply } from "./stress_logout_isolate_worker.ts";

const FILE = "stress_logout_redis_failure.test.ts";
/** Scoped per test (Deno.env is process-wide across `deno test .` modules). */
const stressTest = (name: string, body: () => Promise<void>) =>
  Deno.test(name, () => withAuthUpstreamTimeout(400, body));
/** cache.ts REDIS_TIMEOUT_MS — a hanging Upstash costs this much per pipeline. */
const REDIS_TIMEOUT_MS = 1_200;
/** apps/mobile sessionLifecycle.ts revokeApiSession() gives the sign-out call 15 s. */
const CLIENT_SIGN_OUT_TIMEOUT_MS = 15_000;

// ── Second isolate (Web Worker) ──────────────────────────────────────────────

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

class Isolate {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, (reply: IsolateReply) => void>();

  constructor() {
    this.worker = new Worker(new URL("./stress_logout_isolate_worker.ts", import.meta.url).href, {
      type: "module",
    });
    this.worker.onmessage = (event: MessageEvent<IsolateReply>) => {
      const resolve = this.pending.get(event.data.id);
      if (resolve) {
        this.pending.delete(event.data.id);
        resolve(event.data);
      }
    };
  }

  private send(command: DistributiveOmit<IsolateCommand, "id">): Promise<IsolateReply> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.worker.postMessage({ ...command, id } as IsolateCommand);
    });
  }

  /** Give the isolate this harness' current Upstash contents + GoTrue users/sessions.
   * GoTrue revokes a SESSION (every access token carrying its session_id); the
   * fake revokes per token object, so sibling copies inherit the revocation here. */
  async seed(s: StressHarness, sessions: FakeSession[]): Promise<void> {
    const revokedSessionIds = new Set(
      sessions.filter((x) => x.revoked).map((x) => s.h.sessionIdOf(x.accessToken)),
    );
    const reply = await this.send({
      type: "seed",
      redis: [...s.h.redis.entries()],
      users: [...s.h.users.values()],
      sessions: sessions.map((x) => ({
        ...x,
        revoked: x.revoked || revokedSessionIds.has(s.h.sessionIdOf(x.accessToken)),
      })),
    });
    if (reply.type === "error") throw new Error(`isolate seed: ${reply.message}`);
  }

  async request(
    request: Request,
  ): Promise<{ status: number; gotrueUserCalls: number; gotrueLogoutCalls: number }> {
    const reply = await this.send({
      type: "request",
      method: request.method,
      url: request.url,
      headers: [...request.headers.entries()],
    });
    if (reply.type !== "response") throw new Error(`isolate request: ${JSON.stringify(reply)}`);
    return reply;
  }

  terminate(): void {
    this.worker.terminate();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

interface Ctx {
  s: StressHarness;
  prng: Prng;
  seed: number;
  isolate: Isolate;
  warnings: string[];
}

interface Subject {
  userId: string;
  token: string;
  sibling: string;
  other: string;
  session: FakeSession;
  siblingSession: FakeSession;
  otherSession: FakeSession;
  sessionId: string;
}

function subject(ctx: Ctx): Subject {
  const { userId, session } = mintUser(ctx.s, ctx.prng);
  const sib = siblingToken(ctx.s, session);
  const other = ctx.s.h.mintSession(userId, 3600);
  return {
    userId,
    token: session.accessToken,
    sibling: sib.accessToken,
    other: other.accessToken,
    session,
    siblingSession: sib,
    otherSession: other,
    sessionId: ctx.s.h.sessionIdOf(session.accessToken),
  };
}

const redisCalls = (calls: UpstreamCall[]) => calls.filter((c) => c.target === "redis");
const gotrueCalls = (calls: UpstreamCall[]) =>
  calls.filter((c) => c.target === "user" || c.target === "logout");

const markerKey = (sessionId: string) => `auth:revoked:${sessionId}`;

async function status(
  ctx: Ctx,
  token: string,
): Promise<{ status: number; gotrue: number; redis: number }> {
  const { value, calls } = await ctx.s.roundTrips(() => ctx.s.h.handler(meRequest(token)));
  await drain(value);
  return {
    status: value.status,
    gotrue: gotrueCalls(calls).length,
    redis: redisCalls(calls).length,
  };
}

async function warm(ctx: Ctx, token: string): Promise<Check> {
  const r = await status(ctx, token);
  return check("warm-up GET /v1/me is 200", r.status === 200, r.status);
}

/** The calling isolate's view after a successful sign-out, whatever Redis did. */
async function fencedLocally(ctx: Ctx, sub: Subject): Promise<Check[]> {
  ctx.s.faults.length = 0;
  const bearer = await status(ctx, sub.token);
  const sib = await status(ctx, sub.sibling);
  const other = await status(ctx, sub.other);
  return [
    check("upstream session revoked", sub.session.revoked === true),
    check("bearer refused (401) at this isolate", bearer.status === 401, bearer.status),
    check("bearer refusal needs no GoTrue call", bearer.gotrue === 0, bearer.gotrue),
    check("sibling refused (401) at this isolate", sib.status === 401, sib.status),
    check("other device still signed in", other.status === 200, other.status),
  ];
}

function markerShared(ctx: Ctx, sub: Subject): boolean {
  const entry = ctx.s.h.redis.get(markerKey(sub.sessionId));
  return entry !== undefined && entry.expiresAtMs > Date.now();
}

const fenceWarning = (ctx: Ctx, sub: Subject) =>
  ctx.warnings.some((w) => w.includes("session fence not shared") && w.includes(sub.sessionId));

const redisThrow = (): Fault => always("redis", () => "throw");
const redisHttp = (statusCode: number): Fault =>
  always("redis", () => textAnswer(statusCode, `{"error":"http ${statusCode}"}`));

interface CaseResult {
  status: number;
  checks: Check[];
  roundTrips: number;
  redisTrips: number;
  elapsedMs: number;
  markerShared: boolean;
}

interface RedisCase {
  id: string;
  title: string;
  run(ctx: Ctx): Promise<CaseResult>;
}

async function logoutWith(
  ctx: Ctx,
  faults: Fault[],
  options: { warm?: boolean } = {},
): Promise<{
  sub: Subject;
  res: Response;
  calls: UpstreamCall[];
  pre: Check[];
  elapsedMs: number;
}> {
  const sub = subject(ctx);
  const pre: Check[] = [];
  if (options.warm) pre.push(await warm(ctx, sub.token));
  ctx.s.faults.push(...faults);
  const t0 = performance.now();
  const { value: res, calls } = await ctx.s.roundTrips(() =>
    ctx.s.h.handler(logoutRequest(sub.token)),
  );
  const elapsedMs = Math.round((performance.now() - t0) * 100) / 100;
  await drain(res);
  ctx.s.faults.length = 0;
  return { sub, res, calls, pre, elapsedMs };
}

/** Redis broken across the board during the sign-out → 204, local fence, warning, no shared marker. */
function redisDownCase(
  id: string,
  title: string,
  fault: () => Fault,
  warmFirst: boolean,
): RedisCase {
  return {
    id,
    title,
    async run(ctx) {
      const { sub, res, calls, pre, elapsedMs } = await logoutWith(ctx, [fault()], {
        warm: warmFirst,
      });
      const checks = [
        ...pre,
        check("sign-out is 204 despite Redis failure", res.status === 204, res.status),
        check(
          "GoTrue logout was called (scope=local)",
          calls.some((c) => c.target === "logout" && c.url.includes("scope=local")),
        ),
        check("≤ 3 GoTrue round trips", gotrueCalls(calls).length <= 3, gotrueCalls(calls).length),
        ...(await fencedLocally(ctx, sub)),
        check("fence-not-shared warning logged", fenceWarning(ctx, sub)),
        check("marker NOT in Redis (it was down)", !markerShared(ctx, sub)),
      ];
      return {
        status: res.status,
        checks,
        roundTrips: gotrueCalls(calls).length,
        redisTrips: redisCalls(calls).length,
        elapsedMs,
        markerShared: markerShared(ctx, sub),
      };
    },
  };
}

const CASES: RedisCase[] = [
  redisDownCase("X01", "Redis socket error on every pipeline (cold)", redisThrow, false),
  redisDownCase("X02", "Redis socket error on every pipeline (warm L1 row)", redisThrow, true),
  redisDownCase("X03", "Redis HTTP 500 (warm)", () => redisHttp(500), true),
  redisDownCase(
    "X04",
    "Redis HTTP 401 (token rotated / unauthorized) (warm)",
    () => redisHttp(401),
    true,
  ),
  redisDownCase("X05", "Redis HTTP 429 (Upstash quota) (warm)", () => redisHttp(429), true),
  redisDownCase(
    "X06",
    "Redis 200 with non-JSON body (warm)",
    () => always("redis", () => textAnswer(200, "<html>upstream</html>", "text/html")),
    true,
  ),
  redisDownCase(
    "X07",
    "Redis 200 with a JSON object instead of the pipeline array (warm)",
    () => always("redis", () => jsonAnswer(200, { result: "OK" })),
    true,
  ),
  redisDownCase(
    "X08",
    "Redis 200 with an EMPTY pipeline reply (short) (warm)",
    () => always("redis", () => jsonAnswer(200, [])),
    true,
  ),
  redisDownCase(
    "X09",
    "Redis per-command errors on every slot (warm)",
    () => ({
      target: "redis",
      answer: ({ commands }) =>
        jsonAnswer(
          200,
          commands.map(() => ({ error: "ERR injected" })),
        ),
    }),
    true,
  ),
  redisDownCase(
    "X10",
    "Redis SET answers a non-OK result (marker write refused) (warm)",
    () => redisOp(["SET"], () => jsonAnswer(200, [{ result: "QUEUED" }])),
    true,
  ),
  {
    id: "X11",
    title:
      "Redis HANGS (every pipeline waits out REDIS_TIMEOUT_MS) → sign-out still completes inside the app's 15 s",
    async run(ctx) {
      const { sub, res, calls, pre, elapsedMs } = await logoutWith(
        ctx,
        [always("redis", () => "hang")],
        { warm: false },
      );
      const pipelines = redisCalls(calls).length;
      const checks = [
        ...pre,
        check("sign-out is 204", res.status === 204, res.status),
        check(
          `answers within the client's ${CLIENT_SIGN_OUT_TIMEOUT_MS} ms sign-out timeout`,
          elapsedMs < CLIENT_SIGN_OUT_TIMEOUT_MS,
          elapsedMs,
        ),
        check(
          `elapsed ≈ pipelines × ${REDIS_TIMEOUT_MS} ms (sequential Redis waits)`,
          elapsedMs >= pipelines * REDIS_TIMEOUT_MS * 0.9,
          { elapsedMs, pipelines },
        ),
        ...(await fencedLocally(ctx, sub)),
        check("fence-not-shared warning logged", fenceWarning(ctx, sub)),
      ];
      return {
        status: res.status,
        checks,
        roundTrips: gotrueCalls(calls).length,
        redisTrips: pipelines,
        elapsedMs,
        markerShared: markerShared(ctx, sub),
      };
    },
  },
  {
    id: "X12",
    title:
      "Redis healthy (control): marker + row deletion land in L2; a COLD second isolate refuses the session with 0 GoTrue calls",
    async run(ctx) {
      const { sub, res, calls, elapsedMs } = await logoutWith(ctx, [], { warm: true });
      await ctx.isolate.seed(ctx.s, [sub.session, sub.siblingSession, sub.otherSession]);
      const bearer = await ctx.isolate.request(meRequest(sub.token));
      const sib = await ctx.isolate.request(meRequest(sub.sibling));
      const other = await ctx.isolate.request(meRequest(sub.other));
      const checks = [
        check("sign-out is 204", res.status === 204, res.status),
        check("marker in Redis", markerShared(ctx, sub)),
        check("no fence warning", !fenceWarning(ctx, sub)),
        ...(await fencedLocally(ctx, sub)),
        check("cold isolate refuses bearer", bearer.status === 401, bearer.status),
        check(
          "cold isolate refuses bearer WITHOUT GoTrue (marker read from L2)",
          bearer.gotrueUserCalls === 0,
          bearer.gotrueUserCalls,
        ),
        check(
          "cold isolate refuses sibling without GoTrue",
          sib.status === 401 && sib.gotrueUserCalls === 0,
          sib,
        ),
        check("cold isolate serves the other device", other.status === 200, other.status),
      ];
      return {
        status: res.status,
        checks,
        roundTrips: gotrueCalls(calls).length,
        redisTrips: redisCalls(calls).length,
        elapsedMs,
        markerShared: true,
      };
    },
  },
  {
    id: "X13",
    title:
      "Redis healthy: a second isolate with a WARM L1 copy of the sibling refuses it on the next request (marker checked before L1 row)",
    async run(ctx) {
      const sub = subject(ctx);
      const pre = await warm(ctx, sub.token);
      await ctx.isolate.seed(ctx.s, [sub.session, sub.siblingSession, sub.otherSession]);
      const warmSib = await ctx.isolate.request(meRequest(sub.sibling));
      const t0 = performance.now();
      const { value: res, calls } = await ctx.s.roundTrips(() =>
        ctx.s.h.handler(logoutRequest(sub.token)),
      );
      const elapsedMs = Math.round((performance.now() - t0) * 100) / 100;
      await drain(res);
      // The isolate keeps its L1 but sees the parent's Redis as it is now.
      await ctx.isolate.seed(ctx.s, []);
      const sib = await ctx.isolate.request(meRequest(sub.sibling));
      const checks = [
        pre,
        check(
          "isolate had the sibling warm (200, 1 GoTrue call)",
          warmSib.status === 200 && warmSib.gotrueUserCalls === 1,
          warmSib,
        ),
        check("sign-out is 204", res.status === 204, res.status),
        check("warm isolate now refuses the sibling", sib.status === 401, sib.status),
        check("… without GoTrue (marker via L2)", sib.gotrueUserCalls === 0, sib.gotrueUserCalls),
        ...(await fencedLocally(ctx, sub)),
      ];
      return {
        status: res.status,
        checks,
        roundTrips: gotrueCalls(calls).length,
        redisTrips: redisCalls(calls).length,
        elapsedMs,
        markerShared: markerShared(ctx, sub),
      };
    },
  },
  {
    id: "X14",
    title:
      "Redis fails only for the marker SET → warning; local fence; a COLD second isolate still refuses (row deleted, GoTrue consulted)",
    async run(ctx) {
      const sub = subject(ctx);
      const before = new Set(ctx.s.h.redis.keys());
      const pre = await warm(ctx, sub.token);
      const rowKeys = [...ctx.s.h.redis.keys()].filter(
        (k) => !before.has(k) && k.startsWith("auth:") && !k.startsWith("auth:revoked:"),
      );
      ctx.s.faults.push(redisOp(["SET"], () => "throw"));
      const t0 = performance.now();
      const { value: res, calls } = await ctx.s.roundTrips(() =>
        ctx.s.h.handler(logoutRequest(sub.token)),
      );
      const elapsedMs = Math.round((performance.now() - t0) * 100) / 100;
      await drain(res);
      ctx.s.faults.length = 0;
      await ctx.isolate.seed(ctx.s, [sub.session, sub.siblingSession, sub.otherSession]);
      const bearer = await ctx.isolate.request(meRequest(sub.token));
      const checks = [
        pre,
        check("warm-up wrote exactly one auth row to L2", rowKeys.length === 1, rowKeys.length),
        check("sign-out is 204", res.status === 204, res.status),
        check("fence-not-shared warning logged", fenceWarning(ctx, sub)),
        check("marker NOT in Redis", !markerShared(ctx, sub)),
        check(
          "the bearer's L2 row was deleted",
          rowKeys.every((k) => !ctx.s.h.redis.has(k)),
        ),
        ...(await fencedLocally(ctx, sub)),
        check("cold isolate refuses the bearer", bearer.status === 401, bearer.status),
        check(
          "… by asking GoTrue (1 call; no marker to read)",
          bearer.gotrueUserCalls === 1,
          bearer.gotrueUserCalls,
        ),
      ];
      return {
        status: res.status,
        checks,
        roundTrips: gotrueCalls(calls).length,
        redisTrips: redisCalls(calls).length,
        elapsedMs,
        markerShared: false,
      };
    },
  },
  {
    id: "X15",
    title:
      "Redis fails only for the row DEL/INCR pipeline → marker shared; a cold isolate refuses via the marker; stale row left behind is harmless",
    async run(ctx) {
      const { sub, res, calls, pre, elapsedMs } = await logoutWith(
        ctx,
        [redisOp(["DEL"], () => "throw")],
        { warm: true },
      );
      await ctx.isolate.seed(ctx.s, [sub.session, sub.siblingSession, sub.otherSession]);
      const bearer = await ctx.isolate.request(meRequest(sub.token));
      const checks = [
        ...pre,
        check("sign-out is 204", res.status === 204, res.status),
        check("marker in Redis", markerShared(ctx, sub)),
        check("no fence warning", !fenceWarning(ctx, sub)),
        ...(await fencedLocally(ctx, sub)),
        check("cold isolate refuses the bearer", bearer.status === 401, bearer.status),
        check(
          "… without GoTrue (marker wins over the leftover row)",
          bearer.gotrueUserCalls === 0,
          bearer.gotrueUserCalls,
        ),
      ];
      return {
        status: res.status,
        checks,
        roundTrips: gotrueCalls(calls).length,
        redisTrips: redisCalls(calls).length,
        elapsedMs,
        markerShared: true,
      };
    },
  },
  {
    id: "X16",
    title:
      "Redis DOWN during the sign-out, back afterwards: a COLD second isolate serves the revoked session from the surviving L2 row (documented degradation, ≤ AUTH_CACHE_MAX_TTL)",
    async run(ctx) {
      const { sub, res, calls, pre, elapsedMs } = await logoutWith(ctx, [redisThrow()], {
        warm: true,
      });
      await ctx.isolate.seed(ctx.s, [sub.session, sub.siblingSession, sub.otherSession]);
      const bearer = await ctx.isolate.request(meRequest(sub.token));
      const sib = await ctx.isolate.request(meRequest(sub.sibling));
      const checks = [
        ...pre,
        check("sign-out is 204", res.status === 204, res.status),
        check("fence-not-shared warning logged", fenceWarning(ctx, sub)),
        ...(await fencedLocally(ctx, sub)),
        // Documented: fenceRevokedSession() — "other isolates' cached
        // verifications of it age out on their own (≤ AUTH_CACHE_MAX_TTL_SECONDS)".
        // Recorded, not asserted either way: the row is what the code says it is.
        check("[observed] cold isolate answer for the revoked bearer", true, {
          status: bearer.status,
          gotrue: bearer.gotrueUserCalls,
        }),
        check("[observed] cold isolate answer for the sibling (never cached anywhere)", true, {
          status: sib.status,
          gotrue: sib.gotrueUserCalls,
        }),
        check(
          "sibling (never cached) IS refused by the cold isolate via GoTrue",
          sib.status === 401 && sib.gotrueUserCalls === 1,
          sib,
        ),
      ];
      return {
        status: res.status,
        checks,
        roundTrips: gotrueCalls(calls).length,
        redisTrips: redisCalls(calls).length,
        elapsedMs,
        markerShared: false,
      };
    },
  },
  {
    id: "X17",
    title:
      "Redis flaps (every other pipeline fails) across N seeded sign-outs → every sign-out 204 and locally fenced",
    async run(ctx) {
      const n = 6;
      let flip = ctx.prng.chance(0.5);
      ctx.s.faults.push({
        target: "redis",
        answer: () => {
          flip = !flip;
          return flip ? "throw" : null;
        },
      });
      const checks: Check[] = [];
      let redisTrips = 0;
      let roundTrips = 0;
      let elapsedMs = 0;
      let shared = 0;
      for (let i = 0; i < n; i += 1) {
        const sub = subject(ctx);
        if (ctx.prng.chance(0.5)) checks.push(await warm(ctx, sub.token));
        const t0 = performance.now();
        const { value: res, calls } = await ctx.s.roundTrips(() =>
          ctx.s.h.handler(logoutRequest(sub.token)),
        );
        elapsedMs += performance.now() - t0;
        await drain(res);
        checks.push(check(`sign-out #${i} is 204`, res.status === 204, res.status));
        redisTrips = Math.max(redisTrips, redisCalls(calls).length);
        roundTrips = Math.max(roundTrips, gotrueCalls(calls).length);
        if (markerShared(ctx, sub)) shared += 1;
        // Local fence must hold even while Redis keeps flapping.
        const bearer = await status(ctx, sub.token);
        checks.push(check(`bearer #${i} refused locally`, bearer.status === 401, bearer.status));
        checks.push(
          check(`bearer #${i} refusal needs no GoTrue`, bearer.gotrue === 0, bearer.gotrue),
        );
      }
      ctx.s.faults.length = 0;
      checks.push(
        check("[observed] markers that reached Redis while flapping", true, `${shared}/${n}`),
      );
      return {
        status: 204,
        checks,
        roundTrips,
        redisTrips,
        elapsedMs: Math.round(elapsedMs / n),
        markerShared: shared === n,
      };
    },
  },
  {
    id: "X18",
    title:
      "Marker already in Redis (another isolate signed this session out) → this isolate refuses bearer AND its logout without GoTrue",
    async run(ctx) {
      const sub = subject(ctx);
      ctx.s.h.redis.set(markerKey(sub.sessionId), {
        value: "1",
        expiresAtMs: Date.now() + 600_000,
      });
      const me = await status(ctx, sub.token);
      const t0 = performance.now();
      const { value: res, calls } = await ctx.s.roundTrips(() =>
        ctx.s.h.handler(logoutRequest(sub.token)),
      );
      const elapsedMs = Math.round((performance.now() - t0) * 100) / 100;
      await drain(res);
      const other = await status(ctx, sub.other);
      const checks = [
        check("GET /v1/me refused (401)", me.status === 401, me.status),
        check("… without GoTrue", me.gotrue === 0, me.gotrue),
        check(
          "logout of the fenced bearer answers 401 (nothing to revoke)",
          res.status === 401,
          res.status,
        ),
        check(
          "… without a GoTrue logout call",
          !calls.some((c) => c.target === "logout"),
          calls.map((c) => c.target),
        ),
        check("other device untouched", other.status === 200, other.status),
      ];
      return {
        status: res.status,
        checks,
        roundTrips: gotrueCalls(calls).length,
        redisTrips: redisCalls(calls).length,
        elapsedMs,
        markerShared: true,
      };
    },
  },
  {
    id: "X19",
    title:
      "Redis GET answers a NUMBER where a marker string is expected → not treated as revoked; sign-out proceeds normally",
    async run(ctx) {
      const { sub, res, calls, pre, elapsedMs } = await logoutWith(
        ctx,
        [redisOp(["GET"], () => jsonAnswer(200, [{ result: 1 }, { result: 1 }, { result: 1 }]))],
        { warm: false },
      );
      const checks = [
        ...pre,
        check("sign-out is 204", res.status === 204, res.status),
        check(
          "GoTrue logout called",
          calls.some((c) => c.target === "logout"),
        ),
        ...(await fencedLocally(ctx, sub)),
      ];
      return {
        status: res.status,
        checks,
        roundTrips: gotrueCalls(calls).length,
        redisTrips: redisCalls(calls).length,
        elapsedMs,
        markerShared: markerShared(ctx, sub),
      };
    },
  },
  {
    id: "X20",
    title:
      "Redis slow (250 ms per pipeline, healthy) → 204; Redis round trips per sign-out recorded",
    async run(ctx) {
      const { sub, res, calls, pre, elapsedMs } = await logoutWith(
        ctx,
        [{ target: "redis", answer: () => null, delayMs: 250 }],
        { warm: false },
      );
      const pipelines = redisCalls(calls).length;
      const checks = [
        ...pre,
        check("sign-out is 204", res.status === 204, res.status),
        check("marker in Redis", markerShared(ctx, sub)),
        check(
          "elapsed ≈ pipelines × 250 ms (Redis calls are sequential on this path)",
          elapsedMs >= pipelines * 250 * 0.9,
          { elapsedMs, pipelines },
        ),
        ...(await fencedLocally(ctx, sub)),
      ];
      return {
        status: res.status,
        checks,
        roundTrips: gotrueCalls(calls).length,
        redisTrips: pipelines,
        elapsedMs,
        markerShared: true,
      };
    },
  },
];

// ── Runner ───────────────────────────────────────────────────────────────────

interface RedisOutcome extends CaseOutcome {
  redisTrips: number;
  elapsedMs: number;
  markerShared: boolean;
}

async function withCtx<T>(iteration: number, run: (ctx: Ctx) => Promise<T>): Promise<T> {
  const s = await loadStressHarness({ redis: true });
  const seed = STRESS_SEED + iteration;
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    originalWarn(...args);
  };
  const isolate = new Isolate();
  try {
    return await run({ s, prng: new Prng(seed), seed, isolate, warnings });
  } finally {
    console.warn = originalWarn;
    isolate.terminate();
    s.faults.length = 0;
  }
}

stressTest(
  `stress redis: ${CASES.length} Upstash fault cases × STRESS_ITER=${STRESS_ITER}`,
  async () => {
    const rows: RedisOutcome[] = [];
    for (let i = 0; i < STRESS_ITER; i += 1) {
      await withCtx(i, async (ctx) => {
        for (const c of ctx.prng.shuffle(CASES)) {
          ctx.s.faults.length = 0;
          ctx.warnings.length = 0;
          let result: CaseResult;
          try {
            result = await c.run(ctx);
          } catch (error) {
            result = {
              status: 0,
              checks: [
                check("case threw", false, error instanceof Error ? error.message : String(error)),
              ],
              roundTrips: 0,
              redisTrips: 0,
              elapsedMs: 0,
              markerShared: false,
            };
          }
          ctx.s.faults.length = 0;
          const v = verdict(result.checks);
          rows.push({
            seed: ctx.seed,
            case: c.id,
            verdict: v.held ? "HELD" : "BROKEN",
            status: result.status,
            roundTrips: result.roundTrips,
            redisTrips: result.redisTrips,
            elapsedMs: result.elapsedMs,
            markerShared: result.markerShared,
            detail: `${c.title} — ${v.detail}`,
            replay: replayCommand(FILE, "stress redis", ctx.seed),
          });
          if (c.id === "X16") {
            const observed = result.checks
              .filter((k) => k.name.startsWith("[observed]"))
              .map((k) => `${k.name}: ${JSON.stringify(k.got)}`);
            rows[rows.length - 1].detail += ` | ${observed.join(" | ")}`;
          }
        }
      });
    }
    const broken = rows.filter((r) => r.verdict === "BROKEN");
    const path = await writeReport("redis", {
      file: FILE,
      seedBase: STRESS_SEED,
      iterations: STRESS_ITER,
      cases: CASES.length,
      executed: rows.length,
      held: rows.length - broken.length,
      broken: broken.length,
      maxGotrueRoundTrips: Math.max(...rows.map((r) => r.roundTrips)),
      maxRedisPipelinesPerSignOut: Math.max(...rows.map((r) => r.redisTrips)),
      rows,
    });
    console.log(`[stress] redis: ${rows.length} executed, ${broken.length} BROKEN → ${path}`);
    for (const r of broken)
      console.log(`[stress]   BROKEN seed=${r.seed} case=${r.case}: ${r.detail}`);
    assertEquals(
      broken.map((r) => `${r.seed}/${r.case}: ${r.detail}`),
      [],
      "BROKEN redis cases",
    );
  },
);

stressTest(
  `stress redis load: ${Math.max(25, Math.floor(STRESS_LOAD / 4))} Redis-backed sign-outs → latency + Redis/GoTrue round trips`,
  async () => {
    const n = Math.max(25, Math.floor(STRESS_LOAD / 4));
    await withCtx(1_000, async (ctx) => {
      const cold: number[] = [];
      const warmed: number[] = [];
      const redisTrips: Record<string, number> = {};
      const gotrueTrips: Record<string, number> = {};
      const statuses: Record<string, number> = {};
      const traces: Record<string, string[]> = {};
      for (let i = 0; i < n; i += 1) {
        const sub = subject(ctx);
        const isWarm = i % 2 === 1;
        if (isWarm) await warm(ctx, sub.token);
        const t0 = performance.now();
        const { value: res, calls } = await ctx.s.roundTrips(() =>
          ctx.s.h.handler(logoutRequest(sub.token)),
        );
        const ms = performance.now() - t0;
        await drain(res);
        (isWarm ? warmed : cold).push(ms);
        statuses[res.status] = (statuses[res.status] ?? 0) + 1;
        const r = redisCalls(calls).length;
        const g = gotrueCalls(calls).length;
        redisTrips[r] = (redisTrips[r] ?? 0) + 1;
        gotrueTrips[g] = (gotrueTrips[g] ?? 0) + 1;
        traces[isWarm ? "warm" : "cold"] ??= calls.map((c) =>
          c.target === "redis"
            ? `redis ${(c.commands ?? []).join(",")}`
            : `${c.target} ${c.method} ${new URL(c.url).pathname}`,
        );
        assert(res.status === 204, `sign-out #${i} answered ${res.status}`);
        assert(markerShared(ctx, sub), `marker missing for sign-out #${i}`);
      }
      cold.sort((a, b) => a - b);
      warmed.sort((a, b) => a - b);
      const path = await writeReport("redis_load", {
        file: FILE,
        seed: ctx.seed,
        executed: n,
        statuses,
        cold: {
          n: cold.length,
          p50: percentile(cold, 50),
          p95: percentile(cold, 95),
          max: cold.at(-1),
        },
        warm: {
          n: warmed.length,
          p50: percentile(warmed, 50),
          p95: percentile(warmed, 95),
          max: warmed.at(-1),
        },
        redisPipelinesPerSignOut: redisTrips,
        gotrueCallsPerSignOut: gotrueTrips,
        /** Upstream call sequence of the first cold / first warm sign-out. */
        traces,
        fakeRedisKeys: ctx.s.h.redis.size,
      });
      console.log(
        `[stress] redis load: ${n} sign-outs; cold p50=${percentile(cold, 50)}ms p95=${percentile(cold, 95)}ms; redis pipelines/sign-out ${JSON.stringify(redisTrips)}; gotrue ${JSON.stringify(gotrueTrips)} → ${path}`,
      );
      assert(
        Object.keys(gotrueTrips).every((k) => Number(k) <= 3),
        `GoTrue round trips per sign-out ${JSON.stringify(gotrueTrips)}`,
      );
    });
  },
);
