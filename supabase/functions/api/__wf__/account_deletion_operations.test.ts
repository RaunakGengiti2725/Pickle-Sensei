import { assert, assertEquals, assertNotEquals, assertRejects } from "jsr:@std/assert@1";
import {
  ACCOUNT_DELETION_POLICY_DRAFT,
  AccountDeletionStatusBudget,
  isIntendedRevenueCatCustomerNotFound,
  readAccountDeletionResponseBody,
  accountDeletionAllowsAppleBootstrap,
  accountDeletionStatusResponse,
  beginAccountDeletionOperation,
  confirmAccountDeletionOperation,
  deletionChallengeHash,
  deletionStatusCapabilityHash,
  isIntendedAuthUserNotFound,
  parseDeletionOperationStatus,
  resumeConfirmedAccountDeletionOperation,
  storeAccountAppleCredential,
  type AccountDeletionConfirmDependencies,
  type DeletionOperationRpc,
} from "../accountDeletionOperations.ts";

const OWNER = "08080000-0000-4000-8000-000000000001";
const OTHER = "08080000-0000-4000-8000-000000000002";
const OPERATION = "08080000-0000-4000-8000-000000001001";
const CHALLENGE = "08080000-0000-4000-8000-000000002001";
const LEASE = "08080000-0000-4000-8000-000000003001";
const CAPABILITY = "A".repeat(43);
const CIPHERTEXT = "v1.abcdefghijklmnop.ciphertextOnlyForInjectedTests";
const COMPLETED_AT = "2026-09-07T00:00:00.000Z";
const completed = {
  state: "completed",
  completionReceipt: { completedAt: COMPLETED_AT },
  appleAuthorizationRevocation: "revoked",
};
const pending = {
  state: "pending",
  completionReceipt: null,
  appleAuthorizationRevocation: null,
};

