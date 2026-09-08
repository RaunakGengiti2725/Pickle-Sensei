import {
  minimizeDiagnosticEvent,
  type DiagnosticEnvelope,
  type DiagnosticsIdentity,
  type DiagnosticTransport,
  type DiagnosticTransportFactory,
} from '../privacy';
import {
  createScrubbedTransport,
  findDeniedDiagnosticContent,
  minimizeNativeDiagnosticEvent,
  scrubDiagnosticEnvelope,
  scrubDiagnosticEvent,
  scrubDiagnosticText,
} from '../scrub';
import { optionsForDiagnostics } from '../sentry';

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
const appImageId = '0F1E2D3C-4B5A-4978-8899-AABBCCDDEEFF';
const hermesImageId = '22222222-3333-4444-8555-666666666666';
const objcImageId = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
const pthreadImageId = 'cccccccc-dddd-4eee-8fff-000000000000';
const unreferencedImageId = '12121212-3434-4565-8787-989898989898';
const installId = 'ABCDEF12-3456-4890-ABCD-EF1234567890';
const email = `${marker.toLowerCase()}@example.test`;
const installPath = `/private/var/containers/Bundle/Application/${installId}/PickleSensei.app/PickleSensei`;
const simulatorPath = `/Users/${marker}/Library/Developer/CoreSimulator/Devices/${installId}/data/Containers/Bundle/Application/${installId}/PickleSensei.app/Frameworks/hermes.framework/hermes`;
const mediaUri = `file:///var/mobile/Containers/Data/Application/${installId}/Documents/clips/${marker}.mov`;
const photoId = `${installId}/L0/001`;
const jwt = `eyJhbGciOiJIUzI1NiJ9.${marker}.${marker}`;
const forbidden = [
  marker,
  marker.toLowerCase(),
  installId,
  installId.toLowerCase(),
  email,
  '/Users/',
  '/private/',
  '/var/',
  'file://',
  '.mov',
  'eyJ',
  '203.0.113.7',
  '/L0/',
];

