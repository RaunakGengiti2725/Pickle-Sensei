/**
 * Round 9 ADVERSARY (cluster sync-permit-durability) against migration
 * 20260907100000_permit_settled_no_delete (the TOMBSTONE design that answers
 * ADV-11-PREFIX-RESURRECTION + ADV-17-SETTLED-UNRESTORABLE) on a REAL
 * Postgres 16 (./xc_pg_up.sh):
 *
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     deno test -A --no-check --config deno.json xc_pg_permit_tombstone_adversary.test.ts
 *
 * Every assertion states the candidate's OWN claim; a red test is an observed
 * break of that claim, not a wish. ADV-18..20 are red on ca5c5b25; ADV-21 is
 * the list of attacks that HELD (green) so the coordinator can see what was
 * tried. Without XC_PG_URL (alias PICKLE_AUDIT_PG_URL) every test is
 * `ignore`d — an ignored run is NOT a pass.
 *
 * Threat model, as in ADV-11/ADV-17: the owner / service role (support
 * tooling, ops SQL, a compromised service key). The `authenticated` role has
 * no DELETE, no UPDATE outside status/outcome, cannot pick `id`, and cannot
 * reach the tombstone table — every client path tried in ADV-21 held.
 */
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

// Distinct from the round-7/8/9 suites' users so every file can share one DB.
const U1 = "0000000a-d7e0-4000-8000-000000000031";
const U2 = "0000000a-d7e0-4000-8000-000000000032";
const PREMIUM = "0000000a-d7e0-4000-8000-000000000033";

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
  return `0000000a-d7e0-4000-8000-4${String(shotSeq).padStart(11, "0")}`;
}

