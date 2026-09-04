/**
 * LONG-RUN LEAK campaign for ResultDetailsScreen (unit scr-resultdetailsscreen).
 *
 * Mounts the PRODUCTION screen on a real @react-navigation native stack
 * inside a NavigationContainer + SafeAreaProvider + QueryClientProvider
 * (the same providers App.tsx composes), with the real evidence hook,
 * repository reads over the production getDb() migrations on a REAL SQLite
 * database (node:sqlite behind the op-sqlite native boundary), the real
 * zustand training/consistency/api-session stores and the real
 * createTrainingApi over a mocked fetch. Only native modules and fetch are
 * replaced: op-sqlite, the PickleVideoCapture bridge (sidecar file read),
 * react-native-svg, safe-area-context, react-native-video (auto-mock).
 *
 * Every iteration is one seed (scenario generator:
 * test-support/stress/resultDetailsLeak.scenario.ts): the campaign seeds
 * the store for that scenario, mounts the navigator with
 * ResultDetails on top of a 1–3 deep stack, settles, performs the seeded
 * interaction, unmounts (settled, or while the first DB read is still
 * pending), releases the deferred read, then asserts every per-mount
 * resource returned to its pre-mount level:
 *   • JS timers (setTimeout/setInterval) created during the iteration
 *   • AppState / AccessibilityInfo subscriptions (one-time global observers
 *     are recorded separately and allow-listed on iteration 1 only)
 *   • zustand store subscriptions (training, consistency, api session,
 *     access, auth, app)
 *   • StatusBar prop-stack entries (jest.setup.js mock)
 *   • the rendered tree is empty after unmount
 *   • no console.error during the iteration
 * Heap (after global.gc when exposed), Node active resources and the
 * mount/settle/unmount timings are recorded after every 50 iterations; the
 * least-squares heap slope per 100 iterations (relative to the first
 * checkpoint) is the leak statistic; > 5 % per 100 iterations fails.
 *
 * Scale:   STRESS_ITER=<n>            iterations (default 12 for the suite)
 * Replay:  STRESS_SEED=<seed>[,<seed>] run exactly these seeds
 * Start:   STRESS_SEED_START=<n>      first seed of the campaign (default 1)
 * Output:  STRESS_OUT=<dir>           JSON artifacts (default artifacts/stress)
 * Trees:   STRESS_DUMP=1              also write each settled render tree + text
 * Heap:    STRESS_HEAP_SNAPSHOT=50,500 write post-GC V8 heap snapshots there
 * Full run (500 iterations, GC exposed, one process):
 *   STRESS_ITER=500 node --expose-gc node_modules/jest/bin/jest.js --ci -i \
 *     __tests__/stress/resultDetailsScreen.longRunLeak.stress.test.tsx
 */

// ─── Node built-ins (the mobile tsconfig carries no node typings) ───────────
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  memoryUsage(): {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers: number;
  };
  getActiveResourcesInfo?: () => string[];
  hrtime: { bigint(): bigint };
};
declare const setImmediate: (callback: () => void) => unknown;

interface SqliteStatement {
  all(...params: (string | number | null)[]): Record<string, unknown>[];
  run(...params: (string | number | null)[]): unknown;
}
interface DatabaseSync {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

interface StressGlobals {
  gc?: () => void;
  __stressSqlite?: { db: DatabaseSync | null; hold: Promise<void> | null };
  __stressCaptureBridge?: { readTextFile: jest.Mock };
}
const stressGlobals = globalThis as unknown as StressGlobals;

// ─── Mocks: native boundaries + fetch ONLY ──────────────────────────────────

// op-sqlite native module → the production LocalDb contract over node:sqlite.
// `hold` lets one scenario keep every read pending until the screen is gone.
jest.mock('@op-engineering/op-sqlite', () => {
  const state: { db: DatabaseSync | null; hold: Promise<void> | null } = {
    db: null,
    hold: null,
  };
  (globalThis as unknown as StressGlobals).__stressSqlite = state;
  return {
    open: () => ({
      executeSync: (sql: string) => {
        if (!state.db) throw new Error('sqlite not opened');
        return { rows: state.db.prepare(sql).all() };
      },
      execute: async (sql: string, params: unknown[] = []) => {
        if (state.hold) await state.hold;
        if (!state.db) throw new Error('sqlite not opened');
        return {
          rows: state.db
            .prepare(sql)
            .all(...(params as (string | number | null)[])),
        };
      },
      close: () => {},
    }),
  };
});

// PickleVideoCapture bridge: only the sidecar reader the review path uses.
jest.mock('react-native', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const bridge = { readTextFile: jest.fn() };
  (globalThis as unknown as StressGlobals).__stressCaptureBridge = bridge;
  (RN.NativeModules as Record<string, unknown>).PickleVideoCapture = bridge;
  return RN;
});

// zustand: wrap every store's `subscribe` at creation so per-hook
// useSyncExternalStore subscriptions are counted (the hook reads the internal
// api, so wrapping the public copy after the fact would see nothing).
const STRESS_STORE_COUNTER = Symbol.for('stress.storeSubscriptions');
interface SubscribableApi {
  subscribe: (listener: unknown) => () => void;
}
type CreateStoreLike = (initializer: unknown) => SubscribableApi;
jest.mock('zustand/vanilla', () => {
  const actual =
    jest.requireActual<typeof import('zustand/vanilla')>('zustand/vanilla');
  const create = actual.createStore as unknown as CreateStoreLike;
  const createStore = ((initializer: unknown) => {
    const wrap = (api: SubscribableApi) => {
      const counter = { live: 0, total: 0 };
      const original = api.subscribe;
      api.subscribe = (listener: unknown) => {
        const unsubscribe = original(listener);
        counter.live += 1;
        counter.total += 1;
        let done = false;
        return () => {
          if (!done) {
            done = true;
            counter.live -= 1;
          }
          unsubscribe();
        };
      };
      (api as unknown as Record<symbol, unknown>)[
        Symbol.for('stress.storeSubscriptions')
      ] = counter;
      return api;
    };
    return initializer
      ? wrap(create(initializer))
      : (lazyInitializer: unknown) => wrap(create(lazyInitializer));
  }) as unknown as typeof actual.createStore;
  return { ...actual, createStore };
});

