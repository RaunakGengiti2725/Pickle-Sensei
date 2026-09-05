import { analyzeClip } from "@pickle/analysis-pipeline";
import { generateSwingSequence } from "@pickle/evaluation";
import { PHASES, type PhaseSpan, type Result } from "@pickle/shared-types";
import type { BallObservation, PoseSequence } from "@pickle/swing-domain";
import { toLegacyPoseFrames } from "@pickle/swing-domain";
import type { VideoClipRef } from "@pickle/vision-contracts";
import {
  assessPaddleTrackIdentity,
  classifyStroke,
  createGeometryProviderSet,
  detectOfflineStrokeWindow,
  estimateContact,
  evaluateCaptureQuality,
  evaluateFrameAnalyzability,
  FRAME_ANALYZABILITY_REASONS,
  GEOMETRY_BUNDLE_VERSION,
  GeometryBiomechanicsExtractor,
  IDENTITY,
  paddleOwnershipFromHandAffinity,
  STROKE_HEURISTIC_VERSION,
  STROKE_TAXONOMY_V3,
  type FrameStats,
  type TimedPoint,
} from "../../src/index.js";

/**
 * Seeded randomized long-run stress harness for @pickle/vision-geometry +
 * @pickle/vision-contracts (lens: randomized-seeded).
 *
 * Every sequence is derived from ONE 32-bit seed: the seed picks a synthetic
 * swing (the committed @pickle/evaluation generator — synthetic geometry, no
 * fabricated labels), then a list of 5..60 legal / near-legal ACTIONS over the
 * package's public API. Mutation actions degrade the working pose sequence
 * (noise, dropped frames, occlusion, decimation, truncation, time jitter,
 * unsorted frames, inverted windows, collapsed torso, foreign paddle tracks,
 * non-finite landmarks); query actions call the public API and model-check
 * the invariants documented in the source comments after EVERY step.
 *
 * Invariants checked (see `checkQuery`):
 *   finite      — no NaN / ±Infinity anywhere in any output
 *   no_throw    — public API returns a value (Result or report), never throws
 *   result_shape— failures carry kind/code/message/retryable
 *   pure        — a query never mutates its input sequence
 *   phases      — 6 ordered, non-negative spans in PHASES order, conf ∈ [0,1]
 *   measurements— finite values, conf ∈ [0,1], source "real", unique keys
 *   capture/frame quality — analyzable ⇔ reasons empty, closed reason sets
 *   offline_window — start ≤ peak ≤ end, conf ∈ [0,1]
 *   classify    — conf ∈ [0,1], depth ∈ {1,2,3}, leaf ∈ taxonomy, UNKNOWN ⇒
 *                 limitingFactors non-empty (bounded abstention)
 *   contact     — estimated ⇒ conf ∈ [0,1] and inside window; abstained ⇒
 *                 non-empty reason
 *   identity    — closed verdict set; foreign ⇒ documented IDENTITY gates
 *   ownership   — conf ∈ [0,1], samplesMeasured ≤ samplesTotal
 *   analysis    — scored ⇔ overallScore ∈ [0,10]; low_confidence ⇒ null score
 *   biomech_eq  — GeometryBiomechanicsExtractor ≡ PoseGeometryFeatureExtractor
 *   determinism — the same seed replayed produces a byte-identical trace
 *
 * Cancellation: none of the public provider methods accept an AbortSignal
 * (verified by reading packages/vision-contracts/src/contracts.ts), so the
 * "cancellation honoured" property is NOT APPLICABLE to this unit and is
 * recorded as such rather than as a pass.
 */

// ---------------------------------------------------------------------------
// Seeded RNG (splitmix32) — deterministic, replayable, no Math.random.
// ---------------------------------------------------------------------------

export class Rng {
  private state: number;

  public constructor(seed: number) {
    this.state = seed >>> 0;
  }

  public nextU32(): number {
    this.state = (this.state + 0x9e3779b9) >>> 0;
    let z = this.state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  }

  /** Uniform in [0, 1). */
  public float(): number {
    return this.nextU32() / 4294967296;
  }

  public range(min: number, max: number): number {
    return min + (max - min) * this.float();
  }

  public int(min: number, maxInclusive: number): number {
    return min + Math.floor(this.float() * (maxInclusive - min + 1));
  }

  public bool(probability = 0.5): boolean {
    return this.float() < probability;
  }

