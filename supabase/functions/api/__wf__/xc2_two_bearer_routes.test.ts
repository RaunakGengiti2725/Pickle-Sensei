// xc2 — cross-user isolation audit #2, part 1: the REAL edge function driven
// with two (then N) mocked bearers against the stateful RLS-emulating fake
// Supabase in xc2_fake_supabase.ts.
//
// Question under test: can an authenticated user B, through ANY authenticated
// route of supabase/functions/api/index.ts, read, mutate, reserve, finalize,
// sync into, delete or otherwise touch user A's data — including through the
// edge function's own cross-request state (auth cache keyed by bearer hash,
// rank/progress response cache keyed by user id, in-flight coalescing, rate
// limit windows)?
//
// Three invariants are asserted for EVERY attacker request:
//   I1  no victim canary (victim ids / victim-owned strings) appears in the
//       response unless the attacker itself sent that string in the request;
//   I2  the victim's rows are byte-identical before and after the request;
//   I3  every PostgREST/Auth call made while serving the request acted as the
//       attacker, the service role (only on the service-only tables the
//       route legitimately administers) or anonymous (Auth endpoints) — never
//       as another user (auth-cache / client confusion).
//
// Sections:
//   A. deterministic route matrix (every authenticated route × foreign-id
//      attack variants) with the contract status codes;
//   B. edge-state isolation: auth cache, rank/progress cache, coalescing,
//      logout / refresh rotation / forged & expired bearers, account deletion;
//   C. seeded fuzz at scale (XC2_FUZZ_ITERATIONS, default 3000) over a pool
//      of users, every failure recorded with seed + iteration + request so it
//      replays with XC2_FUZZ_SEED / XC2_FUZZ_REPLAY;
//   D. concurrency: interleaved A/B requests on the cached, coalesced routes.
//
// Artifacts (JSON) are written under $XC2_ARTIFACT_DIR when set.

import { assert, assertEquals } from "@std/assert";
import {
  edgeRequest,
  type EdgeUnderTest,
  type FakeSupabase,
  type FakeUser,
  loadEdge,
  providerIdToken,
  type RecordedCall,
  type Row,
} from "./xc2_fake_supabase.ts";

// ── Deterministic PRNG (mulberry32) ──────────────────────────────────────────

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

const pick = <T>(rng: () => number, items: readonly T[]): T =>
  items[Math.floor(rng() * items.length)];

// ── Artifact output ──────────────────────────────────────────────────────────

const ARTIFACT_DIR = Deno.env.get("XC2_ARTIFACT_DIR") ?? "";

async function writeArtifact(name: string, value: unknown): Promise<string | null> {
  if (!ARTIFACT_DIR) return null;
  await Deno.mkdir(ARTIFACT_DIR, { recursive: true });
  const path = `${ARTIFACT_DIR}/${name}`;
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2) + "\n");
  return path;
}

function heapSnapshot(label: string) {
  const usage = Deno.memoryUsage();
  return {
    label,
    atMs: Date.now(),
    rss: usage.rss,
    heapTotal: usage.heapTotal,
    heapUsed: usage.heapUsed,
    external: usage.external,
  };
}

// ── Seeded users and canaries ────────────────────────────────────────────────

/** Every id owned by user k starts with an 8-hex prefix unique to k, and
 * every text field owned by k carries `xc2canary-<prefix>`; both are what the
 * leak detector scans attacker responses for. */
interface SeededUser {
  user: FakeUser;
  prefix: string;
  canary: string;
  ip: string;
  ids: {
    reservedPermit: string;
    finalizedPermit: string;
    session: string;
    scoredShot: string;
    trial: string;
    challenge: string;
    savedDrill: string;
    idempotencyKey: string;
  };
}

function userId(prefix: string, group: string): string {
  return `${prefix}-0000-4000-8000-${group.padStart(12, "0")}`;
}

function seedUser(
  fake: FakeSupabase,
  k: number,
  provider: "google" | "apple",
  premium: boolean,
): SeededUser {
  const prefix = `c${k.toString(16).padStart(7, "0")}`;
  const canary = `xc2canary-${prefix}`;
  const id = userId(prefix, "0");
  const user = fake.addUser({
    id,
    email: `${canary}@xc2.example`,
    provider,
    providerSubject: `${provider}-sub-${canary}`,
  });
  const profile = fake.rows("profiles").find((p) => p.id === id)!;
  profile.first_name = `${canary}-first`;
  profile.onboarding_state = "complete";
  profile.skill_level = `${canary}-skill`;
  profile.focus_checkpoint = "contact_point";
  const ids = {
    reservedPermit: userId(prefix, "a1"),
    finalizedPermit: userId(prefix, "a2"),
    session: userId(prefix, "b1"),
    scoredShot: userId(prefix, "d1"),
    trial: userId(prefix, "e1"),
    challenge: userId(prefix, "c1"),
    savedDrill: `${canary}-drill`,
    idempotencyKey: `${canary}-idem`,
  };
  const now = Date.now();
  const iso = (deltaMs: number) => new Date(now + deltaMs).toISOString();
  fake.rows("analysis_permits").push(
    {
      id: ids.reservedPermit,
      user_id: id,
      idempotency_key: ids.idempotencyKey,
      status: "reserved",
      outcome: null,
      created_at: iso(-60_000),
    },
    {
      id: ids.finalizedPermit,
      user_id: id,
      idempotency_key: `${canary}-idem-2`,
      status: "finalized",
      outcome: "scored",
      created_at: iso(-3_600_000),
    },
  );
  fake.rows("sessions").push({
    id: ids.session,
    user_id: id,
    started_at: iso(-120_000),
    ended_at: null,
  });
  fake.rows("shots").push({
    id: ids.scoredShot,
    user_id: id,
    session_id: ids.session,
    analysis_permit_id: ids.finalizedPermit,
    shot_type: "drive",
    camera_view: "side",
    captured_at: iso(-3_500_000),
    overall_score: 7.25,
    confidence: 0.9,
    result_kind: "scored",
    created_at: iso(-3_500_000),
  });
  fake.rows("free_rating_ledger").push({
    identity_hash: `hash:${provider}:${user.providerSubject}`,
    scored_count: 1,
  });
  fake.rows("consent_records").push(
    {
      id: userId(prefix, "f1"),
      user_id: id,
      scope: "video_analysis",
      action: "grant",
      consent_version: `${canary}-consent`,
      created_at: iso(-200_000),
    },
    {
      id: userId(prefix, "f2"),
      user_id: id,
      scope: "evaluation_telemetry",
      action: "grant",
      consent_version: `${canary}-consent`,
      created_at: iso(-190_000),
    },
    {
      id: userId(prefix, "f3"),
      user_id: id,
      scope: "model_training",
      action: "grant",
      consent_version: `${canary}-consent`,
      created_at: iso(-180_000),
    },
  );
  fake.rows("evaluation_trials").push({
    id: ids.trial,
    user_id: id,
    payload: { trialId: ids.trial, note: canary },
    created_at: iso(-100_000),
  });
  fake.rows("user_saved_drills").push({
    user_id: id,
    slug: ids.savedDrill,
    saved_at: iso(-90_000),
  });
  fake.rows("player_rank_state").push({
    user_id: id,
    rating: 4 + (k % 7) / 10,
    tier: `${canary}-tier`,
    technique_count: 1,
    scored_shot_count: 1,
    updated_at: iso(-3_400_000),
  });
  fake.rows("player_technique_rating").push({
    user_id: id,
    shot_type: "drive",
    score: 7.25,
    captured_at: iso(-3_500_000),
    sampled_count: 1,
    confidence_weight: 0.9,
  });
  fake.rows("progress_daily").push({
    user_id: id,
    day: "2026-08-30",
    shot_type: "drive",
    scoring_model_version: `${canary}-model`,
    shot_count: 1,
    avg_score: 7.25,
    best_score: 7.25,
  });
  fake.rows("practice_days").push({ user_id: id, day: "2026-08-30" });
  fake.rows("account_deletion_requests").push({
    user_id: id,
    challenge: ids.challenge,
    created_at: iso(-60_000),
    expires_at: iso(14 * 60_000),
  });
  if (premium) {
    fake.rows("billing_entitlements").push({
      user_id: id,
      premium: true,
      product_key: `${canary}-product`,
      expires_at: null,
      verified_at: iso(-1000),
    });
  }
  return { user, prefix, canary, ip: `198.51.100.${(k % 250) + 1}`, ids };
}

