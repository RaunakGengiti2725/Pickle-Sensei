import type { ErrorEvent, ReactNativeOptions } from '@sentry/react-native';
import { getRuntimePublicConfig } from '../../config/runtimeConfig';
import {
  captureBoundaryError,
  captureGlobalError,
  createErrorReporter,
  diagnosticsGate,
  getDiagnosticsStatus,
  initializeDiagnostics,
  NATIVE_DIAGNOSTICS_STATUS,
  optionsForDiagnostics,
  resetDiagnosticsScope,
  type DiagnosticsReporterPort,
} from '../sentry';
import type {
  DiagnosticEnvelope,
  DiagnosticsIdentity,
  DiagnosticTransportFactory,
} from '../privacy';

const mockLoadSdk = jest.fn();
jest.mock('@sentry/react-native', () => {
  mockLoadSdk();
  throw new Error('The diagnostics provider must remain unloaded');
});

const identity: DiagnosticsIdentity = {
  bundleIdentifier: 'com.picklesensei',
  marketingVersion: '1.0',
  nativeBuildNumber: '1',
  sourceRevision: 'a'.repeat(40),
  environment: 'test',
  modelVersion: 'scoring-v1',
  policyVersion: 'policy-v1',
};
const marker = 'SENSITIVE_FIXTURE_DO_NOT_TRANSMIT';

function reporterPort(): DiagnosticsReporterPort & {
  events: ErrorEvent[];
  clearScopes: jest.Mock;
} {
  const events: ErrorEvent[] = [];
  return {
    events,
    parseStack: () => [
      {
        filename: `file:///private/${marker}/main.jsbundle`,
        function: marker,
        lineno: 1,
        colno: 400,
      },
    ],
    captureEvent: event => events.push(event),
    clearScopes: jest.fn(),
  };
}

describe('diagnostics startup gates', () => {
  it('ships no DSN or approved transport, and loads no provider on startup', () => {
    const config = getRuntimePublicConfig().diagnostics;
    expect(config).toMatchObject({
      transportEnabled: false,
      providerApproved: false,
      disclosuresApproved: false,
      nativePrivacyApproved: false,
      dsn: null,
      nativeBuildNumber: null,
      sourceRevision: null,
      environment: null,
      modelVersion: null,
      policyVersion: null,
    });
    expect(diagnosticsGate(config)).toEqual({ state: 'disabled' });
    expect(initializeDiagnostics()).toBe('disabled');
    expect(captureGlobalError(new Error(marker), true)).toBe(false);
    expect(captureBoundaryError(new Error(marker))).toBe(false);
    expect(resetDiagnosticsScope()).toBe(false);
    expect(NATIVE_DIAGNOSTICS_STATUS).toBe(
      'blocked_unverified_native_filtering',
    );
    expect(getDiagnosticsStatus()).toEqual({
      javascript: 'disabled',
      native: NATIVE_DIAGNOSTICS_STATUS,
      transportEnabled: false,
      persistentQueue: false,
    });
    expect(initializeDiagnostics()).toBe('disabled');
    expect(mockLoadSdk).not.toHaveBeenCalled();
  });

  it('does not let transport intent stand in for provider/disclosure approvals', () => {
    const config = {
      ...getRuntimePublicConfig().diagnostics,
      transportEnabled: true,
    };
    expect(diagnosticsGate(config)).toEqual({ state: 'blocked_provider' });
    expect(diagnosticsGate({ ...config, providerApproved: true })).toEqual({
      state: 'blocked_disclosures',
    });
    expect(
      diagnosticsGate({
        ...config,
        providerApproved: true,
        disclosuresApproved: true,
      }),
    ).toEqual({ state: 'blocked_dsn' });
  });

  it('fails closed for absent and hostile configuration', () => {
    expect(diagnosticsGate(undefined)).toEqual({ state: 'disabled' });
    const config = Object.defineProperty({}, 'transportEnabled', {
      get() {
        throw new Error(marker);
      },
    });
    expect(diagnosticsGate(config as never)).toEqual({ state: 'unavailable' });
    for (const transportEnabled of [1, 'true', {}, null]) {
      expect(
        diagnosticsGate({
          ...getRuntimePublicConfig().diagnostics,
          transportEnabled,
        } as never),
      ).toEqual({ state: 'disabled' });
    }
    expect(
      diagnosticsGate({
        ...getRuntimePublicConfig().diagnostics,
        transportEnabled: true,
        providerApproved: true,
        disclosuresApproved: true,
        dsn: marker,
      }),
    ).toEqual({ state: 'blocked_dsn' });
    expect(mockLoadSdk).not.toHaveBeenCalled();
  });

  it('isolates configuration failures and does not repeatedly retry startup', () => {
    const config = jest.fn(() => {
      throw new Error(marker);
    });
    jest.doMock('../../config/runtimeConfig', () => ({
      getRuntimePublicConfig: config,
    }));
    try {
      jest.isolateModules(() => {
        const diagnostics =
          jest.requireActual<typeof import('../sentry')>('../sentry');
        expect(diagnostics.initializeDiagnostics()).toBe('unavailable');
        expect(diagnostics.initializeDiagnostics()).toBe('unavailable');
        expect(diagnostics.captureHandledError(new Error(marker))).toBe(false);
        expect(diagnostics.getDiagnosticsStatus().transportEnabled).toBe(false);
      });
      expect(config).toHaveBeenCalledTimes(1);
      expect(mockLoadSdk).not.toHaveBeenCalled();
    } finally {
      jest.dontMock('../../config/runtimeConfig');
    }
  });
});

