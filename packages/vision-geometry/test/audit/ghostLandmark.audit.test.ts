import { describe, expect, it } from "vitest";
import { generateSwingSequence } from "@pickle/evaluation";
import type { BallObservation } from "@pickle/swing-domain";
import { classifyStroke, estimateContact } from "../../src/index.js";
import { dropLandmark, ghostLandmark } from "./support.js";

/**
 * AUDIT PROBE — invariant I1: "missing / low-visibility (<0.3) landmarks are
 * skipped, never interpolated". A landmark with visibility 0 must behave
 * exactly like an absent landmark everywhere a landmark position is read.
 *
 * Sites under test (all read `mark.x/mark.y` without a visibility gate):
 *   offlineStroke.ts nearestTargetReference (~1485-1492)
 *   offlineStroke.ts nearestWristDistanceTo (~1574-1580)
 *   offlineStroke.ts closestBallToWrist     (~1630-1641)
 *   strokeHeuristicLite.ts classifyStroke   (397-409, torso joints at reference)
 *   strokeHeuristicLite.ts medianTorsoExtent (983-990)
 */

/** Opponent-side ball turn ~280ms before the swing peak (mirrors the
 * existing "rejects ball evidence far from the target's paddle" fixture). */
function farBall(peakMs: number): BallObservation[] {
  return Array.from({ length: 10 }, (_, index) => {
    const t = peakMs - 400 + index * 30;
    const before = index <= 4;
    return {
      frameIndex: index,
      timestampMs: t,
      x: before ? 0.15 + index * 0.03 : 0.27 - (index - 4) * 0.03,
      y: 0.15,
      confidence: 0.8,
    };
  });
}

describe("AUDIT estimateContact: zero-visibility wrist must not tether ball evidence", () => {
  const { sequence, window } = generateSwingSequence();
  const windowArg = { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs };
  const ball = farBall(window.peakMs);
  const turn = ball[4]!; // the direction change sample

  it("control: with real wrists only, the far turn is rejected (baseline behaviour)", () => {
    const control = estimateContact({ sequence, window: windowArg, ballObservations: ball });
    expect(control.status).toBe("estimated");
    if (control.status !== "estimated") return;
    expect(control.supportingEvidence.map((s) => s.signal)).not.toContain("ball_direction_change");
    expect(control.limitingFactors).toContain("ball_turns_rejected_far_from_target");
  });

  it("a visibility-0 left_wrist placed at the turn point must be ignored like an absent landmark", () => {
    const ghost = ghostLandmark(
      sequence,
      "left_wrist",
      (t) => Math.abs(t - turn.timestampMs) <= 80,
      { x: turn.x, y: turn.y },
    );
    const absent = dropLandmark(
      sequence,
      "left_wrist",
      (t) => Math.abs(t - turn.timestampMs) <= 80,
    );

    const withGhost = estimateContact({
      sequence: ghost,
      window: windowArg,
      ballObservations: ball,
    });
    const withAbsent = estimateContact({
      sequence: absent,
      window: windowArg,
      ballObservations: ball,
    });

    expect(withGhost.status).toBe(withAbsent.status);
    if (withGhost.status !== "estimated" || withAbsent.status !== "estimated") return;
    const ghostSignals = withGhost.supportingEvidence.map((s) => s.signal);
    // I1: a zero-visibility joint may not act as a target reference.
    expect(ghostSignals).not.toContain("ball_direction_change");
    expect(withGhost.limitingFactors).toContain("ball_turns_rejected_far_from_target");
    expect(withGhost.estimatedContactMs).toBe(withAbsent.estimatedContactMs);
    expect(withGhost.confidence).toBe(withAbsent.confidence);
  });

  it("a far ball turn at the swing peak tethered only by a visibility-0 wrist must not raise confidence or confirm the ball", () => {
    // Same far-side ball, but its turn coincides with the wrist speed peak.
    const atPeak = farBall(window.peakMs + 280);
    const peakTurn = atPeak[4]!;
    const near = (t: number) => Math.abs(t - peakTurn.timestampMs) <= 80;
    const withGhost = estimateContact({
      sequence: ghostLandmark(sequence, "left_wrist", near, { x: peakTurn.x, y: peakTurn.y }),
      window: windowArg,
      ballObservations: atPeak,
    });
    const withAbsent = estimateContact({
      sequence: dropLandmark(sequence, "left_wrist", near),
      window: windowArg,
      ballObservations: atPeak,
    });
    console.log(`[audit] peak-turn absent: ${JSON.stringify(withAbsent)}`);
    console.log(`[audit] peak-turn ghost:  ${JSON.stringify(withGhost)}`);
    // A "not detected" joint may not flip the verdict (abstain ↔ estimate).
    expect(withGhost.status).toBe(withAbsent.status);
    if (withGhost.status !== "estimated" || withAbsent.status !== "estimated") return;
    expect(withGhost.ballConfirmed).toBe(false);
    expect(withGhost.confidence).toBeLessThanOrEqual(withAbsent.confidence);
  });

  it("a visibility-0 wrist near a ball sample must not create ball_wrist_proximity evidence", () => {
    // Ball stays far from the player but passes through the point where a
    // zero-confidence wrist is reported at the same instant.
    const sample = ball[2]!;
    const ghost = ghostLandmark(
      sequence,
      "left_wrist",
      (t) => Math.abs(t - sample.timestampMs) <= 30,
      { x: sample.x, y: sample.y },
    );
    const absent = dropLandmark(
      sequence,
      "left_wrist",
      (t) => Math.abs(t - sample.timestampMs) <= 30,
    );
    const withGhost = estimateContact({
      sequence: ghost,
      window: windowArg,
      ballObservations: ball,
    });
    const withAbsent = estimateContact({
      sequence: absent,
      window: windowArg,
      ballObservations: ball,
    });
    expect(withGhost.status).toBe(withAbsent.status);
    if (withGhost.status !== "estimated" || withAbsent.status !== "estimated") return;
    expect(withGhost.supportingEvidence.map((s) => s.signal)).not.toContain("ball_wrist_proximity");
    expect(withGhost.confidence).toBe(withAbsent.confidence);
  });
});

