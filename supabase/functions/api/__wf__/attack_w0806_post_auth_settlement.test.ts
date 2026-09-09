// W08-06 adversary (candidate 004c69f3): the post-Auth certification phase at
// its failure boundaries. Every test here is a live-PG test against the shipped
// migrations (XC_PG_URL, see xc_pg_up.sh) and drives the SHIPPING surfaces —
// confirmAccountDeletionOperation() (POST /v1/me/delete-confirm) and
// accountDeletionStatusResponse() (POST /v1/me/delete-status) — through the
// database itself: every RPC is one service_role transaction, every owner page
// read runs as the owner under RLS.
//
//   deno test -A --no-check --config deno.json attack_w0806_post_auth_settlement.test.ts
//
// Attacks:
//   A1 concurrency — two status polls race for the post-Auth phase
//   A2 boundary — the shared 8-attempt budget is spent when the Auth delete lands
//   A3 network — the certify response is lost on the status route (diagnostics)
//   A4 corrupt state — a cascade_only table keeps rows (FK bypassed); the
//      confirm route certifies while the database's own counter sees residue
//   A5 clock — the status window closed: nothing settles, nothing leaks
//   A6 corrupt state — Auth gone without a ready intent: blocked, never claimed
//   A7 copy — legal.ts respects the App Store copy rules
//   A8 process death — the status poll dies holding the post-Auth lease
import postgres from "postgres";
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  ACCOUNT_DELETION_UNREAD_TABLES,
  accountDeletionStatusResponse,
  beginAccountDeletionOperation,
  confirmAccountDeletionOperation,
  ownerNamespaceSelectColumns,
  type AccountDeletionConfirmDependencies,
  type DeletionFailureDetail,
  type DeletionOperationRpc,
} from "../accountDeletionOperations.ts";
import { PRIVACY_POLICY_TEXT, SUPPORT_TEXT, TERMS_TEXT } from "../legal.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];
type Row = Record<string, unknown>;

const OWNER = "0000000a-0806-4a00-8000-00000000ad01";
const SESSION = "0000000a-0806-4a00-8000-00000000ad02";
const IDENTITY = "w0806-attack-google-sub";

const IN_PROGRESS_NO_RECEIPT = {
  state: "in_progress",
  completionReceipt: null,
  appleAuthorizationRevocation: null,
};
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

function wireValue(value: unknown): string | Uint8Array | null {
  if (typeof value === "string" && /^\\x(?:[0-9a-f]{2})+$/.test(value)) {
    return Uint8Array.from(value.slice(2).match(/../g)!, (pair) => parseInt(pair, 16));
  }
  return value as string | null;
}

/** The PostgREST RPC surface answered by the database: one service_role
 * transaction per call; a SQL error becomes `{ data: null, error }`. */
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

/** `lose`: the database runs the call, the response never arrives (once per
 * `times`). */
function losingRpc(
  rpc: DeletionOperationRpc,
  faults: Array<{ name: string; times: number }>,
): DeletionOperationRpc {
  return async (name, parameters) => {
    const fault = faults.find((entry) => entry.name === name && entry.times > 0);
    if (!fault) return await rpc(name, parameters);
    fault.times -= 1;
    await rpc(name, parameters);
    throw new Error(`FAKE transport: the ${name} response was lost`);
  };
}

async function asOwner(tx: Tx, userId: string, sessionId: string): Promise<void> {
  await tx.unsafe(`select set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', public.get_api_request_key())::text, true)`);
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
  await tx.unsafe(
    `set local request.jwt.claims = '{"sub":"${userId}","session_id":"${sessionId}"}'`,
  );
}

