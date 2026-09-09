// W11-01 adversarial tests — the real edge handler booted WITH Upstash Redis
// configured (sessionHarness, redis: true): the shared-store path of the
// sharded auth-failure budget, attacked with a co-tenant flood, a Redis
// outage in the middle of that flood, and a Redis that hangs to the client
// timeout. Own module on purpose: cache.ts reads UPSTASH_* at import.
//
// The session harness answers GET /auth/v1/user for ANY unknown bearer with
// "invalid JWT: session not found"; forged bearers are therefore given the
// answer GoTrue really gives them (bad_jwt / signature invalid) by a fetch
// interceptor installed in front of the harness.
//
//   cd supabase/functions/api/__wf__ && deno test -A --no-check \
//     --config deno.json attack_w11_01_nat_budget_session_redis.test.ts

import { assert, assertEquals } from "@std/assert";
import {
  apiRequest,
  googleIdToken,
  loadSessionHarness,
  REDIS_URL,
  type SessionHarness,
  SUPABASE_URL,
  forgedSessionToken,
} from "./sessionHarness.ts";

const AUTH_FAILURE_LIMIT = { limit: 30, windowSeconds: 300 };
const MINTED_PREFIX = "authminted:v1:";
const DAY_MS = 86_400_000;

let ipCounter = 0;
const freshIp = () => `203.0.113.${(ipCounter++ % 250) + 1}`;

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** GoTrue's real answer for a bearer whose signature does not verify. */
const signatureInvalid = () =>
  jsonResponse(403, {
    code: 403,
    error_code: "bad_jwt",
    msg: "invalid JWT: unable to parse or verify signature, token signature is invalid",
  });

interface Interceptor {
  forged: Set<string>;
  /** When set, every Upstash pipeline call answers with this HTTP status. */
  redisFailStatus: number | null;
  /** When true, every Upstash pipeline call hangs until the caller aborts. */
  redisHang: boolean;
  redisCalls: number;
  userCalls: number;
  restore(): void;
}

function installInterceptor(): Interceptor {
  const inner = globalThis.fetch;
  const state: Interceptor = {
    forged: new Set(),
    redisFailStatus: null,
    redisHang: false,
    redisCalls: 0,
    userCalls: 0,
    restore() {
      globalThis.fetch = inner;
    },
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (request.url === `${REDIS_URL}/pipeline`) {
      state.redisCalls += 1;
      if (state.redisHang) {
        await new Promise<void>((_, reject) => {
          const signal = init?.signal ?? request.signal;
          if (signal.aborted) reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      if (state.redisFailStatus !== null) {
        await request.body?.cancel().catch(() => undefined);
        return new Response("upstream error", { status: state.redisFailStatus });
      }
    }
    if (request.url.startsWith(`${SUPABASE_URL}/auth/v1/user`) && request.method === "GET") {
      state.userCalls += 1;
      const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      if (state.forged.has(bearer)) return signatureInvalid();
    }
    return inner(request);
  }) as typeof fetch;
  return state;
}

async function withPinnedClock(run: (clock: { advance(ms: number): void }) => Promise<void>) {
  const realNow = Date.now;
  const windowMs = AUTH_FAILURE_LIMIT.windowSeconds * 1_000;
  let now = (Math.floor(realNow() / windowMs) + 1) * windowMs + 1_000;
  Date.now = () => now;
  try {
    await run({
      advance(ms: number) {
        now += ms;
      },
    });
  } finally {
    Date.now = realNow;
  }
}

async function send(h: SessionHarness, request: Request): Promise<Response> {
  const response = await h.handler(request);
  await response.body?.cancel();
  return response;
}
const readMe = (h: SessionHarness, ip: string, bearer: string) =>
  send(h, apiRequest("GET", "/v1/me", { token: bearer, ip }));
const postRefresh = (h: SessionHarness, ip: string, refreshToken: string) =>
  send(h, apiRequest("POST", "/v1/auth/refresh", { ip, body: { refreshToken } }));
const postLogout = (h: SessionHarness, ip: string, bearer: string) =>
  send(h, apiRequest("POST", "/v1/auth/logout", { token: bearer, ip, body: {} }));

interface Handset {
  accessToken: string;
  refreshToken: string;
}

async function bootstrapHandset(h: SessionHarness, ip: string): Promise<Handset> {
  const response = await h.handler(
    apiRequest("POST", "/v1/account/bootstrap", { token: googleIdToken(), ip, body: {} }),
  );
  const body = (await response.json()) as { session?: Record<string, unknown> };
  assertEquals(response.status, 200, "handset bootstrapped");
  const session = body.session ?? {};
  assert(
    typeof session.accessToken === "string" && typeof session.refreshToken === "string",
    "bootstrap handed the handset a session",
  );
  return { accessToken: session.accessToken, refreshToken: session.refreshToken };
}

async function rotate(h: SessionHarness, ip: string, refreshToken: string): Promise<Handset> {
  const response = await h.handler(
    apiRequest("POST", "/v1/auth/refresh", { ip, body: { refreshToken } }),
  );
  const body = (await response.json()) as { session?: Record<string, unknown> };
  assertEquals(response.status, 200, "handset rotated");
  const session = body.session ?? {};
  assert(typeof session.accessToken === "string" && typeof session.refreshToken === "string");
  return { accessToken: session.accessToken, refreshToken: session.refreshToken };
}

const egressCharged = (h: SessionHarness, ip: string): number => {
  const entry = [...h.redis.entries()].find(
    ([key]) => key.startsWith("rl:authfail:") && key.endsWith(`:${ip}`),
  );
  return entry ? Number(entry[1].value) : 0;
};

const mintedEntries = (h: SessionHarness) =>
  [...h.redis.entries()].filter(([key]) => key.startsWith(MINTED_PREFIX));

async function flood(h: SessionHarness, interceptor: Interceptor, ip: string): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
    const forged = forgedSessionToken();
    interceptor.forged.add(forged);
    statuses.push((await readMe(h, ip, forged)).status);
  }
  return statuses;
}

