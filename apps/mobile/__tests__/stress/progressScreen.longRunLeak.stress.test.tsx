/**
 * STRESS — unit `scr-progressscreen`, lens `long-run-leak`.
 *
 * Mounts the REAL ProgressScreen inside the real React Navigation tree the
 * app uses (NavigationContainer → native stack → bottom tabs, with the
 * "Performance" tab hosting ProgressScreen) on top of the real zustand
 * stores (appStore, consistency, rankCelebration, apiSession) and the real
 * `getDb()` + repository layer. Only the native/network boundaries are
 * mocked: `@op-engineering/op-sqlite` (backed by an in-memory `node:sqlite`
 * database), react-native-safe-area-context (its own jest mock),
 * react-native-linear-gradient, and `globalThis.fetch`.
 *
 * Every iteration is a seeded scenario (owner, local dataset, server
 * behaviour, in-screen actions, navigation away/back) that mounts, drives and
 * unmounts the whole tree, then asserts the lifecycle returns to baseline:
 * pending fake timers, RN event-emitter listeners (AppState, Dimensions,
 * Appearance, Keyboard, Linking, AccessibilityInfo) and live zustand store
 * subscriptions. Heap (after `gc()`) and Node active resources are sampled
 * every STRESS_HEAP_EVERY iterations; render time drift is measured per
 * iteration with the real clock.
 *
 * Replay / campaign knobs (all optional):
 *   STRESS_ITER=<n>          iterations (default 12 — fast enough for the suite)
 *   STRESS_MASTER_SEED=<n>   master seed (default 20260905)
 *   STRESS_SEEDS=a,b,c       replay exactly these iteration seeds
 *   STRESS_HEAP_EVERY=<n>    heap sample interval (default 50)
 *   STRESS_OUT=<path>        JSON results table (default artifacts/stress/…)
 *
 * Campaign command (one process, gc exposed):
 *   cd apps/mobile && STRESS_ITER=500 node --expose-gc node_modules/.bin/jest \
 *     --ci --silent --runInBand __tests__/stress/progressScreen.longRunLeak
 */
import React from 'react';
import {
  AccessibilityInfo,
  Appearance,
  AppState,
  Dimensions,
  Keyboard,
  Linking,
  Pressable,
  View,
} from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  createNavigationContainerRef,
  NavigationContainer,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

// apps/mobile types only `jest` (no @types/node); declare the exact Node
// surface this harness drives.
declare const require: (id: string) => unknown;

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
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  writeFileSync(path: string, data: string): void;
};
const nodePath = require('path') as {
  dirname(path: string): string;
  join(...parts: string[]): string;
};
const v8 = require('v8') as {
  writeHeapSnapshot(path?: string): string;
};

interface NodeProcess {
  env: Record<string, string | undefined>;
  memoryUsage(): { heapUsed: number; rss: number; external: number };
  hrtime: { bigint(): bigint };
  getActiveResourcesInfo?: () => string[];
  cwd(): string;
}
const nodeProcess = process as unknown as NodeProcess;
const exposedGc = (globalThis as { gc?: () => void }).gc;

// ---------------------------------------------------------------------------
// Native boundary mocks (the ONLY mocks in this suite)
// ---------------------------------------------------------------------------

// The single in-memory SQLite database that backs the production getDb()
// singleton for the whole process — exactly one local store per app run.
const mockSqliteState: { real: DatabaseSync | null } = { real: null };
function mockSqlite(): DatabaseSync {
  if (!mockSqliteState.real)
    mockSqliteState.real = new DatabaseSync(':memory:');
  return mockSqliteState.real;
}
jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => ({
    executeSync: (sql: string) => ({ rows: mockSqlite().prepare(sql).all() }),
    execute: async (sql: string, params: unknown[] = []) => ({
      rows: mockSqlite()
        .prepare(sql)
        .all(...(params as (string | number | null)[])),
    }),
    close: () => {
      mockSqliteState.real?.close();
      mockSqliteState.real = null;
    },
  }),
}));

jest.mock('react-native-safe-area-context', () => {
  const mock = jest.requireActual<{ default: Record<string, unknown> }>(
    'react-native-safe-area-context/jest/mock',
  ).default;
  return { __esModule: true, ...mock };
});

jest.mock('react-native-linear-gradient', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  const { View: RNView } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    ReactActual.createElement(RNView, null, props.children);
  return { __esModule: true, default: MockGradient };
});

