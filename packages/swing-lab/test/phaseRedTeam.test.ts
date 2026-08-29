import { describe, expect, it } from "vitest";
import { checkArtifactInvariants } from "../src/invariants.js";
import { segmentPhasesTemporal, segmentPhasesTemporalV2 } from "../src/phaseTemporal.js";

/**
 * D3-05 — red-team regression suite for PHASE determination.
 *
 * Adversarial families (ALL fixtures synthetic, clearly labeled):
 *  1. corrupt kinematics — NaN/Infinity samples must never buy a timeline a
 *     quiet window would not earn (found: they poisoned Math.max-derived
 *     thresholds and slipped past the no-meaningful-swing gate);
 *  2. truncated clips — a clip starting mid-backswing/mid-acceleration keeps
 *     unobservable boundaries unknown (preparation stays null) and ordering
 *     intact;
 *  3. no visible follow-through — clip ends at contact ⇒ abstain, never an
 *     inverted or invented post-contact boundary;
 *  4. wheelchair-style kinematics — periodic propulsion peaks must not be
 *     promoted to a swing apex without an anchor, and anchored output keeps
 *     accel ≤ contact < followEnd;
 *  5. compact dinks — sub-100ms events segment with valid ordering when the
 *     sampling supports it (120fps) and abstain honestly when it does not
 *     (30fps).
 * Every segmented outcome must additionally pass checkArtifactInvariants
 * after a JSON round-trip.
 */

const jsonRoundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

function bump(
  peakMs: number,
  height: number,
  halfWidthMs: number,
  fromMs: number,
  toMs: number,
  stepMs = 40,
): Array<{ timestampMs: number; value: number }> {
  const series: Array<{ timestampMs: number; value: number }> = [];
  for (let t = fromMs; t <= toMs; t += stepMs) {
    series.push({
      timestampMs: t,
      value: 0.08 + height * Math.exp(-0.5 * ((t - peakMs) / halfWidthMs) ** 2),
    });
  }
  return series;
}

function expectOrderedBoundaries(outcome: ReturnType<typeof segmentPhasesTemporalV2>): void {
  if (outcome.status !== "segmented")
    throw new Error(`expected segmentation, got ${outcome.reason}`);
  const b = outcome.boundaries;
  if (b.preparationStartMs !== null) {
    expect(b.preparationStartMs).toBeLessThanOrEqual(b.accelerationStartMs);
  }
  if (Number.isFinite(b.contactMs)) {
    expect(b.accelerationStartMs).toBeLessThanOrEqual(b.contactMs);
    expect(b.followThroughEndMs).toBeGreaterThan(b.contactMs);
  } else {
    expect(b.accelerationStartMs).toBeLessThan(b.motionPeakMs!);
    expect(b.followThroughEndMs).toBeGreaterThan(b.motionPeakMs!);
  }
  if (b.recoveryEndMs !== null) {
    expect(b.recoveryEndMs).toBeGreaterThanOrEqual(b.followThroughEndMs);
  }
  expect(checkArtifactInvariants(jsonRoundTrip(b))).toEqual([]);
}

