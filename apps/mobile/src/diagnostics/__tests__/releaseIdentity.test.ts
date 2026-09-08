import type { ErrorEvent, ReactNativeOptions } from '@sentry/react-native';
import {
  getRuntimePublicConfig,
  type RuntimeDiagnosticsConfig,
} from '../../config/runtimeConfig';
import {
  applyGeneratedReleaseIdentity,
  generatedReleaseIdentity,
  parseGeneratedReleaseIdentity,
  type GeneratedReleaseIdentity,
} from '../../config/releaseIdentity';
import {
  createErrorReporter,
  diagnosticsGate,
  NATIVE_DIAGNOSTICS_STATUS,
  optionsForDiagnostics,
} from '../sentry';

const mockReadGeneratedReleaseIdentity = jest.fn<unknown, []>(() => null);
jest.mock('../../config/readGeneratedReleaseIdentity', () => ({
  readGeneratedReleaseIdentity: mockReadGeneratedReleaseIdentity,
}));

const mockInit = jest.fn<void, [ReactNativeOptions]>();
const mockCaptureEvent = jest.fn<string, [ErrorEvent]>(() => 'e'.repeat(32));
const mockClear = jest.fn();
jest.mock('@sentry/react-native', () => ({
  init: mockInit,
  debugMetaIntegration: () => ({ name: 'DebugMeta' }),
  getClient: () => ({
    getOptions: () => ({ stackParser: () => [] }),
  }),
  captureEvent: mockCaptureEvent,
  getGlobalScope: () => ({ clear: mockClear }),
  getIsolationScope: () => ({ clear: mockClear }),
  getCurrentScope: () => ({ clear: mockClear }),
}));
jest.mock('@sentry/browser', () => ({
  makeFetchTransport: () => ({
    send: async () => ({}),
    flush: async () => true,
  }),
}));

const marker = 'SENSITIVE_FIXTURE_DO_NOT_TRANSMIT';
const sha = '0123456789abcdef0123456789abcdef01234567';
const dsn = `https://${'a'.repeat(32)}@o1.ingest.sentry.io/1`;

// Exactly what `scripts/release-identity.mjs --check --require-committed
// --json` prints for a committed candidate; the bundle phase writes it as-is.
const generatedRecord = {
  marketingVersion: '1.0',
  buildNumber: 1,
  bundleIdentifier: 'com.picklesensei',
  moduleName: 'PickleSensei',
  displayName: 'Pickle Sensei',
  configurations: ['Debug', 'Release'],
  gitSha: sha,
  committed: true,
  uncommitted: [],
  identityFiles: ['infra/release/release-manifest.json'],
};
const generated: GeneratedReleaseIdentity = {
  bundleIdentifier: 'com.picklesensei',
  marketingVersion: '1.0',
  nativeBuildNumber: '1',
  sourceRevision: sha,
};

function approvedConfig(): RuntimeDiagnosticsConfig {
  return {
    ...getRuntimePublicConfig().diagnostics,
    transportEnabled: true,
    providerApproved: true,
    disclosuresApproved: true,
    nativePrivacyApproved: true,
    dsn,
    environment: 'test',
    modelVersion: 'scoring-v1',
    policyVersion: 'policy-v1',
  };
}

async function settled(): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

beforeEach(() => {
  mockReadGeneratedReleaseIdentity.mockReset();
  mockReadGeneratedReleaseIdentity.mockReturnValue(null);
  mockInit.mockClear();
  mockCaptureEvent.mockClear();
  mockClear.mockClear();
});

