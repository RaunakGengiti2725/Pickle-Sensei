import React from 'react';
import { AppState } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { create } from 'zustand';
import {
  InvariantViolation,
  runSeed,
  summarize,
  writeCampaignArtifact,
  type SequenceRow,
  type Session,
  type SuiteSpec,
} from '../../../stress-harness/mod-app-root/campaign';
import {
  chunk,
  planCampaign,
  type Rng,
} from '../../../stress-harness/mod-app-root/prng';

/**
 * STRESS `mod-app-root` / lens `randomized-seeded` — App.tsx root Gate.
 *
 * Mounts the REAL `App` (RootErrorBoundary → Gate) with controllable zustand
 * stores and marker stubs for every screen the Gate routes to, then drives
 * seeded random sequences (length 5..60) of legal and near-legal launch
 * events over its public seams — cold mount / unmount (warm relaunch), auth
 * hydration landing signed-out / guest / canonical / switched accounts,
 * app-store hydration landing for the right owner, a STALE owner, with or
 * without a profile, or failing, splash hand-off, pre-auth navigation
 * callbacks, hydrate retry, AppState transitions and a render throw deep
 * below the Gate followed by the boundary's retry.
 *
 * After EVERY step a reference model of the Gate (transcribed from App.tsx
 * and the launch contract in AGENTS.md / launchGate.ts) predicts the exact
 * branch, splash state, hydrate/auth call counts, stability-context owner,
 * listener balance and crash telemetry, and the rendered tree is compared
 * against it. Invariants checked (ids appear in failure rows):
 *
 *  noThrow             no action throws out of react-test-renderer's act
 *  singleBranch        exactly one Gate branch is mounted at a time
 *  branchMatchesModel  the mounted branch is the one App.tsx's routing table
 *                      implies for the current stores / pre-auth stage
 *  authFirst           appStore.hydrate is never called before auth hydrated
 *  ownerAgreement      any non-loading branch ⇒ appStore.ownerKey equals the
 *                      owner implied by the auth session (no stale-owner UI)
 *  mainAppGated        RootNavigator ⇒ ready ∧ session ∧ profile
 *  hydrateCallCount    exactly one appStore.hydrate per desired-owner change
 *                      (+1 per Gate mount with a known owner, +1 per retry)
 *  authHydrateCount    exactly one authStore.hydrate per Gate mount
 *  stabilityContext    stability userKey is the pseudonymous data-owner key
 *                      once known, never an email/subject
 *  splash              splash mounted until onFinished, `ready` prop tracks
 *                      the gate, never re-shown after it finished (except a
 *                      boundary retry, which remounts the Gate by design)
 *  crashTelemetry      one non-fatal crash event with an 8-hex fingerprint
 *                      per boundary catch; none otherwise
 *  listenerBalance     one live AppState listener while the Gate is mounted,
 *                      zero after unmount / while the boundary is showing
 *  cleanEndTelemetry   'background' records exactly one session_ended_clean
 *  preAuthOrder        Welcome → questionnaire → sign-in; questionnaire back
 *                      → Welcome; never sign-in straight from Start
 *  determinism         same seed twice → identical action list and trace
 *
 * Default campaign is small (suite speed); `STRESS_ITER=2000 npx jest --ci
 * __tests__/stress/mod-app-root/appRootGate` runs the full lens, and
 * `STRESS_SEED=<seed>` replays one row with its full trace in the artifact
 * `artifacts/stress/mod-app-root/appRootGate.randomizedSeeded.json`.
 */

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View, SafeAreaProvider: View };
});

