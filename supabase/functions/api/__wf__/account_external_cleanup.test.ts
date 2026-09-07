import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { encryptAppleRefreshToken } from "../externalAccounts.ts";
import {
  RC_URL,
  OTHER_USER_ID,
  TEST_USER_ID,
  captureConsole,
  fakeAppleIdToken,
  fakeGoogleIdToken,
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
    const stored = h.callsTo("/rpc/store_account_apple_credential").at(-1)?.body as Record<
      string,
      unknown
    >;
    assertEquals(stored.p_owner_id, TEST_USER_ID);
    assertEquals(typeof stored.p_encrypted_token, "string");
    assertStringIncludes(String(stored.p_encrypted_token), "v1.");
    assertEquals(h.callsTo("/rest/v1/account_external_credentials").length, 0);
    assertEquals(JSON.stringify(stored).includes("apple-refresh-token-from-grant"), false);
    assertEquals(JSON.stringify(stored).includes("one-use-authorization-code"), false);
  },
);

Deno.test("legacy Apple bootstrap remains compatible before the mobile update ships", async () => {
  h.reset();
  h.tables.profiles = [profile()];

  const { result: response, logs } = await captureConsole(() =>
    h.handler(
      userRequest("POST", "/v1/account/bootstrap", {
        token: fakeAppleIdToken(),
        body: {},
      }),
    ),
  );

  assertEquals(response.status, 200);
  assertEquals(logs, [
    { level: "warn", args: ["[api] legacy Apple bootstrap has no revocation credential"] },
  ]);
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

    const { result: response, logs } = await captureConsole(() =>
      h.handler(
        userRequest("POST", "/v1/me/delete-confirm", {
          token: fakeAppleIdToken(),
          body: { challenge },
        }),
      ),
    );
    assertEquals(response.status, 200);
    const completed = await response.json();
    assertEquals(completed.deleted, true);
    assertEquals(completed.appleAuthorizationRevocation, "revoked");
    assertEquals(typeof completed.operationId, "string");
    assertEquals(typeof completed.completionReceipt.completedAt, "string");
    assertEquals(logs, [{ level: "warn", args: ["[api] account deleted"] }]);

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
    h.deletion.appleOwners.add(TEST_USER_ID);

    const { result: response, logs } = await captureConsole(() =>
      h.handler(
        userRequest("POST", "/v1/me/delete-confirm", {
          token: fakeAppleIdToken(),
          body: { challenge },
        }),
      ),
    );
    assertEquals(response.status, 200);
    const completed = await response.json();
    assertEquals(completed.deleted, true);
    assertEquals(completed.appleAuthorizationRevocation, "manual_action_required");
    assertEquals(typeof completed.completionReceipt.completedAt, "string");
    assertEquals(logs, [
      { level: "warn", args: ["[api] account deletion has no Apple revocation token"] },
      { level: "warn", args: ["[api] account deleted"] },
    ]);
    assertEquals(h.callsTo("appleid.apple.com/auth/revoke").length, 0);
    assertEquals(
      h.calls.some((call) => call.url.startsWith(RC_URL) && call.method === "DELETE"),
      true,
    );
  },
);

Deno.test(
  "delete-confirm revokes a stored Apple token even when the current session is Google",
  async () => {
    h.reset();
    const challenge = "55555555-5555-4555-8555-555555555555";
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
          "linked-apple-refresh-to-revoke",
          TEST_USER_ID,
          h.appleTokenEncryptionKey,
        ),
        apple_revoked_at: null,
        revenuecat_deleted_at: null,
      },
    ];
    const response = await h.handler(
      userRequest("POST", "/v1/me/delete-confirm", {
        token: fakeGoogleIdToken(),
        body: { challenge },
      }),
    );
    assertEquals(response.status, 200);
    const completed = await response.json();
    assertEquals(completed.deleted, true);
    assertEquals(completed.appleAuthorizationRevocation, "revoked");
    assertEquals(typeof completed.completionReceipt.completedAt, "string");
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
    assertStringIncludes(String(h.calls[appleIndex].body), "token=linked-apple-refresh-to-revoke");
    assert(
      h.calls.some(
        (call) =>
          call.url.includes("/rpc/checkpoint_account_deletion_operation") &&
          (call.body as Record<string, unknown>).p_checkpoint === "apple" &&
          (call.body as Record<string, unknown>).p_apple_outcome === "revoked",
      ),
    );
  },
);

interface RequestedDeletion {
  challenge: string;
  expiresAt: string;
  operationId: string;
  statusCapability: string;
  statusExpiresAt: string;
}

