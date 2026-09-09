/**
 * INT-security-privacy adversary — the mobile diagnostics pipeline.
 *
 * Attacks the shipping gate (transport must stay disabled), the reporter
 * (hostile error objects, repeated/double captures, throwing traps), and the
 * scrubbed transport (hostile JS + native envelopes carrying PII, media,
 * tokens, network identifiers, cycles, oversize payloads). The sink must only
 * ever receive the allow-listed shape, and never a planted canary.
 *
 *   cd apps/mobile && npx jest --ci --silent __tests__/adv/secprvDiagnosticsPipeline.test.ts
 */
import type { ErrorEvent } from '@sentry/react-native';
import { getRuntimePublicConfig } from '../../src/config/runtimeConfig';
import type {
  DiagnosticEnvelope,
  DiagnosticsIdentity,
  DiagnosticTransport,
} from '../../src/diagnostics/privacy';
import {
  createScrubbedTransport,
  findDeniedDiagnosticContent,
  scrubDiagnosticEnvelope,
  scrubDiagnosticText,
} from '../../src/diagnostics/scrub';
import {
  captureBoundaryError,
  captureGlobalError,
  captureHandledError,
  createErrorReporter,
  diagnosticsGate,
  getDiagnosticsStatus,
  initializeDiagnostics,
  optionsForDiagnostics,
  resetDiagnosticsScope,
  type DiagnosticsReporterPort,
} from '../../src/diagnostics/sentry';

const mockLoadSdk = jest.fn();
jest.mock('@sentry/react-native', () => {
  mockLoadSdk();
  throw new Error('The diagnostics provider must remain unloaded');
});

const CANARY = 'XCANARY_DIAG_9b2e';
const EMAIL = `${CANARY.toLowerCase()}@leak.example`;
const PATH = `/var/mobile/Containers/Data/Application/${CANARY}/Documents/clip.mov`;
const TOKEN = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIke${CANARY}In0.sig`;
const IP = '203.0.113.42';

const identity: DiagnosticsIdentity = {
  bundleIdentifier: 'com.picklesensei',
  marketingVersion: '1.0',
  nativeBuildNumber: '1',
  sourceRevision: 'a'.repeat(40),
  environment: 'test',
  modelVersion: 'scoring-v1',
  policyVersion: 'policy-v1',
};

const VALID_DSN = `https://${'a'.repeat(32)}@o123.ingest.sentry.io/456`;

function memorySink() {
  const sent: DiagnosticEnvelope[] = [];
  const sink: DiagnosticTransport = {
    send: async envelope => {
      sent.push(envelope);
      return {};
    },
    flush: async () => true,
  };
  return { sink, sent };
}

function serialized(value: unknown): string {
  return JSON.stringify(value) ?? '';
}

function nativeEvent(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    event_id: 'b'.repeat(32),
    timestamp: 1_757_400_000,
    platform: 'cocoa',
    level: 'fatal',
    exception: {
      values: [
        {
          type: 'EXC_BAD_ACCESS',
          value: `Attempted to dereference ${CANARY}`,
          mechanism: { type: 'mach', handled: false },
          stacktrace: {
            frames: [
              {
                instruction_addr: '0x10000abcd',
                image_addr: '0x100000000',
                function: 'main',
                package:
                  '/private/var/containers/Bundle/Application/' +
                  CANARY +
                  '/PickleSensei.app/PickleSensei',
                in_app: true,
              },
            ],
          },
        },
      ],
    },
    ...overrides,
  };
}