  public pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)] as T;
  }

  /** Approximately normal(0, 1) via Box–Muller. */
  public gaussian(): number {
    const u = Math.max(this.float(), 1e-12);
    const v = this.float();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type Action =
  | { kind: "noise"; sigma: number }
  | { kind: "drop_frames"; fraction: number; salt: number }
  | { kind: "occlude"; joints: string[]; from: number; to: number }
  | { kind: "dim_visibility"; factor: number }
  | { kind: "decimate"; factor: number }
  | { kind: "truncate"; keep: number }
  | { kind: "time_jitter"; ms: number; salt: number }
  | { kind: "shuffle_frames"; salt: number }
  | { kind: "duplicate_frame"; index: number }
  | { kind: "shift_window"; dStart: number; dEnd: number; dropPeak: boolean }
  | { kind: "collapse_torso" }
  | { kind: "inject_nonfinite"; value: "nan" | "inf" | "-inf"; target: "x" | "y" | "visibility" }
  | { kind: "reset" }
  | { kind: "paddle_on_wrist"; offset: number; sigma: number; confidence: number | null }
  | { kind: "paddle_foreign"; shiftMs: number; offset: number }
  | { kind: "paddle_drop" }
  | { kind: "ball_near_contact"; speed: number; sigma: number }
  | { kind: "ball_drop" }
  | { kind: "q_capture_quality" }
  | { kind: "q_frame_analyzability"; stats: FrameStats }
  | { kind: "q_offline_window" }
  | { kind: "q_classify"; useContact: boolean; declared: "left" | "right" }
  | {
      kind: "q_estimate_contact";
      family: "unknown" | "drive" | "dink" | "volley" | "serve" | "overhead";
      identityGate: boolean;
      ownershipPosterior: boolean;
      ownershipConfidence: number | null;
      kernels: boolean;
    }
  | { kind: "q_paddle_identity"; includeOther: boolean }
  | { kind: "q_ownership" }
  | { kind: "q_provider_chain"; shotType: ShotType; handedness: "left" | "right" }
  | { kind: "q_analyze_clip"; shotType: ShotType; handedness: "left" | "right" };

type ShotType = "forehand_drive" | "dink" | "third_shot_drop" | "serve";
const SHOT_TYPES: readonly ShotType[] = ["forehand_drive", "dink", "third_shot_drop", "serve"];
const LEGACY_JOINTS = [
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
] as const;

export const QUERY_KINDS = [
  "q_capture_quality",
  "q_frame_analyzability",
  "q_offline_window",
  "q_classify",
  "q_estimate_contact",
  "q_paddle_identity",
  "q_ownership",
  "q_provider_chain",
  "q_analyze_clip",
] as const;

export function isQuery(action: Action): boolean {
  return action.kind.startsWith("q_");
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

interface Window {
  startMs: number;
  endMs: number;
  peakMotionMs: number | null;
}

interface World {
  readonly base: PoseSequence;
  readonly baseWindow: Window;
  readonly handed: "left" | "right";
  seq: PoseSequence;
  window: Window;
  paddle: Array<TimedPoint & { confidence?: number }> | null;
  ball: BallObservation[] | null;
  nonFiniteInjected: boolean;
}

function cloneSequence(sequence: PoseSequence): PoseSequence {
  return {
    ...sequence,
    video: { ...sequence.video },
    producedBy: { ...sequence.producedBy },
    frames: sequence.frames.map((frame) => ({
      ...frame,
      landmarks: frame.landmarks.map((mark) => ({ ...mark })),
    })),
  };
}

export interface SequencePlan {
  seed: number;
  swing: Record<string, number | string>;
  actions: Action[];
}

/** Draw the synthetic swing + the full action list from the seed up front, so
 *  the plan itself is the replayable artifact (and can be minimized). */
export function planSequence(seed: number, minLen: number, maxLen: number): SequencePlan {
  const rng = new Rng(seed);
  const handed = rng.bool() ? "right" : "left";
  const swing = {
    handed,
    fps: rng.pick([24, 30, 30, 60]),
    torsoLength: rng.range(0.06, 0.5),
    stanceWidthRatio: rng.range(0.8, 2.2),
    kneeFlexionDeg: rng.range(0, 60),
    contactForwardNorm: rng.range(-0.3, 0.9),
    contactHeightRatio: rng.range(0.1, 1.2),
    backswingLengthNorm: rng.range(0.2, 1.6),
    swingDipNorm: rng.range(0, 0.5),
    shoulderTurnDeg: rng.range(0, 70),
    readyMs: rng.int(100, 900),
    backswingMs: rng.int(100, 900),
    accelerateMs: rng.int(60, 500),
    followMs: rng.int(60, 600),
    recoverMs: rng.int(100, 900),
  } satisfies Record<string, number | string>;
  const length = rng.int(minLen, maxLen);
  const actions: Action[] = [];
  for (let index = 0; index < length; index += 1) {
    actions.push(drawAction(rng, index === length - 1));
  }
  return { seed, swing, actions };
}

function drawAction(rng: Rng, forceQuery: boolean): Action {
  const roll = forceQuery ? 1 : rng.float();
  if (roll < 0.42) {
    // Mutation.
    const m = rng.float();
    if (m < 0.14) return { kind: "noise", sigma: rng.range(0.0005, 0.03) };
    if (m < 0.25)
      return { kind: "drop_frames", fraction: rng.range(0.03, 0.6), salt: rng.nextU32() };
    if (m < 0.36) {
      const count = rng.int(1, 4);
      const joints: string[] = [];
      for (let i = 0; i < count; i += 1) joints.push(rng.pick(LEGACY_JOINTS));
      const from = rng.float();
      return { kind: "occlude", joints, from, to: Math.min(1, from + rng.range(0.05, 0.6)) };
    }
    if (m < 0.43) return { kind: "dim_visibility", factor: rng.range(0.05, 0.9) };
    if (m < 0.5) return { kind: "decimate", factor: rng.int(2, 4) };
    if (m < 0.56) return { kind: "truncate", keep: rng.int(0, 13) };
    if (m < 0.63) return { kind: "time_jitter", ms: rng.range(1, 40), salt: rng.nextU32() };
    if (m < 0.66) return { kind: "shuffle_frames", salt: rng.nextU32() };
    if (m < 0.7) return { kind: "duplicate_frame", index: rng.nextU32() };
    if (m < 0.78) {
      return {
        kind: "shift_window",
        dStart: rng.range(-400, 400),
        dEnd: rng.range(-400, 400),
        dropPeak: rng.bool(0.3),
      };
    }
    if (m < 0.81) return { kind: "collapse_torso" };
    if (m < 0.84) {
      return {
        kind: "inject_nonfinite",
        value: rng.pick(["nan", "inf", "-inf"]),
        target: rng.pick(["x", "y", "visibility"]),
      };
    }
    if (m < 0.9) return { kind: "reset" };
    return { kind: "paddle_drop" };
  }
  if (roll < 0.55) {
    // Auxiliary tracks.
    const a = rng.float();
    if (a < 0.4) {
      return {
        kind: "paddle_on_wrist",
        offset: rng.range(0, 0.25),
        sigma: rng.range(0, 0.02),
        confidence: rng.bool(0.3) ? null : rng.range(0, 1),
      };
    }
    if (a < 0.6)
      return { kind: "paddle_foreign", shiftMs: rng.range(-900, 900), offset: rng.range(0, 0.4) };
    if (a < 0.85)
      return { kind: "ball_near_contact", speed: rng.range(0.1, 3), sigma: rng.range(0, 0.03) };
    return { kind: "ball_drop" };
  }
  // Query.
  const q = rng.pick(QUERY_KINDS);
  switch (q) {
    case "q_capture_quality":
    case "q_offline_window":
    case "q_ownership":
      return { kind: q };
    case "q_frame_analyzability":
      return { kind: q, stats: drawFrameStats(rng) };
    case "q_classify":
      return { kind: q, useContact: rng.bool(0.7), declared: rng.bool() ? "right" : "left" };
    case "q_estimate_contact":
      return {
        kind: q,
        family: rng.pick(["unknown", "drive", "dink", "volley", "serve", "overhead"]),
        identityGate: rng.bool(),
        ownershipPosterior: rng.bool(),
        ownershipConfidence: rng.bool(0.4) ? null : rng.range(-0.2, 1.2),
        kernels: rng.bool(0.3),
      };
    case "q_paddle_identity":
      return { kind: q, includeOther: rng.bool() };
    case "q_provider_chain":
    case "q_analyze_clip":
      return { kind: q, shotType: rng.pick(SHOT_TYPES), handedness: rng.bool() ? "right" : "left" };
  }
}

function drawFrameStats(rng: Rng): FrameStats {
  const frameCount = rng.bool(0.1) ? rng.int(0, 2) : rng.int(2, 900);
  const pairs = Math.max(0, frameCount - 1);
  const frozenBias = rng.float();
  const interFrameDiffs: number[] = [];
  const spatialLumaStd: number[] = [];
  for (let i = 0; i < pairs; i += 1) {
    interFrameDiffs.push(rng.bool(frozenBias) ? rng.range(0, 0.02) : rng.range(0.02, 40));
  }
  for (let i = 0; i < frameCount; i += 1) spatialLumaStd.push(rng.range(0, 80));
  const stats: FrameStats = {
    frameCount,
    durationMs: rng.bool(0.1) ? 0 : rng.range(50, 15 * 60 * 1000),
    width: rng.pick([0, 240, 720, 1080, 1920]),
    height: rng.pick([0, 240, 720, 1280, 1920]),
    interFrameDiffs,
    spatialLumaStd,
    letterboxRowFraction: rng.range(0, 1),
  };
  if (rng.bool(0.5))
    stats.borderRing = { temporalStd: rng.range(0, 5), meanLuma: rng.range(0, 255) };
  if (rng.bool(0.5)) {
    const components: Array<{ size: number; lumaStd: number }> = [];
    const count = rng.int(0, 4);
    for (let i = 0; i < count; i += 1) {
      components.push({ size: rng.int(0, 40), lumaStd: rng.range(0, 40) });
    }
    stats.bottomFrozenComponents = components;
  }
  if (rng.bool(0.5)) stats.source = { width: rng.int(0, 4000), height: rng.int(0, 4000) };
  if (rng.bool(0.5)) {
    stats.decode = {
      errorCount: rng.int(0, 20),
      expectedFrameCount: rng.bool(0.3) ? null : rng.int(0, 1200),
    };
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface Violation {
  step: number;
  action: string;
  invariant: string;
  detail: string;
  /** True when the working sequence carried an injected NaN/Infinity. */
  inputNonFinite: boolean;
}

export interface StepTrace {
  step: number;
  action: string;
  outcome: string;
}

export interface SequenceOutcome {
  seed: number;
  length: number;
  queries: number;
  outcome: "held" | "violated";
  violations: Violation[];
  trace: StepTrace[];
  traceHash: string;
  durationMs: number;
}

/** Deep finiteness walk; returns the first offending path or null. */
export function findNonFinite(value: unknown, path = "$"): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? null : `${path}=${String(value)}`;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findNonFinite(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const hit = findNonFinite(entry, `${path}.${key}`);
      if (hit) return hit;
    }
  }
  return null;
}

/** JSON with NaN/±Infinity preserved as tagged strings (JSON.stringify would
 *  silently turn them into null and hide them from the trace). */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (typeof entry === "number" && !Number.isFinite(entry)) return `<${String(entry)}>`;
    if (entry instanceof Map) return Object.fromEntries(entry);
    return entry;
  });
}

