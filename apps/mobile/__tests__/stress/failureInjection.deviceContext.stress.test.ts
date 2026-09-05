/**
 * STRESS — failure injection, device context + post-deletion cleanup.
 *
 * Unit: `src/account/deviceContext.ts` plus the two authStore paths that
 * consume the module's dependencies natively: `signInWithApple` (device
 * context → bootstrap) and `completeAccountDeletion` (Keychain + SQLite +
 * provider SDK after a server-confirmed deletion).
 *
 * Seams (all Jest-level; NONE of this is Apple runtime truth):
 *   - clock/locale:  `Intl.DateTimeFormat` spied to return empty / missing /
 *                    whitespace locale+timezone, throw, or return null.
 *   - platform:      `Platform.OS` / `Platform.__constants` replaced with
 *                    ios / android / unsupported values and partial constants.
 *   - Keychain:      the repo's `__mocks__/react-native-keychain.ts` auto-mock,
 *                    with `resetGenericPassword` spied to throw / reject /
 *                    return false / never resolve.
 *   - SQLite:        `src/data/db.getDb` mocked to an in-memory LocalDb whose
 *                    `execute` can throw on open, on a chosen DELETE, on kv
 *                    writes, run slow, or never resolve.
 *   - provider SDK:  `@react-native-google-signin/google-signin` mocked with
 *                    `revokeAccess`/`signOut` reject / hang.
 *   - native auth:   `NativeModules.PickleAuth.signInWithApple` resolve /
 *                    reject / hang.
 *
 * Invariants:
 *   - device context NEVER invents a descriptor: bad locale/timezone or an
 *     unsupported platform throws; valid input is trimmed and carries the
 *     configured appVersion.
 *   - sign-in with a broken device context ends with busy=false, a visible
 *     error message, no session, no bootstrap request, empty Keychain.
 *   - completeAccountDeletion: the session is dropped synchronously, the
 *     promise settles (Keychain/SQLite failures are fail-soft), the local
 *     purge is transactional (ROLLBACK on failure, never a COMMIT after a
 *     failed DELETE) and its outcome is reported honestly in
 *     `deletionCleanup.localPurge` ('complete' only when every owner table +
 *     kv namespace was deleted in one committed transaction).
 *
 * Replay: STRESS_SEED=<seed> STRESS_RUN_ID=x npx jest --ci __tests__/stress/failureInjection.deviceContext
 */
import { NativeModules, Platform } from 'react-native';
import * as Keychain from 'react-native-keychain';
import type { LocalDb } from '../../src/data/db';
import type { RuntimePublicConfig } from '../../src/config/runtimeConfig';
import { getAccountBootstrapEnvironment } from '../../src/account/deviceContext';
import { useAuthStore } from '../../src/auth/authStore';
import { clearApiSession, getApiSession } from '../../src/account/apiSession';
import { SESSION_VAULT_SERVICE } from '../../src/account/sessionVault';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import {
  pick,
  probe,
  recordIteration,
  scenarioCases,
  seededRandom,
  type Rng,
} from '../../testing/stress/harness';

const SUITE = 'deviceContext';

// ─── Module seams ────────────────────────────────────────────────────────────

interface DbFault {
  kind:
    | 'ok'
    | 'open_throw'
    | 'kv_write_throw'
    | 'delete_throw'
    | 'delete_throw_first_n'
    | 'slow'
    | 'hang'
    | 'begin_throw';
  /** delete_throw: which owner-scoped DELETE statement (0..10) fails. */
  deleteIndex?: number;
  /** delete_throw_first_n: number of purge attempts that fail before success. */
  failAttempts?: number;
  delayMs?: number;
}

const mockKv = new Map<string, string>();
const mockSqlLog: string[] = [];
let mockDbFault: DbFault = { kind: 'ok' };
let mockDeleteCounter = 0;
let mockAttemptCounter = 0;

