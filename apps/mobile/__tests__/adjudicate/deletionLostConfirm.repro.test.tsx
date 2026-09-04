import React from 'react';
import { NativeModules, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { LocalDb } from '../../src/data/db';

/**
 * MSA-P1-1 — an ambiguous delete-confirm answered 401 must never leave a
 * server-deleted account signed in on the device.
 *
 * The confirm request is the one call whose loss is dangerous: once it has
 * left the phone the server may well have deleted the account, so a timeout
 * cannot promise "Nothing was deleted", and the 401 the retry then earns is
 * exactly what every other API client reports through
 * `reportApiUnauthorized` so the auth store can decide. The auth store's
 * decision is the SERVER's: it forces a refresh-token rotation — the one
 * signal that distinguishes "account gone" (refresh refused → finish the
 * deletion locally: purge, Keychain, signed out) from "bearer merely
 * expired" (refresh succeeds → the account and its local data stay, the same
 * challenge can be retried). Nothing is purged on a guess.
 *
 * MSA-P2-5 — when the local purge fails AND the account needs the manual
 * Sign in with Apple step, both must be said; each alone keeps its notice.
 *
 * Everything below runs the real deletion client, the real auth store, the
 * real session keeper and the real ManageAccountScreen against a routed
 * fetch; only the device seams (SQLite, Keychain, provider SDKs) are faked.
 */

// ─── Device seams ────────────────────────────────────────────────────────────

const mockKv = new Map<string, string>();
const mockStatements: string[] = [];
let mockPurgeFails = false;
function mockCurrentDb(): LocalDb {
  return {
    async execute(sql: string, params: unknown[] = []) {
      const statement = sql.trim().replace(/\s+/g, ' ');
      mockStatements.push(statement);
      if (statement.startsWith('SELECT value FROM kv')) {
        const value = mockKv.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
        mockKv.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      if (statement.startsWith('DELETE FROM') && mockPurgeFails) {
        throw new Error('database is locked');
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
    hasPreviousSignIn: jest.fn(() => false),
    signOut: jest.fn(),
    revokeAccess: jest.fn(),
  },
}));

jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));

jest.mock('../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.example.test',
    revenueCatPublicSdkKey: null,
    googleIosClientId: null,
    googleWebClientId: null,
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

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => insets,
    initialWindowMetrics: null,
  };
});

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn() }),
}));

const mockShowBrandNotice = jest.fn();
jest.mock('../../src/design/BrandNotice', () => ({
  showBrandNotice: (notice: unknown) => mockShowBrandNotice(notice),
}));

import { ManageAccountScreen } from '../../src/screens/ManageAccountScreen';
import { Button } from '../../src/design/components';
import { useAuthStore } from '../../src/auth/authStore';
import {
  clearApiSession,
  establishApiSession,
  getApiSession,
  setApiUnauthorizedListener,
  type ApiSession,
} from '../../src/account/apiSession';
import {
  AccountDeletionError,
  confirmAccountDeletion,
  requestAccountDeletion,
} from '../../src/account/deletion';
import { SESSION_VAULT_SERVICE } from '../../src/account/sessionVault';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import * as Keychain from 'react-native-keychain';

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

// ─── Fixtures ────────────────────────────────────────────────────────────────

const API = 'https://api.example.test';
const canonicalId = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const CHALLENGE = '3b9d5b3c-6e6a-4a6e-9d1c-0f3d4b7a8e21';
const FAR_FUTURE_SECONDS = Math.floor(Date.now() / 1000) + 3600;

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

const bootstrapBody = {
  user: { id: canonicalId, email: 'pat@example.com' },
  onboardingState: 'complete',
  session: {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: FAR_FUTURE_SECONDS,
  },
};

const refreshBody = {
  session: {
    accessToken: 'access-2',
    refreshToken: 'refresh-2',
    expiresAt: FAR_FUTURE_SECONDS,
  },
};

const unauthorized = () =>
  response(
    { error: { code: 'auth.unauthorized', message: 'Unauthorized' } },
    401,
  );

/** A request that left the device and is never answered: rejects only when
 * the caller's own timeout aborts it, exactly like a dead upstream. */
function neverAnswers(init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () =>
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
    );
  });
}

type Route = (init?: RequestInit) => Response | Promise<Response>;

/** Routes fetch by URL suffix; each route may be a queue consumed per call.
 * Unknown routes reject like a dead network. */
