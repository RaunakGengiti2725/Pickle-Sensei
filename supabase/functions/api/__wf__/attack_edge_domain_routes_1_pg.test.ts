/**
 * ADVERSARIAL PASS 3 — `edge-domain-routes`, Postgres side.
 *
 * Runs the real RPCs the edge routes call (`reserve_analysis_permit`,
 * `apply_synced_shot`, `access_state`) under the `authenticated` role with a
 * forged `request.jwt.claim.sub`, exactly as PostgREST would for a user-scoped
 * client. Every test rolls back.
 *
 * Needs a Postgres with the shim + every migration applied — same setup as
 * be-edge-routes-shots-rank.test.ts:
 *   docker run -d --name pickle-audit -e POSTGRES_PASSWORD=pg -p 55432:5432 postgres:16-alpine
 *   docker cp supabase/tests pickle-audit:/tests && docker cp supabase/migrations pickle-audit:/migrations
 *   docker exec pickle-audit sh -c 'psql -U postgres -v ON_ERROR_STOP=1 -f /tests/shim_auth.sql \
 *     && for f in /migrations/*.sql; do psql -U postgres -v ON_ERROR_STOP=1 -f "$f"; done'
 *   PICKLE_AUDIT_PG_URL=postgres://postgres:pg@127.0.0.1:55432/postgres \
 *     deno test -A --no-check --config deno.json attack_edge_domain_routes_1_pg.test.ts
 *
 * Without PICKLE_AUDIT_PG_URL the tests are ignored (never silently passed).
 *
 *   PG-S3  cross-user permit theft: Bob presents Alice's permit id
 *   PG-S1  what the DB answers a bearer whose auth.users row is gone
 */
import postgres from "postgres";
import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";

const PG_URL = Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

const ALICE = "00000000-0000-4000-8000-0000000000aa";
const BOB = "00000000-0000-4000-8000-0000000000bb";

const VERSION_VECTOR = {
  appVersion: "1.0.0",
  modelBundleVersion: "bundle-1",
  poseModelVersion: "pose-1",
  paddleModelVersion: "paddle-1",
  strokeDetectorVersion: "stroke-1",
  phaseModelVersion: "phase-1",
  scoringModelVersion: "scoring-1",
  shotConfigVersion: "config-1",
};

type Sql = ReturnType<typeof postgres>;

