import { describe, expect, it } from "vitest";
import { assessPaddleTrackIdentity, IDENTITY } from "../src/index.js";

/**
 * Structural audit (pass 1) — paddle-track identity boundaries and numeric
 * hygiene (I11: never "foreign" when sparse / unmeasured / degenerate).
 */

const TORSO = 0.2;

function arcTrack(options: {
  fromMs: number;
  toMs: number;
  peakMs: number;
  base: { x: number; y: number };
  amplitude: number;
  stepMs?: number;
}) {
  const points: Array<{ timestampMs: number; x: number; y: number }> = [];
  for (let t = options.fromMs; t <= options.toMs; t += options.stepMs ?? 30) {
    const arc = Math.exp(-((t - options.peakMs) ** 2) / (2 * 100 * 100));
    points.push({
      timestampMs: t,
      x: options.base.x + options.amplitude * arc,
      y: options.base.y - 0.3 * options.amplitude * arc,
    });
  }
  return points;
}

/** The pinned foreign fixture from paddleTrackIdentity.test.ts. */
function foreignFixture() {
  const idleWrist = Array.from({ length: 70 }, (_, i) => ({
    timestampMs: i * 30,
    x: 0.35,
    y: 0.55,
  }));
  const swingingWrist = arcTrack({
    fromMs: 0,
    toMs: 2070,
    peakMs: 700,
    base: { x: 0.6, y: 0.6 },
    amplitude: 0.25,
  });
  const paddle = arcTrack({
    fromMs: 0,
    toMs: 2070,
    peakMs: 1600,
    base: { x: 0.3, y: 0.58 },
    amplitude: -0.12,
  });
  return { idleWrist, swingingWrist, paddle };
}

describe("audit: assessPaddleTrackIdentity — thresholds are the published constants", () => {
  it("pins the IDENTITY constants the verdict logic depends on", () => {
    expect(IDENTITY.maxStepMs).toBe(400);
    expect(IDENTITY.minSpeedSamples).toBe(5);
    expect(IDENTITY.synchronyMinPairs).toBe(8);
    expect(IDENTITY.synchronyConsistent).toBe(0.6);
    expect(IDENTITY.synchronyForeignCeiling).toBe(0.4);
    expect(IDENTITY.minPeakSeparationMs).toBe(250);
  });

  it("a step of exactly 400ms is NOT a fragment boundary; 401ms is", () => {
    const wrist = arcTrack({
      fromMs: 0,
      toMs: 2000,
      peakMs: 1000,
      base: { x: 0.5, y: 0.6 },
      amplitude: 0.2,
    });
    const exact = [
      { timestampMs: 0, x: 0.3, y: 0.5 },
      { timestampMs: 400, x: 0.31, y: 0.5 },
      { timestampMs: 800, x: 0.32, y: 0.5 },
      { timestampMs: 1200, x: 0.33, y: 0.5 },
      { timestampMs: 1600, x: 0.34, y: 0.5 },
      { timestampMs: 2000, x: 0.35, y: 0.5 },
    ];
    const a = assessPaddleTrackIdentity({
      paddleCenters: exact,
      targetWristTracks: [wrist],
      aspect: 1,
      torsoSpan: TORSO,
    });
    expect(a.evidence.paddleTrackGaps.count).toBe(0);
    expect(a.evidence.paddleSpeedSamples).toBe(5);
    const over = exact.map((point, index) => ({
      ...point,
      timestampMs: point.timestampMs + index,
    }));
    const b = assessPaddleTrackIdentity({
      paddleCenters: over,
      targetWristTracks: [wrist],
      aspect: 1,
      torsoSpan: TORSO,
    });
    expect(b.evidence.paddleTrackGaps.count).toBe(5);
    expect(b.verdict).toBe("undetermined");
  });

  it("exactly 5 paddle speed samples is measurable; 4 is not", () => {
    const wrist = arcTrack({
      fromMs: 0,
      toMs: 2000,
      peakMs: 1000,
      base: { x: 0.5, y: 0.6 },
      amplitude: 0.2,
    });
    const six = Array.from({ length: 6 }, (_, i) => ({
      timestampMs: i * 100,
      x: 0.3 + i * 0.01,
      y: 0.5,
    }));
    const a = assessPaddleTrackIdentity({
      paddleCenters: six,
      targetWristTracks: [wrist],
      aspect: 1,
      torsoSpan: TORSO,
    });
    expect(a.evidence.paddleSpeedSamples).toBe(5);
    expect(a.evidence.notes.some((n) => n.includes("paddle speed unmeasurable"))).toBe(false);
    const five = six.slice(0, 5);
    const b = assessPaddleTrackIdentity({
      paddleCenters: five,
      targetWristTracks: [wrist],
      aspect: 1,
      torsoSpan: TORSO,
    });
    expect(b.evidence.paddleSpeedSamples).toBe(4);
    expect(b.verdict).toBe("undetermined");
    expect(b.evidence.notes.some((n) => n.includes("paddle speed unmeasurable"))).toBe(true);
  });
});

