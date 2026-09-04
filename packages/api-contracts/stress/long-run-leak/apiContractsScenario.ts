/**
 * One seeded invocation of the @pickle/api-contracts runtime surface for the
 * long-run-leak campaign: Zod parsing of the client-facing request schemas
 * (valid payloads plus seeded corruptions with a known expected verdict) and
 * the OpenAPI document generator, which is the package's heaviest allocation.
 *
 * Property checks per iteration (violations → BROKEN):
 *  - every untouched seeded payload parses; every seeded corruption is
 *    rejected with ≥ 1 issue that carries a path;
 *  - conditional contracts hold: scored ⇔ score present (ShotSyncPayload),
 *    scored ⇔ ratingId present (AnalysisPermitFinalizeRequest);
 *  - batch bounds: shots 1..200, trials 1..50;
 *  - OpenAPI: 3.1.0, echoes the requested version, exposes the implemented
 *    routes, and JSON-serialises (no cycles, no non-finite numbers).
 */
import {
  CAMERA_VIEWS,
  CHECKPOINTS,
  CONSENT_CAPTURE_MODES,
  CONSENT_SCOPES,
  CONSENT_SOURCES,
  FAULT_DIRECTIONS,
  PHASES,
  SHOT_TYPES,
} from "@pickle/shared-types";
import type { ScenarioResult } from "../../../shared-types/stress/long-run-leak/campaign.js";
import { createRng, type Rng } from "../../../shared-types/stress/long-run-leak/rng.js";
import {
  AccessStateSchema,
  AnalysisPermitFinalizeRequest,
  ConsentGrantRequest,
  EvaluationTrialUploadRequest,
  ShotSyncPayload,
  ShotsSyncRequest,
  buildOpenApiDocument,
} from "../../src/index.js";

type Json = Record<string, unknown>;

interface ParseOutcome {
  label: string;
  expectedSuccess: boolean;
  success: boolean;
  issuePaths: string[];
}

function record(
  label: string,
  expectedSuccess: boolean,
  result: { success: boolean; error?: { issues: ReadonlyArray<{ path: PropertyKey[] }> } },
  violations: string[],
): ParseOutcome {
  const issuePaths = result.success
    ? []
    : (result.error?.issues ?? []).map((i) => i.path.map(String).join("."));
  if (result.success !== expectedSuccess) {
    violations.push(
      `${label}: expected ${expectedSuccess ? "accept" : "reject"} but got ${result.success ? "accept" : "reject"}` +
        (issuePaths.length ? ` (${issuePaths.join(", ")})` : ""),
    );
  }
  if (!result.success && issuePaths.length === 0)
    violations.push(`${label}: rejected without issues`);
  return { label, expectedSuccess, success: result.success, issuePaths };
}

// ------------------------------------------------------------- shot payload

function seededShot(rng: Rng): Json {
  const scored = rng.chance(0.75);
  return {
    id: rng.uuid(),
    analysisPermitId: rng.uuid(),
    sessionId: rng.chance(0.6) ? rng.uuid() : null,
    shotType: rng.pick(SHOT_TYPES),
    cameraView: rng.pick(CAMERA_VIEWS),
    capturedAt: rng.isoDate(),
    timestamps: {
      startMs: rng.int(0, 500),
      contactMs: rng.chance(0.85) ? rng.int(500, 2000) : null,
      endMs: rng.int(2000, 5000),
    },
    overallScore: scored ? Math.round(rng.next() * 1000) / 100 : null,
    confidence: Math.round(rng.next() * 1000) / 1000,
    resultKind: scored ? "scored" : "low_confidence",
    source: "real",
    phases: Array.from({ length: rng.int(0, 5) }, () => ({
      key: rng.pick(PHASES),
      startMs: rng.int(0, 1000),
      representativeMs: rng.int(0, 2000),
      endMs: rng.int(0, 3000),
      confidence: Math.round(rng.next() * 1000) / 1000,
    })),
    checkpoints: Array.from({ length: rng.int(0, 8) }, () => ({
      key: rng.pick(CHECKPOINTS),
      score: rng.chance(0.8) ? rng.int(0, 100) : null,
      confidence: Math.round(rng.next() * 1000) / 1000,
      band: rng.pick(["green", "yellow", "red", "unscored"]),
      direction: rng.pick(FAULT_DIRECTIONS),
      severity: Math.round(rng.next() * 1000) / 1000,
      applicable: rng.chance(0.9),
    })),
    versionVector: {
      appVersion: `0.${rng.int(0, 9)}.${rng.int(0, 99)}`,
      modelBundleVersion: rng.word(8),
      poseModelVersion: rng.word(8),
      paddleModelVersion: rng.word(8),
      strokeDetectorVersion: rng.word(8),
      phaseModelVersion: rng.word(8),
      scoringModelVersion: rng.word(8),
      shotConfigVersion: `${rng.pick(SHOT_TYPES)}@${rng.int(1, 5)}`,
    },
  };
}

