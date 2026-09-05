/**
 * NotificationSettingsScreen failure-injection stress harness.
 *
 * The REAL screen is rendered inside the REAL `NavigationContainer` +
 * native-stack navigator + `SafeAreaProvider` the app uses (pushed from a
 * Settings route the way SettingsScreen does it), on top of the real
 * notification store, the real `NotifeeScheduler` seam and the real SQLite
 * data layer (`src/data/db.ts` migrating a real `node:sqlite` database).
 * Only the two native modules and `Linking.openSettings` are replaced:
 *   - `@op-engineering/op-sqlite`   → shim over node:sqlite, fault-injectable
 *   - `react-native-notify-kit`     → fake OS tray, fault-injectable
 *
 * One fault set per scenario is injected into a dependency the screen
 * reaches — SQLite open / kv read / kv write / history read, the OS
 * permission read and prompt, tray list / cancel / create, the Settings
 * deep link, the clock, navigation and account-owner races — as throw,
 * reject, never-settle, slow, malformed, partial or flaky. After the user
 * action, 60 s of fake time pass and the lens invariants are judged:
 *
 *   no crash        no render/effect throw, no unhandled rejection, no
 *                   console.error;
 *   no infinite     no control is still disabled / pending after 60 s;
 *   pending
 *   no silent       a failed save / schedule / prompt / deep link / permission
 *   failure         read is on screen as copy with a retry or back control;
 *   no fake         no "Scheduled…" caption unless the OS truly granted
 *   success         permission and the tray holds exactly the plan; no
 *                   garbage text (NaN, undefined, null, Invalid Date);
 *   recoverable     with the fault cleared, the visible control (toggle,
 *                   Turn on, Check again, Open system settings) heals the
 *                   state: alerts gone, prefs persisted == in-memory, tray ==
 *                   plan, foreign tray ids untouched;
 *   persisted       PRAGMA integrity_check ok and every notifications kv row
 *   state           is canonical (parseNotificationPrefs(raw) == JSON.parse(raw)).
 *
 * Violations fail the `it`; softer contract notes are recorded as
 * observations in the JSON table so a single root cause does not fail every
 * row. A failing `it` IS a finding: the id and seed in its name replay it.
 *
 * Env:
 *   STRESS_ITER   extra seeded random 2-fault combinations (default 6)
 *   STRESS_SEED   base seed (default 20260904); each scenario's seed is
 *                 hash32(`${STRESS_SEED}:${id}`), so a table row replays with
 *                 STRESS_SEED=<base> STRESS_ONLY='<id>'
 *   STRESS_ONLY   substring filter on scenario ids
 *   STRESS_OUT    JSON table path (default artifacts/stress/<file>.json)
 *
 * Runs on Node >= 22.13 (`node:sqlite`) like the other mobile SQLite suites.
 */
import {
  buildCatalog,
  applyAsyncFault,
  clockInstant,
  faultId,
  findGarbageText,
  FOREIGN_TRAY_ID,
  hash32,
  integrityCheck,
  mulberry32,
  randomCatalogEntry,
  readKv,
  sharedController,
  KV_MALFORMED_VARIANTS,
  type Action,
  type CatalogEntry,
  type ClockVariant,
  type Fault,
  type NodeSqliteDatabase,
  type Rng,
  type ScenarioResult,
  type StartState,
} from '../../test-support/stress/notificationSettingsFailureInjection';

// apps/mobile types only `jest` (no @types/node): declare the exact Node
// surface this harness drives, like the other node:sqlite suites do.
declare const require: (id: string) => unknown;
interface NodeProcess {
  env: Record<string, string | undefined>;
  cwd(): string;
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
}
const process = (globalThis as unknown as { process: NodeProcess }).process;
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (location: string) => NodeSqliteDatabase;
};
const fs = require('fs') as {
  mkdirSync(path: string, options: { recursive: boolean }): void;
  writeFileSync(path: string, data: string): void;
};
const pathModule = require('path') as {
  join(...parts: string[]): string;
  dirname(path: string): string;
};

// ---------------------------------------------------------------------------
// Native seams (the ONLY mocks)
// ---------------------------------------------------------------------------

const mockCtl = sharedController;

jest.mock('@op-engineering/op-sqlite', () => {
  const support =
    require('../../test-support/stress/notificationSettingsFailureInjection') as typeof import('../../test-support/stress/notificationSettingsFailureInjection');
  return support.createOpSqliteShim(support.sharedController);
});
jest.mock('react-native-notify-kit', () => {
  const support =
    require('../../test-support/stress/notificationSettingsFailureInjection') as typeof import('../../test-support/stress/notificationSettingsFailureInjection');
  return support.createNotifyKitFake(support.sharedController);
});

