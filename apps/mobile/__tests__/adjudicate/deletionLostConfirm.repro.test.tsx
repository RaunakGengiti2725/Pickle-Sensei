/**
 * Adjudication reproduction (mobile-settings-account, base 4d812e1a).
 *
 * D1  delete-confirm whose 200 is lost (client 15s abort) → the server HAS
 *     deleted the account (index.ts drops the bearer's auth-cache entry and
 *     `auth.getUser` fails for a deleted user → 401 on every later call).
 *     The retry answers 401; deletion.ts maps it to a NON-retryable
 *     'deletion.session_expired' ("Sign in again, then delete your
 *     account"), the dialog returns to review, `completeAccountDeletion` never
 *     runs (no local purge / Keychain clear), and — unlike every other API
 *     client — deletion.ts never calls `reportApiUnauthorized`, so the auth
 *     store is not told either. The timeout copy also asserts "Nothing was
 *     deleted" for a request that may well have completed server-side.
 *
 * D4  deleted:true + appleAuthorizationRevocation:'manual_action_required'
 *     + local purge failed → only the LOCAL CLEANUP notice is shown; the
 *     manual Apple revocation instruction is silently dropped.
 *
 * Every test asserts the EXPECTED behaviour; a failure = defect reproduced.
 *
 * The `settlement` blocks below pin the FIX for D1: the outcome of an
 * ambiguous confirm is decided by the SESSION LAYER, not by the 401 itself.
 * The dialog records the sent confirm in the auth store, the 401 is reported
 * like every other API client's, and the keeper's refresh verdict settles
 * it — a refused refresh token after a sent confirm means the ACCOUNT is
 * gone (full end-of-account cleanup), a rotated bearer means it is still
 * there (the user may finish), and no verdict keeps the answer unknown.
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));

jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
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

jest.mock('../../src/config/runtimeConfig', () => {
  const actual = jest.requireActual<
    typeof import('../../src/config/runtimeConfig')
  >('../../src/config/runtimeConfig');
  return {
    ...actual,
    getRuntimePublicConfig: () => ({
      ...actual.getRuntimePublicConfig(),
      apiBaseUrl: 'https://api.test',
    }),
  };
});

import * as Keychain from 'react-native-keychain';
import {
  DELETION_SETTLEMENT_DEADLINE_MS,
  ManageAccountScreen,
} from '../../src/screens/ManageAccountScreen';
import { Button } from '../../src/design/components';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import {
  clearApiSession,
  establishApiSession,
  getApiSession,
  reportApiUnauthorized,
  setApiUnauthorizedListener,
} from '../../src/account/apiSession';
import {
  AccountDeletionError,
  confirmAccountDeletion,
} from '../../src/account/deletion';
import { SESSION_VAULT_SERVICE } from '../../src/account/sessionVault';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import {
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';

// The auto-mock (__mocks__/react-native-keychain.ts) exposes its in-memory
// store — the same instance sessionVault requires.
const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

/** The store's real actions, before any test swaps in a spy. */
const realAuthActions = useAuthStore.getState();

const canonicalAppUserId = '11111111-1111-4111-8111-111111111111';
const syncedSession: AuthSession = {
  provider: 'apple',
  subject: canonicalAppUserId,
  canonicalAppUserId,
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
};
const apiSession = {
  apiBaseUrl: 'https://api.test',
  bearerToken: 'access-token-1',
  canonicalAppUserId,
  provider: 'apple' as const,
};

type FetchFn = typeof globalThis.fetch;

interface Scripted {
  /** 'hang' → never resolves; rejects with AbortError once the signal fires. */
  kind: 'hang' | 'json';
  status?: number;
  body?: unknown;
}

