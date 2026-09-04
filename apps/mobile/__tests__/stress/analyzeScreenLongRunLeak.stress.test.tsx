/**
 * STRESS — unit `scr-analyzescreen`, lens `long-run-leak`.
 *
 * Opens and closes the REAL Analyze route (`RootNavigator` → real
 * `NavigationContainer` → real native stack → `AnalyzeRoute` gate →
 * `AnalyzeScreen`) hundreds of times in ONE process and checks that nothing
 * the screen allocates outlives it:
 *
 *   - camera event subscriptions (real `NativeEventEmitter` →
 *     `RCTDeviceEventEmitter`, plus the native `addListener`/`removeListeners`
 *     balance iOS would see),
 *   - JS timers (`jest.getTimerCount()` under fake timers — the library
 *     auto-launch timer, `AnalysisProgress` animations, navigator timers),
 *   - zustand store subscriptions (`useAccessStore`, `useAuthStore`),
 *   - the `StatusBar` props stack (the jest.setup mock records it),
 *   - libuv handles/requests visible to the process,
 *   - a pending native capture is `cancel()`ed exactly once on unmount,
 *   - heap slope (GC'd `heapUsed` every 50 iterations; > 5 % of the first
 *     sample per 100 iterations AND monotone growth is the leak signal),
 *   - mount/unmount time drift (median of the last window vs the first).
 *
 * Only native modules are replaced: the `PickleVideoCapture` bridge module
 * (`__harness__/stress/nativeCaptureModule.ts`), SQLite (`getDb` → in-memory
 * recorder), notifications, SVG / gradient / safe-area natives, and `fetch`.
 * Screens the root stack merely registers (Home, Library, Progress, …) are
 * stubbed so their native imports stay out of the process; the Home stub
 * hands the real `navigation` object to the campaign.
 *
 * Every iteration is replayable: `STRESS_SEED` fans out one seed per
 * iteration; `STRESS_REPLAY_SEEDS=a,b,c` re-runs exactly those iterations.
 *
 *   default (suite):  STRESS_ITER unset → 60 iterations, no heap verdict
 *   campaign:         cd apps/mobile && STRESS_ITER=500 STRESS_OUT=/tmp/stress \
 *                     node --expose-gc node_modules/.bin/jest --ci --silent \
 *                     __tests__/stress/analyzeScreenLongRunLeak
 *
 * Results (seed → outcome table, heap table, handle table, timing drift) are
 * written to `$STRESS_OUT/analyzeScreen.longRunLeak.*.json` when set.
 */
import {
  cameraEventListenerCount,
  emitNativeCameraEvent,
  fakeNativeCaptureState,
  resetFakeNativeCaptureCounters,
} from '../../__harness__/stress/nativeCaptureModule';
import { navigationProbe } from '../../__harness__/stress/navigationProbe';
import {
  assessHeapSlope,
  createSeededRng,
  deriveIterationSeed,
  gcAvailable,
  nowMs,
  openHandleSnapshot,
  parseSeedList,
  readIntEnv,
  sampleHeap,
  timingDrift,
  writeHeapSnapshotArtifact,
  writeStressArtifact,
  type HeapSample,
  type OpenHandleSnapshot,
} from '../../__harness__/stress/longRunLeak';

// ─── Native boundary only ────────────────────────────────────────────────────

jest.mock('../../src/data/db', () => ({ getDb: () => mockCurrentDb() }));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('react-native-linear-gradient', () => {
  const ReactLib = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    ReactLib.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});
jest.mock('react-native-svg', () => {
  const ReactLib = require('react');
  const { View } = require('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    ReactLib.createElement(View, null, props.children);
  // Every named primitive (Circle, RadialGradient, …) renders as a plain
  // View; the library's native module never loads.
  return new Proxy(
    { __esModule: true, default: Mock },
    {
      get: (target, key) =>
        key in target ? target[key as keyof typeof target] : Mock,
    },
  );
});
jest.mock('../../src/notifications/service', () => ({
  __esModule: true,
  subscribeToNotificationPresses: () => () => {},
}));
jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));

// ─── Routes the root stack registers but this lens never opens ──────────────

