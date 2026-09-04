/**
 * stress/scr-onboardingscreen — lens `rapid-interaction`.
 *
 * Renders the REAL App.tsx Gate (SafeAreaProvider → QueryClientProvider →
 * RootErrorBoundary → Gate → Welcome / OnboardingScreen / sign-in / root)
 * with the real appStore + notificationStore (in-memory kv, fake OS
 * scheduler) and fake timers, then fires seeded bursts of user intents at
 * it: double/triple taps, rapid re-selection, Back and Continue in the
 * same frame, Back/Continue while the finish pipeline is held mid-flight,
 * spam navigation in and out of the questionnaire, and "simultaneous"
 * controls. After every op the rendered tree is diffed against the oracle in
 * `testing/stress/onboardingRapidModel.ts`.
 *
 * Invariants (every seed):
 *   - one effect per enabled tap; taps on disabled / absent / dialog-covered
 *     controls do nothing;
 *   - exactly one selected answer per question; Continue gates on it;
 *   - one finish pipeline per intent: one permission request (when asked),
 *     one notification-choice write, one stash/profile save, one navigation;
 *   - no orphan loading/busy affordance once quiescent; at most one dialog;
 *   - no act() warnings, no console errors, no unhandled rejections.
 *
 * Scale: `STRESS_ITER` seeds (default 8); replay one seed with
 * `STRESS_SEED=<n>`. Evidence: `artifacts/stress/<STRESS_RUN_ID>/…`.
 */
import React from 'react';
import { Modal, Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { PermissionState } from '../../src/notifications/service';
import type { Profile } from '../../src/state/profile';
import { deferred, type Deferred } from '../../testing/xcBehavioral/deferred';
import {
  CHOICES,
  OnboardingModel,
  SAVE_FAILURE_MESSAGE,
  apply,
  busy,
  generatePlan,
  isQuestionStep,
  stepComplete,
  stepOf,
  stressSeeds,
  type Op,
  type Plan,
  type TapOutcome,
} from '../../testing/stress/onboardingRapidModel';
import {
  appendResult,
  writeTable,
  type StressResult,
} from '../../testing/stress/evidence';

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Passthrough = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return {
    SafeAreaProvider: Passthrough,
    SafeAreaView: Passthrough,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: {
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 0, bottom: 0, left: 0, right: 0 },
    },
  };
});

jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Line: Mock,
    Path: Mock,
    Polyline: Mock,
    Rect: Mock,
    Defs: Mock,
    LinearGradient: Mock,
    Stop: Mock,
    G: Mock,
    Ellipse: Mock,
  };
});

/* ------------------------------------------------------------------ */
/* Controllable seams: kv writes, canonical save, OS permission        */
/* ------------------------------------------------------------------ */

// Mirrors SAVE_FAILURE_MESSAGE (jest.mock factories may only see `mock*`).
const mockSaveFailureMessage = 'stress: save rejected';
const mockKv = new Map<string, string>();
const mockKvWrites: Array<{ key: string; ok: boolean }> = [];
// Per-seed write policy, installed by the executor.
// The stash (pre-auth) and the owner profile row (account) are the same
// "save" seam: whichever one this seed's mode reaches gets held.
type MockSeam = 'permission' | 'notifKv' | 'save';
const mockSeams: {
  hold: MockSeam | null;
  held: Deferred<void> | null;
  saveFailures: number;
  saveAttempts: number;
  notifKvFails: boolean;
  notifKvAttempts: number;
} = {
  hold: null,
  held: null,
  saveFailures: 0,
  saveAttempts: 0,
  notifKvFails: false,
  notifKvAttempts: 0,
};

function mockKeyClass(key: string): 'notifKv' | 'stash' | 'profileKv' | null {
  if (key === 'onboarding.pending-notifications') return 'notifKv';
  if (key.startsWith('notifications:')) return 'notifKv';
  if (key === 'onboarding.pending-profile') return 'stash';
  if (key.startsWith('profile:')) return 'profileKv';
  return null;
}

