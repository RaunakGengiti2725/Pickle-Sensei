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
 *
 * The `R2` blocks pin the second round (adversary findings against the first
 * fix, `__tests__/attack/deletionSettlementAttack.test.tsx`): only a refresh
 * that STARTS after the confirm's 401 is its verdict (a rotation that merely
 * preceded the 401 — or was already in flight — proves nothing about the
 * account now), a 401 naming a bearer this device already rotated away just
 * re-arms the confirm, the session layer's end-of-account cleanup runs once
 * and its notice is the only one even when the server's 200 lands later, and
 * a delete-REQUEST 401 on a durable session waits for the renewed sign-in
 * instead of telling a signed-in user to sign in again.
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
import {
  markDeletionConfirmRefused,
  markDeletionConfirmSent,
  useAuthStore,
  type AuthSession,
} from '../../src/auth/authStore';
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
import {
  refreshSessionNow,
  stopSessionKeeper,
} from '../../src/account/sessionKeeper';
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
      sessionRenewed: false,
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
      sessionRenewed: false,
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
    // What the real store does when the keeper's refresh is ACCEPTED after
    // the confirm was sent (pinned on the real store below): the bearer is
    // renewed and the pending record is flagged, not released.
    await act(async () => {
      establishApiSession({
        ...apiSession,
        bearerToken: 'access-token-2',
        refreshToken: 'refresh-2',
      });
      useAuthStore.setState(s => ({
        pendingDeletion: { ...s.pendingDeletion!, sessionRenewed: true },
      }));
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
    // What signOut / the legacy expiry path leave behind: no session, no
    // pending record, no cleanup report.
    await act(async () => {
      useAuthStore.setState({ session: null, pendingDeletion: null });
    });
    await flush();
    expect(allText(renderer)).not.toContain('Delete your account?');
    expect(mockShowBrandNotice).not.toHaveBeenCalled();
    expect(
      useAuthStore.getState().completeAccountDeletion,
    ).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('screen: a late verdict after the dialog gave up (deadline passed, then the store ended the account) is still announced', async () => {
    const renderer = await driveLostConfirm();
    await act(async () => {
      jest.advanceTimersByTime(DELETION_SETTLEMENT_DEADLINE_MS);
    });
    await flush();
    // The user closes the dialog and moves on; the keeper's refresh is only
    // refused later (it was offline).
    await act(async () => {
      sheetButton(renderer, 'Keep my account').props.onPress();
    });
    await flush();
    await act(async () => {
      useAuthStore.setState({
        session: null,
        pendingDeletion: null,
        deletionCleanup: { localPurge: 'in_progress' },
      });
    });
    await flush();
    expect(mockShowBrandNotice).not.toHaveBeenCalled();
    await act(async () => {
      useAuthStore.setState({ deletionCleanup: { localPurge: 'complete' } });
    });
    await flush();
    const notices = mockShowBrandNotice.mock.calls.map(
      c => c[0] as { title: string; detail: string },
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]!.title).toBe('Account deleted');
    expect(notices[0]!.detail).not.toMatch(/could not be removed/);
    expect(notices[0]!.detail).toMatch(/Sign in with Apple/);
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

  /** /v1/auth/refresh answers 200 `accepted` times (the launch refresh is
   * the first), then refuses forever. */
  function installRefreshRoute(accepted = 1) {
    let refreshes = 0;
    globalThis.fetch = ((input: unknown) => {
      const url = String(input);
      if (!url.endsWith('/v1/auth/refresh')) {
        return Promise.reject(new Error(`unexpected fetch ${url}`));
      }
      refreshes += 1;
      return Promise.resolve(
        refreshes <= accepted
          ? jsonResponse(
              200,
              refreshBody({
                access: `access-${refreshes + 1}`,
                refresh: `refresh-${refreshes + 1}`,
              }),
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

    markDeletionConfirmSent('challenge-1');
    expect(useAuthStore.getState().pendingDeletion).toEqual({
      canonicalAppUserId,
      challenge: 'challenge-1',
      sessionRenewed: false,
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
    markDeletionConfirmSent('challenge-1');
    markDeletionConfirmRefused('challenge-1');
    expect(useAuthStore.getState().pendingDeletion).toBeNull();

    reportApiUnauthorized(getApiSession()!.bearerToken);
    await flush(20);
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().deletionCleanup).toBeNull();
  });

  it('an ACCEPTED refresh after a sent confirm flags the account as still there but does NOT release the record; a later refusal still ends the account', async () => {
    installRefreshRoute(2);
    await hydrateFromVault();
    markDeletionConfirmSent('challenge-1');

    // The confirm's 401 → refresh → the server renews the bearer: the
    // account existed at that moment.
    reportApiUnauthorized(getApiSession()!.bearerToken);
    await flush(20);
    expect(getApiSession()?.bearerToken).toBe('access-3');
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalAppUserId,
    );
    expect(useAuthStore.getState().pendingDeletion).toEqual({
      canonicalAppUserId,
      challenge: 'challenge-1',
      sessionRenewed: true,
    });
    expect(useAuthStore.getState().deletionCleanup).toBeNull();

    // The server finished the deletion after all: the next 401's refresh is
    // refused, and the account (not just the session) is ended locally.
    reportApiUnauthorized(getApiSession()!.bearerToken);
    await flush(20);
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().pendingDeletion).toBeNull();
    expect(useAuthStore.getState().deletionCleanup).toEqual({
      localPurge: 'failed',
    });
    expect(__keychainStore.get(SESSION_VAULT_SERVICE)).toBeUndefined();
  });

  it('R2: a 401 while the confirm is pending re-opens the question — the earlier renewal is cleared and only the refresh it triggers may set it again; a stale-bearer 401 changes nothing', async () => {
    installRefreshRoute(3);
    await hydrateFromVault();
    markDeletionConfirmSent('challenge-1');
    reportApiUnauthorized('access-2');
    await flush(20);
    expect(getApiSession()?.bearerToken).toBe('access-3');
    expect(useAuthStore.getState().pendingDeletion?.sessionRenewed).toBe(true);

    // The confirm (or any route) now says 401 for the CURRENT bearer: the
    // rotation above no longer vouches for the account.
    reportApiUnauthorized('access-3');
    expect(useAuthStore.getState().pendingDeletion).toEqual({
      canonicalAppUserId,
      challenge: 'challenge-1',
      sessionRenewed: false,
    });
    await flush(20);
    expect(getApiSession()?.bearerToken).toBe('access-4');
    expect(useAuthStore.getState().pendingDeletion?.sessionRenewed).toBe(true);

    // A 401 naming a bearer this device already rotated away is dropped.
    reportApiUnauthorized('access-2');
    await flush(20);
    expect(getApiSession()?.bearerToken).toBe('access-4');
    expect(useAuthStore.getState().pendingDeletion?.sessionRenewed).toBe(true);
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalAppUserId,
    );
  });

  it('R2: a refresh already in flight when the 401 arrives is not its verdict — the keeper runs one more, and that one flags the record', async () => {
    let refreshes = 0;
    let releaseSecond!: (response: Response) => void;
    const secondRefresh = new Promise<Response>(resolve => {
      releaseSecond = resolve;
    });
    globalThis.fetch = ((input: unknown) => {
      const url = String(input);
      if (!url.endsWith('/v1/auth/refresh')) {
        return Promise.reject(new Error(`unexpected fetch ${url}`));
      }
      refreshes += 1;
      if (refreshes === 2) return secondRefresh;
      return Promise.resolve(
        jsonResponse(
          200,
          refreshBody({
            access: `access-${refreshes + 1}`,
            refresh: `refresh-${refreshes + 1}`,
          }),
        ),
      );
    }) as typeof globalThis.fetch;
    await hydrateFromVault();
    markDeletionConfirmSent('challenge-1');

    // A scheduled rotation is already on its way…
    refreshSessionNow();
    await flush(5);
    expect(refreshes).toBe(2);
    // …when the confirm answers 401 for the bearer that rotation replaces.
    reportApiUnauthorized('access-2');
    await flush(5);
    expect(refreshes).toBe(2);

    // The in-flight refresh lands accepted: the account existed when THAT
    // request was made, which may be before the deletion finished.
    releaseSecond(
      jsonResponse(
        200,
        refreshBody({ access: 'access-3', refresh: 'refresh-3' }),
      ),
    );
    await flush(20);
    expect(getApiSession()?.bearerToken).toBe('access-4');
    expect(refreshes).toBe(3);
    expect(useAuthStore.getState().pendingDeletion).toEqual({
      canonicalAppUserId,
      challenge: 'challenge-1',
      sessionRenewed: true,
    });
  });

  it('R2: a refresh already in flight when the 401 arrives is not its verdict — refused follow-up ends the account', async () => {
    let refreshes = 0;
    let releaseSecond!: (response: Response) => void;
    const secondRefresh = new Promise<Response>(resolve => {
      releaseSecond = resolve;
    });
    globalThis.fetch = ((input: unknown) => {
      const url = String(input);
      if (!url.endsWith('/v1/auth/refresh')) {
        return Promise.reject(new Error(`unexpected fetch ${url}`));
      }
      refreshes += 1;
      if (refreshes === 1) {
        return Promise.resolve(
          jsonResponse(
            200,
            refreshBody({ access: 'access-2', refresh: 'refresh-2' }),
          ),
        );
      }
      if (refreshes === 2) return secondRefresh;
      return Promise.resolve(
        jsonResponse(401, { error: { message: 'Sign in again.' } }),
      );
    }) as typeof globalThis.fetch;
    await hydrateFromVault();
    markDeletionConfirmSent('challenge-1');
    refreshSessionNow();
    await flush(5);
    reportApiUnauthorized('access-2');
    const flagged: boolean[] = [];
    const unsubscribe = useAuthStore.subscribe(state => {
      if (state.pendingDeletion)
        flagged.push(state.pendingDeletion.sessionRenewed);
    });
    releaseSecond(
      jsonResponse(
        200,
        refreshBody({ access: 'access-3', refresh: 'refresh-3' }),
      ),
    );
    await flush(30);
    unsubscribe();

    // The pre-401 rotation never counted as "still here"…
    expect(flagged).not.toContain(true);
    // …and the follow-up's refusal ended the ACCOUNT.
    expect(refreshes).toBe(3);
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().pendingDeletion).toBeNull();
    expect(useAuthStore.getState().deletionCleanup).toEqual({
      localPurge: 'failed',
    });
  });

  it('the cleanup report goes through in_progress while the session is already gone, then lands on the purge outcome', async () => {
    await hydrateFromVault();
    markDeletionConfirmSent('challenge-1');
    const reports: Array<[boolean, string | null]> = [];
    const unsubscribe = useAuthStore.subscribe(state => {
      reports.push([
        state.session === null,
        state.deletionCleanup?.localPurge ?? null,
      ]);
    });
    reportApiUnauthorized(getApiSession()!.bearerToken);
    await flush(20);
    unsubscribe();
    expect(reports).toContainEqual([true, 'in_progress']);
    expect(reports[reports.length - 1]).toEqual([true, 'failed']);
    expect(reports).not.toContainEqual([true, null]);
  });
});

describe('R2 — settlement seams the first fix got wrong (screen, spy listener)', () => {
  const durableApiSession = {
    ...apiSession,
    refreshToken: 'refresh-token-1',
  };
  const challengeIssued: Scripted = {
    kind: 'json',
    body: { challenge: 'challenge-1', expiresAt: '2026-09-05T00:00:00.000Z' },
  };
  const unauthorized: Scripted = {
    kind: 'json',
    status: 401,
    body: { error: { message: 'The session is no longer valid.' } },
  };

  /** A fetch whose next answer the test releases by hand. */
  function heldFetch(before: Scripted[]) {
    const scripted = scriptedFetch(before);
    let release!: (response: Response) => void;
    const held = new Promise<Response>(resolve => {
      release = resolve;
    });
    let remaining = before.length;
    globalThis.fetch = ((input, init) => {
      if (remaining > 0) {
        remaining -= 1;
        return scripted.fetchFn(input, init);
      }
      return held;
    }) as FetchFn;
    return {
      release: (status: number, body: unknown) =>
        release({
          ok: status < 400,
          status,
          json: () => Promise.resolve(body),
        } as unknown as Response),
    };
  }

  function mount() {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<ManageAccountScreen />);
    });
    return renderer;
  }

  async function pressContinue(renderer: TestRenderer.ReactTestRenderer) {
    await act(async () => {
      pressable(renderer, 'Delete account')[0]!.props.onPress();
    });
    await act(async () => {
      pressable(renderer, 'Skip the survey')[0]!.props.onPress();
    });
    await act(async () => {
      sheetButton(renderer, 'Continue to delete').props.onPress();
    });
    await flush();
  }

  it('request 401 on a durable session: the dialog holds, and once the store renews the bearer it says so — never "Sign in again"', async () => {
    establishApiSession(durableApiSession);
    globalThis.fetch = scriptedFetch([unauthorized]).fetchFn;
    const renderer = mount();
    await pressContinue(renderer);

    expect(unauthorizedListener).toHaveBeenCalledTimes(1);
    expect(allText(renderer)).not.toMatch(/Sign in again/);
    // Still on the request step, held: nothing to tap until the verdict.
    expect(sheetButton(renderer, 'Requesting…').props.disabled).toBe(true);
    expect(sheetButton(renderer, 'Keep my account').props.disabled).toBe(true);

    await act(async () => {
      establishApiSession({
        ...durableApiSession,
        bearerToken: 'access-token-2',
        refreshToken: 'refresh-token-2',
      });
    });
    await flush();
    const copy = allText(renderer);
    expect(copy).toMatch(/sign-in was renewed/);
    expect(copy).toMatch(/Nothing was deleted/);
    expect(copy).not.toMatch(/Sign in again/);
    expect(sheetButton(renderer, 'Continue to delete').props.disabled).toBe(
      false,
    );
    expect(useAuthStore.getState().pendingDeletion).toBeNull();
    expect(
      useAuthStore.getState().completeAccountDeletion,
    ).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('request 401 on a durable session, sign-in already renewed while the request travelled: told at once', async () => {
    establishApiSession(durableApiSession);
    globalThis.fetch = ((input, init) => {
      establishApiSession({
        ...durableApiSession,
        bearerToken: 'access-token-2',
        refreshToken: 'refresh-token-2',
      });
      return scriptedFetch([unauthorized]).fetchFn(input, init);
    }) as FetchFn;
    const renderer = mount();
    await pressContinue(renderer);
    const copy = allText(renderer);
    expect(copy).toMatch(/sign-in was renewed/);
    expect(copy).not.toMatch(/Sign in again/);
    expect(sheetButton(renderer, 'Continue to delete').props.disabled).toBe(
      false,
    );
    act(() => renderer.unmount());
  });

  it('request 401 on a durable session, no renewal by the deadline (refresh offline): honest copy, still actionable, still nothing deleted', async () => {
    establishApiSession(durableApiSession);
    globalThis.fetch = scriptedFetch([unauthorized]).fetchFn;
    const renderer = mount();
    await pressContinue(renderer);
    await act(async () => {
      jest.advanceTimersByTime(DELETION_SETTLEMENT_DEADLINE_MS);
    });
    await flush();
    const copy = allText(renderer);
    expect(copy).toMatch(/could not be reached to renew/);
    expect(copy).toMatch(/Nothing was deleted/);
    expect(copy).not.toMatch(/Sign in again/);
    expect(sheetButton(renderer, 'Continue to delete').props.disabled).toBe(
      false,
    );
    act(() => renderer.unmount());
  });

  it('request 401 on a durable session, the store signs the user out instead: the dialog closes', async () => {
    establishApiSession(durableApiSession);
    globalThis.fetch = scriptedFetch([unauthorized]).fetchFn;
    const renderer = mount();
    await pressContinue(renderer);
    await act(async () => {
      clearApiSession();
      useAuthStore.setState({ session: null });
    });
    await flush();
    expect(allText(renderer)).not.toContain('Delete your account?');
    expect(mockShowBrandNotice).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('request 401 on a LEGACY session (no refresh token): the user is told to sign in again, as before', async () => {
    globalThis.fetch = scriptedFetch([unauthorized]).fetchFn;
    const renderer = mount();
    await pressContinue(renderer);
    expect(allText(renderer)).toMatch(
      /Your sign-in has expired\. Sign in again, then delete your account\./,
    );
    expect(sheetButton(renderer, 'Continue to delete').props.disabled).toBe(
      false,
    );
    act(() => renderer.unmount());
  });

  it('confirm 401 naming a bearer this device already rotated away: re-armed on the same challenge with no verdict claimed, the sent confirm stays recorded', async () => {
    establishApiSession(durableApiSession);
    const confirm = heldFetch([challengeIssued]);
    const renderer = mount();
    const confirmButton = await armDeletion(renderer);
    await act(async () => {
      confirmButton.props.onPress();
    });
    await flush();
    // The keeper rotates while the confirm travels (the store flags the
    // record renewed, as pinned on the real store).
    await act(async () => {
      establishApiSession({
        ...durableApiSession,
        bearerToken: 'access-token-2',
        refreshToken: 'refresh-token-2',
      });
      const pending = useAuthStore.getState().pendingDeletion!;
      useAuthStore.setState({
        pendingDeletion: { ...pending, sessionRenewed: true },
      });
    });
    await act(async () => {
      confirm.release(401, {
        error: { message: 'The session is no longer valid.' },
      });
    });
    await flush();

    // apiSession drops a 401 for a bearer that is no longer current.
    expect(unauthorizedListener).not.toHaveBeenCalled();
    const copy = allText(renderer);
    expect(copy).not.toMatch(/did not go through|still here/);
    expect(copy).not.toMatch(/Hold on while/);
    expect(copy).toMatch(/not yet known whether your account was deleted/);
    expect(copy).toMatch(/sign-in was renewed while that request/);
    expect(sheetButton(renderer, 'Permanently delete').props.disabled).toBe(
      false,
    );
    expect(useAuthStore.getState().pendingDeletion).toEqual({
      canonicalAppUserId,
      challenge: 'challenge-1',
      sessionRenewed: true,
    });
    expect(
      useAuthStore.getState().completeAccountDeletion,
    ).not.toHaveBeenCalled();
    expect(mockShowBrandNotice).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('the store ended the account while the confirm travelled, then its 200 lands: no second cleanup, one notice, the truthful purge report kept', async () => {
    const confirm = heldFetch([challengeIssued]);
    const renderer = mount();
    const confirmButton = await armDeletion(renderer);
    await act(async () => {
      confirmButton.props.onPress();
    });
    await flush();
    // The real store on a refused refresh after the sent confirm.
    await act(async () => {
      clearApiSession();
      useAuthStore.setState({
        session: null,
        pendingDeletion: null,
        deletionCleanup: { localPurge: 'failed' },
      });
    });
    await flush();
    expect(mockShowBrandNotice).toHaveBeenCalledTimes(1);

    await act(async () => {
      confirm.release(200, {
        deleted: true,
        appleAuthorizationRevocation: 'not_applicable',
      });
    });
    await flush();

    expect(
      useAuthStore.getState().completeAccountDeletion,
    ).not.toHaveBeenCalled();
    expect(mockShowBrandNotice).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().deletionCleanup).toEqual({
      localPurge: 'failed',
    });
    expect(allText(renderer)).not.toContain('Delete your account?');
    act(() => renderer.unmount());
  });

  it('the store ended the account and its cleanup is still running when the 200 lands: the one notice carries what the server said about Apple', async () => {
    const confirm = heldFetch([challengeIssued]);
    const renderer = mount();
    const confirmButton = await armDeletion(renderer);
    await act(async () => {
      confirmButton.props.onPress();
    });
    await flush();
    await act(async () => {
      clearApiSession();
      useAuthStore.setState({
        session: null,
        pendingDeletion: null,
        deletionCleanup: { localPurge: 'in_progress' },
      });
    });
    await flush();
    expect(mockShowBrandNotice).not.toHaveBeenCalled();

    await act(async () => {
      confirm.release(200, {
        deleted: true,
        appleAuthorizationRevocation: 'manual_action_required',
      });
    });
    await flush();
    expect(mockShowBrandNotice).not.toHaveBeenCalled();

    await act(async () => {
      useAuthStore.setState({ deletionCleanup: { localPurge: 'failed' } });
    });
    await flush();
    const notices = mockShowBrandNotice.mock.calls.map(
      c => c[0] as { detail: string },
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]!.detail).toMatch(/could not be removed/);
    expect(notices[0]!.detail).toMatch(/Stop Using Apple ID/);
    // The server answered, so the "check whether it is still listed" copy for
    // a lost answer is not what the user is told.
    expect(notices[0]!.detail).not.toMatch(
      /confirmation from the server was lost/,
    );
    expect(
      useAuthStore.getState().completeAccountDeletion,
    ).not.toHaveBeenCalled();
    act(() => renderer.unmount());
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
