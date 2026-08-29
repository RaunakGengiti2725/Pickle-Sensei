import { describe, expect, it } from "vitest";
import { generateSwingSequence } from "@pickle/evaluation";
import type { BallObservation } from "@pickle/swing-domain";
import {
  detectOfflineStrokeWindow,
  estimateContact,
  evaluateCaptureQuality,
} from "../src/index.js";

describe("detectOfflineStrokeWindow", () => {
  it("finds the constructed swing window and peak on a full-video sequence", () => {
    const { sequence, window } = generateSwingSequence();
    const detected = detectOfflineStrokeWindow(sequence);
    expect(detected.ok).toBe(true);
    if (!detected.ok) return;
    expect(Math.abs(detected.value.peakMotionMs - window.peakMs)).toBeLessThanOrEqual(50);
    expect(detected.value.startMs).toBeLessThan(window.peakMs - 200);
    expect(detected.value.endMs).toBeGreaterThan(window.peakMs + 200);
    expect(detected.value.confidence).toBeGreaterThan(0.3);
  });

  it("abstains on idle motion instead of inventing a stroke", () => {
    const { sequence } = generateSwingSequence();
    const frozen = {
      ...sequence,
      frames: sequence.frames.map((frame) => ({
        ...frame,
        landmarks: frame.landmarks.map((mark) =>
          mark.name.endsWith("wrist") ? { ...mark, x: 0.5, y: 0.5 } : mark,
        ),
      })),
    };
    const detected = detectOfflineStrokeWindow(frozen);
    expect(detected.ok).toBe(false);
    if (detected.ok) return;
    expect(detected.failure.code).toBe("offline_trigger.no_distinct_stroke");
  });
});