import React from 'react';
import { Linking, Text, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import {
  createNavigationContainerRef,
  NavigationContainer,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NotificationSettingsScreen } from '../../src/screens/NotificationSettingsScreen';
import type { RootStackParams } from '../../src/navigation/params';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import { getDb } from '../../src/data/db';
import {
  getActiveDataOwner,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';
import {
  DEFAULT_NOTIFICATION_PREFS,
  notificationPrefsKeyForOwner,
  parseNotificationPrefs,
  PLANNED_NOTIFICATION_IDS,
  type NotificationPrefs,
} from '../../src/notifications/types';
import {
  buildNotificationPlan,
  type NotificationPlanContext,
} from '../../src/notifications/plan';
import { computeConsistencySnapshot } from '../../src/consistency/store';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUITE_FILE =
  '__tests__/stress/notificationSettingsScreen.failureInjection.stress.test.tsx';
const BASE_NOW_ISO = '2026-09-04T18:00:00.000Z';
const OWNER = '66666666-6666-4666-8666-666666666666';
const OTHER_OWNER = '77777777-7777-4777-8777-777777777777';
const STRESS_BASE_SEED = Number(process.env['STRESS_SEED'] ?? '20260904');
const STRESS_ITER = Number(process.env['STRESS_ITER'] ?? '6');
const STRESS_ONLY = process.env['STRESS_ONLY'] ?? '';
const STRESS_OUT =
  process.env['STRESS_OUT'] ??
  pathModule.join(
    process.cwd(),
    'artifacts',
    'stress',
    'notificationSettingsScreen.failureInjection.json',
  );

const COPY = {
  scheduled: 'Scheduled from your real practice history',
  pausedUnknown: 'Paused — notification permission couldn’t be checked',
  pausedDenied: 'Paused until notifications are allowed',
  deniedTitle: 'Notifications are off in system settings',
  unknownTitle: 'Couldn’t check notification permission',
  saveFailed: 'This change couldn’t be saved on this phone',
  scheduleFailed: 'Reminders couldn’t be scheduled on this phone',
  requestFailed: 'Reminders weren’t turned on',
  settingsFailed: 'Couldn’t open Settings from here',
  stayReady: 'Stay match-ready.',
} as const;

const LABEL = {
  turnOn: 'Turn on reminders',
  openSettings: 'Open system settings',
  checkAgain: 'Check again',
  back: 'Back',
  master: 'All reminders',
  practice: 'Practice nudge',
  streak: 'Streak defense',
  weekly: 'Weekly recap',
  comeback: 'Welcome back',
  earlier: 'Reminder 30 minutes earlier',
  later: 'Reminder 30 minutes later',
} as const;

const PRESET_MINUTES = [7 * 60 + 30, 12 * 60, 17 * 60 + 30, 19 * 60 + 30];

const SETTLE_STEPS_MS = [
  0, 250, 1000, 2000, 5000, 9000, 15_000, 31_000, 45_000, 60_000,
];

function seedFor(id: string): number {
  return hash32(`${STRESS_BASE_SEED}:${id}`);
}

function replayCommand(id: string): string {
  return `cd apps/mobile && STRESS_SEED=${STRESS_BASE_SEED} STRESS_ONLY='${id}' npx jest --ci ${SUITE_FILE}`;
}

// ---------------------------------------------------------------------------
// Real navigator host (Home → Settings → NotificationSettings)
// ---------------------------------------------------------------------------

const Stack = createNativeStackNavigator<RootStackParams>();
const navigationRef = createNavigationContainerRef<RootStackParams>();

function HomeStub() {
  return (
    <View>
      <Text>home-stub</Text>
    </View>
  );
}

function SettingsStub() {
  return (
    <View>
      <Text>settings-stub</Text>
    </View>
  );
}

function Host() {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, left: 0, right: 0, bottom: 34 },
      }}
    >
      <NavigationContainer ref={navigationRef}>
        <Stack.Navigator
          initialRouteName="Tabs"
          screenOptions={{ headerShown: false, animation: 'none' }}
        >
          <Stack.Screen name="Tabs" component={HomeStub} />
          <Stack.Screen name="ConsentSettings" component={SettingsStub} />
          <Stack.Screen
            name="NotificationSettings"
            component={NotificationSettingsScreen}
            options={{ title: 'Notifications' }}
          />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

function textsOf(renderer: ReactTestRenderer): string[] {
  const out: string[] = [];
  const flatten = (child: unknown): string => {
    if (child === null || child === undefined || typeof child === 'boolean')
      return '';
    if (Array.isArray(child)) return child.map(flatten).join('');
    if (typeof child === 'object') return '';
    return String(child);
  };
  for (const node of renderer.root.findAllByType(Text)) {
    const text = flatten(node.props['children']).trim();
    if (text) out.push(text);
  }
  return out;
}

function hasText(texts: readonly string[], needle: string): boolean {
  return texts.some(t => t.includes(needle));
}

interface Control {
  label: string;
  disabled: boolean;
  node: ReactTestInstance;
}

function controlsOf(renderer: ReactTestRenderer): Control[] {
  return renderer.root
    .findAll(
      node =>
        typeof node.props['onPress'] === 'function' &&
        typeof node.props['accessibilityLabel'] === 'string',
    )
    .map(node => ({
      label: String(node.props['accessibilityLabel']),
      disabled: node.props['disabled'] === true,
      node,
    }));
}

function findControl(
  renderer: ReactTestRenderer,
  label: string | RegExp,
): Control | undefined {
  return controlsOf(renderer).find(c =>
    typeof label === 'string' ? c.label === label : label.test(c.label),
  );
}

async function press(
  renderer: ReactTestRenderer,
  label: string | RegExp,
): Promise<boolean> {
  const control = findControl(renderer, label);
  if (!control) return false;
  await act(async () => {
    (control.node.props['onPress'] as () => void)();
  });
  return true;
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r));
  });
}

