/**
 * STRESS — unit `mod-notifications`, lens `randomized-seeded`.
 *
 * Seeded randomized long-run over the PUBLIC surface of the notification
 * module: `useNotificationStore` (hydrate / refreshPermission /
 * requestPermissionAndEnable / completeOnboardingStep / setPrefs /
 * dismissPrompt / syncNow), the real `NotifeeScheduler` from service.ts
 * (driven against a faithful fake of the native tray, incl. the iOS
 * 64-pending-request ceiling), the pure planner, and the REAL
 * `useNotificationBootstrap` hook (owner change → hydrate, foreground →
 * refresh + sync) rendered through react-test-renderer.
 *
 * Every sequence is replayable from its seed: `generateSequence(seed)` is a
 * pure function of the seed and every fake is microtask-deterministic, so
 * the same seed produces byte-identical traces (checked for EVERY seed).
 *
 * Invariants (from AGENTS.md "Local reminders", notifications/types.ts,
 * notificationStore.ts, plan.ts and service.ts comments) are model-checked
 * after EVERY action — see `checkInvariants`.
 *
 * Runs:
 *   default (lives in the suite, ~seconds):
 *     cd apps/mobile && npx jest --ci __tests__/stress/notificationsRandomizedSeeded.stress.test.ts
 *   campaign (≥2000 sequences, JSON table of seed → outcome):
 *     STRESS_ITER=2000 STRESS_SEED=1 STRESS_OUT=/tmp/notif-stress.json \
 *       npx jest --ci __tests__/stress/notificationsRandomizedSeeded.stress.test.ts
 *   replay one seed:
 *     STRESS_REPLAY=<seed> npx jest --ci __tests__/stress/notificationsRandomizedSeeded.stress.test.ts
 */
import React from 'react';
import { AppState } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
  useNotificationStore,
} from '../../src/notifications/notificationStore';
import { buildNotificationPlan } from '../../src/notifications/plan';
import type { NotificationPlanContext } from '../../src/notifications/plan';
import { screenTargetFromNotificationData } from '../../src/notifications/service';
import {
  DEFAULT_NOTIFICATION_PREFS,
  NOTIFICATION_ID_PREFIX,
  PLANNED_NOTIFICATION_IDS,
  notificationPrefsKeyForOwner,
  parseNotificationPrefs,
  type NotificationPrefs,
} from '../../src/notifications/types';
import { useNotificationBootstrap } from '../../src/notifications/useNotificationBootstrap';

// Node built-ins for the raw artifacts. The mobile tsconfig excludes node
// typings (see be-mobile-sync-outbox.test.ts), so the shims stay local.
declare const require: (id: string) => unknown;
declare const process: { env: Record<string, string | undefined> };
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { dirname } = require('path') as { dirname: (path: string) => string };

// ───────────────────────────── fakes ─────────────────────────────

/** SQLite kv (data/db + data/repository) with read/write fault injection. */
const mockKv = {
  table: new Map<string, string>(),
  fault: 'none' as 'none' | 'read' | 'write' | 'all',
  reads: 0,
  writes: 0,
};

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        mockKv.reads += 1;
        if (mockKv.fault === 'read' || mockKv.fault === 'all') {
          throw new Error('kv read fault');
        }
        const value = mockKv.table.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        mockKv.writes += 1;
        if (mockKv.fault === 'write' || mockKv.fault === 'all') {
          throw new Error('kv write fault');
        }
        mockKv.table.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

interface TrayEntry {
  id: string;
  title: unknown;
  body: unknown;
  data: unknown;
  timestamp: unknown;
  repeatFrequency: unknown;
  type: unknown;
}

/** iOS: UNUserNotificationCenter keeps at most 64 pending requests. */
const OS_PENDING_LIMIT = 64;

/**
 * Faithful fake of the native module the REAL NotifeeScheduler drives.
 * `authorizationStatus`: -1 undetermined, 0 denied, 1 authorized, 2
 * provisional. Like iOS, `requestPermission` only prompts while the status
 * is undetermined; afterwards it reports the current status silently.
 */
const mockOs = {
  authorizationStatus: -1,
  promptResult: 1,
  promptThrows: false,
  settingsThrows: false,
  listThrows: false,
  cancelThrows: false,
  /** Nth create call (1-based, counted since the fault was armed) throws. */
  createFailAt: null as number | null,
  createCallsSinceArm: 0,
  tray: new Map<string, TrayEntry>(),
  calls: { request: 0, settings: 0, create: 0, list: 0, cancel: 0 },
  /** Fires `fn` once when the named call is reached (owner-switch race). */
  trap: null as null | { on: 'create' | 'list' | 'settings'; fn: () => void },
  /** Violations detected AT CREATE TIME (checked after every action). */
  createViolations: [] as string[],
  reset() {
    this.authorizationStatus = -1;
    this.promptResult = 1;
    this.promptThrows = false;
    this.settingsThrows = false;
    this.listThrows = false;
    this.cancelThrows = false;
    this.createFailAt = null;
    this.createCallsSinceArm = 0;
    this.tray.clear();
    this.calls = { request: 0, settings: 0, create: 0, list: 0, cancel: 0 };
    this.trap = null;
    this.createViolations = [];
  },
  fireTrap(on: 'create' | 'list' | 'settings') {
    if (this.trap && this.trap.on === on) {
      const { fn } = this.trap;
      this.trap = null;
      fn();
    }
  },
};

jest.mock('react-native-notify-kit', () => {
  const notifee = {
    requestPermission: async () => {
      mockOs.calls.request += 1;
      if (mockOs.promptThrows) throw new Error('prompt fault');
      if (mockOs.authorizationStatus === -1) {
        mockOs.authorizationStatus = mockOs.promptResult;
      }
      return { authorizationStatus: mockOs.authorizationStatus };
    },
    getNotificationSettings: async () => {
      mockOs.calls.settings += 1;
      mockOs.fireTrap('settings');
      if (mockOs.settingsThrows) throw new Error('settings fault');
      return { authorizationStatus: mockOs.authorizationStatus };
    },
    createChannel: async () => 'reminders',
    createTriggerNotification: async (
      notification: {
        id?: string;
        title?: unknown;
        body?: unknown;
        data?: unknown;
      },
      trigger: {
        type?: unknown;
        timestamp?: unknown;
        repeatFrequency?: unknown;
      },
    ) => {
      mockOs.calls.create += 1;
      mockOs.createCallsSinceArm += 1;
      mockOs.fireTrap('create');
      if (
        mockOs.createFailAt !== null &&
        mockOs.createCallsSinceArm === mockOs.createFailAt
      ) {
        throw new Error('create fault');
      }
      const id = notification.id ?? '';
      const ts = trigger.timestamp;
      const now = Date.now();
      // Native rejects an id-less request and a non-future / non-finite
      // trigger date (UNCalendar/TimeInterval trigger in the past fires
      // immediately or throws) — record as invariant violations.
      if (!id) mockOs.createViolations.push('create: missing id');
      if (typeof ts !== 'number' || !Number.isFinite(ts)) {
        mockOs.createViolations.push(`create ${id}: non-finite timestamp`);
      } else if (ts < now + 90_000) {
        mockOs.createViolations.push(
          `create ${id}: timestamp ${new Date(ts).toISOString()} < now+90s (${new Date(now).toISOString()})`,
        );
      }
      if (typeof notification.title !== 'string' || !notification.title) {
        mockOs.createViolations.push(`create ${id}: empty title`);
      }
      if (typeof notification.body !== 'string' || !notification.body) {
        mockOs.createViolations.push(`create ${id}: empty body`);
      }
      if (!mockOs.tray.has(id) && mockOs.tray.size >= OS_PENDING_LIMIT) {
        throw new Error('pending request limit reached');
      }
      mockOs.tray.set(id, {
        id,
        title: notification.title,
        body: notification.body,
        data: notification.data,
        timestamp: ts,
        repeatFrequency: trigger.repeatFrequency,
        type: trigger.type,
      });
      return id;
    },
    getTriggerNotificationIds: async () => {
      mockOs.calls.list += 1;
      mockOs.fireTrap('list');
      if (mockOs.listThrows) throw new Error('list fault');
      return [...mockOs.tray.keys()];
    },
    cancelTriggerNotification: async (id: string) => {
      mockOs.calls.cancel += 1;
      if (mockOs.cancelThrows) throw new Error('cancel fault');
      mockOs.tray.delete(id);
    },
    openNotificationSettings: async () => {},
    getInitialNotification: async () => null,
    onForegroundEvent: () => () => {},
    onBackgroundEvent: () => {},
  };
  return {
    __esModule: true,
    default: notifee,
    AndroidImportance: { DEFAULT: 3, HIGH: 4 },
    RepeatFrequency: { NONE: -1, HOURLY: 0, DAILY: 1, WEEKLY: 2 },
    TriggerType: { TIMESTAMP: 0, INTERVAL: 1 },
    EventType: { DISMISSED: 0, PRESS: 1, DELIVERED: 3 },
  };
});

