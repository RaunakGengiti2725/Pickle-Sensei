import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { generateSwing, generateSwingSequence } from "@pickle/evaluation";
import type { PoseFrame } from "@pickle/shared-types";
import type { PoseSequence } from "@pickle/swing-domain";
import type { StrokeEvent } from "@pickle/vision-contracts";
import {
  assessPaddleTrackIdentity,
  classifyStroke,
  createGeometryProviderSet,
  detectOfflineStrokeWindow,
  estimateContact,
  evaluateCaptureQuality,
  evaluateFrameAnalyzability,
  GeometricPhaseSegmenter,
  GeometryBiomechanicsExtractor,
  paddleOwnershipFromHandAffinity,
  PoseGeometryFeatureExtractor,
  RecordedPoseProvider,
  RecordedTriggerStrokeDetector,
  type FrameStats,
} from "../src/index.js";

/**
 * EXECUTION AUDIT — numeric stability / degenerate-input probes for the
 * public vision-geometry API. Every probe records (a) whether the call threw,
 * (b) whether any non-finite number leaked into the returned structure, and
 * (c) whether the result claims success (`ok` / `estimated` / `analyzable`)
 * on input that carries no usable evidence. The table is written to
 * $AUDIT_OUT_DIR/numeric-stability.json so the report can cite it.
 *
 * Assertions encode the contract the package documents for itself: "nothing
 * not measured is claimed", "abstain instead of guessing", deterministic
 * output. A failing probe is a finding, not a reason to loosen the probe.
 */

type Outcome = {
  probe: string;
  threw: string | null;
  nonFinitePaths: string[];
  claimedSuccess: boolean | null;
  summary: string;
};

const OUT_DIR =
  process.env.AUDIT_OUT_DIR ??
  join(import.meta.dirname, "../../../artifacts/vision-geometry-audit");
const outcomes: Outcome[] = [];

function nonFinitePaths(value: unknown, path = "$", acc: string[] = [], depth = 0): string[] {
  if (depth > 12) return acc;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) acc.push(`${path}=${String(value)}`);
    return acc;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => nonFinitePaths(entry, `${path}[${index}]`, acc, depth + 1));
    return acc;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      nonFinitePaths(entry, `${path}.${key}`, acc, depth + 1);
    }
  }
  return acc;
}

function record(probe: string, run: () => unknown, claimed: (result: unknown) => boolean | null) {
  let threw: string | null = null;
  let result: unknown = undefined;
  try {
    result = run();
  } catch (error) {
    threw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  const paths = threw === null ? nonFinitePaths(result) : [];
  const claimedSuccess = threw === null ? claimed(result) : null;
  const outcome: Outcome = {
    probe,
    threw,
    nonFinitePaths: paths.slice(0, 12),
    claimedSuccess,
    summary:
      threw !== null
        ? `THREW ${threw}`
        : `${claimedSuccess === true ? "SUCCESS-CLAIMED" : claimedSuccess === false ? "abstained/failed" : "n/a"}; nonFinite=${paths.length}`,
  };
  outcomes.push(outcome);
  return { result, ...outcome };
}

const resultOk = (r: unknown) => (r as { ok: boolean }).ok === true;
const estimated = (r: unknown) => (r as { status: string }).status === "estimated";
const analyzable = (r: unknown) => (r as { analyzable: boolean }).analyzable === true;

function mutateFrames(
  sequence: PoseSequence,
  map: (frame: PoseSequence["frames"][number], index: number) => PoseSequence["frames"][number],
): PoseSequence {
  return { ...sequence, frames: sequence.frames.map(map) };
}

afterAll(() => {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    join(OUT_DIR, "numeric-stability.json"),
    JSON.stringify(
      {
        generatedAtIso: new Date().toISOString(),
        probes: outcomes.length,
        threw: outcomes.filter((o) => o.threw !== null).length,
        nonFiniteLeaks: outcomes.filter((o) => o.nonFinitePaths.length > 0).length,
        successClaimedOnDegenerateInput: outcomes.filter((o) => o.claimedSuccess === true).length,
        outcomes,
      },
      null,
      2,
    ) + "\n",
  );
});

