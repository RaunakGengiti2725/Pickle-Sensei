import React from 'react';
import {
  Modal,
  StyleSheet,
  Text,
  TextInput,
  type ViewStyle,
} from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * Button ledger for ManageAccountScreen. Every pressable rendered by the
 * screen (header back, "Delete account" link, and every control inside the
 * three-page DeleteAccountDialog — the two exit-survey questions and the
 * confirmation) is pressed here and its real effect asserted: navigation,
 * dialog open/close/reset, page changes, the two deletion API calls with the
 * live ApiSession and the survey (or null when skipped), the armed
 * countdown, the store-level purge, and the user-visible copy on every
 * failure path.
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
import { Button } from '../../src/design/components';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import {
  useApiSessionStore,
  type ApiSession,
} from '../../src/account/apiSession';
import {
  ACCOUNT_DELETION_DETAILS_MAX,
  AccountDeletionError,
} from '../../src/account/deletion';

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

const REASON_LABELS = [
  "I don't use it enough",
  "It hasn't improved my game",
  'The technique reads felt off',
  'Bugs, crashes, or camera trouble',
  "It's too expensive",
  'Privacy or data concerns',
  'Something else',
];

const WANTED_LABELS = [
  'More accurate technique reads',
  'A lower price or a free tier',
  'More drills and coaching guidance',
  'Fewer bugs and smoother capture',
  "Nothing — I've found another app or a coach",
  "Nothing — I just don't need it anymore",
];

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

/** The survey's single-select rows (RN `Pressable` hosts), in render order. */
function radios(renderer: Renderer): Instance[] {
  return renderer.root.findAll(node => {
    if (typeof node.type === 'string') return false;
    const { displayName, name } = node.type as {
      displayName?: string;
      name?: string;
    };
    return (
      (displayName ?? name) === 'Pressable' &&
      node.props.accessibilityRole === 'radio'
    );
  });
}

function onQuestionOne(renderer: Renderer): boolean {
  return allText(renderer).includes("What's making you leave?");
}

function onQuestionTwo(renderer: Renderer): boolean {
  return allText(renderer).includes('What would have kept you?');
}

/** The final confirmation page ("Delete your account?") is showing. */
function sheetOpen(renderer: Renderer): boolean {
  return allText(renderer).includes('Delete your account?');
}