function mockCurrentDb(): LocalDb {
  if (mockDbFault.kind === 'open_throw')
    throw new Error('sqlite: cannot open database');
  return {
    async execute(sql: string, params: unknown[] = []) {
      const statement = sql.trim().replace(/\s+/g, ' ');
      mockSqlLog.push(statement);
      if (mockDbFault.kind === 'hang') return new Promise(() => {});
      if (mockDbFault.kind === 'slow') {
        await new Promise(resolve =>
          setTimeout(resolve, mockDbFault.delayMs ?? 0),
        );
      }
      if (statement === 'BEGIN IMMEDIATE') {
        mockAttemptCounter += 1;
        mockDeleteCounter = 0;
        if (mockDbFault.kind === 'begin_throw')
          throw new Error('sqlite: database is locked');
        return { rows: [] };
      }
      if (statement.startsWith('SELECT value FROM kv')) {
        const value = mockKv.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
        if (mockDbFault.kind === 'kv_write_throw')
          throw new Error('sqlite: disk I/O error');
        mockKv.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      if (statement.startsWith('DELETE FROM')) {
        const index = mockDeleteCounter;
        mockDeleteCounter += 1;
        if (
          mockDbFault.kind === 'delete_throw' &&
          index === (mockDbFault.deleteIndex ?? 0)
        ) {
          throw new Error(`sqlite: DELETE #${index} failed`);
        }
        if (
          mockDbFault.kind === 'delete_throw_first_n' &&
          mockAttemptCounter <= (mockDbFault.failAttempts ?? 0) &&
          index === (mockDbFault.deleteIndex ?? 0)
        ) {
          throw new Error(
            `sqlite: transient DELETE failure (attempt ${mockAttemptCounter})`,
          );
        }
        if (statement.startsWith('DELETE FROM kv'))
          mockKv.delete(String(params[0]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  };
}
jest.mock('../../src/data/db', () => ({ getDb: () => mockCurrentDb() }));

const mockGoogleSignin = {
  configure: jest.fn(),
  hasPlayServices: jest.fn(),
  signIn: jest.fn(),
  signInSilently: jest.fn(),
  hasPreviousSignIn: jest.fn(),
  signOut: jest.fn(),
  revokeAccess: jest.fn(),
};
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: mockGoogleSignin,
}));

jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: 'test-web-client.apps.googleusercontent.com',
  GOOGLE_IOS_CLIENT_ID: 'test-ios-client.apps.googleusercontent.com',
}));

const CONFIG: RuntimePublicConfig = {
  apiBaseUrl: 'https://api.example.test',
  revenueCatPublicSdkKey: null,
  googleIosClientId: 'test-ios-client.apps.googleusercontent.com',
  googleWebClientId: 'test-web-client.apps.googleusercontent.com',
  appVersion: '1.4.2',
  legalPrivacyUrl: null,
  legalTermsUrl: null,
  appStoreId: null,
} as RuntimePublicConfig;
jest.mock('../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => CONFIG,
}));

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};
const nativeModules = NativeModules as { PickleAuth?: unknown };
const platformMutable = Platform as unknown as {
  __constants: unknown;
  OS: string;
};
const realFetch = globalThis.fetch;
const CANONICAL_ID = '7fc2c743-028f-4ec6-942c-a84508f3be38';

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockKv.clear();
  mockSqlLog.length = 0;
  mockDbFault = { kind: 'ok' };
  mockDeleteCounter = 0;
  mockAttemptCounter = 0;
  __keychainStore.clear();
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    hydrated: true,
    session: null,
    busy: false,
    error: null,
    deletionCleanup: null,
  });
  mockGoogleSignin.revokeAccess.mockResolvedValue(null);
  mockGoogleSignin.signOut.mockResolvedValue(null);
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  platformMutable.__constants = null;
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  delete nativeModules.PickleAuth;
  globalThis.fetch = realFetch;
});

// ─── Fault catalogs ──────────────────────────────────────────────────────────

interface IntlFault {
  id: string;
  realistic: boolean;
  /** Whether the module MUST throw for this input. */
  mustThrow: boolean;
  locale?: unknown;
  timeZone?: unknown;
  behaviour: 'values' | 'resolved_throws' | 'ctor_throws' | 'resolved_null';
}

const LOCALES = ['en-US', 'de-DE', 'ja-JP', 'pt-BR', 'en-GB'];
const ZONES = [
  'America/Los_Angeles',
  'Europe/Berlin',
  'Asia/Tokyo',
  'UTC',
  'Australia/Sydney',
];
const PADS = ['', ' ', '\t', '\n  '];

