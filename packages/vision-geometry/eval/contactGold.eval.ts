import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { CONTACT_ESTIMATOR_VERSION } from "../src/index.js";
import { loadGoldEvents, quantile, replayAll, type ReplayRow } from "./contactGoldReplay.js";

/**
 * WAVE-E E02 — contact localization on the enlarged Wave D contact gold.
 * Grouped by bundle/session (never random-frame splits); held-out cases are
 * never read. Condition: LINUX-CPU, committed pose, ORACLE-BALL, no paddle
 * track (all disclosed in the artifact). Timing contract from the cascade
 * evidence contract: ≤66ms strict, ≤132ms acceptable, >132ms wrong-marker.
 */

const REPO = join(import.meta.dirname, "../../..");
const OUT_DIR = join(REPO, "datasets/experiments/wave-e");

const STRICT_MS = 66;
const ACCEPT_MS = 132;

function metricsFor(rows: ReplayRow[]) {
  const target = rows.filter((row) => row.event.owner === "target");
  const estimated = target.filter((row) => row.status === "estimated");
  const errors = estimated
    .map((row) => row.errorMs!)
    .slice()
    .sort((a, b) => a - b);
  const wrong = estimated.filter((row) => row.errorMs! > ACCEPT_MS);
  return {
    targetEvents: target.length,
    estimated: estimated.length,
    abstained: target.length - estimated.length,
    coverage: target.length > 0 ? round3(estimated.length / target.length) : null,
    abstentionRate: target.length > 0 ? round3(1 - estimated.length / target.length) : null,
    wrongMarkers: wrong.length,
    wrongMarkerRateOfEstimated:
      estimated.length > 0 ? round3(wrong.length / estimated.length) : null,
    strictHits: errors.filter((error) => error <= STRICT_MS).length,
    acceptableHits: errors.filter((error) => error <= ACCEPT_MS).length,
    medianErrorMs: roundOrNull(quantile(errors, 0.5)),
    p75ErrorMs: roundOrNull(quantile(errors, 0.75)),
    p90ErrorMs: roundOrNull(quantile(errors, 0.9)),
  };
}

function confidenceConditioned(rows: ReplayRow[]) {
  const estimated = rows.filter(
    (row) => row.event.owner === "target" && row.status === "estimated",
  );
  const bins = [
    { label: "conf<0.5", min: 0, max: 0.5 },
    { label: "0.5≤conf<0.7", min: 0.5, max: 0.7 },
    { label: "conf≥0.7", min: 0.7, max: 1.01 },
  ];
  return bins.map((bin) => {
    const inBin = estimated.filter(
      (row) => row.confidence! >= bin.min && row.confidence! < bin.max,
    );
    const errors = inBin.map((row) => row.errorMs!).sort((a, b) => a - b);
    return {
      bin: bin.label,
      n: inBin.length,
      medianErrorMs: roundOrNull(quantile(errors, 0.5)),
      maxErrorMs: errors.length > 0 ? Math.round(errors[errors.length - 1]!) : null,
      wrongMarkers: errors.filter((error) => error > ACCEPT_MS).length,
    };
  });
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
function roundOrNull(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

describe("wave-e e02: enlarged contact gold replay", () => {
  it("replays all non-held-out gold events and writes the metrics artifact", () => {
    const rows = replayAll();
    const gold = loadGoldEvents();
    expect(gold.length).toBeGreaterThanOrEqual(15);
    expect(rows.length).toBe(gold.length);

    const overall = metricsFor(rows);
    const sessions = [...new Set(rows.map((row) => row.event.session))].sort();
    const bySession = Object.fromEntries(
      sessions.map((session) => [
        session,
        metricsFor(rows.filter((row) => row.event.session === session)),
      ]),
    );
    const bundles = [...new Set(rows.map((row) => row.event.bundle))].sort();
    const byBundle = Object.fromEntries(
      bundles.map((bundle) => [
        bundle,
        metricsFor(rows.filter((row) => row.event.bundle === bundle)),
      ]),
    );

    // High-confidence estimates must never be wrong-markers: confidence has
    // to be honest about the evidence, or abstention would be preferable.
    for (const row of rows) {
      if (row.event.owner === "target" && row.status === "estimated" && row.confidence! >= 0.7) {
        expect(row.errorMs!).toBeLessThanOrEqual(ACCEPT_MS);
      }
    }

    const artifact = {
      experiment: "e02-contact-transfer",
      estimatorVersion: CONTACT_ESTIMATOR_VERSION,
      commit: execSync("git rev-parse HEAD", { cwd: REPO }).toString().trim(),
      evaluatedAtIso: new Date().toISOString(),
      condition: {
        platform: "linux-cpu",
        pose: "committed runs-wave-a people.json (auto target policy)",
        ball: "ORACLE (visually verified gold annotation frames, conf 0.9) — measures temporal fusion, NOT the ball tracker",
        paddle:
          "ABSENT (no committed paddle track for these bundles; wrist-gate proxy path exercised)",
        heldOut: "wm-dink-01 and afn-vic-rally1 never read",
        grouping: "bundle/session (no random-frame splits)",
        toleranceMs: { strict: STRICT_MS, acceptable: ACCEPT_MS },
      },
      overall,
      confidenceConditioned: confidenceConditioned(rows),
      bySession,
      byBundle,
      rows: rows.map((row) => ({
        bundle: row.event.bundle,
        session: row.event.session,
        goldContactMs: row.event.contactMs,
        owner: row.event.owner,
        family: row.event.family,
        status: row.status,
        estimatedContactMs: row.estimatedContactMs,
        confidence: row.confidence,
        errorMs: row.errorMs === null ? null : Math.round(row.errorMs),
        reason: row.reason,
        limitingFactors: row.limitingFactors,
        ballConfirmed: row.ballConfirmed,
        supportingEvidence: row.supportingEvidence,
      })),
    };
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
      join(OUT_DIR, "e02-contact-gold-replay-metrics.json"),
      JSON.stringify(artifact, null, 2) + "\n",
    );

    // Regression floor for the measured condition: raise deliberately.
    expect(overall.wrongMarkerRateOfEstimated ?? 0).toBeLessThanOrEqual(0.25);
    if (overall.medianErrorMs !== null) {
      expect(overall.medianErrorMs).toBeLessThanOrEqual(70);
    }
  });
});
