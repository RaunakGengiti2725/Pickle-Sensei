/**
 * Seeded randomized long-run stress model for @pickle/swing-domain.
 *
 * A plan of legal / near-legal / hostile actions over the public API is
 * derived from a 32-bit seed, executed against the real package with an
 * oracle model (artifact store of serialized pose sequences and their
 * integrity refs), invariants are checked after every step and the outputs
 * are folded into a canonical trace for the determinism comparison.
 *
 * Invariants (ids referenced by the JSON result table):
 *   W1  serializePoseSequence is deterministic and never throws
 *   W2  parse(serialize(x)) succeeds and equals x (producedBy re-attached);
 *       serialize∘parse∘serialize is a fixed point
 *   W3  toLegacyPoseFrames keeps frame count / timestamps / confidence and only
 *       legacy landmark names, with values preserved
 *   W4  no NaN/Infinity in any parsed output for finite inputs
 *   M1  a single corruption of a valid wire document is rejected with exactly
 *       the documented failure code and kind "corrupted_media"
 *   M2  parsePoseSequence never throws (even for hostile text)
 *   M3  parsePoseSequence is deterministic
 *   I1  stored artifact integrity: sha256Hex(wire) equals the stored ref hash,
 *       frameCount / coordinateSystem / poseModelVersion match after reload
 *   H1  sha256Hex matches node:crypto SHA-256 over UTF-8 (well-formed strings)
 *   H2  sha256Hex output is 64 lowercase hex chars and deterministic
 *   H3  the fallback UTF-8 encoder (no TextEncoder) hashes identically to the
 *       TextEncoder path
 *   R1  resolveStroke follows the documented policy exactly; the resolved shot
 *       type is never "unknown"; predicted confidence is echoed unchanged
 *   E1  explainAnalysisRun fails with the documented code for each defect and
 *       succeeds (with executions mirroring modelRuns) for complete records
 *   E2  timestamps that are not ISO-8601 instants are rejected
 *       (provenance.invalid_timestamp)
 *   D1  measured()/unavailable() build the documented discriminated union
 */
import { createHash } from "node:crypto";
import type { ShotAnalysis } from "@pickle/shared-types";
import { SHOT_TYPES, type ShotTypeSlug } from "@pickle/shared-types";
import {
  CAPTURE_ENVELOPE_VERSION_NOT_MEASURED,
  COORDINATE_SYSTEMS,
  explainAnalysisRun,
  measured,
  MODEL_RUNTIMES,
  MODEL_TASKS,
  parsePoseSequence,
  POSE_SEQUENCE_FORMAT,
  POSE_SEQUENCE_SCHEMA_VERSION,
  resolveStroke,
  serializePoseSequence,
  sha256Hex,
  toLegacyPoseFrames,
  unavailable,
  type AnalysisRecord,
  type AnalysisRunProvenance,
  type CanonicalPoseFrame,
  type ModelRef,
  type ModelRunRecord,
  type PoseSequence,
  type StrokeIdentity,
} from "../../src/index.js";
import { canonicalJson, SeededRng } from "./rng.js";

export type InputClass = "legal" | "near_legal" | "hostile";

export type Mutation =
  | "schema_version"
  | "format"
  | "coordinate_system"
  | "model_version"
  | "video"
  | "frames_not_array"
  | "frame_not_object"
  | "frame_fields"
  | "non_monotonic"
  | "no_landmarks"
  | "landmark"
  | "not_json"
  | "not_object";

export type SwingAction =
  | { kind: "pose_roundtrip"; sequence: PoseSequence; inputClass: InputClass }
  | { kind: "store_pose"; sequence: PoseSequence; inputClass: InputClass }
  | { kind: "load_pose"; index: number; inputClass: InputClass }
  | {
      kind: "pose_mutate";
      wire: string;
      mutation: Mutation;
      expectedCode: string;
      inputClass: InputClass;
    }
  | { kind: "sha"; inputs: string[]; fallback: boolean; inputClass: InputClass }
  | {
      kind: "resolve";
      identity: StrokeIdentity;
      threshold: number;
      inputClass: InputClass;
    }
  | { kind: "explain"; record: AnalysisRecord; defect: ExplainDefect; inputClass: InputClass }
  | { kind: "modality"; payload: unknown; reason: string; inputClass: InputClass };

export type ExplainDefect =
  | { type: "none" }
  | { type: "provenance_missing" }
  | { type: "incomplete"; fields: string[] }
  | { type: "timestamp"; value: string; iso: boolean }
  | { type: "no_providers" }
  | { type: "untracked_run"; key: string }
  | { type: "vector_mismatch"; field: "appVersion" | "scoringModelVersion" };

export interface SwingPlan {
  seed: number;
  length: number;
  actions: SwingAction[];
}

const LEGACY_LANDMARKS = [
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
] as const;
const EXTRA_LANDMARKS = ["nose", "left_eye", "右手", "pied_gauche", "🏓", "left_index"] as const;
const LEGACY_SET: ReadonlySet<string> = new Set(LEGACY_LANDMARKS);

