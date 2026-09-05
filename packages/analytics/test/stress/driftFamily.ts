import {
  CATEGORICAL_DRIFT_METRICS,
  computePsi,
  DRIFT_THRESHOLDS,
  DRIFT_THRESHOLDS_VERSION,
  DriftMonitor,
  NUMERIC_DRIFT_BINS,
  NUMERIC_DRIFT_METRICS,
  type CategoricalDriftMetric,
  type DriftAlertEvent,
  type DriftMetric,
  type DriftNotEvaluable,
  type DriftObservation,
  type DriftSeverity,
  type NumericDriftMetric,
} from "../../src/drift.js";
import type { Failure, Family, Replay } from "./campaign.js";
import { bump, fnv1a, stableJson } from "./campaign.js";
import type { Rng } from "./rng.js";

/**
 * Family `drift`: seeded synthetic observation streams through `DriftMonitor`
 * (record / freezeReference / snapshot / test / alerts) plus direct
 * `computePsi` calls, model-checked after every op against an independent
 * reference model (FIFO windows + Map-based PSI).
 *
 * Invariants (from `packages/analytics/src/drift.ts` doc comments):
 *
 *  D-NO-THROW        no public drift API throws on legal/near-legal input
 *  D-SNAPSHOT-MODEL  snapshot(metric) == model window (counts + totalSamples):
 *                    only string categoricals and FINITE numerics are recorded,
 *                    numerics land in the documented fixed bins, and the oldest
 *                    sample is evicted past maxSamplesPerMetric
 *  D-SNAPSHOT-SHAPE  totalSamples ≤ max(0, maxSamples); Σ counts == total;
 *                    counts are positive integers; numeric keys ⊆ bin labels;
 *                    metric echoed
 *  D-TEST-EVAL       test() abstains (`reason`) exactly when the reference is
 *                    missing / < minSamples or current < minSamples, with the
 *                    model's reason and sample counts (bounded abstention)
 *  D-TEST-PSI        evaluable test(): psi is finite, ≥ 0, equals the model
 *                    PSI within 1e-9, severity follows the frozen bands,
 *                    thresholdsVersion is the frozen constant
 *  D-ALERTS          alerts(at) == projection of test() for every metric in
 *                    declaration order (not-evaluable → drift_window_not_evaluable,
 *                    warning/drift → drift_detected, stable → nothing), `at` echoed
 *  D-REF-FROZEN      after freezeReference() the reference sample count for a
 *                    metric is constant until the next freeze
 *  D-PSI-FINITE      computePsi never returns NaN/±Infinity for count maps
 *  D-PSI-SIGN        computePsi ≥ 0 and psi(a,a) == 0
 *  D-PSI-MODEL       computePsi equals the model PSI within 1e-9
 */

export const DRIFT_INVARIANTS = [
  "D-NO-THROW",
  "D-SNAPSHOT-MODEL",
  "D-SNAPSHOT-SHAPE",
  "D-TEST-EVAL",
  "D-TEST-PSI",
  "D-ALERTS",
  "D-REF-FROZEN",
  "D-PSI-FINITE",
  "D-PSI-SIGN",
  "D-PSI-MODEL",
] as const;

export type DriftOp =
  | { op: "monitor"; maxSamples: number }
  | { op: "record"; observations: DriftObservation[] }
  | { op: "freeze" }
  | { op: "snapshot"; metric: DriftMetric }
  | { op: "test"; metric: DriftMetric }
  | { op: "alerts"; at: string }
  | { op: "psi"; reference: Record<string, number>; current: Record<string, number> };

const ALL_METRICS: readonly DriftMetric[] = [
  ...CATEGORICAL_DRIFT_METRICS,
  ...NUMERIC_DRIFT_METRICS,
];

const CATEGORICAL_FIELD: Record<CategoricalDriftMetric, keyof DriftObservation> = {
  device_model: "deviceModel",
  os_version: "osVersion",
  envelope_verdict: "envelopeVerdict",
  stroke_type: "strokeType",
};