/** Owner page reads answered by the database as the owner (RLS). */
function ownerReader(sql: Sql): AccountDeletionConfirmDependencies["readOwnerNamespacePage"] {
  return async (namespace, ownerId, before, limit) => {
    if (before !== null) {
      return {
        data: null,
        error: { message: "keyset page after an owner row was not expected here" },
        status: 500,
      };
    }
    try {
      const rows = await sql.begin(async (tx) => {
        await asOwner(tx as unknown as Tx, ownerId, SESSION);
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

function shippingLiveSession(sql: Sql): (ownerId: string) => Promise<boolean> {
  return async (ownerId) => {
    const rows = await sql.begin(async (tx) => {
      await asOwner(tx as unknown as Tx, ownerId, SESSION);
      return await tx.unsafe(`select public.is_api_session_active() as active`);
    });
    return (rows as unknown as Row[])[0]?.active === true;
  };
}

interface Failure {
  code: string;
  status: number | null | undefined;
  detail: DeletionFailureDetail | undefined;
}

function dependencies(
  sql: Sql,
  calls: WireCall[],
  failures: Failure[],
  options: { loseAuthDeleteResponse?: boolean; afterAuthDelete?: () => Promise<void> } = {},
): AccountDeletionConfirmDependencies {
  let lost = false;
  return {
    verifyLiveSession: shippingLiveSession(sql),
    revokeAppleCredential: async () => {
      throw new Error("a Google-only owner has no Apple credential to revoke");
    },
    deleteRevenueCatCustomer: async () => {
      calls.push({ name: "revenuecat_delete", parameters: {}, data: null, error: null });
    },
    deleteAuthUser: async (ownerId) => {
      await sql.unsafe(`delete from auth.users where id = $1`, [ownerId]);
      calls.push({ name: "auth_delete", parameters: { ownerId }, data: null, error: null });
      await options.afterAuthDelete?.();
      if (options.loseAuthDeleteResponse && !lost) {
        lost = true;
        throw new Error("FAKE network: the deleteUser response was lost");
      }
      return {};
    },
    readOwnerNamespacePage: ownerReader(sql),
    onFailure: (code, status, detail) => {
      failures.push({ code, status, detail });
    },
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

/** The receipt exactly as the status RPC serialises the durable row. */
async function durableReceipt(sql: Sql, operationId: string) {
  const [row] = await sql.unsafe(
    `select to_jsonb(completed_at) #>> '{}' as completed_at
       from api_private.account_deletion_operations where id = $1 and completed_at is not null`,
    [operationId],
  );
  assert(row, "a durable receipt exists");
  return {
    state: "completed",
    completionReceipt: { completedAt: String(row.completed_at) },
    appleAuthorizationRevocation: "not_applicable",
  };
}

/** A fresh owner with history in several namespaces and a requested,
 * confirmable deletion operation (aged past the 3 s fence). */
async function begin(sql: Sql, rpc: DeletionOperationRpc) {
  await sql.unsafe(
    `delete from api_private.account_deletion_operations where owner_id = '${OWNER}'`,
  );
  await sql.unsafe(`delete from auth.users where id = '${OWNER}'`);
  await sql.unsafe(`delete from public.analysis_permit_tombstones where user_id = '${OWNER}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${OWNER}', 'w0806attack@example.com', '{"provider":"google"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider_id, user_id, provider, identity_data) values ('${IDENTITY}', '${OWNER}', 'google', '{"sub":"${IDENTITY}"}')`,
  );
  await sql.unsafe(`insert into auth.sessions (id, user_id) values ('${SESSION}', '${OWNER}')`);
  await sql.unsafe(
    `insert into public.profiles (id, provider, email, display_name) values ('${OWNER}', 'google', 'w0806attack@example.com', 'W0806ATTACK') on conflict (id) do nothing`,
  );
  await sql.unsafe(
    `insert into public.sessions (id, user_id, kind, started_at) values
       ('0000000a-0806-4a00-8000-00000000ad03', '${OWNER}', 'practice', now())`,
  );
  await sql.unsafe(
    `insert into public.user_saved_drills (user_id, slug) values ('${OWNER}', 'dink-ladder')`,
  );
  await sql.unsafe(
    `insert into public.billing_entitlements (user_id, premium, product_key, expires_at)
       values ('${OWNER}', false, null, null)`,
  );
  await sql.unsafe(
    `insert into public.free_rating_ledger (identity_hash, scored_count)
       values (public.free_rating_identity_hash('google', '${IDENTITY}'), 2)
       on conflict (identity_hash) do update set scored_count = 2`,
  );
  const begun = await beginAccountDeletionOperation(rpc, OWNER);
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
  failures: Failure[] = [],
): Promise<{ status: number; body: unknown }> {
  const response = await accountDeletionStatusResponse(
    rpc,
    new Request("https://edge.test/v1/me/delete-status", {
      method: "POST",
      headers: { Authorization: `Bearer ${statusCapability}`, "content-type": "application/json" },
    }),
    { operationId },
    (code, status, detail) => {
      failures.push({ code, status, detail });
    },
  );
  return { status: response.status, body: await response.json() };
}

function countCalls(calls: WireCall[], name: string): number {
  return calls.filter((call) => call.name === name).length;
}

/** The database's own residue verdict for an owner, independent of any lease:
 * the catalog-enumerated owner namespaces the r6 counter itself uses. */
async function databaseResidue(sql: Sql, ownerId: string): Promise<Array<[string, number]>> {
  const namespaces = (await sql.unsafe(
    `select * from api_private.account_deletion_owner_namespaces()`,
  )) as unknown as Array<{ table_schema: string; table_name: string; owner_column: string }>;
  const residue: Array<[string, number]> = [];
  for (const namespace of namespaces) {
    const [row] = await sql.unsafe(
      `select count(*)::int as n from ${namespace.table_schema}.${namespace.table_name}
        where ${namespace.owner_column} = $1`,
      [ownerId],
    );
    if (Number(row.n) > 0)
      residue.push([`${namespace.table_schema}.${namespace.table_name}`, Number(row.n)]);
  }
  return residue;
}

/** A dead worker: the Auth delete landed, the response was lost, and the
 * worker's failure record never reached the database — the retained post-Auth
 * lease is then expired by the clock. */
async function deadWorkerAfterAuthDelete(
  sql: Sql,
  calls: WireCall[],
  failures: Failure[],
  operation: { operationId: string; challenge: string },
): Promise<void> {
  const wire = wireRpc(sql, calls);
  let dropped = false;
  const rpc: DeletionOperationRpc = async (name, parameters) => {
    if (name === "fail_account_deletion_operation" && !dropped) {
      dropped = true;
      throw new Error("FAKE transport: the failure record never reached the database");
    }
    return await wire(name, parameters);
  };
  assertEquals(
    await confirmAccountDeletionOperation(
      rpc,
      dependencies(sql, calls, failures, { loseAuthDeleteResponse: true }),
      OWNER,
      operation,
    ),
    { outcome: "unavailable", code: "auth_delete_unavailable" },
  );
  const dead = await durableRow(sql, operation.operationId);
  assert(dead.auth_deleted_at !== null, "the Auth identity is gone");
  assert(dead.lease_token !== null, "the dead worker's lease is retained");
  assertEquals(dead.completed_at, null);
  await sql.unsafe(
    `update api_private.account_deletion_operations
        set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1`,
    [operation.operationId],
  );
}

Deno.test({
  name: "A1 concurrency: two status polls race for the same expired post-Auth phase over independent connections — the phase is certified exactly once, neither poll fabricates or loses the receipt, the ledger is untouched",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    const pollA = postgres(PG_URL, { max: 1, onnotice: () => {} });
    const pollB = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      const calls: WireCall[] = [];
      const failures: Failure[] = [];
      const begun = await begin(sql, wireRpc(sql, calls));
      const ledgerBefore = await ledgerSnapshot(sql);
      await deadWorkerAfterAuthDelete(sql, calls, failures, begun);
      const callsA: WireCall[] = [];
      const callsB: WireCall[] = [];
      const [a, b] = await Promise.all([
        deleteStatusRoute(wireRpc(pollA, callsA), begun.operationId, begun.statusCapability),
        deleteStatusRoute(wireRpc(pollB, callsB), begun.operationId, begun.statusCapability),
      ]);
      assertEquals(a.status, 200);
      assertEquals(b.status, 200);
      const row = await durableRow(sql, begun.operationId);
      assertEquals(row.phase, "completed");
      assert(row.completed_at !== null);
      const receipt = await durableReceipt(sql, begun.operationId);
      const bodies = [a.body, b.body];
      assert(
        bodies.some((body) => JSON.stringify(body) === JSON.stringify(receipt)),
        `one poll returns the durable receipt: ${JSON.stringify(bodies)}`,
      );
      for (const body of bodies) {
        assert(
          JSON.stringify(body) === JSON.stringify(receipt) ||
            JSON.stringify(body) === JSON.stringify(IN_PROGRESS_NO_RECEIPT),
          `a poll is honest: ${JSON.stringify(body)}`,
        );
      }
      const certifications = [...callsA, ...callsB].filter(
        (call) => call.name === "certify_account_deletion_completion" && call.error === null,
      );
      assertEquals(certifications.length, 1, "certified exactly once");
      assertEquals(
        [...callsA, ...callsB].filter((call) => call.name === "fail_account_deletion_operation"),
        [],
        "no verdict other than the certification was recorded",
      );
      assertEquals(countCalls(calls, "auth_delete"), 1);
      assertEquals(countCalls(calls, "revenuecat_delete"), 1);
      assertEquals(await ledgerSnapshot(sql), ledgerBefore, "free-rating ledger untouched");
      // the receipt is stable afterwards
      assertEquals(
        await deleteStatusRoute(wireRpc(sql, []), begun.operationId, begun.statusCapability),
        {
          status: 200,
          body: receipt,
        },
      );
    } finally {
      await Promise.all([sql.end(), pollA.end(), pollB.end()]);
    }
  },
});

Deno.test({
  name: "A2 boundary: the eighth attempt is the one whose Auth delete lands and whose response is lost — the identity is gone, every namespace is clean, yet the status capability can never certify: blocked without a receipt for good",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      const calls: WireCall[] = [];
      const failures: Failure[] = [];
      const wire = wireRpc(sql, calls);
      const begun = await begin(sql, wire);
      // seven earlier confirm attempts failed before anything external ran
      await sql.unsafe(
        `update api_private.account_deletion_operations set attempts = 7 where id = $1`,
        [begun.operationId],
      );
      assertEquals(
        await confirmAccountDeletionOperation(
          wire,
          dependencies(sql, calls, failures, { loseAuthDeleteResponse: true }),
          OWNER,
          { challenge: begun.challenge, operationId: begun.operationId },
        ),
        { outcome: "unavailable", code: "auth_delete_unavailable" },
      );
      const interrupted = await durableRow(sql, begun.operationId);
      assertEquals(interrupted.attempts, 8);
      assert(interrupted.auth_deleted_at !== null);
      assertEquals(interrupted.completed_at, null);
      assertEquals(interrupted.lease_token, null, "the worker released its lease");
      assertEquals(
        (await sql.unsafe(`select 1 from auth.users where id = $1`, [OWNER])).length,
        0,
        "the Auth identity is gone",
      );
      assertEquals(await databaseResidue(sql, OWNER), [], "the cascade left nothing behind");
      // the app keeps polling with the capability it holds
      const first = await deleteStatusRoute(wire, begun.operationId, begun.statusCapability);
      const second = await deleteStatusRoute(wire, begun.operationId, begun.statusCapability);
      const row = await durableRow(sql, begun.operationId);
      // a clean post-Auth phase must be certifiable: the account is gone and
      // the budget that protected the external steps has nothing left to protect
      assertEquals(
        (first.body as Row).state,
        "completed",
        `first poll after a clean Auth delete: ${JSON.stringify(first.body)}`,
      );
      assertEquals((second.body as Row).state, "completed");
      assertEquals(row.phase, "completed");
      assertEquals(countCalls(calls, "certify_account_deletion_completion"), 1);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "A3 network: the certify response is lost on the status route — the durable receipt is returned, and the diagnostics sink must not report the certified deletion as completion_unverified",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      const calls: WireCall[] = [];
      const failures: Failure[] = [];
      const wire = wireRpc(sql, calls);
      const begun = await begin(sql, wire);
      await deadWorkerAfterAuthDelete(sql, calls, failures, begun);
      const pollFailures: Failure[] = [];
      const lossy = losingRpc(wire, [{ name: "certify_account_deletion_completion", times: 1 }]);
      const settled = await deleteStatusRoute(
        lossy,
        begun.operationId,
        begun.statusCapability,
        pollFailures,
      );
      const row = await durableRow(sql, begun.operationId);
      assertEquals(row.phase, "completed");
      assert(row.completed_at !== null);
      assertEquals(settled, {
        status: 200,
        body: await durableReceipt(sql, begun.operationId),
      });
      assertEquals(countCalls(calls, "certify_account_deletion_completion"), 1);
      assertEquals(row.last_error_code, null, "the durable row carries no error");
      // the operator's diagnostics: a certified deletion is not a failure
      assertEquals(
        pollFailures.map((failure) => failure.code),
        [],
        `diagnostics reported for a certified deletion: ${JSON.stringify(pollFailures)}`,
      );
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "A4 corrupt state: rows survive the cascade in a table the worker does not read (analysis_permit_tombstones, cascade_only; FK bypassed) — the confirm route must not issue a completion receipt while the database's own owner-namespace count reports residue",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      const calls: WireCall[] = [];
      const failures: Failure[] = [];
      const wire = wireRpc(sql, calls);
      const begun = await begin(sql, wire);
      assertEquals(
        ACCOUNT_DELETION_UNREAD_TABLES.analysis_permit_tombstones,
        "cascade_only",
        "the table under attack is one the worker does not read",
      );
      const result = await confirmAccountDeletionOperation(
        wire,
        dependencies(sql, calls, failures, {
          afterAuthDelete: async () => {
            // corrupt persisted state: written after the Auth delete with the
            // FK triggers off — every FK cascades, so this is the only way to
            // observe rows in a cascade_only table under the shipped schema
            await sql.begin(async (tx) => {
              await tx.unsafe(`set local session_replication_role = replica`);
              await tx.unsafe(
                `insert into public.analysis_permit_tombstones
                   (permit_id, user_id, idempotency_key, status, outcome, created_at)
                 values ('0000000a-0806-4a00-8000-00000000ad04', $1, 'attack-residue', 'released', null, now())`,
                [OWNER],
              );
            });
          },
        }),
        OWNER,
        { challenge: begun.challenge, operationId: begun.operationId },
      );
      const residue = await databaseResidue(sql, OWNER);
      assertEquals(
        residue,
        [["public.analysis_permit_tombstones", 1]],
        "the database counts the owner's residue",
      );
      const row = await durableRow(sql, begun.operationId);
      assertEquals(
        result,
        { outcome: "unavailable", code: "completion_unverified" },
        `confirm route verdict with residue: ${JSON.stringify(result)}`,
      );
      assertEquals(row.completed_at, null, "no receipt with residue");
      assertEquals(countCalls(calls, "certify_account_deletion_completion"), 0);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "A5 clock: the status window closed before the poll — the capability learns nothing (404), no claim is taken, no attempt is spent, and the identity's absence is never turned into a receipt",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      const calls: WireCall[] = [];
      const failures: Failure[] = [];
      const wire = wireRpc(sql, calls);
      const begun = await begin(sql, wire);
      await deadWorkerAfterAuthDelete(sql, calls, failures, begun);
      // the clock moved 25 hours past the request: the 24 h status window closed
      await sql.unsafe(
        `update api_private.account_deletion_operations
            set created_at = created_at - interval '25 hours',
                challenge_expires_at = challenge_expires_at - interval '25 hours',
                status_expires_at = status_expires_at - interval '25 hours',
                retain_until = retain_until - interval '25 hours',
                lease_expires_at = lease_expires_at - interval '25 hours'
          where id = $1`,
        [begun.operationId],
      );
      const before = await durableRow(sql, begun.operationId);
      assert(before.lease_token !== null, "the dead worker's lease is still on the row");
      const pollCalls: WireCall[] = [];
      assertEquals(
        await deleteStatusRoute(wireRpc(sql, pollCalls), begun.operationId, begun.statusCapability),
        { status: 404, body: { error: { code: "account.deletion_status_unavailable" } } },
      );
      assertEquals(
        pollCalls.map((call) => call.name),
        ["read_account_deletion_status"],
      );
      const after = await durableRow(sql, begun.operationId);
      assertEquals(after.attempts, before.attempts);
      assertEquals(after.lease_token, before.lease_token);
      assertEquals(after.completed_at, null);
      // the clock rolls back into the window: the phase is settled exactly
      // once on the original operation
      await sql.unsafe(
        `update api_private.account_deletion_operations
            set created_at = created_at + interval '25 hours',
                challenge_expires_at = challenge_expires_at + interval '25 hours',
                status_expires_at = status_expires_at + interval '25 hours',
                retain_until = retain_until + interval '25 hours',
                lease_expires_at = lease_expires_at + interval '25 hours'
          where id = $1`,
        [begun.operationId],
      );
      const settled = await deleteStatusRoute(
        wireRpc(sql, pollCalls),
        begun.operationId,
        begun.statusCapability,
      );
      assertEquals((settled.body as Row).state, "completed");
      assertEquals(countCalls(pollCalls, "certify_account_deletion_completion"), 1);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "A6 corrupt state: the Auth identity disappears while the operation is confirmed but has no ready intent — the row is sealed blocked, the status capability never claims, counts or certifies, and the retry confirm is refused",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      const calls: WireCall[] = [];
      const wire = wireRpc(sql, calls);
      const begun = await begin(sql, wire);
      await sql.unsafe(
        `update api_private.account_deletion_operations
            set confirmed_at = clock_timestamp(), phase = 'confirmed' where id = $1`,
        [begun.operationId],
      );
      // an out-of-band identity delete (admin console, another surface)
      await sql.unsafe(`delete from auth.users where id = $1`, [OWNER]);
      const sealed = await durableRow(sql, begun.operationId);
      assert(sealed.auth_deleted_at !== null);
      assertEquals(sealed.last_error_code, "auth_absent_without_ready_intent");
      assertEquals(sealed.completed_at, null);
      const pollCalls: WireCall[] = [];
      for (let poll = 0; poll < 3; poll += 1) {
        assertEquals(
          await deleteStatusRoute(
            wireRpc(sql, pollCalls),
            begun.operationId,
            begun.statusCapability,
          ),
          { status: 200, body: BLOCKED_NO_RECEIPT },
        );
      }
      for (const call of pollCalls) {
        if (call.name === "claim_account_deletion_status_work")
          assertEquals(call.data, { outcome: "blocked" });
      }
      assertEquals(countCalls(pollCalls, "read_account_deletion_owner_residue"), 0);
      assertEquals(countCalls(pollCalls, "certify_account_deletion_completion"), 0);
      assertEquals(countCalls(pollCalls, "fail_account_deletion_operation"), 0);
      const after = await durableRow(sql, begun.operationId);
      assertEquals(after.attempts, sealed.attempts);
      assertEquals(after.lease_token, null);
      assertEquals(after.completed_at, null);
      // the confirm retry has no session and moves nothing
      const failures: Failure[] = [];
      const retried = await confirmAccountDeletionOperation(
        wire,
        dependencies(sql, calls, failures),
        OWNER,
        { challenge: begun.challenge, operationId: begun.operationId },
      );
      assertEquals(retried, { outcome: "rejected", code: "session_invalid" });
      assertEquals(countCalls(calls, "auth_delete"), 0);
      assertEquals(countCalls(calls, "revenuecat_delete"), 0);
      assertNotEquals((await durableRow(sql, begun.operationId)).phase, "completed");
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "A8 process death: the status poll dies after claiming the post-Auth phase (residue count never runs, no verdict reaches the database) — later polls stay honest, never steal the live lease, and certify exactly once after the lease expires",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      const calls: WireCall[] = [];
      const failures: Failure[] = [];
      const wire = wireRpc(sql, calls);
      const begun = await begin(sql, wire);
      await deadWorkerAfterAuthDelete(sql, calls, failures, begun);
      // the poll's isolate dies right after the claim: every later RPC of that
      // poll never reaches the database
      const dyingCalls: WireCall[] = [];
      const dyingWire = wireRpc(sql, dyingCalls);
      let claimed = false;
      const dying: DeletionOperationRpc = async (name, parameters) => {
        if (claimed) throw new Error("FAKE isolate death: the status poll is gone");
        const result = await dyingWire(name, parameters);
        if (name === "claim_account_deletion_status_work") claimed = true;
        return result;
      };
      const dyingFailures: Failure[] = [];
      const died = await deleteStatusRoute(
        dying,
        begun.operationId,
        begun.statusCapability,
        dyingFailures,
      );
      assertEquals(
        died.status,
        503,
        `a poll that lost its isolate answers generically: ${JSON.stringify(died)}`,
      );
      assertEquals(countCalls(dyingCalls, "certify_account_deletion_completion"), 0);
      assertEquals(countCalls(dyingCalls, "fail_account_deletion_operation"), 0);
      const held = await durableRow(sql, begun.operationId);
      assert(held.lease_token !== null, "the dead poll's lease is on the row");
      assertEquals(held.completed_at, null);
      assertEquals(held.last_error_code, null);
      // the app polls again while that lease is live: honest in_progress, no steal
      const liveCalls: WireCall[] = [];
      assertEquals(
        await deleteStatusRoute(wireRpc(sql, liveCalls), begun.operationId, begun.statusCapability),
        { status: 200, body: IN_PROGRESS_NO_RECEIPT },
      );
      assertEquals(
        liveCalls
          .filter((call) => call.name === "claim_account_deletion_status_work")
          .map((call) => (call.data as Row).outcome),
        ["busy"],
      );
      assertEquals(countCalls(liveCalls, "read_account_deletion_owner_residue"), 0);
      assertEquals(countCalls(liveCalls, "certify_account_deletion_completion"), 0);
      const stillHeld = await durableRow(sql, begun.operationId);
      assertEquals(stillHeld.lease_token, held.lease_token, "the live lease was not stolen");
      assertEquals(stillHeld.attempts, held.attempts, "a busy poll spends no attempt");
      // the lease expires: the next poll settles the phase exactly once
      await sql.unsafe(
        `update api_private.account_deletion_operations
            set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1`,
        [begun.operationId],
      );
      const settleCalls: WireCall[] = [];
      const settled = await deleteStatusRoute(
        wireRpc(sql, settleCalls),
        begun.operationId,
        begun.statusCapability,
      );
      assertEquals(settled, { status: 200, body: await durableReceipt(sql, begun.operationId) });
      assertEquals(countCalls(settleCalls, "certify_account_deletion_completion"), 1);
      const row = await durableRow(sql, begun.operationId);
      assertEquals(row.phase, "completed");
      assertEquals(row.lease_token, null);
      assertEquals(countCalls(calls, "auth_delete"), 1);
      assertEquals(countCalls(calls, "revenuecat_delete"), 1);
    } finally {
      await sql.end();
    }
  },
});

Deno.test(
  "A7 copy: legal.ts (privacy, terms, support) follows the App Store copy rules — no Android / Google Play / guest mode / Live Court / DUPR / competitor names / accuracy claims / superlatives",
  () => {
    const forbidden = [
      /android/i,
      /google play/i,
      /guest mode/i,
      /live court/i,
      /\bDUPR\b/,
      /swingvision/i,
      /pb vision/i,
      /selkirk/i,
      /joola/i,
      /\d+(\.\d+)?\s*%\s*(accura|precis)/i,
      /accuracy of \d/i,
      /\b(best|most accurate|#1|number one|world[- ]class|revolutionary)\b/i,
      /as good as a (human )?coach/i,
    ];
    for (const [name, text] of Object.entries({
      PRIVACY_POLICY_TEXT,
      TERMS_TEXT,
      SUPPORT_TEXT,
    })) {
      for (const pattern of forbidden) {
        const match = text.match(pattern);
        assertEquals(match, null, `${name} contains forbidden copy ${pattern}: ${match?.[0]}`);
      }
    }
  },
);
