import { describe, expect, it } from "vitest";
import {
  PHASE_TEMPORAL_V2_ANCHOR_FREE_VERSION,
  PHASE_TEMPORAL_V2_VERSION,
  segmentPhasesTemporalV2,
} from "../src/phaseTemporal.js";

/**
 * W5 — phases v2 anchor-free mode.
 *
 * Two contracts under test:
 *  1. BYTE-IDENTITY: when a contact anchor IS provided, segmentPhasesTemporalV2
 *     output is byte-identical to the pre-W5 implementation (the pinned JSON
 *     strings below were captured by running the pre-change code).
 *  2. ANCHOR-FREE HONESTY: without a contact anchor the segmenter may emit a
 *     timeline around the measured kinematic peak — with NO contact boundary
 *     (null in JSON), anchorBasis "event_peak", stricter evidence gates, and
 *     precise abstention reasons when the evidence is weak/short/noisy.
 */

/** Same speed-series helper shape used across swing-lab tests. */
function speedBumps(
  bumps: Array<{ peakMs: number; height: number; halfWidthMs: number }>,
  fromMs = 0,
  toMs = 8000,
  stepMs = 40,
): Array<{ timestampMs: number; value: number }> {
  const series: Array<{ timestampMs: number; value: number }> = [];
  for (let t = fromMs; t <= toMs; t += stepMs) {
    let value = 0.08; // idle baseline
    for (const bump of bumps) {
      value += bump.height * Math.exp(-0.5 * ((t - bump.peakMs) / bump.halfWidthMs) ** 2);
    }
    series.push({ timestampMs: t, value });
  }
  return series;
}

const speeds = speedBumps([{ peakMs: 1500, height: 2.0, halfWidthMs: 130 }], 0, 3000);
const event = { startMs: 1100, endMs: 1950 };

const sparsePostContact = (withPostSamples: boolean) => {
  const series: Array<{ timestampMs: number; value: number }> = [];
  for (let t = 900; t <= 1500; t += 40) series.push({ timestampMs: t, value: 1.6 });
  if (withPostSamples) {
    for (let t = 1600; t <= 1720; t += 40) series.push({ timestampMs: t, value: 0.05 });
  }
  return series;
};

