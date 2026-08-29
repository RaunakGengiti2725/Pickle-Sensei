import { describe, expect, it } from "vitest";
import type { PoseSequence } from "@pickle/swing-domain";
import { classifyStroke } from "../src/index.js";

/**
 * stroke-heuristic-4 gates: absence of measurement must never fire a
 * non-stroke gate, and unverifiable normalization/attribution must abstain.
 * Fixtures are hand-built minimal skeletons (shapes from the wave-a bench
 * failures that motivated each gate).
 */

const SHOULDER_Y = 0.4;
const HIP_Y = 0.6;

function frame(
  tMs: number,
  overrides: {
    hipY?: number;
    rightWrist?: { x: number; y: number; visibility: number } | null;
    leftWrist?: { x: number; y: number; visibility: number } | null;
  } = {},
) {
  const hipY = overrides.hipY ?? HIP_Y;
  const rightWrist =
    overrides.rightWrist === undefined
      ? { x: 0.85 + (tMs % 200) / 4000, y: 0.55, visibility: 0.9 }
      : overrides.rightWrist;
  const leftWrist =
    overrides.leftWrist === undefined ? { x: 0.6, y: 0.55, visibility: 0.8 } : overrides.leftWrist;
  const landmarks = [
    { name: "left_shoulder", x: 0.62, y: SHOULDER_Y, visibility: 0.9 },
    { name: "right_shoulder", x: 0.78, y: SHOULDER_Y, visibility: 0.9 },
    { name: "left_hip", x: 0.63, y: hipY, visibility: 0.9 },
    { name: "right_hip", x: 0.77, y: hipY, visibility: 0.9 },
    { name: "right_elbow", x: 0.82, y: 0.48, visibility: 0.9 },
    { name: "left_elbow", x: 0.61, y: 0.48, visibility: 0.8 },
  ];
  if (rightWrist) landmarks.push({ name: "right_wrist", ...rightWrist });
  if (leftWrist) landmarks.push({ name: "left_wrist", ...leftWrist });
  return { timestampMs: tMs, landmarks };
}

function toSequence(frames: ReturnType<typeof frame>[]): PoseSequence {
  return {
    fps: 30,
    frames: frames.map((f) => ({ timestampMs: f.timestampMs, landmarks: f.landmarks })),
  } as unknown as PoseSequence;
}

function classify(
  frames: ReturnType<typeof frame>[],
  overrides: Partial<Parameters<typeof classifyStroke>[0]> = {},
) {
  return classifyStroke({
    sequence: toSequence(frames),
    window: { startMs: 1700, endMs: 2300 },
    contactMs: 2000,
    handedness: "right",
    paddle: null,
    paddleSpeeds: null,
    wristSpeeds: null,
    ...overrides,
  });
}

function swingFrames(build: (tMs: number) => ReturnType<typeof frame> = (t) => frame(t)) {
  const frames: ReturnType<typeof frame>[] = [];
  for (let t = 1500; t <= 2500; t += 33) frames.push(build(t));
  return frames;
}

describe("v4 gate: speed window with zero measured samples never reads as non-swing", () => {
  it("a long series whose samples all fall OUTSIDE the window does not fire the energy gate", () => {
    // Series has >=5 samples (so the gate is armed) but none inside the window.
    const outside = Array.from({ length: 10 }, (_, i) => ({
      timestampMs: 5000 + i * 30,
      value: 0.01,
    }));
    const prediction = classify(swingFrames(), { wristSpeeds: outside });
    expect(prediction.limitingFactors).not.toContain("no_swing_energy_in_window");
  });

  it("a window with >=3 measured sub-floor samples still fires the gate", () => {
    const inWindow = Array.from({ length: 10 }, (_, i) => ({
      timestampMs: 1800 + i * 40,
      value: 0.05,
    }));
    const prediction = classify(swingFrames(), { wristSpeeds: inWindow });
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.limitingFactors).toContain("no_swing_energy_in_window");
  });

  it("1-2 in-window samples are recorded as sparse, not fired", () => {
    const sparse = [
      { timestampMs: 1990, value: 0.05 },
      { timestampMs: 2020, value: 0.05 },
      { timestampMs: 5000, value: 0.05 },
      { timestampMs: 5030, value: 0.05 },
      { timestampMs: 5060, value: 0.05 },
    ];
    const prediction = classify(swingFrames(), { wristSpeeds: sparse });
    expect(prediction.limitingFactors).not.toContain("no_swing_energy_in_window");
    expect(prediction.limitingFactors).toContain(
      "speed_window_sparsely_sampled_gate_not_applicable",
    );
  });
});

describe("v4 gate: transient torso collapse vs sequence median abstains", () => {
  it("a reference frame at <60% of the sequence median torso extent abstains", () => {
    // Torso 0.2 everywhere except near the reference, where it collapses to
    // 0.08 (40% of median) — above the absolute floor 0.04 but garbage.
    const frames = swingFrames((t) =>
      Math.abs(t - 2000) <= 40 ? frame(t, { hipY: SHOULDER_Y + 0.08 }) : frame(t),
    );
    const prediction = classify(frames);
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.limitingFactors).toContain("torso_extent_collapsed_vs_sequence_median");
  });

  it("a steady torso does not trip the relative gate", () => {
    const prediction = classify(swingFrames());
    expect(prediction.limitingFactors).not.toContain("torso_extent_collapsed_vs_sequence_median");
  });
});

describe("v4 gate: dominant-wrist attribution requires a measured rival wrist", () => {
  it("abstains when the rival wrist has zero measured frames near the reference", () => {
    const frames = swingFrames((t) =>
      frame(t, { leftWrist: { x: 0.6, y: 0.55, visibility: 0.1 } }),
    );
    const prediction = classify(frames);
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.limitingFactors).toContain(
      "dominant_wrist_attribution_unverifiable_rival_unmeasured",
    );
  });

  it("classifies normally when both wrists are measured", () => {
    const prediction = classify(swingFrames());
    expect(prediction.limitingFactors).not.toContain(
      "dominant_wrist_attribution_unverifiable_rival_unmeasured",
    );
    expect(prediction.label).toBe("FOREHAND");
  });
});
