import { describe, expect, it } from "vitest";
import { generateSwingSequence } from "@pickle/evaluation";
import { classifyStroke, STROKE_TAXONOMY_V3 } from "../src/index.js";
import type { TrackedPaddleObservation } from "../src/index.js";
import type { PoseSequence } from "@pickle/swing-domain";

/** Paddle observations pinned at a fixed point around contact. */
function paddleAt(
  x: number,
  y: number,
  contactMs: number,
  confidence = 0.7,
): TrackedPaddleObservation[] {
  return Array.from({ length: 11 }, (_, index) => ({
    timestampMs: contactMs - 200 + index * 40,
    box: { x: x - 0.03, y: y - 0.04, width: 0.06, height: 0.08 },
    center: { x, y },
    detectorScore: confidence,
    trackId: 1,
    confidence,
    nearWrist: true,
  }));
}

/**
 * Hand-built pose sequence mirroring the DEV overhead failure shape
 * (afn-sasebo-rally2): torso steady, dominant (right) wrist measured HIGH
 * above the shoulder line at high visibility in the frames before contact,
 * then a low-visibility jitter drop to mid-body at the contact frame itself.
 */
function overheadJitterSequence(contactMs: number): PoseSequence {
  const frames = [];
  const shoulderY = 0.4;
  const hipY = 0.64; // torso 0.24
  for (let index = 0; index < 21; index += 1) {
    const tMs = contactMs - 300 + index * 30;
    // Raised phase: from 150ms before contact until just before contact.
    const raised = tMs >= contactMs - 160 && tMs <= contactMs - 40;
    const atContact = Math.abs(tMs - contactMs) < 30;
    const wrist = raised
      ? { x: 0.7, y: shoulderY - 0.12, visibility: 0.8 } // +0.5 torso above shoulders
      : atContact
        ? { x: 0.76, y: 0.5, visibility: 0.3 } // jitter drop, low visibility
        : { x: 0.72, y: 0.55, visibility: 0.45 };
    const elbow = raised
      ? { x: 0.72, y: shoulderY - 0.05, visibility: 0.8 } // +0.2 torso above
      : { x: 0.74, y: 0.5, visibility: 0.45 };
    frames.push({
      frameIndex: index,
      timestampMs: tMs,
      confidence: 0.9,
      landmarks: [
        { name: "left_shoulder", x: 0.6, y: shoulderY, visibility: 0.9 },
        { name: "right_shoulder", x: 0.8, y: shoulderY, visibility: 0.9 },
        { name: "left_hip", x: 0.62, y: hipY, visibility: 0.9 },
        { name: "right_hip", x: 0.78, y: hipY, visibility: 0.9 },
        { name: "right_wrist", ...wrist },
        { name: "right_elbow", ...elbow },
        { name: "left_wrist", x: 0.62, y: 0.55, visibility: 0.3 },
        { name: "left_elbow", x: 0.63, y: 0.5, visibility: 0.3 },
      ],
    });
  }
  return {
    schemaVersion: 1,
    format: "pickle.pose-sequence.v1",
    coordinateSystem: "normalized_image_top_left",
    producedBy: {
      providerId: "synthetic.swing-generator",
      modelVersion: "synthetic-swing-1",
      runtime: "deterministic",
      executionTarget: "on_device",
      artifactHash: null,
    },
    video: { width: 1080, height: 1080, fps: 30 },
    frames,
  } as PoseSequence;
}

/** Same skeleton but with the wrist invisible near contact. */
function wristInvisibleSequence(contactMs: number): PoseSequence {
  const sequence = overheadJitterSequence(contactMs);
  return {
    ...sequence,
    frames: sequence.frames.map((frame) => ({
      ...frame,
      landmarks: frame.landmarks.map((mark) =>
        mark.name.endsWith("wrist") ? { ...mark, visibility: 0.1 } : mark,
      ),
    })),
  };
}

