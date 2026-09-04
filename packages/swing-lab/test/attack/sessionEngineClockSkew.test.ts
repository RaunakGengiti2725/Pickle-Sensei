import { describe, expect, it } from "vitest";
import {
  SessionEventEngine,
  type SessionStrokeEvent,
  type SpeedSample,
} from "../../src/sessionEngine.js";

/**
 * Adversarial pass 3 (tester #4) — S8: a live wrist-speed stream whose clock
 * steps BACKWARDS by exactly 1 ms once (and variants: repeated, at a stroke
 * peak, behind an already-closed event, duplicate timestamps). Contract:
 * every emitted event has startMs <= peakMs <= endMs, event ids are unique,
 * events never overlap, and nothing is emitted twice.
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

function stream(engine: SessionEventEngine, series: readonly SpeedSample[]): SessionStrokeEvent[] {
  const emitted: SessionStrokeEvent[] = [];
  for (const sample of series) emitted.push(...engine.pushWristSample(sample));
  return emitted;
}

function assertWellFormed(events: readonly SessionStrokeEvent[], label: string): void {
  const ids = events.map((e) => e.eventId);
  expect(new Set(ids).size, `${label}: duplicate eventIds ${JSON.stringify(ids)}`).toBe(ids.length);
  const peaks = events.map((e) => Math.round(e.proposal.peakMs));
  expect(new Set(peaks).size, `${label}: duplicate peaks ${JSON.stringify(peaks)}`).toBe(
    peaks.length,
  );
  let previousEnd = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    const { startMs, peakMs, endMs } = event.proposal;
    expect(Number.isFinite(startMs) && Number.isFinite(endMs), `${label} ${event.eventId}`).toBe(
      true,
    );
    expect(endMs, `${label} ${event.eventId}: endMs < startMs`).toBeGreaterThanOrEqual(startMs);
    expect(peakMs, `${label} ${event.eventId}`).toBeGreaterThanOrEqual(startMs);
    expect(peakMs, `${label} ${event.eventId}`).toBeLessThanOrEqual(endMs);
    expect(startMs, `${label} ${event.eventId}: overlaps previous`).toBeGreaterThan(previousEnd);
    previousEnd = endMs;
  }
}

/** Replace sample[at].timestampMs with sample[at-1].timestampMs - 1. */
function stepBackOnce(series: readonly SpeedSample[], at: number): SpeedSample[] {
  const out = series.map((s) => ({ ...s }));
  out[at] = { ...out[at]!, timestampMs: out[at - 1]!.timestampMs - 1 };
  return out;
}

const TWO_STROKES = speedBumps(
  [
    { peakMs: 1200, height: 2.0, halfWidthMs: 120 },
    { peakMs: 3500, height: 2.0, halfWidthMs: 120 },
  ],
  0,
  6000,
);

