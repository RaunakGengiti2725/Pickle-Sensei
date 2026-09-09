/**
 * W08-06 ADVERSARIAL ATTACKS — candidate 6e0d32d2 (branch devin/pp/w08-06/impl-r6-c2).
 *
 * Independent attack tests against the post-Auth service sweep
 * (`public.sweep_account_deletion_operations`), the residue-aware
 * certification (`public.certify_account_deletion_completion`), the Edge
 * worker's post-Auth stage and the retention copy. Every test runs against a
 * disposable PostgreSQL with every migration applied (XC_PG_URL); without it
 * the live tests are `ignore`d and an ignored run is NOT a pass.
 *
 * Attack categories (assignment list): boundary values, concurrency/reentrancy,
 * process death + repeated scheduled retries (retry budget), corrupt/partial
 * persisted state, unauthorised roles (allowed AND denied paths), replay of
 * spent leases, network failure in the post-Auth stage (429 + Retry-After,
 * persistent 5xx, redirect-shaped page), free-rating conservation, copy.
 *
 * Nothing here modifies the candidate's production code or its own tests.
 */
import postgres from "postgres";
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import {
  ACCOUNT_OWNER_NAMESPACES,
  INVENTORY_READ_ATTEMPTS,
  INVENTORY_RETRY_AFTER_MAX_MS,
  POST_AUTH_VERIFY_ATTEMPTS,
  accountDeletionStatusResponse,
  beginAccountDeletionOperation,
  confirmAccountDeletionOperation,
  ownerNamespaceSelectColumns,
  type AccountDeletionConfirmDependencies,
  type DeletionOperationRpc,
} from "../accountDeletionOperations.ts";
import { PRIVACY_POLICY_TEXT, SUPPORT_TEXT, TERMS_TEXT } from "../legal.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];
type Row = Record<string, unknown>;

/** Attack owners live in their own uuid range so they never collide with the
 * candidate's fixtures when both suites share one disposable database. */
function attackOwner(seq: number): string {
  return `0000000b-0806-4000-8000-${String(seq).padStart(12, "0")}`;
}
function attackSession(seq: number): string {
  return `0000000b-0806-4000-8000-1${String(seq).padStart(11, "0")}`;
}
function attackIdentity(seq: number): string {
  return `w0806-attack-google-sub-${seq}`;
}

