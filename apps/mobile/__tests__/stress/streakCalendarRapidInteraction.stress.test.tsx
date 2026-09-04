/**
 * STRESS — StreakCalendarScreen × rapid / concurrent interaction.
 *
 * The real screen is mounted inside a real `NavigationContainer` +
 * `createNativeStackNavigator` (the same navigator family RootNavigator
 * registers it on, with the same `headerShown: false` route options), on
 * top of the real zustand consistency store and the real consistency
 * engine. Only the native boundary is doubled: SQLite (`getDb` +
 * repository reads), safe-area (the library's own jest mock) and the
 * gradient view. Every tap goes through the host view's Pressability
 * responder handlers (grant → release), so `disabled`, press-in/out and
 * long-press timing behave exactly as the gesture layer does on device.
 *
 * A seeded generator (mulberry32) derives, per seed, a training history
 * (which fixes the month-navigation bounds), a storage profile (instant,
 * delayed, manually-released, or failing reads) and a script of interaction
 * bursts: double/triple taps, same-batch taps (one JS task, stale props),
 * long holds, Prev+Next in one batch, Back while a refresh is in flight,
 * navigation spam, retry spam. A model tracks the intended state and every
 * burst asserts:
 *   - one side effect per intent (one route push per open, one pop per
 *     Back, one store refresh per focus, month/day/achievement toggles land
 *     exactly once per accepted tap);
 *   - no orphan loading state once storage settles (either the snapshot
 *     copy or exactly one error card is on screen);
 *   - no duplicate detail panel / duplicate screen;
 *   - no console.error / console.warn (act() warnings included) and no
 *     unhandled promise rejections.
 *
 * Replay:  STRESS_SEED=<n> npx jest --ci __tests__/stress/streakCalendarRapidInteraction
 * Scale:   STRESS_ITER=<count> [STRESS_BASE=<first seed>] npx jest --ci ...
 * Output:  artifacts/stress/streak-calendar-rapid-interaction-{results,summary}.json
 *          (override the directory with STRESS_OUT).
 */
import React from 'react';
import { Pressable, Text, View } from 'react-native';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { NavigationContainer, useNavigation } from '@react-navigation/native';
import {
  createNativeStackNavigator,
  type NativeStackNavigationProp,
} from '@react-navigation/native-stack';
import type { ActivityShotRow } from '../../src/data/repository';
import type { RootStackParams } from '../../src/navigation/params';
import {
  buildConsistencySnapshot,
  type ConsistencySnapshot,
  type TrainingActivityInput,
} from '../../src/consistency/engine';

jest.mock(
  'react-native-safe-area-context',
  () =>
    jest.requireActual<{ default: unknown }>(
      'react-native-safe-area-context/jest/mock',
    ).default,
);

jest.mock('react-native-linear-gradient', () => {
  const ReactModule = require('react');
  const { View: RNView } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    ReactModule.createElement(RNView, null, props.children);
  return { __esModule: true, default: MockGradient };
});

// ---- Storage boundary (SQLite is native; everything above it is real) ------

type ReadMode = 'instant' | 'timer' | 'manual';

interface Deferred {
  resolve: () => void;
  reject: (error: unknown) => void;
}

const mockStorage = {
  rows: [] as ActivityShotRow[],
  kv: new Map<string, string>(),
  openFails: false,
  readFails: false,
  mode: 'instant' as ReadMode,
  latencyMs: 0,
  /** `getDb` calls (the store also opens for ledger persistence). */
  opens: 0,
  /** `getDb` calls refused — a refresh run that ended in loadError. */
  openFailures: 0,
  /** `listActivityShots` calls — a refresh run that reached storage. */
  reads: 0,
  inFlight: 0,
  manual: [] as Deferred[],
};

function mockAwaitRead(): Promise<void> {
  if (mockStorage.mode === 'instant') return Promise.resolve();
  if (mockStorage.mode === 'timer') {
    return new Promise<void>(resolve =>
      setTimeout(resolve, mockStorage.latencyMs),
    );
  }
  return new Promise<void>((resolve, reject) => {
    mockStorage.manual.push({ resolve, reject });
  });
}

jest.mock('../../src/data/db', () => ({
  getDb: () => {
    mockStorage.opens += 1;
    if (mockStorage.openFails) {
      mockStorage.openFailures += 1;
      throw new Error('sqlite unavailable (stress)');
    }
    return { tag: 'stress-db' };
  },
}));

jest.mock('../../src/data/repository', () => ({
  listActivityShots: async () => {
    mockStorage.reads += 1;
    mockStorage.inFlight += 1;
    try {
      await mockAwaitRead();
      if (mockStorage.readFails) throw new Error('read failed (stress)');
      return mockStorage.rows;
    } finally {
      mockStorage.inFlight -= 1;
    }
  },
  getKv: async (_db: unknown, key: string) => mockStorage.kv.get(key) ?? null,
  setKv: async (_db: unknown, key: string, value: string) => {
    mockStorage.kv.set(key, value);
  },
}));

import {
  GUEST_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { useConsistencyStore } from '../../src/consistency/store';
import { StreakCalendarScreen } from '../../src/screens/StreakCalendarScreen';

// ---- Campaign controls -------------------------------------------------------

const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

const ONLY_SEED =
  process.env.STRESS_SEED !== undefined
    ? Number(process.env.STRESS_SEED)
    : null;
const ITERATIONS = Number(process.env.STRESS_ITER ?? 24);
const BASE_SEED = Number(process.env.STRESS_BASE ?? 1);
const OUT_DIR =
  process.env.STRESS_OUT ?? join(__dirname, '..', '..', 'artifacts', 'stress');
const NOW_ISO = '2026-03-10T18:00:00.000Z';

if (!Number.isInteger(ITERATIONS) || ITERATIONS < 1) {
  throw new Error(`STRESS_ITER must be a positive integer, got ${ITERATIONS}`);
}
if (ONLY_SEED !== null && !Number.isInteger(ONLY_SEED)) {
  throw new Error(
    `STRESS_SEED must be an integer, got ${process.env.STRESS_SEED}`,
  );
}

const SEEDS: number[] =
  ONLY_SEED !== null
    ? [ONLY_SEED]
    : Array.from({ length: ITERATIONS }, (_, i) => BASE_SEED + i);

// ---- Seeded RNG ----------------------------------------------------------------

class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    // mulberry32
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
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

// ---- Calendar helpers (mirror the screen's public contract) ----------------

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

interface Month {
  year: number;
  month: number;
}

function monthOf(day: string): Month {
  return { year: Number(day.slice(0, 4)), month: Number(day.slice(5, 7)) - 1 };
}

function addMonths(m: Month, delta: number): Month {
  const total = m.year * 12 + m.month + delta;
  return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 };
}

