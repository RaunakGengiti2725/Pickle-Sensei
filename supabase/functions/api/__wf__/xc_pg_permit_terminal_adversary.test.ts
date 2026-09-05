/**
 * Adversary round 8 (cluster sync-permit-durability, ADV7-PERMIT-REUSE-DELETE-
 * REINSERT) — REAL Postgres attacks on migration
 * 20260907000000_permit_terminal_client_role (candidate 0896145b).
 *
 * Same harness as xc_pg_permit_lifecycle_adversary.test.ts: a disposable
 * postgres:16 with shim_auth.sql + every migration applied (./xc_pg_up.sh),
 * every client statement as role `authenticated` with a JWT sub, nothing
 * mocked. Owner-role statements stand in for the service role / support
 * tooling / pg_restore and are labelled as such.
 *
 *   ./xc_pg_up.sh
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     deno test -A --no-check --config deno.json xc_pg_permit_terminal_adversary.test.ts
 *
 * Without XC_PG_URL (alias PICKLE_AUDIT_PG_URL) every test is `ignore`d — an
 * ignored run is NOT a pass.
 *
 * Claims attacked (candidate numbering in parentheses):
 *   ADV-11 (BREAK, P2) the one-permit-one-shot invariant (2)/(3) is not
 *          retroactive: every shot written before 20260907000000 has
 *          analysis_permit_id NULL, so analysis_permits_guard_resurrection
 *          cannot see the permit that backed it. The same DELETE + re-INSERT
 *          of the settled permit id that ADV-10 closed for the client role
 *          is accepted for such a permit, and apply_synced_shot() then backs
 *          a SECOND scored shot with it (owner/service role required — no
 *          client path; the free-rating backstop still caps free accounts).
 *   ADV-12 pre-fix consumed permit, every CLIENT path: UPDATE back to
 *          reserved / released-expired, INSERT reusing the idempotency key,
 *          reserve_analysis_permit(key) replay, late sync naming it — all
 *          refused, no second shot.
 *   ADV-13 client-minted `reserved` rows via the column grant: they inflate
 *          access_state().reserved_count and are consumable by the RPC, but
 *          the lifetime backstop still stops the third free scored shot and
 *          reserve_analysis_permit() refuses to mint more.
 *   ADV-14 shots.analysis_permit_id: a direct client INSERT naming a live
 *          permit → 42501 + access.permit_not_reserved (scored and
 *          low_confidence alike); a spoofed `analysis_permit_id` jsonb key is
 *          ignored by the RPC; replaying a shot id under a DIFFERENT permit
 *          keeps the original link and leaves the second permit reserved.
 *   ADV-15 PostgREST upsert equivalents (`resolution=merge-duplicates`):
 *          ON CONFLICT (user_id, idempotency_key) DO UPDATE onto a settled
 *          row → 23514; any ON CONFLICT (id) needs `id` in the INSERT list →
 *          42501; INSERT … RETURNING id, client-finalize, UPDATE back →
 *          23514.
 *   ADV-16 legit flows around the partial unique index: hundreds of
 *          NULL-permit scored shots (premium, pre-fix shape) coexist with a
 *          vouched sync; auth.users cascade for a user whose consumed permits
 *          back linked shots succeeds and leaves no rows.
 *   ADV-17 (BREAK, P2) ops path: the owner/service role may DELETE a permit
 *          that backs a shot (no FK — the shot's analysis_permit_id dangles),
 *          but the guard then refuses to re-load the identical settled row
 *          (23514) — a table-level `pg_dump --data-only` of analysis_permits
 *          cannot be restored while its shots exist, and support cannot
 *          repair the orphan. The full dependency-ordered restore (permits
 *          before shots) still works.
 */
import postgres from "postgres";
import { assert, assertEquals, assertNotEquals } from "@std/assert";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

// Distinct from the round-7 suite's users (…0001/2/3) so both files can run
// against the same disposable DB in one `deno task test`.
const U1 = "0000000a-d7e0-4000-8000-000000000011";
const U2 = "0000000a-d7e0-4000-8000-000000000012";
const PREMIUM = "0000000a-d7e0-4000-8000-000000000013";

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

