/**
 * STRESS — boundary/malformed runtime constants against
 * `src/account/deviceContext.ts`. `Platform` and `Intl.DateTimeFormat` are the
 * only inputs; both are driven from a seeded RNG through hostile values
 * (wrong types, null bytes, 64KB strings, traversal, confusables, missing
 * constants). Invariant: the function either returns a fully string-typed
 * `AccountBootstrapEnvironment` or throws one of its two explicit errors.
 *
 *   STRESS_ITER=3000 npx jest --ci accountDeviceContextMalformed
 *   STRESS_SEED=42 npx jest --ci accountDeviceContextMalformed
 */
import fs from 'node:fs';
import path from 'node:path';

import { getAccountBootstrapEnvironment } from '../../src/account/deviceContext';
import type { RuntimePublicConfig } from '../../src/config/runtimeConfig';
import {
  TRAVERSAL_STRINGS,
  digest,
  edgeOsVersion,
  hostileString,
  bigString,
  wrongTypeValue,
} from '../../__harness__/accountBoundaryMalformed/generators';
import { SeededRng } from '../../__harness__/accountBoundaryMalformed/rng';
import {
  readIterations,
  readReplaySeed,
  readSeedBase,
} from '../../__harness__/accountBoundaryMalformed/runner';

const mockPlatform: { OS: unknown; Version: unknown; constants: unknown } = {
  OS: 'ios',
  Version: '17.5',
  constants: {},
};

// Getter: `jest.mock` is hoisted above the `const`, so the factory must not
// capture `mockPlatform` eagerly.
jest.mock('react-native', () => ({
  get Platform() {
    return mockPlatform;
  },
}));

const CONFIG = { appVersion: '1.2.3' } as RuntimePublicConfig;

const DEFAULT_ITERATIONS = 300;
const DEFAULT_SEED_BASE = 100_000;

interface DeviceRow {
  seed: number;
  os: string;
  constants: string;
  intl: string;
  outcome: 'HELD' | 'BROKEN';
  result: string;
  violations: string[];
}

/** The only two throws the module is allowed to make. */
function isExplicitModuleError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.constructor === Error &&
    (error.message.startsWith(
      'This device did not provide a locale and timezone',
    ) ||
      error.message.startsWith('Unsupported account platform:'))
  );
}

function genLocaleLike(rng: SeededRng): unknown {
  const roll = rng.next();
  if (roll < 0.35)
    return rng.pick(['en-US', 'de-DE', 'ja-JP', 'America/Los_Angeles', 'UTC']);
  if (roll < 0.55) return hostileString(rng);
  if (roll < 0.65) return bigString(rng).value;
  if (roll < 0.72) return rng.pick(TRAVERSAL_STRINGS);
  return wrongTypeValue(rng, { jsonSafe: false });
}

function genConstants(rng: SeededRng, os: unknown): unknown {
  const roll = rng.next();
  if (roll < 0.08) return wrongTypeValue(rng, { jsonSafe: false });
  const constants: Record<string, unknown> = {};
  const maybe = (key: string, value: unknown) => {
    if (rng.chance(0.8)) constants[key] = value;
  };
  if (os === 'android') {
    maybe('Release', edgeOsVersion(rng));
    maybe('Manufacturer', genLocaleLike(rng));
    maybe('Model', genLocaleLike(rng));
  } else {
    maybe('osVersion', edgeOsVersion(rng));
    maybe('systemName', genLocaleLike(rng));
    maybe('interfaceIdiom', genLocaleLike(rng));
  }
  if (rng.chance(0.2)) constants['__proto__'] = { stressPolluted: true };
  return constants;
}

