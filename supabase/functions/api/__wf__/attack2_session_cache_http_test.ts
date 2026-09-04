// ADVERSARIAL PASS 3 — edge-auth-cache-ratelimit (#2), extra scenarios.
//
// Session cache (L1, keyed by sha256(bearer)), logout eviction, bearer-expiry
// bounds, corrupt cache entries, request-id boundaries, hostile bearers, and
// the client-address trust order — all against the REAL handler.
//
//   S11 logout evicts the cached session; the next request re-verifies with
//       GoTrue and a revoked session is refused.
//   S12 a cached session dies with its bearer's `exp` (clock advanced) and
//       an expired bearer never reaches GoTrue.
//   S13 a corrupt L1 entry falls through to a real verification (no 500).
//   S14 request-id boundaries (8..64 of [A-Za-z0-9._-]); rejected ids are
//       never echoed; 401 / 429 responses carry an id too.
//   S15 hostile bearers (512 KiB, unicode, exp:"abc", nested dots, JSON with
//       __proto__) are 401 without an upstream call, quickly.
//   S16 (documenting) `cf-connecting-ip` is trusted OVER x-forwarded-for
//       (http.ts:57-60). Safe only if the gateway in front of the function
//       overwrites/strips that header — INFRA ASSUMPTION, not verifiable
//       from Linux. The test pins the code's behaviour so a change is loud.
//
// Run: cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json attack2_session_cache_http_test.ts

import { assert, assertEquals, assertMatch, assertNotEquals } from "jsr:@std/assert@1";
import { cacheSet, sha256Hex } from "../cache.ts";
import { peekRateLimit } from "../rateLimit.ts";
import { captureAccessLog } from "../http.ts";
import { SUPABASE_URL, TEST_USER_ID, loadHarness, userRequest } from "./routesHarness.ts";

const h = await loadHarness();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** UTF-8 bytes of `s` as they arrive in a header (Latin-1 decoded ByteString). */
const latin1 = (s: string): string => String.fromCharCode(...new TextEncoder().encode(s));

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function accessToken(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  return `${header}.${b64url(
    JSON.stringify({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub: TEST_USER_ID,
      aud: "authenticated",
      role: "authenticated",
      jti: crypto.randomUUID(),
      ...payload,
    }),
  )}.sig`;
}

interface GoTrueStub {
  getUserCalls: number;
  logoutCalls: number;
  /** null → 200 with a Google user; otherwise this status. */
  getUserStatus: number | null;
  restore: () => void;
}

