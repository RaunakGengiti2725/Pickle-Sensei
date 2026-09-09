// ADVERSARIAL TESTS for W04-02 (candidate 90bf7e3d) — live postgres half.
// The REAL register_offline_device() / issue_offline_grant() RPCs on the
// disposable postgres:16 (./xc_pg_up.sh, XC_PG_URL) with their rows pushed
// through the candidate's edge claim builder + signer exactly as
// POST /v1/offline/grants does. Additive only.
//
// Attack categories: unauthorised roles (anon / service_role / authenticated
// without a live session / another user's session — allowed AND denied),
// cross-account isolation on one installation key, free-rating conservation
// (re-issue, second device, disconnected allocation never reclaimed),
// concurrency (two sessions racing one device), boundary clocks (far-future
// and sub-second entitlement expiry, expired-but-premium row, `infinity`),
// corrupt persisted state (fail closed, never authorization).
//
// Without XC_PG_URL every test here is `ignore`d — an ignored run is NOT a
// pass; the W04-02-AC2 gate runs with XC_PG_URL set.

import postgres from "postgres";
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { exportJWK, generateKeyPair } from "jose";
import {
  OFFLINE_PRO_LEASE_MAX_SECONDS,
  type OfflineExecutionGrantClaims,
  type OfflineReleasedArtifacts,
} from "../../../../packages/shared-types/src/offlineAuthorization.ts";
import {
  importOfflineGrantSigningKey,
  importOfflineGrantVerificationKey,
  offlineGrantClaimsFromIssuance,
  type OfflineGrantVerificationContext,
  signOfflineExecutionGrant,
  verifyOfflineExecutionGrant,
} from "../offlineSignature.ts";
import { activeReleasePolicyRow, HARNESS_RELEASE_POLICY } from "./releasePolicyFixture.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

const ISSUER = "http://edge.test/functions/v1/api";
const KID = "attack-w04-02-live-key";
const pair = await generateKeyPair("ES256", { extractable: true });
const signingKey = await importOfflineGrantSigningKey({
  ...(await exportJWK(pair.privateKey)),
  kid: KID,
});
const verifyKey = await importOfflineGrantVerificationKey(KID, await exportJWK(pair.publicKey));

const releasePolicyRow = await activeReleasePolicyRow();
const approval = releasePolicyRow.approval as { policy: { version: string; sha256: string } };
const RELEASE: OfflineReleasedArtifacts = {
  policy: approval.policy,
  mechanicsModel: HARNESS_RELEASE_POLICY.mechanics.lineage.model,
  benchmarkModel: HARNESS_RELEASE_POLICY.benchmark.lineage.model,
};

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

const RUN = crypto.randomUUID().slice(0, 8);
const U = (n: number): string => `0000000c-0402-4000-8000-${RUN}00${String(n).padStart(2, "0")}`;
const SESSION = (n: number): string =>
  `0000000c-0402-4000-8000-${RUN}0a${String(n).padStart(2, "0")}`;
const KEY = (name: string): string => `atk-${name}-${RUN}`;

interface IssueRow {
  result: string;
  grant_id: string | null;
  generation: number | null;
  entitlement_source: string | null;
  issued_at: string | null;
  expires_at: string | null;
  entitlement_expires_at: string | null;
  ticket_ids: string[] | null;
}

async function createUser(sql: Sql, n: number): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${U(n)}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data)
     values ('${U(n)}', 'atk-w04-02-${n}-${RUN}@example.com', '{"provider":"google"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
     values ('google', 'atk-w04-02-${n}-${RUN}', '${U(n)}', '{"sub":"atk-w04-02-${n}-${RUN}"}')`,
  );
  await sql.unsafe(`insert into auth.sessions (id, user_id) values ('${SESSION(n)}', '${U(n)}')`);
}

async function asUser(
  tx: Tx,
  n: number,
  options: { apiKey?: boolean; sessionOf?: number | null } = {},
): Promise<void> {
  if (options.apiKey ?? true) {
    await tx.unsafe(`select set_config('request.headers', jsonb_build_object(
      'x-pickle-api-key', public.get_api_request_key())::text, true)`);
  }
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${U(n)}'`);
  const sessionOf = options.sessionOf === undefined ? n : options.sessionOf;
  if (sessionOf !== null) {
    await tx.unsafe(`set local request.jwt.claims = '{"session_id":"${SESSION(sessionOf)}"}'`);
  }
}