describe('shipping gate — diagnostics transport stays disabled', () => {
  it('runtime config ships every approval false and no DSN; initialize reports disabled', () => {
    const config = getRuntimePublicConfig().diagnostics;
    expect(config).toMatchObject({
      transportEnabled: false,
      providerApproved: false,
      disclosuresApproved: false,
      nativePrivacyApproved: false,
      dsn: null,
    });
    expect(initializeDiagnostics()).toBe('disabled');
    expect(initializeDiagnostics()).toBe('disabled');
    expect(getDiagnosticsStatus()).toEqual({
      javascript: 'disabled',
      native: 'blocked_unverified_native_filtering',
      transportEnabled: false,
      persistentQueue: false,
    });
    expect(mockLoadSdk).not.toHaveBeenCalled();
  });

  it('capture entry points are inert before/without an active reporter and never throw', () => {
    const hostile = new Proxy(new Error(CANARY), {
      get() {
        throw new Error('trap');
      },
    });
    expect(captureGlobalError(hostile, true)).toBe(false);
    expect(captureBoundaryError(hostile)).toBe(false);
    expect(captureHandledError(hostile)).toBe(false);
    expect(resetDiagnosticsScope()).toBe(false);
    expect(mockLoadSdk).not.toHaveBeenCalled();
  });

  it.each([
    ['http scheme', VALID_DSN.replace('https', 'http')],
    [
      'lookalike host',
      VALID_DSN.replace('sentry.io', 'sentry.io.evil.example'),
    ],
    [
      'prefixed host',
      VALID_DSN.replace('o123.ingest', 'o123.ingest.evil.example.ingest'),
    ],
    ['userinfo password', VALID_DSN.replace('@', ':secret@')],
    ['query string', `${VALID_DSN}?x=1`],
    ['trailing path', `${VALID_DSN}/extra`],
    ['uppercase key', VALID_DSN.replace('a'.repeat(32), 'A'.repeat(32))],
    ['newline', `${VALID_DSN}\nhttps://evil.example`],
    ['tunnel-like path', VALID_DSN.replace('/456', '/api/456/envelope/')],
  ])(
    'refuses a %s DSN even when every approval flag is true',
    (_label, dsn) => {
      const gate = diagnosticsGate({
        ...getRuntimePublicConfig().diagnostics,
        transportEnabled: true,
        providerApproved: true,
        disclosuresApproved: true,
        nativePrivacyApproved: true,
        dsn,
      });
      expect(gate.state).toBe('blocked_dsn');
    },
  );

  it('a build without a generated release identity is blocked even with a valid DSN and all approvals', () => {
    const gate = diagnosticsGate(
      {
        ...getRuntimePublicConfig().diagnostics,
        transportEnabled: true,
        providerApproved: true,
        disclosuresApproved: true,
        nativePrivacyApproved: true,
        dsn: VALID_DSN,
      },
      null,
    );
    expect(gate.state).toBe('blocked_identity');
  });

  it('options with a null DSN are disabled; anything the factory transport forwards is still scrubbed', async () => {
    const { sink, sent } = memorySink();
    const options = optionsForDiagnostics(identity, null, () => sink, {
      name: 'DebugMeta',
      setupOnce: () => undefined,
    } as never);
    expect(options.enabled).toBe(false);
    expect(options).not.toHaveProperty('dsn');
    const transport = options.transport?.({
      recordDroppedEvent: () => undefined,
    } as never);
    expect(transport).toBeDefined();
    await transport?.send([
      {
        event_id: 'c'.repeat(32),
        sent_at: new Date(0).toISOString(),
        dsn: CANARY,
      },
      [
        [{ type: 'attachment', filename: `${CANARY}.mov` }, CANARY],
        [{ type: 'event' }, nativeEvent({ user: { email: EMAIL } })],
      ],
    ] as unknown as DiagnosticEnvelope);
    expect(sent.length).toBeLessThanOrEqual(1);
    expect(serialized(sent)).not.toContain(CANARY);
    expect(serialized(sent)).not.toContain('leak.example');
    expect(
      options.beforeSend?.(
        {
          platform: 'javascript',
          level: 'error',
          message: EMAIL,
        } as ErrorEvent,
        {},
      ),
    ).toBeNull();
    expect(options.beforeBreadcrumb?.({ message: EMAIL })).toBeNull();
    expect(
      options.beforeSendTransaction?.({ transaction: CANARY } as never, {}),
    ).toBeNull();
  });
});

