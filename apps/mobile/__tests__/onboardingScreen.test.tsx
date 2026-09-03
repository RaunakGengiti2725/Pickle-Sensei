import React from 'react';
import { Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

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
jest.mock('../src/state/appStore', () => {
  const { focusForGoal } = jest.requireActual<
    typeof import('../src/state/profile')
  >('../src/state/profile');
  const state = {
    completeOnboarding: (profile: unknown) => mockCompleteOnboarding(profile),
    completePreAuthOnboarding: (profile: unknown) =>
      mockCompletePreAuthOnboarding(profile),
    onboardingBusy: false,
    onboardingError: null,
  };
  return {
    focusForGoal,
    useAppStore: (selector: (s: typeof state) => unknown) => selector(state),
  };
});

const mockSignOut = jest.fn();
jest.mock('../src/auth/authStore', () => {
  const state = { signOut: () => mockSignOut() };
  return {
    useAuthStore: (selector: (s: typeof state) => unknown) => selector(state),
  };
});

const mockCompleteNotificationOnboarding = jest.fn<
  Promise<boolean>,
  ['enable' | 'not_now']
>(() => Promise.resolve(true));
jest.mock('../src/notifications/notificationStore', () => {
  const state = {
    completeOnboardingStep: (choice: 'enable' | 'not_now') =>
      mockCompleteNotificationOnboarding(choice),
  };
  return {
    useNotificationStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});

import { OnboardingScreen } from '../src/screens/OnboardingScreen';
import { BrandDialog, type BrandDialogAction } from '../src/design/components';

/**
 * Walks the 8-step onboarding flow (name → gender → level → handedness →
 * goal → problem → reveal → notifications) and pins the personalization contract:
 * completeOnboarding receives the trimmed firstName and the gender value.
 */

function renderScreen(props?: React.ComponentProps<typeof OnboardingScreen>) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<OnboardingScreen {...props} />);
  });
  return renderer;
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join('');
}

function findPressable(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  const nodes = renderer.root.findAll(
    node =>
      node.props?.accessibilityLabel === label &&
      typeof node.props?.onPress === 'function',
  );
  expect(nodes.length).toBeGreaterThan(0);
  return nodes[0]!;
}

function press(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const node = findPressable(renderer, label);
  expect(node.props.disabled).toBeFalsy();
  act(() => {
    node.props.onPress();
  });
}

