/**
 * XC journey-offline-first — database plane.
 *
 * The server-side verdicts a reconnecting device receives per shot come from
 * `public.apply_synced_shot(jsonb)` (latest definition:
 * supabase/migrations/20260902150000_free_rating_identity_ledger.sql). These
 * scenarios drive the REAL function under the `authenticated` role + RLS on a
 * throwaway migrated Postgres and pin the verdict + durable side effects for
 * the offline-first edge cases the mobile outbox has to reconcile:
 *
 *   - a scored shot flushed more than 24h after its permit was reserved
 *     (device stayed offline) → access.permit_expired, then the SAME retry
 *     answers access.permit_not_reserved (the permit was released);
 *   - a shot flushed before its practice set's session row exists
 *     → shot.session_not_found, and accepted once the session lands;
 *   - the same shot id replayed by another account → shot.id_conflict, the
 *     other account's permit is left reserved;
 *   - an over-issued third permit for a free account → access.paywall_required
 *     with the permit released as free_limit_exceeded;
 *   - a concurrent duplicate flush of one shot (device timeout + retry racing
 *     the still-running first request) → the loser's verdict.
 *
 * Setup (same as supabase/tests/run_rls_tests.sh / be-edge-routes-shots-rank):
 *
 *   docker run -d --name pickle-xc-offline -p 55432:5432 -e POSTGRES_PASSWORD=pg postgres:16
 *   docker cp supabase/tests pickle-xc-offline:/tests && docker cp supabase/migrations pickle-xc-offline:/migrations
 *   docker exec pickle-xc-offline bash -c 'psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql \
 *     && for f in /migrations/*.sql; do psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"; done'
 *   PICKLE_AUDIT_PG_URL=postgres://postgres:pg@127.0.0.1:55432/postgres \
 *     deno test -A --no-check --config supabase/functions/api/__wf__/deno.json \
 *       supabase/functions/api/__wf__/xc_journey_offline_first_db.test.ts
 *
 * Without PICKLE_AUDIT_PG_URL every test is skipped (ignore: true) — a skip
 * is NOT a pass. Artifacts: artifacts/xc-offline-first/db/*.json.
 */
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";

const PG_URL = Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

const ALICE = "0000d0d0-0000-4000-8000-00000000000a";
const BOB = "0000d0d0-0000-4000-8000-00000000000b";

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

const ARTIFACT_DIR =
  Deno.env.get("XC_OFFLINE_ARTIFACT_DIR") ??
  new URL("../../../../artifacts/xc-offline-first/db/", import.meta.url).pathname;

async function writeArtifact(name: string, value: unknown): Promise<void> {
  await Deno.mkdir(ARTIFACT_DIR, { recursive: true });
  const path = `${ARTIFACT_DIR}${ARTIFACT_DIR.endsWith("/") ? "" : "/"}${name}`;
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2));
  console.log(`artifact: ${path}`);
}

