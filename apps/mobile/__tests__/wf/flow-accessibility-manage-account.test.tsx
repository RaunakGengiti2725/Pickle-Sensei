import React from 'react';
import { Modal, StyleSheet, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * Accessibility workflow audit — Settings → Manage account → Delete account.
 *
 * Drives the two-step deletion sheet through its cancel and failure branches
 * via the host-level accessibility activate path, checking that every
 * control is labelled, that busy states are mirrored into
 * `accessibilityState.disabled` (double-tap guard), that a failed request or
 * confirmation shows honest copy and leaves a retry path (no dead end), and
 * that nothing is deleted on any cancel branch.
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
jest.mock('../../src/account/deletion', () => {
  class AccountDeletionError extends Error {
    constructor(code: string, message: string, retryable: boolean) {
      super(message);
      Object.assign(this, { code, retryable });
    }
  }
  return {
    AccountDeletionError,
    requestAccountDeletion: (...args: unknown[]) =>
      mockRequestAccountDeletion(...args),
    confirmAccountDeletion: (...args: unknown[]) =>
      mockConfirmAccountDeletion(...args),
  };
});

import { ManageAccountScreen } from '../../src/screens/ManageAccountScreen';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import { AccountDeletionError } from '../../src/account/deletion';

const MIN_TARGET_PT = 44;

const syncedSession: AuthSession = {
  provider: 'apple',
  subject: '22222222-2222-4222-8222-222222222222',
  canonicalAppUserId: '22222222-2222-4222-8222-222222222222',
  localOnly: false,
  displayName: 'Sam Rivera',
  email: 'sam@example.com',
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

function hostPressables(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'string' && typeof node.props.onClick === 'function',
  );
}

function byLabelPrefix(
  renderer: TestRenderer.ReactTestRenderer,
  prefix: string,
) {
  const matches = hostPressables(renderer).filter(node =>
    String(node.props.accessibilityLabel ?? '').startsWith(prefix),
  );
  expect(matches.length).toBe(1);
  return matches[0]!;
}

function press(node: TestRenderer.ReactTestInstance) {
  node.props.onClick();
}

function minHeightOf(node: TestRenderer.ReactTestInstance): number {
  const flat = StyleSheet.flatten(node.props.style) ?? {};
  return Number(flat.minHeight ?? flat.height ?? 0);
}

function modalOf(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findByType(Modal);
}

async function openSheet(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    press(byLabelPrefix(renderer, 'Delete account'));
  });
  expect(modalOf(renderer).props.visible).toBe(true);
  expect(allText(renderer)).toContain('Delete your account?');
}

