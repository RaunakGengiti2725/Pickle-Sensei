/**
 * Audit tests for the `edge-routes-shots-rank` area: the database side of
 * POST /v1/shots:sync (apply_synced_shot), POST /v1/analysis-permits
 * (reserve_analysis_permit), and the rank formula parity between
 * `public.player_technique_rating` / `public.recompute_player_rank`
 * (20260831130000_form_weighted_rank.sql) and
 * `packages/shared-types/src/playerRank.ts` computePlayerRank.
 *
 * Runs against a throwaway Postgres that has the shim + every migration
 * applied (the same setup as supabase/tests/run_rls_tests.sh):
 *
 *   docker run -d --name pickle-audit -p 55432:5432 -e POSTGRES_PASSWORD=pg postgres:16
 *   docker cp supabase/tests pickle-audit:/tests && docker cp supabase/migrations pickle-audit:/migrations
 *   docker exec pickle-audit bash -c 'psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql \
 *     && for f in /migrations/*.sql; do psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"; done'
 *   PICKLE_AUDIT_PG_URL=postgres://postgres:pg@127.0.0.1:55432/postgres \
 *     deno test -A --config supabase/functions/api/__wf__/deno.json supabase/functions/api/__wf__/
 *
 * (`--config` points Deno at the local import map / nodeModulesDir=none so
 * the root pnpm workspace package.json is not picked up.) Without
 * PICKLE_AUDIT_PG_URL every test is skipped (ignore: true).
 */
import postgres from "postgres";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  computePlayerRank,
  type PlayerRankAnalysisInput,
} from "../../../../packages/shared-types/src/playerRank.ts";
import { fakeGoogleIdToken, loadHarness, userRequest } from "./routesHarness.ts";

const PG_URL = Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

const ALICE = "00000000-0000-4000-8000-00000000000a";

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

/** Same, with the Supabase-like `authenticated` role + the JWT sub the
 * shim's auth.uid() reads — exactly how the edge function's per-user
 * client reaches the RPCs. */
async function withUserTx(sql: Sql, userId: string, fn: (tx: Sql) => Promise<void>): Promise<void> {
  await withRollback(sql, async (tx) => {
    await tx.unsafe(
      `insert into auth.users (id, email) values ('${userId}', '${userId}@example.com') on conflict do nothing`,
    );
    await tx.unsafe(`set local role authenticated`);
    await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
    await fn(tx);
  });
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
  const rows = await tx.unsafe(
    `select result, permit_id from public.reserve_analysis_permit('${key}')`,
  );
  assertEquals(rows[0].result, "accepted");
  return String(rows[0].permit_id);
}

async function apply(tx: Sql, shot: Record<string, unknown>): Promise<string> {
  // text → jsonb: postgres.js would otherwise JSON-encode the string again
  // for a jsonb-typed parameter and the RPC would see a JSON string.
  const rows = await tx.unsafe(`select public.apply_synced_shot($1::text::jsonb) as status`, [
    JSON.stringify(shot),
  ]);
  return String(rows[0].status);
}