const BLOCKED_NO_RECEIPT = {
  state: "blocked",
  completionReceipt: null,
  appleAuthorizationRevocation: null,
};
const IN_PROGRESS_NO_RECEIPT = {
  state: "in_progress",
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

/** The PostgREST RPC surface as the service role: one transaction per call, a
 * SQL error becomes `{ data: null, error, status: 500 }`. */
function wireRpc(sql: Sql, calls: WireCall[] = []): DeletionOperationRpc {
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

async function asOwner(tx: Tx, userId: string, sessionId: string): Promise<void> {
  await tx.unsafe(`select set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', public.get_api_request_key())::text, true)`);
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
  await tx.unsafe(
    `set local request.jwt.claims = '{"sub":"${userId}","session_id":"${sessionId}"}'`,
  );
}

/** A fresh Google-only owner with history in several namespaces and two free
 * ratings already spent under its sign-in identity. */
async function resetOwner(sql: Sql, seq: number): Promise<string> {
  const owner = attackOwner(seq);
  await sql.unsafe(`delete from api_private.account_deletion_operations where owner_id = $1`, [
    owner,
  ]);
  await sql.unsafe(`delete from auth.users where id = $1`, [owner]);
  await sql.unsafe(
    `delete from auth.users where id in
       (select user_id from auth.identities where provider = 'google' and provider_id = $1)`,
    [attackIdentity(seq)],
  );
  await sql.begin(async (tx) => {
    await tx.unsafe(`alter table public.user_saved_drills disable trigger all`);
    await tx.unsafe(`delete from public.user_saved_drills where user_id = $1`, [owner]);
    await tx.unsafe(`alter table public.user_saved_drills enable trigger all`);
  });
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ($1, $2, '{"provider":"google"}')`,
    [owner, `w0806attack${seq}@example.com`],
  );
  await sql.unsafe(
    `insert into auth.identities (provider_id, user_id, provider, identity_data)
       values ($1, $2, 'google', jsonb_build_object('sub', $1::text))`,
    [attackIdentity(seq), owner],
  );
  await sql.unsafe(`insert into auth.sessions (id, user_id) values ($1, $2)`, [
    attackSession(seq),
    owner,
  ]);
  await sql.unsafe(
    `insert into public.profiles (id, provider, email, display_name) values ($1, 'google', $2, $3)
       on conflict (id) do nothing`,
    [owner, `w0806attack${seq}@example.com`, `ATTACK${seq}`],
  );
  await sql.unsafe(
    `insert into public.sessions (id, user_id, kind, started_at) values (gen_random_uuid(), $1, 'practice', now())`,
    [owner],
  );
  await sql.unsafe(
    `insert into public.user_saved_drills (user_id, slug) values ($1, 'dink-ladder')`,
    [owner],
  );
  await sql.unsafe(
    `insert into public.billing_entitlements (user_id, premium, product_key, expires_at)
       values ($1, false, null, null)`,
    [owner],
  );
  await sql.unsafe(
    `insert into public.free_rating_ledger (identity_hash, scored_count)
       values (public.free_rating_identity_hash('google', $1), 2)
       on conflict (identity_hash) do update set scored_count = 2`,
    [attackIdentity(seq)],
  );
  return owner;
}

interface DurableRow {
  phase: string;
  confirmed_at: Date | null;
  auth_deleted_at: Date | null;
  completed_at: Date | null;
  lease_token: string | null;
  lease_expires_at: Date | null;
  status_expires_at: Date;
  attempts: number;
  last_error_code: string | null;
}

async function durableRow(sql: Sql, operationId: string): Promise<DurableRow> {
  const rows = await sql.unsafe(
    `select phase, confirmed_at, auth_deleted_at, completed_at, lease_token, lease_expires_at,
            status_expires_at, attempts, last_error_code
       from api_private.account_deletion_operations where id = $1`,
    [operationId],
  );
  assertEquals(rows.length, 1, "durable operation row");
  return rows[0] as unknown as DurableRow;
}

interface Begun {
  owner: string;
  operationId: string;
  challenge: string;
  statusCapability: string;
}

/** A requested operation for `owner`, aged past the confirm fence. */
async function begin(sql: Sql, wire: DeletionOperationRpc, owner: string): Promise<Begun> {
  const begun = await beginAccountDeletionOperation(wire, owner);
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
  return {
    owner,
    operationId: begun.operationId,
    challenge: begun.challenge,
    statusCapability: begun.statusCapability,
  };
}

/** Drives a requested operation to the exact durable shape the worker leaves
 * behind when it dies right after the Auth delete: confirmed, every external
 * checkpoint and the deletion intent recorded, then the Auth identity removed
 * (the AFTER DELETE trigger records the absence). `lease` controls what the
 * trigger retains; `ageHours` shifts the whole clock window into the past. */
async function readyPostAuth(
  sql: Sql,
  begun: Begun,
  options: {
    attempts?: number;
    lease?: "none" | "live" | "expired";
    ageHours?: number;
    /** Stop at `confirmed` (no checkpoints): an admin removed the identity
     * before the worker recorded the deletion intent. */
    beforeIntent?: boolean;
  } = {},
): Promise<void> {
  const attempts = options.attempts ?? 1;
  if (options.beforeIntent) {
    await sql.unsafe(
      `update api_private.account_deletion_operations
          set confirmed_at = now(), phase = 'confirmed', attempts = $2
        where id = $1`,
      [begun.operationId, attempts],
    );
  } else {
    await sql.unsafe(
      `update api_private.account_deletion_operations
          set confirmed_at = now(), phase = 'auth_delete_intent', attempts = $2,
              apple_outcome = 'not_applicable', apple_completed_at = now(),
              revenuecat_completed_at = now(), external_completed_at = now(),
              auth_delete_intent_at = now()
        where id = $1`,
      [begun.operationId, attempts],
    );
  }
  if (options.lease === "live") {
    await sql.unsafe(
      `update api_private.account_deletion_operations
          set lease_token = gen_random_uuid(), lease_expires_at = now() + interval '90 seconds'
        where id = $1`,
      [begun.operationId],
    );
  } else if (options.lease === "expired") {
    await sql.unsafe(
      `update api_private.account_deletion_operations
          set lease_token = gen_random_uuid(), lease_expires_at = now() - interval '1 second'
        where id = $1`,
      [begun.operationId],
    );
  }
  await sql.unsafe(`delete from auth.users where id = $1`, [begun.owner]);
  if (options.ageHours) {
    await sql.unsafe(
      `update api_private.account_deletion_operations
          set created_at = created_at - make_interval(hours => $2),
              challenge_expires_at = challenge_expires_at - make_interval(hours => $2),
              status_expires_at = status_expires_at - make_interval(hours => $2),
              retain_until = retain_until - make_interval(hours => $2),
              confirmed_at = confirmed_at - make_interval(hours => $2),
              auth_deleted_at = auth_deleted_at - make_interval(hours => $2)
        where id = $1`,
      [begun.operationId, options.ageHours],
    );
  }
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

async function sweep(wire: DeletionOperationRpc, limit = 50): Promise<SweepReport> {
  const result = await wire("sweep_account_deletion_operations", { p_limit: limit });
  assertEquals(result.error, null, "the sweep RPC failed");
  return result.data as SweepReport;
}

async function sqlAs(sql: Sql, role: string, statement: string): Promise<string | null> {
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`);
      await tx.unsafe(statement);
    });
    return null;
  } catch (thrown) {
    return (thrown as { code?: string }).code ?? "unknown";
  }
}

