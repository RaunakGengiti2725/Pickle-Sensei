// Route model for the edge fuzz campaign: every route of
// supabase/functions/api/index.ts with a valid baseline request, the
// contract oracle that decides whether a (mutated) body is still valid, the
// statuses each verdict may produce, and the upstream writes a VALID request
// is allowed to perform. Anything outside these envelopes is a failure.

import { sanitizeUserText } from "../../http.ts";
import type { Prng } from "./prng.ts";
import { deletionChallengeFor, hasConsent } from "./upstream.ts";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID_RE.test(value);
const isIsoDate = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const MAX_MS = 2_147_483_647;
const isMs = (v: unknown): v is number =>
  Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_MS;
const isUnit = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

export const DRILL_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,119}$/i;

/** The bot's contract for adversarial input. */
export const REJECT_STATUSES: readonly number[] = [400, 401, 404, 413, 429];

export type AuthKind = "none" | "webhook" | "provider" | "session";

/** What the oracle says about a concrete request body/path. */
export interface Verdict {
  /** "valid" → the server should process; "invalid" → must reject. */
  kind: "valid" | "invalid";
  /** Statuses acceptable for this verdict. */
  statuses: readonly number[];
  /** Upstream write targets allowed (only when kind === "valid"). */
  writeTargets: readonly string[];
  /** Human-readable why (goes into the record). */
  reason: string;
}

export interface FuzzUser {
  id: string;
  ip: string;
}

export interface RouteSpec {
  id: string;
  method: string;
  auth: AuthKind;
  /** Path for a valid request (ids are drawn from the PRNG). */
  path(rng: Prng, user: FuzzUser): string;
  /** Position of the fuzzable path parameter, if any. */
  pathParam?: { kind: "uuid" | "slug"; build(segment: string): string };
  /** Valid body; undefined for body-less routes. */
  body?(rng: Prng, user: FuzzUser): Record<string, unknown>;
  /** Top-level keys the oracle cares about (mutation targets). */
  requiredKeys: readonly string[];
  /** Optional keys the server may sanitize (hostile values must not 5xx). */
  optionalKeys: readonly string[];
  /** Query parameters the route reads. */
  queryKeys: readonly string[];
  /** Judge a body (already parsed the way the server would: non-object → {}). */
  oracle(body: Record<string, unknown>, user: FuzzUser, pathParam: string | null): Verdict;
}

const reject = (reason: string, extra: readonly number[] = []): Verdict => ({
  kind: "invalid",
  statuses: [...REJECT_STATUSES, ...extra],
  writeTargets: [],
  reason,
});
const accept = (
  statuses: readonly number[],
  writeTargets: readonly string[],
  reason: string,
): Verdict => ({
  kind: "valid",
  statuses: [...statuses, 429],
  writeTargets,
  reason,
});

// ─── Contract oracles (ports of the validators in index.ts) ─────────────────

const CAMERA_VIEWS = new Set(["side", "rear_oblique"]);
const CHECKPOINT_BANDS = new Set(["green", "yellow", "red", "unscored"]);
const VERSION_VECTOR_KEYS = [
  "appVersion",
  "modelBundleVersion",
  "poseModelVersion",
  "paddleModelVersion",
  "strokeDetectorVersion",
  "phaseModelVersion",
  "scoringModelVersion",
  "shotConfigVersion",
] as const;

