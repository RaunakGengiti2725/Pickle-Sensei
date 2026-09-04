import React from 'react';
import { TextInput } from 'react-native';
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
/** Mutable so a test can leave the store errored after a failed save, the
 * way the real completeOnboarding does (it resolves and sets onboardingError). */
const mockAppState = {
  completeOnboarding: (profile: unknown) => mockCompleteOnboarding(profile),
  completePreAuthOnboarding: (profile: unknown) =>
    mockCompletePreAuthOnboarding(profile),
  onboardingBusy: false,
  onboardingError: null as string | null,
};
jest.mock('../../src/state/appStore', () => {
  const { focusForGoal } = jest.requireActual<
    typeof import('../../src/state/profile')
  >('../../src/state/profile');
  return {
    focusForGoal,
    useAppStore: (selector: (s: typeof mockAppState) => unknown) =>
      selector(mockAppState),
  };
});

jest.mock('../../src/auth/authStore', () => {
  const state = { signOut: jest.fn() };
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

import { OnboardingScreen } from '../../src/screens/OnboardingScreen';

/**
 * Adjudication ADJ-G (mobile-launch-onboarding): the reminder choice that
 * accompanies the SUCCESSFUL completion — the most recent press — is the one
 * recorded with the notification store. A failed profile save must not pin
 * the FIRST choice for the rest of the component's lifetime: "Not now" after
 * a failed "Turn on reminders" must never leave reminders enabled, and
 * "Turn on reminders" after a failed "Not now" must actually enable them.
 * Re-pressing the SAME button across a retry records it only once (no
 * duplicate OS permission prompt for 'enable').
 */

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
  const node = nodes[0]!;
  expect(node.props.disabled).toBeFalsy();
  act(() => {
    node.props.onPress();
  });
}

function walkToReminders(renderer: TestRenderer.ReactTestRenderer) {
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

describe('OnboardingScreen reminder choice across a failed completion (ADJ-G)', () => {
  beforeEach(() => {
    mockCompleteOnboarding.mockReset();
    mockCompleteOnboarding.mockResolvedValue(undefined);
    mockCompletePreAuthOnboarding.mockReset();
    mockCompletePreAuthOnboarding.mockResolvedValue(true);
    mockCompleteNotificationOnboarding.mockReset();
    mockCompleteNotificationOnboarding.mockResolvedValue(true);
    mockAppState.onboardingBusy = false;
    mockAppState.onboardingError = null;
  });

  it("in-account: 'Turn on reminders' → save fails → 'Not now' records 'not_now' last, and a repeated 'Not now' is not re-recorded", async () => {
    mockCompleteOnboarding.mockImplementation(async () => {
      mockAppState.onboardingError = 'Could not save your profile.';
    });
    const renderer = renderScreen();
    walkToReminders(renderer);

    press(renderer, 'Turn on reminders');
    await act(async () => {});
    expect(mockCompleteNotificationOnboarding).toHaveBeenCalledTimes(1);
    expect(mockCompleteNotificationOnboarding).toHaveBeenLastCalledWith(
      'enable',
    );
    expect(mockCompleteOnboarding).toHaveBeenCalledTimes(1);

    // The player changes their mind on the retry: this press must win.
    press(renderer, 'Not now');
    await act(async () => {});
    expect(mockCompleteOnboarding).toHaveBeenCalledTimes(2);
    expect(mockCompleteNotificationOnboarding).toHaveBeenCalledTimes(2);
    expect(mockCompleteNotificationOnboarding).toHaveBeenLastCalledWith(
      'not_now',
    );

    // Same button again after another failure: the choice is already
    // recorded, only the profile save is retried.
    mockCompleteOnboarding.mockImplementation(async () => {
      mockAppState.onboardingError = null;
    });
    press(renderer, 'Not now');
    await act(async () => {});
    expect(mockCompleteOnboarding).toHaveBeenCalledTimes(3);
    expect(mockCompleteNotificationOnboarding).toHaveBeenCalledTimes(2);
    expect(
      mockCompleteNotificationOnboarding.mock.calls.map(c => c[0]),
    ).toEqual(['enable', 'not_now']);
    act(() => renderer.unmount());
  });

  it("pre-auth: 'Not now' → stash fails → 'Turn on reminders' records 'enable' last, fires onFinished once, and never re-prompts for the same choice", async () => {
    mockCompletePreAuthOnboarding.mockResolvedValue(false);
    const onFinished = jest.fn();
    const renderer = renderScreen({
      mode: 'preauth',
      onFinished,
      onBack: jest.fn(),
    });
    walkToReminders(renderer);

    press(renderer, 'Not now');
    await act(async () => {});
    expect(mockCompleteNotificationOnboarding).toHaveBeenCalledTimes(1);
    expect(mockCompleteNotificationOnboarding).toHaveBeenLastCalledWith(
      'not_now',
    );
    expect(mockCompletePreAuthOnboarding).toHaveBeenCalledTimes(1);
    expect(onFinished).not.toHaveBeenCalled();

    // Still failing: the changed choice is recorded once, the OS prompt runs
    // once, and the hand-off does not happen.
    press(renderer, 'Turn on reminders');
    await act(async () => {});
    expect(mockCompletePreAuthOnboarding).toHaveBeenCalledTimes(2);
    expect(mockCompleteNotificationOnboarding).toHaveBeenCalledTimes(2);
    expect(mockCompleteNotificationOnboarding).toHaveBeenLastCalledWith(
      'enable',
    );
    expect(onFinished).not.toHaveBeenCalled();

    // Retry the same button once the stash succeeds: no second permission
    // request, the hand-off fires exactly once.
    mockCompletePreAuthOnboarding.mockResolvedValue(true);
    press(renderer, 'Turn on reminders');
    await act(async () => {});
    expect(mockCompletePreAuthOnboarding).toHaveBeenCalledTimes(3);
    expect(mockCompleteNotificationOnboarding).toHaveBeenCalledTimes(2);
    expect(
      mockCompleteNotificationOnboarding.mock.calls.map(c => c[0]),
    ).toEqual(['not_now', 'enable']);
    expect(mockCompleteNotificationOnboarding).toHaveBeenLastCalledWith(
      'enable',
    );
    expect(onFinished).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });
});