// ---------------------------------------------------------------------------
// Real app modules (imported AFTER the boundary mocks are registered)
// ---------------------------------------------------------------------------
import { ProgressScreen } from '../../src/screens/ProgressScreen';
import { PremiumTabBar } from '../../src/navigation/PremiumTabBar';
import type {
  MainTabParams,
  RootStackParams,
} from '../../src/navigation/params';
import { color } from '../../src/design/tokens';
import { getDb } from '../../src/data/db';
import {
  GUEST_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  clearApiSession,
  establishApiSession,
  useApiSessionStore,
} from '../../src/account/apiSession';
import { useAppStore } from '../../src/state/appStore';
import { useConsistencyStore } from '../../src/consistency/store';
import { useRankCelebrationStore } from '../../src/progress/rankCelebration';
import { useAccessStore } from '../../src/state/accessStore';
import { useAuthStore } from '../../src/auth/authStore';
import { useWalkthroughStore } from '../../src/walkthrough/walkthroughStore';
import { PRACTICE_HISTORY_RANGES } from '../../src/progress/practiceHistory';
import { SHOT_TYPES } from '@pickle/shared-types';

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32 + splitmix-style seed derivation)
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
  int(min: number, maxInclusive: number): number {
    return min + Math.floor(this.next() * (maxInclusive - min + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

function deriveSeed(master: number, iteration: number): number {
  let z = (master + Math.imul(iteration + 1, 0x9e3779b9)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return (z ^ (z >>> 16)) >>> 0;
}

// ---------------------------------------------------------------------------
// Scenario model
// ---------------------------------------------------------------------------
type ServerMode =
  | 'ok'
  | 'http500'
  | 'network_error'
  | 'invalid_json'
  | 'slow'
  | 'hang_past_timeout';

type Action =
  | { kind: 'section'; label: 'technique progress' | 'practice progress' }
  | { kind: 'range'; label: string }
  | { kind: 'streak_calendar_roundtrip' }
  | { kind: 'idle'; ms: number };

interface Scenario {
  seed: number;
  owner: 'guest' | 'account';
  ownerKey: string;
  server: ServerMode;
  serverDelayMs: number;
  facts: number;
  captures: number;
  captureShape: { valid: number; legacy: number; corrupt: number };
  actions: Action[];
  unmountWhileLoading: boolean;
}

const OWNER_UUIDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
] as const;

function buildScenario(seed: number): Scenario {
  const rng = new Rng(seed);
  const owner = rng.chance(0.55) ? 'account' : 'guest';
  const server = rng.pick<ServerMode>([
    'ok',
    'ok',
    'ok',
    'http500',
    'network_error',
    'invalid_json',
    'slow',
    'hang_past_timeout',
  ]);
  // Heavy-tailed dataset sizes: most iterations small, some large.
  const scale = rng.next();
  const facts =
    scale < 0.25 ? 0 : scale < 0.8 ? rng.int(1, 40) : rng.int(40, 400);
  const captures =
    scale < 0.25
      ? rng.int(0, 2)
      : scale < 0.8
        ? rng.int(0, 25)
        : rng.int(25, 150);
  const valid = Math.round(captures * rng.next());
  const legacy = Math.round((captures - valid) * rng.next());
  const corrupt = captures - valid - legacy;
  const actionCount = rng.int(0, 6);
  const actions: Action[] = [];
  for (let i = 0; i < actionCount; i += 1) {
    const roll = rng.next();
    if (roll < 0.3) {
      actions.push({
        kind: 'section',
        label: rng.chance(0.5) ? 'practice progress' : 'technique progress',
      });
    } else if (roll < 0.6) {
      actions.push({
        kind: 'range',
        label: `${rng.pick(PRACTICE_HISTORY_RANGES).label} range`,
      });
    } else if (roll < 0.8) {
      actions.push({ kind: 'streak_calendar_roundtrip' });
    } else {
      actions.push({ kind: 'idle', ms: rng.int(0, 2000) });
    }
  }
  return {
    seed,
    owner,
    ownerKey: owner === 'guest' ? GUEST_DATA_OWNER : rng.pick(OWNER_UUIDS),
    server,
    serverDelayMs: server === 'slow' ? rng.int(1, 14_000) : 0,
    facts,
    captures,
    captureShape: { valid, legacy, corrupt },
    actions,
    unmountWhileLoading: rng.chance(0.15),
  };
}

// ---------------------------------------------------------------------------
// Seeded fetch (the network boundary)
// ---------------------------------------------------------------------------
let currentScenario: Scenario | null = null;
let fetchCalls = 0;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function progressBody(rng: Rng) {
  const days = rng.int(0, 12);
  const series = Array.from({ length: days }, (_, i) => ({
    day: new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10),
    shot_type: rng.pick(SHOT_TYPES),
    scoring_model_version: 'score-1',
    shot_count: rng.int(1, 9),
    avg_score: rng.int(30, 95),
    best_score: rng.int(50, 100),
  }));
  return {
    series,
    improving: rng.chance(0.5)
      ? [{ checkpoint: 'contact_position', delta: rng.int(1, 20) / 10 }]
      : [],
    needsAttention: rng.chance(0.5)
      ? [{ checkpoint: 'follow_through', avg: rng.int(30, 60) / 10 }]
      : [],
    streak: {
      currentDays: rng.int(0, 30),
      longestDays: rng.int(0, 60),
      practicedToday: rng.chance(0.5),
      lastPracticeDate: rng.chance(0.7)
        ? new Date().toISOString().slice(0, 10)
        : null,
    },
  };
}

function rankBody(rng: Rng) {
  if (rng.chance(0.3)) return { rank: null };
  // player_technique_rating is grouped by (user_id, shot_type): one row per
  // technique, so sample shot types without replacement.
  const pool = [...SHOT_TYPES];
  const techniques = Array.from(
    { length: rng.int(1, Math.min(4, pool.length)) },
    () => ({
      shot_type: pool.splice(rng.int(0, pool.length - 1), 1)[0]!,
      score: rng.int(30, 95) / 10,
      captured_at: new Date().toISOString(),
    }),
  );
  return {
    rank: {
      rating: rng.int(10, 95) / 10,
      techniqueCount: techniques.length,
      tier: rng.pick(['bronze', 'silver', 'gold', 'platinum', 'diamond']),
      techniques,
    },
  };
}

const seededFetch: typeof fetch = (input, init) => {
  fetchCalls += 1;
  const scenario = currentScenario;
  if (!scenario) return Promise.reject(new Error('no scenario active'));
  const url = String(input);
  const rng = new Rng(scenario.seed ^ (url.includes('/v1/rank') ? 0x5a5a : 0));
  const body = url.includes('/v1/rank') ? rankBody(rng) : progressBody(rng);
  const settle = (): Promise<Response> => {
    switch (scenario.server) {
      case 'ok':
        return Promise.resolve(jsonResponse(200, body));
      case 'http500':
        return Promise.resolve(jsonResponse(500, { error: 'boom' }));
      case 'network_error':
        return Promise.reject(new TypeError('Network request failed'));
      case 'invalid_json':
        return Promise.resolve(jsonResponse(200, { nonsense: true }));
      case 'slow':
      case 'hang_past_timeout':
        return new Promise<Response>((resolve, reject) => {
          const delay =
            scenario.server === 'slow' ? scenario.serverDelayMs : 60_000;
          const timer = setTimeout(
            () => resolve(jsonResponse(200, body)),
            delay,
          );
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          });
        });
    }
  };
  return settle();
};