async function statusRoute(
  wire: DeletionOperationRpc,
  begun: Begun,
): Promise<{ status: number; body: unknown }> {
  const response = await accountDeletionStatusResponse(
    wire,
    new Request("https://edge.test/v1/account/delete-status", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${begun.statusCapability}`,
        "content-type": "application/json",
      },
    }),
    { operationId: begun.operationId },
  );
  return { status: response.status, body: await response.json() };
}

/** Rows a cascade "missed": orphaned owner rows written past the FK and the
 * append-only triggers as the superuser, the shape of durable residue. */
async function orphanedDrills(sql: Sql, owner: string, count: number): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe(`alter table public.user_saved_drills disable trigger all`);
    await tx.unsafe(`delete from public.user_saved_drills where user_id = $1`, [owner]);
    for (let index = 0; index < count; index += 1) {
      await tx.unsafe(`insert into public.user_saved_drills (user_id, slug) values ($1, $2)`, [
        owner,
        `orphan-${index}`,
      ]);
    }
    await tx.unsafe(`alter table public.user_saved_drills enable trigger all`);
  });
}

async function ledgerSnapshot(sql: Sql): Promise<string> {
  const rows = await sql.unsafe(
    `select to_jsonb(l) as row from public.free_rating_ledger l order by identity_hash`,
  );
  return JSON.stringify(rows.map((row) => row.row));
}

/** The ledger's meaning — which identity has spent how many ratings. */
async function ledgerCounts(sql: Sql): Promise<string> {
  const rows = await sql.unsafe(
    `select identity_hash, scored_count from public.free_rating_ledger order by identity_hash`,
  );
  return JSON.stringify(rows.map((row) => [row.identity_hash, Number(row.scored_count)]));
}

async function ownerRowCount(sql: Sql, owner: string): Promise<number> {
  const [row] = await sql.unsafe(
    `select jsonb_array_length(api_private.account_deletion_owner_residue($1)) as n`,
    [owner],
  );
  return Number(row.n);
}

// ---------------------------------------------------------------------------
// ATTACK 1 — boundary values of the sweep batch
// ---------------------------------------------------------------------------
Deno.test({
  name: "ATTACK boundary: sweep batch size — null/0/-1/501/INT_MAX are refused (22023), 1/500/default are accepted, and p_limit=1 certifies exactly the oldest Auth-deleted operation first",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      const wire = wireRpc(sql);
      for (const bad of ["null", "0", "-1", "501", "2147483647", "-2147483648"]) {
        assertEquals(
          await sqlAs(
            sql,
            "service_role",
            `select public.sweep_account_deletion_operations(${bad})`,
          ),
          "22023",
          `p_limit=${bad}`,
        );
      }
      // three ready candidates, deleted in a known order
      const begun = [] as Begun[];
      for (const seq of [101, 102, 103]) {
        const owner = await resetOwner(sql, seq);
        const b = await begin(sql, wire, owner);
        begun.push(b);
        await readyPostAuth(sql, b, { lease: "none" });
        // strictly increasing auth_deleted_at regardless of clock resolution
        await sql.unsafe(
          `update api_private.account_deletion_operations
              set auth_deleted_at = auth_deleted_at + make_interval(secs => $2) where id = $1`,
          [b.operationId, begun.length],
        );
      }
      const ledgerBefore = await ledgerSnapshot(sql);
      const one = await sweep(wire, 1);
      assertEquals(one.scanned, 1);
      assertEquals(one.certified, 1);
      assertEquals(one.operations[0].operationId, begun[0].operationId, "oldest first");
      assertEquals((await durableRow(sql, begun[1].operationId)).completed_at, null);
      assertEquals((await durableRow(sql, begun[2].operationId)).completed_at, null);
      // the maximum and the default batch both accept the rest
      const max = await sweep(wire, 500);
      assertEquals(max.scanned, 2);
      assertEquals(max.certified, 2);
      assertEquals(
        await sqlAs(sql, "service_role", `select public.sweep_account_deletion_operations()`),
        null,
        "default batch",
      );
      for (const b of begun) {
        const row = await durableRow(sql, b.operationId);
        assertEquals(row.phase, "completed");
        assert(row.completed_at !== null);
        assertEquals(row.attempts, 2, "one owner lease + exactly one sweep lease");
      }
      assertEquals((await sweep(wire)).scanned, 0, "idle afterwards");
      assertEquals(await ledgerSnapshot(sql), ledgerBefore, "free-rating ledger untouched");
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATTACK 2 — two scheduled sweeps race over the same candidates
// ---------------------------------------------------------------------------
Deno.test({
  name: "ATTACK concurrency: two sweeps running at once over the same four ready operations certify each exactly once (no double receipt, no error outcome), and a sweep racing a worker that holds a live lease leaves it alone",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4, onnotice: () => {} });
    try {
      const wire = wireRpc(sql);
      const begun = [] as Begun[];
      for (const seq of [111, 112, 113, 114]) {
        const owner = await resetOwner(sql, seq);
        const b = await begin(sql, wire, owner);
        begun.push(b);
        await readyPostAuth(sql, b, { lease: "expired" });
      }
      const ledgerBefore = await ledgerSnapshot(sql);
      const [a, b] = await Promise.all([sweep(wire), sweep(wire)]);
      assertEquals(a.failed + b.failed, 0, JSON.stringify([a, b]));
      assertEquals(a.certified + b.certified, 4, "every operation certified exactly once");
      assertEquals(a.residue + b.residue, 0);
      for (const op of begun) {
        const row = await durableRow(sql, op.operationId);
        assertEquals(row.phase, "completed");
        assert(row.completed_at !== null);
        assertEquals(row.lease_token, null);
        assertEquals(
          row.attempts,
          2,
          "the losing sweep must not have spent a second lease on this row",
        );
        assertEquals(
          [...a.operations, ...b.operations].filter(
            (entry) => entry.operationId === op.operationId && entry.outcome === "certified",
          ).length,
          1,
          "exactly one certified report per operation",
        );
      }
      assertEquals(await ledgerSnapshot(sql), ledgerBefore);

      // a worker still holds a live post-Auth lease: the racing sweep skips it
      const owner = await resetOwner(sql, 115);
      const live = await begin(sql, wire, owner);
      await readyPostAuth(sql, live, { lease: "live" });
      const before = await durableRow(sql, live.operationId);
      const [s1, s2] = await Promise.all([sweep(wire), sweep(wire)]);
      assertEquals(s1.scanned + s2.scanned, 0);
      const after = await durableRow(sql, live.operationId);
      assertEquals(after.lease_token, before.lease_token, "the worker's lease is untouched");
      assertEquals(after.completed_at, null);
      assertEquals(await statusRoute(wire, live), { status: 200, body: IN_PROGRESS_NO_RECEIPT });
      // the worker certifies with its lease; a sweep racing that certification
      // has nothing to do afterwards
      const [certified, s3] = await Promise.all([
        wire("certify_account_deletion_completion", {
          p_owner_id: owner,
          p_operation_id: live.operationId,
          p_lease_token: before.lease_token,
        }),
        sweep(wire),
      ]);
      assertEquals((certified.data as Row).state, "completed");
      assertEquals(s3.certified, 0);
      const done = await durableRow(sql, live.operationId);
      assertEquals(done.attempts, before.attempts, "no extra lease was spent");
      assert(done.completed_at !== null);
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATTACK 3 — the scheduled sweep meets durable residue every minute
// ---------------------------------------------------------------------------
Deno.test({
  name: "ATTACK retry budget: durable residue after the Auth delete stays repairable for the whole 24 h status window — after the scheduled sweep has met the residue repeatedly, repairing the residue must still let the sweep certify exactly once",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      const wire = wireRpc(sql);
      const owner = await resetOwner(sql, 121);
      const begun = await begin(sql, wire, owner);
      await readyPostAuth(sql, begun, { lease: "none" });
      await orphanedDrills(sql, owner, 1);
      const ledgerBefore = await ledgerSnapshot(sql);

      // pg_cron runs the sweep every minute; simulate the minutes passing
      let sweeps = 0;
      for (; sweeps < 20; sweeps += 1) {
        const report = await sweep(wire);
        if (report.scanned === 0) break;
        assertEquals(report.certified, 0, "residue must never certify");
        assertEquals(report.residue, 1);
        assertEquals(report.operations[0].namespaces, [{ table: "user_saved_drills", rows: 1 }]);
        const row = await durableRow(sql, begun.operationId);
        assertEquals(row.completed_at, null, "no receipt while residue remains");
        assertEquals(row.last_error_code, "completion_unverified");
        assertEquals(await statusRoute(wire, begun), { status: 200, body: BLOCKED_NO_RECEIPT });
      }
      const stuck = await durableRow(sql, begun.operationId);
      assert(stuck.completed_at === null);
      assert(
        stuck.status_expires_at.getTime() > Date.now() + 23 * 3_600_000,
        "the status window is still open for ~24 h",
      );

      // the operator repairs the residue well inside the window
      await orphanedDrills(sql, owner, 0);
      assertEquals(await ownerRowCount(sql, owner), 0, "no owner rows remain");
      const repaired = await sweep(wire);
      const row = await durableRow(sql, begun.operationId);
      assertEquals(
        { certified: repaired.certified, phase: row.phase, sweepsBeforeRepair: sweeps },
        { certified: 1, phase: "completed", sweepsBeforeRepair: sweeps },
        `after ${sweeps} scheduled sweeps met the residue (attempts=${stuck.attempts}), the repaired operation is no longer certifiable: state=${JSON.stringify((await statusRoute(wire, begun)).body)}`,
      );
      assert(row.completed_at !== null);
      assertEquals((await sweep(wire)).certified, 0, "exactly once");
      assertEquals(await ledgerSnapshot(sql), ledgerBefore);
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATTACK 4 — corrupt / partial persisted state
// ---------------------------------------------------------------------------
Deno.test({
  name: "ATTACK corrupt state: an identity removed before the deletion intent, an expired status window, a spent attempt budget and an already-completed row are never swept, never claimed, never certified, and /delete-status never promises progress",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      const wire = wireRpc(sql);
      // (a) the admin removed the identity while the worker was between the
      //     confirm and the deletion intent
      const early = await begin(sql, wire, await resetOwner(sql, 131));
      await readyPostAuth(sql, early, { beforeIntent: true, lease: "live" });
      const earlyRow = await durableRow(sql, early.operationId);
      assertEquals(earlyRow.last_error_code, "auth_absent_without_ready_intent");
      assertEquals(earlyRow.lease_token, null, "the trigger dropped the lease");
      assert(earlyRow.auth_deleted_at !== null);
      // (b) a ready phase whose 24 h status window has closed
      const expired = await begin(sql, wire, await resetOwner(sql, 132));
      await readyPostAuth(sql, expired, { lease: "none", ageHours: 25 });
      // (c) a ready phase whose attempt budget is spent
      const exhausted = await begin(sql, wire, await resetOwner(sql, 133));
      await readyPostAuth(sql, exhausted, { lease: "none", attempts: 8 });
      // (d) a completed row
      const done = await begin(sql, wire, await resetOwner(sql, 134));
      await readyPostAuth(sql, done, { lease: "none" });
      assertEquals((await sweep(wire)).certified, 1);
      const doneRow = await durableRow(sql, done.operationId);
      assert(doneRow.completed_at !== null);

      const idle = await sweep(wire);
      assertEquals(idle.scanned, 0, JSON.stringify(idle));
      for (const b of [early, expired, exhausted]) {
        const claim = await wire("claim_account_deletion_work", {
          p_owner_id: b.owner,
          p_operation_id: b.operationId,
        });
        assertEquals((claim.data as Row).outcome, "blocked", b.operationId);
        const forged = await wire("certify_account_deletion_completion", {
          p_owner_id: b.owner,
          p_operation_id: b.operationId,
          p_lease_token: crypto.randomUUID(),
        });
        assertEquals((forged.data as Row).outcome, "stale_lease");
        for (const code of ["completion_unverified", "auth_delete_unavailable"]) {
          const failed = await wire("fail_account_deletion_operation", {
            p_owner_id: b.owner,
            p_operation_id: b.operationId,
            p_lease_token: crypto.randomUUID(),
            p_error_code: code,
          });
          assertEquals((failed.data as Row).outcome, "stale_lease");
        }
        assertEquals((await durableRow(sql, b.operationId)).completed_at, null);
        // an open window answers `blocked`; a closed window is no longer
        // readable at all — either way no progress and no receipt is promised
        assertEquals(
          await statusRoute(wire, b),
          b === expired
            ? { status: 404, body: { error: { code: "account.deletion_status_unavailable" } } }
            : { status: 200, body: BLOCKED_NO_RECEIPT },
        );
      }
      const doneClaim = await wire("claim_account_deletion_work", {
        p_owner_id: done.owner,
        p_operation_id: done.operationId,
      });
      assertEquals((doneClaim.data as Row).outcome, "completed");
      assertEquals(
        (await durableRow(sql, done.operationId)).completed_at?.getTime(),
        doneRow.completed_at.getTime(),
      );
      // (e) the worker that recorded a verdict against the early row cannot
      //     be re-issued a lease through the owner path either
      const acquire = await wire("confirm_account_deletion_operation", {
        p_owner_id: early.owner,
        p_challenge_hash: "\\x" + "00".repeat(32),
        p_operation_id: early.operationId,
      });
      assertNotEquals((acquire.data as Row | null)?.outcome, "claimed");
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATTACK 5 — unauthorised roles for the new surfaces (allowed AND denied)
// ---------------------------------------------------------------------------
Deno.test({
  name: "ATTACK roles: anon/authenticated/PUBLIC cannot execute the sweep, the certification, the residue counter or the certification lock; the service role holds exactly sweep + certify + fail and cannot count residue, lock, read or write the operations table directly",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      const wire = wireRpc(sql);
      const b = await begin(sql, wire, await resetOwner(sql, 141));
      await readyPostAuth(sql, b, { lease: "live" });
      const row = await durableRow(sql, b.operationId);
      const lease = row.lease_token!;
      const calls: Record<string, string> = {
        sweep: `select public.sweep_account_deletion_operations(50)`,
        certify: `select public.certify_account_deletion_completion('${b.owner}', '${b.operationId}', '${lease}')`,
        residue: `select api_private.account_deletion_owner_residue('${b.owner}')`,
        lock: `select api_private.lock_account_deletion_certification('${b.owner}', '${b.operationId}', '${lease}')`,
        view: `select api_private.account_deletion_view(o) from api_private.account_deletion_operations o where id = '${b.operationId}'`,
        read: `select * from api_private.account_deletion_operations where id = '${b.operationId}'`,
        seal: `update api_private.account_deletion_operations set completed_at = now(), phase = 'completed', lease_token = null, lease_expires_at = null where id = '${b.operationId}'`,
        acquire: `select api_private.acquire_account_deletion_lease('${b.owner}', '${b.operationId}')`,
      };
      for (const role of ["anon", "authenticated"]) {
        for (const [name, statement] of Object.entries(calls)) {
          assertEquals(await sqlAs(sql, role, statement), "42501", `${role}: ${name}`);
        }
      }
      for (const name of ["residue", "lock", "view", "read", "seal", "acquire"]) {
        assertEquals(
          await sqlAs(sql, "service_role", calls[name]),
          "42501",
          `service_role: ${name}`,
        );
      }
      // PUBLIC holds nothing on the new functions
      const [grants] = await sql.unsafe(`
        select has_function_privilege('public.sweep_account_deletion_operations(integer)', 'EXECUTE') as sweep_self,
               (select count(*) from information_schema.routine_privileges
                 where specific_schema in ('public', 'api_private')
                   and routine_name in ('sweep_account_deletion_operations', 'certify_account_deletion_completion',
                                        'account_deletion_owner_residue', 'lock_account_deletion_certification')
                   and grantee in ('PUBLIC', 'anon', 'authenticated')) as client_grants,
               (select count(*) from information_schema.routine_privileges
                 where specific_schema = 'api_private'
                   and routine_name in ('account_deletion_owner_residue', 'lock_account_deletion_certification')
                   and grantee = 'service_role') as service_private_grants`);
      assertEquals(Number(grants.client_grants), 0);
      assertEquals(Number(grants.service_private_grants), 0);
      // nothing above moved the row
      const after = await durableRow(sql, b.operationId);
      assertEquals(after.completed_at, null);
      assertEquals(after.lease_token, lease);
      // the allowed path: the service role certifies with the live lease
      assertEquals(await sqlAs(sql, "service_role", calls.certify), null);
      assert((await durableRow(sql, b.operationId)).completed_at !== null);
      assertEquals(await sqlAs(sql, "service_role", calls.sweep), null);
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATTACK 6 — replay of a spent lease against a sealed receipt
// ---------------------------------------------------------------------------
Deno.test({
  name: "ATTACK replay: once the sweep sealed the receipt, the lease it spent (and the worker's earlier lease) replayed against certify, fail, checkpoint and the deletion intent changes nothing — the receipt, phase and error code stay exactly as sealed",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      const wire = wireRpc(sql);
      const b = await begin(sql, wire, await resetOwner(sql, 151));
      await readyPostAuth(sql, b, { lease: "expired" });
      const workerLease = (await durableRow(sql, b.operationId)).lease_token!;
      // capture the sweep's lease token before it is cleared: the claim RPC
      // issues it, then the sweep certifies with it
      const claim = await wire("claim_account_deletion_work", {
        p_owner_id: b.owner,
        p_operation_id: b.operationId,
      });
      assertEquals((claim.data as Row).outcome, "claimed");
      const sweepLease = (claim.data as Row).leaseToken as string;
      const sealed = await wire("certify_account_deletion_completion", {
        p_owner_id: b.owner,
        p_operation_id: b.operationId,
        p_lease_token: sweepLease,
      });
      assertEquals((sealed.data as Row).state, "completed");
      const receipt = await durableRow(sql, b.operationId);
      assert(receipt.completed_at !== null);

      const replays: Array<[string, Record<string, unknown>]> = [];
      for (const token of [workerLease, sweepLease]) {
        const binding = {
          p_owner_id: b.owner,
          p_operation_id: b.operationId,
          p_lease_token: token,
        };
        replays.push(["certify_account_deletion_completion", binding]);
        for (const code of [
          "apple_cleanup_unavailable",
          "revenuecat_cleanup_unavailable",
          "checkpoint_unavailable",
          "auth_delete_unavailable",
          "completion_unverified",
        ]) {
          replays.push(["fail_account_deletion_operation", { ...binding, p_error_code: code }]);
        }
        for (const step of ["lease_check", "revenuecat", "external_complete"]) {
          replays.push([
            "checkpoint_account_deletion_operation",
            { ...binding, p_checkpoint: step, p_apple_outcome: null },
          ]);
        }
        replays.push(["set_account_deletion_auth_intent", binding]);
      }
      for (const [name, parameters] of replays) {
        const result = await wire(name, parameters);
        assertEquals(result.error, null, `${name} raised`);
        const outcome = (result.data as Row).outcome;
        assert(
          outcome === "stale_lease" || outcome === "invalid" || outcome === "completed",
          `${name}: ${JSON.stringify(result.data)}`,
        );
        assertNotEquals(outcome, "released");
        assertNotEquals(outcome, "checkpointed");
        assertNotEquals(outcome, "intent_recorded");
      }
      const after = await durableRow(sql, b.operationId);
      assertEquals(after.completed_at.getTime(), receipt.completed_at.getTime());
      assertEquals(after.phase, "completed");
      assertEquals(after.last_error_code, null);
      assertEquals(after.lease_token, null);
      assertEquals(after.attempts, receipt.attempts);
      const status = await statusRoute(wire, b);
      assertEquals(status.status, 200);
      assertEquals((status.body as Row).state, "completed");
      assertEquals((await sweep(wire)).scanned, 0);
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATTACK 7 — network failure in the worker's post-Auth stage
// ---------------------------------------------------------------------------
interface Faults {
  /** Page reads after the Auth delete answer this instead of rows. */
  page?: (namespace: string) => {
    data: null;
    error: Row | null;
    status: number;
    retryAfterMs?: number;
  };
  /** The certification RPC transport fails with this HTTP status, always. */
  certifyStatus?: number;
}

function workerDependencies(
  sql: Sql,
  seq: number,
  faults: Faults,
  pageReads: string[],
): AccountDeletionConfirmDependencies {
  let authDeleted = false;
  return {
    verifyLiveSession: async () => true,
    revokeAppleCredential: async () => {
      throw new Error("a Google-only owner has no Apple credential to revoke");
    },
    deleteRevenueCatCustomer: async () => {},
    deleteAuthUser: async (ownerId) => {
      await sql.unsafe(`delete from auth.users where id = $1`, [ownerId]);
      authDeleted = true;
      return {};
    },
    readOwnerNamespacePage: async (namespace, ownerId, before, limit) => {
      if (authDeleted) pageReads.push(namespace.table);
      if (authDeleted && faults.page) return faults.page(namespace.table);
      if (before !== null) {
        return { data: null, error: { message: "unexpected keyset page" }, status: 500 };
      }
      try {
        const rows = await sql.begin(async (tx) => {
          await asOwner(tx as unknown as Tx, ownerId, attackSession(seq));
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
          error: { message: String((thrown as Error).message) },
          status: 500,
        };
      }
    },
  };
}

function certifyFaultRpc(wire: DeletionOperationRpc, status: number, count: { n: number }) {
  const faulty: DeletionOperationRpc = async (name, parameters) => {
    if (name === "certify_account_deletion_completion") {
      count.n += 1;
      return { data: null, error: { message: `FAKE transport ${status}` }, status };
    }
    return await wire(name, parameters);
  };
  return faulty;
}

Deno.test({
  name: "ATTACK network: after the Auth delete the owner page reads are paced (429, Retry-After 60 s) — the worker honours the bounded pacing, never certifies, records completion_unverified and releases; /delete-status is blocked without a receipt; the scheduled sweep certifies exactly once",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      const calls: WireCall[] = [];
      const wire = wireRpc(sql, calls);
      const owner = await resetOwner(sql, 161);
      const b = await begin(sql, wire, owner);
      const ledgerBefore = await ledgerSnapshot(sql);
      const pageReads: string[] = [];
      const deps = workerDependencies(
        sql,
        161,
        {
          page: () => ({
            data: null,
            error: { message: "Too Many Requests", code: "PGRST" },
            status: 429,
            retryAfterMs: 60_000,
          }),
        },
        pageReads,
      );
      const started = Date.now();
      const result = await confirmAccountDeletionOperation(wire, deps, owner, {
        challenge: b.challenge,
        operationId: b.operationId,
      });
      const elapsed = Date.now() - started;
      assertEquals(result, { outcome: "unavailable", code: "completion_unverified" });
      // every namespace was retried INVENTORY_READ_ATTEMPTS times, paced by at
      // most INVENTORY_RETRY_AFTER_MAX_MS each — never the relayed 60 s
      assertEquals(pageReads.length, ACCOUNT_OWNER_NAMESPACES.length * INVENTORY_READ_ATTEMPTS);
      assert(
        elapsed < (INVENTORY_READ_ATTEMPTS - 1) * INVENTORY_RETRY_AFTER_MAX_MS + 8_000,
        `worker took ${elapsed} ms`,
      );
      assertEquals(
        calls.filter((call) => call.name === "certify_account_deletion_completion").length,
        0,
        "nothing certified",
      );
      const row = await durableRow(sql, b.operationId);
      assertEquals(row.completed_at, null);
      assertEquals(row.last_error_code, "completion_unverified");
      assertEquals(row.lease_token, null, "released for the sweep");
      assert(row.auth_deleted_at !== null);
      assertEquals(await statusRoute(wire, b), { status: 200, body: BLOCKED_NO_RECEIPT });
      const swept = await sweep(wire);
      assertEquals(swept.certified, 1);
      const done = await durableRow(sql, b.operationId);
      assert(done.completed_at !== null);
      const completed = (await statusRoute(wire, b)).body as {
        state: string;
        completionReceipt: { completedAt: string };
        appleAuthorizationRevocation: string;
      };
      assertEquals(completed.state, "completed");
      assertEquals(completed.appleAuthorizationRevocation, "not_applicable");
      assertEquals(
        Date.parse(completed.completionReceipt.completedAt),
        done.completed_at.getTime(),
        "the receipt is the sweep's seal",
      );
      assertEquals((await sweep(wire)).certified, 0);
      assertEquals(await ledgerSnapshot(sql), ledgerBefore);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ATTACK network: the certification RPC answers 503 on every attempt after the Auth delete — the worker stops after POST_AUTH_VERIFY_ATTEMPTS, hands out no receipt, records the verdict, and the scheduled sweep certifies exactly once",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      const calls: WireCall[] = [];
      const wire = wireRpc(sql, calls);
      const owner = await resetOwner(sql, 162);
      const b = await begin(sql, wire, owner);
      const count = { n: 0 };
      const rpc = certifyFaultRpc(wire, 503, count);
      const deps = workerDependencies(sql, 162, {}, []);
      const result = await confirmAccountDeletionOperation(rpc, deps, owner, {
        challenge: b.challenge,
        operationId: b.operationId,
      });
      assertEquals(result, { outcome: "unavailable", code: "completion_unverified" });
      assertEquals(count.n, POST_AUTH_VERIFY_ATTEMPTS, "bounded certification attempts");
      const row = await durableRow(sql, b.operationId);
      assertEquals(row.completed_at, null);
      assertEquals(row.last_error_code, "completion_unverified");
      assertEquals(row.lease_token, null);
      assertEquals(await statusRoute(wire, b), { status: 200, body: BLOCKED_NO_RECEIPT });
      const swept = await sweep(wire);
      assertEquals(swept.certified, 1);
      assertEquals(
        calls.filter((call) => call.name === "certify_account_deletion_completion").length,
        0,
        "the database never saw a worker certification",
      );
      assert((await durableRow(sql, b.operationId)).completed_at !== null);
      assertEquals((await sweep(wire)).certified, 0);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ATTACK network: a redirect-shaped page (302, no rows, no error) after the Auth delete is never taken as an empty namespace — no receipt, verdict recorded, sweep certifies once",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      const wire = wireRpc(sql);
      const owner = await resetOwner(sql, 163);
      const b = await begin(sql, wire, owner);
      const deps = workerDependencies(
        sql,
        163,
        { page: () => ({ data: null, error: null, status: 302 }) },
        [],
      );
      const result = await confirmAccountDeletionOperation(wire, deps, owner, {
        challenge: b.challenge,
        operationId: b.operationId,
      });
      assertEquals(result, { outcome: "unavailable", code: "completion_unverified" });
      const row = await durableRow(sql, b.operationId);
      assertEquals(row.completed_at, null);
      assertEquals(row.last_error_code, "completion_unverified");
      assertEquals(await statusRoute(wire, b), { status: 200, body: BLOCKED_NO_RECEIPT });
      assertEquals((await sweep(wire)).certified, 1);
      assertEquals((await sweep(wire)).certified, 0);
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATTACK 8 — free-rating conservation across deletion + re-sign-in
// ---------------------------------------------------------------------------
Deno.test({
  name: "ATTACK free ratings: the sweep-certified deletion leaves the identity ledger byte-identical, and a new account signing in with the same Google identity starts from the two ratings already spent",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      const wire = wireRpc(sql);
      const owner = await resetOwner(sql, 171);
      const ledgerBefore = await ledgerSnapshot(sql);
      const countsBefore = await ledgerCounts(sql);
      const b = await begin(sql, wire, owner);
      await readyPostAuth(sql, b, { lease: "none" });
      assertEquals((await sweep(wire)).certified, 1);
      assertEquals(await ledgerSnapshot(sql), ledgerBefore);
      // the same person signs in again: a NEW auth user, the SAME identity
      const reborn = "0000000b-0806-4000-8000-2" + "0".repeat(10) + "1";
      const rebornSession = "0000000b-0806-4000-8000-3" + "0".repeat(10) + "1";
      await sql.unsafe(`delete from auth.users where id = $1`, [reborn]);
      await sql.unsafe(
        `insert into auth.users (id, email, raw_app_meta_data) values ($1, 'reborn171@example.com', '{"provider":"google"}')`,
        [reborn],
      );
      await sql.unsafe(
        `insert into auth.identities (provider_id, user_id, provider, identity_data)
           values ($1, $2, 'google', jsonb_build_object('sub', $1::text))`,
        [attackIdentity(171), reborn],
      );
      await sql.unsafe(`insert into auth.sessions (id, user_id) values ($1, $2)`, [
        rebornSession,
        reborn,
      ]);
      await sql.unsafe(
        `insert into public.profiles (id, provider, email, display_name) values ($1, 'google', 'reborn171@example.com', 'REBORN') on conflict (id) do nothing`,
        [reborn],
      );
      const rows = await sql.begin(async (tx) => {
        await asOwner(tx as unknown as Tx, reborn, rebornSession);
        return await tx.unsafe(
          `select public.lifetime_scored_count() as lifetime, public.identity_scored_count() as identity`,
        );
      });
      assertEquals(Number((rows as unknown as Row[])[0].lifetime), 2);
      assertEquals(Number((rows as unknown as Row[])[0].identity), 2);
      // linking the identity again may touch the row's timestamp (late-linked
      // identity trigger) but never its count
      assertEquals(await ledgerCounts(sql), countsBefore);
      await sql.unsafe(`delete from auth.users where id = $1`, [reborn]);
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATTACK 9 — copy parity with the durable behaviour
// ---------------------------------------------------------------------------
Deno.test({
  name: "ATTACK copy: the retention disclosure carries no forbidden store terms, and its 15 min / 24 h / 7 day figures match the database constraints on the deletion operation record",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
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
        /\d+\s?% accura/i,
        /most accurate/i,
        /best (pickleball )?coach/i,
        /as good as a (human|real) coach/i,
      ];
      for (const [name, text] of [
        ["privacy", PRIVACY_POLICY_TEXT],
        ["terms", TERMS_TEXT],
        ["support", SUPPORT_TEXT],
      ] as const) {
        for (const pattern of forbidden) {
          assert(!pattern.test(text), `${name} copy matches ${pattern}`);
        }
      }
      const [constraints] = await sql.unsafe(`
        select
          (select pg_get_constraintdef(oid) from pg_constraint
            where conrelid = 'api_private.account_deletion_operations'::regclass
              and pg_get_constraintdef(oid) like '%retain_until%') as retain,
          (select pg_get_constraintdef(oid) from pg_constraint
            where conrelid = 'api_private.account_deletion_operations'::regclass
              and pg_get_constraintdef(oid) like '%status_expires_at = %') as status,
          (select pg_get_constraintdef(oid) from pg_constraint
            where conrelid = 'api_private.account_deletion_operations'::regclass
              and pg_get_constraintdef(oid) like '%challenge_expires_at <= %') as challenge`);
      assertStringIncludes(String(constraints.retain), "'7 days'");
      assertStringIncludes(String(constraints.status), "'24:00:00'");
      assertStringIncludes(String(constraints.challenge), "'00:15:00'");
      assertStringIncludes(PRIVACY_POLICY_TEXT, "deletion operation record for\n  7 days");
      assertStringIncludes(PRIVACY_POLICY_TEXT, "show\n  you the outcome for 24 hours");
      assertStringIncludes(PRIVACY_POLICY_TEXT, "deletion challenge expires after 15 minutes");
      // the free-rating ledger disclosure names the retained shape exactly
      assertStringIncludes(PRIVACY_POLICY_TEXT, "survives\n  account deletion");
      assertStringIncludes(SUPPORT_TEXT, "free ratings already spent");
      assertStringIncludes(
        TERMS_TEXT,
        "free ratings already used are not restored by deleting the",
      );
    } finally {
      await sql.end();
    }
  },
});
