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
 * PICKLE_AUDIT_PG_URL every Postgres test is skipped (ignore: true).
 *
 * The "rank/progress cache" tests at the end drive the REAL edge handler via
 * routesHarness (fetch-level PostgREST stubs, no database) and always run.
 */
import postgres from "postgres";
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
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
        assertStringIncludes(tooLong, "shot.write_failed:");
        assertStringIncludes(tooLong, "shots_text_bounds");
        // parseSyncShot's isMs accepts any non-negative integer
        // (index.ts:662); the RPC casts to int4.
        const tooBig = await apply(
          tx,
          shotPayload({ analysisPermitId: permitId, endMs: 2147483648 }),
        );
        assertStringIncludes(tooBig, "shot.write_failed:");
        assertStringIncludes(tooBig, "out of range for type integer");
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

// ─────────────────────────────────────────────────────────────────────────────
// Rank/progress cache: an accepted shots:sync invalidates rank:/progress:
// (AGENTS.md "Scale & security"). A build that read the DB BEFORE the sync
// and finishes AFTER the sync's cacheDel must not write its pre-sync payload
// back into the 60 s cache; the 60 s cache + single-flight coalescing must
// keep working for reads with no intervening sync.
// ─────────────────────────────────────────────────────────────────────────────

const h = await loadHarness();

type FetchFn = typeof fetch;

/** Wrap the harness fetch for one test: `intercept` may return a Response for
 * requests it wants to own (they are still recorded in h.calls); anything else
 * falls through to the harness stubs. */
async function withFetchIntercept<T>(
  intercept: (request: Request) => Promise<Response | null>,
  run: () => Promise<T>,
): Promise<T> {
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const owned = await intercept(request.clone());
    if (owned) {
      h.calls.push({ url: request.url, method: request.method, headers: {}, body: null });
      return owned;
    }
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

function syncShotBody() {
  return {
    shots: [
      {
        id: crypto.randomUUID(),
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
        versionVector: {
          appVersion: "1.0.0",
          modelBundleVersion: "1",
          poseModelVersion: "1",
          paddleModelVersion: "1",
          strokeDetectorVersion: "1",
          phaseModelVersion: "1",
          scoringModelVersion: "1",
          shotConfigVersion: "1",
        },
      },
    ],
  };
}

const postgrestReads = (table: string) =>
  h.calls.filter((call) => call.method === "GET" && call.url.includes(`/rest/v1/${table}`));

/** A fresh user (and IP) per test so no earlier test's 60 s cache entry or
 * rate-limit window is in play. */
let userCounter = 0;
function freshUser() {
  userCounter += 1;
  const userId = crypto.randomUUID();
  const token = fakeGoogleIdToken(userId);
  h.tables.profiles = [{ id: userId, email: "u@example.com", provider: "google" }];
  return { userId, token, ip: `203.0.113.${100 + userCounter}` };
}

Deno.test(
  "GET /v1/progress: a build that read before an accepted shots:sync must not re-cache the pre-sync payload; the next GET is a DB-backed build",
  async () => {
    h.reset();
    const { token, ip } = freshUser();
    h.tables.shots = [];
    h.rpcs.apply_synced_shot = "accepted";
    h.tables.progress_daily = [];
    h.tables.practice_days = [];
    const today = new Date().toISOString().slice(0, 10);

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
          return jsonResponse(200, []); // pre-sync snapshot: nothing practised
        }
        return null;
      },
      async () => {
        // 1. Cache miss → build starts and blocks inside its DB read.
        const inflight = h.handler(userRequest("GET", "/v1/progress", { token, ip }));
        await reached;

        // 2. Accepted sync → cacheDel(rank, progress).
        const synced = await h.handler(
          userRequest("POST", "/v1/shots:sync", { token, ip, body: syncShotBody() }),
        );
        assertEquals(synced.status, 200);
        assertEquals(((await synced.json()) as { acceptedIds: string[] }).acceptedIds.length, 1);

        // 3. Post-sync truth.
        h.tables.progress_daily = [
          {
            day: today,
            shot_type: "dink",
            scoring_model_version: "1",
            shot_count: 1,
            avg_score: 7.5,
            best_score: 7.5,
          },
        ];
        h.tables.practice_days = [{ day: today }];

        // 4. The stale build completes (its own response is the pre-sync view).
        releaseRead();
        const stale = await inflight;
        assertEquals(stale.status, 200);
        assertEquals(((await stale.json()) as { series: unknown[] }).series, []);

        // 5. The next GET is a fresh DB-backed build that reflects the sync.
        const readsBefore = postgrestReads("progress_daily").length;
        const after = await h.handler(userRequest("GET", "/v1/progress", { token, ip }));
        assertEquals(after.status, 200);
        const payload = (await after.json()) as {
          series: Array<{ day: string; shot_count: number }>;
          streak: { practicedToday: boolean };
        };
        assertEquals(
          postgrestReads("progress_daily").length,
          readsBefore + 1,
          "post-sync GET must re-read PostgREST, not serve the re-cached stale payload",
        );
        assertEquals(payload.series.length, 1, JSON.stringify(payload));
        assertEquals(payload.series[0]?.day, today);
        assertEquals(payload.streak.practicedToday, true);

        // 6. …and THAT payload is cached again: the following GET is a hit.
        const again = await h.handler(userRequest("GET", "/v1/progress", { token, ip }));
        assertEquals(again.status, 200);
        assertEquals(((await again.json()) as { series: unknown[] }).series.length, 1);
        assertEquals(postgrestReads("progress_daily").length, readsBefore + 1, "cache hit");
      },
    );
  },
);