describe("determinism (run twice → byte-identical)", () => {
  it("offline trigger, contact estimate, stroke class, phases, features are deterministic", async () => {
    const { sequence, window } = generateSwingSequence();
    const one = {
      trigger: detectOfflineStrokeWindow(sequence),
      contact: estimateContact({
        sequence,
        window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
        ballObservations: null,
      }),
      stroke: classifyStroke({
        sequence,
        window,
        contactMs: window.peakMs,
        handedness: "right",
        paddle: null,
        paddleSpeeds: null,
        wristSpeeds: null,
      }),
    };
    const two = {
      trigger: detectOfflineStrokeWindow(structuredClone(sequence)),
      contact: estimateContact({
        sequence: structuredClone(sequence),
        window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
        ballObservations: null,
      }),
      stroke: classifyStroke({
        sequence: structuredClone(sequence),
        window,
        contactMs: window.peakMs,
        handedness: "right",
        paddle: null,
        paddleSpeeds: null,
        wristSpeeds: null,
      }),
    };
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));

    const swing = generateSwing();
    const stroke: StrokeEvent = {
      startMs: swing.window.startMs,
      endMs: swing.window.endMs,
      contactMs: swing.window.peakMs,
      shotTypeHypothesis: null,
      confidence: 0.9,
    };
    const aspect = swing.clip.width / swing.clip.height;
    const seg = new GeometricPhaseSegmenter({ aspectRatio: aspect });
    const p1 = await seg.segmentPhases(swing.frames, [], stroke);
    const p2 = await seg.segmentPhases(structuredClone(swing.frames), [], stroke);
    expect(JSON.stringify(p2)).toBe(JSON.stringify(p1));
    expect(p1.ok).toBe(true);
    if (!p1.ok) return;
    const fx = new PoseGeometryFeatureExtractor({ aspectRatio: aspect });
    const f1 = await fx.extractMeasurements({
      poseFrames: swing.frames,
      paddleFrames: [],
      phases: p1.value,
      shotType: "forehand_drive",
      handedness: "right",
      cameraView: "side",
    });
    const f2 = await fx.extractMeasurements({
      poseFrames: structuredClone(swing.frames),
      paddleFrames: [],
      phases: structuredClone(p1.value),
      shotType: "forehand_drive",
      handedness: "right",
      cameraView: "side",
    });
    expect(JSON.stringify(f2)).toBe(JSON.stringify(f1));
  });

  it("does not mutate its inputs", () => {
    const { sequence, window } = generateSwingSequence();
    const before = JSON.stringify(sequence);
    detectOfflineStrokeWindow(sequence);
    estimateContact({
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
      ballObservations: null,
    });
    evaluateCaptureQuality(sequence);
    classifyStroke({
      sequence,
      window,
      contactMs: window.peakMs,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(JSON.stringify(sequence)).toBe(before);
  });
});

describe("evaluateCaptureQuality — degenerate pose input", () => {
  it("empty sequence abstains without NaN", () => {
    const { sequence } = generateSwingSequence();
    const r = record(
      "captureQuality.emptyFrames",
      () => evaluateCaptureQuality({ ...sequence, frames: [] }),
      analyzable,
    );
    expect(r.threw).toBeNull();
    expect(r.nonFinitePaths).toEqual([]);
    expect(r.claimedSuccess).toBe(false);
  });

  it("NaN frame confidence must not pass the confidence gate", () => {
    const { sequence } = generateSwingSequence();
    const r = record(
      "captureQuality.nanConfidence",
      () => evaluateCaptureQuality(mutateFrames(sequence, (f) => ({ ...f, confidence: NaN }))),
      analyzable,
    );
    expect(r.threw).toBeNull();
    // Contract: a recording that fails here must never produce a confident
    // score. NaN confidence is unmeasured confidence.
    expect(r.claimedSuccess).toBe(false);
    expect(r.nonFinitePaths).toEqual([]);
  });

  it("NaN landmark coordinates must not be reported analyzable", () => {
    const { sequence } = generateSwingSequence();
    const r = record(
      "captureQuality.nanLandmarkXY",
      () =>
        evaluateCaptureQuality(
          mutateFrames(sequence, (f) => ({
            ...f,
            landmarks: f.landmarks.map((m) => ({ ...m, x: NaN, y: NaN })),
          })),
        ),
      analyzable,
    );
    expect(r.threw).toBeNull();
    expect(r.claimedSuccess).toBe(false);
    expect(r.nonFinitePaths).toEqual([]);
  });

  it("reverse-ordered timestamps (contract says ascending) are rejected or handled without sign errors", () => {
    const { sequence } = generateSwingSequence();
    const reversed = { ...sequence, frames: [...sequence.frames].reverse() };
    const r = record(
      "captureQuality.reversedTimestamps",
      () => evaluateCaptureQuality(reversed),
      analyzable,
    );
    expect(r.threw).toBeNull();
    const report = r.result as ReturnType<typeof evaluateCaptureQuality>;
    // durationMs must never be negative and fps must be positive for a real clip.
    expect(report.stats.durationMs).toBeGreaterThanOrEqual(0);
    expect(report.stats.effectiveFps).toBeGreaterThan(0);
  });

  it("all frames at the same timestamp abstain (no fps, no duration)", () => {
    const { sequence } = generateSwingSequence();
    const r = record(
      "captureQuality.sameTimestamp",
      () => evaluateCaptureQuality(mutateFrames(sequence, (f) => ({ ...f, timestampMs: 1000 }))),
      analyzable,
    );
    expect(r.threw).toBeNull();
    expect(r.claimedSuccess).toBe(false);
    expect(r.nonFinitePaths).toEqual([]);
  });
});