jest.mock(
  'react-native-safe-area-context',
  () =>
    (
      jest.requireActual('react-native-safe-area-context/jest/mock') as {
        default: unknown;
      }
    ).default,
);

jest.mock('react-native-svg', () => {
  const React = require('react') as typeof import('react');
  const { View } = require('react-native') as typeof import('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Defs: Mock,
    G: Mock,
    Line: Mock,
    Path: Mock,
    Polygon: Mock,
    Polyline: Mock,
    RadialGradient: Mock,
    LinearGradient: Mock,
    Rect: Mock,
    Stop: Mock,
  };
});

import React from 'react';
import {
  AccessibilityInfo,
  AppState,
  NativeModules,
  StatusBar,
  Text,
  UIManager,
  View,
} from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  NavigationContainer,
  type InitialState,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { ResultDetailsScreen } from '../../src/screens/ResultDetailsScreen';
import type { RootStackParams } from '../../src/navigation/params';
import { color } from '../../src/design/tokens';
import { getDb } from '../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  saveAnalysis,
  savePendingCapture,
  updateCaptureClipPayload,
} from '../../src/data/repository';
import { OUTBOX_MAX_ATTEMPTS } from '../../src/data/sync';
import {
  clearApiSession,
  establishApiSession,
  useApiSessionStore,
} from '../../src/account/apiSession';
import { createTrainingApi } from '../../src/training/api';
import {
  clearTrainingStoreConfiguration,
  configureTrainingStore,
  useTrainingStore,
} from '../../src/training/store';
import { useConsistencyStore } from '../../src/consistency/store';
import { useAccessStore } from '../../src/state/accessStore';
import { useAuthStore } from '../../src/auth/authStore';
import { useAppStore } from '../../src/state/appStore';
import { clearTryAgainHandoff } from '../../src/screens/tryAgainHandoff';
import {
  buildPoseSidecar,
  capturedClip,
  evidenceRecord,
  heapSlope,
  mean,
  percentile,
  scenarioFor,
  scoredAnalysis,
  type HeapPoint,
  type Scenario,
} from '../../test-support/stress/resultDetailsLeak.scenario';

const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (location: string) => DatabaseSync;
};
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { join } = require('path') as { join: (...parts: string[]) => string };
const { writeHeapSnapshot } = require('v8') as {
  writeHeapSnapshot: (filename: string) => string;
};

// ─── Campaign configuration ─────────────────────────────────────────────────

const ITERATIONS = Number(process.env.STRESS_ITER ?? 12);
const SEED_START = Number(process.env.STRESS_SEED_START ?? 1);
const ONLY_SEEDS = process.env.STRESS_SEED
  ? process.env.STRESS_SEED.split(',').map(value => Number(value.trim()))
  : null;
const OUT_DIR =
  process.env.STRESS_OUT ?? join(__dirname, '..', '..', 'artifacts', 'stress');
const CHECKPOINT_EVERY = 50;
const HEAP_SLOPE_LIMIT_PERCENT_PER_100 = 5;
const SETTLE_ROUNDS_MAX = 400;
const DRAIN_MS = 40;
const DUMP_TREES = process.env.STRESS_DUMP === '1';
// Comma-separated checkpoint iterations at which a V8 .heapsnapshot is written
// (post-GC) for retained-object diffing, e.g. STRESS_HEAP_SNAPSHOT=50,500.
const HEAP_SNAPSHOT_AT = new Set(
  (process.env.STRESS_HEAP_SNAPSHOT ?? '')
    .split(',')
    .filter(Boolean)
    .map(value => Number(value.trim())),
);
const SIDECAR_URI = 'file:///private/captures/stress.pose.json';

function seeds(): number[] {
  if (ONLY_SEEDS) {
    if (ONLY_SEEDS.some(seed => !Number.isInteger(seed))) {
      throw new Error(
        `STRESS_SEED must be integers, got ${process.env.STRESS_SEED}`,
      );
    }
    return ONLY_SEEDS;
  }
  return Array.from({ length: ITERATIONS }, (_, index) => SEED_START + index);
}

// ─── Resource trackers ──────────────────────────────────────────────────────

interface TimerRecord {
  kind: 'timeout' | 'interval';
  createdAtIteration: number;
  stack: string;
}

const liveTimers = new Map<unknown, TimerRecord>();
let currentIteration = 0;
type TimerHandler = (...args: unknown[]) => void;
type SetTimer = (
  handler: TimerHandler,
  ms?: number,
  ...args: unknown[]
) => unknown;
type ClearTimer = (id: unknown) => void;
const timerGlobals = globalThis as unknown as {
  setTimeout: SetTimer;
  setInterval: SetTimer;
  clearTimeout: ClearTimer;
  clearInterval: ClearTimer;
};
const realSetTimeout = timerGlobals.setTimeout;
const realSetInterval = timerGlobals.setInterval;
const realClearTimeout = timerGlobals.clearTimeout;
const realClearInterval = timerGlobals.clearInterval;
// `src/data/api.ts` (feedback, sync) calls the GLOBAL fetch; the training
// api takes an injected one. Both point at the per-iteration mock.
const fetchGlobals = globalThis as unknown as { fetch: unknown };
const realFetch = fetchGlobals.fetch;

function stackOf(): string {
  return (new Error().stack ?? '')
    .split('\n')
    .slice(3, 9)
    .map(line => line.trim())
    .join(' | ');
}

function installTimerTracking() {
  timerGlobals.setTimeout = (handler, ms, ...args) => {
    const record: TimerRecord = {
      kind: 'timeout',
      createdAtIteration: currentIteration,
      stack: stackOf(),
    };
    const id: unknown = realSetTimeout(
      (...inner: unknown[]) => {
        liveTimers.delete(id);
        handler(...inner);
      },
      ms,
      ...args,
    );
    liveTimers.set(id, record);
    return id;
  };
  timerGlobals.setInterval = (handler, ms, ...args) => {
    const id: unknown = realSetInterval(handler, ms, ...args);
    liveTimers.set(id, {
      kind: 'interval',
      createdAtIteration: currentIteration,
      stack: stackOf(),
    });
    return id;
  };
  timerGlobals.clearTimeout = id => {
    liveTimers.delete(id);
    realClearTimeout(id);
  };
  timerGlobals.clearInterval = id => {
    liveTimers.delete(id);
    realClearInterval(id);
  };
}