function shotPayload(
  id: string,
  analysisPermitId: string | null,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    analysisPermitId,
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

let shotSeq = 0;
function shotId(): string {
  shotSeq += 1;
  return `0000000a-d7e0-4000-8000-2${String(shotSeq).padStart(11, "0")}`;
}

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

async function resetUsers(sql: Sql, premium = false): Promise<void> {
  for (const id of [U1, U2, PREMIUM]) {
    await sql.unsafe(`delete from auth.users where id = '${id}'`);
    await sql.unsafe(
      `insert into auth.users (id, email, raw_app_meta_data) values ('${id}', '${id}@example.com', '{"provider":"google"}')`,
    );
  }
  if (premium) {
    await sql.unsafe(
      `insert into public.billing_entitlements (user_id, premium, product_key, expires_at)
       values ('${PREMIUM}', true, 'pickle_sensei_pro_lifetime', null)`,
    );
  }
}

function inTx<T>(sql: Sql, userId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    if (userId) await asUser(tx as unknown as Tx, userId);
    return await fn(tx as unknown as Tx);
  }) as Promise<T>;
}

async function reserveRow(
  sql: Sql,
  userId: string,
  key: string,
): Promise<{ result: string; permit_id: string | null; permit_status: string | null }> {
  const rows = await inTx(
    sql,
    userId,
    async (tx) =>
      await tx.unsafe(
        `select x.result, x.permit_id::text as permit_id, x.permit_status from public.reserve_analysis_permit('${key}') x`,
      ),
  );
  return rows[0] as { result: string; permit_id: string | null; permit_status: string | null };
}

async function reserve(sql: Sql, userId: string, key: string): Promise<string> {
  const row = await reserveRow(sql, userId, key);
  assertEquals(row.result, "accepted", `reserve ${key}`);
  return row.permit_id as string;
}

async function sync(tx: Tx, payload: Record<string, unknown>): Promise<string> {
  const rows = await tx.unsafe(`select public.apply_synced_shot($1::jsonb) as r`, [payload]);
  return String(rows[0].r);
}

async function syncAs(sql: Sql, userId: string, payload: Record<string, unknown>): Promise<string> {
  return await inTx(sql, userId, (tx) => sync(tx, payload));
}

async function permitState(sql: Sql, permitId: string): Promise<string> {
  const rows = await sql.unsafe(
    `select status || '/' || coalesce(outcome, 'NULL') as s from public.analysis_permits where id = '${permitId}'`,
  );
  return rows.length === 0 ? "MISSING" : String(rows[0].s);
}

async function shotCount(sql: Sql, userId: string, permitId?: string): Promise<number> {
  const where = permitId ? ` and analysis_permit_id = '${permitId}'` : "";
  const rows = await sql.unsafe(
    `select count(*)::int as n from public.shots where user_id = '${userId}'${where}`,
  );
  return Number(rows[0].n);
}

async function shotLink(sql: Sql, id: string): Promise<string> {
  const rows = await sql.unsafe(
    `select coalesce(analysis_permit_id::text, 'NULL') as p from public.shots where id = '${id}'`,
  );
  return rows.length === 0 ? "MISSING" : String(rows[0].p);
}

function pgError(e: unknown): { code: string; hint: string | null } {
  const err = e as { code?: string; hint?: string };
  return { code: err.code ?? "?", hint: err.hint ?? null };
}

/** One statement in its own transaction (as `userId`, or owner when null):
 * "allowed <rows>" or "<SQLSTATE>:<hint>". */
async function attempt(sql: Sql, userId: string | null, stmt: string): Promise<string> {
  try {
    const n = await inTx(sql, userId, async (tx) => (await tx.unsafe(stmt)).count);
    return `allowed ${n}`;
  } catch (e) {
    const { code, hint } = pgError(e);
    return `${code}:${hint}`;
  }
}

/** Direct client INSERT of a shot row (the `authenticated` INSERT grant on
 * public.shots), optionally naming analysis_permit_id. */
function directShotInsert(
  id: string,
  userId: string,
  resultKind: "scored" | "low_confidence",
  permitId: string | null,
): string {
  const score = resultKind === "scored" ? "7" : "null";
  const permitCol = permitId ? ", analysis_permit_id" : "";
  const permitVal = permitId ? `, '${permitId}'` : "";
  return `insert into public.shots (
    id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
    overall_score, analysis_confidence, result_kind, app_version, model_bundle_version,
    pose_model_version, paddle_model_version, stroke_detector_version, phase_model_version,
    scoring_model_version, shot_config_version${permitCol}
  ) values (
    '${id}', '${userId}', 'dink', 'side', '2026-09-01T10:00:00Z', 0, 100, 200,
    ${score}, 0.9, '${resultKind}', '1', '1', '1', '1', '1', '1', '1', '1'${permitVal}
  )`;
}

