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
// Round 4 (red on BASE_SHA 4cc2d69f, live-PostgreSQL section at the end): the
// worker is driven against the REAL RPCs and durable row — residue after the
// Auth delete is recorded against the retained lease and never certified,
// /delete-status stays blocked with no receipt, a clean sweep certifies exactly
// once, and certification is a service-only RPC.
//
// Round 5 (red on BASE_SHA 4cc2d69f and on the r4 candidate 750da77d): a CLEAN
// deletion stays certifiable after the Auth delete — transient post-Auth
// failures are retried in-process, a released or expired post-Auth lease is
// re-acquired under the exact owner/operation binding, a live post-Auth sweep
// reads in_progress, a 429 page honours bounded pacing, and residue or an
// unreadable namespace still never certifies.
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
  INVENTORY_RETRY_AFTER_DEFAULT_MS,
  INVENTORY_RETRY_AFTER_MAX_MS,
  POST_AUTH_VERIFY_ATTEMPTS,
  accountDeletionStatusResponse,
  beginAccountDeletionOperation,
  confirmAccountDeletionOperation,
  ownerNamespaceSelectColumns,
  parseDeletionOperationStatus,
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
import { fakeSupabaseAccessToken, loadHarness, userRequest } from "./routesHarness.ts";

const routes = await loadHarness();

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
    "offline_devices",
    "offline_grants",
    "player_rank_state",
    "profiles",
    "sessions",
    "settlement_receipts",
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
  // 20260908160000_offline_device_grants.sql: no FK, append-only, the hold
  // follows the identity hash through deletion exactly like the ledger
  assertEquals(ACCOUNT_DELETION_UNREAD_TABLES.offline_allocation_ledger, "retained");
  assertEquals(ACCOUNT_DELETION_UNREAD_TABLES.offline_allocation_identity_links, "retained");
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

// ─── The durable row is certified by the worker that verified the sweep ──────

const authAbsentUncertified = {
  state: "in_progress",
  completionReceipt: null,
  appleAuthorizationRevocation: null,
};

Deno.test(
  "durable row records Auth absence without certifying: the worker certifies only after every namespace paged to empty",
  async () => {
    const h = fixture();
    seedHistory(h.db, OWNER, 4);
    h.results.set("read_account_deletion_receipt", authAbsentUncertified);
    h.results.set("certify_account_deletion_completion", completed);
    assertEquals(await h.confirm(), {
      outcome: "completed",
      operationId: OPERATION,
      deleted: true,
      completionReceipt: { completedAt: COMPLETED_AT },
      appleAuthorizationRevocation: "revoked",
    });
    assertEquals(h.failures, []);
    assertEquals(h.called("certify_account_deletion_completion"), 1);
    const certify = h.calls.findIndex(
      (call) => call.name === "certify_account_deletion_completion",
    );
    assertEquals(h.calls[certify].parameters, {
      p_owner_id: OWNER,
      p_operation_id: OPERATION,
      p_lease_token: LEASE,
    });
    assert(certify > h.calls.findIndex((call) => call.name === "auth_delete"));
    assertEquals(h.calls.at(-1)?.name, "certify_account_deletion_completion");
    // the sweep (one empty page per namespace) is complete before certification
    for (const namespace of ACCOUNT_OWNER_NAMESPACES) {
      assertEquals(
        h.db.reads.filter((read) => read.table === namespace.table && read.limit > 1).length,
        1,
        namespace.table,
      );
    }
    assertEquals(h.called("fail_account_deletion_operation"), 0);
  },
);

Deno.test(
  "durable row records Auth absence without certifying: residue is recorded as completion_unverified and nothing certifies",
  async () => {
    const h = fixture();
    seedHistory(h.db, OWNER, 2);
    h.db.seed("player_rank_state", [{ user_id: OWNER, rating: 3.1 }]);
    h.results.set("read_account_deletion_receipt", authAbsentUncertified);
    h.results.set("certify_account_deletion_completion", completed);
    h.dependencies.deleteAuthUser = async (ownerId) => {
      h.calls.push({ name: "auth_delete", parameters: { ownerId } });
      const keep = (h.db.tables.get("player_rank_state") ?? [])[0];
      h.db.cascade(ownerId);
      h.db.tables.set("player_rank_state", [keep]);
      return {};
    };
    assertEquals(await h.confirm(), { outcome: "unavailable", code: "completion_unverified" });
    assertEquals(h.called("certify_account_deletion_completion"), 0);
    assertEquals(h.calls.at(-1)?.name, "fail_account_deletion_operation");
    assertEquals(h.calls.at(-1)?.parameters, {
      p_owner_id: OWNER,
      p_operation_id: OPERATION,
      p_lease_token: LEASE,
      p_error_code: "completion_unverified",
    });
    assertEquals(h.failures.at(-1)?.detail?.namespaces, [
      { table: "player_rank_state", outcome: "residue", rows: 1, pages: 2 },
    ]);
  },
);

