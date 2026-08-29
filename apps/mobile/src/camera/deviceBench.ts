/**
 * Device-bench export contract (`pickle.device-bench.v1`).
 *
 * On-device benchmark evidence for the iPhone harness
 * (tools/mac-bench/IPHONE_HARNESS.md): thermal state, camera FPS, and memory
 * footprint sampled over a capture session, plus the per-capture telemetry
 * the capture pipeline already emits (CaptureCompletionTelemetryV1 /
 * TargetLockTelemetryV1 — referenced by clip, not duplicated).
 *
 * This module is intentionally pure: samples are PUSHED into a recorder by
 * whoever owns the native signal (thermal state changes from
 * ProcessInfo.thermalState via the bridge, FPS from the camera pipeline,
 * memory from task_info footprint polling). Nothing here reads native APIs,
 * so the whole contract is testable on Linux/CI. Missing signals stay
 * missing — an empty series exports as an empty series with a required
 * `unavailableReason`, never as fabricated zeros.
 */

export const DEVICE_BENCH_SCHEMA_VERSION = 'pickle.device-bench.v1' as const;

/** Mirrors ProcessInfo.thermalState (iOS). */
export type ThermalState = 'nominal' | 'fair' | 'serious' | 'critical';

export interface ThermalSampleV1 {
  /** ms since recorder start (monotonic clock, not wall time). */
  tMs: number;
  state: ThermalState;
}

export interface FpsSampleV1 {
  tMs: number;
  /** Frames delivered over the sampling window, per second. */
  fps: number;
  /** Sampling window the fps was averaged over. */
  windowMs: number;
}

export interface MemorySampleV1 {
  tMs: number;
  /** phys_footprint (task_info), bytes — the number iOS jetsams on. */
  footprintBytes: number;
}

export interface DeviceBenchSeriesV1<TSample> {
  samples: TSample[];
  /** Required when samples is empty: WHY the signal is missing. */
  unavailableReason: string | null;
}

export interface DeviceBenchCaptureRefV1 {
  clipUri: string;
  /** ms since recorder start when the capture finalized. */
  finalizedAtMs: number;
  completionStrategy: 'fixed' | 'adaptive';
  /** Schema versions of the telemetry records stored with the clip. */
  telemetrySchemas: string[];
}

export interface DeviceBenchExportV1 {
  schemaVersion: typeof DEVICE_BENCH_SCHEMA_VERSION;
  deviceModel: string;
  osVersion: string;
  appVersion: string;
  startedAtIso: string;
  durationMs: number;
  thermal: DeviceBenchSeriesV1<ThermalSampleV1>;
  fps: DeviceBenchSeriesV1<FpsSampleV1>;
  memory: DeviceBenchSeriesV1<MemorySampleV1>;
  captures: DeviceBenchCaptureRefV1[];
  notes: string[];
}

const THERMAL_STATES: ReadonlySet<string> = new Set([
  'nominal',
  'fair',
  'serious',
  'critical',
]);

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validateSeries<TSample>(
  errors: string[],
  label: string,
  series: unknown,
  validateSample: (sample: unknown, at: string) => void,
): void {
  if (typeof series !== 'object' || series === null) {
    errors.push(`${label}: not an object`);
    return;
  }
  const value = series as DeviceBenchSeriesV1<TSample>;
  if (!Array.isArray(value.samples)) {
    errors.push(`${label}.samples: not an array`);
    return;
  }
  if (value.samples.length === 0) {
    if (
      typeof value.unavailableReason !== 'string' ||
      value.unavailableReason.length === 0
    ) {
      errors.push(
        `${label}: empty series requires a nonempty unavailableReason`,
      );
    }
  } else if (value.unavailableReason !== null) {
    errors.push(`${label}: unavailableReason must be null when samples exist`);
  }
  let lastTMs = -Infinity;
  value.samples.forEach((sample, index) => {
    const at = `${label}.samples[${index}]`;
    if (typeof sample !== 'object' || sample === null) {
      errors.push(`${at}: not an object`);
      return;
    }
    const tMs = (sample as { tMs?: unknown }).tMs;
    if (!isFiniteNonNegative(tMs)) {
      errors.push(`${at}.tMs: not a finite non-negative number`);
    } else {
      if (tMs < lastTMs)
        errors.push(`${at}.tMs: not monotonically non-decreasing`);
      lastTMs = tMs;
    }
    validateSample(sample, at);
  });
}

