// W08-06 ADVERSARIAL TESTS — candidate devin/pp/w08-06/impl-r4 @ 750da77d.
//
// Each test is one attack on the certified-completion contract. A test that
// FAILS against the candidate is a confirmed break; a test that passes is an
// attack that did not break anything. Nothing here modifies the candidate's
// production code or its own tests.
//
// Live-database attacks drive the SHIPPING worker
// (confirmAccountDeletionOperation / resumeConfirmedAccountDeletionOperation)
// against the real RPCs over a disposable PostgreSQL:
//
//   ./xc_pg_up.sh
//   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
//     deno test -A --no-check --config deno.json w08_06_attack.test.ts

import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import {
  ACCOUNT_OWNER_NAMESPACES,
  INVENTORY_READ_ATTEMPTS,
  accountDeletionStatusResponse,
  beginAccountDeletionOperation,
  confirmAccountDeletionOperation,
  ownerNamespaceSelectColumns,
  resumeConfirmedAccountDeletionOperation,
  verifyOwnerNamespacesEmpty,
  type AccountDeletionConfirmDependencies,
  type DeletionOperationRpc,
  type InventoryPage,
  type OwnerNamespace,
} from "../accountDeletionOperations.ts";
import { PRIVACY_POLICY_TEXT, SUPPORT_TEXT, TERMS_TEXT } from "../legal.ts";

type Row = Record<string, unknown>;

// ─── Attack 1 (unit): 429 + Retry-After on a namespace page after the Auth delete ──
//
// The sweep retries a page error INVENTORY_READ_ATTEMPTS times back to back.
// A source that paces the reader (429 + Retry-After: 1) answers every one of
// those immediate retries with the same 429, so a namespace that IS empty is
// reported `unread` — and after the Auth delete `unread` becomes the terminal
// completion_unverified verdict.

Deno.test(
  "attack: a namespace that answers 429 + Retry-After: 1 then empty must read as `empty`, not `unread`",
  async () => {
    const startedAt = Date.now();
    const reads: number[] = [];
    const reader = {
      readOwnerNamespacePage(
        _namespace: OwnerNamespace,
        _ownerId: string,
        _before: string | null,
        _limit: number,
      ): Promise<InventoryPage<unknown>> {
        const elapsed = Date.now() - startedAt;
        reads.push(elapsed);
        // the source refuses for one second, exactly as its Retry-After says
        if (elapsed < 1_000) {
          return Promise.resolve({
            data: null,
            error: { message: "Too Many Requests", code: "PGRST429" },
            status: 429,
          });
        }
        return Promise.resolve({ data: [], error: null, status: 200 });
      },
    };
    const namespace = ACCOUNT_OWNER_NAMESPACES.find((entry) => entry.table === "shots")!;
    const [verdict] = await verifyOwnerNamespacesEmpty(
      reader,
      "08060000-0000-4000-8000-000000000001",
      [namespace],
    );
    assert(reads.length >= 2, "the sweep retried at all");
    assertEquals(
      verdict.outcome,
      "empty",
      `a paced source (429 + Retry-After: 1) must be re-read after the pacing, not ${
        INVENTORY_READ_ATTEMPTS
      } times within ${reads[reads.length - 1]} ms; verdict: ${JSON.stringify(verdict)}`,
    );
  },
);

// ─── Attack 2 (copy): legal/support text policy ──────────────────────────────

Deno.test("attack: legal and support copy contain no forbidden product claims", () => {
  const forbidden = [
    /android/i,
    /google play/i,
    /guest mode/i,
    /live court/i,
    /\bDUPR\b/,
    /swingvision/i,
    /pb vision/i,
    /selkirk/i,
    /\bjoola\b/i,
    /\d+(\.\d+)?\s?% accura/i,
    /\bmost accurate\b/i,
    /\bbest\b.*\bcoach/i,
    /as good as a (human )?coach/i,
    /replaces? (a|your) coach/i,
  ];
  for (const [name, text] of [
    ["privacy", PRIVACY_POLICY_TEXT],
    ["terms", TERMS_TEXT],
    ["support", SUPPORT_TEXT],
  ] as const) {
    for (const pattern of forbidden) {
      assertEquals(pattern.test(text), false, `${name} matches ${pattern}`);
    }
  }
});

