import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EVAL_OUT_DIR,
  G05_COMMITTED_PATH,
  G05_VOLATILE_KEYS,
  acceptArtifactsRequested,
  buildG05Artifact,
  comparableView,
  currentCommit,
  formatGateViolations,
  g05FixtureMetrics,
  g05GatedMetrics,
  g05GoldMetrics,
  g05Measure,
  readJsonArtifact,
  regressionGateViolations,
  staleArtifactMessage,
  writeJsonArtifact,
  type G05Artifact,
} from "./contactGoldArtifacts.js";

/**
 * WAVE-G g05 — before/after measurement of the ownership-conditioned contact
 * posterior (flag-gated, default OFF).
 *
 * BEFORE = flag OFF (shipped default).
 * AFTER  = flag ON with ownership confidence derived by
 *          paddleOwnershipFromHandAffinity (hand affinity × kinematic
 *          coherence) — null (unmeasured) when no paddle track exists.
 *
 * Slices:
 * - ALL synthetic adversarial contact fixtures (synthetic math tests, not
 *   human truth; confident-wrong = error > 150ms AND confidence ≥ 0.6, same
 *   thresholds as the red-team suite).
 * - Replayable committed contact gold (LINUX-CPU, committed pose,
 *   ORACLE-BALL, NO paddle track — so the paddle-conditioned path cannot
 *   fire; disclosed, and measured anyway to prove no regression). Grouped by
 *   bundle/session, held-out cases never read. Wrong marker = error > 132ms.
 *
 * The fresh measurement is written to the untracked EVAL_OUT_DIR and gated
 * against the committed artifact (see contactGoldArtifacts.ts); the
 * committed artifact is rewritten only with PICKLE_EVAL_ACCEPT_ARTIFACTS=1.
 */

describe("g05 ownership-conditioned posterior before/after", () => {
  it("measures all adversarial fixtures + committed gold and gates against the committed artifact", () => {
    const measurement = g05Measure();
    const { fixturesBefore, fixturesAfter, goldBefore, goldAfter } = measurement;
    const { foreignBefore, foreignAfter, genuineAfter } = measurement;

    const committed = readJsonArtifact<G05Artifact>(G05_COMMITTED_PATH);
    const accepted = committed.acceptedRegressions ?? [];
    const fresh = buildG05Artifact(measurement, {
      acceptedRegressions: accepted,
      commit: currentCommit(),
      dateUtc: new Date().toISOString(),
    });
    writeJsonArtifact(join(EVAL_OUT_DIR, "g05-f09-posterior-eval.json"), fresh);

    // Gold has no paddle track: conditioning must be a strict no-op there.
    expect(g05GoldMetrics(goldAfter)).toEqual(g05GoldMetrics(goldBefore));
    // The broad fixture slice must not regress.
    expect(g05FixtureMetrics(fixturesAfter).confidentWrong).toBeLessThanOrEqual(
      g05FixtureMetrics(fixturesBefore).confidentWrong,
    );
    // The pinned F3 residual is confident-wrong before and must not be after.
    expect(foreignBefore.confidentWrong).toBe(true);
    expect(foreignAfter.confidentWrong).toBe(false);
    // The genuine paddle must stay near-truth and paddle-confirmed.
    expect(genuineAfter.status).toBe("estimated");
    expect(genuineAfter.errorMs!).toBeLessThanOrEqual(66);
    expect(genuineAfter.paddleConfirmed).toBe(true);

    // Ratchet on the conditioned gold slice against the committed artifact.
    const violations = regressionGateViolations(
      g05GatedMetrics(committed),
      g05GatedMetrics(fresh),
      accepted,
    );
    expect(violations, formatGateViolations("g05", violations)).toEqual([]);

    if (acceptArtifactsRequested()) {
      writeJsonArtifact(G05_COMMITTED_PATH, fresh);
      return;
    }
    expect(
      comparableView(committed, G05_VOLATILE_KEYS),
      staleArtifactMessage("g05", G05_COMMITTED_PATH),
    ).toStrictEqual(comparableView(fresh, G05_VOLATILE_KEYS));
  });
});
