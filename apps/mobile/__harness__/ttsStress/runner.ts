/**
 * Seeded stress runner for `apps/mobile/src/audio/tts.ts`.
 *
 * One ITERATION = one replayable scenario: a native-module variant (healthy,
 * absent, partial, throwing, …) plus a random operation sequence
 * (`speak(payload)` / `stop()` / `available()`, with optional rapid-cue
 * bursts) executed against a fresh import of the module. Every iteration is
 * classified HELD or BROKEN against the invariants below and emitted as a
 * JSON row (seed → outcome) so failures can be minimized and replayed.
 *
 * The harness never touches production code: variants are installed on
 * `NativeModules.PickleAudioCoach` (the RN jest preset exposes NativeModules
 * as a plain object) before the module is (re)imported via
 * `jest.isolateModules`, exactly as the real bridge would present them.
 *
 * Nothing here claims iOS/AVSpeechSynthesizer behaviour — the native side
 * is a recorder. What IS proven is what the JS wrapper does with each
 * payload before it reaches the bridge.
 */

import { NativeModules } from 'react-native';
import {
  PAYLOAD_CATEGORIES,
  generatePayload,
  textMetrics,
  type GeneratedPayload,
  type PayloadCategory,
  type TextMetrics,
} from './payloads';
import { createRng, deriveSeed, type Rng } from './rng';

type TtsModule = typeof import('../../src/audio/tts').tts;

// ---------------------------------------------------------------------------
// Native-module variants ("engine states")
// ---------------------------------------------------------------------------

export type NativeVariant =
  | 'healthy'
  | 'absent-undefined'
  | 'absent-null'
  | 'late-registered'
  | 'stop-only'
  | 'speak-non-function'
  | 'throwing-speak'
  | 'throwing-stop'
  | 'throwing-getter';

export const NATIVE_VARIANTS: readonly NativeVariant[] = [
  'healthy',
  'absent-undefined',
  'absent-null',
  'late-registered',
  'stop-only',
  'speak-non-function',
  'throwing-speak',
  'throwing-stop',
  'throwing-getter',
];

/** Relative frequency of each variant inside a campaign. */
const VARIANT_WEIGHTS: readonly (readonly [NativeVariant, number])[] = [
  ['healthy', 60],
  ['absent-undefined', 10],
  ['absent-null', 5],
  ['late-registered', 4],
  ['stop-only', 4],
  ['speak-non-function', 4],
  ['throwing-speak', 6],
  ['throwing-stop', 4],
  ['throwing-getter', 3],
];

export interface RecordedCall {
  method: 'speak' | 'stop';
  args: unknown[];
}

export interface NativeRecorder {
  calls: RecordedCall[];
  reset(): void;
}

interface InstalledVariant {
  variant: NativeVariant;
  tts: TtsModule;
  recorder: NativeRecorder;
  /** For `late-registered`: install a healthy module AFTER import. */
  registerLate(): void;
}

type MutableNativeModules = { PickleAudioCoach?: unknown };

export class NativeBridgeError extends Error {
  constructor(method: string) {
    super(`simulated bridge failure in ${method}`);
    this.name = 'NativeBridgeError';
  }
}

function buildNative(
  variant: NativeVariant,
  recorder: NativeRecorder,
): unknown {
  const speak = (...args: unknown[]): void => {
    recorder.calls.push({ method: 'speak', args });
  };
  const stop = (...args: unknown[]): void => {
    recorder.calls.push({ method: 'stop', args });
  };
  switch (variant) {
    case 'healthy':
      return { speak, stop };
    case 'absent-undefined':
    case 'late-registered':
      return undefined;
    case 'absent-null':
      return null;
    case 'stop-only':
      return { stop };
    case 'speak-non-function':
      return { speak: 'AVSpeechSynthesizer', stop };
    case 'throwing-speak':
      return {
        speak: (...args: unknown[]) => {
          recorder.calls.push({ method: 'speak', args });
          throw new NativeBridgeError('speak');
        },
        stop,
      };
    case 'throwing-stop':
      return {
        speak,
        stop: (...args: unknown[]) => {
          recorder.calls.push({ method: 'stop', args });
          throw new NativeBridgeError('stop');
        },
      };
    case 'throwing-getter':
      return new Proxy(
        {},
        {
          get(_target, prop) {
            throw new NativeBridgeError(`get ${String(prop)}`);
          },
        },
      );
    default: {
      const exhaustive: never = variant;
      throw new Error(`unknown variant ${String(exhaustive)}`);
    }
  }
}

