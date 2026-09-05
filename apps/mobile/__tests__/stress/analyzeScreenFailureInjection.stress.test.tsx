/**
 * STRESS `scr-analyzescreen` × `failure-injection`.
 *
 * AnalyzeScreen is rendered inside a REAL React Navigation container + native
 * stack (Home → Analyze → Result/Paywall/ConnectAccount), above the real
 * access store (RevenueCat client + canonical access client), the real
 * ApiSession/session keeper, the real sync runtime and the real repository
 * over a real in-memory SQLite database. Only the seams the app cannot own
 * under jest are faked: the native camera bridge, the op-sqlite driver, fetch,
 * `react-native-keychain` and the RevenueCat SDK object. Each iteration draws
 * one fault cell from test-support/stress/analyzeScreenFailureInjection.ts and
 * drives the screen as a player would, then checks:
 *
 *   - recoverable terminal state (error surface with Try again/Upgrade AND
 *     Close, a route the player can leave, Result, or ready)
 *   - no infinite spinner: a working/gate spinner still present after 60s of
 *     fake time is a violation
 *   - no silent failure: an injected fault on the capture/scoring path never
 *     lands the player back on "ready" without an error surface
 *   - no fake success: a Result route needs a persisted, well-formed shot
 *   - no corrupted persisted state: PRAGMA integrity_check, no open
 *     transaction, every JSON column parses, no scored shot without an outbox
 *     row or receipt, every analyzed capture owns an analysis record, no
 *     scored shot without a reserved permit
 *   - no leaked permit: every reserved permit is consumed or released
 *
 * Replay: STRESS_SEEDS=123,456 runs exactly those seeds; STRESS_ITER=N sets
 * the iteration count (default covers every cell once); STRESS_CAMPAIGN_SEED
 * changes the seed stream; STRESS_CELL=<id> pins a cell. A JSON table of
 * seed → outcome is written to artifacts/stress/.
 *
 * Requires node:sqlite (Node >= 22.13, or NODE_OPTIONS=--experimental-sqlite
 * on 22.12), like __tests__/dbMigrationMalformedOutbox.test.ts.
 */
import React, { useEffect } from 'react';
import { Text, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  createNavigationContainerRef,
  NavigationContainer,
  useRoute,
  type RouteProp,
} from '@react-navigation/native';
import {
  createNativeStackNavigator,
  type NativeStackNavigationProp,
  type NativeStackScreenProps,
} from '@react-navigation/native-stack';
import type { CameraEvent } from '../../src/camera/capture';
import { AnalyzeScreen } from '../../src/screens/AnalyzeScreen';
import { LoadingState } from '../../src/design/components';
import type { RootStackParams } from '../../src/navigation/params';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';
import { useAuthStore } from '../../src/auth/authStore';
import { createBillingAccessDependencies } from '../../src/billing';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import {
  startSessionKeeper,
  stopSessionKeeper,
} from '../../src/account/sessionKeeper';
import {
  loadPersistedSession,
  savePersistedSession,
} from '../../src/account/sessionVault';
import {
  clearSyncRuntime,
  configureSyncRuntime,
} from '../../src/data/syncRuntime';
import {
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { getDb } from '../../src/data/db';
import {
  campaignSeeds,
  CELLS,
  planFor,
  replayCommand,
  summarize,
  type FaultPlan,
  type IterationRecord,
  type Terminal,
} from '../../test-support/stress/analyzeScreenFailureInjection';
import {
  API_BASE_URL,
  BEARER_1,
  OWNER,
  REFRESH_1,
  RC_PUBLIC_KEY,
  StressWorld,
} from '../../test-support/stress/analyzeScreenStressWorld';

declare const process: {
  env: Record<string, string | undefined>;
  version: string;
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
};
declare const require: (id: string) => unknown;

// ─── World plumbing (jest.mock factories may only see `mock*` bindings) ──────

let mockWorld: StressWorld | null = null;
const mockCameraListeners = new Set<(event: CameraEvent) => void>();

function mockWorldNow(): StressWorld {
  if (!mockWorld) throw new Error('stress world is not active');
  return mockWorld;
}

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => mockWorldNow().opSqlite(),
}));

jest.mock('react-native-keychain', () => ({
  get ACCESSIBLE() {
    return mockWorldNow().keychain.ACCESSIBLE;
  },
  setGenericPassword: (...args: unknown[]) =>
    (
      mockWorldNow().keychain.setGenericPassword as (
        ...a: unknown[]
      ) => Promise<unknown>
    )(...args),
  getGenericPassword: (...args: unknown[]) =>
    (
      mockWorldNow().keychain.getGenericPassword as (
        ...a: unknown[]
      ) => Promise<unknown>
    )(...args),
  resetGenericPassword: (...args: unknown[]) =>
    (
      mockWorldNow().keychain.resetGenericPassword as (
        ...a: unknown[]
      ) => Promise<unknown>
    )(...args),
}));