const PRODUCER: Omit<ModelRef, "modelVersion"> = {
  providerId: "pose.apple-vision",
  runtime: "vision_framework",
  executionTarget: "on_device",
  artifactHash: null,
};

function iso(rng: SeededRng): string {
  const base = Date.UTC(2026, 0, 1);
  return new Date(base + rng.int(0, 300) * 86_400_000 + rng.int(0, 86_399_999)).toISOString();
}

function finiteValue(rng: SeededRng, cls: InputClass): number {
  if (cls === "near_legal") {
    return rng.weighted<number>([
      [2, 0],
      [2, 1],
      [2, -1],
      [1, 1e300],
      [1, -1e300],
      [1, Number.MIN_VALUE],
      [1, Number.MAX_SAFE_INTEGER],
      [1, 0.1 + 0.2],
      [1, rng.range(-1e6, 1e6)],
    ]);
  }
  return rng.range(-2, 2);
}

function genSequence(rng: SeededRng, cls: InputClass): PoseSequence {
  const frameCount =
    cls === "near_legal"
      ? rng.weighted([
          [2, 0],
          [2, 1],
          [3, rng.int(2, 40)],
        ])
      : rng.int(1, 30);
  const landmarkPool = [...LEGACY_LANDMARKS, ...(cls === "legal" ? [] : EXTRA_LANDMARKS)];
  let t = cls === "near_legal" ? rng.pick([-1e6, 0, 0.5, 1e12]) : rng.range(0, 1000);
  const frames: CanonicalPoseFrame[] = [];
  const withZ = rng.chance(0.4);
  for (let i = 0; i < frameCount; i++) {
    const count =
      cls === "near_legal"
        ? rng.pick([1, 2, landmarkPool.length])
        : rng.int(3, landmarkPool.length);
    const names = rng.shuffle(landmarkPool).slice(0, count);
    frames.push({
      frameIndex: cls === "near_legal" ? rng.pick([i, -i, 0, 1e15]) : i,
      timestampMs: t,
      confidence: cls === "near_legal" ? rng.pick([0, 1, 1e-12]) : rng.range(0, 1),
      landmarks: names.map((name) => ({
        name,
        x: finiteValue(rng, cls),
        y: finiteValue(rng, cls),
        visibility: cls === "near_legal" ? rng.pick([0, 1]) : rng.range(0, 1),
        ...(withZ && rng.chance(0.8) ? { z: finiteValue(rng, cls) } : {}),
      })),
    });
    const inc = cls === "near_legal" ? rng.pick([5e-24, 1e-9, 1, 1e9]) : rng.range(1, 40);
    let next = t + inc;
    // keep the sequence strictly monotonic even when `inc` underflows at this magnitude
    if (!(next > t)) next = t + Math.max(1, Math.abs(t) * Number.EPSILON * 2);
    t = next;
  }
  return {
    schemaVersion: POSE_SEQUENCE_SCHEMA_VERSION,
    format: POSE_SEQUENCE_FORMAT,
    coordinateSystem: rng.pick(COORDINATE_SYSTEMS),
    producedBy: {
      ...PRODUCER,
      modelVersion:
        cls === "near_legal"
          ? rng.pick(["v", "apple-vision-bodypose-1", "✓ 1.0"])
          : "apple-vision-bodypose-1",
    },
    video:
      cls === "near_legal"
        ? { width: rng.pick([1, 1e9]), height: rng.pick([1, 7680]), fps: rng.pick([1e-9, 240]) }
        : { width: 1080, height: 1920, fps: rng.pick([30, 60, 120]) },
    frames,
  };
}

type Json = Record<string, unknown>;

