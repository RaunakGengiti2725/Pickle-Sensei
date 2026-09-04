/**
 * Performance / memory soak harness for the analysis pipeline.
 *
 * Runs N consecutive synthetic analyses in ONE process and records, per run:
 * wall time, the deterministic seed and every input parameter derived from it
 * (so any failing run is replayable by seed alone), the typed outcome, and the
 * heap after an explicit `global.gc()` when the process was started with
 * `--expose-gc`. Without `--expose-gc` heap numbers are still recorded but the
 * report says so honestly (`gcAvailable: false`) — a slope over un-collected
 * heap is not evidence of a leak or of its absence.
 *
 * Nothing in here touches production code: the providers are the same
 * deterministic implementations `packages/analysis-pipeline/test/analyzeCapture.test.ts`
 * wires, the pose input is `@pickle/evaluation`'s synthetic swing generator,
 * and the AUTO-stroke classifier is a thin adapter over
 * `@pickle/vision-geometry.classifyStroke` mirroring the mobile adapter in
 * `apps/mobile/src/vision/providers.ts` (which cannot be imported on Linux
 * because it pulls `react-native`).
 */
import { cpus, totalmem } from "node:os";
import { SHOT_TYPES, ok, type ShotTypeSlug } from "@pickle/shared-types";
import { generateSwing, generateSwingSequence, type SwingTruth } from "@pickle/evaluation";
import {
  CheckpointThresholdFaultDetector,
  EngineUncertaintyEstimator,
  PriorityCoachingRanker,
  Sm1TechniqueScorer,
} from "@pickle/scoring";
import { unavailable } from "@pickle/swing-domain";
import type { VideoClipRef } from "@pickle/vision-contracts";
import {
  GeometricPhaseSegmenter,
  GeometryBiomechanicsExtractor,
  classifyStroke,
  createGeometryProviderSet,
} from "@pickle/vision-geometry";
import {
  analyzeCapture,
  analyzeClip,
  SessionEventEngine,
  type CaptureAnalysisInput,
  type FusionProviders,
  type IHierarchicalStrokeClassifier,
  type SpeedSample,
} from "../../src/index.js";

// ── Deterministic PRNG ───────────────────────────────────────────────────────

/** mulberry32 — tiny, deterministic, good enough to spread inputs. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function between(rand: () => number, low: number, high: number): number {
  return low + (high - low) * rand();
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  const index = Math.min(items.length - 1, Math.floor(rand() * items.length));
  const item = items[index];
  if (item === undefined) throw new Error("pick(): empty list");
  return item;
}

// ── Per-run input derivation (everything below is a pure function of seed) ──

export type SoakDeclared = ShotTypeSlug | "AUTO";

export interface SoakInputSpec {
  /** The per-run seed; `deriveInput(seed)` reproduces every field below. */
  seed: number;
  declared: SoakDeclared;
  handedness: "right" | "left";
  cameraView: "side" | "rear_oblique";
  /** Overrides applied on top of `DEFAULT_TRUTH`. */
  truth: Partial<SwingTruth>;
}

const CAMERA_VIEWS = ["side", "rear_oblique"] as const;
const DECLARED_CHOICES: readonly SoakDeclared[] = [...SHOT_TYPES, "AUTO"];

/** Deterministic input for one run. Bounds keep the synthetic swing inside the
 * generator's physical assumptions (torso scale, frame-aligned contact). */
export function deriveInput(seed: number): SoakInputSpec {
  const rand = mulberry32(seed);
  const handed = rand() < 0.5 ? "right" : "left";
  const fps = rand() < 0.5 ? 30 : 60;
  const truth: Partial<SwingTruth> = {
    handed,
    fps,
    torsoLength: between(rand, 0.16, 0.24),
    stanceWidthRatio: between(rand, 1.0, 1.8),
    kneeFlexionDeg: between(rand, 10, 50),
    contactForwardNorm: between(rand, 0.1, 0.7),
    contactHeightRatio: between(rand, 0.25, 0.6),
    backswingLengthNorm: between(rand, 0.4, 1.2),
    swingDipNorm: between(rand, 0.02, 0.25),
    shoulderTurnDeg: between(rand, 20, 80),
    readyMs: Math.round(between(rand, 250, 600)),
    backswingMs: Math.round(between(rand, 300, 650)),
    // Keep contact frame-aligned like DEFAULT_TRUTH (multiple of the frame interval).
    accelerateMs: Math.round(between(rand, 6, 18)) * Math.round(1000 / fps),
    followMs: Math.round(between(rand, 200, 450)),
    recoverMs: Math.round(between(rand, 350, 750)),
  };
  return {
    seed,
    declared: pick(rand, DECLARED_CHOICES),
    handedness: handed,
    cameraView: pick(rand, CAMERA_VIEWS),
    truth,
  };
}