// ---------------------------------------------------------------------------
// Lifecycle instrumentation (listeners + store subscriptions)
// ---------------------------------------------------------------------------
interface Counter {
  name: string;
  live: number;
}

const listenerCounters: Counter[] = [];
const storeCounters: Counter[] = [];

type Emitter = {
  addEventListener: (
    ...args: unknown[]
  ) => { remove?: () => void } | undefined | void;
};

function instrumentEmitter(name: string, module: object): void {
  const counter: Counter = { name, live: 0 };
  listenerCounters.push(counter);
  const target = module as Emitter;
  const original = target.addEventListener;
  target.addEventListener = (...args: unknown[]) => {
    counter.live += 1;
    const subscription = original.apply(target, args);
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      counter.live -= 1;
      subscription?.remove?.();
    };
    return { ...(subscription ?? {}), remove };
  };
}

type Subscribable = {
  subscribe: (listener: (...args: unknown[]) => void) => () => void;
};

function instrumentStore(name: string, module: object): void {
  const counter: Counter = { name, live: 0 };
  storeCounters.push(counter);
  const store = module as Subscribable;
  const original = store.subscribe;
  store.subscribe = listener => {
    counter.live += 1;
    const unsubscribe = original(listener);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      counter.live -= 1;
      unsubscribe();
    };
  };
}

function snapshotCounters(counters: Counter[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const counter of counters) out[counter.name] = counter.live;
  return out;
}

function diffCounters(
  baseline: Record<string, number>,
  now: Record<string, number>,
): Record<string, number> {
  const diff: Record<string, number> = {};
  for (const key of Object.keys(now)) {
    const delta = (now[key] ?? 0) - (baseline[key] ?? 0);
    if (delta !== 0) diff[key] = delta;
  }
  return diff;
}

// ---------------------------------------------------------------------------
// Real navigation tree, shaped like RootNavigator (Tabs inside a native
// stack; Performance tab hosts ProgressScreen). Sibling routes are inert
// placeholders: this unit is ProgressScreen, so the screens it navigates TO
// are out of scope, but the navigation itself (blur → cleanup → refocus →
// reload) is real.
// ---------------------------------------------------------------------------
const Stack = createNativeStackNavigator<RootStackParams>();
const Tabs = createBottomTabNavigator<MainTabParams>();
const navigationRef = createNavigationContainerRef<RootStackParams>();

function Placeholder() {
  return <View testID="placeholder-route" />;
}

function MainTabs() {
  return (
    <Tabs.Navigator
      initialRouteName="Performance"
      tabBar={props => <PremiumTabBar {...props} />}
      screenOptions={{ headerShown: false, tabBarHideOnKeyboard: true }}
    >
      <Tabs.Screen name="Home" component={Placeholder} />
      <Tabs.Screen name="Library" component={Placeholder} />
      <Tabs.Screen name="Add" component={Placeholder} />
      <Tabs.Screen
        name="Performance"
        component={TREE === 'control' ? Placeholder : ProgressScreen}
      />
      <Tabs.Screen name="Settings" component={Placeholder} />
    </Tabs.Navigator>
  );
}

