import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SHOT_TYPES } from "@pickle/shared-types";
import type { ShotAnalysis, ShotTypeSlug } from "@pickle/shared-types";
import {
  CAPTURE_ENVELOPE_VERSION_NOT_MEASURED,
  COORDINATE_SYSTEMS,
  DRILL_MAPPING_VERSION_UNRESOLVED,
  MODEL_RUNTIMES,
  MODEL_TASKS,
  POSE_SEQUENCE_FORMAT,
  POSE_SEQUENCE_SCHEMA_VERSION,
  explainAnalysisRun,
  parsePoseSequence,
  resolveStroke,
  serializePoseSequence,
  sha256Hex,
  toLegacyPoseFrames,
  type AnalysisRecord,
  type CanonicalPoseFrame,
  type ModelRef,
  type ModelRunRecord,
  type PoseSequence,
  type StrokeIdentity,
} from "../../src/index.js";
import {
  TIME_DRIFT_LIMIT_RATIO,
  between,
  fingerprint,
  heapLeakProblems,
  intBetween,
  mulberry32,
  nonFinitePaths,
  pick,
  readCampaignOptions,
  runCampaign,
  seedsFor,
  writeReport,
  type IterationResult,
  type Rng,
} from "../../../scoring/test/stress/leakProbe.js";

/**
 * LONG-RUN LEAK campaign for @pickle/swing-domain.
 *
 * Every iteration builds a seeded pose sequence (30–240 frames), round-trips
 * it through serialize → parse → toLegacyPoseFrames, hashes it, feeds a
 * seeded corruption of the wire JSON back to the parser (which must reject,
 * never repair), resolves a seeded stroke identity, and explains a seeded
 * AnalysisRecord (valid and deliberately broken variants). Heap, retained
 * outputs, handles and listeners are checked every 50 iterations; invocation
 * time drift across the run is measured.
 *
 * Full campaign (what the stress report was produced with):
 *   NODE_OPTIONS=--expose-gc STRESS_ITER=2000 STRESS_OUT=/tmp/swing-leak.json \
 *     pnpm --filter @pickle/swing-domain test -- test/stress
 * Replay one seed:  STRESS_SEEDS=<seed> pnpm --filter @pickle/swing-domain test -- test/stress
 */

const LANDMARKS = [
  "head",
  "left_shoulder",
  "right_shoulder",
  "left_elbow",
  "right_elbow",
  "left_wrist",
  "right_wrist",
  "left_hip",
  "right_hip",
  "left_knee",
  "right_knee",
  "left_ankle",
  "right_ankle",
  "left_heel",
  "right_heel",
  // outside the legacy vocabulary: must survive canonical round-trip, be dropped by the legacy projection
  "left_index",
  "right_index",
  "nose",
] as const;

const LEGACY_COUNT = 15;

type Corruption =
  | "truncate"
  | "non_monotonic"
  | "nan_landmark"
  | "empty_landmarks"
  | "bad_schema"
  | "bad_format"
  | "bad_coords"
  | "no_model_version"
  | "bad_video"
  | "frames_not_array";

const CORRUPTIONS: readonly Corruption[] = [
  "truncate",
  "non_monotonic",
  "nan_landmark",
  "empty_landmarks",
  "bad_schema",
  "bad_format",
  "bad_coords",
  "no_model_version",
  "bad_video",
  "frames_not_array",
];

interface SwingOutcome {
  frames: number;
  landmarksPerFrame: number;
  withZ: boolean;
  wireBytes: number;
  sha256: string;
  corruption: Corruption;
  corruptionCode: string | null;
  stroke: string;
  explanation: string;
  violations: string[];
}

function poseModel(rng: Rng): ModelRef {
  return {
    providerId: pick(rng, ["pose.apple-vision", "pose.mediapipe", "pose.future"]),
    modelVersion: `pose-${intBetween(rng, 1, 9)}`,
    runtime: pick(rng, MODEL_RUNTIMES),
    executionTarget: "on_device",
    artifactHash: rng() < 0.5 ? null : sha256Hex(`artifact-${intBetween(rng, 0, 1 << 20)}`),
  };
}

