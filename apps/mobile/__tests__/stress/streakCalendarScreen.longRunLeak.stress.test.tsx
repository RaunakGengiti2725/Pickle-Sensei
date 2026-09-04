/**
 * STRESS / long-run-leak — StreakCalendarScreen inside the REAL navigator.
 *
 * Mounts the production `StreakCalendarScreen` through the real
 * `@react-navigation/native` container + `@react-navigation/native-stack`
 * navigator (the same primitives `src/navigation/RootNavigator.tsx` uses),
 * with the real `useConsistencyStore` (zustand), the real `getDb()` local
 * schema (`src/data/db.ts`) and the real repository queries, all backed by an
 * in-memory SQLite database (`node:sqlite`). Only native modules are mocked:
 * `@op-engineering/op-sqlite` (→ node:sqlite), `react-native-safe-area-context`
 * (the package's own jest mock), `react-native-linear-gradient`,
 * `react-native-screens` (jest preset native-component stubs) and
 * `react-native-reanimated` (repo `__mocks__`). `fetch` is stubbed to reject
 * so nothing can leave the process.
 *
 * Every iteration is one user visit: `navigate('StreakCalendar')` (mount +
 * `useFocusEffect` refresh against SQLite), a seeded sequence of interactions
 * (month arrows, day taps, achievement taps, a store refresh, a
 * cold-store variant that re-runs the first-snapshot auto-select effect),
 * then `goBack()` (unmount). After every iteration the harness asserts the
 * process returned to baseline: outstanding timers/intervals/immediates/rAF,
 * zustand subscriptions, AppState/Linking/Dimensions subscriptions and the
 * React tree size at the Home route. After every 50 iterations it forces a
 * GC (`--expose-gc`) and records heap, RSS, external memory, and Node's
 * active handles/requests (`process.getActiveResourcesInfo`).
 *
 * Findings thresholds (lens `long-run-leak`):
 *   heapSlopeOk    monotone heapUsed slope after GC  <= 5% per 100 iterations
 *                  (relative to the first post-warmup sample; least squares
 *                  over all post-warmup samples, plus "monotone" = every
 *                  consecutive post-warmup sample grew)
 *   timersOk       pending timers == baseline after each iteration
 *   subsOk         zustand + RN event subscriptions == baseline
 *   treeOk         Home-route React tree size == baseline
 *   handlesOk      Node active handles/requests == baseline at the last sample
 *                  (samples that differ mid-campaign are listed in summary.json)
 *   drift          mount→settled render time: last-50 median vs first-50
 *                  median (reported; > 2x is a finding)
 *
 * Scale: STRESS_ITER (default 100 so the suite stays fast; the campaign runs
 * STRESS_ITER=500+). STRESS_SEED sets the campaign seed (default 20260904);
 * iteration `i` uses seed `STRESS_SEED + i`, so `STRESS_ITER=1
 * STRESS_SEED=<seed>` replays exactly one iteration. Artifacts (per-seed JSON
 * table, heap table, summary) go to STRESS_OUT_DIR
 * (default `<repo>/artifacts/stress/streakCalendar-long-run-leak/`).
 *
 * `--expose-gc` and `--experimental-sqlite` (node:sqlite on Node 22.5–22.12)
 * are required; when either is missing this file re-executes itself under
 * jest with both flags so a plain `npx jest` still runs (never skips) it.
 *
 * Diagnostics: STRESS_HEAP_SNAPSHOTS=1 writes V8 heap snapshots after the
 * warm-up and at the end; STRESS_TIMER_ORIGINS=1 records the creation stack
 * of every pending timer (reported when timers fail to return to baseline);
 * STRESS_KEEP_MOCK_LEDGERS=1 leaves the jest preset's mock call ledgers in
 * place (reproduces the preset-side growth described at KEEP_MOCK_LEDGERS).
 */
