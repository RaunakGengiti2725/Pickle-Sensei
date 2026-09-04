/**
 * ManageAccountScreen — the end of the deletion flow when the server's
 * answer is lost or the local cleanup is incomplete.
 *
 * The server commits the delete BEFORE it answers delete-confirm, so a
 * client-side timeout is ambiguous: the account may already be gone, in
 * which case the same bearer answers 401 to everything from now on. The
 * deletion client resolves that 401 on the SAME challenge as "already
 * deleted", and the screen must then finish exactly like a confirmed
 * deletion (completeAccountDeletion: owner purge + Keychain clear) instead
 * of asking the user to sign in to an account that no longer exists.
 *
 * After the session is gone nothing can be re-shown, so every post-deletion
 * fact the user must act on (local cleanup, the manual Sign in with Apple
 * step) is surfaced in the one notice — never one at the expense of the
 * other.
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
  showBrandNotice: (notice: unknown) => mockShowBrandNotice(notice),
}));

import { ManageAccountScreen } from '../src/screens/ManageAccountScreen';
import { Button } from '../src/design/components';
import {
  useAuthStore,
  type AuthSession,
  type AccountDeletionCleanup,
} from '../src/auth/authStore';
import {
  clearApiSession,
  establishApiSession,
  setApiUnauthorizedListener,
  type ApiSession,
} from '../src/account/apiSession';

const canonicalAppUserId = '11111111-1111-4111-8111-111111111111';

function authSession(provider: 'apple' | 'google'): AuthSession {
  return {
    provider,
    subject: canonicalAppUserId,
    canonicalAppUserId,
    localOnly: false,
    displayName: 'Alex Chen',
    email: 'alex@example.com',
  };
}

function apiSession(provider: 'apple' | 'google'): ApiSession {
  return {
    apiBaseUrl: 'https://api.test',
    bearerToken: 'access-token-1',
    canonicalAppUserId,
    provider,
  };
}

interface Scripted {
  /** 'hang' never resolves and rejects with AbortError once the signal fires. */
  kind: 'hang' | 'json' | 'network';
  status?: number;
  body?: unknown;
}

function scriptedFetch(script: Scripted[]) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchFn: typeof globalThis.fetch = (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const step = script.shift();
    if (!step) throw new Error(`unexpected fetch ${url}`);
    if (step.kind === 'hang') {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('Aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    }
    if (step.kind === 'network') {
      return Promise.reject(new TypeError('Network request failed'));
    }
    return Promise.resolve({
      ok: (step.status ?? 200) < 400,
      status: step.status ?? 200,
      json: () => Promise.resolve(step.body),
    } as unknown as Response);
  };
  return { calls, fetchFn };
}

const requestOk: Scripted = {
  kind: 'json',
  body: { challenge: 'challenge-1', expiresAt: '2026-09-05T00:00:00.000Z' },
};
const unauthorized: Scripted = {
  kind: 'json',
  status: 401,
  body: {
    error: { message: 'The session is no longer valid. Sign in again.' },
  },
};

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

function render() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<ManageAccountScreen />);
  });
  return renderer;
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

