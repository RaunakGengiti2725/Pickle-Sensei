import type { StabilityRecorder } from '../../src/analysis/stabilityTelemetry';

/**
 * App entry (index.js) must install a global JS error handler that records a
 * stability 'crash' event and still hands the error to React Native's own
 * handler, and — in Release, where React Native tracks nothing — a promise
 * rejection tracker that reports unhandled rejections as non-fatal errors.
 */

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

describe('global JS error handler', () => {
  it('records a fatal crash fingerprint and still forwards to the previous handler', () => {
    loadEntry(false);
    const installed = errorUtils.getGlobalHandler();
    expect(installed).not.toBe(previousHandler);

    const error = errorWithStack('boom', 'tap (index.bundle:1:100)');
    installed(error, true);

    expect(previousHandler).toHaveBeenCalledTimes(1);
    expect(previousHandler).toHaveBeenCalledWith(error, true);
    const events = crashEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'crash', fatal: true });
    expect(events[0]?.fingerprint).toMatch(/^[0-9a-f]{8}$/);
  });

  it('fingerprints by top frame — same frame, different message → same fingerprint', () => {
    loadEntry(false);
    const installed = errorUtils.getGlobalHandler();
    installed(errorWithStack('boom 1', 'tap (index.bundle:1:100)'), true);
    installed(errorWithStack('boom 2', 'tap (index.bundle:1:100)'), true);
    installed(errorWithStack('boom 1', 'other (index.bundle:1:200)'), true);
    const [a, b, c] = crashEvents();
    expect(a?.fingerprint).toBe(b?.fingerprint);
    expect(a?.fingerprint).not.toBe(c?.fingerprint);
  });

  it('never contains a stack body in the fingerprint', () => {
    loadEntry(false);
    const installed = errorUtils.getGlobalHandler();
    installed(errorWithStack('boom', 'tap (index.bundle:1:100)'), true);
    const [event] = crashEvents();
    expect(event?.fingerprint).not.toContain('index.bundle');
    expect(event?.fingerprint).not.toContain('boom');
  });

  it('records non-fatal errors as fatal: false', () => {
    loadEntry(false);
    errorUtils.reportError(new Error('soft'));
    expect(previousHandler).toHaveBeenCalledWith(expect.any(Error), false);
    expect(crashEvents()[0]).toMatchObject({ kind: 'crash', fatal: false });
  });

  it('forwards hostile throwables (non-Error values, throwing getters) to the previous handler', () => {
    loadEntry(false);
    const installed = errorUtils.getGlobalHandler();
    const hostile = {};
    Object.defineProperty(hostile, 'stack', {
      get() {
        throw new Error('no stack for you');
      },
    });
    installed(hostile, true);
    installed('plain string', true);
    installed(null, true);
    expect(previousHandler).toHaveBeenCalledTimes(3);
    expect(previousHandler.mock.calls[0]?.[0]).toBe(hostile);
    expect(previousHandler.mock.calls[1]?.[0]).toBe('plain string');
    expect(previousHandler.mock.calls[2]?.[0]).toBeNull();
    expect(crashEvents()).toHaveLength(2);
  });
});

describe('promise rejection tracking', () => {
  it('is installed in Release via HermesInternal for all rejections', () => {
    loadEntry(false);
    expect(hermesStub.enablePromiseRejectionTracker).toHaveBeenCalledTimes(1);
    const options = hermesStub.enablePromiseRejectionTracker.mock.calls[0]?.[0];
    expect(options?.allRejections).toBe(true);
  });

  it('leaves React Native’s own development tracker alone in __DEV__', () => {
    loadEntry(true);
    expect(hermesStub.enablePromiseRejectionTracker).not.toHaveBeenCalled();
  });

  it('reports an unhandled Error rejection as a non-fatal error through the global handler', () => {
    loadEntry(false);
    const options = hermesStub.enablePromiseRejectionTracker.mock.calls[0]?.[0];
    const rejection = errorWithStack(
      'fetch failed',
      'sync (index.bundle:1:300)',
    );
    options?.onUnhandled(7, rejection);

    expect(previousHandler).toHaveBeenCalledTimes(1);
    expect(previousHandler).toHaveBeenCalledWith(rejection, false);
    expect(crashEvents()[0]).toMatchObject({ kind: 'crash', fatal: false });
  });

  it('wraps non-Error rejections in an Error that carries the rejected value', () => {
    loadEntry(false);
    const options = hermesStub.enablePromiseRejectionTracker.mock.calls[0]?.[0];
    options?.onUnhandled(8, 'nope');
    options?.onUnhandled(9, { code: 429 });

    expect(previousHandler).toHaveBeenCalledTimes(2);
    const first = previousHandler.mock.calls[0]?.[0];
    const second = previousHandler.mock.calls[1]?.[0];
    expect(first).toBeInstanceOf(Error);
    expect((first as Error).message).toContain('nope');
    expect((second as Error).message).toContain('429');
    expect(previousHandler.mock.calls[0]?.[1]).toBe(false);
    expect(crashEvents()).toHaveLength(2);
  });

  it('does not throw when a late-handled rejection is reported', () => {
    loadEntry(false);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const options = hermesStub.enablePromiseRejectionTracker.mock.calls[0]?.[0];
    expect(() => options?.onHandled(7)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