describe('generated release identity file', () => {
  it('accepts only the committed candidate record the release-identity script prints', () => {
    const parsed = parseGeneratedReleaseIdentity(generatedRecord);
    expect(parsed).toEqual(generated);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.keys(parsed ?? {}).sort()).toEqual(
      Object.keys(generated).sort(),
    );
    expect(
      parseGeneratedReleaseIdentity({
        ...generatedRecord,
        buildNumber: 12345678,
        marketingVersion: '1.2.3',
      }),
    ).toEqual({
      ...generated,
      nativeBuildNumber: '12345678',
      marketingVersion: '1.2.3',
    });
  });

  it('rejects uncommitted, malformed, foreign and hostile records', () => {
    const rejected: unknown[] = [
      null,
      undefined,
      [],
      'committed',
      42,
      { ...generatedRecord, committed: false },
      { ...generatedRecord, committed: 'true' },
      { ...generatedRecord, committed: undefined },
      { ...generatedRecord, gitSha: null },
      { ...generatedRecord, gitSha: sha.slice(0, 39) },
      { ...generatedRecord, gitSha: `${sha}0` },
      { ...generatedRecord, gitSha: sha.toUpperCase() },
      { ...generatedRecord, gitSha: marker },
      { ...generatedRecord, buildNumber: 0 },
      { ...generatedRecord, buildNumber: -1 },
      { ...generatedRecord, buildNumber: 1.5 },
      { ...generatedRecord, buildNumber: '1' },
      { ...generatedRecord, buildNumber: 123456789 },
      { ...generatedRecord, buildNumber: Number.MAX_SAFE_INTEGER + 2 },
      { ...generatedRecord, buildNumber: Number.NaN },
      { ...generatedRecord, bundleIdentifier: 'com.picklesensei.dev' },
      { ...generatedRecord, bundleIdentifier: undefined },
      { ...generatedRecord, marketingVersion: 'v1.0' },
      { ...generatedRecord, marketingVersion: '1.0.0.0' },
      { ...generatedRecord, marketingVersion: 1 },
      { ...generatedRecord, marketingVersion: undefined },
      Object.defineProperty({ ...generatedRecord }, 'gitSha', {
        get() {
          throw new Error(marker);
        },
      }),
    ];
    for (const input of rejected) {
      expect(parseGeneratedReleaseIdentity(input)).toBeNull();
    }
  });

  it('reads the file the build wrote and yields null when no build wrote one', () => {
    const file = '../../config/releaseIdentity.generated.json';
    const reader = '../../config/readGeneratedReleaseIdentity';
    type Reader = typeof import('../../config/readGeneratedReleaseIdentity');
    jest.doMock(file, () => generatedRecord, { virtual: true });
    try {
      jest.isolateModules(() => {
        expect(
          jest.requireActual<Reader>(reader).readGeneratedReleaseIdentity(),
        ).toEqual(generatedRecord);
      });
    } finally {
      jest.dontMock(file);
    }
    jest.doMock(
      file,
      () => {
        throw new Error(`Cannot find module '${file}'`);
      },
      { virtual: true },
    );
    try {
      jest.isolateModules(() => {
        expect(
          jest.requireActual<Reader>(reader).readGeneratedReleaseIdentity(),
        ).toBeNull();
      });
    } finally {
      jest.dontMock(file);
    }
  });

  it('reads the build-time file through the reader and fails closed without it', () => {
    expect(generatedReleaseIdentity()).toBeNull();
    expect(mockReadGeneratedReleaseIdentity).toHaveBeenCalledTimes(1);
    mockReadGeneratedReleaseIdentity.mockReturnValue(generatedRecord);
    expect(generatedReleaseIdentity()).toEqual(generated);
    mockReadGeneratedReleaseIdentity.mockReturnValue({
      ...generatedRecord,
      committed: false,
    });
    expect(generatedReleaseIdentity()).toBeNull();
    mockReadGeneratedReleaseIdentity.mockImplementation(() => {
      throw new Error(marker);
    });
    expect(generatedReleaseIdentity()).toBeNull();
  });
});