describe("audit: assessPaddleTrackIdentity — input hygiene", () => {
  it("is independent of sample order (unsorted paddle and wrist tracks)", () => {
    const { idleWrist, swingingWrist, paddle } = foreignFixture();
    const sorted = assessPaddleTrackIdentity({
      paddleCenters: paddle,
      targetWristTracks: [swingingWrist, idleWrist],
      aspect: 1,
      torsoSpan: TORSO,
    });
    expect(sorted.verdict).toBe("foreign");
    const shuffled = assessPaddleTrackIdentity({
      paddleCenters: [...paddle].reverse(),
      targetWristTracks: [[...swingingWrist].reverse(), [...idleWrist].reverse()],
      aspect: 1,
      torsoSpan: TORSO,
    });
    expect(shuffled).toEqual(sorted);
  });

  it("duplicate timestamps do not create speed samples or change the verdict", () => {
    const { idleWrist, swingingWrist, paddle } = foreignFixture();
    const doubled = paddle.flatMap((point) => [point, { ...point }]);
    const a = assessPaddleTrackIdentity({
      paddleCenters: paddle,
      targetWristTracks: [swingingWrist, idleWrist],
      aspect: 1,
      torsoSpan: TORSO,
    });
    const b = assessPaddleTrackIdentity({
      paddleCenters: doubled,
      targetWristTracks: [swingingWrist, idleWrist],
      aspect: 1,
      torsoSpan: TORSO,
    });
    expect(b.evidence.paddleSpeedSamples).toBe(a.evidence.paddleSpeedSamples);
    expect(b.verdict).toBe(a.verdict);
  });

  it("NaN paddle centers never yield 'foreign' and never leak NaN into evidence numbers", () => {
    const { idleWrist, swingingWrist, paddle } = foreignFixture();
    const poisoned = paddle.map((point, index) =>
      index % 7 === 0 ? { ...point, x: Number.NaN } : point,
    );
    const a = assessPaddleTrackIdentity({
      paddleCenters: poisoned,
      targetWristTracks: [swingingWrist, idleWrist],
      aspect: 1,
      torsoSpan: TORSO,
    });
    expect(a.verdict).not.toBe("foreign");
    const numbers: Array<number | null> = [
      a.evidence.paddlePeak?.torsoPerSec ?? null,
      a.evidence.targetActivityAtPaddlePeak,
      a.evidence.paddleActivityAtTargetPeak,
      a.evidence.peakSeparationMs,
      a.evidence.targetSynchrony,
      a.evidence.otherSynchrony,
    ];
    for (const value of numbers) {
      if (value !== null) expect(Number.isFinite(value)).toBe(true);
    }
  });

  it("one NaN paddle sample is skipped, not allowed to erase synchrony or the paddle peak", () => {
    const wrist = arcTrack({
      fromMs: 0,
      toMs: 2000,
      peakMs: 1000,
      base: { x: 0.5, y: 0.6 },
      amplitude: 0.2,
    });
    const paddle = wrist.map((point) => ({ ...point, x: point.x + 0.05, y: point.y - 0.03 }));
    const clean = assessPaddleTrackIdentity({
      paddleCenters: paddle,
      targetWristTracks: [wrist],
      aspect: 1,
      torsoSpan: TORSO,
    });
    expect(clean.verdict).toBe("target_consistent");
    expect(clean.evidence.targetSynchrony).toBeGreaterThan(0.9);
    for (const index of [0, 30, paddle.length - 1]) {
      const poisoned = paddle.map((point, i) =>
        i === index ? { ...point, x: Number.NaN } : point,
      );
      const a = assessPaddleTrackIdentity({
        paddleCenters: poisoned,
        targetWristTracks: [wrist],
        aspect: 1,
        torsoSpan: TORSO,
      });
      expect(a.verdict, `NaN at index ${index}`).toBe("target_consistent");
      expect(a.evidence.targetSynchrony, `NaN at index ${index}`).not.toBeNull();
      expect(Number.isFinite(a.evidence.targetSynchrony!), `NaN at index ${index}`).toBe(true);
      expect(a.evidence.paddlePeak?.tMs, `NaN at index ${index}`).toBe(
        clean.evidence.paddlePeak?.tMs,
      );
    }
  });

  it("negative / NaN torso span is treated as unmeasured", () => {
    const { swingingWrist, paddle } = foreignFixture();
    for (const torsoSpan of [-0.2, Number.NaN]) {
      const a = assessPaddleTrackIdentity({
        paddleCenters: paddle,
        targetWristTracks: [swingingWrist],
        aspect: 1,
        torsoSpan,
      });
      expect(a.verdict).toBe("undetermined");
      expect(a.evidence.notes.some((n) => n.includes("torso span unmeasured"))).toBe(true);
    }
  });

  it("peak separation below 250ms never yields foreign (sweep of paddle peak times)", () => {
    const idleWrist = Array.from({ length: 70 }, (_, i) => ({
      timestampMs: i * 30,
      x: 0.35,
      y: 0.55,
    }));
    const target = arcTrack({
      fromMs: 0,
      toMs: 2070,
      peakMs: 700,
      base: { x: 0.6, y: 0.6 },
      amplitude: 0.25,
      stepMs: 10,
    });
    const run = (paddlePeakMs: number) =>
      assessPaddleTrackIdentity({
        paddleCenters: arcTrack({
          fromMs: 0,
          toMs: 2070,
          peakMs: paddlePeakMs,
          base: { x: 0.3, y: 0.58 },
          amplitude: -0.12,
          stepMs: 10,
        }),
        targetWristTracks: [target, idleWrist],
        aspect: 1,
        torsoSpan: TORSO,
      });
    let sawBelow = 0;
    let sawAtOrAbove = 0;
    for (let peakMs = 700; peakMs <= 1300; peakMs += 5) {
      const a = run(peakMs);
      const sep = a.evidence.peakSeparationMs;
      if (sep === null) continue;
      if (sep < IDENTITY.minPeakSeparationMs) {
        sawBelow += 1;
        expect(a.verdict, `paddle peak ${peakMs}ms sep ${sep}ms`).not.toBe("foreign");
      } else {
        sawAtOrAbove += 1;
      }
    }
    expect(sawBelow).toBeGreaterThan(0);
    expect(sawAtOrAbove).toBeGreaterThan(0);
  });
});
