import { describe, expect, it } from "vitest";
import { SessionEventEngine, type SpeedSample } from "../src/sessionEngine.js";

/**
 * STRUCTURAL AUDIT #1 (pass 1/3) — SessionEventEngine hardening probes.
 *
 * Each test encodes an EXPECTED invariant for the live-session engine. A
 * failing test here is a reproduced structural finding at the audited
 * commit, not a regression in production code: production code is untouched.
 */

function speedBumps(
  bumps: Array<{ peakMs: number; height: number; halfWidthMs: number }>,
  fromMs = 0,
  toMs = 8000,
  stepMs = 40,
): SpeedSample[] {
  const series: SpeedSample[] = [];
  for (let t = fromMs; t <= toMs; t += stepMs) {
    let value = 0.08;
    for (const bump of bumps) {
      value += bump.height * Math.exp(-0.5 * ((t - bump.peakMs) / bump.halfWidthMs) ** 2);
    }
    series.push({ timestampMs: t, value });
  }
  return series;
}

describe("audit: input-loss observability", () => {
  it("non-finite wrist samples are dropped AND accounted for (count or note), never silently", () => {
    const engine = new SessionEventEngine({ sessionId: "audit-nonfinite" });
    engine.push({ wrist: [{ timestampMs: 100, value: 0.1 }] });
    engine.push({ wrist: [{ timestampMs: 140, value: Number.NaN }] });
    engine.push({ wrist: [{ timestampMs: Number.POSITIVE_INFINITY, value: 0.1 }] });
    engine.push({ paddle: [{ timestampMs: 180, value: Number.NEGATIVE_INFINITY }] });
    const quality = engine.snapshot().qualityState;
    // Three samples were fed and discarded; the session must surface that.
    const accounted =
      quality.droppedLateSamples > 0 ||
      quality.notes.some((note) => /finite|NaN|invalid|discard|drop/i.test(note)) ||
      quality.wristSamples >= 3;
    expect(accounted).toBe(true);
  });

  it("late PADDLE samples at/behind the frontier are refused like late wrist samples", () => {
    const engine = new SessionEventEngine({ sessionId: "audit-late-paddle" });
    const stream = speedBumps([{ peakMs: 1500, height: 2.0, halfWidthMs: 120 }], 0, 5000);
    let closed = 0;
    for (const sample of stream) closed += engine.pushWristSample(sample).length;
    expect(closed).toBe(1); // frontier advanced past E1
    const before = engine.snapshot().qualityState;

    // A wrist sample behind the frontier: dropped and counted (existing contract).
    engine.push({ wrist: [{ timestampMs: 100, value: 0.5 }] });
    const afterWrist = engine.snapshot().qualityState;
    expect(afterWrist.droppedLateSamples).toBe(before.droppedLateSamples + 1);

    // A paddle sample at the SAME stale timestamp must not be admitted either:
    // it lands inside an already-closed, frozen event's window and can only
    // influence future proposals through history it should not be part of.
    engine.push({ paddle: [{ timestampMs: 100, value: 3.0 }] });
    const afterPaddle = engine.snapshot().qualityState;
    expect(afterPaddle.paddleSamples).toBe(before.paddleSamples);
    expect(afterPaddle.droppedLateSamples).toBe(afterWrist.droppedLateSamples + 1);
  });
});

describe("audit: proposal immutability", () => {
  it("closed-event proposals are deeply immutable (freeze is sufficient for the flat shape)", () => {
    const engine = new SessionEventEngine({ sessionId: "audit-freeze" });
    const emitted = speedBumps([{ peakMs: 1500, height: 2.0, halfWidthMs: 120 }], 0, 5000).flatMap(
      (sample) => engine.pushWristSample(sample),
    );
    expect(emitted).toHaveLength(1);
    const proposal = emitted[0]!.proposal;
    expect(Object.isFrozen(proposal)).toBe(true);
    // Every field is a primitive → shallow freeze IS deep freeze here.
    for (const value of Object.values(proposal)) {
      expect(value === null || typeof value !== "object").toBe(true);
    }
  });
});

describe("audit: per-push cost over a long live session", () => {
  it("per-sample push cost stays bounded as the session grows (no O(history) re-proposal)", () => {
    const engine = new SessionEventEngine({ sessionId: "audit-long-session" });
    const stepMs = 40; // 25 Hz wrist-speed stream
    let t = 0;
    const push = (n: number): number => {
      const started = performance.now();
      for (let i = 0; i < n; i++) {
        t += stepMs;
        // one clear stroke every 3 s, idle baseline otherwise
        const phase = (t % 3000) / 3000;
        const value =
          0.08 +
          (phase > 0.4 && phase < 0.6 ? 2.0 * Math.exp(-0.5 * ((phase - 0.5) / 0.04) ** 2) : 0);
        engine.pushWristSample({ timestampMs: t, value });
      }
      return (performance.now() - started) / n;
    };
    // warm-up + first window (≈40 s of play), then a later window of the
    // same size after ≈3.7 min of accumulated history.
    push(500);
    const early = push(1000);
    push(3000);
    const late = push(1000);
    const ratio = late / early;
    console.log(
      `[audit] per-push cost early=${early.toFixed(4)}ms late=${late.toFixed(4)}ms ratio=${ratio.toFixed(1)} samples=${engine.snapshot().qualityState.wristSamples} events=${engine.snapshot().events.length}`,
    );
    // Bounded work per push tolerates noise but not history-proportional growth.
    expect(ratio).toBeLessThan(3);
  }, 120_000);
});
