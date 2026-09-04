import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadGoldEvents, replayAll } from "./contactGoldReplay.js";
import {
  E02_ACCEPT_MS,
  E02_COMMITTED_PATH,
  E02_VOLATILE_KEYS,
  EVAL_OUT_DIR,
  acceptArtifactsRequested,
  buildE02Artifact,
  comparableView,
  currentCommit,
  e02GatedMetrics,
  e02UndisclosedWrongMarkers,
  formatGateViolations,
  readJsonArtifact,
  regressionGateViolations,
  staleArtifactMessage,
  writeJsonArtifact,
  type E02Artifact,
} from "./contactGoldArtifacts.js";

/**
 * WAVE-E E02 — contact localization on the enlarged Wave D contact gold.
 * Grouped by bundle/session (never random-frame splits); held-out cases are
 * never read. Condition: LINUX-CPU, committed pose, ORACLE-BALL, no paddle
 * track (all disclosed in the artifact). Timing contract from the cascade
 * evidence contract: ≤66ms strict, ≤132ms acceptable, >132ms wrong-marker.
 *
 * The fresh measurement is written to the untracked EVAL_OUT_DIR and gated
 * against the committed artifact (see contactGoldArtifacts.ts): gated
 * metrics may not regress beyond what the artifact explicitly accepts, every
 * wrong marker must be disclosed, and the committed artifact must match the
 * fresh run unless PICKLE_EVAL_ACCEPT_ARTIFACTS=1 asks to regenerate it.
 */

describe("wave-e e02: enlarged contact gold replay", () => {
  it("replays all non-held-out gold events and gates against the committed artifact", () => {
    const rows = replayAll();
    const gold = loadGoldEvents();
    expect(gold.length).toBeGreaterThanOrEqual(15);
    expect(rows.length).toBe(gold.length);

    // High-confidence estimates must never be wrong-markers: confidence has
    // to be honest about the evidence, or abstention would be preferable.
    for (const row of rows) {
      if (row.event.owner === "target" && row.status === "estimated" && row.confidence! >= 0.7) {
        expect(row.errorMs!).toBeLessThanOrEqual(E02_ACCEPT_MS);
      }
    }

    const committed = readJsonArtifact<E02Artifact>(E02_COMMITTED_PATH);
    const accepted = committed.acceptedRegressions ?? [];
    const fresh = buildE02Artifact(rows, {
      acceptedRegressions: accepted,
      commit: currentCommit(),
      evaluatedAtIso: new Date().toISOString(),
    });
    writeJsonArtifact(join(EVAL_OUT_DIR, "e02-contact-gold-replay-metrics.json"), fresh);
    const overall = fresh.overall;

    // Absolute floor for the measured condition: raise deliberately.
    expect(overall.wrongMarkerRateOfEstimated ?? 0).toBeLessThanOrEqual(0.25);
    if (overall.medianErrorMs !== null) {
      expect(overall.medianErrorMs).toBeLessThanOrEqual(70);
    }

    // Ratchet: no silent regression inside the floor. The reference is the
    // committed artifact; only an acceptedRegressions entry for the live
    // estimator version can raise a ceiling.
    const violations = regressionGateViolations(
      e02GatedMetrics(committed),
      e02GatedMetrics(fresh),
      accepted,
    );
    expect(violations, formatGateViolations("e02", violations)).toEqual([]);
    expect(e02UndisclosedWrongMarkers(fresh), "e02 wrong markers not disclosed").toEqual([]);

    if (acceptArtifactsRequested()) {
      writeJsonArtifact(E02_COMMITTED_PATH, fresh);
      return;
    }
    expect(
      comparableView(committed, E02_VOLATILE_KEYS),
      staleArtifactMessage("e02", E02_COMMITTED_PATH),
    ).toStrictEqual(comparableView(fresh, E02_VOLATILE_KEYS));
  });
});
