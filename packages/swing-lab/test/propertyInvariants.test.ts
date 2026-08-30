import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  evaluateFrameAnalyzability,
  FRAME_ANALYZABILITY_REASONS,
  type FrameStats,
} from "@pickle/vision-geometry";
import { checkArtifactInvariants } from "../src/invariants.js";
import { runCorpusCheck } from "../src/corpusCheck.js";
import { proposeStrokeEvents, proposeStrokeEventsV2 } from "../src/strokeEvents.js";
import { segmentPhasesTemporalV2 } from "../src/phaseTemporal.js";

/**
 * Property/fuzz suite: temporal invariants over pipeline outputs under
 * seeded random inputs, plus a corpus check over every committed JSON
 * artifact under datasets/. The corpus check REPORTS violations (a real
 * violation is a finding about the data, recorded in the wave-c summary —
 * never silently repaired here).
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Deterministic LCG so every failure is replayable from the seed. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function randomSeries(
  rand: () => number,
  clipEndMs: number,
): Array<{ timestampMs: number; value: number }> {
  const stepMs = 20 + Math.floor(rand() * 30);
  const series: Array<{ timestampMs: number; value: number }> = [];
  let value = rand() * 0.4;
  for (let t = 0; t <= clipEndMs; t += stepMs) {
    value = Math.max(0, value + (rand() - 0.5) * 0.4);
    if (rand() < 0.05) value += rand() * 4; // occasional swing-like spike
    series.push({ timestampMs: t, value });
  }
  return series;
}

const jsonRoundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("property/fuzz: stroke event proposals", () => {
  it("hold temporal invariants across 300 seeded random inputs", () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const rand = rng(seed * 2654435761);
      const clipEndMs = 800 + Math.floor(rand() * 8000);
      const paddle = rand() < 0.3 ? null : randomSeries(rand, clipEndMs);
      const wrist = rand() < 0.2 ? null : randomSeries(rand, clipEndMs);
      for (const proposal of [
        proposeStrokeEvents({
          paddleSpeeds: paddle,
          wristSpeeds: wrist,
          clipStartMs: 0,
          clipEndMs,
        }),
        proposeStrokeEventsV2({
          paddleSpeeds: paddle,
          wristSpeeds: wrist,
          clipStartMs: 0,
          clipEndMs,
        }),
      ]) {
        let lastStart = -Infinity;
        for (const event of proposal.events) {
          expect(event.endMs, `seed ${seed}`).toBeGreaterThanOrEqual(event.startMs);
          expect(event.peakMs, `seed ${seed}`).toBeGreaterThanOrEqual(event.startMs);
          expect(event.peakMs, `seed ${seed}`).toBeLessThanOrEqual(event.endMs);
          expect(Number.isFinite(event.confidence), `seed ${seed}`).toBe(true);
          expect(event.confidence, `seed ${seed}`).toBeGreaterThanOrEqual(0);
          expect(event.confidence, `seed ${seed}`).toBeLessThanOrEqual(1);
          expect(event.startMs, `seed ${seed} time-ordered`).toBeGreaterThanOrEqual(lastStart);
          lastStart = event.startMs;
        }
        const violations = checkArtifactInvariants(jsonRoundTrip(proposal));
        expect(violations, `seed ${seed}: ${JSON.stringify(violations)}`).toEqual([]);
      }
    }
  });
});

describe("property/fuzz: temporal phase segmentation v2", () => {
  it("segmented outputs keep ordering, finite confidences, and never fabricate contact", () => {
    let segmented = 0;
    let anchorFree = 0;
    for (let seed = 1; seed <= 300; seed += 1) {
      const rand = rng(seed * 40503 + 7);
      const clipEndMs = 1500 + Math.floor(rand() * 6000);
      const startMs = Math.floor(rand() * 1000);
      const endMs = startMs + 300 + Math.floor(rand() * 2000);
      const contactMs =
        rand() < 0.4
          ? null
          : startMs + Math.floor(rand() * (endMs - startMs) * 1.4 - (endMs - startMs) * 0.2);
      const peakMs = rand() < 0.5 ? undefined : startMs + Math.floor(rand() * (endMs - startMs));
      const outcome = segmentPhasesTemporalV2({
        event: peakMs === undefined ? { startMs, endMs } : { startMs, endMs, peakMs },
        contactMs,
        paddleSpeeds: rand() < 0.3 ? null : randomSeries(rand, clipEndMs),
        wristSpeeds: rand() < 0.3 ? null : randomSeries(rand, clipEndMs),
      });
      if (outcome.status !== "segmented") {
        expect(
          outcome.reason.length,
          `seed ${seed}: abstention must carry a reason`,
        ).toBeGreaterThan(0);
        continue;
      }
      segmented += 1;
      const b = outcome.boundaries;
      expect(Number.isFinite(b.confidence), `seed ${seed}`).toBe(true);
      expect(b.version.length, `seed ${seed}`).toBeGreaterThan(0);
      if (b.anchorBasis === "event_peak") {
        anchorFree += 1;
        expect(Number.isNaN(b.contactMs), `seed ${seed}: anchor-free must not carry contact`).toBe(
          true,
        );
      } else {
        expect(Number.isFinite(b.contactMs), `seed ${seed}`).toBe(true);
      }
      const violations = checkArtifactInvariants(jsonRoundTrip(b));
      expect(violations, `seed ${seed}: ${JSON.stringify(violations)}`).toEqual([]);
    }
    // The fuzz must actually exercise both segmentation modes.
    expect(segmented).toBeGreaterThan(10);
    expect(anchorFree).toBeGreaterThan(0);
  });
});

describe("property/fuzz: frame analyzability gate", () => {
  it("is total and emits only registered reason codes over 500 random stats", () => {
    const registry = new Set<string>(FRAME_ANALYZABILITY_REASONS);
    for (let seed = 1; seed <= 500; seed += 1) {
      const rand = rng(seed * 9176 + 13);
      const frameCount = Math.floor(rand() * 200);
      const stats: FrameStats = {
        frameCount,
        durationMs: Math.floor(rand() * 20 * 60 * 1000),
        width: 64,
        height: 36,
        interFrameDiffs: Array.from({ length: Math.max(0, frameCount - 1) }, () => rand() * 30),
        spatialLumaStd: Array.from({ length: frameCount }, () => rand() * 80),
        letterboxRowFraction: rand(),
      };
      const report = evaluateFrameAnalyzability(stats);
      expect(report.analyzable).toBe(report.reasons.length === 0);
      for (const reason of report.reasons) expect(registry.has(reason), reason).toBe(true);
      for (const value of Object.values(report.stats)) expect(Number.isFinite(value)).toBe(true);
    }
  });
});

describe("invariant checker detects seeded violations", () => {
  it("flags each violation family", () => {
    const rules = (value: unknown) => checkArtifactInvariants(value).map((v) => v.rule);
    expect(rules({ startMs: 100, endMs: 50 })).toContain("negative_duration");
    expect(rules({ confidence: Number.NaN })).toContain("non_finite_confidence");
    expect(rules({ confidence: 1.7 })).toContain("confidence_out_of_unit_range");
    expect(rules({ startMs: 0, endMs: 100, contactMs: 300 })).toContain("contact_outside_event");
    expect(
      rules({
        version: "phase.test",
        source: "paddle",
        accelerationStartMs: 500,
        contactMs: 400,
        followThroughEndMs: 700,
      }),
    ).toContain("phase_ordering_invalid");
    expect(
      rules({
        version: "phase.test",
        source: "wrist",
        anchorBasis: "event_peak",
        accelerationStartMs: 100,
        contactMs: 200,
        followThroughEndMs: 300,
      }),
    ).toContain("anchor_free_contact_conflation");
    expect(rules({ producedBy: { providerId: "" } })).toContain("provenance_missing");
    expect(
      rules({
        confidence: 0.5,
        accelerationStartMs: 100,
        contactMs: 200,
        followThroughEndMs: 300,
      }),
    ).toContain("provenance_missing");
    expect(rules({ resolutionBasis: "declared", declaredStroke: null })).toContain(
      "predicted_declared_conflation",
    );
    expect(rules({ resolutionBasis: "predicted_l3", predictedStroke: null })).toContain(
      "predicted_declared_conflation",
    );
  });

  it("accepts clean shapes", () => {
    expect(
      checkArtifactInvariants({
        startMs: 0,
        endMs: 500,
        contactMs: 250,
        confidence: 0.8,
        producedBy: { providerId: "p", modelVersion: "v1" },
      }),
    ).toEqual([]);
  });
});

describe("corpus check over committed datasets/ artifacts", () => {
  // 120s: on a Mac with the regenerated canonical run dirs present (gitignored,
  // absent on Linux CI) the scan covers ~1257 files and takes ~55s — same
  // no-assertion-change timeout raise as the h17 ffmpeg tests.
  it(
    "scans the corpus and reports (never repairs) violations",
    () => {
      const report = runCorpusCheck(join(ROOT, "datasets"));
      expect(report.filesChecked).toBeGreaterThan(200);
      expect(report.parseFailures).toEqual([]);
      const byRule = new Map<string, number>();
      for (const violation of report.violations) {
        byRule.set(violation.rule, (byRule.get(violation.rule) ?? 0) + 1);
      }
      // Findings are reported, not asserted away: the count is logged for the
      // wave-c summary; the check only guarantees the corpus was scanned.
      console.log(
        `corpus check: ${report.filesChecked} files, ${report.violations.length} violations`,
        Object.fromEntries(byRule),
      );
    },
    120_000,
  );
});
