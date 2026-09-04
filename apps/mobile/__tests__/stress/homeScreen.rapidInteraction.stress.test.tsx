/**
 * STRESS — HomeScreen under rapid / concurrent interaction.
 *
 * Renders the REAL RootNavigator (NavigationContainer + native stack + bottom
 * tabs + PremiumTabBar), the REAL HomeScreen with its REAL zustand stores
 * (app, consistency, notification, api-session, access) and the REAL data
 * layer running against an in-memory SQLite database (node:sqlite standing in
 * for op-sqlite). Only native modules (op-sqlite, safe-area, linear-gradient,
 * svg, reanimated, notify-kit, keychain) and `fetch` are mocked. Screens that
 * are NOT under test (Analyze, Result, DrillLibrary, StreakCalendar, the other
 * tabs, …) are replaced by inert recording stubs so a navigation is still a
 * real stack push through the real router but pulls no camera/video natives
 * into the suite.
 *
 * A seeded generator scripts one interaction burst per seed (double/triple
 * taps in one JS turn, tap-during-transition, simultaneous controls,
 * back-during-async, spam navigation, refresh spam, retry-during-error, chart
 * toggle spam, coach-menu spam) and after each burst asserts:
 *   - one side effect per intent: one stack push per navigate burst, one
 *     permission request per "Turn on" burst, one prefs write per "Not now"
 *     burst, at most one progress/rank request per load,
 *   - no orphan loading state (Home never stuck on "Loading your court…" or
 *     with the RefreshControl spinning once every promise/timer settled),
 *   - no duplicate modal / duplicate route (never two consecutive routes of
 *     the same name; never two visible Modals; coach menu visible ⇔ open),
 *   - rank banner fold-out mounted ⇔ expanded once its timers settled,
 *   - chart selection on screen == chart selection persisted in kv,
 *   - no console.error (act() warnings included), no unhandled rejections.
 *
 * Replay / scale:
 *   STRESS_SEED=<n>        replay exactly one seed
 *   STRESS_ITER=<n>        number of seeds (default 24 — keeps the suite fast)
 *   STRESS_SEED_BASE=<n>   first seed (default 1)
 *   STRESS_RESULTS=<path>  write the seed → outcome JSON table
 *
 *   cd apps/mobile && STRESS_SEED=17 npx jest --ci __tests__/stress/homeScreen.rapidInteraction
 */
import type { LocalDb } from '../../src/data/db';
import type { ShotAnalysis } from '@pickle/shared-types';

declare const require: (id: string) => unknown;
declare const process: {
  env: Record<string, string | undefined>;
  on?: (event: string, listener: (reason: unknown) => void) => void;
  off?: (event: string, listener: (reason: unknown) => void) => void;
};

// ---------------------------------------------------------------------------
// Native module doubles (the ONLY things mocked besides fetch and the
// non-Home destination screens).
// ---------------------------------------------------------------------------

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

// SQL statement ledger — every async statement the screen (or a store it
// touches) issues is recorded so side-effect cardinality can be asserted.
const mockSqlLedger: { sql: string; params: unknown[]; failed: boolean }[] = [];
const mockSqliteState: {
  db: DatabaseSync | null;
  /** When true every SELECT rejects — drives HomeScreen's error state. */
  failReads: boolean;
  /** Fake-timer latency per statement — opens in-flight windows. */
  latencyMs: number;
  /** Optional per-statement latency schedule (cycled) — lets a slow
   * statement issued FIRST resolve AFTER a fast one issued later. */
  latencySchedule: number[] | null;
  statementIndex: number;
} = {
  db: null,
  failReads: false,
  latencyMs: 0,
  latencySchedule: null,
  statementIndex: 0,
};

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    const real = () => {
      const db = mockSqliteState.db;
      if (!db) throw new Error('stress harness did not open a database');
      return db;
    };
    const run = (sql: string, params: unknown[]) => ({
      rows: real()
        .prepare(sql)
        .all(...(params as (string | number | null)[])),
    });
    return {
      executeSync: (sql: string, params: unknown[] = []) => run(sql, params),
      execute: async (sql: string, params: unknown[] = []) => {
        const failThisRead =
          mockSqliteState.failReads && /^\s*SELECT/i.test(sql);
        mockSqlLedger.push({ sql, params, failed: failThisRead });
        const schedule = mockSqliteState.latencySchedule;
        const latency = schedule
          ? schedule[mockSqliteState.statementIndex++ % schedule.length]!
          : mockSqliteState.latencyMs;
        if (latency > 0) {
          await new Promise(resolve => setTimeout(resolve, latency));
        }
        if (failThisRead) {
          throw new Error('stress: simulated sqlite read failure');
        }
        return run(sql, params);
      },
      close: () => {},
    };
  },
}));

jest.mock('react-native-linear-gradient', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});
jest.mock('react-native-safe-area-context', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };
  const frame = { x: 0, y: 0, width: 390, height: 844 };
  const SafeAreaInsetsContext = React.createContext(insets);
  const SafeAreaFrameContext = React.createContext(frame);
  return {
    SafeAreaProvider: (props: { children?: React.ReactNode }) =>
      React.createElement(View, null, props.children),
    SafeAreaView: View,
    SafeAreaInsetsContext,
    SafeAreaFrameContext,
    useSafeAreaInsets: () => insets,
    useSafeAreaFrame: () => frame,
    initialWindowMetrics: { insets, frame },
  };
});
jest.mock('react-native-svg', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Line: Mock,
    Path: Mock,
    Polyline: Mock,
    Rect: Mock,
    Defs: Mock,
    LinearGradient: Mock,
    Stop: Mock,
  };
});

