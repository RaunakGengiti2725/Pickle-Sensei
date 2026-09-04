/**
 * ADVERSARIAL PASS 3 — mobile-ios-config — S3
 *
 * Attack: `react-native-keychain.getGenericPassword` returns malformed /
 * hostile content (truncated JSON, wrong types, prototype-poisoning, huge,
 * unicode, throwing, non-object results) and `authStore.hydrate()` runs.
 *
 * Must hold
 *  - hydrate never throws and always flips `hydrated`;
 *  - the store lands SIGNED OUT (session null, signed-out data owner);
 *  - NO session material reaches SQLite kv (no refresh/access/id token,
 *    no provider subject);
 *  - an unparseable vault record is CLEARED (resetGenericPassword) so the
 *    next launch does not re-read garbage;
 *  - no network call is attempted with junk (fetch stays untouched);
 *  - rapid repeated / interleaved hydrates converge to the same signed-out
 *    state.
 *
 * Read-only: no production file is touched. The Keychain module is a
 * per-test controllable jest.mock (not the repo's in-memory auto-mock).
 */
import type { LocalDb } from '../../../src/data/db';
import { useAuthStore } from '../../../src/auth/authStore';
import {
  clearApiSession,
  getApiSession,
} from '../../../src/account/apiSession';
import { SESSION_VAULT_SERVICE } from '../../../src/account/sessionVault';
import { stopSessionKeeper } from '../../../src/account/sessionKeeper';
import {
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import { clearSyncRuntime } from '../../../src/data/syncRuntime';

// ─── Module seams ────────────────────────────────────────────────────────────

const mockKv = new Map<string, string>();
const mockKvWrites: Array<{ key: string; value: string }> = [];
function mockCurrentDb(): LocalDb {
  return {
    async execute(sql: string, params: unknown[] = []) {
      const statement = sql.trim().replace(/\s+/g, ' ');
      if (statement.startsWith('SELECT value FROM kv')) {
        const value = mockKv.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
        mockKv.set(String(params[0]), String(params[1]));
        mockKvWrites.push({ key: String(params[0]), value: String(params[1]) });
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  };
}
jest.mock('../../../src/data/db', () => ({ getDb: () => mockCurrentDb() }));

const mockKeychain = {
  getGenericPassword: jest.fn(),
  setGenericPassword: jest.fn(),
  resetGenericPassword: jest.fn(),
  ACCESSIBLE: {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY:
      'AccessibleAfterFirstUnlockThisDeviceOnly',
  },
};
jest.mock('react-native-keychain', () => mockKeychain);

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

jest.mock('../../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: 'test-web-client.apps.googleusercontent.com',
  GOOGLE_IOS_CLIENT_ID: 'test-ios-client.apps.googleusercontent.com',
}));

jest.mock('../../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.example.test',
    revenueCatPublicSdkKey: null,
    googleIosClientId: 'test-ios-client.apps.googleusercontent.com',
    googleWebClientId: 'test-web-client.apps.googleusercontent.com',
    appVersion: '1.0',
  }),
}));

jest.mock('../../../src/account/deviceContext', () => ({
  getAccountBootstrapEnvironment: () => ({
    locale: 'en-US',
    timezone: 'America/Los_Angeles',
    device: {
      platform: 'ios',
      osVersion: '18.5',
      appVersion: '1.0',
      model: 'iOS phone',
    },
  }),
}));

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SESSION_MATERIAL =
  /refreshToken|accessToken|idToken|id_token|refresh_token|access_token|canonicalAppUserId|"subject"|apple|google/i;

function stored(password: unknown) {
  return {
    service: SESSION_VAULT_SERVICE,
    storage: 'KeychainMock',
    username: 'session',
    password,
  };
}

const realFetch = globalThis.fetch;
let fetchMock: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockKv.clear();
  mockKvWrites.length = 0;
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    hydrated: false,
    session: null,
    busy: false,
    error: null,
  });
  mockKeychain.resetGenericPassword.mockResolvedValue(true);
  mockKeychain.setGenericPassword.mockResolvedValue({
    service: SESSION_VAULT_SERVICE,
    storage: 'KeychainMock',
  });
  mockGoogleSignin.hasPreviousSignIn.mockReturnValue(false);
  mockGoogleSignin.signInSilently.mockResolvedValue({
    type: 'noSavedCredentialFound',
    data: null,
  });
  fetchMock = jest
    .fn()
    .mockRejectedValue(new Error('fetch must not be called'));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  globalThis.fetch = realFetch;
});

