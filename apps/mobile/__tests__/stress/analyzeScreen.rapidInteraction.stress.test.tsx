/**
 * STRESS — unit `scr-analyzescreen`, lens `rapid-interaction`.
 *
 * The REAL RootNavigator (real @react-navigation NavigationContainer, real
 * native-stack + bottom-tabs routers, the real `AnalyzeRoute` access gate) is
 * rendered with the real AnalyzeScreen, real access store and real design
 * components. Only native seams (camera bridge, SQLite, safe-area, SVG, the
 * analysis pipeline that talks to the server) and the OTHER screens are
 * mocked; navigation state is read from the container ref, so "one
 * navigation per intent" is asserted against the router's route list, not a
 * jest.fn.
 *
 * Every iteration is one seed. A seeded generator picks a scenario family
 * and its parameters (tap counts, tap spacing, chip order, capture/analysis
 * outcome) and drives the screen through bursts of double/triple taps,
 * taps during transitions, simultaneous controls, back-during-async and
 * navigation spam, then asserts:
 *   - one capture per capture intent, one permit-reserving analysis call per
 *     scoring intent, one access refresh per touched ledger, one navigation
 *     per routing intent (exactly one Result / Paywall / Analyze route);
 *   - no orphan loading surface (no "Opening camera…"/"Measuring…" text
 *     left behind once the flow settled) and never two surfaces at once;
 *   - no duplicate modal (free-limit prompt) and exactly one alert;
 *   - no act() warnings, no unexpected console.error, no unhandled promise
 *     rejections, no leaked camera-event subscription after unmount.
 *
 * Replay:  STRESS_SEED=<n>[,<m>…] npx jest --ci stress/analyzeScreen.rapidInteraction
 * Flake check: STRESS_SEED=<n> STRESS_REPEAT=10 npx jest …
 * Campaign: STRESS_ITER=300 STRESS_OUT=artifacts/stress/<name>.json npx jest …
 * Default STRESS_ITER is 12 so the suite stays cheap in the regular run.
 *
 * Tap-timing model: `same_tick` delivers every onPress inside ONE act (two
 * fingers / no re-render between taps) — stricter than RN's single-responder
 * touch system; `microtask` and `timer` re-render between taps.
 */
jest.mock('../../src/data/db', () => ({ getDb: () => mockCurrentDb() }));
jest.mock('../../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: jest.fn(),
}));
jest.mock('../../src/data/syncRuntime', () => ({
  triggerOutboxSync: jest.fn(),
}));

type CameraListener = (event: CameraEvent) => void;
const mockCameraListeners = new Set<CameraListener>();

jest.mock('../../src/camera/capture', () => {
  const actual = jest.requireActual('../../src/camera/capture');
  return {
    ...actual,
    captureStrokeVideo: jest.fn(),
    importStrokeVideo: jest.fn(),
    cancelCameraOperation: jest.fn(),
    importedPoseExtractionAvailable: jest.fn(() => true),
    extractImportedPoseSequence: jest.fn(),
    subscribeToCameraEvents: (listener: CameraListener) => {
      mockCameraListeners.add(listener);
      return () => mockCameraListeners.delete(listener);
    },
  };
});
jest.mock('../../src/camera/TargetSelector', () => ({
  TargetSelector: () => null,
}));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
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
    Ellipse: Mock,
    G: Mock,
    Line: Mock,
    Path: Mock,
    Polygon: Mock,
    Polyline: Mock,
    Rect: Mock,
    Defs: Mock,
    LinearGradient: Mock,
    RadialGradient: Mock,
    Stop: Mock,
  };
});

// The navigation library is REAL; this passthrough only captures the
// container ref RootNavigator creates so the router state can be read.
// (imports are hoisted above module constants, so the store lives on
// globalThis rather than in a `const` the factory would see as undefined.)
type NavRefStore = {
  __stressNavRefs?: NavigationContainerRefWithCurrent<RootStackParams>[];
};
function mockNavRefStore(): NavigationContainerRefWithCurrent<RootStackParams>[] {
  const store = globalThis as typeof globalThis & NavRefStore;
  store.__stressNavRefs ??= [];
  return store.__stressNavRefs;
}
jest.mock('@react-navigation/native', () => {
  const actual = jest.requireActual('@react-navigation/native');
  return {
    ...actual,
    createNavigationContainerRef: () => {
      const ref = actual.createNavigationContainerRef();
      mockNavRefStore().push(ref);
      return ref;
    },
  };
});

