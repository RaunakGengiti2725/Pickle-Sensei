// Adversarial attacks on the W10-01 native crash envelope scrubber that the
// candidate f57804e79ead1838c2e2bd27b1ad293f3078c82b withstood. Each `it`
// asserts the fail-closed behaviour that was observed; all pass on the
// candidate and are recorded as attacks tried without a break.

import type { DiagnosticEnvelope, DiagnosticsIdentity } from '../privacy';
import {
  createScrubbedTransport,
  findDeniedDiagnosticContent,
  minimizeNativeDiagnosticEvent,
  scrubDiagnosticEnvelope,
  scrubDiagnosticEvent,
  scrubDiagnosticText,
} from '../scrub';

jest.mock('@sentry/react-native', () => {
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
const eventId = 'c'.repeat(32);
const email = 'raunak@example.test';
const installId = 'ABCDEF12-3456-4890-ABCD-EF1234567890';

type Frame = Record<string, unknown>;

function nativeEvent(
  frames: readonly Frame[],
  overrides: Record<string, unknown> = {},
) {
  return {
    event_id: eventId,
    timestamp: 1_757_000_000,
    platform: 'cocoa',
    level: 'fatal',
    exception: {
      values: [
        {
          type: 'EXC_BAD_ACCESS',
          mechanism: { type: 'mach' },
          stacktrace: { frames },
        },
      ],
    },
    ...overrides,
  };
}

function jsEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_id: eventId,
    timestamp: 1_757_000_000,
    platform: 'javascript',
    level: 'error',
    exception: {
      values: [{ type: 'TypeError', stacktrace: { frames: [] } }],
    },
    ...overrides,
  };
}

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

describe('W10-01 attack (held): timestamp boundary values', () => {
  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -1,
    -1_000_000_000_000,
    1e300,
    '1757000000',
    'not-a-date',
    '+275760-09-13T00:00:00Z',
    '0000-01-01T00:00:00Z',
    {},
    [],
    true,
    null,
    undefined,
  ])(
    'drops the timestamp %p and the envelope built from it is refused',
    timestamp => {
      const dirty = nativeEvent([{ instruction_addr: '0x1' }], { timestamp });
      const event = minimizeNativeDiagnosticEvent(dirty, identity);
      expect(event?.timestamp).toBeUndefined();
      expect(
        scrubDiagnosticEnvelope(
          [{ event_id: eventId }, [[{ type: 'event' }, dirty]]],
          identity,
        ),
      ).toBeNull();
    },
  );

  it('accepts a plausible ISO timestamp and converts it to seconds', () => {
    const event = minimizeNativeDiagnosticEvent(
      nativeEvent([{ instruction_addr: '0x1' }], {
        timestamp: '2026-09-08T18:00:00.000Z',
      }),
      identity,
    );
    expect(event?.timestamp).toBe(
      Date.parse('2026-09-08T18:00:00.000Z') / 1000,
    );
  });
});

describe('W10-01 attack (held): envelope boundaries and duplicate identities', () => {
  const header = {
    event_id: eventId,
    sent_at: marker,
    dsn: marker,
    sdk: { name: marker },
  };
  const cleanItem = [
    { type: 'event' },
    nativeEvent([{ instruction_addr: '0x1' }]),
  ];

  it('drops an envelope whose only event item sits beyond the 20-item bound', () => {
    const filler = new Array(20).fill([{ type: 'attachment' }, marker]);
    expect(
      scrubDiagnosticEnvelope([header, [...filler, cleanItem]], identity),
    ).toBeNull();
  });

  it('keeps exactly one sanitized event and never copies header fields or sibling items', () => {
    const duplicate = [
      { type: 'event' },
      nativeEvent([{ instruction_addr: '0x2' }], { event_id: 'd'.repeat(32) }),
    ];
    const attachment = [{ type: 'attachment', filename: marker }, marker];
    const session = [{ type: 'session' }, { did: installId }];
    const envelope = scrubDiagnosticEnvelope(
      [header, [attachment, session, cleanItem, duplicate]],
      identity,
    );
    expect(envelope).not.toBeNull();
    const [cleanHeader, items] = envelope as DiagnosticEnvelope;
    expect(Object.keys(cleanHeader).sort()).toEqual(['event_id', 'sent_at']);
    expect(items).toHaveLength(1);
    expect(serialized(envelope)).not.toContain(marker);
    expect(serialized(envelope)).not.toContain(installId);
    expect(serialized(envelope)).not.toContain('d'.repeat(32));
  });

  it.each([
    'C'.repeat(32),
    'c'.repeat(31),
    'c'.repeat(33),
    'g'.repeat(32),
    'ABCDEF12-3456-4890-ABCD-EF1234567890',
    '',
    42,
    null,
  ])('drops a malformed event id %p and refuses the envelope', badId => {
    const dirty = nativeEvent([{ instruction_addr: '0x1' }], {
      event_id: badId,
    });
    const event = scrubDiagnosticEvent(dirty, identity);
    expect(event?.event_id).toBeUndefined();
    expect(serialized(event)).not.toContain('ABCDEF12');
    expect(
      scrubDiagnosticEnvelope(
        [{ event_id: eventId }, [[{ type: 'event' }, dirty]]],
        identity,
      ),
    ).toBeNull();
  });

  it('a transport handed a malformed envelope forwards nothing and reports success', async () => {
    const sent: unknown[] = [];
    const transport = createScrubbedTransport(
      {
        send: async envelope => {
          sent.push(envelope);
          return {};
        },
        flush: async () => true,
      },
      identity,
    );
    await transport.send(marker as unknown as DiagnosticEnvelope);
    await transport.send([header] as unknown as DiagnosticEnvelope);
    await transport.send([
      header,
      [[{ type: 'event' }, jsEvent({ platform: 'java' })]],
    ] as unknown as DiagnosticEnvelope);
    expect(sent).toEqual([]);
  });
});