import React from 'react';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import TestRenderer, { act } from 'react-test-renderer';
import {
  AppState,
  Dimensions,
  Linking,
  Pressable,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createNavigationContainerRef,
  DefaultTheme,
  NavigationContainer,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import {
  childProcess,
  fs,
  loadNodeSqlite,
  path,
  resolveModule,
  type SqlInputValue,
  type SqliteDatabaseSync,
} from '../../xc-harness/lifecycle-persistence/nodeShim';
import { makePrng } from '../../xc-harness/lifecycle-persistence/seeds';

declare const __filename: string;
declare const __dirname: string;

interface StressProcess {
  env: Record<string, string | undefined>;
  execPath: string;
  version: string;
  memoryUsage(): {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
    arrayBuffers: number;
  };
  getActiveResourcesInfo(): string[];
  hrtime: { bigint(): bigint };
}
declare const process: StressProcess;
declare const global: { gc?: () => void } & Record<string, unknown>;

// ---------------------------------------------------------------------------
// Timer instrumentation — installed BEFORE any component code runs so every
// setTimeout/setInterval/setImmediate/requestAnimationFrame issued by React
// Native, React Navigation, the store or the screen is accounted for.
// ---------------------------------------------------------------------------
type TimerId = unknown;
interface PendingTimer {
  kind: string;
  origin: string | null;
}
const pendingTimers = new Map<TimerId, PendingTimer>();
const timerGlobals = globalThis as unknown as Record<string, unknown>;
const CAPTURE_TIMER_ORIGINS = process.env['STRESS_TIMER_ORIGINS'] === '1';

function wrapScheduler(
  name: string,
  cancelName: string,
  kind: string,
  repeats: boolean,
): void {
  const original = timerGlobals[name] as
    ((...args: unknown[]) => TimerId) | undefined;
  const originalCancel = timerGlobals[cancelName] as
    ((id: TimerId) => void) | undefined;
  if (typeof original !== 'function' || typeof originalCancel !== 'function') {
    return;
  }
  const wrapped = function (this: unknown, ...args: unknown[]): TimerId {
    const callback = args[0];
    // Assigned below; `fire` only reads it once the timer actually fires.
    const idBox: { id: TimerId } = { id: undefined };
    const fire = function (this: unknown, ...cbArgs: unknown[]) {
      if (!repeats) pendingTimers.delete(idBox.id);
      if (typeof callback === 'function') {
        return (callback as (...a: unknown[]) => unknown).apply(this, cbArgs);
      }
      return undefined;
    };
    const id = original.apply(this, [fire, ...args.slice(1)]);
    idBox.id = id;
    pendingTimers.set(id, {
      kind,
      origin: CAPTURE_TIMER_ORIGINS
        ? (new Error().stack ?? '').split('\n').slice(2, 8).join(' | ')
        : null,
    });
    return id;
  };
  const wrappedCancel = function (this: unknown, id: TimerId): void {
    pendingTimers.delete(id);
    originalCancel.call(this, id);
  };
  timerGlobals[name] = wrapped;
  timerGlobals[cancelName] = wrappedCancel;
}

wrapScheduler('setTimeout', 'clearTimeout', 'timeout', false);
wrapScheduler('setInterval', 'clearInterval', 'interval', true);
wrapScheduler('setImmediate', 'clearImmediate', 'immediate', false);
wrapScheduler(
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'animationFrame',
  false,
);

function pendingTimerCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const timer of pendingTimers.values()) {
    counts[timer.kind] = (counts[timer.kind] ?? 0) + 1;
  }
  return counts;
}

function pendingTimerOrigins(): string[] {
  return [...pendingTimers.values()].map(
    timer => `${timer.kind}: ${timer.origin ?? '(set STRESS_TIMER_ORIGINS=1)'}`,
  );
}

// ---------------------------------------------------------------------------
// Native module mocks (and only those).
// ---------------------------------------------------------------------------
jest.mock('react-native-safe-area-context', () => {
  const mock = require('react-native-safe-area-context/jest/mock') as {
    default: Record<string, unknown>;
  };
  return mock.default;
});

jest.mock('react-native-linear-gradient', () => {
  const ReactLocal = require('react') as typeof React;
  const { View: RNView } = require('react-native') as { View: typeof View };
  return {
    __esModule: true,
    default: (props: {
      children?: React.ReactNode;
      style?: React.ComponentProps<typeof View>['style'];
    }) =>
      ReactLocal.createElement(RNView, { style: props.style }, props.children),
  };
});

const sqlite = loadNodeSqlite();

const mockSqlite: { db: SqliteDatabaseSync | null; opens: number } = {
  db: null,
  opens: 0,
};

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    const db = mockSqlite.db;
    if (!db) throw new Error('stress harness: sqlite not seeded');
    mockSqlite.opens += 1;
    return {
      executeSync: (sql: string) => ({ rows: db.prepare(sql).all() }),
      execute: async (sql: string, params: unknown[] = []) => ({
        rows: db.prepare(sql).all(...(params as SqlInputValue[])),
      }),
      close: () => undefined,
    };
  },
}));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const ITERATIONS = Math.max(
  1,
  Number.parseInt(process.env['STRESS_ITER'] ?? '100', 10) || 100,
);
const BASE_SEED =
  Number.parseInt(process.env['STRESS_SEED'] ?? '', 10) || 20260904;
const SAMPLE_EVERY = 50;
const HEAP_SLOPE_LIMIT_PER_100 = 0.05;
const DRIFT_LIMIT = 2;
const QUIESCE_MAX_MS = 2_000;
/** STRESS_HEAP_SNAPSHOTS=1 writes a V8 .heapsnapshot after the warm-up and at the end. */
const WRITE_HEAP_SNAPSHOTS = process.env['STRESS_HEAP_SNAPSHOTS'] === '1';
interface NodeV8 {
  writeHeapSnapshot(filename: string): string;
}
/**
 * Every `jest.fn()` keeps a ledger of all its calls (calls/instances/contexts/
 * results) for the life of the test file. `@react-native/jest-preset/jest/
 * setup.js` installs `global.performance = { now: jest.fn(Date.now) }`, which
 * React's scheduler and react-test-renderer call tens of thousands of times
 * per mount (~8 MB retained per screen mount), and the preset's native-module
 * doubles (NativeAnimatedModule, StatusBar in jest.setup.js, ...) log a few
 * hundred calls per mount. Those ledgers would mask any real leak, so the
 * harness swaps a plain clock in and drops the ledgers at every sample point
 * — unless STRESS_KEEP_MOCK_LEDGERS=1, kept to reproduce that artefact.
 */
