/**
 * Seeded randomized long-run stress model for @pickle/scoring.
 *
 * Every campaign iteration is a *plan* (a list of legal / near-legal actions
 * over the package's public API) derived purely from a 32-bit seed. The plan
 * is executed against real package objects while an independent oracle model
 * tracks what MUST be true; invariants are checked after every step and the
 * step outputs are folded into a canonical trace so two executions of the
 * same seed can be compared byte-for-byte.
 *
 * Invariants (ids referenced by the JSON result table):
 *   S1  no NaN/Infinity in any scoring output for in-domain inputs
 *   S2  ranges: overall 0..10 (one decimal), checkpoint score 0..100,
 *       confidence/severity 0..1
 *   S3  abstention: presentation follows the configured thresholds; abstain
 *       ⇒ overallScore null, every checkpoint null/unscored, guidance set;
 *       not abstain ⇒ overallScore number, guidance null
 *   S4  band == bandFor(score) when not abstaining
 *   S5  observed ⇔ ∃ measurement (c>0) for one of the checkpoint's metrics;
 *       score null ⇔ !observed
 *   S6  exactly the configured checkpoints, in config order, all applicable
 *   S7  direction: "none" ⇔ every counted metric is inside its range;
 *   S7b direction comes from a metric that actually carries confidence > 0
 *   S8  determinism: scoreShot(config, m) twice → deep-equal
 *   S9  measurement order does not matter (when metric keys are unique)
 *   S10 purity: config and measurements are not mutated
 *   S11 uniform confidence scaling by k∈(0,1]: analysisConfidence scales by k,
 *       checkpoint scores unchanged (weights normalise)
 *   S12 scoreMetric: q∈[0,100]; q==100 ⇔ value∈[lower,upper]; direction none ⇔ d==0
 *   S13 unknown metric keys are ignored (result equals filtered input)
 *   P1  priority fix null ⇔ no candidate (observed, score≠null, severity≥min)
 *   P2  fix is a candidate
 *   P3  reasonKey "root_cause_of:X" ⇒ (fix→X) is a configured dependency, X is
 *       a candidate, fix severity ≥ causeSeverityThreshold
 *   P4  selectPriorityFix deterministic; P5 with dependencyBoost 0 the fix is
 *       the base-priority argmax (ties: severity desc, key asc)
 *   P6  fix severity/confidence finite and within 0..1
 *   A1  Sm1TechniqueScorer.score ok ⇔ shot type has a config; failure code
 *       scoring.unsupported_stroke otherwise; payload mirrors scoreShot
 *   A2  fault detector emits exactly the checkpoints with score<65
 *   A3  uncertainty estimator: perCheckpoint mirrors confidences; limiting
 *       factors match the documented rules
 *   A4  ranker rejects foreign internals with coaching.incompatible_scorer_internal
 *       and otherwise mirrors selectPriorityFix; unknown stroke → Result failure
 *   L1  versioning.AnalysisRunLedger.record/reprocess throw ⇔ oracle
 *   L2  get() returns an independent copy equal to what was stored
 *   L3  runsForShot: exactly the oracle set, sorted by scoredAt
 *   L4  latestRunsUnderVersion: one run per shot, latest scoredAt, sorted by capturedAt
 *   L5  buildProgressLine (versioning): multiset of points preserved, sorted by
 *       capturedAt, segments/transitions alternate, boundary versions incomparable
 *   L6  every pair of versions inside one segment is comparable (documented:
 *       "progress lines never silently span incomparable versions")
 *   L7  segmentDelta finite or null (null ⇔ <2 scored points)
 *   G1  ScoreVersionRegistry.declareComparable throws ⇔ oracle (with code)
 *   G2  areComparable reflexive, symmetric, matches declarations
 *   G3  governance buildProgressLine: points preserved, transitions = segments−1,
 *       pairwise comparability inside segments, boundary incomparable
 *   G4  computeProgressDelta throws ⇔ incomparable, else finite later−earlier
 *   G5  governance ledger: sequential run ids, frozen, getRun/runsForCapture oracle,
 *       same-version reprocess rejected
 */
import type { Measurement, PriorityFix, ShotTypeSlug } from "@pickle/shared-types";
import { CHECKPOINTS, SHOT_TYPES, type CheckpointKey } from "@pickle/shared-types";
import {
  AnalysisRunLedger,
  bandFor,
  buildProgressLine,
  CheckpointThresholdFaultDetector,
  EngineUncertaintyEstimator,
  getShotScoringConfig,
  PriorityCoachingRanker,
  scoreMetric,
  scoreShot,
  segmentDelta,
  selectPriorityFix,
  Sm1TechniqueScorer,
  VersionComparability,
  type AnalysisRun,
  type CheckpointResultDetail,
  type ComparabilityRule,
  type MetricTarget,
  type PriorityOptions,
  type ShotScoringConfig,
  type ShotScoringOutcome,
  type VersionedScore,
} from "../../src/index.js";
import {
  AnalysisRunLedger as GovernanceLedger,
  buildProgressLine as buildGovernanceProgressLine,
  computeProgressDelta,
  ScoreVersioningError,
  ScoreVersionRegistry,
  type AnalysisRunInput,
  type ComparabilityDeclaration,
  type VersionedProgressPoint,
} from "../../src/versionGovernance.js";
import { canonicalJson, SeededRng } from "./rng.js";

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/**
 * Input classes. `legal` values are inside the documented domain; `near_legal`
 * are edge values at/just past the boundaries the domain still admits
 * (confidence 0/1, values far outside targets, duplicate/unknown metric keys,
 * empty strings, unknown ids); `hostile` values are outside the domain
 * altogether (NaN/Infinity measurements, confidence outside 0..1, sigma 0).
 * Hostile steps are tracked separately in the result table.
 */
export type InputClass = "legal" | "near_legal" | "hostile";

export type ScoringAction =
  | {
      kind: "score_shot";
      shotType: string;
      measurements: Measurement[];
      inputClass: InputClass;
      scale: number;
    }
  | { kind: "score_metric"; target: MetricTarget; values: number[]; inputClass: InputClass }
  | { kind: "priority"; options: PriorityOptions; inputClass: InputClass }
  | {
      kind: "pipeline";
      shotType: string;
      measurements: Measurement[];
      modalities: { pose: boolean; paddle: boolean; ball: boolean; court: boolean };
      focusCheckpoint: string | undefined;
      internal: "own" | "foreign";
      inputClass: InputClass;
    }
  | { kind: "ledger_v_record"; run: AnalysisRun; inputClass: InputClass }
  | {
      kind: "ledger_v_reprocess";
      sourceRunId: string;
      next: {
        runId: string;
        scoringModelVersion: string;
        overallScore: number | null;
        scoredAt: string;
      };
      inputClass: InputClass;
    }
  | { kind: "ledger_v_query"; shotId: string; version: string; inputClass: InputClass }
  | { kind: "declare_rule"; declaration: ComparabilityDeclaration; inputClass: InputClass }
  | { kind: "progress_v"; scores: VersionedScore[]; inputClass: InputClass }
  | {
      kind: "progress_g";
      points: VersionedProgressPoint[];
      deltaPair: [number, number] | null;
      inputClass: InputClass;
    }
  | { kind: "ledger_g_record"; input: AnalysisRunInput; inputClass: InputClass }
  | {
      kind: "ledger_g_reprocess";
      supersededRunId: string;
      update: Pick<AnalysisRunInput, "scoringModelVersion" | "overallScore" | "producedAtIso">;
      inputClass: InputClass;
    }
  | { kind: "ledger_g_query"; captureId: string; inputClass: InputClass };

