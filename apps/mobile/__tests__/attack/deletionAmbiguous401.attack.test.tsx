/**
 * Adversarial tests for the MSA-P1-1 fix (candidate ac6df205; baseline
 * f702f0f8). Every test asserts the EXPECTED behaviour; a failure = defect
 * reproduced.
 *
 * The fix turns "delete-confirm timed out, then the retry of the SAME
 * challenge answered 401" into the local end of the account
 * (ManageAccountScreen.confirmDeletion → onDeleted({unverified}) →
 * completeAccountDeletion(deleted)). But a 401 is what `authenticate()`
 * answers for an EXPIRED bearer too ("The session token has expired."), and
 * sessionKeeper.ts documents exactly that case as expected ("a route that
 * does reject it calls refreshSessionNow()": clock skew, or an outage that
 * spanned the bearer's expiry so the keeper could not rotate in time — the
 * same outage that made the confirm time out). The auth store already
 * answers that 401 the right way — it refreshes, and the server's verdict
 * on the REFRESH TOKEN is what says whether the account still exists — but
 * the screen does not wait for that verdict: it purges the owner's local
 * rows, wipes the Keychain record and (Apple) announces "Account deleted"
 * before the refresh has answered, and completeAccountDeletion() then stops
 * the keeper so the answer is dropped.
 *
 * A1  durable Apple session, confirm timed out, retry 401 (bearer expired),
 *     refresh 200 (account alive) → the phone must NOT end the account.
 * A2  legacy provider-token Google session (old server: no refresh token),
 *     confirm timed out, retry 401 → the auth store's silent Google restore
 *     (handleApiUnauthorized, newly reached from deletion.ts) races
 *     completeAccountDeletion(): the phone must not bootstrap a NEW server
 *     account for the user who just deleted theirs (A2a, passes on
 *     f702f0f8), and must land signed out (A2b: f702f0f8 stays signed in to
 *     the deleted account — the original MSA-P1-1; ac6df205 lands signed in
 *     to the freshly created one).
 *
 * Baseline check: A1 and A2a PASS on f702f0f8 (git worktree, same test
 * file), so they are regressions of the candidate, not pre-existing.
 *
 * Both flows use the REAL auth store (hydrate / signInWithGoogle install
 * the real handleApiUnauthorized), the real ApiSession store and the real
 * session keeper; only the network, Keychain, SQLite and provider SDK are
 * doubles.
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { LocalDb } from '../../src/data/db';

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

const mockPurgeOwnerData = jest.fn<Promise<void>, [LocalDb, string]>(() =>
  Promise.resolve(),
);
jest.mock('../../src/data/repository', () => ({
  ...jest.requireActual<typeof import('../../src/data/repository')>(
    '../../src/data/repository',
  ),
  purgeOwnerData: (db: LocalDb, owner: string) => mockPurgeOwnerData(db, owner),
}));

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
  showBrandNotice: (...args: unknown[]) => mockShowBrandNotice(...args),
}));

import { ManageAccountScreen } from '../../src/screens/ManageAccountScreen';
import { Button } from '../../src/design/components';
import { useAuthStore } from '../../src/auth/authStore';
import {
  clearApiSession,
  getApiSession,
  reportApiUnauthorized,
} from '../../src/account/apiSession';
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

const canonicalId = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const FAR_FUTURE_SECONDS = Math.floor(Date.now() / 1000) + 3600;

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** Never resolves; rejects with AbortError once the caller's signal fires. */
function hang(init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener('abort', () => {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
}

const refreshBody = (tokens: { access: string; refresh: string }) => ({
  session: {
    accessToken: tokens.access,
    refreshToken: tokens.refresh,
    expiresAt: FAR_FUTURE_SECONDS,
  },
});

type Route = (init?: RequestInit) => Response | Promise<Response>;

/** Routes fetch by URL suffix, one handler per call in order; unknown routes
 * reject like a dead network. Records every call. */
function installRoutes(routes: Record<string, Route[]>) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchMock = jest.fn((url: string, init?: RequestInit) => {
    calls.push({
      url,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    for (const [suffix, handlers] of Object.entries(routes)) {
      if (url.endsWith(suffix)) {
        const handler = handlers.length > 1 ? handlers.shift() : handlers[0];
        if (!handler) break;
        return Promise.resolve(handler(init));
      }
    }
    return Promise.reject(new Error(`network down (${url})`));
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { calls, fetchMock };
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

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function pressable(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
}

function sheetButton(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const matches = renderer.root
    .findAllByType(Button)
    .filter(node => String(node.props.label).startsWith(label));
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!;
}

/** Delete account → skip survey → Continue to delete → wait out the 5s arm. */
async function armDeletion(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    pressable(renderer, 'Delete account')[0]!.props.onPress();
  });
  await act(async () => {
    pressable(renderer, 'Skip the survey')[0]!.props.onPress();
  });
  await act(async () => {
    sheetButton(renderer, 'Continue to delete').props.onPress();
  });
  await act(async () => {
    jest.advanceTimersByTime(5_000);
  });
  const confirm = sheetButton(renderer, 'Permanently delete');
  expect(confirm.props.disabled).toBe(false);
  return confirm;
}

/** Confirm → the server never answers → the client's 15s abort. */
async function confirmAndTimeOut(
  renderer: TestRenderer.ReactTestRenderer,
  confirm: TestRenderer.ReactTestInstance,
) {
  await act(async () => {
    confirm.props.onPress();
  });
  await act(async () => {
    jest.advanceTimersByTime(15_000);
  });
  const retry = sheetButton(renderer, 'Permanently delete');
  expect(retry.props.disabled).toBe(false);
  return retry;
}

async function settle() {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  jest.useFakeTimers();
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
    deletionCleanup: null,
  });
  mockGoogleSignin.hasPreviousSignIn.mockReturnValue(false);
  mockGoogleSignin.signInSilently.mockResolvedValue({
    type: 'noSavedCredentialFound',
    data: null,
  });
  mockGoogleSignin.hasPlayServices.mockResolvedValue(true);
  mockGoogleSignin.signOut.mockResolvedValue(null);
  mockGoogleSignin.revokeAccess.mockResolvedValue(null);
});

afterEach(() => {
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  globalThis.fetch = realFetch;
  jest.useRealTimers();
});

describe('A1 — timed-out confirm, then 401 for an EXPIRED bearer of a LIVE account', () => {
  it('does not end a live account locally: the refresh the 401 triggers succeeds, so nothing may be purged, the Keychain record must stay, and no "Account deleted" notice may show', async () => {
    seedVault('refresh-1');
    const { calls } = installRoutes({
      '/v1/auth/refresh': [
        // launch: the persisted session is restored
        () =>
          response(refreshBody({ access: 'access-1', refresh: 'refresh-2' })),
        // after the 401: the server still honours the refresh token — the
        // account exists, only the bearer had expired
        () =>
          response(refreshBody({ access: 'access-3', refresh: 'refresh-3' })),
      ],
      '/v1/me/delete-request': [
        () =>
          response({
            challenge: 'challenge-1',
            expiresAt: '2026-09-05T00:00:00.000Z',
          }),
      ],
      '/v1/me/delete-confirm': [
        // the outage: no answer within 15s
        init => hang(init),
        // the retry, still bearing the token the keeper could not rotate
        // during the outage → authenticate() refuses the expired bearer
        () =>
          response(
            { error: { message: 'The session token has expired.' } },
            401,
          ),
      ],
    });

    await act(async () => {
      await useAuthStore.getState().hydrate();
    });
    await settle();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(getApiSession()?.bearerToken).toBe('access-1');

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<ManageAccountScreen />);
    });
    const confirm = await armDeletion(renderer);
    const retry = await confirmAndTimeOut(renderer, confirm);

    await act(async () => {
      retry.props.onPress();
    });
    await settle();

    const urls = calls.map(c => c.url.replace('https://api.example.test', ''));
    expect(urls.slice(0, 4)).toEqual([
      '/v1/auth/refresh',
      '/v1/me/delete-request',
      '/v1/me/delete-confirm',
      '/v1/me/delete-confirm',
    ]);
    // With the fix, the 401 is reported and the keeper asks the server about
    // the refresh token (urls[4] === '/v1/auth/refresh'), which answers 200:
    // the account is alive. Whether or not that question was asked, the
    // phone must not have ended the account on a bare 401.
    const notices = mockShowBrandNotice.mock.calls.map(
      c => c[0] as { title: string; detail: string },
    );
    const state = useAuthStore.getState();
    // Recorded for the log.
    console.log(
      JSON.stringify(
        {
          purgeCalls: mockPurgeOwnerData.mock.calls.length,
          vaultRecord: vaultRecord(),
          sessionAfter: state.session?.canonicalAppUserId ?? null,
          bearerAfter: getApiSession()?.bearerToken ?? null,
          notices,
        },
        null,
        2,
      ),
    );
    expect(mockPurgeOwnerData).not.toHaveBeenCalled();
    expect(vaultRecord()).not.toBeNull();
    expect(state.session?.canonicalAppUserId).toBe(canonicalId);
    expect(notices.some(n => /Account deleted/.test(n.title))).toBe(false);
    act(() => renderer.unmount());
  });
});

