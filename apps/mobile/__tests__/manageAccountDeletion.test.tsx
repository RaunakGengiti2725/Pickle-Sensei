/**
 * ManageAccountScreen deletion dialog — the two outcomes that can only be
 * surfaced ONCE because the session is gone right after:
 *
 * - A delete-confirm whose response was lost (client abort after the request
 *   went out) followed by a 401 on the same challenge means the server has
 *   already deleted the account: the dialog must end the account locally
 *   (completeAccountDeletion) instead of sending the user to "sign in again".
 *   A 401 on a FIRST confirm (no ambiguous attempt before it) still means the
 *   session expired and nothing was deleted.
 * - After a confirmed deletion, a failed local purge and a manual Apple
 *   revocation step are independent facts; both must reach the user in the
 *   single notice BrandNotice can show.
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));

jest.mock('../src/data/db', () => ({
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
jest.mock('../src/design/BrandNotice', () => ({
  showBrandNotice: (...args: unknown[]) => mockShowBrandNotice(...args),
}));

import { ManageAccountScreen } from '../src/screens/ManageAccountScreen';
import { Button } from '../src/design/components';
import { useAuthStore, type AuthSession } from '../src/auth/authStore';
import {
  clearApiSession,
  establishApiSession,
  setApiUnauthorizedListener,
} from '../src/account/apiSession';

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

const SIGN_IN_AGAIN =
  'Your sign-in has expired. Sign in again, then delete your account.';
const CHALLENGE_RESPONSE = {
  kind: 'json' as const,
  body: { challenge: 'challenge-1', expiresAt: '2026-09-05T00:00:00.000Z' },
};
const UNAUTHORIZED = {
  kind: 'json' as const,
  status: 401,
  body: {
    error: { message: 'The session is no longer valid. Sign in again.' },
  },
};

interface Scripted {
  /** 'hang' → never resolves; rejects with AbortError once the signal fires. */
  kind: 'hang' | 'json';
  status?: number;
  body?: unknown;
}

function scriptedFetch(script: Scripted[]) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchFn: typeof globalThis.fetch = (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
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
  const matches = renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!;
}

function sheetButtons(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root
    .findAllByType(Button)
    .filter(node => String(node.props.label).startsWith(label));
}

function sheetButton(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const matches = sheetButtons(renderer, label);
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!;
}

function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<ManageAccountScreen />);
  });
  return renderer;
}

/** Delete account → skip survey → Continue to delete → wait out the 5s arm. */
async function armDeletion(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    pressable(renderer, 'Delete account').props.onPress();
  });
  await act(async () => {
    pressable(renderer, 'Skip the survey').props.onPress();
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

async function pressConfirm(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    sheetButton(renderer, 'Permanently delete').props.onPress();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function completeAccountDeletionMock() {
  return useAuthStore.getState().completeAccountDeletion as jest.Mock;
}

function notices(): Array<{ eyebrow?: string; detail: string }> {
  return mockShowBrandNotice.mock.calls.map(
    c => c[0] as { eyebrow?: string; detail: string },
  );
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
    completeAccountDeletion: jest.fn(async () => {
      useAuthStore.setState({
        session: null,
        deletionCleanup: { localPurge: 'complete' },
      });
    }),
  });
});

afterEach(() => {
  jest.useRealTimers();
  globalThis.fetch = realFetch;
  setApiUnauthorizedListener(null);
  clearApiSession();
});

