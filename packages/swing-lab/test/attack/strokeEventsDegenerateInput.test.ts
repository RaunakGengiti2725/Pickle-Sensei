import { describe, expect, it } from "vitest";
import { proposeStrokeEvents, proposeStrokeEventsV2 } from "../../src/strokeEvents.js";

/**
 * Adversarial inputs for the stroke-event proposer (adjudication cluster
 * pkg-swing-lab::ADJ-08). Proposals feed the annotation queue and replay
 * reports, so a degenerate clip window or a non-finite sample must never
 * surface as a proposal: inverted/zero-length/non-finite windows abstain with
 * a `degenerate_window` reason, and every emitted event is finite and lies
 * inside [clipStartMs, clipEndMs].
 */

type Sample = { timestampMs: number; value: number };

function swing(fromMs: number, toMs: number, peakMs: number, height = 2.0, stepMs = 40): Sample[] {
  const series: Sample[] = [];
  for (let t = fromMs; t <= toMs; t += stepMs) {
    series.push({
      timestampMs: t,
      value: 0.08 + height * Math.exp(-0.5 * ((t - peakMs) / 120) ** 2),
    });
  }
  return series;
}

function expectFiniteInsideClip(
  events: ReadonlyArray<{ startMs: number; peakMs: number; endMs: number; peakSpeed: number }>,
  clipStartMs: number,
  clipEndMs: number,
): void {
  for (const event of events) {
    for (const value of [event.startMs, event.peakMs, event.endMs, event.peakSpeed]) {
      expect(Number.isFinite(value), JSON.stringify(event)).toBe(true);
    }
    expect(event.startMs, JSON.stringify(event)).toBeGreaterThanOrEqual(clipStartMs);
    expect(event.startMs, JSON.stringify(event)).toBeLessThan(event.endMs);
    expect(event.endMs, JSON.stringify(event)).toBeLessThanOrEqual(clipEndMs);
    expect(event.peakMs, JSON.stringify(event)).toBeGreaterThanOrEqual(event.startMs);
    expect(event.peakMs, JSON.stringify(event)).toBeLessThanOrEqual(event.endMs);
  }
}

describe("S4a — inverted / zero-length / non-finite clip bounds", () => {
  const series = swing(0, 4000, 1500);

  it("v1: clipEndMs < clipStartMs never proposes; abstains with degenerate_window", () => {
    const result = proposeStrokeEvents({
      paddleSpeeds: series,
      wristSpeeds: null,
      clipStartMs: 4000,
      clipEndMs: 0,
    });
    expect(result.events).toEqual([]);
    expect(result.source).toBe("none");
    expect(result.reason).toBe("degenerate_window");
  });

  it("v2: clipEndMs < clipStartMs never proposes from wrist or paddle fallback", () => {
    const result = proposeStrokeEventsV2({
      paddleSpeeds: series,
      wristSpeeds: series,
      clipStartMs: 4000,
      clipEndMs: 0,
    });
    expect(result.events).toEqual([]);
    expect(result.source).toBe("none");
    expect(result.reason).toBe("degenerate_window");
  });

  it("zero-length window (clipEndMs === clipStartMs) is degenerate", () => {
    for (const result of [
      proposeStrokeEvents({
        paddleSpeeds: series,
        wristSpeeds: series,
        clipStartMs: 1500,
        clipEndMs: 1500,
      }),
      proposeStrokeEventsV2({
        paddleSpeeds: series,
        wristSpeeds: series,
        clipStartMs: 1500,
        clipEndMs: 1500,
      }),
    ]) {
      expect(result.events).toEqual([]);
      expect(result.reason).toBe("degenerate_window");
    }
  });

  it("non-finite clip bounds (NaN / ±Infinity) are degenerate", () => {
    const bounds: Array<[number, number]> = [
      [Number.NaN, 4000],
      [0, Number.NaN],
      [Number.NEGATIVE_INFINITY, 4000],
      [0, Number.POSITIVE_INFINITY],
    ];
    for (const [clipStartMs, clipEndMs] of bounds) {
      const v1 = proposeStrokeEvents({
        paddleSpeeds: series,
        wristSpeeds: null,
        clipStartMs,
        clipEndMs,
      });
      const v2 = proposeStrokeEventsV2({
        paddleSpeeds: null,
        wristSpeeds: series,
        clipStartMs,
        clipEndMs,
      });
      expect(v1.events, `${clipStartMs}..${clipEndMs}`).toEqual([]);
      expect(v1.reason, `${clipStartMs}..${clipEndMs}`).toBe("degenerate_window");
      expect(v2.events, `${clipStartMs}..${clipEndMs}`).toEqual([]);
      expect(v2.reason, `${clipStartMs}..${clipEndMs}`).toBe("degenerate_window");
    }
  });
});

