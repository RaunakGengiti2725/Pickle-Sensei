// INT-auth-session adversary (integration head 30a40650) — edge side.
//
// Attacks the session routes of the real handler through sessionHarness:
// explicit sign-out with a dead bearer, malformed refresh inputs, the same
// rotating credential presented concurrently and replayed, GoTrue answers
// whose expiry is skewed, and L2 auth-cache rows that are malformed or claim a
// different identity than the bearer they are keyed by.
//
// Tests named `REPRO (defect)` assert the behaviour observed at the attacked
// head so the finding is executable; the contract they contradict is stated
// in the title. Everything else pins behaviour that held under attack.
//
//   cd supabase/functions/api/__wf__ &&
//   deno test -A --no-check --config deno.json xc_adv_auth_session.test.ts

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  apiRequest,
  APPLE_USER_ID,
  errorMessage,
  freshIp,
  GOOGLE_USER_ID,
  loadSessionHarness,
  type SessionHarness,
  withClockOffset,
} from "./sessionHarness.ts";

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const authCacheKey = async (token: string): Promise<string> => `auth:${await sha256Hex(token)}`;

interface SessionView {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

async function refresh(h: SessionHarness, refreshToken: unknown, ip = freshIp()) {
  const response = await h.handler(
    apiRequest("POST", "/v1/auth/refresh", { ip, body: { refreshToken } }),
  );
  const body = (await response.json()) as { session?: SessionView; error?: { message: string } };
  return { response, body };
}

async function me(h: SessionHarness, token: string): Promise<Response> {
  const response = await h.handler(apiRequest("GET", "/v1/me", { token }));
  await response.body?.cancel();
  return response;
}

function gotrueLogoutCalls(h: SessionHarness) {
  return h.callsTo("/auth/v1/logout");
}

function gotrueRefreshCalls(h: SessionHarness) {
  return h.callsTo("grant_type=refresh_token");
}

function authFailureIncrements(h: SessionHarness): number {
  return h.redisCommands.filter(
    (command) => command[0] === "INCR" && String(command[1]).includes("authfail"),
  ).length;
}

// ─── Attack 1: explicit sign-out with a bearer that is no longer live ────────

Deno.test(
  "REPRO (defect): logout with an EXPIRED bearer of a live session is refused 401 before GoTrue is asked — the device's refresh token keeps working, so an online explicit sign-out revokes nothing",
  async () => {
    const h = await loadSessionHarness({ redis: true });
    const minted = h.mintSession(GOOGLE_USER_ID, 1);
    const ip = freshIp();
    const incrementsBefore = authFailureIncrements(h);
    const response = await withClockOffset(
      5_000,
      () => h.handler(apiRequest("POST", "/v1/auth/logout", { token: minted.accessToken, ip })),
    );
    assertEquals(response.status, 401);
    await response.body?.cancel();
    assertEquals(gotrueLogoutCalls(h).length, 0, "GoTrue logout is never reached");
    // The refresh token the app just deleted locally is still honoured
    // server-side: the session survived the sign-out.
    const rotated = await refresh(h, minted.refreshToken);
    assertEquals(rotated.response.status, 200);
    assert(rotated.body.session, "the session still rotates after the failed sign-out");
    // And the sign-out attempt was counted as an auth FAILURE against the IP.
    assertEquals(authFailureIncrements(h) - incrementsBefore, 1);
  },
);

Deno.test(
  "logout with a bearer the session no longer has (rotated away, GoTrue refuses) is 401 and does not touch the successor session",
  async () => {
    const h = await loadSessionHarness({ redis: true });
    const minted = h.mintSession(GOOGLE_USER_ID);
    const rotated = await refresh(h, minted.refreshToken);
    assertEquals(rotated.response.status, 200);
    const response = await h.handler(
      apiRequest("POST", "/v1/auth/logout", { token: minted.accessToken }),
    );
    assertEquals(response.status, 401);
    await response.body?.cancel();
    assertEquals((await me(h, rotated.body.session!.accessToken)).status, 200);
  },
);

Deno.test(
  "logout right after a rotation, using the NEW bearer, kills the whole GoTrue session including the rotated refresh token",
  async () => {
    const h = await loadSessionHarness({ redis: true });
    const minted = h.mintSession(GOOGLE_USER_ID);
    const rotated = await refresh(h, minted.refreshToken);
    const session = rotated.body.session!;
    const response = await h.handler(
      apiRequest("POST", "/v1/auth/logout", { token: session.accessToken }),
    );
    assertEquals(response.status, 204);
    const replay = await refresh(h, session.refreshToken);
    assertEquals(replay.response.status, 401);
    assertEquals((await me(h, session.accessToken)).status, 401);
  },
);

// ─── Attack 2: malformed refresh inputs ──────────────────────────────────────

Deno.test("refresh rejects every malformed refreshToken shape with 400 and never consults GoTrue", async () => {
  const h = await loadSessionHarness({ redis: true });
  const shapes: unknown[] = [
    undefined,
    null,
    "",
    "   ",
    123,
    true,
    ["rt-a"],
    { refresh_token: "rt-a" },
    "x".repeat(4_097),
  ];
  for (const shape of shapes) {
    const before = gotrueRefreshCalls(h).length;
    const { response } = await refresh(h, shape);
    assertEquals(response.status, 400, `shape ${JSON.stringify(shape)?.slice(0, 40)}`);
    assertEquals(gotrueRefreshCalls(h).length, before, "GoTrue is not asked");
  }
});

Deno.test("refresh rejects a non-object / non-JSON body with 400 and never consults GoTrue", async () => {
  const h = await loadSessionHarness({ redis: true });
  const bodies = ["not json", "[]", '"rt-a"', "42", '{"refreshToken":'];
  for (const raw of bodies) {
    const before = gotrueRefreshCalls(h).length;
    const response = await h.handler(
      new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": freshIp() },
        body: raw,
      }),
    );
    assertEquals(response.status, 400, `body ${raw}`);
    await response.body?.cancel();
    assertEquals(gotrueRefreshCalls(h).length, before);
  }
});

