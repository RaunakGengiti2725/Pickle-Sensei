/**
 * INT-security-privacy adversary — diagnostics transport must stay disabled,
 * and even a hypothetically enabled transport must be unable to carry PII,
 * media references, tokens or unbounded payloads.
 *
 * Attacks:
 *  A. Runtime: the shipped configuration keeps diagnostics `disabled` across
 *     repeated initialisation, the provider module is never loaded, and every
 *     capture/reset entry point is a no-op that returns false.
 *  B. Gate: approval flags with truthy non-boolean values, DSN look-alikes
 *     (http, lookalike hosts, query strings, uppercase hex, trailing
 *     whitespace) and hostile config objects (throwing getters, prototype
 *     poisoning) all fail closed.
 *  C. Transport: hostile envelopes (wrong tuple shape, non-event item types,
 *     PII in every free-form event field, envelope headers with dsn/trace,
 *     cyclic graphs, throwing getters, >20 items with the only real event
 *     last) either never reach the sink or reach it stripped of every marker.
 *  D. Reporter: repeated/duplicate/hostile errors under a ready gate never
 *     leak the marker, never throw, and stop after the bounded attempt count.
 *
 *   cd apps/mobile && npx jest --ci --runInBand __tests__/adv/diagnosticsTransportLeak.attack.test.ts
 */
import type { ErrorEvent, StackFrame } from '@sentry/core';
import type { RuntimeDiagnosticsConfig } from '../../src/config/runtimeConfig';
import {
  createScrubbedTransport,
  scrubDiagnosticEnvelope,
} from '../../src/diagnostics/scrub';
import type {
  DiagnosticEnvelope,
  DiagnosticsIdentity,
} from '../../src/diagnostics/privacy';
import {
  captureBoundaryError,
  captureGlobalError,
  captureHandledError,
  createErrorReporter,
  diagnosticsGate,
  getDiagnosticsStatus,
  initializeDiagnostics,
  NATIVE_DIAGNOSTICS_STATUS,
  optionsForDiagnostics,
  resetDiagnosticsScope,
} from '../../src/diagnostics/sentry';

const mockLoadSdk = jest.fn();
jest.mock('@sentry/react-native', () => {
  mockLoadSdk();
  throw new Error('The diagnostics provider must remain unloaded');
});
jest.mock('@sentry/browser', () => {
  mockLoadSdk();
  throw new Error('The diagnostics browser transport must remain unloaded');
});

const MARKER = 'ADV_SECURITY_MARKER';
const PII = {
  email: `${MARKER.toLowerCase()}@example.com`,
  bearer: `Bearer ${MARKER}.eyJhbGciOiJIUzI1NiJ9.${MARKER}`,
  mediaUri: `ph://${MARKER}/L0/001`,
  path: `/var/mobile/Containers/Data/Application/${MARKER}/Documents/clip.mov`,
  ipv4: '203.0.113.77',
  userId: '11111111-1111-4111-8111-111111111111',
  freeText: `user said ${MARKER} about their coach`,
};

const identity: DiagnosticsIdentity = {
  bundleIdentifier: 'com.picklesensei',
  marketingVersion: '1.0',
  nativeBuildNumber: '1',
  sourceRevision: 'a'.repeat(40),
  environment: 'test',
  modelVersion: 'scoring-v1',
  policyVersion: 'policy-v1',
};

const VALID_DSN = `https://${'a'.repeat(32)}@o1.ingest.sentry.io/1`;

function approvedConfig(
  overrides: Partial<Record<keyof RuntimeDiagnosticsConfig, unknown>> = {},
): RuntimeDiagnosticsConfig {
  return {
    transportEnabled: true,
    providerApproved: true,
    disclosuresApproved: true,
    nativePrivacyApproved: true,
    dsn: VALID_DSN,
    ...identity,
    ...overrides,
  } as RuntimeDiagnosticsConfig;
}

