// Execution probes for authentication(): bootstrap / refresh / logout, the
// verified-session cache, pre-auth rate limits, request ids and http helpers,
// all driven through the REAL edge handler against a local fake GoTrue.
//
// Run (repo root):
//   cd tools/audit/edge-auth-cache-ratelimit && deno task probe:routes
//
// Tests tagged [observed] pin CURRENT behaviour that differs from the
// documented contract (they are evidence for a finding, not an endorsement).
// Order-independent: every test resets the fake, uses a fresh client IP and
// fresh tokens, so `--shuffle` must pass.

import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import {
  accessLog,
  appleIdToken,
  boot,
  call,
  errorBody,
  freshIp,
  googleIdToken,
  profileRow,
  resetState,
  sessionToken,
  state,
} from "./fakeGoTrue.ts";

// Boot once at module load (the fake listener is unref'd, so no test has to
// tear it down and the file stays order-independent under --shuffle).
await boot();

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUTH_FAILURE_LIMIT = 30;
const AUTH_REFRESH_LIMIT = 30;
const PUBLIC_PAGE_LIMIT = 60;
const GENERAL_USER_LIMIT = 240;
const IP_LIMIT = 1_200;

function newUser(): string {
  const id = crypto.randomUUID();
  state.profiles.set(id, profileRow(id));
  return id;
}

function assertRateLimited(
  res: Response,
  limit: number,
  windowSeconds: number,
): void {
  assertEquals(res.status, 429);
  assertEquals(res.headers.get("RateLimit-Limit"), String(limit));
  assertEquals(res.headers.get("RateLimit-Remaining"), "0");
  assertEquals(res.headers.get("Cache-Control"), "no-store");
  assertEquals(res.headers.get("X-Content-Type-Options"), "nosniff");
  const retryAfter = Number(res.headers.get("Retry-After"));
  assert(
    retryAfter >= 1 && retryAfter <= windowSeconds,
    `Retry-After ${retryAfter} within window`,
  );
  assert(
    (res.headers.get("x-request-id") ?? "").length >= 8,
    "429 carries x-request-id",
  );
}

// ─── bootstrap ───────────────────────────────────────────────────────────────

Deno.test("bootstrap: Google ID token → 200 with session {accessToken, refreshToken, expiresAt}", async () => {
  resetState();
  const sub = newUser();
  const res = await call("POST", "/v1/account/bootstrap", {
    token: googleIdToken(sub),
  });
  assertEquals(res.status, 200);
  const body = (await res.json()) as {
    user: { id: string };
    onboardingState: string;
    session: { accessToken: string; refreshToken: string; expiresAt: number };
  };
  assertEquals(body.user.id, sub);
  assertEquals(body.onboardingState, "complete");
  assertMatch(body.session.accessToken, /^[\w-]+\.[\w-]+\.[\w-]+$/);
  assertStringIncludes(body.session.refreshToken, "rt-");
  assert(body.session.expiresAt > Math.floor(Date.now() / 1000) + 3_000);
  assertEquals(state.idTokenCalls, 1);
  assertEquals(state.unhandled, []);
});

Deno.test("bootstrap: never served from the auth cache — every call mints a new session", async () => {
  resetState();
  const sub = newUser();
  const token = googleIdToken(sub);
  const a = await call("POST", "/v1/account/bootstrap", { token });
  const b = await call("POST", "/v1/account/bootstrap", { token });
  assertEquals([a.status, b.status], [200, 200]);
  assertEquals(state.idTokenCalls, 2);
  const [sa, sb] = await Promise.all([a.json(), b.json()]);
  assertNotEquals(sa.session.refreshToken, sb.session.refreshToken);
});