/** Mirrors parseSyncShot (index.ts). Returns null when the entry is valid. */
export function shotRejection(value: unknown): string | null {
  if (!isRecord(value)) return "not an object";
  if (!isUuid(value.id)) return "id";
  if (value.source !== "real") return "source";
  if (!isUuid(value.analysisPermitId)) return "analysisPermitId";
  if (value.sessionId !== null && !isUuid(value.sessionId)) return "sessionId";
  if (typeof value.shotType !== "string" || !value.shotType.trim() || value.shotType.length > 64)
    return "shotType";
  if (typeof value.cameraView !== "string" || !CAMERA_VIEWS.has(value.cameraView))
    return "cameraView";
  if (!isIsoDate(value.capturedAt)) return "capturedAt";
  const ts = value.timestamps;
  if (
    !isRecord(ts) ||
    !isMs(ts.startMs) ||
    !isMs(ts.endMs) ||
    (ts.contactMs !== null && !isMs(ts.contactMs))
  ) {
    return "timestamps";
  }
  if (value.resultKind !== "scored" && value.resultKind !== "low_confidence") return "resultKind";
  const overallScore = value.overallScore;
  if (value.resultKind === "scored") {
    if (
      typeof overallScore !== "number" ||
      !Number.isFinite(overallScore) ||
      overallScore < 0 ||
      overallScore > 10
    ) {
      return "overallScore";
    }
  } else if (overallScore !== null) {
    return "overallScore";
  }
  if (!isUnit(value.confidence)) return "confidence";
  if (!Array.isArray(value.phases) || value.phases.length > 32) return "phases";
  const phaseKeys = new Set<string>();
  for (const p of value.phases) {
    if (
      !isRecord(p) ||
      typeof p.key !== "string" ||
      !p.key.trim() ||
      p.key.length > 64 ||
      !isMs(p.startMs) ||
      !isMs(p.representativeMs) ||
      !isMs(p.endMs) ||
      !isUnit(p.confidence)
    ) {
      return "phase";
    }
    if (phaseKeys.has(p.key)) return "phase.dup";
    phaseKeys.add(p.key);
  }
  if (!Array.isArray(value.checkpoints) || value.checkpoints.length > 64) return "checkpoints";
  const checkpointKeys = new Set<string>();
  for (const c of value.checkpoints) {
    if (
      !isRecord(c) ||
      typeof c.key !== "string" ||
      !c.key.trim() ||
      c.key.length > 64 ||
      !(
        c.score === null ||
        (typeof c.score === "number" && Number.isFinite(c.score) && c.score >= 0 && c.score <= 100)
      ) ||
      !isUnit(c.confidence) ||
      typeof c.band !== "string" ||
      !CHECKPOINT_BANDS.has(c.band) ||
      typeof c.direction !== "string" ||
      c.direction.length > 64 ||
      !isUnit(c.severity) ||
      typeof c.applicable !== "boolean"
    ) {
      return "checkpoint";
    }
    if (checkpointKeys.has(c.key)) return "checkpoint.dup";
    checkpointKeys.add(c.key);
  }
  const vv = value.versionVector;
  if (!isRecord(vv)) return "versionVector";
  for (const key of VERSION_VECTOR_KEYS) {
    const v = vv[key];
    if (typeof v !== "string" || !v.trim() || v.length > 64) return `versionVector.${key}`;
  }
  return null;
}

export function trialRejection(value: unknown): string | null {
  const trialId = isRecord(value) ? value.trialId : undefined;
  if (!isUuid(trialId)) return "trialId";
  if (JSON.stringify(value).length > 250_000) return "size";
  return null;
}

const CONSENT_SCOPES = new Set(["video_analysis", "model_training", "evaluation_telemetry"]);
const RELEASABLE_OUTCOMES = new Set([
  "low_confidence",
  "cancelled",
  "failed",
  "unsupported",
  "incorrect_recognition",
]);
const FEEDBACK_RATINGS = new Set(["accurate", "not_quite"]);
const FEEDBACK_CATEGORIES = new Set([
  "wrong_stroke",
  "wrong_player",
  "contact_looks_wrong",
  "feedback_mismatch",
  "other",
]);
const GENDER_OPTIONS = new Set(["female", "male", "nonbinary", "prefer_not_to_say"]);

// ─── Baseline builders ───────────────────────────────────────────────────────

