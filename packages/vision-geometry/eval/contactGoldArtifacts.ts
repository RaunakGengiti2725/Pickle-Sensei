import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { execSync } from "node:child_process";
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
 * Committed contact-gold artifacts (WAVE-E e02, WAVE-G g05) and the contract
 * that keeps them honest.
 *
 * Every `pnpm --filter @pickle/vision-geometry eval` run writes its fresh
 * measurement to the gitignored `artifacts/vision-geometry-eval/` directory
 * and then compares it with the committed artifact under `datasets/`. The
 * committed artifact is rewritten ONLY when `PICKLE_EVAL_ACCEPT_ARTIFACTS=1`
 * is set, and never when the fresh run regresses a gated metric beyond what
 * the artifact's `acceptedRegressions` explicitly accept for the current
 * estimator version. `@pickle/evaluation`'s unit tests replay the same
 * builders against the committed files, so CI fails when an estimator change
 * ships without regenerating them.
 */

export const REPO_ROOT = join(import.meta.dirname, "../../..");
export const EVAL_OUT_DIR = join(REPO_ROOT, "artifacts/vision-geometry-eval");
export const E02_COMMITTED_PATH = join(
  REPO_ROOT,
  "datasets/experiments/wave-e/e02-contact-gold-replay-metrics.json",
);
export const G05_COMMITTED_PATH = join(
  REPO_ROOT,
  "datasets/experiments/wave-g/g05-f09-posterior-eval.json",
);

export const ACCEPT_ARTIFACTS_ENV = "PICKLE_EVAL_ACCEPT_ARTIFACTS";
export const REGENERATE_COMMAND = `${ACCEPT_ARTIFACTS_ENV}=1 pnpm --filter @pickle/vision-geometry eval`;

export function acceptArtifactsRequested(): boolean {
  return process.env[ACCEPT_ARTIFACTS_ENV] === "1";
}

/** Gated headline metrics: a fresh run may never be worse than the committed
 * artifact on these unless the artifact accepts it (see AcceptedRegression). */
export const GATED_METRICS = ["wrongMarkers", "medianErrorMs"] as const;
export type GatedMetric = (typeof GATED_METRICS)[number];
export type GatedMetrics = Record<GatedMetric, number | null>;

/**
 * An explicitly reviewed regression of the gated metrics. Applies only while
 * `estimatorVersion` is the live CONTACT_ESTIMATOR_VERSION: the next estimator
 * inherits the (already worse) committed numbers as its reference, so a stale
 * acceptance can never mask a later regression.
 */
export interface AcceptedRegression {
  estimatorVersion: string;
  /** Metric ceilings the fresh run may reach without failing the gate. */
  ceiling: Partial<Record<GatedMetric, number>>;
  /** Per-row description of what moved (bundle@goldContactMs, before → after). */
  rows: string[];
  rationale: string;
  /** Optional provenance: what introduced the delta and what it was measured against. */
  introducedBy?: string;
  versus?: { estimatorVersion: string; commit?: string };
}

export interface RegressionGateViolation {
  metric: GatedMetric;
  committed: number;
  fresh: number;
  allowed: number;
}

/**
 * Fresh must be ≤ committed for every gated metric, or ≤ the ceiling an
 * AcceptedRegression for the live estimator version declares. A `null`
 * (not measurable) side is never compared — it is not zero.
 */
export function regressionGateViolations(
  committed: GatedMetrics,
  fresh: GatedMetrics,
  accepted: readonly AcceptedRegression[],
  estimatorVersion: string = CONTACT_ESTIMATOR_VERSION,
): RegressionGateViolation[] {
  const violations: RegressionGateViolation[] = [];
  for (const metric of GATED_METRICS) {
    const before = committed[metric];
    const after = fresh[metric];
    if (before === null || after === null) continue;
    let allowed = before;
    for (const entry of accepted) {
      if (entry.estimatorVersion !== estimatorVersion) continue;
      const ceiling = entry.ceiling[metric];
      if (ceiling !== undefined && ceiling > allowed) allowed = ceiling;
    }
    if (after > allowed) violations.push({ metric, committed: before, fresh: after, allowed });
  }
  return violations;
}

export function formatGateViolations(
  label: string,
  violations: readonly RegressionGateViolation[],
): string {
  const lines = violations.map(
    (v) => `  ${v.metric}: committed ${v.committed} → fresh ${v.fresh} (allowed ≤ ${v.allowed})`,
  );
  return [
    `${label}: the fresh run regresses gated metrics beyond the committed artifact.`,
    ...lines,
    `Fix the estimator, or record the regression with a rationale under "acceptedRegressions"`,
    `(estimatorVersion "${CONTACT_ESTIMATOR_VERSION}") in the committed artifact and re-run`,
    `  ${REGENERATE_COMMAND}`,
  ].join("\n");
}

