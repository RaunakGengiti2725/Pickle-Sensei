/**
 * Rapid / concurrent interaction stress for ProgressScreen.
 *
 * The screen is rendered inside the REAL RootNavigator (NavigationContainer,
 * native stack, bottom tabs, PremiumTabBar), with the REAL zustand stores,
 * the REAL repository layer and the REAL SQLite schema (migrations run
 * against a `node:sqlite` in-memory database standing in for op-sqlite).
 * Only native modules, out-of-unit screens and `fetch` are stubbed.
 *
 * A seeded generator scripts interaction bursts (double / triple taps,
 * simultaneous controls, taps during a pending load, back during async,
 * tab spam, coach-menu spam, retry hammering). After every burst the tree
 * must be quiescent and these invariants must hold:
 *   - exactly one local load + one consistency refresh + one progress
 *     request per focus gain / retry intent (no duplicate requests),
 *   - at most one rank request per load,
 *   - at most one StreakCalendar / Result route per navigation intent,
 *     with the last tapped attempt's analysisId,
 *   - no orphan loading state once every held query/response is released,
 *   - error state shown iff the last owning load failed,
 *   - exactly one selected section tab and one selected range tab, matching
 *     the last tap of each burst,
 *   - at most one visible Modal (coach menu),
 *   - no console.error (act() warnings included) and no unhandled rejection.
 *
 * Replay:   STRESS_SEED=<seed> STRESS_ITER=1 npx jest --ci <this file>
 * Campaign: STRESS_ITER=<scenarios> STRESS_BURSTS=<bursts per scenario>
 *           STRESS_REPORT=/abs/path.json (seed → outcome table)
 */
import React from 'react';
import { Modal, Pressable } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { NavigationContainerRefWithCurrent } from '@react-navigation/native';

import type { ShotAnalysis } from '@pickle/shared-types';

declare const require: (id: string) => unknown;
declare const process: {
  env: Record<string, string | undefined>;
  memoryUsage(): { heapUsed: number };
  on(event: 'unhandledRejection', handler: (reason: unknown) => void): void;
  off(event: 'unhandledRejection', handler: (reason: unknown) => void): void;
};

// ---------------------------------------------------------------------------
// Native SQLite stand-in with a fault gate (hold / fail) on the facts query.
// ---------------------------------------------------------------------------
interface SqliteStatement {
  all(...params: (string | number | null)[]): Record<string, unknown>[];
}
interface DatabaseSync {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (location: string) => DatabaseSync;
};

type FaultMode = 'ok' | 'hold' | 'fail';
interface Held {
  release(): void;
}
const mockGate: {
  real: DatabaseSync | null;
  factsLoads: number;
  captureLoads: number;
  modes: FaultMode[];
  dbPlan: (loadIndex: number) => FaultMode;
  held: Held[];
} = {
  real: null,
  factsLoads: 0,
  captureLoads: 0,
  modes: [],
  dbPlan: () => 'ok',
  held: [],
};

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    const db = mockGate.real;
    if (!db) throw new Error('scenario did not seed a database');
    const run = (sql: string, params: unknown[]) => ({
      rows: db.prepare(sql).all(...(params as (string | number | null)[])),
    });
    return {
      executeSync: (sql: string) => run(sql, []),
      execute: async (sql: string, params: unknown[] = []) => {
        const isFactsQuery =
          sql.includes('SELECT payload FROM local_shot') &&
          sql.includes("source = 'real'");
        if (sql.includes('FROM local_capture') && sql.includes('status IN')) {
          mockGate.captureLoads += 1;
        }
        if (!isFactsQuery) return run(sql, params);
        mockGate.factsLoads += 1;
        const mode = mockGate.dbPlan(mockGate.factsLoads);
        mockGate.modes.push(mode);
        if (mode === 'fail') throw new Error('sqlite unavailable (injected)');
        if (mode === 'ok') return run(sql, params);
        return new Promise<{ rows: Record<string, unknown>[] }>(resolve => {
          mockGate.held.push({ release: () => resolve(run(sql, params)) });
        });
      },
      close: () => {},
    };
  },
}));

jest.mock(
  'react-native-safe-area-context',
  () =>
    (
      require('react-native-safe-area-context/jest/mock') as {
        default: unknown;
      }
    ).default,
);

// Real navigation; we only capture the container ref RootNavigator creates
// (at module load) so the harness can read committed navigation state.
type NavRef = NavigationContainerRefWithCurrent<never>;
jest.mock('@react-navigation/native', () => {
  const actual = jest.requireActual('@react-navigation/native') as {
    createNavigationContainerRef: <
      T extends object,
    >() => NavigationContainerRefWithCurrent<T>;
  };
  const captured: { ref: unknown } = { ref: null };
  return {
    ...actual,
    __stressCaptured: captured,
    createNavigationContainerRef: <T extends object>() => {
      const ref = actual.createNavigationContainerRef<T>();
      captured.ref = ref;
      return ref;
    },
  };
});
function navRef(): NavRef | null {
  const mod = require('@react-navigation/native') as {
    __stressCaptured: { ref: NavRef | null };
  };
  return mod.__stressCaptured.ref;
}