export function validShot(
  rng: Prng,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const start = rng.int(0, 1_000_000);
  const scored = rng.bool(0.7);
  return {
    id: rng.uuid(),
    source: "real",
    analysisPermitId: rng.uuid(),
    sessionId: rng.bool() ? rng.uuid() : null,
    shotType: rng.pick(["dink", "drive", "third_shot_drop", "serve", "volley"]),
    cameraView: rng.pick(["side", "rear_oblique"]),
    capturedAt: "2026-09-01T10:00:00.000Z",
    timestamps: { startMs: start, contactMs: start + 400, endMs: start + 900 },
    resultKind: scored ? "scored" : "low_confidence",
    overallScore: scored ? Math.round(rng.float() * 100) / 10 : null,
    confidence: 0.91,
    phases: [
      {
        key: "backswing",
        startMs: start,
        representativeMs: start + 100,
        endMs: start + 300,
        confidence: 0.8,
      },
      {
        key: "contact",
        startMs: start + 300,
        representativeMs: start + 400,
        endMs: start + 500,
        confidence: 0.9,
      },
    ],
    checkpoints: [
      {
        key: "contact_position",
        score: 72,
        confidence: 0.8,
        band: "green",
        direction: "hold",
        severity: 0.1,
        applicable: true,
      },
      {
        key: "paddle_face",
        score: null,
        confidence: 0.4,
        band: "unscored",
        direction: "",
        severity: 0,
        applicable: false,
      },
    ],
    versionVector: Object.fromEntries(VERSION_VECTOR_KEYS.map((key) => [key, "1.0.0"])),
    ...overrides,
  };
}

export function validTrial(rng: Prng): Record<string, unknown> {
  return {
    trialId: rng.uuid(),
    kind: "capture",
    startedAt: "2026-09-01T10:00:00.000Z",
    durationMs: rng.int(500, 30_000),
    detector: { name: "stroke", version: "1.0.0" },
    outcome: rng.pick(["scored", "low_confidence", "cancelled"]),
  };
}

const V1 = "/functions/v1/api/v1";
const PUBLIC = "/functions/v1/api";

// ─── Route table ─────────────────────────────────────────────────────────────

const noBody: RouteSpec["oracle"] = () => accept([200, 204], [], "no body contract");