// Screens OTHER than AnalyzeScreen are stubs: Home exposes the production
// "Analyze" CTA (HomeScreen.tsx: navigate('Analyze', { source: 'camera' }))
// plus the tab bar's import entry; Result/Paywall render a marker so their
// presence in the tree is observable.
jest.mock('../../src/screens/HomeScreen', () => {
  const React = require('react');
  const { Text, View } = require('react-native');
  const { useNavigation } = require('@react-navigation/native');
  return {
    HomeScreen: () => {
      const navigation = useNavigation();
      return React.createElement(
        View,
        null,
        React.createElement(
          Text,
          {
            accessibilityRole: 'button',
            accessibilityLabel: 'Stress: open Analyze',
            onPress: () => navigation.navigate('Analyze', { source: 'camera' }),
          },
          'Stress: open Analyze',
        ),
        React.createElement(
          Text,
          {
            accessibilityRole: 'button',
            accessibilityLabel: 'Stress: open Import',
            onPress: () =>
              navigation.navigate('Analyze', { source: 'library' }),
          },
          'Stress: open Import',
        ),
      );
    },
  };
});
jest.mock('../../src/screens/ResultScreen', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const { useRoute } = require('@react-navigation/native');
  return {
    ResultScreen: () => {
      const route = useRoute();
      const params = (route.params ?? {}) as { analysisId?: string };
      return React.createElement(
        Text,
        { testID: 'stress-result' },
        `stress-result:${params.analysisId ?? '?'}`,
      );
    },
  };
});
jest.mock('../../src/screens/PaywallScreen', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    PaywallScreen: () =>
      React.createElement(Text, { testID: 'stress-paywall' }, 'stress-paywall'),
  };
});
jest.mock('../../src/screens/LibraryScreen', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    LibraryScreen: () =>
      React.createElement(Text, { testID: 'stress-library' }, 'stress-library'),
  };
});
jest.mock('../../src/screens/ProgressScreen', () => ({
  ProgressScreen: () => null,
}));
jest.mock('../../src/screens/SettingsScreen', () => ({
  SettingsScreen: () => null,
}));
jest.mock('../../src/screens/DrillLibraryScreen', () => ({
  DrillLibraryScreen: () => null,
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
jest.mock('../../src/screens/SignInScreen', () => ({
  SignInScreen: () => null,
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
import { Modal, Text } from 'react-native';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import type {
  NavigationContainerRefWithCurrent,
  NavigationState,
} from '@react-navigation/native';
import { RootNavigator } from '../../src/navigation/RootNavigator';
import type { RootStackParams } from '../../src/navigation/params';
import {
  assertCapturedClip,
  cancelCameraOperation,
  captureStrokeVideo,
  importStrokeVideo,
  type CameraEvent,
  type CapturedClip,
} from '../../src/camera/capture';
import {
  runCaptureAnalysis,
  type CaptureAnalysisOutcome,
  type RunCaptureAnalysisRequest,
} from '../../src/analysis/runCaptureAnalysis';
import type { LocalDb } from '../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';
import type {
  BillingAccessDependencies,
  CanonicalAccessState,
} from '../../src/billing/types';
import { SeededRng, campaignSeeds } from './rapidInteraction/seededRng';
import {
  CampaignReporter,
  type IterationRecord,
} from './rapidInteraction/report';

// ─── Recording LocalDb ───────────────────────────────────────────────────────

interface Statement {
  sql: string;
  params: unknown[];
}
let statements: Statement[] = [];
const kv = new Map<string, string>();
const recordingDb: LocalDb = {
  async execute(sql: string, params: unknown[] = []) {
    statements.push({ sql, params });
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

const owner = '55555555-5555-4555-8555-555555555555';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const importedClip = assertCapturedClip({
  uri: 'file:///private/var/mobile/import.mov',
  durationMs: 4200,
  fps: 30,
  width: 1920,
  height: 1080,
  capturedAtIso: '2026-09-04T12:00:00.000Z',
  captureMode: 'imported_video',
  recognition: { status: 'unknown', reason: 'analysis_not_run' },
  ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
});

function guidedClip(): CapturedClip {
  return {
    uri: 'file:///captures/guided.mov',
    durationMs: 4200,
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
      startMs: 2000,
      endMs: 2700,
      peakMotionMs: 2400,
      confidence: 0.86,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    targetSeed: { x: 0.5, y: 0.6, source: 'live_camera_tap' },
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
      trackedDurationMs: 4200,
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
    preRollMs: 2000,
    postRollMs: 1500,
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: 'file:///captures/guided.pose.json',
      frameCount: 120,
      sha256: 'cd'.repeat(32),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
}

type ScoredRecord = Extract<
  CaptureAnalysisOutcome,
  { kind: 'scored' }
>['record'];

type OutcomeKind =
  | 'scored'
  | 'scored_free_limit'
  | 'low_confidence'
  | 'unavailable'
  | 'unavailable_paywall'
  | 'quality_blocked'
  | 'throws';

// Minimal records shaped like the pipeline's (mirrors wf/AnalyzeScreen.buttons):
// the screen reads `strokeIntent.resolutionBasis` and `result`.
const scoredRecord = {
  result: { shotType: 'forehand_drive' },
  strokeIntent: { resolutionBasis: 'declared', disagreement: null },
} as unknown as ScoredRecord;
const abstainedRecord = {
  result: { shotType: 'forehand_drive' },
  strokeIntent: { resolutionBasis: 'abstained' },
} as unknown as ScoredRecord;
const abstainedNoResultRecord = {
  result: null,
  strokeIntent: { resolutionBasis: 'abstained' },
} as unknown as ScoredRecord;

function outcomeFor(kind: OutcomeKind, seed: number): CaptureAnalysisOutcome {
  const analysisId = `analysis-stress-${seed}`;
  switch (kind) {
    case 'scored':
      return {
        kind: 'scored',
        analysisId,
        record: scoredRecord,
        freeLimitReached: false,
      };
    case 'scored_free_limit':
      return {
        kind: 'scored',
        analysisId,
        record: scoredRecord,
        freeLimitReached: true,
      };
    case 'low_confidence':
      return {
        kind: 'low_confidence',
        analysisId,
        record: seed % 2 === 0 ? abstainedRecord : abstainedNoResultRecord,
        guidance: null,
      };
    case 'unavailable':
      return { kind: 'unavailable', reason: 'The analysis server is busy.' };
    case 'unavailable_paywall':
      return {
        kind: 'unavailable',
        reason: 'Your free analyses are used up.',
        cause: 'paywall_required',
      };
    case 'quality_blocked':
      return {
        kind: 'quality_blocked',
        reason: 'Full body was not visible for the whole swing.',
        envelope: null,
      };
    case 'throws':
      throw new Error('stress: analysis pipeline threw');
  }
}

function freeAccess(used: number, reserved = 0): CanonicalAccessState {
  const remaining = 2 - used;
  const availableToReserve = remaining - reserved;
  return {
    premium: false,
    entitlements: [],
    freeRatings: { limit: 2, used, reserved, remaining, availableToReserve },
    canStartRating: availableToReserve > 0,
    paywallRequired: availableToReserve <= 0,
  };
}

function backendReturning(
  getAccess: () => Promise<CanonicalAccessState>,
): BillingAccessDependencies {
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => {
        throw new Error('plans are not part of this test');
      }),
      purchase: jest.fn(),
      restore: jest.fn(),
      readEntitlement: jest.fn(),
    },
    backend: { getAccess: jest.fn(getAccess), syncBilling: jest.fn() },
  };
}

// ─── Chips (TechniqueIntentPicker radio labels → legacy slug) ────────────────

const CHIPS: ReadonlyArray<{ label: string; slug: string | null }> = [
  { label: 'Forehand Drive', slug: 'forehand_drive' },
  { label: 'Backhand Drive', slug: 'backhand_drive' },
  { label: 'Forehand Dink', slug: 'dink' },
  { label: 'Serve', slug: 'serve' },
  { label: 'Third-Shot Drop', slug: 'third_shot_drop' },
  { label: 'Overhead', slug: 'overhead' },
  { label: 'Auto detect', slug: null },
];

/** Saved-phase `StrokeDeclaration` radio labels (STROKE_LABELS) → slug. */
const SAVED_CHIPS: ReadonlyArray<{ label: string; slug: string }> = [
  { label: 'Serve', slug: 'serve' },
  { label: 'Return', slug: 'return' },
  { label: 'Forehand drive', slug: 'forehand_drive' },
  { label: 'Backhand drive', slug: 'backhand_drive' },
  { label: 'Third-shot drop', slug: 'third_shot_drop' },
  { label: 'Dink', slug: 'dink' },
  { label: 'Volley', slug: 'volley' },
  { label: 'Overhead', slug: 'overhead' },
];

// ─── Tree queries ────────────────────────────────────────────────────────────

function renderedText(renderer: ReactTestRenderer): string {
  const collect = (node: unknown): string => {
    if (node == null) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(collect).join('\n');
    const json = node as { children?: unknown[] };
    return (json.children ?? []).map(collect).join('\n');
  };
  return collect(renderer.toJSON());
}

function countText(renderer: ReactTestRenderer, needle: string): number {
  return renderedText(renderer).split(needle).length - 1;
}

function matchesLabel(node: ReactTestInstance, label: string): boolean {
  if (typeof node.props.onPress !== 'function') return false;
  if (node.props.accessibilityLabel === label) return true;
  const children = node.props.children;
  if (typeof children === 'string') return children === label;
  return node
    .findAll(t => t.type === Text)
    .some(t => String(t.props.children) === label);
}

/** Innermost enabled pressable carrying `label` (a11y label or button text). */
function findPressable(
  renderer: ReactTestRenderer,
  label: string,
): ReactTestInstance | null {
  const matches = renderer.root.findAll(n => matchesLabel(n, label));
  const leaves = matches.filter(
    n => n.findAll(m => m !== n && matchesLabel(m, label)).length === 0,
  );
  const enabled = leaves.filter(
    n =>
      n.props.disabled !== true &&
      n.props.accessibilityState?.disabled !== true,
  );
  return enabled[enabled.length - 1] ?? null;
}

/** Number of mounted AnalyzeScreen surfaces (host node of its mascot). */
function analyzeSurfaceCount(renderer: ReactTestRenderer): number {
  return renderer.root.findAll(
    n =>
      typeof n.type === 'string' &&
      typeof n.props.testID === 'string' &&
      n.props.testID.startsWith('analysis-mascot-'),
  ).length;
}

/** Mounted `working`-phase surfaces: the camera/import mascot stage OR the
 * analyzing arc (`StrokeResultAnalyzing`) the Measuring/Reading stages use. */
function workingSurfaceCount(renderer: ReactTestRenderer): number {
  return renderer.root.findAll(
    n =>
      typeof n.type === 'string' &&
      (n.props.testID === 'analysis-mascot-working' ||
        n.props.testID === 'stroke-result-analyzing'),
  ).length;
}

function alertCount(renderer: ReactTestRenderer): number {
  return renderer.root.findAll(
    n => n.props.accessibilityRole === 'alert' && typeof n.type === 'string',
  ).length;
}

function visibleModalCount(renderer: ReactTestRenderer): number {
  return renderer.root
    .findAllByType(Modal)
    .filter(m => m.props.visible !== false).length;
}

function selectedRadios(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAll(
      n =>
        n.props.accessibilityRole === 'radio' &&
        n.props.accessibilityState?.selected === true &&
        typeof n.props.onPress === 'function' &&
        typeof n.type !== 'string',
    )
    .map(n => String(n.props.accessibilityLabel))
    .filter((label, index, all) => all.indexOf(label) === index);
}

// ─── Timing / bursts ─────────────────────────────────────────────────────────

type TapMode =
  { kind: 'same_tick' } | { kind: 'microtask' } | { kind: 'timer'; ms: number };

function pickMode(rng: SeededRng): TapMode {
  return rng.weighted<TapMode>([
    [{ kind: 'same_tick' }, 4],
    [{ kind: 'microtask' }, 3],
    [{ kind: 'timer', ms: rng.pick([1, 16, 50, 120]) }, 3],
  ]);
}

async function flush() {
  await act(async () => {
    jest.advanceTimersByTime(0);
  });
  await act(async () => {});
}

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await act(async () => {});
}

interface BurstResult {
  fired: number;
  missed: number;
}

/**
 * Taps `label` `count` times. `same_tick` fires every tap inside ONE act
 * (the two-finger / same-frame model: React has not re-rendered between
 * taps, so guards must be refs, not state); `microtask` re-renders between
 * taps; `timer` also advances fake time. A tap whose target is no longer
 * on screen is a miss (a real finger would hit nothing).
 */
async function burst(
  renderer: ReactTestRenderer,
  label: string,
  count: number,
  mode: TapMode,
): Promise<BurstResult> {
  const result: BurstResult = { fired: 0, missed: 0 };
  if (mode.kind === 'same_tick') {
    await act(async () => {
      for (let i = 0; i < count; i += 1) {
        const node = findPressable(renderer, label);
        if (!node) {
          result.missed += 1;
          continue;
        }
        node.props.onPress();
        result.fired += 1;
      }
    });
    return result;
  }
  for (let i = 0; i < count; i += 1) {
    await act(async () => {
      const node = findPressable(renderer, label);
      if (!node) {
        result.missed += 1;
        return;
      }
      node.props.onPress();
      result.fired += 1;
    });
    if (mode.kind === 'timer') await advance(mode.ms);
    else await flush();
  }
  return result;
}

/** Fires several DIFFERENT controls inside one act — simultaneous fingers. */
async function simultaneous(
  renderer: ReactTestRenderer,
  labels: readonly string[],
): Promise<Record<string, boolean>> {
  const fired: Record<string, boolean> = {};
  await act(async () => {
    for (const label of labels) {
      const node = findPressable(renderer, label);
      fired[label] = node !== null;
      node?.props.onPress();
    }
  });
  return fired;
}

// ─── Deferred mocks ──────────────────────────────────────────────────────────

interface Deferred<T> {
  resolve: (value: T) => Promise<void>;
  reject: (error: unknown) => Promise<void>;
  readonly pending: number;
}

/** Every call to `mock` returns a fresh pending promise; the controller
 * settles the OLDEST unsettled one. */
function deferredQueue<T>(mock: jest.Mock): Deferred<T> {
  const settlers: Array<{
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
  }> = [];
  mock.mockImplementation(
    () =>
      new Promise<T>((resolve, reject) => {
        settlers.push({ resolve, reject });
      }),
  );
  return {
    get pending() {
      return settlers.length;
    },
    resolve: async value => {
      const next = settlers.shift();
      await act(async () => {
        next?.resolve(value);
      });
      await flush();
    },
    reject: async error => {
      const next = settlers.shift();
      await act(async () => {
        next?.reject(error);
      });
      await flush();
    },
  };
}

function userCancel(): Error {
  return Object.assign(new Error('Camera capture was canceled.'), {
    code: 'camera.cancelled',
  });
}

// ─── World ───────────────────────────────────────────────────────────────────

const captureMock = captureStrokeVideo as jest.Mock;
const importMock = importStrokeVideo as jest.Mock;
const cancelMock = cancelCameraOperation as jest.Mock;
const analysisMock = runCaptureAnalysis as jest.Mock;

let clients: BillingAccessDependencies;
let consoleErrors: string[] = [];
let unhandled: string[] = [];
const realConsoleError = console.error;
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason instanceof Error ? reason.message : String(reason));
};

function navRef(): NavigationContainerRefWithCurrent<RootStackParams> {
  const ref = mockNavRefStore()[0];
  if (!ref) throw new Error('RootNavigator did not create its container ref');
  return ref;
}

function rootRoutes(): NavigationState<RootStackParams>['routes'] {
  const ref = navRef();
  if (!ref.isReady()) return [];
  const state = ref.getRootState();
  return state ? (state as NavigationState<RootStackParams>).routes : [];
}

function routes(): string[] {
  return rootRoutes().map(route => route.name);
}

/** Route names with their keys — distinguishes a replaced route from a
 * duplicate push of the same name. */
function routesDetailed(): string[] {
  return rootRoutes().map(
    route =>
      `${route.name}#${route.key.slice(-6)}:${JSON.stringify(route.params ?? null)}`,
  );
}

function count<T>(items: readonly T[], value: T): number {
  return items.filter(item => item === value).length;
}

async function mountApp(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<RootNavigator />);
  });
  await flush();
  return renderer;
}

