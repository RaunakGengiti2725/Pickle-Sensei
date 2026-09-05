/**
 * STRESS (seeded randomized long-run) — `src/account/deviceContext.ts`.
 *
 * `getAccountBootstrapEnvironment` is a pure function of three runtime
 * sources: `Platform` (OS + constants), `Intl.DateTimeFormat().resolvedOptions()`
 * and the runtime public config. This campaign drives random sequences of
 * mutations to those sources — iOS / Android / unsupported OS values, blank,
 * padded, missing and unicode constants, blank/missing locale or time zone,
 * random app versions — and calls the builder after each mutation.
 *
 * Under jest `react-native` is a controllable stand-in; nothing here is a
 * statement about a real iPhone (that is Mac-runner evidence). What IS
 * pinned is the module's contract on the values the runtime hands it:
 *   V1  ios / android with a usable locale+time zone → an environment whose
 *       `device.platform` is that OS, whose `appVersion` is EXACTLY the
 *       config's (never a constant), whose `locale`/`timezone` are the
 *       trimmed Intl values, and whose `osVersion`/`model` are built ONLY
 *       from the OS-provided constants (Android: trimmed
 *       Manufacturer+Model, Release or String(Version); iOS: osVersion,
 *       systemName+interfaceIdiom) — never a guessed handset identifier
 *   V2  a blank/missing locale or time zone → throws 'This device did not
 *       provide a locale and timezone for account setup.' before any
 *       platform branch runs
 *   V3  any other OS (web, macos, windows, native, '') → throws
 *       'Unsupported account platform: <os>'
 *   V4  the config object is never mutated, and the call is pure: the same
 *       inputs twice give byte-identical output
 *   V5  determinism: the same seed replays to an identical trace
 *
 * Replay one seed:  STRESS_ONLY_SEED=<seed> npx jest __tests__/stress/deviceContextRandomized
 * Long campaign:    STRESS_ITER=2500 npx jest __tests__/stress/deviceContextRandomized
 */
import type { RuntimePublicConfig } from '../../src/config/runtimeConfig';
import { getRuntimePublicConfig } from '../../src/config/runtimeConfig';
import { getAccountBootstrapEnvironment } from '../../src/account/deviceContext';
import {
  campaignConfig,
  describeFailures,
  runCampaign,
  stable,
  type Rng,
  type SequenceSpec,
} from '../../test-support/stress/seededCampaign';

interface MutablePlatform {
  OS: string;
  Version: number | string;
  constants: Record<string, unknown>;
}

jest.mock('react-native', () => {
  const platform: MutablePlatform = {
    OS: 'ios',
    Version: '18.5',
    constants: {},
  };
  return { Platform: platform, __platform: platform };
});

const platform = (
  jest.requireMock('react-native') as { __platform: MutablePlatform }
).__platform;

const MSG_LOCALE =
  'This device did not provide a locale and timezone for account setup.';

const OTHER_OS = ['web', 'macos', 'windows', 'native', '', 'iOS', 'Android'];
const LOCALES = [
  'en-US',
  'en-GB',
  'es-MX',
  'ja-JP',
  'de-DE',
  'pt-BR',
  'hi-IN',
  'zh-Hant-TW',
];
const TIME_ZONES = [
  'America/Los_Angeles',
  'America/New_York',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Australia/Sydney',
  'UTC',
  'Etc/GMT+5',
];
const APP_VERSIONS = ['1.0', '1.0.1', '1.2', '2.0.0-beta.1', '0.9', '10.20.30'];

type Padding = 'none' | 'padded' | 'blank' | 'missing';

interface IntlState {
  locale: string | undefined;
  timeZone: string | undefined;
}

type Action =
  | { kind: 'setOs'; os: string }
  | {
      kind: 'setIosConstants';
      osVersion: string;
      systemName: string | undefined;
      interfaceIdiom: string | undefined;
    }
  | {
      kind: 'setAndroidConstants';
      manufacturer: string | undefined;
      model: string | undefined;
      release: string | undefined;
      version: number;
    }
  | { kind: 'setIntl'; intl: IntlState }
  | { kind: 'setConfig'; appVersion: string }
  | { kind: 'build' };

const TEXT_ALPHABET =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.()/éñ日本語🏓';

