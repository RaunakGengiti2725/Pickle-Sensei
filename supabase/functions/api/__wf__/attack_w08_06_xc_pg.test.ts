// W08-06 ADVERSARY (live PostgreSQL): the deletion state machine from
// 20260907001500_account_deletion_operations.sql on a REAL Postgres 16 with
// every migration applied (./xc_pg_up.sh) — the durable-receipt-after-Auth
// boundary that attack #2 (route file) depends on, unauthorised roles for the
// new SQL surfaces (allowed AND denied), two connections contending for one
// operation, cross-owner claims, the free-rating ledger surviving deletion,
// and the SQL-layer ordering guards.
//
//   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
//     deno test -A --no-check --config deno.json attack_w08_06_xc_pg.test.ts
//
// Without XC_PG_URL every test is `ignore`d — an ignored run is NOT a pass.
import postgres from "postgres";
import { assert, assertEquals, assertRejects } from "@std/assert";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

// Distinct id block from every other xc_pg_* suite so one DB can be shared.
const OWNER = "0000000a-0806-4000-8000-000000000001";
const OTHER = "0000000a-0806-4000-8000-000000000002";
const SESSION = "0000000a-0806-4000-8000-000000000101";
const OTHER_SESSION = "0000000a-0806-4000-8000-000000000102";
const APPLE_SUBJECT = "001234.w0806attack.5678";

const sha = (text: string) => `sha256(convert_to('${text}', 'UTF8'))`;

function connect(max = 1): Sql {
  return postgres(PG_URL, { max, onnotice: () => {} });
}

