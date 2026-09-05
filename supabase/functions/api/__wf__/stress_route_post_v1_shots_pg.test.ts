/**
 * STRESS (fuzz-boundary lens, database half) — POST /v1/shots:sync driven
 * through the REAL edge handler (../index.ts in-process) whose PostgREST
 * calls land on a REAL throwaway Postgres 16 with the shim + every migration
 * applied (stress_shots_sync_pg_backend.ts). Auth/RevenueCat stay stubbed.
 *
 *   ./supabase/functions/api/__wf__/xc_pg_up.sh            # prints XC_PG_URL
 *   cd supabase/functions/api/__wf__
 *   STRESS_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     deno test -A --no-check --config deno.json stress_route_post_v1_shots_pg.test.ts
 *
 * Env:
 *   STRESS_PG_URL   (or XC_PG_URL / PICKLE_AUDIT_PG_URL) — without it every
 *                   test here is ignored, never silently passed.
 *   STRESS_PG_ITER  seeded end-to-end batches against the database (default 40)
 *   STRESS_PG_SEED  master seed (default 20260904)
 *   STRESS_OUT_DIR  artifact directory (pg_*.json)
 *
 * Pins (P0 if broken): duplicate delivery of one shot — concurrently and as
 * a replay — yields ONE row and every copy is `accepted`; a non-premium
 * identity can never record a third scored shot even when a permit was
 * over-issued; two shots on one permit consume it once; a failed detail
 * insert rolls the shot back and leaves the permit reserved for a clean
 * retry; rejected entries never write.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  canonicalShot,
  captureAccess,
  captureConsole,
  EDGE_ORIGIN,
  envInt,
  fakeSessionToken,
  histogram,
  isRecord,
  iterationSeed,
  leakFindings,
  loadStressHarness,
  Prng,
  readBodyText,
  type StressHarness,
  writeJson,
} from "./stress_shots_sync_harness.ts";
import { PostgresBackend, type Sql } from "./stress_shots_sync_pg_backend.ts";
import { canary, generateShot, referenceValidate } from "./stress_shots_sync_fuzz.ts";

const PG_URL = Deno.env.get("STRESS_PG_URL") ?? Deno.env.get("XC_PG_URL") ??
  Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const STRESS_PG_ITER = envInt("STRESS_PG_ITER", 40);
const STRESS_PG_SEED = envInt("STRESS_PG_SEED", 20260904);

let ipCounter = 0;

/** Authenticated request as `sub` (fake Supabase session bearer, verified by
 * the stubbed Auth); each request gets its own client IP so per-IP budgets
 * never shadow the per-user semantics under test. */
