import React from 'react';
import { AppState, Platform, StyleSheet, Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * STRESS — `scr-welcomescreen`, lens `randomized-seeded`.
 *
 * WelcomeScreen is stateless (two callbacks, optional secondary link), so the
 * interesting surface is the screen INSIDE the real App gate: `App.tsx`'s
 * `Gate` owns `preAuthStage`, the splash handoff and the owner-scoped
 * hydration that decides whether Welcome is on screen at all. This suite
 * mounts the REAL `App` (RootErrorBoundary, Gate, real Welcome / SignIn /
 * pre-auth + in-account OnboardingScreen, real `launchGate.ts` routing) and
 * drives it with seeded random sequences of legal and near-legal actions over
 * the public API — taps on the real controls, questionnaire answers, sign-in
 * settling, hydrate settling (in order and out of order), splash handoff,
 * store-level sign-out, AppState events, idempotent re-render, gate remount
 * and cold restart, plus deliberately near-legal moves (two CTAs in one
 * frame, a Welcome handler fired after Welcome unmounted, an early splash
 * finish, a whitespace-only name). Stores are controllable zustand instances
 * (no SQLite under jest) whose `hydrate` mirrors the real `appStore.hydrate`
 * ordering (reset → settle, stale settles dropped); RootNavigator, the three
 * overlays and the MP4 splash are stubbed exactly as `wf/App.buttons.test`.
 *
 * MODEL-CHECKED INVARIANTS (after EVERY action; names are the JSON keys):
 *  - no-throw            the action did not throw out of `act`.
 *  - no-console-error    React/RN logged nothing through console.error.
 *  - no-crash-boundary   RootErrorBoundary never painted "Something went
 *                        wrong"; stabilitySlo never recorded a `crash`.
 *  - one-screen          exactly ONE gate screen is mounted (Welcome, SignIn,
 *                        OnboardingScreen, LoadingState, ErrorState, Root).
 *  - screen-matches-model the mounted screen is the one the model predicts
 *                        from (auth store, app store, preAuthStage) — this
 *                        pins launchGate: Start → onboarding (never sign-in),
 *                        link → sign-in, Back → welcome, finish → sign-in,
 *                        preAuthStage survives sign-in/out, resets on remount.
 *  - welcome-contract    while Welcome is up: exactly the two labelled
 *                        controls, both enabled `button`s with >=44pt targets,
 *                        the sign-in hint, hero/kicker/caption copy, the
 *                        court illustration once, and no forbidden copy
 *                        (APP_STORE_SUBMISSION.md §: no Android/Play/guest
 *                        mode/Live Court/DUPR/competitors/percentages/
 *                        superlatives) or placeholder text.
 *  - welcome-tree-stable every Welcome paint has the same host-tree
 *                        fingerprint as the first one of the run (stateless
 *                        screen ⇒ no drift across returns/remounts).
 *  - onboarding-step     pre-auth/in-account questionnaire: step counter,
 *                        title, Back-vs-Leave-setup header control and its
 *                        hint, Continue enabled iff the step is complete, no
 *                        skip affordance, leave dialog visibility.
 *  - signin-contract     SignIn: Back + both providers once, providers
 *                        disabled iff busy, error card iff a non-cancel error.
 *  - splash-model        splash overlay present iff not finished; its `ready`
 *                        prop equals the model's readiness.
 *  - hydrate-calls       appStore.hydrate call count == model (one per owner
 *                        change per mounted gate, +1 per error retry).
 *  - telemetry           stabilitySlo context userKey == desired owner;
 *                        background transitions each record one clean end.
 *
 * REPLAY
 *   STRESS_SEED_FILTER=<seed> npx jest --ci __tests__/stress/welcomeScreenRandomizedSeeded
 *   Every sequence is a pure function of its seed. Failing sequences are
 *   greedily minimised to a 1-minimal action list, re-run 10× for a flake
 *   rate, and both are written to the JSON table.
 *
 * SCALE
 *   STRESS_ITER (default 40) sequences from STRESS_SEED_START (default 1),
 *   lengths 5–60. STRESS_DETERMINISM_EVERY (default 1) runs every Nth seed a
 *   second time and asserts an identical trace. Artifacts land in
 *   STRESS_ARTIFACT_DIR (default <repo>/artifacts/stress/welcomescreen-
 *   randomized-seeded/): `seed-table.json` (seed → outcome), `summary.json`,
 *   `welcome-tree.json` (the reference host tree), `failures.json`.
 */

jest.mock('react-native-safe-area-context', () => {
  const ReactActual = require('react');
  const { View: RNView } = require('react-native');
  const passthrough = (props: { children?: React.ReactNode }) =>
    ReactActual.createElement(RNView, null, props.children);
  return {
    SafeAreaProvider: passthrough,
    SafeAreaView: passthrough,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: {
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 0, bottom: 0, left: 0, right: 0 },
    },
  };
});

const mockHydrateApp = jest.fn<Promise<void>, []>(() => Promise.resolve());
const mockCompleteOnboarding = jest.fn<Promise<void>, [unknown]>(() =>
  Promise.resolve(),
);
const mockCompletePreAuthOnboarding = jest.fn<Promise<boolean>, [unknown]>(() =>
  Promise.resolve(true),
);
jest.mock('../../src/state/appStore', () => {
  const { create } = jest.requireActual<typeof import('zustand')>('zustand');
  const { focusForGoal } = jest.requireActual<
    typeof import('../../src/state/profile')
  >('../../src/state/profile');
  return {
    focusForGoal,
    useAppStore: create(() => ({
      hydrated: false,
      ownerKey: null,
      profile: null,
      hydrateError: null,
      onboardingBusy: false,
      onboardingError: null,
      lastShotType: 'forehand_drive',
      hydrate: () => mockHydrateApp(),
      completeOnboarding: (profile: unknown) => mockCompleteOnboarding(profile),
      completePreAuthOnboarding: (profile: unknown) =>
        mockCompletePreAuthOnboarding(profile),
    })),
  };
});

