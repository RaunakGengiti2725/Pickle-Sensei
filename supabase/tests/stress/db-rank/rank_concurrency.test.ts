/**
 * db-rank concurrency stress harness — player_rank_state +
 * recompute_player_rank + player_rank_tier + handle_shot_rank_refresh under
 * real Postgres contention (seeded, every iteration replayable).
 *
 * Unit under test (supabase/migrations):
 *   20260829150000_player_rank.sql            table, tier fn, trigger
 *   20260831130000_form_weighted_rank.sql     recompute_player_rank (v2 math)
 *   20260905000000_scored_shot_write_gate.sql BEFORE INSERT permit gate
 *   20260906000000_apply_synced_shot_replay_after_lock.sql  the RPC write path
 *
 * Reference oracle: packages/shared-types/src/playerRank.ts computePlayerRank
 * (AGENTS.md pins the SQL and TS formulas as bit-identical), evaluated over
 * the rows that actually committed. Every iteration ends by comparing
 * player_rank_state and player_technique_rating against that oracle AND
 * against a fresh owner recompute_player_rank() (a stale derived row shows
 * up as a delta between "what is stored" and "what a recompute produces").
 *
 * Run:
 *   ./supabase/tests/stress/db-rank/run.sh                 # STRESS_ITER=2 per scenario
 *   STRESS_ITER=60 ./supabase/tests/stress/db-rank/run.sh  # campaign (11 scenarios × 60 = 660 interleavings)
 *   STRESS_REPLAY=<scenario>:<seed> ./supabase/tests/stress/db-rank/run.sh
 *
 * Env:
 *   STRESS_PG_URL   postgres URL printed by pg_up.sh (tests are IGNORED —
 *                   visibly, never silently passed — when unset)
 *   STRESS_ITER     iterations per scenario (default 2)
 *   STRESS_SEED     campaign seed (default 20260904); iteration seed =
 *                   fnv1a(`${scenario}:${STRESS_SEED}:${i}`)
 *   STRESS_ONLY     comma-separated scenario names
 *   STRESS_REPLAY   `<scenario>:<iterationSeed>` — run exactly that iteration
 *   STRESS_OUT_DIR  where results.json / summary.json are written
 *                   (default artifacts/stress-db-rank/<utc>)
 *   STRESS_LANE_TIMEOUT_MS   statement_timeout+lock_timeout per lane (15000)
 *   STRESS_BURST_BUDGET_MS   wall budget per interleaving (30000)
 *
 * Only NEW files: nothing under supabase/migrations or the existing tests is
 * touched. Never points at a hosted project.
 */
import postgres from "postgres";
import { assertEquals } from "@std/assert";
import {
  computePlayerRank,
  RANK_CONFIDENCE_CAP,
} from "../../../../packages/shared-types/src/playerRank.ts";
import type { PlayerRankAnalysisInput } from "../../../../packages/shared-types/src/playerRank.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PG_URL = Deno.env.get("STRESS_PG_URL") ?? "";
const ITER = Math.max(1, Number(Deno.env.get("STRESS_ITER") ?? "2"));
const CAMPAIGN_SEED = Number(Deno.env.get("STRESS_SEED") ?? "20260904");
const ONLY = (Deno.env.get("STRESS_ONLY") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const REPLAY = Deno.env.get("STRESS_REPLAY") ?? "";
const LANE_TIMEOUT_MS = Number(Deno.env.get("STRESS_LANE_TIMEOUT_MS") ?? "15000");
const BURST_BUDGET_MS = Number(Deno.env.get("STRESS_BURST_BUDGET_MS") ?? "30000");
const OUT_DIR =
  Deno.env.get("STRESS_OUT_DIR") ??
  `artifacts/stress-db-rank/${new Date().toISOString().replace(/[:.]/g, "-")}`;

const skip = PG_URL === "";
if (skip) {
  console.log("db-rank stress: STRESS_PG_URL unset — every scenario is IGNORED (not a pass)");
}

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) — the only source of nondeterminism the harness
// controls. Postgres scheduling is the thing under test and is NOT seeded;
// the seed reproduces the payloads, lane mix, jitters and user setup.
// ---------------------------------------------------------------------------
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