function mutateWire(
  rng: SeededRng,
  wire: string,
): { wire: string; mutation: Mutation; expectedCode: string } {
  const doc = JSON.parse(wire) as Json;
  const frames = doc.frames as Json[];
  const candidates: Mutation[] = [
    "schema_version",
    "format",
    "coordinate_system",
    "model_version",
    "video",
    "frames_not_array",
    "not_json",
    "not_object",
  ];
  if (frames.length >= 1)
    candidates.push("frame_not_object", "frame_fields", "no_landmarks", "landmark");
  if (frames.length >= 2) candidates.push("non_monotonic");
  const mutation = rng.pick(candidates);
  const k = frames.length > 0 ? rng.int(0, frames.length - 1) : 0;
  switch (mutation) {
    case "schema_version":
      doc.schemaVersion = rng.pick([2, 0, "1", null, undefined]);
      return {
        wire: JSON.stringify(doc),
        mutation,
        expectedCode: "pose_sequence.unsupported_schema",
      };
    case "format":
      doc.format = rng.pick(["pickle.pose-sequence.v2", "", null, 1]);
      return {
        wire: JSON.stringify(doc),
        mutation,
        expectedCode: "pose_sequence.unsupported_format",
      };
    case "coordinate_system":
      doc.coordinateSystem = rng.pick(["pixels", "", null, "Normalized_Image_Top_Left"]);
      return {
        wire: JSON.stringify(doc),
        mutation,
        expectedCode: "pose_sequence.unknown_coordinate_system",
      };
    case "model_version":
      doc.poseModelVersion = rng.pick(["", null, 5, undefined]);
      return {
        wire: JSON.stringify(doc),
        mutation,
        expectedCode: "pose_sequence.missing_model_version",
      };
    case "video": {
      const video = doc.video as Json;
      const field = rng.pick(["w", "h", "fps"]);
      const variant = rng.int(0, 4);
      if (variant === 0) doc.video = null;
      else if (variant === 1) delete video[field];
      else if (variant === 2) video[field] = rng.pick([0, -1, -1e-9]);
      else if (variant === 3) video[field] = rng.pick(["1080", true, null]);
      else doc.video = "1080x1920";
      return { wire: JSON.stringify(doc), mutation, expectedCode: "pose_sequence.invalid_video" };
    }
    case "frames_not_array":
      doc.frames = rng.pick([null, {}, "[]", 3, undefined]);
      return { wire: JSON.stringify(doc), mutation, expectedCode: "pose_sequence.invalid_frames" };
    case "frame_not_object":
      frames[k] = rng.pick([null, 3, "frame", true]) as unknown as Json;
      return { wire: JSON.stringify(doc), mutation, expectedCode: "pose_sequence.corrupt_frame" };
    case "frame_fields": {
      const frame = frames[k]!;
      const variant = rng.int(0, 4);
      if (variant === 0) frame.t = rng.pick(["1", null, true]);
      else if (variant === 1) frame.c = rng.pick(["0.5", null]);
      else if (variant === 2) frame.i = rng.pick([1.5, "1", null, -0.5]);
      else if (variant === 3) delete frame.t;
      else delete frame.i;
      return { wire: JSON.stringify(doc), mutation, expectedCode: "pose_sequence.corrupt_frame" };
    }
    case "non_monotonic": {
      const j = Math.max(1, k);
      const prev = frames[j - 1]!.t as number;
      frames[j]!.t = rng.chance(0.5) ? prev : prev - rng.range(0, 10);
      return { wire: JSON.stringify(doc), mutation, expectedCode: "pose_sequence.non_monotonic" };
    }
    case "no_landmarks":
      frames[k]!.l = rng.pick([[], {}, null, "none"]);
      return { wire: JSON.stringify(doc), mutation, expectedCode: "pose_sequence.corrupt_frame" };
    case "landmark": {
      const marks = frames[k]!.l as Json[];
      const m = rng.int(0, marks.length - 1);
      const variant = rng.int(0, 5);
      if (variant === 0) marks[m] = null as unknown as Json;
      else if (variant === 1) marks[m]!.n = rng.pick(["", 1, null]);
      else if (variant === 2) marks[m]!.x = rng.pick(["0.1", null, true]);
      else if (variant === 3) marks[m]!.v = rng.pick(["1", null]);
      else if (variant === 4) marks[m]!.z = rng.pick(["0", null, {}]);
      else delete marks[m]!.y;
      return {
        wire: JSON.stringify(doc),
        mutation,
        expectedCode: "pose_sequence.corrupt_landmark",
      };
    }
    case "not_json": {
      const variant = rng.int(0, 2);
      const text =
        variant === 0
          ? wire.slice(0, rng.int(0, Math.max(0, wire.length - 1)))
          : variant === 1
            ? `garbage${wire}`
            : wire.replace(/"/, "'");
      return { wire: text, mutation, expectedCode: "pose_sequence.not_json" };
    }
    case "not_object":
      return {
        wire: rng.pick(["null", "3", '"sequence"', "true"]),
        mutation,
        expectedCode: "pose_sequence.not_object",
      };
  }
}

function genShaInput(rng: SeededRng, cls: InputClass): string {
  const boundary = rng.pick([0, 1, 3, 55, 56, 57, 63, 64, 65, 111, 119, 120, 127, 128, 500, 2000]);
  const length = rng.chance(0.5) ? boundary : rng.int(0, 300);
  let out = "";
  for (let i = 0; i < length; i++) {
    if (cls === "legal") {
      out += String.fromCharCode(rng.int(0x20, 0x7e));
    } else if (cls === "near_legal") {
      out += rng.weighted<string>([
        [3, String.fromCharCode(rng.int(0x20, 0x7e))],
        [2, String.fromCharCode(rng.int(0x80, 0x7ff))],
        [2, String.fromCharCode(rng.int(0x800, 0xd7ff))],
        [2, String.fromCodePoint(rng.int(0x10000, 0x10ffff))],
        [1, "\u0000"],
        [1, "e\u0301"],
      ]);
    } else {
      // lone surrogates: valid JS strings that are not well-formed Unicode
      out += rng.weighted<string>([
        [2, String.fromCharCode(rng.int(0x20, 0x7e))],
        [1, String.fromCharCode(rng.int(0xd800, 0xdbff))],
        [1, String.fromCharCode(rng.int(0xdc00, 0xdfff))],
      ]);
    }
  }
  if (cls === "hostile" && out.split("").every((c) => c.charCodeAt(0) < 0xd800)) out += "\ud83c";
  return out;
}

const NON_ISO_TIMESTAMPS = [
  "1",
  "12/25/2026",
  "Jan 5 2026",
  "2026-02-30T00:00:00Z",
  "yesterday",
  "2026-13-45T00:00:00Z",
  " 2026-01-01T00:00:00Z",
];

function modelRef(providerId: string, modelVersion: string, rng: SeededRng): ModelRef {
  return {
    providerId,
    modelVersion,
    runtime: rng.pick(MODEL_RUNTIMES),
    executionTarget: rng.pick(["on_device", "server", "hybrid"] as const),
    artifactHash: rng.chance(0.5) ? null : `sha256:${rng.int(0, 1e9).toString(16)}`,
  };
}

function genRecord(
  rng: SeededRng,
  cls: InputClass,
): { record: AnalysisRecord; defect: ExplainDefect } {
  const at = iso(rng);
  const providers = Array.from({ length: rng.int(1, 4) }, (_, i) =>
    modelRef(`provider.${i}`, `v${rng.int(1, 5)}`, rng),
  );
  const scoreVersion = rng.pick(["sm-v1", "sm-v2"]);
  const appVersion = rng.pick(["0.1.0", "1.2.3"]);
  const provenance: AnalysisRunProvenance = {
    appVersion,
    pipelineVersion: "fusion-1",
    providerVersions: providers,
    scoreVersion,
    taxonomyVersion: "pickleball-taxonomy-v2",
    drillMappingVersion: rng.pick(["none", "drills-v3"]),
    captureEnvelopeVersion: rng.pick([CAPTURE_ENVELOPE_VERSION_NOT_MEASURED, "envelope-2"]),
    recordedAtIso: at,
  };
  const modelRuns: ModelRunRecord[] = Array.from({ length: rng.int(0, 5) }, (_, i) => {
    const model = rng.pick(providers);
    return {
      id: `run-${i}`,
      task: rng.pick(MODEL_TASKS),
      model,
      inputSchemaVersion: 1,
      outputSchemaVersion: 1,
      startedAtIso: at,
      completedAtIso: at,
      status: rng.pick(["succeeded", "failed", "abstained"] as const),
      failure: null,
    };
  });
  const scored = rng.chance(0.6);
  const result: ShotAnalysis | null = rng.chance(0.25)
    ? null
    : {
        id: `analysis-${rng.int(0, 1e6)}`,
        sessionId: null,
        shotType: rng.pick(SHOT_TYPES),
        cameraView: "side",
        handedness: "right",
        capturedAtIso: at,
        timestamps: { startMs: 0, contactMs: 450, endMs: 900 },
        phases: [],
        measurements: [],
        checkpoints: [],
        overallScore: scored ? Math.round(rng.range(0, 10) * 10) / 10 : null,
        analysisConfidence: rng.range(0, 1),
        resultKind: scored ? "scored" : "low_confidence",
        guidance: null,
        priorityFix: null,
        versionVector: {
          appVersion,
          modelBundleVersion: "on-device-fusion-1",
          poseModelVersion: "apple-vision-bodypose-1",
          paddleModelVersion: "none",
          strokeDetectorVersion: "none",
          phaseModelVersion: "none",
          scoringModelVersion: scoreVersion,
          shotConfigVersion: "shot-config-v1",
        },
        source: "real",
      };
  const record: AnalysisRecord = {
    schemaVersion: 1,
    id: `record-${rng.int(0, 1e6)}`,
    captureId: `capture-${rng.int(0, 1e6)}`,
    createdAtIso: at,
    engineVersion: "fusion-1",
    strokeTaxonomyVersion: "pickleball-taxonomy-v2",
    strokeResolution: { kind: "declared", shotType: "dink" },
    modalities: { pose: true, paddle: false, ball: false, court: false, camera: false },
    modelRuns,
    provenance,
    result,
    faults: [],
    uncertainty: {
      analysisConfidence: 0.5,
      presentation: "normal",
      perCheckpoint: {},
      limitingFactors: [],
    },
    evidence: [],
    shadow: [],
  };
  if (cls === "legal") return { record, defect: { type: "none" } };
  const defect = rng.weighted<ExplainDefect["type"]>([
    [2, "none"],
    [2, "provenance_missing"],
    [3, "incomplete"],
    [3, "timestamp"],
    [2, "no_providers"],
    [3, "untracked_run"],
    [3, "vector_mismatch"],
  ]);
  switch (defect) {
    case "none":
      return { record, defect: { type: "none" } };
    case "provenance_missing": {
      const stripped = { ...record } as Partial<AnalysisRecord>;
      if (rng.chance(0.5)) delete stripped.provenance;
      else (stripped as Json).provenance = null;
      return { record: stripped as AnalysisRecord, defect: { type: "provenance_missing" } };
    }
    case "incomplete": {
      const fields = rng
        .shuffle([
          "appVersion",
          "pipelineVersion",
          "scoreVersion",
          "taxonomyVersion",
          "drillMappingVersion",
          "captureEnvelopeVersion",
          "recordedAtIso",
        ])
        .slice(0, rng.int(1, 3));
      const broken = { ...provenance } as Json;
      for (const f of fields) broken[f] = rng.pick(["", null, undefined, 3]);
      return {
        record: { ...record, provenance: broken as unknown as AnalysisRunProvenance },
        defect: { type: "incomplete", fields },
      };
    }
    case "timestamp": {
      const value = rng.pick(NON_ISO_TIMESTAMPS);
      return {
        record: { ...record, provenance: { ...provenance, recordedAtIso: value } },
        defect: { type: "timestamp", value, iso: false },
      };
    }
    case "no_providers":
      return {
        record: { ...record, provenance: { ...provenance, providerVersions: [] } },
        defect: { type: "no_providers" },
      };
    case "untracked_run": {
      const ghost = modelRef("provider.ghost", "v9", rng);
      const run: ModelRunRecord = {
        ...(modelRuns[0] ?? {
          id: "run-x",
          task: "pose_estimation",
          inputSchemaVersion: 1,
          outputSchemaVersion: 1,
          startedAtIso: at,
          completedAtIso: at,
          status: "succeeded",
          failure: null,
        }),
        id: "run-ghost",
        model: rng.chance(0.5) ? ghost : { ...providers[0]!, modelVersion: "v-other" },
      };
      return {
        record: { ...record, modelRuns: [...modelRuns, run] },
        defect: { type: "untracked_run", key: `${run.model.providerId}@${run.model.modelVersion}` },
      };
    }
    case "vector_mismatch": {
      if (!result) return { record, defect: { type: "none" } };
      const field = rng.pick(["appVersion", "scoringModelVersion"] as const);
      const vector = { ...result.versionVector, [field]: `${result.versionVector[field]}-x` };
      return {
        record: { ...record, result: { ...result, versionVector: vector } },
        defect: { type: "vector_mismatch", field },
      };
    }
  }
}

function pickClass(rng: SeededRng): InputClass {
  return rng.weighted<InputClass>([
    [6, "legal"],
    [3, "near_legal"],
    [1, "hostile"],
  ]);
}

class PlanState {
  stored = 0;
}

function genAction(rng: SeededRng, st: PlanState): SwingAction {
  const cls = pickClass(rng);
  const kind = rng.weighted<SwingAction["kind"]>([
    [18, "pose_roundtrip"],
    [8, "store_pose"],
    [st.stored > 0 ? 8 : 0, "load_pose"],
    [18, "pose_mutate"],
    [14, "sha"],
    [10, "resolve"],
    [16, "explain"],
    [3, "modality"],
  ]);
  switch (kind) {
    case "pose_roundtrip":
      return {
        kind,
        sequence: genSequence(rng, cls === "hostile" ? "near_legal" : cls),
        inputClass: cls === "hostile" ? "near_legal" : cls,
      };
    case "store_pose":
      st.stored++;
      return {
        kind,
        sequence: genSequence(rng, cls === "hostile" ? "near_legal" : cls),
        inputClass: cls === "hostile" ? "near_legal" : cls,
      };
    case "load_pose":
      return { kind, index: rng.int(0, st.stored - 1), inputClass: "legal" };
    case "pose_mutate": {
      const wire = serializePoseSequence(genSequence(rng, cls === "hostile" ? "near_legal" : cls));
      const m = mutateWire(rng, wire);
      return {
        kind,
        wire: m.wire,
        mutation: m.mutation,
        expectedCode: m.expectedCode,
        inputClass: cls === "legal" ? "near_legal" : cls,
      };
    }
    case "sha":
      return {
        kind,
        inputs: Array.from({ length: rng.int(1, 4) }, () => genShaInput(rng, cls)),
        fallback: rng.chance(0.35),
        inputClass: cls,
      };
    case "resolve": {
      const threshold = cls === "legal" ? rng.range(0.3, 0.95) : rng.pick([0, 1, 0.5, -1, 2]);
      const confidence =
        cls === "legal"
          ? rng.range(0, 1)
          : rng.pick([
              threshold,
              threshold - Number.EPSILON,
              threshold + Number.EPSILON,
              0,
              1,
              Number.NaN,
              Number.POSITIVE_INFINITY,
            ]);
      const predicted = rng.chance(0.25)
        ? null
        : {
            shotType: rng.chance(0.15) ? ("unknown" as const) : rng.pick(SHOT_TYPES),
            confidence,
            alternatives: [],
            producedBy: modelRef("stroke.classifier", "v1", rng),
          };
      const identity: StrokeIdentity = {
        declared: rng.chance(0.5) ? null : rng.pick(SHOT_TYPES),
        predicted,
      };
      return {
        kind,
        identity,
        threshold,
        inputClass: Number.isFinite(confidence)
          ? cls === "hostile"
            ? "near_legal"
            : cls
          : "hostile",
      };
    }
    case "explain": {
      const g = genRecord(rng, cls === "hostile" ? "near_legal" : cls);
      return {
        kind,
        record: g.record,
        defect: g.defect,
        inputClass: g.defect.type === "none" ? "legal" : "near_legal",
      };
    }
    case "modality":
      return {
        kind,
        payload: rng.pick([1, "x", null, { a: [1, 2] }, []]),
        reason: rng.pick(["paddle not visible", ""]),
        inputClass: cls === "hostile" ? "near_legal" : cls,
      };
  }
}

export function generatePlan(seed: number, minLen = 5, maxLen = 60): SwingPlan {
  const rng = new SeededRng(seed);
  const length = rng.int(minLen, maxLen);
  const st = new PlanState();
  const actions: SwingAction[] = [];
  for (let i = 0; i < length; i++) actions.push(genAction(rng, st));
  return { seed, length, actions };
}

// ---------------------------------------------------------------------------
// Execution + oracle
// ---------------------------------------------------------------------------

export interface Violation {
  step: number;
  action: SwingAction["kind"];
  invariant: string;
  inputClass: InputClass;
  detail: string;
}

export interface StepTrace {
  step: number;
  kind: SwingAction["kind"];
  inputClass: InputClass;
  digest: string;
}

export interface ExecutionResult {
  trace: StepTrace[];
  violations: Violation[];
  actionCounts: Record<string, number>;
}

interface Ctx {
  step: number;
  action: SwingAction;
  violations: Violation[];
}

function check(ctx: Ctx, invariant: string, ok: boolean, detail: () => string): void {
  if (ok) return;
  ctx.violations.push({
    step: ctx.step,
    action: ctx.action.kind,
    invariant,
    inputClass: ctx.action.inputClass,
    detail: detail(),
  });
}

function finiteDeep(value: unknown, path = "$"): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? null : `${path}=${String(value)}`;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const r = finiteDeep(value[i], `${path}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = finiteDeep(v, `${path}.${k}`);
      if (r) return r;
    }
  }
  return null;
}

function nodeSha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function withoutTextEncoder<T>(fn: () => T): T {
  const g = globalThis as { TextEncoder?: unknown };
  const saved = g.TextEncoder;
  delete g.TextEncoder;
  try {
    return fn();
  } finally {
    g.TextEncoder = saved;
  }
}

function isIsoInstant(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(value))
    return false;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return false;
  // Calendar validity: JS rolls Feb 30 forward silently; an instant must round-trip.
  const normalized = new Date(ms).toISOString();
  return value.endsWith("Z") ? normalized.slice(0, 10) === value.slice(0, 10) : true;
}

interface Stored {
  wire: string;
  ref: { sha256: string; frameCount: number; coordinateSystem: string; poseModelVersion: string };
}

function roundTrip(
  ctx: Ctx,
  sequence: PoseSequence,
): { wire: string; parsed: PoseSequence | null } {
  let wire = "";
  let threw: string | null = null;
  try {
    wire = serializePoseSequence(sequence);
    check(
      ctx,
      "W1",
      serializePoseSequence(sequence) === wire,
      () => "serializePoseSequence not deterministic",
    );
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  }
  check(ctx, "W1", threw === null, () => `serializePoseSequence threw: ${threw}`);
  if (threw !== null) return { wire, parsed: null };
  const parsed = parsePoseSequence(wire, PRODUCER);
  check(
    ctx,
    "W2",
    parsed.ok,
    () => `parse(serialize(x)) failed: ${parsed.ok ? "" : parsed.failure.code}`,
  );
  if (!parsed.ok) return { wire, parsed: null };
  check(
    ctx,
    "W2",
    canonicalJson(parsed.value) === canonicalJson(sequence) &&
      serializePoseSequence(parsed.value) === wire,
    () =>
      `round trip differs: ${canonicalJson(parsed.value).slice(0, 300)} vs ${canonicalJson(sequence).slice(0, 300)}`,
  );
  const again = parsePoseSequence(wire, PRODUCER);
  check(
    ctx,
    "M3",
    canonicalJson(again) === canonicalJson(parsed),
    () => "parsePoseSequence not deterministic",
  );
  const nf = finiteDeep(parsed.value);
  check(ctx, "W4", nf === null, () => `non-finite in parsed output at ${nf}`);
  const legacy = toLegacyPoseFrames(parsed.value);
  check(
    ctx,
    "W3",
    legacy.length === sequence.frames.length &&
      legacy.every((frame, i) => {
        const src = sequence.frames[i]!;
        const expected = src.landmarks.filter((m) => LEGACY_SET.has(m.name));
        return (
          frame.timestampMs === src.timestampMs &&
          frame.confidence === src.confidence &&
          frame.space === "normalized-image" &&
          frame.landmarks.length === expected.length &&
          frame.landmarks.every(
            (m, j) =>
              m.name === expected[j]!.name &&
              m.x === expected[j]!.x &&
              m.y === expected[j]!.y &&
              m.visibility === expected[j]!.visibility &&
              !("z" in m),
          )
        );
      }),
    () => `legacy projection mismatch (frames ${legacy.length}/${sequence.frames.length})`,
  );
  return { wire, parsed: parsed.value };
}

async function executeAction(ctx: Ctx, store: Stored[]): Promise<unknown> {
  const a = ctx.action;
  switch (a.kind) {
    case "pose_roundtrip": {
      const r = roundTrip(ctx, a.sequence);
      return { wireLength: r.wire.length, frames: r.parsed?.frames.length ?? null };
    }
    case "store_pose": {
      const r = roundTrip(ctx, a.sequence);
      const sha = sha256Hex(r.wire);
      check(ctx, "H2", /^[0-9a-f]{64}$/.test(sha) && sha256Hex(r.wire) === sha, () => `sha=${sha}`);
      check(
        ctx,
        "H1",
        sha === nodeSha256(r.wire),
        () => `sha256Hex(wire)=${sha} node=${nodeSha256(r.wire)}`,
      );
      store.push({
        wire: r.wire,
        ref: {
          sha256: sha,
          frameCount: a.sequence.frames.length,
          coordinateSystem: a.sequence.coordinateSystem,
          poseModelVersion: a.sequence.producedBy.modelVersion,
        },
      });
      return { index: store.length - 1, sha };
    }
    case "load_pose": {
      const entry = store[a.index];
      if (!entry) return { missing: a.index };
      const parsed = parsePoseSequence(entry.wire, PRODUCER);
      check(
        ctx,
        "I1",
        parsed.ok &&
          sha256Hex(entry.wire) === entry.ref.sha256 &&
          parsed.value.frames.length === entry.ref.frameCount &&
          parsed.value.coordinateSystem === entry.ref.coordinateSystem &&
          parsed.value.producedBy.modelVersion === entry.ref.poseModelVersion,
        () =>
          `reload of artifact ${a.index}: ok=${parsed.ok} ${parsed.ok ? "" : parsed.failure.code}`,
      );
      return { index: a.index, ok: parsed.ok };
    }
    case "pose_mutate": {
      let result: ReturnType<typeof parsePoseSequence> | null = null;
      let threw: string | null = null;
      try {
        result = parsePoseSequence(a.wire, PRODUCER);
      } catch (error) {
        threw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      }
      check(
        ctx,
        "M2",
        threw === null,
        () => `parsePoseSequence threw for mutation ${a.mutation}: ${threw}`,
      );
      if (result) {
        check(
          ctx,
          "M1",
          !result.ok &&
            result.failure.code === a.expectedCode &&
            result.failure.kind === "corrupted_media",
          () =>
            `mutation=${a.mutation} expected=${a.expectedCode} got=${result!.ok ? "ok" : `${result!.failure.kind}/${result!.failure.code}`} wire=${a.wire.slice(0, 200)}`,
        );
        const again = parsePoseSequence(a.wire, PRODUCER);
        check(
          ctx,
          "M3",
          canonicalJson(again) === canonicalJson(result),
          () => "parsePoseSequence not deterministic",
        );
      }
      return { code: result && !result.ok ? result.failure.code : "ok", threw };
    }
    case "sha": {
      const out: string[] = [];
      for (const input of a.inputs) {
        const hex = sha256Hex(input);
        out.push(hex);
        check(
          ctx,
          "H2",
          /^[0-9a-f]{64}$/.test(hex) && sha256Hex(input) === hex,
          () => `sha256Hex(${JSON.stringify(input).slice(0, 80)})=${hex}`,
        );
        check(
          ctx,
          "H1",
          hex === nodeSha256(input),
          () =>
            `sha256Hex=${hex} node=${nodeSha256(input)} input=${JSON.stringify(input).slice(0, 120)} (len ${input.length})`,
        );
        if (a.fallback) {
          const fallback = withoutTextEncoder(() => sha256Hex(input));
          check(
            ctx,
            "H3",
            fallback === hex,
            () =>
              `fallback encoder hash ${fallback} != TextEncoder hash ${hex} for ${JSON.stringify(input).slice(0, 120)}`,
          );
        }
      }
      return out;
    }
    case "resolve": {
      const res = resolveStroke(a.identity, { predictionConfidenceThreshold: a.threshold });
      const p = a.identity.predicted;
      const expected =
        p && p.shotType !== "unknown" && p.confidence >= a.threshold
          ? { kind: "predicted", shotType: p.shotType, confidence: p.confidence }
          : a.identity.declared !== null
            ? { kind: "declared", shotType: a.identity.declared }
            : { kind: "unresolved" };
      const actual = res.kind === "unresolved" ? { kind: "unresolved" } : res;
      check(
        ctx,
        "R1",
        canonicalJson(actual) === canonicalJson(expected),
        () => `resolve=${canonicalJson(res)} expected=${canonicalJson(expected)}`,
      );
      check(
        ctx,
        "R1",
        res.kind === "unresolved" ? res.reason.length > 0 : (res.shotType as string) !== "unknown",
        () => canonicalJson(res),
      );
      const again = resolveStroke(a.identity, { predictionConfidenceThreshold: a.threshold });
      check(
        ctx,
        "R1",
        canonicalJson(again) === canonicalJson(res),
        () => "resolveStroke not deterministic",
      );
      return res;
    }
    case "explain": {
      let result: ReturnType<typeof explainAnalysisRun> | null = null;
      let threw: string | null = null;
      try {
        result = explainAnalysisRun(a.record);
      } catch (error) {
        threw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      }
      check(ctx, "E1", threw === null, () => `explainAnalysisRun threw: ${threw}`);
      if (!result) return { threw };
      const d = a.defect;
      const expectedCode =
        d.type === "none"
          ? null
          : d.type === "provenance_missing"
            ? "provenance.missing"
            : d.type === "incomplete"
              ? "provenance.incomplete"
              : d.type === "timestamp"
                ? "provenance.invalid_timestamp"
                : d.type === "no_providers"
                  ? "provenance.no_providers"
                  : d.type === "untracked_run"
                    ? "provenance.model_run_untracked"
                    : "provenance.version_vector_mismatch";
      const code = result.ok ? null : result.failure.code;
      if (d.type === "timestamp") {
        check(
          ctx,
          "E2",
          code === expectedCode && !isIsoInstant(d.value),
          () =>
            `recordedAtIso=${JSON.stringify(d.value)} accepted (result=${code ?? "ok"}); Date.parse=${Date.parse(d.value)}`,
        );
      } else {
        check(
          ctx,
          "E1",
          code === expectedCode,
          () => `defect=${canonicalJson(d)} expected=${expectedCode} got=${code ?? "ok"}`,
        );
      }
      if (result.ok) {
        const r = a.record;
        check(
          ctx,
          "E1",
          result.value.analysisId === r.id &&
            result.value.captureId === r.captureId &&
            result.value.recordedAtIso === r.provenance.recordedAtIso &&
            result.value.executions.length === r.modelRuns.length &&
            result.value.executions.every((e, i) => {
              const run = r.modelRuns[i]!;
              return (
                e.task === run.task &&
                e.providerId === run.model.providerId &&
                e.modelVersion === run.model.modelVersion &&
                e.runtime === run.model.runtime &&
                e.status === run.status
              );
            }) &&
            result.value.scored === (r.result !== null && r.result.resultKind === "scored") &&
            result.value.overallScore === (r.result?.overallScore ?? null),
          () => `explanation mismatch: ${canonicalJson(result).slice(0, 300)}`,
        );
      }
      return { code: code ?? "ok" };
    }
    case "modality": {
      const m = measured(a.payload);
      const u = unavailable<unknown>(a.reason);
      check(
        ctx,
        "D1",
        m.status === "measured" &&
          m.data === a.payload &&
          u.status === "unavailable" &&
          u.reason === a.reason,
        () => canonicalJson({ m, u }),
      );
      return { m, u };
    }
  }
}

export async function executePlan(plan: SwingPlan): Promise<ExecutionResult> {
  const store: Stored[] = [];
  const violations: Violation[] = [];
  const trace: StepTrace[] = [];
  const actionCounts: Record<string, number> = {};
  for (let step = 0; step < plan.actions.length; step++) {
    const action = plan.actions[step]!;
    actionCounts[action.kind] = (actionCounts[action.kind] ?? 0) + 1;
    const ctx: Ctx = { step, action, violations };
    let output: unknown;
    try {
      output = await executeAction(ctx, store);
    } catch (error) {
      output = {
        uncaught: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      };
      check(ctx, "UNCAUGHT", false, () => (output as { uncaught: string }).uncaught);
    }
    trace.push({
      step,
      kind: action.kind,
      inputClass: action.inputClass,
      digest: canonicalJson(output),
    });
  }
  return { trace, violations, actionCounts };
}

export async function minimizePlan(
  plan: SwingPlan,
  invariant: string,
): Promise<{ actions: SwingAction[]; violation: Violation | null }> {
  const reproduces = async (actions: SwingAction[]) => {
    const r = await executePlan({ ...plan, actions });
    return r.violations.find((v) => v.invariant === invariant) ?? null;
  };
  let current = [...plan.actions];
  let first = await reproduces(current);
  if (!first) return { actions: current, violation: null };
  current = current.slice(0, first.step + 1);
  let progress = true;
  while (progress) {
    progress = false;
    for (let i = 0; i < current.length; i++) {
      const candidate = current.filter((_, j) => j !== i);
      const v = await reproduces(candidate);
      if (v) {
        current = candidate;
        first = v;
        progress = true;
        break;
      }
    }
  }
  return { actions: current, violation: first };
}

export type { ShotTypeSlug };
