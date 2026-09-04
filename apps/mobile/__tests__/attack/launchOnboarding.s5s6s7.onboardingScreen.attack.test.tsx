/**
 * ADVERSARIAL S5 / S6 / S7 — OnboardingScreen against the REAL appStore,
 * notificationStore and accountScope (only the OS scheduler, SQLite kv and
 * authStore are stubbed).
 *
 *  S5  account mode, `useAppStore.onboardingBusy` externally true: pressing
 *      "Turn on reminders" must issue NO OS permission request and the label
 *      must read "Finishing setup…".
 *  S6  pre-auth: completeOnboardingStep('enable') rejects, then
 *      completePreAuthOnboarding rejects, press Not now, Back to the reveal,
 *      change the goal, finish again → completeOnboardingStep called exactly
 *      once and the second stash carries the new goal.
 *  S7  pre-auth: completePreAuthOnboarding never resolves → both buttons stay
 *      disabled; unmount → no setState-after-unmount, no onFinished after
 *      unmount (also when the hung promise finally resolves).
 */
import React from 'react';
import { Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { PermissionState } from '../../src/notifications/service';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  initialWindowMetrics: {
    frame: { x: 0, y: 0, width: 390, height: 844 },
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
  },
}));

const mockKv = new Map<string, string>();
const mockDbControl: { failNextWrites: number; writes: string[] } = {
  failNextWrites: 0,
  writes: [],
};
jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      const statement = sql.trim().replace(/\s+/g, ' ');
      if (statement.startsWith('SELECT value FROM kv')) {
        const value = mockKv.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
        if (mockDbControl.failNextWrites > 0) {
          mockDbControl.failNextWrites -= 1;
          throw new Error('SQLITE_FULL: database or disk is full');
        }
        mockKv.set(String(params[0]), String(params[1]));
        mockDbControl.writes.push(String(params[0]));
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
  requestCalls: 0,
  cancelAllCalls: 0,
  appliedPlans: [] as unknown[],
  async permissionState(): Promise<PermissionState> {
    return this.permission;
  },
  async requestPermission(): Promise<PermissionState> {
    this.requestCalls += 1;
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
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  PENDING_ONBOARDING_PROFILE_KV_KEY,
  useAppStore,
} from '../../src/state/appStore';
import {
  PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
  useNotificationStore,
} from '../../src/notifications/notificationStore';
import { OnboardingScreen } from '../../src/screens/OnboardingScreen';

type Renderer = TestRenderer.ReactTestRenderer;

const CANONICAL_OWNER = '7fc2c743-028f-4ec6-942c-a84508f3be38';

const realCompleteStep = useNotificationStore.getState().completeOnboardingStep;
const realCompletePreAuth = useAppStore.getState().completePreAuthOnboarding;

// Jest fails a test on any unhandled rejection. The attack needs to keep
// driving the screen AFTER such a rejection, so the runner's listeners are
// parked for this file and every rejection is recorded as evidence instead.
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};
type RejectionListener = (reason: unknown) => void;
interface RejectionEmitter {
  listeners(event: 'unhandledRejection'): RejectionListener[];
  removeAllListeners(event: 'unhandledRejection'): void;
  on(event: 'unhandledRejection', listener: RejectionListener): void;
  off(event: 'unhandledRejection', listener: RejectionListener): void;
}
const nodeProcess = (globalThis as unknown as { process: RejectionEmitter })
  .process;
let parkedListeners: RejectionListener[] = [];

beforeAll(() => {
  parkedListeners = nodeProcess.listeners('unhandledRejection');
  nodeProcess.removeAllListeners('unhandledRejection');
  nodeProcess.on('unhandledRejection', onUnhandled);
});
afterAll(() => {
  nodeProcess.off('unhandledRejection', onUnhandled);
  for (const listener of parkedListeners) {
    nodeProcess.on('unhandledRejection', listener);
  }
});

beforeEach(() => {
  mockKv.clear();
  mockDbControl.failNextWrites = 0;
  mockDbControl.writes = [];
  mockScheduler.permission = 'undetermined';
  mockScheduler.requestResult = 'granted';
  mockScheduler.requestCalls = 0;
  mockScheduler.cancelAllCalls = 0;
  mockScheduler.appliedPlans = [];
  unhandled.length = 0;
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAppStore.setState({
    hydrated: true,
    ownerKey: SIGNED_OUT_DATA_OWNER,
    profile: null,
    hydrateError: null,
    onboardingBusy: false,
    onboardingError: null,
    completePreAuthOnboarding: realCompletePreAuth,
  });
  useNotificationStore.setState({
    completeOnboardingStep: realCompleteStep,
    permission: 'undetermined',
  });
});

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

