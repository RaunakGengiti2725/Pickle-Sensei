// W08-06: an account deletion is reported complete only once every
// account-owned namespace has been read EMPTY for the owner with the W07-06
// complete-inventory contract (keyset pages until an empty page), after the
// Apple authorization was revoked and the Supabase identity is gone. Residue
// or an unproven read is a retryable 503 with operator diagnostics, never
// `deleted: true`. The legal/support copy states the one retained record
// (the hashed free-rating ledger) the same way in all three documents.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { encryptAppleRefreshToken } from "../externalAccounts.ts";
import {
  type AccountDeletionConfirmDependencies,
  confirmAccountDeletionOperation,
  type DeletionOperationRpc,
} from "../accountDeletionOperations.ts";
import { PRIVACY_POLICY_TEXT, SUPPORT_TEXT, TERMS_TEXT } from "../legal.ts";
import {
  captureConsole,
  fakeGoogleIdToken,
  fakeSupabaseAccessToken,
  loadHarness,
  RC_URL,
  TEST_USER_ID,
  userRequest,
} from "./routesHarness.ts";

const h = await loadHarness();

/** Every `public` table that carries an owner id, with the column the owner
 * is matched on and the primary key the complete read pages by. Mirrors the
 * cascade tree in supabase/migrations (auth.users → profiles → each table);
 * `account_external_credentials` and `account_deletion_requests` cascade from
 * profiles and are only touched by the fenced deletion RPCs, and
 * `free_rating_ledger` / `webhook_events` carry no account key by design. */
const OWNER_NAMESPACES: ReadonlyArray<[table: string, owner: string, key: string[]]> = [
  ["profiles", "id", ["id"]],
  ["sessions", "user_id", ["id"]],
  ["shots", "user_id", ["id"]],
  ["shot_phases", "user_id", ["shot_id", "phase_key"]],
  ["shot_measurements", "user_id", ["shot_id", "metric_key"]],
  ["shot_checkpoints", "user_id", ["shot_id", "checkpoint_key"]],
  ["captures", "user_id", ["id"]],
  ["analysis_permits", "user_id", ["id"]],
  ["analysis_permit_tombstones", "user_id", ["permit_id"]],
  ["consent_records", "user_id", ["id"]],
  ["evaluation_trials", "user_id", ["id"]],
  ["analysis_feedback", "user_id", ["id"]],
  ["user_saved_drills", "user_id", ["user_id", "slug"]],
  ["player_rank_state", "user_id", ["user_id"]],
  ["billing_entitlements", "user_id", ["user_id"]],
  ["account_deletion_feedback", "user_id", ["id"]],
];
const NAMESPACE_TABLES = OWNER_NAMESPACES.map(([table]) => table).sort();
const PAGE_ROWS = 1_000;

const OWNER = "08080000-0000-4000-8000-000000000006";
const OPERATION = "08080000-0000-4000-8000-000000001006";
const CHALLENGE = "08080000-0000-4000-8000-000000002006";
const LEASE = "08080000-0000-4000-8000-000000003006";
const CIPHERTEXT = "v1.abcdefghijklmnop.ciphertextOnlyForInjectedTests";
const COMPLETED_AT = "2026-09-08T00:00:00.000Z";
const completed = {
  state: "completed",
  completionReceipt: { completedAt: COMPLETED_AT },
  appleAuthorizationRevocation: "revoked",
};

interface NamespaceRead {
  table: string;
  ownerColumn: string;
  keyColumns: string[];
  ownerId: string;
  before: string | null;
  limit: number;
}

type PageResponse = {
  data: unknown[] | null;
  error: { message: string; code?: string } | null;
  status?: number;
};

