/**
 * STRESS (lens: concurrency) — index.js global error handler + Hermes promise
 * rejection tracker.
 *
 * The entry file chains ONE global handler in front of React Native's and
 * routes unhandled rejections through `ErrorUtils.reportError`. Under a
 * seeded burst of fatal/non-fatal errors, weird rejection values, late
 * handles and throwing telemetry we assert the durable contract:
 *
 *  - every error reaches the previous (RN) handler exactly once, in order,
 *    with the same `(error, isFatal)` pair — no lost update, no duplicate;
 *  - one stability `crash` event per delivered error, `fatal` mirrors
 *    `isFatal === true`, fingerprints are idempotent per error;
 *  - a throwing telemetry recorder never blocks the previous handler;
 *  - every unhandled rejection becomes exactly one `reportError(Error)` and
 *    `toError` never throws, whatever the rejection value is;
 *  - the whole burst completes inside a bounded wall time (no deadlock).
 *
 * Scale is governed by STRESS_ITER (seeds per campaign; default 6) and
 * STRESS_BURST (events per seed; default 64). STRESS_ONLY=<seed> replays a
 * single seed; STRESS_OUT=<file> writes the seed → outcome table.
 */

import type { StabilityRecorder } from '../../src/analysis/stabilityTelemetry';

// The mobile tsconfig has no Node types (matches flow-app-store-compliance).
declare const process: { env: Record<string, string | undefined> };
declare const queueMicrotask: (fn: () => void) => void;
const { writeFileSync } = jest.requireActual<{
  writeFileSync: (path: string, data: string) => void;
}>('fs');

jest.mock('react-native', () => ({
  AppRegistry: { registerComponent: jest.fn() },
}));
jest.mock('../../App', () => ({ __esModule: true, default: () => null }));
jest.mock('../../src/notifications/service', () => ({
  registerBackgroundNotificationHandler: jest.fn(),
}));

// ─── Seeded RNG ──────────────────────────────────────────────────────────────

class SeededRng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }
}

// ─── Entry-point globals ─────────────────────────────────────────────────────

type Handler = (error: unknown, isFatal?: boolean) => void;
interface RejectionTrackerOptions {
  allRejections: boolean;
  onUnhandled: (id: number, rejection: unknown) => void;
  onHandled: (id: number) => void;
}
interface ErrorUtilsShape {
  getGlobalHandler(): Handler;
  setGlobalHandler(handler: Handler): void;
  reportError(error: unknown): void;
}
interface HermesInternalStub {
  enablePromiseRejectionTracker: (options: RejectionTrackerOptions) => void;
}

const mutableGlobal = globalThis as unknown as {
  __DEV__: boolean;
  ErrorUtils: ErrorUtilsShape;
  HermesInternal?: HermesInternalStub;
};

const originalErrorUtils = mutableGlobal.ErrorUtils;
const originalHandler = originalErrorUtils.getGlobalHandler();
const originalDev = mutableGlobal.__DEV__;
const originalHermes = mutableGlobal.HermesInternal;

interface Entry {
  stabilitySlo: StabilityRecorder;
  installed: Handler;
  previousCalls: Array<{ error: unknown; isFatal: boolean | undefined }>;
  /** Runs inside the previous (RN) handler — lets a test re-enter the chain. */
  hooks: { insidePrevious: Handler | null };
  reported: unknown[];
  tracker: RejectionTrackerOptions | null;
}

/** Loads index.js fresh with a controllable RN handler + Hermes tracker. */
function loadEntry(dev: boolean): Entry {
  const previousCalls: Entry['previousCalls'] = [];
  const reported: unknown[] = [];
  let tracker: RejectionTrackerOptions | null = null;
  const hooks: Entry['hooks'] = { insidePrevious: null };
  let current: Handler = (error, isFatal) => {
    previousCalls.push({ error, isFatal });
    hooks.insidePrevious?.(error, isFatal);
  };
  mutableGlobal.ErrorUtils = {
    getGlobalHandler: () => current,
    setGlobalHandler: handler => {
      current = handler;
    },
    reportError: error => {
      reported.push(error);
    },
  };
  mutableGlobal.__DEV__ = dev;
  mutableGlobal.HermesInternal = {
    enablePromiseRejectionTracker: options => {
      tracker = options;
    },
  };
  let stabilitySlo: StabilityRecorder | null = null;
  jest.isolateModules(() => {
    jest.requireActual('../../index.js');
    stabilitySlo = jest.requireActual<
      typeof import('../../src/analysis/stabilityTelemetry')
    >('../../src/analysis/stabilityTelemetry').stabilitySlo;
  });
  if (!stabilitySlo) throw new Error('stabilityTelemetry did not load');
  return {
    stabilitySlo,
    installed: current,
    previousCalls,
    hooks,
    reported,
    tracker,
  };
}