/** Consistency engine facts the default plan context is derived from. */
const mockSnapshot = {
  currentStreak: 0,
  trainedToday: false,
  totalActivities: 0,
  shieldsAvailable: 0,
  nextStreakMilestone: null as null | {
    title: string;
    days: number;
    daysAway: number;
  },
  throws: false,
};
jest.mock('../../src/consistency/store', () => ({
  computeConsistencySnapshot: async () => {
    if (mockSnapshot.throws) throw new Error('history unreadable');
    return { ...mockSnapshot };
  },
}));

// ───────────────────────────── seeded RNG ─────────────────────────────

/** splitmix32 — small, fast, well distributed, fully deterministic. */
class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x9e3779b9) >>> 0;
    let z = this.state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    z = (z ^ (z >>> 15)) >>> 0;
    return z / 4294967296;
  }
  int(minInclusive: number, maxInclusive: number): number {
    return (
      minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1))
    );
  }
  bool(p = 0.5): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error('pick from empty');
    return item;
  }
  weighted<T extends string>(weights: Record<T, number>): T {
    const entries = Object.entries(weights) as [T, number][];
    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    let roll = this.next() * total;
    for (const [key, w] of entries) {
      roll -= w;
      if (roll < 0) return key;
    }
    return entries[entries.length - 1]![0];
  }
}

// ───────────────────────────── action model ─────────────────────────────

const OWNER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_B = 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb';
const OWNERS = [OWNER_A, OWNER_B, GUEST_DATA_OWNER] as const;

type PrefsPatch = Partial<Omit<NotificationPrefs, 'version'>>;

type Action =
  | { kind: 'signIn'; owner: string }
  | { kind: 'signOut' }
  | { kind: 'rehydrate' }
  | { kind: 'restart' }
  | { kind: 'refreshPermission' }
  | { kind: 'requestEnable' }
  | { kind: 'onboarding'; choice: 'enable' | 'not_now' }
  | { kind: 'setPrefs'; patch: PrefsPatch; legal: boolean }
  | { kind: 'dismissPrompt' }
  | { kind: 'syncNow' }
  | { kind: 'foreground' }
  | { kind: 'osStatus'; status: -1 | 0 | 1 | 2 }
  | { kind: 'osPromptResult'; result: 0 | 1 | 2; throws: boolean }
  | { kind: 'advanceClock'; ms: number }
  | {
      kind: 'facts';
      streak: number;
      trainedToday: boolean;
      total: number;
      shields: number;
      milestoneDaysAway: number | null;
      throws: boolean;
    }
  | { kind: 'kvFault'; mode: 'none' | 'read' | 'write' | 'all' }
  | {
      kind: 'osFault';
      settingsThrows: boolean;
      listThrows: boolean;
      cancelThrows: boolean;
      createFailAt: number | null;
    }
  | { kind: 'corruptKv'; target: 'prefs' | 'pending'; payload: string }
  | { kind: 'foreignTray'; ids: string[] }
  | { kind: 'fillTray'; count: number }
  | {
      kind: 'race';
      first: 'setPrefs' | 'syncNow' | 'requestEnable' | 'dismissPrompt';
      second: 'setPrefs' | 'syncNow' | 'signOut' | 'signIn' | 'foreground';
      owner: string;
      patch: PrefsPatch;
      secondPatch: PrefsPatch;
    }
  | {
      kind: 'ownerSwitchMidSync';
      on: 'create' | 'list' | 'settings';
      owner: string;
    };

interface Sequence {
  seed: number;
  startMs: number;
  actions: Action[];
}

const CORRUPT_PAYLOADS = [
  '',
  'null',
  '[]',
  '{',
  '"string"',
  '{"version":2,"enabled":true}',
  '{"version":1,"enabled":"yes","practiceReminderMinutes":1440}',
  '{"version":1,"enabled":true,"practiceReminderMinutes":-15}',
  '{"version":1,"enabled":true,"practiceReminderMinutes":90.5}',
  '{"version":1,"enabled":true,"practiceReminderMinutes":1e309}',
  '{"enabled":true}',
  '{"__proto__":{"enabled":true}}',
] as const;

const FOREIGN_IDS = [
  'other-app-1',
  'ps',
  'PS.reminder.practice',
  'ps_reminder',
  ' ps.reminder.practice',
  'com.picklesensei.legacy',
  'reminder.ps.',
] as const;

function randomLegalPatch(rng: Rng): PrefsPatch {
  const patch: PrefsPatch = {};
  if (rng.bool(0.5)) patch.enabled = rng.bool();
  if (rng.bool(0.3)) patch.practiceReminder = rng.bool();
  if (rng.bool(0.4)) {
    patch.practiceReminderMinutes = rng.bool(0.7)
      ? rng.int(0, 95) * 15
      : rng.int(0, 1439);
  }
  if (rng.bool(0.3)) patch.streakDefense = rng.bool();
  if (rng.bool(0.3)) patch.weeklyRecap = rng.bool();
  if (rng.bool(0.3)) patch.comeback = rng.bool();
  if (rng.bool(0.2)) patch.promptDismissed = rng.bool();
  return patch;
}

function randomNearLegalPatch(rng: Rng): PrefsPatch {
  // Values the settings UI cannot produce (it steps modulo 1440) but the
  // store's `number` type admits.
  const patch = randomLegalPatch(rng);
  patch.enabled = true;
  patch.practiceReminder = true;
  patch.practiceReminderMinutes = rng.pick([
    -1, -30, 1440, 1441, 1500, 2879, 0.5, 1439.99,
  ]);
  return patch;
}

function randomStartMs(rng: Rng): number {
  // 2025-01-01 .. 2027-12-31 local, with a bias toward edges: around the
  // 19:30 streak-defense cut-off, around midnight, and DST weekends.
  const year = rng.int(2025, 2027);
  const month = rng.int(0, 11);
  const day = rng.int(1, 28);
  const edge = rng.weighted({ uniform: 5, streakCut: 2, midnight: 2, dst: 1 });
  let h: number;
  let m: number;
  let s = rng.int(0, 59);
  if (edge === 'streakCut') {
    h = 19;
    m = rng.int(26, 31);
  } else if (edge === 'midnight') {
    h = rng.bool() ? 23 : 0;
    m = h === 23 ? rng.int(57, 59) : rng.int(0, 2);
  } else if (edge === 'dst') {
    h = rng.int(0, 3);
    m = rng.int(0, 59);
    s = 0;
  } else {
    h = rng.int(0, 23);
    m = rng.int(0, 59);
  }
  const date =
    edge === 'dst'
      ? // Second/last Sunday of March / October / November: the DST
        // transition weekends across US + EU + southern zones.
        new Date(year, rng.pick([2, 9, 10, 3]), rng.int(1, 31), h, m, s, 0)
      : new Date(year, month, day, h, m, s, rng.int(0, 999));
  return date.getTime();
}