async function unmountApp(renderer: ReactTestRenderer) {
  await act(async () => renderer.unmount());
  await flush();
  await flush();
}

function analysisRequests(): RunCaptureAnalysisRequest[] {
  return analysisMock.mock.calls.map(
    call => call[0] as RunCaptureAnalysisRequest,
  );
}

function refreshCount(): number {
  return (clients.backend.getAccess as jest.Mock).mock.calls.length;
}

// ─── Scenario drivers ────────────────────────────────────────────────────────

interface Ctx {
  seed: number;
  rng: SeededRng;
  renderer: ReactTestRenderer;
  params: Record<string, unknown>;
  checks: Record<string, boolean>;
  observed: Record<string, unknown>;
}

function check(ctx: Ctx, name: string, held: boolean, detail?: unknown) {
  ctx.checks[name] = held;
  if (detail !== undefined) ctx.observed[name] = detail;
}

/** Home → Analyze through the production CTA, optionally spammed. */
async function openAnalyze(ctx: Ctx, source: 'camera' | 'library') {
  const label =
    source === 'camera' ? 'Stress: open Analyze' : 'Stress: open Import';
  const taps = ctx.rng.weighted([
    [1, 4],
    [2, 3],
    [3, 2],
    [5, 1],
  ]);
  const mode = pickMode(ctx.rng);
  ctx.params.openTaps = taps;
  ctx.params.openMode = mode;
  await burst(ctx.renderer, label, taps, mode);
  await flush();
  const r = routes();
  check(ctx, 'nav.exactlyOneAnalyzeRoute', count(r, 'Analyze') === 1, r);
  check(
    ctx,
    'nav.analyzeMountedOnce',
    analyzeSurfaceCount(ctx.renderer) <= 1,
    analyzeSurfaceCount(ctx.renderer),
  );
}