type Corruption = { kind: string; apply: (shot: Json, rng: Rng) => Json };

const SHOT_CORRUPTIONS: readonly Corruption[] = [
  { kind: "scoreAbove10", apply: (s) => ({ ...s, overallScore: 10.01, resultKind: "scored" }) },
  { kind: "scoreNegative", apply: (s) => ({ ...s, overallScore: -0.01, resultKind: "scored" }) },
  { kind: "scoreNaN", apply: (s) => ({ ...s, overallScore: Number.NaN, resultKind: "scored" }) },
  {
    kind: "scoreInfinity",
    apply: (s) => ({ ...s, overallScore: Number.POSITIVE_INFINITY, resultKind: "scored" }),
  },
  {
    kind: "scoredWithoutScore",
    apply: (s) => ({ ...s, overallScore: null, resultKind: "scored" }),
  },
  {
    kind: "lowConfidenceWithScore",
    apply: (s) => ({ ...s, overallScore: 5, resultKind: "low_confidence" }),
  },
  { kind: "unknownShotType", apply: (s, rng) => ({ ...s, shotType: rng.word(rng.int(0, 10)) }) },
  { kind: "unknownCameraView", apply: (s) => ({ ...s, cameraView: "drone" }) },
  { kind: "badId", apply: (s, rng) => ({ ...s, id: rng.word(12) }) },
  { kind: "dropPermit", apply: ({ analysisPermitId: _p, ...rest }) => rest },
  { kind: "dropVersionVector", apply: ({ versionVector: _v, ...rest }) => rest },
  { kind: "confidenceAbove1", apply: (s) => ({ ...s, confidence: 1.5 }) },
  { kind: "confidenceNaN", apply: (s) => ({ ...s, confidence: Number.NaN }) },
  {
    kind: "negativeTimestamp",
    apply: (s) => ({ ...s, timestamps: { startMs: -1, contactMs: null, endMs: 10 } }),
  },
  {
    kind: "fractionalTimestamp",
    apply: (s) => ({ ...s, timestamps: { startMs: 0.5, contactMs: null, endMs: 10 } }),
  },
  { kind: "syntheticSource", apply: (s) => ({ ...s, source: "synthetic" }) },
  { kind: "badCapturedAt", apply: (s) => ({ ...s, capturedAt: "yesterday" }) },
  {
    kind: "checkpointScore101",
    apply: (s) => ({
      ...s,
      checkpoints: [
        {
          key: CHECKPOINTS[0],
          score: 101,
          confidence: 0.5,
          band: "red",
          direction: FAULT_DIRECTIONS[0],
          severity: 0.5,
          applicable: true,
        },
      ],
    }),
  },
  {
    kind: "phaseConfidenceNegative",
    apply: (s) => ({
      ...s,
      phases: [{ key: PHASES[0], startMs: 0, representativeMs: 1, endMs: 2, confidence: -0.1 }],
    }),
  },
  { kind: "phasesNotArray", apply: (s) => ({ ...s, phases: {} }) },
];

function exerciseShots(rng: Rng, violations: string[], stats: Record<string, number>) {
  const outcomes: ParseOutcome[] = [];
  const cleanCount = rng.int(1, 3);
  for (let i = 0; i < cleanCount; i += 1) {
    outcomes.push(
      record(`shot clean #${i}`, true, ShotSyncPayload.safeParse(seededShot(rng)), violations),
    );
  }
  for (const corruption of rng.shuffle(SHOT_CORRUPTIONS).slice(0, rng.int(2, 6))) {
    outcomes.push(
      record(
        `shot ${corruption.kind}`,
        false,
        ShotSyncPayload.safeParse(corruption.apply(seededShot(rng), rng)),
        violations,
      ),
    );
  }
  const batchSize = rng.pick([0, 1, 2, rng.int(3, 199), 200, 201, rng.int(202, 260)]);
  const poisonIndex = batchSize > 0 && rng.chance(0.3) ? rng.int(0, batchSize - 1) : -1;
  const shots = Array.from({ length: batchSize }, (_, index) =>
    index === poisonIndex ? { ...seededShot(rng), source: "synthetic" } : seededShot(rng),
  );
  const batchOutcome = record(
    `shots batch n=${batchSize} poison=${poisonIndex}`,
    batchSize >= 1 && batchSize <= 200 && poisonIndex === -1,
    ShotsSyncRequest.safeParse({ shots }),
    violations,
  );
  if (poisonIndex >= 0 && batchSize <= 200 && !batchOutcome.success) {
    const pointsAtPoison = batchOutcome.issuePaths.some((p) =>
      p.startsWith(`shots.${poisonIndex}.`),
    );
    if (!pointsAtPoison)
      violations.push(`shots batch: issue path does not locate poisoned index ${poisonIndex}`);
  }
  outcomes.push(batchOutcome);
  stats.shotParses = outcomes.length;
  stats.shotBatchSize = batchSize;
  return outcomes;
}

