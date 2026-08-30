/**
 * Persistent Google login — hydrate() silent-restore paths.
 *
 * The kv flag 'auth.last-provider' stores ONLY a provider name
 * ({"version":1,"provider":"google"}); identity tokens are never persisted.
 * Hydrate silently restores a Google session via
 * GoogleSignin.hasPreviousSignIn()/signInSilently() and the real
 * bootstrapCanonicalAccount over a mocked fetch. Apple has no silent path
 * (its identity tokens are only issued interactively), so only guest and
 * Google flows are exercised here.
 *
 * Mock style follows the existing suites: in-memory kv-backed LocalDb like
 * analyzeScreenFullFlowE2E's recording db, module mocks for the Google SDK,
 * and a jest.fn fetch for the bootstrap exchange.
 */
import type { LocalDb } from '../src/data/db';
import { useAuthStore } from '../src/auth/authStore';
import { clearApiSession, getApiSession } from '../src/account/apiSession';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../src/data/accountScope';
import { clearSyncRuntime } from '../src/data/syncRuntime';

// ─── Module seams ────────────────────────────────────────────────────────────

// In-memory kv map behind the same SQL the real repository issues.
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
      // Anything else (e.g. the sync runtime draining an empty outbox).
      return { rows: [] };
    },
    close() {},
  };
}
jest.mock('../src/data/db', () => ({ getDb: () => mockCurrentDb() }));

const mockGoogleSignin = {
  configure: jest.fn(),
  hasPlayServices: jest.fn(),
  signIn: jest.fn(),
  signInSilently: jest.fn(),
  hasPreviousSignIn: jest.fn(),
  signOut: jest.fn(),
};
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: mockGoogleSignin,
}));

// Silent restore requires a configured web client id (backend-verifiable
// token audience); the interactive iOS path also needs the iOS client id.
jest.mock('../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: 'test-web-client.apps.googleusercontent.com',
  GOOGLE_IOS_CLIENT_ID: 'test-ios-client.apps.googleusercontent.com',
}));

jest.mock('../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.example.test',
    revenueCatPublicSdkKey: null,
    googleIosClientId: 'test-ios-client.apps.googleusercontent.com',
    googleWebClientId: 'test-web-client.apps.googleusercontent.com',
    appVersion: '1.0',
  }),
}));