/** Answers every step so the reveal's primary button becomes reachable. */
function walkToReveal(renderer: TestRenderer.ReactTestRenderer) {
  act(() => renderer.root.findByType(TextInput).props.onChangeText(' Dana '));
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

describe('OnboardingScreen', () => {
  beforeEach(() => {
    mockCompleteOnboarding.mockClear();
    mockCompletePreAuthOnboarding.mockClear();
    mockCompletePreAuthOnboarding.mockResolvedValue(true);
    mockCompleteNotificationOnboarding.mockClear();
    mockCompleteNotificationOnboarding.mockResolvedValue(true);
    mockSignOut.mockClear();
  });

  it('starts on the name step with Continue locked until a real name is typed', () => {
    const renderer = renderScreen();
    // Every step opens with the same kicker → title → sub block.
    expect(allText(renderer)).toContain('PLAYER SETUP');
    expect(allText(renderer)).toContain('What should we call you?');
    expect(allText(renderer)).toContain(
      'Your coach personalizes every session.',
    );

    const continueButton = findPressable(renderer, 'Continue');
    expect(continueButton.props.disabled).toBe(true);
    const progress = renderer.root.findByProps({
      accessibilityRole: 'progressbar',
    });
    expect(progress.props.accessibilityValue).toEqual({
      min: 1,
      max: 8,
      now: 1,
    });

    const input = renderer.root.findByType(TextInput);
    expect(input.props.placeholder).toBe('First name');
    expect(input.props.maxLength).toBe(40);
    expect(input.props.autoCapitalize).toBe('words');
    expect(input.props.textContentType).toBe('givenName');

    // Whitespace alone must not unlock the step.
    act(() => input.props.onChangeText('   '));
    expect(findPressable(renderer, 'Continue').props.disabled).toBe(true);

    act(() => input.props.onChangeText('  Dana '));
    expect(findPressable(renderer, 'Continue').props.disabled).toBe(false);
    act(() => renderer.unmount());
  });

  it('advances from the keyboard only when the trimmed name is non-empty', () => {
    const renderer = renderScreen();
    const input = renderer.root.findByType(TextInput);

    act(() => input.props.onSubmitEditing());
    expect(allText(renderer)).toContain('What should we call you?');

    act(() => input.props.onChangeText('Jo'));
    act(() => input.props.onSubmitEditing());
    expect(allText(renderer)).toContain('How do you identify?');
    act(() => renderer.unmount());
  });

  it('walks name → gender → level → handedness → goal → problem → reveal → notifications and completes with the new fields', async () => {
    const renderer = renderScreen();

    act(() => renderer.root.findByType(TextInput).props.onChangeText(' Dana '));
    press(renderer, 'Continue');

    expect(allText(renderer)).toContain('How do you identify?');
    expect(allText(renderer)).toContain('Prefer not to say');
    press(renderer, 'Female');
    press(renderer, 'Continue');

    expect(allText(renderer)).toContain('Where is your game today?');
    press(renderer, '3.5');
    press(renderer, 'Continue');

    expect(allText(renderer)).toContain('Which side is home?');
    press(renderer, 'Right-handed');
    press(renderer, 'Continue');

    expect(allText(renderer)).toContain('What do you want to own?');
    press(renderer, 'Third-shot drops');
    press(renderer, 'Continue');

    expect(allText(renderer)).toContain('What breaks down most?');
    press(renderer, 'Control');
    press(renderer, 'Continue');

    expect(allText(renderer)).toContain('Built for Dana.');
    expect(mockCompleteNotificationOnboarding).not.toHaveBeenCalled();
    press(renderer, 'Continue');

    expect(allText(renderer)).toContain('Stay match-ready.');
    expect(allText(renderer)).toContain('Scheduled on this phone');
    expect(mockCompleteNotificationOnboarding).not.toHaveBeenCalled();
    press(renderer, 'Not now');
    await act(async () => {});

    expect(mockCompleteNotificationOnboarding).toHaveBeenCalledWith('not_now');
    expect(mockCompleteOnboarding).toHaveBeenCalledWith(walkedProfile);
    expect(mockCompletePreAuthOnboarding).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  describe('preauth mode (questionnaire before the login flow)', () => {
    it('stashes the answers and hands off to sign-in instead of saving to an account', async () => {
      const onFinished = jest.fn();
      const renderer = renderScreen({
        mode: 'preauth',
        onFinished,
        onBack: jest.fn(),
      });
      walkToReveal(renderer);
      expect(allText(renderer)).toContain('Built for Dana.');
      press(renderer, 'Continue');
      expect(allText(renderer)).toContain('Stay match-ready.');

      press(renderer, 'Turn on reminders');
      await act(async () => {});
      expect(mockCompleteNotificationOnboarding).toHaveBeenCalledWith('enable');
      expect(mockCompletePreAuthOnboarding).toHaveBeenCalledWith(walkedProfile);
      expect(mockCompleteOnboarding).not.toHaveBeenCalled();
      expect(onFinished).toHaveBeenCalledTimes(1);
      act(() => renderer.unmount());
    });

    it('finishes onboarding with reminders off when permission is denied', async () => {
      mockCompleteNotificationOnboarding.mockResolvedValue(false);
      const onFinished = jest.fn();
      const renderer = renderScreen({
        mode: 'preauth',
        onFinished,
        onBack: jest.fn(),
      });
      walkToReveal(renderer);
      press(renderer, 'Continue');
      press(renderer, 'Turn on reminders');
      await act(async () => {});

      expect(mockCompletePreAuthOnboarding).toHaveBeenCalledWith(walkedProfile);
      expect(onFinished).toHaveBeenCalledTimes(1);
      act(() => renderer.unmount());
    });

    it('does not advance to sign-in when the stash write fails', async () => {
      mockCompletePreAuthOnboarding.mockResolvedValue(false);
      const onFinished = jest.fn();
      const renderer = renderScreen({
        mode: 'preauth',
        onFinished,
        onBack: jest.fn(),
      });
      walkToReveal(renderer);
      press(renderer, 'Continue');
      press(renderer, 'Not now');
      await act(async () => {});
      expect(onFinished).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    });

    it('step one only goes BACK to Welcome — no alert, no skip to sign-in, session untouched', () => {
      const onBack = jest.fn();
      const onFinished = jest.fn();
      const renderer = renderScreen({ mode: 'preauth', onFinished, onBack });

      // The only control besides Continue on step one is Back; nothing is
      // labelled as leaving or skipping setup.
      expect(
        renderer.root.findAll(
          node => node.props?.accessibilityLabel === 'Leave setup',
        ),
      ).toHaveLength(0);
      expect(allText(renderer)).not.toMatch(/skip/i);

      press(renderer, 'Back');

      expect(onBack).toHaveBeenCalledTimes(1);
      expect(renderer.root.findByType(BrandDialog).props.visible).toBe(false);
      expect(onFinished).not.toHaveBeenCalled();
      expect(mockCompletePreAuthOnboarding).not.toHaveBeenCalled();
      expect(mockSignOut).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    });

    it('offers no skip on any later step either: Back always returns to the previous question', () => {
      const onBack = jest.fn();
      const renderer = renderScreen({
        mode: 'preauth',
        onFinished: jest.fn(),
        onBack,
      });
      act(() => renderer.root.findByType(TextInput).props.onChangeText('Dana'));
      press(renderer, 'Continue');
      expect(allText(renderer)).not.toMatch(/skip/i);

      press(renderer, 'Back');
      // Back inside the flow never leaves it.
      expect(onBack).not.toHaveBeenCalled();
      expect(renderer.root.findAllByType(TextInput)).toHaveLength(1);
      act(() => renderer.unmount());
    });
  });

  it('in-account mode keeps sign-out as the only exit and never offers a skip', () => {
    const renderer = renderScreen();

    expect(allText(renderer)).not.toMatch(/skip/i);
    press(renderer, 'Leave setup');
    const dialog = renderer.root.findByType(BrandDialog);
    expect(dialog.props.visible).toBe(true);
    const buttons = dialog.props.actions as readonly BrandDialogAction[];
    expect(buttons.map(button => button.label)).toEqual([
      'Keep setting up',
      'Sign out',
    ]);
    act(() => buttons.find(b => b.label === 'Sign out')!.onPress());
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });
});