describe('W10-01 attack (held): regex state reuse across calls', () => {
  const dirty = `saved ${email} to /var/mobile/x and ${installId}`;

  it('global text rules give identical output on repeated and interleaved calls', () => {
    const first = scrubDiagnosticText(dirty);
    const results = [];
    for (let index = 0; index < 50; index += 1) {
      findDeniedDiagnosticContent(dirty);
      results.push(scrubDiagnosticText(dirty));
      scrubDiagnosticText(email);
    }
    expect(new Set(results)).toEqual(new Set([first]));
    expect(first).not.toContain(email);
    expect(first).not.toContain('/var/');
    expect(first).not.toContain(installId);
  });

  it('gate categories are stable across repeated calls', () => {
    const categories = new Set<string | null>();
    for (let index = 0; index < 50; index += 1) {
      categories.add(findDeniedDiagnosticContent(dirty));
      categories.add(findDeniedDiagnosticContent(`${email} ${installId}`));
    }
    expect(categories).toEqual(new Set(['path', 'email']));
  });
});

describe('W10-01 attack (held): pathological text sizes', () => {
  it.each([
    'a'.repeat(1024),
    'a.'.repeat(512),
    ('a'.repeat(39) + '+').repeat(25) + 'a'.repeat(24),
    'a@'.repeat(512),
    '/'.repeat(1024),
    'eyJ'.repeat(341) + 'x',
    '0x'.repeat(512),
    '1.'.repeat(512),
    ' '.repeat(1024),
    '+1 (415) 555-'.repeat(78) + 'aaaaaa',
    '/ '.repeat(512),
  ])(
    'completes and leaves only redaction markers or clean text for %p',
    text => {
      expect(text.length).toBeLessThanOrEqual(1024);
      const clean = scrubDiagnosticText(text);
      expect(typeof clean).toBe('string');
      expect(clean).not.toMatch(/\w+@\w+\.\w{2,}/);
      expect(clean).not.toMatch(/\d\.\d\.\d\.\d/);
      expect(clean).not.toMatch(/eyJ\w{4,}\./);
    },
  );

  it('refuses text over the 1024 character bound instead of scanning it', () => {
    expect(scrubDiagnosticText('a'.repeat(1025))).toBeNull();
    expect(scrubDiagnosticText(`${email}${'a'.repeat(1024)}`)).toBeNull();
  });
});

describe('W10-01 attack (held): traversal bombs fail closed', () => {
  it('a 100k deep nesting reports unreadable rather than clean', () => {
    let node: Record<string, unknown> = { leaf: 'ok' };
    for (let depth = 0; depth < 100_000; depth += 1) node = { child: node };
    expect(findDeniedDiagnosticContent(node)).toBe('unreadable');
  });

  it('a 20k-wide array of clean strings exceeds the walk limit and reports unreadable', () => {
    expect(findDeniedDiagnosticContent(new Array(20_000).fill('ok'))).toBe(
      'unreadable',
    );
  });

  it('a self-referencing clean object terminates', () => {
    const node: Record<string, unknown> = { value: 'ok' };
    node.self = node;
    node.list = [node, node];
    expect(findDeniedDiagnosticContent(node)).toBeNull();
  });

  it('a throwing getter anywhere in the walked value reports unreadable', () => {
    const node = Object.defineProperty({ ok: 'ok' }, 'boom', {
      enumerable: true,
      get: () => {
        throw new Error(marker);
      },
    });
    expect(findDeniedDiagnosticContent(node)).toBe('unreadable');
  });

  it('a Symbol-keyed and null-prototype payload does not crash the walk', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.value = email;
    const sym = { [Symbol('secret')]: email, ok: 'ok' };
    expect(findDeniedDiagnosticContent(bare)).toBe('email');
    expect(findDeniedDiagnosticContent(sym)).toBeNull();
  });
});