describe("evaluateFrameAnalyzability — degenerate frame statistics", () => {
  const good: FrameStats = {
    frameCount: 90,
    durationMs: 3000,
    width: 1080,
    height: 1920,
    interFrameDiffs: Array.from({ length: 89 }, (_, i) => 3 + (i % 5)),
    spatialLumaStd: Array.from({ length: 90 }, () => 40),
    letterboxRowFraction: 0,
  };

  it("baseline good stats are analyzable (sanity)", () => {
    const r = record("frameAnalyzability.good", () => evaluateFrameAnalyzability(good), analyzable);
    expect(r.claimedSuccess).toBe(true);
    expect(r.nonFinitePaths).toEqual([]);
  });

  it("NaN inter-frame diffs and luma std must not be analyzable", () => {
    const r = record(
      "frameAnalyzability.nanStats",
      () =>
        evaluateFrameAnalyzability({
          ...good,
          interFrameDiffs: good.interFrameDiffs.map(() => NaN),
          spatialLumaStd: good.spatialLumaStd.map(() => NaN),
        }),
      analyzable,
    );
    expect(r.threw).toBeNull();
    expect(r.claimedSuccess).toBe(false);
    expect(r.nonFinitePaths).toEqual([]);
  });

  it("NaN frameCount/durationMs must not be analyzable", () => {
    const r = record(
      "frameAnalyzability.nanCountDuration",
      () => evaluateFrameAnalyzability({ ...good, frameCount: NaN, durationMs: NaN }),
      analyzable,
    );
    expect(r.threw).toBeNull();
    expect(r.claimedSuccess).toBe(false);
    expect(r.nonFinitePaths).toEqual([]);
  });

  it("negative durationMs is not a valid capture", () => {
    const r = record(
      "frameAnalyzability.negativeDuration",
      () => evaluateFrameAnalyzability({ ...good, durationMs: -500 }),
      analyzable,
    );
    expect(r.threw).toBeNull();
    expect(r.claimedSuccess).toBe(false);
  });

  it("Infinity letterbox fraction / diffs do not leak", () => {
    const r = record(
      "frameAnalyzability.infinity",
      () =>
        evaluateFrameAnalyzability({
          ...good,
          letterboxRowFraction: Infinity,
          interFrameDiffs: good.interFrameDiffs.map(() => Infinity),
        }),
      analyzable,
    );
    expect(r.threw).toBeNull();
    expect(r.claimedSuccess).toBe(false);
    expect(r.nonFinitePaths).toEqual([]);
  });

  it("zero frames with decode errors is undecodable, never analyzable", () => {
    const r = record(
      "frameAnalyzability.zeroFramesDecodeError",
      () =>
        evaluateFrameAnalyzability({
          ...good,
          frameCount: 0,
          interFrameDiffs: [],
          spatialLumaStd: [],
          decode: { errorCount: 3, expectedFrameCount: 90 },
        } as FrameStats),
      analyzable,
    );
    expect(r.threw).toBeNull();
    expect(r.claimedSuccess).toBe(false);
    expect((r.result as { reasons: string[] }).reasons).toContain("undecodable_media");
  });
});