function monthIndex(m: Month): number {
  return m.year * 12 + m.month;
}

function monthLabel(m: Month): string {
  return `${MONTH_NAMES[m.month]} ${m.year}`;
}

function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** Local noon N days before `now`, as an ISO instant. */
function daysAgoIso(now: Date, daysAgo: number): string {
  const local = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - daysAgo,
    12,
    0,
    0,
    0,
  );
  return local.toISOString();
}

// ---- Fixture -------------------------------------------------------------------

interface Fixture {
  rows: ActivityShotRow[];
  storage: { mode: ReadMode; latencyMs: number; openFails: boolean };
  preHydrated: boolean;
  oracle: ConsistencySnapshot;
  emptyOracle: ConsistencySnapshot;
}

const SHOT_TYPES = ['dink', 'serve', 'forehand_drive', 'backhand_drive'];

function buildFixture(rng: Rng, now: Date): Fixture {
  const spanDays = rng.pick([3, 10, 25, 45, 80]);
  const density = rng.pick([0.35, 0.6, 0.9, 1]);
  const trainedToday = rng.chance(0.65);
  const rows: ActivityShotRow[] = [];
  let id = 0;
  for (let ago = spanDays; ago >= 0; ago--) {
    const trained = ago === 0 ? trainedToday : rng.chance(density);
    if (!trained) continue;
    const count = rng.int(1, 3);
    for (let n = 0; n < count; n++) {
      rows.push({
        id: `shot-${id++}`,
        sessionId: rng.chance(0.3) ? `session-${id}` : null,
        shotType: rng.pick(SHOT_TYPES),
        capturedAt: daysAgoIso(now, ago),
        overallScore: rng.chance(0.85)
          ? Math.round(rng.next() * 50) / 10 + 4
          : null,
        resultKind: 'scored',
      });
    }
  }
  if (rows.length === 0) {
    rows.push({
      id: 'shot-only',
      sessionId: null,
      shotType: 'dink',
      capturedAt: daysAgoIso(now, 1),
      overallScore: 6.5,
      resultKind: 'scored',
    });
  }
  const activities: TrainingActivityInput[] = rows.map(shot => ({
    kind: shot.sessionId ? 'session_stroke' : 'stroke',
    atIso: shot.capturedAt,
    shotType: shot.shotType,
    overallScore: shot.overallScore,
    resultKind: shot.resultKind,
  }));
  const options = { asOfIso: now.toISOString(), timeZone: deviceTimeZone() };
  const mode = rng.pick<ReadMode>(['instant', 'timer', 'timer', 'manual']);
  return {
    rows,
    storage: {
      mode,
      latencyMs: mode === 'timer' ? rng.pick([1, 40, 250, 900]) : 0,
      openFails: rng.chance(0.18),
    },
    preHydrated: !rng.chance(0.18) && rng.chance(0.5),
    oracle: buildConsistencySnapshot(activities, options),
    emptyOracle: buildConsistencySnapshot([], options),
  };
}

// ---- Model of the intended UI state -------------------------------------------

interface Model {
  route: 'origin' | 'calendar';
  snapshotVisible: boolean;
  loadError: boolean;
  autoSelected: boolean;
  visible: Month;
  selectedDay: string | null;
  selectedAchievement: string | null;
  expectedRefreshRuns: number;
  expectedPushes: number;
  expectedPops: number;
}

function statusLineFor(snapshot: ConsistencySnapshot | null): string {
  if (!snapshot || snapshot.totalActivities === 0) {
    return 'Your first analysis lights the flame.';
  }
  if (snapshot.atRisk) {
    return 'No training yet today — one analysis keeps the flame alive.';
  }
  if (snapshot.trainedToday) {
    return `Day ${snapshot.currentStreak} secured. You trained ${snapshot.trainedLast7} of the last 7 days.`;
  }
  return `You trained ${snapshot.trainedLast7} of the last 7 days.`;
}

function earliestMonthOf(
  snapshot: ConsistencySnapshot,
  asOfDay: string,
): Month {
  const keys = Object.keys(snapshot.days);
  const earliest =
    keys.length > 0 ? keys.reduce((a, b) => (a < b ? a : b)) : asOfDay;
  return monthOf(earliest);
}

// ---- Tree queries ---------------------------------------------------------------

function isHost(node: ReactTestInstance): boolean {
  return typeof node.type === 'string';
}

function hostsByLabel(
  renderer: ReactTestRenderer,
  match: (label: string) => boolean,
): ReactTestInstance[] {
  return renderer.root.findAll(
    n =>
      isHost(n) &&
      typeof n.props.accessibilityLabel === 'string' &&
      match(n.props.accessibilityLabel) &&
      typeof n.props.onResponderRelease === 'function',
  );
}

function hostByLabel(
  renderer: ReactTestRenderer,
  label: string,
): ReactTestInstance | null {
  const found = hostsByLabel(renderer, l => l === label);
  if (found.length > 1) {
    throw new Error(`Duplicate pressable "${label}" (${found.length})`);
  }
  return found[0] ?? null;
}