// Deep-child crash probe (stress-harness/mod-app-root/crashProbe.tsx): every
// Gate branch stub renders one; arming it throws far below the root.
jest.mock('../../../src/navigation/RootNavigator', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const {
    CrashProbe,
  } = require('../../../stress-harness/mod-app-root/crashProbe');
  return {
    RootNavigator: () =>
      R.createElement(
        'View',
        { testID: 'RootNavigator' },
        R.createElement(CrashProbe),
      ),
  };
});
jest.mock('../../../src/screens/OnboardingScreen', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const {
    CrashProbe,
  } = require('../../../stress-harness/mod-app-root/crashProbe');
  return {
    OnboardingScreen: (props: {
      mode?: string;
      onFinished?: () => void;
      onBack?: () => void;
    }) =>
      R.createElement(
        'View',
        {
          testID: 'Onboarding',
          mode: props.mode ?? null,
          onFinished: props.onFinished,
          onBack: props.onBack,
        },
        R.createElement(CrashProbe),
      ),
  };
});
jest.mock('../../../src/screens/WelcomeScreen', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const {
    CrashProbe,
  } = require('../../../stress-harness/mod-app-root/crashProbe');
  return {
    WelcomeScreen: (props: {
      onGetStarted: () => void;
      onSignIn: () => void;
    }) =>
      R.createElement(
        'View',
        {
          testID: 'Welcome',
          onGetStarted: props.onGetStarted,
          onSignIn: props.onSignIn,
        },
        R.createElement(CrashProbe),
      ),
  };
});
jest.mock('../../../src/screens/SignInScreen', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const {
    CrashProbe,
  } = require('../../../stress-harness/mod-app-root/crashProbe');
  return {
    SignInScreen: (props: { onBack: () => void }) =>
      R.createElement(
        'View',
        { testID: 'SignIn', onBack: props.onBack },
        R.createElement(CrashProbe),
      ),
  };
});
jest.mock('../../../src/screens/SplashScreen', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    SplashScreen: (props: { ready: boolean; onFinished: () => void }) =>
      R.createElement('View', {
        testID: 'Splash',
        ready: props.ready,
        onFinished: props.onFinished,
      }),
  };
});
jest.mock('../../../src/design/components', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const actual = jest.requireActual<
    typeof import('../../../src/design/components')
  >('../../../src/design/components');
  const {
    CrashProbe,
  } = require('../../../stress-harness/mod-app-root/crashProbe');
  return {
    ...actual,
    // The boundary's own ErrorState must NOT carry a probe: a throw inside
    // the fallback would escape the boundary that renders it.
    ErrorState: (props: {
      title: string;
      detail: string;
      onRetry?: () => void;
    }) =>
      R.createElement(
        'View',
        {
          testID: 'ErrorState',
          title: props.title,
          detail: props.detail,
          onRetry: props.onRetry,
        },
        props.title === 'Something went wrong'
          ? null
          : R.createElement(CrashProbe),
      ),
    LoadingState: (props: { label: string }) =>
      R.createElement(
        'View',
        { testID: 'LoadingState', label: props.label },
        R.createElement(CrashProbe),
      ),
  };
});
jest.mock('../../../src/design/BrandNotice', () => ({
  BrandNoticeHost: () => null,
  showBrandNotice: () => {},
}));
jest.mock('../../../src/components/RankUpCelebration', () => ({
  RankUpCelebration: () => null,
}));
jest.mock('../../../src/consistency/StreakCelebration', () => ({
  StreakCelebration: () => null,
}));
jest.mock('../../../src/walkthrough/FirstRunWalkthrough', () => ({
  FirstRunWalkthrough: () => null,
}));
jest.mock('../../../src/walkthrough/walkthroughStore', () => {
  const state = { maybeShowFirstRun: async () => {} };
  return {
    useWalkthroughStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});
jest.mock('../../../src/notifications/useNotificationBootstrap', () => ({
  useNotificationBootstrap: () => {},
}));
jest.mock('../../../src/consistency/useConsistencyBootstrap', () => ({
  useConsistencyBootstrap: () => {},
}));

// ─── Controllable stores ────────────────────────────────────────────────────

interface Profile {
  skillLevel: string;
}
interface MockAppState {
  hydrated: boolean;
  ownerKey: string | null;
  profile: Profile | null;
  hydrateError: string | null;
  hydrate: () => Promise<void>;
}
interface MockSession {
  provider: 'apple' | 'google' | 'guest';
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
}

/** Call ledger the mocks write into; read by the invariant checks. */
const ledger = {
  hydrateAppCalls: 0,
  /** authStore.hydrated observed at each appStore.hydrate call. */
  hydrateAppAuthHydratedAtCall: [] as boolean[],
  hydrateAuthCalls: 0,
};

const mockUseAppStore = create<MockAppState>(() => ({
  hydrated: false,
  ownerKey: null,
  profile: null,
  hydrateError: null,
  hydrate: async () => {
    ledger.hydrateAppCalls += 1;
    ledger.hydrateAppAuthHydratedAtCall.push(
      mockUseAuthStore.getState().hydrated,
    );
  },
}));
jest.mock('../../../src/state/appStore', () => ({
  useAppStore: (selector: (s: MockAppState) => unknown) =>
    mockUseAppStore(selector),
}));

const mockUseAuthStore = create<MockAuthState>(() => ({
  hydrated: false,
  session: null,
  hydrate: async () => {
    ledger.hydrateAuthCalls += 1;
  },
}));
jest.mock('../../../src/auth/authStore', () => ({
  useAuthStore: (selector: (s: MockAuthState) => unknown) =>
    mockUseAuthStore(selector),
}));

import App from '../../../App';
import { stabilitySlo } from '../../../src/analysis/stabilityTelemetry';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
} from '../../../src/data/accountScope';
import { armCrashProbe } from '../../../stress-harness/mod-app-root/crashProbe';

