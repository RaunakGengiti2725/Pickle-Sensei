import React from 'react';
import {
  Animated,
  Image,
  LayoutAnimation,
  StyleSheet,
  Text,
  TextInput,
} from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * Account deletion moved off the Settings root onto the ManageAccount
 * screen (Settings → Manage account → quiet "Delete account" link). These
 * tests pin that the relocated surface still satisfies App Review
 * 5.1.1(v): the link exists for synced sessions, never for local-only
 * ones, and the full two-step server-verified flow (request → armed
 * countdown → confirm → local purge) still runs from here.
 *
 * The tap now opens a centered two-question exit survey first (why →
 * what would have kept you + optional comment). Every page is skippable
 * (the survey must never obstruct deletion), Next/Continue need an answer,
 * Back keeps answers, and whatever was answered travels with the step-1
 * request so it is stored before the account is gone.
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
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => insets,
    initialWindowMetrics: null,
  };
});

const mockShowBrandNotice = jest.fn();
jest.mock('../src/design/BrandNotice', () => ({
  showBrandNotice: (notice: unknown) => mockShowBrandNotice(notice),
}));

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
  // Only the network calls are stubbed; the survey vocabulary/caps the
  // screen renders from are the real ones.
  const actual = jest.requireActual<typeof import('../src/account/deletion')>(
    '../src/account/deletion',
  );
  return {
    ...actual,
    requestAccountDeletion: (...args: unknown[]) =>
      mockRequestAccountDeletion(...args),
    confirmAccountDeletion: (...args: unknown[]) =>
      mockConfirmAccountDeletion(...args),
  };
});

let mockReducedMotion = false;
jest.mock('../src/design/components', () => {
  const actual = jest.requireActual<typeof import('../src/design/components')>(
    '../src/design/components',
  );
  return { ...actual, useReducedMotion: () => mockReducedMotion };
});