async function requestedDeletion(ownerId = crypto.randomUUID()): Promise<RequestedDeletion> {
  const response = await h.handler(
    userRequest("POST", "/v1/me/delete-request", {
      token: fakeSupabaseAccessToken(ownerId),
      body: {},
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("Cache-Control"), "no-store");
  assertEquals(response.headers.get("Referrer-Policy"), "no-referrer");
  const result = await response.json();
  assertEquals(Object.keys(result).sort(), [
    "challenge",
    "expiresAt",
    "operationId",
    "statusCapability",
    "statusExpiresAt",
  ]);
  assertEquals(result.statusCapability.length, 43);
  assertEquals(typeof result.operationId, "string");
  return result;
}

function deletionStatus(
  operation: RequestedDeletion,
  ip = "198.51.100.81",
  path = "/v1/me/delete-status",
): Promise<Response> {
  return h.handler(
    userRequest("POST", path, {
      token: operation.statusCapability,
      body: { operationId: operation.operationId },
      ip,
    }),
  );
}

function confirmDeletion(ownerId: string, operation: RequestedDeletion): Promise<Response> {
  return h.handler(
    userRequest("POST", "/v1/me/delete-confirm", {
      token: fakeSupabaseAccessToken(ownerId),
      body: { challenge: operation.challenge, operationId: operation.operationId },
    }),
  );
}

function assertStatusHeaders(response: Response): void {
  assertEquals(response.headers.get("Cache-Control"), "no-store");
  assertEquals(response.headers.get("Referrer-Policy"), "no-referrer");
  assertEquals(response.headers.get("Vary"), "Authorization");
}

Deno.test(
  "W08 route: dropped request reply is superseded, never implicitly confirmed",
  async () => {
    h.reset();
    const owner = crypto.randomUUID();
    const dropped = await requestedDeletion(owner);
    const retried = await requestedDeletion(owner);
    assert(dropped.operationId !== retried.operationId);
    assert(dropped.challenge !== retried.challenge);
    assert(dropped.statusCapability !== retried.statusCapability);
    assertEquals(
      (await (await deletionStatus(dropped, "198.51.100.82")).json()).state,
      "superseded",
    );
    assertEquals((await (await deletionStatus(retried, "198.51.100.82")).json()).state, "pending");
    assertEquals((await confirmDeletion(owner, dropped)).status, 403);
    assertEquals(h.callsTo("/auth/v1/admin/users/").length, 0);
    assertEquals(h.callsTo(RC_URL).length, 0);
    assertEquals(h.callsTo("/rest/v1/account_deletion_requests").length, 0);
    assert(!JSON.stringify(h.calls).includes(retried.statusCapability));
    assert(!JSON.stringify(h.calls).includes(retried.challenge));
  },
);

Deno.test(
  "W08 route: a lost begin RPC acknowledgement leaves honest pending work and allows a new request",
  async () => {
    h.reset();
    const owner = crypto.randomUUID();
    h.respond = async (call) => {
      if (!call.url.includes("/rpc/begin_account_deletion_operation")) return null;
      await h.deletion.rpc(
        "begin_account_deletion_operation",
        call.body as Record<string, unknown>,
      );
      return Response.json({ message: "FAKE-private-lost-reply" }, { status: 503 });
    };
    const failed = await h.handler(
      userRequest("POST", "/v1/me/delete-request", {
        token: fakeSupabaseAccessToken(owner),
        body: {},
      }),
    );
    assertEquals(failed.status, 503);
    assert(!(await failed.text()).includes("FAKE-"));
    assertEquals(h.deletion.operations.size, 1);
    assertEquals([...h.deletion.operations.values()][0].confirmedAtMs, null);
    h.respond = () => null;
    await requestedDeletion(owner);
    assertEquals([...h.deletion.operations.values()].filter((row) => row.superseded).length, 1);
    assertEquals(h.callsTo(RC_URL).length, 0);
  },
);

Deno.test(
  "W08 route: dropped confirm reply is recovered after Auth and session are gone, with no account data",
  async () => {
    h.reset();
    const owner = crypto.randomUUID();
    const operation = await requestedDeletion(owner);
    h.deletion.age(operation.operationId);
    const confirmed = await confirmDeletion(owner, operation);
    assertEquals(confirmed.status, 200);
    const receipt = (await confirmed.json()).completionReceipt;
    assertEquals(typeof receipt.completedAt, "string");
    h.userStatus = 401;
    h.rpcs.is_api_session_active = false;
    h.calls = [];
    const { result, logs } = await captureConsole(() => deletionStatus(operation, "198.51.100.83"));
    assertEquals(result.status, 200);
    assertStatusHeaders(result);
    assertEquals(await result.json(), {
      state: "completed",
      completionReceipt: receipt,
      appleAuthorizationRevocation: "not_applicable",
    });
    assertEquals(logs, []);
    assertEquals(h.calls.length, 1);
    assert(h.calls[0].url.endsWith("/rpc/read_account_deletion_status"));
    assertEquals(h.calls[0].headers.authorization, "Bearer service-role-test-key");
    assert(!JSON.stringify(h.calls).includes(operation.statusCapability));
    assert(!JSON.stringify(h.calls[0].body).includes(owner));
  },
);

Deno.test(
  "W08 route: dropped Auth delete reply cannot fabricate success but status can read its trigger receipt",
  async () => {
    h.reset();
    const owner = crypto.randomUUID();
    const operation = await requestedDeletion(owner);
    h.deletion.age(operation.operationId);
    h.respond = (call) => {
      if (call.method !== "DELETE" || !call.url.includes("/auth/v1/admin/users/")) return null;
      h.deletion.observeAuthDeletion(owner);
      throw new TypeError("FAKE-private-lost-auth-response");
    };
    const response = await confirmDeletion(owner, operation);
    assertEquals(response.status, 503);
    assert(!(await response.text()).includes("FAKE-"));
    h.calls = [];
    h.rpcs.is_api_session_active = false;
    const status = await deletionStatus(operation, "198.51.100.84");
    assertEquals(status.status, 200);
    assertEquals((await status.json()).state, "completed");
    assertEquals(h.calls.length, 1);
  },
);

Deno.test(
  "W08 route: unknown, mismatched, expired and malformed capabilities share a minimal absence",
  async () => {
    h.reset();
    const operation = await requestedDeletion();
    const unknown = { ...operation, operationId: crypto.randomUUID() };
    const mismatched = { ...operation, statusCapability: "A".repeat(43) };
    const malformed = { ...operation, statusCapability: "not-a-status-capability" };
    const responses = [];
    for (const candidate of [unknown, mismatched, malformed])
      responses.push(await deletionStatus(candidate, "198.51.100.85"));
    h.deletion.age(operation.operationId, 86_400_001);
    responses.push(await deletionStatus(operation, "198.51.100.85"));
    for (const response of responses) {
      assertEquals(response.status, 404);
      assertStatusHeaders(response);
      assertEquals(await response.json(), {
        error: { code: "account.deletion_status_unavailable" },
      });
    }
    assertEquals(h.callsTo("/rpc/confirm_account_deletion_operation").length, 0);
    assertEquals(h.callsTo("/rpc/claim_account_deletion_work").length, 0);
    assertEquals(h.callsTo(RC_URL).length, 0);
  },
);

Deno.test(
  "W08 route: capabilities cannot authorize account reads, deletion, bootstrap, refresh or logout",
  async () => {
    h.reset();
    const operation = await requestedDeletion();
    h.calls = [];
    for (const [method, path, body] of [
      ["GET", "/v1/me", undefined],
      ["POST", "/v1/me/delete-request", {}],
      [
        "POST",
        "/v1/me/delete-confirm",
        { challenge: operation.challenge, operationId: operation.operationId },
      ],
      ["POST", "/v1/account/bootstrap", {}],
      ["POST", "/v1/auth/refresh", { refreshToken: operation.statusCapability }],
      ["POST", "/v1/auth/logout", {}],
    ] as const) {
      const response = await h.handler(
        userRequest(method, path, { token: operation.statusCapability, body, ip: "198.51.100.86" }),
      );
      assert([400, 401, 403].includes(response.status));
    }
    // A body-only capability must not be sent to Auth as a refresh credential either.
    const refresh = await h.handler(
      userRequest("POST", "/v1/auth/refresh", {
        headers: { Authorization: "" },
        body: { refreshToken: operation.statusCapability },
        ip: "198.51.100.86",
      }),
    );
    assertEquals(refresh.status, 400);
    assertEquals(h.calls, []);
  },
);

Deno.test(
  "W08 route: public status accepts only exact mount paths and rejects URL/body credentials and methods",
  async () => {
    h.reset();
    const operation = await requestedDeletion();
    for (const mount of ["", "/api", "/functions/v1/api"]) {
      const response = await h.handler(
        new Request(`http://edge.test${mount}/v1/me/delete-status`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${operation.statusCapability}`,
            "x-forwarded-for": "198.51.100.87",
          },
          body: JSON.stringify({ operationId: operation.operationId }),
        }),
      );
      assertEquals(response.status, 200);
    }
    h.calls = [];
    const requests = [
      userRequest("GET", "/v1/me/delete-status", {
        token: operation.statusCapability,
        ip: "198.51.100.88",
      }),
      userRequest("POST", `/v1/me/delete-status?capability=${operation.statusCapability}`, {
        token: operation.statusCapability,
        body: { operationId: operation.operationId },
        ip: "198.51.100.88",
      }),
      userRequest("POST", `/v1/me/delete-status#${operation.statusCapability}`, {
        token: operation.statusCapability,
        body: { operationId: operation.operationId },
        ip: "198.51.100.88",
      }),
      userRequest("POST", "/v1/me/delete-status", {
        token: operation.statusCapability,
        body: { operationId: operation.operationId, challenge: operation.challenge },
        ip: "198.51.100.88",
      }),
      userRequest("POST", "/v1/me/delete-status", {
        token: fakeSupabaseAccessToken(),
        body: { operationId: operation.operationId, statusCapability: operation.statusCapability },
        ip: "198.51.100.88",
      }),
      userRequest("POST", "/v1/me/delete-status", {
        token: fakeSupabaseAccessToken(),
        body: { operationId: operation.operationId },
        ip: "198.51.100.88",
      }),
    ];
    for (const request of requests) {
      const response = await h.handler(request);
      assertEquals(response.status, 404);
      assertStatusHeaders(response);
    }
    for (const suffix of [
      "/v1/me/delete-status/extra",
      "/evil/v1/me/delete-status",
      "/v1/me/delete-status/",
    ]) {
      assertEquals(
        (
          await h.handler(
            userRequest("POST", suffix, {
              token: operation.statusCapability,
              body: { operationId: operation.operationId },
              ip: "198.51.100.88",
            }),
          )
        ).status,
        401,
      );
    }
    assertEquals(h.calls, []);
  },
);

Deno.test(
  "W08 route: status has its own bounded IP and failure budgets, independent of ordinary Auth failures",
  async () => {
    h.reset();
    const operation = await requestedDeletion();
    for (let n = 0; n < 30; n++)
      await h.handler(userRequest("GET", "/v1/me", { token: "invalid", ip: "198.51.100.89" }));
    assertEquals((await deletionStatus(operation, "198.51.100.89")).status, 200);
    for (let n = 0; n < 10; n++) {
      assertEquals(
        (await deletionStatus({ ...operation, statusCapability: "invalid" }, "198.51.100.90"))
          .status,
        404,
      );
    }
    const failedBudget = await deletionStatus(operation, "198.51.100.90");
    assertEquals(failedBudget.status, 429);
    assertStatusHeaders(failedBudget);
    assert(Number(failedBudget.headers.get("Retry-After")) > 0);
    h.calls = [];
    for (let n = 0; n < 30; n++)
      assertEquals((await deletionStatus(operation, "198.51.100.91")).status, 200);
    const requestBudget = await deletionStatus(operation, "198.51.100.91");
    assertEquals(requestBudget.status, 429);
    assertStatusHeaders(requestBudget);
    assertEquals(h.calls.length, 30);
    assert(h.calls.every((call) => call.url.endsWith("/rpc/read_account_deletion_status")));
  },
);

Deno.test(
  "W08 route: status rejects oversized and malformed JSON before any RPC, with security headers",
  async () => {
    h.reset();
    const operation = await requestedDeletion();
    h.calls = [];
    for (const [body, status] of [
      ["x".repeat(1_025), 413],
      ["{bad-json", 404],
    ] as const) {
      const response = await h.handler(
        new Request("http://edge.test/v1/me/delete-status", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${operation.statusCapability}`,
            "x-forwarded-for": "198.51.100.92",
          },
          body,
        }),
      );
      assertEquals(response.status, status);
      assertStatusHeaders(response);
    }
    assertEquals(h.calls, []);
  },
);

Deno.test(
  "W08 route: concurrent confirms claim one worker; stale CAS cannot reach providers",
  async () => {
    h.reset();
    const owner = crypto.randomUUID();
    const operation = await requestedDeletion(owner);
    h.deletion.age(operation.operationId);
    let release!: () => void;
    let entered!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const providerEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    h.respond = async (call) => {
      if (!call.url.startsWith(RC_URL)) return null;
      entered();
      await providerGate;
      return new Response(null, { status: 200 });
    };
    const first = confirmDeletion(owner, operation);
    await Promise.race([
      providerEntered,
      first.then(() => {
        throw new Error("confirm returned before the provider gate");
      }),
    ]);
    try {
      const duplicate = await confirmDeletion(owner, operation);
      assertEquals(duplicate.status, 202);
      assertEquals(await duplicate.json(), {
        operationId: operation.operationId,
        state: "in_progress",
      });
      assertEquals(h.callsTo(RC_URL).length, 1);
      const replacement = await h.handler(
        userRequest("POST", "/v1/me/delete-request", {
          token: fakeSupabaseAccessToken(owner),
          body: {},
        }),
      );
      assertEquals(replacement.status, 409);
    } finally {
      release();
    }
    assertEquals((await first).status, 200);
    assertEquals(h.callsTo("/auth/v1/admin/users/").length, 1);
    h.reset();
    const nextOwner = crypto.randomUUID();
    const next = await requestedDeletion(nextOwner);
    h.deletion.age(next.operationId);
    h.rpcs.checkpoint_account_deletion_operation = { outcome: "stale_lease" };
    assertEquals((await confirmDeletion(nextOwner, next)).status, 503);
    assertEquals(h.callsTo(RC_URL).length, 0);
    assertEquals(h.callsTo("/auth/v1/admin/users/").length, 0);
  },
);

Deno.test(
  "W08 route: legacy challenge-only requests use the same leased cleanup and authoritative receipt",
  async () => {
    h.reset();
    const owner = crypto.randomUUID();
    const challenge = crypto.randomUUID();
    h.tables.account_deletion_requests = [
      {
        user_id: owner,
        challenge,
        created_at: new Date(Date.now() - 10_000).toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    ];
    const response = await h.handler(
      userRequest("POST", "/v1/me/delete-confirm", {
        token: fakeSupabaseAccessToken(owner),
        body: { challenge },
      }),
    );
    assertEquals(response.status, 200);
    const result = await response.json();
    assertEquals(result.deleted, true);
    assertEquals(typeof result.completionReceipt.completedAt, "string");
    assertEquals(
      (h.callsTo("/rpc/confirm_account_deletion_operation")[0].body as Record<string, unknown>)
        .p_operation_id,
      null,
    );
    assertEquals(h.callsTo("/rest/v1/account_deletion_requests").length, 0);
    assertEquals(h.callsTo("/rest/v1/account_external_credentials").length, 0);
  },
);

Deno.test(
  "W08 route: live-session check is repeated after body read; failed proof never claims deletion",
  async () => {
    h.reset();
    const owner = crypto.randomUUID();
    const operation = await requestedDeletion(owner);
    h.deletion.age(operation.operationId);
    let checks = 0;
    h.respond = (call) =>
      call.url.endsWith("/rpc/is_api_session_active") ? Response.json(++checks === 1) : null;
    assertEquals((await confirmDeletion(owner, operation)).status, 401);
    assertEquals(checks, 2);
    assertEquals(h.callsTo("/rpc/confirm_account_deletion_operation").length, 0);
    assertEquals(h.callsTo(RC_URL).length, 0);
  },
);

Deno.test(
  "W08 route: supplied operation and owner are strict; malformed binding never falls back to legacy",
  async () => {
    h.reset();
    const owner = crypto.randomUUID();
    const operation = await requestedDeletion(owner);
    h.deletion.age(operation.operationId);
    for (const operationId of [null, "", "invalid"]) {
      const response = await h.handler(
        userRequest("POST", "/v1/me/delete-confirm", {
          token: fakeSupabaseAccessToken(owner),
          body: { challenge: operation.challenge, operationId },
        }),
      );
      assertEquals(response.status, 400);
    }
    assertEquals(
      (await confirmDeletion(owner, { ...operation, operationId: crypto.randomUUID() })).status,
      403,
    );
    assertEquals((await confirmDeletion(OTHER_USER_ID, operation)).status, 403);
    assertEquals(h.callsTo(RC_URL).length, 0);
  },
);

Deno.test(
  "W08 route: a newer Apple credential is revoked; accepted cleanup fences further bootstrap writes",
  async () => {
    h.reset();
    const owner = crypto.randomUUID();
    h.tables.profiles = [{ ...profile(), id: owner }];
    h.tables.account_external_credentials = [
      {
        user_id: owner,
        apple_refresh_token_encrypted: await encryptAppleRefreshToken(
          "older-refresh",
          owner,
          h.appleTokenEncryptionKey,
        ),
      },
    ];
    const operation = await requestedDeletion(owner);
    h.deletion.age(operation.operationId);
    h.respond = (call) =>
      call.url.endsWith("appleid.apple.com/auth/token")
        ? Response.json({ refresh_token: "newer-refresh", id_token: fakeAppleIdToken(owner) })
        : null;
    const bootstrap = await h.handler(
      userRequest("POST", "/v1/account/bootstrap", {
        token: fakeAppleIdToken(owner),
        body: { appleAuthorizationCode: "fresh-code" },
      }),
    );
    assertEquals(bootstrap.status, 200);
    h.rpcs.set_account_deletion_auth_intent = { outcome: "stale_lease" };
    assertEquals((await confirmDeletion(owner, operation)).status, 503);
    const revoke = h.callsTo("appleid.apple.com/auth/revoke");
    assertEquals(revoke.length, 1);
    assertStringIncludes(String(revoke[0].body), "token=newer-refresh");
    const countBefore = h.callsTo("appleid.apple.com/auth/token").length;
    const blocked = await h.handler(
      userRequest("POST", "/v1/account/bootstrap", {
        token: fakeAppleIdToken(owner),
        body: { appleAuthorizationCode: "must-not-exchange" },
      }),
    );
    assertEquals(blocked.status, 409);
    assertEquals(h.callsTo("appleid.apple.com/auth/token").length, countBefore);
    assertEquals(h.callsTo("/rest/v1/account_external_credentials").length, 0);
  },
);

Deno.test(
  "W08 route: confirmation racing Apple exchange cannot overwrite the fenced credential",
  async () => {
    h.reset();
    const owner = crypto.randomUUID();
    h.tables.profiles = [{ ...profile(), id: owner }];
    const encrypted = await encryptAppleRefreshToken(
      "preserved-refresh",
      owner,
      h.appleTokenEncryptionKey,
    );
    h.tables.account_external_credentials = [
      { user_id: owner, apple_refresh_token_encrypted: encrypted },
    ];
    const operation = await requestedDeletion(owner);
    h.deletion.age(operation.operationId);
    h.respond = async (call) => {
      if (!call.url.endsWith("appleid.apple.com/auth/token")) return null;
      const row = h.deletion.operations.get(operation.operationId)!;
      await h.deletion.rpc("confirm_account_deletion_operation", {
        p_owner_id: owner,
        p_operation_id: row.id,
        p_challenge_hash: row.challengeHash,
      });
      return Response.json({
        refresh_token: "uncommitted-refresh",
        id_token: fakeAppleIdToken(owner),
      });
    };
    const response = await h.handler(
      userRequest("POST", "/v1/account/bootstrap", {
        token: fakeAppleIdToken(owner),
        body: { appleAuthorizationCode: "racing-code" },
      }),
    );
    assertEquals(response.status, 409);
    assertEquals(
      (h.tables.account_external_credentials[0] as Record<string, unknown>)
        .apple_refresh_token_encrypted,
      encrypted,
    );
    assertEquals(h.callsTo("/rpc/store_account_apple_credential").length, 1);
    assertEquals(h.callsTo("appleid.apple.com/auth/revoke").length, 1);
    assertStringIncludes(
      String(h.callsTo("appleid.apple.com/auth/revoke")[0].body),
      "token=uncommitted-refresh",
    );
    assertEquals(h.callsTo("/auth/v1/admin/users/").length, 0);
  },
);

Deno.test(
  "W08 route: ciphertext from a different owner fails closed without provider or Auth deletion",
  async () => {
    h.reset();
    const owner = crypto.randomUUID();
    h.tables.account_external_credentials = [
      {
        user_id: owner,
        apple_refresh_token_encrypted: await encryptAppleRefreshToken(
          "other-owner-refresh",
          OTHER_USER_ID,
          h.appleTokenEncryptionKey,
        ),
      },
    ];
    const operation = await requestedDeletion(owner);
    h.deletion.age(operation.operationId);
    assertEquals((await confirmDeletion(owner, operation)).status, 503);
    assertEquals(h.callsTo("appleid.apple.com/auth/revoke").length, 0);
    assertEquals(h.callsTo(RC_URL).length, 0);
    assertEquals(h.callsTo("/auth/v1/admin/users/").length, 0);
  },
);

Deno.test(
  "W08 route: malformed provider 404s never stand in for required external cleanup",
  async () => {
    for (const body of [
      null,
      {},
      { code: "7225" },
      { code: 7118 },
      { code: 7225, error: "route_not_found" },
      "<html>not found</html>",
    ]) {
      h.reset();
      const owner = crypto.randomUUID();
      const operation = await requestedDeletion(owner);
      h.deletion.age(operation.operationId);
      h.respond = (call) =>
        call.url.startsWith(RC_URL) ? Response.json(body, { status: 404 }) : null;
      assertEquals((await confirmDeletion(owner, operation)).status, 503);
      assertEquals(h.callsTo("/auth/v1/admin/users/").length, 0);
      assertEquals(h.deletion.operations.get(operation.operationId)!.revenueCatCompleted, false);
    }
    h.reset();
    const owner = crypto.randomUUID();
    const operation = await requestedDeletion(owner);
    h.deletion.age(operation.operationId);
    h.respond = (call) =>
      call.url.startsWith(RC_URL)
        ? Response.json({ code: 7225, message: "Subscriber does not exist." }, { status: 404 })
        : null;
    assertEquals((await confirmDeletion(owner, operation)).status, 200);
    assertEquals(h.callsTo("/auth/v1/admin/users/").length, 1);
  },
);

Deno.test(
  "W08 route: generic, conflicting and intended Auth absence still require exact code and trigger receipt",
  async () => {
    for (const [status, body, sealed, expected] of [
      [404, null, false, 503],
      [404, { code: "not_admin" }, false, 503],
      [404, { code: "route_not_found", error_code: "user_not_found" }, true, 503],
      [401, { code: "user_not_found" }, false, 503],
      [200, {}, false, 503],
      [404, { code: "user_not_found" }, false, 503],
      [404, { code: "user_not_found" }, true, 200],
      [404, { error_code: "user_not_found" }, true, 200],
    ] as const) {
      h.reset();
      const owner = crypto.randomUUID();
      const operation = await requestedDeletion(owner);
      h.deletion.age(operation.operationId);
      h.respond = (call) => {
        if (!call.url.includes("/auth/v1/admin/users/")) return null;
        if (sealed) h.deletion.observeAuthDeletion(owner);
        return Response.json(body, { status });
      };
      const response = await confirmDeletion(owner, operation);
      assertEquals(response.status, expected);
      if (expected === 200) assertEquals((await response.json()).deleted, true);
      else assert(!(await response.text()).includes('"deleted":true'));
    }
  },
);

Deno.test(
  "W08 route: provider and Auth retries reuse committed checkpoints without skipping failed cleanup",
  async () => {
    h.reset();
    const owner = crypto.randomUUID();
    h.tables.account_external_credentials = [
      {
        user_id: owner,
        apple_refresh_token_encrypted: await encryptAppleRefreshToken(
          "retry-refresh",
          owner,
          h.appleTokenEncryptionKey,
        ),
      },
    ];
    const operation = await requestedDeletion(owner);
    h.deletion.age(operation.operationId);
    let revenueCatAttempts = 0;
    let authAttempts = 0;
    h.respond = (call) => {
      if (call.url.startsWith(RC_URL) && ++revenueCatAttempts === 1)
        return Response.json({}, { status: 503 });
      if (call.url.includes("/auth/v1/admin/users/") && ++authAttempts === 1)
        return Response.json({}, { status: 503 });
      return null;
    };
    assertEquals((await confirmDeletion(owner, operation)).status, 503);
    assertEquals(h.callsTo("/auth/v1/admin/users/").length, 0);
    assertEquals(
      (await (await deletionStatus(operation, "198.51.100.94")).json()).state,
      "in_progress",
    );
    assertEquals((await confirmDeletion(owner, operation)).status, 503);
    assertEquals((await confirmDeletion(owner, operation)).status, 200);
    assertEquals(h.callsTo("appleid.apple.com/auth/revoke").length, 1);
    assertEquals(h.callsTo(RC_URL).length, 2);
    assertEquals(h.callsTo("/auth/v1/admin/users/").length, 2);
    assertEquals(h.callsTo("/rest/v1/account_external_credentials").length, 0);
  },
);

Deno.test(
  "W08 route: first-confirm age and expiry stay strict, and a capability is never a challenge",
  async () => {
    h.reset();
    const owner = crypto.randomUUID();
    const operation = await requestedDeletion(owner);
    assertEquals((await confirmDeletion(owner, operation)).status, 429);
    assertEquals(
      (await confirmDeletion(owner, { ...operation, challenge: operation.statusCapability }))
        .status,
      400,
    );
    h.deletion.age(operation.operationId, 900_001);
    assertEquals((await confirmDeletion(owner, operation)).status, 403);
    assertEquals(h.callsTo(RC_URL).length, 0);
    assertEquals(h.callsTo("/auth/v1/admin/users/").length, 0);
  },
);

Deno.test(
  "W08 route: pending, malformed RPC data and storage errors never become deleted",
  async () => {
    for (const receipt of [
      null,
      [],
      {},
      { state: "pending", completionReceipt: null, appleAuthorizationRevocation: null },
    ]) {
      h.reset();
      const owner = crypto.randomUUID();
      const operation = await requestedDeletion(owner);
      h.deletion.age(operation.operationId);
      h.rpcs.read_account_deletion_receipt = receipt;
      assertEquals((await confirmDeletion(owner, operation)).status, 503);
    }
    h.reset();
    const operation = await requestedDeletion();
    h.rpcErrors.read_account_deletion_status = 503;
    const { result, logs } = await captureConsole(() => deletionStatus(operation, "198.51.100.93"));
    assertEquals(result.status, 503);
    assertStatusHeaders(result);
    assertEquals(logs, []);
    assertEquals(await result.json(), { error: { code: "account.deletion_status_unavailable" } });
  },
);

Deno.test("W08 route: malformed IP headers share a bounded unknown-IP status budget", async () => {
  h.reset();
  const operation = await requestedDeletion();
  h.calls = [];
  for (let n = 0; n < 10; n++) {
    const response = await deletionStatus(
      { ...operation, statusCapability: "invalid" },
      `not-an-ip-${n}`,
    );
    assertEquals(response.status, 404);
  }
  assertEquals((await deletionStatus(operation, "another-malformed-ip")).status, 429);
  assertEquals(h.calls, []);
});

Deno.test(
  "W08 route: empty successful provider responses still require all checkpoints and the Auth receipt",
  async () => {
    h.reset();
    const owner = crypto.randomUUID();
    h.tables.account_external_credentials = [
      {
        user_id: owner,
        apple_refresh_token_encrypted: await encryptAppleRefreshToken(
          "empty-response-refresh",
          owner,
          h.appleTokenEncryptionKey,
        ),
      },
    ];
    const operation = await requestedDeletion(owner);
    h.deletion.age(operation.operationId);
    h.respond = (call) =>
      call.url.startsWith(RC_URL) || call.url.includes("appleid.apple.com/auth/revoke")
        ? new Response(null, { status: 204 })
        : null;
    const response = await confirmDeletion(owner, operation);
    assertEquals(response.status, 200);
    assertEquals(typeof (await response.json()).completionReceipt.completedAt, "string");
    assertEquals(h.callsTo("appleid.apple.com/auth/revoke").length, 1);
    assertEquals(h.callsTo(RC_URL).length, 1);
    assertEquals(h.callsTo("/rpc/set_account_deletion_auth_intent").length, 1);
    assertEquals(h.callsTo("/rpc/read_account_deletion_receipt").length, 1);
  },
);

const PRIVATE_FAILURE =
  "FAKE-provider-refresh-token FAKE-person@example.test https://FAKE-private.test/clip?credential=FAKE-token";

function assertPrivateLogsAbsent(output: string, userId: string): void {
  assert(!output.includes("FAKE-"), "failure logs must exclude upstream and personal material");
  assert(!output.includes(userId), "failure logs must not identify an account");
}

Deno.test(
  "failure logs: Apple grant failures retain invalid-grant vs retryable classification",
  async () => {
    for (const [code, status, expected] of [
      ["invalid_grant", 400, 401],
      [PRIVATE_FAILURE, 429, 503],
    ] as const) {
      h.reset();
      const userId = crypto.randomUUID();
      h.tables.profiles = [{ ...profile(), id: userId }];
      h.respond = (call) =>
        call.url.includes("appleid.apple.com/auth/token")
          ? Response.json({ error: code, error_description: PRIVATE_FAILURE }, { status })
          : null;
      const { result, logs, output } = await captureConsole(() =>
        h.handler(
          userRequest("POST", "/v1/account/bootstrap", {
            token: fakeAppleIdToken(userId),
            body: { appleAuthorizationCode: PRIVATE_FAILURE },
          }),
        ),
      );
      assertEquals(result.status, expected);
      const body = await result.text();
      assert(!body.includes("FAKE-"));
      assertPrivateLogsAbsent(output, userId);
      assertEquals(logs.length, expected === 401 ? 0 : 1);
      if (logs.length) {
        assertEquals(logs[0].args[0], "[api] Apple sign-in:");
        assertEquals((logs[0].args[1] as Record<string, unknown>).status, status);
      }
      assertEquals(h.callsTo("/rest/v1/account_external_credentials").length, 0);
    }
  },
);

Deno.test(
  "failure logs: external erasure failures never claim account deletion or print provider details",
  async () => {
    for (const provider of ["apple", "revenuecat"]) {
      h.reset();
      const userId = crypto.randomUUID();
      const challenge = crypto.randomUUID();
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
            PRIVATE_FAILURE,
            userId,
            h.appleTokenEncryptionKey,
          ),
          apple_revoked_at: null,
          revenuecat_deleted_at: null,
        },
      ];
      h.respond = (call) =>
        (
          provider === "apple"
            ? call.url.includes("appleid.apple.com/auth/revoke")
            : call.url.startsWith(RC_URL)
        )
          ? Response.json(
              { error: PRIVATE_FAILURE, error_description: PRIVATE_FAILURE },
              { status: 502 },
            )
          : null;
      const { result, logs, output } = await captureConsole(() =>
        h.handler(
          userRequest("POST", "/v1/me/delete-confirm", {
            token: fakeAppleIdToken(userId),
            body: { challenge },
          }),
        ),
      );
      assertEquals(result.status, 503);
      assertEquals(await result.json(), {
        error: { message: "Account deletion is temporarily unavailable. Please try again." },
      });
      assertPrivateLogsAbsent(output, userId);
      assertEquals(logs.length, 1);
      assertEquals(logs[0].args[0], "[api] Account deletion:");
      assertEquals((logs[0].args[1] as Record<string, unknown>).status, 502);
      assert(!output.includes("account deleted"));
      assertEquals(h.callsTo("/auth/v1/admin/users/").length, 0);
      if (provider === "apple") assertEquals(h.callsTo(RC_URL).length, 0);
    }
  },
);

Deno.test(
  "failure logs: survey warnings omit personal text without changing best-effort writes",
  async () => {
    for (const stage of ["unknown_reason", "state", "profile", "insert"]) {
      h.reset();
      h.rpcs.access_state = [{ premium: false, scored_count: 0 }];
      h.tables.profiles = [{ created_at: "2026-09-01T10:00:00.000Z" }];
      const userId = crypto.randomUUID();
      const survey = {
        reason: stage === "unknown_reason" ? PRIVATE_FAILURE : "other",
        details: PRIVATE_FAILURE,
      };
      h.respond = (call) =>
        (stage === "state" && call.url.includes("/rpc/access_state")) ||
        (stage === "profile" && call.url.includes("/rest/v1/profiles")) ||
        (stage === "insert" && call.url.includes("/rest/v1/account_deletion_feedback"))
          ? Response.json(
              { code: "23514", message: PRIVATE_FAILURE, details: PRIVATE_FAILURE },
              { status: 400 },
            )
          : null;
      const { result, logs, output } = await captureConsole(() =>
        h.handler(
          userRequest("POST", "/v1/me/delete-request", {
            token: fakeGoogleIdToken(userId),
            body: { survey },
          }),
        ),
      );
      assertEquals(result.status, 200);
      assertEquals(typeof (await result.json()).challenge, "string");
      assertPrivateLogsAbsent(output, userId);
      assertEquals(logs.length, 1);
      assertEquals(logs[0].level, stage === "insert" ? "error" : "warn");
      const writes = h.callsTo("/rest/v1/account_deletion_feedback");
      if (stage === "unknown_reason") {
        assertEquals(logs[0].args, ["[api] delete-request: exit survey ignored (unknown reason)"]);
        assertEquals(writes.length, 0);
      } else {
        assertEquals((writes[0].body as Record<string, unknown>).details, PRIVATE_FAILURE);
        assertEquals(logs[0].args[1], { name: "unknown", code: "23514", status: 400 });
        assertEquals(
          logs[0].args[0],
          stage === "insert"
            ? "[api] delete-request: exit survey not recorded:"
            : "[api] delete-request: survey context partial:",
        );
      }
    }
  },
);
