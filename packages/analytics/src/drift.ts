/**
 * Privacy-safe aggregate drift detection.
 *
 * Only AGGREGATE distributions are held here: category counts and fixed-bin
 * histograms. No user identifiers, no per-clip records, no raw media, no
 * free-form strings beyond low-cardinality category labels (device model,
 * OS version). A window is never evaluated below a minimum sample count so
 * a tiny population can never be singled out.
 *
 * Drift is measured with the Population Stability Index (PSI) against a
 * frozen reference window. Thresholds are VERSIONED and FROZEN: changing
 * them requires a new version string, never an in-place edit.
 */

/** Metrics tracked as categorical count distributions. */
export const CATEGORICAL_DRIFT_METRICS = [
  "device_model",
  "os_version",
  "envelope_verdict",
  "stroke_type",
] as const;

/** Metrics tracked as fixed-bin numeric histograms. */
export const NUMERIC_DRIFT_METRICS = [
  "fps",
  "resolution_short_side_px",
  "player_apparent_size_frac",
  "coverage_frac",
  "abstention_rate",
  "latency_ms",
  "target_lock_success_rate",
  "event_density_per_min",
  "paddle_visibility_frac",
] as const;

export type CategoricalDriftMetric = (typeof CATEGORICAL_DRIFT_METRICS)[number];
export type NumericDriftMetric = (typeof NUMERIC_DRIFT_METRICS)[number];
export type DriftMetric = CategoricalDriftMetric | NumericDriftMetric;

export const DRIFT_THRESHOLDS_VERSION = "drift-thresholds-v0.1-frozen";

/**
 * Frozen PSI thresholds (standard industry bands):
 *  PSI < 0.1        → stable
 *  0.1 ≤ PSI < 0.25 → warning
 *  PSI ≥ 0.25       → drift
 * `minSamples` is the privacy + statistical floor: windows below it are
 * NOT_EVALUABLE, never alerted on.
 */
export const DRIFT_THRESHOLDS = Object.freeze({
  version: DRIFT_THRESHOLDS_VERSION,
  psiWarning: 0.1,
  psiDrift: 0.25,
  minSamples: 100,
  /** Laplace-style smoothing mass added to every bin so PSI stays finite. */
  smoothing: 1e-4,
});

/** Fixed bin edges per numeric metric — versioned with the thresholds. */
export const NUMERIC_DRIFT_BINS: Readonly<Record<NumericDriftMetric, readonly number[]>> =
  Object.freeze({
    fps: [15, 24, 30, 48, 60],
    resolution_short_side_px: [480, 720, 1080, 1440],
    player_apparent_size_frac: [0.05, 0.1, 0.2, 0.35, 0.5],
    coverage_frac: [0.25, 0.5, 0.75, 0.9],
    abstention_rate: [0.05, 0.15, 0.3, 0.5],
    latency_ms: [250, 500, 1000, 2000, 5000],
    target_lock_success_rate: [0.5, 0.75, 0.9, 0.97],
    event_density_per_min: [1, 3, 6, 12],
    paddle_visibility_frac: [0.25, 0.5, 0.75, 0.9],
  });

/** Aggregate distribution snapshot: bin/category label → count. */
export interface DriftDistribution {
  metric: DriftMetric;
  totalSamples: number;
  counts: Record<string, number>;
}

export type DriftSeverity = "stable" | "warning" | "drift";

export interface DriftTestResult {
  metric: DriftMetric;
  psi: number;
  severity: DriftSeverity;
  referenceSamples: number;
  currentSamples: number;
  thresholdsVersion: string;
}

export interface DriftNotEvaluable {
  metric: DriftMetric;
  reason: "insufficient_reference_samples" | "insufficient_current_samples";
  referenceSamples: number;
  currentSamples: number;
  thresholdsVersion: string;
}

/**
 * Typed drift alert events. Aggregate-only payloads: a metric id, the PSI
 * statistic, and sample counts. Never per-user or per-clip data.
 */
export type DriftAlertEvent =
  | {
      name: "drift_detected";
      at: string;
      metric: DriftMetric;
      psi: number;
      severity: "warning" | "drift";
      referenceSamples: number;
      currentSamples: number;
      thresholdsVersion: string;
    }
  | {
      name: "drift_window_not_evaluable";
      at: string;
      metric: DriftMetric;
      reason: DriftNotEvaluable["reason"];
      referenceSamples: number;
      currentSamples: number;
      thresholdsVersion: string;
    };