function randomText(rng: Rng, min: number, max: number): string {
  const length = rng.int(min, max);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += TEXT_ALPHABET[rng.int(0, TEXT_ALPHABET.length - 1)];
  }
  return out;
}

function decorate(rng: Rng, value: string): string | undefined {
  const padding = rng.weighted<Padding>([
    ['none', 6],
    ['padded', 2],
    ['blank', 1],
    ['missing', 1],
  ]);
  switch (padding) {
    case 'none':
      return value;
    case 'padded':
      return `${rng.pick(['', ' ', '\t', '  '])}${value}${rng.pick(['', ' ', '\n', '  '])}`;
    case 'blank':
      return rng.pick(['', ' ', '\t\t', '   ']);
    case 'missing':
      return undefined;
  }
}

function generate(rng: Rng, length: number): Action[] {
  const actions: Action[] = [];
  for (let i = 0; i < length; i += 1) {
    const kind = rng.weighted([
      ['setOs', 15],
      ['setIosConstants', 12],
      ['setAndroidConstants', 12],
      ['setIntl', 15],
      ['setConfig', 6],
      ['build', 40],
    ] as const);
    switch (kind) {
      case 'setOs':
        actions.push({
          kind,
          os: rng.weighted([
            ['ios', 5],
            ['android', 3],
            [rng.pick(OTHER_OS), 2],
          ] as const),
        });
        break;
      case 'setIosConstants':
        actions.push({
          kind,
          osVersion: rng.chance(0.85)
            ? `${rng.int(15, 26)}.${rng.int(0, 7)}${rng.chance(0.3) ? `.${rng.int(1, 3)}` : ''}`
            : (decorate(rng, randomText(rng, 1, 8)) ?? ''),
          systemName: decorate(
            rng,
            rng.pick(['iOS', 'iPadOS', randomText(rng, 1, 12)]),
          ),
          interfaceIdiom: decorate(
            rng,
            rng.pick(['phone', 'pad', 'mac', randomText(rng, 1, 10)]),
          ),
        });
        break;
      case 'setAndroidConstants':
        actions.push({
          kind,
          manufacturer: decorate(
            rng,
            rng.pick(['Google', 'Samsung', 'OnePlus', randomText(rng, 1, 12)]),
          ),
          model: decorate(
            rng,
            rng.pick(['Pixel 8', 'SM-S928B', randomText(rng, 1, 12)]),
          ),
          release: decorate(rng, `${rng.int(10, 16)}`),
          version: rng.int(29, 36),
        });
        break;
      case 'setIntl':
        actions.push({
          kind,
          intl: {
            locale: decorate(rng, rng.pick(LOCALES)),
            timeZone: decorate(rng, rng.pick(TIME_ZONES)),
          },
        });
        break;
      case 'setConfig':
        actions.push({
          kind,
          appVersion: rng.chance(0.7)
            ? rng.pick(APP_VERSIONS)
            : randomText(rng, 1, 12),
        });
        break;
      case 'build':
        actions.push({ kind });
        break;
    }
  }
  return actions;
}

function describeAction(action: Action): string {
  switch (action.kind) {
    case 'build':
      return 'build';
    case 'setOs':
      return `setOs(${JSON.stringify(action.os)})`;
    default:
      return `${action.kind}(${stable(action)})`;
  }
}

function coverageKey(action: Action): string {
  return action.kind === 'setOs' ? `setOs:${action.os}` : action.kind;
}

// ─── Oracle ──────────────────────────────────────────────────────────────────

interface World {
  intl: IntlState;
  ios: {
    osVersion: string;
    systemName: string | undefined;
    interfaceIdiom: string | undefined;
  };
  android: {
    manufacturer: string | undefined;
    model: string | undefined;
    release: string | undefined;
    version: number;
  };
  config: RuntimePublicConfig;
}

type Expected =
  | { outcome: 'resolved'; value: unknown }
  | { outcome: 'error'; message: string };

