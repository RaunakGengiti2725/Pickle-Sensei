import { NativeModules } from 'react-native';
import * as Keychain from 'react-native-keychain';
import {
  captureAccountDeletionContext,
  useAuthStore,
} from '../src/auth/authStore';
import {
  clearApiSession,
  establishApiSession,
  getApiSession,
} from '../src/account/apiSession';
import * as apiRuntime from '../src/account/apiSession';
import * as accessRuntime from '../src/state/accessStore';
import * as consentRuntime from '../src/state/consentStore';
import * as trainingRuntime from '../src/training/store';
import * as syncRuntime from '../src/data/syncRuntime';
import * as billingLifecycle from '../src/billing/lifecycle';
import * as sessionKeeper from '../src/account/sessionKeeper';
import {
  SESSION_VAULT_SERVICE,
  readPersistedSession,
} from '../src/account/sessionVault';
import {
  refreshSessionNow,
  stopSessionKeeper,
} from '../src/account/sessionKeeper';
import { useAppStore, type Profile } from '../src/state/appStore';
import {
  captureDataOwnerContext,
  getActiveDataOwner,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../src/data/accountScope';
import { getKv, setKv } from '../src/data/repository';
import { clearAccessStoreConfiguration } from '../src/state/accessStore';
import {
  closeSqliteTestDatabases,
  createSqliteTestDb,
} from '../testSupport/sqlite';

let mockDatabase: ReturnType<typeof createSqliteTestDb>;
let mockDbUnavailable = false;
jest.mock('../src/data/db', () => ({
  getDb: () => {
    if (mockDbUnavailable) throw new Error('Local storage unavailable');
    return mockDatabase.db;
  },
}));
jest.mock('../src/data/syncRuntime', () => ({
  configureSyncRuntime: jest.fn(),
  clearSyncRuntime: jest.fn(),
}));
jest.mock('../src/billing/lifecycle', () => ({
  startBillingLifecycle: jest.fn(),
  stopBillingLifecycle: jest.fn(),
}));
jest.mock('../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: 'test-web-client.apps.googleusercontent.com',
  GOOGLE_IOS_CLIENT_ID: 'test-ios-client.apps.googleusercontent.com',
}));
jest.mock('../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.example.test',
    revenueCatPublicSdkKey: null,
    appVersion: '1.0',
  }),
}));
jest.mock('../src/account/deviceContext', () => ({
  getAccountBootstrapEnvironment: () => ({
    locale: 'en-US',
    timezone: 'UTC',
    device: {
      platform: 'ios',
      osVersion: '18.5',
      appVersion: '1.0',
      model: 'test',
    },
  }),
}));
const mockGoogleSignin = {
  configure: jest.fn(),
  hasPlayServices: jest.fn(),
  hasPreviousSignIn: jest.fn(),
  signInSilently: jest.fn(),
  signIn: jest.fn(),
  signOut: jest.fn(),
  revokeAccess: jest.fn(),
};
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: mockGoogleSignin,
}));
const mockPurchases = {
  configure: jest.fn(),
  logIn: jest.fn(),
  logOut: jest.fn(),
  getCustomerInfo: jest.fn(),
  purchasePackage: jest.fn(),
  purchaseProduct: jest.fn(),
  restorePurchases: jest.fn(),
  syncPurchases: jest.fn(),
};
jest.mock('react-native-purchases', () => ({
  __esModule: true,
  default: mockPurchases,
}));

const OWNER_A = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const OWNER_B = '11111111-1111-4111-8111-111111111111';
const RESTORE_KEY = 'auth.restore-state';
const GOOGLE_FLAG = JSON.stringify({ version: 1, provider: 'google' });
const HISTORICAL_PROFILE: Profile = {
  firstName: 'Pat',
  gender: 'prefer_not_to_say',
  skillLevel: '3.5',
  handedness: 'right',
  goal: 'drops',
  biggestProblem: 'control',
  focusCheckpoint: 'paddle_set',
};
const PROFILE = JSON.stringify(HISTORICAL_PROFILE);
const PENDING_PROFILE: Profile = {
  ...HISTORICAL_PROFILE,
  firstName: 'New intent',
  goal: 'drives',
  focusCheckpoint: 'preparation',
};
const PENDING = JSON.stringify({
  version: 1,
  profile: PENDING_PROFILE,
});
const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};
const nativeModules = NativeModules as { PickleAuth?: unknown };
const originalNativeAuth = nativeModules.PickleAuth;
const originalFetch = globalThis.fetch;
let appleSignIn: jest.Mock;

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn(async () => body),
  } as unknown as Response;
}

function tokens(suffix: string) {
  return {
    session: {
      accessToken: `access-${suffix}`,
      refreshToken: `refresh-${suffix}`,
      expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
    },
  };
}

function bootstrap(owner = OWNER_A, suffix = 'current') {
  return response({
    user: { id: owner, email: 'pat@example.test' },
    onboardingState: 'complete',
    ...tokens(suffix),
  });
}

function installRoutes(
  routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>,
) {
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    const route = routes[new URL(url).pathname];
    if (!route) throw new Error('Offline');
    return route(init);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function seed32d288d6Vault(provider: 'apple' | 'google' = 'apple') {
  const record = {
    version: 1,
    provider,
    canonicalAppUserId: OWNER_A,
    refreshToken: 'refresh-historical',
    email: 'pat@example.test',
    displayName: 'Pat Player',
  };
  __keychainStore.set(SESSION_VAULT_SERVICE, {
    username: 'session',
    password: JSON.stringify(record),
  });
  return record;
}

async function seedC0d6d51fLocalState(provider: 'apple' | 'google') {
  await setKv(mockDatabase.db, 'auth.local-mode', '');
  await setKv(
    mockDatabase.db,
    'auth.last-provider',
    provider === 'google' ? GOOGLE_FLAG : '',
  );
  await setKv(mockDatabase.db, `profile:${OWNER_A}`, PROFILE);
  await setKv(mockDatabase.db, 'onboarding.pending-profile', PENDING);
  await setKv(mockDatabase.db, 'onboarding.pending-notifications', 'declined');
  mockDatabase.native
    .prepare(
      'INSERT INTO local_session (owner_key, id, mode, started_at, ended_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(
      OWNER_A,
      'historical-session',
      'practice_set',
      '2026-09-01T00:00:00Z',
      null,
    );
}

async function expectOldDataUnchanged() {
  expect(await getKv(mockDatabase.db, `profile:${OWNER_A}`)).toBe(PROFILE);
  expect(await getKv(mockDatabase.db, 'onboarding.pending-profile')).toBe(
    PENDING,
  );
  expect(await getKv(mockDatabase.db, 'onboarding.pending-notifications')).toBe(
    'declined',
  );
  expect(mockDatabase.count('local_session', OWNER_A)).toBe(1);
}

async function flush() {
  for (let turn = 0; turn < 160; turn += 1) await Promise.resolve();
}

function expectNoInteractiveAuth() {
  expect(appleSignIn).not.toHaveBeenCalled();
  expect(mockGoogleSignin.signIn).not.toHaveBeenCalled();
  expect(mockGoogleSignin.hasPlayServices).not.toHaveBeenCalled();
}

function failKvWrites(shouldFail: (key: string, value: string) => boolean) {
  const execute = mockDatabase.db.execute.bind(mockDatabase.db);
  return jest
    .spyOn(mockDatabase.db, 'execute')
    .mockImplementation((sql, params = []) => {
      if (
        sql.startsWith('INSERT OR REPLACE INTO kv') &&
        shouldFail(String(params[0]), String(params[1]))
      ) {
        return Promise.reject(new Error('Persistent SQLite write failure'));
      }
      return execute(sql, params);
    });
}

function holdVaultWrite(refreshToken: string) {
  const write = Keychain.setGenericPassword;
  let release!: () => void;
  const held = new Promise<void>(resolve => {
    release = resolve;
  });
  const spy = jest
    .spyOn(Keychain, 'setGenericPassword')
    .mockImplementation(async (username, password, options) => {
      if (JSON.parse(password).refreshToken === refreshToken) await held;
      return write(username, password, options);
    });
  return { release, spy };
}

async function restartOffline() {
  stopSessionKeeper();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    hydrated: false,
    session: null,
    busy: false,
    error: null,
    restoreState: { status: 'restoring' },
  });
  installRoutes({});
  await useAuthStore.getState().hydrate();
}