jest.mock('../../src/screens/HomeScreen', () => {
  const ReactLib = require('react');
  const { View } = require('react-native');
  const { useNavigation } = require('@react-navigation/native');
  const probe = require('../../__harness__/stress/navigationProbe');
  const HomeScreen = () => {
    // The Home tab lives inside the tab navigator; the root stack is its
    // parent — that is the navigator that owns the Analyze route.
    const tabNavigation = useNavigation();
    probe.navigationProbe.current = tabNavigation.getParent() ?? tabNavigation;
    return ReactLib.createElement(View, { testID: 'stress-home-stub' });
  };
  return { HomeScreen };
});
jest.mock('../../src/screens/LibraryScreen', () => ({
  LibraryScreen: () => null,
}));
jest.mock('../../src/screens/ProgressScreen', () => ({
  ProgressScreen: () => null,
}));
jest.mock('../../src/screens/SettingsScreen', () => ({
  SettingsScreen: () => null,
}));
jest.mock('../../src/screens/DrillLibraryScreen', () => ({
  DrillLibraryScreen: () => null,
}));
jest.mock('../../src/screens/ResultScreen', () => ({
  ResultScreen: () => null,
}));
jest.mock('../../src/screens/ResultDetailsScreen', () => ({
  ResultDetailsScreen: () => null,
}));
jest.mock('../../src/screens/FormReviewScreen', () => ({
  FormReviewScreen: () => null,
}));
jest.mock('../../src/screens/StreakCalendarScreen', () => ({
  StreakCalendarScreen: () => null,
}));
jest.mock('../../src/screens/ManageAccountScreen', () => ({
  ManageAccountScreen: () => null,
}));
jest.mock('../../src/screens/ConsentSettingsScreen', () => ({
  ConsentSettingsScreen: () => null,
}));
jest.mock('../../src/screens/NotificationSettingsScreen', () => ({
  NotificationSettingsScreen: () => null,
}));
jest.mock('../../src/navigation/PremiumTabBar', () => ({
  PremiumTabBar: () => null,
}));