// -------------------------------------------------------- permit finalize

const PERMIT_OUTCOMES = [
  "scored",
  "low_confidence",
  "cancelled",
  "failed",
  "unsupported",
  "incorrect_recognition",
] as const;

function exercisePermits(rng: Rng, violations: string[], stats: Record<string, number>) {
  const outcomes: ParseOutcome[] = [];
  for (let i = 0; i < 6; i += 1) {
    const validOutcome = rng.chance(0.85);
    const outcome = validOutcome
      ? rng.pick(PERMIT_OUTCOMES)
      : rng.pick(["expired", "", "SCORED", "done"]);
    const ratingRoll = rng.next();
    const ratingId: unknown =
      ratingRoll < 0.4
        ? rng.uuid()
        : ratingRoll < 0.7
          ? null
          : ratingRoll < 0.9
            ? undefined
            : rng.word(8);
    const payload: Json = { outcome };
    if (ratingId !== undefined) payload.ratingId = ratingId;
    const ratingIsUuid = typeof ratingId === "string" && /^[0-9a-f-]{36}$/.test(ratingId);
    const ratingAbsent = ratingId === null || ratingId === undefined;
    const expected = validOutcome && (outcome === "scored" ? ratingIsUuid : ratingAbsent);
    outcomes.push(
      record(
        `permit outcome=${String(outcome)} rating=${ratingIsUuid ? "uuid" : String(ratingId)}`,
        expected,
        AnalysisPermitFinalizeRequest.safeParse(payload),
        violations,
      ),
    );
  }
  stats.permitParses = outcomes.length;
  return outcomes;
}

// ------------------------------------------------------ evaluation trials

function seededEnvelope(rng: Rng): Json {
  return {
    schemaVersion: "evaluation-trial-v1",
    trialId: rng.uuid(),
    capturedAtIso: rng.isoDate(),
    consent: {
      scope: "evaluation_telemetry",
      consentVersion: `evaluation-telemetry-v${rng.int(1, 3)}`,
    },
    // Loose envelope: the full record rides along untouched.
    outcomeKind: rng.pick(["scored", "low_confidence", "unavailable", "quality_blocked"]),
    latencyMs: rng.chance(0.8) ? rng.int(0, 30000) : null,
  };
}

function exerciseTrials(rng: Rng, violations: string[], stats: Record<string, number>) {
  const size = rng.pick([0, 1, rng.int(2, 49), 50, 51, rng.int(52, 80)]);
  const poison = size > 0 && rng.chance(0.3) ? rng.int(0, size - 1) : -1;
  const trials = Array.from({ length: size }, (_, index) => {
    const envelope = seededEnvelope(rng);
    if (index !== poison) return envelope;
    return rng.pick([
      { ...envelope, schemaVersion: "evaluation-trial-v2" },
      { ...envelope, trialId: "trial-1" },
      { ...envelope, consent: { scope: "model_training", consentVersion: "x" } },
      { ...envelope, consent: { scope: "evaluation_telemetry", consentVersion: "" } },
      { ...envelope, capturedAtIso: "2026-02-30" },
    ]);
  });
  const outcome = record(
    `trials n=${size} poison=${poison}`,
    size >= 1 && size <= 50 && poison === -1,
    EvaluationTrialUploadRequest.safeParse({ trials }),
    violations,
  );
  stats.trialBatchSize = size;
  return outcome;
}

// -------------------------------------------------------- consent / access

