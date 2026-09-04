// Adversarial pass 3 — `edge-auth-cache-ratelimit` (bootstrap / refresh /
// logout, verified-session cache, per-IP auth-failure budget). Every case
// drives the REAL handler through routesHarness (Supabase Auth + PostgREST
// stubbed at the fetch layer, no port opened) and asserts what the edge does
// on the wire: status, error code, and — the part a client cannot see — which
// upstream calls were made and whether the auth-failure budget was charged.
//
// All cases in this file HELD on 4d812e1a (they pass). Cases that reproduce a
// defect live in attack_p3_findings_test.ts and FAIL on purpose.
//
//   deno test -A --no-check --config deno.json attack_p3_auth_cache_ratelimit_test.ts
//
// Time is frozen per case (Date.now stub) so the wall-clock-aligned rate-limit
// windows cannot roll over mid-test.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { cacheGet, cacheSet, sha256Hex } from "../cache.ts";
import { SUPABASE_URL, TEST_USER_ID, loadHarness, userRequest } from "./routesHarness.ts";

const h = await loadHarness();

// ─── helpers ────────────────────────────────────────────────────────────────

/** UTF-8-safe base64url (btoa alone throws on non-Latin1 code points). */
function b64url(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Unsigned JWT-shaped token; the edge only decodes the payload for routing
 * and delegates verification to (stubbed) Supabase Auth. */
function jwt(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  return `${header}.${b64url(JSON.stringify(payload))}.sig`;
}

function supabaseAccessToken(opts: { sub?: string; expSec: number; jti: string }): string {
  return jwt({
    iss: `${SUPABASE_URL}/auth/v1`,
    sub: opts.sub ?? TEST_USER_ID,
    aud: "authenticated",
    role: "authenticated",
    exp: opts.expSec,
    jti: opts.jti,
  });
}

function gotrueUser(id = TEST_USER_ID, provider: "google" | "apple" = "google") {
  return {
    id,
    aud: "authenticated",
    role: "authenticated",
    email: "user@example.com",
    app_metadata: { provider, providers: [provider] },
    user_metadata: {},
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** routesHarness has no GoTrue `GET /auth/v1/user` (getUser) or
 * `POST /auth/v1/logout` stub — layer one over its fetch and count calls. */
function stubGoTrue(handlers: {
  user?: (request: Request) => Response;
  logout?: (request: Request) => Response;
  token?: (request: Request) => Response;
}) {
  const inner = globalThis.fetch;
  const seen = {
    user: 0,
    logout: 0,
    token: 0,
    logoutUrls: [] as string[],
    logoutBearers: [] as string[],
  };
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === SUPABASE_URL && url.pathname === "/auth/v1/user" && handlers.user) {
      seen.user += 1;
      return Promise.resolve(handlers.user(request));
    }
    if (url.origin === SUPABASE_URL && url.pathname === "/auth/v1/logout" && handlers.logout) {
      seen.logout += 1;
      seen.logoutUrls.push(request.url);
      seen.logoutBearers.push(request.headers.get("authorization") ?? "");
      return Promise.resolve(handlers.logout(request));
    }
    if (url.origin === SUPABASE_URL && url.pathname === "/auth/v1/token" && handlers.token) {
      seen.token += 1;
      return Promise.resolve(handlers.token(request));
    }
    return inner(request);
  }) as typeof fetch;
  return {
    seen,
    restore() {
      globalThis.fetch = inner;
    },
  };
}

async function withFrozenClock<T>(nowMs: number, fn: (now: number) => Promise<T>): Promise<T> {
  const realNow = Date.now;
  Date.now = () => nowMs;
  try {
    return await fn(nowMs);
  } finally {
    Date.now = realNow;
  }
}

function profileRow(id = TEST_USER_ID) {
  return { id, email: "user@example.com", provider: "google", onboarding_state: "complete" };
}

async function errorBody(response: Response): Promise<{ code?: string; message: string }> {
  const body = (await response.json()) as { error: { code?: string; message: string } };
  return body.error;
}

let ipCounter = 0;
/** A fresh source IP per case so per-IP budgets never bleed across cases. */
const freshIp = (): string => `198.51.100.${(ipCounter += 1)}`;

const AUTHFAIL_LIMIT = 30; // AUTH_FAILURE_LIMIT in index.ts

/** Spend `n` units of the per-IP auth-failure budget with a garbage bearer. */
async function spendAuthFailures(ip: string, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    const response = await h.handler(userRequest("GET", "/v1/me", { token: `garbage-${i}`, ip }));
    assertEquals(response.status, 401, `warm-up failure #${i + 1} should be 401`);
    await response.body?.cancel();
  }
}

