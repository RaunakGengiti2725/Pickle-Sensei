/**
 * xc-security-auth-attack-2 — the MOBILE side of "what can a modified client
 * make the server do?".
 *
 * The edge harness (supabase/functions/api/__wf__/xc-auth-attack-2-*.test.ts)
 * proves the server ignores every client-supplied identity. This file pins
 * the other half of the contract from the app's own code paths, driving the
 * REAL authStore / bootstrap / accessApi over a mocked network:
 *
 *  M1 the bootstrap request carries NO identity of any kind in its body —
 *     the only identity material is the provider bearer — and the canonical
 *     id the app adopts is the server's `user.id`, never the provider's own
 *     identifier for the user;
 *  M2 a server response whose `user.id` is not a UUID (an Apple opaque user
 *     id, a Google subject, an email) is refused outright — nothing is
 *     bound to it, nothing is persisted;
 *  M3 the restore path sends ONLY the refresh token — a tampered Keychain
 *     record cannot nominate a canonical id to the server. (Whatever the
 *     record claims stays client-local; observation recorded in the
 *     artifact, see the xc-auth-attack-2 report.)
 *  M4 the access/billing client sends no body at all — `/v1/me/access` and
 *     `/v1/billing/sync` decide from the bearer alone.
 *
 * Set XC_AUTH_ATTACK2_OUT=<dir> to also write mobile_client_identity.json.
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
import { createCanonicalAccessClient } from '../../src/billing/accessApi';
import {
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import * as Keychain from 'react-native-keychain';

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

// Node seams for the optional artifact (same shape as the other wf tests —
// the RN tsconfig has no node types).
declare const require: (id: string) => unknown;
declare const process: { env: Record<string, string | undefined> };
const fs = require('fs') as {
  mkdirSync: (p: string, options: { recursive: true }) => void;
  writeFileSync: (p: string, data: string) => void;
};
const path = require('path') as { join: (...parts: string[]) => string };

// ─── Module seams (same shape as authDurableSession.test.ts) ─────────────────

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

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SERVER_ID = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const VICTIM_ID = '22222222-2222-4222-8222-222222222222';
const APPLE_OPAQUE_USER = '001234.abcdef0123456789abcdef0123456789.1234';
const FAR_FUTURE_SECONDS = Math.floor(Date.now() / 1000) + 3600;

const IDENTITY_KEY =
  /^(user_?id|uid|sub|subject|canonical_?app_?user_?id|app_?user_?id|account_?id|owner_?id|profile_?id|authed_?id|id)$/i;

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function bootstrapBody(userId: string) {
  return {
    user: { id: userId, email: 'pat@example.com' },
    onboardingState: 'complete',
    session: {
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: FAR_FUTURE_SECONDS,
    },
  };
}

function installRoutes(
  routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>,
): jest.Mock {
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    for (const [suffix, handler] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return handler(init);
    }
    throw new Error(`network down (${url})`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** Every key path in a JSON value, e.g. "device.model". */
function keyPaths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      keyPaths(entry, `${prefix}[${index}]`),
    );
  }
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, entry]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return [path, ...keyPaths(entry, path)];
    },
  );
}

const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;

interface Observation {
  id: string;
  serverFacing: string;
  clientLocal: string;
  verdict: 'held' | 'VIOLATION';
}
const observations: Observation[] = [];

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
  mockGoogleSignin.hasPreviousSignIn.mockReturnValue(false);
  mockGoogleSignin.signInSilently.mockResolvedValue({
    type: 'noSavedCredentialFound',
    data: null,
  });
  mockGoogleSignin.hasPlayServices.mockResolvedValue(true);
  mockGoogleSignin.signOut.mockResolvedValue(null);
  mockGoogleSignin.revokeAccess.mockResolvedValue(null);
  nativeModules.PickleAuth = {
    signInWithApple: jest.fn().mockResolvedValue({
      user: APPLE_OPAQUE_USER,
      identityToken: 'apple-identity-token',
      authorizationCode: 'one-use-apple-code',
      email: 'pat@privaterelay.example',
      givenName: 'Pat',
      familyName: 'Player',
    }),
  };
  installRoutes({});
});