describe('reporter — hostile error objects and repeated captures', () => {
  function port(): DiagnosticsReporterPort & {
    events: ErrorEvent[];
    parseCalls: string[];
  } {
    const events: ErrorEvent[] = [];
    const parseCalls: string[] = [];
    return {
      events,
      parseCalls,
      parseStack: stack => {
        parseCalls.push(stack);
        return [
          {
            filename: `file://${PATH}/main.jsbundle`,
            function: CANARY,
            lineno: 7,
            colno: 9,
          },
          {
            filename: `https://cdn.example/${CANARY}/index.bundle?e=${EMAIL}`,
            lineno: 1,
            colno: 1,
          },
          { filename: `${CANARY}.js`, lineno: 2, colno: 2 },
        ];
      },
      captureEvent: event => events.push(event),
      clearScopes: () => undefined,
    };
  }

  it('an error whose every property is hostile yields an allow-listed event with no canary', () => {
    const p = port();
    const reporter = createErrorReporter(p, identity);
    const error = Object.assign(
      new Error(`${CANARY} ${EMAIL} ${PATH} ${TOKEN} ${IP}`),
      {
        name: `Hostile${CANARY}`,
        code: CANARY,
        user: { email: EMAIL },
        request: { url: `https://api.example/?token=${TOKEN}` },
        stack: `Hostile: ${EMAIL}\n    at ${CANARY} (${PATH}/main.jsbundle:7:9)`,
      },
    );
    expect(reporter.capture(error, 'global_js', true)).toBe(true);
    expect(p.events).toHaveLength(1);
    const text = serialized(p.events[0]);
    for (const needle of [CANARY, EMAIL, PATH, TOKEN, IP, 'Hostile']) {
      expect(text).not.toContain(needle);
    }
    expect(findDeniedDiagnosticContent(p.events[0])).toBeNull();
    const first = p.events[0];
    expect(first?.exception?.values?.[0]).toMatchObject({
      type: 'Error',
      value: 'Error details removed',
      mechanism: { type: 'pickle.global_js', handled: false },
    });
    // Only the recognised bundle filename survives, rewritten to app:///.
    expect(first?.exception?.values?.[0]?.stacktrace?.frames).toEqual([
      { filename: 'app:///main.jsbundle', lineno: 7, colno: 9, in_app: true },
      { filename: 'app:///index.bundle', lineno: 1, colno: 1, in_app: true },
    ]);
  });

  it('never re-reports the same error object and caps total attempts at 20', () => {
    const p = port();
    const reporter = createErrorReporter(p, identity);
    const error = new Error('once');
    expect(reporter.capture(error, 'handled_js')).toBe(true);
    expect(reporter.capture(error, 'handled_js')).toBe(false);
    expect(reporter.capture(error, 'react_boundary')).toBe(false);
    let accepted = 1;
    for (let i = 0; i < 100; i += 1)
      if (reporter.capture(new Error(String(i)), 'handled_js')) accepted += 1;
    expect(accepted).toBe(20);
    expect(p.events).toHaveLength(20);
  });

  it('an oversize stack (>32 KiB) and non-object throwables are handled without parsing user text', () => {
    const p = port();
    const reporter = createErrorReporter(p, identity);
    const big = new Error('big');
    big.stack =
      `Error: ${EMAIL}\n` + `    at ${CANARY} (${PATH}:1:1)\n`.repeat(2_000);
    expect(big.stack.length).toBeGreaterThan(32_768);
    expect(reporter.capture(big, 'handled_js')).toBe(true);
    expect(p.parseCalls).toEqual([]);
    expect(reporter.capture(`${EMAIL} ${PATH}`, 'handled_js')).toBe(true);
    expect(reporter.capture(42, 'handled_js')).toBe(true);
    expect(reporter.capture(null, 'handled_js')).toBe(true);
    expect(reporter.capture(undefined, 'handled_js')).toBe(true);
    expect(serialized(p.events)).not.toContain(CANARY);
    expect(serialized(p.events)).not.toContain('leak.example');
  });

  it('a throwing Proxy error, a throwing parser and a rejecting captureEvent never escape', async () => {
    const rejecting: DiagnosticsReporterPort = {
      parseStack: () => {
        throw new Error('parser down');
      },
      captureEvent: () => Promise.reject(new Error('sdk down')),
      clearScopes: () => {
        throw new Error('scope down');
      },
    };
    const reporter = createErrorReporter(rejecting, identity);
    const trap = new Proxy(new Error(CANARY), {
      get(target, key) {
        if (key === 'stack' || key === 'name') throw new Error('trap');
        return Reflect.get(target, key);
      },
    });
    expect(reporter.capture(trap, 'global_js', true)).toBe(true);
    expect(reporter.resetScope()).toBe(false);
    await Promise.resolve();
  });
});