function fixture() {
  const calls: Array<{ name: string; parameters: Record<string, unknown> }> = [];
  const results = new Map<string, unknown>();
  const errors = new Map<string, unknown>();
  results.set("confirm_account_deletion_operation", {
    outcome: "claimed",
    operationId: OPERATION,
    leaseToken: LEASE,
    leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    confirmedAt: new Date(Date.now() - 1_000).toISOString(),
    appleAction: "revoke",
    appleRefreshTokenEncrypted: CIPHERTEXT,
    appleCompleted: false,
    revenueCatCompleted: false,
    revenueCatAlreadyDeleted: false,
  });
  results.set("checkpoint_account_deletion_operation", { outcome: "checkpointed" });
  results.set("set_account_deletion_auth_intent", { outcome: "intent_recorded" });
  results.set("read_account_deletion_receipt", completed);
  results.set("read_account_deletion_status", pending);
  results.set("fail_account_deletion_operation", { outcome: "released" });
  results.set("account_deletion_allows_apple_bootstrap", true);
  results.set("store_account_apple_credential", { outcome: "stored" });
  const rpc: DeletionOperationRpc = async (name, parameters) => {
    calls.push({ name, parameters });
    if (errors.has(name)) return { data: null, error: errors.get(name) };
    if (name === "begin_account_deletion_operation" && !results.has(name)) {
      return {
        data: {
          outcome: "requested",
          operationId: parameters.p_operation_id,
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          statusExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
      };
    }
    return { data: results.get(name) ?? null };
  };
  const providerCall = async (name: string, parameters: Record<string, unknown>) => {
    calls.push({ name, parameters });
    if (errors.has(name)) throw errors.get(name);
  };
  const dependencies: AccountDeletionConfirmDependencies = {
    verifyLiveSession: async (ownerId) => {
      await providerCall("live_session", { ownerId });
      return results.get("live_session") !== false;
    },
    revokeAppleCredential: (encryptedToken, ownerId) =>
      providerCall("apple", { encryptedToken, ownerId }),
    deleteRevenueCatCustomer: (ownerId) => providerCall("revenuecat", { ownerId }),
    deleteAuthUser: async (ownerId) => {
      await providerCall("auth_delete", { ownerId });
      return { error: results.get("auth_error") };
    },
    readOwnerNamespacePage: () => Promise.resolve({ data: [], error: null }),
  };
  const confirm = (body: unknown = { challenge: CHALLENGE, operationId: OPERATION }) =>
    confirmAccountDeletionOperation(rpc, dependencies, OWNER, body);
  const claimPatch = (patch: Record<string, unknown>) => {
    results.set("confirm_account_deletion_operation", {
      ...(results.get("confirm_account_deletion_operation") as Record<string, unknown>),
      ...patch,
    });
  };
  return { calls, results, errors, rpc, dependencies, confirm, claimPatch };
}

function statusRequest(capability = CAPABILITY, url = "https://local.test/v1/me/delete-status") {
  return new Request(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${capability}` },
  });
}

Deno.test(
  "deletion request preserves legacy fields and mints 32 random capability bytes once",
  async () => {
    const h = fixture();
    const first = await beginAccountDeletionOperation(h.rpc, OWNER);
    const second = await beginAccountDeletionOperation(h.rpc, OWNER);
    assert(first.outcome === "requested" && second.outcome === "requested");
    assertEquals(first.statusCapability.length, 43);
    assertEquals(
      atob(first.statusCapability.replace(/-/g, "+").replace(/_/g, "/") + "=").length,
      32,
    );
    assertNotEquals(first.statusCapability, second.statusCapability);
    assertNotEquals(first.challenge, second.challenge);
    assertNotEquals(first.operationId, second.operationId);
    assertEquals(
      h.calls.map((call) => call.name),
      ["begin_account_deletion_operation", "begin_account_deletion_operation"],
    );
    assertEquals(
      h.calls[0].parameters.p_challenge_hash,
      await deletionChallengeHash(OWNER, first.challenge),
    );
    assertEquals(
      h.calls[0].parameters.p_status_capability_hash,
      await deletionStatusCapabilityHash(first.operationId, first.statusCapability),
    );
    const sent = JSON.stringify(h.calls);
    assert(!sent.includes(first.challenge));
    assert(!sent.includes(first.statusCapability));
    assertEquals(Object.keys(first).sort(), [
      "challenge",
      "expiresAt",
      "operationId",
      "outcome",
      "statusCapability",
      "statusExpiresAt",
    ]);
  },
);

Deno.test("lost deletion request response never confirms or invokes providers", async () => {
  const h = fixture();
  h.errors.set("begin_account_deletion_operation", { message: "lost request reply" });
  assertEquals(await beginAccountDeletionOperation(h.rpc, OWNER), { outcome: "unavailable" });
  h.errors.clear();
  assertEquals((await beginAccountDeletionOperation(h.rpc, OWNER)).outcome, "requested");
  assert(h.calls.every((call) => call.name === "begin_account_deletion_operation"));
});

Deno.test("a new request cannot turn an accepted confirmation into replacement work", async () => {
  const h = fixture();
  h.results.set("begin_account_deletion_operation", { outcome: "confirmation_in_progress" });
  assertEquals(await beginAccountDeletionOperation(h.rpc, OWNER), {
    outcome: "confirmation_in_progress",
  });
  assertEquals(h.calls.length, 1);
});

Deno.test(
  "deletion hashes bind challenge to owner and status capability to operation and domain",
  async () => {
    const challenge = await deletionChallengeHash(OWNER, CHALLENGE);
    assertEquals(
      challenge,
      await deletionChallengeHash(OWNER.toUpperCase(), CHALLENGE.toUpperCase()),
    );
    assertNotEquals(challenge, await deletionChallengeHash(OTHER, CHALLENGE));
    const status = await deletionStatusCapabilityHash(OPERATION, CAPABILITY);
    assertNotEquals(status, await deletionStatusCapabilityHash(OTHER, CAPABILITY));
    assertNotEquals(status, challenge);
    assert(/^\\x[0-9a-f]{64}$/.test(status));
    await assertRejects(() => deletionStatusCapabilityHash(OPERATION, "B".repeat(43)));
    await assertRejects(() => deletionStatusCapabilityHash("invalid", CAPABILITY));
    await assertRejects(() => deletionChallengeHash(OWNER, "invalid"));
    await assertRejects(() => deletionChallengeHash("invalid", CHALLENGE));
  },
);

Deno.test(
  "live-session verification precedes confirmation and all deletion side effects",
  async () => {
    const h = fixture();
    h.results.set("live_session", false);
    assertEquals(await h.confirm(), { outcome: "rejected", code: "session_invalid" });
    assertEquals(
      h.calls.map((call) => call.name),
      ["live_session"],
    );
    h.errors.set("live_session", new Error("network failure"));
    assertEquals(await h.confirm(), { outcome: "unavailable", code: "session_unavailable" });
    assert(h.calls.every((call) => call.name === "live_session"));
  },
);

Deno.test("legacy challenge-only confirmation resolves through the owner hash", async () => {
  const h = fixture();
  const result = await h.confirm({ challenge: CHALLENGE });
  assertEquals(result.outcome, "completed");
  assertEquals(h.calls[1], {
    name: "confirm_account_deletion_operation",
    parameters: {
      p_owner_id: OWNER,
      p_operation_id: null,
      p_challenge_hash: await deletionChallengeHash(OWNER, CHALLENGE),
    },
  });
  assert(!JSON.stringify(h.calls).includes(CHALLENGE));
});

Deno.test("wrong supplied operation ID never falls back to legacy confirmation", async () => {
  const h = fixture();
  h.results.set("confirm_account_deletion_operation", { outcome: "invalid" });
  assertEquals(await h.confirm({ challenge: CHALLENGE, operationId: OTHER }), {
    outcome: "rejected",
    code: "invalid",
  });
  assertEquals(h.calls.length, 2);
  assertEquals(h.calls[1].parameters.p_operation_id, OTHER);
  for (const operationId of [null, undefined, "", 1, "not-a-uuid"]) {
    assertEquals(await h.confirm({ challenge: CHALLENGE, operationId }), {
      outcome: "rejected",
      code: "invalid",
    });
  }
  assertEquals(h.calls.length, 2);
});

for (const outcome of ["invalid", "expired", "too_fast", "blocked"] as const) {
  Deno.test(
    `database ${outcome} confirmation verdict never reaches external deletion`,
    async () => {
      const h = fixture();
      h.results.set("confirm_account_deletion_operation", { outcome });
      assertEquals(await h.confirm(), { outcome: "rejected", code: outcome });
      assertEquals(
        h.calls.map((call) => call.name),
        ["live_session", "confirm_account_deletion_operation"],
      );
    },
  );
}

Deno.test("duplicate confirm with an active lease cannot start a second worker", async () => {
  const h = fixture();
  h.results.set("confirm_account_deletion_operation", { outcome: "busy", operationId: OPERATION });
  assertEquals(await h.confirm(), { outcome: "in_progress", operationId: OPERATION });
  assertEquals(h.calls.length, 2);
});

Deno.test(
  "cleanup orders Apple and RevenueCat checkpoints before Auth intent and receipt",
  async () => {
    const h = fixture();
    assertEquals(await h.confirm(), {
      outcome: "completed",
      operationId: OPERATION,
      deleted: true,
      completionReceipt: { completedAt: COMPLETED_AT },
      appleAuthorizationRevocation: "revoked",
    });
    assertEquals(
      h.calls.map((call) => call.parameters.p_checkpoint ?? call.name),
      [
        "live_session",
        "confirm_account_deletion_operation",
        "lease_check",
        "apple",
        "apple",
        "lease_check",
        "revenuecat",
        "revenuecat",
        "external_complete",
        "set_account_deletion_auth_intent",
        "auth_delete",
        "read_account_deletion_receipt",
      ],
    );
    const apple = h.calls.find((call) => call.name === "apple");
    assertEquals(apple?.parameters, { encryptedToken: CIPHERTEXT, ownerId: OWNER });
    for (const call of h.calls.filter(
      (call) => call.name === "checkpoint_account_deletion_operation",
    )) {
      assertEquals(call.parameters.p_owner_id, OWNER);
      assertEquals(call.parameters.p_operation_id, OPERATION);
      assertEquals(call.parameters.p_lease_token, LEASE);
    }
  },
);

Deno.test(
  "legacy Apple manual disconnect is preserved without requiring another device",
  async () => {
    const h = fixture();
    h.claimPatch({ appleAction: "manual_action_required", appleRefreshTokenEncrypted: null });
    h.results.set("read_account_deletion_receipt", {
      ...completed,
      appleAuthorizationRevocation: "manual_action_required",
    });
    const result = await h.confirm();
    assert(result.outcome === "completed");
    assertEquals(result.appleAuthorizationRevocation, "manual_action_required");
    assert(!h.calls.some((call) => call.name === "apple"));
    assert(h.calls.some((call) => call.name === "revenuecat"));
    assert(h.calls.some((call) => call.name === "auth_delete"));
  },
);

Deno.test("existing provider and durable operation checkpoints are reused on retry", async () => {
  const h = fixture();
  h.claimPatch({
    appleAction: "revoked",
    appleRefreshTokenEncrypted: null,
    revenueCatAlreadyDeleted: true,
  });
  assertEquals((await h.confirm()).outcome, "completed");
  assert(!h.calls.some((call) => call.name === "apple" || call.name === "revenuecat"));
  assert(h.calls.some((call) => call.parameters.p_checkpoint === "revenuecat"));
  h.calls.length = 0;
  h.claimPatch({ appleCompleted: true, revenueCatCompleted: true });
  assertEquals((await h.confirm()).outcome, "completed");
  assert(
    !h.calls.some((call) => ["apple", "revenuecat"].includes(String(call.parameters.p_checkpoint))),
  );
});

for (const [provider, code] of [
  ["apple", "apple_cleanup_unavailable"],
  ["revenuecat", "revenuecat_cleanup_unavailable"],
] as const) {
  Deno.test(
    `${provider} failure cannot reach Auth and stores only an allowlisted error code`,
    async () => {
      const h = fixture();
      h.errors.set(provider, new Error(`secret ${CAPABILITY} email@example.com ${CIPHERTEXT}`));
      assertEquals(await h.confirm(), { outcome: "unavailable", code });
      assert(!h.calls.some((call) => call.name === "auth_delete"));
      assertEquals(h.calls.at(-1)?.parameters.p_error_code, code);
      assert(!JSON.stringify(h.calls).includes(CAPABILITY));
      assert(!JSON.stringify(h.calls).includes("email@example.com"));
    },
  );
}

Deno.test(
  "a stale worker lease cannot checkpoint, begin a provider call, or write Auth intent",
  async () => {
    const h = fixture();
    h.results.set("checkpoint_account_deletion_operation", { outcome: "stale_lease" });
    assertEquals(await h.confirm(), { outcome: "unavailable", code: "checkpoint_unavailable" });
    assert(
      !h.calls.some((call) =>
        ["apple", "revenuecat", "auth_delete", "set_account_deletion_auth_intent"].includes(
          call.name,
        ),
      ),
    );
  },
);

Deno.test("failure to durably record Auth intent prevents the destructive Auth call", async () => {
  const h = fixture();
  h.errors.set("set_account_deletion_auth_intent", { code: "55000" });
  assertEquals(await h.confirm(), { outcome: "unavailable", code: "checkpoint_unavailable" });
  assert(!h.calls.some((call) => call.name === "auth_delete"));
});

Deno.test(
  "only intended Auth user_not_found evidence qualifies, never generic status or FK errors",
  () => {
    assert(isIntendedAuthUserNotFound({ status: 404, code: "user_not_found" }));
    assert(isIntendedAuthUserNotFound({ status: 404, error_code: "user_not_found" }));
    for (const error of [
      null,
      {},
      { status: 404 },
      { status: 401 },
      { status: 403 },
      { code: "23503" },
      { status: 404, message: "user_not_found" },
      { status: 401, code: "user_not_found" },
      { status: 500, code: "user_not_found" },
      { code: "user_not_found" },
      { status: 404, code: "route_not_found", error_code: "user_not_found" },
    ]) {
      assertEquals(isIntendedAuthUserNotFound(error), false);
    }
  },
);

for (const error of [{ status: 404 }, { status: 401 }, { code: "23503" }]) {
  Deno.test(`Auth ${JSON.stringify(error)} cannot mint or infer a completion receipt`, async () => {
    const h = fixture();
    h.results.set("auth_error", error);
    assertEquals(await h.confirm(), { outcome: "unavailable", code: "auth_delete_unavailable" });
    assert(!h.calls.some((call) => call.name === "read_account_deletion_receipt"));
  });
}

Deno.test(
  "even successful or intended-absent Auth responses require the durable trigger receipt",
  async () => {
    for (const error of [undefined, { status: 404, code: "user_not_found" }]) {
      const h = fixture();
      h.results.set("auth_error", error);
      h.results.set("read_account_deletion_receipt", pending);
      assertEquals(await h.confirm(), { outcome: "unavailable", code: "completion_unverified" });
      h.results.set("read_account_deletion_receipt", completed);
      assertEquals((await h.confirm()).outcome, "completed");
    }
  },
);

Deno.test(
  "a lost final Auth response is recovered by status without sessions or any resumed deletion",
  async () => {
    const h = fixture();
    h.dependencies.deleteAuthUser = async () => {
      h.results.set("read_account_deletion_status", completed);
      throw new Error("response lost after transaction commit");
    };
    assertEquals(await h.confirm(), { outcome: "unavailable", code: "auth_delete_unavailable" });
    h.calls.length = 0;
    h.results.set("live_session", false);
    const response = await accountDeletionStatusResponse(h.rpc, statusRequest(), {
      operationId: OPERATION,
    });
    assertEquals(response.status, 200);
    assertEquals(await response.json(), completed);
    assertEquals(
      h.calls.map((call) => call.name),
      ["read_account_deletion_status"],
    );
  },
);

Deno.test(
  "status is a minimal allowlisted no-store view and never passes the capability to RPC",
  async () => {
    const h = fixture();
    h.results.set("read_account_deletion_status", {
      ...completed,
      owner_id: OWNER,
      email: "never-return@example.com",
      profile: { name: "Private" },
      provider_id: "apple-subject",
      survey: { reason: "private" },
      challenge: CHALLENGE,
      credentials: CIPHERTEXT,
      statusCapability: CAPABILITY,
      completionReceipt: { ...completed.completionReceipt, ownerId: OWNER },
    });
    const response = await accountDeletionStatusResponse(h.rpc, statusRequest(), {
      operationId: OPERATION,
    });
    assertEquals(response.status, 200);
    assertEquals(await response.json(), completed);
    assertEquals(response.headers.get("Cache-Control"), "no-store");
    assertEquals(response.headers.get("Referrer-Policy"), "no-referrer");
    assertEquals(response.headers.get("Vary"), "Authorization");
    assertEquals(h.calls, [
      {
        name: "read_account_deletion_status",
        parameters: {
          p_operation_id: OPERATION,
          p_status_capability_hash: await deletionStatusCapabilityHash(OPERATION, CAPABILITY),
        },
      },
    ]);
    assert(!JSON.stringify(h.calls).includes(CAPABILITY));
  },
);

Deno.test(
  "unknown, expired, and invalid status capabilities are indistinguishable and read-only",
  async () => {
    const h = fixture();
    h.results.set("read_account_deletion_status", null);
    const unknown = await accountDeletionStatusResponse(h.rpc, statusRequest(), {
      operationId: OPERATION,
    });
    const expired = await accountDeletionStatusResponse(h.rpc, statusRequest("Q".repeat(43)), {
      operationId: OPERATION,
    });
    const malformed = await accountDeletionStatusResponse(h.rpc, statusRequest("invalid"), {
      operationId: OPERATION,
    });
    assertEquals(unknown.status, 404);
    assertEquals(expired.status, 404);
    assertEquals(malformed.status, 404);
    assertEquals(await unknown.text(), await expired.text());
    assertEquals(await malformed.json(), {
      error: { code: "account.deletion_status_unavailable" },
    });
    assert(h.calls.every((call) => call.name === "read_account_deletion_status"));
  },
);

Deno.test(
  "status refuses URL, body, or ordinary access-token credentials and cannot confirm",
  async () => {
    const h = fixture();
    const requests: Array<[Request, unknown]> = [
      [statusRequest("jwt.header.signature"), { operationId: OPERATION }],
      [
        statusRequest(
          CAPABILITY,
          `https://local.test/v1/me/delete-status?capability=${CAPABILITY}`,
        ),
        { operationId: OPERATION },
      ],
      [
        new Request("https://local.test/v1/me/delete-status", { method: "POST" }),
        { operationId: OPERATION, capability: CAPABILITY },
      ],
      [statusRequest(), { operationId: OPERATION, challenge: CHALLENGE }],
      [statusRequest(), { operationId: OWNER, statusCapability: CAPABILITY }],
      [
        new Request("https://local.test/v1/me/delete-status", {
          headers: { Authorization: `Bearer ${CAPABILITY}` },
        }),
        { operationId: OPERATION },
      ],
    ];
    for (const [request, body] of requests) {
      assertEquals((await accountDeletionStatusResponse(h.rpc, request, body)).status, 404);
    }
    assertEquals(h.calls.length, 0);
    assertEquals(await h.confirm({ challenge: CAPABILITY, operationId: OPERATION }), {
      outcome: "rejected",
      code: "invalid",
    });
    assertEquals(h.calls.length, 0);
  },
);

