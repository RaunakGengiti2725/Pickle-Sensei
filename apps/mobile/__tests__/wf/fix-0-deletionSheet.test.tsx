/**
 * Deletion dialog guards (confirmation page, reached past the skippable exit
 * survey): the close/backdrop/back controls cannot dismiss the dialog while a
 * request is in flight (a silent tap during a server round-trip would leave
 * the user unsure whether anything happened), a non-retryable confirm
 * failure returns to review instead of leaving a dead "Permanently delete"
 * button, and a failed on-device purge after a confirmed server deletion is
 * told to the user.
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
  showBrandNotice: (notice: unknown) => mockShowBrandNotice(notice),
}));

const mockRequestAccountDeletion = jest.fn<
  Promise<{ challenge: string; expiresAt: string }>,
  unknown[]
>();
const mockConfirmAccountDeletion = jest.fn<Promise<void>, unknown[]>();
jest.mock('../../src/account/deletion', () => {
  // Only the network calls are stubbed; the survey vocabulary/caps the
  // dialog renders from (and AccountDeletionError) are the real ones.
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

import { AccountDeletionError } from '../../src/account/deletion';
import { ManageAccountScreen } from '../../src/screens/ManageAccountScreen';
import { Button } from '../../src/design/components';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';

const syncedSession: AuthSession = {
  provider: 'apple',
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

function labeled(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const matches = renderer.root.findAll(
    node => node.props.accessibilityLabel === label && 'onPress' in node.props,
  );
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!;
}

function sheetButton(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const matches = renderer.root
    .findAllByType(Button)
    .filter(node => String(node.props.label).startsWith(label));
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The link opens the exit survey first; skipping it lands on the
 * confirmation whose guards this suite pins. */
async function openSheet(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    labeled(renderer, 'Delete account').props.onPress();
  });
  expect(allText(renderer)).toContain("What's making you leave?");
  await act(async () => {
    labeled(renderer, 'Skip the survey').props.onPress();
  });
  expect(allText(renderer)).toContain('Delete your account?');
}