function syncRequest(sub: string, body: unknown): Request {
  ipCounter += 1;
  return new Request(`${EDGE_ORIGIN}/functions/v1/api/v1/shots:sync`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${fakeSessionToken(sub)}`,
      "Content-Type": "application/json",
      "x-forwarded-for": `10.${(ipCounter >> 8) & 255}.${ipCounter & 255}.9`,
    },
    body: JSON.stringify(body),
  });
}

interface Reply {
  status: number;
  requestId: string | null;
  body: unknown;
  text: string;
}

async function call(h: StressHarness, request: Request): Promise<Reply> {
  const response = await h.handler(request);
  const text = await readBodyText(response);
  let body: unknown = undefined;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: response.status, requestId: response.headers.get("x-request-id"), body, text };
}

function acceptedIds(reply: Reply): string[] {
  return isRecord(reply.body) && Array.isArray(reply.body.acceptedIds) ? reply.body.acceptedIds.map(String) : [];
}

function rejected(reply: Reply): Array<{ id: string; code: string; message: unknown }> {
  if (!isRecord(reply.body) || !Array.isArray(reply.body.rejected)) return [];
  return reply.body.rejected.map((r) =>
    isRecord(r) ? { id: String(r.id), code: String(r.code), message: r.message } : { id: "?", code: "?", message: r }
  );
}

function envelopeProblems(reply: Reply): string[] {
  const out: string[] = [];
  if (!reply.requestId) out.push("missing x-request-id");
  const leaks = leakFindings(reply.text);
  if (leaks.length) out.push(`leak ${leaks.join(",")}`);
  if (reply.status >= 500 && reply.text !== '{"error":{"message":"Something went wrong. Please try again."}}') {
    if (!/temporarily unavailable/.test(reply.text)) out.push(`non-generic 5xx: ${reply.text.slice(0, 160)}`);
  }
  return out;
}

async function reserve(
  pg: PostgresBackend,
  userId: string,
  key: string,
): Promise<{ result: string; permitId: string | null }> {
  return await pg.asUser(userId, async (tx) => {
    const rows = await tx.unsafe(`select result, permit_id from public.reserve_analysis_permit($1)`, [key]);
    return { result: String(rows[0].result), permitId: rows[0].permit_id ? String(rows[0].permit_id) : null };
  });
}

interface UserState {
  shots: Array<{ id: string; result_kind: string; analysis_confidence: string }>;
  phases: number;
  checkpoints: number;
  permits: Array<{ id: string; status: string; outcome: string | null }>;
  lifetime: number;
}

async function userState(pg: PostgresBackend, userId: string): Promise<UserState> {
  const sql: Sql = pg.sql;
  const shots = await sql.unsafe(
    `select id, result_kind, analysis_confidence::text from public.shots where user_id = $1 order by id`,
    [userId],
  );
  const phases = await sql.unsafe(`select count(*)::int as n from public.shot_phases where user_id = $1`, [userId]);
  const checkpoints = await sql.unsafe(
    `select count(*)::int as n from public.shot_checkpoints where user_id = $1`,
    [userId],
  );
  const permits = await sql.unsafe(
    `select id, status, outcome from public.analysis_permits where user_id = $1 order by created_at, id`,
    [userId],
  );
  const lifetime = await pg.asUser(userId, async (tx) => {
    const rows = await tx.unsafe(`select public.lifetime_scored_count()::int as n`);
    return Number(rows[0].n);
  });
  return {
    shots: shots.map((r) => ({
      id: String(r.id),
      result_kind: String(r.result_kind),
      analysis_confidence: String(r.analysis_confidence),
    })),
    phases: Number(phases[0].n),
    checkpoints: Number(checkpoints[0].n),
    permits: permits.map((r) => ({
      id: String(r.id),
      status: String(r.status),
      outcome: r.outcome === null ? null : String(r.outcome),
    })),
    lifetime,
  };
}

async function withPg(
  fn: (h: StressHarness, pg: PostgresBackend, users: string[]) => Promise<void>,
): Promise<void> {
  const h = await loadStressHarness();
  const pg = new PostgresBackend(PG_URL);
  const users: string[] = [];
  const consoleSink = captureConsole();
  const accessSink = captureAccess();
  h.setBackend(pg);
  try {
    await fn(h, pg, users);
  } finally {
    h.setBackend(h.memory);
    consoleSink.restore();
    accessSink.restore();
    for (const id of users) await pg.removeUser(id);
    await pg.close();
  }
}

async function newUser(pg: PostgresBackend, users: string[]): Promise<string> {
  const id = crypto.randomUUID();
  await pg.ensureUser(id);
  users.push(id);
  return id;
}

const RICH_DETAILS = {
  phases: [
    { key: "ready", startMs: 0, representativeMs: 10, endMs: 40, confidence: 0.91 },
    { key: "contact", startMs: 40, representativeMs: 100, endMs: 120, confidence: 0.88 },
  ],
  checkpoints: [
    {
      key: "paddle_ready",
      score: 71.25,
      confidence: 0.8,
      band: "green",
      direction: "up",
      severity: 0.1,
      applicable: true,
    },
    {
      key: "knee_bend",
      score: null,
      confidence: 0.2,
      band: "unscored",
      direction: "none",
      severity: 0,
      applicable: false,
    },
  ],
};

Deno.test({
  name:
    "stress pg: 12 concurrent deliveries of ONE scored shot → every copy accepted, exactly one row, permit finalized once; replays stay accepted",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () =>
    withPg(async (h, pg, users) => {
      const user = await newUser(pg, users);
      const permit = await reserve(pg, user, "idem-1");
      assertEquals(permit.result, "accepted");
      const shotId = crypto.randomUUID();
      const shot = canonicalShot(shotId, permit.permitId!, { ...RICH_DETAILS, overallScore: 8.25 });

      const copies = 12;
      const replies = await Promise.all(
        Array.from({ length: copies }, () => call(h, syncRequest(user, { shots: [shot] }))),
      );
      const replays: Reply[] = [];
      for (let i = 0; i < 3; i++) replays.push(await call(h, syncRequest(user, { shots: [shot] })));
      const state = await userState(pg, user);
      const rpcOutcomes = histogram(pg.calls.filter((c) => c.kind === "rpc").map((c) => c.outcome));

      const problems: string[] = [];
      for (const [i, r] of [...replies, ...replays].entries()) {
        problems.push(...envelopeProblems(r).map((p) => `#${i}: ${p}`));
        if (r.status !== 200) problems.push(`#${i}: HTTP ${r.status} ${r.text.slice(0, 120)}`);
        if (JSON.stringify(acceptedIds(r)) !== JSON.stringify([shotId])) {
          problems.push(`#${i}: acceptedIds ${JSON.stringify(acceptedIds(r))} rejected ${JSON.stringify(rejected(r))}`);
        }
      }
      await writeJson("pg_idempotency.json", {
        user,
        shotId,
        permitId: permit.permitId,
        concurrentCopies: copies,
        serialReplays: replays.length,
        statuses: histogram([...replies, ...replays].map((r) => r.status)),
        rpcOutcomes,
        state,
        problems,
      });
      assertEquals(problems, []);
      assertEquals(state.shots.map((s) => s.id), [shotId], "exactly one shots row");
      assertEquals(state.phases, RICH_DETAILS.phases.length);
      assertEquals(state.checkpoints, RICH_DETAILS.checkpoints.length);
      assertEquals(state.permits, [{ id: permit.permitId!, status: "finalized", outcome: "scored" }]);
      assertEquals(state.lifetime, 1);
      // Every copy reached the RPC (the pre-RPC lookup saw nothing for the
      // racing copies) and every RPC answered "accepted" — none saw the
      // already-finalized permit.
      assertEquals(Object.keys(rpcOutcomes), ["accepted"]);
    }),
});

