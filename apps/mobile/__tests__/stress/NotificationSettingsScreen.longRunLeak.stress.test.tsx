/**
 * STRESS / long-run-leak — NotificationSettingsScreen mounted inside the REAL
 * React Navigation container + native-stack navigator, backed by the REAL
 * notificationStore (zustand), the REAL local db layer (production getDb()
 * migrations on a real SQLite via node:sqlite) and the REAL NotifeeScheduler
 * (SchedulerPort → the notify-kit native module mock in __mocks__).
 *
 * Only native modules are replaced:
 *   - @op-engineering/op-sqlite  → node:sqlite in-memory database
 *   - react-native-notify-kit    → apps/mobile/__mocks__ (auto-mock)
 *   - react-native-screens / safe-area-context / Linking → RN jest preset
 *     host-component + module mocks (already part of the test environment)
 *
 * `zustand/vanilla` is wrapped (NOT replaced) so every store's live
 * subscriber count is observable; behaviour is the actual implementation.
 *
 * Each iteration is a seeded scenario (permission state, native failure
 * injection, a random walk over the screen's controls, blur/refocus through
 * the navigator) followed by a full unmount. After every iteration the
 * outstanding timers / immediates, store subscribers and RN event listeners
 * must be back at their pre-mount baseline. Every 50 iterations the heap is
 * forced-GC'd and sampled together with Node's active handles.
 *
 *   STRESS_ITER  iterations (default 60 — fast enough for the normal suite;
 *                the campaign runs 500+)
 *   STRESS_SEED  campaign seed (default 20260904)
 *   STRESS_OUT   optional path for the JSON seed→outcome table
 *
 * Replay one iteration: STRESS_ITER=1 STRESS_SEED=<iteration seed>
 * STRESS_REPLAY=1 (the campaign seed is then used directly as the
 * iteration seed).
 *
 * Run with heap access: node --expose-gc node_modules/.bin/jest --ci
 *   __tests__/stress/NotificationSettingsScreen.longRunLeak.stress.test.tsx
 */
import '../../testing/stress/installLeakProbe';
import React from 'react';
import { AppState, Dimensions, Linking, Text, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  NavigationContainer,
  createNavigationContainerRef,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import {
  forcedHeapUsed,
  gcExposed,
  handleSnapshot,
  iterationSeed,
  linearSlope,
  median,
  mulberry32,
  nowMs,
  outstandingTimerDetails,
  timerCounts,
  type HandleSnapshot,
  type TimerCounts,
} from '../../testing/stress/leakProbe';

// apps/mobile types only `jest` (no @types/node); Node built-ins are loaded
// via jest.requireActual, and `require` is declared for the notify-kit mock.
declare const require: (id: string) => unknown;

// ─── Native module replacement: op-sqlite → node:sqlite ─────────────────────

interface SqliteStatement {
  all(...params: (string | number | null)[]): Record<string, unknown>[];
}
interface DatabaseSync {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}
const mockSqlite: { db: DatabaseSync | null } = { db: null };
jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    if (!mockSqlite.db) {
      const { DatabaseSync: Sqlite } = jest.requireActual<{
        DatabaseSync: new (location: string) => DatabaseSync;
      }>('node:sqlite');
      mockSqlite.db = new Sqlite(':memory:');
    }
    const db = mockSqlite.db;
    return {
      executeSync: (sql: string) => ({ rows: db.prepare(sql).all() }),
      execute: async (sql: string, params: unknown[] = []) => ({
        rows: db.prepare(sql).all(...(params as (string | number | null)[])),
      }),
      close: () => {},
    };
  },
}));

// ─── Store subscriber probe: zustand/vanilla wrapped, behaviour unchanged ───

type SubscriberProbe = { live: () => number };
jest.mock('zustand/vanilla', () => {
  const actual =
    jest.requireActual<typeof import('zustand/vanilla')>('zustand/vanilla');
  let live = 0;
  (
    globalThis as unknown as { __zustandProbe: SubscriberProbe }
  ).__zustandProbe = { live: () => live };
  const createStoreImpl = (createState: never) => {
    const api = actual.createStore(createState);
    const subscribe = api.subscribe;
    api.subscribe = listener => {
      live += 1;
      const unsubscribe = subscribe(listener);
      let done = false;
      return () => {
        if (!done) {
          done = true;
          live -= 1;
        }
        unsubscribe();
      };
    };
    return api;
  };
  const createStore = (createState?: never) =>
    createState ? createStoreImpl(createState) : createStoreImpl;
  return { ...actual, createStore };
});
const zustandProbe = (
  globalThis as unknown as { __zustandProbe: SubscriberProbe }
).__zustandProbe;

