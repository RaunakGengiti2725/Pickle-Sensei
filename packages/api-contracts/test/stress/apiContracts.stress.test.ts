import { describe, it } from "vitest";
import { z } from "zod";
import {
  ANALYSIS_FEEDBACK_CATEGORIES,
  ANALYSIS_FEEDBACK_RATINGS,
  CAMERA_VIEWS,
  CHECKPOINTS,
  CONSENT_CAPTURE_MODES,
  CONSENT_SCOPES,
  CONSENT_SOURCES,
  EVALUATION_TRIAL_SCHEMA_VERSION,
  FAULT_DIRECTIONS,
  PHASES,
  SHOT_TYPES,
  validateEvaluationTrial,
} from "@pickle/shared-types";
import {
  AnalysisFeedbackRequest,
  AnalysisPermitFinalizeRequest,
  ConsentGrantRequest,
  DrillCompletionCreateRequest,
  EvaluationTrialUploadRequest,
  ShotSyncPayload,
  ShotsSyncRequest,
  buildOpenApiDocument,
} from "../../src/index.js";
import * as contracts from "../../src/schemas.js";
import {
  bump,
  canonical,
  check,
  checkCanonicalEqual,
  checkEqual,
  expectCampaignHeld,
  runStressCampaign,
  stable,
  type Rng,
  type StressCampaign,
  stressTestTimeoutMs,
} from "../../../shared-types/test/stress/harness.js";

/**
 * Seeded stress of the /v1 zod contracts (schemas.ts) and the generated
 * OpenAPI document (openapi.ts):
 *
 *  campaign `shot-sync-contract`
 *   - a payload built from the taxonomy enums with in-range numerics parses,
 *     and the parsed value is byte-identical to the input (no coercion, no
 *     injected defaults);
 *   - every single-field corruption (unknown enum member, bad uuid, bad ISO
 *     datetime, NaN/±Infinity, negative or fractional ms, out-of-range score
 *     or confidence, `source` ≠ "real", scored↔low_confidence /
 *     overallScore mismatch) is rejected with every issue located at the
 *     corrupted path — never a spurious issue elsewhere;
 *   - ShotsSyncRequest batch bounds are exactly 1..200;
 *   - parse is deterministic and never throws.
 *
 *  campaign `request-refinements`
 *   - AnalysisPermitFinalizeRequest: ratingId required iff outcome=scored,
 *     omitted ratingId defaults to null, never accepted alongside a
 *     non-scored outcome;
 *   - AnalysisFeedbackRequest: category present iff rating=not_quite;
 *   - DrillCompletionCreateRequest: needs repetitions or duration, integer
 *     ranges 1..10_000 / 1..14_400, drillSlug length 3..60;
 *   - ConsentGrantRequest: consentVersion 1..64, device 1..160, strokeIntent
 *     1..60, optional uuid decisionId / ISO decidedAtIso;
 *   - EvaluationTrialUploadRequest: 1..50 trials, loose envelope keeps extra
 *     keys verbatim, and every record accepted by validateEvaluationTrial
 *     (uuid trialId, ISO capturedAtIso) is also accepted by the envelope.
 *
 *  campaign `openapi-document`
 *   - buildOpenApiDocument(v) is deterministic for the same v, differs from
 *     any other version ONLY in info.version, echoes v verbatim (including
 *     empty, unicode and 300-char strings), is JSON round-trippable (no
 *     undefined/NaN/functions), every path is under /v1/, operationIds are
 *     unique, every operation has a 2xx response, every documented content
 *     block carries a schema, and each embedded schema equals a fresh
 *     z.toJSONSchema of the exported contract; every exported zod schema
 *     converts to JSON Schema deterministically without throwing.
 *   - near-legal probe (STRESS_NEAR_LEGAL=1): every 2xx response documents a
 *     JSON body schema. Known to fail today: `/v1/drill-completions` 200 has
 *     no content although the mobile client reads `payload.completion`
 *     (apps/mobile/src/training/api.ts) — reported as a finding, not fixed
 *     here.
 */

const HEX = "0123456789abcdef";
function uuid(rng: Rng): string {
  const h = (n: number): string => Array.from({ length: n }, () => HEX[rng.int(0, 15)]!).join("");
  return `${h(8)}-${h(4)}-4${h(3)}-${"89ab"[rng.int(0, 3)]!}${h(3)}-${h(12)}`;
}
function iso(rng: Rng): string {
  return new Date(
    Date.UTC(
      2026,
      rng.int(0, 11),
      rng.int(1, 28),
      rng.int(0, 23),
      rng.int(0, 59),
      rng.int(0, 59),
      rng.int(0, 999),
    ),
  ).toISOString();
}
function unit(rng: Rng): number {
  return rng.int(0, 1000) / 1000;
}

