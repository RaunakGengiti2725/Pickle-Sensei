// INT-deletion-managed-media adversary (attacked HEAD 30a40650).
// Worker-level attacks on the leased account-deletion state machine using a
// scripted RPC and scripted providers. Nothing here touches production code.
//
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json \
//     adv_deletion_managed_media.test.ts
import { assert, assertEquals } from "@std/assert";
import {
  type AccountDeletionConfirmDependencies,
  confirmAccountDeletionOperation,
  type DeletionFailureCode,
  type DeletionOperationRpc,
  resumeConfirmedAccountDeletionOperation,
} from "../accountDeletionOperations.ts";
import {
  decryptAppleRefreshToken,
  encryptAppleRefreshToken,
  ExternalAccountError,
  isPermanentExternalAccountError,
} from "../externalAccounts.ts";

const OWNER = "0a0a0000-0000-4000-8000-000000000001";
const OPERATION = "0a0a0000-0000-4000-8000-000000001001";
const CHALLENGE = "0a0a0000-0000-4000-8000-000000002001";
const LEASE = "0a0a0000-0000-4000-8000-000000003001";
const CIPHERTEXT = "v1.abcdefghijklmnop.ciphertextOnlyForAdversaryTests";
const COMPLETED_AT = "2026-09-08T00:00:00.000Z";
const completed = {
  state: "completed",
  completionReceipt: { completedAt: COMPLETED_AT },
  appleAuthorizationRevocation: "revoked",
};

interface Call {
  name: string;
  parameters: Record<string, unknown>;
}

function fixture() {
  const calls: Call[] = [];
  const results = new Map<string, unknown>();
  const errors = new Map<string, unknown>();
  const failures: Array<{ code: DeletionFailureCode; status: number | null }> = [];
  let rpcHook: ((call: Call) => unknown | undefined) | null = null;
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
  results.set("fail_account_deletion_operation", { outcome: "released" });
  const rpc: DeletionOperationRpc = (name, parameters) => {
    const call = { name, parameters };
    calls.push(call);
    const hooked = rpcHook?.(call);
    if (hooked !== undefined) {
      return Promise.resolve(hooked as { data: unknown; error?: unknown });
    }
    if (errors.has(name)) return Promise.resolve({ data: null, error: errors.get(name) });
    return Promise.resolve({ data: results.get(name) ?? null });
  };
  const providerCall = (name: string, parameters: Record<string, unknown>): Promise<void> => {
    calls.push({ name, parameters });
    if (errors.has(name)) return Promise.reject(errors.get(name));
    return Promise.resolve();
  };
  const dependencies: AccountDeletionConfirmDependencies = {
    verifyLiveSession: async (ownerId) => {
      await providerCall("live_session", { ownerId });
      return true;
    },
    revokeAppleCredential: (encryptedToken, ownerId) =>
      providerCall("apple", { encryptedToken, ownerId }),
    deleteRevenueCatCustomer: (ownerId) => providerCall("revenuecat", { ownerId }),
    deleteAuthUser: async (ownerId) => {
      await providerCall("auth_delete", { ownerId });
      return { error: results.get("auth_error") };
    },
    onFailure: (code, status) => {
      failures.push({ code, status });
    },
  };
  const confirm = (body: unknown = { challenge: CHALLENGE, operationId: OPERATION }) =>
    confirmAccountDeletionOperation(rpc, dependencies, OWNER, body);
  const claimPatch = (patch: Record<string, unknown>) => {
    results.set("confirm_account_deletion_operation", {
      ...(results.get("confirm_account_deletion_operation") as Record<string, unknown>),
      ...patch,
    });
  };
  const names = () => calls.map((call) => call.name);
  const checkpoints = () =>
    calls
      .filter((call) => call.name === "checkpoint_account_deletion_operation")
      .map((call) => [call.parameters.p_checkpoint, call.parameters.p_apple_outcome]);
  const releasedWith = () =>
    calls
      .filter((call) => call.name === "fail_account_deletion_operation")
      .map((call) => call.parameters.p_error_code);
  return {
    calls,
    results,
    errors,
    failures,
    rpc,
    dependencies,
    confirm,
    claimPatch,
    names,
    checkpoints,
    releasedWith,
    setRpcHook: (hook: typeof rpcHook) => {
      rpcHook = hook;
    },
  };
}