export function readJsonArtifact<T>(path: string): T {
  if (!existsSync(path)) {
    throw new Error(`committed artifact missing: ${relative(REPO_ROOT, path)}`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJsonArtifact(path: string, artifact: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
}

export function currentCommit(): string {
  return execSync("git rev-parse HEAD", { cwd: REPO_ROOT }).toString().trim();
}

/** Strip the run-specific fields so two runs of the same code compare equal. */
export function comparableView<T extends object>(artifact: T, volatileKeys: readonly string[]): T {
  const copy = { ...artifact } as Record<string, unknown>;
  for (const key of volatileKeys) delete copy[key];
  return copy as T;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
function roundOrNull(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

// ---------------------------------------------------------------------------
// WAVE-E e02 — contact localization on the enlarged Wave D contact gold.
// Timing contract from the cascade evidence contract: ≤66ms strict,
// ≤132ms acceptable, >132ms wrong-marker.
// ---------------------------------------------------------------------------

export const E02_STRICT_MS = 66;
export const E02_ACCEPT_MS = 132;
export const E02_VOLATILE_KEYS = ["commit", "evaluatedAtIso"] as const;

export function e02MetricsFor(rows: ReplayRow[]) {
  const target = rows.filter((row) => row.event.owner === "target");
  const estimated = target.filter((row) => row.status === "estimated");
  const errors = estimated
    .map((row) => row.errorMs!)
    .slice()
    .sort((a, b) => a - b);
  const wrong = estimated.filter((row) => row.errorMs! > E02_ACCEPT_MS);
  return {
    targetEvents: target.length,
    estimated: estimated.length,
    abstained: target.length - estimated.length,
    coverage: target.length > 0 ? round3(estimated.length / target.length) : null,
    abstentionRate: target.length > 0 ? round3(1 - estimated.length / target.length) : null,
    wrongMarkers: wrong.length,
    wrongMarkerRateOfEstimated:
      estimated.length > 0 ? round3(wrong.length / estimated.length) : null,
    strictHits: errors.filter((error) => error <= E02_STRICT_MS).length,
    acceptableHits: errors.filter((error) => error <= E02_ACCEPT_MS).length,
    medianErrorMs: roundOrNull(quantile(errors, 0.5)),
    p75ErrorMs: roundOrNull(quantile(errors, 0.75)),
    p90ErrorMs: roundOrNull(quantile(errors, 0.9)),
  };
}

function e02ConfidenceConditioned(rows: ReplayRow[]) {
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
      wrongMarkers: errors.filter((error) => error > E02_ACCEPT_MS).length,
    };
  });
}

export interface E02Row {
  bundle: string;
  session: string;
  goldContactMs: number;
  owner: ReplayRow["event"]["owner"];
  family: ReplayRow["event"]["family"];
  status: ReplayRow["status"];
  estimatedContactMs: number | null;
  confidence: number | null;
  errorMs: number | null;
  reason: ReplayRow["reason"];
  limitingFactors: ReplayRow["limitingFactors"];
  ballConfirmed: ReplayRow["ballConfirmed"];
  supportingEvidence: ReplayRow["supportingEvidence"];
}

export interface E02Artifact {
  experiment: "e02-contact-transfer";
  estimatorVersion: string;
  commit: string;
  evaluatedAtIso: string;
  regenerate: string;
  condition: Record<string, unknown>;
  acceptedRegressions: AcceptedRegression[];
  overall: ReturnType<typeof e02MetricsFor>;
  confidenceConditioned: ReturnType<typeof e02ConfidenceConditioned>;
  bySession: Record<string, ReturnType<typeof e02MetricsFor>>;
  byBundle: Record<string, ReturnType<typeof e02MetricsFor>>;
  rows: E02Row[];
}

export function buildE02Artifact(
  rows: ReplayRow[],
  options: {
    acceptedRegressions: readonly AcceptedRegression[];
    commit: string;
    evaluatedAtIso: string;
  },
): E02Artifact {
  const sessions = [...new Set(rows.map((row) => row.event.session))].sort();
  const bundles = [...new Set(rows.map((row) => row.event.bundle))].sort();
  return {
    experiment: "e02-contact-transfer",
    estimatorVersion: CONTACT_ESTIMATOR_VERSION,
    commit: options.commit,
    evaluatedAtIso: options.evaluatedAtIso,
    regenerate: REGENERATE_COMMAND,
    condition: {
      platform: "linux-cpu",
      pose: "committed runs-wave-a people.json (auto target policy)",
      ball: "ORACLE (visually verified gold annotation frames, conf 0.9) — measures temporal fusion, NOT the ball tracker",
      paddle:
        "ABSENT (no committed paddle track for these bundles; wrist-gate proxy path exercised)",
      heldOut: "wm-dink-01 and afn-vic-rally1 never read",
      grouping: "bundle/session (no random-frame splits)",
      toleranceMs: { strict: E02_STRICT_MS, acceptable: E02_ACCEPT_MS },
      regressionGate: {
        metrics: [...GATED_METRICS],
        reference:
          "previously committed artifact; ceilings from acceptedRegressions for the live estimatorVersion",
      },
    },
    acceptedRegressions: [...options.acceptedRegressions],
    overall: e02MetricsFor(rows),
    confidenceConditioned: e02ConfidenceConditioned(rows),
    bySession: Object.fromEntries(
      sessions.map((session) => [
        session,
        e02MetricsFor(rows.filter((row) => row.event.session === session)),
      ]),
    ),
    byBundle: Object.fromEntries(
      bundles.map((bundle) => [
        bundle,
        e02MetricsFor(rows.filter((row) => row.event.bundle === bundle)),
      ]),
    ),
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
}

export function e02GatedMetrics(artifact: E02Artifact): GatedMetrics {
  return {
    wrongMarkers: artifact.overall.wrongMarkers,
    medianErrorMs: artifact.overall.medianErrorMs,
  };
}

/** Row key used in AcceptedRegression.rows: `<bundle>@<goldContactMs>`. */
export function e02RowKey(row: { bundle: string; goldContactMs: number }): string {
  return `${row.bundle}@${row.goldContactMs}`;
}

/**
 * Every wrong marker (target row, estimated, error > E02_ACCEPT_MS) in a
 * committed e02 artifact must be named in some acceptedRegressions[].rows
 * entry — whichever estimator version introduced it — so it is never an
 * undisclosed delta. Returns the row keys that are not.
 */
export function e02UndisclosedWrongMarkers(artifact: E02Artifact): string[] {
  const disclosed = new Set<string>();
  for (const entry of artifact.acceptedRegressions) {
    for (const row of entry.rows) {
      const key = row.split(" ")[0];
      if (key) disclosed.add(key);
    }
  }
  const undisclosed: string[] = [];
  for (const row of artifact.rows) {
    if (row.owner !== "target" || row.status !== "estimated" || row.errorMs === null) continue;
    if (row.errorMs <= E02_ACCEPT_MS) continue;
    const key = e02RowKey(row);
    if (!disclosed.has(key)) undisclosed.push(key);
  }
  return undisclosed;
}

// ---------------------------------------------------------------------------
// WAVE-G g05 — before/after measurement of the ownership-conditioned contact
// posterior (flag-gated, default OFF). BEFORE = flag OFF; AFTER = flag ON with
// ownership confidence from paddleOwnershipFromHandAffinity (null when no
// paddle track exists). Slices: synthetic adversarial fixtures (confident-
// wrong = error > 150ms AND confidence ≥ 0.6), replayable committed contact
// gold (no paddle track — regression guard only; wrong marker = error >
// 132ms), and the e09/f09 red-team scenes.
// ---------------------------------------------------------------------------

export const G05_CONFIDENT_WRONG_ERROR_MS = 150;
export const G05_CONFIDENT_WRONG_CONFIDENCE = 0.6;
export const G05_GOLD_ACCEPT_MS = 132;
export const G05_GOLD_STRICT_MS = 66;
export const G05_VOLATILE_KEYS = ["commit", "dateUtc"] as const;

export interface G05FixtureRow {
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

export function g05RunFixtures(conditioned: boolean): G05FixtureRow[] {
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
        errorMs > G05_CONFIDENT_WRONG_ERROR_MS &&
        estimate.confidence >= G05_CONFIDENT_WRONG_CONFIDENCE,
    };
  });
}

export function g05FixtureMetrics(rows: G05FixtureRow[]) {
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

export function g05GoldMetrics(rows: ReplayRow[]) {
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
    wrongMarkers: estimated.filter((row) => row.errorMs! > G05_GOLD_ACCEPT_MS).length,
    confidentWrong: estimated.filter(
      (row) =>
        row.errorMs! > G05_CONFIDENT_WRONG_ERROR_MS &&
        row.confidence! >= G05_CONFIDENT_WRONG_CONFIDENCE,
    ).length,
    strictHits66: errors.filter((error) => error <= G05_GOLD_STRICT_MS).length,
    acceptableHits132: errors.filter((error) => error <= G05_GOLD_ACCEPT_MS).length,
    medianErrorMs: quantile(errors, 0.5),
    p90ErrorMs: quantile(errors, 0.9),
  };
}

export interface G05SceneRow {
  ownershipConfidence: number | null;
  status: "estimated" | "abstained";
  errorMs: number | null;
  confidence: number | null;
  ballConfirmed: boolean | null;
  paddleConfirmed: boolean | null;
  confidentWrong: boolean;
  limitingFactors: string[];
}

export function g05RunScene(
  scene: OwnershipScene & { ball?: import("@pickle/swing-domain").BallObservation[] },
  conditioned: boolean,
): G05SceneRow {
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
      errorMs > G05_CONFIDENT_WRONG_ERROR_MS &&
      estimate.confidence >= G05_CONFIDENT_WRONG_CONFIDENCE,
    limitingFactors: estimate.limitingFactors,
  };
}

