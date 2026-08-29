import { describe, expect, it } from "vitest";
import { generateSwingSequence } from "@pickle/evaluation";
import {
  ballSpeedSeries,
  buildBallTracks,
  selectPrimaryBallTrack,
  type BallCandidateFile,
} from "../src/index.js";
import { BALL_OCCLUSION } from "../src/ballTracker.js";

/**
 * Synthetic CANDIDATE streams testing the association/physics/context math
 * with known inputs. Real-footage behavior is covered by the ball benchmark.
 */

function candidateFile(
  frames: BallCandidateFile["frames"],
  chronicCells: number[] = new Array(24 * 24).fill(0),
): BallCandidateFile {
  return {
    schemaVersion: 1,
    generator: { version: "test", method: "test", scale: 0.5, note: "" },
    video: { path: "test.mp4", width: 1000, height: 1000, fps: 25, durationMs: 4000 },
    window: { startMs: 0, endMs: 4000 },
    backgroundActivity: { grid: 24, cells: chronicCells },
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

/** Fast diagonal flight far from the synthetic player's body. */
function flightFrames(options: { drop?: number[]; from?: number } = {}) {
  const frames: BallCandidateFile["frames"] = [];
  const start = options.from ?? 0;
  for (let index = 0; index < 50; index += 1) {
    const tMs = start + index * 40;
    const candidates = [];
    if (index >= 10 && index < 30 && !(options.drop ?? []).includes(index)) {
      const k = index - 10;
      candidates.push(ball(0.95 - k * 0.03, 0.15 + k * 0.012));
    }
    frames.push({ tMs, candidates, rawComponentCount: candidates.length });
  }
  return frames;
}

const WINDOW = { startMs: 300, endMs: 1400 };

describe("buildBallTracks", () => {
  const { sequence } = generateSwingSequence();

  it("chains a fast flight into one track without interpolating dropped frames", () => {
    const { gated, ablation } = buildBallTracks(
      candidateFile(flightFrames({ drop: [17, 23] })),
      sequence,
      WINDOW,
      null,
    );
    expect(gated.length).toBe(1);
    expect(gated[0]!.observations.length).toBe(18); // 20 minus 2 dropped, no invention
    expect(ablation.stageB_tracks).toBe(1);
    expect(gated[0]!.medianSpeed).toBeGreaterThan(0.5);
  });

  it("rejects slow background drift via the median-speed physics gate", () => {
    const frames: BallCandidateFile["frames"] = [];
    for (let index = 0; index < 50; index += 1) {
      frames.push({
        tMs: index * 40,
        candidates: [ball(0.9 + index * 0.0006, 0.2, 60)], // ~0.015 u/s drift
        rawComponentCount: 1,
      });
    }
    const { gated, ablation } = buildBallTracks(candidateFile(frames), sequence, WINDOW, null);
    expect(ablation.stageB_tracks).toBe(1); // associated…
    expect(gated.length).toBe(0); // …but not a ball
  });

  it("suppresses tracks living in chronically active cells (crowd/flags)", () => {
    const chronic = new Array(24 * 24).fill(0);
    // Mark the flight corridor cells as chronic background motion.
    for (let cy = 0; cy < 8; cy += 1) {
      for (let cx = 0; cx < 24; cx += 1) chronic[cy * 24 + cx] = 0.9;
    }
    const { gated } = buildBallTracks(
      candidateFile(flightFrames(), chronic),
      sequence,
      WINDOW,
      null,
    );
    expect(gated.length).toBe(0);
  });
});

describe("selectPrimaryBallTrack", () => {
  const { sequence } = generateSwingSequence();

  it("tracks a genuine flight and reports honest ablation numbers", () => {
    const { gated, ablation } = buildBallTracks(
      candidateFile(flightFrames()),
      sequence,
      WINDOW,
      null,
    );
    const outcome = selectPrimaryBallTrack(gated, ablation, WINDOW);
    expect(outcome.status).toBe("tracked");
    if (outcome.status !== "tracked") return;
    expect(outcome.track.producedBy.providerId).toBe("ball.motion-diff-tracker");
    expect(outcome.track.producedBy.runtime).toBe("deterministic");
    expect(outcome.track.observations.length).toBe(20);
    expect(outcome.ablation.stageA_rawCandidatesPerSec).toBeGreaterThan(0);
  });

  it("refuses a paddle-unaligned track when a paddle track exists", () => {
    const { gated, ablation } = buildBallTracks(
      candidateFile(flightFrames()),
      sequence,
      WINDOW,
      // Paddle exists but only AFTER the flight — no time alignment possible.
      Array.from({ length: 10 }, (_, index) => ({
        timestampMs: 2500 + index * 40,
        box: { x: 0.5, y: 0.5, width: 0.06, height: 0.08 },
        center: { x: 0.53, y: 0.54 },
        detectorScore: 0.7,
        trackId: 1,
        confidence: 0.7,
        nearWrist: true,
      })),
    );
    const withPaddle = selectPrimaryBallTrack(gated, ablation, WINDOW, {
      paddleTrackExists: true,
    });
    expect(withPaddle.status).toBe("untracked");
    const withoutPaddle = selectPrimaryBallTrack(gated, ablation, WINDOW, {
      paddleTrackExists: false,
    });
    expect(withoutPaddle.status).toBe("tracked");
  });

  it("rejects body-dwelling motion (shirt/limb blobs) as a primary ball", () => {
    // Candidates riding ON the synthetic player's right wrist every frame.
    const frames: BallCandidateFile["frames"] = [];
    const legacy = sequence.frames;
    for (const frame of legacy) {
      const wrist = frame.landmarks.find((mark) => mark.name === "right_wrist")!;
      frames.push({
        tMs: frame.timestampMs,
        candidates: [ball(wrist.x, wrist.y, 80)],
        rawComponentCount: 1,
      });
    }
    const { gated, ablation } = buildBallTracks(candidateFile(frames), sequence, WINDOW, null);
    const outcome = selectPrimaryBallTrack(gated, ablation, WINDOW);
    // Either the physics gates already killed it, or body-dwell must.
    expect(outcome.status).toBe("untracked");
  });
});

describe("ballSpeedSeries", () => {
  it("skips gaps instead of inventing speeds across them", () => {
    const { sequence } = generateSwingSequence();
    const { gated } = buildBallTracks(
      candidateFile(flightFrames({ drop: [15, 16] })), // 120ms hole (≤ maxGapMs)
      sequence,
      WINDOW,
      null,
    );
    expect(gated.length).toBe(1);
    const series = ballSpeedSeries(gated[0]!.observations);
    const maxDt = Math.max(
      ...gated[0]!.observations.slice(1).map(
        (observation, index) => observation.timestampMs - gated[0]!.observations[index]!.timestampMs,
      ),
    );
    expect(maxDt).toBe(120); // the hole exists in the track
    // ballSpeedSeries only emits speeds for dt ≤ 150ms BUT the 120ms hole
    // step must not produce a spike vs the 40ms steps around it.
    expect(series.every((sample) => sample.value < 3.5)).toBe(true);
  });
});

// ── Body-occlusion state machine ─────────────────────────────────────────
//
// Scenario geometry against the synthetic player (body joints span
// x[0.405,0.595] y[0.34,0.92]; padded region x[0.315,0.685] y[0.25,1.0]):
// an incoming ball flies horizontally at y=0.50 from the far left straight
// INTO the body region at 1.0 u/s and vanishes at its edge (x=0.30) —
// exactly the measured afn-sasebo-rally2 failure shape.

/** Incoming flight: 8 observations, 40ms apart, ending at the body edge. */
function incomingFrames(extra: Array<{ tMs: number; x: number; y: number }> = []) {
  const frames: BallCandidateFile["frames"] = [];
  for (let index = 0; index < 50; index += 1) {
    const tMs = index * 40;
    const candidates = [];
    if (index >= 10 && index < 18) {
      candidates.push(ball(0.02 + (index - 10) * 0.04, 0.5)); // 1.0 u/s rightward
    }
    for (const point of extra) {
      if (point.tMs === tMs) candidates.push(ball(point.x, point.y));
    }
    frames.push({ tMs, candidates, rawComponentCount: candidates.length });
  }
  return frames;
}

/** Time-aligned paddle track FAR from the flight (strict eligibility must
 * fail so the body-occlusion fallback is what gets exercised). */
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

/** Deflected emergence on the far side of the body: starts 320ms after the
 * ball vanished, just outside the padded region, moving right-down at a
 * compatible-but-not-corridor-perfect angle (miss > strict radius, within
 * the relaxed body corridor). */
function emergence(t0: number, y0: number, dy: number) {
  const points = [];
  for (let index = 0; index < 4; index += 1) {
    points.push({ tMs: t0 + index * 40, x: 0.7 + index * 0.02, y: y0 + index * dy });
  }
  return points;
}

describe("body-occlusion state machine", () => {
  const { sequence } = generateSwingSequence();

  it("promotes a track that dies entering the target body region (occlusion entry) and stays honestly LOST without candidates", () => {
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
    expect(outcome.selection).toBe("body_occlusion");
    // Only measured candidates — nothing invented during the occlusion.
    expect(outcome.track.observations.length).toBe(8);
    const stateNames = outcome.timeline.states.map((span) => span.state);
    expect(stateNames).toEqual(["TRACKED", "ENTERING_OCCLUSION", "OCCLUDED", "LOST"]);
    const occluded = outcome.timeline.states.find((span) => span.state === "OCCLUDED")!;
    expect(occluded.fromMs).toBe(680); // last observation
    expect(occluded.toMs).toBe(680 + BALL_OCCLUSION.maxOcclusionMs); // hard bound
    expect(outcome.timeline.reacquisition).toMatchObject({
      attempted: true,
      result: "FAILED_NO_CANDIDATE",
      bodyOcclusion: true,
    });
    // No fabricated bridge on LOST.
    expect(outcome.timeline.bridge).toEqual([]);
  });

  it("keeps the strict paddle-aligned selection when one exists (fallback never fires)", () => {
    const alignedPaddle = Array.from({ length: 9 }, (_, index) => ({
      timestampMs: 400 + index * 40,
      box: { x: 0.02 + index * 0.04, y: 0.55, width: 0.05, height: 0.05 },
      center: { x: 0.045 + index * 0.04, y: 0.575 },
      detectorScore: 0.7,
      trackId: 9,
      confidence: 0.7,
      nearWrist: true,
    }));
    const { gated, fragments, ablation } = buildBallTracks(
      candidateFile(incomingFrames()),
      sequence,
      WINDOW,
      alignedPaddle,
    );
    const outcome = selectPrimaryBallTrack(gated, ablation, WINDOW, {
      paddleTrackExists: true,
      fragments,
    });
    expect(outcome.status).toBe("tracked");
    if (outcome.status !== "tracked") return;
    expect(outcome.selection).toBe("paddle_aligned");
  });

  it("reacquires a compatible post-occlusion segment via the body-emergence path", () => {
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
    expect(outcome.timeline.reacquisition).toMatchObject({
      attempted: true,
      result: "SUCCESS",
      bodyOcclusion: true,
    });
    if (!outcome.timeline.reacquisition.attempted) return;
    expect(outcome.timeline.reacquisition.detail).toContain("body-emergence");
    const stateNames = outcome.timeline.states.map((span) => span.state);
    expect(stateNames).toEqual(["TRACKED", "ENTERING_OCCLUSION", "OCCLUDED", "REACQUIRED"]);
    // Incoming 8 + reacquired 4, with the occlusion gap kept as a gap.
    expect(outcome.track.observations.length).toBe(12);
    const timestamps = outcome.track.observations.map((observation) => observation.timestampMs);
    expect(timestamps.filter((t) => t > 680 && t < 1000)).toEqual([]);
  });

  it("keeps predictions distinct from observations (bridge flagged, never in the canonical track)", () => {
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
    const bridge = outcome.timeline.bridge;
    expect(bridge.length).toBeGreaterThan(0);
    for (const point of bridge) {
      expect(point.predicted).toBe(true); // flagged, structurally
      expect(point.t).toBeGreaterThan(680);
      expect(point.t).toBeLessThan(1000);
    }
    const observed = new Set(outcome.track.observations.map((observation) => observation.timestampMs));
    expect(bridge.some((point) => observed.has(Math.round(point.t)))).toBe(false);
    // The lab observations (bench input) carry none of the bridge points.
    expect(outcome.lab.observations.length).toBe(outcome.track.observations.length);
  });

  it("expires the bounded occlusion prediction: a compatible segment beyond the hard max is NOT grabbed", () => {
    // Corridor-perfect continuation, but starting 560ms after the death —
    // beyond maxOcclusionMs. Time alone must reject it.
    const late = [];
    for (let index = 0; index < 4; index += 1) {
      late.push({ tMs: 1240 + index * 40, x: 0.86 + index * 0.04, y: 0.5 });
    }
    const { gated, fragments, ablation } = buildBallTracks(
      candidateFile(incomingFrames(late)),
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
    expect(outcome.track.observations.length).toBe(8); // nothing appended
    expect(outcome.timeline.reacquisition).toMatchObject({
      attempted: true,
      result: "FAILED_NO_CANDIDATE",
    });
    const occluded = outcome.timeline.states.find((span) => span.state === "OCCLUDED")!;
    expect(occluded.toMs - occluded.fromMs).toBe(BALL_OCCLUSION.maxOcclusionMs);
  });

  it("rejects a velocity-compatible decoy far from the body region (false reacquisition is worse than LOST)", () => {
    // Same speed/direction as the vanished ball, but on the opponent side —
    // a different white blob. It must NOT be grabbed.
    const decoy = [];
    for (let index = 0; index < 4; index += 1) {
      decoy.push({ tMs: 1000 + index * 40, x: 0.1 + index * 0.02, y: 0.15 + index * 0.014 });
    }
    const { gated, fragments, ablation } = buildBallTracks(
      candidateFile(incomingFrames(decoy)),
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
    expect(outcome.track.observations.length).toBe(8);
    expect(outcome.timeline.reacquisition).toMatchObject({
      attempted: true,
      result: "FAILED_NO_CANDIDATE",
    });
    expect(
      outcome.timeline.states.some((span) => span.state === "REACQUIRED"),
    ).toBe(false);
  });

  it("stays LOST when two comparable emergences exist (ambiguity beats guessing)", () => {
    const { gated, fragments, ablation } = buildBallTracks(
      candidateFile(
        incomingFrames([
          ...emergence(1000, 0.78, 0.014), // down-right emergence
          ...emergence(1000, 0.22, -0.014), // mirrored up-right emergence
        ]),
      ),
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
    expect(outcome.track.observations.length).toBe(8);
    expect(outcome.timeline.reacquisition).toMatchObject({
      attempted: true,
      result: "FAILED_AMBIGUOUS",
    });
  });

  it("refuses a body-occlusion primary when two comparable tracks end into the body", () => {
    // Two parallel flights both dying at the body edge: the fallback claim
    // is not defensible, so the stage stays untracked.
    const frames: BallCandidateFile["frames"] = [];
    for (let index = 0; index < 50; index += 1) {
      const tMs = index * 40;
      const candidates = [];
      if (index >= 10 && index < 18) {
        candidates.push(ball(0.02 + (index - 10) * 0.04, 0.5));
        candidates.push(ball(0.02 + (index - 10) * 0.04, 0.65));
      }
      frames.push({ tMs, candidates, rawComponentCount: candidates.length });
    }
    const { gated, fragments, ablation } = buildBallTracks(
      candidateFile(frames),
      sequence,
      WINDOW,
      farPaddle(),
    );
    const outcome = selectPrimaryBallTrack(gated, ablation, WINDOW, {
      paddleTrackExists: true,
      fragments,
    });
    expect(outcome.status).toBe("untracked");
    if (outcome.status !== "untracked") return;
    expect(outcome.reason).toContain("body_occlusion_primary_ambiguous");
  });

  it("never claims occlusion for a track that dies at the window edge", () => {
    // Same flight shifted so its death lands within windowEndMarginMs of the
    // window end: indistinguishable from the clip ending → stays untracked.
    const frames: BallCandidateFile["frames"] = [];
    for (let index = 0; index < 50; index += 1) {
      const tMs = index * 40;
      const candidates = [];
      if (index >= 25 && index < 33) {
        candidates.push(ball(0.02 + (index - 25) * 0.04, 0.5)); // dies at 1320
      }
      frames.push({ tMs, candidates, rawComponentCount: candidates.length });
    }
    const { gated, fragments, ablation } = buildBallTracks(
      candidateFile(frames),
      sequence,
      WINDOW, // ends 1400; death at 1280+40=1320 → inside the 150ms margin
      farPaddle(),
    );
    const outcome = selectPrimaryBallTrack(gated, ablation, WINDOW, {
      paddleTrackExists: true,
      fragments,
    });
    expect(outcome.status).toBe("untracked");
  });
});