function randomAction(rng: Rng): Action {
  const kind = rng.weighted({
    signIn: 7,
    signOut: 4,
    rehydrate: 3,
    restart: 3,
    refreshPermission: 3,
    requestEnable: 7,
    onboarding: 4,
    setPrefs: 12,
    dismissPrompt: 2,
    syncNow: 5,
    foreground: 6,
    osStatus: 5,
    osPromptResult: 3,
    advanceClock: 8,
    facts: 5,
    kvFault: 3,
    osFault: 3,
    corruptKv: 2,
    foreignTray: 2,
    fillTray: 1,
    race: 4,
    ownerSwitchMidSync: 3,
  });
  switch (kind) {
    case 'signIn':
      return { kind, owner: rng.pick(OWNERS) };
    case 'signOut':
    case 'rehydrate':
    case 'restart':
    case 'refreshPermission':
    case 'requestEnable':
    case 'dismissPrompt':
    case 'syncNow':
    case 'foreground':
      return { kind };
    case 'onboarding':
      return { kind, choice: rng.bool(0.6) ? 'enable' : 'not_now' };
    case 'setPrefs':
      return rng.bool(0.9)
        ? { kind, patch: randomLegalPatch(rng), legal: true }
        : { kind, patch: randomNearLegalPatch(rng), legal: false };
    case 'osStatus':
      return { kind, status: rng.pick([-1, 0, 1, 2] as const) };
    case 'osPromptResult':
      return {
        kind,
        result: rng.pick([0, 1, 2] as const),
        throws: rng.bool(0.2),
      };
    case 'advanceClock': {
      const unit = rng.weighted({
        seconds: 3,
        minutes: 3,
        hours: 3,
        days: 3,
        weeks: 1,
      });
      const ms =
        unit === 'seconds'
          ? rng.int(1, 120) * 1000
          : unit === 'minutes'
            ? rng.int(1, 120) * 60_000
            : unit === 'hours'
              ? rng.int(1, 30) * 3_600_000
              : unit === 'days'
                ? rng.int(1, 20) * 86_400_000 + rng.int(0, 86_399_999)
                : rng.int(1, 8) * 7 * 86_400_000;
      return { kind, ms };
    }
    case 'facts':
      return {
        kind,
        streak:
          rng.weighted({ zero: 3, small: 4, big: 1 }) === 'zero'
            ? 0
            : rng.bool(0.8)
              ? rng.int(1, 30)
              : rng.int(31, 400),
        trainedToday: rng.bool(),
        total: rng.bool(0.3) ? 0 : rng.int(1, 500),
        shields: rng.int(0, 3),
        milestoneDaysAway: rng.bool(0.3) ? rng.int(0, 3) : null,
        throws: rng.bool(0.1),
      };
    case 'kvFault':
      return {
        kind,
        mode: rng.weighted({ none: 4, read: 2, write: 3, all: 1 }) as
          'none' | 'read' | 'write' | 'all',
      };
    case 'osFault':
      return rng.bool(0.4)
        ? {
            kind,
            settingsThrows: false,
            listThrows: false,
            cancelThrows: false,
            createFailAt: null,
          }
        : {
            kind,
            settingsThrows: rng.bool(0.3),
            listThrows: rng.bool(0.3),
            cancelThrows: rng.bool(0.2),
            createFailAt: rng.bool(0.5) ? rng.int(1, 6) : null,
          };
    case 'corruptKv':
      return {
        kind,
        target: rng.bool(0.75) ? 'prefs' : 'pending',
        payload: rng.pick(CORRUPT_PAYLOADS),
      };
    case 'foreignTray': {
      const n = rng.int(1, 3);
      const ids: string[] = [];
      for (let i = 0; i < n; i += 1) ids.push(rng.pick(FOREIGN_IDS));
      return { kind, ids };
    }
    case 'fillTray':
      return { kind, count: rng.pick([58, 60, 62, 63, 64]) };
    case 'race':
      return {
        kind,
        first: rng.pick([
          'setPrefs',
          'syncNow',
          'requestEnable',
          'dismissPrompt',
        ] as const),
        second: rng.pick([
          'setPrefs',
          'syncNow',
          'signOut',
          'signIn',
          'foreground',
        ] as const),
        owner: rng.pick(OWNERS),
        patch: randomLegalPatch(rng),
        secondPatch: randomLegalPatch(rng),
      };
    case 'ownerSwitchMidSync':
      return {
        kind,
        on: rng.pick(['create', 'list', 'settings'] as const),
        owner: rng.bool(0.5) ? SIGNED_OUT_DATA_OWNER : rng.pick(OWNERS),
      };
  }
}

/** Pure function of the seed: sequence length 5..60. */
export function generateSequence(seed: number): Sequence {
  const rng = new Rng(seed);
  const length = rng.int(5, 60);
  const startMs = randomStartMs(rng);
  const actions: Action[] = [];
  // Most sequences start like the app does: a boot into some owner.
  if (rng.bool(0.85)) {
    actions.push(
      rng.bool(0.8)
        ? { kind: 'signIn', owner: rng.pick(OWNERS) }
        : { kind: 'signOut' },
    );
  }
  while (actions.length < length) actions.push(randomAction(rng));
  return { seed, startMs, actions };
}

// ───────────────────────────── harness ─────────────────────────────

interface StepTrace {
  i: number;
  action: string;
  owner: string;
  state: {
    hydrated: boolean;
    ownerKey: string | null;
    permission: string;
    persistFailed: boolean;
    scheduleFailed: boolean;
    prefs: NotificationPrefs;
  };
  tray: { id: string; ts: unknown; rf: unknown }[];
  kv: string[];
  calls: typeof mockOs.calls;
  violations: string[];
  observations: string[];
}

interface SequenceResult {
  seed: number;
  length: number;
  startIso: string;
  outcome: 'HELD' | 'BROKEN';
  violations: string[];
  firstFailingStep: number | null;
  deterministic: boolean;
  traceHash: string;
  observations: string[];
  /** One minimized reproduction per violated invariant code. */
  minimized?: Record<
    string,
    { length: number; actions: Action[]; violations: string[] }
  >;
}

function Host({ ownerKey }: { ownerKey: string | null }) {
  useNotificationBootstrap(ownerKey);
  return null;
}

let appStateHandler: ((state: string) => void) | null = null;

const INITIAL_STORE = {
  hydrated: false,
  ownerKey: null as string | null,
  prefs: { ...DEFAULT_NOTIFICATION_PREFS },
  permission: 'unknown' as const,
  persistFailed: false,
  scheduleFailed: false,
};

let inflight = 0;
const originalMethods = {
  hydrate: useNotificationStore.getState().hydrate,
  refreshPermission: useNotificationStore.getState().refreshPermission,
  requestPermissionAndEnable:
    useNotificationStore.getState().requestPermissionAndEnable,
  completeOnboardingStep:
    useNotificationStore.getState().completeOnboardingStep,
  setPrefs: useNotificationStore.getState().setPrefs,
  dismissPrompt: useNotificationStore.getState().dismissPrompt,
  syncNow: useNotificationStore.getState().syncNow,
};
const rejections: string[] = [];
const callCounts = { syncNow: 0, hydrate: 0 };

