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

type FetchFn = typeof fetch;

/** Wrap the harness fetch for one test: `intercept` may return a Response
 * (or throw) for requests it wants to own; anything else falls through. */
async function withFetchIntercept<T>(
  intercept: (request: Request) => Promise<Response | null>,
  run: () => Promise<T>,
): Promise<T> {
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const owned = await intercept(request.clone());
    if (owned) return owned;
    return inner(input, init);
  }) as FetchFn;
  try {
    return await run();
  } finally {
    globalThis.fetch = inner;
  }
}

function pendingDeletion(challenge: string) {
  return [
    {
      challenge,
      created_at: new Date(Date.now() - 10_000).toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    },
  ];
}

/** Each deletion scenario signs in as its own Apple subject: delete-confirm
 * has a per-user budget of 5/hour and the harness never resets limiter state. */
function deleteConfirm(challenge: string, ip: string, userId: string): Promise<Response> {
  return h.handler(
    userRequest("POST", "/v1/me/delete-confirm", {
      token: fakeAppleIdToken(userId),
      ip,
      body: { challenge },
    }),
  );
}

const revenueCatDeletes = () =>
  h.calls.filter((call) => call.url.startsWith(RC_URL) && call.method === "DELETE");
const authAdminDeletes = () =>
  h.calls.filter((call) => call.url.includes("/auth/v1/admin/users/") && call.method === "DELETE");
const appleRevokes = () => h.callsTo("appleid.apple.com/auth/revoke");
/** Service-role writes to the external-credential row (checkpoints). */
const credentialWrites = () =>
  h.calls.filter(
    (call) =>
      call.url.includes("/rest/v1/account_external_credentials") &&
      (call.method === "PATCH" || call.method === "POST"),
  );

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
    // The successful revocation is checkpointed BEFORE RevenueCat is touched,
    // so a later provider failure retries without revoking twice.
    const checkpointIndex = h.calls.findIndex(
      (call) =>
        call.url.includes("/rest/v1/account_external_credentials") &&
        call.method === "PATCH" &&
        typeof (call.body as Record<string, unknown>)?.apple_revoked_at === "string",
    );
    assert(checkpointIndex > appleIndex, "apple_revoked_at is written after the revoke");
    assert(checkpointIndex < revenueCatIndex, "apple_revoked_at is written before RevenueCat");

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

// ─── Permanent vs transient Apple revocation failures (EDR-2) ────────────────
// Apple requires account deletion to be fulfilled. A stored credential that
// can never be revoked (ciphertext under a rotated key, a token Apple refuses
// with 4xx) must not leave the account undeletable behind a 503 forever: the
// credential is dropped as a checkpoint, RevenueCat + Supabase Auth deletion
// proceed, and the client is told to disconnect manually. Only failures that a
// retry can fix (transport, Apple 5xx/429) keep the fail-closed 503 and touch
// neither RevenueCat nor Supabase Auth.

const GENERIC_DELETION_503 = {
  error: { message: "Account deletion is temporarily unavailable. Please try again." },
};

function storedAppleCredential(encrypted: string) {
  return [
    {
      apple_refresh_token_encrypted: encrypted,
      apple_revoked_at: null,
      revenuecat_deleted_at: null,
    },
  ];
}

function assertPermanentFailureFulfilled(): void {
  assertEquals(revenueCatDeletes().length, 1, "RevenueCat subscriber erased once");
  assertEquals(authAdminDeletes().length, 1, "Supabase identity deleted once");
  const clearedIndex = h.calls.findIndex(
    (call) =>
      call.url.includes("/rest/v1/account_external_credentials") &&
      call.method === "PATCH" &&
      (call.body as Record<string, unknown>)?.apple_refresh_token_encrypted === null,
  );
  assert(clearedIndex >= 0, "the unrevocable Apple credential is cleared (checkpoint)");
  const revenueCatIndex = h.calls.findIndex(
    (call) => call.url.startsWith(RC_URL) && call.method === "DELETE",
  );
  assert(clearedIndex < revenueCatIndex, "the checkpoint lands before RevenueCat deletion");
  const cleared = h.calls[clearedIndex]?.body as Record<string, unknown>;
  assertEquals(cleared.apple_token_captured_at, null, "capture pair constraint kept");
  assertEquals(cleared.apple_revoked_at, undefined, "never claims a revocation that failed");
}

