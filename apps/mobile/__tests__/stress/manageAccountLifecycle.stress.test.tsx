/**
 * STRESS — ManageAccountScreen under lifecycle interruption.
 *
 * The real ManageAccountScreen is rendered inside a real
 * @react-navigation native stack (the same `Stack.Screen` registration
 * RootNavigator uses) behind a Gate that mirrors App.tsx's rule "no session
 * ⇒ pre-auth surface, session ⇒ navigator", with the real auth store,
 * session keeper, api-session store, deletion client, sync runtime and
 * BrandNoticeHost. Only native seams are replaced: SQLite (in-memory
 * FakeLocalDb), Keychain (the repo's in-memory auto-mock), the Apple
 * sign-in native module, the Google SDK, device context and `fetch`
 * (ScriptedServer). Runtime config points at a test origin so nothing can
 * ever address the production project.
 *
 * Each iteration is a seeded schedule (see
 * __harness__/stress/manageAccountLifecycle/scenario.ts) that drives the
 * deletion dialog — survey → review → requesting → armed countdown →
 * deleting — while interruptions land at seeded offsets: background /
 * foreground, cancel, navigation pop (unmount mid-request), tree remount,
 * forced bearer rotation, server-side revocation, process kill + relaunch
 * (re-hydrate from the Keychain), account switch and a concurrent second
 * hydrate(). Invariants are checked from the server's request log, the
 * store, the Keychain, the fake SQLite, the rendered tree and Jest's timer
 * table.
 *
 * Replay:   STRESS_SEED=7042 npx jest --ci __tests__/stress/manageAccountLifecycle
 * Campaign: STRESS_ITER=120 npx jest --ci --detectOpenHandles __tests__/stress/manageAccountLifecycle
 * Artifacts: apps/mobile/artifacts/xc-lifecycle-persistence/stress-manage-account-lifecycle.*
 */
import React from 'react';
import { AppState, NativeModules, Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  createNavigationContainerRef,
  NavigationContainer,
  useNavigation,
} from '@react-navigation/native';
import {
  createNativeStackNavigator,
  type NativeStackNavigationProp,
} from '@react-navigation/native-stack';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Keychain from 'react-native-keychain';

import { FakeLocalDb } from '../../xc-harness/lifecycle-persistence/fakeLocalDb';
import {
  CANONICAL_ID,
  OTHER_CANONICAL_ID,
} from '../../xc-harness/lifecycle-persistence/seeds';
import {
  artifactDir,
  heapSnapshot,
  matrixMarkdown,
  summarize,
  writeJsonArtifact,
  writeTextArtifact,
  type MatrixRow,
} from '../../xc-harness/lifecycle-persistence/artifacts';
import { nodeProcess } from '../../xc-harness/lifecycle-persistence/nodeShim';
import {
  describeScenario,
  scenarioFromSeed,
  type EventKind,
  type LifecycleEvent,
  type Phase,
  type Scenario,
} from '../../__harness__/stress/manageAccountLifecycle/scenario';
import {
  ScriptedServer,
  type ServerAccount,
} from '../../__harness__/stress/manageAccountLifecycle/server';

const mockDb = { current: new FakeLocalDb() };
jest.mock('../../src/data/db', () => ({
  getDb: () => mockDb.current.handle(),
}));

const mockGoogleSignin = {
  configure: jest.fn(),
  hasPlayServices: jest.fn(async () => true),
  signIn: jest.fn(async () => ({ type: 'cancelled' })),
  signInSilently: jest.fn(async () => ({ type: 'noSavedCredentialFound' })),
  signOut: jest.fn(async () => null),
  revokeAccess: jest.fn(async () => null),
};
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: mockGoogleSignin,
}));
jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: 'test-web-client.apps.googleusercontent.com',
  GOOGLE_IOS_CLIENT_ID: 'test-ios-client.apps.googleusercontent.com',
}));
jest.mock('../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.stress.test',
    revenueCatPublicSdkKey: null,
    googleIosClientId: 'test-ios-client.apps.googleusercontent.com',
    googleWebClientId: 'test-web-client.apps.googleusercontent.com',
    appVersion: '1.0',
    legalPrivacyUrl: null,
    legalTermsUrl: null,
  }),
}));
jest.mock('../../src/account/deviceContext', () => ({
  getAccountBootstrapEnvironment: () => ({
    locale: 'en-US',
    timezone: 'America/Los_Angeles',
    device: {
      platform: 'ios',
      osVersion: '18.5',
      appVersion: '1.0',
      model: 'iOS phone',
    },
  }),
}));
jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };
  return {
    SafeAreaView: View,
    SafeAreaProvider: View,
    SafeAreaInsetsContext: {
      Consumer: (props: { children: (value: unknown) => unknown }) =>
        props.children(insets),
    },
    useSafeAreaInsets: () => insets,
    useSafeAreaFrame: () => ({ x: 0, y: 0, width: 390, height: 844 }),
    initialWindowMetrics: null,
  };
});

