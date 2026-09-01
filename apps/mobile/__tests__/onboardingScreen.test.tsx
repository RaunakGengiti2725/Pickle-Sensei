import React from 'react';
import { Alert, Text, TextInput } from 'react-native';
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

import { OnboardingScreen } from '../src/screens/OnboardingScreen';

/**
 * Walks the 7-step onboarding flow (name → gender → level → handedness →
 * goal → problem → reveal) and pins the personalization contract:
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
    mockSignOut.mockClear();
  });

  it('starts on the name step with Continue locked until a real name is typed', () => {
    const renderer = renderScreen();
    expect(allText(renderer)).toContain('What should we call you?');
    expect(allText(renderer)).toContain(
      'Your coach personalizes every session.',
    );

    const continueButton = findPressable(renderer, 'Continue');
    expect(continueButton.props.disabled).toBe(true);

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

  it('walks name → gender → level → handedness → goal → problem → reveal and completes with the new fields', () => {
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

    // Reveal step is personalized with the trimmed name.
    expect(allText(renderer)).toContain('Built for Dana.');

    press(renderer, 'Start with 2 free ratings');
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
        onExitToSignIn: jest.fn(),
      });
      walkToReveal(renderer);
      expect(allText(renderer)).toContain('Built for Dana.');

      press(renderer, 'Start with 2 free ratings');
      await act(async () => {});
      expect(mockCompletePreAuthOnboarding).toHaveBeenCalledWith(walkedProfile);
      expect(mockCompleteOnboarding).not.toHaveBeenCalled();
      expect(onFinished).toHaveBeenCalledTimes(1);
      act(() => renderer.unmount());
    });

    it('does not advance to sign-in when the stash write fails', async () => {
      mockCompletePreAuthOnboarding.mockResolvedValue(false);
      const onFinished = jest.fn();
      const renderer = renderScreen({
        mode: 'preauth',
        onFinished,
        onExitToSignIn: jest.fn(),
      });
      walkToReveal(renderer);
      press(renderer, 'Start with 2 free ratings');
      await act(async () => {});
      expect(onFinished).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    });

    it('escapes to sign-in from step one without touching the session', () => {
      const alertSpy = jest
        .spyOn(Alert, 'alert')
        .mockImplementation(() => undefined);
      const onExitToSignIn = jest.fn();
      const renderer = renderScreen({
        mode: 'preauth',
        onFinished: jest.fn(),
        onExitToSignIn,
      });

      press(renderer, 'Leave setup');
      expect(alertSpy).toHaveBeenCalledTimes(1);
      const buttons = alertSpy.mock.calls[0]?.[2] ?? [];
      const skip = buttons.find(button => button.text === 'Skip to sign-in');
      expect(skip).toBeDefined();
      act(() => skip!.onPress?.());

      expect(onExitToSignIn).toHaveBeenCalledTimes(1);
      expect(mockSignOut).not.toHaveBeenCalled();
      alertSpy.mockRestore();
      act(() => renderer.unmount());
    });
  });
});