describe('W10-01 attack (held): hostile getters on validated fields', () => {
  it('a debug_id that changes between reads is rejected or normalized, never copied raw', () => {
    let reads = 0;
    const image = Object.defineProperty(
      { type: 'macho', image_addr: '0x102200000', image_size: 4096 },
      'debug_id',
      {
        enumerable: true,
        get: () =>
          ++reads < 3 ? '0f1e2d3c-4b5a-4978-8899-aabbccddeeff' : marker,
      },
    );
    const event = minimizeNativeDiagnosticEvent(
      nativeEvent([{ instruction_addr: '0x102200010' }], {
        debug_meta: { images: [image] },
      }),
      identity,
    );
    expect(serialized(event)).not.toContain(marker);
  });

  it('a throwing getter on the event or a frame fails the whole event closed', () => {
    const frame = Object.defineProperty({}, 'instruction_addr', {
      enumerable: true,
      get: () => {
        throw new Error(marker);
      },
    });
    expect(scrubDiagnosticEvent(nativeEvent([frame]), identity)).toBeNull();
    const event = Object.defineProperty(
      nativeEvent([{ instruction_addr: '0x1' }]),
      'level',
      {
        enumerable: true,
        get: () => {
          throw new Error(marker);
        },
      },
    );
    expect(scrubDiagnosticEvent(event, identity)).toBeNull();
  });

  it('a platform getter that flips between reads still yields no unsupported event', () => {
    let reads = 0;
    const event = Object.defineProperty(
      nativeEvent([{ instruction_addr: '0x1' }]),
      'platform',
      {
        enumerable: true,
        get: () => (++reads === 1 ? 'javascript' : 'cocoa'),
      },
    );
    const clean = scrubDiagnosticEvent(event, identity);
    expect(clean === null || clean.platform === 'javascript').toBe(true);
  });
});

describe('W10-01 attack (held): non-ASCII and homoglyph symbols', () => {
  it.each([
    `-[PS save] raunak@exam\u200bple.com`,
    'sent to raunak@exämple.de',
    'Раунак Генгити',
    'name: Raunak 😀',
  ])('a frame symbol with non-ASCII content is dropped: %p', fn => {
    const event = scrubDiagnosticEvent(
      nativeEvent([{ instruction_addr: '0x1', function: fn }]),
      identity,
    );
    expect(event).not.toBeNull();
    expect(serialized(event)).not.toContain('raunak');
    expect(serialized(event)).not.toContain('Раунак');
    expect(event?.exception?.values?.[0]?.stacktrace?.frames?.[0]).toEqual({
      instruction_addr: '0x1',
      in_app: false,
    });
  });
});

describe('W10-01 attack (held): PII in key names and unsupported surfaces', () => {
  it('denies PII carried in object keys', () => {
    expect(findDeniedDiagnosticContent({ [email]: 1 })).toBe('email');
    expect(findDeniedDiagnosticContent({ ok: { '/var/mobile/x': 1 } })).toBe(
      'path',
    );
  });

  it.each(['java', 'native', 'node', 'apple', 'ios', 'Cocoa', '', null, 7])(
    'rejects unsupported platform %p',
    platform => {
      expect(
        scrubDiagnosticEvent(
          nativeEvent([{ instruction_addr: '0x1' }], { platform }),
          identity,
        ),
      ).toBeNull();
    },
  );

  it.each(['generic', 'kscrash', 'onerror', 'unhandledrejection', 'MACH', ''])(
    'drops exceptions with unsupported native mechanism %p',
    type => {
      expect(
        scrubDiagnosticEvent(
          nativeEvent([{ instruction_addr: '0x1' }], {
            exception: {
              values: [
                {
                  type: 'EXC_CRASH',
                  mechanism: { type },
                  stacktrace: { frames: [{ instruction_addr: '0x1' }] },
                },
              ],
            },
          }),
          identity,
        ),
      ).toBeNull();
    },
  );

  it('a JS event smuggling PII through allowed keys is still dropped', () => {
    const dirty = jsEvent({
      tags: { diagnostic_origin: email },
      exception: {
        values: [{ type: email, stacktrace: { frames: [] } }],
      },
    });
    const clean = scrubDiagnosticEvent(dirty, identity);
    expect(serialized(clean)).not.toContain(email);
  });

  it('a cocoa event with the JS mechanism shape and a message body keeps neither', () => {
    const clean = scrubDiagnosticEvent(
      nativeEvent([{ instruction_addr: '0x1' }], {
        message: marker,
        logentry: { formatted: marker },
        extra: { email },
        user: { email },
      }),
      identity,
    );
    expect(clean).not.toBeNull();
    expect(serialized(clean)).not.toContain(marker);
    expect(serialized(clean)).not.toContain(email);
  });
});
