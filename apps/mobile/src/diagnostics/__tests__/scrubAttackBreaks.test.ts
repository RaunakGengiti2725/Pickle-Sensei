// Adversarial attacks on the W10-01 native crash envelope scrubber that
// reproduce confirmed breaks of candidate f57804e79ead1838c2e2bd27b1ad293f3078c82b.
// Every `it` below asserts the behaviour the scrubber SHOULD have; each one
// fails on the candidate and documents one break.

import type { DiagnosticsIdentity } from '../privacy';
import {
  findDeniedDiagnosticContent,
  minimizeNativeDiagnosticEvent,
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
const eventId = 'c'.repeat(32);
const installId = 'ABCDEF12-3456-4890-ABCD-EF1234567890';
const deviceName = "Raunak's iPhone";
const appImageId = '0f1e2d3c-4b5a-4978-8899-aabbccddeeff';

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

function scrubbedFrames(input: unknown): Frame[] {
  const event = scrubDiagnosticEvent(input, identity);
  const frames = event?.exception?.values?.[0]?.stacktrace?.frames;
  if (!Array.isArray(frames)) throw new Error('event was dropped');
  return frames as Frame[];
}

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

describe('W10-01 attack: hostile getters (fail-closed claim)', () => {
  it('a boolean-typed context field read twice cannot smuggle arbitrary values into the sanitized event', () => {
    const payload = { device_name: deviceName, install_id: installId };
    let foregroundReads = 0;
    let simulatorReads = 0;
    let lowMemoryReads = 0;
    const app = Object.defineProperty({}, 'in_foreground', {
      enumerable: true,
      get: () => (++foregroundReads === 1 ? true : payload),
    });
    const device = Object.defineProperty(
      Object.defineProperty({ family: 'iOS' }, 'simulator', {
        enumerable: true,
        get: () => (++simulatorReads === 1 ? false : installId),
      }),
      'low_memory',
      {
        enumerable: true,
        get: () => (++lowMemoryReads === 1 ? false : deviceName),
      },
    );
    const event = scrubDiagnosticEvent(
      nativeEvent([{ instruction_addr: '0x1' }], {
        contexts: { app, device },
      }),
      identity,
    );
    const text = serialized(event);
    expect(text).not.toContain(installId);
    expect(text).not.toContain(deviceName);
    expect(text).not.toContain('device_name');
    if (event) {
      expect(event.contexts?.app?.in_foreground).toBe(true);
      expect(event.contexts?.device?.simulator).toBe(false);
      expect(event.contexts?.device?.low_memory).toBe(false);
    }
  });
});

describe('W10-01 attack: network deny-list coverage', () => {
  const ipv6Samples = [
    'peer 2001:db8::8a2e:370:7334 closed',
    'peer fe80::1 closed',
    'peer [2001:db8::1]:443 closed',
    'peer ::1 closed',
    'peer fe80::1%en0 closed',
  ];

  it.each(ipv6Samples)(
    'compressed IPv6 literal is denied by the gate: %s',
    text => {
      expect(findDeniedDiagnosticContent(text)).toBe('network');
    },
  );

  it.each(ipv6Samples)(
    'compressed IPv6 literal is redacted from free text: %s',
    text => {
      const clean = scrubDiagnosticText(text);
      expect(clean).not.toBeNull();
      expect(clean).not.toMatch(/[0-9a-f]{1,4}::?[0-9a-f]/i);
      expect(clean).toContain('[redacted]');
    },
  );

  it('IPv6 literal in a native frame symbol does not survive into the event', () => {
    const frames = scrubbedFrames(
      nativeEvent([
        { instruction_addr: '0x1', function: 'peer fe80::1 closed' },
        {
          instruction_addr: '0x2',
          function: 'peer 2001:db8::8a2e:370:7334 closed',
        },
      ]),
    );
    expect(serialized(frames)).not.toContain('fe80::1');
    expect(serialized(frames)).not.toContain('2001:db8::8a2e:370:7334');
  });

  it('hyphen-separated MAC address is denied and redacted', () => {
    const text = 'iface 00-1A-2B-3C-4D-5E up';
    expect(findDeniedDiagnosticContent(text)).toBe('network');
    expect(scrubDiagnosticText(text)).not.toContain('00-1A-2B-3C-4D-5E');
  });
});

describe('W10-01 attack: identifier deny-list coverage in free text', () => {
  it.each([
    'call +14155550100 now',
    'call 4155550100 now',
    'call +44 20 7946 0958 now',
  ])('phone number without US-style separators is redacted: %s', text => {
    const clean = scrubDiagnosticText(text);
    expect(clean).not.toBeNull();
    expect(clean).not.toMatch(/\d{7,}/);
    expect(clean).not.toMatch(/\d{2} \d{4} \d{4}/);
  });

  it.each([
    'tok E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM end',
    'tok ' + 'xY9'.repeat(15) + ' end',
    'tok ' + 'Qz7_'.repeat(12) + ' end',
  ])('base64url / unpadded 43+ char secrets are redacted: %s', text => {
    const clean = scrubDiagnosticText(text);
    expect(clean).not.toBeNull();
    expect(clean).toBe('tok [redacted] end');
  });

  it.each([
    'password: correct-horse-battery',
    'Authorization: Token abcdefghijklmnop',
    '{"refresh_token":"v1.abc123def456ghi"}',
    'apikey ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
    'AKIAIOSFODNN7EXAMPLE',
  ])(
    'header/JSON-style secrets (colon or quote separated) are redacted: %s',
    text => {
      const clean = scrubDiagnosticText(text);
      expect(clean).not.toBeNull();
      expect(clean).toContain('[redacted]');
      expect(clean).not.toContain('correct-horse-battery');
      expect(clean).not.toContain('abcdefghijklmnop');
      expect(clean).not.toContain('v1.abc123def456ghi');
      expect(clean).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
      expect(clean).not.toContain('AKIAIOSFODNN7EXAMPLE');
    },
  );

  it('internationalized email address is denied and redacted', () => {
    const text = 'sent to raunak@exämple.de';
    expect(findDeniedDiagnosticContent(text)).toBe('email');
    expect(scrubDiagnosticText(text)).not.toContain('raunak@ex');
  });
});

describe('W10-01 attack: identifiers in structured native fields', () => {
  it('a bare UUID or 32+ hex identifier used as the package basename is not kept', () => {
    const hex32 = 'ab'.repeat(16);
    const frames = scrubbedFrames(
      nativeEvent([
        {
          instruction_addr: '0x1',
          package: `/private/var/containers/Bundle/Application/${installId}`,
        },
        { instruction_addr: '0x2', package: `/tmp/${hex32}` },
        { instruction_addr: '0x3', package: installId.toLowerCase() },
      ]),
    );
    const text = serialized(frames);
    expect(text).not.toContain(installId);
    expect(text).not.toContain(installId.toLowerCase());
    expect(text).not.toContain(hex32);
  });

  it('a bare UUID or 32+ hex identifier used as the image code_file basename is not kept', () => {
    const event = minimizeNativeDiagnosticEvent(
      nativeEvent(
        [{ instruction_addr: '0x102200010', image_addr: '0x102200000' }],
        {
          debug_meta: {
            images: [
              {
                type: 'macho',
                debug_id: appImageId,
                image_addr: '0x102200000',
                image_size: 4096,
                code_file: `/private/var/containers/Bundle/Application/${installId}`,
              },
            ],
          },
        },
      ),
      identity,
    );
    expect(event).not.toBeNull();
    expect(serialized(event?.debug_meta)).not.toContain(installId);
  });

  it('a 40-hex identifier used as the exception type is not kept', () => {
    const hex40 = 'a' + 'b'.repeat(39);
    const event = scrubDiagnosticEvent(
      nativeEvent([{ instruction_addr: '0x1' }], {
        exception: {
          values: [
            {
              type: hex40,
              mechanism: { type: 'mach' },
              stacktrace: { frames: [{ instruction_addr: '0x1' }] },
            },
          ],
        },
      }),
      identity,
    );
    expect(serialized(event)).not.toContain(hex40);
  });
});

describe('W10-01 attack: case-variant path gate', () => {
  it.each(['File:///Documents/clip.dat', 'FILE:///Documents/clip.dat'])(
    'case-variant file: scheme is denied by the gate: %s',
    text => {
      expect(findDeniedDiagnosticContent(text)).toBe('path');
    },
  );

  it.each([
    '/USERS/raunak/Desktop/x',
    '/Private/Var/Mobile/x',
    '/Var/Mobile/Media/DCIM/x',
  ])('case-variant absolute path root is denied by the gate: %s', text => {
    expect(findDeniedDiagnosticContent(text)).toBe('path');
  });
});

describe('W10-01 attack: unbounded debug_meta.images scan', () => {
  it('stops reading debug images after the documented 50-image bound', () => {
    let reads = 0;
    const images = new Proxy(new Array<unknown>(1_000_000), {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          reads += 1;
          return { type: 'macho', debug_id: 'x', image_addr: '0x1' };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const event = minimizeNativeDiagnosticEvent(
      nativeEvent([{ instruction_addr: '0x1' }], { debug_meta: { images } }),
      identity,
    );
    expect(event).not.toBeNull();
    expect(reads).toBeLessThanOrEqual(50);
  });
});

describe('W10-01 attack: identity values that trip the deny gate', () => {
  it('a valid identity whose model version is dotted quad does not silently drop every event', () => {
    const jsEvent = {
      event_id: eventId,
      timestamp: 1_757_000_000,
      platform: 'javascript',
      level: 'error',
      exception: {
        values: [{ type: 'TypeError', stacktrace: { frames: [] } }],
      },
    };
    expect(scrubDiagnosticEvent(jsEvent, identity)).not.toBeNull();
    const dottedQuad: DiagnosticsIdentity = {
      ...identity,
      modelVersion: '1.0.0.1',
    };
    expect(scrubDiagnosticEvent(jsEvent, dottedQuad)).not.toBeNull();
    expect(
      scrubDiagnosticEvent(
        nativeEvent([{ instruction_addr: '0x1' }]),
        dottedQuad,
      ),
    ).not.toBeNull();
  });
});
