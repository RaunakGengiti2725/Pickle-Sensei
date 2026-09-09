// W08-06 adversarial probe (attack branch only): is the post-Auth recovery
// reachable from the SHIPPING Edge surface?
//
// The candidate's round-5 recovery (migration 20260909180000 +
// resumeConfirmedAccountDeletionOperation) is exercised in its own tests by
// calling the worker directly with `verifyLiveSession: async () => true`. The
// shipping confirm route (index.ts confirmAccountDeletion) instead re-checks
// `is_api_session_active()` as the deleting user — and auth.sessions cascades
// from auth.users, so after the Auth delete that check is false. /delete-status
// never resumes work by design. These probes ask what actually happens to a
// deletion whose worker died after deleteUser, through the surfaces the app
// can reach.
//
//   deno test -A --no-check --config deno.json attack_w0806_post_auth_reachability.test.ts
//   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
//     deno test -A --no-check --config deno.json attack_w0806_post_auth_reachability.test.ts
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import {
  ACCOUNT_OWNER_NAMESPACES,
  accountDeletionStatusResponse,
  beginAccountDeletionOperation,
  confirmAccountDeletionOperation,
  ownerNamespaceSelectColumns,
  type AccountDeletionConfirmDependencies,
  type DeletionOperationRpc,
} from "../accountDeletionOperations.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];
type Row = Record<string, unknown>;

const ATK_OWNER = "0806a77a-0000-4000-8000-0000000000a1";
const ATK_SESSION = "0806a77a-0000-4000-8000-0000000090a1";
const ATK_IDENTITY = "w0806-attack-google-sub";
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

/** The PostgREST RPC surface answered by the disposable database as service_role. */
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

async function asOwner(tx: Tx, userId: string, sessionId: string): Promise<void> {
  await tx.unsafe(`select set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', public.get_api_request_key())::text, true)`);
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
  await tx.unsafe(
    `set local request.jwt.claims = '{"sub":"${userId}","session_id":"${sessionId}"}'`,
  );
}

/** Exactly the shipping route's live-session recheck (index.ts
 * confirmAccountDeletion → authed.db.rpc("is_api_session_active")), answered by
 * the database as the deleting user's session. */
function shippingVerifyLiveSession(
  sql: Sql,
): AccountDeletionConfirmDependencies["verifyLiveSession"] {
  return async (ownerId) => {
    if (ownerId !== ATK_OWNER) return false;
    const rows = await sql.begin(async (tx) => {
      await asOwner(tx as unknown as Tx, ATK_OWNER, ATK_SESSION);
      return await tx.unsafe(`select public.is_api_session_active() as live`);
    });
    const live = (rows as unknown as Row[])[0]?.live;
    if (typeof live !== "boolean") throw new Error("Session check unavailable.");
    return live;
  };
}