function mockSeamOf(cls: 'notifKv' | 'stash' | 'profileKv'): MockSeam {
  return cls === 'notifKv' ? 'notifKv' : 'save';
}

async function mockHoldIf(seam: MockSeam) {
  if (mockSeams.hold === seam && mockSeams.held === null) {
    mockSeams.held = deferred<void>();
    await mockSeams.held.promise;
  }
}

/** The held seam (reached or not yet) is released for this seed. */
function releaseSeam() {
  mockSeams.hold = null;
  if (mockSeams.held && !mockSeams.held.settled) mockSeams.held.resolve();
}

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      const statement = sql.trim().replace(/\s+/g, ' ');
      if (statement.startsWith('SELECT value FROM kv')) {
        const value = mockKv.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
        const key = String(params[0]);
        const cls = mockKeyClass(key);
        if (cls) await mockHoldIf(mockSeamOf(cls));
        if (cls === 'notifKv') {
          mockSeams.notifKvAttempts += 1;
          if (mockSeams.notifKvFails) {
            mockKvWrites.push({ key, ok: false });
            throw new Error('stress: notification kv rejected');
          }
        }
        if (cls === 'stash') {
          mockSeams.saveAttempts += 1;
          if (mockSeams.saveAttempts <= mockSeams.saveFailures) {
            mockKvWrites.push({ key, ok: false });
            throw new Error(mockSaveFailureMessage);
          }
        }
        mockKv.set(key, String(params[1]));
        mockKvWrites.push({ key, ok: true });
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

interface MockSession {
  provider: 'guest' | 'apple';
  subject: string;
  canonicalAppUserId: string | null;
  localOnly: boolean;
  displayName: string | null;
  email: string | null;
}
interface MockAuthState {
  hydrated: boolean;
  session: MockSession | null;
  hydrate: () => Promise<void>;
  signOut: () => Promise<void>;
}
const CANONICAL_ID = '33333333-3333-4333-8333-333333333333';
// Session the auth hydrate restores (null = fresh device → Welcome).
const mockAuth: { initialSession: MockSession | null; signOutCalls: number } = {
  initialSession: null,
  signOutCalls: 0,
};
jest.mock('../../src/auth/authStore', () => {
  const { create } = jest.requireActual<typeof import('zustand')>('zustand');
  const scope = jest.requireActual<
    typeof import('../../src/data/accountScope')
  >('../../src/data/accountScope');
  const useAuthStore = create<MockAuthState>(set => ({
    hydrated: false,
    session: null,
    hydrate: async () => {
      const session = mockAuth.initialSession;
      scope.setActiveDataOwner(
        session?.canonicalAppUserId
          ? scope.canonicalDataOwner(session.canonicalAppUserId)
          : scope.SIGNED_OUT_DATA_OWNER,
      );
      set({ hydrated: true, session });
    },
    signOut: async () => {
      mockAuth.signOutCalls += 1;
      scope.setActiveDataOwner(scope.SIGNED_OUT_DATA_OWNER);
      set({ session: null });
    },
  }));
  return { useAuthStore };
});

let mockApiSession: {
  apiBaseUrl: string;
  bearerToken: string;
  canonicalAppUserId: string;
  provider: 'apple';
} | null = null;
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => mockApiSession,
}));

const mockSaveCanonical = jest.fn<Promise<Profile>, [unknown, Profile]>();
jest.mock('../../src/account/onboarding', () => ({
  fetchCanonicalOnboardingProfile: async () => null,
  saveCanonicalOnboardingProfile: (session: unknown, profile: Profile) =>
    mockSaveCanonical(session, profile),
}));

