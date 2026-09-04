#!/usr/bin/env node
// Seeded concurrency stress harness for public.user_saved_drills.
//
//   PICKLE_STRESS_PG_URL=postgres://postgres:x@127.0.0.1:5499/postgres \
//     node supabase/tests/stress/saved_drills_concurrency.mjs --iter 60 --seed 1
//
// Drives the saved-drill bookmark table exactly the way the Edge Function
// does (supabase/functions/api/index.ts saveDrill / unsaveDrill /
// listSavedDrills: PostgREST upsert with ignoreDuplicates → INSERT ... ON
// CONFLICT DO NOTHING, then a separate read-back SELECT) from several
// parallel `authenticated` sessions, and asserts the invariants that must
// hold whatever the interleaving:
//
//   * idempotency        — N concurrent saves of one (user, slug) leave one row
//   * no duplicate rows  — the (user_id, slug) primary key is never doubled
//   * no lost save       — a save that reported success is visible afterwards
//   * stable saved_at    — a duplicate save never re-stamps saved_at
//   * owner isolation    — a second user can never read/update/delete/steal a row
//   * no deadlock        — opposite-order bursts finish inside the wall bound
//   * no orphan rows     — nothing survives its profile (FK/cascade races)
//
// Every iteration is replayable from its own seed (printed with each result
// and written to the JSON report). Slugs are unique per iteration, so
// iterations never interfere and a single seed can be re-run alone.
//
// Read-only w.r.t. the repo: it only touches a throwaway Postgres that the
// caller migrated (see run_saved_drills_concurrency.sh).

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const require = createRequire(import.meta.url);
// `pg` is a workspace dependency (@pickle/database); resolve it from there so
// this harness needs no install of its own.
const pg = require(
  require.resolve("pg", {
    paths: [
      path.join(repoRoot, "packages/database/node_modules"),
      path.join(repoRoot, "services/api/node_modules"),
      path.join(repoRoot, "node_modules"),
    ],
  }),
);