function restoreTimerTracking() {
  timerGlobals.setTimeout = realSetTimeout;
  timerGlobals.setInterval = realSetInterval;
  timerGlobals.clearTimeout = realClearTimeout;
  timerGlobals.clearInterval = realClearInterval;
}

interface SubscriptionCounter {
  live: number;
  total: number;
}

const storeSubscriptions: Record<string, SubscriptionCounter> = {};

// zustand's `create` copies the vanilla api onto the hook function
// (`Object.assign(useBoundStore, api)`) but `useStore` subscribes through the
// internal `api.subscribe`, so the counter is attached to the api by the
// zustand/vanilla mock above (see STRESS_STORE_COUNTER) and only read here.
function trackStore(name: string, store: unknown) {
  const counter = (store as Record<symbol, SubscriptionCounter | undefined>)[
    STRESS_STORE_COUNTER
  ];
  if (!counter) {
    throw new Error(`store ${name} was not created through zustand/vanilla`);
  }
  storeSubscriptions[name] = counter;
}

const eventSubscriptions: Record<string, SubscriptionCounter> = {
  AppState: { live: 0, total: 0 },
  AccessibilityInfo: { live: 0, total: 0 },
};

function trackEmitter(
  name: keyof typeof eventSubscriptions,
  emitter: { addEventListener: (...args: unknown[]) => { remove: () => void } },
) {
  const counter = eventSubscriptions[name];
  if (!counter) throw new Error(`unknown emitter ${name}`);
  const original = emitter.addEventListener;
  emitter.addEventListener = (...args: unknown[]) => {
    const subscription = original(...args);
    counter.live += 1;
    counter.total += 1;
    let done = false;
    return {
      remove: () => {
        if (!done) {
          done = true;
          counter.live -= 1;
        }
        subscription.remove();
      },
    };
  };
}

// Jest keeps every call/result of every jest.fn() for the life of the test.
// The RN jest preset installs `performance.now = jest.fn(Date.now)` (React's
// scheduler calls it ~16k times per mount) and jest.fn() NativeModules
// (NativeAnimatedModule, …), so their call history is test-infrastructure
// retention (~1 MB per iteration) that would masquerade as an app leak.
// Totals are accumulated here, then the history is cleared after each
// iteration's resource snapshot.
const nativeMockCallTotals: Record<string, number> = {};

function accumulateNativeMockCalls() {
  const seen = new Set<unknown>();
  const walk = (value: unknown, path: string, depth: number) => {
    if (
      value === null ||
      (typeof value !== 'object' && typeof value !== 'function') ||
      seen.has(value) ||
      depth > 2
    ) {
      return;
    }
    seen.add(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const child = (value as Record<string, unknown>)[key];
      const mock = (child as { mock?: { calls: unknown[] } }).mock;
      if (typeof child === 'function' && mock && Array.isArray(mock.calls)) {
        if (mock.calls.length > 0) {
          nativeMockCallTotals[`${path}.${key}`] =
            (nativeMockCallTotals[`${path}.${key}`] ?? 0) + mock.calls.length;
        }
      } else {
        walk(child, `${path}.${key}`, depth + 1);
      }
    }
  };
  walk(NativeModules, 'NativeModules', 0);
  walk(UIManager, 'UIManager', 0);
  walk(
    (globalThis as unknown as { performance?: unknown }).performance,
    'performance',
    0,
  );
}

interface ResourceSnapshot {
  timers: number;
  timeouts: number;
  intervals: number;
  storeSubscriptions: Record<string, number>;
  eventSubscriptions: Record<string, number>;
  statusBarStack: number;
  activeResources: Record<string, number>;
}

function statusBarStackDepth(): number {
  const stack = (StatusBar as unknown as { _propsStack?: unknown[] })
    ._propsStack;
  return Array.isArray(stack) ? stack.length : -1;
}