let permitSeq = 0;
/** A permit id the attacker picks (owner INSERT / UPDATE may name `id`). */
function permitIdFor(tag: string): string {
  permitSeq += 1;
  return `0000000a-d7e0-4000-8000-9${tag.padStart(3, "0")}${String(permitSeq).padStart(8, "0")}`;
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

async function cleanup(sql: Sql): Promise<void> {
  // Leave the shared disposable database as found: the fixture users cascade
  // their permits, shots and tombstones; the fake pg_dump table goes too.
  await sql.unsafe(`drop table if exists public.adv20_dump`);
  for (const id of [U1, U2, PREMIUM]) {
    await sql.unsafe(`delete from auth.users where id = '${id}'`);
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

/** Every production shot written before 20260907000000 has no permit link
 * (the column did not exist). The owner clears the link a vouched sync just
 * wrote — the exact post-migration shape of a historical scored shot whose
 * permit is finalized/scored (same helper as ADV-11). */
async function makePreFix(sql: Sql, shot: string): Promise<void> {
  await sql.unsafe(`update public.shots set analysis_permit_id = null where id = '${shot}'`);
  assertEquals(await shotLink(sql, shot), "NULL");
}

/** Deterministic two-session ordering: resolve once backend `pid` is parked
 * on a heavyweight lock (pg_stat_activity.wait_event_type = 'Lock'). */
async function waitUntilBlocked(sql: Sql, pid: number): Promise<void> {
  for (let i = 0; i < 250; i += 1) {
    const rows = await sql.unsafe(
      `select wait_event_type as w from pg_stat_activity where pid = ${pid}`,
    );
    if (rows.length === 1 && rows[0].w === "Lock") return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`backend ${pid} never blocked on a lock`);
}

const REFUSED = "23514:access.permit_transition_rejected";

Deno.test({
  name: "ADV-18a (BREAK, P2): the owner/service role can UPDATE analysis_permits.id — a settled permit leaves its id with NO tombstone (the guard is BEFORE DELETE only, the lifecycle guard compares status/outcome only), so the id is re-issued as reserved and the RPC backs a second scored shot with it (pre-fix data)",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await resetUsers(sql, true);
      const permit = await reserve(sql, PREMIUM, "adv18a");
      const s1 = shotId();
      assertEquals(await syncAs(sql, PREMIUM, shotPayload(s1, permit)), "accepted");
      assertEquals(await permitState(sql, permit), "finalized/scored");
      await makePreFix(sql, s1);

      const parked = permitIdFor("18a");
      const rename = await attempt(
        sql,
        null,
        `update public.analysis_permits set id = '${parked}' where id = '${permit}'`,
      );
      // Claim (2): "a settled permit that leaves the table is tombstoned". The
      // lifecycle guard (BEFORE UPDATE) only compares status/outcome and the
      // delete guard never fires, so the id is simply free again.
      assertEquals(await permitState(sql, permit), "MISSING");
      assertEquals(await permitState(sql, parked), "finalized/scored");
      const reissue = await attempt(
        sql,
        null,
        `insert into public.analysis_permits (id, user_id, idempotency_key) values ('${permit}', '${PREMIUM}', 'adv18a-again')`,
      );
      const second = await syncAs(sql, PREMIUM, shotPayload(shotId(), permit));
      const scored = await shotCount(sql, PREMIUM);
      assert(
        rename.startsWith("23514") || (await tombstone(sql, permit)) !== "NONE",
        `owner UPDATE of the primary key moved the settled permit ${permit} → ${parked} (${rename}) and left NO tombstone for the old id; ` +
          `reserved re-INSERT of the old id: ${reissue}; second sync naming it: ${second}; scored shots for one settled id: ${scored}`,
      );
      assertEquals(reissue, REFUSED);
      assertEquals(second, "access.permit_not_reserved");
      assertEquals(scored, 1);
    } finally {
      await cleanup(sql);
      await sql.end();
    }
  },
});

Deno.test({
  name: "ADV-18b (BREAK, P2): an id WITH a tombstone — the reserved re-INSERT is refused (claim 3 holds for INSERT) but UPDATE … SET id renames a fresh reserved permit ONTO the tombstoned id: no trigger compares it with the tombstone, the row is reserved beside the finalized/scored tombstone and the RPC backs a second scored shot with the id (pre-fix data)",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await resetUsers(sql, true);
      const consumed = await reserve(sql, PREMIUM, "adv18b");
      const s2 = shotId();
      assertEquals(await syncAs(sql, PREMIUM, shotPayload(s2, consumed)), "accepted");
      await makePreFix(sql, s2);
      assertEquals(
        await attempt(sql, null, `delete from public.analysis_permits where id = '${consumed}'`),
        "allowed 1",
      );
      assertEquals(await tombstone(sql, consumed), `${PREMIUM}:finalized/scored`);
      assertEquals(
        await attempt(
          sql,
          null,
          `insert into public.analysis_permits (id, user_id, idempotency_key) values ('${consumed}', '${PREMIUM}', 'adv18b-again')`,
        ),
        REFUSED,
        "claim (3) holds for INSERT",
      );
      const fresh = await reserve(sql, PREMIUM, "adv18b-fresh");
      const renameOnto = await attempt(
        sql,
        null,
        `update public.analysis_permits set id = '${consumed}' where id = '${fresh}'`,
      );
      const stateAfter = await permitState(sql, consumed);
      const tombAfter = await tombstone(sql, consumed);
      const secondB = await syncAs(sql, PREMIUM, shotPayload(shotId(), consumed));
      assertEquals(
        renameOnto,
        REFUSED,
        `claim (3) "an id with a tombstone comes back only as the identical row, any other shape → 23514 for every role": ` +
          `UPDATE … SET id renamed reserved permit ${fresh} onto tombstoned id ${consumed} (${renameOnto}); ` +
          `row now ${stateAfter} while the tombstone still says ${tombAfter}; sync naming the tombstoned id: ${secondB}; scored shots: ${await shotCount(sql, PREMIUM)}`,
      );
      assertEquals(secondB, "access.permit_not_reserved");
      assertEquals(await shotCount(sql, PREMIUM), 1);
    } finally {
      await cleanup(sql);
      await sql.end();
    }
  },
});

