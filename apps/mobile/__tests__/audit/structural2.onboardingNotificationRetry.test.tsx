import React from 'react';
import { TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * Structural audit #2 — OnboardingScreen.finishOnboarding persists the
 * reminder choice BEFORE the profile save and caches it in component state.
 * When the profile save fails and the user then presses the OTHER reminder
 * button, the second (final) choice must be the one recorded; in particular
 * "Turn on reminders" must still be able to request OS permission.
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
import { BrandDialog } from '../../src/design/components';

function renderScreen(props?: React.ComponentProps<typeof OnboardingScreen>) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<OnboardingScreen {...props} />);
  });
  return renderer;
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

describe('OnboardingScreen — reminder choice after a failed profile save', () => {
  it('pre-auth: "Not now" then (stash fails) "Turn on reminders" records the final choice', async () => {
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
    expect(mockCompleteNotificationStep).toHaveBeenLastCalledWith('not_now');

    press(renderer, 'Turn on reminders');
    await act(async () => {});
    expect(onFinished).toHaveBeenCalledTimes(1);
    // The user's last, successful choice was to turn reminders on.
    expect(mockCompleteNotificationStep).toHaveBeenLastCalledWith('enable');
    act(() => renderer.unmount());
  });

  it('account: "Turn on reminders" then (save fails) "Not now" does not leave reminders enabled', async () => {
    // completeOnboarding never rejects; a server failure leaves the profile
    // unsaved and the screen mounted (Gate still sees profile === null).
    const renderer = renderScreen();
    walkToNotifications(renderer);

    press(renderer, 'Turn on reminders');
    await act(async () => {});
    expect(mockCompleteOnboarding).toHaveBeenCalledTimes(1);
    expect(mockCompleteNotificationStep).toHaveBeenLastCalledWith('enable');

    press(renderer, 'Not now');
    await act(async () => {});
    expect(mockCompleteOnboarding).toHaveBeenCalledTimes(2);
    expect(mockCompleteNotificationStep).toHaveBeenLastCalledWith('not_now');
    act(() => renderer.unmount());
  });

  it('pre-auth: Back from the reminder step and returning keeps the choice re-recordable', async () => {
    mockCompletePreAuthOnboarding.mockResolvedValueOnce(false);
    const renderer = renderScreen({
      mode: 'preauth',
      onFinished: jest.fn(),
      onBack: jest.fn(),
    });
    walkToNotifications(renderer);
    press(renderer, 'Not now');
    await act(async () => {});

    press(renderer, 'Back');
    press(renderer, 'Continue');
    press(renderer, 'Turn on reminders');
    await act(async () => {});
    expect(mockCompleteNotificationStep).toHaveBeenLastCalledWith('enable');
    act(() => renderer.unmount());
  });
});

describe('OnboardingScreen — in-account leave dialog copy (companion to the Gate destination probe)', () => {
  it('promises the sign-in screen as the sign-out destination', () => {
    const renderer = renderScreen();
    press(renderer, 'Leave setup');
    const dialog = renderer.root.findByType(BrandDialog);
    expect(dialog.props.visible).toBe(true);
    expect(dialog.props.detail).toContain('returned to the sign-in screen');
    expect(
      findPressable(renderer, 'Leave setup').props.accessibilityHint,
    ).toContain('return to the sign-in screen');
    act(() => renderer.unmount());
  });
});
