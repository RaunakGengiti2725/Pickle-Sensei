/**
 * Long-run-leak stress campaign for @pickle/analytics (redaction guard +
 * buffered sink + drift monitor).
 *
 * One "iteration" is a full mount → use → unmount cycle of the unit as a
 * long-lived service would perform it: construct a BufferedAnalytics and a
 * DriftMonitor, push a seeded synthetic workload through them, run the
 * property oracles, then drop every reference. The campaign repeats that
 * ≥ STRESS_ITER times in ONE process, forcing GC and sampling heap + active
 * resources every `sampleEvery` iterations, and measuring per-iteration
 * wall time so a slope in either can be detected.
 *
 * Every iteration is replayable in isolation from its `seed` column via
 * `runIteration(seed, ...)`; the table row records the exact outcome.
 */
import { performance } from "node:perf_hooks";
import { runInNewContext } from "node:vm";
import { setFlagsFromString } from "node:v8";
import {
  BufferedAnalytics,
  CATEGORICAL_DRIFT_METRICS,
  DRIFT_THRESHOLDS,
  DriftMonitor,
  NUMERIC_DRIFT_METRICS,
  findPrivacyViolations,
  type AnalyticsEvent,
  type AnalyticsEventName,
  type DriftAlertEvent,
  type DriftMetric,
  type PrivacyViolation,
} from "../../src/index.js";
import { SeededRng, iterationSeed } from "./seededRng.js";
import {
  driftObservation,
  driftPopulation,
  eventBatch,
  type InjectedRule,
  type SyntheticEvent,
} from "./synthetic.js";

// ---------------------------------------------------------------------------
// GC + resource probes
// ---------------------------------------------------------------------------

export type GcSource = "expose-gc-flag" | "v8-setFlagsFromString";

interface GcHandle {
  gc: () => void;
  source: GcSource;
}

/**
 * Prefer the real `--expose-gc` global (present when the process — or the
 * vitest worker, which inherits NODE_OPTIONS — was started with the flag).
 * Fall back to enabling the flag at runtime and pulling `gc` out of a fresh
 * context; the report records which path was used so the evidence is honest.
 */
export function resolveGc(): GcHandle {
  const g = globalThis as { gc?: () => void };
  if (typeof g.gc === "function") return { gc: g.gc, source: "expose-gc-flag" };
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  return { gc, source: "v8-setFlagsFromString" };
}

export interface ResourceCounts {
  [kind: string]: number;
}

export function activeResourceCounts(): ResourceCounts {
  const out: ResourceCounts = {};
  for (const kind of process.getActiveResourcesInfo()) out[kind] = (out[kind] ?? 0) + 1;
  return out;
}

export function processListenerCount(): number {
  return process
    .eventNames()
    .reduce<number>((acc, name) => acc + process.listenerCount(name as string), 0);
}

export interface HeapSample {
  iteration: number;
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
  arrayBuffers: number;
  resources: ResourceCounts;
  processListeners: number;
}

function takeHeapSample(iteration: number, gc: () => void): HeapSample {
  gc();
  gc();
  const m = process.memoryUsage();
  return {
    iteration,
    heapUsed: m.heapUsed,
    heapTotal: m.heapTotal,
    rss: m.rss,
    external: m.external,
    arrayBuffers: m.arrayBuffers,
    resources: activeResourceCounts(),
    processListeners: processListenerCount(),
  };
}

// ---------------------------------------------------------------------------
// Property oracles
// ---------------------------------------------------------------------------

export type CheckName =
  | "guard_catches_every_injected_violation"
  | "guard_reports_exact_path_and_rule"
  | "guard_clean_events_pass"
  | "guard_deterministic_same_input"
  | "sink_drops_exactly_injected"
  | "sink_delivers_every_clean_event_once"
  | "sink_explicit_flush_after_outage_bounded"
  | "sink_abort_honoured_no_loss_no_dup"
  | "drift_window_bounded_by_max_samples"
  | "drift_counts_sum_to_total"
  | "drift_psi_finite_nonnegative"
  | "drift_identical_windows_psi_zero"
  | "drift_below_floor_not_evaluable"
  | "drift_severity_matches_frozen_thresholds"
  | "drift_alerts_no_nan_infinity"
  | "drift_nonfinite_inputs_ignored"
  | "iteration_deterministic_same_seed";

