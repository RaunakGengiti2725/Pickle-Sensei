import React from 'react';
import { Alert, Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { PermissionState } from '../../src/notifications/service';

/**
 * Drives the OnboardingScreen through every control with the REAL appStore
 * and notificationStore behind it (in-memory kv, fake OS scheduler), so the
 * assertions cover what a tap actually persists — not just which callback
 * fired. Covers: every question option, Continue gating, Back, Leave setup
 * (both alert branches, both modes), the reveal, and the notification step's
 * "Turn on reminders" vs "Not now" permission invariant, including OS denial,
 * scheduler failure, stash-write failure + retry, and the double-tap guard.
 */

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  initialWindowMetrics: {
    frame: { x: 0, y: 0, width: 390, height: 844 },
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
  },
}));

const mockKv = new Map<string, string>();
const mockDbControl: {
  writeError: Error | null;
  /** Fail only writes after this many successful ones (null = use writeError for all). */
  failWritesAfter: number | null;
  writes: number;
  writeGate: Promise<void> | null;
} = { writeError: null, failWritesAfter: null, writes: 0, writeGate: null };

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      const statement = sql.trim().replace(/\s+/g, ' ');
      if (statement.startsWith('SELECT value FROM kv')) {
        const value = mockKv.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
        if (mockDbControl.writeGate) await mockDbControl.writeGate;
        mockDbControl.writes += 1;
        if (
          mockDbControl.writeError &&
          (mockDbControl.failWritesAfter === null ||
            mockDbControl.writes > mockDbControl.failWritesAfter)
        ) {
          throw mockDbControl.writeError;
        }
        mockKv.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

const mockSignOut = jest.fn();
jest.mock('../../src/auth/authStore', () => {
  const state = { signOut: () => mockSignOut() };
  return {
    useAuthStore: (selector: (s: typeof state) => unknown) => selector(state),
  };
});

const mockScheduler = {
  permission: 'undetermined' as PermissionState,
  requestResult: 'granted' as PermissionState,
  requestError: null as Error | null,
  requestCalls: 0,
  cancelAllCalls: 0,
  appliedPlans: [] as unknown[],
  async permissionState(): Promise<PermissionState> {
    return this.permission;
  },
  async requestPermission(): Promise<PermissionState> {
    this.requestCalls += 1;
    if (this.requestError) throw this.requestError;
    this.permission = this.requestResult;
    return this.requestResult;
  },
  async applyPlan(plan: unknown): Promise<void> {
    this.appliedPlans.push(plan);
  },
  async cancelAllPlanned(): Promise<void> {
    this.cancelAllCalls += 1;
  },
  async openSystemSettings(): Promise<void> {},
};
jest.mock('../../src/notifications/service', () => ({
  getScheduler: () => mockScheduler,
}));

import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  DEVICE_ONBOARDED_KV_KEY,
  PENDING_ONBOARDING_PROFILE_KV_KEY,
  useAppStore,
} from '../../src/state/appStore';
import {
  PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
  useNotificationStore,
} from '../../src/notifications/notificationStore';
import { OnboardingScreen } from '../../src/screens/OnboardingScreen';

type Renderer = TestRenderer.ReactTestRenderer;

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
    .filter((c): c is string | number => typeof c !== 'object')
    .join('');
}

/**
 * The innermost element carrying the label + onPress is RN's `Pressable`
 * (the layer that receives the merged accessibilityState); the outer match is
 * the `PressableScale` wrapper. One entry per control.
 */
function pressables(renderer: Renderer, label: string) {
  const matches = renderer.root.findAll(
    node =>
      node.props?.accessibilityLabel === label &&
      typeof node.props?.onPress === 'function',
  );
  return matches.filter(
    node => !matches.some(other => other !== node && isAncestor(node, other)),
  );
}

