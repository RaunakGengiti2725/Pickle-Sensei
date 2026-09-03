import React from 'react';
import { Alert, Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * Button ledger for OnboardingScreen: every pressable in the file is pressed
 * here and its observable effect asserted (step change, selection state,
 * store call with the exact payload, Alert wiring, busy/disabled guards and
 * the failure path of the async finish handlers).
 *
 * Step one's header control differs by mode: in-account it is "Leave setup"
 * (sign-out alert); pre-auth it is a plain "Back" to Welcome (`onBack`). There
 * is deliberately NO skip-to-sign-in in either mode (product decision
 * 2026-09-01: the questionnaire is required).
 */

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  initialWindowMetrics: {
    frame: { x: 0, y: 0, width: 390, height: 844 },
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
  },
}));

const mockCompleteOnboarding = jest.fn<Promise<void>, [unknown]>(() =>
  Promise.resolve(),
);
const mockCompletePreAuthOnboarding = jest.fn<Promise<boolean>, [unknown]>(() =>
  Promise.resolve(true),
);
// A real zustand store so the screen re-renders when the mocked async
// actions flip onboardingBusy / onboardingError exactly like appStore does.
jest.mock('../../src/state/appStore', () => {
  const { create } = jest.requireActual<typeof import('zustand')>('zustand');
  const { focusForGoal } = jest.requireActual<
    typeof import('../../src/state/profile')
  >('../../src/state/profile');
  const useAppStore = create(() => ({
    completeOnboarding: (profile: unknown) => mockCompleteOnboarding(profile),
    completePreAuthOnboarding: (profile: unknown) =>
      mockCompletePreAuthOnboarding(profile),
    onboardingBusy: false,
    onboardingError: null as string | null,
  }));
  return { focusForGoal, useAppStore };
});

const mockSignOut = jest.fn(() => Promise.resolve());
jest.mock('../../src/auth/authStore', () => {
  const state = { signOut: () => mockSignOut() };
  return {
    useAuthStore: (selector: (s: typeof state) => unknown) => selector(state),
  };
});

const mockCompleteNotificationOnboarding = jest.fn<
  Promise<boolean>,
  ['enable' | 'not_now']
>(() => Promise.resolve(true));
jest.mock('../../src/notifications/notificationStore', () => {
  const state = {
    completeOnboardingStep: (choice: 'enable' | 'not_now') =>
      mockCompleteNotificationOnboarding(choice),
  };
  return {
    useNotificationStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});

import { useAppStore } from '../../src/state/appStore';
import { OnboardingScreen } from '../../src/screens/OnboardingScreen';

type Renderer = TestRenderer.ReactTestRenderer;
type AlertButton = { text?: string; style?: string; onPress?: () => void };

const STEP_TITLES = {
  name: 'What should we call you?',
  gender: 'How do you identify?',
  level: 'Where is your game today?',
  handedness: 'Which side is home?',
  goal: 'What do you want to own?',
  problem: 'What breaks down most?',
  reveal: 'One focus.',
  notifications: 'Stay match-ready.',
} as const;

const CHOICES = {
  gender: ['Female', 'Male', 'Non-binary', 'Prefer not to say'],
  level: ['Brand new', '2.5', '3.0', '3.5', '4.0', '4.5', '5.0+'],
  handedness: ['Right-handed', 'Left-handed'],
  goal: [
    'Dinks',
    'Drives',
    'Third-shot drops',
    'Serve',
    'Volleys',
    'Footwork',
    'All-around',
  ],
  problem: [
    'Consistency',
    'Control',
    'Power',
    'Contact',
    'Footwork',
    'Placement',
    'Not sure',
  ],
} as const;

function renderScreen(props?: React.ComponentProps<typeof OnboardingScreen>) {
  let renderer!: Renderer;
  act(() => {
    renderer = TestRenderer.create(<OnboardingScreen {...props} />);
  });
  return renderer;
}

function allText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join('');
}

/**
 * The RN Pressable rendered by PressableScale (after it resolved its a11y
 * defaults). PressableScale itself never receives onPressIn, so that prop
 * singles out the inner Pressable; Pressable is a memo, so findAllByType
 * cannot be used.
 */
function findPressables(renderer: Renderer, label: string) {
  return renderer.root.findAll(
    node =>
      node.props?.accessibilityLabel === label &&
      typeof node.props?.onPress === 'function' &&
      typeof node.props?.onPressIn === 'function',
  );
}