export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
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
const CAPTURE_REASONS = new Set([
  "too_few_pose_frames",
  "insufficient_fps",
  "low_pose_confidence",
  "body_not_fully_visible",
  "torso_not_measured",
  "player_too_small_in_frame",
  "player_too_close_or_cropped",
  "tracking_dropout_gap",
]);
const FRAME_REASONS = new Set<string>(FRAME_ANALYZABILITY_REASONS);
const FRAME_NOT_EVALUATED = new Set([
  "camera_motion",
  "scene_cuts",
  "exposure_flicker",
  "playback_speed",
  "static_border_frame",
  "static_overlay_suspected",
  "source_aspect_ratio",
  "decode_integrity",
]);
const IDENTITY_VERDICTS = new Set(["target_consistent", "foreign", "undetermined"]);
const STROKE_LABELS = new Set<string>(STROKE_TAXONOMY_V3.labels);

function inUnit(value: unknown): boolean {
  return typeof value === "number" && value >= 0 && value <= 1;
}

function checkResultShape(result: unknown, add: (inv: string, detail: string) => void): boolean {
  if (
    !result ||
    typeof result !== "object" ||
    typeof (result as { ok?: unknown }).ok !== "boolean"
  ) {
    add("result_shape", `not a Result: ${stableJson(result).slice(0, 200)}`);
    return false;
  }
  const r = result as Result<unknown>;
  if (!r.ok) {
    const f = r.failure;
    if (!f || !FAILURE_KINDS.has(f.kind))
      add("result_shape", `failure.kind invalid: ${stableJson(f)}`);
    if (!f || typeof f.code !== "string" || f.code.length === 0)
      add("result_shape", "failure.code empty");
    if (!f || typeof f.message !== "string" || f.message.length === 0) {
      add("result_shape", "failure.message empty");
    }
    if (!f || typeof f.retryable !== "boolean")
      add("result_shape", "failure.retryable not boolean");
  }
  return true;
}

function checkPhases(
  phases: PhaseSpan[],
  startMs: number,
  add: (inv: string, detail: string) => void,
): void {
  if (phases.length !== PHASES.length) {
    add("phases", `expected ${PHASES.length} spans, got ${phases.length}`);
    return;
  }
  let cursor = startMs;
  phases.forEach((span, index) => {
    if (span.key !== PHASES[index])
      add("phases", `span ${index} key ${span.key} ≠ ${PHASES[index]}`);
    if (span.startMs < cursor - 1e-9)
      add("phases", `${span.key}.startMs ${span.startMs} < cursor ${cursor}`);
    if (span.endMs < span.startMs)
      add("phases", `${span.key} negative span ${span.startMs}..${span.endMs}`);
    if (span.representativeMs < span.startMs || span.representativeMs > span.endMs) {
      add("phases", `${span.key}.representativeMs ${span.representativeMs} outside span`);
    }
    if (!inUnit(span.confidence))
      add("phases", `${span.key}.confidence ${span.confidence} ∉ [0,1]`);
    cursor = span.endMs;
  });
}