async function press(button: TestRenderer.ReactTestInstance) {
  await act(async () => {
    button.props.onPress();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

const realFetch = globalThis.fetch;
const unauthorizedListener = jest.fn();

function signIn(
  provider: 'apple' | 'google',
  completeAccountDeletion: () => Promise<void> = () => Promise.resolve(),
) {
  establishApiSession(apiSession(provider));
  useAuthStore.setState({
    hydrated: true,
    session: authSession(provider),
    busy: false,
    error: null,
    deletionCleanup: null,
    completeAccountDeletion: jest.fn(completeAccountDeletion),
  });
}

function completeWith(cleanup: AccountDeletionCleanup) {
  return async () => {
    useAuthStore.setState({ session: null, deletionCleanup: cleanup });
  };
}

function completeCalls(): number {
  return (useAuthStore.getState().completeAccountDeletion as jest.Mock).mock
    .calls.length;
}

function notices(): Array<{ eyebrow?: string; detail: string; tone?: string }> {
  return mockShowBrandNotice.mock.calls.map(
    c => c[0] as { eyebrow?: string; detail: string; tone?: string },
  );
}

beforeEach(() => {
  jest.useFakeTimers();
  mockShowBrandNotice.mockReset();
  unauthorizedListener.mockReset();
  setApiUnauthorizedListener(unauthorizedListener);
});

afterEach(() => {
  jest.useRealTimers();
  globalThis.fetch = realFetch;
  setApiUnauthorizedListener(null);
  clearApiSession();
});

describe('delete-confirm whose answer never arrived', () => {
  it('times out with retryable copy that does not promise "Nothing was deleted", keeping the same challenge armed', async () => {
    const { calls, fetchFn } = scriptedFetch([requestOk, { kind: 'hang' }]);
    globalThis.fetch = fetchFn;
    signIn('apple');
    const renderer = render();
    const confirm = await armDeletion(renderer);

    await press(confirm);
    await act(async () => {
      jest.advanceTimersByTime(15_000);
    });
    expect(calls.map(c => c.url)).toEqual([
      'https://api.test/v1/me/delete-request',
      'https://api.test/v1/me/delete-confirm',
    ]);
    const copy = allText(renderer);
    expect(copy).not.toContain('Nothing was deleted');
    expect(copy).toMatch(/could not confirm/i);
    // Still armed on the SAME challenge so the retry reuses it.
    const retry = sheetButton(renderer, 'Permanently delete');
    expect(retry.props.disabled).toBe(false);
    expect(sheetButtons(renderer, 'Continue to delete')).toHaveLength(0);
    expect(completeCalls()).toBe(0);
    act(() => renderer.unmount());
  });

  it('Apple: retry answered 401 → the deleted account is torn down locally and the Apple step is given as unconfirmed', async () => {
    const { calls, fetchFn } = scriptedFetch([
      requestOk,
      { kind: 'hang' },
      unauthorized,
    ]);
    globalThis.fetch = fetchFn;
    signIn('apple', completeWith({ localPurge: 'complete' }));
    const renderer = render();
    const confirm = await armDeletion(renderer);
    await press(confirm);
    await act(async () => {
      jest.advanceTimersByTime(15_000);
    });

    await press(sheetButton(renderer, 'Permanently delete'));
    expect(calls).toHaveLength(3);
    expect(calls[2]).toEqual({
      url: 'https://api.test/v1/me/delete-confirm',
      body: { challenge: 'challenge-1' },
    });

    expect(completeCalls()).toBe(1);
    const copy = allText(renderer);
    expect(copy).not.toContain('Sign in again, then delete your account');
    expect(copy).not.toContain('Your sign-in has expired');
    // The deletion path owns the teardown; the generic expired-session
    // handler (token refresh → sign-out) is not raced against it.
    expect(unauthorizedListener).not.toHaveBeenCalled();

    // Apple's revocation outcome was in the lost reply, so the manual step
    // is offered as a check rather than asserted or dropped.
    expect(notices()).toHaveLength(1);
    expect(notices()[0]!.detail).toMatch(/Stop Using Apple ID/);
    expect(notices()[0]!.detail).toMatch(/still (listed|appears)/i);
    act(() => renderer.unmount());
  });

  it('Google: retry answered 401 → torn down locally with no Apple notice', async () => {
    const { fetchFn } = scriptedFetch([
      requestOk,
      { kind: 'network' },
      unauthorized,
    ]);
    globalThis.fetch = fetchFn;
    signIn('google', completeWith({ localPurge: 'complete' }));
    const renderer = render();
    const confirm = await armDeletion(renderer);
    await press(confirm);
    expect(allText(renderer)).not.toContain('Nothing was deleted');

    await press(sheetButton(renderer, 'Permanently delete'));
    expect(completeCalls()).toBe(1);
    expect(allText(renderer)).not.toContain('Sign in again, then delete');
    expect(mockShowBrandNotice).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('a 401 with NO unanswered confirm keeps the expired-session copy, tells the auth store, and deletes nothing', async () => {
    const { fetchFn } = scriptedFetch([requestOk, unauthorized]);
    globalThis.fetch = fetchFn;
    signIn('apple');
    const renderer = render();
    const confirm = await armDeletion(renderer);
    await press(confirm);

    expect(allText(renderer)).toContain(
      'Your sign-in has expired. Sign in again, then delete your account.',
    );
    expect(completeCalls()).toBe(0);
    expect(unauthorizedListener).toHaveBeenCalledTimes(1);
    expect(mockShowBrandNotice).not.toHaveBeenCalled();
    // Non-retryable: back on review, a fresh challenge is needed.
    expect(sheetButtons(renderer, 'Continue to delete')).toHaveLength(1);
    act(() => renderer.unmount());
  });
});

describe('post-deletion notice', () => {
  async function deleteWith(
    provider: 'apple' | 'google',
    appleAuthorizationRevocation: string,
    cleanup: AccountDeletionCleanup,
  ) {
    const { fetchFn } = scriptedFetch([
      requestOk,
      { kind: 'json', body: { deleted: true, appleAuthorizationRevocation } },
    ]);
    globalThis.fetch = fetchFn;
    signIn(provider, completeWith(cleanup));
    const renderer = render();
    const confirm = await armDeletion(renderer);
    await press(confirm);
    expect(completeCalls()).toBe(1);
    act(() => renderer.unmount());
  }

  it('local purge failed AND manual Apple step → ONE notice carrying both facts', async () => {
    await deleteWith('apple', 'manual_action_required', {
      localPurge: 'failed',
    });
    expect(notices()).toHaveLength(1);
    const [notice] = notices();
    expect(notice!.detail).toMatch(/could not be removed/);
    expect(notice!.detail).toMatch(/Stop Using Apple ID/);
    expect(notice!.tone).toBe('danger');
  });

  it('local purge failed alone → the local cleanup warning only', async () => {
    await deleteWith('apple', 'revoked', { localPurge: 'failed' });
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({
      eyebrow: 'LOCAL CLEANUP NEEDED',
      tone: 'danger',
      detail: expect.stringContaining('could not be removed'),
    });
    expect(notices()[0]!.detail).not.toMatch(/Apple/);
  });

  it('manual Apple step alone → the Apple instruction only', async () => {
    await deleteWith('apple', 'manual_action_required', {
      localPurge: 'complete',
    });
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({
      eyebrow: 'ONE APPLE STEP',
      tone: 'neutral',
      detail: expect.stringContaining('Stop Using Apple ID'),
    });
    expect(notices()[0]!.detail).not.toMatch(/could not be removed/);
  });

  it('clean deletion → no notice', async () => {
    await deleteWith('google', 'not_applicable', { localPurge: 'complete' });
    expect(mockShowBrandNotice).not.toHaveBeenCalled();
  });
});