describe('pinned SDK privacy options', () => {
  it('disables every non-error collector and retains only the reviewed DebugMeta integration', async () => {
    const send = jest.fn(async () => ({}));
    const makeTransport: DiagnosticTransportFactory = jest.fn(() => ({
      send,
      flush: async () => true,
    }));
    const debugMeta = { name: 'DebugMeta' };
    const options: ReactNativeOptions = optionsForDiagnostics(
      identity,
      null,
      makeTransport,
      debugMeta,
    );
    expect(options).toMatchObject({
      enabled: false,
      sendDefaultPii: false,
      defaultIntegrations: false,
      integrations: [debugMeta],
      enableNative: false,
      autoInitializeNativeSdk: false,
      enableNativeCrashHandling: false,
      enableNativeNagger: false,
      enableAutoSessionTracking: false,
      enableAutoPerformanceTracing: false,
      enableWatchdogTerminationTracking: false,
      enableAppHangTracking: false,
      enableNdk: false,
      enableNdkScopeSync: false,
      enableTombstone: false,
      enableHistoricalTombstoneReporting: false,
      enableNdkAppHangTracking: false,
      enableMetricKit: false,
      enableTurboModuleTracking: false,
      attachScreenshot: false,
      attachViewHierarchy: false,
      attachThreads: false,
      attachAllThreads: false,
      attachStacktrace: false,
      patchGlobalPromise: false,
      maxBreadcrumbs: 0,
      enableCaptureFailedRequests: false,
      enableAppStartTracking: false,
      enableNativeFramesTracking: false,
      enableStallTracking: false,
      enableUserInteractionTracing: false,
      tracesSampleRate: 0,
      profilesSampleRate: 0,
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
      enableLogs: false,
      enableAutoConsoleLogs: false,
      enableMetrics: false,
      sendClientReports: false,
      spotlight: false,
      tracePropagationTargets: [],
      propagateTraceparent: false,
      maxQueueSize: 8,
      maxCacheItems: 0,
      debug: false,
      _experiments: {},
    });
    expect(options.dsn).toBeUndefined();
    expect(
      options.beforeBreadcrumb?.({ category: 'console', message: marker }, {}),
    ).toBeNull();
    expect(
      options.beforeSendTransaction?.({ type: 'transaction' }, {}),
    ).toBeNull();
    expect(options.beforeSendLog?.({ body: marker } as never)).toBeNull();
    expect(options.beforeSendMetric?.({ name: marker } as never)).toBeNull();
    expect(options.beforeScreenshot?.({}, {})).toBe(false);
    const transport = options.transport!({
      url: '',
      recordDroppedEvent: () => {},
    });
    await transport.send([
      {},
      [
        [
          { type: 'attachment', filename: marker, length: marker.length },
          marker,
        ],
      ],
    ] as unknown as DiagnosticEnvelope);
    expect(send).not.toHaveBeenCalled();
    expect(options.transportOptions).toMatchObject({
      bufferSize: 8,
      headers: {},
      fetchOptions: {
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        keepalive: false,
      },
    });
  });

  it('drops an invalid identity and never constructs its transport', async () => {
    const makeTransport = jest.fn(() => {
      throw new Error(marker);
    });
    const options = optionsForDiagnostics(
      { ...identity, modelVersion: marker },
      null,
      makeTransport,
      { name: 'DebugMeta' },
    );
    expect(options.enabled).toBe(false);
    expect(options.beforeSend?.({ type: undefined }, {})).toBeNull();
    const transport = options.transport!({
      url: '',
      recordDroppedEvent: () => {},
    });
    await expect(
      transport.send([{}, []] as unknown as DiagnosticEnvelope),
    ).resolves.toEqual({});
    expect(makeTransport).not.toHaveBeenCalled();
  });

  it('does not propagate a transport-factory failure into startup', async () => {
    const options = optionsForDiagnostics(
      identity,
      null,
      () => {
        throw new Error(marker);
      },
      { name: 'DebugMeta' },
    );
    const transport = options.transport!({
      url: '',
      recordDroppedEvent: () => {},
    });
    await expect(
      transport.send([{}, []] as unknown as DiagnosticEnvelope),
    ).resolves.toEqual({});
    await expect(transport.flush(1)).resolves.toBe(false);
  });
});

