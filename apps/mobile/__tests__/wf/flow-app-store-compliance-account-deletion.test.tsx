/**
 * App Store compliance sweep — in-app account deletion (App Review 5.1.1(v)).
 *
 * Drives Settings → Manage account → "Delete account" as a user would and
 * pins the branches the happy-path suite does not: the exit survey never
 * stands between the user and deletion (skippable on both questions, no
 * server call of its own), every cancel affordance (Keep my account,
 * backdrop, close X, hardware back), request-phase and confirm-phase
 * failures with honest "nothing was deleted" copy, the double-tap guard
 * while a request is in flight, and that no phase leaves the sheet spinning
 * forever.
 */
import React from 'react';
import { Modal, Text, TextInput } from 'react-native';
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
  subject: '22222222-2222-4222-8222-222222222222',
  canonicalAppUserId: '22222222-2222-4222-8222-222222222222',
  localOnly: false,
  displayName: 'Jordan Lee',
  email: 'jordan@example.com',
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

function pressables(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
}

async function press(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const [node] = pressables(renderer, label);
  if (!node) throw new Error(`No pressable labeled ${label}`);
  await act(async () => {
    node.props.onPress();
  });
}

function sheetButton(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const matches = renderer.root
    .findAllByType(Button)
    .filter(node => String(node.props.label).startsWith(label));
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!;
}

function sheetVisible(renderer: TestRenderer.ReactTestRenderer): boolean {
  return renderer.root.findByType(Modal).props.visible === true;
}

/** Tap the link: the dialog opens on exit-survey question 1. */
async function openSurvey(renderer: TestRenderer.ReactTestRenderer) {
  await press(renderer, 'Delete account');
  expect(sheetVisible(renderer)).toBe(true);
  expect(allText(renderer)).toContain("What's making you leave?");
  expect(allText(renderer)).not.toContain('Delete your account?');
}