describe('Manage account → delete account — accessibility workflow', () => {
  beforeEach(() => {
    mockGoBack.mockClear();
    mockRequestAccountDeletion.mockReset();
    mockConfirmAccountDeletion.mockReset();
    act(() => {
      useAuthStore.setState({
        hydrated: true,
        session: syncedSession,
        busy: false,
        error: null,
        completeAccountDeletion: jest.fn(() => Promise.resolve()),
      });
    });
  });

  it('header Back and the quiet Delete account link are labelled buttons on ≥44pt targets', () => {
    const renderer = renderScreen();
    const back = byLabelPrefix(renderer, 'Back');
    expect(back.props.accessibilityRole).toBe('button');
    expect(back.props.hitSlop).toBeGreaterThanOrEqual(8);
    act(() => press(back));
    expect(mockGoBack).toHaveBeenCalledTimes(1);

    const del = byLabelPrefix(renderer, 'Delete account');
    expect(del.props.accessibilityRole).toBe('button');
    expect(del.props.accessibilityState?.disabled).toBeFalsy();
    expect(minHeightOf(del)).toBeGreaterThanOrEqual(MIN_TARGET_PT);
    expect(modalOf(renderer).props.visible).toBe(false);
    act(() => renderer.unmount());
  });

  it('cancel branches (Keep my account, backdrop, close X, hardware back) never delete', async () => {
    const renderer = renderScreen();
    const cancels = [
      'Keep my account',
      'Cancel account deletion',
      'Close account deletion confirmation',
    ];
    for (const label of cancels) {
      await openSheet(renderer);
      const node = byLabelPrefix(renderer, label);
      expect(node.props.accessibilityState?.disabled).toBeFalsy();
      act(() => press(node));
      expect(modalOf(renderer).props.visible).toBe(false);
    }
    await openSheet(renderer);
    act(() => {
      modalOf(renderer).props.onRequestClose();
    });
    expect(modalOf(renderer).props.visible).toBe(false);

    expect(mockRequestAccountDeletion).not.toHaveBeenCalled();
    expect(mockConfirmAccountDeletion).not.toHaveBeenCalled();
    expect(
      useAuthStore.getState().completeAccountDeletion,
    ).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('while the request is in flight every sheet control is disabled and a second tap is a no-op', async () => {
    let resolveRequest!: (v: { challenge: string; expiresAt: string }) => void;
    mockRequestAccountDeletion.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveRequest = resolve;
        }),
    );
    const renderer = renderScreen();
    await openSheet(renderer);

    await act(async () => {
      press(byLabelPrefix(renderer, 'Continue to delete'));
    });
    expect(mockRequestAccountDeletion).toHaveBeenCalledTimes(1);
    expect(allText(renderer)).toContain('Requesting…');

    const requesting = byLabelPrefix(renderer, 'Requesting…');
    expect(requesting.props.accessibilityState?.disabled).toBe(true);
    const keep = byLabelPrefix(renderer, 'Keep my account');
    expect(keep.props.accessibilityState?.disabled).toBe(true);
    // Backdrop cancel is withdrawn while busy; hardware back too.
    const backdrop = byLabelPrefix(renderer, 'Cancel account deletion');
    expect(modalOf(renderer).props.onRequestClose).toBeUndefined();

    act(() => {
      press(requesting);
      press(keep);
      press(backdrop);
    });
    expect(mockRequestAccountDeletion).toHaveBeenCalledTimes(1);
    expect(modalOf(renderer).props.visible).toBe(true);

    await act(async () => {
      resolveRequest({
        challenge: 'c-1',
        expiresAt: '2026-09-02T00:00:00.000Z',
      });
    });
    expect(allText(renderer)).toContain('Permanently delete (5)');
    act(() => renderer.unmount());
  });

  it('request failure: honest copy, nothing deleted, Continue re-enabled for retry', async () => {
    mockRequestAccountDeletion
      .mockRejectedValueOnce(new Error('network down'))
      .mockRejectedValueOnce(
        new AccountDeletionError(
          'deletion.session_expired',
          'Sign in again to delete your account.',
          false,
        ),
      );
    const renderer = renderScreen();
    await openSheet(renderer);

    await act(async () => {
      press(byLabelPrefix(renderer, 'Continue to delete'));
    });
    expect(allText(renderer)).toContain(
      'The deletion request could not be completed. Nothing was deleted.',
    );
    let retry = byLabelPrefix(renderer, 'Continue to delete');
    expect(retry.props.accessibilityState?.disabled).toBeFalsy();

    // Server-provided reason is surfaced verbatim.
    await act(async () => {
      press(retry);
    });
    expect(allText(renderer)).toContain(
      'Sign in again to delete your account.',
    );
    retry = byLabelPrefix(renderer, 'Continue to delete');
    expect(retry.props.accessibilityState?.disabled).toBeFalsy();
    expect(mockRequestAccountDeletion).toHaveBeenCalledTimes(2);
    expect(mockConfirmAccountDeletion).not.toHaveBeenCalled();
    expect(
      useAuthStore.getState().completeAccountDeletion,
    ).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('confirm failure: stays armed with honest copy, retry allowed, nothing purged', async () => {
    jest.useFakeTimers();
    try {
      mockRequestAccountDeletion.mockResolvedValue({
        challenge: 'c-2',
        expiresAt: '2026-09-02T00:00:00.000Z',
      });
      mockConfirmAccountDeletion
        .mockRejectedValueOnce(new Error('503'))
        .mockResolvedValueOnce(undefined);
      const renderer = renderScreen();
      await openSheet(renderer);

      await act(async () => {
        press(byLabelPrefix(renderer, 'Continue to delete'));
      });
      // Armed: the final button is disabled through the hold-off and stays
      // inert if activated early.
      let confirm = byLabelPrefix(renderer, 'Permanently delete (5)');
      expect(confirm.props.accessibilityState?.disabled).toBe(true);
      act(() => press(confirm));
      expect(mockConfirmAccountDeletion).not.toHaveBeenCalled();

      await act(async () => {
        jest.advanceTimersByTime(5_000);
      });
      confirm = byLabelPrefix(renderer, 'Permanently delete');
      expect(confirm.props.accessibilityLabel).toBe('Permanently delete');
      expect(confirm.props.accessibilityState?.disabled).toBe(false);

      await act(async () => {
        press(confirm);
      });
      expect(mockConfirmAccountDeletion).toHaveBeenCalledWith(null, 'c-2');
      expect(allText(renderer)).toContain(
        'The deletion could not be completed. Nothing was deleted.',
      );
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).not.toHaveBeenCalled();

      // Retry path: the armed button is immediately usable again.
      confirm = byLabelPrefix(renderer, 'Permanently delete');
      expect(confirm.props.accessibilityState?.disabled).toBe(false);
      await act(async () => {
        press(confirm);
      });
      expect(mockConfirmAccountDeletion).toHaveBeenCalledTimes(2);
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).toHaveBeenCalledTimes(1);
      act(() => renderer.unmount());
    } finally {
      jest.useRealTimers();
    }
  });

  it('reopening after a cancel resets the sheet to the review step', async () => {
    mockRequestAccountDeletion.mockRejectedValue(new Error('boom'));
    const renderer = renderScreen();
    await openSheet(renderer);
    await act(async () => {
      press(byLabelPrefix(renderer, 'Continue to delete'));
    });
    expect(allText(renderer)).toContain('Nothing was deleted.');
    act(() => press(byLabelPrefix(renderer, 'Keep my account')));
    await openSheet(renderer);
    expect(allText(renderer)).not.toContain('Nothing was deleted.');
    expect(
      byLabelPrefix(renderer, 'Continue to delete').props.accessibilityState
        ?.disabled,
    ).toBeFalsy();
    act(() => renderer.unmount());
  });
});
