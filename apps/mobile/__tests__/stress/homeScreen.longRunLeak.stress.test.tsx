/**
 * STRESS · unit `scr-homescreen` · lens `long-run-leak`
 *
 * Mounts the REAL HomeScreen inside the real providers the app uses
 * (SafeAreaProvider → QueryClientProvider → NavigationContainer → native
 * stack → bottom tabs with the real PremiumTabBar) and cycles it
 * mount → settle → seeded interactions → unmount many times in ONE process.
 * Stores (app / consistency / notification / api-session / rank-celebration /
 * access / auth), hooks, navigation and the SQLite repository are the real
 * modules; only native boundaries are replaced:
 *   - `@op-engineering/op-sqlite`  → node:sqlite in-memory DB driven through
 *     the production migrations (`getDb()` runs LOCAL_MIGRATIONS for real),
 *     with seeded async latency / fault injection,
 *   - `react-native-linear-gradient` → plain View,
 *   - `react-native-safe-area-context` → the package's own jest mock,
 *   - `globalThis.fetch` → seeded canned responses for /v1/progress + /v1/rank
 *     (reanimated / notify-kit / keychain use the repo-wide __mocks__).
 *
 * Every iteration is a pure function of its 32-bit seed (dataset, session
 * state, latency, faults, interaction script), so any row of the JSON table
 * replays with `STRESS_REPLAY_SEEDS=<seed>`.
 *
 * Measurements (per LENS):
 *   - heap (`process.memoryUsage().heapUsed` after `global.gc()`) every
 *     STRESS_CHECKPOINT (default 50) iterations → linear-regression slope,
 *     expressed as % of the first checkpoint per 100 iterations; a monotone
 *     slope > 5 %/100 it is a failure,
 *   - open handles (`process.getActiveResourcesInfo()`) at every checkpoint
 *     and at the end vs. the pre-campaign baseline,
 *   - listeners/subscriptions: zustand subscriber counts for every real store
 *     HomeScreen (and the tab bar) touch, RN AppState/Linking/Dimensions/
 *     Keyboard listener adds vs. removes, StatusBar props stack depth,
 *     walkthrough target registry, react-query observers, in-flight DB /
 *     fetch calls,
 *   - mount-to-settled time per iteration → drift (median of the last decile
 *     vs. the first decile).
 *
 * Knobs (all optional):
 *   STRESS_ITER=<n>          iterations (default 40 so the suite stays fast;
 *                            the campaign the lens asks for is ≥ 500)
 *   STRESS_SEED=<n>          campaign seed (default 20260904)
 *   STRESS_CHECKPOINT=<n>    heap/handle sampling period (default 50)
 *   STRESS_REPLAY_SEEDS=a,b  run exactly these iteration seeds instead
 *   STRESS_OUT=<file.json>   write the seed → outcome table + metrics
 *
 * Run the full campaign with GC exposed:
 *   STRESS_ITER=500 STRESS_OUT=/tmp/home-leak.json \
 *     node --expose-gc node_modules/.bin/jest --ci --silent \
 *     __tests__/stress/homeScreen.longRunLeak.stress.test.tsx
 */
import React from 'react';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import TestRenderer, { act } from 'react-test-renderer';
import {
  AppState,
  Dimensions,
  Keyboard,
  Linking,
  StatusBar,
} from 'react-native';
import type { ShotAnalysis, ShotTypeSlug } from '@pickle/shared-types';

// apps/mobile types only `jest` (no @types/node); declare the exact Node
// surface this harness drives, like dbMigrationMalformedOutbox.test.ts does.
declare const require: (id: string) => unknown;
declare const process: {
  env: Record<string, string | undefined>;
  memoryUsage(): { heapUsed: number; rss: number; external: number };
  getActiveResourcesInfo(): string[];
};
declare const global: { gc?: () => void };

interface SqliteStatement {
  all(...params: (string | number | null)[]): Record<string, unknown>[];
  run(...params: (string | number | null)[]): unknown;
}
interface DatabaseSync {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (location: string) => DatabaseSync;
};
const fs = require('fs') as {
  writeFileSync(path: string, data: string): void;
  mkdirSync(path: string, opts: { recursive: boolean }): void;
};
const nodePath = require('path') as { dirname(p: string): string };

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) — every iteration derives from one 32-bit seed.
// ---------------------------------------------------------------------------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash32(a: number, b: number): number {
  let h = (a ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (b >>> 0), 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}
type Rng = () => number;
const int = (rng: Rng, lo: number, hi: number) =>
  lo + Math.floor(rng() * (hi - lo + 1));
const pick = <T,>(rng: Rng, items: readonly T[]): T =>
  items[Math.floor(rng() * items.length)]!;
const chance = (rng: Rng, p: number) => rng() < p;

