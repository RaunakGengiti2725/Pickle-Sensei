// Route scenarios for the Edge Function perf harness. Every scenario is
// deterministic from (seed, request index): the same inputs reproduce the
// same upstream call matrix, so a failure record + seed replays exactly.

import {
  activeSubscriber,
  googleIdToken,
  seededUuid,
  sessionToken,
  userIdFor,
  VERSION_VECTOR,
  WEBHOOK_SECRET,
  type Fixtures,
  type RequestSpec,
} from "./perfHarness.ts";

export type TokenKind = "session" | "google" | "none";

export interface ScenarioContext {
  seed: string;
  /** Total measured requests in this run (drives id generation only). */
  requests: number;
}

export interface Scenario {
  id: string;
  route: string;
  variant: string;
  /** How many distinct users the measured requests rotate through. "unique"
   * = a fresh user per request (read caches cold; auth cold unless
   * `warmAuth`). Unique populations are also seeded per scenario so no other
   * scenario can have warmed their caches. */
  users: number | "unique";
  /** For "unique" populations: prime the auth cache for every user first so
   * the measured request isolates the ROUTE cache miss from the auth miss. */
  warmAuth?: boolean;
  token: TokenKind;
  /** Extra per-user warm-up requests (beyond auth priming). */
  warmRoute?: (ctx: ScenarioContext, userIndex: number) => RequestSpec;
  fixtures: (fixtures: Fixtures, ctx: ScenarioContext) => void;
  build: (ctx: ScenarioContext, index: number, userIndex: number) => RequestSpec;
  expectStatus: number[];
  /** Counted against the ">3 round trips on the hot path" threshold. */
  hotPath: boolean;
  /** Reduced request count under simulated latency (long sequential chains). */
  heavy?: boolean;
  notes?: string;
}

const PERMIT_ID = seededUuid("perf:permit");
const SESSION_ID = seededUuid("perf:session");
const ANALYSIS_ID = seededUuid("perf:analysis");
const DELETE_CHALLENGE = seededUuid("perf:delete-challenge");

export function ipFor(userIndex: number): string {
  return `10.${(userIndex >> 16) & 255}.${(userIndex >> 8) & 255}.${userIndex & 255}`;
}

export function tokenFor(kind: TokenKind, seed: string, userIndex: number, nonce = ""): string {
  const userId = userIdFor(seed, userIndex);
  if (kind === "session") return sessionToken(userId, nonce);
  if (kind === "google") return googleIdToken(userId, nonce);
  return "";
}

function eqValue(params: URLSearchParams, column: string): string | null {
  const raw = params.get(column);
  return raw && raw.startsWith("eq.") ? raw.slice(3) : null;
}

