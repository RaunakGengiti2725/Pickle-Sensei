import { describe, expect, it } from "vitest";
import { SessionEventEngine, type SpeedSample } from "../src/sessionEngine.js";

/**
 * STRUCTURAL AUDIT #2 (pass 1) — SessionEventEngine reproducers.
 * Failing test = finding; passing test = verified invariant.
 */

function speedBumps(
  bumps: Array<{ peakMs: number; height: number; halfWidthMs: number }>,
  fromMs: number,
  toMs: number,
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

function threeStrokeStream(): SpeedSample[] {
  return speedBumps(
    [
      { peakMs: 1200, height: 2.0, halfWidthMs: 120 },
      { peakMs: 3600, height: 2.2, halfWidthMs: 120 },
      { peakMs: 6000, height: 1.8, halfWidthMs: 120 },
    ],
    0,
    8200,
  );
}

describe("AUDIT sessionEngine — sample intake honesty", () => {
  it("E2-A: non-finite samples are an input oddity and must be recorded (qualityState), not silently discarded", () => {
    const engine = new SessionEventEngine({ sessionId: "audit-nonfinite" });
    engine.push({ wrist: [{ timestampMs: 0, value: 0.1 }] });
    engine.push({ wrist: [{ timestampMs: 40, value: Number.NaN }] });
    engine.push({ wrist: [{ timestampMs: Number.POSITIVE_INFINITY, value: 0.1 }] });
    engine.push({ paddle: [{ timestampMs: 80, value: Number.NaN }] });
    engine.push({ wrist: [{ timestampMs: 120, value: 0.1 }] });
    const quality = engine.snapshot().qualityState;
    // Two wrist and one paddle sample were rejected. The contract says
    // "recorded oddities — never silent" (SessionQualityState.notes) and that
    // wristSamples counts everything received (kept + dropped).
    const accountedFor =
      quality.wristSamples === 4 || // dropped samples counted in the intake total
      quality.notes.some((note) => /non.?finite|NaN|invalid sample/i.test(note));
    expect(accountedFor).toBe(true);
  });

  it("E2-B: late wrist samples behind the frontier are dropped AND counted (verified invariant)", () => {
    const engine = new SessionEventEngine({ sessionId: "audit-late" });
    const closed = [];
    for (const sample of threeStrokeStream()) closed.push(...engine.push({ wrist: [sample] }));
    closed.push(...engine.flush());
    expect(closed.length).toBeGreaterThanOrEqual(2);
    const before = engine.snapshot();
    engine.push({ wrist: [{ timestampMs: 100, value: 5 }] });
    const after = engine.snapshot();
    expect(after.qualityState.droppedLateSamples).toBe(before.qualityState.droppedLateSamples + 1);
    expect(after.events.map((event) => event.proposal)).toEqual(
      before.events.map((event) => event.proposal),
    );
  });

  it("E2-E: late PADDLE samples behind the frontier are dropped and counted like wrist samples (frontier contract: 'late data behind the frontier could only rewrite closed events')", () => {
    const engine = new SessionEventEngine({ sessionId: "audit-late-paddle" });
    const closed = [];
    for (const sample of threeStrokeStream()) closed.push(...engine.push({ wrist: [sample] }));
    expect(closed.length).toBeGreaterThanOrEqual(1);
    const before = engine.snapshot();
    // A paddle burst placed inside the FIRST (already closed) event's window.
    const latePaddle: SpeedSample[] = [];
    for (let t = 1000; t <= 1400; t += 40) latePaddle.push({ timestampMs: t, value: 9 });
    engine.push({ paddle: latePaddle });
    const after = engine.snapshot();
    console.log(
      JSON.stringify({
        audit: "E2-E late paddle intake",
        frontierEventCount: before.events.length,
        droppedLateBefore: before.qualityState.droppedLateSamples,
        droppedLateAfter: after.qualityState.droppedLateSamples,
        notes: after.qualityState.notes,
      }),
    );
    expect(after.qualityState.droppedLateSamples).toBe(
      before.qualityState.droppedLateSamples + latePaddle.length,
    );
  });
});

describe("AUDIT sessionEngine — emitted proposal immutability", () => {
  it("E2-C: the emitted proposal is deeply immutable (every field is a primitive, so a shallow freeze is sufficient) — verified invariant", () => {
    const engine = new SessionEventEngine({ sessionId: "audit-freeze" });
    const closed = [];
    for (const sample of threeStrokeStream()) closed.push(...engine.push({ wrist: [sample] }));
    closed.push(...engine.flush());
    const event = closed[0]!;
    expect(Object.isFrozen(event.proposal)).toBe(true);
    for (const [key, value] of Object.entries(event.proposal)) {
      expect(
        value === null || typeof value !== "object",
        `proposal.${key} is a nested object — shallow freeze leaves it mutable`,
      ).toBe(true);
    }
    expect(() => {
      (event.proposal as { endMs: number }).endMs = 0;
    }).toThrow();
  });
});

describe("AUDIT sessionEngine — long-session cost", () => {
  it("E2-D: per-sample push() cost must stay bounded on a long live session (frame budget 33ms @ 30fps)", () => {
    // 30 fps live feed. Strokes every ~2.4 s (a rally cadence).
    const stepMs = 1000 / 30;
    const build = (durationMs: number): SpeedSample[] => {
      const bumps = [];
      for (let peak = 1200; peak < durationMs - 1500; peak += 2400) {
        bumps.push({ peakMs: peak, height: 2.0, halfWidthMs: 120 });
      }
      return speedBumps(bumps, 0, durationMs, stepMs);
    };
    const measure = (durationMs: number): { perPushMs: number; lastWindowMs: number } => {
      const stream = build(durationMs);
      const engine = new SessionEventEngine({ sessionId: `audit-perf-${durationMs}` });
      const started = performance.now();
      let lastWindowStart = started;
      for (let index = 0; index < stream.length; index += 1) {
        if (index === stream.length - 300) lastWindowStart = performance.now();
        engine.push({ wrist: [stream[index]!] });
      }
      const total = performance.now() - started;
      return {
        perPushMs: total / stream.length,
        lastWindowMs: (performance.now() - lastWindowStart) / 300,
      };
    };
    const oneMin = measure(60_000);
    const threeMin = measure(3 * 60_000);
    // Evidence table (Linux replay proxy — not Apple device truth).
    console.log(
      JSON.stringify({
        audit: "E2-D session engine push() cost",
        plane: "linux_replay_proxy",
        oneMinute: oneMin,
        threeMinute: threeMin,
        lastWindowRatio: threeMin.lastWindowMs / oneMin.lastWindowMs,
        frameBudgetMs: 33,
      }),
    );
    // A bounded-cost engine keeps the cost of the LAST 300 pushes roughly
    // constant as the session grows; an accumulate-everything engine grows it
    // ~linearly with session length (3x here).
    expect(threeMin.lastWindowMs / oneMin.lastWindowMs).toBeLessThan(2);
  });
});