describe("classifyStroke (heuristic, hierarchical)", () => {
  const { sequence, window } = generateSwingSequence();
  const windowArg = { startMs: window.startMs, endMs: window.endMs };

  it("versions its output as stroke-heuristic-8", () => {
    const prediction = classifyStroke({
      sequence,
      window: windowArg,
      contactMs: window.peakMs,
      handedness: "right",
      paddle: paddleAt(0.8, 0.55, window.peakMs),
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(prediction.classifierVersion).toContain("stroke-heuristic-8");
  });

  it("stops at depth 2 with a side when bounce is unobservable", () => {
    // Synthetic player's shoulders: rear-ish order; put the paddle clearly on
    // the player's right at chest height (within reach of the wrist).
    const prediction = classifyStroke({
      sequence,
      window: windowArg,
      contactMs: window.peakMs,
      handedness: "right",
      paddle: paddleAt(0.75, 0.6, window.peakMs),
      paddleSpeeds: Array.from({ length: 20 }, (_, index) => ({
        timestampMs: window.peakMs - 300 + index * 30,
        value: 1.8,
      })),
      wristSpeeds: null,
    });
    expect(prediction.taxonomyVersion).toBe(STROKE_TAXONOMY_V3.version);
    expect(prediction.taxonomyDepth).toBe(2);
    expect(["FOREHAND", "BACKHAND"]).toContain(prediction.label);
    expect(prediction.leaf).toBeNull(); // no L3 commitment without bounce
    expect(prediction.limitingFactors).toContain("bounce_not_observed_level3_uncommitted");
    expect(prediction.evidence.some((entry) => entry.includes("speed peak"))).toBe(true);
    expect(prediction.contactPointSource).toBe("paddle");
    expect(prediction.contactPointReliability).toBe("strong");
  });

  it("claims OVERHEAD when a plausible high contact point is corroborated by the raised wrist", () => {
    // contactHeightRatio 1.2 puts the synthetic wrist ~0.5 torso above the
    // shoulder line at contact and through the follow — real raise evidence.
    const high = generateSwingSequence({ contactHeightRatio: 1.2 });
    const contactFrame = high.sequence.frames.reduce((best, frame) =>
      Math.abs(frame.timestampMs - high.window.peakMs) <
      Math.abs(best.timestampMs - high.window.peakMs)
        ? frame
        : best,
    );
    const wrist = contactFrame.landmarks.find((mark) => mark.name === "right_wrist")!;
    const prediction = classifyStroke({
      sequence: high.sequence,
      window: { startMs: high.window.startMs, endMs: high.window.endMs },
      contactMs: high.window.peakMs,
      handedness: "right",
      paddle: paddleAt(wrist.x + 0.02, wrist.y - 0.03, high.window.peakMs),
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(prediction.label).toBe("OVERHEAD");
    expect(prediction.leaf).toBe("OVERHEAD");
    expect(prediction.taxonomyDepth).toBe(1);
    expect(prediction.evidence.some((entry) => entry.includes("overhead window"))).toBe(true);
  });

  it("does NOT claim OVERHEAD from a floating high paddle box the wrist never reached", () => {
    // stroke-heuristic-1 confidently called OVERHEAD here from the single
    // point; -2 rejects the implausible box (far beyond wrist reach), uses
    // the wrist, and classifies the side instead.
    const prediction = classifyStroke({
      sequence,
      window: windowArg,
      contactMs: window.peakMs,
      handedness: "right",
      paddle: paddleAt(0.62, 0.05, window.peakMs), // far above shoulder line
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(prediction.label).not.toBe("OVERHEAD");
    expect(prediction.limitingFactors).toContain("paddle_point_implausible_used_wrist");
    expect(prediction.contactPointSource).toBe("wrist");
  });

  it("claims OVERHEAD from repeated skeletal raise evidence over a degraded mid-body point (dev rally2 shape)", () => {
    const contactMs = 2650;
    const prediction = classifyStroke({
      sequence: overheadJitterSequence(contactMs),
      window: { startMs: contactMs - 400, endMs: contactMs + 200 },
      contactMs,
      handedness: "right",
      // Stale mid-body paddle box with rock-bottom track confidence, sitting
      // right on the (jittered) wrist so it passes the reach check.
      paddle: paddleAt(0.75, 0.52, contactMs, 0.08),
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(prediction.label).toBe("OVERHEAD");
    expect(prediction.taxonomyDepth).toBe(1);
    expect(prediction.contactPointReliability).toBe("degraded");
    expect(prediction.limitingFactors).toContain(
      "contact_point_contradicts_overhead_but_degraded_window_wins",
    );
    expect(prediction.confidence).toBeLessThanOrEqual(0.7);
  });

  it("keeps the side call when the paddle track is trustworthy and the skeleton stays low", () => {
    // wm-volley shape: strong paddle confidence, wrist below shoulders the
    // whole window — behavior identical to stroke-heuristic-1.
    const prediction = classifyStroke({
      sequence,
      window: windowArg,
      contactMs: window.peakMs,
      handedness: "right",
      paddle: paddleAt(0.75, 0.6, window.peakMs, 0.75),
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(prediction.label).toBe("FOREHAND");
    expect(prediction.taxonomyDepth).toBe(2);
    expect(prediction.confidence).toBeGreaterThanOrEqual(0.8 - 1e-9);
  });

  it("abstains to UNKNOWN when contact sits on the body midline", () => {
    const { sequence: seq2, window: window2 } = generateSwingSequence();
    const frames = seq2.frames;
    const contactFrame = frames.reduce((best, frame) =>
      Math.abs(frame.timestampMs - window2.peakMs) < Math.abs(best.timestampMs - window2.peakMs)
        ? frame
        : best,
    );
    const shoulders = contactFrame.landmarks.filter((mark) => mark.name.endsWith("shoulder"));
    const midX = (shoulders[0]!.x + shoulders[1]!.x) / 2;
    const midY = (shoulders[0]!.y + shoulders[1]!.y) / 2 + 0.1;
    const prediction = classifyStroke({
      sequence: seq2,
      window: { startMs: window2.startMs, endMs: window2.endMs },
      contactMs: window2.peakMs,
      handedness: "right",
      paddle: paddleAt(midX, midY, window2.peakMs),
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(prediction.label).toBe("UNKNOWN");
    expect(
      prediction.limitingFactors.some((factor) => factor.includes("contact_too_close_to_midline")),
    ).toBe(true);
  });

  it("abstains instead of committing a low-margin side on a degraded contact point", () => {
    const { sequence: seq3, window: window3 } = generateSwingSequence();
    const contactFrame = seq3.frames.reduce((best, frame) =>
      Math.abs(frame.timestampMs - window3.peakMs) < Math.abs(best.timestampMs - window3.peakMs)
        ? frame
        : best,
    );
    const shoulders = contactFrame.landmarks.filter((mark) => mark.name.endsWith("shoulder"));
    const midX = (shoulders[0]!.x + shoulders[1]!.x) / 2;
    const shoulderWidth = Math.abs(shoulders[0]!.x - shoulders[1]!.x);
    const wrist = contactFrame.landmarks.find((mark) => mark.name === "right_wrist")!;
    // Margin ~0.3 shoulder-widths (above the 0.15 floor, inside the 0.5
    // degraded band), pinned near the wrist so the reach check passes, with
    // rock-bottom track confidence → degraded provenance → UNKNOWN.
    const prediction = classifyStroke({
      sequence: seq3,
      window: { startMs: window3.startMs, endMs: window3.endMs },
      contactMs: window3.peakMs,
      handedness: "right",
      paddle: paddleAt(midX + 0.3 * shoulderWidth, wrist.y, window3.peakMs, 0.05),
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.limitingFactors).toContain("side_margin_within_degraded_abstention_band");
    expect(prediction.contactPointReliability).toBe("degraded");

    // Same geometry with a trustworthy track commits (outside the band).
    const trusted = classifyStroke({
      sequence: seq3,
      window: { startMs: window3.startMs, endMs: window3.endMs },
      contactMs: window3.peakMs,
      handedness: "right",
      paddle: paddleAt(midX + 0.3 * shoulderWidth, wrist.y, window3.peakMs, 0.75),
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(trusted.label).toBe("FOREHAND");
  });

  it("abstains when the paddle point is unverifiable and the wrist is invisible at contact", () => {
    const contactMs = 2650;
    const prediction = classifyStroke({
      sequence: wristInvisibleSequence(contactMs),
      window: { startMs: contactMs - 400, endMs: contactMs + 200 },
      contactMs,
      handedness: "right",
      paddle: paddleAt(0.75, 0.52, contactMs, 0.08), // low-confidence box, no wrist to verify
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.limitingFactors).toContain(
      "contact_point_unreliable_paddle_unverified_wrist_invisible",
    );
  });

  it("uses the event peak (never a window midpoint) when contact is missing", () => {
    const prediction = classifyStroke({
      sequence,
      window: windowArg,
      contactMs: null,
      eventPeakMs: window.peakMs,
      handedness: "right",
      paddle: paddleAt(0.8, 0.55, window.peakMs),
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(prediction.limitingFactors).toContain("reference_is_event_peak_not_contact");

    const noReference = classifyStroke({
      sequence,
      window: windowArg,
      contactMs: null,
      eventPeakMs: null,
      handedness: "right",
      paddle: paddleAt(0.8, 0.55, window.peakMs),
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(noReference.label).toBe("UNKNOWN");
    expect(noReference.limitingFactors).toContain("no_contact_and_no_event_peak_reference");
  });
});