function installRoutes(routes: Record<string, Route | Route[]>): jest.Mock {
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    for (const [suffix, handler] of Object.entries(routes)) {
      if (!url.endsWith(suffix)) continue;
      if (Array.isArray(handler)) {
        const next = handler.length > 1 ? handler.shift()! : handler[0]!;
        return next(init);
      }
      return handler(init);
    }
    throw new Error(`network down (${url})`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function vaultRecord(): Record<string, unknown> | null {
  const item = __keychainStore.get(SESSION_VAULT_SERVICE);
  return item ? (JSON.parse(item.password) as Record<string, unknown>) : null;
}

const apiSession: ApiSession = {
  apiBaseUrl: API,
  bearerToken: 'access-1',
  canonicalAppUserId: canonicalId,
  provider: 'apple',
  refreshToken: 'refresh-1',
  bearerExpiresAtMs: FAR_FUTURE_SECONDS * 1000,
};

// ─── Screen helpers ──────────────────────────────────────────────────────────

function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<ManageAccountScreen />);
  });
  return renderer;
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function pressable(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const matches = renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!;
}

function sheetButton(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const matches = renderer.root
    .findAllByType(Button)
    .filter(node => String(node.props.label).startsWith(label));
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!;
}

/** Drains the promise chains the store, keeper and dialog run through
 * (Keychain + SQLite fakes are async) without touching the fake clock. */
async function settle(rounds = 60): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i += 1) await Promise.resolve();
  });
}

/** Signs a real Apple session in (bootstrap route), then opens the dialog,
 * skips the survey and arms the confirm button through its hold-off. */
async function signInAndArm(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    pressable(renderer, 'Delete account').props.onPress();
  });
  await act(async () => {
    pressable(renderer, 'Skip the survey').props.onPress();
  });
  await act(async () => {
    sheetButton(renderer, 'Continue to delete').props.onPress();
  });
  await settle();
  expect(sheetButton(renderer, 'Permanently delete').props.label).toBe(
    'Permanently delete (5)',
  );
  await act(async () => {
    jest.advanceTimersByTime(5_000);
  });
  const confirm = sheetButton(renderer, 'Permanently delete');
  expect(confirm.props.label).toBe('Permanently delete');
  expect(confirm.props.disabled).toBe(false);
  return confirm;
}

async function signInWithApple(): Promise<void> {
  await useAuthStore.getState().signInWithApple();
  expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(canonicalId);
  expect(getApiSession()?.bearerToken).toBe('access-1');
  expect(vaultRecord()).not.toBeNull();
}