function fixture() {
  const calls: Array<{ name: string; parameters: Record<string, unknown> }> = [];
  const reads: NamespaceRead[] = [];
  const failures: Array<{ code: string; status: number | null; detail: unknown }> = [];
  const results = new Map<string, unknown>();
  /** Per-table page script: consumed in order, empty page once exhausted. */
  const pages = new Map<string, PageResponse[]>();
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
  const rpc: DeletionOperationRpc = async (name, parameters) => {
    calls.push({ name, parameters });
    return { data: results.get(name) ?? null };
  };
  const provider = async (name: string, parameters: Record<string, unknown>) => {
    calls.push({ name, parameters });
  };
  const dependencies: AccountDeletionConfirmDependencies = {
    verifyLiveSession: async (ownerId) => {
      await provider("live_session", { ownerId });
      return true;
    },
    revokeAppleCredential: (encryptedToken, ownerId) =>
      provider("apple", { encryptedToken, ownerId }),
    deleteRevenueCatCustomer: (ownerId) => provider("revenuecat", { ownerId }),
    deleteAuthUser: async (ownerId) => {
      await provider("auth_delete", { ownerId });
      return {};
    },
    readOwnerNamespacePage: async (namespace, ownerId, before, limit) => {
      calls.push({ name: "namespace_read", parameters: { table: namespace.table } });
      reads.push({
        table: namespace.table,
        ownerColumn: namespace.ownerColumn,
        keyColumns: [...namespace.keyColumns],
        ownerId,
        before,
        limit,
      });
      const script = pages.get(namespace.table);
      const page = script?.shift();
      return page ?? { data: [], error: null };
    },
    onFailure: (code, status, detail) => {
      failures.push({ code, status, detail });
    },
  };
  const confirm = () =>
    confirmAccountDeletionOperation(rpc, dependencies, OWNER, {
      challenge: CHALLENGE,
      operationId: OPERATION,
    });
  return { calls, reads, failures, results, pages, confirm };
}

const uuid = (n: number) => `08080000-0000-4000-8000-${String(n).padStart(12, "0")}`;

Deno.test(
  "W08-06 worker: deletion completes only after Apple revoke, Auth delete and an empty read of every owner namespace",
  async () => {
    const f = fixture();
    assertEquals(await f.confirm(), {
      outcome: "completed",
      operationId: OPERATION,
      deleted: true,
      completionReceipt: { completedAt: COMPLETED_AT },
      appleAuthorizationRevocation: "revoked",
    });
    const names = f.calls.map((call) => call.name);
    const apple = names.indexOf("apple");
    const revenueCat = names.indexOf("revenuecat");
    const authDelete = names.indexOf("auth_delete");
    const receipt = names.indexOf("read_account_deletion_receipt");
    const firstRead = names.indexOf("namespace_read");
    assert(apple >= 0 && revenueCat > apple && authDelete > revenueCat && receipt > authDelete);
    assert(firstRead > receipt, "namespaces are verified after the durable receipt");
    assertEquals(
      f.reads.map((read) => read.table).sort(),
      NAMESPACE_TABLES,
      "every account-owned namespace is read exactly once when empty",
    );
    for (const [table, ownerColumn, keyColumns] of OWNER_NAMESPACES) {
      const read = f.reads.find((entry) => entry.table === table)!;
      assertEquals(read.ownerColumn, ownerColumn);
      assertEquals(read.keyColumns, keyColumns);
      assertEquals(read.ownerId, OWNER);
      assertEquals(read.before, null);
      assertEquals(read.limit, PAGE_ROWS);
    }
    assertEquals(f.failures, []);
  },
);

Deno.test(
  "W08-06 worker: residue in one namespace is never reported as deleted; the failure names the table",
  async () => {
    const f = fixture();
    f.pages.set("shot_phases", [
      { data: [{ shot_id: uuid(1), phase_key: "contact" }], error: null },
      { data: [], error: null },
    ]);
    assertEquals(await f.confirm(), { outcome: "unavailable", code: "completion_unverified" });
    assertEquals(f.calls.at(-1)?.name, "fail_account_deletion_operation");
    assertEquals(f.calls.at(-1)?.parameters.p_error_code, "completion_unverified");
    assertEquals(f.failures, [
      {
        code: "completion_unverified",
        status: null,
        detail: { namespaces: [{ table: "shot_phases", outcome: "residue", rows: 1, pages: 2 }] },
      },
    ]);
    const phaseReads = f.reads.filter((read) => read.table === "shot_phases");
    assertEquals(phaseReads.length, 2);
    assertEquals(
      phaseReads[1].before,
      `shot_id.lt."${uuid(1)}",and(shot_id.eq."${uuid(1)}",phase_key.lt."contact")`,
      "the second page is keyset-paged strictly before the last row of the first",
    );
  },
);