describe("D3-05 family 1 — corrupt kinematic samples (synthetic)", () => {
  const quiet = (poison?: { index: number; value: number }) => {
    const series: Array<{ timestampMs: number; value: number }> = [];
    for (let t = 1000; t <= 2200; t += 40) series.push({ timestampMs: t, value: 0.05 });
    if (poison)
      series[poison.index] = {
        timestampMs: series[poison.index]!.timestampMs,
        value: poison.value,
      };
    return series;
  };

  it("v1 anchored: a NaN sample must not let a quiet window segment (found garbage full-window timeline)", () => {
    const outcome = segmentPhasesTemporal({
      window: { startMs: 1000, endMs: 2200 },
      contactMs: 1600,
      paddleSpeeds: quiet({ index: 8, value: Number.NaN }),
      wristSpeeds: null,
    });
    expect(outcome.status).toBe("abstained");
    if (outcome.status !== "abstained") return;
    expect(outcome.reason).toContain("no meaningful swing speed");
  });

  it("v2 anchored: an Infinity sample must not let a quiet window segment", () => {
    const outcome = segmentPhasesTemporalV2({
      event: { startMs: 1000, endMs: 2200 },
      contactMs: 1600,
      paddleSpeeds: quiet({ index: 10, value: Number.POSITIVE_INFINITY }),
      wristSpeeds: null,
    });
    expect(outcome.status).toBe("abstained");
  });

  it("anchor-free: an Infinity sample must not fabricate a motion peak from a flat series", () => {
    const flat: Array<{ timestampMs: number; value: number }> = [];
    for (let t = 1000; t <= 2200; t += 40) flat.push({ timestampMs: t, value: 0.1 });
    flat[12] = { timestampMs: flat[12]!.timestampMs, value: Number.POSITIVE_INFINITY };
    const outcome = segmentPhasesTemporalV2({
      event: { startMs: 1000, endMs: 2200 },
      contactMs: null,
      paddleSpeeds: flat,
      wristSpeeds: null,
    });
    expect(outcome.status).toBe("abstained");
    if (outcome.status !== "abstained") return;
    expect(outcome.reason).toContain("PHASE_NO_MOTION_EVIDENCE");
  });

  it("anchor-free: NaN samples inside a REAL swing are dropped, not a blanket abstention (coverage preserved)", () => {
    const series = bump(1600, 2.0, 120, 1000, 2200);
    for (const i of [3, 7, 20])
      series[i] = { timestampMs: series[i]!.timestampMs, value: Number.NaN };
    const outcome = segmentPhasesTemporalV2({
      event: { startMs: 1000, endMs: 2200 },
      contactMs: null,
      paddleSpeeds: series,
      wristSpeeds: null,
    });
    expect(outcome.status).toBe("segmented");
    if (outcome.status !== "segmented") return;
    expect(Math.abs(outcome.boundaries.motionPeakMs! - 1600)).toBeLessThanOrEqual(60);
    expectOrderedBoundaries(outcome);
  });

  it("non-finite timestamps are dropped like non-finite values", () => {
    const series = bump(1600, 2.0, 120, 1000, 2200);
    series.push({ timestampMs: Number.NaN, value: 5.0 });
    const outcome = segmentPhasesTemporalV2({
      event: { startMs: 1000, endMs: 2200 },
      contactMs: 1600,
      paddleSpeeds: series,
      wristSpeeds: null,
    });
    expect(outcome.status).toBe("segmented");
    expectOrderedBoundaries(outcome);
  });
});

describe("D3-05 family 2 — truncated clips (synthetic)", () => {
  it("clip starts mid-acceleration: preparation stays UNKNOWN (null) and ordering holds", () => {
    // Hot from the very first sample through contact, then decays: the true
    // acceleration start is unobservable. accelerationStartMs clamps to the
    // FIRST OBSERVATION (documented earliest-honest-bound semantics, pinned
    // byte-identical in phaseTemporal.test.ts); preparation must stay null —
    // never invented before the first measurement.
    const series: Array<{ timestampMs: number; value: number }> = [];
    for (let t = 1000; t <= 1500; t += 40) series.push({ timestampMs: t, value: 1.5 });
    for (let t = 1540; t <= 1900; t += 40) series.push({ timestampMs: t, value: 0.05 });
    const outcome = segmentPhasesTemporalV2({
      event: { startMs: 1000, endMs: 1900 },
      contactMs: 1480,
      paddleSpeeds: series,
      wristSpeeds: null,
    });
    if (outcome.status !== "segmented")
      throw new Error(`expected segmentation, got ${outcome.reason}`);
    expect(outcome.boundaries.preparationStartMs).toBeNull();
    expect(outcome.boundaries.accelerationStartMs).toBe(1000);
    expectOrderedBoundaries(outcome);
  });

  it("clip starts mid-backswing in anchor-free mode: pre-peak evidence gate abstains rather than inventing acceleration", () => {
    // Only one sample before the peak survives inside the padded event.
    const series: Array<{ timestampMs: number; value: number }> = [
      { timestampMs: 1100, value: 0.4 },
      { timestampMs: 1140, value: 2.1 },
    ];
    for (let t = 1180, v = 1.5; t <= 1900; t += 40, v = Math.max(0.05, v * 0.75)) {
      series.push({ timestampMs: t, value: v });
    }
    const outcome = segmentPhasesTemporalV2({
      event: { startMs: 1100, endMs: 1900 },
      contactMs: null,
      paddleSpeeds: series,
      wristSpeeds: null,
    });
    expect(outcome.status).toBe("abstained");
    if (outcome.status !== "abstained") return;
    expect(outcome.reason).toContain("PHASE_NO_PRE_PEAK_EVIDENCE");
  });
});