/**
 * A3 — two connections. The server DID delete the account on the unanswered
 * confirm, so every later call of every client is refused. The sync
 * transport (or any other API client) is the first to hear it: its 401 goes
 * through reportApiUnauthorized → handleApiUnauthorized → refreshSessionNow
 * → the refresh token is refused → dropRevokedSession() clears the session,
 * the ApiSession and the Keychain record — the deleted owner's SQLite rows
 * are NOT purged by that path. The fix's own claim is that the deletion
 * screen then still purges them ("names the owner … the purge must still
 * target the deleted owner's rows"). Both orderings of that race are tried.
 */
describe('A3 — the account is gone; another client’s 401 drops the session around the retry', () => {
  async function hydrateAppleSession(routes: Record<string, Route[]>) {
    seedVault('refresh-1');
    const installed = installRoutes({
      '/v1/auth/refresh': [
        () =>
          response(refreshBody({ access: 'access-1', refresh: 'refresh-2' })),
        // every later refresh: the account is gone
        () =>
          response(
            { error: { message: 'The session is no longer valid.' } },
            401,
          ),
      ],
      '/v1/me/delete-request': [
        () =>
          response({
            challenge: 'challenge-1',
            expiresAt: '2026-09-05T00:00:00.000Z',
          }),
      ],
      ...routes,
    });
    await act(async () => {
      await useAuthStore.getState().hydrate();
    });
    await settle();
    expect(getApiSession()?.bearerToken).toBe('access-1');
    return installed;
  }

  function logState(label: string, extra: Record<string, unknown> = {}) {
    console.log(
      JSON.stringify(
        {
          label,
          purgeCalls: mockPurgeOwnerData.mock.calls.map(c => c[1]),
          vaultRecord: vaultRecord(),
          session: useAuthStore.getState().session?.canonicalAppUserId ?? null,
          apiSession: getApiSession()?.bearerToken ?? null,
          deletionCleanup: useAuthStore.getState().deletionCleanup,
          authError: useAuthStore.getState().error,
          ...extra,
        },
        null,
        2,
      ),
    );
  }

  it('A3a: the sync client’s 401 lands BEFORE the retry → the retry must still end the deleted account locally (purge the owner’s rows)', async () => {
    const { calls } = await hydrateAppleSession({
      '/v1/me/delete-confirm': [
        init => hang(init),
        () =>
          response(
            { error: { message: 'The session is no longer valid.' } },
            401,
          ),
      ],
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<ManageAccountScreen />);
    });
    const confirm = await armDeletion(renderer);
    const retry = await confirmAndTimeOut(renderer, confirm);

    // Meanwhile the outbox flushes a shot: 401 → refresh → refused → the
    // auth store drops the session (the one implicit sign-out).
    await act(async () => {
      reportApiUnauthorized('access-1');
    });
    await settle();
    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(vaultRecord()).toBeNull();

    await act(async () => {
      retry.props.onPress();
    });
    await settle();
    const urls = calls.map(c => c.url.replace('https://api.example.test', ''));
    const text = allText(renderer);
    logState('A3a', {
      urls,
      sheetShowsRetryError:
        text.match(/Sign in to a synced account[^.]*\./)?.[0] ?? null,
    });
    // The confirm left the phone unanswered, and the server has since refused
    // both the bearer and the refresh token: the account is gone, and the
    // deleted owner's local rows must go with it.
    expect(mockPurgeOwnerData).toHaveBeenCalledTimes(1);
    expect(mockPurgeOwnerData.mock.calls[0]?.[1]).toBe(canonicalId);
    act(() => renderer.unmount());
  });

  it('A3b: the sync client’s 401 lands WHILE the retry is in flight → the 401 on the retry must still purge the deleted owner’s rows', async () => {
    let answerRetry: (() => void) | null = null;
    const { calls } = await hydrateAppleSession({
      '/v1/me/delete-confirm': [
        init => hang(init),
        () =>
          new Promise<Response>(resolve => {
            answerRetry = () =>
              resolve(
                response(
                  { error: { message: 'The session is no longer valid.' } },
                  401,
                ),
              );
          }),
      ],
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<ManageAccountScreen />);
    });
    const confirm = await armDeletion(renderer);
    const retry = await confirmAndTimeOut(renderer, confirm);

    await act(async () => {
      retry.props.onPress();
    });
    await settle();
    expect(sheetButton(renderer, 'Deleting').props.disabled).toBe(true);

    // The outbox's 401 → refresh refused → session dropped, while the
    // retry is still waiting for its answer.
    await act(async () => {
      reportApiUnauthorized('access-1');
    });
    await settle();
    expect(useAuthStore.getState().session).toBeNull();

    await act(async () => {
      answerRetry?.();
    });
    await settle();
    const urls = calls.map(c => c.url.replace('https://api.example.test', ''));
    logState('A3b', { urls });
    expect(mockPurgeOwnerData).toHaveBeenCalledTimes(1);
    expect(mockPurgeOwnerData.mock.calls[0]?.[1]).toBe(canonicalId);
    act(() => renderer.unmount());
  });
});