export interface ScoringPlan {
  seed: number;
  length: number;
  actions: ScoringAction[];
}

const VERSIONS = ["sm-v1", "sm-v2", "sm-v3", "sm-v4"] as const;
const SHOT_IDS = ["shot-a", "shot-b", "shot-c", "shot-d"] as const;
const CAPTURE_IDS = ["cap-1", "cap-2", "cap-3"] as const;
const UNKNOWN_STROKE = "lob" as const;

function iso(rng: SeededRng): string {
  const base = Date.UTC(2026, 0, 1);
  const t = base + rng.int(0, 300) * 86_400_000 + rng.int(0, 86_399) * 1000;
  return new Date(t).toISOString();
}

function day(rng: SeededRng): string {
  return iso(rng).slice(0, 10);
}

function measurementFor(rng: SeededRng, target: MetricTarget, cls: InputClass): Measurement {
  const span = Math.max(target.upper - target.lower, target.sigma, 1e-3);
  let value: number;
  let confidence: number;
  if (cls === "hostile") {
    value = rng.pick([
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      rng.range(-10, 10),
    ]);
    confidence = rng.pick([rng.range(0.5, 1), -0.5, 1.5, Number.NaN]);
    if (
      Number.isFinite(value) &&
      Number.isFinite(confidence) &&
      confidence >= 0 &&
      confidence <= 1
    ) {
      confidence = 2; // guarantee the step is genuinely out of domain
    }
  } else if (cls === "near_legal") {
    value = rng.weighted<number>([
      [2, target.lower],
      [2, target.upper],
      [2, target.lower - 50 * span],
      [2, target.upper + 50 * span],
      [1, 1e6],
      [1, -1e6],
      [1, 1e300],
      [1, -1e300],
      [1, Number.MIN_VALUE],
      [1, 0],
    ]);
    confidence = rng.weighted<number>([
      [3, 0],
      [3, 1],
      [2, Number.EPSILON],
      [2, 1 - Number.EPSILON],
      [2, rng.range(0, 1)],
    ]);
  } else {
    value = rng.weighted<number>([
      [4, rng.range(target.lower, target.upper)],
      [3, rng.range(target.lower - 3 * span, target.upper + 3 * span)],
      [1, rng.range(target.lower - 12 * span, target.upper + 12 * span)],
    ]);
    confidence = rng.weighted<number>([
      [5, rng.range(0.3, 1)],
      [2, rng.range(0, 1)],
      [1, 1],
    ]);
  }
  return {
    metricKey: target.metricKey,
    value,
    confidence,
    unit: rng.pick(["normalized", "ratio", "degrees", "ms", "count"] as const),
    source: rng.pick(["real", "fixture"] as const),
  };
}

function genMeasurements(
  rng: SeededRng,
  config: ShotScoringConfig,
  cls: InputClass,
): Measurement[] {
  const targets = config.checkpoints.flatMap((c) => c.metrics);
  const keepP = rng.weighted<number>([
    [4, 1],
    [3, rng.range(0.6, 1)],
    [2, rng.range(0, 0.6)],
    [1, 0],
  ]);
  const chosen = rng.subset(targets, keepP);
  const out: Measurement[] = chosen.map((t) =>
    measurementFor(rng, t, cls === "hostile" && !rng.chance(0.4) ? "legal" : cls),
  );
  if (cls === "hostile" && !out.some((m) => !inDomain(m))) {
    const t = rng.pick(targets);
    out.push(measurementFor(rng, t, "hostile"));
  }
  if (cls !== "legal" && rng.chance(0.3) && out.length > 0) {
    // duplicate metric key — the engine keeps the last one
    const dup = rng.pick(out);
    out.push({ ...dup, value: dup.value + 1, confidence: rng.range(0, 1) });
  }
  if (cls !== "legal" && rng.chance(0.3)) {
    out.push({
      metricKey: `unknown_metric_${rng.int(0, 9)}`,
      value: rng.range(-10, 10),
      confidence: rng.range(0, 1),
      unit: "normalized",
      source: "fixture",
    });
  }
  return rng.shuffle(out);
}

function inDomain(m: Measurement): boolean {
  return (
    Number.isFinite(m.value) &&
    Number.isFinite(m.confidence) &&
    m.confidence >= 0 &&
    m.confidence <= 1
  );
}

function genTarget(rng: SeededRng, cls: InputClass): MetricTarget {
  const lower = rng.range(-100, 100);
  const width = rng.range(0, 50);
  let sigma = rng.range(0.01, 30);
  let upper = lower + width;
  if (cls === "hostile") {
    if (rng.chance(0.5)) sigma = 0;
    else upper = lower - rng.range(0.1, 20); // inverted range
  } else if (cls === "near_legal") {
    if (rng.chance(0.5))
      upper = lower; // zero-width range
    else sigma = rng.pick([1e-9, 1e9]);
  }
  return {
    metricKey: "m",
    lower,
    upper,
    sigma,
    importance: rng.range(0.1, 2),
    directionBelow: "low",
    directionAbove: "high",
  };
}

function pickClass(rng: SeededRng): InputClass {
  return rng.weighted<InputClass>([
    [6, "legal"],
    [3, "near_legal"],
    [1, "hostile"],
  ]);
}

function pickVersion(rng: SeededRng, cls: InputClass): string {
  if (cls !== "legal" && rng.chance(0.12)) return rng.pick(["", "  "]);
  return rng.pick(VERSIONS);
}

function pickScore(rng: SeededRng): number | null {
  return rng.chance(0.2) ? null : Math.round(rng.range(0, 10) * 10) / 10;
}

class PlanState {
  runIds: string[] = [];
  runCounter = 0;
  governanceRuns = 0;
  hasOutcome = false;
}