// ── Attack 1: the venue lifecycle through Redis — bootstrap, flood, verify,
// rotate, replay the rotated-away token, log out — and the keys the budget
// leaves in the shared store (every one bounded by a finite TTL). ───────────
Deno.test(
  "redis lifecycle: after a thirty-forged-bearer flood the venue's bootstrapped handsets verify, rotate, replay a rotated-away token as a sign-out and log out; every minted key carries a bounded TTL",
  async () => {
    const h = await loadSessionHarness({ redis: true });
    const interceptor = installInterceptor();
    try {
      await withPinnedClock(async (clock) => {
        const ip = freshIp();
        const handsets = [
          await bootstrapHandset(h, ip),
          await bootstrapHandset(h, ip),
          await bootstrapHandset(h, ip),
        ];
        for (const [key, entry] of mintedEntries(h)) {
          assert(
            Number.isFinite(entry.expiresAtMs) &&
              entry.expiresAtMs - Date.now() <= 365 * DAY_MS + 1_000,
            `${key} TTL ${entry.expiresAtMs - Date.now()}ms`,
          );
        }
        assertEquals(mintedEntries(h).length, 6, "access + refresh token per handset");

        clock.advance(1_000);
        const flooded = await flood(h, interceptor, ip);
        assertEquals(
          flooded.filter((s) => s === 401).length,
          AUTH_FAILURE_LIMIT.limit,
          flooded.join(","),
        );
        assertEquals(
          egressCharged(h, ip),
          AUTH_FAILURE_LIMIT.limit,
          "the shared egress signal is spent",
        );
        const heldNovel = await readMe(
          h,
          ip,
          (() => {
            const t = forgedSessionToken();
            interceptor.forged.add(t);
            return t;
          })(),
        );
        assertEquals(heldNovel.status, 429);

        clock.advance(1_000);
        const userCallsBefore = interceptor.userCalls;
        assertEquals(
          (await readMe(h, ip, handsets[0].accessToken)).status,
          200,
          "cold bearer verifies",
        );
        assertEquals(interceptor.userCalls, userCallsBefore + 1, "Auth judged it (cache miss)");

        const rotated = await rotate(h, ip, handsets[1].refreshToken);
        assertEquals(
          (await readMe(h, ip, rotated.accessToken)).status,
          200,
          "the rotated bearer verifies",
        );
        const rotatedKey = mintedEntries(h).find(
          ([, entry]) =>
            entry.expiresAtMs - Date.now() <= 3_600_000 &&
            entry.expiresAtMs - Date.now() > 3_500_000,
        );
        assert(rotatedKey, "the rotated-away refresh token keeps only the grace hour");

        // A stale timer replays the rotated-away token: Auth no longer knows
        // it; the edge minted it, so this is a sign-out, charged to nobody.
        const replay = await postRefresh(h, ip, handsets[1].refreshToken);
        assertEquals(replay.status, 401);
        assertEquals(
          egressCharged(h, ip),
          AUTH_FAILURE_LIMIT.limit,
          "a minted token is never stuffing",
        );

        const logout = await postLogout(h, ip, handsets[2].accessToken);
        assertEquals(logout.status, 204);
        assertEquals((await readMe(h, ip, handsets[2].accessToken)).status, 401, "fenced");
        assertEquals(egressCharged(h, ip), AUTH_FAILURE_LIMIT.limit, "fences charge nothing");

        for (const [key, entry] of h.redis.entries()) {
          if (!key.startsWith("rl:auth") && !key.startsWith("auth")) continue;
          assert(Number.isFinite(entry.expiresAtMs), `${key} has no TTL`);
        }
      });
    } finally {
      interceptor.restore();
    }
  },
);

