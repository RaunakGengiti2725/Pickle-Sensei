import { describe, expect, it } from "vitest";
import { generateSwingSequence } from "@pickle/evaluation";
import {
  buildPaddleTracks,
  PADDLE_CONFIDENCE_MODEL,
  selectPrimaryPaddleTrack,
  paddleSpeedSeries,
  wristSeries,
  type RawPaddleDetectionFile,
} from "../src/index.js";
import {
  segmentTrackByWristOwnership,
  type PaddleTrackCandidate,
  type TrackedPaddleObservation,
} from "../src/paddleTracker.js";

/**
 * Synthetic DETECTION streams (not synthetic paddles-in-the-app): these test
 * the association/gating math with known inputs, the same way the kinematics
 * tests work. Real-footage behavior is verified by the lab run + benchmark.
 */

const VIDEO = { path: "test.mp4", width: 1000, height: 1000, fps: 50, durationMs: 4000 };

function detectionFile(frames: RawPaddleDetectionFile["frames"]): RawPaddleDetectionFile {
  return {
    schemaVersion: 1,
    detector: {
      modelId: "test",
      version: "test",
      license: "Apache-2.0",
      device: "cpu",
      proxyLabels: ["tennis racket"],
      proxyNote: "",
      scoreFloor: 0.08,
    },
    video: VIDEO,
    window: { startMs: 0, endMs: VIDEO.durationMs },
    timing: {
      modelLoadSec: 0,
      framesProcessed: frames.length,
      inferenceSecTotal: 0,
      inferenceMsPerFrame: 0,
      wallSecTotal: 0,
    },
    frames,
  };
}

/** A moving detection following the synthetic swing's right wrist. */
function movingDetections(options: { dropEvery?: number; score?: number } = {}) {
  const { sequence, window } = generateSwingSequence();
  const frames: RawPaddleDetectionFile["frames"] = [];
  let index = 0;
  for (const frame of sequence.frames) {
    const wrist = frame.landmarks.find((mark) => mark.name === "right_wrist")!;
    index += 1;
    const detections: RawPaddleDetectionFile["frames"][number]["detections"] = [];
    if (!(options.dropEvery && index % options.dropEvery === 0)) {
      const cx = wrist.x * 1000;
      const cy = wrist.y * 1000 - 40; // paddle rides above/beside the wrist
      detections.push({
        box: [cx - 35, cy - 45, cx + 35, cy + 45],
        score: options.score ?? 0.7,
        label: "tennis racket",
      });
    }
    frames.push({ tMs: frame.timestampMs, detections, extras: [] });
  }
  return {
    file: detectionFile(frames),
    sequence,
    window: { startMs: window.startMs, endMs: window.endMs },
  };
}

function addStaticFalsePositive(file: RawPaddleDetectionFile, score = 0.9): RawPaddleDetectionFile {
  return {
    ...file,
    frames: file.frames.map((frame) => ({
      ...frame,
      detections: [
        ...frame.detections,
        // Crowd racket far from any wrist, high score, perfectly stable.
        {
          box: [40, 40, 100, 110] as [number, number, number, number],
          score,
          label: "tennis racket",
        },
      ],
    })),
  };
}

describe("buildPaddleTracks", () => {
  it("associates a moving detection stream into one continuous track", () => {
    const { file, window } = movingDetections();
    const tracks = buildPaddleTracks(file, window);
    expect(tracks.length).toBe(1);
    expect(tracks[0]!.observations.length).toBe(file.frames.length);
    expect(tracks[0]!.windowCoverage).toBeGreaterThan(0.9);
  });

  it("survives dropped frames without interpolating them", () => {
    const { file, window } = movingDetections({ dropEvery: 7 });
    const tracks = buildPaddleTracks(file, window);
    expect(tracks.length).toBe(1);
    const withDetections = file.frames.filter((frame) => frame.detections.length > 0).length;
    expect(tracks[0]!.observations.length).toBe(withDetections); // no invented frames
  });

  it("low-score detections extend tracks but never start them", () => {
    const { file, window } = movingDetections({ score: 0.2 }); // below startScore, above extendScore
    expect(buildPaddleTracks(file, window).length).toBe(0);

    // Same stream but the first frame is high-score: track starts, then the
    // low-score stream keeps it alive.
    const seeded = {
      ...file,
      frames: file.frames.map((frame, index) =>
        index === 0
          ? {
              ...frame,
              detections: frame.detections.map((detection) => ({ ...detection, score: 0.8 })),
            }
          : frame,
      ),
    };
    const tracks = buildPaddleTracks(seeded, window);
    expect(tracks.length).toBe(1);
    expect(tracks[0]!.observations.length).toBe(file.frames.length);
  });

  it("rejects implausibly large boxes (buildings, people)", () => {
    const { file, window } = movingDetections();
    const huge = {
      ...file,
      frames: file.frames.map((frame) => ({
        ...frame,
        detections: [
          ...frame.detections,
          {
            box: [0, 0, 900, 900] as [number, number, number, number],
            score: 0.9,
            label: "tennis racket",
          },
        ],
      })),
    };
    const tracks = buildPaddleTracks(huge, window);
    expect(tracks.length).toBe(1); // giant box never became a track
  });
});