const NUMERIC_FIELD: Record<NumericDriftMetric, keyof DriftObservation> = {
  fps: "fps",
  resolution_short_side_px: "resolutionShortSidePx",
  player_apparent_size_frac: "playerApparentSizeFrac",
  coverage_frac: "coverageFrac",
  abstention_rate: "abstentionRate",
  latency_ms: "latencyMs",
  target_lock_success_rate: "targetLockSuccessRate",
  event_density_per_min: "eventDensityPerMin",
  paddle_visibility_frac: "paddleVisibilityFrac",
};

const FIELD_OF: Record<DriftMetric, keyof DriftObservation> = {
  ...CATEGORICAL_FIELD,
  ...NUMERIC_FIELD,
};

function isNumericMetric(metric: DriftMetric): metric is NumericDriftMetric {
  return (NUMERIC_DRIFT_METRICS as readonly string[]).includes(metric);
}

/** Independent binning over the frozen edges: `<e0`, `[e_{i-1},e_i)`, `>=e_last`. */
function modelBin(metric: NumericDriftMetric, value: number): string {
  const edges = NUMERIC_DRIFT_BINS[metric];
  const first = edges[0];
  const last = edges[edges.length - 1];
  if (first === undefined || last === undefined) throw new Error(`no edges for ${metric}`);
  if (value < first) return `<${first}`;
  for (let i = 1; i < edges.length; i++) {
    const lo = edges[i - 1];
    const hi = edges[i];
    if (lo !== undefined && hi !== undefined && value >= lo && value < hi) return `[${lo},${hi})`;
  }
  return `>=${last}`;
}

function binLabels(metric: NumericDriftMetric): Set<string> {
  const edges = NUMERIC_DRIFT_BINS[metric];
  const out = new Set<string>([`<${edges[0]}`, `>=${edges[edges.length - 1]}`]);
  for (let i = 1; i < edges.length; i++) out.add(`[${edges[i - 1]},${edges[i]})`);
  return out;
}

const DEVICE_MODELS = ["iPhone14,2", "iPhone15,3", "iPhone16,1", "iPad13,4", "iPhone12,8"] as const;
const OS_VERSIONS = ["17.4", "17.6", "18.0", "18.1", "18.2"] as const;
const VERDICTS = ["pass", "warn", "fail"] as const;
const STROKES = [
  "serve",
  "return",
  "forehand_drive",
  "backhand_drive",
  "third_shot_drop",
  "dink",
  "volley",
  "overhead",
] as const;
/** Labels legal as strings but hostile to plain-object keyed code. */
const ADVERSARIAL_LABELS = [
  "constructor",
  "__proto__",
  "toString",
  "hasOwnProperty",
  "valueOf",
  "prototype",
  "",
  " ",
  "🥒",
  "x".repeat(300),
  "<15",
  ">=60",
] as const;
/** Labels only introduced after the first freeze, so they are current-only vs the reference. */
const NOVEL_LABELS = [
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "iPhone17,1",
  "19.0",
] as const;

function adversarialNumber(rng: Rng): number {
  return rng.pick([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -1,
    0,
    -0,
    1e308,
    Number.MAX_VALUE,
    Number.MIN_VALUE,
    Number.EPSILON,
    -1e-9,
  ]);
}

/** Profiles keep populations realistic so both stable and drifted regimes occur. */
type Profile = "stable" | "shifted";

function numericValue(rng: Rng, metric: NumericDriftMetric, profile: Profile): number {
  const edges = NUMERIC_DRIFT_BINS[metric];
  const last = edges[edges.length - 1] ?? 1;
  if (rng.chance(0.12)) return rng.pick(edges); // exact boundary
  if (rng.chance(0.06)) return adversarialNumber(rng);
  const hi = profile === "stable" ? last * 1.2 : last * 2.5;
  const lo = profile === "stable" ? 0 : last * 0.6;
  return lo + rng.next() * (hi - lo);
}