function genAction(rng: SeededRng, st: PlanState): ScoringAction {
  const cls = pickClass(rng);
  const kind = rng.weighted<ScoringAction["kind"]>([
    [24, "score_shot"],
    [4, "score_metric"],
    [st.hasOutcome ? 10 : 0, "priority"],
    [10, "pipeline"],
    [7, "ledger_v_record"],
    [4, "ledger_v_reprocess"],
    [4, "ledger_v_query"],
    [5, "declare_rule"],
    [7, "progress_v"],
    [7, "progress_g"],
    [5, "ledger_g_record"],
    [3, "ledger_g_reprocess"],
    [3, "ledger_g_query"],
  ]);
  switch (kind) {
    case "score_shot": {
      const shotType = cls !== "legal" && rng.chance(0.05) ? UNKNOWN_STROKE : rng.pick(SHOT_TYPES);
      const config =
        shotType === UNKNOWN_STROKE ? getShotScoringConfig("dink") : getShotScoringConfig(shotType);
      st.hasOutcome = shotType !== UNKNOWN_STROKE;
      return {
        kind,
        shotType,
        measurements: genMeasurements(rng, config, cls),
        inputClass: cls,
        scale: rng.range(0.05, 1),
      };
    }
    case "score_metric": {
      const target = genTarget(rng, cls);
      const values = Array.from({ length: rng.int(1, 6) }, () =>
        rng.range(target.lower - 200, target.upper + 200),
      );
      return { kind, target, values, inputClass: cls };
    }
    case "priority": {
      const options: PriorityOptions = {};
      if (rng.chance(0.4)) {
        const goal: Partial<Record<CheckpointKey, number>> = {};
        for (const key of rng.subset(CHECKPOINTS, 0.4)) goal[key] = rng.range(0, 2);
        options.goalRelevance = goal;
      }
      if (rng.chance(0.3)) options.focusCheckpoint = rng.pick(CHECKPOINTS);
      if (rng.chance(0.3)) options.minSeverity = rng.range(0, 0.6);
      if (rng.chance(0.3)) options.causeSeverityThreshold = rng.range(0, 0.8);
      if (rng.chance(0.4)) options.dependencyBoost = rng.pick([0, rng.range(0, 2)]);
      if (rng.chance(0.2)) options.focusStickiness = rng.range(0.5, 3);
      return { kind, options, inputClass: cls === "hostile" ? "near_legal" : cls };
    }
    case "pipeline": {
      const shotType = cls !== "legal" && rng.chance(0.08) ? UNKNOWN_STROKE : rng.pick(SHOT_TYPES);
      const config =
        shotType === UNKNOWN_STROKE ? getShotScoringConfig("dink") : getShotScoringConfig(shotType);
      return {
        kind,
        shotType,
        measurements: genMeasurements(rng, config, cls),
        modalities: {
          pose: rng.chance(0.9),
          paddle: rng.chance(0.6),
          ball: rng.chance(0.5),
          court: rng.chance(0.5),
        },
        focusCheckpoint: rng.chance(0.3) ? rng.pick(CHECKPOINTS) : undefined,
        internal: cls !== "legal" && rng.chance(0.2) ? "foreign" : "own",
        inputClass: cls,
      };
    }
    case "ledger_v_record": {
      st.runCounter++;
      const runId =
        cls !== "legal" && st.runIds.length > 0 && rng.chance(0.25)
          ? rng.pick(st.runIds)
          : `run-v-${st.runCounter}`;
      st.runIds.push(runId);
      const source =
        st.runIds.length > 1 && rng.chance(0.35)
          ? rng.pick(st.runIds)
          : cls !== "legal" && rng.chance(0.15)
            ? `ghost-${rng.int(0, 9)}`
            : null;
      return {
        kind,
        run: {
          runId,
          shotId: rng.pick(SHOT_IDS),
          scoringModelVersion: pickVersion(rng, cls),
          overallScore: pickScore(rng),
          capturedAt: iso(rng),
          scoredAt: iso(rng),
          reprocessedFromRunId: source,
        },
        inputClass: cls,
      };
    }
    case "ledger_v_reprocess": {
      st.runCounter++;
      const runId = `run-v-${st.runCounter}`;
      st.runIds.push(runId);
      const sourceRunId =
        st.runIds.length > 1 && !(cls !== "legal" && rng.chance(0.2))
          ? rng.pick(st.runIds)
          : `ghost-${rng.int(0, 9)}`;
      return {
        kind,
        sourceRunId,
        next: {
          runId,
          scoringModelVersion: pickVersion(rng, cls),
          overallScore: pickScore(rng),
          scoredAt: iso(rng),
        },
        inputClass: cls,
      };
    }
    case "ledger_v_query":
      return { kind, shotId: rng.pick(SHOT_IDS), version: rng.pick(VERSIONS), inputClass: cls };
    case "declare_rule": {
      const from = pickVersion(rng, cls);
      const to = cls !== "legal" && rng.chance(0.15) ? from : pickVersion(rng, cls);
      return {
        kind,
        declaration: {
          fromVersion: from,
          toVersion: to,
          calibrationEvidenceRef:
            cls !== "legal" && rng.chance(0.15) ? "" : `calib-${rng.int(1, 99)}`,
          declaredAtIso: iso(rng),
        },
        inputClass: cls,
      };
    }
    case "progress_v": {
      const n = rng.int(0, 12);
      const scores: VersionedScore[] = Array.from({ length: n }, (_, i) => ({
        runId: `p-${i}`,
        shotId: rng.pick(SHOT_IDS),
        scoringModelVersion: pickVersion(rng, cls === "hostile" ? "near_legal" : cls),
        overallScore: pickScore(rng),
        capturedAt: iso(rng),
        scoredAt: iso(rng),
      }));
      return { kind, scores, inputClass: cls };
    }
    case "progress_g": {
      const n = rng.int(0, 12);
      const points: VersionedProgressPoint[] = Array.from({ length: n }, () => ({
        day: day(rng),
        scoringModelVersion: pickVersion(rng, cls === "hostile" ? "near_legal" : cls),
        score: Math.round(rng.range(0, 10) * 10) / 10,
      }));
      const deltaPair: [number, number] | null =
        n >= 2 ? [rng.int(0, n - 1), rng.int(0, n - 1)] : null;
      return { kind, points, deltaPair, inputClass: cls };
    }
    case "ledger_g_record":
      st.governanceRuns++;
      return {
        kind,
        input: {
          captureId: rng.pick(CAPTURE_IDS),
          scoringModelVersion: pickVersion(rng, cls),
          overallScore: pickScore(rng),
          producedAtIso: iso(rng),
        },
        inputClass: cls,
      };
    case "ledger_g_reprocess":
      st.governanceRuns++;
      return {
        kind,
        supersededRunId: `run-${rng.int(1, st.governanceRuns + 1)}`,
        update: {
          scoringModelVersion: pickVersion(rng, cls),
          overallScore: pickScore(rng),
          producedAtIso: iso(rng),
        },
        inputClass: cls,
      };
    case "ledger_g_query":
      return { kind, captureId: rng.pick(CAPTURE_IDS), inputClass: cls };
  }
}

export function generatePlan(seed: number, minLen = 5, maxLen = 60): ScoringPlan {
  const rng = new SeededRng(seed);
  const length = rng.int(minLen, maxLen);
  const st = new PlanState();
  const actions: ScoringAction[] = [];
  for (let i = 0; i < length; i++) actions.push(genAction(rng, st));
  return { seed, length, actions };
}

// ---------------------------------------------------------------------------
// Execution + oracle
// ---------------------------------------------------------------------------

export interface Violation {
  step: number;
  action: ScoringAction["kind"];
  invariant: string;
  inputClass: InputClass;
  detail: string;
}

export interface StepTrace {
  step: number;
  kind: ScoringAction["kind"];
  inputClass: InputClass;
  digest: string;
}

export interface ExecutionResult {
  trace: StepTrace[];
  violations: Violation[];
  actionCounts: Record<string, number>;
}

class Oracle {
  readonly vRuns = new Map<string, AnalysisRun>();
  readonly declared = new Map<string, ComparabilityDeclaration>();
  readonly rules: ComparabilityRule[] = [];
  readonly gRuns = new Map<
    string,
    AnalysisRunInput & { runId: string; supersedesRunId: string | null }
  >();
  gSequence = 0;
  lastOutcome: {
    config: ShotScoringConfig;
    outcome: ShotScoringOutcome;
    domainOk: boolean;
  } | null = null;

  pairKey(a: string, b: string): string {
    return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
  }

  comparable(a: string, b: string): boolean {
    return a === b || this.declared.has(this.pairKey(a, b));
  }
}

interface Ctx {
  step: number;
  action: ScoringAction;
  violations: Violation[];
}

function check(ctx: Ctx, invariant: string, ok: boolean, detail: () => string): void {
  if (ok) return;
  ctx.violations.push({
    step: ctx.step,
    action: ctx.action.kind,
    invariant,
    inputClass: ctx.action.inputClass,
    detail: detail(),
  });
}