class Rng {
  private a: number;
  constructor(seed: number) {
    this.a = seed >>> 0;
  }
  next(): number {
    this.a = (this.a + 0x6d2b79f5) >>> 0;
    let t = this.a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(0, xs.length - 1)];
  }
  uuid(): string {
    const b = new Uint8Array(16);
    for (let i = 0; i < 16; i++) b[i] = this.int(0, 255);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  /** capturedAt inside the shots_captured_at_bounds window, ms precision. */
  capturedAt(): string {
    const lo = Date.UTC(2020, 0, 1);
    const hi = Date.UTC(2035, 0, 1);
    return new Date(lo + Math.floor(this.next() * (hi - lo))).toISOString();
  }
  score(): number {
    // Mostly one-decimal (the app's scale), sometimes two decimals or bounds.
    const r = this.next();
    if (r < 0.05) return 0;
    if (r < 0.1) return 10;
    if (r < 0.3) return Math.round(this.next() * 1000) / 100;
    return Math.round(this.next() * 100) / 10;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

interface LaneRow {
  lane: number;
  user: string;
  op: string;
  result: string;
  sqlstate?: string;
  serverStartMs?: number;
  serverEndMs?: number;
  clientMs: number;
}

interface Violation {
  invariant: string;
  detail: string;
}

interface IterationResult {
  scenario: string;
  seed: number;
  ok: boolean;
  lanes: number;
  wallMs: number;
  histogram: Record<string, number>;
  violations: Violation[];
  notes: Record<string, unknown>;
  replay: string;
}

interface Ctx {
  sql: Sql;
  rng: Rng;
  seed: number;
  scenario: string;
  notes: Record<string, unknown>;
  violations: Violation[];
}

interface User {
  id: string;
  premium: boolean;
  identity?: { provider: string; sub: string };
}

const SHOT_TYPES = ["dink", "drive", "third_shot_drop", "serve", "return", "volley"] as const;
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

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------
function barrier(): { gate: Promise<void>; open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { gate, open };
}

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`set local statement_timeout = ${LANE_TIMEOUT_MS}`);
  await tx.unsafe(`set local lock_timeout = ${LANE_TIMEOUT_MS}`);
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

async function asOwner(tx: Tx): Promise<void> {
  await tx.unsafe(`set local statement_timeout = ${LANE_TIMEOUT_MS}`);
  await tx.unsafe(`set local lock_timeout = ${LANE_TIMEOUT_MS}`);
}

async function serverNowMs(tx: Tx): Promise<number> {
  const r = await tx.unsafe(`select (extract(epoch from clock_timestamp()) * 1000)::float8 as t`);
  return Number(r[0].t);
}

function sqlstateOf(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  return typeof code === "string" ? code : "client_error";
}

function shotPayload(
  rng: Rng,
  id: string,
  analysisPermitId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const scored = !("resultKind" in overrides) ? true : overrides.resultKind === "scored";
  return {
    id,
    analysisPermitId,
    sessionId: null,
    shotType: rng.pick(SHOT_TYPES),
    cameraView: "side",
    capturedAt: rng.capturedAt(),
    startMs: 0,
    contactMs: 100,
    endMs: 200,
    overallScore: scored ? rng.score() : null,
    confidence: scored ? 0.9 : 0.3,
    resultKind: "scored",
    phases: [],
    checkpoints: [],
    versionVector: VERSION_VECTOR,
    ...overrides,
  };
}

/** Lanes: each opens its own transaction (its own connection), sets the
 * caller, waits at the barrier, then runs `fn` and COMMITs. Errors are
 * captured per lane (the lane's tx rolls back) so one failing lane never
 * hides what the others did. */
async function burst(
  ctx: Ctx,
  lanes: number,
  setup: (tx: Tx, lane: number) => Promise<string>, // returns the user label
  fn: (tx: Tx, lane: number) => Promise<Omit<LaneRow, "lane" | "user" | "clientMs">>,
): Promise<{ rows: LaneRow[]; wallMs: number }> {
  const b = barrier();
  let ready = 0;
  const rows: LaneRow[] = [];
  const t0 = performance.now();
  const all = Promise.allSettled(
    Array.from({ length: lanes }, (_, lane) =>
      ctx.sql.begin(async (tx: Tx) => {
        let user = "?";
        try {
          user = await setup(tx, lane);
        } catch (e) {
          ready += 1;
          rows.push({
            lane,
            user,
            op: "setup",
            result: `error:${sqlstateOf(e)}`,
            sqlstate: sqlstateOf(e),
            clientMs: 0,
          });
          throw e;
        }
        ready += 1;
        await b.gate;
        const c0 = performance.now();
        try {
          const out = await fn(tx, lane);
          rows.push({
            lane,
            user,
            clientMs: Math.round((performance.now() - c0) * 100) / 100,
            ...out,
          });
        } catch (e) {
          rows.push({
            lane,
            user,
            op: "error",
            result: `error:${sqlstateOf(e)}`,
            sqlstate: sqlstateOf(e),
            clientMs: Math.round((performance.now() - c0) * 100) / 100,
          });
          throw e; // roll the lane back
        }
      }),
    ),
  );
  while (ready < lanes) await new Promise((r) => setTimeout(r, 1));
  b.open();
  const settled = await all;
  const wallMs = Math.round(performance.now() - t0);
  rows.sort((a, b) => a.lane - b.lane);
  // A lane whose fn returned but whose COMMIT failed (e.g. 40001 under
  // SERIALIZABLE) did not commit anything: mark the row so histograms and
  // invariants never mistake it for a committed outcome.
  settled.forEach((s, lane) => {
    const row = rows.find((r) => r.lane === lane);
    if (s.status === "rejected" && row && !row.result.startsWith("error:")) {
      row.sqlstate = sqlstateOf(s.reason);
      row.result = `${row.result}+commit_failed:${row.sqlstate}`;
    }
  });
  if (wallMs > BURST_BUDGET_MS) {
    ctx.violations.push({
      invariant: "bounded_wall_time",
      detail: `burst took ${wallMs}ms > budget ${BURST_BUDGET_MS}ms`,
    });
  }
  for (const r of rows) {
    if (r.sqlstate === "40P01" || r.result.includes("40P01")) {
      ctx.violations.push({
        invariant: "no_deadlock",
        detail: `lane ${r.lane} (${r.op}) hit deadlock 40P01`,
      });
    }
    if (r.sqlstate === "55P03") {
      ctx.violations.push({
        invariant: "no_deadlock",
        detail: `lane ${r.lane} (${r.op}) hit lock_timeout 55P03`,
      });
    }
  }
  return { rows, wallMs };
}

function histogram(rows: LaneRow[]): Record<string, number> {
  const h: Record<string, number> = {};
  for (const r of rows) h[`${r.op}=${r.result}`] = (h[`${r.op}=${r.result}`] ?? 0) + 1;
  return Object.fromEntries(Object.entries(h).sort());
}

async function applyRpc(tx: Tx, shot: Record<string, unknown>, op: string) {
  const t0 = await serverNowMs(tx);
  const r = await tx.unsafe(`select public.apply_synced_shot($1::text::jsonb) as result`, [
    JSON.stringify(shot),
  ]);
  const t1 = await serverNowMs(tx);
  return { op, result: String(r[0].result), serverStartMs: t0, serverEndMs: t1 };
}

async function reserveRpc(tx: Tx, key: string, op: string) {
  const t0 = await serverNowMs(tx);
  const r = await tx.unsafe(
    `select x.result, x.permit_id::text as permit_id from public.reserve_analysis_permit('${key}') x`,
  );
  const t1 = await serverNowMs(tx);
  return { op, result: String(r[0].result), serverStartMs: t0, serverEndMs: t1 };
}

// ---------------------------------------------------------------------------
// Fixtures (owner role)
// ---------------------------------------------------------------------------
async function makeUser(
  ctx: Ctx,
  opts: { premium?: boolean; identity?: boolean } = {},
): Promise<User> {
  const id = ctx.rng.uuid();
  const identity =
    opts.identity === false ? undefined : { provider: "google", sub: `sub-${ctx.rng.uuid()}` };
  const premium = opts.premium ?? ctx.rng.chance(0.5);
  await ctx.sql.unsafe(`delete from auth.users where id = '${id}'`);
  if (identity) {
    await ctx.sql.unsafe(
      `delete from public.free_rating_ledger
        where identity_hash = public.free_rating_identity_hash('${identity.provider}', '${identity.sub}')`,
    );
  }
  await ctx.sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${id}', '${id}@example.com', '{"provider":"google"}')`,
  );
  if (identity) {
    await ctx.sql.unsafe(
      `insert into auth.identities (provider, provider_id, user_id, identity_data)
       values ('${identity.provider}', '${identity.sub}', '${id}', '{"sub":"${identity.sub}"}')`,
    );
  }
  if (premium) {
    await ctx.sql.unsafe(
      `insert into public.billing_entitlements (user_id, premium) values ('${id}', true)`,
    );
  }
  return { id, premium, identity };
}

/** Owner-issued reserved permit (what reserve_analysis_permit would have
 * produced; issued directly so a scenario can hand a free user MORE than
 * two and exercise the RPC's lifetime backstop). */
async function issuePermit(ctx: Ctx, userId: string, ageHours = 0): Promise<string> {
  const id = ctx.rng.uuid();
  await ctx.sql.unsafe(
    `insert into public.analysis_permits (id, user_id, idempotency_key, status, created_at)
     values ('${id}', '${userId}', 'stress-${id}', 'reserved', now() - interval '${ageHours} hours')`,
  );
  return id;
}

/** Owner-written scored history (auth.uid() is null → the permit gate does
 * not apply; the rank trigger still fires). */
async function seedHistory(
  ctx: Ctx,
  userId: string,
  n: number,
  sessionId: string | null = null,
): Promise<number> {
  ctx.notes["seeded"] = n;
  for (let i = 0; i < n; i++) {
    const id = ctx.rng.uuid();
    const shotType = ctx.rng.pick(SHOT_TYPES);
    const score = ctx.rng.score();
    const session = sessionId ? `'${sessionId}'` : "null";
    await ctx.sql.unsafe(
      `insert into public.shots (id, user_id, session_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
         overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
         paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
       values ('${id}', '${userId}', ${session}, '${shotType}', 'side', '${ctx.rng.capturedAt()}', 0, 100, 200,
         ${score}, 0.9, 'scored', '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1', 'scoring-1', 'config-1')`,
    );
  }
  return n;
}

// ---------------------------------------------------------------------------
// Oracle: committed rows → reference rank → compare with stored state,
// the RLS view (as the user) and a fresh recompute.
// ---------------------------------------------------------------------------
interface StoredState {
  rating: string;
  tier: string;
  technique_count: number;
  scored_shot_count: number;
}