Deno.test(
  "durable row records Auth absence without certifying: a certification the database refuses withholds the receipt",
  async () => {
    const h = fixture();
    seedHistory(h.db, OWNER, 1);
    h.results.set("read_account_deletion_receipt", authAbsentUncertified);
    for (const refused of [
      authAbsentUncertified,
      { state: "blocked", completionReceipt: null, appleAuthorizationRevocation: null },
      null,
    ]) {
      h.calls.length = 0;
      h.db.seed("profiles", [{ id: OWNER, email: "u@example.com" }]);
      h.results.set("certify_account_deletion_completion", refused);
      assertEquals(
        await h.confirm(),
        { outcome: "unavailable", code: "completion_unverified" },
        JSON.stringify(refused),
      );
      assertEquals(h.called("certify_account_deletion_completion"), 1);
      assertEquals(h.calls.at(-1)?.name, "fail_account_deletion_operation");
      assertEquals(h.calls.at(-1)?.parameters.p_error_code, "completion_unverified");
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

// ─── 429 pacing (round 5) ────────────────────────────────────────────────────
//
// r4 retried a 429 page INVENTORY_READ_ATTEMPTS times within 0 ms, so a paced
// source that would have answered its empty page a second later read `unread`
// and fed a completion_unverified verdict. The retry of a 429 page waits for
// the source's Retry-After when the reader relays it, else the default pacing,
// never longer than the bound; other page errors keep retrying immediately.

/** A reader that answers `pages` in order and then repeats the last one,
 * recording when each read arrived. */
function pacedReader(pages: InventoryPage<unknown>[]) {
  const reads: number[] = [];
  const reader: Pick<AccountDeletionConfirmDependencies, "readOwnerNamespacePage"> = {
    readOwnerNamespacePage(_namespace, _ownerId, _before, _limit) {
      reads.push(Date.now());
      return Promise.resolve(pages[Math.min(reads.length, pages.length) - 1]);
    },
  };
  return { reads, reader };
}

const TOO_MANY: InventoryPage<unknown> = {
  data: null,
  error: { message: "Too Many Requests", code: "PGRST429" },
  status: 429,
};
const EMPTY_PAGE: InventoryPage<unknown> = { data: [], error: null, status: 200 };

Deno.test(
  "a 429 page is retried only after the source's pacing: 429 then empty reads `empty` (never `unread`), Retry-After is honoured when relayed and bounded when absurd, and every other page error still retries at once",
  async () => {
    assert(
      INVENTORY_RETRY_AFTER_DEFAULT_MS > 0 &&
        INVENTORY_RETRY_AFTER_DEFAULT_MS <= INVENTORY_RETRY_AFTER_MAX_MS &&
        INVENTORY_RETRY_AFTER_MAX_MS * (INVENTORY_READ_ATTEMPTS - 1) < 10_000,
      "the pacing budget of one namespace stays inside the confirm deadline",
    );
    // no Retry-After relayed: the default pacing separates the reads
    {
      const { reads, reader } = pacedReader([TOO_MANY, EMPTY_PAGE]);
      const verdicts = await verifyOwnerNamespacesEmpty(reader, OWNER, [namespaceOf("shots")]);
      assertEquals(verdicts, [{ table: "shots", outcome: "empty", pages: 1 }]);
      assertEquals(reads.length, 2, "one paced retry");
      assert(
        reads[1] - reads[0] >= INVENTORY_RETRY_AFTER_DEFAULT_MS - 5,
        `retry after ${reads[1] - reads[0]} ms`,
      );
    }
    // a Retry-After relayed by the reader is honoured
    {
      const { reads, reader } = pacedReader([{ ...TOO_MANY, retryAfterMs: 400 }, EMPTY_PAGE]);
      const verdicts = await verifyOwnerNamespacesEmpty(reader, OWNER, [namespaceOf("shots")]);
      assertEquals(verdicts, [{ table: "shots", outcome: "empty", pages: 1 }]);
      assertEquals(reads.length, 2);
      assert(reads[1] - reads[0] >= 395, `retry after ${reads[1] - reads[0]} ms`);
      assert(
        reads[1] - reads[0] < INVENTORY_RETRY_AFTER_DEFAULT_MS,
        "a shorter Retry-After is not padded to the default",
      );
    }
    // an absurd Retry-After is bounded — the sweep never parks on one namespace
    {
      const { reads, reader } = pacedReader([{ ...TOO_MANY, retryAfterMs: 3_600_000 }, EMPTY_PAGE]);
      const startedAt = Date.now();
      const verdicts = await verifyOwnerNamespacesEmpty(reader, OWNER, [namespaceOf("shots")]);
      assertEquals(verdicts, [{ table: "shots", outcome: "empty", pages: 1 }]);
      assertEquals(reads.length, 2);
      const waited = Date.now() - startedAt;
      assert(waited < INVENTORY_RETRY_AFTER_MAX_MS + 500, `waited ${waited} ms`);
      assert(reads[1] - reads[0] >= INVENTORY_RETRY_AFTER_MAX_MS - 5);
    }
    // a source that stays paced is reported `unread` with its 429 after the bounded budget
    {
      const { reads, reader } = pacedReader([TOO_MANY]);
      const verdicts = await verifyOwnerNamespacesEmpty(reader, OWNER, [namespaceOf("shots")]);
      assertEquals(verdicts, [
        {
          table: "shots",
          outcome: "unread",
          reason: "page_error",
          code: "PGRST429",
          httpStatus: 429,
          pages: 1,
        },
      ]);
      assertEquals(reads.length, INVENTORY_READ_ATTEMPTS);
    }
    // a non-429 page error keeps the immediate retry
    {
      const h = fixture();
      h.db.failing.set("sessions", INVENTORY_READ_ATTEMPTS - 1);
      const startedAt = Date.now();
      assertEquals(
        await verifyOwnerNamespacesEmpty(h.dependencies, OWNER, [namespaceOf("sessions")]),
        [{ table: "sessions", outcome: "empty", pages: 1 }],
      );
      assert(Date.now() - startedAt < INVENTORY_RETRY_AFTER_DEFAULT_MS, "no pacing for a 500");
      assertEquals(h.db.reads.length, INVENTORY_READ_ATTEMPTS);
    }
  },
);

// ─── Wire-level retry budget through the shipping route ──────────────────────

/** The app's confirm transport deadline (deletionOperationTransport.ts
 * default `timeoutMs`); the server must answer, either way, inside it. */
const MOBILE_CONFIRM_TIMEOUT_MS = 15_000;

Deno.test(
  "route: a namespace answering a bare 503 after Auth deletion costs exactly INVENTORY_READ_ATTEMPTS wire reads (no SDK retries underneath) and the 503 reply comes back inside the app deadline",
  async () => {
    routes.reset();
    const owner = crypto.randomUUID();
    const requested = await routes.handler(
      userRequest("POST", "/v1/me/delete-request", {
        token: fakeSupabaseAccessToken(owner),
        body: {},
      }),
    );
    assertEquals(requested.status, 200);
    const { challenge, operationId } = await requested.json();
    routes.deletion.age(operationId);
    let authDeleted = false;
    const degradedReads: number[] = [];
    routes.respond = (call) => {
      if (call.method === "DELETE" && call.url.includes("/auth/v1/admin/users/")) {
        authDeleted = true;
        return null;
      }
      if (
        authDeleted &&
        call.method === "GET" &&
        new URL(call.url).pathname === "/rest/v1/consent_records"
      ) {
        degradedReads.push(Date.now());
        return new Response("FAKE-upstream-unavailable", { status: 503 });
      }
      return null;
    };
    const startedAt = Date.now();
    const response = await routes.handler(
      userRequest("POST", "/v1/me/delete-confirm", {
        token: fakeSupabaseAccessToken(owner),
        body: { challenge, operationId },
      }),
    );
    const elapsedMs = Date.now() - startedAt;
    routes.respond = () => null;
    assertEquals(response.status, 503);
    const body = await response.text();
    assert(!body.includes("FAKE-"), "upstream detail leaked");
    assert(!body.includes("deleted"), body);
    assert(!body.includes("completionReceipt"), body);
    assertEquals(authDeleted, true, "the sweep runs after the Auth identity is gone");
    assertEquals(
      degradedReads.length,
      INVENTORY_READ_ATTEMPTS,
      `${degradedReads.length} wire reads of the degraded namespace`,
    );
    assert(
      elapsedMs <= MOBILE_CONFIRM_TIMEOUT_MS,
      `confirm reply held ${elapsedMs} ms (app deadline ${MOBILE_CONFIRM_TIMEOUT_MS} ms)`,
    );
    // every other namespace was paged once to its empty page — no retries
    const afterAuth = routes.calls.slice(
      routes.calls.findIndex(
        (call) => call.method === "DELETE" && call.url.includes("/auth/v1/admin/users/"),
      ),
    );
    for (const namespace of ACCOUNT_OWNER_NAMESPACES) {
      if (namespace.table === "consent_records") continue;
      assertEquals(
        afterAuth.filter(
          (call) =>
            call.method === "GET" && new URL(call.url).pathname === `/rest/v1/${namespace.table}`,
        ).length,
        1,
        namespace.table,
      );
    }
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

Deno.test(
  "Privacy §7 discloses what every `retained` table keeps after deletion, and for how long",
  () => {
    const flat = (text: string) => text.replace(/\s+/g, " ");
    const privacy = flat(PRIVACY_POLICY_TEXT);
    const start = privacy.indexOf("7. RETENTION");
    const end = privacy.indexOf("8. ACCOUNT DELETION");
    assert(start >= 0 && end > start, "Privacy §7 not found");
    const section7 = privacy.slice(start, end);
    // one §7 statement per table the worker classifies as surviving deletion
    const disclosed: Record<string, readonly RegExp[]> = {
      free_rating_ledger: [
        /one-way hash \(SHA-256\)[^.]*sign-in provider's account identifier/,
        /survives account deletion/,
      ],
      webhook_events: [/webhook audit records are scheduled for deletion after 90 days/],
      "api_private.account_deletion_operations": [
        // how long: 7 days after the request; what: the internal account
        // identifier, step timestamps, external cleanup outcomes, error codes
        /deletion (record|operation)[^.]*(7|seven) days/i,
        /internal account identifier[^.]*timestamps[^.]*outcome[^.]*error codes/i,
        /cannot be used to restore the account/,
      ],
      offline_allocation_ledger: [
        /append-only offline allocation record/,
        /internal account identifier, device and grant identifiers, the allocation ticket identifier, an installation key identifier/,
        /allocated, consumed for one scored analysis, or released/,
        /survives account deletion so that the allocation follows the sign-in identity/,
      ],
      offline_allocation_identity_links: [
        /one-way \(SHA-256\) sign-in identity hashes as the free-rating record/,
      ],
      "api_private.billing_transfer_sides": [
        /purchase transfer reconciliation record: the transfer identifier, the internal account identifier of each account involved, RevenueCat's verified entitlement answer/,
        /not removed when one of those accounts is deleted/,
      ],
      "api_private.billing_transfer_audit": [
        /append-only audit trail of each reconciliation step with timestamps/,
        /is not automatically deleted/,
      ],
    };
    const retained = Object.entries(ACCOUNT_DELETION_UNREAD_TABLES)
      .filter(([, reason]) => reason === "retained")
      .map(([table]) => table)
      .sort();
    assertEquals(retained, Object.keys(disclosed).sort(), "retained tables ≠ disclosed tables");
    for (const table of retained) {
      for (const pattern of disclosed[table]) {
        assert(pattern.test(section7), `Privacy §7 does not disclose ${table}: ${pattern}`);
      }
    }
    // the deletion record is described honestly: no personal data beyond the
    // account identifier, and it is restricted to service administration
    assertStringIncludes(section7, "does not contain your email address");
    for (const banned of ["Android", "Google Play", "guest mode", "Live Court", "DUPR"]) {
      assert(!privacy.includes(banned), banned);
    }
  },
);

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
      await sql.unsafe(
        `insert into public.offline_devices (id, user_id, installation_key_id, attestation_environment, attestation_state, attested_at)
           values ('0000000a-0806-4000-8000-000000000501', '${PG_OWNER}', 'ik-0806', 'development', 'attested', now())`,
      );
      await sql.unsafe(
        `insert into public.offline_grants (user_id, device_id, entitlement_source, generation, issued_at, expires_at)
           values ('${PG_OWNER}', '0000000a-0806-4000-8000-000000000501', 'identity_lifetime_free', 1, now(), now() + interval '1 day')`,
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
      assertEquals(before.offline_devices, 1);
      assertEquals(before.offline_grants, 1);
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

// ─── Live PostgreSQL: the durable row after the Auth delete (round 4) ────────
//
// The auth.users AFTER DELETE trigger used to seal completed_at/phase and clear
// the worker's lease in the identity's own transaction — a receipt existed
// before anyone had looked at a single owner table, and a worker that then
// found residue could not record it (fail_… answered stale_lease) while
// /delete-status handed the receipt out. These tests drive the SHIPPING worker
// (confirmAccountDeletionOperation → real RPCs over the disposable database,
// owner reads answered as the owner under RLS) and pin the durable contract:
// Auth absence is recorded WITHOUT certifying, residue is recorded against the
// retained lease and stays blocked with no receipt, and a clean sweep
// certifies exactly once.

const R4_OWNER = "0000000a-0806-4000-8000-000000000202";
const R4_SESSION = "0000000a-0806-4000-8000-000000000302";
const R4_IDENTITY = "w0806-r4-google-sub";
const R4_RESIDUE_SHOT = "0000000a-0806-4000-8000-000000000602";
const BLOCKED_NO_RECEIPT = {
  state: "blocked",
  completionReceipt: null,
  appleAuthorizationRevocation: null,
};

interface WireCall {
  name: string;
  parameters: Record<string, unknown>;
  data: unknown;
  error: { message: string; code: string | null } | null;
}

/** A `\x…` hex bytea literal as the Edge sends it over PostgREST, as bytes for
 * the driver (which would otherwise encode the literal's characters). */
function wireValue(value: unknown): string | Uint8Array | null {
  if (typeof value === "string" && /^\\x(?:[0-9a-f]{2})+$/.test(value)) {
    return Uint8Array.from(value.slice(2).match(/../g)!, (pair) => parseInt(pair, 16));
  }
  return value as string | null;
}

/** The PostgREST RPC surface answered by the database itself: every call is one
 * service_role transaction of `select public.<fn>(name => $n, …)`, a SQL error
 * becomes `{ data: null, error }` exactly like a failed PostgREST call. */
function wireRpc(sql: Sql, calls: WireCall[]): DeletionOperationRpc {
  return async (name, parameters) => {
    const keys = Object.keys(parameters);
    const query = `select public.${name}(${keys.map((key, index) => `${key} => $${index + 1}`).join(", ")}) as data`;
    try {
      const rows = await sql.begin(async (tx) => {
        await tx.unsafe(`set local role service_role`);
        return await tx.unsafe(
          query,
          keys.map((key) => wireValue(parameters[key])),
        );
      });
      const data = (rows as unknown as Row[])[0]?.data ?? null;
      calls.push({ name, parameters, data, error: null });
      return { data, error: null, status: 200 };
    } catch (thrown) {
      const error = {
        message: String((thrown as Error).message),
        code: (thrown as { code?: string }).code ?? null,
      };
      calls.push({ name, parameters, data: null, error });
      return { data: null, error, status: 500 };
    }
  };
}

/** Owner page reads answered by the database as the owner (RLS), plus the
 * residue a test injects for a table whose cascade "missed" — the only way to
 * observe rows after the Auth delete without altering the schema under test. */
function wireOwnerReader(
  sql: Sql,
  residue: () => ReadonlyMap<string, Row[]>,
  denied: () => ReadonlySet<string> = () => new Set(),
): AccountDeletionConfirmDependencies["readOwnerNamespacePage"] {
  return async (namespace, ownerId, before, limit) => {
    if (denied().has(namespace.table)) {
      return {
        data: null,
        error: { message: `permission denied for table ${namespace.table}`, code: "42501" },
        status: 403,
      };
    }
    const injected = residue().get(namespace.table);
    if (injected) {
      const url = new URL("https://db.test/rest/v1/" + namespace.table);
      if (before !== null) url.searchParams.set("or", `(${before})`);
      url.searchParams.set(
        "order",
        namespace.keyColumns.map((column) => `${column}.desc`).join(","),
      );
      url.searchParams.set("limit", String(limit));
      return { data: postgrestSelect(url, injected), error: null, status: 200 };
    }
    if (before !== null) {
      return {
        data: null,
        error: { message: "keyset page after an owner row was not expected here" },
        status: 500,
      };
    }
    try {
      const rows = await sql.begin(async (tx) => {
        await asOwner(tx as unknown as Tx, ownerId, R4_SESSION);
        return await tx.unsafe(
          `select ${ownerNamespaceSelectColumns(namespace)} from public.${namespace.table}
            where ${namespace.ownerColumn} = $1
            order by ${namespace.keyColumns.map((column) => `${column} desc`).join(", ")}
            limit ${limit}`,
          [ownerId],
        );
      });
      return { data: [...(rows as unknown as Row[])], error: null, status: 200 };
    } catch (thrown) {
      return {
        data: null,
        error: {
          message: String((thrown as Error).message),
          code: (thrown as { code?: string }).code,
        },
        status: 500,
      };
    }
  };
}

interface DurableRow {
  phase: string;
  confirmed_at: Date | null;
  auth_deleted_at: Date | null;
  completed_at: Date | null;
  lease_token: string | null;
  lease_expires_at: Date | null;
  attempts: number;
  last_error_code: string | null;
}

async function durableRow(sql: Sql, operationId: string): Promise<DurableRow> {
  const rows = await sql.unsafe(
    `select phase, confirmed_at, auth_deleted_at, completed_at, lease_token, lease_expires_at,
            attempts, last_error_code
       from api_private.account_deletion_operations where id = $1`,
    [operationId],
  );
  assertEquals(rows.length, 1, "durable operation row");
  return rows[0] as unknown as DurableRow;
}

/** A fresh R4 owner with history in several namespaces and a requested,
 * confirmable deletion operation (the request is aged past the 3 s fence). */
async function r4Begin(sql: Sql, rpc: DeletionOperationRpc) {
  await sql.unsafe(
    `delete from api_private.account_deletion_operations where owner_id = '${R4_OWNER}'`,
  );
  await sql.unsafe(`delete from auth.users where id = '${R4_OWNER}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${R4_OWNER}', 'w0806r4@example.com', '{"provider":"google"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider_id, user_id, provider, identity_data) values ('${R4_IDENTITY}', '${R4_OWNER}', 'google', '{"sub":"${R4_IDENTITY}"}')`,
  );
  await sql.unsafe(
    `insert into auth.sessions (id, user_id) values ('${R4_SESSION}', '${R4_OWNER}')`,
  );
  await sql.unsafe(
    `insert into public.profiles (id, provider, email, display_name) values ('${R4_OWNER}', 'google', 'w0806r4@example.com', 'W0806R4') on conflict (id) do nothing`,
  );
  await sql.unsafe(
    `insert into public.sessions (id, user_id, kind, started_at) values
       ('0000000a-0806-4000-8000-000000000402', '${R4_OWNER}', 'practice', now())`,
  );
  await sql.unsafe(
    `insert into public.user_saved_drills (user_id, slug) values ('${R4_OWNER}', 'dink-ladder')`,
  );
  await sql.unsafe(
    `insert into public.billing_entitlements (user_id, premium, product_key, expires_at)
       values ('${R4_OWNER}', false, null, null)`,
  );
  await sql.unsafe(
    `insert into public.free_rating_ledger (identity_hash, scored_count)
       values (public.free_rating_identity_hash('google', '${R4_IDENTITY}'), 2)
       on conflict (identity_hash) do update set scored_count = 2`,
  );
  const begun = await beginAccountDeletionOperation(rpc, R4_OWNER);
  assertEquals(begun.outcome, "requested");
  if (begun.outcome !== "requested") throw new Error("unreachable");
  await sql.unsafe(
    `update api_private.account_deletion_operations
        set created_at = created_at - interval '10 seconds',
            challenge_expires_at = challenge_expires_at - interval '10 seconds',
            status_expires_at = status_expires_at - interval '10 seconds',
            retain_until = retain_until - interval '10 seconds'
      where id = $1`,
    [begun.operationId],
  );
  return begun;
}

function r4Dependencies(
  sql: Sql,
  calls: WireCall[],
  residueAfterAuthDelete: ReadonlyMap<string, Row[]>,
  options: {
    /** Namespaces the owner read path denies after the Auth delete. */
    deniedAfterAuthDelete?: ReadonlySet<string>;
    /** The identity IS deleted server-side, but the admin response never
     * reaches the worker (network) — once. */
    loseAuthDeleteResponse?: boolean;
  } = {},
): AccountDeletionConfirmDependencies {
  let authDeleted = false;
  let lost = false;
  const empty = new Map<string, Row[]>();
  return {
    verifyLiveSession: async () => true,
    revokeAppleCredential: async () => {
      throw new Error("a Google-only owner has no Apple credential to revoke");
    },
    deleteRevenueCatCustomer: async () => {
      calls.push({ name: "revenuecat_delete", parameters: {}, data: null, error: null });
    },
    deleteAuthUser: async (ownerId) => {
      // Supabase Auth admin deleteUser: the auth.users row goes, the AFTER
      // DELETE trigger records the absence in the same transaction.
      await sql.unsafe(`delete from auth.users where id = $1`, [ownerId]);
      authDeleted = true;
      calls.push({ name: "auth_delete", parameters: { ownerId }, data: null, error: null });
      if (options.loseAuthDeleteResponse && !lost) {
        lost = true;
        throw new Error("FAKE network: the deleteUser response was lost");
      }
      return {};
    },
    readOwnerNamespacePage: wireOwnerReader(
      sql,
      () => (authDeleted ? residueAfterAuthDelete : empty),
      () => (authDeleted ? (options.deniedAfterAuthDelete ?? new Set()) : new Set()),
    ),
  };
}

/** A certification attempt made directly by the service, outside any worker
 * (a spent, forged, cross-owner or expired lease): answered by the database
 * like every RPC but NOT recorded in the worker's call log, so the log counts
 * only the certifications the worker itself performed. */
function certifyDirect(sql: Sql, parameters: Record<string, unknown>) {
  return wireRpc(sql, [])("certify_account_deletion_completion", parameters);
}

/** `faults` are transport failures of the RPC surface: `drop` throws before
 * the database sees the call, `lose` lets the database run it and then throws
 * (the response never arrives). Each fault fires `times` times. */
function faultyRpc(
  rpc: DeletionOperationRpc,
  faults: Array<{ name: string; mode: "drop" | "lose"; times: number }>,
): DeletionOperationRpc {
  return async (name, parameters) => {
    const fault = faults.find((entry) => entry.name === name && entry.times > 0);
    if (!fault) return await rpc(name, parameters);
    fault.times -= 1;
    if (fault.mode === "drop")
      throw new Error(`FAKE transport: ${name} never reached the database`);
    await rpc(name, parameters);
    throw new Error(`FAKE transport: the ${name} response was lost`);
  };
}

/** The whole free-rating ledger, byte for byte. */
async function ledgerSnapshot(sql: Sql): Promise<string> {
  const rows = await sql.unsafe(
    `select to_jsonb(l) as row from public.free_rating_ledger l order by identity_hash`,
  );
  return JSON.stringify(rows.map((row) => row.row));
}

async function deleteStatusRoute(
  rpc: DeletionOperationRpc,
  operationId: string,
  statusCapability: string,
): Promise<{ status: number; body: unknown }> {
  const response = await accountDeletionStatusResponse(
    rpc,
    new Request("https://edge.test/v1/account/delete-status", {
      method: "POST",
      headers: { Authorization: `Bearer ${statusCapability}`, "content-type": "application/json" },
    }),
    { operationId },
  );
  return { status: response.status, body: await response.json() };
}

Deno.test({
  name: "live PG: residue after the Auth delete never yields a completion receipt — the durable row stays blocked without a receipt, /delete-status is honest, and nothing can certify afterwards",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      const calls: WireCall[] = [];
      const rpc = wireRpc(sql, calls);
      const begun = await r4Begin(sql, rpc);
      const residue = new Map<string, Row[]>([
        ["shots", [{ id: R4_RESIDUE_SHOT, user_id: R4_OWNER }]],
      ]);
      const dependencies = r4Dependencies(sql, calls, residue);
      const result = await confirmAccountDeletionOperation(rpc, dependencies, R4_OWNER, {
        challenge: begun.challenge,
        operationId: begun.operationId,
      });
      assertEquals(result, { outcome: "unavailable", code: "completion_unverified" });
      // the identity is gone; the deleting worker held exactly one lease
      assertEquals(
        (await sql.unsafe(`select 1 from auth.users where id = '${R4_OWNER}'`)).length,
        0,
      );
      const claim = calls.find((call) => call.name === "confirm_account_deletion_operation");
      const lease = (claim?.data as Row | undefined)?.leaseToken;
      assert(typeof lease === "string", "the confirm claimed a lease");
      assertEquals(calls.filter((call) => call.name === "auth_delete").length, 1);
      // the verdict was RECORDED against the retained lease — the database
      // accepted completion_unverified after the Auth delete (BASE: stale_lease)
      const failed = calls.filter((call) => call.name === "fail_account_deletion_operation");
      assertEquals(failed.length, 1);
      assertEquals(failed[0].parameters, {
        p_owner_id: R4_OWNER,
        p_operation_id: begun.operationId,
        p_lease_token: lease,
        p_error_code: "completion_unverified",
      });
      assertEquals(failed[0].data, { outcome: "released" });
      assertEquals(
        calls.filter((call) => call.name === "certify_account_deletion_completion").length,
        0,
      );
      // durable row: Auth absence recorded, NOT certified, lease released with the verdict
      const row = await durableRow(sql, begun.operationId);
      assert(row.auth_deleted_at !== null, "auth_deleted_at");
      assertEquals(row.completed_at, null);
      assertEquals(row.phase, "auth_delete_intent");
      assertEquals(row.lease_token, null);
      assertEquals(row.last_error_code, "completion_unverified");
      // /delete-status through the shipping route: blocked, no receipt
      assertEquals(await deleteStatusRoute(rpc, begun.operationId, begun.statusCapability), {
        status: 200,
        body: BLOCKED_NO_RECEIPT,
      });
      // the owner receipt read says the same
      assertEquals(
        (
          await rpc("read_account_deletion_receipt", {
            p_owner_id: R4_OWNER,
            p_operation_id: begun.operationId,
          })
        ).data,
        BLOCKED_NO_RECEIPT,
      );
      // nobody can certify after the verdict: the released lease, a forged
      // token and another owner are all refused and the row does not move
      for (const attempt of [
        { p_owner_id: R4_OWNER, p_operation_id: begun.operationId, p_lease_token: lease },
        {
          p_owner_id: R4_OWNER,
          p_operation_id: begun.operationId,
          p_lease_token: crypto.randomUUID(),
        },
        { p_owner_id: PG_OWNER, p_operation_id: begun.operationId, p_lease_token: lease },
      ]) {
        const certify = await certifyDirect(sql, attempt);
        assertEquals(certify.error, null, "certify RPC exists and is callable by the service");
        assertEquals(certify.data, { outcome: "stale_lease" });
      }
      assertEquals(await durableRow(sql, begun.operationId), row);
      assertEquals(await deleteStatusRoute(rpc, begun.operationId, begun.statusCapability), {
        status: 200,
        body: BLOCKED_NO_RECEIPT,
      });
      // a later worker re-acquires the post-Auth phase (round 5) — and while
      // the residue is still there it is found again: no receipt, verdict
      // recorded again, nothing certified, the row blocked without a receipt
      const beforeRetry = calls.length;
      assertEquals(
        await resumeConfirmedAccountDeletionOperation(
          rpc,
          dependencies,
          R4_OWNER,
          begun.operationId,
        ),
        { outcome: "unavailable", code: "completion_unverified" },
      );
      const retry = calls.slice(beforeRetry);
      assertEquals(retry[0].name, "claim_account_deletion_work");
      assertEquals((retry[0].data as Row).outcome, "claimed");
      assertEquals((retry[0].data as Row).authDeleted, true);
      assertNotEquals((retry[0].data as Row).leaseToken, lease);
      assertEquals(
        retry.map((call) => call.name).filter((name) => name !== "read_account_deletion_receipt"),
        ["claim_account_deletion_work", "fail_account_deletion_operation"],
        "no Apple/RevenueCat/Auth step is repeated after the Auth delete",
      );
      assertEquals(retry.at(-1)?.data, { outcome: "released" });
      assertEquals(
        calls.filter((call) => call.name === "certify_account_deletion_completion").length,
        0,
      );
      const retried = await durableRow(sql, begun.operationId);
      assertEquals(retried, { ...row, attempts: row.attempts + 1 });
      assertEquals(await deleteStatusRoute(rpc, begun.operationId, begun.statusCapability), {
        status: 200,
        body: BLOCKED_NO_RECEIPT,
      });
      // the cascade catches up (the residue is gone): the next sweep is clean
      // and certifies exactly once
      residue.delete("shots");
      const ledgerBefore = await ledgerSnapshot(sql);
      const recovered = await resumeConfirmedAccountDeletionOperation(
        rpc,
        dependencies,
        R4_OWNER,
        begun.operationId,
      );
      assertEquals(recovered.outcome, "completed");
      if (recovered.outcome !== "completed") throw new Error("unreachable");
      assertEquals(
        calls.filter((call) => call.name === "certify_account_deletion_completion").length,
        1,
      );
      assertEquals(calls.filter((call) => call.name === "auth_delete").length, 1);
      assertEquals(calls.filter((call) => call.name === "revenuecat_delete").length, 1);
      const certified = await durableRow(sql, begun.operationId);
      assertEquals(certified.phase, "completed");
      assertEquals(certified.lease_token, null);
      assertEquals(certified.last_error_code, null);
      assert(certified.completed_at !== null && retried.auth_deleted_at !== null);
      assert(certified.completed_at.getTime() > retried.auth_deleted_at.getTime());
      assertEquals(await deleteStatusRoute(rpc, begun.operationId, begun.statusCapability), {
        status: 200,
        body: {
          state: "completed",
          completionReceipt: { completedAt: recovered.completionReceipt.completedAt },
          appleAuthorizationRevocation: "not_applicable",
        },
      });
      assertEquals(await ledgerSnapshot(sql), ledgerBefore, "free-rating ledger untouched");
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "live PG: a clean post-Auth sweep certifies completion exactly once, after the Auth delete, and the receipt is then durable and idempotent",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      const calls: WireCall[] = [];
      const rpc = wireRpc(sql, calls);
      const begun = await r4Begin(sql, rpc);
      const dependencies = r4Dependencies(sql, calls, new Map());
      const result = await confirmAccountDeletionOperation(rpc, dependencies, R4_OWNER, {
        challenge: begun.challenge,
        operationId: begun.operationId,
      });
      assertEquals(result.outcome, "completed");
      if (result.outcome !== "completed") throw new Error("unreachable");
      assertEquals(result.operationId, begun.operationId);
      assertEquals(result.appleAuthorizationRevocation, "not_applicable");
      // certified exactly once, by the worker, AFTER the Auth delete and the sweep
      const certifications = calls.filter(
        (call) => call.name === "certify_account_deletion_completion",
      );
      assertEquals(certifications.length, 1);
      assert(
        calls.indexOf(certifications[0]) > calls.findIndex((call) => call.name === "auth_delete"),
      );
      assertEquals(certifications[0].error, null);
      assertEquals(parseDeletionOperationStatus(certifications[0].data)?.state, "completed");
      assertEquals(
        calls.filter((call) => call.name === "fail_account_deletion_operation").length,
        0,
      );
      const row = await durableRow(sql, begun.operationId);
      assertEquals(row.phase, "completed");
      assertEquals(row.lease_token, null);
      assertEquals(row.last_error_code, null);
      assert(row.auth_deleted_at !== null && row.completed_at !== null);
      // the receipt is the certification, not the identity delete
      assert(
        row.completed_at.getTime() > row.auth_deleted_at.getTime(),
        "completed_at must follow auth_deleted_at — the trigger must not seal the receipt",
      );
      assertEquals(
        new Date(result.completionReceipt.completedAt).getTime(),
        row.completed_at.getTime(),
      );
      // /delete-status hands out the certified receipt and nothing else
      assertEquals(await deleteStatusRoute(rpc, begun.operationId, begun.statusCapability), {
        status: 200,
        body: {
          state: "completed",
          completionReceipt: { completedAt: result.completionReceipt.completedAt },
          appleAuthorizationRevocation: "not_applicable",
        },
      });
      // exactly once: the spent lease cannot certify again and the receipt does not move
      const lease = (
        calls.find((call) => call.name === "confirm_account_deletion_operation")?.data as Row
      ).leaseToken;
      assertEquals(
        (
          await certifyDirect(sql, {
            p_owner_id: R4_OWNER,
            p_operation_id: begun.operationId,
            p_lease_token: lease,
          })
        ).data,
        { outcome: "stale_lease" },
      );
      assertEquals(await durableRow(sql, begun.operationId), row);
      // a resumed worker reads the certified receipt, re-verifies emptiness and certifies nothing
      const beforeResume = calls.length;
      const resumed = await resumeConfirmedAccountDeletionOperation(
        rpc,
        dependencies,
        R4_OWNER,
        begun.operationId,
      );
      assertEquals(resumed, result);
      assertEquals(
        calls.slice(beforeResume).map((call) => call.name),
        ["claim_account_deletion_work"],
      );
      assertEquals(await durableRow(sql, begun.operationId), row);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "live PG: certification is a hardened service-only RPC — no anon/authenticated/PUBLIC execute, definer with an empty search_path, and the private lock helper is not callable",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      const [fn] = await sql.unsafe(`
        select p.prosecdef, p.proconfig,
               has_function_privilege('service_role', p.oid, 'EXECUTE') as service,
               has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
               has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
               exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                        where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_execute
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'certify_account_deletion_completion'
           and pg_get_function_identity_arguments(p.oid) = 'p_owner_id uuid, p_operation_id uuid, p_lease_token uuid'`);
      assert(
        fn !== undefined,
        "public.certify_account_deletion_completion(uuid, uuid, uuid) exists",
      );
      assertEquals(fn.prosecdef, true);
      assert((fn.proconfig as string[]).includes('search_path=""'));
      assertEquals(fn.service, true);
      assertEquals(fn.anon, false);
      assertEquals(fn.authenticated, false);
      assertEquals(fn.public_execute, false);
      for (const role of ["anon", "authenticated"]) {
        const denied = await sql
          .begin(async (tx) => {
            await tx.unsafe(`set local role ${role}`);
            await tx.unsafe(
              `select public.certify_account_deletion_completion('${R4_OWNER}', '${R4_OWNER}', '${R4_OWNER}')`,
            );
          })
          .then(
            () => null,
            (error: unknown) => (error as { code?: string }).code ?? null,
          );
        assertEquals(denied, "42501", `${role} cannot certify`);
      }
      const helper = await sql
        .begin(async (tx) => {
          await tx.unsafe(`set local role service_role`);
          await tx.unsafe(
            `select api_private.lock_account_deletion_certification('${R4_OWNER}', '${R4_OWNER}', '${R4_OWNER}')`,
          );
        })
        .then(
          () => null,
          (error: unknown) => (error as { code?: string }).code ?? null,
        );
      assertEquals(helper, "42501", "service cannot reach the private certification lock directly");
    } finally {
      await sql.end();
    }
  },
});

// ─── Live PostgreSQL: recovery after the Auth delete (round 5) ───────────────
//
// r4 certified only through the lease the trigger retained, and nothing could
// re-acquire the post-Auth phase: one transient failure after the Auth delete
// (a receipt read that did not answer, a worker that died, a deleteUser
// response that never arrived) recorded completion_unverified or let the lease
// expire, and from then on claim → blocked, certify → stale_lease and
// /delete-status → blocked for an account that no longer exists — while a
// LIVE post-Auth sweep was reported as blocked too. These tests drive the
// shipping worker against the real RPCs and pin the recovery contract.

const IN_PROGRESS_NO_RECEIPT = {
  state: "in_progress",
  completionReceipt: null,
  appleAuthorizationRevocation: null,
};

function completedBody(completedAt: string) {
  return {
    state: "completed",
    completionReceipt: { completedAt },
    appleAuthorizationRevocation: "not_applicable",
  };
}

/** Everything the worker did after the Auth delete had to be idempotent
 * recovery: no second Apple/RevenueCat/Auth call, no checkpoint, one receipt. */
function assertRecoveryOnly(calls: WireCall[], from: number): void {
  const names = calls.slice(from).map((call) => call.name);
  for (const forbidden of [
    "revenuecat_delete",
    "auth_delete",
    "checkpoint_account_deletion_operation",
    "set_account_deletion_auth_intent",
  ]) {
    assertEquals(names.includes(forbidden), false, `${forbidden} repeated after the Auth delete`);
  }
}

Deno.test({
  name: "live PG: one transient failure of the post-Auth receipt read stays retryable in-process — the clean sweep certifies exactly once and /delete-status reports completed with the receipt",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      const calls: WireCall[] = [];
      const wire = wireRpc(sql, calls);
      const rpc = faultyRpc(wire, [
        { name: "read_account_deletion_receipt", mode: "drop", times: 1 },
      ]);
      const begun = await r4Begin(sql, wire);
      const ledgerBefore = await ledgerSnapshot(sql);
      const dependencies = r4Dependencies(sql, calls, new Map());
      const result = await confirmAccountDeletionOperation(rpc, dependencies, R4_OWNER, {
        challenge: begun.challenge,
        operationId: begun.operationId,
      });
      assertEquals(result.outcome, "completed");
      if (result.outcome !== "completed") throw new Error("unreachable");
      assertEquals(calls.filter((call) => call.name === "auth_delete").length, 1);
      assertEquals(calls.filter((call) => call.name === "revenuecat_delete").length, 1);
      assertEquals(
        calls.filter((call) => call.name === "fail_account_deletion_operation").length,
        0,
        "a transient post-Auth failure records no verdict",
      );
      assertEquals(
        calls.filter((call) => call.name === "certify_account_deletion_completion").length,
        1,
      );
      const row = await durableRow(sql, begun.operationId);
      assertEquals(row.phase, "completed");
      assertEquals(row.lease_token, null);
      assertEquals(row.last_error_code, null);
      assertEquals(row.attempts, 1, "the retained lease was kept, not re-acquired");
      assertEquals(await deleteStatusRoute(rpc, begun.operationId, begun.statusCapability), {
        status: 200,
        body: completedBody(result.completionReceipt.completedAt),
      });
      assertEquals(await ledgerSnapshot(sql), ledgerBefore, "free-rating ledger untouched");
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "live PG: a certification whose response is lost is not repeated — the retry reads the receipt the database already sealed, exactly one certification exists",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      const calls: WireCall[] = [];
      const wire = wireRpc(sql, calls);
      const rpc = faultyRpc(wire, [
        { name: "certify_account_deletion_completion", mode: "lose", times: 1 },
      ]);
      const begun = await r4Begin(sql, wire);
      const dependencies = r4Dependencies(sql, calls, new Map());
      const result = await confirmAccountDeletionOperation(rpc, dependencies, R4_OWNER, {
        challenge: begun.challenge,
        operationId: begun.operationId,
      });
      assertEquals(result.outcome, "completed");
      if (result.outcome !== "completed") throw new Error("unreachable");
      const certifications = calls.filter(
        (call) => call.name === "certify_account_deletion_completion",
      );
      assertEquals(certifications.length, 1, "the database certified exactly once");
      assertEquals(parseDeletionOperationStatus(certifications[0].data)?.state, "completed");
      assertEquals(
        calls.filter((call) => call.name === "fail_account_deletion_operation").length,
        0,
      );
      const row = await durableRow(sql, begun.operationId);
      assertEquals(row.phase, "completed");
      assert(row.completed_at !== null);
      assertEquals(
        new Date(result.completionReceipt.completedAt).getTime(),
        row.completed_at.getTime(),
      );
      assertEquals(await deleteStatusRoute(rpc, begun.operationId, begun.statusCapability), {
        status: 200,
        body: completedBody(result.completionReceipt.completedAt),
      });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "live PG: when the post-Auth storage keeps failing the verdict is recorded and released, /delete-status is honest (blocked, no receipt), and a later worker re-acquires the phase and certifies exactly once",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      const calls: WireCall[] = [];
      const wire = wireRpc(sql, calls);
      const rpc = faultyRpc(wire, [
        {
          name: "read_account_deletion_receipt",
          mode: "drop",
          times: POST_AUTH_VERIFY_ATTEMPTS,
        },
      ]);
      const begun = await r4Begin(sql, wire);
      const ledgerBefore = await ledgerSnapshot(sql);
      const dependencies = r4Dependencies(sql, calls, new Map());
      const first = await confirmAccountDeletionOperation(rpc, dependencies, R4_OWNER, {
        challenge: begun.challenge,
        operationId: begun.operationId,
      });
      assertEquals(first, { outcome: "unavailable", code: "completion_unverified" });
      const lease = (
        calls.find((call) => call.name === "confirm_account_deletion_operation")?.data as Row
      ).leaseToken as string;
      const failed = calls.filter((call) => call.name === "fail_account_deletion_operation");
      assertEquals(failed.length, 1);
      assertEquals(failed[0].data, { outcome: "released" });
      assertEquals(
        calls.filter((call) => call.name === "certify_account_deletion_completion").length,
        0,
      );
      const row = await durableRow(sql, begun.operationId);
      assert(row.auth_deleted_at !== null);
      assertEquals(row.completed_at, null);
      assertEquals(row.phase, "auth_delete_intent");
      assertEquals(row.lease_token, null);
      assertEquals(row.last_error_code, "completion_unverified");
      assertEquals(await deleteStatusRoute(wire, begun.operationId, begun.statusCapability), {
        status: 200,
        body: BLOCKED_NO_RECEIPT,
      });
      // the spent lease certifies nothing
      assertEquals(
        (
          await certifyDirect(sql, {
            p_owner_id: R4_OWNER,
            p_operation_id: begun.operationId,
            p_lease_token: lease,
          })
        ).data,
        { outcome: "stale_lease" },
      );
      // recovery: a worker with the operation binding re-acquires the phase
      const beforeResume = calls.length;
      const resumed = await resumeConfirmedAccountDeletionOperation(
        wire,
        dependencies,
        R4_OWNER,
        begun.operationId,
      );
      assertEquals(resumed.outcome, "completed");
      if (resumed.outcome !== "completed") throw new Error("unreachable");
      assertEquals(resumed.operationId, begun.operationId);
      assertEquals(resumed.appleAuthorizationRevocation, "not_applicable");
      const claim = calls[beforeResume];
      assertEquals(claim.name, "claim_account_deletion_work");
      const claimed = claim.data as Row;
      assertEquals(claimed.outcome, "claimed");
      assertEquals(claimed.authDeleted, true);
      assertEquals(claimed.appleCompleted, true);
      assertEquals(claimed.revenueCatCompleted, true);
      assertNotEquals(claimed.leaseToken, lease, "a fresh lease, not the spent one");
      assertRecoveryOnly(calls, beforeResume);
      assertEquals(
        calls.filter((call) => call.name === "certify_account_deletion_completion").length,
        1,
      );
      const certified = await durableRow(sql, begun.operationId);
      assertEquals(certified.phase, "completed");
      assertEquals(certified.lease_token, null);
      assertEquals(certified.last_error_code, null);
      assertEquals(certified.attempts, 2);
      assert(certified.completed_at !== null && row.auth_deleted_at !== null);
      assert(certified.completed_at.getTime() > row.auth_deleted_at.getTime());
      assertEquals(await deleteStatusRoute(wire, begun.operationId, begun.statusCapability), {
        status: 200,
        body: completedBody(resumed.completionReceipt.completedAt),
      });
      // exactly once: neither lease certifies again, a further resume only reads
      for (const token of [lease, claimed.leaseToken as string]) {
        assertEquals(
          (
            await certifyDirect(sql, {
              p_owner_id: R4_OWNER,
              p_operation_id: begun.operationId,
              p_lease_token: token,
            })
          ).data,
          { outcome: "stale_lease" },
        );
      }
      const beforeSecond = calls.length;
      assertEquals(
        await resumeConfirmedAccountDeletionOperation(
          wire,
          dependencies,
          R4_OWNER,
          begun.operationId,
        ),
        resumed,
      );
      assertEquals(
        calls.slice(beforeSecond).map((call) => call.name),
        ["claim_account_deletion_work"],
      );
      assertEquals(await durableRow(sql, begun.operationId), certified);
      assertEquals(await ledgerSnapshot(sql), ledgerBefore, "free-rating ledger untouched");
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "live PG: worker death after the Auth delete — the retained lease reads in_progress while live and is busy to others, once expired it is re-acquired under the exact owner/operation binding and certifies exactly once; forged, cross-owner, cross-operation and expired leases never certify",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      const calls: WireCall[] = [];
      const wire = wireRpc(sql, calls);
      // the identity is deleted, then the process dies: the verdict RPC never
      // reaches the database and the retained lease stays on the row
      const rpc = faultyRpc(wire, [
        { name: "fail_account_deletion_operation", mode: "drop", times: 1 },
      ]);
      const begun = await r4Begin(sql, wire);
      const ledgerBefore = await ledgerSnapshot(sql);
      const dependencies = r4Dependencies(sql, calls, new Map(), {
        loseAuthDeleteResponse: true,
      });
      const first = await confirmAccountDeletionOperation(rpc, dependencies, R4_OWNER, {
        challenge: begun.challenge,
        operationId: begun.operationId,
      });
      assertEquals(first, { outcome: "unavailable", code: "auth_delete_unavailable" });
      const lease = (
        calls.find((call) => call.name === "confirm_account_deletion_operation")?.data as Row
      ).leaseToken as string;
      assertEquals(
        (await sql.unsafe(`select 1 from auth.users where id = '${R4_OWNER}'`)).length,
        0,
      );
      const row = await durableRow(sql, begun.operationId);
      assert(row.auth_deleted_at !== null);
      assertEquals(row.completed_at, null);
      assertEquals(row.phase, "auth_delete_intent");
      assertEquals(row.lease_token, lease, "the trigger retained the worker's lease");
      assertEquals(row.last_error_code, null);
      assert(row.lease_expires_at !== null && row.lease_expires_at.getTime() > Date.now());
      // a LIVE post-Auth lease is work in flight, not a declined deletion
      assertEquals(await deleteStatusRoute(wire, begun.operationId, begun.statusCapability), {
        status: 200,
        body: IN_PROGRESS_NO_RECEIPT,
      });
      const beforeBusy = calls.length;
      assertEquals(
        await resumeConfirmedAccountDeletionOperation(
          wire,
          dependencies,
          R4_OWNER,
          begun.operationId,
        ),
        { outcome: "in_progress", operationId: begun.operationId },
      );
      assertEquals(
        calls.slice(beforeBusy).map((call) => call.name),
        ["claim_account_deletion_work"],
      );
      // isolation: the binding is exact
      const foreign = crypto.randomUUID();
      assertEquals(
        (
          await wire("claim_account_deletion_work", {
            p_owner_id: PG_OWNER,
            p_operation_id: begun.operationId,
          })
        ).data,
        { outcome: "invalid" },
        "another owner cannot claim the operation",
      );
      assertEquals(
        (
          await wire("claim_account_deletion_work", {
            p_owner_id: R4_OWNER,
            p_operation_id: foreign,
          })
        ).data,
        { outcome: "invalid" },
        "another operation id cannot claim the owner's phase",
      );
      for (const attempt of [
        { p_owner_id: R4_OWNER, p_operation_id: begun.operationId, p_lease_token: foreign },
        { p_owner_id: PG_OWNER, p_operation_id: begun.operationId, p_lease_token: lease },
        { p_owner_id: R4_OWNER, p_operation_id: foreign, p_lease_token: lease },
      ]) {
        assertEquals((await certifyDirect(sql, attempt)).data, { outcome: "stale_lease" });
      }
      assertEquals(await durableRow(sql, begun.operationId), row);
      // the lease expires with nobody alive to renew it
      await sql.unsafe(
        `update api_private.account_deletion_operations
            set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1`,
        [begun.operationId],
      );
      assertEquals(
        (
          await certifyDirect(sql, {
            p_owner_id: R4_OWNER,
            p_operation_id: begun.operationId,
            p_lease_token: lease,
          })
        ).data,
        { outcome: "stale_lease" },
        "an expired lease certifies nothing",
      );
      // no verdict was recorded: the phase is still recoverable, not blocked
      assertEquals(await deleteStatusRoute(wire, begun.operationId, begun.statusCapability), {
        status: 200,
        body: IN_PROGRESS_NO_RECEIPT,
      });
      const beforeResume = calls.length;
      const resumed = await resumeConfirmedAccountDeletionOperation(
        wire,
        dependencies,
        R4_OWNER,
        begun.operationId,
      );
      assertEquals(resumed.outcome, "completed");
      if (resumed.outcome !== "completed") throw new Error("unreachable");
      const claimed = calls[beforeResume].data as Row;
      assertEquals(calls[beforeResume].name, "claim_account_deletion_work");
      assertEquals(claimed.outcome, "claimed");
      assertEquals(claimed.authDeleted, true);
      assertNotEquals(claimed.leaseToken, lease);
      assertRecoveryOnly(calls, beforeResume);
      assertEquals(calls.filter((call) => call.name === "auth_delete").length, 1);
      assertEquals(
        calls.filter((call) => call.name === "certify_account_deletion_completion").length,
        1,
      );
      const certified = await durableRow(sql, begun.operationId);
      assertEquals(certified.phase, "completed");
      assertEquals(certified.lease_token, null);
      assertEquals(certified.attempts, 2);
      assert(certified.completed_at !== null);
      assert(certified.completed_at.getTime() > row.auth_deleted_at.getTime());
      assertEquals(await deleteStatusRoute(wire, begun.operationId, begun.statusCapability), {
        status: 200,
        body: completedBody(resumed.completionReceipt.completedAt),
      });
      for (const token of [lease, claimed.leaseToken as string]) {
        assertEquals(
          (
            await certifyDirect(sql, {
              p_owner_id: R4_OWNER,
              p_operation_id: begun.operationId,
              p_lease_token: token,
            })
          ).data,
          { outcome: "stale_lease" },
        );
      }
      assertEquals(await durableRow(sql, begun.operationId), certified);
      assertEquals(await ledgerSnapshot(sql), ledgerBefore, "free-rating ledger untouched");
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "live PG: a lost deleteUser response is recorded against the retained post-Auth lease and released; the app's retried confirm re-acquires the phase without a second RevenueCat or Auth call and certifies exactly once",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      const calls: WireCall[] = [];
      const rpc = wireRpc(sql, calls);
      const begun = await r4Begin(sql, rpc);
      const ledgerBefore = await ledgerSnapshot(sql);
      const dependencies = r4Dependencies(sql, calls, new Map(), {
        loseAuthDeleteResponse: true,
      });
      const first = await confirmAccountDeletionOperation(rpc, dependencies, R4_OWNER, {
        challenge: begun.challenge,
        operationId: begun.operationId,
      });
      assertEquals(first, { outcome: "unavailable", code: "auth_delete_unavailable" });
      const lease = (
        calls.find((call) => call.name === "confirm_account_deletion_operation")?.data as Row
      ).leaseToken as string;
      const failed = calls.filter((call) => call.name === "fail_account_deletion_operation");
      assertEquals(failed.length, 1);
      assertEquals(failed[0].parameters.p_error_code, "auth_delete_unavailable");
      assertEquals(failed[0].parameters.p_lease_token, lease);
      assertEquals(failed[0].data, { outcome: "released" }, "recorded against the retained lease");
      const row = await durableRow(sql, begun.operationId);
      assert(row.auth_deleted_at !== null);
      assertEquals(row.completed_at, null);
      assertEquals(row.lease_token, null);
      assertEquals(row.last_error_code, "auth_delete_unavailable");
      assertEquals(await deleteStatusRoute(rpc, begun.operationId, begun.statusCapability), {
        status: 200,
        body: BLOCKED_NO_RECEIPT,
      });
      // the app retries the confirm with the same challenge (its session is
      // still cached): the confirm RPC re-acquires the post-Auth phase
      const beforeRetry = calls.length;
      const retried = await confirmAccountDeletionOperation(rpc, dependencies, R4_OWNER, {
        challenge: begun.challenge,
        operationId: begun.operationId,
      });
      assertEquals(retried.outcome, "completed");
      if (retried.outcome !== "completed") throw new Error("unreachable");
      const claimed = calls[beforeRetry].data as Row;
      assertEquals(calls[beforeRetry].name, "confirm_account_deletion_operation");
      assertEquals(claimed.outcome, "claimed");
      assertEquals(claimed.authDeleted, true);
      assertNotEquals(claimed.leaseToken, lease);
      assertRecoveryOnly(calls, beforeRetry);
      assertEquals(calls.filter((call) => call.name === "auth_delete").length, 1);
      assertEquals(calls.filter((call) => call.name === "revenuecat_delete").length, 1);
      assertEquals(
        calls.filter((call) => call.name === "certify_account_deletion_completion").length,
        1,
      );
      const certified = await durableRow(sql, begun.operationId);
      assertEquals(certified.phase, "completed");
      assertEquals(certified.last_error_code, null);
      assertEquals(certified.attempts, 2);
      assertEquals(await deleteStatusRoute(rpc, begun.operationId, begun.statusCapability), {
        status: 200,
        body: completedBody(retried.completionReceipt.completedAt),
      });
      assertEquals(await ledgerSnapshot(sql), ledgerBefore, "free-rating ledger untouched");
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "live PG: an unreadable namespace after the Auth delete never yields a receipt — completion_unverified is recorded, the row stays blocked without a receipt, and only a later complete clean sweep certifies (exactly once)",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      const calls: WireCall[] = [];
      const rpc = wireRpc(sql, calls);
      const begun = await r4Begin(sql, rpc);
      const denied = new Set<string>(["captures"]);
      const dependencies = r4Dependencies(sql, calls, new Map(), {
        deniedAfterAuthDelete: denied,
      });
      const first = await confirmAccountDeletionOperation(rpc, dependencies, R4_OWNER, {
        challenge: begun.challenge,
        operationId: begun.operationId,
      });
      assertEquals(first, { outcome: "unavailable", code: "completion_unverified" });
      assertEquals(
        calls.filter((call) => call.name === "certify_account_deletion_completion").length,
        0,
      );
      const failed = calls.filter((call) => call.name === "fail_account_deletion_operation");
      assertEquals(failed.length, 1);
      assertEquals(failed[0].data, { outcome: "released" });
      const row = await durableRow(sql, begun.operationId);
      assert(row.auth_deleted_at !== null);
      assertEquals(row.completed_at, null);
      assertEquals(row.lease_token, null);
      assertEquals(row.last_error_code, "completion_unverified");
      assertEquals(await deleteStatusRoute(rpc, begun.operationId, begun.statusCapability), {
        status: 200,
        body: BLOCKED_NO_RECEIPT,
      });
      // still unreadable on the retry: still no receipt
      assertEquals(
        await resumeConfirmedAccountDeletionOperation(
          rpc,
          dependencies,
          R4_OWNER,
          begun.operationId,
        ),
        { outcome: "unavailable", code: "completion_unverified" },
      );
      assertEquals(
        calls.filter((call) => call.name === "certify_account_deletion_completion").length,
        0,
      );
      assertEquals(await deleteStatusRoute(rpc, begun.operationId, begun.statusCapability), {
        status: 200,
        body: BLOCKED_NO_RECEIPT,
      });
      // the read path recovers: the complete clean sweep certifies once
      denied.clear();
      const recovered = await resumeConfirmedAccountDeletionOperation(
        rpc,
        dependencies,
        R4_OWNER,
        begun.operationId,
      );
      assertEquals(recovered.outcome, "completed");
      if (recovered.outcome !== "completed") throw new Error("unreachable");
      assertEquals(
        calls.filter((call) => call.name === "certify_account_deletion_completion").length,
        1,
      );
      assertEquals((await durableRow(sql, begun.operationId)).phase, "completed");
      assertEquals(await deleteStatusRoute(rpc, begun.operationId, begun.statusCapability), {
        status: 200,
        body: completedBody(recovered.completionReceipt.completedAt),
      });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "live PG: post-Auth recovery honours the retry budget and the identity binding — an exhausted operation or a recreated identity is blocked, never certified",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      const calls: WireCall[] = [];
      const wire = wireRpc(sql, calls);
      const rpc = faultyRpc(wire, [
        { name: "fail_account_deletion_operation", mode: "drop", times: 1 },
      ]);
      const begun = await r4Begin(sql, wire);
      const dependencies = r4Dependencies(sql, calls, new Map(), {
        loseAuthDeleteResponse: true,
      });
      assertEquals(
        await confirmAccountDeletionOperation(rpc, dependencies, R4_OWNER, {
          challenge: begun.challenge,
          operationId: begun.operationId,
        }),
        { outcome: "unavailable", code: "auth_delete_unavailable" },
      );
      await sql.unsafe(
        `update api_private.account_deletion_operations
            set lease_expires_at = clock_timestamp() - interval '1 second', attempts = 8
          where id = $1`,
        [begun.operationId],
      );
      assertEquals(
        (
          await wire("claim_account_deletion_work", {
            p_owner_id: R4_OWNER,
            p_operation_id: begun.operationId,
          })
        ).data,
        { outcome: "blocked" },
        "the retry budget is spent",
      );
      assertEquals(await deleteStatusRoute(wire, begun.operationId, begun.statusCapability), {
        status: 200,
        body: BLOCKED_NO_RECEIPT,
      });
      // budget restored, but the identity is back under the same id: not the
      // deletion this operation certifies
      await sql.unsafe(
        `update api_private.account_deletion_operations set attempts = 1 where id = $1`,
        [begun.operationId],
      );
      await sql.unsafe(
        `insert into auth.users (id, email, raw_app_meta_data) values ('${R4_OWNER}', 'w0806r4@example.com', '{"provider":"google"}')`,
      );
      assertEquals(
        (
          await wire("claim_account_deletion_work", {
            p_owner_id: R4_OWNER,
            p_operation_id: begun.operationId,
          })
        ).data,
        { outcome: "blocked" },
      );
      assertEquals(
        (
          await certifyDirect(sql, {
            p_owner_id: R4_OWNER,
            p_operation_id: begun.operationId,
            p_lease_token: (
              calls.find((call) => call.name === "confirm_account_deletion_operation")?.data as Row
            ).leaseToken,
          })
        ).data,
        { outcome: "stale_lease" },
      );
      const row = await durableRow(sql, begun.operationId);
      assertEquals(row.completed_at, null);
      assertEquals(row.phase, "auth_delete_intent");
      assertEquals(
        calls.filter((call) => call.name === "certify_account_deletion_completion").length,
        0,
        "no worker certified anything; the direct attempt above was refused",
      );
    } finally {
      await sql.end();
    }
  },
});

// ─── Round 6: recovery reachable from a shipping surface without the owner ───
//
// After the Auth delete the deleting session is gone (auth.sessions cascades
// from auth.users), so the owner's own retry of POST /v1/me/delete-confirm is
// refused by the route's `is_api_session_active()` check and /delete-status
// never resumes work. The database therefore owns recovery:
// `public.sweep_account_deletion_operations(limit)` (service-only, pg_cron)
// re-acquires every post-Auth phase whose lease is not live and certifies it —
// and `certify_account_deletion_completion` itself refuses a receipt while any
// account-keyed table still holds rows of the owner, so a cascade that missed
// a table is a `residue` verdict, never a receipt, whichever caller certifies.

const R6_MIGRATION = "20260909230000_account_deletion_service_sweep.sql";
const R6_MIGRATIONS_DIR = new URL("../../../migrations/", import.meta.url);

Deno.test(
  "static pin: the service sweep migration exists, is service-only, counts every owner namespace the worker pages, and none of the retained-by-policy ledgers",
  async () => {
    const source = await Deno.readTextFile(new URL(R6_MIGRATION, R6_MIGRATIONS_DIR));
    for (const namespace of ACCOUNT_OWNER_NAMESPACES) {
      assertStringIncludes(
        source,
        `from public.${namespace.table} where ${namespace.ownerColumn} = p_owner_id`,
        `${namespace.table} is not counted as owner residue`,
      );
    }
    for (const [table, reason] of Object.entries(ACCOUNT_DELETION_UNREAD_TABLES)) {
      const qualified = table.includes(".") ? table : `public.${table}`;
      const counted = source.includes(`from ${qualified} where user_id = p_owner_id`);
      assertEquals(
        counted,
        reason !== "retained",
        `${table} (${reason}) ${reason === "retained" ? "must never be" : "must be"} counted as residue`,
      );
    }
    assertStringIncludes(source, "create function public.sweep_account_deletion_operations(");
    assertStringIncludes(
      source,
      "revoke all on function public.sweep_account_deletion_operations(integer)\n  from public, anon, authenticated, service_role;",
    );
    assertStringIncludes(
      source,
      "grant execute on function public.sweep_account_deletion_operations(integer)\n  to service_role;",
    );
    assertStringIncludes(source, "cron.schedule('sweep-account-deletion-operations'");
    assertStringIncludes(source, "select public.sweep_account_deletion_operations(50)");
    assertStringIncludes(
      source,
      "'residue'",
      "certification answers a residue verdict instead of a receipt",
    );
  },
);

Deno.test(
  "a `residue` verdict from certification never becomes a receipt — the worker records completion_unverified with the database's namespace counts and certifies nothing again",
  async () => {
    const h = fixture();
    seedHistory(h.db, OWNER, 2);
    h.results.set("read_account_deletion_receipt", IN_PROGRESS_NO_RECEIPT);
    h.results.set("certify_account_deletion_completion", {
      outcome: "residue",
      namespaces: [{ table: "account_deletion_feedback", rows: 3 }],
    });
    assertEquals(await h.confirm(), { outcome: "unavailable", code: "completion_unverified" });
    assertEquals(h.called("auth_delete"), 1);
    assertEquals(h.called("certify_account_deletion_completion"), 1);
    assertEquals(h.called("fail_account_deletion_operation"), 1);
    assertEquals(
      h.calls.find((call) => call.name === "fail_account_deletion_operation")?.parameters
        .p_error_code,
      "completion_unverified",
    );
    assertEquals(h.failures, [
      {
        code: "completion_unverified",
        status: null,
        detail: {
          stage: "completion",
          namespaces: [
            { table: "account_deletion_feedback", outcome: "residue", rows: 3, pages: 0 },
          ],
        },
      },
    ]);
  },
);

Deno.test(
  "a lease the database no longer honours because the service sweep already certified — the worker reads the sealed receipt back, records no verdict, and never certifies twice",
  async () => {
    const h = fixture();
    seedHistory(h.db, OWNER, 1);
    let receiptReads = 0;
    const rpc: DeletionOperationRpc = (name, parameters) => {
      if (name === "read_account_deletion_receipt") {
        receiptReads += 1;
        // the first read (before this worker's certify) shows in-progress; the
        // sweep certifies in between, so the retry read finds the receipt
        h.results.set(
          "read_account_deletion_receipt",
          receiptReads === 1 ? IN_PROGRESS_NO_RECEIPT : completed,
        );
      }
      return h.rpc(name, parameters);
    };
    h.results.set("certify_account_deletion_completion", { outcome: "stale_lease" });
    const result = await confirmAccountDeletionOperation(rpc, h.dependencies, OWNER, {
      challenge: CHALLENGE,
      operationId: OPERATION,
    });
    assertEquals(result, {
      outcome: "completed",
      operationId: OPERATION,
      deleted: true,
      completionReceipt: { completedAt: COMPLETED_AT },
      appleAuthorizationRevocation: "revoked",
    });
    assertEquals(h.called("certify_account_deletion_completion"), 1);
    assertEquals(h.called("fail_account_deletion_operation"), 0);
    assertEquals(h.failures, []);
  },
);

/** The confirm route's own session check, as `index.ts` wires it: the deleting
 * owner's `select public.is_api_session_active()` — false once the Auth
 * delete has cascaded the session away. */
function shippingSessionCheck(sql: Sql): AccountDeletionConfirmDependencies["verifyLiveSession"] {
  return async (ownerId) => {
    if (ownerId !== R4_OWNER) return false;
    const rows = await sql.begin(async (tx) => {
      await asOwner(tx as unknown as Tx, ownerId, R4_SESSION);
      return await tx.unsafe(`select public.is_api_session_active() as live`);
    });
    const live = (rows as unknown as Row[])[0]?.live;
    if (typeof live !== "boolean") throw new Error("Session check unavailable.");
    return live;
  };
}

async function assertCompletedStatus(
  wire: DeletionOperationRpc,
  begun: { operationId: string; statusCapability: string },
  completedAt: Date,
): Promise<void> {
  const status = await deleteStatusRoute(wire, begun.operationId, begun.statusCapability);
  assertEquals(status.status, 200);
  const body = status.body as Row;
  assertEquals(body.state, "completed");
  assertEquals(body.appleAuthorizationRevocation, "not_applicable");
  assertEquals(
    new Date((body.completionReceipt as Row).completedAt as string).getTime(),
    completedAt.getTime(),
  );
}

/** Exactly `count` orphaned feedback rows of the R4 owner — rows a cascade
 * "missed", written past the table's FK and append-only triggers as the
 * superuser (no FK path can produce them otherwise): the exact shape of a
 * durable-residue failure after the Auth delete. */
async function orphanedFeedbackRows(sql: Sql, count: number): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe(`alter table public.account_deletion_feedback disable trigger all`);
    await tx.unsafe(`delete from public.account_deletion_feedback where user_id = '${R4_OWNER}'`);
    for (let index = 0; index < count; index += 1) {
      await tx.unsafe(
        `insert into public.account_deletion_feedback (user_id, reason) values ('${R4_OWNER}', 'other')`,
      );
    }
    await tx.unsafe(`alter table public.account_deletion_feedback enable trigger all`);
  });
}