Deno.test("status rejects inconsistent completion and sanitizes backend failures", async () => {
  const h = fixture();
  for (const data of [
    { ...pending, state: "completed" },
    { ...completed, state: "pending" },
    { ...completed, completionReceipt: { completedAt: "unverified" } },
    { ...completed, appleAuthorizationRevocation: "provider-secret" },
  ]) {
    h.results.set("read_account_deletion_status", data);
    const response = await accountDeletionStatusResponse(h.rpc, statusRequest(), {
      operationId: OPERATION,
    });
    assertEquals(response.status, 503);
    assertEquals(await response.json(), { error: { code: "account.deletion_status_unavailable" } });
  }
  h.errors.set("read_account_deletion_status", { message: `secret ${CAPABILITY}` });
  const response = await accountDeletionStatusResponse(h.rpc, statusRequest(), {
    operationId: OPERATION,
  });
  assertEquals(response.status, 503);
  assert(!(await response.text()).includes(CAPABILITY));
  assertEquals(parseDeletionOperationStatus(null), null);
});

Deno.test(
  "internal recovery claims only previously confirmed work and never accepts a capability",
  async () => {
    const h = fixture();
    h.results.set("claim_account_deletion_work", { outcome: "invalid" });
    assertEquals(
      await resumeConfirmedAccountDeletionOperation(h.rpc, h.dependencies, OWNER, OPERATION),
      {
        outcome: "rejected",
        code: "invalid",
      },
    );
    assertEquals(h.calls, [
      {
        name: "claim_account_deletion_work",
        parameters: { p_owner_id: OWNER, p_operation_id: OPERATION },
      },
    ]);
    h.calls.length = 0;
    h.results.set("claim_account_deletion_work", {
      outcome: "completed",
      operationId: OPERATION,
      status: completed,
    });
    assertEquals(
      (await resumeConfirmedAccountDeletionOperation(h.rpc, h.dependencies, OWNER, OPERATION))
        .outcome,
      "completed",
    );
    assertEquals(h.calls.length, 1);
  },
);