Deno.test({
  name: "ADV-18c (BREAK, P2): a LINKED settled permit renamed away by UPDATE … SET id leaves its shot naming an id that has no row and no tombstone, and the identical settled row can never be put back under that id (23514) — the ADV-17 unrepairable orphan, one UPDATE instead of one DELETE",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await resetUsers(sql, true);
      const linked = await reserve(sql, PREMIUM, "adv18c");
      const s3 = shotId();
      assertEquals(await syncAs(sql, PREMIUM, shotPayload(s3, linked)), "accepted");
      assertEquals(await shotLink(sql, s3), linked);
      const parkedC = permitIdFor("18c");
      const renameC = await attempt(
        sql,
        null,
        `update public.analysis_permits set id = '${parkedC}' where id = '${linked}'`,
      );
      const restoreC = await attempt(
        sql,
        null,
        `insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome)
         values ('${linked}', '${PREMIUM}', 'adv18c-restore', 'finalized', 'scored')`,
      );
      assert(
        renameC.startsWith("23514") || restoreC.startsWith("allowed"),
        `linked permit ${linked} renamed to ${parkedC} (${renameC}): shot ${s3} still names ${await shotLink(sql, s3)} (no FK, no tombstone: ${await tombstone(sql, linked)}), ` +
          `and putting the identical settled row back under the old id is refused (${restoreC}) — the ADV-17 unrepairable orphan, one UPDATE instead of one DELETE`,
      );
    } finally {
      await cleanup(sql);
      await sql.end();
    }
  },
});

Deno.test({
  name: "ADV-19 (BREAK, P2): two owner sessions — a DELETE of a settled permit still in flight makes the tombstone invisible to a concurrent reserved re-INSERT of the same id; the INSERT waits on the primary key, then lands as reserved beside the committed tombstone, and the RPC backs a second scored shot with the id (pre-fix data)",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    const deleter = postgres(PG_URL, { max: 1 });
    const inserter = postgres(PG_URL, { max: 1 });
    try {
      await resetUsers(sql, true);
      const permit = await reserve(sql, PREMIUM, "adv19");
      const s1 = shotId();
      assertEquals(await syncAs(sql, PREMIUM, shotPayload(s1, permit)), "accepted");
      assertEquals(await permitState(sql, permit), "finalized/scored");
      await makePreFix(sql, s1);

      // Session A: DELETE, tombstone written, transaction left open.
      await deleter.unsafe(`begin`);
      await deleter.unsafe(`delete from public.analysis_permits where id = '${permit}'`);

      // Session B: the round-7 reserved re-INSERT. Its BEFORE INSERT guard
      // runs NOW (READ COMMITTED: A's tombstone is not visible, the shot has
      // no link), then the row waits on A for the primary key.
      const pid = Number((await inserter.unsafe(`select pg_backend_pid() as pid`))[0].pid);
      const insert = inserter
        .unsafe(
          `insert into public.analysis_permits (id, user_id, idempotency_key) values ('${permit}', '${PREMIUM}', 'adv19-again')`,
        )
        .then(
          () => "allowed 1",
          (e) => {
            const { code, hint } = pgError(e);
            return `${code}:${hint}`;
          },
        );
      await waitUntilBlocked(sql, pid);
      await deleter.unsafe(`commit`);
      const insertResult = await insert;

      const state = await permitState(sql, permit);
      const tomb = await tombstone(sql, permit);
      const second = await syncAs(sql, PREMIUM, shotPayload(shotId(), permit));
      const scored = await shotCount(sql, PREMIUM);
      assertEquals(
        insertResult,
        REFUSED,
        `claim (3): a tombstoned id may only come back as the identical row. Concurrent reserved re-INSERT: ${insertResult}; ` +
          `row after both commits: ${state} while the tombstone says ${tomb}; sync naming the id: ${second}; scored shots for one settled id: ${scored}`,
      );
      assertEquals(second, "access.permit_not_reserved");
      assertEquals(scored, 1);
    } finally {
      await cleanup(sql);
      await deleter.end();
      await inserter.end();
      await sql.end();
    }
  },
});