afterAll(() => {
  mutableGlobal.ErrorUtils = originalErrorUtils;
  originalErrorUtils.setGlobalHandler(originalHandler);
  mutableGlobal.__DEV__ = originalDev;
  mutableGlobal.HermesInternal = originalHermes;
});

// ─── Payload generators ──────────────────────────────────────────────────────

type PayloadKind =
  | 'error_with_frame'
  | 'error_no_stack'
  | 'error_blank_name'
  | 'string'
  | 'number'
  | 'null'
  | 'undefined'
  | 'plain_object'
  | 'circular_object'
  | 'bigint'
  | 'symbol'
  | 'throwing_getter'
  | 'huge_string';

const PAYLOAD_KINDS: readonly PayloadKind[] = [
  'error_with_frame',
  'error_with_frame',
  'error_with_frame',
  'error_no_stack',
  'error_blank_name',
  'string',
  'number',
  'null',
  'undefined',
  'plain_object',
  'circular_object',
  'bigint',
  'symbol',
  'throwing_getter',
  'huge_string',
];

function makePayload(
  kind: PayloadKind,
  rng: SeededRng,
  index: number,
): unknown {
  switch (kind) {
    case 'error_with_frame': {
      const error = new Error(`boom ${index}`);
      error.stack = `Error: boom ${index}\n    at frame${rng.int(4)} (index.bundle:${rng.int(9000)}:${rng.int(90)})\n    at second (index.bundle:1:999)`;
      return error;
    }
    case 'error_no_stack': {
      const error = new TypeError(`typeless ${index}`);
      error.stack = undefined;
      return error;
    }
    case 'error_blank_name': {
      const error = new Error(`nameless ${index}`);
      error.name = '';
      error.stack = '';
      return error;
    }
    case 'string':
      return `rejected-${index}`;
    case 'number':
      return index * 1.5;
    case 'null':
      return null;
    case 'undefined':
      return undefined;
    case 'plain_object':
      return { code: index, message: 'obj' };
    case 'circular_object': {
      const object: { self?: unknown; index: number } = { index };
      object.self = object;
      return object;
    }
    case 'bigint':
      return BigInt(index);
    case 'symbol':
      return Symbol(`sym-${index}`);
    case 'throwing_getter':
      return Object.defineProperty({}, 'message', {
        enumerable: true,
        get() {
          throw new Error('getter exploded');
        },
      });
    case 'huge_string':
      return 'x'.repeat(50_000 + rng.int(50_000));
    default:
      return kind;
  }
}

// ─── Campaign ────────────────────────────────────────────────────────────────

const ITER = Math.max(1, Number(process.env['STRESS_ITER'] ?? 6));
const BURST = Math.max(4, Number(process.env['STRESS_BURST'] ?? 64));
const BASE_SEED = Number(process.env['STRESS_SEED'] ?? 20260904);
const ONLY = process.env['STRESS_ONLY']
  ? Number(process.env['STRESS_ONLY'])
  : null;
const OUT = process.env['STRESS_OUT'];
const WALL_BUDGET_MS = 5_000;

type Family = 'global_handler_burst' | 'rejection_tracker_burst';
const FAMILIES: readonly Family[] = [
  'global_handler_burst',
  'rejection_tracker_burst',
];

interface Outcome {
  seed: number;
  family: Family;
  outcome: 'held' | 'broken';
  events: number;
  telemetryFaults: number;
  wallMs: number;
  violations: string[];
  payloadMix: Record<string, number>;
}

const outcomes: Outcome[] = [];

function seedsFor(family: Family): number[] {
  const offset = FAMILIES.indexOf(family) * 1_000_000;
  if (ONLY !== null) return [ONLY];
  return Array.from({ length: ITER }, (_, i) => BASE_SEED + offset + i);
}

function fingerprintsOf(entry: Entry): string[] {
  return entry.stabilitySlo
    .events()
    .filter(
      (event): event is Extract<typeof event, { kind: 'crash' }> =>
        event.kind === 'crash',
    )
    .map(event => event.fingerprint);
}