async function coldRestoreOffline(action: 'hydrate' | 'signOut' = 'hydrate') {
  stopSessionKeeper();
  installRoutes({});
  jest.doMock('react-native-keychain', () => Keychain);
  let auth!: typeof import('../src/auth/authStore');
  let scope!: typeof import('../src/data/accountScope');
  let keeper!: typeof import('../src/account/sessionKeeper');
  jest.isolateModules(() => {
    auth = jest.requireActual('../src/auth/authStore');
    scope = jest.requireActual('../src/data/accountScope');
    keeper = jest.requireActual('../src/account/sessionKeeper');
  });
  try {
    await auth.useAuthStore.getState()[action]();
    return {
      state: auth.useAuthStore.getState(),
      owner: scope.getActiveDataOwner(),
    };
  } finally {
    keeper.stopSessionKeeper();
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers({ now: Date.parse('2026-09-06T00:00:00Z') });
  mockDatabase = createSqliteTestDb();
  mockDbUnavailable = false;
  __keychainStore.clear();
  stopSessionKeeper();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    hydrated: false,
    session: null,
    busy: false,
    error: null,
    restoreState: { status: 'restoring' },
  });
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    ownerContext: null,
    awaitingApiSession: false,
    profile: null,
    hydrateError: null,
  });
  appleSignIn = jest.fn(async () => ({
    user: 'untrusted-provider-subject',
    identityToken: 'apple-id-token',
    authorizationCode: 'one-use-code',
    givenName: 'Pat',
  }));
  nativeModules.PickleAuth = { signInWithApple: appleSignIn };
  mockGoogleSignin.hasPreviousSignIn.mockReturnValue(false);
  mockGoogleSignin.signInSilently.mockResolvedValue({
    type: 'noSavedCredentialFound',
    data: null,
  });
  mockGoogleSignin.signOut.mockResolvedValue(null);
  mockGoogleSignin.revokeAccess.mockResolvedValue(null);
  installRoutes({});
});

afterEach(async () => {
  stopSessionKeeper();
  clearApiSession();
  clearAccessStoreConfiguration();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  await flush();
  mockDbUnavailable = false;
  jest.restoreAllMocks();
  await useAuthStore.getState().signOut();
  closeSqliteTestDatabases();
  jest.useRealTimers();
  nativeModules.PickleAuth = originalNativeAuth;
  globalThis.fetch = originalFetch;
});

describe('historical sign-in upgrade', () => {
  it('c0d6d51f Apple has no refresh credential to migrate: offers one reconnect notice, never a fake account or erased onboarding', async () => {
    await seedC0d6d51fLocalState('apple');
    const fetchMock = installRoutes({});

    await useAuthStore.getState().hydrate();

    expect(useAuthStore.getState()).toMatchObject({
      hydrated: true,
      session: null,
      restoreState: {
        status: 'reauth_required',
        reason: 'legacy_credentials_missing',
        provider: null,
        noticePending: true,
      },
    });
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(getApiSession()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockGoogleSignin.hasPreviousSignIn).not.toHaveBeenCalled();
    expectNoInteractiveAuth();
    await expectOldDataUnchanged();

    await useAuthStore.getState().acknowledgeReturningSession();
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().restoreState).toMatchObject({
      status: 'reauth_required',
      noticePending: false,
    });
    expectNoInteractiveAuth();

    installRoutes({ '/v1/account/bootstrap': () => bootstrap() });
    await useAuthStore.getState().signInWithApple();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(OWNER_A);
    expect(useAuthStore.getState().restoreState).toEqual({
      status: 'restored',
      connectivity: 'online',
    });
    await expectOldDataUnchanged();
    await expect(readPersistedSession()).resolves.toMatchObject({
      status: 'available',
      session: { refreshToken: 'refresh-current', canonicalAppUserId: OWNER_A },
    });
  });

  it('c0d6d51f Google silently obtains a real token and verifies it with bootstrap before installing the canonical owner', async () => {
    await seedC0d6d51fLocalState('google');
    mockGoogleSignin.hasPreviousSignIn.mockReturnValue(true);
    mockGoogleSignin.signInSilently.mockResolvedValue({
      type: 'success',
      data: {
        idToken: 'silent-google-token',
        user: {
          id: 'not-a-canonical-owner',
          name: 'Pat',
          email: 'pat@example.test',
        },
      },
    });
    let release!: (value: Response) => void;
    const fetchMock = installRoutes({
      '/v1/account/bootstrap': () =>
        new Promise<Response>(resolve => {
          release = resolve;
        }),
    });
    const restore = useAuthStore.getState().hydrate();
    await flush();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(useAuthStore.getState().session).toBeNull();
    release(bootstrap());
    await restore;

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v1/account/bootstrap',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer silent-google-token',
        }),
      }),
    );
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(OWNER_A);
    await expect(readPersistedSession()).resolves.toMatchObject({
      status: 'available',
      session: { provider: 'google', canonicalAppUserId: OWNER_A },
    });
    expectNoInteractiveAuth();
    await expectOldDataUnchanged();
  });

  it('Google with no saved SDK credential requires reauthentication, not a new onboarding journey', async () => {
    await seedC0d6d51fLocalState('google');
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().restoreState).toMatchObject({
      status: 'reauth_required',
      reason: 'legacy_credentials_missing',
      provider: 'google',
    });
    expect(useAuthStore.getState().session).toBeNull();
    expectNoInteractiveAuth();
    await expectOldDataUnchanged();
  });

  it('an offline Google bootstrap stays retryable and does not consume the legacy restore flag', async () => {
    await seedC0d6d51fLocalState('google');
    mockGoogleSignin.hasPreviousSignIn.mockReturnValue(true);
    mockGoogleSignin.signInSilently.mockResolvedValue({
      type: 'success',
      data: { idToken: 'silent-google-token', user: { name: 'Pat' } },
    });
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().restoreState).toEqual({
      status: 'unavailable',
      reason: 'legacy_restore_unavailable',
    });
    expect(await getKv(mockDatabase.db, 'auth.last-provider')).toBe(
      GOOGLE_FLAG,
    );
    expectNoInteractiveAuth();
    installRoutes({ '/v1/account/bootstrap': () => bootstrap() });
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(OWNER_A);
  });

  it('a definitively rejected legacy Google token requires a real sign-in rather than pretending a retryable outage', async () => {
    await seedC0d6d51fLocalState('google');
    mockGoogleSignin.hasPreviousSignIn.mockReturnValue(true);
    mockGoogleSignin.signInSilently.mockResolvedValue({
      type: 'success',
      data: { idToken: 'refused-provider-token', user: { name: 'Pat' } },
    });
    installRoutes({
      '/v1/account/bootstrap': () =>
        response({ error: { message: 'Sign in again.' } }, 401),
    });
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().restoreState).toMatchObject({
      status: 'reauth_required',
      reason: 'legacy_credentials_missing',
      provider: 'google',
    });
    expect(useAuthStore.getState().session).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expectNoInteractiveAuth();
  });

  it('a new install with only pending onboarding is distinct from returning-account evidence', async () => {
    await setKv(mockDatabase.db, 'onboarding.pending-profile', PENDING);
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().restoreState).toEqual({
      status: 'signed_out',
      reason: 'new_install',
    });
    expect(await getKv(mockDatabase.db, 'onboarding.pending-profile')).toBe(
      PENDING,
    );
    expectNoInteractiveAuth();
  });

  it('a cached canonical profile is only a returning hint, never proof of login', async () => {
    await setKv(mockDatabase.db, `profile:${OWNER_A}`, PROFILE);
    const fetchMock = installRoutes({});
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().restoreState.status).toBe('reauth_required');
    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(fetchMock).not.toHaveBeenCalled();
    expectNoInteractiveAuth();
    expect(await getKv(mockDatabase.db, `profile:${OWNER_A}`)).toBe(PROFILE);
  });

  it.each(['apple', 'google'] as const)(
    'the 32d288d6 v1 %s vault fixture still restores without manual authentication',
    async provider => {
      await seedC0d6d51fLocalState(provider);
      seed32d288d6Vault(provider);
      const fetchMock = installRoutes({
        '/v1/auth/refresh': () => response(tokens('rotated')),
      });
      await useAuthStore.getState().hydrate();
      await flush();
      expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(OWNER_A);
      expect(useAuthStore.getState().restoreState).toEqual({
        status: 'restored',
        connectivity: 'online',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.example.test/v1/auth/refresh',
        expect.objectContaining({
          body: JSON.stringify({ refreshToken: 'refresh-historical' }),
        }),
      );
      expect(mockGoogleSignin.hasPreviousSignIn).not.toHaveBeenCalled();
      expectNoInteractiveAuth();
      await expectOldDataUnchanged();
      const kv = mockDatabase.native.prepare('SELECT value FROM kv').all();
      expect(JSON.stringify(kv)).not.toMatch(
        /refresh-historical|refresh-rotated|access-rotated/,
      );
      expect(
        Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      ).toBeDefined();
    },
  );
});

