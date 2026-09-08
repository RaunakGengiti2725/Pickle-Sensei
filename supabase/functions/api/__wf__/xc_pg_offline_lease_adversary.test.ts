/**
 * INT-offline-lease adversary — REAL Postgres attacks on the allocation /
 * consumption accounting the integration head actually ships for offline
 * ratings (analysis permits reserved online, executed on device, consumed by
 * a possibly days-late `apply_synced_shot`). Attacked head:
 * 30a4065036a917514fb4984fde73f87867f38619.
 *
 * Every scenario drives the real RPCs / triggers on a disposable postgres:16
 * with shim_auth.sql + every migration applied (./xc_pg_up.sh), as role
 * `authenticated` with a JWT sub. Nothing is mocked. Production is never
 * touched.
 *
 *   ./xc_pg_up.sh
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     npx --yes deno@2.5.6 test -A --no-check --config deno.json xc_pg_offline_lease_adversary.test.ts
 *
 * Without XC_PG_URL (alias PICKLE_AUDIT_PG_URL) every test is `ignore`d — an
 * ignored run is NOT a pass.
 *
 * Product invariants under attack (coordinator's wording):
 *   * "offline allocation != consumption and a disconnected device's
 *      allocation is never auto-reclaimed"
 *   * "Pro offline leases <= 7 days and <= verified entitlement expiry"
 *   * "partial/failed/withheld/replayed results never consume a credit"
 *   * "preserve ... cross-account isolation"
 *
 * Attacks (each test names the invariant it asserts; a FAILING test is a
 * reproduced break, a passing test is evidence the invariant holds):
 *   OL-PG-1  disconnected-device reclaim: a reserved free allocation older
 *            than 24h stops counting, a second and THIRD reservation are
 *            handed out, the two fresh ratings consume both lifetime slots
 *            and the disconnected device's late sync is refused.
 *   OL-PG-2  conservation under the same reclaim: whichever order the three
 *            permits sync in, never more than two free scored rows exist.
 *   OL-PG-3  the pg_cron sweep only re-labels (released/expired), never
 *            deletes, and a swept permit still backs its late sync while an
 *            allowance slot remains.
 *   OL-PG-4  Pro lease vs verified entitlement expiry: a permit reserved
 *            while premium (entitlement expiring within the hour) is refused
 *            at a delayed sync after the entitlement lapsed — reconciliation
 *            uses upload-time entitlement, not execution-time authorization.
 *   OL-PG-5  account switch / cross-owner replay: another account cannot
 *            consume, replay or free-ride on the first account's permit or
 *            shot id.
 *   OL-PG-6  repeated reservation with the same idempotency key after the
 *            sweep returns the swept (non-reserved) permit, never a fresh one
 *            and never a second slot.
 *   OL-PG-7  double action: the same late shot synced twice concurrently
 *            against a swept permit yields one row and one consumed permit.
 *   OL-PG-8  abstentions never consume: a swept permit the client settles
 *            as a late abstention (released/expired → released/low_confidence,
 *            the documented late-settlement move) can back no scored row
 *            afterwards and cannot be re-labelled into a rating; a fresh
 *            abstention release likewise backs nothing and spends no slot.
 */
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

const U1 = "0000000b-01ea-4000-8000-000000000001";
const U2 = "0000000b-01ea-4000-8000-000000000002";
const PRO = "0000000b-01ea-4000-8000-000000000003";

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

function shotPayload(
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
    overallScore: 7,
    confidence: 0.9,
    resultKind: "scored",
    phases: [],
    checkpoints: [],
    versionVector: VERSION_VECTOR,
    ...overrides,
  };
}

let shotSeq = 0;
function shotId(): string {
  shotSeq += 1;
  return `0000000b-01ea-4000-8000-2${String(shotSeq).padStart(11, "0")}`;
}

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`select set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', public.get_api_request_key())::text, true)`);
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

/** Owner-role reset: the seeded ids repeat across runs against the same
 * disposable DB. The user cascade removes permits/shots/ledger owners. */