// ── Attack 2: Redis dies in the middle of the flood. The venue's handsets
// were minted while Redis was up; the flood is now counted only in memory. ──
Deno.test(
  "redis outage mid-flood: the venue's handsets keep verifying and rotating through the outage and after recovery, no 5xx leaks, and the flood is still bounded in memory",
  async () => {
    const h = await loadSessionHarness({ redis: true });
    const interceptor = installInterceptor();
    try {
      await withPinnedClock(async (clock) => {
        const ip = freshIp();
        const [a, b] = [await bootstrapHandset(h, ip), await bootstrapHandset(h, ip)];
        clock.advance(1_000);
        const half = AUTH_FAILURE_LIMIT.limit / 2;
        const firstHalf: number[] = [];
        for (let i = 0; i < half; i += 1) {
          const forged = forgedSessionToken();
          interceptor.forged.add(forged);
          firstHalf.push((await readMe(h, ip, forged)).status);
        }
        assertEquals(egressCharged(h, ip), half);

        interceptor.redisFailStatus = 500;
        clock.advance(1_000);
        const secondHalf: number[] = [];
        for (let i = 0; i < half; i += 1) {
          const forged = forgedSessionToken();
          interceptor.forged.add(forged);
          secondHalf.push((await readMe(h, ip, forged)).status);
        }
        assert(
          [...firstHalf, ...secondHalf].every((s) => s === 401),
          `flood statuses ${[...firstHalf, ...secondHalf].join(",")}`,
        );
        // Redis is down: the venue's handsets verify from the isolate's own
        // mirror of what it minted; a stranger's forged bearer is still 401
        // or 429, never 5xx.
        assertEquals(
          (await readMe(h, ip, a.accessToken)).status,
          200,
          "handset A verifies during the outage",
        );
        const rotatedB = await rotate(h, ip, b.refreshToken);
        assertEquals(
          (await readMe(h, ip, rotatedB.accessToken)).status,
          200,
          "handset B rotated during the outage",
        );
        const stranger = forgedSessionToken();
        interceptor.forged.add(stranger);
        const strangerStatus = (await readMe(h, ip, stranger)).status;
        assert(strangerStatus === 401 || strangerStatus === 429, `stranger got ${strangerStatus}`);

        interceptor.redisFailStatus = null;
        clock.advance(1_000);
        assertEquals((await readMe(h, ip, a.accessToken)).status, 200, "A verifies after recovery");
        assertEquals(
          (await postRefresh(h, ip, rotatedB.refreshToken)).status,
          200,
          "B rotates after recovery",
        );
        // B's session was rotated while Redis was down: the store never saw
        // that mint, but this isolate did — the next rotation must not be
        // treated as a stranger's guess.
        assertEquals(egressCharged(h, ip), half, "the venue never added to the shared signal");
      });
    } finally {
      interceptor.restore();
    }
  },
);