Deno.test("attack: retention durations disclosed in §7 match the schema constraints", async () => {
  const migration = await Deno.readTextFile(
    new URL("../../../migrations/20260907001500_account_deletion_operations.sql", import.meta.url),
  );
  const scale = await Deno.readTextFile(
    new URL("../../../migrations/20260831000000_scale_and_security.sql", import.meta.url),
  );
  // the copy: 7-day operation record, 24-hour outcome window, 15-minute challenge, 90-day webhook audit
  assert(/deletion operation record for\s+7 days/.test(PRIVACY_POLICY_TEXT));
  assert(/outcome for 24 hours/.test(PRIVACY_POLICY_TEXT));
  assert(/challenge expires after 15 minutes/.test(PRIVACY_POLICY_TEXT));
  assert(
    /webhook audit records are scheduled for deletion after 90 days/.test(PRIVACY_POLICY_TEXT),
  );
  // the schema
  assert(migration.includes("check (retain_until = created_at + interval '7 days')"));
  assert(migration.includes("check (status_expires_at = created_at + interval '24 hours')"));
  assert(migration.includes("challenge_expires_at <= created_at + interval '15 minutes'"));
  assert(
    scale.includes(
      "delete from public.webhook_events where received_at < now() - interval ''90 days''",
    ),
  );
});

// ─── Live PostgreSQL attacks ─────────────────────────────────────────────────

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

const OWNER = "0000000a-0806-4000-8000-00000000a201";
const SESSION = "0000000a-0806-4000-8000-00000000a301";
const IDENTITY = "w0806-attack-google-sub";
const OTHER_OWNER = "0000000a-0806-4000-8000-00000000a202";
const OTHER_SESSION = "0000000a-0806-4000-8000-00000000a302";
const OTHER_IDENTITY = "w0806-attack-other-google-sub";
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

/** The PostgREST RPC surface answered by the database as service_role. `fault`
 * lets an attack drop one call on the floor (the database committed nothing
 * for it and the isolate saw a transport failure). */