/** Returns [] when valid; otherwise a list of precise problems. */
export function validateDeviceBenchExport(value: unknown): string[] {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null) {
    return ['document: not an object'];
  }
  const doc = value as DeviceBenchExportV1;
  if (doc.schemaVersion !== DEVICE_BENCH_SCHEMA_VERSION) {
    errors.push(
      `schemaVersion: expected "${DEVICE_BENCH_SCHEMA_VERSION}", got ${JSON.stringify(
        (doc as { schemaVersion?: unknown }).schemaVersion,
      )}`,
    );
  }
  for (const key of [
    'deviceModel',
    'osVersion',
    'appVersion',
    'startedAtIso',
  ] as const) {
    if (typeof doc[key] !== 'string' || doc[key].length === 0) {
      errors.push(`${key}: not a nonempty string`);
    }
  }
  if (!isFiniteNonNegative(doc.durationMs)) {
    errors.push('durationMs: not a finite non-negative number');
  }
  validateSeries<ThermalSampleV1>(
    errors,
    'thermal',
    doc.thermal,
    (sample, at) => {
      const state = (sample as { state?: unknown }).state;
      if (typeof state !== 'string' || !THERMAL_STATES.has(state)) {
        errors.push(`${at}.state: not one of nominal|fair|serious|critical`);
      }
    },
  );
  validateSeries<FpsSampleV1>(errors, 'fps', doc.fps, (sample, at) => {
    const fps = (sample as { fps?: unknown }).fps;
    const windowMs = (sample as { windowMs?: unknown }).windowMs;
    if (!isFiniteNonNegative(fps))
      errors.push(`${at}.fps: not a finite non-negative number`);
    if (
      typeof windowMs !== 'number' ||
      !Number.isFinite(windowMs) ||
      windowMs <= 0
    ) {
      errors.push(`${at}.windowMs: not a finite positive number`);
    }
  });
  validateSeries<MemorySampleV1>(errors, 'memory', doc.memory, (sample, at) => {
    const footprintBytes = (sample as { footprintBytes?: unknown })
      .footprintBytes;
    if (!isFiniteNonNegative(footprintBytes)) {
      errors.push(`${at}.footprintBytes: not a finite non-negative number`);
    }
  });
  if (!Array.isArray(doc.captures)) {
    errors.push('captures: not an array');
  } else {
    doc.captures.forEach((capture, index) => {
      const at = `captures[${index}]`;
      if (typeof capture !== 'object' || capture === null) {
        errors.push(`${at}: not an object`);
        return;
      }
      if (typeof capture.clipUri !== 'string' || capture.clipUri.length === 0) {
        errors.push(`${at}.clipUri: not a nonempty string`);
      }
      if (!isFiniteNonNegative(capture.finalizedAtMs)) {
        errors.push(`${at}.finalizedAtMs: not a finite non-negative number`);
      }
      if (
        capture.completionStrategy !== 'fixed' &&
        capture.completionStrategy !== 'adaptive'
      ) {
        errors.push(`${at}.completionStrategy: not "fixed" | "adaptive"`);
      }
      if (
        !Array.isArray(capture.telemetrySchemas) ||
        capture.telemetrySchemas.some(
          schema => typeof schema !== 'string' || schema.length === 0,
        )
      ) {
        errors.push(`${at}.telemetrySchemas: not an array of nonempty strings`);
      }
    });
  }
  if (
    !Array.isArray(doc.notes) ||
    doc.notes.some(note => typeof note !== 'string')
  ) {
    errors.push('notes: not an array of strings');
  }
  return errors;
}

export interface DeviceBenchRecorderInit {
  deviceModel: string;
  osVersion: string;
  appVersion: string;
  startedAtIso: string;
}

/**
 * Accumulates pushed samples and produces a validated export. Pure — the
 * caller owns clocks and native signal wiring, and every tMs is relative to
 * the caller's chosen recorder start.
 */
export class DeviceBenchRecorder {
  private readonly thermal: ThermalSampleV1[] = [];
  private readonly fps: FpsSampleV1[] = [];
  private readonly memory: MemorySampleV1[] = [];
  private readonly captures: DeviceBenchCaptureRefV1[] = [];
  private readonly notes: string[] = [];
  private lastTMs = 0;

  constructor(private readonly init: DeviceBenchRecorderInit) {}

  pushThermal(sample: ThermalSampleV1): void {
    this.thermal.push(sample);
    this.observe(sample.tMs);
  }

  pushFps(sample: FpsSampleV1): void {
    this.fps.push(sample);
    this.observe(sample.tMs);
  }

  pushMemory(sample: MemorySampleV1): void {
    this.memory.push(sample);
    this.observe(sample.tMs);
  }

  pushCapture(capture: DeviceBenchCaptureRefV1): void {
    this.captures.push(capture);
    this.observe(capture.finalizedAtMs);
  }

  addNote(note: string): void {
    this.notes.push(note);
  }

  /**
   * Builds and validates the export document. Empty series must be explained
   * via `unavailableReasons`; an unexplained empty series makes this throw
   * rather than emit an invalid document.
   */
  finalize(
    unavailableReasons: {
      thermal?: string;
      fps?: string;
      memory?: string;
    } = {},
  ): DeviceBenchExportV1 {
    const doc: DeviceBenchExportV1 = {
      schemaVersion: DEVICE_BENCH_SCHEMA_VERSION,
      deviceModel: this.init.deviceModel,
      osVersion: this.init.osVersion,
      appVersion: this.init.appVersion,
      startedAtIso: this.init.startedAtIso,
      durationMs: this.lastTMs,
      thermal: this.series(this.thermal, unavailableReasons.thermal),
      fps: this.series(this.fps, unavailableReasons.fps),
      memory: this.series(this.memory, unavailableReasons.memory),
      captures: [...this.captures],
      notes: [...this.notes],
    };
    const errors = validateDeviceBenchExport(doc);
    if (errors.length > 0) {
      throw new Error(`device-bench export invalid: ${errors.join('; ')}`);
    }
    return doc;
  }

  private series<TSample>(
    samples: TSample[],
    unavailableReason: string | undefined,
  ): DeviceBenchSeriesV1<TSample> {
    return {
      samples: [...samples],
      unavailableReason:
        samples.length === 0 ? (unavailableReason ?? null) : null,
    };
  }

  private observe(tMs: number): void {
    if (Number.isFinite(tMs) && tMs > this.lastTMs) {
      this.lastTMs = tMs;
    }
  }
}

/** Stable filename for the exported document. */
export function deviceBenchExportFilename(startedAtIso: string): string {
  return `device-bench-${startedAtIso.replace(/[:.]/g, '-')}.json`;
}
