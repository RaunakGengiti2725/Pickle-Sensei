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

import { ManageAccountScreen } from '../../src/screens/ManageAccountScreen';
import { Button } from '../../src/design/components';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import {
  clearApiSession,
  establishApiSession,
  setApiUnauthorizedListener,
} from '../../src/account/apiSession';
import {
  AccountDeletionError,
  confirmAccountDeletion,
} from '../../src/account/deletion';

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