jest.mock('../../src/camera/capture', () => {
  const actual = jest.requireActual<typeof import('../../src/camera/capture')>(
    '../../src/camera/capture',
  );
  return {
    ...actual,
    captureStrokeVideo: () => mockWorldNow().captureStrokeVideo(),
    importStrokeVideo: () => mockWorldNow().importStrokeVideo(),
    // The real check inspects the native module (absent under Jest); the
    // stress world stands in for a build that ships the offline pose pass.
    importedPoseExtractionAvailable: () => true,
    extractImportedPoseSequence: () =>
      mockWorldNow().extractImportedPoseSequence(),
    cancelCameraOperation: () => mockWorldNow().cancelCameraOperation(),
    readCaptureArtifact: (uri: string) =>
      mockWorldNow().readCaptureArtifact(uri),
    subscribeToCameraEvents: (listener: (event: CameraEvent) => void) => {
      mockCameraListeners.add(listener);
      return () => mockCameraListeners.delete(listener);
    },
  };
});

jest.mock('../../src/vision/providers', () => {
  const actual = jest.requireActual<
    typeof import('../../src/vision/providers')
  >('../../src/vision/providers');
  return {
    ...actual,
    createFusionProviders: (
      ...args: Parameters<typeof actual.createFusionProviders>
    ) => mockWorldNow().wrapProviders(actual.createFusionProviders(...args)),
  };
});

jest.mock('react-native-safe-area-context', () => {
  const mock = jest.requireActual<{ default: unknown }>(
    'react-native-safe-area-context/jest/mock',
  );
  return mock.default;
});

// ─── Stress navigator: real container + native stack, stub siblings ─────────

const Stack = createNativeStackNavigator<RootStackParams>();
const navigationRef = createNavigationContainerRef<RootStackParams>();

function HomeStub() {
  return <Text testID="stress-home">Home</Text>;
}

function ResultStub() {
  const route = useRoute<RouteProp<RootStackParams, 'Result'>>();
  return <Text testID="stress-result">Result {route.params.analysisId}</Text>;
}

function PaywallStub() {
  const route = useRoute<RouteProp<RootStackParams, 'Paywall'>>();
  return (
    <View>
      <Text testID="stress-paywall">Paywall {route.params?.source}</Text>
      <Text accessibilityLabel="Not now" onPress={() => navigationRef.goBack()}>
        Not now
      </Text>
    </View>
  );
}

function ConnectAccountStub() {
  return <Text testID="stress-connect">ConnectAccount</Text>;
}

/** Mirror of RootNavigator's `useRatingRouteGate` + `AnalyzeRoute` (not
 * exported there); same store reads, same replace targets. */
function useRatingRouteGate(
  navigation: NativeStackNavigationProp<RootStackParams, 'Analyze'>,
) {
  const status = useAccessStore(state => state.status);
  const canonicalAccess = useAccessStore(state => state.canonicalAccess);
  const initialize = useAccessStore(state => state.initialize);
  const localOnly = useAuthStore(state => state.session?.localOnly === true);
  useEffect(() => {
    if (localOnly) {
      navigation.replace('ConnectAccount');
      return;
    }
    if (canonicalAccess?.canStartRating) return;
    if (status === 'idle') {
      void initialize();
      return;
    }
    if (
      canonicalAccess !== null ||
      status === 'ready' ||
      status === 'unconfigured' ||
      status === 'error'
    ) {
      navigation.replace('Paywall', { source: 'rating' });
    }
  }, [canonicalAccess, initialize, localOnly, navigation, status]);
  return canonicalAccess?.canStartRating === true;
}

function AnalyzeRoute({
  navigation,
}: NativeStackScreenProps<RootStackParams, 'Analyze'>) {
  const allowed = useRatingRouteGate(navigation);
  return allowed ? (
    <AnalyzeScreen />
  ) : (
    <LoadingState label="Checking access…" />
  );
}

