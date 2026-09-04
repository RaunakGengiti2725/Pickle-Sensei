// ADVERSARIAL PASS 3 — edge-auth-cache-ratelimit (#2).
//
// Auth-service outages vs. the per-IP auth-failure budget, exercised against
// the REAL Deno.serve handler (routesHarness: Supabase Auth/PostgREST stubbed
// at the fetch layer, no Upstash → per-isolate memory windows, which are the
// SAME module instance this file imports from ../rateLimit.ts).
//
// Every test asserts the EXPECTED contract, so a failure here is a defect at
// the commit under test, not a harness problem. Observed values are printed
// before each assertion so the evidence survives a failing run.
//
//   S1  getUser() 503 outage × 30 uncached bearers from one IP must NOT trip
//       the authfail budget for that IP (bootstrap afterwards must not 429).
//   S3  40 concurrent malformed bearers from one IP are counted EXACTLY 40
//       times in the authfail window (atomic INCR, no under-count).
//   S7  GoTrue /token?grant_type=refresh_token fetch throwing TypeError must
//       surface as a 5xx in < 15 s (mobile REQUEST_TIMEOUT_MS), never as a
//       401 (which the app treats as "session revoked → sign out" and the
//       edge charges to authfail).
//   S8  (own) GoTrue 503 on refresh must also answer within 15 s.
//
// Run: cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json attack2_authfail_outage_test.ts

import { assert, assertEquals } from "jsr:@std/assert@1";
import { peekRateLimit } from "../rateLimit.ts";
import { captureAccessLog } from "../http.ts";
import {
  SUPABASE_URL,
  TEST_USER_ID,
  fakeGoogleIdToken,
  loadHarness,
  userRequest,
} from "./routesHarness.ts";

const AUTH_FAILURE_LIMIT = { limit: 30, windowSeconds: 300 }; // index.ts:2700
const MOBILE_REFRESH_TIMEOUT_MS = 15_000; // apps/mobile/src/account/sessionLifecycle.ts:13
/** Wide "limit" so peekRateLimit's `remaining` reveals the raw count. */
const PEEK_WIDE = 1_000;

const h = await loadHarness();

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A Supabase-issued-looking access token (iss ends with /auth/v1) with a
 * unique jti so each one hashes to a distinct auth-cache key. */
function fakeSupabaseAccessToken(seq: number): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub: TEST_USER_ID,
      aud: "authenticated",
      role: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600,
      jti: `attack2-${seq}-${crypto.randomUUID()}`,
    }),
  );
  return `${header}.${payload}.sig`;
}

/** Pin Date.now() 10 s into the current 300 s bucket so a 60 s / 300 s window
 * cannot roll over mid-test (fixed windows are aligned to floor(now/window)). */
function pinClock(): () => void {
  const realNow = Date.now;
  const pinned = Math.floor(realNow() / 300_000) * 300_000 + 10_000;
  Date.now = () => pinned;
  return () => {
    Date.now = realNow;
  };
}

/** Layer a fetch override on top of the harness stub for one Supabase Auth
 * path; everything else falls through to the harness. */
function overrideAuthPath(
  match: (url: string, method: string) => boolean,
  respond: () => Promise<Response> | Response,
): () => void {
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (match(request.url, request.method)) return respond();
    return inner(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = inner;
  };
}

async function authfailCount(ip: string): Promise<number> {
  const peek = await peekRateLimit("authfail", ip, PEEK_WIDE, AUTH_FAILURE_LIMIT.windowSeconds);
  return PEEK_WIDE - peek.remaining;
}

function profile(provider: "apple" | "google" = "google") {
  return {
    id: TEST_USER_ID,
    email: "nat@example.com",
    provider,
    onboarding_state: "complete",
  };
}

const quiet = () => captureAccessLog(() => undefined);

// ─── S1 ──────────────────────────────────────────────────────────────────────

