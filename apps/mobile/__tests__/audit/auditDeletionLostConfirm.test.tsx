import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * Structural audit probe (mobile-settings-account, pass 1).
 *
 * Two-step deletion when the server performs the delete-confirm but the
 * client never sees the 200 (15 s abort, connection drop). The real
 * `deletion.ts` client runs against a scripted `fetch`; only the SQLite and
 * navigation seams are faked. The auth store's real `completeAccountDeletion`
 * is replaced by a spy because it is the ONLY place the local purge and
 * Keychain clear happen — the probe asks whether anything ever reaches it,
 * or whether the current-bearer 401 is at least reported to the auth store
 * the way every other API client (data/api, training/api, accessApi) does.
 */

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

import { ManageAccountScreen } from '../../src/screens/ManageAccountScreen';
import { Button } from '../../src/design/components';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import {
  clearApiSession,
  establishApiSession,
  setApiUnauthorizedListener,
  type ApiSession,
} from '../../src/account/apiSession';
import { confirmAccountDeletion } from '../../src/account/deletion';

const canonicalAppUserId = '11111111-1111-4111-8111-111111111111';

const authSession: AuthSession = {
  provider: 'apple',
  subject: canonicalAppUserId,
  canonicalAppUserId,
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
};

const apiSession: ApiSession = {
  apiBaseUrl: 'https://api.example.test/functions/v1/api',
  bearerToken: 'access-token-1',
  refreshToken: 'refresh-token-1',
  canonicalAppUserId,
  provider: 'apple',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A fetch that never answers until the caller's signal aborts it. */
function neverAnswers(init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    signal.addEventListener('abort', () => reject(new Error('aborted')));
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

const originalFetch = globalThis.fetch;
const unauthorized = jest.fn();
const completeAccountDeletion = jest.fn(() => Promise.resolve());

beforeEach(() => {
  unauthorized.mockClear();
  completeAccountDeletion.mockClear();
  establishApiSession(apiSession);
  setApiUnauthorizedListener(unauthorized);
  useAuthStore.setState({
    hydrated: true,
    session: authSession,
    busy: false,
    error: null,
    completeAccountDeletion,
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setApiUnauthorizedListener(null);
  clearApiSession();
  jest.useRealTimers();
});

describe('audit: delete-confirm whose success response is lost', () => {
  it('client: a 401 on delete-confirm reports the rejected bearer to the auth store like every other API client', async () => {
    const fetchFn = jest.fn(async () =>
      jsonResponse(401, {
        error: { code: 'unauthorized', message: 'Invalid or expired token.' },
      }),
    );
    await expect(
      confirmAccountDeletion(apiSession, 'challenge-1', fetchFn),
    ).rejects.toMatchObject({ code: 'deletion.session_expired' });
    // data/api.ts:105, training/api.ts:445, accessApi.ts:177 all call
    // reportApiUnauthorized(token) on 401 so the keeper can rotate or end the
    // session; the deletion client is the one route that does not.
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });

  it('screen: lost 200 → retry → 401 must still end the deleted account locally (purge / Keychain / sign-out)', async () => {
    jest.useFakeTimers();
    let confirmCalls = 0;
    globalThis.fetch = jest.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/v1/me/delete-request')) {
          return jsonResponse(200, {
            challenge: 'challenge-1',
            expiresAt: '2026-08-31T00:00:00.000Z',
          });
        }
        if (url.endsWith('/v1/me/delete-confirm')) {
          confirmCalls += 1;
          // 1st confirm: the server deletes the account but the response is
          // lost — the client's 15 s abort fires. 2nd confirm (same
          // challenge): the account is gone, the bearer no longer verifies.
          if (confirmCalls === 1) return neverAnswers(init);
          return jsonResponse(401, {
            error: { code: 'unauthorized', message: 'Invalid token.' },
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      },
    ) as typeof fetch;

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<ManageAccountScreen />);
    });
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
    let confirm = sheetButton(renderer, 'Permanently delete');
    expect(confirm.props.disabled).toBe(false);

    await act(async () => {
      confirm.props.onPress();
    });
    expect(confirmCalls).toBe(1);
    // The 15 s client deadline fires: retryable → the SAME challenge stays
    // armed and the copy asserts nothing was deleted.
    await act(async () => {
      jest.advanceTimersByTime(15_000);
    });
    await act(async () => {
      await Promise.resolve();
    });
    const afterAbort = allText(renderer);
    expect(afterAbort).toContain('Nothing was deleted');
    confirm = sheetButton(renderer, 'Permanently delete');
    expect(confirm.props.disabled).toBe(false);

    await act(async () => {
      confirm.props.onPress();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(confirmCalls).toBe(2);
    const afterRetry = allText(renderer);
    expect(afterRetry).toContain('Sign in again');

    // The account no longer exists server-side. Locally the app must not be
    // left signed in with the deleted owner's rows: either the post-confirm
    // cleanup runs, or the rejected bearer is reported so the keeper can
    // discover the revoked refresh token and end the session.
    const endedLocally =
      completeAccountDeletion.mock.calls.length > 0 ||
      unauthorized.mock.calls.length > 0;
    expect({
      completeAccountDeletionCalls: completeAccountDeletion.mock.calls.length,
      unauthorizedReports: unauthorized.mock.calls.length,
      stillSignedIn: useAuthStore.getState().session !== null,
      endedLocally,
    }).toEqual(expect.objectContaining({ endedLocally: true }));
    act(() => renderer.unmount());
  });
});