describe('lost delete-confirm response', () => {
  it('lost 200 → retry → 401 ends the deleted account locally, never "sign in again"', async () => {
    const { calls, fetchFn } = scriptedFetch([
      CHALLENGE_RESPONSE,
      { kind: 'hang' },
      UNAUTHORIZED,
    ]);
    globalThis.fetch = fetchFn;
    const renderer = renderScreen();
    await armDeletion(renderer);

    // First confirm: the server deletes the account but the 200 never
    // reaches the phone; the client aborts after 15s.
    await pressConfirm(renderer);
    await act(async () => {
      jest.advanceTimersByTime(15_000);
    });
    expect(calls[1]).toEqual({
      url: 'https://api.test/v1/me/delete-confirm',
      body: { challenge: 'challenge-1' },
    });
    const afterTimeout = allText(renderer);
    expect(afterTimeout).not.toMatch(/Nothing was deleted/);
    expect(afterTimeout).toMatch(/may or may not/);
    // The same challenge stays armed for the retry.
    expect(sheetButton(renderer, 'Permanently delete').props.disabled).toBe(
      false,
    );
    expect(completeAccountDeletionMock()).not.toHaveBeenCalled();

    // Retry on the same challenge → 401: the account is already gone.
    await pressConfirm(renderer);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.body).toEqual({ challenge: 'challenge-1' });

    expect(completeAccountDeletionMock()).toHaveBeenCalledTimes(1);
    expect(unauthorizedListener).toHaveBeenCalledTimes(1);
    expect(allText(renderer)).not.toContain(SIGN_IN_AGAIN);
    expect(allText(renderer)).not.toContain('Sign in again, then delete');
    // The dialog closed with the deletion; nothing is left to retry.
    expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('a lost confirm followed by a real answer still honours that answer', async () => {
    const { fetchFn } = scriptedFetch([
      CHALLENGE_RESPONSE,
      { kind: 'hang' },
      {
        kind: 'json',
        status: 403,
        body: {
          error: {
            code: 'account.deletion_challenge_expired',
            message: 'The deletion request expired. Start again from Settings.',
          },
        },
      },
    ]);
    globalThis.fetch = fetchFn;
    const renderer = renderScreen();
    await armDeletion(renderer);
    await pressConfirm(renderer);
    await act(async () => {
      jest.advanceTimersByTime(15_000);
    });
    await pressConfirm(renderer);

    expect(completeAccountDeletionMock()).not.toHaveBeenCalled();
    expect(allText(renderer)).toContain(
      'The deletion request expired. Start again from Settings.',
    );
    act(() => renderer.unmount());
  });

  it('a 401 on a FIRST confirm (no ambiguous attempt before it) still means the session expired', async () => {
    const { fetchFn } = scriptedFetch([CHALLENGE_RESPONSE, UNAUTHORIZED]);
    globalThis.fetch = fetchFn;
    const renderer = renderScreen();
    await armDeletion(renderer);
    await pressConfirm(renderer);

    expect(completeAccountDeletionMock()).not.toHaveBeenCalled();
    expect(unauthorizedListener).toHaveBeenCalledTimes(1);
    expect(allText(renderer)).toContain(SIGN_IN_AGAIN);
    expect(mockShowBrandNotice).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('a 401 on delete-request still means the session expired (nothing to tear down)', async () => {
    const { fetchFn } = scriptedFetch([UNAUTHORIZED]);
    globalThis.fetch = fetchFn;
    const renderer = renderScreen();
    await act(async () => {
      pressable(renderer, 'Delete account').props.onPress();
    });
    await act(async () => {
      pressable(renderer, 'Skip the survey').props.onPress();
    });
    await act(async () => {
      sheetButton(renderer, 'Continue to delete').props.onPress();
    });

    expect(completeAccountDeletionMock()).not.toHaveBeenCalled();
    expect(unauthorizedListener).toHaveBeenCalledTimes(1);
    expect(allText(renderer)).toContain(SIGN_IN_AGAIN);
    act(() => renderer.unmount());
  });

  it('a lost confirm that is then resolved by the retry closing the dialog resets the ambiguity for the next challenge', async () => {
    const { fetchFn } = scriptedFetch([
      CHALLENGE_RESPONSE,
      { kind: 'hang' },
      CHALLENGE_RESPONSE,
      UNAUTHORIZED,
    ]);
    globalThis.fetch = fetchFn;
    const renderer = renderScreen();
    await armDeletion(renderer);
    await pressConfirm(renderer);
    await act(async () => {
      jest.advanceTimersByTime(15_000);
    });

    // User keeps the account after the ambiguous attempt, then starts over
    // in a fresh presentation: a 401 on its very first confirm is a plain
    // expired session again.
    await act(async () => {
      sheetButton(renderer, 'Keep my account').props.onPress();
    });
    await armDeletion(renderer);
    await pressConfirm(renderer);

    expect(completeAccountDeletionMock()).not.toHaveBeenCalled();
    expect(allText(renderer)).toContain(SIGN_IN_AGAIN);
    act(() => renderer.unmount());
  });

  it('after a lost confirm ends the account, an Apple user is told how to check the Apple side', async () => {
    const { fetchFn } = scriptedFetch([
      CHALLENGE_RESPONSE,
      { kind: 'hang' },
      UNAUTHORIZED,
    ]);
    globalThis.fetch = fetchFn;
    const renderer = renderScreen();
    await armDeletion(renderer);
    await pressConfirm(renderer);
    await act(async () => {
      jest.advanceTimersByTime(15_000);
    });
    await pressConfirm(renderer);

    expect(completeAccountDeletionMock()).toHaveBeenCalledTimes(1);
    expect(mockShowBrandNotice).toHaveBeenCalledTimes(1);
    expect(notices()[0]!.detail).toMatch(/Stop Using Apple ID/);
    expect(notices()[0]!.detail).not.toMatch(/could not be removed/);
    act(() => renderer.unmount());
  });
});

describe('post-deletion notices', () => {
  function confirmed(appleAuthorizationRevocation: string) {
    return {
      kind: 'json' as const,
      body: { deleted: true, appleAuthorizationRevocation },
    };
  }

  function purgeFails() {
    useAuthStore.setState({
      completeAccountDeletion: jest.fn(async () => {
        useAuthStore.setState({
          session: null,
          deletionCleanup: { localPurge: 'failed' },
        });
      }),
    });
  }

  it('purge failed AND manual Apple step → one notice carries both facts', async () => {
    const { fetchFn } = scriptedFetch([
      CHALLENGE_RESPONSE,
      confirmed('manual_action_required'),
    ]);
    globalThis.fetch = fetchFn;
    purgeFails();
    const renderer = renderScreen();
    await armDeletion(renderer);
    await pressConfirm(renderer);

    expect(mockShowBrandNotice).toHaveBeenCalledTimes(1);
    const [notice] = notices();
    expect(notice!.detail).toMatch(/could not be removed/);
    expect(notice!.detail).toMatch(/Stop Using Apple ID/);
    expect(notice!.eyebrow).toBe('LOCAL CLEANUP NEEDED');
    act(() => renderer.unmount());
  });

  it('purge failed alone → only the local-cleanup notice', async () => {
    const { fetchFn } = scriptedFetch([
      CHALLENGE_RESPONSE,
      confirmed('revoked'),
    ]);
    globalThis.fetch = fetchFn;
    purgeFails();
    const renderer = renderScreen();
    await armDeletion(renderer);
    await pressConfirm(renderer);

    expect(mockShowBrandNotice).toHaveBeenCalledTimes(1);
    const [notice] = notices();
    expect(notice!.detail).toMatch(/could not be removed/);
    expect(notice!.detail).not.toMatch(/Apple/);
    expect(notice!.eyebrow).toBe('LOCAL CLEANUP NEEDED');
    act(() => renderer.unmount());
  });

  it('manual Apple step alone → only the Apple notice', async () => {
    const { fetchFn } = scriptedFetch([
      CHALLENGE_RESPONSE,
      confirmed('manual_action_required'),
    ]);
    globalThis.fetch = fetchFn;
    const renderer = renderScreen();
    await armDeletion(renderer);
    await pressConfirm(renderer);

    expect(mockShowBrandNotice).toHaveBeenCalledTimes(1);
    const [notice] = notices();
    expect(notice!.detail).toMatch(/Stop Using Apple ID/);
    expect(notice!.detail).not.toMatch(/could not be removed/);
    expect(notice!.eyebrow).toBe('ONE APPLE STEP');
    act(() => renderer.unmount());
  });

  it('clean purge + revoked → no notice at all', async () => {
    const { fetchFn } = scriptedFetch([
      CHALLENGE_RESPONSE,
      confirmed('revoked'),
    ]);
    globalThis.fetch = fetchFn;
    const renderer = renderScreen();
    await armDeletion(renderer);
    await pressConfirm(renderer);

    expect(completeAccountDeletionMock()).toHaveBeenCalledTimes(1);
    expect(mockShowBrandNotice).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});