function synthSequence(rng: Rng): PoseSequence {
  const frameCount = intBetween(rng, 30, 240);
  const landmarkCount = intBetween(rng, 1, LANDMARKS.length);
  const withZ = rng() < 0.4;
  const fps = pick(rng, [24, 30, 60, 120]);
  const frames: CanonicalPoseFrame[] = [];
  let t = between(rng, 0, 50);
  for (let i = 0; i < frameCount; i += 1) {
    // Real capture: gaps are real, timestamps strictly increase, indices may skip.
    const skipped = rng() < 0.05 ? intBetween(rng, 1, 3) : 0;
    t += (1000 / fps) * (1 + skipped) + between(rng, 0, 0.5);
    frames.push({
      frameIndex: i + skipped,
      timestampMs: t,
      confidence: between(rng, 0, 1),
      landmarks: Array.from({ length: landmarkCount }, (_, k) => ({
        name: LANDMARKS[k]!,
        x: between(rng, -0.2, 1.2),
        y: between(rng, -0.2, 1.2),
        visibility: between(rng, 0, 1),
        ...(withZ ? { z: between(rng, -2, 2) } : {}),
      })),
    });
  }
  return {
    schemaVersion: POSE_SEQUENCE_SCHEMA_VERSION,
    format: POSE_SEQUENCE_FORMAT,
    coordinateSystem: pick(rng, COORDINATE_SYSTEMS),
    producedBy: poseModel(rng),
    video: { width: pick(rng, [720, 1080, 1920]), height: pick(rng, [1280, 1920, 1080]), fps },
    frames,
  };
}

function corruptWire(rng: Rng, wire: string, kind: Corruption): string {
  const parsed = JSON.parse(wire) as {
    schemaVersion: number;
    format: string;
    coordinateSystem: string;
    poseModelVersion: string;
    video: { w: number; h: number; fps: number };
    frames: Array<{ i: number; t: number; c: number; l: Array<Record<string, unknown>> }>;
  };
  const frameIdx = intBetween(rng, 1, parsed.frames.length - 1);
  switch (kind) {
    case "truncate":
      return wire.slice(0, intBetween(rng, 1, wire.length - 1));
    case "non_monotonic":
      parsed.frames[frameIdx]!.t = parsed.frames[frameIdx - 1]!.t - between(rng, 0, 10);
      break;
    case "nan_landmark": {
      const mark = parsed.frames[frameIdx]!.l[0]!;
      // JSON cannot carry NaN: emulate the wire a broken producer writes.
      return JSON.stringify(parsed).replace(
        `"x":${String(mark.x)}`,
        `"x":${pick(rng, ["null", '"1"', "true", "1e999"])}`,
      );
    }
    case "empty_landmarks":
      parsed.frames[frameIdx]!.l = [];
      break;
    case "bad_schema":
      parsed.schemaVersion = pick(rng, [0, 2, 99]);
      break;
    case "bad_format":
      parsed.format = "pickle.pose-sequence.v0";
      break;
    case "bad_coords":
      parsed.coordinateSystem = "screen_pixels";
      break;
    case "no_model_version":
      parsed.poseModelVersion = "";
      break;
    case "bad_video":
      parsed.video = { w: pick(rng, [0, -1]), h: 1080, fps: 30 };
      break;
    case "frames_not_array":
      (parsed as { frames: unknown }).frames = {};
      break;
  }
  return JSON.stringify(parsed);
}

const EXPECTED_CODE: Record<Corruption, string | null> = {
  truncate: null, // either not_json or a structural rejection — must simply fail
  non_monotonic: "pose_sequence.non_monotonic",
  nan_landmark: "pose_sequence.corrupt_landmark",
  empty_landmarks: "pose_sequence.corrupt_frame",
  bad_schema: "pose_sequence.unsupported_schema",
  bad_format: "pose_sequence.unsupported_format",
  bad_coords: "pose_sequence.unknown_coordinate_system",
  no_model_version: "pose_sequence.missing_model_version",
  bad_video: "pose_sequence.invalid_video",
  frames_not_array: "pose_sequence.invalid_frames",
};

function synthIdentity(rng: Rng): { identity: StrokeIdentity; threshold: number } {
  const declared: ShotTypeSlug | null = rng() < 0.5 ? pick(rng, SHOT_TYPES) : null;
  const predicted =
    rng() < 0.7
      ? {
          shotType: rng() < 0.15 ? ("unknown" as const) : pick(rng, SHOT_TYPES),
          confidence: between(rng, 0, 1),
          alternatives: [{ shotType: pick(rng, SHOT_TYPES), confidence: between(rng, 0, 1) }],
          producedBy: poseModel(rng),
        }
      : null;
  return { identity: { declared, predicted }, threshold: between(rng, 0.3, 0.95) };
}