Deno.test("refresh trims surrounding whitespace before presenting the token (happy path with sloppy input)", async () => {
  const h = await loadSessionHarness({ redis: true });
  const minted = h.mintSession(APPLE_USER_ID);
  const { response, body } = await refresh(h, `  ${minted.refreshToken}\n`);
  assertEquals(response.status, 200);
  assertEquals(gotrueRefreshCalls(h).at(-1)?.body, { refresh_token: minted.refreshToken });
  assertEquals((await me(h, body.session!.accessToken)).status, 200);
});

Deno.test("a stray Authorization header on refresh is ignored: the body's refresh token decides, not the bearer", async () => {
  const h = await loadSessionHarness({ redis: true });
  const a = h.mintSession(GOOGLE_USER_ID);
  const b = h.mintSession(APPLE_USER_ID);
  const response = await h.handler(
    apiRequest("POST", "/v1/auth/refresh", {
      token: a.accessToken,
      body: { refreshToken: b.refreshToken },
    }),
  );
  const body = (await response.json()) as { session?: SessionView };
  assertEquals(response.status, 200);
  assertEquals(h.sessions.get(body.session!.accessToken)?.userId, APPLE_USER_ID);
  assertEquals(h.refreshTokens.get(a.refreshToken)?.spent, false, "A's credential untouched");
});

// ─── Attack 3: the same rotating credential presented concurrently / replayed ─

Deno.test("the same refresh token presented 5x concurrently yields at most one 200, the rest 401, never 5xx; the winner is usable", async () => {
  const h = await loadSessionHarness({ redis: true });
  const minted = h.mintSession(GOOGLE_USER_ID);
  const results = await Promise.all(
    Array.from({ length: 5 }, () => refresh(h, minted.refreshToken)),
  );
  const statuses = results.map((r) => r.response.status).sort();
  const wins = results.filter((r) => r.response.status === 200);
  assert(wins.length <= 1, `at most one rotation: ${statuses.join(",")}`);
  for (const r of results) assert(r.response.status < 500, `no 5xx: ${statuses.join(",")}`);
  for (const r of results.filter((r) => r.response.status !== 200)) {
    assertEquals(r.response.status, 401);
  }
  if (wins.length === 1) {
    assertEquals((await me(h, wins[0].body.session!.accessToken)).status, 200);
  }
});

Deno.test("replaying a spent refresh token is 401 and counts as an auth failure; the successor credential is untouched", async () => {
  const h = await loadSessionHarness({ redis: true });
  const minted = h.mintSession(GOOGLE_USER_ID);
  const first = await refresh(h, minted.refreshToken);
  assertEquals(first.response.status, 200);
  const before = authFailureIncrements(h);
  const replay = await refresh(h, minted.refreshToken);
  assertEquals(replay.response.status, 401);
  assertEquals(authFailureIncrements(h) - before, 1);
  const second = await refresh(h, first.body.session!.refreshToken);
  assertEquals(second.response.status, 200);
  assertNotEquals(second.body.session!.refreshToken, first.body.session!.refreshToken);
});

// ─── Attack 4: GoTrue answers with skewed / inconsistent expiry ──────────────

