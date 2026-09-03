/**
 * Guest / local-only flow — store layer, driven the way the screens drive it.
 *
 * A guest (`auth.local-mode` = {"version":1,"mode":"guest"}) owns the
 * `device-guest` data bucket, has NO API session and NO billing
 * configuration, so nothing in the app can 401-loop on its behalf: the
 * access store answers `unconfigured` without a network call and the
 * training/consent surfaces refuse before fetching. Connecting an account
 * from a guest session must leave the guest intact on cancel and on every
 * failure branch, and must only flip owner / API / billing after the
 * canonical bootstrap succeeded. Signing out of a guest clears the guest flag
 * and lands on the signed-out owner (no reads, no writes).
 */
import type { LocalDb } from '../../src/data/db';
import { useAuthStore } from '../../src/auth/authStore';
import { clearApiSession, getApiSession } from '../../src/account/apiSession';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  getActiveDataOwner,
  profileKeyForOwner,
  requireWritableDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import {
  clearAccessStoreConfiguration,
  useAccessStore,
} from '../../src/state/accessStore';
import {
  PENDING_ONBOARDING_PROFILE_KV_KEY,
  useAppStore,
} from '../../src/state/appStore';
import { useConsentStore } from '../../src/state/consentStore';
import type { Profile } from '../../src/state/profile';

// ─── Module seams ────────────────────────────────────────────────────────────

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
    revenueCatPublicSdkKey: 'appl_test_public_key',
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

// RevenueCat SDK double, injected through the real billing factory so the
// canonical-account bootstrap path is exercised end-to-end (the native module
// is loaded via dynamic import, which Jest's CJS runtime cannot evaluate).
const mockPurchases = {
  isConfigured: jest.fn(async () => false),
  configure: jest.fn<Promise<void>, [{ apiKey: string; appUserID: string }]>(
    async () => undefined,
  ),
  getAppUserID: jest.fn(async () => 'anon'),
  logIn: jest.fn<Promise<void>, [string]>(async () => undefined),
  getOfferings: jest.fn(async () => ({ current: null, all: {} })),
  getCustomerInfo: jest.fn(async () => ({ entitlements: { active: {} } })),
};
const mockBillingConfigs: Array<Record<string, unknown>> = [];
jest.mock('../../src/billing', () => {
  const actual =
    jest.requireActual<typeof import('../../src/billing')>('../../src/billing');
  return {
    ...actual,
    createBillingAccessDependencies: (
      config: Parameters<typeof actual.createBillingAccessDependencies>[0],
    ) => {
      mockBillingConfigs.push({ ...config });
      return actual.createBillingAccessDependencies({
        ...config,
        revenueCatSdk: mockPurchases as never,
      });
    },
  };
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

const LOCAL_MODE_KEY = 'auth.local-mode';
const LAST_PROVIDER_KEY = 'auth.last-provider';
const GUEST_FLAG = JSON.stringify({ version: 1, mode: 'guest' });
const GOOGLE_FLAG = JSON.stringify({ version: 1, provider: 'google' });
const canonicalId = '7fc2c743-028f-4ec6-942c-a84508f3be38';

const answers: Profile = {
  firstName: 'Dana',
  gender: 'female',
  skillLevel: '3.5',
  handedness: 'right',
  goal: 'drops',
  biggestProblem: 'control',
  focusCheckpoint: 'paddle_set',
};

function googleSuccess(idToken: string | null = 'google-id-token') {
  return {
    type: 'success' as const,
    data: {
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
    },
  };
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

const realFetch = globalThis.fetch;
function installFetch(fetchMock: jest.Mock): void {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
}

function resetStores() {
  clearSyncRuntime();
  clearApiSession();
  clearAccessStoreConfiguration();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    hydrated: false,
    session: null,
    busy: false,
    error: null,
  });
  useAccessStore.getState().reset();
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
    onboardingBusy: false,
    onboardingError: null,
    lastShotType: 'forehand_drive',
  });
}

async function becomeGuest() {
  await useAuthStore.getState().continueAsGuest();
  expect(getActiveDataOwner()).toBe(GUEST_DATA_OWNER);
}