// Out-of-unit screens: inert stubs. Result keeps a real Back control so
// "back during async" can be driven through a pressable like on device.
const mockResultParams: unknown[] = [];
jest.mock('../../src/screens/ResultScreen', () => {
  const RN = jest.requireActual(
    'react-native',
  ) as typeof import('react-native');
  const ReactActual = jest.requireActual('react') as typeof React;
  return {
    ResultScreen: (props: {
      route: { params: unknown };
      navigation: { goBack(): void };
    }) => {
      mockResultParams.push(props.route.params);
      return ReactActual.createElement(RN.Pressable, {
        accessibilityLabel: 'Back',
        accessibilityRole: 'button',
        onPress: () => props.navigation.goBack(),
      });
    },
  };
});
jest.mock('../../src/screens/HomeScreen', () => ({ HomeScreen: () => null }));
jest.mock('../../src/screens/LibraryScreen', () => ({
  LibraryScreen: () => null,
}));
jest.mock('../../src/screens/SettingsScreen', () => ({
  SettingsScreen: () => null,
}));
jest.mock('../../src/screens/AnalyzeScreen', () => ({
  AnalyzeScreen: () => null,
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
jest.mock('../../src/screens/PaywallScreen', () => ({
  PaywallScreen: () => null,
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

import { RootNavigator } from '../../src/navigation/RootNavigator';
import { ProgressScreen } from '../../src/screens/ProgressScreen';
import { StreakCalendarScreen } from '../../src/screens/StreakCalendarScreen';
import { PremiumTabBar } from '../../src/navigation/PremiumTabBar';
import { getDb } from '../../src/data/db';
import {
  markCaptureAnalyzed,
  saveAnalysis,
  savePendingCapture,
} from '../../src/data/repository';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { useApiSessionStore } from '../../src/account/apiSession';
import { useAppStore } from '../../src/state/appStore';
import { useConsistencyStore } from '../../src/consistency/store';
import { useRankCelebrationStore } from '../../src/progress/rankCelebration';

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) — every scenario is a pure function of its seed.
// ---------------------------------------------------------------------------
class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(minInclusive: number, maxInclusive: number): number {
    return (
      minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1))
    );
  }
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return parsed;
};
const SCENARIOS = envInt('STRESS_ITER', 24);
const BURSTS_PER_SCENARIO = envInt('STRESS_BURSTS', 15);
const BASE_SEED = envInt('STRESS_SEED', 20260904);
const REPORT_PATH = process.env['STRESS_REPORT'];
const SEEDS = Array.from({ length: SCENARIOS }, (_, i) =>
  SCENARIOS === 1 ? BASE_SEED : (BASE_SEED + i * 7919) >>> 0,
);

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------
const OWNER = '11111111-2222-4333-8444-555555555555';
const PERMIT = '22222222-2222-4222-8222-222222222222';
const SHOT_TYPES = [
  'forehand_drive',
  'backhand_drive',
  'dink',
  'serve',
  'third_shot_drop',
] as const;
const NOW_MS = Date.parse('2026-09-04T18:00:00.000Z');

function uuidFrom(rng: Rng): string {
  const hex = (n: number) =>
    Array.from({ length: n }, () => rng.int(0, 15).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;
}

function analysisFixture(rng: Rng): ShotAnalysis {
  const score = rng.int(30, 95) / 10;
  return {
    id: uuidFrom(rng),
    sessionId: null,
    shotType: rng.pick(SHOT_TYPES),
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: new Date(NOW_MS - rng.int(1, 80) * 86_400_000).toISOString(),
    timestamps: { startMs: 0, contactMs: 900, endMs: 1800 },
    phases: [],
    measurements: [],
    checkpoints: [
      {
        key: 'contact_position',
        score: rng.int(20, 95),
        confidence: 0.8,
        band: 'yellow',
        direction: 'none',
        severity: 0.3,
        applicable: true,
      },
    ],
    overallScore: score,
    analysisConfidence: 0.9,
    resultKind: 'scored',
    guidance: null,
    priorityFix: null,
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'validated-bundle-1',
      poseModelVersion: 'pose-1',
      paddleModelVersion: 'paddle-1',
      strokeDetectorVersion: 'stroke-1',
      phaseModelVersion: 'phase-1',
      scoringModelVersion: 'score-1',
      shotConfigVersion: 'forehand_drive@1',
    },
    source: 'real',
  };
}

interface Scenario {
  seed: number;
  signedIn: boolean;
  shots: number;
  practiceSetAttempts: number;
  captures: number;
  dbPlan: FaultMode[];
  fetchPlan: FaultMode[];
}

function describeScenario(seed: number): Scenario {
  const rng = new Rng(seed ^ 0x9e3779b9);
  const plan = (weights: Record<FaultMode, number>): FaultMode[] => {
    const bag: FaultMode[] = [];
    for (const mode of ['ok', 'hold', 'fail'] as const) {
      for (let i = 0; i < weights[mode]; i++) bag.push(mode);
    }
    // First load is always honest so the dashboard exists to be attacked.
    return ['ok', ...Array.from({ length: 200 }, () => rng.pick(bag))];
  };
  return {
    seed,
    signedIn: rng.chance(0.6),
    shots: rng.int(0, 10),
    practiceSetAttempts: rng.chance(0.55) ? rng.int(2, 4) : 0,
    captures: rng.int(0, 5),
    dbPlan: plan({ ok: 6, hold: 3, fail: 2 }),
    fetchPlan: plan({ ok: 6, hold: 3, fail: 2 }),
  };
}

async function seedDatabase(rng: Rng, scenario: Scenario): Promise<void> {
  const db = getDb();
  const owner = scenario.signedIn ? OWNER : GUEST_DATA_OWNER;
  setActiveDataOwner(owner);
  for (let i = 0; i < scenario.shots; i++) {
    await saveAnalysis(db, analysisFixture(rng), PERMIT);
  }
  if (scenario.practiceSetAttempts > 0) {
    const sessionId = uuidFrom(rng);
    const shotType = rng.pick(SHOT_TYPES);
    for (let i = 0; i < scenario.practiceSetAttempts; i++) {
      const analysis = analysisFixture(rng);
      await saveAnalysis(
        db,
        {
          ...analysis,
          sessionId,
          shotType,
          capturedAtIso: new Date(
            NOW_MS - (scenario.practiceSetAttempts - i) * 60_000,
          ).toISOString(),
        },
        PERMIT,
      );
    }
  }
  for (let i = 0; i < scenario.captures; i++) {
    const id = uuidFrom(rng);
    await savePendingCapture(db, id, rng.pick(SHOT_TYPES), {
      uri: `file:///tmp/${id}.mov`,
      capturedAtIso: new Date(
        NOW_MS - rng.int(1, 30) * 3_600_000,
      ).toISOString(),
      durationMs: 2_000,
      fps: 60,
      width: 1080,
      height: 1920,
      recognition: {
        status: 'abstained',
        reason: 'stress fixture: no recogniser ran',
      },
      captureMode: 'imported_video',
      ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
    });
    if (rng.chance(0.5)) await markCaptureAnalyzed(db, id);
  }
}

// ---------------------------------------------------------------------------
// fetch stand-in with the same fault gate
// ---------------------------------------------------------------------------
const fetchCounts = { progress: 0, rank: 0, other: 0 };
let fetchPlan: (n: number) => FaultMode = () => 'ok';

const PROGRESS_BODY = {
  series: [],
  improving: [],
  needsAttention: [],
  streak: {
    currentDays: 2,
    longestDays: 5,
    practicedToday: false,
    lastPracticeDate: '2026-09-03',
  },
};
const RANK_BODY = { rank: null };

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function installFetch(): void {
  globalThis.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/v1/progress')) {
      fetchCounts.progress += 1;
      const mode = fetchPlan(fetchCounts.progress);
      if (mode === 'fail') return jsonResponse(503, { error: 'unavailable' });
      if (mode === 'ok') return jsonResponse(200, PROGRESS_BODY);
      return new Promise<Response>(resolve => {
        mockGate.held.push({
          release: () => resolve(jsonResponse(200, PROGRESS_BODY)),
        });
      });
    }
    if (url.endsWith('/v1/rank')) {
      fetchCounts.rank += 1;
      return jsonResponse(200, RANK_BODY);
    }
    fetchCounts.other += 1;
    return jsonResponse(404, {});
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------
type Instance = TestRenderer.ReactTestInstance;
const PressableInner = (Pressable as unknown as { type: React.ComponentType })
  .type;

function pressables(root: Instance): Instance[] {
  return root.findAllByType(PressableInner);
}
function byLabel(root: Instance, label: string): Instance[] {
  return pressables(root).filter(
    n => n.props.accessibilityLabel === label && !n.props.disabled,
  );
}
function byLabelPrefix(root: Instance, prefix: string): Instance[] {
  return pressables(root).filter(
    n =>
      typeof n.props.accessibilityLabel === 'string' &&
      n.props.accessibilityLabel.startsWith(prefix) &&
      !n.props.disabled,
  );
}
function texts(root: Instance): string[] {
  return root
    .findAll(n => (n.type as unknown) === 'Text')
    .map(n =>
      React.Children.toArray(n.props.children)
        .filter((c): c is string => typeof c === 'string')
        .join(''),
    );
}

interface RouteLike {
  name: string;
  params?: unknown;
  state?: { index: number; routes: RouteLike[] };
}
function rootRoutes(): RouteLike[] {
  const state = navRef()?.getRootState() as
    { index: number; routes: RouteLike[] } | undefined;
  return state?.routes ?? [];
}
function topRoute(): RouteLike | undefined {
  const state = navRef()?.getRootState() as
    { index: number; routes: RouteLike[] } | undefined;
  return state?.routes[state.index];
}
function focusedTab(): string | undefined {
  const top = topRoute();
  if (!top || top.name !== 'Tabs' || !top.state) return undefined;
  return top.state.routes[top.state.index]?.name;
}
function performanceFocused(): boolean {
  return focusedTab() === 'Performance';
}

// ---------------------------------------------------------------------------
// Interaction primitives
// ---------------------------------------------------------------------------
function tap(node: Instance, rng: Rng): void {
  const withPressCycle = rng.chance(0.5);
  if (withPressCycle && typeof node.props.onPressIn === 'function') {
    node.props.onPressIn({ nativeEvent: {} });
  }
  node.props.onPress({ nativeEvent: {} });
  if (withPressCycle && typeof node.props.onPressOut === 'function') {
    node.props.onPressOut({ nativeEvent: {} });
  }
}

async function microtask(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      jest.runOnlyPendingTimers();
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

function releaseHeld(): number {
  const held = mockGate.held.splice(0);
  for (const h of held) h.release();
  return held.length;
}

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------
interface BurstRecord {
  index: number;
  kind: string;
  taps: number;
}
interface ScenarioResult {
  seed: number;
  outcome: 'HELD' | 'BROKEN';
  signedIn: boolean;
  shots: number;
  captures: number;
  practiceSetAttempts: number;
  bursts: number;
  taps: number;
  loads: number;
  progressRequests: number;
  rankRequests: number;
  navigations: number;
  consoleWarnings: number;
  kinds: Record<string, number>;
  /** heapUsed after teardown (after an explicit GC when node runs with --expose-gc). */
  heapUsedMb: number;
  failedAt?: BurstRecord;
  error?: string;
}

// @react-native/jest-preset installs `performance.now = jest.fn(Date.now)`
// and react-test-renderer captures that object at load time (before
// jest.useFakeTimers() swaps the global). React's work loop calls it
// thousands of times per commit and jest records every call + result in
// `.mock` until cleared — ~1.6M entries after 70 bursts — which is what ran
// long campaigns out of V8 heap. Grab the mock now (real timers still on)
// so each burst can drop the history.
const presetPerformanceNow = globalThis.performance.now as unknown as {
  mockClear?: () => void;
};
function dropRecordedPerformanceNowCalls() {
  presetPerformanceNow.mockClear?.();
}

const results: ScenarioResult[] = [];
let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

const initialConsistency = useConsistencyStore.getState();
const initialApp = useAppStore.getState();
const initialSession = useApiSessionStore.getState();
const initialRank = useRankCelebrationStore.getState();

type SectionLabel = 'technique progress' | 'practice progress';
type RangeLabel = '7 days range' | '4 weeks range' | '90 days range';
const SECTION_LABELS: SectionLabel[] = [
  'technique progress',
  'practice progress',
];
const RANGE_LABELS: RangeLabel[] = [
  '7 days range',
  '4 weeks range',
  '90 days range',
];

async function runScenario(seed: number): Promise<ScenarioResult> {
  const scenario = describeScenario(seed);
  const rng = new Rng(seed);
  const record: ScenarioResult = {
    seed,
    outcome: 'HELD',
    signedIn: scenario.signedIn,
    shots: scenario.shots,
    captures: scenario.captures,
    practiceSetAttempts: scenario.practiceSetAttempts,
    bursts: 0,
    taps: 0,
    loads: 0,
    progressRequests: 0,
    rankRequests: 0,
    navigations: 0,
    consoleWarnings: 0,
    kinds: {},
    heapUsedMb: 0,
  };

  // Fresh world.
  jest.useFakeTimers();
  jest.setSystemTime(NOW_MS);
  mockGate.real = new DatabaseSync(':memory:');
  mockGate.factsLoads = 0;
  mockGate.captureLoads = 0;
  mockGate.modes = [];
  mockGate.held = [];
  mockGate.dbPlan = () => 'ok';
  fetchCounts.progress = 0;
  fetchCounts.rank = 0;
  fetchCounts.other = 0;
  fetchPlan = () => 'ok';
  mockResultParams.length = 0;
  useConsistencyStore.setState(initialConsistency, true);
  useAppStore.setState(initialApp, true);
  useRankCelebrationStore.setState(initialRank, true);
  useApiSessionStore.setState(initialSession, true);
  installFetch();

  await seedDatabase(rng, scenario);
  if (scenario.signedIn) {
    useApiSessionStore.setState({
      session: {
        apiBaseUrl: 'https://stress.invalid',
        bearerToken: 'stress-token',
        canonicalAppUserId: OWNER,
        provider: 'apple',
      },
    });
  }

  let consistencyRefreshes = 0;
  const realRefresh = useConsistencyStore.getState().refresh;
  useConsistencyStore.setState({
    refresh: async () => {
      consistencyRefreshes += 1;
      await realRefresh();
    },
  });

  const errors: string[] = [];
  const errorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {
    record.consoleWarnings += 1;
  });

  let renderer: TestRenderer.ReactTestRenderer | null = null;
  let focusGains = 0;
  let wasFocused = false;
  let streakFocusGains = 0;
  let streakWasFocused = false;
  let expectedRetries = 0;
  const unsubscribe = { current: () => {} };

  const burst: BurstRecord = { index: 0, kind: 'render', taps: 0 };
  const fail = (message: string): never => {
    throw new Error(
      `[seed ${seed} burst #${burst.index} ${burst.kind}] ${message}`,
    );
  };

  try {
    await act(async () => {
      renderer = TestRenderer.create(<RootNavigator />);
    });
    const root = (renderer as unknown as TestRenderer.ReactTestRenderer).root;
    const ref =
      navRef() ??
      fail('RootNavigator did not create a navigation container ref');
    const trackFocus = () => {
      const focused = performanceFocused();
      if (focused && !wasFocused) focusGains += 1;
      wasFocused = focused;
      const streakFocused = topRoute()?.name === 'StreakCalendar';
      if (streakFocused && !streakWasFocused) streakFocusGains += 1;
      streakWasFocused = streakFocused;
    };
    unsubscribe.current = ref.addListener('state', trackFocus);
    await settle();

    // Arm fault plans only after the tree exists.
    mockGate.dbPlan = n => scenario.dbPlan[n] ?? 'ok';
    fetchPlan = n => scenario.fetchPlan[n] ?? 'ok';

    const tabBar = () =>
      root.findAllByType(PremiumTabBar)[0] ?? fail('no tab bar');
    const tabNode = (label: string) =>
      byLabel(tabBar(), label)[0] ?? fail(`no tab ${label}`);
    const progressRoot = () =>
      root.findAllByType(ProgressScreen)[0] ??
      fail('ProgressScreen not mounted');
    const streakRoot = () => root.findAllByType(StreakCalendarScreen)[0];

    // First focus: Home → Progress.
    burst.kind = 'initial-focus';
    await act(async () => {
      tap(tabNode('Progress'), rng);
    });
    record.taps += 1;
    releaseHeld();
    await settle();
    releaseHeld();
    await settle();

    let lastSection: SectionLabel = 'technique progress';
    let lastRange: RangeLabel = '4 weeks range';
    // PlayerRankCard lives only in the technique section, so every committed
    // practice → technique switch remounts it (and, signed in, it requests
    // /v1/rank again — see the explicit KNOWN DEFECT test below).
    let techniqueRemounts = 0;
    const commitSection = (label: SectionLabel) => {
      if (
        lastSection === 'practice progress' &&
        label === 'technique progress'
      ) {
        techniqueRemounts += 1;
      }
      lastSection = label;
    };

    const checkInvariants = async () => {
      // Quiescence: release everything that is still gated and flush.
      for (let i = 0; i < 4; i++) {
        releaseHeld();
        await settle();
      }
      if (mockGate.held.length !== 0) fail('gated promises still pending');

      const loads = mockGate.factsLoads;
      const expectedLoads = focusGains + expectedRetries;
      if (loads !== expectedLoads) {
        fail(
          `local loads ${loads} != focus gains ${focusGains} + retries ${expectedRetries}`,
        );
      }
      if (mockGate.captureLoads !== loads) {
        fail(`capture loads ${mockGate.captureLoads} != facts loads ${loads}`);
      }
      // StreakCalendarScreen also refreshes once per focus gain (its own
      // useFocusEffect); everything else must come from ProgressScreen loads.
      if (consistencyRefreshes !== loads + streakFocusGains) {
        fail(
          `consistency refreshes ${consistencyRefreshes} != loads ${loads} + streak focus ${streakFocusGains}`,
        );
      }
      const expectedProgress = scenario.signedIn ? loads : 0;
      if (fetchCounts.progress !== expectedProgress) {
        fail(
          `progress requests ${fetchCounts.progress} != ${expectedProgress}`,
        );
      }
      const rankBudget = scenario.signedIn ? loads + techniqueRemounts : 0;
      if (fetchCounts.rank > rankBudget) {
        fail(
          `rank requests ${fetchCounts.rank} exceed loads ${loads} + technique remounts ${techniqueRemounts}`,
        );
      }
      if (fetchCounts.other !== 0)
        fail(`unexpected requests ${fetchCounts.other}`);

      const routes = rootRoutes();
      const streakRoutes = routes.filter(r => r.name === 'StreakCalendar');
      const resultRoutes = routes.filter(r => r.name === 'Result');
      if (streakRoutes.length > 1)
        fail(`duplicate StreakCalendar routes: ${streakRoutes.length}`);
      if (resultRoutes.length > 1)
        fail(`duplicate Result routes: ${resultRoutes.length}`);
      if (
        root.findAllByType(StreakCalendarScreen).length !== streakRoutes.length
      ) {
        fail('StreakCalendar mounted instances != routes');
      }
      const visibleModals = root
        .findAllByType(Modal)
        .filter(m => m.props.visible === true);
      if (visibleModals.length > 1)
        fail(`duplicate modals: ${visibleModals.length}`);

      const screen =
        root.findAllByType(ProgressScreen)[0] ??
        fail('ProgressScreen unmounted');
      const shown = texts(screen);
      const loading = shown.includes('Loading measured progress…');
      const errored = byLabel(screen, 'Try again').length > 0;
      if (loading) fail('orphan loading state after quiescence');
      const lastMode = mockGate.modes[mockGate.modes.length - 1] ?? 'ok';
      if (errored !== (lastMode === 'fail')) {
        fail(`error state ${errored} but last load mode was ${lastMode}`);
      }
      if (!errored) {
        const selectedSections = SECTION_LABELS.filter(l =>
          byLabel(screen, l).some(
            n => n.props.accessibilityState?.selected === true,
          ),
        );
        const selectedRanges = RANGE_LABELS.filter(l =>
          byLabel(screen, l).some(
            n => n.props.accessibilityState?.selected === true,
          ),
        );
        if (
          selectedSections.length !== 1 ||
          selectedSections[0] !== lastSection
        ) {
          fail(
            `selected sections ${JSON.stringify(selectedSections)} expected ${lastSection}`,
          );
        }
        if (selectedRanges.length !== 1 || selectedRanges[0] !== lastRange) {
          fail(
            `selected ranges ${JSON.stringify(selectedRanges)} expected ${lastRange}`,
          );
        }
      }
      if (errors.length > 0) fail(`console.error: ${errors[0]}`);
      if (unhandled.length > 0)
        fail(`unhandled rejection: ${String(unhandled[0])}`);
    };

    await checkInvariants();

    const KINDS = [
      'double-tap',
      'triple-tap',
      'simultaneous-controls',
      'tab-spam',
      'streak-then-back',
      'back-during-async',
      'tab-during-transition',
      'attempt-spam',
      'coach-menu-spam',
      'retry-hammer',
      'refocus-during-async',
    ] as const;

    for (let i = 1; i <= BURSTS_PER_SCENARIO; i++) {
      burst.index = i;
      burst.taps = 0;
      dropRecordedPerformanceNowCalls();
      const top = topRoute();
      const onTabs = top?.name === 'Tabs';
      const screen = onTabs ? progressRoot() : null;
      const errored = screen ? byLabel(screen, 'Try again').length > 0 : false;
      const streak = streakRoot();

      let kind: (typeof KINDS)[number] = rng.pick(KINDS);
      if (!onTabs) kind = 'streak-then-back';
      else if (errored) kind = rng.chance(0.7) ? 'retry-hammer' : 'tab-spam';
      else if (kind === 'retry-hammer') kind = 'double-tap';
      burst.kind = kind;
      record.bursts += 1;
      record.kinds[kind] = (record.kinds[kind] ?? 0) + 1;

      const doTap = (node: Instance) => {
        tap(node, rng);
        burst.taps += 1;
      };

      switch (kind) {
        case 'double-tap':
        case 'triple-tap': {
          const n = kind === 'double-tap' ? 2 : 3;
          const s = screen ?? fail('no screen');
          const roll = rng.int(0, 3);
          if (roll === 0) {
            const label = rng.pick(SECTION_LABELS);
            await act(async () => {
              for (let k = 0; k < n; k++)
                doTap(byLabel(s, label)[0] ?? fail(label));
            });
            commitSection(label);
          } else if (roll === 1) {
            const label = rng.pick(RANGE_LABELS);
            await act(async () => {
              for (let k = 0; k < n; k++)
                doTap(byLabel(s, label)[0] ?? fail(label));
            });
            lastRange = label;
          } else if (roll === 2) {
            const card = byLabelPrefix(s, 'Consistency.')[0];
            if (card) {
              await act(async () => {
                for (let k = 0; k < n; k++) doTap(card);
              });
              record.navigations += 1;
            }
          } else {
            const badge =
              byLabelPrefix(s, 'Achievement')[0] ??
              byLabelPrefix(s, 'Badge')[0];
            if (badge) {
              await act(async () => {
                for (let k = 0; k < n; k++) doTap(badge);
              });
            }
          }
          break;
        }
        case 'simultaneous-controls': {
          const s = screen ?? fail('no screen');
          const sec = rng.pick(SECTION_LABELS);
          const rangeLabel = rng.pick(RANGE_LABELS);
          const secondSec = rng.pick(SECTION_LABELS);
          const withSecond = rng.chance(0.5);
          await act(async () => {
            doTap(byLabel(s, sec)[0] ?? fail(sec));
            doTap(byLabel(s, rangeLabel)[0] ?? fail(rangeLabel));
            if (withSecond) doTap(byLabel(s, secondSec)[0] ?? fail(secondSec));
          });
          commitSection(withSecond ? secondSec : sec);
          lastRange = rangeLabel;
          break;
        }
        case 'tab-spam': {
          const hops = rng.int(2, 6);
          const sameTick = rng.chance(0.5);
          if (sameTick) {
            await act(async () => {
              for (let k = 0; k < hops; k++) {
                doTap(tabNode(k % 2 === 0 ? 'Home' : 'Progress'));
              }
            });
          } else {
            for (let k = 0; k < hops; k++) {
              await act(async () => {
                doTap(tabNode(k % 2 === 0 ? 'Home' : 'Progress'));
              });
              if (rng.chance(0.5)) await microtask();
            }
          }
          // Always end on Progress so the screen is observable.
          await act(async () => {
            doTap(tabNode('Progress'));
          });
          break;
        }
        case 'streak-then-back': {
          if (!streak) {
            const s = screen ?? fail('no screen');
            const card = byLabelPrefix(s, 'Consistency.')[0];
            if (!card) break;
            const n = rng.int(1, 3);
            await act(async () => {
              for (let k = 0; k < n; k++) doTap(card);
            });
            record.navigations += 1;
            if (rng.chance(0.5)) await microtask();
            else await settle();
          }
          // Back is re-queried per press: after the first pop commits the
          // screen (and its Back control) is gone, exactly as on device.
          const n = rng.int(1, 3);
          for (let k = 0; k < n; k++) {
            const sr = streakRoot();
            const node = sr ? byLabel(sr, 'Back')[0] : undefined;
            if (!node) break;
            await act(async () => {
              doTap(node);
            });
          }
          break;
        }
        case 'back-during-async': {
          // Force the next load to be held, refocus to start it, navigate away
          // and back while it is pending, then release.
          const s = screen ?? fail('no screen');
          const card = byLabelPrefix(s, 'Consistency.')[0];
          if (!card) break;
          const savedPlan = mockGate.dbPlan;
          mockGate.dbPlan = () => 'hold';
          await act(async () => {
            doTap(card);
          });
          record.navigations += 1;
          await microtask();
          const sr = streakRoot();
          if (sr) {
            await act(async () => {
              doTap(
                byLabel(sr, 'Back')[0] ?? fail('no Back on StreakCalendar'),
              );
            });
          }
          await microtask();
          // Focus regained → load starts and is held; tap controls meanwhile.
          const s2 = root.findAllByType(ProgressScreen)[0];
          if (s2 && byLabel(s2, 'Try again').length === 0) {
            const label = rng.pick(SECTION_LABELS);
            const node = byLabel(s2, label)[0];
            if (node) {
              await act(async () => {
                doTap(node);
              });
              commitSection(label);
            }
          }
          mockGate.dbPlan = savedPlan;
          break;
        }
        case 'tab-during-transition': {
          // Pogo: open StreakCalendar and pop it again before any pending
          // load / refresh / timer of the previous hop has flushed.
          const hops = rng.int(2, 4);
          for (let k = 0; k < hops; k++) {
            const s = root.findAllByType(ProgressScreen)[0];
            const card = s ? byLabelPrefix(s, 'Consistency.')[0] : undefined;
            if (!card) break;
            await act(async () => {
              doTap(card);
            });
            record.navigations += 1;
            if (rng.chance(0.5)) await microtask();
            const sr = streakRoot();
            const back = sr ? byLabel(sr, 'Back')[0] : undefined;
            if (!back) break;
            await act(async () => {
              doTap(back);
            });
            if (rng.chance(0.3)) await microtask();
          }
          break;
        }
        case 'attempt-spam': {
          const s = screen ?? fail('no screen');
          const attempts = byLabelPrefix(s, 'Attempt ');
          if (attempts.length === 0) break;
          const n = rng.int(1, 3);
          let lastId: string | null = null;
          await act(async () => {
            for (let k = 0; k < n; k++) {
              const node = rng.pick(attempts);
              lastId = String(node.props.testID).replace(
                'practice-set-attempt-',
                '',
              );
              doTap(node);
            }
          });
          record.navigations += 1;
          await microtask();
          const resultRoutes = rootRoutes().filter(r => r.name === 'Result');
          if (resultRoutes.length !== 1)
            fail(`Result routes ${resultRoutes.length}`);
          const params = resultRoutes[0]?.params as
            { analysisId?: string } | undefined;
          if (params?.analysisId !== lastId) {
            fail(
              `Result analysisId ${params?.analysisId} != last tapped ${lastId}`,
            );
          }
          const m = rng.int(1, 2);
          for (let k = 0; k < m; k++) {
            if (topRoute()?.name !== 'Result') break;
            const back = root.findAll(
              nd =>
                nd.props.accessibilityLabel === 'Back' &&
                typeof nd.props.onPress === 'function',
            );
            const node = back[back.length - 1];
            if (!node) break;
            await act(async () => {
              doTap(node);
            });
          }
          break;
        }
        case 'coach-menu-spam': {
          const open = byLabel(tabBar(), 'Open coach actions')[0];
          if (!open) break;
          const n = rng.int(2, 4);
          await act(async () => {
            for (let k = 0; k < n; k++) doTap(open);
          });
          await microtask();
          const visible = root
            .findAllByType(Modal)
            .filter(m => m.props.visible === true);
          if (visible.length !== 1)
            fail(`coach menu modals visible: ${visible.length}`);
          const close = byLabel(tabBar(), 'Close coach actions')[0];
          await act(async () => {
            const m = rng.int(1, 3);
            for (let k = 0; k < m; k++) if (close) doTap(close);
          });
          await settle();
          const after = root
            .findAllByType(Modal)
            .filter(m => m.props.visible === true);
          if (after.length !== 0)
            fail(`coach menu still visible: ${after.length}`);
          break;
        }
        case 'retry-hammer': {
          const s = screen ?? fail('no screen');
          const retry = byLabel(s, 'Try again')[0];
          if (!retry) break;
          const n = rng.int(1, 4);
          await act(async () => {
            for (let k = 0; k < n; k++) doTap(retry);
          });
          expectedRetries += 1;
          break;
        }
        case 'refocus-during-async': {
          // Hold the next load, leave and return to the tab before release.
          const savedPlan = mockGate.dbPlan;
          mockGate.dbPlan = () => 'hold';
          await act(async () => {
            doTap(tabNode('Home'));
          });
          await act(async () => {
            doTap(tabNode('Progress'));
          });
          await microtask();
          const hops = rng.int(0, 2);
          for (let k = 0; k < hops; k++) {
            await act(async () => {
              doTap(tabNode('Home'));
            });
            await act(async () => {
              doTap(tabNode('Progress'));
            });
          }
          mockGate.dbPlan = savedPlan;
          break;
        }
      }

      record.taps += burst.taps;
      await checkInvariants();
    }
  } catch (error) {
    record.outcome = 'BROKEN';
    record.failedAt = { ...burst };
    record.error = error instanceof Error ? error.message : String(error);
  } finally {
    record.loads = mockGate.factsLoads;
    record.progressRequests = fetchCounts.progress;
    record.rankRequests = fetchCounts.rank;
    unsubscribe.current();
    try {
      releaseHeld();
      if (renderer) {
        const r = renderer as TestRenderer.ReactTestRenderer;
        await act(async () => {
          r.unmount();
        });
      }
      await settle();
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
      getDb().close();
      mockGate.real?.close();
      mockGate.real = null;
      setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
      useConsistencyStore.setState(initialConsistency, true);
      useApiSessionStore.setState(initialSession, true);
      const gc = (globalThis as { gc?: () => void }).gc;
      if (gc) gc();
      record.heapUsedMb = Math.round(process.memoryUsage().heapUsed / 1048576);
    }
  }
  return record;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describe('ProgressScreen rapid-interaction stress (real navigator + stores)', () => {
  beforeAll(() => {
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
  });

  afterAll(() => {
    process.off('unhandledRejection', onUnhandled);
    if (REPORT_PATH) {
      const fs = require('fs') as {
        mkdirSync(path: string, options: { recursive: boolean }): void;
        writeFileSync(path: string, data: string): void;
      };
      const path = require('path') as { dirname(p: string): string };
      fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
      fs.writeFileSync(
        REPORT_PATH,
        JSON.stringify(
          {
            unit: 'scr-progressscreen',
            lens: 'rapid-interaction',
            baseSeed: BASE_SEED,
            scenarios: SCENARIOS,
            burstsPerScenario: BURSTS_PER_SCENARIO,
            totals: {
              scenarios: results.length,
              bursts: results.reduce((a, r) => a + r.bursts, 0),
              taps: results.reduce((a, r) => a + r.taps, 0),
              broken: results.filter(r => r.outcome === 'BROKEN').length,
              kinds: results.reduce<Record<string, number>>((acc, r) => {
                for (const [k, v] of Object.entries(r.kinds)) {
                  acc[k] = (acc[k] ?? 0) + v;
                }
                return acc;
              }, {}),
            },
            results,
          },
          null,
          2,
        ),
      );
    }
  });

  it.each(SEEDS)('seed %d survives its interaction bursts', async seed => {
    const result = await runScenario(seed);
    results.push(result);
    if (result.outcome === 'BROKEN') {
      throw new Error(result.error ?? 'unknown failure');
    }
    expect(result.bursts).toBe(BURSTS_PER_SCENARIO);
  });
});

// ---------------------------------------------------------------------------
// Deterministic probes for the two behaviours the seeded campaign surfaced.
// They are `it.failing`: the suite stays green while the behaviour is present
// and turns red the day it is fixed, so the expectation can be flipped.
// ---------------------------------------------------------------------------
interface World {
  root: Instance;
  tab(label: string): Instance;
  progress(): Instance;
  teardown(): Promise<void>;
}

async function bootWorld(signedIn: boolean): Promise<World> {
  jest.useFakeTimers();
  jest.setSystemTime(NOW_MS);
  mockGate.real = new DatabaseSync(':memory:');
  mockGate.factsLoads = 0;
  mockGate.captureLoads = 0;
  mockGate.modes = [];
  mockGate.held = [];
  mockGate.dbPlan = () => 'ok';
  fetchCounts.progress = 0;
  fetchCounts.rank = 0;
  fetchCounts.other = 0;
  fetchPlan = () => 'ok';
  useConsistencyStore.setState(initialConsistency, true);
  useAppStore.setState(initialApp, true);
  useRankCelebrationStore.setState(initialRank, true);
  useApiSessionStore.setState(initialSession, true);
  installFetch();
  const rng = new Rng(1);
  await seedDatabase(rng, {
    seed: 1,
    signedIn,
    shots: 4,
    practiceSetAttempts: 0,
    captures: 0,
    dbPlan: [],
    fetchPlan: [],
  });
  if (signedIn) {
    useApiSessionStore.setState({
      session: {
        apiBaseUrl: 'https://stress.invalid',
        bearerToken: 'stress-token',
        canonicalAppUserId: OWNER,
        provider: 'apple',
      },
    });
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<RootNavigator />);
  });
  await settle();
  const root = renderer.root;
  const tab = (label: string) => {
    const bar = root.findAllByType(PremiumTabBar)[0];
    const node = bar ? byLabel(bar, label)[0] : undefined;
    if (!node) throw new Error(`no tab ${label}`);
    return node;
  };
  const progress = () => {
    const node = root.findAllByType(ProgressScreen)[0];
    if (!node) throw new Error('ProgressScreen not mounted');
    return node;
  };
  return {
    root,
    tab,
    progress,
    teardown: async () => {
      releaseHeld();
      await act(async () => {
        renderer.unmount();
      });
      await settle();
      getDb().close();
      mockGate.real?.close();
      mockGate.real = null;
      setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
      useConsistencyStore.setState(initialConsistency, true);
      useApiSessionStore.setState(initialSession, true);
    },
  };
}

describe('ProgressScreen rapid-interaction known defects (pinned)', () => {
  it.failing(
    'KNOWN DEFECT P3: each practice → technique section toggle issues a new GET /v1/rank (PlayerRankCard remounts; no dedupe)',
    async () => {
      const world = await bootWorld(true);
      try {
        await act(async () => {
          tap(world.tab('Progress'), new Rng(2));
        });
        await settle();
        expect(mockGate.factsLoads).toBe(1);
        expect(fetchCounts.rank).toBe(1);
        for (let i = 0; i < 3; i++) {
          await act(async () => {
            const node = byLabel(world.progress(), 'practice progress')[0];
            if (node) node.props.onPress({ nativeEvent: {} });
          });
          await act(async () => {
            const node = byLabel(world.progress(), 'technique progress')[0];
            if (node) node.props.onPress({ nativeEvent: {} });
          });
          await settle();
        }
        // Intent: switch sections. Expected: no new network request.
        expect(fetchCounts.rank).toBe(1);
      } finally {
        await world.teardown();
      }
    },
  );

  it.failing(
    'KNOWN DEFECT P3: a stack push and a tab jump dispatched in one batch leave ProgressScreen focus-stale (no reload when it is next focused)',
    async () => {
      const world = await bootWorld(false);
      try {
        await act(async () => {
          tap(world.tab('Progress'), new Rng(3));
        });
        await settle();
        expect(mockGate.factsLoads).toBe(1);

        // Same JS batch: navigate('StreakCalendar') from the screen + jump to
        // the Home tab. Not reachable with one finger; reachable by any code
        // path that dispatches two actions across navigators in one tick.
        const trace: string[] = [];
        const snap = (label: string) =>
          trace.push(
            `${label}: routes=${rootRoutes()
              .map(r => r.name)
              .join(
                '>',
              )} tab=${focusedTab()} loads=${mockGate.factsLoads} streakMounted=${
              world.root.findAllByType(StreakCalendarScreen).length
            }`,
          );
        await act(async () => {
          const card = byLabelPrefix(world.progress(), 'Consistency.')[0];
          if (!card) throw new Error('no consistency card');
          card.props.onPress({ nativeEvent: {} });
          world.tab('Home').props.onPress({ nativeEvent: {} });
          card.props.onPress({ nativeEvent: {} });
        });
        await settle();
        snap('after batch');
        const streak = world.root.findAllByType(StreakCalendarScreen)[0];
        if (streak) {
          await act(async () => {
            const back = byLabel(streak, 'Back')[0];
            if (!back) throw new Error('no Back');
            back.props.onPress({ nativeEvent: {} });
          });
          await settle();
          snap('after back');
        }
        if (focusedTab() !== 'Performance') {
          await act(async () => {
            world.tab('Progress').props.onPress({ nativeEvent: {} });
          });
          await settle();
          snap('after Progress tab');
        }
        expect(focusedTab()).toBe('Performance');
        // Intent: Progress regained focus → one fresh local load expected.
        expect({ loads: mockGate.factsLoads, trace }).toEqual({
          loads: 2,
          trace,
        });
      } finally {
        await world.teardown();
      }
    },
  );
});