type Json = Record<string, unknown>;

function validShot(rng: Rng): Json {
  const scored = rng.chance(0.6);
  return {
    id: uuid(rng),
    analysisPermitId: uuid(rng),
    sessionId: rng.chance(0.3) ? null : uuid(rng),
    shotType: rng.pick(SHOT_TYPES),
    cameraView: rng.pick(CAMERA_VIEWS),
    capturedAt: iso(rng),
    timestamps: {
      startMs: rng.int(0, 5000),
      contactMs: rng.chance(0.2) ? null : rng.int(0, 5000),
      endMs: rng.int(0, 5000),
    },
    overallScore: scored ? rng.int(0, 100) / 10 : null,
    confidence: unit(rng),
    resultKind: scored ? "scored" : "low_confidence",
    source: "real",
    phases: Array.from({ length: rng.int(0, 6) }, () => ({
      key: rng.pick(PHASES),
      startMs: rng.int(0, 5000),
      representativeMs: rng.int(0, 5000),
      endMs: rng.int(0, 5000),
      confidence: unit(rng),
    })),
    checkpoints: Array.from({ length: rng.int(0, 11) }, () => ({
      key: rng.pick(CHECKPOINTS),
      score: rng.chance(0.2) ? null : rng.int(0, 100),
      confidence: unit(rng),
      band: rng.pick(["green", "yellow", "red", "unscored"]),
      direction: rng.pick(FAULT_DIRECTIONS),
      severity: unit(rng),
      applicable: rng.chance(0.8),
    })),
    versionVector: {
      appVersion: `1.${rng.int(0, 9)}.${rng.int(0, 9)}`,
      modelBundleVersion: `bundle-${rng.int(0, 99)}`,
      poseModelVersion: `pose-${rng.int(0, 99)}`,
      paddleModelVersion: `paddle-${rng.int(0, 99)}`,
      strokeDetectorVersion: `stroke-${rng.int(0, 99)}`,
      phaseModelVersion: `phase-${rng.int(0, 99)}`,
      scoringModelVersion: `sm-v${rng.int(0, 9)}`,
      shotConfigVersion: `${rng.pick(SHOT_TYPES)}@${rng.int(1, 5)}`,
    },
  };
}

function clone<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_k, v: unknown) =>
      typeof v === "number" && !Number.isFinite(v) ? `__nf:${String(v)}` : v,
    ),
    (_k, v: unknown) => (typeof v === "string" && v.startsWith("__nf:") ? Number(v.slice(5)) : v),
  ) as T;
}

function setPath(root: Json, path: readonly (string | number)[], value: unknown): void {
  let cursor: unknown = root;
  for (const part of path.slice(0, -1)) cursor = (cursor as Record<string | number, unknown>)[part];
  (cursor as Record<string | number, unknown>)[path[path.length - 1]!] = value;
}

const NON_FINITE = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
const BAD_UUIDS = [
  "",
  "not-a-uuid",
  "1f0e8c1a-2b3c-4d5e-8f90-abcdefabcde",
  "1f0e8c1a2b3c4d5e8f90abcdefabcdef",
  "1F0E8C1A-2B3C-4D5E-CF90-ABCDEFABCDEF",
];
const BAD_ISO = [
  "",
  "2026-08-26",
  "2026-08-26T18:00:00",
  "2026-08-26 18:00:00Z",
  "26/08/2026",
  "2026-13-01T00:00:00.000Z",
];

interface Corruption {
  /** Path where every issue must be located. */
  path: (string | number)[];
  /** Path actually written (defaults to `path`). */
  write?: (string | number)[];
  value: unknown;
}