function checkMeasurements(
  measurements: Array<{ metricKey: string; value: number; confidence: number; source: string }>,
  add: (inv: string, detail: string) => void,
): void {
  const keys = new Set<string>();
  for (const m of measurements) {
    if (!Number.isFinite(m.value)) add("measurements", `${m.metricKey} value ${String(m.value)}`);
    if (!inUnit(m.confidence)) add("measurements", `${m.metricKey} confidence ${m.confidence}`);
    if (m.source !== "real") add("measurements", `${m.metricKey} source ${m.source}`);
    if (keys.has(m.metricKey)) add("measurements", `duplicate metricKey ${m.metricKey}`);
    keys.add(m.metricKey);
  }
}

function dominantWrist(world: World): "left_wrist" | "right_wrist" {
  return world.handed === "right" ? "right_wrist" : "left_wrist";
}

function wristTrack(sequence: PoseSequence, name: string): TimedPoint[] {
  const out: TimedPoint[] = [];
  for (const frame of sequence.frames) {
    const mark = frame.landmarks.find((m) => m.name === name);
    if (mark) out.push({ timestampMs: frame.timestampMs, x: mark.x, y: mark.y });
  }
  return out;
}

function applyMutation(world: World, action: Action, rng: Rng): void {
  const seq = world.seq;
  switch (action.kind) {
    case "noise": {
      for (const frame of seq.frames) {
        for (const mark of frame.landmarks) {
          mark.x += rng.gaussian() * action.sigma;
          mark.y += rng.gaussian() * action.sigma;
        }
      }
      return;
    }
    case "drop_frames": {
      const local = new Rng(action.salt);
      const kept = seq.frames.filter(() => !local.bool(action.fraction));
      seq.frames = kept.map((frame, index) => ({ ...frame, frameIndex: index }));
      return;
    }
    case "occlude": {
      const n = seq.frames.length;
      const from = Math.floor(action.from * n);
      const to = Math.floor(action.to * n);
      const joints = new Set(action.joints);
      for (let i = from; i < to && i < n; i += 1) {
        const frame = seq.frames[i]!;
        frame.landmarks = frame.landmarks.filter((m) => !joints.has(m.name));
      }
      return;
    }
    case "dim_visibility": {
      for (const frame of seq.frames) {
        frame.confidence *= action.factor;
        for (const mark of frame.landmarks) mark.visibility *= action.factor;
      }
      return;
    }
    case "decimate": {
      seq.frames = seq.frames.filter((_f, i) => i % action.factor === 0);
      return;
    }
    case "truncate": {
      seq.frames = seq.frames.slice(0, action.keep);
      return;
    }
    case "time_jitter": {
      const local = new Rng(action.salt);
      for (const frame of seq.frames) frame.timestampMs += (local.float() * 2 - 1) * action.ms;
      seq.frames.sort((a, b) => a.timestampMs - b.timestampMs);
      return;
    }
    case "shuffle_frames": {
      const local = new Rng(action.salt);
      for (let i = seq.frames.length - 1; i > 0; i -= 1) {
        const j = local.int(0, i);
        const tmp = seq.frames[i]!;
        seq.frames[i] = seq.frames[j]!;
        seq.frames[j] = tmp;
      }
      return;
    }
    case "duplicate_frame": {
      if (seq.frames.length === 0) return;
      const index = action.index % seq.frames.length;
      const copy = {
        ...seq.frames[index]!,
        landmarks: seq.frames[index]!.landmarks.map((m) => ({ ...m })),
      };
      seq.frames.splice(index, 0, copy);
      return;
    }
    case "shift_window": {
      world.window = {
        startMs: world.window.startMs + action.dStart,
        endMs: world.window.endMs + action.dEnd,
        peakMotionMs: action.dropPeak ? null : world.window.peakMotionMs,
      };
      return;
    }
    case "collapse_torso": {
      for (const frame of seq.frames) {
        const ls = frame.landmarks.find((m) => m.name === "left_shoulder");
        const rs = frame.landmarks.find((m) => m.name === "right_shoulder");
        for (const mark of frame.landmarks) {
          if (mark.name === "left_hip" && ls) {
            mark.x = ls.x;
            mark.y = ls.y;
          }
          if (mark.name === "right_hip" && rs) {
            mark.x = rs.x;
            mark.y = rs.y;
          }
        }
      }
      return;
    }
    case "inject_nonfinite": {
      if (seq.frames.length === 0) return;
      const frame = rng.pick(seq.frames);
      if (frame.landmarks.length === 0) return;
      const mark = rng.pick(frame.landmarks);
      const value =
        action.value === "nan" ? Number.NaN : action.value === "inf" ? Infinity : -Infinity;
      mark[action.target] = value;
      world.nonFiniteInjected = true;
      return;
    }
    case "reset": {
      world.seq = cloneSequence(world.base);
      world.window = { ...world.baseWindow };
      world.nonFiniteInjected = false;
      return;
    }
    case "paddle_on_wrist": {
      const track = wristTrack(seq, dominantWrist(world));
      world.paddle = track.map((p) => {
        const point: TimedPoint & { confidence?: number } = {
          timestampMs: p.timestampMs,
          x: p.x + action.offset + rng.gaussian() * action.sigma,
          y: p.y - action.offset * 0.5 + rng.gaussian() * action.sigma,
        };
        if (action.confidence !== null) point.confidence = action.confidence;
        return point;
      });
      return;
    }
    case "paddle_foreign": {
      const other = dominantWrist(world) === "right_wrist" ? "left_wrist" : "right_wrist";
      const track = wristTrack(seq, other);
      world.paddle = track.map((p) => ({
        timestampMs: p.timestampMs + action.shiftMs,
        x: p.x + action.offset,
        y: p.y,
        confidence: 0.7,
      }));
      return;
    }
    case "paddle_drop":
      world.paddle = null;
      return;
    case "ball_near_contact": {
      const contact = world.window.peakMotionMs ?? (world.window.startMs + world.window.endMs) / 2;
      const wrist = wristTrack(seq, dominantWrist(world));
      const anchor = wrist.reduce<TimedPoint | null>(
        (best, p) =>
          best === null || Math.abs(p.timestampMs - contact) < Math.abs(best.timestampMs - contact)
            ? p
            : best,
        null,
      ) ?? { timestampMs: contact, x: 0.5, y: 0.5 };
      const ball: BallObservation[] = [];
      const fps = seq.video.fps > 0 ? seq.video.fps : 30;
      const stepMs = 1000 / fps;
      for (let k = -12; k <= 12; k += 1) {
        const t = contact + k * stepMs;
        const dir = k < 0 ? -1 : 1;
        ball.push({
          frameIndex: k + 12,
          timestampMs: t,
          x:
            anchor.x +
            (dir * action.speed * Math.abs(k) * stepMs) / 1000 +
            rng.gaussian() * action.sigma,
          y: anchor.y + rng.gaussian() * action.sigma,
          confidence: rng.range(0.3, 1),
        });
      }
      world.ball = ball;
      return;
    }
    case "ball_drop":
      world.ball = null;
      return;
    default:
      return;
  }
}

