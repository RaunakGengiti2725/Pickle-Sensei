import { describe, expect, it } from "vitest";
import type { StrokeEvent } from "@pickle/vision-contracts";
import { GeometricPhaseSegmenter } from "../src/phaseSegmenter.js";
import { classifyStroke, estimateContact, type HeuristicPaddleObservation } from "../src/index.js";
import { generateSwing, generateSwingSequence } from "@pickle/evaluation";

/**
 * Mutation pins for @pickle/vision-geometry (tools/mutation-pipeline-scoring).
 *
 * Each test below kills a specific mutant that SURVIVED the existing
 * @pickle/vision-geometry suite AND the regression bench (bench:compare exit 0):
 *   PHS-01  stroke-window frame filter `<= stroke.endMs` -> `<`
 *   PHS-04  preparation backward walk `index >= 0` -> `index > 0`
 *   CLS-04  UNKNOWN abstention emitted with confidence 0.9 instead of 0.2
 *   CON-03  unconfirmed-ball contact confidence cap raised from 0.7 to 0.95
 *   CON-04  weak-evidence abstention (`totalMass < minTotalMass`) removed
 *   CON-05  contact-far-from-motion-peak abstention (700 ms) removed
 * Replay:
 *   node tools/mutation-pipeline-scoring/run.mjs \
 *     --only PHS-01,PHS-04,CLS-04,CON-03,CON-04,CON-05 --with-pins
 */

const stroke = (window: {
  startMs: number;
  endMs: number;
  peakMs: number | null;
}): StrokeEvent => ({
  startMs: window.startMs,
  endMs: window.endMs,
  contactMs: window.peakMs,
  shotTypeHypothesis: null,
  confidence: 0.9,
});