// ---------------------------------------------------------------------------
// Native mock: op-sqlite → node:sqlite, with seeded latency + fault injection.
// ---------------------------------------------------------------------------
const mockSqlite = {
  real: null as DatabaseSync | null,
  /** Max async latency (ms) for db.execute; 0 = resolve on a microtask. */
  latencyMs: 0,
  rng: mulberry32(1) as Rng,
  /** Number of upcoming HomeScreen history reads (listShots /
   * listRealAnalysisFacts: `FROM local_shot … ORDER BY captured_at DESC`)
   * that must reject. The consistency store's listActivityShots (ASC) races
   * those reads and swallows its own failures, so it is not a target. */
  failNextReads: 0,
  inFlight: 0,
  totalExecutes: 0,
  opens: 0,
};

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    const db = mockSqlite.real;
    if (!db) throw new Error('harness did not create the sqlite database');
    mockSqlite.opens += 1;
    return {
      executeSync: (sql: string) => ({ rows: db.prepare(sql).all() }),
      execute: async (sql: string, params: unknown[] = []) => {
        mockSqlite.inFlight += 1;
        mockSqlite.totalExecutes += 1;
        try {
          if (mockSqlite.latencyMs > 0) {
            const wait = Math.floor(mockSqlite.rng() * mockSqlite.latencyMs);
            await new Promise<void>(resolve => setTimeout(resolve, wait));
          } else {
            await Promise.resolve();
          }
          if (
            mockSqlite.failNextReads > 0 &&
            /^\s*SELECT/i.test(sql) &&
            /FROM local_shot[\s\S]*ORDER BY captured_at DESC/i.test(sql)
          ) {
            mockSqlite.failNextReads -= 1;
            throw new Error('injected sqlite read failure');
          }
          const statement = db.prepare(sql);
          const bound = params as (string | number | null)[];
          if (/^\s*(SELECT|PRAGMA)/i.test(sql)) {
            return { rows: statement.all(...bound) };
          }
          statement.run(...bound);
          return { rows: [] };
        } finally {
          mockSqlite.inFlight -= 1;
        }
      },
      close: () => {},
    };
  },
}));

jest.mock('react-native-linear-gradient', () => {
  const React = require('react') as typeof import('react');
  const { View } = require('react-native') as typeof import('react-native');
  return {
    __esModule: true,
    default: (props: {
      children?: React.ReactNode;
      style?: React.ComponentProps<typeof View>['style'];
    }) => React.createElement(View, { style: props.style }, props.children),
  };
});

jest.mock('react-native-safe-area-context', () => {
  const mock = jest.requireActual<{ default: Record<string, unknown> }>(
    'react-native-safe-area-context/jest/mock',
  );
  return mock.default;
});

// Subscription accounting: zustand's bound hooks subscribe through the
// vanilla api captured inside `create`, so the only seam that sees every
// React subscription is `create` itself. Behaviour is the real library's;
// the wrapper only counts live listeners per store.
jest.mock('zustand', () => {
  const actual = jest.requireActual<typeof import('zustand')>('zustand');
  const live = new Map<object, number>();
  const create = (
    initializer?: import('zustand').StateCreator<unknown>,
  ): unknown => {
    if (initializer === undefined) return create;
    const api = actual.createStore<unknown>(initializer);
    const hook = (selector?: (s: unknown) => unknown) =>
      actual.useStore(wrapped as never, selector as never);
    const wrapped = {
      ...api,
      subscribe: (listener: Parameters<typeof api.subscribe>[0]) => {
        live.set(hook, (live.get(hook) ?? 0) + 1);
        const unsubscribe = api.subscribe(listener);
        let done = false;
        return () => {
          if (done) return;
          done = true;
          live.set(hook, (live.get(hook) ?? 0) - 1);
          unsubscribe();
        };
      },
    };
    Object.assign(hook, wrapped);
    return hook;
  };
  return { ...actual, create, __liveSubscribers: live };
});

// ---------------------------------------------------------------------------
// Native mock: fetch (only /v1/progress + /v1/rank are reachable from Home).
// ---------------------------------------------------------------------------
const mockFetchState = {
  mode: 'ok' as 'ok' | 'http500' | 'network' | 'slow-ok',
  rng: mulberry32(2) as Rng,
  inFlight: 0,
  total: 0,
};
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}
function progressBody(rng: Rng) {
  const days = int(rng, 0, 12);
  return {
    series: [],
    improving: [],
    needsAttention: [],
    streak: {
      currentDays: days,
      longestDays: days + int(rng, 0, 20),
      practicedToday: chance(rng, 0.5),
      lastPracticeDate: '2026-09-01',
    },
  };
}
function rankBody(rng: Rng) {
  if (chance(rng, 0.3)) return { rank: null };
  return {
    rank: {
      tier: pick(rng, ['bronze', 'silver', 'gold', 'platinum', 'diamond']),
      rating: Number((2 + rng() * 6).toFixed(2)),
      confidence: Number(rng().toFixed(2)),
      techniqueCount: int(rng, 1, 8),
      scoredShotCount: int(rng, 1, 40),
      updatedAt: '2026-09-01T00:00:00.000Z',
      techniques: [],
    },
  };
}
const fetchSpy = jest.fn(async (input: unknown): Promise<Response> => {
  mockFetchState.inFlight += 1;
  mockFetchState.total += 1;
  try {
    const url = String(input);
    if (mockFetchState.mode === 'slow-ok') {
      await new Promise<void>(resolve =>
        setTimeout(resolve, int(mockFetchState.rng, 1, 4)),
      );
    } else {
      await Promise.resolve();
    }
    if (mockFetchState.mode === 'network')
      throw new TypeError('Network request failed');
    if (mockFetchState.mode === 'http500')
      return jsonResponse(500, { error: 'x' });
    if (url.endsWith('/v1/progress')) {
      return jsonResponse(200, progressBody(mockFetchState.rng));
    }
    if (url.endsWith('/v1/rank'))
      return jsonResponse(200, rankBody(mockFetchState.rng));
    return jsonResponse(404, { error: 'unrouted' });
  } finally {
    mockFetchState.inFlight -= 1;
  }
});
(globalThis as { fetch: unknown }).fetch = fetchSpy;

