import { describe, expect, it } from "vitest";
import type { PoseSequence } from "@pickle/swing-domain";
import { classifyStroke as classifyLab } from "../src/strokeHeuristic.js";
import { classifyStroke as classifyLite } from "@pickle/vision-geometry";

/**
 * G14-H6 regression pins (wave-g invariant/counterfactual robustness sweep,
 * datasets/experiments/wave-g/g14-h6-invariants-sweep.json).
 *
 * MEASURED FINDING (stroke-heuristic-6): 8 of 594 sweep evaluations flipped
 * a CONFIDENT committed label to a DIFFERENT confident label — the dangerous
 * case. All 8 shared one root cause: the dominant-wrist argmax over
 * comparative ±200ms travel crossed under σ=0.002–0.01u coordinate noise or
 * 10–15fps decimation on rows whose travel ratios were 1.16 and 1.27, and
 * because the two wrists sat on opposite sides of the torso midline, the
 * argmax swap mirrored the side call (FOREHAND(0.60)→BACKHAND(0.60),
 * FOREHAND(0.80)→BACKHAND(0.60)).
 *
 * stroke-heuristic-7 pins the invariant: a committed side must not be a
 * noise-decided coin flip. When both wrists are well measured, travels are
 * within DOMINANT_WRIST_NEAR_TIE_RATIO, AND the wrists sit on opposite
 * sides of the midline (the configuration where the argmax choice mirrors
 * the side), the classifier abstains. Controls below prove the gate does
 * not over-reach into clearly one-armed strokes or two-handed backhands
 * (same-side wrists — covered in strokeHeuristicAmbiguous.redteam.test.ts).
 */

const SHOULDER_Y = 0.4;
const HIP_Y = 0.6;

function nearTieFrame(tMs: number, leftTravelScale: number) {
  // Shoulders at x 0.62 / 0.78 → midline 0.70, shoulder width 0.16u.
  // Both wrists pump vertically: right at x 0.74 (right of midline), left
  // at x 0.66 (left of midline) — separation 0.08u = 0.5 shoulder-widths,
  // well under the bimanual gate's 0.9 wide-grip floor.
  const phase = Math.sin(((tMs - 1500) / 1000) * Math.PI * 2);
  return {
    timestampMs: tMs,
    landmarks: [
      { name: "left_shoulder", x: 0.62, y: SHOULDER_Y, visibility: 0.9 },
      { name: "right_shoulder", x: 0.78, y: SHOULDER_Y, visibility: 0.9 },
      { name: "left_hip", x: 0.63, y: HIP_Y, visibility: 0.9 },
      { name: "right_hip", x: 0.77, y: HIP_Y, visibility: 0.9 },
      { name: "right_elbow", x: 0.76, y: 0.5, visibility: 0.9 },
      { name: "left_elbow", x: 0.64, y: 0.5, visibility: 0.9 },
      { name: "right_wrist", x: 0.74, y: 0.6 + 0.08 * phase, visibility: 0.9 },
      { name: "left_wrist", x: 0.66, y: 0.6 - 0.08 * leftTravelScale * phase, visibility: 0.9 },
    ],
  };
}

function buildInput(leftTravelScale: number) {
  const frames = [] as ReturnType<typeof nearTieFrame>[];
  for (let t = 1500; t <= 2500; t += 33) frames.push(nearTieFrame(t, leftTravelScale));
  const sequence = { fps: 30, frames } as unknown as PoseSequence;
  return {
    sequence,
    window: { startMs: 1700, endMs: 2300 },
    contactMs: 2000,
    handedness: "right",
    paddle: null,
    paddleSpeeds: null,
    wristSpeeds: Array.from({ length: 20 }, (_, i) => ({
      timestampMs: 1700 + i * 30,
      value: 1.2,
    })),
  } as Parameters<typeof classifyLite>[0];
}

describe("G14-H6 pinned invariant: near-tie dominant wrist across the midline must abstain", () => {
  it("nearly-tied wrist travels on opposite sides of the midline abstain (the argmax — and the side call — is noise-decided)", () => {
    const prediction = classifyLab(buildInput(0.9) as Parameters<typeof classifyLab>[0]);
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.leaf).toBe("UNKNOWN");
    expect(prediction.limitingFactors).toContain(
      "dominant_wrist_near_tie_across_midline_side_attribution_unstable",
    );
  });

  it("the Lite copy abstains identically (full parity on the near-tie fixture)", () => {
    const input = buildInput(0.9);
    const lite = classifyLite(input);
    const lab = classifyLab(input as Parameters<typeof classifyLab>[0]);
    expect(lite).toEqual(lab);
    expect(lite.limitingFactors).toContain(
      "dominant_wrist_near_tie_across_midline_side_attribution_unstable",
    );
  });

  it("control: a clearly one-armed swing (rival travel far below the tie band) still commits", () => {
    // Same geometry, left wrist near-still (travel ratio ≈ 5 — far above
    // the 1.35 tie floor). The gate must not fire; the stroke commits on
    // the right wrist, right of the midline, under a right-handed
    // declaration → FOREHAND.
    const input = buildInput(0.2);
    const lite = classifyLite(input);
    const lab = classifyLab(input as Parameters<typeof classifyLab>[0]);
    expect(lite).toEqual(lab);
    expect(lab.label).toBe("FOREHAND");
    expect(lab.limitingFactors).not.toContain(
      "dominant_wrist_near_tie_across_midline_side_attribution_unstable",
    );
  });
});