async function advance(ms: number): Promise<void> {
  if (ms > 0) {
    await act(async () => {
      jest.advanceTimersByTime(ms);
    });
  }
  await flush();
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function storedPrefsFor(start: StartState, rng: Rng): NotificationPrefs | null {
  if (start === 'off-undetermined' || start === 'off-denied') return null;
  return {
    version: 1,
    enabled: true,
    practiceReminder: true,
    practiceReminderMinutes: rng.pick([
      8 * 60,
      ...PRESET_MINUTES,
      23 * 60 + 30,
    ]),
    streakDefense: true,
    weeklyRecap: rng.chance(0.7),
    comeback: rng.chance(0.7),
    promptDismissed: true,
  };
}

function osStatusFor(start: StartState): number {
  switch (start) {
    case 'off-undetermined':
      return -1;
    case 'off-denied':
    case 'on-denied':
      return 0;
    case 'on-provisional':
      return 2;
    case 'on-granted':
    case 'on-unknown':
      return 1;
  }
}

function permissionTruth(): 'granted' | 'denied' | 'undetermined' {
  const status = mockCtl.osStatus;
  if (status === 1 || status === 2) return 'granted';
  if (status === 0) return 'denied';
  return 'undetermined';
}

function seedHistory(
  real: NodeSqliteDatabase,
  owner: string,
  nowMs: number,
  streakDays: number,
): void {
  const insert = real.prepare(
    `INSERT INTO local_shot (owner_key, id, session_id, shot_type, captured_at,
       overall_score, confidence, result_kind, source, favorite, payload)
     VALUES (?, ?, NULL, 'dink', ?, 72, 0.9, 'scored', 'real', 0, '{}')`,
  );
  for (let day = 0; day < streakDays; day++) {
    const at = new Date(nowMs);
    at.setDate(at.getDate() - day);
    at.setHours(10, 0, 0, 0);
    insert.run(owner, `stress-shot-${day}`, at.toISOString());
  }
}

function resetStore(): void {
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
    persistFailed: false,
    scheduleFailed: false,
  });
}

// ---------------------------------------------------------------------------
// Invariant helpers
// ---------------------------------------------------------------------------

function readStoredPrefs(
  real: NodeSqliteDatabase,
  owner: string,
): { raw: string | null; prefs: NotificationPrefs | null; canonical: boolean } {
  const row = readKv(real).find(
    r => r.key === notificationPrefsKeyForOwner(owner),
  );
  if (!row) return { raw: null, prefs: null, canonical: true };
  const raw = typeof row.value === 'string' ? row.value : String(row.value);
  try {
    const parsed = JSON.parse(raw) as unknown;
    const prefs = parseNotificationPrefs(raw);
    return {
      raw,
      prefs,
      canonical: JSON.stringify(parsed) === JSON.stringify(prefs),
    };
  } catch {
    return { raw, prefs: null, canonical: false };
  }
}

function samePrefs(a: NotificationPrefs | null, b: NotificationPrefs): boolean {
  return a !== null && JSON.stringify(a) === JSON.stringify(b);
}

function trayOwnedIds(): string[] {
  return [...mockCtl.tray.keys()].filter(id => id.startsWith('ps.')).sort();
}

/** The ids the store's own planner would schedule for `prefs` right now,
 * computed with the faults cleared (the real history read). */
async function expectedPlanIds(prefs: NotificationPrefs): Promise<string[]> {
  const nowMs = Date.now();
  const armed = [...mockCtl.faults];
  const callsBefore = mockCtl.calls.length;
  mockCtl.clear();
  let context: NotificationPlanContext;
  try {
    const snapshot = await computeConsistencySnapshot();
    context = {
      nowMs,
      streakDays: snapshot.currentStreak,
      practicedToday: snapshot.trainedToday,
      hasAnyHistory: snapshot.totalActivities > 0,
      shieldsAvailable: snapshot.shieldsAvailable,
      milestoneEve:
        snapshot.nextStreakMilestone &&
        snapshot.nextStreakMilestone.daysAway === 1
          ? {
              title: snapshot.nextStreakMilestone.title,
              days: snapshot.nextStreakMilestone.days,
            }
          : null,
    };
  } catch {
    context = {
      nowMs,
      streakDays: 0,
      practicedToday: false,
      hasAnyHistory: false,
    };
  } finally {
    mockCtl.calls.length = callsBefore;
    mockCtl.arm(armed);
  }
  return buildNotificationPlan(prefs, context)
    .map(item => item.id)
    .sort();
}

function hungCalls(): number {
  return mockCtl.calls.filter(c => c.outcome === 'hung').length;
}

function failedCalls(channel: Fault['channel']): number {
  return mockCtl.calls.filter(
    c =>
      c.channel === channel &&
      (c.outcome === 'threw' || c.outcome === 'rejected'),
  ).length;
}

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------

interface ScenarioPick {
  start: StartState;
  action: Action;
  presetIndex: number;
  streakDays: number;
}

function pickScenario(entry: CatalogEntry, rng: Rng): ScenarioPick {
  return {
    start: rng.pick(entry.starts),
    action: rng.pick(entry.actions),
    presetIndex: rng.int(0, PRESET_MINUTES.length - 1),
    streakDays: rng.int(0, 4),
  };
}

async function navigateToScreen(): Promise<void> {
  await act(async () => {
    navigationRef.navigate('ConsentSettings');
  });
  await act(async () => {
    navigationRef.navigate('NotificationSettings');
  });
  await flush();
}