describe("S4b — non-finite wrist / paddle samples", () => {
  const clean = swing(0, 4000, 1500);

  it("v1: NaN speeds interleaved with a real swing yield only finite, in-clip events", () => {
    const poisoned = clean.map((sample, index) =>
      index % 7 === 3 ? { ...sample, value: Number.NaN } : sample,
    );
    const result = proposeStrokeEvents({
      paddleSpeeds: null,
      wristSpeeds: poisoned,
      clipStartMs: 0,
      clipEndMs: 4000,
    });
    expectFiniteInsideClip(result.events, 0, 4000);
    expect(result.events.length).toBeGreaterThan(0);
    expect(Number.isFinite(result.events[0]!.prominence)).toBe(true);
    expect(Number.isFinite(result.events[0]!.confidence)).toBe(true);
  });

  it("v1: NaN timestamps are dropped before sorting and smoothing", () => {
    const poisoned = clean.map((sample, index) =>
      index % 5 === 0 ? { ...sample, timestampMs: Number.NaN } : sample,
    );
    const result = proposeStrokeEvents({
      paddleSpeeds: poisoned,
      wristSpeeds: null,
      clipStartMs: 0,
      clipEndMs: 4000,
    });
    expectFiniteInsideClip(result.events, 0, 4000);
    expect(result.events.length).toBeGreaterThan(0);
  });

  it("v1: an all-NaN series proposes nothing and reports insufficient coverage", () => {
    const allNaN = clean.map((sample) => ({ ...sample, value: Number.NaN }));
    const result = proposeStrokeEvents({
      paddleSpeeds: allNaN,
      wristSpeeds: allNaN,
      clipStartMs: 0,
      clipEndMs: 4000,
    });
    expect(result.events).toEqual([]);
    expect(result.source).toBe("none");
    expect(result.reason).toBe("insufficient_coverage");
  });

  it("v1: ±Infinity speeds never become a peak or a boundary", () => {
    const poisoned = clean.map((sample, index) =>
      index === 10
        ? { ...sample, value: Number.POSITIVE_INFINITY }
        : index === 60
          ? { ...sample, value: Number.NEGATIVE_INFINITY }
          : sample,
    );
    const result = proposeStrokeEvents({
      paddleSpeeds: poisoned,
      wristSpeeds: null,
      clipStartMs: 0,
      clipEndMs: 4000,
    });
    expectFiniteInsideClip(result.events, 0, 4000);
    expect(result.events.length).toBeGreaterThan(0);
    expect(Math.abs(result.events[0]!.peakMs - 1500)).toBeLessThanOrEqual(80);
  });

  it("v2: NaN wrist speeds and timestamps yield finite, in-clip events (glue + relaxation)", () => {
    const poisoned = clean.map((sample, index) =>
      index % 9 === 1
        ? { ...sample, value: Number.NaN }
        : index % 9 === 5
          ? { ...sample, timestampMs: Number.NaN }
          : sample,
    );
    const result = proposeStrokeEventsV2({
      paddleSpeeds: null,
      wristSpeeds: poisoned,
      clipStartMs: 0,
      clipEndMs: 4000,
    });
    expect(result.source).toBe("wrist");
    expectFiniteInsideClip(result.events, 0, 4000);
    expect(result.events.length).toBeGreaterThan(0);
  });

  it("v2: a single NaN paddle sample cannot poison paddle confirmation", () => {
    const paddle = swing(0, 4000, 1560, 2.6);
    const confirmedClean = proposeStrokeEventsV2({
      paddleSpeeds: paddle,
      wristSpeeds: clean,
      clipStartMs: 0,
      clipEndMs: 4000,
    });
    const poisonedPaddle = [{ timestampMs: 2000, value: Number.NaN }, ...paddle];
    const confirmedPoisoned = proposeStrokeEventsV2({
      paddleSpeeds: poisonedPaddle,
      wristSpeeds: clean,
      clipStartMs: 0,
      clipEndMs: 4000,
    });
    expect(confirmedClean.events[0]!.paddleConfirmed).toBe(true);
    expect(confirmedPoisoned.events.map((event) => event.paddleConfirmed)).toEqual(
      confirmedClean.events.map((event) => event.paddleConfirmed),
    );
    for (const event of confirmedPoisoned.events) {
      expect(event.paddlePeakMs === null || Number.isFinite(event.paddlePeakMs)).toBe(true);
    }
    expectFiniteInsideClip(confirmedPoisoned.events, 0, 4000);
  });
});