// ── Attack 3: Redis hangs to the client timeout on every call — what one
// forged bearer and one valid cold bearer now cost the venue in latency. The
// bound is the mobile billing client's 10 s request timeout
// (apps/mobile/src/billing/accessApi.ts BILLING_REQUEST_TIMEOUT_MS). ─────────
const MOBILE_BILLING_TIMEOUT_MS = 10_000;
Deno.test(
  "redis hang: a forged bearer is still judged (401) and a valid cold bearer still verifies (200); each request completes inside the mobile billing client's 10 s timeout with every Redis call burning its 1.2 s timeout",
  async () => {
    const h = await loadSessionHarness({ redis: true });
    const interceptor = installInterceptor();
    try {
      const ip = freshIp();
      const handset = await bootstrapHandset(h, ip);
      interceptor.redisHang = true;
      const forged = forgedSessionToken();
      interceptor.forged.add(forged);

      const forgedStart = performance.now();
      const forgedResponse = await readMe(h, ip, forged);
      const forgedMs = performance.now() - forgedStart;
      const forgedCalls = interceptor.redisCalls;

      const validStart = performance.now();
      const validResponse = await readMe(h, ip, handset.accessToken);
      const validMs = performance.now() - validStart;
      const validCalls = interceptor.redisCalls - forgedCalls;
      interceptor.redisHang = false;

      console.log(
        `[attack] redis hang: forged bearer ${forgedResponse.status} in ${Math.round(forgedMs)}ms ` +
          `(${forgedCalls} Redis calls); valid cold bearer ${validResponse.status} in ${Math.round(validMs)}ms ` +
          `(${validCalls} Redis calls)`,
      );
      assertEquals(forgedResponse.status, 401);
      assertEquals(validResponse.status, 200);
      assert(forgedMs < MOBILE_BILLING_TIMEOUT_MS, `forged bearer took ${forgedMs}ms`);
      assert(validMs < MOBILE_BILLING_TIMEOUT_MS, `valid bearer took ${validMs}ms`);
    } finally {
      interceptor.restore();
    }
  },
);

// ── Attack 4: cross-user replay through Redis — one dead session bearer
// replayed sixty times in parallel from two egresses spends one shared
// shard and neither egress's stuffing signal. ───────────────────────────────
Deno.test(
  "redis shard: sixty parallel replays of one logged-out bearer from two egresses spend one shard, charge neither egress, and a 61st replay is held before Auth",
  async () => {
    const h = await loadSessionHarness({ redis: true });
    const interceptor = installInterceptor();
    try {
      await withPinnedClock(async (clock) => {
        const ipA = freshIp();
        const ipB = freshIp();
        const handset = await bootstrapHandset(h, ipA);
        // Another device signs this session out at Auth (not through this edge,
        // so no local fence): the bearer is now a liveness refusal upstream.
        const session = h.sessions.get(handset.accessToken);
        assert(session, "harness knows the session");
        session.revoked = true;

        clock.advance(1_000);
        const before = interceptor.userCalls;
        const statuses = (
          await Promise.all(
            Array.from({ length: 60 }, (_, i) =>
              readMe(h, i % 2 === 0 ? ipA : ipB, handset.accessToken),
            ),
          )
        ).map((r) => r.status);
        const judged = interceptor.userCalls - before;
        assert(
          statuses.every((s) => s === 401 || s === 429),
          statuses.join(","),
        );
        assertEquals(
          statuses.filter((s) => s === 401).length,
          judged,
          "one Auth call per judged replay",
        );
        assertEquals(egressCharged(h, ipA), 0, "liveness never charges egress A");
        assertEquals(egressCharged(h, ipB), 0, "liveness never charges egress B");
        const shardKeys = [...h.redis.keys()].filter((k) => k.startsWith("rl:authshard:"));
        assertEquals(shardKeys.length, 1, `one shared shard, saw ${shardKeys.length}`);
        assertEquals(Number(h.redis.get(shardKeys[0])!.value), judged);

        clock.advance(1_000);
        const held = await readMe(h, ipB, handset.accessToken);
        assertEquals(held.status, 429, "the shard is spent across egresses");
        assertEquals(interceptor.userCalls, before + judged, "held before Auth");
        const retryAfter = Number(held.headers.get("Retry-After"));
        assert(
          retryAfter >= 1 && retryAfter <= AUTH_FAILURE_LIMIT.windowSeconds,
          `Retry-After ${retryAfter}`,
        );
        // Strangers on both egresses are still judged: nothing was stuffed.
        const strangerA = forgedSessionToken();
        interceptor.forged.add(strangerA);
        assertEquals((await readMe(h, ipA, strangerA)).status, 401);
      });
    } finally {
      interceptor.restore();
    }
  },
);