async function readState(sql: Sql, userId: string): Promise<StoredState | null> {
  const r = await sql.unsafe(
    `select rating::text as rating, tier, technique_count, scored_shot_count
       from public.player_rank_state where user_id = '${userId}'`,
  );
  if (r.length === 0) return null;
  return {
    rating: String(r[0].rating),
    tier: String(r[0].tier),
    technique_count: Number(r[0].technique_count),
    scored_shot_count: Number(r[0].scored_shot_count),
  };
}

async function readRows(sql: Sql, userId: string): Promise<PlayerRankAnalysisInput[]> {
  const r = await sql.unsafe(
    `select id::text as id, shot_type, overall_score::float8 as overall_score, result_kind, source,
            to_char(captured_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as captured_at
       from public.shots where user_id = '${userId}'`,
  );
  return r.map((x: Record<string, unknown>) => ({
    id: String(x.id),
    shotType: String(x.shot_type),
    overallScore: x.overall_score === null ? null : Number(x.overall_score),
    resultKind: String(x.result_kind),
    source: String(x.source),
    capturedAt: String(x.captured_at),
  }));
}

function expectedState(rows: PlayerRankAnalysisInput[]): StoredState | null {
  const ref = computePlayerRank(rows);
  if (!ref) return null;
  return {
    rating: ref.rating.toFixed(2),
    tier: ref.tier,
    technique_count: ref.techniqueCount,
    scored_shot_count: ref.scoredAnalysisCount,
  };
}

function sameState(a: StoredState | null, b: StoredState | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The full rank-consistency check for one user. `label` names the user in
 * violations. Returns the stored state so scenarios can log it. */
async function checkRank(ctx: Ctx, user: User, label: string): Promise<StoredState | null> {
  const rows = await readRows(ctx.sql, user.id);
  const expected = expectedState(rows);
  const stored = await readState(ctx.sql, user.id);
  ctx.notes[`${label}.rows`] = rows.length;
  ctx.notes[`${label}.stored`] = stored;
  ctx.notes[`${label}.expected`] = expected;
  if (!sameState(stored, expected)) {
    ctx.violations.push({
      invariant: "rank_state_matches_committed_rows",
      detail: `${label}: stored=${JSON.stringify(stored)} expected(TS oracle over ${rows.length} committed rows)=${JSON.stringify(
        expected,
      )}`,
    });
  }
  // Idempotent recompute: an owner recompute must not change a correct row.
  await ctx.sql.unsafe(`select public.recompute_player_rank('${user.id}')`);
  const recomputed = await readState(ctx.sql, user.id);
  if (!sameState(recomputed, expected)) {
    ctx.violations.push({
      invariant: "sql_recompute_matches_ts_oracle",
      detail: `${label}: recompute=${JSON.stringify(recomputed)} expected=${JSON.stringify(expected)}`,
    });
  }
  if (!sameState(stored, recomputed)) {
    ctx.violations.push({
      invariant: "stored_state_not_stale",
      detail: `${label}: stored=${JSON.stringify(stored)} but fresh recompute=${JSON.stringify(recomputed)}`,
    });
  }
  // The RLS view from the user's own session must agree with the oracle.
  const ref = computePlayerRank(rows);
  await ctx.sql.begin(async (tx: Tx) => {
    await asUser(tx, user.id);
    const view = await tx.unsafe(
      `select shot_type, score::text as score, sampled_count, confidence_weight
         from public.player_technique_rating order by shot_type`,
    );
    const got = view.map(
      (v: Record<string, unknown>) =>
        `${v.shot_type}:${Number(v.score).toFixed(2)}:${v.sampled_count}:${v.confidence_weight}`,
    );
    const want = (ref?.techniques ?? [])
      .map((t) => {
        const countable = rows.filter(
          (r) =>
            r.shotType === t.shotType &&
            r.resultKind === "scored" &&
            r.overallScore !== null &&
            r.source === "real",
        ).length;
        return `${t.shotType}:${t.score.toFixed(2)}:${t.sampledCount}:${Math.min(countable, RANK_CONFIDENCE_CAP)}`;
      })
      .sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      ctx.violations.push({
        invariant: "technique_view_matches_oracle",
        detail: `${label}: view=${JSON.stringify(got)} expected=${JSON.stringify(want)}`,
      });
    }
    const ownRows = await tx.unsafe(`select count(*)::int as n from public.player_rank_state`);
    const visible = Number(ownRows[0].n);
    if (visible !== (stored ? 1 : 0)) {
      ctx.violations.push({
        invariant: "rls_state_visibility",
        detail: `${label}: authenticated sees ${visible} player_rank_state rows, owner sees ${stored ? 1 : 0}`,
      });
    }
  });
  return stored;
}

async function ownerCounts(sql: Sql, userId: string) {
  const shots = await sql.unsafe(
    `select count(*)::int as n, count(*) filter (where result_kind = 'scored')::int as scored
       from public.shots where user_id = '${userId}'`,
  );
  const permits = await sql.unsafe(
    `select status, coalesce(outcome, '') as outcome, count(*)::int as n
       from public.analysis_permits where user_id = '${userId}' group by 1, 2 order by 1, 2`,
  );
  const ledger = await sql.unsafe(
    `select l.scored_count from public.free_rating_ledger l
       join auth.identities i on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
      where i.user_id = '${userId}'`,
  );
  const byStatus: Record<string, number> = {};
  for (const p of permits) byStatus[`${p.status}/${p.outcome}`] = Number(p.n);
  return {
    shots: Number(shots[0].n),
    scoredShots: Number(shots[0].scored),
    permits: byStatus,
    ledger: ledger.map((l: Record<string, unknown>) => Number(l.scored_count)),
  };
}

/** Key-order-independent JSON so `{a,b}` and `{b,a}` compare equal. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

function expectEq(ctx: Ctx, invariant: string, got: unknown, want: unknown, detail: string) {
  if (canon(got) !== canon(want)) {
    ctx.violations.push({ invariant, detail: `${detail}: got ${canon(got)} want ${canon(want)}` });
  }
}

// ---------------------------------------------------------------------------
// Scenarios. Each is one seeded interleaving; `lanes` is what it fired.
// ---------------------------------------------------------------------------
type Scenario = (
  ctx: Ctx,
) => Promise<{ lanes: number; wallMs: number; histogram: Record<string, number> }>;

/** S1 — two actors, distinct shots, READ COMMITTED. Lanes split between a
 * free and a premium (or two free / two premium — seeded) user, each lane
 * its own permit and shot id, ~20% abstentions. Asserts: no double spend
 * (free user ≤ 2 lifetime scored), every permit settled exactly once, rows
 * == accepted lanes, ledger == scored rows, rank == oracle for BOTH users,
 * RLS view/state isolation, bounded wall time. */