/** Rapid chip taps; the LAST tap decides the declaration. */
async function tapChips(ctx: Ctx): Promise<string | null> {
  const taps = ctx.rng.int(1, 4);
  const mode = pickMode(ctx.rng);
  const sequence = Array.from({ length: taps }, () => ctx.rng.pick(CHIPS));
  ctx.params.chipTaps = sequence.map(c => c.label);
  ctx.params.chipMode = mode;
  if (mode.kind === 'same_tick') {
    await act(async () => {
      for (const chip of sequence) {
        findPressable(ctx.renderer, chip.label)?.props.onPress();
      }
    });
  } else {
    for (const chip of sequence) {
      await act(async () => {
        findPressable(ctx.renderer, chip.label)?.props.onPress();
      });
      if (mode.kind === 'timer') await advance(mode.ms);
      else await flush();
    }
  }
  await flush();
  const last = sequence[sequence.length - 1]!;
  const selected = selectedRadios(ctx.renderer);
  check(
    ctx,
    'chips.lastTapWinsExactlyOneSelected',
    selected.length === 1 && selected[0] === last.label,
    { selected, expected: last.label },
  );
  return last.slug;
}

function settledSurfaceChecks(ctx: Ctx, prefix: string) {
  const r = ctx.renderer;
  check(
    ctx,
    `${prefix}.noOrphanLoading`,
    workingSurfaceCount(r) === 0 &&
      countText(r, 'Opening camera…') === 0 &&
      countText(r, 'Opening video library…') === 0 &&
      countText(r, 'Measuring your swing') === 0 &&
      countText(r, 'Reading player movement') === 0,
    { working: workingSurfaceCount(r), text: renderedText(r).slice(0, 400) },
  );
  check(ctx, `${prefix}.atMostOneAlert`, alertCount(r) <= 1, alertCount(r));
  check(
    ctx,
    `${prefix}.atMostOneModal`,
    visibleModalCount(r) <= 1,
    visibleModalCount(r),
  );
}

/** After the analysis outcome landed, route the terminal surface with more
 * bursts and assert exactly-one navigation per intent. */
async function driveTerminal(ctx: Ctx, kind: OutcomeKind, analysisId: string) {
  const r = ctx.renderer;
  const taps = ctx.rng.int(2, 4);
  const mode = pickMode(ctx.rng);
  ctx.params.terminalTaps = taps;
  ctx.params.terminalMode = mode;
  switch (kind) {
    case 'scored': {
      const now = routes();
      check(
        ctx,
        'scored.replacedWithOneResult',
        count(now, 'Result') === 1 && count(now, 'Analyze') === 0,
        now,
      );
      check(
        ctx,
        'scored.resultCarriesAnalysisId',
        countText(r, `stress-result:${analysisId}`) === 1,
      );
      return;
    }
    case 'scored_free_limit': {
      check(
        ctx,
        'freeLimit.exactlyOneModal',
        visibleModalCount(r) === 1,
        visibleModalCount(r),
      );
      check(
        ctx,
        'freeLimit.promptShownOnce',
        countText(r, 'That was your last free analysis.') === 1,
      );
      const button = ctx.rng.pick([
        'See my score',
        'Upgrade to Pro',
        'Close',
      ] as const);
      ctx.params.freeLimitButton = button;
      const fired = await burst(r, button, taps, mode);
      ctx.observed.freeLimitBurst = fired;
      await flush();
      const now = routes();
      check(
        ctx,
        'freeLimit.exactlyOneResult',
        count(now, 'Result') === 1 && count(now, 'Analyze') === 0,
        routesDetailed(),
      );
      check(
        ctx,
        'freeLimit.atMostOnePaywall',
        count(now, 'Paywall') === (button === 'Upgrade to Pro' ? 1 : 0),
        now,
      );
      check(ctx, 'freeLimit.modalGone', visibleModalCount(r) === 0);
      return;
    }
    case 'low_confidence': {
      // Presentation-less low-confidence records route straight to Result;
      // records with a presentation show the analyzed surface with one CTA.
      const now = routes();
      if (count(now, 'Result') === 1) {
        check(ctx, 'lowConfidence.oneResult', count(now, 'Analyze') === 0, now);
        return;
      }
      check(
        ctx,
        'lowConfidence.analyzedSurfaceOnce',
        countText(r, 'Stroke analysis') === 1,
      );
      if (findPressable(r, 'See the full read')) {
        const fired = await burst(r, 'See the full read', taps, mode);
        ctx.observed.analyzedBurst = fired;
        const after = routes();
        check(
          ctx,
          'lowConfidence.oneResultAfterBurst',
          count(after, 'Result') === 1 && count(after, 'Analyze') === 0,
          after,
        );
        return;
      }
      // Abstained with result:null → no read to open; Close must pop once.
      const fired = await burst(r, 'Close', taps, mode);
      ctx.observed.analyzedBurst = fired;
      const after = routes();
      check(
        ctx,
        'lowConfidence.closePopsOnce',
        count(after, 'Result') === 0 &&
          count(after, 'Analyze') === 0 &&
          after.length === 1,
        after,
      );
      return;
    }
    case 'unavailable':
    case 'quality_blocked':
    case 'throws': {
      check(ctx, 'error.exactlyOneAlert', alertCount(r) === 1, alertCount(r));
      check(
        ctx,
        'error.nothingRatedCopy',
        countText(r, 'Nothing was rated.') === 1,
      );
      const before = captureMock.mock.calls.length;
      const retry = ctx.rng.bool(0.7);
      ctx.params.errorAction = retry ? 'Try again' : 'Close';
      if (retry) {
        const capture = deferredQueue<CapturedClip>(captureMock);
        const fired = await burst(r, 'Try again', taps, mode);
        ctx.observed.retryBurst = fired;
        check(
          ctx,
          'error.tryAgainOneCapture',
          captureMock.mock.calls.length - before === 1,
          captureMock.mock.calls.length - before,
        );
        check(
          ctx,
          'error.oneWorkingSurface',
          workingSurfaceCount(r) === 1 && countText(r, 'Opening camera…') === 1,
          workingSurfaceCount(r),
        );
        await capture.reject(userCancel());
        check(
          ctx,
          'error.cancelReturnsToReady',
          findPressable(r, 'Open automatic camera') !== null &&
            alertCount(r) === 0,
        );
      } else {
        await burst(r, 'Close', taps, mode);
        const now = routes();
        check(
          ctx,
          'error.closePopsOnce',
          count(now, 'Analyze') === 0 && now.length === 1,
          now,
        );
      }
      return;
    }
    case 'unavailable_paywall': {
      check(ctx, 'paywall.exactlyOneAlert', alertCount(r) === 1, alertCount(r));
      const fired = await burst(r, 'Upgrade to Pro', taps, mode);
      ctx.observed.paywallBurst = fired;
      const now = routes();
      check(
        ctx,
        'paywall.exactlyOnePaywallRoute',
        count(now, 'Paywall') === 1,
        now,
      );
      return;
    }
  }
}