import { ManageAccountScreen } from '../../src/screens/ManageAccountScreen';
import type { RootStackParams } from '../../src/navigation/params';
import { useAuthStore } from '../../src/auth/authStore';
import { clearApiSession, getApiSession } from '../../src/account/apiSession';
import {
  refreshSessionNow,
  stopSessionKeeper,
} from '../../src/account/sessionKeeper';
import { SESSION_VAULT_SERVICE } from '../../src/account/sessionVault';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import {
  canonicalDataOwner,
  getActiveDataOwner,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';
import { clearAccessStoreConfiguration } from '../../src/state/accessStore';
import { clearTrainingStoreConfiguration } from '../../src/training/store';
import { BrandNoticeHost } from '../../src/design/BrandNotice';
import { Button, PressableScale } from '../../src/design/components';

// apps/mobile types only `jest` (no @types/node); declare the exact Node
// surface this suite uses, like the other matrix harnesses do.
declare const process: {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
};

// ─── Configuration ───────────────────────────────────────────────────────────

const env = nodeProcess.env;
const DEFAULT_ITERATIONS = 8;
const SEED_BASE = 7000;
const ITERATIONS = Math.max(
  1,
  Number.parseInt(env['STRESS_ITER'] ?? String(DEFAULT_ITERATIONS), 10) ||
    DEFAULT_ITERATIONS,
);
const SEED_FILTER = env['STRESS_SEED']
  ? env['STRESS_SEED']
      .split(',')
      .map(value => Number.parseInt(value.trim(), 10))
      .filter(value => Number.isFinite(value))
  : null;
const SUITE = 'stress-manage-account-lifecycle';

const ACCOUNT_A: ServerAccount = {
  id: CANONICAL_ID,
  email: 'pat@example.com',
  displayName: 'Pat Player',
  identityToken: 'apple-identity-token-A',
};
const ACCOUNT_B: ServerAccount = {
  id: OTHER_CANONICAL_ID,
  email: 'sam@example.com',
  displayName: 'Sam Second',
  identityToken: 'apple-identity-token-B',
};
const OWNER_A = canonicalDataOwner(ACCOUNT_A.id);
const OWNER_B = canonicalDataOwner(ACCOUNT_B.id);
const ARM_DELAY_MS = 5_000;
const CLIENT_TIMEOUT_MS = 15_000;
const LAUNCH_DEADLINE_MS = 8_000;

// Root __mocks__/react-native-keychain.ts is applied automatically; this is
// the same in-memory store the production sessionVault requires.
const keychain = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

// ─── Timer provenance ────────────────────────────────────────────────────────
// jest.getTimerCount() says how many timers are alive, not whose. Wrapping the
// (fake) timer globals records where each live timer was armed so a leak
// points at a file:line instead of a number.

type TimerGlobals = {
  setTimeout: (...args: unknown[]) => unknown;
  clearTimeout: (handle: unknown) => void;
  setInterval: (...args: unknown[]) => unknown;
  clearInterval: (handle: unknown) => void;
};
const liveTimers = new Map<
  unknown,
  { kind: 'timeout' | 'interval'; origin: string }
>();
let timerGlobals: TimerGlobals | null = null;
let restoreTimerGlobals: (() => void) | null = null;

/**
 * Reports every timer still armed and disarms it, so a leak in one seed is
 * attributed to that seed alone instead of bleeding into every later one.
 */
function drainLeakedTimers(): string[] {
  const leaked = [...liveTimers.entries()];
  for (const [handle, { kind }] of leaked) {
    if (kind === 'interval') timerGlobals?.clearInterval(handle);
    else timerGlobals?.clearTimeout(handle);
  }
  liveTimers.clear();
  return leaked.map(([, { origin }]) => origin);
}

function timerOrigin(kind: string, ms: unknown): string {
  const frames = (new Error().stack ?? '')
    .split('\n')
    .slice(1)
    .map(line => line.trim())
    .filter(
      line =>
        !line.includes('manageAccountLifecycle.stress.test') &&
        !line.includes('node_modules/@jest') &&
        !line.includes('node_modules/jest-') &&
        !line.includes('@sinonjs'),
    )
    .slice(0, 3)
    .map(line => line.replace(/^at\s+/, '').replace(/.*\/apps\/mobile\//, ''));
  return `${kind}(${String(ms)}ms) @ ${frames.join(' < ')}`;
}

function trackTimers(): void {
  const g = globalThis as unknown as TimerGlobals;
  const original = {
    setTimeout: g.setTimeout,
    clearTimeout: g.clearTimeout,
    setInterval: g.setInterval,
    clearInterval: g.clearInterval,
  };
  g.setTimeout = (...args: unknown[]) => {
    const [callback, ms, ...rest] = args as [
      (...cbArgs: unknown[]) => void,
      unknown,
      ...unknown[],
    ];
    const origin = timerOrigin('setTimeout', ms);
    const handle: unknown = original.setTimeout(
      (...cbArgs: unknown[]) => {
        liveTimers.delete(handle);
        callback(...cbArgs);
      },
      ms,
      ...rest,
    );
    liveTimers.set(handle, { kind: 'timeout', origin });
    return handle;
  };
  g.clearTimeout = (handle: unknown) => {
    liveTimers.delete(handle);
    original.clearTimeout(handle);
  };
  g.setInterval = (...args: unknown[]) => {
    const [, ms] = args as [unknown, unknown];
    const handle = original.setInterval(...args);
    liveTimers.set(handle, {
      kind: 'interval',
      origin: timerOrigin('setInterval', ms),
    });
    return handle;
  };
  g.clearInterval = (handle: unknown) => {
    liveTimers.delete(handle);
    original.clearInterval(handle);
  };
  timerGlobals = original;
  restoreTimerGlobals = () => {
    g.setTimeout = original.setTimeout;
    g.clearTimeout = original.clearTimeout;
    g.setInterval = original.setInterval;
    g.clearInterval = original.clearInterval;
    restoreTimerGlobals = null;
  };
}

// ─── AppState plumbing ───────────────────────────────────────────────────────

const appStateListeners = new Set<(state: string) => void>();
function emitAppState(state: 'active' | 'background'): void {
  for (const listener of [...appStateListeners]) listener(state);
}

// ─── Real navigator around the real screen ───────────────────────────────────

const Stack = createNativeStackNavigator<RootStackParams>();
const navigationRef = createNavigationContainerRef<RootStackParams>();
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

/** Stands in for the Settings tab: the one hop into Manage account. */
function TabsStub() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParams>>();
  return (
    <Text
      accessibilityRole="button"
      accessibilityLabel="Open manage account"
      onPress={() => navigation.navigate('ManageAccount')}
    >
      TABS
    </Text>
  );
}

/** App.tsx's gate, reduced to the session rule this unit depends on. */
function Gate() {
  const hydrated = useAuthStore(s => s.hydrated);
  const session = useAuthStore(s => s.session);
  if (!hydrated) return <Text>LOADING</Text>;
  if (!session) return <Text>WELCOME</Text>;
  return (
    <NavigationContainer ref={navigationRef}>
      <Stack.Navigator
        screenOptions={{ headerShown: false, animation: 'fade_from_bottom' }}
      >
        <Stack.Screen name="Tabs" component={TabsStub} />
        <Stack.Screen
          name="ManageAccount"
          component={ManageAccountScreen}
          options={{ title: 'Manage Account' }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

interface BoundaryProps {
  onError: (message: string) => void;
  children: React.ReactNode;
}
class RenderBoundary extends React.Component<
  BoundaryProps,
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  componentDidCatch(error: Error): void {
    this.props.onError(`${error.name}: ${error.message}`);
  }
  render(): React.ReactNode {
    return this.state.failed ? <Text>RENDER_ERROR</Text> : this.props.children;
  }
}

function Root(props: { onError: (message: string) => void }) {
  return (
    <RenderBoundary onError={props.onError}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <Gate />
          <BrandNoticeHost />
        </QueryClientProvider>
      </SafeAreaProvider>
    </RenderBoundary>
  );
}

// ─── Rendered-tree helpers ───────────────────────────────────────────────────

type Renderer = TestRenderer.ReactTestRenderer;
type Instance = TestRenderer.ReactTestInstance;

function nodeText(node: Instance): string {
  return node
    .findAllByType(Text)
    .map(child => child.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function renderedText(renderer: Renderer | null): string {
  return renderer ? nodeText(renderer.root) : '';
}

function pressables(renderer: Renderer | null, label: string) {
  if (!renderer) return [];
  return renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
}

function buttons(renderer: Renderer | null, labelPrefix: string) {
  if (!renderer) return [];
  return renderer.root
    .findAllByType(Button)
    .filter(node => String(node.props.label).startsWith(labelPrefix));
}

function radio(renderer: Renderer | null, label: string): Instance | null {
  if (!renderer) return null;
  return (
    renderer.root
      .findAllByType(PressableScale)
      .find(
        node =>
          node.props.accessibilityRole === 'radio' &&
          nodeText(node).includes(label),
      ) ?? null
  );
}

type UiPhase =
  | 'loading'
  | 'signed-out'
  | 'tabs'
  | 'screen'
  | 'why'
  | 'kept'
  | 'review'
  | 'requesting'
  | 'armed'
  | 'deleting'
  | 'render-error';

function uiPhase(renderer: Renderer | null): UiPhase {
  const text = renderedText(renderer);
  if (text.includes('RENDER_ERROR')) return 'render-error';
  if (text.includes('LOADING')) return 'loading';
  if (text.includes('WELCOME')) return 'signed-out';
  if (buttons(renderer, 'Requesting…').length > 0) return 'requesting';
  if (buttons(renderer, 'Deleting…').length > 0) return 'deleting';
  if (buttons(renderer, 'Permanently delete').length > 0) return 'armed';
  if (buttons(renderer, 'Continue to delete').length > 0) return 'review';
  if (pressables(renderer, 'Skip this question').length > 0) return 'kept';
  if (pressables(renderer, 'Skip the survey').length > 0) return 'why';
  if (pressables(renderer, 'Delete account').length > 0) return 'screen';
  if (text.includes('Manage account')) return 'screen';
  return 'tabs';
}

const DIALOG_PHASES = new Set<UiPhase>([
  'why',
  'kept',
  'review',
  'requesting',
  'armed',
  'deleting',
]);

// ─── Per-run state ───────────────────────────────────────────────────────────

interface StaleCheck {
  after: string;
  reopenedAs: UiPhase;
}

interface RunState {
  scenario: Scenario;
  server: ScriptedServer;
  db: FakeLocalDb;
  renderer: Renderer | null;
  renderErrors: string[];
  consoleErrors: string[];
  unhandled: string[];
  timeline: string[];
  currentAccount: ServerAccount;
  /** Seq of the first server request after the account switch. */
  switchedAtSeq: number | null;
  scriptedRevokeAtSeq: number | null;
  explicitSignOut: boolean;
  kills: number;
  killAfterDeliveredDeletion: boolean;
  staleChecks: StaleCheck[];
  errorsExpected: number;
  errorsSeen: number;
  noticesSeen: Set<string>;
  hydrateRejections: string[];
  pendingHydrates: Promise<void>[];
  rehydrateChecks: { ok: boolean; detail: string }[];
  switchChecks: { ok: boolean; detail: string }[];
  listenersBeforeMount: number;
  cancelBlocked: number;
  appliedEvents: number;
  /** Events not yet applied; drained by runPhaseEvents / runLeftoverEvents. */
  pending: Set<LifecycleEvent>;
  mounts: number;
  actWarnings: number;
}

function log(state: RunState, message: string): void {
  state.timeline.push(`${Date.now() - runStartedAt}ms ${message}`);
}
let runStartedAt = 0;

// ─── Clock ───────────────────────────────────────────────────────────────────

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}
const flush = () => advance(0);

/** Advances in small steps until `done()` or `maxMs` of fake time passed. */
async function until(
  done: () => boolean,
  maxMs: number,
  stepMs = 250,
): Promise<boolean> {
  let elapsed = 0;
  await flush();
  while (!done() && elapsed < maxMs) {
    await advance(stepMs);
    elapsed += stepMs;
  }
  return done();
}

// ─── Process model ───────────────────────────────────────────────────────────

function mount(state: RunState, why: string): void {
  act(() => {
    state.renderer = TestRenderer.create(
      <Root onError={message => state.renderErrors.push(message)} />,
    );
  });
  state.mounts += 1;
  log(state, `mount(${why})`);
}

function unmount(state: RunState, why: string): void {
  const renderer = state.renderer;
  state.renderer = null;
  if (renderer) {
    act(() => {
      renderer.unmount();
    });
  }
  log(state, `unmount(${why})`);
}

/** The OS killed the process: singletons gone, Keychain + SQLite survive. */
function resetProcessState(): void {
  clearSyncRuntime();
  stopSessionKeeper();
  clearApiSession();
  clearAccessStoreConfiguration();
  clearTrainingStoreConfiguration();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    session: null,
    hydrated: false,
    busy: false,
    error: null,
    localDataError: null,
    deletionCleanup: null,
  });
}

function startHydrate(state: RunState, why: string): void {
  const promise = useAuthStore
    .getState()
    .hydrate()
    .catch((error: unknown) => {
      state.hydrateRejections.push(
        `${why}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  state.pendingHydrates.push(promise);
}

async function launch(state: RunState, why: string): Promise<void> {
  mount(state, why);
  startHydrate(state, why);
  await until(
    () => useAuthStore.getState().hydrated,
    LAUNCH_DEADLINE_MS + 2_000,
  );
}

async function killAndRelaunch(state: RunState): Promise<void> {
  const deliveredDeletion = state.server.log.some(
    record =>
      record.path === '/v1/me/delete-confirm' &&
      record.outcome === 200 &&
      record.sideEffect?.startsWith('delete:'),
  );
  if (deliveredDeletion) state.killAfterDeliveredDeletion = true;
  unmount(state, 'kill');
  resetProcessState();
  state.server.proc += 1;
  state.kills += 1;
  const vaultBefore = vaultRecord();
  const vaultLive =
    vaultBefore !== null &&
    state.server.isRefreshTokenLive(vaultBefore.refreshToken);
  await launch(state, 'relaunch');
  const session = useAuthStore.getState().session;
  // A live vault record must come back as that user; a dead one (server
  // revoked or deleted the account) must land signed out — never half way.
  const ok =
    vaultBefore === null
      ? session === null
      : vaultLive
        ? session?.canonicalAppUserId === vaultBefore.canonicalAppUserId
        : session === null;
  state.rehydrateChecks.push({
    ok,
    detail: `relaunch: vault=${vaultBefore?.canonicalAppUserId ?? 'none'}${vaultBefore ? (vaultLive ? '(live)' : '(dead)') : ''} session=${session?.canonicalAppUserId ?? 'none'}`,
  });
}

interface VaultRecord {
  canonicalAppUserId: string;
  refreshToken: string;
  provider: string;
}

function vaultRecord(): VaultRecord | null {
  const item = keychain.__keychainStore.get(SESSION_VAULT_SERVICE);
  if (!item) return null;
  try {
    const parsed = JSON.parse(item.password) as Partial<VaultRecord>;
    if (
      typeof parsed.canonicalAppUserId === 'string' &&
      typeof parsed.refreshToken === 'string' &&
      typeof parsed.provider === 'string'
    ) {
      return {
        canonicalAppUserId: parsed.canonicalAppUserId,
        refreshToken: parsed.refreshToken,
        provider: parsed.provider,
      };
    }
  } catch {
    // Malformed vault content is reported as "no record".
  }
  return null;
}

// ─── Driving the screen ──────────────────────────────────────────────────────

function press(node: { props: { onPress?: () => void } }): void {
  act(() => {
    node.props.onPress?.();
  });
}

/** Presses a design-system Button by label unless it is disabled. */
function pressButton(state: RunState, labelPrefix: string): boolean {
  const node = buttons(state.renderer, labelPrefix)[0];
  if (!node) return false;
  if (node.props.disabled) return false;
  press(node);
  log(state, `press "${labelPrefix}"`);
  return true;
}

/** The dialog fell back to `phase` after a failed call: it must say why. */
function expectErrorText(state: RunState, phase: UiPhase): void {
  state.errorsExpected += 1;
  const seen = sawErrorText(state);
  if (seen) state.errorsSeen += 1;
  log(
    state,
    `  expect error text at ${phase}: ${seen ? 'shown' : `MISSING (text=${renderedText(state.renderer).slice(0, 160)})`}`,
  );
}

function pressLabel(state: RunState, label: string): boolean {
  const node = pressables(state.renderer, label)[0];
  if (!node) return false;
  if (node.props.disabled) return false;
  press(node);
  return true;
}

/** From wherever the navigator is, reach the review page of the dialog. */
async function openDialogToReview(state: RunState): Promise<boolean> {
  await flush();
  let phase = uiPhase(state.renderer);
  if (
    phase === 'signed-out' ||
    phase === 'loading' ||
    phase === 'render-error'
  ) {
    return false;
  }
  if (phase === 'tabs') {
    if (!pressLabel(state, 'Open manage account')) return false;
    await flush();
    phase = uiPhase(state.renderer);
  }
  if (phase === 'screen') {
    if (!pressLabel(state, 'Delete account')) return false;
    await flush();
    phase = uiPhase(state.renderer);
  }
  if (phase === 'why') {
    switch (state.scenario.survey) {
      case 'skip-all':
        pressLabel(state, 'Skip the survey');
        break;
      case 'q1-only': {
        const option = radio(state.renderer, 'Something else');
        if (option) press(option);
        await flush();
        pressButton(state, 'Next');
        await flush();
        pressLabel(state, 'Skip this question');
        break;
      }
      case 'q1-q2': {
        const option = radio(state.renderer, 'Privacy or data concerns');
        if (option) press(option);
        await flush();
        pressButton(state, 'Next');
        await flush();
        const kept = radio(state.renderer, 'A lower price or a free tier');
        if (kept) press(kept);
        await flush();
        pressButton(state, 'Continue');
        break;
      }
      case 'q1-comment': {
        const option = radio(state.renderer, 'Something else');
        if (option) press(option);
        await flush();
        pressButton(state, 'Next');
        await flush();
        const input = state.renderer?.root.findAllByType(TextInput)[0];
        if (input) {
          act(() => {
            input.props.onChangeText('Moving abroad for a while');
          });
        }
        await flush();
        pressButton(state, 'Continue');
        break;
      }
    }
    await flush();
    phase = uiPhase(state.renderer);
  }
  return phase === 'review';
}

async function signInAs(
  state: RunState,
  account: ServerAccount,
): Promise<void> {
  const native = NativeModules as {
    PickleAuth?: { signInWithApple: jest.Mock };
  };
  native.PickleAuth?.signInWithApple.mockResolvedValueOnce({
    user: `apple-user-${account.id.slice(0, 8)}`,
    identityToken: account.identityToken,
    authorizationCode: `code-${account.id.slice(0, 8)}`,
    email: account.email,
    givenName: account.displayName.split(' ')[0],
    familyName: account.displayName.split(' ')[1],
  });
  act(() => {
    const promise = useAuthStore
      .getState()
      .signInWithApple()
      .catch((error: unknown) => {
        state.hydrateRejections.push(
          `signIn(${account.id}): ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    state.pendingHydrates.push(promise);
  });
  await until(
    () => useAuthStore.getState().session?.canonicalAppUserId === account.id,
    state.scenario.refreshLatencyMs + 2_000,
  );
}

async function applyEvent(
  state: RunState,
  event: LifecycleEvent,
): Promise<void> {
  const before = uiPhase(state.renderer);
  log(
    state,
    `event ${event.kind} (scheduled ${event.phase}@${event.atMs}, ui=${before})`,
  );
  state.appliedEvents += 1;
  switch (event.kind) {
    case 'bg-fg':
      act(() => emitAppState('background'));
      await flush();
      act(() => emitAppState('active'));
      await flush();
      break;
    case 'cancel': {
      const closed =
        pressButton(state, 'Keep my account') ||
        pressLabel(state, 'Close and keep my account') ||
        pressLabel(state, 'Close account deletion confirmation');
      if (!closed && DIALOG_PHASES.has(before)) state.cancelBlocked += 1;
      await flush();
      break;
    }
    case 'back':
      if (navigationRef.isReady() && navigationRef.canGoBack()) {
        act(() => navigationRef.goBack());
      }
      await flush();
      break;
    case 'remount-tree':
      unmount(state, 'remount');
      mount(state, 'remount');
      await flush();
      break;
    case 'rotate':
      act(() => refreshSessionNow());
      await flush();
      break;
    case 'revoke':
      state.server.revokeAccount(state.currentAccount.id);
      state.scriptedRevokeAtSeq = state.server.log.length;
      // The app learns about it on its next refresh; a foreground is the
      // cheapest realistic trigger.
      act(() => emitAppState('background'));
      await flush();
      act(() => emitAppState('active'));
      await flush();
      break;
    case 'kill-relaunch':
      await killAndRelaunch(state);
      break;
    case 'account-switch': {
      if (useAuthStore.getState().session) {
        state.explicitSignOut = true;
        act(() => {
          const signOut = useAuthStore
            .getState()
            .signOut()
            .catch((error: unknown) => {
              state.hydrateRejections.push(
                `signOut: ${error instanceof Error ? error.message : String(error)}`,
              );
            });
          state.pendingHydrates.push(signOut);
        });
        await until(
          () => useAuthStore.getState().session === null,
          state.scenario.refreshLatencyMs + 2_000,
        );
      }
      state.switchedAtSeq = state.server.log.length;
      state.currentAccount = ACCOUNT_B;
      await signInAs(state, ACCOUNT_B);
      await flush();
      const apiSession = getApiSession();
      const session = useAuthStore.getState().session;
      const opened = await openDialogToReview(state);
      const text = renderedText(state.renderer);
      const vault = vaultRecord();
      const checks: [boolean, string][] = [
        [session?.canonicalAppUserId === ACCOUNT_B.id, 'store session is B'],
        [apiSession?.canonicalAppUserId === ACCOUNT_B.id, 'api session is B'],
        [getActiveDataOwner() === OWNER_B, 'active data owner is B'],
        [vault?.canonicalAppUserId === ACCOUNT_B.id, 'vault holds B'],
        [
          vault === null || state.server.isRefreshTokenLive(vault.refreshToken),
          'vault token live on server',
        ],
        [opened, 'B can reach the deletion review page'],
        [text.includes(ACCOUNT_B.displayName), 'screen shows B name'],
        [text.includes(ACCOUNT_B.email), 'screen shows B email'],
        [!text.includes(ACCOUNT_A.displayName), 'screen hides A name'],
        [!text.includes(ACCOUNT_A.email), 'screen hides A email'],
        [
          !text.includes('Permanently delete') && !text.includes('Deleting…'),
          'no armed/deleting state carried over',
        ],
      ];
      for (const [ok, detail] of checks) {
        state.switchChecks.push({ ok, detail });
      }
      if (opened) {
        pressButton(state, 'Keep my account');
        await flush();
      }
      break;
    }
    case 'double-hydrate': {
      const sessionBefore = useAuthStore.getState().session;
      const ownerBefore = getActiveDataOwner();
      const refreshBefore = state.server.requests('/v1/auth/refresh').length;
      startHydrate(state, 'double-hydrate');
      // `hydrated` is already true from the first hydrate, so wait for this
      // one's own promise and for its refresh round-trip to land.
      let settled = false;
      void state.pendingHydrates[state.pendingHydrates.length - 1]?.then(() => {
        settled = true;
      });
      await until(() => settled, LAUNCH_DEADLINE_MS + 2_000);
      await advance(state.scenario.refreshLatencyMs + 1_000);
      const sessionAfter = useAuthStore.getState().session;
      const ownerAfter = getActiveDataOwner();
      const refreshAfter = state.server.requests('/v1/auth/refresh').length;
      const vault = vaultRecord();
      // A second hydrate must land where the first did — unless the server
      // has since refused this account (scripted revoke / delivered
      // deletion), in which case the only correct landing is signed out.
      const serverRefusesA =
        state.scriptedRevokeAtSeq !== null ||
        state.server.deleted.has(ACCOUNT_A.id);
      const consistent =
        (sessionAfter?.canonicalAppUserId ?? null) ===
        (vault?.canonicalAppUserId ?? null);
      const ok =
        consistent &&
        (sessionBefore === null
          ? true
          : serverRefusesA && sessionBefore.canonicalAppUserId === ACCOUNT_A.id
            ? sessionAfter === null ||
              sessionAfter.canonicalAppUserId ===
                sessionBefore.canonicalAppUserId
            : sessionAfter?.canonicalAppUserId ===
                sessionBefore.canonicalAppUserId &&
              ownerAfter === ownerBefore) &&
        refreshAfter - refreshBefore <= 1;
      state.rehydrateChecks.push({
        ok,
        detail: `double-hydrate: before=${sessionBefore?.canonicalAppUserId ?? 'none'} after=${sessionAfter?.canonicalAppUserId ?? 'none'} vault=${vault?.canonicalAppUserId ?? 'none'} owner ${ownerBefore}→${ownerAfter} refreshes+${refreshAfter - refreshBefore}`,
      });
      break;
    }
    case 'wait':
      await advance(10_000);
      break;
  }
  log(
    state,
    `  → ui=${uiPhase(state.renderer)} session=${useAuthStore.getState().session?.canonicalAppUserId?.slice(0, 8) ?? 'none'}`,
  );
}

const DESTRUCTIVE: ReadonlySet<EventKind> = new Set<EventKind>([
  'cancel',
  'back',
  'remount-tree',
  'revoke',
  'kill-relaunch',
  'account-switch',
]);

/**
 * Runs the events scheduled for `phase`, advancing the clock to each offset
 * while the dialog is still in that phase. `stillIn` tells the runner whether
 * the phase is live; once it is not, remaining events land immediately in
 * whatever state the UI is in (they are still valid interleavings, just
 * later ones — the timeline records where they actually landed).
 */
async function runPhaseEvents(
  state: RunState,
  phase: Phase,
  stillIn: () => boolean,
): Promise<{ destructive: boolean }> {
  const events = state.scenario.events.filter(
    e => e.phase === phase && state.pending.has(e),
  );
  let cursor = 0;
  let destructive = false;
  for (const event of events) {
    state.pending.delete(event);
    if (stillIn()) {
      const wait = Math.max(0, event.atMs - cursor);
      let stepped = 0;
      while (stepped < wait && stillIn()) {
        const step = Math.min(250, wait - stepped);
        await advance(step);
        stepped += step;
      }
      cursor = event.atMs;
    }
    await applyEvent(state, event);
    if (DESTRUCTIVE.has(event.kind)) destructive = true;
  }
  return { destructive };
}

/**
 * Events scheduled for a phase the flow never reached (a permanent request
 * fault leaves the dialog on review, a revocation signs the user out…) still
 * run, in schedule order, at their offsets from the end of the flow. They
 * are still interruptions of the live tree — just later ones.
 */
async function runLeftoverEvents(state: RunState): Promise<void> {
  const leftovers = state.scenario.events.filter(e => state.pending.has(e));
  let cursor = 0;
  for (const event of leftovers) {
    state.pending.delete(event);
    const wait = Math.max(0, event.atMs - cursor);
    if (wait > 0) await advance(Math.min(wait, 5_000));
    cursor = event.atMs;
    await applyEvent(state, event);
  }
}

const ERROR_MARKERS = [
  'Nothing was deleted',
  'Your sign-in has expired',
  'invalid deletion',
  'temporarily offline',
  'slow down',
  'internal error',
  'unknown deletion challenge',
  'did not confirm the deletion',
];

function sawErrorText(state: RunState): boolean {
  const text = renderedText(state.renderer);
  return ERROR_MARKERS.some(marker => text.includes(marker));
}

function noteNotices(state: RunState): void {
  const text = renderedText(state.renderer);
  for (const marker of ['LOCAL CLEANUP NEEDED', 'ONE APPLE STEP']) {
    if (text.includes(marker)) state.noticesSeen.add(marker);
  }
}

/** After a destructive event, the late response must not reopen the dialog
 * in an advanced phase: reopening shows the survey from the top. */
async function checkStaleCompletion(
  state: RunState,
  after: string,
): Promise<void> {
  await advance(CLIENT_TIMEOUT_MS + 1_000);
  const phase = uiPhase(state.renderer);
  if (phase === 'signed-out' || phase === 'loading') return;
  if (DIALOG_PHASES.has(phase)) {
    state.staleChecks.push({ after, reopenedAs: phase });
    return;
  }
  if (phase === 'tabs') {
    pressLabel(state, 'Open manage account');
    await flush();
  }
  pressLabel(state, 'Delete account');
  await flush();
  state.staleChecks.push({ after, reopenedAs: uiPhase(state.renderer) });
  pressLabel(state, 'Close and keep my account');
  await flush();
}

// ─── One iteration ───────────────────────────────────────────────────────────

async function runScenario(scenario: Scenario): Promise<MatrixRow> {
  const startedWall = jest.getRealSystemTime();
  jest.setSystemTime(new Date('2026-09-05T09:00:00Z'));
  runStartedAt = Date.now();
  const server = new ScriptedServer({
    bearerTtlSec: scenario.bearerTtlSec,
    refreshLatencyMs: scenario.refreshLatencyMs,
    request: scenario.request,
    confirm: scenario.confirm,
    appleRevocation: scenario.appleRevocation,
  });
  server.addAccount(ACCOUNT_A);
  server.addAccount(ACCOUNT_B);
  (globalThis as { fetch: unknown }).fetch = server.fetch;

  const db = new FakeLocalDb();
  db.seedShots(OWNER_A, 6);
  db.seedShots(OWNER_B, 2, 'other');
  if (scenario.purgeFails) db.faults = { sqlThrows: /^DELETE FROM local_shot/ };
  mockDb.current = db;

  // Previous run of the app: A signed in, refresh token in the Keychain.
  keychain.__keychainStore.clear();
  const initial = server.issueSession(ACCOUNT_A.id);
  keychain.__keychainStore.set(SESSION_VAULT_SERVICE, {
    username: 'session',
    password: JSON.stringify({
      version: 1,
      provider: scenario.provider,
      canonicalAppUserId: ACCOUNT_A.id,
      refreshToken: initial.refreshToken,
      email: ACCOUNT_A.email,
      displayName: ACCOUNT_A.displayName,
    }),
  });
  resetProcessState();
  appStateListeners.clear();

  const state: RunState = {
    scenario,
    server,
    db,
    renderer: null,
    renderErrors: [],
    consoleErrors: [],
    unhandled: [],
    timeline: [],
    currentAccount: ACCOUNT_A,
    switchedAtSeq: null,
    scriptedRevokeAtSeq: null,
    explicitSignOut: false,
    kills: 0,
    killAfterDeliveredDeletion: false,
    staleChecks: [],
    errorsExpected: 0,
    errorsSeen: 0,
    noticesSeen: new Set(),
    hydrateRejections: [],
    pendingHydrates: [],
    rehydrateChecks: [],
    switchChecks: [],
    listenersBeforeMount: appStateListeners.size,
    cancelBlocked: 0,
    appliedEvents: 0,
    pending: new Set(scenario.events),
    mounts: 0,
    actWarnings: 0,
  };
  const consoleError = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      const message = args.map(String).join(' ').slice(0, 300);
      // React's act() warning is about the test's own scheduling gaps
      // (store continuations settling between two act blocks), not about
      // the product; it is counted separately so it can't hide a real error.
      if (message.includes('not wrapped in act(...)')) {
        state.actWarnings += 1;
        return;
      }
      state.consoleErrors.push(message);
    });
  const onUnhandled = (reason: unknown) => {
    state.unhandled.push(
      reason instanceof Error
        ? `${reason.name}: ${reason.message}`
        : String(reason),
    );
  };
  process.on('unhandledRejection', onUnhandled);

  let sessionAtLaunch: string | null = null;
  let requestPressed = 0;
  let confirmPressed = 0;
  let reconcileForced = false;
  try {
    await launch(state, 'cold');
    sessionAtLaunch =
      useAuthStore.getState().session?.canonicalAppUserId ?? null;

    // ── review
    let atReview = await openDialogToReview(state);
    const review = await runPhaseEvents(
      state,
      'review',
      () => uiPhase(state.renderer) === 'review',
    );
    if (review.destructive || !atReview)
      atReview = await openDialogToReview(state);

    // ── requesting
    let phase = uiPhase(state.renderer);
    let armed = false;
    if (atReview && phase === 'review') {
      pressButton(state, 'Continue to delete');
      requestPressed += 1;
      await flush();
      const requesting = await runPhaseEvents(
        state,
        'requesting',
        () => uiPhase(state.renderer) === 'requesting',
      );
      await until(
        () => uiPhase(state.renderer) !== 'requesting',
        CLIENT_TIMEOUT_MS + 2_000,
      );
      phase = uiPhase(state.renderer);
      if (requesting.destructive && !DIALOG_PHASES.has(phase)) {
        await checkStaleCompletion(state, 'requesting');
        if (await openDialogToReview(state)) {
          pressButton(state, 'Continue to delete');
          requestPressed += 1;
          await until(
            () => uiPhase(state.renderer) !== 'requesting',
            CLIENT_TIMEOUT_MS + 2_000,
          );
          phase = uiPhase(state.renderer);
        }
      }
      if (phase === 'review') {
        expectErrorText(state, phase);
        if (scenario.request.recover) {
          pressButton(state, 'Continue to delete');
          requestPressed += 1;
          await until(
            () => uiPhase(state.renderer) !== 'requesting',
            CLIENT_TIMEOUT_MS + 2_000,
          );
          phase = uiPhase(state.renderer);
        }
      }
      armed = phase === 'armed';
    }

    // ── armed
    if (armed) {
      const armedEvents = await runPhaseEvents(
        state,
        'armed',
        () => uiPhase(state.renderer) === 'armed',
      );
      phase = uiPhase(state.renderer);
      if (armedEvents.destructive && !DIALOG_PHASES.has(phase)) {
        await checkStaleCompletion(state, 'armed');
        if (await openDialogToReview(state)) {
          pressButton(state, 'Continue to delete');
          requestPressed += 1;
          await until(
            () => uiPhase(state.renderer) !== 'requesting',
            CLIENT_TIMEOUT_MS + 2_000,
          );
          phase = uiPhase(state.renderer);
        }
      }
      if (phase === 'armed') {
        await until(() => {
          const button = buttons(state.renderer, 'Permanently delete')[0];
          return !button || !button.props.disabled;
        }, ARM_DELAY_MS + 2_000);
        if (scenario.armedDwellMs > 0) await advance(scenario.armedDwellMs);
      }
    }

    // ── deleting
    if (
      uiPhase(state.renderer) === 'armed' &&
      pressButton(state, 'Permanently delete')
    ) {
      confirmPressed += 1;
      await flush();
      const deleting = await runPhaseEvents(
        state,
        'deleting',
        () => uiPhase(state.renderer) === 'deleting',
      );
      await until(
        () => uiPhase(state.renderer) !== 'deleting',
        CLIENT_TIMEOUT_MS + 2_000,
      );
      phase = uiPhase(state.renderer);
      noteNotices(state);
      if (
        deleting.destructive &&
        !DIALOG_PHASES.has(phase) &&
        phase !== 'signed-out'
      ) {
        await checkStaleCompletion(state, 'deleting');
      }
      if (phase === 'armed' || phase === 'review') {
        expectErrorText(state, phase);
        if (scenario.confirm.recover) {
          if (phase === 'armed') {
            if (pressButton(state, 'Permanently delete')) confirmPressed += 1;
          } else {
            pressButton(state, 'Continue to delete');
            requestPressed += 1;
            await until(
              () => uiPhase(state.renderer) !== 'requesting',
              CLIENT_TIMEOUT_MS + 2_000,
            );
            await until(() => {
              const button = buttons(state.renderer, 'Permanently delete')[0];
              return !button || !button.props.disabled;
            }, ARM_DELAY_MS + 2_000);
            if (pressButton(state, 'Permanently delete')) confirmPressed += 1;
          }
          await until(
            () => uiPhase(state.renderer) !== 'deleting',
            CLIENT_TIMEOUT_MS + 2_000,
          );
          noteNotices(state);
        }
      }
    }
    await flush();
    noteNotices(state);

    // ── after
    await runPhaseEvents(state, 'after', () => true);
    await runLeftoverEvents(state);
    await advance(2_000);
    noteNotices(state);

    // ── reconcile: a server-side revocation or a deletion the client never
    // heard about (killed while the confirm was in flight, relaunched before
    // the server processed it) is only learnable through the next refresh —
    // force one and settle, then judge the end state.
    if (
      (server.deleted.has(ACCOUNT_A.id) ||
        state.scriptedRevokeAtSeq !== null) &&
      useAuthStore.getState().session?.canonicalAppUserId === ACCOUNT_A.id
    ) {
      reconcileForced = true;
      act(() => refreshSessionNow());
      await advance(scenario.refreshLatencyMs + 1_000);
    }
  } catch (error) {
    state.renderErrors.push(
      `driver: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    );
  }

  // ── final observation
  const finalText = renderedText(state.renderer);
  const finalUi = uiPhase(state.renderer);
  const finalSession = useAuthStore.getState().session;
  const finalApi = getApiSession();
  const finalVault = vaultRecord();
  // Judged now, not after teardown: the keeper may legitimately rotate once
  // more while the teardown clock runs, superseding the token read here.
  const finalVaultLive =
    finalVault === null || server.isRefreshTokenLive(finalVault.refreshToken);
  const finalOwner = getActiveDataOwner();
  const deletionCleanup = useAuthStore.getState().deletionCleanup;

  // ── teardown: the tree goes away, in-flight requests time out, then the
  // process-level singletons are stopped. Anything still ticking is a leak.
  const listenersBeforeUnmount = appStateListeners.size;
  unmount(state, 'end');
  const listenersAfterUnmount = appStateListeners.size;
  await advance(CLIENT_TIMEOUT_MS + LAUNCH_DEADLINE_MS + 1_000);
  await Promise.all(state.pendingHydrates);
  const listenersBeforeStop = appStateListeners.size;
  const timersBeforeStop = jest.getTimerCount();
  clearSyncRuntime();
  stopSessionKeeper();
  clearApiSession();
  clearAccessStoreConfiguration();
  clearTrainingStoreConfiguration();
  await flush();
  const timersAfterStop = jest.getTimerCount();
  const leakedTimers = drainLeakedTimers();
  const listenersAfterStop = appStateListeners.size;
  process.off('unhandledRejection', onUnhandled);
  consoleError.mockRestore();

  // ── invariants
  const deletionRecords = server.log.filter(
    r =>
      r.path === '/v1/me/delete-request' || r.path === '/v1/me/delete-confirm',
  );
  const confirms = server.requests('/v1/me/delete-confirm');
  const delivered = confirms.find(
    r => r.outcome === 200 && r.sideEffect?.startsWith('delete:'),
  );
  const serverDeletedA = server.deleted.has(ACCOUNT_A.id);
  const deliveredDeletion = Boolean(delivered);
  // "After" means issued once the deletion had been served — a call that
  // was already on the wire when the server deleted the account is not the
  // client acting on a dead account.
  const afterDelivered = delivered
    ? server.log.filter(r => r.at > (delivered.servedAt ?? delivered.at))
    : [];
  const revokeScripted = state.scriptedRevokeAtSeq !== null;
  const switchedAtSeq = state.switchedAtSeq;
  const aTokensAfterSwitch =
    switchedAtSeq === null
      ? []
      : server.log.filter(
          r =>
            r.seq > switchedAtSeq &&
            r.bearerAccount === ACCOUNT_A.id &&
            r.path !== '/v1/auth/logout',
        );
  const expiredBearers = deletionRecords.filter(
    r => r.bearerState === 'expired',
  );
  const unknownBearers = deletionRecords.filter(
    r => r.bearerState === 'unknown' || r.bearerState === 'none',
  );
  const refreshReuse = server
    .requests('/v1/auth/refresh')
    .filter(
      r =>
        r.outcome === 401 &&
        r.bearerState === 'revoked' &&
        !revokeScripted &&
        !state.explicitSignOut,
    );
  // FakeLocalDb records every statement but does not apply DELETEs to its
  // seeded rows, so the purge is judged on the SQL the store issued: which
  // owner it targeted and whether the statement was accepted or faulted.
  const ownerDeletes = db.statements.filter(s =>
    /^DELETE FROM \w+ WHERE owner_key = \?/.test(s.sql),
  );
  const purgeStatements = ownerDeletes.filter(s => s.params[0] === OWNER_A);
  const purgeTargetsOtherOwner = ownerDeletes.some(
    s => s.params[0] !== OWNER_A,
  );
  const purgeSucceeded = !scenario.purgeFails && purgeStatements.length > 0;
  const purgeAttempts = purgeStatements.filter(s =>
    /^DELETE FROM local_shot /.test(s.sql),
  ).length;

  const invariants: Record<string, boolean> = {
    noRenderError: state.renderErrors.length === 0,
    noConsoleError: state.consoleErrors.length === 0,
    noUnhandledRejection:
      state.unhandled.length === 0 && state.hydrateRejections.length === 0,
    launchedSignedInAsA: sessionAtLaunch === ACCOUNT_A.id,
    armDelayHonoured: confirms.every(
      r =>
        r.challengeAgeMs === null ||
        r.challengeAgeMs === undefined ||
        r.challengeAgeMs >= ARM_DELAY_MS,
    ),
    confirmChallengeOwnAccount: confirms.every(
      r => r.challengeAccount == null || r.challengeAccount === r.bearerAccount,
    ),
    noExpiredBearer: expiredBearers.length === 0,
    noBearerlessDeletionCall: unknownBearers.length === 0,
    noPreviousUserToken: aTokensAfterSwitch.length === 0,
    noTrafficAfterDeliveredDeletion: afterDelivered.every(
      r =>
        r.bearerAccount !== ACCOUNT_A.id || r.path === '/v1/account/bootstrap',
    ),
    deliveredDeletionSignsOut:
      !deliveredDeletion ||
      finalSession === null ||
      finalSession.canonicalAppUserId !== ACCOUNT_A.id,
    deletedAccountNeverRestored:
      !serverDeletedA || finalSession?.canonicalAppUserId !== ACCOUNT_A.id,
    deletedVaultCleared:
      !deliveredDeletion ||
      finalVault === null ||
      finalVault.canonicalAppUserId !== ACCOUNT_A.id,
    deletedOwnerReleased: !deliveredDeletion || finalOwner !== OWNER_A,
    localPurgeAttempted:
      !deliveredDeletion ||
      state.killAfterDeliveredDeletion ||
      purgeStatements.length > 0,
    localPurgeOutcome:
      !deliveredDeletion ||
      state.killAfterDeliveredDeletion ||
      (scenario.purgeFails
        ? !purgeSucceeded && deletionCleanup?.localPurge === 'failed'
        : purgeSucceeded && deletionCleanup?.localPurge === 'complete'),
    purgeNoticeShown:
      !deliveredDeletion ||
      state.killAfterDeliveredDeletion ||
      !scenario.purgeFails ||
      state.noticesSeen.has('LOCAL CLEANUP NEEDED'),
    appleStepNoticeShown:
      !deliveredDeletion ||
      state.killAfterDeliveredDeletion ||
      scenario.purgeFails ||
      scenario.appleRevocation !== 'manual_action_required' ||
      state.noticesSeen.has('ONE APPLE STEP'),
    otherOwnerRowsUntouched: !purgeTargetsOtherOwner,
    noImplicitSignOut:
      finalSession !== null ||
      serverDeletedA ||
      revokeScripted ||
      state.explicitSignOut,
    noRefreshReuse: refreshReuse.length === 0,
    staleCompletionIgnored: state.staleChecks.every(
      c => c.reopenedAs === 'why',
    ),
    errorSurfaced: state.errorsSeen === state.errorsExpected,
    vaultMatchesSession:
      (finalSession === null && finalVault === null) ||
      (finalSession !== null &&
        finalVault !== null &&
        finalVault.canonicalAppUserId === finalSession.canonicalAppUserId),
    vaultTokenLive: finalVaultLive,
    apiSessionMatchesStore:
      (finalSession === null && finalApi === null) ||
      (finalSession !== null &&
        finalApi?.canonicalAppUserId === finalSession.canonicalAppUserId),
    gateMatchesSession:
      finalUi === 'render-error'
        ? false
        : finalSession === null
          ? finalUi === 'signed-out'
          : finalUi !== 'signed-out' && finalUi !== 'loading',
    rehydrateIdempotent: state.rehydrateChecks.every(c => c.ok),
    noPreviousUserState: state.switchChecks.every(c => c.ok),
    // The tree owns no AppState subscriptions (the keeper and sync runtime
    // are process singletons), so unmounting it must not change the count.
    treeOwnsNoListeners: listenersBeforeUnmount === listenersAfterUnmount,
    noLeakedTimers: timersAfterStop === 0,
    noLeakedListeners: listenersAfterStop === 0,
  };
  const failed = Object.entries(invariants)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);

  return {
    suite: SUITE,
    scenario: describeScenario(scenario),
    seed: scenario.seed,
    inputs: {
      provider: scenario.provider,
      survey: scenario.survey,
      bearerTtlSec: scenario.bearerTtlSec,
      request: scenario.request,
      confirm: scenario.confirm,
      appleRevocation: scenario.appleRevocation,
      purgeFails: scenario.purgeFails,
      armedDwellMs: scenario.armedDwellMs,
      events: scenario.events,
    },
    observed: {
      finalUi,
      finalSession: finalSession?.canonicalAppUserId ?? null,
      finalVault: finalVault?.canonicalAppUserId ?? null,
      finalVaultRefreshToken: finalVault?.refreshToken ?? null,
      finalOwner,
      serverDeletedA,
      deliveredDeletion,
      deletionCleanup: deletionCleanup?.localPurge ?? null,
      purgeAttempts,
      purgeSucceeded,
      destructiveSql: db.destructiveStatements(),
      requestPressed,
      confirmPressed,
      reconcileForced,
      appliedEvents: state.appliedEvents,
      cancelBlocked: state.cancelBlocked,
      kills: state.kills,
      mounts: state.mounts,
      requests: server.log.map(r => ({
        seq: r.seq,
        at: r.at - runStartedAt,
        proc: r.proc,
        path: r.path,
        bearerState: r.bearerState,
        bearerAccount: r.bearerAccount?.slice(0, 8) ?? null,
        outcome: r.outcome,
        sideEffect: r.sideEffect,
        challengeAgeMs: r.challengeAgeMs ?? null,
      })),
      staleChecks: state.staleChecks,
      rehydrateChecks: state.rehydrateChecks,
      switchChecks: state.switchChecks.filter(c => !c.ok),
      errorsExpected: state.errorsExpected,
      errorsSeen: state.errorsSeen,
      notices: [...state.noticesSeen],
      timersBeforeStop,
      timersAfterStop,
      leakedTimers,
      listenersBeforeMount: state.listenersBeforeMount,
      listenersBeforeUnmount,
      listenersAfterUnmount,
      listenersBeforeStop,
      listenersAfterStop,
      renderErrors: state.renderErrors,
      consoleErrors: state.consoleErrors,
      actWarnings: state.actWarnings,
      unhandled: state.unhandled,
      hydrateRejections: state.hydrateRejections,
      finalText: finalText.slice(0, 400),
      timeline: state.timeline,
    },
    invariants,
    ok: failed.length === 0,
    failed,
    durationMs: Math.round(jest.getRealSystemTime() - startedWall),
  };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;

beforeAll(() => {
  jest.useFakeTimers({ doNotFake: ['performance'] });
  trackTimers();
  jest.spyOn(Math, 'random').mockReturnValue(0.5);
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _type: string,
    handler: (state: string) => void,
  ) => {
    appStateListeners.add(handler);
    return { remove: () => appStateListeners.delete(handler) };
  }) as unknown as typeof AppState.addEventListener);
  nativeModules.PickleAuth = { signInWithApple: jest.fn() };
});

afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
  delete nativeModules.PickleAuth;
  restoreTimerGlobals?.();
  jest.useRealTimers();
});

describe('STRESS scr-manageaccountscreen / lifecycle — ManageAccountScreen in the real navigator', () => {
  const rows: MatrixRow[] = [];
  const seeds =
    SEED_FILTER && SEED_FILTER.length > 0
      ? SEED_FILTER
      : Array.from({ length: ITERATIONS }, (_, i) => SEED_BASE + i);

  for (const seed of seeds) {
    const scenario = scenarioFromSeed(seed);
    it(`seed ${seed}: ${describeScenario(scenario)}`, async () => {
      const row = await runScenario(scenario);
      rows.push(row);
      if (!row.ok) {
        writeJsonArtifact(`${SUITE}.seed-${seed}.json`, row);
      }
      expect(row.failed).toEqual([]);
    }, 120_000);
  }

  afterAll(() => {
    if (rows.length === 0) return;
    const summary = {
      ...summarize(rows),
      iterations: rows.length,
      seeds: rows.map(r => r.seed),
      appliedEvents: rows.reduce(
        (sum, r) => sum + Number(r.observed['appliedEvents'] ?? 0),
        0,
      ),
      eventKinds: rows.reduce<Record<string, number>>((acc, r) => {
        for (const event of r.inputs['events'] as LifecycleEvent[]) {
          acc[event.kind] = (acc[event.kind] ?? 0) + 1;
        }
        return acc;
      }, {}),
      deliveredDeletions: rows.filter(
        r => r.observed['deliveredDeletion'] === true,
      ).length,
      heap: heapSnapshot(),
      node: nodeProcess.version,
    };
    writeJsonArtifact(`${SUITE}.rows.json`, rows);
    writeJsonArtifact(
      `${SUITE}.table.json`,
      rows.map(r => ({
        seed: r.seed,
        ok: r.ok,
        failed: r.failed,
        finalUi: r.observed['finalUi'],
        deliveredDeletion: r.observed['deliveredDeletion'],
        appliedEvents: r.observed['appliedEvents'],
        durationMs: r.durationMs,
        scenario: r.scenario,
      })),
    );
    writeJsonArtifact(`${SUITE}.summary.json`, summary);
    writeTextArtifact(`${SUITE}.md`, matrixMarkdown(rows));
    console.log(
      `[${SUITE}] ${rows.length} iterations, ${rows.filter(r => r.ok).length} ok → ${artifactDir()}`,
    );
  });
});
