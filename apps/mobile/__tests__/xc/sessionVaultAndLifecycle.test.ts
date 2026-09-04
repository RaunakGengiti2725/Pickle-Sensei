/**
 * sessionVault + sessionLifecycle unit contract (AGENTS.md → "Auth sessions"):
 *
 *  - the Keychain record is written under the vault service with the
 *    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY accessibility class (restorable at
 *    launch on this device only — never through backups or Keychain sync)
 *    and holds exactly {version, provider, canonicalAppUserId, refreshToken,
 *    email, displayName}: no access token, no provider token;
 *  - a record of another schema version, a non-Apple/Google provider, an
 *    empty/missing refresh token or canonical id is NOT trusted: it loads as
 *    null AND is deleted;
 *  - refreshApiSession maps the server's `expiresAt` (unix seconds) to
 *    `bearerExpiresAtMs` (milliseconds) and classifies only 401/403 as
 *    non-retryable.
 */
import * as Keychain from 'react-native-keychain';
import {
  SESSION_VAULT_SERVICE,
  clearPersistedSession,
  loadPersistedSession,
  savePersistedSession,
  type PersistedSession,
} from '../../src/account/sessionVault';
import {
  SessionRefreshError,
  refreshApiSession,
} from '../../src/account/sessionLifecycle';

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<
    string,
    { username: string; password: string; accessible?: string }
  >;
};

const record: PersistedSession = {
  version: 1,
  provider: 'apple',
  canonicalAppUserId: '7fc2c743-028f-4ec6-942c-a84508f3be38',
  refreshToken: 'refresh-1',
  email: 'pat@example.com',
  displayName: 'Pat Player',
};

function seedRaw(raw: unknown): void {
  __keychainStore.set(SESSION_VAULT_SERVICE, {
    username: 'session',
    password: typeof raw === 'string' ? raw : JSON.stringify(raw),
  });
}

beforeEach(() => {
  __keychainStore.clear();
});

describe('sessionVault › save', () => {
  it('stores the record under the vault service with the after-first-unlock, this-device-only accessibility class', async () => {
    expect(await savePersistedSession(record)).toBe(true);
    expect([...__keychainStore.keys()]).toEqual([SESSION_VAULT_SERVICE]);
    const item = __keychainStore.get(SESSION_VAULT_SERVICE);
    expect(item).toBeDefined();
    expect(item!.accessible).toBe(
      Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    );
    expect(item!.accessible).toBe('AccessibleAfterFirstUnlockThisDeviceOnly');
    expect(item!.username).toBe('session');
  });

  it('persists exactly the descriptor + refresh token as JSON — no access-token or provider-token field exists in the record', async () => {
    await savePersistedSession(record);
    const stored = JSON.parse(
      __keychainStore.get(SESSION_VAULT_SERVICE)!.password,
    ) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual([
      'canonicalAppUserId',
      'displayName',
      'email',
      'provider',
      'refreshToken',
      'version',
    ]);
    expect(stored).toEqual(record);
  });

  it('round-trips a valid Apple and a valid Google record, nullable fields included', async () => {
    await savePersistedSession(record);
    expect(await loadPersistedSession()).toEqual(record);
    expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(true);

    const google: PersistedSession = {
      version: 1,
      provider: 'google',
      canonicalAppUserId: '0d8f2f3a-3f2f-4c62-9a4a-4f1a1c9e1b7d',
      refreshToken: 'refresh-g',
      email: null,
      displayName: null,
    };
    await savePersistedSession(google);
    expect(await loadPersistedSession()).toEqual(google);
  });

  it('a later save replaces the earlier record; clear removes it', async () => {
    await savePersistedSession(record);
    await savePersistedSession({ ...record, refreshToken: 'refresh-2' });
    expect(await loadPersistedSession()).toEqual({
      ...record,
      refreshToken: 'refresh-2',
    });
    await clearPersistedSession();
    expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(false);
    expect(await loadPersistedSession()).toBeNull();
  });
});

