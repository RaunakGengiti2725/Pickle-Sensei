import React from 'react';
import { Modal, StyleSheet, Text, type ViewStyle } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * Button ledger for ManageAccountScreen. Every pressable rendered by the
 * screen (header back, "Delete account" link, and the five dismiss/confirm
 * controls inside DeleteAccountSheet) is pressed here and its real effect
 * asserted: navigation, sheet open/close, the two deletion API calls with
 * the live ApiSession, the armed countdown, the store-level purge, and the
 * user-visible copy on every failure path.
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
    code: string;
    retryable: boolean;
    constructor(code: string, message: string, retryable: boolean) {
      super(message);
      this.name = 'AccountDeletionError';
      this.code = code;
      this.retryable = retryable;
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
import { Button } from '../../src/design/components';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import {
  useApiSessionStore,
  type ApiSession,
} from '../../src/account/apiSession';
import { AccountDeletionError } from '../../src/account/deletion';

const CANONICAL_ID = '11111111-1111-4111-8111-111111111111';

const syncedSession: AuthSession = {
  provider: 'google',
  subject: CANONICAL_ID,
  canonicalAppUserId: CANONICAL_ID,
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
};

const apiSession: ApiSession = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'bearer-token',
  canonicalAppUserId: CANONICAL_ID,
  provider: 'google',
};

const CHALLENGE = {
  challenge: 'challenge-1',
  expiresAt: '2026-08-31T00:00:00.000Z',
};

type Renderer = TestRenderer.ReactTestRenderer;
type Instance = TestRenderer.ReactTestInstance;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderScreen(): Renderer {
  let renderer!: Renderer;
  act(() => {
    renderer = TestRenderer.create(<ManageAccountScreen />);
  });
  return renderer;
}

function allText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

/** React Native `Pressable` elements carrying the given accessibilityLabel
 * (the node that owns onPress/disabled/accessibilityRole/hitSlop). */
function hostByLabel(renderer: Renderer, label: string): Instance[] {
  // `Pressable` is a memo wrapper; the rendered instance is its inner
  // component, so match on the component name rather than the exported type.
  return renderer.root.findAll(node => {
    if (typeof node.type === 'string') {
      return false;
    }
    const { displayName, name } = node.type as {
      displayName?: string;
      name?: string;
    };
    return (
      (displayName ?? name) === 'Pressable' &&
      node.props.accessibilityLabel === label
    );
  });
}

/** The single `Pressable` for a label; fails if absent or duplicated. */
function pressableHost(renderer: Renderer, label: string): Instance {
  const hosts = hostByLabel(renderer, label);
  expect(hosts).toHaveLength(1);
  return hosts[0]!;
}

/** Resolved (unpressed) style of a `Pressable`, function styles included. */
function flatStyle(node: Instance): ViewStyle {
  const style =
    typeof node.props.style === 'function'
      ? node.props.style({ pressed: false })
      : node.props.style;
  return (StyleSheet.flatten(style) ?? {}) as ViewStyle;
}

function sheetButtons(renderer: Renderer): Instance[] {
  return renderer.root.findAllByType(Button);
}