import React from 'react';
import { StatusBar, Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { RootNavigator } from '../../src/navigation/RootNavigator';
import type { LocalDb } from '../../src/data/db';
import type { CapturedClip } from '../../src/camera/capture';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';
import type {
  BillingAccessDependencies,
  CanonicalAccessState,
} from '../../src/billing/types';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { usabilityFunnel } from '../../src/analysis/usabilityTelemetry';
import { stabilitySlo } from '../../src/analysis/stabilityTelemetry';

// ─── In-memory SQLite stand-in ───────────────────────────────────────────────

let statementCount = 0;
const kv = new Map<string, string>();
const recordingDb: LocalDb = {
  async execute(sql: string, params: unknown[] = []) {
    statementCount += 1;
    if (sql.startsWith('SELECT value FROM kv')) {
      const value = kv.get(String(params[0]));
      return { rows: value === undefined ? [] : [{ value }] };
    }
    if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
      kv.set(String(params[0]), String(params[1]));
    }
    return { rows: [] };
  },
  close() {},
};
function mockCurrentDb(): LocalDb {
  return recordingDb;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const owner = '55555555-5555-4555-8555-555555555555';

const syncedSession: AuthSession = {
  provider: 'apple',
  subject: owner,
  canonicalAppUserId: owner,
  localOnly: false,
  displayName: 'Stress Tester',
  email: 'stress@example.test',
};

function freeAccess(used: number): CanonicalAccessState {
  const remaining = 2 - used;
  return {
    premium: false,
    entitlements: [],
    freeRatings: {
      limit: 2,
      used,
      reserved: 0,
      remaining,
      availableToReserve: remaining,
    },
    canStartRating: remaining > 0,
    paywallRequired: remaining <= 0,
  };
}

function billingDeps(): BillingAccessDependencies {
  return {
    store: {
      configure: async () => undefined,
      loadPlans: async () => {
        throw new Error('plans are not part of this stress lens');
      },
      purchase: async () => {
        throw new Error('purchase is not part of this stress lens');
      },
      restore: async () => {
        throw new Error('restore is not part of this stress lens');
      },
      readEntitlement: async () => {
        throw new Error('entitlement is not part of this stress lens');
      },
    },
    backend: {
      getAccess: async () => freeAccess(0),
      syncBilling: async () => {
        throw new Error('billing sync is not part of this stress lens');
      },
    },
  };
}

function guidedClip(seed: number): CapturedClip {
  return {
    uri: `file:///captures/stress-${seed}.mov`,
    durationMs: 3000 + (seed % 2000),
    fps: 60,
    width: 1080,
    height: 1080,
    capturedAtIso: '2026-09-04T12:00:00.000Z',
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: 1200,
      endMs: 1900,
      peakMotionMs: 1500,
      confidence: 0.8,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    captureEvidence: {
      schemaVersion: 1,
      window: 'detected_motion',
      poseSource: 'apple_vision_body_pose',
      poseModelVersion: 'apple-vision-bodypose-1',
      triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
      motionUnit: 'normalized_image_units_per_second',
      analysisInputFrameCount: 120,
      poseFrameCount: 120,
      poseMissingFrameCount: 0,
      trackedDurationMs: 700,
      meanCanonicalJointVisibility: 0.9,
      meanJointCoverage: 0.9,
      minimumJointCoverage: 0.8,
      fullBodyVisibleFrameCount: 120,
      jointMotion: [
        {
          joint: 'right_wrist',
          sampleCount: 4,
          meanNormalizedPerSecond: 0.6,
          peakNormalizedPerSecond: 1.4,
        },
      ],
    },
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    preRollMs: 1200,
    postRollMs: 1100,
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: `file:///captures/stress-${seed}.pose.json`,
      frameCount: 120,
      sha256: 'ab'.repeat(32),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
}

const READINESS_STATES = [
  'no_person',
  'full_body_required',
  'move_closer',
  'move_farther',
  'hold_still',
  'ready',
] as const;

// ─── Scenario table (seed → scenario) ────────────────────────────────────────

const SCENARIOS = [
  /** Open the camera landing, look, leave. */
  'idle',
  /** Camera events arrive while nothing is recording, then leave. */
  'stray_events_idle',
  /** Start the camera, receive N readiness events, leave mid-capture. */
  'capture_pending_unmount',
  /** Start the camera, the athlete cancels (typed code), leave. */
  'capture_cancelled',
  /** Start the camera, the session fails, error surface, leave. */
  'capture_error',
  /** Start the camera, a clip lands, "saved" surface, leave. */
  'capture_saved',
  /** Library import auto-launch timer armed, leave before it fires. */
  'library_leave_before_autolaunch',
  /** Library import auto-launch fires, importer pending, leave. */
  'library_import_pending_unmount',
] as const;
type Scenario = (typeof SCENARIOS)[number];

interface IterationRecord {
  index: number;
  seed: number;
  scenario: Scenario;
  events: number;
  outcome: 'held' | 'broken';
  failures: string[];
  consoleErrors: string[];
  mountMs: number;
  unmountMs: number;
  totalMs: number;
  postUnmount: {
    cameraListeners: number;
    nativeListenerBalance: number;
    timers: number;
    accessSubscribers: number;
    authSubscribers: number;
    statusBarStack: number;
    cancelCalls: number;
    pendingNativeOps: number;
    routeCount: number;
  };
}

// ─── Store subscription accounting (instrumentation, not mocking) ────────────

function trackSubscriptions<S>(store: {
  subscribe: (listener: (state: S, prev: S) => void) => () => void;
}): () => number {
  let live = 0;
  const original = store.subscribe;
  store.subscribe = listener => {
    live += 1;
    const unsubscribe = original(listener);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      live -= 1;
      unsubscribe();
    };
  };
  return () => live;
}

const accessSubscribers = trackSubscriptions(useAccessStore);
const authSubscribers = trackSubscriptions(useAuthStore);

// console.error is captured (not silenced) so every React / navigator
// complaint is attributed to the seed that produced it and lands in the
// artifacts instead of scrolling past.
const consoleErrors: { seed: number | null; message: string }[] = [];
let currentSeed: number | null = null;
const realConsoleError = console.error;
function summarizeConsoleErrors(): {
  total: number;
  byMessage: Record<string, { count: number; seeds: number[] }>;
} {
  const byMessage: Record<string, { count: number; seeds: number[] }> = {};
  for (const entry of consoleErrors) {
    const key = entry.message.split('\n')[0]!.slice(0, 160);
    const bucket = (byMessage[key] ??= { count: 0, seeds: [] });
    bucket.count += 1;
    if (entry.seed !== null && bucket.seeds.length < 10) {
      bucket.seeds.push(entry.seed);
    }
  }
  return { total: consoleErrors.length, byMessage };
}

function statusBarStackDepth(): number {
  const bar = StatusBar as unknown as { _propsStack?: unknown[] };
  return bar._propsStack?.length ?? -1;
}

// ─── Driving helpers ─────────────────────────────────────────────────────────

async function flush(): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(0);
  });
  await act(async () => {});
}