function stubGoTrue(): GoTrueStub {
  const inner = globalThis.fetch;
  const stub: GoTrueStub = {
    getUserCalls: 0,
    logoutCalls: 0,
    getUserStatus: null,
    restore() {
      globalThis.fetch = inner;
    },
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (request.method === "GET" && request.url.startsWith(`${SUPABASE_URL}/auth/v1/user`)) {
      stub.getUserCalls += 1;
      if (stub.getUserStatus !== null) {
        return new Response(JSON.stringify({ code: stub.getUserStatus, msg: "invalid JWT" }), {
          status: stub.getUserStatus,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          id: TEST_USER_ID,
          aud: "authenticated",
          role: "authenticated",
          email: "user@example.com",
          app_metadata: { provider: "google", providers: ["google"] },
          user_metadata: {},
          created_at: new Date().toISOString(),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (request.method === "POST" && request.url.startsWith(`${SUPABASE_URL}/auth/v1/logout`)) {
      stub.logoutCalls += 1;
      return new Response(null, { status: 204 });
    }
    return inner(input, init);
  }) as typeof fetch;
  return stub;
}

function pinClock(): { advance: (ms: number) => void; restore: () => void } {
  const realNow = Date.now;
  let pinned = Math.floor(realNow() / 300_000) * 300_000 + 10_000;
  Date.now = () => pinned;
  return {
    advance: (ms) => {
      pinned += ms;
    },
    restore: () => {
      Date.now = realNow;
    },
  };
}

const profile = () => ({
  id: TEST_USER_ID,
  email: "user@example.com",
  provider: "google",
  onboarding_state: "complete",
});

async function drain(res: Response): Promise<Response> {
  await res.body?.cancel();
  return res;
}

Deno.test(
  "[S11] logout evicts the cached session; a revoked session is refused on the next request",
  async () => {
    const clock = pinClock();
    const restoreLog = captureAccessLog(() => undefined);
    const gotrue = stubGoTrue();
    const ip = "198.51.100.81";
    try {
      h.reset();
      h.tables.profiles = [profile()];
      const token = accessToken({ exp: Math.floor(Date.now() / 1000) + 3600 });
      const first = await drain(await h.handler(userRequest("GET", "/v1/me", { ip, token })));
      const second = await drain(await h.handler(userRequest("GET", "/v1/me", { ip, token })));
      const afterTwo = gotrue.getUserCalls;
      const logout = await drain(
        await h.handler(userRequest("POST", "/v1/auth/logout", { ip, token })),
      );
      const afterLogout = gotrue.getUserCalls;
      gotrue.getUserStatus = 401; // GoTrue now treats the session as revoked
      const third = await drain(await h.handler(userRequest("GET", "/v1/me", { ip, token })));
      const fourth = await drain(await h.handler(userRequest("GET", "/v1/me", { ip, token })));
      console.warn(
        `[S11] observed: me=${first.status},${second.status} getUser after 2=${afterTwo} logout=${logout.status} logoutCalls=${gotrue.logoutCalls} getUser after logout=${afterLogout} post-logout me=${third.status},${fourth.status} getUser total=${gotrue.getUserCalls}`,
      );
      assertEquals([first.status, second.status], [200, 200]);
      assertEquals(afterTwo, 1, "second request is served from the auth cache");
      assertEquals(logout.status, 204);
      assertEquals(gotrue.logoutCalls, 1);
      assertEquals(third.status, 401, "revoked session must not be served from cache after logout");
      assertEquals(fourth.status, 401);
      assert(gotrue.getUserCalls >= afterLogout + 1, "post-logout request re-verified with GoTrue");
    } finally {
      gotrue.restore();
      restoreLog();
      clock.restore();
    }
  },
);

Deno.test(
  "[S12] cached session dies with the bearer's exp; an expired bearer never reaches GoTrue",
  async () => {
    const clock = pinClock();
    const restoreLog = captureAccessLog(() => undefined);
    const gotrue = stubGoTrue();
    const ip = "198.51.100.82";
    try {
      h.reset();
      h.tables.profiles = [profile()];
      // Cache TTL = (exp - now) - 30 s, only when >= 60 s (index.ts:388-391):
      // a 120 s bearer is cached for 90 s and the entry's expiresAtMs = exp.
      const token = accessToken({ exp: Math.floor(Date.now() / 1000) + 120 });
      const a = await drain(await h.handler(userRequest("GET", "/v1/me", { ip, token })));
      clock.advance(60_000);
      const b = await drain(await h.handler(userRequest("GET", "/v1/me", { ip, token })));
      const callsAt60 = gotrue.getUserCalls;
      clock.advance(35_000); // 95 s: L1 TTL (90 s) elapsed, bearer still valid → re-verify
      const c = await drain(await h.handler(userRequest("GET", "/v1/me", { ip, token })));
      const callsAt95 = gotrue.getUserCalls;
      clock.advance(26_000); // 121 s: past exp
      const d = await h.handler(userRequest("GET", "/v1/me", { ip, token }));
      const dBody = await d.text();
      const authfail = 1000 - (await peekRateLimit("authfail", ip, 1000, 300)).remaining;
      console.warn(
        `[S12] observed: t0=${a.status} t60=${b.status} t95=${c.status} t121=${d.status} getUser calls at t60=${callsAt60} t95=${callsAt95} total=${gotrue.getUserCalls} authfail=${authfail} body=${dBody.slice(0, 100)}`,
      );
      assertEquals([a.status, b.status, c.status], [200, 200, 200]);
      assertEquals(callsAt60, 1, "t60 served from cache");
      assertEquals(callsAt95, 2, "after the L1 TTL the bearer is re-verified with GoTrue");
      assertEquals(d.status, 401);
      assertEquals(
        gotrue.getUserCalls,
        2,
        "an expired bearer is rejected locally, no upstream call",
      );
      assertEquals(authfail, 1, "the expired bearer counts as one auth failure");
    } finally {
      gotrue.restore();
      restoreLog();
      clock.restore();
    }
  },
);

Deno.test(
  "[S13] corrupt / hostile L1 auth-cache entries fall through to a real verification",
  async () => {
    const clock = pinClock();
    const restoreLog = captureAccessLog(() => undefined);
    const gotrue = stubGoTrue();
    const ip = "198.51.100.83";
    const poison = [
      "not json",
      "{",
      "null",
      "[]",
      '"string"',
      JSON.stringify({ userId: "22222222-2222-4222-8222-222222222222", provider: "google" }), // no expiresAtMs
      JSON.stringify({
        userId: "22222222-2222-4222-8222-222222222222",
        provider: "google",
        expiresAtMs: "9999999999999",
      }),
      JSON.stringify({ __proto__: { expiresAtMs: 9_999_999_999_999 }, provider: "google" }),
    ];
    try {
      h.reset();
      h.tables.profiles = [profile()];
      const results: string[] = [];
      const trustedWithoutVerification: string[] = [];
      for (const [i, raw] of poison.entries()) {
        const token = accessToken({ exp: Math.floor(Date.now() / 1000) + 3600, n: i });
        await cacheSet(`auth:${await sha256Hex(token)}`, raw, 600);
        const before = gotrue.getUserCalls;
        const res = await h.handler(userRequest("GET", "/v1/me", { ip, token }));
        const body = await res.text();
        const userId = res.status === 200 ? JSON.parse(body).user?.id : null;
        // NB: /v1/me echoes the PROFILE row the harness returns (unfiltered),
        // so the identity check is `upstream === 1`: a 200 that made no
        // getUser call means the poisoned entry itself was trusted.
        results.push(
          `${raw.slice(0, 40)}→${res.status}/upstream=${gotrue.getUserCalls - before}/user=${userId}`,
        );
        assert(res.status !== 500, `poison ${raw} caused a 500`);
        if (res.status === 200 && gotrue.getUserCalls - before === 0)
          trustedWithoutVerification.push(raw);
      }
      console.warn(`[S13] observed: ${results.join(" | ")}`);
      assertEquals(
        trustedWithoutVerification,
        [],
        `poisoned cache entries were trusted without verification (index.ts:358 compares expiresAtMs without a type check)`,
      );
    } finally {
      gotrue.restore();
      restoreLog();
      clock.restore();
    }
  },
);

Deno.test("[S14] request-id boundaries and presence on 401/429", async () => {
  const restoreLog = captureAccessLog(() => undefined);
  const gotrue = stubGoTrue();
  const clock = pinClock();
  const ip = "198.51.100.84";
  try {
    h.reset();
    h.tables.profiles = [profile()];
    const cases: [string, boolean][] = [
      ["a".repeat(8), true],
      ["a".repeat(7), false],
      ["A-z.0_9".padEnd(64, "x"), true],
      ["a".repeat(65), false],
      ["réquest-id-1", false],
      ["../../etc/passwd", false],
      ["id with spaces", false],
      ["id\ttab-00000", false],
      // UTF-8 bytes of "𝔲" as they arrive on the wire (Latin-1 decoded).
      ["\xF0\x9D\x94\xB2-fraktur-0", false],
    ];
    const seen: string[] = [];
    for (const [id, echoed] of cases) {
      const res = await drain(
        await h.handler(userRequest("GET", "/healthz", { ip, headers: { "x-request-id": id } })),
      );
      const out = res.headers.get("x-request-id") ?? "";
      seen.push(`${JSON.stringify(id).slice(0, 20)}→${echoed ? "echo" : "mint"}:${out === id}`);
      if (echoed) assertEquals(out, id);
      else {
        assertNotEquals(out, id);
        assertMatch(out, UUID);
      }
    }
    const unauth = await drain(
      await h.handler(userRequest("GET", "/v1/me", { ip, token: "junk" })),
    );
    assertMatch(unauth.headers.get("x-request-id") ?? "", UUID);
    for (let i = 0; i < 30; i += 1) {
      await drain(await h.handler(userRequest("GET", "/v1/me", { ip, token: `junk-${i}` })));
    }
    const limited = await drain(
      await h.handler(
        userRequest("GET", "/v1/me", {
          ip,
          token: "junk",
          headers: { "x-request-id": "client-trace-42" },
        }),
      ),
    );
    console.warn(
      `[S14] observed: ${seen.join(" ")} 401-id=${unauth.headers.has("x-request-id")} 429=${limited.status} 429-id=${limited.headers.get("x-request-id")}`,
    );
    assertEquals(limited.status, 429);
    assertEquals(limited.headers.get("x-request-id"), "client-trace-42");
  } finally {
    clock.restore();
    gotrue.restore();
    restoreLog();
  }
});

Deno.test(
  "[S15] hostile bearers are 401 without an upstream call and without stalling",
  async () => {
    const restoreLog = captureAccessLog(() => undefined);
    const gotrue = stubGoTrue();
    const clock = pinClock();
    const ip = "198.51.100.85";
    const header = b64url(JSON.stringify({ alg: "none" }));
    // [label, bearer, expected getUser calls]. Any issuer ending in /auth/v1 is
    // treated as Supabase-issued (index.ts:482) and handed to GoTrue's getUser —
    // GoTrue is the verifier there, so exactly ONE upstream call is expected for
    // those and none for the rest.
    const bearers: [string, string, number][] = [
      ["512KiB", "x".repeat(512 * 1024), 0],
      [
        "512KiB-jwt",
        `${header}.${b64url(JSON.stringify({ iss: `${SUPABASE_URL}/auth/v1`, pad: "p".repeat(512 * 1024) }))}.s`,
        1,
      ],
      ["unicode", latin1("🥒🥒🥒.🥒🥒🥒.🥒🥒🥒"), 0],
      ["exp-string", accessToken({ exp: "abc" }), 1],
      ["many-dots", ".".repeat(10_000), 0],
      [
        "proto",
        `${header}.${b64url('{"__proto__":{"iss":"https://accounts.google.com"},"exp":9999999999}')}.s`,
        0,
      ],
      [
        "iss-array",
        `${header}.${b64url(JSON.stringify({ iss: ["https://accounts.google.com"], exp: 9_999_999_999 }))}.s`,
        0,
      ],
      [
        "iss-suffix-spoof",
        accessToken({ exp: 9_999_999_999 }).replace(
          `${SUPABASE_URL}/auth/v1`,
          "https://evil.test/auth/v1",
        ),
        1,
      ],
      ["exp-1e300", accessToken({ exp: 1e300 }), 1],
      ["exp-negative", accessToken({ exp: -1 }), 0],
    ];
    try {
      h.reset();
      gotrue.getUserStatus = 401; // GoTrue rejects every forged/oversized token
      const out: string[] = [];
      for (const [label, token, expectedUpstream] of bearers) {
        const before = gotrue.getUserCalls;
        const t0 = performance.now();
        const res = await drain(await h.handler(userRequest("GET", "/v1/me", { ip, token })));
        const ms = Math.round(performance.now() - t0);
        const upstream = gotrue.getUserCalls - before;
        out.push(`${label}→${res.status}/${ms}ms/getUser=${upstream}`);
        assertEquals(res.status, 401, `${label}: ${res.status}`);
        assertEquals(upstream, expectedUpstream, `${label}: upstream calls`);
        assert(ms < 2_000, `${label} took ${ms} ms`);
      }
      const tokenCalls = h.callsTo(`${SUPABASE_URL}/auth/v1/token`).length;
      console.warn(`[S15] observed: ${out.join(" | ")} signInWithIdToken calls=${tokenCalls}`);
      assertEquals(tokenCalls, 0, "no forged provider token reached signInWithIdToken");
    } finally {
      clock.restore();
      gotrue.restore();
      restoreLog();
    }
  },
);

Deno.test(
  "[S16] (documenting) cf-connecting-ip is trusted over x-forwarded-for — 31 refreshes with distinct cf-connecting-ip and one XFF are never 429",
  async () => {
    const restoreLog = captureAccessLog(() => undefined);
    const clock = pinClock();
    try {
      h.reset();
      const statuses = new Set<number>();
      for (let i = 0; i < 31; i += 1) {
        const res = await drain(
          await h.handler(
            userRequest("POST", "/v1/auth/refresh", {
              ip: "198.51.100.86",
              token: "unused",
              body: { refreshToken: "r" },
              headers: { "cf-connecting-ip": `10.9.${Math.floor(i / 256)}.${i % 256}` },
            }),
          ),
        );
        statuses.add(res.status);
      }
      const xffCount =
        1000 - (await peekRateLimit("auth_refresh", "198.51.100.86", 1000, 60)).remaining;
      console.warn(`[S16] observed: statuses=${[...statuses]} auth_refresh(xff ip)=${xffCount}`);
      assertEquals([...statuses], [200]);
      assertEquals(xffCount, 0, "the XFF address is not charged when cf-connecting-ip is present");
    } finally {
      clock.restore();
      restoreLog();
    }
  },
);