// ---------------------------------------------------------------------------
// Real modules under test (imported AFTER the native mocks are registered).
// ---------------------------------------------------------------------------
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  NavigationContainer,
  createNavigationContainerRef,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { HomeScreen, WEEK_CHART_KV_KEY } from '../../src/screens/HomeScreen';
import { PremiumTabBar } from '../../src/navigation/PremiumTabBar';
import type {
  MainTabParams,
  RootStackParams,
} from '../../src/navigation/params';
import { getDb } from '../../src/data/db';
import {
  saveAnalysis,
  saveLocalOnlyAnalysis,
  setKv,
} from '../../src/data/repository';
import {
  GUEST_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { useAppStore } from '../../src/state/appStore';
import { useConsistencyStore } from '../../src/consistency/store';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import {
  clearApiSession,
  establishApiSession,
  useApiSessionStore,
} from '../../src/account/apiSession';
import { useRankCelebrationStore } from '../../src/progress/rankCelebration';
import { useAccessStore } from '../../src/state/accessStore';
import { useAuthStore } from '../../src/auth/authStore';
import { hasWalkthroughTarget } from '../../src/walkthrough/targets';

// ---------------------------------------------------------------------------
// Real provider / navigator tree (mirrors App.tsx → RootNavigator → MainTabs).
// ---------------------------------------------------------------------------
const Stack = createNativeStackNavigator<RootStackParams>();
const Tabs = createBottomTabNavigator<MainTabParams>();
const navigationRef = createNavigationContainerRef<RootStackParams>();
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

/** Sibling routes Home navigates to; they are not the unit under test. */
function RouteSink() {
  return null;
}

function MainTabs() {
  return (
    <Tabs.Navigator
      tabBar={props => <PremiumTabBar {...props} />}
      screenOptions={{ headerShown: false, tabBarHideOnKeyboard: true }}
    >
      <Tabs.Screen name="Home" component={HomeScreen} />
      <Tabs.Screen name="Library" component={RouteSink} />
      <Tabs.Screen name="Add" component={RouteSink} />
      <Tabs.Screen name="Performance" component={RouteSink} />
      <Tabs.Screen name="Settings" component={RouteSink} />
    </Tabs.Navigator>
  );
}

const unhandledActions: string[] = [];

function Harness() {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <NavigationContainer
          ref={navigationRef}
          onUnhandledAction={action => unhandledActions.push(action.type)}
        >
          <Stack.Navigator screenOptions={{ headerShown: false }}>
            <Stack.Screen name="Tabs" component={MainTabs} />
            <Stack.Screen name="Analyze" component={RouteSink} />
            <Stack.Screen name="Result" component={RouteSink} />
            <Stack.Screen name="ResultDetails" component={RouteSink} />
            <Stack.Screen name="FormReview" component={RouteSink} />
            <Stack.Screen name="DrillLibrary" component={RouteSink} />
            <Stack.Screen name="StreakCalendar" component={RouteSink} />
            <Stack.Screen name="ConnectAccount" component={RouteSink} />
            <Stack.Screen name="ManageAccount" component={RouteSink} />
            <Stack.Screen name="ConsentSettings" component={RouteSink} />
            <Stack.Screen name="NotificationSettings" component={RouteSink} />
            <Stack.Screen name="Paywall" component={RouteSink} />
          </Stack.Navigator>
        </NavigationContainer>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

// ---------------------------------------------------------------------------
// Listener / subscription accounting.
// ---------------------------------------------------------------------------
const STORES: Record<string, object> = {
  appStore: useAppStore,
  consistencyStore: useConsistencyStore,
  notificationStore: useNotificationStore,
  apiSessionStore: useApiSessionStore,
  rankCelebrationStore: useRankCelebrationStore,
  accessStore: useAccessStore,
  authStore: useAuthStore,
};
const liveSubscribers = (
  jest.requireMock('zustand') as { __liveSubscribers: Map<object, number> }
).__liveSubscribers;
function storeSubscriberCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [name, hook] of Object.entries(STORES)) {
    counts[name] = liveSubscribers.get(hook) ?? 0;
  }
  return counts;
}
/** Highest per-store subscriber count observed while a tree was mounted —
 * proves the accounting sees the real subscriptions it later expects gone. */
const peakSubscribers: Record<string, number> = {};
let peakRnListenersOpen = 0;
function recordPeaks() {
  for (const [name, count] of Object.entries(storeSubscriberCounts())) {
    peakSubscribers[name] = Math.max(peakSubscribers[name] ?? 0, count);
  }
  peakRnListenersOpen = Math.max(
    peakRnListenersOpen,
    rnListeners.added - rnListeners.removed,
  );
}