Deno.test({
  name:
    "stress pg: free-rating backstop — an over-issued third permit + 3 concurrent scored syncs → exactly 2 scored rows, third is access.paywall_required, its permit released",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () =>
    withPg(async (h, pg, users) => {
      const user = await newUser(pg, users);
      const p1 = await reserve(pg, user, "free-1");
      const p2 = await reserve(pg, user, "free-2");
      const p3 = await reserve(pg, user, "free-3");
      assertEquals([p1.result, p2.result], ["accepted", "accepted"]);
      assert(p3.result !== "accepted", `a third reservation must be refused, got ${p3.result}`);
      // Over-issue: what every build before reserve_analysis_permit could do.
      const extra = crypto.randomUUID();
      await pg.sql.unsafe(
        `insert into public.analysis_permits (id, user_id, idempotency_key, status) values ($1, $2, 'over-issued', 'reserved')`,
        [extra, user],
      );
      const permits = [p1.permitId!, p2.permitId!, extra];
      const shots = permits.map((permit) => canonicalShot(crypto.randomUUID(), permit, { overallScore: 6.5 }));

      const replies = await Promise.all(shots.map((shot) => call(h, syncRequest(user, { shots: [shot] }))));
      const state = await userState(pg, user);
      const codes = replies.flatMap((r) => rejected(r).map((x) => x.code));
      const accepted = replies.flatMap((r) => acceptedIds(r));
      const problems = replies.flatMap((r, i) => envelopeProblems(r).map((p) => `#${i}: ${p}`));

      // Second attack: two DIFFERENT shots racing on the SAME permit consume it once.
      const user2 = await newUser(pg, users);
      const shared = await reserve(pg, user2, "shared-1");
      assertEquals(shared.result, "accepted");
      const racers = [0, 1, 2, 3].map(() => canonicalShot(crypto.randomUUID(), shared.permitId!));
      const raced = await Promise.all(racers.map((shot) => call(h, syncRequest(user2, { shots: [shot] }))));
      const state2 = await userState(pg, user2);
      const racedAccepted = raced.flatMap((r) => acceptedIds(r));
      const racedCodes = raced.flatMap((r) => rejected(r).map((x) => x.code));
      problems.push(...raced.flatMap((r, i) => envelopeProblems(r).map((p) => `race#${i}: ${p}`)));

      await writeJson("pg_free_rating.json", {
        overIssued: {
          user,
          thirdReserveResult: p3.result,
          statuses: histogram(replies.map((r) => r.status)),
          accepted,
          codes,
          state,
        },
        samePermit: {
          user: user2,
          statuses: histogram(raced.map((r) => r.status)),
          accepted: racedAccepted,
          codes: racedCodes,
          state: state2,
        },
        problems,
      });
      assertEquals(problems, []);
      assertEquals(replies.map((r) => r.status), [200, 200, 200]);
      assertEquals(accepted.length, 2, "exactly two scored ratings for a non-premium identity");
      assertEquals(codes, ["access.paywall_required"]);
      assertEquals(state.shots.filter((s) => s.result_kind === "scored").length, 2);
      assertEquals(state.lifetime, 2);
      assertEquals(histogram(state.permits.map((p) => `${p.status}/${p.outcome}`)), {
        "finalized/scored": 2,
        "released/free_limit_exceeded": 1,
      });
      // Same-permit race.
      assertEquals(raced.map((r) => r.status), [200, 200, 200, 200]);
      assertEquals(racedAccepted.length, 1, "one permit → one scored shot");
      assertEquals(histogram(racedCodes), { "access.permit_not_reserved": 3 });
      assertEquals(state2.shots.length, 1);
      assertEquals(state2.permits, [{ id: shared.permitId!, status: "finalized", outcome: "scored" }]);
    }),
});