const installed = new Map<NativeVariant, InstalledVariant>();

/**
 * Import `tts` once per variant with the variant's native module in place.
 * The module captures `NativeModules.PickleAudioCoach` at import time, so a
 * fresh registry per variant is the only faithful way to exercise it.
 */
export function installVariant(variant: NativeVariant): InstalledVariant {
  const existing = installed.get(variant);
  if (existing) {
    existing.recorder.reset();
    return existing;
  }
  const recorder: NativeRecorder = {
    calls: [],
    reset() {
      this.calls.length = 0;
    },
  };
  const nativeModules = NativeModules as MutableNativeModules;
  const previous = nativeModules.PickleAudioCoach;
  const hadPrevious = Object.prototype.hasOwnProperty.call(
    nativeModules,
    'PickleAudioCoach',
  );
  nativeModules.PickleAudioCoach = buildNative(variant, recorder);
  let tts: TtsModule | undefined;
  try {
    jest.isolateModules(() => {
      tts = (jest.requireActual('../../src/audio/tts') as { tts: TtsModule })
        .tts;
    });
  } finally {
    if (hadPrevious) nativeModules.PickleAudioCoach = previous;
    else delete nativeModules.PickleAudioCoach;
  }
  if (!tts) throw new Error('tts module failed to import');
  const entry: InstalledVariant = {
    variant,
    tts,
    recorder,
    registerLate() {
      nativeModules.PickleAudioCoach = buildNative('healthy', recorder);
    },
  };
  installed.set(variant, entry);
  return entry;
}

/** Drop cached imports (used by the determinism test). */
export function resetInstalledVariants(): void {
  installed.clear();
  delete (NativeModules as MutableNativeModules).PickleAudioCoach;
}

// ---------------------------------------------------------------------------
// Operations & invariants
// ---------------------------------------------------------------------------

export type OpKind = 'speak' | 'stop' | 'available';

export interface OpResult {
  op: OpKind;
  /** Present for `speak`. */
  category?: PayloadCategory;
  payload?: string;
  /** Present for `available`. */
  returned?: unknown;
  threw: boolean;
  errorName?: string;
  errorMessage?: string;
}

export type InvariantId =
  | 'I1-absent-engine-noop'
  | 'I2-healthy-never-throws'
  | 'I3-forward-identity'
  | 'I4-available-boolean'
  | 'I5-availability-contract'
  | 'I6-native-exception-contained'
  | 'I7-no-prototype-pollution'
  | 'I8-no-input-mutation'
  | 'I9-no-console-noise'
  | 'I10-rate-sane'
  | 'I11-late-registration-consistent';

export const INVARIANTS: readonly { id: InvariantId; statement: string }[] = [
  {
    id: 'I1-absent-engine-noop',
    statement:
      'With no native module (undefined/null) every op is a silent no-op: available()===false, speak/stop never throw.',
  },
  {
    id: 'I2-healthy-never-throws',
    statement:
      'With a healthy native module no payload of any shape makes speak/stop/available throw.',
  },
  {
    id: 'I3-forward-identity',
    statement:
      'Healthy: each speak(x) forwards exactly one native speak(x, 0.5) with the SAME reference (Object.is), in order; each stop() forwards one native stop().',
  },
  {
    id: 'I4-available-boolean',
    statement: 'available() returns a boolean.',
  },
  {
    id: 'I5-availability-contract',
    statement:
      'available()===true ⇒ speak() reaches the native speak without a JS TypeError; available()===false ⇒ speak()/stop() are no-ops (never throw).',
  },
  {
    id: 'I6-native-exception-contained',
    statement:
      'A native speak/stop that throws must not propagate out of tts.speak/tts.stop (cue emission must not crash the caller).',
  },
  {
    id: 'I7-no-prototype-pollution',
    statement:
      'Object.prototype gains no keys after any payload (incl. __proto__ / constructor.prototype shapes).',
  },
  {
    id: 'I8-no-input-mutation',
    statement:
      'Plain-data payloads are byte-identical (JSON snapshot) after the call.',
  },
  {
    id: 'I9-no-console-noise',
    statement:
      'Healthy/absent variants emit no console.error/console.warn per cue.',
  },
  {
    id: 'I10-rate-sane',
    statement: 'Forwarded rate is a finite number in [0, 1].',
  },
  {
    id: 'I11-late-registration-consistent',
    statement:
      'If the native module appears AFTER import, available() and speak() agree (both see it or both do not).',
  },
];