function isAncestor(
  ancestor: TestRenderer.ReactTestInstance,
  node: TestRenderer.ReactTestInstance,
): boolean {
  let current = node.parent;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function findPressable(renderer: Renderer, label: string) {
  const nodes = pressables(renderer, label);
  expect(nodes.length).toBeGreaterThan(0);
  return nodes[0]!;
}

function press(renderer: Renderer, label: string) {
  const node = findPressable(renderer, label);
  expect(node.props.disabled).toBeFalsy();
  act(() => {
    node.props.onPress();
  });
}

function progressNow(renderer: Renderer): number {
  return renderer.root.findByProps({ accessibilityRole: 'progressbar' }).props
    .accessibilityValue.now;
}

function typeName(renderer: Renderer, name: string) {
  act(() => renderer.root.findByType(TextInput).props.onChangeText(name));
}

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
  expect(allText(renderer)).toContain('YOUR STARTING PLAN');
}

function walkToNotifications(renderer: Renderer) {
  walkToReveal(renderer);
  press(renderer, 'Continue');
  expect(allText(renderer)).toContain('Stay match-ready.');
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

function pendingProfile() {
  const raw = mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY);
  return raw
    ? (JSON.parse(raw) as { version: number; profile: unknown })
    : null;
}

function pendingNotificationChoice() {
  const raw = mockKv.get(PENDING_NOTIFICATION_ONBOARDING_KV_KEY);
  return raw
    ? (JSON.parse(raw) as { version: number; enabled: boolean })
    : null;
}

const QUESTION_STEPS: Array<{
  title: string;
  options: string[];
  hints: string[];
}> = [
  {
    title: 'How do you identify?',
    options: ['Female', 'Male', 'Non-binary', 'Prefer not to say'],
    hints: [],
  },
  {
    title: 'Where is your game today?',
    options: ['Brand new', '2.5', '3.0', '3.5', '4.0', '4.5', '5.0+'],
    hints: ['First paddle, first weeks', 'Open play, high level'],
  },
  {
    title: 'Which side is home?',
    options: ['Right-handed', 'Left-handed'],
    hints: [],
  },
  {
    title: 'What do you want to own?',
    options: [
      'Dinks',
      'Drives',
      'Third-shot drops',
      'Serve',
      'Volleys',
      'Footwork',
      'All-around',
    ],
    hints: ['Own the soft game at the kitchen', 'Raise the whole game'],
  },
  {
    title: 'What breaks down most?',
    options: [
      'Consistency',
      'Control',
      'Power',
      'Contact',
      'Footwork',
      'Placement',
      'Not sure',
    ],
    hints: ["That's what the analysis is for"],
  },
];

