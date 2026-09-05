/**
 * STRESS — StreakCalendarScreen, lens `randomized-seeded`.
 *
 * The screen is mounted the way the app mounts it: inside a real
 * `NavigationContainer` + `createNativeStackNavigator` (react-native-screens
 * host views render in jest), the real zustand consistency store, the real
 * SQLite repository and `getDb()` migrations. Only the native boundary is
 * replaced: `@op-engineering/op-sqlite` is backed by `node:sqlite`
 * (Node >= 22.13, or `NODE_OPTIONS=--experimental-sqlite` on 22.5-22.12),
 * `react-native-safe-area-context` uses the library's own jest mock and
 * `react-native-linear-gradient` is a plain View. Nothing else is mocked.
 *
 * A seeded generator (mulberry32) produces a legal / near-legal action
 * sequence per seed (length 5-60) over the screen's public surface — month
 * arrows, day taps, blur/refocus through the navigator, back + reopen, app
 * relaunch, new training evidence landing in SQLite (with or without a
 * refresh), real `recordDrillCompletion`, midnight rollover, device clock
 * moving backwards, account switch / implicit sign-out, SQLite outage and
 * recovery. Every action is fully described by data, so a sequence can be
 * replayed from its seed or from a minimized action list.
 *
 * Invariants (from the screen's doc comments, the engine contract and the
 * existing flow tests) are model-checked after every step:
 *   I1  exactly one calendar month is rendered; it is never after the
 *       as-of month and never before the earliest logged month;
 *   I2  "Next month" is disabled iff the as-of month is shown;
 *       "Previous month" is disabled iff the earliest month is shown;
 *   I3  the grid is exactly the visible month's days, each labelled
 *       `<day>, trained, N activit(y|ies)` / `<day>, shield protected` /
 *       `<day>, not trained` / bare `<day>` for future days;
 *   I4  trained and shielded days are pressable, every other day is inert;
 *   I5  the day-detail card exists iff a day is selected, names that day
 *       and lists exactly that day's activities (or the shield copy, or
 *       "No training logged this day."); exactly that cell is `selected`;
 *   I6  hero numbers (streak, longest, days trained) equal the store;
 *   I7  the store snapshot equals the SQLite facts: trained days, per-day
 *       activity counts, trainedToday, totals, as-of day = device today,
 *       shielded days never overlap trained days, a live run implies
 *       today or yesterday is logged;
 *   I8  the store never changes without a refresh trigger; a SQLite outage
 *       sets `loadError` and keeps the last snapshot; the error card shows
 *       only when there is no snapshot at all;
 *   I9  no console.error / console.warn during the sequence;
 *   I10 user-facing copy contains no forbidden App Store terms;
 *   I11 determinism: the same seed twice yields an identical trace.
 *
 * Scale: STRESS_ITER sequences (default 40 so the suite stays fast; the
 * campaign runs with STRESS_ITER=2000). STRESS_SEED sets the base seed,
 * STRESS_ONLY=<seed> replays a single seed, STRESS_DETERMINISM=all|sample
 * controls the double-run, STRESS_OUT chooses the artifact directory,
 * STRESS_TAG labels the artifacts, STRESS_VERBOSE=1 prints one line per seed,
 * STRESS_TOLERATE_KNOWN=1 lets a campaign finish when the only failures are
 * the tagged known issues (KI-*, see below) — they are still recorded per seed.
 * Results (seed -> outcome) are written as JSON under
 * `apps/mobile/artifacts/stress/`.
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  NavigationContainer,
  createNavigationContainerRef,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { ConsistencySnapshot } from '../../src/consistency/engine';

declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  version: string;
  memoryUsage(): { heapUsed: number; rss: number };
  stderr: { write(chunk: string): boolean };
};

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
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { join } = require('path') as { join: (...parts: string[]) => string };
// Captured before fake timers replace `Date` — wall-clock for run timings.
const realNow: () => number = Date.now.bind(Date);

/**
 * The RN jest preset installs `performance.now = jest.fn(Date.now)`, and a
 * jest.fn records every call (React's scheduler and Animated call it on
 * every frame). Across thousands of mount/unmount cycles that log is the
 * only unbounded growth in the worker, so it is cleared between sequences.
 */
function clearPerformanceNowLog() {
  const now = (globalThis as { performance?: { now?: unknown } }).performance
    ?.now;
  if (now && typeof now === 'function' && 'mockClear' in now) {
    (now as { mockClear: () => void }).mockClear();
  }
}

// ---------------------------------------------------------------------------
// Native boundary: op-sqlite backed by node:sqlite, with an outage switch.
// ---------------------------------------------------------------------------
const mockSqlite: { db: DatabaseSync | null; down: boolean; executes: number } =
  { db: null, down: false, executes: 0 };

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    const real = mockSqlite.db;
    if (!real) throw new Error('harness did not open a database');
    return {
      executeSync: (sql: string) => ({ rows: real.prepare(sql).all() }),
      execute: async (sql: string, params: unknown[] = []) => {
        mockSqlite.executes += 1;
        if (mockSqlite.down) {
          throw new Error('SQLITE_IOERR: disk I/O error (injected outage)');
        }
        return {
          rows: real
            .prepare(sql)
            .all(...(params as (string | number | null)[])),
        };
      },
      close: () => {},
    };
  },
}));

jest.mock('react-native-safe-area-context', () => {
  const mock = require('react-native-safe-area-context/jest/mock') as {
    default: unknown;
  };
  return mock.default;
});

