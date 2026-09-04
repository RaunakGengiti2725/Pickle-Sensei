/**
 * Adversarial pass 3 — S4: analysis-permit expiry timing inside
 * public.apply_synced_shot (20260902150000_free_rating_identity_ledger.sql,
 * `if v_permit.created_at <= now() - interval '24 hours'`).
 *
 * Postgres harness (same throwaway container as be-edge-routes-shots-rank):
 *
 *   docker run -d --name pickle-audit -p 55432:5432 -e POSTGRES_PASSWORD=pg postgres:16
 *   docker cp supabase/tests pickle-audit:/tests && docker cp supabase/migrations pickle-audit:/migrations
 *   docker exec pickle-audit bash -c 'psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql \
 *     && for f in /migrations/*.sql; do psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"; done'
 *   PICKLE_AUDIT_PG_URL=postgres://postgres:pg@127.0.0.1:55432/postgres \
 *     deno test -A --no-check --config deno.json attack3_permit_expiry_pg.test.ts
 *
 * Every test runs in ONE transaction that is rolled back, so `now()` is frozen
 * for the whole scenario and the ±1 s offsets are exact, not racy. created_at
 * is moved as the superuser (the authenticated role's column grant is
 * status/outcome only — by design); the RPC then runs as `authenticated`
 * with the JWT sub set, exactly as the edge function's per-user client does.
 * Without PICKLE_AUDIT_PG_URL every test is skipped (ignore: true).
 */
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";

const PG_URL = Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

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

type Sql = ReturnType<typeof postgres>;

