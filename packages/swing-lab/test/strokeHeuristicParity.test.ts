import { describe, expect, it } from "vitest";
import type { PoseSequence } from "@pickle/swing-domain";
import { generateSwingSequence } from "@pickle/evaluation";
import { classifyStroke as classifyLab } from "../src/strokeHeuristic.js";
import { classifyStroke as classifyLite } from "@pickle/vision-geometry";

/**
 * PARITY LOCK (D-036): packages/swing-lab/src/strokeHeuristic.ts and the
 * mobile port packages/vision-geometry/src/strokeHeuristicLite.ts must stay
 * byte-equivalent in semantics until the planned dedup lands. Every fixture
 * below runs through BOTH implementations and asserts the full prediction
 * objects (label, leaf, depth, confidence, evidence strings, limiting
 * factors, provenance fields) are deeply identical, so any one-sided change
 * fails CI.
 *
 * Fixtures deliberately route through every decision branch the heuristics
 * share: contact-point provenance (paddle plausible / implausible /
 * low-confidence / wrist fallback), the OVERHEAD corroboration matrix, the
 * v3 non-stroke gates, and the v4 absence-of-measurement gates
 * (in-window speed sample floor, median torso collapse, rival-wrist
 * attribution).
 */

const SHOULDER_Y = 0.4;
const HIP_Y = 0.6;

interface WristOverride {
  x: number;
  y: number;
  visibility: number;
}

