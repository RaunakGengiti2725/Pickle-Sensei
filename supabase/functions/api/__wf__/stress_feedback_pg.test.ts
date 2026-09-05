// Stress lens `failure-load`, part 4 — the REAL table behind
// POST /v1/analyses/:id/feedback on a disposable postgres:16 with
// shim_auth.sql + every migration applied (./xc_pg_up.sh).
//
// The route's write is a PostgREST INSERT into public.analysis_feedback as
// the caller (role authenticated, JWT sub = user). The in-process campaigns
// model that table; this file proves the properties the model assumes:
//
//   PGF1  duplicate delivery — N concurrent inserts of the same
//         (analysis_id, user_id) from N open transactions → exactly ONE row,
//         every other lane fails with SQLSTATE 23505 (the route's 409).  P0.
//   PGF2  append-only — the owner cannot update or delete a feedback row.
//   PGF3  isolation — another user cannot insert a row AS the owner (RLS WITH
//         CHECK) nor read the owner's rows.
//   PGF4  bounds — rating/category over 50 chars are refused (23514, the
//         route's I04 case).
//   PGF5  RECORDED, not asserted: the table has no FK from analysis_id to
//         shots and no rating vocabulary — ownership of the analysis and the
//         accurate|not_quite vocabulary are enforced by the edge route only.
//
//   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
//     STRESS_OUT_DIR=/tmp/stress/ deno test -A --no-check --config deno.json stress_feedback_pg.test.ts
//
// Without XC_PG_URL every test is `ignore`d — an ignored run is NOT a pass.

import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import {
  envInt,
  Prng,
  STRESS_ITER,
  STRESS_SEED,
  writeJson,
} from "./stress_feedback_harness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ??
  Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const LANES = envInt("STRESS_PG_LANES", 16);
const ROUNDS = Math.max(2, STRESS_ITER * 2);

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

interface LaneRow {
  round: number;
  lane: number;
  result: string;
  sqlstate?: string;
  serverStartMs: number;
  serverEndMs: number;
  clientMs: number;
}

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

async function createUser(sql: Sql, userId: string) {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${userId}', '${userId}@example.com', '{"provider":"google"}')`,
  );
}

async function serverNowMs(tx: Tx): Promise<number> {
  const r = await tx.unsafe(
    `select (extract(epoch from clock_timestamp()) * 1000)::float8 as t`,
  );
  return Number(r[0].t);
}

function sqlstateOf(err: unknown): string {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code: unknown }).code)
    : "?";
}

/** The route's INSERT, as the caller. */
async function insertFeedback(
  tx: Tx,
  userId: string,
  analysisId: string,
  rating: string,
  category: string | null,
): Promise<{ result: string; sqlstate?: string }> {
  try {
    await tx.unsafe(
      `insert into public.analysis_feedback (user_id, analysis_id, rating, category) values ($1, $2, $3, $4)`,
      [userId, analysisId, rating, category],
    );
    return { result: "inserted" };
  } catch (err) {
    return { result: "refused", sqlstate: sqlstateOf(err) };
  }
}

async function countRows(sql: Sql, analysisId: string): Promise<number> {
  const r = await sql.unsafe(
    `select count(*)::int as n from public.analysis_feedback where analysis_id = '${analysisId}'`,
  );
  return Number(r[0].n);
}

