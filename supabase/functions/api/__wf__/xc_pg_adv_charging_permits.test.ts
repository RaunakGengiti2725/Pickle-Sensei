/**
 * INT-charging-permits adversary — REAL Postgres attacks on the permit /
 * charge boundary at HEAD 30a4065036a917514fb4984fde73f87867f38619.
 *
 * Same harness as xc_pg_permit_terminal_adversary.test.ts: a disposable
 * postgres:16 with shim_auth.sql + every migration applied (./xc_pg_up.sh),
 * every client statement as role `authenticated` with a JWT sub and the API
 * request key, nothing mocked.
 *
 *   ./xc_pg_up.sh
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     deno test -A --no-check --config deno.json xc_pg_adv_charging_permits.test.ts
 *
 * Without XC_PG_URL (alias PICKLE_AUDIT_PG_URL) every test is `ignore`d — an
 * ignored run is NOT a pass.
 *
 * A test that PASSES documents a boundary that HELD; a test that FAILS is a
 * confirmed break. Attack ids (ATK-P*) are referenced from the report.
 */
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

// Distinct from every other xc_pg_* suite so all files can share one DB.
const U1 = "0000000a-c4a2-4000-8000-000000000021";
const U2 = "0000000a-c4a2-4000-8000-000000000022";
const PREMIUM = "0000000a-c4a2-4000-8000-000000000023";

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

const unscored = (resultKind: "low_confidence" | "partial") => ({ resultKind, overallScore: null });

let shotSeq = 0;
function shotId(): string {
  shotSeq += 1;
  return `0000000a-c4a2-4000-8000-3${String(shotSeq).padStart(11, "0")}`;
}

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`select set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', public.get_api_request_key())::text, true)`);
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

async function resetUsers(
  sql: Sql,
  premium: "none" | "active" | "expired" = "none",
): Promise<void> {
  for (const id of [U1, U2, PREMIUM]) {
    await sql.unsafe(`delete from auth.users where id = '${id}'`);
    await sql.unsafe(
      `delete from public.free_rating_ledger
        where identity_hash = public.free_rating_identity_hash('google', 'adv-cp-${id}')`,
    );
    await sql.unsafe(
      `insert into auth.users (id, email, raw_app_meta_data) values ('${id}', '${id}@example.com', '{"provider":"google"}')`,
    );
    await sql.unsafe(
      `insert into auth.identities (provider, provider_id, user_id, identity_data)
       values ('google', 'adv-cp-${id}', '${id}', '{"sub":"adv-cp-${id}"}')`,
    );
  }
  if (premium === "active") {
    await sql.unsafe(
      `insert into public.billing_entitlements (user_id, premium, product_key, expires_at)
       values ('${PREMIUM}', true, 'pickle_sensei_pro_lifetime', null)`,
    );
  } else if (premium === "expired") {
    await sql.unsafe(
      `insert into public.billing_entitlements (user_id, premium, product_key, expires_at)
       values ('${PREMIUM}', true, 'pickle_sensei_pro_monthly', now() - interval '1 minute')`,
    );
  }
}

function inTx<T>(sql: Sql, userId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    if (userId) await asUser(tx as unknown as Tx, userId);
    return await fn(tx as unknown as Tx);
  }) as Promise<T>;
}

async function reserveRow(
  sql: Sql,
  userId: string,
  key: string,
): Promise<{ result: string; permit_id: string | null; permit_status: string | null }> {
  const rows = await inTx(
    sql,
    userId,
    async (tx) =>
      await tx.unsafe(
        `select x.result, x.permit_id::text as permit_id, x.permit_status from public.reserve_analysis_permit('${key}') x`,
      ),
  );
  return rows[0] as { result: string; permit_id: string | null; permit_status: string | null };
}

async function reserve(sql: Sql, userId: string, key: string): Promise<string> {
  const row = await reserveRow(sql, userId, key);
  assertEquals(row.result, "accepted", `reserve ${key}`);
  return row.permit_id as string;
}