export interface G05Measurement {
  fixturesBefore: G05FixtureRow[];
  fixturesAfter: G05FixtureRow[];
  goldBefore: ReplayRow[];
  goldAfter: ReplayRow[];
  foreignBefore: G05SceneRow;
  foreignAfter: G05SceneRow;
  genuineBefore: G05SceneRow;
  genuineAfter: G05SceneRow;
}

export function g05Measure(): G05Measurement {
  return {
    fixturesBefore: g05RunFixtures(false),
    fixturesAfter: g05RunFixtures(true),
    goldBefore: replayAll(),
    goldAfter: replayAll({ ownershipConditionedPosterior: true }),
    foreignBefore: g05RunScene(foreignPaddleScene(), false),
    foreignAfter: g05RunScene(foreignPaddleScene(), true),
    genuineBefore: g05RunScene(genuinePaddleScene(), false),
    genuineAfter: g05RunScene(genuinePaddleScene(), true),
  };
}

export interface G05Artifact {
  experiment: "wave-g g05-f09-posterior before/after";
  dateUtc: string;
  commit: string;
  estimatorVersion: string;
  posteriorVersion: string;
  regenerate: string;
  condition: string;
  thresholds: Record<string, number>;
  acceptedRegressions: AcceptedRegression[];
  adversarialFixtures: {
    before: ReturnType<typeof g05FixtureMetrics>;
    after: ReturnType<typeof g05FixtureMetrics>;
    rowsBefore: G05FixtureRow[];
    rowsAfter: G05FixtureRow[];
  };
  committedGold: {
    before: ReturnType<typeof g05GoldMetrics>;
    after: ReturnType<typeof g05GoldMetrics>;
  };
  redTeamScenes: {
    note: string;
    foreignPaddleWithinReach: { before: G05SceneRow; after: G05SceneRow };
    genuinePaddle: { before: G05SceneRow; after: G05SceneRow };
  };
}