function inTx<T>(sql: Sql, n: number | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    if (n !== null) await asUser(tx as unknown as Tx, n);
    return await fn(tx as unknown as Tx);
  }) as Promise<T>;
}

async function register(tx: Tx, key: string, attested = true, env = "production"): Promise<string> {
  const rows = await tx.unsafe<{ result: string }[]>(
    `select r.result from public.register_offline_device('${key}', '${env}', ${attested}) r`,
  );
  return rows[0].result;
}

/** The RPC row exactly as PostgREST would serialize it (to_jsonb). */
async function issueRow(tx: Tx, key: string, requested = 2): Promise<IssueRow> {
  const rows = await tx.unsafe<{ row: IssueRow }[]>(
    `select to_jsonb(g) as row from public.issue_offline_grant('${key}', ${requested}) g`,
  );
  return rows[0].row;
}

function context(ownerId: string, installationKeyId: string): OfflineGrantVerificationContext {
  return {
    binding: { issuer: ISSUER, allowedKeyIds: [KID], ownerId, installationKeyId },
    release: RELEASE,
    nowEpochSeconds: Math.floor(Date.now() / 1000),
  };
}

/** Exactly what issueOfflineGrant() does after an accepted row: build → sign → (client) verify. */
async function buildSignVerify(
  row: unknown,
  ownerId: string,
  installationKeyId: string,
): Promise<OfflineExecutionGrantClaims> {
  const claims = offlineGrantClaimsFromIssuance(row, {
    issuer: ISSUER,
    ownerId,
    installationKeyId,
    release: RELEASE,
  });
  const signed = await signOfflineExecutionGrant(
    claims,
    signingKey,
    context(ownerId, installationKeyId),
  );
  return (await verifyOfflineExecutionGrant(
    signed,
    [verifyKey],
    context(ownerId, installationKeyId),
  ))
    .claims;
}

async function sqlErrorCode(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "";
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown";
  }
}

async function count(sql: Sql, query: string): Promise<number> {
  const rows = await sql.unsafe<{ n: string }[]>(`select count(*)::text as n from ${query}`);
  return Number(rows[0].n);
}