describe("selectPrimaryPaddleTrack", () => {
  it("prefers the wrist-adjacent track over a stronger-scoring crowd track", () => {
    const { file, sequence, window } = movingDetections();
    const noisy = addStaticFalsePositive(file, 0.95);
    const tracks = buildPaddleTracks(noisy, window);
    expect(tracks.length).toBe(2);
    const outcome = selectPrimaryPaddleTrack(tracks, wristSeries(sequence), window);
    expect(outcome.status).toBe("tracked");
    if (outcome.status !== "tracked") return;
    // The selected track moves with the wrist; the crowd box sits at ~(0.07, 0.075).
    const first = outcome.lab.observations[0]!;
    expect(Math.hypot(first.center.x - 0.07, first.center.y - 0.075)).toBeGreaterThan(0.1);
    expect(outcome.lab.meanWristDistance).not.toBeNull();
    expect(outcome.lab.meanWristDistance!).toBeLessThan(0.12);
  });

  it("returns untracked (never a wrist-fabricated observation) when only far tracks exist", () => {
    const { sequence, window } = movingDetections();
    const onlyCrowd = addStaticFalsePositive(
      detectionFile(
        sequence.frames.map((frame) => ({ tMs: frame.timestampMs, detections: [], extras: [] })),
      ),
      0.95,
    );
    const tracks = buildPaddleTracks(onlyCrowd, window);
    const outcome = selectPrimaryPaddleTrack(tracks, wristSeries(sequence), window);
    expect(outcome.status).toBe("untracked");
    if (outcome.status === "untracked") {
      expect(outcome.reason).toContain("far_from_wrists");
    }
  });

  it("produces a canonical PaddleTrack with provenance naming the COCO proxy", () => {
    const { file, sequence, window } = movingDetections();
    const outcome = selectPrimaryPaddleTrack(
      buildPaddleTracks(file, window),
      wristSeries(sequence),
      window,
    );
    expect(outcome.status).toBe("tracked");
    if (outcome.status !== "tracked") return;
    expect(outcome.track.producedBy.providerId).toBe("paddle.dfine-coco-proxy");
    expect(outcome.track.coordinateSystem).toBe("normalized_image_top_left");
    expect(outcome.track.continuity).toBeGreaterThan(0.9);
    const observation = outcome.track.observations[10]!;
    expect(observation.bbox!.width).toBeGreaterThan(0);
    expect(observation.bbox!.width).toBeLessThan(0.2);
    expect(observation.keypoints.center).not.toBeNull();
    expect(observation.keypoints.tip).toBeNull(); // no fabricated keypoints
    expect(PADDLE_CONFIDENCE_MODEL).toContain("uncalibrated");
  });
});

// ── FLIP-SEGMENTATION (wave-B W1) ──────────────────────────────────────────
// Hand-built wrist series + tracks with KNOWN ownership per time range, so
// the segmentation math is tested against explicit expectations.

const STEP_MS = 50;

/** Constant-position wrist series sampled at STEP_MS over [0, endMs]. */
function constantWrists(
  endMs: number,
  at: { x: number; y: number },
  override?: (tMs: number) => { x: number; y: number } | null,
): ReturnType<typeof wristSeries> {
  const series: ReturnType<typeof wristSeries> = [];
  for (let tMs = 0; tMs <= endMs; tMs += STEP_MS) {
    const point = override ? (override(tMs) ?? at) : at;
    series.push({ timestampMs: tMs, wrists: [{ x: point.x, y: point.y }] });
  }
  return series;
}

function observationAt(tMs: number, x: number, y: number, score = 0.5): TrackedPaddleObservation {
  return {
    timestampMs: tMs,
    box: { x: x - 0.03, y: y - 0.03, width: 0.06, height: 0.06 },
    center: { x, y },
    detectorScore: score,
    trackId: 1,
    confidence: 0.5,
    nearWrist: false,
  };
}