/** Two probes that reveal the EXACT auth-failure count for `ip` after 29
 * warm-up failures: one more failure must still be admitted (401), and the
 * one after must trip the budget (429). Any extra charge in between shifts
 * the 429 one request earlier. */
async function assertAuthFailBudgetUntouched(ip: string): Promise<void> {
  const thirtieth = await h.handler(userRequest("GET", "/v1/me", { token: "garbage-x", ip }));
  assertEquals(thirtieth.status, 401, "budget was charged by the attack request");
  await thirtieth.body?.cancel();
  const over = await h.handler(userRequest("GET", "/v1/me", { token: "garbage-y", ip }));
  assertEquals(over.status, 429, "probe is not sensitive: budget never tripped");
  assertEquals(over.headers.get("RateLimit-Limit"), String(AUTHFAIL_LIMIT));
  await over.body?.cancel();
}

const encoder = new TextEncoder();

// ─── S1: body stream aborted mid-way on /v1/auth/refresh ────────────────────

Deno.test(
  "S1: refresh whose body stream errors after a partial chunk → 400 validation.refresh, no GoTrue call, authfail NOT charged",
  async () => {
    await withFrozenClock(1_800_000_000_000, async () => {
      h.reset();
      const ip = freshIp();
      await spendAuthFailures(ip, AUTHFAIL_LIMIT - 1);
      const callsBefore = h.calls.length;

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"refreshToken":"rt-live-'));
        },
        pull(controller) {
          controller.error(new DOMException("The request body stream was aborted.", "AbortError"));
        },
      });
      const response = await h.handler(
        new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
          body,
        }),
      );
      assertEquals(response.status, 400);
      const error = await errorBody(response);
      assertEquals(error.code, "validation.refresh");
      assertEquals(h.calls.length, callsBefore, "no upstream call may follow an aborted body");
      assertEquals(h.callsTo("/auth/v1/token").length, 0);
      assert(response.headers.get("x-request-id"));

      await assertAuthFailBudgetUntouched(ip);
    });
  },
);

Deno.test(
  "S1b: refresh body that errors before the first byte, and one that errors AFTER a complete JSON document, both → 400 (truncated bodies are never acted on)",
  async () => {
    h.reset();
    const ip = freshIp();
    const variants: Array<[string, ReadableStream<Uint8Array>]> = [
      [
        "errors before first byte",
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new TypeError("network error"));
          },
        }),
      ],
      [
        "complete JSON then error",
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('{"refreshToken":"rt-complete"}'));
          },
          pull(controller) {
            controller.error(new DOMException("aborted", "AbortError"));
          },
        }),
      ],
    ];
    for (const [label, body] of variants) {
      const response = await h.handler(
        new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
          body,
        }),
      );
      assertEquals(response.status, 400, label);
      assertEquals((await errorBody(response)).code, "validation.refresh", label);
    }
    assertEquals(h.callsTo("/auth/v1/token").length, 0);
  },
);

Deno.test(
  "S1c: control — an intact refresh body reaches GoTrue exactly once and returns a session",
  async () => {
    h.reset();
    const response = await h.handler(
      new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": freshIp() },
        body: JSON.stringify({ refreshToken: "rt-live" }),
      }),
    );
    assertEquals(response.status, 200);
    const body = (await response.json()) as { session: { accessToken: string } };
    assertStringIncludes(body.session.accessToken, "session-for-");
    assertEquals(h.callsTo("/auth/v1/token").length, 1);
    assertEquals(h.callsTo("/auth/v1/token")[0]?.body, { refresh_token: "rt-live" });
  },
);

// ─── S2: bootstrap with a degenerate `sub` ──────────────────────────────────