/** Every production shot written before 20260907000000 has no permit link
 * (the column did not exist). The owner clears the link a vouched sync just
 * wrote — the exact post-migration shape of a historical scored shot whose
 * permit is finalized/scored. */
async function makePreFix(sql: Sql, shot: string): Promise<void> {
  await sql.unsafe(`update public.shots set analysis_permit_id = null where id = '${shot}'`);
  assertEquals(await shotLink(sql, shot), "NULL");
}

Deno.test({
  name: "ADV-11 (BREAK, P2): pre-fix data — the resurrection guard cannot see a permit whose shot has analysis_permit_id NULL, so DELETE + re-INSERT of that settled id (owner/service role) is accepted and the RPC backs a second scored shot with it",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await resetUsers(sql, true);
      const permit = await reserve(sql, PREMIUM, "adv11");
      const s1 = shotId();
      assertEquals(await syncAs(sql, PREMIUM, shotPayload(s1, permit)), "accepted");
      assertEquals(await permitState(sql, permit), "finalized/scored");
      await makePreFix(sql, s1);

      // Support tooling / restore: the round-7 DELETE + re-INSERT, now as the
      // owner role (the client's DELETE is gone — ADV-10). Claim (3): the
      // definer BEFORE INSERT trigger refuses any id already on a shot, for
      // every role.
      const del = await attempt(
        sql,
        null,
        `delete from public.analysis_permits where id = '${permit}'`,
      );
      const ins = await attempt(
        sql,
        null,
        `insert into public.analysis_permits (id, user_id, idempotency_key) values ('${permit}', '${PREMIUM}', 'adv11-again')`,
      );
      const second = await syncAs(sql, PREMIUM, shotPayload(shotId(), permit));
      const scoredShots = await shotCount(sql, PREMIUM);

      assertEquals(
        del,
        "allowed 1",
        "owner DELETE of a settled permit is the support path under attack",
      );
      assert(
        ins.startsWith("23514"),
        `resurrection guard accepted re-INSERT of settled permit ${permit} (${ins}) because its shot ${s1} predates the link column; ` +
          `second sync on the same permit id: ${second}; scored shots for one permit id: ${scoredShots}; permit ${await permitState(sql, permit)}`,
      );
      assertEquals(second, "access.permit_not_reserved");
      assertEquals(scoredShots, 1);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ADV-12: pre-fix consumed permit, every client path — UPDATE to reserved/expired 23514, INSERT reusing the idempotency key 23505, reserve_analysis_permit(key) hands back the settled row (never a fresh one), late sync → access.permit_not_reserved, one shot",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await resetUsers(sql);
      const permit = await reserve(sql, U1, "adv12");
      const s1 = shotId();
      assertEquals(await syncAs(sql, U1, shotPayload(s1, permit)), "accepted");
      await makePreFix(sql, s1);
      assertEquals(await permitState(sql, permit), "finalized/scored");

      assertEquals(
        await attempt(
          sql,
          U1,
          `update public.analysis_permits set status = 'reserved', outcome = null where id = '${permit}'`,
        ),
        "23514:access.permit_transition_rejected",
      );
      assertEquals(
        await attempt(
          sql,
          U1,
          `update public.analysis_permits set status = 'released', outcome = 'expired' where id = '${permit}'`,
        ),
        "23514:access.permit_transition_rejected",
      );
      assertEquals(
        await attempt(
          sql,
          U1,
          `insert into public.analysis_permits (user_id, idempotency_key) values ('${U1}', 'adv12')`,
        ),
        "23505:null",
      );
      const replay = await reserveRow(sql, U1, "adv12");
      assertEquals(
        replay.permit_id,
        permit,
        "idempotent replay returns the same permit, never a new one",
      );
      assertEquals(replay.permit_status, "finalized");
      assertEquals(
        await syncAs(sql, U1, shotPayload(shotId(), permit)),
        "access.permit_not_reserved",
      );
      assertEquals(await shotCount(sql, U1), 1);
      assertEquals(await permitState(sql, permit), "finalized/scored");
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ADV-13: client-minted reserved rows via the column grant — five direct INSERTs inflate access_state().reserved_count and are RPC-consumable, but only two free scored shots land (third → access.paywall_required) and reserve_analysis_permit() refuses to mint",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await resetUsers(sql);
      const minted: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const rows = await inTx(
          sql,
          U1,
          async (tx) =>
            await tx.unsafe(
              `insert into public.analysis_permits (user_id, idempotency_key) values ('${U1}', 'adv13-${i}') returning id::text as id, status, outcome`,
            ),
        );
        assertEquals(rows[0].status, "reserved");
        minted.push(String(rows[0].id));
      }
      const access = await inTx(
        sql,
        U1,
        async (tx) =>
          await tx.unsafe(
            `select premium, scored_count, reserved_count from public.access_state()`,
          ),
      );
      assertEquals(Number(access[0].scored_count), 0);
      assertEquals(Number(access[0].reserved_count), 5, "minted rows count as live reservations");
      assertEquals((await reserveRow(sql, U1, "adv13-legit")).result, "access.paywall_required");

      assertEquals(await syncAs(sql, U1, shotPayload(shotId(), minted[0])), "accepted");
      assertEquals(await syncAs(sql, U1, shotPayload(shotId(), minted[1])), "accepted");
      assertEquals(
        await syncAs(sql, U1, shotPayload(shotId(), minted[2])),
        "access.paywall_required",
      );
      assertEquals(await permitState(sql, minted[0]), "finalized/scored");
      assertEquals(await permitState(sql, minted[1]), "finalized/scored");
      assertEquals(await permitState(sql, minted[2]), "released/free_limit_exceeded");
      assertEquals(await shotCount(sql, U1), 2);
      // A minted live permit does not unlock a direct client scored INSERT past the cap either.
      assertEquals(
        await attempt(sql, U1, directShotInsert(shotId(), U1, "scored", null)),
        "42501:access.paywall_required",
      );
      assertEquals(await shotCount(sql, U1), 2);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ADV-14: shots.analysis_permit_id — direct client INSERT naming a live permit → 42501 access.permit_not_reserved (scored and low_confidence); spoofed analysis_permit_id jsonb key ignored; same shot id under a different permit keeps the original link and leaves the second permit reserved",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await resetUsers(sql);
      const p1 = await reserve(sql, U1, "adv14-1");
      const p2 = await reserve(sql, U1, "adv14-2");

      assertEquals(
        await attempt(sql, U1, directShotInsert(shotId(), U1, "scored", p1)),
        "42501:access.permit_not_reserved",
      );
      assertEquals(
        await attempt(sql, U1, directShotInsert(shotId(), U1, "low_confidence", p1)),
        "42501:access.permit_not_reserved",
      );
      assertEquals(await permitState(sql, p1), "reserved/NULL");
      assertEquals(await shotCount(sql, U1), 0);

      // Spoofed snake_case key beside the contract key: the RPC reads only
      // analysisPermitId and links the shot to that permit.
      const s1 = shotId();
      assertEquals(
        await syncAs(sql, U1, shotPayload(s1, p1, { analysis_permit_id: p2 })),
        "accepted",
      );
      assertEquals(await shotLink(sql, s1), p1);
      assertEquals(await permitState(sql, p1), "finalized/scored");
      assertEquals(await permitState(sql, p2), "reserved/NULL");

      // Receipt lost on the client: the same shot id replayed under a
      // different, still-reserved permit is acknowledged, the original row is
      // untouched, the second permit stays reserved and usable.
      assertEquals(
        await syncAs(sql, U1, shotPayload(s1, p2, { overallScore: 3, shotType: "drive" })),
        "accepted",
      );
      assertEquals(await shotLink(sql, s1), p1);
      const row = await sql.unsafe(
        `select shot_type, overall_score::numeric::int as s from public.shots where id = '${s1}'`,
      );
      assertEquals(row[0].shot_type, "dink");
      assertEquals(Number(row[0].s), 7);
      assertEquals(await permitState(sql, p2), "reserved/NULL");
      assertEquals(await syncAs(sql, U1, shotPayload(shotId(), p2)), "accepted");
      assertEquals(await shotCount(sql, U1), 2);

      // Cross-user / garbage permit values are contract verdicts, never SQL errors.
      const pB = await reserve(sql, U2, "adv14-b");
      assertEquals(await syncAs(sql, U1, shotPayload(shotId(), pB)), "access.permit_not_found");
      assertEquals(await permitState(sql, pB), "reserved/NULL");
      assertEquals(
        await syncAs(sql, U1, shotPayload(shotId(), "00000000-0000-0000-0000-000000000000")),
        "access.permit_not_found",
      );
      assertEquals(await syncAs(sql, U1, shotPayload(shotId(), null)), "access.permit_not_found");
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ADV-15: PostgREST upsert equivalents as authenticated — ON CONFLICT (user_id, idempotency_key) DO UPDATE onto a settled row 23514; ON CONFLICT (id) needs `id` in the INSERT list → 42501; INSERT … RETURNING id, client finalize, UPDATE back to reserved → 23514",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await resetUsers(sql);
      const permit = await reserve(sql, U1, "adv15");
      assertEquals(await syncAs(sql, U1, shotPayload(shotId(), permit)), "accepted");
      assertEquals(await permitState(sql, permit), "finalized/scored");

      assertEquals(
        await attempt(
          sql,
          U1,
          `insert into public.analysis_permits (user_id, idempotency_key, status, outcome) values ('${U1}', 'adv15', 'reserved', null)
           on conflict (user_id, idempotency_key) do update set status = excluded.status, outcome = excluded.outcome`,
        ),
        "23514:access.permit_transition_rejected",
      );
      assertEquals(
        await attempt(
          sql,
          U1,
          `insert into public.analysis_permits (user_id, idempotency_key, status, outcome) values ('${U1}', 'adv15', 'released', 'expired')
           on conflict (user_id, idempotency_key) do update set status = excluded.status, outcome = excluded.outcome`,
        ),
        "23514:access.permit_transition_rejected",
      );
      assertEquals(
        await attempt(
          sql,
          U1,
          `insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome) values ('${permit}', '${U1}', 'adv15-x', 'reserved', null)
           on conflict (id) do update set status = excluded.status, outcome = excluded.outcome`,
        ),
        "42501:null",
      );
      assertEquals(
        await attempt(
          sql,
          U1,
          `insert into public.analysis_permits (id, user_id, idempotency_key) values ('${permit}', '${U1}', 'adv15-y') on conflict do nothing`,
        ),
        "42501:null",
      );
      assertEquals(await permitState(sql, permit), "finalized/scored");
      assertEquals(
        await syncAs(sql, U1, shotPayload(shotId(), permit)),
        "access.permit_not_reserved",
      );

      // INSERT … RETURNING id (the column grant allows it), client PATCH to
      // finalized/cancelled, then UPDATE by id back to reserved.
      const minted = await inTx(
        sql,
        U1,
        async (tx) =>
          await tx.unsafe(
            `insert into public.analysis_permits (user_id, idempotency_key) values ('${U1}', 'adv15-mint') returning id::text as id`,
          ),
      );
      const mintedId = String(minted[0].id);
      assertEquals(
        await attempt(
          sql,
          U1,
          `update public.analysis_permits set status = 'finalized', outcome = 'cancelled' where id = '${mintedId}'`,
        ),
        "allowed 1",
      );
      assertEquals(
        await attempt(
          sql,
          U1,
          `update public.analysis_permits set status = 'reserved', outcome = null where id = '${mintedId}'`,
        ),
        "23514:access.permit_transition_rejected",
      );
      assertEquals(
        await syncAs(sql, U1, shotPayload(shotId(), mintedId)),
        "access.permit_not_reserved",
      );
      assertEquals(await shotCount(sql, U1), 1);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ADV-16: legit flows around the partial unique index — 300 NULL-permit scored shots (premium, pre-fix shape) coexist with vouched syncs; auth.users cascade for a user whose consumed permits back linked shots succeeds and leaves no rows",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await resetUsers(sql, true);
      await sql.unsafe(
        `insert into public.shots (
           id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
           overall_score, analysis_confidence, result_kind, app_version, model_bundle_version,
           pose_model_version, paddle_model_version, stroke_detector_version, phase_model_version,
           scoring_model_version, shot_config_version
         )
         select gen_random_uuid(), '${PREMIUM}', 'dink', 'side', '2026-08-01T10:00:00Z', 0, 100, 200,
                7, 0.9, 'scored', '1', '1', '1', '1', '1', '1', '1', '1'
         from generate_series(1, 300)`,
      );
      assertEquals(await shotCount(sql, PREMIUM), 300);
      const pA = await reserve(sql, PREMIUM, "adv16-a");
      const pB = await reserve(sql, PREMIUM, "adv16-b");
      assertEquals(await syncAs(sql, PREMIUM, shotPayload(shotId(), pA)), "accepted");
      assertEquals(await syncAs(sql, PREMIUM, shotPayload(shotId(), pB)), "accepted");
      assertEquals(await shotCount(sql, PREMIUM), 302);
      assertEquals(await shotCount(sql, PREMIUM, pA), 1);
      assertEquals(
        await syncAs(sql, PREMIUM, shotPayload(shotId(), pA)),
        "access.permit_not_reserved",
      );

      const p1 = await reserve(sql, U1, "adv16-1");
      const p2 = await reserve(sql, U1, "adv16-2");
      assertEquals(await syncAs(sql, U1, shotPayload(shotId(), p1)), "accepted");
      assertEquals(
        await syncAs(
          sql,
          U1,
          shotPayload(shotId(), p2, { resultKind: "low_confidence", overallScore: null }),
        ),
        "accepted",
      );
      assertEquals(await permitState(sql, p2), "released/low_confidence");
      assertEquals(await shotCount(sql, U1), 2);
      assertEquals(
        await attempt(sql, null, `delete from auth.users where id = '${U1}'`),
        "allowed 1",
      );
      assertEquals(await shotCount(sql, U1), 0);
      assertEquals(await permitState(sql, p1), "MISSING");
      assertEquals(await permitState(sql, p2), "MISSING");
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ADV-17 (BREAK, P2): ops path — the owner/service role can DELETE a permit that backs a shot (no FK: the link dangles) but can never re-load the identical settled row (23514), so a table-level data-only restore of analysis_permits fails while its shots exist and the orphan cannot be repaired",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await resetUsers(sql);
      const permit = await reserve(sql, U1, "adv17");
      const s1 = shotId();
      assertEquals(await syncAs(sql, U1, shotPayload(s1, permit)), "accepted");
      const before = await sql.unsafe(
        `select id::text as id, user_id::text as user_id, idempotency_key, status, outcome, created_at::text as created_at, updated_at::text as updated_at
         from public.analysis_permits where id = '${permit}'`,
      );
      assertEquals(before.length, 1);
      const r = before[0] as Record<string, string>;

      // Accidental/support deletion of the permit row (owner role; the RPC's
      // lifetime count and the shot survive, the link now points nowhere).
      assertEquals(
        await attempt(sql, null, `delete from public.analysis_permits where id = '${permit}'`),
        "allowed 1",
      );
      assertEquals(await permitState(sql, permit), "MISSING");
      assertEquals(await shotLink(sql, s1), permit);

      // pg_dump --data-only --column-inserts of that one row, replayed as the
      // owner: byte-identical settled row, same id, same user, same key.
      const restore = await attempt(
        sql,
        null,
        `insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome, created_at, updated_at)
         values ('${r.id}', '${r.user_id}', '${r.idempotency_key}', '${r.status}', '${r.outcome}', '${r.created_at}', '${r.updated_at}')`,
      );
      assertNotEquals(
        restore,
        "23514:access.permit_transition_rejected",
        `the guard refuses to restore the settled permit ${permit} that shot ${s1} still names (link ${await shotLink(sql, s1)}, permit ${await permitState(sql, permit)}): ` +
          `a data-only reload of analysis_permits cannot run while shots exist, and the dangling link cannot be repaired by any role`,
      );
      assertEquals(restore, "allowed 1");
      assertEquals(await permitState(sql, permit), "finalized/scored");
      // Restoring the settled row must not reopen it for a second shot.
      assertEquals(
        await syncAs(sql, U1, shotPayload(shotId(), permit)),
        "access.permit_not_reserved",
      );
      assertEquals(await shotCount(sql, U1), 1);
    } finally {
      await sql.end();
    }
  },
});