/** Enumerates single-field corruptions available on `shot`; variant selects the value. */
function shotCorruptions(shot: Json, variant: number): Corruption[] {
  const pick = <T>(items: readonly T[]): T => items[variant % items.length]!;
  const list: Corruption[] = [
    { path: ["id"], value: pick(BAD_UUIDS) },
    { path: ["analysisPermitId"], value: pick([...BAD_UUIDS, null]) },
    { path: ["sessionId"], value: pick([...BAD_UUIDS, 7]) },
    { path: ["shotType"], value: pick(["Serve", "lob", "", null, "forehand-drive"]) },
    { path: ["cameraView"], value: pick(["front", "SIDE", "", 1]) },
    { path: ["capturedAt"], value: pick([...BAD_ISO, 1_700_000_000_000]) },
    { path: ["timestamps", "startMs"], value: pick([-1, 0.5, ...NON_FINITE, "0"]) },
    { path: ["timestamps", "contactMs"], value: pick([-5, 1.25, ...NON_FINITE]) },
    { path: ["timestamps", "endMs"], value: pick([-1, 2.5, ...NON_FINITE, null]) },
    { path: ["confidence"], value: pick([-0.01, 1.01, ...NON_FINITE, "0.5", null]) },
    { path: ["source"], value: pick(["synthetic", "REAL", "", null, "demo"]) },
    {
      path: ["overallScore"],
      value:
        shot["resultKind"] === "scored"
          ? pick([-0.1, 10.1, ...NON_FINITE, "7", null])
          : pick([7.5, 0, 10, ...NON_FINITE, -1]),
    },
    {
      path: ["overallScore"],
      write: ["resultKind"],
      value: shot["resultKind"] === "scored" ? "low_confidence" : "scored",
    },
    { path: ["resultKind"], value: pick(["abstained", "SCORED", "", null]) },
    { path: ["versionVector", "scoringModelVersion"], value: pick([null, 1, undefined]) },
    { path: ["versionVector"], value: pick([null, "v1", []]) },
    { path: ["phases"], value: pick([null, "none", {}]) },
    { path: ["checkpoints"], value: pick([null, 3]) },
  ];
  const phases = shot["phases"] as Json[];
  if (phases.length > 0) {
    const i = variant % phases.length;
    list.push({ path: ["phases", i, "key"], value: pick(["swing", "CONTACT", "", null]) });
    list.push({ path: ["phases", i, "startMs"], value: pick([-1, 0.5, ...NON_FINITE]) });
    list.push({ path: ["phases", i, "confidence"], value: pick([1.5, -1, ...NON_FINITE]) });
  }
  const checkpoints = shot["checkpoints"] as Json[];
  if (checkpoints.length > 0) {
    const i = variant % checkpoints.length;
    list.push({ path: ["checkpoints", i, "key"], value: pick(["grip", "", null]) });
    list.push({ path: ["checkpoints", i, "score"], value: pick([-1, 100.5, ...NON_FINITE, "50"]) });
    list.push({ path: ["checkpoints", i, "band"], value: pick(["blue", "GREEN", "", null]) });
    list.push({ path: ["checkpoints", i, "direction"], value: pick(["sideways", "", null, 0]) });
    list.push({ path: ["checkpoints", i, "severity"], value: pick([2, -0.5, ...NON_FINITE]) });
    list.push({ path: ["checkpoints", i, "applicable"], value: pick(["true", 1, null]) });
  }
  return list;
}

type ShotAction =
  | { kind: "fresh" }
  | { kind: "legal_mutate"; field: number; variant: number }
  | { kind: "corrupt"; index: number; variant: number }
  | { kind: "batch"; size: number };

const LEGAL_MUTATIONS: ((shot: Json, rng: Rng) => void)[] = [
  (s, r) => setPath(s, ["sessionId"], r.chance(0.5) ? null : uuid(r)),
  (s, r) => setPath(s, ["timestamps", "contactMs"], r.chance(0.3) ? null : r.int(0, 2 ** 31)),
  (s, r) => setPath(s, ["confidence"], r.pick([0, 1, 0.5, 1e-9, 0.999999])),
  (s, r) => {
    const scored = r.chance(0.5);
    setPath(s, ["resultKind"], scored ? "scored" : "low_confidence");
    setPath(s, ["overallScore"], scored ? r.pick([0, 10, 5.55, 9.999]) : null);
  },
  (s, r) => setPath(s, ["shotType"], r.pick(SHOT_TYPES)),
  (s, r) =>
    setPath(
      s,
      ["capturedAt"],
      r.pick(["2026-08-26T18:00:00Z", "2026-08-26T18:00:00.000Z", "1970-01-01T00:00:00Z", iso(r)]),
    ),
  (s) => setPath(s, ["phases"], []),
  (s, r) =>
    setPath(
      s,
      ["checkpoints"],
      Array.from({ length: r.int(1, 3) }, () => ({
        key: r.pick(CHECKPOINTS),
        score: null,
        confidence: 0,
        band: "unscored",
        direction: "none",
        severity: 0,
        applicable: false,
      })),
    ),
  (s, r) =>
    setPath(s, ["versionVector", "appVersion"], r.pick(["", "0.0.0", "very long ".repeat(20)])),
];