const mockScheduler = {
  permission: 'undetermined' as PermissionState,
  requestResult: 'granted' as PermissionState | 'throws',
  requestCalls: 0,
  cancelAllCalls: 0,
  appliedPlans: [] as unknown[],
  async permissionState(): Promise<PermissionState> {
    return this.permission;
  },
  async requestPermission(): Promise<PermissionState> {
    this.requestCalls += 1;
    await mockHoldIf('permission');
    const result = this.requestResult;
    if (result === 'throws') {
      throw new Error('stress: permission prompt failed');
    }
    this.permission = result;
    return result;
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

const mockMounts = { signin: 0, root: 0 };
jest.mock('../../src/navigation/RootNavigator', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    RootNavigator: () => {
      React.useEffect(() => {
        mockMounts.root += 1;
      }, []);
      return React.createElement(Text, null, 'ROOT_NAVIGATOR');
    },
  };
});
jest.mock('../../src/screens/SignInScreen', () => {
  const React = require('react');
  const { Pressable, Text, View } = require('react-native');
  return {
    SignInScreen: (props: { onBack?: () => void }) => {
      React.useEffect(() => {
        mockMounts.signin += 1;
      }, []);
      return React.createElement(
        View,
        null,
        React.createElement(Text, null, 'SIGN_IN_SCREEN'),
        React.createElement(
          Pressable,
          { accessibilityLabel: 'Back', onPress: props.onBack },
          React.createElement(Text, null, 'Back'),
        ),
      );
    },
  };
});
jest.mock('../../src/screens/SplashScreen', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    SplashScreen: (props: { ready: boolean; onFinished: () => void }) => {
      React.useEffect(() => {
        if (props.ready) props.onFinished();
      }, [props.ready, props.onFinished]);
      return React.createElement(Text, null, 'SPLASH');
    },
  };
});
jest.mock('../../src/components/RankUpCelebration', () => ({
  RankUpCelebration: () => null,
}));
jest.mock('../../src/consistency/StreakCelebration', () => ({
  StreakCelebration: () => null,
}));
jest.mock('../../src/walkthrough/FirstRunWalkthrough', () => ({
  FirstRunWalkthrough: () => null,
}));
jest.mock('../../src/walkthrough/walkthroughStore', () => {
  const state = { maybeShowFirstRun: async () => {} };
  return {
    useWalkthroughStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});
jest.mock('../../src/consistency/useConsistencyBootstrap', () => ({
  useConsistencyBootstrap: () => {},
}));

import App from '../../App';
import { useAuthStore } from '../../src/auth/authStore';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  PENDING_ONBOARDING_PROFILE_KV_KEY,
  useAppStore,
} from '../../src/state/appStore';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import { DEFAULT_NOTIFICATION_PREFS } from '../../src/notifications/types';

// The mobile tsconfig excludes node typings (types: ["jest"]); the two
// process members this suite needs are declared locally.
declare const process: {
  env: Record<string, string | undefined>;
  on: (
    event: 'unhandledRejection',
    listener: (reason: unknown) => void,
  ) => void;
  off: (
    event: 'unhandledRejection',
    listener: (reason: unknown) => void,
  ) => void;
};

type Renderer = TestRenderer.ReactTestRenderer;
type Node = TestRenderer.ReactTestInstance;

const LENS = 'scr-onboardingscreen/rapid-interaction';
const DEFAULT_ITERATIONS = 8;
// STRESS_SAME_TICK=1 also dispatches both finish controls in one tick (a
// probe of the closure-based busy guard that touch input cannot produce).
const SAME_TICK = process.env['STRESS_SAME_TICK'] === '1';
const SUITE = SAME_TICK ? `${LENS}/same-tick` : LENS;

/* ------------------------------------------------------------------ */
/* Tree helpers                                                        */
/* ------------------------------------------------------------------ */

function allText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string | number => typeof c !== 'object')
    .join('\u0001');
}

function countText(renderer: Renderer, needle: string): number {
  return renderer.root.findAllByType(Text).filter(node => {
    const children = Array.isArray(node.props.children)
      ? node.props.children
      : [node.props.children];
    return children
      .filter((c: unknown): c is string | number => typeof c !== 'object')
      .join('')
      .includes(needle);
  }).length;
}