type RecordVariant =
  | "valid"
  | "no_provenance"
  | "empty_field"
  | "bad_timestamp"
  | "no_providers"
  | "untracked_run"
  | "vector_mismatch";

const RECORD_VARIANTS: readonly RecordVariant[] = [
  "valid",
  "valid",
  "valid",
  "no_provenance",
  "empty_field",
  "bad_timestamp",
  "no_providers",
  "untracked_run",
  "vector_mismatch",
];

const EXPECTED_RECORD_CODE: Record<RecordVariant, string | null> = {
  valid: null,
  no_provenance: "provenance.missing",
  empty_field: "provenance.incomplete",
  bad_timestamp: "provenance.invalid_timestamp",
  no_providers: "provenance.no_providers",
  untracked_run: "provenance.model_run_untracked",
  vector_mismatch: "provenance.version_vector_mismatch",
};

function synthRecord(rng: Rng, variant: RecordVariant): AnalysisRecord {
  const at = `2026-0${intBetween(rng, 1, 9)}-1${intBetween(rng, 0, 9)}T0${intBetween(rng, 0, 9)}:00:00.000Z`;
  const providers: ModelRef[] = Array.from({ length: intBetween(rng, 1, 5) }, () => poseModel(rng));
  const scoreVersion = `sm-v${intBetween(rng, 1, 3)}`;
  const runs: ModelRunRecord[] = providers.map((model, i) => ({
    id: `run-${i}`,
    task: pick(rng, MODEL_TASKS),
    model,
    inputSchemaVersion: 1,
    outputSchemaVersion: 1,
    startedAtIso: at,
    completedAtIso: at,
    status: pick(rng, ["succeeded", "failed", "abstained"] as const),
    failure: null,
  }));
  const scored = rng() < 0.7;
  const shotType = pick(rng, SHOT_TYPES);
  const result: ShotAnalysis | null = scored
    ? {
        id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        sessionId: null,
        shotType,
        cameraView: "side",
        handedness: "right",
        capturedAtIso: at,
        timestamps: { startMs: 0, contactMs: 450, endMs: 900 },
        phases: [],
        measurements: [],
        checkpoints: [],
        overallScore: Math.round(between(rng, 0, 10) * 10) / 10,
        analysisConfidence: between(rng, 0.65, 1),
        resultKind: "scored",
        guidance: null,
        priorityFix: null,
        versionVector: {
          appVersion: "0.1.0",
          modelBundleVersion: "on-device-fusion-1",
          poseModelVersion: providers[0]!.modelVersion,
          paddleModelVersion: "paddle-none-0",
          strokeDetectorVersion: "temporal-stroke-heuristic-2",
          phaseModelVersion: "phase-1",
          scoringModelVersion:
            variant === "vector_mismatch" ? `${scoreVersion}-other` : scoreVersion,
          shotConfigVersion: `${shotType}@1`,
        },
        source: "real",
      }
    : null;
  const record: AnalysisRecord = {
    schemaVersion: 1,
    id: `analysis-${intBetween(rng, 0, 1 << 30)}`,
    captureId: `capture-${intBetween(rng, 0, 1 << 30)}`,
    createdAtIso: at,
    engineVersion: "fusion-1",
    strokeTaxonomyVersion: "pickleball-taxonomy-v2",
    strokeResolution: { kind: "declared", shotType },
    modalities: { pose: true, paddle: false, ball: false, court: false, camera: false },
    modelRuns:
      variant === "untracked_run" ? [...runs, { ...runs[0]!, model: poseModel(rng) }] : runs,
    provenance: {
      appVersion: "0.1.0",
      pipelineVersion: variant === "empty_field" ? "" : "fusion-1",
      providerVersions: variant === "no_providers" ? [] : providers,
      scoreVersion,
      taxonomyVersion: "pickleball-taxonomy-v2",
      drillMappingVersion: DRILL_MAPPING_VERSION_UNRESOLVED,
      captureEnvelopeVersion: CAPTURE_ENVELOPE_VERSION_NOT_MEASURED,
      recordedAtIso: variant === "bad_timestamp" ? "yesterday" : at,
    },
    result,
    faults: [],
    uncertainty: {
      analysisConfidence: result?.analysisConfidence ?? 0.2,
      presentation: result ? "normal" : "abstain",
      perCheckpoint: {},
      limitingFactors: [],
    },
    evidence: [],
    shadow: [],
  };
  if (variant === "vector_mismatch" && !result) {
    // The mismatch can only surface on a scored record; force one.
    return synthRecord(mulberry32(intBetween(rng, 0, 1 << 30)), variant);
  }
  const stored = JSON.parse(JSON.stringify(record)) as AnalysisRecord;
  if (variant === "no_provenance") {
    delete (stored as Partial<AnalysisRecord>).provenance;
  }
  return stored;
}

