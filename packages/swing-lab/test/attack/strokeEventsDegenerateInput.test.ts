import { describe, expect, it } from "vitest";
import { checkArtifactInvariants } from "../../src/invariants.js";
import { proposeStrokeEvents, proposeStrokeEventsV2 } from "../../src/strokeEvents.js";

/**
 * Adversarial pass 3 (tester #4) — S4: proposeStrokeEventsV2 under degenerate
 * input (inverted clip bounds, NaN wrist speeds / timestamps). Extends the
 * seeded property suite in ../propertyInvariants.test.ts (same LCG, seeds
 * recorded in every assertion message) without touching that file.
 *
 * Contract under attack: a proposer fed unusable input must ABSTAIN with a
 * typed result ({ events: [], source: "none" }) — never emit events whose
 * bounds are NaN, lie outside the clip, or whose amplitude gate was
 * silently disabled by NaN arithmetic.
 */

/** Same LCG as propertyInvariants.test.ts so a seed here replays there. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

type Sample = { timestampMs: number; value: number };

function randomSeries(rand: () => number, clipEndMs: number): Sample[] {
  const stepMs = 20 + Math.floor(rand() * 30);
  const series: Sample[] = [];
  let value = rand() * 0.4;
  for (let t = 0; t <= clipEndMs; t += stepMs) {
    value = Math.max(0, value + (rand() - 0.5) * 0.4);
    if (rand() < 0.05) value += rand() * 4;
    series.push({ timestampMs: t, value });
  }
  return series;
}

/** One unmistakable swing: quiet baseline, a 2.5 u/s bell around 1500ms. */
function oneSwing(): Sample[] {
  const series: Sample[] = [];
  for (let t = 0; t <= 3000; t += 33) {
    const d = (t - 1500) / 120;
    series.push({ timestampMs: t, value: 0.05 + 2.5 * Math.exp(-d * d) });
  }
  return series;
}

const jsonRoundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

function expectFiniteInsideClip(
  events: ReadonlyArray<{ startMs: number; peakMs: number; endMs: number; confidence: number }>,
  clipStartMs: number,
  clipEndMs: number,
  label: string,
): void {
  const lo = Math.min(clipStartMs, clipEndMs);
  const hi = Math.max(clipStartMs, clipEndMs);
  for (const event of events) {
    for (const [key, value] of Object.entries(event)) {
      if (typeof value === "number") {
        expect(Number.isFinite(value), `${label}: ${key}=${value}`).toBe(true);
      }
    }
    expect(event.endMs, label).toBeGreaterThanOrEqual(event.startMs);
    expect(event.peakMs, label).toBeGreaterThanOrEqual(event.startMs);
    expect(event.peakMs, label).toBeLessThanOrEqual(event.endMs);
    expect(event.startMs, `${label}: startMs inside clip`).toBeGreaterThanOrEqual(lo);
    expect(event.endMs, `${label}: endMs inside clip`).toBeLessThanOrEqual(hi);
  }
}

describe("S4a — inverted clip bounds (clipEndMs < clipStartMs)", () => {
  it("control: the same wrist series inside a sane clip proposes exactly one event", () => {
    const result = proposeStrokeEventsV2({
      paddleSpeeds: null,
      wristSpeeds: oneSwing(),
      clipStartMs: 0,
      clipEndMs: 3000,
    });
    expect(result.source).toBe("wrist");
    expect(result.events).toHaveLength(1);
  });

  it("abstains (typed) instead of proposing from a clip of negative length", () => {
    const result = proposeStrokeEventsV2({
      paddleSpeeds: null,
      wristSpeeds: oneSwing(),
      clipStartMs: 3000,
      clipEndMs: 0,
    });
    expect(result, "inverted clip must be a typed abstention").toEqual({
      events: [],
      source: "none",
    });
  });

  it("abstains for a zero-length clip too", () => {
    const result = proposeStrokeEventsV2({
      paddleSpeeds: null,
      wristSpeeds: oneSwing(),
      clipStartMs: 1500,
      clipEndMs: 1500,
    });
    expect(result).toEqual({ events: [], source: "none" });
  });

  it("v1 proposer: inverted clip is a typed abstention as well", () => {
    const result = proposeStrokeEvents({
      paddleSpeeds: oneSwing(),
      wristSpeeds: oneSwing(),
      clipStartMs: 3000,
      clipEndMs: 0,
    });
    expect(result).toEqual({ events: [], source: "none" });
  });

  it("seeded fuzz (seeds 1..200, LCG seed*2654435761): inverted bounds never yield events", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const rand = rng(seed * 2654435761);
      const clipEndMs = 800 + Math.floor(rand() * 8000);
      const wrist = randomSeries(rand, clipEndMs);
      const paddle = rand() < 0.5 ? null : randomSeries(rand, clipEndMs);
      const result = proposeStrokeEventsV2({
        paddleSpeeds: paddle,
        wristSpeeds: wrist,
        clipStartMs: clipEndMs,
        clipEndMs: 0,
      });
      expect(result.events, `seed ${seed}`).toEqual([]);
      expect(result.source, `seed ${seed}`).toBe("none");
    }
  });

  it("non-finite clip bounds (NaN / Infinity) are typed abstentions", () => {
    for (const [clipStartMs, clipEndMs] of [
      [Number.NaN, 3000],
      [0, Number.NaN],
      [Number.NaN, Number.NaN],
      [0, Number.POSITIVE_INFINITY],
      [Number.NEGATIVE_INFINITY, 3000],
    ] as const) {
      const result = proposeStrokeEventsV2({
        paddleSpeeds: null,
        wristSpeeds: oneSwing(),
        clipStartMs,
        clipEndMs,
      });
      expect(result, `clip [${clipStartMs}, ${clipEndMs}]`).toEqual({ events: [], source: "none" });
    }
  });
});

