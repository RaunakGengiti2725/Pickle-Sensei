import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { ExternalAccountError } from "../externalAccounts.ts";
import {
  type AccountDeletionConfirmDependencies,
  accountDeletionStatusResponse,
  completedInventoryRows,
  confirmAccountDeletionOperation,
  type DeletionOperationRpc,
  INVENTORY_MAX_PAGES,
  readOwnerInventory,
  resumeConfirmedAccountDeletionOperation,
} from "../accountDeletionOperations.ts";

// INT-deletion-managed-media adversary (attack branch only): unknown or
// tampered durable state must never surface as a successful deletion, a
// provider failure must fail closed before Auth deletion, and the inventory
// reader must fail closed at its page budget. Nothing here fixes behaviour.

const OWNER = "0adf0000-0000-4000-8000-000000000001";
const OPERATION = "0adf0000-0000-4000-8000-000000001001";
const OTHER_OPERATION = "0adf0000-0000-4000-8000-000000001002";
const CHALLENGE = "0adf0000-0000-4000-8000-000000002001";
const LEASE = "0adf0000-0000-4000-8000-000000003001";
const CAPABILITY = "B".repeat(43);
const CIPHERTEXT = "v1.abcdefghijklmnop.ciphertextOnlyForAdversaryTests";
const COMPLETED_AT = "2026-09-08T00:00:00.000Z";

type Call = { name: string; parameters: Record<string, unknown> };

function claimedLease(overrides: Record<string, unknown> = {}) {
  return {
    outcome: "claimed",
    operationId: OPERATION,
    leaseToken: LEASE,
    leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    confirmedAt: new Date(Date.now() - 5_000).toISOString(),
    appleAction: "revoke",
    appleRefreshTokenEncrypted: CIPHERTEXT,
    appleCompleted: false,
    revenueCatCompleted: false,
    revenueCatAlreadyDeleted: false,
    ...overrides,
  };
}

function fixture() {
  const calls: Call[] = [];
  const results = new Map<string, unknown>();
  const providerErrors = new Map<string, unknown>();
  const rpcHandlers = new Map<string, (parameters: Record<string, unknown>) => unknown>();
  results.set("confirm_account_deletion_operation", claimedLease());
  results.set("claim_account_deletion_work", claimedLease());
  results.set("checkpoint_account_deletion_operation", { outcome: "checkpointed" });
  results.set("set_account_deletion_auth_intent", { outcome: "intent_recorded" });
  results.set("read_account_deletion_receipt", {
    state: "completed",
    completionReceipt: { completedAt: COMPLETED_AT },
    appleAuthorizationRevocation: "revoked",
  });
  results.set("fail_account_deletion_operation", { outcome: "released" });
  const rpc: DeletionOperationRpc = async (name, parameters) => {
    calls.push({ name, parameters });
    const handler = rpcHandlers.get(name);
    if (handler) return { data: handler(parameters) };
    return { data: results.get(name) ?? null };
  };
  const provider = async (name: string, parameters: Record<string, unknown>) => {
    calls.push({ name, parameters });
    if (providerErrors.has(name)) throw providerErrors.get(name);
  };
  const dependencies: AccountDeletionConfirmDependencies = {
    verifyLiveSession: async () => true,
    revokeAppleCredential: (token, ownerId) => provider("revokeApple", { token, ownerId }),
    deleteRevenueCatCustomer: (ownerId) => provider("deleteRevenueCat", { ownerId }),
    deleteAuthUser: async (ownerId) => {
      calls.push({ name: "deleteAuthUser", parameters: { ownerId } });
      if (providerErrors.has("deleteAuthUser")) {
        return { error: providerErrors.get("deleteAuthUser") };
      }
      return { error: null };
    },
  };
  const named = (name: string) => calls.filter((call) => call.name === name);
  const checkpoints = () =>
    named("checkpoint_account_deletion_operation").map((call) => [
      call.parameters.p_checkpoint,
      call.parameters.p_apple_outcome,
    ]);
  return { calls, results, providerErrors, rpcHandlers, rpc, dependencies, named, checkpoints };
}

function assertNeverDeleted(result: { outcome: string }) {
  assertNotEquals(result.outcome, "completed");
  assertEquals((result as Record<string, unknown>).deleted, undefined);
}

