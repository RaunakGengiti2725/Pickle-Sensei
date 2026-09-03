import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { encryptAppleRefreshToken } from "../externalAccounts.ts";
import {
  RC_URL,
  TEST_USER_ID,
  fakeAppleIdToken,
  loadHarness,
  userRequest,
} from "./routesHarness.ts";

const h = await loadHarness();

function profile(provider: "apple" | "google" = "apple") {
  return {
    id: TEST_USER_ID,
    email: "relay@example.com",
    provider,
    onboarding_state: "complete",
  };
}

Deno.test(
  "Apple bootstrap exchanges the one-use code and stores only encrypted revocation material",
  async () => {
    h.reset();
    h.tables.profiles = [profile()];
    const response = await h.handler(
      userRequest("POST", "/v1/account/bootstrap", {
        token: fakeAppleIdToken(),
        body: { appleAuthorizationCode: "one-use-authorization-code" },
      }),
    );
    assertEquals(response.status, 200);

    const apple = h.callsTo("appleid.apple.com/auth/token");
    assertEquals(apple.length, 1);
    assertStringIncludes(String(apple[0]?.body), "code=one-use-authorization-code");
    const stored = h.calls
      .filter(
        (call) =>
          call.url.includes("/rest/v1/account_external_credentials") && call.method === "POST",
      )
      .at(-1)?.body as Record<string, unknown>;
    assertEquals(stored.user_id, TEST_USER_ID);
    assertEquals(typeof stored.apple_refresh_token_encrypted, "string");
    assertStringIncludes(String(stored.apple_refresh_token_encrypted), "v1.");
    assertEquals(JSON.stringify(stored).includes("apple-refresh-token-from-grant"), false);
    assertEquals(JSON.stringify(stored).includes("one-use-authorization-code"), false);
  },
);

Deno.test("legacy Apple bootstrap remains compatible before the mobile update ships", async () => {
  h.reset();
  h.tables.profiles = [profile()];

  const response = await h.handler(
    userRequest("POST", "/v1/account/bootstrap", {
      token: fakeAppleIdToken(),
      body: {},
    }),
  );

  assertEquals(response.status, 200);
  assertEquals(h.callsTo("appleid.apple.com/auth/token").length, 0);
});

Deno.test(
  "revocation-capable Apple clients fail closed if the one-use code is missing",
  async () => {
    h.reset();
    h.tables.profiles = [profile()];

    const response = await h.handler(
      userRequest("POST", "/v1/account/bootstrap", {
        token: fakeAppleIdToken(),
        headers: { "X-Apple-Revocation-Protocol": "1" },
        body: {},
      }),
    );

    assertEquals(response.status, 400);
    assertEquals((await response.json()).error.code, "auth.apple_authorization_code_required");
    assertEquals(h.callsTo("appleid.apple.com/auth/token").length, 0);
  },
);

Deno.test(
  "delete-confirm revokes Apple and erases RevenueCat before deleting Supabase auth",
  async () => {
    h.reset();
    const challenge = "33333333-3333-4333-8333-333333333333";
    h.tables.account_deletion_requests = [
      {
        challenge,
        created_at: new Date(Date.now() - 10_000).toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    ];
    h.tables.account_external_credentials = [
      {
        apple_refresh_token_encrypted: await encryptAppleRefreshToken(
          "refresh-to-revoke",
          TEST_USER_ID,
          h.appleTokenEncryptionKey,
        ),
        apple_revoked_at: null,
        revenuecat_deleted_at: null,
      },
    ];

    const response = await h.handler(
      userRequest("POST", "/v1/me/delete-confirm", {
        token: fakeAppleIdToken(),
        body: { challenge },
      }),
    );
    assertEquals(response.status, 200);
    assertEquals(await response.json(), {
      deleted: true,
      appleAuthorizationRevocation: "revoked",
    });

    const appleIndex = h.calls.findIndex((call) =>
      call.url.includes("appleid.apple.com/auth/revoke"),
    );
    const revenueCatIndex = h.calls.findIndex(
      (call) => call.url.startsWith(RC_URL) && call.method === "DELETE",
    );
    const supabaseIndex = h.calls.findIndex(
      (call) => call.url.includes("/auth/v1/admin/users/") && call.method === "DELETE",
    );
    assert(appleIndex >= 0);
    assert(revenueCatIndex > appleIndex);
    assert(supabaseIndex > revenueCatIndex);

    const revokeBody = String(h.calls[appleIndex]?.body);
    assertStringIncludes(revokeBody, "token=refresh-to-revoke");
    assertStringIncludes(revokeBody, "token_type_hint=refresh_token");
    assertEquals(h.calls[revenueCatIndex]?.headers.authorization, "Bearer sk_test_revenuecat");
  },
);

Deno.test(
  "legacy Apple deletion is fulfilled and explicitly reports the manual disconnect step",
  async () => {
    h.reset();
    const challenge = "44444444-4444-4444-8444-444444444444";
    h.tables.account_deletion_requests = [
      {
        challenge,
        created_at: new Date(Date.now() - 10_000).toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    ];
    h.tables.account_external_credentials = [];

    const response = await h.handler(
      userRequest("POST", "/v1/me/delete-confirm", {
        token: fakeAppleIdToken(),
        body: { challenge },
      }),
    );
    assertEquals(response.status, 200);
    assertEquals(await response.json(), {
      deleted: true,
      appleAuthorizationRevocation: "manual_action_required",
    });
    assertEquals(h.callsTo("appleid.apple.com/auth/revoke").length, 0);
    assertEquals(
      h.calls.some((call) => call.url.startsWith(RC_URL) && call.method === "DELETE"),
      true,
    );
  },
);
