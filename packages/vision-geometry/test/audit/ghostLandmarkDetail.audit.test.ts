import { describe, expect, it } from "vitest";
import { generateSwingSequence } from "@pickle/evaluation";
import type { BallObservation } from "@pickle/swing-domain";
import { classifyStroke, estimateContact } from "../../src/index.js";
import { dropLandmark, ghostLandmark } from "./support.js";

/**
 * AUDIT EVIDENCE PRINTER — companion to ghostLandmark.audit.test.ts. Always
 * passes; it only prints the quantitative delta (confidence, moment, signals)
 * between a zero-visibility landmark and an absent landmark so the finding
 * carries numbers. Run with `--reporter=verbose` to see the console output.
 */

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

describe("AUDIT evidence detail: ghost landmark deltas", () => {
  it("prints estimateContact ghost-vs-absent deltas", () => {
    const { sequence, window } = generateSwingSequence();
    const windowArg = {
      startMs: window.startMs,
      endMs: window.endMs,
      peakMotionMs: window.peakMs,
    };
    const ball = farBall(window.peakMs);
    const turn = ball[4]!;
    const near = (t: number) => Math.abs(t - turn.timestampMs) <= 80;
    const ghost = estimateContact({
      sequence: ghostLandmark(sequence, "left_wrist", near, { x: turn.x, y: turn.y }),
      window: windowArg,
      ballObservations: ball,
    });
    const absent = estimateContact({
      sequence: dropLandmark(sequence, "left_wrist", near),
      window: windowArg,
      ballObservations: ball,
    });
    const summarize = (label: string, estimate: typeof ghost) => {
      if (estimate.status !== "estimated") {
        console.log(`[audit] ${label}: ${estimate.status} ${estimate.reason}`);
        return;
      }
      console.log(
        `[audit] ${label}: t=${estimate.estimatedContactMs}ms conf=${estimate.confidence.toFixed(3)} ` +
          `ballConfirmed=${estimate.ballConfirmed} signals=${JSON.stringify(
            estimate.supportingEvidence.map((s) => `${s.signal}:${s.detail}`),
          )} limiting=${JSON.stringify(estimate.limitingFactors)}`,
      );
    };
    summarize("ghost-wrist(vis=0 at turn)", ghost);
    summarize("absent-wrist", absent);
    console.log(`[audit] true swing peak = ${window.peakMs}ms, ball turn @ ${turn.timestampMs}ms`);
    expect(true).toBe(true);
  });

  it("prints classifyStroke ghost-hip vs absent-hip predictions", () => {
    const { sequence, window } = generateSwingSequence();
    const ref = sequence.frames.reduce((best, frame) =>
      Math.abs(frame.timestampMs - window.peakMs) < Math.abs(best.timestampMs - window.peakMs)
        ? frame
        : best,
    );
    const only = (t: number) => t === ref.timestampMs;
    const input = (seq: typeof sequence) => ({
      sequence: seq,
      window: { startMs: window.startMs, endMs: window.endMs },
      contactMs: null,
      eventPeakMs: window.peakMs,
      handedness: "right" as const,
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    const ghost = classifyStroke(input(ghostLandmark(sequence, "left_hip", only)));
    const absent = classifyStroke(input(dropLandmark(sequence, "left_hip", only)));
    const clean = classifyStroke(input(sequence));
    for (const [label, p] of [
      ["clean", clean],
      ["ghost-hip(vis=0 at (0,1))", ghost],
      ["absent-hip", absent],
    ] as const) {
      console.log(
        `[audit] ${label}: label=${p.label} depth=${p.taxonomyDepth} conf=${p.confidence.toFixed(3)} ` +
          `limiting=${JSON.stringify(p.limitingFactors)} evidence=${JSON.stringify(p.evidence)}`,
      );
    }
    expect(true).toBe(true);
  });
});