describe("segmentPhasesTemporalV2 — ANCHORED path byte-identity regression (W5 hard invariant)", () => {
  // Pinned JSON.stringify outputs captured from the PRE-W5 implementation.
  // If any of these change, the anchored path is no longer byte-identical.
  const pins: Array<{ name: string; input: Parameters<typeof segmentPhasesTemporalV2>[0]; expected: string }> = [
    {
      name: "paddle-source anchored segmentation",
      input: { event, contactMs: 1520, paddleSpeeds: speeds, wristSpeeds: null },
      expected:
        '{"status":"segmented","boundaries":{"version":"phase.paddle-temporal.v2 (event-local, anchor-or-abstain; heuristic, uncalibrated)","source":"paddle","anchor":"contact_estimate","confidence":0.65,"preparationStartMs":1160,"accelerationStartMs":1280,"contactMs":1520,"followThroughEndMs":1720,"recoveryEndMs":1800,"relative":{"preparationStartMs":-360,"accelerationStartMs":-240,"followThroughEndMs":200,"recoveryEndMs":280}}}',
    },
    {
      name: "wrist-source anchored segmentation",
      input: { event, contactMs: 1520, paddleSpeeds: null, wristSpeeds: speeds },
      expected:
        '{"status":"segmented","boundaries":{"version":"phase.paddle-temporal.v2 (event-local, anchor-or-abstain; heuristic, uncalibrated)","source":"wrist","anchor":"contact_estimate","confidence":0.4,"preparationStartMs":1160,"accelerationStartMs":1280,"contactMs":1520,"followThroughEndMs":1720,"recoveryEndMs":1800,"relative":{"preparationStartMs":-360,"accelerationStartMs":-240,"followThroughEndMs":200,"recoveryEndMs":280}}}',
    },
    {
      name: "follow-through repair under sparse post-contact sampling",
      input: { event, contactMs: 1520, paddleSpeeds: sparsePostContact(true), wristSpeeds: null },
      expected:
        '{"status":"segmented","boundaries":{"version":"phase.paddle-temporal.v2 (event-local, anchor-or-abstain; heuristic, uncalibrated)","source":"paddle","anchor":"contact_estimate","confidence":0.65,"preparationStartMs":null,"accelerationStartMs":900,"contactMs":1520,"followThroughEndMs":1600,"recoveryEndMs":1640,"relative":{"preparationStartMs":null,"accelerationStartMs":-620,"followThroughEndMs":80,"recoveryEndMs":120}}}',
    },
    {
      name: "late-contact anchored segmentation (second synthetic window)",
      input: {
        event: { startMs: 5600, endMs: 6840 },
        contactMs: 6700,
        paddleSpeeds: speedBumps([{ peakMs: 6690, height: 1.7, halfWidthMs: 90 }], 5400, 7200),
        wristSpeeds: null,
      },
      expected:
        '{"status":"segmented","boundaries":{"version":"phase.paddle-temporal.v2 (event-local, anchor-or-abstain; heuristic, uncalibrated)","source":"paddle","anchor":"contact_estimate","confidence":0.65,"preparationStartMs":6440,"accelerationStartMs":6560,"contactMs":6700,"followThroughEndMs":6840,"recoveryEndMs":6880,"relative":{"preparationStartMs":-260,"accelerationStartMs":-140,"followThroughEndMs":140,"recoveryEndMs":180}}}',
    },
    {
      name: "wrong-event abstention (contact outside the event)",
      input: { event, contactMs: 2600, paddleSpeeds: speeds, wristSpeeds: null },
      expected: '{"status":"abstained","reason":"PHASE_WRONG_EVENT: contact estimate lies outside the target event"}',
    },
    {
      name: "coverage abstention (too little series inside the event)",
      input: {
        event,
        contactMs: 1520,
        paddleSpeeds: [
          { timestampMs: 1400, value: 1 },
          { timestampMs: 1440, value: 1 },
        ],
        wristSpeeds: null,
      },
      expected: '{"status":"abstained","reason":"insufficient event-local kinematic coverage (paddle and wrist)"}',
    },
  ];

  for (const pin of pins) {
    it(`byte-identical: ${pin.name}`, () => {
      expect(JSON.stringify(segmentPhasesTemporalV2(pin.input))).toBe(pin.expected);
    });
  }

  it("abstains when NO samples exist after the contact anchor (unchanged)", () => {
    const outcome = segmentPhasesTemporalV2({
      event,
      contactMs: 1520,
      paddleSpeeds: sparsePostContact(false),
      wristSpeeds: null,
    });
    expect(outcome.status).toBe("abstained");
    if (outcome.status !== "abstained") return;
    expect(outcome.reason).toContain("PHASE_NO_POST_CONTACT_EVIDENCE");
  });
});