// ─── Action vocabulary ──────────────────────────────────────────────────────

type SessionKind = 'none' | 'guest' | 'canonicalA' | 'canonicalB';
type AppResolveMode =
  | 'desiredWithProfile'
  | 'desiredNoProfile'
  | 'desiredFailed'
  | 'staleOwnerWithProfile'
  | 'staleOwnerNoProfile';

type Action =
  | { kind: 'mount' }
  | { kind: 'unmount' }
  | { kind: 'authResolve'; session: SessionKind }
  | { kind: 'authSessionChange'; session: SessionKind }
  | { kind: 'authRehydrate' }
  | { kind: 'appResolve'; mode: AppResolveMode }
  | { kind: 'appReset' }
  | { kind: 'splashFinish' }
  | { kind: 'pressWelcomeStart' }
  | { kind: 'pressWelcomeSignIn' }
  | { kind: 'onboardingFinish' }
  | { kind: 'onboardingBack' }
  | { kind: 'signInBack' }
  | { kind: 'retryHydrate' }
  | { kind: 'crash' }
  | { kind: 'disarmCrash' }
  | { kind: 'boundaryRetry' }
  | { kind: 'appState'; state: 'active' | 'inactive' | 'background' };

const CANONICAL_A = '3F2504E0-4F89-11D3-9A0C-0305E82C3301';
const CANONICAL_B = '55555555-5555-4555-8555-555555555555';
const STALE_OWNER = '99999999-9999-4999-8999-999999999999';

function sessionFor(kind: SessionKind): MockSession | null {
  switch (kind) {
    case 'none':
      return null;
    case 'guest':
      return {
        provider: 'guest',
        subject: 'local-only',
        canonicalAppUserId: null,
        localOnly: true,
        displayName: null,
        email: null,
      };
    case 'canonicalA':
      return {
        provider: 'apple',
        subject: CANONICAL_A,
        canonicalAppUserId: CANONICAL_A,
        localOnly: false,
        displayName: 'Dana',
        email: 'dana@example.com',
      };
    case 'canonicalB':
      return {
        provider: 'google',
        subject: CANONICAL_B,
        canonicalAppUserId: CANONICAL_B,
        localOnly: false,
        displayName: null,
        email: 'b@example.com',
      };
  }
}

function ownerFor(kind: SessionKind): string {
  switch (kind) {
    case 'none':
      return SIGNED_OUT_DATA_OWNER;
    case 'guest':
      return GUEST_DATA_OWNER;
    case 'canonicalA':
      return CANONICAL_A.toLowerCase();
    case 'canonicalB':
      return CANONICAL_B.toLowerCase();
  }
}

// ─── Reference model (transcribed from App.tsx) ─────────────────────────────

type Branch =
  | 'Loading'
  | 'Welcome'
  | 'OnboardingPreAuth'
  | 'SignIn'
  | 'HydrateError'
  | 'OnboardingInAccount'
  | 'RootNavigator'
  | 'BoundaryError';

interface Model {
  // stores
  authHydrated: boolean;
  session: SessionKind;
  appHydrated: boolean;
  appOwnerKey: string | null;
  profile: boolean;
  hydrateError: string | null;
  // gate-local
  mounted: boolean;
  boundaryCaught: boolean;
  preAuthStage: 'welcome' | 'onboarding' | 'signin';
  splashDone: boolean;
  crashArmed: boolean;
  /** Owner the mounted Gate last ran its hydrate effect for. */
  lastEffectOwner: string | null;
  // expected counters
  hydrateAppCalls: number;
  hydrateAuthCalls: number;
  contextOwner: string | null;
  crashEvents: number;
  cleanEnds: number;
  listenersAdded: number;
  listenersRemoved: number;
}

function initialModel(): Model {
  return {
    authHydrated: false,
    session: 'none',
    appHydrated: false,
    appOwnerKey: null,
    profile: false,
    hydrateError: null,
    mounted: false,
    boundaryCaught: false,
    preAuthStage: 'welcome',
    splashDone: false,
    crashArmed: false,
    lastEffectOwner: null,
    hydrateAppCalls: 0,
    hydrateAuthCalls: 0,
    contextOwner: null,
    crashEvents: 0,
    cleanEnds: 0,
    listenersAdded: 0,
    listenersRemoved: 0,
  };
}

function desiredOwner(m: Model): string | null {
  return m.authHydrated ? ownerFor(m.session) : null;
}

function isReady(m: Model): boolean {
  const owner = desiredOwner(m);
  return Boolean(owner) && m.appHydrated && m.appOwnerKey === owner;
}

