import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateAdversarialContactFixtures } from "@pickle/evaluation";
import {
  estimateContact,
  paddleOwnershipFromHandAffinity,
  CONTACT_ESTIMATOR_VERSION,
  CONTACT_OWNERSHIP_POSTERIOR_VERSION,
} from "../src/index.js";
import { quantile, replayAll, type ReplayRow } from "./contactGoldReplay.js";
import {
  foreignPaddleScene,
  genuinePaddleScene,
  type OwnershipScene,
} from "../test/ownershipScenes.js";

/**
 * WAVE-G g05 — before/after measurement of the ownership-conditioned contact
 * posterior (flag-gated, default OFF).
 *
 * BEFORE = flag OFF (current contact-evidence-4.3 behavior).
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
 */

const REPO = join(import.meta.dirname, "../../..");
const OUT_DIR = join(REPO, "datasets/experiments/wave-g");

const CONFIDENT_WRONG_ERROR_MS = 150;
const CONFIDENT_WRONG_CONFIDENCE = 0.6;
const GOLD_ACCEPT_MS = 132;
const GOLD_STRICT_MS = 66;

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

interface FixtureRow {
  id: string;
  family: string;
  expectation: string;
  ownershipConfidence: number | null;
  status: "estimated" | "abstained";
  errorMs: number | null;
  confidence: number | null;
  paddleConfirmed: boolean | null;
  confidentWrong: boolean;
}

function runFixtures(conditioned: boolean): FixtureRow[] {
  return generateAdversarialContactFixtures().map((fixture) => {
    const ownership = conditioned
      ? paddleOwnershipFromHandAffinity({
          sequence: fixture.sequence,
          paddleCenters: fixture.paddleCenters,
          targetWrists: fixture.targetWrists,
        })
      : null;
    const estimate = estimateContact({
      sequence: fixture.sequence,
      window: fixture.window,
      ballObservations: fixture.ballObservations,
      paddleSpeeds: fixture.paddleSpeeds,
      paddleCenters: fixture.paddleCenters,
      targetWrists: fixture.targetWrists,
      strokeFamily: fixture.strokeFamily,
      ...(conditioned
        ? {
            ownershipConditionedPosterior: true,
            paddleOwnershipConfidence: ownership?.confidence ?? null,
          }
        : {}),
    });
    if (estimate.status === "abstained") {
      return {
        id: fixture.id,
        family: fixture.family,
        expectation: fixture.expectation,
        ownershipConfidence: ownership ? round3(ownership.confidence) : null,
        status: "abstained",
        errorMs: null,
        confidence: null,
        paddleConfirmed: null,
        confidentWrong: false,
      };
    }
    const errorMs = Math.abs(estimate.estimatedContactMs - fixture.trueContactMs);
    return {
      id: fixture.id,
      family: fixture.family,
      expectation: fixture.expectation,
      ownershipConfidence: ownership ? round3(ownership.confidence) : null,
      status: "estimated",
      errorMs: Math.round(errorMs),
      confidence: round3(estimate.confidence),
      paddleConfirmed: estimate.paddleConfirmed,
      confidentWrong:
        errorMs > CONFIDENT_WRONG_ERROR_MS && estimate.confidence >= CONFIDENT_WRONG_CONFIDENCE,
    };
  });
}

function fixtureMetrics(rows: FixtureRow[]) {
  const estimated = rows.filter((row) => row.status === "estimated");
  const errors = estimated
    .map((row) => row.errorMs!)
    .slice()
    .sort((a, b) => a - b);
  return {
    fixtures: rows.length,
    estimated: estimated.length,
    abstained: rows.length - estimated.length,
    confidentWrong: rows.filter((row) => row.confidentWrong).length,
    nearTruth66: errors.filter((error) => error <= 66).length,
    medianErrorMs: quantile(errors, 0.5),
    p90ErrorMs: quantile(errors, 0.9),
  };
}

function goldMetrics(rows: ReplayRow[]) {
  const target = rows.filter((row) => row.event.owner === "target");
  const estimated = target.filter((row) => row.status === "estimated");
  const errors = estimated
    .map((row) => row.errorMs!)
    .slice()
    .sort((a, b) => a - b);
  return {
    targetEvents: target.length,
    estimated: estimated.length,
    abstained: target.length - estimated.length,
    wrongMarkers: estimated.filter((row) => row.errorMs! > GOLD_ACCEPT_MS).length,
    confidentWrong: estimated.filter(
      (row) =>
        row.errorMs! > CONFIDENT_WRONG_ERROR_MS && row.confidence! >= CONFIDENT_WRONG_CONFIDENCE,
    ).length,
    strictHits66: errors.filter((error) => error <= GOLD_STRICT_MS).length,
    acceptableHits132: errors.filter((error) => error <= GOLD_ACCEPT_MS).length,
    medianErrorMs: quantile(errors, 0.5),
    p90ErrorMs: quantile(errors, 0.9),
  };
}