function untrackedIsDistinct(record: AnalysisRecord): boolean {
  const known = new Set(
    record.provenance.providerVersions.map((m) => `${m.providerId}@${m.modelVersion}`),
  );
  return record.modelRuns.some((r) => !known.has(`${r.model.providerId}@${r.model.modelVersion}`));
}

async function iterate(seed: number): Promise<IterationResult<SwingOutcome>> {
  const rng = mulberry32(seed);
  const violations: string[] = [];
  const retain: object[] = [];

  // ── pose sequence round-trip ──────────────────────────────────────────
  const sequence = synthSequence(rng);
  const wire = serializePoseSequence(sequence);
  const wireAgain = serializePoseSequence(sequence);
  if (wire !== wireAgain) violations.push("serialize non-deterministic");
  const producedBy = {
    providerId: sequence.producedBy.providerId,
    runtime: sequence.producedBy.runtime,
    executionTarget: sequence.producedBy.executionTarget,
    artifactHash: sequence.producedBy.artifactHash,
  };
  const parsed = parsePoseSequence(wire, producedBy);
  if (!parsed.ok) {
    violations.push(`valid wire rejected: ${parsed.failure.code}`);
  } else {
    if (fingerprint(parsed.value) !== fingerprint(sequence)) {
      violations.push("round-trip changed the sequence");
    }
    for (const path of nonFinitePaths(parsed.value)) violations.push(`non-finite ${path}`);
    const legacy = toLegacyPoseFrames(parsed.value);
    if (legacy.length !== sequence.frames.length) violations.push("legacy frame count differs");
    const expectedLegacyMarks = Math.min(sequence.frames[0]!.landmarks.length, LEGACY_COUNT);
    for (const frame of legacy) {
      if (frame.landmarks.length !== expectedLegacyMarks) {
        violations.push(
          `legacy projection kept ${frame.landmarks.length}, expected ${expectedLegacyMarks}`,
        );
        break;
      }
      if (frame.landmarks.some((m) => "z" in m)) {
        violations.push("legacy projection leaked z");
        break;
      }
    }
    for (let i = 1; i < parsed.value.frames.length; i += 1) {
      if (parsed.value.frames[i]!.timestampMs <= parsed.value.frames[i - 1]!.timestampMs) {
        violations.push("parsed frames not strictly increasing");
        break;
      }
    }
    retain.push(parsed.value, legacy);
  }

  const digest = sha256Hex(wire);
  if (digest !== createHash("sha256").update(wire, "utf8").digest("hex")) {
    violations.push("sha256Hex disagrees with node:crypto");
  }
  if (sha256Hex(wire) !== digest) violations.push("sha256Hex non-deterministic");

  // ── seeded corruption must be rejected, never repaired ────────────────
  const corruption = pick(rng, CORRUPTIONS);
  const corrupted = corruptWire(rng, wire, corruption);
  const rejected = parsePoseSequence(corrupted, producedBy);
  let corruptionCode: string | null = null;
  if (rejected.ok) {
    if (corruption === "truncate" && corrupted === wire) {
      // slicing at full length cannot happen (upper bound is length-1); defensive
      violations.push("truncate produced identical wire");
    } else {
      violations.push(`corrupted wire (${corruption}) accepted`);
    }
  } else {
    corruptionCode = rejected.failure.code;
    if (rejected.failure.kind !== "corrupted_media") {
      violations.push(`corruption failure kind ${rejected.failure.kind}`);
    }
    const expected = EXPECTED_CODE[corruption];
    if (expected !== null && corruptionCode !== expected) {
      violations.push(`corruption ${corruption} → ${corruptionCode}, expected ${expected}`);
    }
    retain.push(rejected);
  }

  // ── stroke resolution policy ──────────────────────────────────────────
  const { identity, threshold } = synthIdentity(rng);
  const resolution = resolveStroke(identity, { predictionConfidenceThreshold: threshold });
  const p = identity.predicted;
  const expectedKind =
    p && p.shotType !== "unknown" && p.confidence >= threshold
      ? "predicted"
      : identity.declared !== null
        ? "declared"
        : "unresolved";
  if (resolution.kind !== expectedKind) {
    violations.push(`resolveStroke ${resolution.kind}, expected ${expectedKind}`);
  }
  if (resolution.kind === "predicted" && resolution.shotType !== p?.shotType) {
    violations.push("predicted resolution carries wrong shot type");
  }
  if (resolution.kind === "declared" && resolution.shotType !== identity.declared) {
    violations.push("declared resolution carries wrong shot type");
  }
  if (
    fingerprint(resolveStroke(identity, { predictionConfidenceThreshold: threshold })) !==
    fingerprint(resolution)
  ) {
    violations.push("resolveStroke non-deterministic");
  }
  retain.push(resolution);

  // ── analysis-run explanation from storage alone ───────────────────────
  const variant = pick(rng, RECORD_VARIANTS);
  const record = synthRecord(rng, variant);
  const explained = explainAnalysisRun(record);
  let explanation: string;
  if (variant === "untracked_run" && !untrackedIsDistinct(record)) {
    // The seeded "untracked" model collided with a tracked one — then the
    // record IS fully tracked and must explain.
    explanation = explained.ok ? "ok(collision)" : explained.failure.code;
    if (!explained.ok) violations.push("fully tracked record failed to explain");
  } else {
    const expectedCode = EXPECTED_RECORD_CODE[variant];
    if (expectedCode === null) {
      if (!explained.ok) {
        violations.push(`valid record unexplained: ${explained.failure.code}`);
        explanation = explained.failure.code;
      } else {
        explanation = "ok";
        const ex = explained.value;
        if (ex.executions.length !== record.modelRuns.length) violations.push("executions dropped");
        if (ex.scored !== (record.result !== null)) violations.push("scored flag wrong");
        if (ex.overallScore !== (record.result?.overallScore ?? null)) {
          violations.push("overallScore not carried");
        }
        for (const path of nonFinitePaths(ex)) violations.push(`explanation non-finite ${path}`);
        if (fingerprint(explainAnalysisRun(record)) !== fingerprint(explained)) {
          violations.push("explainAnalysisRun non-deterministic");
        }
      }
    } else if (explained.ok) {
      explanation = "ok";
      violations.push(`broken record (${variant}) explained as valid`);
    } else {
      explanation = explained.failure.code;
      if (explained.failure.code !== expectedCode) {
        violations.push(`record ${variant} → ${explained.failure.code}, expected ${expectedCode}`);
      }
    }
  }
  retain.push(record, explained);

  const outcome: SwingOutcome = {
    frames: sequence.frames.length,
    landmarksPerFrame: sequence.frames[0]!.landmarks.length,
    withZ: sequence.frames[0]!.landmarks[0]!.z !== undefined,
    wireBytes: wire.length,
    sha256: digest.slice(0, 16),
    corruption,
    corruptionCode,
    stroke: resolution.kind,
    explanation,
    violations,
  };
  return { outcome, violations, retain };
}

