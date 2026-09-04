// XC-SEC-2 — the bearer contract outside `POST /v1/account/bootstrap`.
//
// Bootstrap is the ONLY route that may spend a Google/Apple ID token
// (signInWithIdToken). Every other authenticated route accepts the Supabase
// ACCESS token that bootstrap (or /v1/auth/refresh) issued and nothing else:
// a provider ID token there is a 401 and never reaches Supabase Auth. If it
// did, every auth-cache miss would mint a fresh Supabase session that
// `POST /v1/auth/logout` can never revoke — the ID token would keep working
// until the provider itself expired it.
//
// Run: deno test -A --no-check --config deno.json xc_adjudication_auth.test.ts
// (inside __wf__/)

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  bootstrapAccessToken,
  fakeAppleIdToken,
  fakeGoogleIdToken,
  loadHarness,
  OTHER_USER_ID,
  SUPABASE_URL,
  TEST_USER_ID,
  userRequest,
} from "./routesHarness.ts";

const ID_TOKEN_EXCHANGE = `${SUPABASE_URL}/auth/v1/token?grant_type=id_token`;
const SESSION_VERIFY = `${SUPABASE_URL}/auth/v1/user`;

const PROFILE_ROW = {
  id: TEST_USER_ID,
  email: "user@example.com",
  provider: "google",
  onboarding_state: "complete",
  skill_level: "beginner",
  handedness: "right",
  primary_goal: "dinks",
  biggest_problem: null,
  focus_checkpoint: "contact_position",
  first_name: null,
  gender: null,
};

const NON_BOOTSTRAP_ROUTES: Array<{ method: string; path: string; body?: unknown }> = [
  { method: "GET", path: "/v1/me" },
  { method: "GET", path: "/v1/me/saved-drills" },
  { method: "POST", path: "/v1/shots:sync", body: { shots: [] } },
  { method: "POST", path: "/v1/auth/logout" },
];

Deno.test(
  "REPRO (defect): transitional provider-ID-token branch is live on non-bootstrap routes — a Google ID token on GET /v1/me/saved-drills must be a 401 that never reaches Supabase Auth",
  async () => {
    const h = await loadHarness();
    const res = await h.handler(
      userRequest("GET", "/v1/me/saved-drills", {
        token: fakeGoogleIdToken(),
        ip: "198.51.100.61",
      }),
    );
    assertEquals(
      res.status,
      401,
      "[defect] authenticate() exchanged a raw Google ID token on a non-bootstrap route",
    );
    await res.body?.cancel();
    assertEquals(
      h.callsTo(ID_TOKEN_EXCHANGE).length,
      0,
      "[defect] a non-bootstrap route called signInWithIdToken",
    );
    assertEquals(h.callsTo(SESSION_VERIFY).length, 0);
  },
);

Deno.test(
  "a fake Google and a fake Apple ID token are 401 on GET /v1/me, GET /v1/me/saved-drills, POST /v1/shots:sync and POST /v1/auth/logout, with ZERO id_token exchanges",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [PROFILE_ROW];
    const idTokens = {
      google: fakeGoogleIdToken(),
      apple: fakeAppleIdToken(),
    };
    for (const [provider, token] of Object.entries(idTokens)) {
      for (const route of NON_BOOTSTRAP_ROUTES) {
        const res = await h.handler(
          userRequest(route.method, route.path, {
            token,
            body: route.body,
            ip: "198.51.100.62",
          }),
        );
        const body = (await res.json()) as { error: { message: string } };
        assertEquals(res.status, 401, `${provider} ID token on ${route.method} ${route.path}`);
        assertStringIncludes(body.error.message, "POST /v1/account/bootstrap");
      }
    }
    assertEquals(h.callsTo(ID_TOKEN_EXCHANGE).length, 0);
    assertEquals(h.callsTo(SESSION_VERIFY).length, 0);
    assertEquals(h.callsTo("/rest/v1/").length, 0, "no query ran on behalf of the ID token");
  },
);