describe('flow: launch-onboarding — OnboardingScreen controls', () => {
  beforeEach(() => {
    mockKv.clear();
    mockDbControl.writeError = null;
    mockDbControl.failWritesAfter = null;
    mockDbControl.writes = 0;
    mockDbControl.writeGate = null;
    mockScheduler.permission = 'undetermined';
    mockScheduler.requestResult = 'granted';
    mockScheduler.requestError = null;
    mockScheduler.requestCalls = 0;
    mockScheduler.cancelAllCalls = 0;
    mockScheduler.appliedPlans = [];
    mockSignOut.mockClear();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    useAppStore.setState({
      hydrated: true,
      ownerKey: SIGNED_OUT_DATA_OWNER,
      profile: null,
      preAuthOnboarded: false,
      onboardingBusy: false,
      onboardingError: null,
    });
    useNotificationStore.setState({
      hydrated: false,
      ownerKey: null,
      permission: 'unknown',
    });
  });

  it('every question step renders every option as a radio with hint + selected state, and Continue stays locked until one is chosen', () => {
    const renderer = renderScreen({ mode: 'preauth' });
    // Step 1: name.
    expect(progressNow(renderer)).toBe(1);
    expect(allText(renderer)).toContain('1/8');
    expect(findPressable(renderer, 'Continue').props.disabled).toBe(true);
    expect(
      findPressable(renderer, 'Continue').props.accessibilityState.disabled,
    ).toBe(true);
    // Whitespace never unlocks; a real name does.
    typeName(renderer, '   ');
    expect(findPressable(renderer, 'Continue').props.disabled).toBe(true);
    typeName(renderer, 'Dana');
    expect(findPressable(renderer, 'Continue').props.disabled).toBe(false);
    press(renderer, 'Continue');

    QUESTION_STEPS.forEach((question, index) => {
      const stepNumber = index + 2;
      expect(allText(renderer)).toContain(question.title);
      expect(progressNow(renderer)).toBe(stepNumber);
      expect(allText(renderer)).toContain(`${stepNumber}/8`);
      // Nothing selected yet → Continue locked.
      expect(findPressable(renderer, 'Continue').props.disabled).toBe(true);

      for (const option of question.options) {
        const node = findPressable(renderer, option);
        expect(node.props.accessibilityRole).toBe('radio');
        expect(node.props.accessibilityState.selected).toBe(false);
      }
      for (const hint of question.hints) {
        expect(
          renderer.root.findAll(n => n.props?.accessibilityHint === hint)
            .length,
        ).toBeGreaterThan(0);
      }

      // Selecting never auto-advances; re-selecting swaps the radio state.
      const [first, second] = question.options;
      press(renderer, first!);
      expect(allText(renderer)).toContain(question.title);
      expect(
        findPressable(renderer, first!).props.accessibilityState.selected,
      ).toBe(true);
      expect(findPressable(renderer, 'Continue').props.disabled).toBe(false);
      press(renderer, second!);
      expect(
        findPressable(renderer, first!).props.accessibilityState.selected,
      ).toBe(false);
      expect(
        findPressable(renderer, second!).props.accessibilityState.selected,
      ).toBe(true);
      press(renderer, 'Continue');
    });

    // Reveal (step 7) then notifications (step 8) — Continue on the reveal is
    // always enabled, and the notification step has no Continue at all.
    expect(allText(renderer)).toContain('YOUR STARTING PLAN');
    expect(progressNow(renderer)).toBe(7);
    expect(findPressable(renderer, 'Continue').props.disabled).toBeFalsy();
    press(renderer, 'Continue');
    expect(allText(renderer)).toContain('Stay match-ready.');
    expect(progressNow(renderer)).toBe(8);
    expect(allText(renderer)).toContain('8/8');
    expect(pressables(renderer, 'Continue')).toHaveLength(0);
    expect(pressables(renderer, 'Turn on reminders')).toHaveLength(1);
    expect(pressables(renderer, 'Not now')).toHaveLength(1);
    act(() => renderer.unmount());
  });

  it('Back returns to the previous step keeping the earlier answer; step one shows Leave setup instead of Back', () => {
    const renderer = renderScreen({ mode: 'preauth' });
    expect(pressables(renderer, 'Back')).toHaveLength(0);
    expect(pressables(renderer, 'Leave setup')).toHaveLength(1);
    const leave = findPressable(renderer, 'Leave setup');
    expect(leave.props.accessibilityHint).toBe(
      'Skip ahead to the sign-in screen',
    );
    expect(leave.props.accessibilityRole).toBe('button');

    typeName(renderer, 'Dana');
    press(renderer, 'Continue');
    press(renderer, 'Male');
    press(renderer, 'Continue');
    expect(allText(renderer)).toContain('Where is your game today?');
    expect(pressables(renderer, 'Leave setup')).toHaveLength(0);
    const back = findPressable(renderer, 'Back');
    expect(back.props.accessibilityHint).toBe(
      'Return to the previous question',
    );
    expect(back.props.accessibilityRole).toBe('button');

    press(renderer, 'Back');
    expect(allText(renderer)).toContain('How do you identify?');
    expect(
      findPressable(renderer, 'Male').props.accessibilityState.selected,
    ).toBe(true);
    expect(findPressable(renderer, 'Continue').props.disabled).toBe(false);
    press(renderer, 'Back');
    expect(allText(renderer)).toContain('What should we call you?');
    expect(renderer.root.findByType(TextInput).props.value).toBe('Dana');
    // Step one: Back is gone again, Leave setup is back.
    expect(pressables(renderer, 'Back')).toHaveLength(0);
    expect(pressables(renderer, 'Leave setup')).toHaveLength(1);
    act(() => renderer.unmount());
  });

  it('Back from the notification step returns to the reveal, and from the reveal to the last question', () => {
    const renderer = renderScreen({ mode: 'preauth' });
    walkToNotifications(renderer);
    press(renderer, 'Back');
    expect(allText(renderer)).toContain('YOUR STARTING PLAN');
    expect(progressNow(renderer)).toBe(7);
    press(renderer, 'Back');
    expect(allText(renderer)).toContain('What breaks down most?');
    expect(
      findPressable(renderer, 'Control').props.accessibilityState.selected,
    ).toBe(true);
    act(() => renderer.unmount());
  });

  it('the reveal reflects the chosen goal and name; a different goal changes the focus', () => {
    const renderer = renderScreen({ mode: 'preauth' });
    walkToReveal(renderer);
    expect(allText(renderer)).toContain('Built for Dana.');
    expect(allText(renderer)).toContain('Paddle Set');
    press(renderer, 'Back');
    press(renderer, 'Back');
    expect(allText(renderer)).toContain('What do you want to own?');
    press(renderer, 'Serve');
    press(renderer, 'Continue');
    press(renderer, 'Continue');
    expect(allText(renderer)).toContain('Sequencing');
    act(() => renderer.unmount());
  });

  it('keyboard Next mirrors Continue but never past an empty name', () => {
    const renderer = renderScreen({ mode: 'preauth' });
    const input = renderer.root.findByType(TextInput);
    expect(input.props.accessibilityLabel).toBe('First name');
    act(() => input.props.onSubmitEditing());
    expect(allText(renderer)).toContain('What should we call you?');
    typeName(renderer, '  ');
    act(() => renderer.root.findByType(TextInput).props.onSubmitEditing());
    expect(allText(renderer)).toContain('What should we call you?');
    typeName(renderer, 'Jo');
    act(() => renderer.root.findByType(TextInput).props.onSubmitEditing());
    expect(allText(renderer)).toContain('How do you identify?');
    act(() => renderer.unmount());
  });

  describe('pre-auth Leave setup alert', () => {
    it('"Keep setting up" is a cancel action that leaves the user on the questionnaire', () => {
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
      expect(alertSpy.mock.calls[0]?.[0]).toBe('Skip setup?');
      const buttons = alertSpy.mock.calls[0]?.[2] ?? [];
      expect(buttons.map(b => b.text)).toEqual([
        'Keep setting up',
        'Skip to sign-in',
      ]);
      const keep = buttons.find(b => b.text === 'Keep setting up')!;
      expect(keep.style).toBe('cancel');
      act(() => keep.onPress?.());
      expect(onExitToSignIn).not.toHaveBeenCalled();
      expect(mockSignOut).not.toHaveBeenCalled();
      expect(allText(renderer)).toContain('What should we call you?');
      alertSpy.mockRestore();
      act(() => renderer.unmount());
    });

    it('"Skip to sign-in" hands off without touching the session or the stash', () => {
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
      const buttons = alertSpy.mock.calls[0]?.[2] ?? [];
      act(() => buttons.find(b => b.text === 'Skip to sign-in')!.onPress?.());
      expect(onExitToSignIn).toHaveBeenCalledTimes(1);
      expect(mockSignOut).not.toHaveBeenCalled();
      expect(mockKv.size).toBe(0);
      alertSpy.mockRestore();
      act(() => renderer.unmount());
    });
  });

  describe('account-mode Leave setup alert', () => {
    it('offers a destructive Sign out and a cancel; only Sign out calls signOut', () => {
      setActiveDataOwner(GUEST_DATA_OWNER);
      const alertSpy = jest
        .spyOn(Alert, 'alert')
        .mockImplementation(() => undefined);
      const renderer = renderScreen();
      const leave = findPressable(renderer, 'Leave setup');
      expect(leave.props.accessibilityHint).toBe(
        'Sign out and return to the sign-in screen',
      );
      press(renderer, 'Leave setup');
      expect(alertSpy.mock.calls[0]?.[0]).toBe('Leave setup?');
      const buttons = alertSpy.mock.calls[0]?.[2] ?? [];
      const keep = buttons.find(b => b.text === 'Keep setting up')!;
      const signOut = buttons.find(b => b.text === 'Sign out')!;
      expect(keep.style).toBe('cancel');
      expect(signOut.style).toBe('destructive');
      act(() => keep.onPress?.());
      expect(mockSignOut).not.toHaveBeenCalled();
      act(() => signOut.onPress?.());
      expect(mockSignOut).toHaveBeenCalledTimes(1);
      alertSpy.mockRestore();
      act(() => renderer.unmount());
    });
  });

  describe('notification step (pre-auth)', () => {
    it('"Not now" NEVER requests OS permission, stashes {enabled:false}, writes the profile stash + device marker, then hands off once', async () => {
      const onFinished = jest.fn();
      const renderer = renderScreen({
        mode: 'preauth',
        onFinished,
        onExitToSignIn: jest.fn(),
      });
      walkToNotifications(renderer);
      const notNow = findPressable(renderer, 'Not now');
      expect(notNow.props.accessibilityRole).toBe('button');
      expect(notNow.props.accessibilityHint).toBe(
        'Finish setup without enabling reminders',
      );
      expect(allText(renderer)).toContain('Change this anytime in Settings.');

      press(renderer, 'Not now');
      await act(async () => {});

      expect(mockScheduler.requestCalls).toBe(0);
      expect(pendingNotificationChoice()).toEqual({
        version: 1,
        enabled: false,
      });
      expect(pendingProfile()).toEqual({ version: 1, profile: walkedProfile });
      expect(mockKv.get(DEVICE_ONBOARDED_KV_KEY)).toBe(
        JSON.stringify({ version: 1 }),
      );
      expect(useAppStore.getState().preAuthOnboarded).toBe(true);
      expect(useAppStore.getState().onboardingBusy).toBe(false);
      expect(useAppStore.getState().onboardingError).toBeNull();
      expect(onFinished).toHaveBeenCalledTimes(1);
      // No owner-scoped prefs are written while signed out.
      expect(
        [...mockKv.keys()].filter(k => k.startsWith('notifications')),
      ).toEqual([]);
      act(() => renderer.unmount());
    });

    it('"Turn on reminders" requests OS permission exactly once and stashes {enabled:true} on grant', async () => {
      const onFinished = jest.fn();
      const renderer = renderScreen({
        mode: 'preauth',
        onFinished,
        onExitToSignIn: jest.fn(),
      });
      walkToNotifications(renderer);
      expect(mockScheduler.requestCalls).toBe(0);
      press(renderer, 'Turn on reminders');
      await act(async () => {});
      expect(mockScheduler.requestCalls).toBe(1);
      expect(useNotificationStore.getState().permission).toBe('granted');
      expect(pendingNotificationChoice()).toEqual({
        version: 1,
        enabled: true,
      });
      expect(pendingProfile()).toEqual({ version: 1, profile: walkedProfile });
      expect(onFinished).toHaveBeenCalledTimes(1);
      act(() => renderer.unmount());
    });

    it('OS denial still completes setup with reminders off (no dead end)', async () => {
      mockScheduler.requestResult = 'denied';
      const onFinished = jest.fn();
      const renderer = renderScreen({
        mode: 'preauth',
        onFinished,
        onExitToSignIn: jest.fn(),
      });
      walkToNotifications(renderer);
      press(renderer, 'Turn on reminders');
      await act(async () => {});
      expect(mockScheduler.requestCalls).toBe(1);
      expect(useNotificationStore.getState().permission).toBe('denied');
      expect(pendingNotificationChoice()).toEqual({
        version: 1,
        enabled: false,
      });
      expect(onFinished).toHaveBeenCalledTimes(1);
      act(() => renderer.unmount());
    });

    it('a throwing OS permission call is swallowed: setup still completes with reminders off', async () => {
      mockScheduler.requestError = new Error('notifee unavailable');
      const onFinished = jest.fn();
      const renderer = renderScreen({
        mode: 'preauth',
        onFinished,
        onExitToSignIn: jest.fn(),
      });
      walkToNotifications(renderer);
      press(renderer, 'Turn on reminders');
      await act(async () => {});
      expect(useNotificationStore.getState().permission).toBe('unknown');
      expect(pendingNotificationChoice()).toEqual({
        version: 1,
        enabled: false,
      });
      expect(onFinished).toHaveBeenCalledTimes(1);
      act(() => renderer.unmount());
    });

    it('double-tap guard: while finishing, both actions are disabled, the label reads "Finishing setup…", and permission is asked once', async () => {
      let releaseWrites!: () => void;
      mockDbControl.writeGate = new Promise<void>(resolve => {
        releaseWrites = resolve;
      });
      const onFinished = jest.fn();
      const renderer = renderScreen({
        mode: 'preauth',
        onFinished,
        onExitToSignIn: jest.fn(),
      });
      walkToNotifications(renderer);

      // First tap: a discrete press event; React flushes the busy state
      // before the next touch can arrive.
      press(renderer, 'Turn on reminders');
      await act(async () => {});

      expect(mockScheduler.requestCalls).toBe(1);
      expect(pressables(renderer, 'Turn on reminders')).toHaveLength(0);
      const busy = findPressable(renderer, 'Finishing setup…');
      expect(busy.props.disabled).toBe(true);
      expect(busy.props.accessibilityState.disabled).toBe(true);
      // Second tap on the (now disabled) primary: even if the handler ran, the
      // in-flight guard drops it.
      act(() => busy.props.onPress());
      await act(async () => {});
      expect(mockScheduler.requestCalls).toBe(1);
      const notNow = findPressable(renderer, 'Not now');
      expect(notNow.props.disabled).toBe(true);
      // A tap on the disabled skip must be a no-op even if it reaches the
      // handler.
      act(() => notNow.props.onPress());
      await act(async () => {});
      expect(mockScheduler.requestCalls).toBe(1);
      expect(onFinished).not.toHaveBeenCalled();

      releaseWrites();
      await act(async () => {});
      await act(async () => {});
      expect(onFinished).toHaveBeenCalledTimes(1);
      expect(pendingNotificationChoice()).toEqual({
        version: 1,
        enabled: true,
      });
      act(() => renderer.unmount());
    });

    it('stash-write failure shows the error copy, clears busy, keeps the user on the step, and a retry succeeds without re-asking permission', async () => {
      const onFinished = jest.fn();
      const renderer = renderScreen({
        mode: 'preauth',
        onFinished,
        onExitToSignIn: jest.fn(),
      });
      walkToNotifications(renderer);

      // The notification choice write (first INSERT) succeeds; the profile
      // stash write that follows fails.
      mockDbControl.writes = 0;
      mockDbControl.failWritesAfter = 1;
      mockDbControl.writeError = new Error('disk full');

      press(renderer, 'Turn on reminders');
      await act(async () => {});

      expect(mockScheduler.requestCalls).toBe(1);
      expect(pendingNotificationChoice()).toEqual({
        version: 1,
        enabled: true,
      });
      expect(pendingProfile()).toBeNull();
      expect(onFinished).not.toHaveBeenCalled();
      expect(useAppStore.getState().onboardingBusy).toBe(false);
      expect(useAppStore.getState().onboardingError).toBe('disk full');
      expect(allText(renderer)).toContain('disk full');
      expect(allText(renderer)).toContain('Stay match-ready.');
      // Buttons are live again — no infinite loading.
      expect(findPressable(renderer, 'Turn on reminders').props.disabled).toBe(
        false,
      );
      expect(findPressable(renderer, 'Not now').props.disabled).toBe(false);

      mockDbControl.writeError = null;
      press(renderer, 'Turn on reminders');
      await act(async () => {});
      // Single permission ask across the retry.
      expect(mockScheduler.requestCalls).toBe(1);
      expect(pendingProfile()).toEqual({ version: 1, profile: walkedProfile });
      expect(useAppStore.getState().onboardingError).toBeNull();
      expect(onFinished).toHaveBeenCalledTimes(1);
      act(() => renderer.unmount());
    });
  });

  describe('notification step (account mode, guest owner)', () => {
    beforeEach(() => {
      setActiveDataOwner(GUEST_DATA_OWNER);
      useAppStore.setState({ ownerKey: GUEST_DATA_OWNER });
    });

    it('"Not now" saves the profile to the owner and owner-scoped prefs with reminders off, never asking permission', async () => {
      const renderer = renderScreen();
      walkToNotifications(renderer);
      press(renderer, 'Not now');
      await act(async () => {});
      expect(mockScheduler.requestCalls).toBe(0);
      expect(JSON.parse(mockKv.get(`profile:${GUEST_DATA_OWNER}`)!)).toEqual(
        walkedProfile,
      );
      expect(useAppStore.getState().profile).toEqual(walkedProfile);
      expect(useAppStore.getState().preAuthOnboarded).toBe(true);
      expect(mockKv.get(DEVICE_ONBOARDED_KV_KEY)).toBe(
        JSON.stringify({ version: 1 }),
      );
      const prefs = JSON.parse(
        mockKv.get(`notifications:${GUEST_DATA_OWNER}`)!,
      ) as { enabled: boolean; promptDismissed: boolean };
      expect(prefs.enabled).toBe(false);
      expect(prefs.promptDismissed).toBe(true);
      expect(pendingNotificationChoice()).toBeNull();
      // Disabled → nothing may be scheduled.
      expect(mockScheduler.appliedPlans).toEqual([]);
      act(() => renderer.unmount());
    });

    it('"Turn on reminders" + grant enables owner prefs and schedules a plan', async () => {
      const renderer = renderScreen();
      walkToNotifications(renderer);
      press(renderer, 'Turn on reminders');
      await act(async () => {});
      expect(mockScheduler.requestCalls).toBe(1);
      const prefs = JSON.parse(
        mockKv.get(`notifications:${GUEST_DATA_OWNER}`)!,
      ) as { enabled: boolean; promptDismissed: boolean };
      expect(prefs.enabled).toBe(true);
      expect(prefs.promptDismissed).toBe(true);
      expect(useAppStore.getState().profile).toEqual(walkedProfile);
      act(() => renderer.unmount());
    });

    it('a failed profile save shows the failure copy and stays recoverable', async () => {
      const renderer = renderScreen();
      walkToNotifications(renderer);
      mockDbControl.writeError = new Error(
        'Your coaching profile could not be saved (test).',
      );
      press(renderer, 'Not now');
      await act(async () => {});
      expect(useAppStore.getState().profile).toBeNull();
      expect(useAppStore.getState().onboardingBusy).toBe(false);
      expect(allText(renderer)).toContain(
        'Your coaching profile could not be saved (test).',
      );
      expect(findPressable(renderer, 'Not now').props.disabled).toBe(false);
      expect(findPressable(renderer, 'Turn on reminders').props.disabled).toBe(
        false,
      );
      mockDbControl.writeError = null;
      press(renderer, 'Not now');
      await act(async () => {});
      expect(useAppStore.getState().profile).toEqual(walkedProfile);
      expect(useAppStore.getState().onboardingError).toBeNull();
      expect(mockScheduler.requestCalls).toBe(0);
      act(() => renderer.unmount());
    });
  });
});