function isAncestor(ancestor: Node, node: Node): boolean {
  let current = node.parent;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function innermost(matches: Node[]): Node[] {
  return matches.filter(
    node => !matches.some(other => other !== node && isAncestor(node, other)),
  );
}

function visibleModals(renderer: Renderer): Node[] {
  return renderer.root
    .findAllByType(Modal)
    .filter(node => node.props.visible !== false);
}

function pressables(renderer: Renderer, label: string): Node[] {
  return innermost(
    renderer.root.findAll(
      node =>
        node.props?.accessibilityLabel === label &&
        typeof node.props?.onPress === 'function',
    ),
  );
}

/** The control a finger could land on right now, or why it cannot. */
function resolveTarget(
  renderer: Renderer,
  label: string,
): { node: Node | null; outcome: TapOutcome } {
  const nodes = pressables(renderer, label);
  if (nodes.length === 0) return { node: null, outcome: 'absent' };
  // Duplicate reachable controls with one label would be a bug on its own.
  expect(nodes).toHaveLength(1);
  const node = nodes[0]!;
  const modals = visibleModals(renderer);
  if (modals.length > 0 && !modals.some(modal => isAncestor(modal, node))) {
    return { node, outcome: 'blocked' };
  }
  if (node.props.disabled) return { node, outcome: 'blocked' };
  return { node, outcome: 'applied' };
}

/** One tap, RNTL `fireEvent.press` semantics: disabled or covered controls
 * swallow the touch; an enabled one fires its handler inside act(). */
function tap(renderer: Renderer, label: string): TapOutcome {
  const target = resolveTarget(renderer, label);
  if (target.outcome !== 'applied') return target.outcome;
  act(() => {
    target.node!.props.onPress();
  });
  return 'applied';
}

function nameInput(renderer: Renderer): Node | null {
  const inputs = renderer.root
    .findAllByType(TextInput)
    .filter(node => node.props.accessibilityLabel === 'First name');
  return inputs[0] ?? null;
}

async function settle(rounds = 3) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
    });
  }
}

async function advance(ms: number) {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
  await settle(1);
}

/* ------------------------------------------------------------------ */
/* Executor                                                            */
/* ------------------------------------------------------------------ */

interface OpTrace {
  op: Op;
  real: TapOutcome[];
  model: TapOutcome[];
}

function runOp(renderer: Renderer, op: Op): TapOutcome[] {
  const out: TapOutcome[] = [];
  const times = (n: number, label: string) => {
    for (let i = 0; i < n; i += 1) out.push(tap(renderer, label));
  };
  switch (op.kind) {
    case 'getStarted':
      times(op.taps, 'Start your first read');
      break;
    case 'alreadyAccount':
      times(op.taps, 'I already have an account');
      break;
    case 'signinBack':
    case 'back':
      times(op.taps, 'Back');
      break;
    case 'continue':
      times(op.taps, 'Continue');
      break;
    case 'leave':
      times(op.taps, 'Leave setup');
      break;
    case 'keepSettingUp':
      times(op.taps, 'Keep setting up');
      break;
    case 'signOut':
      times(op.taps, 'Sign out');
      break;
    case 'finish':
      times(op.taps, op.choice === 'enable' ? 'Turn on reminders' : 'Not now');
      break;
    case 'select':
      for (const label of op.labels) out.push(tap(renderer, label));
      break;
    case 'typeName': {
      const input = nameInput(renderer);
      if (!input || visibleModals(renderer).length > 0) {
        out.push('absent');
        break;
      }
      act(() => input.props.onChangeText(op.text));
      out.push('applied');
      break;
    }
    case 'submitName': {
      for (let i = 0; i < op.taps; i += 1) {
        const input = nameInput(renderer);
        if (!input || visibleModals(renderer).length > 0) {
          out.push('absent');
          continue;
        }
        // The keyboard's Next key always reaches the handler; the handler
        // itself gates on the name — the model reports that as 'blocked'.
        const before = allText(renderer);
        act(() => input.props.onSubmitEditing());
        out.push(allText(renderer) === before ? 'blocked' : 'applied');
      }
      break;
    }
    case 'simultaneous': {
      // Both handlers the user saw at the start of the frame fire in the
      // same act(): neither has re-rendered the other away yet.
      const a = resolveTarget(renderer, op.a);
      const b = resolveTarget(renderer, op.b);
      act(() => {
        if (a.outcome === 'applied') a.node!.props.onPress();
        if (b.outcome === 'applied') b.node!.props.onPress();
      });
      out.push(a.outcome, b.outcome);
      break;
    }
    case 'release':
      releaseSeam();
      break;
    case 'idle':
      break;
  }
  return out;
}