const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  mockKv.clear();
  mockStatements.length = 0;
  mockPurgeFails = false;
  __keychainStore.clear();
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  setApiUnauthorizedListener(null);
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    hydrated: true,
    session: null,
    busy: false,
    error: null,
    deletionCleanup: null,
  });
  nativeModules.PickleAuth = {
    signInWithApple: jest.fn().mockResolvedValue({
      user: 'apple-user-opaque',
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
  jest.useRealTimers();
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  setApiUnauthorizedListener(null);
  delete nativeModules.PickleAuth;
  globalThis.fetch = realFetch;
});

// ─── D1: the deletion client is an API client like every other ───────────────

describe('MSA-P1-1 — deletion client', () => {
  it('module: a 401 on delete-confirm reports the rejected bearer to the auth store', async () => {
    establishApiSession(apiSession);
    const listener = jest.fn();
    setApiUnauthorizedListener(listener);
    const fetchFn = jest.fn(async () => unauthorized());

    await expect(
      confirmAccountDeletion(apiSession, CHALLENGE, fetchFn),
    ).rejects.toMatchObject({ code: 'deletion.session_expired' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ bearerToken: 'access-1' }),
    );

    // The report is about the bearer that was sent: a 401 that lands after
    // the session rotated is ignored (apiSession.ts guards identity).
    listener.mockClear();
    establishApiSession({ ...apiSession, bearerToken: 'access-2' });
    await expect(
      confirmAccountDeletion(apiSession, CHALLENGE, fetchFn),
    ).rejects.toMatchObject({ code: 'deletion.session_expired' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('module: a 401 on delete-request reports the rejected bearer too', async () => {
    establishApiSession(apiSession);
    const listener = jest.fn();
    setApiUnauthorizedListener(listener);
    const fetchFn = jest.fn(async () => unauthorized());

    await expect(
      requestAccountDeletion(apiSession, null, fetchFn),
    ).rejects.toMatchObject({ code: 'deletion.session_expired' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ bearerToken: 'access-1' }),
    );
  });

  it('module: a confirm that times out after leaving the device must not promise "Nothing was deleted"', async () => {
    jest.useFakeTimers();
    const fetchFn = jest.fn((_url: string, init?: RequestInit) =>
      neverAnswers(init),
    );

    const pending = confirmAccountDeletion(apiSession, CHALLENGE, fetchFn);
    const caught = pending.catch((e: unknown) => e);
    await act(async () => {
      jest.advanceTimersByTime(15_000);
    });
    const error = await caught;

    expect(error).toBeInstanceOf(AccountDeletionError);
    const typed = error as AccountDeletionError;
    expect(typed.message).not.toMatch(/nothing was deleted/i);
    // The same challenge may be presented again — that retry is how the
    // device finds out what happened.
    expect(typed.retryable).toBe(true);

    // Step 1 destroys nothing, so ITS timeout copy may keep the promise.
    const requestPending = requestAccountDeletion(apiSession, null, fetchFn);
    const requestCaught = requestPending.catch((e: unknown) => e);
    await act(async () => {
      jest.advanceTimersByTime(15_000);
    });
    const requestError = (await requestCaught) as AccountDeletionError;
    expect(requestError.code).toBe('deletion.unavailable');
    expect(requestError.message).toMatch(/nothing was deleted/i);
  });
});

// ─── D1: the screen ends the deleted account locally ─────────────────────────

describe('MSA-P1-1 — ManageAccountScreen', () => {
  it('screen: lost 200 → retry → 401 must still end the deleted account locally', async () => {
    jest.useFakeTimers();
    const fetchMock = installRoutes({
      '/v1/account/bootstrap': () => response(bootstrapBody),
      '/v1/me/delete-request': () =>
        response({ challenge: CHALLENGE, expiresAt: '2026-09-05T00:00:00Z' }),
      // The server deleted the account on the first confirm, but the 200
      // never reached the phone; the retry meets a bearer that no longer
      // authenticates, and the refresh token is gone with the account.
      '/v1/me/delete-confirm': [neverAnswers, unauthorized],
      '/v1/auth/refresh': unauthorized,
    });
    await signInWithApple();
    const renderer = renderScreen();
    const confirm = await signInAndArm(renderer);

    await act(async () => {
      confirm.props.onPress();
    });
    expect(sheetButton(renderer, 'Deleting').props.disabled).toBe(true);
    await act(async () => {
      jest.advanceTimersByTime(15_000);
    });
    await settle();

    // Ambiguous outcome: honest copy, same challenge re-armed, no promise.
    const copyAfterTimeout = allText(renderer);
    expect(copyAfterTimeout).not.toMatch(/nothing was deleted/i);
    const retry = sheetButton(renderer, 'Permanently delete');
    expect(retry.props.disabled).toBe(false);
    expect(useAuthStore.getState().session).not.toBeNull();
    expect(mockStatements.filter(s => s.startsWith('DELETE FROM'))).toEqual([]);

    await act(async () => {
      retry.props.onPress();
    });
    await settle();

    // The retry's 401 was reported; the auth store asked the server (refresh
    // rotation) and the server refused → the account is gone: end it here.
    expect(fetchMock).toHaveBeenCalledWith(
      `${API}/v1/auth/refresh`,
      expect.objectContaining({ method: 'POST' }),
    );
    const state = useAuthStore.getState();
    expect(state.session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(vaultRecord()).toBeNull();
    expect(state.deletionCleanup).toEqual(
      expect.objectContaining({ localPurge: 'complete' }),
    );
    const deletes = mockStatements.filter(s => s.startsWith('DELETE FROM'));
    expect(deletes).toEqual(
      expect.arrayContaining([
        'DELETE FROM local_shot WHERE owner_key = ?',
        'DELETE FROM outbox WHERE owner_key = ?',
        'DELETE FROM kv WHERE key = ?',
      ]),
    );
    // Not left signed in on the screen: the dialog is gone.
    expect(allText(renderer)).not.toContain('Deleting…');
    expect(allText(renderer)).not.toContain('Permanently delete');
    act(() => renderer.unmount());
  });

  it('screen: a 401 on confirm whose refresh SUCCEEDS keeps the account and its local data (no purge on a guess)', async () => {
    jest.useFakeTimers();
    installRoutes({
      '/v1/account/bootstrap': () => response(bootstrapBody),
      '/v1/me/delete-request': () =>
        response({ challenge: CHALLENGE, expiresAt: '2026-09-05T00:00:00Z' }),
      // A bearer that expired under the dialog: the account still exists.
      '/v1/me/delete-confirm': unauthorized,
      '/v1/auth/refresh': () => response(refreshBody),
    });
    await signInWithApple();
    const renderer = renderScreen();
    const confirm = await signInAndArm(renderer);

    await act(async () => {
      confirm.props.onPress();
    });
    await settle();

    const state = useAuthStore.getState();
    expect(state.session?.canonicalAppUserId).toBe(canonicalId);
    expect(getApiSession()?.bearerToken).toBe('access-2');
    expect(vaultRecord()).toEqual(
      expect.objectContaining({ refreshToken: 'refresh-2' }),
    );
    expect(state.deletionCleanup).toBeNull();
    expect(mockStatements.filter(s => s.startsWith('DELETE FROM'))).toEqual([]);
    // The same challenge is re-armed for the renewed bearer.
    const retry = sheetButton(renderer, 'Permanently delete');
    expect(retry.props.disabled).toBe(false);
    expect(allText(renderer)).not.toMatch(/nothing was deleted/i);
    act(() => renderer.unmount());
  });

  it('screen: an Apple account ended after a lost receipt is told to check the Apple side (the revocation outcome never arrived)', async () => {
    jest.useFakeTimers();
    installRoutes({
      '/v1/account/bootstrap': () => response(bootstrapBody),
      '/v1/me/delete-request': () =>
        response({ challenge: CHALLENGE, expiresAt: '2026-09-05T00:00:00Z' }),
      '/v1/me/delete-confirm': [neverAnswers, unauthorized],
      '/v1/auth/refresh': unauthorized,
    });
    await signInWithApple();
    const renderer = renderScreen();
    const confirm = await signInAndArm(renderer);
    await act(async () => {
      confirm.props.onPress();
    });
    await act(async () => {
      jest.advanceTimersByTime(15_000);
    });
    await settle();
    await act(async () => {
      sheetButton(renderer, 'Permanently delete').props.onPress();
    });
    await settle();

    expect(useAuthStore.getState().session).toBeNull();
    const shown = mockShowBrandNotice.mock.calls.map(
      call => call[0] as { title: string; detail: string; eyebrow?: string },
    );
    expect(shown).toHaveLength(1);
    expect(shown[0]!.title).toBe('Account deleted');
    expect(shown[0]!.detail).toContain('Sign in with Apple');
    expect(shown[0]!.detail).toContain('Stop Using Apple ID');
    expect(`${shown[0]!.eyebrow} ${shown[0]!.detail}`).not.toMatch(
      FORBIDDEN_COPY,
    );
    act(() => renderer.unmount());
  });

  it('screen: 401 then an unreachable refresh → no verdict, nothing purged, same challenge re-armed', async () => {
    jest.useFakeTimers();
    installRoutes({
      '/v1/account/bootstrap': () => response(bootstrapBody),
      '/v1/me/delete-request': () =>
        response({ challenge: CHALLENGE, expiresAt: '2026-09-05T00:00:00Z' }),
      '/v1/me/delete-confirm': unauthorized,
      '/v1/auth/refresh': () => {
        throw new TypeError('Network request failed');
      },
    });
    await signInWithApple();
    const renderer = renderScreen();
    const confirm = await signInAndArm(renderer);
    await act(async () => {
      confirm.props.onPress();
    });
    await settle();

    // Transient refresh failure: the keeper defers (backoff), the store
    // answers 'unknown' and the account is left exactly as it was.
    const state = useAuthStore.getState();
    expect(state.session?.canonicalAppUserId).toBe(canonicalId);
    expect(getApiSession()?.bearerToken).toBe('access-1');
    expect(vaultRecord()).toEqual(
      expect.objectContaining({ refreshToken: 'refresh-1' }),
    );
    expect(state.deletionCleanup).toBeNull();
    expect(mockStatements.filter(s => s.startsWith('DELETE FROM'))).toEqual([]);
    const retry = sheetButton(renderer, 'Permanently delete');
    expect(retry.props.disabled).toBe(false);
    expect(allText(renderer)).toContain(
      'We are checking whether your account was already deleted.',
    );
    expect(allText(renderer)).not.toMatch(/nothing was deleted/i);
    act(() => renderer.unmount());
  });

  it('screen: a sheet closed while the verdict is pending still ends a deleted account and announces it', async () => {
    jest.useFakeTimers();
    let answerRefresh!: () => void;
    installRoutes({
      '/v1/account/bootstrap': () => response(bootstrapBody),
      '/v1/me/delete-request': () =>
        response({ challenge: CHALLENGE, expiresAt: '2026-09-05T00:00:00Z' }),
      '/v1/me/delete-confirm': unauthorized,
      '/v1/auth/refresh': () =>
        new Promise<Response>(resolve => {
          answerRefresh = () => resolve(unauthorized());
        }),
    });
    await signInWithApple();
    const renderer = renderScreen();
    const confirm = await signInAndArm(renderer);
    await act(async () => {
      confirm.props.onPress();
    });
    await settle();
    // Still signed in while the server has not answered; the user backs out.
    expect(useAuthStore.getState().session).not.toBeNull();
    expect(sheetButton(renderer, 'Deleting').props.disabled).toBe(true);
    act(() => renderer.unmount());

    await act(async () => {
      answerRefresh();
    });
    await settle();
    expect(useAuthStore.getState().session).toBeNull();
    expect(vaultRecord()).toBeNull();
    expect(useAuthStore.getState().deletionCleanup).toEqual(
      expect.objectContaining({ localPurge: 'complete' }),
    );
    expect(mockShowBrandNotice).toHaveBeenCalledTimes(1);
  });
});

// ─── D2: both post-deletion notices when both apply ──────────────────────────

const FORBIDDEN_COPY =
  /android|google play|guest mode|live court|dupr|\d+\s*%|\bbest\b|swingvision|pb vision|selkirk|joola/i;

describe('MSA-P2-5 — post-deletion notices', () => {
  async function deleteWith(
    appleAuthorizationRevocation: string,
    purgeFails: boolean,
  ) {
    jest.useFakeTimers();
    mockPurgeFails = purgeFails;
    installRoutes({
      '/v1/account/bootstrap': () => response(bootstrapBody),
      '/v1/me/delete-request': () =>
        response({ challenge: CHALLENGE, expiresAt: '2026-09-05T00:00:00Z' }),
      '/v1/me/delete-confirm': () =>
        response({ deleted: true, appleAuthorizationRevocation }),
    });
    await signInWithApple();
    const renderer = renderScreen();
    const confirm = await signInAndArm(renderer);
    await act(async () => {
      confirm.props.onPress();
    });
    await settle();
    expect(useAuthStore.getState().session).toBeNull();
    act(() => renderer.unmount());
    return mockShowBrandNotice.mock.calls.map(
      call => call[0] as { title: string; detail: string; eyebrow?: string },
    );
  }

  it('purge FAILED + manual_action_required → the user is still told the Apple step', async () => {
    const notices = await deleteWith('manual_action_required', true);
    expect(useAuthStore.getState().deletionCleanup?.localPurge).toBe('failed');
    expect(notices.length).toBeGreaterThan(0);
    const shown = notices.map(n => `${n.title} ${n.detail}`).join('\n');
    expect(shown).toContain('could not be removed');
    expect(shown).toContain('Sign in with Apple');
    expect(shown).toContain('Stop Using Apple ID');
    expect(shown).not.toMatch(FORBIDDEN_COPY);
  });

  it('purge FAILED alone keeps the single LOCAL CLEANUP NEEDED notice and its copy', async () => {
    const notices = await deleteWith('revoked', true);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toEqual(
      expect.objectContaining({
        title: 'Account deleted',
        eyebrow: 'LOCAL CLEANUP NEEDED',
        detail:
          'Your account and synced data were deleted. Some data saved on this phone could not be removed — delete the app to clear it.',
      }),
    );
  });

  it('manual_action_required alone keeps the single ONE APPLE STEP notice and its copy', async () => {
    const notices = await deleteWith('manual_action_required', false);
    expect(useAuthStore.getState().deletionCleanup?.localPurge).toBe(
      'complete',
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toEqual(
      expect.objectContaining({
        title: 'Account deleted',
        eyebrow: 'ONE APPLE STEP',
        detail:
          'This older account had no Apple revocation token. To disconnect it manually, open iPhone Settings → your name → Sign in with Apple → Pickle Sensei → Stop Using Apple ID.',
      }),
    );
  });

  it('a clean deletion with the Apple token revoked shows no notice at all', async () => {
    const notices = await deleteWith('revoked', false);
    expect(notices).toHaveLength(0);
  });
});