function findPressable(renderer: Renderer, label: string) {
  const nodes = pressables(renderer, label);
  expect(nodes.length).toBeGreaterThan(0);
  return nodes[0]!;
}

/** The primary notification control relabels itself while busy. */
function primaryNotificationButton(renderer: Renderer) {
  const nodes = [
    ...pressables(renderer, 'Turn on reminders'),
    ...pressables(renderer, 'Finishing setup…'),
  ];
  expect(nodes.length).toBe(1);
  return nodes[0]!;
}

function press(renderer: Renderer, label: string) {
  const node = findPressable(renderer, label);
  expect(node.props.disabled).toBeFalsy();
  act(() => {
    node.props.onPress();
  });
}

/** Fires onPress regardless of `disabled` — a queued tap / a11y activation. */
async function forcePress(renderer: Renderer, label: string) {
  const node =
    label === 'Turn on reminders'
      ? primaryNotificationButton(renderer)
      : findPressable(renderer, label);
  await act(async () => {
    node.props.onPress();
  });
}

async function flush(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function walkToReveal(renderer: Renderer) {
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
  expect(allText(renderer)).toContain('Built for Dana.');
}

function stash(): { version: number; profile: { goal: string } } | null {
  const raw = mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY);
  return raw ? JSON.parse(raw) : null;
}

// ─── S5 ──────────────────────────────────────────────────────────────────────

describe('S5 account mode: Turn on reminders while onboardingBusy is externally true', () => {
  it('issues no OS permission request and labels the control "Finishing setup…"', async () => {
    setActiveDataOwner(CANONICAL_OWNER);
    useAppStore.setState({ ownerKey: CANONICAL_OWNER });
    const renderer = renderScreen({ mode: 'account' });
    walkToReveal(renderer);
    press(renderer, 'Continue');
    expect(allText(renderer)).toContain('Stay match-ready.');

    // Another actor (e.g. a completeOnboarding still in flight from a
    // different screen instance) holds the store busy.
    act(() => {
      useAppStore.setState({ onboardingBusy: true });
    });

    const enable = primaryNotificationButton(renderer);
    const notNow = findPressable(renderer, 'Not now');
    expect(enable.props.disabled).toBe(true);
    expect(notNow.props.disabled).toBe(true);
    expect(allText(renderer)).toContain('Finishing setup…');
    expect(allText(renderer)).not.toContain('Turn on reminders');

    // Hammer both controls anyway (disabled is a UI hint; the handler is the
    // real guard).
    for (let i = 0; i < 5; i += 1) {
      await forcePress(renderer, 'Turn on reminders');
      await forcePress(renderer, 'Not now');
    }
    await flush();

    console.log(
      JSON.stringify({
        scenario: 'S5',
        requestCalls: mockScheduler.requestCalls,
        label: allText(renderer).includes('Finishing setup…')
          ? 'Finishing setup…'
          : 'other',
        profile: useAppStore.getState().profile,
        kvWrites: mockDbControl.writes,
        prefs: useNotificationStore.getState().prefs,
      }),
    );
    expect(mockScheduler.requestCalls).toBe(0);
    expect(useAppStore.getState().profile).toBeNull();
    expect(mockDbControl.writes).toEqual([]);
    expect(allText(renderer)).toContain('Finishing setup…');

    // Release the external busy flag: the real press works exactly once.
    act(() => {
      useAppStore.setState({ onboardingBusy: false });
    });
    expect(primaryNotificationButton(renderer).props.disabled).toBe(false);
    await forcePress(renderer, 'Turn on reminders');
    await flush();
    expect(mockScheduler.requestCalls).toBe(1);
    expect(useAppStore.getState().profile?.goal).toBe('drops');
    expect(useNotificationStore.getState().prefs.enabled).toBe(true);
    act(() => renderer.unmount());
  });
});

// ─── S6 ──────────────────────────────────────────────────────────────────────

