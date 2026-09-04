import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * AUDIT PROBE (structural #2, mobile-settings-account).
 *
 * Scenario: the delete-confirm request reaches the server and the account is
 * deleted, but the response is lost (15s client abort → retryable
 * `deletion.unavailable`). The dialog keeps the same challenge armed. The
 * user retries; the server no longer knows the bearer (auth cache dropped,
 * user gone) → 401 → `deletion.session_expired` (non-retryable).
 *
 * Expected: the client must not leave a deleted account's session, Keychain
 * record and owner-scoped rows on the device — `completeAccountDeletion`
 * (or equivalent teardown) must run once a confirm attempt has been sent
 * and the server subsequently rejects the bearer.
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

const mockRequestAccountDeletion = jest.fn<
  Promise<{ challenge: string; expiresAt: string }>,
  unknown[]
>();
const mockConfirmAccountDeletion = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../../src/account/deletion', () => {
  const actual = jest.requireActual<
    typeof import('../../src/account/deletion')
  >('../../src/account/deletion');
  return {
    ...actual,
    requestAccountDeletion: (...args: unknown[]) =>
      mockRequestAccountDeletion(...args),
    confirmAccountDeletion: (...args: unknown[]) =>
      mockConfirmAccountDeletion(...args),
  };
});

import { ManageAccountScreen } from '../../src/screens/ManageAccountScreen';
import { Button } from '../../src/design/components';
import { AccountDeletionError } from '../../src/account/deletion';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import { Text } from 'react-native';

const syncedSession: AuthSession = {
  provider: 'apple',
  subject: '11111111-1111-4111-8111-111111111111',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
};

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

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

describe('AUDIT: delete-confirm response lost, retry answered 401', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockRequestAccountDeletion.mockReset();
    mockConfirmAccountDeletion.mockReset();
    useAuthStore.setState({
      hydrated: true,
      session: syncedSession,
      busy: false,
      error: null,
      completeAccountDeletion: jest.fn(() => Promise.resolve()),
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('tears down the local session after an ambiguous confirm is followed by a 401', async () => {
    mockRequestAccountDeletion.mockResolvedValue({
      challenge: 'challenge-1',
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
    // Attempt 1: the request went out, the server deleted the account, the
    // response never came back (deadline abort → retryable).
    mockConfirmAccountDeletion.mockRejectedValueOnce(
      new AccountDeletionError(
        'deletion.unavailable',
        'Account deletion is temporarily offline. Nothing was deleted — please try again.',
        true,
      ),
    );
    // Attempt 2: the bearer is dead because the account is gone.
    mockConfirmAccountDeletion.mockRejectedValueOnce(
      new AccountDeletionError(
        'deletion.session_expired',
        'Your sign-in has expired. Sign in again, then delete your account.',
        false,
      ),
    );

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
    expect(mockConfirmAccountDeletion).toHaveBeenCalledTimes(1);
    // Retryable → same challenge stays armed, no hold-off.
    confirm = sheetButton(renderer, 'Permanently delete');
    expect(confirm.props.disabled).toBe(false);

    await act(async () => {
      confirm.props.onPress();
    });
    expect(mockConfirmAccountDeletion).toHaveBeenCalledTimes(2);
    expect(mockConfirmAccountDeletion).toHaveBeenLastCalledWith(
      null,
      'challenge-1',
    );

    const copy = allText(renderer);
    const cleanupRuns = (
      useAuthStore.getState().completeAccountDeletion as jest.Mock
    ).mock.calls.length;

    // Evidence for the report (printed regardless of verdict).
    console.log(
      JSON.stringify({
        probe: 'deletion-lost-confirm-response',
        completeAccountDeletionCalls: cleanupRuns,
        copyMentionsSignInAgain: copy.includes('Sign in again'),
        copyShown: copy.match(/Your sign-in has expired[^.]*\.[^.]*\./)?.[0],
      }),
    );

    expect(cleanupRuns).toBe(1);
    act(() => renderer.unmount());
  });
});