export const ROUTES: readonly RouteSpec[] = [
  // Public reads
  ...(["healthz", "support", "privacy", "terms"] as const).flatMap((page) =>
    (["GET", "HEAD"] as const).map<RouteSpec>((method) => ({
      id: `${method} /${page}`,
      method,
      auth: "none",
      path: () => `${PUBLIC}/${page}`,
      requiredKeys: [],
      optionalKeys: [],
      queryKeys: [],
      oracle: () => accept([200], [], "public page"),
    })),
  ),
  {
    id: "POST /webhooks/revenuecat",
    method: "POST",
    auth: "webhook",
    path: () => `${PUBLIC}/webhooks/revenuecat`,
    body: (rng, user) => ({
      event: {
        id: `evt_${rng.hex(16)}`,
        type: rng.pick(["INITIAL_PURCHASE", "RENEWAL", "CANCELLATION", "EXPIRATION", "TRANSFER"]),
        app_user_id: user.id,
        aliases: [user.id],
      },
      api_version: "1.0",
    }),
    requiredKeys: ["event"],
    optionalKeys: ["api_version"],
    queryKeys: [],
    oracle: (body) =>
      isRecord(body.event)
        ? accept(
            [200],
            ["table:webhook_events", "table:billing_entitlements"],
            "event object present",
          )
        : reject("event must be an object"),
  },
  // Session establishment
  {
    id: "POST /v1/account/bootstrap",
    method: "POST",
    auth: "provider",
    path: () => `${V1}/account/bootstrap`,
    body: () => ({}),
    requiredKeys: [],
    optionalKeys: ["appleAuthorizationCode"],
    queryKeys: [],
    // 400/401 arise only from an Apple authorization code the provider
    // rejects or attributes to another subject (the ID token itself is valid).
    oracle: (body) =>
      accept(
        body.appleAuthorizationCode === undefined ? [200] : [200, 400, 401],
        ["table:profiles", "table:account_external_credentials"],
        "provider token exchange",
      ),
  },
  {
    id: "POST /v1/auth/refresh",
    method: "POST",
    auth: "none",
    path: () => `${V1}/auth/refresh`,
    body: (rng) => ({ refreshToken: `refresh-${rng.hex(8)}` }),
    requiredKeys: ["refreshToken"],
    optionalKeys: [],
    queryKeys: [],
    oracle: (body) =>
      typeof body.refreshToken === "string" && body.refreshToken.trim()
        ? accept([200, 401], [], "string refresh token (auth service decides)")
        : reject("refreshToken must be a non-empty string"),
  },
  {
    id: "POST /v1/auth/logout",
    method: "POST",
    auth: "session",
    path: () => `${V1}/auth/logout`,
    requiredKeys: [],
    optionalKeys: [],
    queryKeys: [],
    oracle: () => accept([204], [], "logout"),
  },
  // Account
  {
    id: "GET /v1/me",
    method: "GET",
    auth: "session",
    path: () => `${V1}/me`,
    requiredKeys: [],
    optionalKeys: [],
    queryKeys: [],
    oracle: noBody,
  },
  {
    id: "PUT /v1/me/onboarding",
    method: "PUT",
    auth: "session",
    path: () => `${V1}/me/onboarding`,
    body: (rng) => ({
      skillLevel: rng.pick(["beginner", "intermediate", "advanced"]),
      handedness: rng.pick(["right", "left"]),
      goal: rng.pick(["consistency", "power", "placement"]),
      biggestProblem: "popping up dinks",
      firstName: rng.bool() ? "Fuzz" : undefined,
      gender: rng.bool() ? "prefer_not_to_say" : undefined,
    }),
    requiredKeys: ["skillLevel", "handedness", "goal", "biggestProblem"],
    optionalKeys: ["firstName", "gender"],
    queryKeys: [],
    oracle: (body) => {
      const skill =
        typeof body.skillLevel === "string" ? sanitizeUserText(body.skillLevel, 200) : "";
      const goal = typeof body.goal === "string" ? sanitizeUserText(body.goal, 200) : "";
      const problem =
        typeof body.biggestProblem === "string" ? sanitizeUserText(body.biggestProblem, 1_000) : "";
      if (
        !skill ||
        skill.length > 64 ||
        (body.handedness !== "right" && body.handedness !== "left") ||
        !goal ||
        goal.length > 64 ||
        !problem ||
        problem.length > 256
      ) {
        return reject("onboarding core fields");
      }
      if (body.firstName !== undefined && body.firstName !== null) {
        if (typeof body.firstName !== "string") return reject("firstName type");
        const cleaned = sanitizeUserText(body.firstName, 200);
        if (cleaned.length < 1 || cleaned.length > 40) return reject("firstName length");
      }
      if (body.gender !== undefined && body.gender !== null) {
        if (typeof body.gender !== "string" || !GENDER_OPTIONS.has(body.gender))
          return reject("gender");
      }
      return accept([200], ["table:profiles"], "onboarding valid");
    },
  },
  {
    id: "GET /v1/me/access",
    method: "GET",
    auth: "session",
    path: () => `${V1}/me/access`,
    requiredKeys: [],
    optionalKeys: [],
    queryKeys: [],
    oracle: noBody,
  },
  {
    id: "POST /v1/billing/sync",
    method: "POST",
    auth: "session",
    path: () => `${V1}/billing/sync`,
    body: () => ({}),
    requiredKeys: [],
    optionalKeys: ["receipt", "platform"],
    queryKeys: [],
    oracle: () => accept([200], ["table:billing_entitlements"], "body ignored; RC re-verified"),
  },
  // Analysis
  {
    id: "POST /v1/analysis-permits",
    method: "POST",
    auth: "session",
    path: () => `${V1}/analysis-permits`,
    body: (rng) => ({ idempotencyKey: `permit-${rng.hex(12)}` }),
    requiredKeys: ["idempotencyKey"],
    optionalKeys: [],
    queryKeys: [],
    oracle: (body) => {
      const key = body.idempotencyKey;
      return typeof key === "string" && key.trim() && key.length <= 128
        ? accept([200, 402], ["rpc:reserve_analysis_permit"], "idempotencyKey ok")
        : reject("idempotencyKey");
    },
  },
  {
    id: "POST /v1/analysis-permits/:id/finalize",
    method: "POST",
    auth: "session",
    path: (rng) => `${V1}/analysis-permits/${rng.uuid()}/finalize`,
    pathParam: { kind: "uuid", build: (segment) => `${V1}/analysis-permits/${segment}/finalize` },
    body: (rng) => ({ outcome: rng.pick([...RELEASABLE_OUTCOMES]), ratingId: null }),
    requiredKeys: ["outcome", "ratingId"],
    optionalKeys: [],
    queryKeys: [],
    oracle: (body, _user, pathParam) => {
      if (pathParam !== null && !isUuid(pathParam)) return reject("permit id not uuid");
      if (typeof body.outcome !== "string" || !RELEASABLE_OUTCOMES.has(body.outcome))
        return reject("outcome");
      if (body.ratingId !== null && body.ratingId !== undefined)
        return reject("ratingId must be null");
      return accept([200, 404, 409], ["table:analysis_permits"], "finalize valid");
    },
  },
  {
    id: "POST /v1/shots:sync",
    method: "POST",
    auth: "session",
    path: () => `${V1}/shots:sync`,
    body: (rng) => ({ shots: [validShot(rng)] }),
    requiredKeys: ["shots"],
    optionalKeys: [],
    queryKeys: [],
    oracle: (body) => {
      const shots = body.shots;
      if (!Array.isArray(shots) || shots.length < 1 || shots.length > 200)
        return reject("shots envelope");
      const anyValid = shots.some((shot) => shotRejection(shot) === null);
      return anyValid
        ? accept([200], ["rpc:apply_synced_shot"], "≥1 valid shot")
        : {
            kind: "invalid",
            statuses: [200, ...REJECT_STATUSES],
            writeTargets: [],
            reason: "every shot rejected per-entry",
          };
    },
  },
  {
    id: "POST /v1/sessions",
    method: "POST",
    auth: "session",
    path: () => `${V1}/sessions`,
    body: (rng) => ({ id: rng.uuid(), startedAt: "2026-09-01T10:00:00.000Z" }),
    requiredKeys: ["id", "startedAt"],
    optionalKeys: ["endedAt", "court", "notes"],
    queryKeys: [],
    oracle: (body) =>
      isUuid(body.id) && isIsoDate(body.startedAt)
        ? accept([200, 409], ["table:sessions"], "session valid")
        : reject("session id/startedAt"),
  },
  {
    id: "POST /v1/sessions/:id/finalize",
    method: "POST",
    auth: "session",
    path: (rng) => `${V1}/sessions/${rng.uuid()}/finalize`,
    pathParam: { kind: "uuid", build: (segment) => `${V1}/sessions/${segment}/finalize` },
    requiredKeys: [],
    optionalKeys: ["endedAt"],
    queryKeys: [],
    oracle: (_body, _user, pathParam) =>
      pathParam !== null && !isUuid(pathParam)
        ? reject("session id not uuid")
        : accept([200, 404], ["table:sessions"], "finalize"),
  },
  {
    id: "POST /v1/analyses/:id/feedback",
    method: "POST",
    auth: "session",
    path: (rng) => `${V1}/analyses/${rng.uuid()}/feedback`,
    pathParam: { kind: "uuid", build: (segment) => `${V1}/analyses/${segment}/feedback` },
    body: (rng) =>
      rng.bool()
        ? { rating: "accurate" }
        : { rating: "not_quite", category: rng.pick([...FEEDBACK_CATEGORIES]) },
    requiredKeys: ["rating", "category"],
    optionalKeys: ["comment"],
    queryKeys: [],
    oracle: (body, _user, pathParam) => {
      if (pathParam !== null && !isUuid(pathParam)) return reject("analysis id not uuid");
      const rating = body.rating;
      const category = body.category ?? null;
      if (typeof rating !== "string" || !FEEDBACK_RATINGS.has(rating)) return reject("rating");
      if (
        (rating === "not_quite") !==
        (typeof category === "string" && FEEDBACK_CATEGORIES.has(category))
      ) {
        return reject("category/rating pairing");
      }
      return accept([201, 404, 409], ["table:analysis_feedback"], "feedback valid");
    },
  },
  {
    id: "POST /v1/me/evaluation/trials",
    method: "POST",
    auth: "session",
    path: () => `${V1}/me/evaluation/trials`,
    body: (rng) => ({ trials: [validTrial(rng)] }),
    requiredKeys: ["trials"],
    optionalKeys: [],
    queryKeys: [],
    oracle: (body, user) => {
      const trials = body.trials;
      if (!Array.isArray(trials) || trials.length < 1 || trials.length > 200)
        return reject("trials envelope");
      if (!hasConsent(user.id))
        return {
          kind: "invalid",
          statuses: [403, ...REJECT_STATUSES],
          writeTargets: [],
          reason: "consent inactive",
        };
      const anyValid = trials.some((trial) => trialRejection(trial) === null);
      return anyValid
        ? accept([200], ["table:evaluation_trials"], "≥1 valid trial")
        : {
            kind: "invalid",
            statuses: [200, ...REJECT_STATUSES],
            writeTargets: [],
            reason: "every trial rejected per-entry",
          };
    },
  },
  // Reads
  ...(
    ["progress", "rank", "me/consent/status", "me/saved-drills", "training-plans/current"] as const
  ).map<RouteSpec>((suffix) => ({
    id: `GET /v1/${suffix}`,
    method: "GET",
    auth: "session",
    path: () => `${V1}/${suffix}`,
    requiredKeys: [],
    optionalKeys: [],
    queryKeys: [],
    oracle: noBody,
  })),
  {
    id: "GET /v1/catalog/drills",
    method: "GET",
    auth: "session",
    path: () => `${V1}/catalog/drills`,
    requiredKeys: [],
    optionalKeys: [],
    queryKeys: ["q", "family", "limit", "offset", "cursor"],
    oracle: noBody,
  },
  {
    id: "GET /v1/catalog/drills/:slug",
    method: "GET",
    auth: "session",
    path: () => `${V1}/catalog/drills/dink-consistency`,
    pathParam: { kind: "slug", build: (segment) => `${V1}/catalog/drills/${segment}` },
    requiredKeys: [],
    optionalKeys: [],
    queryKeys: [],
    oracle: (_body, _user, pathParam) =>
      pathParam !== null && !DRILL_SLUG_RE.test(pathParam)
        ? reject("slug")
        : accept([200, 404], [], "catalog detail"),
  },
  {
    id: "PUT /v1/me/saved-drills/:slug",
    method: "PUT",
    auth: "session",
    path: () => `${V1}/me/saved-drills/dink-consistency`,
    pathParam: { kind: "slug", build: (segment) => `${V1}/me/saved-drills/${segment}` },
    requiredKeys: [],
    optionalKeys: [],
    queryKeys: [],
    oracle: (_body, _user, pathParam) =>
      pathParam !== null && !DRILL_SLUG_RE.test(pathParam)
        ? reject("slug")
        : accept([200, 201, 204, 404], ["table:user_saved_drills"], "save drill"),
  },
  {
    id: "DELETE /v1/me/saved-drills/:slug",
    method: "DELETE",
    auth: "session",
    path: () => `${V1}/me/saved-drills/dink-consistency`,
    pathParam: { kind: "slug", build: (segment) => `${V1}/me/saved-drills/${segment}` },
    requiredKeys: [],
    optionalKeys: [],
    queryKeys: [],
    oracle: (_body, _user, pathParam) =>
      pathParam !== null && !DRILL_SLUG_RE.test(pathParam)
        ? reject("slug")
        : accept([200, 204, 404], ["table:user_saved_drills"], "unsave drill"),
  },
  {
    id: "POST /v1/training-plans",
    method: "POST",
    auth: "session",
    path: () => `${V1}/training-plans`,
    body: () => ({ focus: "dink" }),
    requiredKeys: [],
    optionalKeys: ["focus", "days"],
    queryKeys: [],
    oracle: () => accept([409], [], "plans unavailable by design"),
  },
  // Consent
  {
    id: "POST /v1/me/consent/grant",
    method: "POST",
    auth: "session",
    path: () => `${V1}/me/consent/grant`,
    body: (rng) => ({
      scope: rng.pick([...CONSENT_SCOPES]),
      consentVersion: "2026-08-01",
      source: "settings",
      device: "iPhone",
      captureMode: "camera",
    }),
    requiredKeys: ["scope", "consentVersion"],
    optionalKeys: ["source", "device", "captureMode"],
    queryKeys: [],
    oracle: (body) => {
      if (typeof body.scope !== "string" || !CONSENT_SCOPES.has(body.scope)) return reject("scope");
      if (typeof body.consentVersion !== "string" || !body.consentVersion.trim())
        return reject("consentVersion");
      return accept([200], ["table:consent_records"], "grant valid");
    },
  },
  {
    id: "POST /v1/me/consent/withdraw",
    method: "POST",
    auth: "session",
    path: () => `${V1}/me/consent/withdraw`,
    body: (rng) => ({ scope: rng.pick([...CONSENT_SCOPES]), source: "settings", device: "iPhone" }),
    requiredKeys: ["scope"],
    optionalKeys: ["source", "device"],
    queryKeys: [],
    oracle: (body) =>
      typeof body.scope === "string" && CONSENT_SCOPES.has(body.scope)
        ? accept([200], ["table:consent_records"], "withdraw valid")
        : reject("scope"),
  },
  // Deletion
  {
    id: "POST /v1/me/delete-request",
    method: "POST",
    auth: "session",
    path: () => `${V1}/me/delete-request`,
    body: (rng) =>
      rng.bool()
        ? {}
        : {
            survey: {
              reason: "not_useful",
              wanted: "more_drills",
              details: "Just testing",
              platform: "ios",
              appVersion: "1.2.3",
            },
          },
    requiredKeys: [],
    optionalKeys: ["survey"],
    queryKeys: [],
    oracle: () =>
      accept(
        [200],
        ["table:account_deletion_requests", "table:account_deletion_feedback"],
        "delete request",
      ),
  },
  {
    id: "POST /v1/me/delete-confirm",
    method: "POST",
    auth: "session",
    path: () => `${V1}/me/delete-confirm`,
    body: (rng, user) => ({
      challenge: rng.bool(0.3) ? deletionChallengeFor(user.id) : rng.uuid(),
    }),
    requiredKeys: ["challenge"],
    optionalKeys: ["appleAuthorizationCode"],
    queryKeys: [],
    oracle: (body, user) => {
      if (!isUuid(body.challenge)) return reject("challenge not uuid");
      if (body.challenge.toLowerCase() !== deletionChallengeFor(user.id)) {
        return {
          kind: "invalid",
          statuses: [403, ...REJECT_STATUSES],
          writeTargets: [],
          reason: "challenge mismatch",
        };
      }
      return accept(
        [200],
        [
          "auth:admin:DELETE",
          "table:account_external_credentials",
          "revenuecat:DELETE",
          "apple:revoke",
        ],
        "challenge matches",
      );
    },
  },
];