// Capture the module-private navigation container ref RootNavigator creates
// so the harness can read the REAL navigation state after every burst.
// Everything else in @react-navigation/native is the actual implementation.
jest.mock('@react-navigation/native', () => {
  const actual = jest.requireActual<typeof import('@react-navigation/native')>(
    '@react-navigation/native',
  );
  const holder: { current: unknown } = { current: null };
  return {
    ...actual,
    __stressNavRef: holder,
    createNavigationContainerRef: () => {
      const ref = actual.createNavigationContainerRef();
      holder.current = ref;
      return ref;
    },
  };
});

// Destination screens: inert recording stubs. A navigation is still a REAL
// stack push through the real navigator; only the far screen is a stub.
const mockMountLedger: string[] = [];
function mockStub(name: string) {
  const React = jest.requireActual<typeof import('react')>('react');
  const { Text } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const Stub = () => {
    React.useEffect(() => {
      mockMountLedger.push(name);
    }, []);
    return React.createElement(
      Text,
      { testID: `stub-${name}` },
      `${name} stub`,
    );
  };
  return { [name]: Stub };
}
jest.mock('../../src/screens/LibraryScreen', () => mockStub('LibraryScreen'));
jest.mock('../../src/screens/ProgressScreen', () => mockStub('ProgressScreen'));
jest.mock('../../src/screens/SettingsScreen', () => mockStub('SettingsScreen'));
jest.mock('../../src/screens/AnalyzeScreen', () => mockStub('AnalyzeScreen'));
jest.mock('../../src/screens/DrillLibraryScreen', () =>
  mockStub('DrillLibraryScreen'),
);
jest.mock('../../src/screens/ResultScreen', () => mockStub('ResultScreen'));
jest.mock('../../src/screens/ResultDetailsScreen', () =>
  mockStub('ResultDetailsScreen'),
);
jest.mock('../../src/screens/FormReviewScreen', () =>
  mockStub('FormReviewScreen'),
);
jest.mock('../../src/screens/StreakCalendarScreen', () =>
  mockStub('StreakCalendarScreen'),
);
jest.mock('../../src/screens/PaywallScreen', () => mockStub('PaywallScreen'));
jest.mock('../../src/screens/SignInScreen', () => mockStub('SignInScreen'));
jest.mock('../../src/screens/ManageAccountScreen', () =>
  mockStub('ManageAccountScreen'),
);
jest.mock('../../src/screens/ConsentSettingsScreen', () =>
  mockStub('ConsentSettingsScreen'),
);
jest.mock('../../src/screens/NotificationSettingsScreen', () =>
  mockStub('NotificationSettingsScreen'),
);

import React from 'react';
import { Modal, RefreshControl } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { RootNavigator } from '../../src/navigation/RootNavigator';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import { useConsistencyStore } from '../../src/consistency/store';
import { useAccessStore } from '../../src/state/accessStore';
import { useAppStore } from '../../src/state/appStore';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { getDb } from '../../src/data/db';
import { saveAnalysis, saveLocalOnlyAnalysis } from '../../src/data/repository';
import { DEFAULT_NOTIFICATION_PREFS } from '../../src/notifications/types';

// ---------------------------------------------------------------------------
// Deterministic RNG (mulberry32) — every burst is replayable from its seed.
// ---------------------------------------------------------------------------
type Rng = {
  next(): number;
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
};
function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: max => Math.floor(next() * max),
    pick: items => items[Math.floor(next() * items.length)]!,
    chance: p => next() < p,
  };
}

// ---------------------------------------------------------------------------
// Fetch double: rejects (503), or defers until the burst releases it.
// ---------------------------------------------------------------------------
type FetchMode = 'reject503' | 'deferred';
const fetchState: {
  mode: FetchMode;
  log: { url: string; method: string }[];
  pending: (() => void)[];
} = { mode: 'reject503', log: [], pending: [] };

function installFetch() {
  fetchState.log = [];
  fetchState.pending = [];
  globalThis.fetch = jest.fn(
    async (input: unknown, init?: { method?: string }) => {
      const url =
        typeof input === 'string'
          ? input
          : String((input as { url?: string })?.url ?? input);
      fetchState.log.push({ url, method: init?.method ?? 'GET' });
      if (fetchState.mode === 'deferred') {
        await new Promise<void>(resolve => {
          fetchState.pending.push(resolve);
        });
      }
      return {
        ok: false,
        status: 503,
        headers: new Map(),
        json: async () => ({}),
        text: async () => '',
      } as unknown as Response;
    },
  ) as unknown as typeof fetch;
}

function releaseFetches() {
  const pending = fetchState.pending;
  fetchState.pending = [];
  for (const resolve of pending) resolve();
}

// ---------------------------------------------------------------------------
// Fixtures — persisted through the REAL repository writers.
// ---------------------------------------------------------------------------
const CANONICAL_OWNER = 'bbbbbbbb-1111-4111-8111-222222222222';

function analysisFixture(
  index: number,
  scored: boolean,
  daysAgo: number,
): ShotAnalysis {
  const captured = new Date(Date.now() - daysAgo * 86_400_000 - index * 60_000);
  const hex = index.toString(16).padStart(12, '0');
  return {
    id: `aaaaaaaa-bbbb-4ccc-8ddd-${hex}`,
    sessionId: null,
    shotType: index % 2 === 0 ? 'forehand_drive' : 'dink',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: captured.toISOString(),
    timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
    phases: [],
    measurements: [],
    checkpoints: [],
    overallScore: scored ? 5 + (index % 5) * 0.7 : null,
    analysisConfidence: scored ? 0.9 : 0.4,
    resultKind: scored ? 'scored' : 'low_confidence',
    guidance: null,
    priorityFix: null,
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'test-native-1',
      poseModelVersion: 'test-pose-1',
      paddleModelVersion: 'test-paddle-1',
      strokeDetectorVersion: 'test-stroke-1',
      phaseModelVersion: 'test-phase-1',
      scoringModelVersion: 'sm-v1',
      shotConfigVersion: 'forehand_drive@1',
    },
    source: 'real',
  };
}