Deno.test(
  "W08-06 worker: a full page is paged through to the empty page and every row is counted",
  async () => {
    const f = fixture();
    const full = Array.from({ length: PAGE_ROWS }, (_, i) => ({ id: uuid(PAGE_ROWS - i) }));
    f.pages.set("shots", [
      { data: full, error: null },
      { data: [{ id: uuid(PAGE_ROWS + 1) }], error: null },
      { data: [], error: null },
    ]);
    assertEquals(await f.confirm(), { outcome: "unavailable", code: "completion_unverified" });
    const shotReads = f.reads.filter((read) => read.table === "shots");
    assertEquals(shotReads.length, 3);
    assertEquals(shotReads[1].before, `id.lt."${uuid(1)}"`);
    assertEquals(shotReads[2].before, `id.lt."${uuid(PAGE_ROWS + 1)}"`);
    assertEquals(f.failures[0]?.detail, {
      namespaces: [{ table: "shots", outcome: "residue", rows: PAGE_ROWS + 1, pages: 3 }],
    });
  },
);

Deno.test(
  "W08-06 worker: a page error or a never-ending read is unread, not empty; its HTTP status is surfaced",
  async () => {
    const f = fixture();
    f.pages.set("captures", [
      { data: null, error: { message: "FAKE-private-db-outage", code: "57P01" }, status: 503 },
    ]);
    assertEquals(await f.confirm(), { outcome: "unavailable", code: "completion_unverified" });
    assertEquals(f.failures, [
      {
        code: "completion_unverified",
        status: 503,
        detail: {
          namespaces: [
            {
              table: "captures",
              outcome: "unread",
              reason: "page_error",
              code: "57P01",
              httpStatus: 503,
              pages: 1,
            },
          ],
        },
      },
    ]);
    assert(!JSON.stringify(f.calls).includes("FAKE-private"));

    const repeating = fixture();
    repeating.pages.set(
      "sessions",
      Array.from({ length: 2_000 }, () => ({ data: [{ id: uuid(7) }], error: null })),
    );
    assertEquals(await repeating.confirm(), {
      outcome: "unavailable",
      code: "completion_unverified",
    });
    assertEquals(repeating.failures[0]?.detail, {
      namespaces: [
        {
          table: "sessions",
          outcome: "unread",
          reason: "repeated_row",
          code: null,
          httpStatus: null,
          pages: 2,
        },
      ],
    });
  },
);

Deno.test(
  "W08-06 worker: an already-completed operation is re-verified before its receipt is served",
  async () => {
    const f = fixture();
    f.results.set("confirm_account_deletion_operation", {
      outcome: "completed",
      operationId: OPERATION,
      status: completed,
    });
    f.pages.set("billing_entitlements", [
      { data: [{ user_id: OWNER }], error: null },
      { data: [], error: null },
    ]);
    assertEquals(await f.confirm(), { outcome: "unavailable", code: "completion_unverified" });
    assertEquals(f.failures[0]?.detail, {
      namespaces: [{ table: "billing_entitlements", outcome: "residue", rows: 1, pages: 2 }],
    });
    assert(!f.calls.some((call) => ["apple", "revenuecat", "auth_delete"].includes(call.name)));

    const clean = fixture();
    clean.results.set("confirm_account_deletion_operation", {
      outcome: "completed",
      operationId: OPERATION,
      status: completed,
    });
    assertEquals((await clean.confirm()).outcome, "completed");
    assertEquals(clean.reads.map((read) => read.table).sort(), NAMESPACE_TABLES);
  },
);

interface RequestedDeletion {
  challenge: string;
  operationId: string;
}

async function requestedDeletion(ownerId: string): Promise<RequestedDeletion> {
  const response = await h.handler(
    userRequest("POST", "/v1/me/delete-request", {
      token: fakeSupabaseAccessToken(ownerId),
      body: {},
    }),
  );
  assertEquals(response.status, 200);
  return await response.json();
}

function confirmDeletion(ownerId: string, operation: RequestedDeletion): Promise<Response> {
  return h.handler(
    userRequest("POST", "/v1/me/delete-confirm", {
      token: fakeSupabaseAccessToken(ownerId),
      body: { challenge: operation.challenge, operationId: operation.operationId },
    }),
  );
}

