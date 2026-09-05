/**
 * STRESS — NotificationSettingsScreen × lifecycle interruption.
 *
 * Renders the REAL RootNavigator (real @react-navigation/native container,
 * real native-stack + bottom-tabs navigators, real useFocusEffect /
 * useNavigation), the REAL notificationStore (zustand) and the REAL
 * useNotificationBootstrap that App.tsx mounts, then drives a seeded schedule
 * of lifecycle events against them:
 *
 *   navigate in / back (focus → refreshPermission, unmount mid-request)
 *   background / foreground (AppState 'change')
 *   kill + relaunch (whole tree unmounted, in-memory store reset, re-hydrate
 *     from the persisted kv; the OS notification center and permission
 *     survive the kill)
 *   account switch / sign-out / sign-in (setActiveDataOwner + owner prop,
 *     navigator torn down while the owner changes exactly as the Gate does)
 *   permission revoked / granted / reset later in system settings
 *   user taps: turn on, every switch, presets, ±30m, check again, open settings
 *   deferred I/O with seeded settle order + injected faults (kv read/write,
 *     permission read/request, applyPlan, cancelAllPlanned, openSettings)
 *
 * Only native/data seams are mocked: SQLite kv (`data/repository`,
 * `data/db`), the OS scheduler port (`notifications/service`), the
 * consistency snapshot (reads SQLite), safe-area (library jest mock), and the
 * sibling screens RootNavigator registers (they are not the unit under test;
 * the Home stub carries the "open notification settings" affordance the real
 * SettingsScreen provides). Token rotation is N/A: neither the screen nor the
 * store touches fetch or a bearer.
 *
 * Every iteration is replayable:  STRESS_SEED=<seed> npx jest --ci <this file>
 * Campaign size:                   STRESS_ITER=<n>    (default 120)
 * Soft invariants fail the run:    STRESS_STRICT=1    (see SOFT_INVARIANTS)
 * Replay a seed's world with an explicit op list (minimisation):
 *                                  STRESS_SEED=<seed> STRESS_SCHEDULE='[{"op":...}]'
 * JSON table (seed → outcome):     STRESS_OUT=<dir>   (default
 *                                  <repo>/artifacts/stress/scr-notificationsettingsscreen)
 */
import React, { useState } from 'react';
import { AppState, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/** Node globals the RN tsconfig does not declare (same pattern as
 * __tests__/xc/xcMatrixNetworkAuth2.keeper.test.ts). */
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  version: string;
  memoryUsage: () => { heapUsed: number; rss: number; external: number };
};
const fs = require('fs') as {
  mkdirSync: (p: string, options: { recursive: true }) => void;
  writeFileSync: (p: string, data: string) => void;
};
const path = require('path') as {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
};

// ─── Native / data seams (the only mocks) ────────────────────────────────────

jest.mock(
  'react-native-safe-area-context',
  () =>
    jest.requireActual<{ default: unknown }>(
      'react-native-safe-area-context/jest/mock',
    ).default,
);

jest.mock('../../src/data/db', () => ({ getDb: () => ({}) }));
jest.mock('../../src/data/repository', () => ({
  getKv: (_db: unknown, key: string) => mockWorld.io.getKv(key),
  setKv: (_db: unknown, key: string, value: string) =>
    mockWorld.io.setKv(key, value),
}));
jest.mock('../../src/consistency/store', () => ({
  computeConsistencySnapshot: () => mockWorld.io.consistencySnapshot(),
}));
jest.mock('../../src/notifications/service', () => ({
  __esModule: true,
  getScheduler: () => mockWorld.os.scheduler,
  subscribeToNotificationPresses: () => mockWorld.os.subscribePress(),
}));