describe("@pickle/swing-domain long-run leak campaign", () => {
  const options = readCampaignOptions();
  const seeds = seedsFor(options);

  it(
    `round-trips, hashes, resolves and explains ${seeds.length}× in one process without leaking, drifting or breaking invariants`,
    async () => {
      const report = await runCampaign<SwingOutcome>({
        unit: "@pickle/swing-domain serialization + sha256 + resolveStroke + explainAnalysisRun",
        options,
        seeds,
        iterate,
      });
      writeReport(options.outPath, report);

      const broken = report.results.filter((r) => r.outcome.violations.length > 0);
      expect(
        broken.map((r) => ({ seed: r.seed, violations: r.outcome.violations })),
        "seeds with invariant violations",
      ).toEqual([]);
      expect(report.iterationsExecuted).toBe(seeds.length);
      expect(report.handleProblems, "handle/listener drift").toEqual([]);
      expect(report.timing.driftRatio, "late/early median invocation time").toBeLessThanOrEqual(
        TIME_DRIFT_LIMIT_RATIO,
      );
      if (options.explicit) {
        expect(report.gcExposed, "campaign requires NODE_OPTIONS=--expose-gc").toBe(true);
      }
      if (report.gcExposed && report.heapTrend.measured) {
        expect(heapLeakProblems(report.heapTrend), "heap after forced GC").toEqual([]);
      }
    },
    10 * 60 * 1000,
  );
});