Deno.test(
  "the bootstrap-issued session is the one sign-in lifecycle: it authenticates, logout revokes it, and the same bearer is 401 afterwards",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [PROFILE_ROW];
    const accessToken = await bootstrapAccessToken(h, { ip: "198.51.100.63" });
    assert(h.sessions.has(accessToken), "fake Auth knows the bootstrap session");

    const me = await h.handler(userRequest("GET", "/v1/me", { token: accessToken }));
    assertEquals(me.status, 200);
    assertEquals(((await me.json()) as { user: { id: string } }).user.id, TEST_USER_ID);
    assertEquals(h.callsTo(SESSION_VERIFY).length, 1, "verified with getUser once");
    assertEquals(h.callsTo(ID_TOKEN_EXCHANGE).length, 0);

    const again = await h.handler(userRequest("GET", "/v1/me", { token: accessToken }));
    assertEquals(again.status, 200);
    await again.body?.cancel();
    assertEquals(h.callsTo(SESSION_VERIFY).length, 1, "second call served from the auth cache");

    const logout = await h.handler(
      userRequest("POST", "/v1/auth/logout", { token: accessToken, ip: "198.51.100.63" }),
    );
    assertEquals(logout.status, 204);
    assertEquals(h.sessions.has(accessToken), false, "Supabase Auth revoked the session");

    const afterLogout = await h.handler(
      userRequest("GET", "/v1/me", { token: accessToken, ip: "198.51.100.63" }),
    );
    assertEquals(afterLogout.status, 401, "revoked bearer is refused, not served from cache");
    assertStringIncludes(
      ((await afterLogout.json()) as { error: { message: string } }).error.message,
      "no longer valid",
    );
    assertEquals(h.callsTo(ID_TOKEN_EXCHANGE).length, 0);
  },
);

Deno.test(
  "a session token whose exp has passed, or a bearer that is neither a session nor a provider token, is 401 before any Supabase Auth call",
  async () => {
    const h = await loadHarness();
    const b64url = (value: string): string =>
      btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const expired = [
      b64url(JSON.stringify({ alg: "HS256", typ: "JWT" })),
      b64url(
        JSON.stringify({
          iss: `${SUPABASE_URL}/auth/v1`,
          sub: TEST_USER_ID,
          exp: Math.floor(Date.now() / 1000) - 60,
        }),
      ),
      "sig",
    ].join(".");
    const expiredRes = await h.handler(
      userRequest("GET", "/v1/me", { token: expired, ip: "198.51.100.64" }),
    );
    assertEquals(expiredRes.status, 401);
    assertStringIncludes(
      ((await expiredRes.json()) as { error: { message: string } }).error.message,
      "expired",
    );

    const foreign = await h.handler(
      userRequest("GET", "/v1/me", { token: "not-a-jwt", ip: "198.51.100.64" }),
    );
    assertEquals(foreign.status, 401);
    await foreign.body?.cancel();

    assertEquals(h.callsTo(`${SUPABASE_URL}/auth/v1/`).length, 0);
  },
);

Deno.test(
  "userRequest() bears the bootstrap-issued session by default, and another user's session comes from bootstrap too",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [PROFILE_ROW];
    assert(h.accessToken.length > 0);
    assert(h.sessions.has(h.accessToken), "default bearer is a live fake-Auth session");
    const me = await h.handler(userRequest("GET", "/v1/me", { ip: "198.51.100.65" }));
    assertEquals(me.status, 200);
    assertEquals(((await me.json()) as { user: { id: string } }).user.id, TEST_USER_ID);

    const otherToken = await bootstrapAccessToken(h, { sub: OTHER_USER_ID, provider: "apple" });
    h.tables.profiles = [{ ...PROFILE_ROW, id: OTHER_USER_ID, provider: "apple" }];
    const other = await h.handler(
      userRequest("GET", "/v1/me", { token: otherToken, ip: "198.51.100.65" }),
    );
    assertEquals(other.status, 200);
    assertEquals(((await other.json()) as { user: { id: string } }).user.id, OTHER_USER_ID);
    assertEquals(h.callsTo(ID_TOKEN_EXCHANGE).length, 0, "bootstrap calls are not recorded");
  },
);