async function runQuery(
  world: World,
  action: Action,
  add: (inv: string, detail: string) => void,
): Promise<unknown> {
  const seq = world.seq;
  switch (action.kind) {
    case "q_capture_quality": {
      const report = evaluateCaptureQuality(seq);
      if (report.analyzable !== (report.reasons.length === 0)) {
        add(
          "capture_quality",
          `analyzable=${report.analyzable} with reasons=${stableJson(report.reasons)}`,
        );
      }
      for (const reason of report.reasons) {
        if (!CAPTURE_REASONS.has(reason)) add("capture_quality", `unknown reason ${reason}`);
      }
      return report;
    }
    case "q_frame_analyzability": {
      const report = evaluateFrameAnalyzability(action.stats);
      if (report.analyzable !== (report.reasons.length === 0)) {
        add(
          "frame_analyzability",
          `analyzable=${report.analyzable} with reasons=${stableJson(report.reasons)}`,
        );
      }
      for (const reason of report.reasons) {
        if (!FRAME_REASONS.has(reason)) add("frame_analyzability", `unknown reason ${reason}`);
      }
      for (const reason of report.notEvaluated) {
        if (!FRAME_NOT_EVALUATED.has(reason))
          add("frame_analyzability", `unknown notEvaluated ${reason}`);
      }
      return report;
    }
    case "q_offline_window": {
      const result = detectOfflineStrokeWindow(seq);
      if (checkResultShape(result, add) && result.ok) {
        const w = result.value;
        if (!(w.startMs <= w.peakMotionMs && w.peakMotionMs <= w.endMs)) {
          add(
            "offline_window",
            `start ${w.startMs} ≤ peak ${w.peakMotionMs} ≤ end ${w.endMs} violated`,
          );
        }
        if (!inUnit(w.confidence)) add("offline_window", `confidence ${w.confidence}`);
      }
      return result;
    }
    case "q_classify": {
      const prediction = classifyStroke({
        sequence: seq,
        window: { startMs: world.window.startMs, endMs: world.window.endMs },
        contactMs: action.useContact ? world.window.peakMotionMs : null,
        eventPeakMs: world.window.peakMotionMs,
        handedness: action.declared,
        paddle: world.paddle
          ? world.paddle.map((p) => ({
              timestampMs: p.timestampMs,
              center: { x: p.x, y: p.y },
              ...(p.confidence !== undefined ? { confidence: p.confidence } : {}),
            }))
          : null,
        paddleSpeeds: world.paddle ? speedsOf(world.paddle) : null,
        wristSpeeds: null,
      });
      if (!inUnit(prediction.confidence)) add("classify", `confidence ${prediction.confidence}`);
      if (![1, 2, 3].includes(prediction.taxonomyDepth))
        add("classify", `depth ${prediction.taxonomyDepth}`);
      if (prediction.leaf !== null && !STROKE_LABELS.has(prediction.leaf)) {
        add("classify", `leaf ${prediction.leaf} not in taxonomy`);
      }
      if (prediction.label === "UNKNOWN") {
        if (prediction.leaf !== null && prediction.leaf !== "UNKNOWN") {
          add("classify", `UNKNOWN with leaf ${prediction.leaf}`);
        }
        if (prediction.limitingFactors.length === 0)
          add("classify", "UNKNOWN without limitingFactors");
      } else if (prediction.leaf === "UNKNOWN") {
        add("classify", `label ${prediction.label} with leaf UNKNOWN`);
      }
      if (prediction.taxonomyVersion !== STROKE_TAXONOMY_V3.version) {
        add("classify", `taxonomyVersion ${prediction.taxonomyVersion}`);
      }
      if (prediction.classifierVersion !== STROKE_HEURISTIC_VERSION) {
        add("classify", `classifierVersion ${prediction.classifierVersion}`);
      }
      return prediction;
    }
    case "q_estimate_contact": {
      const estimate = estimateContact({
        sequence: seq,
        window: world.window,
        ballObservations: world.ball,
        paddleSpeeds: world.paddle ? speedsOf(world.paddle) : null,
        paddleCenters: world.paddle,
        targetWrists: wristTrack(seq, dominantWrist(world)),
        strokeFamily: action.family,
        includeFusionKernels: action.kernels,
        paddleIdentityGate: action.identityGate,
        ownershipConditionedPosterior: action.ownershipPosterior,
        paddleOwnershipConfidence: action.ownershipConfidence,
      });
      if (estimate.status === "estimated") {
        if (!inUnit(estimate.confidence)) add("contact", `confidence ${estimate.confidence}`);
        // estimateContact admits ball evidence up to 250ms beyond the window
        // and extends its density grid to cover every kernel (offlineStroke.ts
        // ball filter + gridStart/gridEnd), so the fused moment may sit within
        // that grace band outside the trigger window.
        const grace = 250;
        const lo = Math.min(world.window.startMs, world.window.endMs) - grace;
        const hi = Math.max(world.window.startMs, world.window.endMs) + grace;
        if (estimate.estimatedContactMs < lo || estimate.estimatedContactMs > hi) {
          add(
            "contact",
            `estimatedContactMs ${estimate.estimatedContactMs} outside window±${grace} ${lo}..${hi}`,
          );
        }
        for (const s of estimate.supportingEvidence) {
          if (!inUnit(s.weight)) add("contact", `evidence weight ${s.weight}`);
        }
        for (const m of estimate.modes ?? []) {
          if (!inUnit(m.share)) add("contact", `mode share ${m.share}`);
        }
      } else if (estimate.status === "abstained") {
        if (typeof estimate.reason !== "string" || estimate.reason.length === 0) {
          add("contact", "abstained without reason");
        }
      } else {
        add("contact", `unknown status ${stableJson(estimate).slice(0, 120)}`);
      }
      return estimate;
    }
    case "q_paddle_identity": {
      const target = [wristTrack(seq, dominantWrist(world))];
      const otherName = dominantWrist(world) === "right_wrist" ? "left_wrist" : "right_wrist";
      const aspect = seq.video.height > 0 ? seq.video.width / seq.video.height : 1;
      const assessment = assessPaddleTrackIdentity({
        paddleCenters: world.paddle ?? [],
        targetWristTracks: target,
        ...(action.includeOther ? { otherWristTracks: [wristTrack(seq, otherName)] } : {}),
        aspect,
        torsoSpan: 0.2,
      });
      if (!IDENTITY_VERDICTS.has(assessment.verdict))
        add("identity", `verdict ${assessment.verdict}`);
      const e = assessment.evidence;
      if (assessment.verdict === "foreign") {
        if (e.peakSeparationMs !== null && e.peakSeparationMs < IDENTITY.minPeakSeparationMs) {
          add(
            "identity",
            `foreign with peakSeparationMs ${e.peakSeparationMs} < ${IDENTITY.minPeakSeparationMs}`,
          );
        }
        if (e.targetSynchrony !== null && e.targetSynchrony > IDENTITY.synchronyForeignCeiling) {
          add("identity", `foreign with targetSynchrony ${e.targetSynchrony}`);
        }
        if (e.paddleSpeedSamples < IDENTITY.minSpeedSamples) {
          add("identity", `foreign with paddleSpeedSamples ${e.paddleSpeedSamples}`);
        }
      }
      if (e.targetActivityAtPaddlePeak !== null && !inUnit(e.targetActivityAtPaddlePeak)) {
        add("identity", `targetActivityAtPaddlePeak ${e.targetActivityAtPaddlePeak}`);
      }
      if (e.paddleActivityAtTargetPeak !== null && !inUnit(e.paddleActivityAtTargetPeak)) {
        add("identity", `paddleActivityAtTargetPeak ${e.paddleActivityAtTargetPeak}`);
      }
      if (e.paddleSamples !== (world.paddle ?? []).length) {
        add("identity", `paddleSamples ${e.paddleSamples} ≠ ${(world.paddle ?? []).length}`);
      }
      return assessment;
    }
    case "q_ownership": {
      const ownership = paddleOwnershipFromHandAffinity({
        sequence: seq,
        paddleCenters: world.paddle,
        targetWrists: wristTrack(seq, dominantWrist(world)),
      });
      if (ownership !== null) {
        if (!inUnit(ownership.confidence)) add("ownership", `confidence ${ownership.confidence}`);
        if (ownership.samplesMeasured > ownership.samplesTotal) {
          add(
            "ownership",
            `samplesMeasured ${ownership.samplesMeasured} > total ${ownership.samplesTotal}`,
          );
        }
        if (ownership.samplesTotal !== (world.paddle ?? []).length) {
          add(
            "ownership",
            `samplesTotal ${ownership.samplesTotal} ≠ ${(world.paddle ?? []).length}`,
          );
        }
      }
      return ownership;
    }
    case "q_provider_chain": {
      const { providers, clip } = buildProviders(world);
      const strokes = await providers.stroke.detectStrokes(clip);
      checkResultShape(strokes, add);
      if (!strokes.ok) return { strokes };
      const stroke = strokes.value[0];
      if (!stroke) {
        add("provider_chain", "detectStrokes ok with zero events");
        return { strokes };
      }
      if (!inUnit(stroke.confidence))
        add("provider_chain", `stroke confidence ${stroke.confidence}`);
      if (stroke.endMs <= stroke.startMs)
        add("provider_chain", `stroke window ${stroke.startMs}..${stroke.endMs}`);
      const window = { startMs: stroke.startMs, endMs: stroke.endMs };
      const pose = await providers.pose.extractPose(clip, window);
      const paddle = await providers.paddle.detectPaddle(clip, window);
      checkResultShape(pose, add);
      checkResultShape(paddle, add);
      if (!pose.ok || !paddle.ok) return { strokes, pose, paddle };
      for (const frame of pose.value) {
        if (frame.timestampMs < window.startMs || frame.timestampMs > window.endMs) {
          add("provider_chain", `extractPose frame ${frame.timestampMs} outside window`);
          break;
        }
      }
      const phases = await providers.phase.segmentPhases(pose.value, paddle.value, stroke);
      checkResultShape(phases, add);
      if (!phases.ok) return { strokes, pose: pose.value.length, paddle, phases };
      checkPhases(phases.value, stroke.startMs, add);
      const features = await providers.features.extractMeasurements({
        poseFrames: pose.value,
        paddleFrames: paddle.value,
        phases: phases.value,
        shotType: action.shotType,
        handedness: action.handedness,
        cameraView: "side",
      });
      checkResultShape(features, add);
      if (features.ok) checkMeasurements(features.value, add);
      // PoseSequence.frames is documented ascending (swing-domain observations.ts);
      // RecordedPoseProvider sorts defensively, the biomech port does not, so
      // hand it in-contract (sorted) frames for the equivalence check.
      const biomech = await new GeometryBiomechanicsExtractor().extract({
        pose: {
          ...seq,
          frames: seq.frames
            .filter((f) => f.timestampMs >= window.startMs && f.timestampMs <= window.endMs)
            .sort((a, b) => a.timestampMs - b.timestampMs),
        },
        paddle: null,
        phases: phases.value,
        shotType: action.shotType,
        handedness: action.handedness,
        cameraView: "side",
      });
      if (stableJson(biomech) !== stableJson(features)) {
        add(
          "biomech_eq",
          "GeometryBiomechanicsExtractor ≠ PoseGeometryFeatureExtractor on identical inputs",
        );
      }
      return { strokes, pose: pose.value.length, paddle, phases, features, biomech };
    }
    case "q_analyze_clip": {
      const { providers, clip } = buildProviders(world);
      const result = await analyzeClip(providers, clip, {
        analysisId: `stress-${world.base.frames.length}`,
        sessionId: null,
        shotType: action.shotType,
        handedness: action.handedness,
        cameraView: "side",
        appVersion: "stress",
        modelBundleVersion: GEOMETRY_BUNDLE_VERSION,
        capturedAtIso: "2026-09-05T00:00:00.000Z",
      });
      if (checkResultShape(result, add) && result.ok) {
        const a = result.value;
        if (a.source !== "real") add("analysis", `source ${a.source}`);
        if (a.resultKind === "scored") {
          if (a.overallScore === null || a.overallScore < 0 || a.overallScore > 10) {
            add("analysis", `scored with overallScore ${String(a.overallScore)}`);
          }
        } else if (a.resultKind === "low_confidence") {
          if (a.overallScore !== null)
            add("analysis", `low_confidence with overallScore ${a.overallScore}`);
          if (a.priorityFix !== null) add("analysis", "low_confidence with priorityFix");
        } else {
          add("analysis", `unknown resultKind ${String(a.resultKind)}`);
        }
        if (!inUnit(a.analysisConfidence))
          add("analysis", `analysisConfidence ${a.analysisConfidence}`);
        checkPhases(a.phases, a.timestamps.startMs, add);
        checkMeasurements(a.measurements, add);
        if (a.timestamps.contactMs !== null) {
          if (
            a.timestamps.contactMs < a.timestamps.startMs ||
            a.timestamps.contactMs > a.timestamps.endMs
          ) {
            add(
              "analysis",
              `contactMs ${a.timestamps.contactMs} outside ${a.timestamps.startMs}..${a.timestamps.endMs}`,
            );
          }
        }
      }
      return result;
    }
    default:
      return undefined;
  }
}