export interface CheckFailure {
  check: CheckName;
  detail: string;
}

export interface IterationResult {
  iteration: number;
  seed: number;
  outcome: "HELD" | "BROKEN";
  failures: CheckFailure[];
  durationMs: number;
  eventsTracked: number;
  violationsInjected: number;
  driftObservations: number;
  driftAlerts: number;
  /** Stable digest of everything the unit produced — equal for equal seeds. */
  digest: string;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Walk any JSON-ish value; return paths holding NaN/±Infinity. */
export function nonFinitePaths(value: unknown, path = ""): string[] {
  if (typeof value === "number") return Number.isFinite(value) ? [] : [path || "<root>"];
  if (Array.isArray(value)) return value.flatMap((v, i) => nonFinitePaths(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      nonFinitePaths(v, path ? `${path}.${k}` : k),
    );
  }
  return [];
}

function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

interface TrackOutcome {
  sent: AnalyticsEvent[];
  dropped: { name: AnalyticsEventName; violations: PrivacyViolation[] }[];
}

/** Let fire-and-forget flushes started inside track() settle (macrotask). */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function eventKey(e: AnalyticsEvent): string {
  return `${e.name}|${e.at}|${e.sessionId ?? ""}`;
}

async function runGuardAndSink(
  rng: SeededRng,
  batch: SyntheticEvent[],
  failures: CheckFailure[],
  digestParts: string[],
): Promise<TrackOutcome> {
  // --- pure guard oracles -------------------------------------------------
  for (const { event, injected } of batch) {
    const first = findPrivacyViolations(event);
    const second = findPrivacyViolations(event);
    if (JSON.stringify(first) !== JSON.stringify(second)) {
      failures.push({
        check: "guard_deterministic_same_input",
        detail: `two scans of the same event differed: ${JSON.stringify(first)} vs ${JSON.stringify(second)}`,
      });
    }
    if (injected === null) {
      if (first.length !== 0) {
        failures.push({
          check: "guard_clean_events_pass",
          detail: `clean ${event.name} flagged: ${JSON.stringify(first)}`,
        });
      }
    } else {
      if (first.length === 0) {
        failures.push({
          check: "guard_catches_every_injected_violation",
          detail: `${injected.rule} at ${injected.path} in ${event.name} passed the guard`,
        });
      } else if (!first.some((v) => v.rule === injected.rule && v.path === injected.path)) {
        failures.push({
          check: "guard_reports_exact_path_and_rule",
          detail: `expected {${injected.rule} @ ${injected.path}} got ${JSON.stringify(first)}`,
        });
      }
    }
    digestParts.push(first.map((v) => `${v.path}:${v.rule}`).join(","));
  }

  // --- sink: happy transport --------------------------------------------
  const maxBuffer = rng.int(1, 64);
  const sent: AnalyticsEvent[] = [];
  const dropped: TrackOutcome["dropped"] = [];
  const sink = new BufferedAnalytics(
    async (events) => {
      sent.push(...events);
    },
    maxBuffer,
    (name, violations) => dropped.push({ name, violations }),
  );
  for (const { event } of batch) sink.track(event);
  await sink.flush();
  await settle();
  await sink.flush();

  const injectedCount = batch.filter((b) => b.injected !== null).length;
  if (sink.droppedViolationCount() !== injectedCount || dropped.length !== injectedCount) {
    failures.push({
      check: "sink_drops_exactly_injected",
      detail: `injected=${injectedCount} droppedCounter=${sink.droppedViolationCount()} onViolation=${dropped.length}`,
    });
  }
  const cleanKeys = batch.filter((b) => b.injected === null).map((b) => eventKey(b.event));
  const sentKeys = sent.map(eventKey);
  if (
    sink.pendingCount() !== 0 ||
    sentKeys.length !== cleanKeys.length ||
    JSON.stringify([...sentKeys].sort()) !== JSON.stringify([...cleanKeys].sort())
  ) {
    failures.push({
      check: "sink_delivers_every_clean_event_once",
      detail: `clean=${cleanKeys.length} sent=${sentKeys.length} pending=${sink.pendingCount()} maxBuffer=${maxBuffer}`,
    });
  }

  // --- sink: after an EXPLICIT flush during an outage the retained tail is
  // bounded and non-empty. (Growth while only track() runs — no explicit
  // flush — is measured separately by outageGrowthProbe.)
  const failMax = rng.int(1, 16);
  const failing = new BufferedAnalytics(async () => {
    throw new Error("synthetic transport outage");
  }, failMax);
  const cleanEvents = batch.filter((b) => b.injected === null).map((b) => b.event);
  for (const e of cleanEvents) failing.track(e);
  for (let i = 0; i < 3; i++) {
    await failing.flush();
    await settle();
  }
  if (
    failing.pendingCount() > failMax ||
    (cleanEvents.length > 0 && failing.pendingCount() === 0)
  ) {
    failures.push({
      check: "sink_explicit_flush_after_outage_bounded",
      detail: `maxBuffer=${failMax} clean=${cleanEvents.length} pending=${failing.pendingCount()}`,
    });
  }

  // --- sink: abort mid-flight; then recover with no loss/dup -------------
  const abortMax = rng.int(8, 64);
  const controller = new AbortController();
  const delivered: AnalyticsEvent[] = [];
  let online = false;
  const abortable = new BufferedAnalytics(async (events) => {
    if (!online) {
      await new Promise<void>((_, reject) => {
        const onAbort = () => {
          controller.signal.removeEventListener("abort", onAbort);
          reject(new Error("aborted"));
        };
        controller.signal.addEventListener("abort", onAbort);
      });
    }
    delivered.push(...events);
  }, abortMax);
  const tail = cleanEvents.slice(-abortMax);
  for (const e of tail) abortable.track(e);
  const inflight = abortable.flush();
  controller.abort();
  await inflight;
  await settle();
  const afterAbort = abortable.pendingCount();
  online = true;
  await abortable.flush();
  const deliveredKeys = delivered.map(eventKey).sort();
  const tailKeys = tail.map(eventKey).sort();
  if (
    afterAbort !== tail.length ||
    abortable.pendingCount() !== 0 ||
    JSON.stringify(deliveredKeys) !== JSON.stringify(tailKeys)
  ) {
    failures.push({
      check: "sink_abort_honoured_no_loss_no_dup",
      detail: `tail=${tail.length} pendingAfterAbort=${afterAbort} delivered=${delivered.length} pendingEnd=${abortable.pendingCount()}`,
    });
  }
  digestParts.push(
    `sink:${sent.length}:${dropped.length}:${failing.pendingCount()}:${delivered.length}`,
  );
  return { sent, dropped };
}

const ALL_METRICS: readonly DriftMetric[] = [
  ...CATEGORICAL_DRIFT_METRICS,
  ...NUMERIC_DRIFT_METRICS,
];

function runDrift(
  rng: SeededRng,
  failures: CheckFailure[],
  digestParts: string[],
): { observations: number; alerts: DriftAlertEvent[] } {
  const maxSamples = rng.int(20, 600);
  const monitor = new DriftMonitor(maxSamples);
  const refPop = driftPopulation(rng);
  const refCount = rng.int(0, 400);
  for (let i = 0; i < refCount; i++) monitor.record(driftObservation(rng, refPop));

  // Non-finite inputs must be ignored: totals must not move.
  const before = ALL_METRICS.map((m) => monitor.snapshot(m).totalSamples);
  monitor.record({
    fps: Number.NaN,
    latencyMs: Number.POSITIVE_INFINITY,
    coverageFrac: Number.NEGATIVE_INFINITY,
    abstentionRate: Number.NaN,
  });
  const after = ALL_METRICS.map((m) => monitor.snapshot(m).totalSamples);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    failures.push({
      check: "drift_nonfinite_inputs_ignored",
      detail: `totals moved on NaN/Infinity input: ${before.join(",")} -> ${after.join(",")}`,
    });
  }