function activeResources(): Record<string, number> {
  const counts: Record<string, number> = {};
  if (typeof process.getActiveResourcesInfo !== 'function') return counts;
  for (const name of process.getActiveResourcesInfo()) {
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

function snapshotResources(): ResourceSnapshot {
  let timeouts = 0;
  let intervals = 0;
  for (const record of liveTimers.values()) {
    if (record.kind === 'timeout') timeouts += 1;
    else intervals += 1;
  }
  return {
    timers: liveTimers.size,
    timeouts,
    intervals,
    storeSubscriptions: Object.fromEntries(
      Object.entries(storeSubscriptions).map(([name, c]) => [name, c.live]),
    ),
    eventSubscriptions: Object.fromEntries(
      Object.entries(eventSubscriptions).map(([name, c]) => [name, c.live]),
    ),
    statusBarStack: statusBarStackDepth(),
    activeResources: activeResources(),
  };
}

// ─── Navigator under test (production route registration for ResultDetails) ─

const Stack = createNativeStackNavigator<RootStackParams>();
const queryClient = new QueryClient();

function InertRoute(props: { route: { name: string } }) {
  return <View testID={`inert-route-${props.route.name}`} />;
}

function initialStateFor(scenario: Scenario): InitialState {
  const under: InitialState['routes'] = [
    { name: 'Tabs' },
    { name: 'Analyze', params: { source: 'camera' } },
    { name: 'Result', params: { analysisId: scenario.analysisId } },
  ].slice(3 - scenario.stackDepth);
  return {
    routes: [
      ...under,
      { name: 'ResultDetails', params: { analysisId: scenario.analysisId } },
    ],
  };
}

function Harness(props: { scenario: Scenario }) {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <NavigationContainer initialState={initialStateFor(props.scenario)}>
          <Stack.Navigator>
            <Stack.Screen name="Tabs" component={InertRoute} />
            <Stack.Screen name="Analyze" component={InertRoute} />
            <Stack.Screen name="Result" component={InertRoute} />
            <Stack.Screen name="FormReview" component={InertRoute} />
            <Stack.Screen
              name="ResultDetails"
              component={ResultDetailsScreen}
              options={{
                title: 'Full breakdown',
                contentStyle: { backgroundColor: color.surface },
              }}
            />
          </Stack.Navigator>
        </NavigationContainer>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

// ─── Store seeding (production writers where they exist) ────────────────────

const sidecar = buildPoseSidecar(SIDECAR_URI);

function sqlite(): DatabaseSync {
  const db = stressGlobals.__stressSqlite?.db;
  if (!db) throw new Error('sqlite fixture not opened');
  return db;
}

async function seedStore(scenario: Scenario) {
  setActiveDataOwner(scenario.owner);
  const db = getDb();
  if (scenario.evidence === 'missing') return;
  const scored = scenario.evidence !== 'abstained';
  if (scored) {
    await saveAnalysis(db, scoredAnalysis(scenario), `permit-${scenario.seed}`);
    for (const sibling of scenario.siblings) {
      await saveAnalysis(
        db,
        scoredAnalysis({
          analysisId: sibling.analysisId,
          sessionId: scenario.sessionId,
          capturedAtIso: sibling.capturedAtIso,
          overallScore: scenario.overallScore,
        }),
        `permit-${scenario.seed}-${sibling.analysisId}`,
      );
    }
  }
  await savePendingCapture(
    db,
    scenario.captureId,
    'forehand_drive',
    capturedClip(scenario, sidecar),
    'forehand_drive',
  );
  await updateCaptureClipPayload(
    db,
    scenario.captureId,
    capturedClip(scenario, sidecar),
  );
  // Stored records are heterogeneous (strokeResultData.loadAnalysisRecordById
  // reads the evidence envelope); the row mirrors saveAnalysisRecord's columns.
  const record = evidenceRecord(scenario, !scored);
  await db.execute(
    `INSERT INTO local_analysis_record
      (owner_key, id, capture_id, created_at, engine_version, scoring_model_version, record)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      scenario.owner,
      scenario.analysisId,
      scenario.captureId,
      scenario.capturedAtIso,
      'on-device-fusion-1',
      scored ? 'sm-v1' : 'abstained',
      JSON.stringify(record),
    ],
  );
  if (scored) {
    switch (scenario.sync) {
      case 'queued':
        break;
      case 'synced':
        await db.execute(
          `INSERT OR REPLACE INTO sync_receipt (owner_key, kind, entity_id)
           VALUES (?, 'shot.sync', ?)`,
          [scenario.owner, scenario.analysisId],
        );
        break;
      case 'rejected':
        await db.execute(
          `UPDATE outbox SET attempts = 1, last_error = 'HTTP 422 rejected'
           WHERE owner_key = ? AND json_extract(payload, '$.id') = ?`,
          [scenario.owner, scenario.analysisId],
        );
        break;
      case 'exhausted':
        await db.execute(
          `UPDATE outbox SET attempts = ?, last_error = 'HTTP 503 unavailable'
           WHERE owner_key = ? AND json_extract(payload, '$.id') = ?`,
          [OUTBOX_MAX_ATTEMPTS, scenario.owner, scenario.analysisId],
        );
        break;
    }
  }
}

function purgeStore(scenario: Scenario) {
  const db = sqlite();
  for (const table of [
    'local_shot',
    'local_capture',
    'local_analysis_record',
    'outbox',
    'sync_receipt',
  ]) {
    db.prepare(`DELETE FROM ${table} WHERE owner_key = ?`).run(scenario.owner);
  }
}

function fetchFor(scenario: Scenario): jest.Mock {
  return jest.fn(async (input: string) => {
    if (scenario.training === 'configured_offline') {
      throw new TypeError('Network request failed');
    }
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      ({
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => 'application/json' },
        json: async () => body,
        text: async () => JSON.stringify(body),
      }) as unknown as Response;
    if (url.includes('/v1/training-plans/current')) return json({ plan: null });
    if (url.includes('/v1/catalog/drills')) return json({ drills: [] });
    if (/\/v1\/analyses\/[^/]+\/feedback$/.test(url)) {
      return json({ feedback: { reviewEligible: false } });
    }
    return json({ error: { code: 'not_found' } }, 404);
  });
}

// ─── Rendering helpers ──────────────────────────────────────────────────────

async function flush() {
  await act(async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
  });
}

function hostByTestId(renderer: ReactTestRenderer, testID: string) {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && node.props.testID === testID,
  );
}

function pressable(
  renderer: ReactTestRenderer,
  predicate: (props: Record<string, unknown>) => boolean,
) {
  const [node] = renderer.root.findAll(
    candidate =>
      typeof candidate.props.onPress === 'function' &&
      predicate(candidate.props),
  );
  return node ?? null;
}

async function press(
  renderer: ReactTestRenderer,
  predicate: (props: Record<string, unknown>) => boolean,
  what: string,
) {
  const node = pressable(renderer, predicate);
  if (!node) throw new Error(`no pressable for ${what}`);
  await act(async () => {
    (node.props.onPress as () => void)();
  });
  await flush();
}

async function settle(
  renderer: ReactTestRenderer,
  ready: () => boolean,
): Promise<number> {
  let rounds = 0;
  while (!ready() && rounds < SETTLE_ROUNDS_MAX) {
    await flush();
    rounds += 1;
  }
  return rounds;
}

function hasRole(renderer: ReactTestRenderer, role: string): boolean {
  return (
    renderer.root.findAll(
      node =>
        typeof node.type === 'string' && node.props.accessibilityRole === role,
    ).length > 0
  );
}

/** The screen's three states: analyzing spinner, "Result missing" alert, or
 * the full breakdown (`result-details` host + breakdown card). */
function analyzing(renderer: ReactTestRenderer): boolean {
  return hostByTestId(renderer, 'stroke-result-analyzing').length > 0;
}
function missingState(renderer: ReactTestRenderer): boolean {
  return hasRole(renderer, 'alert') && /Result missing/.test(allText(renderer));
}
function breakdownState(renderer: ReactTestRenderer): boolean {
  return hostByTestId(renderer, 'result-details-breakdown').length > 0;
}
function loaded(renderer: ReactTestRenderer): boolean {
  return breakdownState(renderer) || missingState(renderer);
}
function screenPresent(renderer: ReactTestRenderer): boolean {
  return analyzing(renderer) || loaded(renderer);
}

function allText(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat(3)
    .filter((child): child is string | number =>
      ['string', 'number'].includes(typeof child),
    )
    .join(' ')
    .replace(/\s+/g, ' ');
}

// ─── Iteration ──────────────────────────────────────────────────────────────

interface IterationFailure {
  invariant: string;
  detail: string;
}

interface IterationResult {
  seed: number;
  iteration: number;
  scenario: Omit<Scenario, 'siblings'> & { siblings: number };
  outcome: 'HELD' | 'BROKEN';
  failures: IterationFailure[];
  timings: {
    seedMs: number;
    mountMs: number;
    settleMs: number;
    settleRounds: number;
    interactionMs: number;
    unmountMs: number;
    totalMs: number;
  };
  rendered: {
    loaded: boolean;
    breakdown: boolean;
    missing: boolean;
    textLength: number;
    trainingStatus: string;
  };
  residual: {
    timers: number;
    storeSubscriptions: number;
    eventSubscriptions: number;
    statusBarStack: number;
  };
  consoleErrors: string[];
  consoleWarnings: string[];
  replay: string;
}

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

function diffCounts(
  before: Record<string, number>,
  after: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const delta = (after[key] ?? 0) - (before[key] ?? 0);
    if (delta !== 0) out[key] = delta;
  }
  return out;
}

async function runIteration(
  seed: number,
  iteration: number,
): Promise<IterationResult> {
  currentIteration = iteration;
  const scenario = scenarioFor(seed);
  const failures: IterationFailure[] = [];
  const consoleErrors: string[] = [];
  const consoleWarnings: string[] = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(' ').slice(0, 400));
  };
  console.warn = (...args: unknown[]) => {
    consoleWarnings.push(args.map(String).join(' ').slice(0, 400));
  };

  const started = nowMs();
  const before = snapshotResources();
  const timersBefore = new Set(liveTimers.keys());

  let renderer: ReactTestRenderer | null = null;
  let mountMs = 0;
  let settleMs = 0;
  let settleRounds = 0;
  let interactionMs = 0;
  let unmountMs = 0;
  let seedMs = 0;
  let wasLoaded = false;
  let breakdown = false;
  let missing = false;
  let textLength = 0;
  const sqliteState = stressGlobals.__stressSqlite;
  if (!sqliteState) throw new Error('sqlite mock missing');
  let releaseHold: (() => void) | null = null;

  try {
    // Seed the real store + session/training configuration.
    const seedStart = nowMs();
    clearTryAgainHandoff();
    if (scenario.session) {
      establishApiSession({
        apiBaseUrl: 'https://stress.invalid',
        bearerToken: `stress-bearer-${seed}`,
        canonicalAppUserId: scenario.owner,
        provider: 'apple',
      });
    } else {
      clearApiSession();
    }
    const fetchFn = fetchFor(scenario);
    fetchGlobals.fetch = fetchFn;
    if (scenario.training === 'unconfigured') {
      clearTrainingStoreConfiguration();
    } else {
      configureTrainingStore(
        createTrainingApi({
          baseUrl: 'https://stress.invalid',
          token: `stress-bearer-${seed}`,
          fetchFn,
        }),
      );
    }
    stressGlobals.__stressCaptureBridge?.readTextFile.mockImplementation(
      async (uri: string) => {
        if (uri !== SIDECAR_URI) throw new Error(`no artifact at ${uri}`);
        return sidecar.json;
      },
    );
    await seedStore(scenario);
    seedMs = nowMs() - seedStart;

    if (scenario.unmount === 'during_load') {
      sqliteState.hold = new Promise<void>(resolve => {
        releaseHold = resolve;
      });
    }

    // Mount the real navigator with ResultDetails focused.
    const mountStart = nowMs();
    await act(async () => {
      renderer = TestRenderer.create(<Harness scenario={scenario} />);
    });
    mountMs = nowMs() - mountStart;
    // `renderer` is assigned inside the act() callback above, which TS's
    // control-flow narrowing does not see (it still believes it is null).
    const mounted = renderer as ReactTestRenderer | null;
    if (!mounted) throw new Error('renderer not created');

    if (!screenPresent(mounted)) {
      failures.push({
        invariant: 'screen_mounted',
        detail: 'ResultDetails rendered none of analyzing/missing/breakdown',
      });
    }

    if (scenario.unmount === 'settled') {
      const settleStart = nowMs();
      settleRounds = await settle(mounted, () => loaded(mounted));
      settleMs = nowMs() - settleStart;
      wasLoaded = loaded(mounted);
      breakdown = breakdownState(mounted);
      missing = missingState(mounted);
      textLength = allText(mounted).length;
      if (DUMP_TREES) {
        mkdirSync(join(OUT_DIR, 'trees'), { recursive: true });
        writeFileSync(
          join(OUT_DIR, 'trees', `seed-${seed}.json`),
          JSON.stringify(
            { seed, scenario, text: allText(mounted), tree: mounted.toJSON() },
            null,
            1,
          ),
        );
      }
      if (breakdown && hostByTestId(mounted, 'result-details').length !== 1) {
        failures.push({
          invariant: 'screen_mounted',
          detail: 'result-details host not rendered exactly once',
        });
      }
      if (!wasLoaded) {
        failures.push({
          invariant: 'settles',
          detail: `evidence never settled within ${SETTLE_ROUNDS_MAX} rounds`,
        });
      }
      const expectMissing = scenario.evidence === 'missing';
      if (wasLoaded && expectMissing !== missing) {
        failures.push({
          invariant: 'renders_expected_state',
          detail: `expected ${expectMissing ? 'missing' : 'breakdown'} state, got ${
            missing ? 'missing' : 'breakdown'
          }`,
        });
      }
      if (scenario.evidence.startsWith('scored') && wasLoaded) {
        const text = allText(mounted);
        if (!/Stroke map/.test(text)) {
          failures.push({
            invariant: 'renders_scored_sections',
            detail: 'scored breakdown lacks the "Stroke map" section',
          });
        }
        if (
          scenario.evidence === 'scored_full' &&
          hostByTestId(mounted, 'stroke-result-replay').length === 0
        ) {
          failures.push({
            invariant: 'renders_replay',
            detail: 'scored_full evidence rendered no replay card',
          });
        }
        // The training section words the REAL store + sync rows: prove the
        // seeded outbox / receipt / API configuration reached the screen.
        const expectedCopy =
          scenario.training === 'unconfigured'
            ? 'Training is not connected.'
            : scenario.training === 'configured_offline'
              ? 'Training could not be verified.'
              : scenario.sync === 'synced'
                ? 'Turn this read into a plan.'
                : scenario.sync === 'queued'
                  ? 'still in the secure outbox'
                  : scenario.sync === 'rejected'
                    ? `refused this read 1 of ${OUTBOX_MAX_ATTEMPTS} times`
                    : `Sync was refused ${OUTBOX_MAX_ATTEMPTS} times`;
        if (!text.includes(expectedCopy)) {
          failures.push({
            invariant: 'renders_training_sync_state',
            detail: `expected "${expectedCopy}" for ${scenario.training}/${scenario.sync}; text: ${text.slice(0, 600)}`,
          });
        }
      }

      // Seeded interaction against the REAL navigation object.
      const interactionStart = nowMs();
      switch (scenario.interaction) {
        case 'none':
          break;
        case 'open_form_review': {
          await press(
            mounted,
            props => props.testID === 'form-review-card',
            'form review card',
          );
          await settle(
            mounted,
            () => hostByTestId(mounted, 'inert-route-FormReview').length > 0,
          );
          if (hostByTestId(mounted, 'inert-route-FormReview').length === 0) {
            failures.push({
              invariant: 'navigates_form_review',
              detail: 'FormReview route not pushed after tapping the card',
            });
          }
          break;
        }
        case 'open_attempt': {
          const target = scenario.siblings[0];
          if (!target) break;
          // Chips are in capture order; the current attempt is the newest, so
          // "Attempt 1" is always a sibling (never the current analysis).
          await press(
            mounted,
            props =>
              props.accessibilityRole === 'tab' &&
              props.accessibilityLabel === 'Attempt 1',
            'attempt chip 1',
          );
          await settle(
            mounted,
            () => hostByTestId(mounted, 'result-details').length === 0,
          );
          if (hostByTestId(mounted, 'result-details').length !== 0) {
            failures.push({
              invariant: 'pops_to_result',
              detail: 'ResultDetails still mounted after popTo(Result)',
            });
          }
          break;
        }
        case 'start_replay':
        case 'toggle_replay': {
          const label = 'Play replay';
          await press(
            mounted,
            props => props.accessibilityLabel === label,
            'replay play button',
          );
          const intervalsLive = snapshotResources().intervals;
          if (intervalsLive <= before.intervals) {
            failures.push({
              invariant: 'replay_interval_started',
              detail: 'play did not start a replay interval',
            });
          }
          if (scenario.interaction === 'toggle_replay') {
            await press(
              mounted,
              props => props.accessibilityLabel === 'Pause replay',
              'replay pause button',
            );
            if (snapshotResources().intervals !== before.intervals) {
              failures.push({
                invariant: 'replay_interval_cleared_on_pause',
                detail: 'pause left the replay interval live',
              });
            }
          }
          break;
        }
        case 'expand_rows': {
          if (
            pressable(mounted, props =>
              /^See \d+ more$/.test(String(props.accessibilityLabel)),
            )
          ) {
            await press(
              mounted,
              props => /^See \d+ more$/.test(String(props.accessibilityLabel)),
              'measured rows toggle',
            );
          }
          break;
        }
        case 'back': {
          await press(
            mounted,
            props =>
              props.accessibilityLabel === (missing ? 'Go back' : 'Back'),
            'header back',
          );
          await settle(mounted, () => !screenPresent(mounted));
          if (screenPresent(mounted)) {
            failures.push({
              invariant: 'goes_back',
              detail: 'ResultDetails still mounted after goBack()',
            });
          }
          break;
        }
        case 'feedback': {
          await press(
            mounted,
            props => props.testID === 'feedback-yes',
            'feedback yes',
          );
          await settle(
            mounted,
            () => hostByTestId(mounted, 'feedback-thanks').length > 0,
          );
          if (hostByTestId(mounted, 'feedback-thanks').length === 0) {
            failures.push({
              invariant: 'feedback_acknowledged',
              detail: 'feedback prompt did not reach the thanks state',
            });
          }
          if (
            !fetchFn.mock.calls.some(([url]) =>
              String(url).includes(
                `/v1/analyses/${scenario.analysisId}/feedback`,
              ),
            )
          ) {
            failures.push({
              invariant: 'feedback_sent',
              detail: 'feedback submission never hit fetch',
            });
          }
          break;
        }
      }
      interactionMs = nowMs() - interactionStart;
    } else {
      // Unmount while the first DB read is still pending.
      if (!analyzing(mounted)) {
        failures.push({
          invariant: 'analyzing_state_while_pending',
          detail:
            'deferred read did not leave the screen in the analyzing state',
        });
      }
    }

    const unmountStart = nowMs();
    await act(async () => {
      mounted.unmount();
    });
    unmountMs = nowMs() - unmountStart;
    renderer = null;

    if (mounted.toJSON() !== null) {
      failures.push({
        invariant: 'tree_empty_after_unmount',
        detail: 'renderer still holds a tree after unmount',
      });
    }

    // Release deferred reads AFTER unmount: the cancellation flags in
    // useStrokeResultEvidence must swallow every late resolution.
    if (releaseHold) {
      sqliteState.hold = null;
      (releaseHold as () => void)();
      releaseHold = null;
    }
    for (let i = 0; i < 6; i += 1) await flush();
    // Drain in-flight short timers: the jest NativeAnimatedModule mock
    // completes a native-driver animation on a 16 ms timeout and the rAF
    // mock schedules zero-delay frames; anything still live afterwards is a
    // residual of this mount.
    await new Promise<void>(resolve =>
      realSetTimeout(() => resolve(), DRAIN_MS),
    );
    await flush();
  } catch (error) {
    failures.push({
      invariant: 'no_exception',
      detail: error instanceof Error ? `${error.message}` : String(error),
    });
    if (renderer) {
      try {
        const leftover: ReactTestRenderer = renderer;
        await act(async () => {
          leftover.unmount();
        });
      } catch {
        // already reported
      }
    }
    if (releaseHold) {
      sqliteState.hold = null;
      (releaseHold as () => void)();
    }
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
    sqliteState.hold = null;
    purgeStore(scenario);
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    clearApiSession();
    clearTrainingStoreConfiguration();
  }

  const after = snapshotResources();
  accumulateNativeMockCalls();
  jest.clearAllMocks();
  const leakedTimers = [...liveTimers.entries()].filter(
    ([id]) => !timersBefore.has(id),
  );
  if (leakedTimers.length > 0) {
    failures.push({
      invariant: 'timers_return_to_baseline',
      detail: leakedTimers
        .map(([, record]) => `${record.kind} @ ${record.stack}`)
        .join(' || ')
        .slice(0, 1200),
    });
  }
  const storeDelta = diffCounts(
    before.storeSubscriptions,
    after.storeSubscriptions,
  );
  if (Object.values(storeDelta).some(delta => delta > 0)) {
    failures.push({
      invariant: 'store_subscriptions_return_to_baseline',
      detail: JSON.stringify(storeDelta),
    });
  }
  const eventDelta = diffCounts(
    before.eventSubscriptions,
    after.eventSubscriptions,
  );
  // The reduced-motion observer (design/components.tsx) registers ONE
  // process-wide AccessibilityInfo listener the first time any animated
  // component mounts; it is a documented singleton, not a per-mount leak.
  const allowedFirstMount =
    iteration === 1 &&
    Object.keys(eventDelta).every(key => key === 'AccessibilityInfo') &&
    (eventDelta.AccessibilityInfo ?? 0) <= 1;
  if (
    Object.values(eventDelta).some(delta => delta > 0) &&
    !allowedFirstMount
  ) {
    failures.push({
      invariant: 'event_subscriptions_return_to_baseline',
      detail: JSON.stringify(eventDelta),
    });
  }
  if (after.statusBarStack !== before.statusBarStack) {
    failures.push({
      invariant: 'statusbar_stack_balanced',
      detail: `StatusBar stack ${before.statusBarStack} → ${after.statusBarStack}`,
    });
  }
  if (consoleErrors.length > 0) {
    failures.push({
      invariant: 'no_console_error',
      detail: consoleErrors.slice(0, 3).join(' || '),
    });
  }

  const totalMs = nowMs() - started;
  const { siblings, ...rest } = scenario;
  return {
    seed,
    iteration,
    scenario: { ...rest, siblings: siblings.length },
    outcome: failures.length === 0 ? 'HELD' : 'BROKEN',
    failures,
    timings: {
      seedMs,
      mountMs,
      settleMs,
      settleRounds,
      interactionMs,
      unmountMs,
      totalMs,
    },
    rendered: {
      loaded: wasLoaded,
      breakdown,
      missing,
      textLength,
      trainingStatus: useTrainingStore.getState().planStatus,
    },
    residual: {
      timers: leakedTimers.length,
      storeSubscriptions: Object.values(storeDelta).reduce((s, d) => s + d, 0),
      eventSubscriptions: Object.values(eventDelta).reduce((s, d) => s + d, 0),
      statusBarStack: after.statusBarStack - before.statusBarStack,
    },
    consoleErrors,
    consoleWarnings,
    replay: `cd apps/mobile && STRESS_SEED=${seed} node --expose-gc node_modules/jest/bin/jest.js --ci -i __tests__/stress/resultDetailsScreen.longRunLeak.stress.test.tsx`,
  };
}

// ─── Campaign ───────────────────────────────────────────────────────────────

interface Checkpoint {
  iteration: number;
  gc: boolean;
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
  arrayBuffers: number;
  resources: ResourceSnapshot;
  meanTotalMsLast50: number;
  meanMountMsLast50: number;
  meanSettleMsLast50: number;
}

function heapCheckpoint(
  iteration: number,
  recent: IterationResult[],
): Checkpoint {
  const gcAvailable = typeof stressGlobals.gc === 'function';
  if (gcAvailable) {
    stressGlobals.gc?.();
    stressGlobals.gc?.();
  }
  const memory = process.memoryUsage();
  if (HEAP_SNAPSHOT_AT.has(iteration)) {
    mkdirSync(OUT_DIR, { recursive: true });
    writeHeapSnapshot(join(OUT_DIR, `heap-${iteration}.heapsnapshot`));
  }
  return {
    iteration,
    gc: gcAvailable,
    heapUsed: memory.heapUsed,
    heapTotal: memory.heapTotal,
    rss: memory.rss,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
    resources: snapshotResources(),
    meanTotalMsLast50: mean(recent.map(r => r.timings.totalMs)),
    meanMountMsLast50: mean(recent.map(r => r.timings.mountMs)),
    meanSettleMsLast50: mean(recent.map(r => r.timings.settleMs)),
  };
}

describe('ResultDetailsScreen — long-run leak campaign (real navigator + providers + SQLite)', () => {
  const results: IterationResult[] = [];
  const checkpoints: Checkpoint[] = [];
  let baseline: ResourceSnapshot | null = null;
  let baselineHeap: ReturnType<typeof process.memoryUsage> | null = null;
  const wallStart = Date.now();

  beforeAll(() => {
    stressGlobals.__stressSqlite ??= { db: null, hold: null };
    stressGlobals.__stressSqlite.db = new DatabaseSync(':memory:');
    installTimerTracking();
    trackStore('training', useTrainingStore);
    trackStore('consistency', useConsistencyStore);
    trackStore('apiSession', useApiSessionStore);
    trackStore('access', useAccessStore);
    trackStore('auth', useAuthStore);
    trackStore('app', useAppStore);
    trackEmitter(
      'AppState',
      AppState as unknown as {
        addEventListener: (...args: unknown[]) => { remove: () => void };
      },
    );
    trackEmitter(
      'AccessibilityInfo',
      AccessibilityInfo as unknown as {
        addEventListener: (...args: unknown[]) => { remove: () => void };
      },
    );
    // Open + migrate the production schema once, exactly like the app.
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    getDb();
    if (typeof stressGlobals.gc === 'function') stressGlobals.gc();
    baseline = snapshotResources();
    baselineHeap = process.memoryUsage();
  });

  afterAll(() => {
    restoreTimerTracking();
    fetchGlobals.fetch = realFetch;
    const failed = results.filter(r => r.outcome === 'BROKEN');
    const byInvariant: Record<string, number> = {};
    for (const r of results)
      for (const f of r.failures)
        byInvariant[f.invariant] = (byInvariant[f.invariant] ?? 0) + 1;
    const points: HeapPoint[] = checkpoints.map(c => ({
      iteration: c.iteration,
      heapUsed: c.heapUsed,
    }));
    const slope = heapSlope(points);
    const totals = results.map(r => r.timings.totalMs);
    const firstWindow = results.slice(0, Math.min(100, results.length));
    const lastWindow = results.slice(-Math.min(100, results.length));
    const drift = {
      firstWindowMeanTotalMs: mean(firstWindow.map(r => r.timings.totalMs)),
      lastWindowMeanTotalMs: mean(lastWindow.map(r => r.timings.totalMs)),
      firstWindowMeanMountMs: mean(firstWindow.map(r => r.timings.mountMs)),
      lastWindowMeanMountMs: mean(lastWindow.map(r => r.timings.mountMs)),
      firstWindowMeanSettleMs: mean(firstWindow.map(r => r.timings.settleMs)),
      lastWindowMeanSettleMs: mean(lastWindow.map(r => r.timings.settleMs)),
      p50TotalMs: percentile(totals, 50),
      p95TotalMs: percentile(totals, 95),
      maxTotalMs: Math.max(0, ...totals),
    };
    const byDimension = (key: keyof IterationResult['scenario']) => {
      const table: Record<string, { executed: number; broken: number }> = {};
      for (const r of results) {
        const value = String(r.scenario[key]);
        table[value] ??= { executed: 0, broken: 0 };
        table[value].executed += 1;
        if (r.outcome === 'BROKEN') table[value].broken += 1;
      }
      return table;
    };
    const summary = {
      unit: 'scr-resultdetailsscreen',
      lens: 'long-run-leak',
      generatedAt: new Date().toISOString(),
      iterationsRequested: ONLY_SEEDS ? ONLY_SEEDS.length : ITERATIONS,
      seedStart: SEED_START,
      onlySeeds: ONLY_SEEDS,
      executed: results.length,
      held: results.length - failed.length,
      broken: failed.length,
      brokenSeeds: failed.map(r => r.seed),
      byInvariant,
      wallMs: Date.now() - wallStart,
      gcExposed: typeof stressGlobals.gc === 'function',
      checkpointEvery: CHECKPOINT_EVERY,
      baseline: { resources: baseline, heap: baselineHeap },
      heapSlope: slope,
      heapSlopeLimitPercentPer100: HEAP_SLOPE_LIMIT_PERCENT_PER_100,
      drift,
      byEvidence: byDimension('evidence'),
      bySync: byDimension('sync'),
      byTraining: byDimension('training'),
      byInteraction: byDimension('interaction'),
      byUnmount: byDimension('unmount'),
      bySession: byDimension('session'),
      byStackDepth: byDimension('stackDepth'),
      finalResources: snapshotResources(),
      nativeMockCallTotals: Object.fromEntries(
        Object.entries(nativeMockCallTotals)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 12),
      ),
      storeSubscriptionTotals: Object.fromEntries(
        Object.entries(storeSubscriptions).map(([n, c]) => [n, c.total]),
      ),
      eventSubscriptionTotals: Object.fromEntries(
        Object.entries(eventSubscriptions).map(([n, c]) => [n, c.total]),
      ),
    };
    mkdirSync(OUT_DIR, { recursive: true });
    const stamp = ONLY_SEEDS
      ? `replay-${ONLY_SEEDS.join('-')}`
      : `iter-${ITERATIONS}`;
    writeFileSync(
      join(OUT_DIR, `resultDetailsScreen.longRunLeak.${stamp}.summary.json`),
      JSON.stringify(summary, null, 2),
    );
    writeFileSync(
      join(OUT_DIR, `resultDetailsScreen.longRunLeak.${stamp}.results.json`),
      JSON.stringify(results, null, 2),
    );
    writeFileSync(
      join(OUT_DIR, `resultDetailsScreen.longRunLeak.${stamp}.heap.json`),
      JSON.stringify(checkpoints, null, 2),
    );
    // Keep the sqlite handle open for the whole process: getDb() caches the
    // migrated instance exactly like the app does; the process exit closes it.
  });

  it(
    'holds every per-mount resource at baseline across the seeded mount/unmount campaign',
    async () => {
      const campaign = seeds();
      const recent: IterationResult[] = [];
      for (let index = 0; index < campaign.length; index += 1) {
        const seed = campaign[index];
        if (seed === undefined) continue;
        const iteration = index + 1;
        const result = await runIteration(seed, iteration);
        results.push(result);
        recent.push(result);
        if (
          iteration % CHECKPOINT_EVERY === 0 ||
          iteration === campaign.length
        ) {
          checkpoints.push(heapCheckpoint(iteration, recent.splice(0)));
        }
      }

      const broken = results.filter(r => r.outcome === 'BROKEN');
      const report = broken
        .slice(0, 10)
        .map(
          r =>
            `seed ${r.seed} [${r.scenario.evidence}/${r.scenario.sync}/${r.scenario.training}/${r.scenario.interaction}/${r.scenario.unmount}]: ${r.failures
              .map(f => `${f.invariant}: ${f.detail}`)
              .join('; ')}`,
        )
        .join('\n');
      expect(results.length).toBe(campaign.length);
      expect({ broken: broken.length, report }).toEqual({
        broken: 0,
        report: '',
      });

      // Timers / subscriptions / StatusBar stack at the END of the campaign
      // versus the pre-campaign baseline (the one-time reduced-motion observer
      // is the only allowed residual).
      const final = snapshotResources();
      expect(baseline).not.toBeNull();
      if (baseline) {
        expect(final.timers).toBe(baseline.timers);
        expect(final.statusBarStack).toBe(baseline.statusBarStack);
        expect(final.storeSubscriptions).toEqual(baseline.storeSubscriptions);
        expect(final.eventSubscriptions.AppState).toBe(
          baseline.eventSubscriptions.AppState,
        );
        expect(
          (final.eventSubscriptions.AccessibilityInfo ?? 0) -
            (baseline.eventSubscriptions.AccessibilityInfo ?? 0),
        ).toBeLessThanOrEqual(1);
      }

      // Heap slope: only meaningful with GC exposed and ≥ 2 checkpoints.
      const slope = heapSlope(
        checkpoints.map(c => ({
          iteration: c.iteration,
          heapUsed: c.heapUsed,
        })),
      );
      if (
        typeof stressGlobals.gc === 'function' &&
        slope &&
        slope.points >= 3
      ) {
        expect(slope.percentPer100).toBeLessThanOrEqual(
          HEAP_SLOPE_LIMIT_PERCENT_PER_100,
        );
      }
    },
    60 * 60 * 1000,
  );
});