Deno.test("bootstrap: missing bearer / non-provider issuer / no subject → 401 without calling GoTrue", async () => {
  resetState();
  const missing = await call("POST", "/v1/account/bootstrap", { token: null });
  assertEquals(missing.status, 401);
  assertEquals((await errorBody(missing)).message, "Missing bearer token.");

  const wrongIssuer = await call("POST", "/v1/account/bootstrap", {
    token: sessionToken(crypto.randomUUID()),
  });
  assertEquals(wrongIssuer.status, 401);
  assertStringIncludes(
    (await errorBody(wrongIssuer)).message ?? "",
    "not a Google or Apple ID token",
  );

  const garbage = await call("POST", "/v1/account/bootstrap", {
    token: "not.a.jwt.at.all",
  });
  assertEquals(garbage.status, 401);

  const noSub = await call("POST", "/v1/account/bootstrap", {
    token: googleIdToken(""),
  });
  assertEquals(noSub.status, 401);
  assertEquals(
    (await errorBody(noSub)).message,
    "The identity token has no subject.",
  );
  assertEquals(state.idTokenCalls, 0);
});

Deno.test("bootstrap: expired ID token → 401 before GoTrue is consulted", async () => {
  resetState();
  const res = await call("POST", "/v1/account/bootstrap", {
    token: googleIdToken(crypto.randomUUID(), -5),
  });
  assertEquals(res.status, 401);
  assertEquals(
    (await errorBody(res)).message,
    "The identity token has expired.",
  );
  assertEquals(state.idTokenCalls, 0);
});

Deno.test("bootstrap: GoTrue rejects the ID token (400) → 401 and the attempt counts as an auth failure", async () => {
  resetState();
  state.idTokenStatus = 400;
  const ip = freshIp();
  for (let i = 0; i < AUTH_FAILURE_LIMIT; i += 1) {
    const res = await call("POST", "/v1/account/bootstrap", {
      token: googleIdToken(crypto.randomUUID()),
      ip,
    });
    assertEquals(res.status, 401);
    await res.body?.cancel();
  }
  assertEquals(state.idTokenCalls, AUTH_FAILURE_LIMIT);
  state.idTokenStatus = 200;
  const sub = newUser();
  const blocked = await call("POST", "/v1/account/bootstrap", {
    token: googleIdToken(sub),
    ip,
  });
  assertRateLimited(blocked, AUTH_FAILURE_LIMIT, 300);
  assertEquals((await errorBody(blocked)).code, "rate_limited");
  assertEquals(
    state.idTokenCalls,
    AUTH_FAILURE_LIMIT,
    "tripped budget never reaches GoTrue",
  );
});

Deno.test("[observed] bootstrap: GoTrue 503 outage is returned as 401 'could not be verified' (not 503)", async () => {
  resetState();
  state.idTokenStatus = 503;
  const sub = newUser();
  const res = await call("POST", "/v1/account/bootstrap", {
    token: googleIdToken(sub),
  });
  assertEquals(res.status, 401);
  assertEquals(
    (await errorBody(res)).message,
    "The identity token could not be verified.",
  );
  assertEquals(state.idTokenCalls, 1);
});

Deno.test("[observed] bootstrap: 30 attempts during a GoTrue outage lock the IP out for the auth-failure window", async () => {
  resetState();
  state.idTokenStatus = 503;
  const ip = freshIp();
  const sub = newUser();
  for (let i = 0; i < AUTH_FAILURE_LIMIT; i += 1) {
    const res = await call("POST", "/v1/account/bootstrap", {
      token: googleIdToken(sub),
      ip,
    });
    assertEquals(res.status, 401);
    await res.body?.cancel();
  }
  state.idTokenStatus = 200; // GoTrue recovers…
  const afterRecovery = await call("POST", "/v1/account/bootstrap", {
    token: googleIdToken(sub),
    ip,
  });
  assertRateLimited(afterRecovery, AUTH_FAILURE_LIMIT, 300); // …but the IP is now locked out
  assertEquals(state.idTokenCalls, AUTH_FAILURE_LIMIT);
});

Deno.test("bootstrap: Apple ID token without authorization code (legacy build) → 200 + warning, no Apple exchange", async () => {
  resetState();
  const sub = newUser();
  state.profiles.set(sub, profileRow(sub, "apple"));
  const res = await call("POST", "/v1/account/bootstrap", {
    token: appleIdToken(sub),
  });
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(state.idTokenCalls, 1);
});