Deno.test("ADV unknown state: 'completed' claim with a non-allowlisted Apple outcome is not a deletion", async () => {
  const f = fixture();
  for (const revocation of ["deleted", "", null, "REVOKED", 1, {}]) {
    f.results.set("confirm_account_deletion_operation", {
      outcome: "completed",
      operationId: OPERATION,
      status: {
        state: "completed",
        completionReceipt: { completedAt: COMPLETED_AT },
        appleAuthorizationRevocation: revocation,
      },
    });
    const result = await confirmAccountDeletionOperation(f.rpc, f.dependencies, OWNER, {
      challenge: CHALLENGE,
    });
    assertNeverDeleted(result);
    assertEquals(result, { outcome: "unavailable", code: "completion_unverified" });
  }
  assertEquals(f.named("deleteAuthUser").length, 0);
  assertEquals(f.named("revokeApple").length, 0);
});

Deno.test("ADV unknown state: 'completed' claim whose receipt timestamp is malformed is not a deletion", async () => {
  const f = fixture();
  for (const completedAt of ["yesterday", 1_700_000_000, "", null, "2026-13-40T00:00:00Z"]) {
    f.results.set("confirm_account_deletion_operation", {
      outcome: "completed",
      operationId: OPERATION,
      status: {
        state: "completed",
        completionReceipt: { completedAt },
        appleAuthorizationRevocation: "revoked",
      },
    });
    const result = await confirmAccountDeletionOperation(f.rpc, f.dependencies, OWNER, {
      challenge: CHALLENGE,
    });
    assertNeverDeleted(result);
  }
});

Deno.test("ADV unknown state: Auth deleted but the durable receipt reads blocked/in-progress → unverified, never deleted:true", async () => {
  for (const state of ["blocked", "in_progress", "pending", "expired", "superseded"]) {
    const f = fixture();
    f.results.set("read_account_deletion_receipt", {
      state,
      completionReceipt: null,
      appleAuthorizationRevocation: null,
    });
    const result = await confirmAccountDeletionOperation(f.rpc, f.dependencies, OWNER, {
      challenge: CHALLENGE,
      operationId: OPERATION,
    });
    assertEquals(f.named("deleteAuthUser").length, 1);
    assertNeverDeleted(result);
    assertEquals(result, { outcome: "unavailable", code: "completion_unverified" });
    const failure = f.named("fail_account_deletion_operation");
    assertEquals(failure.length, 1);
    assertEquals(failure[0]?.parameters.p_error_code, "completion_unverified");
    assertEquals(failure[0]?.parameters.p_lease_token, LEASE);
  }
});

Deno.test("ADV unknown state: a receipt read that throws after Auth deletion stays unverified and does not loop into a second Auth delete", async () => {
  const f = fixture();
  f.rpcHandlers.set("read_account_deletion_receipt", () => {
    throw new Error("receipt store unavailable");
  });
  const result = await confirmAccountDeletionOperation(f.rpc, f.dependencies, OWNER, {
    challenge: CHALLENGE,
  });
  assertNeverDeleted(result);
  assertEquals(result.outcome, "unavailable");
  assertEquals(f.named("deleteAuthUser").length, 1);
});

Deno.test("ADV claim binding: RPC claim naming a different operation than the client supplied is refused before any provider call", async () => {
  const f = fixture();
  f.results.set(
    "confirm_account_deletion_operation",
    claimedLease({ operationId: OTHER_OPERATION }),
  );
  const result = await confirmAccountDeletionOperation(f.rpc, f.dependencies, OWNER, {
    challenge: CHALLENGE,
    operationId: OPERATION,
  });
  assertEquals(result, { outcome: "unavailable", code: "checkpoint_unavailable" });
  assertEquals(f.named("revokeApple").length, 0);
  assertEquals(f.named("deleteRevenueCat").length, 0);
  assertEquals(f.named("deleteAuthUser").length, 0);
  assertEquals(f.checkpoints().length, 0);
});