/** Track riding at a fixed point, sampled at STEP_MS over [startMs, endMs]. */
function trackObservations(
  startMs: number,
  endMs: number,
  at: { x: number; y: number },
  score = 0.5,
): TrackedPaddleObservation[] {
  const observations: TrackedPaddleObservation[] = [];
  for (let tMs = startMs; tMs <= endMs; tMs += STEP_MS) {
    observations.push(observationAt(tMs, at.x, at.y, score));
  }
  return observations;
}

function candidateOf(
  trackId: number,
  observations: TrackedPaddleObservation[],
  stale: { windowCoverage: number; meanScore: number },
): PaddleTrackCandidate {
  return {
    trackId,
    observations: observations.map((observation) => ({ ...observation, trackId })),
    meanScore: stale.meanScore,
    windowCoverage: stale.windowCoverage,
    meanWristDistance: null,
  };
}

const WINDOW = { startMs: 0, endMs: 4000 };
// Target wrist parked at (0.5, 0.5); the paddle rides just beside it.
const TARGET = { x: 0.5, y: 0.5 };
const PADDLE = { x: 0.52, y: 0.52 };
// Other player's wrist far away (0.9, 0.9) except where a test moves it in.
const OTHER_FAR = { x: 0.9, y: 0.9 };

describe("segmentTrackByWristOwnership", () => {
  const targetWrists = constantWrists(WINDOW.endMs, TARGET);

  it("splits at a sustained flip and judges each segment FRESH", () => {
    // Other wrist lands exactly on the paddle for 3 consecutive samples
    // (1000–1100ms) — a sustained flip — then leaves again.
    const otherWrists = constantWrists(WINDOW.endMs, OTHER_FAR, (tMs) =>
      tMs >= 1000 && tMs <= 1100 ? PADDLE : null,
    );
    const observations = trackObservations(0, 4000, PADDLE);
    const segments = segmentTrackByWristOwnership(observations, targetWrists, otherWrists, WINDOW);

    expect(segments.length).toBe(3);
    const [head, run, tail] = segments;
    expect(head!.startMs).toBe(0);
    expect(head!.endMs).toBe(950);
    expect(head!.sustainedFlipRun).toBe(false);
    expect(head!.ownedByOtherPlayer).toBe(false);

    expect(run!.startMs).toBe(1000);
    expect(run!.endMs).toBe(1100);
    expect(run!.observations.length).toBe(3);
    expect(run!.sustainedFlipRun).toBe(true);
    expect(run!.ownedByOtherPlayer).toBe(true);
    // FRESH per-segment stats: the run's other-distance is ~0 even though the
    // whole track's mean other-distance is dominated by OTHER_FAR.
    expect(run!.meanOtherWristDistance!).toBeLessThan(0.01);

    expect(tail!.startMs).toBe(1150);
    expect(tail!.endMs).toBe(4000);
    expect(tail!.ownedByOtherPlayer).toBe(false);
    // Decisively target-owned tail: target ~0.028 vs other ~0.53.
    expect(tail!.meanTargetWristDistance!).toBeLessThan(0.05);
    expect(tail!.meanOtherWristDistance!).toBeGreaterThan(0.4);
  });

  it("treats a shorter-than-sustained flip as transient (no split)", () => {
    // Only 2 consecutive samples flip — below sustainedFlipRunLength.
    const otherWrists = constantWrists(WINDOW.endMs, OTHER_FAR, (tMs) =>
      tMs === 1000 || tMs === 1050 ? PADDLE : null,
    );
    const observations = trackObservations(0, 4000, PADDLE);
    const segments = segmentTrackByWristOwnership(observations, targetWrists, otherWrists, WINDOW);
    expect(segments.length).toBe(1);
    expect(segments[0]!.ownedByOtherPlayer).toBe(false);
  });

  it("marks a wholly other-owned track as one rejected segment", () => {
    const otherPaddle = { x: 0.88, y: 0.88 }; // rides the OTHER player's hand
    const otherWrists = constantWrists(WINDOW.endMs, OTHER_FAR);
    const observations = trackObservations(0, 4000, otherPaddle);
    const segments = segmentTrackByWristOwnership(observations, targetWrists, otherWrists, WINDOW);
    expect(segments.length).toBe(1);
    expect(segments[0]!.ownedByOtherPlayer).toBe(true);
  });
});

