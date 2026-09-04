#!/usr/bin/env node
// Deterministic two-session repro for the P3 observation found by
// profiles_onboarding_concurrency.mjs (invariants updated_at_ge_created_at /
// updated_at_monotonic_across_commits):
//
//   public.set_updated_at() and public.handle_user_email_updated() stamp
//   now(), which is the TRANSACTION START time. A transaction that begins
//   first, then waits on another writer's row lock (or on the signup that
//   creates the row) and commits LAST leaves profiles.updated_at older than
//   the previous writer's stamp — and, for the signup race, older than
//   created_at.
//
// Usage (same throwaway DB as the stress harness):
//   node supabase/tests/stress/repro_stale_updated_at.mjs
// Exit 0 when the anomaly is demonstrated (prints the stamps), 1 otherwise.

import { createRequire } from "node:module";

const require = createRequire(new URL("../../../packages/database/package.json", import.meta.url));
const pg = require("pg");
pg.types.setTypeParser(1184, (v) => v);

const PG_URL = process.env.STRESS_PG_URL ?? "postgres://postgres:x@127.0.0.1:5499/postgres";
const pool = new pg.Pool({ connectionString: PG_URL, max: 3 });

const uid = "00000000-0000-4000-8000-00000000c0de";

async function main() {
  await pool.query("delete from auth.users where id = $1", [uid]);
  await pool.query(
    `insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
     values ($1, 'stale@example.com', '{}'::jsonb, '{"provider":"apple"}'::jsonb)`,
    [uid],
  );

  const a = await pool.connect();
  const b = await pool.connect();
  try {
    // A starts first: its now() is frozen here.
    await a.query("begin isolation level read committed");
    const aStart = (await a.query("select now()::text as t")).rows[0].t;

    // B starts later, writes and commits: row stamped with B's (newer) now().
    await b.query("begin isolation level read committed");
    await b.query("set local role authenticated");
    await b.query(
      "select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)",
      [uid, JSON.stringify({ sub: uid, role: "authenticated" })],
    );
    const bStamp = (
      await b.query(
        "update public.profiles set skill_level = 'beginner' where id = $1 returning updated_at::text as t",
        [uid],
      )
    ).rows[0].t;
    await b.query("commit");

    // A now writes the same row (READ COMMITTED sees B's committed version)
    // and commits last — but set_updated_at() stamps A's older start time.
    await a.query("set local role authenticated");
    await a.query(
      "select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)",
      [uid, JSON.stringify({ sub: uid, role: "authenticated" })],
    );
    const aStamp = (
      await a.query(
        "update public.profiles set skill_level = 'advanced' where id = $1 returning updated_at::text as t",
        [uid],
      )
    ).rows[0].t;
    await a.query("commit");

    const final = (
      await pool.query(
        "select skill_level, updated_at::text as u, created_at::text as c from public.profiles where id = $1",
        [uid],
      )
    ).rows[0];
    const out = { a_txn_start: aStart, b_stamp: bStamp, a_stamp: aStamp, final };
    console.log(JSON.stringify(out, null, 2));

    const older = (
      await pool.query("select $1::timestamptz < $2::timestamptz as older", [final.u, bStamp])
    ).rows[0].older;
    const reproduced = final.skill_level === "advanced" && older === true;
    console.log(
      reproduced
        ? "REPRODUCED: last writer (A) left updated_at older than the previous writer's stamp"
        : "NOT reproduced",
    );
    process.exitCode = reproduced ? 0 : 1;
  } finally {
    await a.query("rollback").catch(() => {});
    await b.query("rollback").catch(() => {});
    a.release();
    b.release();
    await pool.query("delete from auth.users where id = $1", [uid]).catch(() => {});
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 2;
});