describe("estimateContact", () => {
  it("estimates from the wrist peak alone with modest confidence, unconfirmed by ball", () => {
    const { sequence, window } = generateSwingSequence();
    const estimate = estimateContact({
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
      ballObservations: null,
    });
    expect(estimate.status).toBe("estimated");
    if (estimate.status !== "estimated") return;
    expect(Math.abs(estimate.estimatedContactMs - window.peakMs)).toBeLessThanOrEqual(50);
    expect(estimate.supportingEvidence.map((signal) => signal.signal)).toEqual([
      "wrist_speed_peak",
    ]);
    expect(estimate.confidence).toBeLessThan(0.6); // one signal ≠ high confidence
    expect(estimate.ballConfirmed).toBe(false);
  });

  it("uses a measured paddle speed peak as an independent motion signal", () => {
    const { sequence, window } = generateSwingSequence();
    // Paddle speeds constructed to peak 20ms after the wrist peak.
    const paddleSpeeds = Array.from({ length: 40 }, (_, index) => {
      const t = window.peakMs - 400 + index * 20;
      return { timestampMs: t, value: Math.max(0, 3 - Math.abs(t - (window.peakMs + 20)) / 80) };
    });
    const estimate = estimateContact({
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
      ballObservations: null,
      paddleSpeeds,
    });
    expect(estimate.status).toBe("estimated");
    if (estimate.status !== "estimated") return;
    const kinds = estimate.supportingEvidence.map((signal) => signal.signal);
    expect(kinds).toContain("paddle_speed_peak");
    expect(kinds).toContain("wrist_speed_peak");
    expect(estimate.confidence).toBeGreaterThan(0.5); // two corroborating signals
    expect(estimate.ballConfirmed).toBe(false); // motion-only: no ball evidence
    expect(Math.abs(estimate.estimatedContactMs - window.peakMs)).toBeLessThanOrEqual(60);
  });

  it("raises confidence when a real ball track corroborates the wrist peak", () => {
    const { sequence, window } = generateSwingSequence();
    // Synthetic (labeled) incoming→outgoing ball with a turn at the peak.
    const ball: BallObservation[] = [];
    for (let index = 0; index < 12; index += 1) {
      const t = window.peakMs - 180 + index * 30;
      const before = t <= window.peakMs;
      ball.push({
        frameIndex: index,
        timestampMs: t,
        x: before ? 0.9 - (0.9 - 0.584) * ((t - (window.peakMs - 180)) / 180) : 0.584 + ((t - window.peakMs) / 180) * 0.5,
        y: before ? 0.6 + 0.1 * ((t - (window.peakMs - 180)) / 180) : 0.7 - ((t - window.peakMs) / 180) * 0.25,
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
    const kinds = estimate.supportingEvidence.map((signal) => signal.signal);
    expect(kinds).toContain("wrist_speed_peak");
    expect(kinds).toContain("ball_direction_change");
    expect(Math.abs(estimate.estimatedContactMs - window.peakMs)).toBeLessThanOrEqual(60);
    expect(estimate.confidence).toBeGreaterThan(0.55);
    expect(estimate.ballConfirmed).toBe(true);
  });

  it("does not claim ball-confirmed when the ball was lost before the estimated moment", () => {
    const { sequence, window } = generateSwingSequence();
    // Straight-line ball approaching a stationary paddle, vanishing (blur)
    // ~260ms before the wrist peak — no direction change was ever observed,
    // so proximity is the only ball evidence and it pins to the last point.
    const ball: BallObservation[] = Array.from({ length: 10 }, (_, index) => ({
      frameIndex: index,
      timestampMs: window.peakMs - 620 + index * 40,
      x: 0.95 - index * 0.04, // ends at 0.59, nearest the paddle at the end
      y: 0.6,
      confidence: 0.7,
    }));
    const paddleCenters = Array.from({ length: 30 }, (_, index) => ({
      timestampMs: window.peakMs - 660 + index * 40,
      x: 0.55,
      y: 0.6,
    }));
    const estimate = estimateContact({
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
      ballObservations: ball,
      paddleCenters,
    });
    expect(estimate.status).toBe("estimated");
    if (estimate.status !== "estimated") return;
    expect(estimate.ballConfirmed).toBe(false);
    expect(estimate.limitingFactors).toContain("ball_lost_at_contact");
  });

  it("confirms the paddle only when paddle centers exist near the moment", () => {
    const { sequence, window } = generateSwingSequence();
    const speedAt = (t: number) => Math.max(0, 2.5 - Math.abs(t - window.peakMs) / 150);
    const paddleSpeeds = Array.from({ length: 40 }, (_, index) => {
      const t = window.peakMs - 500 + index * 20;
      return { timestampMs: t, value: speedAt(t) };
    });
    const paddleCenters = paddleSpeeds.map((sample) => ({
      timestampMs: sample.timestampMs,
      x: 0.6,
      y: 0.6,
    }));
    const confirmed = estimateContact({
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
      ballObservations: null,
      paddleSpeeds,
      paddleCenters,
    });
    expect(confirmed.status).toBe("estimated");
    if (confirmed.status !== "estimated") return;
    expect(confirmed.paddleConfirmed).toBe(true);
    expect(confirmed.ballConfirmed).toBe(false);
    expect(confirmed.limitingFactors).toContain("no_ball_evidence");

    // The paddle track dies 300ms early: its own (real, ≥0.5 u/s) speed peak
    // sits at the cutoff, the fused moment lands later, and nothing paddle
    // was observed there — paddle evidence must not confirm.
    const cutoff = window.peakMs - 300;
    const lost = estimateContact({
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
      ballObservations: null,
      paddleSpeeds: paddleSpeeds.filter((sample) => sample.timestampMs <= cutoff),
      paddleCenters: paddleCenters.filter((center) => center.timestampMs <= cutoff),
    });
    expect(lost.status).toBe("estimated");
    if (lost.status !== "estimated") return;
    expect(lost.paddleConfirmed).toBe(false);
    expect(lost.limitingFactors).toContain("paddle_lost_at_contact");
  });

  it("uses ball–paddle proximity (not wrist) when a measured paddle exists", () => {
    const { sequence, window } = generateSwingSequence();
    const ball: BallObservation[] = Array.from({ length: 12 }, (_, index) => {
      const t = window.peakMs - 180 + index * 30;
      const before = t <= window.peakMs;
      return {
        frameIndex: index,
        timestampMs: t,
        x: before ? 0.9 - (0.9 - 0.6) * ((t - (window.peakMs - 180)) / 180) : 0.6 + ((t - window.peakMs) / 180) * 0.5,
        y: 0.6,
        confidence: 0.8,
      };
    });
    const paddleCenters = ball.map((observation) => ({
      timestampMs: observation.timestampMs,
      x: 0.58,
      y: 0.61,
    }));
    const estimate = estimateContact({
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
      ballObservations: ball,
      paddleCenters,
    });
    expect(estimate.status).toBe("estimated");
    if (estimate.status !== "estimated") return;
    const kinds = estimate.supportingEvidence.map((signal) => signal.signal);
    expect(kinds).toContain("ball_paddle_proximity");
    expect(kinds).not.toContain("ball_wrist_proximity");
    expect(estimate.ballConfirmed).toBe(true);
  });

  it("abstains when signals disagree wildly", () => {
    const { sequence, window } = generateSwingSequence();
    // Ball turn constructed 800ms after the wrist peak → irreconcilable.
    const ball: BallObservation[] = [0, 1, 2, 3, 4, 5].map((index) => ({
      frameIndex: index,
      timestampMs: window.peakMs + 650 + index * 30,
      x: index < 3 ? 0.9 - index * 0.1 : 0.6 + (index - 3) * 0.12,
      y: 0.6,
      confidence: 0.8,
    }));
    const estimate = estimateContact({
      sequence,
      window: {
        startMs: window.startMs,
        endMs: window.endMs + 900,
        peakMotionMs: window.peakMs,
      },
      ballObservations: ball,
    });
    expect(estimate.status).toBe("abstained");
  });

  // ── contact-evidence-4: temporal fusion behaviors ─────────────────────────

  it("estimates from strong cross-modal agreement with high confidence and a distribution", () => {
    const { sequence, window } = generateSwingSequence();
    const paddleSpeeds = Array.from({ length: 40 }, (_, index) => {
      const t = window.peakMs - 400 + index * 20;
      return { timestampMs: t, value: Math.max(0, 2.6 - Math.abs(t - window.peakMs) / 90) };
    });
    const paddleCenters = paddleSpeeds.map((sample) => ({
      timestampMs: sample.timestampMs,
      x: 0.6,
      y: 0.68,
    }));
    // Incoming→outgoing ball turning exactly at the peak, through the paddle.
    const ball: BallObservation[] = Array.from({ length: 12 }, (_, index) => {
      const t = window.peakMs - 180 + index * 30;
      const before = t <= window.peakMs;
      return {
        frameIndex: index,
        timestampMs: t,
        x: before
          ? 0.9 - (0.9 - 0.6) * ((t - (window.peakMs - 180)) / 180)
          : 0.6 + ((t - window.peakMs) / 180) * 0.5,
        y: 0.68,
        confidence: 0.8,
      };
    });
    const estimate = estimateContact({
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
      ballObservations: ball,
      paddleSpeeds,
      paddleCenters,
    });
    expect(estimate.status).toBe("estimated");
    if (estimate.status !== "estimated") return;
    expect(Math.abs(estimate.estimatedContactMs - window.peakMs)).toBeLessThanOrEqual(50);
    expect(estimate.ballConfirmed).toBe(true);
    expect(estimate.paddleConfirmed).toBe(true);
    expect(estimate.confidence).toBeGreaterThan(0.7);
    // The fused temporal distribution ships for calibration work.
    expect(estimate.contactDistribution).toBeDefined();
    expect(estimate.contactDistribution!.length).toBeGreaterThan(10);
    const peakPoint = estimate.contactDistribution!.reduce((a, b) =>
      b.density > a.density ? b : a,
    );
    expect(Math.abs(peakPoint.tMs - window.peakMs)).toBeLessThanOrEqual(80);
  });

  it("does not let an early paddle whip outlier veto or drag agreeing evidence (v3 failure mode)", () => {
    const { sequence, window } = generateSwingSequence();
    // Paddle: a BIGGER whip peak during the READY phase (wrist measured
    // still ⇒ uncorroborated) and a true peak at contact (wrist corroborates).
    const whipMs = 250; // ready phase: 0–400ms in the synthetic swing
    const paddleSpeeds = Array.from({ length: 60 }, (_, index) => {
      const t = 100 + index * 20;
      const whip = Math.max(0, 1.9 - Math.abs(t - whipMs) / 60);
      const strike = Math.max(0, 1.5 - Math.abs(t - window.peakMs) / 80);
      return { timestampMs: t, value: Math.max(whip, strike) };
    });
    const estimate = estimateContact({
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
      ballObservations: null,
      paddleSpeeds,
    });
    expect(estimate.status).toBe("estimated");
    if (estimate.status !== "estimated") return;
    // v3's flat weighted mean would sit ~450ms early (or abstain on spread);
    // v4 must stay at the corroborated moment.
    expect(Math.abs(estimate.estimatedContactMs - window.peakMs)).toBeLessThanOrEqual(60);
  });

  it("abstains on comparable well-separated evidence clusters, reporting both modes", () => {
    const { sequence, window } = generateSwingSequence();
    // Two equal paddle bursts 500ms apart; the wrist supports both equally
    // (synthetic wrist speed is symmetric enough for corroboration).
    const firstMs = window.peakMs;
    const secondMs = window.peakMs + 500;
    const paddleSpeeds = Array.from({ length: 60 }, (_, index) => {
      const t = window.peakMs - 400 + index * 20;
      const a = Math.max(0, 2.2 - Math.abs(t - firstMs) / 70);
      const b = Math.max(0, 2.2 - Math.abs(t - secondMs) / 70);
      return { timestampMs: t, value: Math.max(a, b) };
    });
    const estimate = estimateContact({
      sequence,
      window: {
        startMs: window.startMs,
        endMs: window.endMs + 700,
        peakMotionMs: window.peakMs,
      },
      ballObservations: null,
      paddleSpeeds,
    });
    expect(estimate.status).toBe("abstained");
    if (estimate.status !== "abstained") return;
    expect(estimate.reason).toContain("multi-modal");
    expect(estimate.modes).toBeDefined();
    expect(estimate.modes!.length).toBeGreaterThanOrEqual(2);
    const modeTimes = estimate.modes!.map((mode) => mode.tMs);
    expect(modeTimes.some((tMs) => Math.abs(tMs - firstMs) <= 120)).toBe(true);
    expect(modeTimes.some((tMs) => Math.abs(tMs - secondMs) <= 120)).toBe(true);
  });

  it("rejects ball evidence far from the target's paddle (opponent-side turn cannot create contact)", () => {
    const { sequence, window } = generateSwingSequence();
    // Sharp turn ~280ms before the swing peak, but the ball never comes near
    // the target's paddle (torso 0.2 ⇒ ~2.5 torso spans away): an
    // opponent-side exchange that must not drag the estimate off the swing.
    const ball: BallObservation[] = Array.from({ length: 10 }, (_, index) => {
      const t = window.peakMs - 400 + index * 30;
      const before = index <= 4;
      return {
        frameIndex: index,
        timestampMs: t,
        x: before ? 0.15 + index * 0.03 : 0.27 - (index - 4) * 0.03,
        y: 0.15,
        confidence: 0.8,
      };
    });
    const paddleSpeeds = Array.from({ length: 40 }, (_, index) => {
      const t = window.peakMs - 400 + index * 20;
      return { timestampMs: t, value: Math.max(0, 2.4 - Math.abs(t - window.peakMs) / 90) };
    });
    const paddleCenters = paddleSpeeds.map((sample) => ({
      timestampMs: sample.timestampMs,
      x: 0.62,
      y: 0.68,
    }));
    const estimate = estimateContact({
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
      ballObservations: ball,
      paddleSpeeds,
      paddleCenters,
    });
    expect(estimate.status).toBe("estimated");
    if (estimate.status !== "estimated") return;
    // Motion evidence still anchors the moment; the far ball contributes
    // nothing and cannot confirm.
    expect(Math.abs(estimate.estimatedContactMs - window.peakMs)).toBeLessThanOrEqual(60);
    expect(estimate.ballConfirmed).toBe(false);
    expect(
      estimate.supportingEvidence.map((signal) => signal.signal),
    ).not.toContain("ball_direction_change");
    expect(estimate.limitingFactors).toContain("ball_turns_rejected_far_from_target");
    expect(estimate.limitingFactors).toContain("ball_never_near_target_paddle");
    // Gating decisions are recorded in the signal detail strings.
    expect(
      estimate.supportingEvidence.some((signal) => signal.detail.includes("rejected")),
    ).toBe(true);
  });

  it("abstains when the ball is OBSERVED far from the target at the fused moment (refutes contact)", () => {
    const { sequence, window } = generateSwingSequence();
    // Same far-side ball, but visible exactly when the motion evidence peaks:
    // one ball on the court, and it is somewhere else — no target contact.
    const ball: BallObservation[] = Array.from({ length: 10 }, (_, index) => {
      const t = window.peakMs - 150 + index * 30;
      const before = index <= 4;
      return {
        frameIndex: index,
        timestampMs: t,
        x: before ? 0.15 + index * 0.03 : 0.27 - (index - 4) * 0.03,
        y: 0.15,
        confidence: 0.8,
      };
    });
    const paddleSpeeds = Array.from({ length: 40 }, (_, index) => {
      const t = window.peakMs - 400 + index * 20;
      return { timestampMs: t, value: Math.max(0, 2.4 - Math.abs(t - window.peakMs) / 90) };
    });
    const paddleCenters = paddleSpeeds.map((sample) => ({
      timestampMs: sample.timestampMs,
      x: 0.62,
      y: 0.68,
    }));
    const estimate = estimateContact({
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
      ballObservations: ball,
      paddleSpeeds,
      paddleCenters,
    });
    expect(estimate.status).toBe("abstained");
    if (estimate.status !== "abstained") return;
    expect(estimate.reason).toContain("refutes contact");
    expect(estimate.limitingFactors).toContain("ball_observed_away_from_target_at_moment");
  });

  it("gates ball turns against provided target wrists when no paddle track exists", () => {
    const { sequence, window } = generateSwingSequence();
    const ball: BallObservation[] = Array.from({ length: 10 }, (_, index) => {
      const t = window.peakMs - 400 + index * 30;
      const before = index <= 4;
      return {
        frameIndex: index,
        timestampMs: t,
        x: before ? 0.15 + index * 0.03 : 0.27 - (index - 4) * 0.03,
        y: 0.15,
        confidence: 0.8,
      };
    });
    // Explicit target wrist positions far from the turn point.
    const targetWrists = Array.from({ length: 60 }, (_, index) => ({
      timestampMs: window.startMs + index * 30,
      x: 0.6,
      y: 0.7,
    }));
    const estimate = estimateContact({
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
      ballObservations: ball,
      targetWrists,
    });
    expect(estimate.status).toBe("estimated");
    if (estimate.status !== "estimated") return;
    expect(
      estimate.supportingEvidence.map((signal) => signal.signal),
    ).not.toContain("ball_direction_change");
    expect(estimate.ballConfirmed).toBe(false);
  });

  it("rejects physically implausible motion peaks as tracking glitches", () => {
    const { sequence, window } = generateSwingSequence();
    // Inject a single-frame wrist landmark jump (≈30 u/s on a 0.2-torso body
    // ⇒ ~150 torso/s: not human motion).
    const glitchMs = window.peakMs - 200;
    const glitched = {
      ...sequence,
      frames: sequence.frames.map((frame) =>
        Math.abs(frame.timestampMs - glitchMs) < 8
          ? {
              ...frame,
              landmarks: frame.landmarks.map((mark) =>
                mark.name === "right_wrist" ? { ...mark, x: mark.x + 0.5 } : mark,
              ),
            }
          : frame,
      ),
    };
    const estimate = estimateContact({
      sequence: glitched,
      window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
      ballObservations: null,
    });
    expect(estimate.status).toBe("estimated");
    if (estimate.status !== "estimated") return;
    expect(estimate.limitingFactors).toContain("implausible_motion_peak_rejected");
    expect(Math.abs(estimate.estimatedContactMs - window.peakMs)).toBeLessThanOrEqual(80);
  });

  it("keeps the v3 result contract when called without any v4 inputs", () => {
    const { sequence, window } = generateSwingSequence();
    const estimate = estimateContact({
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
      ballObservations: null,
    });
    expect(estimate.status).toBe("estimated");
    if (estimate.status !== "estimated") return;
    // Every v3 field, with v3 semantics.
    expect(typeof estimate.estimatedContactMs).toBe("number");
    expect(estimate.confidence).toBeGreaterThan(0);
    expect(estimate.confidence).toBeLessThanOrEqual(0.95);
    expect(typeof estimate.ballConfirmed).toBe("boolean");
    expect(typeof estimate.paddleConfirmed).toBe("boolean");
    expect(Array.isArray(estimate.limitingFactors)).toBe(true);
    expect(estimate.limitingFactors).toContain("no_ball_evidence");
    for (const signal of estimate.supportingEvidence) {
      expect(typeof signal.timestampMs).toBe("number");
      expect(typeof signal.weight).toBe("number");
      expect(typeof signal.detail).toBe("string");
    }
    // No fusion internals unless explicitly requested.
    expect(estimate.fusionKernels).toBeUndefined();
  });
});

describe("evaluateCaptureQuality", () => {
  it("accepts a clean synthetic capture and reports honest stats", () => {
    const { sequence } = generateSwingSequence();
    const report = evaluateCaptureQuality(sequence);
    expect(report.analyzable).toBe(true);
    expect(report.reasons).toEqual([]);
    expect(report.stats.effectiveFps).toBeGreaterThan(50);
    expect(report.notEvaluated).toContain("camera_motion");
  });

  it("rejects missing lower body with a specific reason", () => {
    const { sequence } = generateSwingSequence();
    const cropped = {
      ...sequence,
      frames: sequence.frames.map((frame) => ({
        ...frame,
        landmarks: frame.landmarks.filter(
          (mark) => !mark.name.includes("ankle") && !mark.name.includes("knee"),
        ),
      })),
    };
    const report = evaluateCaptureQuality(cropped);
    expect(report.analyzable).toBe(false);
    expect(report.reasons).toContain("body_not_fully_visible");
  });

  it("rejects too-few frames, low fps, dropouts, and tiny players specifically", () => {
    const { sequence } = generateSwingSequence();
    const few = { ...sequence, frames: sequence.frames.slice(0, 10) };
    expect(evaluateCaptureQuality(few).reasons).toContain("too_few_pose_frames");

    const sparse = {
      ...sequence,
      frames: sequence.frames.filter((_, index) => index % 5 === 0),
    };
    expect(evaluateCaptureQuality(sparse).reasons).toContain("insufficient_fps");

    const gap = {
      ...sequence,
      frames: sequence.frames.filter(
        (frame) => frame.timestampMs < 400 || frame.timestampMs > 1300,
      ),
    };
    expect(evaluateCaptureQuality(gap).reasons).toContain("tracking_dropout_gap");

    const tiny = {
      ...sequence,
      frames: sequence.frames.map((frame) => ({
        ...frame,
        landmarks: frame.landmarks.map((mark) => ({
          ...mark,
          x: 0.5 + (mark.x - 0.5) * 0.2,
          y: 0.5 + (mark.y - 0.5) * 0.2,
        })),
      })),
    };
    expect(evaluateCaptureQuality(tiny).reasons).toContain("player_too_small_in_frame");
  });
});