function validEvent(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    event_id: 'b'.repeat(32),
    timestamp: 1_700_000_000,
    platform: 'javascript',
    level: 'error',
    tags: { diagnostic_origin: 'global_js' },
    exception: {
      values: [
        {
          type: 'TypeError',
          value: PII.freeText,
          stacktrace: {
            frames: [
              {
                filename: `file://${PII.path}/main.jsbundle?email=${PII.email}#${MARKER}`,
                function: MARKER,
                lineno: 10,
                colno: 20,
                vars: { token: PII.bearer },
              },
            ],
          },
        },
      ],
    },
    ...extra,
  };
}

function envelope(
  header: Record<string, unknown>,
  items: unknown[],
): DiagnosticEnvelope {
  return [header, items] as unknown as DiagnosticEnvelope;
}

function containsMarkerOrPii(value: unknown): string[] {
  const text = JSON.stringify(value) ?? '';
  return [MARKER, ...Object.values(PII)].filter(needle =>
    text.includes(needle),
  );
}

describe('INT-security-privacy: diagnostics transport stays disabled and leak-proof', () => {
  describe('A. shipped runtime keeps diagnostics disabled', () => {
    it('stays disabled across repeated initialisation and never loads the provider', () => {
      const first = initializeDiagnostics();
      const second = initializeDiagnostics();
      const third = initializeDiagnostics();
      expect([first, second, third]).toEqual([
        'disabled',
        'disabled',
        'disabled',
      ]);
      expect(getDiagnosticsStatus()).toEqual({
        javascript: 'disabled',
        native: NATIVE_DIAGNOSTICS_STATUS,
        transportEnabled: false,
        persistentQueue: false,
      });
      expect(mockLoadSdk).not.toHaveBeenCalled();
    });

    it('every capture entry point is a no-op (returns false) while disabled', () => {
      const hostile = Object.assign(new Error(PII.freeText), {
        stack: `${PII.path}\n${PII.bearer}`,
        user: { email: PII.email },
      });
      expect(captureGlobalError(hostile, true)).toBe(false);
      expect(captureGlobalError(hostile, false)).toBe(false);
      expect(captureBoundaryError(hostile)).toBe(false);
      expect(captureHandledError(PII.bearer)).toBe(false);
      expect(captureHandledError(null)).toBe(false);
      expect(resetDiagnosticsScope()).toBe(false);
      expect(mockLoadSdk).not.toHaveBeenCalled();
    });
  });

  describe('B. gate fails closed for coerced approvals, DSN look-alikes and hostile config', () => {
    it.each([
      ['string "true"', { transportEnabled: 'true' }, 'disabled'],
      ['numeric 1', { transportEnabled: 1 }, 'disabled'],
      [
        'provider approval as object',
        { providerApproved: {} },
        'blocked_provider',
      ],
      [
        'disclosures as array',
        { disclosuresApproved: [true] },
        'blocked_disclosures',
      ],
      [
        'native approval as "yes"',
        { nativePrivacyApproved: 'yes' },
        NATIVE_DIAGNOSTICS_STATUS,
      ],
    ] as const)(
      'truthy non-boolean approval %s is not an approval',
      (_title, overrides, expected) => {
        expect(diagnosticsGate(approvedConfig(overrides)).state).toBe(expected);
      },
    );

    it.each([
      ['http scheme', VALID_DSN.replace('https://', 'http://')],
      ['uppercase key', `https://${'A'.repeat(32)}@o1.ingest.sentry.io/1`],
      [
        'lookalike host suffix',
        `https://${'a'.repeat(32)}@o1.ingest.sentry.io.evil.example/1`,
      ],
      [
        'lookalike host prefix',
        `https://${'a'.repeat(32)}@o1.ingest.evil-sentry.io/1`,
      ],
      ['query string', `${VALID_DSN}?${MARKER}=1`],
      ['trailing newline', `${VALID_DSN}\n`],
      ['leading whitespace', ` ${VALID_DSN}`],
      ['project id zero', `https://${'a'.repeat(32)}@o1.ingest.sentry.io/0`],
      ['embedded credentials', `https://user:${MARKER}@o1.ingest.sentry.io/1`],
      ['unicode homoglyph', `https://${'a'.repeat(32)}@o1.ingest.sentry.іo/1`],
      ['empty string', ''],
      ['null', null],
      ['array of one valid dsn', [VALID_DSN]],
    ])('DSN %s is blocked', (_title, dsn) => {
      expect(diagnosticsGate(approvedConfig({ dsn })).state).toBe(
        'blocked_dsn',
      );
    });

    it('a well-formed DSN alone still needs the native privacy approval and a valid identity', () => {
      expect(
        diagnosticsGate(approvedConfig({ nativePrivacyApproved: false })).state,
      ).toBe(NATIVE_DIAGNOSTICS_STATUS);
      expect(
        diagnosticsGate(approvedConfig({ sourceRevision: 'HEAD' })).state,
      ).toBe('blocked_identity');
      expect(
        diagnosticsGate(
          approvedConfig({ bundleIdentifier: 'com.picklesensei.dev' }),
        ).state,
      ).toBe('blocked_identity');
      expect(
        diagnosticsGate(approvedConfig({ environment: 'staging' })).state,
      ).toBe('blocked_identity');
      expect(
        diagnosticsGate(
          approvedConfig({ modelVersion: `scoring ${PII.email}` }),
        ).state,
      ).toBe('blocked_identity');
    });

    it('config objects with throwing getters or prototype-only approvals fail closed', () => {
      const throwing = Object.defineProperty({}, 'transportEnabled', {
        get() {
          throw new Error(MARKER);
        },
      });
      expect(diagnosticsGate(throwing as RuntimeDiagnosticsConfig).state).toBe(
        'unavailable',
      );
      const throwingLate = Object.defineProperty(approvedConfig(), 'dsn', {
        get() {
          throw new Error(MARKER);
        },
      });
      expect(diagnosticsGate(throwingLate).state).toBe('unavailable');
      expect(diagnosticsGate(undefined).state).toBe('disabled');
      expect(
        diagnosticsGate(null as unknown as RuntimeDiagnosticsConfig).state,
      ).toBe('disabled');
      expect(
        diagnosticsGate('true' as unknown as RuntimeDiagnosticsConfig).state,
      ).toBe('disabled');
    });

    it('options keep every collector off even when a DSN and identity are supplied', () => {
      const makeTransport = jest.fn(() => ({
        send: async () => ({}),
        flush: async () => true,
      }));
      const options = optionsForDiagnostics(
        identity,
        VALID_DSN,
        makeTransport,
        {
          name: 'DebugMeta',
        } as never,
      );
      expect(options.enabled).toBe(true);
      expect(options.dsn).toBe(VALID_DSN);
      expect(options.maxCacheItems).toBe(0);
      expect(options.maxQueueSize).toBe(8);
      expect(options.sendDefaultPii).toBe(false);
      expect(options.enableNative).toBe(false);
      expect(options.autoInitializeNativeSdk).toBe(false);
      expect(options.enableNativeCrashHandling).toBe(false);
      expect(options.attachScreenshot).toBe(false);
      expect(options.attachViewHierarchy).toBe(false);
      expect(options.attachStacktrace).toBe(false);
      expect(options.enableLogs).toBe(false);
      expect(options.enableMetrics).toBe(false);
      expect(options.replaysSessionSampleRate).toBe(0);
      expect(options.replaysOnErrorSampleRate).toBe(0);
      expect(options.tracesSampleRate).toBe(0);
      expect(options.profilesSampleRate).toBe(0);
      expect(options.maxBreadcrumbs).toBe(0);
      expect(options.tunnel).toBeUndefined();
      expect(
        options.beforeBreadcrumb?.({ message: MARKER }, undefined),
      ).toBeNull();
      expect(
        options.beforeSendTransaction?.(
          { type: 'transaction', transaction: MARKER } as never,
          {} as never,
        ),
      ).toBeNull();
      expect(
        options.beforeSend?.(
          {
            platform: 'javascript',
            level: 'error',
            message: MARKER,
          } as ErrorEvent,
          {} as never,
        ),
      ).toBeNull();
      expect(makeTransport).not.toHaveBeenCalled();
    });
  });

  describe('C. scrubbed transport drops or strips every hostile envelope', () => {
    function sinkPair() {
      const send = jest.fn(async (_envelope: DiagnosticEnvelope) => ({}));
      const sink = { send, flush: async () => true };
      return { send, transport: createScrubbedTransport(sink, identity) };
    }

    it.each([
      ['not an array', { event: validEvent() }],
      ['three-tuple', [{}, [[{ type: 'event' }, validEvent()]], {}]],
      ['header only', [{ dsn: VALID_DSN }]],
      ['items not an array', [{}, { type: 'event' }]],
      [
        'attachment item',
        [{}, [[{ type: 'attachment', filename: 'clip.mov' }, PII.freeText]]],
      ],
      [
        'session item',
        [
          {},
          [
            [
              { type: 'session' },
              { sid: PII.userId, attrs: { ip_address: PII.ipv4 } },
            ],
          ],
        ],
      ],
      [
        'replay item',
        [
          {},
          [[{ type: 'replay_event' }, validEvent({ type: 'replay_event' })]],
        ],
      ],
      [
        'transaction item',
        [{}, [[{ type: 'transaction' }, validEvent({ type: 'transaction' })]]],
      ],
      [
        'log item',
        [{}, [[{ type: 'log' }, { items: [{ body: PII.freeText }] }]]],
      ],
      [
        'client report',
        [{}, [[{ type: 'client_report' }, { discarded_events: [] }]]],
      ],
      [
        'feedback item',
        [{}, [[{ type: 'feedback' }, { message: PII.freeText }]]],
      ],
      [
        'event without id',
        [{}, [[{ type: 'event' }, validEvent({ event_id: undefined })]]],
      ],
      [
        'event without timestamp',
        [{}, [[{ type: 'event' }, validEvent({ timestamp: undefined })]]],
      ],
      [
        'event with hostile timestamp',
        [
          {},
          [[{ type: 'event' }, validEvent({ timestamp: Number.MAX_VALUE })]],
        ],
      ],
      [
        'event with hostile event id',
        [{}, [[{ type: 'event' }, validEvent({ event_id: PII.userId })]]],
      ],
      [
        'event on non-js platform',
        [{}, [[{ type: 'event' }, validEvent({ platform: 'node' })]]],
      ],
      [
        'event at info level',
        [{}, [[{ type: 'event' }, validEvent({ level: 'info' })]]],
      ],
      [
        'event with no exception',
        [
          {},
          [
            [
              { type: 'event' },
              validEvent({ exception: undefined, message: PII.freeText }),
            ],
          ],
        ],
      ],
      [
        'only real event is the 21st item',
        [
          {},
          [
            ...Array.from({ length: 20 }, () => [
              { type: 'attachment' },
              MARKER,
            ]),
            [{ type: 'event' }, validEvent()],
          ],
        ],
      ],
    ])('%s never reaches the sink', async (_title, hostile) => {
      const { send, transport } = sinkPair();
      await expect(
        transport.send(hostile as unknown as DiagnosticEnvelope),
      ).resolves.toEqual({});
      expect(send).not.toHaveBeenCalled();
    });

    it('a valid event with PII in every free-form field reaches the sink stripped of all of it', async () => {
      const { send, transport } = sinkPair();
      const hostile = envelope(
        {
          dsn: VALID_DSN,
          sdk: { name: MARKER },
          trace: { public_key: MARKER, user_segment: PII.email },
        },
        [
          [
            { type: 'event', content_type: MARKER },
            validEvent({
              message: PII.freeText,
              logentry: { message: PII.freeText },
              user: { id: PII.userId, email: PII.email, ip_address: PII.ipv4 },
              request: {
                url: PII.mediaUri,
                headers: { Authorization: PII.bearer },
              },
              breadcrumbs: [{ message: PII.freeText }],
              contexts: { device: { name: MARKER }, app: { app_name: MARKER } },
              extra: { path: PII.path },
              fingerprint: [MARKER],
              transaction: MARKER,
              server_name: MARKER,
              modules: { [MARKER]: '1' },
              environment: MARKER,
              release: MARKER,
              dist: MARKER,
              tags: {
                diagnostic_origin: 'global_js',
                [MARKER]: PII.email,
                user_id: PII.userId,
              },
              sdk: {
                name: MARKER,
                integrations: [MARKER],
                settings: { infer_ip: 'auto' },
              },
              debug_meta: {
                images: [
                  {
                    type: 'sourcemap',
                    code_file: `${PII.path}/index.android.bundle`,
                    debug_id: MARKER,
                  },
                  {
                    type: 'macho',
                    code_file: PII.path,
                    debug_id: 'c'.repeat(36),
                  },
                ],
              },
            }),
          ],
        ],
      );
      await transport.send(hostile);
      expect(send).toHaveBeenCalledTimes(1);
      const forwarded = send.mock.calls[0]?.[0];
      expect(containsMarkerOrPii(forwarded)).toEqual([]);
      const [header, items] = forwarded as unknown as [
        Record<string, unknown>,
        unknown[],
      ];
      expect(Object.keys(header).sort()).toEqual(['event_id', 'sent_at']);
      expect(items).toHaveLength(1);
      const [itemHeader, event] = items[0] as [
        Record<string, unknown>,
        ErrorEvent,
      ];
      expect(itemHeader).toEqual({ type: 'event' });
      expect(Object.keys(event).sort()).toEqual(
        [
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
      expect(event.sdk?.settings).toEqual({ infer_ip: 'never' });
      const frames = event.exception?.values?.[0]?.stacktrace
        ?.frames as StackFrame[];
      expect(frames).toEqual([
        {
          filename: 'app:///main.jsbundle',
          lineno: 10,
          colno: 20,
          in_app: true,
        },
      ]);
      expect(event.exception?.values?.[0]?.value).toBe('Error details removed');
    });

    it('cyclic graphs, throwing getters and huge frame arrays never throw and never leak', async () => {
      const { send, transport } = sinkPair();
      const cyclic: Record<string, unknown> = validEvent();
      cyclic.self = cyclic;
      (cyclic.exception as Record<string, unknown>).parent = cyclic;
      await expect(
        transport.send(envelope({}, [[{ type: 'event' }, cyclic]])),
      ).resolves.toEqual({});
      expect(containsMarkerOrPii(send.mock.calls.at(-1)?.[0])).toEqual([]);

      const throwing = validEvent();
      Object.defineProperty(throwing, 'exception', {
        enumerable: true,
        get() {
          throw new Error(MARKER);
        },
      });
      await expect(
        transport.send(envelope({}, [[{ type: 'event' }, throwing]])),
      ).resolves.toEqual({});

      const throwingFrames = validEvent();
      const frames = new Proxy([] as unknown[], {
        get(_target, property) {
          if (property === 'length') return 5;
          throw new Error(MARKER);
        },
      });
      (
        throwingFrames.exception as {
          values: [{ stacktrace: { frames: unknown } }];
        }
      ).values[0].stacktrace.frames = frames;
      await expect(
        transport.send(envelope({}, [[{ type: 'event' }, throwingFrames]])),
      ).resolves.toEqual({});

      const huge = validEvent();
      const many = Array.from({ length: 10_000 }, (_, index) => ({
        filename: index % 2 ? 'main.jsbundle' : PII.path,
        lineno: index + 1,
        colno: 1,
      }));
      (
        huge.exception as { values: [{ stacktrace: { frames: unknown } }] }
      ).values[0].stacktrace.frames = many;
      await transport.send(envelope({}, [[{ type: 'event' }, huge]]));
      const forwarded = send.mock.calls.at(-1)?.[0] as unknown as [
        unknown,
        [unknown, ErrorEvent][],
      ];
      const cleanFrames =
        forwarded[1][0]?.[1].exception?.values?.[0]?.stacktrace?.frames ?? [];
      expect(cleanFrames.length).toBeLessThanOrEqual(50);
      expect(containsMarkerOrPii(forwarded)).toEqual([]);
    });

    it('a sink that throws or rejects cannot surface the envelope or the error', async () => {
      const sink = {
        send: jest.fn(async () => {
          throw new Error(MARKER);
        }),
        flush: jest.fn(async () => {
          throw new Error(MARKER);
        }),
      };
      const transport = createScrubbedTransport(sink, identity);
      await expect(
        transport.send(envelope({}, [[{ type: 'event' }, validEvent()]])),
      ).resolves.toEqual({});
      await expect(transport.flush(10)).resolves.toBe(false);
      expect(
        scrubDiagnosticEnvelope(
          envelope({}, [[{ type: 'event' }, validEvent()]]),
          {
            ...identity,
            sourceRevision: MARKER,
          },
        ),
      ).toBeNull();
    });
  });

  describe('D. bounded, leak-free reporter under a ready gate', () => {
    function port() {
      const events: ErrorEvent[] = [];
      return {
        events,
        parseStack: (stack: string): StackFrame[] => [
          {
            filename: `file://${PII.path}/main.jsbundle`,
            function: stack.slice(0, 40),
            lineno: 1,
            colno: 1,
          },
          { filename: PII.mediaUri, function: MARKER, lineno: 2, colno: 2 },
        ],
        captureEvent: (event: ErrorEvent) => {
          events.push(event);
          return 'id';
        },
        clearScopes: () => undefined,
      };
    }

    it('reports distinct errors at most 20 times, dedupes repeats, and never emits a marker', () => {
      const reporterPort = port();
      const reporter = createErrorReporter(reporterPort, identity);
      const repeated = new Error(PII.freeText);
      expect(reporter.capture(repeated, 'global_js', true)).toBe(true);
      expect(reporter.capture(repeated, 'react_boundary')).toBe(false);
      expect(reporter.capture(repeated, 'handled_js')).toBe(false);
      let accepted = 1;
      for (let index = 0; index < 40; index += 1) {
        const error = Object.assign(
          new Error(`${MARKER}-${index} ${PII.email}`),
          {
            name: index % 3 === 0 ? MARKER : 'RangeError',
            stack: `${MARKER}\n at ${PII.path}:1:1\n at ${PII.bearer}`,
          },
        );
        if (reporter.capture(error, 'handled_js')) accepted += 1;
      }
      expect(accepted).toBe(20);
      expect(reporterPort.events).toHaveLength(20);
      expect(reporter.capture(PII.bearer, 'handled_js')).toBe(false);
      expect(containsMarkerOrPii(reporterPort.events)).toEqual([]);
      for (const event of reporterPort.events) {
        expect(event.exception?.values?.[0]?.value).toBe(
          'Error details removed',
        );
        expect(event.exception?.values?.[0]?.stacktrace?.frames).toEqual([
          {
            filename: 'app:///main.jsbundle',
            lineno: 1,
            colno: 1,
            in_app: true,
          },
        ]);
        expect(event.tags?.source_revision).toBe(identity.sourceRevision);
      }
    });

    it('primitive and hostile throwables (proxies, throwing getters, huge stacks) never throw or leak', () => {
      const reporterPort = port();
      const reporter = createErrorReporter(reporterPort, identity);
      const proxy = new Proxy(
        {},
        {
          get() {
            throw new Error(MARKER);
          },
        },
      );
      expect(() => reporter.capture(proxy, 'global_js')).not.toThrow();
      const huge = Object.assign(new Error(MARKER), {
        stack: PII.path.repeat(5_000),
      });
      expect(reporter.capture(huge, 'global_js')).toBe(true);
      expect(reporter.capture(PII.freeText, 'handled_js')).toBe(true);
      expect(reporter.capture(Symbol(MARKER), 'handled_js')).toBe(true);
      expect(reporter.capture(undefined, 'handled_js')).toBe(true);
      expect(containsMarkerOrPii(reporterPort.events)).toEqual([]);
      for (const event of reporterPort.events) {
        expect(event.exception?.values?.[0]?.stacktrace).toBeUndefined();
      }
    });
  });
});