/** Every string the victim owns that must never surface for someone else. */
function canariesOf(fake: FakeSupabase, victim: SeededUser): string[] {
  const out = new Set<string>([victim.prefix, victim.canary, victim.user.id]);
  for (const [, rows] of fake.tables) {
    for (const row of rows) {
      const owner = row.user_id ?? row.id;
      if (
        owner !== victim.user.id &&
        row.identity_hash !== `hash:${victim.user.provider}:${victim.user.providerSubject}`
      )
        continue;
      for (const value of Object.values(row)) {
        if (
          typeof value === "string" &&
          value.length >= 8 &&
          (value.includes(victim.prefix) || value.includes(victim.canary))
        ) {
          out.add(value);
        }
      }
    }
  }
  return [...out];
}

function ownedSnapshot(fake: FakeSupabase, victim: SeededUser): string {
  const snapshot: Record<string, Row[]> = {};
  for (const [table, rows] of [...fake.tables].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const owned = rows.filter(
      (row) =>
        row.user_id === victim.user.id ||
        (table === "profiles" && row.id === victim.user.id) ||
        (table === "free_rating_ledger" &&
          row.identity_hash === `hash:${victim.user.provider}:${victim.user.providerSubject}`),
    );
    snapshot[table] = owned;
  }
  return JSON.stringify(snapshot);
}

/** Service-role writes the routes legitimately perform. */
const SERVICE_TABLES = new Set([
  "billing_entitlements",
  "webhook_events",
  "account_external_credentials",
  "auth/admin/users",
]);

function foreignActorCalls(calls: RecordedCall[], attackerId: string): RecordedCall[] {
  return calls.filter((call) => {
    if (call.actor === attackerId) return false;
    if (call.actor === "anon" && call.table?.startsWith("auth/")) return false;
    if (call.actor === "service") {
      const table = call.table ?? "";
      if (table.startsWith("auth/admin/users/")) return false;
      return !SERVICE_TABLES.has(table);
    }
    if (call.actor === "revenuecat") return false;
    if (call.actor === "invalid" && call.table?.startsWith("auth/")) {
      return false;
    }
    return true;
  });
}

// ── Request runner with invariant checks ─────────────────────────────────────

/** Victim strings an attacker has itself SENT in any earlier request (a
 * bookmarked victim slug, an echoed id). Seeing those again in the
 * attacker's own responses is the attacker reading back its own input, not
 * a leak; anything else victim-owned still is. */
const sentByAttacker = new Map<string, Set<string>>();

interface Outcome {
  status: number;
  code: string | null;
  body: string;
  leaked: string[];
  victimMutated: boolean;
  foreignActors: RecordedCall[];
  calls: RecordedCall[];
}