/** S1: chips → "Open automatic camera" burst → zero-touch scoring → terminal. */
async function scenarioOpenCameraBurst(ctx: Ctx) {
  await openAnalyze(ctx, 'camera');
  const slug = await tapChips(ctx);
  const capture = deferredQueue<CapturedClip>(captureMock);
  const analysis = deferredQueue<CaptureAnalysisOutcome>(analysisMock);
  const taps = ctx.rng.int(2, 5);
  const mode = pickMode(ctx.rng);
  ctx.params.openCameraTaps = taps;
  ctx.params.openCameraMode = mode;
  const fired = await burst(ctx.renderer, 'Open automatic camera', taps, mode);
  ctx.observed.openCameraBurst = fired;
  check(
    ctx,
    'capture.exactlyOne',
    captureMock.mock.calls.length === 1,
    captureMock.mock.calls.length,
  );
  check(
    ctx,
    'capture.oneWorkingSurface',
    workingSurfaceCount(ctx.renderer) === 1 &&
      countText(ctx.renderer, 'Opening camera…') === 1,
    workingSurfaceCount(ctx.renderer),
  );
  check(
    ctx,
    'capture.pickerGone',
    findPressable(ctx.renderer, 'Forehand Drive') === null,
  );

  const backDuringAnalysis = ctx.rng.bool(0.3);
  ctx.params.backDuringAnalysis = backDuringAnalysis;
  await capture.resolve(guidedClip());
  await flush();
  check(
    ctx,
    'permit.exactlyOneAnalysis',
    analysisMock.mock.calls.length === 1,
    analysisMock.mock.calls.length,
  );
  const request = analysisRequests()[0];
  check(
    ctx,
    'permit.declarationMatchesLastChip',
    request?.declaredStroke === slug,
    { got: request?.declaredStroke, expected: slug },
  );
  check(
    ctx,
    'analysis.oneMeasuringSurface',
    workingSurfaceCount(ctx.renderer) === 1 &&
      countText(ctx.renderer, 'Measuring your swing') >= 1,
    {
      working: workingSurfaceCount(ctx.renderer),
      text: renderedText(ctx.renderer).slice(0, 300),
    },
  );

  const outcomeKind = ctx.rng.weighted<OutcomeKind>([
    ['scored', 4],
    ['scored_free_limit', 3],
    ['low_confidence', 1],
    ['unavailable', 1],
    ['unavailable_paywall', 1],
    ['quality_blocked', 1],
    ['throws', 1],
  ]);
  ctx.params.outcome = outcomeKind;

  if (backDuringAnalysis) {
    const closeTaps = ctx.rng.int(1, 4);
    const closeMode = pickMode(ctx.rng);
    ctx.params.closeTaps = closeTaps;
    ctx.params.closeMode = closeMode;
    const closed = await burst(ctx.renderer, 'Close', closeTaps, closeMode);
    ctx.observed.closeBurst = closed;
    const now = routes();
    check(
      ctx,
      'back.analyzePoppedOnce',
      count(now, 'Analyze') === 0 && now.length === 1,
      now,
    );
    check(
      ctx,
      'back.noRefreshBeforeSettle',
      refreshCount() === 0,
      refreshCount(),
    );
    if (outcomeKind === 'throws')
      await analysis.reject(new Error('stress: analysis threw'));
    else await analysis.resolve(outcomeFor(outcomeKind, ctx.seed));
    await flush();
    const after = routes();
    check(
      ctx,
      'back.noResultAfterAbandon',
      count(after, 'Result') === 0 && count(after, 'Analyze') === 0,
      after,
    );
    check(
      ctx,
      'back.refreshExactlyOnceAfterSettle',
      refreshCount() === 1,
      refreshCount(),
    );
    check(ctx, 'back.permitStillOne', analysisMock.mock.calls.length === 1);
    return;
  }

  if (outcomeKind === 'throws')
    await analysis.reject(new Error('stress: analysis threw'));
  else await analysis.resolve(outcomeFor(outcomeKind, ctx.seed));
  await flush();
  settledSurfaceChecks(ctx, 'settled');
  await driveTerminal(ctx, outcomeKind, `analysis-stress-${ctx.seed}`);
  check(
    ctx,
    'permit.stillExactlyOne',
    analysisMock.mock.calls.length === 1,
    analysisMock.mock.calls.length,
  );
}

/** S2: capture rejects (user cancel or failure) under a tap burst. */
async function scenarioCaptureRejects(ctx: Ctx) {
  await openAnalyze(ctx, 'camera');
  await tapChips(ctx);
  const capture = deferredQueue<CapturedClip>(captureMock);
  const taps = ctx.rng.int(2, 4);
  const mode = pickMode(ctx.rng);
  ctx.params.openCameraTaps = taps;
  ctx.params.openCameraMode = mode;
  await burst(ctx.renderer, 'Open automatic camera', taps, mode);
  check(
    ctx,
    'capture.exactlyOne',
    captureMock.mock.calls.length === 1,
    captureMock.mock.calls.length,
  );
  const cancelled = ctx.rng.bool(0.5);
  ctx.params.rejection = cancelled
    ? 'camera.cancelled'
    : 'camera.session_failed';
  await capture.reject(
    cancelled
      ? userCancel()
      : Object.assign(new Error('The camera session failed to start.'), {
          code: 'camera.session_failed',
        }),
  );
  settledSurfaceChecks(ctx, 'settled');
  if (cancelled) {
    check(
      ctx,
      'cancel.readyAgainNoAlert',
      findPressable(ctx.renderer, 'Open automatic camera') !== null &&
        alertCount(ctx.renderer) === 0,
    );
    check(
      ctx,
      'cancel.stillOnAnalyze',
      count(routes(), 'Analyze') === 1,
      routes(),
    );
  } else {
    check(ctx, 'error.exactlyOneAlert', alertCount(ctx.renderer) === 1);
    check(
      ctx,
      'error.tryAgainOffered',
      findPressable(ctx.renderer, 'Try again') !== null,
    );
  }
  check(ctx, 'permit.none', analysisMock.mock.calls.length === 0);
  // A second attempt from the settled surface is again exactly one capture.
  const again = deferredQueue<CapturedClip>(captureMock);
  const label = cancelled ? 'Open automatic camera' : 'Try again';
  await burst(ctx.renderer, label, ctx.rng.int(2, 4), pickMode(ctx.rng));
  check(
    ctx,
    'capture.secondIntentExactlyOneMore',
    captureMock.mock.calls.length === 2,
    captureMock.mock.calls.length,
  );
  await again.reject(userCancel());
  check(
    ctx,
    'cancel.readyAgainNoAlert2',
    findPressable(ctx.renderer, 'Open automatic camera') !== null &&
      alertCount(ctx.renderer) === 0,
  );
}

