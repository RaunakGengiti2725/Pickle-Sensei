/**
 * Adversarial ordering variant for candidate 91db4fb3's lost-delete-confirm
 * fix (XC-P2-DELETE-CONFIRM-LOST-RESPONSE).
 *
 * The fix keeps the "confirmation unresolved" fact in a Set private to
 * account/deletion.ts and only consults it when the SAME challenge is
 * retried through confirmAccountDeletion. But after a lost response the
 * first thing that learns the account is gone is usually NOT that retry:
 *   - Settings' useFocusEffect → GET /v1/me/access → 401 →
 *     reportApiUnauthorized → handleApiUnauthorized → refreshSessionNow()
 *   - or the keeper's own rotation / foreground re-check
 * → POST /v1/auth/refresh → 401 → dropRevokedSession(): signed out, Keychain
 * cleared, error null — and the deleted owner's local rows are NOT purged,
 * deletionCleanup stays null, no "Account deleted" confirmation. Exactly the
 * outcome the finding asked the fix to prevent, reached by a different
 * ordering. (Same on 4d812e1a — the candidate does not regress this, it
 * leaves it open.)
 */
import { NativeModules } from 'react-native';
import type { LocalDb } from '../../../src/data/db';
import * as Keychain from 'react-native-keychain';

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
jest.mock('../../../src/data/db', () => ({ getDb: () => mockCurrentDb() }));

const mockPurgeOwnerData = jest.fn<Promise<void>, [LocalDb, string]>(
  async () => undefined,
);
jest.mock('../../../src/data/repository', () => {
  const actual = jest.requireActual<
    typeof import('../../../src/data/repository')
  >('../../../src/data/repository');
  return {
    ...actual,
    purgeOwnerData: (db: LocalDb, owner: string) =>
      mockPurgeOwnerData(db, owner),
  };
});

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: jest.fn(),
    hasPlayServices: jest.fn().mockResolvedValue(true),
    signIn: jest.fn(),
    signInSilently: jest
      .fn()
      .mockResolvedValue({ type: 'noSavedCredentialFound', data: null }),
    hasPreviousSignIn: jest.fn().mockReturnValue(false),
    signOut: jest.fn().mockResolvedValue(null),
    revokeAccess: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock('../../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));

jest.mock('../../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.example.test',
    revenueCatPublicSdkKey: null,
    googleIosClientId: null,
    googleWebClientId: null,
    appVersion: '1.0',
  }),
}));

import { useAuthStore } from '../../../src/auth/authStore';
import {
  clearApiSession,
  getApiSession,
  reportApiUnauthorized,
} from '../../../src/account/apiSession';
import { confirmAccountDeletion } from '../../../src/account/deletion';
import { SESSION_VAULT_SERVICE } from '../../../src/account/sessionVault';
import { stopSessionKeeper } from '../../../src/account/sessionKeeper';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import { clearSyncRuntime } from '../../../src/data/syncRuntime';

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

const canonicalId = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const FAR_FUTURE_SECONDS = Math.floor(Date.now() / 1000) + 3600;

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

beforeEach(() => {
  mockKv.clear();
  mockPurgeOwnerData.mockClear();
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
    deletionCleanup: null,
  });
});

afterEach(() => {
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  delete nativeModules.PickleAuth;
  globalThis.fetch = realFetch;
});

describe('attack: lost delete-confirm response, deletion learned through the refresh path', () => {
  it('server deleted the account; the keeper (via a 401 on another route) finds out first → local owner data must still be purged and the deletion completed', async () => {
    __keychainStore.set(SESSION_VAULT_SERVICE, {
      username: 'session',
      password: JSON.stringify({
        version: 1,
        provider: 'apple',
        canonicalAppUserId: canonicalId,
        refreshToken: 'refresh-durable',
        email: 'pat@example.com',
        displayName: 'Pat Player',
      }),
    });
    let serverDeleted = false;
    globalThis.fetch = jest.fn(async (url: string) => {
      if (url.endsWith('/v1/auth/refresh')) {
        return serverDeleted
          ? response(
              { error: { message: 'The session could not be refreshed.' } },
              401,
            )
          : response({
              session: {
                accessToken: 'access-2',
                refreshToken: 'refresh-2',
                expiresAt: FAR_FUTURE_SECONDS,
              },
            });
      }
      throw new Error(`network down (${url})`);
    }) as unknown as typeof fetch;

    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    const api = getApiSession();
    expect(api).not.toBeNull();

    // Permanently delete → the server executes it, the response is lost.
    await expect(
      confirmAccountDeletion(
        api!,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        async () => {
          serverDeleted = true;
          throw new TypeError('Network request failed');
        },
      ),
    ).rejects.toMatchObject({ code: 'deletion.unavailable', retryable: true });

    // Player backs out to Settings; its access refresh answers 401 for the
    // current bearer (account gone) → keeper rotates now → refresh refused.
    reportApiUnauthorized(api!.bearerToken);
    await flush();

    const state = useAuthStore.getState();
    // The account IS gone and the app has now learned it. The finding's
    // contract: completeAccountDeletion semantics — sign out, clear the
    // Keychain, AND purge the deleted owner's local rows.
    expect(state.session).toBeNull();
    expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(false);
    expect(mockPurgeOwnerData).toHaveBeenCalledWith(
      expect.anything(),
      canonicalDataOwner(canonicalId),
    );
    expect(state.deletionCleanup).toEqual({ localPurge: 'complete' });
  });
});
