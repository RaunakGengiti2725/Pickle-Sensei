import { describe, expect, it } from "vitest";
import { generateAdversarialContactFixtures, generateSwingSequence } from "@pickle/evaluation";
import type { BallObservation } from "@pickle/swing-domain";
import { assessPaddleTrackIdentity, estimateContact } from "../src/index.js";

/**
 * g01 paddle-track identity: TEMPORAL ownership evidence for a paddle track.
 * The spatial reach tether cannot reject a foreign paddle hovering within
 * reach of an idle target wrist (the pinned F3 residual); whole-event motion
 * synchrony can — a held paddle moves with its owner's hand.
 */

const TORSO = 0.2;

function track(points: Array<[number, number, number]>) {
  return points.map(([timestampMs, x, y]) => ({ timestampMs, x, y }));
}

/** A hand swinging (gaussian arc peaking at `peakMs`) sampled every 30ms. */
function arcTrack(options: {
  fromMs: number;
  toMs: number;
  peakMs: number;
  base: { x: number; y: number };
  amplitude: number;
}) {
  const points: Array<{ timestampMs: number; x: number; y: number }> = [];
  for (let t = options.fromMs; t <= options.toMs; t += 30) {
    const arc = Math.exp(-((t - options.peakMs) ** 2) / (2 * 100 * 100));
    points.push({
      timestampMs: t,
      x: options.base.x + options.amplitude * arc,
      y: options.base.y - 0.3 * options.amplitude * arc,
    });
  }
  return points;
}

describe("assessPaddleTrackIdentity", () => {
  it("calls a paddle riding the target's hand target_consistent (synchrony)", () => {
    const wrist = arcTrack({
      fromMs: 0,
      toMs: 2000,
      peakMs: 1000,
      base: { x: 0.5, y: 0.6 },
      amplitude: 0.2,
    });
    const paddle = wrist.map((point) => ({ ...point, x: point.x + 0.05, y: point.y - 0.03 }));
    const assessment = assessPaddleTrackIdentity({
      paddleCenters: paddle,
      targetWristTracks: [wrist],
      aspect: 1,
      torsoSpan: TORSO,
    });
    expect(assessment.verdict).toBe("target_consistent");
    expect(assessment.evidence.targetSynchrony).toBeGreaterThan(0.9);
  });

  it("calls a paddle that moves while every target hand is idle — and is idle while the target swings — foreign", () => {
    const idleWrist = track(
      Array.from({ length: 70 }, (_, i) => [i * 30, 0.35, 0.55] as [number, number, number]),
    );
    const swingingWrist = arcTrack({
      fromMs: 0,
      toMs: 2070,
      peakMs: 700,
      base: { x: 0.6, y: 0.6 },
      amplitude: 0.25,
    });
    // Foreign paddle: hovers near the idle wrist, arcs at 1600ms (someone else's hit).
    const paddle = arcTrack({
      fromMs: 0,
      toMs: 2070,
      peakMs: 1600,
      base: { x: 0.3, y: 0.58 },
      amplitude: -0.12,
    });
    const assessment = assessPaddleTrackIdentity({
      paddleCenters: paddle,
      targetWristTracks: [swingingWrist, idleWrist],
      aspect: 1,
      torsoSpan: TORSO,
    });
    expect(assessment.verdict).toBe("foreign");
    expect(assessment.evidence.peakSeparationMs).toBeGreaterThanOrEqual(250);
  });

  it("never returns foreign when the paddle track is too sparse to measure", () => {
    const wrist = arcTrack({
      fromMs: 0,
      toMs: 2000,
      peakMs: 700,
      base: { x: 0.6, y: 0.6 },
      amplitude: 0.25,
    });
    const assessment = assessPaddleTrackIdentity({
      paddleCenters: track([
        [0, 0.3, 0.58],
        [500, 0.3, 0.58],
        [1000, 0.31, 0.58],
      ]),
      targetWristTracks: [wrist],
      aspect: 1,
      torsoSpan: TORSO,
    });
    expect(assessment.verdict).toBe("undetermined");
  });

  it("never returns foreign without a measured target wrist trajectory", () => {
    const paddle = arcTrack({
      fromMs: 0,
      toMs: 2000,
      peakMs: 1600,
      base: { x: 0.3, y: 0.58 },
      amplitude: -0.12,
    });
    const assessment = assessPaddleTrackIdentity({
      paddleCenters: paddle,
      targetWristTracks: [],
      aspect: 1,
      torsoSpan: TORSO,
    });
    expect(assessment.verdict).toBe("undetermined");
  });

  it("discloses fragment provenance (occlusion gaps) and measures within fragments", () => {
    const wrist = arcTrack({
      fromMs: 0,
      toMs: 2000,
      peakMs: 1000,
      base: { x: 0.5, y: 0.6 },
      amplitude: 0.2,
    });
    const paddle = wrist
      .filter((point) => point.timestampMs < 800 || point.timestampMs > 1300)
      .map((point) => ({ ...point, x: point.x + 0.05, y: point.y - 0.03 }));
    const assessment = assessPaddleTrackIdentity({
      paddleCenters: paddle,
      targetWristTracks: [wrist],
      aspect: 1,
      torsoSpan: TORSO,
    });
    expect(assessment.evidence.paddleTrackGaps.count).toBe(1);
    expect(assessment.evidence.paddleTrackGaps.maxGapMs).toBeGreaterThan(400);
    expect(assessment.verdict).not.toBe("foreign");
  });

  it("records contradiction evidence when the paddle synchronizes with a NON-target hand", () => {
    const idleTarget = track(
      Array.from({ length: 70 }, (_, i) => [i * 30, 0.7, 0.55] as [number, number, number]),
    );
    const targetSwing = arcTrack({
      fromMs: 0,
      toMs: 2070,
      peakMs: 500,
      base: { x: 0.8, y: 0.6 },
      amplitude: 0.2,
    });
    const opponentWrist = arcTrack({
      fromMs: 0,
      toMs: 2070,
      peakMs: 1500,
      base: { x: 0.25, y: 0.5 },
      amplitude: 0.18,
    });
    const paddle = opponentWrist.map((point) => ({
      ...point,
      x: point.x + 0.04,
      y: point.y + 0.03,
    }));
    const assessment = assessPaddleTrackIdentity({
      paddleCenters: paddle,
      targetWristTracks: [targetSwing, idleTarget],
      otherWristTracks: [opponentWrist],
      aspect: 1,
      torsoSpan: TORSO,
    });
    expect(assessment.verdict).toBe("foreign");
    expect(assessment.evidence.otherSynchrony).toBeGreaterThan(0.9);
    expect(assessment.evidence.notes.some((note) => note.includes("NON-target"))).toBe(true);
  });

  it("degenerate torso span yields undetermined, never foreign", () => {
    const paddle = arcTrack({
      fromMs: 0,
      toMs: 2000,
      peakMs: 1600,
      base: { x: 0.3, y: 0.58 },
      amplitude: -0.12,
    });
    const assessment = assessPaddleTrackIdentity({
      paddleCenters: paddle,
      targetWristTracks: [paddle],
      aspect: 1,
      torsoSpan: 0,
    });
    expect(assessment.verdict).toBe("undetermined");
  });
});