describe("D3-05 family 3 — no visible follow-through (synthetic)", () => {
  it("anchored: clip ends AT contact ⇒ abstain, never an inverted timeline", () => {
    const series: Array<{ timestampMs: number; value: number }> = [];
    for (let t = 900; t <= 1500; t += 40) series.push({ timestampMs: t, value: 1.6 });
    const outcome = segmentPhasesTemporalV2({
      event: { startMs: 900, endMs: 1900 },
      contactMs: 1500,
      paddleSpeeds: series,
      wristSpeeds: null,
    });
    expect(outcome.status).toBe("abstained");
    if (outcome.status !== "abstained") return;
    expect(outcome.reason).toContain("PHASE_NO_POST_CONTACT_EVIDENCE");
  });

  it("anchored: a single post-contact observation is the minimum honest follow-through bound (> contact)", () => {
    const series: Array<{ timestampMs: number; value: number }> = [];
    for (let t = 900; t <= 1500; t += 40) series.push({ timestampMs: t, value: 1.6 });
    series.push({ timestampMs: 1560, value: 0.05 });
    const outcome = segmentPhasesTemporalV2({
      event: { startMs: 900, endMs: 1900 },
      contactMs: 1520,
      paddleSpeeds: series,
      wristSpeeds: null,
    });
    if (outcome.status !== "segmented")
      throw new Error(`expected segmentation, got ${outcome.reason}`);
    expect(outcome.boundaries.followThroughEndMs).toBe(1560);
    expectOrderedBoundaries(outcome);
  });

  it("anchor-free: clip ends at the motion peak ⇒ post-peak evidence gate abstains", () => {
    const series: Array<{ timestampMs: number; value: number }> = [];
    for (let t = 1000, v = 0.05; t <= 1760; t += 40, v = v * 1.25) {
      series.push({ timestampMs: t, value: v });
    }
    const outcome = segmentPhasesTemporalV2({
      event: { startMs: 1000, endMs: 1800 },
      contactMs: null,
      paddleSpeeds: series,
      wristSpeeds: null,
    });
    expect(outcome.status).toBe("abstained");
    if (outcome.status !== "abstained") return;
    expect(outcome.reason).toContain("PHASE_NO_POST_PEAK_EVIDENCE");
  });
});

describe("D3-05 family 4 — wheelchair-style periodic propulsion kinematics (synthetic)", () => {
  const propulsion = (fromMs: number, toMs: number) => {
    const series: Array<{ timestampMs: number; value: number }> = [];
    for (let t = fromMs; t <= toMs; t += 40) {
      series.push({
        timestampMs: t,
        value: 0.1 + 1.4 * Math.max(0, Math.sin((2 * Math.PI * t) / 900)) ** 2,
      });
    }
    return series;
  };

  it("anchor-free: propulsion rhythm has no decisive apex ⇒ abstain, never promote a wheel push to a swing", () => {
    const outcome = segmentPhasesTemporalV2({
      event: { startMs: 800, endMs: 3200 },
      contactMs: null,
      paddleSpeeds: propulsion(0, 4000),
      wristSpeeds: null,
    });
    expect(outcome.status).toBe("abstained");
    if (outcome.status !== "abstained") return;
    expect(outcome.reason).toMatch(
      /PHASE_PEAK_NOT_UNIQUE|PHASE_PEAK_NOT_PROMINENT|PHASE_PEAK_OUTSIDE_EVENT/,
    );
  });

  it("anchored: a trusted contact anchor between pushes still yields an ORDERED timeline (accel ≤ contact < followEnd)", () => {
    const outcome = segmentPhasesTemporalV2({
      event: { startMs: 800, endMs: 3200 },
      contactMs: 1800,
      paddleSpeeds: propulsion(0, 4000),
      wristSpeeds: null,
    });
    expectOrderedBoundaries(outcome);
  });

  it("anchored: contact anchored ON a propulsion peak keeps ordering", () => {
    const outcome = segmentPhasesTemporalV2({
      event: { startMs: 800, endMs: 3200 },
      contactMs: 1350,
      paddleSpeeds: propulsion(0, 4000),
      wristSpeeds: null,
    });
    expectOrderedBoundaries(outcome);
  });
});

