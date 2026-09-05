import { describe, expect, it } from "vitest";
import { CHECKPOINTS, SHOT_TYPES } from "@pickle/shared-types";
import type { CheckpointKey, Measurement, ShotTypeSlug } from "@pickle/shared-types";
import {
  AnalysisRunLedger,
  CheckpointThresholdFaultDetector,
  EngineUncertaintyEstimator,
  PriorityCoachingRanker,
  Sm1TechniqueScorer,
  VersionComparability,
  bandFor,
  buildProgressLine,
  getShotScoringConfig,
  scoreShot,
  segmentDelta,
  type VersionedScore,
} from "../../src/index.js";
import {
  AnalysisRunLedger as GovernanceLedger,
  ScoreVersionRegistry,
  buildProgressLine as buildGovernedProgressLine,
  computeProgressDelta,
} from "../../src/versionGovernance.js";
import {
  TIME_DRIFT_LIMIT_RATIO,
  between,
  fingerprint,
  heapLeakProblems,
  inUnitInterval,
  intBetween,
  isFiniteNumber,
  mulberry32,
  nonFinitePaths,
  pick,
  readCampaignOptions,
  runCampaign,
  seedsFor,
  writeReport,
  type IterationResult,
  type Rng,
} from "./leakProbe.js";

/**
 * LONG-RUN LEAK campaign for @pickle/scoring.
 *
 * Invokes the whole sm-v1 provider chain (scorer → fault detector →
 * uncertainty estimator → coaching ranker) plus both version-governance
 * ledgers hundreds of times in ONE process with seeded synthetic measurement
 * streams, and checks after every 50 iterations that heap, retained outputs,
 * handles, timers and listeners return to baseline, and that invocation time
 * does not drift.
 *
 * Per-seed invariants (any violation marks the seed BROKEN):
 *   - determinism: same seed → identical fingerprint on replay
 *   - no NaN/Infinity anywhere in the outputs
 *   - bounded abstention: abstain ⇔ analysisConfidence < minAnalysisConfidence,
 *     and a clean stream (every metric present, confidence ≥ 0.8) never abstains
 *   - score/confidence/severity ranges; band consistency; faults ⇔ score < 65
 *   - priority fix points at an observed checkpoint
 *   - ledgers are append-only and refuse overwrites
 *
 * Full campaign (what the stress report was produced with):
 *   NODE_OPTIONS=--expose-gc STRESS_ITER=2000 STRESS_OUT=/tmp/scoring-leak.json \
 *     pnpm --filter @pickle/scoring test -- test/stress
 * Replay one seed:  STRESS_SEEDS=<seed> pnpm --filter @pickle/scoring test -- test/stress
 */

type Scenario = "clean" | "noisy" | "degraded";

const UNITS = ["normalized", "ratio", "degrees", "ms", "count"] as const;

interface ScoringOutcome {
  scenario: Scenario;
  shotType: ShotTypeSlug;
  measurements: number;
  presentation: string;
  overallScore: number | null;
  analysisConfidence: number;
  faults: number;
  fix: string | null;
  /**
   * Checkpoint scores strictly above 100 — values the sync validator
   * (supabase/functions/api parseSyncShot, `c.score <= 100`) and the
   * shot_details CHECK constraint refuse. Recorded as data here; pinned by
   * the dedicated contract test below.
   */
  scoresAbove100: Array<{ checkpoint: string; score: number }>;
  fingerprint: string;
  violations: string[];
}