const KEEP_MOCK_LEDGERS = process.env['STRESS_KEEP_MOCK_LEDGERS'] === '1';
interface NodePerfHooks {
  performance: { now(): number };
}
function presetClockCallCount(): number | null {
  const now = (globalThis as { performance?: { now?: unknown } }).performance
    ?.now as { mock?: { calls: unknown[] } } | undefined;
  return now?.mock ? now.mock.calls.length : null;
}
const OUT_DIR =
  process.env['STRESS_OUT_DIR'] ??
  path.resolve(
    __dirname,
    '../../../../artifacts/stress/streakCalendar-long-run-leak',
  );

const ASOF_ISO = '2026-09-04T18:30:00.000Z';
const OWNER = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const SHOT_TYPES = ['dink', 'drive', 'serve', 'third_shot_drop', 'volley'];

// ---------------------------------------------------------------------------
// Scenario model — a pure function of the seed.
// ---------------------------------------------------------------------------
type Action =
  | 'prevMonth'
  | 'nextMonth'
  | 'tapDay'
  | 'tapAchievement'
  | 'refresh'
  | 'toggleShieldOff'
  | 'noop';

interface Scenario {
  seed: number;
  iteration: number;
  coldStore: boolean;
  actions: Action[];
}

const ACTIONS: Action[] = [
  'prevMonth',
  'nextMonth',
  'tapDay',
  'tapDay',
  'tapAchievement',
  'refresh',
  'noop',
];

function scenarioFor(seed: number, iteration: number): Scenario {
  const rng = makePrng(seed);
  const count = 1 + Math.floor(rng() * 8);
  const actions: Action[] = [];
  for (let i = 0; i < count; i += 1) {
    actions.push(ACTIONS[Math.floor(rng() * ACTIONS.length)] as Action);
  }
  return { seed, iteration, coldStore: rng() < 0.15, actions };
}

interface IterationRow {
  seed: number;
  iteration: number;
  coldStore: boolean;
  actions: Action[];
  outcome: 'HELD' | 'BROKEN';
  failed: string[];
  invariants: Record<string, boolean>;
  observed: {
    mountMs: number;
    totalMs: number;
    nodesWhileMounted: number;
    nodesAtHome: number;
    pendingTimers: Record<string, number>;
    timerOrigins: string[];
    quiesceMs: number;
    storeSubs: number;
    rnSubs: Record<string, number>;
    routeAfter: string | null;
    snapshotAsOfDay: string | null;
    streak: number | null;
    detailShown: boolean;
    error: string | null;
  };
}

interface HeapSample {
  iteration: number;
  heapUsedMb: number;
  heapTotalMb: number;
  rssMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  activeResources: Record<string, number>;
  activeHandleCount: number;
  pendingTimers: Record<string, number>;
  storeSubs: number;
  medianMountMsLastWindow: number;
}

// ---------------------------------------------------------------------------
// Re-exec guard: never skip — run the file under the flags it needs.
// ---------------------------------------------------------------------------
const needsReexec = sqlite === null || typeof global.gc !== 'function';