// ─── App modules (real) ─────────────────────────────────────────────────────

import { NotificationSettingsScreen } from '../../src/screens/NotificationSettingsScreen';
import { BrandToggle } from '../../src/design/components';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import {
  GUEST_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import type { RootStackParams } from '../../src/navigation/params';

type NotifeeMock = {
  default: {
    getNotificationSettings: jest.Mock;
    requestPermission: jest.Mock;
    createTriggerNotification: jest.Mock;
    getTriggerNotificationIds: jest.Mock;
    cancelTriggerNotification: jest.Mock;
    openNotificationSettings: jest.Mock;
  };
};
// The SAME instance the real NotifeeScheduler loads (jest.requireMock hands
// back a separate registry entry for auto-mocked node modules).
const notifee = (require('react-native-notify-kit') as NotifeeMock).default;

// ─── RN event-listener probe (Linking / AppState / Dimensions) ─────────────

type Subscription = { remove: () => void };
type AddListener = (...args: unknown[]) => Subscription | undefined;
const listenerLive = { count: 0 };
function probeListeners(target: object, name: string) {
  const record = target as Record<string, unknown>;
  const original = record[name] as AddListener | undefined;
  if (typeof original !== 'function') return;
  record[name] = (...args: unknown[]) => {
    const sub = original.apply(target, args);
    listenerLive.count += 1;
    if (!sub || typeof sub.remove !== 'function') {
      return sub;
    }
    const remove = sub.remove;
    let removed = false;
    sub.remove = () => {
      if (!removed) {
        removed = true;
        listenerLive.count -= 1;
      }
      remove.call(sub);
    };
    return sub;
  };
}
probeListeners(Linking, 'addEventListener');
probeListeners(AppState, 'addEventListener');
probeListeners(Dimensions, 'addEventListener');

// ─── Real navigator around the real screen ──────────────────────────────────

type StressStackParams = Pick<RootStackParams, 'NotificationSettings'> & {
  Probe: undefined;
};
const Stack = createNativeStackNavigator<StressStackParams>();
const navigationRef = createNavigationContainerRef<StressStackParams>();

function ProbeScreen() {
  return (
    <View>
      <Text>probe</Text>
    </View>
  );
}

const INITIAL_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, bottom: 34, left: 0, right: 0 },
};

function Harness() {
  return (
    <SafeAreaProvider initialMetrics={INITIAL_METRICS}>
      <NavigationContainer ref={navigationRef}>
        <Stack.Navigator initialRouteName="NotificationSettings">
          <Stack.Screen
            name="NotificationSettings"
            component={NotificationSettingsScreen}
            options={{ title: 'Notifications' }}
          />
          <Stack.Screen name="Probe" component={ProbeScreen} />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

// ─── Scenario model ─────────────────────────────────────────────────────────

type Permission = 'granted' | 'denied' | 'undetermined';
type Action =
  | 'toggle-all'
  | 'toggle-practice'
  | 'toggle-streak'
  | 'toggle-weekly'
  | 'toggle-comeback'
  | 'preset'
  | 'step-earlier'
  | 'step-later'
  | 'turn-on'
  | 'open-settings'
  | 'check-again'
  | 'blur-refocus'
  | 'back';

interface Scenario {
  permission: Permission;
  permissionReadFails: boolean;
  requestFails: boolean;
  scheduleFails: boolean;
  settingsOpenFails: boolean;
  actions: Action[];
  /** Master switch state the (real, persisted) store is put in before the
   *  mount, so both screen layouts — toggles vs. "Turn on reminders" — get
   *  exercised regardless of what the previous iteration left behind. */
  startEnabled: boolean;
}

const ALL_ACTIONS: Action[] = [
  'toggle-all',
  'toggle-practice',
  'toggle-streak',
  'toggle-weekly',
  'toggle-comeback',
  'preset',
  'step-earlier',
  'step-later',
  'turn-on',
  'open-settings',
  'check-again',
  'blur-refocus',
  'back',
];

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

function scenarioFor(seed: number): Scenario {
  const rng = mulberry32(seed);
  const p = rng();
  const permission: Permission =
    p < 0.6 ? 'granted' : p < 0.8 ? 'denied' : 'undetermined';
  const actionCount = Math.floor(rng() * 4); // 0..3
  const actions: Action[] = [];
  for (let i = 0; i < actionCount; i += 1) actions.push(pick(rng, ALL_ACTIONS));
  return {
    permission,
    permissionReadFails: rng() < 0.1,
    requestFails: rng() < 0.1,
    scheduleFails: rng() < 0.1,
    settingsOpenFails: rng() < 0.1,
    actions,
    startEnabled: rng() < 0.5,
  };
}

// ─── Render helpers ─────────────────────────────────────────────────────────

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });
}