function predictBranch(m: Model): Branch | null {
  if (!m.mounted) return null;
  if (m.boundaryCaught) return 'BoundaryError';
  if (!isReady(m)) return 'Loading';
  if (m.session === 'none') {
    if (m.preAuthStage === 'signin') return 'SignIn';
    if (m.preAuthStage === 'onboarding') return 'OnboardingPreAuth';
    return 'Welcome';
  }
  if (!m.profile && m.hydrateError) return 'HydrateError';
  if (!m.profile) return 'OnboardingInAccount';
  return 'RootNavigator';
}

/** Gate committed (mounted, boundary not showing): effects are live. */
function gateLive(m: Model): boolean {
  return m.mounted && !m.boundaryCaught;
}

/** Re-run the Gate's owner effects for the current store state. */
function settleOwnerEffects(m: Model): void {
  if (!gateLive(m)) return;
  const owner = desiredOwner(m);
  if (owner && owner !== m.lastEffectOwner) {
    m.hydrateAppCalls += 1;
    m.contextOwner = owner;
  }
  m.lastEffectOwner = owner;
}

/** A store change re-rendered the Gate: an armed probe throws. */
function maybeCatch(m: Model): void {
  if (gateLive(m) && m.crashArmed) {
    m.boundaryCaught = true;
    m.crashEvents += 1;
    m.listenersRemoved += 1;
  }
}

/** Fresh Gate commit (mount or boundary retry). */
function commitGate(m: Model): void {
  m.preAuthStage = 'welcome';
  m.splashDone = false;
  if (m.crashArmed) {
    // Render throws before commit: no effects, no listener, one catch.
    m.boundaryCaught = true;
    m.crashEvents += 1;
    return;
  }
  m.boundaryCaught = false;
  m.hydrateAuthCalls += 1;
  m.listenersAdded += 1;
  m.lastEffectOwner = null;
  settleOwnerEffects(m);
}

// ─── Draw (legal / near-legal, model-aware) ─────────────────────────────────

const SESSION_KINDS: readonly SessionKind[] = [
  'none',
  'guest',
  'canonicalA',
  'canonicalB',
];
const APP_MODES: readonly AppResolveMode[] = [
  'desiredWithProfile',
  'desiredNoProfile',
  'desiredFailed',
  'staleOwnerWithProfile',
  'staleOwnerNoProfile',
];

function draw(rng: Rng, m: Model): Action {
  if (!m.mounted) {
    // Cold launch: stores may already hold state (warm relaunch) or not.
    return rng.weighted<Action>(
      [
        { kind: 'mount' },
        { kind: 'authResolve', session: rng.pick(SESSION_KINDS) },
        { kind: 'appResolve', mode: rng.pick(APP_MODES) },
        { kind: 'appReset' },
        { kind: 'authRehydrate' },
      ],
      [10, 2, 1, 1, 1],
    );
  }
  if (m.boundaryCaught) {
    return rng.weighted<Action>(
      [
        { kind: 'disarmCrash' },
        { kind: 'boundaryRetry' },
        { kind: 'unmount' },
        { kind: 'authSessionChange', session: rng.pick(SESSION_KINDS) },
        { kind: 'appResolve', mode: rng.pick(APP_MODES) },
        { kind: 'appState', state: 'background' },
      ],
      [6, 6, 1, 1, 1, 1],
    );
  }
  const branch = predictBranch(m);
  const candidates: Action[] = [];
  const weights: number[] = [];
  const add = (action: Action, weight: number) => {
    candidates.push(action);
    weights.push(weight);
  };
  if (!m.authHydrated) {
    add({ kind: 'authResolve', session: rng.pick(SESSION_KINDS) }, 14);
  } else {
    add({ kind: 'authSessionChange', session: rng.pick(SESSION_KINDS) }, 5);
    add({ kind: 'authRehydrate' }, 1);
  }
  add(
    {
      kind: 'appResolve',
      mode: rng.weighted(APP_MODES, [6, 3, 2, 2, 1]),
    },
    m.authHydrated && !isReady(m) ? 14 : 4,
  );
  add({ kind: 'appReset' }, 1);
  if (!m.splashDone) add({ kind: 'splashFinish' }, isReady(m) ? 8 : 2);
  if (branch === 'Welcome') {
    add({ kind: 'pressWelcomeStart' }, 6);
    add({ kind: 'pressWelcomeSignIn' }, 4);
  }
  if (branch === 'OnboardingPreAuth') {
    add({ kind: 'onboardingFinish' }, 6);
    add({ kind: 'onboardingBack' }, 3);
  }
  if (branch === 'SignIn') add({ kind: 'signInBack' }, 4);
  if (branch === 'HydrateError') add({ kind: 'retryHydrate' }, 6);
  add({ kind: 'crash' }, 2);
  add(
    {
      kind: 'appState',
      state: rng.pick(['active', 'inactive', 'background'] as const),
    },
    2,
  );
  add({ kind: 'unmount' }, 2);
  return rng.weighted(candidates, weights);
}