describe("GeometricPhaseSegmenter mutation pins", () => {
  it("PHS-01: a pose frame timestamped exactly at stroke.endMs is inside the window", async () => {
    const swing = generateSwing();
    const segmenter = new GeometricPhaseSegmenter({ aspectRatio: 1 });
    // Six frames, the sixth landing exactly on the window end. The window
    // filter is inclusive on both ends, so this must NOT abstain for frame
    // count (it may still abstain for other, honest reasons on idle motion).
    const frames = swing.frames.slice(0, 6);
    const endMs = frames[5]!.timestampMs;
    const result = await segmenter.segmentPhases(
      frames,
      [],
      stroke({ startMs: frames[0]!.timestampMs, endMs, peakMs: null }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).not.toBe("phase.too_few_pose_frames");

    // One frame fewer inside the window (end just before the sixth frame)
    // MUST abstain with the frame-count code: the boundary is exact.
    const shorter = await segmenter.segmentPhases(
      frames,
      [],
      stroke({ startMs: frames[0]!.timestampMs, endMs: endMs - 1, peakMs: null }),
    );
    expect(shorter.ok).toBe(false);
    if (shorter.ok) return;
    expect(shorter.failure.code).toBe("phase.too_few_pose_frames");
  });

  it("PHS-01: a window ending exactly on the last frame sees that frame", async () => {
    const swing = generateSwing();
    const segmenter = new GeometricPhaseSegmenter({ aspectRatio: 1 });
    const lastTs = swing.frames[swing.frames.length - 1]!.timestampMs;
    const onFrame = await segmenter.segmentPhases(
      swing.frames,
      [],
      stroke({ startMs: 0, endMs: lastTs, peakMs: swing.window.peakMs }),
    );
    const pastFrame = await segmenter.segmentPhases(
      swing.frames,
      [],
      stroke({ startMs: 0, endMs: lastTs + 1, peakMs: swing.window.peakMs }),
    );
    expect(onFrame.ok).toBe(true);
    expect(pastFrame.ok).toBe(true);
    if (!onFrame.ok || !pastFrame.ok) return;
    // Same measured frames -> identical boundaries; only the trailing recover
    // end (the requested stroke.endMs itself) and its midpoint may move by 1ms.
    const strip = (spans: typeof onFrame.value) =>
      spans.map((span, index) =>
        index === spans.length - 1 ? { ...span, endMs: null, representativeMs: null } : span,
      );
    expect(strip(onFrame.value)).toEqual(strip(pastFrame.value));
    expect(onFrame.value[onFrame.value.length - 1]!.endMs).toBe(lastTs);
    expect(pastFrame.value[pastFrame.value.length - 1]!.endMs).toBe(lastTs + 1);
  });

  it("PHS-04: preparation can begin at the very first measured speed sample", async () => {
    const swing = generateSwing();
    const segmenter = new GeometricPhaseSegmenter({ aspectRatio: 1 });
    // Open the window mid-backswing (default truth: ready 0-400ms, backswing
    // 400-850ms). Every sample before the peak is then above 10% of the peak
    // speed, so the backward preparation walk must reach sample 0 and the
    // ready phase collapses onto the first speed sample.
    const startMs = 600;
    const frames = swing.frames.filter((frame) => frame.timestampMs >= startMs);
    const result = await segmenter.segmentPhases(
      frames,
      [],
      stroke({ startMs, endMs: swing.window.endMs, peakMs: swing.window.peakMs }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ready = result.value.find((span) => span.key === "ready")!;
    const prepare = result.value.find((span) => span.key === "prepare")!;
    // Central-difference speeds start at the SECOND window frame.
    const firstSpeedTs = frames[1]!.timestampMs;
    expect(ready.startMs).toBe(startMs);
    expect(ready.endMs).toBe(firstSpeedTs);
    expect(prepare.startMs).toBe(firstSpeedTs);
    expect(prepare.endMs).toBeGreaterThan(prepare.startMs);
  });
});

describe("classifyStroke mutation pins", () => {
  const paddleAt = (x: number, y: number, contactMs: number): HeuristicPaddleObservation[] =>
    Array.from({ length: 11 }, (_, index) => ({
      timestampMs: contactMs - 200 + index * 40,
      center: { x, y },
    }));

  it("CLS-04: every UNKNOWN abstention carries a confidence below the auto-resolution floor", () => {
    const { sequence, window } = generateSwingSequence();
    const windowArg = { startMs: window.startMs, endMs: window.endMs };
    const contactFrame = sequence.frames.reduce((best, frame) =>
      Math.abs(frame.timestampMs - window.peakMs) < Math.abs(best.timestampMs - window.peakMs)
        ? frame
        : best,
    );
    const shoulders = contactFrame.landmarks.filter((mark) => mark.name.endsWith("shoulder"));
    const midX = (shoulders[0]!.x + shoulders[1]!.x) / 2;
    const midY = (shoulders[0]!.y + shoulders[1]!.y) / 2 + 0.1;

    const abstentions = [
      // Contact on the body midline: no side margin.
      classifyStroke({
        sequence,
        window: windowArg,
        contactMs: window.peakMs,
        handedness: "right",
        paddle: paddleAt(midX, midY, window.peakMs),
        paddleSpeeds: null,
        wristSpeeds: null,
      }),
      // Neither a contact estimate nor an event peak to reference.
      classifyStroke({
        sequence,
        window: windowArg,
        contactMs: null,
        eventPeakMs: null,
        handedness: "right",
        paddle: paddleAt(0.8, 0.55, window.peakMs),
        paddleSpeeds: null,
        wristSpeeds: null,
      }),
      // Ambidextrous: the side decision is undefined.
      classifyStroke({
        sequence,
        window: windowArg,
        contactMs: window.peakMs,
        handedness: "ambidextrous",
        paddle: paddleAt(0.8, 0.55, window.peakMs),
        paddleSpeeds: null,
        wristSpeeds: null,
      }),
    ];
    for (const prediction of abstentions) {
      expect(prediction.label).toBe("UNKNOWN");
      expect(prediction.leaf).toBe("UNKNOWN");
      expect(prediction.taxonomyDepth).toBe(1);
      // An abstention must never look more certain than a committed side
      // (>= 0.45) or clear the 0.5 auto-resolution floor downstream.
      expect(prediction.confidence).toBeLessThan(0.45);
      expect(prediction.confidence).toBe(0.2);
    }
  });
});

describe("estimateContact mutation pins", () => {
  it("CON-03: a contact never corroborated by the ball is capped at 0.7 confidence", () => {
    const { sequence, window } = generateSwingSequence();
    // Wrist peak + an owned, present paddle peak: two coherent motion
    // families, so the raw fused confidence (0.18 + 0.55·coherence + 0.06·2)
    // clears 0.7 by itself — the only thing holding it there is the
    // unconfirmed-ball cap.
    const paddleSpeeds = Array.from({ length: 40 }, (_, index) => {
      const t = window.peakMs - 400 + index * 20;
      return { timestampMs: t, value: Math.max(0, 3 - Math.abs(t - window.peakMs) / 80) };
    });
    const paddleCenters = paddleSpeeds.map((sample) => ({
      timestampMs: sample.timestampMs,
      x: 0.72,
      y: 0.55,
    }));
    const estimate = estimateContact({
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
      ballObservations: null,
      paddleSpeeds,
      paddleCenters,
    });
    expect(estimate.status).toBe("estimated");
    if (estimate.status !== "estimated") return;
    expect(estimate.ballConfirmed).toBe(false);
    expect(estimate.paddleConfirmed).toBe(true);
    expect(estimate.limitingFactors).toContain("no_ball_evidence");
    // Two agreeing motion signals earn the full unconfirmed-ball budget...
    expect(estimate.confidence).toBeGreaterThan(0.65);
    // ...and not one bit more: without the ball, 0.7 is the ceiling.
    expect(estimate.confidence).toBeLessThanOrEqual(0.7);
  });

  it("CON-04: boundary-censored, uncorroborated motion evidence is too weak to place a contact", () => {
    const { sequence, window } = generateSwingSequence();
    // Scan ends ON the motion peak, so the wrist peak is a boundary maximum
    // (censored x0.3), and a flat sub-threshold paddle track (0.3 u/s, below
    // the 0.5 u/s paddle-peak floor so it contributes no kernel of its own)
    // refuses to corroborate the wrist (x0.667). Wrist reliability 0.5 x 0.3
    // x 0.667 leaves ~0.14 of mass: under the 0.15 evidence floor.
    const endMs = window.peakMs;
    const paddleSpeeds = Array.from({ length: 60 }, (_, index) => ({
      timestampMs: window.startMs + index * 20,
      value: 0.3,
    })).filter((sample) => sample.timestampMs <= endMs);
    const estimate = estimateContact({
      sequence,
      window: { startMs: window.startMs, endMs, peakMotionMs: endMs },
      ballObservations: null,
      paddleSpeeds,
    });
    expect(estimate.status).toBe("abstained");
    if (estimate.status !== "abstained") return;
    expect(estimate.limitingFactors).toContain("insufficient_evidence_mass");
    expect(estimate.reason).toMatch(
      /Contact evidence too weak: reliability-weighted mass 0\.1\d < 0\.15/,
    );
  });

  it("CON-05: a fused contact more than 700 ms from the scanned motion peak is refused", () => {
    const { sequence, window } = generateSwingSequence();
    // The evidence (wrist peak) sits at the true swing peak; the caller
    // claims the scanned movement peaked 1.5 s later. The strongest tracked
    // evidence therefore describes a different moment than the stroke under
    // analysis and must not be reported as its contact.
    const claimedPeakMs = window.peakMs + 1500;
    const estimate = estimateContact({
      sequence,
      window: { startMs: window.startMs, endMs: claimedPeakMs + 100, peakMotionMs: claimedPeakMs },
      ballObservations: null,
    });
    expect(estimate.status).toBe("abstained");
    if (estimate.status !== "abstained") return;
    expect(estimate.limitingFactors).toContain("contact_far_from_motion_peak");
    expect(estimate.reason).toMatch(/the strongest tracked evidence belongs to a different moment/);

    // Control: the same evidence with an honest motion peak IS estimated.
    const honest = estimateContact({
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
      ballObservations: null,
    });
    expect(honest.status).toBe("estimated");
  });
});
