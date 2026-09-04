/**
 * Static-health probe (NOT part of the default jest suite — run explicitly):
 *
 *   cd apps/mobile && npx jest --ci --rootDir . \
 *     --testMatch '<rootDir>/scripts/staticHealth/probes/*.probe.ts'
 *
 * Exercises the swallowed catch at src/auth/authStore.ts hydrate(): the
 * SQLite kv reads (legacy session key, local-guest flag) run BEFORE the
 * Keychain vault is consulted, inside one try whose catch lands the launch
 * signed-out. A valid durable session therefore does not survive a launch
 * on which the local database cannot be opened, even though the vault record
 * is intact and the server would accept the refresh token.
 *
 * The assertions describe the durable-sign-in CONTRACT (AGENTS.md: the ONE
 * implicit sign-out is the server refusing the refresh token). A failing run
 * is the finding; a passing run means the ordering has been fixed.
 */
import type { LocalDb } from '../../../src/data/db';
import { useAuthStore } from '../../../src/auth/authStore';
import {
  getApiSession,
  clearApiSession,
} from '../../../src/account/apiSession';
import { SESSION_VAULT_SERVICE } from '../../../src/account/sessionVault';
import { stopSessionKeeper } from '../../../src/account/sessionKeeper';
import {
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import { clearSyncRuntime } from '../../../src/data/syncRuntime';
import * as Keychain from 'react-native-keychain';

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

let mockDbMode: 'healthy' | 'open-throws' | 'kv-read-rejects' = 'healthy';
const mockKv = new Map<string, string>();
function mockDb(): LocalDb {
  return {
    async execute(sql: string, params: unknown[] = []) {
      const statement = sql.trim().replace(/\s+/g, ' ');
      if (mockDbMode === 'kv-read-rejects' && statement.startsWith('SELECT')) {
        throw new Error('SQLITE_IOERR: disk I/O error');
      }
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
jest.mock('../../../src/data/db', () => ({
  getDb: () => {
    if (mockDbMode === 'open-throws') {
      throw new Error('SQLITE_CANTOPEN: unable to open database file');
    }
    return mockDb();
  },
}));

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: jest.fn(),
    hasPreviousSignIn: jest.fn().mockReturnValue(false),
    signInSilently: jest.fn(),
    signOut: jest.fn(),
    revokeAccess: jest.fn(),
  },
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

const canonicalId = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const FAR_FUTURE_SECONDS = Math.floor(Date.now() / 1000) + 3600;

function seedVault(refreshToken: string) {
  __keychainStore.set(SESSION_VAULT_SERVICE, {
    username: 'session',
    password: JSON.stringify({
      version: 1,
      provider: 'apple',
      canonicalAppUserId: canonicalId,
      refreshToken,
      email: 'pat@example.com',
      displayName: 'Pat Player',
    }),
  });
}

const realFetch = globalThis.fetch;
let refreshCalls = 0;

beforeEach(() => {
  mockDbMode = 'healthy';
  mockKv.clear();
  __keychainStore.clear();
  refreshCalls = 0;
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
  globalThis.fetch = jest.fn(async (url: string) => {
    if (url.endsWith('/v1/auth/refresh')) {
      refreshCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          session: {
            accessToken: 'access-rotated',
            refreshToken: 'refresh-rotated',
            expiresAt: FAR_FUTURE_SECONDS,
          },
        }),
      } as unknown as Response;
    }
    throw new Error(`network down (${url})`);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  globalThis.fetch = realFetch;
});

describe('durable session vs. local database failure at launch', () => {
  it('control: with a healthy database the vault record restores the session', async () => {
    seedVault('refresh-1');
    await useAuthStore.getState().hydrate();
    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.session).toMatchObject({
      provider: 'apple',
      canonicalAppUserId: canonicalId,
    });
    expect(getApiSession()?.bearerToken).toBe('access-rotated');
    expect(refreshCalls).toBe(1);
  });

  it('getDb() throwing at launch must not sign out a user whose Keychain session is intact', async () => {
    seedVault('refresh-1');
    mockDbMode = 'open-throws';
    await useAuthStore.getState().hydrate();
    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    expect({
      session: state.session?.canonicalAppUserId ?? null,
      owner: getActiveDataOwner(),
      refreshCalls,
      vaultStillHolds: __keychainStore.has(SESSION_VAULT_SERVICE),
    }).toEqual({
      session: canonicalId,
      owner: expect.not.stringMatching(SIGNED_OUT_DATA_OWNER),
      refreshCalls: 1,
      vaultStillHolds: true,
    });
  });

  it('a kv read rejecting at launch must not sign out a user whose Keychain session is intact', async () => {
    seedVault('refresh-1');
    mockDbMode = 'kv-read-rejects';
    await useAuthStore.getState().hydrate();
    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    expect({
      session: state.session?.canonicalAppUserId ?? null,
      owner: getActiveDataOwner(),
      refreshCalls,
    }).toEqual({
      session: canonicalId,
      owner: expect.not.stringMatching(SIGNED_OUT_DATA_OWNER),
      refreshCalls: 1,
    });
  });
});