const rnListeners = { added: 0, removed: 0 };
function trackEmitter(
  target: { addEventListener?: unknown; addListener?: unknown },
  method: 'addEventListener' | 'addListener',
) {
  const original = target[method] as (...args: unknown[]) => {
    remove: () => void;
  };
  if (typeof original !== 'function') return;
  (target as Record<string, unknown>)[method] = (...args: unknown[]) => {
    rnListeners.added += 1;
    const subscription = original.apply(target, args);
    let removed = false;
    const originalRemove = subscription.remove.bind(subscription);
    subscription.remove = () => {
      if (removed) return;
      removed = true;
      rnListeners.removed += 1;
      originalRemove();
    };
    return subscription;
  };
}
trackEmitter(AppState, 'addEventListener');
trackEmitter(Linking, 'addEventListener');
trackEmitter(Dimensions, 'addEventListener');
trackEmitter(Keyboard, 'addListener');

type StatusBarWithStack = typeof StatusBar & { _propsStack: unknown[] };
const statusBarStackDepth = () =>
  (StatusBar as StatusBarWithStack)._propsStack.length;

function activeResources(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const kind of process.getActiveResourcesInfo()) {
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Dataset generation through the REAL repository (production SQL).
// ---------------------------------------------------------------------------
const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';
const SHOT_TYPES: readonly ShotTypeSlug[] = [
  'forehand_drive',
  'backhand_drive',
  'dink',
  'volley',
  'serve',
  'return',
  'third_shot_drop',
  'overhead',
];
const CHECKPOINTS = ['paddle_prep', 'contact_point', 'follow_through'];
const NOW_MS = Date.parse('2026-09-04T18:00:00.000Z');

function uuidFrom(rng: Rng): string {
  const hex = () => Math.floor(rng() * 16).toString(16);
  const seg = (n: number) => Array.from({ length: n }, hex).join('');
  return `${seg(8)}-${seg(4)}-4${seg(3)}-8${seg(3)}-${seg(12)}`;
}

function makeAnalysis(rng: Rng, index: number): ShotAnalysis {
  const scored = chance(rng, 0.75);
  const score = Number((3 + rng() * 6.9).toFixed(1));
  const daysBack = chance(rng, 0.7) ? int(rng, 0, 6) : int(rng, 7, 40);
  const capturedAt = new Date(
    NOW_MS - daysBack * 86_400_000 - index * 60_000 - int(rng, 0, 3_600_000),
  ).toISOString();
  const shotType = pick(rng, SHOT_TYPES);
  const modelVersion = chance(rng, 0.85) ? 'score-1' : 'score-0';
  return {
    id: uuidFrom(rng),
    sessionId: chance(rng, 0.4) ? uuidFrom(rng) : null,
    shotType,
    cameraView: 'side',
    handedness: chance(rng, 0.5) ? 'right' : 'left',
    capturedAtIso: capturedAt,
    timestamps: { startMs: 0, contactMs: 900, endMs: 1800 },
    phases: [],
    measurements: [],
    checkpoints: scored
      ? CHECKPOINTS.map(key => ({
          key,
          applicable: chance(rng, 0.9),
          score: Number((rng() * 10).toFixed(1)),
          label: key,
          verdict: 'ok',
          detail: '',
        }))
      : [],
    overallScore: scored ? score : null,
    analysisConfidence: scored ? Number((0.6 + rng() * 0.4).toFixed(2)) : 0.2,
    resultKind: scored ? 'scored' : 'low_confidence',
    guidance: null,
    priorityFix: scored
      ? {
          checkpoint: pick(rng, CHECKPOINTS),
          title: 'Focus',
          detail: 'Keep the paddle up.',
          drillSlug: null,
        }
      : null,
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'validated-bundle-1',
      poseModelVersion: 'pose-1',
      paddleModelVersion: 'paddle-1',
      strokeDetectorVersion: 'stroke-1',
      phaseModelVersion: 'phase-1',
      scoringModelVersion: modelVersion,
      shotConfigVersion: `${shotType}@1`,
    },
    source: 'real',
  } as unknown as ShotAnalysis;
}

type SessionKind = 'guest' | 'signed-in' | 'signed-in-other-owner';
interface Scenario {
  seed: number;
  owner: string;
  session: SessionKind;
  shots: number;
  weekChartKv: 'scores' | 'reads' | 'garbage' | 'none';
  profile: boolean;
  latencyMs: number;
  fetch: typeof mockFetchState.mode;
  failReads: number;
  notificationPrimed: boolean;
  script: Action[];
}
type Action =
  | 'toggle-chart'
  | 'refresh'
  | 'streak'
  | 'rank-banner'
  | 'rank-banner-twice'
  | 'analyze'
  | 'drills'
  | 'recent'
  | 'tab-away-back'
  | 'retry'
  | 'unmount-mid-load';

