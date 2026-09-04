import React from 'react';
import { TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * Adversarial pass (mobile-settings-account, pass 3): the two-step account
 * deletion dialog under rapid repeats, cancellation mid-flight, retry after
 * failure, and oversized / unicode survey input.
 */

jest.mock('../../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));

jest.mock('../../../src/data/db', () => ({
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
const mockConfirmAccountDeletion = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../../../src/account/deletion', () => {
  const actual = jest.requireActual<
    typeof import('../../../src/account/deletion')
  >('../../../src/account/deletion');
  return {
    ...actual,
    requestAccountDeletion: (...args: unknown[]) =>
      mockRequestAccountDeletion(...args),
    confirmAccountDeletion: (...args: unknown[]) =>
      mockConfirmAccountDeletion(...args),
  };
});

import { ManageAccountScreen } from '../../../src/screens/ManageAccountScreen';
import { Button } from '../../../src/design/components';
import { AccountDeletionError } from '../../../src/account/deletion';
import { useAuthStore, type AuthSession } from '../../../src/auth/authStore';

const syncedSession: AuthSession = {
  provider: 'google',
  subject: '11111111-1111-4111-8111-111111111111',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
};
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<ManageAccountScreen />);
  });
  return renderer;
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

/** Skip the survey, request the challenge, and burn the 5s hold-off. */
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
  expect(confirm.props.label).toBe('Permanently delete');
  expect(confirm.props.disabled).toBe(false);
  return confirm;
}