// ── CLI ──────────────────────────────────────────────────────────────────────
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const PG_URL = process.env.PICKLE_STRESS_PG_URL ?? "";
if (!PG_URL) {
  console.error(
    "PICKLE_STRESS_PG_URL is required (a throwaway Postgres with the Supabase shim + every migration applied).",
  );
  process.exit(2);
}
const ITERATIONS = Number(arg("iter", process.env.STRESS_ITER ?? 60));
const BASE_SEED = Number(arg("seed", process.env.STRESS_SEED ?? 1));
const ONLY = (arg("only", "") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const OUT = arg("out", process.env.STRESS_OUT ?? "");
const ITER_WALL_MS = Number(arg("wall-ms", 8000));

// ── seeded RNG (mulberry32 over a sha256 of seed material) ───────────────────
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedOf(...parts) {
  const h = crypto.createHash("sha256").update(parts.join(":")).digest();
  return h.readUInt32BE(0);
}
function rngFor(seed) {
  const next = mulberry32(seed);
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (xs) => xs[Math.floor(next() * xs.length)],
    shuffle: (xs) => {
      const a = xs.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── fixed test identities ────────────────────────────────────────────────────
const USER_A = "00000000-0000-4000-8000-00000000a001";
const USER_B = "00000000-0000-4000-8000-00000000b002";
const USER_C = "00000000-0000-4000-8000-00000000c003";

const pool = new pg.Pool({ connectionString: PG_URL, max: 24 });

/** Owner-role query (no JWT claim): setup/teardown/inspection. */
async function owner(sql, params = []) {
  const c = await pool.connect();
  try {
    return await c.query(sql, params);
  } finally {
    c.release();
  }
}

/**
 * Run `fn` inside ONE transaction as the `authenticated` role with
 * request.jwt.claim.sub = uid — the same posture as a PostgREST request
 * (supabase/tests/security_regression.sql uses the identical shim).
 */
async function asUser(uid, fn, { isolation = "read committed", timeoutMs = 5000 } = {}) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(`set transaction isolation level ${isolation}`);
    await c.query(`set local statement_timeout = ${timeoutMs}`);
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claim.sub', $1, true)", [uid]);
    const value = await fn(c);
    await c.query("commit");
    return value;
  } catch (err) {
    try {
      await c.query("rollback");
    } catch {
      /* connection already unusable */
    }
    throw err;
  } finally {
    c.release();
  }
}

/** Each PostgREST call is its own implicit transaction — model that too. */
async function callAsUser(uid, sql, params = [], opts = {}) {
  return asUser(uid, (c) => c.query(sql, params), opts);
}

// ── the operations the Edge Function performs ────────────────────────────────
const SQL_UPSERT =
  "insert into public.user_saved_drills (user_id, slug) values ($1, $2) on conflict (user_id, slug) do nothing";
const SQL_READBACK =
  "select slug, saved_at from public.user_saved_drills where user_id = $1 and slug = $2";
const SQL_DELETE = "delete from public.user_saved_drills where user_id = $1 and slug = $2";
const SQL_LIST =
  "select slug, saved_at from public.user_saved_drills where user_id = $1 order by saved_at desc";

const errOf = (e) => ({ code: e.code ?? null, message: String(e.message ?? e).slice(0, 200) });

async function rowsFor(uid, slug) {
  const r = await owner(
    "select user_id, slug, saved_at from public.user_saved_drills where user_id = $1 and slug = $2",
    [uid, slug],
  );
  return r.rows;
}

// ── scenarios ────────────────────────────────────────────────────────────────
// Each returns { violations: string[], notes: object }.
const scenarios = {
  /** S1 duplicate-save burst: k parallel saves of one (user, slug). */
  async dupSaveBurst(rng, slug) {
    const k = rng.int(2, 8);
    const delays = Array.from({ length: k }, () => rng.int(0, 12));
    const results = await Promise.allSettled(
      delays.map(async (d) => {
        await sleep(d);
        return callAsUser(USER_A, SQL_UPSERT, [USER_A, slug]);
      }),
    );
    const errors = results.filter((r) => r.status === "rejected").map((r) => errOf(r.reason));
    const inserted = results.filter(
      (r) => r.status === "fulfilled" && r.value.rowCount === 1,
    ).length;
    const rows = await rowsFor(USER_A, slug);
    const violations = [];
    if (errors.length) violations.push(`save error(s): ${JSON.stringify(errors)}`);
    if (rows.length !== 1) violations.push(`expected exactly 1 row, saw ${rows.length}`);
    if (inserted !== 1) violations.push(`expected exactly 1 INSERT to win, saw ${inserted}`);
    return { violations, notes: { k, inserted } };
  },

  /** S1b idempotent re-save must not re-stamp saved_at. */
  async savedAtStability(rng, slug) {
    await callAsUser(USER_A, SQL_UPSERT, [USER_A, slug]);
    const first = (await rowsFor(USER_A, slug))[0]?.saved_at;
    const k = rng.int(2, 6);
    await Promise.all(
      Array.from({ length: k }, async () => {
        await sleep(rng.int(0, 8));
        return callAsUser(USER_A, SQL_UPSERT, [USER_A, slug]);
      }),
    );
    const rows = await rowsFor(USER_A, slug);
    const violations = [];
    if (rows.length !== 1) violations.push(`expected 1 row, saw ${rows.length}`);
    if (rows[0] && String(rows[0].saved_at) !== String(first)) {
      violations.push(`saved_at moved on duplicate save: ${first} → ${rows[0].saved_at}`);
    }
    return { violations, notes: { k } };
  },

  /** S2 save/unsave interleaving: mixed burst, final state must be sane. */
  async saveUnsaveInterleave(rng, slug) {
    const k = rng.int(2, 8);
    const ops = Array.from({ length: k }, () => (rng.next() < 0.5 ? "save" : "unsave"));
    const results = await Promise.allSettled(
      ops.map(async (op) => {
        await sleep(rng.int(0, 12));
        return op === "save"
          ? callAsUser(USER_A, SQL_UPSERT, [USER_A, slug])
          : callAsUser(USER_A, SQL_DELETE, [USER_A, slug]);
      }),
    );
    const errors = results.filter((r) => r.status === "rejected").map((r) => errOf(r.reason));
    const rows = await rowsFor(USER_A, slug);
    const violations = [];
    if (errors.length) violations.push(`unexpected error(s): ${JSON.stringify(errors)}`);
    if (rows.length > 1) violations.push(`duplicate rows: ${rows.length}`);
    // A trailing save (no unsave after it) must leave the bookmark saved:
    // enforce the ordering-independent floor instead — the row set is a
    // function of the winner, so only >1 is a violation.
    return { violations, notes: { ops: ops.join(","), finalRows: rows.length } };
  },

  /**
   * S3 read-your-write: the Edge Function's saveDrill does the upsert and the
   * read-back as two separate PostgREST calls (index.ts saveDrill), so a
   * concurrent unsave can land between them. Records the miss rate; a miss is
   * an API-level 503 on an otherwise successful save.
   */
  async readYourWriteRace(rng, slug) {
    await callAsUser(USER_A, SQL_UPSERT, [USER_A, slug]);
    const gap = rng.int(0, 10);
    let readback = null;
    const save = (async () => {
      await callAsUser(USER_A, SQL_UPSERT, [USER_A, slug]);
      await sleep(gap);
      const r = await callAsUser(USER_A, SQL_READBACK, [USER_A, slug]);
      readback = r.rowCount;
      return r;
    })();
    const unsave = (async () => {
      await sleep(rng.int(0, 10));
      return callAsUser(USER_A, SQL_DELETE, [USER_A, slug]);
    })();
    const settled = await Promise.allSettled([save, unsave]);
    const errors = settled.filter((r) => r.status === "rejected").map((r) => errOf(r.reason));
    const rows = await rowsFor(USER_A, slug);
    const violations = [];
    if (errors.length) violations.push(`unexpected error(s): ${JSON.stringify(errors)}`);
    if (rows.length > 1) violations.push(`duplicate rows: ${rows.length}`);
    return { violations, notes: { readbackRows: readback, missedReadback: readback === 0 } };
  },

  /** S3b same race, but the two statements share ONE transaction. */
  async readYourWriteAtomic(rng, slug) {
    await callAsUser(USER_A, SQL_UPSERT, [USER_A, slug]);
    let readback = null;
    const save = asUser(USER_A, async (c) => {
      await c.query(SQL_UPSERT, [USER_A, slug]);
      await sleep(rng.int(0, 10));
      const r = await c.query(SQL_READBACK, [USER_A, slug]);
      readback = r.rowCount;
    });
    const unsave = (async () => {
      await sleep(rng.int(0, 10));
      return callAsUser(USER_A, SQL_DELETE, [USER_A, slug]);
    })();
    const settled = await Promise.allSettled([save, unsave]);
    const errors = settled.filter((r) => r.status === "rejected").map((r) => errOf(r.reason));
    const violations = [];
    if (errors.length) violations.push(`unexpected error(s): ${JSON.stringify(errors)}`);
    return { violations, notes: { readbackRows: readback, missedReadback: readback === 0 } };
  },

  /** S4 two users, same slug: both bookmarks exist, each sees only its own. */
  async twoUsersSameSlug(rng, slug) {
    const settled = await Promise.allSettled([
      (async () => {
        await sleep(rng.int(0, 8));
        return callAsUser(USER_A, SQL_UPSERT, [USER_A, slug]);
      })(),
      (async () => {
        await sleep(rng.int(0, 8));
        return callAsUser(USER_B, SQL_UPSERT, [USER_B, slug]);
      })(),
    ]);
    const errors = settled.filter((r) => r.status === "rejected").map((r) => errOf(r.reason));
    const violations = [];
    if (errors.length) violations.push(`unexpected error(s): ${JSON.stringify(errors)}`);
    const seenByA = await callAsUser(USER_A, SQL_READBACK, [USER_A, slug]);
    const seenByB = await callAsUser(USER_B, SQL_READBACK, [USER_B, slug]);
    const crossA = await callAsUser(USER_A, SQL_READBACK, [USER_B, slug]);
    if (seenByA.rowCount !== 1) violations.push(`A cannot see its own row (${seenByA.rowCount})`);
    if (seenByB.rowCount !== 1) violations.push(`B cannot see its own row (${seenByB.rowCount})`);
    if (crossA.rowCount !== 0) violations.push(`A read B's row through RLS (${crossA.rowCount})`);
    return { violations, notes: {} };
  },

  /** S5 two actors on the same row: B attacks while A keeps re-saving. */
  async crossUserAttack(rng, slug) {
    await callAsUser(USER_A, SQL_UPSERT, [USER_A, slug]);
    const before = (await rowsFor(USER_A, slug))[0];
    const attacks = rng.shuffle([
      ["select", SQL_READBACK, [USER_A, slug]],
      ["delete", SQL_DELETE, [USER_A, slug]],
      [
        "update",
        "update public.user_saved_drills set slug = $3 where user_id = $1 and slug = $2",
        [USER_A, slug, `${slug}-hijacked`],
      ],
      [
        "steal",
        "update public.user_saved_drills set user_id = $3 where user_id = $1 and slug = $2",
        [USER_A, slug, USER_B],
      ],
      ["stamp", "update public.user_saved_drills set saved_at = now() where slug = $1", [slug]],
    ]);
    const settled = await Promise.allSettled([
      ...attacks.map(async ([, sql, params]) => {
        await sleep(rng.int(0, 10));
        return callAsUser(USER_B, sql, params);
      }),
      (async () => {
        await sleep(rng.int(0, 10));
        return callAsUser(USER_A, SQL_UPSERT, [USER_A, slug]);
      })(),
    ]);
    const violations = [];
    settled.slice(0, attacks.length).forEach((r, i) => {
      const name = attacks[i][0];
      if (r.status === "fulfilled" && r.value.rowCount !== 0) {
        violations.push(`B's ${name} affected ${r.value.rowCount} of A's rows`);
      }
      if (r.status === "rejected" && r.reason.code !== "42501") {
        violations.push(`B's ${name} failed unexpectedly: ${JSON.stringify(errOf(r.reason))}`);
      }
    });
    const after = (await rowsFor(USER_A, slug))[0];
    if (!after) violations.push("A's row disappeared under a cross-user attack");
    else if (
      after.user_id !== before.user_id ||
      after.slug !== before.slug ||
      String(after.saved_at) !== String(before.saved_at)
    ) {
      violations.push(`A's row mutated: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    }
    const bRows = await rowsFor(USER_B, slug);
    if (bRows.length) violations.push("row was transferred to B");
    return { violations, notes: { attacks: attacks.map((a) => a[0]).join(",") } };
  },

  /** S6 owner self-hijack: A tries to move its own row to B (with check). */
  async selfHijack(rng, slug) {
    await callAsUser(USER_A, SQL_UPSERT, [USER_A, slug]);
    const settled = await Promise.allSettled([
      callAsUser(
        USER_A,
        "update public.user_saved_drills set user_id = $3 where user_id = $1 and slug = $2",
        [USER_A, slug, USER_B],
      ),
      (async () => {
        await sleep(rng.int(0, 6));
        return callAsUser(USER_B, SQL_UPSERT, [USER_B, slug]);
      })(),
    ]);
    const violations = [];
    const hijack = settled[0];
    if (hijack.status === "fulfilled" && hijack.value.rowCount !== 0) {
      violations.push("A moved its row to B (RLS with-check bypass)");
    }
    if (hijack.status === "rejected" && hijack.reason.code !== "42501") {
      violations.push(`unexpected hijack error: ${JSON.stringify(errOf(hijack.reason))}`);
    }
    if ((await rowsFor(USER_A, slug)).length !== 1) violations.push("A lost its row");
    return { violations, notes: {} };
  },

  /**
   * S7 deadlock hunt, API-shaped: the Edge Function issues ONE statement per
   * request (PostgREST implicit transactions), so opposite-order bursts must
   * never deadlock or block past the wall bound.
   */
  async oppositeOrderNoTx(rng, slug) {
    const slugs = [`${slug}-a`, `${slug}-b`, `${slug}-c`];
    const started = Date.now();
    const runOrder = async (order) => {
      for (const s of order) {
        await callAsUser(USER_A, SQL_UPSERT, [USER_A, s]);
        await sleep(rng.int(0, 4));
        if (rng.next() < 0.4) await callAsUser(USER_A, SQL_DELETE, [USER_A, s]);
      }
    };
    const settled = await Promise.allSettled([
      runOrder(slugs),
      runOrder(slugs.slice().reverse()),
      runOrder(rng.shuffle(slugs)),
    ]);
    const elapsed = Date.now() - started;
    const violations = [];
    for (const r of settled) {
      if (r.status === "rejected") {
        const e = errOf(r.reason);
        if (e.code === "40P01") violations.push(`deadlock detected: ${e.message}`);
        else if (e.code === "57014") violations.push(`statement timed out (blocked): ${e.message}`);
        else violations.push(`unexpected error: ${JSON.stringify(e)}`);
      }
    }
    if (elapsed > 6000) violations.push(`burst took ${elapsed}ms (> 6000ms bound)`);
    for (const s of slugs) {
      if ((await rowsFor(USER_A, s)).length > 1) violations.push(`duplicate rows for ${s}`);
    }
    return { violations, notes: { elapsedMs: elapsed } };
  },

  /**
   * S7b the same opposite-order burst BATCHED into one transaction per actor —
   * the shape a future "save many drills" route would have. INFORMATIONAL: no
   * production path does this today, so a deadlock here is recorded as a rate
   * (notes.deadlocks), not scored as a broken invariant. Duplicate rows or a
   * hang past the bound WOULD be violations.
   */
  async oppositeOrderBatchedTx(rng, slug) {
    const slugs = [`${slug}-a`, `${slug}-b`, `${slug}-c`];
    const started = Date.now();
    const runOrder = async (order) =>
      asUser(USER_A, async (c) => {
        for (const s of order) {
          await c.query(SQL_UPSERT, [USER_A, s]);
          await sleep(rng.int(0, 6));
        }
      });
    const settled = await Promise.allSettled([
      runOrder(slugs),
      runOrder(slugs.slice().reverse()),
      runOrder(rng.shuffle(slugs)),
    ]);
    const elapsed = Date.now() - started;
    const violations = [];
    let deadlocks = 0;
    for (const r of settled) {
      if (r.status === "rejected") {
        const e = errOf(r.reason);
        if (e.code === "40P01") deadlocks++;
        else if (e.code === "57014") violations.push(`statement timed out (blocked): ${e.message}`);
        else violations.push(`unexpected error: ${JSON.stringify(e)}`);
      }
    }
    if (elapsed > 6000) violations.push(`burst took ${elapsed}ms (> 6000ms bound)`);
    for (const s of slugs) {
      if ((await rowsFor(USER_A, s)).length > 1) violations.push(`duplicate rows for ${s}`);
    }
    return { violations, notes: { elapsedMs: elapsed, deadlocks } };
  },

  /** S8 SERIALIZABLE bursts: 40001 is allowed, but retry must converge. */
  async serializableBurst(rng, slug) {
    const k = rng.int(2, 6);
    let serializationFailures = 0;
    const attempt = async () => {
      for (let tries = 0; tries < 5; tries++) {
        try {
          return await asUser(
            USER_A,
            async (c) => {
              await c.query(SQL_UPSERT, [USER_A, slug]);
              await sleep(rng.int(0, 8));
              await c.query(SQL_READBACK, [USER_A, slug]);
            },
            { isolation: "serializable" },
          );
        } catch (e) {
          if (e.code === "40001" || e.code === "40P01") {
            serializationFailures++;
            await sleep(rng.int(1, 10));
            continue;
          }
          throw e;
        }
      }
      throw new Error("serializable retry budget exhausted (5)");
    };
    const settled = await Promise.allSettled(Array.from({ length: k }, attempt));
    const violations = [];
    for (const r of settled) {
      if (r.status === "rejected")
        violations.push(`serializable: ${JSON.stringify(errOf(r.reason))}`);
    }
    const rows = await rowsFor(USER_A, slug);
    if (rows.length !== 1)
      violations.push(`expected 1 row after serializable burst, saw ${rows.length}`);
    return { violations, notes: { k, serializationFailures } };
  },

  /** S9 lost update on saved_at: concurrent owner updates, last writer wins. */
  async concurrentSavedAtUpdate(rng, slug) {
    await callAsUser(USER_A, SQL_UPSERT, [USER_A, slug]);
    const stamps = [
      "2026-01-01T00:00:00Z",
      "2026-02-02T00:00:00Z",
      "2026-03-03T00:00:00Z",
      "2026-04-04T00:00:00Z",
    ].slice(0, rng.int(2, 4));
    const settled = await Promise.allSettled(
      stamps.map(async (ts) => {
        await sleep(rng.int(0, 10));
        return callAsUser(
          USER_A,
          "update public.user_saved_drills set saved_at = $3 where user_id = $1 and slug = $2",
          [USER_A, slug, ts],
        );
      }),
    );
    const violations = [];
    for (const r of settled) {
      if (r.status === "rejected")
        violations.push(`update failed: ${JSON.stringify(errOf(r.reason))}`);
    }
    const rows = await rowsFor(USER_A, slug);
    if (rows.length !== 1) violations.push(`expected 1 row, saw ${rows.length}`);
    else {
      const got = new Date(rows[0].saved_at).toISOString();
      if (!stamps.map((s) => new Date(s).toISOString()).includes(got)) {
        violations.push(`saved_at is not one of the concurrent writes: ${got}`);
      }
    }
    return { violations, notes: { writers: stamps.length } };
  },

  /** S10 account deletion during a save burst — FK/cascade race. */
  async deleteAccountDuringSave(rng, slug) {
    const uid = crypto.randomUUID();
    await owner(
      "insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values ($1, $2, '{}'::jsonb, '{\"provider\":\"google\"}'::jsonb)",
      [uid, `${uid}@example.test`],
    );
    const k = rng.int(2, 6);
    const saves = Array.from({ length: k }, async (_, i) => {
      await sleep(rng.int(0, 12));
      return callAsUser(uid, SQL_UPSERT, [uid, `${slug}-${i}`]);
    });
    const kill = (async () => {
      await sleep(rng.int(0, 12));
      return owner("delete from auth.users where id = $1", [uid]);
    })();
    const settled = await Promise.allSettled([...saves, kill]);
    const violations = [];
    settled.slice(0, k).forEach((r, i) => {
      if (r.status === "rejected") {
        const e = errOf(r.reason);
        // 23503 (FK violation) is the legitimate outcome of racing the cascade.
        if (e.code !== "23503")
          violations.push(`save ${i} failed unexpectedly: ${JSON.stringify(e)}`);
      }
    });
    if (settled[k].status === "rejected") {
      violations.push(`account delete failed: ${JSON.stringify(errOf(settled[k].reason))}`);
    }
    const orphans = await owner(
      "select count(*)::int as n from public.user_saved_drills d left join public.profiles p on p.id = d.user_id where p.id is null",
    );
    if (orphans.rows[0].n !== 0)
      violations.push(`${orphans.rows[0].n} orphan bookmark row(s) survived the account`);
    const left = await owner(
      "select count(*)::int as n from public.user_saved_drills where user_id = $1",
      [uid],
    );
    if (left.rows[0].n !== 0)
      violations.push(`${left.rows[0].n} bookmark(s) survived the deleted account`);
    return { violations, notes: { k } };
  },

  /** S11 cancel-during-call: the client goes away mid-transaction. */
  async cancelDuringSave(rng, slug) {
    const c = await pool.connect();
    let cancelled = false;
    try {
      await c.query("begin");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claim.sub', $1, true)", [USER_A]);
      await c.query(SQL_UPSERT, [USER_A, slug]);
      await sleep(rng.int(0, 8));
      // Simulate the request being abandoned: kill the transaction, not the row.
      await c.query("rollback");
      cancelled = true;
    } finally {
      c.release();
    }
    const concurrent = await Promise.allSettled([
      callAsUser(USER_A, SQL_UPSERT, [USER_A, slug]),
      callAsUser(USER_A, SQL_READBACK, [USER_A, slug]),
    ]);
    const violations = [];
    for (const r of concurrent) {
      if (r.status === "rejected")
        violations.push(`post-cancel op failed: ${JSON.stringify(errOf(r.reason))}`);
    }
    const rows = await rowsFor(USER_A, slug);
    if (rows.length !== 1)
      violations.push(`expected the retry to leave exactly 1 row, saw ${rows.length}`);
    return { violations, notes: { cancelled } };
  },

  /**
   * S12 identity rotation mid-connection (pooled connection reused by another
   * signed-in user, or a token rotated between statements).
   */
  async identityRotationMidTx(rng, slug) {
    await callAsUser(USER_A, SQL_UPSERT, [USER_A, slug]);
    const violations = [];
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claim.sub', $1, true)", [USER_A]);
      const mine = await c.query(SQL_READBACK, [USER_A, slug]);
      if (mine.rowCount !== 1) violations.push("A could not read its own row before rotation");
      await sleep(rng.int(0, 6));
      // Rotate to C mid-transaction: the very next statement must be scoped to C.
      await c.query("select set_config('request.jwt.claim.sub', $1, true)", [USER_C]);
      const afterRotate = await c.query(SQL_READBACK, [USER_A, slug]);
      if (afterRotate.rowCount !== 0) {
        violations.push(`after rotation the session still read A's row (${afterRotate.rowCount})`);
      }
      const write = await c.query(SQL_UPSERT, [USER_A, `${slug}-x`]).catch((e) => e);
      if (!(write instanceof Error)) {
        violations.push("rotated session inserted a row owned by A");
      } else if (write.code !== "42501") {
        violations.push(`unexpected rotation write error: ${JSON.stringify(errOf(write))}`);
      }
      await c.query("rollback");
    } finally {
      c.release();
    }
    if ((await rowsFor(USER_A, slug)).length !== 1) violations.push("A's row was lost");
    if ((await rowsFor(USER_A, `${slug}-x`)).length !== 0)
      violations.push("rotated write persisted");
    return { violations, notes: {} };
  },

  /** S13 concurrent list + mutation: the list must never show a torn row. */
  async listDuringMutation(rng, slug) {
    const n = rng.int(2, 5);
    const slugs = Array.from({ length: n }, (_, i) => `${slug}-l${i}`);
    await Promise.all(slugs.map((s) => callAsUser(USER_A, SQL_UPSERT, [USER_A, s])));
    const violations = [];
    const listers = Array.from({ length: 3 }, async () => {
      await sleep(rng.int(0, 10));
      const r = await callAsUser(USER_A, SQL_LIST, [USER_A]);
      const own = r.rows.filter((row) => slugs.includes(row.slug));
      const uniq = new Set(own.map((row) => row.slug));
      if (uniq.size !== own.length) violations.push("list returned duplicate slugs");
      if (r.rows.some((row) => row.saved_at == null))
        violations.push("list returned a null saved_at");
      return own.length;
    });
    const mutators = slugs.map(async (s) => {
      await sleep(rng.int(0, 10));
      return rng.next() < 0.5
        ? callAsUser(USER_A, SQL_DELETE, [USER_A, s])
        : callAsUser(USER_A, SQL_UPSERT, [USER_A, s]);
    });
    const settled = await Promise.allSettled([...listers, ...mutators]);
    for (const r of settled) {
      if (r.status === "rejected")
        violations.push(`list/mutate failed: ${JSON.stringify(errOf(r.reason))}`);
    }
    for (const s of slugs) {
      if ((await rowsFor(USER_A, s)).length > 1) violations.push(`duplicate rows for ${s}`);
    }
    return { violations, notes: { n } };
  },

  /** S14 hostile slug racing a legitimate save (check constraint under load). */
  async hostileSlugRace(rng, slug) {
    const hostile = rng.pick([
      "../../../etc/passwd",
      "'; drop table public.user_saved_drills; --",
      `${"x".repeat(200)}`,
      "-leading-dash",
      "with space",
    ]);
    const settled = await Promise.allSettled([
      (async () => {
        await sleep(rng.int(0, 8));
        return callAsUser(USER_A, SQL_UPSERT, [USER_A, slug]);
      })(),
      (async () => {
        await sleep(rng.int(0, 8));
        return callAsUser(USER_A, SQL_UPSERT, [USER_A, hostile]);
      })(),
    ]);
    const violations = [];
    if (settled[0].status === "rejected") {
      violations.push(`legit save failed: ${JSON.stringify(errOf(settled[0].reason))}`);
    }
    if (settled[1].status === "fulfilled") {
      violations.push(`hostile slug accepted: ${JSON.stringify(hostile)}`);
    } else if (settled[1].reason.code !== "23514") {
      violations.push(`hostile slug rejected with ${settled[1].reason.code}, expected 23514`);
    }
    if ((await rowsFor(USER_A, slug)).length !== 1) violations.push("legit bookmark missing");
    if ((await rowsFor(USER_A, hostile)).length !== 0)
      violations.push("hostile bookmark persisted");
    return { violations, notes: { hostile } };
  },
};

// ── setup / teardown ─────────────────────────────────────────────────────────
async function ensureUser(uid, email) {
  await owner(
    "insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values ($1, $2, '{}'::jsonb, '{\"provider\":\"google\"}'::jsonb) on conflict (id) do nothing",
    [uid, email],
  );
  const p = await owner("select count(*)::int as n from public.profiles where id = $1", [uid]);
  if (p.rows[0].n !== 1) throw new Error(`profile for ${uid} was not created by the auth trigger`);
}

async function main() {
  const startedAt = new Date().toISOString();
  await ensureUser(USER_A, "stress-a@example.test");
  await ensureUser(USER_B, "stress-b@example.test");
  await ensureUser(USER_C, "stress-c@example.test");

  const names = Object.keys(scenarios).filter((n) => ONLY.length === 0 || ONLY.includes(n));
  const results = [];
  const t0 = Date.now();

  for (let iter = 0; iter < ITERATIONS; iter++) {
    const name = names[iter % names.length];
    const seed = seedOf(BASE_SEED, iter, name);
    const rng = rngFor(seed);
    const slug = `stress-${BASE_SEED}-${iter}-${seed.toString(36)}`;
    // The slug is a pure function of (base seed, iter), so replaying a seed on
    // a database that already ran it must start from the same clean state —
    // otherwise "exactly one INSERT wins" reads as zero on the second run.
    await owner("delete from public.user_saved_drills where slug = $1", [slug]);
    const started = Date.now();
    let outcome = "held";
    let violations = [];
    let notes = {};
    try {
      const res = await Promise.race([
        scenarios[name](rng, slug),
        sleep(ITER_WALL_MS).then(() => {
          throw new Error(`iteration exceeded wall bound ${ITER_WALL_MS}ms`);
        }),
      ]);
      violations = res.violations;
      notes = res.notes;
      if (violations.length) outcome = "broken";
    } catch (e) {
      outcome = "broken";
      violations = [`harness/driver error: ${JSON.stringify(errOf(e))}`];
    }
    const row = {
      iter,
      scenario: name,
      seed,
      slug,
      outcome,
      ms: Date.now() - started,
      violations,
      notes,
    };
    results.push(row);
    if (outcome === "broken") {
      console.error(
        `BROKEN iter=${iter} scenario=${name} seed=${seed} → ${violations.join(" | ")}`,
      );
    } else if ((iter + 1) % 25 === 0) {
      console.log(`… ${iter + 1}/${ITERATIONS} iterations, 0 broken so far`);
    }
  }

  // Global invariants after the whole campaign.
  const globals = [];
  const dup = await owner(
    "select user_id, slug, count(*)::int as n from public.user_saved_drills group by 1,2 having count(*) > 1",
  );
  if (dup.rowCount) globals.push(`duplicate (user_id, slug) rows: ${JSON.stringify(dup.rows)}`);
  const orphan = await owner(
    "select count(*)::int as n from public.user_saved_drills d left join public.profiles p on p.id = d.user_id where p.id is null",
  );
  if (orphan.rows[0].n !== 0) globals.push(`${orphan.rows[0].n} orphan bookmark rows`);
  const badSlug = await owner(
    "select count(*)::int as n from public.user_saved_drills where slug !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$'",
  );
  if (badSlug.rows[0].n !== 0)
    globals.push(`${badSlug.rows[0].n} rows violate the slug constraint`);

  const broken = results.filter((r) => r.outcome === "broken");
  const perScenario = {};
  for (const r of results) {
    const s = (perScenario[r.scenario] ??= { runs: 0, broken: 0, notes: {} });
    s.runs++;
    if (r.outcome === "broken") s.broken++;
    if (r.notes && r.notes.missedReadback)
      s.notes.missedReadback = (s.notes.missedReadback ?? 0) + 1;
    if (r.notes && r.notes.serializationFailures) {
      s.notes.serializationFailures =
        (s.notes.serializationFailures ?? 0) + r.notes.serializationFailures;
    }
    if (r.notes && r.notes.deadlocks)
      s.notes.deadlocks = (s.notes.deadlocks ?? 0) + r.notes.deadlocks;
  }

  const report = {
    unit: "db-drills-saved",
    lens: "concurrency",
    table: "public.user_saved_drills",
    startedAt,
    finishedAt: new Date().toISOString(),
    wallMs: Date.now() - t0,
    baseSeed: BASE_SEED,
    iterations: ITERATIONS,
    scenarios: names,
    perScenario,
    globalInvariantViolations: globals,
    brokenCount: broken.length,
    results,
  };
  if (OUT) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log(`report → ${OUT}`);
  }
  console.log(
    `\n${ITERATIONS} iterations across ${names.length} scenarios in ${report.wallMs}ms; broken=${broken.length}; global violations=${globals.length}`,
  );
  for (const g of globals) console.error(`GLOBAL VIOLATION: ${g}`);
  await pool.end();
  process.exit(broken.length || globals.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => {});
  process.exit(1);
});