describe('scrubbed transport — hostile envelopes', () => {
  it('JS event: user, request, breadcrumbs, extra, contexts, server_name, attachments never reach the sink', async () => {
    const { sink, sent } = memorySink();
    const transport = createScrubbedTransport(sink, identity);
    const event: Record<string, unknown> = {
      event_id: 'd'.repeat(32),
      timestamp: 1_757_400_000,
      platform: 'javascript',
      level: 'error',
      message: `${CANARY} ${EMAIL}`,
      transaction: `/session/${CANARY}`,
      server_name: `iphone-${CANARY}`,
      user: { id: CANARY, email: EMAIL, ip_address: IP, username: CANARY },
      request: {
        url: `https://api.example/?token=${TOKEN}`,
        headers: { Authorization: `Bearer ${TOKEN}` },
      },
      breadcrumbs: [{ message: PATH }, { data: { uri: `file://${PATH}` } }],
      extra: { clip: PATH, [CANARY]: 1 },
      contexts: { device: { name: CANARY }, app: { device_app_hash: CANARY } },
      fingerprint: [CANARY],
      tags: { diagnostic_origin: 'global_js', user_id: CANARY, [EMAIL]: 'x' },
      sdk: {
        name: 'sentry.javascript.react-native',
        version: '8.24.0',
        integrations: [CANARY],
      },
      exception: {
        values: [
          {
            type: `Custom${CANARY}`,
            value: EMAIL,
            module: CANARY,
            thread_id: 1,
            mechanism: { type: 'onerror', data: { url: PATH } },
            stacktrace: {
              frames: [
                {
                  filename: `file://${PATH}/main.jsbundle`,
                  function: CANARY,
                  lineno: 1,
                  colno: 1,
                  vars: { email: EMAIL },
                },
                {
                  filename: `${PATH}/index.bundle`,
                  lineno: 2,
                  colno: 2,
                  context_line: EMAIL,
                  pre_context: [CANARY],
                },
              ],
            },
          },
        ],
      },
      debug_meta: {
        images: [
          {
            type: 'sourcemap',
            code_file: `file://${PATH}/main.jsbundle`,
            debug_id: '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12),
            debug_file: PATH,
          },
          {
            type: 'macho',
            code_file: PATH,
            debug_id: 'e'.repeat(8) + '-eeee-eeee-eeee-' + 'e'.repeat(12),
          },
        ],
      },
    };
    await transport.send([
      {
        event_id: 'd'.repeat(32),
        sent_at: new Date(0).toISOString(),
        dsn: `https://${CANARY}@o1.ingest.sentry.io/1`,
        trace: { user_segment: CANARY },
      },
      [
        [
          {
            type: 'attachment',
            filename: `${CANARY}.mov`,
            content_type: 'video/quicktime',
          },
          `binary ${CANARY}`,
        ],
        [{ type: 'session' }, { did: CANARY, ip_address: IP }],
        [{ type: 'event' }, event],
        [{ type: 'client_report' }, { discarded_events: [] }],
      ],
    ] as unknown as DiagnosticEnvelope);
    expect(sent).toHaveLength(1);
    const text = serialized(sent[0]);
    for (const needle of [
      CANARY,
      EMAIL,
      PATH,
      TOKEN,
      IP,
      'leak.example',
      'attachment',
      'session',
      'user',
      'breadcrumbs',
      'request',
      'extra',
      'vars',
      'context_line',
    ]) {
      expect(text).not.toContain(needle);
    }
    const header = sent[0]?.[0] ?? {};
    const items = sent[0]?.[1] ?? [];
    expect(Object.keys(header).sort()).toEqual(['event_id', 'sent_at']);
    expect(items).toHaveLength(1);
    const clean = (items[0]?.[1] ?? {}) as ErrorEvent;
    expect(Object.keys(clean).sort()).toEqual(
      [
        'debug_meta',
        'dist',
        'environment',
        'event_id',
        'exception',
        'level',
        'platform',
        'release',
        'sdk',
        'tags',
        'timestamp',
        'type',
      ].sort(),
    );
    expect(clean.tags).toEqual({
      diagnostic_origin: 'global_js',
      source_revision: 'a'.repeat(40),
      model_version: 'scoring-v1',
      policy_version: 'policy-v1',
    });
    expect(clean.debug_meta).toEqual({
      images: [
        {
          type: 'sourcemap',
          code_file: 'app:///main.jsbundle',
          debug_id: '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12),
        },
      ],
    });
  });

  it('native event: hostile symbols, packages, contexts and identifiers are stripped; unreferenced images dropped', async () => {
    const { sink, sent } = memorySink();
    const transport = createScrubbedTransport(sink, identity);
    const event = nativeEvent({
      user: { id: CANARY, email: EMAIL },
      contexts: {
        device: {
          name: `iPhone of ${CANARY}`,
          model: 'iPhone16,2',
          model_id: 'D93AP',
          family: 'iOS',
          arch: 'arm64e',
          memory_size: 6_000_000_000,
          boot_time: '2026-09-09T00:00:00Z',
          timezone: 'America/Los_Angeles',
          locale: 'en_US',
          device_id: CANARY,
          external_storage_size: 1,
        },
        app: {
          app_identifier: 'com.picklesensei',
          build_type: 'app store',
          device_app_hash: CANARY,
          app_name: CANARY,
        },
        os: {
          name: 'iOS',
          version: '18.6.2',
          build: '22G100',
          kernel_version: `Darwin ${CANARY}`,
        },
        culture: { locale: 'en_US', timezone: 'America/Los_Angeles' },
        response: { headers: { Authorization: TOKEN } },
      },
      exception: {
        values: [
          {
            type: 'EXC_BAD_ACCESS',
            value: `${EMAIL} ${PATH}`,
            mechanism: {
              type: 'mach',
              handled: false,
              meta: {
                mach_exception: {
                  exception: 1,
                  code: 1,
                  subcode: 0,
                  name: 'EXC_BAD_ACCESS',
                },
              },
              data: { relevant_address: CANARY },
            },
            thread_id: 0,
            stacktrace: {
              frames: [
                {
                  instruction_addr: '0x10000abcd',
                  image_addr: '0x100000000',
                  function: `-[SessionVault storeRefreshToken:${TOKEN}] ${EMAIL} ${PATH} ${IP}`,
                  package: `${PATH}/PickleSensei`,
                  filename: PATH,
                  abs_path: PATH,
                  vars: { email: EMAIL },
                  in_app: true,
                },
                {
                  instruction_addr: '0x18000abcd',
                  image_addr: '0x180000000',
                  function: 'objc_msgSend',
                  package: '/usr/lib/libobjc.A.dylib',
                  in_app: false,
                },
              ],
            },
          },
        ],
      },
      debug_meta: {
        images: [
          {
            type: 'macho',
            image_addr: '0x100000000',
            image_size: 65_536,
            debug_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
            code_file: `${PATH}/PickleSensei`,
            arch: 'arm64e',
            uuid: CANARY,
          },
          {
            type: 'macho',
            image_addr: '0x180000000',
            image_size: 65_536,
            debug_id: 'b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
            code_file: '/usr/lib/libobjc.A.dylib',
            arch: 'arm64e',
          },
          {
            type: 'macho',
            image_addr: '0x1f0000000',
            image_size: 65_536,
            debug_id: 'c1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
            code_file: `/System/Library/${CANARY}.dylib`,
          },
        ],
      },
      threads: { values: [{ id: 0, name: CANARY }] },
      breadcrumbs: [{ message: EMAIL }],
      sdk: {
        name: 'sentry.cocoa',
        version: '8.50.0',
        integrations: [CANARY],
        packages: [{ name: CANARY }],
      },
    });
    await transport.send([
      { event_id: 'b'.repeat(32), sent_at: new Date(0).toISOString() },
      [[{ type: 'event' }, event]],
    ] as unknown as DiagnosticEnvelope);
    expect(sent).toHaveLength(1);
    const text = serialized(sent[0]);
    for (const needle of [
      CANARY,
      EMAIL,
      PATH,
      TOKEN,
      IP,
      'leak.example',
      'threads',
      'breadcrumbs',
      'user',
      'timezone',
      'locale',
      'boot_time',
      'device_id',
      'kernel',
      'response',
      'filename',
      'abs_path',
      'vars',
      'relevant_address',
      'uuid',
      'app_name',
    ]) {
      expect(text).not.toContain(needle);
    }
    const clean: ErrorEvent = (
      (sent[0]?.[1] ?? []) as Array<[unknown, ErrorEvent]>
    )[0]?.[1] ?? { type: undefined };
    expect(findDeniedDiagnosticContent(clean)).toBeNull();
    const images = clean.debug_meta?.images ?? [];
    expect(images).toHaveLength(2);
    expect(
      images.map(image => (image as { code_file?: string }).code_file),
    ).toEqual(['PickleSensei', 'libobjc.A.dylib']);
    expect(clean.exception?.values?.[0]?.value).toBe('Error details removed');
    const frames = clean.exception?.values?.[0]?.stacktrace?.frames ?? [];
    expect(frames).toHaveLength(2);
    const allowedFrameKeys = [
      'function',
      'image_addr',
      'in_app',
      'instruction_addr',
      'package',
    ];
    for (const frame of frames) {
      for (const key of Object.keys(frame))
        expect(allowedFrameKeys).toContain(key);
    }
  });

  it('cyclic, 100k-frame and Proxy-trapped envelopes are bounded or refused without throwing or leaking', async () => {
    const { sink, sent } = memorySink();
    const transport = createScrubbedTransport(sink, identity);
    const cyclic: Record<string, unknown> = nativeEvent({});
    (cyclic.exception as Record<string, unknown>).self = cyclic;
    const huge = nativeEvent({
      exception: {
        values: [
          {
            type: 'EXC_BAD_ACCESS',
            mechanism: { type: 'mach', handled: false },
            stacktrace: {
              frames: Array.from({ length: 100_000 }, (_, i) => ({
                instruction_addr: `0x${(0x10000000 + i).toString(16)}`,
                function: i === 99_999 ? `${CANARY} ${EMAIL}` : 'fn',
              })),
            },
          },
        ],
      },
    });
    const trapped = new Proxy(nativeEvent({}), {
      get(target, key) {
        if (key === 'exception') throw new Error('trap');
        return Reflect.get(target, key);
      },
    });
    for (const event of [cyclic, huge, trapped]) {
      await expect(
        transport.send([
          { event_id: 'b'.repeat(32), sent_at: new Date(0).toISOString() },
          [[{ type: 'event' }, event]],
        ] as unknown as DiagnosticEnvelope),
      ).resolves.toEqual({});
    }
    expect(serialized(sent)).not.toContain('leak.example');
    expect(serialized(sent)).not.toContain(PATH);
    for (const envelope of sent) {
      const clean: ErrorEvent = (
        envelope[1] as Array<[unknown, ErrorEvent]>
      )[0]?.[1] ?? { type: undefined };
      expect(findDeniedDiagnosticContent(clean)).toBeNull();
      expect(
        (clean.exception?.values?.[0]?.stacktrace?.frames ?? []).length,
      ).toBeLessThanOrEqual(50);
    }
    expect(
      scrubDiagnosticEnvelope(
        [{}, Array.from({ length: 1_000_000 })],
        identity,
      ),
    ).toBeNull();
  });

  it('a hostile identity (path in modelVersion, email in policyVersion, non-hex revision) disables the transport', async () => {
    const hostile = {
      ...identity,
      modelVersion: `scoring-v1/${CANARY}`,
      policyVersion: EMAIL,
      sourceRevision: 'g'.repeat(40),
    } as unknown as DiagnosticsIdentity;
    const { sink, sent } = memorySink();
    const transport = createScrubbedTransport(sink, hostile);
    await transport.send([
      { event_id: 'b'.repeat(32), sent_at: new Date(0).toISOString() },
      [[{ type: 'event' }, nativeEvent({})]],
    ] as unknown as DiagnosticEnvelope);
    expect(sent).toEqual([]);
  });
});