describe('persistent faults and cross-store replacement', () => {
  it('persists revocation before a delayed rotated native write drains, despite a canceled Apple attempt', async () => {
    seed32d288d6Vault();
    await useAuthStore.getState().hydrate();
    const held = holdVaultWrite('refresh-delayed-A');
    installRoutes({ '/v1/auth/refresh': () => response(tokens('delayed-A')) });
    refreshSessionNow();
    await flush();
    installRoutes({ '/v1/auth/refresh': () => response(null, 401) });
    refreshSessionNow();
    await flush();
    appleSignIn.mockRejectedValue({
      code: 'auth.canceled',
      message: 'Canceled',
    });
    await useAuthStore.getState().signInWithApple();
    const markerBeforeRelease = await getKv(mockDatabase.db, RESTORE_KEY);
    held.release();
    await flush();
    await restartOffline();
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().restoreState).toMatchObject({
      status: 'reauth_required',
      reason: 'revoked',
    });
    expect(JSON.parse(markerBeforeRelease!)).toMatchObject({
      status: 'reauth_required',
      reason: 'revoked',
    });
    const cold = await coldRestoreOffline();
    expect(cold.state.session).toBeNull();
    expect(cold.state.restoreState).toMatchObject({
      status: 'reauth_required',
      reason: 'revoked',
    });
    expect(cold.owner).toBe(SIGNED_OUT_DATA_OWNER);
  });

  it('retries an unsaved revocation after storage failure and never restores the known-revoked credential in the same process', async () => {
    seed32d288d6Vault();
    await useAuthStore.getState().hydrate();
    const metadata = failKvWrites(key => key === RESTORE_KEY);
    const vault = jest
      .spyOn(Keychain, 'resetGenericPassword')
      .mockRejectedValue(new Error('Delete failed'));
    installRoutes({ '/v1/auth/refresh': () => response(null, 401) });
    refreshSessionNow();
    await flush();
    appleSignIn.mockRejectedValue({
      code: 'auth.canceled',
      message: 'Canceled',
    });
    await useAuthStore.getState().signInWithApple();
    await restartOffline();
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState()).toMatchObject({
      restoreState: { status: 'reauth_required', reason: 'revoked' },
      error: { code: 'auth.storage_unavailable' },
    });
    metadata.mockRestore();
    vault.mockRestore();
    await restartOffline();
    const cold = await coldRestoreOffline();
    expect(cold.state.session).toBeNull();
    expect(cold.state.restoreState).toMatchObject({ reason: 'revoked' });
  });

  it('does not replay an unsaved A suppression over a successful B vault when all metadata writes still fail', async () => {
    seed32d288d6Vault();
    await useAuthStore.getState().hydrate();
    failKvWrites(key => key === RESTORE_KEY);
    jest
      .spyOn(Keychain, 'resetGenericPassword')
      .mockRejectedValue(new Error('Delete failed'));
    installRoutes({ '/v1/auth/refresh': () => response(null, 401) });
    refreshSessionNow();
    await flush();
    installRoutes({ '/v1/account/bootstrap': () => bootstrap(OWNER_B, 'B') });
    await useAuthStore.getState().signInWithApple();
    expect(useAuthStore.getState().error).toBeNull();
    await restartOffline();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(OWNER_B);
    const cold = await coldRestoreOffline();
    expect(cold.state.session?.canonicalAppUserId).toBe(OWNER_B);
  });

  it('restores the new vault offline when every final active-marker write fails', async () => {
    seed32d288d6Vault();
    await useAuthStore.getState().hydrate();
    failKvWrites(
      (key, value) =>
        key === RESTORE_KEY && JSON.parse(value).status === 'active',
    );
    installRoutes({ '/v1/account/bootstrap': () => bootstrap(OWNER_B, 'B') });
    await useAuthStore.getState().signInWithApple();
    expect(useAuthStore.getState().error).toBeNull();
    await restartOffline();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(OWNER_B);
    expect(useAuthStore.getState().restoreState).toEqual({
      status: 'restored',
      connectivity: 'offline',
    });
    const cold = await coldRestoreOffline();
    expect(cold.state.session?.canonicalAppUserId).toBe(OWNER_B);
    expect(cold.owner).toBe(OWNER_B);
  });

  it('reports a failed replacement and removes old credentials when both replacement marker and vault writes fail persistently', async () => {
    seed32d288d6Vault();
    await useAuthStore.getState().hydrate();
    failKvWrites(key => key === RESTORE_KEY);
    jest
      .spyOn(Keychain, 'setGenericPassword')
      .mockRejectedValue(new Error('Persistent vault write failure'));
    installRoutes({ '/v1/account/bootstrap': () => bootstrap(OWNER_B, 'B') });
    await useAuthStore.getState().signInWithApple();
    const error = useAuthStore.getState().error;
    expect(useAuthStore.getState().busy).toBe(false);
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(OWNER_B);
    await restartOffline();
    expect(useAuthStore.getState().session).toBeNull();
    expect(error?.code).toBe('auth.storage_unavailable');
  });

  it('never reports an unsafe replacement as durable when both stores and deletion fail persistently', async () => {
    seed32d288d6Vault();
    await useAuthStore.getState().hydrate();
    failKvWrites(key => key === RESTORE_KEY);
    jest
      .spyOn(Keychain, 'setGenericPassword')
      .mockRejectedValue(new Error('Write failed'));
    jest
      .spyOn(Keychain, 'resetGenericPassword')
      .mockRejectedValue(new Error('Delete failed'));
    installRoutes({ '/v1/account/bootstrap': () => bootstrap(OWNER_B, 'B') });
    await useAuthStore.getState().signInWithApple();
    expect(useAuthStore.getState()).toMatchObject({
      busy: false,
      error: { code: 'auth.storage_unavailable' },
    });
    expect(useAuthStore.getState().error?.message).toMatch(
      /save|remember|closing/i,
    );
  });

  it('uses a successfully written new vault even when both replacement metadata writes fail after a durable sign-out fence', async () => {
    seed32d288d6Vault();
    await useAuthStore.getState().hydrate();
    jest
      .spyOn(Keychain, 'resetGenericPassword')
      .mockRejectedValue(new Error('Delete failed'));
    await useAuthStore.getState().signOut();
    failKvWrites(key => key === RESTORE_KEY);
    installRoutes({ '/v1/account/bootstrap': () => bootstrap(OWNER_B, 'B') });
    await useAuthStore.getState().signInWithApple();
    expect(useAuthStore.getState().error).toBeNull();
    await restartOffline();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(OWNER_B);
    expect(getActiveDataOwner()).toBe(OWNER_B);
  });

  it('does not label a durable new vault as unsaved when the final metadata acknowledgement never arrives', async () => {
    const execute = mockDatabase.db.execute.bind(mockDatabase.db);
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    jest
      .spyOn(mockDatabase.db, 'execute')
      .mockImplementation((sql, params = []) => {
        if (
          sql.startsWith('INSERT OR REPLACE INTO kv') &&
          params[0] === RESTORE_KEY &&
          JSON.parse(String(params[1])).status === 'active'
        ) {
          return held.then(() => execute(sql, params));
        }
        return execute(sql, params);
      });
    installRoutes({ '/v1/account/bootstrap': () => bootstrap(OWNER_B, 'B') });
    const signIn = useAuthStore.getState().signInWithApple();
    await flush();
    await jest.advanceTimersByTimeAsync(30_000);
    const state = useAuthStore.getState();
    release();
    await signIn;
    await flush();
    await restartOffline();
    expect(state).toMatchObject({ busy: false, error: null });
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(OWNER_B);
  });

  it('never lets a late original vault deletion erase a newer owner, even after the sign-out deadline', async () => {
    seed32d288d6Vault();
    await useAuthStore.getState().hydrate();
    const reset = Keychain.resetGenericPassword;
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    jest
      .spyOn(Keychain, 'resetGenericPassword')
      .mockImplementationOnce(async options => {
        await held;
        return reset(options);
      });
    const signOut = useAuthStore.getState().signOut();
    await flush();
    await jest.advanceTimersByTimeAsync(10_000);
    const signedOut = useAuthStore.getState();
    installRoutes({ '/v1/account/bootstrap': () => bootstrap(OWNER_B, 'B') });
    const signIn = useAuthStore.getState().signInWithApple();
    await flush();
    await jest.advanceTimersByTimeAsync(10_000);
    const beforeRelease = __keychainStore.get(SESSION_VAULT_SERVICE)?.password;
    release();
    await Promise.all([signOut, signIn]);
    await flush();
    await restartOffline();
    expect(signedOut).toMatchObject({
      busy: false,
      session: null,
      error: null,
    });
    expect(JSON.parse(beforeRelease!)).toMatchObject({
      canonicalAppUserId: OWNER_A,
    });
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(OWNER_B);
  });

  it('a guest choice is durably suppressed immediately while an old native rotation remains unfinished', async () => {
    seed32d288d6Vault();
    await useAuthStore.getState().hydrate();
    const held = holdVaultWrite('refresh-late-A');
    installRoutes({ '/v1/auth/refresh': () => response(tokens('late-A')) });
    refreshSessionNow();
    await flush();
    const guest = useAuthStore.getState().continueAsGuest();
    await flush();
    await jest.advanceTimersByTimeAsync(30_000);
    const state = useAuthStore.getState();
    const marker = await getKv(mockDatabase.db, RESTORE_KEY);
    held.release();
    await guest;
    await flush();
    await restartOffline();
    expect(state).toMatchObject({
      busy: false,
      session: { provider: 'guest' },
      restoreState: { status: 'guest' },
    });
    expect(JSON.parse(marker!)).toMatchObject({ status: 'guest' });
    expect(useAuthStore.getState().session?.provider).toBe('guest');
  });

  it('does not reuse unversioned suppression as a weaker fence for an unidentified newer vault', async () => {
    __keychainStore.set(SESSION_VAULT_SERVICE, {
      username: 'session',
      password: JSON.stringify({ ...seed32d288d6Vault(), generation: 10 }),
    });
    await setKv(
      mockDatabase.db,
      RESTORE_KEY,
      JSON.stringify({
        version: 1,
        status: 'reauth_required',
        reason: 'revoked',
        provider: 'apple',
        noticePending: true,
      }),
    );
    await useAuthStore.getState().hydrate();
    await restartOffline();
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().restoreState).toMatchObject({
      status: 'reauth_required',
      reason: 'revoked',
    });
    expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(true);
  });

  it('a successful replacement remains restorable when a stale legacy guest flag cannot be cleared', async () => {
    await setKv(
      mockDatabase.db,
      'auth.local-mode',
      JSON.stringify({ version: 1, mode: 'guest' }),
    );
    failKvWrites(key => key === 'auth.local-mode');
    installRoutes({ '/v1/account/bootstrap': () => bootstrap(OWNER_B, 'B') });
    await useAuthStore.getState().signInWithApple();
    await restartOffline();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(OWNER_B);
    expect(getActiveDataOwner()).toBe(OWNER_B);
  });

  it('an empty historical local-mode row remains returning evidence even though getKv normalizes it to null', async () => {
    await setKv(mockDatabase.db, 'auth.local-mode', '');
    expect(await getKv(mockDatabase.db, 'auth.local-mode')).toBeNull();
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().restoreState).toMatchObject({
      status: 'reauth_required',
      reason: 'legacy_credentials_missing',
    });
    expect(useAuthStore.getState().session).toBeNull();
    expectNoInteractiveAuth();
  });

  it('never erases the only legacy returning hint before its non-secret replacement is durable', async () => {
    const legacy = JSON.stringify({
      provider: 'apple',
      subject: 'old-subject',
      email: 'legacy@example.test',
    });
    await setKv(mockDatabase.db, 'auth.session', legacy);
    const fault = failKvWrites(key => key === RESTORE_KEY);
    await useAuthStore.getState().hydrate();
    const remainingLegacy = await getKv(mockDatabase.db, 'auth.session');
    fault.mockRestore();
    await restartOffline();
    expect(useAuthStore.getState().restoreState.status).toBe('reauth_required');
    expect(remainingLegacy).toBe(legacy);
    expect(await getKv(mockDatabase.db, 'auth.session')).toBeNull();
    expect(await getKv(mockDatabase.db, RESTORE_KEY)).not.toMatch(
      /old-subject|legacy@example/,
    );
    const cold = await coldRestoreOffline();
    expect(cold.state.session).toBeNull();
    expect(cold.state.restoreState.status).toBe('reauth_required');
  });

  it('keeps the only Google returning hint until its replacement notice is durable', async () => {
    await setKv(mockDatabase.db, 'auth.last-provider', GOOGLE_FLAG);
    mockGoogleSignin.hasPreviousSignIn.mockReturnValue(true);
    const fault = failKvWrites(key => key === RESTORE_KEY);
    await useAuthStore.getState().hydrate();
    const remaining = await getKv(mockDatabase.db, 'auth.last-provider');
    fault.mockRestore();
    const cold = await coldRestoreOffline();
    expect(remaining).toBe(GOOGLE_FLAG);
    expect(cold.state.restoreState).toMatchObject({
      status: 'reauth_required',
      reason: 'legacy_credentials_missing',
      provider: 'google',
    });
  });

  it('finishes signed out after the storage deadline even if legacy flag cleanup stays pending', async () => {
    seed32d288d6Vault();
    await useAuthStore.getState().hydrate();
    const execute = mockDatabase.db.execute.bind(mockDatabase.db);
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    jest
      .spyOn(mockDatabase.db, 'execute')
      .mockImplementation((sql, params = []) => {
        if (
          sql.startsWith('INSERT OR REPLACE INTO kv') &&
          params[0] === 'auth.last-provider'
        )
          return held.then(() => execute(sql, params));
        return execute(sql, params);
      });
    const signOut = useAuthStore.getState().signOut();
    await flush();
    await jest.advanceTimersByTimeAsync(30_000);
    const beforeRelease = useAuthStore.getState();
    release();
    await signOut;
    expect(beforeRelease).toMatchObject({
      busy: false,
      session: null,
      error: null,
    });
    const cold = await coldRestoreOffline();
    expect(cold.state.session).toBeNull();
    expect(cold.state.restoreState).toEqual({
      status: 'signed_out',
      reason: 'user_sign_out',
    });
  });

  it('has a durable non-secret returning marker at the exact legacy scrub boundary', async () => {
    await setKv(
      mockDatabase.db,
      'auth.session',
      JSON.stringify({ provider: 'apple', subject: 'old-subject' }),
    );
    let markerAtScrub: unknown;
    mockDatabase.observeStatements(call => {
      if (
        call.sql.startsWith('INSERT OR REPLACE INTO kv') &&
        call.params[0] === 'auth.session' &&
        call.params[1] === ''
      ) {
        markerAtScrub = mockDatabase.native
          .prepare('SELECT value FROM kv WHERE key = ?')
          .get(RESTORE_KEY)?.value;
      }
    });
    await useAuthStore.getState().hydrate();
    expect(markerAtScrub).toEqual(expect.any(String));
    expect(JSON.parse(String(markerAtScrub))).toMatchObject({
      status: 'reauth_required',
      reason: 'legacy_credentials_missing',
    });
  });

  it('keeps a returning notice pending until acknowledgement actually persists', async () => {
    await seedC0d6d51fLocalState('apple');
    await useAuthStore.getState().hydrate();
    const fault = failKvWrites(key => key === RESTORE_KEY);
    await useAuthStore.getState().acknowledgeReturningSession();
    expect(useAuthStore.getState()).toMatchObject({
      restoreState: { noticePending: true },
      error: { code: 'auth.storage_unavailable' },
    });
    fault.mockRestore();
    await useAuthStore.getState().acknowledgeReturningSession();
    await restartOffline();
    expect(useAuthStore.getState().restoreState).toMatchObject({
      noticePending: false,
    });
  });

  it('an acknowledgement can durably finish a previously unsaved revocation without a later retry resetting the notice', async () => {
    seed32d288d6Vault();
    await useAuthStore.getState().hydrate();
    const metadata = failKvWrites(key => key === RESTORE_KEY);
    jest
      .spyOn(Keychain, 'resetGenericPassword')
      .mockRejectedValue(new Error('Delete failed'));
    installRoutes({ '/v1/auth/refresh': () => response(null, 401) });
    refreshSessionNow();
    await flush();
    metadata.mockRestore();
    await useAuthStore.getState().acknowledgeReturningSession();
    expect(useAuthStore.getState().restoreState).toMatchObject({
      noticePending: false,
    });
    await restartOffline();
    expect(useAuthStore.getState().restoreState).toMatchObject({
      reason: 'revoked',
      noticePending: false,
    });
    const cold = await coldRestoreOffline();
    expect(cold.state.restoreState).toMatchObject({
      reason: 'revoked',
      noticePending: false,
    });
  });

  it('does not lose an acknowledgement because an unrelated provider attempt increments the auth revision', async () => {
    await seedC0d6d51fLocalState('apple');
    await useAuthStore.getState().hydrate();
    appleSignIn.mockRejectedValue({
      code: 'auth.canceled',
      message: 'Canceled',
    });
    const acknowledge = useAuthStore.getState().acknowledgeReturningSession();
    const canceled = useAuthStore.getState().signInWithApple();
    await Promise.all([acknowledge, canceled]);
    await restartOffline();
    expect(useAuthStore.getState().restoreState).toMatchObject({
      noticePending: false,
    });
  });

  it.each(['signed_out', 'revoked'] as const)(
    'retries failed vault deletion and legacy identity scrubbing on a %s launch',
    async kind => {
      seed32d288d6Vault();
      await setKv(
        mockDatabase.db,
        'auth.session',
        JSON.stringify({ provider: 'apple', subject: 'old-subject' }),
      );
      await setKv(
        mockDatabase.db,
        RESTORE_KEY,
        JSON.stringify(
          kind === 'signed_out'
            ? { version: 1, status: 'signed_out', reason: 'user_sign_out' }
            : {
                version: 1,
                status: 'reauth_required',
                reason: 'revoked',
                provider: 'apple',
                noticePending: true,
              },
        ),
      );
      const scrubFault = failKvWrites(key => key === 'auth.session');
      const deleteFault = jest
        .spyOn(Keychain, 'resetGenericPassword')
        .mockRejectedValue(new Error('Delete failed'));
      await useAuthStore.getState().hydrate();
      expect(useAuthStore.getState().session).toBeNull();
      expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(true);
      scrubFault.mockRestore();
      deleteFault.mockRestore();
      await restartOffline();
      expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(false);
      expect(await getKv(mockDatabase.db, 'auth.session')).toBeNull();
      expect(useAuthStore.getState().session).toBeNull();
      expectNoInteractiveAuth();
    },
  );

  it('releases the UI deadline but never lets a later credential write overtake an unfinished native write', async () => {
    seed32d288d6Vault();
    await useAuthStore.getState().hydrate();
    const held = holdVaultWrite('refresh-late-A');
    installRoutes({ '/v1/auth/refresh': () => response(tokens('late-A')) });
    refreshSessionNow();
    await flush();
    installRoutes({ '/v1/account/bootstrap': () => bootstrap(OWNER_B, 'B') });
    const signInB = useAuthStore.getState().signInWithApple();
    await flush();
    await jest.advanceTimersByTimeAsync(30_000);
    const stateBeforeRelease = useAuthStore.getState();
    const writesBeforeRelease = held.spy.mock.calls.map(
      call => JSON.parse(call[1]).refreshToken,
    );
    held.release();
    await signInB;
    await flush();
    await restartOffline();
    expect(stateBeforeRelease).toMatchObject({
      busy: false,
      hydrated: true,
      error: { code: 'auth.storage_unavailable' },
    });
    expect(writesBeforeRelease).not.toContain('refresh-B');
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(OWNER_B);
    await expect(readPersistedSession()).resolves.toMatchObject({
      status: 'available',
      session: { refreshToken: 'refresh-B' },
    });
  });

  it.each(['apple', 'google'] as const)(
    'roundtrips the actual historical %s profile through auth and appStore offline without adopting pending intent',
    async provider => {
      await seedC0d6d51fLocalState(provider);
      seed32d288d6Vault(provider);
      await useAuthStore.getState().hydrate();
      await useAppStore.getState().hydrate();
      expect(useAppStore.getState()).toMatchObject({
        hydrated: true,
        ownerKey: OWNER_A,
        profile: HISTORICAL_PROFILE,
        hydrateError: null,
      });
      await expectOldDataUnchanged();
      await useAuthStore.getState().signOut();
      await useAppStore.getState().hydrate();
      expect(useAppStore.getState().profile).toBeNull();
      expect(await getKv(mockDatabase.db, `profile:${OWNER_A}`)).toBe(PROFILE);
    },
  );

  it('adopts real pending onboarding only after a verified reconnect and successful canonical save, retaining the other owner', async () => {
    await seedC0d6d51fLocalState('apple');
    const otherProfile = JSON.stringify({
      ...HISTORICAL_PROFILE,
      firstName: 'Other owner',
    });
    await setKv(mockDatabase.db, `profile:${OWNER_B}`, otherProfile);
    await useAuthStore.getState().hydrate();
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toBeNull();
    await expectOldDataUnchanged();
    installRoutes({
      '/v1/account/bootstrap': () => bootstrap(),
      '/v1/me/onboarding': () =>
        response({ recommendedCheckpoint: 'contact_position' }),
    });
    await useAuthStore.getState().signInWithApple();
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toEqual({
      ...PENDING_PROFILE,
      focusCheckpoint: 'contact_position',
    });
    expect(
      await getKv(mockDatabase.db, 'onboarding.pending-profile'),
    ).toBeNull();
    expect(await getKv(mockDatabase.db, `profile:${OWNER_B}`)).toBe(
      otherProfile,
    );
    await restartOffline();
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toEqual({
      ...PENDING_PROFILE,
      focusCheckpoint: 'contact_position',
    });
    expect(await getKv(mockDatabase.db, `profile:${OWNER_B}`)).toBe(
      otherProfile,
    );
  });
});