Deno.test({
  name: "ADV-20 (BREAK, P2): TRUNCATE public.analysis_permits (owner privilege, no row triggers) removes every settled/linked permit with NO tombstone while their shots survive, and the table-level data-only reload that ADV-17 declared legitimate is refused 23514 for every linked permit — the ADV-17 orphan for a whole table",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await resetUsers(sql, true);
      const permit = await reserve(sql, PREMIUM, "adv20");
      const s1 = shotId();
      assertEquals(await syncAs(sql, PREMIUM, shotPayload(s1, permit)), "accepted");
      assertEquals(await shotLink(sql, s1), permit);

      // pg_dump --data-only of the table, taken while everything is consistent
      // (a plain table, not a temp one: the pool may hand out another session).
      await sql.unsafe(`drop table if exists public.adv20_dump`);
      await sql.unsafe(
        `create table public.adv20_dump as select * from public.analysis_permits where id = '${permit}'`,
      );

      // The reload pattern for a data-only dump: empty the table, COPY it back.
      // TRUNCATE is table-owner privilege, not superuser, and fires no row
      // trigger — the tombstone guard never runs.
      const truncate = await attempt(sql, null, `truncate public.analysis_permits`);
      assertEquals(truncate, "allowed null");
      assertEquals(await permitState(sql, permit), "MISSING");
      assertEquals(await shotLink(sql, s1), permit, "the shot survives with a dangling link");
      const tomb = await tombstone(sql, permit);

      const reload = await attempt(
        sql,
        null,
        `insert into public.analysis_permits select * from public.adv20_dump`,
      );
      await sql.unsafe(`drop table public.adv20_dump`);
      assert(
        tomb !== "NONE" || reload.startsWith("allowed"),
        `TRUNCATE removed settled linked permit ${permit} with tombstone=${tomb} while shot ${s1} still names it; ` +
          `reloading the identical dumped row: ${reload}; permit now ${await permitState(sql, permit)} — ` +
          `the ADV-17 data-only restore is refused again, one TRUNCATE instead of one DELETE`,
      );
      assertEquals(reload, "allowed 1");
      assertEquals(await permitState(sql, permit), "finalized/scored");
    } finally {
      await cleanup(sql);
      await sql.end();
    }
  },
});