function Harness() {
  return (
    <SafeAreaProvider>
      <NavigationContainer ref={navigationRef}>
        <Stack.Navigator
          screenOptions={{
            headerShown: false,
            animation: 'fade_from_bottom',
            contentStyle: { backgroundColor: color.surface },
          }}
        >
          <Stack.Screen name="Tabs" component={MainTabs} />
          <Stack.Screen name="StreakCalendar" component={Placeholder} />
          <Stack.Screen name="Result" component={Placeholder} />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

// ---------------------------------------------------------------------------
// Fixture writers (real schema, real repository readers)
// ---------------------------------------------------------------------------
const ANALYSIS_TEMPLATE = {
  sessionId: null,
  cameraView: 'side',
  handedness: 'right',
  timestamps: { startMs: 0, contactMs: 900, endMs: 1800 },
  phases: [],
  measurements: [],
  checkpoints: [],
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

function uuidFrom(rng: Rng): string {
  const hex = () => rng.int(0, 15).toString(16);
  const part = (n: number) => Array.from({ length: n }, hex).join('');
  return `${part(8)}-${part(4)}-4${part(3)}-8${part(3)}-${part(12)}`;
}

function resetLocalStore(): void {
  const db = mockSqlite();
  db.exec('DELETE FROM local_shot');
  db.exec('DELETE FROM local_capture');
  db.exec('DELETE FROM kv');
  db.exec('DELETE FROM outbox');
}

function seedLocalStore(scenario: Scenario): void {
  const db = mockSqlite();
  const rng = new Rng(scenario.seed ^ 0xf1f1f1f1);
  const now = Date.now();
  const insertShot = db.prepare(
    `INSERT OR REPLACE INTO local_shot
     (owner_key, id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < scenario.facts; i += 1) {
    const scored = rng.chance(0.8);
    const shotType = rng.pick(SHOT_TYPES);
    const capturedAtIso = new Date(
      now - rng.int(0, 120) * 86_400_000 - rng.int(0, 86_399_000),
    ).toISOString();
    const score = scored ? rng.int(20, 98) / 10 : null;
    const analysis = {
      ...ANALYSIS_TEMPLATE,
      id: uuidFrom(rng),
      sessionId: rng.chance(0.3) ? uuidFrom(rng) : null,
      shotType,
      capturedAtIso,
      overallScore: score,
      analysisConfidence: scored ? rng.int(60, 99) / 100 : rng.int(5, 40) / 100,
      resultKind: scored ? 'scored' : 'low_confidence',
      versionVector: {
        ...ANALYSIS_TEMPLATE.versionVector,
        scoringModelVersion: rng.chance(0.9) ? 'score-1' : 'score-2',
        shotConfigVersion: `${shotType}@1`,
      },
      checkpoints: scored
        ? [
            {
              key: 'contact_position',
              applicable: true,
              score: rng.int(20, 98) / 10,
            },
          ]
        : [],
    };
    insertShot.run(
      scenario.ownerKey,
      analysis.id,
      analysis.sessionId,
      shotType,
      capturedAtIso,
      score,
      analysis.analysisConfidence,
      analysis.resultKind,
      'real',
      JSON.stringify(analysis),
    );
  }

  const insertCapture = db.prepare(
    `INSERT INTO local_capture
      (owner_key, id, uri, shot_type, declared_stroke, captured_at, duration_ms, fps, width, height, status, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const shapes: Array<'valid' | 'legacy' | 'corrupt'> = [
    ...Array.from(
      { length: scenario.captureShape.valid },
      () => 'valid' as const,
    ),
    ...Array.from(
      { length: scenario.captureShape.legacy },
      () => 'legacy' as const,
    ),
    ...Array.from(
      { length: scenario.captureShape.corrupt },
      () => 'corrupt' as const,
    ),
  ];
  shapes.forEach((shape, index) => {
    const id = uuidFrom(rng);
    const uri = `file:///stress/${scenario.seed}/${index}.mov`;
    const capturedAtIso = new Date(
      now - rng.int(0, 120) * 86_400_000 - rng.int(0, 86_399_000),
    ).toISOString();
    const durationMs = rng.int(900, 6000);
    const fps = rng.pick([30, 59.94, 60]);
    const width = 720;
    const height = 1280;
    const clip = {
      uri,
      durationMs,
      fps,
      width,
      height,
      capturedAtIso,
      captureMode: 'imported_video',
      recognition: { status: 'unknown', reason: 'analysis_not_run' },
      ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
    };
    const payload =
      shape === 'valid'
        ? JSON.stringify(clip)
        : shape === 'legacy'
          ? null
          : '{"captureMode":"imported_video","uri":"file:///x"';
    insertCapture.run(
      scenario.ownerKey,
      id,
      uri,
      rng.pick(SHOT_TYPES),
      rng.chance(0.5) ? rng.pick(SHOT_TYPES) : null,
      capturedAtIso,
      durationMs,
      fps,
      width,
      height,
      rng.chance(0.6) ? 'analyzed' : 'awaiting_model',
      payload,
    );
  });
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------
function renderedText(root: ReactTestInstance): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object' && 'children' in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(root.children);
  return out.join(' ');
}

/** react-test-renderer skips React.memo wrappers, so the mounted Pressable
 * instances carry the inner component type. */
const PressableInner = (
  Pressable as unknown as { type: React.ComponentType<unknown> }
).type;

function findPressable(
  root: ReactTestInstance,
  label: string,
): ReactTestInstance | null {
  const matches = root.findAll(
    node =>
      node.type === PressableInner &&
      (node.props as { accessibilityLabel?: string }).accessibilityLabel ===
        label,
  );
  return matches[0] ?? null;
}

const REAL_NOW = (): number =>
  Number(nodeProcess.hrtime.bigint() / BigInt(1000)) / 1000;

async function flush(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

// ---------------------------------------------------------------------------
// Result model
// ---------------------------------------------------------------------------
function withoutSeed(scenario: Scenario): Omit<Scenario, 'seed'> {
  const copy: Partial<Scenario> = { ...scenario };
  delete copy.seed;
  return copy as Omit<Scenario, 'seed'>;
}

interface IterationResult {
  iteration: number;
  seed: number;
  scenario: Omit<Scenario, 'seed'>;
  outcome: 'held' | 'broken';
  failures: string[];
  loadedState:
    | 'loaded'
    | 'error_state'
    | 'unmounted_while_loading'
    | 'never_loaded'
    | 'control_tree';
  fetchCalls: number;
  mountToLoadedMs: number | null;
  totalMs: number;
  timersAfter: number;
  listenerDrift: Record<string, number>;
  storeDrift: Record<string, number>;
  consoleErrors: string[];
}

interface HeapSample {
  afterIteration: number;
  heapUsed: number;
  rss: number;
  external: number;
  activeResources: Record<string, number>;
  gc: boolean;
}

function activeResources(): Record<string, number> {
  const info = nodeProcess.getActiveResourcesInfo?.() ?? [];
  const out: Record<string, number> = {};
  for (const kind of info) out[kind] = (out[kind] ?? 0) + 1;
  return out;
}

function heapSample(afterIteration: number): HeapSample {
  if (exposedGc) {
    exposedGc();
    exposedGc();
  }
  const memory = nodeProcess.memoryUsage();
  return {
    afterIteration,
    heapUsed: memory.heapUsed,
    rss: memory.rss,
    external: memory.external,
    activeResources: activeResources(),
    gc: Boolean(exposedGc),
  };
}

/** Least-squares slope of heapUsed per iteration, expressed as % of the
 * first sample per 100 iterations, plus whether every step increased. */
function heapTrend(samples: HeapSample[]): {
  slopePctPer100: number | null;
  monotoneIncreasing: boolean;
  firstHeap: number | null;
  lastHeap: number | null;
} {
  if (samples.length < 2) {
    return {
      slopePctPer100: null,
      monotoneIncreasing: false,
      firstHeap: samples[0]?.heapUsed ?? null,
      lastHeap: samples[0]?.heapUsed ?? null,
    };
  }
  const n = samples.length;
  const meanX = samples.reduce((s, p) => s + p.afterIteration, 0) / n;
  const meanY = samples.reduce((s, p) => s + p.heapUsed, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of samples) {
    num += (p.afterIteration - meanX) * (p.heapUsed - meanY);
    den += (p.afterIteration - meanX) ** 2;
  }
  const slopePerIteration = den === 0 ? 0 : num / den;
  const first = samples[0]!.heapUsed;
  let monotone = true;
  for (let i = 1; i < n; i += 1) {
    if (samples[i]!.heapUsed <= samples[i - 1]!.heapUsed) {
      monotone = false;
      break;
    }
  }
  return {
    slopePctPer100: (slopePerIteration * 100 * 100) / first,
    monotoneIncreasing: monotone,
    firstHeap: first,
    lastHeap: samples[n - 1]!.heapUsed,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// ---------------------------------------------------------------------------
// One iteration
// ---------------------------------------------------------------------------
async function runIteration(
  iteration: number,
  scenario: Scenario,
  baselineListeners: Record<string, number>,
  baselineStores: Record<string, number>,
  baselineTimers: number,
  consoleErrors: string[],
): Promise<IterationResult> {
  currentScenario = scenario;
  fetchCalls = 0;
  const failures: string[] = [];
  const startedAt = REAL_NOW();

  setActiveDataOwner(scenario.ownerKey);
  if (scenario.owner === 'account') {
    establishApiSession({
      apiBaseUrl: 'https://stress.invalid',
      bearerToken: `stress-${scenario.seed}`,
      canonicalAppUserId: scenario.ownerKey,
      provider: 'apple',
    });
  } else {
    clearApiSession();
  }
  resetLocalStore();
  seedLocalStore(scenario);

  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Harness />);
  });

  let loadedState: IterationResult['loadedState'] = 'never_loaded';
  let mountToLoadedMs: number | null = null;

  if (TREE === 'control') {
    // Placeholder in the Performance tab: only the navigator round trips and
    // idle time are meaningful; no ProgressScreen controls exist.
    await flush(500);
    for (const action of scenario.actions) {
      if (action.kind === 'idle') await flush(action.ms);
      if (
        action.kind === 'streak_calendar_roundtrip' &&
        navigationRef.isReady()
      ) {
        await act(async () => {
          navigationRef.navigate('StreakCalendar');
        });
        await flush(400);
        await act(async () => {
          if (navigationRef.canGoBack()) navigationRef.goBack();
        });
        await flush(400);
      }
    }
    loadedState = 'control_tree';
  } else if (scenario.unmountWhileLoading) {
    // Tear the tree down while getDb/list*/fetch are still in flight.
    await flush(0);
    loadedState = 'unmounted_while_loading';
  } else {
    // Drive virtual time until the screen leaves its loading state.
    let waited = 0;
    for (;;) {
      const text = renderedText(renderer.root);
      if (!text.includes('Loading measured progress')) {
        mountToLoadedMs = REAL_NOW() - startedAt;
        loadedState = text.includes('Progress couldn’t load')
          ? 'error_state'
          : 'loaded';
        break;
      }
      if (waited >= 20_000) {
        failures.push(
          `screen still loading after ${waited}ms virtual time (server=${scenario.server})`,
        );
        break;
      }
      await flush(50);
      waited += 50;
    }

    if (loadedState === 'loaded') {
      const text = renderedText(renderer.root);
      if (!text.includes('Progress')) {
        failures.push('loaded tree lacks the Progress title');
      }
    }
    if (loadedState === 'error_state') {
      // The local store is healthy in every scenario: getDb + repository
      // reads must never surface the error state (server trouble is
      // swallowed by design).
      failures.push('error state shown although local reads are healthy');
    }

    for (const action of scenario.actions) {
      switch (action.kind) {
        case 'section':
        case 'range': {
          const target = findPressable(renderer.root, action.label);
          if (!target) {
            failures.push(`control "${action.label}" not rendered`);
            break;
          }
          await act(async () => {
            (target.props as { onPress: () => void }).onPress();
          });
          await flush(16);
          break;
        }
        case 'streak_calendar_roundtrip': {
          if (!navigationRef.isReady()) {
            failures.push('navigation ref not ready for round trip');
            break;
          }
          await act(async () => {
            navigationRef.navigate('StreakCalendar');
          });
          await flush(400);
          await act(async () => {
            if (navigationRef.canGoBack()) navigationRef.goBack();
          });
          await flush(400);
          // Refocus re-runs the focus effect: wait for the reload again.
          let waited = 0;
          while (
            renderedText(renderer.root).includes('Loading measured progress') &&
            waited < 20_000
          ) {
            await flush(50);
            waited += 50;
          }
          if (waited >= 20_000) {
            failures.push(
              'screen never reloaded after StreakCalendar round trip',
            );
          }
          break;
        }
        case 'idle':
          await flush(action.ms);
          break;
      }
    }
  }

  await act(async () => {
    renderer.unmount();
  });
  // Drain everything the tree could legitimately have left behind: the
  // 15s progress request timeout, a slow/hanging server, animations.
  await flush(65_000);
  // Jest mocks record every call (args, `this`, result) forever. The RN jest
  // preset installs `performance.now = jest.fn(Date.now)`, which React's
  // scheduler calls tens of thousands of times per mount — that bookkeeping
  // is test-runner memory, not app memory, so drop it before sampling.
  jest.clearAllMocks();

  const timersAfter = jest.getTimerCount();
  const listenerDrift = diffCounters(
    baselineListeners,
    snapshotCounters(listenerCounters),
  );
  const storeDrift = diffCounters(
    baselineStores,
    snapshotCounters(storeCounters),
  );
  if (timersAfter !== baselineTimers) {
    failures.push(
      `pending timers ${timersAfter} != baseline ${baselineTimers} after unmount`,
    );
  }
  if (Object.keys(listenerDrift).length) {
    failures.push(`listener drift ${JSON.stringify(listenerDrift)}`);
  }
  if (Object.keys(storeDrift).length) {
    failures.push(`store subscription drift ${JSON.stringify(storeDrift)}`);
  }
  if (consoleErrors.length) {
    failures.push(
      `console.error x${consoleErrors.length}: ${consoleErrors[0]}`,
    );
  }

  return {
    iteration,
    seed: scenario.seed,
    scenario: withoutSeed(scenario),
    outcome: failures.length ? 'broken' : 'held',
    failures,
    loadedState,
    fetchCalls,
    mountToLoadedMs,
    totalMs: REAL_NOW() - startedAt,
    timersAfter,
    listenerDrift,
    storeDrift,
    consoleErrors: [...consoleErrors],
  };
}

// ---------------------------------------------------------------------------
// The campaign
// ---------------------------------------------------------------------------
const env = nodeProcess.env;
const ITERATIONS = Math.max(1, Number(env['STRESS_ITER'] ?? 12));
const MASTER_SEED = Number(env['STRESS_MASTER_SEED'] ?? 20260905) >>> 0;
const HEAP_EVERY = Math.max(1, Number(env['STRESS_HEAP_EVERY'] ?? 50));
const REPLAY_SEEDS = (env['STRESS_SEEDS'] ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(s => Number(s) >>> 0);
const OUT_PATH =
  env['STRESS_OUT'] ??
  nodePath.join(
    nodeProcess.cwd(),
    'artifacts',
    'stress',
    'progressScreen-long-run-leak.json',
  );

/** `full` mounts ProgressScreen in the Performance tab; `control` mounts the
 * identical navigator tree with an inert placeholder there instead, so the
 * heap/handle cost of the navigator + harness itself can be subtracted. */
const TREE: 'full' | 'control' =
  env['STRESS_TREE'] === 'control' ? 'control' : 'full';

/** STRESS_HEAP_SNAPSHOT=<path>: write a V8 heap snapshot after the last
 * iteration (post-gc) for retainer analysis. */
const HEAP_SNAPSHOT_PATH = env['STRESS_HEAP_SNAPSHOT'] ?? '';

const HEAP_SLOPE_LIMIT_PCT_PER_100 = 5;
const RENDER_DRIFT_LIMIT_RATIO = 1.5;

describe('ProgressScreen long-run leak campaign (real navigator + stores)', () => {
  const originalFetch = globalThis.fetch;
  const consoleErrors: string[] = [];
  let consoleErrorSpy: jest.SpyInstance;

  beforeAll(() => {
    jest.useFakeTimers({ doNotFake: ['hrtime', 'nextTick', 'queueMicrotask'] });
    globalThis.fetch = seededFetch;
    instrumentEmitter('AppState', AppState);
    instrumentEmitter('Dimensions', Dimensions);
    instrumentEmitter('Appearance', Appearance);
    instrumentEmitter('Keyboard', Keyboard);
    instrumentEmitter('Linking', Linking);
    instrumentEmitter('AccessibilityInfo', AccessibilityInfo);
    instrumentStore('apiSession', useApiSessionStore);
    instrumentStore('appStore', useAppStore);
    instrumentStore('consistency', useConsistencyStore);
    instrumentStore('rankCelebration', useRankCelebrationStore);
    instrumentStore('access', useAccessStore);
    instrumentStore('auth', useAuthStore);
    instrumentStore('walkthrough', useWalkthroughStore);
    consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation((...args: unknown[]) => {
        consoleErrors.push(
          args
            .map(a => (a instanceof Error ? a.message : String(a)))
            .join(' ')
            .slice(0, 300),
        );
      });
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    consoleErrorSpy.mockRestore();
    clearApiSession();
    jest.useRealTimers();
    mockSqliteState.real?.close();
    mockSqliteState.real = null;
  });

  it(
    `mounts/unmounts ${REPLAY_SEEDS.length || ITERATIONS} seeded scenarios and returns to baseline`,
    async () => {
      // Open the real local store once (production migrations run here).
      getDb();
      const seeds = REPLAY_SEEDS.length
        ? REPLAY_SEEDS
        : Array.from({ length: ITERATIONS }, (_, i) =>
            deriveSeed(MASTER_SEED, i),
          );

      // Warm-up: one mount/unmount so module-level caches (fonts, style
      // sheets, navigation registries) are populated before the baseline.
      const warmup = buildScenario(deriveSeed(MASTER_SEED ^ 0xdeadbeef, 0));
      warmup.actions = [{ kind: 'streak_calendar_roundtrip' }];
      warmup.unmountWhileLoading = false;
      await runIteration(
        -1,
        warmup,
        snapshotCounters(listenerCounters),
        snapshotCounters(storeCounters),
        jest.getTimerCount(),
        consoleErrors,
      );
      consoleErrors.length = 0;

      const baselineListeners = snapshotCounters(listenerCounters);
      const baselineStores = snapshotCounters(storeCounters);
      const baselineTimers = jest.getTimerCount();
      const heapSamples: HeapSample[] = [heapSample(0)];
      const results: IterationResult[] = [];
      const wallStart = REAL_NOW();

      for (let i = 0; i < seeds.length; i += 1) {
        consoleErrors.length = 0;
        const scenario = buildScenario(seeds[i]!);
        let result: IterationResult;
        try {
          result = await runIteration(
            i,
            scenario,
            baselineListeners,
            baselineStores,
            baselineTimers,
            consoleErrors,
          );
        } catch (error) {
          result = {
            iteration: i,
            seed: scenario.seed,
            scenario: withoutSeed(scenario),
            outcome: 'broken',
            failures: [
              `threw: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
            ],
            loadedState: 'never_loaded',
            fetchCalls,
            mountToLoadedMs: null,
            totalMs: 0,
            timersAfter: jest.getTimerCount(),
            listenerDrift: diffCounters(
              baselineListeners,
              snapshotCounters(listenerCounters),
            ),
            storeDrift: diffCounters(
              baselineStores,
              snapshotCounters(storeCounters),
            ),
            consoleErrors: [...consoleErrors],
          };
        }
        results.push(result);
        if ((i + 1) % HEAP_EVERY === 0 || i + 1 === seeds.length) {
          heapSamples.push(heapSample(i + 1));
        }
      }

      // Heap trend excludes the very first sample (pre-campaign) so one-off
      // lazy initialisation during the first window cannot masquerade as a
      // slope; the raw table keeps every sample.
      const steady = heapSamples.slice(1);
      const trend = heapTrend(steady.length >= 2 ? steady : heapSamples);

      const loadedTimes = results
        .filter(r => r.mountToLoadedMs !== null)
        .map(r => r.mountToLoadedMs!);
      const decile = Math.max(1, Math.floor(loadedTimes.length / 10));
      const firstDecileMedian = median(loadedTimes.slice(0, decile));
      const lastDecileMedian = median(loadedTimes.slice(-decile));
      const driftRatio =
        firstDecileMedian && lastDecileMedian
          ? lastDecileMedian / firstDecileMedian
          : null;

      const broken = results.filter(r => r.outcome === 'broken');
      const campaignFailures: string[] = [];
      const heapEvaluated = Boolean(exposedGc) && steady.length >= 3;
      if (
        heapEvaluated &&
        trend.monotoneIncreasing &&
        trend.slopePctPer100 !== null &&
        trend.slopePctPer100 > HEAP_SLOPE_LIMIT_PCT_PER_100
      ) {
        campaignFailures.push(
          `monotone heap growth ${trend.slopePctPer100.toFixed(2)}% per 100 iterations`,
        );
      }
      if (
        loadedTimes.length >= 100 &&
        driftRatio !== null &&
        driftRatio > RENDER_DRIFT_LIMIT_RATIO
      ) {
        campaignFailures.push(
          `mount→loaded time drifted x${driftRatio.toFixed(2)} (first decile median ${firstDecileMedian?.toFixed(1)}ms → last ${lastDecileMedian?.toFixed(1)}ms)`,
        );
      }

      const report = {
        unit: 'scr-progressscreen',
        lens: 'long-run-leak',
        tree: TREE,
        generatedAt: new Date().toISOString(),
        node: (nodeProcess as unknown as { version?: string }).version ?? null,
        gcExposed: Boolean(exposedGc),
        mockCallRecordsClearedPerIteration: true,
        masterSeed: MASTER_SEED,
        replaySeeds: REPLAY_SEEDS,
        iterationsRequested: seeds.length,
        iterationsExecuted: results.length,
        wallMs: REAL_NOW() - wallStart,
        baseline: {
          timers: baselineTimers,
          listeners: baselineListeners,
          storeSubscriptions: baselineStores,
        },
        heap: {
          evaluated: heapEvaluated,
          limitPctPer100: HEAP_SLOPE_LIMIT_PCT_PER_100,
          ...trend,
          samples: heapSamples,
        },
        renderTime: {
          evaluated: loadedTimes.length >= 100,
          limitRatio: RENDER_DRIFT_LIMIT_RATIO,
          samples: loadedTimes.length,
          firstDecileMedianMs: firstDecileMedian,
          lastDecileMedianMs: lastDecileMedian,
          driftRatio,
          overallMedianMs: median(loadedTimes),
          maxMs: loadedTimes.length ? Math.max(...loadedTimes) : null,
        },
        outcomes: {
          held: results.length - broken.length,
          broken: broken.length,
          byLoadedState: results.reduce<Record<string, number>>((acc, r) => {
            acc[r.loadedState] = (acc[r.loadedState] ?? 0) + 1;
            return acc;
          }, {}),
          byServer: results.reduce<Record<string, number>>((acc, r) => {
            acc[r.scenario.server] = (acc[r.scenario.server] ?? 0) + 1;
            return acc;
          }, {}),
        },
        campaignFailures,
        failingSeeds: broken.map(r => ({ seed: r.seed, failures: r.failures })),
        iterations: results,
      };
      fs.mkdirSync(nodePath.dirname(OUT_PATH), { recursive: true });
      fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
      if (HEAP_SNAPSHOT_PATH) {
        heapSample(results.length);
        v8.writeHeapSnapshot(HEAP_SNAPSHOT_PATH);
      }

      expect(results.length).toBe(seeds.length);
      expect({
        failingSeeds: report.failingSeeds,
        campaignFailures,
      }).toEqual({ failingSeeds: [], campaignFailures: [] });
    },
    // 500 full-tree mount/unmount cycles under fake timers comfortably fit;
    // the ceiling only exists so a hung campaign fails instead of spinning.
    30 * 60 * 1000,
  );
});