jest.mock('react-native-linear-gradient', () => {
  const ReactModule = require('react') as typeof import('react');
  const { View } = require('react-native') as typeof import('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    ReactModule.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});

import { StreakCalendarScreen } from '../../src/screens/StreakCalendarScreen';
import { useConsistencyStore } from '../../src/consistency/store';
import { getDb } from '../../src/data/db';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const ITERATIONS = Number(process.env.STRESS_ITER ?? 40);
const BASE_SEED = Number(process.env.STRESS_SEED ?? 20260904);
const ONLY_SEED =
  process.env.STRESS_ONLY !== undefined
    ? Number(process.env.STRESS_ONLY)
    : null;
const DETERMINISM = process.env.STRESS_DETERMINISM ?? 'sample';
const CHUNK = 100;
const OUT_DIR =
  process.env.STRESS_OUT ?? join(__dirname, '..', '..', 'artifacts', 'stress');
const RUN_TAG = process.env.STRESS_TAG ?? `tz-${deviceTimeZone()}`;

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';
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
const FORBIDDEN_COPY =
  /Android|Google Play|guest mode|Live Court|DUPR|SwingVision|PB Vision|Selkirk|JOOLA|\d+\s?%\s*accura|accuracy|world[- ]class|best in class|#1\b/i;
const DAY_MS = 86_400_000;

function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// ---------------------------------------------------------------------------
// Seeded RNG
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(this.next() * items.length)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }
  weighted<T extends string>(table: Record<T, number>): T {
    const entries = Object.entries(table) as [T, number][];
    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    let roll = this.next() * total;
    for (const [key, weight] of entries) {
      roll -= weight;
      if (roll < 0) return key;
    }
    return entries[entries.length - 1]![0];
  }
}

// ---------------------------------------------------------------------------
// Local-day helpers (independent of the engine's Intl implementation)
// ---------------------------------------------------------------------------
function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function monthOf(day: string): { year: number; month: number } {
  return { year: Number(day.slice(0, 4)), month: Number(day.slice(5, 7)) - 1 };
}

function monthIndex(m: { year: number; month: number }): number {
  return m.year * 12 + m.month;
}

function monthFromIndex(index: number): { year: number; month: number } {
  return { year: Math.floor(index / 12), month: ((index % 12) + 12) % 12 };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function dayOrdinal(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00.000Z`) / DAY_MS);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
type Action =
  | { t: 'prevMonth' }
  | { t: 'nextMonth' }
  | { t: 'tapDay'; index: number; preferLogged: boolean }
  | {
      t: 'addShot';
      daysBack: number;
      secondOfDay: number;
      session: boolean;
      scored: boolean;
      score: number;
      shotType: string;
      refresh: boolean;
    }
  | { t: 'recordDrill'; daysBack: number; secondOfDay: number; dup: boolean }
  | { t: 'blurRefocus' }
  | { t: 'backReopen' }
  | { t: 'relaunch'; hydrate: boolean }
  | { t: 'advanceDay'; days: number; refresh: boolean }
  | { t: 'clockBack'; days: number; refresh: boolean }
  | { t: 'switchOwner'; owner: 'A' | 'B' | 'guest' | 'signedOut' }
  | { t: 'dbDown' }
  | { t: 'dbUp'; tryAgain: boolean }
  | { t: 'explicitRefresh' };

const SHOT_TYPES = ['dink', 'third_shot_drop', 'drive', 'serve', 'volley'];

function generateActions(rng: Rng, length: number): Action[] {
  const actions: Action[] = [];
  for (let i = 0; i < length; i += 1) {
    const kind = rng.weighted({
      prevMonth: 12,
      nextMonth: 9,
      tapDay: 22,
      addShot: 16,
      recordDrill: 6,
      blurRefocus: 7,
      backReopen: 4,
      relaunch: 2,
      advanceDay: 6,
      clockBack: 1,
      switchOwner: 3,
      dbDown: 3,
      dbUp: 4,
      explicitRefresh: 5,
    });
    switch (kind) {
      case 'prevMonth':
      case 'nextMonth':
      case 'blurRefocus':
      case 'backReopen':
      case 'dbDown':
      case 'explicitRefresh':
        actions.push({ t: kind });
        break;
      case 'tapDay':
        actions.push({
          t: 'tapDay',
          index: rng.int(0, 10_000),
          preferLogged: rng.chance(0.65),
        });
        break;
      case 'addShot':
        actions.push({
          t: 'addShot',
          daysBack: rng.chance(0.5) ? rng.int(0, 3) : rng.int(0, 160),
          secondOfDay: rng.int(0, 86_399),
          session: rng.chance(0.3),
          scored: rng.chance(0.7),
          score: rng.int(20, 95) / 10,
          shotType: rng.pick(SHOT_TYPES),
          refresh: rng.chance(0.7),
        });
        break;
      case 'recordDrill':
        actions.push({
          t: 'recordDrill',
          daysBack: rng.chance(0.6) ? 0 : rng.int(0, 90),
          secondOfDay: rng.int(0, 86_399),
          dup: rng.chance(0.2),
        });
        break;
      case 'relaunch':
        actions.push({ t: 'relaunch', hydrate: rng.chance(0.6) });
        break;
      case 'advanceDay':
        actions.push({
          t: 'advanceDay',
          days: rng.chance(0.8) ? 1 : rng.int(2, 40),
          refresh: rng.chance(0.6),
        });
        break;
      case 'clockBack':
        actions.push({
          t: 'clockBack',
          days: rng.int(1, 45),
          refresh: rng.chance(0.7),
        });
        break;
      case 'switchOwner':
        actions.push({
          t: 'switchOwner',
          owner: rng.weighted({ A: 4, B: 3, guest: 1, signedOut: 2 }),
        });
        break;
      case 'dbUp':
        actions.push({ t: 'dbUp', tryAgain: rng.chance(0.7) });
        break;
      default:
        throw new Error(`unknown action kind ${String(kind)}`);
    }
  }
  return actions;
}

// ---------------------------------------------------------------------------
// Fact model (what SQLite holds) and the screen model
// ---------------------------------------------------------------------------
interface Fact {
  owner: string;
  kind: 'stroke' | 'session_stroke' | 'drill';
  atMs: number;
  label: string;
}

interface Preload {
  nowMs: number;
  facts: Fact[];
  drillSeeds: { id: string; atMs: number; title: string }[];
  preHydrate: 'none' | 'fresh' | 'staleDay';
  startOwner: string;
}

function randomInstant(rng: Rng): number {
  const year = rng.int(2024, 2027);
  const month = rng.int(0, 11);
  const day = rng.int(1, daysInMonth(year, month));
  const hour = rng.int(0, 23);
  const minute = rng.int(0, 59);
  return Date.UTC(year, month, day, hour, minute, rng.int(0, 59));
}

function generatePreload(rng: Rng): Preload {
  const nowMs = randomInstant(rng);
  const bucket = rng.weighted({ none: 20, few: 40, some: 30, many: 10 });
  const count =
    bucket === 'none'
      ? 0
      : bucket === 'few'
        ? rng.int(1, 10)
        : bucket === 'some'
          ? rng.int(10, 60)
          : rng.int(60, 220);
  const facts: Fact[] = [];
  const horizon = rng.pick([7, 30, 90, 180, 400]);
  for (let i = 0; i < count; i += 1) {
    // Consecutive-day runs are common in real histories: half of the facts
    // land within a short window so streaks and shields actually appear.
    const daysBack = rng.chance(0.5)
      ? rng.int(0, Math.min(14, horizon))
      : rng.int(0, horizon);
    const owner = rng.chance(0.85) ? OWNER_A : OWNER_B;
    const session = rng.chance(0.3);
    const shotType = rng.pick(SHOT_TYPES);
    facts.push({
      owner,
      kind: session ? 'session_stroke' : 'stroke',
      atMs: nowMs - daysBack * DAY_MS - rng.int(0, 86_399) * 1000,
      label: shotType.replace(/_/g, ' '),
    });
  }
  const drillSeeds: Preload['drillSeeds'] = [];
  const drillCount = rng.chance(0.4) ? rng.int(1, 6) : 0;
  for (let i = 0; i < drillCount; i += 1) {
    drillSeeds.push({
      id: `pre-drill-${i}`,
      atMs: nowMs - rng.int(0, 60) * DAY_MS - rng.int(0, 86_399) * 1000,
      title: `Drill ${i + 1}`,
    });
  }
  return {
    nowMs,
    facts,
    drillSeeds,
    preHydrate: rng.weighted({ none: 45, fresh: 40, staleDay: 15 }),
    startOwner: rng.chance(0.05) ? SIGNED_OUT_DATA_OWNER : OWNER_A,
  };
}

interface ScreenModel {
  mounted: boolean;
  errorCardExpected: boolean;
  visible: { year: number; month: number } | null;
  selected: string | null;
  autoPending: boolean;
  /** Local day the screen last computed from `new Date()` — it only
   *  re-renders on its own state changes or on selected store changes. */
  renderedAsOfDay: string;
}

// ---------------------------------------------------------------------------
// Host: real NavigationContainer + native stack, StreakCalendar pushed on top
// ---------------------------------------------------------------------------
type StressStackParams = {
  Home: undefined;
  StreakCalendar: undefined;
  Overlay: undefined;
};
const Stack = createNativeStackNavigator<StressStackParams>();
const navigationRef = createNavigationContainerRef<StressStackParams>();

function HomeStub() {
  return <Text>HOME</Text>;
}
function OverlayStub() {
  return <Text>OVERLAY</Text>;
}

function Host() {
  return (
    <SafeAreaProvider>
      <NavigationContainer ref={navigationRef}>
        <Stack.Navigator
          initialRouteName="Home"
          screenOptions={{ headerShown: false, animation: 'fade_from_bottom' }}
        >
          <Stack.Screen name="Home" component={HomeStub} />
          <Stack.Screen
            name="StreakCalendar"
            component={StreakCalendarScreen}
            options={{ title: 'Consistency' }}
          />
          <Stack.Screen name="Overlay" component={OverlayStub} />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

// ---------------------------------------------------------------------------
// Render-tree readers
// ---------------------------------------------------------------------------
type Renderer = TestRenderer.ReactTestRenderer;
type Instance = TestRenderer.ReactTestInstance;

function textOf(node: Instance): string {
  return node
    .findAllByType(Text)
    .map(n => n.props.children)
    .flat(4)
    .filter((c): c is string | number =>
      ['string', 'number'].includes(typeof c),
    )
    .map(String)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Outermost pressable per accessibility label. `PressableScale` forwards
 * `accessibilityLabel`/`onPress`/`disabled` to RN's `Pressable`, so the
 * composite and the host both match; keep only the composite (one per
 * control) so counts reflect what a user sees.
 */
function labelled(renderer: Renderer, match: (label: string) => boolean) {
  const matches = renderer.root.findAll(
    n =>
      typeof n.props.accessibilityLabel === 'string' &&
      match(n.props.accessibilityLabel) &&
      typeof n.props.onPress === 'function',
  );
  const set = new Set(matches);
  return matches.filter(n => {
    let parent = n.parent;
    while (parent) {
      if (set.has(parent)) return false;
      parent = parent.parent;
    }
    return true;
  });
}

function byTestId(renderer: Renderer, id: string): Instance[] {
  return renderer.root.findAll(
    n => n.props.testID === id && typeof n.type === 'string',
  );
}

interface CellView {
  day: string;
  label: string;
  disabled: boolean;
  selected: boolean;
  press: () => void;
}

interface ScreenView {
  monthTitle: string | null;
  prevDisabled: boolean | null;
  nextDisabled: boolean | null;
  cells: CellView[];
  detail: Instance | null;
  errorCard: Instance | null;
  heroText: string | null;
  allText: string;
}

function readScreen(renderer: Renderer): ScreenView {
  const titleNodes = renderer.root.findAllByType(Text).filter(n => {
    const text = Array.isArray(n.props.children)
      ? n.props.children.map(String).join('')
      : String(n.props.children ?? '');
    return /^(January|February|March|April|May|June|July|August|September|October|November|December) \d{4}$/.test(
      text,
    );
  });
  const monthTitle =
    titleNodes.length === 1
      ? (Array.isArray(titleNodes[0]!.props.children)
          ? titleNodes[0]!.props.children.map(String).join('')
          : String(titleNodes[0]!.props.children)
        ).trim()
      : titleNodes.length === 0
        ? null
        : `AMBIGUOUS(${titleNodes.length})`;
  const prev = labelled(renderer, l => l === 'Previous month');
  const next = labelled(renderer, l => l === 'Next month');
  const cells = labelled(renderer, l => /^\d{4}-\d{2}-\d{2}/.test(l)).map(
    node => ({
      day: (node.props.accessibilityLabel as string).slice(0, 10),
      label: node.props.accessibilityLabel as string,
      disabled: Boolean(node.props.disabled),
      selected: Boolean(node.props.accessibilityState?.selected),
      press: () => (node.props.onPress as () => void)(),
    }),
  );
  const detail = byTestId(renderer, 'streak-day-detail');
  const errorCard = byTestId(renderer, 'streak-load-error');
  const hero = byTestId(renderer, 'streak-hero');
  return {
    monthTitle,
    prevDisabled: prev.length === 1 ? Boolean(prev[0]!.props.disabled) : null,
    nextDisabled: next.length === 1 ? Boolean(next[0]!.props.disabled) : null,
    cells,
    detail: detail[0] ?? null,
    errorCard: errorCard[0] ?? null,
    heroText: hero[0] ? textOf(hero[0]) : null,
    allText: textOf(renderer.root),
  };
}

// ---------------------------------------------------------------------------
// Sequence runner
// ---------------------------------------------------------------------------
interface StepFailure {
  step: number;
  action: string;
  invariant: string;
  message: string;
  /** Set when the deviation matches a product issue already reproduced and
   *  minimized by this campaign (see the findings table in the summary). */
  knownIssue?: KnownIssueId;
}

/**
 * Product deviations reproduced by this harness. They stay failures (the
 * default run is red until the screen is fixed); tagging them lets the
 * campaign keep exploring for anything else and, with
 * STRESS_TOLERATE_KNOWN=1, finish a long run while still recording every
 * occurrence per seed.
 *
 * KI-1: with no snapshot (signed out) the screen derives "today" from
 *       `new Date()` at render time only; a day rollover under the mounted
 *       screen is never re-rendered, so the new today looks like a future
 *       day (bare label, muted number, no today ring).
 * KI-2: `atEarliestMonth` / `atCurrentMonth` use equality, so once the
 *       visible month falls outside [earliest, as-of] (history shrinks or the
 *       clock moves under the mounted screen) the arrows stay enabled and
 *       the user can page indefinitely past the calendar's bounds.
 */
type KnownIssueId = 'KI-1' | 'KI-2';
const TOLERATE_KNOWN = process.env.STRESS_TOLERATE_KNOWN === '1';

interface SequenceResult {
  seed: number;
  length: number;
  executedSteps: number;
  outcome: 'pass' | 'fail' | 'crash';
  failures: StepFailure[];
  trace: string[];
  traceDigest: string;
  flags: { clockBack: boolean; ownerSwitch: boolean; dbOutage: boolean };
}

const consoleLog: string[] = [];
let consoleErrorSpy: jest.SpyInstance | null = null;
let consoleWarnSpy: jest.SpyInstance | null = null;

function installConsoleCapture() {
  consoleErrorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleLog.push(`error: ${args.map(String).join(' ')}`);
    });
  consoleWarnSpy = jest
    .spyOn(console, 'warn')
    .mockImplementation((...args: unknown[]) => {
      consoleLog.push(`warn: ${args.map(String).join(' ')}`);
    });
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 12; i += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  });
}

function resetStore() {
  useConsistencyStore.setState({
    hydrated: false,
    ownerKey: null,
    snapshot: null,
    loadError: false,
    celebration: null,
    daySecured: null,
  });
}

function wipeDb(db: DatabaseSync) {
  for (const table of [
    'kv',
    'local_shot',
    'local_session',
    'local_capture',
    'outbox',
    'sync_receipt',
    'local_analysis_record',
  ]) {
    try {
      db.exec(`DELETE FROM ${table}`);
    } catch {
      // Table is created by the app's own migrations on first getDb().
    }
  }
}

let shotCounter = 0;

function insertShot(
  db: DatabaseSync,
  owner: string,
  atMs: number,
  session: boolean,
  shotType: string,
  scored: boolean,
  score: number,
) {
  shotCounter += 1;
  const id = `shot-${shotCounter}`;
  db.prepare(
    `INSERT OR REPLACE INTO local_shot
     (owner_key, id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    owner,
    id,
    session ? `session-${id}` : null,
    shotType,
    new Date(atMs).toISOString(),
    scored ? score : null,
    0.9,
    scored ? 'scored' : 'low_confidence',
    'real',
    JSON.stringify({ id, source: 'real' }),
  );
}

class Sequence {
  readonly seed: number;
  readonly actions: Action[];
  readonly preload: Preload;
  private readonly db: DatabaseSync;
  private renderer: Renderer | null = null;
  private facts: Fact[] = [];
  /** Drill ids already in each owner's ledger (the store dedupes per owner). */
  private drillIds = new Map<string, Set<string>>();
  private drillCounter = 0;

  private drillIdsFor(owner: string): Set<string> {
    let ids = this.drillIds.get(owner);
    if (!ids) {
      ids = new Set<string>();
      this.drillIds.set(owner, ids);
    }
    return ids;
  }
  private nowMs = 0;
  private owner = OWNER_A;
  private model: ScreenModel = {
    mounted: false,
    errorCardExpected: false,
    visible: null,
    selected: null,
    autoPending: true,
    renderedAsOfDay: '',
  };

  private noteScreenRender() {
    this.model.renderedAsOfDay = localDayKey(this.nowMs);
  }
  private lastSnapshot: ConsistencySnapshot | null = null;
  private lastLoadError = false;
  /** True when no fact/clock/owner change is pending a refresh. */
  private synced = false;
  readonly failures: StepFailure[] = [];
  readonly trace: string[] = [];
  readonly flags = { clockBack: false, ownerSwitch: false, dbOutage: false };
  private currentStep = 0;
  private currentAction = 'preload';

  constructor(seed: number, db: DatabaseSync, actions?: Action[]) {
    this.seed = seed;
    this.db = db;
    const rng = new Rng(seed);
    this.preload = generatePreload(rng);
    const length = rng.int(5, 60);
    this.actions = actions ?? generateActions(rng, length);
  }

  private fail(invariant: string, message: string, knownIssue?: KnownIssueId) {
    this.failures.push({
      step: this.currentStep,
      action: this.currentAction,
      invariant,
      message,
      ...(knownIssue ? { knownIssue } : {}),
    });
  }

  private expectEq(
    invariant: string,
    actual: unknown,
    expected: unknown,
    what: string,
    knownIssue?: KnownIssueId,
  ) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e)
      this.fail(invariant, `${what}: expected ${e}, got ${a}`, knownIssue);
  }

  private setClock(ms: number) {
    this.nowMs = ms;
    jest.setSystemTime(ms);
  }

  private storeState() {
    return useConsistencyStore.getState();
  }

  /** Marks the store as expected to reflect the facts after this step. */
  private async triggerRefresh(via: () => Promise<void>) {
    await act(async () => {
      await via();
    });
    await settle();
  }

  private describe(action: Action): string {
    return JSON.stringify(action);
  }

  // ---- Lifecycle -----------------------------------------------------------

  async mountHost() {
    await act(async () => {
      this.renderer = TestRenderer.create(<Host />);
    });
    await settle();
  }

  async unmountHost() {
    if (!this.renderer) return;
    const renderer = this.renderer;
    await act(async () => {
      renderer.unmount();
    });
    this.renderer = null;
    this.model.mounted = false;
  }

  private async openCalendar() {
    const snapshotAtMount = this.storeState().snapshot;
    await act(async () => {
      navigationRef.navigate('StreakCalendar');
    });
    this.model = {
      mounted: true,
      errorCardExpected: false,
      visible: monthOf(localDayKey(this.nowMs)),
      selected: null,
      autoPending: true,
      renderedAsOfDay: localDayKey(this.nowMs),
    };
    if (snapshotAtMount) this.applyAutoSelect(snapshotAtMount);
    await settle();
  }

  private applyAutoSelect(snapshot: ConsistencySnapshot) {
    if (!this.model.autoPending) return;
    this.model.autoPending = false;
    this.model.visible = monthOf(snapshot.asOfDay);
    this.model.selected = snapshot.trainedToday ? snapshot.asOfDay : null;
  }

  async setUp() {
    shotCounter = 0;
    mockSqlite.down = false;
    wipeDb(this.db);
    resetStore();
    this.setClock(this.preload.nowMs);
    this.owner = OWNER_A;
    setActiveDataOwner(OWNER_A);
    for (const fact of this.preload.facts) {
      insertShot(
        this.db,
        fact.owner,
        fact.atMs,
        fact.kind === 'session_stroke',
        fact.label.replace(/ /g, '_'),
        true,
        6.5,
      );
      this.facts.push(fact);
    }
    if (this.preload.drillSeeds.length > 0) {
      // Drills are recorded through the real store API (ledger in SQLite kv).
      for (const drill of this.preload.drillSeeds) {
        await useConsistencyStore.getState().recordDrillCompletion({
          id: drill.id,
          slug: drill.id,
          title: drill.title,
          completedAtIso: new Date(drill.atMs).toISOString(),
        });
        this.drillIdsFor(OWNER_A).add(drill.id);
        this.facts.push({
          owner: OWNER_A,
          kind: 'drill',
          atMs: drill.atMs,
          label: drill.title,
        });
      }
      resetStore();
    }
    if (this.preload.preHydrate !== 'none') {
      if (this.preload.preHydrate === 'staleDay') {
        this.setClock(this.preload.nowMs - DAY_MS);
      }
      await useConsistencyStore.getState().hydrate();
      this.setClock(this.preload.nowMs);
    }
    this.owner = this.preload.startOwner;
    setActiveDataOwner(this.owner);
    if (this.owner === SIGNED_OUT_DATA_OWNER) {
      // App.tsx re-hydrates the store for the signed-out owner.
      await useConsistencyStore.getState().hydrate();
    }
    this.synced = true;
    this.lastSnapshot = this.storeState().snapshot;
    this.lastLoadError = this.storeState().loadError;
    this.trace.push(
      `preload now=${new Date(this.nowMs).toISOString()} facts=${this.facts.length} preHydrate=${this.preload.preHydrate} owner=${this.owner}`,
    );
    await this.mountHost();
    await this.openCalendar();
    this.afterRefreshTrigger();
    this.checkInvariants();
    this.recordTrace();
  }

  // ---- Expected store updates ----------------------------------------------

  /** Called after any step that invokes `refresh()` (focus, explicit, drill). */
  private afterRefreshTrigger() {
    const state = this.storeState();
    if (
      state.snapshot !== this.lastSnapshot ||
      state.loadError !== this.lastLoadError
    ) {
      this.noteScreenRender();
    }
    if (mockSqlite.down && this.owner !== SIGNED_OUT_DATA_OWNER) {
      this.expectEq('I8', state.loadError, true, 'loadError after outage');
      if (state.snapshot !== this.lastSnapshot) {
        this.fail('I8', 'snapshot changed during a SQLite outage');
      }
    } else {
      this.expectEq('I8', state.loadError, false, 'loadError after refresh');
      this.checkStoreAgainstFacts(state.snapshot);
    }
    if (this.model.mounted && state.snapshot) {
      this.applyAutoSelect(state.snapshot);
    }
    this.lastSnapshot = state.snapshot;
    this.lastLoadError = state.loadError;
  }

  /** Called after a step that must not touch the store. */
  private afterQuietStep() {
    const state = this.storeState();
    if (state.snapshot !== this.lastSnapshot) {
      this.fail('I8', 'store snapshot changed without a refresh trigger');
      this.lastSnapshot = state.snapshot;
      this.noteScreenRender();
    }
    if (state.loadError !== this.lastLoadError) {
      this.fail('I8', 'loadError changed without a refresh trigger');
      this.lastLoadError = state.loadError;
      this.noteScreenRender();
    }
    if (this.model.mounted && state.snapshot) {
      this.applyAutoSelect(state.snapshot);
    }
  }

  private expectedTrainedDays(): Map<string, Fact[]> {
    const byDay = new Map<string, Fact[]>();
    if (this.owner === SIGNED_OUT_DATA_OWNER) return byDay;
    for (const fact of this.facts) {
      if (fact.owner !== this.owner || fact.atMs > this.nowMs) continue;
      const day = localDayKey(fact.atMs);
      const list = byDay.get(day) ?? [];
      list.push(fact);
      byDay.set(day, list);
    }
    return byDay;
  }

  private checkStoreAgainstFacts(snapshot: ConsistencySnapshot | null) {
    if (this.owner === SIGNED_OUT_DATA_OWNER) {
      this.expectEq('I7', snapshot, null, 'signed-out snapshot');
      return;
    }
    if (!snapshot) {
      this.fail('I7', 'no snapshot after a successful refresh');
      return;
    }
    const today = localDayKey(this.nowMs);
    this.expectEq('I7', snapshot.asOfDay, today, 'asOfDay');
    const expected = this.expectedTrainedDays();
    const trained = Object.values(snapshot.days)
      .filter(d => !d.shielded)
      .map(d => d.day)
      .sort();
    this.expectEq('I7', trained, [...expected.keys()].sort(), 'trained days');
    for (const [day, facts] of expected) {
      const log = snapshot.days[day];
      if (!log) continue;
      this.expectEq(
        'I7',
        log.activities.length,
        facts.length,
        `activity count ${day}`,
      );
    }
    let total = 0;
    for (const facts of expected.values()) total += facts.length;
    this.expectEq('I7', snapshot.totalActivities, total, 'totalActivities');
    this.expectEq(
      'I7',
      snapshot.totalTrainedDays,
      expected.size,
      'totalTrainedDays',
    );
    this.expectEq(
      'I7',
      snapshot.trainedToday,
      expected.has(today),
      'trainedToday',
    );
    const todayOrdinal = dayOrdinal(today);
    const first = trained[0] ? dayOrdinal(trained[0]) : null;
    for (const log of Object.values(snapshot.days)) {
      const ordinal = dayOrdinal(log.day);
      if (ordinal > todayOrdinal) this.fail('I7', `future day ${log.day}`);
      if (log.shielded) {
        if (expected.has(log.day)) {
          this.fail('I7', `shielded day ${log.day} is a trained day`);
        }
        if (first === null || ordinal <= first || ordinal >= todayOrdinal) {
          this.fail('I7', `shield ${log.day} outside the trained span`);
        }
        if (log.activities.length !== 0 || log.xp !== 0) {
          this.fail('I7', `shielded day ${log.day} carries activity/xp`);
        }
      }
    }
    if (snapshot.trainedToday && snapshot.currentStreak < 1) {
      this.fail('I7', 'trained today but streak is 0');
    }
    if (snapshot.currentStreak > 0) {
      const yesterday = localDayKey(this.nowMs - DAY_MS);
      if (!snapshot.trainedToday && !snapshot.days[yesterday]) {
        this.fail(
          'I7',
          `live run (${snapshot.currentStreak}) without today or yesterday logged`,
        );
      }
    }
    if (snapshot.longestStreak < snapshot.currentStreak) {
      this.fail('I7', 'longestStreak < currentStreak');
    }
    if (snapshot.currentStreak > expected.size + snapshot.shieldedDayCount) {
      this.fail('I7', 'currentStreak exceeds logged days');
    }
  }

  // ---- Screen invariants ---------------------------------------------------

  private checkInvariants() {
    if (consoleLog.length > 0) {
      this.fail('I9', consoleLog.splice(0).join(' | ').slice(0, 600));
    }
    if (!this.renderer) return;
    const view = readScreen(this.renderer);
    const state = this.storeState();
    if (!this.model.mounted) {
      if (view.monthTitle !== null || view.errorCard) {
        this.fail('I1', 'calendar still rendered after leaving the screen');
      }
      return;
    }
    if (FORBIDDEN_COPY.test(view.allText)) {
      const match = FORBIDDEN_COPY.exec(view.allText);
      this.fail('I10', `forbidden copy: ${match?.[0] ?? '?'}`);
    }
    const snapshot = state.snapshot;
    const errorCardExpected = !snapshot && state.loadError;
    if (errorCardExpected) {
      if (!view.errorCard) this.fail('I8', 'error card missing');
      if (view.monthTitle !== null) {
        this.fail('I8', 'calendar rendered alongside the error card');
      }
      if (view.errorCard && !/Try again/.test(textOf(view.errorCard))) {
        this.fail('I8', 'error card lacks Try again');
      }
      return;
    }
    if (view.errorCard) this.fail('I8', 'error card shown with a snapshot');

    // I1 — one month, within [earliest, asOf].
    const asOfDay = snapshot?.asOfDay ?? localDayKey(this.nowMs);
    const currentMonth = monthOf(asOfDay);
    const days = snapshot ? Object.keys(snapshot.days) : [];
    const earliestDay =
      days.length > 0 ? days.reduce((a, b) => (a < b ? a : b)) : asOfDay;
    const earliestMonth = monthOf(earliestDay);
    const visible = this.model.visible;
    if (!visible) {
      this.fail('I1', 'model has no visible month');
      return;
    }
    this.expectEq(
      'I1',
      view.monthTitle,
      `${MONTH_NAMES[visible.month]} ${visible.year}`,
      'month title',
    );
    // With no snapshot the screen's bounds and labels all hang off the
    // `new Date()` it saw at its last render (KI-1 when that day is stale).
    const staleAsOf = !snapshot && this.model.renderedAsOfDay !== asOfDay;
    const outOfBounds =
      monthIndex(visible) > monthIndex(currentMonth) ||
      monthIndex(visible) < monthIndex(earliestMonth);
    const boundsIssue: KnownIssueId = staleAsOf ? 'KI-1' : 'KI-2';
    if (monthIndex(visible) > monthIndex(currentMonth)) {
      this.fail(
        'I1',
        `future month rendered: ${MONTH_NAMES[visible.month]} ${visible.year} > as-of ${asOfDay}`,
        boundsIssue,
      );
    }
    if (monthIndex(visible) < monthIndex(earliestMonth)) {
      this.fail(
        'I1',
        `month before earliest history rendered: ${MONTH_NAMES[visible.month]} ${visible.year} < ${earliestDay}`,
        boundsIssue,
      );
    }
    // I2 — arrows.
    this.expectEq(
      'I2',
      view.nextDisabled,
      monthIndex(visible) >= monthIndex(currentMonth),
      'Next month disabled',
      staleAsOf
        ? 'KI-1'
        : outOfBounds && view.nextDisabled === false
          ? 'KI-2'
          : undefined,
    );
    this.expectEq(
      'I2',
      view.prevDisabled,
      monthIndex(visible) <= monthIndex(earliestMonth),
      'Previous month disabled',
      staleAsOf
        ? 'KI-1'
        : outOfBounds && view.prevDisabled === false
          ? 'KI-2'
          : undefined,
    );
    // I3/I4 — grid.
    const expectedDays: string[] = [];
    for (let d = 1; d <= daysInMonth(visible.year, visible.month); d += 1) {
      expectedDays.push(
        `${visible.year}-${pad2(visible.month + 1)}-${pad2(d)}`,
      );
    }
    this.expectEq(
      'I3',
      view.cells.map(c => c.day),
      expectedDays,
      'grid days',
    );
    let selectedCells = 0;
    for (const cell of view.cells) {
      const log = snapshot?.days[cell.day];
      const future = cell.day > asOfDay;
      const expectedLabel = log
        ? log.shielded
          ? `${cell.day}, shield protected`
          : `${cell.day}, trained, ${log.activities.length} ${
              log.activities.length === 1 ? 'activity' : 'activities'
            }`
        : future
          ? cell.day
          : `${cell.day}, not trained`;
      if (cell.label !== expectedLabel) {
        const staleSuffix =
          staleAsOf &&
          (cell.label === cell.day ||
            cell.label === `${cell.day}, not trained`);
        this.fail(
          'I3',
          `label ${JSON.stringify(cell.label)} != ${JSON.stringify(expectedLabel)}`,
          staleSuffix ? 'KI-1' : undefined,
        );
      }
      if (cell.disabled !== !log) {
        this.fail(
          'I4',
          `${cell.day} disabled=${cell.disabled} counted=${Boolean(log)}`,
        );
      }
      if (cell.selected) selectedCells += 1;
      if (cell.selected !== (cell.day === this.model.selected)) {
        this.fail(
          'I5',
          `${cell.day} selected=${cell.selected} model=${this.model.selected}`,
        );
      }
    }
    if (selectedCells > 1) this.fail('I5', `${selectedCells} cells selected`);
    // I5 — detail card.
    const selected = this.model.selected;
    if (selected === null) {
      if (view.detail) this.fail('I5', 'detail card without a selection');
    } else {
      if (!view.detail) {
        this.fail('I5', `detail card missing for ${selected}`);
      } else {
        const detailText = textOf(view.detail);
        const sel = monthOf(selected);
        const dayNumber = String(Number(selected.slice(8, 10)));
        if (
          !detailText.includes(MONTH_NAMES[sel.month]!) ||
          !new RegExp(`\\b${dayNumber}\\b`).test(detailText)
        ) {
          this.fail(
            'I5',
            `detail heading does not name ${selected}: ${detailText.slice(0, 80)}`,
          );
        }
        const log = snapshot?.days[selected];
        if (!log) {
          if (!detailText.includes('No training logged this day.')) {
            this.fail(
              'I5',
              `unlogged detail copy: ${detailText.slice(0, 120)}`,
            );
          }
        } else if (log.shielded) {
          if (!detailText.includes('A Streak Shield protected this day')) {
            this.fail('I5', `shield detail copy: ${detailText.slice(0, 120)}`);
          }
        } else {
          const n = log.activities.length;
          const chip = `${n} ${n === 1 ? 'ACTIVITY' : 'ACTIVITIES'}`;
          if (!detailText.includes(chip)) {
            this.fail(
              'I5',
              `detail chip ${chip} missing: ${detailText.slice(0, 120)}`,
            );
          }
          const labels = view.detail
            .findAllByType(Text)
            .filter(t => t.props.numberOfLines === 1)
            .map(t => textOf(t));
          this.expectEq(
            'I5',
            labels,
            log.activities.map(a => a.label),
            `activity rows for ${selected}`,
          );
          const facts = this.expectedTrainedDays().get(selected);
          if (
            facts &&
            this.owner !== SIGNED_OUT_DATA_OWNER &&
            !this.lastLoadError
          ) {
            const expectedLabels = [...facts]
              .sort((a, b) => a.atMs - b.atMs || a.label.localeCompare(b.label))
              .map(f => f.label);
            if (
              this.lastSnapshot === snapshot &&
              JSON.stringify(labels) !== JSON.stringify(expectedLabels) &&
              this.synced
            ) {
              this.fail(
                'I5',
                `activity rows ${JSON.stringify(labels)} != facts ${JSON.stringify(expectedLabels)}`,
              );
            }
          }
        }
      }
    }
    // I6 — hero.
    if (!view.heroText) {
      this.fail('I6', 'hero missing');
    } else {
      const streak = snapshot?.currentStreak ?? 0;
      const longest = snapshot?.longestStreak ?? 0;
      const trainedDays = snapshot?.totalTrainedDays ?? 0;
      if (!view.heroText.startsWith(`${streak} DAY STREAK`)) {
        this.fail(
          'I6',
          `hero streak: ${view.heroText.slice(0, 40)} (store ${streak})`,
        );
      }
      if (!view.heroText.includes(`${longest} LONGEST`)) {
        this.fail(
          'I6',
          `hero longest ${longest} missing: ${view.heroText.slice(0, 200)}`,
        );
      }
      if (!view.heroText.includes(`${trainedDays} DAYS TRAINED`)) {
        this.fail('I6', `hero days trained ${trainedDays} missing`);
      }
    }
  }

  private recordTrace() {
    if (!this.renderer) {
      this.trace.push(
        `${this.currentStep}:${this.currentAction} host=unmounted`,
      );
      return;
    }
    const view = readScreen(this.renderer);
    const state = this.storeState();
    const digest = {
      month: view.monthTitle,
      prev: view.prevDisabled,
      next: view.nextDisabled,
      cells: fnv1a(
        view.cells
          .map(
            c =>
              `${c.label}|${c.disabled ? 'd' : 'e'}|${c.selected ? 's' : '-'}`,
          )
          .join(';'),
      ),
      detail: view.detail ? fnv1a(textOf(view.detail)) : null,
      error: Boolean(view.errorCard),
      hero: view.heroText ? fnv1a(view.heroText) : null,
      loadError: state.loadError,
      days: state.snapshot ? Object.keys(state.snapshot.days).length : -1,
      streak: state.snapshot?.currentStreak ?? -1,
      selected: this.model.selected,
    };
    this.trace.push(
      `${this.currentStep}:${this.currentAction} ${JSON.stringify(digest)}`,
    );
  }

  // ---- Actions -------------------------------------------------------------

  private pressLabelled(label: string): boolean {
    if (!this.renderer) return false;
    const [node] = labelled(this.renderer, l => l === label);
    if (!node || node.props.disabled) return false;
    act(() => {
      (node.props.onPress as () => void)();
    });
    return true;
  }

  async step(index: number, action: Action) {
    this.currentStep = index + 1;
    this.currentAction = this.describe(action);
    const failuresBefore = this.failures.length;
    await this.apply(action);
    this.checkInvariants();
    this.recordTrace();
    return this.failures.length === failuresBefore;
  }

  private async apply(action: Action): Promise<void> {
    switch (action.t) {
      case 'prevMonth':
      case 'nextMonth': {
        if (!this.model.mounted) return;
        const label =
          action.t === 'prevMonth' ? 'Previous month' : 'Next month';
        const pressed = this.pressLabelled(label);
        if (pressed && this.model.visible) {
          this.model.visible = monthFromIndex(
            monthIndex(this.model.visible) +
              (action.t === 'prevMonth' ? -1 : 1),
          );
          this.noteScreenRender();
        }
        await settle();
        this.afterQuietStep();
        return;
      }
      case 'tapDay': {
        if (!this.model.mounted || !this.renderer) return;
        const view = readScreen(this.renderer);
        if (view.cells.length === 0) return;
        const logged = view.cells.filter(c => !c.disabled);
        const pool =
          action.preferLogged && logged.length > 0 ? logged : view.cells;
        const cell = pool[action.index % pool.length]!;
        if (cell.disabled) {
          // A real user cannot press an inert day; nothing may change.
          await settle();
          this.afterQuietStep();
          return;
        }
        act(() => cell.press());
        this.model.selected =
          this.model.selected === cell.day ? null : cell.day;
        this.noteScreenRender();
        await settle();
        this.afterQuietStep();
        return;
      }
      case 'addShot': {
        const atMs = Math.min(
          this.nowMs,
          this.nowMs -
            action.daysBack * DAY_MS -
            ((this.nowMs % DAY_MS) - action.secondOfDay * 1000),
        );
        const owner =
          this.owner === SIGNED_OUT_DATA_OWNER ? OWNER_A : this.owner;
        insertShot(
          this.db,
          owner,
          atMs,
          action.session,
          action.shotType,
          action.scored,
          action.score,
        );
        this.facts.push({
          owner,
          kind: action.session ? 'session_stroke' : 'stroke',
          atMs,
          label: action.shotType.replace(/_/g, ' '),
        });
        this.synced = false;
        if (action.refresh) {
          await this.triggerRefresh(() =>
            useConsistencyStore.getState().refresh(),
          );
          this.synced = !mockSqlite.down;
          this.afterRefreshTrigger();
        } else {
          await settle();
          this.afterQuietStep();
        }
        return;
      }
      case 'recordDrill': {
        this.drillCounter += 1;
        const allIds = [...this.drillIds.values()].flatMap(ids => [...ids]);
        const id =
          action.dup && allIds.length > 0
            ? allIds[action.daysBack % allIds.length]!
            : `drill-${this.drillCounter}`;
        const atMs = Math.min(
          this.nowMs,
          this.nowMs -
            action.daysBack * DAY_MS -
            ((this.nowMs % DAY_MS) - action.secondOfDay * 1000),
        );
        const ownerIds = this.drillIdsFor(this.owner);
        const isNew = !ownerIds.has(id);
        const recordable =
          this.owner !== SIGNED_OUT_DATA_OWNER && !mockSqlite.down;
        await this.triggerRefresh(() =>
          useConsistencyStore.getState().recordDrillCompletion({
            id,
            slug: id,
            title: `Drill ${id}`,
            completedAtIso: new Date(atMs).toISOString(),
          }),
        );
        if (recordable && isNew) {
          ownerIds.add(id);
          this.facts.push({
            owner: this.owner,
            kind: 'drill',
            atMs,
            label: `Drill ${id}`,
          });
        }
        if (
          this.owner === SIGNED_OUT_DATA_OWNER ||
          (!isNew && !mockSqlite.down)
        ) {
          // recordDrillCompletion returns before refresh when signed out or
          // when the id is already in the owner's ledger (a readable ledger
          // dedupes; an unreadable one falls through to refresh).
          this.afterQuietStep();
        } else {
          this.synced = !mockSqlite.down;
          this.afterRefreshTrigger();
        }
        return;
      }
      case 'blurRefocus': {
        if (!this.model.mounted) return;
        await act(async () => {
          navigationRef.navigate('Overlay');
        });
        await settle();
        if (this.renderer) {
          const view = readScreen(this.renderer);
          if (!view.allText.includes('OVERLAY')) {
            this.fail('I1', 'overlay route did not render');
          }
        }
        await act(async () => {
          navigationRef.goBack();
        });
        await settle();
        this.synced = !mockSqlite.down;
        this.afterRefreshTrigger();
        return;
      }
      case 'backReopen': {
        if (!this.model.mounted) {
          await this.openCalendar();
          this.synced = !mockSqlite.down;
          this.afterRefreshTrigger();
          return;
        }
        if (!this.pressLabelled('Back')) {
          this.fail('I1', 'Back button missing or disabled');
          return;
        }
        await settle();
        this.model.mounted = false;
        this.checkInvariants();
        await this.openCalendar();
        this.synced = !mockSqlite.down;
        this.afterRefreshTrigger();
        return;
      }
      case 'relaunch': {
        await this.unmountHost();
        resetStore();
        if (action.hydrate) {
          await act(async () => {
            await useConsistencyStore.getState().hydrate();
          });
        }
        this.lastSnapshot = this.storeState().snapshot;
        this.lastLoadError = this.storeState().loadError;
        await this.mountHost();
        await this.openCalendar();
        this.synced = !mockSqlite.down;
        this.afterRefreshTrigger();
        return;
      }
      case 'advanceDay':
      case 'clockBack': {
        const delta = action.t === 'advanceDay' ? action.days : -action.days;
        if (action.t === 'clockBack') this.flags.clockBack = true;
        this.setClock(this.nowMs + delta * DAY_MS);
        this.synced = false;
        if (action.refresh) {
          await this.triggerRefresh(() =>
            useConsistencyStore.getState().refresh(),
          );
          this.synced = !mockSqlite.down;
          this.afterRefreshTrigger();
        } else {
          await settle();
          this.afterQuietStep();
        }
        return;
      }
      case 'switchOwner': {
        this.flags.ownerSwitch = true;
        this.owner =
          action.owner === 'A'
            ? OWNER_A
            : action.owner === 'B'
              ? OWNER_B
              : action.owner === 'guest'
                ? GUEST_DATA_OWNER
                : SIGNED_OUT_DATA_OWNER;
        setActiveDataOwner(this.owner);
        this.synced = false;
        // The auth flow re-hydrates the consistency store for the new owner.
        await this.triggerRefresh(() =>
          useConsistencyStore.getState().hydrate(),
        );
        this.synced = !mockSqlite.down || this.owner === SIGNED_OUT_DATA_OWNER;
        this.afterRefreshTrigger();
        return;
      }
      case 'dbDown': {
        this.flags.dbOutage = true;
        mockSqlite.down = true;
        await this.triggerRefresh(() =>
          useConsistencyStore.getState().refresh(),
        );
        this.afterRefreshTrigger();
        return;
      }
      case 'dbUp': {
        mockSqlite.down = false;
        if (
          action.tryAgain &&
          this.renderer &&
          byTestId(this.renderer, 'streak-load-error')[0]
        ) {
          const [button] = labelled(this.renderer, l => l === 'Try again');
          if (!button || button.props.disabled) {
            this.fail('I8', 'Try again button not pressable');
            return;
          }
          await act(async () => {
            (button.props.onPress as () => void)();
          });
          await settle();
        } else {
          await this.triggerRefresh(() =>
            useConsistencyStore.getState().refresh(),
          );
        }
        this.synced = true;
        this.afterRefreshTrigger();
        return;
      }
      case 'explicitRefresh': {
        await this.triggerRefresh(() =>
          useConsistencyStore.getState().refresh(),
        );
        this.synced = !mockSqlite.down;
        this.afterRefreshTrigger();
        return;
      }
      default: {
        const never: never = action;
        throw new Error(`unhandled action ${JSON.stringify(never)}`);
      }
    }
  }

  async tearDown() {
    await this.unmountHost();
    mockSqlite.down = false;
    if (consoleLog.length > 0) {
      this.currentAction = 'teardown';
      this.fail('I9', consoleLog.splice(0).join(' | ').slice(0, 600));
    }
  }
}

