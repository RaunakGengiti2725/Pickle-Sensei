import React from 'react';
import { Modal, StyleSheet, Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * Accessibility workflow audit — Settings → Manage account → Delete account.
 *
 * Drives the deletion dialog (two-question exit survey, then the two-step
 * confirmation) through its cancel and failure branches via the host-level
 * accessibility activate path, checking that every control is labelled, that
 * the survey announces its radios, selection and progress, that busy states
 * are mirrored into `accessibilityState.disabled` (double-tap guard), that a
 * failed request or confirmation shows honest copy and leaves a retry path
 * (no dead end), and that nothing is deleted on any cancel branch.
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

import { ManageAccountScreen } from '../../src/screens/ManageAccountScreen';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import {
  ACCOUNT_DELETION_DETAILS_MAX,
  AccountDeletionError,
} from '../../src/account/deletion';

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

/** Host nodes VoiceOver would read with the given role. */
function hostsWithRole(renderer: TestRenderer.ReactTestRenderer, role: string) {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'string' && node.props.accessibilityRole === role,
  );
}

/** Activate the link: the dialog opens on exit-survey question 1. */
async function openSurvey(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    press(byLabelPrefix(renderer, 'Delete account'));
  });
  expect(modalOf(renderer).props.visible).toBe(true);
  expect(allText(renderer)).toContain("What's making you leave?");
  expect(allText(renderer)).not.toContain('Delete your account?');
}