Deno.test("a refreshed session whose expires_at is far in the future (ms instead of s) is passed through — the app must clamp, the edge does not (characterisation)", async () => {
  const h = await loadSessionHarness({ redis: true });
  const minted = h.mintSession(GOOGLE_USER_ID);
  // A session with an absurd lifetime: GoTrue's expires_at is unix SECONDS; a
  // misconfigured upstream that answered milliseconds would pass validSession.
  h.accessTokenTtlSeconds = Date.now(); // expires_at ≈ now + now ≈ 2*now (a ms-scale number)
  try {
    const { response, body } = await refresh(h, minted.refreshToken);
    assertEquals(response.status, 200);
    assert(body.session!.expiresAt > Math.floor(Date.now() / 1000) + 400 * 365 * 86_400);
  } finally {
    h.accessTokenTtlSeconds = 3600;
  }
});

Deno.test("a refreshed session with a 1-second lifetime is still a rotation (not dead on arrival) and its bearer authenticates once, then expires", async () => {
  const h = await loadSessionHarness({ redis: true });
  const minted = h.mintSession(GOOGLE_USER_ID);
  h.accessTokenTtlSeconds = 2;
  try {
    const { response, body } = await refresh(h, minted.refreshToken);
    assertEquals(response.status, 200);
    assertEquals((await me(h, body.session!.accessToken)).status, 200);
    const later = await withClockOffset(3_000, () => me(h, body.session!.accessToken));
    assertEquals(later.status, 401);
    // The rotated refresh token still works after the bearer died.
    const again = await withClockOffset(3_000, () => refresh(h, body.session!.refreshToken));
    assertEquals(again.response.status, 200);
  } finally {
    h.accessTokenTtlSeconds = 3600;
  }
});

Deno.test("the edge's own clock running 10 minutes behind GoTrue does not refuse a bearer whose exp is still ahead of the edge clock", async () => {
  const h = await loadSessionHarness({ redis: true });
  const minted = h.mintSession(GOOGLE_USER_ID, 3600);
  const response = await withClockOffset(-600_000, () => me(h, minted.accessToken));
  assertEquals(response.status, 200);
});

Deno.test("the edge's clock running 2 hours AHEAD refuses a 1-hour bearer as expired (401) without asking GoTrue, but the refresh token rotates — the app recovers by refreshing, not by signing out", async () => {
  const h = await loadSessionHarness({ redis: true });
  const minted = h.mintSession(GOOGLE_USER_ID, 3600);
  const getUserBefore = h.callsTo("/auth/v1/user").length;
  const response = await withClockOffset(7_200_000, () => me(h, minted.accessToken));
  assertEquals(response.status, 401);
  assertEquals(h.callsTo("/auth/v1/user").length, getUserBefore);
  const rotated = await withClockOffset(7_200_000, () => refresh(h, minted.refreshToken));
  assertEquals(rotated.response.status, 200);
});

// ─── Attack 5: malformed / hostile L2 auth-cache rows ────────────────────────

Deno.test("malformed L2 auth-cache rows are never trusted and never crash: each falls back to a real verification and the bearer's own identity", async () => {
  const h = await loadSessionHarness({ redis: true });
  const minted = h.mintSession(GOOGLE_USER_ID);
  const key = await authCacheKey(minted.accessToken);
  const far = Date.now() + 9 * 60_000;
  const rows: Array<[string, string]> = [
    ["garbage", "not json at all"],
    ["empty object", "{}"],
    ["array", "[1,2,3]"],
    ["null", "null"],
    ["number", "42"],
    [
      "expiresAtMs as string",
      JSON.stringify({
        userId: GOOGLE_USER_ID,
        email: null,
        provider: "google",
        accessToken: minted.accessToken,
        expiresAtMs: String(far),
      }),
    ],
    [
      "expiresAtMs NaN",
      JSON.stringify({
        userId: GOOGLE_USER_ID,
        email: null,
        provider: "google",
        accessToken: minted.accessToken,
        expiresAtMs: "NaN",
      }),
    ],
    [
      "expired row",
      JSON.stringify({
        userId: GOOGLE_USER_ID,
        email: null,
        provider: "google",
        accessToken: minted.accessToken,
        expiresAtMs: Date.now() - 1,
      }),
    ],
    [
      "provider mismatch",
      JSON.stringify({
        userId: GOOGLE_USER_ID,
        email: null,
        provider: "apple",
        accessToken: minted.accessToken,
        expiresAtMs: far,
      }),
    ],
    [
      "missing userId",
      JSON.stringify({
        email: null,
        provider: "google",
        accessToken: minted.accessToken,
        expiresAtMs: far,
      }),
    ],
    [
      "missing accessToken",
      JSON.stringify({ userId: GOOGLE_USER_ID, email: null, provider: "google", expiresAtMs: far }),
    ],
  ];
  for (const [label, value] of rows) {
    h.redis.set(key, { value, expiresAtMs: Infinity });
    const response = await h.handler(apiRequest("GET", "/v1/me", { token: minted.accessToken }));
    assert(response.status < 500, `${label}: no 5xx (got ${response.status})`);
    if (response.status === 200) {
      const body = (await response.json()) as { user?: { id?: string } };
      assertEquals(body.user?.id, GOOGLE_USER_ID, `${label}: identity comes from the bearer`);
    } else {
      await response.body?.cancel();
    }
    // The verification must have been re-done or refused, never served from
    // the malformed row as-is.
    h.redis.delete(key);
  }
});

