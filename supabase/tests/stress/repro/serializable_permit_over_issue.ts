/**
 * Deterministic repro: `reserve_analysis_permit` over-issues free permits when
 * the caller's transaction is NOT READ COMMITTED.
 *
 * The gate is "take access_lock_key(uid), then re-count scored + live reserved
 * under the lock". The re-count reads the TRANSACTION snapshot, so a session
 * that took its snapshot before a concurrent reservation committed still counts
 * the stale total after acquiring the lock, and hands out a third live permit
 * to a free account whose lifetime allowance is two.
 *
 *   S2: begin isolation level serializable; select 1        -- snapshot fixed
 *   S1: reserve_analysis_permit(k1)                         -- 2nd live permit
 *   S2: reserve_analysis_permit(k2)                         -- expects paywall
 *
 * Hosted PostgREST executes the RPC in its own READ COMMITTED transaction, so
 * this is reachable only from a client that opts into a stricter isolation
 * level; the same script runs the READ COMMITTED control for contrast.
 *
 *   STRESS_PG_URL=postgres://postgres:pg@127.0.0.1:5499/postgres \
 *     deno run -A --no-check --config deno.json repro/serializable_permit_over_issue.ts
 */
import postgres from "postgres";
import { asUser, createUser, stdout } from "../harness.ts";

const url = Deno.env.get("STRESS_PG_URL");
if (!url) throw new Error("STRESS_PG_URL required");
const sql = postgres(url, { max: 4, onnotice: () => {} });

type Case = {
  isolation: "serializable" | "read committed";
  s1: string;
  s2: string;
  reserved: number;
};

async function run(isolation: "serializable" | "read committed", uid: string): Promise<Case> {
  await sql.unsafe(`delete from auth.users where id = '${uid}'`);
  await createUser(sql, {
    id: uid,
    provider: "google",
    sub: `repro-over-issue-${isolation}`,
    premium: false,
  });
  // First of the two free permits, committed before either session starts.
  await sql.begin(async (tx) => {
    await asUser(tx, uid);
    await tx.unsafe(`select public.reserve_analysis_permit('k-setup')`);
  });

  const s1 = await sql.reserve();
  const s2 = await sql.reserve();
  let r1 = "";
  let r2 = "";
  try {
    await s2.unsafe(`begin isolation level ${isolation}`);
    await asUser(s2, uid);
    await s2.unsafe(`select 1`); // fixes S2's snapshot before S1 commits

    await s1.unsafe(`begin`);
    await asUser(s1, uid);
    r1 = String(
      (await s1.unsafe(`select result from public.reserve_analysis_permit('k-s1')`))[0].result,
    );
    await s1.unsafe(`commit`);

    r2 = String(
      (await s2.unsafe(`select result from public.reserve_analysis_permit('k-s2')`))[0].result,
    );
    await s2.unsafe(`commit`).catch(async () => {
      r2 = `${r2}(rolled back)`;
      await s2.unsafe(`rollback`);
    });
  } catch (e) {
    r2 = `err:${(e as { code?: string }).code ?? String((e as Error).message)}`;
    await s2.unsafe(`rollback`).catch(() => {});
    await s1.unsafe(`rollback`).catch(() => {});
  } finally {
    s1.release();
    s2.release();
  }
  const live = await sql.unsafe(
    `select count(*)::int as n from public.analysis_permits
       where user_id = '${uid}' and status = 'reserved'`,
  );
  await sql.unsafe(`delete from auth.users where id = '${uid}'`);
  return { isolation, s1: r1, s2: r2, reserved: Number(live[0].n) };
}

const ser = await run("serializable", "88888888-8888-4888-8888-888888888888");
const rc = await run("read committed", "99999999-9999-4999-8999-999999999999");
await sql.end();
stdout(JSON.stringify({ ser, rc }, null, 2));
const broken = ser.reserved > 2;
stdout(
  broken
    ? `BROKEN (serializable): free account holds ${ser.reserved} live permits (limit 2); read committed held ${rc.reserved} with s2=${rc.s2}`
    : `HELD: serializable held ${ser.reserved} live permits, read committed ${rc.reserved}`,
);
Deno.exit(broken ? 1 : 0);