function tracked<A extends unknown[], R>(
  name: string,
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return (...args: A) => {
    inflight += 1;
    if (name === 'syncNow') callCounts.syncNow += 1;
    if (name === 'hydrate') callCounts.hydrate += 1;
    return fn(...args)
      .catch((error: unknown) => {
        rejections.push(`${name} rejected: ${String(error)}`);
        throw error;
      })
      .finally(() => {
        inflight -= 1;
      });
  };
}

/** Public methods are wrapped so `settle` can wait for unawaited chains
 * (the bootstrap hook `void`s hydrate and the foreground refresh). */
function installTracking() {
  useNotificationStore.setState({
    hydrate: tracked('hydrate', originalMethods.hydrate),
    refreshPermission: tracked(
      'refreshPermission',
      originalMethods.refreshPermission,
    ),
    requestPermissionAndEnable: tracked(
      'requestPermissionAndEnable',
      originalMethods.requestPermissionAndEnable,
    ),
    completeOnboardingStep: tracked(
      'completeOnboardingStep',
      originalMethods.completeOnboardingStep,
    ),
    setPrefs: tracked('setPrefs', originalMethods.setPrefs),
    dismissPrompt: tracked('dismissPrompt', originalMethods.dismissPrompt),
    syncNow: tracked('syncNow', originalMethods.syncNow),
  });
}

function resetStore() {
  useNotificationStore.setState({ ...INITIAL_STORE });
  installTracking();
}

