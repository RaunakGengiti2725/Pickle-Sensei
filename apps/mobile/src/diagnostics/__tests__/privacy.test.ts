import {
  createFilteredTransport,
  diagnosticsIdentity,
  minimizeDiagnosticEnvelope,
  minimizeDiagnosticEvent,
  type DiagnosticEnvelope,
  type DiagnosticsIdentity,
  type DiagnosticTransport,
} from '../privacy';

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
const eventId = 'b'.repeat(32);
const debugId = '11111111-2222-4333-8444-555555555555';

function dirtyEvent() {
  return {
    event_id: eventId,
    timestamp: 1_700_000_000,
    platform: 'javascript',
    level: 'fatal',
    message: marker,
    logentry: { message: marker, params: [marker] },
    user: { id: marker, email: `${marker}@example.test`, ip_address: marker },
    request: {
      url: `https://example.test/${marker}?access_token=${marker}`,
      headers: { Authorization: `Bearer ${marker}`, Cookie: marker },
      data: { refreshToken: marker, receipt: marker, grant: marker },
    },
    breadcrumbs: [
      { category: 'console', message: marker, data: { arguments: [marker] } },
      { category: 'http', data: { url: marker, response: marker } },
    ],
    contexts: {
      device: { id: marker, name: marker },
      trace: { trace_id: marker },
      app: { device_app_hash: marker },
      pose: { joints: [marker] },
    },
    extra: {
      accessToken: marker,
      refreshToken: marker,
      idToken: marker,
      providerId: marker,
      grant: marker,
      receipt: marker,
      deviceKey: marker,
      displayName: marker,
      email: marker,
      notes: marker,
      scores: [marker],
      pose: marker,
      clip: `file:///private/Captures/${marker}.mov`,
    },
    tags: { owner: marker, diagnostic_origin: 'global_js' },
    release: marker,
    dist: marker,
    environment: marker,
    transaction: marker,
    fingerprint: [marker],
    server_name: marker,
    modules: { [marker]: marker },
    sdk: {
      name: marker,
      integrations: [marker],
      settings: { infer_ip: 'auto' },
    },
    sdkProcessingMetadata: { dynamicSamplingContext: { user_segment: marker } },
    threads: { values: [{ name: marker, stacktrace: { frames: [] } }] },
    exception: {
      values: [
        {
          type: 'TypeError',
          value: marker,
          module: marker,
          mechanism: { type: marker, data: { grant: marker }, handled: false },
          stacktrace: {
            frames: [
              {
                filename: `file:///private/${marker}/main.jsbundle?token=${marker}`,
                abs_path: marker,
                function: marker,
                module: marker,
                lineno: 1,
                colno: 425,
                vars: { user: marker },
                pre_context: [marker],
                context_line: marker,
                post_context: [marker],
                data: { score: marker },
              },
              { filename: `/Users/${marker}/media.mov`, lineno: 1, colno: 1 },
              { filename: `ph://${marker}`, lineno: 1, colno: 1 },
            ],
          },
        },
      ],
    },
    debug_meta: {
      images: [
        {
          type: 'sourcemap',
          debug_id: debugId,
          code_file: `file:///private/${marker}/main.jsbundle`,
          debug_file: marker,
        },
        { type: 'macho', debug_id: marker, code_file: marker },
      ],
    },
    futureField: { privateData: marker },
  };
}

function dirtyEnvelope(): DiagnosticEnvelope {
  return [
    {
      event_id: eventId,
      sent_at: marker,
      dsn: marker,
      trace: { user: marker },
    },
    [
      [{ type: 'event', privateHeader: marker }, dirtyEvent()],
      [{ type: 'attachment', length: marker.length, filename: marker }, marker],
      [{ type: 'log', item_count: 1 }, { items: [{ body: marker }] }],
      [{ type: 'session' }, { user: marker }],
    ],
  ] as unknown as DiagnosticEnvelope;
}

