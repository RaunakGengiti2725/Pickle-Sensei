/**
 * Round 9 (cluster sync-permit-durability, ADV-11-PREFIX-RESURRECTION +
 * ADV-17-SETTLED-UNRESTORABLE) — PRESERVE proofs for migration
 * 20260907100000_permit_settled_no_delete on a REAL Postgres 16.
 *
 * The adversary cases themselves live unchanged in
 * xc_pg_permit_terminal_adversary.test.ts (ADV-11 / ADV-17 go red → green).
 * This file pins what the fix must NOT break, plus the exact shape of the
 * tombstone contract, against the same disposable DB (./xc_pg_up.sh):
 *
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     deno test -A --no-check --config deno.json xc_pg_permit_delete_guard.test.ts
 *
 * Without XC_PG_URL (alias PICKLE_AUDIT_PG_URL) every test is `ignore`d — an
 * ignored run is NOT a pass.
 */
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

// Distinct from the round-7/8 suites' users so every file can share one DB.
const U1 = "0000000a-d7e0-4000-8000-000000000021";
const U2 = "0000000a-d7e0-4000-8000-000000000022";
const PREMIUM = "0000000a-d7e0-4000-8000-000000000023";

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
  return `0000000a-d7e0-4000-8000-3${String(shotSeq).padStart(11, "0")}`;
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