async function drain(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

async function settle(): Promise<void> {
  // Everything below is microtask/immediate-driven (no timers), so a few
  // drains after in-flight reaches zero means quiescence.
  let guard = 0;
  do {
    await drain();
    await drain();
    guard += 1;
    if (guard > 10_000) throw new Error('settle: store never quiesced');
  } while (inflight > 0);
  await drain();
}

function ignore(): void {}

/** Mirrors notificationStore.defaultLoadContext over the fake snapshot. */
function expectedContext(nowMs: number): NotificationPlanContext {
  if (mockSnapshot.throws) {
    return {
      nowMs,
      streakDays: 0,
      practicedToday: false,
      hasAnyHistory: false,
    };
  }
  return {
    nowMs,
    streakDays: mockSnapshot.currentStreak,
    practicedToday: mockSnapshot.trainedToday,
    hasAnyHistory: mockSnapshot.totalActivities > 0,
    shieldsAvailable: mockSnapshot.shieldsAvailable,
    milestoneEve:
      mockSnapshot.nextStreakMilestone &&
      mockSnapshot.nextStreakMilestone.daysAway === 1
        ? {
            title: mockSnapshot.nextStreakMilestone.title,
            days: mockSnapshot.nextStreakMilestone.days,
          }
        : null,
  };
}

function ownedTray(): TrayEntry[] {
  return [...mockOs.tray.values()]
    .filter(entry => entry.id.startsWith(NOTIFICATION_ID_PREFIX))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function foreignTray(): TrayEntry[] {
  return [...mockOs.tray.values()].filter(
    entry => !entry.id.startsWith(NOTIFICATION_ID_PREFIX),
  );
}

function faultsActive(): boolean {
  return (
    mockKv.fault !== 'none' ||
    mockOs.settingsThrows ||
    mockOs.listThrows ||
    mockOs.cancelThrows ||
    mockOs.createFailAt !== null
  );
}

interface Model {
  /** Owners whose kv row an action may legitimately touch. */
  ownersTouched: Set<string>;
  /** The tray is expected to equal the plan for the current store state. */
  reconciled: boolean;
  /** The last action asked the OS for its permission status. */
  refreshed: boolean;
  /** Foreign tray entries (never touched by the app). */
  foreign: Map<string, TrayEntry>;
  /** Pending pre-auth onboarding choice, as the kv holds it. */
  pending: { enabled: boolean } | null;
  /** Rows overwritten by the harness (corruptKv) that the store has not
   * rewritten yet — INV-12 cannot hold for them by construction. */
  tamperedRows: Set<string>;
  /** Expected prompt-count delta for the current action. */
  promptsAllowed: number;
  /** A hydrate for the (final) owner ran to completion during the action. */
  hydratedThisAction: boolean;
  /** The last hydrate could not read the prefs row (kv read fault): the
   * store's documented fallback is DEFAULT_NOTIFICATION_PREFS in memory
   * while the row keeps the old value — recorded as an observation. */
  prefsUnreadable: boolean;
  /** Non-failing observations for the results table. */
  observations: string[];
  /** In-range only? (near-legal minutes make wall-clock checks moot) */
  prefsLegal: boolean;
  /** kv table before the action. */
  kvBefore: Map<string, string>;
  ownedBefore: TrayEntry[];
  stateBefore: ReturnType<typeof useNotificationStore.getState>;
  promptsBefore: number;
}

const KNOWN_IDS = new Set<string>(PLANNED_NOTIFICATION_IDS);

function planToTray(
  prefs: NotificationPrefs,
  nowMs: number,
): { id: string; ts: number; rf: number | undefined }[] {
  return buildNotificationPlan(prefs, expectedContext(nowMs))
    .map(item => ({
      id: item.id,
      ts: item.timestampMs,
      rf:
        item.repeat === 'daily' ? 1 : item.repeat === 'weekly' ? 2 : undefined,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function checkInvariants(model: Model, action: Action): string[] {
  const out: string[] = [];
  const state = useNotificationStore.getState();
  const owner = getActiveDataOwner();
  const owned = ownedTray();
  const nowMs = Date.now();

  // INV-01 (store contract): public methods never reject.
  if (rejections.length) out.push(...rejections.map(r => `INV-01 ${r}`));

  // INV-02 (service.ts): created requests are well-formed, future-dated
  // (≥ now + 90s lead), non-empty copy.
  if (mockOs.createViolations.length) {
    out.push(
      ...mockOs.createViolations.map(v =>
        v.startsWith('INV-') ? v : `INV-02 ${v}`,
      ),
    );
  }

  // INV-03 (types.ts): every app id is under `ps.` AND one of the six
  // planned ids; ≤ 6 app entries; tray never exceeds the OS ceiling.
  for (const entry of owned) {
    if (!KNOWN_IDS.has(entry.id)) out.push(`INV-03 unknown app id ${entry.id}`);
    const target = screenTargetFromNotificationData(entry.data);
    if (target === null)
      out.push(`INV-03 ${entry.id} carries no valid screen target`);
  }
  if (owned.length > PLANNED_NOTIFICATION_IDS.length) {
    out.push(
      `INV-03 ${owned.length} app entries > ${PLANNED_NOTIFICATION_IDS.length}`,
    );
  }
  if (mockOs.tray.size > OS_PENDING_LIMIT) {
    out.push(`INV-03 tray ${mockOs.tray.size} > OS limit ${OS_PENDING_LIMIT}`);
  }

  // INV-04 (service.ts): entries outside the prefix are never touched.
  const foreignNow = foreignTray();
  if (foreignNow.length !== model.foreign.size) {
    out.push(
      `INV-04 foreign entries ${foreignNow.length} != expected ${model.foreign.size}`,
    );
  } else {
    for (const entry of foreignNow) {
      const expected = model.foreign.get(entry.id);
      if (!expected || expected.timestamp !== entry.timestamp) {
        out.push(`INV-04 foreign entry ${JSON.stringify(entry.id)} altered`);
      }
    }
  }

  // INV-05 (types.ts): a signed-out owner never gets a prefs row.
  if (mockKv.table.has(notificationPrefsKeyForOwner(SIGNED_OUT_DATA_OWNER))) {
    out.push('INV-05 prefs row written for signed-out owner');
  }

  // INV-06 (accountScope): an owner's row changes only while that owner
  // was active during the action.
  for (const [key, value] of mockKv.table) {
    if (!key.startsWith('notifications:')) continue;
    if (model.kvBefore.get(key) === value) continue;
    const rowOwner = key.slice('notifications:'.length);
    if (!model.ownersTouched.has(rowOwner)) {
      out.push(
        `INV-06 row for ${rowOwner} changed while owners ${[...model.ownersTouched].join('|')} were active`,
      );
    }
  }

  // INV-07 (store): the OS prompt is only ever triggered by the two
  // explicit user gestures; hydrate/sync/foreground never prompt.
  const promptDelta = mockOs.calls.request - model.promptsBefore;
  if (promptDelta > model.promptsAllowed) {
    out.push(
      `INV-07 OS prompt fired ${promptDelta}x during ${action.kind} (allowed ${model.promptsAllowed})`,
    );
  }

  // INV-08 (state shape).
  const p = state.prefs;
  if (p.version !== 1) out.push('INV-08 prefs.version != 1');
  for (const key of [
    'enabled',
    'practiceReminder',
    'streakDefense',
    'weeklyRecap',
    'comeback',
    'promptDismissed',
  ] as const) {
    if (typeof p[key] !== 'boolean')
      out.push(`INV-08 prefs.${key} not boolean`);
  }
  if (
    typeof p.practiceReminderMinutes !== 'number' ||
    Number.isNaN(p.practiceReminderMinutes)
  ) {
    out.push('INV-08 practiceReminderMinutes not a number');
  }
  if (
    !['granted', 'denied', 'undetermined', 'unknown'].includes(state.permission)
  ) {
    out.push(`INV-08 permission ${String(state.permission)} invalid`);
  }
  if (
    state.ownerKey !== null &&
    state.ownerKey !== owner &&
    inflight === 0 &&
    model.reconciled
  ) {
    // Only after a reconcile pass may we insist the store follows the owner.
    out.push(
      `INV-08 store ownerKey ${state.ownerKey} != active owner ${owner} after ${action.kind}`,
    );
  }

  // INV-09 (store flag honesty): whenever the store claims the last
  // reconcile succeeded (`scheduleFailed === false`) and a reconcile pass
  // ran since the last fact/clock/permission change, the tray under `ps.`
  // equals the planner's output for the store state (empty for signed-out /
  // disabled / not granted / owner mismatch). Injected faults do NOT excuse
  // this: a failed pass must leave `scheduleFailed === true`.
  if (model.reconciled && !state.scheduleFailed) {
    const expectEmpty =
      owner === SIGNED_OUT_DATA_OWNER ||
      state.ownerKey !== owner ||
      !state.prefs.enabled ||
      state.permission !== 'granted';
    const expected = expectEmpty ? [] : planToTray(state.prefs, nowMs);
    const actual = owned.map(e => ({
      id: e.id,
      ts: e.timestamp,
      rf: e.repeatFrequency,
    }));
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      out.push(
        `INV-09 tray != plan (scheduleFailed=false): expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`,
      );
    }
  }

  // INV-10 (AGENTS.md): signed-out ⇒ nothing stays scheduled, defaults in
  // memory — checked after any reconcile pass.
  if (
    owner === SIGNED_OUT_DATA_OWNER &&
    model.reconciled &&
    !state.scheduleFailed
  ) {
    if (owned.length)
      out.push(`INV-10 signed-out but ${owned.length} app reminders remain`);
    if (
      JSON.stringify(state.prefs) !== JSON.stringify(DEFAULT_NOTIFICATION_PREFS)
    ) {
      out.push('INV-10 signed-out but prefs are not defaults');
    }
  }

  // INV-11 (permission truth): after a refresh (hydrate / foreground /
  // refreshPermission) with a readable OS, the store mirrors the OS; a
  // denied OS after a reconcile pass ⇒ nothing scheduled.
  if (model.refreshed && !mockOs.settingsThrows) {
    const expected =
      mockOs.authorizationStatus === -1
        ? 'undetermined'
        : mockOs.authorizationStatus === 0
          ? 'denied'
          : 'granted';
    if (state.permission !== expected) {
      out.push(`INV-11 store permission ${state.permission} != OS ${expected}`);
    }
  }
  if (
    model.refreshed &&
    !mockOs.settingsThrows &&
    model.reconciled &&
    !state.scheduleFailed &&
    mockOs.authorizationStatus === 0 &&
    owned.length
  ) {
    out.push(`INV-11 OS denied yet ${owned.length} app reminders scheduled`);
  }

  // INV-12 (store): in-memory prefs round-trip through the kv row unless
  // the store admits the write failed. Compared through the parser: an
  // out-of-range minute pushed via setPrefs is normalised on reload (that
  // divergence is recorded as OBS-16, it is unreachable from the UI). After
  // an unreadable row the documented fallback is defaults (OBS-17).
  if (
    owner !== SIGNED_OUT_DATA_OWNER &&
    state.ownerKey === owner &&
    state.hydrated &&
    !state.persistFailed &&
    !model.tamperedRows.has(owner) &&
    inflight === 0
  ) {
    const rowRaw =
      mockKv.table.get(notificationPrefsKeyForOwner(owner)) ?? null;
    const row = parseNotificationPrefs(rowRaw);
    const memory = parseNotificationPrefs(JSON.stringify(state.prefs));
    if (JSON.stringify(memory) !== JSON.stringify(state.prefs)) {
      model.observations.push(
        `OBS-16 in-memory prefs not parser-stable: ${JSON.stringify(state.prefs)}`,
      );
    }
    if (model.prefsUnreadable) {
      if (
        JSON.stringify(state.prefs) !==
        JSON.stringify(DEFAULT_NOTIFICATION_PREFS)
      ) {
        out.push(
          `INV-12 unreadable row must fall back to defaults, got ${JSON.stringify(state.prefs)}`,
        );
      }
      if (JSON.stringify(row) !== JSON.stringify(DEFAULT_NOTIFICATION_PREFS)) {
        model.observations.push(
          `OBS-17 row ${rowRaw} unreadable during hydrate: memory holds defaults, schedule cancelled, no flag set`,
        );
      }
    } else if (JSON.stringify(row) !== JSON.stringify(memory)) {
      out.push(
        `INV-12 kv row ${JSON.stringify(row)} != prefs ${JSON.stringify(state.prefs)} (persistFailed=false)`,
      );
    }
  }

  // INV-13 (store): a pre-auth onboarding choice is consumed by the first
  // writable hydrate that can read it, and honoured when that owner had no
  // prefs row yet (master switch + promptDismissed follow the choice).
  if (model.hydratedThisAction && model.pending) {
    const pendingRaw = mockKv.table.get(PENDING_NOTIFICATION_ONBOARDING_KV_KEY);
    const consumed = !pendingRaw;
    if (
      owner !== SIGNED_OUT_DATA_OWNER &&
      state.ownerKey === owner &&
      !faultsActive()
    ) {
      if (!consumed) {
        out.push('INV-13 pending onboarding choice not consumed by hydrate');
      }
      const hadRow = model.kvBefore.has(notificationPrefsKeyForOwner(owner));
      if (!hadRow && !model.tamperedRows.has(owner)) {
        if (
          state.prefs.enabled !== model.pending.enabled ||
          !state.prefs.promptDismissed
        ) {
          out.push(
            `INV-13 pending choice enabled=${model.pending.enabled} not honoured: prefs ${JSON.stringify(state.prefs)}`,
          );
        }
      }
    }
    // The store consumed the marker (possibly under an unrelated OS fault):
    // the model must follow reality or a later hydrate is judged against a
    // choice that no longer exists.
    if (consumed) model.pending = null;
  }

  return out;
}

async function runAction(
  action: Action,
  model: Model,
  renderer: { current: TestRenderer.ReactTestRenderer },
) {
  const store = () => useNotificationStore.getState();
  model.promptsAllowed = 0;
  model.refreshed = false;
  model.hydratedThisAction = false;
  rejections.length = 0;
  callCounts.syncNow = 0;
  callCounts.hydrate = 0;
  mockOs.createViolations = [];
  model.promptsBefore = mockOs.calls.request;
  model.kvBefore = new Map(mockKv.table);
  model.ownedBefore = ownedTray();
  model.stateBefore = store();
  model.ownersTouched = new Set([getActiveDataOwner()]);

  const setOwner = async (owner: string) => {
    setActiveDataOwner(owner);
    model.ownersTouched.add(owner);
    await act(async () => {
      renderer.current.update(React.createElement(Host, { ownerKey: owner }));
    });
  };

  const ownedBeforeJson = JSON.stringify(
    model.ownedBefore.map(e => [e.id, e.timestamp]),
  );

  const ownerBefore = getActiveDataOwner();
  const readsBefore = mockKv.reads;
  const writesBefore = mockKv.writes;

  switch (action.kind) {
    case 'signIn':
      // Same owner ⇒ the hook's effect does not re-run (no-op, like the app).
      if (action.owner === ownerBefore) break;
      await setOwner(action.owner);
      await settle();
      model.reconciled = true;
      model.refreshed = !faultsActive();
      model.hydratedThisAction = true;
      break;
    case 'signOut':
      if (ownerBefore === SIGNED_OUT_DATA_OWNER) break;
      await setOwner(SIGNED_OUT_DATA_OWNER);
      await settle();
      model.reconciled = true;
      break;
    case 'rehydrate':
      await store().hydrate().catch(ignore);
      await settle();
      model.reconciled = true;
      model.refreshed =
        getActiveDataOwner() !== SIGNED_OUT_DATA_OWNER && !faultsActive();
      model.hydratedThisAction = true;
      break;
    case 'restart': {
      await act(async () => {
        renderer.current.unmount();
      });
      resetStore();
      const owner = getActiveDataOwner();
      await act(async () => {
        renderer.current = TestRenderer.create(
          React.createElement(Host, { ownerKey: owner }),
        );
      });
      await settle();
      model.reconciled = true;
      model.refreshed = owner !== SIGNED_OUT_DATA_OWNER && !faultsActive();
      model.hydratedThisAction = true;
      break;
    }
    case 'refreshPermission': {
      const before = store().permission;
      await store().refreshPermission().catch(ignore);
      await settle();
      model.refreshed = true;
      if (store().permission !== before) model.reconciled = false;
      break;
    }
    case 'requestEnable':
      model.promptsAllowed = 1;
      await store().requestPermissionAndEnable().catch(ignore);
      await settle();
      // Grant ⇒ setPrefs ⇒ sync; deny/throw ⇒ permission changed, no sync.
      if (
        store().permission === 'granted' &&
        getActiveDataOwner() !== SIGNED_OUT_DATA_OWNER
      ) {
        model.reconciled = true;
      } else if (store().permission !== model.stateBefore.permission) {
        model.reconciled = false;
      }
      break;
    case 'onboarding':
      model.promptsAllowed = action.choice === 'enable' ? 1 : 0;
      await store().completeOnboardingStep(action.choice).catch(ignore);
      await settle();
      if (getActiveDataOwner() === SIGNED_OUT_DATA_OWNER) {
        if (mockKv.fault === 'none' || mockKv.fault === 'read') {
          model.pending = {
            enabled:
              action.choice === 'enable' && store().permission === 'granted',
          };
        }
        if (store().permission !== model.stateBefore.permission)
          model.reconciled = false;
      } else {
        model.reconciled = true;
      }
      break;
    case 'setPrefs':
      await store().setPrefs(action.patch).catch(ignore);
      await settle();
      if (getActiveDataOwner() !== SIGNED_OUT_DATA_OWNER) {
        model.reconciled = true;
        if (
          !action.legal &&
          action.patch.practiceReminderMinutes !== undefined
        ) {
          model.prefsLegal = false;
        }
      }
      break;
    case 'dismissPrompt':
      await store().dismissPrompt().catch(ignore);
      await settle();
      if (
        !model.stateBefore.prefs.promptDismissed &&
        getActiveDataOwner() !== SIGNED_OUT_DATA_OWNER
      ) {
        model.reconciled = true;
      }
      break;
    case 'syncNow': {
      const wasReconciled =
        model.reconciled && !store().scheduleFailed && !faultsActive();
      await store().syncNow().catch(ignore);
      await settle();
      model.reconciled = true;
      // INV-14 (plan.ts): syncing is idempotent — same facts, same tray.
      if (wasReconciled) {
        const after = JSON.stringify(ownedTray().map(e => [e.id, e.timestamp]));
        if (after !== ownedBeforeJson) {
          mockOs.createViolations.push(
            `INV-14 syncNow not idempotent: ${ownedBeforeJson} -> ${after}`,
          );
        }
      }
      break;
    }
    case 'foreground':
      if (!appStateHandler)
        throw new Error('bootstrap hook did not subscribe to AppState');
      await act(async () => {
        appStateHandler!('active');
      });
      await settle();
      model.reconciled = true;
      model.refreshed = !mockOs.settingsThrows;
      break;
    case 'osStatus':
      if (mockOs.authorizationStatus !== action.status)
        model.reconciled = false;
      mockOs.authorizationStatus = action.status;
      break;
    case 'osPromptResult':
      mockOs.promptResult = action.result;
      mockOs.promptThrows = action.throws;
      break;
    case 'advanceClock':
      jest.setSystemTime(Date.now() + action.ms);
      model.reconciled = false;
      break;
    case 'facts':
      mockSnapshot.currentStreak = action.streak;
      mockSnapshot.trainedToday = action.trainedToday;
      mockSnapshot.totalActivities = action.total;
      mockSnapshot.shieldsAvailable = action.shields;
      mockSnapshot.nextStreakMilestone =
        action.milestoneDaysAway === null
          ? null
          : { title: 'Week One', days: 7, daysAway: action.milestoneDaysAway };
      mockSnapshot.throws = action.throws;
      model.reconciled = false;
      break;
    case 'kvFault':
      mockKv.fault = action.mode;
      break;
    case 'osFault':
      mockOs.settingsThrows = action.settingsThrows;
      mockOs.listThrows = action.listThrows;
      mockOs.cancelThrows = action.cancelThrows;
      mockOs.createFailAt = action.createFailAt;
      mockOs.createCallsSinceArm = 0;
      break;
    case 'corruptKv': {
      const key =
        action.target === 'prefs'
          ? notificationPrefsKeyForOwner(getActiveDataOwner())
          : PENDING_NOTIFICATION_ONBOARDING_KV_KEY;
      if (
        action.target === 'prefs' &&
        getActiveDataOwner() === SIGNED_OUT_DATA_OWNER
      )
        break;
      mockKv.table.set(key, action.payload);
      if (action.target === 'pending') model.pending = null;
      else model.tamperedRows.add(getActiveDataOwner());
      break;
    }
    case 'foreignTray':
      for (const id of action.ids) {
        if (mockOs.tray.size >= OS_PENDING_LIMIT) break;
        const entry: TrayEntry = {
          id,
          title: 'foreign',
          body: 'foreign',
          data: { screen: 'Elsewhere' },
          timestamp: Date.now() + 3_600_000,
          repeatFrequency: undefined,
          type: 0,
        };
        mockOs.tray.set(id, entry);
        model.foreign.set(id, entry);
      }
      break;
    case 'fillTray': {
      let n = 0;
      while (mockOs.tray.size < action.count && n < OS_PENDING_LIMIT) {
        const id = `other.fill.${n}`;
        n += 1;
        if (mockOs.tray.has(id)) continue;
        const entry: TrayEntry = {
          id,
          title: 'foreign',
          body: 'foreign',
          data: null,
          timestamp: Date.now() + 7_200_000,
          repeatFrequency: undefined,
          type: 0,
        };
        mockOs.tray.set(id, entry);
        model.foreign.set(id, entry);
      }
      break;
    }
    case 'race': {
      // Two public calls without awaiting the first — the shapes a real UI
      // produces (toggle + foreground, toggle + sign-out, double tap…).
      model.promptsAllowed = action.first === 'requestEnable' ? 1 : 0;
      const first =
        action.first === 'setPrefs'
          ? store().setPrefs(action.patch)
          : action.first === 'syncNow'
            ? store().syncNow()
            : action.first === 'requestEnable'
              ? store().requestPermissionAndEnable()
              : store().dismissPrompt();
      first.catch(ignore);
      let second: Promise<unknown> = Promise.resolve();
      if (action.second === 'setPrefs')
        second = store().setPrefs(action.secondPatch);
      else if (action.second === 'syncNow') second = store().syncNow();
      else if (action.second === 'signOut')
        await setOwner(SIGNED_OUT_DATA_OWNER);
      else if (action.second === 'signIn') await setOwner(action.owner);
      else if (appStateHandler) {
        const handler = appStateHandler;
        await act(async () => {
          handler('active');
        });
      }
      second.catch(ignore);
      await Promise.allSettled([first, second]);
      await settle();
      // Any interleaving is legal only if the FINAL state is coherent: once
      // a reconcile pass (syncNow) ran during the action, the tray must
      // match the store after everything settled.
      const permissionChanged =
        store().permission !== model.stateBefore.permission;
      if (
        action.first === 'requestEnable' &&
        permissionChanged &&
        store().permission !== 'granted'
      ) {
        // A failed/denied prompt never syncs (same as the plain action): the
        // tray is stale by design until the next reconcile pass.
        model.reconciled = false;
      } else if (callCounts.syncNow > 0 || callCounts.hydrate > 0) {
        model.reconciled = true;
      } else if (permissionChanged) {
        model.reconciled = false;
      }
      if (
        callCounts.hydrate > 0 &&
        getActiveDataOwner() !== SIGNED_OUT_DATA_OWNER
      ) {
        model.hydratedThisAction = true;
      }
      model.refreshed = false;
      break;
    }
    case 'ownerSwitchMidSync': {
      // The user signs out / switches account while a reconcile is between
      // native calls: fire the switch INSIDE the named native call.
      const target = action.owner;
      let fired = false;
      mockOs.trap = {
        on: action.on,
        fn: () => {
          fired = true;
          setActiveDataOwner(target);
          model.ownersTouched.add(target);
          // The bootstrap hook re-hydrates on the owner change (rendered
          // synchronously here; the effect runs after commit).
          renderer.current.update(
            React.createElement(Host, { ownerKey: target }),
          );
        },
      };
      // A foreground pass (refresh → sync) reaches every trapped call.
      if (!appStateHandler)
        throw new Error('bootstrap hook did not subscribe to AppState');
      await act(async () => {
        appStateHandler!('active');
      });
      await settle();
      mockOs.trap = null;
      await act(async () => {
        // Flush the effect scheduled by the in-trap update.
      });
      await settle();
      model.reconciled = true;
      model.refreshed = false;
      if (fired && target !== SIGNED_OUT_DATA_OWNER)
        model.hydratedThisAction = true;
      break;
    }
  }
  // Rows written for the (final) active owner are always legitimate.
  model.ownersTouched.add(getActiveDataOwner());
  // Track the documented read-fault fallback: a hydrate that attempted a
  // read under a read fault lands on defaults; the next successful read or
  // write re-couples memory and row.
  if (
    callCounts.hydrate > 0 &&
    mockKv.reads > readsBefore &&
    (mockKv.fault === 'read' || mockKv.fault === 'all')
  ) {
    model.prefsUnreadable = true;
  } else if (
    (mockKv.reads > readsBefore &&
      mockKv.fault !== 'read' &&
      mockKv.fault !== 'all' &&
      callCounts.hydrate > 0) ||
    (mockKv.writes > writesBefore &&
      mockKv.fault !== 'write' &&
      mockKv.fault !== 'all')
  ) {
    model.prefsUnreadable = false;
  }
  // A row the store rewrote is trustworthy again.
  if (action.kind !== 'corruptKv') {
    for (const rowOwner of [...model.tamperedRows]) {
      const key = notificationPrefsKeyForOwner(rowOwner);
      if (mockKv.table.get(key) !== model.kvBefore.get(key))
        model.tamperedRows.delete(rowOwner);
    }
  }
}

function describeAction(action: Action): string {
  return JSON.stringify(action);
}

function countBy(items: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[item] = (out[item] ?? 0) + 1;
  return out;
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

async function resetWorld(
  startMs: number,
): Promise<{ current: TestRenderer.ReactTestRenderer }> {
  jest.setSystemTime(startMs);
  mockKv.table.clear();
  mockKv.fault = 'none';
  mockKv.reads = 0;
  mockKv.writes = 0;
  mockOs.reset();
  mockSnapshot.currentStreak = 0;
  mockSnapshot.trainedToday = false;
  mockSnapshot.totalActivities = 0;
  mockSnapshot.shieldsAvailable = 0;
  mockSnapshot.nextStreakMilestone = null;
  mockSnapshot.throws = false;
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  rejections.length = 0;
  inflight = 0;
  resetStore();
  appStateHandler = null;
  const renderer = {
    current: null as unknown as TestRenderer.ReactTestRenderer,
  };
  await act(async () => {
    renderer.current = TestRenderer.create(
      React.createElement(Host, { ownerKey: null }),
    );
  });
  return renderer;
}

/** Runs a sequence (or a prefix/subset given explicitly), returning the
 * per-step trace and the violations per step. */
async function runSequence(
  startMs: number,
  actions: readonly Action[],
): Promise<{
  trace: StepTrace[];
  violations: string[];
  firstFailingStep: number | null;
}> {
  const renderer = await resetWorld(startMs);
  const model: Model = {
    ownersTouched: new Set(),
    reconciled: false,
    refreshed: false,
    foreign: new Map(),
    pending: null,
    tamperedRows: new Set(),
    promptsAllowed: 0,
    hydratedThisAction: false,
    prefsUnreadable: false,
    observations: [],
    prefsLegal: true,
    kvBefore: new Map(),
    ownedBefore: [],
    stateBefore: useNotificationStore.getState(),
    promptsBefore: 0,
  };
  const trace: StepTrace[] = [];
  const allViolations: string[] = [];
  let firstFailingStep: number | null = null;
  try {
    for (let i = 0; i < actions.length; i += 1) {
      const action = actions[i]!;
      let stepViolations: string[];
      model.observations = [];
      try {
        await runAction(action, model, renderer);
        stepViolations = checkInvariants(model, action);
      } catch (error) {
        stepViolations = [`INV-00 harness/action threw: ${String(error)}`];
      }
      const stepObservations = [...model.observations];
      // Wall-clock invariants are meaningless once out-of-range minutes were
      // pushed through setPrefs; INV-02 future-dating still applies.
      const state = useNotificationStore.getState();
      trace.push({
        i,
        action: describeAction(action),
        owner: getActiveDataOwner(),
        state: {
          hydrated: state.hydrated,
          ownerKey: state.ownerKey,
          permission: state.permission,
          persistFailed: state.persistFailed,
          scheduleFailed: state.scheduleFailed,
          prefs: state.prefs,
        },
        tray: [...mockOs.tray.values()].map(e => ({
          id: e.id,
          ts: e.timestamp,
          rf: e.repeatFrequency,
        })),
        kv: [...mockKv.table.entries()].map(([k, v]) => `${k}=${v}`).sort(),
        calls: { ...mockOs.calls },
        violations: stepViolations,
        observations: stepObservations,
      });
      if (stepViolations.length) {
        if (firstFailingStep === null) firstFailingStep = i;
        allViolations.push(
          ...stepViolations.map(v => `step ${i} ${action.kind}: ${v}`),
        );
      }
    }
  } finally {
    await act(async () => {
      renderer.current.unmount();
    });
    await settle();
  }
  return { trace, violations: allViolations, firstFailingStep };
}

function invariantCode(violation: string): string {
  const match = violation.match(/INV-\d+/);
  return match ? match[0] : 'INV-??';
}

/** Greedy delta-debugging over the action list: drop chunks while the
 * sequence still violates the SAME invariant code. */
async function minimize(
  startMs: number,
  actions: Action[],
  code: string,
): Promise<{ actions: Action[]; violations: string[] }> {
  const reproduces = (violations: string[]) =>
    violations.some(v => invariantCode(v) === code);
  let current = [...actions];
  let currentViolations = (await runSequence(startMs, current)).violations;
  let chunk = Math.max(1, Math.floor(current.length / 2));
  while (chunk >= 1) {
    let i = 0;
    let removedAny = false;
    while (i < current.length) {
      const candidate = [...current.slice(0, i), ...current.slice(i + chunk)];
      if (candidate.length === 0) {
        i += chunk;
        continue;
      }
      const result = await runSequence(startMs, candidate);
      if (reproduces(result.violations)) {
        current = candidate;
        currentViolations = result.violations.filter(
          v => invariantCode(v) === code,
        );
        removedAny = true;
      } else {
        i += chunk;
      }
    }
    if (!removedAny) chunk = Math.floor(chunk / 2);
  }
  return { actions: current, violations: currentViolations };
}

// ───────────────────────────── campaign ─────────────────────────────

const ITER = Math.max(1, Number(process.env['STRESS_ITER'] ?? 120));
const BASE_SEED = Number(process.env['STRESS_SEED'] ?? 1);
const OUT = process.env['STRESS_OUT'];
const REPLAY = process.env['STRESS_REPLAY'];
const BATCH = 50;

function seedFor(index: number): number {
  // Distinct, stable seeds per (base, index).
  return (
    (Math.imul(BASE_SEED, 0x9e3779b1) ^ Math.imul(index + 1, 0x85ebca77)) >>> 0
  );
}

const results: SequenceResult[] = [];
let scenariosExecuted = 0;
let stepsExecuted = 0;

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
      'requestAnimationFrame',
      'cancelAnimationFrame',
    ],
  });
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, handler) => {
      appStateHandler = handler as (state: string) => void;
      return { remove: () => {} } as ReturnType<
        typeof AppState.addEventListener
      >;
    });
});