Deno.test({
  name:
    "stress pg PGF1: concurrent duplicate feedback delivery → exactly one row, others 23505",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: LANES + 2 });
    const prng = new Prng((STRESS_SEED ^ 0x9f1) >>> 0);
    const rows: LaneRow[] = [];
    const failures: string[] = [];
    const perRound: Array<
      {
        round: number;
        userId: string;
        analysisId: string;
        inserted: number;
        dup23505: number;
        other: number;
        rowsAfter: number;
        overlapping: number;
      }
    > = [];
    try {
      for (let round = 0; round < ROUNDS; round++) {
        const userId = prng.uuid();
        const analysisId = prng.uuid();
        await createUser(sql, userId);
        const rating = prng.next() < 0.5 ? "accurate" : "not_quite";
        const category = rating === "not_quite" ? "other" : null;

        let open!: () => void;
        const gate = new Promise<void>((resolve) => (open = resolve));
        let ready = 0;
        const laneRows: LaneRow[] = [];
        const all = Promise.all(
          Array.from({ length: LANES }, (_, lane) =>
            sql.begin(async (tx) => {
              await asUser(tx as unknown as Tx, userId);
              ready += 1;
              await gate;
              const t0 = performance.now();
              const s0 = await serverNowMs(tx as unknown as Tx);
              const out = await insertFeedback(
                tx as unknown as Tx,
                userId,
                analysisId,
                rating,
                category,
              );
              const clientMs = performance.now() - t0;
              // A refused statement aborts the transaction, so the end clock
              // is only readable server-side on the winning lane.
              const s1 = out.result === "inserted"
                ? await serverNowMs(tx as unknown as Tx)
                : s0 + clientMs;
              laneRows.push({
                round,
                lane,
                ...out,
                serverStartMs: s0,
                serverEndMs: s1,
                clientMs: Math.round(clientMs * 100) / 100,
              });
              if (out.result !== "inserted") {
                // a failed statement aborts the tx; postgres-js rethrows on commit
                throw new Error(`lane ${lane} refused (${out.sqlstate})`);
              }
            }).catch(() => undefined)),
        );
        while (ready < LANES) await new Promise((r) => setTimeout(r, 1));
        open();
        await all;
        laneRows.sort((a, b) => a.lane - b.lane);
        rows.push(...laneRows);
        const inserted = laneRows.filter((r) => r.result === "inserted").length;
        const dup = laneRows.filter((r) => r.sqlstate === "23505").length;
        const other = laneRows.length - inserted - dup;
        const rowsAfter = await countRows(sql, analysisId);
        const overlapping = laneRows.filter((a) =>
          laneRows.some((b) =>
            b !== a && a.serverStartMs < b.serverEndMs &&
            b.serverStartMs < a.serverEndMs
          )
        ).length;
        perRound.push({
          round,
          userId,
          analysisId,
          inserted,
          dup23505: dup,
          other,
          rowsAfter,
          overlapping,
        });
        if (rowsAfter !== 1) {
          failures.push(
            `round ${round}: ${rowsAfter} rows for one (analysis, user) — DUPLICATE DELIVERY`,
          );
        }
        if (inserted !== 1) {
          failures.push(`round ${round}: ${inserted} lanes reported inserted`);
        }
        if (other !== 0) {
          failures.push(
            `round ${round}: ${other} lanes failed with a SQLSTATE other than 23505: ${
              laneRows.filter((r) =>
                r.result !== "inserted" && r.sqlstate !== "23505"
              ).map((r) =>
                r.sqlstate
              ).join(",")
            }`,
          );
        }
        if (laneRows.length !== LANES) {
          failures.push(`round ${round}: ${laneRows.length} lanes reported`);
        }
      }
    } finally {
      await sql.end();
    }
    const path = await writeJson("pg_duplicate_delivery.json", {
      seed: STRESS_SEED,
      lanes: LANES,
      rounds: ROUNDS,
      perRound,
      failures,
      rows,
      replay:
        `XC_PG_URL=<from ./xc_pg_up.sh> STRESS_SEED=${STRESS_SEED} STRESS_ITER=${STRESS_ITER} STRESS_PG_LANES=${LANES} deno test -A --no-check --config deno.json stress_feedback_pg.test.ts --filter PGF1`,
    });
    console.log(
      `[stress-pg] PGF1 ${ROUNDS} rounds × ${LANES} lanes: ${
        JSON.stringify(perRound.map((r) =>
          `${r.inserted}/${r.dup23505}/${r.rowsAfter} (overlap ${r.overlapping})`
        ))
      } → ${path}`,
    );
    assertEquals(failures, []);
  },
});