function buildProviders(world: World): {
  providers: ReturnType<typeof createGeometryProviderSet>;
  clip: VideoClipRef;
} {
  const seq = world.seq;
  const frames = toLegacyPoseFrames(seq);
  const durationMs = frames.length > 0 ? Math.max(...frames.map((f) => f.timestampMs)) : 0;
  const providers = createGeometryProviderSet({
    poseFrames: frames,
    poseModelVersion: "stress-pose-1",
    trigger: {
      modelVersion: "stress-trigger-1",
      startMs: world.window.startMs,
      endMs: world.window.endMs,
      peakMotionMs: world.window.peakMotionMs,
      confidence: 0.8,
    },
    video: { width: seq.video.width, height: seq.video.height },
  });
  const clip: VideoClipRef = {
    uri: "stress://synthetic",
    durationMs,
    fps: seq.video.fps,
    width: seq.video.width,
    height: seq.video.height,
  };
  return { providers, clip };
}

function speedsOf(
  centers: ReadonlyArray<{ timestampMs: number; x: number; y: number }>,
): Array<{ timestampMs: number; value: number }> {
  const speeds: Array<{ timestampMs: number; value: number }> = [];
  for (let index = 1; index < centers.length; index += 1) {
    const a = centers[index - 1]!;
    const b = centers[index]!;
    const dt = b.timestampMs - a.timestampMs;
    speeds.push({
      timestampMs: (a.timestampMs + b.timestampMs) / 2,
      value: dt !== 0 ? (Math.hypot(b.x - a.x, b.y - a.y) / dt) * 1000 : 0,
    });
  }
  return speeds;
}