Deno.test(
  "ADV-E01: an Apple revoke that outlives the lease cannot continue into RevenueCat or Auth",
  async () => {
    const f = fixture();
    let appleReturned = false;
    f.dependencies.revokeAppleCredential = (encryptedToken, ownerId) => {
      f.calls.push({ name: "apple", parameters: { encryptedToken, ownerId } });
      // The lease (120 s) expires while Apple is still answering; a second
      // worker has since taken the lease, so every RPC bound to the old token
      // is stale from here on.
      appleReturned = true;
      return Promise.resolve();
    };
    f.setRpcHook((call) => {
      if (!appleReturned) return undefined;
      if (call.parameters.p_lease_token === LEASE) return { data: { outcome: "stale_lease" } };
      return undefined;
    });
    const result = await f.confirm();
    assertEquals(result, { outcome: "unavailable", code: "checkpoint_unavailable" });
    assert(!f.names().includes("revenuecat"), "RevenueCat must not run under a stale lease");
    assert(!f.names().includes("auth_delete"), "Auth deletion must not run under a stale lease");
    assert(!f.names().includes("set_account_deletion_auth_intent"));
    assert(!f.names().includes("read_account_deletion_receipt"));
    assertEquals(f.checkpoints(), [
      ["lease_check", null],
      ["apple", "revoked"],
    ]);
    assertEquals(f.failures.map((failure) => failure.code), ["checkpoint_unavailable"]);
  },
);

Deno.test(
  "ADV-E02: a successful Auth delete with a malformed or stale receipt is never reported as deleted",
  async () => {
    const receipts: Array<[string, unknown]> = [
      ["completedAt is not a date", {
        ...completed,
        completionReceipt: { completedAt: "not-a-date" },
      }],
      ["completedAt is a bare date prefix", {
        ...completed,
        completionReceipt: { completedAt: "2026-09-08T" },
      }],
      ["completedAt is a number", { ...completed, completionReceipt: { completedAt: Date.now() } }],
      ["completedAt is an epoch string", {
        ...completed,
        completionReceipt: { completedAt: String(Date.now()) },
      }],
      ["completionReceipt is an empty object", { ...completed, completionReceipt: {} }],
      ["completionReceipt is a string", { ...completed, completionReceipt: COMPLETED_AT }],
      ["Apple outcome is upper-cased", { ...completed, appleAuthorizationRevocation: "REVOKED" }],
      ["Apple outcome is a foreign value", {
        ...completed,
        appleAuthorizationRevocation: "revoke",
      }],
      ["Apple outcome is missing", {
        state: "completed",
        completionReceipt: completed.completionReceipt,
      }],
      ["state is capitalised", { ...completed, state: "Completed" }],
      ["state says in_progress with a receipt", { ...completed, state: "in_progress" }],
      ["state says in_progress with deleted:true", {
        state: "in_progress",
        completionReceipt: null,
        appleAuthorizationRevocation: null,
        deleted: true,
      }],
      ["state says blocked", {
        state: "blocked",
        completionReceipt: null,
        appleAuthorizationRevocation: null,
      }],
      ["receipt is an array", [completed]],
      ["receipt is JSON text", JSON.stringify(completed)],
      ["receipt is null", null],
      ["receipt is true", true],
    ];
    for (const [label, receipt] of receipts) {
      const f = fixture();
      f.results.set("read_account_deletion_receipt", receipt);
      const result = await f.confirm();
      assertEquals(result, { outcome: "unavailable", code: "completion_unverified" }, label);
      assertEquals(f.names().filter((name) => name === "auth_delete").length, 1, label);
      assertEquals(f.releasedWith(), ["completion_unverified"], label);
      assertEquals(f.failures.map((failure) => failure.code), ["completion_unverified"], label);
    }
  },
);

Deno.test(
  "ADV-E03: a self-contradictory lease is refused before any provider or checkpoint call",
  async () => {
    const leases: Array<[string, Record<string, unknown>]> = [
      ["revoke with appleCompleted already true", { appleCompleted: true }],
      ["revoke without ciphertext", { appleRefreshTokenEncrypted: null }],
      ["revoke with a too-short ciphertext", { appleRefreshTokenEncrypted: "v1.a.b" }],
      ["not_applicable while ciphertext is still attached", { appleAction: "not_applicable" }],
      ["manual_action_required while ciphertext is still attached", {
        appleAction: "manual_action_required",
      }],
      ["unknown Apple action", { appleAction: "skip", appleRefreshTokenEncrypted: null }],
      ["lease token missing", { leaseToken: null }],
      ["lease token is not a UUID", { leaseToken: "lease" }],
      ["lease expiry is not a timestamp", { leaseExpiresAt: "soon" }],
      ["confirmedAt is missing", { confirmedAt: undefined }],
      ["revenueCatCompleted is a string", { revenueCatCompleted: "true" }],
      ["operation id belongs to another operation", {
        operationId: "0a0a0000-0000-4000-8000-000000001002",
      }],
    ];
    for (const [label, patch] of leases) {
      const f = fixture();
      f.claimPatch(patch);
      const result = await f.confirm();
      assertEquals(result, { outcome: "unavailable", code: "checkpoint_unavailable" }, label);
      assertEquals(
        f.names().filter((name) => ["apple", "revenuecat", "auth_delete"].includes(name)),
        [],
        label,
      );
      assertEquals(f.checkpoints(), [], label);
      assert(!f.names().includes("set_account_deletion_auth_intent"), label);
    }
  },
);