import {
  ManageAccountScreen,
  DELETION_MASCOT_MOMENTS,
} from '../src/screens/ManageAccountScreen';
import { color, type } from '../src/design/tokens';
import { Button, PressableScale } from '../src/design/components';
import { useAuthStore, type AuthSession } from '../src/auth/authStore';
import {
  clearApiSession,
  establishApiSession,
} from '../src/account/apiSession';
import {
  captureDataOwnerContext,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../src/data/accountScope';

const syncedSession: AuthSession = {
  provider: 'google',
  subject: '11111111-1111-4111-8111-111111111111',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
};

const apiSession = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'access-token',
  canonicalAppUserId: syncedSession.canonicalAppUserId!,
  provider: 'google' as const,
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

/** The survey's single-select rows, in render order. */
function radios(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAllByType(PressableScale)
    .filter(node => node.props.accessibilityRole === 'radio');
}

async function armDeletion(renderer: TestRenderer.ReactTestRenderer) {
  mockRequestAccountDeletion.mockResolvedValue({
    challenge: 'captured-challenge',
    expiresAt: '2099-01-01T00:00:00.000Z',
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
}

describe('ManageAccountScreen', () => {
  beforeEach(() => {
    mockReducedMotion = false;
    mockGoBack.mockClear();
    mockShowBrandNotice.mockClear();
    mockRequestAccountDeletion.mockReset();
    mockConfirmAccountDeletion.mockReset();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    setActiveDataOwner(apiSession.canonicalAppUserId);
    establishApiSession(apiSession);
    useAuthStore.setState({
      hydrated: true,
      session: syncedSession,
      busy: false,
      error: null,
      completeAccountDeletion: jest.fn(() => Promise.resolve()),
    });
  });

  it.each(['signed_out', 'another_account'])(
    'passes the immutable original owner to cleanup after auth changes to %s during confirmation',
    async next => {
      jest.useFakeTimers();
      const context = { ...captureDataOwnerContext(), provider: 'google' };
      let resolve!: () => void;
      mockConfirmAccountDeletion.mockReturnValue(
        new Promise<void>(res => {
          resolve = res;
        }),
      );
      const cleanup = useAuthStore.getState().completeAccountDeletion;
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await act(async () => {
          sheetButton(renderer, 'Permanently delete').props.onPress();
        });
        await act(async () => {
          clearApiSession();
          setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
          useAuthStore.setState({ session: null });
          if (next === 'another_account') {
            const owner = '22222222-2222-4222-8222-222222222222';
            setActiveDataOwner(owner);
            establishApiSession({
              ...apiSession,
              canonicalAppUserId: owner,
              provider: 'apple',
            });
            useAuthStore.setState({
              session: {
                ...syncedSession,
                canonicalAppUserId: owner,
                subject: owner,
                provider: 'apple',
              },
            });
          }
          resolve();
        });

        expect(cleanup).toHaveBeenCalledWith(context);
        expect(Object.isFrozen((cleanup as jest.Mock).mock.calls[0]![0])).toBe(
          true,
        );
        expect(mockShowBrandNotice).toHaveBeenCalledWith(
          expect.objectContaining({
            title: 'Account deleted',
            tone: 'success',
            eyebrow: 'DELETION CONFIRMED',
          }),
        );
      } finally {
        act(() => renderer.unmount());
        jest.useRealTimers();
      }
    },
  );

  it('does not send a challenge from A with B credentials after switching during the countdown', async () => {
    jest.useFakeTimers();
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      const owner = '22222222-2222-4222-8222-222222222222';
      await act(async () => {
        setActiveDataOwner(owner);
        establishApiSession({ ...apiSession, canonicalAppUserId: owner });
        useAuthStore.setState({
          session: {
            ...syncedSession,
            canonicalAppUserId: owner,
            subject: owner,
          },
        });
        sheetButton(renderer, 'Permanently delete').props.onPress();
      });

      expect(mockConfirmAccountDeletion).not.toHaveBeenCalled();
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).not.toHaveBeenCalled();
      expect(allText(renderer)).toContain('The signed-in account changed.');
    } finally {
      act(() => renderer.unmount());
      jest.useRealTimers();
    }
  });

  it('shows unknown completion after an unexpected final transport failure, never a keep-account claim', async () => {
    jest.useFakeTimers();
    mockConfirmAccountDeletion.mockRejectedValue(new Error('lost response'));
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await act(async () => {
        sheetButton(renderer, 'Permanently delete').props.onPress();
      });

      expect(allText(renderer)).toContain('Deletion status unknown');
      expect(allText(renderer)).toContain('may have completed');
      expect(allText(renderer)).not.toContain('Nothing was deleted');
      expect(allText(renderer)).not.toContain('Keep my account');
      expect(sheetButton(renderer, 'Retry deletion').props.disabled).toBe(
        false,
      );
      expect(sheetButton(renderer, 'Close').props.disabled).toBe(false);
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).not.toHaveBeenCalled();
      expect(mockShowBrandNotice).not.toHaveBeenCalled();
    } finally {
      act(() => renderer.unmount());
      jest.useRealTimers();
    }
  });

  it('keeps an offline restored owner in recovery instead of asking it to connect another account', async () => {
    clearApiSession();
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

    expect(mockRequestAccountDeletion).not.toHaveBeenCalled();
    expect(allText(renderer)).toContain('Your account is still reconnecting.');
    expect(allText(renderer)).not.toContain('Sign in to a synced account');
    act(() => renderer.unmount());
  });

  afterEach(() => jest.restoreAllMocks());

  it('keeps the three survey and review captions as plain text with reachable 44pt controls', async () => {
    const renderer = renderScreen();
    const expectContext = (phase: keyof typeof DELETION_MASCOT_MOMENTS) => {
      const context = renderer.root
        .findAllByType(Text)
        .find(node => node.props.testID === `deletion-context-${phase}`)!;
      expect(context.props.children).toBe(
        DELETION_MASCOT_MOMENTS[phase].caption,
      );
      const style = StyleSheet.flatten(context.props.style);
      expect(style).toMatchObject({
        fontSize: type.caption.fontSize,
        color: color.inkSoft,
      });
      expect(style.backgroundColor).toBeUndefined();
      expect(renderer.root.findAllByType(Image)).toHaveLength(0);
      for (const row of radios(renderer)) {
        expect(
          StyleSheet.flatten(row.props.style).minHeight,
        ).toBeGreaterThanOrEqual(44);
      }
    };
    const expectHeaderTarget = (label: string) => {
      const control = pressable(renderer, label)[0]!;
      expect(StyleSheet.flatten(control.props.style)).toMatchObject({
        width: 44,
        height: 44,
      });
    };
    await act(async () =>
      pressable(renderer, 'Delete account')[0]!.props.onPress(),
    );
    expectContext('why');
    expectHeaderTarget('Close and keep my account');
    expect(
      StyleSheet.flatten(pressable(renderer, 'Skip the survey')[0]!.props.style)
        .minHeight,
    ).toBeGreaterThanOrEqual(44);
    await act(async () => radios(renderer)[0]!.props.onPress());
    await act(async () => sheetButton(renderer, 'Next').props.onPress());
    expectContext('kept');
    expectHeaderTarget('Back to the previous question');
    expectHeaderTarget('Close and keep my account');
    await act(async () =>
      pressable(renderer, 'Skip this question')[0]!.props.onPress(),
    );
    expectContext('review');
    expectHeaderTarget('Close account deletion confirmation');
    expect(allText(renderer)).toContain(
      "Free ratings you've already used stay used",
    );
    expect(allText(renderer)).toContain(
      'does not cancel a subscription or issue a',
    );
    expect(mockRequestAccountDeletion).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('skips custom entrance and page animations under reduced motion without skipping survey choices', async () => {
    mockReducedMotion = true;
    const renderer = renderScreen();
    const timing = jest.spyOn(Animated, 'timing');
    const layout = jest.spyOn(LayoutAnimation, 'configureNext');
    await act(async () =>
      pressable(renderer, 'Delete account')[0]!.props.onPress(),
    );
    await act(async () => radios(renderer)[0]!.props.onPress());
    await act(async () => sheetButton(renderer, 'Next').props.onPress());
    expect(allText(renderer)).toContain('QUESTION 2 OF 2');
    await act(async () =>
      pressable(renderer, 'Back to the previous question')[0]!.props.onPress(),
    );
    expect(radios(renderer)[0]!.props.accessibilityState.selected).toBe(true);
    await act(async () =>
      pressable(renderer, 'Skip the survey')[0]!.props.onPress(),
    );
    expect(allText(renderer)).toContain('Delete your account?');
    expect(timing).not.toHaveBeenCalled();
    expect(layout).not.toHaveBeenCalled();
    expect(mockRequestAccountDeletion).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('shows account details with deletion as a quiet link, sheet closed', () => {
    const renderer = renderScreen();
    const copy = allText(renderer);
    expect(copy).toContain('Account details');
    expect(copy).toContain('Alex Chen');
    expect(copy).toContain('alex@example.com');
    expect(copy).toContain('Google');
    // The link is present but neither the survey nor the confirmation is
    // mounted yet.
    expect(pressable(renderer, 'Delete account').length).toBeGreaterThan(0);
    expect(copy).not.toContain("What's making you leave?");
    expect(copy).not.toContain('Delete your account?');
    act(() => renderer.unmount());
  });

  it('opens question 1 centered: Next needs an answer, Skip never does', async () => {
    const renderer = renderScreen();
    await act(async () => {
      pressable(renderer, 'Delete account')[0]!.props.onPress();
    });
    const copy = allText(renderer);
    expect(copy).toContain("What's making you leave?");
    expect(copy).toContain('QUESTION 1 OF 2');
    expect(copy).not.toContain('Delete your account?');
    // Every reason is a radio in the pinned order, "Something else" last.
    expect(radios(renderer).map(node => node.props.accessibilityLabel)).toEqual(
      [
        "I don't use it enough",
        "It hasn't improved my game",
        'The technique reads felt off',
        'Bugs, crashes, or camera trouble',
        "It's too expensive",
        'Privacy or data concerns',
        'Something else',
      ],
    );
    // Nothing chosen → Next is disabled; Skip is always live; no Back yet.
    expect(sheetButton(renderer, 'Next').props.disabled).toBe(true);
    expect(pressable(renderer, 'Skip the survey').length).toBeGreaterThan(0);
    expect(pressable(renderer, 'Back to the previous question')).toHaveLength(
      0,
    );

    await act(async () => {
      radios(renderer)[4]!.props.onPress();
    });
    expect(sheetButton(renderer, 'Next').props.disabled).toBe(false);
    act(() => renderer.unmount());
  });

  it('question 2 asks what would have kept them, Back keeps the first answer', async () => {
    const renderer = renderScreen();
    await act(async () => {
      pressable(renderer, 'Delete account')[0]!.props.onPress();
    });
    await act(async () => {
      pressable(renderer, "It's too expensive")[0]!.props.onPress();
    });
    await act(async () => {
      sheetButton(renderer, 'Next').props.onPress();
    });
    const copy = allText(renderer);
    expect(copy).toContain('What would have kept you?');
    expect(copy).toContain('QUESTION 2 OF 2');
    expect(radios(renderer).map(node => node.props.accessibilityLabel)).toEqual(
      [
        'More accurate technique reads',
        'A lower price or a free tier',
        'More drills and coaching guidance',
        'Fewer bugs and smoother capture',
        "Nothing — I've found another app or a coach",
        "Nothing — I just don't need it anymore",
      ],
    );
    // Only the second page carries the comment field.
    expect(renderer.root.findByType(TextInput).props.maxLength).toBe(500);
    expect(sheetButton(renderer, 'Continue').props.disabled).toBe(true);
    expect(pressable(renderer, 'Skip this question').length).toBeGreaterThan(0);

    await act(async () => {
      pressable(renderer, 'Back to the previous question')[0]!.props.onPress();
    });
    expect(allText(renderer)).toContain("What's making you leave?");
    const expensive = radios(renderer).find(
      node => node.props.accessibilityLabel === "It's too expensive",
    );
    expect(expensive?.props.accessibilityState).toEqual({ selected: true });
    expect(sheetButton(renderer, 'Next').props.disabled).toBe(false);
    act(() => renderer.unmount());
  });

  it('sends both answers and the comment with the step-1 request', async () => {
    mockRequestAccountDeletion.mockResolvedValue({
      challenge: 'challenge-1',
      expiresAt: '2026-08-31T00:00:00.000Z',
    });
    const renderer = renderScreen();
    await act(async () => {
      pressable(renderer, 'Delete account')[0]!.props.onPress();
    });
    await act(async () => {
      pressable(renderer, "It's too expensive")[0]!.props.onPress();
    });
    await act(async () => {
      sheetButton(renderer, 'Next').props.onPress();
    });
    await act(async () => {
      pressable(renderer, 'A lower price or a free tier')[0]!.props.onPress();
    });
    await act(async () => {
      renderer.root
        .findByType(TextInput)
        .props.onChangeText('  $60 a year is steep for a rec player.  ');
    });
    expect(allText(renderer)).toContain('/500');

    await act(async () => {
      sheetButton(renderer, 'Continue').props.onPress();
    });
    // The survey hands off to the unchanged two-step confirmation.
    expect(allText(renderer)).toContain('Delete your account?');
    expect(mockRequestAccountDeletion).not.toHaveBeenCalled();

    await act(async () => {
      sheetButton(renderer, 'Continue to delete').props.onPress();
    });
    expect(mockRequestAccountDeletion).toHaveBeenCalledWith(apiSession, {
      reason: 'too_expensive',
      wanted: 'price',
      details: '$60 a year is steep for a rec player.',
      platform: 'ios',
      appVersion: '1.0',
    });
    act(() => renderer.unmount());
  });

  it('a comment alone answers question 2', async () => {
    mockRequestAccountDeletion.mockResolvedValue({
      challenge: 'challenge-1',
      expiresAt: '2026-08-31T00:00:00.000Z',
    });
    const renderer = renderScreen();
    await act(async () => {
      pressable(renderer, 'Delete account')[0]!.props.onPress();
    });
    await act(async () => {
      pressable(renderer, 'Something else')[0]!.props.onPress();
    });
    await act(async () => {
      sheetButton(renderer, 'Next').props.onPress();
    });
    await act(async () => {
      renderer.root.findByType(TextInput).props.onChangeText('Moving abroad');
    });
    // Words alone are an answer — the button must not stay dead.
    expect(sheetButton(renderer, 'Continue').props.disabled).toBe(false);
    await act(async () => {
      sheetButton(renderer, 'Continue').props.onPress();
    });
    await act(async () => {
      sheetButton(renderer, 'Continue to delete').props.onPress();
    });
    expect(mockRequestAccountDeletion).toHaveBeenCalledWith(
      apiSession,
      expect.objectContaining({
        reason: 'other',
        wanted: null,
        details: 'Moving abroad',
      }),
    );
    act(() => renderer.unmount());
  });

  it('skipping question 2 still sends question 1', async () => {
    mockRequestAccountDeletion.mockResolvedValue({
      challenge: 'challenge-1',
      expiresAt: '2026-08-31T00:00:00.000Z',
    });
    const renderer = renderScreen();
    await act(async () => {
      pressable(renderer, 'Delete account')[0]!.props.onPress();
    });
    await act(async () => {
      pressable(renderer, 'Privacy or data concerns')[0]!.props.onPress();
    });
    await act(async () => {
      sheetButton(renderer, 'Next').props.onPress();
    });
    // Half-filled page 2 is discarded by its Skip — skipping means skipping.
    await act(async () => {
      renderer.root.findByType(TextInput).props.onChangeText('draft…');
    });
    await act(async () => {
      pressable(renderer, 'Skip this question')[0]!.props.onPress();
    });
    expect(allText(renderer)).toContain('Delete your account?');
    await act(async () => {
      sheetButton(renderer, 'Continue to delete').props.onPress();
    });
    expect(mockRequestAccountDeletion).toHaveBeenCalledWith(
      apiSession,
      expect.objectContaining({
        reason: 'privacy',
        wanted: null,
        details: null,
      }),
    );
    act(() => renderer.unmount());
  });

  it('Skip on question 1 reaches the confirmation and sends no survey at all', async () => {
    mockRequestAccountDeletion.mockResolvedValue({
      challenge: 'challenge-1',
      expiresAt: '2026-08-31T00:00:00.000Z',
    });
    const renderer = renderScreen();
    await act(async () => {
      pressable(renderer, 'Delete account')[0]!.props.onPress();
    });
    // Even a picked reason is discarded by Skip — skipping means skipping.
    await act(async () => {
      pressable(renderer, 'Privacy or data concerns')[0]!.props.onPress();
    });
    await act(async () => {
      pressable(renderer, 'Skip the survey')[0]!.props.onPress();
    });
    expect(allText(renderer)).toContain('Delete your account?');
    expect(allText(renderer)).not.toContain('QUESTION');
    await act(async () => {
      sheetButton(renderer, 'Continue to delete').props.onPress();
    });
    expect(mockRequestAccountDeletion).toHaveBeenCalledWith(apiSession, null);
    act(() => renderer.unmount());
  });

  it('closing the survey keeps the account and resets it for next time', async () => {
    const renderer = renderScreen();
    await act(async () => {
      pressable(renderer, 'Delete account')[0]!.props.onPress();
    });
    await act(async () => {
      pressable(renderer, "I don't use it enough")[0]!.props.onPress();
    });
    await act(async () => {
      sheetButton(renderer, 'Next').props.onPress();
    });
    await act(async () => {
      pressable(renderer, 'Close and keep my account')[0]!.props.onPress();
    });
    expect(allText(renderer)).not.toContain('What would have kept you?');
    expect(mockRequestAccountDeletion).not.toHaveBeenCalled();

    await act(async () => {
      pressable(renderer, 'Delete account')[0]!.props.onPress();
    });
    // Back at question 1, fresh: no reason carried over.
    expect(allText(renderer)).toContain("What's making you leave?");
    expect(sheetButton(renderer, 'Next').props.disabled).toBe(true);
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
      await act(async () => {
        pressable(renderer, 'Skip the survey')[0]!.props.onPress();
      });
      expect(allText(renderer)).toContain('Delete your account?');

      await act(async () => {
        sheetButton(renderer, 'Continue to delete').props.onPress();
      });
      expect(mockRequestAccountDeletion).toHaveBeenCalledTimes(1);
      expect(mockRequestAccountDeletion).toHaveBeenCalledWith(apiSession, null);

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
        apiSession,
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