// Sibling screens RootNavigator registers. Home carries the affordance the
// real SettingsScreen offers (navigation.navigate('NotificationSettings')).
jest.mock('../../src/screens/HomeScreen', () => {
  const ReactModule = require('react') as typeof import('react');
  const RN = require('react-native') as typeof import('react-native');
  const Nav =
    require('@react-navigation/native') as typeof import('@react-navigation/native');
  return {
    HomeScreen: () => {
      const navigation = Nav.useNavigation<{
        navigate: (route: 'NotificationSettings') => void;
      }>();
      return ReactModule.createElement(
        RN.Pressable,
        {
          accessibilityRole: 'button',
          accessibilityLabel: 'Open notification settings',
          onPress: () => navigation.navigate('NotificationSettings'),
        },
        ReactModule.createElement(RN.Text, null, 'Home stub'),
      );
    },
  };
});
jest.mock('../../src/screens/LibraryScreen', () => ({
  LibraryScreen: () => null,
}));
jest.mock('../../src/screens/ProgressScreen', () => ({
  ProgressScreen: () => null,
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
jest.mock('../../src/screens/ResultScreen', () => ({
  ResultScreen: () => null,
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
jest.mock('../../src/navigation/PremiumTabBar', () => ({
  PremiumTabBar: () => null,
}));
// RootNavigator only reads `session` from the auth store (route gates that
// never render here); the real store drags Keychain + network into the tree.
jest.mock('../../src/auth/authStore', () => {
  const { create } = require('zustand') as typeof import('zustand');
  return {
    __esModule: true,
    useAuthStore: create(() => ({ hydrated: true, session: null })),
  };
});

import { RootNavigator } from '../../src/navigation/RootNavigator';
import { NotificationSettingsScreen } from '../../src/screens/NotificationSettingsScreen';
import { useNotificationBootstrap } from '../../src/notifications/useNotificationBootstrap';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import { buildNotificationPlan } from '../../src/notifications/plan';
import type {
  PermissionState,
  SchedulerPort,
} from '../../src/notifications/service';
import {
  DEFAULT_NOTIFICATION_PREFS,
  formatReminderMinutes,
  notificationPrefsKeyForOwner,
  parseNotificationPrefs,
  type NotificationPrefs,
  type PlannedNotification,
} from '../../src/notifications/types';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { BrandToggle } from '../../src/design/components';

// ─── Seeded PRNG ─────────────────────────────────────────────────────────────

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
function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}
const chance = (rng: () => number, p: number): boolean => rng() < p;

// ─── Fake world: deferred I/O, durable kv, OS notification center ────────────

type IoKind =
  | 'kv.get'
  | 'kv.set'
  | 'consistency'
  | 'perm.read'
  | 'perm.request'
  | 'os.apply'
  | 'os.cancel'
  | 'os.openSettings';

interface Pending {
  id: number;
  kind: IoKind;
  settle: () => void;
}

const SYNC_KINDS = new Set<IoKind>(['consistency', 'os.apply', 'os.cancel']);
/** SQLite work runs on one serialized connection: it completes in issue
 *  order, never overtaking an earlier statement. Bridge calls to the
 *  notification center may interleave freely. */
const SQLITE_KINDS = new Set<IoKind>(['kv.get', 'kv.set', 'consistency']);

/** Fixed "now" so every plan the store builds is byte-for-byte replayable. */
const FIXED_NOW_MS = new Date(2026, 8, 4, 10, 0, 0).getTime();

const CONSISTENCY_SNAPSHOT = {
  currentStreak: 3,
  trainedToday: false,
  totalActivities: 5,
  shieldsAvailable: 1,
  nextStreakMilestone: null,
};

class FakeIo {
  kv = new Map<string, string>();
  pending: Pending[] = [];
  issued = 0;
  settled = 0;
  /** "Next N calls of this kind fail" counters, armed by schedule ops. */
  faults: Record<IoKind, number> = {
    'kv.get': 0,
    'kv.set': 0,
    consistency: 0,
    'perm.read': 0,
    'perm.request': 0,
    'os.apply': 0,
    'os.cancel': 0,
    'os.openSettings': 0,
  };
  /** Injected failures that actually bit, per kind. */
  fired: Record<IoKind, number> = {
    'kv.get': 0,
    'kv.set': 0,
    consistency: 0,
    'perm.read': 0,
    'perm.request': 0,
    'os.apply': 0,
    'os.cancel': 0,
    'os.openSettings': 0,
  };
  /** Probability a call completes on the microtask queue instead of waiting
   *  for an explicit settle op (seeded per scenario). */
  pImmediate = 0.5;
  rng: () => number = mulberry32(0);
  /** Settle/fault log since the last trace line (replays only). */
  events: string[] = [];
  /** Times a sync step (context load / apply / cancel) was issued while
   *  another sync step was still deferred — two syncNow() runs overlapped. */
  overlappingSyncs = 0;
  private nextId = 1;

  defer<T>(kind: IoKind, run: () => T): Promise<T> {
    this.issued += 1;
    const id = this.nextId++;
    if (
      SYNC_KINDS.has(kind) &&
      this.pending.some(entry => SYNC_KINDS.has(entry.kind))
    ) {
      this.overlappingSyncs += 1;
    }
    return new Promise<T>((resolve, reject) => {
      const settle = () => {
        this.settled += 1;
        if (this.faults[kind] > 0) {
          this.faults[kind] -= 1;
          this.fired[kind] += 1;
          this.events.push(`#${id}:${kind}:FAULT`);
          reject(new Error(`injected ${kind} failure`));
          return;
        }
        this.events.push(`#${id}:${kind}:ok`);
        try {
          resolve(run());
        } catch (error) {
          reject(error);
        }
      };
      const mustQueue =
        SQLITE_KINDS.has(kind) &&
        this.pending.some(entry => SQLITE_KINDS.has(entry.kind));
      if (!mustQueue && chance(this.rng, this.pImmediate)) {
        // Still asynchronous (a real bridge call never resolves inline).
        this.events.push(`#${id}:${kind}:issued(immediate)`);
        void Promise.resolve().then(settle);
      } else {
        this.events.push(`#${id}:${kind}:issued(deferred)`);
        this.pending.push({ id, kind, settle });
      }
    });
  }

  settleOne(index: number): Pending | null {
    const chosen = this.pending[index];
    if (!chosen) return null;
    const actual = SQLITE_KINDS.has(chosen.kind)
      ? this.pending.findIndex(entry => SQLITE_KINDS.has(entry.kind))
      : index;
    const [entry] = this.pending.splice(actual, 1);
    if (!entry) return null;
    entry.settle();
    return entry;
  }

  getKv(key: string): Promise<string | null> {
    return this.defer('kv.get', () => this.kv.get(key) ?? null);
  }
  setKv(key: string, value: string): Promise<void> {
    return this.defer('kv.set', () => {
      this.kv.set(key, value);
    });
  }
  consistencySnapshot(): Promise<typeof CONSISTENCY_SNAPSHOT> {
    return this.defer('consistency', () => ({ ...CONSISTENCY_SNAPSHOT }));
  }
}

class FakeOs {
  permission: PermissionState = 'undetermined';
  /** Bumped every time system settings change the permission. */
  permissionVersion = 0;
  /** Version + outcome of every permission read/request that settled. */
  settledPermissionReads: Array<{ version: number; ok: boolean }> = [];
  planned = new Map<string, PlannedNotification>();
  applyCalls = 0;
  cancelCalls = 0;
  /** Outcome of the most recently SETTLED cancelAllPlanned call. */
  lastCancel: 'ok' | 'fault' | null = null;
  openSettingsCalls = 0;
  pressSubscriptions = 0;
  pressUnsubscriptions = 0;
  /** What the OS answers when the app asks (a re-prompt after a denial is not
   *  possible on iOS, so a request while denied stays denied). */
  requestOutcome: PermissionState = 'granted';

  constructor(private readonly io: FakeIo) {}

  setPermission(next: PermissionState) {
    if (this.permission === next) return;
    this.permission = next;
    this.permissionVersion += 1;
  }

  subscribePress(): () => void {
    this.pressSubscriptions += 1;
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      this.pressUnsubscriptions += 1;
    };
  }

  readonly scheduler: SchedulerPort = {
    permissionState: () => {
      const version = this.permissionVersion;
      return this.io
        .defer('perm.read', () => this.permission)
        .then(
          state => {
            this.settledPermissionReads.push({ version, ok: true });
            return state;
          },
          error => {
            this.settledPermissionReads.push({ version, ok: false });
            throw error;
          },
        );
    },
    requestPermission: () => {
      const version = this.permissionVersion;
      return this.io
        .defer('perm.request', () => {
          if (this.permission === 'undetermined') {
            this.permission = this.requestOutcome;
          }
          return this.permission;
        })
        .then(
          state => {
            this.settledPermissionReads.push({ version, ok: true });
            return state;
          },
          error => {
            this.settledPermissionReads.push({ version, ok: false });
            throw error;
          },
        );
    },
    applyPlan: plan =>
      this.io.defer('os.apply', () => {
        this.applyCalls += 1;
        this.planned.clear();
        for (const item of plan) this.planned.set(item.id, item);
      }),
    cancelAllPlanned: () =>
      this.io
        .defer('os.cancel', () => {
          this.cancelCalls += 1;
          this.planned.clear();
        })
        .then(
          () => {
            this.lastCancel = 'ok';
          },
          (error: unknown) => {
            this.lastCancel = 'fault';
            throw error;
          },
        ),
    openSystemSettings: () =>
      this.io.defer('os.openSettings', () => {
        this.openSettingsCalls += 1;
      }),
  };
}

const mockWorld: { io: FakeIo; os: FakeOs } = (() => {
  const io = new FakeIo();
  return { io, os: new FakeOs(io) };
})();

function resetWorld(rng: () => number, pImmediate: number) {
  const io = new FakeIo();
  io.rng = rng;
  io.pImmediate = pImmediate;
  mockWorld.io = io;
  mockWorld.os = new FakeOs(io);
}

// ─── AppState + console capture ──────────────────────────────────────────────

type AppStateHandler = (state: string) => void;
const appStateListeners = new Set<AppStateHandler>();
let appStateSubscribed = 0;
let appStateRemoved = 0;

const consoleErrors: string[] = [];

beforeAll(() => {
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    type: string,
    handler: AppStateHandler,
  ) => {
    if (type !== 'change') return { remove: () => {} };
    appStateSubscribed += 1;
    appStateListeners.add(handler);
    return {
      remove: () => {
        if (appStateListeners.delete(handler)) appStateRemoved += 1;
      },
    };
  }) as unknown as typeof AppState.addEventListener);
  jest.spyOn(Date, 'now').mockImplementation(() => FIXED_NOW_MS);
  jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args.map(a => String(a)).join(' '));
  });
});

afterAll(() => {
  jest.restoreAllMocks();
});

function emitAppState(state: 'active' | 'background' | 'inactive') {
  for (const handler of Array.from(appStateListeners)) handler(state);
}

// ─── Harness shell (the App.tsx composition around the navigator) ────────────

const control: {
  setOwner: ((owner: string | null) => void) | null;
  setNavMounted: ((mounted: boolean) => void) | null;
} = { setOwner: null, setNavMounted: null };

function Shell(props: { initialOwner: string; initialNavMounted: boolean }) {
  const [owner, setOwner] = useState<string | null>(props.initialOwner);
  const [navMounted, setNavMounted] = useState(props.initialNavMounted);
  control.setOwner = setOwner;
  control.setNavMounted = setNavMounted;
  useNotificationBootstrap(owner);
  return navMounted ? (
    <RootNavigator />
  ) : (
    <Text testID="gate-loading">Loading your account</Text>
  );
}

const queryClient = new QueryClient();