function binLabel(edges: readonly number[], index: number): string {
  if (index === 0) return `<${edges[0]}`;
  if (index === edges.length) return `>=${edges[edges.length - 1]}`;
  return `[${edges[index - 1]},${edges[index]})`;
}

/** Map a numeric value to its fixed-bin label for the given metric. */
export function numericBinLabel(metric: NumericDriftMetric, value: number): string {
  const edges = NUMERIC_DRIFT_BINS[metric];
  let index = 0;
  for (const edge of edges) {
    if (value < edge) break;
    index++;
  }
  return binLabel(edges, index);
}

/**
 * Population Stability Index between two count distributions over the union
 * of their bins. Smoothing keeps the statistic finite when a bin is empty
 * on one side.
 */
export function computePsi(
  reference: Record<string, number>,
  current: Record<string, number>,
  smoothing: number = DRIFT_THRESHOLDS.smoothing,
): number {
  const bins = new Set([...Object.keys(reference), ...Object.keys(current)]);
  const refTotal = Object.values(reference).reduce((a, b) => a + b, 0);
  const curTotal = Object.values(current).reduce((a, b) => a + b, 0);
  if (refTotal === 0 || curTotal === 0 || bins.size === 0) return 0;
  const smoothedRefTotal = refTotal + smoothing * bins.size;
  const smoothedCurTotal = curTotal + smoothing * bins.size;
  let psi = 0;
  for (const bin of bins) {
    const p = ((reference[bin] ?? 0) + smoothing) / smoothedRefTotal;
    const q = ((current[bin] ?? 0) + smoothing) / smoothedCurTotal;
    psi += (q - p) * Math.log(q / p);
  }
  return psi;
}

/**
 * Rolling aggregate window for one metric. Holds only bin counts and a FIFO
 * of bin labels (for eviction) — never the raw observations themselves for
 * numeric metrics, and only low-cardinality labels for categorical ones.
 */
export class RollingDistribution {
  private counts = new Map<string, number>();
  private order: string[] = [];

  constructor(
    readonly metric: DriftMetric,
    readonly maxSamples = 1000,
  ) {}

  addCategory(label: string): void {
    this.order.push(label);
    this.counts.set(label, (this.counts.get(label) ?? 0) + 1);
    while (this.order.length > this.maxSamples) {
      const evicted = this.order.shift();
      if (evicted === undefined) break;
      const remaining = (this.counts.get(evicted) ?? 1) - 1;
      if (remaining <= 0) this.counts.delete(evicted);
      else this.counts.set(evicted, remaining);
    }
  }

  snapshot(): DriftDistribution {
    return {
      metric: this.metric,
      totalSamples: this.order.length,
      counts: Object.fromEntries(this.counts),
    };
  }
}

/** One capture/session observation, already reduced to aggregate-safe fields. */
export interface DriftObservation {
  deviceModel?: string;
  osVersion?: string;
  envelopeVerdict?: string;
  strokeType?: string;
  fps?: number;
  resolutionShortSidePx?: number;
  playerApparentSizeFrac?: number;
  coverageFrac?: number;
  abstentionRate?: number;
  latencyMs?: number;
  targetLockSuccessRate?: number;
  eventDensityPerMin?: number;
  paddleVisibilityFrac?: number;
}

const CATEGORICAL_FIELDS: Readonly<Record<CategoricalDriftMetric, keyof DriftObservation>> =
  Object.freeze({
    device_model: "deviceModel",
    os_version: "osVersion",
    envelope_verdict: "envelopeVerdict",
    stroke_type: "strokeType",
  });

const NUMERIC_FIELDS: Readonly<Record<NumericDriftMetric, keyof DriftObservation>> = Object.freeze({
  fps: "fps",
  resolution_short_side_px: "resolutionShortSidePx",
  player_apparent_size_frac: "playerApparentSizeFrac",
  coverage_frac: "coverageFrac",
  abstention_rate: "abstentionRate",
  latency_ms: "latencyMs",
  target_lock_success_rate: "targetLockSuccessRate",
  event_density_per_min: "eventDensityPerMin",
  paddle_visibility_frac: "paddleVisibilityFrac",
});