/** Runs `fn` inside one transaction that is always rolled back. */
async function withRollback(sql: Sql, fn: (tx: Sql) => Promise<void>): Promise<void> {
  try {
    await sql.begin(async (tx) => {
      await fn(tx as unknown as Sql);
      throw new Error("__rollback__");
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "__rollback__") {
      throw error;
    }
  }
}

async function ensureUser(tx: Sql, userId: string): Promise<void> {
  await tx.unsafe(
    `insert into auth.users (id, email) values ('${userId}', '${userId}@example.com') on conflict do nothing`,
  );
}

/** Act as `userId` under RLS — how the edge function's per-user client
 * reaches the RPCs (shim: auth.uid() reads request.jwt.claim.sub). */
async function actAs(tx: Sql, userId: string): Promise<void> {
  await tx.unsafe(`reset role`);
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

async function actAsSuperuser(tx: Sql): Promise<void> {
  await tx.unsafe(`reset role`);
}

function shotPayload(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    sessionId: null,
    shotType: "dink",
    cameraView: "side",
    capturedAt: "2026-09-04T10:00:00.000Z",
    startMs: 0,
    contactMs: 100,
    endMs: 200,
    overallScore: 7,
    confidence: 0.9,
    resultKind: "scored",
    phases: [{ key: "ready", startMs: 0, representativeMs: 10, endMs: 20, confidence: 0.9 }],
    checkpoints: [
      {
        key: "paddle_face",
        score: 70,
        confidence: 0.8,
        band: "yellow",
        direction: "hold",
        severity: 0.2,
        applicable: true,
      },
    ],
    versionVector: VERSION_VECTOR,
    ...overrides,
  };
}

async function reserve(tx: Sql, key: string): Promise<string> {
  const rows = await tx.unsafe(
    `select result, permit_id from public.reserve_analysis_permit('${key}')`,
  );
  assertEquals(rows[0].result, "accepted");
  return String(rows[0].permit_id);
}

async function apply(tx: Sql, shot: Record<string, unknown>): Promise<string> {
  const rows = await tx.unsafe(`select public.apply_synced_shot($1::text::jsonb) as status`, [
    JSON.stringify(shot),
  ]);
  return String(rows[0].status);
}

async function permitRow(
  tx: Sql,
  permitId: string,
): Promise<{ status: string; outcome: string | null }> {
  const rows = await tx.unsafe(
    `select status, outcome from public.analysis_permits where id = '${permitId}'`,
  );
  return { status: String(rows[0].status), outcome: rows[0].outcome as string | null };
}

async function shotCount(tx: Sql, id: string): Promise<number> {
  const rows = await tx.unsafe(`select count(*)::int as n from public.shots where id = '${id}'`);
  return Number(rows[0].n);
}

Deno.test({
  name: "offline > 24h: the permit reserved before going offline is refused as expired, and the retry is refused as not-reserved",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    try {
      await withRollback(sql, async (tx) => {
        await ensureUser(tx, ALICE);
        await actAs(tx, ALICE);
        const permitId = await reserve(tx, "xc-offline-25h");
        // The device scored while online (permit reserved), then stayed
        // offline for 25 hours before the outbox could flush.
        await actAsSuperuser(tx);
        await tx.unsafe(
          `update public.analysis_permits set created_at = now() - interval '25 hours' where id = '${permitId}'`,
        );
        await actAs(tx, ALICE);
        const shot = shotPayload({ analysisPermitId: permitId });
        const first = await apply(tx, shot);
        const afterFirst = await permitRow(tx, permitId);
        const second = await apply(tx, shot);
        const third = await apply(tx, shot);
        const stored = await shotCount(tx, String(shot.id));
        // The rating was NOT spent server-side: a fresh permit is still available.
        const access = await tx.unsafe(`select * from public.access_state()`);
        await writeArtifact("permit-expired-offline-flush.json", {
          permitId,
          verdicts: [first, second, third],
          permitAfterFirst: afterFirst,
          shotRowsStored: stored,
          accessState: access[0],
        });
        assertEquals(first, "access.permit_expired");
        assertEquals(afterFirst, { status: "released", outcome: "expired" });
        // Every later retry of the same durable row gets a DIFFERENT code.
        assertEquals(second, "access.permit_not_reserved");
        assertEquals(third, "access.permit_not_reserved");
        assertEquals(stored, 0);
        assertEquals(Number(access[0].scored_count), 0);
        assertEquals(Number(access[0].reserved_count), 0);
      });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "shot flushed before its session row: session_not_found, then accepted once the session lands; permit untouched in between",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    try {
      await withRollback(sql, async (tx) => {
        await ensureUser(tx, ALICE);
        await actAs(tx, ALICE);
        const permitId = await reserve(tx, "xc-session-order");
        const sessionId = crypto.randomUUID();
        const shot = shotPayload({ analysisPermitId: permitId, sessionId });
        const before = await apply(tx, shot);
        const permitBetween = await permitRow(tx, permitId);
        await tx.unsafe(
          `insert into public.sessions (id, user_id, started_at) values ('${sessionId}', '${ALICE}', '2026-09-04T09:00:00Z')`,
        );
        const after = await apply(tx, shot);
        const replay = await apply(tx, shot);
        const permitAfter = await permitRow(tx, permitId);
        const stored = await shotCount(tx, String(shot.id));
        const details = await tx.unsafe(
          `select (select count(*)::int from public.shot_phases where shot_id = '${shot.id}') as phases,
                  (select count(*)::int from public.shot_checkpoints where shot_id = '${shot.id}') as checkpoints`,
        );
        await writeArtifact("session-ordering.json", {
          sessionId,
          verdicts: { beforeSession: before, afterSession: after, replay },
          permitBetween,
          permitAfter,
          shotRowsStored: stored,
          details: details[0],
        });
        assertEquals(before, "shot.session_not_found");
        assertEquals(permitBetween, { status: "reserved", outcome: null });
        assertEquals(after, "accepted");
        assertEquals(replay, "accepted");
        assertEquals(permitAfter, { status: "finalized", outcome: "scored" });
        assertEquals(stored, 1);
        assertEquals(details[0], { phases: 1, checkpoints: 1 });
      });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "same shot id replayed by another account: shot.id_conflict, the other account's permit stays reserved and its row is never written",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    try {
      await withRollback(sql, async (tx) => {
        await ensureUser(tx, ALICE);
        await ensureUser(tx, BOB);
        await actAs(tx, ALICE);
        const alicePermit = await reserve(tx, "xc-conflict-a");
        const shot = shotPayload({ analysisPermitId: alicePermit });
        assertEquals(await apply(tx, shot), "accepted");

        await actAs(tx, BOB);
        const bobPermit = await reserve(tx, "xc-conflict-b");
        const asBob = await apply(tx, { ...shot, analysisPermitId: bobPermit });
        const bobPermitAfter = await permitRow(tx, bobPermit);
        const bobVisible = await tx.unsafe(
          `select count(*)::int as n from public.shots where id = '${shot.id}'`,
        );
        await actAsSuperuser(tx);
        const owners = await tx.unsafe(`select user_id from public.shots where id = '${shot.id}'`);
        await writeArtifact("cross-account-id-conflict.json", {
          verdictAsBob: asBob,
          bobPermitAfter,
          bobSeesRows: bobVisible[0].n,
          owners: owners.map((r) => r.user_id),
        });
        assertEquals(asBob, "shot.id_conflict");
        assertEquals(bobPermitAfter, { status: "reserved", outcome: null });
        assertEquals(bobVisible[0].n, 0);
        assertEquals(
          owners.map((r) => String(r.user_id)),
          [ALICE],
        );
      });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "over-issued third permit on a free account: paywall_required at sync, permit released as free_limit_exceeded, no third scored row",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    try {
      await withRollback(sql, async (tx) => {
        await ensureUser(tx, ALICE);
        await actAs(tx, ALICE);
        const p1 = await reserve(tx, "xc-free-1");
        assertEquals(await apply(tx, shotPayload({ analysisPermitId: p1 })), "accepted");
        const p2 = await reserve(tx, "xc-free-2");
        assertEquals(await apply(tx, shotPayload({ analysisPermitId: p2 })), "accepted");
        const refused = await tx.unsafe(
          `select result from public.reserve_analysis_permit('xc-free-3')`,
        );
        // Simulate a permit an older build managed to obtain anyway.
        await actAsSuperuser(tx);
        const p3 = crypto.randomUUID();
        await tx.unsafe(
          `insert into public.analysis_permits (id, user_id, idempotency_key, status) values ('${p3}', '${ALICE}', 'xc-free-3-forced', 'reserved')`,
        );
        await actAs(tx, ALICE);
        const third = shotPayload({ analysisPermitId: p3 });
        const verdict = await apply(tx, third);
        const retry = await apply(tx, third);
        const p3After = await permitRow(tx, p3);
        const scored = await tx.unsafe(
          `select count(*)::int as n from public.shots where result_kind = 'scored'`,
        );
        await writeArtifact("paywall-backstop.json", {
          reserveThird: refused[0].result,
          verdicts: [verdict, retry],
          permitAfter: p3After,
          scoredRows: scored[0].n,
        });
        assertEquals(refused[0].result, "access.paywall_required");
        assertEquals(verdict, "access.paywall_required");
        assertEquals(retry, "access.permit_not_reserved");
        assertEquals(p3After, { status: "released", outcome: "free_limit_exceeded" });
        assertEquals(scored[0].n, 2);
        assertEquals(await shotCount(tx, String(third.id)), 0);
      });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "concurrent duplicate flush of one shot: the request that commits first is accepted; the racer's verdict is recorded",
  ignore,
  async fn() {
    const first = postgres(PG_URL, { max: 1 });
    const second = postgres(PG_URL, { max: 1 });
    const admin = postgres(PG_URL, { max: 1 });
    const shotId = crypto.randomUUID();
    let permitId = "";
    try {
      await admin.unsafe(
        `insert into auth.users (id, email) values ('${ALICE}', '${ALICE}@example.com') on conflict do nothing`,
      );
      // Reserve the permit in its own committed transaction so both racing
      // connections can see it.
      await first.begin(async (tx) => {
        await tx.unsafe(`set local role authenticated`);
        await tx.unsafe(`set local request.jwt.claim.sub = '${ALICE}'`);
        permitId = await reserve(tx as unknown as Sql, `xc-race-${shotId}`);
      });
      const shot = shotPayload({ id: shotId, analysisPermitId: permitId });

      // Request 1 applies the shot but has not committed yet (still running
      // server-side when the device's 20s timeout fires).
      let releaseFirst: () => void = () => {};
      const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve));
      let firstVerdict = "";
      const firstTx = first.begin(async (tx) => {
        await tx.unsafe(`set local role authenticated`);
        await tx.unsafe(`set local request.jwt.claim.sub = '${ALICE}'`);
        firstVerdict = await apply(tx as unknown as Sql, shot);
        await firstHeld;
      });
      // Give request 1 time to take its locks.
      await new Promise((r) => setTimeout(r, 300));

      // Request 2: the device retried the identical row.
      let secondVerdict = "";
      const secondTx = second.begin(async (tx) => {
        await tx.unsafe(`set local role authenticated`);
        await tx.unsafe(`set local request.jwt.claim.sub = '${ALICE}'`);
        secondVerdict = await apply(tx as unknown as Sql, shot);
      });
      const secondSettledEarly = await Promise.race([
        secondTx.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 500)),
      ]);
      // Request 1 commits.
      releaseFirst();
      await firstTx;
      await secondTx;

      const rows = await admin.unsafe(
        `select count(*)::int as n from public.shots where id = '${shotId}'`,
      );
      const permit = await admin.unsafe(
        `select status, outcome from public.analysis_permits where id = '${permitId}'`,
      );
      // A third, sequential flush (the device's next pass) of the same row.
      let thirdVerdict = "";
      await first.begin(async (tx) => {
        await tx.unsafe(`set local role authenticated`);
        await tx.unsafe(`set local request.jwt.claim.sub = '${ALICE}'`);
        thirdVerdict = await apply(tx as unknown as Sql, shot);
      });
      await writeArtifact("concurrent-duplicate-flush.json", {
        shotId,
        permitId,
        secondBlockedBehindFirst: !secondSettledEarly,
        verdicts: { first: firstVerdict, racer: secondVerdict, nextFlush: thirdVerdict },
        shotRows: rows[0].n,
        permit: permit[0],
      });
      assertEquals(firstVerdict, "accepted");
      assert(!secondSettledEarly, "the racer should block on the per-user/permit locks");
      assertEquals(rows[0].n, 1);
      assertEquals(permit[0], { status: "finalized", outcome: "scored" });
      // The server holds the shot, yet the racer is told the permit is not
      // reserved — a permanent code for a shot that IS accepted. The device's
      // next flush is acknowledged from the idempotent replay check.
      assertEquals(secondVerdict, "access.permit_not_reserved");
      assertEquals(thirdVerdict, "accepted");
    } finally {
      await admin.unsafe(`delete from public.shots where id = '${shotId}'`).catch(() => {});
      if (permitId) {
        await admin
          .unsafe(`delete from public.analysis_permits where id = '${permitId}'`)
          .catch(() => {});
      }
      await Promise.all([first.end(), second.end(), admin.end()]);
    }
  },
});
