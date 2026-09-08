/**
 * Adversarial tester, work package W01-01 (candidate 4b785e99) — REAL Postgres
 * attacks on migration 20260908100000_permit_partial_terminal_outcome.sql.
 *
 * Same harness shape as xc_pg_permit_lifecycle_adversary.test.ts: a disposable
 * postgres:16 with shim_auth.sql + every migration applied (./xc_pg_up.sh),
 * role `authenticated` with a JWT sub, independent connections whose
 * transactions genuinely overlap. Nothing is mocked.
 *
 *   ./xc_pg_up.sh
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     deno test -A --config deno.json xc_pg_w01_01_partial_outcome_adversary.test.ts
 *
 * Without XC_PG_URL (alias PICKLE_AUDIT_PG_URL) every test is `ignore`d — an
 * ignored run is NOT a pass.
 *
 * Attacks (each test names the failure boundary it drives):
 *   W01-ATK-1  concurrency: partial vs scored sync racing on ONE permit, both
 *              orders → exactly one shot, the loser gets a permanent verdict,
 *              the count charges only when the scored side won
 *   W01-ATK-2  concurrency: partial sync uncommitted vs the pg_cron sweep and
 *              the reverse (sweep uncommitted vs late partial) → no deadlock,
 *              the permit ends released/partial in both orders
 *   W01-ATK-3  replay / duplicate identity: the partial shot id replayed as a
 *              9.9 scored payload, under another permit, twice concurrently,
 *              and by another user → the partial row is never upgraded
 *   W01-ATK-4  boundary values on a partial payload (score 0 / -1 / 10 / 11 /
 *              "NaN" / "Infinity" / "" ; resultKind "PARTIAL" / "partial " /
 *              "" / missing) → refused, no row, permit still backing a retry
 *   W01-ATK-5  unauthorised roles for the new state: anon, another user,
 *              client-role UPDATE/INSERT matrix around released/partial
 *              (allowed AND denied paths), direct client INSERT of a partial row
 *   W01-ATK-6  free-rating conservation: partials at the limit, premium,
 *              access_state(), reserve_analysis_permit(), late-linked identity
 *              inheritance and the ledger floor never count a partial
 *   W01-ATK-7  crash between steps: a partial whose detail write fails, and a
 *              backend killed mid-transaction → nothing persists, the permit
 *              still backs a clean retry
 *   W01-ATK-8  integration boundary: the shipping finalize route's exact write
 *              shape (status='finalized', outcome=<releasable>) with outcome
 *              'partial' is refused by the guard — released/partial is the only
 *              admissible spelling
 *   W01-ATK-9  tombstone + idempotency key: after the owner deletes a
 *              released/partial permit the tombstoned id is consumed and the
 *              same idempotency key is a NEW reservation (not a replay)
 *   W01-ATK-10 clocks: far-future / far-past created_at and capturedAt, and a
 *              capturedAt before the permit → the partial path is age-agnostic
 */
import postgres from "postgres";
import { assert, assertEquals, assertNotEquals } from "@std/assert";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

const U1 = "0000000a-4b78-4000-8000-000000000001";
const U2 = "0000000a-4b78-4000-8000-000000000002";
const PREMIUM = "0000000a-4b78-4000-8000-000000000003";

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

function partialPayload(
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
    overallScore: null,
    confidence: 0.2,
    resultKind: "partial",
    phases: [],
    checkpoints: [],
    versionVector: VERSION_VECTOR,
    ...overrides,
  };
}

function scoredPayload(
  id: string,
  analysisPermitId: string | null,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return partialPayload(id, analysisPermitId, {
    overallScore: 7,
    confidence: 0.9,
    resultKind: "scored",
    ...overrides,
  });
}