describe("detectOfflineStrokeWindow — degenerate pose sequences", () => {
  it("video height 0 does not throw or leak", () => {
    const { sequence } = generateSwingSequence();
    const r = record(
      "offlineTrigger.zeroHeight",
      () => detectOfflineStrokeWindow({ ...sequence, video: { ...sequence.video, height: 0 } }),
      resultOk,
    );
    expect(r.threw).toBeNull();
    expect(r.nonFinitePaths).toEqual([]);
  });

  it("NaN wrist coordinates abstain rather than fabricate a window", () => {
    const { sequence } = generateSwingSequence();
    const r = record(
      "offlineTrigger.nanWrists",
      () =>
        detectOfflineStrokeWindow(
          mutateFrames(sequence, (f) => ({
            ...f,
            landmarks: f.landmarks.map((m) =>
              m.name.endsWith("wrist") ? { ...m, x: NaN, y: NaN } : m,
            ),
          })),
        ),
      resultOk,
    );
    expect(r.threw).toBeNull();
    expect(r.claimedSuccess).toBe(false);
    expect(r.nonFinitePaths).toEqual([]);
  });

  it("a single-frame spike of Infinity in one wrist coordinate abstains", () => {
    const { sequence } = generateSwingSequence();
    const spikeAt = Math.floor(sequence.frames.length / 2);
    const r = record(
      "offlineTrigger.infinitySpike",
      () =>
        detectOfflineStrokeWindow(
          mutateFrames(sequence, (f, i) =>
            i === spikeAt
              ? {
                  ...f,
                  landmarks: f.landmarks.map((m) =>
                    m.name === "right_wrist" ? { ...m, x: Infinity } : m,
                  ),
                }
              : f,
          ),
        ),
      resultOk,
    );
    expect(r.threw).toBeNull();
    expect(r.nonFinitePaths).toEqual([]);
    expect(r.claimedSuccess).toBe(false);
  });

  it("reversed frame order (contract violation) is either rejected or produces a window with start<=peak<=end", () => {
    const { sequence } = generateSwingSequence();
    const r = record(
      "offlineTrigger.reversedFrames",
      () => detectOfflineStrokeWindow({ ...sequence, frames: [...sequence.frames].reverse() }),
      resultOk,
    );
    expect(r.threw).toBeNull();
    const res = r.result as ReturnType<typeof detectOfflineStrokeWindow>;
    if (res.ok) {
      expect(res.value.startMs).toBeLessThanOrEqual(res.value.peakMotionMs);
      expect(res.value.peakMotionMs).toBeLessThanOrEqual(res.value.endMs);
    }
  });

  it("duplicate timestamps for every frame abstain", () => {
    const { sequence } = generateSwingSequence();
    const r = record(
      "offlineTrigger.duplicateTimestamps",
      () => detectOfflineStrokeWindow(mutateFrames(sequence, (f) => ({ ...f, timestampMs: 500 }))),
      resultOk,
    );
    expect(r.threw).toBeNull();
    expect(r.claimedSuccess).toBe(false);
    expect(r.nonFinitePaths).toEqual([]);
  });

  it("exactly 12 frames (boundary) does not throw", () => {
    const { sequence } = generateSwingSequence();
    const r = record(
      "offlineTrigger.twelveFrames",
      () => detectOfflineStrokeWindow({ ...sequence, frames: sequence.frames.slice(0, 12) }),
      resultOk,
    );
    expect(r.threw).toBeNull();
    expect(r.nonFinitePaths).toEqual([]);
  });
});