function nav() {
  const probe = navigationProbe.current;
  if (!probe) throw new Error('Home stub never received a navigation object');
  return probe;
}

function routeNames(): string[] {
  return nav()
    .getState()
    .routes.map(r => r.name);
}

function allText(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function pressButton(renderer: ReactTestRenderer, label: string): void {
  const candidates = renderer.root.findAll(
    n =>
      typeof n.props.onPress === 'function' &&
      n.findAll(t => t.type === Text && String(t.props.children) === label)
        .length > 0,
  );
  const node = candidates[candidates.length - 1];
  if (!node) throw new Error(`No button labeled ${label}`);
  act(() => node.props.onPress());
}

function readinessEvent(rng: ReturnType<typeof createSeededRng>) {
  return {
    type: 'readiness',
    state: rng.pick(READINESS_STATES),
    poseConfidence: rng.next(),
    jointCoverage: rng.next(),
    stableForMs: rng.int(3000),
    emittedAtIso: new Date(
      1_757_000_000_000 + rng.int(1_000_000),
    ).toISOString(),
  };
}

async function emitEvents(
  rng: ReturnType<typeof createSeededRng>,
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await act(async () => {
      emitNativeCameraEvent(readinessEvent(rng));
    });
  }
}

interface Baseline {
  cameraListeners: number;
  nativeListenerBalance: number;
  timers: number;
  accessSubscribers: number;
  authSubscribers: number;
  statusBarStack: number;
  routeCount: number;
}

function snapshot(): Baseline {
  return {
    cameraListeners: cameraEventListenerCount(),
    nativeListenerBalance: fakeNativeCaptureState.nativeListenerBalance,
    timers: jest.getTimerCount(),
    accessSubscribers: accessSubscribers(),
    authSubscribers: authSubscribers(),
    statusBarStack: statusBarStackDepth(),
    routeCount: routeNames().length,
  };
}

async function openAnalyze(source: 'camera' | 'library'): Promise<void> {
  act(() => nav().navigate('Analyze', { source }));
  await flush();
}

async function closeAnalyze(): Promise<void> {
  act(() => nav().goBack());
  await flush();
}

/** Lets the React Native jest preset's one-shot Animated flush timers
 *  (16 ms, `NativeAnimatedHelper` mock) fire so `jest.getTimerCount()`
 *  compares like with like; anything the screen leaves armed past 50 ms —
 *  and every interval — still counts. */
async function settleFrameworkTimers(ms = 50): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await flush();
}

/** Runs ONE iteration from its seed; returns the record. Never throws for
 *  a held/broken verdict — only for harness bugs. */