describe("S8 — SessionEventEngine under a 1 ms backwards clock step", () => {
  const cleanEngine = new SessionEventEngine({ sessionId: "s8-clean" });
  const clean = [...stream(cleanEngine, TWO_STROKES), ...cleanEngine.flush()];

  it("control: the clean stream yields two well-formed events", () => {
    assertWellFormed(clean, "clean");
    expect(clean.map((e) => e.eventId)).toEqual(["E1", "E2"]);
  });

  it("one backwards step in the idle gap → same two events, none malformed, none duplicated", () => {
    const at = TWO_STROKES.findIndex((s) => s.timestampMs === 2400); // idle gap, after E1 closes
    const skewed = stepBackOnce(TWO_STROKES, at);
    expect(skewed[at]!.timestampMs).toBe(2359);
    const engine = new SessionEventEngine({ sessionId: "s8-gap" });
    const live = stream(engine, skewed);
    const all = [...live, ...engine.flush()];
    assertWellFormed(all, "gap-skew");
    expect(all.map((e) => e.eventId)).toEqual(["E1", "E2"]);
    expect(all.map((e) => Math.round(e.proposal.peakMs))).toEqual(
      clean.map((e) => Math.round(e.proposal.peakMs)),
    );
  });

  it("one backwards step exactly at a stroke peak → still one event per stroke", () => {
    const at = TWO_STROKES.findIndex((s) => s.timestampMs === 1200);
    const skewed = stepBackOnce(TWO_STROKES, at);
    const engine = new SessionEventEngine({ sessionId: "s8-peak" });
    const all = [...stream(engine, skewed), ...engine.flush()];
    assertWellFormed(all, "peak-skew");
    expect(all).toHaveLength(2);
  });

  it("backwards step landing BEHIND the closed frontier is dropped (counted), never re-emits E1", () => {
    // Stream up to a point where E1 is closed, then push a sample 1ms behind
    // the last one that also sits inside E1's span.
    const engine = new SessionEventEngine({ sessionId: "s8-behind" });
    const firstClose = TWO_STROKES.findIndex((s) => s.timestampMs >= 1200 + 1200 + 40);
    const head = TWO_STROKES.slice(0, firstClose + 1);
    const live = stream(engine, head);
    expect(
      live.map((e) => e.eventId),
      "E1 must have closed",
    ).toEqual(["E1"]);
    const e1 = live[0]!;
    // 1ms behind the previous sample, and (for the strong variant) a sample
    // inside E1's own span with a huge value — it must not rewrite E1.
    const behind = { timestampMs: head[head.length - 1]!.timestampMs - 1, value: 0.08 };
    const insideE1 = { timestampMs: e1.proposal.peakMs, value: 9.9 };
    const emittedLate = [...engine.pushWristSample(behind), ...engine.pushWristSample(insideE1)];
    const rest = stream(engine, TWO_STROKES.slice(firstClose + 1));
    const all = [...live, ...emittedLate, ...rest, ...engine.flush()];
    assertWellFormed(all, "behind-frontier");
    expect(all.map((e) => e.eventId)).toEqual(["E1", "E2"]);
    expect(all[0]!.proposal.peakSpeed).toBe(e1.proposal.peakSpeed);
    expect(engine.snapshot().qualityState.droppedLateSamples).toBeGreaterThanOrEqual(1);
    expect(Object.isFrozen(all[0]!.proposal)).toBe(true);
  });

  it("duplicate timestamps (same ms twice) do not duplicate events", () => {
    const at = TWO_STROKES.findIndex((s) => s.timestampMs === 1240);
    const dup = TWO_STROKES.map((s) => ({ ...s }));
    dup[at] = { ...dup[at]!, timestampMs: dup[at - 1]!.timestampMs };
    const engine = new SessionEventEngine({ sessionId: "s8-dup" });
    const all = [...stream(engine, dup), ...engine.flush()];
    assertWellFormed(all, "dup-ts");
    expect(all).toHaveLength(2);
  });

  it("seeded fuzz (LCG seeds 1..150): a single -1ms step anywhere never breaks bounds/uniqueness", () => {
    for (let seed = 1; seed <= 150; seed += 1) {
      let state = (seed * 2654435761) >>> 0;
      const rand = () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x1_0000_0000;
      };
      const at = 1 + Math.floor(rand() * (TWO_STROKES.length - 1));
      const skewed = stepBackOnce(TWO_STROKES, at);
      const engine = new SessionEventEngine({ sessionId: `s8-fuzz-${seed}` });
      const all = [...stream(engine, skewed), ...engine.flush()];
      assertWellFormed(all, `seed ${seed} (step at index ${at})`);
      expect(all.length, `seed ${seed}: event count`).toBe(2);
    }
  });

  it("every-other-sample jitter (-1ms, +81ms, ...) never emits malformed or duplicate events", () => {
    const jittered = TWO_STROKES.map((s, i) => ({
      ...s,
      timestampMs: i % 2 === 1 ? s.timestampMs - 41 : s.timestampMs,
    }));
    const engine = new SessionEventEngine({ sessionId: "s8-jitter" });
    const all = [...stream(engine, jittered), ...engine.flush()];
    assertWellFormed(all, "jitter");
    const snapshotIds = engine.snapshot().events.map((e) => e.eventId);
    expect(new Set(snapshotIds).size).toBe(snapshotIds.length);
  });

  it("non-finite timestamps / values are ignored, not turned into events", () => {
    const engine = new SessionEventEngine({ sessionId: "s8-nan" });
    const poisoned = TWO_STROKES.map((s, i) =>
      i % 37 === 5
        ? { ...s, timestampMs: Number.NaN }
        : i % 41 === 7
          ? { ...s, value: Number.NaN }
          : s,
    );
    const all = [...stream(engine, poisoned), ...engine.flush()];
    assertWellFormed(all, "nan");
    expect(all).toHaveLength(2);
  });
});