let shotSeq = 0;
function shotId(): string {
  shotSeq += 1;
  return `0000000a-4b78-4000-8000-1${String(shotSeq).padStart(11, "0")}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`select set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', public.get_api_request_key())::text, true)`);
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

async function asAnon(tx: Tx): Promise<void> {
  await tx.unsafe(`select set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', public.get_api_request_key())::text, true)`);
  await tx.unsafe(`set local role anon`);
  await tx.unsafe(`set local request.jwt.claim.sub = ''`);
}

/** Owner-role reset: the seeded ids repeat across runs against the same
 * disposable DB. The user cascade removes permits/shots/ledger owners; the
 * identity ledger has no FK, so the identities used here are wiped too. */
async function resetUsers(sql: Sql, premium = false): Promise<void> {
  await sql.unsafe(
    `delete from public.free_rating_ledger where identity_hash in (
       select public.free_rating_identity_hash(p, s) from (values
         ('google', 'google-sub-w01-u1'), ('apple', 'apple-sub-w01-u1-late'),
         ('google', 'google-sub-w01-u2'), ('google', 'google-sub-w01-premium')) as v(p, s))`,
  );
  for (const [id, sub] of [
    [U1, "google-sub-w01-u1"],
    [U2, "google-sub-w01-u2"],
    [PREMIUM, "google-sub-w01-premium"],
  ]) {
    await sql.unsafe(`delete from auth.users where id = '${id}'`);
    await sql.unsafe(
      `insert into auth.users (id, email, raw_app_meta_data) values ('${id}', '${id}@example.com', '{"provider":"google"}')`,
    );
    await sql.unsafe(
      `insert into auth.identities (provider, provider_id, user_id, identity_data)
       values ('google', '${sub}', '${id}', jsonb_build_object('sub', '${sub}', 'email', '${id}@example.com'))`,
    );
  }
  if (premium) {
    await sql.unsafe(
      `insert into public.billing_entitlements (user_id, premium, product_key, expires_at)
       values ('${PREMIUM}', true, 'pickle_sensei_pro_lifetime', null)`,
    );
  }
}

function inTx<T>(
  sql: Sql,
  userId: string | null,
  fn: (tx: Tx) => Promise<T>,
  hold?: Promise<void>,
): Promise<T> {
  return sql.begin(async (tx) => {
    if (userId) await asUser(tx as unknown as Tx, userId);
    const out = await fn(tx as unknown as Tx);
    if (hold) await hold;
    return out;
  }) as Promise<T>;
}

async function reserve(sql: Sql, userId: string, key: string): Promise<string> {
  const rows = await inTx(
    sql,
    userId,
    async (tx) =>
      await tx.unsafe(
        `select x.result, x.permit_id::text as permit_id from public.reserve_analysis_permit('${key}') x`,
      ),
  );
  assertEquals(rows[0].result, "accepted", `reserve ${key}`);
  return rows[0].permit_id as string;
}

async function reserveVerdict(
  sql: Sql,
  userId: string,
  key: string,
): Promise<{
  result: string;
  permitId: string | null;
  status: string | null;
  outcome: string | null;
}> {
  const rows = await inTx(
    sql,
    userId,
    async (tx) =>
      await tx.unsafe(
        `select x.result, x.permit_id::text as permit_id, x.permit_status, x.permit_outcome
         from public.reserve_analysis_permit('${key}') x`,
      ),
  );
  return {
    result: String(rows[0].result),
    permitId: (rows[0].permit_id as string | null) ?? null,
    status: (rows[0].permit_status as string | null) ?? null,
    outcome: (rows[0].permit_outcome as string | null) ?? null,
  };
}

async function sync(tx: Tx, payload: Record<string, unknown>): Promise<string> {
  const rows = await tx.unsafe(`select public.apply_synced_shot($1::text::jsonb) as r`, [
    JSON.stringify(payload),
  ]);
  return String(rows[0].r);
}

async function permitState(sql: Sql, permitId: string): Promise<string> {
  const rows = await sql.unsafe(
    `select status || '/' || coalesce(outcome, 'NULL') as s from public.analysis_permits where id = '${permitId}'`,
  );
  return rows.length === 0 ? "MISSING" : String(rows[0].s);
}

/** result_kind/overall_score/analysis_permit_id of a shot row, or MISSING. */
async function shotRow(sql: Sql, id: string): Promise<string> {
  const rows = await sql.unsafe(
    `select result_kind || '/' || coalesce(overall_score::text, 'NULL') || '/' || coalesce(analysis_permit_id::text, 'NULL') as s
     from public.shots where id = '${id}'`,
  );
  return rows.length === 0 ? "MISSING" : String(rows[0].s);
}

async function shotCount(sql: Sql, userId: string): Promise<number> {
  const rows = await sql.unsafe(
    `select count(*)::int as n from public.shots where user_id = '${userId}'`,
  );
  return Number(rows[0].n);
}

async function detailCount(sql: Sql, shot: string): Promise<number> {
  const rows = await sql.unsafe(
    `select (select count(*) from public.shot_phases where shot_id = '${shot}')::int
          + (select count(*) from public.shot_checkpoints where shot_id = '${shot}')::int as n`,
  );
  return Number(rows[0].n);
}

/** lifetime_scored_count() and access_state() as the user sees them. */
async function counts(
  sql: Sql,
  userId: string,
): Promise<{ lifetime: number; scored: number; reserved: number; premium: boolean }> {
  const rows = await inTx(
    sql,
    userId,
    async (tx) =>
      await tx.unsafe(
        `select public.lifetime_scored_count() as lifetime, a.scored_count, a.reserved_count, a.premium
         from public.access_state() a`,
      ),
  );
  return {
    lifetime: Number(rows[0].lifetime),
    scored: Number(rows[0].scored_count),
    reserved: Number(rows[0].reserved_count),
    premium: Boolean(rows[0].premium),
  };
}

async function ledger(sql: Sql, provider: string, sub: string): Promise<number> {
  const rows = await sql.unsafe(
    `select coalesce((select scored_count from public.free_rating_ledger
       where identity_hash = public.free_rating_identity_hash('${provider}', '${sub}')), -1) as n`,
  );
  return Number(rows[0].n);
}

/** Backdate a reservation past the sweep horizon (owner role). */
async function setCreatedAt(sql: Sql, permitId: string, expr: string): Promise<void> {
  await sql.unsafe(
    `with stale as (
       delete from public.analysis_permits where id = '${permitId}' and status = 'reserved'
       returning id, user_id, idempotency_key, status, outcome
     )
     insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome, created_at)
     select id, user_id, idempotency_key, status, outcome, ${expr} from stale`,
  );
}

const SWEEP_SQL = `update public.analysis_permits set status = 'released', outcome = 'expired' where status = 'reserved' and created_at < now() - interval '24 hours' and user_id in ('${U1}', '${U2}', '${PREMIUM}')`;

async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no result within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function pgError(e: unknown): { code: string; hint: string | null } {
  const err = e as { code?: string; hint?: string };
  return { code: err.code ?? "?", hint: err.hint ?? null };
}

/** One client statement in its own transaction as `userId`: "allowed <rows>"
 * or "<SQLSTATE>:<hint>". */
async function attempt(sql: Sql, userId: string, stmt: string): Promise<string> {
  try {
    const n = await inTx(sql, userId, async (tx) => (await tx.unsafe(stmt)).count);
    return `allowed ${n}`;
  } catch (e) {
    const { code, hint } = pgError(e);
    return `${code}:${hint}`;
  }
}

/** The sync RPC as `userId`, in its own committed transaction. */
function syncAs(sql: Sql, userId: string, payload: Record<string, unknown>): Promise<string> {
  return inTx(sql, userId, (tx) => sync(tx, payload));
}

// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "W01-ATK-1: partial vs scored racing on ONE permit (both orders) → exactly one shot, loser access.permit_not_reserved, the count charges only when scored won",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 8 });
    try {
      // Order A: the partial holds the permit lock uncommitted while the
      // scored sync arrives.
      await resetUsers(sql);
      let permit = await reserve(sql, U1, "atk1-a");
      let g = gate();
      const partialA = shotId();
      const scoredA = shotId();
      const heldPartial = inTx(sql, U1, (tx) => sync(tx, partialPayload(partialA, permit)), g.wait);
      await sleep(300);
      const scoredP = syncAs(sql, U1, scoredPayload(scoredA, permit));
      await sleep(400);
      g.open();
      const [rp, rs] = await within(Promise.all([heldPartial, scoredP]), 15_000, "ATK-1 order A");
      assertEquals(rp, "accepted");
      assertEquals(rs, "access.permit_not_reserved");
      assertEquals(await permitState(sql, permit), "released/partial");
      assertEquals(await shotRow(sql, partialA), `partial/NULL/${permit}`);
      assertEquals(await shotRow(sql, scoredA), "MISSING");
      assertEquals((await counts(sql, U1)).lifetime, 0);

      // Order B: the scored sync holds the lock; the partial arrives.
      permit = await reserve(sql, U1, "atk1-b");
      g = gate();
      const partialB = shotId();
      const scoredB = shotId();
      const heldScored = inTx(sql, U1, (tx) => sync(tx, scoredPayload(scoredB, permit)), g.wait);
      await sleep(300);
      const partialP = syncAs(sql, U1, partialPayload(partialB, permit));
      await sleep(400);
      g.open();
      const [rs2, rp2] = await within(Promise.all([heldScored, partialP]), 15_000, "ATK-1 order B");
      assertEquals(rs2, "accepted");
      assertEquals(rp2, "access.permit_not_reserved");
      assertEquals(await permitState(sql, permit), "finalized/scored");
      assertEquals(await shotRow(sql, partialB), "MISSING");
      assertEquals(await shotCount(sql, U1), 2);
      assertEquals((await counts(sql, U1)).lifetime, 1);

      // No-gate stampede: 6 partial syncs with 6 shot ids on one permit.
      permit = await reserve(sql, U1, "atk1-c");
      const ids = Array.from({ length: 6 }, () => shotId());
      const verdicts = await Promise.all(
        ids.map((id) => syncAs(sql, U1, partialPayload(id, permit))),
      );
      assertEquals(verdicts.filter((v) => v === "accepted").length, 1);
      assertEquals(verdicts.filter((v) => v === "access.permit_not_reserved").length, 5);
      assertEquals(await shotCount(sql, U1), 3);
      assertEquals(await permitState(sql, permit), "released/partial");
      assertEquals((await counts(sql, U1)).lifetime, 1);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "W01-ATK-2: partial sync uncommitted vs the sweep, and sweep uncommitted vs a late partial → no deadlock, released/partial in both orders, never released/expired over a stored shot",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 8 });
    try {
      await resetUsers(sql);
      // Order A: the partial sync locks the (stale) permit first; the sweep
      // must wait and then update 0 rows.
      const p1 = await reserve(sql, U1, "atk2-a");
      await setCreatedAt(sql, p1, "now() - interval '25 hours'");
      let g = gate();
      const s1 = shotId();
      const held = inTx(sql, U1, (tx) => sync(tx, partialPayload(s1, p1)), g.wait);
      await sleep(300);
      const sweepP = inTx(sql, null, async (tx) => (await tx.unsafe(SWEEP_SQL)).count);
      await sleep(400);
      g.open();
      const [verdict, swept] = await within(Promise.all([held, sweepP]), 15_000, "ATK-2 order A");
      assertEquals(verdict, "accepted");
      assertEquals(swept, 0);
      assertEquals(await permitState(sql, p1), "released/partial");
      assertEquals(await shotRow(sql, s1), `partial/NULL/${p1}`);

      // Order B: the sweep holds the row uncommitted; the late partial waits,
      // then settles the swept permit.
      const p2 = await reserve(sql, U1, "atk2-b");
      await setCreatedAt(sql, p2, "now() - interval '25 hours'");
      g = gate();
      const sweepHeld = inTx(sql, null, async (tx) => (await tx.unsafe(SWEEP_SQL)).count, g.wait);
      await sleep(300);
      const s2 = shotId();
      const lateP = syncAs(sql, U1, partialPayload(s2, p2));
      await sleep(400);
      g.open();
      const [swept2, verdict2] = await within(
        Promise.all([sweepHeld, lateP]),
        15_000,
        "ATK-2 order B",
      );
      assertEquals(swept2, 1);
      assertEquals(verdict2, "accepted");
      assertEquals(await permitState(sql, p2), "released/partial");
      assertEquals(await shotRow(sql, s2), `partial/NULL/${p2}`);

      // A released/partial permit is never re-swept nor re-expired.
      assertEquals(await (async () => (await sql.unsafe(SWEEP_SQL)).count)(), 0);
      assertEquals(
        await attempt(
          sql,
          U1,
          `update public.analysis_permits set status = 'released', outcome = 'expired' where id = '${p2}'`,
        ),
        "23514:access.permit_transition_rejected",
      );
      assertEquals((await counts(sql, U1)).lifetime, 0);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "W01-ATK-3: replaying the partial shot id as scored 9.9 / under a second permit / twice at once / from another user never upgrades the partial row or charges",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 8 });
    try {
      await resetUsers(sql);
      const p1 = await reserve(sql, U1, "atk3-a");
      const p2 = await reserve(sql, U1, "atk3-b");
      const id = shotId();
      assertEquals(await syncAs(sql, U1, partialPayload(id, p1)), "accepted");

      // Same id, now claiming a 9.9 rating under the same permit.
      assertEquals(await syncAs(sql, U1, scoredPayload(id, p1, { overallScore: 9.9 })), "accepted");
      assertEquals(await shotRow(sql, id), `partial/NULL/${p1}`);
      // Same id, claiming a rating under a DIFFERENT live permit.
      assertEquals(await syncAs(sql, U1, scoredPayload(id, p2, { overallScore: 9.9 })), "accepted");
      assertEquals(await shotRow(sql, id), `partial/NULL/${p1}`);
      assertEquals(await permitState(sql, p2), "reserved/NULL");
      assertEquals((await counts(sql, U1)).lifetime, 0);

      // Two identical partial syncs at once on a fresh permit → both accepted,
      // one row, one released/partial.
      const p3 = await reserve(sql, U1, "atk3-c");
      const dup = shotId();
      const both = await Promise.all([
        syncAs(sql, U1, partialPayload(dup, p3)),
        syncAs(sql, U1, partialPayload(dup, p3)),
      ]);
      assertEquals(both, ["accepted", "accepted"]);
      assertEquals(
        Number(
          (await sql.unsafe(`select count(*)::int as n from public.shots where id = '${dup}'`))[0]
            .n,
        ),
        1,
      );
      assertEquals(await permitState(sql, p3), "released/partial");

      // Another user replays U1's partial shot id with their own live permit.
      const pu2 = await reserve(sql, U2, "atk3-u2");
      assertEquals(await syncAs(sql, U2, partialPayload(id, pu2)), "shot.id_conflict");
      assertEquals(await shotRow(sql, id), `partial/NULL/${p1}`);
      assertEquals(await permitState(sql, pu2), "reserved/NULL");
      assertEquals(await shotCount(sql, U2), 0);

      // The consumed permit p1 cannot back another partial, nor a scored shot.
      assertEquals(
        await syncAs(sql, U1, partialPayload(shotId(), p1)),
        "access.permit_not_reserved",
      );
      assertEquals(
        await syncAs(sql, U1, scoredPayload(shotId(), p1)),
        "access.permit_not_reserved",
      );
      assertEquals(await shotCount(sql, U1), 2);
      assertEquals((await counts(sql, U1)).lifetime, 0);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "W01-ATK-4: boundary values on a partial payload (score 0/-1/10/11/NaN/Infinity/''; resultKind PARTIAL/'partial '/''/missing) → refused, no row, permit still backs a clean retry",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await resetUsers(sql);
      const permit = await reserve(sql, U1, "atk4");
      const cases: Array<[string, Record<string, unknown>, string]> = [
        ["score 0", { overallScore: 0 }, "shot.write_failed:23514"],
        ["score -1", { overallScore: -1 }, "shot.write_failed:23514"],
        ["score 10", { overallScore: 10 }, "shot.write_failed:23514"],
        ["score 11", { overallScore: 11 }, "shot.write_failed:23514"],
        ["score 'NaN'", { overallScore: "NaN" }, "shot.write_failed:23514"],
        ["score 'Infinity'", { overallScore: "Infinity" }, "shot.write_failed:22003"],
        ["score ''", { overallScore: "" }, "shot.write_failed:22P02"],
        ["resultKind PARTIAL", { resultKind: "PARTIAL" }, "shot.write_failed:23514"],
        ["resultKind 'partial '", { resultKind: "partial " }, "shot.write_failed:23514"],
        ["resultKind ''", { resultKind: "" }, "shot.write_failed:23514"],
        ["resultKind null", { resultKind: null }, "shot.write_failed:23502"],
        ["confidence 1.5", { confidence: 1.5 }, "shot.write_failed:23514"],
        ["confidence -0.1", { confidence: -0.1 }, "shot.write_failed:23514"],
      ];
      for (const [label, overrides, expected] of cases) {
        const id = shotId();
        const verdict = await syncAs(sql, U1, partialPayload(id, permit, overrides));
        assertEquals(verdict, expected, label);
        assertEquals(await shotRow(sql, id), "MISSING", label);
        assertEquals(await permitState(sql, permit), "reserved/NULL", label);
      }
      // A partial with a stray non-null score is ALSO refused when the client
      // bypasses the RPC and inserts the row directly (table invariant).
      assertEquals(
        await attempt(
          sql,
          U1,
          `insert into public.shots (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
             overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
             paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
           values ('${shotId()}', '${U1}', 'dink', 'side', now(), 0, 1, 2, 5.0, 0.2, 'partial',
             '1', '1', '1', '1', '1', '1', '1', '1')`,
        ),
        "23514:null",
      );
      // The permit is untouched by every refusal: a clean partial retry lands.
      const ok = shotId();
      assertEquals(await syncAs(sql, U1, partialPayload(ok, permit)), "accepted");
      assertEquals(await shotRow(sql, ok), `partial/NULL/${permit}`);
      assertEquals(await permitState(sql, permit), "released/partial");
      assertEquals(await shotCount(sql, U1), 1);
      assertEquals((await counts(sql, U1)).lifetime, 0);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "W01-ATK-5: roles around released/partial — anon, another user, the client UPDATE/INSERT matrix (allowed AND denied), direct client INSERT of a partial row",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await resetUsers(sql);
      const p1 = await reserve(sql, U1, "atk5-a");

      // anon: no EXECUTE on the RPC at all (42501), nothing is touched.
      const anon = await sql
        .begin(async (tx) => {
          await asAnon(tx as unknown as Tx);
          return await sync(tx as unknown as Tx, partialPayload(shotId(), p1));
        })
        .catch((e: unknown) => `${pgError(e).code}`);
      assertEquals(anon, "42501");
      // Another user naming U1's permit: RLS hides it (not found), no row.
      assertEquals(await syncAs(sql, U2, partialPayload(shotId(), p1)), "access.permit_not_found");
      // Another user releasing U1's permit as partial: 0 rows under RLS.
      assertEquals(
        await attempt(
          sql,
          U2,
          `update public.analysis_permits set status = 'released', outcome = 'partial' where id = '${p1}'`,
        ),
        "allowed 0",
      );
      assertEquals(await permitState(sql, p1), "reserved/NULL");
      assertEquals(await shotCount(sql, U1), 0);

      // Owner releases their own reservation as partial (the edge finalize
      // path once it writes released/partial) — allowed exactly once.
      assertEquals(
        await attempt(
          sql,
          U1,
          `update public.analysis_permits set status = 'released', outcome = 'partial' where id = '${p1}'`,
        ),
        "allowed 1",
      );
      // released/partial is terminal for the client role: every move refused.
      for (const [status, outcome] of [
        ["finalized", "scored"],
        ["finalized", "partial"],
        ["finalized", "low_confidence"],
        ["reserved", null],
        ["released", "expired"],
        ["released", "low_confidence"],
        ["released", "cancelled"],
        ["released", "free_limit_exceeded"],
        ["released", null],
      ] as Array<[string, string | null]>) {
        const o = outcome === null ? "null" : `'${outcome}'`;
        assertEquals(
          await attempt(
            sql,
            U1,
            `update public.analysis_permits set status = '${status}', outcome = ${o} where id = '${p1}'`,
          ),
          "23514:access.permit_transition_rejected",
          `${status}/${outcome}`,
        );
      }
      // Bookkeeping no-op stays allowed; immutable columns stay refused.
      assertEquals(
        await attempt(
          sql,
          U1,
          `update public.analysis_permits set status = 'released', outcome = 'partial' where id = '${p1}'`,
        ),
        "allowed 1",
      );
      assertEquals(
        (
          await attempt(
            sql,
            U1,
            `update public.analysis_permits set created_at = now() - interval '2 days' where id = '${p1}'`,
          )
        ).startsWith("42501"),
        true,
      );
      // A released/partial permit backs nothing.
      assertEquals(
        await syncAs(sql, U1, partialPayload(shotId(), p1)),
        "access.permit_not_reserved",
      );
      assertEquals(
        await syncAs(sql, U1, scoredPayload(shotId(), p1)),
        "access.permit_not_reserved",
      );

      // Client INSERT of a permit in the new state: finalized/partial is not a
      // state; reserved/'partial' violates the shape.
      for (const [status, outcome] of [
        ["finalized", "partial"],
        ["reserved", "partial"],
      ]) {
        assertEquals(
          await attempt(
            sql,
            U1,
            `insert into public.analysis_permits (user_id, idempotency_key, status, outcome)
             values ('${U1}', 'atk5-ins-${status}', '${status}', '${outcome}')`,
          ),
          "23514:access.permit_transition_rejected",
          `insert ${status}/${outcome}`,
        );
      }

      // Direct client INSERT of a partial SHOT row naming a live permit → the
      // shots gate refuses (same as scored / low_confidence, ADV-14).
      const p2 = await reserve(sql, U1, "atk5-b");
      const directCols = `(id, user_id, analysis_permit_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
          overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
          paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)`;
      const directLinked = await attempt(
        sql,
        U1,
        `insert into public.shots ${directCols}
         values ('${shotId()}', '${U1}', '${p2}', 'dink', 'side', now(), 0, 1, 2, null, 0.2, 'partial',
           '1', '1', '1', '1', '1', '1', '1', '1')`,
      );
      assertEquals(directLinked, "42501:access.permit_not_reserved");
      assertEquals(await permitState(sql, p2), "reserved/NULL");
      // Direct client INSERT of an UNLINKED partial row: the table admits it
      // (as it always did for low_confidence); it counts for nothing.
      const orphan = shotId();
      const directOrphan = await attempt(
        sql,
        U1,
        `insert into public.shots ${directCols}
         values ('${orphan}', '${U1}', null, 'dink', 'side', now(), 0, 1, 2, null, 0.2, 'partial',
           '1', '1', '1', '1', '1', '1', '1', '1')`,
      );
      assertEquals(directOrphan, "allowed 1");
      assertEquals(await shotRow(sql, orphan), "partial/NULL/NULL");
      const c = await counts(sql, U1);
      assertEquals(c.lifetime, 0);
      assertEquals(c.scored, 0);
      // Client UPDATE of the orphan into a rating: shots have no client UPDATE.
      assertEquals(
        (
          await attempt(
            sql,
            U1,
            `update public.shots set result_kind = 'scored', overall_score = 9.9 where id = '${orphan}'`,
          )
        ).startsWith("42501"),
        true,
      );
      assertEquals(await shotRow(sql, orphan), "partial/NULL/NULL");
      // Rank / progress readers ignore the partial rows entirely.
      const readers = await inTx(
        sql,
        U1,
        async (tx) =>
          await tx.unsafe(
            `select (select count(*) from public.progress_daily)::int as daily,
                    (select count(*) from public.player_technique_rating)::int as rating`,
          ),
      );
      assertEquals([Number(readers[0].daily), Number(readers[0].rating)], [0, 0]);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "W01-ATK-6: free-rating conservation — partials at the free limit, premium, access_state(), reserve_analysis_permit(), late-linked identity inheritance and the ledger floor never count a partial",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 6 });
    try {
      await resetUsers(sql, true);
      // Spend both free ratings.
      const a = await reserve(sql, U1, "atk6-s1");
      const b = await reserve(sql, U1, "atk6-s2");
      assertEquals(await syncAs(sql, U1, scoredPayload(shotId(), a)), "accepted");
      assertEquals(await syncAs(sql, U1, scoredPayload(shotId(), b)), "accepted");
      assertEquals((await counts(sql, U1)).lifetime, 2);
      assertEquals(await ledger(sql, "google", "google-sub-w01-u1"), 2);
      // No further reservation for a free account…
      assertEquals((await reserveVerdict(sql, U1, "atk6-third")).result, "access.paywall_required");

      // …but permits issued earlier (and a swept one) still settle a partial
      // for free: no charge, no paywall, no ledger movement.
      // Seed two extra reservations as the owner (what older builds could
      // hold), one of them already swept.
      const extra1 = "0000000a-4b78-4000-8000-2000000000e1";
      const extra2 = "0000000a-4b78-4000-8000-2000000000e2";
      await sql.unsafe(
        `insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome, created_at) values
           ('${extra1}', '${U1}', 'atk6-extra1', 'reserved', null, now()),
           ('${extra2}', '${U1}', 'atk6-extra2', 'reserved', null, now() - interval '25 hours')`,
      );
      assertEquals(Number((await sql.unsafe(SWEEP_SQL)).count), 1);
      assertEquals(await permitState(sql, extra2), "released/expired");
      const s3 = shotId();
      const s4 = shotId();
      assertEquals(await syncAs(sql, U1, partialPayload(s3, extra1)), "accepted");
      assertEquals(await syncAs(sql, U1, partialPayload(s4, extra2)), "accepted");
      assertEquals(await permitState(sql, extra1), "released/partial");
      assertEquals(await permitState(sql, extra2), "released/partial");
      let c = await counts(sql, U1);
      assertEquals([c.lifetime, c.scored, c.reserved], [2, 2, 0]);
      assertEquals(await ledger(sql, "google", "google-sub-w01-u1"), 2);
      // A scored sync on yet another extra permit is still the paywall.
      const extra3 = "0000000a-4b78-4000-8000-2000000000e3";
      await sql.unsafe(
        `insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome) values
           ('${extra3}', '${U1}', 'atk6-extra3', 'reserved', null)`,
      );
      assertEquals(
        await syncAs(sql, U1, scoredPayload(shotId(), extra3)),
        "access.paywall_required",
      );
      assertEquals(await permitState(sql, extra3), "released/free_limit_exceeded");
      assertEquals(await shotCount(sql, U1), 4);

      // Late-linked identity: an identity linked AFTER 2 scored + 2 partial
      // inherits exactly 2.
      await sql.unsafe(
        `insert into auth.identities (provider, provider_id, user_id, identity_data)
         values ('apple', 'apple-sub-w01-u1-late', '${U1}', '{"sub":"apple-sub-w01-u1-late"}')`,
      );
      assertEquals(await ledger(sql, "apple", "apple-sub-w01-u1-late"), 2);

      // Anti-reset: delete the account, re-create it under the same Google
      // identity → still 2 spent, a third scored is refused, a partial is fine.
      await sql.unsafe(`delete from auth.users where id = '${U1}'`);
      await sql.unsafe(
        `insert into auth.users (id, email, raw_app_meta_data) values ('${U1}', '${U1}@example.com', '{"provider":"google"}')`,
      );
      await sql.unsafe(
        `insert into auth.identities (provider, provider_id, user_id, identity_data)
         values ('google', 'google-sub-w01-u1', '${U1}', '{"sub":"google-sub-w01-u1"}')`,
      );
      assertEquals(await shotCount(sql, U1), 0);
      c = await counts(sql, U1);
      assertEquals([c.lifetime, c.scored], [2, 2]);
      assertEquals(
        (await reserveVerdict(sql, U1, "atk6-after-delete")).result,
        "access.paywall_required",
      );
      const extra4 = "0000000a-4b78-4000-8000-2000000000e4";
      await sql.unsafe(
        `insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome) values
           ('${extra4}', '${U1}', 'atk6-extra4', 'reserved', null)`,
      );
      assertEquals(await syncAs(sql, U1, partialPayload(shotId(), extra4)), "accepted");
      assertEquals(await permitState(sql, extra4), "released/partial");
      assertEquals((await counts(sql, U1)).lifetime, 2);
      assertEquals(await ledger(sql, "google", "google-sub-w01-u1"), 2);

      // Premium: partial accepted, released (not finalized), never counted.
      const pp = await reserve(sql, PREMIUM, "atk6-premium");
      assertEquals(await syncAs(sql, PREMIUM, partialPayload(shotId(), pp)), "accepted");
      assertEquals(await permitState(sql, pp), "released/partial");
      c = await counts(sql, PREMIUM);
      assertEquals([c.lifetime, c.premium], [0, true]);
      assertEquals(await ledger(sql, "google", "google-sub-w01-premium"), -1);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "W01-ATK-7: crash between steps — a partial whose detail write fails, and a backend killed mid-sync → nothing persists, the permit still backs a clean retry",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 6 });
    try {
      await resetUsers(sql);
      const permit = await reserve(sql, U1, "atk7");
      // The shot row inserts, then the checkpoint detail violates its check
      // constraint → the atomic block rolls the shot back too.
      const bad = shotId();
      const verdict = await syncAs(
        sql,
        U1,
        partialPayload(bad, permit, {
          phases: [
            { key: "prepare", startMs: 0, representativeMs: 20, endMs: 50, confidence: 0.5 },
          ],
          checkpoints: [
            {
              key: "elbow",
              score: null,
              confidence: 0.5,
              band: "purple",
              direction: "n/a",
              severity: 0,
              applicable: false,
            },
          ],
        }),
      );
      assertEquals(verdict, "shot.write_failed:23514");
      assertEquals(await shotRow(sql, bad), "MISSING");
      assertEquals(await detailCount(sql, bad), 0);
      assertEquals(await permitState(sql, permit), "reserved/NULL");

      // Process death mid-transaction: the sync's backend is terminated while
      // its transaction is still open (its own connection pool, so the kill
      // cannot take a healthy connection down with it).
      const killed = shotId();
      const g = gate();
      const pidBox: { pid?: number } = {};
      const doomed = postgres(PG_URL, { max: 1 });
      let outcome: string;
      try {
        const dying = inTx(
          doomed,
          U1,
          async (tx) => {
            pidBox.pid = Number((await tx.unsafe(`select pg_backend_pid() as pid`))[0].pid);
            return await sync(tx, partialPayload(killed, permit));
          },
          g.wait,
        ).then(
          (v) => `committed:${v}`,
          (e: unknown) => `died:${pgError(e).code}`,
        );
        await sleep(400);
        assert(pidBox.pid !== undefined, "backend pid captured");
        // The shot is written but uncommitted: invisible to everyone else.
        assertEquals(await shotRow(sql, killed), "MISSING");
        assertEquals(
          Boolean((await sql.unsafe(`select pg_terminate_backend(${pidBox.pid}) as t`))[0].t),
          true,
        );
        g.open();
        outcome = await within(dying, 15_000, "ATK-7 killed backend");
      } finally {
        await doomed.end({ timeout: 2 });
      }
      assert(outcome.startsWith("died:"), `expected the killed tx to fail, got ${outcome}`);
      assertEquals(await shotRow(sql, killed), "MISSING");
      assertEquals(await permitState(sql, permit), "reserved/NULL");
      assertEquals(await shotCount(sql, U1), 0);

      // Clean retry after both failures.
      const ok = shotId();
      assertEquals(
        await syncAs(
          sql,
          U1,
          partialPayload(ok, permit, {
            phases: [
              { key: "prepare", startMs: 0, representativeMs: 20, endMs: 50, confidence: 0.5 },
            ],
            checkpoints: [
              {
                key: "elbow",
                score: null,
                confidence: 0.5,
                band: "unscored",
                direction: "n/a",
                severity: 0,
                applicable: false,
              },
            ],
          }),
        ),
        "accepted",
      );
      assertEquals(await shotRow(sql, ok), `partial/NULL/${permit}`);
      assertEquals(await detailCount(sql, ok), 2);
      assertEquals(await permitState(sql, permit), "released/partial");
      assertEquals((await counts(sql, U1)).lifetime, 0);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "W01-ATK-8: the shipping finalize route's write shape (status='finalized', outcome=<releasable>, eq status='reserved') with outcome 'partial' is refused 23514 — only released/partial is admissible",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await resetUsers(sql);
      const p1 = await reserve(sql, U1, "atk8-a");
      // index.ts finalizeAnalysisPermitRoute: .update({ status: "finalized", outcome })
      //   .eq("id", permitId).eq("user_id", authed.id).eq("status", "reserved")
      const routeShape = (outcome: string, permit: string) =>
        `update public.analysis_permits set status = 'finalized', outcome = '${outcome}'
         where id = '${permit}' and user_id = '${U1}' and status = 'reserved'`;
      // Today's releasable vocabulary still lands as finalized/<outcome>.
      assertEquals(await attempt(sql, U1, routeShape("low_confidence", p1)), "allowed 1");
      assertEquals(await permitState(sql, p1), "finalized/low_confidence");
      // The identical write with the new word is refused by the guard — the
      // route would surface 409 access.permit_transition_rejected and the
      // permit would stay reserved (occupying an allowance slot until swept).
      const p2 = await reserve(sql, U1, "atk8-b");
      assertEquals(
        await attempt(sql, U1, routeShape("partial", p2)),
        "23514:access.permit_transition_rejected",
      );
      assertEquals(await permitState(sql, p2), "reserved/NULL");
      // The admissible spelling for the same intent.
      assertEquals(
        await attempt(
          sql,
          U1,
          `update public.analysis_permits set status = 'released', outcome = 'partial'
           where id = '${p2}' and user_id = '${U1}' and status = 'reserved'`,
        ),
        "allowed 1",
      );
      assertEquals(await permitState(sql, p2), "released/partial");
      // finalized/low_confidence (today's route result) is NOT backing and
      // cannot be moved to released/partial later either.
      assertEquals(
        await syncAs(sql, U1, partialPayload(shotId(), p1)),
        "access.permit_not_reserved",
      );
      assertEquals(
        await attempt(
          sql,
          U1,
          `update public.analysis_permits set status = 'released', outcome = 'partial' where id = '${p1}'`,
        ),
        "23514:access.permit_transition_rejected",
      );
      assertEquals((await counts(sql, U1)).lifetime, 0);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "W01-ATK-9: tombstone + idempotency key — after the owner deletes a released/partial permit the id is consumed, byte-identical restore only, and the same key is a NEW reservation",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await resetUsers(sql);
      const key = "atk9-key";
      const p1 = await reserve(sql, U1, key);
      const s1 = shotId();
      assertEquals(await syncAs(sql, U1, partialPayload(s1, p1)), "accepted");
      // Idempotent replay of the same key returns the settled permit as-is.
      let v = await reserveVerdict(sql, U1, key);
      assertEquals(
        [v.result, v.permitId, v.status, v.outcome],
        ["accepted", p1, "released", "partial"],
      );

      // Owner deletes the linked released/partial permit (tombstone).
      const del = await sql.unsafe(`delete from public.analysis_permits where id = '${p1}'`);
      assertEquals(del.count, 1);
      assertEquals(await permitState(sql, p1), "MISSING");
      assertEquals(await shotRow(sql, s1), `partial/NULL/${p1}`);
      // Client re-INSERT of the id as reserved / as released/partial under
      // another key → refused (resurrection guard); byte-identical restore by
      // the client is refused too (the client cannot name an id).
      for (const [status, outcome, k] of [
        ["reserved", null, "atk9-resurrect"],
        ["released", "partial", "atk9-resurrect-2"],
        ["released", "partial", key],
      ] as Array<[string, string | null, string]>) {
        const o = outcome === null ? "null" : `'${outcome}'`;
        const r = await attempt(
          sql,
          U1,
          `insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome)
           values ('${p1}', '${U1}', '${k}', '${status}', ${o})`,
        );
        assertNotEquals(r.split(" ")[0], "allowed", `${status}/${outcome}/${k}: ${r}`);
      }
      assertEquals(await permitState(sql, p1), "MISSING");
      // The tombstoned id backs nothing.
      assertEquals(
        await syncAs(sql, U1, partialPayload(shotId(), p1)),
        "access.permit_not_reserved",
      );
      assertEquals(
        await syncAs(sql, U1, scoredPayload(shotId(), p1)),
        "access.permit_not_reserved",
      );

      // Owner restore: only the byte-identical row comes back (same key, same
      // settled state); a different key or a reopened reservation is refused.
      const ownerTry = async (
        k: string,
        status: string,
        outcome: string | null,
      ): Promise<string> => {
        try {
          const o = outcome === null ? "null" : `'${outcome}'`;
          const n = (
            await sql.unsafe(
              `insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome)
             values ('${p1}', '${U1}', '${k}', '${status}', ${o})`,
            )
          ).count;
          return `allowed ${n}`;
        } catch (e) {
          return pgError(e).code;
        }
      };
      assertEquals(await ownerTry("atk9-other-key", "released", "partial"), "23514");
      assertEquals(await ownerTry(key, "reserved", null), "23514");
      assertEquals(await ownerTry(key, "released", "partial"), "allowed 1");
      assertEquals(await permitState(sql, p1), "released/partial");
      assertEquals(
        await syncAs(sql, U1, partialPayload(shotId(), p1)),
        "access.permit_not_reserved",
      );
      // Replay of the key still returns the restored settled permit.
      v = await reserveVerdict(sql, U1, key);
      assertEquals(
        [v.result, v.permitId, v.status, v.outcome],
        ["accepted", p1, "released", "partial"],
      );

      // Delete again; with the row gone the same idempotency key is a NEW
      // reservation (a different id): the key's history went with the row.
      // Recorded, not asserted as a break — the fresh permit is issued under
      // the normal allowance and the tombstoned id stays consumed.
      assertEquals(
        (await sql.unsafe(`delete from public.analysis_permits where id = '${p1}'`)).count,
        1,
      );
      v = await reserveVerdict(sql, U1, key);
      assertEquals(v.result, "accepted");
      assertNotEquals(v.permitId, p1);
      assertEquals([v.status, v.outcome], ["reserved", null]);
      assertEquals((await counts(sql, U1)).reserved, 1);
      assertEquals(
        await syncAs(sql, U1, partialPayload(shotId(), p1)),
        "access.permit_not_reserved",
      );
      assertEquals(await shotCount(sql, U1), 1);
      assertEquals((await counts(sql, U1)).lifetime, 0);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "W01-ATK-10: clocks — far-future / far-past permit created_at and shot capturedAt, capturedAt before the permit → the partial path is age-agnostic and never charges",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await resetUsers(sql);
      const future = await reserve(sql, U1, "atk10-future");
      await setCreatedAt(sql, future, "now() + interval '400 days'");
      const ancient = await reserve(sql, U1, "atk10-ancient");
      await setCreatedAt(sql, ancient, "timestamptz '1970-01-01T00:00:00Z'");
      // A far-future reservation counts as reserved (created_at > now()-24h)
      // and occupies an allowance slot until settled.
      assertEquals((await counts(sql, U1)).reserved, 1);
      assertEquals(Number((await sql.unsafe(SWEEP_SQL)).count), 1);
      assertEquals(await permitState(sql, ancient), "released/expired");

      // Out-of-bounds shot clocks (shots_captured_at_bounds: 2000 ≤ t < 2100)
      // and malformed clocks are refused with the permit intact.
      for (const [permit, capturedAt] of [
        [future, "2999-12-31T23:59:59.000Z"],
        [ancient, "1970-01-01T00:00:00.000Z"],
        [future, ""],
        [future, "not-a-date"],
        [future, "2026-13-45T00:00:00Z"],
        [future, null],
      ] as Array<[string, string | null]>) {
        const id = shotId();
        const verdict = await syncAs(sql, U1, partialPayload(id, permit, { capturedAt }));
        assert(verdict.startsWith("shot.write_failed:"), `${capturedAt}: ${verdict}`);
        assertEquals(await shotRow(sql, id), "MISSING");
      }
      assertEquals(await permitState(sql, future), "reserved/NULL");
      assertEquals(await permitState(sql, ancient), "released/expired");
      // In-bounds clocks far from the permit's own clock are accepted on both
      // the far-future reservation and the swept 1970 one.
      const f = shotId();
      assertEquals(
        await syncAs(
          sql,
          U1,
          partialPayload(f, future, { capturedAt: "2099-12-31T23:59:59.000Z" }),
        ),
        "accepted",
      );
      assertEquals(await permitState(sql, future), "released/partial");
      const a = shotId();
      assertEquals(
        await syncAs(
          sql,
          U1,
          partialPayload(a, ancient, { capturedAt: "2000-01-01T00:00:00.000Z" }),
        ),
        "accepted",
      );
      assertEquals(await permitState(sql, ancient), "released/partial");
      const p3 = await reserve(sql, U1, "atk10-live");
      assertEquals(await permitState(sql, p3), "reserved/NULL");
      const c = await counts(sql, U1);
      assertEquals([c.lifetime, c.scored, c.reserved], [0, 0, 1]);
      assertEquals(await shotCount(sql, U1), 2);
    } finally {
      await sql.end();
    }
  },
});
