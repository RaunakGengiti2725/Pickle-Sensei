import { describe, expect, it } from "vitest";
import { checkArtifactInvariants } from "../src/invariants.js";
import {
  PHASE_TEMPORAL_V2_ANCHOR_FREE_VERSION,
  segmentPhasesTemporalV2,
} from "../src/phaseTemporal.js";

/**
 * E04 — anchor-free v2.3 burst-aware apex ownership (ALL fixtures synthetic).
 *
 * Committed-gold forensics (dense dink/volley rallies) showed the v2.2
 * ownership and rival gates judging the ±300ms margin as if every sample there
 * belonged to this event's swing: a NEIGHBORING stroke's peak in the margin —
 * rest-separated from the in-event apex — blocked segmentation even though the
 * event owns a decisive, unique apex. v2.3 exempts margin samples that are
 * rest-separated from the apex (the series drops below the boundary-walking
 * accel threshold between them); everything else is unchanged:
 *  - in-event contenders ALWAYS count (periodic in-event motion still abstains
 *    — D3-05 B2 wheelchair fixture is regression-pinned in phaseRedTeam);
 *  - a margin peak motion-connected to the apex is the same swing spilling
 *    past the event boundary and still abstains (PHASE_PEAK_OUTSIDE_EVENT).
 * Every segmented outcome must pass checkArtifactInvariants after a JSON
 * round-trip.
 *
 * F07 — v2.4 measurement-resolution apex adoption. Committed-gold forensics
 * on the 6 remaining abstentions showed one case (wavea-marne-dig@14042)
 * where the swing's true apex sits ONE SAMPLE (15ms at 60fps) past the
 * labeled event end, motion-connected to the in-event peak, with every other
 * sample above the in-event peak inside the event. At the resolution of the
 * measurement that apex is indistinguishable from an in-event apex. v2.4
 * adopts the strongest motion-connected margin sample as the apex ONLY when
 * every motion-connected margin sample above the in-event peak lies within
 * one median inter-sample gap of the boundary; a swing whose excess extends
 * farther out genuinely spills past the label and still abstains
 * (PHASE_PEAK_OUTSIDE_EVENT — the v2.3 spill-over fixture is unchanged).
 * Rest-separated margin motion is never adopted.
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

/** Two Gaussian swing bursts: sum of bumps (shared 0.08 floor, not doubled). */
function twoBursts(
  a: { peakMs: number; height: number; halfWidthMs: number },
  b: { peakMs: number; height: number; halfWidthMs: number },
  fromMs: number,
  toMs: number,
  stepMs = 40,
): Array<{ timestampMs: number; value: number }> {
  const series: Array<{ timestampMs: number; value: number }> = [];
  for (let t = fromMs; t <= toMs; t += stepMs) {
    series.push({
      timestampMs: t,
      value:
        0.08 +
        a.height * Math.exp(-0.5 * ((t - a.peakMs) / a.halfWidthMs) ** 2) +
        b.height * Math.exp(-0.5 * ((t - b.peakMs) / b.halfWidthMs) ** 2),
    });
  }
  return series;
}

function expectOrderedAnchorFree(outcome: ReturnType<typeof segmentPhasesTemporalV2>): void {
  if (outcome.status !== "segmented")
    throw new Error(`expected segmentation, got ${outcome.reason}`);
  const b = outcome.boundaries;
  expect(b.version).toBe(PHASE_TEMPORAL_V2_ANCHOR_FREE_VERSION);
  expect(b.anchorBasis).toBe("event_peak");
  expect(Number.isFinite(b.contactMs)).toBe(false);
  if (b.preparationStartMs !== null) {
    expect(b.preparationStartMs).toBeLessThanOrEqual(b.accelerationStartMs);
  }
  expect(b.accelerationStartMs).toBeLessThan(b.motionPeakMs!);
  expect(b.followThroughEndMs).toBeGreaterThan(b.motionPeakMs!);
  if (b.recoveryEndMs !== null) {
    expect(b.recoveryEndMs).toBeGreaterThanOrEqual(b.followThroughEndMs);
  }
  expect(checkArtifactInvariants(jsonRoundTrip(b))).toEqual([]);
}