async function runSequence(
  seed: number,
  db: DatabaseSync,
  actions?: Action[],
): Promise<SequenceResult> {
  const sequence = new Sequence(seed, db, actions);
  let executedSteps = 0;
  let outcome: SequenceResult['outcome'] = 'pass';
  try {
    await sequence.setUp();
    for (let i = 0; i < sequence.actions.length; i += 1) {
      await sequence.step(i, sequence.actions[i]!);
      executedSteps += 1;
    }
  } catch (error) {
    outcome = 'crash';
    sequence.failures.push({
      step: executedSteps,
      action: 'exception',
      invariant: 'crash',
      message:
        error instanceof Error
          ? `${error.message}\n${error.stack ?? ''}`.slice(0, 1200)
          : String(error),
    });
  } finally {
    await sequence.tearDown();
    clearPerformanceNowLog();
  }
  if (outcome === 'pass' && sequence.failures.length > 0) outcome = 'fail';
  return {
    seed,
    length: sequence.actions.length,
    executedSteps,
    outcome,
    failures: sequence.failures,
    trace: sequence.trace,
    traceDigest: fnv1a(sequence.trace.join('\n')),
    flags: sequence.flags,
  };
}

/**
 * Prefix truncation to the first failing step (one replay to confirm), then
 * greedy one-at-a-time removal (ddmin-lite) under a replay cap.
 */