function scriptedFetch(script: Scripted[]) {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchFn: FetchFn = (input, init) => {
    const url = String(input);
    calls.push({ url, method: String(init?.method ?? 'GET') });
    const step = script.shift();
    if (!step) throw new Error(`unexpected fetch ${url}`);
    if (step.kind === 'hang') {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }
    return Promise.resolve({
      ok: (step.status ?? 200) < 400,
      status: step.status ?? 200,
      json: () => Promise.resolve(step.body),
    } as unknown as Response);
  };
  return { calls, fetchFn };
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

/** Lets every queued microtask (fetch mocks, store updates) settle. */
async function flush(rounds = 10) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const realFetch = globalThis.fetch;
const unauthorizedListener = jest.fn();

beforeEach(() => {
  jest.useFakeTimers();
  mockShowBrandNotice.mockReset();
  unauthorizedListener.mockReset();
  establishApiSession(apiSession);
  setApiUnauthorizedListener(unauthorizedListener);
  useAuthStore.setState({
    hydrated: true,
    session: syncedSession,
    busy: false,
    error: null,
    deletionCleanup: null,
    pendingDeletion: null,
    completeAccountDeletion: jest.fn(() => Promise.resolve()),
  });
});

afterEach(() => {
  jest.useRealTimers();
  globalThis.fetch = realFetch;
  setApiUnauthorizedListener(null);
  clearApiSession();
});

describe('D1 — delete-confirm response lost, retry answered 401', () => {
  it('module: a 401 on delete-confirm reports the rejected bearer to the auth store', async () => {
    const { fetchFn } = scriptedFetch([
      {
        kind: 'json',
        status: 401,
        body: {
          error: { message: 'The session is no longer valid. Sign in again.' },
        },
      },
    ]);
    await expect(
      confirmAccountDeletion(apiSession, 'challenge-1', fetchFn),
    ).rejects.toBeInstanceOf(AccountDeletionError);
    expect(unauthorizedListener).toHaveBeenCalledTimes(1);
  });

  it('module: a confirm that times out after the request went out must not promise "Nothing was deleted"', async () => {
    const { fetchFn } = scriptedFetch([{ kind: 'hang' }]);
    const pending = confirmAccountDeletion(apiSession, 'challenge-1', fetchFn);
    const settled = pending.catch((e: unknown) => e);
    await act(async () => {
      jest.advanceTimersByTime(15_000);
    });
    const error = (await settled) as AccountDeletionError;
    expect(error).toBeInstanceOf(AccountDeletionError);
    expect(error.message).not.toMatch(/Nothing was deleted/);
  });

  it('screen: lost 200 → retry → 401 must still end the deleted account locally', async () => {
    const { calls, fetchFn } = scriptedFetch([
      {
        kind: 'json',
        body: {
          challenge: 'challenge-1',
          expiresAt: '2026-09-05T00:00:00.000Z',
        },
      },
      { kind: 'hang' },
      {
        kind: 'json',
        status: 401,
        body: {
          error: { message: 'The session is no longer valid. Sign in again.' },
        },
      },
    ]);
    globalThis.fetch = fetchFn;

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<ManageAccountScreen />);
    });
    const confirm = await armDeletion(renderer);
    expect(calls.map(c => c.url)).toEqual([
      'https://api.test/v1/me/delete-request',
    ]);

    // First confirm: the server deletes the account but the response never
    // reaches the phone; the client aborts after 15s.
    await act(async () => {
      confirm.props.onPress();
    });
    await act(async () => {
      jest.advanceTimersByTime(15_000);
    });
    expect(calls[1]!.url).toBe('https://api.test/v1/me/delete-confirm');
    const afterTimeout = allText(renderer);

    // Retry on the same challenge → 401 (account is gone).
    const retry = sheetButton(renderer, 'Permanently delete');
    expect(retry.props.disabled).toBe(false);
    await act(async () => {
      retry.props.onPress();
    });
    expect(calls).toHaveLength(3);
    const afterRetry = allText(renderer);

    const completeAccountDeletion = useAuthStore.getState()
      .completeAccountDeletion as jest.Mock;
    const locallyEnded =
      completeAccountDeletion.mock.calls.length > 0 ||
      unauthorizedListener.mock.calls.length > 0;

    // Observed today (recorded for the log):
    //   afterTimeout contains "Nothing was deleted — please try again."
    //   afterRetry   contains "Your sign-in has expired. Sign in again, then
    //                delete your account." and the dialog is back on review.
    console.log(
      JSON.stringify(
        {
          afterTimeoutSaysNothingDeleted: /Nothing was deleted/.test(
            afterTimeout,
          ),
          afterRetryCopy:
            afterRetry.match(/Your sign-in has expired[^.]*\.[^.]*\./)?.[0] ??
            null,
          backOnReview: /Delete your account\?/.test(afterRetry),
          completeAccountDeletionCalls:
            completeAccountDeletion.mock.calls.length,
          unauthorizedListenerCalls: unauthorizedListener.mock.calls.length,
        },
        null,
        2,
      ),
    );

    // EXPECTED: a 401 after an ambiguous confirm ends the account locally
    // (purge + Keychain clear via completeAccountDeletion, or at minimum the
    // auth store learns the bearer is dead).
    expect(locallyEnded).toBe(true);
    act(() => renderer.unmount());
  });
});

