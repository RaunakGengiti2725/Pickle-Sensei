/**
 * stress — POST /v1/sessions/:id/finalize (end session): REAL POSTGRES half.
 *
 * The route performs exactly two PostgREST statements as the caller
 * (`authenticated` + jwt sub, RLS applies), each in its own transaction:
 *
 *   S1  select id, ended_at from public.sessions where id = $1 and user_id = $2      (maybeSingle)
 *   S2  update public.sessions set ended_at = $now where id = $1 and user_id = $2    (only when S1.ended_at is null)
 *
 * This file drives S1/S2 verbatim on a disposable postgres:16 with
 * shim_auth.sql + EVERY migration applied (./xc_pg_up.sh), through N
 * independent connections, so the DB-level semantics the edge fn relies on
 * are proven rather than modelled:
 *
 *   PG1 idempotency: STRESS_ITER finalize→replay pairs; the replay never writes
 *       and ended_at is byte-identical; per-statement latency p50/p95.
 *   PG2 concurrent duplicate delivery: LANES connections run S1 then S2 on ONE
 *       session from a barrier — how many rows each UPDATE touched, how many
 *       distinct ended_at values were written (last writer wins), no error.
 *   PG3 tenant isolation: another user's S1 sees no row and S2 touches 0 rows
 *       (RLS), anon is refused outright.
 *   PG4 column grant: authenticated may move ONLY ended_at (42501 on any other
 *       column) — the boundary defense_in_depth.sql draws around this route.
 *   PG5 free-rating / permit ledgers are untouched by finalization
 *       (shots, analysis_permits, free_rating_ledger counts before == after).
 *
 *   XC_PG_CONTAINER=pickle-stress-pg XC_PG_PORT=55434 ./xc_pg_up.sh
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55434/postgres STRESS_ITER=1000 \
 *     deno test -A --no-check --config deno.json stress_end_session_pg.test.ts
 *
 * Without XC_PG_URL every test is `ignore`d — an ignored run is NOT a pass.
 */
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import {
  latencyStats,
  Prng,
  replayCommand,
  STRESS_ITER,
  STRESS_SEED,
  writeJson,
} from "./stress_end_session_harness.ts";
import { envInt } from "./xc_concurrency_harness.ts";

const FILE = "stress_end_session_pg.test.ts";
const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const LANES = envInt("STRESS_PG_LANES", 16);
const PG_ITER = Math.min(STRESS_ITER, envInt("STRESS_PG_ITER", 1000));

type Sql = ReturnType<typeof postgres>;

const connect = (max: number): Sql => postgres(PG_URL, { max, onnotice: () => {} });

async function createUser(sql: Sql, userId: string): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${userId}', '${userId}@example.com', '{"provider":"google"}')`,
  );
}

async function createSession(
  sql: Sql,
  sessionId: string,
  userId: string,
  endedAt: string | null,
): Promise<void> {
  await sql.unsafe(
    `insert into public.sessions (id, user_id, kind, started_at, ended_at)
       values ('${sessionId}', '${userId}', 'practice', now() - interval '30 minutes', ${endedAt ? `'${endedAt}'` : "null"})`,
  );
}

/** S1 as the route issues it (PostgREST GET …&id=eq.&user_id=eq. → maybeSingle). */
async function s1(
  sql: Sql,
  userId: string,
  sessionId: string,
): Promise<{ id: string; ended_at: Date | null } | null> {
  return await sql.begin(async (tx) => {
    await tx.unsafe(`set local role authenticated`);
    await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
    const rows = await tx.unsafe<{ id: string; ended_at: Date | null }[]>(
      `select id, ended_at from public.sessions where id = '${sessionId}' and user_id = '${userId}'`,
    );
    if (rows.length > 1) throw new Error(`S1 returned ${rows.length} rows`);
    return rows[0] ?? null;
  });
}