// ─── Observation of the real tree ───────────────────────────────────────────

interface Observation {
  branch: Branch | 'NONE' | 'MULTI';
  branches: string[];
  splash: { present: boolean; ready: boolean | null };
  loadingLabel: string | null;
  hydrateAppCalls: number;
  hydrateAuthCalls: number;
  contextOwner: string | null;
  crashEvents: number;
  cleanEnds: number;
  listenersAdded: number;
  listenersRemoved: number;
}

type Renderer = TestRenderer.ReactTestRenderer;
type Instance = TestRenderer.ReactTestInstance;

function hostMarkers(renderer: Renderer, testID: string): Instance[] {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && node.props.testID === testID,
  );
}

const appStateListener = AppState.addEventListener as jest.Mock;
const setContextSpy = jest.spyOn(stabilitySlo, 'setContext');

function currentContextOwner(): string | null {
  const last = setContextSpy.mock.calls[setContextSpy.mock.calls.length - 1];
  if (!last) return null;
  const [context] = last as [{ userKey: string }];
  return context.userKey;
}

function removedListenerCount(): number {
  return appStateListener.mock.results.reduce((count, result) => {
    const subscription = result.value as { remove: jest.Mock } | undefined;
    return count + (subscription?.remove.mock.calls.length ?? 0);
  }, 0);
}

function observe(renderer: Renderer | null): Observation {
  const branches: string[] = [];
  let splash: Observation['splash'] = { present: false, ready: null };
  let loadingLabel: string | null = null;
  if (renderer) {
    for (const marker of hostMarkers(renderer, 'LoadingState')) {
      branches.push('Loading');
      loadingLabel = marker.props.label as string;
    }
    if (hostMarkers(renderer, 'Welcome').length) branches.push('Welcome');
    for (const marker of hostMarkers(renderer, 'Onboarding')) {
      branches.push(
        marker.props.mode === 'preauth'
          ? 'OnboardingPreAuth'
          : 'OnboardingInAccount',
      );
    }
    if (hostMarkers(renderer, 'SignIn').length) branches.push('SignIn');
    for (const marker of hostMarkers(renderer, 'ErrorState')) {
      branches.push(
        marker.props.title === 'Something went wrong'
          ? 'BoundaryError'
          : 'HydrateError',
      );
    }
    if (hostMarkers(renderer, 'RootNavigator').length) {
      branches.push('RootNavigator');
    }
    const splashes = hostMarkers(renderer, 'Splash');
    if (splashes.length > 1) branches.push('MULTI_SPLASH');
    splash = {
      present: splashes.length > 0,
      ready: splashes.length ? (splashes[0]!.props.ready as boolean) : null,
    };
  }
  const events = stabilitySlo.events();
  return {
    branch:
      branches.length === 1
        ? (branches[0] as Branch)
        : branches.length === 0
          ? 'NONE'
          : 'MULTI',
    branches,
    splash,
    loadingLabel,
    hydrateAppCalls: ledger.hydrateAppCalls,
    hydrateAuthCalls: ledger.hydrateAuthCalls,
    contextOwner: currentContextOwner(),
    crashEvents: events.filter(e => e.kind === 'crash').length,
    cleanEnds: events.filter(e => e.kind === 'session_ended_clean').length,
    listenersAdded: appStateListener.mock.calls.length,
    listenersRemoved: removedListenerCount(),
  };
}

// ─── Session: executes actions against the real App ─────────────────────────

function resetWorld(): void {
  ledger.hydrateAppCalls = 0;
  ledger.hydrateAppAuthHydratedAtCall = [];
  ledger.hydrateAuthCalls = 0;
  mockUseAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
  });
  mockUseAuthStore.setState({ hydrated: false, session: null });
  armCrashProbe(false);
  stabilitySlo.reset();
  setContextSpy.mockClear();
  appStateListener.mockClear();
}

function fail(invariant: string, detail: string): never {
  throw new InvariantViolation(invariant, detail);
}