const mockHydrateAuth = jest.fn<Promise<void>, []>(() => Promise.resolve());
const mockSignInWithApple = jest.fn<Promise<void>, []>(() => Promise.resolve());
const mockSignInWithGoogle = jest.fn<Promise<void>, []>(() =>
  Promise.resolve(),
);
const mockSignOut = jest.fn<Promise<void>, []>(() => Promise.resolve());
const mockClearError = jest.fn<void, []>();
jest.mock('../../src/auth/authStore', () => {
  const { create } = jest.requireActual<typeof import('zustand')>('zustand');
  return {
    useAuthStore: create(() => ({
      hydrated: false,
      session: null,
      busy: false,
      error: null,
      hydrate: () => mockHydrateAuth(),
      signInWithApple: () => mockSignInWithApple(),
      signInWithGoogle: () => mockSignInWithGoogle(),
      signOut: () => mockSignOut(),
      clearError: () => mockClearError(),
    })),
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

jest.mock('../../src/walkthrough/walkthroughStore', () => {
  const { create } = jest.requireActual<typeof import('zustand')>('zustand');
  return {
    useWalkthroughStore: create(() => ({
      visible: false,
      maybeShowFirstRun: () => Promise.resolve(),
    })),
  };
});

jest.mock('../../src/notifications/useNotificationBootstrap', () => ({
  useNotificationBootstrap: () => undefined,
}));
jest.mock('../../src/consistency/useConsistencyBootstrap', () => ({
  useConsistencyBootstrap: () => undefined,
}));

jest.mock('../../src/navigation/RootNavigator', () => {
  const ReactActual = require('react');
  const { View: RNView } = require('react-native');
  return {
    __esModule: true,
    RootNavigator: () =>
      ReactActual.createElement(RNView, { testID: 'RootNavigator' }),
  };
});
jest.mock('../../src/components/RankUpCelebration', () => {
  const ReactActual = require('react');
  const { View: RNView } = require('react-native');
  return {
    __esModule: true,
    RankUpCelebration: () =>
      ReactActual.createElement(RNView, { testID: 'RankUpCelebration' }),
  };
});
jest.mock('../../src/consistency/StreakCelebration', () => {
  const ReactActual = require('react');
  const { View: RNView } = require('react-native');
  return {
    __esModule: true,
    StreakCelebration: () =>
      ReactActual.createElement(RNView, { testID: 'StreakCelebration' }),
  };
});
jest.mock('../../src/walkthrough/FirstRunWalkthrough', () => {
  const ReactActual = require('react');
  const { View: RNView } = require('react-native');
  return {
    __esModule: true,
    FirstRunWalkthrough: () =>
      ReactActual.createElement(RNView, { testID: 'FirstRunWalkthrough' }),
  };
});
// The real splash finishes through a native-driver Animated.timing whose
// completion never fires under jest's NativeAnimatedModule mock; the stub
// exposes exactly the two props App.tsx wires (`ready`, `onFinished`).
jest.mock('../../src/screens/SplashScreen', () => {
  const ReactActual = require('react');
  const { View: RNView } = require('react-native');
  return {
    __esModule: true,
    SplashScreen: (props: { ready: boolean; onFinished: () => void }) =>
      ReactActual.createElement(RNView, {
        testID: 'SplashScreen',
        ready: props.ready,
        onFinished: props.onFinished,
      }),
  };
});

import App from '../../App';
import { useAppStore } from '../../src/state/appStore';
import {
  useAuthStore,
  type AuthError,
  type AuthSession,
} from '../../src/auth/authStore';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';
import { stabilitySlo } from '../../src/analysis/stabilityTelemetry';
import { WelcomeScreen } from '../../src/screens/WelcomeScreen';
import { SignInScreen } from '../../src/screens/SignInScreen';
import { OnboardingScreen } from '../../src/screens/OnboardingScreen';
import { ErrorState, LoadingState } from '../../src/design/components';
import { makePrng, pick } from '../../xc-harness/lifecycle-persistence/seeds';
import {
  fs,
  nodeProcess,
  path,
} from '../../xc-harness/lifecycle-persistence/nodeShim';

declare const __dirname: string;

// ---------------------------------------------------------------------------
// Campaign configuration (env-driven; small by default so the suite is cheap)
// ---------------------------------------------------------------------------

function envInt(name: string, fallback: number): number {
  const raw = nodeProcess.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

const STRESS_ITER = envInt('STRESS_ITER', 40);
const SEED_START = envInt('STRESS_SEED_START', 1);
const SEED_FILTER = nodeProcess.env['STRESS_SEED_FILTER'];
const DETERMINISM_EVERY = Math.max(1, envInt('STRESS_DETERMINISM_EVERY', 1));
const MIN_LEN = 5;
const MAX_LEN = 60;
const FLAKE_RERUNS = 10;
const MINIMIZE_BUDGET = 400;
const ARTIFACT_DIR = (() => {
  const configured = nodeProcess.env['STRESS_ARTIFACT_DIR'];
  return configured && configured.length > 0
    ? configured
    : path.resolve(
        __dirname,
        '../../../../artifacts/stress/welcomescreen-randomized-seeded',
      );
})();

function writeArtifact(name: string, value: unknown): string {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const file = path.join(ARTIFACT_DIR, name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return file;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CANONICAL_ID = '3F2504E0-4F89-11D3-9A0C-0305E82C3301';
const CANONICAL_OWNER = CANONICAL_ID.toLowerCase();

const googleSession: AuthSession = {
  provider: 'google',
  subject: 'google-subject',
  canonicalAppUserId: CANONICAL_ID,
  localOnly: false,
  displayName: 'Dana',
  email: null,
};
const appleSession: AuthSession = { ...googleSession, provider: 'apple' };

const onboardedProfile = {
  skillLevel: '3.5',
  handedness: 'right',
  goal: 'drops',
  biggestProblem: 'control',
  focusCheckpoint: 'paddle_set',
} as const;

const HYDRATE_ERROR_COPY = 'Your coaching profile could not be loaded.';
const SIGN_IN_FAILED: AuthError = {
  code: 'auth.failed',
  message: 'The provider did not return an identity.',
};
const SIGN_IN_CANCELED: AuthError = {
  code: 'auth.canceled',
  message: 'Sign-in was canceled.',
};

const START_LABEL = 'Start your first read';
const SIGN_IN_LABEL = 'I already have an account';
const WELCOME_REQUIRED_COPY = [
  'See the stroke.',
  'Know the fix.',
  'PRIVATE BY DEFAULT',
  START_LABEL,
  SIGN_IN_LABEL,
  'Two successful validated ratings free',
  'Unscored attempts don’t count',
];
// APP_STORE_SUBMISSION.md §1 rules 4–5 + REVIEW.md placeholder ban.
const FORBIDDEN_COPY =
  /android|google play|guest mode|live court|dupr|swingvision|pb vision|selkirk|joola|\d+\s?%|\bbest\b|most accurate|ai coach equivalent|lorem|todo|placeholder|undefined|\[object/i;

const ONBOARDING_STEPS = 8;
const QUESTION_TITLES = [
  'What should we call you?',
  'How do you identify?',
  'Where is your game today?',
  'Which side is home?',
  'What do you want to own?',
  'What breaks down most?',
] as const;
const CHOICES: Record<number, readonly string[]> = {
  1: ['Female', 'Male', 'Non-binary', 'Prefer not to say'],
  2: ['Brand new', '2.5', '3.0', '3.5', '4.0', '4.5', '5.0+'],
  3: ['Right-handed', 'Left-handed'],
  4: ['Dinks', 'Drives', 'Third-shot drops', 'Serve'],
  5: ['Consistency', 'Control', 'Power', 'Contact'],
};
const NAMES = ['Dana', 'Ari', 'Lee', ' Sam ', 'Jo'];

// ---------------------------------------------------------------------------
// Scenario (per-sequence, drawn from the seed) and mutable harness seams
// ---------------------------------------------------------------------------

type HydrateMode = 'sync' | 'microtask' | 'deferred';
type AuthMode = 'sync' | 'deferred' | 'fail' | 'cancel';
type InitialAuth = 'signed-out' | 'restored-session';

interface Scenario {
  initialAuth: InitialAuth;
  hydrateMode: HydrateMode;
  authMode: AuthMode;
  canonicalHasProfile: boolean;
  canonicalHydrateError: boolean;
  preAuthStashOk: boolean;
  length: number;
}

function drawScenario(rng: () => number): Scenario {
  const initialAuth = rng() < 0.65 ? 'signed-out' : 'restored-session';
  const hydrateRoll = rng();
  const hydrateMode: HydrateMode =
    hydrateRoll < 0.4 ? 'sync' : hydrateRoll < 0.6 ? 'microtask' : 'deferred';
  const authRoll = rng();
  const authMode: AuthMode =
    authRoll < 0.4
      ? 'sync'
      : authRoll < 0.7
        ? 'deferred'
        : authRoll < 0.85
          ? 'fail'
          : 'cancel';
  const canonicalHasProfile = rng() < 0.5;
  const canonicalHydrateError = !canonicalHasProfile && rng() < 0.4;
  const preAuthStashOk = rng() < 0.8;
  const length = MIN_LEN + Math.floor(rng() * (MAX_LEN - MIN_LEN + 1));
  return {
    initialAuth,
    hydrateMode,
    authMode,
    canonicalHasProfile,
    canonicalHydrateError,
    preAuthStashOk,
    length,
  };
}

interface PendingHydrate {
  owner: string;
  resolve: () => void;
}

/** Mutable seams the mocked stores consult; reset per sequence. */
const seams = {
  scenario: null as Scenario | null,
  pendingHydrates: [] as PendingHydrate[],
  pendingAuth: null as null | { provider: 'apple' | 'google' },
};

/** Same derivation as App.tsx's Gate (and authStore's setActiveDataOwner). */
function desiredOwnerOf(auth: {
  hydrated: boolean;
  session: AuthSession | null;
}): string | null {
  if (!auth.hydrated) return null;
  if (auth.session?.provider === 'guest') return GUEST_DATA_OWNER;
  if (auth.session?.canonicalAppUserId) {
    return auth.session.canonicalAppUserId.trim().toLowerCase();
  }
  return SIGNED_OUT_DATA_OWNER;
}

function settleHydrate(owner: string) {
  const scenario = seams.scenario!;
  // appStore.hydrate: `if (getActiveDataOwner() !== owner) return;`
  if (desiredOwnerOf(useAuthStore.getState()) !== owner) return;
  const canonical = owner === CANONICAL_OWNER;
  useAppStore.setState({
    hydrated: true,
    ownerKey: owner,
    profile:
      canonical && scenario.canonicalHasProfile ? onboardedProfile : null,
    hydrateError:
      canonical &&
      !scenario.canonicalHasProfile &&
      scenario.canonicalHydrateError
        ? HYDRATE_ERROR_COPY
        : null,
    onboardingBusy: false,
    onboardingError: null,
  });
}

/** Mirrors appStore.hydrate: synchronous reset, then the owner's outcome. */
function hydrateImpl(): Promise<void> {
  const owner =
    desiredOwnerOf(useAuthStore.getState()) ?? SIGNED_OUT_DATA_OWNER;
  useAppStore.setState({
    hydrated: false,
    ownerKey: owner,
    profile: null,
    hydrateError: null,
  });
  const mode = seams.scenario!.hydrateMode;
  if (mode === 'sync') {
    settleHydrate(owner);
    return Promise.resolve();
  }
  if (mode === 'microtask') {
    return Promise.resolve().then(() => settleHydrate(owner));
  }
  return new Promise<void>(resolve => {
    seams.pendingHydrates.push({ owner, resolve });
  });
}

function settleAuth(outcome: 'success' | 'fail' | 'cancel') {
  const pending = seams.pendingAuth;
  seams.pendingAuth = null;
  if (!pending) return;
  if (outcome === 'success') {
    useAuthStore.setState({
      busy: false,
      error: null,
      session: pending.provider === 'apple' ? appleSession : googleSession,
    });
    return;
  }
  useAuthStore.setState({
    busy: false,
    error: outcome === 'fail' ? SIGN_IN_FAILED : SIGN_IN_CANCELED,
  });
}

function signInImpl(provider: 'apple' | 'google'): Promise<void> {
  const auth = useAuthStore.getState();
  if (auth.busy) return Promise.resolve();
  useAuthStore.setState({ busy: true, error: null });
  const mode = seams.scenario!.authMode;
  if (mode === 'deferred') {
    seams.pendingAuth = { provider };
    return Promise.resolve();
  }
  seams.pendingAuth = { provider };
  settleAuth(mode === 'sync' ? 'success' : mode);
  return Promise.resolve();
}

function resetStores() {
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
    onboardingBusy: false,
    onboardingError: null,
  });
  useAuthStore.setState({
    hydrated: false,
    session: null,
    busy: false,
    error: null,
  });
  seams.pendingHydrates = [];
  seams.pendingAuth = null;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

type Renderer = TestRenderer.ReactTestRenderer;
type ReactTestInstance = TestRenderer.ReactTestInstance;

/** One line per Text node; string and number children joined in order. */
function allText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => {
      const children: unknown = node.props.children;
      const parts = Array.isArray(children) ? children : [children];
      return parts
        .filter(
          (c): c is string | number =>
            typeof c === 'string' || typeof c === 'number',
        )
        .map(String)
        .join('');
    })
    .join('\n');
}

/** Host views only, so a stubbed screen counts once (not composite + host). */
function markers(renderer: Renderer, testID: string) {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && node.props.testID === testID,
  );
}

/** Innermost labelled node carrying an onPress (the resolved Pressable). */
function labelledPressables(renderer: Renderer): ReactTestInstance[] {
  const isMatch = (node: ReactTestInstance) =>
    typeof node.props?.accessibilityLabel === 'string' &&
    typeof node.props?.onPress === 'function';
  return renderer.root
    .findAll(isMatch)
    .filter(
      node =>
        node.findAll(child => child !== node && isMatch(child)).length === 0,
    );
}

function pressablesByLabel(renderer: Renderer, label: string) {
  return labelledPressables(renderer).filter(
    node => node.props.accessibilityLabel === label,
  );
}

function resolvedStyle(node: ReactTestInstance): Record<string, unknown> {
  const style =
    typeof node.props.style === 'function'
      ? node.props.style({ pressed: false })
      : node.props.style;
  return (StyleSheet.flatten(style) ?? {}) as Record<string, unknown>;
}

/**
 * Structural fingerprint of a composite's host subtree: element type plus the
 * props that carry meaning for a user (labels, roles, hints, disabled,
 * testIDs, text). Layout numbers are excluded on purpose — the point is
 * "same screen, same controls, same copy" across returns and remounts.
 */
function fingerprint(node: ReactTestInstance | string): unknown {
  if (typeof node === 'string') return node;
  const children = node.children.map(child => fingerprint(child));
  if (typeof node.type !== 'string') return children;
  const props = node.props as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const key of [
    'testID',
    'accessibilityLabel',
    'accessibilityRole',
    'accessibilityHint',
    'accessible',
    'disabled',
  ]) {
    if (props[key] !== undefined) kept[key] = props[key];
  }
  return { t: node.type, p: kept, c: children };
}

function hashString(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

type Screen =
  | 'loading-signed-out'
  | 'loading-account'
  | 'welcome'
  | 'onboarding-preauth'
  | 'signin'
  | 'profile-error'
  | 'onboarding-account'
  | 'root';

interface OnboardingModel {
  depth: number;
  name: string;
  answered: Set<number>;
  leaveDialogOpen: boolean;
}

interface WelcomeHandles {
  gateGeneration: number;
  start: () => void;
  signIn: () => void;
}

interface Model {
  gateGeneration: number;
  preAuthStage: 'welcome' | 'onboarding' | 'signin';
  splashDone: boolean;
  lastScreen: Screen | null;
  lastDesiredOwner: string | null;
  expectedHydrateCalls: number;
  expectedCleanEnds: number;
  onboarding: OnboardingModel;
  welcomeHandles: WelcomeHandles | null;
}

function freshOnboarding(): OnboardingModel {
  return { depth: 0, name: '', answered: new Set(), leaveDialogOpen: false };
}

function freshGate(model: Model | null): Model {
  return {
    gateGeneration: (model?.gateGeneration ?? 0) + 1,
    preAuthStage: 'welcome',
    splashDone: false,
    lastScreen: null,
    lastDesiredOwner: null,
    expectedHydrateCalls: model?.expectedHydrateCalls ?? 0,
    expectedCleanEnds: model?.expectedCleanEnds ?? 0,
    onboarding: freshOnboarding(),
    welcomeHandles: null,
  };
}

function modelReady(): boolean {
  const auth = useAuthStore.getState();
  const app = useAppStore.getState();
  const desired = desiredOwnerOf(auth);
  return (
    auth.hydrated &&
    Boolean(desired) &&
    app.hydrated &&
    app.ownerKey === desired
  );
}

function predictScreen(model: Model): Screen {
  const auth = useAuthStore.getState();
  const app = useAppStore.getState();
  if (!modelReady()) {
    return auth.session ? 'loading-account' : 'loading-signed-out';
  }
  if (!auth.session) {
    return model.preAuthStage === 'signin'
      ? 'signin'
      : model.preAuthStage === 'onboarding'
        ? 'onboarding-preauth'
        : 'welcome';
  }
  if (!app.profile && app.hydrateError) return 'profile-error';
  if (!app.profile) return 'onboarding-account';
  return 'root';
}

function onboardingStepComplete(onb: OnboardingModel): boolean {
  if (onb.depth >= 6) return true;
  if (onb.depth === 0) return onb.name.trim().length >= 1;
  return onb.answered.has(onb.depth);
}

function expectedStepTitle(onb: OnboardingModel): string {
  if (onb.depth < 6) return QUESTION_TITLES[onb.depth]!;
  if (onb.depth === 6) return `Built for ${onb.name.trim()}.`;
  return 'Stay match-ready.';
}

/**
 * Runs after every action: the desired owner drives one hydrate() per change
 * (Gate's effect on [desiredOwner]); a screen change into either onboarding
 * variant is a fresh OnboardingScreen instance (no state survives).
 */
function settleModel(model: Model) {
  const desired = desiredOwnerOf(useAuthStore.getState());
  if (desired && desired !== model.lastDesiredOwner) {
    model.expectedHydrateCalls += 1;
  }
  model.lastDesiredOwner = desired;
  const screen = predictScreen(model);
  const isOnboarding =
    screen === 'onboarding-preauth' || screen === 'onboarding-account';
  if (isOnboarding && screen !== model.lastScreen) {
    model.onboarding = freshOnboarding();
  }
  model.lastScreen = screen;
}

// ---------------------------------------------------------------------------
// Observation + invariants
// ---------------------------------------------------------------------------

interface Observation {
  screen: Screen | 'none' | 'multiple';
  mountedScreens: string[];
  labels: string[];
  textHash: string;
  splash: null | { ready: boolean };
  crashBoundary: boolean;
}

function observe(renderer: Renderer): Observation {
  const mounted: string[] = [];
  const welcome = renderer.root.findAllByType(WelcomeScreen);
  const signIn = renderer.root.findAllByType(SignInScreen);
  const onboarding = renderer.root.findAllByType(OnboardingScreen);
  const loading = renderer.root.findAllByType(LoadingState);
  const errors = renderer.root.findAllByType(ErrorState);
  const root = markers(renderer, 'RootNavigator');
  const text = allText(renderer);
  const crashBoundary = text.includes('Something went wrong');

  mounted.push(...welcome.map(() => 'welcome'));
  mounted.push(...signIn.map(() => 'signin'));
  for (const node of onboarding) {
    mounted.push(
      node.props.mode === 'preauth'
        ? 'onboarding-preauth'
        : 'onboarding-account',
    );
  }
  for (const node of loading) {
    mounted.push(
      node.props.label === 'Loading your account'
        ? 'loading-account'
        : node.props.label === 'Getting things ready'
          ? 'loading-signed-out'
          : `loading:${String(node.props.label)}`,
    );
  }
  for (const node of errors) {
    mounted.push(
      node.props.title === 'Your coaching profile couldn’t load'
        ? 'profile-error'
        : `error:${String(node.props.title)}`,
    );
  }
  mounted.push(...root.map(() => 'root'));

  const splashNodes = markers(renderer, 'SplashScreen');
  const splash =
    splashNodes.length === 1
      ? { ready: Boolean(splashNodes[0]!.props.ready) }
      : null;

  return {
    screen:
      mounted.length === 1
        ? (mounted[0] as Screen)
        : mounted.length === 0
          ? 'none'
          : 'multiple',
    mountedScreens: mounted,
    labels: labelledPressables(renderer)
      .map(node => String(node.props.accessibilityLabel))
      .sort(),
    textHash: hashString(text),
    splash: splashNodes.length > 1 ? { ready: false } : splash,
    crashBoundary,
  };
}

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

function check(name: string, ok: boolean, detail?: string): Check {
  return ok ? { name, ok } : { name, ok, detail };
}

let referenceWelcomeTree: string | null = null;
let referenceWelcomeTreeJson: unknown = null;

function checkInvariants(
  renderer: Renderer,
  model: Model,
  observation: Observation,
  consoleErrors: string[],
  recordSpy: jest.SpyInstance,
  setContextSpy: jest.SpyInstance,
): Check[] {
  const checks: Check[] = [];
  const text = allText(renderer);
  const predicted = predictScreen(model);

  checks.push(
    check(
      'no-console-error',
      consoleErrors.length === 0,
      consoleErrors.slice(0, 3).join(' | ').slice(0, 400),
    ),
  );
  const crashRecorded = recordSpy.mock.calls.some(
    call => (call[0] as { kind?: string } | undefined)?.kind === 'crash',
  );
  checks.push(
    check(
      'no-crash-boundary',
      !observation.crashBoundary && !crashRecorded,
      `boundary=${observation.crashBoundary} crashRecorded=${crashRecorded}`,
    ),
  );
  checks.push(
    check(
      'one-screen',
      observation.mountedScreens.length === 1,
      `mounted=${JSON.stringify(observation.mountedScreens)}`,
    ),
  );
  checks.push(
    check(
      'screen-matches-model',
      observation.screen === predicted,
      `observed=${observation.screen} predicted=${predicted} stage=${model.preAuthStage}`,
    ),
  );

  // Splash overlay: present until finished, `ready` mirrors the gate.
  const ready = modelReady();
  checks.push(
    check(
      'splash-model',
      model.splashDone
        ? observation.splash === null
        : observation.splash !== null && observation.splash.ready === ready,
      `splashDone=${model.splashDone} observed=${JSON.stringify(observation.splash)} ready=${ready}`,
    ),
  );

  checks.push(
    check(
      'hydrate-calls',
      mockHydrateApp.mock.calls.length === model.expectedHydrateCalls,
      `actual=${mockHydrateApp.mock.calls.length} expected=${model.expectedHydrateCalls}`,
    ),
  );

  const desired = desiredOwnerOf(useAuthStore.getState());
  const lastContext = setContextSpy.mock.calls.at(-1)?.[0] as
    { userKey?: string } | undefined;
  const cleanEnds = recordSpy.mock.calls.filter(
    call =>
      (call[0] as { kind?: string } | undefined)?.kind ===
      'session_ended_clean',
  ).length;
  checks.push(
    check(
      'telemetry',
      (desired === null || lastContext?.userKey === desired) &&
        cleanEnds === model.expectedCleanEnds,
      `desired=${desired} lastUserKey=${lastContext?.userKey} cleanEnds=${cleanEnds}/${model.expectedCleanEnds}`,
    ),
  );

  if (predicted === 'welcome' && observation.screen === 'welcome') {
    const problems: string[] = [];
    const start = pressablesByLabel(renderer, START_LABEL);
    const link = pressablesByLabel(renderer, SIGN_IN_LABEL);
    if (start.length !== 1) problems.push(`start×${start.length}`);
    if (link.length !== 1) problems.push(`link×${link.length}`);
    const labels = observation.labels;
    const expectedLabels = [SIGN_IN_LABEL, START_LABEL].sort();
    if (JSON.stringify(labels) !== JSON.stringify(expectedLabels)) {
      problems.push(`labels=${JSON.stringify(labels)}`);
    }
    for (const node of [...start, ...link]) {
      if (node.props.accessibilityRole !== 'button') problems.push('role');
      if (node.props.disabled) problems.push('disabled');
      if (node.props.accessibilityState?.disabled) problems.push('a11yState');
      const style = resolvedStyle(node);
      if (typeof style.minHeight !== 'number' || style.minHeight < 44) {
        problems.push(`minHeight=${String(style.minHeight)}`);
      }
      if (style.opacity !== 1)
        problems.push(`opacity=${String(style.opacity)}`);
    }
    if (link[0]?.props.accessibilityHint !== 'Sign in to an existing account') {
      problems.push('hint');
    }
    for (const copy of WELCOME_REQUIRED_COPY) {
      if (!text.includes(copy)) problems.push(`missing:${copy}`);
    }
    const forbidden = text.match(FORBIDDEN_COPY);
    if (forbidden) problems.push(`forbidden:${forbidden[0]}`);
    if (markers(renderer, 'welcome-court-story').length !== 1) {
      problems.push('court-story');
    }
    if (
      text.includes('What should we call you?') ||
      text.includes('Your ratings,')
    ) {
      problems.push('other-screen-copy');
    }
    checks.push(
      check('welcome-contract', problems.length === 0, problems.join(',')),
    );

    const tree = JSON.stringify(
      fingerprint(renderer.root.findByType(WelcomeScreen)),
    );
    if (referenceWelcomeTree === null) {
      referenceWelcomeTree = tree;
      referenceWelcomeTreeJson = JSON.parse(tree);
    }
    checks.push(
      check(
        'welcome-tree-stable',
        tree === referenceWelcomeTree,
        `hash=${hashString(tree)} reference=${hashString(referenceWelcomeTree)}`,
      ),
    );
  }

  if (
    (predicted === 'onboarding-preauth' ||
      predicted === 'onboarding-account') &&
    observation.screen === predicted
  ) {
    const onb = model.onboarding;
    const problems: string[] = [];
    const counter = `${onb.depth + 1}/${ONBOARDING_STEPS}`;
    if (!text.includes(counter)) problems.push(`counter:${counter}`);
    if (!text.includes(expectedStepTitle(onb))) {
      problems.push(`title:${expectedStepTitle(onb)}`);
    }
    if (/skip/i.test(text)) problems.push('skip-copy');
    const back = pressablesByLabel(renderer, 'Back');
    const leave = pressablesByLabel(renderer, 'Leave setup');
    if (onb.depth > 0) {
      if (back.length !== 1) problems.push(`back×${back.length}`);
      if (
        back[0]?.props.accessibilityHint !== 'Return to the previous question'
      ) {
        problems.push('back-hint');
      }
      if (leave.length !== 0) problems.push('leave-at-depth');
    } else if (predicted === 'onboarding-preauth') {
      if (back.length !== 1) problems.push(`back×${back.length}`);
      if (back[0]?.props.accessibilityHint !== 'Return to the welcome screen') {
        problems.push('back-hint-welcome');
      }
      if (leave.length !== 0) problems.push('leave-in-preauth');
    } else {
      if (leave.length !== 1) problems.push(`leave×${leave.length}`);
      if (back.length !== 0) problems.push('back-at-step-one');
    }
    if (onb.depth < 7) {
      const cont = pressablesByLabel(renderer, 'Continue');
      if (cont.length !== 1) problems.push(`continue×${cont.length}`);
      const complete = onboardingStepComplete(onb);
      if (Boolean(cont[0]?.props.disabled) !== !complete) {
        problems.push(
          `continue-disabled=${String(cont[0]?.props.disabled)} complete=${complete}`,
        );
      }
    } else {
      if (pressablesByLabel(renderer, 'Not now').length !== 1)
        problems.push('not-now');
      if (pressablesByLabel(renderer, 'Turn on reminders').length !== 1) {
        problems.push('turn-on-reminders');
      }
    }
    const dialog = markers(renderer, 'onboarding-leave-dialog').length;
    if ((dialog === 1) !== onb.leaveDialogOpen) {
      problems.push(`leave-dialog=${dialog} expected=${onb.leaveDialogOpen}`);
    }
    if (text.includes('See the stroke.')) problems.push('welcome-copy-leak');
    checks.push(
      check('onboarding-step', problems.length === 0, problems.join(',')),
    );
  }

  if (predicted === 'signin' && observation.screen === 'signin') {
    const auth = useAuthStore.getState();
    const problems: string[] = [];
    if (pressablesByLabel(renderer, 'Back').length !== 1) problems.push('back');
    const google = pressablesByLabel(renderer, 'Continue with Google');
    const apple = pressablesByLabel(renderer, 'Continue with Apple');
    if (google.length !== 1) problems.push('google');
    if (apple.length !== (Platform.OS === 'ios' ? 1 : 0))
      problems.push('apple');
    for (const node of [...google, ...apple]) {
      if (Boolean(node.props.disabled) !== auth.busy)
        problems.push('busy-gate');
    }
    const errorCard = pressablesByLabel(renderer, 'Dismiss sign-in error');
    const expectError = Boolean(
      auth.error && auth.error.code !== 'auth.canceled',
    );
    if ((errorCard.length === 1) !== expectError) problems.push('error-card');
    if (text.includes('Signing in securely…') !== auth.busy)
      problems.push('busy-copy');
    if (!text.includes('Your ratings,')) problems.push('title');
    if (text.includes('See the stroke.')) problems.push('welcome-copy-leak');
    checks.push(
      check('signin-contract', problems.length === 0, problems.join(',')),
    );
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

type ActionName =
  | 'auth-hydrate'
  | 'splash-finish'
  | 'press-start'
  | 'press-start-double'
  | 'press-signin-link'
  | 'press-both-start-then-link'
  | 'press-both-link-then-start'
  | 'stale-welcome-start'
  | 'stale-welcome-signin'
  | 'rerender-noop'
  | 'onb-answer'
  | 'onb-continue'
  | 'onb-back'
  | 'onb-finish-not-now'
  | 'onb-finish-reminders'
  | 'leave-open'
  | 'leave-keep'
  | 'leave-signout'
  | 'signin-back'
  | 'signin-google'
  | 'signin-apple'
  | 'signin-dismiss-error'
  | 'auth-settle-success'
  | 'auth-settle-fail'
  | 'hydrate-settle-oldest'
  | 'hydrate-settle-newest'
  | 'sign-out'
  | 'error-retry-same'
  | 'error-retry-recover'
  | 'appstate-background'
  | 'appstate-active'
  | 'gate-remount'
  | 'cold-restart';

interface Action {
  name: ActionName;
  /** Concrete argument (choice label, name text) so replays are exact. */
  arg?: string;
}

interface Weighted {
  action: Action;
  weight: number;
}

function legalActions(model: Model, rng: () => number): Weighted[] {
  const auth = useAuthStore.getState();
  const screen = predictScreen(model);
  const out: Weighted[] = [];
  const add = (name: ActionName, weight: number, arg?: string) =>
    out.push({ action: arg === undefined ? { name } : { name, arg }, weight });

  if (!auth.hydrated) add('auth-hydrate', 12);
  if (!model.splashDone) add('splash-finish', modelReady() ? 4 : 1);
  add('rerender-noop', 1);
  add('appstate-background', 1);
  add('appstate-active', 0.5);
  add('gate-remount', 0.6);
  add('cold-restart', 0.4);

  if (screen === 'welcome') {
    add('press-start', 8);
    add('press-signin-link', 5);
    add('press-start-double', 1.5);
    add('press-both-start-then-link', 0.7);
    add('press-both-link-then-start', 0.7);
  } else if (
    model.welcomeHandles &&
    model.welcomeHandles.gateGeneration === model.gateGeneration
  ) {
    add('stale-welcome-start', 0.4);
    add('stale-welcome-signin', 0.4);
  }

  if (screen === 'onboarding-preauth' || screen === 'onboarding-account') {
    const onb = model.onboarding;
    if (onb.leaveDialogOpen) {
      add('leave-keep', 3);
      add('leave-signout', 3);
    } else {
      if (onb.depth === 0) {
        add('onb-answer', 5, rng() < 0.15 ? '   ' : pick(rng, NAMES));
      } else if (onb.depth <= 5) {
        add('onb-answer', 5, pick(rng, CHOICES[onb.depth]!));
      }
      if (onb.depth < 7) add('onb-continue', 5);
      add(
        'onb-back',
        screen === 'onboarding-preauth' && onb.depth === 0 ? 5 : 2.5,
      );
      if (onb.depth === 7) {
        add('onb-finish-not-now', 5);
        add('onb-finish-reminders', 3);
      }
      if (screen === 'onboarding-account' && onb.depth === 0)
        add('leave-open', 3);
    }
  }

  if (screen === 'signin') {
    add('signin-back', 5);
    if (!auth.busy) {
      add('signin-google', 4);
      if (Platform.OS === 'ios') add('signin-apple', 2);
    }
    if (auth.error && auth.error.code !== 'auth.canceled') {
      add('signin-dismiss-error', 3);
    }
  }
  if (seams.pendingAuth) {
    add('auth-settle-success', 6);
    add('auth-settle-fail', 2);
  }
  if (seams.pendingHydrates.length > 0) {
    add('hydrate-settle-oldest', 8);
    if (seams.pendingHydrates.length > 1) add('hydrate-settle-newest', 3);
  }
  if (auth.session && screen !== 'loading-account') add('sign-out', 2.5);
  if (screen === 'profile-error') {
    add('error-retry-same', 2);
    add('error-retry-recover', 3);
  }
  return out;
}

function drawAction(model: Model, rng: () => number): Action {
  const options = legalActions(model, rng);
  const total = options.reduce((sum, option) => sum + option.weight, 0);
  let roll = rng() * total;
  for (const option of options) {
    roll -= option.weight;
    if (roll <= 0) return option.action;
  }
  return options[options.length - 1]!.action;
}

const mountedRenderers: Renderer[] = [];

interface Harness {
  renderer: Renderer;
  model: Model;
  scenario: Scenario;
  consoleErrors: string[];
  recordSpy: jest.SpyInstance;
  setContextSpy: jest.SpyInstance;
}

function pressNode(node: ReactTestInstance) {
  if (node.props.disabled) return false;
  node.props.onPress();
  return true;
}

function pressLabel(renderer: Renderer, label: string): boolean {
  const nodes = pressablesByLabel(renderer, label);
  if (nodes.length !== 1) {
    throw new Error(
      `expected exactly one "${label}" control, found ${nodes.length}`,
    );
  }
  return pressNode(nodes[0]!);
}

function latestAppStateHandler(): ((state: string) => void) | null {
  const listener = AppState.addEventListener as jest.Mock;
  const changeCalls = listener.mock.calls.filter(call => call[0] === 'change');
  const last = changeCalls.at(-1);
  return last ? (last[1] as (state: string) => void) : null;
}

/** Async act: a microtask-mode hydrate triggered by mount settles inside. */
async function mountApp(harness: Harness) {
  await act(async () => {
    harness.renderer = TestRenderer.create(<App />);
  });
  mountedRenderers.push(harness.renderer);
}

/**
 * Applies one action to the real tree, then updates the model. Returns
 * `applied=false` when the action's precondition no longer holds (only
 * possible while replaying a minimised list), in which case it is a no-op.
 */
async function applyAction(harness: Harness, action: Action): Promise<boolean> {
  const { model } = harness;
  const screen = predictScreen(model);
  const renderer = harness.renderer;
  const auth = useAuthStore.getState();

  const captureWelcome = () => {
    if (predictScreen(model) !== 'welcome') return;
    const start = pressablesByLabel(renderer, START_LABEL)[0];
    const link = pressablesByLabel(renderer, SIGN_IN_LABEL)[0];
    if (start && link) {
      model.welcomeHandles = {
        gateGeneration: model.gateGeneration,
        start: start.props.onPress,
        signIn: link.props.onPress,
      };
    }
  };

  switch (action.name) {
    case 'auth-hydrate': {
      if (auth.hydrated) return false;
      await act(async () => {
        useAuthStore.setState({
          hydrated: true,
          session:
            harness.scenario.initialAuth === 'restored-session'
              ? googleSession
              : null,
        });
      });
      break;
    }
    case 'splash-finish': {
      if (model.splashDone) return false;
      const [splash] = markers(renderer, 'SplashScreen');
      if (!splash) return false;
      act(() => {
        splash.props.onFinished();
      });
      model.splashDone = true;
      break;
    }
    case 'press-start': {
      if (screen !== 'welcome') return false;
      captureWelcome();
      act(() => {
        pressLabel(renderer, START_LABEL);
      });
      model.preAuthStage = 'onboarding';
      break;
    }
    case 'press-start-double': {
      if (screen !== 'welcome') return false;
      captureWelcome();
      act(() => {
        const node = pressablesByLabel(renderer, START_LABEL)[0]!;
        pressNode(node);
        pressNode(node);
      });
      model.preAuthStage = 'onboarding';
      break;
    }
    case 'press-signin-link': {
      if (screen !== 'welcome') return false;
      captureWelcome();
      act(() => {
        pressLabel(renderer, SIGN_IN_LABEL);
      });
      model.preAuthStage = 'signin';
      break;
    }
    case 'press-both-start-then-link': {
      if (screen !== 'welcome') return false;
      captureWelcome();
      act(() => {
        pressLabel(renderer, START_LABEL);
        pressLabel(renderer, SIGN_IN_LABEL);
      });
      // Two setState calls in one batch: the last one wins.
      model.preAuthStage = 'signin';
      break;
    }
    case 'press-both-link-then-start': {
      if (screen !== 'welcome') return false;
      captureWelcome();
      act(() => {
        pressLabel(renderer, SIGN_IN_LABEL);
        pressLabel(renderer, START_LABEL);
      });
      model.preAuthStage = 'onboarding';
      break;
    }
    case 'stale-welcome-start':
    case 'stale-welcome-signin': {
      const handles = model.welcomeHandles;
      if (!handles || screen === 'welcome') return false;
      const live = handles.gateGeneration === model.gateGeneration;
      act(() => {
        (action.name === 'stale-welcome-start'
          ? handles.start
          : handles.signIn)();
      });
      // The closure targets the Gate's setState: it lands if that Gate is
      // still mounted (the screen it changes may be hidden behind a loading
      // state or a session) and is inert once the Gate is gone.
      if (live) {
        model.preAuthStage =
          action.name === 'stale-welcome-start' ? 'onboarding' : 'signin';
      }
      break;
    }
    case 'rerender-noop': {
      act(() => {
        renderer.update(<App />);
      });
      break;
    }
    case 'onb-answer': {
      if (screen !== 'onboarding-preauth' && screen !== 'onboarding-account') {
        return false;
      }
      const onb = model.onboarding;
      if (onb.leaveDialogOpen || onb.depth > 5) return false;
      if (onb.depth === 0) {
        const value = action.arg ?? 'Dana';
        act(() => {
          renderer.root.findByType(TextInput).props.onChangeText(value);
        });
        onb.name = value;
      } else {
        const label = action.arg ?? CHOICES[onb.depth]![0]!;
        if (!CHOICES[onb.depth]!.includes(label)) return false;
        act(() => {
          pressLabel(renderer, label);
        });
        onb.answered.add(onb.depth);
      }
      break;
    }
    case 'onb-continue': {
      if (screen !== 'onboarding-preauth' && screen !== 'onboarding-account') {
        return false;
      }
      const onb = model.onboarding;
      if (onb.leaveDialogOpen || onb.depth >= 7) return false;
      let pressed = false;
      act(() => {
        pressed = pressLabel(renderer, 'Continue');
      });
      if (pressed) onb.depth += 1;
      break;
    }
    case 'onb-back': {
      if (screen !== 'onboarding-preauth' && screen !== 'onboarding-account') {
        return false;
      }
      const onb = model.onboarding;
      if (onb.leaveDialogOpen) return false;
      if (onb.depth > 0) {
        act(() => {
          pressLabel(renderer, 'Back');
        });
        onb.depth -= 1;
      } else if (screen === 'onboarding-preauth') {
        act(() => {
          pressLabel(renderer, 'Back');
        });
        model.preAuthStage = 'welcome';
      } else {
        return false;
      }
      break;
    }
    case 'onb-finish-not-now':
    case 'onb-finish-reminders': {
      if (screen !== 'onboarding-preauth' && screen !== 'onboarding-account') {
        return false;
      }
      const onb = model.onboarding;
      if (onb.leaveDialogOpen || onb.depth !== 7) return false;
      const label =
        action.name === 'onb-finish-not-now' ? 'Not now' : 'Turn on reminders';
      await act(async () => {
        pressLabel(renderer, label);
      });
      if (screen === 'onboarding-preauth') {
        if (harness.scenario.preAuthStashOk) model.preAuthStage = 'signin';
      }
      // In-account: mockCompleteOnboarding stores the profile → RootNavigator.
      break;
    }
    case 'leave-open': {
      if (screen !== 'onboarding-account') return false;
      const onb = model.onboarding;
      if (onb.leaveDialogOpen || onb.depth !== 0) return false;
      act(() => {
        pressLabel(renderer, 'Leave setup');
      });
      onb.leaveDialogOpen = true;
      break;
    }
    case 'leave-keep': {
      if (
        screen !== 'onboarding-account' ||
        !model.onboarding.leaveDialogOpen
      ) {
        return false;
      }
      act(() => {
        pressLabel(renderer, 'Keep setting up');
      });
      model.onboarding.leaveDialogOpen = false;
      break;
    }
    case 'leave-signout': {
      if (
        screen !== 'onboarding-account' ||
        !model.onboarding.leaveDialogOpen
      ) {
        return false;
      }
      await act(async () => {
        pressLabel(renderer, 'Sign out');
      });
      model.onboarding.leaveDialogOpen = false;
      break;
    }
    case 'signin-back': {
      if (screen !== 'signin') return false;
      act(() => {
        pressLabel(renderer, 'Back');
      });
      model.preAuthStage = 'welcome';
      break;
    }
    case 'signin-google':
    case 'signin-apple': {
      if (screen !== 'signin' || auth.busy) return false;
      const label =
        action.name === 'signin-google'
          ? 'Continue with Google'
          : 'Continue with Apple';
      if (action.name === 'signin-apple' && Platform.OS !== 'ios') return false;
      await act(async () => {
        pressLabel(renderer, label);
      });
      break;
    }
    case 'signin-dismiss-error': {
      if (screen !== 'signin') return false;
      if (!auth.error || auth.error.code === 'auth.canceled') return false;
      act(() => {
        pressLabel(renderer, 'Dismiss sign-in error');
      });
      break;
    }
    case 'auth-settle-success':
    case 'auth-settle-fail': {
      if (!seams.pendingAuth) return false;
      await act(async () => {
        settleAuth(action.name === 'auth-settle-success' ? 'success' : 'fail');
      });
      break;
    }
    case 'hydrate-settle-oldest':
    case 'hydrate-settle-newest': {
      if (seams.pendingHydrates.length === 0) return false;
      const pending =
        action.name === 'hydrate-settle-oldest'
          ? seams.pendingHydrates.shift()!
          : seams.pendingHydrates.pop()!;
      await act(async () => {
        settleHydrate(pending.owner);
        pending.resolve();
      });
      break;
    }
    case 'sign-out': {
      if (!auth.session) return false;
      await act(async () => {
        useAuthStore.setState({ session: null, busy: false, error: null });
      });
      break;
    }
    case 'error-retry-same':
    case 'error-retry-recover': {
      if (screen !== 'profile-error') return false;
      if (action.name === 'error-retry-recover') {
        harness.scenario.canonicalHydrateError = false;
      }
      await act(async () => {
        pressLabel(renderer, 'Try again');
      });
      model.expectedHydrateCalls += 1;
      break;
    }
    case 'appstate-background':
    case 'appstate-active': {
      const handler = latestAppStateHandler();
      if (!handler) return false;
      act(() => {
        handler(
          action.name === 'appstate-background' ? 'background' : 'active',
        );
      });
      if (action.name === 'appstate-background') model.expectedCleanEnds += 1;
      break;
    }
    case 'gate-remount': {
      act(() => {
        renderer.unmount();
      });
      harness.model = freshGate(model);
      await mountApp(harness);
      break;
    }
    case 'cold-restart': {
      act(() => {
        renderer.unmount();
      });
      resetStores();
      harness.model = freshGate(model);
      await mountApp(harness);
      break;
    }
    default: {
      const exhaustive: never = action.name;
      throw new Error(`unknown action ${String(exhaustive)}`);
    }
  }
  settleModel(harness.model);
  return true;
}

// ---------------------------------------------------------------------------
// Sequence runner
// ---------------------------------------------------------------------------

interface StepTrace {
  i: number;
  action: string;
  applied: boolean;
  screen: string;
  labels: string[];
  textHash: string;
  splash: string;
  stage: string;
  depth: number;
}

interface SequenceResult {
  seed: number;
  scenario: Scenario;
  actions: Action[];
  steps: number;
  ok: boolean;
  failedStep: number | null;
  failedInvariants: string[];
  failureDetail: string[];
  trace: StepTrace[];
  finalScreen: string;
  screensVisited: string[];
  durationMs: number;
}

function traceKey(trace: StepTrace[]): string {
  return JSON.stringify(trace);
}

async function createHarness(scenario: Scenario): Promise<Harness> {
  resetStores();
  seams.scenario = scenario;
  mockHydrateApp.mockClear();
  mockHydrateApp.mockImplementation(hydrateImpl);
  mockHydrateAuth.mockClear();
  mockSignInWithApple.mockImplementation(() => signInImpl('apple'));
  mockSignInWithGoogle.mockImplementation(() => signInImpl('google'));
  mockSignOut.mockImplementation(async () => {
    useAuthStore.setState({ session: null, busy: false, error: null });
  });
  mockClearError.mockImplementation(() => {
    useAuthStore.setState({ error: null });
  });
  mockCompletePreAuthOnboarding.mockImplementation(() =>
    Promise.resolve(seams.scenario!.preAuthStashOk),
  );
  mockCompleteOnboarding.mockImplementation(async () => {
    useAppStore.setState({ profile: onboardedProfile });
  });
  mockCompleteNotificationOnboarding.mockImplementation(() =>
    Promise.resolve(true),
  );
  (AppState.addEventListener as jest.Mock).mockClear();
  const recordSpy = jest.spyOn(stabilitySlo, 'record');
  const setContextSpy = jest.spyOn(stabilitySlo, 'setContext');
  recordSpy.mockClear();
  setContextSpy.mockClear();
  const harness: Harness = {
    renderer: null as unknown as Renderer,
    model: freshGate(null),
    scenario: { ...scenario },
    consoleErrors: [],
    recordSpy,
    setContextSpy,
  };
  await mountApp(harness);
  settleModel(harness.model);
  return harness;
}

function teardown(harness: Harness) {
  try {
    act(() => {
      harness.renderer.unmount();
    });
  } catch {
    // Already unmounted by a remount action; nothing to release.
  }
  mountedRenderers.length = 0;
}

const consoleErrorSink: string[] = [];
let consoleErrorSpy: jest.SpyInstance | null = null;

function installConsoleTrap() {
  consoleErrorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleErrorSink.push(
        args
          .map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
          .join(' '),
      );
    });
}

/**
 * Runs one sequence. `fixedActions` replays an explicit list (used by the
 * minimiser); otherwise the actions are drawn from the seeded RNG against
 * the live model, so the seed alone reproduces the sequence.
 */
async function runSequence(
  seed: number,
  fixedActions?: Action[],
): Promise<SequenceResult> {
  const started = Date.now();
  const rng = makePrng(seed);
  const scenario = drawScenario(rng);
  const harness = await createHarness(scenario);
  const actions: Action[] = [];
  const trace: StepTrace[] = [];
  const screensVisited = new Set<string>();
  let ok = true;
  let failedStep: number | null = null;
  let failedInvariants: string[] = [];
  let failureDetail: string[] = [];

  const observeAndCheck = (i: number, action: string, applied: boolean) => {
    const observation = observe(harness.renderer);
    screensVisited.add(observation.screen);
    const checks = checkInvariants(
      harness.renderer,
      harness.model,
      observation,
      consoleErrorSink.splice(0, consoleErrorSink.length),
      harness.recordSpy,
      harness.setContextSpy,
    );
    trace.push({
      i,
      action,
      applied,
      screen: observation.screen,
      labels: observation.labels,
      textHash: observation.textHash,
      splash: observation.splash ? `ready=${observation.splash.ready}` : 'gone',
      stage: harness.model.preAuthStage,
      depth: harness.model.onboarding.depth,
    });
    const failed = checks.filter(c => !c.ok);
    if (failed.length > 0) {
      ok = false;
      failedStep = i;
      failedInvariants = failed.map(c => c.name);
      failureDetail = failed.map(c => `${c.name}: ${c.detail ?? ''}`);
      return false;
    }
    return true;
  };

  // Step 0: the freshly mounted gate must already satisfy every invariant.
  consoleErrorSink.length = 0;
  if (observeAndCheck(0, 'mount', true)) {
    const total = fixedActions ? fixedActions.length : scenario.length;
    for (let i = 0; i < total; i += 1) {
      const action = fixedActions
        ? fixedActions[i]!
        : drawAction(harness.model, rng);
      actions.push(action);
      let applied = false;
      try {
        applied = await applyAction(harness, action);
      } catch (error) {
        ok = false;
        failedStep = i + 1;
        failedInvariants = ['no-throw'];
        failureDetail = [
          `no-throw: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
        ];
        trace.push({
          i: i + 1,
          action: actionLabel(action),
          applied: false,
          screen: 'threw',
          labels: [],
          textHash: '',
          splash: '',
          stage: harness.model.preAuthStage,
          depth: harness.model.onboarding.depth,
        });
        break;
      }
      if (!observeAndCheck(i + 1, actionLabel(action), applied)) break;
    }
  }

  const finalScreen = trace.at(-1)?.screen ?? 'none';
  teardown(harness);
  return {
    seed,
    scenario,
    actions,
    steps: trace.length - 1,
    ok,
    failedStep,
    failedInvariants,
    failureDetail,
    trace,
    finalScreen,
    screensVisited: [...screensVisited].sort(),
    durationMs: Date.now() - started,
  };
}

function actionLabel(action: Action): string {
  return action.arg === undefined
    ? action.name
    : `${action.name}(${action.arg})`;
}

/** Greedy 1-minimal reduction that keeps the same failing invariant set. */
async function minimize(result: SequenceResult): Promise<{
  actions: Action[];
  replays: number;
}> {
  const target = result.failedInvariants.join(',');
  let current = result.actions.slice(
    0,
    result.failedStep ?? result.actions.length,
  );
  let replays = 0;
  const stillFails = async (candidate: Action[]) => {
    replays += 1;
    const replay = await runSequence(result.seed, candidate);
    return !replay.ok && replay.failedInvariants.join(',') === target;
  };
  let changed = true;
  while (changed && replays < MINIMIZE_BUDGET) {
    changed = false;
    for (
      let i = current.length - 1;
      i >= 0 && replays < MINIMIZE_BUDGET;
      i -= 1
    ) {
      const candidate = [...current.slice(0, i), ...current.slice(i + 1)];
      if (await stillFails(candidate)) {
        current = candidate;
        changed = true;
      }
    }
  }
  return { actions: current, replays };
}

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------

interface SeedRow {
  seed: number;
  outcome: 'HELD' | 'BROKEN';
  steps: number;
  length: number;
  scenario: Omit<Scenario, 'length'>;
  screensVisited: string[];
  finalScreen: string;
  failedStep: number | null;
  failedInvariants: string[];
  failureDetail: string[];
  deterministic: boolean | null;
  minimizedActions: string[] | null;
  minimizeReplays: number | null;
  flakeRate: string | null;
  durationMs: number;
}

const seeds: number[] = SEED_FILTER
  ? [Number(SEED_FILTER)]
  : Array.from({ length: STRESS_ITER }, (_, i) => SEED_START + i);

beforeAll(() => {
  installConsoleTrap();
});

afterAll(() => {
  consoleErrorSpy?.mockRestore();
  jest.restoreAllMocks();
});

afterEach(() => {
  while (mountedRenderers.length > 0) {
    const renderer = mountedRenderers.pop()!;
    try {
      act(() => renderer.unmount());
    } catch {
      // already unmounted
    }
  }
});

describe(`WelcomeScreen randomized-seeded stress (${seeds.length} seeds from ${seeds[0]}, length ${MIN_LEN}-${MAX_LEN})`, () => {
  const rows: SeedRow[] = [];
  const failures: SequenceResult[] = [];
  let executedSteps = 0;
  let determinismChecked = 0;
  let determinismMismatches = 0;
  const heap: Array<{ afterSeeds: number; heapUsedMb: number; rssMb: number }> =
    [];

  test(
    'every seeded action sequence keeps all gate/Welcome invariants',
    async () => {
      const campaignStart = Date.now();
      for (const [index, seed] of seeds.entries()) {
        const result = await runSequence(seed);
        executedSteps += result.steps;

        let deterministic: boolean | null = null;
        if (index % DETERMINISM_EVERY === 0 || !result.ok) {
          const again = await runSequence(seed);
          executedSteps += again.steps;
          deterministic = traceKey(again.trace) === traceKey(result.trace);
          determinismChecked += 1;
          if (!deterministic) determinismMismatches += 1;
        }

        let minimizedActions: string[] | null = null;
        let minimizeReplays: number | null = null;
        let flakeRate: string | null = null;
        if (!result.ok) {
          failures.push(result);
          const reduced = await minimize(result);
          minimizedActions = reduced.actions.map(actionLabel);
          minimizeReplays = reduced.replays;
          let reruns = 0;
          for (let r = 0; r < FLAKE_RERUNS; r += 1) {
            const rerun = await runSequence(seed);
            executedSteps += rerun.steps;
            if (!rerun.ok) reruns += 1;
          }
          flakeRate = `${reruns}/${FLAKE_RERUNS}`;
        }

        const { length, ...scenarioRest } = result.scenario;
        rows.push({
          seed,
          outcome: result.ok && deterministic !== false ? 'HELD' : 'BROKEN',
          steps: result.steps,
          length,
          scenario: scenarioRest,
          screensVisited: result.screensVisited,
          finalScreen: result.finalScreen,
          failedStep: result.failedStep,
          failedInvariants: result.failedInvariants,
          failureDetail: result.failureDetail,
          deterministic,
          minimizedActions,
          minimizeReplays,
          flakeRate,
          durationMs: result.durationMs,
        });

        if ((index + 1) % 100 === 0 || index === seeds.length - 1) {
          const usage = nodeProcess.memoryUsage();
          heap.push({
            afterSeeds: index + 1,
            heapUsedMb: Math.round(usage.heapUsed / 1048576),
            rssMb: Math.round(usage.rss / 1048576),
          });
        }
      }

      const broken = rows.filter(row => row.outcome === 'BROKEN');
      const screenHistogram: Record<string, number> = {};
      for (const row of rows) {
        for (const screen of row.screensVisited) {
          screenHistogram[screen] = (screenHistogram[screen] ?? 0) + 1;
        }
      }
      const summary = {
        suite: 'welcomeScreenRandomizedSeeded.stress',
        seedStart: seeds[0],
        seeds: seeds.length,
        sequencesExecuted: rows.length,
        stepsExecuted: executedSteps,
        lengthRange: [MIN_LEN, MAX_LEN],
        held: rows.length - broken.length,
        broken: broken.length,
        brokenSeeds: broken.map(row => row.seed),
        determinismChecked,
        determinismMismatches,
        screensVisitedBySequence: screenHistogram,
        heap,
        node: nodeProcess.version,
        durationMs: Date.now() - campaignStart,
      };
      const tableFile = writeArtifact('seed-table.json', rows);
      const summaryFile = writeArtifact('summary.json', summary);
      writeArtifact('failures.json', failures);
      writeArtifact('welcome-tree.json', {
        hash: referenceWelcomeTree ? hashString(referenceWelcomeTree) : null,
        tree: referenceWelcomeTreeJson,
      });

      // Jest's own assertion carries the pointer to the evidence.
      expect({
        broken: broken.map(row => ({
          seed: row.seed,
          failedStep: row.failedStep,
          failedInvariants: row.failedInvariants,
          detail: row.failureDetail,
          minimized: row.minimizedActions,
          flakeRate: row.flakeRate,
        })),
        determinismMismatches,
        artifacts: [tableFile, summaryFile],
      }).toEqual({
        broken: [],
        determinismMismatches: 0,
        artifacts: [tableFile, summaryFile],
      });
      expect(rows.length).toBe(seeds.length);
      expect(executedSteps).toBeGreaterThanOrEqual(rows.length * MIN_LEN);
    },
    // Campaign-scale runs (STRESS_ITER in the thousands) need real time.
    Math.max(60_000, seeds.length * 3_000),
  );
});