// ---------------------------------------------------------------------------
// ATTACK A — unauthorised roles for the two new SQL surfaces.
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "ATTACK roles (live DB): anon / service_role / no API key / no session / another user's session are refused by both RPCs; the live caller is admitted",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    try {
      await createUser(sql, 1);
      await createUser(sql, 2);
      const key = KEY("roles");
      const registerCall =
        `select * from public.register_offline_device('${key}', 'production', false)`;
      const issueCall = `select * from public.issue_offline_grant('${key}', 2)`;

      for (const call of [registerCall, issueCall]) {
        // anon / service_role: EXECUTE revoked.
        for (const role of ["anon", "service_role"]) {
          const code = await sqlErrorCode(() =>
            sql.begin(async (tx) => {
              await tx.unsafe(`set local role ${role}`);
              await tx.unsafe(call);
            })
          );
          assertEquals(code, "42501", `${role}: ${call}`);
        }
        // authenticated, live session, but not through the edge fn (no API key).
        assertEquals(
          await sqlErrorCode(() =>
            sql.begin(async (tx) => {
              await asUser(tx as unknown as Tx, 1, { apiKey: false });
              await tx.unsafe(call);
            })
          ),
          "42501",
          `no api key: ${call}`,
        );
        // authenticated through the edge fn but the session claim is missing.
        assertEquals(
          await sqlErrorCode(() =>
            sql.begin(async (tx) => {
              await asUser(tx as unknown as Tx, 1, { sessionOf: null });
              await tx.unsafe(call);
            })
          ),
          "42501",
          `no session: ${call}`,
        );
        // authenticated as user 1 presenting user 2's live session id.
        assertEquals(
          await sqlErrorCode(() =>
            sql.begin(async (tx) => {
              await asUser(tx as unknown as Tx, 1, { sessionOf: 2 });
              await tx.unsafe(call);
            })
          ),
          "42501",
          `foreign session: ${call}`,
        );
        // a revoked (not_after in the past) session.
        await sql.unsafe(
          `update auth.sessions set not_after = now() - interval '1 second' where id = '${
            SESSION(2)
          }'`,
        );
        assertEquals(
          await sqlErrorCode(() =>
            sql.begin(async (tx) => {
              await asUser(tx as unknown as Tx, 2);
              await tx.unsafe(call);
            })
          ),
          "42501",
          `revoked session: ${call}`,
        );
      }
      // Nothing was written by any denied path.
      assertEquals(
        await count(sql, `public.offline_devices where user_id in ('${U(1)}', '${U(2)}')`),
        0,
      );

      // Allowed path: the live caller registers (unattested, as the edge fn
      // sends it) and is then refused a grant for the right reason.
      const registered = await inTx(sql, 1, (tx) => register(tx, key, false));
      assertEquals(registered, "accepted");
      const row = await inTx(sql, 1, (tx) => issueRow(tx, key));
      assertEquals(row.result, "offline.device_not_attested");
      assertEquals(
        await count(sql, `public.offline_grants where user_id = '${U(1)}'`),
        0,
        "an unattested device never spends a generation",
      );

      // The three tables behind the RPCs: anon / service_role have no
      // privilege at all; an owner reads its own rows only, and only through
      // the API (the restrictive api_requests_only policy hides them otherwise);
      // no client role can write.
      const tables = ["offline_devices", "offline_grants", "offline_allocation_ledger"];
      for (const table of tables) {
        for (const role of ["anon", "service_role"]) {
          const code = await sqlErrorCode(() =>
            sql.begin(async (tx) => {
              await tx.unsafe(`set local role ${role}`);
              await tx.unsafe(`select * from public.${table} limit 1`);
            })
          );
          assertEquals(code, "42501", `${role} select ${table}`);
        }
        for (
          const write of [
            `delete from public.${table}`,
            `update public.${table} set user_id = '${U(1)}'`,
          ]
        ) {
          const code = await sqlErrorCode(() =>
            sql.begin(async (tx) => {
              await asUser(tx as unknown as Tx, 1);
              await tx.unsafe(write);
            })
          );
          assertEquals(code, "42501", `authenticated ${write}`);
        }
      }
      // Seed a free grant + 2 tickets for user 2 (attested via the DB path
      // the edge never exposes), then read across the account boundary.
      await createUser(sql, 2);
      await inTx(sql, 2, (tx) => register(tx, KEY("roles-other"), true));
      assertEquals(
        (await inTx(sql, 2, (tx) => issueRow(tx, KEY("roles-other")))).result,
        "accepted",
      );
      const visible = await inTx(sql, 1, async (tx) => {
        const devices = await tx.unsafe<{ installation_key_id: string }[]>(
          `select installation_key_id from public.offline_devices`,
        );
        const grants = await tx.unsafe<{ n: string }[]>(
          `select count(*)::text as n from public.offline_grants`,
        );
        const ledger = await tx.unsafe<{ n: string }[]>(
          `select count(*)::text as n from public.offline_allocation_ledger`,
        );
        return {
          devices: devices.map((r) => r.installation_key_id),
          grants: grants[0].n,
          ledger: ledger[0].n,
        };
      });
      assertEquals(
        visible,
        { devices: [key], grants: "0", ledger: "0" },
        "an owner sees exactly its own rows",
      );
      const other = await inTx(sql, 2, async (tx) => {
        const grants = await tx.unsafe<{ n: string }[]>(
          `select count(*)::text as n from public.offline_grants`,
        );
        const ledger = await tx.unsafe<{ n: string }[]>(
          `select count(*)::text as n from public.offline_allocation_ledger`,
        );
        return { grants: grants[0].n, ledger: ledger[0].n };
      });
      assertEquals(other, { grants: "1", ledger: "2" });
      const noApiKey = await sqlErrorCode(() =>
        sql.begin(async (tx) => {
          await asUser(tx as unknown as Tx, 2, { apiKey: false });
          for (const table of tables) {
            const rows = await tx.unsafe<{ n: string }[]>(
              `select count(*)::text as n from public.${table}`,
            );
            assertEquals(rows[0].n, "0", `outside the API the owner's ${table} rows are invisible`);
          }
        })
      );
      assertEquals(noApiKey, "");
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATTACK B — cross-account isolation on ONE installation key + conservation.
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "ATTACK isolation + conservation (live DB): one installation key across two accounts never shares tickets; re-issue, a second device and a rotated account never mint a third free rating",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    try {
      await createUser(sql, 3);
      await createUser(sql, 4);
      const shared = KEY("shared");

      // Account 3 holds two tickets on the shared installation.
      assertEquals(await inTx(sql, 3, (tx) => register(tx, shared)), "accepted");
      const a1 = await inTx(sql, 3, (tx) => issueRow(tx, shared));
      assertEquals(a1.result, "accepted");
      assertEquals(a1.ticket_ids?.length, 2);
      const claimsA1 = await buildSignVerify(a1, U(3), shared);
      assertEquals(claimsA1.allocation?.ticketIds.length, 2);

      // Account 4 registers the SAME installation key: its own device row,
      // its own tickets, never account 3's.
      assertEquals(await inTx(sql, 4, (tx) => register(tx, shared)), "accepted");
      const b1 = await inTx(sql, 4, (tx) => issueRow(tx, shared));
      assertEquals(b1.result, "accepted");
      assertEquals(b1.ticket_ids?.length, 2);
      for (const t of b1.ticket_ids ?? []) assert(!a1.ticket_ids?.includes(t));
      await buildSignVerify(b1, U(4), shared);
      // A grant signed for account 3 never verifies as account 4's and vice versa.
      for (const [row, owner, wrongOwner] of [[a1, U(3), U(4)], [b1, U(4), U(3)]] as const) {
        const signed = await signOfflineExecutionGrant(
          offlineGrantClaimsFromIssuance(row, {
            issuer: ISSUER,
            ownerId: owner,
            installationKeyId: shared,
            release: RELEASE,
          }),
          signingKey,
          context(owner, shared),
        );
        let crossed = false;
        try {
          await verifyOfflineExecutionGrant(signed, [verifyKey], context(wrongOwner, shared));
          crossed = true;
        } catch {
          // expected
        }
        assert(!crossed, "a grant signed for one owner must never verify for another");
      }

      // Re-issue for account 3: same tickets, next generation, ledger unchanged.
      const a2 = await inTx(sql, 3, (tx) => issueRow(tx, shared));
      assertEquals(a2.result, "accepted");
      assertEquals([...(a2.ticket_ids ?? [])].sort(), [...(a1.ticket_ids ?? [])].sort());
      assertEquals(a2.generation, 2);
      assertNotEquals(a2.grant_id, a1.grant_id);
      const claimsA2 = await buildSignVerify(a2, U(3), shared);
      assertEquals(claimsA2.allocation?.generation, 2);
      assertEquals(claimsA2.allocation?.allocationId, a2.grant_id);
      // requestedTickets 0 / 1 on a device that already holds 2 → still the 2 it holds.
      for (const requested of [0, 1]) {
        const again = await inTx(sql, 3, (tx) => issueRow(tx, shared, requested));
        assertEquals(again.result, "accepted", String(requested));
        assertEquals(again.ticket_ids?.length, 2);
      }
      assertEquals(
        await count(
          sql,
          `public.offline_allocation_ledger where user_id = '${U(3)}' and event = 'allocated'`,
        ),
        2,
        "re-issuing never allocates again",
      );

      // A second (disconnected-first) device of account 3 gets NOTHING: the
      // first device's allocation is never reclaimed for it.
      const second = KEY("second");
      assertEquals(await inTx(sql, 3, (tx) => register(tx, second)), "accepted");
      const s1 = await inTx(sql, 3, (tx) => issueRow(tx, second));
      assertEquals(s1.result, "access.paywall_required");
      assertEquals(
        await count(
          sql,
          `public.offline_allocation_ledger where user_id = '${U(3)}' and event = 'allocated'`,
        ),
        2,
      );
      // And the first device still holds exactly its two.
      const a3 = await inTx(sql, 3, (tx) => issueRow(tx, shared));
      assertEquals([...(a3.ticket_ids ?? [])].sort(), [...(a1.ticket_ids ?? [])].sort());

      // The online path sees both holds: no third rating online either.
      const hold = await inTx(sql, 3, async (tx) => {
        const rows = await tx.unsafe<{ held: number }[]>(
          `select public.offline_hold_count() as held`,
        );
        return rows[0];
      });
      assertEquals(Number(hold.held), 2);

      // Account rotation: account 3 is deleted and the SAME sign-in identity
      // re-creates an account. Its original installation recovers the SAME two
      // tickets (never two fresh ones) — conservation across re-creation.
      await sql.unsafe(`delete from auth.users where id = '${U(3)}'`);
      await sql.unsafe(`delete from auth.users where id = '${U(5)}'`);
      await sql.unsafe(
        `insert into auth.users (id, email, raw_app_meta_data)
         values ('${U(5)}', 'atk-w04-02-5-${RUN}@example.com', '{"provider":"google"}')`,
      );
      await sql.unsafe(
        `insert into auth.identities (provider, provider_id, user_id, identity_data)
         values ('google', 'atk-w04-02-3-${RUN}', '${U(5)}', '{"sub":"atk-w04-02-3-${RUN}"}')`,
      );
      await sql.unsafe(
        `insert into auth.sessions (id, user_id) values ('${SESSION(5)}', '${U(5)}')`,
      );
      assertEquals(await inTx(sql, 5, (tx) => register(tx, shared)), "accepted");
      const r1 = await inTx(sql, 5, (tx) => issueRow(tx, shared));
      assertEquals(r1.result, "accepted");
      assertEquals([...(r1.ticket_ids ?? [])].sort(), [...(a1.ticket_ids ?? [])].sort());
      await buildSignVerify(r1, U(5), shared);
      // A brand-new device on the re-created account still gets nothing.
      const third = KEY("third");
      assertEquals(await inTx(sql, 5, (tx) => register(tx, third)), "accepted");
      assertEquals(
        (await inTx(sql, 5, (tx) => issueRow(tx, third))).result,
        "access.paywall_required",
      );
      // Account 4 on the shared key is untouched by all of it.
      const b2 = await inTx(sql, 4, (tx) => issueRow(tx, shared));
      assertEquals([...(b2.ticket_ids ?? [])].sort(), [...(b1.ticket_ids ?? [])].sort());
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATTACK C — concurrency: two live sessions of one account race one device.
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "ATTACK concurrency (live DB): two overlapping issue_offline_grant() calls for one device allocate exactly two tickets once and both rows sign",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 3 });
    try {
      await createUser(sql, 6);
      const key = KEY("race");
      assertEquals(await inTx(sql, 6, (tx) => register(tx, key)), "accepted");

      // Both transactions open, both take the lock in turn.
      const results = await Promise.all([
        inTx(sql, 6, async (tx) => {
          const row = await issueRow(tx, key);
          await tx.unsafe(`select pg_sleep(0.3)`);
          return row;
        }),
        inTx(sql, 6, (tx) => issueRow(tx, key)),
      ]);
      for (const row of results) assertEquals(row.result, "accepted");
      assertEquals(
        results.map((r) => r.generation).sort(),
        [1, 2],
        "the two generations are distinct and consecutive",
      );
      assertEquals(
        [...(results[0].ticket_ids ?? [])].sort(),
        [...(results[1].ticket_ids ?? [])].sort(),
        "the second caller re-issues the same two tickets, never two more",
      );
      assertEquals(
        await count(
          sql,
          `public.offline_allocation_ledger where user_id = '${U(6)}' and event = 'allocated'`,
        ),
        2,
      );
      for (const row of results) await buildSignVerify(row, U(6), key);

      // Double registration in parallel (first registration of one key):
      // both accepted with ONE device row.
      await createUser(sql, 7);
      const dup = KEY("dup");
      const regs = await Promise.all([
        inTx(sql, 7, (tx) => register(tx, dup)),
        inTx(sql, 7, (tx) => register(tx, dup)),
        inTx(sql, 7, (tx) => register(tx, dup, false)),
      ]);
      assertEquals(regs, ["accepted", "accepted", "accepted"]);
      assertEquals(
        await count(sql, `public.offline_devices where user_id = '${U(7)}'`),
        1,
      );
      // ...and an unattested re-registration never downgraded it.
      const state = await sql.unsafe<{ attestation_state: string }[]>(
        `select attestation_state from public.offline_devices where user_id = '${U(7)}'`,
      );
      assertEquals(state[0].attestation_state, "attested");
      // Environment switch on a known key is refused, never rewritten.
      assertEquals(
        await inTx(sql, 7, (tx) => register(tx, dup, true, "development")),
        "offline.device_environment_mismatch",
      );
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATTACK D — boundary clocks on the Pro path through the REAL rows.
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "ATTACK clocks (live DB): far-future entitlement caps at 7 days; an expired-but-premium row is NOT a Pro lease; `infinity` fails closed",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    try {
      // Far future (year 9999): lease is exactly 7 days and signs.
      await createUser(sql, 8);
      await sql.unsafe(
        `insert into public.billing_entitlements (user_id, premium, product_key, expires_at)
         values ('${U(8)}', true, 'pickle_sensei_pro_annual', '9999-12-31T00:00:00Z')`,
      );
      const far = KEY("far");
      assertEquals(await inTx(sql, 8, (tx) => register(tx, far)), "accepted");
      const farRow = await inTx(sql, 8, (tx) => issueRow(tx, far));
      assertEquals(farRow.result, "accepted");
      const farClaims = await buildSignVerify(farRow, U(8), far);
      assertEquals(farClaims.entitlementSource, "verified_store");
      assertEquals(farClaims.exp - farClaims.iat, OFFLINE_PRO_LEASE_MAX_SECONDS);
      assert(farClaims.lease?.kind === "subscription");
      assert(farClaims.lease.verifiedEntitlementExpiresAt > farClaims.exp);

      // Expired subscription still flagged premium=true: the RPC must fall
      // back to the free identity path — never a Pro lease past the store.
      await createUser(sql, 9);
      await sql.unsafe(
        `insert into public.billing_entitlements (user_id, premium, product_key, expires_at)
         values ('${U(9)}', true, 'pickle_sensei_pro_monthly', now() - interval '1 second')`,
      );
      const stale = KEY("stale");
      assertEquals(await inTx(sql, 9, (tx) => register(tx, stale)), "accepted");
      const staleRow = await inTx(sql, 9, (tx) => issueRow(tx, stale));
      assertEquals(staleRow.result, "accepted");
      assertEquals(staleRow.entitlement_source, "identity_lifetime_free");
      assertEquals(staleRow.entitlement_expires_at, null);
      const staleClaims = await buildSignVerify(staleRow, U(9), stale);
      assertEquals(staleClaims.entitlementSource, "identity_lifetime_free");
      assertEquals(staleClaims.allocation?.ticketIds.length, 2);

      // Lifetime (expires_at null): lease 7 days, lifetime lease, signs.
      await createUser(sql, 10);
      await sql.unsafe(
        `insert into public.billing_entitlements (user_id, premium, product_key, expires_at)
         values ('${U(10)}', true, 'pickle_sensei_pro_lifetime', null)`,
      );
      const life = KEY("life");
      assertEquals(await inTx(sql, 10, (tx) => register(tx, life)), "accepted");
      const lifeRow = await inTx(sql, 10, (tx) => issueRow(tx, life));
      const lifeClaims = await buildSignVerify(lifeRow, U(10), life);
      assertEquals(lifeClaims.lease?.kind, "lifetime");
      assertEquals(lifeClaims.exp - lifeClaims.iat, OFFLINE_PRO_LEASE_MAX_SECONDS);

      // Corrupt persisted state: expires_at = 'infinity' is accepted by the
      // table and the RPC, serialized as "infinity" — the edge must refuse
      // the row (fail closed), not sign an open-ended lease.
      await createUser(sql, 11);
      await sql.unsafe(
        `insert into public.billing_entitlements (user_id, premium, product_key, expires_at)
         values ('${U(11)}', true, 'pickle_sensei_pro_annual', 'infinity')`,
      );
      const inf = KEY("inf");
      assertEquals(await inTx(sql, 11, (tx) => register(tx, inf)), "accepted");
      const infRow = await inTx(sql, 11, (tx) => issueRow(tx, inf));
      assertEquals(infRow.result, "accepted");
      let refused = "";
      try {
        offlineGrantClaimsFromIssuance(infRow, {
          issuer: ISSUER,
          ownerId: U(11),
          installationKeyId: inf,
          release: RELEASE,
        });
      } catch (error) {
        refused = (error as { reason?: string }).reason ?? "thrown";
      }
      assertEquals(refused, "row_malformed", JSON.stringify(infRow));
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATTACK E — a Pro entitlement that ends inside the issuance second: the
// table and the RPC commit a real (sub-second) lease; the edge's whole-second
// floor collapses it to exp == iat and the route answers 503 for a row the
// database already spent. Documents the boundary through REAL rows.
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "ATTACK clocks (live DB): a Pro entitlement expiring within the issuance second yields a committed grant the edge cannot sign (documented boundary)",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    try {
      await createUser(sql, 12);
      const edge = KEY("edge");
      assertEquals(await inTx(sql, 12, (tx) => register(tx, edge)), "accepted");
      await sql.unsafe(
        `insert into public.billing_entitlements (user_id, premium, product_key, expires_at)
         values ('${U(12)}', true, 'pickle_sensei_pro_monthly', now() + interval '1 day')`,
      );
      // The entitlement ends at the last millisecond of the CURRENT second;
      // the issuance that follows a few ms later lands inside that second
      // unless the write straddled a second boundary — retry then. Every
      // attempt asserts the invariant that holds for its own timing.
      let observedSameSecond = false;
      let spent = 0;
      for (let attempt = 0; attempt < 12 && !observedSameSecond; attempt += 1) {
        await sql.unsafe(
          `update public.billing_entitlements
           set expires_at = date_trunc('second', clock_timestamp()) + interval '999 milliseconds'
           where user_id = '${U(12)}'`,
        );
        const row = await inTx(sql, 12, (tx) => issueRow(tx, edge));
        if (row.result !== "accepted") {
          // The entitlement had already lapsed → free path (never a Pro lease).
          assertEquals(row.result, "accepted");
        }
        if (row.entitlement_source !== "verified_store") continue;
        spent += 1;
        assert(row.issued_at && row.expires_at);
        const issuedMs = Date.parse(row.issued_at);
        const expiresMs = Date.parse(row.expires_at);
        assert(expiresMs > issuedMs, "the table only accepts expires_at > issued_at");
        const sameSecond = Math.floor(expiresMs / 1000) === Math.floor(issuedMs / 1000);
        let reason = "";
        try {
          await buildSignVerify(row, U(12), edge);
        } catch (error) {
          reason = (error as { reason?: string }).reason ?? "thrown";
        }
        if (sameSecond) {
          observedSameSecond = true;
          // The generation was spent by the database, then refused by the edge.
          assertEquals(reason, "expiry_not_after_issuance");
        } else {
          assertEquals(
            reason,
            "",
            `a ${expiresMs - issuedMs} ms lease crossing a second boundary signs`,
          );
        }
      }
      assert(observedSameSecond, "expected at least one issuance inside the expiry second");
      assertEquals(
        await count(
          sql,
          `public.offline_grants where user_id = '${
            U(12)
          }' and entitlement_source = 'verified_store'`,
        ),
        spent,
      );
    } finally {
      await sql.end();
    }
  },
});