Deno.test("REPRO (defect, P3 defense-in-depth): an L2 auth-cache row that claims ANOTHER user's id for a valid bearer is accepted without re-verification — authed.id (the per-user budget key, service-role writes) follows the row, not the JWT sub", async () => {
  const h = await loadSessionHarness({ redis: true });
  const minted = h.mintSession(GOOGLE_USER_ID);
  const key = await authCacheKey(minted.accessToken);
  h.redis.set(key, {
    value: JSON.stringify({
      userId: APPLE_USER_ID,
      email: "apple@example.com",
      provider: "google",
      accessToken: minted.accessToken,
      expiresAtMs: Date.now() + 9 * 60_000,
    }),
    expiresAtMs: Infinity,
  });
  const getUserBefore = h.callsTo("/auth/v1/user").length;
  const commandsBefore = h.redisCommands.length;
  const response = await h.handler(apiRequest("GET", "/v1/me", { token: minted.accessToken }));
  assertEquals(response.status, 200);
  await response.body?.cancel();
  // Observed: the row is trusted as-is (no GoTrue verification) and the
  // request is budgeted — i.e. attributed — to the OTHER user's id. Row data
  // itself still flows through the bearer's own JWT (RLS), so the fake's
  // /v1/me body is not a witness; the identity confusion is in `authed.id`.
  assertEquals(h.callsTo("/auth/v1/user").length, getUserBefore);
  const userBudgetKeys = h.redisCommands
    .slice(commandsBefore)
    .filter((command) => command[0] === "INCR" && String(command[1]).startsWith("rl:user:"))
    .map((command) => String(command[1]));
  assertEquals(userBudgetKeys.length, 1);
  assert(userBudgetKeys[0].endsWith(`:${APPLE_USER_ID}`), userBudgetKeys[0]);
});

Deno.test("a poisoned L2 row for a bearer of a LOGGED-OUT session is refused by the revocation fence regardless of its contents", async () => {
  const h = await loadSessionHarness({ redis: true });
  const minted = h.mintSession(GOOGLE_USER_ID);
  const sibling = h.mintSession(GOOGLE_USER_ID, 3600, {
    sessionId: h.sessionIdOf(minted.accessToken),
  });
  const logout = await h.handler(
    apiRequest("POST", "/v1/auth/logout", { token: minted.accessToken }),
  );
  assertEquals(logout.status, 204);
  h.redis.set(await authCacheKey(sibling.accessToken), {
    value: JSON.stringify({
      userId: GOOGLE_USER_ID,
      email: null,
      provider: "google",
      accessToken: sibling.accessToken,
      expiresAtMs: Date.now() + 9 * 60_000,
    }),
    expiresAtMs: Infinity,
  });
  assertEquals((await me(h, sibling.accessToken)).status, 401);
});

// ─── Attack 6: Redis outage during the session routes ────────────────────────

Deno.test("with Redis answering garbage, bootstrap-issued bearers still authenticate and refresh still rotates (cache is an optimisation, not an authority)", async () => {
  const h = await loadSessionHarness({ redis: true });
  const minted = h.mintSession(GOOGLE_USER_ID);
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("upstash.session.test")) {
      return Promise.resolve(new Response("<html>502 Bad Gateway</html>", { status: 502 }));
    }
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    assertEquals((await me(h, minted.accessToken)).status, 200);
    const rotated = await refresh(h, minted.refreshToken);
    assertEquals(rotated.response.status, 200);
    assertEquals((await me(h, rotated.body.session!.accessToken)).status, 200);
    const logout = await h.handler(
      apiRequest("POST", "/v1/auth/logout", { token: rotated.body.session!.accessToken }),
    );
    assertEquals(logout.status, 204);
    assertEquals((await me(h, rotated.body.session!.accessToken)).status, 401);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("logout answered 404 by GoTrue (session already gone) is 204 for the app and the bearer is fenced locally", async () => {
  const h = await loadSessionHarness({ redis: true });
  const minted = h.mintSession(GOOGLE_USER_ID);
  assertEquals((await me(h, minted.accessToken)).status, 200);
  h.logoutStatus = 404;
  const response = await h.handler(
    apiRequest("POST", "/v1/auth/logout", { token: minted.accessToken }),
  );
  assertEquals(response.status, 204);
  h.logoutStatus = null;
  assertEquals((await me(h, minted.accessToken)).status, 401);
  assertEquals(
    await errorMessage(await h.handler(apiRequest("GET", "/v1/me", { token: minted.accessToken }))),
    "The session is no longer valid. Sign in again.",
  );
});