/** S3: back (header Close) while the camera is opening; capture settles late. */
async function scenarioCloseDuringCapture(ctx: Ctx) {
  const source = ctx.rng.bool(0.7) ? 'camera' : 'library';
  ctx.params.source = source;
  // Armed BEFORE the route opens: a timer-spaced open burst can outlast the
  // 160ms library auto-launch.
  const capture = deferredQueue<CapturedClip>(
    source === 'camera' ? captureMock : importMock,
  );
  await openAnalyze(ctx, source);
  if (source === 'camera') {
    await tapChips(ctx);
    await burst(
      ctx.renderer,
      'Open automatic camera',
      ctx.rng.int(1, 3),
      pickMode(ctx.rng),
    );
  } else {
    // Library imports auto-launch after 160ms.
    await advance(200);
  }
  const captureCalls = source === 'camera' ? captureMock : importMock;
  check(
    ctx,
    'capture.exactlyOne',
    captureCalls.mock.calls.length === 1,
    captureCalls.mock.calls.length,
  );
  const closeTaps = ctx.rng.int(1, 4);
  const closeMode = pickMode(ctx.rng);
  ctx.params.closeTaps = closeTaps;
  ctx.params.closeMode = closeMode;
  const closed = await burst(ctx.renderer, 'Close', closeTaps, closeMode);
  ctx.observed.closeBurst = closed;
  const now = routes();
  check(
    ctx,
    'back.analyzePoppedOnce',
    count(now, 'Analyze') === 0 && now.length === 1,
    now,
  );
  check(
    ctx,
    'back.nativeCancelIssued',
    cancelMock.mock.calls.length >= 1,
    cancelMock.mock.calls.length,
  );
  const lateSettle = ctx.rng.pick(['resolve', 'cancelled', 'failed'] as const);
  ctx.params.lateSettle = lateSettle;
  if (lateSettle === 'resolve') {
    await capture.resolve(source === 'camera' ? guidedClip() : importedClip);
  } else if (lateSettle === 'cancelled') {
    await capture.reject(userCancel());
  } else {
    await capture.reject(new Error('stress: camera failed after close'));
  }
  await flush();
  const after = routes();
  check(
    ctx,
    'back.noPermitForAbandonedScreen',
    analysisMock.mock.calls.length === 0,
    analysisMock.mock.calls.length,
  );
  check(
    ctx,
    'back.noRefreshWithoutLedger',
    refreshCount() === 0,
    refreshCount(),
  );
  check(
    ctx,
    'back.routesUnchangedAfterLateSettle',
    after.length === 1 && after[0] === 'Tabs',
    after,
  );
  check(
    ctx,
    'back.noAnalyzeRemounted',
    analyzeSurfaceCount(ctx.renderer) === 0,
    analyzeSurfaceCount(ctx.renderer),
  );
}

/** S4: saved-phase controls fired together (score + capture another, etc). */
async function scenarioSavedPhaseSimultaneous(ctx: Ctx) {
  await openAnalyze(ctx, 'camera');
  // No declaration before capture → the clip lands on the saved surface.
  const capture = deferredQueue<CapturedClip>(captureMock);
  await burst(
    ctx.renderer,
    'Open automatic camera',
    ctx.rng.int(1, 3),
    pickMode(ctx.rng),
  );
  check(ctx, 'capture.exactlyOne', captureMock.mock.calls.length === 1);
  await capture.resolve(guidedClip());
  check(
    ctx,
    'saved.surfaceShown',
    countText(ctx.renderer, 'Capture complete') === 1,
  );
  check(
    ctx,
    'saved.scoreDisabledUntilDeclared',
    findPressable(ctx.renderer, 'Get my Technique Score') === null,
  );
  const analysis = deferredQueue<CaptureAnalysisOutcome>(analysisMock);
  const variant = ctx.rng.weighted([
    ['score_burst', 3],
    ['score_and_capture_another', 3],
    ['capture_another_and_library', 2],
    ['library_only', 1],
    ['chip_and_score_same_tick', 2],
  ] as const);
  ctx.params.variant = variant;
  const chip = ctx.rng.pick(SAVED_CHIPS);
  ctx.params.chip = chip.label;

  if (variant === 'library_only') {
    // Control: a SINGLE tap on "Open Library" (no burst) from the saved
    // surface must pop Analyze back to the one Tabs route.
    await burst(ctx.renderer, 'Open Library', 1, { kind: 'same_tick' });
    await flush();
    const now = routes();
    check(
      ctx,
      'library.singleTapPopsToTabs',
      now.length === 1 && now[0] === 'Tabs',
      routesDetailed(),
    );
    check(
      ctx,
      'library.noDuplicateTabsRoute',
      count(now, 'Tabs') === 1,
      routesDetailed(),
    );
    check(
      ctx,
      'library.analyzeUnmounted',
      analyzeSurfaceCount(ctx.renderer) === 0,
      analyzeSurfaceCount(ctx.renderer),
    );
    return;
  }

  if (variant === 'chip_and_score_same_tick') {
    // Chip and score in the SAME tick: the score button is still disabled
    // in this render, so the finger hits a disabled control → no scoring.
    const fired = await simultaneous(ctx.renderer, [
      chip.label,
      'Get my Technique Score',
    ]);
    ctx.observed.fired = fired;
    check(
      ctx,
      'saved.disabledScoreIgnored',
      analysisMock.mock.calls.length === 0,
      analysisMock.mock.calls.length,
    );
    await flush();
    check(
      ctx,
      'saved.scoreEnabledAfterChip',
      findPressable(ctx.renderer, 'Get my Technique Score') !== null,
    );
    const taps = ctx.rng.int(2, 4);
    await burst(
      ctx.renderer,
      'Get my Technique Score',
      taps,
      pickMode(ctx.rng),
    );
    check(
      ctx,
      'permit.exactlyOneAnalysis',
      analysisMock.mock.calls.length === 1,
      analysisMock.mock.calls.length,
    );
    await analysis.resolve(outcomeFor('scored', ctx.seed));
    const now = routes();
    check(
      ctx,
      'scored.replacedWithOneResult',
      count(now, 'Result') === 1 && count(now, 'Analyze') === 0,
      now,
    );
    return;
  }

  await act(async () => {
    findPressable(ctx.renderer, chip.label)?.props.onPress();
  });
  await flush();
  check(
    ctx,
    'saved.scoreEnabledAfterChip',
    findPressable(ctx.renderer, 'Get my Technique Score') !== null,
  );

  if (variant === 'score_burst') {
    const taps = ctx.rng.int(2, 5);
    const mode = pickMode(ctx.rng);
    ctx.params.scoreTaps = taps;
    ctx.params.scoreMode = mode;
    await burst(ctx.renderer, 'Get my Technique Score', taps, mode);
    check(
      ctx,
      'permit.exactlyOneAnalysis',
      analysisMock.mock.calls.length === 1,
      analysisMock.mock.calls.length,
    );
    check(
      ctx,
      'permit.declarationMatchesChip',
      analysisRequests()[0]?.declaredStroke === chip.slug,
    );
    check(
      ctx,
      'analysis.oneMeasuringSurface',
      workingSurfaceCount(ctx.renderer) === 1 &&
        countText(ctx.renderer, 'Measuring your swing') >= 1,
      {
        working: workingSurfaceCount(ctx.renderer),
        text: renderedText(ctx.renderer).slice(0, 300),
      },
    );
    const outcomeKind = ctx.rng.pick([
      'scored',
      'scored_free_limit',
      'unavailable',
      'quality_blocked',
    ] as const);
    ctx.params.outcome = outcomeKind;
    await analysis.resolve(outcomeFor(outcomeKind, ctx.seed));
    settledSurfaceChecks(ctx, 'settled');
    await driveTerminal(ctx, outcomeKind, `analysis-stress-${ctx.seed}`);
    check(ctx, 'permit.stillExactlyOne', analysisMock.mock.calls.length === 1);
    return;
  }

  if (variant === 'score_and_capture_another') {
    const order = ctx.rng.bool()
      ? ['Get my Technique Score', 'Capture another']
      : ['Capture another', 'Get my Technique Score'];
    ctx.params.order = order;
    const fired = await simultaneous(ctx.renderer, order);
    ctx.observed.fired = fired;
    await flush();
    const captures = captureMock.mock.calls.length;
    const permits = analysisMock.mock.calls.length;
    ctx.observed.afterSimultaneous = {
      captures,
      permits,
      text: renderedText(ctx.renderer).slice(0, 200),
    };
    // Two flows for one screen: the invariant is that at most ONE of them is
    // live on this screen at a time (single phase, single loading surface).
    check(ctx, 'simul.singleLiveFlow', !(captures === 2 && permits === 1), {
      captures,
      permits,
    });
    check(
      ctx,
      'simul.singleLoadingSurface',
      workingSurfaceCount(ctx.renderer) <= 1,
      workingSurfaceCount(ctx.renderer),
    );
    // Settle whatever started, in seeded order, and watch the permit count.
    const captureFirst = ctx.rng.bool();
    ctx.params.settleOrder = captureFirst
      ? 'capture_then_analysis'
      : 'analysis_then_capture';
    const settleCapture = async () => {
      if (capture.pending > 0) await capture.resolve(guidedClip());
    };
    const settleAnalysis = async () => {
      if (analysis.pending > 0)
        await analysis.resolve(outcomeFor('scored', ctx.seed));
    };
    if (captureFirst) {
      await settleCapture();
      ctx.observed.afterCaptureSettled = {
        permits: analysisMock.mock.calls.length,
        routes: routes(),
        text: renderedText(ctx.renderer).slice(0, 200),
      };
      await settleAnalysis();
    } else {
      await settleAnalysis();
      ctx.observed.afterAnalysisSettled = {
        routes: routes(),
        cancels: cancelMock.mock.calls.length,
      };
      await settleCapture();
    }
    await flush();
    const now = routes();
    check(
      ctx,
      'simul.permitAtMostOne',
      analysisMock.mock.calls.length <= 1,
      analysisMock.mock.calls.length,
    );
    check(
      ctx,
      'simul.atMostOneResult',
      count(now, 'Result') <= 1 && count(now, 'Analyze') <= 1,
      now,
    );
    check(
      ctx,
      'simul.noOrphanLoadingIfOnResult',
      count(now, 'Result') === 0 || workingSurfaceCount(ctx.renderer) === 0,
      workingSurfaceCount(ctx.renderer),
    );
    return;
  }

  // capture_another_and_library: "Capture another" + "Open Library" together.
  const fired = await simultaneous(ctx.renderer, [
    'Capture another',
    'Open Library',
  ]);
  ctx.observed.fired = fired;
  await flush();
  const now = routes();
  check(
    ctx,
    'simul.libraryPopsAnalyzeOnce',
    count(now, 'Analyze') === 0 && now.length === 1,
    routesDetailed(),
  );
  check(
    ctx,
    'library.noDuplicateTabsRoute',
    count(now, 'Tabs') === 1,
    routesDetailed(),
  );
  check(
    ctx,
    'capture.atMostOneMore',
    captureMock.mock.calls.length <= 2,
    captureMock.mock.calls.length,
  );
  if (count(now, 'Analyze') === 0) {
    check(
      ctx,
      'back.nativeCancelIssued',
      captureMock.mock.calls.length === 1 || cancelMock.mock.calls.length >= 1,
      cancelMock.mock.calls.length,
    );
  }
  if (capture.pending > 0) await capture.reject(userCancel());
  check(ctx, 'permit.none', analysisMock.mock.calls.length === 0);
  check(ctx, 'back.noRefreshWithoutLedger', refreshCount() === 0);
}