function finiteDeep(value: unknown, path = "$"): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? null : `${path}=${String(value)}`;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const r = finiteDeep(value[i], `${path}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = finiteDeep(v, `${path}.${k}`);
      if (r) return r;
    }
  }
  return null;
}

function approx(a: number, b: number, tol = 1e-9): boolean {
  return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
}

function isKnownShotType(shotType: string): shotType is ShotTypeSlug {
  return (SHOT_TYPES as readonly string[]).includes(shotType);
}

function lastByKey(measurements: Measurement[]): Map<string, Measurement> {
  const byMetric = new Map<string, Measurement>();
  for (const m of measurements) byMetric.set(m.metricKey, m);
  return byMetric;
}

function checkScoreShotOutcome(
  ctx: Ctx,
  config: ShotScoringConfig,
  measurements: Measurement[],
  outcome: ShotScoringOutcome,
): void {
  const domainOk = measurements.every(inDomain);
  const byMetric = lastByKey(measurements);

  const nonFinite = finiteDeep(outcome);
  check(ctx, "S1", nonFinite === null, () => `non-finite output at ${nonFinite}`);

  // S6 structure
  check(
    ctx,
    "S6",
    outcome.checkpoints.length === config.checkpoints.length &&
      outcome.checkpoints.every((c, i) => c.key === config.checkpoints[i]!.key && c.applicable) &&
      outcome.checkpointResults.length === config.checkpoints.length,
    () => `checkpoints=${outcome.checkpoints.map((c) => c.key).join(",")}`,
  );

  if (!domainOk) return; // out-of-domain inputs: only S1/S6 are meaningful

  // S2 ranges
  check(
    ctx,
    "S2",
    (outcome.overallScore === null ||
      (outcome.overallScore >= 0 &&
        outcome.overallScore <= 10 &&
        approx(outcome.overallScore * 10, Math.round(outcome.overallScore * 10)))) &&
      outcome.analysisConfidence >= 0 &&
      outcome.analysisConfidence <= 1 + 1e-12 &&
      outcome.checkpoints.every(
        (c) =>
          (c.score === null || (c.score >= 0 && c.score <= 100 + 1e-9)) &&
          c.confidence >= 0 &&
          c.confidence <= 1 + 1e-12 &&
          c.severity >= 0 &&
          c.severity <= 1,
      ),
    () => `overall=${outcome.overallScore} conf=${outcome.analysisConfidence}`,
  );

  // S3 abstention
  const expectedPresentation =
    outcome.analysisConfidence < config.minAnalysisConfidence
      ? "abstain"
      : outcome.analysisConfidence < config.lowerConfidenceThreshold
        ? "lower_confidence"
        : "normal";
  check(
    ctx,
    "S3",
    outcome.presentation === expectedPresentation,
    () => `presentation=${outcome.presentation} expected=${expectedPresentation}`,
  );
  if (outcome.presentation === "abstain") {
    check(
      ctx,
      "S3",
      outcome.overallScore === null &&
        outcome.guidance !== null &&
        outcome.checkpoints.every((c) => c.score === null && c.band === "unscored"),
      () => `abstain leaked score: overall=${outcome.overallScore}`,
    );
  } else {
    check(
      ctx,
      "S3",
      outcome.overallScore !== null && outcome.guidance === null,
      () =>
        `non-abstain without score: overall=${outcome.overallScore} guidance=${outcome.guidance}`,
    );
    check(
      ctx,
      "S4",
      outcome.checkpoints.every((c) => c.band === bandFor(c.score)),
      () => outcome.checkpoints.map((c) => `${c.key}:${c.score}:${c.band}`).join(","),
    );
  }

  // S5 / S7 per checkpoint
  for (let i = 0; i < config.checkpoints.length; i++) {
    const cfg = config.checkpoints[i]!;
    const r = outcome.checkpointResults[i]!;
    const present = cfg.metrics
      .map((t) => byMetric.get(t.metricKey))
      .filter((m): m is Measurement => m !== undefined);
    const expectObserved = present.some((m) => m.confidence > 0);
    check(
      ctx,
      "S5",
      r.observed === expectObserved && (r.score === null) === !r.observed,
      () => `${cfg.key}: observed=${r.observed} expected=${expectObserved} score=${r.score}`,
    );
    if (!r.observed) continue;
    const allInside = present.every((m) => {
      const t = cfg.metrics.find((x) => x.metricKey === m.metricKey)!;
      return m.value >= t.lower && m.value <= t.upper;
    });
    if (allInside) {
      check(
        ctx,
        "S7",
        r.direction === "none",
        () => `${cfg.key}: all inside but direction=${r.direction}`,
      );
    }
    const detailFor = (d: { metricKey: string }) => byMetric.get(d.metricKey)!;
    const worstCounted = r.metricDetails
      .filter((d) => detailFor(d).confidence > 0)
      .reduce((a, b) => (b.q < a.q ? b : a));
    check(
      ctx,
      "S7b",
      r.direction === worstCounted.direction,
      () =>
        `${cfg.key}: direction=${r.direction} but worst confidence>0 metric ${worstCounted.metricKey} says ${worstCounted.direction}; details=${r.metricDetails
          .map((d) => `${d.metricKey}(q=${d.q.toFixed(1)},c=${d.confidence},dir=${d.direction})`)
          .join(" ")}`,
    );
  }
}

function priorityOracle(
  config: ShotScoringConfig,
  results: CheckpointResultDetail[],
  options: PriorityOptions,
): { candidates: CheckpointResultDetail[]; argmaxBase: CheckpointKey | null } {
  const minSeverity = options.minSeverity ?? 0.12;
  const stickiness = options.focusStickiness ?? 1.25;
  const cfgByKey = new Map(config.checkpoints.map((c) => [c.key, c]));
  const candidates = results.filter(
    (r) => r.observed && r.score !== null && r.severity >= minSeverity && cfgByKey.has(r.key),
  );
  const ranked = candidates
    .map((r) => {
      const cfg = cfgByKey.get(r.key)!;
      const goal = options.goalRelevance?.[r.key] ?? 1;
      let base = r.severity * r.confidence * cfg.coachPriority * cfg.changeability * goal;
      if (options.focusCheckpoint === r.key) base *= stickiness;
      return { key: r.key, base, severity: r.severity };
    })
    .sort((a, b) => b.base - a.base || b.severity - a.severity || a.key.localeCompare(b.key));
  return { candidates, argmaxBase: ranked[0]?.key ?? null };
}

function checkPriority(
  ctx: Ctx,
  config: ShotScoringConfig,
  results: CheckpointResultDetail[],
  options: PriorityOptions,
  fix: PriorityFix | null,
): void {
  const { candidates, argmaxBase } = priorityOracle(config, results, options);
  check(
    ctx,
    "P1",
    (fix === null) === (candidates.length === 0),
    () => `fix=${fix?.checkpoint} candidates=${candidates.length}`,
  );
  if (!fix) return;
  const cand = candidates.find((c) => c.key === fix.checkpoint);
  check(ctx, "P2", cand !== undefined, () => `fix ${fix.checkpoint} not a candidate`);
  check(
    ctx,
    "P6",
    Number.isFinite(fix.severity) &&
      Number.isFinite(fix.confidence) &&
      fix.severity >= 0 &&
      fix.severity <= 1 &&
      fix.confidence >= 0 &&
      fix.confidence <= 1,
    () => `severity=${fix.severity} confidence=${fix.confidence}`,
  );
  if (fix.reasonKey.startsWith("root_cause_of:")) {
    const effect = fix.reasonKey.slice("root_cause_of:".length);
    const threshold = options.causeSeverityThreshold ?? 0.25;
    check(
      ctx,
      "P3",
      config.dependencies.some((d) => d.cause === fix.checkpoint && d.effect === effect) &&
        candidates.some((c) => c.key === effect) &&
        (cand?.severity ?? 0) >= threshold,
      () => `reason=${fix.reasonKey} fix=${fix.checkpoint} severity=${cand?.severity}`,
    );
  } else {
    check(
      ctx,
      "P3",
      fix.reasonKey === "highest_weighted_priority",
      () => `reason=${fix.reasonKey}`,
    );
  }
  if (options.dependencyBoost === 0) {
    check(
      ctx,
      "P5",
      fix.checkpoint === argmaxBase,
      () => `boost=0 fix=${fix.checkpoint} argmax=${argmaxBase}`,
    );
  }
  const again = selectPriorityFix(config, results, options);
  check(
    ctx,
    "P4",
    canonicalJson(again) === canonicalJson(fix),
    () => "selectPriorityFix not deterministic",
  );
}

async function executeAction(
  ctx: Ctx,
  oracle: Oracle,
  vLedger: AnalysisRunLedger,
  gLedger: GovernanceLedger,
  registry: ScoreVersionRegistry,
): Promise<unknown> {
  const a = ctx.action;
  switch (a.kind) {
    case "score_shot": {
      if (!isKnownShotType(a.shotType)) {
        let threw = false;
        try {
          getShotScoringConfig(a.shotType as ShotTypeSlug);
        } catch {
          threw = true;
        }
        check(ctx, "A1", threw, () => `getShotScoringConfig(${a.shotType}) did not throw`);
        return { unknownStroke: a.shotType, threw };
      }
      const config = getShotScoringConfig(a.shotType);
      const configBefore = canonicalJson(config);
      const inputBefore = canonicalJson(a.measurements);
      const outcome = scoreShot(config, a.measurements);
      checkScoreShotOutcome(ctx, config, a.measurements, outcome);
      check(
        ctx,
        "S10",
        canonicalJson(config) === configBefore,
        () => "config mutated by scoreShot",
      );
      check(
        ctx,
        "S10",
        canonicalJson(a.measurements) === inputBefore,
        () => "measurements mutated by scoreShot",
      );
      const again = scoreShot(config, a.measurements);
      check(
        ctx,
        "S8",
        canonicalJson(again) === canonicalJson(outcome),
        () => "scoreShot not deterministic",
      );
      const keys = a.measurements.map((m) => m.metricKey);
      if (new Set(keys).size === keys.length) {
        const permuted = scoreShot(config, [...a.measurements].reverse());
        const strip = (o: ShotScoringOutcome) =>
          canonicalJson({
            ...o,
            checkpointResults: o.checkpointResults.map((r) => ({
              ...r,
              metricDetails: [...r.metricDetails].sort((x, y) =>
                x.metricKey.localeCompare(y.metricKey),
              ),
            })),
          });
        check(
          ctx,
          "S9",
          strip(permuted) === strip(outcome),
          () => "scoreShot depends on measurement order",
        );
      }
      const known = new Set(config.checkpoints.flatMap((c) => c.metrics.map((t) => t.metricKey)));
      const filtered = scoreShot(
        config,
        a.measurements.filter((m) => known.has(m.metricKey)),
      );
      check(
        ctx,
        "S13",
        canonicalJson(filtered) === canonicalJson(outcome),
        () => "unknown metric keys changed the result",
      );
      if (a.measurements.every(inDomain)) {
        const scaled = scoreShot(
          config,
          a.measurements.map((m) => ({ ...m, confidence: m.confidence * a.scale })),
        );
        check(
          ctx,
          "S11",
          approx(scaled.analysisConfidence, outcome.analysisConfidence * a.scale, 1e-9) &&
            scaled.checkpointResults.every((r, i) => {
              const o = outcome.checkpointResults[i]!;
              return (
                (r.score === null) === (o.score === null) &&
                (r.score === null || approx(r.score, o.score!, 1e-9))
              );
            }),
          () => `scale=${a.scale} conf ${outcome.analysisConfidence}→${scaled.analysisConfidence}`,
        );
      }
      oracle.lastOutcome = { config, outcome, domainOk: a.measurements.every(inDomain) };
      return outcome;
    }
    case "score_metric": {
      const out = a.values.map((v) => scoreMetric(a.target, v));
      const t = a.target;
      const hostile = a.inputClass === "hostile";
      for (let i = 0; i < out.length; i++) {
        const o = out[i]!;
        const v = a.values[i]!;
        const inside = v >= t.lower && v <= t.upper;
        if (!hostile) {
          check(
            ctx,
            "S1",
            Number.isFinite(o.q),
            () => `scoreMetric q=${o.q} target=${canonicalJson(t)} value=${v}`,
          );
          check(
            ctx,
            "S12",
            o.q >= 0 &&
              o.q <= 100 &&
              (!inside || o.q === 100) &&
              (o.direction === "none") === inside,
            () =>
              `q=${o.q} inside=${inside} direction=${o.direction} value=${v} target=${canonicalJson(t)}`,
          );
        } else {
          check(
            ctx,
            "S1",
            Number.isFinite(o.q),
            () => `hostile target ${canonicalJson(t)} value=${v} → q=${o.q}`,
          );
        }
      }
      return out;
    }
    case "priority": {
      const last = oracle.lastOutcome;
      if (!last) return { skipped: true };
      // A priority step inherits the domain of the outcome it ranks.
      if (!last.domainOk) ctx.action = { ...a, inputClass: "hostile" };
      const fix = selectPriorityFix(last.config, last.outcome.checkpointResults, a.options);
      checkPriority(ctx, last.config, last.outcome.checkpointResults, a.options, fix);
      return fix;
    }
    case "pipeline": {
      const scorer = new Sm1TechniqueScorer();
      const detector = new CheckpointThresholdFaultDetector();
      const estimator = new EngineUncertaintyEstimator();
      const ranker = new PriorityCoachingRanker();
      const shotType = a.shotType as ShotTypeSlug;
      const scored = await scorer.score({
        shotType,
        measurements: a.measurements,
        embedding: null,
      });
      const known = isKnownShotType(a.shotType);
      check(ctx, "A1", scored.ok === known, () => `scorer ok=${scored.ok} known=${known}`);
      if (!scored.ok) {
        check(
          ctx,
          "A1",
          scored.failure.code === "scoring.unsupported_stroke",
          () => scored.failure.code,
        );
        // The ranker is a Result-returning contract too: an unknown stroke must
        // come back as a failure, not as a rejected promise.
        let rankThrew: string | null = null;
        let rankResult: Awaited<ReturnType<PriorityCoachingRanker["rank"]>> | null = null;
        try {
          rankResult = await ranker.rank({
            shotType,
            scorerInternal: { checkpointResults: [], shotType },
          });
        } catch (error) {
          rankThrew = error instanceof Error ? error.message : String(error);
        }
        check(
          ctx,
          "A4",
          rankThrew === null && rankResult !== null && !rankResult.ok,
          () => `unknown stroke: ranker threw=${rankThrew} result=${canonicalJson(rankResult)}`,
        );
        return { failure: scored.failure.code, rankThrew };
      }
      const config = getShotScoringConfig(shotType);
      const reference = scoreShot(config, a.measurements);
      check(
        ctx,
        "A1",
        canonicalJson(scored.value.checkpoints) === canonicalJson(reference.checkpoints) &&
          Object.is(scored.value.overallScore, reference.overallScore) &&
          scored.value.presentation === reference.presentation,
        () => "scorer adapter diverges from scoreShot",
      );
      const faults = await detector.detectFaults({
        shotType,
        checkpoints: scored.value.checkpoints,
        scorerInternal: scored.value.internal,
      });
      check(ctx, "A2", faults.ok, () => "fault detector failed");
      if (faults.ok) {
        const expected = scored.value.checkpoints.filter((c) => c.score !== null && c.score < 65);
        check(
          ctx,
          "A2",
          faults.value.length === expected.length &&
            faults.value.every((f, i) => {
              const c = expected[i]!;
              const metricKeys = reference.checkpointResults
                .find((r) => r.key === c.key)!
                .metricDetails.map((d) => d.metricKey);
              return (
                f.checkpoint === c.key &&
                f.code === `${c.key}.${c.direction}` &&
                Object.is(f.severity, c.severity) &&
                Object.is(f.confidence, c.confidence) &&
                canonicalJson(f.evidence[0]?.metricKeys) === canonicalJson(metricKeys)
              );
            }),
          () =>
            `faults=${faults.value.map((f) => f.code).join(",")} expected=${expected.map((c) => c.key).join(",")}`,
        );
        if (a.measurements.every(inDomain)) {
          const nf = finiteDeep(faults.value);
          check(ctx, "S1", nf === null, () => `fault output non-finite at ${nf}`);
        }
      }
      const uncertainty = await estimator.estimate({
        checkpoints: scored.value.checkpoints,
        analysisConfidence: scored.value.analysisConfidence,
        presentation: scored.value.presentation,
        modalitiesUsed: a.modalities,
      });
      check(ctx, "A3", uncertainty.ok, () => "uncertainty estimator failed");
      if (uncertainty.ok) {
        const expectedFactors: string[] = [];
        if (!a.modalities.paddle) expectedFactors.push("paddle_track_unavailable");
        if (!a.modalities.ball) expectedFactors.push("ball_track_unavailable");
        if (!a.modalities.court) expectedFactors.push("court_geometry_unavailable");
        for (const c of scored.value.checkpoints) {
          if (c.applicable && c.confidence === 0)
            expectedFactors.push(`checkpoint_unobserved:${c.key}`);
        }
        if (
          scored.value.presentation === "abstain" &&
          scored.value.checkpoints.some((c) => c.confidence > 0)
        ) {
          expectedFactors.push("analysis_confidence_below_threshold");
        }
        const per = Object.fromEntries(scored.value.checkpoints.map((c) => [c.key, c.confidence]));
        check(
          ctx,
          "A3",
          canonicalJson(uncertainty.value.limitingFactors) === canonicalJson(expectedFactors) &&
            canonicalJson(uncertainty.value.perCheckpoint) === canonicalJson(per) &&
            Object.is(uncertainty.value.analysisConfidence, scored.value.analysisConfidence) &&
            uncertainty.value.presentation === scored.value.presentation,
          () =>
            `factors=${uncertainty.value.limitingFactors.join(",")} expected=${expectedFactors.join(",")}`,
        );
      }
      const rankInput = {
        shotType,
        scorerInternal: a.internal === "own" ? scored.value.internal : { foreign: true },
        ...(a.focusCheckpoint ? { focusCheckpoint: a.focusCheckpoint } : {}),
      };
      let ranked: Awaited<ReturnType<PriorityCoachingRanker["rank"]>> | null = null;
      let rankThrew: string | null = null;
      try {
        ranked = await ranker.rank(rankInput);
      } catch (error) {
        rankThrew = error instanceof Error ? error.message : String(error);
      }
      check(
        ctx,
        "A4",
        rankThrew === null,
        () => `ranker threw instead of returning Result: ${rankThrew}`,
      );
      if (ranked) {
        if (a.internal === "foreign") {
          check(
            ctx,
            "A4",
            !ranked.ok && ranked.failure.code === "coaching.incompatible_scorer_internal",
            () => `foreign internal accepted: ${canonicalJson(ranked)}`,
          );
        } else {
          const expected = selectPriorityFix(
            config,
            reference.checkpointResults,
            a.focusCheckpoint ? { focusCheckpoint: a.focusCheckpoint as CheckpointKey } : {},
          );
          check(
            ctx,
            "A4",
            ranked.ok && canonicalJson(ranked.value) === canonicalJson(expected),
            () => `ranker=${canonicalJson(ranked)} expected=${canonicalJson(expected)}`,
          );
        }
      }
      return { scored: scored.value, faults, uncertainty, ranked, rankThrew };
    }
    case "ledger_v_record": {
      const run = a.run;
      const source =
        run.reprocessedFromRunId === null ? null : oracle.vRuns.get(run.reprocessedFromRunId);
      const expectThrow =
        run.scoringModelVersion.trim() === "" ||
        oracle.vRuns.has(run.runId) ||
        (run.reprocessedFromRunId !== null && (!source || source.shotId !== run.shotId));
      let threw = false;
      let stored: AnalysisRun | null = null;
      try {
        stored = vLedger.record(run);
      } catch {
        threw = true;
      }
      check(
        ctx,
        "L1",
        threw === expectThrow,
        () => `record threw=${threw} expected=${expectThrow} run=${canonicalJson(run)}`,
      );
      if (!threw && stored) {
        oracle.vRuns.set(run.runId, { ...run });
        check(
          ctx,
          "L2",
          canonicalJson(stored) === canonicalJson(run),
          () => "record() returned a different run",
        );
        stored.overallScore = -999;
        const fetched = vLedger.get(run.runId);
        check(
          ctx,
          "L2",
          fetched !== null && canonicalJson(fetched) === canonicalJson(run),
          () => "returned copy aliases ledger storage",
        );
      }
      return { threw, stored: threw ? null : run.runId };
    }
    case "ledger_v_reprocess": {
      const source = oracle.vRuns.get(a.sourceRunId);
      const expectThrow =
        !source || a.next.scoringModelVersion.trim() === "" || oracle.vRuns.has(a.next.runId);
      let threw = false;
      let stored: AnalysisRun | null = null;
      try {
        stored = vLedger.reprocess(a.sourceRunId, a.next);
      } catch {
        threw = true;
      }
      check(
        ctx,
        "L1",
        threw === expectThrow,
        () => `reprocess threw=${threw} expected=${expectThrow}`,
      );
      if (!threw && stored && source) {
        const expected: AnalysisRun = {
          runId: a.next.runId,
          shotId: source.shotId,
          scoringModelVersion: a.next.scoringModelVersion,
          overallScore: a.next.overallScore,
          capturedAt: source.capturedAt,
          scoredAt: a.next.scoredAt,
          reprocessedFromRunId: a.sourceRunId,
        };
        oracle.vRuns.set(expected.runId, expected);
        check(
          ctx,
          "L2",
          canonicalJson(stored) === canonicalJson(expected),
          () => `reprocess stored ${canonicalJson(stored)}`,
        );
      }
      return { threw };
    }
    case "ledger_v_query": {
      const forShot = vLedger.runsForShot(a.shotId);
      const expectedForShot = [...oracle.vRuns.values()]
        .filter((r) => r.shotId === a.shotId)
        .sort((x, y) => x.scoredAt.localeCompare(y.scoredAt));
      check(
        ctx,
        "L3",
        forShot.length === expectedForShot.length &&
          forShot.every(
            (r, i) => r.scoredAt === expectedForShot[i]!.scoredAt && r.shotId === a.shotId,
          ) &&
          canonicalJson([...forShot].sort((x, y) => x.runId.localeCompare(y.runId))) ===
            canonicalJson([...expectedForShot].sort((x, y) => x.runId.localeCompare(y.runId))),
        () =>
          `runsForShot=${forShot.map((r) => r.runId).join(",")} expected=${expectedForShot.map((r) => r.runId).join(",")}`,
      );
      const latest = vLedger.latestRunsUnderVersion(a.version);
      const byShot = new Map<string, AnalysisRun>();
      for (const r of oracle.vRuns.values()) {
        if (r.scoringModelVersion !== a.version) continue;
        const e = byShot.get(r.shotId);
        if (!e || r.scoredAt > e.scoredAt) byShot.set(r.shotId, r);
      }
      const expectedLatest = [...byShot.values()].sort((x, y) =>
        x.capturedAt.localeCompare(y.capturedAt),
      );
      check(
        ctx,
        "L4",
        latest.length === expectedLatest.length &&
          new Set(latest.map((r) => r.shotId)).size === latest.length &&
          latest.every(
            (r, i) =>
              r.capturedAt === expectedLatest[i]!.capturedAt && r.scoringModelVersion === a.version,
          ) &&
          latest.every((r) => {
            const e = byShot.get(r.shotId);
            return e !== undefined && e.scoredAt === r.scoredAt;
          }),
        () =>
          `latest=${latest.map((r) => `${r.shotId}@${r.runId}`).join(",")} expected=${expectedLatest.map((r) => `${r.shotId}@${r.runId}`).join(",")}`,
      );
      return { forShot: forShot.map((r) => r.runId), latest: latest.map((r) => r.runId) };
    }
    case "declare_rule": {
      const d = a.declaration;
      const expectedCode =
        d.fromVersion.trim() === "" || d.toVersion.trim() === ""
          ? "version.missing"
          : d.fromVersion === d.toVersion
            ? "comparability.self"
            : d.calibrationEvidenceRef.trim() === ""
              ? "comparability.no_evidence"
              : oracle.declared.has(oracle.pairKey(d.fromVersion, d.toVersion))
                ? "comparability.duplicate"
                : null;
      let code: string | null = null;
      let otherError: string | null = null;
      try {
        registry.declareComparable(d);
      } catch (error) {
        if (error instanceof ScoreVersioningError) code = error.code;
        else otherError = String(error);
      }
      check(
        ctx,
        "G1",
        otherError === null && code === expectedCode,
        () => `declare code=${code} expected=${expectedCode} err=${otherError}`,
      );
      if (code === null && otherError === null) {
        oracle.declared.set(oracle.pairKey(d.fromVersion, d.toVersion), d);
        oracle.rules.push({
          versionA: d.fromVersion,
          versionB: d.toVersion,
          rationale: d.calibrationEvidenceRef,
        });
      }
      // G2 across the whole vocabulary
      for (const x of VERSIONS) {
        for (const y of VERSIONS) {
          const ab = registry.areComparable(x, y);
          const ba = registry.areComparable(y, x);
          check(
            ctx,
            "G2",
            ab === ba && ab === oracle.comparable(x, y),
            () => `areComparable(${x},${y})=${ab} reverse=${ba} oracle=${oracle.comparable(x, y)}`,
          );
        }
      }
      return { code };
    }
    case "progress_v": {
      const comparability = new VersionComparability(oracle.rules);
      const expectThrow = a.scores.some((s) => s.scoringModelVersion.trim() === "");
      let threw = false;
      let line: ReturnType<typeof buildProgressLine> = [];
      try {
        line = buildProgressLine(a.scores, comparability);
      } catch {
        threw = true;
      }
      check(
        ctx,
        "L5",
        threw === expectThrow,
        () => `buildProgressLine threw=${threw} expected=${expectThrow}`,
      );
      if (threw) return { threw };
      const segments = line.filter((e) => e.kind === "segment");
      const points = segments.flatMap((e) => (e.kind === "segment" ? e.segment.points : []));
      const sortedIds = (xs: readonly VersionedScore[]) =>
        xs
          .map((p) => p.runId)
          .sort()
          .join(",");
      check(
        ctx,
        "L5",
        sortedIds(points) === sortedIds(a.scores),
        () => "progress line lost or duplicated points",
      );
      check(
        ctx,
        "L5",
        points.every((p, i) => i === 0 || points[i - 1]!.capturedAt <= p.capturedAt),
        () => "progress points not ordered by capturedAt",
      );
      check(
        ctx,
        "L5",
        line.every((e, i) => (i % 2 === 0) === (e.kind === "segment")) &&
          (line.length === 0 || line.length % 2 === 1),
        () => `element kinds=${line.map((e) => e.kind).join(",")}`,
      );
      for (let i = 1; i < line.length; i += 2) {
        const prev = line[i - 1]!;
        const tr = line[i]!;
        const next = line[i + 1]!;
        if (prev.kind !== "segment" || tr.kind !== "version_transition" || next.kind !== "segment")
          continue;
        check(
          ctx,
          "L5",
          tr.fromVersion === prev.segment.scoringModelVersion &&
            tr.toVersion === next.segment.scoringModelVersion &&
            tr.at === next.segment.points[0]!.capturedAt &&
            !comparability.isComparable(tr.fromVersion, tr.toVersion),
          () => `transition ${tr.fromVersion}→${tr.toVersion} at ${tr.at}`,
        );
      }
      for (const e of segments) {
        if (e.kind !== "segment") continue;
        const versions = [...new Set(e.segment.points.map((p) => p.scoringModelVersion))];
        for (const x of versions) {
          for (const y of versions) {
            check(
              ctx,
              "L6",
              comparability.isComparable(x, y),
              () =>
                `segment (version ${e.segment.scoringModelVersion}) contains incomparable versions ${x} and ${y}; rules=${oracle.rules
                  .map((r) => `${r.versionA}~${r.versionB}`)
                  .join(
                    ",",
                  )}; points=${e.segment.points.map((p) => `${p.runId}:${p.scoringModelVersion}@${p.capturedAt}`).join(" ")}`,
            );
          }
        }
        const delta = segmentDelta(e.segment);
        const scored = e.segment.points.filter((p) => p.overallScore !== null);
        check(
          ctx,
          "L7",
          scored.length < 2
            ? delta === null
            : delta !== null &&
                Number.isFinite(delta) &&
                approx(delta, scored[scored.length - 1]!.overallScore! - scored[0]!.overallScore!),
          () => `segmentDelta=${delta} scored=${scored.length}`,
        );
      }
      return line;
    }
    case "progress_g": {
      const expectThrow = a.points.some((p) => p.scoringModelVersion.trim() === "");
      let threw = false;
      let line: ReturnType<typeof buildGovernanceProgressLine> = { segments: [], transitions: [] };
      try {
        line = buildGovernanceProgressLine(a.points, registry);
      } catch {
        threw = true;
      }
      check(
        ctx,
        "G3",
        threw === expectThrow,
        () => `governance buildProgressLine threw=${threw} expected=${expectThrow}`,
      );
      if (!threw) {
        const points = line.segments.flatMap((s) => s.points);
        const key = (p: VersionedProgressPoint) => `${p.day}|${p.scoringModelVersion}|${p.score}`;
        check(
          ctx,
          "G3",
          points.map(key).sort().join(";") === a.points.map(key).sort().join(";") &&
            points.every((p, i) => i === 0 || points[i - 1]!.day <= p.day) &&
            line.transitions.length === Math.max(0, line.segments.length - 1),
          () =>
            `segments=${line.segments.length} transitions=${line.transitions.length} points=${points.length}/${a.points.length}`,
        );
        for (const s of line.segments) {
          const versions = [...new Set(s.points.map((p) => p.scoringModelVersion))].sort();
          check(
            ctx,
            "G3",
            canonicalJson([...s.versions].sort()) === canonicalJson(versions) &&
              versions.every((x) => versions.every((y) => oracle.comparable(x, y))),
            () => `segment versions=${s.versions.join(",")} points=${versions.join(",")}`,
          );
        }
        for (let i = 0; i < line.transitions.length; i++) {
          const tr = line.transitions[i]!;
          const prev = line.segments[i]!;
          const next = line.segments[i + 1]!;
          check(
            ctx,
            "G3",
            tr.fromVersion === prev.points[prev.points.length - 1]!.scoringModelVersion &&
              tr.toVersion === next.points[0]!.scoringModelVersion &&
              tr.day === next.points[0]!.day &&
              prev.versions.some((v) => !oracle.comparable(v, tr.toVersion)),
            () => `transition ${canonicalJson(tr)}`,
          );
        }
      }
      let deltaResult: unknown = null;
      if (a.deltaPair) {
        const earlier = a.points[a.deltaPair[0]]!;
        const later = a.points[a.deltaPair[1]]!;
        const versionsOk =
          earlier.scoringModelVersion.trim() !== "" && later.scoringModelVersion.trim() !== "";
        const expectCode = !versionsOk
          ? "version.missing"
          : oracle.comparable(earlier.scoringModelVersion, later.scoringModelVersion)
            ? null
            : "progress.incomparable_versions";
        let code: string | null = null;
        let delta: number | null = null;
        try {
          delta = computeProgressDelta(earlier, later, registry);
        } catch (error) {
          code = error instanceof ScoreVersioningError ? error.code : `other:${String(error)}`;
        }
        check(
          ctx,
          "G4",
          code === expectCode &&
            (code !== null ||
              (delta !== null &&
                Number.isFinite(delta) &&
                approx(delta, later.score - earlier.score))),
          () => `delta=${delta} code=${code} expected=${expectCode}`,
        );
        deltaResult = { delta, code };
      }
      return { line, deltaResult };
    }
    case "ledger_g_record": {
      const expectThrow = a.input.scoringModelVersion.trim() === "";
      let code: string | null = null;
      let stored: ReturnType<GovernanceLedger["recordRun"]> | null = null;
      try {
        stored = gLedger.recordRun(a.input);
      } catch (error) {
        code = error instanceof ScoreVersioningError ? error.code : `other:${String(error)}`;
      }
      check(
        ctx,
        "G5",
        (code !== null) === expectThrow && (code === null || code === "version.missing"),
        () => `recordRun code=${code}`,
      );
      if (stored) {
        oracle.gSequence++;
        const expected = { ...a.input, runId: `run-${oracle.gSequence}`, supersedesRunId: null };
        oracle.gRuns.set(expected.runId, expected);
        check(
          ctx,
          "G5",
          canonicalJson(stored) === canonicalJson(expected) && Object.isFrozen(stored),
          () => `recordRun stored ${canonicalJson(stored)} expected ${canonicalJson(expected)}`,
        );
        check(
          ctx,
          "G5",
          canonicalJson(gLedger.getRun(expected.runId)) === canonicalJson(expected),
          () => "getRun mismatch",
        );
      }
      return { code, runId: stored?.runId ?? null };
    }
    case "ledger_g_reprocess": {
      const superseded = oracle.gRuns.get(a.supersededRunId);
      const expectCode =
        a.update.scoringModelVersion.trim() === ""
          ? "version.missing"
          : !superseded
            ? "run.not_found"
            : superseded.scoringModelVersion === a.update.scoringModelVersion
              ? "run.same_version_reprocess"
              : null;
      let code: string | null = null;
      let stored: ReturnType<GovernanceLedger["reprocess"]> | null = null;
      try {
        stored = gLedger.reprocess(a.supersededRunId, a.update);
      } catch (error) {
        code = error instanceof ScoreVersioningError ? error.code : `other:${String(error)}`;
      }
      check(ctx, "G5", code === expectCode, () => `reprocess code=${code} expected=${expectCode}`);
      if (stored && superseded) {
        oracle.gSequence++;
        const expected = {
          captureId: superseded.captureId,
          scoringModelVersion: a.update.scoringModelVersion,
          overallScore: a.update.overallScore,
          producedAtIso: a.update.producedAtIso,
          runId: `run-${oracle.gSequence}`,
          supersedesRunId: a.supersededRunId,
        };
        oracle.gRuns.set(expected.runId, expected);
        check(
          ctx,
          "G5",
          canonicalJson(stored) === canonicalJson(expected) && Object.isFrozen(stored),
          () => `reprocess stored ${canonicalJson(stored)}`,
        );
        check(
          ctx,
          "G5",
          canonicalJson(gLedger.getRun(a.supersededRunId)) === canonicalJson(superseded),
          () => "superseded run changed after reprocess",
        );
      }
      return { code, runId: stored?.runId ?? null };
    }
    case "ledger_g_query": {
      const runs = gLedger.runsForCapture(a.captureId);
      const expected = [...oracle.gRuns.values()].filter((r) => r.captureId === a.captureId);
      check(
        ctx,
        "G5",
        canonicalJson(runs) === canonicalJson(expected) &&
          gLedger.getRun(`run-${oracle.gSequence + 1}`) === null,
        () =>
          `runsForCapture=${runs.map((r) => r.runId).join(",")} expected=${expected.map((r) => r.runId).join(",")}`,
      );
      return runs.map((r) => r.runId);
    }
  }
}

export async function executePlan(plan: ScoringPlan): Promise<ExecutionResult> {
  const oracle = new Oracle();
  const vLedger = new AnalysisRunLedger();
  const gLedger = new GovernanceLedger();
  const registry = new ScoreVersionRegistry();
  const violations: Violation[] = [];
  const trace: StepTrace[] = [];
  const actionCounts: Record<string, number> = {};
  for (let step = 0; step < plan.actions.length; step++) {
    const action = plan.actions[step]!;
    actionCounts[action.kind] = (actionCounts[action.kind] ?? 0) + 1;
    const ctx: Ctx = { step, action, violations };
    let output: unknown;
    try {
      output = await executeAction(ctx, oracle, vLedger, gLedger, registry);
    } catch (error) {
      output = {
        uncaught: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      };
      check(ctx, "UNCAUGHT", false, () => (output as { uncaught: string }).uncaught);
    }
    trace.push({
      step,
      kind: action.kind,
      inputClass: action.inputClass,
      digest: canonicalJson(output),
    });
  }
  return { trace, violations, actionCounts };
}

// ---------------------------------------------------------------------------
// Minimisation (greedy 1-step delta debugging over the plan)
// ---------------------------------------------------------------------------

export async function minimizePlan(
  plan: ScoringPlan,
  invariant: string,
): Promise<{ actions: ScoringAction[]; violation: Violation | null }> {
  const reproduces = async (actions: ScoringAction[]) => {
    const r = await executePlan({ ...plan, actions });
    return r.violations.find((v) => v.invariant === invariant) ?? null;
  };
  let current = [...plan.actions];
  let first = await reproduces(current);
  if (!first) return { actions: current, violation: null };
  current = current.slice(0, first.step + 1);
  let progress = true;
  while (progress) {
    progress = false;
    for (let i = 0; i < current.length; i++) {
      const candidate = current.filter((_, j) => j !== i);
      const v = await reproduces(candidate);
      if (v) {
        current = candidate;
        first = v;
        progress = true;
        break;
      }
    }
  }
  return { actions: current, violation: first };
}