Deno.test("ADV claim binding: a claim with a malformed lease token or missing Apple ciphertext never starts provider work", async () => {
  for (
    const claim of [
      claimedLease({ leaseToken: "not-a-uuid" }),
      claimedLease({ appleAction: "revoke", appleRefreshTokenEncrypted: null }),
      claimedLease({ appleAction: "delete_everything" }),
      claimedLease({ leaseExpiresAt: "soon" }),
      claimedLease({ appleCompleted: "yes" }),
    ]
  ) {
    const f = fixture();
    f.results.set("confirm_account_deletion_operation", claim);
    const result = await confirmAccountDeletionOperation(f.rpc, f.dependencies, OWNER, {
      challenge: CHALLENGE,
    });
    assertNeverDeleted(result);
    assertEquals(f.named("revokeApple").length, 0);
    assertEquals(f.named("deleteRevenueCat").length, 0);
    assertEquals(f.named("deleteAuthUser").length, 0);
  }
});

Deno.test("ADV revocation failure: transient Apple failure releases the lease and nothing downstream runs", async () => {
  for (
    const error of [
      new ExternalAccountError("unavailable", "apple", "Apple 503", 503),
      new ExternalAccountError("configuration", "apple", "missing Apple secrets"),
      new TypeError("fetch failed"),
      "string thrown",
    ]
  ) {
    const f = fixture();
    f.providerErrors.set("revokeApple", error);
    const result = await confirmAccountDeletionOperation(f.rpc, f.dependencies, OWNER, {
      challenge: CHALLENGE,
    });
    assertEquals(result, { outcome: "unavailable", code: "apple_cleanup_unavailable" });
    assertEquals(f.named("deleteRevenueCat").length, 0);
    assertEquals(f.named("deleteAuthUser").length, 0);
    assertEquals(f.named("set_account_deletion_auth_intent").length, 0);
    assertEquals(f.checkpoints(), [["lease_check", null]]);
    assertEquals(
      f.named("fail_account_deletion_operation")[0]?.parameters.p_error_code,
      "apple_cleanup_unavailable",
    );
  }
});

Deno.test("ADV revocation failure: permanent Apple refusal checkpoints apple_unrevocable and the receipt says manual_action_required", async () => {
  const f = fixture();
  f.providerErrors.set(
    "revokeApple",
    new ExternalAccountError("invalid_grant", "apple", "invalid_grant", 400),
  );
  f.results.set("read_account_deletion_receipt", {
    state: "completed",
    completionReceipt: { completedAt: COMPLETED_AT },
    appleAuthorizationRevocation: "manual_action_required",
  });
  const result = await confirmAccountDeletionOperation(f.rpc, f.dependencies, OWNER, {
    challenge: CHALLENGE,
  });
  assertEquals(result.outcome, "completed");
  if (result.outcome !== "completed") throw new Error("unreachable");
  assertEquals(result.appleAuthorizationRevocation, "manual_action_required");
  assertEquals(f.checkpoints(), [
    ["lease_check", null],
    ["apple_unrevocable", "manual_action_required"],
    ["lease_check", null],
    ["revenuecat", null],
    ["external_complete", null],
  ]);
  assertEquals(f.named("revokeApple").length, 1);
  assertEquals(f.named("deleteRevenueCat").length, 1);
  assertEquals(f.named("deleteAuthUser").length, 1);
});

Deno.test("ADV revocation failure: the database refusing apple_unrevocable fails closed (no RevenueCat, no Auth delete)", async () => {
  const f = fixture();
  f.providerErrors.set(
    "revokeApple",
    new ExternalAccountError("invalid_grant", "apple", "invalid_grant", 400),
  );
  f.rpcHandlers.set(
    "checkpoint_account_deletion_operation",
    (parameters) =>
      parameters.p_checkpoint === "apple_unrevocable"
        ? { outcome: "stale_lease" }
        : { outcome: "checkpointed" },
  );
  const result = await confirmAccountDeletionOperation(f.rpc, f.dependencies, OWNER, {
    challenge: CHALLENGE,
  });
  assertNeverDeleted(result);
  assertEquals(f.named("deleteRevenueCat").length, 0);
  assertEquals(f.named("deleteAuthUser").length, 0);
});

