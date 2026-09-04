/**
 * sessionVault + sessionLifecycle unit contract (mutation-testing survivors
 * SV-01, SV-02, SV-03, SV-06, SL-06):
 *
 *  - the Keychain record is written with the AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY
 *    accessibility class (restorable at launch on this device only — never
 *    synced to another device via iCloud Keychain);
 *  - a record of another schema version, a non-Apple/Google provider, or an
 *    empty refresh token is NOT trusted: it loads as null AND is deleted;
 *  - refreshApiSession maps the server's `expiresAt` (seconds) to
 *    `bearerExpiresAtMs` (milliseconds).
 */
import * as Keychain from 'react-native-keychain';
import {
  SESSION_VAULT_SERVICE,
  loadPersistedSession,
  savePersistedSession,
} from '../../src/account/sessionVault';
import { refreshApiSession } from '../../src/account/sessionLifecycle';

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<
    string,
    { username: string; password: string; accessible?: string }
  >;
};

const record = {
  version: 1 as const,
  provider: 'apple' as const,
  canonicalAppUserId: '7fc2c743-028f-4ec6-942c-a84508f3be38',
  refreshToken: 'refresh-1',
  email: 'pat@example.com',
  displayName: 'Pat Player',
};

function seedRaw(raw: unknown): void {
  __keychainStore.set(SESSION_VAULT_SERVICE, {
    username: 'session',
    password: JSON.stringify(raw),
  });
}

beforeEach(() => {
  __keychainStore.clear();
});

describe('sessionVault', () => {
  it('stores the record with the after-first-unlock, this-device-only accessibility class', async () => {
    expect(await savePersistedSession(record)).toBe(true);
    const item = __keychainStore.get(SESSION_VAULT_SERVICE);
    expect(item).toBeDefined();
    expect(item!.accessible).toBe(
      Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    );
    expect(JSON.parse(item!.password)).toEqual(record);
  });

  it('round-trips a valid record', async () => {
    await savePersistedSession(record);
    expect(await loadPersistedSession()).toEqual(record);
    expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(true);
  });

  it.each([
    ['a future schema version', { ...record, version: 2 }],
    ['a missing version', { ...record, version: undefined }],
    ['a provider that is not apple/google', { ...record, provider: 'guest' }],
    ['an empty refresh token', { ...record, refreshToken: '' }],
    ['a non-string refresh token', { ...record, refreshToken: 42 }],
    ['an empty canonical id', { ...record, canonicalAppUserId: '' }],
  ])('refuses %s: loads as null and deletes the item', async (_label, raw) => {
    seedRaw(raw);
    expect(await loadPersistedSession()).toBeNull();
    expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(false);
  });

  it('refuses unparseable JSON the same way', async () => {
    __keychainStore.set(SESSION_VAULT_SERVICE, {
      username: 'session',
      password: '{not json',
    });
    expect(await loadPersistedSession()).toBeNull();
    expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(false);
  });
});

describe('refreshApiSession', () => {
  it('maps expiresAt seconds to bearerExpiresAtMs milliseconds', async () => {
    const expiresAt = 1_800_000_000;
    const fetchFn = jest.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            session: {
              accessToken: 'access-2',
              refreshToken: 'refresh-2',
              expiresAt,
            },
          }),
        }) as unknown as Response,
    );
    const tokens = await refreshApiSession(
      { apiBaseUrl: 'https://api.example.test', refreshToken: 'refresh-1' },
      { fetchFn },
    );
    expect(tokens).toEqual({
      bearerToken: 'access-2',
      refreshToken: 'refresh-2',
      bearerExpiresAtMs: expiresAt * 1000,
    });
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.example.test/v1/auth/refresh',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ refreshToken: 'refresh-1' }),
      }),
    );
  });
});