const burstTwoUsersDistinctShots: Scenario = async (ctx) => {
  const a = await makeUser(ctx);
  const b = await makeUser(ctx);
  const lanes = ctx.rng.int(4, 14);
  const plan = Array.from({ length: lanes }, () => {
    const user = ctx.rng.chance(0.5) ? a : b;
    return { user, scored: !ctx.rng.chance(0.2), shotId: ctx.rng.uuid(), permitId: "" };
  });
  // A few lanes share a capturedAt (clock skew / same-instant captures) so
  // the id tie-break in both formulas is exercised.
  const sharedAt = ctx.rng.capturedAt();
  for (const p of plan) p.permitId = await issuePermit(ctx, p.user.id);
  const payloads = plan.map((p) =>
    shotPayload(ctx.rng, p.shotId, p.permitId, {
      resultKind: p.scored ? "scored" : "low_confidence",
      ...(p.scored ? {} : { overallScore: null, confidence: 0.3 }),
      ...(ctx.rng.chance(0.3) ? { capturedAt: sharedAt } : {}),
    }),
  );
  const { rows, wallMs } = await burst(
    ctx,
    lanes,
    async (tx, lane) => {
      await asUser(tx, plan[lane].user.id);
      return plan[lane].user === a ? "A" : "B";
    },
    (tx, lane) =>
      applyRpc(tx, payloads[lane], plan[lane].scored ? "apply.scored" : "apply.abstain"),
  );
  for (const [label, user] of [
    ["A", a],
    ["B", b],
  ] as const) {
    const mine = plan.map((p, i) => ({ p, r: rows[i] })).filter((x) => x.p.user === user);
    const scoredLanes = mine.filter((x) => x.p.scored);
    const abstainLanes = mine.filter((x) => !x.p.scored);
    const accepted = mine.filter((x) => x.r.result === "accepted");
    const acceptedScored = scoredLanes.filter((x) => x.r.result === "accepted").length;
    const paywalled = scoredLanes.filter((x) => x.r.result === "access.paywall_required").length;
    const expectScored = user.premium ? scoredLanes.length : Math.min(2, scoredLanes.length);
    expectEq(
      ctx,
      "no_double_spend",
      acceptedScored,
      expectScored,
      `${label} accepted scored lanes`,
    );
    expectEq(
      ctx,
      "no_double_spend",
      paywalled,
      scoredLanes.length - expectScored,
      `${label} paywalled lanes`,
    );
    expectEq(
      ctx,
      "abstentions_always_accepted",
      abstainLanes.filter((x) => x.r.result === "accepted").length,
      abstainLanes.length,
      `${label} abstain lanes accepted`,
    );
    const c = await ownerCounts(ctx.sql, user.id);
    expectEq(
      ctx,
      "no_duplicate_rows",
      c.shots,
      accepted.length,
      `${label} shots rows == accepted lanes`,
    );
    expectEq(ctx, "no_duplicate_rows", c.scoredShots, acceptedScored, `${label} scored rows`);
    expectEq(
      ctx,
      "permits_settled_once",
      c.permits,
      Object.fromEntries(
        [
          ["finalized/scored", acceptedScored],
          ["released/low_confidence", abstainLanes.length],
          ["released/free_limit_exceeded", paywalled],
        ].filter(([, n]) => (n as number) > 0),
      ),
      `${label} permit ledger`,
    );
    if (user.identity) {
      expectEq(
        ctx,
        "identity_ledger_matches_scored",
        c.ledger,
        acceptedScored > 0 ? [acceptedScored] : [],
        `${label} ledger`,
      );
    }
    await checkRank(ctx, user, label);
  }
  return { lanes, wallMs, histogram: histogram(rows) };
};

/** S2 — duplicate calls: the same payload from N lanes at once (a sync
 * retried by several devices / outbox replays), for two distinct shots of
 * one premium user. Every lane must be `accepted`, exactly one row per
 * shot, each permit finalized once, rank == oracle. */
const duplicateReplaySameShot: Scenario = async (ctx) => {
  const u = await makeUser(ctx, { premium: true });
  const groups = ctx.rng.int(1, 3);
  const plan: Array<{ payload: Record<string, unknown>; g: number }> = [];
  for (let g = 0; g < groups; g++) {
    const payload = shotPayload(ctx.rng, ctx.rng.uuid(), await issuePermit(ctx, u.id));
    const copies = ctx.rng.int(2, 6);
    for (let i = 0; i < copies; i++) plan.push({ payload, g });
  }
  // Shuffle lanes so replays of different shots interleave.
  for (let i = plan.length - 1; i > 0; i--) {
    const j = ctx.rng.int(0, i);
    [plan[i], plan[j]] = [plan[j], plan[i]];
  }
  const { rows, wallMs } = await burst(
    ctx,
    plan.length,
    async (tx) => {
      await asUser(tx, u.id);
      return "U";
    },
    (tx, lane) => applyRpc(tx, plan[lane].payload, `apply.dup${plan[lane].g}`),
  );
  expectEq(
    ctx,
    "idempotent_replay",
    rows.filter((r) => r.result === "accepted").length,
    plan.length,
    "all lanes accepted",
  );
  const c = await ownerCounts(ctx.sql, u.id);
  expectEq(ctx, "no_duplicate_rows", c.shots, groups, "one row per distinct shot");
  expectEq(
    ctx,
    "permits_settled_once",
    c.permits,
    { "finalized/scored": groups },
    "each permit finalized once",
  );
  await checkRank(ctx, u, "U");
  return { lanes: plan.length, wallMs, histogram: histogram(rows) };
};

/** S3 — two actors on the same row id: A and B both sync a shot with the
 * SAME uuid (each with their own permit). Exactly one row; the loser's
 * lanes get shot.id_conflict, the loser's permit is NOT spent, the loser's
 * ledger/rank are untouched, and neither can see the other's rank row. */
const twoActorsSameShotId: Scenario = async (ctx) => {
  const a = await makeUser(ctx, { premium: ctx.rng.chance(0.5) });
  const b = await makeUser(ctx, { premium: ctx.rng.chance(0.5) });
  const shotId = ctx.rng.uuid();
  const pa = await issuePermit(ctx, a.id);
  const pb = await issuePermit(ctx, b.id);
  const na = ctx.rng.int(1, 4);
  const nb = ctx.rng.int(1, 4);
  const payA = shotPayload(ctx.rng, shotId, pa);
  const payB = shotPayload(ctx.rng, shotId, pb);
  const owners = [...Array(na).fill(a), ...Array(nb).fill(b)] as User[];
  const { rows, wallMs } = await burst(
    ctx,
    owners.length,
    async (tx, lane) => {
      await asUser(tx, owners[lane].id);
      return owners[lane] === a ? "A" : "B";
    },
    (tx, lane) =>
      applyRpc(tx, owners[lane] === a ? payA : payB, owners[lane] === a ? "apply.A" : "apply.B"),
  );
  const winner = await ctx.sql.unsafe(
    `select user_id::text as u from public.shots where id = '${shotId}'`,
  );
  expectEq(ctx, "no_duplicate_rows", winner.length, 1, "exactly one row for the contested id");
  const w = winner.length === 1 ? (String(winner[0].u) === a.id ? a : b) : null;
  if (w) {
    const l = w === a ? b : a;
    const wl = w === a ? "A" : "B";
    const ll = w === a ? "B" : "A";
    expectEq(
      ctx,
      "winner_lanes_accepted",
      rows.filter((r) => r.user === wl).map((r) => r.result),
      rows.filter((r) => r.user === wl).map(() => "accepted"),
      `${wl} lanes`,
    );
    expectEq(
      ctx,
      "loser_lanes_conflict",
      rows.filter((r) => r.user === ll).map((r) => r.result),
      rows.filter((r) => r.user === ll).map(() => "shot.id_conflict"),
      `${ll} lanes`,
    );
    const cl = await ownerCounts(ctx.sql, l.id);
    expectEq(
      ctx,
      "no_double_spend",
      cl.permits,
      { "reserved/": 1 },
      `${ll} permit still reserved (not spent)`,
    );
    expectEq(ctx, "no_double_spend", cl.ledger, [], `${ll} ledger untouched`);
    expectEq(ctx, "no_cross_user_rows", cl.shots, 0, `${ll} owns no rows`);
    const cw = await ownerCounts(ctx.sql, w.id);
    expectEq(
      ctx,
      "permits_settled_once",
      cw.permits,
      { "finalized/scored": 1 },
      `${wl} permit finalized once`,
    );
    // RLS: the loser cannot see the winner's shot nor rank row.
    await ctx.sql.begin(async (tx: Tx) => {
      await asUser(tx, l.id);
      const s = await tx.unsafe(
        `select count(*)::int as n from public.shots where id = '${shotId}'`,
      );
      const st = await tx.unsafe(
        `select count(*)::int as n from public.player_rank_state where user_id = '${w.id}'`,
      );
      expectEq(
        ctx,
        "rls_cross_user_isolation",
        [Number(s[0].n), Number(st[0].n)],
        [0, 0],
        `${ll} sees winner's shot/state`,
      );
    });
    await checkRank(ctx, w, wl);
    await checkRank(ctx, l, ll);
  }
  return { lanes: owners.length, wallMs, histogram: histogram(rows) };
};

