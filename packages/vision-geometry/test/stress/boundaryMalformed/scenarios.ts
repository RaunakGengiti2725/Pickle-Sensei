import { PHASES, type PhaseSpan, type PoseFrame, type Result } from "@pickle/shared-types";
import type { StrokeEvent, VideoClipRef } from "@pickle/vision-contracts";
import {
  parsePoseSequence,
  serializePoseSequence,
  type BallObservation,
  type PoseSequence,
} from "@pickle/swing-domain";
import { generateSwing } from "@pickle/evaluation";

import { evaluateCaptureQuality } from "../../../src/captureQuality.js";
import { PoseGeometryFeatureExtractor } from "../../../src/featureExtractor.js";
import {
  evaluateFrameAnalyzability,
  FRAME_ANALYZABILITY_REASONS,
  type FrameStats,
} from "../../../src/frameAnalyzability.js";
import { createGeometryProviderSet, type RecordedStrokeInput } from "../../../src/index.js";
import {
  detectOfflineStrokeWindow,
  estimateContact,
  paddleOwnershipFromHandAffinity,
  type ContactEstimate,
} from "../../../src/offlineStroke.js";
import {
  assessPaddleTrackIdentity,
  type PaddleTrackIdentityInput,
} from "../../../src/paddleTrackIdentity.js";
import { GeometricPhaseSegmenter } from "../../../src/phaseSegmenter.js";
import {
  classifyStroke,
  STROKE_TAXONOMY_V3,
  type HeuristicStrokePrediction,
} from "../../../src/strokeHeuristicLite.js";
import {
  deepCopy,
  hostileString,
  mutateTree,
  POLLUTION_KEYS,
  UNICODE_NORMALIZATION_PAIRS,
  type Mutation,
  type MutationOp,
} from "./malformed.js";
import { rng, type Rng } from "./rng.js";

/**
 * Boundary/malformed-input scenarios for @pickle/vision-geometry (and the
 * type-only @pickle/vision-contracts surface it implements). Every scenario
 * starts from the committed synthetic swing skeleton (`generateSwing`, math
 * fixture — no labels) and applies seeded mutations: numeric specials
 * (NaN/±Infinity/-0/overflow), wrong JSON types, deleted keys, prototype
 * pollution keys, hostile strings (null bytes, 64 KiB+, path traversal,
 * unicode normalization pairs), empty/duplicated/reordered arrays, and
 * whole-input poisoning. The wire scenario mutates the serialized sidecar
 * JSON itself (truncation, future schema versions, invalid literals).
 *
 * Contract under test (per directive §6 zero-silent-failure): a malformed
 * input yields a TYPED outcome (Result failure / abstention / UNKNOWN), never
 * a throw, never NaN/Infinity in the output, never a mutated input, never a
 * write to a shared prototype, and the same seed replays identically.
 */

export interface BuiltInput {
  input: unknown;
  mutations: Mutation[];
  /** True when the mutation left nothing measurable — the target must abstain. */
  expectAbstain: boolean;
}

/**
 * Returned by a scenario's `run` instead of invoking the target when the input
 * would trip a known process-killing defect (the runner cannot survive an OOM
 * or an infinite loop). Every refusal names the defect it guards against; the
 * defect itself is pinned by `boundaryMalformed.knownGaps.test.ts`.
 */
export interface HarnessRefusal {
  harnessRefused: true;
  hazard: string;
  detail: string;
}

export function isRefusal(value: unknown): value is HarnessRefusal {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { harnessRefused?: unknown }).harnessRefused === true
  );
}

export interface Scenario {
  id: string;
  /** Production entry point exercised (file: symbol). */
  target: string;
  build(r: Rng, seed: number): BuiltInput;
  run(input: unknown): unknown | Promise<unknown>;
  /** Shape/contract violations beyond the generic ones (throw, non-finite, …). */
  check(output: unknown, built: BuiltInput): string[];
  summarize(output: unknown): string;
  /** Optional cap on iterations (boundary probes with a fixed size ladder). */
  maxIterations?: number;
}

const FAILURE_KINDS = new Set([
  "timeout",
  "retryable",
  "permanent",
  "low_confidence",
  "permission_denied",
  "network",
  "unsupported_device",
  "corrupted_media",
  "auth_failed",
  "not_implemented",
]);

const CAPTURE_QUALITY_REASONS = new Set([
  "too_few_pose_frames",
  "insufficient_fps",
  "low_pose_confidence",
  "body_not_fully_visible",
  "torso_not_measured",
  "player_too_small_in_frame",
  "player_too_close_or_cropped",
  "tracking_dropout_gap",
]);

const MEASUREMENT_UNITS = new Set(["normalized", "ratio", "degrees", "ms", "count"]);
const STROKE_LABELS = new Set<string>(STROKE_TAXONOMY_V3.labels);
const PRODUCER = {
  providerId: "stress.boundary-malformed",
  runtime: "deterministic",
  executionTarget: "on_device",
  artifactHash: null,
} as const;

// ── Base material (committed synthetic skeleton, no labels) ─────────────────

export interface BaseSwing {
  key: string;
  frames: PoseFrame[];
  sequence: PoseSequence;
  window: { startMs: number; endMs: number; peakMs: number };
  video: { width: number; height: number; fps: number };
}

const baseCache = new Map<string, BaseSwing>();
/** Deterministic base phases per base skeleton, keyed by fps + frame count. */
const PHASE_SEED_CACHE = new Map<string, PhaseSpan[]>();

function baseSwing(r: Rng): BaseSwing {
  const fps = r.pick([24, 30, 60]);
  const handed = r.pick(["right", "left"] as const);
  const torsoLength = r.pick([0.14, 0.2, 0.26]);
  const key = `${fps}:${handed}:${torsoLength}`;
  const cached = baseCache.get(key);
  if (cached) return deepCopy(cached);
  const swing = generateSwing({ fps, handed, torsoLength });
  const video = { width: swing.clip.width, height: swing.clip.height, fps };
  const sequence: PoseSequence = {
    schemaVersion: 1,
    format: "pickle.pose-sequence.v1",
    coordinateSystem: "normalized_image_top_left",
    producedBy: { ...PRODUCER, modelVersion: "synthetic-swing-1" },
    video,
    frames: swing.frames.map((frame, index) => ({
      frameIndex: index,
      timestampMs: frame.timestampMs,
      confidence: frame.confidence,
      landmarks: frame.landmarks.map((mark) => ({
        name: mark.name,
        x: mark.x,
        y: mark.y,
        visibility: mark.visibility,
      })),
    })),
  };
  const built: BaseSwing = { key, frames: swing.frames, sequence, window: swing.window, video };
  baseCache.set(key, built);
  return deepCopy(built);
}

async function basePhases(base: BaseSwing): Promise<PhaseSpan[]> {
  const segmenter = new GeometricPhaseSegmenter({ aspectRatio: 1 });
  const result = await segmenter.segmentPhases(base.frames, [], {
    startMs: base.window.startMs,
    endMs: base.window.endMs,
    contactMs: base.window.peakMs,
    shotTypeHypothesis: null,
    confidence: 0.9,
  });
  if (!result.ok) throw new Error(`base swing must segment: ${result.failure.code}`);
  return result.value;
}

/** Deterministic committed-synthetic base swing for minimized known-gap repros. */
export function syntheticBase(seed: number): BaseSwing {
  return baseSwing(rng(seed));
}