async function minimize(
  seed: number,
  db: DatabaseSync,
  actions: Action[],
  firstFailingStep: number,
  cap: number,
): Promise<{ actions: Action[]; replays: number; steps: number }> {
  let current = actions;
  let replays = 0;
  let steps = 0;
  if (firstFailingStep >= 0 && firstFailingStep + 1 < actions.length) {
    const prefix = actions.slice(0, firstFailingStep + 1);
    replays += 1;
    const result = await runSequence(seed, db, prefix);
    steps += result.executedSteps;
    if (result.outcome !== 'pass') current = prefix;
  }
  let progress = true;
  while (progress && replays < cap) {
    progress = false;
    for (let i = 0; i < current.length && replays < cap; i += 1) {
      const candidate = current.filter((_, j) => j !== i);
      replays += 1;
      const result = await runSequence(seed, db, candidate);
      steps += result.executedSteps;
      if (result.outcome !== 'pass') {
        current = candidate;
        progress = true;
        i -= 1;
      }
    }
  }
  return { actions: current, replays, steps };
}

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------
interface CampaignRecord {
  seed: number;
  length: number;
  executedSteps: number;
  outcome: SequenceResult['outcome'];
  flags: SequenceResult['flags'];
  failures: StepFailure[];
  deterministic: boolean | null;
  minimizedActions: Action[] | null;
  minimizeReplays: number | null;
  /** 'full' = 120-replay ddmin; 'light' = prefix cut + 16-replay ddmin. */
  minimizePolicy: 'full' | 'light' | null;
  rerun10: { failures: number; rate: number } | null;
  replay: string;
  heapUsedMb: number;
  ms: number;
  knownIssues: KnownIssueId[];
  /** Every failure of this seed is a tagged known issue. */
  knownOnly: boolean;
}