describe("selectPrimaryPaddleTrack flip-segmentation", () => {
  const targetWrists = constantWrists(WINDOW.endMs, TARGET);

  it("keeps a decisively target-owned tail after an earlier sustained flip", () => {
    // Regression for the afn-sasebo-rally1 catastrophe: truncation-by-
    // deletion cut the winning track at its first flip and deleted the
    // decisively target-owned tail that held every gold label.
    const otherWrists = constantWrists(WINDOW.endMs, OTHER_FAR, (tMs) =>
      tMs >= 1000 && tMs <= 1100 ? PADDLE : null,
    );
    const track = candidateOf(1, trackObservations(0, 4000, PADDLE), {
      windowCoverage: 1,
      meanScore: 0.5,
    });
    const outcome = selectPrimaryPaddleTrack([track], targetWrists, WINDOW, otherWrists);
    expect(outcome.status).toBe("tracked");
    if (outcome.status !== "tracked") return;
    const kept = outcome.lab.observations.map((observation) => observation.timestampMs);
    // The tail (post-flip) SURVIVES…
    expect(Math.max(...kept)).toBe(4000);
    expect(kept.filter((tMs) => tMs > 1100).length).toBe(58); // 1150..4000
    // …only the 3-observation flip run was dropped…
    expect(kept.length).toBe(81 - 3);
    expect(kept.some((tMs) => tMs >= 1000 && tMs <= 1100)).toBe(false);
    // …and the drop is visible as exactly one switch event at the boundary.
    expect(outcome.association.switchEvents.length).toBe(1);
    expect(outcome.association.switchEvents[0]!.atMs).toBe(1000);
    // Coverage stays honest AND high: the sum of surviving segment spans
    // (0–950 + 1150–4000 = 95% — the dropped run's hole is NOT claimed).
    expect(outcome.lab.windowCoverage).toBeCloseTo(0.95, 5);
  });

  it("recomputes score terms from kept observations (stale-coverage regression)", () => {
    // Regression for the afn-sasebo-rally2 defect: a track cut 79→10 obs
    // kept its pre-cut windowCoverage 0.986 and outranked the honest track.
    const otherWrists = constantWrists(WINDOW.endMs, OTHER_FAR);
    // Impostor: brief 10-obs head near the target's hand (0–450ms), then a
    // long tail glued to the OTHER player's hand (500–2450ms).
    const impostor = candidateOf(
      1,
      [...trackObservations(0, 450, PADDLE), ...trackObservations(500, 2450, { x: 0.88, y: 0.88 })],
      { windowCoverage: 0.99, meanScore: 0.5 }, // STALE pre-cut terms
    );
    // Honest track: near the target's hand for 60% of the window.
    const honest = candidateOf(2, trackObservations(1200, 3800, PADDLE), {
      windowCoverage: 0.65,
      meanScore: 0.5,
    });
    const outcome = selectPrimaryPaddleTrack([impostor, honest], targetWrists, WINDOW, otherWrists);
    expect(outcome.status).toBe("tracked");
    if (outcome.status !== "tracked") return;
    // The honest track wins: the impostor's kept head only covers ~11%.
    expect(outcome.lab.trackId).toBe(2);
    const impostorScored = outcome.allTracks.find((candidate) => candidate.trackId === 1)!;
    expect(impostorScored.windowCoverage).toBeLessThan(0.15); // honest, not 0.99
    expect(impostorScored.observations.length).toBe(10); // other-owned tail dropped
  });

  it("still rejects a track that is wholly another player's paddle", () => {
    const otherWrists = constantWrists(WINDOW.endMs, OTHER_FAR);
    const theirs = candidateOf(1, trackObservations(0, 4000, { x: 0.88, y: 0.88 }), {
      windowCoverage: 1,
      meanScore: 0.5,
    });
    const outcome = selectPrimaryPaddleTrack([theirs], targetWrists, WINDOW, otherWrists);
    expect(outcome.status).toBe("untracked");
    if (outcome.status !== "untracked") return;
    expect(outcome.reason).toContain("only_other_players_paddles_found");
    expect(outcome.association!.rejectedOtherPlayerTracks).toBe(1);
    // No switch events: the track never belonged to the target at all.
    expect(outcome.association!.switchEvents.length).toBe(0);
  });

  it("cannot ride neutral scraps past ownership after a proven flip", () => {
    // wm-dink-01 T7 regression shape: a track that is decisively another
    // player's for a long sustained run must NOT survive segmentation on its
    // neutral (equidistant) remainder and outrank honest tracks on span
    // coverage. Head 0–1000ms equidistant from both wrists (neutral), tail
    // 1050–4000ms glued to the other player's hand (sustained flip run).
    const otherWrists = constantWrists(WINDOW.endMs, OTHER_FAR);
    const impostor = candidateOf(
      1,
      [
        ...trackObservations(0, 1000, { x: 0.7, y: 0.7 }), // neutral
        ...trackObservations(1050, 4000, { x: 0.88, y: 0.88 }), // theirs
      ],
      { windowCoverage: 1, meanScore: 0.9 },
    );
    const outcome = selectPrimaryPaddleTrack([impostor], targetWrists, WINDOW, otherWrists);
    // No decisively target-owned segment exists → judged as a whole → the
    // track-level ownership test rejects it as another player's paddle.
    expect(outcome.status).toBe("untracked");
    if (outcome.status !== "untracked") return;
    expect(outcome.reason).toContain("only_other_players_paddles_found");
    expect(outcome.association!.rejectedOtherPlayerTracks).toBe(1);
  });
});