function wireRpc(
  sql: Sql,
  calls: WireCall[],
  fault: (name: string) => "ok" | "throw" = () => "ok",
): DeletionOperationRpc {
  return async (name, parameters) => {
    if (fault(name) === "throw") {
      calls.push({
        name,
        parameters,
        data: null,
        error: { message: "injected transport failure", code: null },
      });
      throw new Error("injected transport failure");
    }
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

async function asOwner(tx: Tx, userId: string, sessionId: string): Promise<void> {
  await tx.unsafe(`select set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', public.get_api_request_key())::text, true)`);
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
  await tx.unsafe(
    `set local request.jwt.claims = '{"sub":"${userId}","session_id":"${sessionId}"}'`,
  );
}

/** Owner page reads answered by the database as the owner under RLS. */
function ownerReader(
  sql: Sql,
  sessionId: string,
  fault: () => "ok" | "throw" = () => "ok",
): AccountDeletionConfirmDependencies["readOwnerNamespacePage"] {
  return async (namespace, ownerId, before, limit) => {
    if (fault() === "throw") throw new Error("injected owner read failure");
    if (before !== null) {
      return {
        data: null,
        error: { message: "keyset page after an owner row was not expected here" },
        status: 500,
      };
    }
    try {
      const rows = await sql.begin(async (tx) => {
        await asOwner(tx as unknown as Tx, ownerId, sessionId);
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
  last_error_code: string | null;
  attempts: number;
}

async function durableRow(sql: Sql, operationId: string): Promise<DurableRow> {
  const rows = await sql.unsafe(
    `select phase, confirmed_at, auth_deleted_at, completed_at, lease_token, lease_expires_at,
            last_error_code, attempts
       from api_private.account_deletion_operations where id = $1`,
    [operationId],
  );
  assertEquals(rows.length, 1, "durable operation row");
  return rows[0] as unknown as DurableRow;
}

/** Superuser view: every owner namespace is empty for `ownerId`. */
async function everyNamespaceEmpty(sql: Sql, ownerId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const namespace of ACCOUNT_OWNER_NAMESPACES) {
    const rows = await sql.unsafe(
      `select 1 from public.${namespace.table} where ${namespace.ownerColumn} = $1`,
      [ownerId],
    );
    counts[namespace.table] = rows.length;
  }
  return counts;
}

async function seedOwner(
  sql: Sql,
  owner: string,
  session: string,
  identity: string,
): Promise<void> {
  await sql.unsafe(
    `delete from api_private.account_deletion_operations where owner_id = '${owner}'`,
  );
  await sql.unsafe(`delete from auth.users where id = '${owner}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${owner}', '${identity}@example.com', '{"provider":"google"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider_id, user_id, provider, identity_data) values ('${identity}', '${owner}', 'google', '{"sub":"${identity}"}')`,
  );
  await sql.unsafe(`insert into auth.sessions (id, user_id) values ('${session}', '${owner}')`);
  await sql.unsafe(
    `insert into public.profiles (id, provider, email, display_name) values ('${owner}', 'google', '${identity}@example.com', 'Attack') on conflict (id) do nothing`,
  );
  await sql.unsafe(
    `insert into public.sessions (id, user_id, kind, started_at) values (gen_random_uuid(), '${owner}', 'practice', now())`,
  );
  await sql.unsafe(
    `insert into public.user_saved_drills (user_id, slug) values ('${owner}', 'dink-ladder')`,
  );
  await sql.unsafe(
    `insert into public.billing_entitlements (user_id, premium, product_key, expires_at)
       values ('${owner}', false, null, null)`,
  );
}

async function begin(sql: Sql, rpc: DeletionOperationRpc, owner: string) {
  const begun = await beginAccountDeletionOperation(rpc, owner);
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

interface Faults {
  /** Thrown by deleteAuthUser AFTER the auth.users row is gone (response lost). */
  loseAuthDeleteResponse?: boolean;
  /** RPC names that fail (transport) while `armed()` is true. */
  rpcFaults?: (name: string) => boolean;
  /** Owner reads fail (transport) while `armed()` is true. */
  ownerReadFault?: boolean;
}

function dependencies(
  sql: Sql,
  calls: WireCall[],
  session: string,
  faults: Faults,
  armed: () => boolean,
): AccountDeletionConfirmDependencies {
  return {
    verifyLiveSession: () => Promise.resolve(true),
    revokeAppleCredential: () =>
      Promise.reject(new Error("a Google-only owner has no Apple credential to revoke")),
    deleteRevenueCatCustomer: () => {
      calls.push({ name: "revenuecat_delete", parameters: {}, data: null, error: null });
      return Promise.resolve();
    },
    deleteAuthUser: async (ownerId) => {
      await sql.unsafe(`delete from auth.users where id = $1`, [ownerId]);
      calls.push({ name: "auth_delete", parameters: { ownerId }, data: null, error: null });
      if (faults.loseAuthDeleteResponse && armed()) {
        throw new Error("injected: Auth admin deleteUser response timed out");
      }
      return {};
    },
    readOwnerNamespacePage: ownerReader(sql, session, () =>
      faults.ownerReadFault && armed() ? "throw" : "ok",
    ),
  };
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

/** After a transient post-Auth failure has passed, a clean deletion (every
 * namespace empty, superuser-verified) must still be certifiable through a
 * shipping worker path — otherwise the operation is stuck `blocked` with no
 * receipt forever, and not even the service role can record the truth. */
async function assertCleanDeletionStillCertifiable(
  sql: Sql,
  rpc: DeletionOperationRpc,
  healthy: AccountDeletionConfirmDependencies,
  owner: string,
  operationId: string,
  statusCapability: string,
  attack: string,
): Promise<void> {
  const counts = await everyNamespaceEmpty(sql, owner);
  for (const [table, count] of Object.entries(counts)) {
    assertEquals(count, 0, `${table} cascaded with the identity — the deletion IS clean`);
  }
  assertEquals((await sql.unsafe(`select 1 from auth.users where id = '${owner}'`)).length, 0);
  const row = await durableRow(sql, operationId);
  assert(row.auth_deleted_at !== null, "Auth absence recorded");
  // the shipping resume path, now healthy, must be able to finish the job
  const resumed = await resumeConfirmedAccountDeletionOperation(rpc, healthy, owner, operationId);
  const status = await deleteStatusRoute(rpc, operationId, statusCapability);
  const after = await durableRow(sql, operationId);
  assertEquals(
    resumed.outcome,
    "completed",
    `${attack}: the deletion is clean (every namespace empty) but the shipping worker cannot ` +
      `certify it — resume answered ${JSON.stringify(resumed)}, /delete-status answers ` +
      `${JSON.stringify(status.body)}, durable row ${JSON.stringify({
        phase: after.phase,
        completed_at: after.completed_at,
        lease_token: after.lease_token === null ? null : "<retained>",
        lease_expired:
          after.lease_expires_at !== null && after.lease_expires_at.getTime() < Date.now(),
        last_error_code: after.last_error_code,
      })}. Nothing (not even the service role) can ever record the receipt.`,
  );
}

// ─── Attack 3 (process death): the isolate dies between the Auth delete and the certification ──

Deno.test({
  name: "attack: worker crash after the Auth delete — the retained lease expires and the clean deletion must still be certifiable",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      await seedOwner(sql, OWNER, SESSION, IDENTITY);
      const calls: WireCall[] = [];
      let armed = false;
      // once armed, the database is unreachable for the isolate: the receipt
      // read fails AND the failure verdict cannot be written (a dying isolate
      // records nothing) — the durable row keeps the lease the trigger retained
      const rpc = wireRpc(sql, calls, (name) =>
        armed &&
        (name === "read_account_deletion_receipt" || name === "fail_account_deletion_operation")
          ? "throw"
          : "ok",
      );
      const begun = await begin(sql, rpc, OWNER);
      const crashing: AccountDeletionConfirmDependencies = {
        ...dependencies(sql, calls, SESSION, {}, () => false),
        deleteAuthUser: async (ownerId) => {
          await sql.unsafe(`delete from auth.users where id = $1`, [ownerId]);
          calls.push({ name: "auth_delete", parameters: { ownerId }, data: null, error: null });
          armed = true;
          return {};
        },
      };
      const first = await confirmAccountDeletionOperation(rpc, crashing, OWNER, {
        challenge: begun.challenge,
        operationId: begun.operationId,
      });
      assertEquals(first, { outcome: "unavailable", code: "completion_unverified" });
      assertEquals(
        calls.filter((call) => call.name === "certify_account_deletion_completion").length,
        0,
      );
      const crashed = await durableRow(sql, begun.operationId);
      assertEquals(crashed.completed_at, null);
      assert(
        crashed.lease_token !== null,
        "the trigger retained the lease for the sweeping worker",
      );
      assertEquals(crashed.last_error_code, null, "a dead isolate recorded no verdict");
      // ... the isolate is gone; its 120 s lease runs out (simulated by the clock)
      await sql.unsafe(
        `update api_private.account_deletion_operations
            set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1`,
        [begun.operationId],
      );
      armed = false;
      const healthy = dependencies(sql, calls, SESSION, {}, () => false);
      await assertCleanDeletionStillCertifiable(
        sql,
        rpc,
        healthy,
        OWNER,
        begun.operationId,
        begun.statusCapability,
        "crash between Auth delete and certification",
      );
    } finally {
      await sql.end();
    }
  },
});

// ─── Attack 4 (network failure at the receipt-read step) ─────────────────────

Deno.test({
  name: "attack: one transient failure of the post-Auth receipt read must not turn a clean deletion into a permanent completion_unverified",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      await seedOwner(sql, OWNER, SESSION, IDENTITY);
      const calls: WireCall[] = [];
      let blips = 1;
      const rpc = wireRpc(sql, calls, (name) => {
        if (name === "read_account_deletion_receipt" && blips > 0) {
          blips -= 1;
          return "throw";
        }
        return "ok";
      });
      const begun = await begin(sql, rpc, OWNER);
      const deps = dependencies(sql, calls, SESSION, {}, () => false);
      const first = await confirmAccountDeletionOperation(rpc, deps, OWNER, {
        challenge: begun.challenge,
        operationId: begun.operationId,
      });
      assertEquals(first, { outcome: "unavailable", code: "completion_unverified" });
      const row = await durableRow(sql, begun.operationId);
      // no namespace was ever read, yet the durable verdict claims residue
      assertEquals(
        calls.filter((call) => call.name === "fail_account_deletion_operation").map((c) => c.data),
        [{ outcome: "released" }],
      );
      assertEquals(row.last_error_code, "completion_unverified");
      await assertCleanDeletionStillCertifiable(
        sql,
        rpc,
        deps,
        OWNER,
        begun.operationId,
        begun.statusCapability,
        "transient receipt-read failure after the Auth delete",
      );
    } finally {
      await sql.end();
    }
  },
});

// ─── Attack 5 (network failure at the Auth-delete step: response lost) ──────

Deno.test({
  name: "attack: Auth admin deleteUser succeeds server-side but the response is lost — the clean deletion must still be certifiable",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      await seedOwner(sql, OWNER, SESSION, IDENTITY);
      const calls: WireCall[] = [];
      const rpc = wireRpc(sql, calls);
      const begun = await begin(sql, rpc, OWNER);
      let lose = true;
      const deps = dependencies(sql, calls, SESSION, { loseAuthDeleteResponse: true }, () => lose);
      const first = await confirmAccountDeletionOperation(rpc, deps, OWNER, {
        challenge: begun.challenge,
        operationId: begun.operationId,
      });
      assertEquals(first, { outcome: "unavailable", code: "auth_delete_unavailable" });
      // the verdict could not even be recorded: the lease helper refuses once the identity is gone
      assertEquals(
        calls.filter((call) => call.name === "fail_account_deletion_operation").map((c) => c.data),
        [{ outcome: "stale_lease" }],
      );
      // the app retries the confirm with the same challenge (its documented behaviour on 503)
      lose = false;
      const retried = await confirmAccountDeletionOperation(rpc, deps, OWNER, {
        challenge: begun.challenge,
        operationId: begun.operationId,
      });
      assertEquals(
        retried.outcome,
        "completed",
        `the app's retry of the confirm after a lost Auth-delete response answered ${JSON.stringify(
          retried,
        )} for a deletion that is clean`,
      );
    } finally {
      await sql.end();
    }
  },
});

// ─── Attack 6 (concurrency): two workers certify with the same retained lease ──

Deno.test({
  name: "attack: concurrent certifications with the same retained lease certify exactly once; a racing residue verdict cannot unwind it",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4, onnotice: () => {} });
    try {
      await seedOwner(sql, OWNER, SESSION, IDENTITY);
      const calls: WireCall[] = [];
      const rpc = wireRpc(sql, calls);
      const begun = await begin(sql, rpc, OWNER);
      // drive the worker up to the Auth delete, then stop it before it certifies
      let holdBeforeCertify = true;
      const stopAtFail = wireRpc(sql, calls, (name) =>
        holdBeforeCertify &&
        (name === "fail_account_deletion_operation" || name === "read_account_deletion_receipt")
          ? "throw"
          : "ok",
      );
      const deps = dependencies(sql, calls, SESSION, {}, () => false);
      const first = await confirmAccountDeletionOperation(stopAtFail, deps, OWNER, {
        challenge: begun.challenge,
        operationId: begun.operationId,
      });
      assertEquals(first, { outcome: "unavailable", code: "completion_unverified" });
      holdBeforeCertify = false;
      const row = await durableRow(sql, begun.operationId);
      assert(row.lease_token !== null && row.completed_at === null);
      const lease = row.lease_token;
      const certify = () =>
        sql.begin(async (tx) => {
          await tx.unsafe(`set local role service_role`);
          const rows = await tx.unsafe(
            `select public.certify_account_deletion_completion($1, $2, $3) as data`,
            [OWNER, begun.operationId, lease],
          );
          return (rows as unknown as Row[])[0].data as Row;
        });
      const fail = () =>
        sql.begin(async (tx) => {
          await tx.unsafe(`set local role service_role`);
          const rows = await tx.unsafe(
            `select public.fail_account_deletion_operation($1, $2, $3, 'completion_unverified') as data`,
            [OWNER, begun.operationId, lease],
          );
          return (rows as unknown as Row[])[0].data as Row;
        });
      const outcomes = await Promise.all([certify(), certify(), fail(), certify()]);
      const certified = outcomes.filter((o) => o.state === "completed");
      const stale = outcomes.filter((o) => o.outcome === "stale_lease");
      const released = outcomes.filter((o) => o.outcome === "released");
      // exactly one actor wins the retained lease
      assertEquals(certified.length + released.length, 1, JSON.stringify(outcomes));
      assertEquals(stale.length, 3, JSON.stringify(outcomes));
      const after = await durableRow(sql, begun.operationId);
      assertEquals(after.lease_token, null);
      if (certified.length === 1) {
        assertEquals(after.phase, "completed");
        assert(after.completed_at !== null);
        assertEquals(after.last_error_code, null);
        const body = (await deleteStatusRoute(rpc, begun.operationId, begun.statusCapability))
          .body as { state: string; completionReceipt: { completedAt: string } | null };
        assertEquals(body.state, "completed");
        assert(body.completionReceipt !== null);
        assertEquals(
          new Date(body.completionReceipt.completedAt).getTime(),
          after.completed_at.getTime(),
        );
      } else {
        assertEquals(after.completed_at, null);
        assertEquals(after.last_error_code, "completion_unverified");
        assertEquals(
          (await deleteStatusRoute(rpc, begun.operationId, begun.statusCapability)).body,
          BLOCKED_NO_RECEIPT,
        );
      }
    } finally {
      await sql.end();
    }
  },
});