export function buildG05Artifact(
  measurement: G05Measurement,
  options: {
    acceptedRegressions: readonly AcceptedRegression[];
    commit: string;
    dateUtc: string;
  },
): G05Artifact {
  return {
    experiment: "wave-g g05-f09-posterior before/after",
    dateUtc: options.dateUtc,
    commit: options.commit,
    estimatorVersion: CONTACT_ESTIMATOR_VERSION,
    posteriorVersion: CONTACT_OWNERSHIP_POSTERIOR_VERSION,
    regenerate: REGENERATE_COMMAND,
    condition:
      "LINUX-CPU; gold: committed pose + ORACLE-BALL, no paddle track (paddle-conditioned path cannot fire on gold — regression guard only); fixtures: synthetic",
    thresholds: {
      confidentWrongErrorMs: G05_CONFIDENT_WRONG_ERROR_MS,
      confidentWrongConfidence: G05_CONFIDENT_WRONG_CONFIDENCE,
      goldStrictMs: G05_GOLD_STRICT_MS,
      goldAcceptMs: G05_GOLD_ACCEPT_MS,
    },
    acceptedRegressions: [...options.acceptedRegressions],
    adversarialFixtures: {
      before: g05FixtureMetrics(measurement.fixturesBefore),
      after: g05FixtureMetrics(measurement.fixturesAfter),
      rowsBefore: measurement.fixturesBefore,
      rowsAfter: measurement.fixturesAfter,
    },
    committedGold: {
      before: g05GoldMetrics(measurement.goldBefore),
      after: g05GoldMetrics(measurement.goldAfter),
    },
    redTeamScenes: {
      note: "e09/f09 F3 residual (foreign paddle WITHIN reach of idle target wrist) + genuine-paddle positive guard; synthetic, outside the fixture generator",
      foreignPaddleWithinReach: {
        before: measurement.foreignBefore,
        after: measurement.foreignAfter,
      },
      genuinePaddle: { before: measurement.genuineBefore, after: measurement.genuineAfter },
    },
  };
}

/** g05's gate reads the flag-ON gold slice: the shipped default is flag OFF
 * (covered by e02), so this is the guard on the conditioned path. */
export function g05GatedMetrics(artifact: G05Artifact): GatedMetrics {
  return {
    wrongMarkers: artifact.committedGold.after.wrongMarkers,
    medianErrorMs: artifact.committedGold.after.medianErrorMs,
  };
}