function StressNavigator({ source }: { source: 'camera' | 'library' }) {
  return (
    <NavigationContainer
      ref={navigationRef}
      initialState={{
        index: 1,
        routes: [{ name: 'Tabs' }, { name: 'Analyze', params: { source } }],
      }}
    >
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Tabs" component={HomeStub} />
        <Stack.Screen name="Analyze" component={AnalyzeRoute} />
        <Stack.Screen name="Result" component={ResultStub} />
        <Stack.Screen name="Paywall" component={PaywallStub} />
        <Stack.Screen name="ConnectAccount" component={ConnectAccountStub} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

// ─── Driving helpers ─────────────────────────────────────────────────────────

type Renderer = TestRenderer.ReactTestRenderer;

const BASE_TIME = Date.UTC(2026, 8, 4, 18, 0, 0);
const STUCK_AFTER_MS = 60_000;
const ITERATION_BUDGET_MS = 130_000;
const STEP_MS = 250;

function textOf(renderer: Renderer): string {
  return renderer.root
    .findAll(n => n.type === Text)
    .map(n =>
      React.Children.toArray(n.props.children as React.ReactNode)
        .map(c =>
          typeof c === 'string' || typeof c === 'number' ? String(c) : '',
        )
        .join(''),
    )
    .join('\n');
}

function pressables(renderer: Renderer): string[] {
  return renderer.root
    .findAll(
      n =>
        typeof n.props.onPress === 'function' &&
        typeof n.props.accessibilityLabel === 'string' &&
        n.props.disabled !== true,
    )
    .map(n => String(n.props.accessibilityLabel));
}

function press(renderer: Renderer, label: string | RegExp): boolean {
  const nodes = renderer.root.findAll(
    n =>
      typeof n.props.onPress === 'function' &&
      typeof n.props.accessibilityLabel === 'string' &&
      (typeof label === 'string'
        ? n.props.accessibilityLabel === label
        : label.test(n.props.accessibilityLabel)) &&
      n.props.disabled !== true,
  );
  const node = nodes[0];
  if (!node) return false;
  act(() => {
    node.props.onPress();
  });
  return true;
}

function hasTestId(renderer: Renderer, id: string): boolean {
  return renderer.root.findAll(n => n.props.testID === id).length > 0;
}

type Observed =
  | 'gate'
  | 'ready'
  | 'working'
  | 'saved'
  | 'analyzed'
  | 'free_limit'
  | 'error'
  | 'result'
  | 'paywall'
  | 'connect'
  | 'home'
  | 'unknown';

function observe(renderer: Renderer): Observed {
  const route: string | undefined = navigationRef.isReady()
    ? navigationRef.getRootState()?.routes.at(-1)?.name
    : undefined;
  if (route === 'Result' || hasTestId(renderer, 'stress-result'))
    return 'result';
  if (route === 'Paywall' || hasTestId(renderer, 'stress-paywall'))
    return 'paywall';
  if (route === 'ConnectAccount') return 'connect';
  if (route === 'Tabs') return 'home';
  if (hasTestId(renderer, 'analysis-mascot-error')) return 'error';
  if (
    hasTestId(renderer, 'analysis-mascot-working') ||
    hasTestId(renderer, 'stroke-result-analyzing')
  )
    return 'working';
  if (hasTestId(renderer, 'analysis-mascot-saved')) return 'saved';
  if (hasTestId(renderer, 'analysis-mascot-free-limit')) return 'free_limit';
  if (hasTestId(renderer, 'analysis-mascot-outcome')) return 'analyzed';
  if (hasTestId(renderer, 'analysis-mascot-ready')) return 'ready';
  if (textOf(renderer).includes('Checking access…')) return 'gate';
  return 'unknown';
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

interface Drive {
  renderer: Renderer;
  plan: FaultPlan;
  fakeMs: number;
  errorShownEver: boolean;
  workingSeenEver: boolean;
  navFaultApplied: boolean;
  savedHandled: boolean;
  clockJumpApplied: boolean;
  controlsAtError: string[];
  notes: string[];
}

function terminalFor(observed: Observed, renderer: Renderer): Terminal | null {
  switch (observed) {
    case 'result':
      return 'result';
    case 'paywall':
      return 'paywall';
    case 'connect':
    case 'home':
      return 'home';
    case 'analyzed':
      return 'analyzed';
    case 'free_limit':
      return 'free_limit';
    case 'ready':
      return 'ready';
    case 'error': {
      const labels = pressables(renderer);
      return labels.includes('Upgrade to Pro')
        ? 'error_upgrade'
        : 'error_retry';
    }
    default:
      return null;
  }
}

/** Advances fake time until the screen reaches a terminal state or the
 * budget is exhausted, applying the plan's player interactions on the way. */
async function drive(d: Drive, budgetMs: number): Promise<Terminal> {
  const start = d.fakeMs;
  let lastObserved: Observed = 'unknown';
  let sameSince = d.fakeMs;
  let readyPressed = false;
  for (;;) {
    const observed = observe(d.renderer);
    if (observed !== lastObserved) {
      lastObserved = observed;
      sameSince = d.fakeMs;
    }
    if (observed === 'working') {
      d.workingSeenEver = true;
      const clock = d.plan.clock;
      if (
        clock &&
        (clock.kind === 'jump_backwards' || clock.kind === 'jump_forwards') &&
        !d.clockJumpApplied
      ) {
        d.clockJumpApplied = true;
        const sign = clock.kind === 'jump_forwards' ? 1 : -1;
        jest.setSystemTime(Date.now() + sign * clock.byMs);
      }
    }
    if (observed === 'error') {
      d.errorShownEver = true;
      d.controlsAtError = pressables(d.renderer);
    }

    // Player interactions the plan calls for.
    if (observed === 'ready' && d.plan.source === 'camera' && !readyPressed) {
      readyPressed = true;
      if (d.plan.declare) press(d.renderer, /^forehand drive$/i);
      else press(d.renderer, /^auto detect$/i);
      await settle();
      if (!press(d.renderer, 'Open automatic camera')) {
        d.notes.push('ready: "Open automatic camera" not pressable');
      }
      await settle();
      continue;
    }
    if (observed === 'saved' && !d.savedHandled) {
      d.savedHandled = true;
      if (
        !pressables(d.renderer).some(l =>
          /^skip|technique score|auto detect$/i.test(l),
        )
      ) {
        press(d.renderer, /^forehand drive$/i);
        await settle();
      }
      const pressed =
        press(d.renderer, /^Skip — pick automatically$/) ||
        press(d.renderer, 'Get my Technique Score') ||
        press(d.renderer, 'Analyze with Auto Detect');
      if (!pressed)
        d.notes.push(
          `saved: no scoring control among ${pressables(d.renderer).join('|')}`,
        );
      await settle();
      continue;
    }
    const nav = d.plan.navigation;
    if (nav && !d.navFaultApplied && observed === 'working') {
      const text = textOf(d.renderer);
      const analysing = /Reading player movement|Measuring your swing/.test(
        text,
      );
      if (
        (nav.action === 'close' &&
          nav.atStage === 'capture_working' &&
          !analysing) ||
        (nav.action === 'close' &&
          nav.atStage === 'analysis_working' &&
          analysing)
      ) {
        d.navFaultApplied = true;
        for (let i = 0; i < nav.times; i += 1) press(d.renderer, 'Close');
        await settle();
        continue;
      }
      if (nav.action === 'navigate_home' && analysing) {
        d.navFaultApplied = true;
        act(() => {
          navigationRef.navigate('Tabs');
        });
        await settle();
        continue;
      }
    }

    // `ready` only counts as a terminal once the run has actually started
    // (library auto-launches after 160ms; camera launches on the press above).
    const terminal =
      observed === 'ready' && !d.workingSeenEver && !readyPressed
        ? null
        : terminalFor(observed, d.renderer);
    if (terminal) return terminal;
    if (d.fakeMs - start >= budgetMs) {
      if (observed === 'gate') return 'bootstrap_stuck';
      if (observed === 'working') return 'working_stuck';
      return 'unknown';
    }
    if (
      d.fakeMs - sameSince >= STUCK_AFTER_MS &&
      (observed === 'working' || observed === 'gate') &&
      !d.notes.includes('spinner unchanged for 60s')
    ) {
      d.notes.push('spinner unchanged for 60s');
    }
    if (d.plan.clock?.kind === 'frozen') {
      jest.setSystemTime(BASE_TIME);
    }
    await advance(STEP_MS);
    d.fakeMs += STEP_MS;
  }
}

// ─── One iteration ───────────────────────────────────────────────────────────

async function runIteration(
  seed: number,
  index: number,
  onlyCell?: string,
): Promise<IterationRecord> {
  const plan = planFor(seed, index, onlyCell);
  const startedWall = Date.now();
  jest.useFakeTimers();
  const clock = plan.clock;
  jest.setSystemTime(clock?.kind === 'absolute' ? clock.epochMs : BASE_TIME);

  const consoleErrors: string[] = [];
  const unhandled: string[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason instanceof Error ? reason.message : String(reason));
  };
  process.on('unhandledRejection', onUnhandled);
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    consoleErrors.push(
      args.map(a => (a instanceof Error ? a.message : String(a))).join(' '),
    );
  };

  const w = new StressWorld({
    plan,
    emit: event => {
      act(() => {
        for (const listener of mockCameraListeners) listener(event);
      });
    },
  });
  mockWorld = w;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = w.fetch as typeof fetch;

  const violations: string[] = [];
  const notes: string[] = [];
  let terminal: Terminal = 'unknown';
  let recovery: IterationRecord['recovery'] = null;
  let controls: string[] = [];
  let errorMessage: string | null = null;
  let fakeMs = 0;
  let persistence: IterationRecord['persistence'] = null;
  let renderer: Renderer | null = null;

  try {
    // ── App runtime the way installApiSession() wires it ──────────────────
    // Keychain vault first (this is where `keychain.get` faults land).
    let vaultState = 'pending';
    const vaultLoad = loadPersistedSession()
      .then(s => {
        vaultState = s ? 'session' : 'null';
      })
      .catch(e => {
        vaultState = `threw:${e instanceof Error ? e.message : String(e)}`;
      });
    await settle();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(15_000);
    });
    fakeMs += 15_000;
    void vaultLoad;
    notes.push(`vault.load=${vaultState}`);
    if (vaultState.startsWith('threw'))
      violations.push('keychain read rejection escaped sessionVault');

    setActiveDataOwner(canonicalDataOwner(OWNER));
    // Keychain `set` faults only land on the vault write that follows a bearer
    // rotation; give those plans a bearer the keeper must rotate ~2s in (the
    // keeper refreshes 60s before expiry).
    const needsRotation =
      plan.keychain?.op === 'set' ||
      plan.fetch.some(f => f.route === 'auth.refresh');
    const bearerExpiresAtMs =
      clock?.kind === 'bearer_expires_in_past'
        ? Date.now() - 5_000
        : needsRotation
          ? Date.now() + 62_000
          : Date.now() + 90_000;
    const apiSession = {
      apiBaseUrl: API_BASE_URL,
      bearerToken: BEARER_1,
      canonicalAppUserId: OWNER,
      provider: 'apple' as const,
      refreshToken: REFRESH_1,
      bearerExpiresAtMs,
    };
    establishApiSession(apiSession);
    configureAccessStore(
      createBillingAccessDependencies({
        revenueCatPublicSdkKey: RC_PUBLIC_KEY,
        canonicalAppUserId: OWNER,
        apiBaseUrl: API_BASE_URL,
        get apiToken() {
          return BEARER_1;
        },
        revenueCatSdk: w.revenueCat,
        platform: 'ios',
        fetchFn: w.fetch,
      }),
    );
    configureSyncRuntime(apiSession);
    useAuthStore.setState({
      session: {
        provider: 'apple',
        subject: 'apple-subject',
        canonicalAppUserId: OWNER,
        localOnly: false,
        displayName: null,
        email: null,
      },
      hydrated: true,
    });
    startSessionKeeper({
      apiBaseUrl: API_BASE_URL,
      refreshToken: REFRESH_1,
      bearerExpiresAtMs,
      onRotated: async tokens => {
        w.log.rotatedBearers += 1;
        establishApiSession({
          ...apiSession,
          bearerToken: tokens.bearerToken,
          refreshToken: tokens.refreshToken,
          bearerExpiresAtMs: tokens.bearerExpiresAtMs,
        });
        await savePersistedSession({
          version: 1,
          provider: 'apple',
          canonicalAppUserId: OWNER,
          refreshToken: tokens.refreshToken,
          email: null,
          displayName: null,
        });
      },
      onRevoked: () => {
        w.log.revokedSessions += 1;
      },
      fetchFn: w.fetch,
    });

    // ── Render inside the real navigator ──────────────────────────────────
    await act(async () => {
      renderer = TestRenderer.create(<StressNavigator source={plan.source} />);
    });
    if (!renderer) throw new Error('renderer did not mount');
    await settle();

    const d: Drive = {
      renderer,
      plan,
      fakeMs: 0,
      errorShownEver: false,
      workingSeenEver: false,
      navFaultApplied: false,
      savedHandled: false,
      clockJumpApplied: false,
      controlsAtError: [],
      notes,
    };
    terminal = await drive(d, ITERATION_BUDGET_MS);
    if (d.clockJumpApplied) {
      notes.push(
        `clock.${clock?.kind}=${clock && 'byMs' in clock ? clock.byMs : 0}ms applied at first working frame`,
      );
    }
    controls = pressables(renderer);
    if (terminal === 'error_retry' || terminal === 'error_upgrade') {
      const text = textOf(renderer);
      const idx = text.indexOf('Nothing was rated.');
      errorMessage =
        idx >= 0
          ? (text
              .slice(idx + 'Nothing was rated.'.length)
              .split('\n')
              .filter(Boolean)[0] ?? null)
          : null;
    }

    // ── Recovery: use the visible control the plan chose ──────────────────
    if (terminal === 'error_retry' || terminal === 'error_upgrade') {
      const hasClose = controls.includes('Close');
      const hasPrimary =
        controls.includes('Try again') || controls.includes('Upgrade to Pro');
      if (!hasClose) violations.push('error surface without a Close control');
      if (!hasPrimary)
        violations.push('error surface without Try again / Upgrade control');
      const nav = plan.navigation;
      if (
        nav?.action === 'retry_double_tap' &&
        controls.includes('Try again')
      ) {
        press(renderer, 'Try again');
        press(renderer, 'Try again');
        await settle();
        const after = await drive(d, 60_000);
        recovery = { action: 'try_again×2', outcome: after };
        if (w.log.reservedPermits.length > 1 && after === 'result') {
          notes.push(
            `double tap reserved ${w.log.reservedPermits.length} permits`,
          );
        }
      } else if (
        nav?.action === 'try_again_then_close_race' &&
        controls.includes('Try again')
      ) {
        press(renderer, 'Try again');
        press(renderer, 'Close');
        await settle();
        const after = await drive(d, 60_000);
        recovery = { action: 'try_again+close', outcome: after };
      } else if (
        plan.recovery === 'try_again' &&
        controls.includes('Try again')
      ) {
        press(renderer, 'Try again');
        await settle();
        const after = await drive(d, 60_000);
        recovery = { action: 'try_again', outcome: after };
        if (after === 'working_stuck' || after === 'unknown') {
          violations.push(`retry did not settle: ${after}`);
        }
      } else if (
        controls.includes('Upgrade to Pro') &&
        plan.recovery === 'try_again'
      ) {
        press(renderer, 'Upgrade to Pro');
        await settle();
        const after = await drive(d, 10_000);
        recovery = { action: 'upgrade', outcome: after };
        if (after !== 'paywall')
          violations.push(`Upgrade to Pro did not reach Paywall: ${after}`);
      } else if (hasClose) {
        press(renderer, 'Close');
        await settle();
        const after = await drive(d, 10_000);
        recovery = { action: 'close', outcome: after };
        if (after !== 'home')
          violations.push(`Close did not leave the screen: ${after}`);
      }
    } else if (
      terminal === 'saved' ||
      terminal === 'analyzed' ||
      terminal === 'free_limit'
    ) {
      const hasExit = controls.some(l =>
        /^(Close|Back|See the full read|See my score|Done)$/i.test(l),
      );
      if (!hasExit)
        violations.push(
          `${terminal} surface has no visible exit control: ${controls.join('|')}`,
        );
    } else if (terminal === 'working_stuck') {
      violations.push(
        `working spinner still shown after ${ITERATION_BUDGET_MS / 1000}s fake time (no timeout/error surfaced)`,
      );
      if (!controls.includes('Close')) {
        violations.push('stuck working surface has no Close control');
      } else {
        // The escape hatch must actually work while the run is wedged.
        press(renderer, 'Close');
        await settle();
        const after = await drive(d, 10_000);
        recovery = { action: 'close_while_stuck', outcome: after };
        if (after !== 'home')
          violations.push(`Close did not leave the stuck screen: ${after}`);
        else
          notes.push(
            `Close escaped the stuck spinner (cancelCameraOperation calls=${w.log.cancelCalls})`,
          );
      }
    } else if (terminal === 'bootstrap_stuck') {
      violations.push(
        `"Checking access…" gate still shown after ${ITERATION_BUDGET_MS / 1000}s fake time`,
      );
      if (controls.length === 0)
        violations.push('stuck access gate exposes no control at all');
    } else if (terminal === 'unknown') {
      violations.push(
        `unrecognised terminal surface: ${textOf(renderer).slice(0, 200)}`,
      );
    }
    fakeMs += d.fakeMs;

    // ── Silent failure / fake success ─────────────────────────────────────
    const faultOnCapturePath =
      w.log.faultHits > 0 &&
      (plan.dependency === 'camera' ||
        plan.dependency === 'permissions' ||
        plan.dependency === 'vision' ||
        plan.dependency === 'sqlite' ||
        (plan.dependency === 'fetch' &&
          plan.fetch.some(f => f.route === 'permits.reserve')));
    if (
      faultOnCapturePath &&
      terminal === 'ready' &&
      !d.errorShownEver &&
      !plan.navigation
    ) {
      violations.push(
        'fault on the capture/scoring path returned to ready without an error surface',
      );
    }
    if (terminal === 'result' && plan.vision?.form === 'malformed') {
      notes.push(
        'malformed provider output reached Result — checked against persisted shot below',
      );
    }

    // ── Persistence ──────────────────────────────────────────────────────
    // Let the sync runtime / release calls drain before snapshotting (and, for
    // rotation-write faults, let the keeper's rotation timer fire).
    const drainMs =
      needsRotation || clock?.kind === 'bearer_expires_in_past' ? 6_000 : 2_000;
    await advance(drainMs);
    fakeMs += drainMs;
    if (plan.keychain?.op === 'set') {
      notes.push(
        `rotations=${w.log.rotatedBearers} keychainWrites=${w.log.keychainWrites}`,
      );
      if (w.log.keychainWrites === 0)
        violations.push(
          'keychain set fault never exercised: no rotation write happened',
        );
    }
    if (
      clock?.kind === 'bearer_expires_in_past' ||
      plan.fetch.some(f => f.route === 'auth.refresh')
    ) {
      notes.push(
        `rotations=${w.log.rotatedBearers} revoked=${w.log.revokedSessions}`,
      );
    }
    // Closing the screen does not cancel a scoring run already past the
    // permit reserve (AnalyzeScreen only flags it abandoned); let that
    // background run settle so the accounting reflects its real outcome.
    const outstanding = (): number =>
      w.log.reservedPermits.length -
      w.log.fetchCalls.filter(c => /\/finalize$/.test(c)).length -
      w.snapshot().shotScores.length;
    if (terminal === 'home' && outstanding() > 0) {
      let waited = 0;
      while (waited < 60_000 && outstanding() > 0) {
        await advance(5_000);
        waited += 5_000;
      }
      fakeMs += waited;
      notes.push(
        `background run after close: waited ${waited}ms, outstanding=${outstanding()}`,
      );
    }
    persistence = w.snapshot();
    if (persistence.integrity !== 'ok')
      violations.push(`integrity_check=${persistence.integrity}`);
    if (persistence.openTransaction) {
      // A statement that never resolves inside BEGIN…COMMIT necessarily leaves
      // the transaction pending while the spinner is stuck; that is the
      // spinner finding, not a second corruption finding.
      if (terminal === 'working_stuck')
        notes.push('transaction pending behind the stuck statement');
      else violations.push('transaction left open');
    }
    if (persistence.unparsablePayloads > 0)
      violations.push(
        `${persistence.unparsablePayloads} unparsable JSON column(s)`,
      );
    if (persistence.shotsWithoutOutboxOrReceipt > 0)
      violations.push('scored shot without outbox row or sync receipt');
    for (const capture of w.captureRows()) {
      if (capture.status === 'analyzed' && capture.records === 0) {
        violations.push(
          `capture ${capture.id} marked analyzed without an analysis record`,
        );
      }
      if (
        capture.status !== 'analyzed' &&
        capture.status !== 'awaiting_model'
      ) {
        violations.push(`capture ${capture.id} has status ${capture.status}`);
      }
    }
    if (persistence.shotScores.length > w.log.reservedPermits.length) {
      violations.push('more scored shots persisted than permits reserved');
    }
    // Technique scores are 0..10 (the edge parser rejects anything else).
    for (const score of persistence.shotScores) {
      if (!Number.isFinite(score) || score < 0 || score > 10) {
        violations.push(`persisted scored shot with overall_score=${score}`);
      }
    }
    if (terminal === 'result') {
      const analysisId = textOf(renderer).match(/Result (\S+)/)?.[1] ?? null;
      if (!analysisId) {
        violations.push('Result route without an analysisId');
      } else {
        const rows = w.sqlite
          .prepare(
            `SELECT result_kind, overall_score, payload FROM local_shot WHERE id = ?`,
          )
          .all(analysisId);
        const row = rows[0];
        if (!row) {
          violations.push(
            `Result opened for ${analysisId} but no local_shot row exists (fake success)`,
          );
        } else if (row['result_kind'] === 'scored') {
          const payload = JSON.parse(String(row['payload'])) as {
            checkpoints?: unknown[];
          };
          if (
            !Array.isArray(payload.checkpoints) ||
            payload.checkpoints.length === 0
          ) {
            violations.push('scored shot persisted without checkpoints');
          }
        }
      }
    }
    // Permit accounting: reserved − released − consumed(by a persisted scored shot) must be 0.
    // A release the client ATTEMPTED but the server refused is the documented
    // server-sweep path (runCaptureAnalysis swallows it) — count attempts.
    const consumed = persistence.shotScores.length;
    const releaseAttempts = w.log.fetchCalls.filter(c =>
      /\/finalize$/.test(c),
    ).length;
    const leaked = w.log.reservedPermits.length - releaseAttempts - consumed;
    if (leaked > 0 && terminal !== 'working_stuck' && terminal !== 'unknown') {
      violations.push(
        `${leaked} reserved permit(s) neither consumed nor released`,
      );
    }
    if (releaseAttempts > w.log.releasedPermits.length) {
      notes.push(
        `${releaseAttempts - w.log.releasedPermits.length} permit release(s) refused by server — relies on server-side sweep`,
      );
    }
    if (unhandled.length > 0)
      violations.push(`unhandled rejection: ${unhandled[0]}`);
    // An iteration whose injected fault was never reached proves nothing —
    // fail the harness rather than count it.
    if (
      w.log.faultHits === 0 &&
      plan.dependency !== 'clock' &&
      plan.dependency !== 'navigation'
    ) {
      violations.push(
        `harness: ${plan.cell} fault was never exercised (0 hits)`,
      );
    }
  } catch (error) {
    // Keep the seed in the table: an escaped exception is a BROKEN outcome,
    // not a missing row.
    violations.push(
      `exception escaped to the test: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    );
  } finally {
    // ── Teardown ─────────────────────────────────────────────────────────
    try {
      if (renderer) {
        const r: Renderer = renderer;
        await act(async () => {
          r.unmount();
        });
      }
    } catch (error) {
      notes.push(
        `unmount threw: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    stopSessionKeeper();
    clearSyncRuntime();
    clearAccessStoreConfiguration();
    clearApiSession();
    useAuthStore.setState({ session: null, hydrated: false });
    try {
      getDb().close();
    } catch {
      // The world's database may already be closed.
    }
    w.close();
    globalThis.fetch = previousFetch;
    mockWorld = null;
    mockCameraListeners.clear();
    console.error = originalConsoleError;
    process.off('unhandledRejection', onUnhandled);
    jest.clearAllTimers();
    jest.useRealTimers();
  }

  const record: IterationRecord = {
    seed,
    index,
    cell: plan.cell,
    replay: replayCommand(seed, plan.cell),
    dependency: plan.dependency,
    form: plan.form,
    source: plan.source,
    plan,
    faultHits: w.log.faultHits,
    terminal,
    errorMessage,
    controls,
    recovery,
    fetchCalls: w.log.fetchCalls,
    bridgeCalls: w.log.bridgeCalls,
    cancelCalls: w.log.cancelCalls,
    permits: {
      reserved: w.log.reservedPermits,
      released: w.log.releasedPermits,
    },
    persistence,
    consoleErrors: consoleErrors.filter(
      m =>
        !/not wrapped in act|ReactNativeFiberHostComponent|useNativeDriver/.test(
          m,
        ),
    ),
    unhandledRejections: unhandled,
    violations,
    notes,
    fakeMsAdvanced: fakeMs,
    wallMs: Date.now() - startedWall,
    verdict: violations.length === 0 ? 'HELD' : 'BROKEN',
  };
  return record;
}