async function sync(tx: Tx, payload: Record<string, unknown>): Promise<string> {
  const rows = await tx.unsafe(`select public.apply_synced_shot($1::jsonb) as r`, [payload]);
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

async function lifetimeScored(sql: Sql, userId: string): Promise<number> {
  const rows = await inTx(
    sql,
    userId,
    async (tx) => await tx.unsafe(`select public.lifetime_scored_count() as n`),
  );
  return Number(rows[0].n);
}

/** Sum of identity-ledger scored counts across this suite's three users. */
async function ledgerRows(sql: Sql): Promise<number> {
  const rows = await sql.unsafe(
    `select coalesce(sum(l.scored_count), 0)::int as n from public.free_rating_ledger l
      where l.identity_hash in (
        public.free_rating_identity_hash('google', 'adv-cp-${U1}'),
        public.free_rating_identity_hash('google', 'adv-cp-${U2}'),
        public.free_rating_identity_hash('google', 'adv-cp-${PREMIUM}'))`,
  );
  return Number(rows[0].n);
}

async function shotRow(sql: Sql, id: string): Promise<Record<string, unknown> | null> {
  const rows = await sql.unsafe(
    `select result_kind, overall_score::text as overall_score, coalesce(analysis_permit_id::text,'NULL') as permit
       from public.shots where id = '${id}'`,
  );
  return rows.length === 0 ? null : (rows[0] as Record<string, unknown>);
}

function pgError(e: unknown): { code: string; hint: string | null } {
  const err = e as { code?: string; hint?: string };
  return { code: err.code ?? "?", hint: err.hint ?? null };
}

async function attempt(sql: Sql, userId: string | null, stmt: string): Promise<string> {
  try {
    const n = await inTx(sql, userId, async (tx) => (await tx.unsafe(stmt)).count);
    return `allowed ${n}`;
  } catch (e) {
    const { code, hint } = pgError(e);
    return `${code}:${hint}`;
  }
}

function withDb(name: string, fn: (sql: Sql) => Promise<void>) {
  Deno.test({
    name,
    ignore,
    async fn() {
      const sql = postgres(PG_URL, { max: 4, onnotice: () => {} });
      try {
        await fn(sql);
      } finally {
        await sql.end({ timeout: 5 });
      }
    },
  });
}

// ── ATK-P1 — the charge is decided by ONE label, never by two outputs ───────
// The joint contract charges only when mechanics AND benchmark are both
// validated and durably published. The data plane has no slot for the second
// output: `result_kind = 'scored'` alone finalizes the permit and writes the
// free-rating ledger. A row that explicitly carries a WITHHELD benchmark is
// charged all the same.

withDb(
  "ATK-P1 scored row with an explicit withheld benchmark is charged (permit finalized/scored, ledger +1)",
  async (sql) => {
    await resetUsers(sql);
    const permit = await reserve(sql, U1, "atk-p1");
    const id = shotId();
    const ledgerBefore = await ledgerRows(sql);
    const verdict = await syncAs(
      sql,
      U1,
      shotPayload(id, permit, {
        benchmark: {
          schemaVersion: "technique-benchmark-v1",
          interpretation: "unofficial_single_swing_form_only",
          scale: "dupr_2_8",
          status: "insufficient_evidence",
          reasonCodes: ["uncertainty_exceeds_release_bound"],
        },
        mechanics: { status: "validated_score", score: 7 },
      }),
    );
    // Observed at HEAD: 'accepted', finalized/scored, lifetime 1, ledger +1.
    // Expected by the joint contract: not chargeable (outcome_partial) —
    // the permit must settle released/partial and nothing may be counted.
    assertEquals(verdict, "accepted");
    assertEquals(await permitState(sql, permit), "released/partial");
    assertEquals(await lifetimeScored(sql, U1), 0);
    assertEquals(await ledgerRows(sql), ledgerBefore);
  },
);

// ── ATK-P2 — partial / abstention never charge; partial permit is terminal ──

withDb(
  "ATK-P2 partial and low_confidence settle their permits without counting; partial permit cannot be resurrected",
  async (sql) => {
    await resetUsers(sql);
    const pPartial = await reserve(sql, U1, "atk-p2-partial");
    const pAbstain = await reserve(sql, U1, "atk-p2-abstain");
    const partialId = shotId();
    assertEquals(
      await syncAs(sql, U1, shotPayload(partialId, pPartial, unscored("partial"))),
      "accepted",
    );
    assertEquals(
      await syncAs(sql, U1, shotPayload(shotId(), pAbstain, unscored("low_confidence"))),
      "accepted",
    );
    assertEquals(await permitState(sql, pPartial), "released/partial");
    assertEquals(await permitState(sql, pAbstain), "released/low_confidence");
    assertEquals(await lifetimeScored(sql, U1), 0);
    assertEquals(await ledgerRows(sql), 0);

    // Both free slots are back: two more reservations succeed.
    await reserve(sql, U1, "atk-p2-r3");
    await reserve(sql, U1, "atk-p2-r4");

    // Resurrection attempts on released/partial via the client column grant.
    for (const move of [
      `update public.analysis_permits set status = 'reserved', outcome = null where id = '${pPartial}'`,
      `update public.analysis_permits set status = 'finalized', outcome = 'scored' where id = '${pPartial}'`,
      `update public.analysis_permits set status = 'finalized', outcome = 'partial' where id = '${pPartial}'`,
      `update public.analysis_permits set status = 'released', outcome = 'expired' where id = '${pPartial}'`,
      `update public.analysis_permits set status = 'released', outcome = 'low_confidence' where id = '${pPartial}'`,
    ]) {
      assertEquals(await attempt(sql, U1, move), "23514:access.permit_transition_rejected", move);
    }
    // Late scored sync naming the partial permit → refused, nothing counted.
    assertEquals(
      await syncAs(sql, U1, shotPayload(shotId(), pPartial)),
      "access.permit_not_reserved",
    );
    // Replaying the partial shot id relabelled `scored` → replay-accepted, row unchanged.
    assertEquals(await syncAs(sql, U1, shotPayload(partialId, pPartial)), "accepted");
    assertEquals(await shotRow(sql, partialId), {
      result_kind: "partial",
      overall_score: null,
      permit: pPartial,
    });
    assertEquals(await lifetimeScored(sql, U1), 0);
  },
);

// ── ATK-P3 — second credit on a valid replay ─────────────────────────────────

withDb(
  "ATK-P3 valid scored replay (same permit, then a fresh permit) never consumes a second credit",
  async (sql) => {
    await resetUsers(sql);
    const p1 = await reserve(sql, U1, "atk-p3-1");
    const p2 = await reserve(sql, U1, "atk-p3-2");
    const id = shotId();
    assertEquals(await syncAs(sql, U1, shotPayload(id, p1)), "accepted");
    assertEquals(await lifetimeScored(sql, U1), 1);
    assertEquals(await ledgerRows(sql), 1);
    // Replay under the same permit.
    assertEquals(await syncAs(sql, U1, shotPayload(id, p1)), "accepted");
    // Replay under a DIFFERENT live permit (client relaunch with a new reservation).
    assertEquals(await syncAs(sql, U1, shotPayload(id, p2, { overallScore: 9.9 })), "accepted");
    assertEquals(await lifetimeScored(sql, U1), 1);
    assertEquals(await ledgerRows(sql), 1);
    assertEquals(await permitState(sql, p1), "finalized/scored");
    assertEquals(await permitState(sql, p2), "reserved/NULL");
    assertEquals(await shotRow(sql, id), {
      result_kind: "scored",
      overall_score: "7.00",
      permit: p1,
    });
    // Cross-account replay of the same id → conflict, never accepted for U2.
    const p3 = await reserve(sql, U2, "atk-p3-u2");
    assertEquals(await syncAs(sql, U2, shotPayload(id, p3)), "shot.id_conflict");
    assertEquals(await permitState(sql, p3), "reserved/NULL");
    assertEquals(await lifetimeScored(sql, U2), 0);
  },
);

// ── ATK-P4 — crash after one of two outputs (write fails mid-transaction) ───
// The shot row is inserted, then a detail row fails: the whole block must
// roll back, the permit must still back a clean retry, nothing counted.

withDb(
  "ATK-P4 detail write failure after the shot insert rolls back everything and leaves the permit reserved",
  async (sql) => {
    await resetUsers(sql);
    const permit = await reserve(sql, U1, "atk-p4");
    const id = shotId();
    const broken = shotPayload(id, permit, {
      phases: [
        { key: "load", startMs: "not-a-number", representativeMs: 10, endMs: 20, confidence: 0.9 },
      ],
    });
    const verdict = await syncAs(sql, U1, broken);
    assert(verdict.startsWith("shot.write_failed:"), verdict);
    assertEquals(await shotRow(sql, id), null);
    assertEquals(await permitState(sql, permit), "reserved/NULL");
    assertEquals(await lifetimeScored(sql, U1), 0);
    assertEquals(await ledgerRows(sql), 0);
    // Clean retry with a valid payload consumes the permit exactly once.
    assertEquals(await syncAs(sql, U1, shotPayload(id, permit)), "accepted");
    assertEquals(await permitState(sql, permit), "finalized/scored");
    assertEquals(await lifetimeScored(sql, U1), 1);
  },
);

// ── ATK-P5 — premium bypass boundaries ──────────────────────────────────────

withDb(
  "ATK-P5 premium bypasses the allowance but never the permit; an EXPIRED entitlement is not premium",
  async (sql) => {
    await resetUsers(sql, "active");
    // Third and fourth scored ratings for an active premium member.
    for (let i = 1; i <= 4; i++) {
      const p = await reserve(sql, PREMIUM, `atk-p5-${i}`);
      assertEquals(await syncAs(sql, PREMIUM, shotPayload(shotId(), p)), "accepted");
    }
    assertEquals(await lifetimeScored(sql, PREMIUM), 4);
    // No permit at all → refused even for premium.
    assertEquals(
      await syncAs(sql, PREMIUM, shotPayload(shotId(), "0000000a-c4a2-4000-8000-0000000000ff")),
      "access.permit_not_found",
    );
    // Direct scored INSERT without a permit → the table gate refuses.
    const direct = await attempt(
      sql,
      PREMIUM,
      `insert into public.shots (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
       overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
       paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
     values ('${shotId()}', '${PREMIUM}', 'dink', 'side', now(), 0, 100, 200, 7, 0.9, 'scored',
       '1','1','1','1','1','1','1','1')`,
    );
    assert(direct.startsWith("42501:"), direct);

    // Entitlement lapses: a premium=true row past expires_at is not premium.
    await sql.unsafe(
      `update public.billing_entitlements set expires_at = now() - interval '1 minute' where user_id = '${PREMIUM}'`,
    );
    const lapsed = await reserveRow(sql, PREMIUM, "atk-p5-lapsed");
    assertEquals(lapsed.result, "access.paywall_required");
    // A permit minted earlier (before lapse) cannot carry a 5th free rating.
    await sql.unsafe(
      `update public.billing_entitlements set expires_at = now() + interval '1 hour' where user_id = '${PREMIUM}'`,
    );
    const held = await reserve(sql, PREMIUM, "atk-p5-held");
    await sql.unsafe(
      `update public.billing_entitlements set expires_at = now() - interval '1 minute' where user_id = '${PREMIUM}'`,
    );
    assertEquals(
      await syncAs(sql, PREMIUM, shotPayload(shotId(), held)),
      "access.paywall_required",
    );
    assertEquals(await permitState(sql, held), "released/free_limit_exceeded");
    assertEquals(await lifetimeScored(sql, PREMIUM), 4);
  },
);

// ── ATK-P6 — HOLD vs refund: a swept (expired) permit still settles late ────

withDb(
  "ATK-P6 late sync onto released/expired settles exactly once; a second late shot is refused",
  async (sql) => {
    await resetUsers(sql);
    const permit = await reserve(sql, U1, "atk-p6");
    await sql.unsafe(
      `update public.analysis_permits set status = 'released', outcome = 'expired' where id = '${permit}'`,
    );
    assertEquals(await permitState(sql, permit), "released/expired");
    const id = shotId();
    assertEquals(await syncAs(sql, U1, shotPayload(id, permit)), "accepted");
    assertEquals(await permitState(sql, permit), "finalized/scored");
    assertEquals(await lifetimeScored(sql, U1), 1);
    assertEquals(
      await syncAs(sql, U1, shotPayload(shotId(), permit)),
      "access.permit_not_reserved",
    );
    assertEquals(await syncAs(sql, U1, shotPayload(id, permit)), "accepted");
    assertEquals(await lifetimeScored(sql, U1), 1);
    // A late PARTIAL onto a swept permit settles released/partial, not counted.
    const p2 = await reserve(sql, U1, "atk-p6-partial");
    await sql.unsafe(
      `update public.analysis_permits set status = 'released', outcome = 'expired' where id = '${p2}'`,
    );
    assertEquals(await syncAs(sql, U1, shotPayload(shotId(), p2, unscored("partial"))), "accepted");
    assertEquals(await permitState(sql, p2), "released/partial");
    assertEquals(await lifetimeScored(sql, U1), 1);
  },
);

// ── ATK-P7 — cross-account permit use ───────────────────────────────────────

withDb(
  "ATK-P7 a permit reserved by U1 cannot back U2's shot, and U2 cannot finalize or read it",
  async (sql) => {
    await resetUsers(sql);
    const permit = await reserve(sql, U1, "atk-p7");
    assertEquals(await syncAs(sql, U2, shotPayload(shotId(), permit)), "access.permit_not_found");
    assertEquals(
      await attempt(
        sql,
        U2,
        `update public.analysis_permits set status = 'finalized', outcome = 'cancelled' where id = '${permit}'`,
      ),
      "allowed 0",
    );
    const visible = await inTx(
      sql,
      U2,
      async (tx) =>
        await tx.unsafe(
          `select count(*)::int as n from public.analysis_permits where id = '${permit}'`,
        ),
    );
    assertEquals(Number(visible[0].n), 0);
    assertEquals(await permitState(sql, permit), "reserved/NULL");
    assertEquals(await lifetimeScored(sql, U2), 0);
  },
);

// ── ATK-P8 — data-plane gate for a scored row without a score ───────────────
// The edge parser refuses `scored` with a null score; the RPC is the last
// gate before the ledger. Bypassing the parser (any caller holding the API
// request key) must not be able to charge a rating that carries no number.

withDb(
  "ATK-P8 RPC refuses a `scored` row carrying overallScore=null (no unscored rating is ever counted)",
  async (sql) => {
    await resetUsers(sql);
    const permit = await reserve(sql, U1, "atk-p8");
    const id = shotId();
    const verdict = await syncAs(sql, U1, shotPayload(id, permit, { overallScore: null }));
    assert(verdict !== "accepted", `unscored 'scored' row was accepted: ${verdict}`);
    assertEquals(await shotRow(sql, id), null);
    assertEquals(await permitState(sql, permit), "reserved/NULL");
    assertEquals(await lifetimeScored(sql, U1), 0);
  },
);