function synthMeasurements(rng: Rng, shotType: ShotTypeSlug, scenario: Scenario): Measurement[] {
  const config = getShotScoringConfig(shotType);
  const dropProbability = scenario === "clean" ? 0 : scenario === "noisy" ? 0.3 : 0.7;
  const out: Measurement[] = [];
  for (const checkpoint of config.checkpoints) {
    for (const target of checkpoint.metrics) {
      if (rng() < dropProbability) continue;
      const center = (target.lower + target.upper) / 2;
      const halfWidth = (target.upper - target.lower) / 2;
      const spread = scenario === "clean" ? halfWidth : halfWidth + 4 * target.sigma;
      const value = center + between(rng, -spread, spread);
      const confidence =
        scenario === "clean"
          ? between(rng, 0.8, 1)
          : scenario === "noisy"
            ? between(rng, 0, 1)
            : between(rng, 0, 0.7);
      out.push({
        metricKey: target.metricKey,
        value,
        confidence,
        unit: pick(rng, UNITS),
        source: rng() < 0.5 ? "real" : "fixture",
      });
    }
  }
  // Input order must not matter: shuffle.
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const scorer = new Sm1TechniqueScorer();
const faultDetector = new CheckpointThresholdFaultDetector();
const uncertainty = new EngineUncertaintyEstimator();
const ranker = new PriorityCoachingRanker();

async function runScoringChain(
  shotType: ShotTypeSlug,
  measurements: Measurement[],
  scenario: Scenario,
  focus: CheckpointKey | undefined,
): Promise<{ payload: unknown; retain: object[]; violations: string[]; summary: ScoringOutcome }> {
  const violations: string[] = [];
  const config = getShotScoringConfig(shotType);

  const scored = await scorer.score({ shotType, measurements, embedding: null });
  if (!scored.ok) {
    violations.push(`scorer failed: ${scored.failure.code}`);
    return {
      payload: scored,
      retain: [scored],
      violations,
      summary: {
        scenario,
        shotType,
        measurements: measurements.length,
        presentation: "error",
        overallScore: null,
        analysisConfidence: Number.NaN,
        faults: 0,
        fix: null,
        scoresAbove100: [],
        fingerprint: "",
        violations,
      },
    };
  }
  const value = scored.value;

  // Pure engine and adapter must agree exactly.
  const direct = scoreShot(config, measurements);
  if (fingerprint(direct.checkpoints) !== fingerprint(value.checkpoints)) {
    violations.push("adapter checkpoints differ from scoreShot()");
  }

  for (const path of nonFinitePaths(value)) violations.push(`non-finite at ${path}`);

  const c = value.analysisConfidence;
  if (!inUnitInterval(c)) violations.push(`analysisConfidence out of [0,1]: ${c}`);
  const expectedPresentation =
    c < config.minAnalysisConfidence
      ? "abstain"
      : c < config.lowerConfidenceThreshold
        ? "lower_confidence"
        : "normal";
  if (value.presentation !== expectedPresentation) {
    violations.push(
      `presentation ${value.presentation} but confidence ${c} → ${expectedPresentation}`,
    );
  }
  if (scenario === "clean" && value.presentation !== "normal") {
    violations.push(`clean stream abstained/lowered: ${value.presentation} (conf ${c})`);
  }
  if (value.presentation === "abstain") {
    if (value.overallScore !== null) violations.push("abstain with non-null overallScore");
    if (value.guidance === null) violations.push("abstain without guidance");
    for (const cp of value.checkpoints) {
      if (cp.score !== null || cp.band !== "unscored") {
        violations.push(`abstain leaked checkpoint score ${cp.key}`);
      }
    }
  } else {
    if (value.guidance !== null) violations.push("guidance present without abstention");
    const anyObserved = value.checkpoints.some((cp) => cp.score !== null);
    if (anyObserved) {
      const s = value.overallScore;
      if (!isFiniteNumber(s) || s < 0 || s > 10 || Math.round(s * 10) / 10 !== s) {
        violations.push(`overallScore not a one-decimal 0..10 value: ${String(s)}`);
      }
    } else if (value.overallScore !== null) {
      violations.push("overallScore without any observed checkpoint");
    }
  }

  const applicableKeys = config.checkpoints
    .filter((cp) => cp.metrics.length > 0)
    .map((cp) => cp.key);
  if (fingerprint(value.checkpoints.map((cp) => cp.key)) !== fingerprint(applicableKeys)) {
    violations.push("checkpoint key set differs from config");
  }
  const observedKeys = new Set<string>();
  const scoresAbove100: Array<{ checkpoint: string; score: number }> = [];
  for (const cp of value.checkpoints) {
    if (!CHECKPOINTS.includes(cp.key)) violations.push(`unknown checkpoint ${cp.key}`);
    if (!inUnitInterval(cp.confidence)) violations.push(`${cp.key} confidence ${cp.confidence}`);
    if (!inUnitInterval(cp.severity)) violations.push(`${cp.key} severity ${cp.severity}`);
    if (cp.score !== null) {
      observedKeys.add(cp.key);
      if (!isFiniteNumber(cp.score) || cp.score < 0 || cp.score > 100 + 1e-9) {
        violations.push(`${cp.key} score ${cp.score}`);
      } else if (cp.score > 100) {
        scoresAbove100.push({ checkpoint: cp.key, score: cp.score });
      }
      if (cp.band !== bandFor(cp.score)) violations.push(`${cp.key} band ${cp.band}`);
    } else if (value.presentation !== "abstain" && cp.confidence !== 0) {
      violations.push(`${cp.key} unobserved but confidence ${cp.confidence}`);
    }
  }
  const presentMetricKeys = new Set(measurements.map((m) => m.metricKey));
  for (const ev of value.checkpointEvidence) {
    for (const key of ev.metricKeys) {
      if (!presentMetricKeys.has(key)) violations.push(`evidence cites absent metric ${key}`);
    }
  }

  const faults = await faultDetector.detectFaults({
    shotType,
    checkpoints: value.checkpoints,
    scorerInternal: value.internal,
  });
  if (!faults.ok) violations.push(`fault detector failed: ${faults.failure.code}`);
  const faultList = faults.ok ? faults.value : [];
  const expectedFaultKeys = value.checkpoints
    .filter((cp) => cp.score !== null && cp.score < 65)
    .map((cp) => cp.key)
    .sort();
  if (fingerprint(faultList.map((f) => f.checkpoint).sort()) !== fingerprint(expectedFaultKeys)) {
    violations.push("fault set ≠ checkpoints scoring < 65");
  }
  for (const path of nonFinitePaths(faultList)) violations.push(`fault non-finite at ${path}`);

  const estimate = await uncertainty.estimate({
    checkpoints: value.checkpoints,
    analysisConfidence: value.analysisConfidence,
    presentation: value.presentation,
    modalitiesUsed: { pose: true, paddle: false, ball: false, court: false },
  });
  if (!estimate.ok) violations.push(`uncertainty failed: ${estimate.failure.code}`);
  if (estimate.ok) {
    for (const path of nonFinitePaths(estimate.value))
      violations.push(`uncertainty non-finite ${path}`);
    if (Object.keys(estimate.value.perCheckpoint).length !== value.checkpoints.length) {
      violations.push("uncertainty perCheckpoint key count mismatch");
    }
  }

  // Both production callers (analyzeCapture, analyzeClip) skip coaching when
  // the scorer abstained; mirror that gate.
  const rank =
    value.presentation === "abstain"
      ? null
      : await ranker.rank({
          shotType,
          scorerInternal: value.internal,
          ...(focus ? { focusCheckpoint: focus } : {}),
        });
  if (rank && !rank.ok) violations.push(`ranker failed: ${rank.failure.code}`);
  const fix = rank && rank.ok ? rank.value : null;
  if (fix) {
    if (!observedKeys.has(fix.checkpoint)) violations.push(`fix on unobserved ${fix.checkpoint}`);
    if (!inUnitInterval(fix.severity) || !inUnitInterval(fix.confidence)) {
      violations.push(`fix severity/confidence ${fix.severity}/${fix.confidence}`);
    }
    if (typeof fix.reasonKey !== "string" || fix.reasonKey === "") violations.push("fix reasonKey");
  }

  const payload = { scored: value, direct, faults: faultList, estimate, fix };
  const retain: object[] = [value, direct, faultList];
  if (fix) retain.push(fix);
  return {
    payload,
    retain,
    violations,
    summary: {
      scenario,
      shotType,
      measurements: measurements.length,
      presentation: value.presentation,
      overallScore: value.overallScore,
      analysisConfidence: value.analysisConfidence,
      faults: faultList.length,
      fix: fix?.checkpoint ?? null,
      scoresAbove100,
      fingerprint: "",
      violations,
    },
  };
}

function exerciseLedgers(rng: Rng, violations: string[]): object[] {
  const retained: object[] = [];
  const versions = ["sm-v1", "sm-v2", "sm-v3"];
  const runs = intBetween(rng, 3, 10);

  // versioning.ts ledger + progress line
  const ledger = new AnalysisRunLedger();
  const scores: VersionedScore[] = [];
  const shotIds = ["shot-a", "shot-b", "shot-c"];
  for (let i = 0; i < runs; i += 1) {
    const day = String(10 + i).padStart(2, "0");
    const run = ledger.record({
      runId: `run-${i}`,
      shotId: pick(rng, shotIds),
      scoringModelVersion: pick(rng, versions),
      overallScore: rng() < 0.15 ? null : Math.round(between(rng, 0, 10) * 10) / 10,
      capturedAt: `2026-08-${day}T10:00:00.000Z`,
      scoredAt: `2026-08-${day}T10:00:01.000Z`,
      reprocessedFromRunId: null,
    });
    scores.push(run);
  }
  let threw = false;
  try {
    ledger.record({ ...scores[0]!, reprocessedFromRunId: null });
  } catch {
    threw = true;
  }
  if (!threw) violations.push("ledger accepted duplicate runId");
  const reprocessed = ledger.reprocess("run-0", {
    runId: "run-re",
    scoringModelVersion: "sm-v9",
    overallScore: 5,
    scoredAt: "2026-09-01T00:00:00.000Z",
  });
  if (reprocessed.reprocessedFromRunId !== "run-0") violations.push("reprocess lost source link");
  const original = ledger.get("run-0");
  if (!original || original.scoringModelVersion !== scores[0]!.scoringModelVersion) {
    violations.push("reprocess mutated the original run");
  }
  const comparability = new VersionComparability(
    rng() < 0.5 ? [{ versionA: "sm-v1", versionB: "sm-v2", rationale: "seeded calibration" }] : [],
  );
  const line = buildProgressLine(scores, comparability);
  const pointsInLine = line.reduce(
    (n, el) => n + (el.kind === "segment" ? el.segment.points.length : 0),
    0,
  );
  if (pointsInLine !== scores.length) violations.push("progress line dropped/duplicated points");
  const segments = line.filter((el) => el.kind === "segment").length;
  const transitions = line.filter((el) => el.kind === "version_transition").length;
  if (transitions !== Math.max(segments - 1, 0)) violations.push("transition count ≠ segments-1");
  for (const el of line) {
    if (el.kind !== "segment") continue;
    const delta = segmentDelta(el.segment);
    if (delta !== null && !isFiniteNumber(delta)) violations.push("non-finite segment delta");
  }
  retained.push(ledger, line, comparability);

  // versionGovernance.ts registry + ledger
  const registry = new ScoreVersionRegistry();
  registry.declareComparable({
    fromVersion: "sm-v1",
    toVersion: "sm-v2",
    calibrationEvidenceRef: "report://seeded",
    declaredAtIso: "2026-09-01T00:00:00.000Z",
  });
  let dup = false;
  try {
    registry.declareComparable({
      fromVersion: "sm-v2",
      toVersion: "sm-v1",
      calibrationEvidenceRef: "report://again",
      declaredAtIso: "2026-09-01T00:00:00.000Z",
    });
  } catch {
    dup = true;
  }
  if (!dup) violations.push("registry accepted duplicate declaration");
  const points = Array.from({ length: runs }, (_, i) => ({
    day: `2026-08-${String(10 + i).padStart(2, "0")}`,
    scoringModelVersion: pick(rng, versions),
    score: between(rng, 0, 10),
  }));
  const governed = buildGovernedProgressLine(points, registry);
  const governedPoints = governed.segments.reduce((n, s) => n + s.points.length, 0);
  if (governedPoints !== points.length) violations.push("governed line dropped points");
  if (governed.transitions.length !== Math.max(governed.segments.length - 1, 0)) {
    violations.push("governed transitions ≠ segments-1");
  }
  for (const segment of governed.segments) {
    for (let i = 1; i < segment.points.length; i += 1) {
      const d = computeProgressDelta(segment.points[i - 1]!, segment.points[i]!, registry);
      if (!isFiniteNumber(d)) violations.push("non-finite governed delta");
    }
  }
  const a = { day: "2026-08-01", scoringModelVersion: "sm-v1", score: 5 };
  const b = { day: "2026-08-02", scoringModelVersion: "sm-v3", score: 6 };
  let refused = false;
  try {
    computeProgressDelta(a, b, registry);
  } catch {
    refused = true;
  }
  if (!refused) violations.push("delta across incomparable versions was fabricated");
  const gLedger = new GovernanceLedger();
  const first = gLedger.recordRun({
    captureId: "cap-1",
    scoringModelVersion: "sm-v1",
    overallScore: 4.2,
    producedAtIso: "2026-08-01T00:00:00.000Z",
  });
  const second = gLedger.reprocess(first.runId, {
    scoringModelVersion: "sm-v2",
    overallScore: 4.4,
    producedAtIso: "2026-08-02T00:00:00.000Z",
  });
  if (second.supersedesRunId !== first.runId) violations.push("governed reprocess lost link");
  if (gLedger.runsForCapture("cap-1").length !== 2)
    violations.push("governed ledger history collapsed");
  if (!Object.isFrozen(gLedger.getRun(first.runId))) violations.push("governed run not frozen");
  retained.push(registry, governed, gLedger);
  return retained;
}

async function iterate(seed: number): Promise<IterationResult<ScoringOutcome>> {
  const rng = mulberry32(seed);
  const shotType = pick(rng, SHOT_TYPES);
  const roll = rng();
  const scenario: Scenario = roll < 0.3 ? "clean" : roll < 0.8 ? "noisy" : "degraded";
  const measurements = synthMeasurements(rng, shotType, scenario);
  const focus = rng() < 0.3 ? pick(rng, CHECKPOINTS) : undefined;

  const first = await runScoringChain(shotType, measurements, scenario, focus);
  const violations = [...first.violations];

  // Determinism: replay the identical input and compare fingerprints.
  const replay = await runScoringChain(shotType, measurements, scenario, focus);
  if (fingerprint(first.payload) !== fingerprint(replay.payload)) {
    violations.push("non-deterministic: replay fingerprint differs");
  }

  const ledgerObjects = exerciseLedgers(rng, violations);

  const fp = fingerprint(first.payload);
  const outcome: ScoringOutcome = {
    ...first.summary,
    fingerprint: fp.length.toString(16) + ":" + checksum(fp),
    violations,
  };
  return { outcome, violations, retain: [...first.retain, ...replay.retain, ...ledgerObjects] };
}

/** Tiny FNV-1a so the results table can carry a compact per-seed digest. */
function checksum(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

describe("@pickle/scoring long-run leak campaign", () => {
  const options = readCampaignOptions();
  const seeds = seedsFor(options);

  it(
    `invokes the sm-v1 chain ${seeds.length}× in one process without leaking, drifting or breaking invariants`,
    async () => {
      const report = await runCampaign<ScoringOutcome>({
        unit: "@pickle/scoring sm-v1 chain + version ledgers",
        options,
        seeds,
        iterate,
      });
      writeReport(options.outPath, report);

      const broken = report.results.filter((r) => r.outcome.violations.length > 0);
      expect(
        broken.map((r) => ({ seed: r.seed, violations: r.outcome.violations })),
        "seeds with invariant violations",
      ).toEqual([]);
      expect(report.iterationsExecuted).toBe(seeds.length);

      // Handles / timers / listeners / subscriptions must return to baseline.
      expect(report.handleProblems, "handle/listener drift").toEqual([]);

      // Invocation time must not drift upward across the run.
      expect(report.timing.driftRatio, "late/early median invocation time").toBeLessThanOrEqual(
        TIME_DRIFT_LIMIT_RATIO,
      );

      if (options.explicit) {
        // A deliberate campaign without --expose-gc cannot measure heap; that
        // is a harness misconfiguration, not a pass.
        expect(report.gcExposed, "campaign requires NODE_OPTIONS=--expose-gc").toBe(true);
      }
      if (report.gcExposed && report.heapTrend.measured) {
        expect(heapLeakProblems(report.heapTrend), "heap after forced GC").toEqual([]);
      }
    },
    10 * 60 * 1000,
  );
});

/**
 * The sync contract for a checkpoint score is `0 <= score <= 100`: the edge
 * parser (supabase/functions/api/index.ts parseSyncShot) rejects the whole
 * shot as `shot.invalid_payload` otherwise, and `shot_details` carries the
 * same CHECK constraint. apps/mobile/src/data/sync.ts forwards
 * `checkpoint.score` unrounded. A clean stroke — every metric inside its
 * target interval (q = 100) — must therefore never produce a checkpoint score
 * above 100, not even by floating-point rounding.
 */
describe("@pickle/scoring checkpoint scores honour the 0..100 sync contract", () => {
  const options = readCampaignOptions();
  const seeds = seedsFor({ ...options, iterations: Math.max(options.iterations, 500) });

  it("never emits a checkpoint score > 100 for clean in-target streams", () => {
    const syncValidatorAccepts = (score: number | null): boolean =>
      score === null || (Number.isFinite(score) && score >= 0 && score <= 100);
    const rejected: Array<{ seed: number; shotType: string; checkpoint: string; score: number }> =
      [];
    for (const seed of seeds) {
      const rng = mulberry32(seed);
      const shotType = pick(rng, SHOT_TYPES);
      const config = getShotScoringConfig(shotType);
      const outcome = scoreShot(config, synthMeasurements(rng, shotType, "clean"));
      for (const cp of outcome.checkpoints) {
        if (!syncValidatorAccepts(cp.score)) {
          rejected.push({ seed, shotType, checkpoint: cp.key, score: cp.score! });
        }
      }
    }
    expect(rejected, `shots the sync validator would reject (of ${seeds.length})`).toEqual([]);
  });

  /**
   * Minimised from the seeded failures above: two in-target metrics whose
   * importance·confidence products make Σ(a·c·100) / Σ(a·c) round up past 100
   * (packages/scoring/src/engine.ts scoreCheckpoint: `weighted / weightSum`).
   * Every other metric sits mid-target at confidence 0.9, so the shot is a
   * fully observed, normal-presentation 10.0 — exactly the shot a player
   * wants synced.
   */
  it("minimised: forehand_drive athletic_base at 0.6 / 0.73 confidence stays <= 100", () => {
    const config = getShotScoringConfig("forehand_drive");
    const measurements: Measurement[] = config.checkpoints.flatMap((cp) =>
      cp.metrics.map((m) => ({
        metricKey: m.metricKey,
        value: (m.lower + m.upper) / 2,
        confidence:
          m.metricKey === "stance_width_ratio"
            ? 0.6
            : m.metricKey === "knee_flexion_deg"
              ? 0.73
              : 0.9,
        unit: "ratio" as const,
        source: "real" as const,
      })),
    );
    const outcome = scoreShot(config, measurements);
    expect(outcome.presentation).toBe("normal");
    expect(outcome.overallScore).toBe(10);
    const athleticBase = outcome.checkpoints.find((cp) => cp.key === "athletic_base")!;
    expect(athleticBase.score, "athletic_base checkpoint score").toBeLessThanOrEqual(100);
  });
});