describe('ManageAccountScreen deletion — adversarial', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockGoBack.mockClear();
    mockRequestAccountDeletion.mockReset();
    mockConfirmAccountDeletion.mockReset();
    mockRequestAccountDeletion.mockResolvedValue({
      challenge: 'challenge-1',
      expiresAt: '2026-08-31T00:00:00.000Z',
    });
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

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('S6: double-tap Permanently delete at secondsLeft === 0', () => {
    it('two taps as separate events → exactly one delete-confirm request', async () => {
      const gate = deferred<void>();
      mockConfirmAccountDeletion.mockReturnValue(gate.promise);
      const renderer = renderScreen();
      const confirm = await armDeletion(renderer);

      await act(async () => {
        confirm.props.onPress();
      });
      // Re-rendered as 'deleting': disabled, and the handler is a no-op.
      const deleting = sheetButton(renderer, 'Deleting');
      expect(deleting.props.disabled).toBe(true);
      await act(async () => {
        deleting.props.onPress();
      });
      await act(async () => {
        confirm.props.onPress(); // stale closure from the armed render
      });
      expect(mockConfirmAccountDeletion).toHaveBeenCalledTimes(1);
      expect(mockConfirmAccountDeletion).toHaveBeenCalledWith(
        null,
        'challenge-1',
      );

      gate.resolve();
      await act(async () => {
        await Promise.resolve();
      });
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).toHaveBeenCalledTimes(1);
      act(() => renderer.unmount());
    });

    it('CHARACTERIZATION: two taps inside ONE batched event tick → two confirm requests', async () => {
      // React batches both handlers before re-rendering, so both closures
      // observe phase === 'armed'. RN delivers each touch as its own
      // discrete event (flushed synchronously), so this is only reachable if
      // two press callbacks land in the same JS tick. Pinned so the
      // guard (a ref, or `busy` check inside confirmDeletion) is a
      // deliberate addition rather than an accident.
      const gate = deferred<void>();
      mockConfirmAccountDeletion.mockReturnValue(gate.promise);
      const renderer = renderScreen();
      const confirm = await armDeletion(renderer);
      await act(async () => {
        confirm.props.onPress();
        confirm.props.onPress();
      });
      expect(mockConfirmAccountDeletion).toHaveBeenCalledTimes(2);
      gate.resolve();
      await act(async () => {
        await Promise.resolve();
      });
      act(() => renderer.unmount());
    });

    it('25 rapid sequential taps (each its own event) still produce one request', async () => {
      const gate = deferred<void>();
      mockConfirmAccountDeletion.mockReturnValue(gate.promise);
      const renderer = renderScreen();
      const confirm = await armDeletion(renderer);
      for (let i = 0; i < 25; i += 1) {
        await act(async () => {
          confirm.props.onPress();
        });
      }
      expect(mockConfirmAccountDeletion).toHaveBeenCalledTimes(1);
      gate.resolve();
      await act(async () => {
        await Promise.resolve();
      });
      act(() => renderer.unmount());
    });

    it('CHARACTERIZATION: at secondsLeft > 0 only the disabled prop blocks the confirm — the handler itself does not check secondsLeft', async () => {
      mockConfirmAccountDeletion.mockResolvedValue(undefined);
      const renderer = renderScreen();
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
        jest.advanceTimersByTime(2_000);
      });
      const early = sheetButton(renderer, 'Permanently delete');
      expect(early.props.label).toBe('Permanently delete (3)');
      expect(early.props.disabled).toBe(true);
      // The onPress closure does NOT guard on secondsLeft, only on phase —
      // the disabled prop is the only thing stopping an early confirm.
      await act(async () => {
        early.props.onPress();
      });
      expect(mockConfirmAccountDeletion).toHaveBeenCalledTimes(1);
      act(() => renderer.unmount());
    });
  });

  describe('cancellation and retry mid-flight', () => {
    it('a retryable confirm failure re-arms at 0 and the retry sends exactly one more request', async () => {
      mockConfirmAccountDeletion
        .mockRejectedValueOnce(
          new AccountDeletionError(
            'deletion.unavailable',
            'Account deletion is temporarily offline. Nothing was deleted — please try again.',
            true,
          ),
        )
        .mockResolvedValueOnce(undefined);
      const renderer = renderScreen();
      const confirm = await armDeletion(renderer);
      await act(async () => {
        confirm.props.onPress();
      });
      const rearmed = sheetButton(renderer, 'Permanently delete');
      expect(rearmed.props.label).toBe('Permanently delete');
      expect(rearmed.props.disabled).toBe(false);
      await act(async () => {
        rearmed.props.onPress();
      });
      expect(mockConfirmAccountDeletion).toHaveBeenCalledTimes(2);
      expect(
        mockConfirmAccountDeletion.mock.calls.every(
          c => c[1] === 'challenge-1',
        ),
      ).toBe(true);
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).toHaveBeenCalledTimes(1);
      act(() => renderer.unmount());
    });

    it('a non-retryable confirm failure (expired challenge) drops back to review; no auto-retry', async () => {
      mockConfirmAccountDeletion.mockRejectedValueOnce(
        new AccountDeletionError(
          'deletion.rejected',
          'This deletion request has expired. Start again.',
          false,
        ),
      );
      const renderer = renderScreen();
      const confirm = await armDeletion(renderer);
      await act(async () => {
        confirm.props.onPress();
      });
      expect(sheetButton(renderer, 'Continue to delete').props.disabled).toBe(
        false,
      );
      expect(mockConfirmAccountDeletion).toHaveBeenCalledTimes(1);
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    });

    it('Keep my account and the close control are disabled while the confirm is in flight', async () => {
      const gate = deferred<void>();
      mockConfirmAccountDeletion.mockReturnValue(gate.promise);
      const renderer = renderScreen();
      const confirm = await armDeletion(renderer);
      await act(async () => {
        confirm.props.onPress();
      });
      expect(sheetButton(renderer, 'Keep my account').props.disabled).toBe(
        true,
      );
      const close = pressable(
        renderer,
        'Close account deletion confirmation',
      )[0]!;
      expect(close.props.disabled).toBe(true);
      gate.resolve();
      await act(async () => {
        await Promise.resolve();
      });
      act(() => renderer.unmount());
    });

    it('Keep my account is disabled while requesting; closing once armed stops the countdown and a re-open starts over', async () => {
      const gate = deferred<{ challenge: string; expiresAt: string }>();
      mockRequestAccountDeletion.mockReturnValue(gate.promise);
      mockConfirmAccountDeletion.mockResolvedValue(undefined);
      const renderer = renderScreen();
      await act(async () => {
        pressable(renderer, 'Delete account')[0]!.props.onPress();
      });
      await act(async () => {
        pressable(renderer, 'Skip the survey')[0]!.props.onPress();
      });
      await act(async () => {
        sheetButton(renderer, 'Continue to delete').props.onPress();
      });
      expect(sheetButton(renderer, 'Keep my account').props.disabled).toBe(
        true,
      );
      gate.resolve({
        challenge: 'challenge-late',
        expiresAt: '2026-08-31T00:00:00.000Z',
      });
      await act(async () => {
        await Promise.resolve();
      });
      const armed = sheetButton(renderer, 'Permanently delete');
      expect(armed.props.label).toBe('Permanently delete (5)');
      // Close and keep: the countdown must stop and no confirm may fire.
      await act(async () => {
        sheetButton(renderer, 'Keep my account').props.onPress();
      });
      await act(async () => {
        jest.advanceTimersByTime(10_000);
      });
      expect(mockConfirmAccountDeletion).not.toHaveBeenCalled();
      // Re-open: the dialog starts over at the survey, not armed.
      await act(async () => {
        pressable(renderer, 'Delete account')[0]!.props.onPress();
      });
      expect(pressable(renderer, 'Skip the survey').length).toBeGreaterThan(0);
      act(() => renderer.unmount());
    });

    it('while requesting, Continue to delete re-renders disabled; CHARACTERIZATION: its handler is unguarded (a forced call sends again)', async () => {
      const gate = deferred<{ challenge: string; expiresAt: string }>();
      mockRequestAccountDeletion.mockReturnValue(gate.promise);
      const renderer = renderScreen();
      await act(async () => {
        pressable(renderer, 'Delete account')[0]!.props.onPress();
      });
      await act(async () => {
        pressable(renderer, 'Skip the survey')[0]!.props.onPress();
      });
      const cont = sheetButton(renderer, 'Continue to delete');
      await act(async () => {
        cont.props.onPress();
      });
      const requesting = sheetButton(renderer, 'Requesting');
      expect(requesting.props.disabled).toBe(true);
      expect(mockRequestAccountDeletion).toHaveBeenCalledTimes(1);
      // Unlike confirmDeletion (guarded by `phase === 'armed'`),
      // beginRequest has no phase/busy guard: the disabled prop is the only
      // thing preventing a second challenge mint. Pressable honours
      // `disabled`, so this is unreachable from a real tap.
      await act(async () => {
        requesting.props.onPress();
      });
      expect(mockRequestAccountDeletion).toHaveBeenCalledTimes(2);
      gate.resolve({
        challenge: 'c',
        expiresAt: '2026-08-31T00:00:00.000Z',
      });
      await act(async () => {
        await Promise.resolve();
      });
      act(() => renderer.unmount());
    });

    it('CHARACTERIZATION: double tap on Continue to delete within one batched tick → two challenge requests', async () => {
      const gate = deferred<{ challenge: string; expiresAt: string }>();
      mockRequestAccountDeletion.mockReturnValue(gate.promise);
      const renderer = renderScreen();
      await act(async () => {
        pressable(renderer, 'Delete account')[0]!.props.onPress();
      });
      await act(async () => {
        pressable(renderer, 'Skip the survey')[0]!.props.onPress();
      });
      const cont = sheetButton(renderer, 'Continue to delete');
      await act(async () => {
        cont.props.onPress();
        cont.props.onPress();
      });
      // Step 1 is idempotent server-side (upsert on user_id), so a doubled
      // request costs a challenge rotation, never data.
      expect(mockRequestAccountDeletion).toHaveBeenCalledTimes(2);
      gate.resolve({
        challenge: 'c',
        expiresAt: '2026-08-31T00:00:00.000Z',
      });
      await act(async () => {
        await Promise.resolve();
      });
      act(() => renderer.unmount());
    });
  });

  describe('survey payload edges', () => {
    async function openQuestionTwo(renderer: TestRenderer.ReactTestRenderer) {
      await act(async () => {
        pressable(renderer, 'Delete account')[0]!.props.onPress();
      });
      await act(async () => {
        pressable(renderer, 'Something else')[0]!.props.onPress();
      });
      await act(async () => {
        sheetButton(renderer, 'Next').props.onPress();
      });
    }

    it('CHARACTERIZATION: a pasted comment longer than 500 chars is sent unclipped (server sanitizer is the cap)', async () => {
      const renderer = renderScreen();
      await openQuestionTwo(renderer);
      const huge = 'x'.repeat(5_000);
      await act(async () => {
        renderer.root.findByType(TextInput).props.onChangeText(huge);
      });
      await act(async () => {
        sheetButton(renderer, 'Continue').props.onPress();
      });
      await act(async () => {
        sheetButton(renderer, 'Continue to delete').props.onPress();
      });
      const survey = mockRequestAccountDeletion.mock.calls[0]![1] as {
        details: string;
      };
      // TextInput maxLength=500 only gates typing; onChangeText from a
      // paste bypasses it. The screen does not clip; the edge
      // sanitizeUserText(…, 500) does. Pinned at the client boundary.
      expect(survey.details.length).toBe(5_000);
      act(() => renderer.unmount());
    });

    it('unicode / RTL / NUL / emoji comment is forwarded verbatim after trim, not mangled', async () => {
      const renderer = renderScreen();
      await openQuestionTwo(renderer);
      const text = '  \u202Eيلع\u0000👋🏽 c\u0327a\u0301fe\u0301 ﷽  ';
      await act(async () => {
        renderer.root.findByType(TextInput).props.onChangeText(text);
      });
      await act(async () => {
        sheetButton(renderer, 'Continue').props.onPress();
      });
      await act(async () => {
        sheetButton(renderer, 'Continue to delete').props.onPress();
      });
      const survey = mockRequestAccountDeletion.mock.calls[0]![1] as {
        details: string;
        reason: string;
      };
      expect(survey.reason).toBe('other');
      expect(survey.details).toBe(text.trim());
      act(() => renderer.unmount());
    });

    it('whitespace-only comment on question 2 does not count as an answer', async () => {
      const renderer = renderScreen();
      await openQuestionTwo(renderer);
      await act(async () => {
        renderer.root
          .findByType(TextInput)
          .props.onChangeText('   \n\t\u00a0 ');
      });
      expect(sheetButton(renderer, 'Continue').props.disabled).toBe(true);
      act(() => renderer.unmount());
    });
  });
});