describe('error-only diagnostics allowlist', () => {
  it('rebuilds events without secrets, identity, free text, paths, media, scores or pose', () => {
    const source = dirtyEvent();
    const clean = minimizeDiagnosticEvent(source, identity);
    expect(clean).toMatchObject({
      event_id: eventId,
      timestamp: 1_700_000_000,
      platform: 'javascript',
      level: 'fatal',
      release: 'com.picklesensei@1.0+1',
      dist: '1',
      environment: 'test',
      sdk: {
        name: 'sentry.javascript.react-native',
        version: '8.24.0',
        settings: { infer_ip: 'never' },
      },
      tags: {
        diagnostic_origin: 'global_js',
        source_revision: identity.sourceRevision,
        model_version: 'scoring-v1',
        policy_version: 'policy-v1',
      },
      exception: {
        values: [{ type: 'TypeError', value: 'Error details removed' }],
      },
    });
    expect(clean?.exception?.values?.[0]?.stacktrace?.frames).toEqual([
      { filename: 'app:///main.jsbundle', lineno: 1, colno: 425, in_app: true },
    ]);
    expect(clean?.debug_meta?.images).toEqual([
      {
        type: 'sourcemap',
        debug_id: debugId,
        code_file: 'app:///main.jsbundle',
      },
    ]);
    expect(JSON.stringify(clean)).not.toContain(marker);
    expect(source.message).toBe(marker);
    expect(source.exception.values[0]?.stacktrace.frames).toHaveLength(3);
  });

  it('removes unknown exception names, mechanisms and all unreviewed breadcrumbs', () => {
    const source = dirtyEvent();
    source.exception.values[0]!.type = marker;
    source.tags.diagnostic_origin = marker;
    const clean = minimizeDiagnosticEvent(source, identity);
    expect(clean?.exception?.values?.[0]).toMatchObject({ type: 'Error' });
    expect(clean?.tags?.diagnostic_origin).toBe('handled_js');
    expect(clean?.breadcrumbs).toBeUndefined();
    expect(JSON.stringify(clean)).not.toContain(marker);
  });

  it.each([
    'transaction',
    'replay_event',
    'feedback',
    'profile',
    'log',
    'metric',
  ])('drops %s events instead of treating them as errors', type => {
    expect(
      minimizeDiagnosticEvent({ ...dirtyEvent(), type }, identity),
    ).toBeNull();
  });

  it.each(['cocoa', 'native', 'java', undefined])(
    'does not claim to sanitize native or unspecified-platform envelopes (%s)',
    platform => {
      expect(
        minimizeDiagnosticEvent({ ...dirtyEvent(), platform }, identity),
      ).toBeNull();
    },
  );

  it.each(['debug', 'info', 'warning', 'log', undefined])(
    'drops non-error severity %s',
    level => {
      expect(
        minimizeDiagnosticEvent({ ...dirtyEvent(), level }, identity),
      ).toBeNull();
    },
  );

  it('drops messages without exceptions and hostile getters without throwing', () => {
    expect(
      minimizeDiagnosticEvent(
        { ...dirtyEvent(), exception: undefined },
        identity,
      ),
    ).toBeNull();
    const hostile = Object.defineProperty({}, 'platform', {
      get() {
        throw new Error(marker);
      },
    });
    expect(() => minimizeDiagnosticEvent(hostile, identity)).not.toThrow();
    expect(minimizeDiagnosticEvent(hostile, identity)).toBeNull();
  });

  it('bounds frames and rejects invalid frame coordinates and debug IDs', () => {
    const source = dirtyEvent();
    source.exception.values[0]!.stacktrace.frames = Array.from(
      { length: 1000 },
      () => ({
        filename: 'main.jsbundle',
        lineno: 1,
        colno: 425,
      }),
    ) as (typeof source.exception.values)[0]['stacktrace']['frames'];
    const clean = minimizeDiagnosticEvent(source, identity);
    expect(clean?.exception?.values?.[0]?.stacktrace?.frames).toHaveLength(50);
    const malformed = {
      ...source,
      event_id: marker,
      timestamp: Number.NaN,
      debug_meta: {
        images: [
          { type: 'sourcemap', code_file: 'main.jsbundle', debug_id: marker },
        ],
      },
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                {
                  filename: 'main.jsbundle',
                  lineno: -1,
                  colno: Number.POSITIVE_INFINITY,
                },
                { filename: 'main.jsbundle', lineno: 1, colno: -2 },
              ],
            },
          },
        ],
      },
    };
    const filtered = minimizeDiagnosticEvent(malformed, identity);
    expect(filtered?.event_id).toBeUndefined();
    expect(filtered?.timestamp).toBeUndefined();
    expect(filtered?.debug_meta).toBeUndefined();
    expect(filtered?.exception?.values?.[0]?.stacktrace).toBeUndefined();
  });

  it('enforces frame bounds without trusting overridden array methods', () => {
    const source = dirtyEvent();
    const frames = Array.from({ length: 1000 }, () => ({
      filename: 'main.jsbundle',
      lineno: 1,
      colno: 425,
    }));
    const slice = jest.fn(() => frames);
    frames.slice = slice;
    source.exception.values[0]!.stacktrace.frames =
      frames as (typeof source.exception.values)[0]['stacktrace']['frames'];
    const clean = minimizeDiagnosticEvent(source, identity);
    expect(clean?.exception?.values?.[0]?.stacktrace?.frames).toHaveLength(50);
    expect(slice).not.toHaveBeenCalled();
  });

  it('strips envelope headers and every non-error item before serialization', () => {
    const clean = minimizeDiagnosticEnvelope(dirtyEnvelope(), identity);
    expect(clean?.[0]).toEqual({
      event_id: eventId,
      sent_at: '2023-11-14T22:13:20.000Z',
    });
    expect(clean?.[1]).toHaveLength(1);
    expect(clean?.[1][0]?.[0]).toEqual({ type: 'event' });
    expect(JSON.stringify(clean)).not.toContain(marker);
    expect(minimizeDiagnosticEnvelope(clean, identity)).toEqual(clean);
  });

  it.each([
    'attachment',
    'transaction',
    'profile',
    'profile_chunk',
    'replay_event',
    'replay_recording',
    'session',
    'sessions',
    'client_report',
    'user_report',
    'feedback',
    'check_in',
    'span',
    'log',
    'metric',
    'trace_metric',
    'raw_security',
  ])('drops envelopes containing only %s', type => {
    expect(
      minimizeDiagnosticEnvelope([{}, [[{ type }, marker]]], identity),
    ).toBeNull();
  });

  it('rejects opaque serialized/native payloads and malformed envelopes', () => {
    for (const envelope of [
      null,
      marker,
      [],
      [{}, null],
      [{}, [[{ type: 'event' }, JSON.stringify(dirtyEvent())]]],
    ]) {
      expect(minimizeDiagnosticEnvelope(envelope, identity)).toBeNull();
    }
    expect(
      minimizeDiagnosticEnvelope(
        [{}, [[{ type: 'event' }, { ...dirtyEvent(), platform: 'cocoa' }]]],
        identity,
      ),
    ).toBeNull();
  });

  it('drops envelopes without SDK-generated event IDs and timestamps', () => {
    for (const patch of [{ event_id: undefined }, { timestamp: undefined }]) {
      expect(
        minimizeDiagnosticEnvelope(
          [{}, [[{ type: 'event' }, { ...dirtyEvent(), ...patch }]]],
          identity,
        ),
      ).toBeNull();
    }
  });

  it.each(Object.keys(identity))(
    'fails closed for private or missing release identity field %s',
    field => {
      for (const value of [
        marker,
        `file:///private/${marker}`,
        null,
        undefined,
      ]) {
        const invalid = { ...identity, [field]: value };
        expect(diagnosticsIdentity(invalid)).toBeNull();
        expect(
          minimizeDiagnosticEvent(dirtyEvent(), invalid as DiagnosticsIdentity),
        ).toBeNull();
        expect(
          minimizeDiagnosticEnvelope(
            dirtyEnvelope(),
            invalid as DiagnosticsIdentity,
          ),
        ).toBeNull();
      }
    },
  );

  it('snapshots allowlisted values once instead of trusting changing getters', () => {
    const event = dirtyEvent();
    let levelReads = 0;
    Object.defineProperty(event, 'level', {
      get: () => (++levelReads === 1 ? 'fatal' : marker),
    });
    let columnReads = 0;
    Object.defineProperty(
      event.exception.values[0]!.stacktrace.frames[0],
      'colno',
      { get: () => (++columnReads === 1 ? 425 : marker) },
    );
    let identityReads = 0;
    const release = Object.defineProperty(
      { ...identity },
      'nativeBuildNumber',
      { get: () => (++identityReads === 1 ? '1' : marker) },
    );
    const clean = minimizeDiagnosticEvent(event, release);
    expect(clean?.dist).toBe('1');
    expect(clean?.level).toBe('fatal');
    expect(JSON.stringify(clean)).not.toContain(marker);
    expect(columnReads).toBe(1);
    expect(levelReads).toBe(1);
    expect(identityReads).toBe(1);
  });
});