function ownerReader(sql: Sql): AccountDeletionConfirmDependencies["readOwnerNamespacePage"] {
  return async (namespace, ownerId, before, limit) => {
    if (before !== null) {
      return { data: null, error: { message: "unexpected keyset page" }, status: 500 };
    }
    try {
      const rows = await sql.begin(async (tx) => {
        await asOwner(tx as unknown as Tx, ownerId, ATK_SESSION);
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
  };
}

function shippingDependencies(sql: Sql, calls: WireCall[]): AccountDeletionConfirmDependencies {
  let lost = false;
  return {
    verifyLiveSession: shippingVerifyLiveSession(sql),
    revokeAppleCredential: async () => {
      throw new Error("a Google-only owner has no Apple credential to revoke");
    },
    deleteRevenueCatCustomer: async () => {
      calls.push({ name: "revenuecat_delete", parameters: {}, data: null, error: null });
    },
    deleteAuthUser: async (ownerId) => {
      await sql.unsafe(`delete from auth.users where id = $1`, [ownerId]);
      calls.push({ name: "auth_delete", parameters: { ownerId }, data: null, error: null });
      if (!lost) {
        lost = true;
        // the process dies / the admin response is lost right after deleteUser
        throw new Error("FAKE network: the deleteUser response was lost");
      }
      return {};
    },
    readOwnerNamespacePage: ownerReader(sql),
  };
}

async function seedOwner(sql: Sql, rpc: DeletionOperationRpc) {
  await sql.unsafe(
    `delete from api_private.account_deletion_operations where owner_id = '${ATK_OWNER}'`,
  );
  await sql.unsafe(`delete from auth.users where id = '${ATK_OWNER}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${ATK_OWNER}', 'w0806atk@example.com', '{"provider":"google"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider_id, user_id, provider, identity_data) values ('${ATK_IDENTITY}', '${ATK_OWNER}', 'google', '{"sub":"${ATK_IDENTITY}"}')`,
  );
  await sql.unsafe(
    `insert into auth.sessions (id, user_id) values ('${ATK_SESSION}', '${ATK_OWNER}')`,
  );
  await sql.unsafe(
    `insert into public.profiles (id, provider, email, display_name) values ('${ATK_OWNER}', 'google', 'w0806atk@example.com', 'W0806ATK') on conflict (id) do nothing`,
  );
  const begun = await beginAccountDeletionOperation(rpc, ATK_OWNER);
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

async function durableRow(sql: Sql, operationId: string): Promise<Row> {
  const rows = await sql.unsafe(
    `select phase, auth_deleted_at, completed_at, lease_token, lease_expires_at, attempts, last_error_code
       from api_private.account_deletion_operations where id = $1`,
    [operationId],
  );
  assertEquals(rows.length, 1);
  return rows[0] as unknown as Row;
}

async function statusRoute(rpc: DeletionOperationRpc, operationId: string, capability: string) {
  const response = await accountDeletionStatusResponse(
    rpc,
    new Request("https://edge.test/v1/me/delete-status", {
      method: "POST",
      headers: { Authorization: `Bearer ${capability}`, "content-type": "application/json" },
    }),
    { operationId },
  );
  return { status: response.status, body: await response.json() };
}

// ─── D1: static wiring ───────────────────────────────────────────────────────
Deno.test(
  "ATTACK D1: the post-Auth recovery claim (claim_account_deletion_work / resumeConfirmedAccountDeletionOperation) has a caller in the shipping Edge entry point",
  async () => {
    const entry = await Deno.readTextFile(new URL("../index.ts", import.meta.url));
    const callers = [
      "resumeConfirmedAccountDeletionOperation",
      "claim_account_deletion_work",
    ].filter((symbol) => entry.includes(symbol));
    assert(
      callers.length > 0,
      "index.ts never calls the recovery path: after the deleting session is gone nothing in the shipping app can re-acquire a post-Auth phase",
    );
  },
);

// ─── D2: process death after deleteUser, through the shipping surfaces ───────
Deno.test({
  name: "ATTACK D2 (live PG): worker death after the Auth delete — the app's retried confirm (shipping live-session recheck) or the status poll must eventually certify a clean sweep and hand out the receipt",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      const calls: WireCall[] = [];
      const rpc = wireRpc(sql, calls);
      const begun = await seedOwner(sql, rpc);
      const dependencies = shippingDependencies(sql, calls);

      const first = await confirmAccountDeletionOperation(rpc, dependencies, ATK_OWNER, {
        challenge: begun.challenge,
        operationId: begun.operationId,
      });
      assertEquals(first, { outcome: "unavailable", code: "auth_delete_unavailable" });
      const row = await durableRow(sql, begun.operationId);
      assert(row.auth_deleted_at !== null, "the identity is gone");
      assertEquals(row.completed_at, null, "nothing certified yet");
      assertEquals(
        (await sql.unsafe(`select 1 from auth.sessions where user_id = '${ATK_OWNER}'`)).length,
        0,
        "auth.sessions cascaded with auth.users",
      );

      // every namespace already reads empty as the owner: a clean sweep is possible
      // (the same RLS path the shipping worker uses)
      for (const namespace of ACCOUNT_OWNER_NAMESPACES) {
        const page = await ownerReader(sql)(namespace, ATK_OWNER, null, 10);
        assertEquals(page.error, null, namespace.table);
        assertEquals(page.data, [], namespace.table);
      }

      // surface 1 — the app retries POST /v1/me/delete-confirm with the same
      // challenge (its bearer is still cached ≤10 min): the shipping route
      // rechecks is_api_session_active() first.
      const retried = await confirmAccountDeletionOperation(rpc, dependencies, ATK_OWNER, {
        challenge: begun.challenge,
        operationId: begun.operationId,
      });
      // surface 2 — the status capability never resumes work
      const status = await statusRoute(rpc, begun.operationId, begun.statusCapability);
      const after = await durableRow(sql, begun.operationId);
      const observed = {
        retriedConfirm: retried,
        status,
        durable: {
          phase: after.phase,
          completed_at: after.completed_at,
          last_error_code: after.last_error_code,
        },
        recoveryClaims: calls.filter((call) => call.name === "claim_account_deletion_work").length,
      };
      assertEquals(status.status, 200);
      assertEquals((status.body as Row).completionReceipt, null, "no receipt without a sweep");
      assertEquals(
        retried.outcome,
        "completed",
        `the only shipping caller of the post-Auth recovery is the owner's own confirm, and it is refused: ${JSON.stringify(observed)}`,
      );
    } finally {
      await sql.end();
    }
  },
});

// ─── D3: the orphaned phase, once its window closes ──────────────────────────
Deno.test({
  name: "ATTACK D3 (live PG): an orphaned post-Auth phase whose status window closed is reported blocked with no receipt for an account that was fully deleted — the deletion never certifies through any shipping surface",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      const calls: WireCall[] = [];
      const rpc = wireRpc(sql, calls);
      const begun = await seedOwner(sql, rpc);
      const dependencies = shippingDependencies(sql, calls);
      const first = await confirmAccountDeletionOperation(rpc, dependencies, ATK_OWNER, {
        challenge: begun.challenge,
        operationId: begun.operationId,
      });
      assertEquals(first, { outcome: "unavailable", code: "auth_delete_unavailable" });
      // the retained lease expires, nobody renews it, and the 24 h window closes
      // (every anchored timestamp moves together so the row stays well-formed)
      await sql.unsafe(
        `update api_private.account_deletion_operations
            set created_at = created_at - interval '25 hours',
                challenge_expires_at = challenge_expires_at - interval '25 hours',
                status_expires_at = status_expires_at - interval '25 hours',
                retain_until = retain_until - interval '25 hours',
                lease_expires_at = case when lease_expires_at is null then null
                  else least(lease_expires_at, status_expires_at - interval '25 hours') end
          where id = $1`,
        [begun.operationId],
      );
      const retried = await confirmAccountDeletionOperation(rpc, dependencies, ATK_OWNER, {
        challenge: begun.challenge,
        operationId: begun.operationId,
      });
      assertEquals(retried, { outcome: "rejected", code: "session_invalid" });
      const status = await statusRoute(rpc, begun.operationId, begun.statusCapability);
      const after = await durableRow(sql, begun.operationId);
      assertEquals(after.completed_at, null);
      assertEquals(
        (await sql.unsafe(`select 1 from auth.users where id = '${ATK_OWNER}'`)).length,
        0,
      );
      // the capability window closed: the route answers 404 or blocked, never completed
      assert(
        status.status === 404 ||
          (status.status === 200 && (status.body as Row).state === "blocked"),
        JSON.stringify(status),
      );
      assertEquals(
        calls.filter((call) => call.name === "certify_account_deletion_completion").length,
        0,
        "no certification ever happened",
      );
    } finally {
      await sql.end();
    }
  },
});