/** S4 — the same mix as S1 but every lane runs SERIALIZABLE. The code does
 * not claim serializable safety; this records what happens. Invariants that
 * MUST still hold: rows == accepted lanes, each permit settled at most once
 * and a lane that did not commit did not spend, rank == oracle over
 * committed rows, no deadlock. 40001 outcomes are recorded, not failed. */
const serializableBurst: Scenario = async (ctx) => {
  const u = await makeUser(ctx, { premium: ctx.rng.chance(0.7) });
  const lanes = ctx.rng.int(3, 10);
  const plan = [] as Array<{ payload: Record<string, unknown> }>;
  for (let i = 0; i < lanes; i++) {
    plan.push({ payload: shotPayload(ctx.rng, ctx.rng.uuid(), await issuePermit(ctx, u.id)) });
  }
  const { rows, wallMs } = await burst(
    ctx,
    lanes,
    async (tx) => {
      await tx.unsafe(`set transaction isolation level serializable`);
      await asUser(tx, u.id);
      return "U";
    },
    (tx, lane) => applyRpc(tx, plan[lane].payload, "apply.serializable"),
  );
  // A lane "committed" only if its tx did not error after the RPC returned.
  const committedAccepted = rows.filter((r) => r.result === "accepted").length;
  const c = await ownerCounts(ctx.sql, u.id);
  const expectScored = u.premium ? committedAccepted : Math.min(2, committedAccepted);
  ctx.notes["serializable.results"] = rows.map((r) => r.result);
  // Under SERIALIZABLE the commit itself can fail (40001) after the RPC
  // returned 'accepted'; count rows against what is actually there.
  if (c.scoredShots > expectScored) {
    ctx.violations.push({
      invariant: "no_double_spend",
      detail: `scored rows ${c.scoredShots} > ${expectScored}`,
    });
  }
  const finalized = c.permits["finalized/scored"] ?? 0;
  expectEq(
    ctx,
    "permits_settled_once",
    finalized,
    c.scoredShots,
    "finalized permits == scored rows",
  );
  if (u.identity)
    expectEq(
      ctx,
      "identity_ledger_matches_scored",
      c.ledger,
      c.scoredShots > 0 ? [c.scoredShots] : [],
      "ledger",
    );
  await checkRank(ctx, u, "U");
  return { lanes, wallMs, histogram: histogram(rows) };
};

/** S5 — call-during-call across the two client write paths: RPC scored
 * syncs (advisory-locked) racing DIRECT authenticated INSERTs of
 * low_confidence rows (the grant exists; no lock). Both fire the rank
 * trigger for the same user. Invariant: the stored rank equals the oracle
 * over the committed rows once everything has committed. */
const rpcVsDirectLowConfidenceInsert: Scenario = async (ctx) => {
  const u = await makeUser(ctx, { premium: true });
  await seedHistory(ctx, u.id, ctx.rng.int(0, 6));
  const nRpc = ctx.rng.int(1, 5);
  const nDirect = ctx.rng.int(1, 5);
  const rpcPayloads = [] as Array<Record<string, unknown>>;
  for (let i = 0; i < nRpc; i++)
    rpcPayloads.push(shotPayload(ctx.rng, ctx.rng.uuid(), await issuePermit(ctx, u.id)));
  const jitter = Array.from({ length: nRpc + nDirect }, () => ctx.rng.int(0, 25));
  const { rows, wallMs } = await burst(
    ctx,
    nRpc + nDirect,
    async (tx) => {
      await asUser(tx, u.id);
      return "U";
    },
    async (tx, lane) => {
      if (jitter[lane] > 0) await tx.unsafe(`select pg_sleep(${jitter[lane] / 1000})`);
      if (lane < nRpc) return applyRpc(tx, rpcPayloads[lane], "apply.scored");
      const t0 = await serverNowMs(tx);
      await tx.unsafe(
        `insert into public.shots (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
           overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
           paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
         values ('${ctx.rng.uuid()}', '${u.id}', '${ctx.rng.pick(SHOT_TYPES)}', 'side', '${ctx.rng.capturedAt()}', 0, null, 200,
           null, 0.3, 'low_confidence', '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1', 'scoring-1', 'config-1')`,
      );
      const t1 = await serverNowMs(tx);
      return {
        op: "insert.low_confidence",
        result: "inserted",
        serverStartMs: t0,
        serverEndMs: t1,
      };
    },
  );
  const c = await ownerCounts(ctx.sql, u.id);
  ctx.notes["counts"] = c;
  const acceptedRpc = rows.filter((r) => r.op === "apply.scored" && r.result === "accepted").length;
  const inserted = rows.filter(
    (r) => r.op === "insert.low_confidence" && r.result === "inserted",
  ).length;
  expectEq(
    ctx,
    "all_lanes_committed",
    [acceptedRpc, inserted],
    [nRpc, nDirect],
    "rpc accepted / direct inserted",
  );
  await checkRank(ctx, u, "U");
  return { lanes: nRpc + nDirect, wallMs, histogram: histogram(rows) };
};

/** S6 — owner / service-role scored writes for one user with NO advisory
 * lock (backfills, operator scripts: auth.uid() is null so neither the
 * permit gate nor the RPC lock is involved). Concurrent trigger recomputes
 * for the same user_id — the stored rank must still equal the oracle. */
const ownerDirectScoredInserts: Scenario = async (ctx) => {
  const u = await makeUser(ctx, { premium: true });
  await seedHistory(ctx, u.id, ctx.rng.int(0, 4));
  const lanes = ctx.rng.int(2, 8);
  const rowsPlan = Array.from({ length: lanes }, () => ({
    id: ctx.rng.uuid(),
    shotType: ctx.rng.pick(SHOT_TYPES),
    score: ctx.rng.score(),
    at: ctx.rng.capturedAt(),
    jitter: ctx.rng.int(0, 20),
  }));
  const { rows, wallMs } = await burst(
    ctx,
    lanes,
    async (tx) => {
      await asOwner(tx);
      return "owner";
    },
    async (tx, lane) => {
      const p = rowsPlan[lane];
      if (p.jitter > 0) await tx.unsafe(`select pg_sleep(${p.jitter / 1000})`);
      const t0 = await serverNowMs(tx);
      await tx.unsafe(
        `insert into public.shots (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
           overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
           paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
         values ('${p.id}', '${u.id}', '${p.shotType}', 'side', '${p.at}', 0, 100, 200,
           ${p.score}, 0.9, 'scored', '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1', 'scoring-1', 'config-1')`,
      );
      const t1 = await serverNowMs(tx);
      return { op: "insert.owner_scored", result: "inserted", serverStartMs: t0, serverEndMs: t1 };
    },
  );
  expectEq(
    ctx,
    "all_lanes_committed",
    rows.filter((r) => r.result === "inserted").length,
    lanes,
    "owner inserts",
  );
  await checkRank(ctx, u, "U");
  return { lanes, wallMs, histogram: histogram(rows) };
};