function expectGuestIntact() {
  const state = useAuthStore.getState();
  expect(state.session).toMatchObject({
    provider: 'guest',
    subject: 'local-only',
    canonicalAppUserId: null,
    localOnly: true,
  });
  expect(state.busy).toBe(false);
  expect(getActiveDataOwner()).toBe(GUEST_DATA_OWNER);
  expect(getApiSession()).toBeNull();
  expect(mockKv.get(LOCAL_MODE_KEY)).toBe(GUEST_FLAG);
  expect(mockKv.get(LAST_PROVIDER_KEY) ?? '').toBe('');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockKv.clear();
  mockBillingConfigs.length = 0;
  resetStores();
  mockGoogleSignin.hasPreviousSignIn.mockReturnValue(false);
  mockGoogleSignin.signInSilently.mockResolvedValue({
    type: 'noSavedCredentialFound',
    data: null,
  });
  mockGoogleSignin.hasPlayServices.mockResolvedValue(true);
  mockGoogleSignin.signIn.mockResolvedValue({ type: 'cancelled', data: null });
  mockGoogleSignin.signOut.mockResolvedValue(null);
  mockPurchases.isConfigured.mockResolvedValue(false);
  mockPurchases.getAppUserID.mockResolvedValue('anon');
  installFetch(
    jest.fn().mockRejectedValue(new Error('fetch not configured in test')),
  );
});

afterEach(() => {
  resetStores();
  globalThis.fetch = realFetch;
});

// ─── Guest session shape, persistence, hydration ─────────────────────────────

describe('guest session: creation, persistence and restore', () => {
  it('continueAsGuest owns the device-guest bucket, persists the flag and holds no API/billing material', async () => {
    await becomeGuest();

    expectGuestIntact();
    expect(useAuthStore.getState().session?.displayName).toBeNull();
    expect(useAuthStore.getState().session?.email).toBeNull();
    // Writable: local reads/writes are allowed for a guest.
    expect(requireWritableDataOwner()).toBe(GUEST_DATA_OWNER);
  });

  it('hydrate restores the guest from the flag alone and never consults Google or the network', async () => {
    mockKv.set(LOCAL_MODE_KEY, GUEST_FLAG);
    mockKv.set(LAST_PROVIDER_KEY, GOOGLE_FLAG);
    const fetchMock = jest.fn();
    installFetch(fetchMock);

    await useAuthStore.getState().hydrate();

    expect(useAuthStore.getState().hydrated).toBe(true);
    expect(useAuthStore.getState().session).toMatchObject({
      provider: 'guest',
      localOnly: true,
    });
    expect(getActiveDataOwner()).toBe(GUEST_DATA_OWNER);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockGoogleSignin.signInSilently).not.toHaveBeenCalled();
    expect(getApiSession()).toBeNull();
  });

  it('a device without the guest flag hydrates signed out (guest is never invented)', async () => {
    await useAuthStore.getState().hydrate();

    expect(useAuthStore.getState().hydrated).toBe(true);
    expect(useAuthStore.getState().session).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(() => requireWritableDataOwner()).toThrow();
  });
});

// ─── No 401 loops: a guest has nothing to call the backend with ──────────────

