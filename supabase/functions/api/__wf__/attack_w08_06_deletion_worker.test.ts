// W08-06 ADVERSARY (worker plane): boundary and corrupt-state attacks against
// candidate b5519d14's `confirmAccountDeletionOperation` +
// `verifyOwnerNamespacesEmpty` — malformed inventory rows, exact-page and
// budget boundaries, thrown/429 reads, malformed receipts on replay, a crash
// between Auth deletion and the receipt, an ambiguous Auth "not found", and a
// static sweep of the migrations for owner-keyed tables the namespace list
// or the documented unread-table record must account for.
//
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json \
//     attack_w08_06_deletion_worker.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  ACCOUNT_DELETION_UNREAD_TABLES,
  ACCOUNT_OWNER_NAMESPACES,
  type AccountDeletionConfirmDependencies,
  confirmAccountDeletionOperation,
  type DeletionOperationRpc,
  INVENTORY_MAX_PAGES,
  INVENTORY_PAGE_ROWS,
} from "../accountDeletionOperations.ts";

const OWNER = "0a080600-0000-4000-8000-0000000000a6";
const OPERATION = "0a080600-0000-4000-8000-0000000010a6";
const CHALLENGE = "0a080600-0000-4000-8000-0000000020a6";
const LEASE = "0a080600-0000-4000-8000-0000000030a6";
const COMPLETED_AT = "2026-09-08T00:00:00.000Z";
const completed = {
  state: "completed",
  completionReceipt: { completedAt: COMPLETED_AT },
  appleAuthorizationRevocation: "revoked",
};
const uuid = (n: number) => `0a080600-0000-4000-8000-${String(n).padStart(12, "0")}`;

type PageResponse = {
  data: unknown;
  error: { message: string; code?: string } | null;
  status?: number;
};

interface Read {
  table: string;
  before: string | null;
  limit: number;
}