Deno.test(
  "Apple bootstrap uses preflight plus atomic credential-store fencing, without resetting checkpoints",
  async () => {
    const h = fixture();
    assertEquals(await accountDeletionAllowsAppleBootstrap(h.rpc, OWNER), true);
    h.results.set("account_deletion_allows_apple_bootstrap", false);
    assertEquals(await accountDeletionAllowsAppleBootstrap(h.rpc, OWNER), false);
    assertEquals(await storeAccountAppleCredential(h.rpc, OWNER, CIPHERTEXT), "stored");
    h.results.set("store_account_apple_credential", { outcome: "confirmation_in_progress" });
    assertEquals(
      await storeAccountAppleCredential(h.rpc, OWNER, CIPHERTEXT),
      "confirmation_in_progress",
    );
    assertEquals(h.calls.at(-1), {
      name: "store_account_apple_credential",
      parameters: { p_owner_id: OWNER, p_encrypted_token: CIPHERTEXT },
    });
    assert(!h.calls.some((call) => Object.hasOwn(call.parameters, "apple_revoked_at")));
  },
);

Deno.test(
  "status IP storage is bounded and fails closed until expired slots can be reclaimed",
  () => {
    let now = 1_000;
    const budget = new AccountDeletionStatusBudget(() => now);
    for (let n = 0; n < 2_048; n++) assertEquals(budget.admit(`fixture-ip-${n}`), null);
    assertEquals(budget.admit("overflow-ip")?.status, 429);
    assertEquals(budget.admit("fixture-ip-0"), null);
    now += 300_001;
    assertEquals(budget.admit("overflow-ip"), null);
  },
);