// ── Providers (deterministic, same as the package's own tests) ──────────────

const TRIGGER_MODEL = {
  providerId: "trigger.temporal-heuristic",
  modelVersion: "temporal-stroke-heuristic-2",
  runtime: "deterministic" as const,
  executionTarget: "on_device" as const,
  artifactHash: null,
};

/** Mirror of `HeuristicHierarchicalStrokeClassifier` in apps/mobile (minus the
 * registry manifest plumbing): pose-only, no synthesized paddle/speed data. */
export class SoakHeuristicStrokeClassifier implements IHierarchicalStrokeClassifier {
  public readonly descriptor = {
    providerId: "classifier.stroke-heuristic-lite",
    modelVersion: "stroke-heuristic-1 (soak harness adapter)",
    runtime: "deterministic" as const,
    executionTarget: "on_device" as const,
    artifactHash: null,
    inputSchemaVersion: 1,
    outputSchemaVersion: 1,
  };

  public async classify(
    input: Parameters<IHierarchicalStrokeClassifier["classify"]>[0],
  ): ReturnType<IHierarchicalStrokeClassifier["classify"]> {
    return ok(
      classifyStroke({
        sequence: input.pose,
        window: input.window,
        contactMs: input.contactMs,
        eventPeakMs: input.eventPeakMs,
        handedness: input.handedness,
        paddle: null,
        paddleSpeeds: null,
        wristSpeeds: null,
      }),
    );
  }
}

export function soakFusionProviders(): FusionProviders {
  return {
    phase: new GeometricPhaseSegmenter({ aspectRatio: 1 }),
    biomechanics: new GeometryBiomechanicsExtractor(),
    scorer: new Sm1TechniqueScorer(),
    faultDetector: new CheckpointThresholdFaultDetector(),
    uncertainty: new EngineUncertaintyEstimator(),
    coach: new PriorityCoachingRanker(),
    classifier: null,
    autoStrokeClassifier: new SoakHeuristicStrokeClassifier(),
    shadowScorers: [],
  };
}

export function captureInputFor(spec: SoakInputSpec, runIndex: number): CaptureAnalysisInput {
  const { sequence, window } = generateSwingSequence(spec.truth);
  return {
    captureId: `soak-capture-${runIndex}-seed-${spec.seed}`,
    pose: sequence,
    paddle: unavailable("paddle_detector_not_installed"),
    ball: unavailable("ball_tracker_not_installed"),
    trigger: {
      startMs: window.startMs,
      endMs: window.endMs,
      peakMotionMs: window.peakMs,
      confidence: 0.9,
      producedBy: TRIGGER_MODEL,
    },
    stroke: { declared: spec.declared === "AUTO" ? null : spec.declared, predicted: null },
    handedness: spec.handedness,
    cameraView: spec.cameraView,
    capturedAtIso: "2026-08-27T18:00:00.000Z",
  };
}

// ── Measurement primitives ──────────────────────────────────────────────────

export interface HeapSample {
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
  arrayBuffers: number;
}

export function gcAvailable(): boolean {
  return typeof globalThis.gc === "function";
}

/** Collect (when exposed) and sample memory. Returns the gc wall time in ms. */
export function collectAndSample(): { sample: HeapSample; gcMs: number } {
  let gcMs = 0;
  if (gcAvailable()) {
    const start = performance.now();
    // Two passes: the first can leave finalizable objects behind.
    globalThis.gc?.();
    globalThis.gc?.();
    gcMs = performance.now() - start;
  }
  const usage = process.memoryUsage();
  return {
    sample: {
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      rss: usage.rss,
      external: usage.external,
      arrayBuffers: usage.arrayBuffers,
    },
    gcMs,
  };
}

export interface LinearFit {
  /** Slope in y-units per x-unit (bytes per run). */
  slope: number;
  intercept: number;
  /** Pearson r; NaN when x or y has zero variance. */
  r: number;
  n: number;
}

export function linearFit(points: ReadonlyArray<{ x: number; y: number }>): LinearFit {
  const n = points.length;
  if (n === 0) return { slope: 0, intercept: 0, r: Number.NaN, n: 0 };
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of points) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const r = sxx === 0 || syy === 0 ? Number.NaN : sxy / Math.sqrt(sxx * syy);
  return { slope, intercept: my - slope * mx, r, n };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const hi = sorted[mid];
  const lo = sorted[mid - 1];
  if (hi === undefined) return Number.NaN;
  return sorted.length % 2 === 1 || lo === undefined ? hi : (lo + hi) / 2;
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const value = sorted[Math.min(rank, sorted.length) - 1];
  return value ?? Number.NaN;
}