  monitor.freezeReference();

  // Identical windows → PSI exactly 0 (or not evaluable below the floor).
  for (const metric of ALL_METRICS) {
    const r = monitor.test(metric);
    if ("psi" in r && r.psi !== 0) {
      failures.push({
        check: "drift_identical_windows_psi_zero",
        detail: `${metric}: psi=${r.psi} for reference === current`,
      });
    }
  }

  const drifted = rng.chance(0.5);
  const curPop = drifted ? driftPopulation(rng) : refPop;
  const curCount = rng.int(0, 400);
  for (let i = 0; i < curCount; i++) monitor.record(driftObservation(rng, curPop));

  const at = new Date(Date.UTC(2026, 8, 5)).toISOString();
  const alerts = monitor.alerts(at);
  const nan = nonFinitePaths(alerts);
  if (nan.length > 0) {
    failures.push({ check: "drift_alerts_no_nan_infinity", detail: nan.join(";") });
  }

  for (const metric of ALL_METRICS) {
    const snap = monitor.snapshot(metric);
    const sum = Object.values(snap.counts).reduce((a, b) => a + b, 0);
    if (snap.totalSamples > maxSamples) {
      failures.push({
        check: "drift_window_bounded_by_max_samples",
        detail: `${metric}: totalSamples=${snap.totalSamples} > maxSamples=${maxSamples}`,
      });
    }
    if (sum !== snap.totalSamples || Object.values(snap.counts).some((c) => c <= 0)) {
      failures.push({
        check: "drift_counts_sum_to_total",
        detail: `${metric}: sum(counts)=${sum} totalSamples=${snap.totalSamples}`,
      });
    }
    const r = monitor.test(metric);
    const refSamples = r.referenceSamples;
    const curSamples = r.currentSamples;
    const shouldAbstain =
      refSamples < DRIFT_THRESHOLDS.minSamples || curSamples < DRIFT_THRESHOLDS.minSamples;
    if ("reason" in r) {
      if (!shouldAbstain) {
        failures.push({
          check: "drift_below_floor_not_evaluable",
          detail: `${metric}: abstained (${r.reason}) with ref=${refSamples} cur=${curSamples}`,
        });
      }
      digestParts.push(`${metric}:na:${r.reason}`);
    } else {
      if (shouldAbstain) {
        failures.push({
          check: "drift_below_floor_not_evaluable",
          detail: `${metric}: evaluated with ref=${refSamples} cur=${curSamples} (< ${DRIFT_THRESHOLDS.minSamples})`,
        });
      }
      if (!isFiniteNumber(r.psi) || r.psi < 0) {
        failures.push({
          check: "drift_psi_finite_nonnegative",
          detail: `${metric}: psi=${String(r.psi)}`,
        });
      }
      const expected =
        r.psi >= DRIFT_THRESHOLDS.psiDrift
          ? "drift"
          : r.psi >= DRIFT_THRESHOLDS.psiWarning
            ? "warning"
            : "stable";
      if (r.severity !== expected || r.thresholdsVersion !== DRIFT_THRESHOLDS.version) {
        failures.push({
          check: "drift_severity_matches_frozen_thresholds",
          detail: `${metric}: psi=${r.psi} severity=${r.severity} expected=${expected} version=${r.thresholdsVersion}`,
        });
      }
      digestParts.push(`${metric}:${r.psi.toFixed(12)}:${r.severity}`);
    }
  }
  return { observations: refCount + curCount + 1, alerts };
}