export type Outcome = 'HELD' | 'BROKEN';

export interface IterationRow {
  index: number;
  seed: number;
  variant: NativeVariant;
  ops: number;
  speaks: number;
  stops: number;
  availableCalls: number;
  burst: boolean;
  categories: PayloadCategory[];
  outcome: Outcome;
  violated: InvariantId[];
  /** First error observed (if any). */
  error?: { op: OpKind; name?: string; message?: string };
  /** Metrics of the largest string payload in the iteration. */
  largestText?: TextMetrics & { category: PayloadCategory };
  /** JSON.stringify([payload, 0.5]) outcome per speak — a bridge-serialization PROXY, not device truth. */
  bridgeJsonProxy: { ok: number; failed: number; failures: string[] };
  results: OpResult[];
}

interface PlannedOp {
  op: OpKind;
  payload?: GeneratedPayload;
}

function planOps(
  rng: Rng,
  variant: NativeVariant,
): { ops: PlannedOp[]; burst: boolean } {
  const burst = rng.bool(0.2);
  const length = burst ? rng.int(40, 200) : rng.int(1, 12);
  const ops: PlannedOp[] = [];
  // Always probe availability first so I5 has a reading.
  ops.push({ op: 'available' });
  for (let i = 0; i < length; i += 1) {
    const kind = rng.weighted<OpKind>([
      ['speak', burst ? 85 : 65],
      ['stop', burst ? 12 : 25],
      ['available', 10],
    ]);
    if (kind === 'speak') {
      // Bursts model rapid cue emission: mostly realistic cues with a few
      // hostile payloads interleaved; single-shot iterations lean hostile.
      const category = burst
        ? rng.bool(0.7)
          ? 'plain-cue'
          : rng.pick(PAYLOAD_CATEGORIES)
        : rng.pick(PAYLOAD_CATEGORIES);
      ops.push({ op: 'speak', payload: generatePayload(rng, category) });
    } else {
      ops.push({ op: kind });
    }
  }
  if (variant === 'late-registered') {
    // Probe again after registration happens mid-sequence.
    ops.push({ op: 'available' });
    ops.push({ op: 'speak', payload: generatePayload(rng, 'plain-cue') });
  }
  return { ops, burst };
}

function snapshot(payload: GeneratedPayload): string | null {
  if (!payload.snapshotable) return null;
  try {
    return JSON.stringify(payload.value, (_k, v: unknown) =>
      typeof v === 'number' && !Number.isFinite(v)
        ? `__nonfinite:${String(v)}`
        : v,
    );
  } catch {
    return null;
  }
}

function errorInfo(err: unknown): { name?: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: typeof err, message: String(err) };
}

function bridgeJsonProxy(payload: unknown): string | null {
  try {
    JSON.stringify([payload, 0.5]);
    return null;
  } catch (err) {
    const info = errorInfo(err);
    return `${info.name ?? 'Error'}: ${info.message ?? ''}`.slice(0, 120);
  }
}

/**
 * Run a single replayable iteration. `index` is only carried into the row.
 */