async function performAction(
  renderer: ReactTestRenderer,
  pick: ScenarioPick,
  faults: readonly Fault[],
): Promise<string[]> {
  const notes: string[] = [];
  const tap = async (label: string | RegExp) => {
    const ok = await press(renderer, label);
    if (!ok) notes.push(`control missing: ${String(label)}`);
    return ok;
  };
  switch (pick.action) {
    case 'focusOnly':
      break;
    case 'turnOn':
      await tap(LABEL.turnOn);
      break;
    case 'toggleMaster':
      await tap(LABEL.master);
      break;
    case 'togglePractice':
      await tap(LABEL.practice);
      break;
    case 'toggleStreak':
      await tap(LABEL.streak);
      break;
    case 'toggleWeekly':
      await tap(LABEL.weekly);
      break;
    case 'toggleComeback':
      await tap(LABEL.comeback);
      break;
    case 'preset': {
      const minutes = PRESET_MINUTES[pick.presetIndex] ?? PRESET_MINUTES[0]!;
      const labels = ['Morning', 'Midday', 'Evening', 'Night'];
      const label = labels[pick.presetIndex] ?? 'Morning';
      const ok = await tap(new RegExp(`^${label}, `));
      if (ok) notes.push(`preset ${label} = ${minutes} min`);
      break;
    }
    case 'stepEarlier':
      await tap(LABEL.earlier);
      break;
    case 'stepLater':
      await tap(LABEL.later);
      break;
    case 'rapidToggles':
      for (let i = 0; i < 5; i++) {
        await act(async () => {
          const c = findControl(renderer, LABEL.master);
          if (c) (c.node.props['onPress'] as () => void)();
        });
      }
      break;
    case 'openSettings':
      await tap(LABEL.openSettings);
      break;
    case 'checkAgain':
      await tap(LABEL.checkAgain);
      break;
    case 'back':
      await tap(LABEL.back);
      break;
    case 'backAndReenter':
      await tap(LABEL.back);
      await flush();
      await act(async () => {
        navigationRef.navigate('NotificationSettings');
      });
      await flush();
      break;
  }

  // Races that start 1 s into an in-flight write.
  const nav = faults.find(f => f.channel === 'nav');
  const owner = faults.find(f => f.channel === 'owner');
  if (nav || owner) await advance(1000);
  if (nav?.variant === 'backMidFlight') {
    await tap(LABEL.back);
  } else if (nav?.variant === 'doubleBack') {
    await act(async () => {
      const c = findControl(renderer, LABEL.back);
      if (c) {
        (c.node.props['onPress'] as () => void)();
        (c.node.props['onPress'] as () => void)();
      }
    });
  }
  if (owner?.variant === 'switchMidFlight') {
    setActiveDataOwner(OTHER_OWNER);
    void useNotificationStore
      .getState()
      .hydrate({ expectedOwnerKey: OTHER_OWNER });
  } else if (owner?.variant === 'signOutMidFlight') {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    void useNotificationStore
      .getState()
      .hydrate({ expectedOwnerKey: SIGNED_OUT_DATA_OWNER });
  }
  return notes;
}