Deno.test("ADV restart mid-deletion: a lease stolen between checkpoints stops the worker before Auth deletion", async () => {
  // The first worker paused after Apple; a second worker (lease takeover after
  // expiry) finished Apple + RevenueCat; the stale first worker resumes.
  const f = fixture();
  let checkpointCalls = 0;
  f.rpcHandlers.set("checkpoint_account_deletion_operation", () => {
    checkpointCalls += 1;
    return checkpointCalls <= 2 ? { outcome: "checkpointed" } : { outcome: "stale_lease" };
  });
  const result = await resumeConfirmedAccountDeletionOperation(
    f.rpc,
    f.dependencies,
    OWNER,
    OPERATION,
  );
  assertEquals(result, { outcome: "unavailable", code: "checkpoint_unavailable" });
  assertEquals(f.named("deleteRevenueCat").length, 0);
  assertEquals(f.named("set_account_deletion_auth_intent").length, 0);
  assertEquals(f.named("deleteAuthUser").length, 0);
  // fail_account_deletion_operation is fenced by the (stale) lease token, so
  // it cannot release the live worker's lease.
  assertEquals(f.named("fail_account_deletion_operation")[0]?.parameters.p_lease_token, LEASE);
});

Deno.test("ADV restart mid-deletion: a worker resuming after external_complete never repeats Apple/RevenueCat", async () => {
  const f = fixture();
  f.results.set(
    "claim_account_deletion_work",
    claimedLease({
      appleCompleted: true,
      revenueCatCompleted: true,
      appleAction: "revoked",
      appleRefreshTokenEncrypted: null,
    }),
  );
  const result = await resumeConfirmedAccountDeletionOperation(
    f.rpc,
    f.dependencies,
    OWNER,
    OPERATION,
  );
  assertEquals(result.outcome, "completed");
  assertEquals(f.named("revokeApple").length, 0);
  assertEquals(f.named("deleteRevenueCat").length, 0);
  assertEquals(f.checkpoints(), [["external_complete", null]]);
  assertEquals(f.named("deleteAuthUser").length, 1);
});

Deno.test("ADV double action: an intent RPC that is not 'intent_recorded' blocks the destructive Auth call", async () => {
  for (
    const intent of [{ outcome: "stale_lease" }, { outcome: "recorded" }, null, "ok", {
      outcome: "intent_recorded",
      extra: 1,
    }]
  ) {
    const f = fixture();
    f.results.set("set_account_deletion_auth_intent", intent);
    const result = await confirmAccountDeletionOperation(f.rpc, f.dependencies, OWNER, {
      challenge: CHALLENGE,
    });
    const shouldProceed = intent !== null && typeof intent === "object" &&
      intent.outcome === "intent_recorded";
    assertEquals(f.named("deleteAuthUser").length, shouldProceed ? 1 : 0);
    if (!shouldProceed) assertNeverDeleted(result);
  }
});

Deno.test("ADV status route: a tampered completed record (bad Apple outcome, bad receipt, extra fields) is never a 200 completion", async () => {
  const records: unknown[] = [
    {
      state: "completed",
      completionReceipt: { completedAt: COMPLETED_AT },
      appleAuthorizationRevocation: "deleted",
    },
    {
      state: "completed",
      completionReceipt: { completedAt: "soon" },
      appleAuthorizationRevocation: "revoked",
    },
    { state: "completed", completionReceipt: null, appleAuthorizationRevocation: "revoked" },
    {
      state: "completed",
      completionReceipt: { completedAt: COMPLETED_AT },
      appleAuthorizationRevocation: null,
    },
    {
      state: "deleted",
      completionReceipt: { completedAt: COMPLETED_AT },
      appleAuthorizationRevocation: "revoked",
    },
    {
      state: "in_progress",
      completionReceipt: { completedAt: COMPLETED_AT },
      appleAuthorizationRevocation: null,
    },
    { state: "in_progress", completionReceipt: null, appleAuthorizationRevocation: "revoked" },
    "completed",
    [],
    42,
  ];
  for (const record of records) {
    const rpc: DeletionOperationRpc = async () => ({ data: record });
    const request = new Request("https://edge.test/v1/me/delete-status", {
      method: "POST",
      headers: { Authorization: `Bearer ${CAPABILITY}` },
    });
    const response = await accountDeletionStatusResponse(rpc, request, { operationId: OPERATION });
    assertNotEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.state, undefined);
    assertEquals(body.completionReceipt, undefined);
  }
});