afterEach(() => {
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  delete nativeModules.PickleAuth;
  globalThis.fetch = realFetch;
});

afterAll(() => {
  const outDir = process.env.XC_AUTH_ATTACK2_OUT;
  if (!outDir) return;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'mobile_client_identity.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        fixtures: { SERVER_ID, VICTIM_ID, APPLE_OPAQUE_USER },
        observations,
      },
      null,
      2,
    ),
  );
});

// ─── M1 ──────────────────────────────────────────────────────────────────────

describe('M1 bootstrap: identity comes from the server response, never from the client', () => {
  it('sends no identity field in the body and adopts the server user.id (not the Apple opaque user)', async () => {
    let sentBody: unknown = null;
    let sentHeaders: Record<string, string> = {};
    installRoutes({
      '/v1/account/bootstrap': init => {
        sentBody = JSON.parse(String(init?.body));
        sentHeaders = (init?.headers ?? {}) as Record<string, string>;
        return response(bootstrapBody(SERVER_ID));
      },
    });

    await useAuthStore.getState().signInWithApple();

    const paths = keyPaths(sentBody);
    const identityPaths = paths.filter(path =>
      IDENTITY_KEY.test(path.slice(path.lastIndexOf('.') + 1)),
    );
    expect(identityPaths).toEqual([]);
    expect(JSON.stringify(sentBody)).not.toContain(APPLE_OPAQUE_USER);
    expect(JSON.stringify(sentBody)).not.toContain(SERVER_ID);
    // Only the provider bearer carries identity — and it is the ONE thing the
    // server exchanges (signInWithIdToken); nothing else in the request names
    // a user.
    expect(sentHeaders.Authorization).toBe('Bearer apple-identity-token');
    expect(Object.keys(sentHeaders).sort()).toEqual(
      [
        'Accept',
        'Authorization',
        'Content-Type',
        'X-Apple-Revocation-Protocol',
        'X-Client-Version',
      ].sort(),
    );

    const state = useAuthStore.getState();
    expect(state.error).toBeNull();
    expect(state.session?.canonicalAppUserId).toBe(SERVER_ID);
    expect(state.session?.subject).not.toBe(APPLE_OPAQUE_USER);
    expect(getApiSession()?.canonicalAppUserId).toBe(SERVER_ID);
    expect(getActiveDataOwner()).toBe(SERVER_ID);
    // The Apple opaque user identifier is not persisted anywhere as identity.
    const durable = JSON.stringify([...__keychainStore.values()]);
    expect(durable).not.toContain(APPLE_OPAQUE_USER);
    for (const value of mockKv.values()) {
      expect(value).not.toContain(APPLE_OPAQUE_USER);
    }
    observations.push({
      id: 'M1',
      serverFacing: `bootstrap body keys: ${paths.join(', ')}; Authorization = provider bearer only`,
      clientLocal: `canonicalAppUserId adopted = ${SERVER_ID} (server user.id)`,
      verdict: 'held',
    });
  });
});

// ─── M2 ──────────────────────────────────────────────────────────────────────

describe('M2 bootstrap: a non-canonical user.id from the server is refused', () => {
  it.each([
    ['Apple opaque user id', APPLE_OPAQUE_USER],
    ['Google subject', '103847562938475612345'],
    ['email', 'pat@example.com'],
    ['uuid with junk', `${SERVER_ID}; drop`],
    ['empty', ''],
  ])('%s → no session, no vault record, no data owner', async (_label, id) => {
    installRoutes({
      '/v1/account/bootstrap': () => response(bootstrapBody(id)),
    });

    await useAuthStore.getState().signInWithApple();

    const state = useAuthStore.getState();
    expect(state.session).toBeNull();
    expect(state.error).not.toBeNull();
    expect(getApiSession()).toBeNull();
    expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(false);
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    observations.push({
      id: `M2:${_label}`,
      serverFacing: 'n/a (response-side)',
      clientLocal: `user.id=${JSON.stringify(id)} refused: session null, vault empty`,
      verdict: 'held',
    });
  });
});