export interface IterationOptions {
  /** Events per iteration (default 40). */
  eventsPerIteration?: number;
}

interface RawIteration {
  failures: CheckFailure[];
  eventsTracked: number;
  violationsInjected: number;
  driftObservations: number;
  driftAlerts: number;
  digest: string;
}

async function runIterationRaw(seed: number, opts: IterationOptions): Promise<RawIteration> {
  const rng = new SeededRng(seed);
  const failures: CheckFailure[] = [];
  const digestParts: string[] = [];
  const count = opts.eventsPerIteration ?? 40;
  const violationRate = rng.float(0, 0.6);
  const batch = eventBatch(rng, count, violationRate);
  await runGuardAndSink(rng, batch, failures, digestParts);
  const drift = runDrift(rng, failures, digestParts);
  return {
    failures,
    eventsTracked: batch.length,
    violationsInjected: batch.filter((b) => b.injected !== null).length,
    driftObservations: drift.observations,
    driftAlerts: drift.alerts.length,
    digest: fnv1a(digestParts.join("\n")),
  };
}

/** Replay exactly one iteration from its seed (the row's `seed` column). */
export async function runIteration(
  seed: number,
  iteration: number,
  opts: IterationOptions = {},
): Promise<IterationResult> {
  const t0 = performance.now();
  const first = await runIterationRaw(seed, opts);
  const durationMs = performance.now() - t0;
  const second = await runIterationRaw(seed, opts);
  const failures = [...first.failures];
  if (first.digest !== second.digest) {
    failures.push({
      check: "iteration_deterministic_same_seed",
      detail: `digest ${first.digest} vs ${second.digest} for seed ${seed}`,
    });
  }
  return {
    iteration,
    seed,
    outcome: failures.length === 0 ? "HELD" : "BROKEN",
    failures,
    durationMs,
    eventsTracked: first.eventsTracked,
    violationsInjected: first.violationsInjected,
    driftObservations: first.driftObservations,
    driftAlerts: first.driftAlerts,
    digest: first.digest,
  };
}

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------