/** Diffs the rendered tree against the oracle. Throws with a precise
 * message on the first divergence. */
function assertTreeMatches(
  renderer: Renderer,
  model: OnboardingModel,
  where: string,
) {
  const s = model.state;
  const text = allText(renderer);
  const markers: Record<string, boolean> = {
    welcome: text.includes('See the stroke.'),
    onboarding:
      text.includes('PLAYER SETUP') ||
      text.includes('YOUR STARTING PLAN') ||
      text.includes('STAY IN RHYTHM'),
    signin: text.includes('SIGN_IN_SCREEN'),
    root: text.includes('ROOT_NAVIGATOR'),
    loading:
      text.includes('Getting things ready') ||
      text.includes('Loading your account'),
    splash: text.includes('SPLASH'),
  };
  const shown = Object.keys(markers).filter(k => markers[k]);
  if (shown.length !== 1 || shown[0] !== s.stage) {
    throw new Error(
      `${where}: expected stage ${s.stage}, screen shows [${shown.join(', ')}]`,
    );
  }
  const modals = visibleModals(renderer);
  const wantModal = s.stage === 'onboarding' && s.confirmingLeave ? 1 : 0;
  if (modals.length !== wantModal) {
    throw new Error(
      `${where}: expected ${wantModal} visible dialog(s), found ${modals.length}`,
    );
  }
  if (s.stage !== 'onboarding') return;

  if (countText(renderer, 'PLAYER SETUP') > 1) {
    throw new Error(`${where}: duplicate onboarding screen rendered`);
  }
  const step = stepOf(s);
  const counter = `${s.stepIndex + 1}`;
  const counterNodes = renderer.root.findAllByType(Text).filter(node => {
    const c = node.props.children;
    return (
      Array.isArray(c) &&
      String(c[0]) === counter &&
      c[1] === '/' &&
      String(c[2]) === '8'
    );
  });
  if (counterNodes.length !== 1) {
    throw new Error(
      `${where}: expected step counter ${counter}/8 once, found ${counterNodes.length}`,
    );
  }
  if (wantModal === 1) {
    if (
      pressables(renderer, 'Keep setting up').length !== 1 ||
      pressables(renderer, 'Sign out').length !== 1 ||
      !text.includes('Leave setup?')
    ) {
      throw new Error(`${where}: leave dialog missing its actions`);
    }
  }

  if (step === 'name') {
    const input = nameInput(renderer);
    if (!input) throw new Error(`${where}: name input missing`);
    const want = s.answers['name'] ?? '';
    if (input.props.value !== want) {
      throw new Error(
        `${where}: name input shows ${JSON.stringify(input.props.value)}, expected ${JSON.stringify(want)}`,
      );
    }
  }
  if (isQuestionStep(step)) {
    const radios = innermost(
      renderer.root.findAll(
        node =>
          node.props?.accessibilityRole === 'radio' &&
          typeof node.props?.onPress === 'function',
      ),
    );
    if (radios.length !== CHOICES[step].length) {
      throw new Error(
        `${where}: ${step} shows ${radios.length} choices, expected ${CHOICES[step].length}`,
      );
    }
    const selected = radios.filter(
      node => node.props.accessibilityState?.selected === true,
    );
    const wantValue = s.answers[step];
    const wantLabel = CHOICES[step].find(([, v]) => v === wantValue)?.[0];
    const gotLabels = selected.map(node => node.props.accessibilityLabel);
    if (
      wantLabel === undefined
        ? selected.length !== 0
        : gotLabels.join() !== wantLabel
    ) {
      throw new Error(
        `${where}: ${step} selected [${gotLabels.join(', ')}], expected [${wantLabel ?? ''}]`,
      );
    }
  }
  if (step !== 'notifications') {
    const cont = pressables(renderer, 'Continue');
    if (cont.length !== 1) {
      throw new Error(`${where}: expected one Continue, found ${cont.length}`);
    }
    const disabled = Boolean(cont[0]!.props.disabled);
    if (disabled !== !stepComplete(s)) {
      throw new Error(
        `${where}: Continue disabled=${disabled} but step ${step} complete=${stepComplete(s)}`,
      );
    }
    if (text.includes('Finishing setup…')) {
      throw new Error(
        `${where}: busy label rendered off the notifications step`,
      );
    }
    return;
  }
  // notifications step
  const isBusy = busy(s);
  const finishing = countText(renderer, 'Finishing setup…');
  const enable = pressables(renderer, 'Turn on reminders');
  const notNow = pressables(renderer, 'Not now');
  if (isBusy) {
    if (finishing !== 1 || enable.length !== 0) {
      throw new Error(
        `${where}: busy pipeline but busy-label×${finishing}, enable×${enable.length}`,
      );
    }
    if (notNow.length !== 1 || !notNow[0]!.props.disabled) {
      throw new Error(`${where}: "Not now" must be disabled while finishing`);
    }
  } else {
    if (finishing !== 0 || enable.length !== 1 || enable[0]!.props.disabled) {
      throw new Error(
        `${where}: quiescent but busy-label×${finishing}, enable×${enable.length} disabled=${String(enable[0]?.props.disabled)}`,
      );
    }
    if (notNow.length !== 1 || notNow[0]!.props.disabled) {
      throw new Error(`${where}: "Not now" must be enabled when quiescent`);
    }
  }
  const errorShown = text.includes(SAVE_FAILURE_MESSAGE);
  if (errorShown !== (s.storeError !== null)) {
    throw new Error(
      `${where}: save error shown=${errorShown}, expected ${s.storeError !== null}`,
    );
  }
}

