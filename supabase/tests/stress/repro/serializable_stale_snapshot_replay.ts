/**
 * Deterministic 2-session repro (no randomness) for the SERIALIZABLE-only
 * anomaly the campaign surfaces in scenario B (same shot id, two distinct
 * permits, same user):
 *
 *   S2: begin isolation level serializable; set role authenticated (user U);
 *       select 1  -- snapshot taken BEFORE S1 commits
 *   S1: apply_synced_shot(shot S, permit p1)  → accepted, committed
 *   S2: apply_synced_shot(shot S, permit p2)
 *       expected: 'accepted' (U already owns S; the RPC's replay branch)
 *       observed: 'shot.id_conflict' (permanent) — both the post-lock
 *                 replay check and the unique_violation handler read the
 *                 stale snapshot where S does not exist, while the unique
 *                 index (which is not snapshot-bound) rejects the insert.
 *
 * Hosted PostgREST runs RPCs under READ COMMITTED (every statement gets a
 * fresh snapshot), so this is NOT reachable through the edge function today;
 * it documents that the idempotency contract depends on the isolation level.
 *
 *   STRESS_PG_URL=postgres://postgres:pg@127.0.0.1:5499/postgres \
 *     deno run -A --no-check --config deno.json repro/serializable_stale_snapshot_replay.ts
 */
import postgres from "postgres";
import {
  applyRpc,
  asUser,
  createUser,
  makePayload,
  Prng,
  reserveAsUser,
  stdout,
} from "../harness.ts";

const url = Deno.env.get("STRESS_PG_URL");
if (!url) throw new Error("STRESS_PG_URL required");
const sql = postgres(url, { max: 4, onnotice: () => {} });
const prng = new Prng(7);
const u = {
  id: "44444444-4444-4444-8444-444444444444",
  provider: "google",
  sub: "repro-serializable",
  premium: true,
};
await createUser(sql, u);
const p1 = await reserveAsUser(sql, u.id, "k-repro-1");
const p2 = await reserveAsUser(sql, u.id, "k-repro-2");
const shotId = "55555555-5555-4555-8555-555555555555";
const pay1 = makePayload(prng, shotId, p1);
const pay2 = makePayload(prng, shotId, p2);

const run = async (isolation: "read committed" | "serializable") => {
  const s2 = await sql.reserve();
  try {
    await s2.unsafe(`begin isolation level ${isolation}`);
    await asUser(s2, u.id);
    await s2.unsafe(`select 1`); // S2 snapshot
    let r1 = "";
    await sql.begin(async (tx) => {
      await asUser(tx, u.id);
      r1 = await applyRpc(tx, pay1); // S1 commits the row
    });
    const r2 = await applyRpc(s2, pay2);
    await s2.unsafe(`commit`);
    const rows = await sql.unsafe(
      `select count(*)::int as n from public.shots where id = '${shotId}' and user_id = '${u.id}'`,
    );
    const permits = await sql.unsafe(
      `select id::text as id, status, outcome from public.analysis_permits where user_id = '${u.id}' order by created_at`,
    );
    return { isolation, s1: r1, s2: r2, ownedRows: rows[0].n, permits };
  } finally {
    s2.release();
  }
};

const ser = await run("serializable");
stdout(JSON.stringify(ser, null, 2));
// reset and show the READ COMMITTED behaviour for the same interleaving
await sql.unsafe(`delete from public.shots where id = '${shotId}'`);
await sql.unsafe(
  `update public.analysis_permits set status = 'reserved', outcome = null where user_id = '${u.id}'`,
);
const rc = await run("read committed");
stdout(JSON.stringify(rc, null, 2));
await sql.unsafe(`delete from auth.users where id = '${u.id}'`);
await sql.end();
const broken = ser.s2 !== "accepted";
stdout(
  broken
    ? `BROKEN (serializable): S2 returned ${ser.s2}, expected accepted; read committed returned ${rc.s2}`
    : "HELD: serializable replay accepted",
);
Deno.exit(broken ? 1 : 0);