function pad(rng: Rng, value: string): string {
  return `${pick(rng, PADS)}${value}${pick(rng, PADS)}`;
}

function drawIntlFault(rng: Rng): IntlFault {
  const roll = rng();
  if (roll < 0.25) {
    return {
      id: 'intl:valid_padded',
      realistic: true,
      mustThrow: false,
      locale: pad(rng, pick(rng, LOCALES)),
      timeZone: pad(rng, pick(rng, ZONES)),
      behaviour: 'values',
    };
  }
  if (roll < 0.4) {
    const which = pick(rng, ['locale', 'timeZone', 'both'] as const);
    const bad = pick(rng, ['', '   ', undefined, '\t'] as const);
    return {
      id: `intl:${which}_${bad === undefined ? 'undefined' : bad === '' ? 'empty' : 'whitespace'}`,
      realistic: true,
      mustThrow: true,
      locale: which === 'timeZone' ? pick(rng, LOCALES) : bad,
      timeZone: which === 'locale' ? pick(rng, ZONES) : bad,
      behaviour: 'values',
    };
  }
  if (roll < 0.55) {
    const which = pick(rng, ['locale', 'timeZone'] as const);
    const bad = pick(rng, [null, 42, {}, []] as const);
    return {
      id: `intl:${which}_${Array.isArray(bad) ? 'array' : bad === null ? 'null' : typeof bad}`,
      realistic: false,
      mustThrow: true,
      locale: which === 'locale' ? bad : pick(rng, LOCALES),
      timeZone: which === 'timeZone' ? bad : pick(rng, ZONES),
      behaviour: 'values',
    };
  }
  if (roll < 0.7)
    return {
      id: 'intl:resolvedOptions_throws',
      realistic: false,
      mustThrow: true,
      behaviour: 'resolved_throws',
    };
  if (roll < 0.85)
    return {
      id: 'intl:DateTimeFormat_throws',
      realistic: false,
      mustThrow: true,
      behaviour: 'ctor_throws',
    };
  return {
    id: 'intl:resolvedOptions_null',
    realistic: false,
    mustThrow: true,
    behaviour: 'resolved_null',
  };
}

function installIntl(fault: IntlFault): void {
  jest.spyOn(Intl, 'DateTimeFormat').mockImplementation((() => {
    if (fault.behaviour === 'ctor_throws')
      throw new RangeError('Incorrect locale information provided');
    return {
      resolvedOptions() {
        if (fault.behaviour === 'resolved_throws')
          throw new TypeError('resolvedOptions unavailable');
        if (fault.behaviour === 'resolved_null') return null;
        return { locale: fault.locale, timeZone: fault.timeZone };
      },
    };
  }) as unknown as typeof Intl.DateTimeFormat);
}

interface PlatformFault {
  id: string;
  os: string;
  realistic: boolean;
  constants: Record<string, unknown>;
  version: number | string;
}

function drawPlatformFault(rng: Rng): PlatformFault {
  const roll = rng();
  if (roll < 0.4) {
    const full = rng() < 0.6;
    const constants: Record<string, unknown> = full
      ? {
          osVersion: pick(rng, ['18.5', '17.0.1', '26.0']),
          systemName: 'iOS',
          interfaceIdiom: pick(rng, ['phone', 'pad']),
        }
      : {
          osVersion: pick(rng, ['18.5', undefined, '']),
          systemName: pick(rng, ['iOS', undefined]),
          interfaceIdiom: pick(rng, ['phone', undefined]),
        };
    return {
      id: full ? 'platform:ios' : 'platform:ios_partial_constants',
      os: 'ios',
      realistic: full,
      constants,
      version: constants['osVersion'] as string,
    };
  }
  if (roll < 0.7) {
    const full = rng() < 0.6;
    const constants: Record<string, unknown> = full
      ? { Manufacturer: 'Google', Model: 'Pixel 8', Release: '14' }
      : {
          Manufacturer: pick(rng, ['Google', undefined, ' ']),
          Model: pick(rng, ['Pixel 8', undefined, '']),
          Release: pick(rng, ['14', undefined, '']),
        };
    return {
      id: full ? 'platform:android' : 'platform:android_partial_constants',
      os: 'android',
      realistic: full,
      constants,
      version: 34,
    };
  }
  const os = pick(rng, ['web', 'windows', 'macos', '', 'harmony']);
  return {
    id: `platform:unsupported_${os || 'empty'}`,
    os,
    realistic: false,
    constants: {},
    version: 0,
  };
}