function fixture() {
  const calls: Array<{ name: string; parameters: Record<string, unknown> }> = [];
  const reads: Read[] = [];
  const failures: Array<{ code: string; status: number | null; detail: unknown }> = [];
  const results = new Map<string, unknown>();
  const throwing = new Map<string, unknown>();
  const pages = new Map<string, Array<PageResponse | (() => PageResponse)>>();
  results.set("confirm_account_deletion_operation", {
    outcome: "claimed",
    operationId: OPERATION,
    leaseToken: LEASE,
    leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    confirmedAt: new Date(Date.now() - 1_000).toISOString(),
    appleAction: "not_applicable",
    appleRefreshTokenEncrypted: null,
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
    if (throwing.has(name)) throw throwing.get(name);
    return { data: results.get(name) ?? null };
  };
  let authDeleteResult: { error?: unknown } = {};
  const dependencies: AccountDeletionConfirmDependencies = {
    verifyLiveSession: async () => true,
    revokeAppleCredential: async (_token, ownerId) => {
      calls.push({ name: "apple", parameters: { ownerId } });
    },
    deleteRevenueCatCustomer: async (ownerId) => {
      calls.push({ name: "revenuecat", parameters: { ownerId } });
    },
    deleteAuthUser: async (ownerId) => {
      calls.push({ name: "auth_delete", parameters: { ownerId } });
      return authDeleteResult;
    },
    readOwnerNamespacePage: async (namespace, _ownerId, before, limit) => {
      calls.push({ name: "namespace_read", parameters: { table: namespace.table } });
      reads.push({ table: namespace.table, before, limit });
      const script = pages.get(namespace.table);
      const next = script?.shift();
      const page = typeof next === "function" ? next() : next;
      return (page ?? { data: [], error: null }) as { data: unknown[]; error: null };
    },
    onFailure: (code, status, detail) => failures.push({ code, status, detail }),
  };
  const confirm = () =>
    confirmAccountDeletionOperation(rpc, dependencies, OWNER, {
      challenge: CHALLENGE,
      operationId: OPERATION,
    });
  return {
    calls,
    reads,
    failures,
    results,
    throwing,
    pages,
    confirm,
    setAuthDeleteResult: (value: { error?: unknown }) => (authDeleteResult = value),
  };
}

const names = (f: ReturnType<typeof fixture>) => f.calls.map((c) => c.name);
const namespaceDetail = (f: ReturnType<typeof fixture>, table: string) => {
  const detail = f.failures[0]?.detail as { namespaces: Array<Record<string, unknown>> };
  return detail.namespaces.find((n) => n.table === table);
};

// ---------------------------------------------------------------------------
// ATTACK 8 — corrupt persisted rows: a key that is null / missing / an object
// / NaN / a bare non-object row / a non-array page. Each must be `unread`
// (malformed_page), never `empty`, never `deleted: true`.
// ---------------------------------------------------------------------------
Deno.test("ATTACK W08-06 #8: corrupt inventory rows never count as an empty namespace", async () => {
  const corrupt: Array<[string, unknown]> = [
    ["null key", [{ id: null }]],
    ["missing key", [{ user_id: OWNER }]],
    ["object key", [{ id: { toString: () => uuid(1) } }]],
    ["NaN key", [{ id: Number.NaN }]],
    ["Infinity key", [{ id: Number.POSITIVE_INFINITY }]],
    ["bare row", ["not-an-object"]],
    ["null row", [null]],
    ["non-array page", { rows: [] }],
    ["object page", { 0: { id: uuid(1) }, length: 1 }],
  ];
  for (const [label, data] of corrupt) {
    const f = fixture();
    f.pages.set("shots", [{ data, error: null }]);
    const result = await f.confirm();
    assertEquals(result, { outcome: "unavailable", code: "completion_unverified" }, label);
    assertEquals(namespaceDetail(f, "shots")?.outcome, "unread", label);
    assertEquals(namespaceDetail(f, "shots")?.reason, "malformed_page", label);
    assertEquals(f.calls.at(-1)?.name, "fail_account_deletion_operation", label);
    assertEquals(f.calls.at(-1)?.parameters.p_error_code, "completion_unverified", label);
    // no second read of the corrupt namespace with a fabricated cursor
    assertEquals(f.reads.filter((r) => r.table === "shots").length, 1, label);
  }
});

// ---------------------------------------------------------------------------
// ATTACK 9 — boundary pages: exactly `limit` rows then an error, `limit + 1`
// rows (server ignored the limit), a duplicate straddling two pages, and a
// namespace that never yields an empty page within INVENTORY_MAX_PAGES.
// ---------------------------------------------------------------------------
Deno.test("ATTACK W08-06 #9: full-page, overflow, straddling duplicate and page-budget boundaries stay unread", async () => {
  const full = (offset: number) =>
    Array.from({ length: INVENTORY_PAGE_ROWS }, (_, i) => ({
      id: uuid(offset + INVENTORY_PAGE_ROWS - i),
    }));

  const errorAfterFull = fixture();
  errorAfterFull.pages.set("captures", [
    { data: full(0), error: null },
    { data: null, error: { message: "FAKE-timeout", code: "57014" }, status: 504 },
  ]);
  assertEquals(await errorAfterFull.confirm(), {
    outcome: "unavailable",
    code: "completion_unverified",
  });
  assertEquals(namespaceDetail(errorAfterFull, "captures"), {
    table: "captures",
    outcome: "unread",
    reason: "page_error",
    code: "57014",
    httpStatus: 504,
    pages: 2,
  });
  assertEquals(errorAfterFull.failures[0]?.status, 504);

  const overflow = fixture();
  overflow.pages.set("sessions", [{ data: [...full(0), { id: uuid(5_000) }], error: null }]);
  assertEquals((await overflow.confirm()).outcome, "unavailable");
  assertEquals(namespaceDetail(overflow, "sessions")?.reason, "page_overflow");
  assertEquals(overflow.reads.filter((r) => r.table === "sessions").length, 1);

  const straddle = fixture();
  straddle.pages.set("analysis_permits", [
    { data: full(0), error: null },
    { data: [{ id: uuid(1) }], error: null }, // == last row of page 1
  ]);
  assertEquals((await straddle.confirm()).outcome, "unavailable");
  assertEquals(namespaceDetail(straddle, "analysis_permits")?.reason, "repeated_row");

  const endless = fixture();
  let n = 0;
  endless.pages.set(
    "consent_records",
    Array.from({ length: INVENTORY_MAX_PAGES + 5 }, () => () => ({
      data: [{ id: uuid(++n) }],
      error: null,
    })),
  );
  assertEquals((await endless.confirm()).outcome, "unavailable");
  assertEquals(namespaceDetail(endless, "consent_records"), {
    table: "consent_records",
    outcome: "unread",
    reason: "page_budget",
    code: null,
    httpStatus: null,
    pages: INVENTORY_MAX_PAGES,
  });
  assertEquals(
    endless.reads.filter((r) => r.table === "consent_records").length,
    INVENTORY_MAX_PAGES,
    "the reader stops at the budget instead of looping",
  );
});

// ---------------------------------------------------------------------------
// ATTACK 10 — network failure INSIDE the sweep: a read that throws (abort /
// timeout), a 429 with Retry-After, and a redirect-shaped 3xx error page.
// ---------------------------------------------------------------------------
Deno.test("ATTACK W08-06 #10: thrown, 429 and 3xx namespace reads are unread and surfaced with their status", async () => {
  const thrown = fixture();
  thrown.pages.set("evaluation_trials", [
    () => {
      throw new DOMException("The signal has been aborted", "TimeoutError");
    },
  ]);
  assertEquals(await thrown.confirm(), { outcome: "unavailable", code: "completion_unverified" });
  assertEquals(namespaceDetail(thrown, "evaluation_trials")?.outcome, "unread");
  assertEquals(namespaceDetail(thrown, "evaluation_trials")?.reason, "page_error");
  assertEquals(namespaceDetail(thrown, "evaluation_trials")?.httpStatus, null);
  assert(!JSON.stringify(thrown.calls).includes("aborted"));

  const limited = fixture();
  limited.pages.set("analysis_feedback", [
    { data: null, error: { message: "FAKE-rate-limited", code: "PGRST429" }, status: 429 },
  ]);
  assertEquals((await limited.confirm()).outcome, "unavailable");
  assertEquals(namespaceDetail(limited, "analysis_feedback")?.httpStatus, 429);
  assertEquals(limited.failures[0]?.status, 429);

  const redirected = fixture();
  redirected.pages.set("shot_measurements", [
    { data: null, error: { message: "FAKE-moved" }, status: 307 },
  ]);
  assertEquals((await redirected.confirm()).outcome, "unavailable");
  assertEquals(namespaceDetail(redirected, "shot_measurements")?.httpStatus, 307);
  for (const f of [thrown, limited, redirected]) {
    assert(!JSON.stringify(f.calls).includes("FAKE-"));
    assertEquals(f.calls.filter((c) => c.name === "auth_delete").length, 1);
  }
});

// ---------------------------------------------------------------------------
// ATTACK 11 — replay with a corrupt durable receipt: `completed` claim whose
// status lacks a receipt / carries a non-timestamp / an unknown Apple outcome
// / a far-future or -infinity completedAt. Nothing external may run and no
// receipt may be served.
// ---------------------------------------------------------------------------
Deno.test("ATTACK W08-06 #11: a replayed completed claim with a corrupt receipt is never served", async () => {
  const corruptStatuses: Array<[string, unknown]> = [
    ["no receipt", {
      state: "completed",
      completionReceipt: null,
      appleAuthorizationRevocation: "revoked",
    }],
    ["non-timestamp", { ...completed, completionReceipt: { completedAt: "yesterday" } }],
    ["numeric completedAt", {
      ...completed,
      completionReceipt: { completedAt: 1_757_000_000_000 },
    }],
    ["unknown apple outcome", { ...completed, appleAuthorizationRevocation: "maybe" }],
    ["null apple outcome", { ...completed, appleAuthorizationRevocation: null }],
    ["state mismatch", { ...completed, state: "in_progress" }],
    ["string status", "completed"],
    ["missing status", undefined],
  ];
  for (const [label, status] of corruptStatuses) {
    const f = fixture();
    f.results.set("confirm_account_deletion_operation", {
      outcome: "completed",
      operationId: OPERATION,
      status,
    });
    const result = await f.confirm();
    assertEquals(result.outcome, "unavailable", label);
    assert(!("deleted" in result), label);
    assert(!names(f).some((n) => ["apple", "revenuecat", "auth_delete"].includes(n)), label);
  }
  // Far-future receipt: the parser accepts any ISO instant. Record the
  // observed behaviour (not a break by itself; documented for the judge).
  const future = fixture();
  future.results.set("confirm_account_deletion_operation", {
    outcome: "completed",
    operationId: OPERATION,
    status: { ...completed, completionReceipt: { completedAt: "2999-01-01T00:00:00.000Z" } },
  });
  const served = await future.confirm();
  assertEquals(served.outcome, "completed");
  assertEquals(future.reads.length, ACCOUNT_OWNER_NAMESPACES.length);
});

// ---------------------------------------------------------------------------
// ATTACK 12 — crash between Auth deletion and the receipt read, then between
// the receipt and the sweep: the retry must re-verify from the completed
// claim without a second Apple / RevenueCat / Auth call.
// ---------------------------------------------------------------------------
Deno.test("ATTACK W08-06 #12: a crash after Auth deletion is retried from the durable claim without repeating external steps", async () => {
  const f = fixture();
  f.throwing.set("read_account_deletion_receipt", new Error("FAKE-connection-reset"));
  assertEquals(await f.confirm(), { outcome: "unavailable", code: "completion_unverified" });
  assertEquals(f.reads, [], "no sweep without a durable receipt");
  assertEquals(f.failures[0]?.code, "completion_unverified");
  assertEquals(f.calls.at(-1)?.name, "fail_account_deletion_operation");

  // Restart: the durable row is completed; the retry re-verifies.
  f.throwing.clear();
  f.calls.length = 0;
  f.results.set("confirm_account_deletion_operation", {
    outcome: "completed",
    operationId: OPERATION,
    status: completed,
  });
  const retried = await f.confirm();
  assertEquals(retried.outcome, "completed");
  assert(!names(f).some((n) => ["apple", "revenuecat", "auth_delete"].includes(n)));
  assertEquals(new Set(f.reads.map((r) => r.table)).size, ACCOUNT_OWNER_NAMESPACES.length);
});

// ---------------------------------------------------------------------------
// ATTACK 13 — ambiguous Auth "not found": deleteUser says the user is already
// gone but the durable row never observed the absence (receipt not
// completed). Must be completion_unverified, not a fabricated receipt.
// ---------------------------------------------------------------------------
Deno.test("ATTACK W08-06 #13: Auth 'user not found' without a durable receipt is not a completion", async () => {
  const f = fixture();
  f.setAuthDeleteResult({
    error: { status: 404, code: "user_not_found", message: "User not found" },
  });
  f.results.set("read_account_deletion_receipt", {
    state: "blocked",
    completionReceipt: null,
    appleAuthorizationRevocation: null,
  });
  const result = await f.confirm();
  assertEquals(result, { outcome: "unavailable", code: "completion_unverified" });
  assertEquals(f.reads, [], "no sweep is trusted without a completed receipt");

  const malformedError = fixture();
  malformedError.setAuthDeleteResult({ error: { message: "FAKE-gateway", status: 502 } });
  assertEquals(await malformedError.confirm(), {
    outcome: "unavailable",
    code: "auth_delete_unavailable",
  });
  assertEquals(malformedError.reads, []);
  assertEquals(malformedError.failures[0]?.code, "auth_delete_unavailable");
  // Observed: the Auth provider's HTTP status is not carried into onFailure
  // (status null) — diagnostics only, recorded for the judge.
  assertEquals(malformedError.failures[0]?.status, null);
});

// ---------------------------------------------------------------------------
// ATTACK 14 — static completeness of the namespace accounting: every table
// created by the migrations that carries a column referencing auth.users(id)
// or public.profiles(id) must be either an owner namespace or explicitly
// recorded in ACCOUNT_DELETION_UNREAD_TABLES with a reason. An unrecorded
// owner-keyed table is an accounting gap in the "complete inventory" claim.
// ---------------------------------------------------------------------------
Deno.test("ATTACK W08-06 #14: every owner-referencing table in the migrations is a namespace or a recorded unread table", async () => {
  const dir = new URL("../../../migrations/", import.meta.url);
  const files = [...Deno.readDirSync(dir)]
    .filter((e) => e.isFile && e.name.endsWith(".sql"))
    .map((e) => e.name)
    .sort();
  const created = new Map<string, string>();
  const dropped = new Set<string>();
  for (const name of files) {
    const sql = await Deno.readTextFile(new URL(name, dir));
    const tableRe =
      /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_]+)\.([a-z_]+)\s*\(([\s\S]*?)\n\);/gi;
    for (const match of sql.matchAll(tableRe)) {
      created.set(`${match[1]}.${match[2]}`, match[3]);
    }
    for (const match of sql.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?([a-z_]+)\.([a-z_]+)/gi)) {
      dropped.add(`${match[1]}.${match[2]}`);
    }
    // Columns added later: `alter table x add column user_id uuid ... references ...`
    for (
      const match of sql.matchAll(
        /alter\s+table\s+(?:if\s+exists\s+)?([a-z_]+)\.([a-z_]+)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?([^;]+);/gi,
      )
    ) {
      const key = `${match[1]}.${match[2]}`;
      created.set(key, `${created.get(key) ?? ""}\n${match[3]}`);
    }
  }
  const ownerReferencing = [...created.entries()]
    .filter(([table, body]) =>
      !dropped.has(table) &&
      /references\s+(auth\.users|public\.profiles)\s*\(\s*id\s*\)/i.test(body)
    )
    .map(([table]) => table)
    .sort();
  assert(ownerReferencing.length >= 16, `parser found ${ownerReferencing.length} owner tables`);
  const namespaces = new Set(ACCOUNT_OWNER_NAMESPACES.map((n) => `public.${n.table}`));
  const recorded = new Set(Object.keys(ACCOUNT_DELETION_UNREAD_TABLES).map((t) => `public.${t}`));
  const unaccounted = ownerReferencing.filter((t) => !namespaces.has(t) && !recorded.has(t));
  assertEquals(
    unaccounted,
    [],
    `owner-keyed tables neither swept nor recorded as unread: ${JSON.stringify(unaccounted)}`,
  );
});
