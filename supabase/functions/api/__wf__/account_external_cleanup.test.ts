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

// ─── Apple revocation failure classes ──────────────────────────────────────
// Apple says deletion must ALWAYS be fulfilled. A credential that can never
// be revoked by retrying (undecryptable after a key rotation, or refused by
// Apple with a non-retryable 4xx) is checkpointed as unrevocable and the
// deletion continues with the legacy `manual_action_required` outcome. Only
// a transient Apple failure (unreachable, 5xx, 429) fails closed with 503 and
// leaves RevenueCat and Supabase Auth untouched (ordering guarantee).

type FetchFn = typeof fetch;

/** Own the Apple revoke call for one test (still recorded in h.calls so
 * ordering assertions work); everything else falls through to the harness. */
async function withAppleRevoke<T>(
  revoke: () => Promise<Response>,
  run: () => Promise<T>,
): Promise<T> {
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === "https://appleid.apple.com/auth/revoke") {
      h.calls.push({
        url: request.url,
        method: request.method,
        headers: {},
        body: await request.text(),
      });
      return revoke();
    }
    return inner(input, init);
  }) as FetchFn;
  try {
    return await run();
  } finally {
    globalThis.fetch = inner;
  }
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function pendingDeletion(challenge: string) {
  return [
    {
      challenge,
      created_at: new Date(Date.now() - 10_000).toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    },
  ];
}

/** delete-confirm has a 5/hour per-user budget: each case below is its own
 * Apple user so the budget never decides a test. */
async function appleUserWithStoredCredential(
  refreshToken: string,
  key = h.appleTokenEncryptionKey,
): Promise<{ userId: string; token: string }> {
  const userId = crypto.randomUUID();
  h.tables.profiles = [{ id: userId, email: "apple@example.com", provider: "apple" }];
  h.tables.account_external_credentials = [
    {
      apple_refresh_token_encrypted: await encryptAppleRefreshToken(refreshToken, userId, key),
      apple_revoked_at: null,
      revenuecat_deleted_at: null,
    },
  ];
  return { userId, token: fakeAppleIdToken(userId) };
}

const deleteConfirm = (token: string, challenge: string) =>
  h.handler(userRequest("POST", "/v1/me/delete-confirm", { token, body: { challenge } }));

const revenueCatDeletes = () =>
  h.calls.filter((call) => call.url.startsWith(RC_URL) && call.method === "DELETE");
const authAdminDeletes = () =>
  h.calls.filter((call) => call.url.includes("/auth/v1/admin/users/") && call.method === "DELETE");
/** PATCHes that null out the stored Apple ciphertext (the unrevocable checkpoint). */
const credentialCleared = () =>
  h.calls.filter(
    (call) =>
      call.url.includes("/rest/v1/account_external_credentials") &&
      call.method === "PATCH" &&
      (call.body as Record<string, unknown>).apple_refresh_token_encrypted === null,
  );

Deno.test(
  "delete-confirm: Apple token encrypted under a rotated key is unrevocable → deletion completes with manual_action_required",
  async () => {
    h.reset();
    const challenge = "55555555-5555-4555-8555-555555555555";
    h.tables.account_deletion_requests = pendingDeletion(challenge);
    const rotatedKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const { token } = await appleUserWithStoredCredential("refresh-under-old-key", rotatedKey);

    const response = await deleteConfirm(token, challenge);
    assertEquals(response.status, 200, JSON.stringify(await response.clone().json()));
    assertEquals(await response.json(), {
      deleted: true,
      appleAuthorizationRevocation: "manual_action_required",
    });
    assertEquals(h.callsTo("appleid.apple.com/auth/revoke").length, 0);
    assertEquals(credentialCleared().length, 1, "unrevocable credential is checkpointed");
    assertEquals(revenueCatDeletes().length, 1);
    assertEquals(authAdminDeletes().length, 1);
  },
);