/**
 * After unmount, let in-flight *finite* work complete before judging the
 * residue: the RN jest preset's NativeAnimatedModule mock completes every
 * `startAnimatingNode` with a 16 ms setTimeout (BrandToggle / stack
 * transitions), so a toggle pressed right before unmount legitimately has a
 * 16 ms timer pending. Bounded (≤ 4 × 20 ms); intervals, listeners, store
 * subscribers and long timers are not masked by this — they never drain.
 */
async function settle(baseline: TimerCounts) {
  for (let round = 0; round < 4; round += 1) {
    const now = timerCounts();
    if (
      now.timeouts <= baseline.timeouts &&
      now.intervals <= baseline.intervals &&
      now.immediates <= baseline.immediates
    ) {
      return;
    }
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 20));
    });
  }
}

function pressables(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function' &&
      node.props.disabled !== true,
  );
}

function switches(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root
    .findAllByType(BrandToggle)
    .filter(node => node.props.label === label && node.props.disabled !== true);
}

async function press(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const [node] = pressables(renderer, label);
  if (!node) return false;
  await act(async () => {
    node.props.onPress();
  });
  await flush();
  return true;
}

async function toggle(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const [node] = switches(renderer, label);
  if (!node) return false;
  await act(async () => {
    node.props.onValueChange(!node.props.value);
  });
  await flush();
  return true;
}

async function applyAction(
  renderer: TestRenderer.ReactTestRenderer,
  action: Action,
  rng: () => number,
): Promise<boolean> {
  switch (action) {
    case 'toggle-all':
      return toggle(renderer, 'All reminders');
    case 'toggle-practice':
      return toggle(renderer, 'Practice nudge');
    case 'toggle-streak':
      return toggle(renderer, 'Streak defense');
    case 'toggle-weekly':
      return toggle(renderer, 'Weekly recap');
    case 'toggle-comeback':
      return toggle(renderer, 'Welcome back');
    case 'preset': {
      const presets = renderer.root.findAll(
        node =>
          typeof node.props.accessibilityLabel === 'string' &&
          /^(Morning|Midday|Evening|Night)/.test(
            node.props.accessibilityLabel,
          ) &&
          typeof node.props.onPress === 'function',
      );
      if (presets.length === 0) return false;
      const node = pick(rng, presets);
      await act(async () => {
        node.props.onPress();
      });
      await flush();
      return true;
    }
    case 'step-earlier':
      return press(renderer, 'Reminder 30 minutes earlier');
    case 'step-later':
      return press(renderer, 'Reminder 30 minutes later');
    case 'turn-on':
      return press(renderer, 'Turn on reminders');
    case 'open-settings':
      return press(renderer, 'Open system settings');
    case 'check-again':
      return press(renderer, 'Check again');
    case 'back':
      // Root of the stack: goBack is a no-op the navigator must absorb.
      return press(renderer, 'Back');
    case 'blur-refocus': {
      if (!navigationRef.isReady()) return false;
      await act(async () => {
        navigationRef.navigate('Probe');
      });
      await flush();
      await act(async () => {
        if (navigationRef.canGoBack()) navigationRef.goBack();
      });
      await flush();
      return true;
    }
  }
}