Deno.test(
  "status request and failure counters saturate separately and reset on their own deadlines",
  () => {
    let now = 1_000;
    const budget = new AccountDeletionStatusBudget(() => now);
    for (let n = 0; n < 30; n++) assertEquals(budget.admit("same-ip"), null);
    const limited = budget.admit("same-ip")!;
    assertEquals(limited.status, 429);
    assertEquals(limited.headers.get("Retry-After"), "60");
    assertEquals(limited.headers.get("Cache-Control"), "no-store");
    assertEquals(limited.headers.get("Referrer-Policy"), "no-referrer");
    now += 60_001;
    for (let n = 0; n < 10; n++) {
      assertEquals(budget.admit("same-ip"), null);
      budget.recordFailure("same-ip");
    }
    assertEquals(budget.admit("same-ip")?.status, 429);
    assertEquals(budget.admit("other-ip"), null);
    now += 240_000;
    assertEquals(budget.admit("same-ip"), null);
  },
);

Deno.test(
  "only the precise RevenueCat customer-absence payload qualifies for an idempotent cleanup",
  () => {
    assert(
      isIntendedRevenueCatCustomerNotFound({ code: 7225, message: "Subscriber does not exist." }),
    );
    for (const value of [
      null,
      [],
      {},
      "not found",
      { code: "7225" },
      { code: 404 },
      { error_code: 7225 },
      { code: 7225, message: {} },
      { code: 7225, error: "unknown_endpoint" },
    ]) {
      assertEquals(isIntendedRevenueCatCustomerNotFound(value), false);
    }
  },
);