Deno.test(
  "ADV-E04: Apple invalid_grant whose unrevocable checkpoint is refused by the database stops before RevenueCat and Auth",
  async () => {
    const f = fixture();
    f.errors.set(
      "apple",
      new ExternalAccountError("invalid_grant", "apple", "Apple refused the token.", 400),
    );
    f.setRpcHook((call) => {
      if (
        call.name === "checkpoint_account_deletion_operation" &&
        call.parameters.p_checkpoint === "apple_unrevocable"
      ) {
        // The credential row changed underneath the lease (e.g. a racing
        // bootstrap replaced it): the database raises 22023.
        return { data: null, error: { code: "22023", status: 400 } };
      }
      return undefined;
    });
    const result = await f.confirm();
    assertEquals(result, { outcome: "unavailable", code: "checkpoint_unavailable" });
    assertEquals(f.checkpoints(), [
      ["lease_check", null],
      ["apple_unrevocable", "manual_action_required"],
    ]);
    assert(!f.names().includes("revenuecat"));
    assert(!f.names().includes("auth_delete"));
    assertEquals(f.releasedWith(), ["checkpoint_unavailable"]);
  },
);

Deno.test(
  "ADV-E05: Apple invalid_grant proceeds through apple_unrevocable and the receipt reports manual_action_required only",
  async () => {
    const f = fixture();
    f.errors.set(
      "apple",
      new ExternalAccountError("invalid_grant", "apple", "Apple refused the token.", 400),
    );
    f.results.set("read_account_deletion_receipt", {
      ...completed,
      appleAuthorizationRevocation: "manual_action_required",
    });
    const result = await f.confirm();
    assertEquals(result, {
      outcome: "completed",
      operationId: OPERATION,
      deleted: true,
      completionReceipt: { completedAt: COMPLETED_AT },
      appleAuthorizationRevocation: "manual_action_required",
    });
    assertEquals(f.checkpoints(), [
      ["lease_check", null],
      ["apple_unrevocable", "manual_action_required"],
      ["lease_check", null],
      ["revenuecat", null],
      ["external_complete", null],
    ]);
    assertEquals(f.names().filter((name) => name === "apple").length, 1);
    assertEquals(f.failures, []);
  },
);

Deno.test(
  "ADV-E06: transient Apple, RevenueCat and Auth failures each release the lease with their own code and never reach later steps",
  async () => {
    const cases: Array<{
      label: string;
      stage: string;
      error: unknown;
      code: DeletionFailureCode;
      forbidden: string[];
    }> = [
      {
        label: "Apple 503",
        stage: "apple",
        error: new ExternalAccountError("unavailable", "apple", "Apple 503.", 503),
        code: "apple_cleanup_unavailable",
        forbidden: ["revenuecat", "auth_delete", "set_account_deletion_auth_intent"],
      },
      {
        label: "Apple client secret misconfigured",
        stage: "apple",
        error: new ExternalAccountError("configuration", "apple", "Missing APPLE_SIGN_IN_KEY_ID."),
        code: "apple_cleanup_unavailable",
        forbidden: ["revenuecat", "auth_delete", "set_account_deletion_auth_intent"],
      },
      {
        label: "Apple transport TypeError",
        stage: "apple",
        error: new TypeError("fetch failed"),
        code: "apple_cleanup_unavailable",
        forbidden: ["revenuecat", "auth_delete", "set_account_deletion_auth_intent"],
      },
      {
        label: "RevenueCat 429",
        stage: "revenuecat",
        error: new ExternalAccountError("unavailable", "revenuecat", "RevenueCat 429.", 429),
        code: "revenuecat_cleanup_unavailable",
        forbidden: ["auth_delete", "set_account_deletion_auth_intent"],
      },
      {
        label: "RevenueCat unverified 404",
        stage: "revenuecat",
        error: new ExternalAccountError(
          "invalid_response",
          "revenuecat",
          "Customer absence is unverified.",
          404,
        ),
        code: "revenuecat_cleanup_unavailable",
        forbidden: ["auth_delete", "set_account_deletion_auth_intent"],
      },
      {
        label: "Auth admin transport failure",
        stage: "auth_delete",
        error: new TypeError("fetch failed"),
        code: "auth_delete_unavailable",
        forbidden: ["read_account_deletion_receipt"],
      },
    ];
    for (const testCase of cases) {
      const f = fixture();
      f.errors.set(testCase.stage, testCase.error);
      const result = await f.confirm();
      assertEquals(result, { outcome: "unavailable", code: testCase.code }, testCase.label);
      for (const forbidden of testCase.forbidden) {
        assert(!f.names().includes(forbidden), `${testCase.label}: ${forbidden} must not run`);
      }
      assertEquals(f.releasedWith(), [testCase.code], testCase.label);
      assertEquals(
        f.checkpoints().some(([step]) => step === "external_complete"),
        testCase.stage === "auth_delete",
        `${testCase.label}: external_complete is checkpointed only once both providers succeeded`,
      );
    }
  },
);