afterAll(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  if (OUT && REPLAY) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(replayDump, null, 2));
  } else if (OUT) {
    const failed = results.filter(r => r.outcome === 'BROKEN');
    const summary = {
      unit: 'mod-notifications',
      lens: 'randomized-seeded',
      baseSeed: BASE_SEED,
      iterations: ITER,
      scenariosExecuted,
      stepsExecuted,
      held: results.length - failed.length,
      broken: failed.length,
      nonDeterministic: results.filter(r => !r.deterministic).length,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      failingSeeds: failed.map(r => r.seed),
      violationsByInvariant: countBy(
        results.flatMap(r => r.violations.map(invariantCode)),
      ),
      observationsByCode: countBy(
        results.flatMap(r =>
          r.observations.map(o => o.match(/OBS-\d+/)?.[0] ?? 'OBS-??'),
        ),
      ),
      actionsByKind: countBy(
        results.flatMap(r => generateSequence(r.seed).actions.map(a => a.kind)),
      ),
      results,
    };
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(summary, null, 2));
  }
});

async function runSeed(seed: number): Promise<SequenceResult> {
  const sequence = generateSequence(seed);
  const first = await runSequence(sequence.startMs, sequence.actions);
  const second = await runSequence(sequence.startMs, sequence.actions);
  scenariosExecuted += 2;
  stepsExecuted += sequence.actions.length * 2;
  const firstJson = JSON.stringify(first.trace);
  const secondJson = JSON.stringify(second.trace);
  const deterministic = firstJson === secondJson;
  const violations = [...first.violations];
  if (!deterministic) {
    let step = 0;
    while (
      step < first.trace.length &&
      JSON.stringify(first.trace[step]) === JSON.stringify(second.trace[step])
    )
      step += 1;
    violations.push(
      `INV-15 non-deterministic replay: traces diverge at step ${step}`,
    );
  }
  const result: SequenceResult = {
    seed,
    length: sequence.actions.length,
    startIso: new Date(sequence.startMs).toISOString(),
    outcome: violations.length ? 'BROKEN' : 'HELD',
    violations,
    firstFailingStep: first.firstFailingStep,
    deterministic,
    traceHash: fnv1a(firstJson),
    observations: first.trace.flatMap(step =>
      step.observations.map(o => `step ${step.i}: ${o}`),
    ),
  };
  if (first.violations.length) {
    result.minimized = {};
    for (const code of new Set(first.violations.map(invariantCode))) {
      const minimized = await minimize(
        sequence.startMs,
        sequence.actions,
        code,
      );
      result.minimized[code] = {
        length: minimized.actions.length,
        actions: minimized.actions,
        violations: minimized.violations,
      };
    }
  }
  return result;
}