async function seedShots(db: LocalDb, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const scored = i % 3 !== 2;
    const analysis = analysisFixture(i, scored, i % 4);
    if (scored) {
      await saveAnalysis(
        db,
        analysis,
        `cccccccc-bbbb-4ccc-8ddd-${i.toString(16).padStart(12, '0')}`,
      );
    } else {
      await saveLocalOnlyAnalysis(db, analysis);
    }
  }
}

// ---------------------------------------------------------------------------
// Harness plumbing
// ---------------------------------------------------------------------------
const consoleErrors: string[] = [];
const unhandled: string[] = [];
let originalConsoleError: typeof console.error;
const onUnhandled = (reason: unknown) => {
  unhandled.push(String(reason));
};

interface NavStateLike {
  index?: number;
  routes: { name: string; key: string; state?: NavStateLike }[];
}
interface NavRefLike {
  isReady(): boolean;
  getRootState(): NavStateLike | undefined;
  goBack(): void;
  canGoBack(): boolean;
  navigate(name: string, params?: unknown): void;
}
function navRef(): NavRefLike {
  const holder = (
    jest.requireMock('@react-navigation/native') as {
      __stressNavRef: { current: unknown };
    }
  ).__stressNavRef;
  if (!holder.current) throw new Error('RootNavigator did not create its ref');
  return holder.current as NavRefLike;
}
function rootRoutes(): string[] {
  return (
    navRef()
      .getRootState()
      ?.routes.map(r => r.name) ?? []
  );
}
function focusedTab(): string | null {
  const root = navRef().getRootState();
  const tabs = root?.routes[0]?.state;
  if (!tabs || tabs.index === undefined) return 'Home';
  return tabs.routes[tabs.index]?.name ?? null;
}

type Node = ReactTestInstance;
type Renderer = ReactTestRenderer;

/** RN exports Pressable as a memo wrapper, so the rendered instance's type is
 * the inner component; match it by name (same rule as the WF ledgers). */
function pressables(renderer: Renderer): Node[] {
  return renderer.root.findAll(
    n =>
      typeof n.type === 'function' &&
      n.type.name === 'Pressable' &&
      typeof n.props.onPress === 'function',
  );
}
function byTestId(renderer: Renderer, testID: string): Node | null {
  return pressables(renderer).find(n => n.props.testID === testID) ?? null;
}
function byLabel(renderer: Renderer, label: RegExp): Node | null {
  return (
    pressables(renderer).find(
      n =>
        typeof n.props.accessibilityLabel === 'string' &&
        label.test(n.props.accessibilityLabel),
    ) ?? null
  );
}
function allText(renderer: Renderer): string {
  return renderer.root
    .findAll(
      n =>
        (n.type as unknown) === 'Text' ||
        (n.type as { displayName?: string })?.displayName === 'Text',
    )
    .map(n =>
      React.Children.toArray(n.props.children)
        .filter(c => typeof c === 'string' || typeof c === 'number')
        .join(''),
    )
    .join('\n');
}
function hasTestId(renderer: Renderer, testID: string): boolean {
  return renderer.root.findAll(n => n.props.testID === testID).length > 0;
}
function refreshControl(renderer: Renderer): Node | null {
  const found = renderer.root.findAllByType(RefreshControl);
  return found[0] ?? null;
}
function visibleModals(renderer: Renderer): number {
  return renderer.root
    .findAllByType(Modal)
    .filter(m => m.props.visible === true).length;
}