Deno.test(
  "S2: bootstrap with sub '' → 401 'no subject', no Supabase Auth call, authfail charged",
  async () => {
    await withFrozenClock(1_800_000_100_000, async () => {
      h.reset();
      const ip = freshIp();
      const token = jwt({
        iss: "https://accounts.google.com",
        sub: "",
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      const response = await h.handler(
        userRequest("POST", "/v1/account/bootstrap", { token, ip, body: {} }),
      );
      assertEquals(response.status, 401);
      assertStringIncludes((await errorBody(response)).message, "no subject");
      assertEquals(h.callsTo("/auth/v1/").length, 0);
    });
  },
);

Deno.test(
  "S2: bootstrap with numeric sub (and with sub absent / null / object) → 401, no Supabase Auth call",
  async () => {
    h.reset();
    const ip = freshIp();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const subs: unknown[] = [1234567890, 0, null, { id: "x" }, ["a"], true];
    for (const sub of subs) {
      const payload: Record<string, unknown> = { iss: "https://accounts.google.com", exp };
      if (sub !== undefined) payload.sub = sub;
      const response = await h.handler(
        userRequest("POST", "/v1/account/bootstrap", { token: jwt(payload), ip, body: {} }),
      );
      assertEquals(response.status, 401, `sub=${JSON.stringify(sub)}`);
      assertStringIncludes((await errorBody(response)).message, "no subject");
    }
    const absent = await h.handler(
      userRequest("POST", "/v1/account/bootstrap", {
        token: jwt({ iss: "https://accounts.google.com", exp }),
        ip,
        body: {},
      }),
    );
    assertEquals(absent.status, 401);
    await absent.body?.cancel();
    assertEquals(h.callsTo("/auth/v1/").length, 0);
  },
);

// ─── S3: issuer routing is strict ───────────────────────────────────────────

Deno.test(
  "S3: bootstrap with iss 'https://accounts.google.com/' (trailing slash) and 'ACCOUNTS.GOOGLE.COM' → 401, no Supabase Auth call",
  async () => {
    h.reset();
    const ip = freshIp();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const issuers = [
      "https://accounts.google.com/",
      "ACCOUNTS.GOOGLE.COM",
      "https://ACCOUNTS.GOOGLE.COM",
      "http://accounts.google.com",
      "https://accounts.google.com.evil.example",
      "https://evil.example/accounts.google.com",
      "https://accounts.google.com\u0000",
      " https://accounts.google.com",
      "https://appleid.apple.com/",
      "HTTPS://appleid.apple.com",
      "https://accounts.gооgle.com", // Cyrillic о homoglyphs
      "",
      42,
      ["https://accounts.google.com"],
    ];
    for (const iss of issuers) {
      const response = await h.handler(
        userRequest("POST", "/v1/account/bootstrap", {
          token: jwt({ iss, sub: TEST_USER_ID, exp }),
          ip,
          body: {},
        }),
      );
      assertEquals(response.status, 401, `iss=${JSON.stringify(iss)}`);
      assertStringIncludes((await errorBody(response)).message, "not a Google or Apple ID token");
    }
    assertEquals(h.callsTo("/auth/v1/").length, 0);
  },
);

Deno.test(
  "S3b: the same strict issuer set is refused by authenticate() on every other route",
  async () => {
    h.reset();
    const ip = freshIp();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    for (const iss of [
      "https://accounts.google.com/",
      "ACCOUNTS.GOOGLE.COM",
      `${SUPABASE_URL}/auth/v1/`,
    ]) {
      const response = await h.handler(
        userRequest("GET", "/v1/me", { token: jwt({ iss, sub: TEST_USER_ID, exp }), ip }),
      );
      assertEquals(response.status, 401, `iss=${iss}`);
      await response.body?.cancel();
    }
    assertEquals(h.callsTo("/auth/v1/").length, 0);
  },
);

Deno.test(
  "S3c: control — the two exact issuers (with and without scheme, as Google actually emits) route to Supabase Auth once each",
  async () => {
    h.reset();
    const ip = freshIp();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    h.tables.profiles = [profileRow()];
    for (const iss of [
      "https://accounts.google.com",
      "accounts.google.com",
      "https://appleid.apple.com",
    ]) {
      h.calls = [];
      const response = await h.handler(
        userRequest("POST", "/v1/account/bootstrap", {
          token: jwt({ iss, sub: TEST_USER_ID, exp, jti: iss }),
          ip,
          body: {},
        }),
      );
      assertEquals(response.status, 200, `iss=${iss}`);
      await response.body?.cancel();
      assertEquals(h.callsTo("/auth/v1/token").length, 1, `iss=${iss}`);
    }
  },
);

// ─── S4: verified-session cache boundary ────────────────────────────────────

Deno.test(
  "S4: a cached auth entry with expiresAtMs exactly Date.now()+5_000 is a MISS (getUser re-verifies); +5_001 is a hit",
  async () => {
    await withFrozenClock(1_800_000_200_000, async (now) => {
      h.reset();
      h.tables.profiles = [profileRow()];
      const gotrue = stubGoTrue({ user: () => jsonResponse(200, gotrueUser()) });
      try {
        const cases: Array<[string, number, number]> = [
          ["exactly +5_000 → miss", now + 5_000, 1],
          ["+4_999 → miss", now + 4_999, 1],
          ["+5_001 → hit", now + 5_001, 0],
        ];
        for (const [label, expiresAtMs, expectedGetUser] of cases) {
          const token = supabaseAccessToken({ expSec: Math.floor(now / 1000) + 3600, jti: label });
          await cacheSet(
            `auth:${await sha256Hex(token)}`,
            JSON.stringify({
              userId: TEST_USER_ID,
              email: "user@example.com",
              provider: "google",
              accessToken: token,
              expiresAtMs,
            }),
            600,
          );
          gotrue.seen.user = 0;
          const response = await h.handler(userRequest("GET", "/v1/me", { token, ip: freshIp() }));
          assertEquals(response.status, 200, label);
          await response.body?.cancel();
          assertEquals(gotrue.seen.user, expectedGetUser, label);
        }
      } finally {
        gotrue.restore();
      }
    });
  },
);

Deno.test(
  "S4b: a cached entry for the OTHER provider, a corrupt JSON entry, and a non-object entry are all misses (never a 500)",
  async () => {
    await withFrozenClock(1_800_000_300_000, async (now) => {
      h.reset();
      h.tables.profiles = [profileRow()];
      const gotrue = stubGoTrue({ user: () => jsonResponse(200, gotrueUser()) });
      try {
        const exp = Math.floor(now / 1000) + 3600;
        const entries: Array<[string, string, string]> = [
          [
            "provider mismatch (google id token vs cached apple)",
            jwt({ iss: "https://accounts.google.com", sub: TEST_USER_ID, exp, jti: "mismatch" }),
            JSON.stringify({
              userId: TEST_USER_ID,
              email: null,
              provider: "apple",
              accessToken: "sb",
              expiresAtMs: now + 600_000,
            }),
          ],
          ["corrupt json", supabaseAccessToken({ expSec: exp, jti: "corrupt" }), "{not json"],
          ["number", supabaseAccessToken({ expSec: exp, jti: "number" }), "42"],
          ["null literal", supabaseAccessToken({ expSec: exp, jti: "null" }), "null"],
          [
            "missing expiresAtMs",
            supabaseAccessToken({ expSec: exp, jti: "noexp" }),
            JSON.stringify({ userId: TEST_USER_ID, provider: "google", accessToken: "sb" }),
          ],
        ];
        for (const [label, token, raw] of entries) {
          await cacheSet(`auth:${await sha256Hex(token)}`, raw, 600);
          h.calls = [];
          gotrue.seen.user = 0;
          const response = await h.handler(userRequest("GET", "/v1/me", { token, ip: freshIp() }));
          assertEquals(response.status, 200, label);
          await response.body?.cancel();
          const verified = gotrue.seen.user + h.callsTo("/auth/v1/token").length;
          assertEquals(verified, 1, `${label}: must re-verify upstream exactly once`);
        }
      } finally {
        gotrue.restore();
      }
    });
  },
);

// ─── S5: logout twice, GoTrue 204 then 404 ──────────────────────────────────

Deno.test(
  "S5: /v1/auth/logout twice with one bearer (GoTrue 204 then 404) → both 204; the cache was dropped so the 2nd call re-verifies via getUser",
  async () => {
    h.reset();
    const ip = freshIp();
    const token = supabaseAccessToken({ expSec: Math.floor(Date.now() / 1000) + 3600, jti: "s5" });
    const logoutStatuses = [204, 404];
    const gotrue = stubGoTrue({
      user: () => jsonResponse(200, gotrueUser()),
      logout: () => {
        const status = logoutStatuses.shift() ?? 404;
        return status === 204
          ? new Response(null, { status })
          : jsonResponse(status, {
              code: 404,
              error_code: "session_not_found",
              msg: "Session not found",
            });
      },
    });
    try {
      const first = await h.handler(userRequest("POST", "/v1/auth/logout", { token, ip }));
      assertEquals(first.status, 204);
      assertEquals(gotrue.seen.user, 1);
      assertEquals(gotrue.seen.logout, 1);
      assertEquals(
        await cacheGet(`auth:${await sha256Hex(token)}`),
        null,
        "bearer must be gone from the auth cache",
      );

      const second = await h.handler(userRequest("POST", "/v1/auth/logout", { token, ip }));
      assertEquals(second.status, 204);
      assertEquals(gotrue.seen.user, 2, "second logout must re-verify with getUser, not the cache");
      assertEquals(gotrue.seen.logout, 2);
      assertEquals(await cacheGet(`auth:${await sha256Hex(token)}`), null);
      // Both logout calls carried scope=local and the caller's own bearer.
      assertEquals(
        gotrue.seen.logoutUrls,
        Array(2).fill(`${SUPABASE_URL}/auth/v1/logout?scope=local`),
      );
      assertEquals(gotrue.seen.logoutBearers, Array(2).fill(`Bearer ${token}`));
    } finally {
      gotrue.restore();
    }
  },
);

Deno.test(
  "S5b: logout when getUser now says the session is gone (GoTrue 403 session_not_found) → 401 and NO logout call; GoTrue 5xx on logout → 503 with a generic body",
  async () => {
    h.reset();
    const ip = freshIp();
    const token = supabaseAccessToken({ expSec: Math.floor(Date.now() / 1000) + 3600, jti: "s5b" });
    let userStatus = 403;
    let logoutStatus = 204;
    const gotrue = stubGoTrue({
      user: () =>
        userStatus === 200
          ? jsonResponse(200, gotrueUser())
          : jsonResponse(403, {
              code: 403,
              error_code: "session_not_found",
              msg: "Session from session_id claim in JWT does not exist",
            }),
      logout: () => new Response(logoutStatus === 204 ? null : "boom", { status: logoutStatus }),
    });
    try {
      const gone = await h.handler(userRequest("POST", "/v1/auth/logout", { token, ip }));
      assertEquals(gone.status, 401);
      assertStringIncludes((await errorBody(gone)).message, "no longer valid");
      assertEquals(gotrue.seen.logout, 0);

      userStatus = 200;
      logoutStatus = 502;
      const failed = await h.handler(userRequest("POST", "/v1/auth/logout", { token, ip }));
      assertEquals(failed.status, 503);
      const body = await errorBody(failed);
      assertEquals(/502|boom/.test(body.message), false, "5xx body must stay generic");
      assertEquals(gotrue.seen.logout, 1);
      assertEquals(
        await cacheGet(`auth:${await sha256Hex(token)}`),
        null,
        "cache is dropped even when GoTrue fails",
      );
    } finally {
      gotrue.restore();
    }
  },
);

Deno.test(
  "S5c: 8 concurrent logouts with the same bearer all settle 204 (or 503 only on 5xx), never 500, and every one reaches GoTrue",
  async () => {
    h.reset();
    const ip = freshIp();
    const token = supabaseAccessToken({ expSec: Math.floor(Date.now() / 1000) + 3600, jti: "s5c" });
    const gotrue = stubGoTrue({
      user: () => jsonResponse(200, gotrueUser()),
      logout: () => new Response(null, { status: 204 }),
    });
    try {
      const responses = await Promise.all(
        Array.from({ length: 8 }, () =>
          h.handler(userRequest("POST", "/v1/auth/logout", { token, ip })),
        ),
      );
      assertEquals(
        responses.map((r) => r.status),
        Array(8).fill(204),
      );
      assertEquals(gotrue.seen.logout, 8);
      assertEquals(await cacheGet(`auth:${await sha256Hex(token)}`), null);
    } finally {
      gotrue.restore();
    }
  },
);

// ─── S6: logout with a bearer whose exp passed 1 s ago ──────────────────────

Deno.test(
  "S6 (pinned decision): logout with a bearer expired 1 s ago → 401 'session token has expired'; GoTrue logout is NOT called (refresh token stays live) and the per-IP authfail budget IS charged",
  async () => {
    await withFrozenClock(1_800_000_400_000, async (now) => {
      h.reset();
      const ip = freshIp();
      await spendAuthFailures(ip, AUTHFAIL_LIMIT - 2);
      const token = supabaseAccessToken({ expSec: Math.floor(now / 1000) - 1, jti: "s6" });
      const gotrue = stubGoTrue({
        user: () => jsonResponse(200, gotrueUser()),
        logout: () => new Response(null, { status: 204 }),
      });
      try {
        const response = await h.handler(userRequest("POST", "/v1/auth/logout", { token, ip }));
        assertEquals(response.status, 401);
        assertStringIncludes((await errorBody(response)).message, "session token has expired");
        assertEquals(gotrue.seen.user, 0, "expired bearers are refused before Supabase Auth");
        assertEquals(gotrue.seen.logout, 0, "the device session is NOT revoked server-side");
        // The 401 counted as an auth failure: with 28 warm-ups + this one the
        // budget sits at 29, so exactly one more failure is admitted.
        await assertAuthFailBudgetUntouched(ip);
      } finally {
        gotrue.restore();
      }
    });
  },
);

Deno.test(
  "S6b: an expired bearer that is still in the auth cache is refused from exp alone (cache is never consulted) — and exp exactly == now is expired",
  async () => {
    await withFrozenClock(1_800_000_500_000, async (now) => {
      h.reset();
      const gotrue = stubGoTrue({ user: () => jsonResponse(200, gotrueUser()) });
      try {
        for (const [label, expSec] of [
          ["exp == now", now / 1000],
          ["exp 1s ago", now / 1000 - 1],
        ] as Array<[string, number]>) {
          const token = supabaseAccessToken({ expSec, jti: label });
          await cacheSet(
            `auth:${await sha256Hex(token)}`,
            JSON.stringify({
              userId: TEST_USER_ID,
              email: null,
              provider: "google",
              accessToken: token,
              expiresAtMs: now + 600_000,
            }),
            600,
          );
          const response = await h.handler(userRequest("GET", "/v1/me", { token, ip: freshIp() }));
          assertEquals(response.status, 401, label);
          await response.body?.cancel();
          assertEquals(gotrue.seen.user, 0, label);
        }
      } finally {
        gotrue.restore();
      }
    });
  },
);

// ─── S7 companion (held part): the bearer that confirmed deletion is dead ──

Deno.test(
  "S7a: after delete-confirm the CONFIRMING bearer is evicted from the cache and must re-verify (getUser says the user is gone → 401)",
  async () => {
    h.reset();
    const ip = freshIp();
    const token = supabaseAccessToken({ expSec: Math.floor(Date.now() / 1000) + 3600, jti: "s7a" });
    const challenge = "77777777-7777-4777-8777-777777777777";
    h.tables.account_deletion_requests = [
      {
        challenge,
        created_at: new Date(Date.now() - 10_000).toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    ];
    h.tables.account_external_credentials = [];
    h.tables.profiles = [profileRow()];
    let userDeleted = false;
    const gotrue = stubGoTrue({
      user: () =>
        userDeleted
          ? jsonResponse(403, {
              code: 403,
              error_code: "user_not_found",
              msg: "User from sub claim in JWT does not exist",
            })
          : jsonResponse(200, gotrueUser()),
    });
    try {
      // Warm the cache for this bearer, then delete.
      const me = await h.handler(userRequest("GET", "/v1/me", { token, ip }));
      assertEquals(me.status, 200);
      await me.body?.cancel();
      assertEquals(gotrue.seen.user, 1);

      const deleted = await h.handler(
        userRequest("POST", "/v1/me/delete-confirm", { token, ip, body: { challenge } }),
      );
      assertEquals(deleted.status, 200);
      assertEquals(((await deleted.json()) as { deleted: boolean }).deleted, true);
      assertEquals(gotrue.seen.user, 1, "delete-confirm itself was served from the warm cache");
      assertEquals(await cacheGet(`auth:${await sha256Hex(token)}`), null);

      userDeleted = true;
      h.tables.profiles = [];
      const after = await h.handler(userRequest("GET", "/v1/me", { token, ip }));
      assertEquals(after.status, 401);
      await after.body?.cancel();
      assertEquals(
        gotrue.seen.user,
        2,
        "the confirming bearer is re-verified, not served from cache",
      );
    } finally {
      gotrue.restore();
    }
  },
);

// ─── Extra: refresh validation + GoTrue failure classes ─────────────────────

Deno.test(
  "E1: refresh with whitespace-only / non-string / oversized refreshToken → 400 and no GoTrue call; GoTrue 400 invalid_grant → 401 (charged exactly once)",
  async () => {
    await withFrozenClock(1_800_000_600_000, async () => {
      h.reset();
      const ip = freshIp();
      await spendAuthFailures(ip, AUTHFAIL_LIMIT - 2);
      const refresh = (body: BodyInit, extraHeaders: Record<string, string> = {}) =>
        h.handler(
          new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-forwarded-for": ip, ...extraHeaders },
            body,
          }),
        );

      const gotrue = stubGoTrue({
        token: () =>
          jsonResponse(400, {
            code: 400,
            error_code: "refresh_token_not_found",
            msg: "Invalid Refresh Token: Refresh Token Not Found",
          }),
      });
      try {
        const invalid: Array<[string, string]> = [
          ["whitespace only", JSON.stringify({ refreshToken: " \t\n" })],
          ["number", JSON.stringify({ refreshToken: 12345 })],
          ["array", JSON.stringify({ refreshToken: ["rt"] })],
          ["object", JSON.stringify({ refreshToken: { rt: "x" } })],
          ["null", JSON.stringify({ refreshToken: null })],
          ["top-level array", JSON.stringify([{ refreshToken: "rt" }])],
          ["top-level string", JSON.stringify("rt")],
          ["empty body", ""],
          ["unicode key homoglyph", JSON.stringify({ refreshTokеn: "rt" })], // Cyrillic е
        ];
        for (const [label, body] of invalid) {
          const response = await refresh(body);
          assertEquals(response.status, 400, label);
          assertEquals((await errorBody(response)).code, "validation.refresh", label);
        }
        assertEquals(gotrue.seen.token, 0);

        // Over the 5 MB JSON body cap: refused with 413 before any parsing.
        const tooLarge = await refresh(JSON.stringify({ refreshToken: "x".repeat(5_000_001) }));
        assertEquals(tooLarge.status, 413);
        await tooLarge.body?.cancel();
        assertEquals(gotrue.seen.token, 0);

        // GoTrue rejects the grant → 401, and that 401 IS an auth failure.
        const rejected = await refresh(JSON.stringify({ refreshToken: "rt-revoked" }));
        assertEquals(rejected.status, 401);
        assertStringIncludes((await errorBody(rejected)).message, "Sign in again");
        assertEquals(gotrue.seen.token, 1, "a 4xx from GoTrue is final — no retry");

        // Budget: 28 warm-ups + the one 401 above = 29 → exactly one more 401 admitted
        // (i.e. the nine 400s and the 413 above charged nothing).
        await assertAuthFailBudgetUntouched(ip);
      } finally {
        gotrue.restore();
      }
    });
  },
);

// ─── Extra: request-id contract survives every status class ─────────────────

Deno.test(
  "E2: a well-formed client x-request-id is echoed on 400/401/413/429/204 alike; malformed ones (65 chars, unicode, spaces, 7 chars) are replaced by a UUID",
  async () => {
    await withFrozenClock(1_800_000_700_000, async (now) => {
      h.reset();
      const ip = freshIp();
      const good = "client-req.0123456789_ABC";
      const gotrue = stubGoTrue({
        user: () => jsonResponse(200, gotrueUser()),
        logout: () => new Response(null, { status: 204 }),
      });
      try {
        const token = supabaseAccessToken({ expSec: Math.floor(now / 1000) + 3600, jti: "e2" });
        const probes: Array<[string, Promise<Response>, number]> = [
          [
            "401",
            h.handler(
              userRequest("GET", "/v1/me", {
                token: "garbage",
                ip,
                headers: { "x-request-id": good },
              }),
            ),
            401,
          ],
          [
            "400",
            h.handler(
              new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
                method: "POST",
                headers: { "x-forwarded-for": ip, "x-request-id": good },
                body: "{}",
              }),
            ),
            400,
          ],
          [
            "413",
            h.handler(
              new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
                method: "POST",
                headers: {
                  "x-forwarded-for": ip,
                  "x-request-id": good,
                  "content-length": "9999999",
                },
                body: "{}",
              }),
            ),
            413,
          ],
          [
            "204",
            h.handler(
              userRequest("POST", "/v1/auth/logout", {
                token,
                ip,
                headers: { "x-request-id": good },
              }),
            ),
            204,
          ],
        ];
        for (const [label, pending, status] of probes) {
          const response = await pending;
          assertEquals(response.status, status, label);
          assertEquals(response.headers.get("x-request-id"), good, label);
          await response.body?.cancel();
        }
        // 429 (auth-failure budget tripped) still carries the client id.
        await spendAuthFailures(ip, AUTHFAIL_LIMIT - 1);
        const limited = await h.handler(
          userRequest("GET", "/v1/me", { token: "garbage", ip, headers: { "x-request-id": good } }),
        );
        assertEquals(limited.status, 429);
        assertEquals(limited.headers.get("x-request-id"), good);
        await limited.body?.cancel();

        const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
        for (const bad of [
          "a".repeat(65),
          "short7c",
          "has space inside",
          "unicodé-request-id",
          "semi;colon-injection",
          "",
        ]) {
          const response = await h.handler(
            userRequest("GET", "/healthz", { ip: freshIp(), headers: { "x-request-id": bad } }),
          );
          const id = response.headers.get("x-request-id") ?? "";
          assert(
            uuidRe.test(id),
            `x-request-id ${JSON.stringify(bad)} must be replaced, got ${id}`,
          );
          assert(id !== bad);
          await response.body?.cancel();
        }
      } finally {
        gotrue.restore();
      }
    });
  },
);