// ─── Attack 7 (replay / duplicate identity / cross-account) ──────────────────

Deno.test({
  name: "attack: a replayed identity (same auth.users id re-created) and another owner's retained lease can never certify a receipt",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      await seedOwner(sql, OWNER, SESSION, IDENTITY);
      await seedOwner(sql, OTHER_OWNER, OTHER_SESSION, OTHER_IDENTITY);
      const calls: WireCall[] = [];
      // both owners are driven to the Auth delete and held there (dying isolate)
      let hold = true;
      const rpc = wireRpc(sql, calls, (name) =>
        hold &&
        (name === "read_account_deletion_receipt" || name === "fail_account_deletion_operation")
          ? "throw"
          : "ok",
      );
      const begunA = await begin(sql, rpc, OWNER);
      const begunB = await begin(sql, rpc, OTHER_OWNER);
      for (const [owner, session, begun] of [
        [OWNER, SESSION, begunA],
        [OTHER_OWNER, OTHER_SESSION, begunB],
      ] as const) {
        const deps = dependencies(sql, calls, session, {}, () => false);
        const result = await confirmAccountDeletionOperation(rpc, deps, owner, {
          challenge: begun.challenge,
          operationId: begun.operationId,
        });
        assertEquals(result, { outcome: "unavailable", code: "completion_unverified" });
      }
      hold = false;
      const rowA = await durableRow(sql, begunA.operationId);
      const rowB = await durableRow(sql, begunB.operationId);
      assert(rowA.lease_token !== null && rowB.lease_token !== null);
      // duplicate identity: the same auth.users id is created again while A's lease is live
      await sql.unsafe(
        `insert into auth.users (id, email, raw_app_meta_data) values ('${OWNER}', 'replay@example.com', '{"provider":"google"}')`,
      );
      const attempts: Array<Record<string, unknown>> = [
        // A's own lease while an identity with A's id exists again
        { p_owner_id: OWNER, p_operation_id: begunA.operationId, p_lease_token: rowA.lease_token },
        // B's retained lease against A's operation
        { p_owner_id: OWNER, p_operation_id: begunA.operationId, p_lease_token: rowB.lease_token },
        // A's operation certified "as" B
        {
          p_owner_id: OTHER_OWNER,
          p_operation_id: begunA.operationId,
          p_lease_token: rowA.lease_token,
        },
        // B's operation with A's lease
        {
          p_owner_id: OTHER_OWNER,
          p_operation_id: begunB.operationId,
          p_lease_token: rowA.lease_token,
        },
      ];
      for (const attempt of attempts) {
        const certify = await rpc("certify_account_deletion_completion", attempt);
        assertEquals(certify.error, null);
        assertEquals(certify.data, { outcome: "stale_lease" }, JSON.stringify(attempt));
      }
      assertEquals(await durableRow(sql, begunA.operationId), rowA);
      assertEquals(await durableRow(sql, begunB.operationId), rowB);
      // the re-created identity cannot resume or re-claim A's operation either
      const deps = dependencies(sql, calls, SESSION, {}, () => false);
      assertEquals(
        await resumeConfirmedAccountDeletionOperation(rpc, deps, OWNER, begunA.operationId),
        { outcome: "rejected", code: "blocked" },
      );
      assertEquals(await deleteStatusRoute(rpc, begunA.operationId, begunA.statusCapability), {
        status: 200,
        body: BLOCKED_NO_RECEIPT,
      });
      // B, whose identity is genuinely gone, still certifies with its own lease
      const certifyB = await rpc("certify_account_deletion_completion", {
        p_owner_id: OTHER_OWNER,
        p_operation_id: begunB.operationId,
        p_lease_token: rowB.lease_token,
      });
      assertEquals((certifyB.data as Row).state, "completed");
      await sql.unsafe(`delete from auth.users where id = '${OWNER}'`);
    } finally {
      await sql.end();
    }
  },
});