function sheetButton(renderer: Renderer, labelPrefix: string): Instance {
  const matches = sheetButtons(renderer).filter(node =>
    String(node.props.label).startsWith(labelPrefix),
  );
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function sheetOpen(renderer: Renderer): boolean {
  return allText(renderer).includes('Delete your account?');
}

function press(node: Instance) {
  act(() => {
    node.props.onPress();
  });
}

async function pressAsync(node: Instance) {
  await act(async () => {
    node.props.onPress();
  });
}

async function openSheet(renderer: Renderer) {
  await pressAsync(pressableHost(renderer, 'Delete account'));
  expect(sheetOpen(renderer)).toBe(true);
}

/** Open the sheet and drive it to the armed state (request resolved). */
async function armSheet(renderer: Renderer) {
  mockRequestAccountDeletion.mockResolvedValue(CHALLENGE);
  await openSheet(renderer);
  await pressAsync(sheetButton(renderer, 'Continue to delete'));
  expect(mockRequestAccountDeletion).toHaveBeenCalledTimes(1);
  expect(sheetButton(renderer, 'Permanently delete').props.label).toBe(
    'Permanently delete (5)',
  );
}

describe('ManageAccountScreen button ledger', () => {
  let renderer: Renderer | null = null;

  beforeEach(() => {
    jest.useFakeTimers();
    mockGoBack.mockClear();
    mockRequestAccountDeletion.mockReset();
    mockConfirmAccountDeletion.mockReset();
    useApiSessionStore.setState({ session: apiSession });
    useAuthStore.setState({
      hydrated: true,
      session: syncedSession,
      busy: false,
      error: null,
      completeAccountDeletion: jest.fn(() => Promise.resolve()),
    });
  });

  afterEach(() => {
    if (renderer) {
      const current = renderer;
      act(() => current.unmount());
      renderer = null;
    }
    jest.useRealTimers();
  });

  describe('screen', () => {
    it('Back -> navigation.goBack(), role button, 44pt + hitSlop', () => {
      renderer = renderScreen();
      const back = pressableHost(renderer, 'Back');
      expect(back.props.accessibilityRole).toBe('button');
      expect(back.props.hitSlop).toBe(8);
      expect(flatStyle(back)).toMatchObject({ width: 44, height: 44 });
      press(back);
      expect(mockGoBack).toHaveBeenCalledTimes(1);
    });

    it('Delete account -> opens the confirmation sheet (role, label, 44pt)', async () => {
      renderer = renderScreen();
      expect(sheetOpen(renderer)).toBe(false);
      const link = pressableHost(renderer, 'Delete account');
      expect(link.props.accessibilityRole).toBe('button');
      expect(flatStyle(link).minHeight).toBeGreaterThanOrEqual(44);
      await pressAsync(link);
      expect(sheetOpen(renderer)).toBe(true);
      // The sheet opens in the review step: nothing was requested yet.
      expect(sheetButton(renderer, 'Continue to delete').props.disabled).toBe(
        false,
      );
      expect(mockRequestAccountDeletion).not.toHaveBeenCalled();
      // Re-tapping the link while open is idempotent.
      await pressAsync(link);
      expect(sheetOpen(renderer)).toBe(true);
      expect(renderer.root.findAllByType(Modal)).toHaveLength(1);
    });

    it('Delete account is hidden for local-only (guest) sessions', () => {
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
      renderer = renderScreen();
      expect(hostByLabel(renderer, 'Delete account')).toHaveLength(0);
      expect(allText(renderer)).toContain('LOCAL');
    });

    it('renders null server fields as placeholders without throwing', () => {
      useAuthStore.setState({
        session: { ...syncedSession, displayName: null, email: null },
      });
      renderer = renderScreen();
      const copy = allText(renderer);
      expect(copy).toContain('Account details');
      expect(copy).toContain('—');
      expect(copy).toContain('Google');
      expect(hostByLabel(renderer, 'Delete account')).toHaveLength(1);
    });

    it('renders a session-less screen (no session) without throwing', () => {
      useAuthStore.setState({ session: null });
      renderer = renderScreen();
      expect(allText(renderer)).toContain('LOCAL');
      expect(hostByLabel(renderer, 'Delete account')).toHaveLength(0);
      press(pressableHost(renderer, 'Back'));
      expect(mockGoBack).toHaveBeenCalledTimes(1);
    });
  });

  describe('sheet dismiss controls (idle)', () => {
    it('Modal onRequestClose -> closes the sheet', async () => {
      renderer = renderScreen();
      await openSheet(renderer);
      const modal = renderer.root.findByType(Modal);
      expect(typeof modal.props.onRequestClose).toBe('function');
      act(() => modal.props.onRequestClose());
      expect(sheetOpen(renderer)).toBe(false);
    });

    it('Backdrop "Cancel account deletion" -> closes the sheet', async () => {
      renderer = renderScreen();
      await openSheet(renderer);
      const backdrop = pressableHost(renderer, 'Cancel account deletion');
      expect(flatStyle(backdrop)).toMatchObject({
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
      });
      press(backdrop);
      expect(sheetOpen(renderer)).toBe(false);
    });

    // WF-ISSUE: Deletion sheet backdrop Pressable has no accessibilityRole
    it.skip('Backdrop "Cancel account deletion" exposes accessibilityRole', async () => {
      renderer = renderScreen();
      await openSheet(renderer);
      const backdrop = pressableHost(renderer, 'Cancel account deletion');
      expect(backdrop.props.accessibilityRole).toBe('button');
    });

    it('X "Close account deletion confirmation" -> closes the sheet (role, 44pt)', async () => {
      renderer = renderScreen();
      await openSheet(renderer);
      const close = pressableHost(
        renderer,
        'Close account deletion confirmation',
      );
      expect(close.props.accessibilityRole).toBe('button');
      expect(flatStyle(close)).toMatchObject({ width: 44, height: 44 });
      press(close);
      expect(sheetOpen(renderer)).toBe(false);
    });

    it('Keep my account -> closes the sheet (role button, enabled)', async () => {
      renderer = renderScreen();
      await openSheet(renderer);
      const keep = sheetButton(renderer, 'Keep my account');
      expect(keep.props.disabled).toBe(false);
      const host = pressableHost(renderer, 'Keep my account');
      expect(host.props.accessibilityRole).toBe('button');
      expect(host.props.accessibilityState).toMatchObject({ disabled: false });
      press(keep);
      expect(sheetOpen(renderer)).toBe(false);
      expect(mockRequestAccountDeletion).not.toHaveBeenCalled();
    });

    it('closing resets the sheet: reopening starts at "Continue to delete" with no stale error', async () => {
      renderer = renderScreen();
      mockRequestAccountDeletion.mockRejectedValue(new Error('boom'));
      await openSheet(renderer);
      await pressAsync(sheetButton(renderer, 'Continue to delete'));
      expect(allText(renderer)).toContain(
        'The deletion request could not be completed. Nothing was deleted.',
      );
      press(sheetButton(renderer, 'Keep my account'));
      expect(sheetOpen(renderer)).toBe(false);

      mockRequestAccountDeletion.mockResolvedValue(CHALLENGE);
      await openSheet(renderer);
      expect(allText(renderer)).not.toContain('could not be completed');
      expect(sheetButton(renderer, 'Continue to delete').props.disabled).toBe(
        false,
      );
    });

    it('closing while armed stops the countdown and reopening starts over', async () => {
      renderer = renderScreen();
      await armSheet(renderer);
      press(sheetButton(renderer, 'Keep my account'));
      expect(sheetOpen(renderer)).toBe(false);
      act(() => {
        jest.advanceTimersByTime(10_000);
      });
      await openSheet(renderer);
      expect(sheetButton(renderer, 'Continue to delete').props.label).toBe(
        'Continue to delete',
      );
      expect(sheetButtons(renderer).map(b => b.props.label)).toEqual([
        'Keep my account',
        'Continue to delete',
      ]);
    });
  });

  describe('Continue to delete -> requestAccountDeletion', () => {
    it('calls the API with the live ApiSession, shows "Requesting…" disabled, then arms a 5s countdown', async () => {
      renderer = renderScreen();
      const pending = deferred<typeof CHALLENGE>();
      mockRequestAccountDeletion.mockReturnValue(pending.promise);
      await openSheet(renderer);

      await pressAsync(sheetButton(renderer, 'Continue to delete'));
      expect(mockRequestAccountDeletion).toHaveBeenCalledTimes(1);
      expect(mockRequestAccountDeletion).toHaveBeenCalledWith(apiSession);

      // Pending: both action buttons disabled, spinner copy, no double fire.
      const requesting = sheetButton(renderer, 'Requesting…');
      expect(requesting.props.disabled).toBe(true);
      expect(
        pressableHost(renderer, 'Requesting…').props.accessibilityState,
      ).toMatchObject({ disabled: true });
      expect(sheetButton(renderer, 'Keep my account').props.disabled).toBe(
        true,
      );
      // The double-tap guard is the Pressable `disabled` gate (Pressability
      // never fires onPress while disabled), so assert the gate is closed.
      expect(pressableHost(renderer, 'Requesting…').props.disabled).toBe(true);
      expect(mockRequestAccountDeletion).toHaveBeenCalledTimes(1);

      await act(async () => {
        pending.resolve(CHALLENGE);
        await pending.promise;
      });

      let confirm = sheetButton(renderer, 'Permanently delete');
      expect(confirm.props.label).toBe('Permanently delete (5)');
      expect(confirm.props.disabled).toBe(true);
      expect(sheetButton(renderer, 'Keep my account').props.disabled).toBe(
        false,
      );

      act(() => {
        jest.advanceTimersByTime(4_000);
      });
      confirm = sheetButton(renderer, 'Permanently delete');
      expect(confirm.props.label).toBe('Permanently delete (1)');
      expect(confirm.props.disabled).toBe(true);

      act(() => {
        jest.advanceTimersByTime(1_000);
      });
      confirm = sheetButton(renderer, 'Permanently delete');
      expect(confirm.props.label).toBe('Permanently delete');
      expect(confirm.props.disabled).toBe(false);
      expect(
        pressableHost(renderer, 'Permanently delete').props.accessibilityRole,
      ).toBe('button');

      // The countdown stops at 0 and never wraps or re-disables.
      act(() => {
        jest.advanceTimersByTime(30_000);
      });
      confirm = sheetButton(renderer, 'Permanently delete');
      expect(confirm.props.label).toBe('Permanently delete');
      expect(confirm.props.disabled).toBe(false);
    });

    it('AccountDeletionError -> its message is shown and the button re-enables', async () => {
      renderer = renderScreen();
      mockRequestAccountDeletion.mockRejectedValue(
        new AccountDeletionError(
          'deletion.unavailable',
          'Account deletion is temporarily offline. Nothing was deleted — please try again.',
          true,
        ),
      );
      await openSheet(renderer);
      await pressAsync(sheetButton(renderer, 'Continue to delete'));
      expect(allText(renderer)).toContain(
        'Account deletion is temporarily offline. Nothing was deleted — please try again.',
      );
      const retry = sheetButton(renderer, 'Continue to delete');
      expect(retry.props.disabled).toBe(false);
      expect(sheetButton(renderer, 'Keep my account').props.disabled).toBe(
        false,
      );
      // Nothing was armed: no "Permanently delete" button, no confirm call.
      expect(
        sheetButtons(renderer).filter(b =>
          String(b.props.label).startsWith('Permanently delete'),
        ),
      ).toHaveLength(0);
      expect(mockConfirmAccountDeletion).not.toHaveBeenCalled();

      // Retry succeeds and clears the error copy.
      mockRequestAccountDeletion.mockResolvedValue(CHALLENGE);
      await pressAsync(retry);
      expect(allText(renderer)).not.toContain('temporarily offline');
      expect(sheetButton(renderer, 'Permanently delete').props.label).toBe(
        'Permanently delete (5)',
      );
    });

    it('unknown rejection -> generic copy, sheet stays open, button re-enables', async () => {
      renderer = renderScreen();
      mockRequestAccountDeletion.mockRejectedValue(new TypeError('network'));
      await openSheet(renderer);
      await pressAsync(sheetButton(renderer, 'Continue to delete'));
      expect(sheetOpen(renderer)).toBe(true);
      expect(allText(renderer)).toContain(
        'The deletion request could not be completed. Nothing was deleted.',
      );
      expect(sheetButton(renderer, 'Continue to delete').props.disabled).toBe(
        false,
      );
    });

    it('missing ApiSession -> the deletion module rejection is surfaced, not swallowed', async () => {
      renderer = renderScreen();
      useApiSessionStore.setState({ session: null });
      mockRequestAccountDeletion.mockRejectedValue(
        new AccountDeletionError(
          'deletion.not_configured',
          'Sign in to a synced account before deleting it.',
          false,
        ),
      );
      await openSheet(renderer);
      await pressAsync(sheetButton(renderer, 'Continue to delete'));
      expect(mockRequestAccountDeletion).toHaveBeenCalledWith(null);
      expect(allText(renderer)).toContain(
        'Sign in to a synced account before deleting it.',
      );
    });
  });

  describe('Permanently delete -> confirmAccountDeletion', () => {
    it('is inert during the countdown and while deleting (double-tap guard)', async () => {
      renderer = renderScreen();
      await armSheet(renderer);
      const pending = deferred<void>();
      mockConfirmAccountDeletion.mockReturnValue(pending.promise);

      // Disabled during countdown: the store-level control blocks the tap.
      const counting = sheetButton(renderer, 'Permanently delete');
      expect(counting.props.disabled).toBe(true);
      expect(
        pressableHost(renderer, 'Permanently delete (5)').props
          .accessibilityState,
      ).toMatchObject({ disabled: true });

      act(() => {
        jest.advanceTimersByTime(5_000);
      });
      await pressAsync(sheetButton(renderer, 'Permanently delete'));
      expect(mockConfirmAccountDeletion).toHaveBeenCalledTimes(1);

      const deleting = sheetButton(renderer, 'Deleting…');
      expect(deleting.props.disabled).toBe(true);
      expect(sheetButton(renderer, 'Keep my account').props.disabled).toBe(
        true,
      );
      // A second tap while deleting is a no-op (phase guard inside onPress).
      await pressAsync(deleting);
      expect(mockConfirmAccountDeletion).toHaveBeenCalledTimes(1);

      await act(async () => {
        pending.resolve(undefined);
        await pending.promise;
      });
    });

    it('success -> confirm called with (ApiSession, challenge), sheet closes, completeAccountDeletion runs', async () => {
      renderer = renderScreen();
      await armSheet(renderer);
      mockConfirmAccountDeletion.mockResolvedValue(undefined);
      act(() => {
        jest.advanceTimersByTime(5_000);
      });
      await pressAsync(sheetButton(renderer, 'Permanently delete'));
      expect(mockConfirmAccountDeletion).toHaveBeenCalledWith(
        apiSession,
        'challenge-1',
      );
      expect(sheetOpen(renderer)).toBe(false);
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).toHaveBeenCalledTimes(1);
    });

    it('non-retryable AccountDeletionError -> message shown, back to review (fresh challenge required), nothing purged', async () => {
      renderer = renderScreen();
      await armSheet(renderer);
      mockConfirmAccountDeletion.mockRejectedValue(
        new AccountDeletionError(
          'deletion.rejected',
          'The server did not confirm the deletion.',
          false,
        ),
      );
      act(() => {
        jest.advanceTimersByTime(5_000);
      });
      await pressAsync(sheetButton(renderer, 'Permanently delete'));
      expect(sheetOpen(renderer)).toBe(true);
      expect(allText(renderer)).toContain(
        'The server did not confirm the deletion.',
      );
      // The dead challenge is not offered again: the sheet returns to the
      // review step so the next attempt requests a new one.
      expect(
        sheetButtons(renderer).map(node => node.props.label),
      ).not.toContain('Permanently delete');
      const restart = sheetButton(renderer, 'Continue to delete');
      expect(restart.props.disabled).toBe(false);
      expect(sheetButton(renderer, 'Keep my account').props.disabled).toBe(
        false,
      );
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).not.toHaveBeenCalled();
    });

    it('retryable AccountDeletionError -> message shown, stays armed at 0 and re-enabled, nothing purged', async () => {
      renderer = renderScreen();
      await armSheet(renderer);
      mockConfirmAccountDeletion.mockRejectedValue(
        new AccountDeletionError(
          'deletion.unavailable',
          'The server did not confirm the deletion.',
          true,
        ),
      );
      act(() => {
        jest.advanceTimersByTime(5_000);
      });
      await pressAsync(sheetButton(renderer, 'Permanently delete'));
      expect(sheetOpen(renderer)).toBe(true);
      expect(allText(renderer)).toContain(
        'The server did not confirm the deletion.',
      );
      const confirm = sheetButton(renderer, 'Permanently delete');
      expect(confirm.props.label).toBe('Permanently delete');
      expect(confirm.props.disabled).toBe(false);
      expect(sheetButton(renderer, 'Keep my account').props.disabled).toBe(
        false,
      );
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).not.toHaveBeenCalled();

      // Retry from the error state uses the same challenge and can succeed.
      mockConfirmAccountDeletion.mockResolvedValue(undefined);
      await pressAsync(confirm);
      expect(mockConfirmAccountDeletion).toHaveBeenLastCalledWith(
        apiSession,
        'challenge-1',
      );
      expect(sheetOpen(renderer)).toBe(false);
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).toHaveBeenCalledTimes(1);
    });

    it('unknown rejection -> generic copy, button re-enabled', async () => {
      renderer = renderScreen();
      await armSheet(renderer);
      mockConfirmAccountDeletion.mockRejectedValue(new TypeError('network'));
      act(() => {
        jest.advanceTimersByTime(5_000);
      });
      await pressAsync(sheetButton(renderer, 'Permanently delete'));
      expect(allText(renderer)).toContain(
        'The deletion could not be completed. Nothing was deleted.',
      );
      expect(sheetButton(renderer, 'Permanently delete').props.disabled).toBe(
        false,
      );
    });
  });

  describe('sheet dismiss controls while busy', () => {
    it('Modal onRequestClose and backdrop are inert while requesting', async () => {
      renderer = renderScreen();
      const pending = deferred<typeof CHALLENGE>();
      mockRequestAccountDeletion.mockReturnValue(pending.promise);
      await openSheet(renderer);
      await pressAsync(sheetButton(renderer, 'Continue to delete'));

      expect(
        renderer.root.findByType(Modal).props.onRequestClose,
      ).toBeUndefined();
      const backdrop = pressableHost(renderer, 'Cancel account deletion');
      expect(backdrop.props.onPress).toBeUndefined();
      expect(sheetButton(renderer, 'Keep my account').props.disabled).toBe(
        true,
      );
      expect(sheetOpen(renderer)).toBe(true);

      await act(async () => {
        pending.resolve(CHALLENGE);
        await pending.promise;
      });
      expect(sheetOpen(renderer)).toBe(true);
    });

    it('Modal onRequestClose and backdrop are inert while deleting', async () => {
      renderer = renderScreen();
      await armSheet(renderer);
      const pending = deferred<void>();
      mockConfirmAccountDeletion.mockReturnValue(pending.promise);
      act(() => {
        jest.advanceTimersByTime(5_000);
      });
      await pressAsync(sheetButton(renderer, 'Permanently delete'));

      expect(
        renderer.root.findByType(Modal).props.onRequestClose,
      ).toBeUndefined();
      expect(
        pressableHost(renderer, 'Cancel account deletion').props.onPress,
      ).toBeUndefined();
      expect(sheetButton(renderer, 'Keep my account').props.disabled).toBe(
        true,
      );

      await act(async () => {
        pending.reject(new TypeError('network'));
        await pending.promise.catch(() => undefined);
      });
      expect(sheetOpen(renderer)).toBe(true);
    });

    // WF-ISSUE: Deletion sheet close (X) ignores the busy state and dismisses mid-request
    it.skip('X "Close account deletion confirmation" is inert while requesting (like every other dismiss control)', async () => {
      renderer = renderScreen();
      const pending = deferred<typeof CHALLENGE>();
      mockRequestAccountDeletion.mockReturnValue(pending.promise);
      await openSheet(renderer);
      await pressAsync(sheetButton(renderer, 'Continue to delete'));

      const close = pressableHost(
        renderer,
        'Close account deletion confirmation',
      );
      expect(close.props.accessibilityState).toMatchObject({ disabled: true });
      act(() => {
        close.props.onPress?.();
      });
      expect(sheetOpen(renderer)).toBe(true);

      await act(async () => {
        pending.resolve(CHALLENGE);
        await pending.promise;
      });
      // Had the X dismissed the sheet mid-request, reopening it would skip
      // the review step and land straight on an armed "Permanently delete".
      press(sheetButton(renderer, 'Keep my account'));
      await openSheet(renderer);
      expect(sheetButton(renderer, 'Continue to delete').props.label).toBe(
        'Continue to delete',
      );
    });
  });
});