Deno.test("bootstrap: Apple ID token with X-Apple-Revocation-Protocol but no code → 400 coded", async () => {
  resetState();
  const sub = newUser();
  const res = await call("POST", "/v1/account/bootstrap", {
    token: appleIdToken(sub),
    body: {},
    headers: { "X-Apple-Revocation-Protocol": "1" },
  });
  assertEquals(res.status, 400);
  assertEquals(
    (await errorBody(res)).code,
    "auth.apple_authorization_code_required",
  );
});

Deno.test("bootstrap: profile row missing (signup trigger lagging) → generic 503, no detail leak", async () => {
  resetState();
  const sub = crypto.randomUUID(); // no profile row
  const res = await call("POST", "/v1/account/bootstrap", {
    token: googleIdToken(sub),
  });
  assertEquals(res.status, 503);
  const body = await res.text();
  assertStringIncludes(body, "temporarily unavailable");
  assert(!body.includes("PGRST"), "no PostgREST detail in the client body");
});

Deno.test("bootstrap: declared Content-Length over 5 MB → 413 before any auth work", async () => {
  resetState();
  const res = await call("POST", "/v1/account/bootstrap", {
    token: googleIdToken(crypto.randomUUID()),
    headers: { "content-length": String(5_000_001) },
  });
  assertEquals(res.status, 413);
  assertEquals(state.idTokenCalls, 0);
  assertMatch(res.headers.get("x-request-id") ?? "", UUID);
  await res.body?.cancel();
});

// ─── authenticate(): session tokens + cache ─────────────────────────────────

Deno.test("session token: verified once with getUser, then served from the auth cache", async () => {
  resetState();
  const sub = newUser();
  const token = sessionToken(sub);
  const a = await call("GET", "/v1/me/access", { token });
  assertEquals(a.status, 200);
  await a.body?.cancel();
  assertEquals(state.getUserCalls, 1);
  for (let i = 0; i < 5; i += 1) {
    const r = await call("GET", "/v1/me/access", { token });
    assertEquals(r.status, 200);
    await r.body?.cancel();
  }
  assertEquals(state.getUserCalls, 1, "cache hit for every subsequent request");
});

Deno.test("session token: cache TTL is bounded by exp — a token with < 90 s left is never cached", async () => {
  resetState();
  const sub = newUser();
  const shortLived = sessionToken(sub, 80); // ttl = 80 - 30 = 50 s < 60 s floor → not cached
  for (let i = 0; i < 3; i += 1) {
    const r = await call("GET", "/v1/me/access", { token: shortLived });
    assertEquals(r.status, 200);
    await r.body?.cancel();
  }
  assertEquals(state.getUserCalls, 3, "every request re-verified");

  const longer = sessionToken(sub, 100); // ttl = 70 s → cached
  for (let i = 0; i < 3; i += 1) {
    const r = await call("GET", "/v1/me/access", { token: longer });
    assertEquals(r.status, 200);
    await r.body?.cancel();
  }
  assertEquals(state.getUserCalls, 4);
});

Deno.test("session token: expired exp → 401 'session token has expired' without GoTrue", async () => {
  resetState();
  const res = await call("GET", "/v1/me/access", {
    token: sessionToken(crypto.randomUUID(), -1),
  });
  assertEquals(res.status, 401);
  assertEquals(
    (await errorBody(res)).message,
    "The session token has expired.",
  );
  assertEquals(state.getUserCalls, 0);
});

Deno.test("session token: revoked at GoTrue (401) → 401 'no longer valid' and counts as an auth failure", async () => {
  resetState();
  const sub = newUser();
  const token = sessionToken(sub);
  state.revoked.add(token);
  const ip = freshIp();
  for (let i = 0; i < AUTH_FAILURE_LIMIT; i += 1) {
    const r = await call("GET", "/v1/me/access", { token, ip });
    assertEquals(r.status, 401);
    assertEquals(
      (await errorBody(r)).message,
      "The session is no longer valid. Sign in again.",
    );
  }
  assertEquals(state.getUserCalls, AUTH_FAILURE_LIMIT);
  const valid = await call("GET", "/v1/me/access", {
    token: sessionToken(newUser()),
    ip,
  });
  assertRateLimited(valid, AUTH_FAILURE_LIMIT, 300);
  assertEquals(
    state.getUserCalls,
    AUTH_FAILURE_LIMIT,
    "locked-out IP never reaches GoTrue",
  );
});