function issuePathsAllEqual(
  issues: readonly z.core.$ZodIssue[],
  expected: readonly (string | number)[],
): boolean {
  const target = expected.join(".");
  return issues.length > 0 && issues.every((issue) => issue.path.map(String).join(".") === target);
}

function makeShotCampaign(): StressCampaign<ShotAction, { shot: Json; rng: Rng }> {
  const stats: Record<string, number> = {};
  return {
    name: "shot-sync-contract",
    stats,
    init: (rng) => ({ shot: validShot(rng), rng: rng.fork() }),
    genAction: (rng) => {
      const roll = rng.next();
      if (roll < 0.1) return { kind: "fresh" };
      if (roll < 0.4)
        return {
          kind: "legal_mutate",
          field: rng.int(0, LEGAL_MUTATIONS.length - 1),
          variant: rng.int(0, 0xffff),
        };
      if (roll < 0.92) return { kind: "corrupt", index: rng.int(0, 63), variant: rng.int(0, 15) };
      return { kind: "batch", size: rng.pick([0, 1, 2, 199, 200, 201]) };
    },
    step(model, action) {
      if (action.kind === "fresh") model.shot = validShot(model.rng.fork());
      if (action.kind === "legal_mutate")
        LEGAL_MUTATIONS[action.field]!(model.shot, model.rng.fork());

      const baseline = ShotSyncPayload.safeParse(model.shot);
      check(baseline.success, "legal-shot-accepted", () =>
        stable(baseline.success ? null : baseline.error.issues),
      );
      if (baseline.success)
        checkCanonicalEqual(baseline.data, model.shot, "parsed-shot-identical-to-input");
      checkEqual(
        ShotSyncPayload.safeParse(model.shot).success,
        baseline.success,
        "shot-parse-deterministic",
      );

      if (action.kind === "corrupt") {
        const options = shotCorruptions(model.shot, action.variant);
        const corruption = options[action.index % options.length]!;
        const corrupted = clone(model.shot);
        setPath(corrupted, corruption.write ?? corruption.path, corruption.value);
        const result = ShotSyncPayload.safeParse(corrupted);
        check(
          !result.success,
          "corrupted-shot-rejected",
          () =>
            `${(corruption.write ?? corruption.path).join(".")}=${stable(corruption.value)} accepted`,
        );
        if (!result.success) {
          check(
            issuePathsAllEqual(result.error.issues, corruption.path),
            "issues-located-at-corrupted-path",
            () =>
              `${corruption.path.join(".")} ← ${stable(result.error.issues.map((i) => i.path))}`,
          );
          checkEqual(
            stable(ShotSyncPayload.safeParse(corrupted)),
            stable(result),
            "rejection-deterministic",
          );
        }
        bump(stats, "corrupt");
        return `corrupt:${corruption.path.join(".")}`;
      }
      if (action.kind === "batch") {
        const request = { shots: Array.from({ length: action.size }, () => model.shot) };
        const result = ShotsSyncRequest.safeParse(request);
        checkEqual(
          result.success,
          action.size >= 1 && action.size <= 200,
          "batch-bounds-exactly-1-to-200",
        );
        if (!result.success)
          check(issuePathsAllEqual(result.error.issues, ["shots"]), "batch-issue-at-shots", () =>
            stable(result.error.issues),
          );
        bump(stats, "batch");
        return `batch:${action.size}:${result.success ? 1 : 0}`;
      }
      bump(stats, action.kind);
      return `${action.kind}:ok`;
    },
  };
}

type RefinementAction =
  | { kind: "finalize"; outcome: string; ratingId: string | null | undefined }
  | { kind: "feedback"; rating: string; category: string | null }
  | {
      kind: "drill";
      reps: number | null | undefined;
      duration: number | null | undefined;
      slugLength: number;
    }
  | {
      kind: "consent";
      versionLength: number;
      deviceLength: number | null | undefined;
      intentLength: number | null | undefined;
      decision: "omit" | "uuid" | "bad";
      decidedAt: "omit" | "iso" | "bad";
    }
  | { kind: "trial_upload"; count: number; extraKeys: boolean; corruptVersion: boolean };

const FINALIZE_OUTCOMES = [
  "scored",
  "low_confidence",
  "cancelled",
  "failed",
  "unsupported",
  "incorrect_recognition",
] as const;