describe('ManageAccountScreen deletion sheet guards', () => {
  beforeEach(() => {
    mockRequestAccountDeletion.mockReset();
    mockConfirmAccountDeletion.mockReset();
    mockShowBrandNotice.mockClear();
    act(() => {
      useAuthStore.setState({
        hydrated: true,
        session: syncedSession,
        busy: false,
        error: null,
        deletionCleanup: null,
        completeAccountDeletion: jest.fn(() => Promise.resolve()),
      });
    });
  });

  it('disables the close control and backdrop while the request is in flight', async () => {
    const pending = deferred<{ challenge: string; expiresAt: string }>();
    mockRequestAccountDeletion.mockReturnValue(pending.promise);
    const renderer = renderScreen();
    await openSheet(renderer);

    expect(
      labeled(renderer, 'Close account deletion confirmation').props.disabled,
    ).toBeFalsy();

    await act(async () => {
      sheetButton(renderer, 'Continue to delete').props.onPress();
    });
    expect(
      labeled(renderer, 'Close account deletion confirmation').props.disabled,
    ).toBe(true);
    expect(labeled(renderer, 'Cancel account deletion').props.disabled).toBe(
      true,
    );

    await act(async () => {
      pending.resolve({
        challenge: 'challenge-1',
        expiresAt: '2026-08-31T00:00:00.000Z',
      });
    });
    expect(
      labeled(renderer, 'Close account deletion confirmation').props.disabled,
    ).toBeFalsy();
    act(() => renderer.unmount());
  });

  it('the hardware back request is ignored while busy and honored again afterwards', async () => {
    const pending = deferred<{ challenge: string; expiresAt: string }>();
    mockRequestAccountDeletion.mockReturnValue(pending.promise);
    const renderer = renderScreen();
    await openSheet(renderer);
    const modal = () =>
      renderer.root.findAll(node => 'onRequestClose' in node.props)[0]!;
    expect(typeof modal().props.onRequestClose).toBe('function');

    await act(async () => {
      sheetButton(renderer, 'Continue to delete').props.onPress();
    });
    expect(modal().props.onRequestClose).toBeUndefined();

    await act(async () => {
      pending.reject(new Error('network down'));
    });
    expect(typeof modal().props.onRequestClose).toBe('function');
    expect(allText(renderer)).toContain('could not be completed');
    expect(allText(renderer)).toContain('Nothing was deleted');

    await act(async () => {
      modal().props.onRequestClose();
    });
    expect(allText(renderer)).not.toContain('Delete your account?');
    await openSheet(renderer);
    expect(allText(renderer)).not.toContain('could not be completed');
    act(() => renderer.unmount());
  });

  it('a non-retryable confirm failure returns to review instead of a dead challenge', async () => {
    jest.useFakeTimers();
    try {
      mockRequestAccountDeletion.mockResolvedValue({
        challenge: 'challenge-1',
        expiresAt: '2026-08-31T00:00:00.000Z',
      });
      mockConfirmAccountDeletion.mockRejectedValue(
        new AccountDeletionError(
          'deletion.rejected',
          'That confirmation expired.',
          false,
        ),
      );
      const renderer = renderScreen();
      await openSheet(renderer);
      await act(async () => {
        sheetButton(renderer, 'Continue to delete').props.onPress();
      });
      await act(async () => {
        jest.advanceTimersByTime(5_000);
      });
      await act(async () => {
        sheetButton(renderer, 'Permanently delete').props.onPress();
      });
      const copy = allText(renderer);
      expect(copy).toContain('That confirmation expired.');
      expect(copy).not.toContain('Permanently delete');
      expect(
        sheetButton(renderer, 'Continue to delete').props.disabled,
      ).toBeFalsy();
      act(() => renderer.unmount());
    } finally {
      jest.useRealTimers();
    }
  });

  it('a retryable confirm failure keeps the armed challenge ready to retry', async () => {
    jest.useFakeTimers();
    try {
      mockRequestAccountDeletion.mockResolvedValue({
        challenge: 'challenge-1',
        expiresAt: '2026-08-31T00:00:00.000Z',
      });
      mockConfirmAccountDeletion.mockRejectedValue(
        new AccountDeletionError(
          'deletion.unavailable',
          'Try again in a moment.',
          true,
        ),
      );
      const renderer = renderScreen();
      await openSheet(renderer);
      await act(async () => {
        sheetButton(renderer, 'Continue to delete').props.onPress();
      });
      await act(async () => {
        jest.advanceTimersByTime(5_000);
      });
      await act(async () => {
        sheetButton(renderer, 'Permanently delete').props.onPress();
      });
      expect(allText(renderer)).toContain('Try again in a moment.');
      const confirm = sheetButton(renderer, 'Permanently delete');
      expect(confirm.props.disabled).toBe(false);
      act(() => renderer.unmount());
    } finally {
      jest.useRealTimers();
    }
  });

  it('tells the user when the server deleted the account but the local purge failed', async () => {
    jest.useFakeTimers();
    try {
      mockRequestAccountDeletion.mockResolvedValue({
        challenge: 'challenge-1',
        expiresAt: '2026-08-31T00:00:00.000Z',
      });
      mockConfirmAccountDeletion.mockResolvedValue(undefined);
      useAuthStore.setState({
        completeAccountDeletion: jest.fn(async () => {
          useAuthStore.setState({
            session: null,
            deletionCleanup: { localPurge: 'failed' },
          });
        }),
      });
      const renderer = renderScreen();
      await openSheet(renderer);
      await act(async () => {
        sheetButton(renderer, 'Continue to delete').props.onPress();
      });
      await act(async () => {
        jest.advanceTimersByTime(5_000);
      });
      await act(async () => {
        sheetButton(renderer, 'Permanently delete').props.onPress();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockShowBrandNotice).toHaveBeenCalledTimes(1);
      expect(mockShowBrandNotice).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: expect.stringContaining('could not be removed'),
        }),
      );
      act(() => renderer.unmount());
    } finally {
      jest.useRealTimers();
    }
  });
});