Deno.test(
  "delete-confirm: Apple token encrypted under a rotated key is unrevocable → 200 manual_action_required, RevenueCat + Auth deleted",
  async () => {
    h.reset();
    const challenge = "55555555-5555-4555-8555-555555555555";
    const userId = "aaaaaaaa-0001-4aaa-8aaa-aaaaaaaaaaaa";
    h.tables.account_deletion_requests = pendingDeletion(challenge);
    const rotatedKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    h.tables.account_external_credentials = storedAppleCredential(
      await encryptAppleRefreshToken("refresh-under-old-key", userId, rotatedKey),
    );

    const response = await deleteConfirm(challenge, "203.0.113.31", userId);
    assertEquals(response.status, 200);
    assertEquals(await response.json(), {
      deleted: true,
      appleAuthorizationRevocation: "manual_action_required",
    });
    assertEquals(appleRevokes().length, 0, "an undecryptable token is never sent to Apple");
    assertPermanentFailureFulfilled();
  },
);

Deno.test(
  "delete-confirm: Apple revoke 400 invalid_grant is permanent → 200 manual_action_required, RevenueCat + Auth deleted",
  async () => {
    {
      const code = "invalid_grant";
      h.reset();
      const challenge = "56565656-5656-4656-8656-565656565656";
      const userId = "bbbbbbbb-0000-4bbb-8bbb-bbbbbbbbbbbb";
      h.tables.account_deletion_requests = pendingDeletion(challenge);
      h.tables.account_external_credentials = storedAppleCredential(
        await encryptAppleRefreshToken("refresh-apple-refuses", userId, h.appleTokenEncryptionKey),
      );

      let revokeCalls = 0;
      const response = await withFetchIntercept(
        async (request) => {
          if (request.url === "https://appleid.apple.com/auth/revoke") {
            revokeCalls += 1;
            return new Response(JSON.stringify({ error: code }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }
          return null;
        },
        () => deleteConfirm(challenge, "203.0.113.32", userId),
      );
      assertEquals(response.status, 200);
      assertEquals(await response.json(), {
        deleted: true,
        appleAuthorizationRevocation: "manual_action_required",
      });
      assertEquals(revokeCalls, 1);
      assertPermanentFailureFulfilled();
    }
  },
);

// Only `invalid_grant` refuses the stored token. Apple's other ErrorResponse
// codes blame OUR client secret / request (rotated .p8, wrong key id, clock
// skew) and code-less 4xx blame the path to Apple — the operator repairs
// those and the SAME token revokes afterwards, so the credential must survive.
const appleError = (status: number, code: string): Response =>
  new Response(JSON.stringify({ error: code }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const transientAppleFailures: Array<[string, () => Promise<Response>]> = [
  ["503", () => Promise.resolve(new Response("upstream error", { status: 503 }))],
  ["429", () => Promise.resolve(new Response(null, { status: 429 }))],
  ["400 invalid_client", () => Promise.resolve(appleError(400, "invalid_client"))],
  ["400 invalid_request", () => Promise.resolve(appleError(400, "invalid_request"))],
  ["401 without a body", () => Promise.resolve(new Response(null, { status: 401 }))],
  ["403 without a body", () => Promise.resolve(new Response("Forbidden", { status: 403 }))],
  [
    "fetch rejection",
    () => Promise.reject(new TypeError("error sending request: connection reset")),
  ],
];

for (const [index, [label, failure]] of transientAppleFailures.entries()) {
  Deno.test(
    `delete-confirm: Apple revoke ${label} is transient → 503, neither RevenueCat nor Auth deletion runs`,
    async () => {
      h.reset();
      const challenge = "57575757-5757-4757-8757-575757575757";
      const userId = `cccccccc-000${index}-4ccc-8ccc-cccccccccccc`;
      h.tables.account_deletion_requests = pendingDeletion(challenge);
      h.tables.account_external_credentials = storedAppleCredential(
        await encryptAppleRefreshToken("refresh-still-valid", userId, h.appleTokenEncryptionKey),
      );

      let revokeCalls = 0;
      const response = await withFetchIntercept(
        (request) => {
          if (request.url !== "https://appleid.apple.com/auth/revoke") return Promise.resolve(null);
          revokeCalls += 1;
          return failure();
        },
        () => deleteConfirm(challenge, "203.0.113.33", userId),
      );
      assertEquals(response.status, 503);
      assertEquals(await response.json(), GENERIC_DELETION_503);
      assertEquals(revokeCalls, 1);
      assertEquals(revenueCatDeletes().length, 0, "fail closed: RevenueCat untouched");
      assertEquals(authAdminDeletes().length, 0, "fail closed: Supabase identity kept");
      assertEquals(credentialWrites().length, 0, "no checkpoint for a retryable failure");
    },
  );
}