async function reserve(sql: Sql, userId: string, key: string): Promise<string> {
  const rows = await inTx(
    sql,
    userId,
    async (tx) =>
      await tx.unsafe(
        `select x.result, x.permit_id::text as permit_id from public.reserve_analysis_permit('${key}') x`,
      ),
  );
  const row = rows[0] as { result: string; permit_id: string | null };
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

async function tombstone(sql: Sql, permitId: string): Promise<string> {
  const rows = await sql.unsafe(
    `select user_id::text || ':' || status || '/' || coalesce(outcome, 'NULL') as s
     from public.analysis_permit_tombstones where permit_id = '${permitId}'`,
  );
  return rows.length === 0 ? "NONE" : String(rows[0].s);
}

async function shotCount(sql: Sql, userId: string, permitId?: string): Promise<number> {
  const where = permitId ? ` and analysis_permit_id = '${permitId}'` : "";
  const rows = await sql.unsafe(
    `select count(*)::int as n from public.shots where user_id = '${userId}'${where}`,
  );
  return Number(rows[0].n);
}

async function count(sql: Sql, stmt: string): Promise<number> {
  const rows = await sql.unsafe(`select count(*)::int as n from ${stmt}`);
  return Number(rows[0].n);
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

const REFUSED = "23514:access.permit_transition_rejected";

Deno.test({
  name: "R-1: owner DELETE of a settled permit tombstones it — reserved re-INSERT (same or another user) is 23514, the RPC answers access.permit_not_reserved for the owner of the id and access.permit_not_found for anyone else, no shot is written",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await resetUsers(sql, true);
      // A legacy-style settled permit: no shot names it (pre-20260907000000).
      const permit = await reserve(sql, PREMIUM, "r1");
      assertEquals(
        await attempt(
          sql,
          null,
          `update public.analysis_permits set status = 'finalized', outcome = 'scored' where id = '${permit}'`,
        ),
        "allowed 1",
      );
      assertEquals(await tombstone(sql, permit), "NONE");
      assertEquals(
        await attempt(sql, null, `delete from public.analysis_permits where id = '${permit}'`),
        "allowed 1",
      );
      assertEquals(await permitState(sql, permit), "MISSING");
      assertEquals(await tombstone(sql, permit), `${PREMIUM}:finalized/scored`);

      for (const [user, status, outcome] of [
        [PREMIUM, "reserved", null],
        [PREMIUM, "released", "expired"],
        [PREMIUM, "finalized", "cancelled"],
        [U1, "finalized", "scored"], // right shape, wrong owner
      ] as const) {
        const r = await attempt(
          sql,
          null,
          `insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome)
           values ('${permit}', '${user}', 'r1-again-${status}-${outcome ?? "null"}-${user.slice(-2)}', '${status}', ${outcome === null ? "null" : `'${outcome}'`})`,
        );
        assertEquals(r, REFUSED, `${user} ${status}/${outcome ?? "NULL"} must be refused`);
      }
      assertEquals(await permitState(sql, permit), "MISSING");

      assertEquals(
        await syncAs(sql, PREMIUM, shotPayload(shotId(), permit)),
        "access.permit_not_reserved",
      );
      assertEquals(await syncAs(sql, U1, shotPayload(shotId(), permit)), "access.permit_not_found");
      assertEquals(await shotCount(sql, PREMIUM), 0);
      assertEquals(await shotCount(sql, U1), 0);

      // The client role sees nothing of the tombstone table.
      assertEquals(
        await attempt(sql, PREMIUM, `select * from public.analysis_permit_tombstones`),
        "42501:null",
      );
      assertEquals(
        await attempt(
          sql,
          PREMIUM,
          `delete from public.analysis_permit_tombstones where permit_id = '${permit}'`,
        ),
        "42501:null",
      );
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "R-2: the exact restore consumes the tombstone (row back, finalized/scored, still consumed); a second DELETE re-tombstones; a restore with a different idempotency key is refused",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await resetUsers(sql);
      const permit = await reserve(sql, U1, "r2");
      const s1 = shotId();
      assertEquals(await syncAs(sql, U1, shotPayload(s1, permit)), "accepted");
      const before = await sql.unsafe(
        `select id::text as id, user_id::text as user_id, idempotency_key, status, outcome, created_at::text as created_at, updated_at::text as updated_at
         from public.analysis_permits where id = '${permit}'`,
      );
      const r = before[0] as Record<string, string>;
      const restoreStmt = (key: string) =>
        `insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome, created_at, updated_at)
         values ('${r.id}', '${r.user_id}', '${key}', '${r.status}', '${r.outcome}', '${r.created_at}', '${r.updated_at}')`;

      assertEquals(
        await attempt(sql, null, `delete from public.analysis_permits where id = '${permit}'`),
        "allowed 1",
      );
      assertEquals(await tombstone(sql, permit), `${U1}:finalized/scored`);
      assertEquals(await attempt(sql, null, restoreStmt("r2-other-key")), REFUSED);
      assertEquals(await attempt(sql, null, restoreStmt(r.idempotency_key)), "allowed 1");
      assertEquals(await permitState(sql, permit), "finalized/scored");
      assertEquals(await tombstone(sql, permit), "NONE");
      assertEquals(
        await syncAs(sql, U1, shotPayload(shotId(), permit)),
        "access.permit_not_reserved",
      );
      assertEquals(await shotCount(sql, U1), 1);

      // Round trip again: delete → tombstone → reserved re-INSERT refused →
      // restore allowed. The memory is idempotent.
      assertEquals(
        await attempt(sql, null, `delete from public.analysis_permits where id = '${permit}'`),
        "allowed 1",
      );
      assertEquals(await tombstone(sql, permit), `${U1}:finalized/scored`);
      assertEquals(
        await attempt(
          sql,
          null,
          `insert into public.analysis_permits (id, user_id, idempotency_key) values ('${permit}', '${U1}', 'r2-reopen')`,
        ),
        REFUSED,
      );
      assertEquals(await attempt(sql, null, restoreStmt(r.idempotency_key)), "allowed 1");
      assertEquals(await permitState(sql, permit), "finalized/scored");
      assertEquals(await shotCount(sql, U1, permit), 1);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "R-3: a reserved, unlinked permit is deleted by the owner role with no memory (ops hygiene): the id is re-issuable and the fresh row backs a shot once",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await resetUsers(sql);
      const permit = await reserve(sql, U1, "r3");
      assertEquals(await permitState(sql, permit), "reserved/NULL");
      assertEquals(
        await attempt(sql, null, `delete from public.analysis_permits where id = '${permit}'`),
        "allowed 1",
      );
      assertEquals(await tombstone(sql, permit), "NONE");
      assertEquals(
        await attempt(
          sql,
          null,
          `insert into public.analysis_permits (id, user_id, idempotency_key) values ('${permit}', '${U1}', 'r3-reissued')`,
        ),
        "allowed 1",
      );
      assertEquals(await syncAs(sql, U1, shotPayload(shotId(), permit)), "accepted");
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

Deno.test({
  name: "R-4: account deletion — `delete from auth.users` and `delete from public.profiles` both cascade every permit (settled, linked, reserved) and every shot, write NO tombstone, drop the user's existing tombstones, and free the ids for re-issue",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await resetUsers(sql);
      const seed = async (user: string, tag: string) => {
        const linked = await reserve(sql, user, `${tag}-linked`);
        assertEquals(await syncAs(sql, user, shotPayload(shotId(), linked)), "accepted");
        const settled = await reserve(sql, user, `${tag}-settled`);
        assertEquals(
          await attempt(
            sql,
            null,
            `update public.analysis_permits set status = 'finalized', outcome = 'cancelled' where id = '${settled}'`,
          ),
          "allowed 1",
        );
        const live = await reserve(sql, user, `${tag}-live`);
        // one pre-existing tombstone of this user (a free account holds at
        // most two live slots, so the settled row is seeded by the owner)
        const gone = `0000000a-d7e0-4000-8000-4${tag.slice(-1) === "a" ? "1" : "2"}0000000000`;
        assertEquals(
          await attempt(
            sql,
            null,
            `insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome)
             values ('${gone}', '${user}', '${tag}-gone', 'finalized', 'cancelled')`,
          ),
          "allowed 1",
        );
        assertEquals(
          await attempt(sql, null, `delete from public.analysis_permits where id = '${gone}'`),
          "allowed 1",
        );
        assertEquals(await tombstone(sql, gone), `${user}:finalized/cancelled`);
        assertEquals(await count(sql, `public.analysis_permits where user_id = '${user}'`), 3);
        assertEquals(await shotCount(sql, user), 1);
        return { linked, settled, live, gone };
      };
      const a = await seed(U1, "r4a");
      const b = await seed(U2, "r4b");

      assertEquals(
        await attempt(sql, null, `delete from auth.users where id = '${U1}'`),
        "allowed 1",
      );
      assertEquals(
        await attempt(sql, null, `delete from public.profiles where id = '${U2}'`),
        "allowed 1",
      );

      for (const [user, ids] of [
        [U1, a],
        [U2, b],
      ] as const) {
        assertEquals(await count(sql, `public.profiles where id = '${user}'`), 0);
        assertEquals(await count(sql, `public.analysis_permits where user_id = '${user}'`), 0);
        assertEquals(await shotCount(sql, user), 0);
        assertEquals(
          await count(sql, `public.analysis_permit_tombstones where user_id = '${user}'`),
          0,
        );
        for (const id of Object.values(ids)) {
          assertEquals(await permitState(sql, id), "MISSING");
          assertEquals(await tombstone(sql, id), "NONE");
        }
      }

      // The freed ids may be re-issued (no tombstone leak), as reserved.
      await sql.unsafe(
        `insert into auth.users (id, email, raw_app_meta_data) values ('${U1}', '${U1}@example.com', '{"provider":"google"}')`,
      );
      let n = 0;
      for (const id of [a.linked, a.settled, b.linked, b.gone]) {
        n += 1;
        assertEquals(
          await attempt(
            sql,
            null,
            `insert into public.analysis_permits (id, user_id, idempotency_key) values ('${id}', '${U1}', 'r4-reissue-${n}')`,
          ),
          "allowed 1",
          `freed id ${id} must be re-issuable`,
        );
      }
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "R-5: legitimate writers are untouched — reserve, edge finalize/release UPDATE, pg_cron sweep UPDATE, late sync of a swept permit, same-shot replay, premium NULL-permit rows; settled → reserved UPDATE is 23514 for the owner role too",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await resetUsers(sql, true);
      // edge finalize + release/cancel
      const fin = await reserve(sql, U1, "r5-fin");
      assertEquals(
        await attempt(
          sql,
          U1,
          `update public.analysis_permits set status = 'finalized', outcome = 'cancelled' where id = '${fin}'`,
        ),
        "allowed 1",
      );
      const rel = await reserve(sql, U1, "r5-rel");
      assertEquals(
        await attempt(
          sql,
          U1,
          `update public.analysis_permits set status = 'released', outcome = 'low_confidence' where id = '${rel}'`,
        ),
        "allowed 1",
      );
      // the exact pg_cron sweep statement, then the late sync of the swept row
      const swept = await reserve(sql, U1, "r5-swept");
      await sql.unsafe(
        `update public.analysis_permits set created_at = now() - interval '25 hours' where id = '${swept}'`,
      );
      assertEquals(
        await attempt(
          sql,
          null,
          `update public.analysis_permits set status = 'released', outcome = 'expired' where status = 'reserved' and created_at < now() - interval '24 hours'`,
        ),
        "allowed 1",
      );
      assertEquals(await permitState(sql, swept), "released/expired");
      const late = shotId();
      assertEquals(await syncAs(sql, U1, shotPayload(late, swept)), "accepted");
      assertEquals(await permitState(sql, swept), "finalized/scored");
      // same-shot replay
      assertEquals(await syncAs(sql, U1, shotPayload(late, swept)), "accepted");
      assertEquals(await shotCount(sql, U1), 1);
      assertEquals(await count(sql, `public.analysis_permit_tombstones`), 0);

      // premium: NULL-permit direct rows still coexist (partial index)
      for (let i = 0; i < 3; i += 1) {
        assertEquals(
          await attempt(
            sql,
            null,
            `insert into public.shots (
               id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
               overall_score, analysis_confidence, result_kind, app_version, model_bundle_version,
               pose_model_version, paddle_model_version, stroke_detector_version, phase_model_version,
               scoring_model_version, shot_config_version
             ) values (
               '${shotId()}', '${PREMIUM}', 'dink', 'side', '2026-08-01T10:00:00Z', 0, 100, 200,
               7, 0.9, 'scored', '1', '1', '1', '1', '1', '1', '1', '1')`,
          ),
          "allowed 1",
        );
      }
      const pp = await reserve(sql, PREMIUM, "r5-premium");
      assertEquals(await syncAs(sql, PREMIUM, shotPayload(shotId(), pp)), "accepted");
      assertEquals(await shotCount(sql, PREMIUM), 4);

      // the lifecycle guard holds for the owner role: no reopening a settled
      // row by UPDATE (20260906140000), DELETE is the only owner path and it
      // is remembered.
      for (const id of [fin, rel, swept]) {
        assertEquals(
          await attempt(
            sql,
            null,
            `update public.analysis_permits set status = 'reserved', outcome = null where id = '${id}'`,
          ),
          REFUSED,
          `owner settled → reserved UPDATE of ${id} must be refused`,
        );
      }
      // ...and the owner cannot switch the tombstone off with the
      // idempotency-key trick either: DELETE + INSERT (user_id, key) as a
      // fresh reservation under the same key gets a NEW id, never the old one.
      assertEquals(
        await attempt(sql, null, `delete from public.analysis_permits where id = '${fin}'`),
        "allowed 1",
      );
      const rows = await sql.unsafe(
        `insert into public.analysis_permits (user_id, idempotency_key) values ('${U1}', 'r5-fin') returning id::text as id`,
      );
      assert(rows.length === 1 && rows[0].id !== fin);
      assertEquals(await tombstone(sql, fin), `${U1}:finalized/cancelled`);
    } finally {
      await sql.end();
    }
  },
});