describe('retrying the current session persistence', () => {
  async function failedSignIn() {
    const fault = jest
      .spyOn(Keychain, 'setGenericPassword')
      .mockRejectedValue(new Error('Write failed'));
    installRoutes({
      '/v1/account/bootstrap': () => bootstrap(OWNER_A, 'retry-A'),
    });
    await useAuthStore.getState().signInWithApple();
    expect(useAuthStore.getState().error?.code).toBe(
      'auth.storage_unavailable',
    );
    const generation = JSON.parse((await getKv(mockDatabase.db, RESTORE_KEY))!)
      .generation as number;
    return { fault, generation };
  }

  it('retries failure then success with the exact session, API session, owner generation and no auth, billing, profile or analysis effects', async () => {
    await seedC0d6d51fLocalState('apple');
    const { fault, generation } = await failedSignIn();
    await useAppStore.getState().hydrate();
    const session = useAuthStore.getState().session;
    const apiSession = getApiSession();
    const owner = captureDataOwnerContext();
    const appState = useAppStore.getState();
    const restoreState = useAuthStore.getState().restoreState;
    const previousWarning = useAuthStore.getState().error;
    const effects = [
      jest.spyOn(Keychain, 'resetGenericPassword'),
      jest.spyOn(apiRuntime, 'establishApiSession'),
      jest.spyOn(apiRuntime, 'clearApiSession'),
      jest.spyOn(accessRuntime, 'configureAccessStore'),
      jest.spyOn(accessRuntime, 'clearAccessStoreConfiguration'),
      jest.spyOn(consentRuntime, 'configureConsentStore'),
      jest.spyOn(consentRuntime, 'resetConsentStore'),
      jest.spyOn(trainingRuntime, 'configureTrainingStore'),
      jest.spyOn(trainingRuntime, 'clearTrainingStoreConfiguration'),
      jest.spyOn(syncRuntime, 'configureSyncRuntime'),
      jest.spyOn(syncRuntime, 'clearSyncRuntime'),
      jest.spyOn(billingLifecycle, 'startBillingLifecycle'),
      jest.spyOn(billingLifecycle, 'stopBillingLifecycle'),
      jest.spyOn(sessionKeeper, 'startSessionKeeper'),
      jest.spyOn(sessionKeeper, 'stopSessionKeeper'),
    ];
    const fetchMock = installRoutes({});
    jest.clearAllMocks();
    const beforeCalls = mockDatabase.calls.length;
    await useAuthStore.getState().retrySessionPersistence();
    expect(useAuthStore.getState().error?.code).toBe(
      'auth.storage_unavailable',
    );
    expect(useAuthStore.getState().error).not.toBe(previousWarning);
    fault.mockRestore();
    await expect(
      useAuthStore.getState().retrySessionPersistence(),
    ).resolves.toBeUndefined();
    await flush();
    expect(useAuthStore.getState().error).toBeNull();
    expect(useAuthStore.getState().session).toBe(session);
    expect(getApiSession()).toBe(apiSession);
    expect(captureDataOwnerContext()).toEqual(owner);
    expect(useAuthStore.getState().restoreState).toBe(restoreState);
    expect(useAppStore.getState()).toBe(appState);
    expect(useAuthStore.getState().busy).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expectNoInteractiveAuth();
    for (const call of Object.values(mockGoogleSignin))
      expect(call).not.toHaveBeenCalled();
    for (const call of Object.values(mockPurchases))
      expect(call).not.toHaveBeenCalled();
    for (const effect of effects) expect(effect).not.toHaveBeenCalled();
    const writes = mockDatabase.calls
      .slice(beforeCalls)
      .filter(call => /^(INSERT|UPDATE|DELETE)/.test(call.sql));
    expect(
      writes.every(
        call =>
          call.sql.startsWith('INSERT OR REPLACE INTO kv') &&
          String(call.params[0]).startsWith('auth.'),
      ),
    ).toBe(true);
    await expect(readPersistedSession()).resolves.toMatchObject({
      status: 'available',
      session: {
        canonicalAppUserId: OWNER_A,
        refreshToken: 'refresh-retry-A',
        generation,
      },
    });
    await expectOldDataUnchanged();
    expect(
      JSON.stringify(mockDatabase.native.prepare('SELECT value FROM kv').all()),
    ).not.toMatch(/refresh-retry-A|access-retry-A|apple-id-token|one-use-code/);
  });

  it('a successful ordinary rotation clears an earlier persistence warning without changing credential generation', async () => {
    const { fault, generation } = await failedSignIn();
    const session = useAuthStore.getState().session;
    const owner = captureDataOwnerContext();
    fault.mockRestore();
    installRoutes({
      '/v1/auth/refresh': () => response(tokens('rotated-retry')),
    });
    refreshSessionNow();
    await flush();
    expect(useAuthStore.getState().error).toBeNull();
    expect(useAuthStore.getState().session).toBe(session);
    expect(captureDataOwnerContext()).toEqual(owner);
    await expect(readPersistedSession()).resolves.toMatchObject({
      status: 'available',
      session: { refreshToken: 'refresh-rotated-retry', generation },
    });
  });

  it('coalesces duplicate retries, including after the UI deadline, while an applied write has an unknown acknowledgement', async () => {
    const { fault, generation } = await failedSignIn();
    fault.mockRestore();
    const write = Keychain.setGenericPassword;
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const nativeWrite = jest
      .spyOn(Keychain, 'setGenericPassword')
      .mockImplementation(async (username, password, options) => {
        await write(username, password, options);
        await held;
        throw new Error('Write acknowledgement lost');
      });
    const first = useAuthStore.getState().retrySessionPersistence();
    const second = useAuthStore.getState().retrySessionPersistence();
    await flush();
    await jest.advanceTimersByTimeAsync(8_000);
    await Promise.all([first, second]);
    const pendingWarning = useAuthStore.getState().error;
    const callsAtDeadline = nativeWrite.mock.calls.length;
    await useAuthStore.getState().retrySessionPersistence();
    const callsAfterRetry = nativeWrite.mock.calls.length;
    release();
    await flush();
    expect(pendingWarning?.code).toBe('auth.storage_unavailable');
    expect(callsAtDeadline).toBe(1);
    expect(callsAfterRetry).toBe(1);
    expect(nativeWrite).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState()).toMatchObject({ busy: false, error: null });
    await expect(readPersistedSession()).resolves.toMatchObject({
      status: 'available',
      session: { refreshToken: 'refresh-retry-A', generation },
    });
  });

  it('reuses an unfinished initial sign-in write rather than queuing an overlapping retry', async () => {
    expect(useAuthStore.getState().retrySessionPersistence).toEqual(
      expect.any(Function),
    );
    const held = holdVaultWrite('refresh-initial');
    installRoutes({
      '/v1/account/bootstrap': () => bootstrap(OWNER_A, 'initial'),
    });
    const signIn = useAuthStore.getState().signInWithApple();
    await flush();
    await jest.advanceTimersByTimeAsync(8_000);
    await signIn;
    const retry = useAuthStore.getState().retrySessionPersistence();
    await flush();
    const calls = held.spy.mock.calls.length;
    held.release();
    await retry;
    await flush();
    expect(calls).toBe(1);
    expect(held.spy).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().error).toBeNull();
  });

  it('a late successful retry for an old token never clears the warning for a newer failed rotation', async () => {
    const { fault } = await failedSignIn();
    const previousWarning = useAuthStore.getState().error;
    fault.mockRestore();
    const write = Keychain.setGenericPassword;
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    jest
      .spyOn(Keychain, 'setGenericPassword')
      .mockImplementation(async (username, password, options) => {
        const token = JSON.parse(password).refreshToken;
        if (token === 'refresh-retry-A') await held;
        if (token === 'refresh-new-failure')
          throw new Error('New token write failed');
        return write(username, password, options);
      });
    const retry = useAuthStore.getState().retrySessionPersistence();
    await flush();
    installRoutes({
      '/v1/auth/refresh': () => response(tokens('new-failure')),
    });
    refreshSessionNow();
    await flush();
    const errors: unknown[] = [];
    const unsubscribe = useAuthStore.subscribe(state => {
      errors.push(state.error);
    });
    release();
    await retry;
    await flush();
    unsubscribe();
    expect(getApiSession()?.refreshToken).toBe('refresh-new-failure');
    expect(useAuthStore.getState().error?.code).toBe(
      'auth.storage_unavailable',
    );
    expect(useAuthStore.getState().error).not.toBe(previousWarning);
    expect(errors).not.toContain(null);
  });

  it('skips a queued retry whose token was superseded before the native write could start', async () => {
    const { fault, generation } = await failedSignIn();
    fault.mockRestore();
    const held = holdVaultWrite('refresh-retry-A');
    const firstRetry = useAuthStore.getState().retrySessionPersistence();
    await flush();
    let rotation = 0;
    installRoutes({
      '/v1/auth/refresh': () => response(tokens(`queued-${++rotation}`)),
    });
    refreshSessionNow();
    await flush();
    const supersededRetry = useAuthStore.getState().retrySessionPersistence();
    refreshSessionNow();
    await flush();
    const currentApi = getApiSession();
    held.release();
    await Promise.all([firstRetry, supersededRetry]);
    await flush();
    expect(
      held.spy.mock.calls.map(call => JSON.parse(call[1]).refreshToken),
    ).toEqual(['refresh-retry-A', 'refresh-queued-2']);
    expect(getApiSession()).toBe(currentApi);
    expect(useAuthStore.getState().error).toBeNull();
    await expect(readPersistedSession()).resolves.toMatchObject({
      status: 'available',
      session: { refreshToken: 'refresh-queued-2', generation },
    });
  });

  it.each(['auth.failed', 'auth.storage_unavailable'] as const)(
    'a pending retry preserves a newer unrelated %s error through its timeout and success',
    async code => {
      const { fault } = await failedSignIn();
      fault.mockRestore();
      const held = holdVaultWrite('refresh-retry-A');
      const retry = useAuthStore.getState().retrySessionPersistence();
      await flush();
      const unrelated = { code, message: 'A newer unrelated failure' };
      useAuthStore.setState({ error: unrelated });
      await jest.advanceTimersByTimeAsync(8_000);
      await retry;
      const atDeadline = useAuthStore.getState().error;
      held.release();
      await flush();
      expect(atDeadline).toBe(unrelated);
      expect(useAuthStore.getState().error).toBe(unrelated);
    },
  );

  it.each([OWNER_A, OWNER_B])(
    'a retry completing after a newer %s generation signs in cannot overwrite it or clear its pending warning early',
    async nextOwner => {
      const { fault } = await failedSignIn();
      fault.mockRestore();
      const held = holdVaultWrite('refresh-retry-A');
      const retry = useAuthStore.getState().retrySessionPersistence();
      await flush();
      installRoutes({
        '/v1/account/bootstrap': () => bootstrap(nextOwner, 'B'),
      });
      const signInB = useAuthStore.getState().signInWithApple();
      await flush();
      await jest.advanceTimersByTimeAsync(8_000);
      await retry;
      await signInB;
      const currentB = useAuthStore.getState().session;
      const apiB = getApiSession();
      const pendingB = useAuthStore.getState().error;
      const writesBeforeRelease = held.spy.mock.calls.map(
        call => JSON.parse(call[1]).refreshToken,
      );
      held.release();
      await flush();
      expect(pendingB?.code).toBe('auth.storage_unavailable');
      expect(writesBeforeRelease).not.toContain('refresh-B');
      expect(useAuthStore.getState().session).toBe(currentB);
      expect(getApiSession()).toBe(apiB);
      expect(useAuthStore.getState().error).toBeNull();
      await expect(readPersistedSession()).resolves.toMatchObject({
        status: 'available',
        session: { canonicalAppUserId: nextOwner, refreshToken: 'refresh-B' },
      });
    },
  );

  it('a retry is retired by revocation and cannot write an active marker or persistence warning over it', async () => {
    const { fault } = await failedSignIn();
    fault.mockRestore();
    const held = holdVaultWrite('refresh-retry-A');
    const retry = useAuthStore.getState().retrySessionPersistence();
    await flush();
    installRoutes({ '/v1/auth/refresh': () => response(null, 401) });
    refreshSessionNow();
    await flush();
    const revoked = useAuthStore.getState().restoreState;
    held.release();
    await retry;
    await flush();
    expect(useAuthStore.getState()).toMatchObject({
      session: null,
      busy: false,
      error: null,
    });
    expect(useAuthStore.getState().restoreState).toBe(revoked);
    expect(revoked).toMatchObject({
      status: 'reauth_required',
      reason: 'revoked',
    });
    expect(getApiSession()).toBeNull();
    await expect(readPersistedSession()).resolves.toEqual({ status: 'empty' });
  });

  it('retries an unfinished cross-store preparation with its already reserved credential generation', async () => {
    seed32d288d6Vault();
    await useAuthStore.getState().hydrate();
    await useAuthStore.getState().signOut();
    await setKv(
      mockDatabase.db,
      RESTORE_KEY,
      JSON.stringify({
        version: 1,
        status: 'signed_out',
        reason: 'user_sign_out',
      }),
    );
    const attemptedGenerations: number[] = [];
    const failure = failKvWrites((key, value) => {
      if (key !== RESTORE_KEY) return false;
      const record = JSON.parse(value);
      if (record.status === 'replacing')
        attemptedGenerations.push(record.generation);
      return true;
    });
    installRoutes({ '/v1/account/bootstrap': () => bootstrap(OWNER_B, 'B') });
    await useAuthStore.getState().signInWithApple();
    const session = useAuthStore.getState().session;
    const apiSession = getApiSession();
    const owner = captureDataOwnerContext();
    await useAuthStore.getState().retrySessionPersistence();
    expect(useAuthStore.getState().error?.code).toBe(
      'auth.storage_unavailable',
    );
    await expect(readPersistedSession()).resolves.toEqual({ status: 'empty' });
    failure.mockRestore();
    await useAuthStore.getState().retrySessionPersistence();
    expect(useAuthStore.getState().error).toBeNull();
    expect(useAuthStore.getState().session).toBe(session);
    expect(getApiSession()).toBe(apiSession);
    expect(captureDataOwnerContext()).toEqual(owner);
    expect(attemptedGenerations).toEqual([
      attemptedGenerations[0],
      attemptedGenerations[0],
    ]);
    await expect(readPersistedSession()).resolves.toMatchObject({
      status: 'available',
      session: { generation: attemptedGenerations[0] },
    });
    const cold = await coldRestoreOffline();
    expect(cold.state.session?.canonicalAppUserId).toBe(OWNER_B);
  });

  it('does nothing without a current matching refresh credential', async () => {
    const writes = jest.spyOn(Keychain, 'setGenericPassword');
    const fetchMock = installRoutes({});
    await useAuthStore.getState().retrySessionPersistence();
    expect(writes).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    await useAuthStore.getState().continueAsGuest();
    await useAuthStore.getState().retrySessionPersistence();
    expect(writes).not.toHaveBeenCalled();
    installRoutes({ '/v1/account/bootstrap': () => bootstrap() });
    await useAuthStore.getState().signInWithApple();
    const current = getApiSession()!;
    establishApiSession({ ...current, refreshToken: null });
    writes.mockClear();
    await useAuthStore.getState().retrySessionPersistence();
    establishApiSession({ ...current, canonicalAppUserId: OWNER_B });
    await useAuthStore.getState().retrySessionPersistence();
    expect(writes).not.toHaveBeenCalled();
  });
});