// ─── Extra: cold-cache stampede is bounded only by client concurrency (pinned) ─

Deno.test(
  "E3 (pinned): N concurrent first requests with one fresh bearer each verify with getUser while GoTrue is slow (no auth single-flight) and then share one cache entry",
  async () => {
    h.reset();
    h.tables.profiles = [profileRow()];
    const token = supabaseAccessToken({ expSec: Math.floor(Date.now() / 1000) + 3600, jti: "e3" });
    // A real GoTrue round trip takes tens of ms; a synchronous stub would let
    // the first handler write the cache before the others even read it.
    const inner = globalThis.fetch;
    const gotrue = stubGoTrue({ user: () => jsonResponse(200, gotrueUser()) });
    const stubbed = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === "/auth/v1/user")
        await new Promise((r) => setTimeout(r, 20));
      return stubbed(request);
    }) as typeof fetch;
    try {
      const burst = await Promise.all(
        Array.from({ length: 12 }, () =>
          h.handler(userRequest("GET", "/v1/me", { token, ip: freshIp() })),
        ),
      );
      assertEquals(
        burst.map((r) => r.status),
        Array(12).fill(200),
      );
      for (const r of burst) await r.body?.cancel();
      assertEquals(gotrue.seen.user, 12, "current behaviour: every concurrent miss goes upstream");
      const warm = await h.handler(userRequest("GET", "/v1/me", { token, ip: freshIp() }));
      assertEquals(warm.status, 200);
      await warm.body?.cancel();
      assertEquals(gotrue.seen.user, 12, "once written, the cache absorbs the next request");
    } finally {
      globalThis.fetch = inner;
    }
  },
);