describe("E04 — burst-aware apex ownership (neighboring-stroke margin motion, synthetic)", () => {
  it("a STRONGER rest-separated neighboring burst in the margin no longer blocks a decisive in-event apex", () => {
    // Event owns a clean apex at 1500; the next stroke (stronger, 2050) sits
    // in the margin, with the series near rest between them — the committed
    // dense-dink-rally pattern that abstained PHASE_PEAK_OUTSIDE_EVENT in v2.2.
    const series = twoBursts(
      { peakMs: 1500, height: 1.0, halfWidthMs: 80 },
      { peakMs: 2050, height: 1.6, halfWidthMs: 80 },
      1000,
      2100,
    );
    const outcome = segmentPhasesTemporalV2({
      event: { startMs: 1200, endMs: 1800 },
      contactMs: null,
      paddleSpeeds: series,
      wristSpeeds: null,
    });
    expectOrderedAnchorFree(outcome);
    if (outcome.status !== "segmented") return;
    expect(Math.abs(outcome.boundaries.motionPeakMs! - 1500)).toBeLessThanOrEqual(40);
  });

  it("a stronger margin peak MOTION-CONNECTED to the apex is the same swing spilling out ⇒ still abstains", () => {
    // One wide swing whose apex lies 60ms past the event end: the margin max
    // is connected to the in-event maximum above the accel threshold.
    const series = bump(1860, 1.4, 200, 1000, 2160);
    const outcome = segmentPhasesTemporalV2({
      event: { startMs: 1200, endMs: 1800 },
      contactMs: null,
      paddleSpeeds: series,
      wristSpeeds: null,
    });
    expect(outcome.status).toBe("abstained");
    if (outcome.status !== "abstained") return;
    expect(outcome.reason).toContain("PHASE_PEAK_OUTSIDE_EVENT");
  });

  it("a NEAR-EQUAL rest-separated neighboring burst in the margin is not a rival ⇒ segments", () => {
    const series = twoBursts(
      { peakMs: 1500, height: 1.2, halfWidthMs: 80 },
      { peakMs: 2050, height: 1.15, halfWidthMs: 80 },
      1000,
      2100,
    );
    const outcome = segmentPhasesTemporalV2({
      event: { startMs: 1200, endMs: 1800 },
      contactMs: null,
      paddleSpeeds: series,
      wristSpeeds: null,
    });
    expectOrderedAnchorFree(outcome);
  });

  it("a near-equal margin rival motion-connected to the apex (no rest between) ⇒ still PHASE_PEAK_NOT_UNIQUE", () => {
    // Two near-equal narrow peaks bridged by a plateau ABOVE the accel
    // threshold (0.25 × the smaller peak ≈ 0.30): never rest-separated, so
    // the margin peak remains a rival; the long quiet lead-in keeps the local
    // median low so the prominence gate does not fire first.
    const series: Array<{ timestampMs: number; value: number }> = [];
    for (let t = 600; t <= 2100; t += 40) {
      const bridged = t > 1500 && t < 2050 ? 0.4 : 0;
      series.push({
        timestampMs: t,
        value:
          0.08 +
          Math.max(
            bridged,
            1.2 * Math.exp(-0.5 * ((t - 1500) / 60) ** 2),
            1.15 * Math.exp(-0.5 * ((t - 2050) / 60) ** 2),
          ),
      });
    }
    const outcome = segmentPhasesTemporalV2({
      event: { startMs: 1200, endMs: 1800 },
      contactMs: null,
      paddleSpeeds: series,
      wristSpeeds: null,
    });
    expect(outcome.status).toBe("abstained");
    if (outcome.status !== "abstained") return;
    expect(outcome.reason).toContain("PHASE_PEAK_NOT_UNIQUE");
  });

  it("near-equal rival peaks INSIDE the event always contest, rest-separated or not ⇒ PHASE_PEAK_NOT_UNIQUE", () => {
    const series = twoBursts(
      { peakMs: 1400, height: 1.2, halfWidthMs: 70 },
      { peakMs: 1900, height: 1.15, halfWidthMs: 70 },
      1000,
      2300,
    );
    const outcome = segmentPhasesTemporalV2({
      event: { startMs: 1100, endMs: 2200 },
      contactMs: null,
      paddleSpeeds: series,
      wristSpeeds: null,
    });
    expect(outcome.status).toBe("abstained");
    if (outcome.status !== "abstained") return;
    expect(outcome.reason).toContain("PHASE_PEAK_NOT_UNIQUE");
  });

  it("an apex ONE SAMPLE past the event boundary, motion-connected, is adopted ≡ measurement resolution ⇒ segments around it", () => {
    // Narrow swing whose apex sample (1840) sits 30ms past the event end with
    // a 40ms sampling interval; the only sample above the in-event peak is
    // that apex sample — the committed marne-dig pattern.
    const series = bump(1840, 1.4, 60, 1000, 2110);
    const outcome = segmentPhasesTemporalV2({
      event: { startMs: 1200, endMs: 1810 },
      contactMs: null,
      paddleSpeeds: series,
      wristSpeeds: null,
    });
    expectOrderedAnchorFree(outcome);
    if (outcome.status !== "segmented") return;
    expect(outcome.boundaries.motionPeakMs).toBe(1840);
  });

  it("a connected excess extending BEYOND one sampling interval is a real spillover ⇒ still PHASE_PEAK_OUTSIDE_EVENT", () => {
    // Wide swing peaking 70ms past the event end: samples above the in-event
    // peak sit at +30ms AND +70ms out — the apex is resolvably outside.
    const series = bump(1880, 1.4, 200, 1000, 2180);
    const outcome = segmentPhasesTemporalV2({
      event: { startMs: 1200, endMs: 1810 },
      contactMs: null,
      paddleSpeeds: series,
      wristSpeeds: null,
    });
    expect(outcome.status).toBe("abstained");
    if (outcome.status !== "abstained") return;
    expect(outcome.reason).toContain("PHASE_PEAK_OUTSIDE_EVENT");
  });

  it("a stronger REST-SEPARATED neighbor one sample past the boundary is never adopted ⇒ segments around the in-event apex", () => {
    const series = twoBursts(
      { peakMs: 1500, height: 1.0, halfWidthMs: 60 },
      { peakMs: 1840, height: 1.6, halfWidthMs: 20 },
      1000,
      2110,
    );
    const outcome = segmentPhasesTemporalV2({
      event: { startMs: 1200, endMs: 1810 },
      contactMs: null,
      paddleSpeeds: series,
      wristSpeeds: null,
    });
    expectOrderedAnchorFree(outcome);
    if (outcome.status !== "segmented") return;
    expect(Math.abs(outcome.boundaries.motionPeakMs! - 1500)).toBeLessThanOrEqual(40);
  });

  it("fuzz: 300 seeded near-boundary apexes — every segmented output is ordered and invariant-clean", () => {
    let segmented = 0;
    let abstained = 0;
    for (let seed = 0; seed < 300; seed += 1) {
      let state = seed * 1103515245 + 12345;
      const rand = () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 2 ** 32;
      };
      const apexOffsetMs = Math.floor((rand() - 0.5) * 200); // ±100ms around the event end
      const height = 0.7 + rand() * 1.5;
      const width = 40 + rand() * 160;
      const stepMs = 20 + Math.floor(rand() * 30);
      const endMs = 1800 + Math.floor(rand() * 30);
      const series = bump(endMs + apexOffsetMs, height, width, 1000, endMs + 320, stepMs);
      const outcome = segmentPhasesTemporalV2({
        event: { startMs: 1200, endMs },
        contactMs: null,
        paddleSpeeds: series,
        wristSpeeds: null,
      });
      if (outcome.status === "segmented") {
        segmented += 1;
        expectOrderedAnchorFree(outcome);
      } else {
        abstained += 1;
        expect(outcome.reason.length).toBeGreaterThan(0);
      }
    }
    expect(segmented + abstained).toBe(300);
    expect(segmented).toBeGreaterThan(0);
    expect(abstained).toBeGreaterThan(0);
  });

  it("fuzz: 300 seeded two-burst rallies — every segmented output is ordered and invariant-clean", () => {
    let segmented = 0;
    let abstained = 0;
    for (let seed = 0; seed < 300; seed += 1) {
      // deterministic LCG
      let state = seed * 2654435761 + 1;
      const rand = () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 2 ** 32;
      };
      const apexHeight = 0.7 + rand() * 1.5;
      const neighborHeight = 0.7 + rand() * 1.5;
      const gapMs = 400 + Math.floor(rand() * 500);
      const width = 60 + rand() * 60;
      const series = twoBursts(
        { peakMs: 1500, height: apexHeight, halfWidthMs: width },
        { peakMs: 1500 + gapMs, height: neighborHeight, halfWidthMs: width },
        900,
        1500 + gapMs + 300,
      );
      const outcome = segmentPhasesTemporalV2({
        event: { startMs: 1200, endMs: 1800 },
        contactMs: null,
        paddleSpeeds: series,
        wristSpeeds: null,
      });
      if (outcome.status === "segmented") {
        segmented += 1;
        expectOrderedAnchorFree(outcome);
      } else {
        abstained += 1;
        expect(outcome.reason.length).toBeGreaterThan(0);
      }
    }
    expect(segmented + abstained).toBe(300);
    // The fuzz is a validity net, not a coverage target: at least some
    // rest-separated neighbor configurations must segment.
    expect(segmented).toBeGreaterThan(0);
  });
});