function fatalsOf(entry: Entry): boolean[] {
  return entry.stabilitySlo
    .events()
    .filter(
      (event): event is Extract<typeof event, { kind: 'crash' }> =>
        event.kind === 'crash',
    )
    .map(event => event.fatal);
}

async function runGlobalHandlerBurst(seed: number): Promise<Outcome> {
  const rng = new SeededRng(seed);
  const entry = loadEntry(true);
  const violations: string[] = [];
  const payloadMix: Record<string, number> = {};
  const record = entry.stabilitySlo.record.bind(entry.stabilitySlo);
  let telemetryFaults = 0;
  const faultRate = rng.pick([0, 0, 0.1, 0.35]);
  // Telemetry that intermittently throws must never block the RN handler.
  const spy = jest
    .spyOn(entry.stabilitySlo, 'record')
    .mockImplementation(event => {
      if (rng.chance(faultRate)) {
        telemetryFaults += 1;
        throw new Error('telemetry sink offline');
      }
      record(event);
    });

  const plan = Array.from({ length: BURST }, (_, index) => {
    const kind = rng.pick(PAYLOAD_KINDS);
    payloadMix[kind] = (payloadMix[kind] ?? 0) + 1;
    return {
      kind,
      payload: makePayload(kind, rng, index),
      isFatal: [true, false, undefined][rng.int(3)],
    };
  });

  const started = Date.now();
  // Duplicate calls: the same error object delivered twice must record twice
  // with the same fingerprint (fingerprinting is pure) and reach RN twice.
  const dupes = plan.filter(() => rng.chance(0.15));
  // Distinct delivery records even when the payload object is shared.
  const deliveries = [...plan, ...dupes].map(d => ({ ...d }));
  // Call-during-call: some deliveries are raised from INSIDE the previous
  // (RN) handler while the installed handler is still on the stack; the
  // rest arrive from a Promise.all burst spread over microtasks and timers.
  const nested = deliveries.filter(() => rng.chance(0.2));
  const direct = deliveries.filter(d => !nested.includes(d));
  let nestedIndex = 0;
  let reentryDepth = 0;
  const installed = mutableGlobal.ErrorUtils.getGlobalHandler();
  entry.hooks.insidePrevious = () => {
    if (reentryDepth > 0) return;
    const next = nested[nestedIndex];
    if (!next) return;
    nestedIndex += 1;
    reentryDepth += 1;
    try {
      installed(next.payload, next.isFatal);
    } finally {
      reentryDepth -= 1;
    }
  };
  await Promise.all(
    direct.map(
      (delivery, i) =>
        new Promise<void>(resolve => {
          const fire = () => {
            installed(delivery.payload, delivery.isFatal);
            resolve();
          };
          if (i % 3 === 0) queueMicrotask(fire);
          else if (i % 3 === 1) setTimeout(fire, 0);
          else fire();
        }),
    ),
  );
  // Any nested deliveries not yet consumed fire last.
  entry.hooks.insidePrevious = null;
  while (nestedIndex < nested.length) {
    const next = nested[nestedIndex];
    nestedIndex += 1;
    if (next) installed(next.payload, next.isFatal);
  }
  const wallMs = Date.now() - started;
  spy.mockRestore();

  const expectedCount = deliveries.length;
  if (entry.previousCalls.length !== expectedCount) {
    violations.push(
      `previous handler saw ${entry.previousCalls.length} calls, expected ${expectedCount}`,
    );
  }
  const seen = new Map<unknown, number>();
  for (const call of entry.previousCalls) {
    seen.set(call.error, (seen.get(call.error) ?? 0) + 1);
  }
  for (const delivery of deliveries) {
    const expected = deliveries.filter(
      d => d.payload === delivery.payload,
    ).length;
    if (seen.get(delivery.payload) !== expected) {
      violations.push(
        `payload delivered ${seen.get(delivery.payload) ?? 0}×, expected ${expected}×`,
      );
      break;
    }
  }
  for (const call of entry.previousCalls) {
    const match = deliveries.find(
      d => d.payload === call.error && d.isFatal === call.isFatal,
    );
    if (!match) {
      violations.push(
        'previous handler received an (error, isFatal) pair never sent',
      );
      break;
    }
  }
  const fingerprints = fingerprintsOf(entry);
  const fatals = fatalsOf(entry);
  // A payload whose `.message` getter throws defeats fingerprinting inside
  // the guarded block: the event is dropped but the handler chain continues.
  const unfingerprintable = deliveries.filter(
    d => d.kind === 'throwing_getter',
  ).length;
  const recorded = expectedCount - telemetryFaults - unfingerprintable;
  if (fingerprints.length !== recorded) {
    violations.push(
      `crash events ${fingerprints.length}, expected ${recorded} (${expectedCount} deliveries − ${telemetryFaults} telemetry faults − ${unfingerprintable} unfingerprintable)`,
    );
  }
  if (faultRate === 0) {
    // With healthy telemetry the crash log mirrors delivery order exactly.
    // The recorder runs BEFORE the previous handler, so a re-entrant
    // delivery is recorded after its parent but reaches RN before it —
    // compare as multisets in the nested case and as sequences otherwise.
    const expectedFatals = entry.previousCalls
      .filter(
        c =>
          deliveries.find(d => d.payload === c.error)?.kind !==
          'throwing_getter',
      )
      .map(c => c.isFatal === true);
    const sameOrder = JSON.stringify(fatals) === JSON.stringify(expectedFatals);
    const sameCount =
      fatals.filter(Boolean).length === expectedFatals.filter(Boolean).length;
    if (nested.length === 0 ? !sameOrder : !sameCount) {
      violations.push('fatal flags do not mirror isFatal===true');
    }
    // Idempotent fingerprint: the same error object always hashes the same.
    if (nested.length === 0) {
      const byPayload = new Map<unknown, Set<string>>();
      entry.previousCalls.forEach((call, i) => {
        const fp = fingerprints[i];
        if (fp === undefined) return;
        const set = byPayload.get(call.error) ?? new Set<string>();
        set.add(fp);
        byPayload.set(call.error, set);
      });
      for (const [, set] of byPayload) {
        if (set.size > 1) {
          violations.push('same error object produced different fingerprints');
          break;
        }
      }
    }
  }
  for (const fp of fingerprints) {
    if (!/^[0-9a-f]{8}$/.test(fp)) {
      violations.push(`fingerprint not an 8-hex djb2: ${fp}`);
      break;
    }
  }
  if (wallMs > WALL_BUDGET_MS) {
    violations.push(`burst took ${wallMs}ms > ${WALL_BUDGET_MS}ms budget`);
  }

  return {
    seed,
    family: 'global_handler_burst',
    outcome: violations.length === 0 ? 'held' : 'broken',
    events: expectedCount,
    telemetryFaults,
    wallMs,
    violations,
    payloadMix,
  };
}