describe('last-mile envelope transport', () => {
  it('never sends attachments or unsanitized metadata to an injected recording transport', async () => {
    const sent: DiagnosticEnvelope[] = [];
    const sink: DiagnosticTransport = {
      send: async envelope => {
        sent.push(envelope);
        return {};
      },
      flush: async () => true,
    };
    const transport = createFilteredTransport(sink, identity);
    await transport.send(dirtyEnvelope());
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent)).not.toContain(marker);
    await transport.send([
      {},
      [
        [
          { type: 'attachment', length: marker.length, filename: marker },
          marker,
        ],
      ],
    ] as unknown as DiagnosticEnvelope);
    expect(sent).toHaveLength(1);
    await expect(transport.flush(25)).resolves.toBe(true);
  });

  it('isolates synchronous and asynchronous transport failures without recursive reports', async () => {
    for (const send of [
      jest.fn(() => {
        throw new Error(marker);
      }),
      jest.fn(() => Promise.reject(new Error(marker))),
    ]) {
      const transport = createFilteredTransport(
        { send, flush: () => Promise.reject(new Error(marker)) },
        identity,
      );
      await expect(transport.send(dirtyEnvelope())).resolves.toEqual({});
      await expect(transport.flush(25)).resolves.toBe(false);
      expect(send).toHaveBeenCalledTimes(1);
    }
  });
});