function AppShell(props: { initialOwner: string; initialNavMounted: boolean }) {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <Shell
          initialOwner={props.initialOwner}
          initialNavMounted={props.initialNavMounted}
        />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

// ─── Store reset (process death) ─────────────────────────────────────────────

const PRISTINE_STORE = { ...useNotificationStore.getState() };

function resetStoreLikeProcessDeath() {
  useNotificationStore.setState({ ...PRISTINE_STORE }, true);
}

// ─── Tree queries ────────────────────────────────────────────────────────────

type Renderer = TestRenderer.ReactTestRenderer;
type Node = TestRenderer.ReactTestInstance;

function pressableByLabel(renderer: Renderer, label: string): Node | null {
  const matches = renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
  return (
    matches.find(node => node.props.accessibilityRole !== undefined) ??
    matches[0] ??
    null
  );
}

function toggles(renderer: Renderer): Node[] {
  return renderer.root.findAllByType(BrandToggle);
}

function toggleByLabel(renderer: Renderer, label: string): Node | null {
  return toggles(renderer).find(node => node.props.label === label) ?? null;
}

function screenMounted(renderer: Renderer): boolean {
  return renderer.root.findAllByType(NotificationSettingsScreen).length > 0;
}

function textPresent(renderer: Renderer, needle: string): boolean {
  return renderer.root
    .findAllByType(Text)
    .some(node =>
      String(
        Array.isArray(node.props.children)
          ? node.props.children.join('')
          : node.props.children,
      ).includes(needle),
    );
}

async function flush() {
  await act(async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
  });
}

// ─── Scenario model ──────────────────────────────────────────────────────────

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';
const OWNER_C = '33333333-3333-4333-8333-333333333333';
const OWNERS = [OWNER_A, OWNER_B, OWNER_C, GUEST_DATA_OWNER] as const;

const TOGGLE_LABELS = [
  'All reminders',
  'Practice nudge',
  'Streak defense',
  'Weekly recap',
  'Welcome back',
] as const;
const PRESET_LABELS = [
  'Morning, 7:00 AM',
  'Midday, 12:00 PM',
  'Evening, 5:30 PM',
  'Night, 8:30 PM',
] as const;

type Op =
  | { op: 'open_screen' }
  | { op: 'back' }
  | { op: 'tap_turn_on'; times: 1 | 2 }
  | { op: 'flip'; label: (typeof TOGGLE_LABELS)[number] }
  | { op: 'preset'; label: (typeof PRESET_LABELS)[number] }
  | { op: 'step'; direction: -1 | 1 }
  | { op: 'tap_check_again' }
  | { op: 'tap_open_settings' }
  | { op: 'background' }
  | { op: 'foreground' }
  | { op: 'permission'; to: PermissionState }
  | { op: 'switch_account'; to: string; remountAfter: number; lifo: boolean }
  | { op: 'sign_out'; remountAfter: number; lifo: boolean }
  | { op: 'kill_relaunch'; drainBeforeKill: number; lifo: boolean }
  | { op: 'settle'; index: number }
  | { op: 'settle_all' }
  | { op: 'fault'; kind: IoKind; count: number }
  | { op: 'idle' };

interface Violation {
  at: number;
  op: string;
  invariant: string;
  detail: string;
}

/**
 * Invariants whose violation is a reportable finding but a KNOWN, timing- or
 * fault-bounded property of the current store design. They are recorded in
 * the JSON table and counted, and fail the suite only with STRESS_STRICT=1
 * so the campaign can live in the normal run while the findings stand:
 *   - no-previous-owner-state-rendered: hydrate() leaves the previous
 *     owner's prefs/ownerKey in the store until the new owner's kv read
 *     resolves; a screen mounted inside that window renders them.
 *   - previous-owner-prefs-written-to-new-owner: a toggle/preset tap inside
 *     that same window runs setPrefs(), which spreads the PREVIOUS owner's
 *     prefs and persists them under the NEW owner's key (cross-account copy
 *     of preference data; the user's own change is then reverted in memory
 *     when the pending hydrate read lands).
 *   - durable-prefs-dropped-after-read-fault: a failed kv read on hydrate
 *     falls back to defaults (by design), which cancels the OS schedule and
 *     shows the opt-in card over durable "enabled" prefs for that run.
 *   - prefs-lost-to-inflight-hydrate: hydrate() captures `prefs` before its
 *     awaits and sets it unconditionally afterwards, so a setPrefs that
 *     landed in between is reverted in memory (durable keeps it) and its
 *     schedule is cancelled by hydrate's trailing syncNow.
 *   - schedule-survives-swallowed-cancel-fault: hydrate() for the signed-out
 *     owner does `cancelAllPlanned().catch(() => {})` and then reports
 *     scheduleFailed=false, so when that one bridge call fails the previous
 *     user's reminders stay in the notification center (until the next
 *     foreground sync cancels them) with nothing flagged in the store.
 *   - os-schedule-stale-after-overlapping-syncs: syncNow() builds its plan
 *     from prefs captured before `await loadContext()` and applies it without
 *     re-checking, so of two overlapping syncs the one that settles last
 *     wins even when it is the older one (self-heals on next foreground).
 */
const SOFT_INVARIANTS = new Set<string>([
  'no-previous-owner-state-rendered',
  'previous-owner-prefs-written-to-new-owner',
  'durable-prefs-dropped-after-read-fault',
  'prefs-lost-to-inflight-hydrate',
  'os-schedule-stale-after-overlapping-syncs',
  'schedule-survives-swallowed-cancel-fault',
]);
const STRICT = process.env.STRESS_STRICT === '1';

interface ScenarioResult {
  seed: number;
  outcome: 'HELD' | 'BROKEN' | 'SOFT';
  ops: number;
  opsExecuted: number;
  reorderedSettles: number;
  overlappingSyncs: number;
  ioIssued: number;
  ioSettled: number;
  faultsArmed: number;
  screenOpens: number;
  taps: number;
  appStateEvents: number;
  permissionChanges: number;
  kills: number;
  accountSwitches: number;
  violations: Violation[];
  schedule: Op[];
  /** Per-op trace, recorded only for single-seed replays (STRESS_SEED). */
  trace: string[];
  finalState: {
    owner: string;
    storeOwner: string | null;
    permission: string;
    osPermission: string;
    prefs: NotificationPrefs;
    persisted: NotificationPrefs | null;
    plannedIds: string[];
    persistFailed: boolean;
    scheduleFailed: boolean;
  };
}

function initialPrefsFor(rng: () => number): NotificationPrefs | null {
  if (chance(rng, 0.3)) return null;
  return {
    ...DEFAULT_NOTIFICATION_PREFS,
    enabled: chance(rng, 0.6),
    practiceReminder: chance(rng, 0.8),
    practiceReminderMinutes: pick(rng, [420, 720, 1050, 1230, 0, 1410]),
    streakDefense: chance(rng, 0.7),
    weeklyRecap: chance(rng, 0.7),
    comeback: chance(rng, 0.7),
    promptDismissed: chance(rng, 0.7),
  };
}

function buildSchedule(rng: () => number, length: number): Op[] {
  const ops: Op[] = [];
  for (let i = 0; i < length; i += 1) {
    const roll = rng();
    if (roll < 0.14) ops.push({ op: 'open_screen' });
    else if (roll < 0.22) ops.push({ op: 'back' });
    else if (roll < 0.3)
      ops.push({ op: 'tap_turn_on', times: chance(rng, 0.3) ? 2 : 1 });
    else if (roll < 0.4)
      ops.push({ op: 'flip', label: pick(rng, TOGGLE_LABELS) });
    else if (roll < 0.44)
      ops.push({ op: 'preset', label: pick(rng, PRESET_LABELS) });
    else if (roll < 0.47)
      ops.push({ op: 'step', direction: chance(rng, 0.5) ? -1 : 1 });
    else if (roll < 0.49) ops.push({ op: 'tap_check_again' });
    else if (roll < 0.51) ops.push({ op: 'tap_open_settings' });
    else if (roll < 0.56) ops.push({ op: 'background' });
    else if (roll < 0.62) ops.push({ op: 'foreground' });
    else if (roll < 0.68)
      ops.push({
        op: 'permission',
        to: pick(rng, ['granted', 'denied', 'undetermined'] as const),
      });
    else if (roll < 0.73)
      ops.push({
        op: 'switch_account',
        to: pick(rng, OWNERS),
        remountAfter: Math.floor(rng() * 4),
        lifo: chance(rng, 0.4),
      });
    else if (roll < 0.75)
      ops.push({
        op: 'sign_out',
        remountAfter: Math.floor(rng() * 3),
        lifo: chance(rng, 0.4),
      });
    else if (roll < 0.8)
      ops.push({
        op: 'kill_relaunch',
        drainBeforeKill: Math.floor(rng() * 3),
        lifo: chance(rng, 0.4),
      });
    else if (roll < 0.9)
      ops.push({ op: 'settle', index: Math.floor(rng() * 4) });
    else if (roll < 0.93) ops.push({ op: 'settle_all' });
    else if (roll < 0.98)
      ops.push({
        op: 'fault',
        kind: pick(rng, [
          'kv.get',
          'kv.set',
          'perm.read',
          'perm.request',
          'os.apply',
          'os.cancel',
          'os.openSettings',
          'consistency',
        ] as const),
        count: 1 + Math.floor(rng() * 2),
      });
    else ops.push({ op: 'idle' });
  }
  return ops;
}