/**
 * Maintains rolling distributions for every drift metric and runs the PSI
 * test of the current window against a frozen reference window.
 */
export class DriftMonitor {
  private readonly windows = new Map<DriftMetric, RollingDistribution>();
  private reference = new Map<DriftMetric, DriftDistribution>();

  constructor(readonly maxSamplesPerMetric = 1000) {
    for (const metric of CATEGORICAL_DRIFT_METRICS) {
      this.windows.set(metric, new RollingDistribution(metric, maxSamplesPerMetric));
    }
    for (const metric of NUMERIC_DRIFT_METRICS) {
      this.windows.set(metric, new RollingDistribution(metric, maxSamplesPerMetric));
    }
  }

  record(observation: DriftObservation): void {
    for (const metric of CATEGORICAL_DRIFT_METRICS) {
      const value = observation[CATEGORICAL_FIELDS[metric]];
      if (typeof value === "string") this.window(metric).addCategory(value);
    }
    for (const metric of NUMERIC_DRIFT_METRICS) {
      const value = observation[NUMERIC_FIELDS[metric]];
      if (typeof value === "number" && Number.isFinite(value)) {
        this.window(metric).addCategory(numericBinLabel(metric, value));
      }
    }
  }

  private window(metric: DriftMetric): RollingDistribution {
    const window = this.windows.get(metric);
    if (!window) throw new Error(`unknown drift metric: ${metric}`);
    return window;
  }

  /** Freeze the current windows as the reference baseline. */
  freezeReference(): void {
    this.reference = new Map(
      [...this.windows.entries()].map(([metric, window]) => [metric, window.snapshot()]),
    );
  }

  snapshot(metric: DriftMetric): DriftDistribution {
    return this.window(metric).snapshot();
  }

  /** Run the PSI drift test for one metric against the frozen reference. */
  test(metric: DriftMetric): DriftTestResult | DriftNotEvaluable {
    const reference = this.reference.get(metric);
    const current = this.window(metric).snapshot();
    const referenceSamples = reference?.totalSamples ?? 0;
    if (!reference || referenceSamples < DRIFT_THRESHOLDS.minSamples) {
      return {
        metric,
        reason: "insufficient_reference_samples",
        referenceSamples,
        currentSamples: current.totalSamples,
        thresholdsVersion: DRIFT_THRESHOLDS_VERSION,
      };
    }
    if (current.totalSamples < DRIFT_THRESHOLDS.minSamples) {
      return {
        metric,
        reason: "insufficient_current_samples",
        referenceSamples,
        currentSamples: current.totalSamples,
        thresholdsVersion: DRIFT_THRESHOLDS_VERSION,
      };
    }
    const psi = computePsi(reference.counts, current.counts);
    const severity: DriftSeverity =
      psi >= DRIFT_THRESHOLDS.psiDrift
        ? "drift"
        : psi >= DRIFT_THRESHOLDS.psiWarning
          ? "warning"
          : "stable";
    return {
      metric,
      psi,
      severity,
      referenceSamples,
      currentSamples: current.totalSamples,
      thresholdsVersion: DRIFT_THRESHOLDS_VERSION,
    };
  }

  /**
   * Test every metric and emit typed alert events for anything that is
   * drifting (or not evaluable). Stable metrics emit nothing.
   */
  alerts(at: string): DriftAlertEvent[] {
    const events: DriftAlertEvent[] = [];
    for (const metric of [...CATEGORICAL_DRIFT_METRICS, ...NUMERIC_DRIFT_METRICS]) {
      const result = this.test(metric);
      if ("reason" in result) {
        events.push({
          name: "drift_window_not_evaluable",
          at,
          metric,
          reason: result.reason,
          referenceSamples: result.referenceSamples,
          currentSamples: result.currentSamples,
          thresholdsVersion: result.thresholdsVersion,
        });
      } else if (result.severity !== "stable") {
        events.push({
          name: "drift_detected",
          at,
          metric,
          psi: result.psi,
          severity: result.severity,
          referenceSamples: result.referenceSamples,
          currentSamples: result.currentSamples,
          thresholdsVersion: result.thresholdsVersion,
        });
      }
    }
    return events;
  }
}