Deno.test(
  "ADV-E07: repeated confirm and internal resume of a completed operation return the receipt without any provider or Auth call",
  async () => {
    const f = fixture();
    f.results.set("confirm_account_deletion_operation", {
      outcome: "completed",
      operationId: OPERATION,
      status: completed,
    });
    f.results.set("claim_account_deletion_work", {
      outcome: "completed",
      operationId: OPERATION,
      status: completed,
    });
    const again = await f.confirm();
    const resumed = await resumeConfirmedAccountDeletionOperation(
      f.rpc,
      f.dependencies,
      OWNER,
      OPERATION,
    );
    for (const result of [again, resumed]) {
      assertEquals(result, {
        outcome: "completed",
        operationId: OPERATION,
        deleted: true,
        completionReceipt: { completedAt: COMPLETED_AT },
        appleAuthorizationRevocation: "revoked",
      });
    }
    assertEquals(
      f.names().filter((name) => ["apple", "revenuecat", "auth_delete"].includes(name)),
      [],
    );
    assertEquals(f.checkpoints(), []);

    // A completed claim whose status is stale or malformed is not a receipt.
    for (
      const status of [
        { state: "in_progress", completionReceipt: null, appleAuthorizationRevocation: null },
        { ...completed, completionReceipt: null },
        undefined,
      ]
    ) {
      const g = fixture();
      g.results.set("claim_account_deletion_work", {
        outcome: "completed",
        operationId: OPERATION,
        status,
      });
      assertEquals(
        await resumeConfirmedAccountDeletionOperation(g.rpc, g.dependencies, OWNER, OPERATION),
        { outcome: "unavailable", code: "completion_unverified" },
      );
      assertEquals(g.names(), ["claim_account_deletion_work"]);
    }
  },
);

Deno.test(
  "ADV-E08: operator key rotation or a misconfigured APPLE_TOKEN_ENCRYPTION_KEY classifies the stored credential as permanently unrevocable",
  async () => {
    // Observation, not a verdict: a valid 32-byte key that is simply the WRONG
    // key is indistinguishable from an intentional rotation, so the worker
    // drops the credential (apple_unrevocable) instead of retrying.
    const keyA = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const keyB = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const ciphertext = await encryptAppleRefreshToken("r1.apple-refresh-token", OWNER, keyA);
    assertEquals(await decryptAppleRefreshToken(ciphertext, OWNER, keyA), "r1.apple-refresh-token");
    let failure: unknown = null;
    try {
      await decryptAppleRefreshToken(ciphertext, OWNER, keyB);
    } catch (error) {
      failure = error;
    }
    assert(failure instanceof ExternalAccountError);
    assertEquals(failure.kind, "invalid_response");
    assertEquals(isPermanentExternalAccountError(failure), true);
    // A wrongly sized key is retryable configuration, as documented.
    let sizeFailure: unknown = null;
    try {
      await decryptAppleRefreshToken(ciphertext, OWNER, btoa("short"));
    } catch (error) {
      sizeFailure = error;
    }
    assert(sizeFailure instanceof ExternalAccountError);
    assertEquals(sizeFailure.kind, "configuration");
    assertEquals(isPermanentExternalAccountError(sizeFailure), false);
  },
);