describe('D1 settlement — the session layer decides an ambiguous confirm', () => {
  const lostThen401: Scripted[] = [
    {
      kind: 'json',
      body: { challenge: 'challenge-1', expiresAt: '2026-09-05T00:00:00.000Z' },
    },
    { kind: 'hang' },
    {
      kind: 'json',
      status: 401,
      body: { error: { message: 'The session is no longer valid.' } },
    },
  ];

  /** request → confirm times out → retry answers 401. */
  async function driveLostConfirm() {
    const { calls, fetchFn } = scriptedFetch([...lostThen401]);
    globalThis.fetch = fetchFn;
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<ManageAccountScreen />);
    });
    const confirm = await armDeletion(renderer);
    await act(async () => {
      confirm.props.onPress();
    });
    await act(async () => {
      jest.advanceTimersByTime(15_000);
    });
    const retry = sheetButton(renderer, 'Permanently delete');
    await act(async () => {
      retry.props.onPress();
    });
    await flush();
    expect(calls).toHaveLength(3);
    return renderer;
  }

  it('module: the confirm timeout is retryable and flagged as possibly deleted; the request timeout is not', async () => {
    const hungConfirm = scriptedFetch([{ kind: 'hang' }]);
    const confirmSettled = confirmAccountDeletion(
      apiSession,
      'challenge-1',
      hungConfirm.fetchFn,
    ).catch((e: unknown) => e);
    await act(async () => {
      jest.advanceTimersByTime(15_000);
    });
    expect(await confirmSettled).toMatchObject({
      code: 'deletion.unavailable',
      retryable: true,
      mayHaveDeleted: true,
    });

    const { requestAccountDeletion } = jest.requireActual<
      typeof import('../../src/account/deletion')
    >('../../src/account/deletion');
    const hungRequest = scriptedFetch([{ kind: 'hang' }]);
    const requestSettled = requestAccountDeletion(
      apiSession,
      null,
      hungRequest.fetchFn,
    ).catch((e: unknown) => e);
    await act(async () => {
      jest.advanceTimersByTime(15_000);
    });
    const requestError = (await requestSettled) as AccountDeletionError;
    expect(requestError).toMatchObject({
      code: 'deletion.unavailable',
      retryable: true,
      mayHaveDeleted: false,
    });
    expect(requestError.message).toMatch(/Nothing was deleted/);
  });

  it('module: a confirm the server REFUSED (403/429) is known not to have deleted; a 5xx or 401 is not', async () => {
    const outcomes: Array<[number, boolean]> = [
      [403, false],
      [429, false],
      [503, true],
      [401, true],
    ];
    for (const [status, mayHaveDeleted] of outcomes) {
      const { fetchFn } = scriptedFetch([
        {
          kind: 'json',
          status,
          body: { error: { message: `status ${status}` } },
        },
      ]);
      await expect(
        confirmAccountDeletion(apiSession, 'challenge-1', fetchFn),
      ).rejects.toMatchObject({ mayHaveDeleted });
    }
  });

  it('screen: the sent confirm is recorded in the auth store and a definitive refusal releases it', async () => {
    const { fetchFn } = scriptedFetch([
      {
        kind: 'json',
        body: {
          challenge: 'challenge-1',
          expiresAt: '2026-09-05T00:00:00.000Z',
        },
      },
      {
        kind: 'json',
        status: 403,
        body: {
          error: {
            code: 'account.deletion_challenge_expired',
            message: 'The deletion request expired. Start again.',
          },
        },
      },
    ]);
    globalThis.fetch = fetchFn;
    const sentDuringConfirm: unknown[] = [];
    const unsubscribe = useAuthStore.subscribe(state => {
      sentDuringConfirm.push(state.pendingDeletion);
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<ManageAccountScreen />);
    });
    const confirm = await armDeletion(renderer);
    await act(async () => {
      confirm.props.onPress();
    });
    await flush();
    unsubscribe();
    // Recorded BEFORE the request left, released once the server said no.
    expect(sentDuringConfirm).toContainEqual({
      canonicalAppUserId,
      challenge: 'challenge-1',
    });
    expect(useAuthStore.getState().pendingDeletion).toBeNull();
    expect(allText(renderer)).toContain('Delete your account?');
    act(() => renderer.unmount());
  });

  it('screen: after the 401 the dialog waits for the session verdict — never back on review, the sent confirm stays recorded', async () => {
    const renderer = await driveLostConfirm();
    const copy = allText(renderer);
    expect(unauthorizedListener).toHaveBeenCalledTimes(1);
    expect(unauthorizedListener.mock.calls[0]![0]).toMatchObject({
      bearerToken: 'access-token-1',
      canonicalAppUserId,
    });
    expect(useAuthStore.getState().pendingDeletion).toEqual({
      canonicalAppUserId,
      challenge: 'challenge-1',
    });
    expect(copy).not.toContain('Delete your account?');
    expect(copy).not.toContain('Nothing was deleted');
    expect(copy).toContain('Checking whether your account was deleted');
    // No control can fire a second confirm or dismiss while the verdict is out.
    expect(
      renderer.root
        .findAllByType(Button)
        .filter(node => String(node.props.label).startsWith('Permanently')),
    ).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('screen: verdict ACCOUNT GONE (store ended the account) → the deletion is announced with the local cleanup and the Apple check', async () => {
    const renderer = await driveLostConfirm();
    // What the real store does when the keeper reports the refresh refused
    // after a sent confirm (pinned on the real store below).
    await act(async () => {
      useAuthStore.setState({
        session: null,
        pendingDeletion: null,
        deletionCleanup: { localPurge: 'failed' },
      });
    });
    await flush();
    const notices = mockShowBrandNotice.mock.calls.map(
      c => c[0] as { title: string; detail: string },
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]!.title).toBe('Account deleted');
    expect(notices[0]!.detail).toMatch(/could not be removed/);
    // The lost response may have carried the manual Apple step: an Apple
    // account is told how to check.
    expect(notices[0]!.detail).toMatch(/Sign in with Apple/);
    expect(notices[0]!.detail).not.toMatch(/Nothing was deleted/);
    act(() => renderer.unmount());
  });

  it('screen: verdict STILL SIGNED IN (bearer rotated) → the dialog re-arms on the same challenge and nothing is purged', async () => {
    const renderer = await driveLostConfirm();
    await act(async () => {
      establishApiSession({
        ...apiSession,
        bearerToken: 'access-token-2',
        refreshToken: 'refresh-2',
      });
    });
    await flush();
    const copy = allText(renderer);
    expect(copy).toContain('still here');
    const again = sheetButton(renderer, 'Permanently delete');
    expect(again.props.disabled).toBe(false);
    expect(sheetButton(renderer, 'Keep my account').props.disabled).toBe(false);
    expect(
      useAuthStore.getState().completeAccountDeletion,
    ).not.toHaveBeenCalled();
    expect(mockShowBrandNotice).not.toHaveBeenCalled();
    // The renewed bearer is what the next confirm carries.
    const { calls, fetchFn } = scriptedFetch([
      {
        kind: 'json',
        body: { deleted: true, appleAuthorizationRevocation: 'revoked' },
      },
    ]);
    globalThis.fetch = fetchFn;
    await act(async () => {
      again.props.onPress();
    });
    await flush();
    expect(calls).toEqual([
      { url: 'https://api.test/v1/me/delete-confirm', method: 'POST' },
    ]);
    expect(
      useAuthStore.getState().completeAccountDeletion,
    ).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('screen: NO verdict within the deadline (offline refresh) → honest unknown copy, re-armed, nothing purged', async () => {
    const renderer = await driveLostConfirm();
    await act(async () => {
      jest.advanceTimersByTime(DELETION_SETTLEMENT_DEADLINE_MS);
    });
    await flush();
    const copy = allText(renderer);
    expect(copy).not.toContain('Nothing was deleted');
    expect(copy).toContain('not yet known');
    expect(sheetButton(renderer, 'Permanently delete').props.disabled).toBe(
      false,
    );
    expect(
      useAuthStore.getState().completeAccountDeletion,
    ).not.toHaveBeenCalled();
    expect(useAuthStore.getState().session).toEqual(syncedSession);
    act(() => renderer.unmount());
  });

  it('screen: a plain sign-out while waiting (legacy session, no refresh token) closes the dialog without a deletion notice', async () => {
    const renderer = await driveLostConfirm();
    await act(async () => {
      useAuthStore.setState({ session: null });
    });
    await flush();
    expect(mockShowBrandNotice).not.toHaveBeenCalled();
    expect(
      useAuthStore.getState().completeAccountDeletion,
    ).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});

describe('D1 settlement — real auth store + session keeper', () => {
  const refreshBody = (tokens: { access: string; refresh: string }) => ({
    session: {
      accessToken: tokens.access,
      refreshToken: tokens.refresh,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    },
  });

  function jsonResponse(status: number, body: unknown): Response {
    return {
      ok: status < 400,
      status,
      json: () => Promise.resolve(body),
    } as unknown as Response;
  }

  /** /v1/auth/refresh answers 200 once (launch), then refuses forever. */
  function installRefreshRoute() {
    let refreshes = 0;
    globalThis.fetch = ((input: unknown) => {
      const url = String(input);
      if (!url.endsWith('/v1/auth/refresh')) {
        return Promise.reject(new Error(`unexpected fetch ${url}`));
      }
      refreshes += 1;
      return Promise.resolve(
        refreshes === 1
          ? jsonResponse(
              200,
              refreshBody({ access: 'access-2', refresh: 'refresh-2' }),
            )
          : jsonResponse(401, { error: { message: 'Sign in again.' } }),
      );
    }) as typeof globalThis.fetch;
  }

  async function hydrateFromVault() {
    __keychainStore.set(SESSION_VAULT_SERVICE, {
      username: 'session',
      password: JSON.stringify({
        version: 1,
        provider: 'apple',
        canonicalAppUserId,
        refreshToken: 'refresh-1',
        email: 'alex@example.com',
        displayName: 'Alex Chen',
      }),
    });
    await act(async () => {
      await useAuthStore.getState().hydrate();
    });
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalAppUserId,
    );
    expect(getApiSession()?.bearerToken).toBe('access-2');
  }

  beforeEach(() => {
    __keychainStore.clear();
    stopSessionKeeper();
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    // The real store, wired the way the app wires it (the unauthorized
    // listener installed by authStore, not this file's spy).
    setApiUnauthorizedListener(null);
    useAuthStore.setState({
      ...realAuthActions,
      hydrated: false,
      session: null,
      busy: false,
      error: null,
      deletionCleanup: null,
      pendingDeletion: null,
    });
    installRefreshRoute();
  });

  afterEach(() => {
    stopSessionKeeper();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    __keychainStore.clear();
  });

  it('a refused refresh AFTER a sent confirm ends the ACCOUNT: purge attempted, Keychain cleared, owner signed out, cleanup reported', async () => {
    await hydrateFromVault();
    const bearer = getApiSession()!.bearerToken;

    useAuthStore.getState().markDeletionConfirmSent('challenge-1');
    expect(useAuthStore.getState().pendingDeletion).toEqual({
      canonicalAppUserId,
      challenge: 'challenge-1',
    });

    // What deletion.ts does on the confirm's 401.
    reportApiUnauthorized(bearer);
    await flush(20);

    const state = useAuthStore.getState();
    expect(state.session).toBeNull();
    expect(state.pendingDeletion).toBeNull();
    // getDb() throws in this file → every purge attempt fails and says so.
    expect(state.deletionCleanup).toEqual({ localPurge: 'failed' });
    expect(state.error).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(__keychainStore.get(SESSION_VAULT_SERVICE)).toBeUndefined();
  });

  it('a refused refresh WITHOUT a sent confirm stays the plain revoked-session sign-out (no deletion cleanup)', async () => {
    await hydrateFromVault();
    reportApiUnauthorized(getApiSession()!.bearerToken);
    await flush(20);

    const state = useAuthStore.getState();
    expect(state.session).toBeNull();
    expect(state.deletionCleanup).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(__keychainStore.get(SESSION_VAULT_SERVICE)).toBeUndefined();
  });

  it('a sent confirm the server then REFUSED is released, so a later revocation is again a plain sign-out', async () => {
    await hydrateFromVault();
    useAuthStore.getState().markDeletionConfirmSent('challenge-1');
    useAuthStore.getState().markDeletionConfirmRefused('challenge-1');
    expect(useAuthStore.getState().pendingDeletion).toBeNull();

    reportApiUnauthorized(getApiSession()!.bearerToken);
    await flush(20);
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().deletionCleanup).toBeNull();
  });

  it('a rotated bearer does NOT release the sent confirm (the server may still be finishing it)', async () => {
    await hydrateFromVault();
    useAuthStore.getState().markDeletionConfirmSent('challenge-1');
    establishApiSession({
      ...getApiSession()!,
      bearerToken: 'access-3',
    });
    expect(useAuthStore.getState().pendingDeletion).toEqual({
      canonicalAppUserId,
      challenge: 'challenge-1',
    });
  });
});

describe('D4 — manual Apple step vs local purge failure', () => {
  it('purge FAILED + manual_action_required → the user is still told the Apple step', async () => {
    const { fetchFn } = scriptedFetch([
      {
        kind: 'json',
        body: {
          challenge: 'challenge-1',
          expiresAt: '2026-09-05T00:00:00.000Z',
        },
      },
      {
        kind: 'json',
        body: {
          deleted: true,
          appleAuthorizationRevocation: 'manual_action_required',
        },
      },
    ]);
    globalThis.fetch = fetchFn;
    useAuthStore.setState({
      completeAccountDeletion: jest.fn(async () => {
        useAuthStore.setState({
          session: null,
          deletionCleanup: { localPurge: 'failed' },
        });
      }),
    });

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<ManageAccountScreen />);
    });
    const confirm = await armDeletion(renderer);
    await act(async () => {
      confirm.props.onPress();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const notices = mockShowBrandNotice.mock.calls.map(
      c => c[0] as { eyebrow: string; detail: string },
    );
    console.log(JSON.stringify(notices, null, 2));
    expect(notices.length).toBeGreaterThan(0);
    const mentionsAppleStep = notices.some(n =>
      /Sign in with Apple|Stop Using Apple ID/.test(n.detail),
    );
    const mentionsLocalCleanup = notices.some(n =>
      /could not be removed/.test(n.detail),
    );
    expect(mentionsLocalCleanup).toBe(true);
    expect(mentionsAppleStep).toBe(true);
    act(() => renderer.unmount());
  });
});