describe("D3-05 family 5 — compact dink events <100ms (synthetic)", () => {
  it("30fps: a sub-100ms event cannot carry enough in-window samples ⇒ honest abstention (never confidently wrong)", () => {
    const series: Array<{ timestampMs: number; value: number }> = [];
    for (let t = 500; t <= 2000; t += 33) {
      series.push({
        timestampMs: t,
        value: 0.08 + 1.2 * Math.exp(-0.5 * ((t - 1050) / 60) ** 2),
      });
    }
    const outcome = segmentPhasesTemporalV2({
      event: { startMs: 1000, endMs: 1090 },
      contactMs: 1050,
      paddleSpeeds: series,
      wristSpeeds: null,
    });
    expect(outcome.status).toBe("abstained");
  });

  it("120fps: the same compact dink segments with valid ordering and contact inside the event", () => {
    const series: Array<{ timestampMs: number; value: number }> = [];
    for (let t = 500; t <= 2000; t += 8) {
      series.push({
        timestampMs: t,
        value: 0.08 + 1.2 * Math.exp(-0.5 * ((t - 1050) / 60) ** 2),
      });
    }
    const outcome = segmentPhasesTemporalV2({
      event: { startMs: 1000, endMs: 1090 },
      contactMs: 1050,
      paddleSpeeds: series,
      wristSpeeds: null,
    });
    expectOrderedBoundaries(outcome);
    if (outcome.status !== "segmented") return;
    expect(outcome.boundaries.contactMs).toBe(1050);
  });

  it("anchor-free compact dink at 30fps abstains (too few in-event samples) rather than inventing a peak timeline", () => {
    const series: Array<{ timestampMs: number; value: number }> = [];
    for (let t = 500; t <= 2000; t += 33) {
      series.push({
        timestampMs: t,
        value: 0.08 + 1.2 * Math.exp(-0.5 * ((t - 1050) / 60) ** 2),
      });
    }
    const outcome = segmentPhasesTemporalV2({
      event: { startMs: 1000, endMs: 1090 },
      contactMs: null,
      paddleSpeeds: series,
      wristSpeeds: null,
    });
    expect(outcome.status).toBe("abstained");
  });
});

describe("D3-05 — corrupt-input fuzz: NaN/Infinity injection never yields a disordered or invariant-violating timeline", () => {
  const rng = (seed: number) => {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
  };

  it("300 seeds with injected non-finite samples", () => {
    let segmented = 0;
    for (let seed = 1; seed <= 300; seed += 1) {
      const rand = rng(seed * 7919 + 3);
      const startMs = Math.floor(rand() * 800);
      const endMs = startMs + 400 + Math.floor(rand() * 1800);
      const series: Array<{ timestampMs: number; value: number }> = [];
      const peakMs = startMs + (endMs - startMs) * (0.2 + rand() * 0.6);
      for (let t = startMs - 300; t <= endMs + 300; t += 30 + Math.floor(rand() * 20)) {
        series.push({
          timestampMs: t,
          value: 0.05 + rand() * 0.1 + 2.2 * Math.exp(-0.5 * ((t - peakMs) / 110) ** 2),
        });
      }
      const poisons = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
      for (let k = 0; k < 1 + Math.floor(rand() * 4); k += 1) {
        const i = Math.floor(rand() * series.length);
        series[i] = { timestampMs: series[i]!.timestampMs, value: poisons[k % poisons.length]! };
      }
      const contactMs = rand() < 0.5 ? null : Math.round(peakMs + (rand() - 0.5) * 80);
      const outcome = segmentPhasesTemporalV2({
        event: { startMs, endMs },
        contactMs,
        paddleSpeeds: series,
        wristSpeeds: null,
      });
      if (outcome.status !== "segmented") continue;
      segmented += 1;
      expectOrderedBoundaries(outcome);
      // No non-finite value may ever surface in a segmented artifact.
      const flat = JSON.stringify(outcome);
      expect(flat.includes("Infinity")).toBe(false);
    }
    expect(segmented).toBeGreaterThan(50);
  });
});