async function resetOwners(sql: Sql): Promise<void> {
  await sql.unsafe(
    `delete from api_private.account_deletion_operations where owner_id in ('${OWNER}','${OTHER}')`,
  );
  await sql.unsafe(`delete from auth.users where id in ('${OWNER}','${OTHER}')`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values
       ('${OWNER}', 'w0806-owner@example.com', '{"provider":"apple"}'),
       ('${OTHER}', 'w0806-other@example.com', '{"provider":"google"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider_id, user_id, provider, identity_data) values
       ('${APPLE_SUBJECT}', '${OWNER}', 'apple', '{"sub":"${APPLE_SUBJECT}"}'),
       ('w0806-other-google', '${OTHER}', 'google', '{"sub":"w0806-other-google"}')`,
  );
  await sql.unsafe(
    `insert into auth.sessions (id, user_id) values ('${SESSION}', '${OWNER}'), ('${OTHER_SESSION}', '${OTHER}')`,
  );
  await sql.unsafe(
    `insert into public.profiles (id, provider, email, display_name) values
       ('${OWNER}', 'apple', 'w0806-owner@example.com', 'W0806')
     on conflict (id) do nothing`,
  );
}

async function asServiceRole(tx: Tx): Promise<void> {
  await tx.unsafe(`set local role service_role`);
}

async function asUser(tx: Tx, userId: string, sessionId: string): Promise<void> {
  await tx.unsafe(`select set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', public.get_api_request_key())::text, true)`);
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
  await tx.unsafe(`set local request.jwt.claims = '{"session_id":"${sessionId}"}'`);
}

interface Claim {
  outcome: string;
  operationId?: string;
  leaseToken?: string;
  status?: Record<string, unknown>;
}

/** Drives the operation through request → confirm → Apple → RevenueCat →
 * external_complete → auth intent exactly as the Edge worker does (via the
 * service_role-granted RPCs), stopping right before Auth deletion. */
async function readyForAuthDeletion(
  sql: Sql,
  owner: string,
  operationId: string,
  challenge: string,
) {
  const begun = await sql.begin(async (tx) => {
    await asServiceRole(tx as unknown as Tx);
    const rows = await tx.unsafe(
      `select public.begin_account_deletion_operation('${owner}', '${operationId}',
         ${sha(`pickle-sensei/account-deletion/challenge/v1/${owner}/${challenge}`)},
         ${sha(`pickle-sensei/account-deletion/status/v1/${owner}/${challenge}`)}) as r`,
    );
    return rows[0].r as Claim;
  });
  assertEquals(begun.outcome, "requested");
  // the RPC refuses a confirm within 3 s of the request
  await sql.unsafe(
    `update api_private.account_deletion_operations set created_at = created_at - interval '10 seconds',
       challenge_expires_at = challenge_expires_at - interval '10 seconds',
       status_expires_at = status_expires_at - interval '10 seconds',
       retain_until = retain_until - interval '10 seconds' where id = '${operationId}'`,
  );
  const claim = await sql.begin(async (tx) => {
    await asServiceRole(tx as unknown as Tx);
    const rows = await tx.unsafe(
      `select public.confirm_account_deletion_operation('${owner}',
         ${
        sha(`pickle-sensei/account-deletion/challenge/v1/${owner}/${challenge}`)
      }, '${operationId}') as r`,
    );
    return rows[0].r as Claim;
  });
  assertEquals(claim.outcome, "claimed", JSON.stringify(claim));
  const lease = claim.leaseToken as string;
  const checkpoint = (name: string, apple: string | null) =>
    sql.begin(async (tx) => {
      await asServiceRole(tx as unknown as Tx);
      const rows = await tx.unsafe(
        `select public.checkpoint_account_deletion_operation('${owner}', '${operationId}', '${lease}', '${name}', ${
          apple === null ? "null" : `'${apple}'`
        }) as r`,
      );
      return rows[0].r as Claim;
    });
  return { lease, checkpoint };
}

Deno.test({
  name:
    "ATTACK W08-06 #15 (live PG): once Auth is deleted the durable status is `completed`, the deleting session is gone, and the claim can never be re-acquired — the residue retry path does not exist",
  ignore,
  async fn() {
    const sql = connect();
    try {
      await resetOwners(sql);
      const operationId = "0000000a-0806-4000-8000-000000001001";
      const challenge = "0000000a-0806-4000-8000-000000002001";
      const { lease, checkpoint } = await readyForAuthDeletion(sql, OWNER, operationId, challenge);
      assertEquals((await checkpoint("apple", "manual_action_required")).outcome, "checkpointed");
      assertEquals((await checkpoint("revenuecat", null)).outcome, "checkpointed");
      assertEquals((await checkpoint("external_complete", null)).outcome, "checkpointed");
      const intent = await sql.begin(async (tx) => {
        await asServiceRole(tx as unknown as Tx);
        const rows = await tx.unsafe(
          `select public.set_account_deletion_auth_intent('${OWNER}', '${operationId}', '${lease}') as r`,
        );
        return rows[0].r as Claim;
      });
      assertEquals(intent.outcome, "intent_recorded");

      // Live session is accepted right up to Auth deletion.
      const liveBefore = await sql.begin(async (tx) => {
        await asUser(tx as unknown as Tx, OWNER, SESSION);
        return (await tx.unsafe(`select public.is_api_session_active() as live`))[0].live;
      });
      assertEquals(liveBefore, true);

      // Auth admin deleteUser == `delete from auth.users`.
      await sql.unsafe(`delete from auth.users where id = '${OWNER}'`);

      const receipt = (
        await sql.unsafe(
          `select public.read_account_deletion_receipt('${OWNER}', '${operationId}') as r`,
        )
      )[0].r as Record<string, unknown>;
      assertEquals(
        receipt.state,
        "completed",
        "durable state is completed the instant auth.users loses the row",
      );
      assert(receipt.completionReceipt !== null);
      const status = (
        await sql.unsafe(
          `select public.read_account_deletion_status('${operationId}',
             ${sha(`pickle-sensei/account-deletion/status/v1/${OWNER}/${challenge}`)}) as r`,
        )
      )[0].r as Record<string, unknown>;
      assertEquals(status.state, "completed", "the status capability the app polls says completed");

      // The deleting session cascaded away with auth.users, so any retry the
      // Edge worker wants to make (verifyLiveSession first) is refused.
      const sessions = await sql.unsafe(
        `select count(*)::int as n from auth.sessions where user_id = '${OWNER}'`,
      );
      assertEquals(sessions[0].n, 0);
      const liveAfter = await sql.begin(async (tx) => {
        await asUser(tx as unknown as Tx, OWNER, SESSION);
        return (await tx.unsafe(`select public.is_api_session_active() as live`))[0].live;
      });
      assertEquals(liveAfter, false);

      // Even the worker's own claim RPC only ever re-serves `completed`.
      const reclaim = await sql.begin(async (tx) => {
        await asServiceRole(tx as unknown as Tx);
        return (await tx.unsafe(
          `select public.claim_account_deletion_work('${OWNER}', '${operationId}') as r`,
        ))[0].r as Claim;
      });
      assertEquals(reclaim.outcome, "completed");
      // No RPC exists that can move a completed operation back to unverified:
      // `fail_account_deletion_operation('completion_unverified')` needs the
      // lease the completed row no longer carries.
      const fail = await sql.begin(async (tx) => {
        await asServiceRole(tx as unknown as Tx);
        return (await tx.unsafe(
          `select public.fail_account_deletion_operation('${OWNER}', '${operationId}', '${lease}', 'completion_unverified') as r`,
        ))[0].r as Claim;
      });
      assertEquals(fail.outcome, "stale_lease");
      const after = (
        await sql.unsafe(
          `select public.read_account_deletion_receipt('${OWNER}', '${operationId}') as r`,
        )
      )[0].r as Record<string, unknown>;
      assertEquals(
        after.state,
        "completed",
        "residue verdicts cannot be recorded against the durable row",
      );
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "ATTACK W08-06 #16 (live PG): anon/authenticated are denied every deletion RPC and every retained/private table; service_role is allowed",
  ignore,
  async fn() {
    const sql = connect();
    try {
      await resetOwners(sql);
      const calls = [
        `public.begin_account_deletion_operation('${OWNER}', gen_random_uuid(), ${sha("a")}, ${
          sha("b")
        })`,
        `public.confirm_account_deletion_operation('${OWNER}', ${sha("a")}, null)`,
        `public.claim_account_deletion_work('${OWNER}', gen_random_uuid())`,
        `public.checkpoint_account_deletion_operation('${OWNER}', gen_random_uuid(), gen_random_uuid(), 'apple', 'revoked')`,
        `public.set_account_deletion_auth_intent('${OWNER}', gen_random_uuid(), gen_random_uuid())`,
        `public.fail_account_deletion_operation('${OWNER}', gen_random_uuid(), gen_random_uuid(), 'completion_unverified')`,
        `public.read_account_deletion_status(gen_random_uuid(), ${sha("c")})`,
        `public.read_account_deletion_receipt('${OWNER}', gen_random_uuid())`,
        `public.store_account_apple_credential('${OWNER}', 'x')`,
        `public.account_deletion_allows_apple_bootstrap('${OWNER}')`,
      ];
      const reads = [
        `select * from public.account_external_credentials`,
        `select * from public.free_rating_ledger`,
        `select * from api_private.account_deletion_operations`,
        `select * from api_private.billing_verification_tickets`,
        `select * from public.webhook_events`,
      ];
      for (const role of ["anon", "authenticated"]) {
        for (const call of calls) {
          await assertRejects(
            () =>
              sql.begin(async (tx) => {
                if (role === "authenticated") await asUser(tx as unknown as Tx, OWNER, SESSION);
                else await tx.unsafe(`set local role anon`);
                await tx.unsafe(`select ${call}`);
              }),
            Error,
            "permission denied",
            `${role}: ${call}`,
          );
        }
        for (const read of reads) {
          await assertRejects(
            () =>
              sql.begin(async (tx) => {
                if (role === "authenticated") await asUser(tx as unknown as Tx, OWNER, SESSION);
                else await tx.unsafe(`set local role anon`);
                await tx.unsafe(read);
              }),
            Error,
            "permission denied",
            `${role}: ${read}`,
          );
        }
      }
      // Allowed path: service_role can read status/receipt for a foreign id
      // (returns null, never raises) and can begin an operation.
      const allowed = await sql.begin(async (tx) => {
        await asServiceRole(tx as unknown as Tx);
        const status = (await tx.unsafe(`select ${calls[6]} as r`))[0].r;
        const receipt = (await tx.unsafe(`select ${calls[7]} as r`))[0].r;
        const begun = (await tx.unsafe(`select ${calls[0]} as r`))[0].r as Claim;
        return { status, receipt, begun: begun.outcome };
      });
      assertEquals(allowed, { status: null, receipt: null, begun: "requested" });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "ATTACK W08-06 #17 (live PG): two connections confirming the same operation get exactly one lease; another owner cannot claim or read it",
  ignore,
  async fn() {
    const sql = connect(4);
    try {
      await resetOwners(sql);
      const operationId = "0000000a-0806-4000-8000-000000001003";
      const challenge = "0000000a-0806-4000-8000-000000002003";
      const hash = sha(`pickle-sensei/account-deletion/challenge/v1/${OWNER}/${challenge}`);
      const begun = await sql.begin(async (tx) => {
        await asServiceRole(tx as unknown as Tx);
        return (await tx.unsafe(
          `select public.begin_account_deletion_operation('${OWNER}', '${operationId}', ${hash},
             ${sha(`pickle-sensei/account-deletion/status/v1/${OWNER}/${challenge}`)}) as r`,
        ))[0].r as Claim;
      });
      assertEquals(begun.outcome, "requested");
      await sql.unsafe(
        `update api_private.account_deletion_operations set created_at = created_at - interval '10 seconds',
       challenge_expires_at = challenge_expires_at - interval '10 seconds',
       status_expires_at = status_expires_at - interval '10 seconds',
       retain_until = retain_until - interval '10 seconds' where id = '${operationId}'`,
      );
      const confirm = () =>
        sql.begin(async (tx) => {
          await asServiceRole(tx as unknown as Tx);
          return (await tx.unsafe(
            `select public.confirm_account_deletion_operation('${OWNER}', ${hash}, '${operationId}') as r`,
          ))[0].r as Claim;
        });
      const results = await Promise.all([confirm(), confirm(), confirm(), confirm()]);
      const outcomes = results.map((r) => r.outcome).sort();
      assertEquals(outcomes, ["busy", "busy", "busy", "claimed"], JSON.stringify(results));
      const leases = results.filter((r) => r.leaseToken).map((r) => r.leaseToken);
      assertEquals(leases.length, 1);
      const attempts = await sql.unsafe(
        `select attempts, lease_token::text as lease from api_private.account_deletion_operations where id = '${operationId}'`,
      );
      assertEquals(attempts[0].attempts, 1, "busy callers do not burn attempts");
      assertEquals(attempts[0].lease, leases[0]);

      // Cross-owner: OTHER cannot claim, checkpoint, or read OWNER's operation.
      const foreign = await sql.begin(async (tx) => {
        await asServiceRole(tx as unknown as Tx);
        const claim = (await tx.unsafe(
          `select public.claim_account_deletion_work('${OTHER}', '${operationId}') as r`,
        ))[0].r as Claim;
        const checkpoint = (await tx.unsafe(
          `select public.checkpoint_account_deletion_operation('${OTHER}', '${operationId}', '${
            leases[0]
          }', 'lease_check', null) as r`,
        ))[0].r as Claim;
        const receipt = (await tx.unsafe(
          `select public.read_account_deletion_receipt('${OTHER}', '${operationId}') as r`,
        ))[0].r;
        return { claim: claim.outcome, checkpoint: checkpoint.outcome, receipt };
      });
      assertEquals(foreign, { claim: "invalid", checkpoint: "stale_lease", receipt: null });
      // and OTHER's own auth row is untouched
      assertEquals(
        (await sql.unsafe(`select count(*)::int as n from auth.users where id = '${OTHER}'`))[0].n,
        1,
      );
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "ATTACK W08-06 #18 (live PG): free-rating ledger survives deletion and re-binds to the same Apple identity; the ticket table the sweep ignores does cascade",
  ignore,
  async fn() {
    const sql = connect();
    try {
      await resetOwners(sql);
      await sql.unsafe(
        `delete from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('apple', '${APPLE_SUBJECT}')`,
      );
      await sql.unsafe(
        `insert into public.free_rating_ledger (identity_hash, scored_count)
           values (public.free_rating_identity_hash('apple', '${APPLE_SUBJECT}'), 2)`,
      );
      await sql.unsafe(
        `insert into api_private.billing_verification_tickets (user_id, verification_order) values ('${OWNER}', 1)`,
      );
      const before = await sql.begin(async (tx) => {
        await asUser(tx as unknown as Tx, OWNER, SESSION);
        return (await tx.unsafe(`select public.identity_scored_count() as n`))[0].n;
      });
      assertEquals(before, 2);

      await sql.unsafe(`delete from auth.users where id = '${OWNER}'`);

      const ledger = await sql.unsafe(
        `select scored_count from public.free_rating_ledger
           where identity_hash = public.free_rating_identity_hash('apple', '${APPLE_SUBJECT}')`,
      );
      assertEquals(ledger.length, 1, "the ledger row has no FK and is retained");
      assertEquals(ledger[0].scored_count, 2);
      const tickets = await sql.unsafe(
        `select count(*)::int as n from api_private.billing_verification_tickets where user_id = '${OWNER}'`,
      );
      assertEquals(
        tickets[0].n,
        0,
        "billing_verification_tickets cascades from auth.users (not swept, not recorded)",
      );

      // Sign in again with the same Apple ID → fresh account, same subject.
      const reborn = "0000000a-0806-4000-8000-000000000003";
      const rebornSession = "0000000a-0806-4000-8000-000000000103";
      await sql.unsafe(`delete from auth.users where id = '${reborn}'`);
      await sql.unsafe(
        `insert into auth.users (id, email, raw_app_meta_data) values ('${reborn}', 'w0806-reborn@example.com', '{"provider":"apple"}')`,
      );
      await sql.unsafe(
        `insert into auth.identities (provider_id, user_id, provider, identity_data) values
           ('${APPLE_SUBJECT}', '${reborn}', 'apple', '{"sub":"${APPLE_SUBJECT}"}')`,
      );
      await sql.unsafe(
        `insert into auth.sessions (id, user_id) values ('${rebornSession}', '${reborn}')`,
      );
      const after = await sql.begin(async (tx) => {
        await asUser(tx as unknown as Tx, reborn, rebornSession);
        const n = (await tx.unsafe(`select public.identity_scored_count() as n`))[0].n;
        const lifetime = (await tx.unsafe(`select public.lifetime_scored_count() as n`))[0].n;
        return { n, lifetime };
      });
      assertEquals(after, { n: 2, lifetime: 2 }, "used free ratings are not restored");
      await sql.unsafe(`delete from auth.users where id = '${reborn}'`);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "ATTACK W08-06 #19 (live PG): SQL-layer ordering — RevenueCat/auth-intent before Apple, wrong Apple outcome, bad error code, short hash all refuse",
  ignore,
  async fn() {
    const sql = connect();
    try {
      await resetOwners(sql);
      const operationId = "0000000a-0806-4000-8000-000000001005";
      const challenge = "0000000a-0806-4000-8000-000000002005";
      const { lease, checkpoint } = await readyForAuthDeletion(sql, OWNER, operationId, challenge);
      await assertRejects(
        () => checkpoint("revenuecat", null),
        Error,
        "Apple cleanup checkpoint is required",
      );
      await assertRejects(
        () => checkpoint("external_complete", null),
        Error,
        "External cleanup checkpoints are required",
      );
      await assertRejects(
        () =>
          sql.begin(async (tx) => {
            await asServiceRole(tx as unknown as Tx);
            await tx.unsafe(
              `select public.set_account_deletion_auth_intent('${OWNER}', '${operationId}', '${lease}')`,
            );
          }),
        Error,
        "External cleanup must precede Auth deletion",
      );
      // Apple: owner is an Apple account without a stored token → expected
      // 'manual_action_required'; claiming 'revoked' or 'not_applicable' is refused.
      await assertRejects(
        () => checkpoint("apple", "revoked"),
        Error,
        "Invalid Apple cleanup checkpoint",
      );
      await assertRejects(
        () => checkpoint("apple", "not_applicable"),
        Error,
        "Invalid Apple cleanup checkpoint",
      );
      await assertRejects(() => checkpoint("bogus", null), Error, "Invalid deletion checkpoint");
      await assertRejects(
        () =>
          sql.begin(async (tx) => {
            await asServiceRole(tx as unknown as Tx);
            await tx.unsafe(
              `select public.fail_account_deletion_operation('${OWNER}', '${operationId}', '${lease}', 'deleted_ok')`,
            );
          }),
        Error,
        "Invalid deletion error code",
      );
      const shortHash = await sql.begin(async (tx) => {
        await asServiceRole(tx as unknown as Tx);
        return (await tx.unsafe(
          `select public.confirm_account_deletion_operation('${OWNER}', '\\x0102'::bytea, '${operationId}') as r`,
        ))[0].r as Claim;
      });
      assertEquals(shortHash.outcome, "invalid");
      // Nothing above moved the row.
      const row = await sql.unsafe(
        `select phase, apple_completed_at, revenuecat_completed_at, external_completed_at, auth_delete_intent_at, completed_at
           from api_private.account_deletion_operations where id = '${operationId}'`,
      );
      assertEquals(row[0].phase, "confirmed");
      for (
        const column of [
          "apple_completed_at",
          "revenuecat_completed_at",
          "external_completed_at",
          "auth_delete_intent_at",
          "completed_at",
        ]
      ) {
        assertEquals(row[0][column], null, column);
      }
      assertEquals(
        (await sql.unsafe(`select count(*)::int as n from auth.users where id = '${OWNER}'`))[0].n,
        1,
      );
    } finally {
      await sql.end();
    }
  },
});