// ─── Attack 8 (status honesty during the live sweep) ─────────────────────────

Deno.test({
  name: "attack: while the sweeping worker still holds its live lease after the Auth delete, /delete-status must not already say `blocked`",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      await seedOwner(sql, OWNER, SESSION, IDENTITY);
      const calls: WireCall[] = [];
      let observed: { status: number; body: unknown } | null = null;
      const rpc = wireRpc(sql, calls);
      const begun = await begin(sql, rpc, OWNER);
      const deps: AccountDeletionConfirmDependencies = {
        ...dependencies(sql, calls, SESSION, {}, () => false),
        deleteAuthUser: async (ownerId) => {
          await sql.unsafe(`delete from auth.users where id = $1`, [ownerId]);
          // the app's status poll lands while the worker is sweeping
          observed = await deleteStatusRoute(rpc, begun.operationId, begun.statusCapability);
          return {};
        },
      };
      const result = await confirmAccountDeletionOperation(rpc, deps, OWNER, {
        challenge: begun.challenge,
        operationId: begun.operationId,
      });
      assertEquals(result.outcome, "completed");
      assert(observed !== null);
      const body = (observed as { status: number; body: Row }).body;
      assertEquals(
        body.state,
        "in_progress",
        `a live lease is held and the sweep is running, yet the status poll answered ${JSON.stringify(
          body,
        )} — the app renders \`blocked\` as "the server declined to delete this account"`,
      );
    } finally {
      await sql.end();
    }
  },
});