function frame(
  tMs: number,
  overrides: {
    hipY?: number;
    rightWrist?: WristOverride | null;
    leftWrist?: WristOverride | null;
    rightElbowY?: number;
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
    { name: "right_elbow", x: 0.82, y: overrides.rightElbowY ?? 0.48, visibility: 0.9 },
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

function swingFrames(build: (tMs: number) => ReturnType<typeof frame> = (t) => frame(t)) {
  const frames: ReturnType<typeof frame>[] = [];
  for (let t = 1500; t <= 2500; t += 33) frames.push(build(t));
  return frames;
}

type SharedInput = Parameters<typeof classifyLite>[0];

function expectParity(input: SharedInput) {
  const lite = classifyLite(input);
  const lab = classifyLab(input as Parameters<typeof classifyLab>[0]);
  expect(lite).toEqual(lab);
  return lite;
}

function baseInput(frames: ReturnType<typeof frame>[], overrides: Partial<SharedInput> = {}) {
  return {
    sequence: toSequence(frames),
    window: { startMs: 1700, endMs: 2300 },
    contactMs: 2000,
    handedness: "right",
    paddle: null,
    paddleSpeeds: null,
    wristSpeeds: null,
    ...overrides,
  } as SharedInput;
}

function speedSeries(startMs: number, count: number, value: number) {
  return Array.from({ length: count }, (_, i) => ({ timestampMs: startMs + i * 30, value }));
}

function paddleAt(x: number, y: number, contactMs: number, confidence: number) {
  return Array.from({ length: 11 }, (_, index) => ({
    timestampMs: contactMs - 200 + index * 40,
    center: { x, y },
    confidence,
  }));
}

describe("strokeHeuristic ↔ strokeHeuristicLite parity (identical fixtures, identical outputs)", () => {
  it("committed side call on the shared synthetic swing (paddle + speeds)", () => {
    const { sequence, window } = generateSwingSequence();
    const prediction = expectParity({
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs },
      contactMs: window.peakMs,
      handedness: "right",
      paddle: paddleAt(0.8, 0.55, window.peakMs, 0.9),
      paddleSpeeds: speedSeries(window.peakMs - 300, 20, 1.8),
      wristSpeeds: null,
    });
    expect(["FOREHAND", "BACKHAND"]).toContain(prediction.label);
    expect(prediction.taxonomyDepth).toBe(2);
  });

  it("wrist fallback when no paddle is tracked (mobile reality) + event-peak reference", () => {
    const { sequence, window } = generateSwingSequence();
    const prediction = expectParity(
      baseInput([], {
        sequence,
        window: { startMs: window.startMs, endMs: window.endMs },
        contactMs: null,
        eventPeakMs: window.peakMs,
      }),
    );
    expect(prediction.limitingFactors).toContain("reference_is_event_peak_not_contact");
    expect(prediction.limitingFactors).toContain("paddle_not_tracked_at_contact");
  });

  it("no reference at all", () => {
    expectParity(baseInput(swingFrames(), { contactMs: null, eventPeakMs: null }));
  });

  it("no pose frame near contact", () => {
    const prediction = expectParity(baseInput(swingFrames(), { contactMs: 9000 }));
    expect(prediction.limitingFactors).toContain("no_pose_frame_near_contact");
  });

  it("degenerate torso extent abstains identically", () => {
    const frames = swingFrames((t) => frame(t, { hipY: SHOULDER_Y + 0.01 }));
    const prediction = expectParity(baseInput(frames));
    expect(prediction.limitingFactors).toContain(
      "torso_extent_degenerate_normalization_unreliable",
    );
  });

  it("v4: transient torso collapse vs sequence median abstains identically", () => {
    const frames = swingFrames((t) =>
      t === 1995 ? frame(t, { hipY: SHOULDER_Y + 0.08 }) : frame(t),
    );
    // Reference frame torso 0.08 vs sequence median 0.2 → below 0.6× median.
    const prediction = expectParity(baseInput(frames, { contactMs: 1995 }));
    expect(prediction.limitingFactors).toContain("torso_extent_collapsed_vs_sequence_median");
  });

  it("v4: rival wrist never measured abstains identically", () => {
    const frames = swingFrames((t) => frame(t, { leftWrist: null }));
    const prediction = expectParity(baseInput(frames));
    expect(prediction.limitingFactors).toContain(
      "dominant_wrist_attribution_unverifiable_rival_unmeasured",
    );
  });

  it("v3: measured no-swing-energy window abstains identically", () => {
    const prediction = expectParity(
      baseInput(swingFrames(), { wristSpeeds: speedSeries(1700, 10, 0.05) }),
    );
    expect(prediction.limitingFactors).toContain("no_swing_energy_in_window");
  });

  it("v4: an empty in-window slice of a long speed series never fires the energy gate", () => {
    const prediction = expectParity(
      baseInput(swingFrames(), { wristSpeeds: speedSeries(5000, 10, 0.01) }),
    );
    expect(prediction.limitingFactors).not.toContain("no_swing_energy_in_window");
  });

  it("v4: a sparsely sampled window (< 3 samples) records the limiting factor, gate held", () => {
    const prediction = expectParity(
      baseInput(swingFrames(), {
        wristSpeeds: [...speedSeries(5000, 8, 0.01), ...speedSeries(2000, 2, 0.05)],
      }),
    );
    expect(prediction.limitingFactors).toContain(
      "speed_window_sparsely_sampled_gate_not_applicable",
    );
    expect(prediction.limitingFactors).not.toContain("no_swing_energy_in_window");
  });

  it("v3: measured stillness (no wrist travel) abstains identically", () => {
    const frames = swingFrames((t) =>
      frame(t, { rightWrist: { x: 0.85, y: 0.55, visibility: 0.9 } }),
    );
    const prediction = expectParity(baseInput(frames));
    expect(prediction.limitingFactors).toContain("no_swing_motion_near_reference");
  });

  it("paddle within reach with strong confidence commits identically", () => {
    const prediction = expectParity(
      baseInput(swingFrames(), {
        paddle: paddleAt(0.9, 0.55, 2000, 0.8),
        paddleSpeeds: speedSeries(1700, 20, 1.8),
      }),
    );
    expect(prediction.contactPointSource).toBe("paddle");
    expect(prediction.contactPointReliability).toBe("strong");
  });

  it("low-confidence paddle degrades provenance identically (abstention band)", () => {
    expectParity(
      baseInput(swingFrames(), {
        paddle: paddleAt(0.9, 0.55, 2000, 0.1),
        paddleSpeeds: speedSeries(1700, 20, 1.8),
      }),
    );
  });

  it("implausibly distant paddle falls back to the wrist identically", () => {
    const prediction = expectParity(
      baseInput(swingFrames(), {
        paddle: paddleAt(0.1, 0.1, 2000, 0.9),
        paddleSpeeds: speedSeries(1700, 20, 1.8),
      }),
    );
    expect(prediction.limitingFactors).toContain("paddle_point_implausible_used_wrist");
  });

  it("OVERHEAD with point + skeletal corroboration agrees identically", () => {
    const frames = swingFrames((t) =>
      Math.abs(t - 2000) <= 150
        ? frame(t, {
            rightWrist: { x: 0.85 + (t % 200) / 4000, y: SHOULDER_Y - 0.12, visibility: 0.9 },
            rightElbowY: SHOULDER_Y - 0.05,
          })
        : frame(t),
    );
    const prediction = expectParity(
      baseInput(frames, { paddle: paddleAt(0.86, SHOULDER_Y - 0.14, 2000, 0.9) }),
    );
    expect(prediction.label).toBe("OVERHEAD");
  });

  it("high paddle point beyond reach with a quiet skeleton refuses OVERHEAD identically", () => {
    const prediction = expectParity(
      baseInput(swingFrames(), { paddle: paddleAt(0.86, SHOULDER_Y - 0.14, 2000, 0.9) }),
    );
    expect(prediction.limitingFactors).toContain("paddle_point_implausible_used_wrist");
    expect(prediction.label).not.toBe("OVERHEAD");
  });

  it("ambidextrous declaration abstains identically", () => {
    expectParity(
      baseInput(swingFrames(), {
        handedness: "ambidextrous",
        paddleSpeeds: speedSeries(1700, 20, 1.8),
      }),
    );
  });

  it("left-handed side attribution matches identically", () => {
    expectParity(
      baseInput(swingFrames(), {
        handedness: "left",
        paddleSpeeds: speedSeries(1700, 20, 1.8),
      }),
    );
  });

  it("classifier version strings are identical", () => {
    const lite = classifyLite(baseInput(swingFrames()));
    const lab = classifyLab(baseInput(swingFrames()) as Parameters<typeof classifyLab>[0]);
    expect(lite.classifierVersion).toBe(lab.classifierVersion);
    expect(lite.classifierVersion).toContain("stroke-heuristic-4");
  });
});