function oracle(world: World): Expected {
  const locale = world.intl.locale?.trim();
  const timezone = world.intl.timeZone?.trim();
  if (!locale || !timezone) return { outcome: 'error', message: MSG_LOCALE };
  if (platform.OS === 'android') {
    const manufacturer = world.android.manufacturer?.trim();
    const model = world.android.model?.trim();
    return {
      outcome: 'resolved',
      value: {
        locale,
        timezone,
        device: {
          platform: 'android',
          osVersion:
            world.android.release?.trim() || String(world.android.version),
          appVersion: world.config.appVersion,
          model: [manufacturer, model].filter(Boolean).join(' '),
        },
      },
    };
  }
  if (platform.OS === 'ios') {
    return {
      outcome: 'resolved',
      value: {
        locale,
        timezone,
        device: {
          platform: 'ios',
          osVersion: world.ios.osVersion,
          appVersion: world.config.appVersion,
          model: [world.ios.systemName, world.ios.interfaceIdiom]
            .filter(Boolean)
            .join(' '),
        },
      },
    };
  }
  return {
    outcome: 'error',
    message: `Unsupported account platform: ${platform.OS}`,
  };
}

function applyPlatformConstants(world: World): void {
  if (platform.OS === 'android') {
    platform.Version = world.android.version;
    platform.constants = {
      isTesting: true,
      reactNativeVersion: { major: 0, minor: 87, patch: 0 },
      Version: world.android.version,
      ...(world.android.release !== undefined
        ? { Release: world.android.release }
        : {}),
      ...(world.android.manufacturer !== undefined
        ? { Manufacturer: world.android.manufacturer }
        : {}),
      ...(world.android.model !== undefined
        ? { Model: world.android.model }
        : {}),
      Brand: 'stress',
      Serial: 'unknown',
      Fingerprint: 'stress/fingerprint',
      uiMode: 'normal',
    };
  } else {
    platform.Version = world.ios.osVersion;
    platform.constants = {
      isTesting: true,
      reactNativeVersion: { major: 0, minor: 87, patch: 0 },
      forceTouchAvailable: false,
      osVersion: world.ios.osVersion,
      ...(world.ios.systemName !== undefined
        ? { systemName: world.ios.systemName }
        : {}),
      ...(world.ios.interfaceIdiom !== undefined
        ? { interfaceIdiom: world.ios.interfaceIdiom }
        : {}),
    };
  }
}

const realDateTimeFormat = Intl.DateTimeFormat;

function installIntl(intl: IntlState): void {
  const fake = function DateTimeFormat(): Intl.DateTimeFormat {
    return {
      resolvedOptions: () =>
        ({
          locale: intl.locale,
          timeZone: intl.timeZone,
          calendar: 'gregory',
          numberingSystem: 'latn',
        }) as unknown as Intl.ResolvedDateTimeFormatOptions,
    } as unknown as Intl.DateTimeFormat;
  };
  (Intl as { DateTimeFormat: unknown }).DateTimeFormat = fake;
}

function describeResult(
  result:
    | { outcome: 'resolved'; value: unknown }
    | { outcome: 'error'; error: unknown },
): unknown {
  if (result.outcome === 'resolved') return result;
  const error = result.error;
  return {
    outcome: 'error',
    name: error instanceof Error ? error.name : 'non-error',
    message: error instanceof Error ? error.message : String(error),
  };
}

function build(
  config: RuntimePublicConfig,
):
  | { outcome: 'resolved'; value: unknown }
  | { outcome: 'error'; error: unknown } {
  try {
    return {
      outcome: 'resolved',
      value: getAccountBootstrapEnvironment(config),
    };
  } catch (error) {
    return { outcome: 'error', error };
  }
}