function exerciseConsentAndAccess(rng: Rng, violations: string[], stats: Record<string, number>) {
  const outcomes: ParseOutcome[] = [];
  const grant: Json = {
    scope: rng.pick(CONSENT_SCOPES),
    consentVersion: rng.word(rng.int(1, 64)),
    source: rng.pick(CONSENT_SOURCES),
    captureMode: rng.pick(CONSENT_CAPTURE_MODES),
  };
  if (rng.chance(0.5)) grant.device = rng.chance(0.8) ? rng.word(rng.int(1, 160)) : null;
  if (rng.chance(0.5)) grant.strokeIntent = rng.chance(0.8) ? rng.pick(SHOT_TYPES) : null;
  if (rng.chance(0.6)) grant.decisionId = rng.uuid();
  if (rng.chance(0.6)) grant.decidedAtIso = rng.isoDate();
  outcomes.push(
    record("consent grant clean", true, ConsentGrantRequest.safeParse(grant), violations),
  );
  const grantCorruption = rng.pick([
    { kind: "version65", value: { ...grant, consentVersion: rng.word(65) } },
    { kind: "versionEmpty", value: { ...grant, consentVersion: "" } },
    { kind: "device161", value: { ...grant, device: rng.word(161) } },
    { kind: "scope", value: { ...grant, scope: "marketing" } },
    { kind: "decisionId", value: { ...grant, decisionId: "abc" } },
    { kind: "decidedAt", value: { ...grant, decidedAtIso: "now" } },
  ]);
  outcomes.push(
    record(
      `consent grant ${grantCorruption.kind}`,
      false,
      ConsentGrantRequest.safeParse(grantCorruption.value),
      violations,
    ),
  );

  const used = rng.int(0, 2);
  const reserved = rng.int(0, 3);
  const remaining = 2 - used;
  const access: Json = {
    premium: rng.chance(0.3),
    entitlements: rng.chance(0.5) ? ["pickle_sensei_pro"] : [],
    freeRatings: {
      limit: 2,
      used,
      reserved,
      remaining,
      availableToReserve: Math.max(0, remaining - reserved),
    },
    canStartRating: rng.chance(0.5),
    paywallRequired: rng.chance(0.5),
  };
  outcomes.push(record("access clean", true, AccessStateSchema.safeParse(access), violations));
  const accessCorruption = rng.pick([
    {
      kind: "limit3",
      value: { ...access, freeRatings: { ...(access.freeRatings as Json), limit: 3 } },
    },
    {
      kind: "used3",
      value: { ...access, freeRatings: { ...(access.freeRatings as Json), used: 3 } },
    },
    {
      kind: "usedFraction",
      value: { ...access, freeRatings: { ...(access.freeRatings as Json), used: 0.5 } },
    },
    {
      kind: "reservedNegative",
      value: { ...access, freeRatings: { ...(access.freeRatings as Json), reserved: -1 } },
    },
    {
      kind: "remainingNaN",
      value: { ...access, freeRatings: { ...(access.freeRatings as Json), remaining: Number.NaN } },
    },
  ]);
  outcomes.push(
    record(
      `access ${accessCorruption.kind}`,
      false,
      AccessStateSchema.safeParse(accessCorruption.value),
      violations,
    ),
  );
  stats.consentAccessParses = outcomes.length;
  return outcomes;
}

// ------------------------------------------------------------------ openapi

function exerciseOpenApi(rng: Rng, violations: string[], stats: Record<string, number>) {
  const version = `${rng.int(0, 3)}.${rng.int(0, 20)}.${rng.int(0, 99)}`;
  const document = buildOpenApiDocument(version) as {
    openapi?: unknown;
    info?: { version?: unknown };
    paths?: Record<string, unknown>;
  };
  if (document.openapi !== "3.1.0")
    violations.push(`openapi: version field ${String(document.openapi)}`);
  if (document.info?.version !== version)
    violations.push(`openapi: info.version ${String(document.info?.version)} != ${version}`);
  const paths = Object.keys(document.paths ?? {});
  for (const route of ["/v1/health", "/v1/catalog/shot-types", "/v1/shots:sync"]) {
    if (!paths.includes(route)) violations.push(`openapi: missing route ${route}`);
  }
  let serialisedLength = 0;
  try {
    serialisedLength = JSON.stringify(document).length;
  } catch (error) {
    violations.push(`openapi: not serialisable: ${String(error)}`);
  }
  stats.openApiPaths = paths.length;
  stats.openApiBytes = serialisedLength;
  return { version, paths, serialisedLength, document };
}

// ------------------------------------------------------------------ scenario

export function apiContractsScenario(seed: number): ScenarioResult {
  const rng = createRng(seed);
  const violations: string[] = [];
  const stats: Record<string, number> = {};
  const shots = exerciseShots(rng, violations, stats);
  const permits = exercisePermits(rng, violations, stats);
  const trials = exerciseTrials(rng, violations, stats);
  const consentAccess = exerciseConsentAndAccess(rng, violations, stats);
  const openapi = exerciseOpenApi(rng, violations, stats);
  return {
    outputs: { shots, permits, trials, consentAccess, openapi },
    violations,
    stats,
  };
}