export interface HeapWindow {
  /** First run index (inclusive) of this window. */
  fromRun: number;
  /** Last run index (inclusive). */
  toRun: number;
  runs: number;
  medianHeapUsed: number;
  meanHeapUsed: number;
  minHeapUsed: number;
  maxHeapUsed: number;
  /** Median growth vs the previous window, in percent (null for the first). */
  growthVsPreviousPct: number | null;
}

export interface HeapVerdict {
  gcAvailable: boolean;
  /** Runs excluded from the fit (JIT warm-up, caches filling). */
  warmupRuns: number;
  fit: LinearFit;
  baselineHeapUsed: number;
  /** Fitted growth per 100 runs, as a percentage of the baseline (first-window median). */
  slopePer100RunsPct: number;
  slopeBytesPerRun: number;
  windows: HeapWindow[];
  /** Every window median >= its predecessor. */
  monotoneAcrossWindows: boolean;
  /** Largest single window-to-window growth (percent). */
  maxWindowGrowthPct: number;
  thresholdPer100RunsPct: number;
  /** The finding criterion from the brief: monotone growth > threshold per 100 runs. */
  leakSuspected: boolean;
  /** Heap delta first→last post-warm-up run, bytes. */
  netDeltaBytes: number;
}

export function heapVerdict(
  heapUsedByRun: readonly number[],
  options: { warmupRuns: number; windowRuns: number; thresholdPer100RunsPct: number; gc: boolean },
): HeapVerdict {
  const warm = heapUsedByRun.slice(options.warmupRuns);
  const points = warm.map((y, i) => ({ x: i, y }));
  const fit = linearFit(points);
  const windows: HeapWindow[] = [];
  for (let start = 0; start < warm.length; start += options.windowRuns) {
    const slice = warm.slice(start, start + options.windowRuns);
    if (slice.length === 0) break;
    const med = median(slice);
    const previous = windows[windows.length - 1];
    windows.push({
      fromRun: options.warmupRuns + start,
      toRun: options.warmupRuns + start + slice.length - 1,
      runs: slice.length,
      medianHeapUsed: med,
      meanHeapUsed: slice.reduce((a, b) => a + b, 0) / slice.length,
      minHeapUsed: Math.min(...slice),
      maxHeapUsed: Math.max(...slice),
      growthVsPreviousPct:
        previous && previous.medianHeapUsed > 0
          ? ((med - previous.medianHeapUsed) / previous.medianHeapUsed) * 100
          : null,
    });
  }
  const baseline = windows[0]?.medianHeapUsed ?? warm[0] ?? 0;
  const slopePer100RunsPct = baseline > 0 ? ((fit.slope * 100) / baseline) * 100 : 0;
  const growths = windows.map((w) => w.growthVsPreviousPct).filter((g): g is number => g !== null);
  const monotone = growths.length > 0 && growths.every((g) => g >= 0);
  const maxWindowGrowthPct = growths.length > 0 ? Math.max(...growths) : 0;
  const first = warm[0] ?? 0;
  const last = warm[warm.length - 1] ?? first;
  return {
    gcAvailable: options.gc,
    warmupRuns: options.warmupRuns,
    fit,
    baselineHeapUsed: baseline,
    slopePer100RunsPct,
    slopeBytesPerRun: fit.slope,
    windows,
    monotoneAcrossWindows: monotone,
    maxWindowGrowthPct,
    thresholdPer100RunsPct: options.thresholdPer100RunsPct,
    // Only a gc'd heap can support a leak verdict; without gc the slope is
    // reported but never promoted to a finding.
    leakSuspected:
      options.gc &&
      monotone &&
      (slopePer100RunsPct > options.thresholdPer100RunsPct ||
        maxWindowGrowthPct > options.thresholdPer100RunsPct),
    netDeltaBytes: last - first,
  };
}

// ── Scenario 1: analyzeCapture ×N ───────────────────────────────────────────

export interface CaptureRunRecord {
  run: number;
  seed: number;
  input: SoakInputSpec;
  frames: number;
  durationMs: number;
  gcMs: number;
  ok: boolean;
  /** `scored` / `abstain` / … when ok, else the typed failure code. */
  outcome: string;
  overallScore: number | null;
  modelRuns: number;
  /** Thrown exception (not a typed failure) — always a finding. */
  threw: string | null;
  heap: HeapSample;
}

export interface LatencyStats {
  runs: number;
  totalMs: number;
  throughputPerSec: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  /** Least-squares slope of per-run latency vs run index (ms per run). */
  latencySlopeMsPerRun: number;
}