Deno.test("[observed] session token: GoTrue 503 on getUser is returned as 401 'Sign in again' and charged as an auth failure", async () => {
  resetState();
  state.getUserStatus = 503;
  const sub = newUser();
  const ip = freshIp();
  const res = await call("GET", "/v1/me/access", {
    token: sessionToken(sub),
    ip,
  });
  assertEquals(res.status, 401);
  assertEquals(
    (await errorBody(res)).message,
    "The session is no longer valid. Sign in again.",
  );
  assertEquals(state.getUserCalls, 1);
  // The same IP's auth-failure budget was charged for an upstream outage:
  for (let i = 1; i < AUTH_FAILURE_LIMIT; i += 1) {
    const r = await call("GET", "/v1/me/access", {
      token: sessionToken(sub),
      ip,
    });
    assertEquals(r.status, 401);
    await r.body?.cancel();
  }
  state.getUserStatus = 200;
  const afterRecovery = await call("GET", "/v1/me/access", {
    token: sessionToken(sub),
    ip,
  });
  assertRateLimited(afterRecovery, AUTH_FAILURE_LIMIT, 300);
});

Deno.test("session token: account without a Google/Apple identity → 401", async () => {
  resetState();
  state.userProvider = "email";
  const res = await call("GET", "/v1/me/access", {
    token: sessionToken(newUser()),
  });
  assertEquals(res.status, 401);
  assertStringIncludes(
    (await errorBody(res)).message ?? "",
    "does not belong to a Google or Apple account",
  );
});

Deno.test("transitional provider ID token on a normal route: exchanged once, then cached", async () => {
  resetState();
  const sub = newUser();
  const token = googleIdToken(sub);
  for (let i = 0; i < 3; i += 1) {
    const r = await call("GET", "/v1/me/access", { token });
    assertEquals(r.status, 200);
    await r.body?.cancel();
  }
  assertEquals(state.idTokenCalls, 1);
  assertEquals(state.getUserCalls, 0);
});

Deno.test("authenticate: lowercase 'bearer' scheme and missing header both → 401 'Missing bearer token.'", async () => {
  resetState();
  const lower = await call("GET", "/v1/me/access", {
    token: null,
    headers: { Authorization: `bearer ${sessionToken(newUser())}` },
  });
  assertEquals(lower.status, 401);
  assertEquals((await errorBody(lower)).message, "Missing bearer token.");
  const none = await call("GET", "/v1/me/access", { token: null });
  assertEquals(none.status, 401);
  await none.body?.cancel();
  assertEquals(state.getUserCalls, 0);
});

// ─── refresh ────────────────────────────────────────────────────────────────

Deno.test("refresh: valid refresh token → 200 {session} with rotated tokens, no Authorization header needed", async () => {
  resetState();
  const sub = newUser();
  const res = await call("POST", "/v1/auth/refresh", {
    token: null,
    body: { refreshToken: `rt-for-${sub}` },
  });
  assertEquals(res.status, 200);
  const body = (await res.json()) as {
    session: { accessToken: string; refreshToken: string; expiresAt: number };
  };
  assertEquals(state.refreshCalls, 1);
  assertEquals(state.lastRefreshBody?.refresh_token, `rt-for-${sub}`);
  assertNotEquals(body.session.refreshToken, `rt-for-${sub}`);
  assert(body.session.expiresAt > Math.floor(Date.now() / 1000));
});

Deno.test("refresh: refreshToken is trimmed before it reaches GoTrue", async () => {
  resetState();
  const sub = newUser();
  const res = await call("POST", "/v1/auth/refresh", {
    token: null,
    body: { refreshToken: `  rt-for-${sub}  ` },
  });
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(state.lastRefreshBody?.refresh_token, `rt-for-${sub}`);
});