async function runIteration(
  renderer: ReactTestRenderer,
  index: number,
  seed: number,
  baseline: Baseline,
): Promise<IterationRecord> {
  currentSeed = seed;
  const rng = createSeededRng(seed);
  const scenario = rng.pick(ACTIVE_SCENARIOS);
  const failures: string[] = [];
  const errorsBefore = consoleErrors.length;
  const cancelBefore = fakeNativeCaptureState.cancelCalls;
  const importsBefore = fakeNativeCaptureState.importCalls;
  let events = 0;
  let expectCancel = 0;

  const source = scenario.startsWith('library') ? 'library' : 'camera';
  const t0 = nowMs();
  await openAnalyze(source);
  const t1 = nowMs();

  if (!routeNames().includes('Analyze')) {
    failures.push(`Analyze route not on stack after navigate: ${routeNames()}`);
  }
  if (source === 'camera') {
    if (cameraEventListenerCount() !== baseline.cameraListeners + 1) {
      failures.push(
        `expected exactly one camera listener while mounted, saw ${cameraEventListenerCount() - baseline.cameraListeners}`,
      );
    }
    if (!allText(renderer).includes('Open automatic camera')) {
      failures.push('camera landing did not render its primary action');
    }
  }

  switch (scenario) {
    case 'idle':
      break;
    case 'stray_events_idle':
      events = 1 + rng.int(8);
      await emitEvents(rng, events);
      break;
    case 'capture_pending_unmount': {
      pressButton(renderer, 'Open automatic camera');
      await flush();
      events = rng.int(13);
      await emitEvents(rng, events);
      if (fakeNativeCaptureState.pendingCaptures.length !== 1) {
        failures.push(
          `expected 1 pending native capture, saw ${fakeNativeCaptureState.pendingCaptures.length}`,
        );
      }
      expectCancel = 1;
      break;
    }
    case 'capture_cancelled': {
      pressButton(renderer, 'Open automatic camera');
      await flush();
      events = rng.int(4);
      await emitEvents(rng, events);
      const pending = fakeNativeCaptureState.pendingCaptures.shift();
      if (!pending) failures.push('no pending native capture to cancel');
      await act(async () => {
        pending?.reject({ code: 'camera.cancelled', message: 'cancelled' });
      });
      await flush();
      if (!allText(renderer).includes('Open automatic camera')) {
        failures.push('user cancel did not return to the camera landing');
      }
      break;
    }
    case 'capture_error': {
      pressButton(renderer, 'Open automatic camera');
      await flush();
      events = rng.int(4);
      await emitEvents(rng, events);
      const pending = fakeNativeCaptureState.pendingCaptures.shift();
      if (!pending) failures.push('no pending native capture to fail');
      await act(async () => {
        pending?.reject(new Error(`Camera session failed (seed ${seed})`));
      });
      await flush();
      if (!allText(renderer).includes('Try again')) {
        failures.push('capture failure did not render the error surface');
      }
      break;
    }
    case 'capture_saved': {
      pressButton(renderer, 'Open automatic camera');
      await flush();
      events = rng.int(6);
      await emitEvents(rng, events);
      const pending = fakeNativeCaptureState.pendingCaptures.shift();
      if (!pending) failures.push('no pending native capture to resolve');
      await act(async () => {
        pending?.resolve(guidedClip(seed));
      });
      await flush();
      await flush();
      if (!allText(renderer).includes('Capture complete')) {
        failures.push(
          `resolved clip did not reach the saved surface; screen text: ${allText(renderer).slice(0, 300)}`,
        );
      }
      break;
    }
    case 'library_leave_before_autolaunch': {
      // The auto-launch timer is armed for 160 ms; leave at a seeded moment
      // strictly before it fires.
      await act(async () => {
        jest.advanceTimersByTime(rng.int(159));
      });
      if (fakeNativeCaptureState.importCalls !== importsBefore) {
        failures.push('library importer launched before its 160 ms timer');
      }
      break;
    }
    case 'library_import_pending_unmount': {
      await act(async () => {
        jest.advanceTimersByTime(200);
      });
      await flush();
      if (fakeNativeCaptureState.pendingImports.length !== 1) {
        failures.push(
          `expected 1 pending native import, saw ${fakeNativeCaptureState.pendingImports.length}`,
        );
      }
      expectCancel = 1;
      break;
    }
  }

  const t2 = nowMs();
  await closeAnalyze();
  const t3 = nowMs();

  // A pending native operation is cancelled on unmount; the native side then
  // rejects the promise like iOS does after `cancel()`.
  const cancels = fakeNativeCaptureState.cancelCalls - cancelBefore;
  if (cancels !== expectCancel) {
    failures.push(`expected ${expectCancel} cancel() call(s), saw ${cancels}`);
  }
  const leftovers = [
    ...fakeNativeCaptureState.pendingCaptures,
    ...fakeNativeCaptureState.pendingImports,
  ];
  fakeNativeCaptureState.pendingCaptures = [];
  fakeNativeCaptureState.pendingImports = [];
  if (leftovers.length !== expectCancel) {
    failures.push(
      `expected ${expectCancel} pending native op(s) at unmount, saw ${leftovers.length}`,
    );
  }
  await act(async () => {
    for (const op of leftovers) {
      op.reject({ code: 'camera.cancelled', message: 'cancelled' });
    }
  });
  await flush();
  await settleFrameworkTimers();
  // The RN jest preset installs `jest.fn()` recorders on the clock
  // (`performance.now = jest.fn(Date.now)`) and on NativeAnimatedModule;
  // every call appends to `mock.calls`/`mock.results` for the life of the
  // file. React's scheduler and Animated hit them thousands of times per
  // mount (~600 KB/iteration retained), which would drown any leak in the
  // unit under test. Clearing call records keeps implementations intact.
  jest.clearAllMocks();

  const after = snapshot();
  const compare = (key: keyof Baseline, label: string) => {
    if (after[key] !== baseline[key]) {
      failures.push(
        `${label} did not return to baseline: ${baseline[key]} → ${after[key]}`,
      );
    }
  };
  compare('cameraListeners', 'camera event listeners');
  compare(
    'nativeListenerBalance',
    'native addListener/removeListeners balance',
  );
  compare('timers', 'pending JS timers');
  compare('accessSubscribers', 'useAccessStore subscribers');
  compare('authSubscribers', 'useAuthStore subscribers');
  compare('statusBarStack', 'StatusBar props stack');
  compare('routeCount', 'navigator route count');
  if (routeNames().includes('Analyze')) {
    failures.push('Analyze route still on the stack after goBack');
  }

  currentSeed = null;
  return {
    index,
    seed,
    scenario,
    events,
    outcome: failures.length === 0 ? 'held' : 'broken',
    failures,
    consoleErrors: consoleErrors
      .slice(errorsBefore)
      .map(e => e.message.split('\n')[0]!.slice(0, 160)),
    mountMs: t1 - t0,
    unmountMs: t3 - t2,
    totalMs: t3 - t0,
    postUnmount: {
      cameraListeners: after.cameraListeners,
      nativeListenerBalance: after.nativeListenerBalance,
      timers: after.timers,
      accessSubscribers: after.accessSubscribers,
      authSubscribers: after.authSubscribers,
      statusBarStack: after.statusBarStack,
      cancelCalls: cancels,
      pendingNativeOps: leftovers.length,
      routeCount: after.routeCount,
    },
  };
}