describe('failure-isolated error reporter', () => {
  it('minimizes the error before passing it to any SDK API', () => {
    const port = reporterPort();
    const reporter = createErrorReporter(port, identity);
    const error = Object.assign(new TypeError(marker), {
      grant: marker,
      receipt: marker,
      captureUri: marker,
      cause: new Error(marker),
    });
    expect(reporter.capture(error, 'global_js', true)).toBe(true);
    expect(port.events).toHaveLength(1);
    expect(JSON.stringify(port.events)).not.toContain(marker);
    expect(port.events[0]).toMatchObject({
      level: 'fatal',
      tags: { diagnostic_origin: 'global_js' },
      exception: {
        values: [{ type: 'TypeError', value: 'Error details removed' }],
      },
    });
  });

  it('deduplicates the same Error across boundary, global and handled paths', () => {
    const port = reporterPort();
    const reporter = createErrorReporter(port, identity);
    const error = new Error(marker);
    expect(reporter.capture(error, 'react_boundary')).toBe(true);
    expect(reporter.capture(error, 'global_js', false)).toBe(false);
    expect(reporter.capture(error, 'handled_js')).toBe(false);
    expect(port.events).toHaveLength(1);
    expect(reporter.capture(new Error(marker), 'handled_js')).toBe(true);
    expect(port.events).toHaveLength(2);
  });

  it('never serializes rejection objects, messages, causes or component data', () => {
    const port = reporterPort();
    const reporter = createErrorReporter(port, identity);
    const rejected = {
      email: marker,
      grant: marker,
      toString: jest.fn(() => marker),
    };
    expect(reporter.capture(rejected, 'global_js')).toBe(true);
    expect(rejected.toString).not.toHaveBeenCalled();
    expect(JSON.stringify(port.events)).not.toContain(marker);
    const throwingMessage = Object.defineProperty(new Error(), 'message', {
      get() {
        throw new Error(marker);
      },
    });
    Object.defineProperty(throwingMessage, 'stack', {
      value: 'main.jsbundle:1:400',
    });
    expect(reporter.capture(throwingMessage, 'react_boundary')).toBe(true);
  });

  it('does not let parser errors or hostile error properties escape', () => {
    const port = reporterPort();
    port.parseStack = () => {
      throw new Error(marker);
    };
    const reporter = createErrorReporter(port, identity);
    expect(() =>
      reporter.capture(new Error(marker), 'global_js'),
    ).not.toThrow();
    expect(port.events).toHaveLength(1);
    const hostile = Object.defineProperty({}, 'stack', {
      get() {
        throw new Error(marker);
      },
    });
    expect(() => reporter.capture(hostile, 'global_js')).not.toThrow();
    expect(JSON.stringify(port.events)).not.toContain(marker);
  });

  it('handles synchronous and asynchronous SDK capture failures without recapturing them', async () => {
    for (const captureEvent of [
      jest.fn(() => {
        throw new Error(marker);
      }),
      jest.fn(() => Promise.reject(new Error(marker))),
    ]) {
      const port = { ...reporterPort(), captureEvent };
      const reporter = createErrorReporter(port, identity);
      const error = new Error(marker);
      expect(() => reporter.capture(error, 'global_js')).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();
      expect(reporter.capture(error, 'react_boundary')).toBe(false);
      expect(captureEvent).toHaveBeenCalledTimes(1);
    }
  });

  it('bounds reporting and prevents reentrant diagnostic failures', () => {
    const port = reporterPort();
    const reporter = createErrorReporter(port, identity);
    const capture = port.captureEvent;
    port.captureEvent = event => {
      expect(reporter.capture(new Error(marker), 'global_js')).toBe(false);
      return capture(event);
    };
    for (let index = 0; index < 100; index += 1)
      reporter.capture(new Error(marker), 'global_js');
    expect(port.events).toHaveLength(20);
  });

  it('clears all owner-related scope without accepting an owner ID or resetting deduplication', () => {
    const port = reporterPort();
    const reporter = createErrorReporter(port, identity);
    const error = new Error(marker);
    reporter.capture(error, 'react_boundary');
    expect(reporter.resetScope()).toBe(true);
    expect(port.clearScopes).toHaveBeenCalledTimes(1);
    expect(reporter.capture(error, 'global_js')).toBe(false);
    port.clearScopes.mockImplementationOnce(() => {
      throw new Error(marker);
    });
    expect(reporter.resetScope()).toBe(false);
  });
});
