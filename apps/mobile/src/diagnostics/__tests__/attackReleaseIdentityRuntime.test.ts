// Adversarial tests for W10-03 (candidate 4675b54f): the runtime half — the
// parser, the merge, the gate and the startup wiring — attacked at replay,
// restart, prototype and time-of-check boundaries the candidate's own suites
// do not exercise. A failing test is a confirmed break.
import {
  getRuntimePublicConfig,
  type RuntimeDiagnosticsConfig,
} from '../../config/runtimeConfig';
import {
  applyGeneratedReleaseIdentity,
  generatedReleaseIdentity,
  parseGeneratedReleaseIdentity,
} from '../../config/releaseIdentity';
import { diagnosticsGate, NATIVE_DIAGNOSTICS_STATUS } from '../sentry';

const mockReadGeneratedReleaseIdentity = jest.fn<unknown, []>(() => null);
jest.mock('../../config/readGeneratedReleaseIdentity', () => ({
  readGeneratedReleaseIdentity: () => mockReadGeneratedReleaseIdentity(),
}));

const mockLoadSdk = jest.fn();
jest.mock('@sentry/react-native', () => {
  mockLoadSdk();
  throw new Error('The diagnostics provider must remain unloaded');
});

const sha = '0123456789abcdef0123456789abcdef01234567';
const otherSha = 'fedcba9876543210fedcba9876543210fedcba98';
const dsn = `https://${'a'.repeat(32)}@o1.ingest.sentry.io/1`;
const record = {
  marketingVersion: '1.0',
  buildNumber: 1,
  bundleIdentifier: 'com.picklesensei',
  gitSha: sha,
  committed: true,
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

async function settled(): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

beforeEach(() => {
  mockReadGeneratedReleaseIdentity.mockReset();
  mockReadGeneratedReleaseIdentity.mockReturnValue(null);
  mockLoadSdk.mockClear();
});

describe('ATTACK prototype and property-shape smuggling', () => {
  it('ignores a committed verdict and identity inherited through the prototype', () => {
    expect(parseGeneratedReleaseIdentity(Object.create(record))).toBeNull();
    expect(
      parseGeneratedReleaseIdentity(
        Object.assign(Object.create({ committed: true }), {
          ...record,
          committed: undefined,
        }),
      ),
    ).toBeNull();
    expect(
      parseGeneratedReleaseIdentity(
        Object.assign(Object.create({ gitSha: sha }), {
          ...record,
          gitSha: undefined,
        }),
      ),
    ).toBeNull();
  });

  it('is not fooled by JSON that names __proto__ or by objects wrapping the primitives', () => {
    expect(
      parseGeneratedReleaseIdentity(
        JSON.parse(`{"__proto__":${JSON.stringify(record)}}`),
      ),
    ).toBeNull();
    expect(
      parseGeneratedReleaseIdentity({
        ...record,
        committed: Object(true),
      }),
    ).toBeNull();
    expect(
      parseGeneratedReleaseIdentity({
        ...record,
        buildNumber: Object(1),
      }),
    ).toBeNull();
    expect(
      parseGeneratedReleaseIdentity({
        ...record,
        gitSha: Object(sha),
      }),
    ).toBeNull();
    expect(
      parseGeneratedReleaseIdentity({
        ...record,
        marketingVersion: Object('1.0'),
      }),
    ).toBeNull();
  });

  it('rejects whitespace, zero-width and unicode-digit disguises around every field', () => {
    for (const patch of [
      { marketingVersion: '1.0\n' },
      { marketingVersion: ' 1.0' },
      { marketingVersion: '\u{FF11}.0' },
      { marketingVersion: '1.0\u200B' },
      { gitSha: `${sha}\n` },
      { gitSha: `${sha.slice(1)}\u{FF10}` },
      { bundleIdentifier: 'com.picklesensei\u0000' },
      { bundleIdentifier: 'com.picklesensei ' },
      { buildNumber: 1.0000000000000002 },
      { buildNumber: -0 },
      { buildNumber: 0.5 + 0.5 - 1 },
    ]) {
      expect(parseGeneratedReleaseIdentity({ ...record, ...patch })).toBeNull();
    }
  });
});

describe('ATTACK time-of-check / time-of-use on the record', () => {
  it('reads each field exactly once and freezes what it returns', () => {
    const reads: string[] = [];
    let shaReads = 0;
    const shifty = {
      get committed() {
        reads.push('committed');
        return true;
      },
      get bundleIdentifier() {
        reads.push('bundleIdentifier');
        return 'com.picklesensei';
      },
      get marketingVersion() {
        reads.push('marketingVersion');
        return '1.0';
      },
      get buildNumber() {
        reads.push('buildNumber');
        return 1;
      },
      get gitSha() {
        reads.push('gitSha');
        shaReads += 1;
        return shaReads === 1 ? sha : otherSha;
      },
    };
    const parsed = parseGeneratedReleaseIdentity(shifty);
    expect(parsed).toEqual({
      bundleIdentifier: 'com.picklesensei',
      marketingVersion: '1.0',
      nativeBuildNumber: '1',
      sourceRevision: sha,
    });
    expect(reads.filter(key => key === 'gitSha')).toHaveLength(1);
    expect(Object.isFrozen(parsed)).toBe(true);
    const mutable = parsed as unknown as Record<string, unknown>;
    expect(Reflect.set(mutable, 'sourceRevision', otherSha)).toBe(false);
    expect(parsed?.sourceRevision).toBe(sha);
  });

  it('never lets a getter that throws on the second read leak a half-built identity', () => {
    let buildReads = 0;
    const record2 = {
      ...record,
      get buildNumber() {
        buildReads += 1;
        if (buildReads > 1) throw new Error('second read');
        return 1;
      },
    };
    expect(parseGeneratedReleaseIdentity(record2)).not.toBeNull();
    expect(buildReads).toBe(1);
    const applied = applyGeneratedReleaseIdentity(approvedConfig(), {
      bundleIdentifier: 'com.picklesensei',
      marketingVersion: '1.0',
      get nativeBuildNumber(): string {
        throw new Error('hostile');
      },
      sourceRevision: sha,
    });
    expect(applied).toBeNull();
  });
});

describe('ATTACK replay of another candidate', () => {
  it('refuses an identity whose commit or build differs from what the runtime already carries, even when numerically equal', () => {
    const generated = parseGeneratedReleaseIdentity(record);
    expect(generated).not.toBeNull();
    for (const runtime of [
      { nativeBuildNumber: '01' },
      { nativeBuildNumber: '1.0' },
      { nativeBuildNumber: ' 1' },
      { sourceRevision: sha.toUpperCase() },
      { sourceRevision: otherSha },
      { marketingVersion: '1.0.0' },
      { marketingVersion: '1' },
    ]) {
      expect(
        applyGeneratedReleaseIdentity(
          { ...approvedConfig(), ...runtime },
          generated,
        ),
      ).toBeNull();
      expect(
        diagnosticsGate({ ...approvedConfig(), ...runtime }, generated),
      ).toEqual({ state: 'blocked_identity' });
    }
  });

  it('never merges a record from a different bundle even when the runtime bundle field is missing', () => {
    const generated = parseGeneratedReleaseIdentity(record);
    const config = approvedConfig();
    const stripped = Object.fromEntries(
      Object.entries(config).filter(([key]) => key !== 'bundleIdentifier'),
    ) as unknown as RuntimeDiagnosticsConfig;
    expect(applyGeneratedReleaseIdentity(stripped, generated)).toBeNull();
    expect(diagnosticsGate(stripped, generated)).toEqual({
      state: 'blocked_identity',
    });
  });
});

describe('ATTACK restart and reload: the identity is fixed at startup', () => {
  it('does not pick up an identity file that appears after startup blocked on its absence', async () => {
    const diagnostics = startup(approvedConfig());
    expect(diagnostics.initializeDiagnostics()).toBe('blocked_identity');
    // A later build (or an attacker) drops a valid file into place while the
    // process keeps running; only a restart may observe it.
    mockReadGeneratedReleaseIdentity.mockReturnValue(record);
    expect(diagnostics.initializeDiagnostics()).toBe('blocked_identity');
    expect(diagnostics.initializeDiagnostics()).toBe('blocked_identity');
    expect(mockReadGeneratedReleaseIdentity).toHaveBeenCalledTimes(1);
    await settled();
    expect(mockLoadSdk).not.toHaveBeenCalled();
    expect(diagnostics.getDiagnosticsStatus().javascript).toBe(
      'blocked_identity',
    );
    expect(diagnostics.getDiagnosticsStatus().transportEnabled).toBe(false);
    expect(diagnostics.captureHandledError(new Error('x'))).toBe(false);
  });

  it('gives a fresh process exactly the identity of its own build, not the previous process’s', async () => {
    mockReadGeneratedReleaseIdentity.mockReturnValue(record);
    const first = startup(approvedConfig());
    expect(first.initializeDiagnostics()).toBe('initializing');
    // Restart after the file was removed (e.g. the next build's phase refused).
    mockReadGeneratedReleaseIdentity.mockReturnValue(null);
    const second = startup(approvedConfig());
    expect(second.initializeDiagnostics()).toBe('blocked_identity');
    // Restart with another candidate's file: the runtime must carry that one.
    mockReadGeneratedReleaseIdentity.mockReturnValue({
      ...record,
      gitSha: otherSha,
      buildNumber: 2,
    });
    expect(generatedReleaseIdentity()).toEqual({
      bundleIdentifier: 'com.picklesensei',
      marketingVersion: '1.0',
      nativeBuildNumber: '2',
      sourceRevision: otherSha,
    });
    const third = startup(approvedConfig());
    expect(third.initializeDiagnostics()).toBe('initializing');
    await settled();
    expect(second.getDiagnosticsStatus().javascript).toBe('blocked_identity');
  });

  it('treats a reader that throws (a corrupt generated module) as no identity, not as a crash', async () => {
    mockReadGeneratedReleaseIdentity.mockImplementation(() => {
      throw new SyntaxError('Unexpected end of JSON input');
    });
    expect(generatedReleaseIdentity()).toBeNull();
    const diagnostics = startup(approvedConfig());
    expect(diagnostics.initializeDiagnostics()).toBe('blocked_identity');
    await settled();
    expect(mockLoadSdk).not.toHaveBeenCalled();
    expect(diagnostics.getDiagnosticsStatus().transportEnabled).toBe(false);
  });

  it('keeps transport disabled and the SDK unloaded on the shipping configuration even with a perfect identity', async () => {
    mockReadGeneratedReleaseIdentity.mockReturnValue(record);
    const shipping = getRuntimePublicConfig().diagnostics;
    expect(shipping.transportEnabled).toBe(false);
    expect(shipping.nativeBuildNumber).toBeNull();
    expect(shipping.sourceRevision).toBeNull();
    const diagnostics = startup(shipping);
    expect(diagnostics.initializeDiagnostics()).toBe('disabled');
    // The file is read once at startup and never surfaced: nothing about the
    // build leaks into a disabled diagnostics status.
    expect(mockReadGeneratedReleaseIdentity).toHaveBeenCalledTimes(1);
    await settled();
    expect(mockLoadSdk).not.toHaveBeenCalled();
    const status = diagnostics.getDiagnosticsStatus();
    expect(JSON.stringify(status)).not.toContain(sha);
    expect(JSON.stringify(status)).not.toContain('"1.0"');
  });
});

describe('ATTACK approval-flag bypass through the identity path', () => {
  it('rejects truthy non-boolean approvals no matter how complete the identity is', () => {
    const generated = parseGeneratedReleaseIdentity(record);
    const base = approvedConfig();
    expect(diagnosticsGate(base, generated).state).toBe('ready_js_only');
    const forged: Array<
      [Partial<Record<keyof RuntimeDiagnosticsConfig, unknown>>, string]
    > = [
      [{ transportEnabled: 'true' }, 'disabled'],
      [{ transportEnabled: 1 }, 'disabled'],
      [{ providerApproved: 'yes' }, 'blocked_provider'],
      [{ disclosuresApproved: {} }, 'blocked_disclosures'],
      [{ nativePrivacyApproved: [] }, NATIVE_DIAGNOSTICS_STATUS],
      [{ dsn: `${dsn}\n` }, 'blocked_dsn'],
      [
        { dsn: dsn.replace('sentry.io', 'sentry.io.attacker.example') },
        'blocked_dsn',
      ],
    ];
    for (const [patch, expected] of forged) {
      const gate = diagnosticsGate(
        { ...base, ...patch } as RuntimeDiagnosticsConfig,
        generated,
      );
      expect(gate.state === expected || gate.state === 'unavailable').toBe(
        true,
      );
      expect(gate.state).not.toBe('ready_js_only');
    }
  });
});