// ─── Campaign configuration ──────────────────────────────────────────────────

const ITERATIONS = readIntEnv('STRESS_ITER', 60);
const CAMPAIGN_SEED = readIntEnv('STRESS_SEED', 20260904);
const REPLAY_SEEDS = parseSeedList(process.env.STRESS_REPLAY_SEEDS);
const HEAP_EVERY = 50;
const HEAP_SLOPE_LIMIT_PCT_PER_100 = 5;
const TIMING_WINDOW = 50;
const HEAP_SNAPSHOTS = process.env.STRESS_HEAP_SNAPSHOTS === '1';
/** `STRESS_SCENARIOS=idle,capture_saved` restricts the seeded pick to a
 *  subset — the bisection knob for attributing growth to one path. The seed
 *  table still records which scenario each seed ran. */
const ACTIVE_SCENARIOS: readonly Scenario[] = (() => {
  const raw = process.env.STRESS_SCENARIOS;
  if (!raw) return SCENARIOS;
  const wanted = raw.split(',').map(s => s.trim());
  const unknown = wanted.filter(
    s => !(SCENARIOS as readonly string[]).includes(s),
  );
  if (unknown.length > 0) {
    throw new Error(
      `STRESS_SCENARIOS: unknown scenario(s) ${unknown.join(', ')}`,
    );
  }
  return SCENARIOS.filter(s => wanted.includes(s));
})();

const iterationSeeds: number[] =
  REPLAY_SEEDS ??
  Array.from({ length: ITERATIONS }, (_, i) =>
    deriveIterationSeed(CAMPAIGN_SEED, i),
  );

/** An explicit campaign must produce a heap verdict — an unmeasured heap is
 *  not "held". Seed replays and short runs cannot yield ≥3 samples, so they
 *  report the heap table without a verdict. */
const REQUIRE_GC =
  process.env.STRESS_ITER !== undefined &&
  iterationSeeds.length >= 2 * HEAP_EVERY;