function installPlatform(fault: PlatformFault): void {
  jest.replaceProperty(platformMutable, 'OS', fault.os);
  platformMutable.__constants = fault.constants;
  jest
    .spyOn(
      Platform as unknown as { Version: number | string },
      'Version',
      'get',
    )
    .mockReturnValue(fault.version);
}

function looksInvented(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /^(undefined|null|NaN|\[object Object\])$/.test(value.trim())
  );
}

// ─── Scenario 1: device context under locale/timezone faults ─────────────────

describe('deviceContext.intl — locale/timezone faults never yield an invented descriptor', () => {
  const scenario = 'deviceContext.intl';
  scenarioCases(scenario).forEach(([seed, iteration]) => {
    it(`seed ${seed} (iteration ${iteration}) throws or returns trimmed truth`, async () => {
      const rng = seededRandom(seed);
      const intl = drawIntlFault(rng);
      const platform = pick(rng, [
        {
          id: 'platform:ios',
          os: 'ios',
          realistic: true,
          constants: {
            osVersion: '18.5',
            systemName: 'iOS',
            interfaceIdiom: 'phone',
          },
          version: '18.5',
        },
        {
          id: 'platform:android',
          os: 'android',
          realistic: true,
          constants: {
            Manufacturer: 'Google',
            Model: 'Pixel 8',
            Release: '14',
          },
          version: 34,
        },
      ] as PlatformFault[]);
      await recordIteration(
        {
          suite: SUITE,
          scenario,
          seed,
          iteration,
          fault: intl.id,
          inputs: { intl, platform: platform.id },
        },
        async () => {
          installIntl(intl);
          installPlatform(platform);
          let result: unknown = null;
          let error: unknown = null;
          try {
            result = getAccountBootstrapEnvironment(CONFIG);
          } catch (caught) {
            error = caught;
          }
          const observed = {
            threw: error !== null,
            message:
              error instanceof Error
                ? error.message
                : error === null
                  ? null
                  : String(error),
            result,
          };
          if (intl.mustThrow) {
            expect(result).toBeNull();
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message.length).toBeGreaterThan(0);
            if (intl.realistic) {
              expect((error as Error).message).toBe(
                'This device did not provide a locale and timezone for account setup.',
              );
            }
          } else {
            expect(error).toBeNull();
            const env = result as {
              locale: string;
              timezone: string;
              device: { platform: string; appVersion: string };
            };
            expect(env.locale).toBe(String(intl.locale).trim());
            expect(env.timezone).toBe(String(intl.timeZone).trim());
            expect(env.device.platform).toBe(platform.os);
            expect(env.device.appVersion).toBe(CONFIG.appVersion);
          }
          return {
            observed: { ...observed, faultRealistic: intl.realistic },
            classification: 'HELD',
          };
        },
      );
    });
  });
});

// ─── Scenario 2: device context under platform faults ────────────────────────