Deno.test({
  name:
    "stress pg: a failing detail insert (4 concurrent) rolls the shot back and leaves the permit reserved; the route then syncs cleanly on that permit",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () =>
    withPg(async (h, pg, users) => {
      const user = await newUser(pg, users);
      const permit = await reserve(pg, user, "atomic-1");
      assertEquals(permit.result, "accepted");
      const shotId = crypto.randomUUID();
      // "purple" is refused by the edge parser, so this reaches the RPC only
      // as a stand-in for ANY detail-row constraint failure — called the way
      // the route's per-user client would.
      const poisoned = {
        ...canonicalShot(shotId, permit.permitId!),
        startMs: 0,
        contactMs: 100,
        endMs: 200,
        phases: RICH_DETAILS.phases,
        checkpoints: [{ ...RICH_DETAILS.checkpoints[0], band: "purple" }],
      };
      const statuses = await Promise.all(
        [0, 1, 2, 3].map(() =>
          pg.asUser(user, async (tx) => {
            const rows = await tx.unsafe(`select public.apply_synced_shot($1::text::jsonb) as status`, [
              JSON.stringify(poisoned),
            ]);
            return String(rows[0].status);
          })
        ),
      );
      const afterFailure = await userState(pg, user);
      // Clean retry through the real route on the SAME permit.
      const retry = await call(
        h,
        syncRequest(user, { shots: [canonicalShot(shotId, permit.permitId!, RICH_DETAILS)] }),
      );
      const afterRetry = await userState(pg, user);
      await writeJson("pg_atomic_rollback.json", {
        user,
        shotId,
        statuses,
        afterFailure,
        retry: { status: retry.status, body: retry.body },
        afterRetry,
      });

      for (const s of statuses) assertStringIncludes(s, "shot.write_failed:");
      for (const s of statuses) assert(!/sqlerrm|purple/i.test(s), `status must carry SQLSTATE only: ${s}`);
      assertEquals(afterFailure.shots, []);
      assertEquals(afterFailure.phases, 0);
      assertEquals(afterFailure.checkpoints, 0);
      assertEquals(afterFailure.permits, [{ id: permit.permitId!, status: "reserved", outcome: null }]);
      assertEquals(envelopeProblems(retry), []);
      assertEquals(retry.status, 200);
      assertEquals(acceptedIds(retry), [shotId]);
      assertEquals(afterRetry.shots.map((s) => s.id), [shotId]);
      assertEquals(afterRetry.phases, RICH_DETAILS.phases.length);
      assertEquals(afterRetry.checkpoints, RICH_DETAILS.checkpoints.length);
      assertEquals(afterRetry.permits, [{ id: permit.permitId!, status: "finalized", outcome: "scored" }]);
    }),
});