describe('release identity applied to the diagnostics configuration', () => {
  it('fills build number and source commit only from the generated identity', () => {
    const shipped = getRuntimePublicConfig().diagnostics;
    expect(shipped).toMatchObject({
      nativeBuildNumber: null,
      sourceRevision: null,
    });
    expect(applyGeneratedReleaseIdentity(shipped, generated)).toEqual({
      ...shipped,
      nativeBuildNumber: '1',
      sourceRevision: sha,
    });
    expect(applyGeneratedReleaseIdentity(shipped, null)).toBeNull();
    expect(
      applyGeneratedReleaseIdentity(
        { ...shipped, nativeBuildNumber: '1', sourceRevision: sha },
        null,
      ),
    ).toBeNull();
    expect(
      applyGeneratedReleaseIdentity(
        { ...shipped, nativeBuildNumber: '1', sourceRevision: sha },
        generated,
      ),
    ).toEqual({ ...shipped, nativeBuildNumber: '1', sourceRevision: sha });
  });

  it('refuses any drift between the runtime configuration and the candidate', () => {
    const shipped = getRuntimePublicConfig().diagnostics;
    const drifted: Array<[RuntimeDiagnosticsConfig, GeneratedReleaseIdentity]> =
      [
        [{ ...shipped, marketingVersion: '1.1' }, generated],
        [shipped, { ...generated, marketingVersion: '1.1' }],
        [{ ...shipped, nativeBuildNumber: '2' }, generated],
        [{ ...shipped, sourceRevision: 'b'.repeat(40) }, generated],
        [
          { ...shipped, bundleIdentifier: 'com.picklesensei.dev' as never },
          generated,
        ],
        [shipped, { ...generated, bundleIdentifier: marker as never }],
      ];
    for (const [config, candidate] of drifted) {
      expect(applyGeneratedReleaseIdentity(config, candidate)).toBeNull();
    }
    const hostile = Object.defineProperty({ ...shipped }, 'nativeBuildNumber', {
      get() {
        throw new Error(marker);
      },
    }) as RuntimeDiagnosticsConfig;
    expect(applyGeneratedReleaseIdentity(hostile, generated)).toBeNull();
  });
});

describe('diagnostics gate with the generated release identity', () => {
  it('keeps every approval gate ahead of the identity and stays disabled by default', () => {
    const shipped = getRuntimePublicConfig().diagnostics;
    expect(diagnosticsGate(shipped, generated)).toEqual({ state: 'disabled' });
    expect(diagnosticsGate(undefined, generated)).toEqual({
      state: 'disabled',
    });
    const config = approvedConfig();
    expect(
      diagnosticsGate({ ...config, providerApproved: false }, generated),
    ).toEqual({ state: 'blocked_provider' });
    expect(
      diagnosticsGate({ ...config, disclosuresApproved: false }, generated),
    ).toEqual({ state: 'blocked_disclosures' });
    expect(diagnosticsGate({ ...config, dsn: null }, generated)).toEqual({
      state: 'blocked_dsn',
    });
    expect(
      diagnosticsGate({ ...config, nativePrivacyApproved: false }, generated),
    ).toEqual({ state: NATIVE_DIAGNOSTICS_STATUS });
  });

  it('forms the identity from the candidate and blocks without or against it', () => {
    const config = approvedConfig();
    expect(diagnosticsGate(config)).toEqual({ state: 'blocked_identity' });
    expect(diagnosticsGate(config, null)).toEqual({
      state: 'blocked_identity',
    });
    expect(
      diagnosticsGate({ ...config, nativeBuildNumber: '2' }, generated),
    ).toEqual({ state: 'blocked_identity' });
    expect(
      diagnosticsGate({ ...config, environment: null }, generated),
    ).toEqual({ state: 'blocked_identity' });
    expect(diagnosticsGate(config, generated)).toEqual({
      state: 'ready_js_only',
      dsn,
      identity: {
        bundleIdentifier: 'com.picklesensei',
        marketingVersion: '1.0',
        nativeBuildNumber: '1',
        sourceRevision: sha,
        environment: 'test',
        modelVersion: 'scoring-v1',
        policyVersion: 'policy-v1',
      },
    });
  });

  it('tags SDK options and every reported event with version, build and commit', () => {
    const gate = diagnosticsGate(approvedConfig(), generated);
    if (gate.state !== 'ready_js_only') throw new Error(gate.state);
    const options = optionsForDiagnostics(
      gate.identity,
      gate.dsn,
      () => ({ send: async () => ({}), flush: async () => true }),
      { name: 'DebugMeta' },
    );
    expect(options).toMatchObject({
      enabled: true,
      release: 'com.picklesensei@1.0+1',
      dist: '1',
      environment: 'test',
      enableNative: false,
      autoInitializeNativeSdk: false,
      enableNativeCrashHandling: false,
    });
    const events: ErrorEvent[] = [];
    const reporter = createErrorReporter(
      {
        parseStack: () => [],
        captureEvent: event => events.push(event),
        clearScopes: () => {},
      },
      gate.identity,
    );
    expect(reporter.capture(new Error(marker), 'handled_js')).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      release: 'com.picklesensei@1.0+1',
      dist: '1',
      environment: 'test',
      tags: {
        diagnostic_origin: 'handled_js',
        source_revision: sha,
        model_version: 'scoring-v1',
        policy_version: 'policy-v1',
      },
    });
    expect(JSON.stringify(events)).not.toContain(marker);
  });
});

