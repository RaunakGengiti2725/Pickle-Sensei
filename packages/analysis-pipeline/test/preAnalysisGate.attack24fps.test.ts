// xc-matrix::XC-ADJ-VIS-1 — adversarial pin (attack branch devin/attack-fix-322511d1).
//
// The candidate makes the phone scoring path consult evaluatePreAnalysisGate,
// which now lifts every evaluateCaptureQuality reason — including
// `insufficient_fps` (effective pose FPS < 24). The capture envelope
// (packages/capture-envelope/src/thresholds.ts `frame_rate.supported.min = 24`)
// declares a 24 fps clip SUPPORTED, and a 24 fps clip is exactly what an
// imported iPhone 4K/24 recording is.
//
// Sidecar timestamps are integer milliseconds (native import path:
// `Int(elapsedMs.rounded())`; the synthetic generator: `Math.round(tMs)`). At
// 24 fps the ideal spacing is 41.666… ms, so the LAST timestamp rounds up for
// every frame count with (n − 1) ≡ 1 (mod 3) and the measured effective FPS
// becomes 23.996 < 24. A pristine, fully visible, zero-dropout 24 fps swing is
// therefore refused as `insufficient_fps` — and on the phone path the user is
// told "the player was not tracked well enough through the stroke ... Nothing
// was rated" — for one third of all clip lengths, and for EVERY clip length
// once a single pose frame is missing. Baseline 4d812e1a scored these clips.
//
// Run (repo root):
//   cd packages/analysis-pipeline && npx vitest run test/preAnalysisGate.attack24fps.test.ts

import { describe, expect, it } from "vitest";
import { generateSwingSequence } from "@pickle/evaluation";
import { evaluateCaptureQuality } from "@pickle/vision-geometry";
import { evaluatePreAnalysisGate } from "../src/index.js";

describe("pre-analysis gate × 24 fps (envelope-supported) footage", () => {
  it("a pristine 24 fps swing is analyzable at every clip length", () => {
    const refused: string[] = [];
    // Sweep the recover phase so the frame count walks through every residue
    // of (n − 1) mod 3; every frame is full-body at visibility 0.95, no gaps.
    for (let recoverMs = 500; recoverMs <= 700; recoverMs += 10) {
      const { sequence } = generateSwingSequence({ fps: 24, recoverMs });
      const decision = evaluatePreAnalysisGate({
        frame: null,
        pose: sequence,
        poseQuality: evaluateCaptureQuality(sequence),
      });
      if (!decision.analyzable) {
        const n = sequence.frames.length;
        const durationMs =
          (sequence.frames[n - 1]?.timestampMs ?? 0) - (sequence.frames[0]?.timestampMs ?? 0);
        refused.push(
          `recoverMs=${recoverMs} frames=${n} durationMs=${durationMs} ` +
            `effectiveFps=${(((n - 1) * 1000) / durationMs).toFixed(3)} ` +
            `reasons=${decision.reasons.join(",")}`,
        );
      }
    }
    expect(
      refused,
      `${refused.length} pristine 24 fps clip length(s) refused:\n${refused.join("\n")}`,
    ).toEqual([]);
  });

  it("a 24 fps swing with ONE dropped pose frame is still analyzable", () => {
    const { sequence } = generateSwingSequence({ fps: 24, recoverMs: 600 });
    // Remove a single mid-clip frame (an ordinary Vision miss): the 83 ms hole
    // is far below every dropout threshold (tracking_dropout_gap 700 ms,
    // torso anchor 120 ms).
    const frames = sequence.frames.filter((_, index) => index !== 10);
    const dropped = { ...sequence, frames };
    const decision = evaluatePreAnalysisGate({
      frame: null,
      pose: dropped,
      poseQuality: evaluateCaptureQuality(dropped),
    });
    expect(decision.reasons).toEqual([]);
    expect(decision.analyzable).toBe(true);
  });
});