async function runScenario(
  entry: CatalogEntry,
  seed: number,
): Promise<ScenarioResult> {
  const startedAt = Date.now();
  const rng = mulberry32(seed);
  const pick = pickScenario(entry, rng);
  const violations: string[] = [];
  const observations: string[] = [];
  const consoleErrors: string[] = [];
  const unhandled: string[] = [];
  const detail: Record<string, unknown> = {};

  const onUnhandled = (reason: unknown) =>
    unhandled.push(String((reason as Error)?.message ?? reason).slice(0, 200));
  process.on('unhandledRejection', onUnhandled);
  const consoleErrorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(
        args
          .map(a => (a instanceof Error ? a.message : String(a)))
          .join(' ')
          .slice(0, 240),
      );
    });

  const clockFault = entry.faults.find(f => f.channel === 'clock');
  const nowInstant = clockFault
    ? clockInstant(clockFault.variant as ClockVariant, BASE_NOW_ISO)
    : new Date(BASE_NOW_ISO);
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    now: nowInstant,
  });
  let dateNowSpy: jest.SpyInstance<number, []> | null = null;
  if (clockFault?.variant === 'nanNow') {
    dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(NaN);
  }

  // Fresh real database + fresh store; the data layer re-opens on next use.
  mockCtl.clear();
  mockCtl.calls.length = 0;
  mockCtl.hits.clear();
  mockCtl.tray.clear();
  mockCtl.tray.set(FOREIGN_TRAY_ID, { timestamp: 4e12, repeatFrequency: -1 });
  const real = new DatabaseSync(':memory:');
  mockCtl.real = real;
  setActiveDataOwner(OWNER);
  getDb().close();
  resetStore();

  const storedPrefs = storedPrefsFor(pick.start, rng);
  const kvReadFault = entry.faults.find(f => f.channel === 'sqlite.kvRead');
  const kvMalformed =
    kvReadFault?.mode === 'malformed' ? kvReadFault.variant : undefined;
  if (kvMalformed) {
    real
      .prepare('INSERT INTO kv (key, value) VALUES (?, ?)')
      .run(
        notificationPrefsKeyForOwner(OWNER),
        KV_MALFORMED_VARIANTS[kvMalformed] ?? 'garbage',
      );
  } else if (storedPrefs) {
    real
      .prepare('INSERT INTO kv (key, value) VALUES (?, ?)')
      .run(notificationPrefsKeyForOwner(OWNER), JSON.stringify(storedPrefs));
  }
  // A row for another account must never be touched by this owner's writes.
  const otherRaw = JSON.stringify({
    ...DEFAULT_NOTIFICATION_PREFS,
    enabled: true,
  });
  real
    .prepare('INSERT INTO kv (key, value) VALUES (?, ?)')
    .run(notificationPrefsKeyForOwner(OTHER_OWNER), otherRaw);
  seedHistory(real, OWNER, nowInstant.getTime(), pick.streakDays);

  mockCtl.osStatus = osStatusFor(pick.start);
  mockCtl.osStatusAfterRequest = 1;
  const openSettingsSpy = jest
    .spyOn(Linking, 'openSettings')
    .mockImplementation(
      () =>
        applyAsyncFault(
          mockCtl,
          'linking.openSettings',
          'Linking.openSettings',
          () => undefined,
        ) as Promise<void>,
    );

  // The store's own permission read fails for the 'on-unknown' start.
  const bootFaults: Fault[] = [];
  if (entry.phase === 'boot') bootFaults.push(...entry.faults);
  if (
    pick.start === 'on-unknown' &&
    !bootFaults.some(f => f.channel === 'notify.settings')
  ) {
    bootFaults.push({ channel: 'notify.settings', mode: 'reject' });
  }
  mockCtl.arm(bootFaults);

  let renderer: ReactTestRenderer | null = null;
  let actError: string | null = null;

  try {
    // Bootstrap exactly like useNotificationBootstrap, then mount + push.
    void useNotificationStore.getState().hydrate({ expectedOwnerKey: OWNER });
    await flush();
    await act(async () => {
      renderer = TestRenderer.create(<Host />);
    });
    await flush();
    await navigateToScreen();
    const view = renderer as unknown as ReactTestRenderer;
    detail['textsBeforeAction'] = textsOf(view).slice(0, 12);

    // Arm action-phase faults (replacing the 'on-unknown' bootstrap fault so
    // the retry control is judged against the injected fault alone).
    if (entry.phase === 'action') mockCtl.arm(entry.faults);
    else if (pick.start === 'on-unknown') mockCtl.arm(entry.faults);

    const prefsBeforeAction = useNotificationStore.getState().prefs;
    const actionNotes = await performAction(view, pick, entry.faults);
    observations.push(...actionNotes);

    // ---- 60 s of fake time ------------------------------------------------
    let elapsed = 0;
    for (const step of SETTLE_STEPS_MS) {
      await advance(step - elapsed);
      elapsed = step;
    }

    const ownerChanged = getActiveDataOwner() !== OWNER;
    const navFault = entry.faults.find(f => f.channel === 'nav');
    if (navFault && !ownerChanged) {
      // The user comes back to the screen after the race.
      if (!navigationRef.getCurrentRoute()?.name.startsWith('Notification')) {
        await act(async () => {
          navigationRef.navigate('NotificationSettings');
        });
        await flush();
      }
    }

    const state = useNotificationStore.getState();
    const texts = textsOf(view);
    const controls = controlsOf(view);
    const onScreen =
      navigationRef.getCurrentRoute()?.name === 'NotificationSettings';
    detail['routeAfter'] = navigationRef.getCurrentRoute()?.name ?? null;
    detail['textsAfter'] = texts.slice(0, 16);
    detail['controlsAfter'] = controls.map(
      c => `${c.label}${c.disabled ? ' (disabled)' : ''}`,
    );
    detail['store'] = {
      permission: state.permission,
      enabled: state.prefs.enabled,
      persistFailed: state.persistFailed,
      scheduleFailed: state.scheduleFailed,
      ownerKey: state.ownerKey,
    };
    detail['calls'] = mockCtl.calls.map(c => `${c.channel}:${c.outcome}`);
    detail['trayAfter'] = [...mockCtl.tray.keys()];
    detail['permissionTruth'] = permissionTruth();

    // no crash
    if (unhandled.length)
      violations.push(`crash: unhandled rejection ${unhandled[0]}`);
    if (consoleErrors.length)
      violations.push(`crash: console.error ${consoleErrors[0]}`);

    // no garbage text
    const garbage = findGarbageText(texts);
    if (garbage.length)
      violations.push(
        `fake-success: garbage text ${JSON.stringify(garbage[0])}`,
      );

    if (onScreen && !ownerChanged) {
      // no infinite pending
      const stuck = controls.filter(
        c => c.disabled && c.label === LABEL.turnOn,
      );
      if (stuck.length) {
        violations.push(
          'infinite-pending: "Turn on reminders" still disabled 60s after the prompt did not answer, no copy explains it',
        );
      }
      const dimmedTime = controls.filter(
        c =>
          c.disabled &&
          (c.label === LABEL.earlier || c.label === LABEL.later) &&
          state.prefs.practiceReminder,
      );
      if (dimmedTime.length)
        violations.push(
          'infinite-pending: time controls disabled while the nudge is on',
        );

      // no silent failure — persisted write
      const lastWrite = [...mockCtl.calls]
        .reverse()
        .find(c => c.channel === 'sqlite.kvWrite');
      const writeFailedLast =
        lastWrite !== undefined &&
        (lastWrite.outcome === 'threw' || lastWrite.outcome === 'rejected');
      if (writeFailedLast && !hasText(texts, COPY.saveFailed)) {
        violations.push(
          'silent-failure: the last preference write failed but no "couldn’t be saved" copy is on screen',
        );
      }
      if (state.persistFailed !== hasText(texts, COPY.saveFailed)) {
        violations.push(
          'silent-failure: persistFailed state and copy disagree',
        );
      }
      // no silent failure — prompt
      if (
        pick.action === 'turnOn' &&
        failedCalls('notify.request') > 0 &&
        state.permission !== 'denied' &&
        !hasText(texts, COPY.requestFailed) &&
        !hasText(texts, COPY.deniedTitle)
      ) {
        violations.push(
          'silent-failure: the permission prompt failed but no copy or retry is on screen',
        );
      }
      // no silent failure — deep link
      if (
        failedCalls('linking.openSettings') > 0 &&
        !hasText(texts, COPY.settingsFailed)
      ) {
        violations.push(
          'silent-failure: Linking.openSettings failed with no fallback copy',
        );
      }
      // no silent failure — permission read
      if (
        state.permission === 'unknown' &&
        state.prefs.enabled &&
        !hasText(texts, COPY.unknownTitle)
      ) {
        violations.push(
          'silent-failure: permission unknown with reminders on, no "Check again" card',
        );
      }
      if (
        state.permission === 'unknown' &&
        state.prefs.enabled &&
        !controls.some(c => c.label === LABEL.checkAgain && !c.disabled)
      ) {
        violations.push('recoverable: no enabled "Check again" control');
      }
      if (state.permission === 'denied') {
        if (!hasText(texts, COPY.deniedTitle))
          violations.push(
            'silent-failure: denied permission has no recovery card',
          );
        if (!controls.some(c => c.label === LABEL.openSettings && !c.disabled))
          violations.push(
            'recoverable: denied state has no "Open system settings"',
          );
      }
      if (state.scheduleFailed !== hasText(texts, COPY.scheduleFailed)) {
        violations.push(
          'silent-failure: scheduleFailed state and copy disagree',
        );
      }

      // no fake success — permission
      const truth = permissionTruth();
      if (state.permission === 'granted' && truth !== 'granted') {
        violations.push(
          `fake-success: store says granted while the OS reported ${truth} (payload ${JSON.stringify(
            entry.faults.find(
              f =>
                f.channel === 'notify.settings' ||
                f.channel === 'notify.request',
            )?.variant ?? null,
          )})`,
        );
      }
      if (hasText(texts, COPY.scheduled) && truth !== 'granted') {
        violations.push(
          'fake-success: "Scheduled…" caption without OS permission',
        );
      }
      if (
        hasText(texts, COPY.scheduled) &&
        hasText(texts, COPY.scheduleFailed)
      ) {
        observations.push(
          'contradictory-copy: "Scheduled from your real practice history" shown beside "Reminders couldn’t be scheduled"',
        );
      }
      // no fake success — tray must hold the plan when the store says synced
      const active = state.prefs.enabled && state.permission === 'granted';
      if (hungCalls() === 0 && !state.scheduleFailed) {
        const owned = trayOwnedIds();
        if (active) {
          const expected = await expectedPlanIds(state.prefs);
          if (JSON.stringify(owned) !== JSON.stringify(expected)) {
            const historyFailed =
              failedCalls('sqlite.history') > 0 ||
              mockCtl.calls.some(
                c =>
                  c.channel === 'sqlite.history' && c.outcome === 'malformed',
              );
            const line = `tray ${JSON.stringify(owned)} != plan ${JSON.stringify(expected)}`;
            if (historyFailed) {
              observations.push(
                `silent-degradation: history read failed, streak reminder dropped without copy (${line})`,
              );
            } else {
              violations.push(`fake-success: ${line}`);
            }
          }
        } else if (owned.length) {
          violations.push(
            `fake-success: reminders off/paused but tray still holds ${JSON.stringify(owned)}`,
          );
        }
      } else if (hungCalls() > 0) {
        observations.push(
          `hung-dependency: ${hungCalls()} call(s) never settled; no timeout or copy covers them`,
        );
      }
      // garbage never reaches the tray
      for (const [id, trigger] of mockCtl.tray) {
        if (
          id.startsWith('ps.') &&
          (typeof trigger.timestamp !== 'number' ||
            !Number.isFinite(trigger.timestamp))
        ) {
          violations.push(
            `corrupt-tray: ${id} scheduled at ${String(trigger.timestamp)}`,
          );
        }
        if (
          id.startsWith('ps.') &&
          !PLANNED_NOTIFICATION_IDS.includes(id as never)
        ) {
          violations.push(`corrupt-tray: unknown id ${id}`);
        }
      }
      if (!mockCtl.tray.has(FOREIGN_TRAY_ID)) {
        violations.push(
          'corrupt-tray: a foreign app’s notification was cancelled',
        );
      }

      // persisted == memory whenever the store claims the save landed
      const stored = readStoredPrefs(real, OWNER);
      detail['storedAfter'] = stored.raw?.slice(0, 200) ?? null;
      const writeHung = mockCtl.calls.some(
        c => c.channel === 'sqlite.kvWrite' && c.outcome === 'hung',
      );
      const wroteSomething = mockCtl.calls.some(
        c => c.channel === 'sqlite.kvWrite',
      );
      const wroteOk = mockCtl.calls.some(
        c => c.channel === 'sqlite.kvWrite' && c.outcome === 'ok',
      );
      // A malformed row the harness planted may survive until the app writes;
      // once the app has written, the row must be canonical.
      if (!stored.canonical && (wroteOk || kvReadFault?.mode !== 'malformed'))
        violations.push(
          `corrupt-persisted: ${JSON.stringify(stored.raw).slice(0, 120)}`,
        );
      if (
        wroteSomething &&
        !writeHung &&
        !state.persistFailed &&
        stored.prefs &&
        !samePrefs(stored.prefs, state.prefs)
      ) {
        violations.push(
          `corrupt-persisted: store says saved but kv holds ${stored.raw} vs memory ${JSON.stringify(state.prefs)}`,
        );
      }
      if (
        storedPrefs &&
        wroteSomething &&
        kvReadFault &&
        kvReadFault.mode !== 'malformed' &&
        stored.prefs &&
        stored.prefs.practiceReminderMinutes !==
          storedPrefs.practiceReminderMinutes &&
        prefsBeforeAction.practiceReminderMinutes !==
          storedPrefs.practiceReminderMinutes &&
        !['preset', 'stepEarlier', 'stepLater'].includes(pick.action)
      ) {
        observations.push(
          `prefs-reset: a failed read at launch fell back to defaults and the next write persisted them (was ${storedPrefs.practiceReminderMinutes} min, now ${stored.prefs.practiceReminderMinutes})`,
        );
      }
      if (
        hasText(texts, COPY.stayReady) &&
        storedPrefs?.enabled &&
        kvReadFault &&
        kvReadFault.mode !== 'malformed' &&
        !hasText(texts, COPY.saveFailed)
      ) {
        observations.push(
          'silent-failure: reminders were on but the launch read failed; screen shows the fresh "Turn on" card with no hint',
        );
      }
    }

    // ---- recovery: clear the fault, use the visible control --------------
    if (!ownerChanged) {
      mockCtl.clear();
      if (clockFault) {
        // The clock fault is a device condition; recovery means it is fixed.
        dateNowSpy?.mockRestore();
        dateNowSpy = null;
        jest.setSystemTime(new Date(BASE_NOW_ISO));
      }
      if (!onScreen) {
        await act(async () => {
          navigationRef.navigate('NotificationSettings');
        });
        await flush();
      }
      const before = textsOf(view);
      if (findControl(view, LABEL.checkAgain)) {
        await press(view, LABEL.checkAgain);
      } else if (findControl(view, LABEL.turnOn)) {
        await press(view, LABEL.turnOn);
      } else if (findControl(view, LABEL.practice)) {
        await press(view, LABEL.practice);
        await advance(250);
        await press(view, LABEL.practice);
      } else if (findControl(view, LABEL.openSettings)) {
        await press(view, LABEL.openSettings);
      }
      if (hasText(before, COPY.settingsFailed))
        await press(view, LABEL.openSettings);
      await advance(60_000);

      const after = useNotificationStore.getState();
      const textsAfter = textsOf(view);
      const controlsAfter = controlsOf(view);
      detail['textsRecovered'] = textsAfter.slice(0, 16);
      detail['storeRecovered'] = {
        permission: after.permission,
        enabled: after.prefs.enabled,
        persistFailed: after.persistFailed,
        scheduleFailed: after.scheduleFailed,
      };
      detail['trayRecovered'] = [...mockCtl.tray.keys()];
      const truth = permissionTruth();
      if (after.persistFailed)
        violations.push('recoverable: persistFailed after retry');
      if (after.scheduleFailed)
        violations.push('recoverable: scheduleFailed after retry');
      if (
        hasText(textsAfter, COPY.saveFailed) ||
        hasText(textsAfter, COPY.scheduleFailed)
      )
        violations.push('recoverable: failure copy still shown after retry');
      if (hasText(textsAfter, COPY.settingsFailed))
        violations.push(
          'recoverable: settings-link failure copy still shown after retry',
        );
      if (controlsAfter.some(c => c.disabled && c.label === LABEL.turnOn))
        violations.push(
          'recoverable: "Turn on reminders" still disabled after retry',
        );
      if (after.permission !== truth) {
        violations.push(
          `recoverable: permission ${after.permission} after retry, OS says ${truth}`,
        );
      }
      const stored = readStoredPrefs(real, OWNER);
      const wrote = mockCtl.calls.some(
        c => c.channel === 'sqlite.kvWrite' && c.outcome === 'ok',
      );
      if (!stored.canonical && (wrote || kvReadFault?.mode !== 'malformed'))
        violations.push(
          `corrupt-persisted: after retry ${JSON.stringify(stored.raw).slice(0, 120)}`,
        );
      if (wrote && stored.prefs && !samePrefs(stored.prefs, after.prefs)) {
        violations.push(
          `recoverable: kv ${stored.raw} != memory ${JSON.stringify(after.prefs)} after retry`,
        );
      }
      const owned = trayOwnedIds();
      const activeAfter = after.prefs.enabled && after.permission === 'granted';
      if (activeAfter) {
        const expected = await expectedPlanIds(after.prefs);
        if (JSON.stringify(owned) !== JSON.stringify(expected))
          violations.push(
            `recoverable: tray ${JSON.stringify(owned)} != plan ${JSON.stringify(expected)} after retry`,
          );
      } else if (owned.length && after.hydrated) {
        violations.push(
          `recoverable: reminders off/paused after retry but tray holds ${JSON.stringify(owned)}`,
        );
      }
      if (!mockCtl.tray.has(FOREIGN_TRAY_ID))
        violations.push(
          'corrupt-tray: foreign notification cancelled during retry',
        );
      if (unhandled.length > 0 && !violations.some(v => v.startsWith('crash')))
        violations.push(
          `crash: unhandled rejection during retry ${unhandled[0]}`,
        );
      if (
        consoleErrors.length > 0 &&
        !violations.some(v => v.startsWith('crash'))
      )
        violations.push(
          `crash: console.error during retry ${consoleErrors[0]}`,
        );
    } else {
      // Owner race: the original owner's row stays canonical, the other
      // owner's row is untouched, a signed-out process keeps nothing queued.
      await advance(10_000);
      const stored = readStoredPrefs(real, OWNER);
      if (!stored.canonical)
        violations.push(
          `corrupt-persisted: ${JSON.stringify(stored.raw).slice(0, 120)}`,
        );
      const otherRow = readKv(real).find(
        r => r.key === notificationPrefsKeyForOwner(OTHER_OWNER),
      );
      if (otherRow?.value !== otherRaw)
        violations.push(
          'corrupt-persisted: another account’s prefs row changed',
        );
      if (
        getActiveDataOwner() === SIGNED_OUT_DATA_OWNER &&
        trayOwnedIds().length
      )
        violations.push(
          `fake-success: signed out but tray holds ${JSON.stringify(trayOwnedIds())}`,
        );
      const st = useNotificationStore.getState();
      if (st.ownerKey !== getActiveDataOwner())
        violations.push(
          `corrupt-state: store owner ${st.ownerKey} != active ${getActiveDataOwner()}`,
        );
      if (unhandled.length)
        violations.push(`crash: unhandled rejection ${unhandled[0]}`);
      if (consoleErrors.length)
        violations.push(`crash: console.error ${consoleErrors[0]}`);
    }
  } catch (error) {
    actError = String((error as Error)?.stack ?? error).slice(0, 600);
    violations.push(
      `crash: ${String((error as Error)?.message ?? error).slice(0, 200)}`,
    );
  } finally {
    try {
      const r = renderer as ReactTestRenderer | null;
      if (r) {
        await act(async () => {
          r.unmount();
        });
      }
    } catch (error) {
      violations.push(
        `crash: unmount ${String((error as Error)?.message ?? error)}`,
      );
    }
    const integrity = integrityCheck(real);
    if (integrity !== 'ok')
      violations.push(`corrupt-persisted: integrity_check ${integrity}`);
    for (const row of readKv(real)) {
      if (typeof row.value !== 'string') {
        violations.push(
          `corrupt-persisted: kv ${row.key} holds ${typeof row.value}`,
        );
      }
    }
    detail['kvKeys'] = readKv(real).map(r => r.key);
    if (actError) detail['error'] = actError;
    if (consoleErrors.length)
      detail['consoleErrors'] = consoleErrors.slice(0, 3);
    getDb().close();
    real.close();
    mockCtl.real = null;
    mockCtl.clear();
    openSettingsSpy.mockRestore();
    dateNowSpy?.mockRestore();
    consoleErrorSpy.mockRestore();
    process.off('unhandledRejection', onUnhandled);
    jest.clearAllTimers();
    jest.useRealTimers();
    setActiveDataOwner(OWNER);
    resetStore();
  }

  return {
    id: entry.id,
    seed,
    faults: entry.faults.map(faultId),
    phase: entry.phase,
    start: pick.start,
    action: pick.action,
    detail: { ...detail, streakDays: pick.streakDays },
    outcome: violations.length ? 'BROKEN' : 'HELD',
    violations,
    observations,
    durationMs: Date.now() - startedAt,
    replay: replayCommand(entry.id),
  };
}

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------