function hostsByTestId(
  renderer: ReactTestRenderer,
  testID: string,
): ReactTestInstance[] {
  return renderer.root.findAll(n => isHost(n) && n.props.testID === testID);
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

/** Drive a press through Pressability's responder state machine, the way
 * the RN responder system does on device. Returns false when the control
 * refuses the responder grant (disabled). */
function beginTouch(host: ReactTestInstance): { release: () => void } | null {
  if (host.props.onStartShouldSetResponder?.() === false) return null;
  const target = { measure: () => {} };
  const event = {
    persist() {},
    currentTarget: target,
    target,
    nativeEvent: {
      pageX: 12,
      pageY: 12,
      locationX: 4,
      locationY: 4,
      timestamp: Date.now(),
      identifier: 1,
      touches: [],
      changedTouches: [],
    },
  };
  host.props.onResponderGrant(event);
  return {
    release: () => {
      host.props.onResponderRelease(event);
    },
  };
}

function tap(host: ReactTestInstance): boolean {
  const touch = beginTouch(host);
  if (!touch) return false;
  touch.release();
  return true;
}

// ---- Navigator under test ------------------------------------------------------

const Stack = createNativeStackNavigator<RootStackParams>();

function OriginScreen() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParams>>();
  return (
    <View>
      <Text>Progress</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open streak calendar"
        onPress={() => navigation.navigate('StreakCalendar')}
      >
        <Text>Open streak calendar</Text>
      </Pressable>
    </View>
  );
}

interface NavProbe {
  unhandled: number;
  /** Raw onStateChange callbacks (identity churn included). */
  stateChanges: number;
  /** Route-list transitions — what the user can observe. */
  transitions: number;
  routeNames: string[];
}

function Harness(props: { probe: NavProbe }) {
  return (
    <NavigationContainer
      onUnhandledAction={() => {
        props.probe.unhandled += 1;
      }}
      onStateChange={state => {
        props.probe.stateChanges += 1;
        const names = state ? state.routes.map(r => r.name) : [];
        if (names.join('>') !== props.probe.routeNames.join('>')) {
          props.probe.transitions += 1;
        }
        props.probe.routeNames = names;
      }}
    >
      <Stack.Navigator
        screenOptions={{
          headerShown: false,
          animation: 'fade_from_bottom',
        }}
      >
        <Stack.Screen name="Tabs" component={OriginScreen} />
        <Stack.Screen
          name="StreakCalendar"
          component={StreakCalendarScreen}
          options={{ title: 'Consistency' }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

// ---- Script generation ---------------------------------------------------------

type Batch = 'separate' | 'same';

type Step =
  | { kind: 'open'; taps: number; batch: Batch }
  | { kind: 'settle' }
  | { kind: 'advance'; ms: number }
  | { kind: 'month'; dir: -1 | 1; taps: number; batch: Batch }
  | { kind: 'monthSimul'; first: -1 | 1 }
  | { kind: 'day'; slot: number; taps: number; batch: Batch }
  | { kind: 'dayDisabled'; slot: number }
  | { kind: 'achievement'; slot: number; taps: number; batch: Batch }
  | {
      kind: 'hold';
      target: 'back' | 'prev' | 'next' | 'day';
      slot: number;
      ms: number;
    }
  | { kind: 'back'; taps: number; batch: Batch }
  | { kind: 'retry'; taps: number; batch: Batch }
  | { kind: 'releaseRead' };

function generateScript(rng: Rng, fixture: Fixture): Step[] {
  const steps: Step[] = [];
  const openBatch: Batch = rng.chance(0.4) ? 'same' : 'separate';
  steps.push({ kind: 'open', taps: rng.int(1, 3), batch: openBatch });
  if (rng.chance(0.6)) steps.push({ kind: 'settle' });
  const bursts = rng.int(4, 12);
  for (let i = 0; i < bursts; i++) {
    const roll = rng.next();
    const batch: Batch = rng.chance(0.35) ? 'same' : 'separate';
    if (roll < 0.2) {
      steps.push({
        kind: 'month',
        dir: rng.chance(0.5) ? -1 : 1,
        taps: rng.int(1, 4),
        batch,
      });
    } else if (roll < 0.26) {
      steps.push({ kind: 'monthSimul', first: rng.chance(0.5) ? -1 : 1 });
    } else if (roll < 0.46) {
      steps.push({
        kind: 'day',
        slot: rng.int(0, 40),
        taps: rng.int(1, 3),
        batch,
      });
    } else if (roll < 0.52) {
      steps.push({ kind: 'dayDisabled', slot: rng.int(0, 40) });
    } else if (roll < 0.64) {
      steps.push({
        kind: 'achievement',
        slot: rng.int(0, 12),
        taps: rng.int(1, 3),
        batch,
      });
    } else if (roll < 0.7) {
      steps.push({
        kind: 'hold',
        target: rng.pick(['back', 'prev', 'next', 'day'] as const),
        slot: rng.int(0, 40),
        ms: rng.pick([120, 520, 1200]),
      });
    } else if (roll < 0.78) {
      steps.push({ kind: 'settle' });
    } else if (roll < 0.84) {
      steps.push({ kind: 'advance', ms: rng.pick([0, 16, 100, 600]) });
    } else if (roll < 0.9) {
      steps.push({ kind: 'releaseRead' });
    } else if (roll < 0.95 && fixture.storage.openFails) {
      steps.push({ kind: 'retry', taps: rng.int(1, 3), batch });
    } else {
      steps.push({ kind: 'back', taps: rng.int(1, 3), batch });
      if (rng.chance(0.7)) {
        steps.push({ kind: 'open', taps: rng.int(1, 2), batch: 'separate' });
      }
    }
  }
  if (rng.chance(0.5))
    steps.push({ kind: 'back', taps: rng.int(1, 2), batch: 'separate' });
  steps.push({ kind: 'releaseRead' });
  steps.push({ kind: 'settle' });
  return steps;
}

// ---- Result table --------------------------------------------------------------

interface IterationResult {
  seed: number;
  ok: boolean;
  bursts: number;
  taps: number;
  failures: string[];
  observations: Record<string, number>;
  fixture: {
    trainedDays: number;
    trainedToday: boolean;
    monthsOfHistory: number;
    storage: Fixture['storage'];
    preHydrated: boolean;
  };
  reads: number;
  refreshRuns: number;
  dbOpens: number;
  navStateChanges: number;
  unhandledActions: number;
  consoleErrors: string[];
  script: string[];
  durationMs: number;
}

const results: IterationResult[] = [];
const wallStart = Date.now();

// ---- Console / rejection capture -------------------------------------------------

let consoleLog: string[] = [];
let unhandledRejections: string[] = [];
const originalError = console.error;
const originalWarn = console.warn;
const onRejection = (reason: unknown) => {
  unhandledRejections.push(String(reason));
};

beforeAll(() => {
  console.error = (...args: unknown[]) => {
    consoleLog.push(`error: ${args.map(String).join(' ')}`);
  };
  console.warn = (...args: unknown[]) => {
    consoleLog.push(`warn: ${args.map(String).join(' ')}`);
  };
  process.on('unhandledRejection', onRejection);
});

afterAll(() => {
  console.error = originalError;
  console.warn = originalWarn;
  process.off('unhandledRejection', onRejection);

  const failed = results.filter(r => !r.ok);
  const byInvariant: Record<string, number> = {};
  const observations: Record<string, number> = {};
  for (const r of results) {
    for (const f of r.failures) {
      const key = f.split(':')[0] ?? f;
      byInvariant[key] = (byInvariant[key] ?? 0) + 1;
    }
    for (const [key, n] of Object.entries(r.observations)) {
      observations[key] = (observations[key] ?? 0) + n;
    }
  }
  const summary = {
    unit: 'scr-streakcalendarscreen',
    lens: 'rapid-interaction',
    generatedAt: new Date().toISOString(),
    nowIso: NOW_ISO,
    timeZone: deviceTimeZone(),
    seeds: { only: ONLY_SEED, base: BASE_SEED, count: SEEDS.length },
    iterationsExecuted: results.length,
    burstsExecuted: results.reduce((n, r) => n + r.bursts, 0),
    tapsExecuted: results.reduce((n, r) => n + r.taps, 0),
    passed: results.length - failed.length,
    failed: failed.length,
    failedSeeds: failed.map(r => r.seed),
    byInvariant,
    observations,
    aggregate: {
      reads: results.reduce((n, r) => n + r.reads, 0),
      navStateChanges: results.reduce((n, r) => n + r.navStateChanges, 0),
      unhandledActions: results.reduce((n, r) => n + r.unhandledActions, 0),
    },
    wallMs: Date.now() - wallStart,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const suffix = ONLY_SEED !== null ? `-seed${ONLY_SEED}` : '';
  writeFileSync(
    join(OUT_DIR, `streak-calendar-rapid-interaction-summary${suffix}.json`),
    JSON.stringify(summary, null, 2),
  );
  writeFileSync(
    join(OUT_DIR, `streak-calendar-rapid-interaction-results${suffix}.json`),
    JSON.stringify(results, null, 2),
  );
});

// ---- One iteration ----------------------------------------------------------------

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
  });
  await flush();
}

/** Run timers and microtasks until storage has nothing in flight (manual
 * reads excluded — those stay pending on purpose until `releaseRead`). */
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await advance(50);
    if (mockStorage.inFlight - mockStorage.manual.length === 0 && i >= 2) break;
  }
  await advance(1000);
}

