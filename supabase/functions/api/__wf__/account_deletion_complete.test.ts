// W08-06 — Edge account deletion completes every owner namespace, or says so.
//
// Round-1 findings this file pins (each red on BASE_SHA 8ba4849d):
//   * a completed receipt was returned straight from the Auth-delete trigger
//     with no proof that the owner's rows were actually gone;
//   * the worker had no privilege-safe way to read client-owned tables (the
//     service role holds no SELECT grant on them), so an inventory built on
//     raw service-role reads fails closed for EVERY account;
//   * an unreadable namespace was only discovered AFTER the Auth identity was
//     deleted — at which point the deleting session is gone and nobody can
//     retry the operation.
//
// Fix under test: the worker probes every owner namespace through the actor
// the privilege model allows (owner bearer under RLS, or service role for the
// two billing/credential tables) BEFORE anything irreversible, and after the
// Auth identity is gone it pages every namespace to an EMPTY page (W07-06
// keyset pagination) before the receipt is handed out. A live-PostgreSQL
// section (XC_PG_URL, ./xc_pg_up.sh) pins the registry against the real
// grants/policies/cascades so a schema change cannot silently orphan a table.
//
//   deno test -A --no-check --config deno.json account_deletion_complete.test.ts
//   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
//     deno test -A --no-check --config deno.json account_deletion_complete.test.ts
import postgres from "postgres";
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import {
  ACCOUNT_DELETION_UNREAD_TABLES,
  ACCOUNT_OWNER_NAMESPACES,
  INVENTORY_PAGE_ROWS,
  INVENTORY_READ_ATTEMPTS,
  confirmAccountDeletionOperation,
  ownerNamespaceSelectColumns,
  probeOwnerNamespaces,
  resumeConfirmedAccountDeletionOperation,
  verifyOwnerNamespacesEmpty,
  type AccountDeletionConfirmDependencies,
  type DeletionFailureDetail,
  type DeletionOperationRpc,
  type InventoryPage,
  type OwnerNamespace,
} from "../accountDeletionOperations.ts";
import { PRIVACY_POLICY_TEXT, SUPPORT_TEXT, TERMS_TEXT } from "../legal.ts";
import { postgrestSelect } from "./postgrestStandIn.ts";

const OWNER = "08060000-0000-4000-8000-000000000001";
const OPERATION = "08060000-0000-4000-8000-000000001001";
const CHALLENGE = "08060000-0000-4000-8000-000000002001";
const LEASE = "08060000-0000-4000-8000-000000003001";
const COMPLETED_AT = "2026-09-08T00:00:00.000Z";
const completed = {
  state: "completed",
  completionReceipt: { completedAt: COMPLETED_AT },
  appleAuthorizationRevocation: "revoked",
};

type Row = Record<string, unknown>;

function namespaceOf(table: string): OwnerNamespace {
  const namespace = ACCOUNT_OWNER_NAMESPACES.find((entry) => entry.table === table);
  if (!namespace) throw new Error(`${table} is not a registered owner namespace`);
  return namespace;
}

function uuid(seq: number): string {
  return `08060000-0000-4000-8000-4${String(seq).padStart(11, "0")}`;
}

/** Owner rows keyed by table, answered like PostgREST (owner filter, keyset
 * `or` filter, descending order, limit clamped to `maxRows`). */
class FakeDatabase {
  readonly tables = new Map<string, Row[]>();
  readonly reads: Array<{ table: string; before: string | null; limit: number }> = [];
  readonly denied = new Set<string>();
  readonly failing = new Map<string, number>();
  maxRows = Number.POSITIVE_INFINITY;
  /** Rows of every table are deleted the moment the Auth identity goes. */
  cascadeOnAuthDelete = true;

  seed(table: string, rows: Row[]): void {
    this.tables.set(table, [...(this.tables.get(table) ?? []), ...rows]);
  }

  cascade(ownerId: string): void {
    for (const [table, rows] of this.tables) {
      const namespace = namespaceOf(table);
      this.tables.set(
        table,
        rows.filter((row) => row[namespace.ownerColumn] !== ownerId),
      );
    }
  }