function hostPressable(renderer: Renderer, label: string) {
  const nodes = findPressables(renderer, label);
  expect(nodes).toHaveLength(1);
  return nodes[0]!;
}

function hasPressable(renderer: Renderer, label: string) {
  return findPressables(renderer, label).length > 0;
}

function press(renderer: Renderer, label: string) {
  const node = hostPressable(renderer, label);
  expect(node.props.disabled).toBeFalsy();
  act(() => {
    node.props.onPress();
  });
}

function typeName(renderer: Renderer, text: string) {
  act(() => renderer.root.findByType(TextInput).props.onChangeText(text));
}

function stepNow(renderer: Renderer) {
  return renderer.root.findByProps({ accessibilityRole: 'progressbar' }).props
    .accessibilityValue.now as number;
}

/** name → gender → level → handedness → goal → problem → reveal. */
function walkToReveal(renderer: Renderer) {
  typeName(renderer, ' Dana ');
  press(renderer, 'Continue');
  press(renderer, 'Female');
  press(renderer, 'Continue');
  press(renderer, '3.5');
  press(renderer, 'Continue');
  press(renderer, 'Right-handed');
  press(renderer, 'Continue');
  press(renderer, 'Third-shot drops');
  press(renderer, 'Continue');
  press(renderer, 'Control');
  press(renderer, 'Continue');
  expect(allText(renderer)).toContain(STEP_TITLES.reveal);
}

function walkToNotifications(renderer: Renderer) {
  walkToReveal(renderer);
  press(renderer, 'Continue');
  expect(allText(renderer)).toContain(STEP_TITLES.notifications);
}

