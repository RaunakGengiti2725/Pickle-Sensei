/**
 * Adversarial variant of the XCF-04 case in authDurableSession.test.ts
 * (candidate fcf951d8). The candidate widens the keeper's wait for a rotation
 * answer from 15s to ROTATION_ANSWER_TIMEOUT_MS = 120s, but keeps the same
 * abort → retryable-error → "present the same refresh token again" path once
 * that deadline passes. Rotation is not idempotent: the server spends the
 * presented token when the request ARRIVES, so a rotation answer that lands
 * after the client's deadline is still dropped, and the spent token is
 * re-presented — which a live GoTrue refuses (`refresh_token_already_used`,
 * whole family revoked) → implicit sign-out of an account in good standing.
 *
 * The bug class the fix claims to close is "the rotation answer was lost
 * client-side"; only the threshold moved (15s → 120s).
 */
import { NativeModules } from 'react-native';
import type { LocalDb } from '../../src/data/db';
import { useAuthStore } from '../../src/auth/authStore';
import {
  bearerTokenFor,
  clearApiSession,
  getApiSession,
} from '../../src/account/apiSession';
import { SESSION_VAULT_SERVICE } from '../../src/account/sessionVault';
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
    hasPlayServices: jest.fn(),
    signIn: jest.fn(),
    signInSilently: jest.fn(),
    hasPreviousSignIn: jest.fn().mockReturnValue(false),
    signOut: jest.fn(),
    revokeAccess: jest.fn(),
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

jest.mock('../../src/account/deviceContext', () => ({
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

const canonicalId = '7fc2c743-028f-4ec6-942c-a84508f3be38';

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function vaultRecord(): Record<string, unknown> | null {
  const item = __keychainStore.get(SESSION_VAULT_SERVICE);
  return item ? (JSON.parse(item.password) as Record<string, unknown>) : null;
}

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

/**
 * A GoTrue-faithful refresh endpoint: the presented token is spent the moment
 * the request arrives; the answer (carrying the successor) takes `answerMs`.
 * A rotated-away token presented again after `graceMs` is reuse → the whole
 * family is revoked and the server answers 401.
 */
function rotatingRefreshRoute(answerMs: number, graceMs: number) {
  const presented: string[] = [];
  let current = 'refresh-1';
  let rotation = 1;
  const rotatedAt = new Map<string, number>();
  let revoked = false;
  const handler = (init?: RequestInit): Promise<Response> => {
    const { refreshToken } = JSON.parse(String(init?.body)) as {
      refreshToken: string;
    };
    presented.push(refreshToken);
    if (revoked) return Promise.resolve(response({}, 401));
    if (refreshToken !== current) {
      const spentAt = rotatedAt.get(refreshToken);
      if (spentAt === undefined || Date.now() - spentAt > graceMs) {
        revoked = true;
        return Promise.resolve(response({}, 401));
      }
    } else {
      rotatedAt.set(refreshToken, Date.now());
      rotation += 1;
      current = `refresh-${rotation}`;
    }
    const body = {
      session: {
        accessToken: `access-${rotation}`,
        refreshToken: current,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
    };
    return new Promise<Response>((resolve, reject) => {
      const answer = setTimeout(() => resolve(response(body)), answerMs);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(answer);
        reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      });
    });
  };
  return {
    handler,
    presented,
    wasRevoked: () => revoked,
  };
}

const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;

beforeEach(() => {
  jest.clearAllMocks();
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
});

afterEach(() => {
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  delete nativeModules.PickleAuth;
  globalThis.fetch = realFetch;
  jest.useRealTimers();
});

describe('ATTACK XCF-04: a rotation answer that lands after the keeper deadline', () => {
  it('is still adopted and the spent refresh token is never presented again (answer at 130s, deadline 120s)', async () => {
    jest.useFakeTimers();
    seedVault('refresh-1');
    const server = rotatingRefreshRoute(130_000, 10_000);
    globalThis.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/auth/refresh')) return server.handler(init);
      throw new Error(`network down (${url})`);
    }) as unknown as typeof fetch;

    const hydration = useAuthStore.getState().hydrate();
    await jest.advanceTimersByTimeAsync(8_000);
    await hydration;

    // Launched signed in with local data; the rotation request is out and the
    // server has ALREADY spent refresh-1.
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(getApiSession()).toBeNull();
    expect(server.presented).toEqual(['refresh-1']);

    // The answer arrives 130s after the request. Whatever the client-side
    // deadline is, the ONLY way to keep this account is to adopt it — the
    // server will not honour refresh-1 a second time.
    await jest.advanceTimersByTimeAsync(130_000 + 1);
    // Whatever the keeper does next, it must never re-present refresh-1 and
    // the account must still be signed in.
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect({
      presented: server.presented,
      revoked: server.wasRevoked(),
      signedIn: useAuthStore.getState().session?.canonicalAppUserId ?? null,
      owner: getActiveDataOwner(),
      vault: vaultRecord()?.refreshToken ?? null,
    }).toEqual({
      presented: ['refresh-1'],
      revoked: false,
      signedIn: canonicalId,
      owner: canonicalDataOwner(canonicalId),
      vault: 'refresh-2',
    });
    expect(getApiSession()).toMatchObject({
      bearerToken: 'access-2',
      refreshToken: 'refresh-2',
      canonicalAppUserId: canonicalId,
    });
    expect(bearerTokenFor(canonicalId)).toBe('access-2');
  });
});