// ─── M3 ──────────────────────────────────────────────────────────────────────

describe('M3 restore: a tampered Keychain canonical id cannot reach the server', () => {
  it('the refresh request body is exactly {refreshToken}; the record\u2019s canonical id is never sent', async () => {
    __keychainStore.set(SESSION_VAULT_SERVICE, {
      username: 'session',
      password: JSON.stringify({
        version: 1,
        provider: 'apple',
        canonicalAppUserId: VICTIM_ID, // tampered: not the token's account
        refreshToken: 'refresh-attacker',
        email: 'pat@example.com',
        displayName: 'Pat Player',
      }),
    });
    const bodies: unknown[] = [];
    const fetchMock = installRoutes({
      '/v1/auth/refresh': init => {
        bodies.push(JSON.parse(String(init?.body)));
        return response({
          session: {
            accessToken: 'access-attacker-2',
            refreshToken: 'refresh-attacker-2',
            expiresAt: FAR_FUTURE_SECONDS,
          },
        });
      },
    });

    await useAuthStore.getState().hydrate();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodies).toEqual([{ refreshToken: 'refresh-attacker' }]);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(JSON.stringify(headers)).not.toContain(VICTIM_ID);
    expect(JSON.stringify(init.body)).not.toContain(VICTIM_ID);

    // Client-local consequence of the tampering, recorded verbatim: the app
    // scopes local data / bearer lookup to the record's id. The server still
    // resolves the account from the access token alone (edge harness), so
    // this is confined to the tampering device.
    const state = useAuthStore.getState();
    observations.push({
      id: 'M3',
      serverFacing: 'refresh body = {refreshToken} only; no id in headers/body',
      clientLocal:
        `session.canonicalAppUserId=${state.session?.canonicalAppUserId}, ` +
        `activeDataOwner=${getActiveDataOwner()}, ` +
        `bearerTokenFor(VICTIM)=${bearerTokenFor(VICTIM_ID) ? 'bearer' : 'null'}, ` +
        `bearerTokenFor(SERVER_ID)=${bearerTokenFor(SERVER_ID) ? 'bearer' : 'null'}`,
      verdict: 'held',
    });
  });
});

// ─── M4 ──────────────────────────────────────────────────────────────────────

describe('M4 access/billing client: bearer-only requests, no body', () => {
  it('GET /v1/me/access and POST /v1/billing/sync carry no identity besides the bearer', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/v1/me/access')) {
        return response({
          premium: false,
          scoredCount: 0,
          reservedCount: 0,
          freeRatings: { limit: 2, used: 0, reserved: 0, remaining: 2 },
        });
      }
      return response({
        billing: { premium: false, entitlements: [] },
        access: {
          premium: false,
          scoredCount: 0,
          reservedCount: 0,
          freeRatings: { limit: 2, used: 0, reserved: 0, remaining: 2 },
        },
      });
    };
    const client = createCanonicalAccessClient({
      baseUrl: 'https://api.example.test',
      token: 'access-1',
      fetchFn: fetchFn as never,
    });

    // Payload shapes are parsed downstream; only the OUTBOUND request is under
    // test here, so a parse rejection is fine as long as the request was made.
    await client.getAccess().catch(() => null);
    await client.syncBilling().catch(() => null);

    expect(calls.map(c => c.url)).toEqual([
      'https://api.example.test/v1/me/access',
      'https://api.example.test/v1/billing/sync',
    ]);
    for (const call of calls) {
      expect(call.init?.body).toBeUndefined();
      expect(call.init?.headers).toEqual({
        Accept: 'application/json',
        Authorization: 'Bearer access-1',
      });
    }
    observations.push({
      id: 'M4',
      serverFacing:
        'access + billing/sync: no body, headers = Accept + Authorization',
      clientLocal: 'n/a',
      verdict: 'held',
    });
  });
});