Deno.test({
  name: "ADV-21 (HELD, green): attacks that did NOT break the tombstone — DELETE + re-INSERT in one transaction and in one wCTE statement; concurrent identical restores (exactly one lands); DELETE racing apply_synced_shot in both orders; tombstoned reserved+linked restore → contract verdict, never 23505; permit_tombstoned()/RPC verdicts are caller-scoped (no cross-user oracle); profile-only delete cascades shots and tombstones; legal released/expired → finalized/scored re-tombstone; trigger functions and tombstone table unreachable for clients",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 6 });
    const a = postgres(PG_URL, { max: 1 });
    const b = postgres(PG_URL, { max: 1 });
    try {
      await resetUsers(sql, true);

      // Same transaction / same statement: the trigger sees its own tombstone.
      const p1 = await reserve(sql, PREMIUM, "adv21-1");
      assertEquals(await syncAs(sql, PREMIUM, shotPayload(shotId(), p1)), "accepted");
      assertEquals(
        await attempt(
          sql,
          null,
          `delete from public.analysis_permits where id = '${p1}';
           insert into public.analysis_permits (id, user_id, idempotency_key) values ('${p1}', '${PREMIUM}', 'adv21-1-tx')`,
        ),
        REFUSED,
      );
      assertEquals(
        await attempt(
          sql,
          null,
          `with d as (delete from public.analysis_permits where id = '${p1}' returning *)
           insert into public.analysis_permits (id, user_id, idempotency_key) select id, user_id, idempotency_key || '-w' from d`,
        ),
        REFUSED,
      );
      assertEquals(await permitState(sql, p1), "finalized/scored");
      assertEquals(await tombstone(sql, p1), "NONE");

      // Concurrent identical restores of a tombstoned linked permit.
      assertEquals(
        await attempt(sql, null, `delete from public.analysis_permits where id = '${p1}'`),
        "allowed 1",
      );
      const row = `('${p1}', '${PREMIUM}', 'adv21-1', 'finalized', 'scored')`;
      await a.unsafe(`begin`);
      await a.unsafe(
        `insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome) values ${row}`,
      );
      const pidB = Number((await b.unsafe(`select pg_backend_pid() as pid`))[0].pid);
      const loser = b
        .unsafe(
          `insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome) values ${row}`,
        )
        .then(
          () => "allowed 1",
          (e) => {
            const { code, hint } = pgError(e);
            return `${code}:${hint}`;
          },
        );
      await waitUntilBlocked(sql, pidB);
      await a.unsafe(`commit`);
      assertEquals(await loser, REFUSED, "second identical restore (id already on a shot)");
      assertEquals(await permitState(sql, p1), "finalized/scored");
      assertEquals(await tombstone(sql, p1), "NONE");

      // DELETE racing the RPC, both orders (released/expired = late-sync backing).
      const p2 = await reserve(sql, PREMIUM, "adv21-2");
      await sql.unsafe(
        `update public.analysis_permits set status = 'released', outcome = 'expired' where id = '${p2}'`,
      );
      await a.unsafe(`begin`);
      await a.unsafe(`delete from public.analysis_permits where id = '${p2}'`);
      const pidSync = Number((await b.unsafe(`select pg_backend_pid() as pid`))[0].pid);
      const lateSync = b.begin(async (tx) => {
        await asUser(tx as unknown as Tx, PREMIUM);
        return await sync(tx as unknown as Tx, shotPayload(shotId(), p2));
      });
      await waitUntilBlocked(sql, pidSync);
      await a.unsafe(`commit`);
      assertEquals(await lateSync, "access.permit_not_reserved");
      assertEquals(await shotCount(sql, PREMIUM, p2), 0);

      const p3 = await reserve(sql, PREMIUM, "adv21-3");
      await b.unsafe(`begin`);
      await asUser(b as unknown as Tx, PREMIUM);
      assertEquals(await sync(b as unknown as Tx, shotPayload(shotId(), p3)), "accepted");
      const pidDel = Number((await a.unsafe(`select pg_backend_pid() as pid`))[0].pid);
      const del = a.unsafe(`delete from public.analysis_permits where id = '${p3}'`).then(
        (r) => `allowed ${r.count}`,
        (e) => pgError(e).code,
      );
      await waitUntilBlocked(sql, pidDel);
      await b.unsafe(`commit`);
      assertEquals(await del, "allowed 1");
      assertEquals(await tombstone(sql, p3), `${PREMIUM}:finalized/scored`);
      assertEquals(await shotCount(sql, PREMIUM, p3), 1);

      // Tombstoned reserved+linked permit restored identical: the second shot
      // gets a contract verdict, not 23505.
      const p4 = await reserve(sql, PREMIUM, "adv21-4");
      const s4 = shotId();
      assertEquals(await syncAs(sql, PREMIUM, shotPayload(s4, p4)), "accepted");
      const p5 = await reserve(sql, PREMIUM, "adv21-5");
      await sql.unsafe(`update public.shots set analysis_permit_id = '${p5}' where id = '${s4}'`);
      assertEquals(
        await attempt(sql, null, `delete from public.analysis_permits where id = '${p5}'`),
        "allowed 1",
      );
      assertEquals(await tombstone(sql, p5), `${PREMIUM}:reserved/NULL`);
      assertEquals(
        await attempt(
          sql,
          null,
          `insert into public.analysis_permits (id, user_id, idempotency_key) values ('${p5}', '${PREMIUM}', 'adv21-5')`,
        ),
        "allowed 1",
      );
      assertEquals(
        await syncAs(sql, PREMIUM, shotPayload(shotId(), p5)),
        "access.permit_not_reserved",
      );
      assertEquals(await shotCount(sql, PREMIUM, p5), 1);

      // Oracle: caller-scoped everywhere.
      const p6 = await reserve(sql, U1, "adv21-6");
      assertEquals(await syncAs(sql, U1, shotPayload(shotId(), p6)), "accepted");
      assertEquals(
        await attempt(sql, null, `delete from public.analysis_permits where id = '${p6}'`),
        "allowed 1",
      );
      const tombstonedFor = async (u: string) =>
        (await inTx(sql, u, (tx) => tx.unsafe(`select public.permit_tombstoned('${p6}') as t`)))[0]
          .t;
      assertEquals(await tombstonedFor(U1), true);
      assertEquals(await tombstonedFor(U2), false);
      assertEquals(
        await attempt(sql, null, `set local role anon; select public.permit_tombstoned('${p6}')`),
        "42501:null",
      );
      assertEquals(await syncAs(sql, U1, shotPayload(shotId(), p6)), "access.permit_not_reserved");
      assertEquals(await syncAs(sql, U2, shotPayload(shotId(), p6)), "access.permit_not_found");
      assertEquals(
        await syncAs(sql, U2, shotPayload(shotId(), "0000000a-d7e0-4000-8000-00000000dead")),
        "access.permit_not_found",
      );
      for (const stmt of [
        `select * from public.analysis_permit_tombstones`,
        `delete from public.analysis_permit_tombstones`,
        `select public.guard_analysis_permit_delete()`,
        `select public.guard_analysis_permit_resurrection()`,
        `update public.analysis_permits set id = '0000000a-d7e0-4000-8000-00000000beef' where user_id = '${U1}'`,
        `truncate public.analysis_permits`,
      ]) {
        assert((await attempt(sql, U1, stmt)).startsWith("42501"), stmt);
      }

      // Profile-only delete (auth.users row alive): permits, shots and
      // tombstones all cascade; the re-created profile reserves normally.
      assertEquals(
        await attempt(sql, null, `delete from public.profiles where id = '${U1}'`),
        "allowed 1",
      );
      assertEquals(await tombstone(sql, p6), "NONE");
      assertEquals(await shotCount(sql, U1), 0);
      assertEquals(
        await attempt(sql, null, `insert into public.profiles (id) values ('${U1}')`),
        "allowed 1",
      );
      assertEquals((await reserveRow(sql, U1, "adv21-6")).result, "accepted");

      // Legal released/expired → (restore) → late sync → finalized/scored:
      // the re-tombstone carries the new shape; the old shape is refused.
      const p7 = await reserve(sql, PREMIUM, "adv21-7");
      await sql.unsafe(
        `update public.analysis_permits set status = 'released', outcome = 'expired' where id = '${p7}'`,
      );
      assertEquals(
        await attempt(sql, null, `delete from public.analysis_permits where id = '${p7}'`),
        "allowed 1",
      );
      assertEquals(
        await attempt(
          sql,
          null,
          `insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome) values ('${p7}', '${PREMIUM}', 'adv21-7', 'released', 'expired')`,
        ),
        "allowed 1",
      );
      assertEquals(await syncAs(sql, PREMIUM, shotPayload(shotId(), p7)), "accepted");
      assertEquals(
        await attempt(sql, null, `delete from public.analysis_permits where id = '${p7}'`),
        "allowed 1",
      );
      assertEquals(await tombstone(sql, p7), `${PREMIUM}:finalized/scored`);
      assertEquals(
        await attempt(
          sql,
          null,
          `insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome) values ('${p7}', '${PREMIUM}', 'adv21-7', 'released', 'expired')`,
        ),
        REFUSED,
      );
      assertEquals(await shotCount(sql, PREMIUM, p7), 1);
    } finally {
      await cleanup(sql);
      await a.end();
      await b.end();
      await sql.end();
    }
  },
});
