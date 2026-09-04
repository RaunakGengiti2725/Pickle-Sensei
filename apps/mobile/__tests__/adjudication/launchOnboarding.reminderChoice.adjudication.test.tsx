import React from 'react';
import { TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * Adjudication repro (ADJ-G) for `mobile-launch-onboarding` @ 4d812e1a.
 *
 * OnboardingScreen.finishOnboarding records the reminder choice once and
 * caches it in component state (`if (!notificationChoice)`). When the
 * profile save fails and the user presses the OTHER reminder button on the
 * retry, the newer choice is never recorded. In-account this can leave
 * reminders enabled after the user's final answer was "Not now"; pre-auth
 * the reverse can silently drop a "Turn on reminders" opt-in. Fails on
 * 4d812e1a.
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
jest.mock('../../src/state/appStore', () => {
  const { focusForGoal } = jest.requireActual<
    typeof import('../../src/state/profile')
  >('../../src/state/profile');
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

jest.mock('../../src/auth/authStore', () => {
  const state = { signOut: () => Promise.resolve() };
  return {
    useAuthStore: (selector: (s: typeof state) => unknown) => selector(state),
  };
});

const mockCompleteNotificationStep = jest.fn<
  Promise<boolean>,
  ['enable' | 'not_now']
>(() => Promise.resolve(true));
jest.mock('../../src/notifications/notificationStore', () => {
  const state = {
    completeOnboardingStep: (choice: 'enable' | 'not_now') =>
      mockCompleteNotificationStep(choice),
  };
  return {
    useNotificationStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});

import { OnboardingScreen } from '../../src/screens/OnboardingScreen';

function renderScreen(props?: React.ComponentProps<typeof OnboardingScreen>) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<OnboardingScreen {...props} />);
  });
  return renderer;
}

function press(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const nodes = renderer.root.findAll(
    node =>
      node.props?.accessibilityLabel === label &&
      typeof node.props?.onPress === 'function',
  );
  expect(nodes.length).toBeGreaterThan(0);
  expect(nodes[0]!.props.disabled).toBeFalsy();
  act(() => {
    nodes[0]!.props.onPress();
  });
}

function walkToNotifications(renderer: TestRenderer.ReactTestRenderer) {
  act(() => renderer.root.findByType(TextInput).props.onChangeText('Dana'));
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
  press(renderer, 'Continue');
}

beforeEach(() => {
  mockCompleteOnboarding.mockReset();
  mockCompleteOnboarding.mockResolvedValue(undefined);
  mockCompletePreAuthOnboarding.mockReset();
  mockCompletePreAuthOnboarding.mockResolvedValue(true);
  mockCompleteNotificationStep.mockReset();
  mockCompleteNotificationStep.mockResolvedValue(true);
});

describe('ADJ-G — reminder choice on the retry after a failed profile save', () => {
  it('in-account: "Turn on reminders" → save fails → "Not now" records not_now as the final choice', async () => {
    mockCompleteOnboarding.mockResolvedValueOnce(undefined); // store sets onboardingError; component only awaits
    const renderer = renderScreen();
    walkToNotifications(renderer);

    press(renderer, 'Turn on reminders');
    await act(async () => {});
    expect(mockCompleteNotificationStep).toHaveBeenLastCalledWith('enable');

    press(renderer, 'Not now');
    await act(async () => {});
    expect(mockCompleteOnboarding).toHaveBeenCalledTimes(2);
    expect(mockCompleteNotificationStep).toHaveBeenLastCalledWith('not_now');
    act(() => renderer.unmount());
  });

  it('pre-auth: "Not now" → stash fails → "Turn on reminders" records enable as the final choice', async () => {
    mockCompletePreAuthOnboarding.mockResolvedValueOnce(false);
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

    press(renderer, 'Turn on reminders');
    await act(async () => {});
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(mockCompleteNotificationStep).toHaveBeenLastCalledWith('enable');
    act(() => renderer.unmount());
  });
});