// ─── Attack 9 (unauthorised roles on the new and changed SQL surfaces) ───────

Deno.test({
  name: "attack: owner and anon cannot fail, claim, set intent or certify an operation; the service can (allowed and denied paths)",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      await seedOwner(sql, OWNER, SESSION, IDENTITY);
      const calls: WireCall[] = [];
      const rpc = wireRpc(sql, calls);
      const begun = await begin(sql, rpc, OWNER);
      const statements = [
        `select public.fail_account_deletion_operation('${OWNER}', '${begun.operationId}', gen_random_uuid(), 'completion_unverified')`,
        `select public.claim_account_deletion_work('${OWNER}', '${begun.operationId}')`,
        `select public.set_account_deletion_auth_intent('${OWNER}', '${begun.operationId}', gen_random_uuid())`,
        `select public.certify_account_deletion_completion('${OWNER}', '${begun.operationId}', gen_random_uuid())`,
        `select public.read_account_deletion_receipt('${OWNER}', '${begun.operationId}')`,
        `select * from api_private.account_deletion_operations where owner_id = '${OWNER}'`,
      ];
      for (const statement of statements) {
        // the owner, with a live API session
        const owner = await sql
          .begin(async (tx) => {
            await asOwner(tx as unknown as Tx, OWNER, SESSION);
            await tx.unsafe(statement);
          })
          .then(
            () => null,
            (error: unknown) => (error as { code?: string }).code ?? null,
          );
        assertEquals(owner, "42501", `owner: ${statement}`);
        const anon = await sql
          .begin(async (tx) => {
            await tx.unsafe(`set local role anon`);
            await tx.unsafe(statement);
          })
          .then(
            () => null,
            (error: unknown) => (error as { code?: string }).code ?? null,
          );
        assertEquals(anon, "42501", `anon: ${statement}`);
      }
      // the service reaches the RPCs (allowed path) but never the table
      const service = await sql
        .begin(async (tx) => {
          await tx.unsafe(`set local role service_role`);
          await tx.unsafe(statements[5]);
        })
        .then(
          () => null,
          (error: unknown) => (error as { code?: string }).code ?? null,
        );
      assertEquals(service, "42501", "service: direct table read");
      const certify = await rpc("certify_account_deletion_completion", {
        p_owner_id: OWNER,
        p_operation_id: begun.operationId,
        p_lease_token: crypto.randomUUID(),
      });
      assertEquals(certify.error, null);
      assertEquals(certify.data, { outcome: "stale_lease" });
      assertEquals((await durableRow(sql, begun.operationId)).confirmed_at, null);
    } finally {
      await sql.end();
    }
  },
});