export interface HeapSlope {
  /** Least-squares slope of heapUsed vs iteration, in bytes per 100 iterations. */
  bytesPer100: number;
  /** Slope as % of the first post-warm-up sample, per 100 iterations. */
  pctPer100: number;
  /** True when every consecutive sample after warm-up is strictly higher. */
  monotone: boolean;
  firstHeapUsed: number;
  lastHeapUsed: number;
  samplesUsed: number;
}

export function heapSlope(samples: HeapSample[], warmupSamples = 1): HeapSlope {
  const used = samples.slice(warmupSamples);
  if (used.length < 2) {
    const only = used[0] ?? samples[samples.length - 1];
    const h = only?.heapUsed ?? 0;
    return {
      bytesPer100: 0,
      pctPer100: 0,
      monotone: false,
      firstHeapUsed: h,
      lastHeapUsed: h,
      samplesUsed: used.length,
    };
  }
  const n = used.length;
  const xs = used.map((s) => s.iteration);
  const ys = used.map((s) => s.heapUsed);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] ?? 0) - mx;
    num += dx * ((ys[i] ?? 0) - my);
    den += dx * dx;
  }
  const slopePerIter = den === 0 ? 0 : num / den;
  const first = ys[0] ?? 0;
  let monotone = true;
  for (let i = 1; i < n; i++) if ((ys[i] ?? 0) <= (ys[i - 1] ?? 0)) monotone = false;
  return {
    bytesPer100: slopePerIter * 100,
    pctPer100: first === 0 ? 0 : (slopePerIter * 100 * 100) / first,
    monotone,
    firstHeapUsed: first,
    lastHeapUsed: ys[n - 1] ?? 0,
    samplesUsed: n,
  };
}

export interface TimingDrift {
  windowSize: number;
  firstWindowMeanMs: number;
  lastWindowMeanMs: number;
  firstWindowP95Ms: number;
  lastWindowP95Ms: number;
  /** lastWindowMean / firstWindowMean (1.0 = no drift). */
  ratio: number;
  overallMeanMs: number;
  overallMaxMs: number;
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
}

