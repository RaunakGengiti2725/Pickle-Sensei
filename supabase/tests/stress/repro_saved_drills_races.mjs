#!/usr/bin/env node
// Deterministic, timing-free repros for the two concurrency behaviours the
// seeded campaign (saved_drills_concurrency.mjs) surfaces on
// public.user_saved_drills. Each repro drives the sessions step by step, so it
// reproduces on every run rather than "sometimes".
//
//   PICKLE_STRESS_PG_URL=postgres://postgres:x@127.0.0.1:5499/postgres \
//     node supabase/tests/stress/repro_saved_drills_races.mjs
//
// R1  saveDrill read-back gap — supabase/functions/api/index.ts saveDrill
//     issues the upsert and the read-back as two separate PostgREST calls. A
//     concurrent unsave (the same user's other device, or a double-tap) that
//     commits between them makes the read-back return no row, which the route
//     maps to serviceUnavailable("Drill save") → HTTP 503 even though the save
//     itself succeeded and the DB is perfectly consistent.
//
// R2  batched multi-slug save deadlock — no route batches saves today (each
//     PUT is its own implicit transaction, R2 does NOT reproduce there), but
//     two sessions that save the same slugs in opposite order INSIDE one
//     transaction deadlock (40P01). Recorded so a future "save all" route does
//     not ship the hazard.
//
// Exit 0 = both repros produced their documented outcome.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const require = createRequire(import.meta.url);
const pg = require(
  require.resolve("pg", {
    paths: [
      path.join(repoRoot, "packages/database/node_modules"),
      path.join(repoRoot, "services/api/node_modules"),
      path.join(repoRoot, "node_modules"),
    ],
  }),
);

const PG_URL = process.env.PICKLE_STRESS_PG_URL ?? "";
if (!PG_URL) {
  console.error("PICKLE_STRESS_PG_URL is required.");
  process.exit(2);
}

const USER = "00000000-0000-4000-8000-00000000a001";
const pool = new pg.Pool({ connectionString: PG_URL, max: 8 });

async function owner(sql, params = []) {
  const c = await pool.connect();
  try {
    return await c.query(sql, params);
  } finally {
    c.release();
  }
}

/** A long-lived `authenticated` session, driven statement by statement. */
async function session(uid) {
  const c = await pool.connect();
  await c.query("set role authenticated");
  await c.query("select set_config('request.jwt.claim.sub', $1, false)", [uid]);
  return {
    q: (sql, params = []) => c.query(sql, params),
    close: async () => {
      try {
        await c.query("rollback");
      } catch {
        /* not in a transaction */
      }
      await c.query("reset role");
      c.release();
    },
  };
}

const UPSERT =
  "insert into public.user_saved_drills (user_id, slug) values ($1, $2) on conflict (user_id, slug) do nothing";
const READBACK =
  "select slug, saved_at from public.user_saved_drills where user_id = $1 and slug = $2";
const DELETE = "delete from public.user_saved_drills where user_id = $1 and slug = $2";

async function ensureUser() {
  await owner(
    "insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values ($1, $2, '{}'::jsonb, '{\"provider\":\"google\"}'::jsonb) on conflict (id) do nothing",
    [USER, "repro@example.test"],
  );
}

async function r1ReadbackGap() {
  const slug = `repro-r1-${crypto.randomUUID().slice(0, 8)}`;
  const saveSession = await session(USER);
  const unsaveSession = await session(USER);
  try {
    // step 1 — PUT /v1/me/saved-drills/:slug, call 1 of 2 (the upsert commits).
    const up = await saveSession.q(UPSERT, [USER, slug]);
    // step 2 — the other device's DELETE lands in the gap.
    const del = await unsaveSession.q(DELETE, [USER, slug]);
    // step 3 — call 2 of 2: the read-back the route requires.
    const back = await saveSession.q(READBACK, [USER, slug]);
    const outcome = {
      repro: "R1 saveDrill read-back gap",
      upsertRowCount: up.rowCount,
      concurrentDeleteRowCount: del.rowCount,
      readbackRowCount: back.rowCount,
      routeResult:
        back.rowCount === 0
          ? "serviceUnavailable('Drill save') → HTTP 503 (index.ts saveDrill: `if (row.error || !row.data)`)"
          : "200 saved",
      rowsLeft: (
        await owner(
          "select count(*)::int n from public.user_saved_drills where user_id=$1 and slug=$2",
          [USER, slug],
        )
      ).rows[0].n,
    };
    console.log(JSON.stringify(outcome, null, 2));
    return back.rowCount === 0;
  } finally {
    await saveSession.close();
    await unsaveSession.close();
  }
}

async function r2BatchedDeadlock() {
  const a = `repro-r2a-${crypto.randomUUID().slice(0, 8)}`;
  const b = `repro-r2b-${crypto.randomUUID().slice(0, 8)}`;
  const s1 = await session(USER);
  const s2 = await session(USER);
  try {
    await s1.q("begin");
    await s2.q("begin");
    await s1.q(UPSERT, [USER, a]); // s1 holds a
    await s2.q(UPSERT, [USER, b]); // s2 holds b
    const p1 = s1.q(UPSERT, [USER, b]).then(
      () => ({ ok: true }),
      (e) => ({ ok: false, code: e.code, message: e.message }),
    );
    const p2 = s2.q(UPSERT, [USER, a]).then(
      () => ({ ok: true }),
      (e) => ({ ok: false, code: e.code, message: e.message }),
    );
    const [r1, r2] = await Promise.all([p1, p2]);
    const deadlocked = [r1, r2].some((r) => !r.ok && r.code === "40P01");
    console.log(
      JSON.stringify(
        {
          repro: "R2 batched multi-slug save deadlock (no production route batches today)",
          session1: r1,
          session2: r2,
          deadlockDetected: deadlocked,
        },
        null,
        2,
      ),
    );
    return deadlocked;
  } finally {
    await s1.close();
    await s2.close();
  }
}

async function main() {
  await ensureUser();
  const r1 = await r1ReadbackGap();
  const r2 = await r2BatchedDeadlock();
  await pool.end();
  console.log(`\nR1 reproduced: ${r1}\nR2 reproduced: ${r2}`);
  process.exit(r1 && r2 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => {});
  process.exit(1);
});