describe('storage trouble is not an empty or revoked session', () => {
  it('keeps a supported credential and its owner offline rather than requiring sign-in', async () => {
    await seedC0d6d51fLocalState('apple');
    seed32d288d6Vault();
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(OWNER_A);
    expect(useAuthStore.getState().restoreState).toEqual({
      status: 'restored',
      connectivity: 'offline',
    });
    expect(getApiSession()).toBeNull();
    await expect(readPersistedSession()).resolves.toMatchObject({
      status: 'available',
      session: { refreshToken: 'refresh-historical' },
    });
    await expectOldDataUnchanged();
    expectNoInteractiveAuth();
  });

  it('an unreadable vault never falls through to Google and can be retried without destroying its record', async () => {
    await seedC0d6d51fLocalState('google');
    const historical = seed32d288d6Vault();
    const read = jest
      .spyOn(Keychain, 'getGenericPassword')
      .mockRejectedValue(new Error('Device locked'));
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () => response(tokens('retry')),
    });
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().restoreState).toEqual({
      status: 'unavailable',
      reason: 'vault_unavailable',
    });
    expect(useAuthStore.getState().session).toBeNull();
    expect(mockGoogleSignin.hasPreviousSignIn).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      JSON.parse(__keychainStore.get(SESSION_VAULT_SERVICE)!.password),
    ).toEqual(historical);
    read.mockRestore();
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(OWNER_A);
    expectNoInteractiveAuth();
  });

  it.each([
    ['{bad-json', 'vault_invalid'],
    [
      JSON.stringify({
        version: 2,
        provider: 'apple',
        refreshToken: 'future-format',
      }),
      'vault_unsupported',
    ],
    [
      JSON.stringify({
        version: 1,
        provider: 'apple',
        canonicalAppUserId: 'provider-subject',
        refreshToken: 'not-trusted',
      }),
      'vault_invalid',
    ],
    [
      JSON.stringify({
        version: 1,
        provider: 'apple',
        canonicalAppUserId: OWNER_A,
        refreshToken: '   ',
      }),
      'vault_invalid',
    ],
  ])(
    'preserves an unsupported or invalid vault without attempting an account recovery: %s',
    async (raw, reason) => {
      __keychainStore.set(SESSION_VAULT_SERVICE, {
        username: 'session',
        password: raw!,
      });
      const fetchMock = installRoutes({});
      await useAuthStore.getState().hydrate();
      expect(useAuthStore.getState().restoreState).toEqual({
        status: 'unavailable',
        reason,
      });
      expect(__keychainStore.get(SESSION_VAULT_SERVICE)?.password).toBe(raw);
      expect(useAuthStore.getState().session).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      expectNoInteractiveAuth();
    },
  );

  it.each([
    '{bad-json',
    JSON.stringify({ version: 2, refreshToken: 'future-format' }),
  ])(
    'only an explicit verified sign-in replaces an unreadable historical vault: %s',
    async password => {
      __keychainStore.set(SESSION_VAULT_SERVICE, {
        username: 'session',
        password,
      });
      await useAuthStore.getState().hydrate();
      expect(__keychainStore.get(SESSION_VAULT_SERVICE)?.password).toBe(
        password,
      );
      installRoutes({ '/v1/account/bootstrap': () => bootstrap(OWNER_B, 'B') });
      await useAuthStore.getState().signInWithApple();
      expect(useAuthStore.getState().error).toBeNull();
      const cold = await coldRestoreOffline();
      expect(cold.state.session?.canonicalAppUserId).toBe(OWNER_B);
    },
  );

  it('an explicit sign-out before hydration suppresses a modern vault whose generation has not been read yet', async () => {
    installRoutes({ '/v1/account/bootstrap': () => bootstrap(OWNER_B, 'B') });
    await useAuthStore.getState().signInWithApple();
    const signedOut = await coldRestoreOffline('signOut');
    expect(signedOut.state.session).toBeNull();
    const cold = await coldRestoreOffline();
    expect(cold.state.session).toBeNull();
    expect(cold.state.restoreState).toEqual({
      status: 'signed_out',
      reason: 'user_sign_out',
    });
  });

  it('unreadable local restore metadata blocks resurrection without erasing a readable vault', async () => {
    const historical = seed32d288d6Vault();
    mockDbUnavailable = true;
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().restoreState).toEqual({
      status: 'unavailable',
      reason: 'local_storage_unavailable',
    });
    expect(useAuthStore.getState().session).toBeNull();
    expect(
      JSON.parse(__keychainStore.get(SESSION_VAULT_SERVICE)!.password),
    ).toEqual(historical);
    mockDbUnavailable = false;
    installRoutes({ '/v1/auth/refresh': () => response(tokens('retry')) });
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(OWNER_A);
  });
});