describe('guest session: gated backend features answer honestly without a request', () => {
  it('accessStore.initialize lands on `unconfigured` with copy and never touches the network or RevenueCat', async () => {
    await becomeGuest();
    const fetchMock = jest.fn();
    installFetch(fetchMock);

    await useAccessStore.getState().initialize();
    // Second call (e.g. a re-focused screen) is idempotent — no loop.
    await useAccessStore.getState().initialize();

    const access = useAccessStore.getState();
    expect(access.status).toBe('unconfigured');
    expect(access.canonicalAccess).toBeNull();
    expect(access.error).toMatchObject({ code: 'billing.unconfigured' });
    expect(access.error?.message).toBe(
      'Billing has not been connected to this signed-in account.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockBillingConfigs).toHaveLength(0);
    expect(mockPurchases.configure).not.toHaveBeenCalled();
    expect(mockPurchases.logIn).not.toHaveBeenCalled();
  });

  it('purchase/restore/sync are refused for a guest without any request and leave the operation idle', async () => {
    await becomeGuest();
    const fetchMock = jest.fn();
    installFetch(fetchMock);

    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      false,
    );
    await expect(useAccessStore.getState().restorePurchases()).resolves.toBe(
      false,
    );
    await expect(useAccessStore.getState().syncBilling()).resolves.toBe(false);

    expect(useAccessStore.getState().operation).toBe('idle');
    expect(useAccessStore.getState().status).toBe('unconfigured');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockPurchases.configure).not.toHaveBeenCalled();
  });

  it('consentStore hydrates to signed-out for a guest and a toggle attempt is a no-op', async () => {
    await becomeGuest();
    const fetchMock = jest.fn();
    installFetch(fetchMock);

    await useConsentStore.getState().hydrate();
    expect(useConsentStore.getState().availability).toBe('signed_out');
    await useConsentStore.getState().setModelTrainingConsent(true);

    expect(useConsentStore.getState().modelTrainingActive).toBe(false);
    expect(useConsentStore.getState().busy).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── Guest data adoption and isolation ───────────────────────────────────────

describe('guest data: legacy/pre-auth adoption and isolation from canonical owners', () => {
  it('the guest adopts the pre-auth questionnaire once; the stash is consumed and no device-level marker is left behind', async () => {
    mockKv.set(
      PENDING_ONBOARDING_PROFILE_KV_KEY,
      JSON.stringify({ version: 1, profile: answers }),
    );
    await becomeGuest();

    await useAppStore.getState().hydrate();

    expect(useAppStore.getState().ownerKey).toBe(GUEST_DATA_OWNER);
    expect(useAppStore.getState().profile).toEqual(answers);
    expect(mockKv.get(profileKeyForOwner(GUEST_DATA_OWNER))).toBe(
      JSON.stringify(answers),
    );
    expect(mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBe('');
    // The (emptied) stash is the only device-level onboarding row: the
    // "device onboarded" marker was removed 2026-09-01 so the launch gate can
    // never consult device history.
    expect(
      [...mockKv.keys()].filter(key => key.startsWith('onboarding.')),
    ).toEqual([PENDING_ONBOARDING_PROFILE_KV_KEY]);
    expect(useAppStore.getState()).not.toHaveProperty('preAuthOnboarded');
  });

  it('a freshly answered stash replaces an existing guest profile (newest intent wins)', async () => {
    const existing: Profile = {
      skillLevel: '4.0',
      handedness: 'left',
      goal: 'serve',
      biggestProblem: 'power',
      focusCheckpoint: 'sequencing',
    };
    mockKv.set(profileKeyForOwner(GUEST_DATA_OWNER), JSON.stringify(existing));
    mockKv.set(
      PENDING_ONBOARDING_PROFILE_KV_KEY,
      JSON.stringify({ version: 1, profile: answers }),
    );
    await becomeGuest();

    await useAppStore.getState().hydrate();

    expect(useAppStore.getState().profile).toEqual(answers);
    expect(mockKv.get(profileKeyForOwner(GUEST_DATA_OWNER))).toBe(
      JSON.stringify(answers),
    );
    expect(mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBe('');
  });

  it('the guest adopts the legacy unscoped `profile` row and clears it', async () => {
    mockKv.set('profile', JSON.stringify(answers));
    await becomeGuest();

    await useAppStore.getState().hydrate();

    expect(useAppStore.getState().profile).toEqual(answers);
    expect(mockKv.get(profileKeyForOwner(GUEST_DATA_OWNER))).toBe(
      JSON.stringify(answers),
    );
    expect(mockKv.get('profile')).toBe('');
  });

  it('a guest profile never leaks into a canonical owner bucket and vice versa', async () => {
    mockKv.set(profileKeyForOwner(GUEST_DATA_OWNER), JSON.stringify(answers));
    mockKv.set(
      profileKeyForOwner(canonicalDataOwner(canonicalId)),
      JSON.stringify({ ...answers, firstName: 'Canon' }),
    );

    await becomeGuest();
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile?.firstName).toBe('Dana');

    setActiveDataOwner(canonicalDataOwner(canonicalId));
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().ownerKey).toBe(
      canonicalDataOwner(canonicalId),
    );
    expect(useAppStore.getState().profile?.firstName).toBe('Canon');
    // Guest row untouched.
    expect(mockKv.get(profileKeyForOwner(GUEST_DATA_OWNER))).toBe(
      JSON.stringify(answers),
    );
  });

  it('the signed-out owner cannot read a profile and cannot write', async () => {
    mockKv.set(profileKeyForOwner(GUEST_DATA_OWNER), JSON.stringify(answers));
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);

    await useAppStore.getState().hydrate();

    expect(useAppStore.getState().profile).toBeNull();
    expect(() => requireWritableDataOwner()).toThrow();
  });
});

// ─── Connect account from a guest: cancel / failure / success ────────────────

describe('guest → Connect account (Google)', () => {
  it('cancel keeps the guest session, owner and flag intact and reports auth.canceled', async () => {
    await becomeGuest();
    mockGoogleSignin.signIn.mockResolvedValue({
      type: 'cancelled',
      data: null,
    });
    const fetchMock = jest.fn();
    installFetch(fetchMock);

    await useAuthStore.getState().signInWithGoogle();

    expectGuestIntact();
    expect(useAuthStore.getState().error).toEqual({
      code: 'auth.canceled',
      message: 'Sign-in canceled.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    useAuthStore.getState().clearError();
    expect(useAuthStore.getState().error).toBeNull();
  });

  it('a 5xx bootstrap failure keeps the guest intact and surfaces a typed message (busy resets)', async () => {
    await becomeGuest();
    mockGoogleSignin.signIn.mockResolvedValue(googleSuccess());
    installFetch(
      jest
        .fn()
        .mockResolvedValue(response({ error: { message: 'Down' } }, 503)),
    );

    await useAuthStore.getState().signInWithGoogle();

    expectGuestIntact();
    expect(useAuthStore.getState().error).toEqual({
      code: 'auth.failed',
      message: 'Down',
    });
  });

  it('a 401 from bootstrap is terminal (no retry loop) and leaves the guest intact', async () => {
    await becomeGuest();
    mockGoogleSignin.signIn.mockResolvedValue(googleSuccess());
    const fetchMock = jest.fn().mockResolvedValue(response({}, 401));
    installFetch(fetchMock);

    await useAuthStore.getState().signInWithGoogle();

    expectGuestIntact();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().error).toEqual({
      code: 'auth.failed',
      message:
        'The account server could not verify this identity provider token.',
    });
  });

  it('a network failure keeps the guest intact with retryable copy', async () => {
    await becomeGuest();
    mockGoogleSignin.signIn.mockResolvedValue(googleSuccess());
    installFetch(jest.fn().mockRejectedValue(new TypeError('offline')));

    await useAuthStore.getState().signInWithGoogle();

    expectGuestIntact();
    expect(useAuthStore.getState().error).toEqual({
      code: 'auth.failed',
      message: 'Secure account setup is temporarily unavailable.',
    });
  });

  it('a missing Google id token never reaches the network and keeps the guest', async () => {
    await becomeGuest();
    mockGoogleSignin.signIn.mockResolvedValue(googleSuccess(null));
    const fetchMock = jest.fn();
    installFetch(fetchMock);

    await useAuthStore.getState().signInWithGoogle();

    expectGuestIntact();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useAuthStore.getState().error?.code).toBe('auth.failed');
  });

  it('double-tap guard: a second signInWithGoogle while busy is ignored', async () => {
    await becomeGuest();
    let resolveSignIn!: (value: unknown) => void;
    mockGoogleSignin.signIn.mockReturnValue(
      new Promise(resolve => {
        resolveSignIn = resolve;
      }),
    );

    const first = useAuthStore.getState().signInWithGoogle();
    await Promise.resolve();
    expect(useAuthStore.getState().busy).toBe(true);
    await useAuthStore.getState().signInWithGoogle();
    expect(mockGoogleSignin.signIn).toHaveBeenCalledTimes(1);

    resolveSignIn({ type: 'cancelled', data: null });
    await first;
    expect(useAuthStore.getState().busy).toBe(false);
    expectGuestIntact();
  });

  it('success flips owner/API/billing to the canonical UUID, clears the guest flag and arms Google restore', async () => {
    await becomeGuest();
    mockGoogleSignin.signIn.mockResolvedValue(googleSuccess());
    const fetchMock = jest.fn().mockResolvedValue(
      response({
        user: { id: canonicalId, email: 'pat@example.com' },
        onboardingState: 'complete',
      }),
    );
    installFetch(fetchMock);

    await useAuthStore.getState().signInWithGoogle();

    const state = useAuthStore.getState();
    expect(state.busy).toBe(false);
    expect(state.error).toBeNull();
    expect(state.session).toEqual({
      provider: 'google',
      subject: canonicalId,
      canonicalAppUserId: canonicalId,
      localOnly: false,
      displayName: 'Pat Player',
      email: 'pat@example.com',
    });
    expect(getActiveDataOwner()).toBe(canonicalDataOwner(canonicalId));
    expect(getApiSession()).toMatchObject({
      canonicalAppUserId: canonicalId,
      bearerToken: 'google-id-token',
      apiBaseUrl: 'https://api.example.test',
    });
    expect(mockKv.get(LOCAL_MODE_KEY)).toBe('');
    expect(mockKv.get(LAST_PROVIDER_KEY)).toBe(GOOGLE_FLAG);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.test/v1/account/bootstrap');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer google-id-token',
    );
  });

  it('after connecting, RevenueCat is configured with the canonical UUID only (never the guest/provider subject)', async () => {
    await becomeGuest();
    mockGoogleSignin.signIn.mockResolvedValue(googleSuccess());
    installFetch(
      jest.fn(async (url: string) => {
        if (url.endsWith('/v1/account/bootstrap')) {
          return response({
            user: { id: canonicalId, email: null },
            onboardingState: 'complete',
          });
        }
        return response({}, 500);
      }),
    );
    mockPurchases.getAppUserID.mockResolvedValue(canonicalId);

    await useAuthStore.getState().signInWithGoogle();
    await useAccessStore.getState().initialize();

    expect(mockBillingConfigs).toHaveLength(1);
    expect(mockBillingConfigs[0]).toMatchObject({
      canonicalAppUserId: canonicalId,
      revenueCatPublicSdkKey: 'appl_test_public_key',
      apiBaseUrl: 'https://api.example.test',
      apiToken: 'google-id-token',
    });
    expect(mockPurchases.configure).toHaveBeenCalledTimes(1);
    expect(mockPurchases.configure).toHaveBeenCalledWith({
      apiKey: 'appl_test_public_key',
      appUserID: canonicalId,
    });
    const idsSeen = [
      ...mockPurchases.configure.mock.calls.map(call => call[0].appUserID),
      ...mockPurchases.logIn.mock.calls.map(call => call[0]),
    ];
    expect(idsSeen).not.toContain('local-only');
    expect(idsSeen).not.toContain(GUEST_DATA_OWNER);
    expect(idsSeen).not.toContain('google-uid-1');
    expect(useAccessStore.getState().status).not.toBe('unconfigured');
  });

  it('the connected account starts from its own bucket; the guest profile row never migrates', async () => {
    mockKv.set(profileKeyForOwner(GUEST_DATA_OWNER), JSON.stringify(answers));
    await becomeGuest();
    mockGoogleSignin.signIn.mockResolvedValue(googleSuccess());
    installFetch(
      jest.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/v1/account/bootstrap')) {
          return response({
            user: { id: canonicalId, email: null },
            onboardingState: 'pending',
          });
        }
        if (url.endsWith('/v1/me/onboarding') && init?.method === 'GET') {
          return response({ profile: null });
        }
        return response({}, 500);
      }),
    );

    await useAuthStore.getState().signInWithGoogle();
    await useAppStore.getState().hydrate();

    expect(useAppStore.getState().ownerKey).toBe(
      canonicalDataOwner(canonicalId),
    );
    // Guest-only data stays in its bucket; the account starts clean.
    expect(useAppStore.getState().profile).toBeNull();
    expect(mockKv.get(profileKeyForOwner(GUEST_DATA_OWNER))).toBe(
      JSON.stringify(answers),
    );
    expect(
      mockKv.get(profileKeyForOwner(canonicalDataOwner(canonicalId))),
    ).toBeUndefined();
  });
});