// ─── Oracle ──────────────────────────────────────────────────────────────────

function expectedPlanIds(prefs: NotificationPrefs): string[] {
  return buildNotificationPlan(prefs, {
    nowMs: FIXED_NOW_MS,
    streakDays: CONSISTENCY_SNAPSHOT.currentStreak,
    practicedToday: CONSISTENCY_SNAPSHOT.trainedToday,
    hasAnyHistory: CONSISTENCY_SNAPSHOT.totalActivities > 0,
    shieldsAvailable: CONSISTENCY_SNAPSHOT.shieldsAvailable,
    milestoneEve: null,
  })
    .map(item => item.id)
    .sort();
}

function persistedPrefs(owner: string): NotificationPrefs | null {
  const raw = mockWorld.io.kv.get(notificationPrefsKeyForOwner(owner));
  return raw === undefined ? null : parseNotificationPrefs(raw);
}

/** Checks that must hold after EVERY op (not only at quiescence). */
function checkAlways(
  renderer: Renderer,
  violations: Violation[],
  at: number,
  op: string,
) {
  const state = useNotificationStore.getState();
  const owner = getActiveDataOwner();

  if (consoleErrors.length > 0) {
    violations.push({
      at,
      op,
      invariant: 'no-console-error',
      detail: consoleErrors.splice(0).join(' | ').slice(0, 600),
    });
  }

  if (screenMounted(renderer)) {
    // A screen for owner X must never show prefs the store still holds for
    // a previous owner.
    if (state.ownerKey !== null && state.ownerKey !== owner) {
      violations.push({
        at,
        op,
        invariant: 'no-previous-owner-state-rendered',
        detail: `screen mounted for ${owner} while store.ownerKey=${state.ownerKey} (hydrated=${state.hydrated}, enabled=${state.prefs.enabled})`,
      });
    }
    // Rendered controls mirror the store synchronously.
    for (const label of TOGGLE_LABELS) {
      const toggle = toggleByLabel(renderer, label);
      if (!toggle) continue;
      const key = TOGGLE_TO_PREF[label];
      if (toggle.props.value !== state.prefs[key]) {
        violations.push({
          at,
          op,
          invariant: 'ui-mirrors-store',
          detail: `${label} shows ${String(toggle.props.value)} but prefs.${key}=${String(state.prefs[key])}`,
        });
      }
    }
    if (state.prefs.enabled && state.permission !== 'denied') {
      const label = `Reminder time ${formatReminderMinutes(
        state.prefs.practiceReminderMinutes,
      )}`;
      const shown = renderer.root.findAll(
        node => node.props.accessibilityLabel === label,
      );
      if (shown.length === 0) {
        violations.push({
          at,
          op,
          invariant: 'ui-mirrors-store',
          detail: `reminder time label "${label}" not rendered`,
        });
      }
    }
    const deniedCard = textPresent(
      renderer,
      'Notifications are off in system settings',
    );
    if (deniedCard !== (state.permission === 'denied')) {
      violations.push({
        at,
        op,
        invariant: 'ui-mirrors-store',
        detail: `denied card=${String(deniedCard)} but permission=${state.permission}`,
      });
    }
    const optIn = pressableByLabel(renderer, 'Turn on reminders');
    const optInExpected = !state.prefs.enabled && state.permission !== 'denied';
    if ((optIn !== null) !== optInExpected) {
      violations.push({
        at,
        op,
        invariant: 'ui-mirrors-store',
        detail: `opt-in card=${String(optIn !== null)} but enabled=${String(state.prefs.enabled)} permission=${state.permission}`,
      });
    }
  }
}

const TOGGLE_TO_PREF: Record<
  (typeof TOGGLE_LABELS)[number],
  keyof NotificationPrefs
> = {
  'All reminders': 'enabled',
  'Practice nudge': 'practiceReminder',
  'Streak defense': 'streakDefense',
  'Weekly recap': 'weeklyRecap',
  'Welcome back': 'comeback',
};