describe('deviceContext.platform — unsupported platforms throw; partial constants never fabricate', () => {
  const scenario = 'deviceContext.platform';
  scenarioCases(scenario).forEach(([seed, iteration]) => {
    it(`seed ${seed} (iteration ${iteration}) matches the platform contract`, async () => {
      const rng = seededRandom(seed);
      const platform = drawPlatformFault(rng);
      const locale = pick(rng, LOCALES);
      const timeZone = pick(rng, ZONES);
      await recordIteration(
        {
          suite: SUITE,
          scenario,
          seed,
          iteration,
          fault: platform.id,
          inputs: { platform, locale, timeZone },
        },
        async () => {
          installIntl({
            id: 'intl:valid',
            realistic: true,
            mustThrow: false,
            locale,
            timeZone,
            behaviour: 'values',
          });
          installPlatform(platform);
          let result: ReturnType<typeof getAccountBootstrapEnvironment> | null =
            null;
          let error: unknown = null;
          try {
            result = getAccountBootstrapEnvironment(CONFIG);
          } catch (caught) {
            error = caught;
          }
          const observed: Record<string, unknown> = {
            threw: error !== null,
            message: error instanceof Error ? error.message : null,
            device: result?.device ?? null,
          };
          if (platform.os !== 'ios' && platform.os !== 'android') {
            expect(result).toBeNull();
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).toBe(
              `Unsupported account platform: ${platform.os}`,
            );
            return { observed };
          }
          expect(error).toBeNull();
          const device = result!.device;
          expect(device.platform).toBe(platform.os);
          expect(device.appVersion).toBe(CONFIG.appVersion);
          expect(result!.locale).toBe(locale);
          expect(result!.timezone).toBe(timeZone);
          // Never a stringified hole.
          expect(looksInvented(device.model)).toBe(false);
          expect(looksInvented(device.osVersion)).toBe(false);
          expect(device.model).toBe(device.model.trim());
          const wellFormed =
            typeof device.osVersion === 'string' && device.osVersion.length > 0;
          observed['osVersionWellFormed'] = wellFormed;
          if (platform.realistic) {
            expect(wellFormed).toBe(true);
            expect(device.model.length).toBeGreaterThan(0);
            return { observed };
          }
          // Partial constants (outside React Native's contract): the module
          // passes through whatever the OS bridge gave it — recorded, not
          // asserted, as long as nothing was fabricated.
          return { observed, classification: 'KNOWN_LIMIT' };
        },
      );
    });
  });
});

// ─── Scenario 3: sign-in consumer with a broken device context / native auth ─

type NativeAuthFault = 'ok' | 'reject_error' | 'reject_nonerror' | 'hang';

describe('deviceContext.signIn — Apple sign-in with broken device context or native auth', () => {
  const scenario = 'deviceContext.signIn';
  scenarioCases(scenario).forEach(([seed, iteration]) => {
    it(`seed ${seed} (iteration ${iteration}) ends with busy=false, visible error, no session`, async () => {
      const rng = seededRandom(seed);
      const native = pick(rng, [
        'ok',
        'ok',
        'reject_error',
        'reject_nonerror',
        'hang',
      ] as NativeAuthFault[]);
      const intl = native === 'ok' ? drawIntlFault(rng) : null;
      const platform =
        native === 'ok' && intl !== null && !intl.mustThrow
          ? drawPlatformFault(rng)
          : null;
      const faultId =
        native !== 'ok'
          ? `nativeAuth:${native}`
          : intl!.mustThrow
            ? intl!.id
            : platform!.id;
      await recordIteration(
        {
          suite: SUITE,
          scenario,
          seed,
          iteration,
          fault: faultId,
          inputs: { native, intl, platform },
        },
        async () => {
          if (intl) installIntl(intl);
          if (platform) installPlatform(platform);
          else if (intl)
            installPlatform({
              id: 'platform:ios',
              os: 'ios',
              realistic: true,
              constants: {
                osVersion: '18.5',
                systemName: 'iOS',
                interfaceIdiom: 'phone',
              },
              version: '18.5',
            });
          const fetchMock = jest.fn(() =>
            Promise.reject(new TypeError('Network request failed')),
          );
          globalThis.fetch = fetchMock as unknown as typeof fetch;
          nativeModules.PickleAuth = {
            signInWithApple: jest.fn(() => {
              if (native === 'hang') return new Promise(() => {});
              if (native === 'reject_error')
                return Promise.reject(
                  Object.assign(new Error('Sign-in canceled.'), {
                    code: 'auth.canceled',
                  }),
                );
              if (native === 'reject_nonerror')
                return Promise.reject('ASAuthorizationError 1001');
              return Promise.resolve({
                user: 'apple-user-opaque',
                identityToken: 'apple-identity-token',
                authorizationCode: 'one-use-apple-code',
                email: 'pat@privaterelay.example',
                givenName: 'Pat',
                familyName: 'Player',
              });
            }),
          };
          const contextMustThrow =
            native === 'ok' &&
            (intl!.mustThrow ||
              (platform !== null &&
                platform.os !== 'ios' &&
                platform.os !== 'android'));
          const run = probe(useAuthStore.getState().signInWithApple());
          expect(useAuthStore.getState().busy).toBe(true);
          await jest.advanceTimersByTimeAsync(60_000);
          const state = useAuthStore.getState();
          const observed: Record<string, unknown> = {
            settled: run.settled,
            busy: state.busy,
            error: state.error,
            session: state.session,
            fetchCalls: fetchMock.mock.calls.length,
            keychainEntries: __keychainStore.size,
            apiSession: getApiSession() !== null,
            contextMustThrow,
          };
          expect(state.session).toBeNull();
          expect(__keychainStore.size).toBe(0);
          expect(getApiSession()).toBeNull();
          if (native === 'hang') {
            // Native promise never settles: the store cannot recover on its
            // own (busy stays true). Outside the client's control — Apple's
            // ASAuthorizationController always completes or errors on device.
            expect(run.settled).toBe(false);
            expect(state.busy).toBe(true);
            return { observed, classification: 'KNOWN_LIMIT' };
          }
          expect(run.settled).toBe(true);
          expect(state.busy).toBe(false);
          expect(state.error).not.toBeNull();
          expect(typeof state.error!.message).toBe('string');
          expect(state.error!.message.length).toBeGreaterThan(0);
          if (contextMustThrow) {
            // Device context failed BEFORE any network call.
            expect(fetchMock).not.toHaveBeenCalled();
            expect(state.error!.code).toBe('auth.failed');
          } else if (native === 'ok') {
            // Context fine; the bootstrap transport failed instead.
            expect(fetchMock).toHaveBeenCalledTimes(1);
          } else {
            expect(fetchMock).not.toHaveBeenCalled();
          }
          const realistic =
            native !== 'reject_nonerror' &&
            (intl?.realistic ?? true) &&
            (platform?.realistic ?? true);
          return {
            observed: { ...observed, faultRealistic: realistic },
            classification: 'HELD',
          };
        },
      );
    });
  });
});