export function latencyStats(durations: readonly number[]): LatencyStats {
  const totalMs = durations.reduce((a, b) => a + b, 0);
  return {
    runs: durations.length,
    totalMs,
    throughputPerSec: totalMs > 0 ? (durations.length / totalMs) * 1000 : 0,
    meanMs: durations.length > 0 ? totalMs / durations.length : 0,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    p99Ms: percentile(durations, 99),
    maxMs: durations.length > 0 ? Math.max(...durations) : 0,
    latencySlopeMsPerRun: linearFit(durations.map((y, x) => ({ x, y }))).slope,
  };
}

export interface CaptureSoakOptions {
  runs: number;
  /** Base seed; run i uses seed `baseSeed + i`. */
  baseSeed: number;
  warmupRuns: number;
  windowRuns: number;
  thresholdPer100RunsPct: number;
  /** Fresh providers per run (mobile behaviour: createFusionProviders per
   * analysis) vs one shared set for the whole process. */
  providersPerRun: boolean;
  /** Control mode: derive the input and record everything exactly as a real
   * run does, but skip `analyzeCapture`. The resulting heap slope is the
   * harness's own retention (per-run record objects) and is subtracted from
   * the workload slope before a leak verdict is made. */
  noop?: boolean;
  onRun?: (record: CaptureRunRecord) => void;
}

export interface CaptureSoakReport {
  scenario: "analyzeCapture" | "control";
  options: Omit<CaptureSoakOptions, "onRun">;
  records: CaptureRunRecord[];
  latency: LatencyStats;
  heap: HeapVerdict;
  outcomes: Record<string, number>;
  byDeclared: Record<string, { runs: number; scored: number; abstain: number; failed: number }>;
  failures: Array<{ run: number; seed: number; outcome: string; threw: string | null }>;
  /** Seeds whose run threw a JS exception (crash class). */
  exceptions: number[];
}

export async function runCaptureSoak(options: CaptureSoakOptions): Promise<CaptureSoakReport> {
  const shared = options.providersPerRun ? null : soakFusionProviders();
  const records: CaptureRunRecord[] = [];
  let counter = 0;
  for (let run = 0; run < options.runs; run++) {
    const seed = options.baseSeed + run;
    const spec = deriveInput(seed);
    const input = captureInputFor(spec, run);
    const providers = shared ?? soakFusionProviders();
    const analysisOptions = {
      analysisId: `soak-analysis-${run}`,
      sessionId: null,
      appVersion: "0.0.0-soak",
      modelBundleVersion: "fusion-soak",
      nowIso: () => "2026-08-27T18:30:00.000Z",
      makeId: () => `soak-run-${++counter}`,
    };
    const started = performance.now();
    let ok = false;
    let outcome = "unknown";
    let overallScore: number | null = null;
    let modelRuns = 0;
    let threw: string | null = null;
    try {
      if (options.noop) {
        ok = true;
        outcome = "noop";
      } else {
        const result = await analyzeCapture(providers, input, analysisOptions);
        ok = result.ok;
        if (result.ok) {
          outcome = result.value.result?.resultKind ?? "no_result";
          overallScore = result.value.result?.overallScore ?? null;
          modelRuns = result.value.modelRuns.length;
        } else {
          outcome = `${result.failure.kind}:${result.failure.code}`;
        }
      }
    } catch (error) {
      threw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      outcome = "exception";
    }
    const durationMs = performance.now() - started;
    const { sample, gcMs } = collectAndSample();
    const record: CaptureRunRecord = {
      run,
      seed,
      input: spec,
      frames: input.pose.frames.length,
      durationMs,
      gcMs,
      ok,
      outcome,
      overallScore,
      modelRuns,
      threw,
      heap: sample,
    };
    records.push(record);
    options.onRun?.(record);
  }
  const outcomes: Record<string, number> = {};
  const byDeclared: CaptureSoakReport["byDeclared"] = {};
  for (const record of records) {
    outcomes[record.outcome] = (outcomes[record.outcome] ?? 0) + 1;
    const key = record.input.declared;
    const bucket = byDeclared[key] ?? { runs: 0, scored: 0, abstain: 0, failed: 0 };
    bucket.runs++;
    if (record.outcome === "scored") bucket.scored++;
    else if (record.ok) bucket.abstain++;
    else bucket.failed++;
    byDeclared[key] = bucket;
  }
  const { onRun: _onRun, ...plainOptions } = options;
  return {
    scenario: options.noop ? "control" : "analyzeCapture",
    options: plainOptions,
    records,
    latency: latencyStats(records.map((r) => r.durationMs)),
    heap: heapVerdict(
      records.map((r) => r.heap.heapUsed),
      {
        warmupRuns: options.warmupRuns,
        windowRuns: options.windowRuns,
        thresholdPer100RunsPct: options.thresholdPer100RunsPct,
        gc: gcAvailable(),
      },
    ),
    outcomes,
    byDeclared,
    failures: records
      .filter((r) => !r.ok)
      .map((r) => ({ run: r.run, seed: r.seed, outcome: r.outcome, threw: r.threw })),
    exceptions: records.filter((r) => r.threw !== null).map((r) => r.seed),
  };
}

