import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { encryptAppleRefreshToken } from "../externalAccounts.ts";
import {
  RC_URL,
  TEST_USER_ID,
  fakeAppleIdToken,
  fakeSupabaseAccessToken,
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

    const request = userRequest("POST", "/v1/me/delete-confirm", { body: { challenge } });
    const response = await h.handler(request);
    assertEquals(response.status, 200);
    assertEquals(await response.json(), {
      deleted: true,
      appleAuthorizationRevocation: "revoked",
    });
    assertEquals(h.callsTo("/auth/v1/user").length, 1);
    assertEquals(h.callsTo("grant_type=id_token").length, 0);
    assertEquals(
      h.callsTo("/rest/v1/account_deletion_requests")[0].headers.authorization,
      request.headers.get("Authorization"),
    );

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

async function googleSessionDeletion(providers = ["google", "apple"]) {
  h.reset();
  const userId = crypto.randomUUID();
  const token = fakeSupabaseAccessToken(userId);
  const challenge = crypto.randomUUID();
  const external = {
    user_id: userId,
    apple_refresh_token_encrypted: (await encryptAppleRefreshToken(
      "linked-apple-refresh-to-revoke",
      userId,
      h.appleTokenEncryptionKey,
    )) as string | null,
    apple_revoked_at: null as string | null,
    revenuecat_deleted_at: null as string | null,
  };
  h.tables.account_external_credentials = [external];
  h.tables.account_deletion_requests = [
    {
      challenge,
      created_at: new Date(Date.now() - 10_000).toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    },
  ];
  const adminStatuses: number[] = [];
  h.authResponse = (call) => {
    if (call.url.endsWith("/auth/v1/user") && call.method === "GET") {
      return Response.json({
        id: userId,
        email: "linked@example.com",
        app_metadata: { provider: "google", providers },
      });
    }
    if (call.url.endsWith(`/auth/v1/admin/users/${userId}`) && call.method === "DELETE") {
      const status = adminStatuses.shift() ?? 200;
      return Response.json(
        status === 200
          ? {}
          : {
              code: "unexpected_failure",
              msg: "Auth deletion temporarily unavailable",
            },
        { status },
      );
    }
    throw new Error(`unexpected auth endpoint: ${new URL(call.url).pathname}`);
  };
  return {
    userId,
    token,
    external,
    adminStatuses,
    confirm: () =>
      h.handler(
        userRequest("POST", "/v1/me/delete-confirm", {
          token,
          ip: "198.51.100.91",
          body: { challenge },
        }),
      ),
  };
}

for (const providers of [["google", "apple"], ["google"]]) {
  Deno.test(
    `access-token deletion revokes stored Apple credentials even when the primary provider is Google (${providers.join(",")})`,
    async () => {
      const c = await googleSessionDeletion(providers);
      const response = await c.confirm();
      assertEquals(response.status, 200);
      assertEquals(await response.json(), {
        deleted: true,
        appleAuthorizationRevocation: "revoked",
      });
      const auth = h.callsTo("/auth/v1/user");
      assertEquals(auth.length, 1);
      assertEquals(auth[0].headers.authorization, `Bearer ${c.token}`);
      assertEquals(
        h.callsTo("grant_type=id_token").length,
        0,
        "exercise the current access-token path, not legacy provider auth",
      );

      const apple = h.calls.findIndex((call) => call.url.includes("appleid.apple.com/auth/revoke"));
      const checkpoint = h.calls.findIndex(
        (call) =>
          call.url.includes("/rest/v1/account_external_credentials") && call.method === "PATCH",
      );
      const revenueCat = h.calls.findIndex(
        (call) => call.url.startsWith(RC_URL) && call.method === "DELETE",
      );
      const admin = h.calls.findIndex(
        (call) => call.url.includes("/auth/v1/admin/users/") && call.method === "DELETE",
      );
      assert(apple >= 0);
      assert(checkpoint > apple);
      assert(revenueCat > checkpoint);
      assert(admin > revenueCat);
      const revoked = new URLSearchParams(String(h.calls[apple].body));
      assertEquals(revoked.get("token"), "linked-apple-refresh-to-revoke");
      assertEquals(revoked.get("token_type_hint"), "refresh_token");
      assert(c.external.apple_revoked_at);
      assert(c.external.revenuecat_deleted_at);
      for (const call of h.callsTo("/rest/v1/account_external_credentials")) {
        assertEquals(call.headers.apikey, "service-role-test-key");
        assertEquals(call.headers.authorization, "Bearer service-role-test-key");
      }
      assertEquals(
        h.callsTo("/rest/v1/account_deletion_requests")[0].headers.authorization,
        `Bearer ${c.token}`,
      );
      assertEquals(h.calls[admin].headers.authorization, "Bearer service-role-test-key");
    },
  );
}

Deno.test(
  "access-token deletion retries checkpointed Apple/RevenueCat cleanup after downstream failures",
  async () => {
    const c = await googleSessionDeletion();
    h.subscriber = null;
    const revenueCatOutage = await c.confirm();
    assertEquals(revenueCatOutage.status, 503);
    await revenueCatOutage.body?.cancel();
    assertEquals(h.callsTo("appleid.apple.com/auth/revoke").length, 1);
    assert(
      c.external.apple_revoked_at,
      "the successful revocation must be checkpointed before RevenueCat",
    );
    const revokedAt = c.external.apple_revoked_at;
    assertEquals(c.external.revenuecat_deleted_at, null);
    assertEquals(h.callsTo("/auth/v1/admin/users/").length, 0);

    h.subscriber = {};
    c.adminStatuses.push(503);
    const authOutage = await c.confirm();
    assertEquals(authOutage.status, 503);
    await authOutage.body?.cancel();
    assertEquals(
      h.callsTo("appleid.apple.com/auth/revoke").length,
      1,
      "do not revoke an already-checkpointed credential",
    );
    assertEquals(c.external.apple_revoked_at, revokedAt);
    assert(c.external.revenuecat_deleted_at);
    const deletedAt = c.external.revenuecat_deleted_at;

    const recovered = await c.confirm();
    assertEquals(recovered.status, 200);
    assertEquals(await recovered.json(), {
      deleted: true,
      appleAuthorizationRevocation: "revoked",
    });
    assertEquals(h.callsTo("appleid.apple.com/auth/revoke").length, 1);
    assertEquals(
      h.callsTo(RC_URL).length,
      2,
      "one failed RevenueCat delete and one successful retry",
    );
    assertEquals(h.callsTo("/auth/v1/admin/users/").length, 2);
    assertEquals(c.external.revenuecat_deleted_at, deletedAt);
    assertEquals(h.callsTo("grant_type=id_token").length, 0);
  },
);

for (const token of [null, "unreadable-but-already-revoked"]) {
  Deno.test(
    `access-token deletion honors an Apple revoked checkpoint without decrypting (${token ?? "no token"})`,
    async () => {
      const c = await googleSessionDeletion();
      c.external.apple_refresh_token_encrypted = token;
      c.external.apple_revoked_at = new Date(Date.now() - 1_000).toISOString();
      c.external.revenuecat_deleted_at = c.external.apple_revoked_at;
      const response = await c.confirm();
      assertEquals(response.status, 200);
      assertEquals(await response.json(), {
        deleted: true,
        appleAuthorizationRevocation: "revoked",
      });
      assertEquals(h.callsTo("appleid.apple.com/auth/revoke").length, 0);
      assertEquals(h.callsTo(RC_URL).length, 0);
      assertEquals(h.callsTo("/auth/v1/admin/users/").length, 1);
    },
  );
}

Deno.test(
  "access-token deletion fails closed on an unreadable stored Apple credential despite Google primary auth",
  async () => {
    const c = await googleSessionDeletion();
    c.external.apple_refresh_token_encrypted = "unreadable-apple-credential";
    const response = await c.confirm();
    assertEquals(response.status, 503);
    const text = await response.text();
    assertEquals(JSON.parse(text), {
      error: { message: "Account deletion is temporarily unavailable. Please try again." },
    });
    assert(!text.includes("unreadable-apple-credential"));
    assert(!text.includes(c.token));
    assertEquals(c.external.apple_revoked_at, null);
    assertEquals(h.callsTo("appleid.apple.com/auth/revoke").length, 0);
    assertEquals(h.callsTo(RC_URL).length, 0);
    assertEquals(h.callsTo("/auth/v1/admin/users/").length, 0);
  },
);

Deno.test(
  "access-token Google deletion without stored Apple credentials stays not_applicable",
  async () => {
    const c = await googleSessionDeletion(["google"]);
    h.tables.account_external_credentials = [];
    const response = await c.confirm();
    assertEquals(response.status, 200);
    assertEquals(await response.json(), {
      deleted: true,
      appleAuthorizationRevocation: "not_applicable",
    });
    assertEquals(h.callsTo("appleid.apple.com/auth/revoke").length, 0);
    assertEquals(h.callsTo(RC_URL).length, 1);
    assertEquals(h.callsTo("/auth/v1/admin/users/").length, 1);
  },
);

for (const phase of ["apple_exchange", "apple_revoke", "auth_delete"] as const) {
  Deno.test(
    `${phase} errors use only safe diagnostics, never upstream messages or unknown codes`,
    async () => {
      const privateDetail = "private-provider-detail-must-not-be-logged";
      let invoke: () => Promise<Response>;
      if (phase === "apple_exchange") {
        h.reset();
        h.tables.profiles = [profile()];
        invoke = () =>
          h.handler(
            userRequest("POST", "/v1/account/bootstrap", {
              token: fakeAppleIdToken(),
              body: { appleAuthorizationCode: "private-one-use-code" },
            }),
          );
      } else {
        invoke = (await googleSessionDeletion()).confirm;
      }
      const stubbedFetch = globalThis.fetch;
      const originalError = console.error;
      const logs: string[] = [];
      let failures = 0;
      console.error = (...values) =>
        logs.push(values.map((value) => Deno.inspect(value)).join(" "));
      globalThis.fetch = (input, init) => {
        const url = new Request(input, init).url;
        const target =
          phase === "apple_exchange"
            ? "appleid.apple.com/auth/token"
            : phase === "apple_revoke"
              ? "appleid.apple.com/auth/revoke"
              : "/auth/v1/admin/users/";
        if (url.includes(target)) {
          failures += 1;
          return Promise.resolve(
            Response.json(
              {
                code: "unexpected_failure",
                error: privateDetail,
                error_description: privateDetail,
                msg: privateDetail,
              },
              { status: phase === "auth_delete" ? 400 : 503 },
            ),
          );
        }
        return stubbedFetch(input, init);
      };
      try {
        const response = await invoke();
        assertEquals(response.status, 503);
        assertEquals(failures, 1);
        const output = `${await response.text()}\n${logs.join("\n")}`;
        for (const secret of [
          privateDetail,
          "private-one-use-code",
          "linked-apple-refresh-to-revoke",
          h.appleTokenEncryptionKey,
        ]) {
          assert(
            !output.includes(secret),
            "upstream error details must never reach responses or logs",
          );
        }
      } finally {
        globalThis.fetch = stubbedFetch;
        console.error = originalError;
      }
    },
  );
}