describe('sessionVault › load refuses untrusted records', () => {
  it.each([
    ['a future schema version', { ...record, version: 2 }],
    ['a version 0 record', { ...record, version: 0 }],
    ['a string version', { ...record, version: '1' }],
    ['a missing version', { ...record, version: undefined }],
    ['a provider that is not apple/google', { ...record, provider: 'guest' }],
    ['an email-style provider', { ...record, provider: 'email' }],
    ['a missing provider', { ...record, provider: undefined }],
    ['an empty refresh token', { ...record, refreshToken: '' }],
    ['a non-string refresh token', { ...record, refreshToken: 42 }],
    ['a missing refresh token', { ...record, refreshToken: undefined }],
    ['an empty canonical id', { ...record, canonicalAppUserId: '' }],
    ['a non-string canonical id', { ...record, canonicalAppUserId: 7 }],
    ['an array', [record]],
    ['a JSON null', null],
    ['a JSON string', 'session'],
  ])('refuses %s: loads as null and deletes the item', async (_label, raw) => {
    seedRaw(raw);
    expect(await loadPersistedSession()).toBeNull();
    expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(false);
  });

  it('refuses unparseable JSON the same way', async () => {
    seedRaw('{not json');
    expect(await loadPersistedSession()).toBeNull();
    expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(false);
  });

  it('normalises non-string email/displayName to null but keeps the record', async () => {
    seedRaw({ ...record, email: 12, displayName: { first: 'Pat' } });
    expect(await loadPersistedSession()).toEqual({
      ...record,
      email: null,
      displayName: null,
    });
    expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(true);
  });

  it('returns null when nothing is stored, without touching other services', async () => {
    __keychainStore.set('com.picklesensei.other', {
      username: 'x',
      password: 'y',
    });
    expect(await loadPersistedSession()).toBeNull();
    expect(__keychainStore.has('com.picklesensei.other')).toBe(true);
  });
});

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('refreshApiSession', () => {
  it('maps expiresAt seconds to bearerExpiresAtMs milliseconds and posts the refresh token', async () => {
    const expiresAt = 1_800_000_000;
    const fetchFn = jest.fn(async () =>
      response(200, {
        session: {
          accessToken: 'access-2',
          refreshToken: 'refresh-2',
          expiresAt,
        },
      }),
    );
    const tokens = await refreshApiSession(
      { apiBaseUrl: 'https://api.example.test', refreshToken: 'refresh-1' },
      { fetchFn },
    );
    expect(tokens).toEqual({
      bearerToken: 'access-2',
      refreshToken: 'refresh-2',
      bearerExpiresAtMs: 1_800_000_000_000,
    });
    expect(tokens.bearerExpiresAtMs).toBe(expiresAt * 1000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.example.test/v1/auth/refresh',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ refreshToken: 'refresh-1' }),
      }),
    );
  });

  it.each([401, 403])('HTTP %i is the non-retryable refusal', async status => {
    const fetchFn = jest.fn(async () => response(status, {}));
    const failure = await refreshApiSession(
      { apiBaseUrl: 'https://api.example.test', refreshToken: 'refresh-1' },
      { fetchFn },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SessionRefreshError);
    expect((failure as SessionRefreshError).retryable).toBe(false);
  });

  it.each([
    ['HTTP 500', async () => response(500, {})],
    ['HTTP 503', async () => response(503, {})],
    ['HTTP 429', async () => response(429, {})],
    ['HTTP 400', async () => response(400, {})],
    [
      'a network error',
      async (): Promise<Response> => {
        throw new TypeError('Network request failed');
      },
    ],
    ['a 200 without a session', async () => response(200, {})],
    [
      'a 200 with a non-numeric expiresAt',
      async () =>
        response(200, {
          session: {
            accessToken: 'a',
            refreshToken: 'r',
            expiresAt: '1800000000',
          },
        }),
    ],
    [
      'a 200 with an empty access token',
      async () =>
        response(200, {
          session: { accessToken: ' ', refreshToken: 'r', expiresAt: 1 },
        }),
    ],
  ])('%s is a retryable failure, never a refusal', async (_label, fetchFn) => {
    const failure = await refreshApiSession(
      { apiBaseUrl: 'https://api.example.test', refreshToken: 'refresh-1' },
      { fetchFn: jest.fn(fetchFn) },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SessionRefreshError);
    expect((failure as SessionRefreshError).retryable).toBe(true);
  });
});