describe("AUDIT classifyStroke: zero-visibility torso joint must equal an absent joint", () => {
  const { sequence, window } = generateSwingSequence();
  const windowArg = { startMs: window.startMs, endMs: window.endMs };
  const referenceFrame = sequence.frames.reduce((best, frame) =>
    Math.abs(frame.timestampMs - window.peakMs) < Math.abs(best.timestampMs - window.peakMs)
      ? frame
      : best,
  );
  const onlyReference = (t: number) => t === referenceFrame.timestampMs;
  const mobileRealityInput = (seq: typeof sequence) => ({
    sequence: seq,
    window: windowArg,
    contactMs: null,
    eventPeakMs: window.peakMs,
    handedness: "right" as const,
    paddle: null,
    paddleSpeeds: null,
    wristSpeeds: null,
  });

  it("control: absent hip at the reference frame abstains with torso_not_measured_at_contact", () => {
    const absent = dropLandmark(sequence, "left_hip", onlyReference);
    const prediction = classifyStroke(mobileRealityInput(absent));
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.limitingFactors).toContain("torso_not_measured_at_contact");
  });

  it("a visibility-0 left_hip at (0,1) in the reference frame must not yield a committed label", () => {
    const ghost = ghostLandmark(sequence, "left_hip", onlyReference);
    const prediction = classifyStroke(mobileRealityInput(ghost));
    // I1: the zero-visibility joint must be treated as missing → UNKNOWN.
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.taxonomyDepth).toBe(1);
  });

  it("a visibility-0 hip inflating the torso must not demote a corroborated OVERHEAD to a side label", () => {
    const high = generateSwingSequence({ contactHeightRatio: 1.2 });
    const ref = high.sequence.frames.reduce((best, frame) =>
      Math.abs(frame.timestampMs - high.window.peakMs) <
      Math.abs(best.timestampMs - high.window.peakMs)
        ? frame
        : best,
    );
    const wrist = ref.landmarks.find((mark) => mark.name === "right_wrist")!;
    const paddle = Array.from({ length: 11 }, (_, index) => ({
      timestampMs: high.window.peakMs - 200 + index * 40,
      center: { x: wrist.x, y: wrist.y - 0.02 },
    }));
    const clean = classifyStroke({
      sequence: high.sequence,
      window: { startMs: high.window.startMs, endMs: high.window.endMs },
      contactMs: high.window.peakMs,
      handedness: "right",
      paddle,
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(clean.label).toBe("OVERHEAD");

    const ghost = ghostLandmark(high.sequence, "right_hip", (t) => t === ref.timestampMs);
    const prediction = classifyStroke({
      sequence: ghost,
      window: { startMs: high.window.startMs, endMs: high.window.endMs },
      contactMs: high.window.peakMs,
      handedness: "right",
      paddle,
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    // Either the same answer as with real joints, or an honest abstention —
    // never a different committed label driven by a "not detected" joint.
    expect(["OVERHEAD", "UNKNOWN"]).toContain(prediction.label);
  });
});