Deno.test("refresh: missing / blank / non-string refreshToken and malformed JSON → 400 validation.refresh", async () => {
  resetState();
  for (
    const body of [{}, { refreshToken: "" }, { refreshToken: "   " }, {
      refreshToken: 42,
    }, [1, 2]]
  ) {
    const res = await call("POST", "/v1/auth/refresh", { token: null, body });
    assertEquals(res.status, 400);
    assertEquals((await errorBody(res)).code, "validation.refresh");
  }
  const malformed = await call("POST", "/v1/auth/refresh", {
    token: null,
    rawBody: "{not json",
  });
  assertEquals(malformed.status, 400);
  assertEquals((await errorBody(malformed)).code, "validation.refresh");
  const empty = await call("POST", "/v1/auth/refresh", { token: null });
  assertEquals(empty.status, 400);
  await empty.body?.cancel();
  assertEquals(state.refreshCalls, 0);
});

Deno.test("refresh: revoked / already-rotated token → 401 and charged as an auth failure", async () => {
  resetState();
  state.deadRefreshTokens.add("rt-dead");
  const ip = freshIp();
  const res = await call("POST", "/v1/auth/refresh", {
    token: null,
    body: { refreshToken: "rt-dead" },
    ip,
  });
  assertEquals(res.status, 401);
  assertEquals(
    (await errorBody(res)).message,
    "The session could not be refreshed. Sign in again.",
  );
  for (let i = 1; i < AUTH_FAILURE_LIMIT; i += 1) {
    const r = await call("POST", "/v1/auth/refresh", {
      token: null,
      body: { refreshToken: "rt-dead" },
      ip,
    });
    assertEquals(r.status, 401);
    await r.body?.cancel();
  }
  const blocked = await call("GET", "/v1/me/access", {
    token: sessionToken(newUser()),
    ip,
  });
  assertRateLimited(blocked, AUTH_FAILURE_LIMIT, 300);
});