const records: CampaignRecord[] = [];
/** First seed that reproduced each known issue. */
const knownIssueFirstSeed = new Map<KnownIssueId, number>();
/** Seeds per known issue that got the full treatment (10x rerun + ddmin). */
const knownIssueFullRuns = new Map<KnownIssueId, number>();
const FULL_RUNS_PER_KNOWN_ISSUE = 3;
let sharedDb: DatabaseSync | null = null;
let totalStepsExecuted = 0;
let determinismChecked = 0;
let determinismMismatches = 0;

const seeds: number[] =
  ONLY_SEED !== null
    ? [ONLY_SEED]
    : Array.from({ length: ITERATIONS }, (_, i) => BASE_SEED + i);
const chunks: number[][] = [];
for (let i = 0; i < seeds.length; i += CHUNK)
  chunks.push(seeds.slice(i, i + CHUNK));

beforeAll(() => {
  jest.useFakeTimers({
    doNotFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'setImmediate',
      'clearImmediate',
      'nextTick',
      'queueMicrotask',
      'hrtime',
      'performance',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
    ],
    now: BASE_SEED * 1000,
  });
  sharedDb = new DatabaseSync(':memory:');
  mockSqlite.db = sharedDb;
  // The app opens (and migrates) its local store at launch.
  getDb();
  installConsoleCapture();
});