describe("S4b — NaN wrist speeds", () => {
  it("a single NaN sample must not disable the amplitude gate (jitter must stay non-events)", () => {
    // Pure low-level jitter, well under minPeakSpeed 0.5: no event is a swing.
    const jitter: Sample[] = [];
    for (let t = 0; t <= 3000; t += 33) {
      jitter.push({ timestampMs: t, value: 0.05 + 0.04 * Math.sin(t / 37) });
    }
    const clean = proposeStrokeEventsV2({
      paddleSpeeds: null,
      wristSpeeds: jitter,
      clipStartMs: 0,
      clipEndMs: 3000,
    });
    expect(clean.events, "control: clean jitter proposes nothing").toEqual([]);

    const poisoned = jitter.map((s, i) => (i === 45 ? { ...s, value: Number.NaN } : s));
    const result = proposeStrokeEventsV2({
      paddleSpeeds: null,
      wristSpeeds: poisoned,
      clipStartMs: 0,
      clipEndMs: 3000,
    });
    // Either abstain, or behave exactly like the clean series. A NaN must
    // never CREATE events where the clean series had none.
    expect(result.events, `NaN-poisoned jitter proposed ${result.events.length} events`).toEqual(
      [],
    );
  });

  it("NaN values never reach the output: every emitted event is finite and inside the clip", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const rand = rng(seed * 2654435761);
      const clipEndMs = 800 + Math.floor(rand() * 8000);
      const wrist = randomSeries(rand, clipEndMs);
      // Poison 1..3 samples with NaN values.
      const poisonCount = 1 + Math.floor(rand() * 3);
      for (let k = 0; k < poisonCount; k += 1) {
        const at = Math.floor(rand() * wrist.length);
        wrist[at] = { timestampMs: wrist[at]!.timestampMs, value: Number.NaN };
      }
      const result = proposeStrokeEventsV2({
        paddleSpeeds: null,
        wristSpeeds: wrist,
        clipStartMs: 0,
        clipEndMs,
      });
      expectFiniteInsideClip(result.events, 0, clipEndMs, `seed ${seed} (NaN values)`);
      const violations = checkArtifactInvariants(jsonRoundTrip(result));
      expect(violations, `seed ${seed}: ${JSON.stringify(violations)}`).toEqual([]);
    }
  });

  it("all-NaN wrist speeds is a typed abstention", () => {
    const wrist = oneSwing().map((s) => ({ ...s, value: Number.NaN }));
    const result = proposeStrokeEventsV2({
      paddleSpeeds: null,
      wristSpeeds: wrist,
      clipStartMs: 0,
      clipEndMs: 3000,
    });
    expect(result).toEqual({ events: [], source: "none" });
  });

  it("NaN timestamps never reach the output (seeds 1..200)", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const rand = rng(seed * 2654435761 + 11);
      const clipEndMs = 800 + Math.floor(rand() * 8000);
      const wrist = randomSeries(rand, clipEndMs);
      const at = Math.floor(rand() * wrist.length);
      wrist[at] = { timestampMs: Number.NaN, value: wrist[at]!.value };
      const result = proposeStrokeEventsV2({
        paddleSpeeds: null,
        wristSpeeds: wrist,
        clipStartMs: 0,
        clipEndMs,
      });
      expectFiniteInsideClip(result.events, 0, clipEndMs, `seed ${seed} (NaN timestamp)`);
    }
  });

  it("NaN in the PADDLE series cannot poison confirmation fields (seeds 1..200)", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const rand = rng(seed * 2654435761 + 23);
      const clipEndMs = 800 + Math.floor(rand() * 8000);
      const wrist = randomSeries(rand, clipEndMs);
      const paddle = randomSeries(rand, clipEndMs);
      const at = Math.floor(rand() * paddle.length);
      paddle[at] = { timestampMs: paddle[at]!.timestampMs, value: Number.NaN };
      const result = proposeStrokeEventsV2({
        paddleSpeeds: paddle,
        wristSpeeds: wrist,
        clipStartMs: 0,
        clipEndMs,
      });
      for (const event of result.events) {
        expect(Number.isFinite(event.paddleSupport), `seed ${seed} paddleSupport`).toBe(true);
        expect(Number.isFinite(event.confidence), `seed ${seed} confidence`).toBe(true);
        if (event.paddlePeakMs !== null) {
          expect(Number.isFinite(event.paddlePeakMs), `seed ${seed} paddlePeakMs`).toBe(true);
        }
      }
    }
  });
});