let replayDump: unknown = null;

if (REPLAY) {
  describe('stress mod-notifications randomized-seeded — replay', () => {
    it(`seed ${REPLAY} holds every invariant`, async () => {
      const result = await runSeed(Number(REPLAY));
      results.push(result);
      const sequence = generateSequence(Number(REPLAY));
      const minimizedTraces: Record<string, unknown> = {};
      for (const [code, m] of Object.entries(result.minimized ?? {})) {
        minimizedTraces[code] = (
          await runSequence(sequence.startMs, m.actions)
        ).trace;
      }
      replayDump = { sequence, result, minimizedTraces };
      if (!OUT) {
        console.log(JSON.stringify(replayDump, null, 2));
      }
      expect(result.violations).toEqual([]);
    }, 600_000);
  });
} else {
  describe(`stress mod-notifications randomized-seeded (${ITER} sequences × 2 runs, base seed ${BASE_SEED})`, () => {
    const batches = Math.ceil(ITER / BATCH);
    for (let b = 0; b < batches; b += 1) {
      const from = b * BATCH;
      const to = Math.min(ITER, from + BATCH);
      it(`sequences ${from}..${to - 1} hold every invariant and replay identically`, async () => {
        const failures: string[] = [];
        for (let index = from; index < to; index += 1) {
          const result = await runSeed(seedFor(index));
          results.push(result);
          if (result.outcome === 'BROKEN') {
            const minimized = Object.entries(result.minimized ?? {})
              .map(([code, m]) => `${code}→${m.length} actions`)
              .join(', ');
            failures.push(
              `seed ${result.seed} (len ${result.length}, start ${result.startIso}, minimized ${minimized}):\n  ${result.violations.slice(0, 5).join('\n  ')}`,
            );
          }
        }
        expect(failures).toEqual([]);
      }, 600_000);
    }
  });
}