async function resetUsers(sql: Sql): Promise<void> {
  for (const id of [U1, U2, PRO]) {
    await sql.unsafe(`delete from auth.users where id = '${id}'`);
    await sql.unsafe(
      `insert into auth.users (id, email, raw_app_meta_data) values ('${id}', '${id}@example.com', '{"provider":"google"}')`,
    );
  }
}

function inTx<T>(sql: Sql, userId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    if (userId) await asUser(tx as unknown as Tx, userId);
    return await fn(tx as unknown as Tx);
  }) as Promise<T>;
}

interface ReserveRow {
  result: string;
  permit_id: string | null;
  permit_status: string | null;
  permit_outcome: string | null;
}

async function reserveRaw(sql: Sql, userId: string, key: string): Promise<ReserveRow> {
  const rows = await inTx(
    sql,
    userId,
    async (tx) =>
      await tx.unsafe(
        `select x.result, x.permit_id::text as permit_id, x.permit_status, x.permit_outcome
         from public.reserve_analysis_permit('${key}') x`,
      ),
  );
  return rows[0] as unknown as ReserveRow;
}

async function reserve(sql: Sql, userId: string, key: string): Promise<string> {
  const row = await reserveRaw(sql, userId, key);
  assertEquals(row.result, "accepted", `reserve ${key}`);
  return row.permit_id as string;
}

async function sync(tx: Tx, payload: Record<string, unknown>): Promise<string> {
  // postgres.js serializes the object itself once the server reports the
  // parameter as jsonb (the pattern the existing lifecycle adversary uses).
  const rows = await tx.unsafe(`select public.apply_synced_shot($1::jsonb) as r`, [
    payload as unknown as string,
  ]);
  return String(rows[0].r);
}

async function syncAs(sql: Sql, userId: string, payload: Record<string, unknown>): Promise<string> {
  return await inTx(sql, userId, (tx) => sync(tx, payload));
}

async function permitState(sql: Sql, permitId: string): Promise<string> {
  const rows = await sql.unsafe(
    `select status || '/' || coalesce(outcome, 'NULL') as s from public.analysis_permits where id = '${permitId}'`,
  );
  return rows.length === 0 ? "MISSING" : String(rows[0].s);
}

async function scoredCount(sql: Sql, userId: string): Promise<number> {
  const rows = await sql.unsafe(
    `select count(*)::int as n from public.shots where user_id = '${userId}' and result_kind = 'scored'`,
  );
  return Number(rows[0].n);
}

async function accessState(
  sql: Sql,
  userId: string,
): Promise<{ premium: boolean; scored: number; reserved: number }> {
  const rows = await inTx(
    sql,
    userId,
    async (tx) =>
      await tx.unsafe(`select premium, scored_count, reserved_count from public.access_state()`),
  );
  return {
    premium: Boolean(rows[0].premium),
    scored: Number(rows[0].scored_count),
    reserved: Number(rows[0].reserved_count),
  };
}

/** The device went dark right after reserving: age the reservation past the
 * 24h reservation-accounting horizon (owner role; clients hold no UPDATE on
 * created_at). */
async function backdate(sql: Sql, permitId: string, hours = 25): Promise<void> {
  await sql.unsafe(
    `with stale as (
       delete from public.analysis_permits where id = '${permitId}' and status = 'reserved'
       returning id, user_id, idempotency_key, status, outcome
     )
     insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome, created_at)
     select id, user_id, idempotency_key, status, outcome, now() - interval '${hours} hours' from stale`,
  );
}

/** The pg_cron expire-stale-analysis-permits statement (20260831000000),
 * scoped to this file's users. */
async function sweep(sql: Sql): Promise<number> {
  const rows = await sql.unsafe(
    `update public.analysis_permits set status = 'released', outcome = 'expired'
     where status = 'reserved' and created_at < now() - interval '24 hours'
       and user_id in ('${U1}', '${U2}', '${PRO}') returning id`,
  );
  return rows.length;
}

function pgError(e: unknown): string {
  const err = e as { code?: string; hint?: string; message?: string };
  return `${err.code ?? "?"}:${err.hint ?? err.message ?? ""}`;
}

async function attempt(sql: Sql, userId: string, stmt: string): Promise<string> {
  try {
    const n = await inTx(sql, userId, async (tx) => (await tx.unsafe(stmt)).count);
    return `allowed ${n}`;
  } catch (e) {
    return pgError(e);
  }
}