/** S7 — rotation/logout taken to its end: account deletion (auth.users
 * DELETE → profiles → shots/permits/state cascade, what
 * auth.admin.deleteUser does) racing in-flight RPC syncs for the same user.
 * Invariants: no orphan rows for the user afterwards, no deadlock, bounded
 * wall time; each lane's outcome is one of a known set. */
const accountDeleteVsSync: Scenario = async (ctx) => {
  const u = await makeUser(ctx, { premium: true });
  await seedHistory(ctx, u.id, ctx.rng.int(0, 3));
  const nRpc = ctx.rng.int(1, 6);
  const payloads = [] as Array<Record<string, unknown>>;
  for (let i = 0; i < nRpc; i++)
    payloads.push(shotPayload(ctx.rng, ctx.rng.uuid(), await issuePermit(ctx, u.id)));
  const deleteJitter = ctx.rng.int(0, 30);
  const { rows, wallMs } = await burst(
    ctx,
    nRpc + 1,
    async (tx, lane) => {
      if (lane === nRpc) {
        await asOwner(tx);
        return "owner";
      }
      await asUser(tx, u.id);
      return "U";
    },
    async (tx, lane) => {
      if (lane === nRpc) {
        if (deleteJitter > 0) await tx.unsafe(`select pg_sleep(${deleteJitter / 1000})`);
        const t0 = await serverNowMs(tx);
        await tx.unsafe(`delete from auth.users where id = '${u.id}'`);
        const t1 = await serverNowMs(tx);
        return { op: "delete.account", result: "deleted", serverStartMs: t0, serverEndMs: t1 };
      }
      return applyRpc(tx, payloads[lane], "apply.scored");
    },
  );
  const known = new Set([
    "accepted",
    "access.permit_not_found",
    "shot.write_failed:23503",
    "shot.write_failed:40P01",
    "error:40P01",
    "error:55P03",
    "error:57014",
  ]);
  for (const r of rows) {
    if (r.op === "apply.scored" && !known.has(r.result)) {
      ctx.violations.push({
        invariant: "known_outcomes",
        detail: `lane ${r.lane} unexpected ${r.result}`,
      });
    }
  }
  const del = rows[nRpc];
  ctx.notes["delete.result"] = del.result;
  const orphans = await ctx.sql.unsafe(
    `select
       (select count(*) from public.shots where user_id = '${u.id}')::int as shots,
       (select count(*) from public.analysis_permits where user_id = '${u.id}')::int as permits,
       (select count(*) from public.player_rank_state where user_id = '${u.id}')::int as state,
       (select count(*) from public.profiles where id = '${u.id}')::int as profiles,
       (select count(*) from auth.users where id = '${u.id}')::int as users`,
  );
  const o = orphans[0];
  ctx.notes["after"] = o;
  if (del.result === "deleted") {
    expectEq(
      ctx,
      "no_orphans_after_delete",
      [Number(o.shots), Number(o.permits), Number(o.state), Number(o.profiles), Number(o.users)],
      [0, 0, 0, 0, 0],
      "rows left after account deletion committed",
    );
  } else {
    // Deletion lost (deadlock victim etc.): the account must be intact and
    // its rank consistent; the operator will retry the deletion.
    expectEq(ctx, "account_intact_when_delete_failed", Number(o.users), 1, "auth.users row");
    await checkRank(ctx, u, "U");
  }
  return { lanes: nRpc + 1, wallMs, histogram: histogram(rows) };
};

/** S7b — a client-reachable unlocked writer: `authenticated` holds DELETE
 * on public.sessions (sessions_delete_own) and shots.session_id is
 * `on delete set null`, so deleting a session UPDATEs every shot in it and
 * fires handle_shot_rank_refresh OUTSIDE the RPC's advisory lock while
 * syncs for the same user run. Invariants: committed rank state == oracle
 * over committed rows, no deadlock, bounded wall time. */
const sessionDeleteVsSync: Scenario = async (ctx) => {
  const u = await makeUser(ctx, { premium: true });
  const sessionId = ctx.rng.uuid();
  await ctx.sql.unsafe(
    `insert into public.sessions (id, user_id, kind, started_at) values ('${sessionId}', '${u.id}', 'practice', now())`,
  );
  await seedHistory(ctx, u.id, ctx.rng.int(1, 4), sessionId);
  const nRpc = ctx.rng.int(1, 5);
  const payloads = [] as Array<Record<string, unknown>>;
  for (let i = 0; i < nRpc; i++)
    payloads.push(shotPayload(ctx.rng, ctx.rng.uuid(), await issuePermit(ctx, u.id)));
  const deleteJitter = ctx.rng.int(0, 20);
  const { rows, wallMs } = await burst(
    ctx,
    nRpc + 1,
    async (tx) => {
      await asUser(tx, u.id);
      return "U";
    },
    async (tx, lane) => {
      if (lane === nRpc) {
        if (deleteJitter > 0) await tx.unsafe(`select pg_sleep(${deleteJitter / 1000})`);
        const t0 = await serverNowMs(tx);
        const r = await tx.unsafe(
          `delete from public.sessions where id = '${sessionId}' returning id`,
        );
        const t1 = await serverNowMs(tx);
        return {
          op: "delete.session",
          result: r.length === 1 ? "deleted" : "missing",
          serverStartMs: t0,
          serverEndMs: t1,
        };
      }
      return applyRpc(tx, payloads[lane], "apply.scored");
    },
  );
  for (const r of rows) {
    if (r.op === "apply.scored" && r.result !== "accepted") {
      ctx.violations.push({
        invariant: "known_outcomes",
        detail: `lane ${r.lane} unexpected ${r.result}`,
      });
    }
  }
  const c = await ownerCounts(ctx.sql, u.id);
  ctx.notes["counts"] = c;
  const left = await ctx.sql.unsafe(
    `select count(*)::int as n from public.shots where session_id = '${sessionId}'`,
  );
  expectEq(
    ctx,
    "session_cascade_applied",
    Number(left[0].n),
    0,
    "shots still pointing at the deleted session",
  );
  await checkRank(ctx, u, "U");
  return { lanes: nRpc + 1, wallMs, histogram: histogram(rows) };
};

/** S8 — cancel-during-call: a blocker holds the user's advisory lock while
 * the sync lane runs with a short statement_timeout (or is
 * pg_cancel_backend'ed). The cancelled call must leave NO shot, the permit
 * still reserved and the rank unchanged; the retry of the same payload
 * is then accepted and the rank matches the oracle. */