/** Open the dialog and skip the survey straight to the confirmation page. */
async function openSheet(renderer: TestRenderer.ReactTestRenderer) {
  await openSurvey(renderer);
  await press(renderer, 'Skip the survey');
  expect(allText(renderer)).toContain('Delete your account?');
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

describe('Manage account → Delete account (App Review 5.1.1(v))', () => {
  beforeEach(() => {
    jest.useFakeTimers();
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

  afterEach(() => {
    jest.useRealTimers();
  });

  it('is reachable from Settings → Manage account with a back affordance and a labeled button-role link', async () => {
    const renderer = renderScreen();
    expect(allText(renderer)).toContain('Manage account');
    await press(renderer, 'Back');
    expect(mockGoBack).toHaveBeenCalledTimes(1);

    const [link] = pressables(renderer, 'Delete account');
    expect(link).toBeDefined();
    expect(link!.props.accessibilityRole).toBe('button');
    // Nothing destructive happens on the first tap: only the exit survey
    // opens, and it is not even the confirmation yet.
    await press(renderer, 'Delete account');
    expect(mockRequestAccountDeletion).not.toHaveBeenCalled();
    expect(sheetVisible(renderer)).toBe(true);
    expect(allText(renderer)).toContain("What's making you leave?");
    expect(allText(renderer)).not.toContain('Delete your account?');
    act(() => renderer.unmount());
  });

  it('spells out the destructive scope before any server call', async () => {
    const renderer = renderScreen();
    await openSheet(renderer);
    const copy = allText(renderer);
    expect(copy).toContain('permanently deletes your account and all synced');
    expect(copy).toContain('This cannot be undone.');
    // The free-rating ledger (migration 20260902150000) follows the sign-in
    // identity across deletion; the confirmation must say so before the
    // player deletes expecting a fresh allowance.
    expect(copy).toContain(
      "Free ratings you've already used stay used — a new account with the same Apple or Google sign-in won't get them again.",
    );
    expect(copy).toContain('does not cancel a subscription or issue a refund');
    const [manageSubscription] = pressables(
      renderer,
      'Manage subscription in the App Store',
    );
    expect(manageSubscription).toBeDefined();
    expect(manageSubscription!.props.accessibilityRole).toBe('link');
    expect(sheetButton(renderer, 'Keep my account').props.disabled).toBeFalsy();
    expect(
      sheetButton(renderer, 'Continue to delete').props.disabled,
    ).toBeFalsy();
    expect(mockRequestAccountDeletion).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  describe('exit survey never obstructs deletion', () => {
    it('question 1 can be skipped outright: the confirmation opens and step 1 sends no survey', async () => {
      mockRequestAccountDeletion.mockResolvedValue({
        challenge: 'challenge-skip',
        expiresAt: '2026-09-01T00:00:00.000Z',
      });
      const renderer = renderScreen();
      await openSurvey(renderer);
      // Next is gated on an answer; Skip and the close X never are.
      expect(sheetButton(renderer, 'Next').props.disabled).toBe(true);
      expect(pressables(renderer, 'Skip the survey').length).toBeGreaterThan(0);
      expect(
        pressables(renderer, 'Close and keep my account').length,
      ).toBeGreaterThan(0);
      await press(renderer, 'Skip the survey');
      expect(allText(renderer)).toContain('Delete your account?');
      expect(mockRequestAccountDeletion).not.toHaveBeenCalled();

      await act(async () => {
        sheetButton(renderer, 'Continue to delete').props.onPress();
      });
      expect(mockRequestAccountDeletion).toHaveBeenCalledWith(null, null);
      act(() => renderer.unmount());
    });

    it('question 2 can be skipped too: step 1 then carries only the first answer', async () => {
      mockRequestAccountDeletion.mockResolvedValue({
        challenge: 'challenge-q1',
        expiresAt: '2026-09-01T00:00:00.000Z',
      });
      const renderer = renderScreen();
      await openSurvey(renderer);
      await press(renderer, 'Privacy or data concerns');
      await act(async () => {
        sheetButton(renderer, 'Next').props.onPress();
      });
      expect(allText(renderer)).toContain('What would have kept you?');
      expect(sheetButton(renderer, 'Continue').props.disabled).toBe(true);
      expect(pressables(renderer, 'Skip this question').length).toBeGreaterThan(
        0,
      );
      await press(renderer, 'Skip this question');
      expect(allText(renderer)).toContain('Delete your account?');

      await act(async () => {
        sheetButton(renderer, 'Continue to delete').props.onPress();
      });
      expect(mockRequestAccountDeletion).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          reason: 'privacy',
          wanted: null,
          details: null,
        }),
      );
      act(() => renderer.unmount());
    });

    it('answers ride along with step 1 (never a call of their own) and the comment is optional', async () => {
      mockRequestAccountDeletion.mockResolvedValue({
        challenge: 'challenge-survey',
        expiresAt: '2026-09-01T00:00:00.000Z',
      });
      const renderer = renderScreen();
      await openSurvey(renderer);
      await press(renderer, "It's too expensive");
      await act(async () => {
        sheetButton(renderer, 'Next').props.onPress();
      });
      await press(renderer, 'A lower price or a free tier');
      const input = renderer.root.findByType(TextInput);
      expect(input.props.accessibilityHint).toBe('Optional');
      await act(async () => {
        input.props.onChangeText('  $60 a year is steep for a rec player.  ');
      });
      await act(async () => {
        sheetButton(renderer, 'Continue').props.onPress();
      });
      expect(allText(renderer)).toContain('Delete your account?');
      expect(mockRequestAccountDeletion).not.toHaveBeenCalled();

      await act(async () => {
        sheetButton(renderer, 'Continue to delete').props.onPress();
      });
      expect(mockRequestAccountDeletion).toHaveBeenCalledWith(null, {
        reason: 'too_expensive',
        wanted: 'price',
        details: '$60 a year is steep for a rec player.',
        platform: 'ios',
        appVersion: '1.0',
      });
      act(() => renderer.unmount());
    });

    it('closing the survey from either question keeps the account and forgets the answers', async () => {
      const renderer = renderScreen();
      await openSurvey(renderer);
      await press(renderer, "I don't use it enough");
      await press(renderer, 'Close and keep my account');
      expect(sheetVisible(renderer)).toBe(false);

      await openSurvey(renderer);
      expect(sheetButton(renderer, 'Next').props.disabled).toBe(true);
      await press(renderer, "I don't use it enough");
      await act(async () => {
        sheetButton(renderer, 'Next').props.onPress();
      });
      await press(renderer, 'Close and keep my account');
      expect(sheetVisible(renderer)).toBe(false);

      await openSurvey(renderer);
      await press(renderer, 'Cancel account deletion');
      expect(sheetVisible(renderer)).toBe(false);
      expect(mockRequestAccountDeletion).not.toHaveBeenCalled();
      expect(mockConfirmAccountDeletion).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    });
  });

  describe('cancel branches', () => {
    it('"Keep my account" closes the sheet without any server call', async () => {
      const renderer = renderScreen();
      await openSheet(renderer);
      await act(async () => {
        sheetButton(renderer, 'Keep my account').props.onPress();
      });
      expect(sheetVisible(renderer)).toBe(false);
      expect(mockRequestAccountDeletion).not.toHaveBeenCalled();
      expect(mockConfirmAccountDeletion).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    });

    it('the backdrop and the close X both cancel from the review step', async () => {
      const renderer = renderScreen();
      await openSheet(renderer);
      await press(renderer, 'Cancel account deletion');
      expect(sheetVisible(renderer)).toBe(false);

      await openSheet(renderer);
      await press(renderer, 'Close account deletion confirmation');
      expect(sheetVisible(renderer)).toBe(false);
      expect(mockRequestAccountDeletion).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    });

    it('hardware back (onRequestClose) cancels from the review step', async () => {
      const renderer = renderScreen();
      await openSheet(renderer);
      const modal = renderer.root.findByType(Modal);
      expect(typeof modal.props.onRequestClose).toBe('function');
      await act(async () => {
        modal.props.onRequestClose();
      });
      expect(sheetVisible(renderer)).toBe(false);
      act(() => renderer.unmount());
    });

    it('cancelling after a minted challenge resets the sheet so reopening starts at review', async () => {
      mockRequestAccountDeletion.mockResolvedValue({
        challenge: 'challenge-cancel',
        expiresAt: '2026-09-01T00:00:00.000Z',
      });
      const renderer = renderScreen();
      await openSheet(renderer);
      await act(async () => {
        sheetButton(renderer, 'Continue to delete').props.onPress();
      });
      expect(sheetButton(renderer, 'Permanently delete').props.label).toBe(
        'Permanently delete (5)',
      );
      await act(async () => {
        sheetButton(renderer, 'Keep my account').props.onPress();
      });
      expect(sheetVisible(renderer)).toBe(false);
      expect(mockConfirmAccountDeletion).not.toHaveBeenCalled();

      // Reopen: back at the review step, countdown gone, no stale challenge.
      await openSheet(renderer);
      expect(
        sheetButton(renderer, 'Continue to delete').props.disabled,
      ).toBeFalsy();
      expect(
        renderer.root
          .findAllByType(Button)
          .filter(node =>
            String(node.props.label).startsWith('Permanently delete'),
          ),
      ).toHaveLength(0);
      await act(async () => {
        jest.advanceTimersByTime(10_000);
      });
      expect(mockConfirmAccountDeletion).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    });
  });

  describe('failure branches', () => {
    it('request failure: honest copy, back to review, nothing deleted, retry possible', async () => {
      mockRequestAccountDeletion.mockRejectedValueOnce(
        new AccountDeletionError(
          'deletion.unavailable',
          'Account deletion is temporarily unavailable. Nothing was deleted.',
          false,
        ),
      );
      const renderer = renderScreen();
      await openSheet(renderer);
      await act(async () => {
        sheetButton(renderer, 'Continue to delete').props.onPress();
      });
      const copy = allText(renderer);
      expect(copy).toContain(
        'Account deletion is temporarily unavailable. Nothing was deleted.',
      );
      // No spinner stuck, the primary action is re-enabled for a retry.
      const retry = sheetButton(renderer, 'Continue to delete');
      expect(retry.props.disabled).toBeFalsy();
      expect(sheetVisible(renderer)).toBe(true);
      expect(mockConfirmAccountDeletion).not.toHaveBeenCalled();
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).not.toHaveBeenCalled();

      mockRequestAccountDeletion.mockResolvedValueOnce({
        challenge: 'challenge-2',
        expiresAt: '2026-09-01T00:00:00.000Z',
      });
      await act(async () => {
        retry.props.onPress();
      });
      expect(mockRequestAccountDeletion).toHaveBeenCalledTimes(2);
      expect(allText(renderer)).not.toContain('temporarily unavailable');
      expect(sheetButton(renderer, 'Permanently delete').props.label).toBe(
        'Permanently delete (5)',
      );
      act(() => renderer.unmount());
    });

    it('non-typed request failure falls back to generic "nothing was deleted" copy', async () => {
      mockRequestAccountDeletion.mockRejectedValueOnce(new TypeError('boom'));
      const renderer = renderScreen();
      await openSheet(renderer);
      await act(async () => {
        sheetButton(renderer, 'Continue to delete').props.onPress();
      });
      expect(allText(renderer)).toContain(
        'The deletion request could not be completed. Nothing was deleted.',
      );
      expect(
        sheetButton(renderer, 'Continue to delete').props.disabled,
      ).toBeFalsy();
      act(() => renderer.unmount());
    });

    it('retryable confirm failure: stays armed with the same challenge, shows copy, no local purge', async () => {
      mockRequestAccountDeletion.mockResolvedValue({
        challenge: 'challenge-3',
        expiresAt: '2026-09-01T00:00:00.000Z',
      });
      mockConfirmAccountDeletion
        .mockRejectedValueOnce(
          new AccountDeletionError(
            'deletion.unavailable',
            'The server declined this deletion request. Nothing was deleted.',
            true,
          ),
        )
        .mockResolvedValueOnce(undefined);

      const renderer = renderScreen();
      await openSheet(renderer);
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
      expect(mockConfirmAccountDeletion).toHaveBeenCalledWith(
        null,
        'challenge-3',
      );
      expect(allText(renderer)).toContain(
        'The server declined this deletion request. Nothing was deleted.',
      );
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).not.toHaveBeenCalled();

      // Not stuck on "Deleting…": the confirm button is usable again
      // immediately (no second countdown) with the same challenge.
      confirm = sheetButton(renderer, 'Permanently delete');
      expect(confirm.props.label).toBe('Permanently delete');
      expect(confirm.props.disabled).toBe(false);
      await act(async () => {
        confirm.props.onPress();
      });
      expect(mockConfirmAccountDeletion).toHaveBeenLastCalledWith(
        null,
        'challenge-3',
      );
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).toHaveBeenCalledTimes(1);
      expect(sheetVisible(renderer)).toBe(false);
      act(() => renderer.unmount());
    });

    it('non-retryable confirm failure: shows copy, returns to review so a fresh challenge is requested, no local purge', async () => {
      mockRequestAccountDeletion.mockResolvedValue({
        challenge: 'challenge-3',
        expiresAt: '2026-09-01T00:00:00.000Z',
      });
      mockConfirmAccountDeletion.mockRejectedValueOnce(
        new AccountDeletionError(
          'deletion.rejected',
          'The server declined this deletion request. Nothing was deleted.',
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
      const confirm = sheetButton(renderer, 'Permanently delete');
      expect(confirm.props.disabled).toBe(false);
      await act(async () => {
        confirm.props.onPress();
      });
      expect(mockConfirmAccountDeletion).toHaveBeenCalledWith(
        null,
        'challenge-3',
      );
      expect(allText(renderer)).toContain(
        'The server declined this deletion request. Nothing was deleted.',
      );
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).not.toHaveBeenCalled();

      // The rejected challenge is dead: the sheet offers a fresh request
      // rather than re-arming the same one.
      expect(sheetVisible(renderer)).toBe(true);
      expect(
        renderer.root
          .findAllByType(Button)
          .map(node => String(node.props.label)),
      ).not.toContain('Permanently delete');
      expect(sheetButton(renderer, 'Continue to delete').props.disabled).toBe(
        false,
      );
      expect(sheetButton(renderer, 'Keep my account').props.disabled).toBe(
        false,
      );
      act(() => renderer.unmount());
    });
  });

  describe('busy guards', () => {
    it('while the request is in flight the primary and cancel buttons are disabled, the backdrop is inert, and a second tap issues no second request', async () => {
      const pending = deferred<{ challenge: string; expiresAt: string }>();
      mockRequestAccountDeletion.mockReturnValueOnce(pending.promise);
      const renderer = renderScreen();
      await openSheet(renderer);

      const start = sheetButton(renderer, 'Continue to delete');
      await act(async () => {
        start.props.onPress();
      });
      const requesting = sheetButton(renderer, 'Requesting…');
      expect(requesting.props.disabled).toBe(true);
      expect(sheetButton(renderer, 'Keep my account').props.disabled).toBe(
        true,
      );
      const [backdrop] = renderer.root.findAll(
        node => node.props.accessibilityLabel === 'Cancel account deletion',
      );
      expect(backdrop!.props.onPress).toBeUndefined();
      expect(renderer.root.findByType(Modal).props.onRequestClose).toBe(
        undefined,
      );
      expect(mockRequestAccountDeletion).toHaveBeenCalledTimes(1);

      await act(async () => {
        pending.resolve({
          challenge: 'challenge-4',
          expiresAt: '2026-09-01T00:00:00.000Z',
        });
      });
      expect(sheetButton(renderer, 'Permanently delete').props.label).toBe(
        'Permanently delete (5)',
      );
      act(() => renderer.unmount());
    });

    it('while deleting, the confirm button is disabled and shows progress; success closes the sheet exactly once', async () => {
      mockRequestAccountDeletion.mockResolvedValue({
        challenge: 'challenge-5',
        expiresAt: '2026-09-01T00:00:00.000Z',
      });
      const pending = deferred<void>();
      mockConfirmAccountDeletion.mockReturnValueOnce(pending.promise);

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
      const deleting = sheetButton(renderer, 'Deleting…');
      expect(deleting.props.disabled).toBe(true);
      expect(sheetButton(renderer, 'Keep my account').props.disabled).toBe(
        true,
      );
      expect(mockConfirmAccountDeletion).toHaveBeenCalledTimes(1);

      await act(async () => {
        pending.resolve();
      });
      expect(sheetVisible(renderer)).toBe(false);
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).toHaveBeenCalledTimes(1);
      act(() => renderer.unmount());
    });
  });
});