Deno.test(
  "GET /v1/rank: a build that read before an accepted shots:sync must not re-cache the pre-sync {rank:null}",
  async () => {
    h.reset();
    const { token, ip } = freshUser();
    h.tables.shots = [];
    h.rpcs.apply_synced_shot = "accepted";

    let releaseRead!: () => void;
    const gate = new Promise<void>((resolve) => (releaseRead = resolve));
    let readReached!: () => void;
    const reached = new Promise<void>((resolve) => (readReached = resolve));
    let gated = false;

    await withFetchIntercept(
      async (request) => {
        if (!gated && request.url.includes("/rest/v1/player_technique_rating")) {
          gated = true;
          readReached();
          await gate;
          return jsonResponse(200, []);
        }
        return null;
      },
      async () => {
        const inflight = h.handler(userRequest("GET", "/v1/rank", { token, ip }));
        await reached;
        const synced = await h.handler(
          userRequest("POST", "/v1/shots:sync", { token, ip, body: syncShotBody() }),
        );
        assertEquals(synced.status, 200);
        await synced.body?.cancel();
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
        releaseRead();
        const stale = await inflight;
        assertEquals(await stale.json(), { rank: null });

        const readsBefore = postgrestReads("player_technique_rating").length;
        const after = await h.handler(userRequest("GET", "/v1/rank", { token, ip }));
        assertEquals(after.status, 200);
        const payload = (await after.json()) as { rank: { rating: number } | null };
        assertEquals(postgrestReads("player_technique_rating").length, readsBefore + 1);
        assertNotEquals(
          payload.rank,
          null,
          "stale pre-sync {rank:null} served after an accepted sync",
        );
        assertEquals(payload.rank?.rating, 7.5);
      },
    );
  },
);

Deno.test(
  "GET /v1/rank: back-to-back reads with no intervening sync make exactly one PostgREST read (coalesce + 60 s cache)",
  async () => {
    h.reset();
    const { token, ip } = freshUser();
    h.tables.player_technique_rating = [
      {
        shot_type: "dink",
        score: 6.2,
        captured_at: new Date().toISOString(),
        sampled_count: 3,
        confidence_weight: 3,
      },
    ];
    h.tables.player_rank_state = [];

    // Two concurrent cache misses share ONE in-flight build.
    const [first, second] = await Promise.all([
      h.handler(userRequest("GET", "/v1/rank", { token, ip })),
      h.handler(userRequest("GET", "/v1/rank", { token, ip })),
    ]);
    assertEquals(first.status, 200);
    assertEquals(second.status, 200);
    const a = (await first.json()) as { rank: { rating: number } };
    const b = (await second.json()) as { rank: { rating: number } };
    assertEquals(a.rank.rating, 6.2);
    assertEquals(b, a);
    assertEquals(postgrestReads("player_technique_rating").length, 1, "coalesced into one read");

    // A later sequential read is a cache hit.
    const third = await h.handler(userRequest("GET", "/v1/rank", { token, ip }));
    assertEquals(third.status, 200);
    assertEquals(await third.json(), a);
    assertEquals(postgrestReads("player_technique_rating").length, 1, "served from the 60 s cache");
  },
);