const cancelDuringCall: Scenario = async (ctx) => {
  const u = await makeUser(ctx, { premium: ctx.rng.chance(0.5) });
  const seeded = await seedHistory(ctx, u.id, ctx.rng.int(0, 3));
  const before = await readState(ctx.sql, u.id);
  const permit = await issuePermit(ctx, u.id);
  const payload = shotPayload(ctx.rng, ctx.rng.uuid(), permit);
  const holdMs = ctx.rng.int(150, 400);
  const timeoutMs = ctx.rng.int(20, 120);
  const useBackendCancel = ctx.rng.chance(0.4);
  let victimPid = 0;
  const { rows, wallMs } = await burst(
    ctx,
    useBackendCancel ? 3 : 2,
    async (tx, lane) => {
      if (lane === 0) {
        await asOwner(tx);
        return "blocker";
      }
      if (lane === 1) {
        await asUser(tx, u.id);
        if (!useBackendCancel) await tx.unsafe(`set local statement_timeout = ${timeoutMs}`);
        victimPid = Number((await tx.unsafe(`select pg_backend_pid() as pid`))[0].pid);
        return "U";
      }
      await asOwner(tx);
      return "canceller";
    },
    async (tx, lane) => {
      if (lane === 0) {
        const t0 = await serverNowMs(tx);
        await tx.unsafe(`select pg_advisory_xact_lock(public.access_lock_key('${u.id}'))`);
        await tx.unsafe(`select pg_sleep(${holdMs / 1000})`);
        const t1 = await serverNowMs(tx);
        return { op: "hold.lock", result: "held", serverStartMs: t0, serverEndMs: t1 };
      }
      if (lane === 1) return applyRpc(tx, payload, "apply.under_cancel");
      await tx.unsafe(`select pg_sleep(${timeoutMs / 1000})`);
      const r = await tx.unsafe(`select pg_cancel_backend(${victimPid}) as ok`);
      return { op: "cancel.backend", result: String(r[0].ok) };
    },
  );
  const victim = rows[1];
  ctx.notes["victim"] = victim.result;
  const c = await ownerCounts(ctx.sql, u.id);
  const mid = await readState(ctx.sql, u.id);
  // A free user whose seeded history already spent both lifetime ratings is
  // legitimately paywalled (permit released as free_limit_exceeded) when the
  // call is NOT cancelled; the retry then finds no reserved permit.
  const atLimit = !u.premium && (before?.scored_shot_count ?? 0) >= 2;
  const uncancelled = atLimit ? "access.paywall_required" : "accepted";
  if (victim.result === "error:57014") {
    expectEq(ctx, "cancel_leaves_no_row", c.shots, seeded, "shots after cancel");
    const shotThere = await ctx.sql.unsafe(
      `select count(*)::int as n from public.shots where id = '${payload.id}'`,
    );
    expectEq(ctx, "cancel_leaves_no_row", Number(shotThere[0].n), 0, "cancelled shot row absent");
    expectEq(
      ctx,
      "cancel_keeps_permit_reserved",
      c.permits["reserved/"] ?? 0,
      1,
      "permit still reserved",
    );
    expectEq(ctx, "cancel_keeps_rank", mid, before, "rank unchanged by cancelled call");
  } else if (victim.result !== uncancelled) {
    ctx.violations.push({
      invariant: "known_outcomes",
      detail: `victim lane ${victim.result} (want ${uncancelled} or error:57014)`,
    });
  }
  // Retry (the outbox replays the same payload).
  let retry = "";
  await ctx.sql.begin(async (tx: Tx) => {
    await asUser(tx, u.id);
    retry = (await applyRpc(tx, payload, "apply.retry")).result;
  });
  const expectRetry =
    victim.result === "access.paywall_required" ? "access.permit_not_reserved" : uncancelled;
  expectEq(ctx, "retry_after_cancel", retry, expectRetry, "retry result");
  await checkRank(ctx, u, "U");
  return { lanes: rows.length, wallMs, histogram: { ...histogram(rows), [`retry=${retry}`]: 1 } };
};

/** S9 — RLS from the authenticated role for the rank objects, two users
 * with real rank rows: each sees exactly its own state/view rows; neither
 * can execute recompute_player_rank, nor write player_rank_state. */
const rlsRankVisibility: Scenario = async (ctx) => {
  const a = await makeUser(ctx, { premium: true });
  const b = await makeUser(ctx, { premium: true });
  await seedHistory(ctx, a.id, ctx.rng.int(1, 5));
  await seedHistory(ctx, b.id, ctx.rng.int(1, 5));
  const users: Array<[string, User, User]> = [
    ["A", a, b],
    ["B", b, a],
  ];
  const { rows, wallMs } = await burst(
    ctx,
    2,
    async (tx, lane) => {
      await asUser(tx, users[lane][1].id);
      return users[lane][0];
    },
    async (tx, lane) => {
      const [label, me, other] = users[lane];
      const st = await tx.unsafe(`select user_id::text as u from public.player_rank_state`);
      expectEq(
        ctx,
        "rls_state_visibility",
        st.map((r: Record<string, unknown>) => String(r.u)),
        [me.id],
        `${label} state rows`,
      );
      const view = await tx.unsafe(
        `select distinct user_id::text as u from public.player_technique_rating`,
      );
      expectEq(
        ctx,
        "rls_view_visibility",
        view.map((r: Record<string, unknown>) => String(r.u)),
        [me.id],
        `${label} view rows`,
      );
      const denied: string[] = [];
      for (const [name, stmt] of [
        ["recompute_other", `select public.recompute_player_rank('${other.id}')`],
        ["recompute_self", `select public.recompute_player_rank('${me.id}')`],
        [
          "update_state",
          `update public.player_rank_state set rating = 9.99 where user_id = '${me.id}'`,
        ],
        [
          "insert_state",
          `insert into public.player_rank_state (user_id, rating, tier, technique_count, scored_shot_count)
                             values ('${other.id}', 9.99, 'diamond', 1, 1)`,
        ],
        ["delete_state", `delete from public.player_rank_state where user_id = '${me.id}'`],
      ] as const) {
        try {
          await tx.savepoint(async (sp: Tx) => {
            await sp.unsafe(stmt);
          });
          denied.push(`${name}:ALLOWED`);
        } catch (e) {
          denied.push(`${name}:${sqlstateOf(e)}`);
        }
      }
      expectEq(
        ctx,
        "rank_objects_client_readonly",
        denied,
        [
          "recompute_other:42501",
          "recompute_self:42501",
          "update_state:42501",
          "insert_state:42501",
          "delete_state:42501",
        ],
        `${label} write/execute attempts`,
      );
      return { op: "rls.probe", result: "probed" };
    },
  );
  await checkRank(ctx, a, "A");
  await checkRank(ctx, b, "B");
  return { lanes: 2, wallMs, histogram: histogram(rows) };
};

/** S10 — free-limit double spend across reserve + apply on ONE free user:
 * reserve lanes (fresh keys) race apply lanes (pre-issued permits) so the
 * lifetime allowance is contested from both directions. Invariant:
 * scored rows ≤ 2, scored + still-reserved ≤ 2 (no over-issue), ledger ==
 * scored rows, rank == oracle. */
