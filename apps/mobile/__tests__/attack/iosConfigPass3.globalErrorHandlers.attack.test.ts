/**
 * ADVERSARIAL PASS 3 / mobile-ios-config — index.js global error handling.
 *
 * Attacks the crash fingerprint + Hermes rejection tracker installed by
 * apps/mobile/index.js with hostile inputs the fix-23 suite does not cover:
 *
 *   S1  a 1 MB stack with NO 'at ' frame + a throwing `name` getter
 *   S2  two unhandled rejections with identical stacks fired in the SAME tick
 *   S4  stabilitySlo.record throwing synchronously
 *
 * Every test names the invariant the coordinator asked for; when the baseline
 * deviates, the test asserts the OBSERVED behaviour under a
 * `BASELINE BEHAVIOUR:` label so the deviation is pinned as evidence rather
 * than hidden — see the pass report for the BROKEN/HELD classification.
 *
 * Mock style mirrors __tests__/wf/fix-23-globalErrorHandlers.test.ts.
 */
import type { StabilityRecorder } from '../../src/analysis/stabilityTelemetry';

jest.mock('react-native', () => ({
  AppRegistry: { registerComponent: jest.fn() },
}));
jest.mock('../../App', () => ({ __esModule: true, default: () => null }));
jest.mock('../../src/notifications/service', () => ({
  registerBackgroundNotificationHandler: jest.fn(),
}));

type Handler = (error: unknown, isFatal?: boolean) => void;
type RejectionTrackerOptions = {
  allRejections: boolean;
  onUnhandled: (id: number, rejection: unknown) => void;
  onHandled: (id: number) => void;
};
type HermesInternalStub = {
  enablePromiseRejectionTracker: jest.Mock<void, [RejectionTrackerOptions]>;
};

const errorUtils = (
  globalThis as unknown as {
    ErrorUtils: {
      getGlobalHandler(): Handler;
      setGlobalHandler(handler: Handler): void;
      reportError(error: unknown): void;
    };
  }
).ErrorUtils;
const mutableGlobal = globalThis as unknown as {
  __DEV__: boolean;
  HermesInternal?: HermesInternalStub;
};

const originalHandler = errorUtils.getGlobalHandler();
const originalDev = mutableGlobal.__DEV__;
const previousHandler = jest.fn<void, [unknown, boolean | undefined]>();
const hermesStub: HermesInternalStub = {
  enablePromiseRejectionTracker: jest.fn(),
};

let stabilitySlo: StabilityRecorder;

function loadEntry(dev: boolean): void {
  mutableGlobal.__DEV__ = dev;
  mutableGlobal.HermesInternal = hermesStub;
  errorUtils.setGlobalHandler(previousHandler);
  jest.isolateModules(() => {
    jest.requireActual('../../index.js');
    stabilitySlo = jest.requireActual<
      typeof import('../../src/analysis/stabilityTelemetry')
    >('../../src/analysis/stabilityTelemetry').stabilitySlo;
  });
}

function crashEvents() {
  return stabilitySlo
    .events()
    .filter(
      (event): event is Extract<typeof event, { kind: 'crash' }> =>
        event.kind === 'crash',
    );
}

const ONE_MIB = 1024 * 1024;

/** 1 MiB stack body made of lines that never start with 'at ' — every line
 * is a trap: leading whitespace, 'AT ' upper-case, 'at' glued to a word,
 * unicode, and a final line without a newline. */
function hugeFramelessStack(seed: number): string {
  const lines: string[] = [];
  let size = 0;
  let x = seed >>> 0;
  const traps = [
    '    \u00e0t frame (index.bundle:1:1)',
    'AT tap (index.bundle:1:100)',
    'attach (index.bundle:1:100)',
    '\tData: \u{1F3BE}\u{1F3D3} pickle',
    '  at\u00a0nbsp (index.bundle:1:2)',
    '',
  ];
  while (size < ONE_MIB) {
    x = (x * 1664525 + 1013904223) >>> 0;
    const line = `${traps[x % traps.length]}${'#'.repeat(x % 64)}`;
    lines.push(line);
    size += line.length + 1;
  }
  return `Error: huge\n${lines.join('\n')}`;
}

function errorWithStack(message: string, frame: string): Error {
  const error = new Error(message);
  error.stack = `Error: ${message}\n    at ${frame}\n    at second (index.bundle:1:999)`;
  return error;
}

afterEach(() => {
  previousHandler.mockReset();
  hermesStub.enablePromiseRejectionTracker.mockReset();
});

afterAll(() => {
  errorUtils.setGlobalHandler(originalHandler);
  mutableGlobal.__DEV__ = originalDev;
  delete mutableGlobal.HermesInternal;
});