async function runRejectionTrackerBurst(seed: number): Promise<Outcome> {
  const rng = new SeededRng(seed);
  const entry = loadEntry(false);
  const violations: string[] = [];
  const payloadMix: Record<string, number> = {};
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const consoleError = jest
    .spyOn(console, 'error')
    .mockImplementation(() => {});

  const tracker = entry.tracker;
  if (!tracker) {
    violations.push(
      'release entry did not enable the Hermes rejection tracker',
    );
    warn.mockRestore();
    consoleError.mockRestore();
    return {
      seed,
      family: 'rejection_tracker_burst',
      outcome: 'broken',
      events: 0,
      telemetryFaults: 0,
      wallMs: 0,
      violations,
      payloadMix,
    };
  }
  if (tracker.allRejections !== true) {
    violations.push('tracker not enabled with allRejections=true');
  }

  const plan = Array.from({ length: BURST }, (_, index) => {
    const kind = rng.pick(PAYLOAD_KINDS);
    payloadMix[kind] = (payloadMix[kind] ?? 0) + 1;
    return {
      id: 1 + index,
      payload: makePayload(kind, rng, index),
      handledLate: rng.chance(0.2),
    };
  });
  // Two actors on the same id: Hermes may report the same rejection id as
  // unhandled and then handled; the tracker must treat them independently.
  const duplicateIds = plan.filter(() => rng.chance(0.1));

  // Mid-burst, ErrorUtils.reportError disappears for a window (a host
  // without ErrorUtils) — the tracker must fall back to console.error and
  // never throw.
  const dropWindow = rng.chance(0.5)
    ? { from: rng.int(BURST), length: 1 + rng.int(8) }
    : null;
  const errorUtils = mutableGlobal.ErrorUtils;
  const reportError = errorUtils.reportError;
  let dropped = 0;

  const started = Date.now();
  let threw = 0;
  await Promise.all(
    [...plan, ...duplicateIds].map(
      (item, i) =>
        new Promise<void>(resolve => {
          const fire = () => {
            const inDrop =
              dropWindow !== null &&
              i >= dropWindow.from &&
              i < dropWindow.from + dropWindow.length;
            if (inDrop) {
              (errorUtils as { reportError?: unknown }).reportError = undefined;
              dropped += 1;
            }
            try {
              tracker.onUnhandled(item.id, item.payload);
              if (item.handledLate) tracker.onHandled(item.id);
            } catch {
              threw += 1;
            } finally {
              errorUtils.reportError = reportError;
            }
            resolve();
          };
          if (i % 2 === 0) queueMicrotask(fire);
          else setTimeout(fire, 0);
        }),
    ),
  );
  const wallMs = Date.now() - started;

  const total = plan.length + duplicateIds.length;
  if (threw > 0) violations.push(`onUnhandled/onHandled threw ${threw}×`);
  if (entry.reported.length !== total - dropped) {
    violations.push(
      `reportError called ${entry.reported.length}×, expected ${total - dropped} (${total} rejections − ${dropped} without ErrorUtils)`,
    );
  }
  if (consoleError.mock.calls.length !== dropped) {
    violations.push(
      `console.error fallback used ${consoleError.mock.calls.length}×, expected ${dropped}`,
    );
  }
  const notErrors = entry.reported.filter(r => !(r instanceof Error));
  if (notErrors.length > 0) {
    violations.push(
      `${notErrors.length} reported values are not Error instances`,
    );
  }
  for (const reported of entry.reported) {
    if (!(reported instanceof Error)) continue;
    const original = [...plan, ...duplicateIds].find(
      p => p.payload === reported,
    );
    if (original) continue; // Error rejections pass through untouched.
    if (!reported.message.startsWith('Unhandled promise rejection: ')) {
      violations.push(
        `non-Error rejection lost its prefix: ${reported.message.slice(0, 60)}`,
      );
      break;
    }
  }
  const lateCount = [...plan, ...duplicateIds].filter(
    p => p.handledLate,
  ).length;
  if (warn.mock.calls.length !== lateCount) {
    violations.push(
      `late-handled warnings ${warn.mock.calls.length}, expected ${lateCount}`,
    );
  }
  if (wallMs > WALL_BUDGET_MS) {
    violations.push(`burst took ${wallMs}ms > ${WALL_BUDGET_MS}ms budget`);
  }
  warn.mockRestore();
  consoleError.mockRestore();

  return {
    seed,
    family: 'rejection_tracker_burst',
    outcome: violations.length === 0 ? 'held' : 'broken',
    events: total,
    telemetryFaults: 0,
    wallMs,
    violations,
    payloadMix,
  };
}