interface PgFuzzRow {
  seed: number;
  user: string;
  batch: number;
  validShots: number;
  realPermits: number;
  reserveResults: string[];
  status: number;
  requestId: string | null;
  accepted: string[];
  rejectedCodes: Record<string, number>;
  replayed: boolean;
  rowsAfter: number;
  scoredRows: number;
  ok: boolean;
  failures: string[];
}

Deno.test({
  name:
    `stress pg fuzz: ${STRESS_PG_ITER} seeded batches (seed ${STRESS_PG_SEED}) against Postgres — accepted ⇔ row written, rejected ⇒ no row, ≤2 scored, permits consumed exactly once`,
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () =>
    withPg(async (h, pg, users) => {
      const rows: PgFuzzRow[] = [];
      const started = performance.now();
      for (let i = 0; i < STRESS_PG_ITER; i++) {
        const seed = iterationSeed(STRESS_PG_SEED, i);
        const p = new Prng(seed);
        const user = await newUser(pg, users);
        const mark = canary(seed);
        const n = p.int(1, 6);
        const shots: Record<string, unknown>[] = [];
        const expected = new Map<string, string>(); // id → "accepted" | code
        const reserveResults: string[] = [];
        let realPermits = 0;
        let scoredBudget = 2;
        for (let k = 0; k < n; k++) {
          const g = generateShot(p, mark, p.chance(0.5));
          const verdict = referenceValidate(g.raw);
          if (!verdict.ok) {
            shots.push(g.raw as Record<string, unknown>);
            expected.set(verdict.id, verdict.code);
            continue;
          }
          const shot = { ...(g.raw as Record<string, unknown>) };
          const wantsPermit = p.chance(0.75);
          let permitReal = false;
          if (wantsPermit) {
            const r = await reserve(pg, user, `fz-${k}`);
            reserveResults.push(r.result);
            if (r.result === "accepted" && r.permitId) {
              shot.analysisPermitId = r.permitId;
              permitReal = true;
              realPermits += 1;
            }
          }
          // Session ids are random → never owned → shot.session_not_found
          // (after the permit check). Force null on half the valid shots so
          // acceptance is reachable.
          if (p.chance(0.5)) shot.sessionId = null;
          shots.push(shot);
          const id = String(shot.id);
          if (!permitReal) {
            expected.set(id, "access.permit_not_found");
          } else if (shot.sessionId !== null) {
            expected.set(id, "shot.session_not_found");
          } else if (shot.resultKind === "scored" && scoredBudget === 0) {
            expected.set(id, "access.paywall_required");
          } else {
            if (shot.resultKind === "scored") scoredBudget -= 1;
            expected.set(id, "accepted");
          }
        }
        const reply = await call(h, syncRequest(user, { shots }));
        const replayed = p.chance(0.3);
        const replay = replayed ? await call(h, syncRequest(user, { shots })) : null;
        const state = await userState(pg, user);

        const failures = envelopeProblems(reply);
        if (reply.status !== 200) failures.push(`HTTP ${reply.status}: ${reply.text.slice(0, 160)}`);
        const accepted = acceptedIds(reply).sort();
        const rej = rejected(reply);
        const wantAccepted = [...expected.entries()].filter(([, v]) => v === "accepted").map(([id]) => id).sort();
        if (JSON.stringify(accepted) !== JSON.stringify(wantAccepted)) {
          failures.push(`acceptedIds ${JSON.stringify(accepted)} ≠ oracle ${JSON.stringify(wantAccepted)}`);
        }
        for (const r of rej) {
          const want = expected.get(r.id);
          if (want === undefined) failures.push(`rejected unknown id ${r.id}`);
          else if (want === "accepted") failures.push(`oracle accepted ${r.id} but route rejected ${r.code}`);
          else if (want !== r.code) failures.push(`rejected ${r.id}: code ${r.code} ≠ oracle ${want}`);
          if (typeof r.message !== "string" || !r.message) failures.push(`rejected ${r.id}: no message`);
        }
        if (accepted.length + rej.length !== shots.length) {
          failures.push(`accepted+rejected ${accepted.length}+${rej.length} ≠ ${shots.length} shots`);
        }
        const rowIds = state.shots.map((s) => s.id).sort();
        if (JSON.stringify(rowIds) !== JSON.stringify(accepted)) {
          failures.push(`rows ${JSON.stringify(rowIds)} ≠ acceptedIds ${JSON.stringify(accepted)}`);
        }
        const scoredRows = state.shots.filter((s) => s.result_kind === "scored").length;
        if (scoredRows > 2) failures.push(`${scoredRows} scored rows for a non-premium identity`);
        if (state.lifetime !== scoredRows) failures.push(`lifetime_scored_count ${state.lifetime} ≠ ${scoredRows}`);
        const finalized = state.permits.filter((x) => x.status === "finalized").length;
        if (finalized !== scoredRows) failures.push(`${finalized} finalized permits ≠ ${scoredRows} scored rows`);
        const releasedLow = state.permits.filter((x) =>
          x.status === "released" && x.outcome === "low_confidence"
        ).length;
        const lowRows = state.shots.filter((s) => s.result_kind === "low_confidence").length;
        if (releasedLow !== lowRows) failures.push(`${releasedLow} released(low_confidence) permits ≠ ${lowRows} rows`);
        if (replay) {
          failures.push(...envelopeProblems(replay).map((x) => `replay: ${x}`));
          if (replay.status !== 200) failures.push(`replay HTTP ${replay.status}`);
          if (JSON.stringify(acceptedIds(replay).sort()) !== JSON.stringify(accepted)) {
            failures.push(
              `replay acceptedIds ${JSON.stringify(acceptedIds(replay))} ≠ first ${JSON.stringify(accepted)}`,
            );
          }
          const after = await userState(pg, user);
          if (JSON.stringify(after.shots) !== JSON.stringify(state.shots)) failures.push("replay changed shots rows");
          if (JSON.stringify(after.permits) !== JSON.stringify(state.permits)) failures.push("replay changed permits");
        }
        rows.push({
          seed,
          user,
          batch: shots.length,
          validShots: [...expected.values()].filter((v) =>
            !v.startsWith("shot.invalid") && v !== "shot.non_real_source"
          ).length,
          realPermits,
          reserveResults,
          status: reply.status,
          requestId: reply.requestId,
          accepted,
          rejectedCodes: histogram(rej.map((r) => r.code)),
          replayed,
          rowsAfter: state.shots.length,
          scoredRows,
          ok: failures.length === 0,
          failures,
        });
      }
      const failed = rows.filter((r) => !r.ok);
      const summary = {
        masterSeed: STRESS_PG_SEED,
        iterations: rows.length,
        requestsExecuted: rows.length + rows.filter((r) => r.replayed).length,
        elapsedMs: Math.round(performance.now() - started),
        statuses: histogram(rows.map((r) => r.status)),
        rejectedCodes: histogram(
          rows.flatMap((r) => Object.entries(r.rejectedCodes).flatMap(([c, k]) => Array(k).fill(c))),
        ),
        acceptedTotal: rows.reduce((s, r) => s + r.accepted.length, 0),
        rowsWritten: rows.reduce((s, r) => s + r.rowsAfter, 0),
        dbCalls: histogram(pg.calls.map((c) =>
          `${c.kind}:${c.outcome.startsWith("error") ? "error" : c.kind === "rpc" ? c.outcome : "ok"}`
        )),
        failed: failed.map((r) => ({ seed: r.seed, failures: r.failures })),
      };
      const rowsPath = await writeJson("pg_fuzz_results.json", rows);
      const summaryPath = await writeJson("pg_fuzz_summary.json", summary);
      console.log(
        `[stress pg fuzz] ${summary.requestsExecuted} requests / ${rows.length} seeds in ${summary.elapsedMs}ms — ${
          JSON.stringify(summary.statuses)
        } — failed ${failed.length} — ${rowsPath} ${summaryPath}`,
      );
      assertEquals(
        failed.map((r) =>
          `${r.seed}: ${r.failures.join(" | ")}`
        ),
        [],
      );
    }),
});