// ── Scenario 2: legacy analyzeClip ×N over the recorded-geometry provider set ─

export interface ClipRunRecord {
  run: number;
  seed: number;
  input: SoakInputSpec;
  durationMs: number;
  gcMs: number;
  ok: boolean;
  outcome: string;
  threw: string | null;
  heap: HeapSample;
}

export interface ClipSoakReport {
  scenario: "analyzeClip";
  options: { runs: number; baseSeed: number; warmupRuns: number; windowRuns: number };
  records: ClipRunRecord[];
  latency: LatencyStats;
  heap: HeapVerdict;
  outcomes: Record<string, number>;
  failures: Array<{ run: number; seed: number; outcome: string; threw: string | null }>;
  exceptions: number[];
}

export async function runClipSoak(options: {
  runs: number;
  baseSeed: number;
  warmupRuns: number;
  windowRuns: number;
  thresholdPer100RunsPct: number;
}): Promise<ClipSoakReport> {
  const records: ClipRunRecord[] = [];
  for (let run = 0; run < options.runs; run++) {
    const seed = options.baseSeed + run;
    const spec = deriveInput(seed);
    // analyzeClip has no AUTO path: fold AUTO onto forehand_drive for this scenario.
    const shotType: ShotTypeSlug = spec.declared === "AUTO" ? "forehand_drive" : spec.declared;
    const skeleton = generateSwing(spec.truth);
    const clip: VideoClipRef = {
      uri: skeleton.clip.uri,
      durationMs: skeleton.clip.durationMs,
      fps: skeleton.clip.fps,
      width: skeleton.clip.width,
      height: skeleton.clip.height,
    };
    const providers = createGeometryProviderSet({
      poseFrames: skeleton.frames,
      poseModelVersion: "synthetic-swing-1",
      trigger: {
        modelVersion: TRIGGER_MODEL.modelVersion,
        startMs: skeleton.window.startMs,
        endMs: skeleton.window.endMs,
        peakMotionMs: skeleton.window.peakMs,
        confidence: 0.9,
      },
      video: { width: skeleton.clip.width, height: skeleton.clip.height },
    });
    const started = performance.now();
    let ok = false;
    let outcome = "unknown";
    let threw: string | null = null;
    try {
      const result = await analyzeClip(providers, clip, {
        analysisId: `soak-clip-${run}`,
        sessionId: null,
        shotType,
        handedness: spec.handedness,
        cameraView: spec.cameraView,
        appVersion: "0.0.0-soak",
        modelBundleVersion: "geometry-soak",
        capturedAtIso: "2026-08-27T18:00:00.000Z",
      });
      ok = result.ok;
      outcome = result.ok
        ? result.value.resultKind
        : `${result.failure.kind}:${result.failure.code}`;
    } catch (error) {
      threw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      outcome = "exception";
    }
    const durationMs = performance.now() - started;
    const { sample, gcMs } = collectAndSample();
    records.push({ run, seed, input: spec, durationMs, gcMs, ok, outcome, threw, heap: sample });
  }
  const outcomes: Record<string, number> = {};
  for (const record of records) outcomes[record.outcome] = (outcomes[record.outcome] ?? 0) + 1;
  return {
    scenario: "analyzeClip",
    options: {
      runs: options.runs,
      baseSeed: options.baseSeed,
      warmupRuns: options.warmupRuns,
      windowRuns: options.windowRuns,
    },
    records,
    latency: latencyStats(records.map((r) => r.durationMs)),
    heap: heapVerdict(
      records.map((r) => r.heap.heapUsed),
      {
        warmupRuns: options.warmupRuns,
        windowRuns: options.windowRuns,
        thresholdPer100RunsPct: options.thresholdPer100RunsPct,
        gc: gcAvailable(),
      },
    ),
    outcomes,
    failures: records
      .filter((r) => !r.ok)
      .map((r) => ({ run: r.run, seed: r.seed, outcome: r.outcome, threw: r.threw })),
    exceptions: records.filter((r) => r.threw !== null).map((r) => r.seed),
  };
}

