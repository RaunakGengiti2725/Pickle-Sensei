import type { StabilityRecorder } from '../../src/analysis/stabilityTelemetry';

/**
 * Attack pass mobile-ios-config-4 / scenario S4: the app entry (index.js) in
 * a Release bundle (`__DEV__ === false`) where `global.HermesInternal` is
 * undefined (JSC build, or a Hermes build without the rejection tracker API).
 * `installPromiseRejectionTracking` must no-op without throwing and the rest
 * of the entry (global error handler, AppRegistry registration under the
 * app.json name) must still run. Also drives the tracker's callbacks with
 * hostile rejection payloads (circular, symbol, huge, unicode) when Hermes IS
 * present so the `toError` fallback never throws inside the tracker.
 */

const mockRegisterComponent = jest.fn();
jest.mock('react-native', () => ({
  AppRegistry: {
    registerComponent: (...args: unknown[]) => mockRegisterComponent(...args),
  },
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
  enablePromiseRejectionTracker?: jest.Mock<void, [RejectionTrackerOptions]>;
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
const originalHermes = mutableGlobal.HermesInternal;
const previousHandler = jest.fn<void, [unknown, boolean | undefined]>();

let stabilitySlo: StabilityRecorder;

function loadEntry(dev: boolean, hermes: HermesInternalStub | undefined) {
  mutableGlobal.__DEV__ = dev;
  if (hermes === undefined) {
    delete mutableGlobal.HermesInternal;
  } else {
    mutableGlobal.HermesInternal = hermes;
  }
  errorUtils.setGlobalHandler(previousHandler);
  jest.isolateModules(() => {
    jest.requireActual('../../index.js');
    stabilitySlo = jest.requireActual<
      typeof import('../../src/analysis/stabilityTelemetry')
    >('../../src/analysis/stabilityTelemetry').stabilitySlo;
  });
}

const appJsonName = (jest.requireActual('../../app.json') as { name: string })
  .name;

afterEach(() => {
  previousHandler.mockReset();
  mockRegisterComponent.mockReset();
  errorUtils.setGlobalHandler(originalHandler);
  mutableGlobal.__DEV__ = originalDev;
  if (originalHermes === undefined) {
    delete mutableGlobal.HermesInternal;
  } else {
    mutableGlobal.HermesInternal = originalHermes;
  }
});

describe('S4 — Release entry without HermesInternal', () => {
  it('loads without throwing when HermesInternal is undefined and __DEV__ is false', () => {
    expect(mutableGlobal.HermesInternal).toBeUndefined();
    expect(() => loadEntry(false, undefined)).not.toThrow();
    // The rest of the entry still ran: registration under the app.json name
    // and the crash-fingerprinting global handler.
    expect(mockRegisterComponent).toHaveBeenCalledTimes(1);
    expect(mockRegisterComponent.mock.calls[0]?.[0]).toBe(appJsonName);
    const installed = errorUtils.getGlobalHandler();
    expect(installed).not.toBe(previousHandler);
    const error = new Error('boom');
    installed(error, true);
    expect(previousHandler).toHaveBeenCalledWith(error, true);
    expect(
      stabilitySlo.events().filter(event => event.kind === 'crash'),
    ).toHaveLength(1);
  });

  it('loads without throwing when HermesInternal exists but lacks enablePromiseRejectionTracker', () => {
    expect(() => loadEntry(false, {})).not.toThrow();
    expect(mockRegisterComponent).toHaveBeenCalledTimes(1);
  });

  it('loads without throwing when enablePromiseRejectionTracker is not a function', () => {
    expect(() =>
      loadEntry(false, {
        enablePromiseRejectionTracker: 'nope' as unknown as jest.Mock<
          void,
          [RejectionTrackerOptions]
        >,
      }),
    ).not.toThrow();
    expect(mockRegisterComponent).toHaveBeenCalledTimes(1);
  });

  it('never touches Hermes in __DEV__ even when it is present', () => {
    const stub: HermesInternalStub = {
      enablePromiseRejectionTracker: jest.fn(),
    };
    loadEntry(true, stub);
    expect(stub.enablePromiseRejectionTracker).not.toHaveBeenCalled();
  });

  it('survives repeated isolated loads (rapid re-entry) without double registration per load', () => {
    for (let i = 0; i < 25; i += 1) {
      expect(() =>
        loadEntry(false, i % 2 === 0 ? undefined : {}),
      ).not.toThrow();
    }
    expect(mockRegisterComponent).toHaveBeenCalledTimes(25);
  });
});

describe('S4b — tracker callbacks under hostile rejection payloads (Hermes present)', () => {
  function installedTracker(): RejectionTrackerOptions {
    const stub: HermesInternalStub = {
      enablePromiseRejectionTracker: jest.fn(),
    };
    loadEntry(false, stub);
    expect(stub.enablePromiseRejectionTracker).toHaveBeenCalledTimes(1);
    const options = stub.enablePromiseRejectionTracker!.mock.calls[0]?.[0];
    expect(options?.allRejections).toBe(true);
    return options!;
  }

  it('reports every payload shape as an Error through ErrorUtils.reportError without throwing', () => {
    const tracker = installedTracker();
    const reportError = jest.fn();
    const original = errorUtils.reportError;
    errorUtils.reportError = reportError;
    try {
      const circular: Record<string, unknown> = { a: 1 };
      circular['self'] = circular;
      const payloads: unknown[] = [
        undefined,
        null,
        0,
        '',
        'plain string',
        'ünïcödé 🥒 \u202e\u0000',
        'x'.repeat(2_000_000),
        Symbol('sym'),
        12345678901234567890n,
        circular,
        {
          toJSON: () => {
            throw new Error('toJSON explodes');
          },
        },
        new Error('real error'),
        Object.create(null),
        () => 'fn',
      ];
      payloads.forEach((payload, index) => {
        expect(() => tracker.onUnhandled(index, payload)).not.toThrow();
      });
      expect(reportError).toHaveBeenCalledTimes(payloads.length);
      for (const call of reportError.mock.calls) {
        expect(call[0]).toBeInstanceOf(Error);
      }
      // A real Error is forwarded as-is, never re-wrapped.
      expect(reportError.mock.calls[11]?.[0]).toBe(payloads[11]);
    } finally {
      errorUtils.reportError = original;
    }
  });

  it('falls back to console.error when ErrorUtils.reportError is unavailable, and onHandled only warns', () => {
    const tracker = installedTracker();
    const original = errorUtils.reportError;
    // Simulate a runtime whose ErrorUtils lacks reportError.
    (errorUtils as { reportError?: unknown }).reportError = undefined;
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const consoleWarn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => {});
    try {
      expect(() => tracker.onUnhandled(7, 'late')).not.toThrow();
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(() => tracker.onHandled(7)).not.toThrow();
      expect(consoleWarn).toHaveBeenCalledTimes(1);
      expect(String(consoleWarn.mock.calls[0]?.[0])).toContain('id: 7');
    } finally {
      errorUtils.reportError = original;
      consoleError.mockRestore();
      consoleWarn.mockRestore();
    }
  });
});
