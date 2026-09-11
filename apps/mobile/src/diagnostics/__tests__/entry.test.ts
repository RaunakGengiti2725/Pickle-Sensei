type Handler = (error: unknown, fatal?: boolean) => void;
type RejectionTracker = {
  allRejections: boolean;
  onUnhandled(id: number, error: unknown): void;
  onHandled(id: number): void;
};
type DiagnosticsMock = typeof import('../__mocks__/sentry');

const mockOrder: string[] = [];
const mockRegisterComponent = jest.fn();
jest.mock('react-native', () => ({
  AppRegistry: { registerComponent: mockRegisterComponent },
}));
jest.mock('../../../App', () => {
  mockOrder.push('app');
  return { __esModule: true, default: () => null };
});
jest.mock('../../notifications/service', () => ({
  registerBackgroundNotificationHandler: jest.fn(),
}));
jest.mock('../sentry');

const runtime = globalThis as unknown as {
  __DEV__: boolean;
  ErrorUtils: {
    getGlobalHandler(): Handler;
    setGlobalHandler(handler: Handler): void;
  };
  HermesInternal?: {
    enablePromiseRejectionTracker: jest.Mock<void, [RejectionTracker]>;
  };
};
const originalHandler = runtime.ErrorUtils.getGlobalHandler();
const originalDev = runtime.__DEV__;
const originalHermes = runtime.HermesInternal;
const previousHandler = jest.fn<void, [unknown, boolean | undefined]>();
const tracker = jest.fn<void, [RejectionTracker]>();

function loadEntry(
  configure?: (diagnostics: DiagnosticsMock) => void,
): DiagnosticsMock {
  let diagnostics!: DiagnosticsMock;
  jest.isolateModules(() => {
    diagnostics = jest.requireMock<DiagnosticsMock>('../sentry');
    diagnostics.initializeDiagnostics.mockImplementation(() => {
      mockOrder.push('init');
      return 'disabled';
    });
    configure?.(diagnostics);
    jest.requireActual('../../../index.js');
  });
  return diagnostics;
}

beforeEach(() => {
  mockOrder.length = 0;
  previousHandler.mockReset();
  tracker.mockReset();
  runtime.__DEV__ = false;
  runtime.HermesInternal = { enablePromiseRejectionTracker: tracker };
  runtime.ErrorUtils.setGlobalHandler(previousHandler);
});

afterEach(() => {
  runtime.__DEV__ = originalDev;
  runtime.HermesInternal = originalHermes;
  runtime.ErrorUtils.setGlobalHandler(originalHandler);
  jest.clearAllMocks();
});

describe('early, non-interfering diagnostics entry hook', () => {
  it('initializes before evaluating App and reports each error through the original RN handler once', () => {
    const diagnostics = loadEntry();
    expect(mockOrder).toEqual(['init', 'app']);
    const error = new Error('SENSITIVE_FIXTURE_DO_NOT_TRANSMIT');
    runtime.ErrorUtils.getGlobalHandler()(error, true);
    expect(diagnostics.captureGlobalError).toHaveBeenCalledTimes(1);
    expect(diagnostics.captureGlobalError).toHaveBeenCalledWith(error, true);
    expect(previousHandler).toHaveBeenCalledTimes(1);
    expect(previousHandler).toHaveBeenCalledWith(error, true);
  });

  it('leaves startup usable if diagnostics initialization throws', () => {
    expect(() =>
      loadEntry(diagnostics => {
        diagnostics.initializeDiagnostics.mockImplementation(() => {
          throw new Error('SENSITIVE_FIXTURE_DO_NOT_TRANSMIT');
        });
      }),
    ).not.toThrow();
    expect(mockRegisterComponent).toHaveBeenCalled();
  });

  it('forwards the identical throwable and fatal flag even when diagnostics fails', () => {
    const diagnostics = loadEntry(port => {
      port.captureGlobalError.mockImplementation(() => {
        throw new Error('SENSITIVE_FIXTURE_DO_NOT_TRANSMIT');
      });
    });
    const hostile = Object.defineProperty({}, 'stack', {
      get() {
        throw new Error('SENSITIVE_FIXTURE_DO_NOT_TRANSMIT');
      },
    });
    for (const error of [hostile, null, 'SENSITIVE_FIXTURE_DO_NOT_TRANSMIT']) {
      expect(() =>
        runtime.ErrorUtils.getGlobalHandler()(error, false),
      ).not.toThrow();
      expect(previousHandler).toHaveBeenLastCalledWith(error, false);
    }
    expect(diagnostics.captureGlobalError).toHaveBeenCalledTimes(3);
    expect(previousHandler).toHaveBeenCalledTimes(3);
  });

  it('does not swallow an exception from React Native’s original handler', () => {
    loadEntry();
    const originalFailure = new Error('original handler');
    previousHandler.mockImplementationOnce(() => {
      throw originalFailure;
    });
    expect(() =>
      runtime.ErrorUtils.getGlobalHandler()(new Error(), true),
    ).toThrow(originalFailure);
  });

  it('does not stack another reporting handler when the entry is evaluated again', () => {
    const first = loadEntry();
    const installed = runtime.ErrorUtils.getGlobalHandler();
    loadEntry();
    expect(runtime.ErrorUtils.getGlobalHandler()).toBe(installed);
    installed(new Error(), true);
    expect(first.captureGlobalError).toHaveBeenCalledTimes(1);
    expect(previousHandler).toHaveBeenCalledTimes(1);
  });

  it('uses the existing Hermes rejection path without a second SDK rejection tracker', () => {
    const diagnostics = loadEntry();
    expect(tracker).toHaveBeenCalledTimes(1);
    const error = new Error('SENSITIVE_FIXTURE_DO_NOT_TRANSMIT');
    tracker.mock.calls[0]?.[0].onUnhandled(1, error);
    expect(diagnostics.captureGlobalError).toHaveBeenCalledTimes(1);
    expect(diagnostics.captureGlobalError).toHaveBeenCalledWith(error, false);
    expect(previousHandler).toHaveBeenCalledTimes(1);
    expect(previousHandler).toHaveBeenCalledWith(error, false);
  });

  it('keeps the development promise rejection tracker unchanged', () => {
    runtime.__DEV__ = true;
    loadEntry();
    expect(tracker).not.toHaveBeenCalled();
  });
});