function makeRefinementCampaign(): StressCampaign<RefinementAction, { rng: Rng }> {
  const stats: Record<string, number> = {};
  return {
    name: "request-refinements",
    stats,
    init: (rng) => ({ rng: rng.fork() }),
    genAction: (rng) => {
      switch (rng.int(0, 4)) {
        case 0:
          return {
            kind: "finalize",
            outcome: rng.pick([...FINALIZE_OUTCOMES, "expired", "SCORED", ""]),
            ratingId: rng.chance(0.4) ? uuid(rng) : rng.pick([undefined, null, "not-a-uuid"]),
          };
        case 1:
          return {
            kind: "feedback",
            rating: rng.pick([...ANALYSIS_FEEDBACK_RATINGS, "great", ""]),
            category: rng.chance(0.4) ? null : rng.pick([...ANALYSIS_FEEDBACK_CATEGORIES, "bogus"]),
          };
        case 2:
          return {
            kind: "drill",
            reps: rng.pick([undefined, null, 0, 1, 500, 10_000, 10_001, 2.5, Number.NaN]),
            duration: rng.pick([undefined, null, 0, 1, 14_400, 14_401, -1, 3.3]),
            slugLength: rng.pick([0, 2, 3, 30, 60, 61]),
          };
        case 3:
          return {
            kind: "consent",
            versionLength: rng.pick([0, 1, 64, 65, 20]),
            deviceLength: rng.pick([undefined, null, 0, 1, 160, 161]),
            intentLength: rng.pick([undefined, null, 0, 1, 60, 61]),
            decision: rng.pick(["omit", "uuid", "bad"]),
            decidedAt: rng.pick(["omit", "iso", "bad"]),
          };
        default:
          return {
            kind: "trial_upload",
            count: rng.pick([0, 1, 7, 50, 51]),
            extraKeys: rng.chance(0.5),
            corruptVersion: rng.chance(0.15),
          };
      }
    },
    step(model, action) {
      const rng = model.rng.fork();
      switch (action.kind) {
        case "finalize": {
          const body: Json = { outcome: action.outcome };
          if (action.ratingId !== undefined) body["ratingId"] = action.ratingId;
          const result = AnalysisPermitFinalizeRequest.safeParse(body);
          const outcomeValid = (FINALIZE_OUTCOMES as readonly string[]).includes(action.outcome);
          const ratingIsUuid =
            typeof action.ratingId === "string" && z.uuid().safeParse(action.ratingId).success;
          const ratingShapeValid =
            action.ratingId === undefined || action.ratingId === null || ratingIsUuid;
          const expected =
            outcomeValid &&
            ratingShapeValid &&
            (action.outcome === "scored" ? ratingIsUuid : !ratingIsUuid);
          checkEqual(result.success, expected, "finalize-ratingId-iff-scored");
          if (result.success)
            checkEqual(
              result.data.ratingId,
              action.ratingId ?? null,
              "finalize-omitted-ratingId-defaults-null",
            );
          bump(stats, `finalize_${expected ? "ok" : "rejected"}`);
          return `finalize:${result.success ? 1 : 0}`;
        }
        case "feedback": {
          const result = AnalysisFeedbackRequest.safeParse({
            rating: action.rating,
            category: action.category,
          });
          const ratingValid = (ANALYSIS_FEEDBACK_RATINGS as readonly string[]).includes(
            action.rating,
          );
          const categoryValid =
            action.category === null ||
            (ANALYSIS_FEEDBACK_CATEGORIES as readonly string[]).includes(action.category);
          const expected =
            ratingValid &&
            categoryValid &&
            (action.rating === "not_quite") === (action.category !== null);
          checkEqual(result.success, expected, "feedback-category-iff-not-quite");
          bump(stats, `feedback_${expected ? "ok" : "rejected"}`);
          return `feedback:${result.success ? 1 : 0}`;
        }
        case "drill": {
          const body: Json = {
            id: uuid(rng),
            drillSlug: "d".repeat(action.slugLength),
            completedAt: iso(rng),
          };
          if (action.reps !== undefined) body["actualRepetitions"] = action.reps;
          if (action.duration !== undefined) body["actualDurationSeconds"] = action.duration;
          const result = DrillCompletionCreateRequest.safeParse(body);
          const intIn = (v: number | null | undefined, max: number): boolean =>
            v == null || (Number.isInteger(v) && v >= 1 && v <= max);
          const expected =
            action.slugLength >= 3 &&
            action.slugLength <= 60 &&
            intIn(action.reps, 10_000) &&
            intIn(action.duration, 14_400) &&
            (action.reps != null || action.duration != null);
          checkEqual(result.success, expected, "drill-completion-ranges-and-requires-effort");
          bump(stats, `drill_${expected ? "ok" : "rejected"}`);
          return `drill:${result.success ? 1 : 0}`;
        }
        case "consent": {
          const body: Json = {
            scope: rng.pick(CONSENT_SCOPES),
            consentVersion: "v".repeat(action.versionLength),
            source: rng.pick(CONSENT_SOURCES),
            captureMode: rng.pick(CONSENT_CAPTURE_MODES),
          };
          if (action.deviceLength !== undefined)
            body["device"] = action.deviceLength === null ? null : "d".repeat(action.deviceLength);
          if (action.intentLength !== undefined)
            body["strokeIntent"] =
              action.intentLength === null ? null : "s".repeat(action.intentLength);
          if (action.decision !== "omit")
            body["decisionId"] = action.decision === "uuid" ? uuid(rng) : "nope";
          if (action.decidedAt !== "omit")
            body["decidedAtIso"] = action.decidedAt === "iso" ? iso(rng) : "yesterday";
          const result = ConsentGrantRequest.safeParse(body);
          const lenOk = (v: number | null | undefined, max: number): boolean =>
            v == null || (v >= 1 && v <= max);
          const expected =
            action.versionLength >= 1 &&
            action.versionLength <= 64 &&
            lenOk(action.deviceLength, 160) &&
            lenOk(action.intentLength, 60) &&
            action.decision !== "bad" &&
            action.decidedAt !== "bad";
          checkEqual(result.success, expected, "consent-grant-length-and-identity-bounds");
          if (result.success)
            checkCanonicalEqual(result.data, body, "consent-grant-parsed-identical");
          bump(stats, `consent_${expected ? "ok" : "rejected"}`);
          return `consent:${result.success ? 1 : 0}`;
        }
        case "trial_upload": {
          const trials = Array.from({ length: action.count }, () => {
            const trial: Json = {
              schemaVersion: EVALUATION_TRIAL_SCHEMA_VERSION,
              trialId: uuid(rng),
              captureId: `cap-${rng.int(0, 999)}`,
              analysisId: null,
              capturedAtIso: iso(rng),
              recordedAtIso: iso(rng),
              outcomeKind: "unavailable",
              outcomeReason: null,
              envelopeOverall: null,
              latencyMs: null,
              appVersion: "1.0.0",
              engineVersion: null,
              modelBundleVersion: null,
              declaredStroke: null,
              claims: {
                targetLock: { status: "not_measured" },
                eventSelection: { status: "not_measured", startMs: null, endMs: null },
                strokeLabel: { status: "not_measured", label: null, confidence: null },
                contactMarker: {
                  status: "not_measured",
                  estimatedContactMs: null,
                  ballConfirmed: false,
                  paddleConfirmed: false,
                },
                phaseRender: { status: "not_measured", contactMs: null, followThroughEndMs: null },
                resultScore: {
                  status: "abstained",
                  overallScore: null,
                  analysisConfidence: null,
                  presentation: "abstain",
                },
              },
              limitingFactors: [],
              userFlags: [],
              dims: {
                userPseudonym: null,
                sessionId: null,
                courtId: null,
                deviceModel: null,
                devicePlatform: "ios",
                osVersion: null,
              },
              consent: {
                scope: "evaluation_telemetry",
                consentVersion: `evaluation-telemetry-v${rng.int(1, 9)}`,
              },
            };
            if (action.extraKeys) trial[`extra_${rng.int(0, 9)}`] = { nested: rng.int(0, 9) };
            return trial;
          });
          if (action.corruptVersion && trials.length > 0)
            trials[0]!["schemaVersion"] = "evaluation-trial-v0";
          const result = EvaluationTrialUploadRequest.safeParse({ trials });
          const expected =
            action.count >= 1 && action.count <= 50 && !(action.corruptVersion && action.count > 0);
          checkEqual(result.success, expected, "trial-upload-bounds-1-to-50-and-version-literal");
          if (result.success) {
            checkCanonicalEqual(
              result.data.trials,
              trials,
              "loose-envelope-keeps-extra-keys-verbatim",
            );
            for (const trial of trials) {
              const deep = validateEvaluationTrial(trial);
              check(deep.ok, "envelope-accepted-record-passes-deep-validator", () =>
                stable(deep.errors),
              );
            }
          }
          bump(stats, `trial_upload_${expected ? "ok" : "rejected"}`);
          return `trial_upload:${result.success ? 1 : 0}`;
        }
      }
    },
  };
}