async function execute(
  actions: Action[],
  rng: Rng,
  _seed: number,
): Promise<{
  trace: { step: number; action: string; outcome: string }[];
  violation: { step: number; message: string } | null;
}> {
  const trace: { step: number; action: string; outcome: string }[] = [];
  const violations: { step: number; message: string }[] = [];
  const fail = (step: number, message: string): void => {
    if (violations.length === 0) violations.push({ step, message });
  };
  const baseConfig = getRuntimePublicConfig();
  const world: World = {
    intl: { locale: rng.pick(LOCALES), timeZone: rng.pick(TIME_ZONES) },
    ios: {
      osVersion: `${rng.int(16, 19)}.${rng.int(0, 6)}`,
      systemName: 'iOS',
      interfaceIdiom: 'phone',
    },
    android: {
      manufacturer: 'Google',
      model: 'Pixel 8',
      release: '14',
      version: 34,
    },
    config: { ...baseConfig },
  };
  platform.OS = rng.pick(['ios', 'android']);
  applyPlatformConstants(world);
  installIntl(world.intl);

  try {
    for (const [step, action] of actions.entries()) {
      let outcome: unknown;
      switch (action.kind) {
        case 'setOs':
          platform.OS = action.os;
          applyPlatformConstants(world);
          outcome = { outcome: 'set' };
          break;
        case 'setIosConstants':
          world.ios = {
            osVersion: action.osVersion,
            systemName: action.systemName,
            interfaceIdiom: action.interfaceIdiom,
          };
          applyPlatformConstants(world);
          outcome = { outcome: 'set' };
          break;
        case 'setAndroidConstants':
          world.android = {
            manufacturer: action.manufacturer,
            model: action.model,
            release: action.release,
            version: action.version,
          };
          applyPlatformConstants(world);
          outcome = { outcome: 'set' };
          break;
        case 'setIntl':
          world.intl = { ...action.intl };
          installIntl(world.intl);
          outcome = { outcome: 'set' };
          break;
        case 'setConfig':
          world.config = { ...baseConfig, appVersion: action.appVersion };
          outcome = { outcome: 'set' };
          break;
        case 'build': {
          const configBefore = stable(world.config);
          const first = build(world.config);
          const second = build(world.config);
          outcome = describeResult(first);
          const expected = oracle(world);
          const expectedOutcome =
            expected.outcome === 'resolved'
              ? expected
              : { outcome: 'error', name: 'Error', message: expected.message };
          if (stable(outcome) !== stable(expectedOutcome)) {
            fail(
              step,
              `V1/V2/V3 ${stable(outcome)} ≠ expected ${stable(expectedOutcome)}`,
            );
          }
          if (stable(describeResult(second)) !== stable(outcome)) {
            fail(step, 'V4 two identical calls differed');
          }
          if (stable(world.config) !== configBefore)
            fail(step, 'V4 config mutated');
          if (first.outcome === 'resolved') {
            const env = first.value as {
              locale: string;
              timezone: string;
              device: {
                platform: string;
                osVersion: string;
                appVersion: string;
                model: string;
              };
            };
            if (env.device.appVersion !== world.config.appVersion) {
              fail(
                step,
                `V1 appVersion ${env.device.appVersion} is not the runtime config's ${world.config.appVersion}`,
              );
            }
            if (
              env.locale !== env.locale.trim() ||
              !env.locale ||
              env.timezone !== env.timezone.trim() ||
              !env.timezone
            ) {
              fail(
                step,
                `V1 untrimmed/blank locale or timezone ${stable({ l: env.locale, t: env.timezone })}`,
              );
            }
            if (env.device.platform !== platform.OS)
              fail(step, `V1 platform ${env.device.platform} ≠ ${platform.OS}`);
            if (/iPhone\d|iPad\d|,\d/.test(env.device.model)) {
              fail(
                step,
                `V1 model looks like a guessed hardware identifier: ${env.device.model}`,
              );
            }
            for (const [k, v] of Object.entries(env.device)) {
              if (typeof v !== 'string')
                fail(step, `V1 device.${k} is ${typeof v}`);
            }
          }
          break;
        }
      }
      trace.push({
        step,
        action: describeAction(action),
        outcome: stable(outcome),
      });
      if (violations.length > 0) break;
    }
  } finally {
    (Intl as { DateTimeFormat: unknown }).DateTimeFormat = realDateTimeFormat;
  }
  return { trace, violation: violations[0] ?? null };
}

const spec: SequenceSpec<Action> = {
  generate,
  execute,
  describeAction,
  coverageKey,
};

describe('STRESS device context — seeded randomized runtime mutations', () => {
  afterEach(() => {
    (Intl as { DateTimeFormat: unknown }).DateTimeFormat = realDateTimeFormat;
  });

  it(
    'holds V1–V5 on every seeded sequence (see STRESS_* knobs)',
    async () => {
      const config = campaignConfig();
      const output = await runCampaign(
        'device-context-randomized',
        spec,
        config,
      );
      expect(describeFailures(output)).toBe('');
      expect(output.summary.sequencesExecuted).toBe(
        config.onlySeeds?.length ?? config.iterations,
      );
      expect(output.summary.nonDeterministicSeeds).toEqual([]);
    },
    20 * 60_000,
  );
});