function buildScenario(seed: number): Scenario {
  const rng = mulberry32(seed);
  const session = pick<SessionKind>(rng, [
    'guest',
    'guest',
    'signed-in',
    'signed-in',
    'signed-in-other-owner',
  ]);
  const failReads = chance(rng, 0.12) ? int(rng, 1, 3) : 0;
  const actions: Action[] = [];
  const count = int(rng, 0, 4);
  const pool: Action[] = [
    'toggle-chart',
    'refresh',
    'streak',
    'rank-banner',
    'rank-banner-twice',
    'analyze',
    'drills',
    'recent',
    'tab-away-back',
  ];
  for (let i = 0; i < count; i += 1) actions.push(pick(rng, pool));
  if (failReads > 0) actions.unshift('retry');
  if (chance(rng, 0.15)) actions.push('unmount-mid-load');
  return {
    seed,
    owner: session === 'guest' ? GUEST_DATA_OWNER : OWNER_A,
    session,
    shots: chance(rng, 0.2) ? 0 : int(rng, 1, 45),
    weekChartKv: pick(rng, ['scores', 'reads', 'garbage', 'none', 'none']),
    profile: chance(rng, 0.7),
    latencyMs: chance(rng, 0.5) ? int(rng, 1, 4) : 0,
    fetch: pick(rng, ['ok', 'ok', 'http500', 'network', 'slow-ok']),
    failReads,
    notificationPrimed: chance(rng, 0.5),
    script: actions,
  };
}

function resetDatabase() {
  const db = mockSqlite.real;
  if (!db) throw new Error('no database');
  for (const table of [
    'local_shot',
    'outbox',
    'kv',
    'local_session',
    'local_capture',
    'sync_receipt',
    'local_analysis_record',
  ]) {
    db.exec(`DELETE FROM ${table}`);
  }
}

async function seedScenario(scenario: Scenario) {
  const rng = mulberry32(hash32(scenario.seed, 7));
  mockSqlite.latencyMs = 0;
  mockSqlite.failNextReads = 0;
  mockSqlite.rng = mulberry32(hash32(scenario.seed, 11));
  mockFetchState.rng = mulberry32(hash32(scenario.seed, 13));
  mockFetchState.mode = scenario.fetch;
  setActiveDataOwner(scenario.owner);
  // Production open + LOCAL_MIGRATIONS on first call; a singleton afterwards.
  const db = getDb();
  resetDatabase();
  for (let i = 0; i < scenario.shots; i += 1) {
    const analysis = makeAnalysis(rng, i);
    if (analysis.resultKind === 'scored') {
      await saveAnalysis(db, analysis, uuidFrom(rng));
    } else {
      await saveLocalOnlyAnalysis(db, analysis);
    }
  }
  if (scenario.weekChartKv !== 'none') {
    await setKv(
      db,
      WEEK_CHART_KV_KEY,
      scenario.weekChartKv === 'garbage' ? '{"nope":1}' : scenario.weekChartKv,
    );
  }

  if (scenario.session === 'guest') {
    clearApiSession();
  } else {
    establishApiSession({
      apiBaseUrl: 'https://api.example.test',
      bearerToken: 'stress-bearer',
      canonicalAppUserId: scenario.session === 'signed-in' ? OWNER_A : OWNER_B,
      provider: 'apple',
    });
  }
  useAppStore.setState({
    hydrated: true,
    ownerKey: scenario.owner,
    profile: scenario.profile
      ? {
          name: `Player ${scenario.seed % 97}`,
          gender: 'prefer_not_to_say',
          skillLevel: pick(rng, ['beginner', 'intermediate', 'advanced']),
          goal: pick(rng, ['consistency', 'power', 'placement']),
          focus: pick(rng, ['forehand_drive', 'backhand_dink', 'serve']),
        }
      : null,
  } as Partial<ReturnType<typeof useAppStore.getState>>);
  useNotificationStore.setState({
    hydrated: true,
    ownerKey: scenario.owner,
    prefs: {
      ...useNotificationStore.getState().prefs,
      enabled: false,
      promptDismissed: !scenario.notificationPrimed,
    },
    permission: 'unknown',
  });
  useConsistencyStore.setState({
    hydrated: false,
    ownerKey: null,
    snapshot: null,
    loadError: false,
    celebration: null,
    daySecured: null,
  });
  useRankCelebrationStore.setState(useRankCelebrationStore.getInitialState());

  // Latency / faults apply to the screen's own reads, not to the seeding.
  mockSqlite.latencyMs = scenario.latencyMs;
  mockSqlite.failNextReads = scenario.failReads;
}

// ---------------------------------------------------------------------------
// Render helpers.
// ---------------------------------------------------------------------------
const sleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

/** Drains microtasks, seeded DB/fetch latency and RN's setImmediate batches. */
async function settle(maxLatencyMs: number) {
  await act(async () => {
    for (let round = 0; round < 6; round += 1) {
      await sleep(maxLatencyMs + 1);
      if (
        mockSqlite.inFlight === 0 &&
        mockFetchState.inFlight === 0 &&
        round >= 1
      ) {
        break;
      }
    }
  });
}

function findByTestId(root: ReactTestInstance, testID: string) {
  return (
    root.findAll(
      n => n.props?.testID === testID && typeof n.props.onPress === 'function',
    )[0] ?? null
  );
}
function findByLabelPrefix(root: ReactTestInstance, prefix: string) {
  return (
    root.findAll(
      n =>
        typeof n.props?.accessibilityLabel === 'string' &&
        n.props.accessibilityLabel.startsWith(prefix) &&
        typeof n.props.onPress === 'function',
    )[0] ?? null
  );
}

async function press(node: ReactTestInstance | null) {
  if (!node) return false;
  await act(async () => {
    node.props.onPress();
  });
  return true;
}

interface IterationResult {
  index: number;
  seed: number;
  outcome: 'HELD' | 'BROKEN';
  ms: number;
  scenario: Omit<Scenario, 'seed'>;
  detail?: string;
  state: 'loaded' | 'error' | 'loading' | 'unmounted-early';
  actionsRun: number;
}