Deno.test("[observed] refresh: GoTrue 5xx → generic 503 only after supabase-js retries with backoff (~25 s, 8 upstream calls)", async () => {
  resetState();
  state.refreshStatus = 503;
  const ip = freshIp();
  const startedAt = Date.now();
  const res = await call("POST", "/v1/auth/refresh", {
    token: null,
    body: { refreshToken: "rt-x" },
    ip,
  });
  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[probe] refresh during GoTrue 503: status=${res.status} elapsedMs=${elapsedMs} upstreamCalls=${state.refreshCalls}`,
  );
  assertEquals(res.status, 503);
  assert(
    state.refreshCalls >= 2,
    `expected supabase-js retries, saw ${state.refreshCalls} upstream call(s)`,
  );
  assert(
    elapsedMs >= 10_000,
    `expected the documented ~25 s stall, saw ${elapsedMs} ms`,
  );
  const text = await res.text();
  assertStringIncludes(text, "Session refresh is temporarily unavailable");
  assert(!text.includes("upstream down"));
  // an outage does NOT charge the auth-failure budget
  state.refreshStatus = 200;
  const ok = await call("GET", "/v1/me/access", {
    token: sessionToken(newUser()),
    ip,
  });
  assertEquals(ok.status, 200);
  await ok.body?.cancel();
});

Deno.test("refresh: per-IP budget of 30/min applies even to successful rotations", async () => {
  resetState();
  const ip = freshIp();
  const sub = newUser();
  for (let i = 0; i < AUTH_REFRESH_LIMIT; i += 1) {
    const r = await call("POST", "/v1/auth/refresh", {
      token: null,
      body: { refreshToken: `rt-for-${sub}` },
      ip,
    });
    assertEquals(r.status, 200);
    await r.body?.cancel();
  }
  const blocked = await call("POST", "/v1/auth/refresh", {
    token: null,
    body: { refreshToken: `rt-for-${sub}` },
    ip,
  });
  assertRateLimited(blocked, AUTH_REFRESH_LIMIT, 60);
  assertEquals(state.refreshCalls, AUTH_REFRESH_LIMIT);
  // other routes from the same IP are unaffected
  const other = await call("GET", "/v1/me/access", {
    token: sessionToken(newUser()),
    ip,
  });
  assertEquals(other.status, 200);
  await other.body?.cancel();
});

// ─── logout ─────────────────────────────────────────────────────────────────

Deno.test("logout: 204, revokes with scope=local for THIS bearer and evicts it from the auth cache", async () => {
  resetState();
  const sub = newUser();
  const token = sessionToken(sub);
  const warm = await call("GET", "/v1/me/access", { token });
  assertEquals(warm.status, 200);
  await warm.body?.cancel();
  assertEquals(state.getUserCalls, 1);

  const out = await call("POST", "/v1/auth/logout", { token });
  assertEquals(out.status, 204);
  assertEquals(state.logoutCalls, 1);
  assertStringIncludes(
    state.lastLogoutUrl ?? "",
    "/auth/v1/logout?scope=local",
  );
  assertEquals(state.lastLogoutBearer, token);

  // GoTrue now considers the session gone; the edge must re-verify, not serve the cache.
  state.revoked.add(token);
  const after = await call("GET", "/v1/me/access", { token });
  assertEquals(after.status, 401);
  await after.body?.cancel();
  assertEquals(state.getUserCalls, 2, "bearer was re-verified after logout");
});

Deno.test("logout: GoTrue 401/404 (session already gone) → still 204", async () => {
  resetState();
  for (const status of [401, 404]) {
    state.logoutStatus = status;
    const res = await call("POST", "/v1/auth/logout", {
      token: sessionToken(newUser()),
    });
    assertEquals(res.status, 204);
  }
});

Deno.test("logout: GoTrue 5xx → generic 503", async () => {
  resetState();
  state.logoutStatus = 502;
  const res = await call("POST", "/v1/auth/logout", {
    token: sessionToken(newUser()),
  });
  assertEquals(res.status, 503);
  assertStringIncludes(await res.text(), "Sign-out is temporarily unavailable");
});

Deno.test("logout: requires a verifiable bearer (expired → 401, no revoke call)", async () => {
  resetState();
  const res = await call("POST", "/v1/auth/logout", {
    token: sessionToken(newUser(), -1),
  });
  assertEquals(res.status, 401);
  await res.body?.cancel();
  assertEquals(state.logoutCalls, 0);
});

// ─── rate limits through the handler ────────────────────────────────────────

Deno.test("healthz: 60/min per IP, 61st → 429 with RateLimit-* + Retry-After, request id, access-log code", async () => {
  resetState();
  const ip = freshIp();
  for (let i = 0; i < PUBLIC_PAGE_LIMIT; i += 1) {
    const r = await call("GET", "/healthz", { token: null, ip });
    assertEquals(r.status, 200);
    await r.body?.cancel();
  }
  accessLog.length = 0;
  const blocked = await call("GET", "/healthz", {
    token: null,
    ip,
    headers: { "x-request-id": "probe-rl-0001" },
  });
  assertRateLimited(blocked, PUBLIC_PAGE_LIMIT, 60);
  assertEquals(blocked.headers.get("x-request-id"), "probe-rl-0001");
  assertEquals((await errorBody(blocked)).code, "rate_limited");
  const access = accessLog.filter((l) => l.startsWith('{"evt":"api_request"'));
  assertEquals(access.length, 1);
  const entry = JSON.parse(access[0]);
  assertEquals(entry.status, 429);
  assertEquals(entry.code, "rate_limited");
  assertEquals(entry.requestId, "probe-rl-0001");
  assertEquals(entry.route, "/functions/v1/api/healthz");
  // a different IP is unaffected
  const other = await call("GET", "/healthz", { token: null });
  assertEquals(other.status, 200);
  await other.body?.cancel();
});

Deno.test("per-user general budget: 240/min, 241st → 429 scoped to the user (other users fine, same IP)", async () => {
  resetState();
  const sub = newUser();
  const token = sessionToken(sub);
  const ip = freshIp();
  for (let i = 0; i < GENERAL_USER_LIMIT; i += 1) {
    const r = await call("GET", "/v1/me/access", { token, ip });
    assertEquals(r.status, 200);
    await r.body?.cancel();
  }
  const blocked = await call("GET", "/v1/me/access", { token, ip });
  assertRateLimited(blocked, GENERAL_USER_LIMIT, 60);
  await blocked.body?.cancel();
  const other = await call("GET", "/v1/me/access", {
    token: sessionToken(newUser()),
    ip,
  });
  assertEquals(other.status, 200);
  await other.body?.cancel();
});

Deno.test("per-IP budget: 1200/min across users, 1201st → 429 before authentication", async () => {
  resetState();
  const ip = freshIp();
  const users = Array.from({ length: 6 }, () => sessionToken(newUser()));
  for (let i = 0; i < IP_LIMIT; i += 1) {
    const r = await call("GET", "/v1/me/access", {
      token: users[i % users.length],
      ip,
    });
    assertEquals(r.status, 200, `request ${i + 1}`);
    await r.body?.cancel();
  }
  const before = state.getUserCalls;
  const blocked = await call("GET", "/v1/me/access", {
    token: sessionToken(newUser()),
    ip,
  });
  assertRateLimited(blocked, IP_LIMIT, 60);
  await blocked.body?.cancel();
  assertEquals(state.getUserCalls, before, "blocked pre-auth");
});

Deno.test("unknown route with a valid session → 404 JSON with request id (no 5xx)", async () => {
  resetState();
  const res = await call("GET", "/v1/definitely-not-a-route", {
    token: sessionToken(newUser()),
  });
  assertEquals(res.status, 404);
  assertMatch(res.headers.get("x-request-id") ?? "", UUID);
  assertEquals(res.headers.get("content-type"), "application/json");
  await res.body?.cancel();
});

Deno.test("request id: well-formed client id echoed on 200/401/503; malformed replaced by a UUID", async () => {
  resetState();
  const ok = await call("GET", "/healthz", {
    token: null,
    headers: { "x-request-id": "ios-req_0001.a" },
  });
  assertEquals(ok.headers.get("x-request-id"), "ios-req_0001.a");
  await ok.body?.cancel();

  const unauth = await call("GET", "/v1/me/access", {
    token: null,
    headers: { "x-request-id": "ios-req_0002.b" },
  });
  assertEquals(unauth.status, 401);
  assertEquals(unauth.headers.get("x-request-id"), "ios-req_0002.b");
  await unauth.body?.cancel();

  state.logoutStatus = 502;
  const outage = await call("POST", "/v1/auth/logout", {
    token: sessionToken(newUser()),
    headers: { "x-request-id": "ios-req_0003.c" },
  });
  assertEquals(outage.status, 503);
  assertEquals(outage.headers.get("x-request-id"), "ios-req_0003.c");
  await outage.body?.cancel();

  const bad = await call("GET", "/healthz", {
    token: null,
    headers: { "x-request-id": "short" },
  });
  assertMatch(bad.headers.get("x-request-id") ?? "", UUID);
  await bad.body?.cancel();
});

Deno.test("every JSON response carries the security headers", async () => {
  resetState();
  const responses = await Promise.all([
    call("GET", "/healthz", { token: null }),
    call("GET", "/v1/me/access", { token: null }),
    call("GET", "/v1/me/access", { token: sessionToken(newUser()) }),
    call("POST", "/v1/auth/refresh", { token: null, body: {} }),
  ]);
  for (const res of responses) {
    assertEquals(res.headers.get("content-type"), "application/json");
    assertEquals(res.headers.get("x-content-type-options"), "nosniff");
    assertEquals(res.headers.get("cache-control"), "no-store");
    assertEquals(res.headers.get("referrer-policy"), "no-referrer");
    await res.body?.cancel();
  }
});

Deno.test("fake supabase saw no unhandled endpoints in this test", async () => {
  resetState();
  const res = await call("GET", "/v1/me/access", {
    token: sessionToken(newUser()),
  });
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(state.unhandled, []);
});