/** Store refresh runs observed at the storage boundary. */
function refreshRuns(): number {
  return mockStorage.reads + mockStorage.openFailures;
}

/** Release every manually-held read (serialized refreshes start the next
 * read only after the previous one lands, so drain in rounds). */
async function drainManualReads(): Promise<void> {
  for (let round = 0; round < 12; round++) {
    const pending = mockStorage.manual.splice(0);
    await act(async () => {
      for (const d of pending) d.resolve();
      await Promise.resolve();
    });
    await settle();
    if (mockStorage.manual.length === 0 && mockStorage.inFlight === 0) return;
  }
}

function resetStore(fixture: Fixture) {
  useConsistencyStore.setState({
    hydrated: fixture.preHydrated,
    ownerKey: fixture.preHydrated ? GUEST_DATA_OWNER : null,
    snapshot: fixture.preHydrated ? fixture.oracle : null,
    loadError: false,
    celebration: null,
    daySecured: null,
  });
}

async function runIteration(seed: number): Promise<IterationResult> {
  const startedAt = Date.now();
  const rng = new Rng(seed);
  const now = new Date(NOW_ISO);
  const fixture = buildFixture(rng, now);
  const script = generateScript(rng, fixture);
  const failures: string[] = [];
  const observations: Record<string, number> = {};
  const observe = (key: string, n = 1) => {
    observations[key] = (observations[key] ?? 0) + n;
  };
  const fail = (invariant: string, detail: string) => {
    failures.push(`${invariant}: ${detail}`);
  };

  mockStorage.rows = fixture.rows;
  mockStorage.kv = new Map();
  mockStorage.openFails = fixture.storage.openFails;
  mockStorage.readFails = false;
  mockStorage.mode = fixture.storage.mode;
  mockStorage.latencyMs = fixture.storage.latencyMs;
  mockStorage.opens = 0;
  mockStorage.openFailures = 0;
  mockStorage.reads = 0;
  mockStorage.inFlight = 0;
  mockStorage.manual = [];
  consoleLog = [];
  unhandledRejections = [];
  setActiveDataOwner(GUEST_DATA_OWNER);
  resetStore(fixture);

  const asOfDay = fixture.oracle.asOfDay;
  const currentMonth = monthOf(asOfDay);
  const earliestMonth = earliestMonthOf(fixture.oracle, asOfDay);
  const trainedDays = Object.keys(fixture.oracle.days).sort();

  const model: Model = {
    route: 'origin',
    snapshotVisible: fixture.preHydrated,
    loadError: false,
    autoSelected: false,
    visible: currentMonth,
    selectedDay: null,
    selectedAchievement: null,
    expectedRefreshRuns: 0,
    expectedPushes: 0,
    expectedPops: 0,
  };
  let pushesSeen = 0;
  let popsSeen = 0;
  let bursts = 0;
  let taps = 0;

  const probe: NavProbe = {
    unhandled: 0,
    stateChanges: 0,
    transitions: 0,
    routeNames: ['Tabs'],
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Harness probe={probe} />);
  });

  // The store's first snapshot anchors the month and opens today's log.
  const applyFirstSnapshotEffects = () => {
    if (model.autoSelected) return;
    model.autoSelected = true;
    model.visible = monthOf(asOfDay);
    model.selectedDay = fixture.oracle.trainedToday ? asOfDay : null;
  };

  /** The error card replaces the calendar until a retry succeeds. */
  const onErrorScreen = () => model.loadError && !model.snapshotVisible;

  const bounds = () => ({
    earliest: model.snapshotVisible ? earliestMonth : currentMonth,
    current: currentMonth,
  });

  const prevDisabled = () =>
    monthIndex(model.visible) === monthIndex(bounds().earliest);
  const nextDisabled = () =>
    monthIndex(model.visible) === monthIndex(bounds().current);

  const daysInVisibleMonth = () =>
    model.snapshotVisible
      ? trainedDays.filter(d => {
          const m = monthOf(d);
          return (
            m.year === model.visible.year && m.month === model.visible.month
          );
        })
      : [];

  const untrainedDaysInVisibleMonth = () => {
    const days: string[] = [];
    const daysInMonth = new Date(
      model.visible.year,
      model.visible.month + 1,
      0,
    ).getDate();
    for (let d = 1; d <= daysInMonth; d++) {
      const key = `${model.visible.year}-${String(model.visible.month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      if (!fixture.oracle.days[key]) days.push(key);
    }
    return days;
  };

  const achievementHosts = () =>
    hostsByLabel(renderer, l => / (Earned|Locked\.)/.test(l));

  /** Storage reads currently pending that will land a snapshot/error later. */
  const pendingReadsWillLand = () => mockStorage.inFlight > 0;

  /** After storage settles, the calendar route must show the snapshot copy
   * or exactly one error card — never the pre-snapshot placeholder. */
  const checkSettledScreen = (where: string) => {
    if (model.route !== 'calendar') {
      const backs = hostsByLabel(renderer, l => l === 'Back');
      if (backs.length !== 0) {
        fail(
          'screen-count',
          `${where}: calendar still mounted after pop (${backs.length})`,
        );
      }
      return;
    }
    const text = allText(renderer);
    const errorCards = hostsByTestId(renderer, 'streak-load-error');
    const heroCount = hostsByTestId(renderer, 'streak-hero').length;
    if (model.loadError && !model.snapshotVisible) {
      if (errorCards.length !== 1) {
        fail(
          'error-card',
          `${where}: expected 1 error card, saw ${errorCards.length}`,
        );
      }
      if (heroCount !== 0)
        fail('error-card', `${where}: hero rendered beside error`);
      return;
    }
    if (errorCards.length !== 0) {
      fail('error-card', `${where}: error card shown with snapshot state`);
    }
    if (heroCount !== 1) {
      fail('screen-count', `${where}: expected 1 hero, saw ${heroCount}`);
    }
    const expectedStatus = statusLineFor(
      model.snapshotVisible ? fixture.oracle : null,
    );
    if (!text.includes(expectedStatus)) {
      fail(
        model.snapshotVisible ? 'orphan-loading' : 'placeholder',
        `${where}: status line "${expectedStatus}" missing; text=${text.slice(0, 240)}`,
      );
    }
    if (!text.includes(monthLabel(model.visible))) {
      fail(
        'month',
        `${where}: expected "${monthLabel(model.visible)}" visible`,
      );
    }
    const inBounds =
      monthIndex(model.visible) >= monthIndex(bounds().earliest) &&
      monthIndex(model.visible) <= monthIndex(bounds().current);
    if (!inBounds) observe('month-overshoot-same-batch');
    const details = hostsByTestId(renderer, 'streak-day-detail');
    if (details.length !== (model.selectedDay ? 1 : 0)) {
      fail(
        'duplicate-detail',
        `${where}: day detail count ${details.length}, selected=${model.selectedDay}`,
      );
    }
    const prev = hostByLabel(renderer, 'Previous month');
    const next = hostByLabel(renderer, 'Next month');
    if (!prev || !next) {
      fail('controls', `${where}: month arrows missing`);
    } else {
      const prevOff = prev.props.onStartShouldSetResponder?.() === false;
      const nextOff = next.props.onStartShouldSetResponder?.() === false;
      if (prevOff !== prevDisabled()) {
        fail(
          'controls',
          `${where}: Previous disabled=${prevOff}, model=${prevDisabled()}`,
        );
      }
      if (nextOff !== nextDisabled()) {
        fail(
          'controls',
          `${where}: Next disabled=${nextOff}, model=${nextDisabled()}`,
        );
      }
    }
    const detailRegions = renderer.root.findAll(
      n => isHost(n) && n.props.accessibilityLiveRegion === 'polite',
    );
    if (detailRegions.length !== (model.selectedAchievement ? 1 : 0)) {
      fail(
        'duplicate-detail',
        `${where}: achievement detail count ${detailRegions.length}, selected=${model.selectedAchievement}`,
      );
    }
  };

  const noteNavigation = () => {
    const onCalendar =
      probe.routeNames[probe.routeNames.length - 1] === 'StreakCalendar';
    const calendarRoutes = probe.routeNames.filter(
      n => n === 'StreakCalendar',
    ).length;
    if (calendarRoutes > 1)
      fail('duplicate-screen', `routes=${probe.routeNames.join('>')}`);
    if ((model.route === 'calendar') !== onCalendar) {
      fail(
        'navigation',
        `model route ${model.route}, navigator ${probe.routeNames.join('>')}`,
      );
    }
  };

  /** A refresh finished with a snapshot (store observed). */
  const syncFromStore = () => {
    const state = useConsistencyStore.getState();
    if (state.snapshot && !model.snapshotVisible) {
      model.snapshotVisible = true;
      model.loadError = false;
      if (model.route === 'calendar') applyFirstSnapshotEffects();
    }
    if (state.loadError && !state.snapshot) model.loadError = true;
    if (state.snapshot && model.route === 'calendar' && !model.autoSelected) {
      applyFirstSnapshotEffects();
    }
  };

  const runTaps = async (
    count: number,
    batch: Batch,
    locate: () => ReactTestInstance | null,
    onAccepted: () => void,
    onAbsent: () => void,
  ) => {
    bursts += 1;
    if (batch === 'same') {
      // One JS task: every tap sees the props of the last commit.
      await act(async () => {
        for (let i = 0; i < count; i++) {
          const host = locate();
          if (!host) {
            onAbsent();
            continue;
          }
          taps += 1;
          if (tap(host)) onAccepted();
        }
      });
      await flush();
    } else {
      for (let i = 0; i < count; i++) {
        const host = locate();
        if (!host) {
          onAbsent();
          continue;
        }
        taps += 1;
        let accepted = false;
        await act(async () => {
          accepted = tap(host);
        });
        if (accepted) onAccepted();
        await flush();
      }
    }
    syncFromStore();
  };

  try {
    for (const [index, step] of script.entries()) {
      const where = `step ${index} ${JSON.stringify(step)}`;
      switch (step.kind) {
        case 'open': {
          if (model.route !== 'origin') {
            observe('open-skipped-already-on-calendar');
            break;
          }
          const before = probe.transitions;
          const rawBefore = probe.stateChanges;
          let accepted = 0;
          await runTaps(
            step.taps,
            step.batch,
            () => hostByLabel(renderer, 'Open streak calendar'),
            () => {
              accepted += 1;
            },
            () => observe('open-target-absent'),
          );
          if (accepted > 0) {
            observe('open-taps-accepted', accepted);
            model.route = 'calendar';
            model.expectedPushes += 1;
            model.expectedRefreshRuns += 1; // one focus → one refresh
            pushesSeen += probe.transitions - before;
            if (probe.transitions - before !== 1) {
              fail(
                'navigation',
                `${where}: ${probe.transitions - before} route transitions for one open intent`,
              );
            }
            if (probe.stateChanges - rawBefore > 1) {
              observe(
                'open-state-identity-churn',
                probe.stateChanges - rawBefore - 1,
              );
            }
            if (model.snapshotVisible) applyFirstSnapshotEffects();
            syncFromStore();
          }
          noteNavigation();
          break;
        }
        case 'settle': {
          bursts += 1;
          await settle();
          syncFromStore();
          if (!pendingReadsWillLand()) checkSettledScreen(where);
          break;
        }
        case 'advance': {
          bursts += 1;
          await advance(step.ms);
          syncFromStore();
          break;
        }
        case 'releaseRead': {
          bursts += 1;
          const pending = mockStorage.manual.splice(0);
          await act(async () => {
            for (const d of pending) d.resolve();
            await Promise.resolve();
          });
          await flush();
          await flush();
          syncFromStore();
          if (pending.length > 0)
            observe('manual-reads-released', pending.length);
          break;
        }
        case 'month': {
          if (model.route !== 'calendar' || onErrorScreen()) {
            observe('month-skipped-off-screen');
            break;
          }
          const label = step.dir === -1 ? 'Previous month' : 'Next month';
          const disabledAtStart =
            step.dir === -1 ? prevDisabled() : nextDisabled();
          let accepted = 0;
          const visibleBefore = model.visible;
          await runTaps(
            step.taps,
            step.batch,
            () => hostByLabel(renderer, label),
            () => {
              accepted += 1;
            },
            () => fail('controls', `${where}: "${label}" missing`),
          );
          observe('month-taps-accepted', accepted);
          if (step.batch === 'same') {
            // Stale props: every tap in the batch is accepted or refused as one.
            const expectedAccepted = disabledAtStart ? 0 : step.taps;
            if (accepted !== expectedAccepted) {
              fail(
                'same-batch-accept',
                `${where}: accepted ${accepted}, expected ${expectedAccepted}`,
              );
            }
            model.visible = addMonths(visibleBefore, step.dir * accepted);
          } else {
            let expectedAccepted = 0;
            let cursor = visibleBefore;
            for (let i = 0; i < step.taps; i++) {
              const off =
                step.dir === -1
                  ? monthIndex(cursor) === monthIndex(bounds().earliest)
                  : monthIndex(cursor) === monthIndex(bounds().current);
              if (off) break;
              cursor = addMonths(cursor, step.dir);
              expectedAccepted += 1;
            }
            if (accepted !== expectedAccepted) {
              fail(
                'month',
                `${where}: accepted ${accepted}, expected ${expectedAccepted}`,
              );
            }
            model.visible = cursor;
          }
          const text = allText(renderer);
          if (!text.includes(monthLabel(model.visible))) {
            fail('month', `${where}: expected "${monthLabel(model.visible)}"`);
          }
          break;
        }
        case 'monthSimul': {
          if (model.route !== 'calendar' || onErrorScreen()) {
            observe('month-skipped-off-screen');
            break;
          }
          bursts += 1;
          const before = model.visible;
          const prevOff = prevDisabled();
          const nextOff = nextDisabled();
          const order =
            step.first === -1
              ? ['Previous month', 'Next month']
              : ['Next month', 'Previous month'];
          let delta = 0;
          await act(async () => {
            for (const label of order) {
              const host = hostByLabel(renderer, label);
              if (!host) {
                fail('controls', `${where}: "${label}" missing`);
                continue;
              }
              taps += 1;
              if (tap(host)) delta += label === 'Previous month' ? -1 : 1;
            }
          });
          await flush();
          const expectedDelta = (prevOff ? 0 : -1) + (nextOff ? 0 : 1);
          if (delta !== expectedDelta) {
            fail(
              'same-batch-accept',
              `${where}: delta ${delta}, expected ${expectedDelta}`,
            );
          }
          model.visible = addMonths(before, delta);
          if (!allText(renderer).includes(monthLabel(model.visible))) {
            fail('month', `${where}: expected "${monthLabel(model.visible)}"`);
          }
          break;
        }
        case 'day': {
          if (model.route !== 'calendar' || onErrorScreen()) {
            observe('day-skipped-off-screen');
            break;
          }
          const days = daysInVisibleMonth();
          if (days.length === 0) {
            observe('day-none-tappable');
            break;
          }
          const day = days[step.slot % days.length] as string;
          const selectedBefore = model.selectedDay;
          let accepted = 0;
          await runTaps(
            step.taps,
            step.batch,
            () => {
              const hosts = hostsByLabel(renderer, l =>
                l.startsWith(`${day},`),
              );
              if (hosts.length > 1)
                fail(
                  'duplicate-control',
                  `${where}: ${hosts.length} cells for ${day}`,
                );
              return hosts[0] ?? null;
            },
            () => {
              accepted += 1;
            },
            () => fail('controls', `${where}: day cell ${day} missing`),
          );
          observe('day-taps-accepted', accepted);
          if (accepted !== step.taps) {
            fail(
              'day',
              `${where}: accepted ${accepted} of ${step.taps} taps on trained day`,
            );
          }
          // Toggle semantics: odd count selects/deselects, even count nets out.
          let selected = selectedBefore;
          for (let i = 0; i < accepted; i++)
            selected = selected === day ? null : day;
          model.selectedDay = selected;
          const details = hostsByTestId(renderer, 'streak-day-detail');
          if (details.length !== (model.selectedDay ? 1 : 0)) {
            fail(
              'duplicate-detail',
              `${where}: detail count ${details.length}, selected=${model.selectedDay}`,
            );
          }
          break;
        }
        case 'dayDisabled': {
          if (model.route !== 'calendar' || onErrorScreen()) {
            observe('day-skipped-off-screen');
            break;
          }
          const days = untrainedDaysInVisibleMonth();
          if (days.length === 0) {
            observe('day-all-trained');
            break;
          }
          const day = days[step.slot % days.length] as string;
          const before = model.selectedDay;
          await runTaps(
            1,
            'separate',
            () =>
              hostsByLabel(
                renderer,
                l => l.startsWith(`${day},`) || l === day,
              )[0] ?? null,
            () => fail('day', `${where}: untrained day ${day} accepted a tap`),
            () => fail('controls', `${where}: day cell ${day} missing`),
          );
          const details = hostsByTestId(renderer, 'streak-day-detail');
          if (details.length !== (before ? 1 : 0)) {
            fail(
              'duplicate-detail',
              `${where}: detail count changed on disabled day tap`,
            );
          }
          break;
        }
        case 'achievement': {
          if (model.route !== 'calendar' || !model.snapshotVisible) {
            observe('achievement-skipped');
            break;
          }
          const hosts = achievementHosts();
          if (hosts.length === 0) {
            fail('controls', `${where}: no achievement badges rendered`);
            break;
          }
          const chosen = hosts[step.slot % hosts.length] as ReactTestInstance;
          const label = chosen.props.accessibilityLabel as string;
          const title = label.split('. ')[0] ?? label;
          const before = model.selectedAchievement;
          let accepted = 0;
          await runTaps(
            step.taps,
            step.batch,
            () => hostByLabel(renderer, label),
            () => {
              accepted += 1;
            },
            () => fail('controls', `${where}: badge "${title}" missing`),
          );
          observe('achievement-taps-accepted', accepted);
          if (accepted !== step.taps) {
            fail(
              'achievement',
              `${where}: accepted ${accepted} of ${step.taps}`,
            );
          }
          let selected = before;
          for (let i = 0; i < accepted; i++)
            selected = selected === title ? null : title;
          model.selectedAchievement = selected;
          const regions = renderer.root.findAll(
            n => isHost(n) && n.props.accessibilityLiveRegion === 'polite',
          );
          if (regions.length !== (selected ? 1 : 0)) {
            fail(
              'duplicate-detail',
              `${where}: achievement detail count ${regions.length}, selected=${selected}`,
            );
          }
          break;
        }
        case 'hold': {
          if (
            model.route !== 'calendar' ||
            (onErrorScreen() && step.target !== 'back')
          ) {
            observe('hold-skipped-off-screen');
            break;
          }
          bursts += 1;
          let host: ReactTestInstance | null = null;
          let day: string | null = null;
          if (step.target === 'back') host = hostByLabel(renderer, 'Back');
          else if (step.target === 'prev')
            host = hostByLabel(renderer, 'Previous month');
          else if (step.target === 'next')
            host = hostByLabel(renderer, 'Next month');
          else {
            const days = daysInVisibleMonth();
            if (days.length > 0) {
              day = days[step.slot % days.length] as string;
              host =
                hostsByLabel(renderer, l => l.startsWith(`${day},`))[0] ?? null;
            }
          }
          if (!host) {
            observe('hold-target-absent');
            break;
          }
          const expectAccept =
            step.target === 'back' ||
            step.target === 'day' ||
            (step.target === 'prev' ? !prevDisabled() : !nextDisabled());
          let touch: { release: () => void } | null = null;
          await act(async () => {
            touch = beginTouch(host as ReactTestInstance);
          });
          taps += 1;
          if (!touch !== !expectAccept) {
            fail(
              'controls',
              `${where}: grant=${Boolean(touch)}, expected ${expectAccept}`,
            );
          }
          await advance(step.ms);
          syncFromStore();
          if (touch) {
            observe(`hold-released-${step.target}`);
            const before = probe.transitions;
            await act(async () => {
              (touch as { release: () => void }).release();
            });
            await flush();
            if (step.target === 'back') {
              model.route = 'origin';
              model.expectedPops += 1;
              popsSeen += probe.transitions - before;
              if (probe.transitions - before !== 1) {
                fail(
                  'navigation',
                  `${where}: ${probe.transitions - before} route transitions for one Back`,
                );
              }
              model.selectedDay = null;
              model.selectedAchievement = null;
              model.autoSelected = false;
              model.visible = currentMonth;
            } else if (step.target === 'day' && day) {
              model.selectedDay = model.selectedDay === day ? null : day;
            } else {
              model.visible = addMonths(
                model.visible,
                step.target === 'prev' ? -1 : 1,
              );
            }
            noteNavigation();
          }
          break;
        }
        case 'back': {
          if (model.route !== 'calendar') {
            observe('back-skipped-off-screen');
            break;
          }
          const before = probe.transitions;
          const unhandledBefore = probe.unhandled;
          const readsInFlight = mockStorage.inFlight;
          let accepted = 0;
          await runTaps(
            step.taps,
            step.batch,
            () => hostByLabel(renderer, 'Back'),
            () => {
              accepted += 1;
            },
            () => observe('back-target-gone'),
          );
          if (accepted === 0) {
            fail('navigation', `${where}: Back never accepted`);
            break;
          }
          if (readsInFlight > 0) observe('back-during-refresh');
          observe('back-accepted');
          model.route = 'origin';
          model.expectedPops += 1;
          popsSeen += probe.transitions - before;
          if (probe.transitions - before !== 1) {
            fail(
              'navigation',
              `${where}: ${probe.transitions - before} route transitions for one Back intent`,
            );
          }
          if (step.batch === 'same' && accepted > 1) {
            observe('back-same-batch-extra-goBack', accepted - 1);
            if (probe.unhandled - unhandledBefore !== accepted - 1) {
              fail(
                'navigation',
                `${where}: ${probe.unhandled - unhandledBefore} unhandled for ${accepted - 1} extra goBack`,
              );
            }
          } else if (probe.unhandled !== unhandledBefore) {
            fail(
              'navigation',
              `${where}: unhandled action after separate Back taps`,
            );
          }
          model.selectedDay = null;
          model.selectedAchievement = null;
          model.autoSelected = false;
          model.visible = currentMonth;
          noteNavigation();
          const backs = hostsByLabel(renderer, l => l === 'Back');
          if (backs.length !== 0)
            fail('screen-count', `${where}: calendar still mounted after Back`);
          break;
        }
        case 'retry': {
          if (
            model.route !== 'calendar' ||
            !(model.loadError && !model.snapshotVisible)
          ) {
            observe('retry-skipped');
            break;
          }
          // Storage recovers before the retry so the outcome is observable.
          mockStorage.openFails = false;
          const runsBefore = refreshRuns();
          let accepted = 0;
          await runTaps(
            step.taps,
            step.batch,
            () => hostByLabel(renderer, 'Try again'),
            () => {
              accepted += 1;
            },
            () => observe('retry-target-gone'),
          );
          model.expectedRefreshRuns += accepted;
          observe('retry-taps-accepted', accepted);
          await drainManualReads();
          syncFromStore();
          const ran = refreshRuns() - runsBefore;
          if (ran !== accepted) {
            fail(
              'refresh-count',
              `${where}: ${ran} refresh runs for ${accepted} retry taps`,
            );
          }
          if (!model.snapshotVisible) {
            fail(
              'orphan-loading',
              `${where}: retry did not surface the snapshot`,
            );
          }
          checkSettledScreen(where);
          break;
        }
        default: {
          const never: never = step;
          throw new Error(`unknown step ${JSON.stringify(never)}`);
        }
      }
      if (probe.routeNames.filter(n => n === 'StreakCalendar').length > 1) {
        fail('duplicate-screen', `${where}: ${probe.routeNames.join('>')}`);
      }
    }

    // Final settle: nothing may still be loading and the refresh budget must
    // match the number of focus events + accepted retries.
    await drainManualReads();
    syncFromStore();
    if (!pendingReadsWillLand()) checkSettledScreen('final');
    if (mockStorage.inFlight !== 0) {
      fail(
        'orphan-loading',
        `final: ${mockStorage.inFlight} reads still in flight`,
      );
    }
    if (refreshRuns() !== model.expectedRefreshRuns) {
      fail(
        'refresh-count',
        `final: ${refreshRuns()} refresh runs (${mockStorage.reads} reads + ${mockStorage.openFailures} failed opens), expected ${model.expectedRefreshRuns} (one per focus + one per retry)`,
      );
    }
    if (pushesSeen !== model.expectedPushes) {
      fail(
        'navigation',
        `final: ${pushesSeen} pushes, expected ${model.expectedPushes}`,
      );
    }
    if (popsSeen !== model.expectedPops) {
      fail(
        'navigation',
        `final: ${popsSeen} pops, expected ${model.expectedPops}`,
      );
    }
  } catch (error) {
    fail(
      'exception',
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
  } finally {
    try {
      await act(async () => {
        renderer.unmount();
      });
      await settle();
    } catch (error) {
      fail('unmount', error instanceof Error ? error.message : String(error));
    }
  }

  if (consoleLog.length > 0) {
    fail('console', consoleLog.slice(0, 3).join(' | '));
  }
  if (unhandledRejections.length > 0) {
    fail('unhandled-rejection', unhandledRejections.join(' | '));
  }

  return {
    seed,
    ok: failures.length === 0,
    bursts,
    taps,
    failures,
    observations,
    fixture: {
      trainedDays: trainedDays.length,
      trainedToday: fixture.oracle.trainedToday,
      monthsOfHistory: monthIndex(currentMonth) - monthIndex(earliestMonth) + 1,
      storage: fixture.storage,
      preHydrated: fixture.preHydrated,
    },
    reads: mockStorage.reads,
    refreshRuns: refreshRuns(),
    dbOpens: mockStorage.opens,
    navStateChanges: probe.stateChanges,
    unhandledActions: probe.unhandled,
    consoleErrors: consoleLog.slice(0, 10),
    script: script.map(s => JSON.stringify(s)),
    durationMs: Date.now() - startedAt,
  };
}

describe('StreakCalendarScreen rapid-interaction stress', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date(NOW_ISO));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each(SEEDS)(
    'seed %i holds every rapid-interaction invariant',
    async seed => {
      const result = await runIteration(seed);
      results.push(result);
      expect(result.failures).toEqual([]);
    },
  );
});