const namespaceReads = (owner: string) =>
  h.calls.filter(
    (call) =>
      call.method === "GET" &&
      call.url.includes("/rest/v1/") &&
      !call.url.includes("/rest/v1/rpc/") &&
      call.url.includes(`=eq.${owner}`),
  );

Deno.test(
  "W08-06 route: delete-confirm reads every owner namespace with the service role, newest-first, 1000 rows a page, after Auth deletion",
  async () => {
    h.reset();
    const owner = crypto.randomUUID();
    h.tables.shots = [{ id: uuid(11), user_id: owner }];
    h.tables.profiles = [{ id: owner, email: "owner@relay.invalid" }];
    const operation = await requestedDeletion(owner);
    h.deletion.age(operation.operationId);
    const response = await confirmDeletion(owner, operation);
    assertEquals(response.status, 200);
    assertEquals((await response.json()).deleted, true);

    const authDelete = h.calls.findIndex(
      (call) => call.method === "DELETE" && call.url.includes("/auth/v1/admin/users/"),
    );
    assert(authDelete >= 0);
    const reads = namespaceReads(owner);
    assertEquals(
      reads.map((call) => new URL(call.url).pathname.slice("/rest/v1/".length)).sort(),
      NAMESPACE_TABLES,
    );
    for (const [table, ownerColumn, keyColumns] of OWNER_NAMESPACES) {
      const call = reads.find((entry) => new URL(entry.url).pathname.endsWith(`/${table}`))!;
      assert(h.calls.indexOf(call) > authDelete, `${table} is read after Auth deletion`);
      assertEquals(call.headers.authorization, "Bearer service-role-test-key");
      const params = new URL(call.url).searchParams;
      assertEquals(params.get(ownerColumn), `eq.${owner}`);
      assertEquals(params.get("select"), keyColumns.join(","));
      assertEquals(params.get("order"), keyColumns.map((column) => `${column}.desc`).join(","));
      assertEquals(params.get("limit"), String(PAGE_ROWS));
      assertEquals(params.get("or"), null);
    }
    assertEquals(h.tables.shots, []);
    assertEquals(h.tables.profiles, []);
  },
);

Deno.test(
  "W08-06 route: rows that survive Auth deletion make delete-confirm a 503 with a generic body, never deleted:true",
  async () => {
    h.reset();
    const owner = crypto.randomUUID();
    const operation = await requestedDeletion(owner);
    h.deletion.age(operation.operationId);
    h.respond = (call) => {
      if (call.method !== "GET" || !new URL(call.url).pathname.endsWith("/rest/v1/shots")) {
        return null;
      }
      const params = new URL(call.url).searchParams;
      if (params.get("user_id") !== `eq.${owner}`) return null;
      return Response.json(params.has("or") ? [] : [{ id: uuid(21) }]);
    };
    const { result: response, logs } = await captureConsole(() =>
      confirmDeletion(owner, operation),
    );
    assertEquals(response.status, 503);
    const body = await response.text();
    assert(!body.includes("deleted"));
    assert(!body.includes("shots"));
    const shotReads = h.calls.filter(
      (call) =>
        call.method === "GET" &&
        new URL(call.url).pathname.endsWith("/rest/v1/shots") &&
        call.url.includes(`=eq.${owner}`),
    );
    assertEquals(shotReads.length, 2);
    assertStringIncludes(
      decodeURIComponent(new URL(shotReads[1].url).search),
      `or=(id.lt."${uuid(21)}")`,
    );
    const failure = logs.find(
      (log) => log.level === "error" && String(log.args[0]).includes("Account deletion"),
    );
    assert(failure, "operator log names the failure");
    assertEquals(failure.args[1], {
      code: "completion_unverified",
      status: null,
      namespaces: [{ table: "shots", outcome: "residue", rows: 1, pages: 2 }],
    });
    assert(!JSON.stringify(logs).includes(operation.challenge));
  },
);