// ── Scenario 3: one long live session through SessionEventEngine ────────────

/** Synthetic wrist-speed stream: idle baseline plus one gaussian bump per
 * stroke, `strokeEveryMs` apart, sampled at `fps`. Deterministic per seed. */
export function syntheticWristStream(input: {
  seed: number;
  strokes: number;
  fps: number;
  strokeEveryMs: number;
}): SpeedSample[] {
  const rand = mulberry32(input.seed);
  const stepMs = 1000 / input.fps;
  const totalMs = input.strokes * input.strokeEveryMs + 1500;
  const bumps: Array<{ peakMs: number; height: number; halfWidthMs: number }> = [];
  for (let i = 0; i < input.strokes; i++) {
    bumps.push({
      peakMs: 800 + i * input.strokeEveryMs + between(rand, -80, 80),
      height: between(rand, 2.5, 7.0),
      halfWidthMs: between(rand, 70, 120),
    });
  }
  const series: SpeedSample[] = [];
  let bumpCursor = 0;
  for (let t = 0; t <= totalMs; t += stepMs) {
    let value = 0.08 + between(rand, -0.01, 0.01);
    // Only bumps within ±4 half-widths matter; the cursor keeps this O(1).
    while (bumpCursor < bumps.length && (bumps[bumpCursor]?.peakMs ?? 0) + 600 < t) bumpCursor++;
    for (let b = bumpCursor; b < bumps.length; b++) {
      const bump = bumps[b];
      if (!bump) break;
      if (bump.peakMs - 600 > t) break;
      value += bump.height * Math.exp(-0.5 * ((t - bump.peakMs) / bump.halfWidthMs) ** 2);
    }
    series.push({ timestampMs: t, value });
  }
  return series;
}

export interface SessionPushWindow {
  fromSample: number;
  toSample: number;
  samples: number;
  /** Wall-clock ms spent inside `pushWristSample` for this window. */
  pushTotalMs: number;
  pushMeanUs: number;
  pushP95Us: number;
  pushMaxUs: number;
  eventsClosed: number;
  heapUsedAfterWindow: number;
}

export interface SessionSoakReport {
  scenario: "sessionEngine";
  options: {
    seed: number;
    strokes: number;
    fps: number;
    strokeEveryMs: number;
    windowSamples: number;
  };
  samples: number;
  sessionDurationMs: number;
  eventsClosed: number;
  flushClosed: number;
  windows: SessionPushWindow[];
  /** Per-push cost fit vs sample index (µs per sample) — a positive slope means
   * each frame gets more expensive as the session grows (super-linear session cost). */
  pushCostFit: LinearFit;
  /** Ratio of the last window's mean push cost to the first window's. */
  lastToFirstWindowRatio: number;
  totalPushMs: number;
  /** Fraction of the frame budget (1000/fps ms) consumed by the mean push in the last window. */
  lastWindowMeanPushShareOfFrameBudget: number;
  /** Sample count at which the fitted per-push cost would consume the whole
   * frame budget (null when the fit slope is not positive). */
  projectedFrameBudgetExhaustionAtSample: number | null;
  /** gc'd heap after the first and last window, and the retained bytes per
   * pushed sample between them. The engine retains the whole series by
   * design (`sessionEngine.ts` append-only reconciliation), so this is a
   * cost figure, not a leak verdict. */
  heapFirstWindow: number;
  heapLastWindow: number;
  retainedBytesPerSample: number;
  qualityNotes: number;
  threw: string | null;
}