  readPage(
    namespace: OwnerNamespace,
    ownerId: string,
    before: string | null,
    limit: number,
  ): InventoryPage<unknown> {
    this.reads.push({ table: namespace.table, before, limit });
    if (this.denied.has(namespace.table)) {
      return {
        data: null,
        error: { message: `permission denied for table ${namespace.table}`, code: "42501" },
        status: 403,
      };
    }
    const failures = this.failing.get(namespace.table) ?? 0;
    if (failures > 0) {
      this.failing.set(namespace.table, failures - 1);
      return { data: null, error: { message: "canceling statement", code: "57014" }, status: 500 };
    }
    const url = new URL("https://db.test/rest/v1/" + namespace.table);
    if (before !== null) url.searchParams.set("or", `(${before})`);
    url.searchParams.set("order", namespace.keyColumns.map((column) => `${column}.desc`).join(","));
    url.searchParams.set("limit", String(limit));
    const owned = (this.tables.get(namespace.table) ?? []).filter(
      (row) => row[namespace.ownerColumn] === ownerId,
    );
    return {
      data: postgrestSelect(url, owned, { maxRows: this.maxRows }),
      error: null,
      status: 200,
    };
  }
}

function fixture() {
  const db = new FakeDatabase();
  const calls: Array<{ name: string; parameters: Record<string, unknown> }> = [];
  const results = new Map<string, unknown>();
  const failures: Array<{ code: string; status: number | null; detail?: DeletionFailureDetail }> =
    [];
  results.set("confirm_account_deletion_operation", {
    outcome: "claimed",
    operationId: OPERATION,
    leaseToken: LEASE,
    leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    confirmedAt: new Date(Date.now() - 1_000).toISOString(),
    appleAction: "revoke",
    appleRefreshTokenEncrypted: "v1.abcdefghijklmnop.ciphertextOnlyForInjectedTests",
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
  const provider =
    (name: string) =>
    async (..._: unknown[]) => {
      calls.push({ name, parameters: {} });
    };
  const dependencies: AccountDeletionConfirmDependencies = {
    verifyLiveSession: async () => true,
    revokeAppleCredential: provider("apple"),
    deleteRevenueCatCustomer: provider("revenuecat"),
    deleteAuthUser: async (ownerId) => {
      calls.push({ name: "auth_delete", parameters: { ownerId } });
      if (db.cascadeOnAuthDelete) db.cascade(ownerId);
      return {};
    },
    readOwnerNamespacePage: (namespace, ownerId, before, limit) =>
      Promise.resolve(db.readPage(namespace, ownerId, before, limit)),
    onFailure: (code, status, detail) => failures.push({ code, status, detail }),
  };
  const confirm = () =>
    confirmAccountDeletionOperation(rpc, dependencies, OWNER, {
      challenge: CHALLENGE,
      operationId: OPERATION,
    });
  const called = (name: string) => calls.filter((call) => call.name === name).length;
  return { db, calls, results, failures, rpc, dependencies, confirm, called };
}

function seedHistory(db: FakeDatabase, ownerId: string, shots: number): void {
  db.seed("profiles", [{ id: ownerId, email: "u@example.com" }]);
  db.seed(
    "shots",
    Array.from({ length: shots }, (_, index) => ({ id: uuid(index + 1), user_id: ownerId })),
  );
  db.seed(
    "shot_phases",
    Array.from({ length: shots }, (_, index) => ({
      shot_id: uuid(index + 1),
      user_id: ownerId,
      phase_key: "contact",
    })),
  );
  db.seed("billing_entitlements", [{ user_id: ownerId, premium: false }]);
}

// ─── Registry shape ──────────────────────────────────────────────────────────

Deno.test("owner namespace registry: every account-owned table is read once, as the owner", () => {
  const tables = ACCOUNT_OWNER_NAMESPACES.map((namespace) => namespace.table);
  assertEquals(new Set(tables).size, tables.length, "duplicate namespace");
  for (const namespace of ACCOUNT_OWNER_NAMESPACES) {
    assert(namespace.keyColumns.length > 0, `${namespace.table} has no keyset`);
    assert(Object.isFrozen(namespace) && Object.isFrozen(namespace.keyColumns));
    const select = ownerNamespaceSelectColumns(namespace).split(",");
    assert(select.includes(namespace.ownerColumn), `${namespace.table} select lacks owner`);
    for (const column of namespace.keyColumns) assert(select.includes(column));
    assertEquals(new Set(select).size, select.length, `${namespace.table} select repeats`);
  }
  // Every namespace the deleting user can SELECT under RLS (`*_select_own`,
  // 20260905190106_api_only_database_access.sql); no service-role reads.
  assertEquals(tables.slice().sort(), [
    "analysis_feedback",
    "analysis_permits",
    "billing_entitlements",
    "captures",
    "consent_records",
    "evaluation_trials",
    "player_rank_state",
    "profiles",
    "sessions",
    "shot_checkpoints",
    "shot_measurements",
    "shot_phases",
    "shots",
    "user_saved_drills",
  ]);
  assertEquals(namespaceOf("profiles").ownerColumn, "id");
  for (const table of Object.keys(ACCOUNT_DELETION_UNREAD_TABLES)) {
    assert(!tables.includes(table), `${table} is both read and declared unread`);
  }
  assertEquals(ACCOUNT_DELETION_UNREAD_TABLES.free_rating_ledger, "retained");
  assertEquals(ACCOUNT_DELETION_UNREAD_TABLES.webhook_events, "retained");
  // The challenge and credential rows are fenced behind the deletion RPC
  // family (account_external_cleanup.test.ts pins zero PostgREST reads of
  // either); they leave with the auth cascade.
  assertEquals(ACCOUNT_DELETION_UNREAD_TABLES.account_deletion_requests, "rpc_owned");
  assertEquals(ACCOUNT_DELETION_UNREAD_TABLES.account_external_credentials, "rpc_owned");
  assertEquals(ACCOUNT_DELETION_UNREAD_TABLES.analysis_permit_tombstones, "cascade_only");
  assertEquals(ACCOUNT_DELETION_UNREAD_TABLES.account_deletion_feedback, "cascade_only");
});

// ─── Completion is gated by the sweep ────────────────────────────────────────

Deno.test(
  "residue in any owner namespace after Auth deletion withholds the receipt (503, never deleted:true)",
  async () => {
    for (const table of ["shots", "shot_phases", "billing_entitlements", "player_rank_state"]) {
      const h = fixture();
      seedHistory(h.db, OWNER, 3);
      h.db.seed("player_rank_state", [{ user_id: OWNER, rating: 3.1 }]);
      const namespace = namespaceOf(table);
      // the cascade "misses" this table: one row of the owner survives
      h.dependencies.deleteAuthUser = async (ownerId) => {
        h.calls.push({ name: "auth_delete", parameters: { ownerId } });
        const keep = (h.db.tables.get(table) ?? [])[0];
        h.db.cascade(ownerId);
        h.db.tables.set(table, [keep]);
        return {};
      };
      assertEquals(
        await h.confirm(),
        { outcome: "unavailable", code: "completion_unverified" },
        table,
      );
      assertEquals(h.called("auth_delete"), 1);
      assertEquals(h.called("read_account_deletion_receipt"), 1);
      const failure = h.failures.at(-1)!;
      assertEquals(failure.code, "completion_unverified");
      assertEquals(failure.detail?.stage, "completion");
      assertEquals(failure.detail?.namespaces, [{ table, outcome: "residue", rows: 1, pages: 2 }]);
      assertEquals(
        h.calls.at(-1)?.name,
        "fail_account_deletion_operation",
        "lease released with completion_unverified",
      );
      assertEquals(h.calls.at(-1)?.parameters.p_error_code, "completion_unverified");
      assertEquals(
        [...h.db.tables.keys()].every((entry) =>
          namespace.table === entry ? true : (h.db.tables.get(entry) ?? []).length === 0,
        ),
        true,
      );
    }
  },
);

Deno.test("a clean cascade completes: every namespace is paged to an empty page", async () => {
  const h = fixture();
  seedHistory(h.db, OWNER, 5);
  assertEquals(await h.confirm(), {
    outcome: "completed",
    operationId: OPERATION,
    deleted: true,
    completionReceipt: { completedAt: COMPLETED_AT },
    appleAuthorizationRevocation: "revoked",
  });
  assertEquals(h.failures, []);
  // pre-flight probe (limit 1) + one empty page per namespace after Auth deletion
  for (const namespace of ACCOUNT_OWNER_NAMESPACES) {
    const reads = h.db.reads.filter((read) => read.table === namespace.table);
    assertEquals(reads.length, 2, namespace.table);
    assertEquals(reads[0], { table: namespace.table, before: null, limit: 1 });
    assertEquals(reads[1], { table: namespace.table, before: null, limit: INVENTORY_PAGE_ROWS });
  }
  // Apple → RevenueCat → Auth ordering is untouched
  const order = h.calls
    .map((call) => call.name)
    .filter((name) =>
      ["apple", "revenuecat", "auth_delete", "read_account_deletion_receipt"].includes(name),
    );
  assertEquals(order, ["apple", "revenuecat", "auth_delete", "read_account_deletion_receipt"]);
});

Deno.test(
  "residue behind several pages is still found: a clamped page size never proves emptiness",
  async () => {
    const h = fixture();
    h.db.cascadeOnAuthDelete = false;
    h.db.maxRows = 7; // PostgREST db-max-rows below the requested page size
    h.db.seed(
      "shots",
      Array.from({ length: 20 }, (_, index) => ({ id: uuid(index + 1), user_id: OWNER })),
    );
    const verdicts = await verifyOwnerNamespacesEmpty(h.dependencies, OWNER, [
      namespaceOf("shots"),
    ]);
    assertEquals(verdicts, [{ table: "shots", outcome: "residue", rows: 20, pages: 4 }]);
    const reads = h.db.reads.filter((read) => read.table === "shots");
    assertEquals(reads.length, 4);
    assertEquals(reads[0].before, null);
    for (const read of reads.slice(1)) assertStringIncludes(read.before ?? "", "id.lt.");
    assertEquals(
      reads.every((read) => read.limit === INVENTORY_PAGE_ROWS),
      true,
    );
  },
);

Deno.test("an unreadable namespace is `unread`, never `empty`", async () => {
  const h = fixture();
  h.db.denied.add("captures");
  const verdicts = await verifyOwnerNamespacesEmpty(h.dependencies, OWNER, [
    namespaceOf("captures"),
    namespaceOf("sessions"),
  ]);
  assertEquals(verdicts, [
    {
      table: "captures",
      outcome: "unread",
      reason: "page_error",
      code: "42501",
      httpStatus: 403,
      pages: 1,
    },
    { table: "sessions", outcome: "empty", pages: 1 },
  ]);
  assertEquals(
    h.db.reads.filter((read) => read.table === "captures").length,
    INVENTORY_READ_ATTEMPTS,
  );
});

Deno.test(
  "a transient page error is retried a bounded number of times, then reported",
  async () => {
    const h = fixture();
    h.db.failing.set("sessions", INVENTORY_READ_ATTEMPTS - 1);
    assertEquals(
      await verifyOwnerNamespacesEmpty(h.dependencies, OWNER, [namespaceOf("sessions")]),
      [{ table: "sessions", outcome: "empty", pages: 1 }],
    );
    h.db.failing.set("sessions", INVENTORY_READ_ATTEMPTS);
    assertEquals(
      await verifyOwnerNamespacesEmpty(h.dependencies, OWNER, [namespaceOf("sessions")]),
      [
        {
          table: "sessions",
          outcome: "unread",
          reason: "page_error",
          code: "57014",
          httpStatus: 500,
          pages: 1,
        },
      ],
    );
  },
);

Deno.test(
  "rows the source returns for another owner, or without their keyset, are `unread`",
  async () => {
    const h = fixture();
    h.db.cascadeOnAuthDelete = false;
    const other = "08060000-0000-4000-8000-000000000002";
    h.dependencies.readOwnerNamespacePage = async (namespace) =>
      namespace.table === "shots"
        ? { data: [{ id: uuid(1), user_id: other }], error: null, status: 200 }
        : { data: [{ user_id: OWNER }], error: null, status: 200 };
    const verdicts = await verifyOwnerNamespacesEmpty(h.dependencies, OWNER, [
      namespaceOf("shots"),
      namespaceOf("sessions"),
    ]);
    assertEquals(
      verdicts.map((verdict) => [verdict.table, verdict.outcome]),
      [
        ["shots", "unread"],
        ["sessions", "unread"],
      ],
    );
    assertEquals(
      verdicts.map((verdict) => (verdict.outcome === "unread" ? verdict.reason : null)),
      ["malformed_page", "malformed_page"],
    );
  },
);

Deno.test("an owner that is not a UUID or a namespace list that is empty is refused", async () => {
  const h = fixture();
  assertEquals(await verifyOwnerNamespacesEmpty(h.dependencies, OWNER, []), []);
  await assertRejectsLike(() => verifyOwnerNamespacesEmpty(h.dependencies, "not-a-uuid"));
  await assertRejectsLike(() => probeOwnerNamespaces(h.dependencies, "not-a-uuid"));
});

async function assertRejectsLike(fn: () => Promise<unknown>): Promise<void> {
  let rejected = false;
  try {
    await fn();
  } catch {
    rejected = true;
  }
  assert(rejected, "expected rejection");
}

// ─── Pre-flight: nothing irreversible before every namespace proves readable ──

Deno.test(
  "an unreadable namespace stops the worker BEFORE Apple, RevenueCat and Auth — the session survives for the retry",
  async () => {
    const h = fixture();
    seedHistory(h.db, OWNER, 2);
    h.db.denied.add("shots"); // e.g. a grant the actor does not hold (42501)
    assertEquals(await h.confirm(), { outcome: "unavailable", code: "completion_unverified" });
    assertEquals(h.called("apple"), 0);
    assertEquals(h.called("revenuecat"), 0);
    assertEquals(h.called("set_account_deletion_auth_intent"), 0);
    assertEquals(h.called("auth_delete"), 0);
    assertEquals(h.called("read_account_deletion_receipt"), 0);
    // the lease is released with a retryable code; the owner's data is intact
    assertEquals(h.calls.at(-1)?.name, "fail_account_deletion_operation");
    assertEquals(h.calls.at(-1)?.parameters.p_error_code, "completion_unverified");
    assertEquals((h.db.tables.get("shots") ?? []).length, 2);
    assertEquals(h.failures, [
      {
        code: "completion_unverified",
        status: 403,
        detail: {
          stage: "preflight",
          namespaces: [
            {
              table: "shots",
              outcome: "unread",
              reason: "page_error",
              code: "42501",
              httpStatus: 403,
              pages: 1,
            },
          ],
        },
      },
    ]);
    // every namespace was probed with a single-row page — the probe is a
    // readability check, not an inventory
    const probes = h.db.reads.filter((read) => read.limit === 1);
    assertEquals(probes.length, ACCOUNT_OWNER_NAMESPACES.length);
    assert(probes.every((read) => read.before === null));
  },
);

Deno.test(
  "the pre-flight probe also refuses malformed rows before anything irreversible",
  async () => {
    const h = fixture();
    h.dependencies.readOwnerNamespacePage = async (namespace) =>
      namespace.table === "profiles"
        ? { data: [{ email: "u@example.com" }], error: null, status: 200 }
        : { data: [], error: null, status: 200 };
    assertEquals(await h.confirm(), { outcome: "unavailable", code: "completion_unverified" });
    assertEquals(h.called("apple"), 0);
    assertEquals(h.called("auth_delete"), 0);
    assertEquals(h.failures[0]?.detail?.stage, "preflight");
    assertEquals(
      h.failures[0]?.detail?.namespaces.map((verdict) => verdict.table),
      ["profiles"],
    );
  },
);

Deno.test(
  "the pre-flight probe runs on every claim, including a retry that resumes after Apple",
  async () => {
    const h = fixture();
    seedHistory(h.db, OWNER, 1);
    h.results.set("confirm_account_deletion_operation", {
      ...(h.results.get("confirm_account_deletion_operation") as Record<string, unknown>),
      appleCompleted: true,
      appleAction: "revoked",
      appleRefreshTokenEncrypted: null,
      revenueCatCompleted: true,
    });
    h.db.denied.add("consent_records");
    assertEquals(await h.confirm(), { outcome: "unavailable", code: "completion_unverified" });
    assertEquals(h.called("auth_delete"), 0);
    assertEquals(h.called("set_account_deletion_auth_intent"), 0);
  },
);

// ─── Already-completed claims are re-verified ────────────────────────────────

Deno.test(
  "a `completed` claim (status poll / resume) is re-verified against the namespaces before the receipt is repeated",
  async () => {
    const h = fixture();
    h.results.set("claim_account_deletion_work", {
      outcome: "completed",
      operationId: OPERATION,
      status: completed,
    });
    h.db.cascadeOnAuthDelete = false;
    h.db.seed("evaluation_trials", [{ id: uuid(9), user_id: OWNER }]);
    assertEquals(
      await resumeConfirmedAccountDeletionOperation(h.rpc, h.dependencies, OWNER, OPERATION),
      { outcome: "unavailable", code: "completion_unverified" },
    );
    assertEquals(h.failures.at(-1)?.detail, {
      stage: "completion",
      namespaces: [{ table: "evaluation_trials", outcome: "residue", rows: 1, pages: 2 }],
    });
    h.db.tables.set("evaluation_trials", []);
    assertEquals(
      await resumeConfirmedAccountDeletionOperation(h.rpc, h.dependencies, OWNER, OPERATION),
      {
        outcome: "completed",
        operationId: OPERATION,
        deleted: true,
        completionReceipt: { completedAt: COMPLETED_AT },
        appleAuthorizationRevocation: "revoked",
      },
    );
  },
);

Deno.test("diagnostics carry namespace names and counts only — never row contents", async () => {
  const h = fixture();
  h.db.cascadeOnAuthDelete = false;
  h.db.seed("profiles", [{ id: OWNER, email: "private@example.test", display_name: "SECRET" }]);
  assertEquals(await h.confirm(), { outcome: "unavailable", code: "completion_unverified" });
  const logged = JSON.stringify(h.failures);
  assert(!logged.includes("private@example.test") && !logged.includes("SECRET"));
  assertStringIncludes(logged, '"table":"profiles"');
});

// ─── Legal / support copy parity with the retained free-rating ledger ────────

Deno.test("support and terms copy match the retained free-rating ledger disclosure", () => {
  const flat = (text: string) => text.replace(/\s+/g, " ");
  const support = flat(SUPPORT_TEXT);
  assertStringIncludes(support, "does not restore free ratings that were already used");
  assertStringIncludes(
    support,
    "Only a one-way hash of that sign-in identity and its scored-analysis count is kept",
  );
  assertStringIncludes(support, "Section 7 of the Privacy Policy");
  const terms = flat(TERMS_TEXT);
  assertStringIncludes(terms, "The free allowance is offered once per sign-in identity");
  assertStringIncludes(
    terms,
    "free ratings already used are not restored by deleting the account and signing in again with the same Apple or Google account",
  );
  assertStringIncludes(
    terms,
    "restore free ratings already used, or delete your Apple or Google account",
  );
  const privacy = flat(PRIVACY_POLICY_TEXT);
  assertStringIncludes(
    privacy,
    "one-way hash (SHA-256) of your sign-in provider's account identifier",
  );
  assertStringIncludes(privacy, "survives account deletion for that reason");
  for (const text of [support, terms]) {
    for (const banned of ["Android", "Google Play", "guest mode", "Live Court", "DUPR"]) {
      assert(!text.includes(banned), banned);
    }
  }
});

// ─── Live PostgreSQL: the registry against the real privilege model ──────────

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

const PG_OWNER = "0000000a-0806-4000-8000-000000000201";
const PG_SESSION = "0000000a-0806-4000-8000-000000000301";
const PG_IDENTITY = "w0806-r2-google-sub";

async function asOwner(tx: Tx, userId: string, sessionId: string): Promise<void> {
  await tx.unsafe(`select set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', public.get_api_request_key())::text, true)`);
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
  await tx.unsafe(
    `set local request.jwt.claims = '{"sub":"${userId}","session_id":"${sessionId}"}'`,
  );
}

async function resetOwner(sql: Sql): Promise<void> {
  await sql.unsafe(
    `delete from api_private.account_deletion_operations where owner_id = '${PG_OWNER}'`,
  );
  await sql.unsafe(`delete from auth.users where id = '${PG_OWNER}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${PG_OWNER}', 'w0806r2@example.com', '{"provider":"google"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider_id, user_id, provider, identity_data) values ('${PG_IDENTITY}', '${PG_OWNER}', 'google', '{"sub":"${PG_IDENTITY}"}')`,
  );
  await sql.unsafe(
    `insert into auth.sessions (id, user_id) values ('${PG_SESSION}', '${PG_OWNER}')`,
  );
  await sql.unsafe(
    `insert into public.profiles (id, provider, email, display_name) values ('${PG_OWNER}', 'google', 'w0806r2@example.com', 'W0806R2') on conflict (id) do nothing`,
  );
}

/** Every base table in public/api_private keyed by an account: a column with a
 * foreign key to profiles(id) or auth.users(id), or an owner column with no
 * key at all (the ledger and the audit log). */
async function ownerKeyedTables(sql: Sql): Promise<Set<string>> {
  const rows = await sql.unsafe(`
    with fks as (
      select kcu.table_schema, kcu.table_name
      from information_schema.key_column_usage kcu
      join information_schema.referential_constraints rc
        on rc.constraint_name = kcu.constraint_name and rc.constraint_schema = kcu.constraint_schema
      join information_schema.constraint_column_usage ccu
        on ccu.constraint_name = rc.unique_constraint_name
       and ccu.constraint_schema = rc.unique_constraint_schema
      where (ccu.table_schema, ccu.table_name, ccu.column_name)
            in (('public', 'profiles', 'id'), ('auth', 'users', 'id'))
    ), owner_columns as (
      select table_schema, table_name from information_schema.columns
      where table_schema in ('public', 'api_private')
        and column_name in ('user_id', 'owner_id', 'app_user_id', 'identity_hash')
    )
    select distinct t.table_schema, t.table_name
    from information_schema.tables t
    where t.table_type = 'BASE TABLE' and t.table_schema in ('public', 'api_private')
      and ((t.table_schema, t.table_name) in (select * from fks)
        or (t.table_schema, t.table_name) in (select * from owner_columns))
    order by 1, 2`);
  return new Set(
    rows.map((row) =>
      row.table_schema === "public"
        ? String(row.table_name)
        : `${row.table_schema}.${row.table_name}`,
    ),
  );
}

Deno.test({
  name: "live PG: the namespace registry covers every account-keyed table, and the owner holds exactly the grant the sweep relies on",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      const keyed = await ownerKeyedTables(sql);
      const declared = new Set([
        ...ACCOUNT_OWNER_NAMESPACES.map((namespace) => namespace.table),
        ...Object.keys(ACCOUNT_DELETION_UNREAD_TABLES),
      ]);
      assertEquals([...declared].sort(), [...keyed].sort(), "registry ≠ schema");
      for (const namespace of ACCOUNT_OWNER_NAMESPACES) {
        const [priv] = await sql.unsafe(
          `select has_table_privilege('service_role', 'public.${namespace.table}', 'SELECT') as server,
                  has_table_privilege('authenticated', 'public.${namespace.table}', 'SELECT') as owner_grant,
                  exists (select 1 from pg_policies where schemaname = 'public' and tablename = '${namespace.table}'
                          and cmd = 'SELECT' and roles::text[] @> array['authenticated']) as owner_policy,
                  (select string_agg(a.attname, ',' order by k.ord)
                     from pg_index i join pg_class c on c.oid = i.indrelid
                     join pg_namespace n on n.oid = c.relnamespace
                     cross join lateral unnest(i.indkey) with ordinality as k(attnum, ord)
                     join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
                    where i.indisprimary and n.nspname = 'public' and c.relname = '${namespace.table}') as pk,
                  (select data_type from information_schema.columns where table_schema = 'public'
                     and table_name = '${namespace.table}' and column_name = '${namespace.ownerColumn}') as owner_type`,
        );
        assertEquals(priv.owner_type, "uuid", `${namespace.table}.${namespace.ownerColumn}`);
        assertEquals(priv.owner_grant, true, `${namespace.table}: authenticated SELECT`);
        assertEquals(priv.owner_policy, true, `${namespace.table}: owner SELECT policy`);
        // the service role holds SELECT on the billing row only; a raw
        // service-role sweep of the client-owned tables is 42501 (r1 finding)
        assertEquals(
          priv.server,
          namespace.table === "billing_entitlements",
          `${namespace.table}: service_role SELECT`,
        );
        // the keyset is the primary key (minus the owner column when it is
        // part of the key, since the owner filter already fixes it)
        const pk = String(priv.pk).split(",");
        const keyset = [...namespace.keyColumns];
        assertEquals(
          keyset.sort(),
          pk.length > 1 ? pk.filter((column) => column !== namespace.ownerColumn).sort() : pk,
          `${namespace.table} keyset`,
        );
      }
      for (const [table, reason] of Object.entries(ACCOUNT_DELETION_UNREAD_TABLES)) {
        const [schema, name] = table.includes(".") ? table.split(".") : ["public", table];
        const [priv] = await sql.unsafe(
          `select has_table_privilege('service_role', '${schema}.${name}', 'SELECT') as server,
                  has_table_privilege('authenticated', '${schema}.${name}', 'SELECT') as owner_grant,
                  (select string_agg(rc.delete_rule, ',')
                     from information_schema.table_constraints tc
                     join information_schema.referential_constraints rc
                       on rc.constraint_name = tc.constraint_name and rc.constraint_schema = tc.constraint_schema
                     join information_schema.constraint_column_usage ccu
                       on ccu.constraint_name = rc.unique_constraint_name
                      and ccu.constraint_schema = rc.unique_constraint_schema
                    where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = '${schema}'
                      and tc.table_name = '${name}'
                      and (ccu.table_schema, ccu.table_name, ccu.column_name)
                          in (('public', 'profiles', 'id'), ('auth', 'users', 'id'))) as account_fk`,
        );
        if (reason === "retained") {
          assertEquals(priv.account_fk, null, `${table} must not cascade with the account`);
          continue;
        }
        // the account key detaches or removes the row with the account
        assert(
          priv.account_fk === "CASCADE" || priv.account_fk === "SET NULL",
          `${table}: account FK delete rule ${priv.account_fk}`,
        );
        if (reason === "cascade_only") {
          // the deleting user cannot read it — the moment an owner grant
          // appears, this pin fails so the table moves into the read registry
          assertEquals(priv.owner_grant, false, `${table} became owner-readable`);
          assertEquals(priv.server, false, `${table}: service_role SELECT`);
        } else {
          // rpc_owned: the service role reads only the credential row, and
          // only through the fenced RPC family
          assertEquals(
            priv.server,
            table === "account_external_credentials",
            `${table}: service_role SELECT`,
          );
        }
      }
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "live PG: the owner read path stays usable after the Auth identity is deleted, every namespace cascades to empty, and the free-rating ledger survives",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      await resetOwner(sql);
      await sql.unsafe(
        `insert into public.sessions (id, user_id, kind, started_at) values
           ('0000000a-0806-4000-8000-000000000401', '${PG_OWNER}', 'practice', now())`,
      );
      await sql.unsafe(
        `insert into public.user_saved_drills (user_id, slug) values ('${PG_OWNER}', 'dink-ladder')`,
      );
      await sql.unsafe(
        `insert into public.billing_entitlements (user_id, premium, product_key, expires_at)
           values ('${PG_OWNER}', false, null, null)`,
      );
      const identityHash = (
        await sql.unsafe(`select public.free_rating_identity_hash('google', '${PG_IDENTITY}') as h`)
      )[0].h as string;
      await sql.unsafe(
        `insert into public.free_rating_ledger (identity_hash, scored_count) values ('${identityHash}', 2)
           on conflict (identity_hash) do update set scored_count = 2`,
      );
      // before deletion the owner reads its own rows (the pre-flight probe)
      const before = await sql.begin(async (tx) => {
        await asOwner(tx as unknown as Tx, PG_OWNER, PG_SESSION);
        const out: Record<string, number> = {};
        for (const namespace of ACCOUNT_OWNER_NAMESPACES) {
          const rows = await tx.unsafe(
            `select ${ownerNamespaceSelectColumns(namespace)} from public.${namespace.table}
              where ${namespace.ownerColumn} = '${PG_OWNER}' limit 1`,
          );
          out[namespace.table] = rows.length;
        }
        return out;
      });
      assertEquals(before.profiles, 1);
      assertEquals(before.sessions, 1);
      assertEquals(before.user_saved_drills, 1);
      assertEquals(before.billing_entitlements, 1);
      // the r1 sweep read these tables as service_role: denied by the grants
      const denied = await sql
        .begin(async (tx) => {
          await tx.unsafe(`set local role service_role`);
          await tx.unsafe(`select id from public.shots where user_id = '${PG_OWNER}' limit 1`);
        })
        .then(
          () => null,
          (error: unknown) => (error as { code?: string }).code ?? null,
        );
      assertEquals(denied, "42501", "service_role SELECT on shots");

      await sql.unsafe(`delete from auth.users where id = '${PG_OWNER}'`);
      const sessions = await sql.unsafe(
        `select 1 from auth.sessions where user_id = '${PG_OWNER}'`,
      );
      assertEquals(sessions.length, 0, "auth.sessions cascades with auth.users");

      // after deletion: the same owner claims still read (RLS-empty), no error
      const after = await sql.begin(async (tx) => {
        await asOwner(tx as unknown as Tx, PG_OWNER, PG_SESSION);
        const out: Record<string, number> = {};
        for (const namespace of ACCOUNT_OWNER_NAMESPACES) {
          const rows = await tx.unsafe(
            `select ${ownerNamespaceSelectColumns(namespace)} from public.${namespace.table}
              where ${namespace.ownerColumn} = '${PG_OWNER}'
              order by ${namespace.keyColumns.map((column) => `${column} desc`).join(", ")}
              limit ${INVENTORY_PAGE_ROWS}`,
          );
          out[namespace.table] = rows.length;
        }
        return out;
      });
      assertEquals(Object.keys(after).length, ACCOUNT_OWNER_NAMESPACES.length);
      for (const [table, count] of Object.entries(after)) assertEquals(count, 0, table);
      // the unread cascading tables hold nothing for the owner either (superuser view)
      for (const [table, reason] of Object.entries(ACCOUNT_DELETION_UNREAD_TABLES)) {
        if (reason === "retained") continue;
        const qualified = table.includes(".") ? table : `public.${table}`;
        const rows = await sql.unsafe(`select 1 from ${qualified} where user_id = '${PG_OWNER}'`);
        assertEquals(rows.length, 0, table);
      }
      // the ledger row is untouched — the disclosure in legal.ts is true
      const ledger = await sql.unsafe(
        `select scored_count from public.free_rating_ledger where identity_hash = '${identityHash}'`,
      );
      assertEquals(
        ledger.map((row) => Number(row.scored_count)),
        [2],
      );
      assertNotEquals(identityHash, PG_IDENTITY);
    } finally {
      await sql.end();
    }
  },
});