/** S2 as the route issues it (PostgREST PATCH …&id=eq.&user_id=eq. {ended_at}). Returns affected rows. */
async function s2(sql: Sql, userId: string, sessionId: string, endedAt: string): Promise<number> {
  return await sql.begin(async (tx) => {
    await tx.unsafe(`set local role authenticated`);
    await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
    const res = await tx.unsafe(
      `update public.sessions set ended_at = '${endedAt}' where id = '${sessionId}' and user_id = '${userId}'`,
    );
    return res.count;
  });
}

/** The route's control flow over S1/S2 (index.ts finalizeSession). */
async function routeFinalize(
  sql: Sql,
  userId: string,
  sessionId: string,
): Promise<{ status: number; wrote: boolean; s1Ms: number; s2Ms: number }> {
  const t1 = performance.now();
  const found = await s1(sql, userId, sessionId);
  const s1Ms = performance.now() - t1;
  if (!found) return { status: 404, wrote: false, s1Ms, s2Ms: 0 };
  if (found.ended_at === null) {
    const t2 = performance.now();
    const n = await s2(sql, userId, sessionId, new Date().toISOString());
    return { status: 200, wrote: n === 1, s1Ms, s2Ms: performance.now() - t2 };
  }
  return { status: 200, wrote: false, s1Ms, s2Ms: 0 };
}

async function ownerRow(
  sql: Sql,
  sessionId: string,
): Promise<{ ended_at: Date | null; updated_at: Date }> {
  const rows = await sql.unsafe<{ ended_at: Date | null; updated_at: Date }[]>(
    `select ended_at, updated_at from public.sessions where id = '${sessionId}'`,
  );
  return rows[0];
}