Deno.test(
  "delete-confirm: Apple 400 invalid_grant (already revoked/expired) is unrevocable → deletion completes with manual_action_required",
  async () => {
    h.reset();
    const challenge = "66666666-6666-4666-8666-666666666666";
    h.tables.account_deletion_requests = pendingDeletion(challenge);
    const { token } = await appleUserWithStoredCredential("refresh-already-revoked");

    const response = await withAppleRevoke(
      () => Promise.resolve(jsonResponse(400, { error: "invalid_grant" })),
      () => deleteConfirm(token, challenge),
    );
    assertEquals(response.status, 200, JSON.stringify(await response.clone().json()));
    assertEquals(await response.json(), {
      deleted: true,
      appleAuthorizationRevocation: "manual_action_required",
    });
    assertEquals(h.callsTo("appleid.apple.com/auth/revoke").length, 1);
    assertEquals(credentialCleared().length, 1, "unrevocable credential is checkpointed");
    assertEquals(revenueCatDeletes().length, 1);
    assertEquals(authAdminDeletes().length, 1);
  },
);

Deno.test(
  "delete-confirm: Apple 400 invalid_client is unrevocable → deletion completes with manual_action_required",
  async () => {
    h.reset();
    const challenge = "67676767-6767-4767-8767-676767676767";
    h.tables.account_deletion_requests = pendingDeletion(challenge);
    const { token } = await appleUserWithStoredCredential("refresh-bad-client");

    const response = await withAppleRevoke(
      () => Promise.resolve(jsonResponse(400, { error: "invalid_client" })),
      () => deleteConfirm(token, challenge),
    );
    assertEquals(response.status, 200, JSON.stringify(await response.clone().json()));
    assertEquals(
      ((await response.json()) as { appleAuthorizationRevocation: string })
        .appleAuthorizationRevocation,
      "manual_action_required",
    );
    assertEquals(revenueCatDeletes().length, 1);
    assertEquals(authAdminDeletes().length, 1);
  },
);

for (const [label, revoke] of [
  ["Apple 503", () => Promise.resolve(new Response("upstream error", { status: 503 }))],
  ["Apple 429", () => Promise.resolve(jsonResponse(429, { error: "slow_down" }))],
  [
    "Apple unreachable (fetch rejects)",
    () => Promise.reject(new TypeError("error sending request: connection reset")),
  ],
] as Array<[string, () => Promise<Response>]>) {
  Deno.test(
    `delete-confirm: ${label} is transient → 503, and neither RevenueCat nor Supabase Auth is touched`,
    async () => {
      h.reset();
      const challenge = "77777777-7777-4777-8777-777777777777";
      h.tables.account_deletion_requests = pendingDeletion(challenge);
      const { token } = await appleUserWithStoredCredential("refresh-transient");

      const response = await withAppleRevoke(revoke, () => deleteConfirm(token, challenge));
      assertEquals(response.status, 503);
      assertEquals(await response.json(), {
        error: { message: "Account deletion is temporarily unavailable. Please try again." },
      });
      assertEquals(h.callsTo("appleid.apple.com/auth/revoke").length, 1);
      assertEquals(credentialCleared().length, 0, "a retryable failure is not checkpointed");
      assertEquals(revenueCatDeletes().length, 0);
      assertEquals(authAdminDeletes().length, 0);
    },
  );
}

Deno.test(
  "delete-confirm: a successful Apple revocation is checkpointed (apple_revoked_at) BEFORE RevenueCat deletion",
  async () => {
    h.reset();
    const challenge = "88888888-8888-4888-8888-888888888888";
    h.tables.account_deletion_requests = pendingDeletion(challenge);
    const { token } = await appleUserWithStoredCredential("refresh-to-revoke");

    const response = await deleteConfirm(token, challenge);
    assertEquals(response.status, 200);
    assertEquals(await response.json(), {
      deleted: true,
      appleAuthorizationRevocation: "revoked",
    });

    const revokeIndex = h.calls.findIndex((call) =>
      call.url.includes("appleid.apple.com/auth/revoke"),
    );
    const checkpointIndex = h.calls.findIndex(
      (call) =>
        call.url.includes("/rest/v1/account_external_credentials") &&
        call.method === "PATCH" &&
        typeof (call.body as Record<string, unknown>).apple_revoked_at === "string",
    );
    const revenueCatIndex = h.calls.findIndex(
      (call) => call.url.startsWith(RC_URL) && call.method === "DELETE",
    );
    assert(revokeIndex >= 0, "Apple revoke was called");
    assert(checkpointIndex > revokeIndex, "apple_revoked_at is written after the revoke");
    assert(revenueCatIndex > checkpointIndex, "RevenueCat deletion follows the checkpoint");
    assertEquals(credentialCleared().length, 0);
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