export function timingDrift(rows: IterationResult[], windowSize: number): TimingDrift {
  const d = rows.map((r) => r.durationMs);
  const w = Math.max(1, Math.min(windowSize, Math.floor(d.length / 2)));
  const first = d.slice(0, w);
  const last = d.slice(-w);
  const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
  const fm = mean(first);
  const lm = mean(last);
  return {
    windowSize: w,
    firstWindowMeanMs: fm,
    lastWindowMeanMs: lm,
    firstWindowP95Ms: p95(first),
    lastWindowP95Ms: p95(last),
    ratio: fm === 0 ? 0 : lm / fm,
    overallMeanMs: mean(d),
    overallMaxMs: d.length === 0 ? 0 : Math.max(...d),
  };
}

export interface ResourceDelta {
  kind: string;
  baseline: number;
  final: number;
}

export function resourceDeltas(baseline: ResourceCounts, final: ResourceCounts): ResourceDelta[] {
  const kinds = new Set([...Object.keys(baseline), ...Object.keys(final)]);
  const out: ResourceDelta[] = [];
  for (const kind of kinds) {
    const b = baseline[kind] ?? 0;
    const f = final[kind] ?? 0;
    if (b !== f) out.push({ kind, baseline: b, final: f });
  }
  return out;
}

/** Resource kinds with MORE live instances at the end than at baseline. */
export function leakedResources(deltas: ResourceDelta[]): ResourceDelta[] {
  return deltas.filter((d) => d.final > d.baseline);
}

export interface CampaignOptions {
  campaignSeed: number;
  iterations: number;
  sampleEvery: number;
  eventsPerIteration?: number;
}

export interface CampaignReport {
  unit: "pkg-analytics";
  lens: "long-run-leak";
  gitRevision: string | null;
  node: string;
  gcSource: GcSource;
  options: CampaignOptions;
  startedAt: string;
  finishedAt: string;
  iterationsExecuted: number;
  scenariosExecuted: {
    iterations: number;
    eventsTracked: number;
    violationsInjected: number;
    driftObservations: number;
  };
  held: number;
  broken: number;
  failedSeeds: { iteration: number; seed: number; failures: CheckFailure[] }[];
  baselineResources: ResourceCounts;
  baselineProcessListeners: number;
  finalResources: ResourceCounts;
  finalProcessListeners: number;
  resourceDeltas: ResourceDelta[];
  leakedResources: ResourceDelta[];
  heapSamples: HeapSample[];
  heapSlope: HeapSlope;
  timing: TimingDrift;
  rows: IterationResult[];
}

export const HEAP_SLOPE_LIMIT_PCT_PER_100 = 5;

export async function runCampaign(
  options: CampaignOptions,
  gitRevision: string | null = null,
): Promise<CampaignReport> {
  const { gc, source } = resolveGc();
  const startedAt = new Date().toISOString();
  const baselineResources = activeResourceCounts();
  const baselineProcessListeners = processListenerCount();
  const heapSamples: HeapSample[] = [takeHeapSample(0, gc)];
  const rows: IterationResult[] = [];
  const iterOpts: IterationOptions = {};
  if (options.eventsPerIteration !== undefined) {
    iterOpts.eventsPerIteration = options.eventsPerIteration;
  }
  for (let i = 1; i <= options.iterations; i++) {
    const seed = iterationSeed(options.campaignSeed, i);
    rows.push(await runIteration(seed, i, iterOpts));
    if (i % options.sampleEvery === 0) heapSamples.push(takeHeapSample(i, gc));
  }
  if (rows.length % options.sampleEvery !== 0) heapSamples.push(takeHeapSample(rows.length, gc));
  gc();
  const finalResources = activeResourceCounts();
  const finalProcessListeners = processListenerCount();
  const failed = rows.filter((r) => r.outcome === "BROKEN");
  return {
    unit: "pkg-analytics",
    lens: "long-run-leak",
    gitRevision,
    node: process.version,
    gcSource: source,
    options,
    startedAt,
    finishedAt: new Date().toISOString(),
    iterationsExecuted: rows.length,
    scenariosExecuted: {
      iterations: rows.length,
      eventsTracked: rows.reduce((a, r) => a + r.eventsTracked, 0),
      violationsInjected: rows.reduce((a, r) => a + r.violationsInjected, 0),
      driftObservations: rows.reduce((a, r) => a + r.driftObservations, 0),
    },
    held: rows.length - failed.length,
    broken: failed.length,
    failedSeeds: failed.map((r) => ({
      iteration: r.iteration,
      seed: r.seed,
      failures: r.failures,
    })),
    baselineResources,
    baselineProcessListeners,
    finalResources,
    finalProcessListeners,
    resourceDeltas: resourceDeltas(baselineResources, finalResources),
    leakedResources: leakedResources(resourceDeltas(baselineResources, finalResources)),
    heapSamples,
    heapSlope: heapSlope(heapSamples),
    timing: timingDrift(rows, Math.max(10, Math.floor(options.iterations / 5))),
    rows,
  };
}