Deno.test({
  name: `stress/end-session pg: PG1 ${PG_ITER} finalize→replay pairs are idempotent (real RLS + grants)`,
  ignore,
  async fn() {
    const sql = connect(4);
    const prng = new Prng(STRESS_SEED ^ 0x9601);
    try {
      const userId = prng.uuid();
      await createUser(sql, userId);
      const rows: Array<{
        i: number;
        session: string;
        first: number;
        replay: number;
        wroteFirst: boolean;
        wroteReplay: boolean;
        stable: boolean;
      }> = [];
      const s1Lat: number[] = [];
      const s2Lat: number[] = [];
      for (let i = 0; i < PG_ITER; i += 1) {
        const sessionId = prng.uuid();
        await createSession(sql, sessionId, userId, null);
        const first = await routeFinalize(sql, userId, sessionId);
        const afterFirst = await ownerRow(sql, sessionId);
        const replay = await routeFinalize(sql, userId, sessionId);
        const afterReplay = await ownerRow(sql, sessionId);
        s1Lat.push(first.s1Ms, replay.s1Ms);
        if (first.s2Ms) s2Lat.push(first.s2Ms);
        rows.push({
          i,
          session: sessionId,
          first: first.status,
          replay: replay.status,
          wroteFirst: first.wrote,
          wroteReplay: replay.wrote,
          stable:
            afterFirst.ended_at?.getTime() === afterReplay.ended_at?.getTime() &&
            afterFirst.updated_at.getTime() === afterReplay.updated_at.getTime(),
        });
      }
      const bad = rows.filter(
        (r) => !(r.first === 200 && r.replay === 200 && r.wroteFirst && !r.wroteReplay && r.stable),
      );
      await writeJson("pg_idempotency", {
        seed: STRESS_SEED ^ 0x9601,
        pairs: rows.length,
        s1: latencyStats(s1Lat),
        s2: latencyStats(s2Lat),
        violations: bad,
        replay: replayCommand(FILE, "PG1", STRESS_SEED),
        rows,
      });
      assertEquals(
        bad,
        [],
        "every pair: first writes once, replay writes nothing, row byte-stable",
      );
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: `stress/end-session pg: PG2 ${LANES} concurrent duplicate deliveries on ONE session`,
  ignore,
  async fn() {
    const sql = connect(LANES + 2);
    const prng = new Prng(STRESS_SEED ^ 0x9602);
    try {
      const userId = prng.uuid();
      await createUser(sql, userId);
      const results = [];
      for (let round = 0; round < 5; round += 1) {
        const sessionId = prng.uuid();
        await createSession(sql, sessionId, userId, null);
        let open!: () => void;
        const gate = new Promise<void>((r) => (open = r));
        const lanes = Array.from({ length: LANES }, async (_, lane) => {
          await gate;
          const found = await s1(sql, userId, sessionId);
          const sawNull = found?.ended_at === null;
          let updated = 0;
          let stamp: string | null = null;
          let error: string | null = null;
          if (sawNull) {
            stamp = new Date(Date.now() + lane).toISOString(); // distinct per lane, as distinct isolates would produce
            try {
              updated = await s2(sql, userId, sessionId, stamp);
            } catch (e) {
              error = e instanceof Error ? e.message : String(e);
            }
          }
          return { lane, sawNull, updated, stamp, error };
        });
        open();
        const lanesOut = await Promise.all(lanes);
        const final = await ownerRow(sql, sessionId);
        const writers = lanesOut.filter((l) => l.updated === 1);
        results.push({
          round,
          session: sessionId,
          lanesSawNull: lanesOut.filter((l) => l.sawNull).length,
          updatesApplied: writers.length,
          distinctStamps: new Set(writers.map((w) => w.stamp)).size,
          finalEndedAt: final.ended_at?.toISOString() ?? null,
          finalIsOneOfWriters: writers.some(
            (w) => w.stamp && new Date(w.stamp).getTime() === final.ended_at?.getTime(),
          ),
          errors: lanesOut.filter((l) => l.error).map((l) => l.error),
          lanes: lanesOut,
        });
      }
      await writeJson("pg_concurrent_duplicates", {
        seed: STRESS_SEED ^ 0x9602,
        lanes: LANES,
        note: "S2 has no `and ended_at is null` guard: every lane whose S1 saw null re-stamps ended_at; last writer wins. No error, no lost row — ended_at drifts within the race window.",
        results,
        replay: replayCommand(FILE, "PG2", STRESS_SEED),
      });
      for (const r of results) {
        assertEquals(r.errors, [], "no lane errored");
        assert(r.finalEndedAt !== null, "session ended");
        assert(r.finalIsOneOfWriters, "final ended_at is one of the writers' stamps");
        assert(r.updatesApplied >= 1, "at least one lane wrote");
        assertEquals(
          r.updatesApplied,
          r.lanesSawNull,
          "every lane that read null wrote (unguarded UPDATE)",
        );
      }
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "stress/end-session pg: PG3 tenant isolation — other user sees nothing, anon refused",
  ignore,
  async fn() {
    const sql = connect(2);
    const prng = new Prng(STRESS_SEED ^ 0x9603);
    try {
      const owner = prng.uuid();
      const other = prng.uuid();
      await createUser(sql, owner);
      await createUser(sql, other);
      const out: Record<string, unknown> = {};
      const trials = 50;
      let leaks = 0;
      let writes = 0;
      for (let i = 0; i < trials; i += 1) {
        const sessionId = prng.uuid();
        await createSession(sql, sessionId, owner, null);
        // route as `other` with the OWNER's session id (user_id filter is the caller's id)
        if ((await s1(sql, other, sessionId)) !== null) leaks += 1;
        writes += await s2(sql, other, sessionId, new Date().toISOString());
        // forged filter: `other` naming the owner's user_id explicitly — RLS must still hide it
        const forged = await sql.begin(async (tx) => {
          await tx.unsafe(`set local role authenticated`);
          await tx.unsafe(`set local request.jwt.claim.sub = '${other}'`);
          const r = await tx.unsafe(
            `select id from public.sessions where id = '${sessionId}' and user_id = '${owner}'`,
          );
          const u = await tx.unsafe(
            `update public.sessions set ended_at = now() where id = '${sessionId}' and user_id = '${owner}'`,
          );
          return { rows: r.length, updated: u.count };
        });
        leaks += forged.rows;
        writes += forged.updated;
        assertEquals((await ownerRow(sql, sessionId)).ended_at, null, `owner row untouched (${i})`);
      }
      out.crossTenant = { trials, leaks, writes };
      let anonError = "";
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe(`set local role anon`);
          await tx.unsafe(`select id, ended_at from public.sessions limit 1`);
        });
      } catch (e) {
        anonError = e instanceof Error ? e.message : String(e);
      }
      out.anon = { error: anonError };
      await writeJson("pg_isolation", {
        seed: STRESS_SEED ^ 0x9603,
        ...out,
        replay: replayCommand(FILE, "PG3", STRESS_SEED),
      });
      assertEquals(leaks, 0, "no cross-tenant read");
      assertEquals(writes, 0, "no cross-tenant write");
      assert(
        /permission denied/i.test(anonError),
        `anon must be refused, got: ${anonError || "(no error)"}`,
      );
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "stress/end-session pg: PG4 column grant — authenticated moves ended_at only",
  ignore,
  async fn() {
    const sql = connect(2);
    const prng = new Prng(STRESS_SEED ^ 0x9604);
    try {
      const userId = prng.uuid();
      await createUser(sql, userId);
      const sessionId = prng.uuid();
      await createSession(sql, sessionId, userId, null);
      const attempt = async (setClause: string) => {
        try {
          await sql.begin(async (tx) => {
            await tx.unsafe(`set local role authenticated`);
            await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
            await tx.unsafe(
              `update public.sessions set ${setClause} where id = '${sessionId}' and user_id = '${userId}'`,
            );
          });
          return "ok";
        } catch (e) {
          const err = e as { code?: string; message?: string };
          return `${err.code ?? "?"}: ${err.message ?? String(e)}`;
        }
      };
      const table = {
        ended_at: await attempt(`ended_at = now()`),
        started_at: await attempt(`started_at = now()`),
        notes: await attempt(`notes = 'x'`),
        kind: await attempt(`kind = 'game'`),
        event_count: await attempt(`event_count = 9`),
        user_id: await attempt(`user_id = '${userId}'`),
        ended_at_plus_notes: await attempt(`ended_at = now(), notes = 'x'`),
      };
      await writeJson("pg_column_grant", {
        seed: STRESS_SEED ^ 0x9604,
        table,
        replay: replayCommand(FILE, "PG4", STRESS_SEED),
      });
      assertEquals(table.ended_at, "ok");
      for (const [col, res] of Object.entries(table)) {
        if (col === "ended_at") continue;
        assert(res.startsWith("42501"), `${col}: expected 42501, got ${res}`);
      }
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "stress/end-session pg: PG5 finalization never touches permits / shots / free-rating ledger",
  ignore,
  async fn() {
    const sql = connect(2);
    const prng = new Prng(STRESS_SEED ^ 0x9605);
    try {
      const userId = prng.uuid();
      await createUser(sql, userId);
      const counts = async () => {
        const [r] = await sql.unsafe<Array<Record<string, string>>>(
          `select (select count(*) from public.shots) as shots,
                  (select count(*) from public.analysis_permits) as permits,
                  (select count(*) from public.free_rating_ledger) as ledger,
                  (select coalesce(sum(scored_count), 0) from public.free_rating_ledger) as ledger_scored`,
        );
        return r;
      };
      const before = await counts();
      const N = 100;
      for (let i = 0; i < N; i += 1) {
        const sessionId = prng.uuid();
        await createSession(sql, sessionId, userId, null);
        const a = await routeFinalize(sql, userId, sessionId);
        const b = await routeFinalize(sql, userId, sessionId);
        assertEquals([a.status, b.status], [200, 200]);
      }
      const after = await counts();
      await writeJson("pg_ledgers_untouched", {
        seed: STRESS_SEED ^ 0x9605,
        finalizations: N * 2,
        before,
        after,
        replay: replayCommand(FILE, "PG5", STRESS_SEED),
      });
      assertEquals(after, before, "ledger/permit/shot counts unchanged by finalization");
    } finally {
      await sql.end();
    }
  },
});