describe("segmentPhasesTemporalV2 — ANCHOR-FREE mode (W5)", () => {
  it("segments around the measured motion peak with NO contact boundary", () => {
    const outcome = segmentPhasesTemporalV2({
      event,
      contactMs: null,
      paddleSpeeds: speeds,
      wristSpeeds: null,
    });
    expect(outcome.status).toBe("segmented");
    if (outcome.status !== "segmented") return;
    const boundaries = outcome.boundaries;
    expect(boundaries.version).toBe(PHASE_TEMPORAL_V2_ANCHOR_FREE_VERSION);
    expect(boundaries.version).not.toBe(PHASE_TEMPORAL_V2_VERSION);
    expect(boundaries.anchorBasis).toBe("event_peak");
    expect(boundaries.anchor).toBe("speed_peak");
    expect(boundaries.source).toBe("paddle");
    expect(boundaries.confidence).toBeCloseTo(0.52, 10); // 0.65 × 0.8 anchor-free penalty
    // The contact boundary is explicitly ABSENT: NaN in-process, null in JSON.
    expect(Number.isNaN(boundaries.contactMs)).toBe(true);
    expect(JSON.parse(JSON.stringify(outcome)).boundaries.contactMs).toBeNull();
    // Motion peak measured near the synthetic bump (40ms sampling grid).
    expect(boundaries.motionPeakMs).toBeDefined();
    expect(Math.abs(boundaries.motionPeakMs! - 1500)).toBeLessThanOrEqual(60);
    // Monotonic honest timeline around the peak.
    expect(boundaries.preparationStartMs!).toBeLessThanOrEqual(boundaries.accelerationStartMs);
    expect(boundaries.accelerationStartMs).toBeLessThan(boundaries.motionPeakMs!);
    expect(boundaries.followThroughEndMs).toBeGreaterThan(boundaries.motionPeakMs!);
    expect(boundaries.recoveryEndMs!).toBeGreaterThanOrEqual(boundaries.followThroughEndMs);
    // relative is peak-relative (t=0 at the motion peak) in anchor-free mode.
    expect(boundaries.relative.accelerationStartMs).toBeLessThan(0);
    expect(boundaries.relative.followThroughEndMs).toBeGreaterThan(0);
    expect(boundaries.relative.accelerationStartMs).toBe(
      boundaries.accelerationStartMs - boundaries.motionPeakMs!,
    );
  });

  it("passes the cascade PHASE ordering predicate with a null contact (usable-result-v1 clause c)", () => {
    const outcome = segmentPhasesTemporalV2({
      event,
      contactMs: null,
      paddleSpeeds: speeds,
      wristSpeeds: null,
    });
    expect(outcome.status).toBe("segmented");
    // Exactly the predicate cascadeWaterfall.ts applies to report.json.
    const serialized = JSON.parse(JSON.stringify(outcome)) as {
      status: string;
      boundaries: { contactMs: number | null; followThroughEndMs: number | null };
    };
    const orderingValid =
      serialized.boundaries.followThroughEndMs == null ||
      serialized.boundaries.contactMs == null ||
      serialized.boundaries.followThroughEndMs > serialized.boundaries.contactMs;
    expect(serialized.status).toBe("segmented");
    expect(orderingValid).toBe(true);
  });

  it("uses the wrist series at reduced confidence when paddle coverage is absent", () => {
    const outcome = segmentPhasesTemporalV2({
      event,
      contactMs: null,
      paddleSpeeds: null,
      wristSpeeds: speeds,
    });
    expect(outcome.status).toBe("segmented");
    if (outcome.status !== "segmented") return;
    expect(outcome.boundaries.source).toBe("wrist");
    expect(outcome.boundaries.confidence).toBeCloseTo(0.32, 10); // 0.4 × 0.8
    expect(outcome.boundaries.anchorBasis).toBe("event_peak");
  });

  it("accepts the event's own peak as a cross-check when they agree", () => {
    const outcome = segmentPhasesTemporalV2({
      event: { ...event, peakMs: 1540 },
      contactMs: null,
      paddleSpeeds: speeds,
      wristSpeeds: null,
    });
    expect(outcome.status).toBe("segmented");
  });

  // ── NOT A FREE PASS: insufficient evidence still abstains, precisely ──

  it("abstains on weak motion (peak below the anchor-free floor)", () => {
    const weak = speedBumps([{ peakMs: 1500, height: 0.3, halfWidthMs: 130 }], 0, 3000);
    const outcome = segmentPhasesTemporalV2({
      event,
      contactMs: null,
      paddleSpeeds: weak,
      wristSpeeds: null,
    });
    expect(outcome.status).toBe("abstained");
    if (outcome.status !== "abstained") return;
    expect(outcome.reason).toContain("PHASE_NO_MOTION_EVIDENCE");
  });

  it("abstains on a flat active series (no measurable apex)", () => {
    const flat: Array<{ timestampMs: number; value: number }> = [];
    for (let t = 900; t <= 1720; t += 40) flat.push({ timestampMs: t, value: 1.6 });
    const outcome = segmentPhasesTemporalV2({
      event,
      contactMs: null,
      paddleSpeeds: flat,
      wristSpeeds: null,
    });
    expect(outcome.status).toBe("abstained");
    if (outcome.status !== "abstained") return;
    expect(outcome.reason).toContain("PHASE_PEAK_NOT_PROMINENT");
  });

  it("abstains when the swing apex lies outside the event (event does not own its peak)", () => {
    const risingEdge = speedBumps([{ peakMs: 2100, height: 2.2, halfWidthMs: 200 }], 800, 2250);
    const outcome = segmentPhasesTemporalV2({
      event,
      contactMs: null,
      paddleSpeeds: risingEdge,
      wristSpeeds: null,
    });
    expect(outcome.status).toBe("abstained");
    if (outcome.status !== "abstained") return;
    expect(outcome.reason).toContain("PHASE_PEAK_OUTSIDE_EVENT");
  });

  it("abstains when the measured peak contradicts the event's own peak", () => {
    const outcome = segmentPhasesTemporalV2({
      event: { ...event, peakMs: 1100 },
      contactMs: null,
      paddleSpeeds: speeds,
      wristSpeeds: null,
    });
    expect(outcome.status).toBe("abstained");
    if (outcome.status !== "abstained") return;
    expect(outcome.reason).toContain("PHASE_PEAK_MISMATCH");
  });

  it("abstains without pre-peak evidence (acceleration unmeasurable)", () => {
    const series: Array<{ timestampMs: number; value: number }> = [
      { timestampMs: 1100, value: 0.3 },
      { timestampMs: 1140, value: 2.0 },
    ];
    for (let t = 1180, v = 1.4; t <= 1900; t += 40, v = Math.max(0.05, v * 0.7)) {
      series.push({ timestampMs: t, value: v });
    }
    const outcome = segmentPhasesTemporalV2({
      event,
      contactMs: null,
      paddleSpeeds: series,
      wristSpeeds: null,
    });
    expect(outcome.status).toBe("abstained");
    if (outcome.status !== "abstained") return;
    expect(outcome.reason).toContain("PHASE_NO_PRE_PEAK_EVIDENCE");
  });

  it("abstains without post-peak evidence (deceleration/follow-through unmeasurable)", () => {
    const series: Array<{ timestampMs: number; value: number }> = [];
    for (let t = 1100, v = 0.05; t <= 1860; t += 40, v = Math.min(0.4, v * 1.2)) {
      series.push({ timestampMs: t, value: v });
    }
    series.push({ timestampMs: 1900, value: 1.2 });
    series.push({ timestampMs: 1940, value: 2.1 });
    const outcome = segmentPhasesTemporalV2({
      event,
      contactMs: null,
      paddleSpeeds: series,
      wristSpeeds: null,
    });
    expect(outcome.status).toBe("abstained");
    if (outcome.status !== "abstained") return;
    expect(outcome.reason).toContain("PHASE_NO_POST_PEAK_EVIDENCE");
  });

  it("abstains with precise coverage reason when the series barely covers the event", () => {
    const few = speeds.filter((sample) => sample.timestampMs >= 1300 && sample.timestampMs <= 1560);
    const outcome = segmentPhasesTemporalV2({
      event,
      contactMs: null,
      paddleSpeeds: few,
      wristSpeeds: null,
    });
    expect(outcome.status).toBe("abstained");
    if (outcome.status !== "abstained") return;
    expect(outcome.reason).toContain("PHASE_INSUFFICIENT_COVERAGE");
  });

  it("never inherits the anchored version string or a fabricated contact", () => {
    const outcome = segmentPhasesTemporalV2({
      event,
      contactMs: null,
      paddleSpeeds: speeds,
      wristSpeeds: null,
    });
    if (outcome.status !== "segmented") throw new Error("expected segmentation");
    // The peak must NOT be smuggled into contactMs (v1's speed_peak fallback
    // did that; anchor-free v2.1 must not fabricate a contact marker).
    const serialized = JSON.parse(JSON.stringify(outcome)) as {
      boundaries: { contactMs: number | null; motionPeakMs: number };
    };
    expect(serialized.boundaries.contactMs).toBeNull();
    expect(serialized.boundaries.motionPeakMs).not.toBeNull();
  });
});