export const ROUTE_BY_ID: ReadonlyMap<string, RouteSpec> = new Map(
  ROUTES.map((route) => [route.id, route]),
);

/** Every path the router knows, for method-confusion cases. */
export const KNOWN_PATHS: readonly string[] = [
  `${PUBLIC}/healthz`,
  `${PUBLIC}/support`,
  `${PUBLIC}/privacy`,
  `${PUBLIC}/terms`,
  `${PUBLIC}/webhooks/revenuecat`,
  `${V1}/account/bootstrap`,
  `${V1}/auth/refresh`,
  `${V1}/auth/logout`,
  `${V1}/me`,
  `${V1}/me/onboarding`,
  `${V1}/me/access`,
  `${V1}/billing/sync`,
  `${V1}/analysis-permits`,
  `${V1}/shots:sync`,
  `${V1}/sessions`,
  `${V1}/me/evaluation/trials`,
  `${V1}/progress`,
  `${V1}/rank`,
  `${V1}/me/consent/status`,
  `${V1}/me/consent/grant`,
  `${V1}/me/consent/withdraw`,
  `${V1}/me/delete-request`,
  `${V1}/me/delete-confirm`,
  `${V1}/me/saved-drills`,
  `${V1}/catalog/drills`,
  `${V1}/training-plans/current`,
  `${V1}/training-plans`,
];

export { PUBLIC as PUBLIC_PREFIX, V1 as V1_PREFIX };