function check(m: Model, o: Observation, action: Action): void {
  const expected = predictBranch(m);
  if (m.mounted) {
    if (o.branch === 'NONE' || o.branch === 'MULTI') {
      fail(
        'singleBranch',
        `after ${action.kind}: mounted ${JSON.stringify(o.branches)}`,
      );
    }
  } else if (o.branch !== 'NONE') {
    fail(
      'singleBranch',
      `unmounted but rendered ${JSON.stringify(o.branches)}`,
    );
  }
  if ((expected ?? 'NONE') !== o.branch) {
    fail(
      'branchMatchesModel',
      `after ${action.kind}: expected ${expected ?? 'NONE'}, rendered ${o.branch} (model ${JSON.stringify(
        {
          authHydrated: m.authHydrated,
          session: m.session,
          appHydrated: m.appHydrated,
          appOwnerKey: m.appOwnerKey,
          profile: m.profile,
          hydrateError: m.hydrateError,
          preAuthStage: m.preAuthStage,
        },
      )})`,
    );
  }
  if (o.branch === 'Loading') {
    const wantLabel =
      m.session === 'none' ? 'Getting things ready' : 'Loading your account';
    if (o.loadingLabel !== wantLabel) {
      fail(
        'branchMatchesModel',
        `loading label ${JSON.stringify(o.loadingLabel)} ≠ ${wantLabel}`,
      );
    }
  }
  if (ledger.hydrateAppAuthHydratedAtCall.some(v => !v)) {
    fail('authFirst', 'appStore.hydrate called before auth hydrated');
  }
  const owner = desiredOwner(m);
  if (
    o.branch !== 'Loading' &&
    o.branch !== 'BoundaryError' &&
    o.branch !== 'NONE'
  ) {
    const store = mockUseAppStore.getState();
    if (
      !store.hydrated ||
      store.ownerKey !== owner ||
      !mockUseAuthStore.getState().hydrated
    ) {
      fail(
        'ownerAgreement',
        `${o.branch} rendered with appStore.ownerKey=${store.ownerKey} hydrated=${store.hydrated} while auth implies ${owner}`,
      );
    }
  }
  if (o.branch === 'RootNavigator') {
    const store = mockUseAppStore.getState();
    if (!isReady(m) || m.session === 'none' || !store.profile) {
      fail('mainAppGated', 'RootNavigator without ready ∧ session ∧ profile');
    }
  }
  if (o.hydrateAppCalls !== m.hydrateAppCalls) {
    fail(
      'hydrateCallCount',
      `after ${action.kind}: appStore.hydrate called ${o.hydrateAppCalls}×, model expects ${m.hydrateAppCalls}`,
    );
  }
  if (o.hydrateAuthCalls !== m.hydrateAuthCalls) {
    fail(
      'authHydrateCount',
      `authStore.hydrate called ${o.hydrateAuthCalls}×, model expects ${m.hydrateAuthCalls}`,
    );
  }
  if (o.contextOwner !== m.contextOwner) {
    fail(
      'stabilityContext',
      `stability userKey ${o.contextOwner} ≠ model ${m.contextOwner}`,
    );
  }
  if (o.contextOwner !== null) {
    const allowed = new Set([
      GUEST_DATA_OWNER,
      SIGNED_OUT_DATA_OWNER,
      CANONICAL_A.toLowerCase(),
      CANONICAL_B.toLowerCase(),
    ]);
    if (!allowed.has(o.contextOwner)) {
      fail(
        'stabilityContext',
        `userKey ${o.contextOwner} is not a data-owner key`,
      );
    }
  }
  const splashExpected = gateLive(m) && !m.splashDone;
  if (o.splash.present !== splashExpected) {
    fail(
      'splash',
      `splash present=${o.splash.present}, expected ${splashExpected} (splashDone=${m.splashDone})`,
    );
  }
  if (o.splash.present && o.splash.ready !== isReady(m)) {
    fail('splash', `splash ready=${o.splash.ready}, gate ready=${isReady(m)}`);
  }
  if (o.crashEvents !== m.crashEvents) {
    fail(
      'crashTelemetry',
      `${o.crashEvents} crash events recorded, model expects ${m.crashEvents}`,
    );
  }
  for (const event of stabilitySlo.events()) {
    if (event.kind !== 'crash') continue;
    if (event.fatal !== false || !/^[0-9a-f]{8}$/.test(event.fingerprint)) {
      fail(
        'crashTelemetry',
        `boundary crash event malformed: ${JSON.stringify(event)}`,
      );
    }
  }
  const live = o.listenersAdded - o.listenersRemoved;
  if (live !== (gateLive(m) ? 1 : 0)) {
    fail(
      'listenerBalance',
      `${live} live AppState listeners (added ${o.listenersAdded}, removed ${o.listenersRemoved}) with gateLive=${gateLive(m)}`,
    );
  }
  if (
    o.listenersAdded !== m.listenersAdded ||
    o.listenersRemoved !== m.listenersRemoved
  ) {
    fail(
      'listenerBalance',
      `listeners added/removed ${o.listenersAdded}/${o.listenersRemoved}, model ${m.listenersAdded}/${m.listenersRemoved}`,
    );
  }
  if (o.cleanEnds !== m.cleanEnds) {
    fail(
      'cleanEndTelemetry',
      `${o.cleanEnds} session_ended_clean events, model expects ${m.cleanEnds}`,
    );
  }
}

