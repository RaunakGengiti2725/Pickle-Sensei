/**
 * Deterministic 2-session repro for the deadlock between apply_synced_shot
 * and account deletion (what `auth.admin.deleteUser` does: `delete from
 * auth.users where id = $1`, cascading through profiles → shots / permits).
 *
 *   S1 (authenticated user U): begin; apply_synced_shot(shot S, permit P)
 *       → holds access_lock_key(U), P `for update`, the new shots row and a
 *         KEY SHARE on profiles(U) … then the harness holds the tx open.
 *   S2 (owner): begin; delete from auth.users where id = U
 *       → deletes auth.users(U) → cascade deletes profiles(U) (conflicts with
 *         S1's KEY SHARE? no — S1 already holds it, so S2 BLOCKS here) …
 *
 * The campaign shows the interleaving that deadlocks: S2 gets to the
 * profiles/permit cascade first, S1 then needs KEY SHARE on the profile row
 * S2 deleted while S2 needs the permit row S1 locked `for update`. Postgres
 * resolves it after deadlock_timeout (1s) with SQLSTATE 40P01 on one side:
 *   - apply loses → the RPC's handler returns 'shot.write_failed:40P01'
 *     (transient for the client) and the account deletion proceeds;
 *   - delete loses → `deleteUser` fails → POST /v1/account/delete answers
 *     503 after the Apple authorization was already revoked; the account,
 *     its shots and permits remain until the user retries.
 *
 * This script forces the second ordering deterministically:
 *   S2 first deletes the profile row's parent (auth.users) and blocks on the
 *   permit row; S1 then inserts and blocks on the profile KEY SHARE.
 *
 *   STRESS_PG_URL=postgres://postgres:pg@127.0.0.1:5499/postgres \
 *     deno run -A --no-check --config deno.json repro/delete_user_vs_apply_deadlock.ts
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
const prng = new Prng(11);
const u = {
  id: "66666666-6666-4666-8666-666666666666",
  provider: "google",
  sub: "repro-deadlock",
  premium: true,
};
await createUser(sql, u);
const permit = await reserveAsUser(sql, u.id, "k-repro-deadlock");
const payload = makePayload(prng, "77777777-7777-4777-8777-777777777777", permit);

const s1 = await sql.reserve();
const s2 = await sql.reserve();
const outcome: Record<string, unknown> = {};
try {
  // S1 takes the per-user advisory lock and the permit row lock exactly like
  // the RPC does, but stops before the shots insert (the RPC is atomic, so we
  // reproduce its lock footprint step by step with the same statements).
  await s1.unsafe(`begin`);
  await asUser(s1, u.id);
  await s1.unsafe(`select pg_advisory_xact_lock(public.access_lock_key('${u.id}'::uuid))`);
  await s1.unsafe(`select id from public.analysis_permits where id = '${permit}' for update`);

  // S2: account deletion starts; the cascade reaches analysis_permits and
  // blocks on S1's row lock (after having deleted auth.users → profiles).
  await s2.unsafe(`begin`);
  const del = s2.unsafe(`delete from auth.users where id = '${u.id}'`).then(
    (r) => ({ ok: true, count: r.count }),
    (e) => ({
      ok: false,
      sqlstate: (e as { code?: string }).code,
      message: String((e as Error).message),
    }),
  );
  await new Promise((r) => setTimeout(r, 300));

  // S1: the RPC body continues — the shots insert needs KEY SHARE on the
  // profiles row S2 has deleted → S1 waits on S2 while S2 waits on S1.
  const t0 = performance.now();
  const apply = await applyRpc(s1, payload).then(
    (r) => ({ ok: true, result: r }),
    (e) => ({
      ok: false,
      sqlstate: (e as { code?: string }).code,
      message: String((e as Error).message),
    }),
  );
  outcome.applyMs = Math.round(performance.now() - t0);
  outcome.apply = apply;
  await s1.unsafe(`commit`).catch(async () => await s1.unsafe(`rollback`));
  outcome.delete = await del;
  await s2.unsafe(`commit`).catch(async () => await s2.unsafe(`rollback`));
} finally {
  s1.release();
  s2.release();
}
const left = await sql.unsafe(
  `select (select count(*) from auth.users where id = '${u.id}')::int as users,
          (select count(*) from public.shots where user_id = '${u.id}')::int as shots,
          (select count(*) from public.analysis_permits where user_id = '${u.id}')::int as permits`,
);
outcome.remaining = left[0];
await sql.unsafe(`delete from auth.users where id = '${u.id}'`);
await sql.end();
stdout(JSON.stringify(outcome, null, 2));
const deadlocked =
  JSON.stringify(outcome.apply).includes("40P01") ||
  JSON.stringify(outcome.delete).includes("40P01");
stdout(
  deadlocked
    ? "BROKEN: deadlock (40P01) between apply_synced_shot and account deletion"
    : "HELD: no deadlock between apply_synced_shot and account deletion",
);
Deno.exit(deadlocked ? 1 : 0);