function runDeviceSeed(seed: number): DeviceRow {
  const rng = new SeededRng(seed);
  const os = rng.chance(0.7)
    ? rng.pick(['ios', 'android'])
    : rng.pick([
        'web',
        'windows',
        'macos',
        'IOS',
        'ios\u0000',
        '',
        null,
        undefined,
        42,
      ]);
  const constants = genConstants(rng, os);
  const intl = {
    locale: genLocaleLike(rng),
    timeZone: genLocaleLike(rng),
  };

  mockPlatform.OS = os;
  mockPlatform.Version = edgeOsVersion(rng);
  mockPlatform.constants = constants;
  const spy = jest
    .spyOn(Intl, 'DateTimeFormat')
    .mockImplementation(
      () => ({ resolvedOptions: () => intl }) as unknown as Intl.DateTimeFormat,
    );

  const violations: string[] = [];
  let result: string;
  try {
    const env = getAccountBootstrapEnvironment(CONFIG);
    result = 'ok';
    if (typeof env.locale !== 'string' || !env.locale.trim())
      violations.push('ok-shape:locale');
    if (typeof env.timezone !== 'string' || !env.timezone.trim()) {
      violations.push('ok-shape:timezone');
    }
    if (env.device.platform !== 'ios' && env.device.platform !== 'android') {
      violations.push('ok-shape:platform');
    }
    if (typeof env.device.osVersion !== 'string') {
      violations.push(
        `ok-shape:osVersion-not-string:${typeof env.device.osVersion}`,
      );
    }
    if (typeof env.device.model !== 'string')
      violations.push('ok-shape:model-not-string');
    if (env.device.appVersion !== CONFIG.appVersion)
      violations.push('ok-shape:appVersion');
    if (os !== 'ios' && os !== 'android')
      violations.push(`ok-on-unsupported-os:${digest(os, 20)}`);
  } catch (error) {
    if (isExplicitModuleError(error)) {
      result = 'typed:Error';
    } else {
      const name = error instanceof Error ? error.name : typeof error;
      result = `untyped:${name}`;
      const message = error instanceof Error ? error.message : String(error);
      violations.push(
        `untyped-throw:${name}:${normaliseMessage(message).slice(0, 120)}`,
      );
    }
  } finally {
    spy.mockRestore();
  }
  if (({} as Record<string, unknown>)['stressPolluted'] !== undefined) {
    violations.push('prototype-pollution:Object');
  }
  return {
    seed,
    os: digest(os, 20),
    constants: digest(constants, 120),
    intl: digest(intl, 120),
    outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
    result,
    violations,
  };
}

/**
 * Known-broken classes (one root cause: the module trusts `Platform.*` and
 * `Intl` values without runtime validation), pinned below with
 * `test.failing`; remove once fixed. Untyped throws are matched on their
 * exact V8 message so an unexpected TypeError can never hide behind a known
 * one.
 */
const KNOWN_BROKEN: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  {
    name: 'ok-shape:osVersion-not-string',
    pattern: /^ok-shape:osVersion-not-string:/,
  },
  {
    name: 'untyped-throw:TypeError:<constant>?.trim is not a function',
    pattern:
      /^untyped-throw:TypeError:(Platform\.constants\.(Release|Manufacturer|Model)|resolved\.(locale|timeZone))\?\.trim is not a function$/,
  },
  {
    name: "untyped-throw:TypeError:Cannot read properties of null|undefined (reading '<constant>')",
    pattern:
      /^untyped-throw:TypeError:Cannot read properties of (null|undefined) \(reading '(osVersion|Release|Manufacturer|Model|systemName|interfaceIdiom)'\)$/,
  },
  {
    name: 'untyped-throw:TypeError:Cannot convert <Symbol|null-proto object> to string',
    pattern:
      /^untyped-throw:TypeError:Cannot convert (a Symbol value to a string|object to primitive value)$/,
  },
];

/** Strips the babel interop prefix (`_reactNative.Platform` → `Platform`). */
function normaliseMessage(message: string): string {
  return message.replace(/_[A-Za-z]+\./g, '');
}

function violationClass(v: string): string {
  const known = KNOWN_BROKEN.find(k => k.pattern.test(v));
  if (known) return known.name;
  return v.startsWith('untyped-throw:')
    ? v
    : v.split(':').slice(0, 2).join(':');
}

function isKnownBroken(v: string): boolean {
  return KNOWN_BROKEN.some(k => k.pattern.test(v));
}