class GateSession implements Session<Action, Observation> {
  private renderer: Renderer | null = null;

  constructor(private readonly m: Model) {
    resetWorld();
  }

  private prop<T>(testID: string, name: string): T {
    const [marker] = this.renderer ? hostMarkers(this.renderer, testID) : [];
    if (!marker) {
      fail('branchMatchesModel', `no mounted ${testID} to drive`);
    }
    return marker.props[name] as T;
  }

  private liveListener(): (state: string) => void {
    const last =
      appStateListener.mock.calls[appStateListener.mock.calls.length - 1];
    if (!last) fail('listenerBalance', 'no AppState listener registered');
    return (last as [string, (state: string) => void])[1];
  }

  step(action: Action): Observation {
    const m = this.m;
    act(() => {
      switch (action.kind) {
        case 'mount': {
          if (m.mounted) return;
          m.mounted = true;
          commitGate(m);
          this.renderer = TestRenderer.create(<App />);
          return;
        }
        case 'unmount': {
          if (!m.mounted) return;
          if (gateLive(m)) m.listenersRemoved += 1;
          m.mounted = false;
          m.boundaryCaught = false;
          this.renderer?.unmount();
          this.renderer = null;
          return;
        }
        case 'authResolve': {
          m.authHydrated = true;
          m.session = action.session;
          mockUseAuthStore.setState({
            hydrated: true,
            session: sessionFor(action.session),
          });
          maybeCatch(m);
          settleOwnerEffects(m);
          return;
        }
        case 'authSessionChange': {
          if (!m.authHydrated) return;
          m.session = action.session;
          mockUseAuthStore.setState({ session: sessionFor(action.session) });
          maybeCatch(m);
          settleOwnerEffects(m);
          return;
        }
        case 'authRehydrate': {
          m.authHydrated = false;
          mockUseAuthStore.setState({ hydrated: false });
          maybeCatch(m);
          settleOwnerEffects(m);
          return;
        }
        case 'appResolve': {
          const owner = desiredOwner(m) ?? SIGNED_OUT_DATA_OWNER;
          const target =
            action.mode === 'staleOwnerWithProfile' ||
            action.mode === 'staleOwnerNoProfile'
              ? STALE_OWNER
              : owner;
          const profile =
            action.mode === 'desiredWithProfile' ||
            action.mode === 'staleOwnerWithProfile';
          const error =
            action.mode === 'desiredFailed'
              ? 'Your coaching profile is unavailable right now.'
              : null;
          m.appHydrated = true;
          m.appOwnerKey = target;
          m.profile = profile;
          m.hydrateError = error;
          mockUseAppStore.setState({
            hydrated: true,
            ownerKey: target,
            profile: profile ? { skillLevel: '3.5' } : null,
            hydrateError: error,
          });
          maybeCatch(m);
          return;
        }
        case 'appReset': {
          m.appHydrated = false;
          m.appOwnerKey = null;
          m.profile = false;
          m.hydrateError = null;
          mockUseAppStore.setState({
            hydrated: false,
            ownerKey: null,
            profile: null,
            hydrateError: null,
          });
          maybeCatch(m);
          return;
        }
        case 'splashFinish': {
          if (!gateLive(m) || m.splashDone) return;
          this.prop<() => void>('Splash', 'onFinished')();
          m.splashDone = true;
          return;
        }
        case 'pressWelcomeStart': {
          if (predictBranch(m) !== 'Welcome') return;
          this.prop<() => void>('Welcome', 'onGetStarted')();
          m.preAuthStage = 'onboarding';
          return;
        }
        case 'pressWelcomeSignIn': {
          if (predictBranch(m) !== 'Welcome') return;
          this.prop<() => void>('Welcome', 'onSignIn')();
          m.preAuthStage = 'signin';
          return;
        }
        case 'onboardingFinish': {
          if (predictBranch(m) !== 'OnboardingPreAuth') return;
          this.prop<() => void>('Onboarding', 'onFinished')();
          m.preAuthStage = 'signin';
          return;
        }
        case 'onboardingBack': {
          if (predictBranch(m) !== 'OnboardingPreAuth') return;
          this.prop<() => void>('Onboarding', 'onBack')();
          m.preAuthStage = 'welcome';
          return;
        }
        case 'signInBack': {
          if (predictBranch(m) !== 'SignIn') return;
          this.prop<() => void>('SignIn', 'onBack')();
          m.preAuthStage = 'welcome';
          return;
        }
        case 'retryHydrate': {
          if (predictBranch(m) !== 'HydrateError') return;
          this.prop<() => void>('ErrorState', 'onRetry')();
          m.hydrateAppCalls += 1;
          return;
        }
        case 'crash': {
          if (!gateLive(m)) return;
          m.crashArmed = true;
          armCrashProbe(true);
          maybeCatch(m);
          return;
        }
        case 'disarmCrash': {
          m.crashArmed = false;
          armCrashProbe(false);
          return;
        }
        case 'boundaryRetry': {
          if (!m.mounted || !m.boundaryCaught) return;
          this.prop<() => void>('ErrorState', 'onRetry')();
          commitGate(m);
          return;
        }
        case 'appState': {
          if (!gateLive(m)) return;
          this.liveListener()(action.state);
          if (action.state === 'background') m.cleanEnds += 1;
          return;
        }
      }
    });
    const observation = observe(this.renderer);
    check(this.m, observation, action);
    return observation;
  }