// ─── Campaign ────────────────────────────────────────────────────────────────

const env = process.env;
const campaignSeed = Number(env['STRESS_CAMPAIGN_SEED'] ?? 20260904);
const explicitSeeds = (env['STRESS_SEEDS'] ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(Number);
const requested =
  explicitSeeds.length > 0
    ? explicitSeeds.length
    : Number(env['STRESS_ITER'] ?? CELLS.length);
const seeds =
  explicitSeeds.length > 0
    ? explicitSeeds
    : campaignSeeds(campaignSeed, requested);
const onlyCell = env['STRESS_CELL'];

const iterations: IterationRecord[] = [];
const startedAtIso = new Date().toISOString();

describe(`AnalyzeScreen failure injection (${requested} seeded iterations, campaign ${campaignSeed})`, () => {
  jest.setTimeout(20 * 60_000);

  it.each(seeds.map((seed, index) => [seed, index] as const))(
    'seed %d holds every recovery invariant',
    async (seed, index) => {
      const record = await runIteration(seed, index, onlyCell);
      iterations.push(record);
      expect({
        seed: record.seed,
        cell: record.cell,
        terminal: record.terminal,
        violations: record.violations,
      }).toEqual({
        seed: record.seed,
        cell: record.cell,
        terminal: record.terminal,
        violations: [],
      });
    },
  );

  afterAll(() => {
    const fs = require('fs') as {
      mkdirSync(path: string, options: { recursive: boolean }): void;
      writeFileSync(path: string, data: string): void;
    };
    const path = require('path') as { join(...parts: string[]): string };
    const dir = path.join(__dirname, '..', '..', 'artifacts', 'stress');
    fs.mkdirSync(dir, { recursive: true });
    const report = summarize(iterations, {
      commit: env['STRESS_COMMIT'] ?? 'working-tree',
      campaignSeed,
      requested,
      startedAtIso,
      node: process.version,
    });
    const file = path.join(
      dir,
      `analyzeScreenFailureInjection.${
        explicitSeeds.length > 0
          ? `seeds-${[...new Set(explicitSeeds)].join('_')}-n${explicitSeeds.length}${onlyCell ? `-${onlyCell}` : ''}`
          : `campaign-${campaignSeed}-${requested}`
      }.json`,
    );
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
  });
});