function withoutSeed(scenario: Scenario): Omit<Scenario, 'seed'> {
  const copy: Partial<Scenario> = { ...scenario };
  delete copy.seed;
  return copy as Omit<Scenario, 'seed'>;
}

async function runIteration(
  index: number,
  seed: number,
): Promise<IterationResult> {
  const scenario = buildScenario(seed);
  await seedScenario(scenario);
  const started = performance.now();
  let renderer!: ReactTestRenderer;
  let state: IterationResult['state'] = 'loading';
  let actionsRun = 0;
  let detail: string | undefined;
  let outcome: IterationResult['outcome'] = 'HELD';
  const consoleErrors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(' '));
  };
  try {
    await act(async () => {
      renderer = TestRenderer.create(<Harness />);
    });
    const earlyUnmount = scenario.script.includes('unmount-mid-load');
    if (!earlyUnmount) {
      await settle(scenario.latencyMs + (scenario.fetch === 'slow-ok' ? 4 : 0));
      const root = renderer.root;
      const errorRetry = findByLabelPrefix(root, 'Try again');
      if (scenario.failReads > 0) {
        // The injected read failure must surface as the error state, and
        // retry must recover (the injected fault is consumed).
        if (!errorRetry) {
          outcome = 'BROKEN';
          detail = 'injected read failure did not produce the error state';
        }
      }
      for (const action of scenario.script) {
        actionsRun += 1;
        switch (action) {
          case 'retry': {
            const retry = findByLabelPrefix(renderer.root, 'Try again');
            if (retry) {
              mockSqlite.failNextReads = 0;
              await press(retry);
              await settle(scenario.latencyMs + 4);
            }
            break;
          }
          case 'toggle-chart': {
            const target =
              findByTestId(renderer.root, 'home-week-chart-reads') ??
              findByTestId(renderer.root, 'home-week-chart-scores');
            await press(target);
            await settle(scenario.latencyMs);
            break;
          }
          case 'refresh': {
            const rc = renderer.root.findAll(
              n => typeof n.props?.onRefresh === 'function',
            )[0];
            if (rc) {
              await act(async () => {
                rc.props.onRefresh();
              });
              await settle(scenario.latencyMs + 4);
            }
            break;
          }
          case 'streak': {
            const streak =
              findByTestId(renderer.root, 'player-rank-banner-streak') ??
              findByTestId(renderer.root, 'home-streak-badge');
            if (await press(streak)) {
              await settle(0);
              await act(async () => {
                if (navigationRef.isReady() && navigationRef.canGoBack()) {
                  navigationRef.goBack();
                }
              });
              await settle(scenario.latencyMs + 4);
            }
            break;
          }
          case 'rank-banner':
          case 'rank-banner-twice': {
            const toggle = findByTestId(
              renderer.root,
              'player-rank-banner-toggle',
            );
            if (await press(toggle)) {
              await settle(0);
              if (action === 'rank-banner-twice') {
                await press(
                  findByTestId(renderer.root, 'player-rank-banner-toggle'),
                );
                await settle(0);
              }
            }
            break;
          }
          case 'analyze':
          case 'drills': {
            const target = findByLabelPrefix(
              renderer.root,
              action === 'analyze' ? 'Stroke Analysis' : 'Drill Library',
            );
            if (await press(target)) {
              await settle(0);
              await act(async () => {
                if (navigationRef.isReady() && navigationRef.canGoBack()) {
                  navigationRef.goBack();
                }
              });
              await settle(scenario.latencyMs + 4);
            }
            break;
          }
          case 'recent': {
            const target = findByLabelPrefix(renderer.root, 'Open ');
            if (await press(target)) {
              await settle(0);
              await act(async () => {
                if (navigationRef.isReady() && navigationRef.canGoBack()) {
                  navigationRef.goBack();
                }
              });
              await settle(scenario.latencyMs + 4);
            }
            break;
          }
          case 'tab-away-back': {
            await act(async () => {
              navigationRef.navigate('Tabs', { screen: 'Library' });
            });
            await settle(0);
            await act(async () => {
              navigationRef.navigate('Tabs', { screen: 'Home' });
            });
            await settle(scenario.latencyMs + 4);
            break;
          }
          case 'unmount-mid-load':
            break;
        }
      }
      recordPeaks();
      const root2 = renderer.root;
      if (findByLabelPrefix(root2, 'Try again')) state = 'error';
      else if (
        root2.findAll(n => n.props?.testID === 'player-rank-banner').length > 0
      ) {
        state = 'loaded';
      } else {
        state = 'loading';
      }
      if (state === 'loading') {
        outcome = 'BROKEN';
        detail = 'screen never left the loading state';
      }
      if (state === 'error' && scenario.failReads === 0) {
        outcome = 'BROKEN';
        detail = 'error state without an injected fault';
      }
    } else {
      recordPeaks();
      state = 'unmounted-early';
    }
    await act(async () => {
      renderer.unmount();
    });
    // Let anything the unmount left in flight (DB reads, fetches, RN
    // batches) resolve so a leak is attributable to the screen, not timing.
    await settle(scenario.latencyMs + 6);
  } catch (error) {
    outcome = 'BROKEN';
    detail =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    try {
      await act(async () => {
        renderer?.unmount();
      });
    } catch {
      // Already torn down.
    }
  } finally {
    console.error = originalError;
    // The RN jest preset wraps performance.now and every NativeAnimatedModule
    // method in jest.fn(), whose call/result ledgers retain each cycle's
    // animation closures (and, through them, fibers and navigation objects)
    // forever. That ledger is test-runner bookkeeping, not app memory; drop
    // it so the heap slope measures HomeScreen. Implementations are kept.
    jest.clearAllMocks();
  }
  const realErrors = consoleErrors.filter(
    message =>
      !message.includes('not wrapped in act') &&
      !message.includes('ExperimentalWarning'),
  );
  if (realErrors.length > 0 && outcome === 'HELD') {
    outcome = 'BROKEN';
    detail = `console.error: ${realErrors[0]!.slice(0, 400)}`;
  }
  return {
    index,
    seed,
    outcome,
    ms: performance.now() - started,
    scenario: withoutSeed(scenario),
    detail,
    state,
    actionsRun,
  };
}