function observation(rng: Rng, profile: Profile, frozen: boolean): DriftObservation {
  if (rng.chance(0.03)) return {};
  const obs: Record<string, unknown> = {};
  const label = (pool: readonly string[]): string => {
    if (frozen && rng.chance(0.03)) return rng.pick(NOVEL_LABELS);
    if (rng.chance(0.05)) return rng.pick(ADVERSARIAL_LABELS);
    if (profile === "shifted") return pool[pool.length - 1] ?? "";
    return rng.pick(pool);
  };
  if (rng.chance(0.8)) obs["deviceModel"] = label(DEVICE_MODELS);
  if (rng.chance(0.8)) obs["osVersion"] = label(OS_VERSIONS);
  if (rng.chance(0.7)) obs["envelopeVerdict"] = label(VERDICTS);
  if (rng.chance(0.7)) obs["strokeType"] = label(STROKES);
  for (const metric of NUMERIC_DRIFT_METRICS) {
    if (rng.chance(0.7)) obs[NUMERIC_FIELD[metric]] = numericValue(rng, metric, profile);
  }
  return obs as DriftObservation;
}

function countMap(rng: Rng): Record<string, number> {
  const out: Record<string, number> = {};
  const pool: readonly string[] = rng.chance(0.15) ? ADVERSARIAL_LABELS : STROKES;
  const size = rng.int(0, 6);
  for (let i = 0; i < size; i++) {
    const key = rng.pick(pool);
    out[key] = rng.chance(0.1) ? 0 : rng.int(1, 5000);
  }
  return out;
}

const MAX_SAMPLES_POOL = [0, 1, 3, 50, 120, 1000, 1000, 5000] as const;

export function generateDriftOps(rng: Rng, length: number): DriftOp[] {
  const ops: DriftOp[] = [{ op: "monitor", maxSamples: rng.pick(MAX_SAMPLES_POOL) }];
  let profile: Profile = "stable";
  let frozen = false;
  while (ops.length < length) {
    const kind = rng.weighted<DriftOp["op"]>([
      [46, "record"],
      [8, "freeze"],
      [12, "snapshot"],
      [14, "test"],
      [8, "alerts"],
      [10, "psi"],
      [2, "monitor"],
    ]);
    switch (kind) {
      case "record": {
        // One record op = a burst of observations so the 100-sample floor is
        // reachable inside a 5-60 op sequence (bounded abstention gets exercised
        // on both sides of the floor).
        const burst = rng.pick([1, 1, 5, 20, 60, 130, 250]);
        if (rng.chance(0.15)) profile = profile === "stable" ? "shifted" : "stable";
        ops.push({
          op: "record",
          observations: Array.from({ length: burst }, () => observation(rng, profile, frozen)),
        });
        break;
      }
      case "freeze":
        frozen = true;
        ops.push({ op: "freeze" });
        break;
      case "snapshot":
        ops.push({ op: "snapshot", metric: rng.pick(ALL_METRICS) });
        break;
      case "test":
        ops.push({ op: "test", metric: rng.pick(ALL_METRICS) });
        break;
      case "alerts":
        ops.push({
          op: "alerts",
          at: new Date(
            Date.UTC(2026, rng.int(0, 11), rng.int(1, 28), rng.int(0, 23)),
          ).toISOString(),
        });
        break;
      case "psi": {
        const reference = countMap(rng);
        ops.push({
          op: "psi",
          reference,
          current: rng.chance(0.2) ? { ...reference } : countMap(rng),
        });
        break;
      }
      case "monitor":
        ops.push({ op: "monitor", maxSamples: rng.pick(MAX_SAMPLES_POOL) });
        break;
    }
  }
  return ops;
}

interface Model {
  maxSamples: number;
  windows: Map<DriftMetric, string[]>;
  reference: Map<DriftMetric, Map<string, number>>;
  frozenSamples: Map<DriftMetric, number>;
}

function newModel(maxSamples: number): Model {
  return { maxSamples, windows: new Map(), reference: new Map(), frozenSamples: new Map() };
}