export function runIteration(seed: number, index = 0): IterationRow {
  const rng = createRng(seed);
  const variant = rng.weighted(VARIANT_WEIGHTS);
  const { ops: plan, burst } = planOps(rng, variant);
  const { tts, recorder, registerLate } = installVariant(variant);
  recorder.reset();

  const protoKeysBefore = Object.getOwnPropertyNames(Object.prototype).length;
  const consoleError = jest
    .spyOn(console, 'error')
    .mockImplementation(() => {});
  const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});

  const results: OpResult[] = [];
  const violated = new Set<InvariantId>();
  const categories: PayloadCategory[] = [];
  let largestText: IterationRow['largestText'];
  const proxy = { ok: 0, failed: 0, failures: [] as string[] };
  let firstError: IterationRow['error'];
  let speaks = 0;
  let stops = 0;
  let availableCalls = 0;
  let lateRegistered = false;
  const expectedForwarded: RecordedCall[] = [];
  const availabilityReadings: boolean[] = [];

  const lateTriggerAt =
    variant === 'late-registered' ? Math.floor(plan.length / 2) : -1;

  plan.forEach((planned, i) => {
    if (i === lateTriggerAt) {
      registerLate();
      lateRegistered = true;
    }
    const result: OpResult = { op: planned.op, threw: false };
    let before: string | null = null;
    if (planned.op === 'speak' && planned.payload) {
      speaks += 1;
      result.category = planned.payload.category;
      result.payload = planned.payload.describe;
      categories.push(planned.payload.category);
      before = snapshot(planned.payload);
      if (typeof planned.payload.value === 'string') {
        const m = textMetrics(planned.payload.value);
        if (!largestText || m.utf16Length > largestText.utf16Length) {
          largestText = { ...m, category: planned.payload.category };
        }
      }
      const proxyFailure = bridgeJsonProxy(planned.payload.value);
      if (proxyFailure) {
        proxy.failed += 1;
        if (proxy.failures.length < 5) proxy.failures.push(proxyFailure);
      } else {
        proxy.ok += 1;
      }
    } else if (planned.op === 'stop') {
      stops += 1;
    } else {
      availableCalls += 1;
    }

    try {
      if (planned.op === 'speak' && planned.payload) {
        (tts.speak as (text: unknown) => void)(planned.payload.value);
        if (
          variant === 'healthy' ||
          (variant === 'late-registered' && lateRegistered)
        ) {
          expectedForwarded.push({
            method: 'speak',
            args: [planned.payload.value, 0.5],
          });
        }
      } else if (planned.op === 'stop') {
        tts.stop();
        if (
          variant === 'healthy' ||
          (variant === 'late-registered' && lateRegistered)
        ) {
          expectedForwarded.push({ method: 'stop', args: [] });
        }
      } else {
        const returned: unknown = tts.available();
        result.returned = returned;
        if (typeof returned !== 'boolean') violated.add('I4-available-boolean');
        else availabilityReadings.push(returned);
      }
    } catch (err) {
      result.threw = true;
      const info = errorInfo(err);
      result.errorName = info.name;
      result.errorMessage = info.message?.slice(0, 200);
      if (!firstError) firstError = { op: planned.op, ...info };
    }

    if (planned.op === 'speak' && planned.payload && before !== null) {
      const after = snapshot(planned.payload);
      if (after !== before) violated.add('I8-no-input-mutation');
    }
    results.push(result);
  });

  // --- Invariant evaluation -------------------------------------------------
  const anyThrew = results.some(r => r.threw);
  const speakOrStopThrew = results.some(
    r => r.threw && (r.op === 'speak' || r.op === 'stop'),
  );

  if (variant === 'absent-undefined' || variant === 'absent-null') {
    if (anyThrew) violated.add('I1-absent-engine-noop');
    if (availabilityReadings.some(v => v !== false)) {
      violated.add('I1-absent-engine-noop');
    }
    if (recorder.calls.length !== 0) violated.add('I1-absent-engine-noop');
  }

  if (variant === 'healthy') {
    if (anyThrew) violated.add('I2-healthy-never-throws');
    const forwarded = recorder.calls;
    let identity = forwarded.length === expectedForwarded.length;
    if (identity) {
      for (let i = 0; i < forwarded.length; i += 1) {
        const got = forwarded[i];
        const want = expectedForwarded[i];
        if (!got || !want || got.method !== want.method) {
          identity = false;
          break;
        }
        if (got.args.length !== want.args.length) {
          identity = false;
          break;
        }
        for (let a = 0; a < got.args.length; a += 1) {
          if (!Object.is(got.args[a], want.args[a])) {
            identity = false;
            break;
          }
        }
        if (!identity) break;
        if (got.method === 'speak') {
          const rate = got.args[1];
          if (
            typeof rate !== 'number' ||
            !Number.isFinite(rate) ||
            rate < 0 ||
            rate > 1
          ) {
            violated.add('I10-rate-sane');
          }
        }
      }
    }
    if (!identity) violated.add('I3-forward-identity');
  }

  // I5: availability contract (evaluated on every variant that did not
  // simulate a native-side exception — those are I6's domain).
  if (
    variant !== 'throwing-speak' &&
    variant !== 'throwing-stop' &&
    variant !== 'throwing-getter'
  ) {
    const saidAvailable = availabilityReadings.some(v => v === true);
    const saidUnavailable = availabilityReadings.some(v => v === false);
    if (speakOrStopThrew && (saidAvailable || saidUnavailable)) {
      // Either reading makes a JS-side TypeError from speak/stop a contract
      // violation: "true" promised a working speak, "false" promised a no-op.
      violated.add('I5-availability-contract');
    }
  }

  // I6: native exceptions must not escape the wrapper.
  if (
    variant === 'throwing-speak' ||
    variant === 'throwing-stop' ||
    variant === 'throwing-getter'
  ) {
    if (anyThrew) violated.add('I6-native-exception-contained');
  }

  // I7: prototype pollution.
  const protoKeysAfter = Object.getOwnPropertyNames(Object.prototype).length;
  if (
    protoKeysAfter !== protoKeysBefore ||
    ({} as { polluted?: unknown }).polluted !== undefined
  ) {
    violated.add('I7-no-prototype-pollution');
  }

  // I9: console noise (only where the wrapper itself is the only actor).
  if (
    (variant === 'healthy' ||
      variant === 'absent-undefined' ||
      variant === 'absent-null') &&
    (consoleError.mock.calls.length > 0 || consoleWarn.mock.calls.length > 0)
  ) {
    violated.add('I9-no-console-noise');
  }
  consoleError.mockRestore();
  consoleWarn.mockRestore();
  if (lateRegistered) {
    delete (NativeModules as MutableNativeModules).PickleAudioCoach;
  }

  // I11: late registration — available() and speak() must agree.
  if (variant === 'late-registered') {
    const afterReadings = results
      .filter(r => r.op === 'available')
      .slice(-1)
      .map(r => r.returned);
    const lastAvailable = afterReadings[0];
    const forwardedAfter = recorder.calls.length;
    const speakAfter = results.slice(lateTriggerAt).some(r => r.op === 'speak');
    if (speakAfter) {
      const speakReached = forwardedAfter > 0;
      if (lastAvailable !== speakReached) {
        violated.add('I11-late-registration-consistent');
      }
    }
  }

  return {
    index,
    seed,
    variant,
    ops: plan.length,
    speaks,
    stops,
    availableCalls,
    burst,
    categories: Array.from(new Set(categories)),
    outcome: violated.size === 0 ? 'HELD' : 'BROKEN',
    violated: Array.from(violated).sort(),
    error: firstError,
    largestText,
    bridgeJsonProxy: proxy,
    results,
  };
}

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------