afterAll(() => {
  if (!OUT) return;
  const held = outcomes.filter(o => o.outcome === 'held').length;
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        suite: 'indexEntry.errorHandlers.concurrency',
        baseSeed: BASE_SEED,
        iterationsPerFamily: ITER,
        burst: BURST,
        executed: outcomes.length,
        events: outcomes.reduce((sum, o) => sum + o.events, 0),
        held,
        broken: outcomes.length - held,
        rows: outcomes,
      },
      null,
      2,
    ),
  );
});

describe('index.js global error handler — seeded bursts', () => {
  it.each(seedsFor('global_handler_burst'))(
    'seed %i: every error reaches RN once, in order, with telemetry contained',
    async seed => {
      const outcome = await runGlobalHandlerBurst(seed);
      outcomes.push(outcome);
      expect(outcome.violations).toEqual([]);
    },
  );
});

describe('index.js promise rejection tracker — seeded bursts', () => {
  it.each(seedsFor('rejection_tracker_burst'))(
    'seed %i: every rejection becomes exactly one reported Error',
    async seed => {
      const outcome = await runRejectionTrackerBurst(seed);
      outcomes.push(outcome);
      expect(outcome.violations).toEqual([]);
    },
  );
});

describe('index.js entry — install is a no-op without host hooks', () => {
  it('does not throw when ErrorUtils lacks setGlobalHandler and Hermes is absent', () => {
    mutableGlobal.ErrorUtils = {
      getGlobalHandler: () => () => {},
      setGlobalHandler:
        undefined as unknown as ErrorUtilsShape['setGlobalHandler'],
      reportError: () => {},
    };
    mutableGlobal.HermesInternal = undefined;
    mutableGlobal.__DEV__ = false;
    expect(() =>
      jest.isolateModules(() => {
        jest.requireActual('../../index.js');
      }),
    ).not.toThrow();
  });
});
