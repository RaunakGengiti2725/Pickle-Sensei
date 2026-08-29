import { describe, expect, it } from "vitest";
import { generateSwingSequence } from "@pickle/evaluation";
import {
  aggregateBallOcclusionResults,
  bucketForBallLabel,
  buildBallTracks,
  scoreBallOcclusionCase,
  selectPrimaryBallTrack,
  type BallCandidateFile,
} from "../src/index.js";
import type { BallFrameLabel } from "../src/annotationSchema.js";
import type { BallPrediction } from "../src/ballBench.js";
import { BALL_OCCLUSION } from "../src/ballTracker.js";

/**
 * Occlusion-bucketed evaluation of the ball tracker: unit tests of the
 * scoring math plus REPLAY fixtures that run the real state machine against
 * occlusion-state gold (the C04 label semantics). Real-footage scoring
 * requires the macOS run artifacts (see ballOcclusionBench CLI).
 */

function candidateFile(frames: BallCandidateFile["frames"]): BallCandidateFile {
  return {
    schemaVersion: 1,
    generator: { version: "test", method: "test", scale: 0.5, note: "" },
    video: { path: "test.mp4", width: 1000, height: 1000, fps: 25, durationMs: 4000 },
    window: { startMs: 0, endMs: 4000 },
    backgroundActivity: { grid: 24, cells: new Array(24 * 24).fill(0) },
    timing: { framesProcessed: frames.length, wallSecTotal: 0, msPerFrame: 0 },
    frames,
  };
}

const ball = (x: number, y: number, area = 40) => ({
  x,
  y,
  areaPx: area,
  wNorm: 0.01,
  hNorm: 0.01,
  elong: 1.2,
  score: 500,
});

const WINDOW = { startMs: 300, endMs: 1400 };

const visible = (tMs: number, x: number, y: number, state?: BallFrameLabel["occlusionState"]) =>
  ({
    tMs,
    point: { x, y },
    visibility: "visible",
    ...(state !== undefined ? { occlusionState: state } : {}),
  }) as BallFrameLabel;

const occluded = (tMs: number): BallFrameLabel => ({
  tMs,
  point: null,
  visibility: "occluded",
  occlusionState: "occluded",
});

describe("bucketForBallLabel", () => {
  it("maps explicit occlusion states to their buckets", () => {
    expect(bucketForBallLabel(visible(0, 0.5, 0.5, "observed"))).toBe("OBSERVED");
    expect(bucketForBallLabel(visible(0, 0.5, 0.5, "entering_occlusion"))).toBe(
      "ENTERING_OCCLUSION",
    );
    expect(bucketForBallLabel(occluded(0))).toBe("OCCLUDED");
    expect(bucketForBallLabel(visible(0, 0.5, 0.5, "reacquired"))).toBe("REACQUIRED");
  });

  it("buckets pre-waveC labels (no occlusionState) by visibility", () => {
    expect(bucketForBallLabel(visible(0, 0.5, 0.5))).toBe("OBSERVED");
    expect(bucketForBallLabel({ tMs: 0, point: null, visibility: "occluded" })).toBe("OCCLUDED");
    expect(bucketForBallLabel({ tMs: 0, point: null, visibility: "not_visible" })).toBe(
      "NOT_VISIBLE",
    );
    expect(bucketForBallLabel({ tMs: 0, point: null, visibility: "uncertain" })).toBe(
      "UNCERTAIN_EXCLUDED",
    );
  });
});

