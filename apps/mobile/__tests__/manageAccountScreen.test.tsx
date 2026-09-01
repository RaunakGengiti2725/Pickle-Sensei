import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * Account deletion moved off the Settings root onto the ManageAccount
 * screen (Settings → Manage account → quiet "Delete account" link). These
 * tests pin that the relocated surface still satisfies App Review
 * 5.1.1(v): the link exists for synced sessions, never for local-only
 * ones, and the full two-step server-verified flow (request → armed
 * countdown → confirm → local purge) still runs from here.
 */

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
  return { SafeAreaView: View };
});

const mockGoBack = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack }),
}));

const mockRequestAccountDeletion = jest.fn<
  Promise<{ challenge: string; expiresAt: string }>,
  unknown[]
>();
const mockConfirmAccountDeletion = jest.fn<Promise<void>, unknown[]>();
jest.mock('../src/account/deletion', () => {
  class AccountDeletionError extends Error {}
  return {
    AccountDeletionError,
    requestAccountDeletion: (...args: unknown[]) =>
      mockRequestAccountDeletion(...args),
    confirmAccountDeletion: (...args: unknown[]) =>
      mockConfirmAccountDeletion(...args),
  };
});

import { ManageAccountScreen } from '../src/screens/ManageAccountScreen';
import { Button } from '../src/design/components';
import { useAuthStore, type AuthSession } from '../src/auth/authStore';

const syncedSession: AuthSession = {
  provider: 'google',
  subject: '11111111-1111-4111-8111-111111111111',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
};

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

describe('ManageAccountScreen', () => {
  beforeEach(() => {
    mockGoBack.mockClear();
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

  it('shows account details with deletion as a quiet link, sheet closed', () => {
    const renderer = renderScreen();
    const copy = allText(renderer);
    expect(copy).toContain('Account details');
    expect(copy).toContain('Alex Chen');
    expect(copy).toContain('alex@example.com');
    expect(copy).toContain('Google');
    // The link is present but the confirmation sheet is not mounted yet.
    expect(pressable(renderer, 'Delete account').length).toBeGreaterThan(0);
    expect(copy).not.toContain('Delete your account?');
    act(() => renderer.unmount());
  });

  it('never offers deletion to local-only sessions', () => {
    useAuthStore.setState({
      session: {
        provider: 'guest',
        subject: 'local-only',
        canonicalAppUserId: null,
        localOnly: true,
        displayName: null,
        email: null,
      },
    });
    const renderer = renderScreen();
    expect(pressable(renderer, 'Delete account')).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('runs the full two-step deletion: request, armed countdown, confirm, local purge', async () => {
    jest.useFakeTimers();
    try {
      mockRequestAccountDeletion.mockResolvedValue({
        challenge: 'challenge-1',
        expiresAt: '2026-08-31T00:00:00.000Z',
      });
      mockConfirmAccountDeletion.mockResolvedValue(undefined);

      const renderer = renderScreen();
      await act(async () => {
        pressable(renderer, 'Delete account')[0]!.props.onPress();
      });
      expect(allText(renderer)).toContain('Delete your account?');

      await act(async () => {
        sheetButton(renderer, 'Continue to delete').props.onPress();
      });
      expect(mockRequestAccountDeletion).toHaveBeenCalledTimes(1);

      // Armed: the final button stays disabled through the 5s hold-off.
      let confirm = sheetButton(renderer, 'Permanently delete');
      expect(confirm.props.label).toBe('Permanently delete (5)');
      expect(confirm.props.disabled).toBe(true);

      await act(async () => {
        jest.advanceTimersByTime(5_000);
      });
      confirm = sheetButton(renderer, 'Permanently delete');
      expect(confirm.props.label).toBe('Permanently delete');
      expect(confirm.props.disabled).toBe(false);

      await act(async () => {
        confirm.props.onPress();
      });
      expect(mockConfirmAccountDeletion).toHaveBeenCalledWith(
        null,
        'challenge-1',
      );
      // Server confirmed → the store-level purge/disconnect runs.
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).toHaveBeenCalledTimes(1);
      act(() => renderer.unmount());
    } finally {
      jest.useRealTimers();
    }
  });
});