const realFetch = globalThis.fetch;
let renderer!: ReactTestRenderer;

beforeAll(async () => {
  // Wall-clock stays real so mount/unmount durations are measurable; every
  // scheduling primitive the screen uses (timers, Date, rAF) is faked.
  jest.useFakeTimers({ doNotFake: ['performance', 'hrtime'] });
  console.error = (...args: unknown[]) => {
    consoleErrors.push({
      seed: currentSeed,
      message: args
        .map(a => (a instanceof Error ? a.message : String(a)))
        .join(' '),
    });
  };
  globalThis.fetch = (async () => {
    throw new Error('no network in the stress lens');
  }) as unknown as typeof fetch;
  kv.clear();
  statementCount = 0;
  resetFakeNativeCaptureCounters();
  usabilityFunnel.reset();
  stabilitySlo.reset();
  setActiveDataOwner(owner);
  establishApiSession({
    apiBaseUrl: 'https://api.stress.test',
    bearerToken: 'stress-bearer',
    canonicalAppUserId: owner,
    provider: 'apple',
  });
  clearAccessStoreConfiguration();
  configureAccessStore(billingDeps());
  useAccessStore.setState({ status: 'ready', canonicalAccess: freeAccess(0) });
  useAuthStore.setState({
    hydrated: true,
    session: syncedSession,
    busy: false,
    error: null,
  });
  await act(async () => {
    renderer = TestRenderer.create(<RootNavigator />);
  });
  await flush();
});

afterAll(() => {
  act(() => renderer.unmount());
  console.error = realConsoleError;
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAccessStore.getState().reset();
  globalThis.fetch = realFetch;
  jest.useRealTimers();
});