// ─── Scenario 4: post-deletion cleanup under Keychain/SQLite/SDK faults ──────

type KeychainFault = 'ok' | 'returns_false' | 'throw_sync' | 'reject' | 'hang';
type SdkFault = 'ok' | 'revoke_reject' | 'signout_reject' | 'revoke_hang';

function drawDbFault(rng: Rng): DbFault {
  return pick(rng, [
    { kind: 'ok' },
    { kind: 'ok' },
    { kind: 'open_throw' },
    { kind: 'kv_write_throw' },
    { kind: 'begin_throw' },
    { kind: 'delete_throw', deleteIndex: Math.floor(rng() * 11) },
    {
      kind: 'delete_throw_first_n',
      deleteIndex: Math.floor(rng() * 11),
      failAttempts: 1 + Math.floor(rng() * 3),
    },
    { kind: 'slow', delayMs: 250 + Math.floor(rng() * 4000) },
    { kind: 'hang' },
  ] as DbFault[]);
}

function dbFaultId(fault: DbFault): string {
  switch (fault.kind) {
    case 'delete_throw':
      return `sqlite:delete_throw#${fault.deleteIndex}`;
    case 'delete_throw_first_n':
      return `sqlite:delete_throw_first_${fault.failAttempts}#${fault.deleteIndex}`;
    case 'slow':
      return `sqlite:slow:${fault.delayMs}`;
    default:
      return `sqlite:${fault.kind}`;
  }
}

const OWNER_STATEMENTS = 6 + 5; // owner tables + kv namespaces per purge attempt
const LOCAL_PURGE_ATTEMPTS = 3;