// ─── Extra: fixed-window boundary burst (pinned property of rateLimit.ts) ───

Deno.test(
  "E4 (pinned): the per-IP refresh budget is a wall-clock-aligned fixed window — 30 requests at t=59.999 s and 30 at t=60.000 s are all admitted",
  async () => {
    h.reset();
    const ip = freshIp();
    const realNow = Date.now;
    const windowStart = 1_800_000_900_000; // multiple of 60_000
    try {
      Date.now = () => windowStart + 59_999;
      const late = await Promise.all(
        Array.from({ length: 31 }, () =>
          h.handler(
            new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
              body: "{}",
            }),
          ),
        ),
      );
      assertEquals(late.map((r) => r.status).filter((s) => s === 400).length, 30);
      assertEquals(late.map((r) => r.status).filter((s) => s === 429).length, 1);
      const limited = late.find((r) => r.status === 429)!;
      assertEquals(limited.headers.get("Retry-After"), "1");
      for (const r of late) await r.body?.cancel();

      Date.now = () => windowStart + 60_000;
      const early = await Promise.all(
        Array.from({ length: 30 }, () =>
          h.handler(
            new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
              body: "{}",
            }),
          ),
        ),
      );
      assertEquals(
        early.map((r) => r.status),
        Array(30).fill(400),
      );
      for (const r of early) await r.body?.cancel();
    } finally {
      Date.now = realNow;
    }
  },
);