describe("estimateContact paddleIdentityGate flag", () => {
  /** The pinned F3-residual scenario (contactRedTeam 'F3 residual'), rebuilt
   * here verbatim: a foreign paddle WITHIN reach of the idle off-hand wrist,
   * arcing at the opponent's hit 600ms after truth. */
  function f3ResidualInputs() {
    const { sequence, window } = generateSwingSequence();
    const idleWrist = sequence.frames
      .map((frame) => frame.landmarks.find((mark) => mark.name === "left_wrist"))
      .find((mark): mark is NonNullable<typeof mark> => mark !== undefined)!;
    const oppHitMs = window.peakMs + 600;
    const paddleCenters = Array.from({ length: 70 }, (_, i) => {
      const t = window.startMs + i * 30;
      const arc = Math.exp(-((t - oppHitMs) ** 2) / (2 * 100 * 100));
      return {
        timestampMs: t,
        x: idleWrist.x - 0.12 - 0.1 * arc,
        y: idleWrist.y + 0.05 - 0.03 * arc,
      };
    });
    const paddleSpeeds: Array<{ timestampMs: number; value: number }> = [];
    for (let i = 1; i < paddleCenters.length; i += 1) {
      const a = paddleCenters[i - 1]!;
      const b = paddleCenters[i]!;
      paddleSpeeds.push({
        timestampMs: (a.timestampMs + b.timestampMs) / 2,
        value: (Math.hypot(b.x - a.x, b.y - a.y) / (b.timestampMs - a.timestampMs)) * 1000,
      });
    }
    const hitAt = { x: idleWrist.x - 0.22, y: idleWrist.y + 0.02 };
    const ball: BallObservation[] = [];
    let frameIndex = 0;
    for (let t = oppHitMs - 400; t <= oppHitMs + 300; t += 30) {
      const before = t <= oppHitMs;
      const raw = before ? (t - (oppHitMs - 400)) / 400 : (t - oppHitMs) / 300;
      ball.push({
        frameIndex: frameIndex++,
        timestampMs: t,
        x: before ? hitAt.x + 0.4 - 0.4 * raw : hitAt.x + 0.35 * raw,
        y: before ? hitAt.y - 0.35 + 0.35 * raw : hitAt.y - 0.3 * raw,
        confidence: 0.8,
      });
    }
    return { sequence, window, oppHitMs, paddleCenters, paddleSpeeds, ball };
  }

  it("with the gate ON, the F3-residual foreign paddle no longer yields a confident wrong contact", () => {
    const inputs = f3ResidualInputs();
    const estimate = estimateContact({
      sequence: inputs.sequence,
      window: {
        startMs: inputs.window.startMs,
        endMs: inputs.window.endMs + 500,
        peakMotionMs: inputs.window.peakMs,
      },
      ballObservations: inputs.ball,
      paddleSpeeds: inputs.paddleSpeeds,
      paddleCenters: inputs.paddleCenters,
      paddleIdentityGate: true,
    });
    // Honest outcomes only: abstain, or estimate near truth — never a
    // confident, modality-confirmed contact at the opponent's hit.
    if (estimate.status === "estimated") {
      const wrongAndConfident =
        Math.abs(estimate.estimatedContactMs - inputs.window.peakMs) > 150 &&
        estimate.confidence >= 0.6;
      expect(wrongAndConfident).toBe(false);
      expect(estimate.paddleConfirmed).toBe(false);
    }
  });

  it("with the gate OFF, the pinned F3-residual behavior is untouched", () => {
    const inputs = f3ResidualInputs();
    const estimate = estimateContact({
      sequence: inputs.sequence,
      window: {
        startMs: inputs.window.startMs,
        endMs: inputs.window.endMs + 500,
        peakMotionMs: inputs.window.peakMs,
      },
      ballObservations: inputs.ball,
      paddleSpeeds: inputs.paddleSpeeds,
      paddleCenters: inputs.paddleCenters,
    });
    expect(estimate.status).toBe("estimated");
    if (estimate.status !== "estimated") return;
    expect(Math.abs(estimate.estimatedContactMs - inputs.oppHitMs)).toBeLessThanOrEqual(100);
    expect(estimate.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("keeps trusting a genuine paddle track with the gate ON", () => {
    const { sequence, window } = generateSwingSequence();
    const paddleCenters = sequence.frames
      .map((frame) => {
        const wrist = frame.landmarks.find((mark) => mark.name === "right_wrist");
        return wrist
          ? { timestampMs: frame.timestampMs, x: wrist.x + 0.05, y: wrist.y - 0.03 }
          : null;
      })
      .filter((center): center is NonNullable<typeof center> => center !== null);
    const paddleSpeeds: Array<{ timestampMs: number; value: number }> = [];
    for (let i = 1; i < paddleCenters.length; i += 1) {
      const a = paddleCenters[i - 1]!;
      const b = paddleCenters[i]!;
      paddleSpeeds.push({
        timestampMs: (a.timestampMs + b.timestampMs) / 2,
        value: (Math.hypot(b.x - a.x, b.y - a.y) / (b.timestampMs - a.timestampMs)) * 1000,
      });
    }
    const estimate = estimateContact({
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
      ballObservations: null,
      paddleSpeeds,
      paddleCenters,
      paddleIdentityGate: true,
    });
    expect(estimate.status).toBe("estimated");
    if (estimate.status !== "estimated") return;
    expect(Math.abs(estimate.estimatedContactMs - window.peakMs)).toBeLessThanOrEqual(60);
    expect(estimate.paddleConfirmed).toBe(true);
    expect(estimate.limitingFactors).not.toContain("paddle_track_identity_foreign");
  });

  it("changes nothing on any adversarial contact fixture (broad no-regression sweep)", () => {
    for (const fixture of generateAdversarialContactFixtures()) {
      const run = (paddleIdentityGate: boolean) =>
        estimateContact({
          sequence: fixture.sequence,
          window: fixture.window,
          ballObservations: fixture.ballObservations,
          paddleSpeeds: fixture.paddleSpeeds,
          paddleCenters: fixture.paddleCenters,
          targetWrists: fixture.targetWrists,
          strokeFamily: fixture.strokeFamily,
          paddleIdentityGate,
        });
      const off = run(false);
      const on = run(true);
      expect(on.status, fixture.id).toBe(off.status);
      if (off.status === "estimated" && on.status === "estimated") {
        expect(on.estimatedContactMs, fixture.id).toBe(off.estimatedContactMs);
        expect(on.confidence, fixture.id).toBeCloseTo(off.confidence, 10);
        expect(on.ballConfirmed, fixture.id).toBe(off.ballConfirmed);
        expect(on.paddleConfirmed, fixture.id).toBe(off.paddleConfirmed);
      }
    }
  });
});