export function wristTrack(base: BaseSwing, name: "left_wrist" | "right_wrist") {
  return base.frames.flatMap((frame) => {
    const mark = frame.landmarks.find((entry) => entry.name === name);
    return mark ? [{ timestampMs: frame.timestampMs, x: mark.x, y: mark.y }] : [];
  });
}

/** Synthetic ball path: approaches the dominant wrist, reverses at the peak. */
function syntheticBall(base: BaseSwing, r: Rng): BallObservation[] {
  const dominant = wristTrack(base, r.chance(0.5) ? "right_wrist" : "left_wrist");
  const contact = dominant.find((point) => point.timestampMs >= base.window.peakMs) ?? dominant[0];
  if (!contact) return [];
  const observations: BallObservation[] = [];
  let index = 0;
  for (let tMs = base.window.peakMs - 400; tMs <= base.window.peakMs + 400; tMs += 1000 / 30) {
    const delta = tMs - base.window.peakMs;
    const direction = delta < 0 ? 1 : -1;
    observations.push({
      frameIndex: index,
      timestampMs: Math.round(tMs),
      x: contact.x + direction * Math.abs(delta) * 0.0012,
      y: contact.y - Math.abs(delta) * 0.0002,
      confidence: 0.6 + r.next() * 0.3,
    });
    index += 1;
  }
  return observations;
}

function synthesizedSpeeds(track: ReadonlyArray<{ timestampMs: number; x: number; y: number }>) {
  const speeds: Array<{ timestampMs: number; value: number }> = [];
  for (let index = 1; index < track.length; index += 1) {
    const a = track[index - 1]!;
    const b = track[index]!;
    const dt = b.timestampMs - a.timestampMs;
    if (dt <= 0) continue;
    speeds.push({
      timestampMs: b.timestampMs,
      value: (Math.hypot(b.x - a.x, b.y - a.y) / dt) * 1000,
    });
  }
  return speeds;
}

// ── Generic checks ──────────────────────────────────────────────────────────

function isResult(value: unknown): value is Result<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { ok?: unknown }).ok === "boolean"
  );
}

function checkResult(result: unknown, label: string): string[] {
  const violations: string[] = [];
  if (!isResult(result)) return [`${label}: not a Result (${typeof result})`];
  if (result.ok) return violations;
  const failure = result.failure as Partial<Result<unknown> & { failure: unknown }>["failure"] & {
    kind?: unknown;
    code?: unknown;
    message?: unknown;
    retryable?: unknown;
  };
  if (!failure || typeof failure !== "object") return [`${label}: failure payload missing`];
  if (typeof failure.kind !== "string" || !FAILURE_KINDS.has(failure.kind)) {
    violations.push(`${label}: failure.kind invalid (${String(failure.kind)})`);
  }
  if (typeof failure.code !== "string" || failure.code.length === 0) {
    violations.push(`${label}: failure.code missing`);
  }
  if (typeof failure.message !== "string") violations.push(`${label}: failure.message missing`);
  else if (failure.message.length > 2048) {
    violations.push(
      `${label}: failure.message echoes oversized input (${failure.message.length} chars)`,
    );
  }
  if (typeof failure.retryable !== "boolean") violations.push(`${label}: retryable not boolean`);
  return violations;
}