if (needsReexec) {
  describe('StreakCalendarScreen long-run leak (re-exec under --expose-gc --experimental-sqlite)', () => {
    it(
      'runs the whole file under node --expose-gc --experimental-sqlite',
      () => {
        if (process.env['STRESS_CHILD'] === '1') {
          throw new Error(
            `stress harness: node:sqlite=${sqlite !== null} gc=${typeof global.gc} even with flags; Node >= 22.5 is required (running ${process.version})`,
          );
        }
        const jestBin = resolveModule('jest/bin/jest');
        const result = childProcess.spawnSync(
          process.execPath,
          [jestBin, '--ci', '--runInBand', '--runTestsByPath', __filename],
          {
            cwd: path.resolve(__dirname, '../..'),
            env: {
              ...process.env,
              STRESS_CHILD: '1',
              NODE_OPTIONS:
                `${process.env['NODE_OPTIONS'] ?? ''} --expose-gc --experimental-sqlite`.trim(),
            },
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
          },
        );
        const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
        const summaryLine = combined
          .split('\n')
          .find(line => line.includes('[stress] streakCalendar long-run-leak'));
        if (summaryLine) console.log(summaryLine.trim());
        const tail = combined.slice(-8000);
        expect({ status: result.status, tail }).toEqual({ status: 0, tail });
      },
      30 * 60_000,
    );
  });
} else {
  runCampaign();
}

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------
function runCampaign(): void {
  // Real product modules — required lazily so the native mocks above are in
  // place and so `setActiveDataOwner` runs before the store's first refresh.
  const { StreakCalendarScreen } =
    require('../../src/screens/StreakCalendarScreen') as typeof import('../../src/screens/StreakCalendarScreen');
  const { useConsistencyStore } =
    require('../../src/consistency/store') as typeof import('../../src/consistency/store');
  const { getDb, closeDbForTests } =
    require('../../src/data/db') as typeof import('../../src/data/db') & {
      closeDbForTests?: () => void;
    };
  const { setActiveDataOwner } =
    require('../../src/data/accountScope') as typeof import('../../src/data/accountScope');
  const { color } =
    require('../../src/design/tokens') as typeof import('../../src/design/tokens');

  type StackParams = { Home: undefined; StreakCalendar: undefined };
  const Stack = createNativeStackNavigator<StackParams>();
  const navigationRef = createNavigationContainerRef<StackParams>();

  function HomeScreen() {
    return (
      <View testID="stress-home">
        <Pressable
          testID="stress-open-streak"
          accessibilityRole="button"
          onPress={() => navigationRef.navigate('StreakCalendar')}
        >
          <Text>Open consistency</Text>
        </Pressable>
      </View>
    );
  }

  // Mirrors App.tsx (SafeAreaProvider → QueryClientProvider) and
  // RootNavigator.tsx (theme + screenOptions + the StreakCalendar route).
  const queryClient = new QueryClient();
  const theme = {
    ...DefaultTheme,
    colors: {
      ...DefaultTheme.colors,
      background: color.surface,
      primary: color.court,
    },
  };

  function Root() {
    return (
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <NavigationContainer ref={navigationRef} theme={theme}>
            <Stack.Navigator
              initialRouteName="Home"
              screenOptions={{
                headerShown: false,
                animation: 'fade_from_bottom',
                contentStyle: { backgroundColor: color.surface },
              }}
            >
              <Stack.Screen name="Home" component={HomeScreen} />
              <Stack.Screen
                name="StreakCalendar"
                component={StreakCalendarScreen}
                options={{ title: 'Consistency' }}
              />
            </Stack.Navigator>
          </NavigationContainer>
        </QueryClientProvider>
      </SafeAreaProvider>
    );
  }

  // ---- subscription accounting -------------------------------------------
  let storeSubs = 0;
  const rnSubs: Record<string, number> = {};

  function trackEmitter(
    target: { addEventListener: (...args: unknown[]) => unknown },
    label: string,
  ): void {
    const original = target.addEventListener;
    rnSubs[label] = 0;
    target.addEventListener = function (this: unknown, ...args: unknown[]) {
      const sub = original.apply(this, args) as
        { remove?: () => void } | undefined;
      rnSubs[label] = (rnSubs[label] ?? 0) + 1;
      if (sub && typeof sub.remove === 'function') {
        const remove = sub.remove;
        let removed = false;
        sub.remove = function (this: unknown) {
          if (!removed) {
            removed = true;
            rnSubs[label] = (rnSubs[label] ?? 0) - 1;
          }
          return remove.call(this);
        };
      }
      return sub;
    } as typeof original;
  }

  function installSubscriptionTracking(): void {
    const originalSubscribe = useConsistencyStore.subscribe;
    useConsistencyStore.subscribe = ((
      listener: Parameters<typeof originalSubscribe>[0],
    ) => {
      storeSubs += 1;
      const unsubscribe = originalSubscribe(listener);
      let done = false;
      return () => {
        if (!done) {
          done = true;
          storeSubs -= 1;
        }
        unsubscribe();
      };
    }) as typeof originalSubscribe;
    trackEmitter(
      AppState as unknown as { addEventListener: (...a: unknown[]) => unknown },
      'AppState',
    );
    trackEmitter(
      Linking as unknown as { addEventListener: (...a: unknown[]) => unknown },
      'Linking',
    );
    trackEmitter(
      Dimensions as unknown as {
        addEventListener: (...a: unknown[]) => unknown;
      },
      'Dimensions',
    );
  }

  // ---- fetch guard ---------------------------------------------------------
  const fetchCalls: string[] = [];
  (globalThis as { fetch?: unknown }).fetch = async (input: unknown) => {
    fetchCalls.push(String(input));
    throw new Error('stress harness: network is disabled');
  };

  // ---- deterministic clock for the screen's "today" ------------------------
  // The screen derives `today` from `new Date()` only when the snapshot is
  // missing; the store derives `asOfDay` from `new Date()` in refresh. Pin it
  // so every seed sees the same calendar.
  const RealDate = Date;
  class PinnedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(ASOF_ISO);
      } else {
        super(...(args as [string | number | Date]));
      }
    }
    static now(): number {
      return new RealDate(ASOF_ISO).getTime();
    }
  }

  // ---- seeded local history --------------------------------------------
  function seedHistory(db: SqliteDatabaseSync, seed: number): number {
    const rng = makePrng(seed ^ 0x5eed);
    const insert = db.prepare(
      `INSERT INTO local_shot
         (owner_key, id, session_id, shot_type, captured_at, overall_score,
          confidence, result_kind, source, favorite, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'real', 0, ?)`,
    );
    const asOf = new RealDate(ASOF_ISO);
    let inserted = 0;
    for (let daysAgo = 0; daysAgo < 140; daysAgo += 1) {
      // ~65% of days trained, in runs, with a few multi-session days.
      if (rng() > 0.65) continue;
      const shotsToday = 1 + Math.floor(rng() * 4);
      for (let s = 0; s < shotsToday; s += 1) {
        const at = new RealDate(
          asOf.getTime() -
            daysAgo * 86_400_000 -
            Math.floor(rng() * 6) * 3_600_000 -
            s * 60_000,
        );
        const scored = rng() > 0.15;
        insert.run(
          OWNER,
          `shot-${seed}-${daysAgo}-${s}`,
          `session-${seed}-${daysAgo}`,
          SHOT_TYPES[Math.floor(rng() * SHOT_TYPES.length)] as string,
          at.toISOString(),
          scored ? Math.round((4 + rng() * 6) * 10) / 10 : null,
          scored ? 0.9 : 0.4,
          scored ? 'scored' : 'low_confidence',
          '{}',
        );
        inserted += 1;
      }
    }
    return inserted;
  }

  // ---- helpers -----------------------------------------------------------
  async function settle(renderer: ReactTestRenderer | null): Promise<void> {
    // Flush microtasks + one macrotask so the serialized refresh queue,
    // navigation state commits and Animated callbacks all complete.
    await act(async () => {
      await new Promise<void>(resolve => {
        (timerGlobals['setTimeout'] as (cb: () => void, ms: number) => void)(
          resolve,
          0,
        );
      });
    });
    await act(async () => {
      await Promise.resolve();
    });
    void renderer;
  }

  /**
   * Real-time wait until no one-shot timer / immediate / animation frame is
   * outstanding (intervals are compared against the baseline separately), or
   * until `maxMs` elapsed. Returns the wait in ms; the caller compares the
   * remaining timers with the baseline.
   */
  async function waitForTimerQuiescence(
    baselineTimers: Record<string, number> | null,
    maxMs: number,
  ): Promise<number> {
    const start = nowMs();
    const realSetTimeout = timerGlobals['setTimeout'] as (
      cb: () => void,
      ms: number,
    ) => void;
    for (;;) {
      const counts = pendingTimerCounts();
      const quiet = baselineTimers
        ? sameCounts(counts, baselineTimers)
        : Object.entries(counts).every(
            ([kind, n]) => kind === 'interval' || n === 0,
          );
      if (quiet || nowMs() - start > maxMs) return nowMs() - start;
      await act(async () => {
        await new Promise<void>(resolve => realSetTimeout(resolve, 25));
      });
    }
  }

  function nodeCount(renderer: ReactTestRenderer): number {
    return renderer.root.findAll(() => true).length;
  }

  /** Host nodes only, so a composite + its host View is not counted twice. */
  function hostsWithTestId(
    renderer: ReactTestRenderer,
    testID: string,
  ): ReactTestInstance[] {
    return renderer.root.findAll(
      node => typeof node.type === 'string' && node.props['testID'] === testID,
    );
  }

  function findByLabel(
    renderer: ReactTestRenderer,
    label: string,
  ): ReactTestInstance | null {
    const matches = renderer.root.findAll(
      node =>
        node.props['accessibilityLabel'] === label &&
        typeof node.props['onPress'] === 'function',
    );
    return matches[0] ?? null;
  }

  function findAllPressable(
    renderer: ReactTestRenderer,
    predicate: (label: string) => boolean,
  ): ReactTestInstance[] {
    return renderer.root.findAll(
      node =>
        typeof node.props['accessibilityLabel'] === 'string' &&
        typeof node.props['onPress'] === 'function' &&
        predicate(node.props['accessibilityLabel'] as string),
    );
  }

  function currentRoute(): string | null {
    return navigationRef.isReady()
      ? (navigationRef.getCurrentRoute()?.name ?? null)
      : null;
  }

  function nowMs(): number {
    return Number(process.hrtime.bigint()) / 1e6;
  }

  function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
      : (sorted[mid] as number);
  }

  function activeResources(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const kind of process.getActiveResourcesInfo()) {
      counts[kind] = (counts[kind] ?? 0) + 1;
    }
    return counts;
  }

  function sameCounts(
    a: Record<string, number>,
    b: Record<string, number>,
  ): boolean {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if ((a[key] ?? 0) !== (b[key] ?? 0)) return false;
    }
    return true;
  }

  function gcAndSample(iteration: number, mountTimes: number[]): HeapSample {
    // Nothing in this harness asserts on mock call records (see
    // KEEP_MOCK_LEDGERS above).
    if (!KEEP_MOCK_LEDGERS) jest.clearAllMocks();
    const gc = global.gc as () => void;
    gc();
    gc();
    const usage = process.memoryUsage();
    const resources = activeResources();
    return {
      iteration,
      heapUsedMb: round2(usage.heapUsed / 1048576),
      heapTotalMb: round2(usage.heapTotal / 1048576),
      rssMb: round2(usage.rss / 1048576),
      externalMb: round2(usage.external / 1048576),
      arrayBuffersMb: round2(usage.arrayBuffers / 1048576),
      activeResources: resources,
      activeHandleCount: Object.values(resources).reduce((a, b) => a + b, 0),
      pendingTimers: pendingTimerCounts(),
      storeSubs,
      medianMountMsLastWindow: round2(median(mountTimes.slice(-SAMPLE_EVERY))),
    };
  }

  function round2(value: number): number {
    return Math.round(value * 100) / 100;
  }

  /** Least-squares slope of heapUsed per 100 iterations, as a fraction of the first sample. */
  function heapSlopePer100(samples: HeapSample[]): number {
    if (samples.length < 2) return 0;
    const n = samples.length;
    const xs = samples.map(s => s.iteration);
    const ys = samples.map(s => s.heapUsedMb);
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i += 1) {
      num += ((xs[i] as number) - mx) * ((ys[i] as number) - my);
      den += ((xs[i] as number) - mx) ** 2;
    }
    const slopePerIteration = den === 0 ? 0 : num / den;
    return (slopePerIteration * 100) / (ys[0] as number);
  }

  function isMonotoneGrowth(samples: HeapSample[]): boolean {
    if (samples.length < 2) return false;
    for (let i = 1; i < samples.length; i += 1) {
      if (
        (samples[i] as HeapSample).heapUsedMb <=
        (samples[i - 1] as HeapSample).heapUsedMb
      ) {
        return false;
      }
    }
    return true;
  }

  function writeHeapSnapshot(label: string): string | null {
    if (!WRITE_HEAP_SNAPSHOTS) return null;
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const v8 = require('node:v8') as NodeV8;
    (global.gc as () => void)();
    return v8.writeHeapSnapshot(path.join(OUT_DIR, `${label}.heapsnapshot`));
  }

  function writeArtifact(name: string, value: unknown): string {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR, name);
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
    return file;
  }

  // ---- the campaign ------------------------------------------------------
  describe('StreakCalendarScreen long-run leak (real navigator + store + SQLite)', () => {
    const rows: IterationRow[] = [];
    const samples: HeapSample[] = [];
    const mountTimes: number[] = [];
    let renderer: ReactTestRenderer | null = null;
    let baseline: {
      timers: Record<string, number>;
      storeSubs: number;
      rnSubs: Record<string, number>;
      nodesAtHome: number;
      resources: Record<string, number>;
    } | null = null;
    let seededShots = 0;

    beforeAll(async () => {
      if (!KEEP_MOCK_LEDGERS) {
        const { performance: realPerformance } =
          require('node:perf_hooks') as NodePerfHooks;
        // Same object the scheduler captured at load; only `now` is replaced.
        (globalThis as { performance: { now(): number } }).performance.now =
          () => realPerformance.now();
      }
      (globalThis as { Date: unknown }).Date = PinnedDate;
      const { DatabaseSync } = sqlite as NonNullable<typeof sqlite>;
      mockSqlite.db = new DatabaseSync(':memory:');
      setActiveDataOwner(OWNER);
      // Production schema via the production migration path.
      getDb();
      seededShots = seedHistory(mockSqlite.db, BASE_SEED);
      installSubscriptionTracking();
      await act(async () => {
        renderer = TestRenderer.create(<Root />);
      });
      await settle(renderer);
      // Hydrate the store exactly the way App.tsx's bootstrap does, so the
      // first screen visit sees a snapshot (the cold-store variant clears it).
      await act(async () => {
        await useConsistencyStore.getState().hydrate();
      });
      await settle(renderer);
      // NavigationContainer arms a 1 s "multiple linking handlers" check and
      // a 150 ms getInitialURL race on mount; let them fire before baselining.
      await waitForTimerQuiescence(null, 5_000);
    });

    afterAll(() => {
      if (renderer) {
        act(() => (renderer as ReactTestRenderer).unmount());
      }
      (globalThis as { Date: unknown }).Date = RealDate;
      if (typeof closeDbForTests === 'function') closeDbForTests();
      mockSqlite.db?.close();
    });

    async function runIteration(scenario: Scenario): Promise<IterationRow> {
      const r = renderer as ReactTestRenderer;
      const failed: string[] = [];
      const invariants: Record<string, boolean> = {};
      let error: string | null = null;
      const t0 = nowMs();
      let mountMs = 0;
      let nodesWhileMounted = 0;
      let detailShown = false;
      let quiesceMs = 0;

      try {
        if (scenario.coldStore) {
          act(() => {
            useConsistencyStore.setState({ snapshot: null, loadError: false });
          });
        }

        const tMount = nowMs();
        await act(async () => {
          navigationRef.navigate('StreakCalendar');
        });
        await settle(r);
        mountMs = nowMs() - tMount;

        const hero = hostsWithTestId(r, 'streak-hero');
        invariants['mountedWithHero'] = hero.length === 1;
        if (hero.length !== 1) failed.push('mountedWithHero');
        invariants['noLoadError'] =
          hostsWithTestId(r, 'streak-load-error').length === 0;
        if (!invariants['noLoadError']) failed.push('noLoadError');

        for (const action of scenario.actions) {
          switch (action) {
            case 'prevMonth':
            case 'nextMonth': {
              const button = findByLabel(
                r,
                action === 'prevMonth' ? 'Previous month' : 'Next month',
              );
              if (button && !button.props['disabled']) {
                await act(async () => {
                  (button.props['onPress'] as () => void)();
                });
              }
              break;
            }
            case 'tapDay': {
              const days = findAllPressable(r, label =>
                /^\d{4}-\d{2}-\d{2}/.test(label),
              ).filter(n => !n.props['disabled']);
              if (days.length > 0) {
                const rng = makePrng(scenario.seed ^ days.length);
                const pick = days[
                  Math.floor(rng() * days.length)
                ] as ReactTestInstance;
                await act(async () => {
                  (pick.props['onPress'] as () => void)();
                });
                detailShown =
                  detailShown ||
                  hostsWithTestId(r, 'streak-day-detail').length > 0;
              }
              break;
            }
            case 'tapAchievement': {
              const badges = findAllPressable(r, label =>
                /Earned|Locked/.test(label),
              );
              if (badges.length > 0) {
                const rng = makePrng(scenario.seed ^ 0xbade);
                const pick = badges[
                  Math.floor(rng() * badges.length)
                ] as ReactTestInstance;
                await act(async () => {
                  (pick.props['onPress'] as () => void)();
                });
              }
              break;
            }
            case 'refresh': {
              await act(async () => {
                await useConsistencyStore.getState().refresh();
              });
              break;
            }
            case 'toggleShieldOff':
            case 'noop':
              break;
          }
        }
        await settle(r);
        nodesWhileMounted = nodeCount(r);
        invariants['stillOnStreakRoute'] = currentRoute() === 'StreakCalendar';
        if (!invariants['stillOnStreakRoute'])
          failed.push('stillOnStreakRoute');

        // Leave the way a user does: the header back button.
        const back = findByLabel(r, 'Back');
        invariants['backButtonPresent'] = back !== null;
        if (back) {
          await act(async () => {
            (back.props['onPress'] as () => void)();
          });
        } else {
          failed.push('backButtonPresent');
          await act(async () => {
            navigationRef.goBack();
          });
        }
        await settle(r);
        quiesceMs = await waitForTimerQuiescence(
          baseline ? baseline.timers : null,
          QUIESCE_MAX_MS,
        );
      } catch (err) {
        error =
          err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        failed.push('threw');
        invariants['threw'] = false;
        // Try to get back to Home so later seeds are not poisoned.
        try {
          await act(async () => {
            if (navigationRef.isReady() && navigationRef.canGoBack()) {
              navigationRef.goBack();
            }
          });
          await settle(r);
        } catch {
          // reported through `threw`
        }
      }

      const routeAfter = currentRoute();
      const nodesAtHome = nodeCount(r);
      const timers = pendingTimerCounts();
      const timerOrigins =
        baseline && !sameCounts(timers, baseline.timers)
          ? pendingTimerOrigins()
          : [];
      const rn = { ...rnSubs };
      const snapshot = useConsistencyStore.getState().snapshot;

      invariants['unmountedToHome'] =
        routeAfter === 'Home' && hostsWithTestId(r, 'streak-hero').length === 0;
      if (!invariants['unmountedToHome']) failed.push('unmountedToHome');

      if (baseline) {
        invariants['timersOk'] = sameCounts(timers, baseline.timers);
        invariants['storeSubsOk'] = storeSubs === baseline.storeSubs;
        invariants['rnSubsOk'] = sameCounts(rn, baseline.rnSubs);
        invariants['treeOk'] = nodesAtHome === baseline.nodesAtHome;
        for (const key of ['timersOk', 'storeSubsOk', 'rnSubsOk', 'treeOk']) {
          if (!invariants[key]) failed.push(key);
        }
      }
      invariants['noFetch'] = fetchCalls.length === 0;
      if (!invariants['noFetch']) failed.push('noFetch');

      mountTimes.push(mountMs);
      return {
        seed: scenario.seed,
        iteration: scenario.iteration,
        coldStore: scenario.coldStore,
        actions: scenario.actions,
        outcome: failed.length === 0 ? 'HELD' : 'BROKEN',
        failed,
        invariants,
        observed: {
          mountMs: round2(mountMs),
          totalMs: round2(nowMs() - t0),
          nodesWhileMounted,
          nodesAtHome,
          pendingTimers: timers,
          timerOrigins,
          quiesceMs: round2(quiesceMs),
          storeSubs,
          rnSubs: rn,
          routeAfter,
          snapshotAsOfDay: snapshot?.asOfDay ?? null,
          streak: snapshot?.currentStreak ?? null,
          detailShown,
          error,
        },
      };
    }

    it(
      `mounts/unmounts the screen ${ITERATIONS}× (seed ${BASE_SEED}) without leaking timers, subscriptions, tree nodes or heap`,
      async () => {
        expect(seededShots).toBeGreaterThan(0);
        expect(currentRoute()).toBe('Home');
        expect(useConsistencyStore.getState().snapshot?.asOfDay).toBe(
          '2026-09-04',
        );

        // Warm-up visit (module-level caches, lazy requires, JIT) — counted
        // separately, then the post-warmup state is the baseline.
        const warm = await runIteration({
          seed: BASE_SEED - 1,
          iteration: -1,
          coldStore: false,
          actions: ['nextMonth', 'prevMonth', 'tapDay', 'tapAchievement'],
        });
        expect(warm.failed).toEqual([]);
        await waitForTimerQuiescence(null, 5_000);
        const gc = global.gc as () => void;
        gc();
        baseline = {
          timers: pendingTimerCounts(),
          storeSubs,
          rnSubs: { ...rnSubs },
          nodesAtHome: nodeCount(renderer as ReactTestRenderer),
          resources: activeResources(),
        };
        mountTimes.length = 0;
        samples.push(gcAndSample(0, [warm.observed.mountMs]));
        const heapSnapshots: string[] = [];
        const first = writeHeapSnapshot('heap-after-warmup');
        if (first) heapSnapshots.push(first);

        for (let i = 0; i < ITERATIONS; i += 1) {
          const scenario = scenarioFor(BASE_SEED + i, i);
          rows.push(await runIteration(scenario));
          if ((i + 1) % SAMPLE_EVERY === 0 || i + 1 === ITERATIONS) {
            samples.push(gcAndSample(i + 1, mountTimes));
          }
        }

        const lastSnapshot = writeHeapSnapshot(`heap-after-${rows.length}`);
        if (lastSnapshot) heapSnapshots.push(lastSnapshot);

        // ---- campaign-level invariants -----------------------------------
        const slope = heapSlopePer100(samples.slice(1));
        const monotone = isMonotoneGrowth(samples.slice(1));
        const heapSlopeOk = !(monotone && slope > HEAP_SLOPE_LIMIT_PER_100);
        const firstSample = samples[1] as HeapSample;
        const last = samples[samples.length - 1] as HeapSample;
        const heapGrowthPct = round2(
          ((last.heapUsedMb - firstSample.heapUsedMb) /
            firstSample.heapUsedMb) *
            100,
        );
        const firstWindow = median(mountTimes.slice(0, SAMPLE_EVERY));
        const lastWindow = median(mountTimes.slice(-SAMPLE_EVERY));
        const drift = firstWindow === 0 ? 1 : lastWindow / firstWindow;
        const driftOk = drift <= DRIFT_LIMIT;
        // Node handles must be back at baseline once the campaign settles;
        // a sample taken while a scheduler/act timeout is in flight is noted,
        // not failed (it cannot be a leak if the last sample is at baseline).
        const handlesOk = sameCounts(last.activeResources, baseline!.resources);
        const transientHandleSamples = samples
          .slice(1)
          .filter(s => !sameCounts(s.activeResources, baseline!.resources))
          .map(s => ({ iteration: s.iteration, resources: s.activeResources }));
        const brokenRows = rows.filter(r => r.outcome === 'BROKEN');

        const summary = {
          unit: 'scr-streakcalendarscreen',
          lens: 'long-run-leak',
          node: process.version,
          baseSeed: BASE_SEED,
          iterations: rows.length,
          seededShots,
          sqliteOpens: mockSqlite.opens,
          held: rows.length - brokenRows.length,
          broken: brokenRows.length,
          brokenSeeds: brokenRows.map(r => ({
            seed: r.seed,
            failed: r.failed,
            error: r.observed.error,
          })),
          coldStoreIterations: rows.filter(r => r.coldStore).length,
          baseline,
          heap: {
            samples,
            slopePer100Iterations: round2(slope * 100) / 100,
            slopePer100IterationsPct: round2(slope * 100),
            monotone,
            growthPctFirstToLast: heapGrowthPct,
            limitPctPer100: HEAP_SLOPE_LIMIT_PER_100 * 100,
            heapSlopeOk,
            heapSnapshots,
            mockLedgersKept: KEEP_MOCK_LEDGERS,
            presetClockRecordedCalls: presetClockCallCount(),
          },
          handles: {
            baseline: baseline!.resources,
            last: last.activeResources,
            transientHandleSamples,
            handlesOk,
          },
          renderDrift: {
            firstWindowMedianMountMs: round2(firstWindow),
            lastWindowMedianMountMs: round2(lastWindow),
            ratio: round2(drift),
            limit: DRIFT_LIMIT,
            driftOk,
            allMountMs: mountTimes.map(round2),
          },
          fetchCalls,
        };

        const seedTable = writeArtifact('seed-outcomes.json', rows);
        const heapTable = writeArtifact('heap-samples.json', samples);
        const summaryFile = writeArtifact('summary.json', summary);
        console.log(
          `[stress] streakCalendar long-run-leak: ${rows.length} iterations, ${brokenRows.length} BROKEN, heap ${firstSample.heapUsedMb}→${last.heapUsedMb} MB (slope ${round2(slope * 100)}%/100it, monotone=${monotone}), drift ${round2(drift)}x; artifacts: ${seedTable}, ${heapTable}, ${summaryFile}`,
        );

        expect(
          brokenRows.map(r => ({
            seed: r.seed,
            failed: r.failed,
            error: r.observed.error,
          })),
        ).toEqual([]);
        expect({ heapSlopeOk, handlesOk, driftOk }).toEqual({
          heapSlopeOk: true,
          handlesOk: true,
          driftOk: true,
        });
      },
      60 * 60_000,
    );
  });
}