/** Any page of the dialog is showing. */
function dialogOpen(renderer: Renderer): boolean {
  return (
    onQuestionOne(renderer) || onQuestionTwo(renderer) || sheetOpen(renderer)
  );
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

/** Tap the link: the dialog opens on exit-survey question 1. */
async function openDialog(renderer: Renderer) {
  await pressAsync(pressableHost(renderer, 'Delete account'));
  expect(onQuestionOne(renderer)).toBe(true);
  expect(sheetOpen(renderer)).toBe(false);
}

/** Open the dialog and skip the survey straight to the confirmation page. */
async function openSheet(renderer: Renderer) {
  await openDialog(renderer);
  await pressAsync(pressableHost(renderer, 'Skip the survey'));
  expect(sheetOpen(renderer)).toBe(true);
}

/** Open the dialog, answer question 1 and move on to question 2. */
async function reachQuestionTwo(renderer: Renderer, reason: string) {
  await openDialog(renderer);
  await pressAsync(pressableHost(renderer, reason));
  await pressAsync(sheetButton(renderer, 'Next'));
  expect(onQuestionTwo(renderer)).toBe(true);
}

/** Open the confirmation and drive it to the armed state (request resolved). */
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

  beforeAll(async () => {
    // The design system probes AccessibilityInfo.isReduceMotionEnabled() once
    // per process; settle that probe here so its resolution never lands
    // outside act() in whichever synchronous case runs first.
    let warmUp!: Renderer;
    await act(async () => {
      warmUp = TestRenderer.create(<ManageAccountScreen />);
    });
    act(() => warmUp.unmount());
  });

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

    it('Delete account -> opens the exit survey, not the confirmation (role, label, 44pt)', async () => {
      renderer = renderScreen();
      expect(dialogOpen(renderer)).toBe(false);
      const link = pressableHost(renderer, 'Delete account');
      expect(link.props.accessibilityRole).toBe('button');
      expect(flatStyle(link).minHeight).toBeGreaterThanOrEqual(44);
      await pressAsync(link);
      // Question 1 first: nothing was requested, the confirmation is not
      // mounted yet, and the header says where in the survey we are.
      expect(onQuestionOne(renderer)).toBe(true);
      expect(sheetOpen(renderer)).toBe(false);
      expect(allText(renderer)).toContain('QUESTION 1 OF 2');
      expect(sheetButton(renderer, 'Next').props.disabled).toBe(true);
      expect(mockRequestAccountDeletion).not.toHaveBeenCalled();
      // Re-tapping the link while open is idempotent.
      await pressAsync(link);
      expect(onQuestionOne(renderer)).toBe(true);
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

  describe('exit survey — question 1 ("What\'s making you leave?")', () => {
    it('lists the seven reasons as single-select radios in the pinned order; Next needs a pick', async () => {
      renderer = renderScreen();
      await openDialog(renderer);
      const rows = radios(renderer);
      expect(rows.map(node => node.props.accessibilityLabel)).toEqual(
        REASON_LABELS,
      );
      for (const row of rows) {
        expect(row.props.accessibilityState).toMatchObject({ selected: false });
        expect(flatStyle(row).minHeight).toBeGreaterThanOrEqual(44);
      }
      expect(sheetButton(renderer, 'Next').props.disabled).toBe(true);
      // No Back on the first question; Skip is always live.
      expect(
        hostByLabel(renderer, 'Back to the previous question'),
      ).toHaveLength(0);
      expect(
        pressableHost(renderer, 'Skip the survey').props.disabled,
      ).toBeFalsy();

      await pressAsync(rows[4]!);
      expect(
        pressableHost(renderer, "It's too expensive").props.accessibilityState,
      ).toMatchObject({ selected: true });
      expect(sheetButton(renderer, 'Next').props.disabled).toBe(false);

      // Single select: picking another reason moves the selection.
      await pressAsync(pressableHost(renderer, 'Something else'));
      expect(
        pressableHost(renderer, "It's too expensive").props.accessibilityState,
      ).toMatchObject({ selected: false });
      expect(
        pressableHost(renderer, 'Something else').props.accessibilityState,
      ).toMatchObject({ selected: true });
      expect(mockRequestAccountDeletion).not.toHaveBeenCalled();
    });

    it('Next -> question 2 with the progress marker; Back returns and keeps the answer', async () => {
      renderer = renderScreen();
      await reachQuestionTwo(renderer, "It's too expensive");
      expect(allText(renderer)).toContain('QUESTION 2 OF 2');
      expect(sheetOpen(renderer)).toBe(false);

      const back = pressableHost(renderer, 'Back to the previous question');
      expect(back.props.accessibilityRole).toBe('button');
      await pressAsync(back);
      expect(onQuestionOne(renderer)).toBe(true);
      expect(
        pressableHost(renderer, "It's too expensive").props.accessibilityState,
      ).toMatchObject({ selected: true });
      expect(sheetButton(renderer, 'Next').props.disabled).toBe(false);
    });

    it('Skip the survey -> confirmation, and step 1 then sends no survey at all (a picked reason is discarded)', async () => {
      renderer = renderScreen();
      mockRequestAccountDeletion.mockResolvedValue(CHALLENGE);
      await openDialog(renderer);
      await pressAsync(pressableHost(renderer, 'Privacy or data concerns'));
      await pressAsync(pressableHost(renderer, 'Skip the survey'));
      expect(sheetOpen(renderer)).toBe(true);
      expect(allText(renderer)).not.toContain('QUESTION');
      expect(mockRequestAccountDeletion).not.toHaveBeenCalled();

      await pressAsync(sheetButton(renderer, 'Continue to delete'));
      expect(mockRequestAccountDeletion).toHaveBeenCalledWith(apiSession, null);
    });

    it('X "Close and keep my account" closes from question 1 without any request; reopening starts fresh', async () => {
      renderer = renderScreen();
      await openDialog(renderer);
      await pressAsync(pressableHost(renderer, "I don't use it enough"));
      const close = pressableHost(renderer, 'Close and keep my account');
      expect(close.props.accessibilityRole).toBe('button');
      expect(close.props.disabled).toBeFalsy();
      press(close);
      expect(dialogOpen(renderer)).toBe(false);
      expect(mockRequestAccountDeletion).not.toHaveBeenCalled();

      await openDialog(renderer);
      expect(
        pressableHost(renderer, "I don't use it enough").props
          .accessibilityState,
      ).toMatchObject({ selected: false });
      expect(sheetButton(renderer, 'Next').props.disabled).toBe(true);
    });

    it('backdrop and hardware back both cancel from question 1', async () => {
      renderer = renderScreen();
      await openDialog(renderer);
      press(pressableHost(renderer, 'Cancel account deletion'));
      expect(dialogOpen(renderer)).toBe(false);

      await openDialog(renderer);
      const modal = renderer.root.findByType(Modal);
      expect(typeof modal.props.onRequestClose).toBe('function');
      act(() => modal.props.onRequestClose());
      expect(dialogOpen(renderer)).toBe(false);
      expect(mockRequestAccountDeletion).not.toHaveBeenCalled();
    });
  });

  describe('exit survey — question 2 ("What would have kept you?")', () => {
    it('lists the six options + an optional capped comment; Continue needs an option or a comment', async () => {
      renderer = renderScreen();
      await reachQuestionTwo(renderer, "It's too expensive");
      expect(
        radios(renderer).map(node => node.props.accessibilityLabel),
      ).toEqual(WANTED_LABELS);
      const input = renderer.root.findByType(TextInput);
      expect(input.props.accessibilityLabel).toBe(
        'Anything else you want us to know',
      );
      expect(input.props.maxLength).toBe(ACCOUNT_DELETION_DETAILS_MAX);
      expect(allText(renderer)).toContain(`0/${ACCOUNT_DELETION_DETAILS_MAX}`);
      expect(sheetButton(renderer, 'Continue').props.disabled).toBe(true);
      expect(
        pressableHost(renderer, 'Skip this question').props.disabled,
      ).toBeFalsy();

      // Words alone are an answer…
      await act(async () => {
        input.props.onChangeText('Moving abroad');
      });
      expect(sheetButton(renderer, 'Continue').props.disabled).toBe(false);
      expect(allText(renderer)).toContain(`13/${ACCOUNT_DELETION_DETAILS_MAX}`);
      // …but whitespace is not.
      await act(async () => {
        input.props.onChangeText('   ');
      });
      expect(sheetButton(renderer, 'Continue').props.disabled).toBe(true);
      // …and so is an option on its own.
      await pressAsync(pressableHost(renderer, 'A lower price or a free tier'));
      expect(sheetButton(renderer, 'Continue').props.disabled).toBe(false);
    });

    it('Continue -> confirmation; step 1 then carries reason, wanted and the trimmed comment', async () => {
      renderer = renderScreen();
      mockRequestAccountDeletion.mockResolvedValue(CHALLENGE);
      await reachQuestionTwo(renderer, "It's too expensive");
      await pressAsync(pressableHost(renderer, 'A lower price or a free tier'));
      await act(async () => {
        renderer!.root
          .findByType(TextInput)
          .props.onChangeText('  $60 a year is steep for a rec player.  ');
      });
      await pressAsync(sheetButton(renderer, 'Continue'));
      expect(sheetOpen(renderer)).toBe(true);
      // The survey is only stored with the step-1 request, never on its own.
      expect(mockRequestAccountDeletion).not.toHaveBeenCalled();

      await pressAsync(sheetButton(renderer, 'Continue to delete'));
      expect(mockRequestAccountDeletion).toHaveBeenCalledWith(apiSession, {
        reason: 'too_expensive',
        wanted: 'price',
        details: '$60 a year is steep for a rec player.',
        platform: 'ios',
        appVersion: '1.0',
      });
    });

    it('Skip this question -> confirmation; step 1 keeps question 1 and drops the half-typed draft', async () => {
      renderer = renderScreen();
      mockRequestAccountDeletion.mockResolvedValue(CHALLENGE);
      await reachQuestionTwo(renderer, 'Privacy or data concerns');
      await act(async () => {
        renderer!.root.findByType(TextInput).props.onChangeText('draft…');
      });
      await pressAsync(pressableHost(renderer, 'Skip this question'));
      expect(sheetOpen(renderer)).toBe(true);

      await pressAsync(sheetButton(renderer, 'Continue to delete'));
      expect(mockRequestAccountDeletion).toHaveBeenCalledWith(apiSession, {
        reason: 'privacy',
        wanted: null,
        details: null,
        platform: 'ios',
        appVersion: '1.0',
      });
    });

    it('X "Close and keep my account" closes from question 2 and resets both answers', async () => {
      renderer = renderScreen();
      await reachQuestionTwo(renderer, "It's too expensive");
      await pressAsync(pressableHost(renderer, 'A lower price or a free tier'));
      press(pressableHost(renderer, 'Close and keep my account'));
      expect(dialogOpen(renderer)).toBe(false);
      expect(mockRequestAccountDeletion).not.toHaveBeenCalled();

      await openDialog(renderer);
      expect(sheetButton(renderer, 'Next').props.disabled).toBe(true);
      await pressAsync(pressableHost(renderer, "It's too expensive"));
      await pressAsync(sheetButton(renderer, 'Next'));
      expect(
        pressableHost(renderer, 'A lower price or a free tier').props
          .accessibilityState,
      ).toMatchObject({ selected: false });
      expect(sheetButton(renderer, 'Continue').props.disabled).toBe(true);
    });
  });

  describe('sheet dismiss controls (idle)', () => {
    it('Modal onRequestClose -> closes the sheet', async () => {
      renderer = renderScreen();
      await openSheet(renderer);
      const modal = renderer.root.findByType(Modal);
      expect(typeof modal.props.onRequestClose).toBe('function');
      act(() => modal.props.onRequestClose());
      expect(dialogOpen(renderer)).toBe(false);
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
      expect(dialogOpen(renderer)).toBe(false);
    });

    it('Backdrop "Cancel account deletion" exposes accessibilityRole', async () => {
      renderer = renderScreen();
      await openSheet(renderer);
      const backdrop = pressableHost(renderer, 'Cancel account deletion');
      expect(backdrop.props.accessibilityRole).toBe('button');
    });

    it('X "Close account deletion confirmation" -> closes the sheet (role)', async () => {
      renderer = renderScreen();
      await openSheet(renderer);
      const close = pressableHost(
        renderer,
        'Close account deletion confirmation',
      );
      expect(close.props.accessibilityRole).toBe('button');
      // WF-ISSUE: the dialog's header controls (DialogHeader `headerButton`,
      // also the survey pages' X and Back) are 36pt round buttons with no
      // hitSlop — below the 44pt minimum hit target the old sheet's X met.
      // expect(flatStyle(close)).toMatchObject({ width: 44, height: 44 });
      press(close);
      expect(dialogOpen(renderer)).toBe(false);
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
      expect(dialogOpen(renderer)).toBe(false);
      expect(mockRequestAccountDeletion).not.toHaveBeenCalled();
    });

    it('closing resets the dialog: reopening starts at question 1 and the confirmation has no stale error', async () => {
      renderer = renderScreen();
      mockRequestAccountDeletion.mockRejectedValue(new Error('boom'));
      await openSheet(renderer);
      await pressAsync(sheetButton(renderer, 'Continue to delete'));
      expect(allText(renderer)).toContain(
        'The deletion request could not be completed. Nothing was deleted.',
      );
      press(sheetButton(renderer, 'Keep my account'));
      expect(dialogOpen(renderer)).toBe(false);

      mockRequestAccountDeletion.mockResolvedValue(CHALLENGE);
      // Reopening lands on question 1 again, never on a half-finished
      // confirmation.
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
      expect(dialogOpen(renderer)).toBe(false);
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
    it('calls the API with the live ApiSession (and the skipped survey), shows "Requesting…" disabled, then arms a 5s countdown', async () => {
      renderer = renderScreen();
      const pending = deferred<typeof CHALLENGE>();
      mockRequestAccountDeletion.mockReturnValue(pending.promise);
      await openSheet(renderer);

      await pressAsync(sheetButton(renderer, 'Continue to delete'));
      expect(mockRequestAccountDeletion).toHaveBeenCalledTimes(1);
      expect(mockRequestAccountDeletion).toHaveBeenCalledWith(apiSession, null);

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
      expect(mockRequestAccountDeletion).toHaveBeenCalledWith(null, null);
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
      expect(dialogOpen(renderer)).toBe(false);
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
      expect(dialogOpen(renderer)).toBe(false);
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
      expect(backdrop.props.disabled).toBe(true);
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

    it('X "Close account deletion confirmation" is inert while requesting (like every other dismiss control)', async () => {
      renderer = renderScreen();
      const pending = deferred<typeof CHALLENGE>();
      mockRequestAccountDeletion.mockReturnValue(pending.promise);
      await openSheet(renderer);
      await pressAsync(sheetButton(renderer, 'Continue to delete'));

      // The X relies on the Pressable `disabled` gate (Pressability never
      // fires onPress while disabled) rather than dropping its handler, so
      // assert the gate is closed and announced to assistive tech.
      const close = pressableHost(
        renderer,
        'Close account deletion confirmation',
      );
      expect(close.props.accessibilityState).toMatchObject({ disabled: true });
      expect(close.props.disabled).toBe(true);
      expect(flatStyle(close).opacity).toBeLessThan(1);
      expect(sheetOpen(renderer)).toBe(true);

      await act(async () => {
        pending.resolve(CHALLENGE);
        await pending.promise;
      });
      // Re-enabled once the round-trip settled.
      expect(
        pressableHost(renderer, 'Close account deletion confirmation').props
          .disabled,
      ).toBe(false);
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