describe('A2 — legacy provider-token Google session (old server), timed-out confirm, then 401', () => {
  async function runLegacyGoogleLostConfirm() {
    mockGoogleSignin.signIn.mockResolvedValue({
      type: 'success',
      data: {
        idToken: 'google-id-token-1',
        user: { name: 'Pat Player', email: 'pat@example.com' },
      },
    });
    // The silent restore handleApiUnauthorized attempts for a legacy session
    // finds the SDK credential still there (completeAccountDeletion's
    // revokeAccess has not run yet) and gets a fresh ID token.
    mockGoogleSignin.hasPreviousSignIn.mockReturnValue(true);
    mockGoogleSignin.signInSilently.mockResolvedValue({
      type: 'success',
      data: {
        idToken: 'google-id-token-2',
        user: { name: 'Pat Player', email: 'pat@example.com' },
      },
    });
    let releaseSecondBootstrap: (() => void) | null = null;
    const { calls } = installRoutes({
      '/v1/account/bootstrap': [
        // old server: no `session` → the app bears the Google ID token itself
        // and has nothing to persist (the pre-contract, "legacy" session)
        () =>
          response({
            user: { id: canonicalId, email: 'pat@example.com' },
            onboardingState: 'complete',
          }),
        // the account was deleted, so a second bootstrap with the same
        // Google identity creates a brand-new account; it lands after the
        // local cleanup finished
        () =>
          new Promise<Response>(resolve => {
            releaseSecondBootstrap = () =>
              resolve(
                response({
                  user: {
                    id: '9d2e6c1a-5b0f-4e7a-8c3d-2f1e0a9b8c7d',
                    email: 'pat@example.com',
                  },
                  onboardingState: 'complete',
                }),
              );
          }),
      ],
      '/v1/me/delete-request': [
        () =>
          response({
            challenge: 'challenge-1',
            expiresAt: '2026-09-05T00:00:00.000Z',
          }),
      ],
      '/v1/me/delete-confirm': [
        init => hang(init),
        () =>
          response(
            {
              error: {
                message: 'The session is no longer valid. Sign in again.',
              },
            },
            401,
          ),
      ],
    });

    await act(async () => {
      await useAuthStore.getState().signInWithGoogle();
    });
    await settle();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(getApiSession()).toMatchObject({
      bearerToken: 'google-id-token-1',
      refreshToken: null,
    });
    expect(vaultRecord()).toBeNull();

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<ManageAccountScreen />);
    });
    const confirm = await armDeletion(renderer);
    const retry = await confirmAndTimeOut(renderer, confirm);

    await act(async () => {
      retry.props.onPress();
    });
    await settle();
    const cleanupDone = useAuthStore.getState().deletionCleanup !== null;
    await act(async () => {
      releaseSecondBootstrap?.();
    });
    await settle();

    const urls = calls.map(c => c.url.replace('https://api.example.test', ''));
    const state = useAuthStore.getState();
    console.log(
      JSON.stringify(
        {
          urls,
          cleanupDoneBeforeRestoreLanded: cleanupDone,
          signInSilentlyCalls:
            mockGoogleSignin.signInSilently.mock.calls.length,
          sessionAfter: state.session,
          apiSessionAfter: getApiSession(),
          purgeCalls: mockPurgeOwnerData.mock.calls.length,
        },
        null,
        2,
      ),
    );
    act(() => renderer.unmount());
    return { urls, state };
  }

  it('A2a: does not silently bootstrap a NEW server account for the user who just deleted theirs', async () => {
    const { urls } = await runLegacyGoogleLostConfirm();
    expect(urls.filter(u => u === '/v1/account/bootstrap')).toHaveLength(1);
  });

  it('A2b: lands signed out — not signed in to the deleted account, and not to a different one', async () => {
    const { state } = await runLegacyGoogleLostConfirm();
    expect(state.session).toBeNull();
    expect(getApiSession()).toBeNull();
  });
});