Deno.test(
  "[S1] getUser() 503 outage × 30 uncached bearers from one IP does not charge authfail; bootstrap from that IP is not 429",
  async () => {
    const unpin = pinClock();
    const restoreLog = quiet();
    const ip = "198.51.100.61";
    let getUserCalls = 0;
    const restoreFetch = overrideAuthPath(
      (url, method) => method === "GET" && url.startsWith(`${SUPABASE_URL}/auth/v1/user`),
      () => {
        getUserCalls += 1;
        return new Response(
          JSON.stringify({ code: 503, msg: "Auth service temporarily unavailable" }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    try {
      h.reset();
      h.tables.profiles = [profile()];
      const statuses: number[] = [];
      for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
        const res = await h.handler(
          userRequest("GET", "/v1/me", { ip, token: fakeSupabaseAccessToken(i) }),
        );
        statuses.push(res.status);
        await res.body?.cancel();
      }
      const charged = await authfailCount(ip);
      const histogram = statuses.reduce<Record<string, number>>((acc, s) => {
        acc[s] = (acc[s] ?? 0) + 1;
        return acc;
      }, {});
      console.warn(
        `[S1] observed: getUser calls=${getUserCalls} statuses=${JSON.stringify(histogram)} authfail(ip)=${charged}`,
      );

      // The real user behind the same NAT now signs in after the outage.
      const bootstrap = await h.handler(
        userRequest("POST", "/v1/account/bootstrap", { ip, token: fakeGoogleIdToken() }),
      );
      const bootstrapBody = await bootstrap.text();
      console.warn(
        `[S1] observed: bootstrap status=${bootstrap.status} retry-after=${bootstrap.headers.get("Retry-After")} body=${bootstrapBody.slice(0, 160)}`,
      );

      assertEquals(getUserCalls, AUTH_FAILURE_LIMIT.limit, "every uncached bearer reached GoTrue");
      assert(
        bootstrap.status !== 429,
        `bootstrap from ${ip} was rate limited (429) after an AUTH-SERVICE outage: authfail=${charged}`,
      );
      assertEquals(
        charged,
        0,
        "auth-service failures must not be charged to the client's authfail budget",
      );
      assert(
        statuses.every((s) => s >= 500 && s < 600),
        `an upstream 503 must be reported as a 5xx, got ${JSON.stringify(histogram)}`,
      );
    } finally {
      restoreFetch();
      restoreLog();
      unpin();
    }
  },
);

Deno.test(
  "[S1b] signInWithIdToken 503 outage × 30 bootstraps from one NAT IP does not lock that IP out afterwards",
  async () => {
    const unpin = pinClock();
    const restoreLog = quiet();
    const ip = "198.51.100.62";
    let down = true;
    let tokenCalls = 0;
    const restoreFetch = overrideAuthPath(
      (url, method) => down && method === "POST" && url.startsWith(`${SUPABASE_URL}/auth/v1/token`),
      () => {
        tokenCalls += 1;
        return new Response(JSON.stringify({ code: 503, msg: "upstream down" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      },
    );
    try {
      h.reset();
      h.tables.profiles = [profile()];
      const statuses: number[] = [];
      for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
        const res = await h.handler(
          userRequest("POST", "/v1/account/bootstrap", {
            ip,
            token: fakeGoogleIdToken(`user-${i}`),
          }),
        );
        statuses.push(res.status);
        await res.body?.cancel();
      }
      down = false; // outage over
      const charged = await authfailCount(ip);
      const after = await h.handler(
        userRequest("POST", "/v1/account/bootstrap", { ip, token: fakeGoogleIdToken() }),
      );
      await after.body?.cancel();
      console.warn(
        `[S1b] observed: token calls during outage=${tokenCalls} statuses=${[...new Set(statuses)]} authfail(ip)=${charged} post-outage bootstrap=${after.status} retry-after=${after.headers.get("Retry-After")}`,
      );
      assertEquals(tokenCalls, AUTH_FAILURE_LIMIT.limit);
      assert(
        after.status !== 429,
        `post-outage bootstrap from ${ip} is locked out: authfail=${charged}`,
      );
      assertEquals(charged, 0);
    } finally {
      restoreFetch();
      restoreLog();
      unpin();
    }
  },
);

// ─── S3 ──────────────────────────────────────────────────────────────────────

Deno.test(
  "[S3] 40 concurrent malformed bearers from one IP → authfail window reads exactly 40, 41st request is 429",
  async () => {
    const unpin = pinClock();
    const restoreLog = quiet();
    const ip = "198.51.100.63";
    try {
      h.reset();
      const seed = 0x5eed_2026;
      // Deterministic "random" garbage: LCG seeded so a failure is replayable.
      let x = seed;
      const junk = (): string => {
        x = (Math.imul(x, 1_664_525) + 1_013_904_223) >>> 0;
        return x.toString(36) + "." + (x ^ 0xdead_beef).toString(36);
      };
      const bearers = Array.from({ length: 40 }, junk);
      const responses = await Promise.all(
        bearers.map((token) => h.handler(userRequest("GET", "/v1/me", { ip, token }))),
      );
      const statuses = responses.map((r) => r.status);
      await Promise.all(responses.map((r) => r.body?.cancel()));
      const count = await authfailCount(ip);
      const blocked = await h.handler(userRequest("GET", "/v1/me", { ip }));
      await blocked.body?.cancel();
      console.warn(
        `[S3] seed=${seed} observed: statuses=${[...new Set(statuses)]} authfail(ip)=${count} 41st=${blocked.status}`,
      );
      assert(
        statuses.every((s) => s === 401),
        `all 40 malformed bearers should be 401 pre-block, got ${statuses}`,
      );
      assertEquals(count, 40, "concurrent failures must be counted exactly once each");
      assertEquals(blocked.status, 429);
      assertEquals(Number.isInteger(Number(blocked.headers.get("Retry-After"))), true);
    } finally {
      restoreLog();
      unpin();
    }
  },
);

// ─── S7 / S8 ─────────────────────────────────────────────────────────────────

async function timedRefresh(ip: string): Promise<{ status: number; ms: number; body: string }> {
  const started = performance.now();
  const res = await h.handler(
    userRequest("POST", "/v1/auth/refresh", {
      ip,
      token: "unused",
      body: { refreshToken: "refresh-token-under-test" },
    }),
  );
  const ms = Math.round(performance.now() - started);
  return { status: res.status, ms, body: (await res.text()).slice(0, 200) };
}

const isRefreshGrant = (url: string, method: string): boolean =>
  method === "POST" &&
  url.startsWith(`${SUPABASE_URL}/auth/v1/token`) &&
  new URL(url).searchParams.get("grant_type") === "refresh_token";

Deno.test({
  name: "[S7] GoTrue refresh fetch throws TypeError → edge answers 5xx in < 15 s and does not charge authfail",
  fn: async () => {
    const restoreLog = quiet();
    const ip = "198.51.100.67";
    let attempts = 0;
    const restoreFetch = overrideAuthPath(isRefreshGrant, () => {
      attempts += 1;
      throw new TypeError("error sending request for url (connection reset)");
    });
    try {
      h.reset();
      const before = await authfailCount(ip);
      const { status, ms, body } = await timedRefresh(ip);
      const charged = (await authfailCount(ip)) - before;
      console.warn(
        `[S7] observed: status=${status} elapsed=${ms}ms gotrue attempts=${attempts} authfail delta=${charged} body=${body}`,
      );
      assert(
        ms < MOBILE_REFRESH_TIMEOUT_MS,
        `edge took ${ms} ms (> mobile REQUEST_TIMEOUT_MS ${MOBILE_REFRESH_TIMEOUT_MS}); the app aborts first`,
      );
      assert(status >= 500 && status < 600, `a network fault must be a 5xx, got ${status}`);
      assertEquals(charged, 0, "a network fault is not an authentication failure");
    } finally {
      restoreFetch();
      restoreLog();
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "[S8] GoTrue refresh responds 503 → edge answers 5xx in < 15 s",
  fn: async () => {
    const restoreLog = quiet();
    const ip = "198.51.100.68";
    let attempts = 0;
    const restoreFetch = overrideAuthPath(isRefreshGrant, () => {
      attempts += 1;
      return new Response(JSON.stringify({ code: 503, msg: "upstream down" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    });
    try {
      h.reset();
      const before = await authfailCount(ip);
      const { status, ms, body } = await timedRefresh(ip);
      const charged = (await authfailCount(ip)) - before;
      console.warn(
        `[S8] observed: status=${status} elapsed=${ms}ms gotrue attempts=${attempts} authfail delta=${charged} body=${body}`,
      );
      assert(status >= 500 && status < 600, `upstream 503 must be a 5xx, got ${status}`);
      assertEquals(charged, 0);
      assert(
        ms < MOBILE_REFRESH_TIMEOUT_MS,
        `edge took ${ms} ms (> mobile REQUEST_TIMEOUT_MS ${MOBILE_REFRESH_TIMEOUT_MS}); the app aborts first`,
      );
    } finally {
      restoreFetch();
      restoreLog();
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});