  close(): void {
    if (this.renderer) {
      const renderer = this.renderer;
      this.renderer = null;
      act(() => renderer.unmount());
    }
    armCrashProbe(false);
  }
}

const spec: SuiteSpec<Action, Observation, Model> = {
  name: 'appRootGate.randomizedSeeded',
  initialModel,
  draw: (rng, model) => draw(rng, model),
  open: model => new GateSession(model),
  observationKey: o =>
    `${o.branch}${o.splash.present ? (o.splash.ready ? '+splashReady' : '+splash') : ''}`,
};

const INVARIANTS = [
  'noThrow',
  'singleBranch',
  'branchMatchesModel',
  'authFirst',
  'ownerAgreement',
  'mainAppGated',
  'hydrateCallCount',
  'authHydrateCount',
  'stabilityContext',
  'splash',
  'crashTelemetry',
  'listenerBalance',
  'cleanEndTelemetry',
  'preAuthOrder',
  'determinism',
] as const;

// ─── Campaign ───────────────────────────────────────────────────────────────

const plan = planCampaign(40);
const rows: SequenceRow<Action, Observation>[] = [];
const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

afterAll(() => {
  consoleError.mockRestore();
  const summary = summarize(spec.name, rows, INVARIANTS, a => a.kind);
  writeCampaignArtifact(summary);
});

describe('App.tsx root Gate — seeded randomized launch sequences', () => {
  const chunks = chunk(plan.seeds, 50);
  if (chunks.length === 0) {
    it('runs no sequences when STRESS_ITER=0', () => {
      expect(plan.seeds).toHaveLength(0);
    });
  }
  it.each(chunks.map((seeds, index) => [index, seeds] as const))(
    'chunk %i holds every invariant',
    (_index, seeds) => {
      const failures: string[] = [];
      for (const seed of seeds) {
        const row = runSeed(spec, seed, {
          minLen: plan.minLen,
          maxLen: plan.maxLen,
          determinism: true,
          keepTrace: plan.replayOnly !== null,
        });
        rows.push(row);
        if (row.outcome !== 'HELD') {
          failures.push(
            `seed ${row.seed}: ${row.outcome} ${row.invariant} — ${row.error} (minimized to ${row.minimized?.steps ?? '?'} steps)`,
          );
        }
      }
      expect(failures).toEqual([]);
    },
    240_000,
  );

  it('pre-auth order: Start never reaches sign-in directly (preAuthOrder)', () => {
    // Directed probe on top of the random campaign: the questionnaire is the
    // only path from Start to sign-in.
    const m = initialModel();
    const session = new GateSession(m);
    try {
      session.step({ kind: 'mount' });
      session.step({ kind: 'authResolve', session: 'none' });
      session.step({ kind: 'appResolve', mode: 'desiredNoProfile' });
      const afterStart = session.step({ kind: 'pressWelcomeStart' });
      if (afterStart.branch !== 'OnboardingPreAuth') {
        fail('preAuthOrder', `Start landed on ${afterStart.branch}`);
      }
      const afterBack = session.step({ kind: 'onboardingBack' });
      if (afterBack.branch !== 'Welcome') {
        fail(
          'preAuthOrder',
          `questionnaire back landed on ${afterBack.branch}`,
        );
      }
      session.step({ kind: 'pressWelcomeStart' });
      const afterFinish = session.step({ kind: 'onboardingFinish' });
      if (afterFinish.branch !== 'SignIn') {
        fail('preAuthOrder', `finish landed on ${afterFinish.branch}`);
      }
    } finally {
      session.close();
    }
  });
});