type OpenApiAction =
  | { kind: "build"; version: string }
  | { kind: "convert_one"; index: number }
  | { kind: "route_check"; index: number };

const SCHEMA_EXPORTS: [string, z.ZodType][] = Object.entries(
  contracts as Record<string, unknown>,
).flatMap(([name, value]): [string, z.ZodType][] =>
  value instanceof z.ZodType ? [[name, value]] : [],
);

const ROUTE_SCHEMAS: [string, string, "requestBody" | "200", z.ZodType][] = [
  ["/v1/shots:sync", "post", "requestBody", ShotsSyncRequest],
  ["/v1/shots:sync", "post", "200", contracts.ShotsSyncResponse],
  ["/v1/analysis-permits/{id}/finalize", "post", "requestBody", AnalysisPermitFinalizeRequest],
  ["/v1/analysis-permits/{id}/finalize", "post", "200", contracts.AnalysisPermitResponse],
  ["/v1/me/consent/grant", "post", "requestBody", ConsentGrantRequest],
  ["/v1/me/consent/status", "get", "200", contracts.ConsentStatusResponse],
  ["/v1/drill-completions", "post", "requestBody", DrillCompletionCreateRequest],
  ["/v1/admin/quality-dashboard", "get", "200", contracts.QualityDashboardResponse],
  ["/v1/me/access", "get", "200", contracts.AccessStateSchema],
];

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];
const REFERENCE_VERSION = "0.0.0-stress-reference";