function buildWorld(plan: SequencePlan): World {
  const { sequence, window } = generateSwingSequence(
    plan.swing as Parameters<typeof generateSwingSequence>[0],
  );
  const baseWindow: Window = {
    startMs: window.startMs,
    endMs: window.endMs,
    peakMotionMs: window.peakMs,
  };
  return {
    base: sequence,
    baseWindow,
    handed: plan.swing["handed"] === "left" ? "left" : "right",
    seq: cloneSequence(sequence),
    window: { ...baseWindow },
    paddle: null,
    ball: null,
    nonFiniteInjected: false,
  };
}

/** Execute a plan once; the trace is the replayable evidence. */
export async function executePlan(plan: SequencePlan): Promise<SequenceOutcome> {
  const started = performance.now();
  const world = buildWorld(plan);
  // Mutation randomness is drawn from a stream seeded by the plan seed, so a
  // mutation's effect depends only on (seed, position) — replayable.
  const mutationRng = new Rng(plan.seed ^ 0x5bd1e995);
  const violations: Violation[] = [];
  const trace: StepTrace[] = [];
  let queries = 0;

  for (let step = 0; step < plan.actions.length; step += 1) {
    const action = plan.actions[step]!;
    const label = action.kind;
    const add = (invariant: string, detail: string): void => {
      violations.push({
        step,
        action: label,
        invariant,
        detail,
        inputNonFinite: world.nonFiniteInjected,
      });
    };
    if (!isQuery(action)) {
      applyMutation(world, action, mutationRng);
      trace.push({
        step,
        action: label,
        outcome: `frames=${world.seq.frames.length} paddle=${world.paddle?.length ?? 0} ball=${world.ball?.length ?? 0} win=${world.window.startMs.toFixed(1)}..${world.window.endMs.toFixed(1)}`,
      });
      continue;
    }
    queries += 1;
    const before = stableJson(world.seq);
    let output: unknown;
    try {
      output = await runQuery(world, action, add);
    } catch (error) {
      add(
        "no_throw",
        `${label} threw: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
      );
      trace.push({
        step,
        action: label,
        outcome: `THREW ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    const nonFinite = findNonFinite(output);
    if (nonFinite) add("finite", nonFinite);
    if (stableJson(world.seq) !== before) add("pure", `${label} mutated its input sequence`);
    trace.push({
      step,
      action: label,
      outcome: fnv1a(stableJson(output)) + " " + summarize(output),
    });
  }

  const traceText = stableJson(trace);
  return {
    seed: plan.seed,
    length: plan.actions.length,
    queries,
    outcome: violations.length === 0 ? "held" : "violated",
    violations,
    trace,
    traceHash: fnv1a(traceText),
    durationMs: performance.now() - started,
  };
}

function summarize(output: unknown): string {
  if (output === null || output === undefined) return "null";
  if (typeof output !== "object") return String(output);
  const o = output as Record<string, unknown>;
  if ("ok" in o) {
    if (o["ok"] === true) {
      const v = o["value"] as Record<string, unknown> | unknown[] | undefined;
      if (Array.isArray(v)) return `ok[${v.length}]`;
      if (v && typeof v === "object" && "resultKind" in v)
        return `ok ${String(v["resultKind"])} score=${String(v["overallScore"])}`;
      return "ok";
    }
    const f = o["failure"] as { code?: string } | undefined;
    return `fail ${f?.code ?? "?"}`;
  }
  if ("status" in o)
    return `${String(o["status"])}${"reason" in o ? " " + String(o["reason"]) : ""}`;
  if ("verdict" in o) return `verdict=${String(o["verdict"])}`;
  if ("label" in o) return `label=${String(o["label"])} conf=${String(o["confidence"])}`;
  if ("analyzable" in o) return `analyzable=${String(o["analyzable"])} ${stableJson(o["reasons"])}`;
  if ("confidence" in o) return `conf=${String(o["confidence"])}`;
  if ("strokes" in o) return "chain-partial";
  return "obj";
}

/**
 * Greedy 1-minimal shrink of a violating plan: drop actions while the plan
 * still violates the SAME invariant set; then truncate after the first
 * violating step. The result replays through `executePlan` unchanged.
 */
export async function minimizePlan(
  plan: SequencePlan,
  original: SequenceOutcome,
): Promise<{ plan: SequencePlan; outcome: SequenceOutcome }> {
  const signature = (o: SequenceOutcome): string =>
    stableJson([...new Set(o.violations.map((v) => v.invariant))].sort());
  const target = signature(original);
  let current: SequencePlan = { ...plan, actions: [...plan.actions] };
  let outcome = original;
  const firstBad = Math.max(...original.violations.map((v) => v.step));
  const truncated = { ...current, actions: current.actions.slice(0, firstBad + 1) };
  const truncatedOutcome = await executePlan(truncated);
  if (truncatedOutcome.outcome === "violated" && signature(truncatedOutcome) === target) {
    current = truncated;
    outcome = truncatedOutcome;
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = current.actions.length - 1; index >= 0; index -= 1) {
      if (current.actions.length <= 1) break;
      const candidate = { ...current, actions: current.actions.filter((_a, i) => i !== index) };
      const candidateOutcome = await executePlan(candidate);
      if (candidateOutcome.outcome === "violated" && signature(candidateOutcome) === target) {
        current = candidate;
        outcome = candidateOutcome;
        changed = true;
      }
    }
  }
  return { plan: current, outcome };
}

export interface CampaignConfig {
  iterations: number;
  baseSeed: number;
  minLen: number;
  maxLen: number;
  /** Explicit seeds to (re)play instead of the derived range. */
  seeds?: number[];
}

export interface CampaignRow {
  seed: number;
  length: number;
  queries: number;
  outcome: "held" | "violated" | "nondeterministic";
  deterministic: boolean;
  traceHash: string;
  replayTraceHash: string;
  violations: Violation[];
  durationMs: number;
}

export interface CampaignResult {
  config: CampaignConfig;
  rows: CampaignRow[];
  totals: {
    sequences: number;
    steps: number;
    queries: number;
    held: number;
    violated: number;
    nondeterministic: number;
    queryKinds: Record<string, number>;
    outcomeKinds: Record<string, number>;
  };
  failures: Array<{
    seed: number;
    original: SequenceOutcome;
    minimized: SequencePlan;
    minimizedOutcome: SequenceOutcome;
  }>;
}

export function seedsFor(config: CampaignConfig): number[] {
  if (config.seeds && config.seeds.length > 0) return config.seeds;
  const seeds: number[] = [];
  const rng = new Rng(config.baseSeed);
  for (let i = 0; i < config.iterations; i += 1) seeds.push(rng.nextU32());
  return seeds;
}

export async function runCampaign(
  config: CampaignConfig,
  onProgress?: (done: number, total: number) => void,
): Promise<CampaignResult> {
  const seeds = seedsFor(config);
  const rows: CampaignRow[] = [];
  const failures: CampaignResult["failures"] = [];
  const queryKinds: Record<string, number> = {};
  const outcomeKinds: Record<string, number> = {};
  let steps = 0;
  let queries = 0;
  for (let i = 0; i < seeds.length; i += 1) {
    const seed = seeds[i]!;
    const plan = planSequence(seed, config.minLen, config.maxLen);
    const first = await executePlan(plan);
    const second = await executePlan(plan);
    const deterministic =
      first.traceHash === second.traceHash && stableJson(first.trace) === stableJson(second.trace);
    steps += plan.actions.length;
    queries += first.queries;
    for (const action of plan.actions) {
      if (isQuery(action)) queryKinds[action.kind] = (queryKinds[action.kind] ?? 0) + 1;
    }
    for (const entry of first.trace) {
      if (!entry.action.startsWith("q_")) continue;
      const key = `${entry.action}:${entry.outcome.split(" ").slice(1, 3).join(" ")}`;
      outcomeKinds[key] = (outcomeKinds[key] ?? 0) + 1;
    }
    const outcome: CampaignRow["outcome"] = !deterministic ? "nondeterministic" : first.outcome;
    rows.push({
      seed,
      length: plan.actions.length,
      queries: first.queries,
      outcome,
      deterministic,
      traceHash: first.traceHash,
      replayTraceHash: second.traceHash,
      violations: first.violations,
      durationMs: first.durationMs + second.durationMs,
    });
    if (first.outcome === "violated") {
      const minimized = await minimizePlan(plan, first);
      failures.push({
        seed,
        original: first,
        minimized: minimized.plan,
        minimizedOutcome: minimized.outcome,
      });
    }
    onProgress?.(i + 1, seeds.length);
  }
  return {
    config,
    rows,
    totals: {
      sequences: rows.length,
      steps,
      queries,
      held: rows.filter((r) => r.outcome === "held").length,
      violated: rows.filter((r) => r.outcome === "violated").length,
      nondeterministic: rows.filter((r) => r.outcome === "nondeterministic").length,
      queryKinds,
      outcomeKinds,
    },
    failures,
  };
}