describe('S6 pre-auth: notification step rejects, stash rejects, Not now, back, change goal, finish again', () => {
  it('asks the notification store once overall and the second stash carries the new goal', async () => {
    const stepCalls: string[] = [];
    let stepRejects = 1;
    useNotificationStore.setState({
      completeOnboardingStep: async (choice, deps) => {
        stepCalls.push(choice);
        if (stepRejects > 0) {
          stepRejects -= 1;
          throw new Error('UNUserNotificationCenter unavailable');
        }
        return realCompleteStep(choice, deps);
      },
    });
    const preAuthCalls: Array<{ goal: string }> = [];
    let preAuthRejects = 1;
    useAppStore.setState({
      completePreAuthOnboarding: async profile => {
        preAuthCalls.push({ goal: profile.goal });
        if (preAuthRejects > 0) {
          preAuthRejects -= 1;
          throw new Error('kv write exploded');
        }
        return realCompletePreAuth(profile);
      },
    });

    const onFinished = jest.fn();
    const onBack = jest.fn();
    const renderer = renderScreen({ mode: 'preauth', onFinished, onBack });
    walkToReveal(renderer);
    press(renderer, 'Continue');
    expect(allText(renderer)).toContain('Stay match-ready.');

    // 1. Turn on reminders → completeOnboardingStep('enable') rejects.
    await forcePress(renderer, 'Turn on reminders');
    await flush();
    const afterStepReject = {
      stepCalls: [...stepCalls],
      preAuthCalls: preAuthCalls.length,
      enableDisabled: primaryNotificationButton(renderer).props.disabled,
      unhandled: unhandled.length,
      text: allText(renderer),
    };
    expect(onFinished).not.toHaveBeenCalled();
    // The screen must recover: controls usable again.
    expect(afterStepReject.enableDisabled).toBe(false);

    // 2. Retry: the step resolves now, but the stash write rejects.
    await forcePress(renderer, 'Turn on reminders');
    await flush();
    const afterPreAuthReject = {
      stepCalls: [...stepCalls],
      preAuthCalls: preAuthCalls.length,
      enableDisabled: primaryNotificationButton(renderer).props.disabled,
      unhandled: unhandled.length,
      onboardingError: useAppStore.getState().onboardingError,
      textHasError: allText(renderer).includes('kv write exploded'),
    };
    expect(onFinished).not.toHaveBeenCalled();
    expect(afterPreAuthReject.enableDisabled).toBe(false);

    // 3. Not now (the store already holds a notification choice) → the real
    //    stash write succeeds — but the test keeps the screen mounted to
    //    exercise the back-and-edit path the coordinator asked for.
    const stepCallsBeforeNotNow = stepCalls.length;
    await forcePress(renderer, 'Not now');
    await flush();
    const stashAfterNotNow = stash();

    // 4. Back to the reveal, back to the goal, change it, finish again.
    press(renderer, 'Back'); // notifications → reveal
    expect(allText(renderer)).toContain('Built for Dana.');
    press(renderer, 'Back'); // reveal → problem
    press(renderer, 'Back'); // problem → goal
    expect(allText(renderer)).toContain('What do you want to own?');
    press(renderer, 'Serve');
    press(renderer, 'Continue');
    press(renderer, 'Continue');
    expect(allText(renderer)).toContain('Built for Dana.');
    press(renderer, 'Continue');
    expect(allText(renderer)).toContain('Stay match-ready.');
    await forcePress(renderer, 'Not now');
    await flush();
    const finalStash = stash();

    console.log(
      JSON.stringify({
        scenario: 'S6',
        afterStepReject: { ...afterStepReject, text: undefined },
        afterPreAuthReject,
        stepCallsBeforeNotNow,
        stepCallsAfterNotNow: stepCalls.length,
        stashAfterNotNow,
        preAuthCalls,
        finalStash,
        onFinished: onFinished.mock.calls.length,
        unhandledRejections: unhandled.map(e =>
          e instanceof Error ? e.message : String(e),
        ),
        notificationStash: mockKv.get(PENDING_NOTIFICATION_ONBOARDING_KV_KEY),
        onboardingError: useAppStore.getState().onboardingError,
      }),
    );

    // Coordinator assertions.
    expect(finalStash?.profile.goal).toBe('serve');
    expect(finalStash?.profile).toMatchObject({
      firstName: 'Dana',
      goal: 'serve',
      focusCheckpoint: 'sequencing',
    });
    // A failed step must not surface as an unhandled promise rejection
    // (RN swallows these silently in release: the tap just "does nothing").
    expect(unhandled).toEqual([]);
    // The user's LAST notification choice was "Not now" — the device stash
    // must not still say reminders are on.
    expect(
      JSON.parse(mockKv.get(PENDING_NOTIFICATION_ONBOARDING_KV_KEY) ?? 'null'),
    ).toEqual({ version: 1, enabled: false });
    expect(stepCalls).toHaveLength(1);
    act(() => renderer.unmount());
  });

  it('(documented failure modes) permission denied + stash write failure, then Not now, back, new goal', async () => {
    mockScheduler.requestResult = 'denied';
    mockDbControl.failNextWrites = 2; // notification stash + profile stash fail
    const onFinished = jest.fn();
    const renderer = renderScreen({
      mode: 'preauth',
      onFinished,
      onBack: jest.fn(),
    });
    walkToReveal(renderer);
    press(renderer, 'Continue');
    await forcePress(renderer, 'Turn on reminders');
    await flush();
    expect(mockScheduler.requestCalls).toBe(1);
    expect(onFinished).not.toHaveBeenCalled();
    expect(useAppStore.getState().onboardingError).toContain('SQLITE_FULL');
    expect(findPressable(renderer, 'Not now').props.disabled).toBe(false);

    press(renderer, 'Back');
    press(renderer, 'Back');
    press(renderer, 'Back');
    press(renderer, 'Serve');
    press(renderer, 'Continue');
    press(renderer, 'Continue');
    press(renderer, 'Continue');
    await forcePress(renderer, 'Not now');
    await flush();
    console.log(
      JSON.stringify({
        scenario: 'S6-documented',
        requestCalls: mockScheduler.requestCalls,
        stash: stash(),
        notificationStash: mockKv.get(PENDING_NOTIFICATION_ONBOARDING_KV_KEY),
        onFinished: onFinished.mock.calls.length,
        onboardingError: useAppStore.getState().onboardingError,
      }),
    );
    expect(mockScheduler.requestCalls).toBe(1);
    expect(stash()?.profile.goal).toBe('serve');
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().onboardingError).toBeNull();
    expect(unhandled).toEqual([]);
    act(() => renderer.unmount());
  });
});