describe('S1 — crashFingerprint under a 1 MiB frameless stack', () => {
  const SEED = 0x5eed_0003;

  it('1 MiB stack with no "at " frame → fingerprint is 8 hex chars, derived from the message', () => {
    loadEntry(false);
    const installed = errorUtils.getGlobalHandler();
    const stack = hugeFramelessStack(SEED);
    expect(stack.length).toBeGreaterThanOrEqual(ONE_MIB);
    expect(stack.split('\n').some(line => line.trim().startsWith('at '))).toBe(
      false,
    );

    const error = new Error('huge');
    error.stack = stack;
    const started = Date.now();
    installed(error, true);
    const elapsedMs = Date.now() - started;

    expect(previousHandler).toHaveBeenCalledTimes(1);
    expect(previousHandler).toHaveBeenCalledWith(error, true);
    const [event] = crashEvents();
    expect(event).toMatchObject({ kind: 'crash', fatal: true });
    expect(event?.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(elapsedMs).toBeLessThan(5_000);

    // Frameless → name|message fallback: an identical message with an
    // entirely different frameless stack must collide, a different message
    // must not.
    const twin = new Error('huge');
    twin.stack = `Error: huge\n${'x'.repeat(2048)}`;
    installed(twin, true);
    const other = new Error('huge-2');
    other.stack = stack;
    installed(other, true);
    const [a, b, c] = crashEvents();
    expect(a?.fingerprint).toBe(b?.fingerprint);
    expect(a?.fingerprint).not.toBe(c?.fingerprint);
  });

  it('1 MiB stack whose ONLY "at " frame is the last line still fingerprints by that frame', () => {
    loadEntry(false);
    const installed = errorUtils.getGlobalHandler();
    const error = new Error('tail frame');
    error.stack = `${hugeFramelessStack(SEED)}\n    at tail (index.bundle:1:1)`;
    installed(error, false);
    const control = errorWithStack(
      'different message',
      'tail (index.bundle:1:1)',
    );
    installed(control, false);
    const [a, b] = crashEvents();
    expect(a?.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(a?.fingerprint).toBe(b?.fingerprint);
    expect(previousHandler).toHaveBeenCalledTimes(2);
  });

  it('1 MiB frameless stack + throwing `name` getter: previous handler still gets (error, true)', () => {
    loadEntry(false);
    const installed = errorUtils.getGlobalHandler();
    const hostile = new Error('hostile name');
    hostile.stack = hugeFramelessStack(SEED ^ 0xffff);
    Object.defineProperty(hostile, 'name', {
      get() {
        throw new Error('name getter trap');
      },
    });

    expect(() => installed(hostile, true)).not.toThrow();
    expect(previousHandler).toHaveBeenCalledTimes(1);
    expect(previousHandler).toHaveBeenCalledWith(hostile, true);
  });

  it('BASELINE BEHAVIOUR: a throwing `name` getter drops the crash event entirely (no 8-hex fingerprint is recorded)', () => {
    // Coordinator invariant: "fingerprint must still be 8 hex chars".
    // Observed on 4d812e1a: crashFingerprint reads `error.name` outside any
    // try/catch, the getter throws, installGlobalErrorHandler's catch swallows
    // it, and stabilitySlo receives NOTHING for this crash. The same design
    // is already pinned for a throwing `stack` getter in fix-23 (3 hostile
    // throwables → 2 crash events), so this is pre-existing, not a
    // regression. Flip this expectation if crashFingerprint is hardened.
    loadEntry(false);
    const installed = errorUtils.getGlobalHandler();
    const hostile = new Error('hostile name');
    hostile.stack = hugeFramelessStack(SEED);
    Object.defineProperty(hostile, 'name', {
      get() {
        throw new Error('name getter trap');
      },
    });
    installed(hostile, true);
    expect(previousHandler).toHaveBeenCalledTimes(1);
    expect(crashEvents()).toHaveLength(0);
  });

  it('BASELINE BEHAVIOUR: an Error whose `name` is a Symbol also drops the crash event (lazy stack getter throws on `${name}`)', () => {
    // Same class as the throwing getter above: under V8 (this Jest run)
    // reading `error.stack` formats `${name}: ${message}` lazily and a Symbol
    // name makes that throw, so crashFingerprint throws and the crash is not
    // counted. Hermes behaviour is not asserted here. Handler delivery is
    // intact.
    loadEntry(false);
    const installed = errorUtils.getGlobalHandler();
    const symbolNamed = Object.assign(new Error('sym'), {
      name: Symbol('name') as unknown,
    });
    expect(() => installed(symbolNamed, true)).not.toThrow();
    expect(previousHandler).toHaveBeenCalledWith(symbolNamed, true);
    expect(crashEvents()).toHaveLength(0);
  });

  it('hostile non-string name/stack/message shapes (numbers, objects, null, control chars, null-prototype) still yield 8 hex chars', () => {
    loadEntry(false);
    const installed = errorUtils.getGlobalHandler();
    const shapes: unknown[] = [
      { name: 42, stack: 12345, message: { nested: true } },
      { name: '', stack: null, message: null },
      { name: 'E', stack: '\n'.repeat(4096), message: '\u0000\uFFFF' },
      Object.create(null),
    ];
    for (const shape of shapes) installed(shape, false);
    expect(previousHandler).toHaveBeenCalledTimes(shapes.length);
    const events = crashEvents();
    expect(events).toHaveLength(shapes.length);
    for (const event of events) {
      expect(event.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    }
  });
});

describe('S2 — identical unhandled rejections in the same tick under the Hermes tracker', () => {
  function tracker(): RejectionTrackerOptions {
    const options = hermesStub.enablePromiseRejectionTracker.mock.calls[0]?.[0];
    expect(options).toBeDefined();
    expect(options?.allRejections).toBe(true);
    return options as RejectionTrackerOptions;
  }

  it('two distinct Error objects with byte-identical stacks → two reportError deliveries, no dedupe', () => {
    loadEntry(false);
    const reportSpy = jest.spyOn(errorUtils, 'reportError');
    try {
      const { onUnhandled } = tracker();
      const a = errorWithStack('fetch failed', 'sync (index.bundle:1:300)');
      const b = errorWithStack('fetch failed', 'sync (index.bundle:1:300)');
      expect(a.stack).toBe(b.stack);
      onUnhandled(1, a);
      onUnhandled(2, b);

      expect(reportSpy).toHaveBeenCalledTimes(2);
      expect(reportSpy.mock.calls[0]?.[0]).toBe(a);
      expect(reportSpy.mock.calls[1]?.[0]).toBe(b);
      expect(previousHandler).toHaveBeenCalledTimes(2);
      expect(previousHandler.mock.calls[0]).toEqual([a, false]);
      expect(previousHandler.mock.calls[1]).toEqual([b, false]);
      const events = crashEvents();
      expect(events).toHaveLength(2);
      expect(events[0]?.fingerprint).toBe(events[1]?.fingerprint);
    } finally {
      reportSpy.mockRestore();
    }
  });

  it('the SAME Error instance rejected twice with the same id → still two deliveries', () => {
    loadEntry(false);
    const reportSpy = jest.spyOn(errorUtils, 'reportError');
    try {
      const { onUnhandled } = tracker();
      const same = errorWithStack('dup', 'sync (index.bundle:1:300)');
      onUnhandled(7, same);
      onUnhandled(7, same);
      expect(reportSpy).toHaveBeenCalledTimes(2);
      expect(previousHandler).toHaveBeenCalledTimes(2);
      expect(crashEvents()).toHaveLength(2);
    } finally {
      reportSpy.mockRestore();
    }
  });

  it('a burst of 500 identical non-Error rejections in one tick → 500 deliveries, no loss', () => {
    loadEntry(false);
    const reportSpy = jest.spyOn(errorUtils, 'reportError');
    try {
      const { onUnhandled } = tracker();
      const payload = { code: 'E_SAME', detail: 'x'.repeat(256) };
      for (let i = 0; i < 500; i += 1) onUnhandled(i, payload);
      expect(reportSpy).toHaveBeenCalledTimes(500);
      expect(previousHandler).toHaveBeenCalledTimes(500);
      for (const call of previousHandler.mock.calls) {
        expect(call[0]).toBeInstanceOf(Error);
        expect((call[0] as Error).message).toContain('E_SAME');
        expect(call[1]).toBe(false);
      }
    } finally {
      reportSpy.mockRestore();
    }
  });

  it('interleaving onHandled between two identical onUnhandled calls does not suppress the second', () => {
    loadEntry(false);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const reportSpy = jest.spyOn(errorUtils, 'reportError');
    try {
      const { onUnhandled, onHandled } = tracker();
      const a = errorWithStack('late', 'sync (index.bundle:1:300)');
      const b = errorWithStack('late', 'sync (index.bundle:1:300)');
      onUnhandled(11, a);
      onHandled(11);
      onUnhandled(12, b);
      expect(reportSpy).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('11');
    } finally {
      reportSpy.mockRestore();
      warn.mockRestore();
    }
  });

  it('a rejection payload that throws on JSON.stringify (BigInt / cyclic) is still reported, never thrown', () => {
    loadEntry(false);
    const reportSpy = jest.spyOn(errorUtils, 'reportError');
    try {
      const { onUnhandled } = tracker();
      const cyclic: { self?: unknown } = {};
      cyclic.self = cyclic;
      expect(() => onUnhandled(1, cyclic)).not.toThrow();
      expect(() => onUnhandled(2, BigInt(1) as unknown)).not.toThrow();
      expect(() => onUnhandled(3, undefined)).not.toThrow();
      expect(() => onUnhandled(4, Symbol('s') as unknown)).not.toThrow();
      expect(reportSpy).toHaveBeenCalledTimes(4);
      expect(previousHandler).toHaveBeenCalledTimes(4);
    } finally {
      reportSpy.mockRestore();
    }
  });
});

describe('S4 — stabilitySlo.record throwing synchronously', () => {
  const recordTrap = jest.fn<void, [unknown]>(() => {
    throw new Error('telemetry exploded');
  });

  function loadEntryWithThrowingTelemetry(): void {
    mutableGlobal.__DEV__ = false;
    mutableGlobal.HermesInternal = hermesStub;
    errorUtils.setGlobalHandler(previousHandler);
    jest.isolateModules(() => {
      jest.doMock('../../src/analysis/stabilityTelemetry', () => ({
        stabilitySlo: { record: recordTrap, events: () => [] },
      }));
      jest.requireActual('../../index.js');
    });
  }

  afterEach(() => {
    recordTrap.mockClear();
    jest.dontMock('../../src/analysis/stabilityTelemetry');
  });

  it('fatal path: the previous global handler still receives the ORIGINAL (error, isFatal)', () => {
    loadEntryWithThrowingTelemetry();
    const installed = errorUtils.getGlobalHandler();
    expect(installed).not.toBe(previousHandler);
    const error = errorWithStack('boom', 'tap (index.bundle:1:100)');

    expect(() => installed(error, true)).not.toThrow();
    expect(recordTrap).toHaveBeenCalledTimes(1);
    expect(previousHandler).toHaveBeenCalledTimes(1);
    expect(previousHandler.mock.calls[0]?.[0]).toBe(error);
    expect(previousHandler.mock.calls[0]?.[1]).toBe(true);
  });

  it('non-fatal path + undefined isFatal are forwarded verbatim (no coercion to boolean)', () => {
    loadEntryWithThrowingTelemetry();
    const installed = errorUtils.getGlobalHandler();
    const soft = errorWithStack('soft', 'tap (index.bundle:1:100)');
    installed(soft, false);
    installed(soft, undefined);
    expect(previousHandler.mock.calls).toEqual([
      [soft, false],
      [soft, undefined],
    ]);
    expect(recordTrap).toHaveBeenCalledTimes(2);
  });

  it('Hermes unhandled rejection path still reaches the previous handler when telemetry throws', () => {
    loadEntryWithThrowingTelemetry();
    const options = hermesStub.enablePromiseRejectionTracker.mock.calls[0]?.[0];
    const rejection = errorWithStack(
      'fetch failed',
      'sync (index.bundle:1:300)',
    );
    expect(() => options?.onUnhandled(3, rejection)).not.toThrow();
    expect(previousHandler).toHaveBeenCalledTimes(1);
    expect(previousHandler).toHaveBeenCalledWith(rejection, false);
  });

  it('telemetry that throws a non-Error (string / null) is swallowed the same way', () => {
    recordTrap
      .mockImplementationOnce(() => {
        throw 'string trap';
      })
      .mockImplementationOnce(() => {
        throw null;
      });
    loadEntryWithThrowingTelemetry();
    const installed = errorUtils.getGlobalHandler();
    const e1 = errorWithStack('one', 'tap (index.bundle:1:100)');
    const e2 = errorWithStack('two', 'tap (index.bundle:1:100)');
    expect(() => installed(e1, true)).not.toThrow();
    expect(() => installed(e2, true)).not.toThrow();
    expect(previousHandler.mock.calls).toEqual([
      [e1, true],
      [e2, true],
    ]);
  });

  it('the previous handler itself throwing propagates (telemetry never masks RN\u2019s own failure)', () => {
    loadEntryWithThrowingTelemetry();
    const installed = errorUtils.getGlobalHandler();
    previousHandler.mockImplementationOnce(() => {
      throw new Error('rn handler failure');
    });
    expect(() =>
      installed(errorWithStack('x', 'tap (index.bundle:1:100)'), true),
    ).toThrow('rn handler failure');
  });
});