describe('cleanup.completeAccountDeletion — Keychain/SQLite/SDK faults after a confirmed deletion', () => {
  const scenario = 'cleanup.completeAccountDeletion';
  scenarioCases(scenario).forEach(([seed, iteration]) => {
    it(`seed ${seed} (iteration ${iteration}) drops the session, settles, and reports the purge honestly`, async () => {
      const rng = seededRandom(seed);
      const keychain = pick(rng, [
        'ok',
        'ok',
        'returns_false',
        'throw_sync',
        'reject',
        'hang',
      ] as KeychainFault[]);
      const db = drawDbFault(rng);
      const provider = pick(rng, ['apple', 'google'] as const);
      const sdk =
        provider === 'google'
          ? pick(rng, [
              'ok',
              'revoke_reject',
              'signout_reject',
              'revoke_hang',
            ] as SdkFault[])
          : 'ok';
      const hasSession = rng() < 0.9;
      const faultId = `keychain:${keychain}|${dbFaultId(db)}|sdk:${sdk}`;
      await recordIteration(
        {
          suite: SUITE,
          scenario,
          seed,
          iteration,
          fault: faultId,
          inputs: { keychain, db, provider, sdk, hasSession },
        },
        async () => {
          mockDbFault = db;
          const owner = canonicalDataOwner(CANONICAL_ID);
          mockKv.set(`profile:${owner}`, '{"seeded":true}');
          mockKv.set('auth.localMode', '');
          __keychainStore.set(SESSION_VAULT_SERVICE, {
            username: 'session',
            password: '{"version":1}',
          });
          if (hasSession) {
            setActiveDataOwner(owner);
            useAuthStore.setState({
              session: {
                provider,
                subject: CANONICAL_ID,
                canonicalAppUserId: CANONICAL_ID,
                localOnly: false,
                displayName: 'Pat',
                email: 'pat@example.com',
              },
            });
          }
          const reset = jest
            .spyOn(Keychain, 'resetGenericPassword')
            .mockImplementation((options?: { service?: string }) => {
              if (keychain === 'throw_sync')
                throw new Error('Keychain: errSecInteractionNotAllowed');
              if (keychain === 'reject')
                return Promise.reject(new Error('Keychain: errSecAuthFailed'));
              if (keychain === 'hang') return new Promise(() => {});
              if (keychain === 'returns_false') return Promise.resolve(false);
              return Promise.resolve(
                __keychainStore.delete(options?.service ?? '__default__'),
              );
            });
          mockGoogleSignin.revokeAccess.mockImplementation(() => {
            if (sdk === 'revoke_reject')
              return Promise.reject(new Error('SIGN_IN_REQUIRED'));
            if (sdk === 'revoke_hang') return new Promise(() => {});
            return Promise.resolve(null);
          });
          mockGoogleSignin.signOut.mockImplementation(() =>
            sdk === 'signout_reject'
              ? Promise.reject(new Error('SIGN_IN_REQUIRED'))
              : Promise.resolve(null),
          );

          const run = probe(useAuthStore.getState().completeAccountDeletion());
          // Synchronous part of the contract: the session is gone right away.
          const immediate = useAuthStore.getState();
          expect(immediate.session).toBeNull();
          expect(immediate.busy).toBe(false);
          expect(immediate.error).toBeNull();
          expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
          expect(getApiSession()).toBeNull();

          await jest.advanceTimersByTimeAsync(60_000);
          const state = useAuthStore.getState();
          const begins = mockSqlLog.filter(s => s === 'BEGIN IMMEDIATE').length;
          const commits = mockSqlLog.filter(s => s === 'COMMIT').length;
          const rollbacks = mockSqlLog.filter(s => s === 'ROLLBACK').length;
          const deletes = mockSqlLog.filter(s =>
            s.startsWith('DELETE FROM'),
          ).length;
          const observed: Record<string, unknown> = {
            settled: run.settled,
            resolved: run.resolved,
            error:
              run.error instanceof Error
                ? run.error.message
                : (run.error ?? null),
            localPurge: state.deletionCleanup?.localPurge ?? null,
            keychainCalls: reset.mock.calls.length,
            keychainEntries: __keychainStore.size,
            begins,
            commits,
            rollbacks,
            deletes,
            profileKvRemains: mockKv.has(`profile:${owner}`),
            revokeCalls: mockGoogleSignin.revokeAccess.mock.calls.length,
          };
          expect(state.session).toBeNull();
          expect(reset).toHaveBeenCalledTimes(1);
          expect(reset.mock.calls[0]![0]).toEqual({
            service: SESSION_VAULT_SERVICE,
          });

          const hanging =
            keychain === 'hang' || db.kind === 'hang' || sdk === 'revoke_hang';
          if (hanging) {
            // A native call that never returns cannot be worked around by the
            // store; whatever landed before the hang must still hold.
            expect(run.settled).toBe(false);
            expect(commits).toBe(0);
            // No COMMIT ever follows a failed DELETE inside the same attempt.
            expect(rollbacks).toBeLessThanOrEqual(begins);
            if (keychain === 'hang') expect(begins).toBe(0);
            return { observed, classification: 'KNOWN_LIMIT' };
          }

          expect(run.settled).toBe(true);
          expect(run.resolved).toBe(true);
          if (keychain === 'ok')
            expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(false);
          if (!hasSession) {
            expect(state.deletionCleanup?.localPurge).toBe('not_needed');
            expect(begins).toBe(0);
            return { observed };
          }
          // Transactional purge accounting.
          expect(begins).toBeLessThanOrEqual(LOCAL_PURGE_ATTEMPTS);
          let expectedPurge: 'complete' | 'failed';
          switch (db.kind) {
            case 'ok':
            case 'kv_write_throw':
            case 'slow':
              expectedPurge = 'complete';
              break;
            case 'delete_throw_first_n':
              expectedPurge =
                (db.failAttempts ?? 0) < LOCAL_PURGE_ATTEMPTS
                  ? 'complete'
                  : 'failed';
              break;
            default:
              expectedPurge = 'failed';
          }
          expect(state.deletionCleanup?.localPurge).toBe(expectedPurge);
          if (expectedPurge === 'complete') {
            expect(commits).toBe(1);
            expect(mockKv.has(`profile:${owner}`)).toBe(false);
            const lastBegin = mockSqlLog.lastIndexOf('BEGIN IMMEDIATE');
            const finalAttempt = mockSqlLog.slice(lastBegin);
            expect(
              finalAttempt.filter(s => s.startsWith('DELETE FROM')),
            ).toHaveLength(OWNER_STATEMENTS);
            expect(finalAttempt[finalAttempt.length - 1]).toBe('COMMIT');
            const failedAttempts =
              db.kind === 'delete_throw_first_n' ? (db.failAttempts ?? 0) : 0;
            expect(begins).toBe(1 + failedAttempts);
            expect(rollbacks).toBe(failedAttempts);
          } else {
            expect(commits).toBe(0);
            if (db.kind === 'open_throw') {
              expect(begins).toBe(0);
            } else if (db.kind === 'begin_throw') {
              expect(begins).toBe(LOCAL_PURGE_ATTEMPTS);
              // BEGIN itself failed before the try: no transaction was
              // opened, so nothing to roll back.
              expect(rollbacks).toBe(0);
              expect(deletes).toBe(0);
            } else {
              expect(begins).toBe(LOCAL_PURGE_ATTEMPTS);
              expect(rollbacks).toBe(LOCAL_PURGE_ATTEMPTS);
              // Every attempt stopped at the injected statement.
              expect(deletes).toBe(
                LOCAL_PURGE_ATTEMPTS * ((db.deleteIndex ?? 0) + 1),
              );
            }
            // The owner's profile row must still be there for the
            // "LOCAL CLEANUP NEEDED" notice to be truthful.
            if (db.kind !== 'open_throw') {
              const kvDeleteIndex = 6; // first kv namespace = 'profile'
              const profileDeleted =
                db.kind !== 'begin_throw' &&
                (db.deleteIndex ?? 0) > kvDeleteIndex;
              expect(mockKv.has(`profile:${owner}`)).toBe(!profileDeleted);
              // (Mock has no real ROLLBACK; a real SQLite would restore it. If
              // the DELETE reached the profile row before failing, the
              // in-memory map reflects the un-rolled-back state — recorded.)
              observed['mockLacksRollback'] = profileDeleted;
            }
          }
          const realistic = keychain !== 'throw_sync';
          return {
            observed: { ...observed, faultRealistic: realistic },
            classification: 'HELD',
          };
        },
      );
    });
  });
});