function expectSignedOutAndClean(): void {
  const state = useAuthStore.getState();
  expect(state.hydrated).toBe(true);
  expect(state.session).toBeNull();
  expect(state.busy).toBe(false);
  expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
  expect(getApiSession()).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(mockKeychain.setGenericPassword).not.toHaveBeenCalled();
  for (const [key, value] of mockKv) {
    expect(`${key}=${value}`).not.toMatch(SESSION_MATERIAL);
  }
  for (const write of mockKvWrites) {
    expect(write.value).not.toMatch(SESSION_MATERIAL);
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('S3 — malformed Keychain record → hydrate (attack)', () => {
  const malformedPasswords: Array<[string, unknown]> = [
    [
      'truncated JSON',
      '{"version":1,"provider":"apple","canonicalAppUserId":"7fc2c743-028f-4ec6-942c-a84508f3be38","refreshT',
    ],
    ['not JSON at all', 'hello keychain'],
    ['empty string', ''],
    ['whitespace only', '   \n\t'],
    ['JSON null', 'null'],
    ['JSON number', '42'],
    ['JSON string', '"refresh-token-in-a-string"'],
    ['JSON array', '["apple","7fc2c743-028f-4ec6-942c-a84508f3be38","rt"]'],
    [
      'wrong version',
      JSON.stringify({
        version: 2,
        provider: 'apple',
        canonicalAppUserId: 'x',
        refreshToken: 'rt',
      }),
    ],
    [
      'version as string',
      JSON.stringify({
        version: '1',
        provider: 'apple',
        canonicalAppUserId: 'x',
        refreshToken: 'rt',
      }),
    ],
    [
      'unknown provider',
      JSON.stringify({
        version: 1,
        provider: 'facebook',
        canonicalAppUserId: 'x',
        refreshToken: 'rt',
      }),
    ],
    [
      'provider with unicode look-alike',
      JSON.stringify({
        version: 1,
        provider: 'аpple',
        canonicalAppUserId: 'x',
        refreshToken: 'rt',
      }),
    ],
    [
      'empty refreshToken',
      JSON.stringify({
        version: 1,
        provider: 'apple',
        canonicalAppUserId: 'x',
        refreshToken: '',
      }),
    ],
    [
      'numeric refreshToken',
      JSON.stringify({
        version: 1,
        provider: 'apple',
        canonicalAppUserId: 'x',
        refreshToken: 12345,
      }),
    ],
    [
      'empty canonicalAppUserId',
      JSON.stringify({
        version: 1,
        provider: 'google',
        canonicalAppUserId: '',
        refreshToken: 'rt',
      }),
    ],
    [
      'object canonicalAppUserId',
      JSON.stringify({
        version: 1,
        provider: 'google',
        canonicalAppUserId: { $ne: null },
        refreshToken: 'rt',
      }),
    ],
    [
      '__proto__ poisoning',
      '{"__proto__":{"version":1,"provider":"apple","canonicalAppUserId":"x","refreshToken":"rt"}}',
    ],
    [
      'constructor.prototype poisoning',
      '{"constructor":{"prototype":{"provider":"apple"}},"version":1}',
    ],
    [
      'BOM prefixed',
      '\uFEFF{"version":1,"provider":"apple","canonicalAppUserId":"x","refreshToken":"rt"}',
    ],
    [
      'NUL embedded',
      '{"version":1,"provider":"apple\u0000","canonicalAppUserId":"x","refreshToken":"rt"}',
    ],
    ['huge garbage (1 MiB)', 'A'.repeat(1024 * 1024)],
    ['deeply nested arrays', '['.repeat(5000) + ']'.repeat(5000)],
    ['password is a number, not a string', 987654321],
    [
      'password is an object, not a string',
      {
        version: 1,
        provider: 'apple',
        canonicalAppUserId: 'x',
        refreshToken: 'rt',
      },
    ],
    ['password is null', null],
    ['password is undefined', undefined],
  ];

  it.each(malformedPasswords)(
    '%s → no throw, signed out, vault cleared, kv clean',
    async (_label, password) => {
      mockKeychain.getGenericPassword.mockResolvedValue(stored(password));

      await expect(useAuthStore.getState().hydrate()).resolves.toBeUndefined();

      expectSignedOutAndClean();
      expect(mockKeychain.getGenericPassword).toHaveBeenCalledWith({
        service: SESSION_VAULT_SERVICE,
      });
      expect(mockKeychain.resetGenericPassword).toHaveBeenCalledWith({
        service: SESSION_VAULT_SERVICE,
      });
    },
  );

  it.each([
    [
      'Keychain rejects (errSecItemNotFound-like)',
      () =>
        mockKeychain.getGenericPassword.mockRejectedValue(
          new Error('The specified item could not be found in the keychain.'),
        ),
    ],
    [
      'Keychain rejects with a non-Error',
      () => mockKeychain.getGenericPassword.mockRejectedValue('nope'),
    ],
    [
      'Keychain throws synchronously',
      () =>
        mockKeychain.getGenericPassword.mockImplementation(() => {
          throw new Error('sync boom');
        }),
    ],
    [
      'Keychain returns undefined',
      () => mockKeychain.getGenericPassword.mockResolvedValue(undefined),
    ],
    [
      'Keychain returns null',
      () => mockKeychain.getGenericPassword.mockResolvedValue(null),
    ],
    [
      'Keychain returns false (no item)',
      () => mockKeychain.getGenericPassword.mockResolvedValue(false),
    ],
    [
      'Keychain returns true (bogus)',
      () => mockKeychain.getGenericPassword.mockResolvedValue(true),
    ],
    [
      'Keychain returns a string',
      () => mockKeychain.getGenericPassword.mockResolvedValue('{"version":1}'),
    ],
    [
      'Keychain returns an item with no password key',
      () =>
        mockKeychain.getGenericPassword.mockResolvedValue({
          service: SESSION_VAULT_SERVICE,
          username: 'session',
        }),
    ],
    [
      'Keychain never resolves within the test (hangs) — hydrate must not be awaited forever by callers',
      undefined,
    ],
  ])('%s → no throw, signed out, kv clean', async (_label, arm) => {
    if (!arm) {
      // A hanging Keychain read: hydrate itself would await forever, so the
      // assertion is that nothing ELSE (kv, fetch) happens while it hangs.
      mockKeychain.getGenericPassword.mockReturnValue(new Promise(() => {}));
      const pending = useAuthStore.getState().hydrate();
      await new Promise<void>(resolve => setTimeout(() => resolve(), 20));
      expect(useAuthStore.getState().session).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      for (const write of mockKvWrites) {
        expect(write.value).not.toMatch(SESSION_MATERIAL);
      }
      void pending;
      return;
    }
    arm();
    await expect(useAuthStore.getState().hydrate()).resolves.toBeUndefined();
    expectSignedOutAndClean();
  });

  it('resetGenericPassword failing while clearing garbage still lands signed out without throwing', async () => {
    mockKeychain.getGenericPassword.mockResolvedValue(stored('{not json'));
    mockKeychain.resetGenericPassword.mockRejectedValue(
      new Error('errSecInteractionNotAllowed'),
    );
    await expect(useAuthStore.getState().hydrate()).resolves.toBeUndefined();
    expectSignedOutAndClean();
  });

  it('garbage vault + stale legacy google flag: legacy path runs but Google has no saved credential → signed out, flag not upgraded', async () => {
    mockKv.set(
      'auth.last-provider',
      JSON.stringify({ version: 1, provider: 'google' }),
    );
    mockKeychain.getGenericPassword.mockResolvedValue(stored('{"version":1'));
    mockGoogleSignin.hasPreviousSignIn.mockReturnValue(true);
    mockGoogleSignin.signInSilently.mockResolvedValue({
      type: 'noSavedCredentialFound',
      data: null,
    });
    await expect(useAuthStore.getState().hydrate()).resolves.toBeUndefined();
    expectSignedOutAndClean();
  });

  it('legacy SQLite session key is blanked, never hydrated, even when the vault is garbage', async () => {
    mockKv.set(
      'auth.session',
      JSON.stringify({ provider: 'apple', subject: '001234.abcdef' }),
    );
    mockKeychain.getGenericPassword.mockResolvedValue(stored('garbage'));
    await expect(useAuthStore.getState().hydrate()).resolves.toBeUndefined();
    const state = useAuthStore.getState();
    expect(state.session).toBeNull();
    expect(mockKv.get('auth.session')).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rapid repeated hydrates over a garbage vault converge (seed 0xc0ffee order of payloads)', async () => {
    let seed = 0xc0ffee;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    const payloads = [
      '{',
      'null',
      '[]',
      '""',
      'A'.repeat(4096),
      '{"version":1}',
    ];
    mockKeychain.getGenericPassword.mockImplementation(async () => {
      await new Promise<void>(resolve =>
        setTimeout(() => resolve(), next() % 3),
      );
      return stored(payloads[next() % payloads.length]);
    });
    await Promise.all(
      Array.from({ length: 12 }, () => useAuthStore.getState().hydrate()),
    );
    expectSignedOutAndClean();
    expect(mockKeychain.resetGenericPassword).toHaveBeenCalledTimes(12);
  });

  it('a valid-looking record whose refresh token is rejected by the server signs out WITHOUT persisting anything to kv', async () => {
    mockKeychain.getGenericPassword.mockResolvedValue(
      stored(
        JSON.stringify({
          version: 1,
          provider: 'apple',
          canonicalAppUserId: '7fc2c743-028f-4ec6-942c-a84508f3be38',
          refreshToken: 'stolen-or-stale-refresh-token',
          email: 'pat@example.com',
          displayName: 'Pat Player',
        }),
      ),
    );
    fetchMock = jest.fn(async (url: string) => {
      if (url.endsWith('/v1/auth/refresh')) {
        return {
          ok: false,
          status: 401,
          json: jest.fn().mockResolvedValue({ error: 'invalid_grant' }),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(useAuthStore.getState().hydrate()).resolves.toBeUndefined();

    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.session).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(getApiSession()).toBeNull();
    expect(mockKeychain.resetGenericPassword).toHaveBeenCalledWith({
      service: SESSION_VAULT_SERVICE,
    });
    for (const write of mockKvWrites) {
      expect(write.value).not.toMatch(/refresh|access|token|7fc2c743/i);
    }
    // The stolen token was sent exactly once, to the refresh route, over HTTPS.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(
      /^https:\/\/api\.example\.test\/v1\/auth\/refresh$/,
    );
  });
});