function configureNative(scenario: Scenario) {
  const status =
    scenario.permission === 'granted'
      ? 1
      : scenario.permission === 'denied'
        ? 0
        : -1;
  notifee.getNotificationSettings.mockImplementation(async () => {
    if (scenario.permissionReadFails) throw new Error('settings read failed');
    return { authorizationStatus: status };
  });
  notifee.requestPermission.mockImplementation(async () => {
    if (scenario.requestFails) throw new Error('prompt failed');
    return { authorizationStatus: status === -1 ? 1 : status };
  });
  notifee.createTriggerNotification.mockImplementation(
    async (notification: { id?: string }) => {
      if (scenario.scheduleFails) throw new Error('schedule failed');
      return notification.id ?? 'mock-id';
    },
  );
  notifee.getTriggerNotificationIds.mockImplementation(async () => []);
  notifee.cancelTriggerNotification.mockImplementation(async () => {});
  const linkingMock = Linking.openSettings as unknown as jest.Mock;
  linkingMock.mockImplementation(async () => {
    if (scenario.settingsOpenFails) throw new Error('deep link failed');
  });
}

// ─── Campaign ───────────────────────────────────────────────────────────────

interface IterationRow {
  i: number;
  seed: number;
  scenario: Scenario;
  applied: Action[];
  outcome: 'HELD' | 'BROKEN';
  reason?: string;
  mountMs: number;
  totalMs: number;
  refreshCalls: number;
  timersAfter: TimerCounts;
  subscribersAfter: number;
  listenersAfter: number;
}

interface HeapSample {
  iteration: number;
  heapUsed: number;
  handles: HandleSnapshot;
  timers: TimerCounts;
  subscribers: number;
  listeners: number;
}

const env = (
  globalThis as unknown as {
    process: { env: Record<string, string | undefined> };
  }
).process.env;
// STRESS_ITER set ⇒ campaign mode (heap slope is mandatory, needs --expose-gc);
// unset ⇒ the fast default that lives in the suite (60 iterations, ~3 s).
const CAMPAIGN = env.STRESS_ITER !== undefined;
const ITERATIONS = Math.max(1, Number(env.STRESS_ITER ?? '60') || 60);
const CAMPAIGN_SEED = Number(env.STRESS_SEED ?? '20260904') || 20260904;
const REPLAY = env.STRESS_REPLAY === '1';
const OUT_PATH = env.STRESS_OUT;
// STRESS_KEEP_MOCK_CALLS=1 keeps jest.fn() call recordings across iterations
// (diagnostic: quantifies how much of the heap slope is mock bookkeeping).
const KEEP_MOCK_CALLS = env.STRESS_KEEP_MOCK_CALLS === '1';
const SAMPLE_EVERY = 50;
const WARMUP = Math.min(SAMPLE_EVERY, ITERATIONS);
// Lens threshold: monotone heap slope > 5% per 100 iterations is a finding.
const SLOPE_LIMIT_PCT_PER_100 = 5;
const RENDER_DRIFT_LIMIT = 3;

function seedFor(i: number) {
  return REPLAY ? CAMPAIGN_SEED : iterationSeed(CAMPAIGN_SEED, i);
}

function writeJson(path: string, value: unknown) {
  const fs = jest.requireActual<{
    mkdirSync(p: string, o: { recursive: boolean }): void;
    writeFileSync(p: string, data: string): void;
  }>('fs');
  const dir = path.replace(/\/[^/]*$/, '');
  if (dir && dir !== path) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path, JSON.stringify(value, null, 2));
}