afterAll(() => {
  consoleErrorSpy?.mockRestore();
  consoleWarnSpy?.mockRestore();
  jest.useRealTimers();
  const failed = records.filter(r => r.outcome !== 'pass');
  const summary = {
    unit: 'scr-streakcalendarscreen',
    lens: 'randomized-seeded',
    runTag: RUN_TAG,
    timeZone: deviceTimeZone(),
    node: process.version,
    baseSeed: BASE_SEED,
    onlySeed: ONLY_SEED,
    requestedSequences: seeds.length,
    executedSequences: records.length,
    executedSteps: totalStepsExecuted,
    lengthRange: records.length
      ? [
          Math.min(...records.map(r => r.length)),
          Math.max(...records.map(r => r.length)),
        ]
      : null,
    passed: records.length - failed.length,
    failed: failed.length,
    failedKnownOnly: failed.filter(r => r.knownOnly).length,
    failedNew: failed.filter(r => !r.knownOnly).length,
    tolerateKnown: TOLERATE_KNOWN,
    knownIssues: (['KI-1', 'KI-2'] as KnownIssueId[]).map(id => ({
      id,
      seeds: failed.filter(r => r.knownIssues.includes(id)).length,
      firstSeed: knownIssueFirstSeed.get(id) ?? null,
    })),
    heapUsedMbMax: records.reduce((m, r) => Math.max(m, r.heapUsedMb), 0),
    wallMs: records.reduce((t, r) => t + r.ms, 0),
    determinismChecked,
    determinismMismatches,
    invariantsTripped: Object.entries(
      failed
        .flatMap(r => r.failures)
        .reduce<Record<string, number>>((acc, f) => {
          acc[f.invariant] = (acc[f.invariant] ?? 0) + 1;
          return acc;
        }, {}),
    ),
    failedSeeds: failed.map(r => ({
      seed: r.seed,
      outcome: r.outcome,
      flags: r.flags,
      firstFailure: r.failures[0] ?? null,
      failures: r.failures.length,
      knownIssues: r.knownIssues,
      knownOnly: r.knownOnly,
      minimizedLength: r.minimizedActions?.length ?? null,
      minimizedActions: r.minimizedActions,
      minimizePolicy: r.minimizePolicy,
      rerun10: r.rerun10,
      replay: r.replay,
    })),
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const suffix = `${RUN_TAG}${ONLY_SEED !== null ? `-only-${ONLY_SEED}` : ''}`;
  writeFileSync(
    join(OUT_DIR, `streakcalendar-randomized-summary-${suffix}.json`),
    JSON.stringify(summary, null, 2),
  );
  writeFileSync(
    join(OUT_DIR, `streakcalendar-randomized-results-${suffix}.json`),
    JSON.stringify(
      records.map(r => ({
        seed: r.seed,
        outcome: r.outcome,
        length: r.length,
        executedSteps: r.executedSteps,
        deterministic: r.deterministic,
        flags: r.flags,
        failures: r.failures,
        knownIssues: r.knownIssues,
        knownOnly: r.knownOnly,
        minimizedActions: r.minimizedActions,
        minimizeReplays: r.minimizeReplays,
        minimizePolicy: r.minimizePolicy,
        rerun10: r.rerun10,
        heapUsedMb: r.heapUsedMb,
        ms: r.ms,
        replay: r.replay,
      })),
      null,
      2,
    ),
  );
});

describe(`StreakCalendarScreen randomized-seeded stress (${seeds.length} sequences, base seed ${BASE_SEED}, ${RUN_TAG})`, () => {
  it.each(chunks.map((chunk, index) => [index, chunk] as const))(
    'chunk %i holds every invariant on every step',
    async (_index, chunk) => {
      const db = sharedDb;
      if (!db) throw new Error('database not opened');
      const chunkFailures: string[] = [];
      for (const seed of chunk) {
        const startedAt = realNow();
        const first = await runSequence(seed, db);
        totalStepsExecuted += first.executedSteps;
        const record: CampaignRecord = {
          seed,
          length: first.length,
          executedSteps: first.executedSteps,
          outcome: first.outcome,
          flags: first.flags,
          failures: first.failures,
          deterministic: null,
          minimizedActions: null,
          minimizeReplays: null,
          minimizePolicy: null,
          rerun10: null,
          replay: `cd apps/mobile && STRESS_ONLY=${seed} STRESS_SEED=${BASE_SEED} npx jest --ci __tests__/stress/streakCalendarScreen.randomizedSeeded.stress.test.tsx`,
          heapUsedMb: 0,
          ms: 0,
          knownIssues: [],
          knownOnly: false,
        };
        const checkDeterminism =
          first.outcome !== 'pass' ||
          DETERMINISM === 'all' ||
          (DETERMINISM === 'sample' && seed % 5 === 0);
        if (checkDeterminism) {
          const second = await runSequence(seed, db);
          totalStepsExecuted += second.executedSteps;
          determinismChecked += 1;
          record.deterministic = second.traceDigest === first.traceDigest;
          if (!record.deterministic) {
            determinismMismatches += 1;
            const firstDiff = first.trace.findIndex(
              (line, i) => second.trace[i] !== line,
            );
            record.failures = [
              ...record.failures,
              {
                step: firstDiff,
                action: 'determinism',
                invariant: 'I11',
                message: `trace diverged at line ${firstDiff}:\n  run1: ${first.trace[firstDiff] ?? '<none>'}\n  run2: ${second.trace[firstDiff] ?? '<none>'}`,
              },
            ];
            if (record.outcome === 'pass') record.outcome = 'fail';
          }
        }
        if (record.outcome !== 'pass') {
          record.knownIssues = [
            ...new Set(
              record.failures.flatMap(f =>
                f.knownIssue ? [f.knownIssue] : [],
              ),
            ),
          ];
          record.knownOnly =
            record.failures.length > 0 &&
            record.failures.every(f => f.knownIssue);
          // Every failing seed is minimized. New failures, non-deterministic
          // ones and the first FULL_RUNS_PER_KNOWN_ISSUE seeds of each known
          // issue also get the 10x rerun and the full ddmin budget; later
          // seeds of an already-characterised known issue get the light
          // budget so a 2000-seed campaign stays tractable.
          const wantsFull =
            !record.knownOnly ||
            record.deterministic === false ||
            record.knownIssues.some(
              id =>
                (knownIssueFullRuns.get(id) ?? 0) < FULL_RUNS_PER_KNOWN_ISSUE,
            );
          for (const id of record.knownIssues) {
            if (!knownIssueFirstSeed.has(id)) knownIssueFirstSeed.set(id, seed);
            if (wantsFull) {
              knownIssueFullRuns.set(id, (knownIssueFullRuns.get(id) ?? 0) + 1);
            }
          }
          if (wantsFull) {
            const reruns: SequenceResult[] = [];
            for (let i = 0; i < 10; i += 1) {
              const rerun = await runSequence(seed, db);
              totalStepsExecuted += rerun.executedSteps;
              reruns.push(rerun);
            }
            const rerunFailures = reruns.filter(
              r => r.outcome !== 'pass',
            ).length;
            record.rerun10 = {
              failures: rerunFailures,
              rate: rerunFailures / 10,
            };
          }
          if (first.outcome !== 'pass') {
            const sequence = new Sequence(seed, db);
            const firstFailingStep = first.failures.reduce(
              (min, f) => Math.min(min, f.step),
              Number.POSITIVE_INFINITY,
            );
            const minimized = await minimize(
              seed,
              db,
              sequence.actions,
              Number.isFinite(firstFailingStep) ? firstFailingStep : -1,
              wantsFull ? 120 : 16,
            );
            totalStepsExecuted += minimized.steps;
            record.minimizedActions = minimized.actions;
            record.minimizeReplays = minimized.replays;
            record.minimizePolicy = wantsFull ? 'full' : 'light';
          }
          if (!(TOLERATE_KNOWN && record.knownOnly)) {
            chunkFailures.push(
              `seed ${seed}: ${record.failures
                .slice(0, 3)
                .map(
                  f =>
                    `[step ${f.step} ${f.invariant}${f.knownIssue ? ` ${f.knownIssue}` : ''}] ${f.message.slice(0, 300)}`,
                )
                .join('\n    ')}`,
            );
          }
        }
        record.ms = realNow() - startedAt;
        record.heapUsedMb = Math.round(
          process.memoryUsage().heapUsed / 1048576,
        );
        if (process.env.STRESS_VERBOSE) {
          process.stderr.write(
            `seed ${seed} ${record.outcome} len=${record.length} ${record.ms}ms heap=${record.heapUsedMb}MB\n`,
          );
        }
        records.push(record);
      }
      expect(chunkFailures).toEqual([]);
    },
    Math.max(30_000, CHUNK * 4_000),
  );
});