/** Side-effect accounting, checked only when nothing is in flight. */
function assertQuiescentEffects(model: OnboardingModel, where: string) {
  const c = model.state.counters;
  const problems: string[] = [];
  if (mockScheduler.requestCalls !== c.permissionRequests) {
    problems.push(
      `permission requests ${mockScheduler.requestCalls} ≠ ${c.permissionRequests}`,
    );
  }
  const notifWrites = mockKvWrites.filter(
    w => mockKeyClass(w.key) === 'notifKv',
  ).length;
  if (notifWrites !== c.notifKvWrites) {
    problems.push(
      `notification-choice writes ${notifWrites} ≠ ${c.notifKvWrites}`,
    );
  }
  const stashAttempts = mockKvWrites.filter(
    w => mockKeyClass(w.key) === 'stash',
  ).length;
  const saveAttempts = stashAttempts + mockSaveCanonical.mock.calls.length;
  if (saveAttempts !== c.saveAttempts) {
    problems.push(`save attempts ${saveAttempts} ≠ ${c.saveAttempts}`);
  }
  const stashOk = mockKvWrites.filter(
    w => mockKeyClass(w.key) === 'stash' && w.ok,
  ).length;
  const profileOk = mockKvWrites.filter(
    w => mockKeyClass(w.key) === 'profileKv' && w.ok,
  ).length;
  if (stashOk + profileOk !== c.saveOk) {
    problems.push(`successful saves ${stashOk + profileOk} ≠ ${c.saveOk}`);
  }
  if (mockMounts.signin !== c.signinMounts) {
    problems.push(`sign-in mounts ${mockMounts.signin} ≠ ${c.signinMounts}`);
  }
  if (mockMounts.root !== c.rootMounts) {
    problems.push(`root mounts ${mockMounts.root} ≠ ${c.rootMounts}`);
  }
  if (mockAuth.signOutCalls !== c.signOuts) {
    problems.push(`sign-outs ${mockAuth.signOutCalls} ≠ ${c.signOuts}`);
  }
  if (useAppStore.getState().onboardingBusy) {
    problems.push('appStore.onboardingBusy stuck true');
  }
  const persisted = model.state.persistedProfile;
  if (persisted) {
    const raw = mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY);
    const stash = raw
      ? (JSON.parse(raw) as { profile: Profile }).profile
      : null;
    const owned = [...mockKv.entries()].find(([k]) => k.startsWith('profile:'));
    const profile = owned ? (JSON.parse(owned[1]) as Profile) : null;
    const got = stash ?? profile;
    if (JSON.stringify(got) !== JSON.stringify(persisted)) {
      problems.push(
        `persisted profile ${JSON.stringify(got)} ≠ ${JSON.stringify(persisted)}`,
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(`${where}: ${problems.join('; ')}`);
  }
}

interface Capture {
  errors: string[];
  warnings: string[];
  rejections: string[];
}

function installCapture(): { capture: Capture; restore: () => void } {
  const capture: Capture = { errors: [], warnings: [], rejections: [] };
  const origError = console.error;
  const origWarn = console.warn;
  console.error = (...args: unknown[]) => {
    capture.errors.push(args.map(String).join(' '));
  };
  console.warn = (...args: unknown[]) => {
    capture.warnings.push(args.map(String).join(' '));
  };
  const onRejection = (reason: unknown) => {
    capture.rejections.push(
      reason instanceof Error ? reason.message : String(reason),
    );
  };
  process.on('unhandledRejection', onRejection);
  return {
    capture,
    restore: () => {
      console.error = origError;
      console.warn = origWarn;
      process.off('unhandledRejection', onRejection);
    },
  };
}

function resetWorld(plan: Plan) {
  mockKv.clear();
  mockKvWrites.length = 0;
  mockSeams.hold =
    plan.faults.hold === 'stash' || plan.faults.hold === 'profileKv'
      ? 'save'
      : plan.faults.hold;
  mockSeams.held = null;
  mockSeams.saveFailures = plan.faults.saveFailures;
  mockSeams.saveAttempts = 0;
  mockSeams.notifKvFails = plan.faults.notifKvFails;
  mockSeams.notifKvAttempts = 0;
  mockScheduler.permission = 'undetermined';
  mockScheduler.requestResult = plan.faults.permission;
  mockScheduler.requestCalls = 0;
  mockScheduler.cancelAllCalls = 0;
  mockScheduler.appliedPlans = [];
  mockMounts.signin = 0;
  mockMounts.root = 0;
  mockAuth.signOutCalls = 0;
  mockSaveCanonical.mockReset();
  mockSaveCanonical.mockImplementation(async (_s, profile) => {
    await mockHoldIf('save');
    mockSeams.saveAttempts += 1;
    if (mockSeams.saveAttempts <= mockSeams.saveFailures) {
      throw new Error(SAVE_FAILURE_MESSAGE);
    }
    return profile;
  });
  if (plan.mode === 'account') {
    mockAuth.initialSession = {
      provider: 'apple',
      subject: 'apple-subject',
      canonicalAppUserId: CANONICAL_ID,
      localOnly: false,
      displayName: null,
      email: null,
    };
    mockApiSession = {
      apiBaseUrl: 'https://api.example.test',
      bearerToken: 'token',
      canonicalAppUserId: CANONICAL_ID,
      provider: 'apple',
    };
  } else {
    mockAuth.initialSession = null;
    mockApiSession = null;
  }
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({ hydrated: false, session: null });
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
    onboardingBusy: false,
    onboardingError: null,
  });
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
  });
}