Deno.test({
  name:
    "OL-PG-1: a disconnected device's reserved free allocation is never auto-reclaimed — after one >24h reservation only ONE more may be handed out, and its late scored sync must still be honoured",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await resetUsers(sql);
      const a = await reserve(sql, U1, "ol1-device-offline");
      await backdate(sql, a);
      const before = await accessState(sql, U1);
      const b = await reserveRaw(sql, U1, "ol1-second");
      const c = await reserveRaw(sql, U1, "ol1-third");
      const observed: Record<string, unknown> = {
        accessStateWhileDeviceHoldsA: before,
        secondReservation: b.result,
        thirdReservation: c.result,
        aState: await permitState(sql, a),
      };
      // Consume the fresh reservations first (the connected path), then the
      // disconnected device comes back with its already-executed rating.
      if (b.permit_id) observed.syncB = await syncAs(sql, U1, shotPayload(shotId(), b.permit_id));
      if (c.permit_id) observed.syncC = await syncAs(sql, U1, shotPayload(shotId(), c.permit_id));
      observed.lateSyncA = await syncAs(sql, U1, shotPayload(shotId(), a));
      observed.aStateAfter = await permitState(sql, a);
      observed.scoredRows = await scoredCount(sql, U1);
      const detail = JSON.stringify(observed);
      // The invariant: A is still allocated (reserved_count counts it), so
      // only one further slot exists, and A's late sync is accepted.
      assertEquals(before.reserved, 1, `A must still count as allocated: ${detail}`);
      assertEquals(b.result, "accepted", detail);
      assertEquals(c.result, "access.paywall_required", `third slot handed out: ${detail}`);
      assertEquals(
        observed.lateSyncA,
        "accepted",
        `disconnected device's rating refused: ${detail}`,
      );
      assertEquals(await permitState(sql, a), "finalized/scored", detail);
      assertEquals(await scoredCount(sql, U1), 2, detail);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "OL-PG-2: conservation under reclaim — with three outstanding permits (one stale) no sync order ever records a third free scored row, and every refused permit ends released/free_limit_exceeded",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await resetUsers(sql);
      const a = await reserve(sql, U1, "ol2-a");
      await backdate(sql, a);
      const b = await reserve(sql, U1, "ol2-b");
      const c = await reserve(sql, U1, "ol2-c");
      const results = [
        await syncAs(sql, U1, shotPayload(shotId(), a)),
        await syncAs(sql, U1, shotPayload(shotId(), b)),
        await syncAs(sql, U1, shotPayload(shotId(), c)),
      ];
      assertEquals(results, ["accepted", "accepted", "access.paywall_required"]);
      assertEquals(await scoredCount(sql, U1), 2);
      assertEquals(await permitState(sql, a), "finalized/scored");
      assertEquals(await permitState(sql, b), "finalized/scored");
      assertEquals(await permitState(sql, c), "released/free_limit_exceeded");
      // A fourth reservation is refused: both slots are spent and no reserved
      // permit is left to reclaim.
      assertEquals((await reserveRaw(sql, U1, "ol2-d")).result, "access.paywall_required");
      const state = await accessState(sql, U1);
      assertEquals(state.scored, 2);
      assertEquals(state.reserved, 0);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "OL-PG-3: the sweep re-labels a stale reservation released/expired (never deletes) and the swept permit still backs its late sync while an allowance slot remains",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await resetUsers(sql);
      const a = await reserve(sql, U1, "ol3-a");
      await backdate(sql, a);
      assertEquals(await sweep(sql), 1);
      assertEquals(await permitState(sql, a), "released/expired");
      // Sweeping again is a no-op; the row is still there.
      assertEquals(await sweep(sql), 0);
      assertEquals(await syncAs(sql, U1, shotPayload(shotId(), a)), "accepted");
      assertEquals(await permitState(sql, a), "finalized/scored");
      assertEquals(await scoredCount(sql, U1), 1);
      // A second sync of a DIFFERENT shot on the consumed permit is refused.
      assertEquals(await syncAs(sql, U1, shotPayload(shotId(), a)), "access.permit_not_reserved");
      assertEquals(await scoredCount(sql, U1), 1);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "OL-PG-4: a permit reserved under a verified Pro entitlement is authorization at execution — its delayed sync after the entitlement lapsed must not be refused as a free-limit breach",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await resetUsers(sql);
      await sql.unsafe(
        `insert into public.billing_entitlements (user_id, premium, product_key, expires_at)
         values ('${PRO}', true, 'pickle_sensei_pro_monthly', now() + interval '1 hour')`,
      );
      // A real Pro member: both lifetime free slots long spent.
      for (const key of ["ol4-spent-1", "ol4-spent-2"]) {
        const p = await reserve(sql, PRO, key);
        assertEquals(await syncAs(sql, PRO, shotPayload(shotId(), p)), "accepted");
      }
      const stateWhilePro = await accessState(sql, PRO);
      assertEquals(stateWhilePro, { premium: true, scored: 2, reserved: 0 });
      // Reserved with 1h of verified entitlement left; the advertised permit
      // lifetime (created_at + 24h, edge permitView) exceeds that expiry.
      const lease = await reserve(sql, PRO, "ol4-last-day");
      const leaseRow = await sql.unsafe(
        `select (created_at + interval '24 hours' > b.expires_at) as lease_outlives_entitlement
         from public.analysis_permits p join public.billing_entitlements b on b.user_id = p.user_id
         where p.id = '${lease}'`,
      );
      // The device scores on-device, then the outbox drains after the store
      // entitlement has lapsed (RevenueCat verdict re-verified by the server).
      await sql.unsafe(
        `update public.billing_entitlements set expires_at = now() - interval '1 minute', verified_at = now()
         where user_id = '${PRO}'`,
      );
      const stateAfterLapse = await accessState(sql, PRO);
      const late = await syncAs(sql, PRO, shotPayload(shotId(), lease));
      const observed = JSON.stringify({
        leaseOutlivesEntitlement: leaseRow[0].lease_outlives_entitlement,
        stateAfterLapse,
        lateSync: late,
        permit: await permitState(sql, lease),
        scoredRows: await scoredCount(sql, PRO),
      });
      assertEquals(stateAfterLapse.premium, false, observed);
      assertEquals(
        late,
        "accepted",
        `execution-time Pro authorization refused at upload: ${observed}`,
      );
      assertEquals(await permitState(sql, lease), "finalized/scored", observed);
      assertEquals(await scoredCount(sql, PRO), 3, observed);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "OL-PG-5: account switch — another account cannot consume, replay or free-ride on the first account's permit or shot id, and the victim's allocation is untouched",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await resetUsers(sql);
      const p1 = await reserve(sql, U1, "ol5-u1");
      await backdate(sql, p1);
      const victimShot = shotId();
      // U2 (the account the device switched to) tries U1's stale permit.
      assertEquals(await syncAs(sql, U2, shotPayload(shotId(), p1)), "access.permit_not_found");
      // U1's own late sync still lands.
      assertEquals(await syncAs(sql, U1, shotPayload(victimShot, p1)), "accepted");
      // U2 replays U1's shot id with U2's own permit: no takeover, no second
      // row, U2's permit is not consumed by a foreign id.
      const p2 = await reserve(sql, U2, "ol5-u2");
      const replay = await syncAs(sql, U2, shotPayload(victimShot, p2));
      assert(
        replay === "shot.id_conflict" || replay.startsWith("shot.write_failed"),
        `foreign shot id replay verdict: ${replay}`,
      );
      assertEquals(await permitState(sql, p2), "reserved/NULL");
      const owner = await sql.unsafe(
        `select user_id::text as u from public.shots where id = '${victimShot}'`,
      );
      assertEquals(owner.map((r) => r.u), [U1]);
      assertEquals(await scoredCount(sql, U1), 1);
      assertEquals(await scoredCount(sql, U2), 0);
      // U2 cannot finalize U1's permit either.
      assertEquals(
        await attempt(
          sql,
          U2,
          `update public.analysis_permits set status = 'released', outcome = 'cancelled' where id = '${p1}'`,
        ),
        "allowed 0",
      );
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "OL-PG-6: re-reserving with the same idempotency key after the sweep returns the swept permit (released/expired), never a fresh reserved one and never a second slot",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await resetUsers(sql);
      const a = await reserve(sql, U1, "ol6-key");
      await backdate(sql, a);
      assertEquals(await sweep(sql), 1);
      const replay = await reserveRaw(sql, U1, "ol6-key");
      assertEquals(replay.result, "accepted");
      assertEquals(replay.permit_id, a);
      assertEquals(`${replay.permit_status}/${replay.permit_outcome}`, "released/expired");
      const rows = await sql.unsafe(
        `select count(*)::int as n from public.analysis_permits where user_id = '${U1}'`,
      );
      assertEquals(Number(rows[0].n), 1);
      // The swept permit is still the one that backs the device's late result.
      assertEquals(await syncAs(sql, U1, shotPayload(shotId(), a)), "accepted");
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "OL-PG-7: double action — the same late shot synced twice concurrently against a swept permit yields one row and one consumed permit",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 6 });
    try {
      await resetUsers(sql);
      const a = await reserve(sql, U1, "ol7-a");
      await backdate(sql, a);
      assertEquals(await sweep(sql), 1);
      const id = shotId();
      const results = await Promise.all([
        syncAs(sql, U1, shotPayload(id, a)),
        syncAs(sql, U1, shotPayload(id, a)),
        syncAs(sql, U1, shotPayload(id, a, { overallScore: 9.9 })),
      ]);
      assertEquals(results, ["accepted", "accepted", "accepted"]);
      const rows = await sql.unsafe(
        `select overall_score::float8 as s from public.shots where id = '${id}'`,
      );
      assertEquals(rows.length, 1);
      assertEquals(Number(rows[0].s), 7);
      assertEquals(await permitState(sql, a), "finalized/scored");
      assertEquals(await scoredCount(sql, U1), 1);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "OL-PG-8: abstentions never consume — a swept permit settled late as low_confidence backs no scored row and cannot be re-labelled into a rating; a fresh abstention release backs nothing and spends no slot",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await resetUsers(sql);
      const swept = await reserve(sql, U1, "ol8-swept");
      await backdate(sql, swept);
      assertEquals(await sweep(sql), 1);
      // Documented late settlement (guard_analysis_permit_lifecycle):
      // released/expired → released/low_confidence is allowed for the client.
      assertEquals(
        await attempt(
          sql,
          U1,
          `update public.analysis_permits set status = 'released', outcome = 'low_confidence' where id = '${swept}'`,
        ),
        "allowed 1",
      );
      assertEquals(await permitState(sql, swept), "released/low_confidence");
      // …and from there nothing revives it: no scored sync, no re-label.
      assertEquals(
        await syncAs(sql, U1, shotPayload(shotId(), swept)),
        "access.permit_not_reserved",
      );
      for (
        const to of [
          "status = 'reserved', outcome = null",
          "status = 'finalized', outcome = 'scored'",
          "status = 'released', outcome = 'expired'",
        ]
      ) {
        const verdict = await attempt(
          sql,
          U1,
          `update public.analysis_permits set ${to} where id = '${swept}'`,
        );
        assert(verdict.startsWith("23514:"), `${to}: ${verdict}`);
      }
      assertEquals(await permitState(sql, swept), "released/low_confidence");

      const fresh = await reserve(sql, U1, "ol8-fresh");
      assertEquals(
        await attempt(
          sql,
          U1,
          `update public.analysis_permits set status = 'released', outcome = 'low_confidence' where id = '${fresh}'`,
        ),
        "allowed 1",
      );
      assertEquals(await permitState(sql, fresh), "released/low_confidence");
      assertEquals(
        await syncAs(sql, U1, shotPayload(shotId(), fresh)),
        "access.permit_not_reserved",
      );
      assertEquals(await scoredCount(sql, U1), 0);
      // Neither the abstention nor the sweep spent a lifetime slot.
      const state = await accessState(sql, U1);
      assertEquals(state.scored, 0);
      assertEquals(state.reserved, 0);
    } finally {
      await sql.end();
    }
  },
});