function randomVersion(rng: Rng): string {
  switch (rng.int(0, 4)) {
    case 0:
      return `${rng.int(0, 99)}.${rng.int(0, 99)}.${rng.int(0, 999)}`;
    case 1:
      return `${rng.int(0, 9)}.${rng.int(0, 9)}.${rng.int(0, 9)}-rc.${rng.int(0, 9)}+sha.${uuid(rng).slice(0, 8)}`;
    case 2:
      return "";
    case 3:
      return Array.from({ length: rng.int(1, 40) }, () =>
        String.fromCodePoint(rng.pick([0x20, 0x22, 0x5c, 0x7f, 0xe9, 0x4e2d, 0x1f3d3, 0x0a])),
      ).join("");
    default:
      return "v".repeat(rng.int(1, 300));
  }
}

interface OpenApiModel {
  /** Document built once per sequence at REFERENCE_VERSION; every later build must equal it modulo info.version. */
  reference: Json;
  /** canonical(reference) with the version literal replaced by a token that cannot appear in JSON output. */
  referenceTemplate: string;
}

const VERSION_TOKEN = "\u0000VERSION\u0000";

/** Structural audit of a freshly built document (runs on every `build` step so violations are recorded and minimized per seed). */
function auditDocument(doc: Json, strictBodies: boolean): number {
  checkEqual(doc["openapi"], "3.1.0", "openapi-version-literal");
  const paths = doc["paths"] as Record<string, Record<string, Json>>;
  const operationIds = new Set<string>();
  let operations = 0;
  for (const [route, methods] of Object.entries(paths)) {
    check(route.startsWith("/v1/"), "every-route-under-v1", () => route);
    for (const [method, operation] of Object.entries(methods)) {
      operations += 1;
      check(HTTP_METHODS.includes(method), "http-method-known", () => `${route} ${method}`);
      const id = operation["operationId"];
      check(
        typeof id === "string" && id.length > 0 && !operationIds.has(id),
        "operationId-unique-non-empty",
        () => `${route} ${method} ${String(id)}`,
      );
      if (typeof id === "string") operationIds.add(id);
      const responses = operation["responses"] as Record<string, Json>;
      const success = Object.keys(responses).filter((code) => code.startsWith("2"));
      check(success.length > 0, "operation-has-2xx-response", () => `${route} ${method}`);
      for (const [code, response] of Object.entries(responses)) {
        const content = response["content"] as Json | undefined;
        if (content !== undefined) {
          const json = content["application/json"] as Json | undefined;
          check(
            json !== undefined && typeof json["schema"] === "object" && json["schema"] !== null,
            "documented-content-has-json-schema",
            () => `${route} ${method} ${code}`,
          );
        } else if (strictBodies && code.startsWith("2")) {
          check(false, "2xx-response-documents-body-schema", () => `${route} ${method} ${code}`);
        }
      }
      const body = operation["requestBody"] as Json | undefined;
      if (body !== undefined) {
        const json = (body["content"] as Json)["application/json"] as Json | undefined;
        check(
          json !== undefined && typeof json["schema"] === "object",
          "request-body-has-json-schema",
          () => `${route} ${method}`,
        );
      }
    }
  }
  check(operations > 0, "document-has-operations", () => stable(Object.keys(paths)));
  return operations;
}

