import { describe, expect, it } from "vitest";
import { proposeStrokeEvents, proposeStrokeEventsV2 } from "../../src/strokeEvents.js";
import {
  proposeStrokeEvents as proposeStrokeEventsMirror,
  proposeStrokeEventsV2 as proposeStrokeEventsV2Mirror,
} from "../../../analysis-pipeline/src/sessionEngine.js";

/**
 * Adversarial follow-up to SL-07 (candidate e4e45826). The fix's stated
 * contract: "clipEndMs <= clipStartMs or non-finite bounds → typed
 * abstention; non-finite samples are dropped before gating; all emitted
 * fields finite and inside the clip. Same contract in both copies."
 *
 * The first two clauses hold (strokeEventsDegenerateInput.test.ts). These
 * cases probe the third clause on inputs the new `finiteSamples` /
 * `isUsableClip` guards let through: every sample finite and the clip
 * usable, yet the proposer emits events outside the clip or with non-finite
 * `peakSpeed` / `prominence` (3-sample smoothing overflows to Infinity).
 * Behaviour is identical at 4d812e1a — a pre-existing gap the fix did not
 * close, not a regression.
 */

type Sample = { timestampMs: number; value: number };

function bell(fps: number, durationMs: number, peakAtMs: number, amp: number): Sample[] {
  const n = Math.floor((durationMs / 1000) * fps);
  return Array.from({ length: n }, (_, index) => {
    const t = (index * 1000) / fps;
    const d = t - peakAtMs;
    return { timestampMs: t, value: 0.1 + amp * Math.exp(-(d * d) / (2 * 100 * 100)) };
  });
}

const proposers = [
  ["swing-lab proposeStrokeEvents", proposeStrokeEvents],
  ["swing-lab proposeStrokeEventsV2", proposeStrokeEventsV2],
  ["analysis-pipeline proposeStrokeEvents", proposeStrokeEventsMirror],
  ["analysis-pipeline proposeStrokeEventsV2", proposeStrokeEventsV2Mirror],
] as const;

describe("SL-07 residual: emitted fields inside the clip and finite", () => {
  for (const [label, propose] of proposers) {
    it(`${label}: samples entirely before the clip do not yield an event outside [clipStartMs, clipEndMs]`, () => {
      const result = propose({
        wristSpeeds: bell(30, 5000, 2500, 3),
        paddleSpeeds: null,
        clipStartMs: 10_000,
        clipEndMs: 12_000,
      });
      for (const event of result.events) {
        expect(event.startMs, `${label} startMs`).toBeGreaterThanOrEqual(10_000);
        expect(event.endMs, `${label} endMs`).toBeLessThanOrEqual(12_000);
      }
    });

    it(`${label}: finite samples whose 3-sample smoothing sum overflows never yield non-finite peakSpeed/prominence`, () => {
      const result = propose({
        wristSpeeds: bell(30, 5000, 2500, 3).map((sample) => ({
          ...sample,
          value: 8e307 + sample.value,
        })),
        paddleSpeeds: null,
        clipStartMs: 0,
        clipEndMs: 5000,
      });
      for (const event of result.events) {
        expect(Number.isFinite(event.peakSpeed), `${label} peakSpeed=${event.peakSpeed}`).toBe(
          true,
        );
        expect(Number.isFinite(event.prominence), `${label} prominence=${event.prominence}`).toBe(
          true,
        );
      }
    });
  }
});