// ---------------------------------------------------------------------------
// Sink outage-growth probe (buffer bound while the transport is down)
// ---------------------------------------------------------------------------

export interface OutageGrowthRow {
  seed: number;
  maxBuffer: number;
  tracked: number;
  /** pendingCount() once every auto-flush started by track() has failed. */
  pendingAfterOutage: number;
  /** pendingCount() after one explicit flush() that also fails. */
  pendingAfterExplicitFlush: number;
  transportCalls: number;
}

/**
 * Model a long-lived service whose transport is down: it keeps calling
 * track() (which auto-flushes at maxBuffer) and never calls flush() itself
 * until later. The documented bound is `maxBuffer` (flush keeps
 * `batch.slice(-maxBuffer)`), so pendingAfterOutage must not exceed it.
 */
export async function outageGrowthProbe(
  seed: number,
  fixed: { maxBuffer?: number; multiples?: number } = {},
): Promise<OutageGrowthRow> {
  const rng = new SeededRng(seed);
  const maxBuffer = fixed.maxBuffer ?? rng.int(1, 32);
  const multiples = fixed.multiples ?? rng.int(2, 40);
  const tracked = maxBuffer * multiples;
  let transportCalls = 0;
  const sink = new BufferedAnalytics(async () => {
    transportCalls++;
    throw new Error("synthetic transport outage");
  }, maxBuffer);
  const batch = eventBatch(rng, tracked, 0);
  for (const { event } of batch) sink.track(event);
  await settle();
  const pendingAfterOutage = sink.pendingCount();
  await sink.flush();
  await settle();
  return {
    seed,
    maxBuffer,
    tracked,
    pendingAfterOutage,
    pendingAfterExplicitFlush: sink.pendingCount(),
    transportCalls,
  };
}

// ---------------------------------------------------------------------------
// Guard scan-cost probe (input-size sensitivity of the redaction regexes)
// ---------------------------------------------------------------------------

export interface ScanCostRow {
  seed: number;
  rule: InjectedRule | "none";
  length: number;
  violations: string[];
  durationMs: number;
}

/**
 * Time a single `findPrivacyViolations` call over one oversized string of
 * `length` characters drawn from the email local-part alphabet WITHOUT an
 * '@' (so the email rule must fail after trying every start position).
 */
export function scanCostProbe(seed: number, length: number): ScanCostRow {
  const rng = new SeededRng(seed);
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._%+-";
  let s = "";
  for (let i = 0; i < length; i++) s += alphabet[rng.int(0, alphabet.length - 1)];
  const event = {
    at: "2026-09-05T00:00:00.000Z",
    name: "analysis_failed",
    failureKind: s,
  } as AnalyticsEvent;
  const t0 = performance.now();
  const violations = findPrivacyViolations(event);
  const durationMs = performance.now() - t0;
  return {
    seed,
    rule: "oversized_string",
    length,
    violations: violations.map((v) => `${v.path}:${v.rule}`),
    durationMs,
  };
}