describe('stress: deviceContext boundary/malformed runtime constants', () => {
  const replaySeed = readReplaySeed();

  test(
    replaySeed === null
      ? 'every seed returns a string-typed environment or throws one of the two explicit errors'
      : `replay seed ${replaySeed}`,
    () => {
      const seedBase = replaySeed ?? readSeedBase(DEFAULT_SEED_BASE);
      const iterations =
        replaySeed === null ? readIterations(DEFAULT_ITERATIONS) : 1;
      const rows: DeviceRow[] = [];
      for (let i = 0; i < iterations; i += 1)
        rows.push(runDeviceSeed(seedBase + i));
      const broken = rows.filter(r => r.outcome === 'BROKEN');
      const unexpected = broken.filter(r => !r.violations.every(isKnownBroken));
      const byViolation: Record<string, number> = {};
      for (const r of broken) {
        for (const v of r.violations) {
          byViolation[violationClass(v)] =
            (byViolation[violationClass(v)] ?? 0) + 1;
        }
      }
      const dir =
        process.env['STRESS_OUT'] ??
        path.resolve(
          __dirname,
          '../../artifacts/stress/account-boundary-malformed',
        );
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(
        dir,
        replaySeed === null
          ? `deviceContext-${seedBase}-${iterations}.json`
          : `deviceContext-replay-${replaySeed}.json`,
      );
      fs.writeFileSync(
        file,
        JSON.stringify(
          {
            module: 'deviceContext',
            lens: 'boundary-malformed',
            seedBase,
            iterations,
            executed: rows.length,
            held: rows.length - broken.length,
            broken: broken.length,
            brokenSeeds: broken.map(r => r.seed),
            byViolation,
            knownBrokenClasses: KNOWN_BROKEN.map(k => k.name),
            rows,
          },
          null,
          2,
        ),
      );
      console.log(
        `[stress:deviceContext] executed=${rows.length} held=${rows.length - broken.length} ` +
          `broken=${broken.length} unexpected=${unexpected.length} table=${file}`,
      );
      if (replaySeed !== null) {
        console.log(JSON.stringify(rows[0], null, 2));
      }
      expect(rows.length).toBe(iterations);
      expect(
        unexpected.map(r => ({ seed: r.seed, violations: r.violations })),
      ).toEqual([]);
    },
    10 * 60 * 1000,
  );

  test('a seed replays to an identical row', () => {
    for (const seed of [100_007, 123_456]) {
      expect(runDeviceSeed(seed)).toEqual(runDeviceSeed(seed));
    }
  });
});

describe('stress: pinned deviceContext failures (test.failing = currently broken)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.failing(
    'ios: a missing Platform.constants.osVersion must not yield osVersion: undefined',
    () => {
      mockPlatform.OS = 'ios';
      mockPlatform.constants = { systemName: 'iOS', interfaceIdiom: 'phone' };
      jest.spyOn(Intl, 'DateTimeFormat').mockImplementation(
        () =>
          ({
            resolvedOptions: () => ({ locale: 'en-US', timeZone: 'UTC' }),
          }) as unknown as Intl.DateTimeFormat,
      );
      const env = getAccountBootstrapEnvironment(CONFIG);
      expect(typeof env.device.osVersion).toBe('string');
    },
  );

  test.failing(
    'a non-string Intl locale must throw the explicit module error, not TypeError',
    () => {
      mockPlatform.OS = 'ios';
      mockPlatform.constants = {
        osVersion: '18.0',
        systemName: 'iOS',
        interfaceIdiom: 'phone',
      };
      jest.spyOn(Intl, 'DateTimeFormat').mockImplementation(
        () =>
          ({
            resolvedOptions: () => ({ locale: 42, timeZone: 'UTC' }),
          }) as unknown as Intl.DateTimeFormat,
      );
      let error: unknown = null;
      try {
        getAccountBootstrapEnvironment(CONFIG);
      } catch (e) {
        error = e;
      }
      expect(error).not.toBeNull();
      expect(isExplicitModuleError(error)).toBe(true);
    },
  );

  test.failing(
    'ios: a non-object Platform.constants must throw the explicit module error, not TypeError',
    () => {
      mockPlatform.OS = 'ios';
      mockPlatform.constants = undefined;
      jest.spyOn(Intl, 'DateTimeFormat').mockImplementation(
        () =>
          ({
            resolvedOptions: () => ({ locale: 'en-US', timeZone: 'UTC' }),
          }) as unknown as Intl.DateTimeFormat,
      );
      let error: unknown = null;
      try {
        getAccountBootstrapEnvironment(CONFIG);
      } catch (e) {
        error = e;
      }
      expect(error).not.toBeNull();
      expect(isExplicitModuleError(error)).toBe(true);
    },
  );
});