function inValues(params: URLSearchParams, column: string): string[] {
  const raw = params.get(column);
  if (!raw || !raw.startsWith("in.(")) return [];
  return raw
    .slice(4, -1)
    .split(",")
    .map((v) => v.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function profileRow(id: string): Record<string, unknown> {
  return {
    id,
    email: `${id.slice(0, 8)}@example.com`,
    onboarding_state: "complete",
    provider: "google",
    skill_level: "intermediate",
    handedness: "right",
    primary_goal: "dinks",
    biggest_problem: "consistency",
    focus_checkpoint: "contact_position",
    first_name: "Perf",
    gender: null,
    age_range: "30_39",
    play_frequency: "weekly",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

const CONSENT_GRANTED = [
  {
    id: seededUuid("perf:consent:grant"),
    scope: "evaluation_telemetry",
    action: "grant",
    consent_version: "2026-08-01",
    created_at: "2026-08-01T00:00:00.000Z",
  },
];

function baseFixtures(fixtures: Fixtures): void {
  fixtures.tables = {};
  fixtures.redisSeed = [];
  fixtures.resolvers = {
    profiles: (params) => {
      const id = eqValue(params, "id");
      return id ? [profileRow(id)] : [];
    },
    analysis_permits: (params) => {
      const id = eqValue(params, "id");
      return id
        ? [{ id, status: "reserved", outcome: null, created_at: "2026-09-01T00:00:00.000Z" }]
        : [];
    },
    sessions: (params) => {
      const id = eqValue(params, "id");
      return id
        ? [{ id, started_at: "2026-09-01T00:00:00.000Z", ended_at: null, shot_type: "dink" }]
        : [];
    },
    evaluation_trials: (params) => {
      const id = eqValue(params, "id");
      return id ? [{ id }] : [];
    },
    user_saved_drills: (params) => {
      const slug = eqValue(params, "drill_slug") ?? eqValue(params, "slug");
      return slug ? [{ drill_slug: slug, slug, saved_at: "2026-09-01T00:00:00.000Z" }] : [];
    },
    shots: () => [],
    webhook_events: () => [],
    account_external_credentials: () => [],
  };
  fixtures.rpcs.access_state = [{ premium: false, scored_count: 0, reserved_count: 0 }];
  fixtures.rpcs.apply_synced_shot = "accepted";
  fixtures.subscriber = activeSubscriber(false);
}

export function shotPayload(
  seed: string,
  index: number,
  shotIndex: number,
): Record<string, unknown> {
  const id = seededUuid(`${seed}:shot:${index}:${shotIndex}`);
  return {
    id,
    source: "real",
    analysisPermitId: seededUuid(`${seed}:permit:${index}:${shotIndex}`),
    sessionId: null,
    shotType: "dink",
    cameraView: "side",
    capturedAt: "2026-09-01T12:00:00.000Z",
    timestamps: { startMs: 0, contactMs: 850, endMs: 1600 },
    resultKind: "scored",
    overallScore: 7.25,
    confidence: 0.91,
    phases: [
      { key: "preparation", startMs: 0, representativeMs: 300, endMs: 600, confidence: 0.9 },
      { key: "contact", startMs: 600, representativeMs: 850, endMs: 1000, confidence: 0.92 },
      { key: "recovery", startMs: 1000, representativeMs: 1300, endMs: 1600, confidence: 0.88 },
    ],
    checkpoints: [
      {
        key: "contact_position",
        score: 78,
        confidence: 0.9,
        band: "green",
        direction: "hold",
        severity: 0.1,
        applicable: true,
      },
      {
        key: "paddle_set",
        score: 62,
        confidence: 0.85,
        band: "yellow",
        direction: "earlier",
        severity: 0.4,
        applicable: true,
      },
      {
        key: "athletic_base",
        score: 71,
        confidence: 0.8,
        band: "green",
        direction: "hold",
        severity: 0.2,
        applicable: true,
      },
      {
        key: "face_wrist_stability",
        score: null,
        confidence: 0.3,
        band: "unscored",
        direction: "",
        severity: 0,
        applicable: false,
      },
    ],
    versionVector: VERSION_VECTOR,
  };
}

export function trialPayload(
  seed: string,
  index: number,
  trialIndex: number,
): Record<string, unknown> {
  return {
    trialId: seededUuid(`${seed}:trial:${index}:${trialIndex}`),
    capturedAt: "2026-09-01T12:00:00.000Z",
    shotType: "dink",
    cameraView: "side",
    predicted: { overallScore: 7.1, confidence: 0.9 },
    device: { model: "iPhone", os: "iOS" },
  };
}

function progressRows(count: number): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const start = Date.UTC(2026, 0, 1);
  for (let i = 0; i < count; i += 1) {
    rows.push({
      day: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
      shot_type: i % 2 === 0 ? "dink" : "drive",
      scoring_model_version: "scoring-1",
      shot_count: 3 + (i % 5),
      avg_score: 6 + (i % 30) / 10,
      best_score: 7 + (i % 20) / 10,
    });
  }
  return rows;
}

function practiceDays(count: number): Array<Record<string, unknown>> {
  const start = Date.UTC(2026, 0, 1);
  return Array.from({ length: count }, (_, i) => ({
    day: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
  }));
}

const RANK_ROWS = {
  player_technique_rating: [
    {
      shot_type: "dink",
      score: 7.2,
      captured_at: "2026-09-01T12:00:00.000Z",
      sampled_count: 12,
      confidence_weight: 0.8,
    },
    {
      shot_type: "drive",
      score: 6.4,
      captured_at: "2026-09-01T12:00:00.000Z",
      sampled_count: 8,
      confidence_weight: 0.7,
    },
  ],
  player_rank_state: [
    {
      rating: 6.8,
      tier: "silver",
      technique_count: 2,
      scored_shot_count: 20,
      updated_at: "2026-09-01T12:00:00.000Z",
    },
  ],
};

const authed = (
  ctx: ScenarioContext,
  userIndex: number,
  spec: Omit<RequestSpec, "token" | "ip">,
  token: TokenKind = "session",
  nonce = "",
): RequestSpec => ({
  ...spec,
  token: tokenFor(token, ctx.seed, userIndex, nonce),
  ip: ipFor(userIndex),
});

const shotsSync = (count: number): Scenario => ({
  id: `shots-sync-${count}`,
  route: "POST /v1/shots:sync",
  variant: `${count} new shot${count === 1 ? "" : "s"}`,
  users: 250,
  token: "session",
  fixtures: baseFixtures,
  build: (ctx, index, userIndex) =>
    authed(ctx, userIndex, {
      method: "POST",
      path: "/v1/shots:sync",
      body: { shots: Array.from({ length: count }, (_, j) => shotPayload(ctx.seed, index, j)) },
    }),
  expectStatus: [200],
  hotPath: true,
  heavy: count >= 50,
  notes: "1 batched replay SELECT + 1 sequential apply_synced_shot RPC per new shot.",
});

const trials = (count: number): Scenario => ({
  id: `evaluation-trials-${count}`,
  route: "POST /v1/me/evaluation/trials",
  variant: `${count} trial${count === 1 ? "" : "s"}`,
  users: 250,
  token: "session",
  fixtures: (f) => {
    baseFixtures(f);
    f.tables.consent_records = CONSENT_GRANTED;
  },
  build: (ctx, index, userIndex) =>
    authed(ctx, userIndex, {
      method: "POST",
      path: "/v1/me/evaluation/trials",
      body: { trials: Array.from({ length: count }, (_, j) => trialPayload(ctx.seed, index, j)) },
    }),
  expectStatus: [200],
  hotPath: true,
  heavy: count >= 50,
  notes: "1 consent read + sequential (upsert + ownership SELECT) per trial.",
});

export const SCENARIOS: Scenario[] = [
  {
    id: "healthz",
    route: "GET /healthz",
    variant: "public",
    users: 250,
    token: "none",
    fixtures: baseFixtures,
    build: (_ctx, _index, userIndex) => ({ method: "GET", path: "/healthz", ip: ipFor(userIndex) }),
    expectStatus: [200],
    hotPath: false,
  },
  {
    id: "privacy",
    route: "GET /privacy",
    variant: "public legal text",
    users: 250,
    token: "none",
    fixtures: baseFixtures,
    build: (_ctx, _index, userIndex) => ({ method: "GET", path: "/privacy", ip: ipFor(userIndex) }),
    expectStatus: [200],
    hotPath: false,
  },
  {
    id: "account-bootstrap",
    route: "POST /v1/account/bootstrap",
    variant: "google id token, profile exists",
    users: "unique",
    token: "google",
    fixtures: baseFixtures,
    build: (ctx, index, userIndex) =>
      authed(
        ctx,
        userIndex,
        { method: "POST", path: "/v1/account/bootstrap", body: {} },
        "google",
        `boot-${index}`,
      ),
    expectStatus: [200],
    hotPath: true,
  },
  {
    id: "auth-refresh",
    route: "POST /v1/auth/refresh",
    variant: "rotate refresh token",
    users: 250,
    token: "none",
    fixtures: baseFixtures,
    build: (ctx, index, userIndex) => ({
      method: "POST",
      path: "/v1/auth/refresh",
      ip: ipFor(userIndex),
      body: { refreshToken: `rt-${ctx.seed}-${index}` },
    }),
    expectStatus: [200],
    hotPath: true,
  },
  {
    id: "auth-logout",
    route: "POST /v1/auth/logout",
    variant: "auth warm",
    users: 250,
    token: "session",
    fixtures: baseFixtures,
    build: (ctx, _index, userIndex) =>
      authed(ctx, userIndex, { method: "POST", path: "/v1/auth/logout" }),
    expectStatus: [204],
    hotPath: false,
    notes: "Logout evicts the auth cache, so request N+1 for the same user re-verifies.",
  },
  {
    id: "me",
    route: "GET /v1/me",
    variant: "auth warm, profile exists",
    users: 250,
    token: "session",
    fixtures: baseFixtures,
    build: (ctx, _index, userIndex) => authed(ctx, userIndex, { method: "GET", path: "/v1/me" }),
    expectStatus: [200],
    hotPath: true,
  },
  {
    id: "me-missing-profile",
    route: "GET /v1/me",
    variant: "profile row missing (trigger lag path)",
    users: 250,
    token: "session",
    fixtures: (f) => {
      baseFixtures(f);
      f.resolvers.profiles = () => [];
    },
    build: (ctx, _index, userIndex) => authed(ctx, userIndex, { method: "GET", path: "/v1/me" }),
    expectStatus: [503],
    hotPath: false,
    heavy: true,
    notes: "Degraded path: retries after a fixed sleep, then 503.",
  },
  {
    id: "onboarding",
    route: "PUT /v1/me/onboarding",
    variant: "auth warm",
    users: 250,
    token: "session",
    fixtures: baseFixtures,
    build: (ctx, _index, userIndex) =>
      authed(ctx, userIndex, {
        method: "PUT",
        path: "/v1/me/onboarding",
        body: {
          skillLevel: "intermediate",
          handedness: "right",
          goal: "dinks",
          biggestProblem: "consistency",
          firstName: "Perf",
          gender: "prefer_not_to_say",
          ageRange: "30_39",
          playFrequency: "weekly",
        },
      }),
    expectStatus: [200],
    hotPath: true,
  },
  {
    id: "access",
    route: "GET /v1/me/access",
    variant: "auth warm",
    users: 250,
    token: "session",
    fixtures: baseFixtures,
    build: (ctx, _index, userIndex) =>
      authed(ctx, userIndex, { method: "GET", path: "/v1/me/access" }),
    expectStatus: [200],
    hotPath: true,
  },
  {
    id: "access-auth-cold-session",
    route: "GET /v1/me/access",
    variant: "auth cache MISS, Supabase session token (getUser)",
    users: "unique",
    token: "session",
    fixtures: baseFixtures,
    build: (ctx, index, userIndex) =>
      authed(ctx, userIndex, { method: "GET", path: "/v1/me/access" }, "session", `cold-${index}`),
    expectStatus: [200],
    hotPath: true,
  },
  {
    id: "access-auth-cold-google",
    route: "GET /v1/me/access",
    variant: "auth cache MISS, transitional Google id token (signInWithIdToken)",
    users: "unique",
    token: "google",
    fixtures: baseFixtures,
    build: (ctx, index, userIndex) =>
      authed(ctx, userIndex, { method: "GET", path: "/v1/me/access" }, "google", `cold-${index}`),
    expectStatus: [200],
    hotPath: true,
  },
  {
    id: "billing-sync",
    route: "POST /v1/billing/sync",
    variant: "auth warm, RevenueCat verified",
    users: 250,
    token: "session",
    fixtures: (f) => {
      baseFixtures(f);
      f.subscriber = activeSubscriber(true);
    },
    build: (ctx, _index, userIndex) =>
      authed(ctx, userIndex, { method: "POST", path: "/v1/billing/sync", body: {} }),
    expectStatus: [200],
    hotPath: true,
  },
  {
    id: "permits-reserve",
    route: "POST /v1/analysis-permits",
    variant: "auth warm, accepted",
    users: 250,
    token: "session",
    fixtures: baseFixtures,
    build: (ctx, index, userIndex) =>
      authed(ctx, userIndex, {
        method: "POST",
        path: "/v1/analysis-permits",
        body: { idempotencyKey: `perf-${ctx.seed}-${index}` },
      }),
    expectStatus: [200],
    hotPath: true,
  },
  {
    id: "permits-finalize",
    route: "POST /v1/analysis-permits/:id/finalize",
    variant: "auth warm, reserved → cancelled",
    users: 250,
    token: "session",
    fixtures: baseFixtures,
    build: (ctx, _index, userIndex) =>
      authed(ctx, userIndex, {
        method: "POST",
        path: `/v1/analysis-permits/${PERMIT_ID}/finalize`,
        body: { outcome: "cancelled", ratingId: null },
      }),
    expectStatus: [200],
    hotPath: true,
  },
  shotsSync(1),
  shotsSync(10),
  shotsSync(50),
  shotsSync(200),
  {
    id: "shots-sync-replay-10",
    route: "POST /v1/shots:sync",
    variant: "10 shots, all already synced (replay)",
    users: 250,
    token: "session",
    fixtures: (f) => {
      baseFixtures(f);
      f.resolvers.shots = (params) => inValues(params, "id").map((id) => ({ id }));
    },
    build: (ctx, index, userIndex) =>
      authed(ctx, userIndex, {
        method: "POST",
        path: "/v1/shots:sync",
        body: { shots: Array.from({ length: 10 }, (_, j) => shotPayload(ctx.seed, index, j)) },
      }),
    expectStatus: [200],
    hotPath: true,
  },
  {
    id: "sessions-create",
    route: "POST /v1/sessions",
    variant: "auth warm",
    users: 250,
    token: "session",
    fixtures: baseFixtures,
    build: (ctx, index, userIndex) =>
      authed(ctx, userIndex, {
        method: "POST",
        path: "/v1/sessions",
        body: {
          id: seededUuid(`${ctx.seed}:session:${index}`),
          startedAt: "2026-09-01T12:00:00.000Z",
          shotType: "dink",
        },
      }),
    expectStatus: [200],
    hotPath: true,
  },
  {
    id: "sessions-finalize",
    route: "POST /v1/sessions/:id/finalize",
    variant: "auth warm, open session",
    users: 250,
    token: "session",
    fixtures: baseFixtures,
    build: (ctx, _index, userIndex) =>
      authed(ctx, userIndex, {
        method: "POST",
        path: `/v1/sessions/${SESSION_ID}/finalize`,
        body: { endedAt: "2026-09-01T12:30:00.000Z" },
      }),
    expectStatus: [200],
    hotPath: true,
  },
  trials(1),
  trials(10),
  trials(50),
  trials(200),
  {
    id: "analysis-feedback",
    route: "POST /v1/analyses/:id/feedback",
    variant: "auth warm, consent active",
    users: 250,
    token: "session",
    fixtures: (f) => {
      baseFixtures(f);
      f.resolvers.shots = (params) => {
        const id = eqValue(params, "id");
        return id ? [{ id }] : [];
      };
      f.tables.consent_records = CONSENT_GRANTED;
    },
    build: (ctx, _index, userIndex) =>
      authed(ctx, userIndex, {
        method: "POST",
        path: `/v1/analyses/${ANALYSIS_ID}/feedback`,
        body: { rating: "accurate", comment: "Looks right." },
      }),
    expectStatus: [200, 201],
    hotPath: true,
  },
  {
    id: "progress-cache-hit",
    route: "GET /v1/progress",
    variant: "auth warm, progress cache HIT",
    users: 250,
    token: "session",
    warmRoute: (ctx, userIndex) => authed(ctx, userIndex, { method: "GET", path: "/v1/progress" }),
    fixtures: (f) => {
      baseFixtures(f);
      f.tables.progress_daily = progressRows(30);
      f.tables.practice_days = practiceDays(30);
    },
    build: (ctx, _index, userIndex) =>
      authed(ctx, userIndex, { method: "GET", path: "/v1/progress" }),
    expectStatus: [200],
    hotPath: true,
  },
  {
    id: "progress-cache-miss",
    route: "GET /v1/progress",
    variant: "auth warm, progress cache MISS, 30 days (1 page each)",
    users: "unique",
    warmAuth: true,
    token: "session",
    fixtures: (f) => {
      baseFixtures(f);
      f.tables.progress_daily = progressRows(30);
      f.tables.practice_days = practiceDays(30);
    },
    build: (ctx, _index, userIndex) =>
      authed(ctx, userIndex, { method: "GET", path: "/v1/progress" }),
    expectStatus: [200],
    hotPath: true,
  },
  {
    id: "progress-cache-miss-2500",
    route: "GET /v1/progress",
    variant: "auth warm, progress cache MISS, 2500 progress_daily rows (3 pages)",
    users: "unique",
    warmAuth: true,
    token: "session",
    fixtures: (f) => {
      baseFixtures(f);
      f.tables.progress_daily = progressRows(2500);
      f.tables.practice_days = practiceDays(400);
    },
    build: (ctx, _index, userIndex) =>
      authed(ctx, userIndex, { method: "GET", path: "/v1/progress" }),
    expectStatus: [200],
    hotPath: true,
    notes: "readAllRows pages in 1000-row units; row count grows the sequential page chain.",
  },
  {
    id: "rank-cache-hit",
    route: "GET /v1/rank",
    variant: "auth warm, rank cache HIT",
    users: 250,
    token: "session",
    warmRoute: (ctx, userIndex) => authed(ctx, userIndex, { method: "GET", path: "/v1/rank" }),
    fixtures: (f) => {
      baseFixtures(f);
      f.tables.player_technique_rating = RANK_ROWS.player_technique_rating;
      f.tables.player_rank_state = RANK_ROWS.player_rank_state;
    },
    build: (ctx, _index, userIndex) => authed(ctx, userIndex, { method: "GET", path: "/v1/rank" }),
    expectStatus: [200],
    hotPath: true,
  },
  {
    id: "rank-cache-miss",
    route: "GET /v1/rank",
    variant: "auth warm, rank cache MISS",
    users: "unique",
    warmAuth: true,
    token: "session",
    fixtures: (f) => {
      baseFixtures(f);
      f.tables.player_technique_rating = RANK_ROWS.player_technique_rating;
      f.tables.player_rank_state = RANK_ROWS.player_rank_state;
    },
    build: (ctx, _index, userIndex) => authed(ctx, userIndex, { method: "GET", path: "/v1/rank" }),
    expectStatus: [200],
    hotPath: true,
  },
  {
    id: "progress-cache-l2-hit",
    route: "GET /v1/progress",
    variant: "auth warm, L1 MISS, Redis (L2) HIT — degrades to a DB miss with Redis off",
    users: "unique",
    warmAuth: true,
    token: "session",
    fixtures: (f, ctx) => {
      baseFixtures(f);
      f.tables.progress_daily = progressRows(30);
      f.tables.practice_days = practiceDays(30);
      const value = JSON.stringify({ series: [], practiceDays: [], streak: null, l2Seeded: true });
      for (let i = 0; i < ctx.requests; i += 1) {
        f.redisSeed.push({ key: `progress:${userIdFor(ctx.seed, i)}`, value, ttlSeconds: 60 });
      }
    },
    build: (ctx, _index, userIndex) =>
      authed(ctx, userIndex, { method: "GET", path: "/v1/progress" }),
    expectStatus: [200],
    hotPath: true,
    notes: "Seeded L2 body is a stand-in; response bytes here are not representative.",
  },
  {
    id: "rank-cache-l2-hit",
    route: "GET /v1/rank",
    variant: "auth warm, L1 MISS, Redis (L2) HIT — degrades to a DB miss with Redis off",
    users: "unique",
    warmAuth: true,
    token: "session",
    fixtures: (f, ctx) => {
      baseFixtures(f);
      f.tables.player_technique_rating = RANK_ROWS.player_technique_rating;
      f.tables.player_rank_state = RANK_ROWS.player_rank_state;
      const value = JSON.stringify({ rank: null, l2Seeded: true });
      for (let i = 0; i < ctx.requests; i += 1) {
        f.redisSeed.push({ key: `rank:${userIdFor(ctx.seed, i)}`, value, ttlSeconds: 60 });
      }
    },
    build: (ctx, _index, userIndex) => authed(ctx, userIndex, { method: "GET", path: "/v1/rank" }),
    expectStatus: [200],
    hotPath: true,
    notes: "Seeded L2 body is a stand-in; response bytes here are not representative.",
  },
  {
    id: "consent-status",
    route: "GET /v1/me/consent/status",
    variant: "auth warm",
    users: 250,
    token: "session",
    fixtures: (f) => {
      baseFixtures(f);
      f.tables.consent_records = CONSENT_GRANTED;
    },
    build: (ctx, _index, userIndex) =>
      authed(ctx, userIndex, { method: "GET", path: "/v1/me/consent/status" }),
    expectStatus: [200],
    hotPath: true,
  },
  {
    id: "consent-grant",
    route: "POST /v1/me/consent/grant",
    variant: "auth warm",
    users: 250,
    token: "session",
    fixtures: (f) => {
      baseFixtures(f);
      f.tables.consent_records = CONSENT_GRANTED;
    },
    build: (ctx, _index, userIndex) =>
      authed(ctx, userIndex, {
        method: "POST",
        path: "/v1/me/consent/grant",
        body: { scope: "evaluation_telemetry", consentVersion: "2026-08-01" },
      }),
    expectStatus: [200],
    hotPath: true,
  },
  {
    id: "consent-withdraw",
    route: "POST /v1/me/consent/withdraw",
    variant: "auth warm, scope active",
    users: 250,
    token: "session",
    fixtures: (f) => {
      baseFixtures(f);
      f.tables.consent_records = CONSENT_GRANTED;
    },
    build: (ctx, _index, userIndex) =>
      authed(ctx, userIndex, {
        method: "POST",
        path: "/v1/me/consent/withdraw",
        body: { scope: "evaluation_telemetry" },
      }),
    expectStatus: [200],
    hotPath: true,
  },
  {
    id: "catalog-drills",
    route: "GET /v1/catalog/drills",
    variant: "auth warm, no filters",
    users: 250,
    token: "session",
    fixtures: baseFixtures,
    build: (ctx, _index, userIndex) =>
      authed(ctx, userIndex, { method: "GET", path: "/v1/catalog/drills" }),
    expectStatus: [200],
    hotPath: true,
  },
  {
    id: "catalog-drill-detail",
    route: "GET /v1/catalog/drills/:slug",
    variant: "auth warm",
    users: 250,
    token: "session",
    fixtures: baseFixtures,
    build: (ctx, _index, userIndex) =>
      authed(ctx, userIndex, { method: "GET", path: "/v1/catalog/drills/wall-dink-rally" }),
    expectStatus: [200],
    hotPath: true,
  },
  {
    id: "saved-drills-list-0",
    route: "GET /v1/me/saved-drills",
    variant: "auth warm, none saved",
    users: 250,
    token: "session",
    fixtures: (f) => {
      baseFixtures(f);
      f.resolvers.user_saved_drills = () => [];
    },
    build: (ctx, _index, userIndex) =>
      authed(ctx, userIndex, { method: "GET", path: "/v1/me/saved-drills" }),
    expectStatus: [200],
    hotPath: true,
  },
  {
    id: "saved-drills-list-20",
    route: "GET /v1/me/saved-drills",
    variant: "auth warm, 20 saved",
    users: 250,
    token: "session",
    fixtures: (f) => {
      baseFixtures(f);
      f.resolvers.user_saved_drills = () =>
        Array.from({ length: 20 }, (_, i) => ({
          drill_slug: i % 2 === 0 ? "wall-dink-rally" : "dink-target-boxes",
          slug: i % 2 === 0 ? "wall-dink-rally" : "dink-target-boxes",
          saved_at: "2026-09-01T00:00:00.000Z",
        }));
    },
    build: (ctx, _index, userIndex) =>
      authed(ctx, userIndex, { method: "GET", path: "/v1/me/saved-drills" }),
    expectStatus: [200],
    hotPath: true,
  },
  {
    id: "saved-drill-put",
    route: "PUT /v1/me/saved-drills/:slug",
    variant: "auth warm",
    users: 250,
    token: "session",
    fixtures: baseFixtures,
    build: (ctx, _index, userIndex) =>
      authed(ctx, userIndex, { method: "PUT", path: "/v1/me/saved-drills/wall-dink-rally" }),
    expectStatus: [200, 201],
    hotPath: true,
  },
  {
    id: "saved-drill-delete",
    route: "DELETE /v1/me/saved-drills/:slug",
    variant: "auth warm",
    users: 250,
    token: "session",
    fixtures: baseFixtures,
    build: (ctx, _index, userIndex) =>
      authed(ctx, userIndex, { method: "DELETE", path: "/v1/me/saved-drills/wall-dink-rally" }),
    expectStatus: [200, 204],
    hotPath: true,
  },
  {
    id: "training-plan-current",
    route: "GET /v1/training-plans/current",
    variant: "auth warm",
    users: 250,
    token: "session",
    fixtures: baseFixtures,
    build: (ctx, _index, userIndex) =>
      authed(ctx, userIndex, { method: "GET", path: "/v1/training-plans/current" }),
    expectStatus: [200],
    hotPath: true,
  },
  {
    id: "delete-request",
    route: "POST /v1/me/delete-request",
    variant: "auth warm, no survey",
    users: 1000,
    token: "session",
    fixtures: baseFixtures,
    build: (ctx, _index, userIndex) =>
      authed(ctx, userIndex, { method: "POST", path: "/v1/me/delete-request", body: {} }),
    expectStatus: [200],
    hotPath: false,
  },
  {
    id: "delete-request-survey",
    route: "POST /v1/me/delete-request",
    variant: "auth warm, with exit survey",
    users: 1000,
    token: "session",
    fixtures: baseFixtures,
    build: (ctx, _index, userIndex) =>
      authed(ctx, userIndex, {
        method: "POST",
        path: "/v1/me/delete-request",
        body: { survey: { reason: "other", details: "Perf harness." } },
      }),
    expectStatus: [200],
    hotPath: false,
  },
  {
    id: "delete-confirm",
    route: "POST /v1/me/delete-confirm",
    variant: "auth warm, google account, RevenueCat cleanup",
    users: 500,
    token: "session",
    fixtures: (f) => {
      baseFixtures(f);
      f.resolvers.account_deletion_requests = () => [
        {
          id: seededUuid("perf:deletion-request"),
          challenge: DELETE_CHALLENGE,
          created_at: new Date(Date.now() - 30_000).toISOString(),
          expires_at: new Date(Date.now() + 600_000).toISOString(),
          status: "pending",
        },
      ];
    },
    build: (ctx, _index, userIndex) =>
      authed(ctx, userIndex, {
        method: "POST",
        path: "/v1/me/delete-confirm",
        body: { challenge: DELETE_CHALLENGE },
      }),
    expectStatus: [200, 204],
    hotPath: false,
  },
  {
    id: "webhook-revenuecat",
    route: "POST /webhooks/revenuecat",
    variant: "secret-gated, RENEWAL, one subject",
    users: 250,
    token: "none",
    fixtures: (f) => {
      baseFixtures(f);
      f.subscriber = activeSubscriber(true);
    },
    build: (ctx, index, userIndex) => ({
      method: "POST",
      path: "/webhooks/revenuecat",
      ip: ipFor(userIndex),
      headers: { Authorization: WEBHOOK_SECRET },
      body: {
        event: {
          id: seededUuid(`${ctx.seed}:webhook:${index}`),
          type: "RENEWAL",
          app_user_id: userIdFor(ctx.seed, userIndex),
          original_app_user_id: userIdFor(ctx.seed, userIndex),
          event_timestamp_ms: Date.now(),
        },
      },
    }),
    expectStatus: [200],
    hotPath: false,
  },
];

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((scenario) => scenario.id === id);
}