async function tick(ms = 0) {
  await act(async () => {
    if (ms > 0) jest.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Drive timers + microtasks until nothing changes for two rounds. */
async function settle(maxRounds = 40): Promise<number> {
  let quiet = 0;
  let rounds = 0;
  let last = `${mockSqlLedger.length}|${fetchState.log.length}|${JSON.stringify(
    navRef().getRootState() ?? null,
  )}|${mockMountLedger.length}`;
  while (quiet < 2 && rounds < maxRounds) {
    rounds++;
    await act(async () => {
      jest.advanceTimersByTime(400);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const now = `${mockSqlLedger.length}|${fetchState.log.length}|${JSON.stringify(
      navRef().getRootState() ?? null,
    )}|${mockMountLedger.length}`;
    if (now === last) quiet++;
    else quiet = 0;
    last = now;
  }
  return rounds;
}

function countSql(pattern: RegExp, from = 0): number {
  return mockSqlLedger.slice(from).filter(s => pattern.test(s.sql)).length;
}
function countFetch(pathSuffix: string, from = 0): number {
  return fetchState.log.slice(from).filter(f => f.url.endsWith(pathSuffix))
    .length;
}
/** The SAME module instance service.ts lazily requires (jest.requireMock
 * would hand back a separate copy of the __mocks__ module). */
function notifeeMock() {
  return (
    require('react-native-notify-kit') as {
      default: { requestPermission: jest.Mock };
    }
  ).default;
}

// ---------------------------------------------------------------------------
// Scenario model
// ---------------------------------------------------------------------------
type Control =
  | 'streak-badge'
  | 'banner-toggle'
  | 'banner-streak'
  | 'analyze'
  | 'drills'
  | 'recent-result'
  | 'chart-scores'
  | 'chart-reads'
  | 'notif-turn-on'
  | 'notif-not-now'
  | 'refresh'
  | 'retry'
  | 'coach-fab'
  | 'tab-library'
  | 'tab-performance'
  | 'tab-home'
  | 'back';

const NAV_CONTROLS: readonly Control[] = [
  'streak-badge',
  'banner-streak',
  'analyze',
  'drills',
  'recent-result',
];
const NAV_TARGET: Record<string, string> = {
  'streak-badge': 'StreakCalendar',
  'banner-streak': 'StreakCalendar',
  analyze: 'Analyze',
  drills: 'DrillLibrary',
  'recent-result': 'Result',
};

type BurstKind =
  | 'multi-tap-same-turn'
  | 'tap-during-transition'
  | 'simultaneous-controls'
  | 'back-during-async'
  | 'spam-navigation'
  | 'refresh-spam'
  | 'retry-during-error'
  | 'chart-toggle-spam'
  | 'coach-menu-spam'
  | 'notification-spam'
  | 'banner-toggle-spam'
  | 'toggle-during-load'
  | 'retry-out-of-order';

const BURST_KINDS: readonly BurstKind[] = [
  'multi-tap-same-turn',
  'tap-during-transition',
  'simultaneous-controls',
  'back-during-async',
  'spam-navigation',
  'refresh-spam',
  'retry-during-error',
  'chart-toggle-spam',
  'coach-menu-spam',
  'notification-spam',
  'banner-toggle-spam',
  'toggle-during-load',
  'retry-out-of-order',
];

interface Scenario {
  seed: number;
  kind: BurstKind;
  signedIn: boolean;
  shots: number;
  dbLatencyMs: number;
  accessReady: boolean;
  steps: string[];
}

interface Outcome {
  seed: number;
  kind: BurstKind;
  scenario: Scenario;
  status: 'HELD' | 'BROKEN';
  violations: string[];
  metrics: Record<string, number | string | boolean | null>;
}

const outcomes: Outcome[] = [];
let activeRenderer: Renderer | null = null;

function findControl(renderer: Renderer, control: Control): Node | null {
  switch (control) {
    case 'streak-badge':
      return byTestId(renderer, 'home-streak-badge');
    case 'banner-toggle':
      return byTestId(renderer, 'player-rank-banner-toggle');
    case 'banner-streak':
      return byTestId(renderer, 'player-rank-banner-streak');
    case 'analyze':
      return byLabel(renderer, /^Stroke Analysis\./);
    case 'drills':
      return byLabel(renderer, /^Drill Library\./);
    case 'recent-result':
      return byLabel(renderer, /^Open .* result$/);
    case 'chart-scores':
      return byTestId(renderer, 'home-week-chart-scores');
    case 'chart-reads':
      return byTestId(renderer, 'home-week-chart-reads');
    case 'notif-turn-on':
      return byLabel(renderer, /^Turn on/);
    case 'notif-not-now':
      return byLabel(renderer, /^Not now/);
    case 'coach-fab':
      return byLabel(renderer, /coach actions$/);
    case 'tab-library':
      return byLabel(renderer, /^Library$/);
    case 'tab-performance':
      return byLabel(renderer, /^Performance$/);
    case 'tab-home':
      return byLabel(renderer, /^Home$/);
    case 'refresh':
    case 'retry':
    case 'back':
      return null;
  }
}

/** Fire a control exactly like the WF ledgers do: through the Pressable's
 * own onPress (the same handler the native responder would invoke). */
function fire(renderer: Renderer, control: Control): boolean {
  if (control === 'refresh') {
    const rc = refreshControl(renderer);
    if (!rc) return false;
    rc.props.onRefresh();
    return true;
  }
  if (control === 'retry') {
    const retry =
      byLabel(renderer, /^Try again/) ?? byLabel(renderer, /again/i);
    if (!retry) return false;
    retry.props.onPress();
    return true;
  }
  if (control === 'back') {
    const ref = navRef();
    if (!ref.canGoBack()) return false;
    ref.goBack();
    return true;
  }
  const node = findControl(renderer, control);
  if (!node) return false;
  node.props.onPress();
  return true;
}

async function mount(): Promise<Renderer> {
  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(<RootNavigator />);
  });
  return renderer;
}

async function prepare(scenario: Scenario): Promise<void> {
  // getDb() caches its migrated handle; closing it makes the next getDb()
  // run LOCAL_MIGRATIONS against the fresh in-memory database.
  if (mockSqliteState.db) {
    getDb().close();
    mockSqliteState.db.close();
  }
  mockSqliteState.db = new DatabaseSync(':memory:');
  mockSqliteState.failReads = false;
  mockSqliteState.latencyMs = 0;
  mockSqliteState.latencySchedule = null;
  mockSqliteState.statementIndex = 0;
  mockSqlLedger.length = 0;
  mockMountLedger.length = 0;
  installFetch();
  fetchState.mode = 'reject503';
  consoleErrors.length = 0;
  unhandled.length = 0;
  notifeeMock().requestPermission.mockClear();

  useAccessStore.getState().reset();
  useConsistencyStore.setState({ snapshot: null } as never);
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
    persistFailed: false,
    scheduleFailed: false,
  });
  useAppStore.setState({ profile: null } as never);

  if (scenario.signedIn) {
    setActiveDataOwner(CANONICAL_OWNER);
    establishApiSession({
      apiBaseUrl: 'https://stress.invalid',
      bearerToken: 'stress-bearer',
      canonicalAppUserId: CANONICAL_OWNER,
      provider: 'apple',
    });
  } else {
    setActiveDataOwner(GUEST_DATA_OWNER);
    clearApiSession();
  }
  if (scenario.accessReady) {
    useAccessStore.setState({
      status: 'ready',
      canonicalAccess: {
        premium: true,
        entitlements: ['pickle_sensei_pro'],
        freeRatings: {
          limit: 2,
          used: 0,
          reserved: 0,
          remaining: 2,
          availableToReserve: 2,
        },
        canStartRating: true,
      },
    } as never);
  }

  const db = getDb();
  await seedShots(db, scenario.shots);
  // The real App hydrates the notification store before Home renders; the
  // priming card is only visible on a hydrated, un-answered store.
  await useNotificationStore.getState().hydrate();
  notifeeMock().requestPermission.mockClear();
  mockSqlLedger.length = 0;
  mockSqliteState.latencyMs = scenario.dbLatencyMs;
}

// ---------------------------------------------------------------------------
// Burst generator + executor
// ---------------------------------------------------------------------------
function makeScenario(seed: number): Scenario {
  const rng = mulberry32(seed);
  const kind = BURST_KINDS[seed % BURST_KINDS.length]!;
  return {
    seed,
    kind,
    signedIn: rng.chance(0.5),
    shots: rng.pick([0, 1, 3, 7]),
    dbLatencyMs: rng.pick([0, 0, 30, 120]),
    accessReady: rng.chance(0.5),
    steps: [],
  };
}

interface Snapshot {
  routes: string[];
  sql: number;
  fetch: number;
  mounts: number;
  permission: number;
  notifWrites: number;
}
function snapshot(): Snapshot {
  return {
    routes: rootRoutes(),
    sql: mockSqlLedger.length,
    fetch: fetchState.log.length,
    mounts: mockMountLedger.length,
    permission: notifeeMock().requestPermission.mock.calls.length,
    notifWrites: countSql(/INSERT OR REPLACE INTO kv/).valueOf(),
  };
}

const HOME_LOAD_READ =
  /FROM local_shot\s+WHERE owner_key = \? AND source = 'real'\s+ORDER BY captured_at DESC LIMIT \?$/m;

function homeLoading(renderer: Renderer): boolean {
  return /Loading your court…/.test(allText(renderer));
}
function homeErrored(renderer: Renderer): boolean {
  return /Your court couldn’t load/.test(allText(renderer));
}
function homeRefreshing(renderer: Renderer): boolean {
  return refreshControl(renderer)?.props.refreshing === true;
}

async function runScenario(scenario: Scenario): Promise<Outcome> {
  const rng = mulberry32(scenario.seed ^ 0x9e3779b9);
  const violations: string[] = [];
  const metrics: Outcome['metrics'] = {};
  const step = (s: string) => scenario.steps.push(s);

  await prepare(scenario);
  const renderer = await mount();
  activeRenderer = renderer;
  await settle();
  const startupSql = mockSqlLedger.length;
  metrics['startupSql'] = startupSql;
  metrics['startupProgressRequests'] = countFetch('/v1/progress');
  metrics['startupRankRequests'] = countFetch('/v1/rank');
  if (homeLoading(renderer)) {
    violations.push('startup: Home still shows the loading state after settle');
  }
  if (scenario.signedIn && countFetch('/v1/progress') !== 1) {
    violations.push(
      `startup: expected exactly 1 /v1/progress request, saw ${countFetch('/v1/progress')}`,
    );
  }

  const before = snapshot();
  let expectedPushes: number | null = null;
  let expectedTarget: string | null = null;
  let expectedPermissionRequests: number | null = null;
  let expectedNotifWrites: number | null = null;
  let chartExpected: 'scores' | 'reads' | null = null;

  switch (scenario.kind) {
    case 'multi-tap-same-turn': {
      const control = rng.pick([
        ...NAV_CONTROLS,
        'banner-toggle',
        'coach-fab',
      ] as const);
      const taps = rng.pick([2, 3, 3, 4]);
      step(`${control} x${taps} in one JS turn`);
      let fired = 0;
      await act(async () => {
        for (let i = 0; i < taps; i++) if (fire(renderer, control)) fired++;
      });
      metrics['fired'] = fired;
      if (fired > 0 && NAV_TARGET[control]) {
        expectedPushes = 1;
        expectedTarget = NAV_TARGET[control]!;
      }
      break;
    }
    case 'tap-during-transition': {
      const control = rng.pick(NAV_CONTROLS);
      const gaps = [0, 16, 50, 120];
      const gap = rng.pick(gaps);
      step(`${control}, wait ${gap}ms (transition running), ${control} again`);
      let fired = 0;
      await act(async () => {
        if (fire(renderer, control)) fired++;
      });
      await tick(gap);
      await act(async () => {
        if (fire(renderer, control)) fired++;
      });
      metrics['fired'] = fired;
      metrics['gapMs'] = gap;
      if (fired > 0) {
        expectedPushes = 1;
        expectedTarget = NAV_TARGET[control]!;
      }
      break;
    }
    case 'simultaneous-controls': {
      const a = rng.pick([
        ...NAV_CONTROLS,
        'banner-toggle',
        'coach-fab',
      ] as const);
      const others = (
        [
          ...NAV_CONTROLS,
          'banner-toggle',
          'chart-reads',
          'chart-scores',
          'refresh',
          'coach-fab',
          'tab-library',
        ] as const
      ).filter(c => c !== a);
      const b = rng.pick(others);
      step(`${a} + ${b} in one JS turn`);
      let firedA = false;
      let firedB = false;
      await act(async () => {
        firedA = fire(renderer, a);
        firedB = fire(renderer, b);
      });
      metrics['firedA'] = firedA;
      metrics['firedB'] = firedB;
      const navA = firedA && NAV_TARGET[a] ? 1 : 0;
      const navB = firedB && NAV_TARGET[b] ? 1 : 0;
      // Two different navigate intents in the same turn legitimately push
      // two routes; what must never happen is a duplicate of either.
      expectedPushes = navA + navB;
      if (b === 'chart-reads') chartExpected = 'reads';
      if (b === 'chart-scores') chartExpected = 'scores';
      break;
    }
    case 'back-during-async': {
      const control = rng.pick(NAV_CONTROLS);
      const viaRefresh = rng.chance(0.5);
      fetchState.mode = 'deferred';
      mockSqliteState.latencyMs = Math.max(mockSqliteState.latencyMs, 60);
      step(
        `${viaRefresh ? 'refresh (deferred network), ' : ''}${control}, back while Home load in flight, release`,
      );
      await act(async () => {
        if (viaRefresh) fire(renderer, 'refresh');
        fire(renderer, control);
      });
      await tick(16);
      await act(async () => {
        fire(renderer, 'back');
      });
      await tick(rng.pick([0, 30, 200]));
      await act(async () => {
        releaseFetches();
      });
      await settle();
      await act(async () => {
        releaseFetches();
      });
      fetchState.mode = 'reject503';
      expectedPushes = 0;
      break;
    }
    case 'spam-navigation': {
      const hops = 3 + rng.int(6);
      const script: string[] = [];
      for (let i = 0; i < hops; i++) {
        const c = rng.pick([
          ...NAV_CONTROLS,
          'back',
          'back',
          'tab-library',
          'tab-performance',
          'tab-home',
        ] as const);
        script.push(c);
      }
      step(`spam: ${script.join(' → ')}`);
      let fired = 0;
      for (const c of script) {
        const delay = rng.pick([0, 0, 16, 60]);
        await act(async () => {
          if (fire(renderer, c as Control)) fired++;
        });
        if (delay > 0) await tick(delay);
      }
      metrics['fired'] = fired;
      break;
    }
    case 'refresh-spam': {
      const pulls = 2 + rng.int(4);
      const deferred = rng.chance(0.5);
      if (deferred) fetchState.mode = 'deferred';
      step(`refresh x${pulls}${deferred ? ' with deferred network' : ''}`);
      for (let i = 0; i < pulls; i++) {
        await act(async () => {
          fire(renderer, 'refresh');
        });
        const gap = rng.pick([0, 0, 16, 80]);
        if (gap > 0) await tick(gap);
      }
      if (deferred) {
        await tick(50);
        await act(async () => {
          releaseFetches();
        });
        await settle();
        await act(async () => {
          releaseFetches();
        });
        fetchState.mode = 'reject503';
      }
      metrics['pulls'] = pulls;
      break;
    }
    case 'retry-during-error': {
      mockSqliteState.failReads = true;
      const retries = 2 + rng.int(3);
      step(
        `refresh (reads fail) → error state → retry x${retries} → reads recover`,
      );
      await act(async () => {
        fire(renderer, 'refresh');
      });
      await settle();
      metrics['reachedErrorState'] = homeErrored(renderer);
      if (!homeErrored(renderer)) {
        violations.push('retry: Home never reached its error state');
      }
      const recoverAt = rng.int(retries);
      let fired = 0;
      for (let i = 0; i < retries; i++) {
        if (i === recoverAt) mockSqliteState.failReads = false;
        await act(async () => {
          if (fire(renderer, 'retry')) fired++;
        });
        // Either tap again mid-load or let the attempt land first.
        if (rng.chance(0.5)) await tick(16);
        else await settle();
      }
      metrics['retriesFired'] = fired;
      break;
    }
    case 'chart-toggle-spam': {
      const flips = 2 + rng.int(6);
      let last: 'scores' | 'reads' = 'scores';
      const seq: string[] = [];
      for (let i = 0; i < flips; i++) {
        last = rng.pick(['scores', 'reads'] as const);
        seq.push(last);
      }
      step(`chart: ${seq.join(',')}`);
      const sameTurn = rng.chance(0.5);
      if (sameTurn) {
        await act(async () => {
          for (const s of seq)
            fire(renderer, s === 'scores' ? 'chart-scores' : 'chart-reads');
        });
      } else {
        for (const s of seq) {
          await act(async () => {
            fire(renderer, s === 'scores' ? 'chart-scores' : 'chart-reads');
          });
          await tick(rng.pick([0, 16]));
        }
      }
      chartExpected = last;
      break;
    }
    case 'coach-menu-spam': {
      const taps = 2 + rng.int(5);
      const gaps = Array.from({ length: taps }, () =>
        rng.pick([0, 0, 16, 100, 250]),
      );
      step(`coach FAB x${taps} gaps ${gaps.join('/')}`);
      let fired = 0;
      for (let i = 0; i < taps; i++) {
        await act(async () => {
          if (fire(renderer, 'coach-fab')) fired++;
        });
        if (gaps[i]! > 0) await tick(gaps[i]!);
      }
      metrics['fired'] = fired;
      break;
    }
    case 'notification-spam': {
      const control = rng.pick(['notif-turn-on', 'notif-not-now'] as const);
      const taps = rng.pick([2, 3]);
      const sameTurn = rng.chance(0.6);
      step(`${control} x${taps} ${sameTurn ? 'same turn' : '16ms apart'}`);
      let fired = 0;
      if (sameTurn) {
        await act(async () => {
          for (let i = 0; i < taps; i++) if (fire(renderer, control)) fired++;
        });
      } else {
        for (let i = 0; i < taps; i++) {
          await act(async () => {
            if (fire(renderer, control)) fired++;
          });
          await tick(16);
        }
      }
      metrics['fired'] = fired;
      metrics['cardVisibleAtStart'] = fired > 0;
      if (fired > 0) {
        // One intent ("turn on" / "not now") ⇒ one permission prompt and one
        // durable prefs write, however many times the finger landed.
        if (control === 'notif-turn-on') expectedPermissionRequests = 1;
        expectedNotifWrites = 1;
      }
      break;
    }
    case 'banner-toggle-spam': {
      const taps = 2 + rng.int(5);
      const gaps = Array.from({ length: taps }, () =>
        rng.pick([0, 16, 100, 200, 300]),
      );
      step(`rank banner toggle x${taps} gaps ${gaps.join('/')}`);
      let fired = 0;
      for (let i = 0; i < taps; i++) {
        await act(async () => {
          if (fire(renderer, 'banner-toggle')) fired++;
        });
        if (gaps[i]! > 0) await tick(gaps[i]!);
      }
      metrics['fired'] = fired;
      break;
    }
    case 'toggle-during-load': {
      // A load (pull-to-refresh or re-focus) is in flight when the player
      // picks the other chart. The pick is the newest intent and must win.
      mockSqliteState.latencyMs = Math.max(mockSqliteState.latencyMs, 60);
      const viaRefresh = rng.chance(0.6);
      const target = rng.pick(['scores', 'reads'] as const);
      const wait = rng.pick([0, 16, 40]);
      step(
        `${viaRefresh ? 'refresh' : 'tab-library → tab-home (re-focus load)'}, wait ${wait}ms, chart ${target} while load in flight`,
      );
      await act(async () => {
        if (viaRefresh) fire(renderer, 'refresh');
        else fire(renderer, 'tab-library');
      });
      if (!viaRefresh) {
        await tick(16);
        await act(async () => {
          fire(renderer, 'tab-home');
        });
      }
      if (wait > 0) await tick(wait);
      let fired = false;
      await act(async () => {
        fired = fire(
          renderer,
          target === 'scores' ? 'chart-scores' : 'chart-reads',
        );
      });
      metrics['fired'] = fired;
      if (fired) chartExpected = target;
      break;
    }
    case 'retry-out-of-order': {
      // Reads fail; the player taps "Try again" (slow, still failing), then
      // immediately hops to Library and back. The re-focus load is fast and
      // succeeds; the stale failure lands AFTER it. The newest load succeeded,
      // so Home must end on data, not on the error card.
      mockSqliteState.failReads = true;
      const slow = rng.pick([150, 300, 600]);
      const gap = rng.pick([0, 16, 50]);
      step(
        `refresh (reads fail) → error → retry(slow ${slow}ms, fails) → ${gap}ms → tab-library → tab-home (fast re-focus load succeeds)`,
      );
      await act(async () => {
        fire(renderer, 'refresh');
      });
      await settle();
      metrics['reachedErrorState'] = homeErrored(renderer);
      if (!homeErrored(renderer)) {
        violations.push('retry: Home never reached its error state');
      }
      mockSqliteState.statementIndex = 0;
      // Home's load issues 3 statements: the retry is slow, everything after fast.
      mockSqliteState.latencySchedule = [
        slow,
        slow,
        slow,
        ...Array<number>(12).fill(0),
      ];
      let fired = 0;
      await act(async () => {
        if (fire(renderer, 'retry')) fired++;
      });
      await tick(gap);
      mockSqliteState.failReads = false;
      await act(async () => {
        fire(renderer, 'tab-library');
      });
      await tick(16);
      await act(async () => {
        fire(renderer, 'tab-home');
      });
      metrics['retriesFired'] = fired;
      metrics['slowMs'] = slow;
      break;
    }
  }

  const rounds = await settle();
  metrics['settleRounds'] = rounds;
  const after = snapshot();

  // ---- Invariants ---------------------------------------------------------
  const routes = after.routes;
  metrics['routesAfter'] = routes.join('>');
  metrics['focusedTab'] = focusedTab();
  for (let i = 1; i < routes.length; i++) {
    if (routes[i] === routes[i - 1]) {
      violations.push(`duplicate consecutive route: ${routes.join('>')}`);
      break;
    }
  }
  const pushes = routes.length - before.routes.length;
  metrics['pushes'] = pushes;
  if (expectedPushes !== null && pushes !== expectedPushes) {
    violations.push(
      `expected ${expectedPushes} stack push(es), got ${pushes} (${routes.join('>')})`,
    );
  }
  if (expectedTarget !== null) {
    const hits = routes.filter(r => r === expectedTarget).length;
    // Analyze may legitimately be REPLACED by Paywall by the rating gate.
    const gated = expectedTarget === 'Analyze' && routes.includes('Paywall');
    if (hits !== 1 && !gated) {
      violations.push(
        `expected exactly one ${expectedTarget} route, got ${hits} (${routes.join('>')})`,
      );
    }
  }
  const paywalls = routes.filter(r => r === 'Paywall').length;
  if (paywalls > 1)
    violations.push(`duplicate Paywall modal routes: ${paywalls}`);
  const modals = visibleModals(renderer);
  metrics['visibleModals'] = modals;
  if (modals > 1) violations.push(`${modals} Modals visible at once`);

  // Coach menu: visible ⇔ open once settled.
  const fab = byLabel(renderer, /coach actions$/);
  if (fab) {
    const open = fab.props.accessibilityState?.expanded === true;
    if (open !== modals > 0) {
      violations.push(`coach menu open=${open} but visible modals=${modals}`);
    }
  }

  // Home never orphaned in loading / refreshing / error-without-cause.
  const onHome = routes.length === 1 && focusedTab() === 'Home';
  metrics['homeLoading'] = homeLoading(renderer);
  metrics['homeRefreshing'] = homeRefreshing(renderer);
  metrics['homeErrored'] = homeErrored(renderer);
  if (onHome && homeLoading(renderer)) {
    violations.push('orphan loading state: Home still loading after settle');
  }
  if (homeRefreshing(renderer)) {
    violations.push(
      'orphan refresh: RefreshControl still refreshing after settle',
    );
  }
  // The error card must describe the NEWEST load's outcome, whatever order
  // overlapping attempts resolved in.
  const lastLoadRead = [...mockSqlLedger]
    .reverse()
    .find(s => HOME_LOAD_READ.test(s.sql));
  const lastLoadFailed = lastLoadRead?.failed === true;
  metrics['lastLoadFailed'] = lastLoadFailed;
  if (onHome && homeErrored(renderer) !== lastLoadFailed) {
    violations.push(
      lastLoadFailed
        ? 'Home hides the error although its newest load failed'
        : 'Home shows the error state although its newest load succeeded',
    );
  }

  // Rank banner: fold-out mounted ⇔ expanded once its timers settled.
  const toggle = byTestId(renderer, 'player-rank-banner-toggle');
  if (toggle) {
    const expanded = toggle.props.accessibilityState?.expanded === true;
    const mounted = hasTestId(renderer, 'player-rank-banner-fold-out');
    metrics['bannerExpanded'] = expanded;
    if (expanded !== mounted) {
      violations.push(
        `rank banner expanded=${expanded} but fold-out mounted=${mounted}`,
      );
    }
  }

  // Chart: on-screen selection == persisted selection.
  if (chartExpected !== null) {
    const row = mockSqliteState
      .db!.prepare('SELECT value FROM kv WHERE key = ?')
      .all('home.week-chart')[0];
    const persisted = row ? String(row['value']) : null;
    metrics['chartPersisted'] = persisted;
    const scoresBtn = byTestId(renderer, 'home-week-chart-scores');
    const selected =
      scoresBtn?.props.accessibilityState?.selected === true
        ? 'scores'
        : 'reads';
    metrics['chartSelected'] = selected;
    if (persisted !== chartExpected) {
      violations.push(`chart persisted=${persisted} expected=${chartExpected}`);
    }
    if (selected !== chartExpected) {
      violations.push(`chart selected=${selected} expected=${chartExpected}`);
    }
  }

  // Side-effect cardinality.
  const permissionRequests = after.permission - before.permission;
  metrics['permissionRequests'] = permissionRequests;
  if (
    expectedPermissionRequests !== null &&
    permissionRequests !== expectedPermissionRequests
  ) {
    violations.push(
      `expected ${expectedPermissionRequests} permission request(s), got ${permissionRequests}`,
    );
  }
  const notifPrefWrites = mockSqlLedger
    .slice(before.sql)
    .filter(
      s =>
        /INSERT OR REPLACE INTO kv/.test(s.sql) &&
        String(s.params[0]).startsWith('notifications'),
    ).length;
  metrics['notifPrefWrites'] = notifPrefWrites;
  if (expectedNotifWrites !== null && notifPrefWrites !== expectedNotifWrites) {
    violations.push(
      `expected ${expectedNotifWrites} notification pref write(s), got ${notifPrefWrites}`,
    );
  }
  const progress = countFetch('/v1/progress', before.fetch);
  const rank = countFetch('/v1/rank', before.fetch);
  // Every Home load() issues exactly two LIMITed local_shot reads
  // (listShots + listRealAnalysisFacts).
  const homeLoads = Math.ceil(countSql(HOME_LOAD_READ, before.sql) / 2);
  metrics['progressRequests'] = progress;
  metrics['rankRequests'] = rank;
  metrics['homeLoads'] = homeLoads;
  metrics['sqlDuringBurst'] = after.sql - before.sql;
  metrics['stubMounts'] = after.mounts - before.mounts;
  if (scenario.signedIn && progress > Math.max(homeLoads, 1) + 0) {
    violations.push(
      `${progress} /v1/progress requests for ${homeLoads} Home load(s)`,
    );
  }

  if (consoleErrors.length > 0) {
    violations.push(
      `console.error x${consoleErrors.length}: ${consoleErrors[0]!.slice(0, 300)}`,
    );
  }
  if (unhandled.length > 0) {
    violations.push(
      `unhandled rejection x${unhandled.length}: ${unhandled[0]!.slice(0, 300)}`,
    );
  }

  await act(async () => {
    renderer.unmount();
  });
  activeRenderer = null;
  await tick(500);

  return {
    seed: scenario.seed,
    kind: scenario.kind,
    scenario,
    status: violations.length === 0 ? 'HELD' : 'BROKEN',
    violations,
    metrics,
  };
}

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------
const env = process.env;
const ONE_SEED = env['STRESS_SEED'] ? Number(env['STRESS_SEED']) : null;
const ITER = env['STRESS_ITER'] ? Number(env['STRESS_ITER']) : 24;
const BASE = env['STRESS_SEED_BASE'] ? Number(env['STRESS_SEED_BASE']) : 1;
const RESULTS = env['STRESS_RESULTS'] ?? null;

const seeds: number[] =
  ONE_SEED !== null
    ? [ONE_SEED]
    : Array.from({ length: ITER }, (_, i) => BASE + i);

beforeAll(() => {
  originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(' '));
  };
  process.on?.('unhandledRejection', onUnhandled);
});