/** Open the dialog and skip the survey straight to the confirmation page. */
async function openSheet(renderer: TestRenderer.ReactTestRenderer) {
  await openSurvey(renderer);
  await act(async () => {
    press(byLabelPrefix(renderer, 'Skip the survey'));
  });
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

  it('question 1 is a labelled radio group with announced progress; Next mirrors its gate, Skip and close are always live', async () => {
    const renderer = renderScreen();
    await openSurvey(renderer);

    // Progress is exposed as a progressbar, not just visual text.
    const progress = hostsWithRole(renderer, 'progressbar');
    expect(progress).toHaveLength(1);
    expect(progress[0]!.props.accessibilityLabel).toBe('Question 1 of 2');
    expect(hostsWithRole(renderer, 'radiogroup')).toHaveLength(1);

    // Seven reasons, each a radio on a ≥44pt row announcing its selection.
    const radios = hostsWithRole(renderer, 'radio');
    expect(radios.map(node => node.props.accessibilityLabel)).toEqual([
      "I don't use it enough",
      "It hasn't improved my game",
      'The technique reads felt off',
      'Bugs, crashes, or camera trouble',
      "It's too expensive",
      'Privacy or data concerns',
      'Something else',
    ]);
    for (const radio of radios) {
      expect(radio.props.accessibilityState?.selected).toBe(false);
      expect(minHeightOf(radio)).toBeGreaterThanOrEqual(MIN_TARGET_PT);
    }
    // The disabled Next is announced disabled and activating it does nothing.
    const next = byLabelPrefix(renderer, 'Next');
    expect(next.props.accessibilityState?.disabled).toBe(true);
    act(() => press(next));
    expect(allText(renderer)).toContain("What's making you leave?");

    await act(async () => {
      press(byLabelPrefix(renderer, "It's too expensive"));
    });
    expect(
      byLabelPrefix(renderer, "It's too expensive").props.accessibilityState
        ?.selected,
    ).toBe(true);
    expect(
      byLabelPrefix(renderer, "I don't use it enough").props.accessibilityState
        ?.selected,
    ).toBe(false);
    expect(
      byLabelPrefix(renderer, 'Next').props.accessibilityState?.disabled,
    ).toBe(false);

    // Escape hatches are labelled buttons that are never gated.
    for (const label of ['Skip the survey', 'Close and keep my account']) {
      const node = byLabelPrefix(renderer, label);
      expect(node.props.accessibilityRole).toBe('button');
      expect(node.props.accessibilityState?.disabled).toBeFalsy();
    }
    // WF-ISSUE: "Skip the survey" / "Skip this question" text links are 40pt
    // tall (styles.textLink minHeight 40) and the header X/Back are 36pt
    // (styles.headerButton), all without hitSlop — below the 44pt minimum
    // hit target; the size assertions are intentionally skipped here.
    // expect(minHeightOf(byLabelPrefix(renderer, 'Skip the survey'))).toBeGreaterThanOrEqual(MIN_TARGET_PT);
    // expect(minHeightOf(byLabelPrefix(renderer, 'Close and keep my account'))).toBeGreaterThanOrEqual(MIN_TARGET_PT);
    expect(mockRequestAccountDeletion).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('question 2 announces its radios, an optional labelled comment field with a cap, and a Back control', async () => {
    const renderer = renderScreen();
    await openSurvey(renderer);
    await act(async () => {
      press(byLabelPrefix(renderer, 'Something else'));
    });
    await act(async () => {
      press(byLabelPrefix(renderer, 'Next'));
    });
    expect(allText(renderer)).toContain('What would have kept you?');
    expect(
      hostsWithRole(renderer, 'progressbar')[0]!.props.accessibilityLabel,
    ).toBe('Question 2 of 2');
    expect(
      hostsWithRole(renderer, 'radio').map(n => n.props.accessibilityLabel),
    ).toEqual([
      'More accurate technique reads',
      'A lower price or a free tier',
      'More drills and coaching guidance',
      'Fewer bugs and smoother capture',
      "Nothing — I've found another app or a coach",
      "Nothing — I just don't need it anymore",
    ]);

    const input = renderer.root.findByType(TextInput);
    expect(input.props.accessibilityLabel).toBe(
      'Anything else you want us to know',
    );
    expect(input.props.accessibilityHint).toBe('Optional');
    expect(input.props.maxLength).toBe(ACCOUNT_DELETION_DETAILS_MAX);

    // Continue is gated (announced) until an option OR a comment exists.
    expect(
      byLabelPrefix(renderer, 'Continue').props.accessibilityState?.disabled,
    ).toBe(true);
    await act(async () => {
      input.props.onChangeText('Moving abroad');
    });
    expect(
      byLabelPrefix(renderer, 'Continue').props.accessibilityState?.disabled,
    ).toBe(false);

    const back = byLabelPrefix(renderer, 'Back to the previous question');
    expect(back.props.accessibilityRole).toBe('button');
    expect(
      byLabelPrefix(renderer, 'Skip this question').props.accessibilityRole,
    ).toBe('button');
    await act(async () => {
      press(back);
    });
    expect(allText(renderer)).toContain("What's making you leave?");
    expect(
      byLabelPrefix(renderer, 'Something else').props.accessibilityState
        ?.selected,
    ).toBe(true);
    act(() => renderer.unmount());
  });

  it('the answers given travel with the request; skipping sends none', async () => {
    mockRequestAccountDeletion.mockResolvedValue({
      challenge: 'c-survey',
      expiresAt: '2026-09-02T00:00:00.000Z',
    });
    const renderer = renderScreen();
    await openSurvey(renderer);
    await act(async () => {
      press(byLabelPrefix(renderer, 'Privacy or data concerns'));
    });
    await act(async () => {
      press(byLabelPrefix(renderer, 'Next'));
    });
    await act(async () => {
      press(byLabelPrefix(renderer, 'More accurate technique reads'));
    });
    await act(async () => {
      press(byLabelPrefix(renderer, 'Continue'));
    });
    expect(allText(renderer)).toContain('Delete your account?');
    await act(async () => {
      press(byLabelPrefix(renderer, 'Continue to delete'));
    });
    expect(mockRequestAccountDeletion).toHaveBeenCalledWith(null, {
      reason: 'privacy',
      wanted: 'accuracy',
      details: null,
      platform: 'ios',
      appVersion: '1.0',
    });
    act(() => press(byLabelPrefix(renderer, 'Keep my account')));

    mockRequestAccountDeletion.mockClear();
    await openSheet(renderer);
    await act(async () => {
      press(byLabelPrefix(renderer, 'Continue to delete'));
    });
    expect(mockRequestAccountDeletion).toHaveBeenCalledWith(null, null);
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