describe('startup wiring of the generated release identity', () => {
  function startup(
    diagnostics: RuntimeDiagnosticsConfig,
  ): typeof import('../sentry') {
    jest.doMock('../../config/runtimeConfig', () => ({
      getRuntimePublicConfig: () => ({ diagnostics }),
    }));
    try {
      let loaded!: typeof import('../sentry');
      jest.isolateModules(() => {
        loaded = jest.requireActual<typeof import('../sentry')>('../sentry');
      });
      return loaded;
    } finally {
      jest.dontMock('../../config/runtimeConfig');
    }
  }

  it('never lets the generated identity stand in for the approval flags', async () => {
    mockReadGeneratedReleaseIdentity.mockReturnValue(generatedRecord);
    const disabled = startup(getRuntimePublicConfig().diagnostics);
    expect(disabled.initializeDiagnostics()).toBe('disabled');
    const unapproved = startup({
      ...approvedConfig(),
      providerApproved: false,
    });
    expect(unapproved.initializeDiagnostics()).toBe('blocked_provider');
    await settled();
    expect(mockInit).not.toHaveBeenCalled();
    expect(disabled.getDiagnosticsStatus().transportEnabled).toBe(false);
    expect(unapproved.getDiagnosticsStatus().transportEnabled).toBe(false);
  });

  it('blocks an approved configuration whose build carries no committed identity', async () => {
    const diagnostics = startup(approvedConfig());
    expect(diagnostics.initializeDiagnostics()).toBe('blocked_identity');
    await settled();
    expect(mockInit).not.toHaveBeenCalled();
    expect(diagnostics.captureHandledError(new Error(marker))).toBe(false);
  });

  it('initializes an approved configuration from the build-time identity file', async () => {
    mockReadGeneratedReleaseIdentity.mockReturnValue(generatedRecord);
    const diagnostics = startup(approvedConfig());
    expect(diagnostics.initializeDiagnostics()).toBe('initializing');
    await settled();
    expect(diagnostics.getDiagnosticsStatus().javascript).toBe(
      'active_js_only',
    );
    expect(mockInit).toHaveBeenCalledTimes(1);
    expect(mockInit.mock.calls[0]?.[0]).toMatchObject({
      dsn,
      release: 'com.picklesensei@1.0+1',
      dist: '1',
      environment: 'test',
      enableNative: false,
    });
    expect(diagnostics.captureHandledError(new Error(marker))).toBe(true);
    expect(mockCaptureEvent).toHaveBeenCalledTimes(1);
    expect(mockCaptureEvent.mock.calls[0]?.[0]).toMatchObject({
      release: 'com.picklesensei@1.0+1',
      dist: '1',
      tags: { source_revision: sha, diagnostic_origin: 'handled_js' },
    });
    expect(JSON.stringify(mockCaptureEvent.mock.calls)).not.toContain(marker);
  });
});