const reserveVsApplyFreeLimit: Scenario = async (ctx) => {
  const u = await makeUser(ctx, { premium: false });
  const nApply = ctx.rng.int(1, 4);
  const nReserve = ctx.rng.int(1, 4);
  const payloads = [] as Array<Record<string, unknown>>;
  for (let i = 0; i < nApply; i++)
    payloads.push(shotPayload(ctx.rng, ctx.rng.uuid(), await issuePermit(ctx, u.id)));
  const keys = Array.from({ length: nReserve }, () => `k-${ctx.rng.uuid()}`);
  const { rows, wallMs } = await burst(
    ctx,
    nApply + nReserve,
    async (tx) => {
      await asUser(tx, u.id);
      return "U";
    },
    (tx, lane) =>
      lane < nApply
        ? applyRpc(tx, payloads[lane], "apply.scored")
        : reserveRpc(tx, keys[lane - nApply], "reserve"),
  );
  const c = await ownerCounts(ctx.sql, u.id);
  ctx.notes["counts"] = c;
  if (c.scoredShots > 2)
    ctx.violations.push({
      invariant: "no_double_spend",
      detail: `scored rows ${c.scoredShots} > 2`,
    });
  // Pre-issued permits that were paywalled are released by the RPC, so the
  // only reserved rows left are RPC-issued ones; those + scored must fit.
  const rpcReserved = rows.filter((r) => r.op === "reserve" && r.result === "accepted").length;
  expectEq(
    ctx,
    "permits_settled_once",
    c.permits["reserved/"] ?? 0,
    rpcReserved,
    "reserved rows == accepted reserve lanes",
  );
  if (c.scoredShots + rpcReserved > 2) {
    ctx.violations.push({
      invariant: "no_over_issue",
      detail: `scored ${c.scoredShots} + rpc-reserved ${rpcReserved} > 2`,
    });
  }
  expectEq(
    ctx,
    "identity_ledger_matches_scored",
    c.ledger,
    c.scoredShots > 0 ? [c.scoredShots] : [],
    "ledger",
  );
  expectEq(
    ctx,
    "no_duplicate_rows",
    c.scoredShots,
    rows.filter((r) => r.op === "apply.scored" && r.result === "accepted").length,
    "scored rows == accepted apply lanes",
  );
  await checkRank(ctx, u, "U");
  return { lanes: nApply + nReserve, wallMs, histogram: histogram(rows) };
};

const SCENARIOS: Record<string, Scenario> = {
  burst_two_users_distinct_shots: burstTwoUsersDistinctShots,
  duplicate_replay_same_shot: duplicateReplaySameShot,
  two_actors_same_shot_id: twoActorsSameShotId,
  serializable_burst: serializableBurst,
  rpc_vs_direct_low_confidence_insert: rpcVsDirectLowConfidenceInsert,
  owner_direct_scored_inserts: ownerDirectScoredInserts,
  account_delete_vs_sync: accountDeleteVsSync,
  session_delete_vs_sync: sessionDeleteVsSync,
  cancel_during_call: cancelDuringCall,
  rls_rank_visibility: rlsRankVisibility,
  reserve_vs_apply_free_limit: reserveVsApplyFreeLimit,
};

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
const results: IterationResult[] = [];
let sqlShared: Sql | null = null;

function sharedSql(): Sql {
  if (!sqlShared) {
    sqlShared = postgres(PG_URL, {
      max: 48,
      idle_timeout: 30,
      connect_timeout: 30,
      prepare: false,
    });
  }
  return sqlShared;
}

function iterationSeeds(name: string): number[] {
  if (REPLAY) {
    const [s, seed] = REPLAY.split(":");
    return s === name ? [Number(seed)] : [];
  }
  return Array.from({ length: ITER }, (_, i) => fnv1a(`${name}:${CAMPAIGN_SEED}:${i}`));
}

async function runIteration(name: string, seed: number): Promise<IterationResult> {
  const ctx: Ctx = {
    sql: sharedSql(),
    rng: new Rng(seed),
    seed,
    scenario: name,
    notes: {},
    violations: [],
  };
  const t0 = performance.now();
  let lanes = 0;
  let wallMs = 0;
  let hist: Record<string, number> = {};
  try {
    const out = await SCENARIOS[name](ctx);
    lanes = out.lanes;
    wallMs = out.wallMs;
    hist = out.histogram;
  } catch (e) {
    ctx.violations.push({
      invariant: "harness_error",
      detail: `${(e as Error).message} (${sqlstateOf(e)})`,
    });
  }
  const res: IterationResult = {
    scenario: name,
    seed,
    ok: ctx.violations.length === 0,
    lanes,
    wallMs: wallMs || Math.round(performance.now() - t0),
    histogram: hist,
    violations: ctx.violations,
    notes: ctx.notes,
    replay: `STRESS_REPLAY=${name}:${seed} ./supabase/tests/stress/db-rank/run.sh`,
  };
  results.push(res);
  return res;
}

async function writeReports(): Promise<void> {
  await Deno.mkdir(OUT_DIR, { recursive: true });
  const table = results.map((r) => ({
    scenario: r.scenario,
    seed: r.seed,
    outcome: r.ok ? "HELD" : "BROKEN",
    lanes: r.lanes,
    wallMs: r.wallMs,
    violations: r.violations.map((v) => v.invariant),
    replay: r.replay,
  }));
  const byScenario: Record<
    string,
    { iterations: number; lanes: number; failed: number; failedSeeds: number[] }
  > = {};
  for (const r of results) {
    const s = (byScenario[r.scenario] ??= { iterations: 0, lanes: 0, failed: 0, failedSeeds: [] });
    s.iterations += 1;
    s.lanes += r.lanes;
    if (!r.ok) {
      s.failed += 1;
      s.failedSeeds.push(r.seed);
    }
  }
  const summary = {
    campaignSeed: CAMPAIGN_SEED,
    iterPerScenario: ITER,
    replay: REPLAY || null,
    scenariosExecuted: results.length,
    lanesExecuted: results.reduce((n, r) => n + r.lanes, 0),
    failed: results.filter((r) => !r.ok).length,
    byScenario,
    laneTimeoutMs: LANE_TIMEOUT_MS,
    burstBudgetMs: BURST_BUDGET_MS,
  };
  await Deno.writeTextFile(`${OUT_DIR}/results.json`, JSON.stringify(table, null, 2));
  await Deno.writeTextFile(`${OUT_DIR}/results.full.json`, JSON.stringify(results, null, 2));
  await Deno.writeTextFile(`${OUT_DIR}/summary.json`, JSON.stringify(summary, null, 2));
  console.log(`db-rank stress: wrote ${OUT_DIR}/{results,results.full,summary}.json`);
  console.log(JSON.stringify(summary, null, 2));
}

const names = Object.keys(SCENARIOS).filter((n) => ONLY.length === 0 || ONLY.includes(n));
let remaining = names.filter((n) => iterationSeeds(n).length > 0).length;

for (const name of names) {
  const seeds = iterationSeeds(name);
  if (seeds.length === 0) continue;
  Deno.test({
    name: `db-rank stress: ${name} ×${seeds.length}`,
    ignore: skip,
    sanitizeResources: false,
    sanitizeOps: false,
    async fn() {
      const failed: IterationResult[] = [];
      for (const seed of seeds) {
        const r = await runIteration(name, seed);
        if (!r.ok) failed.push(r);
      }
      remaining -= 1;
      if (remaining === 0) {
        await writeReports();
        await sharedSql().end({ timeout: 5 });
      }
      const summary = failed.map(
        (f) =>
          `seed ${f.seed}: ${f.violations.map((v) => `${v.invariant} — ${v.detail}`).join(" | ")}\n  replay: ${f.replay}`,
      );
      assertEquals(
        failed.length,
        0,
        `${failed.length}/${seeds.length} iterations violated an invariant:\n${summary.join("\n")}`,
      );
    },
  });
}