// ---------------------------------------------------------------------------
// Campaign.
// ---------------------------------------------------------------------------
interface Checkpoint {
  iteration: number;
  heapUsed: number;
  rss: number;
  external: number;
  resources: Record<string, number>;
  storeSubscribers: Record<string, number>;
  rnListenersOpen: number;
  statusBarDepth: number;
  medianMsSoFar: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function regressionSlope(points: { x: number; y: number }[]): number {
  const n = points.length;
  if (n < 2) return 0;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

function forceGc() {
  if (typeof global.gc === 'function') {
    global.gc();
    global.gc();
  }
}

async function sampleCheckpoint(
  iteration: number,
  durations: number[],
): Promise<Checkpoint> {
  await settle(8);
  forceGc();
  const mem = process.memoryUsage();
  return {
    iteration,
    heapUsed: mem.heapUsed,
    rss: mem.rss,
    external: mem.external,
    resources: activeResources(),
    storeSubscribers: storeSubscriberCounts(),
    rnListenersOpen: rnListeners.added - rnListeners.removed,
    statusBarDepth: statusBarStackDepth(),
    medianMsSoFar: median(durations.slice(-50)),
  };
}

const ITERATIONS = Number(process.env['STRESS_ITER'] ?? 40);
const CAMPAIGN_SEED = Number(process.env['STRESS_SEED'] ?? 20260904);
const CHECKPOINT_EVERY = Number(process.env['STRESS_CHECKPOINT'] ?? 50);
const REPLAY = (process.env['STRESS_REPLAY_SEEDS'] ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(Number);
const OUT = process.env['STRESS_OUT'];
const GC_AVAILABLE = typeof global.gc === 'function';
const HEAP_SLOPE_LIMIT_PCT_PER_100 = 5;

beforeAll(() => {
  mockSqlite.real = new DatabaseSync(':memory:');
});

afterAll(() => {
  mockSqlite.real?.close();
  mockSqlite.real = null;
});

describe(`HomeScreen long-run leak campaign (seed ${CAMPAIGN_SEED}, ${
  REPLAY.length > 0
    ? `replay ${REPLAY.length} seed(s)`
    : `${ITERATIONS} iterations`
})`, () => {
  // One process, one test: the whole point is accumulation across cycles.
  jest.setTimeout(30 * 60 * 1000);

  it('mount/unmount cycles return heap, handles, timers and subscriptions to baseline', async () => {
    const seeds =
      REPLAY.length > 0
        ? REPLAY
        : Array.from({ length: ITERATIONS }, (_, i) =>
            hash32(CAMPAIGN_SEED, i),
          );

    // Warm-up: pays module transforms / JIT so the baseline is a steady state.
    const warm = await runIteration(-1, hash32(CAMPAIGN_SEED, 0xffff));
    const baseline = await sampleCheckpoint(0, [warm.ms]);

    const results: IterationResult[] = [];
    const checkpoints: Checkpoint[] = [];
    const durations: number[] = [];
    for (let i = 0; i < seeds.length; i += 1) {
      const result = await runIteration(i, seeds[i]!);
      results.push(result);
      durations.push(result.ms);
      if ((i + 1) % CHECKPOINT_EVERY === 0) {
        checkpoints.push(await sampleCheckpoint(i + 1, durations));
      }
    }
    const final = await sampleCheckpoint(seeds.length, durations);
    if (
      checkpoints.length === 0 ||
      checkpoints[checkpoints.length - 1]!.iteration !== seeds.length
    ) {
      checkpoints.push(final);
    }

    // ---- heap slope -------------------------------------------------------
    const points = checkpoints.map(c => ({ x: c.iteration, y: c.heapUsed }));
    const slopePerIteration = regressionSlope(points);
    const referenceHeap = checkpoints[0]?.heapUsed ?? baseline.heapUsed;
    const slopePctPer100 = (slopePerIteration * 100 * 100) / referenceHeap;
    let increases = 0;
    for (let i = 1; i < checkpoints.length; i += 1) {
      if (checkpoints[i]!.heapUsed > checkpoints[i - 1]!.heapUsed)
        increases += 1;
    }
    const deltas = Math.max(1, checkpoints.length - 1);
    const monotoneFraction = increases / deltas;
    const heapGrowthPct =
      ((final.heapUsed - baseline.heapUsed) / baseline.heapUsed) * 100;

    // ---- timing drift -----------------------------------------------------
    const decile = Math.max(1, Math.floor(durations.length / 10));
    const firstMedian = median(durations.slice(0, decile));
    const lastMedian = median(durations.slice(-decile));
    const driftRatio = firstMedian > 0 ? lastMedian / firstMedian : 1;

    const broken = results.filter(r => r.outcome === 'BROKEN');
    const summary = {
      unit: 'scr-homescreen',
      lens: 'long-run-leak',
      campaignSeed: CAMPAIGN_SEED,
      iterationsRequested: seeds.length,
      iterationsExecuted: results.length,
      checkpointEvery: CHECKPOINT_EVERY,
      gcAvailable: GC_AVAILABLE,
      baseline,
      final,
      checkpoints,
      heap: {
        referenceHeap,
        slopeBytesPerIteration: slopePerIteration,
        slopePctPer100,
        monotoneFraction,
        growthPctBaselineToFinal: heapGrowthPct,
        limitPctPer100: HEAP_SLOPE_LIMIT_PCT_PER_100,
      },
      timing: {
        firstDecileMedianMs: firstMedian,
        lastDecileMedianMs: lastMedian,
        driftRatio,
        overallMedianMs: median(durations),
        p95Ms:
          [...durations].sort((a, b) => a - b)[
            Math.floor(durations.length * 0.95)
          ] ?? 0,
      },
      leaks: {
        storeSubscribersBaseline: baseline.storeSubscribers,
        storeSubscribersPeakWhileMounted: { ...peakSubscribers },
        storeSubscribersFinal: final.storeSubscribers,
        rnListenersOpenBaseline: baseline.rnListenersOpen,
        rnListenersOpenPeakWhileMounted: peakRnListenersOpen,
        rnListenersOpenFinal: final.rnListenersOpen,
        rnListenersAdded: rnListeners.added,
        rnListenersRemoved: rnListeners.removed,
        statusBarDepthBaseline: baseline.statusBarDepth,
        statusBarDepthFinal: final.statusBarDepth,
        walkthroughTargetsLive: (
          ['rank-banner', 'coach-fab', 'tab-library', 'tab-progress'] as const
        ).filter(hasWalkthroughTarget),
        reactQueryObservers: queryClient
          .getQueryCache()
          .getAll()
          .reduce((s, q) => s + q.getObserversCount(), 0),
        sqliteInFlight: mockSqlite.inFlight,
        fetchInFlight: mockFetchState.inFlight,
        sqliteOpens: mockSqlite.opens,
        sqliteExecutes: mockSqlite.totalExecutes,
        fetchCalls: mockFetchState.total,
        unhandledNavigationActions: unhandledActions.length,
        timeoutsBaseline: baseline.resources['Timeout'] ?? 0,
        timeoutsFinal: final.resources['Timeout'] ?? 0,
      },
      broken: broken.map(r => ({ seed: r.seed, detail: r.detail })),
      iterations: results,
    };

    if (OUT) {
      fs.mkdirSync(nodePath.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
    }

    // ---- invariants -------------------------------------------------------
    expect(results.length).toBe(seeds.length);
    expect(broken).toEqual([]);

    // Timers / listeners / subscriptions back at baseline after the final
    // unmount (the mounted-tree baseline is taken after the warm-up cycle).
    // The accounting must have SEEN the screen's subscriptions while mounted…
    expect(peakSubscribers['appStore']).toBeGreaterThan(0);
    expect(peakSubscribers['consistencyStore']).toBeGreaterThan(0);
    expect(peakSubscribers['notificationStore']).toBeGreaterThan(0);
    // …and every one of them must be gone after the final unmount.
    expect(final.storeSubscribers).toEqual(baseline.storeSubscribers);
    expect(final.rnListenersOpen).toBe(baseline.rnListenersOpen);
    expect(final.statusBarDepth).toBe(baseline.statusBarDepth);
    expect(summary.leaks.walkthroughTargetsLive).toEqual([]);
    expect(summary.leaks.reactQueryObservers).toBe(0);
    expect(summary.leaks.sqliteInFlight).toBe(0);
    expect(summary.leaks.fetchInFlight).toBe(0);
    expect(final.resources['Timeout'] ?? 0).toBeLessThanOrEqual(
      baseline.resources['Timeout'] ?? 0,
    );
    // The production db singleton must be opened exactly once per process.
    expect(mockSqlite.opens).toBe(1);

    // Heap: a monotone slope above the lens threshold is the finding.
    if (GC_AVAILABLE) {
      const monotoneLeak =
        slopePctPer100 > HEAP_SLOPE_LIMIT_PCT_PER_100 &&
        monotoneFraction >= 0.6;
      expect({ slopePctPer100, monotoneFraction, monotoneLeak }).toMatchObject({
        monotoneLeak: false,
      });
    } else if (
      ITERATIONS >= 500 ||
      (REPLAY.length === 0 && seeds.length >= 500)
    ) {
      throw new Error(
        'A ≥500-iteration campaign must run with node --expose-gc so the heap slope is measurable.',
      );
    }

    // Render-time drift: the last decile must not be > 2× the first.
    expect(driftRatio).toBeLessThan(2);
  });
});