function dirtyNativeEvent() {
  return {
    event_id: eventId,
    timestamp: 1_757_000_000.5,
    platform: 'cocoa',
    level: 'fatal',
    release: `com.picklesensei@9.9+${marker}`,
    dist: marker,
    environment: marker,
    message: marker,
    logentry: { formatted: marker },
    transaction: marker,
    fingerprint: [marker],
    server_name: marker,
    modules: { [marker]: marker },
    user: { id: marker, email, ip_address: '203.0.113.7' },
    tags: {
      diagnostic_origin: 'handled_js',
      device_name: marker,
      [marker]: marker,
    },
    extra: { clip: mediaUri, token: jwt, photo: photoId },
    breadcrumbs: [{ message: marker, data: { url: mediaUri } }],
    request: {
      url: `https://api.example.test/${marker}?access_token=${jwt}`,
      headers: { Authorization: `Bearer ${jwt}` },
    },
    threads: {
      values: [
        {
          id: 0,
          crashed: true,
          name: marker,
          stacktrace: { frames: [{ function: marker, package: installPath }] },
        },
      ],
    },
    contexts: {
      app: {
        app_identifier: 'com.picklesensei',
        app_name: marker,
        app_version: '1.0',
        app_build: '1',
        app_id: installId,
        device_app_hash: marker,
        app_start_time: '2026-09-08T17:59:00.000Z',
        build_type: 'app store',
        in_foreground: true,
        app_memory: 1234,
      },
      device: {
        name: `${marker}'s iPhone`,
        family: 'iOS',
        model: 'iPhone15,2',
        model_id: 'D73AP',
        arch: 'arm64e',
        memory_size: 6_000_000_000,
        free_memory: 123_456_789,
        usable_memory: 4_000_000_000,
        storage_size: 128_000_000_000,
        free_storage: 64_000_000_000,
        boot_time: '2026-09-08T00:00:00.000Z',
        timezone: marker,
        locale: marker,
        simulator: false,
        battery_level: 0.5,
        orientation: 'portrait',
        screen_width_pixels: 1179,
        device_unique_identifier: marker,
        low_memory: false,
        thermal_state: 'nominal',
      },
      os: {
        name: 'iOS',
        version: '18.6.2',
        build: '22G100',
        kernel_version: `Darwin ${marker}`,
        rooted: false,
      },
      culture: { locale: marker, timezone: marker },
      runtime: { name: marker },
      trace: { trace_id: marker, span_id: marker },
      [marker]: { value: marker },
    },
    exception: {
      values: [
        {
          type: 'EXC_BAD_ACCESS',
          value: `Attempted to dereference garbage pointer 0x10 while saving ${mediaUri} for ${email}`,
          thread_id: 0,
          module: marker,
          mechanism: {
            type: 'mach',
            handled: false,
            synthetic: false,
            description: marker,
            meta: {
              signal: {
                number: 11,
                code: 0,
                name: 'SIGSEGV',
                code_name: marker,
              },
              mach_exception: {
                exception: 1,
                code: 1,
                subcode: 16,
                name: 'EXC_BAD_ACCESS',
              },
              [marker]: { value: marker },
            },
            data: { relevant_address: '0x10', path: installPath, email },
          },
          stacktrace: {
            frames: [
              {
                function: 'main',
                package: installPath,
                instruction_addr: '0x0000000102201234',
                symbol_addr: '0x0000000102201200',
                image_addr: '0x0000000102200000',
                in_app: true,
                filename: installPath,
                abs_path: installPath,
                vars: { email },
                context_line: marker,
              },
              {
                function: `-[PSClipStore saveClipAtURL:] ${mediaUri}`,
                package: installPath,
                instruction_addr: '0x0000000102205678',
                image_addr: '0x0000000102200000',
                in_app: true,
              },
              {
                function: email,
                package: simulatorPath,
                instruction_addr: '0x0000000104000ABC',
                image_addr: '0x0000000104000000',
                in_app: false,
              },
              {
                function: 'objc_exception_throw',
                package: '/usr/lib/libobjc.A.dylib',
                instruction_addr: '0x00000001a0001000',
                image_addr: '0x00000001a0000000',
                in_app: false,
              },
              {
                function: marker,
                package: `/System/Library/${marker}.framework/${marker}`,
                instruction_addr: marker,
                in_app: false,
              },
              {
                function: 'pthread_kill',
                package: '/usr/lib/system/libsystem_pthread.dylib',
                instruction_addr: '0x1a0100200',
                symbol_addr: 'not-hex',
                image_addr: '0x00000001a0100000',
                in_app: 'yes',
              },
              marker,
              null,
            ],
          },
        },
        {
          type: marker,
          value: marker,
          mechanism: { type: marker },
          stacktrace: {
            frames: [{ instruction_addr: '0x1', package: mediaUri }],
          },
        },
      ],
    },
    debug_meta: {
      images: [
        {
          type: 'macho',
          debug_id: appImageId,
          code_file: installPath,
          image_addr: '0x0000000102200000',
          image_size: 65_536,
          image_vmaddr: '0x0000000100000000',
          arch: 'arm64',
          code_id: marker,
          name: marker,
        },
        {
          type: 'macho',
          debug_id: hermesImageId,
          code_file: simulatorPath,
          image_addr: '0x0000000104000000',
          image_size: 4096,
          arch: 'arm64',
        },
        {
          type: 'macho',
          debug_id: objcImageId,
          code_file: '/usr/lib/libobjc.A.dylib',
          image_addr: '0x00000001a0000000',
          image_size: 4096,
          arch: 'arm64e',
        },
        {
          type: 'macho',
          debug_id: pthreadImageId,
          code_file: '/usr/lib/system/libsystem_pthread.dylib',
          image_addr: '0x00000001a0100000',
          image_size: 4096,
          arch: marker,
        },
        {
          type: 'macho',
          debug_id: unreferencedImageId,
          code_file: '/System/Library/Frameworks/UIKit.framework/UIKit',
          image_addr: '0x00000001b0000000',
          image_size: 4096,
        },
        {
          type: 'macho',
          debug_id: marker,
          code_file: mediaUri,
          image_addr: '0x0000000102200000',
          image_size: 4096,
        },
        {
          type: 'sourcemap',
          debug_id: hermesImageId,
          code_file: 'app:///main.jsbundle',
        },
        marker,
      ],
    },
    sdk: {
      name: 'sentry.cocoa.react-native',
      version: '8.56.0',
      integrations: [marker],
      packages: [{ name: marker, version: marker }],
    },
    [marker]: marker,
  };
}