function counts(labels: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const label of labels) out.set(label, (out.get(label) ?? 0) + 1);
  return out;
}

function modelPsi(
  reference: Map<string, number>,
  current: Map<string, number>,
  smoothing: number,
): number {
  const bins = new Set([...reference.keys(), ...current.keys()]);
  const refTotal = [...reference.values()].reduce((a, b) => a + b, 0);
  const curTotal = [...current.values()].reduce((a, b) => a + b, 0);
  if (refTotal === 0 || curTotal === 0 || bins.size === 0) return 0;
  const sRef = refTotal + smoothing * bins.size;
  const sCur = curTotal + smoothing * bins.size;
  let psi = 0;
  for (const bin of bins) {
    const p = ((reference.get(bin) ?? 0) + smoothing) / sRef;
    const q = ((current.get(bin) ?? 0) + smoothing) / sCur;
    psi += (q - p) * Math.log(q / p);
  }
  return psi;
}

function modelWindow(model: Model, metric: DriftMetric): string[] {
  let w = model.windows.get(metric);
  if (!w) {
    w = [];
    model.windows.set(metric, w);
  }
  return w;
}

function modelRecord(model: Model, obs: DriftObservation): void {
  const push = (metric: DriftMetric, label: string) => {
    const w = modelWindow(model, metric);
    w.push(label);
    while (w.length > Math.max(0, model.maxSamples)) w.shift();
  };
  for (const metric of CATEGORICAL_DRIFT_METRICS) {
    const value = obs[CATEGORICAL_FIELD[metric]];
    if (typeof value === "string") push(metric, value);
  }
  for (const metric of NUMERIC_DRIFT_METRICS) {
    const value = obs[NUMERIC_FIELD[metric]];
    if (typeof value === "number" && Number.isFinite(value)) push(metric, modelBin(metric, value));
  }
}

function modelFreeze(model: Model): void {
  model.reference = new Map();
  model.frozenSamples = new Map();
  for (const metric of ALL_METRICS) {
    const labels = modelWindow(model, metric);
    model.reference.set(metric, counts(labels));
    model.frozenSamples.set(metric, labels.length);
  }
}

/** Own-entries of a plain record as a Map (tolerates keys like __proto__). */
function recordToMap(record: Record<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const key of Object.getOwnPropertyNames(record)) {
    const value = record[key];
    if (typeof value === "number") out.set(key, value);
  }
  return out;
}