Deno.test(
  "W08-06 route: an unreadable namespace fails closed and stays retryable; a later clean read completes",
  async () => {
    h.reset();
    const owner = crypto.randomUUID();
    const operation = await requestedDeletion(owner);
    h.deletion.age(operation.operationId);
    h.respond = (call) =>
      call.method === "GET" &&
      new URL(call.url).pathname.endsWith("/rest/v1/player_rank_state") &&
      call.url.includes(`=eq.${owner}`)
        ? Response.json({ message: "FAKE-private-outage", code: "57P01" }, { status: 500 })
        : null;
    const { result: failed, logs } = await captureConsole(() => confirmDeletion(owner, operation));
    assertEquals(failed.status, 503);
    assert(!(await failed.text()).includes("FAKE-"));
    assertEquals(logs.find((log) => log.level === "error")?.args[1], {
      code: "completion_unverified",
      status: 500,
      namespaces: [
        {
          table: "player_rank_state",
          outcome: "unread",
          reason: "page_error",
          code: "57P01",
          httpStatus: 500,
          pages: 1,
        },
      ],
    });
    h.respond = () => null;
    h.calls = [];
    const retried = await confirmDeletion(owner, operation);
    assertEquals(retried.status, 200);
    assertEquals((await retried.json()).deleted, true);
    assertEquals(
      h.calls.filter((call) => call.method === "DELETE" && call.url.includes("/auth/v1/admin/")),
      [],
      "the retry re-verifies the completed operation without a second Auth delete",
    );
    assertEquals(
      namespaceReads(owner)
        .map((call) => new URL(call.url).pathname.slice("/rest/v1/".length))
        .sort(),
      NAMESPACE_TABLES,
    );
  },
);

Deno.test(
  "W08-06 route: the stored Apple authorization is revoked before RevenueCat, Auth and the namespace sweep",
  async () => {
    h.reset();
    const challenge = "66666666-6666-4666-8666-666666666666";
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
    const result = await response.json();
    assertEquals(result.deleted, true);
    assertEquals(result.appleAuthorizationRevocation, "revoked");
    const apple = h.calls.findIndex((call) => call.url.includes("appleid.apple.com/auth/revoke"));
    const revenueCat = h.calls.findIndex(
      (call) => call.url.startsWith(RC_URL) && call.method === "DELETE",
    );
    const authDelete = h.calls.findIndex(
      (call) => call.method === "DELETE" && call.url.includes("/auth/v1/admin/users/"),
    );
    const reads = namespaceReads(TEST_USER_ID);
    assert(apple >= 0 && revenueCat > apple && authDelete > revenueCat);
    assertEquals(reads.length, NAMESPACE_TABLES.length);
    assert(reads.every((call) => h.calls.indexOf(call) > authDelete));
  },
);

Deno.test(
  "W08-06 copy: support, privacy and terms all describe the retained free-rating record the same way",
  () => {
    const flat = (text: string) => text.replace(/\s+/g, " ");
    const support = flat(SUPPORT_TEXT);
    const privacy = flat(PRIVACY_POLICY_TEXT);
    const terms = flat(TERMS_TEXT);
    for (const text of [support, privacy, terms]) {
      assertStringIncludes(text, "same Apple or Google account");
      assert(
        /free ratings (you have |that were )?already used are not restored|does not restore free ratings that were already used/i.test(
          text,
        ),
        "each document says used free ratings are not restored by deletion",
      );
    }
    assertStringIncludes(
      support,
      "one-way hash of that sign-in identity and its scored-analysis count",
    );
    assertStringIncludes(support, "Section 7 of the Privacy Policy");
    assertStringIncludes(
      privacy,
      "one-way hash (SHA-256) of your sign-in provider's account identifier",
    );
    assertStringIncludes(privacy, "survives account deletion for that reason");
    assertStringIncludes(terms, "The free allowance is offered once per sign-in identity");
    assertStringIncludes(
      terms,
      "restore free ratings already used, or delete your Apple or Google account",
    );
    for (const text of [SUPPORT_TEXT, PRIVACY_POLICY_TEXT, TERMS_TEXT]) {
      assert(
        !/Android|Google Play|guest mode|Live Court|DUPR|SwingVision|PB Vision|Selkirk|JOOLA|\d+% accura/i.test(
          text,
        ),
      );
    }
  },
);