const catalog = buildCatalog();
const randomEntries: CatalogEntry[] = [];
for (let i = 0; i < STRESS_ITER; i++) {
  randomEntries.push(randomCatalogEntry(mulberry32(seedFor(`random#${i}`)), i));
}
const scenarios = [...catalog, ...randomEntries].filter(
  e => !STRESS_ONLY || e.id.includes(STRESS_ONLY),
);

const results: ScenarioResult[] = [];

afterAll(() => {
  const held = results.filter(r => r.outcome === 'HELD').length;
  const broken = results.filter(r => r.outcome === 'BROKEN');
  const observationKinds = new Map<string, string[]>();
  for (const r of results) {
    for (const o of r.observations) {
      const kind = o.split(':')[0] ?? o;
      const list = observationKinds.get(kind) ?? [];
      list.push(r.id);
      observationKinds.set(kind, list);
    }
  }
  const table = {
    suite: SUITE_FILE,
    baseSeed: STRESS_BASE_SEED,
    iterations: STRESS_ITER,
    catalogSize: catalog.length,
    distinctFaults: new Set(catalog.flatMap(e => e.faults.map(faultId))).size,
    executed: results.length,
    held,
    broken: broken.length,
    brokenIds: broken.map(r => `${r.id} seed=${r.seed}`),
    observations: Object.fromEntries(
      [...observationKinds.entries()].map(([k, ids]) => [k, ids]),
    ),
    rows: results,
  };
  fs.mkdirSync(pathModule.dirname(STRESS_OUT), { recursive: true });
  fs.writeFileSync(STRESS_OUT, JSON.stringify(table, null, 2));
});

describe('NotificationSettingsScreen failure injection (real navigator, real store, real SQLite)', () => {
  it('has a catalog with at least 60 distinct injected faults', () => {
    const distinct = new Set(catalog.flatMap(e => e.faults.map(faultId)));
    expect(distinct.size).toBeGreaterThanOrEqual(60);
  });

  for (const entry of scenarios) {
    const seed = seedFor(entry.id);
    it(`[${entry.id}] seed=${seed}`, async () => {
      const result = await runScenario(entry, seed);
      results.push(result);
      if (result.violations.length) {
        console.log(
          JSON.stringify(
            {
              id: result.id,
              seed,
              start: result.start,
              action: result.action,
              violations: result.violations,
              detail: result.detail,
            },
            null,
            1,
          ).slice(0, 4000),
        );
      }
      expect(result.violations).toEqual([]);
    });
  }
});