function makeOpenApiCampaign(strictBodies: boolean): StressCampaign<OpenApiAction, OpenApiModel> {
  const stats: Record<string, number> = {};
  return {
    name: strictBodies ? "openapi-document-strict-bodies" : "openapi-document",
    stats,
    init: () => {
      const reference = buildOpenApiDocument(REFERENCE_VERSION);
      const serialized = canonical(reference);
      const literal = JSON.stringify(REFERENCE_VERSION);
      check(serialized.split(literal).length === 2, "reference-version-appears-exactly-once", () =>
        String(serialized.split(literal).length - 1),
      );
      return { reference, referenceTemplate: serialized.replace(literal, VERSION_TOKEN) };
    },
    genAction: (rng) => {
      const roll = rng.next();
      if (roll < 0.15) return { kind: "build", version: randomVersion(rng) };
      if (roll < 0.65) return { kind: "convert_one", index: rng.int(0, SCHEMA_EXPORTS.length - 1) };
      return { kind: "route_check", index: rng.int(0, ROUTE_SCHEMAS.length - 1) };
    },
    step(model, action) {
      switch (action.kind) {
        case "build": {
          const doc = buildOpenApiDocument(action.version);
          checkEqual(
            (doc["info"] as Json)["version"],
            action.version,
            "openapi-echoes-version-verbatim",
          );
          const serialized = canonical(doc);
          const expected = model.referenceTemplate.replace(VERSION_TOKEN, () =>
            JSON.stringify(action.version),
          );
          check(
            serialized === expected,
            "openapi-differs-from-reference-only-in-version",
            () => `version=${JSON.stringify(action.version)} doc=${serialized.slice(0, 300)}`,
          );
          check(
            stable(doc) === JSON.stringify(doc),
            "openapi-json-round-trip-lossless",
            () => "document contains undefined, non-finite numbers or bigint",
          );
          const operations = auditDocument(doc, strictBodies);
          bump(stats, "build");
          return `build:${action.version.length}:${operations}`;
        }
        case "convert_one": {
          const [name, schema] = SCHEMA_EXPORTS[action.index]!;
          const first = z.toJSONSchema(schema, { target: "draft-2020-12" });
          checkEqual(
            stable(z.toJSONSchema(schema, { target: "draft-2020-12" })),
            stable(first),
            `json-schema-deterministic:${name}`,
          );
          checkEqual(
            stable(JSON.parse(JSON.stringify(first))),
            stable(first),
            `json-schema-round-trip:${name}`,
          );
          bump(stats, "convert_one");
          return `convert:${name}`;
        }
        case "route_check": {
          const [route, method, where, schema] = ROUTE_SCHEMAS[action.index]!;
          const paths = model.reference["paths"] as Record<string, Record<string, Json>>;
          const operation = paths[route]?.[method];
          check(operation !== undefined, "documented-route-present", () => `${route} ${method}`);
          if (operation === undefined) return `route:${route}:missing`;
          const holder =
            where === "requestBody"
              ? (operation["requestBody"] as Json)
              : ((operation["responses"] as Record<string, Json>)["200"] as Json);
          const embedded = ((holder["content"] as Json)["application/json"] as Json)["schema"];
          checkEqual(
            stable(embedded),
            stable(z.toJSONSchema(schema, { target: "draft-2020-12" })),
            `embedded-schema-matches-export:${route}:${where}`,
          );
          bump(stats, "route_check");
          return `route:${route}:${where}`;
        }
      }
    },
  };
}

describe("api-contracts — seeded randomized long-run", () => {
  it(
    "ShotSyncPayload accepts legal payloads verbatim and rejects each corruption at its path",
    async () => {
      expectCampaignHeld(await runStressCampaign(makeShotCampaign()));
    },
    stressTestTimeoutMs(),
  );
  it(
    "request refinements hold their documented cross-field rules and bounds",
    async () => {
      expectCampaignHeld(await runStressCampaign(makeRefinementCampaign()));
    },
    stressTestTimeoutMs(),
  );
  it(
    "OpenAPI document is deterministic, honest about /v1 routes and mirrors the exported schemas",
    async () => {
      expectCampaignHeld(await runStressCampaign(makeOpenApiCampaign(false)));
    },
    stressTestTimeoutMs(),
  );
});

describe.skipIf(!process.env["STRESS_NEAR_LEGAL"])("api-contracts — near-legal probe", () => {
  it(
    "every 2xx response in the OpenAPI document declares a JSON body schema",
    async () => {
      expectCampaignHeld(await runStressCampaign(makeOpenApiCampaign(true)));
    },
    stressTestTimeoutMs(),
  );
});
