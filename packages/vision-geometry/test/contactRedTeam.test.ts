import { describe, expect, it } from "vitest";
import { generateAdversarialContactFixtures, generateSwingSequence } from "@pickle/evaluation";
import type { BallObservation } from "@pickle/swing-domain";
import { estimateContact } from "../src/index.js";

/**
 * e09 red-team regressions: adversarial synthetic sequences driven through the
 * REAL estimateContact code path, measured against the constructed synthetic
 * contact truth. A confident-but-wrong contact (large error at high
 * confidence, or a wrong moment "confirmed" by a modality) is the failure
 * mode under attack; abstention is always an acceptable outcome.
 */

const CONFIDENT_WRONG_ERROR_MS = 150;
const CONFIDENT_WRONG_CONFIDENCE = 0.6;

function run(fixture: ReturnType<typeof generateAdversarialContactFixtures>[number]) {
  return estimateContact({
    sequence: fixture.sequence,
    window: fixture.window,
    ballObservations: fixture.ballObservations,
    paddleSpeeds: fixture.paddleSpeeds,
    paddleCenters: fixture.paddleCenters,
    targetWrists: fixture.targetWrists,
    strokeFamily: fixture.strokeFamily,
  });
}

describe("contact red-team: adversarial fixture sweep", () => {
  it("never produces a confident-but-wrong contact on any adversarial fixture", () => {
    for (const fixture of generateAdversarialContactFixtures()) {
      const estimate = run(fixture);
      if (estimate.status !== "estimated") continue; // abstention is honest
      const errorMs = Math.abs(estimate.estimatedContactMs - fixture.trueContactMs);
      expect(
        errorMs > CONFIDENT_WRONG_ERROR_MS && estimate.confidence >= CONFIDENT_WRONG_CONFIDENCE,
        `${fixture.id}: confident-but-wrong (err ${errorMs}ms @ confidence ${estimate.confidence.toFixed(2)})`,
      ).toBe(false);
      if (estimate.ballConfirmed || estimate.paddleConfirmed) {
        expect(
          errorMs,
          `${fixture.id}: modality-confirmed estimate is ${errorMs}ms from truth`,
        ).toBeLessThanOrEqual(CONFIDENT_WRONG_ERROR_MS);
      }
      if (fixture.expectation === "estimate_near_truth") {
        expect(errorMs, `${fixture.id}: expected near-truth estimate`).toBeLessThanOrEqual(120);
      }
    }
  });
});

describe("contact red-team: occlusion gap-edge censoring", () => {
  it("does not ball-confirm a late contact off the first post-occlusion sample", () => {
    // Pre-fix (contact-evidence-4.1) this fixture estimated +115ms at
    // confidence 0.75 with ballConfirmed: the turn/proximity measured at the
    // re-entry sample after the occlusion gap anchored the contact there.
    const fixture = generateAdversarialContactFixtures().find(
      (candidate) => candidate.id === "occluded-ball-at-contact",
    )!;
    const estimate = run(fixture);
    expect(estimate.status).toBe("estimated");
    if (estimate.status !== "estimated") return;
    expect(Math.abs(estimate.estimatedContactMs - fixture.trueContactMs)).toBeLessThanOrEqual(60);
    expect(estimate.ballConfirmed).toBe(false);
  });

  it("does not let a ball re-entering after an occlusion gap drag the contact late", () => {
    // Ball tracked up to contact−250ms, occluded through contact, re-enters
    // at contact+250ms on a deflected line: the apparent turn/proximity at
    // the re-entry sample spans the gap and must be censored, not treated
    // as a hit at the sample time.
    const { sequence, window } = generateSwingSequence();
    const at = { x: 0.584, y: 0.6 };
    const ball: BallObservation[] = [];
    let frameIndex = 0;
    for (let t = window.peakMs - 550; t <= window.peakMs - 250; t += 30) {
      const raw = (t - (window.peakMs - 550)) / 300;
      ball.push({
        frameIndex: frameIndex++,
        timestampMs: t,
        x: 0.95 - 0.25 * raw,
        y: at.y - 0.08 + 0.05 * raw,
        confidence: 0.8,
      });
    }
    for (let t = window.peakMs + 250; t <= window.peakMs + 600; t += 30) {
      const raw = (t - (window.peakMs + 250)) / 350;
      ball.push({
        frameIndex: frameIndex++,
        timestampMs: t,
        x: at.x + 0.12 + 0.3 * raw,
        y: at.y - 0.1 - 0.15 * raw,
        confidence: 0.8,
      });
    }
    const estimate = estimateContact({
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
      ballObservations: ball,
    });
    expect(estimate.status).toBe("estimated");
    if (estimate.status !== "estimated") return;
    expect(Math.abs(estimate.estimatedContactMs - window.peakMs)).toBeLessThanOrEqual(60);
    expect(estimate.ballConfirmed).toBe(false);
    expect(estimate.limitingFactors).toContain("ball_lost_at_contact");
  });
});

describe("contact red-team: paddle track identity (reach tether)", () => {
  it("rejects a paddle track beyond reach of every measured target wrist", () => {
    // The paddle track switched to the OPPONENT's paddle across the court;
    // the ball turns at the opponent's hit 600ms after the target's true
    // contact. Without the reach tether this yields a both-modality-confirmed
    // contact 590ms late at confidence 0.76.
    const { sequence, window } = generateSwingSequence();
    const oppHitMs = window.peakMs + 600;
    const paddleCenters = Array.from({ length: 70 }, (_, i) => {
      const t = window.startMs + i * 30;
      const arc = Math.exp(-((t - oppHitMs) ** 2) / (2 * 100 * 100));
      return { timestampMs: t, x: 0.05 + 0.1 * arc, y: 0.18 - 0.03 * arc };
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
    const ball: BallObservation[] = [];
    let frameIndex = 0;
    for (let t = oppHitMs - 400; t <= oppHitMs + 300; t += 30) {
      const before = t <= oppHitMs;
      const raw = before ? (t - (oppHitMs - 400)) / 400 : (t - oppHitMs) / 300;
      ball.push({
        frameIndex: frameIndex++,
        timestampMs: t,
        x: before ? 0.6 - 0.45 * raw : 0.15 + 0.3 * raw,
        y: before ? 0.55 - 0.4 * raw : 0.15 + 0.1 * raw,
        confidence: 0.8,
      });
    }
    const estimate = estimateContact({
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs + 500, peakMotionMs: window.peakMs },
      ballObservations: ball,
      paddleSpeeds,
      paddleCenters,
    });
    expect(estimate.status).toBe("estimated");
    if (estimate.status !== "estimated") return;
    expect(Math.abs(estimate.estimatedContactMs - window.peakMs)).toBeLessThanOrEqual(60);
    expect(estimate.paddleConfirmed).toBe(false);
    expect(estimate.ballConfirmed).toBe(false);
    expect(estimate.limitingFactors).toContain("paddle_track_beyond_reach");
  });

  it("keeps trusting a genuine paddle track that stays within reach", () => {
    // Positive guard for the reach tether: a paddle riding just off the
    // dominant wrist must stay a full-strength target reference.
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
    });
    expect(estimate.status).toBe("estimated");
    if (estimate.status !== "estimated") return;
    expect(Math.abs(estimate.estimatedContactMs - window.peakMs)).toBeLessThanOrEqual(60);
    expect(estimate.paddleConfirmed).toBe(true);
    expect(estimate.limitingFactors).not.toContain("paddle_track_beyond_reach");
  });
});