async function withRollback(sql: Sql, fn: (tx: Sql) => Promise<void>): Promise<void> {
  try {
    await sql.begin(async (tx) => {
      await fn(tx as unknown as Sql);
      throw new Error("__rollback__");
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "__rollback__") throw error;
  }
}

async function ensureUser(tx: Sql, userId: string): Promise<void> {
  await tx.unsafe(
    `insert into auth.users (id, email) values ('${userId}', '${userId}@example.com') on conflict do nothing`,
  );
}

/** Switch the session to the PostgREST-equivalent identity for `userId`. */
async function actAs(tx: Sql, userId: string): Promise<void> {
  await tx.unsafe(`reset role`);
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

async function asSuperuser(tx: Sql): Promise<void> {
  await tx.unsafe(`reset role`);
}

function shotPayload(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    sessionId: null,
    shotType: "dink",
    cameraView: "side",
    capturedAt: "2026-09-01T10:00:00.000Z",
    startMs: 0,
    contactMs: 100,
    endMs: 200,
    overallScore: 7,
    confidence: 0.9,
    resultKind: "scored",
    phases: [],
    checkpoints: [],
    versionVector: VERSION_VECTOR,
    ...overrides,
  };
}

async function reserve(tx: Sql, key: string): Promise<{ result: string; permitId: string | null }> {
  const rows = await tx.unsafe(`select result, permit_id from public.reserve_analysis_permit('${key}')`);
  return { result: String(rows[0].result), permitId: rows[0].permit_id ? String(rows[0].permit_id) : null };
}

async function apply(tx: Sql, shot: Record<string, unknown>): Promise<string> {
  const rows = await tx.unsafe(`select public.apply_synced_shot($1::text::jsonb) as status`, [
    JSON.stringify(shot),
  ]);
  return String(rows[0].status);
}

async function permitRow(tx: Sql, permitId: string) {
  const rows = await tx.unsafe(
    `select user_id, status, outcome from public.analysis_permits where id = '${permitId}'`,
  );
  return rows[0] as { user_id: string; status: string; outcome: string | null } | undefined;
}

Deno.test({
  name: "PG-S3: Bob presenting Alice's reserved permit gets access.permit_not_found; Alice's permit stays reserved; no shot is written",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    try {
      await withRollback(sql, async (tx) => {
        await ensureUser(tx, ALICE);
        await ensureUser(tx, BOB);

        await actAs(tx, ALICE);
        const alicePermit = await reserve(tx, "alice-1");
        assertEquals(alicePermit.result, "accepted");
        const permitId = alicePermit.permitId!;

        await actAs(tx, BOB);
        // RLS: Bob cannot even see the row…
        const visible = await tx.unsafe(`select count(*)::int as n from public.analysis_permits where id = '${permitId}'`);
        assertEquals(visible[0].n, 0);
        // …cannot mutate it…
        const stolenUpdate = await tx.unsafe(
          `update public.analysis_permits set status = 'finalized', outcome = 'scored' where id = '${permitId}'`,
        );
        assertEquals(stolenUpdate.count, 0);
        // …and the sync RPC reports not_found, identical to a random id.
        const stolenShotId = crypto.randomUUID();
        const theft = await apply(tx, shotPayload({ id: stolenShotId, analysisPermitId: permitId }));
        assertEquals(theft, "access.permit_not_found");
        const random = await apply(tx, shotPayload({ analysisPermitId: crypto.randomUUID() }));
        assertEquals(random, "access.permit_not_found", "no oracle: foreign permit ≡ nonexistent permit");
        // Rapid repeats (8×) do not change the verdict or leak state.
        for (let i = 0; i < 8; i += 1) {
          assertEquals(await apply(tx, shotPayload({ id: stolenShotId, analysisPermitId: permitId })), "access.permit_not_found");
        }
        // Control: Bob's own permit works, proving the harness is live.
        const bobPermit = await reserve(tx, "bob-1");
        assertEquals(bobPermit.result, "accepted");
        assertNotEquals(bobPermit.permitId, permitId);
        assertEquals(await apply(tx, shotPayload({ analysisPermitId: bobPermit.permitId! })), "accepted");

        await asSuperuser(tx);
        const alice = await permitRow(tx, permitId);
        assertEquals(alice, { user_id: ALICE, status: "reserved", outcome: null });
        const stolen = await tx.unsafe(`select count(*)::int as n from public.shots where id = '${stolenShotId}'`);
        assertEquals(stolen[0].n, 0);
        const bobShots = await tx.unsafe(`select count(*)::int as n from public.shots where user_id = '${BOB}'`);
        assertEquals(bobShots[0].n, 1);
        const aliceShots = await tx.unsafe(`select count(*)::int as n from public.shots where user_id = '${ALICE}'`);
        assertEquals(aliceShots[0].n, 0);
        // Alice's free-rating counters are untouched by Bob's attempt.
        await actAs(tx, ALICE);
        const access = await tx.unsafe(`select premium, scored_count, reserved_count from public.access_state()`);
        assertEquals(access[0], { premium: false, scored_count: 0, reserved_count: 1 });
      });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "PG-S3b: Bob cannot finalize/release Alice's permit through the finalize path either (0 rows under RLS)",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    try {
      await withRollback(sql, async (tx) => {
        await ensureUser(tx, ALICE);
        await ensureUser(tx, BOB);
        await actAs(tx, ALICE);
        const permitId = (await reserve(tx, "alice-2")).permitId!;
        await actAs(tx, BOB);
        // POST /v1/analysis-permits/:id/finalize does update ... eq(id).eq(user_id)
        // — with or without the user_id predicate RLS yields zero rows.
        for (const outcome of ["cancelled", "scored", "expired"]) {
          const r = await tx.unsafe(
            `update public.analysis_permits set status = 'released', outcome = '${outcome}' where id = '${permitId}'`,
          );
          assertEquals(r.count, 0, outcome);
        }
        const del = await tx.unsafe(`delete from public.analysis_permits where id = '${permitId}'`);
        assertEquals(del.count, 0);
        await asSuperuser(tx);
        assertEquals((await permitRow(tx, permitId))!.status, "reserved");
      });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "PG-S1: after auth.users cascade-delete, a still-valid bearer's queries see a FRESH account (access_state 0/0) and writes fail on the profiles FK",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    try {
      await withRollback(sql, async (tx) => {
        await ensureUser(tx, ALICE);
        await actAs(tx, ALICE);
        const permitId = (await reserve(tx, "live-1")).permitId!;
        assertEquals(await apply(tx, shotPayload({ analysisPermitId: permitId, overallScore: 6 })), "accepted");
        const live = await tx.unsafe(`select premium, scored_count, reserved_count from public.access_state()`);
        assertEquals(live[0], { premium: false, scored_count: 1, reserved_count: 0 });

        // Account deletion = adminDb.auth.admin.deleteUser → auth.users row gone,
        // everything user-owned cascades.
        await asSuperuser(tx);
        await tx.unsafe(`delete from auth.users where id = '${ALICE}'`);
        assertEquals((await tx.unsafe(`select count(*)::int as n from public.profiles where id = '${ALICE}'`))[0].n, 0);
        assertEquals((await tx.unsafe(`select count(*)::int as n from public.shots where user_id = '${ALICE}'`))[0].n, 0);

        // The other device's cached bearer still carries sub = ALICE.
        await actAs(tx, ALICE);
        const stale = await tx.unsafe(`select premium, scored_count, reserved_count from public.access_state()`);
        // What GET /v1/me/access will compute for the ghost: premium=false,
        // used=0, remaining=2 — indistinguishable from a brand-new account.
        assertEquals(stale[0], { premium: false, scored_count: 0, reserved_count: 0 });
        assertEquals((await tx.unsafe(`select count(*)::int as n from public.profiles`))[0].n, 0);
        assertEquals((await tx.unsafe(`select count(*)::int as n from public.consent_records`))[0].n, 0);
        assertEquals((await tx.unsafe(`select count(*)::int as n from public.player_rank_state`))[0].n, 0);
        assertEquals((await tx.unsafe(`select count(*)::int as n from public.progress_daily`))[0].n, 0);

        // Writes: the FK to profiles refuses them → PostgREST error → edge 503.
        const err = await assertRejects(() => reserve(tx, "ghost-1"));
        assertEquals((err as { code?: string }).code, "23503");
      });
      await withRollback(sql, async (tx) => {
        await actAs(tx, "00000000-0000-4000-8000-00000000dead");
        const sync = await apply(tx, shotPayload({ analysisPermitId: crypto.randomUUID() }));
        assertEquals(sync, "access.permit_not_found");
        // Last statement of the block: the failure aborts the transaction.
        const err = await assertRejects(() =>
          tx.unsafe(
            `insert into public.consent_records (user_id, scope, action, consent_version) values (auth.uid(), 'model_training', 'grant', 'v1')`,
          ));
        assertEquals((err as { code?: string }).code, "23503");
      });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "PG-S1b: the free-rating identity ledger survives deletion — a re-created account with the same identity is NOT fresh",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    try {
      await withRollback(sql, async (tx) => {
        await ensureUser(tx, ALICE);
        const hasIdentities = await tx.unsafe(
          `select count(*)::int as n from information_schema.tables where table_schema = 'auth' and table_name = 'identities'`,
        );
        assert(hasIdentities[0].n === 1, "shim must provide auth.identities");
        await tx.unsafe(
          `insert into auth.identities (id, user_id, provider, provider_id, identity_data)
           values (gen_random_uuid(), '${ALICE}', 'apple', 'apple-sub-1', '{}'::jsonb)`,
        );
        await actAs(tx, ALICE);
        for (const key of ["l-1", "l-2"]) {
          const permitId = (await reserve(tx, key)).permitId!;
          assertEquals(await apply(tx, shotPayload({ analysisPermitId: permitId })), "accepted");
        }
        assertEquals((await reserve(tx, "l-3")).result, "access.paywall_required");

        await asSuperuser(tx);
        await tx.unsafe(`delete from auth.users where id = '${ALICE}'`);
        // Same Apple ID signs in again → new auth.users row + same identity subject.
        await ensureUser(tx, BOB);
        await tx.unsafe(
          `insert into auth.identities (id, user_id, provider, provider_id, identity_data)
           values (gen_random_uuid(), '${BOB}', 'apple', 'apple-sub-1', '{}'::jsonb)`,
        );
        await actAs(tx, BOB);
        const access = await tx.unsafe(`select premium, scored_count, reserved_count from public.access_state()`);
        assertEquals(access[0], { premium: false, scored_count: 2, reserved_count: 0 });
        assertEquals((await reserve(tx, "l-4")).result, "access.paywall_required");
      });
    } finally {
      await sql.end();
    }
  },
});