// ── D4-01 STRESS FIXTURES (wave-D S4 selection stress) ─────────────────────
// Flip-truncation family variants, a late-appearing better track, and two
// tracks alternating quality — hand-built with known ownership per range.
describe("selectPrimaryPaddleTrack D4-01 stress fixtures", () => {
  const targetWrists = constantWrists(WINDOW.endMs, TARGET);
  const THEIRS = { x: 0.88, y: 0.88 };

  it("flip family: sustained flip at the HEAD keeps the target-owned tail", () => {
    const otherWrists = constantWrists(WINDOW.endMs, OTHER_FAR, (tMs) =>
      tMs <= 1000 ? PADDLE : null,
    );
    const track = candidateOf(1, trackObservations(0, 4000, PADDLE), {
      windowCoverage: 1,
      meanScore: 0.5,
    });
    const outcome = selectPrimaryPaddleTrack([track], targetWrists, WINDOW, otherWrists);
    expect(outcome.status).toBe("tracked");
    if (outcome.status !== "tracked") return;
    // Head run (0–1000, 21 obs) dropped; tail 1050–4000 (60 obs) survives.
    expect(outcome.lab.observations.length).toBe(60);
    expect(outcome.lab.observations[0]!.timestampMs).toBe(1050);
    expect(outcome.lab.windowCoverage).toBeCloseTo(0.7375, 4);
  });

  it("flip family: sustained flip at the TAIL keeps the target-owned head", () => {
    const otherWrists = constantWrists(WINDOW.endMs, OTHER_FAR, (tMs) =>
      tMs >= 3000 ? PADDLE : null,
    );
    const track = candidateOf(1, trackObservations(0, 4000, PADDLE), {
      windowCoverage: 1,
      meanScore: 0.5,
    });
    const outcome = selectPrimaryPaddleTrack([track], targetWrists, WINDOW, otherWrists);
    expect(outcome.status).toBe("tracked");
    if (outcome.status !== "tracked") return;
    expect(outcome.lab.observations.length).toBe(60);
    expect(outcome.lab.observations.at(-1)!.timestampMs).toBe(2950);
    expect(outcome.lab.windowCoverage).toBeCloseTo(0.7375, 4);
  });

  it("flip family: TWO separated sustained flips drop both runs, keep all target segments", () => {
    const otherWrists = constantWrists(WINDOW.endMs, OTHER_FAR, (tMs) =>
      (tMs >= 1000 && tMs <= 1200) || (tMs >= 2500 && tMs <= 2700) ? PADDLE : null,
    );
    const track = candidateOf(1, trackObservations(0, 4000, PADDLE), {
      windowCoverage: 1,
      meanScore: 0.5,
    });
    const outcome = selectPrimaryPaddleTrack([track], targetWrists, WINDOW, otherWrists);
    expect(outcome.status).toBe("tracked");
    if (outcome.status !== "tracked") return;
    expect(outcome.lab.observations.length).toBe(81 - 10); // two 5-obs runs dropped
    expect(outcome.association.switchEvents.length).toBe(2);
    expect(outcome.lab.windowCoverage).toBeCloseTo(0.85, 4);
    const kept = outcome.lab.observations.map((observation) => observation.timestampMs);
    expect(kept.some((tMs) => tMs >= 1000 && tMs <= 1200)).toBe(false);
    expect(kept.some((tMs) => tMs >= 2500 && tMs <= 2700)).toBe(false);
  });

  it("flip family: run exactly at sustainedFlipRunLength splits; one below does not", () => {
    for (const [runLength, expectSplit] of [
      [2, false],
      [3, true],
    ] as const) {
      const otherWrists = constantWrists(WINDOW.endMs, OTHER_FAR, (tMs) =>
        tMs >= 1000 && tMs < 1000 + runLength * STEP_MS ? PADDLE : null,
      );
      const track = candidateOf(1, trackObservations(0, 4000, PADDLE), {
        windowCoverage: 1,
        meanScore: 0.5,
      });
      const outcome = selectPrimaryPaddleTrack([track], targetWrists, WINDOW, otherWrists);
      expect(outcome.status).toBe("tracked");
      if (outcome.status !== "tracked") return;
      expect(outcome.association.switchEvents.length).toBe(expectSplit ? 1 : 0);
      expect(outcome.lab.observations.length).toBe(expectSplit ? 81 - 3 : 81);
    }
  });

  it("late-appearing better track outranks a mediocre early track", () => {
    const otherWrists = constantWrists(WINDOW.endMs, OTHER_FAR);
    // Early: farther from the wrist, low score, covers the first 60%.
    const early = candidateOf(1, trackObservations(0, 2400, { x: 0.56, y: 0.56 }, 0.3), {
      windowCoverage: 0.6,
      meanScore: 0.3,
    });
    // Late: appears only in the last 50%, glued to the paddle, high score.
    const late = candidateOf(2, trackObservations(2000, 4000, PADDLE, 0.8), {
      windowCoverage: 0.5,
      meanScore: 0.8,
    });
    const outcome = selectPrimaryPaddleTrack([early, late], targetWrists, WINDOW, otherWrists);
    expect(outcome.status).toBe("tracked");
    if (outcome.status !== "tracked") return;
    expect(outcome.lab.trackId).toBe(2);
  });

  it("two tracks alternating quality: winner keeps ONLY its target-owned segments", () => {
    const otherWrists = constantWrists(WINDOW.endMs, OTHER_FAR);
    // A rides the target's paddle in quarters 1+3, the other player's in 2+4;
    // B is the mirror image. Neither track is wholly honest.
    const trackA = candidateOf(
      1,
      [
        ...trackObservations(0, 1000, PADDLE),
        ...trackObservations(1050, 2000, THEIRS),
        ...trackObservations(2050, 3000, PADDLE),
        ...trackObservations(3050, 4000, THEIRS),
      ],
      { windowCoverage: 1, meanScore: 0.6 },
    );
    const trackB = candidateOf(
      2,
      [
        ...trackObservations(0, 1000, THEIRS),
        ...trackObservations(1050, 2000, PADDLE),
        ...trackObservations(2050, 3000, THEIRS),
        ...trackObservations(3050, 4000, PADDLE),
      ],
      { windowCoverage: 1, meanScore: 0.6 },
    );
    const outcome = selectPrimaryPaddleTrack([trackA, trackB], targetWrists, WINDOW, otherWrists);
    expect(outcome.status).toBe("tracked");
    if (outcome.status !== "tracked") return;
    // A winner exists, keeps only its two target-owned quarters (41 obs),
    // reports honest ~49% coverage, and carries ZERO other-player frames.
    expect(outcome.lab.observations.length).toBe(41);
    expect(outcome.lab.windowCoverage).toBeCloseTo(0.4875, 4);
    const nearTheirs = outcome.lab.observations.filter(
      (observation) =>
        Math.hypot(observation.center.x - THEIRS.x, observation.center.y - THEIRS.y) < 0.03,
    );
    expect(nearTheirs.length).toBe(0);
  });
});

describe("paddleSpeedSeries", () => {
  it("computes speeds between consecutive observations and skips gaps", () => {
    const { file, sequence, window } = movingDetections({ dropEvery: 3 });
    const outcome = selectPrimaryPaddleTrack(
      buildPaddleTracks(file, window),
      wristSeries(sequence),
      window,
    );
    expect(outcome.status).toBe("tracked");
    if (outcome.status !== "tracked") return;
    const series = paddleSpeedSeries(outcome.lab.observations);
    expect(series.length).toBeGreaterThan(10);
    // The synthetic swing accelerates mid-window: speed peak must be inside it.
    const peak = series.reduce((a, b) => (b.value > a.value ? b : a));
    expect(peak.timestampMs).toBeGreaterThan(window.startMs);
    expect(peak.timestampMs).toBeLessThan(window.endMs);
  });
});