function sameMap(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

function severityOf(psi: number): DriftSeverity {
  if (psi >= DRIFT_THRESHOLDS.psiDrift) return "drift";
  if (psi >= DRIFT_THRESHOLDS.psiWarning) return "warning";
  return "stable";
}

type ModelTest =
  | { reason: DriftNotEvaluable["reason"]; referenceSamples: number; currentSamples: number }
  | { psi: number; severity: DriftSeverity; referenceSamples: number; currentSamples: number };

function modelTest(model: Model, metric: DriftMetric): ModelTest {
  const reference = model.reference.get(metric);
  const referenceSamples = model.frozenSamples.get(metric) ?? 0;
  const labels = modelWindow(model, metric);
  const currentSamples = labels.length;
  if (!reference || referenceSamples < DRIFT_THRESHOLDS.minSamples) {
    return { reason: "insufficient_reference_samples", referenceSamples, currentSamples };
  }
  if (currentSamples < DRIFT_THRESHOLDS.minSamples) {
    return { reason: "insufficient_current_samples", referenceSamples, currentSamples };
  }
  const psi = modelPsi(reference, counts(labels), DRIFT_THRESHOLDS.smoothing);
  return { psi, severity: severityOf(psi), referenceSamples, currentSamples };
}

const PSI_TOLERANCE = 1e-9;

export async function runDriftOps(ops: readonly DriftOp[]): Promise<Replay> {
  const failures: Failure[] = [];
  const trace: string[] = [];
  const coverage: Record<string, number> = {};
  const fail = (invariant: string, step: number, detail: string) =>
    failures.push({ invariant, step, detail });

  let monitor = new DriftMonitor(1000);
  let model = newModel(1000);

  const checkSnapshot = (metric: DriftMetric, step: number) => {
    const snap = monitor.snapshot(metric);
    const actual = recordToMap(snap.counts);
    const labels = modelWindow(model, metric);
    const expected = counts(labels);
    if (!sameMap(actual, expected) || snap.totalSamples !== labels.length) {
      fail(
        "D-SNAPSHOT-MODEL",
        step,
        `${metric}: snapshot ${stableJson([...actual])}/${snap.totalSamples} vs model ${stableJson([...expected])}/${labels.length}`,
      );
    }
    const sum = [...actual.values()].reduce((a, b) => a + b, 0);
    const problems: string[] = [];
    if (snap.totalSamples > Math.max(0, model.maxSamples))
      problems.push(`total ${snap.totalSamples} > max ${model.maxSamples}`);
    if (sum !== snap.totalSamples) problems.push(`Σcounts ${sum} != total ${snap.totalSamples}`);
    for (const [k, v] of actual)
      if (!Number.isInteger(v) || v <= 0) problems.push(`count[${k}]=${v}`);
    if (isNumericMetric(metric)) {
      const known = binLabels(metric);
      for (const k of actual.keys()) if (!known.has(k)) problems.push(`unknown bin ${k}`);
    }
    if (snap.metric !== metric) problems.push(`metric echo ${snap.metric}`);
    if (problems.length > 0) fail("D-SNAPSHOT-SHAPE", step, `${metric}: ${problems.join("; ")}`);
    return snap;
  };

  const checkTest = (metric: DriftMetric, step: number) => {
    const result = monitor.test(metric);
    const expected = modelTest(model, metric);
    trace.push(`test ${metric} ${stableJson(result)}`);
    const resultAbstains = "reason" in result;
    const expectedAbstains = "reason" in expected;
    bump(
      coverage,
      "reason" in result ? `test.abstain.${result.reason}` : `test.evaluable.${result.severity}`,
    );
    if ("psi" in result && !Number.isFinite(result.psi)) bump(coverage, "test.psi.nonFinite");
    if (resultAbstains !== expectedAbstains) {
      fail(
        "D-TEST-EVAL",
        step,
        `${metric}: got ${stableJson(result)} expected ${stableJson(expected)}`,
      );
      return;
    }
    if (
      result.referenceSamples !== expected.referenceSamples ||
      result.currentSamples !== expected.currentSamples
    ) {
      fail(
        "D-TEST-EVAL",
        step,
        `${metric}: samples ${result.referenceSamples}/${result.currentSamples} vs model ${expected.referenceSamples}/${expected.currentSamples}`,
      );
    }
    if ("reason" in result && "reason" in expected) {
      if (result.reason !== expected.reason)
        fail("D-TEST-EVAL", step, `${metric}: reason ${result.reason} vs ${expected.reason}`);
      if (result.thresholdsVersion !== DRIFT_THRESHOLDS_VERSION)
        fail("D-TEST-EVAL", step, `${metric}: thresholdsVersion ${result.thresholdsVersion}`);
    }
    if ("psi" in result && "psi" in expected && !Number.isFinite(result.psi)) {
      const ref = model.reference.get(metric) ?? new Map<string, number>();
      const cur = counts(modelWindow(model, metric));
      fail(
        "D-PSI-FINITE",
        step,
        `test(${metric}).psi = ${String(result.psi)} (model ${expected.psi.toFixed(6)} ${expected.severity}); ` +
          `one-sided labels: ${stableJson([...new Set([...ref.keys(), ...cur.keys()])].filter((k) => ref.has(k) !== cur.has(k)))}`,
      );
    } else if ("psi" in result && "psi" in expected) {
      const problems: string[] = [];
      if (result.psi < -PSI_TOLERANCE) problems.push(`psi negative ${result.psi}`);
      if (Math.abs(result.psi - expected.psi) > PSI_TOLERANCE)
        problems.push(`psi ${result.psi} vs model ${expected.psi}`);
      if (result.severity !== expected.severity)
        problems.push(`severity ${result.severity} vs ${expected.severity}`);
      if (result.thresholdsVersion !== DRIFT_THRESHOLDS_VERSION)
        problems.push(`thresholdsVersion ${result.thresholdsVersion}`);
      if (result.metric !== metric) problems.push(`metric echo ${result.metric}`);
      if (problems.length > 0) fail("D-TEST-PSI", step, `${metric}: ${problems.join("; ")}`);
    }
    const frozen = model.frozenSamples.get(metric);
    if (frozen !== undefined && frozen !== result.referenceSamples) {
      fail(
        "D-REF-FROZEN",
        step,
        `${metric}: referenceSamples ${result.referenceSamples} moved from frozen ${frozen}`,
      );
    }
  };

  const expectedAlerts = (at: string): DriftAlertEvent[] =>
    ALL_METRICS.flatMap((metric): DriftAlertEvent[] => {
      const t = modelTest(model, metric);
      if ("reason" in t) {
        return [
          {
            name: "drift_window_not_evaluable",
            at,
            metric,
            reason: t.reason,
            referenceSamples: t.referenceSamples,
            currentSamples: t.currentSamples,
            thresholdsVersion: DRIFT_THRESHOLDS_VERSION,
          },
        ];
      }
      if (t.severity === "stable") return [];
      return [
        {
          name: "drift_detected",
          at,
          metric,
          psi: t.psi,
          severity: t.severity,
          referenceSamples: t.referenceSamples,
          currentSamples: t.currentSamples,
          thresholdsVersion: DRIFT_THRESHOLDS_VERSION,
        },
      ];
    });

  for (let step = 0; step < ops.length; step++) {
    const op = ops[step];
    if (!op) continue;
    try {
      switch (op.op) {
        case "monitor":
          monitor = new DriftMonitor(op.maxSamples);
          model = newModel(op.maxSamples);
          trace.push(`monitor ${op.maxSamples}`);
          break;
        case "record": {
          const touched = new Set<DriftMetric>();
          for (const observation of op.observations) {
            monitor.record(observation);
            modelRecord(model, observation);
            for (const metric of ALL_METRICS)
              if (FIELD_OF[metric] in observation) touched.add(metric);
          }
          trace.push(`record x${op.observations.length} ${fnv1a(stableJson(op.observations))}`);
          bump(coverage, "record.observations", op.observations.length);
          // Per-step check on every metric this burst touched.
          for (const metric of touched) checkSnapshot(metric, step);
          break;
        }
        case "freeze":
          monitor.freezeReference();
          modelFreeze(model);
          trace.push("freeze");
          bump(coverage, "freeze");
          break;
        case "snapshot": {
          const snap = checkSnapshot(op.metric, step);
          trace.push(
            `snapshot ${op.metric} ${stableJson(recordToMap(snap.counts))} ${snap.totalSamples}`,
          );
          break;
        }
        case "test":
          checkTest(op.metric, step);
          break;
        case "alerts": {
          const alerts = monitor.alerts(op.at);
          trace.push(`alerts ${stableJson(alerts)}`);
          bump(coverage, "alerts.calls");
          for (const a of alerts)
            bump(
              coverage,
              a.name === "drift_detected"
                ? `alerts.drift_detected.${a.severity}`
                : `alerts.not_evaluable.${a.reason}`,
            );
          const expected = expectedAlerts(op.at);
          const problems: string[] = [];
          if (alerts.length !== expected.length)
            problems.push(`count ${alerts.length} vs ${expected.length}`);
          for (let i = 0; i < Math.min(alerts.length, expected.length); i++) {
            const a = alerts[i];
            const e = expected[i];
            if (!a || !e) continue;
            if (a.name !== e.name || a.metric !== e.metric || a.at !== e.at) {
              problems.push(
                `[${i}] ${a.name}/${a.metric}/${a.at} vs ${e.name}/${e.metric}/${e.at}`,
              );
              continue;
            }
            if (
              a.referenceSamples !== e.referenceSamples ||
              a.currentSamples !== e.currentSamples
            ) {
              problems.push(
                `${a.metric} samples ${a.referenceSamples}/${a.currentSamples} vs ${e.referenceSamples}/${e.currentSamples}`,
              );
            }
            if (a.thresholdsVersion !== DRIFT_THRESHOLDS_VERSION)
              problems.push(`${a.metric} thresholdsVersion ${a.thresholdsVersion}`);
            if (a.name === "drift_detected" && e.name === "drift_detected") {
              if (a.severity !== e.severity)
                problems.push(`${a.metric} severity ${a.severity} vs ${e.severity}`);
              if (!Number.isFinite(a.psi) || Math.abs(a.psi - e.psi) > PSI_TOLERANCE)
                problems.push(`${a.metric} psi ${a.psi} vs ${e.psi}`);
            }
            if (
              a.name === "drift_window_not_evaluable" &&
              e.name === "drift_window_not_evaluable" &&
              a.reason !== e.reason
            ) {
              problems.push(`${a.metric} reason ${a.reason} vs ${e.reason}`);
            }
          }
          if (problems.length > 0) {
            // alerts() is a projection of test(): a non-finite psi there is the
            // computePsi defect, not an alert-projection defect.
            const nanMetrics = ALL_METRICS.filter((metric) => {
              const r = monitor.test(metric);
              return "psi" in r && !Number.isFinite(r.psi);
            });
            if (nanMetrics.length > 0) {
              fail(
                "D-PSI-FINITE",
                step,
                `alerts(): psi is NaN for ${nanMetrics.join(",")} → alert suppressed; ${problems.join("; ")}`,
              );
            } else {
              fail("D-ALERTS", step, problems.join("; "));
            }
          }
          break;
        }
        case "psi": {
          const psi = computePsi(op.reference, op.current);
          trace.push(`psi ${psi}`);
          bump(coverage, Number.isFinite(psi) ? "psi.finite" : "psi.nonFinite");
          const expected = modelPsi(
            recordToMap(op.reference),
            recordToMap(op.current),
            DRIFT_THRESHOLDS.smoothing,
          );
          if (!Number.isFinite(psi)) {
            fail(
              "D-PSI-FINITE",
              step,
              `computePsi(${stableJson(op.reference)}, ${stableJson(op.current)}) = ${String(psi)}`,
            );
            break;
          }
          if (psi < -PSI_TOLERANCE)
            fail(
              "D-PSI-SIGN",
              step,
              `psi ${psi} < 0 for ${stableJson(op.reference)} vs ${stableJson(op.current)}`,
            );
          if (
            stableJson(op.reference) === stableJson(op.current) &&
            Math.abs(psi) > PSI_TOLERANCE
          ) {
            fail("D-PSI-SIGN", step, `psi(a,a) = ${psi} for ${stableJson(op.reference)}`);
          }
          if (Math.abs(psi - expected) > PSI_TOLERANCE)
            fail("D-PSI-MODEL", step, `psi ${psi} vs model ${expected}`);
          break;
        }
      }
    } catch (error) {
      fail("D-NO-THROW", step, `${op.op} threw ${String(error)}`);
    }
  }

  // End-of-sequence sweep over every metric.
  for (const metric of ALL_METRICS) {
    try {
      checkSnapshot(metric, ops.length);
      checkTest(metric, ops.length);
    } catch (error) {
      fail("D-NO-THROW", ops.length, `sweep ${metric} threw ${String(error)}`);
    }
  }
  await Promise.resolve();
  return { trace: trace.join("\n"), failures, coverage };
}

export const driftFamily: Family<DriftOp> = {
  name: "drift",
  generate: generateDriftOps,
  run: runDriftOps,
};