describe("segmentPhasesTemporalV2 — anchored accel≤contact ordering invariant (held-out one-shot defect)", () => {
  it("repairs accel to the last pre-anchor observation when the nearest sample sits after the anchor", () => {
    // Quiet before the anchor, hot after: nearest-to-anchor sample is at
    // 1520 (>1505) and the backward walk breaks immediately — pre-fix this
    // emitted accelerationStartMs 1520 > contactMs 1505 (impossible timeline).
    const series: Array<{ timestampMs: number; value: number }> = [];
    for (let t = 1000; t <= 1400; t += 40) series.push({ timestampMs: t, value: 0.05 });
    for (let t = 1520; t <= 1960; t += 40) series.push({ timestampMs: t, value: 1.8 });
    for (let t = 2000; t <= 2200; t += 40) series.push({ timestampMs: t, value: 0.05 });
    const outcome = segmentPhasesTemporalV2({
      event: { startMs: 1000, endMs: 2200 },
      contactMs: 1505,
      paddleSpeeds: series,
      wristSpeeds: null,
    });
    if (outcome.status !== "segmented") throw new Error(`expected segmentation, got ${outcome.reason}`);
    expect(outcome.boundaries.accelerationStartMs).toBeLessThanOrEqual(1505);
    expect(outcome.boundaries.followThroughEndMs).toBeGreaterThan(1505);
  });

  it("abstains when no kinematic samples exist at or before the contact anchor", () => {
    const series: Array<{ timestampMs: number; value: number }> = [];
    for (let t = 1600; t <= 2400; t += 40) series.push({ timestampMs: t, value: 1.5 });
    const outcome = segmentPhasesTemporalV2({
      event: { startMs: 1400, endMs: 2400 },
      contactMs: 1500,
      paddleSpeeds: series,
      wristSpeeds: null,
    });
    expect(outcome.status).toBe("abstained");
    if (outcome.status !== "abstained") return;
    expect(outcome.reason).toContain("PHASE_NO_PRE_CONTACT_EVIDENCE");
  });
});