describe('free-text scrubber — deny coverage probes', () => {
  it.each([
    [
      'percent-encoded file URL',
      `file%3A%2F%2F%2Fvar%2Fmobile%2F${CANARY}%2Fclip.mov`,
    ],
    ['home-relative Library path', `~/Library/Caches/${CANARY}`],
    ['compressed IPv6', 'fe80::1ff:fe23:4567:890a'],
    ['international phone', '+44 20 7946 0958'],
    ['mailto URL', `mailto:${EMAIL}`],
    [
      'Apple private relay style address',
      `${CANARY.toLowerCase()}@privaterelay.appleid.com`,
    ],
    ['Photos localIdentifier', 'A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D/L0/001'],
    ['media basename with spaces', `IMG 0042 ${CANARY}.MOV`],
    ['Windows path', `C:\\Users\\${CANARY}\\clip.mov`],
    [
      'base64url refresh token (43 chars, no padding)',
      'A'.repeat(21) + '-' + '_'.repeat(21),
    ],
  ])('%s is redacted or dropped', (_label, text) => {
    const out = scrubDiagnosticText(text);
    expect(
      out === null ||
        out === '[redacted]' ||
        (!out.includes(CANARY) &&
          !out.includes('leak.example') &&
          !out.includes('privaterelay')),
    ).toBe(true);
    if (out !== null && out !== '[redacted]')
      expect(out).toContain('[redacted]');
  });
});