/** Checks that must hold once every deferred call has settled. */
function checkQuiescent(
  renderer: Renderer,
  violations: Violation[],
  at: number,
  op: string,
  navMounted: boolean,
  tapWhileHydrating: boolean,
  refreshExpectedFrom: number | null,
) {
  const state = useNotificationStore.getState();
  const owner = getActiveDataOwner();
  const os = mockWorld.os;

  if (mockWorld.io.pending.length !== 0) {
    violations.push({
      at,
      op,
      invariant: 'quiescent',
      detail: `${mockWorld.io.pending.length} calls still pending after drain`,
    });
  }

  // Hydrated for the active owner.
  if (!state.hydrated || state.ownerKey !== owner) {
    violations.push({
      at,
      op,
      invariant: 'hydrated-for-active-owner',
      detail: `hydrated=${String(state.hydrated)} ownerKey=${state.ownerKey} owner=${owner}`,
    });
  }

  // In-memory prefs match the durable copy for this owner (unless the last
  // write failed and the screen says so).
  const durable = persistedPrefs(owner);
  if (owner === SIGNED_OUT_DATA_OWNER) {
    if (
      JSON.stringify(state.prefs) !== JSON.stringify(DEFAULT_NOTIFICATION_PREFS)
    ) {
      violations.push({
        at,
        op,
        invariant: 'signed-out-defaults',
        detail: `signed-out store holds ${JSON.stringify(state.prefs)}`,
      });
    }
  } else if (!state.persistFailed) {
    const expected = durable ?? { ...DEFAULT_NOTIFICATION_PREFS };
    if (JSON.stringify(state.prefs) !== JSON.stringify(expected)) {
      violations.push({
        at,
        op,
        invariant:
          mockWorld.io.fired['kv.get'] > 0
            ? 'durable-prefs-dropped-after-read-fault'
            : tapWhileHydrating
              ? 'prefs-lost-to-inflight-hydrate'
              : 'prefs-match-durable',
        detail: `store=${JSON.stringify(state.prefs)} durable=${JSON.stringify(durable)} (kv.get faults fired=${mockWorld.io.fired['kv.get']}, tapWhileHydrating=${String(tapWhileHydrating)})`,
      });
    }
  }

  // Focus (useFocusEffect) and foreground (bootstrap AppState listener) must
  // each re-read permission, so a change made in system settings is seen.
  if (
    refreshExpectedFrom !== null &&
    !os.settledPermissionReads.some(read => read.version >= refreshExpectedFrom)
  ) {
    violations.push({
      at,
      op,
      invariant: 'permission-reread-on-focus-or-foreground',
      detail: `no permission read since version ${refreshExpectedFrom} (reads=${JSON.stringify(os.settledPermissionReads)})`,
    });
  }

  // Permission truth: a successful read issued after the last system-settings
  // change must leave the store agreeing with the OS.
  const freshOk = os.settledPermissionReads.some(
    read => read.ok && read.version === os.permissionVersion,
  );
  if (freshOk && os.settledPermissionReads.length > 0) {
    const last =
      os.settledPermissionReads[os.settledPermissionReads.length - 1]!;
    if (last.ok && last.version === os.permissionVersion) {
      if (state.permission !== os.permission) {
        violations.push({
          at,
          op,
          invariant: 'permission-matches-os',
          detail: `store.permission=${state.permission} os=${os.permission}`,
        });
      }
    }
  }

  // Schedule truth (OS notification center).
  const plannedIds = Array.from(os.planned.keys()).sort();
  if (!state.scheduleFailed) {
    const shouldHavePlan =
      owner !== SIGNED_OUT_DATA_OWNER &&
      state.ownerKey === owner &&
      state.prefs.enabled &&
      state.permission === 'granted';
    const expected = shouldHavePlan ? expectedPlanIds(state.prefs) : [];
    if (JSON.stringify(plannedIds) !== JSON.stringify(expected)) {
      violations.push({
        at,
        op,
        invariant:
          expected.length === 0 && os.lastCancel === 'fault'
            ? 'schedule-survives-swallowed-cancel-fault'
            : mockWorld.io.overlappingSyncs > 0
              ? 'os-schedule-stale-after-overlapping-syncs'
              : 'os-schedule-matches-prefs',
        detail: `planned=${JSON.stringify(plannedIds)} expected=${JSON.stringify(expected)} (enabled=${String(state.prefs.enabled)} permission=${state.permission} owner=${owner} overlappingSyncs=${mockWorld.io.overlappingSyncs})`,
      });
    }
  }
  if (
    (owner === SIGNED_OUT_DATA_OWNER || state.permission === 'denied') &&
    plannedIds.length > 0 &&
    !state.scheduleFailed
  ) {
    violations.push({
      at,
      op,
      invariant:
        os.lastCancel === 'fault'
          ? 'schedule-survives-swallowed-cancel-fault'
          : 'nothing-scheduled-when-not-allowed',
      detail: `planned=${JSON.stringify(plannedIds)} owner=${owner} permission=${state.permission}`,
    });
  }

  // Screen state at rest: no request in flight, so the opt-in CTA is enabled.
  if (navMounted && screenMounted(renderer)) {
    const optIn = pressableByLabel(renderer, 'Turn on reminders');
    if (optIn && optIn.props.disabled === true) {
      violations.push({
        at,
        op,
        invariant: 'cta-re-enabled-at-rest',
        detail: 'Turn on reminders stays disabled with nothing in flight',
      });
    }
  }
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function drainAll(limit = 400) {
  let guard = 0;
  await flush();
  while (mockWorld.io.pending.length > 0 && guard < limit) {
    mockWorld.io.settleOne(0);
    await flush();
    guard += 1;
  }
  await flush();
}

async function runScenario(
  seed: number,
  scheduleOverride?: Op[],
): Promise<ScenarioResult> {
  const rng = mulberry32(seed);
  const pImmediate = pick(rng, [0.0, 0.25, 0.5, 0.75, 1.0]);
  resetWorld(mulberry32(seed ^ 0x9e3779b9), pImmediate);
  resetStoreLikeProcessDeath();
  consoleErrors.length = 0;
  appStateListeners.clear();
  // jest.fn() mocks (react-native's NativeAnimatedModule etc.) record every
  // call's arguments, which pins each mounted navigator's animation closures
  // and fibers forever; drop that recording so the heap samples measure the
  // app, not the mock registry. Implementations are kept.
  jest.clearAllMocks();

  const io = mockWorld.io;
  const os = mockWorld.os;
  os.permission = pick(rng, ['undetermined', 'granted', 'denied'] as const);
  os.requestOutcome = chance(rng, 0.75) ? 'granted' : 'denied';

  // Durable state left by earlier runs of the app (any owner may have some).
  for (const owner of OWNERS) {
    const prefs = initialPrefsFor(rng);
    if (prefs)
      io.kv.set(notificationPrefsKeyForOwner(owner), JSON.stringify(prefs));
  }
  let owner: string = pick(rng, OWNERS);
  setActiveDataOwner(owner);

  const generated = buildSchedule(rng, 10 + Math.floor(rng() * 21));
  const schedule = scheduleOverride ?? generated;
  const violations: Violation[] = [];
  let reorderedSettles = 0;
  let faultsArmed = 0;
  let screenOpens = 0;
  let taps = 0;
  let appStateEvents = 0;
  let permissionChanges = 0;
  let kills = 0;
  let accountSwitches = 0;
  let navMounted = true;
  /** iOS app state. A user cannot touch a backgrounded app, and system
   *  settings can only change while the app is not in the foreground. */
  let appActive = true;
  let opsExecuted = 0;
  const trace: string[] = [];
  const traceLine = (label: string) => {
    if (process.env.STRESS_SEED === undefined) return;
    const st = useNotificationStore.getState();
    trace.push(
      `${label} | io=[${io.events.splice(0).join(' ')}] | owner=${getActiveDataOwner()} store.owner=${st.ownerKey} hydrated=${String(st.hydrated)} enabled=${String(st.prefs.enabled)} min=${st.prefs.practiceReminderMinutes} perm=${st.permission} os.perm=${os.permission} planned=${os.planned.size} pending=[${io.pending.map(p => p.kind).join(',')}] screen=${String(navMounted && screenMounted(renderer))} active=${String(appActive)}`,
    );
  };

  let renderer!: Renderer;
  const relaunch = async () => {
    // A signed-out process lands on Welcome, never the navigator; the
    // bootstrap hydrates the (signed-out) store underneath either way.
    navMounted = owner !== SIGNED_OUT_DATA_OWNER;
    await act(async () => {
      renderer = TestRenderer.create(
        <AppShell initialOwner={owner} initialNavMounted={navMounted} />,
      );
    });
    await flush();
  };
  await relaunch();

  let tapWhileHydrating = false;
  /** permissionVersion at the last focus/foreground the live process saw;
   *  a permission read must have been issued at or after it. */
  let refreshExpectedFrom: number | null = null;
  const noteTap = () => {
    if (io.pending.some(p => p.kind === 'kv.get')) tapWhileHydrating = true;
  };
  // setPrefs() spreads whatever `prefs` the store holds at tap time. If the
  // store still holds a PREVIOUS owner's prefs (new owner's hydrate not
  // settled), every field that differs from the new owner's durable copy is
  // copied across accounts and persisted under the new owner's key.
  const guardedPrefsTap = async (
    at: number,
    op: string,
    patched: readonly (keyof NotificationPrefs)[],
    tap: () => Promise<void>,
  ) => {
    const before = useNotificationStore.getState();
    const activeOwner = getActiveDataOwner();
    const durable = persistedPrefs(activeOwner) ?? {
      ...DEFAULT_NOTIFICATION_PREFS,
    };
    await tap();
    const after = useNotificationStore.getState();
    if (
      before.ownerKey === null ||
      before.ownerKey === activeOwner ||
      after.ownerKey !== activeOwner ||
      activeOwner === SIGNED_OUT_DATA_OWNER
    )
      return;
    const leaked = (Object.keys(before.prefs) as (keyof NotificationPrefs)[])
      .filter(f => f !== 'version' && !patched.includes(f))
      .filter(
        f =>
          before.prefs[f] !== durable[f] && after.prefs[f] === before.prefs[f],
      );
    if (leaked.length > 0) {
      violations.push({
        at,
        op,
        invariant: 'previous-owner-prefs-written-to-new-owner',
        detail: `tap for ${activeOwner} spread prefs of ${before.ownerKey}: fields ${JSON.stringify(leaked)} store=${JSON.stringify(after.prefs)} durable-before=${JSON.stringify(durable)}`,
      });
    }
  };
  // Settle up to `n` deferred calls; LIFO lets the NEWEST owner's I/O land
  // before the previous owner's still-pending reads (stale-read ordering).
  const settleSome = async (n: number, lifo: boolean) => {
    for (let i = 0; i < n && io.pending.length > 0; i += 1) {
      const index = lifo ? io.pending.length - 1 : 0;
      if (index !== 0) reorderedSettles += 1;
      io.settleOne(index);
      await flush();
    }
  };
  const canInteract = () => appActive && navMounted && screenMounted(renderer);
  const press = async (node: Node | null) => {
    if (!node || node.props.disabled === true) return false;
    taps += 1;
    noteTap();
    await act(async () => {
      node.props.onPress();
    });
    await flush();
    return true;
  };

  for (let at = 0; at < schedule.length; at += 1) {
    const step = schedule[at]!;
    opsExecuted += 1;
    switch (step.op) {
      case 'open_screen': {
        if (appActive && navMounted && !screenMounted(renderer)) {
          if (
            await press(
              pressableByLabel(renderer, 'Open notification settings'),
            )
          ) {
            screenOpens += 1;
            refreshExpectedFrom = os.permissionVersion;
          }
        }
        break;
      }
      case 'back': {
        if (canInteract()) await press(pressableByLabel(renderer, 'Back'));
        break;
      }
      case 'tap_turn_on': {
        if (canInteract()) {
          const node = pressableByLabel(renderer, 'Turn on reminders');
          if (node && node.props.disabled !== true) {
            taps += step.times;
            noteTap();
            await act(async () => {
              node.props.onPress();
              if (step.times === 2) node.props.onPress();
            });
            await flush();
          }
        }
        break;
      }
      case 'flip': {
        if (canInteract()) {
          const toggle = toggleByLabel(renderer, step.label);
          if (toggle && toggle.props.disabled !== true) {
            taps += 1;
            noteTap();
            await guardedPrefsTap(
              at,
              step.op,
              [TOGGLE_TO_PREF[step.label], 'promptDismissed'],
              async () => {
                await act(async () => {
                  toggle.props.onValueChange(!toggle.props.value);
                });
                await flush();
              },
            );
          }
        }
        break;
      }
      case 'preset': {
        if (canInteract())
          await guardedPrefsTap(
            at,
            step.op,
            ['practiceReminderMinutes', 'promptDismissed'],
            async () => {
              await press(pressableByLabel(renderer, step.label));
            },
          );
        break;
      }
      case 'step': {
        if (canInteract())
          await guardedPrefsTap(
            at,
            step.op,
            ['practiceReminderMinutes', 'promptDismissed'],
            async () => {
              await press(
                pressableByLabel(
                  renderer,
                  step.direction < 0
                    ? 'Reminder 30 minutes earlier'
                    : 'Reminder 30 minutes later',
                ),
              );
            },
          );
        break;
      }
      case 'tap_check_again': {
        if (canInteract())
          await press(pressableByLabel(renderer, 'Check again'));
        break;
      }
      case 'tap_open_settings': {
        if (canInteract())
          await press(pressableByLabel(renderer, 'Open system settings'));
        break;
      }
      case 'background': {
        if (!appActive) break;
        appActive = false;
        appStateEvents += 1;
        await act(async () => emitAppState('background'));
        await flush();
        break;
      }
      case 'foreground': {
        if (appActive) break;
        appActive = true;
        appStateEvents += 1;
        refreshExpectedFrom = os.permissionVersion;
        await act(async () => emitAppState('active'));
        await flush();
        break;
      }
      case 'permission': {
        // Changed in Settings.app: the app is in the background meanwhile.
        if (appActive) {
          appActive = false;
          appStateEvents += 1;
          await act(async () => emitAppState('background'));
          await flush();
        }
        if (os.permission !== step.to) permissionChanges += 1;
        os.setPermission(step.to);
        break;
      }
      case 'switch_account': {
        if (step.to === owner || !appActive) break;
        accountSwitches += 1;
        owner = step.to;
        // authStore flips the owner synchronously; the Gate re-renders with
        // the navigator gone until the app store hydrates for the new owner.
        await act(async () => {
          setActiveDataOwner(owner);
          control.setNavMounted?.(false);
          control.setOwner?.(owner);
        });
        navMounted = false;
        await flush();
        await settleSome(step.remountAfter, step.lifo);
        await act(async () => control.setNavMounted?.(true));
        navMounted = true;
        await flush();
        break;
      }
      case 'sign_out': {
        if (owner === SIGNED_OUT_DATA_OWNER || !appActive) break;
        accountSwitches += 1;
        owner = SIGNED_OUT_DATA_OWNER;
        await act(async () => {
          setActiveDataOwner(owner);
          control.setNavMounted?.(false);
          control.setOwner?.(owner);
        });
        navMounted = false;
        await flush();
        await settleSome(step.remountAfter, step.lifo);
        // A signed-out process shows Welcome, never the navigator — the
        // bootstrap keeps running underneath either way.
        break;
      }
      case 'kill_relaunch': {
        kills += 1;
        await settleSome(step.drainBeforeKill, step.lifo);
        await act(async () => renderer.unmount());
        // In-flight bridge calls die with the process; durable kv + OS state
        // survive. What the dead process learned about permission does not.
        io.pending.length = 0;
        os.settledPermissionReads = [];
        refreshExpectedFrom = null;
        if (appStateListeners.size !== 0) {
          violations.push({
            at,
            op: step.op,
            invariant: 'no-leaked-appstate-listeners',
            detail: `${appStateListeners.size} AppState listener(s) survive unmount`,
          });
          appStateListeners.clear();
        }
        if (os.pressSubscriptions !== os.pressUnsubscriptions) {
          violations.push({
            at,
            op: step.op,
            invariant: 'no-leaked-press-subscriptions',
            detail: `${os.pressSubscriptions} subscribed vs ${os.pressUnsubscriptions} unsubscribed`,
          });
        }
        resetStoreLikeProcessDeath();
        appActive = true;
        await relaunch();
        break;
      }
      case 'settle': {
        if (io.pending.length > 0) {
          const index = Math.min(step.index, io.pending.length - 1);
          if (index !== 0) reorderedSettles += 1;
          io.settleOne(index);
          await flush();
        }
        break;
      }
      case 'settle_all': {
        await drainAll();
        break;
      }
      case 'fault': {
        io.faults[step.kind] += step.count;
        faultsArmed += step.count;
        break;
      }
      case 'idle': {
        await flush();
        break;
      }
    }
    traceLine(`${at}:${JSON.stringify(step)}`);
    checkAlways(renderer, violations, at, step.op);
  }

  // Quiescence: settle everything, clear any armed faults (they only bite
  // on the NEXT call — a fault that never fired is just unused), check.
  for (const kind of Object.keys(io.faults) as IoKind[]) io.faults[kind] = 0;
  await drainAll();
  if (!appActive) {
    appActive = true;
    refreshExpectedFrom = os.permissionVersion;
    await act(async () => emitAppState('active'));
    await drainAll();
  }
  if (io.fired.consistency > 0) {
    // A failed history read degrades that sync to fact-free reminders by
    // design; the next foreground re-syncs with facts, so give it one.
    await act(async () => emitAppState('active'));
    await drainAll();
  }
  if (owner !== SIGNED_OUT_DATA_OWNER && !navMounted) {
    await act(async () => control.setNavMounted?.(true));
    navMounted = true;
    await flush();
  }
  traceLine('drain');
  checkAlways(renderer, violations, schedule.length, 'drain');
  checkQuiescent(
    renderer,
    violations,
    schedule.length,
    'drain',
    navMounted,
    tapWhileHydrating,
    refreshExpectedFrom,
  );

  // Idempotent re-hydrate: hydrate ∘ hydrate == hydrate. The first
  // re-hydrate may legitimately absorb world changes the process never
  // observed (a permission flipped in system settings after the last read);
  // the second must change nothing.
  const snapshot = () => ({
    store: JSON.stringify({
      ...useNotificationStore.getState(),
      hydrate: 0,
      refreshPermission: 0,
      requestPermissionAndEnable: 0,
      completeOnboardingStep: 0,
      setPrefs: 0,
      dismissPrompt: 0,
      syncNow: 0,
    }),
    kv: JSON.stringify(Array.from(io.kv.entries()).sort()),
    planned: JSON.stringify(Array.from(os.planned.keys()).sort()),
  });
  await act(async () => {
    void useNotificationStore.getState().hydrate({ expectedOwnerKey: owner });
  });
  await drainAll();
  const first = snapshot();
  await act(async () => {
    void useNotificationStore.getState().hydrate({ expectedOwnerKey: owner });
  });
  await drainAll();
  const second = snapshot();
  for (const key of ['store', 'kv', 'planned'] as const) {
    if (first[key] !== second[key]) {
      violations.push({
        at: schedule.length + 1,
        op: 'rehydrate',
        invariant: `idempotent-rehydrate-${key}`,
        detail: `first=${first[key]} second=${second[key]}`.slice(0, 800),
      });
    }
  }
  checkAlways(renderer, violations, schedule.length + 1, 'rehydrate');

  // Final teardown = process exit: nothing may survive.
  await act(async () => renderer.unmount());
  await flush();
  if (appStateListeners.size !== 0) {
    violations.push({
      at: schedule.length + 2,
      op: 'teardown',
      invariant: 'no-leaked-appstate-listeners',
      detail: `${appStateListeners.size} AppState listener(s) survive unmount`,
    });
    appStateListeners.clear();
  }
  if (os.pressSubscriptions !== os.pressUnsubscriptions) {
    violations.push({
      at: schedule.length + 2,
      op: 'teardown',
      invariant: 'no-leaked-press-subscriptions',
      detail: `${os.pressSubscriptions} subscribed vs ${os.pressUnsubscriptions} unsubscribed`,
    });
  }
  // Late settles after unmount must not throw or log.
  await drainAll();
  if (consoleErrors.length > 0) {
    violations.push({
      at: schedule.length + 2,
      op: 'teardown',
      invariant: 'no-console-error',
      detail: consoleErrors.splice(0).join(' | ').slice(0, 600),
    });
  }

  const state = useNotificationStore.getState();
  return {
    seed,
    outcome:
      violations.length === 0
        ? 'HELD'
        : violations.every(v => SOFT_INVARIANTS.has(v.invariant))
          ? 'SOFT'
          : 'BROKEN',
    ops: schedule.length,
    opsExecuted,
    reorderedSettles,
    overlappingSyncs: io.overlappingSyncs,
    ioIssued: io.issued,
    ioSettled: io.settled,
    faultsArmed,
    screenOpens,
    taps,
    appStateEvents,
    permissionChanges,
    kills,
    accountSwitches,
    violations,
    schedule,
    trace,
    finalState: {
      owner,
      storeOwner: state.ownerKey,
      permission: state.permission,
      osPermission: os.permission,
      prefs: state.prefs,
      persisted: persistedPrefs(owner),
      plannedIds: Array.from(os.planned.keys()).sort(),
      persistFailed: state.persistFailed,
      scheduleFailed: state.scheduleFailed,
    },
  };
}

// ─── Minimised repros ────────────────────────────────────────────────────────

/**
 * Hand-minimised schedules (seed fixes the world: durable prefs per owner,
 * OS permission, deferral pattern). Each reproduces one SOFT invariant 100%
 * deterministically; `expect` lists the invariants they must trip so the
 * repro stays faithful. STRESS_STRICT=1 turns them into hard failures.
 */
const MINIMIZED_REPROS: ReadonlyArray<{
  id: string;
  seed: number;
  schedule: Op[];
  expect: string[];
}> = [
  {
    // Guest → account B while B's hydrate read is pending: B's screen shows
    // the guest's prefs and one toggle tap persists guest prefs under B.
    id: 'switch-account-tap-before-hydrate',
    seed: 2,
    schedule: [
      { op: 'switch_account', to: OWNER_B, remountAfter: 0, lifo: false },
      { op: 'open_screen' },
      { op: 'flip', label: 'Welcome back' },
      { op: 'settle_all' },
    ],
    expect: [
      'no-previous-owner-state-rendered',
      'previous-owner-prefs-written-to-new-owner',
      'prefs-lost-to-inflight-hydrate',
    ],
  },
  {
    // Same-owner: tap "Turn on reminders" while the launch hydrate read is
    // still pending → hydrate lands afterwards and reverts enabled=true.
    id: 'tap-during-launch-hydrate',
    seed: 42,
    schedule: [
      { op: 'open_screen' },
      { op: 'tap_turn_on', times: 1 },
      { op: 'settle_all' },
    ],
    expect: ['prefs-lost-to-inflight-hydrate'],
  },
  {
    // A single failing kv read on hydrate → defaults in memory → the
    // trailing syncNow cancels every OS reminder although durable says on.
    id: 'read-fault-cancels-schedule',
    seed: 1,
    schedule: [
      { op: 'fault', kind: 'kv.get', count: 1 },
      { op: 'kill_relaunch', drainBeforeKill: 0, lifo: false },
      { op: 'settle_all' },
    ],
    expect: ['durable-prefs-dropped-after-read-fault'],
  },
  {
    // "All reminders" off, then "Turn on reminders" straight away: the
    // newer sync's applyPlan lands first, the older sync's cancelAll last →
    // enabled=true, scheduleFailed=false, nothing in the notification center.
    id: 'toggle-off-then-on-older-cancel-lands-last',
    seed: 3,
    schedule: [
      { op: 'permission', to: 'granted' },
      { op: 'foreground' },
      { op: 'open_screen' },
      { op: 'settle_all' },
      { op: 'flip', label: 'All reminders' },
      { op: 'tap_turn_on', times: 1 },
      { op: 'settle', index: 1 },
      { op: 'settle_all' },
    ],
    expect: ['os-schedule-stale-after-overlapping-syncs'],
  },
  {
    // Sign out while the notification-center cancel fails once: hydrate()
    // swallows it, the previous user's reminders stay scheduled and the
    // store says scheduleFailed=false.
    id: 'sign-out-cancel-fault-swallowed',
    seed: 485,
    schedule: [
      { op: 'open_screen' },
      { op: 'permission', to: 'granted' },
      { op: 'foreground' },
      { op: 'settle_all' },
      { op: 'tap_turn_on', times: 1 },
      { op: 'settle_all' },
      { op: 'fault', kind: 'os.cancel', count: 1 },
      { op: 'sign_out', remountAfter: 0, lifo: false },
      { op: 'settle_all' },
    ],
    expect: ['schedule-survives-swallowed-cancel-fault'],
  },
];

// ─── Campaign ────────────────────────────────────────────────────────────────

const OUT_DIR =
  process.env.STRESS_OUT ??
  path.resolve(
    __dirname,
    '../../../../artifacts/stress/scr-notificationsettingsscreen',
  );

const ONLY_SEED =
  process.env.STRESS_SEED !== undefined
    ? Number(process.env.STRESS_SEED)
    : null;
const ITERATIONS =
  ONLY_SEED !== null ? 1 : Number(process.env.STRESS_ITER ?? 120);
// ~50ms per scenario on CI-class hardware; leave ample slack for big campaigns.
const CAMPAIGN_TIMEOUT_MS = Math.max(30_000, ITERATIONS * 250);

describe('stress: NotificationSettingsScreen lifecycle interruptions (real navigator + store)', () => {
  it(
    'holds every lifecycle invariant across the seeded schedule',
    async () => {
      const only = ONLY_SEED;
      // Minimisation aid: replay <seed>'s world with an explicit op list.
      const scheduleOverride =
        only !== null && process.env.STRESS_SCHEDULE !== undefined
          ? (JSON.parse(process.env.STRESS_SCHEDULE) as Op[])
          : undefined;
      const count = ITERATIONS;
      const seeds =
        only !== null ? [only] : Array.from({ length: count }, (_, i) => i);

      // Leak signal: heapUsed after a forced GC (run jest under
      // `node --expose-gc` for exact numbers) sampled every 100 scenarios.
      const forceGc = (globalThis as { gc?: () => void }).gc;
      const sampleHeap = (label: string) => {
        forceGc?.();
        const usage = process.memoryUsage();
        return { label, heapUsed: usage.heapUsed, rss: usage.rss };
      };
      const heapSamples = [sampleHeap('start')];
      const heapBefore = process.memoryUsage();
      const started = new Date().getTime();
      const results: ScenarioResult[] = [];
      for (const seed of seeds) {
        results.push(await runScenario(seed, scheduleOverride));
        if (results.length % 100 === 0)
          heapSamples.push(sampleHeap(`after-${results.length}`));
      }
      heapSamples.push(sampleHeap('end'));
      const wallMs = new Date().getTime() - started;
      const heapAfter = process.memoryUsage();
      // Steady-state retention per scenario, measured from the first sample
      // after warm-up (JIT/module caches settle inside the first 100).
      const steady = heapSamples.filter(h => h.label.startsWith('after-'));
      const heapPerScenarioBytes =
        forceGc !== undefined && steady.length >= 2
          ? (steady[steady.length - 1]!.heapUsed - steady[0]!.heapUsed) /
            ((steady.length - 1) * 100)
          : null;

      const failures = results.filter(r => r.outcome !== 'HELD');
      const hardFailures = results.filter(r =>
        r.violations.some(v => STRICT || !SOFT_INVARIANTS.has(v.invariant)),
      );
      const byInvariant: Record<string, number> = {};
      const seedsByInvariant: Record<string, number[]> = {};
      for (const r of failures)
        for (const v of r.violations) {
          byInvariant[v.invariant] = (byInvariant[v.invariant] ?? 0) + 1;
          const seeds = (seedsByInvariant[v.invariant] ??= []);
          if (!seeds.includes(r.seed)) seeds.push(r.seed);
        }

      fs.mkdirSync(OUT_DIR, { recursive: true });
      const report = {
        unit: 'scr-notificationsettingsscreen',
        lens: 'lifecycle',
        plane:
          'mobile (jest, real RootNavigator + @react-navigation + notificationStore + useNotificationBootstrap; mocked SQLite kv, OS scheduler port, consistency snapshot)',
        node: process.version,
        generatedAt: new Date().toISOString(),
        replay:
          'STRESS_SEED=<seed> npx jest --ci __tests__/stress/notificationSettingsLifecycle.stress.test.tsx',
        seeds: {
          count: results.length,
          first: seeds[0],
          last: seeds[seeds.length - 1],
        },
        wallMs,
        heap: {
          gcForced: forceGc !== undefined,
          heapUsedDeltaBytes: heapAfter.heapUsed - heapBefore.heapUsed,
          rssDeltaBytes: heapAfter.rss - heapBefore.rss,
          heapPerScenarioBytes,
          samples: heapSamples,
        },
        totals: {
          scenarios: results.length,
          ops: results.reduce((s, r) => s + r.opsExecuted, 0),
          ioIssued: results.reduce((s, r) => s + r.ioIssued, 0),
          ioSettled: results.reduce((s, r) => s + r.ioSettled, 0),
          faultsArmed: results.reduce((s, r) => s + r.faultsArmed, 0),
          reorderedSettles: results.reduce((s, r) => s + r.reorderedSettles, 0),
          overlappingSyncs: results.reduce((s, r) => s + r.overlappingSyncs, 0),
          screenOpens: results.reduce((s, r) => s + r.screenOpens, 0),
          taps: results.reduce((s, r) => s + r.taps, 0),
          appStateEvents: results.reduce((s, r) => s + r.appStateEvents, 0),
          permissionChanges: results.reduce(
            (s, r) => s + r.permissionChanges,
            0,
          ),
          kills: results.reduce((s, r) => s + r.kills, 0),
          // AppState 'change' subscriptions across the whole campaign; every
          // one must have been removed by the time the process exits.
          appStateSubscribed,
          appStateRemoved,
          appStateLive: appStateListeners.size,
          accountSwitches: results.reduce((s, r) => s + r.accountSwitches, 0),
          held: results.filter(r => r.outcome === 'HELD').length,
          soft: results.filter(r => r.outcome === 'SOFT').length,
          broken: results.filter(r => r.outcome === 'BROKEN').length,
          strict: STRICT,
          softInvariants: Array.from(SOFT_INVARIANTS),
          violationsByInvariant: byInvariant,
          seedsByInvariant,
        },
        table: results.map(r => ({
          seed: r.seed,
          outcome: r.outcome,
          ops: r.ops,
          io: r.ioIssued,
          faults: r.faultsArmed,
          reordered: r.reorderedSettles,
          opens: r.screenOpens,
          taps: r.taps,
          kills: r.kills,
          switches: r.accountSwitches,
          violations: r.violations.map(v => `${v.at}:${v.op}:${v.invariant}`),
        })),
        failures: failures.map(r => ({
          seed: r.seed,
          violations: r.violations,
          schedule: r.schedule,
          trace: r.trace,
          finalState: r.finalState,
        })),
        replayed:
          only !== null
            ? {
                seed: only,
                schedule: results[0]!.schedule,
                trace: results[0]!.trace,
              }
            : null,
      };
      fs.writeFileSync(
        path.join(
          OUT_DIR,
          only !== null
            ? `seed-${only}${scheduleOverride ? '-minimized' : ''}.json`
            : 'lifecycle-results.json',
        ),
        JSON.stringify(report, null, 2),
      );

      expect(results.length).toBe(seeds.length);
      // Each scenario mounts/unmounts the navigator + screen several times;
      // anything that survives (store subscribers, AppState listeners,
      // navigation refs) shows up here as steady growth. Observed: ~3 KB.
      if (heapPerScenarioBytes !== null)
        expect(heapPerScenarioBytes).toBeLessThan(64 * 1024);
      expect(
        hardFailures.map(r => ({
          seed: r.seed,
          violations: r.violations
            .filter(v => STRICT || !SOFT_INVARIANTS.has(v.invariant))
            .map(v => `${v.at}:${v.op}:${v.invariant}: ${v.detail}`),
        })),
      ).toEqual([]);
    },
    CAMPAIGN_TIMEOUT_MS,
  );

  it('minimised repros reproduce exactly the documented findings', async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const outcomes: Array<{
      id: string;
      seed: number;
      tripped: string[];
      expected: string[];
      result: ScenarioResult;
    }> = [];
    for (const repro of MINIMIZED_REPROS) {
      const result = await runScenario(repro.seed, repro.schedule);
      const tripped = Array.from(
        new Set(result.violations.map(v => v.invariant)),
      ).sort();
      outcomes.push({
        id: repro.id,
        seed: repro.seed,
        tripped,
        expected: [...repro.expect].sort(),
        result,
      });
    }
    fs.writeFileSync(
      path.join(OUT_DIR, 'minimized-repros.json'),
      JSON.stringify(
        {
          strict: STRICT,
          replay:
            'STRESS_SEED=<seed> STRESS_SCHEDULE=<json schedule> npx jest --ci __tests__/stress/notificationSettingsLifecycle.stress.test.tsx',
          repros: outcomes.map(o => ({
            id: o.id,
            seed: o.seed,
            schedule: o.result.schedule,
            expected: o.expected,
            tripped: o.tripped,
            violations: o.result.violations,
            trace: o.result.trace,
            finalState: o.result.finalState,
          })),
        },
        null,
        2,
      ),
    );
    if (STRICT) {
      expect(
        outcomes.map(o => ({ id: o.id, seed: o.seed, tripped: o.tripped })),
      ).toEqual(outcomes.map(o => ({ id: o.id, seed: o.seed, tripped: [] })));
    } else {
      // Only SOFT invariants may trip, and each repro must still trip the
      // invariants it documents (a fix must flip this file to strict).
      expect(
        outcomes.map(o => ({ id: o.id, seed: o.seed, tripped: o.tripped })),
      ).toEqual(
        outcomes.map(o => ({ id: o.id, seed: o.seed, tripped: o.expected })),
      );
      for (const o of outcomes)
        for (const inv of o.tripped)
          expect(SOFT_INVARIANTS.has(inv)).toBe(true);
    }
  });
});
