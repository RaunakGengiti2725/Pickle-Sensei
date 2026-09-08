import type {
  ErrorEvent,
  ReactNativeOptions,
  StackFrame,
} from '@sentry/react-native';
import {
  getRuntimePublicConfig,
  type RuntimeDiagnosticsConfig,
} from '../config/runtimeConfig';
import {
  diagnosticErrorType,
  diagnosticsIdentity,
  diagnosticsRelease,
  type DiagnosticOrigin,
  type DiagnosticsIdentity,
  type DiagnosticTransport,
  type DiagnosticTransportFactory,
} from './privacy';
import {
  createDiagnosticRetention,
  type DiagnosticRetention,
} from './retention';
import { createScrubbedTransport, scrubDiagnosticEvent } from './scrub';

export const NATIVE_DIAGNOSTICS_STATUS = 'blocked_unverified_native_filtering';

type BlockedState =
  | 'disabled'
  | 'blocked_provider'
  | 'blocked_disclosures'
  | 'blocked_dsn'
  | 'blocked_identity'
  | typeof NATIVE_DIAGNOSTICS_STATUS
  | 'unavailable';

type DiagnosticsGate =
  | { state: BlockedState }
  | { state: 'ready_js_only'; identity: DiagnosticsIdentity; dsn: string };

export type DiagnosticsState =
  BlockedState | 'uninitialized' | 'initializing' | 'active_js_only';

export interface DiagnosticsReporterPort {
  parseStack(stack: string): StackFrame[];
  captureEvent(event: ErrorEvent): unknown;
  clearScopes(): unknown;
}

export function diagnosticsGate(
  config: RuntimeDiagnosticsConfig | undefined,
): DiagnosticsGate {
  try {
    if (config?.transportEnabled !== true) return { state: 'disabled' };
    if (config.providerApproved !== true) return { state: 'blocked_provider' };
    if (config.disclosuresApproved !== true)
      return { state: 'blocked_disclosures' };
    const dsn = config.dsn;
    if (
      typeof dsn !== 'string' ||
      !/^https:\/\/[a-f0-9]{32}@o[0-9]+\.ingest(?:\.(?:us|de))?\.sentry\.io\/[1-9][0-9]*$/.test(
        dsn,
      )
    ) {
      return { state: 'blocked_dsn' };
    }
    if (config.nativePrivacyApproved !== true)
      return { state: NATIVE_DIAGNOSTICS_STATUS };
    const identity = diagnosticsIdentity(config);
    if (!identity) return { state: 'blocked_identity' };
    return { state: 'ready_js_only', identity, dsn };
  } catch {
    return { state: 'unavailable' };
  }
}

export function optionsForDiagnostics(
  identity: DiagnosticsIdentity,
  dsn: string | null,
  makeTransport: DiagnosticTransportFactory,
  debugMeta: ReturnType<
    (typeof import('@sentry/react-native'))['debugMetaIntegration']
  >,
  retain?: (sink: DiagnosticTransport) => DiagnosticTransport,
): ReactNativeOptions {
  const releaseIdentity = diagnosticsIdentity(identity);
  const fetchOptions = {
    credentials: 'omit' as const,
    referrerPolicy: 'no-referrer' as const,
    keepalive: false,
  };
  const disabledTransport = {
    send: async () => ({}),
    flush: async () => false,
  };
  return {
    enabled: dsn !== null && releaseIdentity !== null,
    ...(dsn === null ? {} : { dsn }),
    release: releaseIdentity ? diagnosticsRelease(releaseIdentity) : undefined,
    dist: releaseIdentity?.nativeBuildNumber,
    environment: releaseIdentity?.environment,
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
    enableAnrFingerprinting: false,
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
    tracesSampler: () => 0,
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
    shutdownTimeout: 0,
    debug: false,
    _experiments: {},
    initialScope: {},
    tunnel: undefined,
    beforeSend: event =>
      releaseIdentity ? scrubDiagnosticEvent(event, releaseIdentity) : null,
    beforeBreadcrumb: () => null,
    beforeSendTransaction: () => null,
    beforeSendLog: () => null,
    beforeSendMetric: () => null,
    beforeScreenshot: () => false,
    transportOptions: {
      bufferSize: 8,
      headers: {},
      fetchOptions,
    },
    transport: options => {
      try {
        if (!releaseIdentity) return disabledTransport;
        const sink = makeTransport(options);
        return createScrubbedTransport(
          retain ? retain(sink) : sink,
          releaseIdentity,
        );
      } catch {
        return disabledTransport;
      }
    },
  };
}