describe("scoreBallOcclusionCase", () => {
  const predictions: BallPrediction[] = [
    { t: 100, x: 0.5, y: 0.5, conf: 0.5 },
    { t: 140, x: 0.54, y: 0.5, conf: 0.5 },
    { t: 300, x: 0.7, y: 0.5, conf: 0.5 },
  ];

  it("scores visible buckets and flags any point emitted during OCCLUDED gold", () => {
    const labels: BallFrameLabel[] = [
      visible(100, 0.5, 0.5, "observed"), // hit
      visible(140, 0.9, 0.9, "entering_occlusion"), // wrong location
      occluded(200), // no prediction within 40ms → abstained
      occluded(300), // prediction at 300 → VIOLATION
      visible(500, 0.8, 0.5, "reacquired"), // no prediction → miss
      { tMs: 700, point: null, visibility: "uncertain" },
    ];
    const result = scoreBallOcclusionCase("t", labels, predictions, null);
    const byBucket = Object.fromEntries(result.buckets.map((score) => [score.bucket, score]));
    expect(byBucket["OBSERVED"]).toMatchObject({ n: 1, hits: 1 });
    expect(byBucket["ENTERING_OCCLUSION"]).toMatchObject({ n: 1, wrongLocation: 1 });
    expect(byBucket["OCCLUDED"]).toMatchObject({ n: 2, abstained: 1, violations: 1 });
    expect(byBucket["REACQUIRED"]).toMatchObject({ n: 1, misses: 1 });
    expect(byBucket["UNCERTAIN_EXCLUDED"]).toMatchObject({ n: 1 });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.kind).toBe("EMITTED_DURING_OCCLUDED_GOLD");
  });

  it("flags points emitted during NOT_VISIBLE gold", () => {
    const labels: BallFrameLabel[] = [{ tMs: 100, point: null, visibility: "not_visible" }];
    const result = scoreBallOcclusionCase("t", labels, predictions, null);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.kind).toBe("EMITTED_DURING_NOT_VISIBLE_GOLD");
  });

  it("flags an unflagged bridge point and a bridge/observation timestamp collision", () => {
    const timeline = {
      states: [],
      bridge: [
        { t: 200, x: 0.6, y: 0.5, predicted: true as const },
        { t: 300, x: 0.7, y: 0.5, predicted: true as const }, // collides with obs at 300
      ],
      reacquisition: { attempted: false as const },
    };
    const result = scoreBallOcclusionCase("t", [], predictions, timeline);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.kind).toBe("UNFLAGGED_BRIDGE_POINT");
    const tampered = {
      ...timeline,
      bridge: [{ t: 200, x: 0.6, y: 0.5, predicted: false as unknown as true }],
    };
    const tamperedResult = scoreBallOcclusionCase("t", [], predictions, tampered);
    expect(tamperedResult.violations).toHaveLength(1);
  });

  it("aggregates per-bucket n across cases without changing denominators", () => {
    const a = scoreBallOcclusionCase("a", [visible(100, 0.5, 0.5, "observed")], predictions, null);
    const b = scoreBallOcclusionCase("b", [occluded(200), occluded(300)], predictions, null);
    const totals = aggregateBallOcclusionResults([a, b]);
    const byBucket = Object.fromEntries(totals.map((score) => [score.bucket, score]));
    expect(byBucket["OBSERVED"]!.n).toBe(1);
    expect(byBucket["OCCLUDED"]).toMatchObject({ n: 2, abstained: 1, violations: 1 });
  });
});

// ── REPLAY fixtures: real state machine scored against occlusion gold ──────
//
// Geometry mirrors ballTracker.test.ts: the synthetic player's padded body
// region spans x[0.315,0.685]; an incoming ball at y=0.5 flies into it at
// 1.0 u/s and vanishes; a compatible segment emerges on the far side.

function incomingFrames(extra: Array<{ tMs: number; x: number; y: number }> = []) {
  const frames: BallCandidateFile["frames"] = [];
  for (let index = 0; index < 50; index += 1) {
    const tMs = index * 40;
    const candidates = [];
    if (index >= 10 && index < 18) {
      candidates.push(ball(0.02 + (index - 10) * 0.04, 0.5));
    }
    for (const point of extra) {
      if (point.tMs === tMs) candidates.push(ball(point.x, point.y));
    }
    frames.push({ tMs, candidates, rawComponentCount: candidates.length });
  }
  return frames;
}

function farPaddle() {
  return Array.from({ length: 13 }, (_, index) => ({
    timestampMs: 400 + index * 40,
    box: { x: 0.88, y: 0.88, width: 0.04, height: 0.04 },
    center: { x: 0.9, y: 0.9 },
    detectorScore: 0.7,
    trackId: 9,
    confidence: 0.7,
    nearWrist: true,
  }));
}

function emergence(t0: number, y0: number, dy: number) {
  const points = [];
  for (let index = 0; index < 4; index += 1) {
    points.push({ tMs: t0 + index * 40, x: 0.7 + index * 0.02, y: y0 + index * dy });
  }
  return points;
}