Deno.test("ADV status route: malformed capability/body shapes never reach the RPC", async () => {
  let rpcCalls = 0;
  const rpc: DeletionOperationRpc = async () => {
    rpcCalls += 1;
    return {
      data: {
        state: "completed",
        completionReceipt: { completedAt: COMPLETED_AT },
        appleAuthorizationRevocation: "revoked",
      },
    };
  };
  const attempts: Array<{ url?: string; method?: string; auth?: string | null; body: unknown }> = [
    { auth: `Bearer ${CAPABILITY}`, body: { operationId: OPERATION, extra: true } },
    { auth: `Bearer ${CAPABILITY}`, body: { operationId: "not-a-uuid" } },
    { auth: `Bearer ${CAPABILITY}`, body: [OPERATION] },
    { auth: `Bearer ${CAPABILITY}`, body: null },
    { auth: `Bearer ${CAPABILITY.slice(0, 42)}`, body: { operationId: OPERATION } },
    { auth: `Bearer ${CAPABILITY}=`, body: { operationId: OPERATION } },
    { auth: `Basic ${CAPABILITY}`, body: { operationId: OPERATION } },
    { auth: null, body: { operationId: OPERATION } },
    { auth: `Bearer ${CAPABILITY}`, method: "GET", body: { operationId: OPERATION } },
    {
      auth: `Bearer ${CAPABILITY}`,
      url: "https://edge.test/v1/me/delete-status?x=1",
      body: { operationId: OPERATION },
    },
  ];
  for (const attempt of attempts) {
    const headers = new Headers();
    if (attempt.auth !== null) headers.set("Authorization", attempt.auth ?? "");
    const request = new Request(attempt.url ?? "https://edge.test/v1/me/delete-status", {
      method: attempt.method ?? "POST",
      headers,
    });
    const response = await accountDeletionStatusResponse(rpc, request, attempt.body);
    assertEquals(response.status, 404);
    await response.body?.cancel();
  }
  assertEquals(rpcCalls, 0);
});

Deno.test("ADV pagination: exactly the page budget of full pages is INCOMPLETE (fail closed), one fewer is COMPLETE", async () => {
  const pageOf = (page: number) => [{ id: `${page}-a` }, { id: `${page}-b` }];
  const reader = (fullPages: number) => {
    let served = 0;
    return {
      pageRows: 2,
      readPage: async () => {
        served += 1;
        return { data: served <= fullPages ? pageOf(served) : [], error: null };
      },
      cursorAfter: (row: { id: string }) => row.id,
      cursorKey: (cursor: string) => cursor,
      calls: () => served,
    };
  };
  const budget = reader(INVENTORY_MAX_PAGES);
  const atBudget = await readOwnerInventory(budget);
  assertEquals(atBudget.status, "INCOMPLETE");
  if (atBudget.status === "INCOMPLETE") assertEquals(atBudget.reason, "page_budget");
  assertEquals(completedInventoryRows(atBudget), null);
  assertEquals(budget.calls(), INVENTORY_MAX_PAGES);

  const below = reader(INVENTORY_MAX_PAGES - 1);
  const complete = await readOwnerInventory(below);
  assertEquals(complete.status, "COMPLETE");
  assertEquals(completedInventoryRows(complete)?.length, 2 * (INVENTORY_MAX_PAGES - 1));
  assertEquals(below.calls(), INVENTORY_MAX_PAGES);
});

Deno.test("ADV pagination: a source that ignores the cursor is caught on the second page, not at the budget", async () => {
  let served = 0;
  const result = await readOwnerInventory({
    pageRows: 3,
    readPage: async () => {
      served += 1;
      return { data: [{ id: "x" }, { id: "y" }, { id: "z" }], error: null };
    },
    cursorAfter: (row: { id: string }) => row.id,
    cursorKey: (cursor: string) => cursor,
  });
  assertEquals(result.status, "INCOMPLETE");
  if (result.status === "INCOMPLETE") assertEquals(result.reason, "repeated_row");
  assertEquals(served, 2);
  assertEquals(completedInventoryRows(result), null);
  assert(INVENTORY_MAX_PAGES > 2);
});