async function withRollback(sql: Sql, fn: (tx: Sql) => Promise<void>): Promise<void> {
  try {
    await sql.begin(async (tx) => {
      await fn(tx as unknown as Sql);
      throw new Error("__rollback__");
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "__rollback__") throw error;
  }
}

async function asUser(tx: Sql, userId: string): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

async function asSuperuser(tx: Sql): Promise<void> {
  await tx.unsafe(`reset role`);
}

function shotPayload(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
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

async function reserve(tx: Sql, key: string): Promise<string> {
  const rows = await tx.unsafe(`select result, permit_id from public.reserve_analysis_permit('${key}')`);
  assertEquals(rows[0].result, "accepted");
  return String(rows[0].permit_id);
}

async function apply(tx: Sql, shot: Record<string, unknown>): Promise<string> {
  const rows = await tx.unsafe(`select public.apply_synced_shot($1::text::jsonb) as status`, [
    JSON.stringify(shot),
  ]);
  return String(rows[0].status);
}

async function agePermit(tx: Sql, userId: string, permitId: string, offset: string): Promise<void> {
  await asSuperuser(tx);
  const updated = await tx.unsafe(
    `update public.analysis_permits set created_at = now() - interval '${offset}' where id = '${permitId}' returning created_at`,
  );
  assertEquals(updated.length, 1);
  await asUser(tx, userId);
}

async function permitRow(tx: Sql, permitId: string): Promise<{ status: string; outcome: string | null }> {
  const rows = await tx.unsafe(`select status, outcome from public.analysis_permits where id = '${permitId}'`);
  assertEquals(rows.length, 1);
  return { status: String(rows[0].status), outcome: rows[0].outcome === null ? null : String(rows[0].outcome) };
}

async function scenario(fn: (tx: Sql, userId: string) => Promise<void>): Promise<void> {
  const sql = postgres(PG_URL);
  try {
    await withRollback(sql, async (tx) => {
      const userId = crypto.randomUUID();
      await tx.unsafe(`insert into auth.users (id, email) values ('${userId}', '${userId}@example.com')`);
      await asUser(tx, userId);
      await fn(tx, userId);
    });
  } finally {
    await sql.end();
  }
}

Deno.test({
  name: "S4: permit aged to now()-24h-1s → apply_synced_shot returns access.permit_expired, permit becomes released/expired, no shot row",
  ignore,
  async fn() {
    await scenario(async (tx, userId) => {
      const permitId = await reserve(tx, "expiry-late");
      await agePermit(tx, userId, permitId, "24 hours 1 second");
      const shot = shotPayload({ analysisPermitId: permitId });
      assertEquals(await apply(tx, shot), "access.permit_expired");
      assertEquals(await permitRow(tx, permitId), { status: "released", outcome: "expired" });
      const shots = await tx.unsafe(`select count(*)::int as n from public.shots where id = '${shot.id}'`);
      assertEquals(shots[0].n, 0);
      // A replay against the now-released permit is the "not reserved" code,
      // never a second expiry write and never an acceptance.
      assertEquals(await apply(tx, shot), "access.permit_not_reserved");
      assertEquals(await permitRow(tx, permitId), { status: "released", outcome: "expired" });
    });
  },
});

Deno.test({
  name: "S4: permit aged to exactly now()-24h+1s (i.e. 23h59m59s old) → accepted, permit finalized/scored",
  ignore,
  async fn() {
    await scenario(async (tx, userId) => {
      const permitId = await reserve(tx, "expiry-fresh");
      await agePermit(tx, userId, permitId, "23 hours 59 minutes 59 seconds");
      const shot = shotPayload({ analysisPermitId: permitId });
      assertEquals(await apply(tx, shot), "accepted");
      assertEquals(await permitRow(tx, permitId), { status: "finalized", outcome: "scored" });
      const shots = await tx.unsafe(`select count(*)::int as n from public.shots where id = '${shot.id}'`);
      assertEquals(shots[0].n, 1);
    });
  },
});

Deno.test({
  name: "S4: boundary — created_at exactly now()-24h is treated as EXPIRED by apply (<=), and access_state stops counting it as reserved at the same instant (>)",
  ignore,
  async fn() {
    await scenario(async (tx, userId) => {
      const permitId = await reserve(tx, "expiry-boundary");
      const before = await tx.unsafe(`select reserved_count from public.access_state()`);
      assertEquals(before[0].reserved_count, 1);
      await agePermit(tx, userId, permitId, "24 hours");
      const at = await tx.unsafe(`select reserved_count from public.access_state()`);
      assertEquals(at[0].reserved_count, 0, "access_state must not count a permit that apply would refuse");
      assertEquals(await apply(tx, shotPayload({ analysisPermitId: permitId })), "access.permit_expired");
      assertEquals(await permitRow(tx, permitId), { status: "released", outcome: "expired" });
    });
  },
});

Deno.test({
  name: "S4: clock skew — a permit with created_at in the FUTURE (+1h) is not expired and is accepted; a permit 1 year old is expired",
  ignore,
  async fn() {
    await scenario(async (tx, userId) => {
      const future = await reserve(tx, "expiry-future");
      await agePermit(tx, userId, future, "-1 hour");
      assertEquals(await apply(tx, shotPayload({ analysisPermitId: future })), "accepted");
      const ancient = await reserve(tx, "expiry-ancient");
      await agePermit(tx, userId, ancient, "365 days");
      assertEquals(await apply(tx, shotPayload({ analysisPermitId: ancient })), "access.permit_expired");
      assertEquals(await permitRow(tx, ancient), { status: "released", outcome: "expired" });
    });
  },
});

Deno.test({
  name: "S4: an expired permit frees the reservation slot — the user can reserve again and the expired permit never consumed a free rating",
  ignore,
  async fn() {
    await scenario(async (tx, userId) => {
      const stale = await reserve(tx, "expiry-slot-1");
      await agePermit(tx, userId, stale, "25 hours");
      assertEquals(await apply(tx, shotPayload({ analysisPermitId: stale })), "access.permit_expired");
      const access = await tx.unsafe(`select scored_count, reserved_count from public.access_state()`);
      assertEquals(access[0].scored_count, 0);
      assertEquals(access[0].reserved_count, 0);
      const p2 = await reserve(tx, "expiry-slot-2");
      const p3 = await reserve(tx, "expiry-slot-3");
      assertEquals(await apply(tx, shotPayload({ analysisPermitId: p2 })), "accepted");
      assertEquals(await apply(tx, shotPayload({ analysisPermitId: p3, shotType: "serve" })), "accepted");
      const after = await tx.unsafe(`select scored_count from public.access_state()`);
      assertEquals(after[0].scored_count, 2);
    });
  },
});

Deno.test({
  name: "S4: permission denial — the authenticated role cannot rewind created_at itself to dodge expiry (column grant is status/outcome only)",
  ignore,
  async fn() {
    await scenario(async (tx, userId) => {
      const permitId = await reserve(tx, "expiry-tamper");
      await agePermit(tx, userId, permitId, "25 hours");
      let denied = false;
      try {
        await tx.unsafe(`savepoint tamper`);
        await tx.unsafe(`update public.analysis_permits set created_at = now() where id = '${permitId}'`);
      } catch (error) {
        denied = true;
        assert(String(error).includes("permission denied"), String(error));
        await tx.unsafe(`rollback to savepoint tamper`);
      }
      assert(denied, "authenticated role must not be able to update created_at");
      assertEquals(await apply(tx, shotPayload({ analysisPermitId: permitId })), "access.permit_expired");
      void userId;
    });
  },
});

Deno.test({
  name: "S4: another user's expired permit is invisible — apply as a second user reports permit_not_found and leaves the row untouched",
  ignore,
  async fn() {
    await scenario(async (tx, owner) => {
      const permitId = await reserve(tx, "expiry-cross-user");
      await agePermit(tx, owner, permitId, "25 hours");
      const intruder = crypto.randomUUID();
      await asSuperuser(tx);
      await tx.unsafe(`insert into auth.users (id, email) values ('${intruder}', '${intruder}@example.com')`);
      await asUser(tx, intruder);
      assertEquals(await apply(tx, shotPayload({ analysisPermitId: permitId })), "access.permit_not_found");
      await asSuperuser(tx);
      assertEquals(await permitRow(tx, permitId), { status: "reserved", outcome: null });
    });
  },
});