function inUnit(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function checkPhaseSpans(spans: unknown, stroke: { startMs?: unknown; endMs?: unknown }): string[] {
  const violations: string[] = [];
  if (!Array.isArray(spans)) return ["phases: not an array"];
  if (spans.length !== PHASES.length) violations.push(`phases: ${spans.length} spans (want 6)`);
  const seen = new Set<string>();
  let cursor = Number.NEGATIVE_INFINITY;
  for (const span of spans as PhaseSpan[]) {
    if (!PHASES.includes(span.key)) violations.push(`phases: unknown key ${String(span.key)}`);
    if (seen.has(span.key)) violations.push(`phases: duplicate key ${span.key}`);
    seen.add(span.key);
    if (!Number.isFinite(span.startMs) || !Number.isFinite(span.endMs)) {
      violations.push(`phases: ${span.key} non-finite bounds`);
      continue;
    }
    if (span.startMs > span.endMs) violations.push(`phases: ${span.key} start > end`);
    if (span.startMs < cursor) violations.push(`phases: ${span.key} starts before previous end`);
    cursor = span.endMs;
    if (span.representativeMs < span.startMs || span.representativeMs > span.endMs) {
      violations.push(`phases: ${span.key} representative outside span`);
    }
    if (!inUnit(span.confidence)) violations.push(`phases: ${span.key} confidence not in [0,1]`);
    if (
      typeof stroke.startMs === "number" &&
      typeof stroke.endMs === "number" &&
      Number.isFinite(stroke.startMs) &&
      Number.isFinite(stroke.endMs) &&
      stroke.startMs <= stroke.endMs &&
      (span.startMs < stroke.startMs - 1e-6 || span.endMs > stroke.endMs + 1e-6)
    ) {
      violations.push(`phases: ${span.key} escapes the stroke window`);
    }
  }
  return violations;
}

function checkMeasurements(measurements: unknown): string[] {
  const violations: string[] = [];
  if (!Array.isArray(measurements)) return ["measurements: not an array"];
  if (measurements.length === 0) violations.push("measurements: ok() with empty list");
  for (const entry of measurements as Array<Record<string, unknown>>) {
    if (typeof entry.metricKey !== "string" || entry.metricKey.length === 0) {
      violations.push("measurements: metricKey missing");
    }
    if (typeof entry.value !== "number" || !Number.isFinite(entry.value)) {
      violations.push(`measurements: ${String(entry.metricKey)} value non-finite`);
    }
    if (!inUnit(entry.confidence)) {
      violations.push(`measurements: ${String(entry.metricKey)} confidence not in [0,1]`);
    }
    if (typeof entry.unit !== "string" || !MEASUREMENT_UNITS.has(entry.unit)) {
      violations.push(`measurements: ${String(entry.metricKey)} unit invalid`);
    }
    if (entry.source !== "real") violations.push("measurements: source is not real");
  }
  return violations;
}

function checkContact(estimate: unknown, window: { startMs?: unknown; endMs?: unknown }): string[] {
  const violations: string[] = [];
  const value = estimate as ContactEstimate | null;
  if (!value || typeof value !== "object") return ["contact: not an object"];
  if (value.status !== "estimated" && value.status !== "abstained") {
    return [`contact: status invalid (${String((value as { status?: unknown }).status)})`];
  }
  if (value.status === "abstained") {
    if (typeof value.reason !== "string" || value.reason.length === 0) {
      violations.push("contact: abstained without reason");
    }
  } else {
    if (!Number.isFinite(value.estimatedContactMs))
      violations.push("contact: contactMs non-finite");
    if (!inUnit(value.confidence)) violations.push("contact: confidence not in [0,1]");
    if (typeof value.ballConfirmed !== "boolean" || typeof value.paddleConfirmed !== "boolean") {
      violations.push("contact: confirmation flags not boolean");
    }
    if (
      typeof window.startMs === "number" &&
      typeof window.endMs === "number" &&
      Number.isFinite(window.startMs) &&
      Number.isFinite(window.endMs) &&
      window.startMs <= window.endMs &&
      (value.estimatedContactMs < window.startMs - 500 ||
        value.estimatedContactMs > window.endMs + 500)
    ) {
      violations.push("contact: estimate more than 500ms outside the analysis window");
    }
    if (!Array.isArray(value.limitingFactors)) violations.push("contact: limitingFactors missing");
    if (!Array.isArray(value.supportingEvidence)) violations.push("contact: evidence missing");
  }
  for (const point of value.contactDistribution ?? []) {
    if (!inUnit(point.density)) {
      violations.push("contact: distribution density not in [0,1]");
      break;
    }
  }
  for (const mode of value.modes ?? []) {
    if (!inUnit(mode.share)) {
      violations.push("contact: mode share not in [0,1]");
      break;
    }
  }
  return violations;
}

function checkPrediction(prediction: unknown, expectAbstain: boolean): string[] {
  const violations: string[] = [];
  const value = prediction as HeuristicStrokePrediction | null;
  if (!value || typeof value !== "object") return ["stroke: not an object"];
  if (typeof value.label !== "string" || value.label.length === 0)
    violations.push("stroke: label missing");
  if (![1, 2, 3].includes(value.taxonomyDepth)) violations.push("stroke: taxonomyDepth invalid");
  if (value.leaf !== null && !STROKE_LABELS.has(value.leaf)) {
    violations.push(`stroke: leaf outside taxonomy (${String(value.leaf)})`);
  }
  if (
    value.leaf !== null &&
    value.leaf !== "OVERHEAD" &&
    value.leaf !== "UNKNOWN" &&
    value.taxonomyDepth !== 3
  ) {
    violations.push("stroke: leaf committed below depth 3");
  }
  if (!inUnit(value.confidence)) violations.push("stroke: confidence not in [0,1]");
  if (!Array.isArray(value.evidence) || value.evidence.some((entry) => typeof entry !== "string")) {
    violations.push("stroke: evidence not string[]");
  }
  if (
    !Array.isArray(value.limitingFactors) ||
    value.limitingFactors.some((entry) => typeof entry !== "string")
  ) {
    violations.push("stroke: limitingFactors not string[]");
  }
  // The designed abstention is `unknown()` → UNKNOWN@depth1 with the fixed
  // floor confidence 0.2 (strokeHeuristicLite.ts:959-979); anything higher
  // would be a confident non-answer.
  if (value.label === "UNKNOWN" && (value.taxonomyDepth !== 1 || value.confidence > 0.2)) {
    violations.push("stroke: UNKNOWN outside the abstention shape (depth 1, conf ≤ 0.2)");
  }
  if (expectAbstain && value.label !== "UNKNOWN") {
    violations.push(`stroke: committed ${value.label} on fully non-finite input`);
  }
  return violations;
}

function checkGateReport(
  report: unknown,
  registry: ReadonlySet<string>,
  expectAbstain: boolean,
): string[] {
  const violations: string[] = [];
  const value = report as {
    analyzable?: unknown;
    reasons?: unknown;
    notEvaluated?: unknown;
    stats?: unknown;
  } | null;
  if (!value || typeof value !== "object") return ["gate: not an object"];
  if (typeof value.analyzable !== "boolean") violations.push("gate: analyzable not boolean");
  if (!Array.isArray(value.reasons)) violations.push("gate: reasons not an array");
  else {
    if (value.analyzable !== (value.reasons.length === 0)) {
      violations.push("gate: analyzable disagrees with reasons");
    }
    if (new Set(value.reasons).size !== value.reasons.length)
      violations.push("gate: duplicate reasons");
    for (const reason of value.reasons) {
      if (typeof reason !== "string" || !registry.has(reason)) {
        violations.push(`gate: unregistered reason ${String(reason)}`);
      }
    }
  }
  if (!Array.isArray(value.notEvaluated)) violations.push("gate: notEvaluated not an array");
  if (!value.stats || typeof value.stats !== "object") violations.push("gate: stats missing");
  else {
    for (const [key, stat] of Object.entries(value.stats)) {
      if (typeof stat !== "number") violations.push(`gate: stats.${key} not a number`);
    }
  }
  if (expectAbstain && value.analyzable === true) {
    violations.push("gate: analyzable=true on fully non-finite input");
  }
  return violations;
}

function mutated<T>(
  value: T,
  r: Rng,
  options: { min?: number; max?: number; ops?: readonly MutationOp[] } = {},
): { value: T; mutations: Mutation[]; expectAbstain: boolean } {
  const count = r.int(options.min ?? 1, options.max ?? 3);
  const opts = options.ops ? { count, ops: options.ops } : { count };
  const result = mutateTree(value, r, opts);
  const expectAbstain = result.mutations.some((entry) => entry.op === "poison_all_numbers");
  return { ...result, expectAbstain };
}

function firstFailureCode(result: unknown): string {
  if (!isResult(result)) return "not-result";
  return result.ok ? "ok" : `fail:${(result.failure as { code?: string }).code ?? "?"}`;
}

// ── Scenarios ───────────────────────────────────────────────────────────────

const WIRE_MUTATIONS = [
  "truncate",
  "future_schema",
  "format_variant",
  "coordinate_system_variant",
  "pollution_key",
  "number_literal",
  "model_version_hostile",
  "null_byte",
  "bom_prefix",
  "nfd_document",
  "landmark_name_pollution",
  "wrap_document",
  "empty_frames",
  "empty_landmarks",
  "garbage_bytes",
] as const;

const wireIngress: Scenario = {
  id: "wire_json_ingress",
  target:
    "swing-domain/serialization.ts:parsePoseSequence → captureQuality/offlineStroke/strokeHeuristicLite",
  build(r) {
    const base = baseSwing(r);
    let text = serializePoseSequence(base.sequence);
    const mutations: Mutation[] = [];
    const count = r.int(1, 3);
    for (let step = 0; step < count; step += 1) {
      const op = r.pick(WIRE_MUTATIONS);
      switch (op) {
        case "truncate": {
          const cut = r.int(0, text.length);
          text = text.slice(0, cut);
          mutations.push({ op: "truncate_array", path: "$", detail: `truncate@${cut}` });
          break;
        }
        case "future_schema": {
          const version = r.pick([
            "2",
            "999",
            '"1"',
            "1.5",
            "-1",
            "1e999",
            "null",
            "true",
            '"v1"',
            "[1]",
          ]);
          text = text.replace('"schemaVersion":1', `"schemaVersion":${version}`);
          mutations.push({ op: "wrong_type", path: "$.schemaVersion", detail: version });
          break;
        }
        case "format_variant": {
          const format = r.pick([
            '"pickle.pose-sequence.v2"',
            JSON.stringify("pickle.pose-sequence.v1".normalize("NFD")),
            '"pickle.pose-sequence.v1\\u200b"',
            '""',
            "null",
            '"PICKLE.POSE-SEQUENCE.V1"',
          ]);
          text = text.replace('"format":"pickle.pose-sequence.v1"', `"format":${format}`);
          mutations.push({ op: "hostile_string", path: "$.format", detail: format });
          break;
        }
        case "coordinate_system_variant": {
          const pair = r.pick(UNICODE_NORMALIZATION_PAIRS);
          const system = r.pick([
            JSON.stringify(pair[1]),
            '"image_pixels"',
            '"../../normalized_image_top_left"',
            '"normalized_image_top_left\\u0000"',
            "42",
          ]);
          text = text.replace(
            '"coordinateSystem":"normalized_image_top_left"',
            `"coordinateSystem":${system}`,
          );
          mutations.push({ op: "hostile_string", path: "$.coordinateSystem", detail: system });
          break;
        }
        case "pollution_key": {
          const key = r.pick(POLLUTION_KEYS);
          text = text.replace("{", `{"${key}":{"stressPolluted":true},`);
          mutations.push({ op: "pollution_key", path: `$.${key}`, detail: "injected" });
          break;
        }
        case "number_literal": {
          const literal = r.pick([
            "1e999",
            "-1e999",
            "-0",
            "1e-999",
            "9007199254740993",
            "NaN",
            "Infinity",
            "-Infinity",
            '"1"',
            "null",
            "true",
            "[]",
            "{}",
            "0x10",
            "01",
            "1.",
            ".5",
            "1e",
          ]);
          const numbers = [...text.matchAll(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)];
          if (numbers.length === 0) break;
          const match = r.pick(numbers);
          const start = match.index ?? 0;
          text = `${text.slice(0, start)}${literal}${text.slice(start + match[0].length)}`;
          mutations.push({ op: "number_special", path: `$@${start}`, detail: literal });
          break;
        }
        case "model_version_hostile": {
          const value = hostileString(r);
          text = text.replace(
            '"poseModelVersion":"synthetic-swing-1"',
            `"poseModelVersion":${JSON.stringify(value)}`,
          );
          mutations.push({
            op: "hostile_string",
            path: "$.poseModelVersion",
            detail: `len=${value.length}`,
          });
          break;
        }
        case "null_byte": {
          const at = r.int(0, Math.max(0, text.length - 1));
          text = `${text.slice(0, at)}\\u0000${text.slice(at)}`;
          mutations.push({ op: "hostile_string", path: `$@${at}`, detail: "\\u0000" });
          break;
        }
        case "bom_prefix": {
          text = `\ufeff${text}`;
          mutations.push({ op: "hostile_string", path: "$", detail: "BOM" });
          break;
        }
        case "nfd_document": {
          text = text.normalize("NFD");
          mutations.push({ op: "hostile_string", path: "$", detail: "NFD" });
          break;
        }
        case "landmark_name_pollution": {
          const key = r.pick(POLLUTION_KEYS);
          text = text.replace(/"n":"[a-z_]+"/, `"n":"${key}"`);
          mutations.push({ op: "pollution_key", path: "$.frames[0].l[0].n", detail: key });
          break;
        }
        case "wrap_document": {
          const wrapped = r.pick([
            `[${text}]`,
            JSON.stringify(text),
            `{"data":${text}}`,
            "null",
            '""',
          ]);
          text = wrapped;
          mutations.push({ op: "wrong_type", path: "$", detail: wrapped.slice(0, 12) });
          break;
        }
        case "empty_frames": {
          text = text.replace(/"frames":\[.*\]/s, '"frames":[]');
          mutations.push({ op: "empty_array", path: "$.frames", detail: "[]" });
          break;
        }
        case "empty_landmarks": {
          text = text.replace(/"l":\[[^\]]*\]/, '"l":[]');
          mutations.push({ op: "empty_array", path: "$.frames[0].l", detail: "[]" });
          break;
        }
        case "garbage_bytes": {
          const at = r.int(0, Math.max(0, text.length - 1));
          const junk = r.pick(["\u0000", "}", "{", "]", ",", '"', "\\", "\ud800", "\u202e", "\n"]);
          text = `${text.slice(0, at)}${junk}${text.slice(at)}`;
          mutations.push({ op: "hostile_string", path: `$@${at}`, detail: JSON.stringify(junk) });
          break;
        }
      }
    }
    return { input: text, mutations, expectAbstain: false };
  },
  run(input) {
    const parsed = parsePoseSequence(input as string, PRODUCER);
    if (!parsed.ok) return { parsed };
    const sequence = parsed.value;
    const quality = evaluateCaptureQuality(sequence);
    const window = detectOfflineStrokeWindow(sequence);
    if (!window.ok) return { parsed, quality, window };
    const contact = estimateContact({
      sequence,
      window: {
        startMs: window.value.startMs,
        endMs: window.value.endMs,
        peakMotionMs: window.value.peakMotionMs,
      },
      ballObservations: null,
    });
    const stroke = classifyStroke({
      sequence,
      window: { startMs: window.value.startMs, endMs: window.value.endMs },
      contactMs: contact.status === "estimated" ? contact.estimatedContactMs : null,
      eventPeakMs: window.value.peakMotionMs,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    return { parsed, quality, window, contact, stroke };
  },
  check(output) {
    const value = output as {
      parsed: Result<PoseSequence>;
      quality?: unknown;
      window?: Result<{ startMs: number; endMs: number }>;
      contact?: unknown;
      stroke?: unknown;
    };
    const violations = checkResult(value.parsed, "parse");
    if (!value.parsed.ok) {
      const code = (value.parsed.failure as { code: string }).code;
      if (!code.startsWith("pose_sequence.")) violations.push(`parse: foreign code ${code}`);
      return violations;
    }
    violations.push(...checkGateReport(value.quality, CAPTURE_QUALITY_REASONS, false));
    violations.push(...checkResult(value.window, "offline_window"));
    if (value.window?.ok) {
      violations.push(...checkContact(value.contact, value.window.value));
      violations.push(...checkPrediction(value.stroke, false));
    }
    return violations;
  },
  summarize(output) {
    const value = output as {
      parsed: unknown;
      window?: unknown;
      stroke?: HeuristicStrokePrediction;
    };
    const parts = [firstFailureCode(value.parsed)];
    if (value.window !== undefined) parts.push(firstFailureCode(value.window));
    if (value.stroke) parts.push(`label:${value.stroke.label}`);
    return parts.join(" → ");
  },
};

const frameStatsGate: Scenario = {
  id: "frame_stats_gate",
  target: "frameAnalyzability.ts:evaluateFrameAnalyzability",
  build(r) {
    const frameCount = r.int(0, 400);
    const stats: FrameStats = {
      frameCount,
      durationMs: r.int(0, 15 * 60 * 1000),
      width: r.pick([64, 640, 1920]),
      height: r.pick([36, 360, 1080]),
      interFrameDiffs: Array.from({ length: Math.max(0, frameCount - 1) }, () => r.next() * 30),
      spatialLumaStd: Array.from({ length: frameCount }, () => r.next() * 80),
      letterboxRowFraction: r.next(),
    };
    if (r.chance(0.5)) stats.borderRing = { temporalStd: r.next() * 5, meanLuma: r.next() * 255 };
    if (r.chance(0.5)) {
      stats.bottomFrozenComponents = Array.from({ length: r.int(0, 4) }, () => ({
        size: r.int(0, 64),
        lumaStd: r.next() * 40,
      }));
    }
    if (r.chance(0.5)) stats.source = { width: r.int(1, 4000), height: r.int(1, 4000) };
    if (r.chance(0.5)) {
      stats.decode = {
        errorCount: r.int(0, 5),
        expectedFrameCount: r.chance(0.3) ? null : r.int(0, 500),
      };
    }
    const result = mutated(stats, r, { max: 4 });
    return {
      input: result.value,
      mutations: result.mutations,
      expectAbstain: result.expectAbstain,
    };
  },
  run(input) {
    return evaluateFrameAnalyzability(input as FrameStats);
  },
  check(output, built) {
    return checkGateReport(output, new Set(FRAME_ANALYZABILITY_REASONS), built.expectAbstain);
  },
  summarize(output) {
    const value = output as { analyzable: boolean; reasons: string[] };
    return `analyzable=${value.analyzable}${value.reasons.length ? `:${value.reasons.join("+")}` : ""}`;
  },
};

const captureQuality: Scenario = {
  id: "capture_quality_gate",
  target: "captureQuality.ts:evaluateCaptureQuality",
  build(r) {
    const base = baseSwing(r);
    const result = mutated(base.sequence, r);
    return {
      input: result.value,
      mutations: result.mutations,
      expectAbstain: result.expectAbstain,
    };
  },
  run(input) {
    return evaluateCaptureQuality(input as PoseSequence);
  },
  check(output, built) {
    return checkGateReport(output, CAPTURE_QUALITY_REASONS, built.expectAbstain);
  },
  summarize(output) {
    const value = output as { analyzable: boolean; reasons: string[] };
    return `analyzable=${value.analyzable}${value.reasons.length ? `:${value.reasons.join("+")}` : ""}`;
  },
};

interface PhaseInput {
  frames: PoseFrame[];
  stroke: StrokeEvent;
  aspectRatio: number;
}

const phaseSegmenter: Scenario = {
  id: "phase_segmenter",
  target: "phaseSegmenter.ts:GeometricPhaseSegmenter.segmentPhases",
  build(r) {
    const base = baseSwing(r);
    const input: PhaseInput = {
      frames: base.frames,
      stroke: {
        startMs: base.window.startMs,
        endMs: base.window.endMs,
        contactMs: r.chance(0.7) ? base.window.peakMs : null,
        shotTypeHypothesis: null,
        confidence: 0.9,
      },
      aspectRatio: r.pick([1, 16 / 9, 9 / 16]),
    };
    const result = mutated(input, r);
    return {
      input: result.value,
      mutations: result.mutations,
      expectAbstain: result.expectAbstain,
    };
  },
  async run(input) {
    const value = input as PhaseInput;
    const segmenter = new GeometricPhaseSegmenter({ aspectRatio: value.aspectRatio });
    return segmenter.segmentPhases(value.frames, [], value.stroke);
  },
  check(output, built) {
    const violations = checkResult(output, "phases");
    const result = output as Result<PhaseSpan[]>;
    if (isResult(result) && result.ok) {
      const stroke = (built.input as PhaseInput).stroke ?? {};
      violations.push(...checkPhaseSpans(result.value, stroke));
      if (built.expectAbstain) violations.push("phases: ok() on fully non-finite input");
    }
    return violations;
  },
  summarize: firstFailureCode,
};

interface FeatureInput {
  frames: PoseFrame[];
  phases: PhaseSpan[];
  shotType: string;
  handedness: string;
  cameraView: string;
  aspectRatio: number;
}

const featureExtractor: Scenario = {
  id: "feature_extractor",
  target: "featureExtractor.ts:PoseGeometryFeatureExtractor.extractMeasurements",
  build(r) {
    const base = baseSwing(r);
    const cachedPhases = PHASE_SEED_CACHE.get(base.key);
    if (!cachedPhases) throw new Error("phase cache not primed; call primeScenarios() first");
    const phases = deepCopy(cachedPhases);
    const input: FeatureInput = {
      frames: base.frames,
      phases,
      shotType: r.pick(["forehand_drive", "dink", "serve", "third_shot_drop"]),
      handedness: r.pick(["right", "left", "ambidextrous"]),
      cameraView: r.pick(["side", "rear_oblique"]),
      aspectRatio: r.pick([1, 16 / 9, 9 / 16]),
    };
    const result = mutated(input, r);
    return {
      input: result.value,
      mutations: result.mutations,
      expectAbstain: result.expectAbstain,
    };
  },
  async run(input) {
    const value = input as FeatureInput;
    const extractor = new PoseGeometryFeatureExtractor({ aspectRatio: value.aspectRatio });
    return extractor.extractMeasurements({
      poseFrames: value.frames,
      paddleFrames: [],
      phases: value.phases,
      shotType: value.shotType as "dink",
      handedness: value.handedness as "right",
      cameraView: value.cameraView as "side",
    });
  },
  check(output, built) {
    const violations = checkResult(output, "features");
    const result = output as Result<unknown>;
    if (isResult(result) && result.ok) {
      violations.push(...checkMeasurements(result.value));
      if (built.expectAbstain) violations.push("features: ok() on fully non-finite input");
    }
    return violations;
  },
  summarize(output) {
    const result = output as Result<unknown[]>;
    return isResult(result) && result.ok ? `ok:${result.value.length}` : firstFailureCode(result);
  },
};

/** Primes deterministic base phases for every base skeleton variant. */
export async function primeScenarios(): Promise<void> {
  for (const fps of [24, 30, 60]) {
    for (const handed of ["right", "left"] as const) {
      for (const torsoLength of [0.14, 0.2, 0.26]) {
        const key = `${fps}:${handed}:${torsoLength}`;
        if (PHASE_SEED_CACHE.has(key)) continue;
        const swing = generateSwing({ fps, handed, torsoLength });
        const base: BaseSwing = {
          key,
          frames: swing.frames,
          sequence: {
            schemaVersion: 1,
            format: "pickle.pose-sequence.v1",
            coordinateSystem: "normalized_image_top_left",
            producedBy: { ...PRODUCER, modelVersion: "synthetic-swing-1" },
            video: { width: 1080, height: 1080, fps },
            frames: [],
          },
          window: swing.window,
          video: { width: 1080, height: 1080, fps },
        };
        PHASE_SEED_CACHE.set(key, await basePhases(base));
      }
    }
  }
}

interface PipelineInput {
  recorded: RecordedStrokeInput;
  clip: VideoClipRef;
}

const recordedPipeline: Scenario = {
  id: "recorded_provider_pipeline",
  target:
    "index.ts:createGeometryProviderSet → providers.ts (RecordedTriggerStrokeDetector, RecordedPoseProvider, AbsentPaddleDetector) → phaseSegmenter → featureExtractor",
  build(r) {
    const base = baseSwing(r);
    const input: PipelineInput = {
      recorded: {
        poseFrames: base.frames,
        poseModelVersion: "apple-vision-bodypose-1",
        trigger: {
          modelVersion: "temporal-trigger-1",
          startMs: base.window.startMs,
          endMs: base.window.endMs,
          peakMotionMs: base.window.peakMs,
          confidence: 0.8,
        },
        video: { width: base.video.width, height: base.video.height },
      },
      clip: {
        uri: "file:///captures/stroke.mov",
        durationMs: base.window.endMs,
        fps: base.video.fps,
        width: base.video.width,
        height: base.video.height,
      },
    };
    const result = mutated(input, r);
    return {
      input: result.value,
      mutations: result.mutations,
      expectAbstain: result.expectAbstain,
    };
  },
  async run(input) {
    const value = input as PipelineInput;
    const providers = createGeometryProviderSet(value.recorded);
    const strokes = await providers.stroke.detectStrokes(value.clip);
    if (!strokes.ok) return { strokes };
    const stroke = strokes.value[0];
    if (!stroke) return { strokes, note: "no stroke event" };
    const pose = await providers.pose.extractPose(value.clip, stroke);
    if (!pose.ok) return { strokes, pose };
    const paddle = await providers.paddle.detectPaddle(value.clip, stroke);
    const phases = await providers.phase.segmentPhases(
      pose.value,
      paddle.ok ? paddle.value : [],
      stroke,
    );
    if (!phases.ok) return { strokes, pose, paddle, phases };
    const features = await providers.features.extractMeasurements({
      poseFrames: pose.value,
      paddleFrames: paddle.ok ? paddle.value : [],
      phases: phases.value,
      shotType: "forehand_drive",
      handedness: "right",
      cameraView: "side",
    });
    return { strokes, pose, paddle, phases, features, ball: providers.ball };
  },
  check(output, built) {
    const value = output as {
      strokes: Result<StrokeEvent[]>;
      note?: string;
      pose?: Result<PoseFrame[]>;
      paddle?: Result<unknown[]>;
      phases?: Result<PhaseSpan[]>;
      features?: Result<unknown>;
      ball?: unknown;
    };
    const violations = checkResult(value.strokes, "strokes");
    if (value.note) violations.push(`pipeline: ${value.note}`);
    if (value.strokes.ok) {
      const event = value.strokes.value[0];
      if (
        event &&
        !(
          Number.isFinite(event.startMs) &&
          Number.isFinite(event.endMs) &&
          event.startMs < event.endMs
        )
      ) {
        violations.push("strokes: ok() with a non-finite or inverted window");
      }
      if (event && !inUnit(event.confidence)) violations.push("strokes: confidence not in [0,1]");
    }
    if (value.pose) violations.push(...checkResult(value.pose, "pose"));
    if (value.paddle) violations.push(...checkResult(value.paddle, "paddle"));
    if (value.phases) {
      violations.push(...checkResult(value.phases, "phases"));
      if (value.phases.ok && value.strokes.ok) {
        violations.push(...checkPhaseSpans(value.phases.value, value.strokes.value[0] ?? {}));
      }
    }
    if (value.features) {
      violations.push(...checkResult(value.features, "features"));
      if (value.features.ok) {
        violations.push(...checkMeasurements(value.features.value));
        if (built.expectAbstain) violations.push("features: ok() on fully non-finite input");
      }
    }
    if (value.ball !== undefined && value.ball !== null)
      violations.push("pipeline: ball tracker fabricated");
    return violations;
  },
  summarize(output) {
    const value = output as Record<string, unknown>;
    return ["strokes", "pose", "phases", "features"]
      .filter((key) => value[key] !== undefined)
      .map((key) => `${key}=${firstFailureCode(value[key])}`)
      .join(" ");
  },
};

const offlineWindow: Scenario = {
  id: "offline_stroke_window",
  target: "offlineStroke.ts:detectOfflineStrokeWindow",
  build(r) {
    const base = baseSwing(r);
    const result = mutated(base.sequence, r);
    return {
      input: result.value,
      mutations: result.mutations,
      expectAbstain: result.expectAbstain,
    };
  },
  run(input) {
    return detectOfflineStrokeWindow(input as PoseSequence);
  },
  check(output, built) {
    const violations = checkResult(output, "offline_window");
    const result = output as Result<{
      startMs: number;
      endMs: number;
      motionStartMs: number;
      motionEndMs: number;
      peakMotionMs: number;
      confidence: number;
    }>;
    if (isResult(result) && result.ok) {
      const w = result.value;
      const ordered =
        w.startMs <= w.motionStartMs &&
        w.motionStartMs <= w.peakMotionMs &&
        w.peakMotionMs <= w.motionEndMs &&
        w.motionEndMs <= w.endMs;
      if (!ordered)
        violations.push("offline_window: bounds not ordered start≤motionStart≤peak≤motionEnd≤end");
      if (!(w.confidence >= 0.05 && w.confidence <= 0.95)) {
        violations.push("offline_window: confidence outside [0.05,0.95]");
      }
      if (built.expectAbstain) violations.push("offline_window: ok() on fully non-finite input");
    }
    return violations;
  },
  summarize: firstFailureCode,
};

interface ContactInput {
  sequence: PoseSequence;
  window: { startMs: number; endMs: number; peakMotionMs: number | null };
  ballObservations: BallObservation[] | null;
  paddleSpeeds: Array<{ timestampMs: number; value: number }> | null;
  paddleCenters: Array<{ timestampMs: number; x: number; y: number }> | null;
  targetWrists: Array<{ timestampMs: number; x: number; y: number }> | null;
  strokeFamily: string | null;
  includeFusionKernels: boolean;
  paddleIdentityGate: boolean;
  paddleOwnershipConfidence: number | null;
  ownershipConditionedPosterior: boolean;
}

/**
 * estimateContact builds its fusion grid with
 * `for (tMs = gridStart; tMs <= gridEnd; tMs += 5)` where gridStart/gridEnd
 * come straight from `window.startMs/endMs` and the kernel timestamps
 * (src/offlineStroke.ts:1023-1037). A non-finite bound never terminates
 * (-Infinity + 5 === -Infinity) and a huge finite span allocates one object per
 * 5 ms — both kill the process, so the harness refuses such inputs and the
 * known-gaps test proves the OOM in a memory-capped child.
 */
const CONTACT_GRID_MAX_POINTS = 2_000_000;

function contactGridHazard(value: ContactInput): HarnessRefusal | null {
  const times: unknown[] = [value.window?.startMs, value.window?.endMs];
  const push = (series: unknown) => {
    if (!Array.isArray(series)) return;
    for (const item of series) {
      const t = (item as { timestampMs?: unknown } | null)?.timestampMs;
      if (typeof t === "number") times.push(t);
    }
  };
  push(value.sequence?.frames);
  push(value.ballObservations);
  push(value.paddleSpeeds);
  push(value.paddleCenters);
  push(value.targetWrists);
  const numeric = times.filter((t): t is number => typeof t === "number");
  if (numeric.some((t) => !Number.isFinite(t))) {
    // NaN bounds make the loop run zero times (then `grid.reduce` on an
    // empty array throws) — that path is safe to invoke; only ±Infinity hangs.
    const infinite = numeric.filter((t) => t === Infinity || t === -Infinity);
    if (infinite.length === 0) return null;
    return {
      harnessRefused: true,
      hazard: "contact_grid_unbounded",
      detail: `±Infinity in ${infinite.length} timestamp(s)/window bound(s) → fusion grid loop never terminates`,
    };
  }
  const span = Math.max(...numeric) - Math.min(...numeric);
  const points = span / 5;
  if (points > CONTACT_GRID_MAX_POINTS) {
    return {
      harnessRefused: true,
      hazard: "contact_grid_unbounded",
      detail: `span ${span.toExponential(2)} ms → ~${points.toExponential(2)} grid points`,
    };
  }
  return null;
}

const contactEstimator: Scenario = {
  id: "contact_estimator",
  target: "offlineStroke.ts:estimateContact",
  build(r) {
    const base = baseSwing(r);
    const wrist = wristTrack(base, "right_wrist");
    const paddleCenters = r.chance(0.6)
      ? wrist.map((point) => ({
          timestampMs: point.timestampMs,
          x: point.x + 0.03,
          y: point.y - 0.02,
        }))
      : null;
    const input: ContactInput = {
      sequence: base.sequence,
      window: {
        startMs: base.window.startMs,
        endMs: base.window.endMs,
        peakMotionMs: base.window.peakMs,
      },
      ballObservations: r.chance(0.7) ? syntheticBall(base, r) : null,
      paddleSpeeds: paddleCenters ? synthesizedSpeeds(paddleCenters) : null,
      paddleCenters,
      targetWrists: r.chance(0.5) ? wrist : null,
      strokeFamily: r.pick(["volley", "dink", "drive", "serve", "overhead", "unknown", null]),
      includeFusionKernels: r.chance(0.3),
      paddleIdentityGate: r.chance(0.5),
      paddleOwnershipConfidence: r.chance(0.5) ? r.next() : null,
      ownershipConditionedPosterior: r.chance(0.5),
    };
    const result = mutated(input, r, { max: 4 });
    return {
      input: result.value,
      mutations: result.mutations,
      expectAbstain: result.expectAbstain,
    };
  },
  run(input) {
    const value = input as ContactInput;
    const hazard = contactGridHazard(value);
    if (hazard) return hazard;
    return estimateContact({
      sequence: value.sequence,
      window: value.window,
      ballObservations: value.ballObservations,
      paddleSpeeds: value.paddleSpeeds,
      paddleCenters: value.paddleCenters,
      targetWrists: value.targetWrists,
      strokeFamily: value.strokeFamily as "unknown",
      includeFusionKernels: value.includeFusionKernels,
      paddleIdentityGate: value.paddleIdentityGate,
      paddleOwnershipConfidence: value.paddleOwnershipConfidence,
      ownershipConditionedPosterior: value.ownershipConditionedPosterior,
    });
  },
  check(output, built) {
    const window = (built.input as ContactInput).window ?? {};
    const violations = checkContact(output, window);
    if (built.expectAbstain && (output as ContactEstimate).status === "estimated") {
      violations.push("contact: estimated on fully non-finite input");
    }
    return violations;
  },
  summarize(output) {
    const value = output as ContactEstimate;
    return value.status === "estimated"
      ? `estimated:${value.confidence.toFixed(2)}`
      : `abstained:${value.reason}`;
  },
};

const paddleIdentity: Scenario = {
  id: "paddle_identity",
  target: "paddleTrackIdentity.ts:assessPaddleTrackIdentity",
  build(r) {
    const base = baseSwing(r);
    const right = wristTrack(base, "right_wrist");
    const left = wristTrack(base, "left_wrist");
    const input: PaddleTrackIdentityInput = {
      paddleCenters: right.map((point) => ({
        timestampMs: point.timestampMs,
        x: point.x + 0.03,
        y: point.y - 0.02,
      })),
      targetWristTracks: r.chance(0.5) ? [right, left] : [right],
      aspect: r.pick([1, 16 / 9, 9 / 16]),
      torsoSpan: r.pick([0.14, 0.2, 0.26]),
    };
    if (r.chance(0.5)) {
      input.otherWristTracks = [left.map((point) => ({ ...point, x: 1 - point.x }))];
    }
    const result = mutated(input, r);
    return {
      input: result.value,
      mutations: result.mutations,
      expectAbstain: result.expectAbstain,
    };
  },
  run(input) {
    return assessPaddleTrackIdentity(input as PaddleTrackIdentityInput);
  },
  check(output, built) {
    const violations: string[] = [];
    const value = output as {
      verdict?: unknown;
      evidence?: Record<string, unknown>;
      version?: unknown;
    } | null;
    if (!value || typeof value !== "object") return ["identity: not an object"];
    if (!["target_consistent", "foreign", "undetermined"].includes(String(value.verdict))) {
      violations.push(`identity: verdict invalid (${String(value.verdict)})`);
    }
    if (!value.evidence || typeof value.evidence !== "object")
      violations.push("identity: evidence missing");
    else {
      for (const key of [
        "targetActivityAtPaddlePeak",
        "paddleActivityAtTargetPeak",
        "targetSynchrony",
        "otherSynchrony",
      ]) {
        const entry = value.evidence[key];
        if (entry !== null && !(typeof entry === "number" && Number.isFinite(entry))) {
          violations.push(`identity: evidence.${key} not finite-or-null`);
        }
      }
      if (!Array.isArray(value.evidence.notes)) violations.push("identity: notes not an array");
    }
    if (built.expectAbstain && value.verdict !== "undetermined") {
      violations.push(`identity: ${String(value.verdict)} on fully non-finite input`);
    }
    return violations;
  },
  summarize(output) {
    return `verdict:${String((output as { verdict: string }).verdict)}`;
  },
};

interface StrokeInput {
  sequence: PoseSequence;
  window: { startMs: number; endMs: number };
  contactMs: number | null;
  eventPeakMs: number | null;
  handedness: string;
  paddle: Array<{
    timestampMs: number;
    center: { x: number; y: number };
    confidence?: number;
  }> | null;
  paddleSpeeds: Array<{ timestampMs: number; value: number }> | null;
  wristSpeeds: Array<{ timestampMs: number; value: number }> | null;
}

const strokeClassifier: Scenario = {
  id: "stroke_classifier",
  target: "strokeHeuristicLite.ts:classifyStroke",
  build(r) {
    const base = baseSwing(r);
    const wrist = wristTrack(base, "right_wrist");
    const paddle = r.chance(0.5)
      ? wrist.map((point) => {
          const observation: {
            timestampMs: number;
            center: { x: number; y: number };
            confidence?: number;
          } = { timestampMs: point.timestampMs, center: { x: point.x + 0.03, y: point.y - 0.02 } };
          if (r.chance(0.7)) observation.confidence = 0.5 + r.next() * 0.5;
          return observation;
        })
      : null;
    const input: StrokeInput = {
      sequence: base.sequence,
      window: { startMs: base.window.startMs, endMs: base.window.endMs },
      contactMs: r.chance(0.7) ? base.window.peakMs : null,
      eventPeakMs: r.chance(0.7) ? base.window.peakMs : null,
      handedness: r.pick(["right", "left", "ambidextrous"]),
      paddle,
      paddleSpeeds: paddle
        ? synthesizedSpeeds(paddle.map((p) => ({ timestampMs: p.timestampMs, ...p.center })))
        : null,
      wristSpeeds: r.chance(0.5) ? synthesizedSpeeds(wrist) : null,
    };
    const result = mutated(input, r, { max: 4 });
    return {
      input: result.value,
      mutations: result.mutations,
      expectAbstain: result.expectAbstain,
    };
  },
  run(input) {
    const value = input as StrokeInput;
    return classifyStroke({
      sequence: value.sequence,
      window: value.window,
      contactMs: value.contactMs,
      eventPeakMs: value.eventPeakMs,
      handedness: value.handedness as "right",
      paddle: value.paddle,
      paddleSpeeds: value.paddleSpeeds,
      wristSpeeds: value.wristSpeeds,
    });
  },
  check(output, built) {
    return checkPrediction(output, built.expectAbstain);
  },
  summarize(output) {
    const value = output as HeuristicStrokePrediction;
    return `label:${value.label}@${value.taxonomyDepth}:${value.confidence.toFixed(2)}`;
  },
};

interface OwnershipInput {
  sequence: PoseSequence;
  paddleCenters: Array<{ timestampMs: number; x: number; y: number }> | null;
  targetWrists: Array<{ timestampMs: number; x: number; y: number }> | null;
}

const paddleOwnership: Scenario = {
  id: "paddle_ownership",
  target: "offlineStroke.ts:paddleOwnershipFromHandAffinity",
  build(r) {
    const base = baseSwing(r);
    const wrist = wristTrack(base, "right_wrist");
    const input: OwnershipInput = {
      sequence: base.sequence,
      paddleCenters: r.chance(0.8)
        ? wrist.map((point) => ({
            timestampMs: point.timestampMs,
            x: point.x + 0.03,
            y: point.y - 0.02,
          }))
        : null,
      targetWrists: r.chance(0.5) ? wrist : null,
    };
    const result = mutated(input, r);
    return {
      input: result.value,
      mutations: result.mutations,
      expectAbstain: result.expectAbstain,
    };
  },
  run(input) {
    const value = input as OwnershipInput;
    return paddleOwnershipFromHandAffinity({
      sequence: value.sequence,
      paddleCenters: value.paddleCenters,
      targetWrists: value.targetWrists,
    });
  },
  check(output, built) {
    if (output === null) return [];
    const violations: string[] = [];
    const value = output as {
      confidence?: unknown;
      samplesMeasured?: unknown;
      samplesTotal?: unknown;
    };
    if (!inUnit(value.confidence)) violations.push("ownership: confidence not in [0,1]");
    if (
      typeof value.samplesMeasured !== "number" ||
      typeof value.samplesTotal !== "number" ||
      value.samplesMeasured > value.samplesTotal
    ) {
      violations.push("ownership: samplesMeasured > samplesTotal");
    }
    if (built.expectAbstain)
      violations.push("ownership: measured confidence on fully non-finite input");
    return violations;
  },
  summarize(output) {
    return output === null
      ? "null"
      : `confidence:${(output as { confidence: number }).confidence.toFixed(2)}`;
  },
};

// ── Oversized-series boundary probes (size ladder, deterministic) ───────────

const SIZE_LADDER = [1_000, 10_000, 50_000, 100_000, 124_000, 130_000, 200_000] as const;
const OVERSIZED_TARGETS = [
  "paddle_identity",
  "feature_extractor",
  "contact_estimator",
  "capture_quality",
  "offline_window",
] as const;
type OversizedTarget = (typeof OVERSIZED_TARGETS)[number];

interface OversizedInput {
  target: OversizedTarget;
  size: number;
}

/** Long idle-then-swing tracks: `size` samples at 30 fps with one swing at the end. */
export function longWrist(size: number): Array<{ timestampMs: number; x: number; y: number }> {
  return Array.from({ length: size }, (_, index) => {
    const swing = index > size - 40 ? Math.sin((index - (size - 40)) / 6) * 0.15 : 0;
    return { timestampMs: index * 33, x: 0.5 + swing, y: 0.6 + Math.sin(index / 50) * 0.002 };
  });
}

function longFrames(size: number): PoseFrame[] {
  const wrist = longWrist(size);
  return wrist.map((point) => ({
    timestampMs: point.timestampMs,
    space: "normalized-image" as const,
    confidence: 0.9,
    landmarks: [
      { name: "left_shoulder" as const, x: 0.45, y: 0.4, visibility: 0.9 },
      { name: "right_shoulder" as const, x: 0.55, y: 0.4, visibility: 0.9 },
      { name: "left_hip" as const, x: 0.46, y: 0.6, visibility: 0.9 },
      { name: "right_hip" as const, x: 0.54, y: 0.6, visibility: 0.9 },
      { name: "left_ankle" as const, x: 0.44, y: 0.9, visibility: 0.9 },
      { name: "right_ankle" as const, x: 0.56, y: 0.9, visibility: 0.9 },
      { name: "left_wrist" as const, x: 0.4, y: 0.62, visibility: 0.9 },
      { name: "right_wrist" as const, x: point.x, y: point.y, visibility: 0.9 },
    ],
  }));
}

function longSequence(size: number): PoseSequence {
  return {
    schemaVersion: 1,
    format: "pickle.pose-sequence.v1",
    coordinateSystem: "normalized_image_top_left",
    producedBy: { ...PRODUCER, modelVersion: "synthetic-long-1" },
    video: { width: 1080, height: 1080, fps: 30 },
    frames: longFrames(size).map((frame, index) => ({
      frameIndex: index,
      timestampMs: frame.timestampMs,
      confidence: frame.confidence,
      landmarks: frame.landmarks.map((mark) => ({ ...mark })),
    })),
  };
}

const oversizedSeries: Scenario = {
  id: "oversized_series",
  target:
    "paddleTrackIdentity.ts:280 / featureExtractor.ts:196 / offlineStroke.ts:1375 (Math.max(...spread)) + captureQuality/offlineStroke totals",
  maxIterations: SIZE_LADDER.length * OVERSIZED_TARGETS.length,
  build(_r, seed) {
    // Size-major order: every target at size 0, then every target at size 1,
    // … so a small STRESS_ITER still touches every target before the ladder
    // reaches the process-limit sizes.
    const ordinal = (seed - 1) % (SIZE_LADDER.length * OVERSIZED_TARGETS.length);
    const input: OversizedInput = {
      target: OVERSIZED_TARGETS[ordinal % OVERSIZED_TARGETS.length] as OversizedTarget,
      size: SIZE_LADDER[Math.floor(ordinal / OVERSIZED_TARGETS.length)] as number,
    };
    return {
      input,
      mutations: [
        { op: "duplicate_array_items", path: "$", detail: `${input.target}@${input.size}` },
      ],
      expectAbstain: false,
    };
  },
  async run(input) {
    const { target, size } = input as OversizedInput;
    switch (target) {
      case "paddle_identity": {
        // Short paddle track over the swing, long wrist track: speedSynchrony is
        // O(paddle × wrist) so this keeps the probe fast while the wrist speed
        // series still reaches the `Math.max(...series)` spread at :280.
        const wrist = longWrist(size);
        return assessPaddleTrackIdentity({
          paddleCenters: wrist
            .slice(-200)
            .map((p) => ({ timestampMs: p.timestampMs, x: p.x + 0.03, y: p.y })),
          targetWristTracks: [wrist],
          aspect: 1,
          torsoSpan: 0.2,
        });
      }
      case "feature_extractor": {
        const frames = longFrames(size);
        const last = frames[frames.length - 1]!.timestampMs;
        const span = (key: PhaseSpan["key"], startMs: number, endMs: number): PhaseSpan => ({
          key,
          startMs,
          representativeMs: (startMs + endMs) / 2,
          endMs,
          confidence: 0.9,
        });
        const extractor = new PoseGeometryFeatureExtractor({ aspectRatio: 1 });
        return extractor.extractMeasurements({
          poseFrames: frames,
          paddleFrames: [],
          phases: [
            span("ready", 0, 33),
            span("prepare", 33, 66),
            span("accelerate", 66, last - 66),
            span("contact", last - 66, last - 33),
            span("follow_through", last - 33, last),
            span("recover", last, last),
          ],
          shotType: "forehand_drive",
          handedness: "right",
          cameraView: "side",
        });
      }
      case "contact_estimator": {
        const sequence = longSequence(size);
        const last = sequence.frames[sequence.frames.length - 1]!.timestampMs;
        return estimateContact({
          sequence,
          window: { startMs: 0, endMs: last, peakMotionMs: last - 20 * 33 },
          ballObservations: null,
        });
      }
      case "capture_quality":
        return evaluateCaptureQuality(longSequence(size));
      case "offline_window":
        return detectOfflineStrokeWindow(longSequence(size));
    }
  },
  check(output, built) {
    const { target } = built.input as OversizedInput;
    switch (target) {
      case "paddle_identity":
        return paddleIdentity.check(output, built);
      case "feature_extractor": {
        const violations = checkResult(output, "features");
        const result = output as Result<unknown>;
        if (isResult(result) && result.ok) violations.push(...checkMeasurements(result.value));
        return violations;
      }
      case "contact_estimator":
        return checkContact(output, {});
      case "capture_quality":
        return checkGateReport(output, CAPTURE_QUALITY_REASONS, false);
      case "offline_window":
        return checkResult(output, "offline_window");
    }
  },
  summarize(output) {
    if (isResult(output)) return firstFailureCode(output);
    const value = output as { status?: string; verdict?: string; analyzable?: boolean };
    return value.status ?? value.verdict ?? `analyzable=${String(value.analyzable)}`;
  },
};

export const SCENARIOS: readonly Scenario[] = [
  wireIngress,
  frameStatsGate,
  captureQuality,
  phaseSegmenter,
  featureExtractor,
  recordedPipeline,
  offlineWindow,
  contactEstimator,
  paddleIdentity,
  strokeClassifier,
  paddleOwnership,
  oversizedSeries,
];