// ─── Sign out from a guest ───────────────────────────────────────────────────

describe('guest → Sign out', () => {
  it('clears the session, the guest flag and the owner; leaves guest data on disk', async () => {
    mockKv.set(profileKeyForOwner(GUEST_DATA_OWNER), JSON.stringify(answers));
    await becomeGuest();

    await useAuthStore.getState().signOut();

    const state = useAuthStore.getState();
    expect(state.session).toBeNull();
    expect(state.busy).toBe(false);
    expect(state.error).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(mockKv.get(LOCAL_MODE_KEY)).toBe('');
    expect(mockKv.get(LAST_PROVIDER_KEY)).toBe('');
    expect(mockGoogleSignin.signOut).not.toHaveBeenCalled();
    expect(mockKv.get(profileKeyForOwner(GUEST_DATA_OWNER))).toBe(
      JSON.stringify(answers),
    );
  });

  it('the next launch after guest sign-out does not resurrect the guest', async () => {
    await becomeGuest();
    await useAuthStore.getState().signOut();
    useAuthStore.setState({ hydrated: false });

    await useAuthStore.getState().hydrate();

    expect(useAuthStore.getState().hydrated).toBe(true);
    expect(useAuthStore.getState().session).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
  });

  it('a later guest restore sees the same device-guest bucket again', async () => {
    mockKv.set(profileKeyForOwner(GUEST_DATA_OWNER), JSON.stringify(answers));
    await becomeGuest();
    await useAuthStore.getState().signOut();

    await becomeGuest();
    await useAppStore.getState().hydrate();

    expect(useAppStore.getState().profile).toEqual(answers);
  });
});