// Fixed runtime device context (Platform.constants is not fully populated
// under jest); the bootstrap request body is not under test here.
jest.mock('../src/account/deviceContext', () => ({
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

const LOCAL_MODE_KEY = 'auth.local-mode';
const LAST_PROVIDER_KEY = 'auth.last-provider';
const GUEST_FLAG = JSON.stringify({ version: 1, mode: 'guest' });
const GOOGLE_FLAG = JSON.stringify({ version: 1, provider: 'google' });

const canonicalId = '7fc2c743-028f-4ec6-942c-a84508f3be38';

function googleUser(idToken: string | null) {
  return {
    user: {
      id: 'google-uid-1',
      name: 'Pat Player',
      email: 'pat@gmail.example',
      photo: null,
      familyName: 'Player',
      givenName: 'Pat',
    },
    scopes: [],
    idToken,
    serverAuthCode: null,
  };
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

const sessionExpiresAt = Math.floor(Date.now() / 1000) + 3600;

function bootstrapSuccessFetch(): jest.Mock {
  return jest.fn().mockResolvedValue(
    response({
      user: { id: canonicalId, email: 'pat@example.com' },
      onboardingState: 'complete',
      session: {
        accessToken: 'supabase-access-token',
        refreshToken: 'supabase-refresh-token',
        expiresAt: sessionExpiresAt,
      },
    }),
  );
}

const realFetch = globalThis.fetch;

function installFetch(fetchMock: jest.Mock): void {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockKv.clear();
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    hydrated: false,
    session: null,
    busy: false,
    error: null,
  });
  // Defaults: no silent session anywhere unless a test opts in.
  mockGoogleSignin.hasPreviousSignIn.mockReturnValue(false);
  mockGoogleSignin.signInSilently.mockResolvedValue({
    type: 'noSavedCredentialFound',
    data: null,
  });
  mockGoogleSignin.hasPlayServices.mockResolvedValue(true);
  mockGoogleSignin.signIn.mockResolvedValue({ type: 'cancelled', data: null });
  mockGoogleSignin.signOut.mockResolvedValue(null);
  installFetch(
    jest.fn().mockRejectedValue(new Error('fetch not configured in test')),
  );
});

afterEach(() => {
  clearSyncRuntime();
  clearApiSession();
  globalThis.fetch = realFetch;
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('authStore hydrate silent restore', () => {
  it('guest restore is unchanged: guest flag wins and Google is never consulted', async () => {
    mockKv.set(LOCAL_MODE_KEY, GUEST_FLAG);
    mockKv.set(LAST_PROVIDER_KEY, GOOGLE_FLAG); // stale flag must be ignored

    await useAuthStore.getState().hydrate();

    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.session).toMatchObject({
      provider: 'guest',
      subject: 'local-only',
      canonicalAppUserId: null,
      localOnly: true,
    });
    expect(getActiveDataOwner()).toBe(GUEST_DATA_OWNER);
    expect(mockGoogleSignin.hasPreviousSignIn).not.toHaveBeenCalled();
    expect(mockGoogleSignin.signInSilently).not.toHaveBeenCalled();
  });

  it('last-provider google + silent success restores the session with the canonical id from bootstrap', async () => {
    mockKv.set(LAST_PROVIDER_KEY, GOOGLE_FLAG);
    mockGoogleSignin.hasPreviousSignIn.mockReturnValue(true);
    mockGoogleSignin.signInSilently.mockResolvedValue({
      type: 'success',
      data: googleUser('silent-google-id-token'),
    });
    const fetchMock = bootstrapSuccessFetch();
    installFetch(fetchMock);

    await useAuthStore.getState().hydrate();

    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.error).toBeNull();
    expect(state.session).toEqual({
      provider: 'google',
      subject: canonicalId,
      canonicalAppUserId: canonicalId,
      localOnly: false,
      displayName: 'Pat Player',
      email: 'pat@example.com',
    });

    // The silent token was exchanged with the real bootstrap client…
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v1/account/bootstrap',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer silent-google-id-token',
        }),
      }),
    );
    // …and the resulting API bearer is the revocable Supabase access token,
    // NOT the provider ID token (spent by the one-time exchange).
    expect(getApiSession()).toMatchObject({
      bearerToken: 'supabase-access-token',
      refreshToken: 'supabase-refresh-token',
      canonicalAppUserId: canonicalId,
      provider: 'google',
    });
    expect(getActiveDataOwner()).toBe(canonicalId);
    // …the flag stays armed for the next launch, and no kv value ever holds
    // provider or session token material.
    expect(mockKv.get(LAST_PROVIDER_KEY)).toBe(GOOGLE_FLAG);
    for (const value of mockKv.values()) {
      expect(value).not.toContain('silent-google-id-token');
      expect(value).not.toContain('supabase-access-token');
      expect(value).not.toContain('supabase-refresh-token');
    }
    expect(mockGoogleSignin.configure.mock.calls[0]?.[0]).toMatchObject({
      webClientId: 'test-web-client.apps.googleusercontent.com',
    });
  });

  it('silent noSavedCredentialFound lands signed out AND clears the flag', async () => {
    mockKv.set(LAST_PROVIDER_KEY, GOOGLE_FLAG);
    mockGoogleSignin.hasPreviousSignIn.mockReturnValue(true);
    mockGoogleSignin.signInSilently.mockResolvedValue({
      type: 'noSavedCredentialFound',
      data: null,
    });
    const fetchMock = bootstrapSuccessFetch();
    installFetch(fetchMock);

    await useAuthStore.getState().hydrate();

    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.session).toBeNull();
    expect(state.error).toBeNull();
    // Definitive answer from the SDK: stop retrying on future launches.
    expect(mockKv.get(LAST_PROVIDER_KEY)).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getApiSession()).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
  });

  it('silent success with a bootstrap network failure lands signed out, keeps the flag, and surfaces no error', async () => {
    mockKv.set(LAST_PROVIDER_KEY, GOOGLE_FLAG);
    mockGoogleSignin.hasPreviousSignIn.mockReturnValue(true);
    mockGoogleSignin.signInSilently.mockResolvedValue({
      type: 'success',
      data: googleUser('silent-google-id-token'),
    });
    installFetch(jest.fn().mockRejectedValue(new Error('network down')));

    await expect(useAuthStore.getState().hydrate()).resolves.toBeUndefined();

    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.session).toBeNull();
    expect(state.error).toBeNull();
    // Transient failure: the next launch retries silently.
    expect(mockKv.get(LAST_PROVIDER_KEY)).toBe(GOOGLE_FLAG);
    expect(getApiSession()).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
  });

  it('silent success without an idToken stays signed out and never calls bootstrap', async () => {
    mockKv.set(LAST_PROVIDER_KEY, GOOGLE_FLAG);
    mockGoogleSignin.hasPreviousSignIn.mockReturnValue(true);
    mockGoogleSignin.signInSilently.mockResolvedValue({
      type: 'success',
      data: googleUser(null),
    });
    const fetchMock = bootstrapSuccessFetch();
    installFetch(fetchMock);

    await useAuthStore.getState().hydrate();

    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.session).toBeNull();
    expect(state.error).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    // No verifiable token this launch; the flag stays for the next attempt.
    expect(mockKv.get(LAST_PROVIDER_KEY)).toBe(GOOGLE_FLAG);
  });

  it('no previous SDK sign-in skips signInSilently and stays signed out with the flag kept', async () => {
    mockKv.set(LAST_PROVIDER_KEY, GOOGLE_FLAG);
    mockGoogleSignin.hasPreviousSignIn.mockReturnValue(false);

    await useAuthStore.getState().hydrate();

    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.session).toBeNull();
    expect(mockGoogleSignin.signInSilently).not.toHaveBeenCalled();
    expect(mockKv.get(LAST_PROVIDER_KEY)).toBe(GOOGLE_FLAG);
  });

  it('interactive Google sign-in writes the flag and signOut revokes and clears it', async () => {
    mockGoogleSignin.signIn.mockResolvedValue({
      type: 'success',
      data: googleUser('interactive-google-id-token'),
    });
    const fetchMock = bootstrapSuccessFetch();
    installFetch(fetchMock);

    await useAuthStore.getState().signInWithGoogle();
    expect(useAuthStore.getState().error).toBeNull();
    expect(useAuthStore.getState().session?.subject).toBe(canonicalId);
    expect(mockKv.get(LAST_PROVIDER_KEY)).toBe(GOOGLE_FLAG);

    await useAuthStore.getState().signOut();

    // Sign-out revoked the application session server-side, bearing the
    // Supabase access token — not just forgotten locally.
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v1/auth/logout',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer supabase-access-token',
        }),
      }),
    );

    const state = useAuthStore.getState();
    expect(state.session).toBeNull();
    expect(mockKv.get(LAST_PROVIDER_KEY)).toBe('');
    expect(mockGoogleSignin.signOut).toHaveBeenCalled();
    expect(getApiSession()).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);

    // Next launch after sign-out: no silent restore attempt at all.
    mockGoogleSignin.hasPreviousSignIn.mockClear();
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session).toBeNull();
    expect(mockGoogleSignin.hasPreviousSignIn).not.toHaveBeenCalled();
  });
});