/** S5: navigation spam — open/close Analyze in cycles. */
async function scenarioNavigationSpam(ctx: Ctx) {
  const cycles = ctx.rng.int(1, 3);
  ctx.params.cycles = cycles;
  const openings: string[] = [];
  for (let i = 0; i < cycles; i += 1) {
    const source = ctx.rng.bool(0.75) ? 'camera' : 'library';
    openings.push(source);
    const capture = deferredQueue<CapturedClip>(
      source === 'camera' ? captureMock : importMock,
    );
    await openAnalyze(ctx, source);
    if (source === 'library') {
      // Close DURING the 160ms auto-launch delay or right after it.
      const early = ctx.rng.bool();
      await advance(early ? ctx.rng.int(0, 150) : 200);
      ctx.params[`cycle${i}.closedBeforeLaunch`] = early;
    }
    const closeTaps = ctx.rng.int(1, 5);
    const closeMode = pickMode(ctx.rng);
    await burst(ctx.renderer, 'Close', closeTaps, closeMode);
    await advance(200);
    const now = routes();
    check(
      ctx,
      `cycle${i}.backOnTabsOnly`,
      now.length === 1 && now[0] === 'Tabs',
      now,
    );
    if (capture.pending > 0) await capture.reject(userCancel());
    await flush();
    check(ctx, `cycle${i}.routesStable`, routes().length === 1, routes());
    check(
      ctx,
      `cycle${i}.importAtMostOnce`,
      importMock.mock.calls.length <= i + 1,
    );
  }
  ctx.params.openings = openings;
  check(ctx, 'nav.noPermit', analysisMock.mock.calls.length === 0);
  check(
    ctx,
    'nav.noCameraListenerLeak',
    mockCameraListeners.size === 0,
    mockCameraListeners.size,
  );
}

/** S6: free-limit prompt reached through zero-touch AUTO; spam its buttons. */
async function scenarioFreeLimitModalSpam(ctx: Ctx) {
  await openAnalyze(ctx, 'camera');
  await act(async () => {
    findPressable(ctx.renderer, 'Auto detect')?.props.onPress();
  });
  await flush();
  const capture = deferredQueue<CapturedClip>(captureMock);
  const analysis = deferredQueue<CaptureAnalysisOutcome>(analysisMock);
  await burst(ctx.renderer, 'Analyze with Auto Detect', 1, {
    kind: 'same_tick',
  }).then(async fired => {
    // "Analyze with Auto Detect" only exists on the saved surface; on the
    // ready surface the CTA is the camera button.
    if (fired.fired === 0)
      await burst(
        ctx.renderer,
        'Open automatic camera',
        ctx.rng.int(1, 3),
        pickMode(ctx.rng),
      );
  });
  check(
    ctx,
    'capture.exactlyOne',
    captureMock.mock.calls.length === 1,
    captureMock.mock.calls.length,
  );
  await capture.resolve(guidedClip());
  check(
    ctx,
    'permit.exactlyOneAnalysis',
    analysisMock.mock.calls.length === 1,
    analysisMock.mock.calls.length,
  );
  check(
    ctx,
    'permit.autoRunDeclaresNothing',
    analysisRequests()[0]?.declaredStroke === null &&
      analysisRequests()[0]?.declaredCanonical === null,
  );
  await analysis.resolve(outcomeFor('scored_free_limit', ctx.seed));
  check(
    ctx,
    'freeLimit.exactlyOneModal',
    visibleModalCount(ctx.renderer) === 1,
    visibleModalCount(ctx.renderer),
  );
  const upgradeTapped = ctx.rng.bool()
    ? await (async () => {
        // Double/triple tap on ONE button (same tick or spaced).
        const button = ctx.rng.pick([
          'See my score',
          'Upgrade to Pro',
          'Close',
        ] as const);
        const taps = ctx.rng.int(2, 3);
        const mode = pickMode(ctx.rng);
        ctx.params.buttons = [button];
        ctx.params.buttonTaps = taps;
        ctx.params.buttonMode = mode;
        ctx.observed.fired = await burst(ctx.renderer, button, taps, mode);
        return button === 'Upgrade to Pro';
      })()
    : await (async () => {
        // Distinct buttons under simultaneous fingers.
        const buttons = ctx.rng
          .shuffle(['See my score', 'Upgrade to Pro', 'Close'])
          .slice(0, ctx.rng.int(1, 3));
        ctx.params.buttons = buttons;
        ctx.observed.fired = await simultaneous(ctx.renderer, buttons);
        return buttons.includes('Upgrade to Pro');
      })();
  await flush();
  const now = routes();
  check(
    ctx,
    'freeLimit.exactlyOneResult',
    count(now, 'Result') === 1 && count(now, 'Analyze') === 0,
    routesDetailed(),
  );
  check(
    ctx,
    'freeLimit.atMostOnePaywall',
    count(now, 'Paywall') <= (upgradeTapped ? 1 : 0),
    routesDetailed(),
  );
  check(ctx, 'freeLimit.modalGone', visibleModalCount(ctx.renderer) === 0);
  check(ctx, 'permit.stillExactlyOne', analysisMock.mock.calls.length === 1);
}