export function runSessionSoak(options: {
  seed: number;
  strokes: number;
  fps: number;
  strokeEveryMs: number;
  windowSamples: number;
}): SessionSoakReport {
  const stream = syntheticWristStream(options);
  const engine = new SessionEventEngine({
    sessionId: `soak-session-${options.seed}`,
    captureMeta: { startedAtIso: "2026-08-27T18:00:00.000Z", fps: options.fps, source: "live" },
  });
  const windows: SessionPushWindow[] = [];
  const perSampleUs: number[] = [];
  let eventsClosed = 0;
  let threw: string | null = null;
  let windowStart = 0;
  let windowDurations: number[] = [];
  let windowEvents = 0;
  const closeWindow = (endIndex: number): void => {
    const total = windowDurations.reduce((a, b) => a + b, 0);
    windows.push({
      fromSample: windowStart,
      toSample: endIndex,
      samples: windowDurations.length,
      pushTotalMs: total / 1000,
      pushMeanUs: windowDurations.length > 0 ? total / windowDurations.length : 0,
      pushP95Us: percentile(windowDurations, 95),
      pushMaxUs: windowDurations.length > 0 ? Math.max(...windowDurations) : 0,
      eventsClosed: windowEvents,
      heapUsedAfterWindow: collectAndSample().sample.heapUsed,
    });
    windowStart = endIndex + 1;
    windowDurations = [];
    windowEvents = 0;
  };
  try {
    for (let i = 0; i < stream.length; i++) {
      const sample = stream[i];
      if (!sample) break;
      const started = performance.now();
      const closed = engine.pushWristSample(sample);
      const us = (performance.now() - started) * 1000;
      perSampleUs.push(us);
      windowDurations.push(us);
      windowEvents += closed.length;
      eventsClosed += closed.length;
      if (windowDurations.length >= options.windowSamples) closeWindow(i);
    }
    if (windowDurations.length > 0) closeWindow(stream.length - 1);
  } catch (error) {
    threw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  let flushClosed = 0;
  if (threw === null) {
    try {
      flushClosed = engine.flush().length;
    } catch (error) {
      threw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
  }
  const first = windows[0];
  const last = windows[windows.length - 1];
  const totalPushMs = perSampleUs.reduce((a, b) => a + b, 0) / 1000;
  const frameBudgetMs = 1000 / options.fps;
  const pushCostFit = linearFit(perSampleUs.map((y, x) => ({ x, y })));
  const heapFirst = first?.heapUsedAfterWindow ?? 0;
  const heapLast = last?.heapUsedAfterWindow ?? heapFirst;
  const samplesBetween = first && last ? last.toSample - first.toSample : 0;
  return {
    scenario: "sessionEngine",
    options,
    samples: stream.length,
    sessionDurationMs: stream[stream.length - 1]?.timestampMs ?? 0,
    eventsClosed,
    flushClosed,
    windows,
    pushCostFit,
    lastToFirstWindowRatio:
      first && last && first.pushMeanUs > 0 ? last.pushMeanUs / first.pushMeanUs : Number.NaN,
    totalPushMs,
    lastWindowMeanPushShareOfFrameBudget: last ? last.pushMeanUs / 1000 / frameBudgetMs : 0,
    projectedFrameBudgetExhaustionAtSample:
      pushCostFit.slope > 0
        ? Math.ceil((frameBudgetMs * 1000 - pushCostFit.intercept) / pushCostFit.slope)
        : null,
    heapFirstWindow: heapFirst,
    heapLastWindow: heapLast,
    retainedBytesPerSample: samplesBetween > 0 ? (heapLast - heapFirst) / samplesBetween : 0,
    qualityNotes: engine.snapshot().qualityState.notes.length,
    threw,
  };
}

// ── Whole-report ────────────────────────────────────────────────────────────

export interface SoakEnvironment {
  node: string;
  v8: string;
  platform: string;
  arch: string;
  cpus: number;
  totalMemBytes: number;
  execArgv: string[];
  gcExposed: boolean;
  startedAtIso: string;
  gitCommit: string | null;
}

export interface SoakFinding {
  scenario: string;
  criterion: string;
  detail: string;
  /** Seeds/inputs to replay the finding. */
  replay: string;
}

/** Workload slope with the harness's own retention (control run) removed. */
export interface ControlAdjustedHeap {
  controlSlopeBytesPerRun: number;
  workloadSlopeBytesPerRun: number;
  adjustedSlopeBytesPerRun: number;
  adjustedSlopePer100RunsPct: number;
}

export function controlAdjust(workload: HeapVerdict, control: HeapVerdict): ControlAdjustedHeap {
  const adjusted = workload.slopeBytesPerRun - control.slopeBytesPerRun;
  return {
    controlSlopeBytesPerRun: control.slopeBytesPerRun,
    workloadSlopeBytesPerRun: workload.slopeBytesPerRun,
    adjustedSlopeBytesPerRun: adjusted,
    adjustedSlopePer100RunsPct:
      workload.baselineHeapUsed > 0 ? ((adjusted * 100) / workload.baselineHeapUsed) * 100 : 0,
  };
}

export interface SoakReport {
  harness: "pipeline-soak-1";
  environment: SoakEnvironment;
  /** Same loop with `noop: true` — the harness's own per-run heap retention. */
  control: CaptureSoakReport | null;
  captureControlAdjusted: ControlAdjustedHeap | null;
  capture: CaptureSoakReport | null;
  clip: ClipSoakReport | null;
  session: SessionSoakReport | null;
  findings: SoakFinding[];
  finishedAtIso: string;
}

export function deriveFindings(
  report: Omit<SoakReport, "findings" | "finishedAtIso">,
): SoakFinding[] {
  const findings: SoakFinding[] = [];
  const capture = report.capture;
  if (capture) {
    if (capture.exceptions.length > 0) {
      findings.push({
        scenario: "analyzeCapture",
        criterion: "thrown exception (not a typed failure)",
        detail: `${capture.exceptions.length} run(s) threw`,
        replay: `seeds ${capture.exceptions.join(",")} → deriveInput(seed) + captureInputFor()`,
      });
    }
    const adjusted = report.captureControlAdjusted;
    const slopePct = adjusted
      ? adjusted.adjustedSlopePer100RunsPct
      : capture.heap.slopePer100RunsPct;
    const leak =
      capture.heap.gcAvailable &&
      capture.heap.monotoneAcrossWindows &&
      (slopePct > capture.heap.thresholdPer100RunsPct ||
        capture.heap.maxWindowGrowthPct > capture.heap.thresholdPer100RunsPct);
    if (leak) {
      findings.push({
        scenario: "analyzeCapture",
        criterion: `monotone gc'd heap growth > ${capture.heap.thresholdPer100RunsPct}% per 100 runs`,
        detail:
          `raw slope ${capture.heap.slopeBytesPerRun.toFixed(0)} B/run = ` +
          `${capture.heap.slopePer100RunsPct.toFixed(2)}%/100 runs` +
          (adjusted
            ? `; control-adjusted ${adjusted.adjustedSlopeBytesPerRun.toFixed(0)} B/run = ${adjusted.adjustedSlopePer100RunsPct.toFixed(2)}%/100 runs`
            : "") +
          `; max window step ${capture.heap.maxWindowGrowthPct.toFixed(2)}%`,
        replay: `baseSeed ${capture.options.baseSeed}, runs ${capture.options.runs}, providersPerRun=${capture.options.providersPerRun}`,
      });
    }
  }
  const clip = report.clip;
  if (clip) {
    if (clip.exceptions.length > 0) {
      findings.push({
        scenario: "analyzeClip",
        criterion: "thrown exception (not a typed failure)",
        detail: `${clip.exceptions.length} run(s) threw`,
        replay: `seeds ${clip.exceptions.join(",")}`,
      });
    }
    if (clip.heap.leakSuspected) {
      findings.push({
        scenario: "analyzeClip",
        criterion: `monotone gc'd heap growth > ${clip.heap.thresholdPer100RunsPct}% per 100 runs`,
        detail: `slope ${clip.heap.slopePer100RunsPct.toFixed(2)}%/100 runs`,
        replay: `baseSeed ${clip.options.baseSeed}, runs ${clip.options.runs}`,
      });
    }
  }
  const session = report.session;
  if (session) {
    if (session.threw) {
      findings.push({
        scenario: "sessionEngine",
        criterion: "thrown exception",
        detail: session.threw,
        replay: `seed ${session.options.seed}, strokes ${session.options.strokes}, fps ${session.options.fps}`,
      });
    }
    if (Number.isFinite(session.lastToFirstWindowRatio) && session.lastToFirstWindowRatio >= 2) {
      findings.push({
        scenario: "sessionEngine",
        criterion: "per-frame push cost grows with session length (super-linear session cost)",
        detail:
          `mean push ${session.windows[0]?.pushMeanUs.toFixed(0) ?? "?"}µs in the first window → ` +
          `${session.windows[session.windows.length - 1]?.pushMeanUs.toFixed(0) ?? "?"}µs in the last ` +
          `(×${session.lastToFirstWindowRatio.toFixed(1)}); last-window mean uses ` +
          `${(session.lastWindowMeanPushShareOfFrameBudget * 100).toFixed(1)}% of the ${(1000 / session.options.fps).toFixed(1)}ms frame budget` +
          (session.projectedFrameBudgetExhaustionAtSample === null
            ? ""
            : `; fitted cost reaches the full frame budget at sample ${session.projectedFrameBudgetExhaustionAtSample} ` +
              `(~${(session.projectedFrameBudgetExhaustionAtSample / session.options.fps / 60).toFixed(1)} min at ${session.options.fps} samples/s)`),
        replay: `seed ${session.options.seed}, strokes ${session.options.strokes}, fps ${session.options.fps}, strokeEveryMs ${session.options.strokeEveryMs}`,
      });
    }
  }
  return findings;
}

export function describeEnvironment(gitCommit: string | null): SoakEnvironment {
  return {
    node: process.version,
    v8: process.versions.v8 ?? "unknown",
    platform: process.platform,
    arch: process.arch,
    cpus: cpus().length,
    totalMemBytes: totalmem(),
    execArgv: [...process.execArgv],
    gcExposed: gcAvailable(),
    startedAtIso: new Date().toISOString(),
    gitCommit,
  };
}