interface SceneRow {
  ownershipConfidence: number | null;
  status: "estimated" | "abstained";
  errorMs: number | null;
  confidence: number | null;
  ballConfirmed: boolean | null;
  paddleConfirmed: boolean | null;
  confidentWrong: boolean;
  limitingFactors: string[];
}

function runScene(
  scene: OwnershipScene & { ball?: import("@pickle/swing-domain").BallObservation[] },
  conditioned: boolean,
): SceneRow {
  const ownership = conditioned
    ? paddleOwnershipFromHandAffinity({
        sequence: scene.sequence,
        paddleCenters: scene.paddleCenters,
      })
    : null;
  const estimate = estimateContact({
    sequence: scene.sequence,
    window: scene.window,
    ballObservations: scene.ball ?? null,
    paddleSpeeds: scene.paddleSpeeds,
    paddleCenters: scene.paddleCenters,
    ...(conditioned
      ? {
          ownershipConditionedPosterior: true,
          paddleOwnershipConfidence: ownership?.confidence ?? null,
        }
      : {}),
  });
  if (estimate.status === "abstained") {
    return {
      ownershipConfidence: ownership ? round3(ownership.confidence) : null,
      status: "abstained",
      errorMs: null,
      confidence: null,
      ballConfirmed: null,
      paddleConfirmed: null,
      confidentWrong: false,
      limitingFactors: estimate.limitingFactors ?? [],
    };
  }
  const errorMs = Math.abs(estimate.estimatedContactMs - scene.trueContactMs);
  return {
    ownershipConfidence: ownership ? round3(ownership.confidence) : null,
    status: "estimated",
    errorMs: Math.round(errorMs),
    confidence: round3(estimate.confidence),
    ballConfirmed: estimate.ballConfirmed,
    paddleConfirmed: estimate.paddleConfirmed,
    confidentWrong:
      errorMs > CONFIDENT_WRONG_ERROR_MS && estimate.confidence >= CONFIDENT_WRONG_CONFIDENCE,
    limitingFactors: estimate.limitingFactors,
  };
}

describe("g05 ownership-conditioned posterior before/after", () => {
  it("measures all adversarial fixtures + committed gold and writes the artifact", () => {
    const fixturesBefore = runFixtures(false);
    const fixturesAfter = runFixtures(true);
    const goldBefore = replayAll();
    const goldAfter = replayAll({ ownershipConditionedPosterior: true });
    const foreignBefore = runScene(foreignPaddleScene(), false);
    const foreignAfter = runScene(foreignPaddleScene(), true);
    const genuineBefore = runScene(genuinePaddleScene(), false);
    const genuineAfter = runScene(genuinePaddleScene(), true);

    const artifact = {
      experiment: "wave-g g05-f09-posterior before/after",
      dateUtc: new Date().toISOString(),
      estimatorVersion: CONTACT_ESTIMATOR_VERSION,
      posteriorVersion: CONTACT_OWNERSHIP_POSTERIOR_VERSION,
      condition:
        "LINUX-CPU; gold: committed pose + ORACLE-BALL, no paddle track (paddle-conditioned path cannot fire on gold — regression guard only); fixtures: synthetic",
      thresholds: {
        confidentWrongErrorMs: CONFIDENT_WRONG_ERROR_MS,
        confidentWrongConfidence: CONFIDENT_WRONG_CONFIDENCE,
        goldStrictMs: GOLD_STRICT_MS,
        goldAcceptMs: GOLD_ACCEPT_MS,
      },
      adversarialFixtures: {
        before: fixtureMetrics(fixturesBefore),
        after: fixtureMetrics(fixturesAfter),
        rowsBefore: fixturesBefore,
        rowsAfter: fixturesAfter,
      },
      committedGold: {
        before: goldMetrics(goldBefore),
        after: goldMetrics(goldAfter),
      },
      redTeamScenes: {
        note: "e09/f09 F3 residual (foreign paddle WITHIN reach of idle target wrist) + genuine-paddle positive guard; synthetic, outside the fixture generator",
        foreignPaddleWithinReach: { before: foreignBefore, after: foreignAfter },
        genuinePaddle: { before: genuineBefore, after: genuineAfter },
      },
    };

    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
      join(OUT_DIR, "g05-f09-posterior-eval.json"),
      `${JSON.stringify(artifact, null, 2)}\n`,
    );

    // Gold has no paddle track: conditioning must be a strict no-op there.
    expect(goldMetrics(goldAfter)).toEqual(goldMetrics(goldBefore));
    // The broad fixture slice must not regress.
    expect(fixtureMetrics(fixturesAfter).confidentWrong).toBeLessThanOrEqual(
      fixtureMetrics(fixturesBefore).confidentWrong,
    );
    // The pinned F3 residual is confident-wrong before and must not be after.
    expect(foreignBefore.confidentWrong).toBe(true);
    expect(foreignAfter.confidentWrong).toBe(false);
    // The genuine paddle must stay near-truth and paddle-confirmed.
    expect(genuineAfter.status).toBe("estimated");
    expect(genuineAfter.errorMs!).toBeLessThanOrEqual(66);
    expect(genuineAfter.paddleConfirmed).toBe(true);
  });
});