// ─── S7 ──────────────────────────────────────────────────────────────────────

describe('S7 pre-auth: completePreAuthOnboarding never resolves', () => {
  it('keeps both controls disabled, and unmounting produces no late setState / onFinished', async () => {
    let releaseHung!: (ok: boolean) => void;
    const hung = new Promise<boolean>(resolve => {
      releaseHung = resolve;
    });
    useAppStore.setState({
      completePreAuthOnboarding: async () => {
        useAppStore.setState({ onboardingBusy: true, onboardingError: null });
        return hung;
      },
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const onFinished = jest.fn();
    const renderer = renderScreen({
      mode: 'preauth',
      onFinished,
      onBack: jest.fn(),
    });
    walkToReveal(renderer);
    press(renderer, 'Continue');
    await forcePress(renderer, 'Turn on reminders');
    await flush();

    expect(mockScheduler.requestCalls).toBe(1);
    const enable = primaryNotificationButton(renderer);
    const notNow = findPressable(renderer, 'Not now');
    expect(enable.props.disabled).toBe(true);
    expect(notNow.props.disabled).toBe(true);
    expect(allText(renderer)).toContain('Finishing setup…');

    // Queued taps while hung: nothing extra happens.
    for (let i = 0; i < 4; i += 1) {
      await forcePress(renderer, 'Turn on reminders');
      await forcePress(renderer, 'Not now');
    }
    await flush();
    expect(mockScheduler.requestCalls).toBe(1);
    expect(primaryNotificationButton(renderer).props.disabled).toBe(true);
    expect(findPressable(renderer, 'Not now').props.disabled).toBe(true);
    expect(onFinished).not.toHaveBeenCalled();

    // Gate tears the screen down while the promise is still pending.
    act(() => renderer.unmount());
    await flush();
    const errorsAfterUnmount = errorSpy.mock.calls.length;
    const warnsAfterUnmount = warnSpy.mock.calls.length;
    expect(onFinished).not.toHaveBeenCalled();

    // …and the hung promise finally resolves long after the unmount.
    await act(async () => {
      releaseHung(true);
    });
    await flush();

    console.log(
      JSON.stringify({
        scenario: 'S7',
        errorsAfterUnmount,
        warnsAfterUnmount,
        consoleErrorsTotal: errorSpy.mock.calls.map(c =>
          String(c[0]).slice(0, 160),
        ),
        consoleWarnsTotal: warnSpy.mock.calls.map(c =>
          String(c[0]).slice(0, 160),
        ),
        onFinishedAfterUnmount: onFinished.mock.calls.length,
        unhandled: unhandled.length,
      }),
    );
    errorSpy.mockRestore();
    warnSpy.mockRestore();

    expect(errorsAfterUnmount).toBe(0);
    expect(warnsAfterUnmount).toBe(0);
    expect(errorSpy.mock.calls).toEqual([]);
    expect(onFinished).not.toHaveBeenCalled();
  });
});