Deno.test({
  name: "apply_synced_shot: a failing detail insert rolls back the shot and leaves the permit reserved",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    try {
      await withUserTx(sql, ALICE, async (tx) => {
        const permitId = await reserve(tx, "atomic-1");
        const id = crypto.randomUUID();
        const status = await apply(
          tx,
          shotPayload({
            id,
            analysisPermitId: permitId,
            phases: [
              {
                key: "ready",
                startMs: 0,
                representativeMs: 10,
                endMs: 20,
                confidence: 0.9,
              },
            ],
            // "purple" passes nothing the edge parser accepts either; here it
            // stands in for ANY detail-row constraint failure.
            checkpoints: [
              {
                key: "x",
                score: 50,
                confidence: 0.5,
                band: "purple",
                direction: "up",
                severity: 0.1,
                applicable: true,
              },
            ],
          }),
        );
        assertStringIncludes(status, "shot.write_failed:");
        const shots = await tx.unsafe(
          `select count(*)::int as n from public.shots where id = '${id}'`,
        );
        assertEquals(shots[0].n, 0);
        const phases = await tx.unsafe(
          `select count(*)::int as n from public.shot_phases where shot_id = '${id}'`,
        );
        assertEquals(phases[0].n, 0);
        const permit = await tx.unsafe(
          `select status, outcome from public.analysis_permits where id = '${permitId}'`,
        );
        assertEquals(permit[0].status, "reserved");
        assertEquals(permit[0].outcome, null);
      });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "apply_synced_shot: accepted scored shot finalizes the permit, refreshes rank state, and replays idempotently",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    try {
      await withUserTx(sql, ALICE, async (tx) => {
        const permitId = await reserve(tx, "accept-1");
        const shot = shotPayload({
          analysisPermitId: permitId,
          overallScore: 7.3,
        });
        assertEquals(await apply(tx, shot), "accepted");
        const permit = await tx.unsafe(
          `select status, outcome from public.analysis_permits where id = '${permitId}'`,
        );
        assertEquals(permit[0].status, "finalized");
        assertEquals(permit[0].outcome, "scored");
        const state = await tx.unsafe(
          `select rating::text as rating, tier, technique_count, scored_shot_count from public.player_rank_state`,
        );
        assertEquals(state.length, 1);
        assertEquals(state[0].rating, "7.30");
        assertEquals(state[0].tier, "platinum");
        // Replay (same id, permit already finalized) is acknowledged, not rewritten.
        assertEquals(await apply(tx, shot), "accepted");
        const count = await tx.unsafe(`select count(*)::int as n from public.shots`);
        assertEquals(count[0].n, 1);
      });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "free limit: after two scored analyses the third permit is refused (access.paywall_required)",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    try {
      await withUserTx(sql, ALICE, async (tx) => {
        const p1 = await reserve(tx, "free-1");
        assertEquals(await apply(tx, shotPayload({ analysisPermitId: p1 })), "accepted");
        // Reserve the 2nd permit BEFORE the 2nd sync lands, then a 3rd permit
        // must be refused once two scored shots exist.
        const p2 = await reserve(tx, "free-2");
        assertEquals(
          await apply(tx, shotPayload({ analysisPermitId: p2, shotType: "serve" })),
          "accepted",
        );
        const third = await tx.unsafe(
          `select result from public.reserve_analysis_permit('free-3')`,
        );
        assertEquals(third[0].result, "access.paywall_required");
        const access = await tx.unsafe(`select * from public.access_state()`);
        assertEquals(access[0].premium, false);
        assertEquals(access[0].scored_count, 2);
        assertEquals(access[0].reserved_count, 0);
      });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "apply_synced_shot: values the edge parser accepts but the schema rejects surface as shot.write_failed (retryable) instead of validation errors",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    try {
      await withUserTx(sql, ALICE, async (tx) => {
        const permitId = await reserve(tx, "bounds-1");
        // parseSyncShot allows versionVector values up to 128 chars
        // (index.ts:787); shots_text_bounds caps them at 64.
        const tooLong = await apply(
          tx,
          shotPayload({
            analysisPermitId: permitId,
            versionVector: { ...VERSION_VECTOR, appVersion: "a".repeat(100) },
          }),
        );
        // The detail is the SQLSTATE class only (20260904000000): 23514 =
        // check_violation (shots_text_bounds). Never sqlerrm, which would
        // echo the client's value into the edge logs.
        assertEquals(tooLong, "shot.write_failed:23514");
        // parseSyncShot's isMs accepts any non-negative integer
        // (index.ts:662); the RPC casts to int4.
        const tooBig = await apply(
          tx,
          shotPayload({ analysisPermitId: permitId, endMs: 2147483648 }),
        );
        // 22003 = numeric_value_out_of_range (int4 cast).
        assertEquals(tooBig, "shot.write_failed:22003");
        // Nothing was written and the permit is still usable.
        const permit = await tx.unsafe(
          `select status from public.analysis_permits where id = '${permitId}'`,
        );
        assertEquals(permit[0].status, "reserved");
      });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "progress_daily: one year of three-technique daily practice exceeds PostgREST's default 1000-row cap",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    try {
      await withRollback(sql, async (tx) => {
        const userId = crypto.randomUUID();
        await tx.unsafe(
          `insert into auth.users (id, email) values ('${userId}', '${userId}@example.com')`,
        );
        // GET /v1/progress reads progress_daily with .eq(user_id).order(day)
        // and NO .limit()/.range() (index.ts:1403-1408). Hosted Supabase's
        // Data API caps unpaged responses at max_rows = 1000, so the newest
        // rows fall off first for a user with this much history.
        await tx.unsafe(
          `insert into public.shots
             (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
              overall_score, analysis_confidence, result_kind,
              app_version, model_bundle_version, pose_model_version, paddle_model_version,
              stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
           select gen_random_uuid(), '${userId}', t.shot_type, 'side',
                  timestamptz '2025-09-01 12:00:00+00' + (d.n * interval '1 day'),
                  0, 100, 200, 6.5, 0.9, 'scored',
                  '1', '1', '1', '1', '1', '1', '1', '1'
             from generate_series(0, 364) as d(n)
            cross join (values ('dink'), ('serve'), ('drive')) as t(shot_type)`,
        );
        const rows = await tx.unsafe(
          `select count(*)::int as n from public.progress_daily where user_id = '${userId}'`,
        );
        assertEquals(rows[0].n, 1095);
        assert(rows[0].n > 1000, "progress_daily cardinality must exceed the default max_rows");
      });
    } finally {
      await sql.end();
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Rank formula parity: SQL view + recompute vs shared-types computePlayerRank
// ─────────────────────────────────────────────────────────────────────────────

/** Deterministic PRNG so a failure reproduces from the printed seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TECHNIQUES = ["dink", "serve", "drive", "third_shot_drop", "volley", "lob", "reset"];

interface SeedShot {
  id: string;
  shotType: string;
  capturedAt: string;
  overallScore: number | null;
  resultKind: "scored" | "low_confidence";
}

function randomShots(rand: () => number, n: number): SeedShot[] {
  const instants: string[] = [];
  const out: SeedShot[] = [];
  for (let i = 0; i < n; i++) {
    // ~25% of rows reuse an earlier capture instant so id tie-breaks matter.
    let capturedAt: string;
    if (instants.length > 0 && rand() < 0.25) {
      capturedAt = instants[Math.floor(rand() * instants.length)]!;
    } else {
      const ms = Date.UTC(2026, 0, 1) + Math.floor(rand() * 240 * 24 * 3600 * 1000);
      capturedAt = new Date(ms).toISOString();
      instants.push(capturedAt);
    }
    const lowConfidence = rand() < 0.12;
    // Production scorer emits tenths (packages/scoring/src/engine.ts:147);
    // also exercise hundredths, which the numeric(4,2) column stores exactly.
    const score = rand() < 0.5 ? Math.round(rand() * 100) / 10 : Math.round(rand() * 1000) / 100;
    out.push({
      id: crypto.randomUUID(),
      shotType: TECHNIQUES[Math.floor(rand() * TECHNIQUES.length)]!,
      capturedAt,
      overallScore: lowConfidence ? null : score,
      resultKind: lowConfidence ? "low_confidence" : "scored",
    });
  }
  return out;
}

Deno.test({
  name: "rank parity: player_technique_rating + recompute_player_rank match computePlayerRank on seeded histories",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    const seed = Number(Deno.env.get("PICKLE_AUDIT_SEED") ?? "20260901");
    const rand = mulberry32(seed);
    try {
      for (let round = 0; round < 40; round++) {
        const userId = crypto.randomUUID();
        const n = 1 + Math.floor(rand() * 60);
        const shots = randomShots(rand, n);
        // Insert as superuser (bypasses permits/free-limit) — the trigger
        // still refreshes player_rank_state for every row.
        await withRollback(sql, async (tx) => {
          {
            await tx.unsafe(
              `insert into auth.users (id, email) values ('${userId}', '${userId}@example.com')`,
            );
            for (const s of shots) {
              await tx.unsafe(
                `insert into public.shots
                   (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
                    overall_score, analysis_confidence, result_kind,
                    app_version, model_bundle_version, pose_model_version, paddle_model_version,
                    stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
                 values ($1, $2, $3, 'side', $4, 0, 100, 200, $5, 0.9, $6,
                         '1', '1', '1', '1', '1', '1', '1', '1')`,
                [s.id, userId, s.shotType, s.capturedAt, s.overallScore, s.resultKind],
              );
            }
            const expected = computePlayerRank(
              shots.map<PlayerRankAnalysisInput>((s) => ({
                id: s.id,
                shotType: s.shotType,
                capturedAt: s.capturedAt,
                overallScore: s.overallScore,
                resultKind: s.resultKind,
                source: "real",
              })),
            );
            const view = await tx.unsafe(
              `select shot_type, score::text as score, captured_at, sampled_count, confidence_weight
                 from public.player_technique_rating where user_id = '${userId}' order by shot_type`,
            );
            const state = await tx.unsafe(
              `select rating::text as rating, tier, technique_count, scored_shot_count
                 from public.player_rank_state where user_id = '${userId}'`,
            );
            const ctx = `seed=${seed} round=${round} user=${userId}`;
            if (!expected) {
              assertEquals(view.length, 0, ctx);
              assertEquals(state.length, 0, ctx);
            } else {
              assertEquals(state.length, 1, ctx);
              assertEquals(Number(state[0].rating), expected.rating, `${ctx} rating`);
              assertEquals(state[0].tier, expected.tier, `${ctx} tier`);
              assertEquals(
                state[0].technique_count,
                expected.techniqueCount,
                `${ctx} techniqueCount`,
              );
              assertEquals(
                state[0].scored_shot_count,
                expected.scoredAnalysisCount,
                `${ctx} scoredAnalysisCount`,
              );
              const byType = new Map(expected.techniques.map((t) => [t.shotType, t]));
              assertEquals(view.length, byType.size, `${ctx} technique rows`);
              let confidenceSum = 0;
              let weightedHundredths = 0;
              for (const row of view) {
                const t = byType.get(String(row.shot_type));
                assert(t, `${ctx} unexpected technique ${row.shot_type}`);
                assertEquals(Number(row.score), t.score, `${ctx} ${row.shot_type} score`);
                assertEquals(
                  new Date(row.captured_at as string).toISOString(),
                  t.capturedAt,
                  `${ctx} ${row.shot_type} captured_at`,
                );
                assertEquals(
                  row.sampled_count,
                  t.sampledCount,
                  `${ctx} ${row.shot_type} sampled_count`,
                );
                // Edge fallback (index.ts:1563-1575) over the view's rows.
                const w = Number(row.confidence_weight);
                confidenceSum += w;
                weightedHundredths += w * Math.round(Number(row.score) * 100);
              }
              assertEquals(
                Math.round(weightedHundredths / confidenceSum) / 100,
                expected.rating,
                `${ctx} edge fallback rating`,
              );
            }
          }
        });
      }
    } finally {
      await sql.end();
    }
  },
});

// ─── Permit backing is NULL-safe; the lifecycle is closed (OFF-24H-02) ──────
// 20260906140000_permit_lifecycle_null_safe.sql. A released/NULL permit was
// client-reachable and the round-6 backing predicate evaluated to NULL on it,
// so the RPC fell through: 42501 → shot.write_failed (retried forever), or —
// beside an unrelated live reservation — an ACCEPTED shot, twice.

/** Puts an existing permit into the pre-fix released/NULL state the way only
 * legacy rows can be in it now: as the owner with the lifecycle guard off.
 * Restores the authenticated session afterwards. */
async function forceReleasedNull(tx: Sql, userId: string, permitId: string): Promise<void> {
  await tx.unsafe(`reset role`);
  await tx.unsafe(
    `alter table public.analysis_permits disable trigger analysis_permits_guard_lifecycle`,
  );
  await tx.unsafe(
    `update public.analysis_permits set status = 'released', outcome = null where id = '${permitId}'`,
  );
  await tx.unsafe(
    `alter table public.analysis_permits enable trigger analysis_permits_guard_lifecycle`,
  );
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

async function shotCount(tx: Sql, userId: string): Promise<number> {
  const rows = await tx.unsafe(
    `select count(*)::int as n from public.shots where user_id = '${userId}'`,
  );
  return Number(rows[0].n);
}

Deno.test({
  name: "apply_synced_shot: a released/NULL permit is refused with access.permit_not_reserved — alone, beside an unrelated live reservation, and on a second shot — and never backs a row",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    const user = "00000000-0000-4000-8000-00000000002a";
    try {
      await withUserTx(sql, user, async (tx) => {
        const stale = await reserve(tx, "off24h02-stale");
        await forceReleasedNull(tx, user, stale);

        // no other permit: the verdict, not shot.write_failed:42501
        assertEquals(
          await apply(tx, shotPayload({ analysisPermitId: stale })),
          "access.permit_not_reserved",
        );
        assertEquals(await shotCount(tx, user), 0);

        // an unrelated LIVE reservation must not rescue the named permit
        const live = await reserve(tx, "off24h02-live");
        const first = crypto.randomUUID();
        assertEquals(
          await apply(tx, shotPayload({ id: first, analysisPermitId: stale })),
          "access.permit_not_reserved",
        );
        assertEquals(
          await apply(tx, shotPayload({ analysisPermitId: stale })),
          "access.permit_not_reserved",
          "second shot on the same released/NULL permit",
        );
        assertEquals(await shotCount(tx, user), 0);
        const permit = await tx.unsafe(
          `select status, outcome from public.analysis_permits where id = '${stale}'`,
        );
        assertEquals(permit[0].status, "released");
        assertEquals(permit[0].outcome, null);

        // the live reservation still backs ITS OWN shot exactly once
        assertEquals(await apply(tx, shotPayload({ analysisPermitId: live })), "accepted");
        assertEquals(
          await apply(tx, shotPayload({ analysisPermitId: live })),
          "access.permit_not_reserved",
          "one permit backs one shot",
        );
        assertEquals(await shotCount(tx, user), 1);
      });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "analysis_permits lifecycle guard: a client UPDATE to released/NULL is refused with 23514 + access.permit_transition_rejected, a legal finalize still lands, and a settled permit is terminal",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    const user = "00000000-0000-4000-8000-00000000002b";
    try {
      await withUserTx(sql, user, async (tx) => {
        const permitId = await reserve(tx, "off24h02-guard");
        const forge = async (set: string) => {
          // savepoint so the refused statement does not abort the outer tx
          await tx.unsafe(`savepoint forge`);
          try {
            await tx.unsafe(`update public.analysis_permits set ${set} where id = '${permitId}'`);
          } catch (error) {
            await tx.unsafe(`rollback to savepoint forge`);
            const pgError = error as { code?: string; hint?: string };
            assertEquals(pgError.code, "23514", set);
            assertEquals(pgError.hint, "access.permit_transition_rejected", set);
            return;
          }
          throw new Error(`expected 23514 for: ${set}`);
        };
        await forge(`status = 'released', outcome = null`);
        await forge(`status = 'finalized', outcome = null`);
        await forge(`status = 'released', outcome = 'bogus'`);
        const untouched = await tx.unsafe(
          `select status, outcome from public.analysis_permits where id = '${permitId}'`,
        );
        assertEquals(untouched[0].status, "reserved");
        assertEquals(untouched[0].outcome, null);

        // exactly what POST /v1/analysis-permits/:id/finalize writes
        await tx.unsafe(
          `update public.analysis_permits set status = 'finalized', outcome = 'cancelled'
            where id = '${permitId}' and status = 'reserved'`,
        );
        await forge(`status = 'reserved', outcome = null`);
        await forge(`status = 'released', outcome = 'expired'`);
        assertEquals(
          await apply(tx, shotPayload({ analysisPermitId: permitId })),
          "access.permit_not_reserved",
        );
      });
    } finally {
      await sql.end();
    }
  },
});

// ─── Rank/progress cache vs accepted shots:sync (EDR-3) ─────────────────────
// These cases drive the REAL edge handler through routesHarness (PostgREST /
// GoTrue stubbed at fetch level) and therefore run without PICKLE_AUDIT_PG_URL.
//
// AGENTS.md "Scale & security": rank/progress responses cache 60 s and are
// invalidated by accepted shot syncs. A build that read the database BEFORE a
// sync landed must not write its pre-sync payload back over that invalidation.

const h = await loadHarness();

type FetchFn = typeof fetch;

/** Wrap the harness fetch for one test: `intercept` may return a Response for
 * requests it wants to own; anything else falls through (and is recorded). */
async function withFetchIntercept<T>(
  intercept: (request: Request) => Promise<Response | null>,
  run: () => Promise<T>,
): Promise<T> {
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const owned = await intercept(request.clone());
    if (owned) return owned;
    return inner(input, init);
  }) as FetchFn;
  try {
    return await run();
  } finally {
    globalThis.fetch = inner;
  }
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function syncShotBody(id = crypto.randomUUID()) {
  return {
    shots: [
      {
        id,
        source: "real",
        analysisPermitId: crypto.randomUUID(),
        sessionId: null,
        shotType: "dink",
        cameraView: "side",
        capturedAt: new Date().toISOString(),
        timestamps: { startMs: 0, contactMs: 500, endMs: 1000 },
        resultKind: "scored",
        overallScore: 7.5,
        confidence: 0.9,
        phases: [],
        checkpoints: [],
        versionVector: VERSION_VECTOR,
      },
    ],
  };
}

/** Rank/progress cache keys are per user and the harness never clears the
 * cache module, so every scenario signs in as its own subject. */
function cacheUser(userId: string) {
  h.reset();
  h.tables.profiles = [{ id: userId, email: "u@example.com", provider: "google" }];
  h.tables.shots = [];
  h.rpcs.apply_synced_shot = "accepted";
  return { token: fakeGoogleIdToken(userId) };
}

Deno.test(
  "GET /v1/progress: a build that read before an accepted shots:sync must not re-cache the pre-sync payload",
  async () => {
    const auth = cacheUser("dddddddd-0001-4ddd-8ddd-dddddddddddd");
    const ip = "203.0.113.61";
    h.tables.progress_daily = [];
    h.tables.practice_days = [];

    let releaseRead!: () => void;
    const gate = new Promise<void>((resolve) => (releaseRead = resolve));
    let readReached!: () => void;
    const reached = new Promise<void>((resolve) => (readReached = resolve));
    let gated = false;

    await withFetchIntercept(
      async (request) => {
        if (!gated && request.url.includes("/rest/v1/progress_daily")) {
          gated = true;
          readReached();
          await gate;
          // Pre-sync snapshot: no daily aggregates yet.
          return jsonResponse(200, []);
        }
        return null;
      },
      async () => {
        // 1. Cache miss → build starts and blocks inside its DB read.
        const inflight = h.handler(userRequest("GET", "/v1/progress", { ...auth, ip }));
        await reached;

        // 2. Accepted sync → invalidates rank:/progress: for this user.
        const synced = await h.handler(
          userRequest("POST", "/v1/shots:sync", { ...auth, ip, body: syncShotBody() }),
        );
        assertEquals(synced.status, 200);
        assertEquals(((await synced.json()) as { acceptedIds: string[] }).acceptedIds.length, 1);

        // 3. Post-sync truth: one aggregated day now exists.
        const today = new Date().toISOString().slice(0, 10);
        h.tables.progress_daily = [
          {
            day: today,
            shot_type: "dink",
            scoring_model_version: "scoring-1",
            shot_count: 1,
            avg_score: 7.5,
            best_score: 7.5,
          },
        ];
        h.tables.practice_days = [{ day: today }];

        // 4. The stale build completes with the pre-sync rows.
        releaseRead();
        const stale = await inflight;
        assertEquals(stale.status, 200);
        assertEquals(((await stale.json()) as { series: unknown[] }).series, []);

        // 5. The next read must be a DB-backed build, not a cache hit.
        const readsBefore = h.callsTo("/rest/v1/progress_daily").length;
        const after = await h.handler(userRequest("GET", "/v1/progress", { ...auth, ip }));
        assertEquals(after.status, 200);
        assertEquals(
          h.callsTo("/rest/v1/progress_daily").length,
          readsBefore + 1,
          "post-sync GET /v1/progress was served from the re-cached pre-sync payload",
        );
        const payload = (await after.json()) as {
          series: unknown[];
          streak: { practicedToday: boolean };
        };
        assertEquals(payload.series.length, 1);
        assertEquals(payload.streak.practicedToday, true);
      },
    );
  },
);

Deno.test(
  "GET /v1/rank: back-to-back reads with no intervening sync make exactly one PostgREST read (60 s cache + coalesce)",
  async () => {
    const auth = cacheUser("dddddddd-0002-4ddd-8ddd-dddddddddddd");
    const ip = "203.0.113.62";
    h.tables.player_technique_rating = [
      {
        shot_type: "dink",
        score: 7.5,
        captured_at: new Date().toISOString(),
        sampled_count: 1,
        confidence_weight: 1,
      },
    ];
    h.tables.player_rank_state = [];

    const first = await h.handler(userRequest("GET", "/v1/rank", { ...auth, ip }));
    assertEquals(first.status, 200);
    const firstBody = await first.json();
    const second = await h.handler(userRequest("GET", "/v1/rank", { ...auth, ip }));
    assertEquals(second.status, 200);
    assertEquals(await second.json(), firstBody);
    assertEquals(h.callsTo("/rest/v1/player_technique_rating").length, 1);

    // Concurrent misses coalesce into the single in-flight build.
    const coalescedUser = cacheUser("dddddddd-0003-4ddd-8ddd-dddddddddddd");
    h.tables.player_technique_rating = [];
    const [a, b] = await Promise.all([
      h.handler(userRequest("GET", "/v1/rank", { ...coalescedUser, ip })),
      h.handler(userRequest("GET", "/v1/rank", { ...coalescedUser, ip })),
    ]);
    assertEquals([a.status, b.status], [200, 200]);
    assertEquals(await a.json(), { rank: null });
    assertEquals(await b.json(), { rank: null });
    assertEquals(h.callsTo("/rest/v1/player_technique_rating").length, 1);
  },
);

// ─── POST /v1/analysis-permits/:id/finalize vs the lifecycle guard ──────────
// analysis_permits_guard_lifecycle refuses an illegal permit transition with
// SQLSTATE 23514 + hint access.permit_transition_rejected; PostgREST relays
// it as a 400 with that body. The edge must answer a 4xx conflict the app
// treats as a verdict — never a 503 the outbox would retry.

const PERMIT_ID = "eeeeeeee-0001-4eee-8eee-eeeeeeeeeeee";

function finalizeUser(userId: string) {
  h.reset();
  h.tables.profiles = [{ id: userId, email: "u@example.com", provider: "google" }];
  h.tables.analysis_permits = [
    {
      id: PERMIT_ID,
      status: "reserved",
      outcome: null,
      created_at: new Date().toISOString(),
    },
  ];
  h.rpcs.access_state = { scored_count: 0, reserved_count: 0, premium: false, premium_until: null };
  return { token: fakeGoogleIdToken(userId) };
}

Deno.test(
  "POST /v1/analysis-permits/:id/finalize: a transition the lifecycle guard refuses (23514 + hint) is a 409 access.permit_transition_rejected, not a 503",
  async () => {
    const auth = finalizeUser("eeeeeeee-0002-4eee-8eee-eeeeeeeeeeee");
    const ip = "203.0.113.71";
    const res = await withFetchIntercept(
      async (request) => {
        if (request.method !== "PATCH" || !request.url.includes("/rest/v1/analysis_permits")) {
          return null;
        }
        return jsonResponse(400, {
          code: "23514",
          message:
            "analysis_permits: illegal permit transition finalized/scored -> finalized/cancelled",
          details: null,
          hint: "access.permit_transition_rejected",
        });
      },
      () =>
        h.handler(
          userRequest("POST", `/v1/analysis-permits/${PERMIT_ID}/finalize`, {
            ...auth,
            ip,
            body: { outcome: "cancelled", ratingId: null },
          }),
        ),
    );
    assertEquals(res.status, 409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assertEquals(body.error.code, "access.permit_transition_rejected");
  },
);

Deno.test(
  "POST /v1/analysis-permits/:id/finalize: any other PostgREST write error is still the generic retryable 503",
  async () => {
    const auth = finalizeUser("eeeeeeee-0003-4eee-8eee-eeeeeeeeeeee");
    const ip = "203.0.113.72";
    const res = await withFetchIntercept(
      async (request) => {
        if (request.method !== "PATCH" || !request.url.includes("/rest/v1/analysis_permits")) {
          return null;
        }
        return jsonResponse(400, {
          code: "23514",
          message: "some other check constraint",
          details: null,
          hint: null,
        });
      },
      () =>
        h.handler(
          userRequest("POST", `/v1/analysis-permits/${PERMIT_ID}/finalize`, {
            ...auth,
            ip,
            body: { outcome: "cancelled", ratingId: null },
          }),
        ),
    );
    assertEquals(res.status, 503);
  },
);