// ─── Extra: logout with a transitional provider-token bearer (pinned) ───────

Deno.test(
  "E5 (pinned): logout bearing a Google ID token (transitional branch) answers 204 although GoTrue rejects the bearer and the session minted by authenticate() is never revoked",
  async () => {
    h.reset();
    const ip = freshIp();
    const token = jwt({
      iss: "https://accounts.google.com",
      sub: TEST_USER_ID,
      exp: Math.floor(Date.now() / 1000) + 3600,
      jti: "e5",
    });
    const gotrue = stubGoTrue({
      logout: (request) =>
        request.headers.get("authorization") === `Bearer ${token}`
          ? jsonResponse(401, {
              code: 401,
              error_code: "bad_jwt",
              msg: "invalid JWT: unable to parse or verify signature",
            })
          : new Response(null, { status: 204 }),
    });
    try {
      const response = await h.handler(userRequest("POST", "/v1/auth/logout", { token, ip }));
      assertEquals(response.status, 204);
      assertEquals(
        h.callsTo("/auth/v1/token").length,
        1,
        "authenticate() minted a Supabase session via signInWithIdToken",
      );
      assertEquals(gotrue.seen.logout, 1);
      assertEquals(
        gotrue.seen.logoutBearers,
        [`Bearer ${token}`],
        "the PROVIDER token is what reaches GoTrue logout",
      );
      assertEquals(await cacheGet(`auth:${await sha256Hex(token)}`), null);
    } finally {
      gotrue.restore();
    }
  },
);
