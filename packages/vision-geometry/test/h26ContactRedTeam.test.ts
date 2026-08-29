/**
 * h26-redteam-perception contact regression (Wave H). SYNTHETIC fixture; no
 * corpus data. Pins the FIXED fabricated-contact break: a ball reversing
 * direction exactly at a completely MOTIONLESS athlete's wrist (opponent's
 * shot whizzing past, ball off a wall/partner) must never become a
 * high-confidence target contact.
 */
import { describe, expect, it } from "vitest";
import type { PoseSequence } from "@pickle/swing-domain";

import { estimateContact } from "../src/offlineStroke.js";

function staticSequence(frameCount: number): PoseSequence {
  return {
    schemaVersion: 1,
    format: "pickle.pose-sequence.v1",
    coordinateSystem: "normalized_image_top_left",
    producedBy: {
      providerId: "synthetic.h26",
      modelVersion: "synthetic",
      runtime: "vision_framework",
      executionTarget: "on_device",
      artifactHash: null,
    },
    video: { width: 1920, height: 1080, fps: 30 },
    frames: Array.from({ length: frameCount }, (_, index) => ({
      frameIndex: index,
      timestampMs: index * 33,
      confidence: 0.9,
      landmarks: [
        { name: "left_shoulder", x: 0.48, y: 0.5, visibility: 0.9 },
        { name: "right_shoulder", x: 0.52, y: 0.5, visibility: 0.9 },
        { name: "left_hip", x: 0.48, y: 0.62, visibility: 0.9 },
        { name: "right_hip", x: 0.52, y: 0.62, visibility: 0.9 },
        { name: "left_wrist", x: 0.46, y: 0.68, visibility: 0.9 },
        { name: "right_wrist", x: 0.55, y: 0.68, visibility: 0.9 },
      ],
    })),
  } as PoseSequence;
}

describe("h26-C1 (FIXED P0): fabricated contact on a motionless athlete", () => {
  it("does not estimate a confident contact from ball reversal alone", () => {
    const sequence = staticSequence(60);
    // Ball flies in, turns 180° exactly at the static right wrist at 990ms.
    const ball = Array.from({ length: 60 }, (_, i) => {
      const x = i <= 30 ? 0.9 - (0.9 - 0.55) * (i / 30) : 0.55 + (0.9 - 0.55) * ((i - 30) / 30);
      return { frameIndex: i, timestampMs: i * 33, x, y: 0.68, confidence: 0.9 };
    });
    const outcome = estimateContact({
      sequence,
      window: { startMs: 0, endMs: 1980, peakMotionMs: null },
      ballObservations: ball,
      paddleSpeeds: null,
      paddleCenters: null,
      targetWrists: sequence.frames.map((frame) => ({
        timestampMs: frame.timestampMs,
        x: 0.55,
        y: 0.68,
      })),
    });
    // Pre-fix: status "estimated", confidence 0.93, ballConfirmed true.
    if (outcome.status === "estimated") {
      expect(outcome.confidence).toBeLessThanOrEqual(0.55);
      expect(outcome.ballConfirmed).toBe(false);
    } else {
      expect(outcome.status).toBe("abstained");
    }
  });
});