describe('NotificationSettingsScreen long-run leak (real navigator + stores)', () => {
  beforeAll(async () => {
    setActiveDataOwner(GUEST_DATA_OWNER);
    configureNative(scenarioFor(0));
    // Exactly what the app does once per launch: hydrate the store before any
    // screen mounts (it runs getDb() migrations against the real SQLite).
    await useNotificationStore.getState().hydrate();
  });

  afterAll(() => {
    mockSqlite.db?.close();
    mockSqlite.db = null;
  });

  it(
    `mount/unmount ${ITERATIONS}× (seed ${CAMPAIGN_SEED}) leaves timers, listeners, store subscribers and heap at baseline`,
    async () => {
      const rows: IterationRow[] = [];
      const heapSamples: HeapSample[] = [];
      const failures: string[] = [];

      // Baseline AFTER store hydration and with an empty tree.
      await flush();
      const baselineTimers = timerCounts();
      const baselineSubscribers = zustandProbe.live();
      const baselineListeners = listenerLive.count;
      heapSamples.push({
        iteration: 0,
        heapUsed: forcedHeapUsed(),
        handles: handleSnapshot(),
        timers: baselineTimers,
        subscribers: baselineSubscribers,
        listeners: baselineListeners,
      });

      for (let i = 1; i <= ITERATIONS; i += 1) {
        const seed = seedFor(i);
        const scenario = scenarioFor(seed);
        const rng = mulberry32(seed ^ 0x5bd1e995);
        // jest.fn() records every call's arguments forever (notifee mock, the
        // RN preset's NativeAnimated/UIManager mocks…). That is test-infra
        // memory, not app memory: drop the recordings so the heap slope
        // measures what the screen/navigator/stores retain. Implementations
        // are kept (clear, not reset).
        if (!KEEP_MOCK_CALLS) jest.clearAllMocks();
        configureNative(scenario);
        if (
          useNotificationStore.getState().prefs.enabled !==
          scenario.startEnabled
        ) {
          // Real store action (persists to SQLite and reconciles the scheduler).
          await useNotificationStore
            .getState()
            .setPrefs({ enabled: scenario.startEnabled });
        }
        const refreshBefore = notifee.getNotificationSettings.mock.calls.length;
        const applied: Action[] = [];
        const reasons: string[] = [];

        const t0 = nowMs();
        let renderer!: TestRenderer.ReactTestRenderer;
        try {
          await act(async () => {
            renderer = TestRenderer.create(<Harness />);
          });
          await flush();
          const mountMs = nowMs() - t0;

          // The real screen must be on the stack, with its header title.
          const texts = renderer.root
            .findAllByType(Text)
            .map(n => n.props.children)
            .flat()
            .filter((c): c is string => typeof c === 'string');
          if (!texts.includes('Notifications')) {
            reasons.push(
              `screen not rendered inside navigator: ${texts
                .slice(0, 5)
                .join(' | ')}`,
            );
          }

          for (const action of scenario.actions) {
            if (await applyAction(renderer, action, rng)) applied.push(action);
          }

          await act(async () => {
            renderer.unmount();
          });
          await flush();
          await settle(baselineTimers);
          const totalMs = nowMs() - t0;

          const timersAfter = timerCounts();
          const subscribersAfter = zustandProbe.live();
          const listenersAfter = listenerLive.count;
          const refreshCalls =
            notifee.getNotificationSettings.mock.calls.length - refreshBefore;

          if (
            timersAfter.timeouts !== baselineTimers.timeouts ||
            timersAfter.intervals !== baselineTimers.intervals ||
            timersAfter.immediates !== baselineTimers.immediates
          ) {
            const detail = outstandingTimerDetails()
              .map(d => `${d.kind}(${d.delayMs}ms) ${d.stack}`)
              .join(' || ');
            reasons.push(
              `timers not at baseline after unmount: ${JSON.stringify(
                timersAfter,
              )} vs ${JSON.stringify(baselineTimers)}${detail ? ` :: ${detail}` : ''}`,
            );
          }
          if (subscribersAfter !== baselineSubscribers) {
            reasons.push(
              `store subscribers ${subscribersAfter} != baseline ${baselineSubscribers}`,
            );
          }
          if (listenersAfter !== baselineListeners) {
            reasons.push(
              `RN listeners ${listenersAfter} != baseline ${baselineListeners}`,
            );
          }
          if (refreshCalls < 1) {
            reasons.push(
              `useFocusEffect did not refresh permission (calls=${refreshCalls})`,
            );
          }

          rows.push({
            i,
            seed,
            scenario,
            applied,
            outcome: reasons.length ? 'BROKEN' : 'HELD',
            reason: reasons.length ? reasons.join('; ') : undefined,
            mountMs,
            totalMs,
            refreshCalls,
            timersAfter,
            subscribersAfter,
            listenersAfter,
          });
        } catch (error) {
          reasons.push(
            `threw: ${error instanceof Error ? error.message : String(error)}`,
          );
          rows.push({
            i,
            seed,
            scenario,
            applied,
            outcome: 'BROKEN',
            reason: reasons.join('; '),
            mountMs: -1,
            totalMs: nowMs() - t0,
            refreshCalls: -1,
            timersAfter: timerCounts(),
            subscribersAfter: zustandProbe.live(),
            listenersAfter: listenerLive.count,
          });
        }
        if (reasons.length) {
          failures.push(`seed ${seed} (i=${i}): ${reasons.join('; ')}`);
        }

        if (i % SAMPLE_EVERY === 0 || i === ITERATIONS) {
          heapSamples.push({
            iteration: i,
            heapUsed: forcedHeapUsed(),
            handles: handleSnapshot(),
            timers: timerCounts(),
            subscribers: zustandProbe.live(),
            listeners: listenerLive.count,
          });
        }
      }

      // ── Heap slope (post-warmup samples, % of first post-warmup sample per 100 iterations)
      const steady = heapSamples.filter(s => s.iteration >= WARMUP);
      const base = steady[0]?.heapUsed ?? heapSamples[0]!.heapUsed;
      const slopeBytesPerIter = linearSlope(
        steady.map(s => ({ x: s.iteration, y: s.heapUsed })),
      );
      const slopePctPer100 = (slopeBytesPerIter * 100 * 100) / base;
      let increases = 0;
      for (let k = 1; k < steady.length; k += 1) {
        if (steady[k]!.heapUsed > steady[k - 1]!.heapUsed) increases += 1;
      }
      const monotone = steady.length > 2 && increases === steady.length - 1;

      // ── Render/iteration time drift: median of the last window vs the first
      const window = Math.max(1, Math.min(100, Math.floor(rows.length / 2)));
      const firstMount = median(rows.slice(0, window).map(r => r.mountMs));
      const lastMount = median(rows.slice(-window).map(r => r.mountMs));
      const firstTotal = median(rows.slice(0, window).map(r => r.totalMs));
      const lastTotal = median(rows.slice(-window).map(r => r.totalMs));
      const mountDrift = firstMount > 0 ? lastMount / firstMount : 1;

      const last = heapSamples[heapSamples.length - 1]!;
      const summary = {
        unit: 'scr-notificationsettingsscreen',
        lens: 'long-run-leak',
        campaignSeed: CAMPAIGN_SEED,
        replay: REPLAY,
        iterationsRequested: ITERATIONS,
        iterationsExecuted: rows.length,
        held: rows.filter(r => r.outcome === 'HELD').length,
        broken: rows.filter(r => r.outcome === 'BROKEN').length,
        gcExposed,
        baseline: {
          timers: baselineTimers,
          subscribers: baselineSubscribers,
          listeners: baselineListeners,
          heapUsed: heapSamples[0]!.heapUsed,
        },
        final: {
          timers: last.timers,
          subscribers: last.subscribers,
          listeners: last.listeners,
          heapUsed: last.heapUsed,
          handles: last.handles,
        },
        heap: {
          sampleEvery: SAMPLE_EVERY,
          warmupIterations: WARMUP,
          steadySamples: steady.length,
          slopeBytesPerIteration: Math.round(slopeBytesPerIter),
          slopePctPer100Iterations: Number(slopePctPer100.toFixed(3)),
          monotoneIncrease: monotone,
          limitPctPer100: SLOPE_LIMIT_PCT_PER_100,
        },
        timing: {
          window,
          mountMsMedianFirst: Number(firstMount.toFixed(2)),
          mountMsMedianLast: Number(lastMount.toFixed(2)),
          totalMsMedianFirst: Number(firstTotal.toFixed(2)),
          totalMsMedianLast: Number(lastTotal.toFixed(2)),
          mountDriftRatio: Number(mountDrift.toFixed(3)),
          limitRatio: RENDER_DRIFT_LIMIT,
        },
        failures,
      };

      if (OUT_PATH) writeJson(OUT_PATH, { summary, heapSamples, rows });
      console.info(JSON.stringify({ summary, heapSamples }, null, 2));

      expect(failures).toEqual([]);
      expect(rows).toHaveLength(ITERATIONS);
      if (CAMPAIGN && !gcExposed) {
        throw new Error(
          'run the campaign under --expose-gc (node --expose-gc node_modules/.bin/jest …) so the heap slope is measurable',
        );
      }
      if (gcExposed && steady.length >= 3) {
        expect(monotone && slopePctPer100 > SLOPE_LIMIT_PCT_PER_100).toBe(
          false,
        );
      }
      expect(mountDrift).toBeLessThan(RENDER_DRIFT_LIMIT);
    },
    10 * 60 * 1000,
  );
});