async function attack(
  edge: EdgeUnderTest,
  attacker: SeededUser,
  token: string,
  victim: SeededUser,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<Outcome> {
  const fake = edge.fake;
  const before = ownedSnapshot(fake, victim);
  const canaries = canariesOf(fake, victim);
  const callsBefore = fake.calls.length;
  const request = edgeRequest(method, path, {
    token,
    ip: attacker.ip,
    body,
    headers,
  });
  const requestText = `${path} ${body === undefined ? "" : JSON.stringify(body)}`;
  const response = await edge.handler(request);
  const text = await response.text();
  const calls = fake.calls.slice(callsBefore);
  const after = ownedSnapshot(fake, victim);
  let code: string | null = null;
  try {
    const parsed = JSON.parse(text);
    code = parsed?.error?.code ?? null;
  } catch {
    code = null;
  }
  const sent = sentByAttacker.get(attacker.user.id) ?? new Set<string>();
  sentByAttacker.set(attacker.user.id, sent);
  for (const canary of canaries) {
    if (requestText.includes(canary)) sent.add(canary);
  }
  const leaked =
    attacker.user.id === victim.user.id
      ? []
      : canaries.filter((canary) => text.includes(canary) && !sent.has(canary));
  return {
    status: response.status,
    code,
    body: text,
    leaked,
    victimMutated: attacker.user.id !== victim.user.id && before !== after,
    foreignActors: foreignActorCalls(calls, attacker.user.id),
    calls,
  };
}

// ── Payload builders ─────────────────────────────────────────────────────────

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

function syncShot(
  id: string,
  permitId: string,
  sessionId: string | null,
  resultKind: "scored" | "low_confidence" = "scored",
) {
  return {
    id,
    source: "real",
    analysisPermitId: permitId,
    sessionId,
    shotType: "drive",
    cameraView: "side",
    capturedAt: "2026-09-01T10:00:00.000Z",
    timestamps: { startMs: 0, contactMs: 500, endMs: 1000 },
    overallScore: resultKind === "scored" ? 6.5 : null,
    confidence: 0.9,
    resultKind,
    phases: [
      {
        key: "prep",
        startMs: 0,
        representativeMs: 100,
        endMs: 400,
        confidence: 0.9,
      },
    ],
    checkpoints: [
      {
        key: "contact_point",
        score: resultKind === "scored" ? 6.5 : null,
        confidence: 0.9,
        band: resultKind === "scored" ? "green" : "unscored",
        direction: "none",
        severity: 0,
        applicable: true,
      },
    ],
    versionVector: VERSION_VECTOR,
  };
}

const ONBOARDING = {
  skillLevel: "intermediate",
  handedness: "right",
  goal: "consistency",
  biggestProblem: "contact timing",
};

interface Variant {
  name: string;
  method: string;
  path: (a: SeededUser, v: SeededUser, rng: () => number) => string;
  body?: (a: SeededUser, v: SeededUser, rng: () => number) => unknown;
  /** Statuses the contract allows for a FOREIGN-id attempt. */
  expectForeign: number[];
  /** Route-family rate limit scope so the fuzz can budget it. */
  scope: string;
}

const uuid = (rng: () => number) => {
  const hex = () => Math.floor(rng() * 16).toString(16);
  const seg = (n: number) => Array.from({ length: n }, hex).join("");
  return `${seg(8)}-${seg(4)}-4${seg(3)}-8${seg(3)}-${seg(12)}`;
};

/** Attacker `a` targets victim `v`. Every variant carries a victim-owned id
 * or victim-shaped payload. */
const VARIANTS: Variant[] = [
  {
    name: "GET /v1/me",
    method: "GET",
    path: () => "/v1/me",
    expectForeign: [200],
    scope: "user",
  },
  {
    name: "PUT /v1/me/onboarding (foreign id fields)",
    method: "PUT",
    path: () => "/v1/me/onboarding",
    body: (_a, v) => ({
      ...ONBOARDING,
      id: v.user.id,
      userId: v.user.id,
      user_id: v.user.id,
      firstName: "Mallory",
    }),
    expectForeign: [200],
    scope: "user",
  },
  {
    name: "GET /v1/me/access",
    method: "GET",
    path: () => "/v1/me/access",
    expectForeign: [200],
    scope: "user",
  },
  {
    name: "POST /v1/billing/sync (foreign appUserId)",
    method: "POST",
    path: () => "/v1/billing/sync",
    body: (_a, v) => ({ appUserId: v.user.id, userId: v.user.id }),
    expectForeign: [200],
    scope: "billing_sync",
  },
  {
    name: "POST /v1/analysis-permits (victim idempotency key)",
    method: "POST",
    path: () => "/v1/analysis-permits",
    body: (_a, v) => ({
      idempotencyKey: v.ids.idempotencyKey,
      userId: v.user.id,
    }),
    expectForeign: [200, 402],
    scope: "permits",
  },
  {
    name: "POST /v1/analysis-permits/:victimPermit/finalize",
    method: "POST",
    path: (_a, v) => `/v1/analysis-permits/${v.ids.reservedPermit}/finalize`,
    body: () => ({ outcome: "cancelled", ratingId: null }),
    expectForeign: [404],
    scope: "permits",
  },
  {
    name: "POST /v1/analysis-permits/:victimFinalizedPermit/finalize",
    method: "POST",
    path: (_a, v) => `/v1/analysis-permits/${v.ids.finalizedPermit}/finalize`,
    body: () => ({ outcome: "failed", ratingId: null }),
    expectForeign: [404],
    scope: "permits",
  },
  {
    name: "POST /v1/shots:sync (victim permit + victim session)",
    method: "POST",
    path: () => "/v1/shots:sync",
    body: (_a, v, rng) => ({
      shots: [syncShot(uuid(rng), v.ids.reservedPermit, v.ids.session)],
    }),
    expectForeign: [200],
    scope: "shots_sync",
  },
  {
    name: "POST /v1/shots:sync (victim shot id replay)",
    method: "POST",
    path: () => "/v1/shots:sync",
    body: (a, v) => ({
      shots: [syncShot(v.ids.scoredShot, a.ids.reservedPermit, null)],
    }),
    expectForeign: [200],
    scope: "shots_sync",
  },
  {
    name: "POST /v1/shots:sync (own permit, victim session)",
    method: "POST",
    path: () => "/v1/shots:sync",
    body: (a, v, rng) => ({
      shots: [syncShot(uuid(rng), a.ids.reservedPermit, v.ids.session)],
    }),
    expectForeign: [200],
    scope: "shots_sync",
  },
  {
    name: "POST /v1/sessions (victim session id)",
    method: "POST",
    path: () => "/v1/sessions",
    body: (_a, v) => ({
      id: v.ids.session,
      startedAt: "2026-09-01T09:00:00.000Z",
      userId: v.user.id,
    }),
    expectForeign: [409],
    scope: "user",
  },
  {
    name: "POST /v1/sessions/:victimSession/finalize",
    method: "POST",
    path: (_a, v) => `/v1/sessions/${v.ids.session}/finalize`,
    body: (_a, v) => ({ id: v.ids.session }),
    expectForeign: [404],
    scope: "user",
  },
  {
    name: "POST /v1/me/evaluation/trials (victim trial id)",
    method: "POST",
    path: () => "/v1/me/evaluation/trials",
    body: (_a, v) => ({
      trials: [{ trialId: v.ids.trial, userId: v.user.id, subject: v.user.id }],
    }),
    expectForeign: [200, 403],
    scope: "trials",
  },
  {
    name: "GET /v1/progress",
    method: "GET",
    path: () => "/v1/progress",
    expectForeign: [200],
    scope: "user",
  },
  {
    name: "GET /v1/rank",
    method: "GET",
    path: () => "/v1/rank",
    expectForeign: [200],
    scope: "user",
  },
  {
    name: "GET /v1/me/consent/status",
    method: "GET",
    path: () => "/v1/me/consent/status",
    expectForeign: [200],
    scope: "consent",
  },
  {
    name: "POST /v1/me/consent/grant (foreign user fields)",
    method: "POST",
    path: () => "/v1/me/consent/grant",
    body: (_a, v) => ({
      scope: "model_training",
      consentVersion: "v9",
      userId: v.user.id,
      user_id: v.user.id,
    }),
    expectForeign: [200],
    scope: "consent",
  },
  {
    name: "POST /v1/me/consent/withdraw (foreign user fields)",
    method: "POST",
    path: () => "/v1/me/consent/withdraw",
    body: (_a, v) => ({
      scope: "video_analysis",
      userId: v.user.id,
      user_id: v.user.id,
    }),
    expectForeign: [200],
    scope: "consent",
  },
  {
    name: "POST /v1/analyses/:victimShot/feedback",
    method: "POST",
    path: (_a, v) => `/v1/analyses/${v.ids.scoredShot}/feedback`,
    body: () => ({ rating: "not_quite", category: "wrong_player" }),
    expectForeign: [404],
    scope: "user",
  },
  {
    name: "GET /v1/me/saved-drills",
    method: "GET",
    path: () => "/v1/me/saved-drills",
    expectForeign: [200],
    scope: "user",
  },
  {
    name: "PUT /v1/me/saved-drills/:victimSlug",
    method: "PUT",
    path: (_a, v) => `/v1/me/saved-drills/${v.ids.savedDrill}`,
    body: (_a, v) => ({
      slug: v.ids.savedDrill,
      saved: true,
      userId: v.user.id,
    }),
    expectForeign: [200],
    scope: "user",
  },
  {
    name: "DELETE /v1/me/saved-drills/:victimSlug",
    method: "DELETE",
    path: (_a, v) => `/v1/me/saved-drills/${v.ids.savedDrill}`,
    expectForeign: [204],
    scope: "user",
  },
  {
    name: "POST /v1/me/delete-request (foreign user fields)",
    method: "POST",
    path: () => "/v1/me/delete-request",
    body: (_a, v) => ({ userId: v.user.id, user_id: v.user.id }),
    expectForeign: [200],
    scope: "delete_request",
  },
  {
    name: "POST /v1/me/delete-confirm (victim challenge)",
    method: "POST",
    path: () => "/v1/me/delete-confirm",
    body: (_a, v) => ({ challenge: v.ids.challenge, userId: v.user.id }),
    expectForeign: [403],
    scope: "delete_confirm",
  },
  {
    name: "GET /v1/training-plans/current",
    method: "GET",
    path: () => "/v1/training-plans/current",
    expectForeign: [200, 404],
    scope: "user",
  },
  {
    name: "POST /v1/training-plans (foreign user fields)",
    method: "POST",
    path: () => "/v1/training-plans",
    body: (_a, v) => ({
      userId: v.user.id,
      user_id: v.user.id,
      focusCheckpoint: "contact_point",
    }),
    expectForeign: [200, 400, 404, 409],
    scope: "user",
  },
  {
    name: "GET /v1/catalog/drills/:victimSlug",
    method: "GET",
    path: (_a, v) => `/v1/catalog/drills/${v.ids.savedDrill}`,
    expectForeign: [200, 404],
    scope: "user",
  },
  {
    name: "POST /v1/auth/logout (own bearer; victim untouched)",
    method: "POST",
    path: () => "/v1/auth/logout",
    body: (_a, v) => ({ userId: v.user.id }),
    expectForeign: [204],
    scope: "user",
  },
];

// Variants that would revoke or consume the attacker's OWN session and must
// stay out of the fuzz loop (they are exercised deterministically in B).
const FUZZ_EXCLUDED = new Set(["POST /v1/auth/logout (own bearer; victim untouched)"]);

// ── Section A: deterministic route matrix ────────────────────────────────────

Deno.test("xc2/A route matrix: user B with user A's ids on every authenticated route", async () => {
  const edge = await loadEdge();
  sentByAttacker.clear();
  const fake = edge.fake;
  const alice = seedUser(fake, 1, "google", true);
  const bob = seedUser(fake, 2, "apple", false);
  const bobSession = fake.mintSession(bob.user.id);
  const aliceSession = fake.mintSession(alice.user.id);
  const rng = mulberry32(0xa11ce);

  // Alice is active first so the edge's caches hold HER verified session and
  // HER rank/progress payloads when Bob arrives.
  for (const path of ["/v1/me", "/v1/rank", "/v1/progress", "/v1/me/access"]) {
    const warm = await edge.handler(
      edgeRequest("GET", path, {
        token: aliceSession.accessToken,
        ip: alice.ip,
      }),
    );
    const warmText = await warm.text();
    assertEquals(warm.status, 200, `alice warm ${path}: ${warmText}`);
  }

  const matrix: Array<Record<string, unknown>> = [];
  const failures: string[] = [];
  for (const variant of VARIANTS) {
    // Bob bears his Supabase session on odd variants and his Apple ID token
    // (transitional branch) on even ones, so both authenticate() paths meet
    // the same foreign-id attempts.
    const useProviderToken =
      matrix.length % 2 === 0 && variant.method !== "POST" ? false : matrix.length % 3 === 0;
    const token = useProviderToken
      ? providerIdToken("apple", bob.user.providerSubject)
      : bobSession.accessToken;
    const outcome = await attack(
      edge,
      bob,
      token,
      alice,
      variant.method,
      variant.path(bob, alice, rng),
      variant.body?.(bob, alice, rng),
    );
    const statusOk = variant.expectForeign.includes(outcome.status);
    const row = {
      variant: variant.name,
      bearer: useProviderToken ? "apple-id-token" : "supabase-session",
      status: outcome.status,
      code: outcome.code,
      statusWithinContract: statusOk,
      leaked: outcome.leaked,
      victimMutated: outcome.victimMutated,
      foreignActorCalls: outcome.foreignActors.map((c) => `${c.method} ${c.url} as ${c.actor}`),
      calls: outcome.calls.map((c) => `${c.method} ${c.url} as ${c.actor} -> ${c.status}`),
      body: outcome.body.slice(0, 400),
    };
    matrix.push(row);
    if (!statusOk) {
      failures.push(
        `${variant.name}: status ${outcome.status} not in ${variant.expectForeign} body=${outcome.body.slice(
          0,
          200,
        )}`,
      );
    }
    if (outcome.leaked.length) {
      failures.push(`${variant.name}: LEAK ${outcome.leaked.join(",")}`);
    }
    if (outcome.victimMutated) failures.push(`${variant.name}: VICTIM MUTATED`);
    if (outcome.foreignActors.length) {
      failures.push(`${variant.name}: FOREIGN ACTOR ${row.foreignActorCalls.join(";")}`);
    }
  }

  // Contract-specific expectations on the interesting bodies.
  const byName = (name: string) => matrix.find((row) => row.variant === name)!;
  assertEquals(byName("POST /v1/sessions (victim session id)").code, "session.id_conflict");
  assertEquals(
    byName("POST /v1/analysis-permits/:victimPermit/finalize").code,
    "access.permit_not_found",
  );
  assertEquals(byName("POST /v1/sessions/:victimSession/finalize").code, "session.not_found");
  assertEquals(byName("POST /v1/analyses/:victimShot/feedback").code, "analysis.not_found");
  assertEquals(
    byName("POST /v1/me/delete-confirm (victim challenge)").code,
    "account.deletion_challenge_invalid",
  );

  // shots:sync with Alice's permit / session / shot id must be rejected PER
  // SHOT with the ownership code, never accepted.
  const rejectionCode = (name: string) => {
    const parsed = JSON.parse(String(byName(name).body)) as {
      acceptedIds: string[];
      rejected: Array<{ code: string }>;
    };
    assertEquals(parsed.acceptedIds, [], `${name} must accept nothing`);
    return parsed.rejected.map((r) => r.code);
  };
  assertEquals(rejectionCode("POST /v1/shots:sync (victim permit + victim session)"), [
    "access.permit_not_found",
  ]);
  assertEquals(rejectionCode("POST /v1/shots:sync (victim shot id replay)"), ["shot.id_conflict"]);
  assertEquals(rejectionCode("POST /v1/shots:sync (own permit, victim session)"), [
    "shot.session_not_found",
  ]);
  const trialsBody = JSON.parse(
    String(byName("POST /v1/me/evaluation/trials (victim trial id)").body),
  ) as {
    acceptedTrialIds: string[];
    rejected: Array<{ code: string }>;
  };
  assertEquals(trialsBody.acceptedTrialIds, []);
  assertEquals(
    trialsBody.rejected.map((r) => r.code),
    ["evaluation.trial_id_conflict"],
  );
  const syncCalls = fake.calls.filter((c) => c.url.startsWith("/rest/v1/rpc/apply_synced_shot"));
  assert(
    syncCalls.length >= 2,
    "apply_synced_shot must have been invoked for the foreign-permit attempts",
  );
  const aliceShotsAfter = fake.rows("shots").filter((s) => s.user_id === alice.user.id).length;
  assertEquals(aliceShotsAfter, 1, "Alice must still own exactly her one seeded shot");
  const alicePermit = fake.rows("analysis_permits").find((p) => p.id === alice.ids.reservedPermit)!;
  assertEquals(
    alicePermit.status,
    "reserved",
    "Alice's reserved permit must not be consumed by Bob",
  );
  const bobShotsBoundToAlicePermit = fake
    .rows("shots")
    .filter((s) => s.user_id === bob.user.id && s.analysis_permit_id === alice.ids.reservedPermit);
  assertEquals(bobShotsBoundToAlicePermit.length, 0);
  // Bob's own permit + Alice's session → the RPC refuses (shot.session_not_found).
  const bobShotsInAliceSession = fake
    .rows("shots")
    .filter((s) => s.user_id === bob.user.id && s.session_id === alice.ids.session);
  assertEquals(bobShotsInAliceSession.length, 0);
  // Bob's access must not inherit Alice's premium.
  const bobAccessResponse = await edge.handler(
    edgeRequest("GET", "/v1/me/access", {
      token: bobSession.accessToken,
      ip: bob.ip,
    }),
  );
  const bobAccess = JSON.parse(await bobAccessResponse.text());
  assertEquals(bobAccess.premium, false);
  const aliceAccessResponse = await edge.handler(
    edgeRequest("GET", "/v1/me/access", {
      token: aliceSession.accessToken,
      ip: alice.ip,
    }),
  );
  const aliceAccess = JSON.parse(await aliceAccessResponse.text());
  assertEquals(
    aliceAccess.premium,
    true,
    "alice's premium must survive bob's billing/permit attempts",
  );
  // Alice's evaluation trial row must still be hers and Bob must not have
  // acquired a trial under her id.
  const trial = fake.rows("evaluation_trials").find((t) => t.id === alice.ids.trial)!;
  assertEquals(trial.user_id, alice.user.id);
  assertEquals(
    fake
      .rows("evaluation_trials")
      .filter((t) => t.user_id === bob.user.id && t.id === alice.ids.trial).length,
    0,
  );

  const path = await writeArtifact("route_matrix.json", {
    generatedAt: new Date().toISOString(),
    attacker: { id: bob.user.id, provider: bob.user.provider },
    victim: { id: alice.user.id, provider: alice.user.provider, premium: true },
    variants: matrix.length,
    failures,
    rows: matrix,
  });
  if (path) console.log(`[xc2] route matrix → ${path}`);
  assertEquals(failures, [], failures.join("\n"));
});

// ── Detector self-check ──────────────────────────────────────────────────────

Deno.test(
  "xc2/0 detector control: a stolen bearer IS flagged (leak + foreign actor), so a quiet matrix means something",
  async () => {
    const edge = await loadEdge();
    sentByAttacker.clear();
    const fake = edge.fake;
    const alice = seedUser(fake, 7, "google", true);
    const bob = seedUser(fake, 8, "apple", false);
    const aliceSession = fake.mintSession(alice.user.id);
    // Bob presents ALICE's real bearer: this is not an isolation failure of the
    // edge (possession of the bearer is the credential) but it must light up
    // every detector the matrix relies on.
    const stolen = await attack(edge, bob, aliceSession.accessToken, alice, "GET", "/v1/me");
    assertEquals(stolen.status, 200);
    assert(stolen.leaked.length > 0, "leak detector must see alice's canaries");
    assert(stolen.foreignActors.length > 0, "actor detector must see PostgREST acting as alice");
    const mutate = await attack(
      edge,
      bob,
      aliceSession.accessToken,
      alice,
      "POST",
      "/v1/me/consent/grant",
      {
        scope: "model_training",
        consentVersion: "v9",
      },
    );
    assertEquals(mutate.status, 200, mutate.body);
    assert(mutate.victimMutated, "mutation detector must see alice's consent ledger grow");
  },
);

// ── Section B: edge-state isolation ──────────────────────────────────────────

Deno.test(
  "xc2/B edge state: auth cache, response cache, logout, rotation, forged/expired bearers, deletion",
  async () => {
    const edge = await loadEdge();
    sentByAttacker.clear();
    const fake = edge.fake;
    const alice = seedUser(fake, 3, "google", true);
    const bob = seedUser(fake, 4, "google", false);
    const aliceSession = fake.mintSession(alice.user.id);
    const bobSession = fake.mintSession(bob.user.id);
    const log: Array<Record<string, unknown>> = [];
    const step = async (
      label: string,
      user: SeededUser,
      token: string,
      method: string,
      path: string,
      body?: unknown,
    ) => {
      const before = fake.calls.length;
      const response = await edge.handler(edgeRequest(method, path, { token, ip: user.ip, body }));
      const text = await response.text();
      const calls = fake.calls.slice(before);
      log.push({
        label,
        status: response.status,
        body: text.slice(0, 300),
        calls: calls.map((c) => `${c.method} ${c.url} as ${c.actor} -> ${c.status}`),
      });
      return { status: response.status, text, calls };
    };

    // 1. Auth cache: Alice verified once; Bob's first request must hit Auth
    //    as Bob (never reuse Alice's cached session), and Bob's rank must be Bob's.
    const a1 = await step("alice rank (cold)", alice, aliceSession.accessToken, "GET", "/v1/rank");
    assertEquals(a1.status, 200);
    assert(a1.text.includes(alice.canary), "alice rank must show alice's tier canary");
    const a2 = await step(
      "alice rank (cached)",
      alice,
      aliceSession.accessToken,
      "GET",
      "/v1/rank",
    );
    assertEquals(
      a2.calls.filter((c) => c.table === "auth/user").length,
      0,
      "second alice request must be served from the auth cache",
    );
    assertEquals(
      a2.calls.filter((c) => c.table === "player_rank_state").length,
      0,
      "second alice rank must be served from the rank cache",
    );
    const b1 = await step("bob rank (cold)", bob, bobSession.accessToken, "GET", "/v1/rank");
    assertEquals(b1.status, 200);
    assert(
      !b1.text.includes(alice.canary) && !b1.text.includes(alice.prefix),
      "bob's rank must not carry alice's cached payload",
    );
    assert(b1.text.includes(bob.canary));
    assertEquals(
      b1.calls.filter((c) => c.table === "auth/user" && c.actor === bob.user.id).length,
      1,
      "bob must be verified as bob",
    );
    assertEquals(b1.calls.filter((c) => c.actor === alice.user.id).length, 0);

    // 2. Progress cache and coalescing keyed per user.
    const ap = await step("alice progress", alice, aliceSession.accessToken, "GET", "/v1/progress");
    const bp = await step("bob progress", bob, bobSession.accessToken, "GET", "/v1/progress");
    assertEquals(ap.status, 200);
    assertEquals(bp.status, 200);
    assert(ap.text.includes(alice.canary) || ap.text.includes("2026-08-30"));
    assert(!bp.text.includes(alice.canary) && !bp.text.includes(alice.prefix));

    // 3. Bob's accepted sync invalidates BOB's caches only; Alice's cached rank
    //    still serves without a DB read and is still Alice's.
    const bobSync = await step(
      "bob sync own shot",
      bob,
      bobSession.accessToken,
      "POST",
      "/v1/shots:sync",
      {
        shots: [syncShot(userId(bob.prefix, "d9"), bob.ids.reservedPermit, bob.ids.session)],
      },
    );
    assertEquals(bobSync.status, 200);
    assert(bobSync.text.includes('"acceptedIds":["' + userId(bob.prefix, "d9")), bobSync.text);
    const a3 = await step(
      "alice rank (still cached after bob's sync)",
      alice,
      aliceSession.accessToken,
      "GET",
      "/v1/rank",
    );
    assertEquals(
      a3.calls.filter((c) => c.table === "player_rank_state").length,
      0,
      "bob's sync must not evict alice's rank cache",
    );
    assert(a3.text.includes(alice.canary));
    const b2 = await step(
      "bob rank after sync (recomputed)",
      bob,
      bobSession.accessToken,
      "GET",
      "/v1/rank",
    );
    assertEquals(
      b2.calls.filter((c) => c.table === "player_rank_state" && c.actor === bob.user.id).length,
      1,
      "bob's rank must be recomputed as bob",
    );

    // 4. Forged bearer naming Alice's uid (never issued by Auth) → 401, and
    //    nothing reaches PostgREST as Alice.
    const forged = await step(
      "bob forges alice session jwt",
      bob,
      fake.forgedSessionToken(alice.user.id),
      "GET",
      "/v1/me",
    );
    assertEquals(forged.status, 401, forged.text);
    assertEquals(forged.calls.filter((c) => c.actor === alice.user.id).length, 0);
    assertEquals(
      forged.calls.filter((c) => c.table?.startsWith("rest/") || c.url.startsWith("/rest/")).length,
      0,
      "a forged bearer must never reach PostgREST",
    );

    // 5. Expired bearer (Alice's real sid, exp in the past) → 401 before Auth.
    const expiredToken = (() => {
      const minted = fake.mintSession(alice.user.id, -60);
      return minted.accessToken;
    })();
    const expired = await step("expired alice bearer", alice, expiredToken, "GET", "/v1/me");
    assertEquals(expired.status, 401);
    assertEquals(
      expired.calls.length,
      0,
      "an expired bearer must be refused without any outbound call",
    );

    // 6. Bob logs out: Bob's bearer dies at the edge; Alice's cached bearer lives.
    const logout = await step("bob logout", bob, bobSession.accessToken, "POST", "/v1/auth/logout");
    assertEquals(logout.status, 204);
    const bobAfterLogout = await step(
      "bob after logout",
      bob,
      bobSession.accessToken,
      "GET",
      "/v1/me",
    );
    assertEquals(bobAfterLogout.status, 401, "logged-out bearer must be refused");
    const aliceAfterBobLogout = await step(
      "alice after bob logout",
      alice,
      aliceSession.accessToken,
      "GET",
      "/v1/me",
    );
    assertEquals(aliceAfterBobLogout.status, 200);
    assert(aliceAfterBobLogout.text.includes(alice.canary));

    // 7. Refresh rotation: Bob's refresh token → new session for BOB only; a
    //    replayed (rotated-away) refresh token is refused; Alice's refresh
    //    token in Bob's hands still yields Alice's session — which is the
    //    documented bearer model (possession of a refresh token IS the
    //    credential), so the harness records it and asserts the rotation.
    const bob2 = fake.mintSession(bob.user.id);
    const refreshed = await step("bob refresh", bob, "", "POST", "/v1/auth/refresh", {
      refreshToken: bob2.refreshToken,
    });
    assertEquals(refreshed.status, 200, refreshed.text);
    const refreshedSession = JSON.parse(refreshed.text).session as {
      accessToken: string;
      refreshToken: string;
    };
    const meAfterRefresh = await step(
      "bob /me with refreshed bearer",
      bob,
      refreshedSession.accessToken,
      "GET",
      "/v1/me",
    );
    assertEquals(meAfterRefresh.status, 200);
    assert(meAfterRefresh.text.includes(bob.canary) && !meAfterRefresh.text.includes(alice.canary));
    const replay = await step(
      "bob replays rotated refresh token",
      bob,
      "",
      "POST",
      "/v1/auth/refresh",
      { refreshToken: bob2.refreshToken },
    );
    assertEquals(replay.status, 401);

    // 8. Bob deletes HIS account (own challenge, min-age satisfied by the seed).
    //    Alice's rows, cache and bearer are untouched; Bob's rows are gone and
    //    Bob's bearer is dead.
    const aliceBefore = ownedSnapshot(fake, alice);
    const bobDelete = await step(
      "bob delete-confirm own challenge",
      bob,
      refreshedSession.accessToken,
      "POST",
      "/v1/me/delete-confirm",
      { challenge: bob.ids.challenge },
    );
    assertEquals(bobDelete.status, 200, bobDelete.text);
    assertEquals(
      bobDelete.calls.filter(
        (c) => c.url.startsWith("/auth/v1/admin/users/") && c.url.endsWith(bob.user.id),
      ).length,
      1,
    );
    assertEquals(
      bobDelete.calls.filter((c) => c.url.includes(alice.user.id)).length,
      0,
      "deletion must never name alice",
    );
    assertEquals(
      ownedSnapshot(fake, alice),
      aliceBefore,
      "alice's rows must be unchanged by bob's deletion",
    );
    assertEquals(fake.rows("shots").filter((s) => s.user_id === bob.user.id).length, 0);
    assertEquals(
      fake
        .rows("free_rating_ledger")
        .filter((l) => l.identity_hash === `hash:google:${bob.user.providerSubject}`).length,
      1,
      "bob's ledger row must survive deletion (identity-lifetime free ratings)",
    );
    const bobAfterDelete = await step(
      "bob after delete",
      bob,
      refreshedSession.accessToken,
      "GET",
      "/v1/me",
    );
    assertEquals(bobAfterDelete.status, 401);
    const a4 = await step(
      "alice after bob delete",
      alice,
      aliceSession.accessToken,
      "GET",
      "/v1/rank",
    );
    assertEquals(a4.status, 200);
    assert(a4.text.includes(alice.canary));

    // 9. A brand-new sign-in with Bob's Google identity (same provider subject)
    //    inherits the ledger count, never Alice's.
    const rebornToken = providerIdToken("google", bob.user.providerSubject);
    const reborn = await step(
      "bob re-signs in after deletion",
      bob,
      rebornToken,
      "GET",
      "/v1/me/access",
    );
    assertEquals(reborn.status, 200, reborn.text);
    const rebornAccess = JSON.parse(reborn.text);
    assertEquals(rebornAccess.premium, false);
    assertEquals(
      rebornAccess.freeRatings.used,
      2,
      "identity ledger: 1 seeded + 1 synced scored shot survive deletion",
    );

    const path = await writeArtifact("edge_state_isolation.json", {
      generatedAt: new Date().toISOString(),
      steps: log,
    });
    if (path) console.log(`[xc2] edge state log → ${path}`);
  },
);

// ── Section C: seeded fuzz at scale ──────────────────────────────────────────

Deno.test(
  "xc2/C seeded fuzz: N attacker→victim requests over a user pool with replayable failures",
  async () => {
    const edge = await loadEdge();
    sentByAttacker.clear();
    const fake = edge.fake;
    const iterations = Number(Deno.env.get("XC2_FUZZ_ITERATIONS") ?? "3000");
    const seed = Number(Deno.env.get("XC2_FUZZ_SEED") ?? "20260904");
    const poolSize = Number(Deno.env.get("XC2_FUZZ_USERS") ?? "48");
    const replayOnly = Deno.env.get("XC2_FUZZ_REPLAY"); // comma-separated iteration numbers
    const replaySet = replayOnly ? new Set(replayOnly.split(",").map(Number)) : null;
    const rng = mulberry32(seed);

    const pool: SeededUser[] = [];
    const tokens = new Map<string, string[]>();
    for (let k = 0; k < poolSize; k += 1) {
      const provider = k % 2 === 0 ? "google" : "apple";
      const user = seedUser(fake, 100 + k, provider, k % 5 === 0);
      pool.push(user);
      const session = fake.mintSession(user.user.id);
      tokens.set(user.user.id, [
        session.accessToken,
        providerIdToken(provider, user.user.providerSubject),
      ]);
    }
    const variants = VARIANTS.filter((v) => !FUZZ_EXCLUDED.has(v.name));

    const heap: Array<ReturnType<typeof heapSnapshot>> = [heapSnapshot("start")];
    const statusMatrix: Record<string, Record<string, number>> = {};
    const failures: Array<Record<string, unknown>> = [];
    let executed = 0;
    let rateLimited = 0;
    let serverErrors = 0;
    const startedAt = Date.now();

    for (let i = 0; i < iterations; i += 1) {
      // Draw every random choice even when replaying so iteration i sees the
      // same PRNG state as in the original run.
      const attacker = pick(rng, pool);
      let victim = pick(rng, pool);
      if (victim === attacker) {
        victim = pool[(pool.indexOf(attacker) + 1) % pool.length];
      }
      const variant = pick(rng, variants);
      const bearerKind = rng() < 0.5 ? 0 : 1;
      const path = variant.path(attacker, victim, rng);
      const body = variant.body?.(attacker, victim, rng);
      // Random victim-id header noise: ids in headers must be ignored too.
      const headers =
        rng() < 0.3
          ? { "x-user-id": victim.user.id, "x-supabase-user": victim.user.id }
          : undefined;
      if (replaySet && !replaySet.has(i)) continue;

      const token = tokens.get(attacker.user.id)![bearerKind];
      const outcome = await attack(
        edge,
        attacker,
        token,
        victim,
        variant.method,
        path,
        body,
        headers,
      );
      executed += 1;
      const cell = (statusMatrix[variant.name] ??= {});
      const key = `${outcome.status}${outcome.code ? " " + outcome.code : ""}`;
      cell[key] = (cell[key] ?? 0) + 1;
      if (outcome.status === 429) rateLimited += 1;
      if (outcome.status >= 500) serverErrors += 1;

      const problems: string[] = [];
      if (outcome.leaked.length) {
        problems.push(`leak:${outcome.leaked.join(",")}`);
      }
      if (outcome.victimMutated) problems.push("victim-mutated");
      if (outcome.foreignActors.length) {
        problems.push(`foreign-actor:${outcome.foreignActors.map((c) => c.actor).join(",")}`);
      }
      if (outcome.status !== 429 && !variant.expectForeign.includes(outcome.status))
        problems.push(`status:${outcome.status}`);
      if (problems.length) {
        failures.push({
          iteration: i,
          seed,
          attacker: attacker.user.id,
          victim: victim.user.id,
          bearer: bearerKind === 0 ? "supabase-session" : `${attacker.user.provider}-id-token`,
          variant: variant.name,
          method: variant.method,
          path,
          body,
          headers,
          status: outcome.status,
          code: outcome.code,
          problems,
          responseBody: outcome.body.slice(0, 500),
          calls: outcome.calls.map((c) => `${c.method} ${c.url} as ${c.actor} -> ${c.status}`),
        });
      }
      if (i % 250 === 249) heap.push(heapSnapshot(`iter-${i + 1}`));
    }
    heap.push(heapSnapshot("end"));

    // Whole-pool integrity after the storm: every user still owns exactly the
    // rows they seeded plus whatever they themselves wrote — but nobody owns a
    // shot bound to another user's permit or session, and no permit changed
    // owner.
    const crossBoundShots = fake.rows("shots").filter((shot) => {
      const permit = fake.rows("analysis_permits").find((p) => p.id === shot.analysis_permit_id);
      const session = shot.session_id
        ? fake.rows("sessions").find((s) => s.id === shot.session_id)
        : null;
      return (
        (permit && permit.user_id !== shot.user_id) || (session && session.user_id !== shot.user_id)
      );
    });
    const summary = {
      generatedAt: new Date().toISOString(),
      seed,
      iterations,
      executed,
      poolSize,
      variants: variants.map((v) => v.name),
      durationMs: Date.now() - startedAt,
      rateLimited,
      serverErrors,
      failures: failures.length,
      crossBoundShots: crossBoundShots.length,
      statusMatrix,
      heap,
      fakeCalls: fake.calls.length,
      replay: {
        how: "XC2_FUZZ_SEED=<seed> XC2_FUZZ_ITERATIONS=<iterations> XC2_FUZZ_USERS=<poolSize> XC2_FUZZ_REPLAY=<iteration[,iteration]> deno test -A --no-check --config deno.json xc2_two_bearer_routes.test.ts --filter 'xc2/C'",
      },
    };
    const summaryPath = await writeArtifact("fuzz_summary.json", summary);
    const failuresPath = await writeArtifact("fuzz_failures.json", failures);
    const heapPath = await writeArtifact("fuzz_heap.json", heap);
    if (summaryPath) {
      console.log(
        `[xc2] fuzz summary → ${summaryPath}; failures → ${failuresPath}; heap → ${heapPath}`,
      );
    }
    console.log(
      `[xc2] fuzz executed=${executed} rateLimited=${rateLimited} serverErrors=${serverErrors} failures=${failures.length}`,
    );

    assertEquals(
      crossBoundShots.length,
      0,
      "no shot may be bound to another user's permit or session",
    );
    assertEquals(
      serverErrors,
      0,
      "5xx during fuzz means the route or the fake rejected something the contract allows",
    );
    assertEquals(failures.length, 0, JSON.stringify(failures.slice(0, 5), null, 2));
    assert(
      rateLimited < executed / 4,
      `rate limiting dominated the fuzz (${rateLimited}/${executed}); widen the pool`,
    );
  },
);

// ── Section D: concurrency on cached/coalesced routes ────────────────────────

Deno.test(
  "xc2/D concurrency: interleaved A/B requests on coalesced, cached routes stay per-user",
  async () => {
    const edge = await loadEdge();
    sentByAttacker.clear();
    const fake = edge.fake;
    const alice = seedUser(fake, 5, "google", true);
    const bob = seedUser(fake, 6, "apple", false);
    const aliceSession = fake.mintSession(alice.user.id);
    const bobSession = fake.mintSession(bob.user.id);
    const rounds = Number(Deno.env.get("XC2_CONCURRENCY_ROUNDS") ?? "40");
    const log: Array<Record<string, unknown>> = [];
    const problems: string[] = [];
    for (let round = 0; round < rounds; round += 1) {
      const path = ["/v1/rank", "/v1/progress", "/v1/me/access", "/v1/me"][round % 4];
      const batch = [
        { who: alice, token: aliceSession.accessToken },
        { who: bob, token: bobSession.accessToken },
        { who: alice, token: aliceSession.accessToken },
        { who: bob, token: bobSession.accessToken },
        { who: bob, token: providerIdToken("apple", bob.user.providerSubject) },
        {
          who: alice,
          token: providerIdToken("google", alice.user.providerSubject),
        },
      ];
      const responses = await Promise.all(
        batch.map(({ who, token }) =>
          edge
            .handler(edgeRequest("GET", path, { token, ip: who.ip }))
            .then(async (r) => ({ who, status: r.status, text: await r.text() })),
        ),
      );
      for (const r of responses) {
        const other = r.who === alice ? bob : alice;
        const leak = r.text.includes(other.canary) || r.text.includes(other.prefix);
        const premiumOk =
          path !== "/v1/me/access" || JSON.parse(r.text).premium === (r.who === alice);
        if (r.status !== 200 || leak || !premiumOk) {
          problems.push(
            `round ${round} ${path} ${r.who.user.id}: status=${r.status} leak=${leak} premiumOk=${premiumOk} body=${r.text.slice(
              0,
              160,
            )}`,
          );
        }
      }
      log.push({ round, path, statuses: responses.map((r) => r.status) });
      // Alternate cache invalidation from Bob so Alice's cached payloads meet
      // Bob's busts under concurrency.
      if (round % 8 === 7) {
        const sync = await edge.handler(
          edgeRequest("POST", "/v1/shots:sync", {
            token: bobSession.accessToken,
            ip: bob.ip,
            body: {
              shots: [
                syncShot(
                  userId(bob.prefix, String(900 + round)),
                  bob.ids.reservedPermit,
                  null,
                  "low_confidence",
                ),
              ],
            },
          }),
        );
        await sync.body?.cancel();
      }
    }
    const path = await writeArtifact("concurrency.json", {
      generatedAt: new Date().toISOString(),
      rounds,
      problems,
      log,
    });
    if (path) console.log(`[xc2] concurrency log → ${path}`);
    assertEquals(problems, [], problems.join("\n"));
  },
);