// ─── Attack 10 (free-rating conservation across every deletion verdict) ─────

Deno.test({
  name: "attack: the free-rating ledger is byte-identical across the Auth delete, a residue verdict and a certification",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      await seedOwner(sql, OWNER, SESSION, IDENTITY);
      const identityHash = (
        await sql.unsafe(`select public.free_rating_identity_hash('google', '${IDENTITY}') as h`)
      )[0].h as string;
      await sql.unsafe(
        `insert into public.free_rating_ledger (identity_hash, scored_count) values ('${identityHash}', 2)
           on conflict (identity_hash) do update set scored_count = 2`,
      );
      const before = await sql.unsafe(
        `select * from public.free_rating_ledger order by identity_hash`,
      );
      const calls: WireCall[] = [];
      const rpc = wireRpc(sql, calls);
      const begun = await begin(sql, rpc, OWNER);
      const deps = dependencies(sql, calls, SESSION, {}, () => false);
      const result = await confirmAccountDeletionOperation(rpc, deps, OWNER, {
        challenge: begun.challenge,
        operationId: begun.operationId,
      });
      assertEquals(result.outcome, "completed");
      const lease = (
        calls.find((call) => call.name === "confirm_account_deletion_operation")?.data as Row
      ).leaseToken;
      // late verdicts against the certified row
      await rpc("fail_account_deletion_operation", {
        p_owner_id: OWNER,
        p_operation_id: begun.operationId,
        p_lease_token: lease,
        p_error_code: "completion_unverified",
      });
      await rpc("certify_account_deletion_completion", {
        p_owner_id: OWNER,
        p_operation_id: begun.operationId,
        p_lease_token: lease,
      });
      const after = await sql.unsafe(
        `select * from public.free_rating_ledger order by identity_hash`,
      );
      assertEquals([...after], [...before]);
      // signing in again with the same Google account continues from 2
      assertEquals(
        (
          await sql.unsafe(
            `select scored_count from public.free_rating_ledger where identity_hash = '${identityHash}'`,
          )
        ).map((row) => Number(row.scored_count)),
        [2],
      );
    } finally {
      await sql.end();
    }
  },
});