function errorProperty(error: unknown, key: 'name' | 'stack'): unknown {
  try {
    return error !== null &&
      (typeof error === 'object' || typeof error === 'function')
      ? (error as Record<string, unknown>)[key]
      : undefined;
  } catch {
    return undefined;
  }
}

export function createErrorReporter(
  port: DiagnosticsReporterPort,
  identity: DiagnosticsIdentity,
) {
  const releaseIdentity = diagnosticsIdentity(identity);
  const seen = new WeakSet<object>();
  let reporting = false;
  let attempts = 0;

  return {
    capture(error: unknown, origin: DiagnosticOrigin, fatal = false): boolean {
      if (!releaseIdentity || reporting || attempts >= 20) return false;
      reporting = true;
      try {
        if (
          error !== null &&
          (typeof error === 'object' || typeof error === 'function')
        ) {
          if (seen.has(error)) return false;
          seen.add(error);
        }
        attempts += 1;
        let stackFrames: StackFrame[] = [];
        const stack = errorProperty(error, 'stack');
        if (typeof stack === 'string' && stack.length <= 32_768) {
          try {
            stackFrames = port.parseStack(stack);
          } catch {
            stackFrames = [];
          }
        }
        const event = scrubDiagnosticEvent(
          {
            type: undefined,
            platform: 'javascript',
            level: fatal === true ? 'fatal' : 'error',
            tags: { diagnostic_origin: origin },
            exception: {
              values: [
                {
                  type: diagnosticErrorType(errorProperty(error, 'name')),
                  stacktrace: { frames: stackFrames },
                },
              ],
            },
          },
          releaseIdentity,
        );
        if (!event) return false;
        void Promise.resolve(port.captureEvent(event)).catch(() => {});
        return true;
      } catch {
        return false;
      } finally {
        reporting = false;
      }
    },
    resetScope(): boolean {
      try {
        void Promise.resolve(port.clearScopes()).catch(() => {});
        return true;
      } catch {
        return false;
      }
    },
  };
}

let state: DiagnosticsState = 'uninitialized';
let reporter: ReturnType<typeof createErrorReporter> | null = null;
let retention: DiagnosticRetention | null = null;

async function initializeSdk(
  gate: Extract<DiagnosticsGate, { state: 'ready_js_only' }>,
): Promise<void> {
  try {
    const sdk = await import('@sentry/react-native');
    const browser = await import('@sentry/browser');
    const nextRetention = createDiagnosticRetention(gate.identity);
    sdk.init(
      optionsForDiagnostics(
        gate.identity,
        gate.dsn,
        browser.makeFetchTransport,
        sdk.debugMetaIntegration(),
        nextRetention.retain,
      ),
    );
    const client = sdk.getClient();
    if (!client) {
      state = 'unavailable';
      return;
    }
    const nextReporter = createErrorReporter(
      {
        parseStack: stack => client.getOptions().stackParser(stack),
        captureEvent: event => sdk.captureEvent(event),
        clearScopes: () => {
          sdk.getGlobalScope().clear();
          sdk.getIsolationScope().clear();
          sdk.getCurrentScope().clear();
        },
      },
      gate.identity,
    );
    if (!nextReporter.resetScope()) {
      state = 'unavailable';
      return;
    }
    reporter = nextReporter;
    retention = nextRetention;
    state = 'active_js_only';
  } catch {
    reporter = null;
    retention = null;
    state = 'unavailable';
  }
}

export function initializeDiagnostics(): DiagnosticsState {
  if (state !== 'uninitialized') return state;
  state = 'initializing';
  try {
    const gate = diagnosticsGate(getRuntimePublicConfig().diagnostics);
    if (gate.state !== 'ready_js_only') {
      state = gate.state;
      return state;
    }
    void initializeSdk(gate);
  } catch {
    state = 'unavailable';
  }
  return state;
}

export function getDiagnosticsStatus() {
  return {
    javascript: state,
    native: NATIVE_DIAGNOSTICS_STATUS,
    transportEnabled: state === 'active_js_only',
    persistentQueue: state === 'active_js_only' && retention !== null,
  } as const;
}

export function captureGlobalError(error: unknown, fatal = false): boolean {
  return reporter?.capture(error, 'global_js', fatal) ?? false;
}

export function captureBoundaryError(error: unknown): boolean {
  return reporter?.capture(error, 'react_boundary') ?? false;
}

export function captureHandledError(error: unknown): boolean {
  return reporter?.capture(error, 'handled_js') ?? false;
}

export function resetDiagnosticsScope(): boolean {
  return reporter?.resetScope() ?? false;
}