const walkedProfile = {
  firstName: 'Dana',
  gender: 'female',
  skillLevel: '3.5',
  handedness: 'right',
  goal: 'drops',
  biggestProblem: 'control',
  focusCheckpoint: 'paddle_set',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

let alertSpy: jest.SpyInstance;

function alertButtons(call = 0): AlertButton[] {
  return (alertSpy.mock.calls[call]?.[2] ?? []) as AlertButton[];
}

describe('OnboardingScreen button ledger', () => {
  beforeEach(() => {
    mockCompleteOnboarding.mockReset();
    mockCompleteOnboarding.mockResolvedValue(undefined);
    mockCompletePreAuthOnboarding.mockReset();
    mockCompletePreAuthOnboarding.mockResolvedValue(true);
    mockCompleteNotificationOnboarding.mockReset();
    mockCompleteNotificationOnboarding.mockResolvedValue(true);
    mockSignOut.mockClear();
    act(() =>
      useAppStore.setState({ onboardingBusy: false, onboardingError: null }),
    );
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  describe('header: Leave setup (step 1 only)', () => {
    it('is a 44pt-class button with a hit slop, and Back is not offered on step 1', () => {
      const renderer = renderScreen();
      const leave = hostPressable(renderer, 'Leave setup');
      expect(leave.props.accessibilityRole).toBe('button');
      expect(leave.props.hitSlop).toBe(12);
      expect(leave.props.accessibilityHint).toBe(
        'Sign out and return to the sign-in screen',
      );
      expect(hasPressable(renderer, 'Back')).toBe(false);
      act(() => renderer.unmount());
    });

    it('account mode: confirms, then "Sign out" calls signOut and "Keep setting up" does nothing', () => {
      const renderer = renderScreen();
      press(renderer, 'Leave setup');

      expect(alertSpy).toHaveBeenCalledTimes(1);
      expect(alertSpy.mock.calls[0]?.[0]).toBe('Leave setup?');
      const buttons = alertButtons();
      expect(buttons.map(b => b.text)).toEqual(['Keep setting up', 'Sign out']);

      const keep = buttons.find(b => b.text === 'Keep setting up')!;
      expect(keep.style).toBe('cancel');
      act(() => keep.onPress?.());
      expect(mockSignOut).not.toHaveBeenCalled();
      expect(allText(renderer)).toContain(STEP_TITLES.name);

      const signOut = buttons.find(b => b.text === 'Sign out')!;
      expect(signOut.style).toBe('destructive');
      act(() => signOut.onPress?.());
      expect(mockSignOut).toHaveBeenCalledTimes(1);
      act(() => renderer.unmount());
    });

    // The pre-auth "Leave setup" → "Skip setup?" → "Skip to sign-in"
    // (onExitToSignIn) escape was removed 2026-09-01: pre-auth step one has
    // no "Leave setup" at all — its control is a plain Back to Welcome.
    it('preauth mode: step one has no Leave setup — a plain "Back" calls onBack once, with no alert and no sign-out', () => {
      const onBack = jest.fn();
      const onFinished = jest.fn();
      const renderer = renderScreen({
        mode: 'preauth',
        onFinished,
        onBack,
      });
      expect(hasPressable(renderer, 'Leave setup')).toBe(false);
      expect(allText(renderer)).not.toMatch(/skip/i);
      const back = hostPressable(renderer, 'Back');
      expect(back.props.accessibilityRole).toBe('button');
      expect(back.props.hitSlop).toBe(12);
      expect(back.props.accessibilityHint).toBe('Return to the welcome screen');

      press(renderer, 'Back');
      expect(onBack).toHaveBeenCalledTimes(1);
      expect(alertSpy).not.toHaveBeenCalled();
      expect(onFinished).not.toHaveBeenCalled();
      expect(mockSignOut).not.toHaveBeenCalled();
      expect(mockCompletePreAuthOnboarding).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    });

    it('preauth mode: past step one, Back returns to the previous question and never calls onBack', () => {
      const onBack = jest.fn();
      const renderer = renderScreen({
        mode: 'preauth',
        onFinished: jest.fn(),
        onBack,
      });
      typeName(renderer, 'Jo');
      press(renderer, 'Continue');
      expect(stepNow(renderer)).toBe(2);
      expect(hostPressable(renderer, 'Back').props.accessibilityHint).toBe(
        'Return to the previous question',
      );
      expect(allText(renderer)).not.toMatch(/skip/i);

      press(renderer, 'Back');
      expect(stepNow(renderer)).toBe(1);
      expect(onBack).not.toHaveBeenCalled();
      expect(renderer.root.findByType(TextInput).props.value).toBe('Jo');
      // Step one again: the Back control now points at Welcome.
      expect(hostPressable(renderer, 'Back').props.accessibilityHint).toBe(
        'Return to the welcome screen',
      );
      expect(hasPressable(renderer, 'Leave setup')).toBe(false);
      act(() => renderer.unmount());
    });
  });

  describe('header: Back (steps 2–8)', () => {
    it('returns one step and keeps earlier answers; on step 1 it yields to Leave setup', () => {
      const renderer = renderScreen();
      typeName(renderer, 'Jo');
      press(renderer, 'Continue');
      expect(stepNow(renderer)).toBe(2);

      const back = hostPressable(renderer, 'Back');
      expect(back.props.accessibilityRole).toBe('button');
      expect(back.props.hitSlop).toBe(12);
      expect(hasPressable(renderer, 'Leave setup')).toBe(false);

      press(renderer, 'Back');
      expect(stepNow(renderer)).toBe(1);
      expect(renderer.root.findByType(TextInput).props.value).toBe('Jo');
      expect(hasPressable(renderer, 'Back')).toBe(false);
      expect(hasPressable(renderer, 'Leave setup')).toBe(true);
      act(() => renderer.unmount());
    });

    it('walks back from notifications to the reveal and from the reveal to the last question with the selection intact', () => {
      const renderer = renderScreen();
      walkToNotifications(renderer);
      expect(stepNow(renderer)).toBe(8);

      press(renderer, 'Back');
      expect(stepNow(renderer)).toBe(7);
      expect(allText(renderer)).toContain(STEP_TITLES.reveal);

      press(renderer, 'Back');
      expect(stepNow(renderer)).toBe(6);
      expect(allText(renderer)).toContain(STEP_TITLES.problem);
      expect(
        hostPressable(renderer, 'Control').props.accessibilityState.selected,
      ).toBe(true);
      expect(hostPressable(renderer, 'Continue').props.disabled).toBe(false);
      act(() => renderer.unmount());
    });
  });

  describe('name step: First name input + Continue', () => {
    it('Continue stays disabled for empty/whitespace names and advances once a real name is typed', () => {
      const renderer = renderScreen();
      const input = renderer.root.findByType(TextInput);
      expect(input.props.accessibilityLabel).toBe('First name');

      const locked = hostPressable(renderer, 'Continue');
      expect(locked.props.accessibilityRole).toBe('button');
      expect(locked.props.disabled).toBe(true);
      expect(locked.props.accessibilityState.disabled).toBe(true);

      typeName(renderer, '   ');
      expect(hostPressable(renderer, 'Continue').props.disabled).toBe(true);

      typeName(renderer, ' Dana ');
      expect(renderer.root.findByType(TextInput).props.value).toBe(' Dana ');
      press(renderer, 'Continue');
      expect(stepNow(renderer)).toBe(2);
      expect(allText(renderer)).toContain(STEP_TITLES.gender);
      act(() => renderer.unmount());
    });

    it('keyboard Next (onSubmitEditing) mirrors Continue but never past an empty name', () => {
      const renderer = renderScreen();
      const input = renderer.root.findByType(TextInput);
      expect(input.props.returnKeyType).toBe('next');

      act(() => input.props.onSubmitEditing());
      expect(stepNow(renderer)).toBe(1);

      typeName(renderer, '  ');
      act(() => renderer.root.findByType(TextInput).props.onSubmitEditing());
      expect(stepNow(renderer)).toBe(1);

      typeName(renderer, 'Jo');
      act(() => renderer.root.findByType(TextInput).props.onSubmitEditing());
      expect(stepNow(renderer)).toBe(2);
      act(() => renderer.unmount());
    });
  });

  describe('choice steps: every ChoiceCard selects (no auto-advance) and unlocks Continue', () => {
    const steps = [
      { key: 'gender', title: STEP_TITLES.gender, choices: CHOICES.gender },
      { key: 'level', title: STEP_TITLES.level, choices: CHOICES.level },
      {
        key: 'handedness',
        title: STEP_TITLES.handedness,
        choices: CHOICES.handedness,
      },
      { key: 'goal', title: STEP_TITLES.goal, choices: CHOICES.goal },
      { key: 'problem', title: STEP_TITLES.problem, choices: CHOICES.problem },
    ] as const;

    it.each(steps)('$key', ({ title, choices }) => {
      const renderer = renderScreen();
      typeName(renderer, 'Dana');
      press(renderer, 'Continue');
      // Advance with the first choice of each earlier step until `title`.
      for (const earlier of steps) {
        if (earlier.title === title) break;
        press(renderer, earlier.choices[0]);
        press(renderer, 'Continue');
      }
      expect(allText(renderer)).toContain(title);
      expect(hostPressable(renderer, 'Continue').props.disabled).toBe(true);

      for (const label of choices) {
        const card = hostPressable(renderer, label);
        expect(card.props.accessibilityRole).toBe('radio');
        expect(card.props.accessibilityState.selected).toBe(false);
        press(renderer, label);
        // Selecting never auto-advances; the card shows selected; the
        // previously selected card is released.
        expect(allText(renderer)).toContain(title);
        for (const other of choices) {
          expect(
            hostPressable(renderer, other).props.accessibilityState.selected,
          ).toBe(other === label);
        }
        expect(hostPressable(renderer, 'Continue').props.disabled).toBe(false);
      }
      act(() => renderer.unmount());
    });

    it('every choice value reaches completeOnboarding, and the goal drives the reveal focus', async () => {
      const renderer = renderScreen();
      typeName(renderer, 'Sam');
      press(renderer, 'Continue');
      press(renderer, 'Non-binary');
      press(renderer, 'Continue');
      press(renderer, 'Brand new');
      press(renderer, 'Continue');
      press(renderer, 'Left-handed');
      press(renderer, 'Continue');
      press(renderer, 'Serve');
      press(renderer, 'Continue');
      press(renderer, 'Not sure');
      press(renderer, 'Continue');

      expect(allText(renderer)).toContain('Built for Sam.');
      expect(allText(renderer)).toContain('Sequencing');
      press(renderer, 'Continue');
      press(renderer, 'Not now');
      await act(async () => {});

      expect(mockCompleteOnboarding).toHaveBeenCalledWith({
        firstName: 'Sam',
        gender: 'nonbinary',
        skillLevel: 'Beginner',
        handedness: 'left',
        goal: 'serve',
        biggestProblem: 'not sure',
        focusCheckpoint: 'sequencing',
      });
      act(() => renderer.unmount());
    });
  });

  describe('reveal step: Continue', () => {
    it('moves to the notification step without touching any store', () => {
      const renderer = renderScreen();
      walkToReveal(renderer);
      expect(allText(renderer)).toContain('Built for Dana.');
      expect(allText(renderer)).toContain('Paddle Set');

      const cont = hostPressable(renderer, 'Continue');
      expect(cont.props.disabled).toBeFalsy();
      press(renderer, 'Continue');

      expect(stepNow(renderer)).toBe(8);
      expect(allText(renderer)).toContain(STEP_TITLES.notifications);
      expect(mockCompleteNotificationOnboarding).not.toHaveBeenCalled();
      expect(mockCompleteOnboarding).not.toHaveBeenCalled();
      expect(mockCompletePreAuthOnboarding).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    });
  });

  describe('notification step: Turn on reminders / Not now', () => {
    it('exposes both as buttons with descriptive labels', () => {
      const renderer = renderScreen();
      walkToNotifications(renderer);
      const enable = hostPressable(renderer, 'Turn on reminders');
      expect(enable.props.accessibilityRole).toBe('button');
      expect(enable.props.disabled).toBeFalsy();
      const notNow = hostPressable(renderer, 'Not now');
      expect(notNow.props.accessibilityRole).toBe('button');
      expect(notNow.props.accessibilityHint).toBe(
        'Finish setup without enabling reminders',
      );
      expect(notNow.props.disabled).toBeFalsy();
      act(() => renderer.unmount());
    });

    it('account mode: Turn on reminders → completeOnboardingStep("enable") then completeOnboarding(profile)', async () => {
      const renderer = renderScreen();
      walkToNotifications(renderer);
      press(renderer, 'Turn on reminders');
      await act(async () => {});

      expect(mockCompleteNotificationOnboarding).toHaveBeenCalledTimes(1);
      expect(mockCompleteNotificationOnboarding).toHaveBeenCalledWith('enable');
      expect(mockCompleteOnboarding).toHaveBeenCalledTimes(1);
      expect(mockCompleteOnboarding).toHaveBeenCalledWith(walkedProfile);
      expect(mockCompletePreAuthOnboarding).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    });

    it('account mode: Not now → completeOnboardingStep("not_now") then completeOnboarding(profile)', async () => {
      const renderer = renderScreen();
      walkToNotifications(renderer);
      press(renderer, 'Not now');
      await act(async () => {});

      expect(mockCompleteNotificationOnboarding).toHaveBeenCalledWith(
        'not_now',
      );
      expect(mockCompleteOnboarding).toHaveBeenCalledWith(walkedProfile);
      expect(mockCompletePreAuthOnboarding).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    });

    it('preauth mode: both buttons stash via completePreAuthOnboarding and hand off through onFinished', async () => {
      for (const label of ['Turn on reminders', 'Not now'] as const) {
        mockCompleteNotificationOnboarding.mockClear();
        mockCompletePreAuthOnboarding.mockClear();
        const onFinished = jest.fn();
        const renderer = renderScreen({
          mode: 'preauth',
          onFinished,
          onBack: jest.fn(),
        });
        walkToNotifications(renderer);
        press(renderer, label);
        await act(async () => {});

        expect(mockCompleteNotificationOnboarding).toHaveBeenCalledWith(
          label === 'Not now' ? 'not_now' : 'enable',
        );
        expect(mockCompletePreAuthOnboarding).toHaveBeenCalledWith(
          walkedProfile,
        );
        expect(mockCompleteOnboarding).not.toHaveBeenCalled();
        expect(onFinished).toHaveBeenCalledTimes(1);
        act(() => renderer.unmount());
      }
    });

    it('preauth mode: a denied permission still finishes with reminders off', async () => {
      mockCompleteNotificationOnboarding.mockResolvedValue(false);
      const onFinished = jest.fn();
      const renderer = renderScreen({
        mode: 'preauth',
        onFinished,
        onBack: jest.fn(),
      });
      walkToNotifications(renderer);
      press(renderer, 'Turn on reminders');
      await act(async () => {});
      expect(mockCompletePreAuthOnboarding).toHaveBeenCalledWith(walkedProfile);
      expect(onFinished).toHaveBeenCalledTimes(1);
      act(() => renderer.unmount());
    });

    it('preauth mode: a failed stash shows the store error, does not hand off, and re-enables both buttons', async () => {
      mockCompletePreAuthOnboarding.mockImplementation(async () => {
        useAppStore.setState({ onboardingBusy: true, onboardingError: null });
        await Promise.resolve();
        useAppStore.setState({
          onboardingBusy: false,
          onboardingError: 'Your answers could not be saved.',
        });
        return false;
      });
      const onFinished = jest.fn();
      const renderer = renderScreen({
        mode: 'preauth',
        onFinished,
        onBack: jest.fn(),
      });
      walkToNotifications(renderer);
      press(renderer, 'Not now');
      await act(async () => {});

      expect(onFinished).not.toHaveBeenCalled();
      expect(allText(renderer)).toContain('Your answers could not be saved.');
      expect(hostPressable(renderer, 'Turn on reminders').props.disabled).toBe(
        false,
      );
      expect(hostPressable(renderer, 'Not now').props.disabled).toBe(false);

      // Retry succeeds and hands off.
      mockCompletePreAuthOnboarding.mockResolvedValue(true);
      press(renderer, 'Not now');
      await act(async () => {});
      expect(mockCompletePreAuthOnboarding).toHaveBeenCalledTimes(2);
      expect(onFinished).toHaveBeenCalledTimes(1);
      act(() => renderer.unmount());
    });

    it('guards double taps: while pending both buttons disable, the label reads "Finishing setup…", and the second tap is ignored', async () => {
      const gate = deferred<boolean>();
      mockCompleteNotificationOnboarding.mockReturnValue(gate.promise);
      const renderer = renderScreen();
      walkToNotifications(renderer);

      const enable = hostPressable(renderer, 'Turn on reminders');
      act(() => enable.props.onPress());
      expect(mockCompleteNotificationOnboarding).toHaveBeenCalledTimes(1);

      // Each tap is its own discrete event: React has re-rendered by the
      // time the second one lands, so it hits the disabled, busy button.
      expect(hasPressable(renderer, 'Turn on reminders')).toBe(false);
      const busy = hostPressable(renderer, 'Finishing setup…');
      expect(busy.props.disabled).toBe(true);
      expect(busy.props.accessibilityState.disabled).toBe(true);
      act(() => busy.props.onPress());
      expect(hostPressable(renderer, 'Not now').props.disabled).toBe(true);
      act(() => hostPressable(renderer, 'Not now').props.onPress?.());
      expect(mockCompleteNotificationOnboarding).toHaveBeenCalledTimes(1);
      expect(mockCompleteOnboarding).not.toHaveBeenCalled();

      await act(async () => {
        gate.resolve(true);
      });
      expect(mockCompleteOnboarding).toHaveBeenCalledTimes(1);
      expect(mockCompleteOnboarding).toHaveBeenCalledWith(walkedProfile);
      act(() => renderer.unmount());
    });

    it('account mode failure: shows onboardingError copy, re-enables the buttons, and a retry saves without re-asking for permission', async () => {
      mockCompleteOnboarding.mockImplementationOnce(async () => {
        useAppStore.setState({ onboardingBusy: true, onboardingError: null });
        await Promise.resolve();
        useAppStore.setState({
          onboardingBusy: false,
          onboardingError:
            'Your coaching profile could not be securely saved. Check your connection and try again.',
        });
      });
      const renderer = renderScreen();
      walkToNotifications(renderer);
      press(renderer, 'Turn on reminders');
      await act(async () => {});

      expect(mockCompleteOnboarding).toHaveBeenCalledTimes(1);
      expect(allText(renderer)).toContain(
        'Your coaching profile could not be securely saved.',
      );
      const retry = hostPressable(renderer, 'Turn on reminders');
      expect(retry.props.disabled).toBe(false);
      expect(hostPressable(renderer, 'Not now').props.disabled).toBe(false);

      press(renderer, 'Turn on reminders');
      await act(async () => {});
      expect(mockCompleteOnboarding).toHaveBeenCalledTimes(2);
      // The notification choice was already recorded; the retry only saves.
      expect(mockCompleteNotificationOnboarding).toHaveBeenCalledTimes(1);
      act(() => renderer.unmount());
    });

    it('store busy flag from outside the screen disables both finish buttons', () => {
      const renderer = renderScreen();
      walkToNotifications(renderer);
      act(() => useAppStore.setState({ onboardingBusy: true }));
      expect(hostPressable(renderer, 'Finishing setup…').props.disabled).toBe(
        true,
      );
      expect(hostPressable(renderer, 'Not now').props.disabled).toBe(true);
      act(() => useAppStore.setState({ onboardingBusy: false }));
      expect(hostPressable(renderer, 'Turn on reminders').props.disabled).toBe(
        false,
      );
      act(() => renderer.unmount());
    });
  });
});