Deno.test({
  name:
    "stress pg PGF2–PGF5: append-only, cross-user isolation, bounds, and the table-layer gaps the route covers",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    const prng = new Prng((STRESS_SEED ^ 0x9f2) >>> 0);
    const owner = prng.uuid();
    const intruder = prng.uuid();
    const analysisId = prng.uuid();
    const observations: Record<string, unknown> = {};
    const failures: string[] = [];
    try {
      await createUser(sql, owner);
      await createUser(sql, intruder);

      // Owner writes the row (the route's success path).
      await sql.begin(async (tx) => {
        await asUser(tx as unknown as Tx, owner);
        const out = await insertFeedback(
          tx as unknown as Tx,
          owner,
          analysisId,
          "accurate",
          null,
        );
        if (out.result !== "inserted") {
          failures.push(`owner insert refused: ${out.sqlstate}`);
        }
      });
      assertEquals(await countRows(sql, analysisId), 1);

      // PGF2 append-only.
      const attempt = async (
        userId: string,
        statement: string,
        params: unknown[] = [],
      ) => {
        try {
          await sql.begin(async (tx) => {
            await asUser(tx as unknown as Tx, userId);
            await tx.unsafe(statement, params as never[]);
          });
          return "allowed";
        } catch (err) {
          return `refused:${sqlstateOf(err)}`;
        }
      };
      const upd = await attempt(
        owner,
        `update public.analysis_feedback set rating = 'not_quite' where analysis_id = $1`,
        [analysisId],
      );
      const del = await attempt(
        owner,
        `delete from public.analysis_feedback where analysis_id = $1`,
        [analysisId],
      );
      observations.ownerUpdate = upd;
      observations.ownerDelete = del;
      if (!upd.startsWith("refused")) {
        failures.push(`PGF2 owner UPDATE was ${upd}`);
      }
      if (!del.startsWith("refused")) {
        failures.push(`PGF2 owner DELETE was ${del}`);
      }
      assertEquals(
        await countRows(sql, analysisId),
        1,
        "row survives update/delete attempts",
      );

      // PGF3 isolation.
      const forge = await attempt(
        intruder,
        `insert into public.analysis_feedback (user_id, analysis_id, rating) values ($1, $2, 'accurate')`,
        [owner, prng.uuid()],
      );
      observations.intruderInsertAsOwner = forge;
      if (!forge.startsWith("refused:42501")) {
        failures.push(`PGF3 intruder insert AS owner was ${forge}`);
      }
      let visible = -1;
      await sql.begin(async (tx) => {
        await asUser(tx as unknown as Tx, intruder);
        const r = await tx.unsafe(
          `select count(*)::int as n from public.analysis_feedback where analysis_id = $1`,
          [analysisId],
        );
        visible = Number(r[0].n);
      });
      observations.intruderSeesOwnerRows = visible;
      if (visible !== 0) {
        failures.push(`PGF3 intruder sees ${visible} owner rows`);
      }
      // Same analysis id, different user: the uniqueness is per (analysis, user).
      const otherUserSameAnalysis = await attempt(
        intruder,
        `insert into public.analysis_feedback (user_id, analysis_id, rating) values ($1, $2, 'accurate')`,
        [intruder, analysisId],
      );
      observations.otherUserSameAnalysis = otherUserSameAnalysis;

      // PGF4 bounds (route case I04: PostgREST 400/23514 → 503).
      const longRating = await attempt(
        owner,
        `insert into public.analysis_feedback (user_id, analysis_id, rating) values ($1, $2, $3)`,
        [owner, prng.uuid(), "x".repeat(51)],
      );
      const longCategory = await attempt(
        owner,
        `insert into public.analysis_feedback (user_id, analysis_id, rating, category) values ($1, $2, 'not_quite', $3)`,
        [owner, prng.uuid(), "y".repeat(51)],
      );
      observations.ratingOver50 = longRating;
      observations.categoryOver50 = longCategory;
      if (longRating !== "refused:23514") {
        failures.push(`PGF4 51-char rating was ${longRating}`);
      }
      if (longCategory !== "refused:23514") {
        failures.push(`PGF4 51-char category was ${longCategory}`);
      }

      // PGF5 recorded: what the TABLE accepts that the ROUTE refuses.
      observations.tableAcceptsUnknownRating = await attempt(
        owner,
        `insert into public.analysis_feedback (user_id, analysis_id, rating) values ($1, $2, 'garbage')`,
        [owner, prng.uuid()],
      );
      observations.tableAcceptsNotQuiteWithoutCategory = await attempt(
        owner,
        `insert into public.analysis_feedback (user_id, analysis_id, rating) values ($1, $2, 'not_quite')`,
        [owner, prng.uuid()],
      );
      observations.tableAcceptsAnalysisIdWithNoShotRow = await attempt(
        owner,
        `insert into public.analysis_feedback (user_id, analysis_id, rating) values ($1, $2, 'accurate')`,
        [owner, prng.uuid()],
      );
      const fk = await sql.unsafe(
        `select count(*)::int as n from pg_constraint where conrelid = 'public.analysis_feedback'::regclass and contype = 'f' and conkey = array[(select attnum from pg_attribute where attrelid = 'public.analysis_feedback'::regclass and attname = 'analysis_id')]`,
      );
      observations.analysisIdForeignKeys = Number(fk[0].n);
    } finally {
      await sql.end();
    }
    const path = await writeJson("pg_table_contract.json", {
      seed: STRESS_SEED,
      owner,
      intruder,
      analysisId,
      observations,
      failures,
      replay:
        `XC_PG_URL=<from ./xc_pg_up.sh> STRESS_SEED=${STRESS_SEED} deno test -A --no-check --config deno.json stress_feedback_pg.test.ts --filter PGF2`,
    });
    console.log(`[stress-pg] PGF2–5 ${JSON.stringify(observations)} → ${path}`);
    assert(Object.keys(observations).length >= 10);
    assertEquals(failures, []);
  },
});