interface SweepReport {
  scanned: number;
  claimed: number;
  certified: number;
  residue: number;
  skipped: number;
  failed: number;
  operations: Array<Record<string, unknown>>;
}

async function sweep(wire: DeletionOperationRpc): Promise<SweepReport> {
  const result = await wire("sweep_account_deletion_operations", { p_limit: 50 });
  assertEquals(result.error, null, "the sweep RPC failed");
  return result.data as SweepReport;
}

async function sweepAs(sql: Sql, role: string): Promise<string | null> {
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`);
      await tx.unsafe(`select public.sweep_account_deletion_operations(50)`);
    });
    return null;
  } catch (thrown) {
    return (thrown as { code?: string }).code ?? "unknown";
  }
}

Deno.test({
  name: "live PG: worker death after the Auth delete — the owner's retry is refused by the SHIPPING session check (no claim), the service sweep skips the live lease, re-acquires it once expired and certifies exactly once, a second sweep is idle, /delete-status reports completed",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      const calls: WireCall[] = [];
      const wire = wireRpc(sql, calls);
      const rpc = faultyRpc(wire, [
        { name: "fail_account_deletion_operation", mode: "drop", times: 1 },
      ]);
      const begun = await r4Begin(sql, wire);
      const ledgerBefore = await ledgerSnapshot(sql);
      const dependencies: AccountDeletionConfirmDependencies = {
        ...r4Dependencies(sql, calls, new Map(), { loseAuthDeleteResponse: true }),
        verifyLiveSession: shippingSessionCheck(sql),
      };
      const first = await confirmAccountDeletionOperation(rpc, dependencies, R4_OWNER, {
        challenge: begun.challenge,
        operationId: begun.operationId,
      });
      assertEquals(first, { outcome: "unavailable", code: "auth_delete_unavailable" });
      const afterDeath = calls.length;
      assertEquals((await durableRow(sql, begun.operationId)).completed_at, null);

      // D2: the app retries the confirm; the shipping route re-runs the
      // session check as the deleted owner — refused, nothing claimed
      const retry = await confirmAccountDeletionOperation(wire, dependencies, R4_OWNER, {
        challenge: begun.challenge,
        operationId: begun.operationId,
      });
      assertEquals(retry, { outcome: "rejected", code: "session_invalid" });
      assertEquals(calls.length, afterDeath, "a refused session reaches no RPC");

      // the live retained lease is work in flight: the sweep leaves it alone
      const live = await sweep(wire);
      assertEquals(live.certified, 0);
      assertEquals(live.claimed, 0);
      assertEquals(live.operations, []);
      assertEquals(await deleteStatusRoute(wire, begun.operationId, begun.statusCapability), {
        status: 200,
        body: IN_PROGRESS_NO_RECEIPT,
      });
      assertEquals((await durableRow(sql, begun.operationId)).completed_at, null);

      // the lease expires: the scheduled sweep re-acquires and certifies
      await sql.unsafe(
        `update api_private.account_deletion_operations
            set lease_expires_at = now() - interval '1 second' where id = $1`,
        [begun.operationId],
      );
      const recovered = await sweep(wire);
      assertEquals(recovered.claimed, 1);
      assertEquals(recovered.certified, 1);
      assertEquals(recovered.residue, 0);
      assertEquals(recovered.failed, 0);
      assertEquals(recovered.operations.length, 1);
      assertEquals(recovered.operations[0].operationId, begun.operationId);
      assertEquals(recovered.operations[0].outcome, "certified");
      const row = await durableRow(sql, begun.operationId);
      assertEquals(row.phase, "completed");
      assert(row.completed_at !== null);
      assertEquals(row.lease_token, null);
      assertEquals(row.last_error_code, null);
      assertEquals(row.attempts, 2, "one owner lease, one sweep lease");
      await assertCompletedStatus(wire, begun, row.completed_at);

      // exactly once: the next sweep finds nothing to do, direct certification
      // with the spent binding is refused, and the receipt is unchanged
      const idle = await sweep(wire);
      assertEquals(idle.claimed, 0);
      assertEquals(idle.certified, 0);
      assertEquals(idle.operations, []);
      const forged = await certifyDirect(sql, {
        p_owner_id: R4_OWNER,
        p_operation_id: begun.operationId,
        p_lease_token: crypto.randomUUID(),
      });
      assertEquals((forged.data as Row).outcome, "stale_lease");
      assertEquals(
        (await durableRow(sql, begun.operationId)).completed_at?.getTime(),
        row.completed_at.getTime(),
      );
      assertRecoveryOnly(calls, afterDeath);

      // the sweep is a service surface: clients cannot reach it
      assertEquals(await sweepAs(sql, "anon"), "42501");
      assertEquals(await sweepAs(sql, "authenticated"), "42501");
      assertEquals(await ledgerSnapshot(sql), ledgerBefore, "free-rating ledger untouched");
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "live PG: a lost deleteUser response with a recorded verdict — /delete-status is honest (blocked, no receipt), the owner's retry is refused by the shipping session check, and the service sweep certifies the released phase exactly once",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      const calls: WireCall[] = [];
      const wire = wireRpc(sql, calls);
      const begun = await r4Begin(sql, wire);
      const dependencies: AccountDeletionConfirmDependencies = {
        ...r4Dependencies(sql, calls, new Map(), { loseAuthDeleteResponse: true }),
        verifyLiveSession: shippingSessionCheck(sql),
      };
      const first = await confirmAccountDeletionOperation(wire, dependencies, R4_OWNER, {
        challenge: begun.challenge,
        operationId: begun.operationId,
      });
      assertEquals(first, { outcome: "unavailable", code: "auth_delete_unavailable" });
      const failed = await durableRow(sql, begun.operationId);
      assertEquals(failed.phase, "auth_delete_intent");
      assert(failed.auth_deleted_at !== null);
      assertEquals(failed.completed_at, null);
      assertEquals(failed.lease_token, null, "the verdict released the lease");
      assertEquals(failed.last_error_code, "auth_delete_unavailable");
      assertEquals(await deleteStatusRoute(wire, begun.operationId, begun.statusCapability), {
        status: 200,
        body: BLOCKED_NO_RECEIPT,
      });

      const afterLoss = calls.length;
      const retry = await confirmAccountDeletionOperation(wire, dependencies, R4_OWNER, {
        challenge: begun.challenge,
        operationId: begun.operationId,
      });
      assertEquals(retry, { outcome: "rejected", code: "session_invalid" });
      assertEquals(calls.length, afterLoss, "a refused session reaches no RPC");

      const recovered = await sweep(wire);
      assertEquals(recovered.claimed, 1);
      assertEquals(recovered.certified, 1);
      assertEquals(recovered.operations[0].operationId, begun.operationId);
      const row = await durableRow(sql, begun.operationId);
      assertEquals(row.phase, "completed");
      assert(row.completed_at !== null);
      assertEquals(row.last_error_code, null);
      await assertCompletedStatus(wire, begun, row.completed_at);
      assertEquals((await sweep(wire)).certified, 0);
      assertRecoveryOnly(calls, afterLoss);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "live PG: rows the cascade missed after the Auth delete — the sweep records completion_unverified without a receipt, direct certification answers `residue` with the table and count, /delete-status stays blocked, and once the residue is gone the sweep certifies exactly once",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      const calls: WireCall[] = [];
      const wire = wireRpc(sql, calls);
      await orphanedFeedbackRows(sql, 0);
      const begun = await r4Begin(sql, wire);
      const ledgerBefore = await ledgerSnapshot(sql);
      // the process dies right after the Auth delete: the verdict never lands
      const rpc = faultyRpc(wire, [
        { name: "fail_account_deletion_operation", mode: "drop", times: 1 },
      ]);
      const dependencies: AccountDeletionConfirmDependencies = {
        ...r4Dependencies(sql, calls, new Map(), { loseAuthDeleteResponse: true }),
        verifyLiveSession: shippingSessionCheck(sql),
      };
      const first = await confirmAccountDeletionOperation(rpc, dependencies, R4_OWNER, {
        challenge: begun.challenge,
        operationId: begun.operationId,
      });
      assertEquals(first, { outcome: "unavailable", code: "auth_delete_unavailable" });
      // a table whose cascade "missed": an orphaned owner row written as the
      // definer once the identity is gone (no FK path can produce it
      // otherwise) — the exact shape of a durable-residue failure
      await orphanedFeedbackRows(sql, 1);
      await sql.unsafe(
        `update api_private.account_deletion_operations
            set lease_expires_at = now() - interval '1 second' where id = $1`,
        [begun.operationId],
      );

      const swept = await sweep(wire);
      assertEquals(swept.claimed, 1);
      assertEquals(swept.certified, 0);
      assertEquals(swept.residue, 1);
      assertEquals(swept.operations[0].outcome, "residue");
      assertEquals(swept.operations[0].namespaces, [
        { table: "account_deletion_feedback", rows: 1 },
      ]);
      const stuck = await durableRow(sql, begun.operationId);
      assertEquals(stuck.completed_at, null, "residue never yields a receipt");
      assertEquals(stuck.phase, "auth_delete_intent");
      assertEquals(stuck.lease_token, null, "the verdict released the lease");
      assertEquals(stuck.last_error_code, "completion_unverified");
      assertEquals(await deleteStatusRoute(wire, begun.operationId, begun.statusCapability), {
        status: 200,
        body: BLOCKED_NO_RECEIPT,
      });

      // a worker holding a valid lease is refused the same way
      const claim = await wire("claim_account_deletion_work", {
        p_owner_id: R4_OWNER,
        p_operation_id: begun.operationId,
      });
      assertEquals((claim.data as Row).outcome, "claimed");
      const direct = await certifyDirect(sql, {
        p_owner_id: R4_OWNER,
        p_operation_id: begun.operationId,
        p_lease_token: (claim.data as Row).leaseToken,
      });
      assertEquals(direct.data, {
        outcome: "residue",
        namespaces: [{ table: "account_deletion_feedback", rows: 1 }],
      });
      assertEquals((await durableRow(sql, begun.operationId)).completed_at, null);
      assertEquals(
        (await durableRow(sql, begun.operationId)).lease_token,
        (claim.data as Row).leaseToken,
        "a refused certification keeps the lease for the caller's verdict",
      );
      const released = await wire("fail_account_deletion_operation", {
        p_owner_id: R4_OWNER,
        p_operation_id: begun.operationId,
        p_lease_token: (claim.data as Row).leaseToken,
        p_error_code: "completion_unverified",
      });
      assertEquals((released.data as Row).outcome, "released");

      // the residue is repaired: the next scheduled sweep certifies, once
      await orphanedFeedbackRows(sql, 0);
      const recovered = await sweep(wire);
      assertEquals(recovered.certified, 1);
      assertEquals(recovered.residue, 0);
      const row = await durableRow(sql, begun.operationId);
      assertEquals(row.phase, "completed");
      assert(row.completed_at !== null);
      assertEquals(row.last_error_code, null);
      await assertCompletedStatus(wire, begun, row.completed_at);
      assertEquals((await sweep(wire)).certified, 0);
      assertEquals(await ledgerSnapshot(sql), ledgerBefore, "free-rating ledger untouched");
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "live PG: a post-Auth phase whose identity was recreated under the same uuid reads blocked (no receipt) exactly as the claim RPC answers, the sweep never touches it, and once the identity is gone again it certifies exactly once",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      const calls: WireCall[] = [];
      const wire = wireRpc(sql, calls);
      // worker death after the Auth delete: no verdict, the lease is retained
      const rpc = faultyRpc(wire, [
        { name: "fail_account_deletion_operation", mode: "drop", times: 1 },
      ]);
      const begun = await r4Begin(sql, wire);
      const dependencies: AccountDeletionConfirmDependencies = {
        ...r4Dependencies(sql, calls, new Map(), { loseAuthDeleteResponse: true }),
        verifyLiveSession: shippingSessionCheck(sql),
      };
      const first = await confirmAccountDeletionOperation(rpc, dependencies, R4_OWNER, {
        challenge: begun.challenge,
        operationId: begun.operationId,
      });
      assertEquals(first, { outcome: "unavailable", code: "auth_delete_unavailable" });
      await sql.unsafe(
        `update api_private.account_deletion_operations
            set lease_expires_at = now() - interval '1 second' where id = $1`,
        [begun.operationId],
      );
      const orphaned = await durableRow(sql, begun.operationId);
      assertEquals(orphaned.last_error_code, null);
      assert(orphaned.lease_token !== null, "the retained (now expired) lease");
      // recoverable: a sweep would finish it
      assertEquals(await deleteStatusRoute(wire, begun.operationId, begun.statusCapability), {
        status: 200,
        body: IN_PROGRESS_NO_RECEIPT,
      });

      // the uuid is recreated: nothing may certify the old operation, and the
      // status must say so rather than promise progress that cannot happen
      await sql.unsafe(
        `insert into auth.users (id, email, raw_app_meta_data) values ('${R4_OWNER}', 'w0806r6@example.com', '{"provider":"google"}')`,
      );
      const claim = await wire("claim_account_deletion_work", {
        p_owner_id: R4_OWNER,
        p_operation_id: begun.operationId,
      });
      assertEquals((claim.data as Row).outcome, "blocked");
      assertEquals(
        await deleteStatusRoute(wire, begun.operationId, begun.statusCapability),
        { status: 200, body: BLOCKED_NO_RECEIPT },
        "status agrees with the claim RPC: nothing can progress this operation",
      );
      const skipped = await sweep(wire);
      assertEquals(skipped.scanned, 0);
      assertEquals(skipped.certified, 0);
      assertEquals(skipped.operations, []);
      const stale = await certifyDirect(sql, {
        p_owner_id: R4_OWNER,
        p_operation_id: begun.operationId,
        p_lease_token: orphaned.lease_token,
      });
      assertEquals((stale.data as Row).outcome, "stale_lease");
      const untouched = await durableRow(sql, begun.operationId);
      assertEquals(untouched.completed_at, null);
      assertEquals(untouched.lease_token, orphaned.lease_token);
      assertEquals(untouched.last_error_code, null);

      // the recreated identity is deleted as well: the phase is recoverable
      // again and the sweep finishes it
      await sql.unsafe(`delete from auth.users where id = '${R4_OWNER}'`);
      assertEquals(await deleteStatusRoute(wire, begun.operationId, begun.statusCapability), {
        status: 200,
        body: IN_PROGRESS_NO_RECEIPT,
      });
      const recovered = await sweep(wire);
      assertEquals(recovered.certified, 1);
      const row = await durableRow(sql, begun.operationId);
      assertEquals(row.phase, "completed");
      assert(row.completed_at !== null);
      await assertCompletedStatus(wire, begun, row.completed_at);
      assertEquals((await sweep(wire)).certified, 0);
    } finally {
      await sql.end();
    }
  },
});
