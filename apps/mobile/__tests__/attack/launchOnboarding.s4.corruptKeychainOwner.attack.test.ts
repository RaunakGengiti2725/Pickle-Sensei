/**
 * ADVERSARIAL S4 — the Keychain hands back a schema-valid session record
 * whose canonicalAppUserId is NOT a UUID (corrupt vault, a record written by
 * a future/other build, or a tampered backup restore).
 *
 * Expected: canonicalDataOwner rejects it, the record is cleared so the next
 * launch does not trip over it again, and hydrate() lands signed-out without
 * throwing out of owner resolution.
 */
import type { LocalDb } from '../../src/data/db';
import { useAuthStore } from '../../src/auth/authStore';
import { clearApiSession, getApiSession } from '../../src/account/apiSession';
import {
  SESSION_VAULT_SERVICE,
  loadPersistedSession,
} from '../../src/account/sessionVault';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import * as Keychain from 'react-native-keychain';

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

const mockKv = new Map<string, string>();
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
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  };
}
jest.mock('../../src/data/db', () => ({ getDb: () => mockCurrentDb() }));

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: jest.fn(),
    hasPreviousSignIn: jest.fn(() => false),
    signInSilently: jest.fn(),
    signIn: jest.fn(),
    signOut: jest.fn(),
    revokeAccess: jest.fn(),
    hasPlayServices: jest.fn(),
  },
}));

jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: 'test-web-client.apps.googleusercontent.com',
  GOOGLE_IOS_CLIENT_ID: 'test-ios-client.apps.googleusercontent.com',
}));

jest.mock('../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.example.test',
    revenueCatPublicSdkKey: null,
    googleIosClientId: 'test-ios-client.apps.googleusercontent.com',
    googleWebClientId: 'test-web-client.apps.googleusercontent.com',
    appVersion: '1.0',
  }),
}));

const CORRUPT_IDS: Array<[string, string]> = [
  ['plain string', 'not-a-uuid'],
  ['apple opaque user id', '001234.abcdef0123456789abcdef0123456789.1234'],
  ['numeric', '12345'],
  ['unicode', 'ユーザー-🥒-0000'],
  ['sql-ish', "'; DROP TABLE kv; --"],
  ['huge', 'x'.repeat(4_096)],
  ['almost uuid (bad variant nibble)', '7fc2c743-028f-4ec6-042c-a84508f3be38'],
  ['uuid with inner whitespace', '7fc2c743-028f-4ec6-942c- a84508f3be38'],
];

function seedVault(canonicalAppUserId: string) {
  __keychainStore.set(SESSION_VAULT_SERVICE, {
    username: 'session',
    password: JSON.stringify({
      version: 1,
      provider: 'apple',
      canonicalAppUserId,
      refreshToken: 'refresh-1',
      email: 'pat@example.com',
      displayName: 'Pat Player',
    }),
  });
}

const realFetch = globalThis.fetch;
let fetchMock: jest.Mock;

beforeEach(() => {
  mockKv.clear();
  __keychainStore.clear();
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
  fetchMock = jest.fn(async (url: string) => {
    throw new Error(`unexpected network call ${url}`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  globalThis.fetch = realFetch;
});

describe('S4 Keychain record with a non-UUID canonicalAppUserId', () => {
  it.each(CORRUPT_IDS)(
    '%s: canonicalDataOwner rejects it, hydrate lands signed-out without throwing, and the record is cleared',
    async (_label, corruptId) => {
      seedVault(corruptId);

      // The vault happily returns the record (schema only checks "non-empty
      // string") …
      const persisted = await loadPersistedSession();
      const vaultAcceptedIt = persisted !== null;
      // … and owner resolution refuses it.
      expect(() => canonicalDataOwner(corruptId)).toThrow(
        'Local account scope requires a canonical backend UUID.',
      );

      await expect(useAuthStore.getState().hydrate()).resolves.toBeUndefined();

      const state = useAuthStore.getState();
      const recordAfter = __keychainStore.get(SESSION_VAULT_SERVICE);
      console.log(
        JSON.stringify({
          scenario: 'S4',
          id:
            corruptId.length > 64
              ? `${corruptId.slice(0, 16)}…(${corruptId.length})`
              : corruptId,
          vaultAcceptedIt,
          hydrated: state.hydrated,
          session: state.session,
          owner: getActiveDataOwner(),
          apiSession: getApiSession(),
          networkCalls: fetchMock.mock.calls.length,
          keychainRecordStillPresent: Boolean(recordAfter),
        }),
      );

      expect(state.hydrated).toBe(true);
      expect(state.session).toBeNull();
      expect(state.error).toBeNull();
      expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
      expect(getApiSession()).toBeNull();
      // No refresh may be attempted for an owner we cannot scope.
      expect(fetchMock).not.toHaveBeenCalled();
      // The poisoned record must not survive to the next launch.
      expect(recordAfter).toBeUndefined();
    },
  );

  it('a corrupt record is not resurrected as a session on a second launch either', async () => {
    seedVault('not-a-uuid');
    await useAuthStore.getState().hydrate();
    useAuthStore.setState({ hydrated: false });
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().hydrated).toBe(true);
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
  });

  it('an upper-case / padded UUID is still a valid owner (normalization, not rejection)', async () => {
    const id = '  7FC2C743-028F-4EC6-942C-A84508F3BE38 ';
    expect(canonicalDataOwner(id)).toBe('7fc2c743-028f-4ec6-942c-a84508f3be38');
    seedVault(id);
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        session: {
          accessToken: 'access-2',
          refreshToken: 'refresh-2',
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        },
      }),
    }));
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(id);
    expect(getActiveDataOwner()).toBe('7fc2c743-028f-4ec6-942c-a84508f3be38');
    expect(getApiSession()?.canonicalAppUserId).toBe(id);
  });
});