type ScenarioName =
  | 'open_camera_burst'
  | 'capture_rejects'
  | 'close_during_capture'
  | 'saved_phase_simultaneous'
  | 'navigation_spam'
  | 'free_limit_modal_spam';

const SCENARIOS: Record<ScenarioName, (ctx: Ctx) => Promise<void>> = {
  open_camera_burst: scenarioOpenCameraBurst,
  capture_rejects: scenarioCaptureRejects,
  close_during_capture: scenarioCloseDuringCapture,
  saved_phase_simultaneous: scenarioSavedPhaseSimultaneous,
  navigation_spam: scenarioNavigationSpam,
  free_limit_modal_spam: scenarioFreeLimitModalSpam,
};

function pickScenario(rng: SeededRng): ScenarioName {
  return rng.weighted<ScenarioName>([
    ['open_camera_burst', 5],
    ['capture_rejects', 2],
    ['close_during_capture', 3],
    ['saved_phase_simultaneous', 3],
    ['navigation_spam', 2],
    ['free_limit_modal_spam', 2],
  ]);
}

// ─── Campaign ────────────────────────────────────────────────────────────────

const seeds = campaignSeeds();
const reporter = new CampaignReporter('scr-analyzescreen', 'rapid-interaction');

const NAV_DEV_WARNING = /was not handled by any navigator/;
const ACT_WARNING = /not wrapped in act|inside a test was not wrapped/;

function classifyConsole(messages: string[]) {
  const navDevWarnings = messages.filter(m => NAV_DEV_WARNING.test(m));
  const actWarnings = messages.filter(m => ACT_WARNING.test(m));
  const other = messages.filter(
    m => !NAV_DEV_WARNING.test(m) && !ACT_WARNING.test(m),
  );
  return { navDevWarnings, actWarnings, other };
}

beforeAll(() => {
  process.on('unhandledRejection', onUnhandled);
});

afterAll(() => {
  process.off('unhandledRejection', onUnhandled);
  const summary = reporter.flush(seeds);
  realConsoleError(
    `[stress scr-analyzescreen/rapid-interaction] executed=${summary.scenariosExecuted} held=${summary.held} broken=${summary.broken}` +
      (summary.broken > 0
        ? ` brokenSeeds=${summary.brokenSeeds.join(',')}`
        : '') +
      (process.env.STRESS_OUT ? ` out=${process.env.STRESS_OUT}` : ''),
  );
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  captureMock.mockReset();
  importMock.mockReset();
  analysisMock.mockReset();
  mockCameraListeners.clear();
  statements = [];
  kv.clear();
  consoleErrors = [];
  unhandled = [];
  console.error = (...args: unknown[]) => {
    consoleErrors.push(
      args.map(a => (a instanceof Error ? a.message : String(a))).join(' '),
    );
  };
  setActiveDataOwner(owner);
  establishApiSession({
    apiBaseUrl: 'https://api.test',
    bearerToken: 'token-stress',
    canonicalAppUserId: owner,
    provider: 'apple',
  });
  clearAccessStoreConfiguration();
  clients = backendReturning(async () => freeAccess(1));
  configureAccessStore(clients);
  useAccessStore.setState({ status: 'ready', canonicalAccess: freeAccess(0) });
});

afterEach(() => {
  console.error = realConsoleError;
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  jest.useRealTimers();
});

describe.each(seeds)('AnalyzeScreen rapid-interaction seed %i', seed => {
  it('holds every single-side-effect invariant under the seeded burst', async () => {
    const startedAt = process.hrtime.bigint();
    const rng = new SeededRng(seed);
    const scenario = pickScenario(rng);
    const renderer = await mountApp();
    const ctx: Ctx = {
      seed,
      rng,
      renderer,
      params: {},
      checks: {},
      observed: {},
    };
    let driverError: string | null = null;
    try {
      check(
        ctx,
        'boot.tabsIsRoot',
        routes().length === 1 && routes()[0] === 'Tabs',
        routes(),
      );
      await SCENARIOS[scenario](ctx);
    } catch (error) {
      driverError =
        error instanceof Error
          ? `${error.message}\n${error.stack ?? ''}`
          : String(error);
    }
    // Tear the whole app down: the deferred ledger refresh (if any) must fire
    // exactly once, and no camera subscription may survive the unmount.
    const refreshBeforeUnmount = refreshCount();
    const ledgerTouched = analysisMock.mock.calls.length > 0;
    try {
      await unmountApp(renderer);
    } catch (error) {
      driverError ??=
        error instanceof Error ? `unmount: ${error.message}` : String(error);
    }
    await flush();
    const refreshAfter = refreshCount();
    check(
      ctx,
      'teardown.noCameraListenerLeak',
      mockCameraListeners.size === 0,
      mockCameraListeners.size,
    );
    check(
      ctx,
      'teardown.refreshExactlyOncePerTouchedLedger',
      ledgerTouched ? refreshAfter === 1 : refreshAfter === 0,
      { ledgerTouched, refreshBeforeUnmount, refreshAfter },
    );
    const classified = classifyConsole(consoleErrors);
    check(
      ctx,
      'console.noActWarnings',
      classified.actWarnings.length === 0,
      classified.actWarnings,
    );
    check(
      ctx,
      'console.noUnexpectedErrors',
      classified.other.length === 0,
      classified.other,
    );
    check(
      ctx,
      'console.noUnhandledRejections',
      unhandled.length === 0,
      unhandled,
    );
    ctx.observed.navDevWarnings = classified.navDevWarnings.length;
    ctx.observed.navDevWarningSamples = classified.navDevWarnings
      .slice(0, 2)
      .map(m => m.split('\n')[0]);
    ctx.observed.pendingCaptureRows = statements.filter(s =>
      /INSERT INTO captures/i.test(s.sql),
    ).length;

    const failed = Object.entries(ctx.checks)
      .filter(([, held]) => !held)
      .map(([name]) => name);
    const record: IterationRecord = {
      seed,
      scenario,
      params: ctx.params,
      checks: ctx.checks,
      observed: ctx.observed,
      consoleErrors: consoleErrors.map(m => m.split('\n')[0] ?? m),
      unhandledRejections: unhandled,
      driverError,
      outcome: failed.length === 0 && driverError === null ? 'HELD' : 'BROKEN',
      durationMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
    };
    reporter.record(record);
    if (record.outcome === 'BROKEN') {
      throw new Error(
        `seed ${seed} (${scenario}) BROKEN — failed checks: ${failed.join(', ') || '(driver error)'}` +
          `\nparams=${JSON.stringify(ctx.params)}` +
          `\nobserved=${JSON.stringify(ctx.observed)}` +
          (driverError ? `\ndriverError=${driverError}` : ''),
      );
    }
  });
});