function trackPredictions(outcome: ReturnType<typeof selectPrimaryBallTrack>): BallPrediction[] {
  if (outcome.status !== "tracked") return [];
  return outcome.track.observations.map((observation) => ({
    t: observation.timestampMs,
    x: observation.x,
    y: observation.y,
    conf: observation.confidence,
  }));
}

describe("replay: occlusion state machine scored against occlusion gold", () => {
  const { sequence } = generateSwingSequence();

  it("reacquisition case: hits in OBSERVED/ENTERING/REACQUIRED, zero OCCLUDED violations", () => {
    const emerged = emergence(1000, 0.78, 0.014);
    const { gated, fragments, ablation } = buildBallTracks(
      candidateFile(incomingFrames(emerged)),
      sequence,
      WINDOW,
      farPaddle(),
    );
    const outcome = selectPrimaryBallTrack(gated, ablation, WINDOW, {
      paddleTrackExists: true,
      fragments,
    });
    expect(outcome.status).toBe("tracked");
    if (outcome.status !== "tracked") return;

    // Gold mirrors the fixture: flight OBSERVED, terminal approach
    // ENTERING_OCCLUSION, the gap OCCLUDED (no points), emergence REACQUIRED.
    const labels: BallFrameLabel[] = [
      visible(440, 0.06, 0.5, "observed"),
      visible(560, 0.18, 0.5, "observed"),
      visible(680, 0.3, 0.5, "entering_occlusion"),
      occluded(760),
      occluded(880),
      visible(1000, emerged[0]!.x, emerged[0]!.y, "reacquired"),
      visible(1040, emerged[1]!.x, emerged[1]!.y, "observed"),
    ];
    const result = scoreBallOcclusionCase(
      "replay-reacquire",
      labels,
      trackPredictions(outcome),
      outcome.timeline,
    );
    const byBucket = Object.fromEntries(result.buckets.map((score) => [score.bucket, score]));
    expect(byBucket["OBSERVED"]).toMatchObject({ n: 3, hits: 3 });
    expect(byBucket["ENTERING_OCCLUSION"]).toMatchObject({ n: 1, hits: 1 });
    expect(byBucket["OCCLUDED"]).toMatchObject({ n: 2, abstained: 2, violations: 0 });
    expect(byBucket["REACQUIRED"]).toMatchObject({ n: 1, hits: 1 });
    expect(result.violations).toEqual([]);
  });

  it("honest-LOST case: OCCLUDED gold abstained through the bounded search, no bridge", () => {
    const { gated, fragments, ablation } = buildBallTracks(
      candidateFile(incomingFrames()),
      sequence,
      WINDOW,
      farPaddle(),
    );
    const outcome = selectPrimaryBallTrack(gated, ablation, WINDOW, {
      paddleTrackExists: true,
      fragments,
    });
    expect(outcome.status).toBe("tracked");
    if (outcome.status !== "tracked") return;
    const labels: BallFrameLabel[] = [
      visible(560, 0.18, 0.5, "observed"),
      visible(680, 0.3, 0.5, "entering_occlusion"),
      occluded(760),
      occluded(880),
      occluded(680 + BALL_OCCLUSION.maxOcclusionMs), // end of the search bound
    ];
    const result = scoreBallOcclusionCase(
      "replay-lost",
      labels,
      trackPredictions(outcome),
      outcome.timeline,
    );
    const byBucket = Object.fromEntries(result.buckets.map((score) => [score.bucket, score]));
    expect(byBucket["OCCLUDED"]).toMatchObject({ n: 3, abstained: 3, violations: 0 });
    expect(outcome.timeline.bridge).toEqual([]);
    expect(result.violations).toEqual([]);
  });

  it("bridge predictions stay flagged and never collide with canonical observations", () => {
    const { gated, fragments, ablation } = buildBallTracks(
      candidateFile(incomingFrames(emergence(1000, 0.78, 0.014))),
      sequence,
      WINDOW,
      farPaddle(),
    );
    const outcome = selectPrimaryBallTrack(gated, ablation, WINDOW, {
      paddleTrackExists: true,
      fragments,
    });
    expect(outcome.status).toBe("tracked");
    if (outcome.status !== "tracked") return;
    expect(outcome.timeline.bridge.length).toBeGreaterThan(0);
    const result = scoreBallOcclusionCase(
      "replay-bridge",
      [],
      trackPredictions(outcome),
      outcome.timeline,
    );
    expect(result.violations).toEqual([]);
  });
});