describe('deliberate sign-out, revocation, and account races', () => {
  it('offline user sign-out leaves a durable non-secret tombstone when Keychain deletion fails', async () => {
    await seedC0d6d51fLocalState('apple');
    seed32d288d6Vault();
    await useAuthStore.getState().hydrate();
    jest
      .spyOn(Keychain, 'resetGenericPassword')
      .mockRejectedValue(new Error('Keychain unavailable'));
    await useAuthStore.getState().signOut();
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () => response(tokens('must-not-restore')),
    });
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().restoreState).toEqual({
      status: 'signed_out',
      reason: 'user_sign_out',
    });
    expect(useAuthStore.getState().session).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockGoogleSignin.hasPreviousSignIn).not.toHaveBeenCalled();
    await expectOldDataUnchanged();
    expect(await getKv(mockDatabase.db, RESTORE_KEY)).not.toMatch(
      /refresh-|access-|7fc2c743/,
    );
  });

  it('surfaces the inability to remember sign-out when both durable stores fail, without leaving a live session', async () => {
    seed32d288d6Vault();
    await useAuthStore.getState().hydrate();
    mockDbUnavailable = true;
    jest
      .spyOn(Keychain, 'resetGenericPassword')
      .mockRejectedValue(new Error('Delete failed'));
    await useAuthStore.getState().signOut();
    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(useAuthStore.getState().error?.code).toBe(
      'auth.storage_unavailable',
    );
    expect(useAuthStore.getState().restoreState).toEqual({
      status: 'signed_out',
      reason: 'user_sign_out',
    });
  });

  it.each([401, 403])(
    'a %s refresh refusal persists the revoked reason and never invokes a provider to bypass it',
    async status => {
      await seedC0d6d51fLocalState('google');
      seed32d288d6Vault('google');
      jest
        .spyOn(Keychain, 'resetGenericPassword')
        .mockRejectedValue(new Error('Keychain unavailable'));
      const fetchMock = installRoutes({
        '/v1/auth/refresh': () => response(null, status),
      });
      await useAuthStore.getState().hydrate();
      expect(useAuthStore.getState().restoreState).toMatchObject({
        status: 'reauth_required',
        reason: 'revoked',
        provider: 'google',
        noticePending: true,
      });
      expect(useAuthStore.getState().session).toBeNull();
      await useAuthStore.getState().acknowledgeReturningSession();
      fetchMock.mockClear();
      await useAuthStore.getState().hydrate();
      expect(useAuthStore.getState().restoreState).toMatchObject({
        reason: 'revoked',
        noticePending: false,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockGoogleSignin.hasPreviousSignIn).not.toHaveBeenCalled();
      await expectOldDataUnchanged();
    },
  );

  it('a failed B credential save after a failed A sign-out deletion cannot resurrect A on relaunch', async () => {
    seed32d288d6Vault();
    await useAuthStore.getState().hydrate();
    jest
      .spyOn(Keychain, 'resetGenericPassword')
      .mockRejectedValue(new Error('Delete failed'));
    await useAuthStore.getState().signOut();
    jest
      .spyOn(Keychain, 'setGenericPassword')
      .mockRejectedValue(new Error('Write failed'));
    installRoutes({ '/v1/account/bootstrap': () => bootstrap(OWNER_B, 'B') });
    await useAuthStore.getState().signInWithApple();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(OWNER_B);
    expect(getApiSession()?.canonicalAppUserId).toBe(OWNER_B);
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () => response(tokens('A')),
    });
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().restoreState).toMatchObject({
      status: 'reauth_required',
      reason: 'credentials_missing',
      provider: 'apple',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
  });

  it.each([200, 401])(
    'ignores an A restore completing with %s after B is installed',
    async status => {
      seed32d288d6Vault();
      let release!: (value: Response) => void;
      installRoutes({
        '/v1/auth/refresh': () =>
          new Promise<Response>(resolve => {
            release = resolve;
          }),
        '/v1/account/bootstrap': () => bootstrap(OWNER_B, 'B'),
      });
      const restoreA = useAuthStore.getState().hydrate();
      await flush();
      await useAuthStore.getState().signInWithApple();
      const currentB = useAuthStore.getState().session;
      release(response(tokens('stale-A'), status));
      await jest.advanceTimersByTimeAsync(8_000);
      await restoreA;
      expect(useAuthStore.getState().session).toBe(currentB);
      expect(getActiveDataOwner()).toBe(OWNER_B);
      expect(getApiSession()?.bearerToken).toBe('access-B');
      await expect(readPersistedSession()).resolves.toMatchObject({
        status: 'available',
        session: { canonicalAppUserId: OWNER_B, refreshToken: 'refresh-B' },
      });
      expect(useAuthStore.getState().restoreState).toEqual({
        status: 'restored',
        connectivity: 'online',
      });
      expect(
        JSON.parse((await getKv(mockDatabase.db, RESTORE_KEY))!),
      ).toMatchObject({ status: 'active' });
    },
  );

  it('a confirmed deletion of the current owner leaves a deletion tombstone even when the vault cannot be read or cleared', async () => {
    installRoutes({ '/v1/account/bootstrap': () => bootstrap() });
    await useAuthStore.getState().signInWithApple();
    const context = captureAccountDeletionContext();
    const read = jest
      .spyOn(Keychain, 'getGenericPassword')
      .mockRejectedValue(new Error('Device locked'));
    jest
      .spyOn(Keychain, 'resetGenericPassword')
      .mockRejectedValue(new Error('Delete failed'));
    await useAuthStore.getState().completeAccountDeletion(context);
    read.mockRestore();
    const fetchMock = installRoutes({});
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().restoreState).toEqual({
      status: 'signed_out',
      reason: 'account_deleted',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a late vault read for A cannot replace a newer verified B session', async () => {
    const historical = seed32d288d6Vault();
    let release!: (
      value: Awaited<ReturnType<typeof Keychain.getGenericPassword>>,
    ) => void;
    jest.spyOn(Keychain, 'getGenericPassword').mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = resolve;
        }),
    );
    installRoutes({ '/v1/account/bootstrap': () => bootstrap(OWNER_B, 'B') });
    const restoreA = useAuthStore.getState().hydrate();
    await flush();
    await useAuthStore.getState().signInWithApple();
    const currentB = useAuthStore.getState().session;
    release({
      username: 'session',
      password: JSON.stringify(historical),
      service: SESSION_VAULT_SERVICE,
      storage: 'KeychainMock' as Keychain.STORAGE_TYPE,
    });
    await restoreA;
    expect(useAuthStore.getState().session).toBe(currentB);
    expect(getApiSession()?.canonicalAppUserId).toBe(OWNER_B);
    await expect(readPersistedSession()).resolves.toMatchObject({
      status: 'available',
      session: { canonicalAppUserId: OWNER_B },
    });
  });

  it('a delayed returning-notice acknowledgement cannot overwrite B restore metadata', async () => {
    await seedC0d6d51fLocalState('apple');
    await useAuthStore.getState().hydrate();
    const execute = mockDatabase.db.execute.bind(mockDatabase.db);
    let release!: () => void;
    jest
      .spyOn(mockDatabase.db, 'execute')
      .mockImplementation((sql, params = []) => {
        if (
          sql.startsWith('INSERT OR REPLACE INTO kv') &&
          params[0] === RESTORE_KEY &&
          String(params[1]).includes('legacy_credentials_missing')
        ) {
          return new Promise<void>(resolve => {
            release = resolve;
          }).then(() => execute(sql, params));
        }
        return execute(sql, params);
      });
    const acknowledge = useAuthStore.getState().acknowledgeReturningSession();
    await flush();
    installRoutes({ '/v1/account/bootstrap': () => bootstrap(OWNER_B, 'B') });
    const signInB = useAuthStore.getState().signInWithApple();
    await flush();
    release();
    await acknowledge;
    await signInB;
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(OWNER_B);
    expect(useAuthStore.getState().restoreState).toEqual({
      status: 'restored',
      connectivity: 'online',
    });
    expect(JSON.parse((await getKv(mockDatabase.db, RESTORE_KEY))!)).toEqual({
      version: 1,
      generation: expect.any(Number),
      status: 'active',
      provider: 'apple',
    });
  });

  it.each([OWNER_A, OWNER_B])(
    'a late deletion cannot change a newer signed-out generation or erase its vault (%s)',
    async nextOwner => {
      installRoutes({
        '/v1/account/bootstrap': () => bootstrap(OWNER_A, 'original-A'),
      });
      await useAuthStore.getState().signInWithApple();
      const deletion = captureAccountDeletionContext();
      installRoutes({
        '/v1/account/bootstrap': () => bootstrap(nextOwner, 'new'),
      });
      await useAuthStore.getState().signInWithApple();
      jest
        .spyOn(Keychain, 'resetGenericPassword')
        .mockRejectedValue(new Error('Delete failed'));
      await useAuthStore.getState().signOut();
      const before = useAuthStore.getState();
      const vault = __keychainStore.get(SESSION_VAULT_SERVICE);
      const marker = await getKv(mockDatabase.db, RESTORE_KEY);
      await useAuthStore.getState().completeAccountDeletion(deletion);
      expect(useAuthStore.getState()).toBe(before);
      expect(__keychainStore.get(SESSION_VAULT_SERVICE)).toEqual(vault);
      expect(await getKv(mockDatabase.db, RESTORE_KEY)).toBe(marker);
    },
  );

  it('late A deletion preserves B credentials and its restore metadata', async () => {
    installRoutes({ '/v1/account/bootstrap': () => bootstrap(OWNER_A, 'A') });
    await useAuthStore.getState().signInWithApple();
    const deletion = captureAccountDeletionContext();
    installRoutes({ '/v1/account/bootstrap': () => bootstrap(OWNER_B, 'B') });
    await useAuthStore.getState().signInWithApple();
    await useAuthStore.getState().completeAccountDeletion(deletion);
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(OWNER_B);
    await expect(readPersistedSession()).resolves.toMatchObject({
      status: 'available',
      session: { canonicalAppUserId: OWNER_B },
    });
    expect(
      JSON.parse((await getKv(mockDatabase.db, RESTORE_KEY))!),
    ).toMatchObject({ status: 'active' });
  });
});