describe(`AnalyzeScreen long-run leak — ${iterationSeeds.length} real-navigator open/close iterations (campaign seed ${CAMPAIGN_SEED})`, () => {
  it('returns every listener, timer, subscription and native handle to baseline and holds the heap slope', async () => {
    if (REQUIRE_GC && !gcAvailable()) {
      throw new Error(
        'STRESS_ITER campaigns need `node --expose-gc node_modules/.bin/jest …` so the heap slope is measurable; refusing to report an unmeasured heap as held.',
      );
    }
    expect(routeNames()).toEqual(['Tabs']);

    // One warm-up open/close so module-level lazy caches (navigator route
    // registry, StyleSheet, Animated registries, the navigator's own
    // one-shot timers) settle before the baseline and the first heap sample
    // are taken — a real per-iteration leak still shows over 500 iterations.
    const warmup = await runIteration(
      renderer,
      -1,
      deriveIterationSeed(CAMPAIGN_SEED, 1 << 20),
      snapshot(),
    );
    // `useLinking` arms one 1 s timer on container mount; let it pass so the
    // baseline timer count is the steady state, not the boot state.
    await settleFrameworkTimers(1_100);
    const baseline = snapshot();
    const baselineHandles = openHandleSnapshot();

    const records: IterationRecord[] = [];
    const heap: HeapSample[] = [sampleHeap(0)];
    const handles: { iteration: number; snapshot: OpenHandleSnapshot }[] = [
      { iteration: 0, snapshot: openHandleSnapshot() },
    ];
    const funnelStart = usabilityFunnel.events().length;
    const sloStart = stabilitySlo.events().length;

    for (let i = 0; i < iterationSeeds.length; i += 1) {
      records.push(
        await runIteration(renderer, i, iterationSeeds[i]!, baseline),
      );
      if ((i + 1) % HEAP_EVERY === 0 || i + 1 === iterationSeeds.length) {
        heap.push(sampleHeap(i + 1));
        writeHeapSnapshotArtifact(`analyzeScreen.longRunLeak.iter${i + 1}`);
        handles.push({ iteration: i + 1, snapshot: openHandleSnapshot() });
      }
    }

    const heapVerdict = assessHeapSlope(heap, { warmupSamples: 1 });
    const mountDrift = timingDrift(
      records.map(r => r.mountMs),
      TIMING_WINDOW,
    );
    const unmountDrift = timingDrift(
      records.map(r => r.unmountMs),
      TIMING_WINDOW,
    );
    const totalDrift = timingDrift(
      records.map(r => r.totalMs),
      TIMING_WINDOW,
    );
    const finalHandles = openHandleSnapshot();
    const broken = records.filter(r => r.outcome === 'broken');
    const byScenario = Object.fromEntries(
      SCENARIOS.map(s => [
        s,
        {
          executed: records.filter(r => r.scenario === s).length,
          broken: broken.filter(r => r.scenario === s).length,
        },
      ]),
    );
    const telemetryGrowth = {
      usabilityFunnelEvents: usabilityFunnel.events().length - funnelStart,
      stabilitySloEvents: stabilitySlo.events().length - sloStart,
      perIterationFunnelEvents:
        (usabilityFunnel.events().length - funnelStart) / records.length,
      dbStatements: statementCount,
    };

    const summary = {
      unit: 'scr-analyzescreen',
      lens: 'long-run-leak',
      campaignSeed: CAMPAIGN_SEED,
      replaySeeds: REPLAY_SEEDS,
      iterationsRequested: iterationSeeds.length,
      iterationsExecuted: records.length,
      gcAvailable: gcAvailable(),
      node: process.version,
      warmup,
      baseline,
      baselineHandles,
      finalHandles,
      consoleErrors: summarizeConsoleErrors(),
      heapVerdict,
      heapSlopeLimitPctPer100: HEAP_SLOPE_LIMIT_PCT_PER_100,
      timing: {
        mount: mountDrift,
        unmount: unmountDrift,
        total: totalDrift,
        perturbedByHeapSnapshots: HEAP_SNAPSHOTS,
      },
      byScenario,
      brokenSeeds: broken.map(r => ({
        seed: r.seed,
        scenario: r.scenario,
        failures: r.failures,
      })),
      telemetryGrowth,
    };
    const artifacts = {
      summary: writeStressArtifact(
        'analyzeScreen.longRunLeak.summary.json',
        summary,
      ),
      seeds: writeStressArtifact(
        'analyzeScreen.longRunLeak.seeds.json',
        records,
      ),
      heap: writeStressArtifact('analyzeScreen.longRunLeak.heap.json', heap),
      handles: writeStressArtifact(
        'analyzeScreen.longRunLeak.handles.json',
        handles,
      ),
    };
    if (artifacts.summary) {
      console.log(
        `[stress] ${records.length} iterations; heap ${heapVerdict.assessed ? `${heapVerdict.slopePctPer100Iterations.toFixed(2)}%/100it (monotone=${heapVerdict.monotoneIncreasing})` : 'not assessed'}; mount drift ×${mountDrift.driftRatio.toFixed(2)}; artifacts in ${process.env.STRESS_OUT}`,
      );
    }

    // ── Verdicts ──────────────────────────────────────────────────────────
    expect(records.length).toBe(iterationSeeds.length);
    expect(
      broken.map(r => `${r.seed}:${r.scenario}:${r.failures.join('|')}`),
    ).toEqual([]);

    // Process-level handles never grow with the campaign.
    expect(finalHandles.handles).toBeLessThanOrEqual(baselineHandles.handles);
    expect(finalHandles.requests).toBeLessThanOrEqual(baselineHandles.requests);

    if (heapVerdict.assessed) {
      const leaking =
        heapVerdict.monotoneIncreasing &&
        heapVerdict.slopePctPer100Iterations > HEAP_SLOPE_LIMIT_PCT_PER_100;
      expect({
        leaking,
        slopePctPer100Iterations: heapVerdict.slopePctPer100Iterations,
        monotoneIncreasing: heapVerdict.monotoneIncreasing,
        totalGrowthPct: heapVerdict.totalGrowthPct,
      }).toEqual(expect.objectContaining({ leaking: false }));
    } else if (REQUIRE_GC) {
      throw new Error(`heap slope not assessed: ${heapVerdict.reason}`);
    }

    // Render/invocation time must not degrade as the process ages. Writing a
    // heap snapshot flushes V8's compiled code, so in attribution mode the
    // timings are still recorded but are not a verdict on the unit.
    if (records.length >= 2 * TIMING_WINDOW && !HEAP_SNAPSHOTS) {
      expect(totalDrift.driftRatio).toBeLessThan(2);
    }
  });
});