async function runSeed(seed: number): Promise<StressResult> {
  expect(mockSaveFailureMessage).toBe(SAVE_FAILURE_MESSAGE);
  const plan = generatePlan(seed, { sameTickFinish: SAME_TICK });
  const model = new OnboardingModel(plan.mode, plan.faults);
  resetWorld(plan);
  const { capture, restore } = installCapture();
  const traces: OpTrace[] = [];
  const started = Date.now();
  let renderer: Renderer | null = null;
  let verdict: StressResult['verdict'] = 'pass';
  let failure: string | null = null;
  let executedOps = 0;
  try {
    await act(async () => {
      renderer = TestRenderer.create(<App />);
    });
    await settle();
    const r = renderer as unknown as Renderer;
    assertTreeMatches(r, model, 'launch');
    for (let i = 0; i < plan.steps.length; i += 1) {
      const { op, gap } = plan.steps[i]!;
      const where = `seed ${seed} (${plan.mode}, faults ${JSON.stringify(plan.faults)}) op#${i} ${JSON.stringify(op)} gap=${gap}`;
      const real = runOp(r, op);
      const expected = apply(model, op);
      executedOps += 1;
      traces.push({ op, real, model: expected });
      if (real.join() !== expected.join()) {
        throw new Error(
          `${where}: tap outcomes [${real.join(', ')}] ≠ model [${expected.join(', ')}]`,
        );
      }
      if (gap === 'micro') await settle();
      else if (gap === 'frame') await advance(16);
      else if (gap === 'long') await advance(400);
      if (gap !== 'none') model.settle();
      assertTreeMatches(r, model, where);
      if (gap !== 'none' && model.state.finishing === null) {
        assertQuiescentEffects(model, where);
      }
    }
    // Drain: whatever is still pending must complete without leaving a busy
    // affordance behind.
    releaseSeam();
    model.release();
    act(() => {
      jest.runOnlyPendingTimers();
    });
    await settle();
    model.settle();
    assertTreeMatches(r, model, `seed ${seed} drain`);
    assertQuiescentEffects(model, `seed ${seed} drain`);
    const actWarnings = [...capture.errors, ...capture.warnings].filter(
      m => m.includes('act(') || m.includes('not wrapped in act'),
    );
    if (actWarnings.length > 0) {
      throw new Error(`seed ${seed}: act() warnings: ${actWarnings[0]}`);
    }
    if (capture.rejections.length > 0) {
      throw new Error(
        `seed ${seed}: unhandled rejections: ${capture.rejections.join(' | ')}`,
      );
    }
    if (capture.errors.length > 0) {
      throw new Error(`seed ${seed}: console.error: ${capture.errors[0]}`);
    }
  } catch (error) {
    verdict = 'fail';
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    if (renderer) {
      const r = renderer as unknown as Renderer;
      act(() => r.unmount());
    }
    releaseSeam();
    restore();
  }
  const outcomes = traces.flatMap(t => t.real);
  const result: StressResult = {
    suite: SUITE,
    seed,
    mode: plan.mode,
    faults: { ...plan.faults },
    ops: plan.steps.length,
    executedOps,
    intents: plan.intents,
    applied: outcomes.filter(o => o === 'applied').length,
    blocked: outcomes.filter(o => o === 'blocked').length,
    absent: outcomes.filter(o => o === 'absent').length,
    counters: { ...model.state.counters },
    finalStage: model.state.stage,
    observations: [...model.state.observations],
    consoleWarnings: capture.warnings.length,
    verdict,
    failure,
    durationMs: Date.now() - started,
    replay: `STRESS_SEED=${seed} npx jest --ci __tests__/stress/onboardingRapidInteraction`,
    plan: plan.steps,
  };
  appendResult(result);
  return result;
}

const results: StressResult[] = [];

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
});

afterEach(() => {
  jest.useRealTimers();
});

afterAll(() => {
  writeTable(SUITE, results);
});

describe('stress: OnboardingScreen rapid/concurrent interaction (real App Gate, fake timers)', () => {
  const seeds = stressSeeds(process.env, LENS, DEFAULT_ITERATIONS);
  for (const seed of seeds) {
    it(`seed ${seed}: every burst has exactly one effect per intent and settles clean`, async () => {
      const result = await runSeed(seed);
      results.push(result);
      if (result.verdict === 'fail') {
        throw new Error(`${result.failure}\nreplay: ${result.replay}`);
      }
    });
  }
});