Deno.test(
  "provider error parsing rejects malformed and oversized bodies without unbounded buffering",
  async () => {
    assertEquals(await readAccountDeletionResponseBody(Response.json({ code: 7225 })), {
      code: 7225,
    });
    assertEquals(
      await readAccountDeletionResponseBody(new Response("<html>not found</html>")),
      null,
    );
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(16_385));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    assertEquals(await readAccountDeletionResponseBody(response), null);
    assertEquals(cancelled, true);
    assertEquals(
      await readAccountDeletionResponseBody(
        new Response("{}", { headers: { "Content-Length": "1000000000" } }),
      ),
      null,
    );
  },
);

Deno.test("worker diagnostics report only the allowlisted stage and numeric status", async () => {
  const h = fixture();
  const logged: unknown[] = [];
  h.dependencies.onFailure = (code, status) => logged.push({ code, status });
  h.errors.set("apple", {
    status: 502,
    message: `${CAPABILITY} private@example.test`,
    code: CIPHERTEXT,
  });
  assertEquals((await h.confirm()).outcome, "unavailable");
  assertEquals(logged, [{ code: "apple_cleanup_unavailable", status: 502 }]);
});

Deno.test(
  "retention and retry constants are explicitly bounded draft policy, not legal approval",
  () => {
    assertEquals(ACCOUNT_DELETION_POLICY_DRAFT, {
      confirmationMinimumAgeSeconds: 3,
      confirmationLifetimeSeconds: 900,
      statusCapabilityLifetimeSeconds: 86_400,
      operationRetentionSeconds: 604_800,
      workerLeaseSeconds: 120,
      maximumWorkerAttempts: 8,
      legallyApproved: false,
    });
  },
);