function expectedNativeEvent() {
  return {
    type: undefined,
    platform: 'cocoa',
    level: 'fatal',
    event_id: eventId,
    timestamp: 1_757_000_000.5,
    release: 'com.picklesensei@1.0+1',
    dist: '1',
    environment: 'test',
    tags: {
      diagnostic_origin: 'native_crash',
      source_revision: 'a'.repeat(40),
      model_version: 'scoring-v1',
      policy_version: 'policy-v1',
    },
    sdk: {
      name: 'sentry.cocoa.react-native',
      version: '8.56.0',
      settings: { infer_ip: 'never' },
    },
    contexts: {
      app: { build_type: 'app store', in_foreground: true },
      device: {
        family: 'iOS',
        model: 'iPhone15,2',
        model_id: 'D73AP',
        arch: 'arm64e',
        simulator: false,
        memory_size: 6_000_000_000,
        free_memory: 123_456_789,
        usable_memory: 4_000_000_000,
        low_memory: false,
      },
      os: { name: 'iOS', version: '18.6.2', build: '22G100' },
    },
    exception: {
      values: [
        {
          type: 'EXC_BAD_ACCESS',
          value: 'Error details removed',
          thread_id: 0,
          mechanism: {
            type: 'pickle.native_crash',
            handled: false,
            data: { native_mechanism: 'mach' },
            meta: {
              signal: { number: 11, code: 0, name: 'SIGSEGV' },
              mach_exception: {
                exception: 1,
                code: 1,
                subcode: 16,
                name: 'EXC_BAD_ACCESS',
              },
            },
          },
          stacktrace: {
            frames: [
              {
                function: 'main',
                package: 'PickleSensei',
                instruction_addr: '0x0000000102201234',
                symbol_addr: '0x0000000102201200',
                image_addr: '0x0000000102200000',
                in_app: true,
              },
              {
                function: '-[PSClipStore saveClipAtURL:] [redacted]',
                package: 'PickleSensei',
                instruction_addr: '0x0000000102205678',
                image_addr: '0x0000000102200000',
                in_app: true,
              },
              {
                package: 'hermes',
                instruction_addr: '0x0000000104000abc',
                image_addr: '0x0000000104000000',
                in_app: false,
              },
              {
                function: 'objc_exception_throw',
                package: 'libobjc.A.dylib',
                instruction_addr: '0x00000001a0001000',
                image_addr: '0x00000001a0000000',
                in_app: false,
              },
              {
                function: 'pthread_kill',
                package: 'libsystem_pthread.dylib',
                instruction_addr: '0x1a0100200',
                image_addr: '0x00000001a0100000',
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
          debug_id: appImageId.toLowerCase(),
          code_file: 'PickleSensei',
          image_addr: '0x0000000102200000',
          image_size: 65_536,
          image_vmaddr: '0x0000000100000000',
          arch: 'arm64',
        },
        {
          type: 'macho',
          debug_id: hermesImageId,
          code_file: 'hermes',
          image_addr: '0x0000000104000000',
          image_size: 4096,
          arch: 'arm64',
        },
        {
          type: 'macho',
          debug_id: objcImageId,
          code_file: 'libobjc.A.dylib',
          image_addr: '0x00000001a0000000',
          image_size: 4096,
          arch: 'arm64e',
        },
        {
          type: 'macho',
          debug_id: pthreadImageId,
          code_file: 'libsystem_pthread.dylib',
          image_addr: '0x00000001a0100000',
          image_size: 4096,
        },
      ],
    },
  };
}

function nativeEnvelope(event: unknown = dirtyNativeEvent()) {
  return [
    {
      event_id: eventId,
      sent_at: '2026-09-08T18:00:00.000Z',
      dsn: `https://${marker}@o1.ingest.sentry.io/1`,
      sdk: { name: 'sentry.cocoa', version: '8.56.0' },
      trace: { user_id: marker, public_key: marker, environment: marker },
    },
    [
      [{ type: 'attachment', filename: `${marker}.mov`, length: 3 }, 'abc'],
      [{ type: 'session' }, { did: marker }],
      [{ type: 'event' }, event],
      [{ type: 'attachment', filename: 'view-hierarchy.json' }, marker],
    ],
  ] as unknown as DiagnosticEnvelope;
}

function expectNoForbiddenContent(value: unknown) {
  const serialized = JSON.stringify(value);
  for (const needle of forbidden) expect(serialized).not.toContain(needle);
  expect(findDeniedDiagnosticContent(value)).toBeNull();
}

describe('diagnostic deny-list', () => {
  it.each([
    ['path', `saving ${installPath} failed`, 'path'],
    ['home path', `open ~/Movies/${marker}.mov`, 'path'],
    ['file uri', `read ${mediaUri}`, 'path'],
    ['windows path', `C:\\Users\\${marker}\\clip.mov`, 'path'],
    ['email', `contact ${email} now`, 'email'],
    ['bearer', `Authorization: Bearer ${jwt}`, 'token'],
    ['jwt', `token ${jwt} expired`, 'token'],
    ['query secret', `?refresh_token=${marker}&x=1`, 'token'],
    ['vendor key', `key appl_${marker}${marker} rejected`, 'token'],
    ['photo library id', `asset ${photoId} missing`, 'media'],
    ['photo uri', `ph://${installId}/L0/001`, 'media'],
    ['media file', `IMG_0421.MOV could not be decoded`, 'media'],
    ['ipv4', `peer 203.0.113.7 closed`, 'network'],
    ['ipv6', `peer 2001:0db8:85a3:0000:0000:8a2e:0370:7334 closed`, 'network'],
    ['mac address', `peer 00:1A:2B:3C:4D:5E`, 'network'],
  ])('flags and redacts %s', (_label, text, category) => {
    expect(findDeniedDiagnosticContent(text)).toBe(category);
    const scrubbed = scrubDiagnosticText(text);
    expect(scrubbed).toContain('[redacted]');
    expectNoForbiddenContent(scrubbed);
    expect(scrubbed).not.toContain('IMG_0421');
    expect(scrubbed).not.toContain('2001:0db8');
    expect(scrubbed).not.toContain('00:1A:2B');
  });

  it('redacts identifiers, secrets and phone numbers from free text', () => {
    expect(scrubDiagnosticText(`device ${installId} lost`)).toBe(
      'device [redacted] lost',
    );
    expect(scrubDiagnosticText(`hash ${'f'.repeat(40)} lost`)).toBe(
      'hash [redacted] lost',
    );
    expect(scrubDiagnosticText(`blob ${'QUJD'.repeat(12)}+A== lost`)).toBe(
      'blob [redacted] lost',
    );
    expect(scrubDiagnosticText('call +1 (415) 555-0100 now')).toBe(
      'call [redacted] now',
    );
    expect(scrubDiagnosticText(`user ${marker}@example.test`)).toBe(
      'user [redacted]',
    );
  });

  it('keeps native symbols, release identity and bundle names intact', () => {
    for (const text of [
      'main',
      '-[PSClipStore saveClipAtURL:]',
      '$s12PickleSensei9ClipStoreC4save4clipySS_tKF',
      'objc_exception_throw',
      '__pthread_kill',
      'std::__1::basic_string<char>::append',
      'com.picklesensei@1.0+1',
      'sentry.cocoa.react-native',
      'iPhone15,2',
      '18.6.2',
      '0x0000000102201234',
    ]) {
      expect(scrubDiagnosticText(text)).toBe(text);
      expect(findDeniedDiagnosticContent(text)).toBeNull();
    }
    expect(findDeniedDiagnosticContent('app:///main.jsbundle')).toBeNull();
    expect(
      findDeniedDiagnosticContent(minimizeDiagnosticEvent(jsEvent(), identity)),
    ).toBeNull();
    expect(findDeniedDiagnosticContent(expectedNativeEvent())).toBeNull();
  });

  it('inspects nested values, keys and hostile inputs without throwing', () => {
    expect(findDeniedDiagnosticContent({ nested: [{ deep: email }] })).toBe(
      'email',
    );
    expect(findDeniedDiagnosticContent({ [installPath]: 'x' })).toBe('path');
    expect(findDeniedDiagnosticContent(null)).toBeNull();
    expect(findDeniedDiagnosticContent(12)).toBeNull();
    const hostile = Object.defineProperty({}, 'boom', {
      enumerable: true,
      get() {
        throw new Error(marker);
      },
    });
    expect(findDeniedDiagnosticContent(hostile)).toBe('unreadable');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(findDeniedDiagnosticContent(cyclic)).toBeNull();
    expect(scrubDiagnosticText(12)).toBeNull();
    expect(scrubDiagnosticText('x'.repeat(5000))).toBeNull();
    expect(scrubDiagnosticText('')).toBe('');
  });
});

function jsEvent() {
  return {
    event_id: 'b'.repeat(32),
    timestamp: 1_700_000_000,
    platform: 'javascript',
    level: 'error',
    message: marker,
    user: { email },
    tags: { diagnostic_origin: 'react_boundary' },
    exception: {
      values: [
        {
          type: 'TypeError',
          value: marker,
          stacktrace: {
            frames: [
              { filename: `${mediaUri}/main.jsbundle`, lineno: 1, colno: 2 },
            ],
          },
        },
      ],
    },
  };
}

describe('native crash envelope scrubbing', () => {
  it('rebuilds a cocoa crash from the allow-list and drops every seeded identifier', () => {
    const clean = minimizeNativeDiagnosticEvent(dirtyNativeEvent(), identity);
    expect(clean).toEqual(expectedNativeEvent());
    expectNoForbiddenContent(clean);
    expect(Object.keys(clean!).sort()).toEqual(
      Object.keys(expectedNativeEvent()).sort(),
    );
  });

  it('routes cocoa and javascript events through one scrubber', () => {
    expect(scrubDiagnosticEvent(dirtyNativeEvent(), identity)).toEqual(
      expectedNativeEvent(),
    );
    expect(scrubDiagnosticEvent(jsEvent(), identity)).toEqual(
      minimizeDiagnosticEvent(jsEvent(), identity),
    );
    expectNoForbiddenContent(scrubDiagnosticEvent(jsEvent(), identity));
    for (const platform of ['native', 'java', 'android', 'node', undefined]) {
      expect(
        scrubDiagnosticEvent({ ...dirtyNativeEvent(), platform }, identity),
      ).toBeNull();
    }
  });

  it('refuses native payloads that are not crashes or carry no symbolicable frame', () => {
    const base = dirtyNativeEvent();
    expect(
      minimizeNativeDiagnosticEvent({ ...base, level: 'warning' }, identity),
    ).toBeNull();
    expect(
      minimizeNativeDiagnosticEvent({ ...base, type: 'transaction' }, identity),
    ).toBeNull();
    for (const mechanism of [
      'nserror',
      'watchdog_termination',
      'AppHang',
      'MetricKit',
      'generic',
      marker,
      undefined,
    ]) {
      const [first] = base.exception.values;
      expect(
        minimizeNativeDiagnosticEvent(
          {
            ...base,
            exception: {
              values: [
                {
                  ...first,
                  mechanism: { ...first!.mechanism, type: mechanism },
                },
              ],
            },
          },
          identity,
        ),
      ).toBeNull();
    }
    const [first] = base.exception.values;
    expect(
      minimizeNativeDiagnosticEvent(
        {
          ...base,
          exception: {
            values: [
              {
                ...first,
                stacktrace: {
                  frames: [{ function: 'main', package: installPath }],
                },
              },
            ],
          },
        },
        identity,
      ),
    ).toBeNull();
    expect(
      minimizeNativeDiagnosticEvent({ ...base, exception: {} }, identity),
    ).toBeNull();
    expect(minimizeNativeDiagnosticEvent(marker, identity)).toBeNull();
    expect(
      minimizeNativeDiagnosticEvent(base, {
        ...identity,
        sourceRevision: marker,
      }),
    ).toBeNull();
  });

  it('bounds frames, exceptions and images and keeps only referenced images', () => {
    const base = dirtyNativeEvent();
    const [first] = base.exception.values;
    const frames = Array.from({ length: 300 }, (_, index) => ({
      function: `frame_${index}`,
      instruction_addr: `0x${(0x1_0000_0000 + index * 16).toString(16)}`,
      in_app: index % 2 === 0,
    }));
    const images = Array.from({ length: 400 }, (_, index) => ({
      type: 'macho',
      debug_id: `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
      image_addr: `0x${(0x1_0000_0000 + index * 16).toString(16)}`,
      image_size: 16,
    }));
    const clean = minimizeNativeDiagnosticEvent(
      {
        ...base,
        exception: {
          values: [
            { ...first, stacktrace: { frames } },
            { ...first, stacktrace: { frames } },
            { ...first, stacktrace: { frames } },
            { ...first, stacktrace: { frames } },
          ],
        },
        debug_meta: { images },
      },
      identity,
    );
    expect(clean?.exception?.values).toHaveLength(3);
    const cleanFrames = clean?.exception?.values?.[0]?.stacktrace?.frames;
    expect(cleanFrames).toHaveLength(50);
    expect(cleanFrames?.[0]).toEqual({
      function: 'frame_250',
      instruction_addr: `0x${(0x1_0000_0000 + 250 * 16).toString(16)}`,
      in_app: true,
    });
    expect(cleanFrames?.[49]?.function).toBe('frame_299');
    const cleanImages = clean?.debug_meta?.images ?? [];
    expect(cleanImages).toHaveLength(50);
    expect(cleanImages[0]).toEqual({
      type: 'macho',
      debug_id: `${(250).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
      image_addr: `0x${(0x1_0000_0000 + 250 * 16).toString(16)}`,
      image_size: 16,
    });
    expectNoForbiddenContent(clean);
  });

  it('accepts ISO timestamps and omits unverifiable optional fields', () => {
    const base = dirtyNativeEvent();
    const clean = minimizeNativeDiagnosticEvent(
      {
        ...base,
        timestamp: '2026-09-08T18:00:00.500Z',
        sdk: { name: marker, version: marker },
        contexts: { device: { name: marker }, os: { name: marker } },
        debug_meta: marker,
      },
      identity,
    );
    expect(clean?.timestamp).toBe(1_788_890_400.5);
    expect(clean?.sdk).toEqual({
      name: 'sentry.cocoa',
      settings: { infer_ip: 'never' },
    });
    expect(clean?.contexts).toBeUndefined();
    expect(clean?.debug_meta).toBeUndefined();
    expect(
      minimizeNativeDiagnosticEvent({ ...base, timestamp: marker }, identity)
        ?.timestamp,
    ).toBeUndefined();
    expectNoForbiddenContent(clean);
  });

  it('fails closed on hostile getters and on identifiers that slip past the allow-list', () => {
    const base = dirtyNativeEvent();
    const hostile = Object.defineProperty({ ...base }, 'exception', {
      get() {
        throw new Error(marker);
      },
    });
    expect(minimizeNativeDiagnosticEvent(hostile, identity)).toBeNull();
    let reads = 0;
    const [first] = base.exception.values;
    const frame = Object.defineProperty(
      { instruction_addr: '0x1', in_app: true },
      'function',
      { get: () => (++reads === 1 ? 'main' : `${email}`) },
    );
    expect(
      scrubDiagnosticEvent(
        {
          ...base,
          exception: {
            values: [{ ...first, stacktrace: { frames: [frame] } }],
          },
        },
        identity,
      )?.exception?.values?.[0]?.stacktrace?.frames?.[0],
    ).toEqual({ function: 'main', instruction_addr: '0x1', in_app: true });
    expect(
      scrubDiagnosticEvent(
        {
          ...base,
          exception: {
            values: [
              {
                ...first,
                stacktrace: {
                  frames: [
                    {
                      instruction_addr: '0x1',
                      function: `handler for ${photoId}`,
                    },
                  ],
                },
              },
            ],
          },
        },
        identity,
      )?.exception?.values?.[0]?.stacktrace?.frames?.[0],
    ).toEqual({
      function: 'handler for [redacted]',
      instruction_addr: '0x1',
      in_app: false,
    });
  });

  it('rebuilds native envelopes with only the sanitized event item', () => {
    const clean = scrubDiagnosticEnvelope(nativeEnvelope(), identity);
    expect(clean).toEqual([
      { event_id: eventId, sent_at: '2025-09-04T15:33:20.500Z' },
      [[{ type: 'event' }, expectedNativeEvent()]],
    ]);
    expectNoForbiddenContent(clean);
    expect(
      scrubDiagnosticEnvelope(
        nativeEnvelope({ ...dirtyNativeEvent(), event_id: marker }),
        identity,
      ),
    ).toBeNull();
    expect(
      scrubDiagnosticEnvelope(
        [
          {},
          [[{ type: 'event' }, { ...dirtyNativeEvent(), platform: 'java' }]],
        ],
        identity,
      ),
    ).toBeNull();
    expect(scrubDiagnosticEnvelope(marker, identity)).toBeNull();
  });

  it('wraps the transport so native envelopes are scrubbed before the sink', async () => {
    const send = jest.fn(async () => ({ statusCode: 200 }));
    const sink: DiagnosticTransport = { send, flush: async () => true };
    const transport = createScrubbedTransport(sink, identity);
    await expect(transport.send(nativeEnvelope())).resolves.toEqual({
      statusCode: 200,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expectNoForbiddenContent(send.mock.calls[0]);
    await expect(
      transport.send(nativeEnvelope({ ...dirtyNativeEvent(), level: 'info' })),
    ).resolves.toEqual({});
    expect(send).toHaveBeenCalledTimes(1);
    const broken = createScrubbedTransport(
      {
        send: async () => {
          throw new Error(marker);
        },
        flush: async () => {
          throw new Error(marker);
        },
      },
      identity,
    );
    await expect(broken.send(nativeEnvelope())).resolves.toEqual({});
    await expect(broken.flush(1)).resolves.toBe(false);
    await expect(
      createScrubbedTransport(sink, {
        ...identity,
        sourceRevision: marker,
      }).send(nativeEnvelope()),
    ).resolves.toEqual({});
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('shipping diagnostics path', () => {
  it('scrubs native crash envelopes and events in the pinned SDK options', async () => {
    const send = jest.fn(async () => ({}));
    const makeTransport: DiagnosticTransportFactory = jest.fn(() => ({
      send,
      flush: async () => true,
    }));
    const options = optionsForDiagnostics(identity, null, makeTransport, {
      name: 'DebugMeta',
    });
    expect(options.enabled).toBe(false);
    expect(options.enableNative).toBe(false);
    expect(options.enableNativeCrashHandling).toBe(false);
    expect(options.beforeSend?.(dirtyNativeEvent() as never, {})).toEqual(
      expectedNativeEvent(),
    );
    const transport = options.transport!({
      url: '',
      recordDroppedEvent: () => {},
    });
    await transport.send(nativeEnvelope());
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]).toEqual([
      [
        { event_id: eventId, sent_at: '2025-09-04T15:33:20.500Z' },
        [[{ type: 'event' }, expectedNativeEvent()]],
      ],
    ]);
    expectNoForbiddenContent(send.mock.calls);
  });
});