describe("estimateContact — degenerate inputs", () => {
  it("inverted window abstains", () => {
    const { sequence, window } = generateSwingSequence();
    const r = record(
      "estimateContact.invertedWindow",
      () =>
        estimateContact({
          sequence,
          window: { startMs: window.endMs, endMs: window.startMs, peakMotionMs: window.peakMs },
          ballObservations: null,
        }),
      estimated,
    );
    expect(r.threw).toBeNull();
    expect(r.claimedSuccess).toBe(false);
    expect(r.nonFinitePaths).toEqual([]);
  });

  it("NaN peakMotionMs hint does not poison the estimate", () => {
    const { sequence, window } = generateSwingSequence();
    const r = record(
      "estimateContact.nanPeakHint",
      () =>
        estimateContact({
          sequence,
          window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: NaN },
          ballObservations: null,
        }),
      estimated,
    );
    expect(r.threw).toBeNull();
    expect(r.nonFinitePaths).toEqual([]);
    const res = r.result as ReturnType<typeof estimateContact>;
    if (res.status === "estimated") {
      expect(res.estimatedContactMs).toBeGreaterThanOrEqual(window.startMs);
      expect(res.estimatedContactMs).toBeLessThanOrEqual(window.endMs);
      expect(res.confidence).toBeGreaterThanOrEqual(0);
      expect(res.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("NaN ball observations are ignored, not fused", () => {
    const { sequence, window } = generateSwingSequence();
    const ball = sequence.frames.map((f) => ({
      frameIndex: f.frameIndex,
      timestampMs: f.timestampMs,
      x: NaN,
      y: NaN,
      confidence: 0.9,
    }));
    const r = record(
      "estimateContact.nanBall",
      () =>
        estimateContact({
          sequence,
          window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
          ballObservations: ball,
        }),
      estimated,
    );
    expect(r.threw).toBeNull();
    expect(r.nonFinitePaths).toEqual([]);
    const res = r.result as ReturnType<typeof estimateContact>;
    if (res.status === "estimated") {
      expect(res.ballConfirmed).toBe(false);
      expect(res.supportingEvidence.map((s) => s.signal)).not.toContain("ball_direction_change");
    }
  });

  it("NaN paddle speeds are ignored, not fused", () => {
    const { sequence, window } = generateSwingSequence();
    const speeds = sequence.frames.map((f) => ({ timestampMs: f.timestampMs, value: NaN }));
    const r = record(
      "estimateContact.nanPaddleSpeeds",
      () =>
        estimateContact({
          sequence,
          window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
          ballObservations: null,
          paddleSpeeds: speeds,
        }),
      estimated,
    );
    expect(r.threw).toBeNull();
    expect(r.nonFinitePaths).toEqual([]);
    const res = r.result as ReturnType<typeof estimateContact>;
    if (res.status === "estimated") {
      expect(res.supportingEvidence.map((s) => s.signal)).not.toContain("paddle_speed_peak");
    }
  });

  it("empty sequence abstains", () => {
    const { sequence, window } = generateSwingSequence();
    const r = record(
      "estimateContact.emptyFrames",
      () =>
        estimateContact({
          sequence: { ...sequence, frames: [] },
          window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
          ballObservations: null,
        }),
      estimated,
    );
    expect(r.threw).toBeNull();
    expect(r.claimedSuccess).toBe(false);
    expect(r.nonFinitePaths).toEqual([]);
  });

  it("estimated contact always lies inside the window with confidence in [0,1] (fuzz over 40 seeds)", () => {
    const failures: string[] = [];
    for (let seed = 0; seed < 40; seed += 1) {
      const { sequence, window } = generateSwingSequence({
        fps: 24 + (seed % 5) * 9,
        torsoLength: 0.08 + (seed % 7) * 0.05,
        handed: seed % 2 === 0 ? "right" : "left",
        accelerateMs: 80 + (seed % 6) * 40,
      });
      const res = estimateContact({
        sequence,
        window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: null },
        ballObservations: null,
      });
      const leaks = nonFinitePaths(res);
      if (leaks.length > 0) failures.push(`seed ${seed}: nonFinite ${leaks.join(",")}`);
      if (res.status === "estimated") {
        if (res.estimatedContactMs < window.startMs || res.estimatedContactMs > window.endMs)
          failures.push(`seed ${seed}: contact ${res.estimatedContactMs} outside window`);
        if (res.confidence < 0 || res.confidence > 1)
          failures.push(`seed ${seed}: confidence ${res.confidence}`);
      }
    }
    outcomes.push({
      probe: "estimateContact.fuzz40",
      threw: null,
      nonFinitePaths: [],
      claimedSuccess: null,
      summary: failures.length === 0 ? "all invariants held" : failures.join(" | "),
    });
    expect(failures).toEqual([]);
  });
});

describe("GeometricPhaseSegmenter / PoseGeometryFeatureExtractor — degenerate inputs", () => {
  function fixture() {
    const swing = generateSwing();
    const stroke: StrokeEvent = {
      startMs: swing.window.startMs,
      endMs: swing.window.endMs,
      contactMs: swing.window.peakMs,
      shotTypeHypothesis: null,
      confidence: 0.9,
    };
    return { swing, stroke, aspect: swing.clip.width / swing.clip.height };
  }

  it("aspectRatio 0 / NaN / Infinity: phases + features must not leak non-finite values", async () => {
    for (const aspectRatio of [0, NaN, Infinity, -1]) {
      const { swing, stroke } = fixture();
      const seg = new GeometricPhaseSegmenter({ aspectRatio });
      const phases = await seg.segmentPhases(swing.frames, [], stroke);
      const label = `phaseSegmenter.aspect=${String(aspectRatio)}`;
      const leaks = nonFinitePaths(phases);
      outcomes.push({
        probe: label,
        threw: null,
        nonFinitePaths: leaks.slice(0, 12),
        claimedSuccess: phases.ok,
        summary: `${phases.ok ? "SUCCESS-CLAIMED" : `failed ${(phases as { failure: { code: string } }).failure.code}`}; nonFinite=${leaks.length}`,
      });
      expect(leaks, label).toEqual([]);
      if (phases.ok) {
        const fx = new PoseGeometryFeatureExtractor({ aspectRatio });
        const features = await fx.extractMeasurements({
          poseFrames: swing.frames,
          paddleFrames: [],
          phases: phases.value,
          shotType: "forehand_drive",
          handedness: "right",
          cameraView: "side",
        });
        const fLeaks = nonFinitePaths(features);
        outcomes.push({
          probe: `featureExtractor.aspect=${String(aspectRatio)}`,
          threw: null,
          nonFinitePaths: fLeaks.slice(0, 12),
          claimedSuccess: features.ok,
          summary: `${features.ok ? `SUCCESS-CLAIMED (${features.value.length} measurements)` : "failed"}; nonFinite=${fLeaks.length}`,
        });
        expect(fLeaks, `features aspect=${aspectRatio}`).toEqual([]);
        if (features.ok) {
          for (const m of features.value) {
            expect(m.confidence, `${m.metricKey} confidence`).toBeGreaterThanOrEqual(0);
            expect(m.confidence, `${m.metricKey} confidence`).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it("phase spans are ordered, non-negative and inside the stroke window", async () => {
    const { swing, stroke, aspect } = fixture();
    const seg = new GeometricPhaseSegmenter({ aspectRatio: aspect });
    const phases = await seg.segmentPhases(swing.frames, [], stroke);
    expect(phases.ok).toBe(true);
    if (!phases.ok) return;
    let cursor = stroke.startMs;
    for (const span of phases.value) {
      expect(span.startMs).toBeGreaterThanOrEqual(cursor);
      expect(span.endMs).toBeGreaterThanOrEqual(span.startMs);
      expect(span.representativeMs).toBeGreaterThanOrEqual(span.startMs);
      expect(span.representativeMs).toBeLessThanOrEqual(span.endMs);
      expect(span.confidence).toBeGreaterThanOrEqual(0);
      expect(span.confidence).toBeLessThanOrEqual(1);
      cursor = span.endMs;
    }
    expect(cursor).toBeLessThanOrEqual(stroke.endMs);
  });

  it("stroke.contactMs = NaN abstains or ignores the hint without leaking", async () => {
    const { swing, stroke, aspect } = fixture();
    const seg = new GeometricPhaseSegmenter({ aspectRatio: aspect });
    const phases = await seg.segmentPhases(swing.frames, [], { ...stroke, contactMs: NaN });
    const leaks = nonFinitePaths(phases);
    outcomes.push({
      probe: "phaseSegmenter.nanContactHint",
      threw: null,
      nonFinitePaths: leaks.slice(0, 12),
      claimedSuccess: phases.ok,
      summary: `${phases.ok ? "SUCCESS-CLAIMED" : "failed"}; nonFinite=${leaks.length}`,
    });
    expect(leaks).toEqual([]);
  });

  it("frames with NaN confidence must not yield phase confidence NaN", async () => {
    const { swing, stroke, aspect } = fixture();
    const seg = new GeometricPhaseSegmenter({ aspectRatio: aspect });
    const frames: PoseFrame[] = swing.frames.map((f) => ({ ...f, confidence: NaN }));
    const phases = await seg.segmentPhases(frames, [], stroke);
    const leaks = nonFinitePaths(phases);
    outcomes.push({
      probe: "phaseSegmenter.nanFrameConfidence",
      threw: null,
      nonFinitePaths: leaks.slice(0, 12),
      claimedSuccess: phases.ok,
      summary: `${phases.ok ? "SUCCESS-CLAIMED" : "failed"}; nonFinite=${leaks.length}`,
    });
    expect(leaks).toEqual([]);
  });

  it("all landmarks collapsed to one point: features abstain (no torso) and never divide by zero", async () => {
    const { swing, stroke, aspect } = fixture();
    const frames: PoseFrame[] = swing.frames.map((f) => ({
      ...f,
      landmarks: f.landmarks.map((m) => ({ ...m, x: 0.5, y: 0.5 })),
    }));
    const seg = new GeometricPhaseSegmenter({ aspectRatio: aspect });
    const phases = await seg.segmentPhases(frames, [], stroke);
    outcomes.push({
      probe: "phaseSegmenter.collapsedSkeleton",
      threw: null,
      nonFinitePaths: nonFinitePaths(phases).slice(0, 12),
      claimedSuccess: phases.ok,
      summary: phases.ok
        ? "SUCCESS-CLAIMED"
        : `failed ${(phases as { failure: { code: string } }).failure.code}`,
    });
    expect(phases.ok).toBe(false);
    // Feed the extractor synthetic phases so its own guards are exercised.
    const fx = new PoseGeometryFeatureExtractor({ aspectRatio: aspect });
    const good = await seg.segmentPhases(swing.frames, [], stroke);
    if (!good.ok) return;
    const features = await fx.extractMeasurements({
      poseFrames: frames,
      paddleFrames: [],
      phases: good.value,
      shotType: "forehand_drive",
      handedness: "right",
      cameraView: "side",
    });
    const leaks = nonFinitePaths(features);
    outcomes.push({
      probe: "featureExtractor.collapsedSkeleton",
      threw: null,
      nonFinitePaths: leaks.slice(0, 12),
      claimedSuccess: features.ok,
      summary: `${features.ok ? `SUCCESS-CLAIMED (${features.value.length} measurements)` : "failed"}; nonFinite=${leaks.length}`,
    });
    expect(leaks).toEqual([]);
    expect(features.ok).toBe(false);
  });

  it("phases with NaN boundaries do not produce measurements with NaN", async () => {
    const { swing, stroke, aspect } = fixture();
    const seg = new GeometricPhaseSegmenter({ aspectRatio: aspect });
    const good = await seg.segmentPhases(swing.frames, [], stroke);
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    const fx = new PoseGeometryFeatureExtractor({ aspectRatio: aspect });
    const features = await fx.extractMeasurements({
      poseFrames: swing.frames,
      paddleFrames: [],
      phases: good.value.map((p) => ({ ...p, startMs: NaN, endMs: NaN, representativeMs: NaN })),
      shotType: "forehand_drive",
      handedness: "right",
      cameraView: "side",
    });
    const leaks = nonFinitePaths(features);
    outcomes.push({
      probe: "featureExtractor.nanPhases",
      threw: null,
      nonFinitePaths: leaks.slice(0, 12),
      claimedSuccess: features.ok,
      summary: `${features.ok ? `SUCCESS-CLAIMED (${features.value.length} measurements)` : "failed"}; nonFinite=${leaks.length}`,
    });
    expect(leaks).toEqual([]);
  });
});

describe("assessPaddleTrackIdentity / paddleOwnershipFromHandAffinity / classifyStroke", () => {
  it("torsoSpan 0 / NaN and empty tracks are undetermined without NaN", () => {
    for (const torsoSpan of [0, NaN, -0.2]) {
      const r = record(
        `paddleIdentity.torso=${String(torsoSpan)}`,
        () =>
          assessPaddleTrackIdentity({
            paddleCenters: [
              { timestampMs: 0, x: 0.5, y: 0.5 },
              { timestampMs: 33, x: 0.52, y: 0.5 },
              { timestampMs: 66, x: 0.55, y: 0.5 },
            ],
            targetWristTracks: [[{ timestampMs: 0, x: 0.5, y: 0.5 }]],
            aspect: 9 / 16,
            torsoSpan,
          }),
        (res) => (res as { verdict: string }).verdict !== "undetermined",
      );
      expect(r.threw).toBeNull();
      expect(r.nonFinitePaths).toEqual([]);
      expect(r.claimedSuccess).toBe(false);
    }
    const empty = record(
      "paddleIdentity.emptyTracks",
      () =>
        assessPaddleTrackIdentity({
          paddleCenters: [],
          targetWristTracks: [],
          aspect: 9 / 16,
          torsoSpan: 0.2,
        }),
      (res) => (res as { verdict: string }).verdict !== "undetermined",
    );
    expect(empty.threw).toBeNull();
    expect(empty.nonFinitePaths).toEqual([]);
    expect(empty.claimedSuccess).toBe(false);
  });

  it("NaN paddle centres in ownership affinity yield null or a finite confidence in [0,1]", () => {
    const { sequence } = generateSwingSequence();
    const centers = sequence.frames.map((f) => ({ timestampMs: f.timestampMs, x: NaN, y: NaN }));
    const r = record(
      "ownership.nanCenters",
      () => paddleOwnershipFromHandAffinity({ sequence, paddleCenters: centers }),
      (res) => res !== null,
    );
    expect(r.threw).toBeNull();
    expect(r.nonFinitePaths).toEqual([]);
    const res = r.result as ReturnType<typeof paddleOwnershipFromHandAffinity>;
    if (res !== null) {
      expect(res.confidence).toBeGreaterThanOrEqual(0);
      expect(res.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("classifyStroke with NaN contact, empty frames, or NaN landmarks stays UNKNOWN/finite", () => {
    const { sequence, window } = generateSwingSequence();
    const cases: Array<[string, () => unknown]> = [
      [
        "classifyStroke.nanContact",
        () =>
          classifyStroke({
            sequence,
            window,
            contactMs: NaN,
            handedness: "right",
            paddle: null,
            paddleSpeeds: null,
            wristSpeeds: null,
          }),
      ],
      [
        "classifyStroke.emptyFrames",
        () =>
          classifyStroke({
            sequence: { ...sequence, frames: [] },
            window,
            contactMs: window.peakMs,
            handedness: "right",
            paddle: null,
            paddleSpeeds: null,
            wristSpeeds: null,
          }),
      ],
      [
        "classifyStroke.nanLandmarks",
        () =>
          classifyStroke({
            sequence: mutateFrames(sequence, (f) => ({
              ...f,
              landmarks: f.landmarks.map((m) => ({ ...m, x: NaN, y: NaN })),
            })),
            window,
            contactMs: window.peakMs,
            handedness: "right",
            paddle: null,
            paddleSpeeds: null,
            wristSpeeds: null,
          }),
      ],
      [
        "classifyStroke.noContactNoPeak",
        () =>
          classifyStroke({
            sequence,
            window,
            contactMs: null,
            eventPeakMs: null,
            handedness: "right",
            paddle: null,
            paddleSpeeds: null,
            wristSpeeds: null,
          }),
      ],
    ];
    for (const [label, run] of cases) {
      const r = record(label, run, (res) => (res as { label: string }).label !== "UNKNOWN");
      expect(r.threw, label).toBeNull();
      expect(r.nonFinitePaths, label).toEqual([]);
      const pred = r.result as ReturnType<typeof classifyStroke>;
      expect(pred.confidence, label).toBeGreaterThanOrEqual(0);
      expect(pred.confidence, label).toBeLessThanOrEqual(1);
      if (label !== "classifyStroke.nanContact") expect(pred.label, label).toBe("UNKNOWN");
    }
  });
});

describe("providers / createGeometryProviderSet", () => {
  it("video.height 0 falls back to aspect 1 and the set is fully constructed", async () => {
    const swing = generateSwing();
    const set = createGeometryProviderSet({
      poseFrames: swing.frames,
      poseModelVersion: "apple-vision-bodypose-1",
      trigger: {
        modelVersion: "temporal-stroke-heuristic-2",
        startMs: swing.window.startMs,
        endMs: swing.window.endMs,
        peakMotionMs: swing.window.peakMs,
        confidence: 0.88,
      },
      video: { width: 1080, height: 0 },
    });
    expect(set.ball).toBeNull();
    const clip = { uri: "x", durationMs: 1, fps: 60, width: 1080, height: 0 };
    const strokes = await set.stroke.detectStrokes(clip);
    expect(strokes.ok).toBe(true);
    const pose = await set.pose.extractPose(clip, swing.window);
    expect(pose.ok).toBe(true);
    const paddle = await set.paddle.detectPaddle(clip, swing.window);
    expect(paddle.ok && paddle.value.length === 0).toBe(true);
  });

  it("inverted / zero-length trigger windows are rejected", async () => {
    const inverted = new RecordedTriggerStrokeDetector({
      triggerModelVersion: "t",
      startMs: 1000,
      endMs: 900,
      peakMotionMs: null,
      confidence: 0.5,
    });
    const zero = new RecordedTriggerStrokeDetector({
      triggerModelVersion: "t",
      startMs: 1000,
      endMs: 1000,
      peakMotionMs: null,
      confidence: 0.5,
    });
    const clip = { uri: "x", durationMs: 1, fps: 60, width: 1, height: 1 };
    expect((await inverted.detectStrokes(clip)).ok).toBe(false);
    expect((await zero.detectStrokes(clip)).ok).toBe(false);
  });

  it("NaN trigger bounds are rejected, not replayed as a real detection", async () => {
    const nan = new RecordedTriggerStrokeDetector({
      triggerModelVersion: "t",
      startMs: NaN,
      endMs: NaN,
      peakMotionMs: null,
      confidence: 0.5,
    });
    const clip = { uri: "x", durationMs: 1, fps: 60, width: 1, height: 1 };
    const res = await nan.detectStrokes(clip);
    const leaks = nonFinitePaths(res);
    outcomes.push({
      probe: "recordedTrigger.nanBounds",
      threw: null,
      nonFinitePaths: leaks.slice(0, 12),
      claimedSuccess: res.ok,
      summary: `${res.ok ? "SUCCESS-CLAIMED" : "failed"}; nonFinite=${leaks.length}`,
    });
    expect(res.ok).toBe(false);
  });

  it("RecordedPoseProvider sorts unsorted frames and enforces the 6-frame floor", async () => {
    const swing = generateSwing();
    const provider = new RecordedPoseProvider({
      frames: [...swing.frames].reverse(),
      poseModelVersion: "m",
    });
    const clip = { uri: "x", durationMs: 1, fps: 60, width: 1, height: 1 };
    const res = await provider.extractPose(clip, swing.window);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    for (let i = 1; i < res.value.length; i += 1) {
      expect(res.value[i]!.timestampMs).toBeGreaterThanOrEqual(res.value[i - 1]!.timestampMs);
    }
    const few = await provider.extractPose(clip, {
      startMs: swing.window.startMs,
      endMs: swing.window.startMs + 1,
    });
    expect(few.ok).toBe(false);
  });

  it("GeometryBiomechanicsExtractor with zero-height video does not leak", async () => {
    const { sequence } = generateSwingSequence();
    const swing = generateSwing();
    const seg = new GeometricPhaseSegmenter({ aspectRatio: 1 });
    const phases = await seg.segmentPhases(swing.frames, [], {
      startMs: swing.window.startMs,
      endMs: swing.window.endMs,
      contactMs: swing.window.peakMs,
      shotTypeHypothesis: null,
      confidence: 0.9,
    });
    expect(phases.ok).toBe(true);
    if (!phases.ok) return;
    const extractor = new GeometryBiomechanicsExtractor();
    const out = await extractor.extract({
      pose: { ...sequence, video: { ...sequence.video, height: 0 } },
      paddle: null,
      phases: phases.value,
      shotType: "forehand_drive",
      handedness: "right",
      cameraView: "side",
    });
    const leaks = nonFinitePaths(out);
    outcomes.push({
      probe: "biomechanicsExtractor.zeroHeight",
      threw: null,
      nonFinitePaths: leaks.slice(0, 12),
      claimedSuccess: out.ok,
      summary: `${out.ok ? `SUCCESS-CLAIMED (${out.value.length})` : "failed"}; nonFinite=${leaks.length}`,
    });
    expect(leaks).toEqual([]);
  });
});