export interface CampaignSummary {
  campaignSeed: number;
  iterations: number;
  executed: number;
  held: number;
  broken: number;
  byVariant: Record<string, { executed: number; broken: number }>;
  byCategory: Record<string, { speaks: number; brokenIterations: number }>;
  byInvariant: Record<string, number>;
  totalOps: number;
  totalSpeaks: number;
  totalStops: number;
  totalAvailable: number;
  burstIterations: number;
  maxTextUtf16: number;
  maxTextUtf8Bytes: number;
  bridgeJsonProxy: { ok: number; failed: number; failureKinds: string[] };
  brokenSeeds: {
    seed: number;
    variant: NativeVariant;
    violated: InvariantId[];
  }[];
}

export interface CampaignResult {
  summary: CampaignSummary;
  rows: IterationRow[];
}

export interface CampaignOptions {
  campaignSeed: number;
  iterations: number;
  /** Keep per-op results in rows (large); default keeps them only for BROKEN rows. */
  keepAllResults?: boolean;
}

export function runCampaign(options: CampaignOptions): CampaignResult {
  const rows: IterationRow[] = [];
  const byVariant: CampaignSummary['byVariant'] = {};
  const byCategory: CampaignSummary['byCategory'] = {};
  const byInvariant: CampaignSummary['byInvariant'] = {};
  const failureKinds = new Set<string>();
  const summary: CampaignSummary = {
    campaignSeed: options.campaignSeed,
    iterations: options.iterations,
    executed: 0,
    held: 0,
    broken: 0,
    byVariant,
    byCategory,
    byInvariant,
    totalOps: 0,
    totalSpeaks: 0,
    totalStops: 0,
    totalAvailable: 0,
    burstIterations: 0,
    maxTextUtf16: 0,
    maxTextUtf8Bytes: 0,
    bridgeJsonProxy: { ok: 0, failed: 0, failureKinds: [] },
    brokenSeeds: [],
  };

  for (let i = 0; i < options.iterations; i += 1) {
    const seed = deriveSeed(options.campaignSeed, i);
    const row = runIteration(seed, i);
    summary.executed += 1;
    summary.totalOps += row.ops;
    summary.totalSpeaks += row.speaks;
    summary.totalStops += row.stops;
    summary.totalAvailable += row.availableCalls;
    if (row.burst) summary.burstIterations += 1;
    if (row.largestText) {
      summary.maxTextUtf16 = Math.max(
        summary.maxTextUtf16,
        row.largestText.utf16Length,
      );
      summary.maxTextUtf8Bytes = Math.max(
        summary.maxTextUtf8Bytes,
        row.largestText.utf8Bytes,
      );
    }
    summary.bridgeJsonProxy.ok += row.bridgeJsonProxy.ok;
    summary.bridgeJsonProxy.failed += row.bridgeJsonProxy.failed;
    for (const f of row.bridgeJsonProxy.failures) failureKinds.add(f);

    const v = (byVariant[row.variant] ??= { executed: 0, broken: 0 });
    v.executed += 1;
    for (const r of row.results) {
      if (r.op === 'speak' && r.category) {
        const c = (byCategory[r.category] ??= {
          speaks: 0,
          brokenIterations: 0,
        });
        c.speaks += 1;
      }
    }
    if (row.outcome === 'HELD') {
      summary.held += 1;
    } else {
      summary.broken += 1;
      v.broken += 1;
      for (const cat of row.categories) {
        const c = (byCategory[cat] ??= { speaks: 0, brokenIterations: 0 });
        c.brokenIterations += 1;
      }
      for (const inv of row.violated) {
        byInvariant[inv] = (byInvariant[inv] ?? 0) + 1;
      }
      summary.brokenSeeds.push({
        seed: row.seed,
        variant: row.variant,
        violated: row.violated,
      });
    }
    rows.push(
      options.keepAllResults || row.outcome === 'BROKEN'
        ? row
        : { ...row, results: [] },
    );
  }
  summary.bridgeJsonProxy.failureKinds = Array.from(failureKinds).sort();
  return { summary, rows };
}

/**
 * Minimize a broken seed: replay it and return the smallest op prefix that
 * still violates at least one of the same invariants. Because the plan is a
 * pure function of the seed, the prefix is described by (seed, opCount).
 */
export function minimizeSeed(seed: number): {
  seed: number;
  variant: NativeVariant;
  fullOps: number;
  violated: InvariantId[];
  firstViolatingOp?: OpResult;
  firstViolatingOpIndex?: number;
} {
  const row = runIteration(seed);
  const firstIdx = row.results.findIndex(r => r.threw);
  return {
    seed,
    variant: row.variant,
    fullOps: row.ops,
    violated: row.violated,
    firstViolatingOp: firstIdx >= 0 ? row.results[firstIdx] : undefined,
    firstViolatingOpIndex: firstIdx >= 0 ? firstIdx : undefined,
  };
}