afterAll(() => {
  console.error = originalConsoleError;
  process.off?.('unhandledRejection', onUnhandled);
  mockSqliteState.db?.close();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  clearApiSession();
  if (RESULTS) {
    const fs = require('fs') as {
      writeFileSync(path: string, data: string): void;
    };
    fs.writeFileSync(
      RESULTS,
      JSON.stringify(
        {
          unit: 'scr-homescreen',
          lens: 'rapid-interaction',
          executed: outcomes.length,
          held: outcomes.filter(o => o.status === 'HELD').length,
          broken: outcomes.filter(o => o.status === 'BROKEN').length,
          outcomes,
        },
        null,
        2,
      ),
    );
  }
});

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(async () => {
  // A scenario that threw or timed out must not leak its tree (and its store
  // subscriptions) into the next seed's act()/console.error ledger.
  if (activeRenderer) {
    const leaked = activeRenderer;
    activeRenderer = null;
    await act(async () => {
      leaked.unmount();
    });
  }
  jest.useRealTimers();
});

describe('HomeScreen rapid-interaction stress (real RootNavigator + stores + SQLite)', () => {
  for (const seed of seeds) {
    const scenario = makeScenario(seed);
    it(`seed=${seed} ${scenario.kind}`, async () => {
      const outcome = await runScenario(scenario);
      outcomes.push(outcome);
      expect({
        seed,
        steps: scenario.steps,
        violations: outcome.violations,
      }).toEqual({ seed, steps: scenario.steps, violations: [] });
    });
  }
});
