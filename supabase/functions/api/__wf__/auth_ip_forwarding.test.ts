import { assert, assertEquals } from "@std/assert";
import {
  fakeGoogleIdToken,
  fakeSupabaseAccessToken,
  loadHarness,
  type RecordedCall,
  TEST_USER_ID,
  userRequest,
} from "./routesHarness.ts";

const SECRET_KEY = `sb_secret_${crypto.randomUUID()}`;
Deno.env.set("SB_SECRET_KEY", SECRET_KEY);

const h = await loadHarness();

const profile = () => ({
  id: TEST_USER_ID,
  email: "user@example.com",
  provider: "google",
  onboarding_state: "complete",
});
const authCalls = (calls: RecordedCall[]) => calls.filter((c) => c.url.includes("/auth/v1/"));
const restCalls = (calls: RecordedCall[]) => calls.filter((c) => c.url.includes("/rest/v1/"));
const authPath = (call: RecordedCall) => new URL(call.url).pathname;

Deno.test(
  "Auth calls carry the secret apikey + forwarded edge IP; REST calls never do",
  async () => {
    h.reset();
    h.tables.profiles = [profile()];
    const edgeIp = "198.51.100.77";
    const headers = { "cf-connecting-ip": edgeIp, "x-forwarded-for": "1.2.3.4, 203.0.113.20" };
    const sessionToken = fakeSupabaseAccessToken("33333333-3333-4333-8333-333333333333");

    const boot = await h.handler(
      userRequest("POST", "/v1/account/bootstrap", { body: {}, headers }),
    );
    assertEquals(boot.status, 200);
    await boot.text();

    const consent = await h.handler(
      userRequest("GET", "/v1/me/consent/status", { token: sessionToken, headers }),
    );
    assertEquals(consent.status, 200);
    await consent.text();

    const refresh = await h.handler(
      userRequest("POST", "/v1/auth/refresh", { body: { refreshToken: "r" }, headers }),
    );
    assertEquals(refresh.status, 200);
    await refresh.text();

    const logout = await h.handler(
      userRequest("POST", "/v1/auth/logout", { token: sessionToken, headers }),
    );
    assertEquals(logout.status, 204);

    const auth = authCalls(h.calls);
    const paths = auth.map(authPath);
    for (const path of ["/auth/v1/token", "/auth/v1/user", "/auth/v1/logout"]) {
      assert(paths.includes(path), `expected an Auth call to ${path}, saw ${paths.join(", ")}`);
    }
    for (const call of auth) {
      assertEquals(call.headers["apikey"], SECRET_KEY, call.url);
      assertEquals(call.headers["sb-forwarded-for"], edgeIp, call.url);
    }
    const userCall = auth.find((c) => authPath(c) === "/auth/v1/user");
    assert(userCall);
    assertEquals(userCall.headers["authorization"], `Bearer ${sessionToken}`);

    const rest = restCalls(h.calls);
    assert(rest.length > 0);
    for (const call of rest) {
      assertEquals(call.headers["sb-forwarded-for"], undefined, call.url);
      assert(call.headers["apikey"] !== SECRET_KEY, `secret key must not reach REST: ${call.url}`);
    }
  },
);

Deno.test(
  "only the edge-authoritative hop is forwarded, and only when it is a real IP",
  async () => {
    const cases: Array<{ forwardedFor: string; expected: string | undefined }> = [
      { forwardedFor: "1.2.3.4, 203.0.113.44", expected: "203.0.113.44" },
      { forwardedFor: "2001:db8::1", expected: "2001:db8::1" },
      { forwardedFor: "not an ip", expected: undefined },
      { forwardedFor: "999.1.1.1", expected: undefined },
      { forwardedFor: "203.0.113.9 evil", expected: undefined },
    ];
    for (const testCase of cases) {
      h.reset();
      h.tables.profiles = [profile()];
      const res = await h.handler(
        userRequest("POST", "/v1/account/bootstrap", {
          body: {},
          headers: { "x-forwarded-for": testCase.forwardedFor },
        }),
      );
      assertEquals(res.status, 200, testCase.forwardedFor);
      await res.text();
      const token = authCalls(h.calls).find((c) => authPath(c) === "/auth/v1/token");
      assert(token, testCase.forwardedFor);
      assertEquals(token.headers["apikey"], SECRET_KEY);
      assertEquals(token.headers["sb-forwarded-for"], testCase.expected, testCase.forwardedFor);
    }
  },
);

Deno.test("no client IP at all keeps the secret apikey without a forwarded address", async () => {
  h.reset();
  h.tables.profiles = [profile()];
  const request = userRequest("POST", "/v1/account/bootstrap", { body: {} });
  request.headers.delete("x-forwarded-for");
  const res = await h.handler(request);
  assertEquals(res.status, 200);
  await res.text();
  const token = authCalls(h.calls).find((c) => authPath(c) === "/auth/v1/token");
  assert(token);
  assertEquals(token.headers["apikey"], SECRET_KEY);
  assertEquals(token.headers["sb-forwarded-for"], undefined);
});

Deno.test("the secret key never appears in responses, whatever Auth answers", async () => {
  h.reset();
  h.userStatus = 503;
  const outage = await h.handler(
    userRequest("GET", "/v1/me/consent/status", {
      token: fakeSupabaseAccessToken("44444444-4444-4444-8444-444444444444"),
      ip: "203.0.113.5",
    }),
  );
  assertEquals(outage.status, 503);
  assert(!(await outage.text()).includes(SECRET_KEY));

  h.reset();
  const rejected = await h.handler(
    userRequest("GET", "/v1/me", { token: fakeGoogleIdToken(), ip: "203.0.113.6" }),
  );
  assert(!(await rejected.text()).includes(SECRET_KEY));
  assert(![...rejected.headers.values()].some((v) => v.includes(SECRET_KEY)));
});

Deno.test({
  name: "teardown: SB_SECRET_KEY does not leak into later test modules",
  fn() {
    Deno.env.delete("SB_SECRET_KEY");
  },
  sanitizeOps: false,
  sanitizeResources: false,
});
