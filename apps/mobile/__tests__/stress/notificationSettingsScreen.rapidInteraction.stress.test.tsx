/**
 * STRESS — NotificationSettingsScreen under rapid / concurrent interaction.
 *
 * The screen is rendered inside the REAL React Navigation container and the
 * REAL native-stack navigator (same screenOptions as RootNavigator), with the
 * real notificationStore, the real SchedulerPort adapter (service.ts) and the
 * real repository/consistency code. Only the native edges are faked:
 *   - react-native-notify-kit (the notification TurboModule) → an in-memory
 *     tray with FIFO completion and seeded per-call latency / faults,
 *   - the SQLite handle behind getDb() → an in-memory kv + local_shot table
 *     with FIFO completion and seeded latency / write faults,
 *   - react-native-safe-area-context → the library's own jest mock,
 *   - Linking.openSettings → spy routed to the fake native,
 *   - global fetch → spy that must never be called (the screen is local-only).
 *
 * Every burst is generated from a seed (mulberry32) and is replayable:
 *   STRESS_ITER=<n>        number of bursts in the campaign (default 24)
 *   STRESS_SEED=<n>        campaign base seed (default 20260904)
 *   STRESS_ONLY_SEED=<n>   replay exactly one burst seed (verbose trace)
 *   STRESS_SEEDS=a,b,c     replay exactly these burst seeds
 *   STRESS_REPEAT=<n>      run every selected seed n times (flake rate)
 *   STRESS_OUT=<path>      write the seed → outcome JSON table there
 *
 * A "tap" is one discrete press event: the control is re-queried on the
 * focused route, a disabled / absent control is a MISS (the real Pressable
 * would not fire), and React flushes between taps exactly as RN's per-event
 * batchedUpdates does. Bursts therefore model double/triple taps, taps during
 * in-flight native work, back-during-async, spam navigation and rapid
 * alternation between controls — not impossible same-batch dispatch.
 */
import React from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  DefaultTheme,
  NavigationContainer,
  createNavigationContainerRef,
  useNavigation,
} from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import * as fs from 'fs';

import type { LocalDb } from '../../src/data/db';

// ---------------------------------------------------------------------------
// Native fakes (the only mocked surface). `mockNative` is read lazily.
// ---------------------------------------------------------------------------

type NativeOutcome = 'grant' | 'deny' | 'throw';

class FifoLatencyQueue {
  private tail: Promise<void> = Promise.resolve();
  inFlight = 0;

  run<T>(latencyMs: number, op: () => T): Promise<T> {
    const prev = this.tail;
    this.inFlight += 1;
    const p = (async () => {
      await prev;
      await new Promise<void>(resolve => setTimeout(resolve, latencyMs));
      return op();
    })();
    this.tail = p.then(
      () => undefined,
      () => undefined,
    );
    void p.finally(() => {
      this.inFlight -= 1;
    });
    return p;
  }
}

interface FaultProfile {
  /** Latency range (ms) of one native notification op. */
  notifeeLatencyMin: number;
  notifeeLatencyMax: number;
  /** Latency range (ms) of one SQLite statement. */
  dbLatencyMin: number;
  dbLatencyMax: number;
  /** Probability that a kv write throws. */
  kvWriteFailP: number;
  /** Probability that createTriggerNotification throws. */
  createFailP: number;
  /** Probability that getNotificationSettings throws. */
  settingsReadFailP: number;
  /** Probability that Linking.openSettings rejects. */
  openSettingsFailP: number;
  /** Outcome of the k-th system permission prompt. */
  requestOutcomes: NativeOutcome[];
}

interface TrayEntry {
  id: string;
  createdSeq: number;
}

class FakeNative {
  readonly notifeeQueue = new FifoLatencyQueue();
  readonly dbQueue = new FifoLatencyQueue();
  readonly tray = new Map<string, TrayEntry>();
  readonly kv = new Map<string, string>();
  readonly log: string[] = [];
  /** AuthorizationStatus: -1 undetermined, 0 denied, 1 authorized. */
  authorizationStatus: number;
  requestPermissionCalls = 0;
  requestPermissionConcurrent = 0;
  requestPermissionMaxConcurrent = 0;
  settingsReadCalls = 0;
  openSettingsCalls = 0;
  kvWriteAttempts: Array<{ key: string; ok: boolean }> = [];
  createAttempts = 0;
  createFailures = 0;
  cancelCalls = 0;
  private seq = 0;
  private outcomeIndex = 0;

  constructor(
    private readonly rng: Rng,
    readonly profile: FaultProfile,
    initialAuthorizationStatus: number,
    shotRows: Record<string, unknown>[],
  ) {
    this.authorizationStatus = initialAuthorizationStatus;
    this.shotRows = shotRows;
  }

  private readonly shotRows: Record<string, unknown>[];

  private notifeeLatency(): number {
    return this.rng.int(
      this.profile.notifeeLatencyMin,
      this.profile.notifeeLatencyMax,
    );
  }

  private dbLatency(): number {
    return this.rng.int(this.profile.dbLatencyMin, this.profile.dbLatencyMax);
  }

  nextRequestOutcome(): NativeOutcome {
    const outcomes = this.profile.requestOutcomes;
    const outcome = outcomes[Math.min(this.outcomeIndex, outcomes.length - 1)];
    this.outcomeIndex += 1;
    return outcome ?? 'grant';
  }

  peekRequestOutcome(k: number): NativeOutcome {
    const outcomes = this.profile.requestOutcomes;
    return outcomes[Math.min(k, outcomes.length - 1)] ?? 'grant';
  }

  // --- notifee surface -----------------------------------------------------

  getNotificationSettings(): Promise<{ authorizationStatus: number }> {
    this.settingsReadCalls += 1;
    const fail = this.rng.chance(this.profile.settingsReadFailP);
    const status = this.authorizationStatus;
    return this.notifeeQueue.run(this.notifeeLatency(), () => {
      this.log.push(
        `native.getNotificationSettings -> ${fail ? 'throw' : status}`,
      );
      if (fail) throw new Error('settings read failed');
      return { authorizationStatus: status };
    });
  }

  /**
   * iOS semantics: the system prompt is shown only while authorization is
   * undetermined, it is MODAL (the app receives no touches until it is
   * answered — `tap()` reports `miss:modal`), and concurrent requests share
   * the pending answer. Once determined, requestPermission just reports the
   * current status without prompting.
   */
  promptOpen = false;
  promptsShown = 0;
  private pendingPrompt: Promise<{ authorizationStatus: number }> | null = null;

  requestPermission(): Promise<{ authorizationStatus: number }> {
    this.requestPermissionCalls += 1;
    this.requestPermissionConcurrent += 1;
    this.requestPermissionMaxConcurrent = Math.max(
      this.requestPermissionMaxConcurrent,
      this.requestPermissionConcurrent,
    );
    let p: Promise<{ authorizationStatus: number }>;
    if (this.pendingPrompt) {
      p = this.pendingPrompt;
      this.log.push('native.requestPermission -> joins pending prompt');
    } else if (this.authorizationStatus !== -1) {
      const status = this.authorizationStatus;
      p = this.notifeeQueue.run(this.notifeeLatency(), () => {
        this.log.push(
          `native.requestPermission -> already ${status} (no prompt)`,
        );
        return { authorizationStatus: status };
      });
    } else {
      const outcome = this.nextRequestOutcome();
      this.promptsShown += 1;
      this.promptOpen = outcome !== 'throw';
      p = this.notifeeQueue.run(this.notifeeLatency(), () => {
        this.log.push(`native.requestPermission -> prompt ${outcome}`);
        this.promptOpen = false;
        this.pendingPrompt = null;
        if (outcome === 'throw') throw new Error('prompt failed');
        this.authorizationStatus = outcome === 'grant' ? 1 : 0;
        return { authorizationStatus: this.authorizationStatus };
      });
      if (outcome !== 'throw') this.pendingPrompt = p;
    }
    void p.finally(() => {
      this.requestPermissionConcurrent -= 1;
    });
    return p;
  }

  createChannel(): Promise<string> {
    return this.notifeeQueue.run(this.notifeeLatency(), () => 'reminders');
  }

  createTriggerNotification(notification: { id?: string }): Promise<string> {
    this.createAttempts += 1;
    const fail = this.rng.chance(this.profile.createFailP);
    return this.notifeeQueue.run(this.notifeeLatency(), () => {
      const id = notification.id ?? 'mock-id';
      this.log.push(`native.createTrigger(${id})${fail ? ' -> throw' : ''}`);
      if (fail) {
        this.createFailures += 1;
        throw new Error('create failed');
      }
      this.seq += 1;
      this.tray.set(id, { id, createdSeq: this.seq });
      return id;
    });
  }

  getTriggerNotificationIds(): Promise<string[]> {
    return this.notifeeQueue.run(this.notifeeLatency(), () => {
      const ids = [...this.tray.keys()];
      this.log.push(`native.getTriggerIds -> [${ids.join(',')}]`);
      return ids;
    });
  }

  cancelTriggerNotification(id: string): Promise<void> {
    this.cancelCalls += 1;
    return this.notifeeQueue.run(this.notifeeLatency(), () => {
      this.log.push(`native.cancelTrigger(${id})`);
      this.tray.delete(id);
    });
  }

  openNotificationSettings(): Promise<void> {
    return this.openSettings();
  }

  openSettings(): Promise<void> {
    this.openSettingsCalls += 1;
    const fail = this.rng.chance(this.profile.openSettingsFailP);
    return this.notifeeQueue.run(this.notifeeLatency(), () => {
      this.log.push(`native.openSettings${fail ? ' -> reject' : ''}`);
      if (fail) throw new Error('cannot open settings');
    });
  }

  // --- SQLite surface ------------------------------------------------------

  readonly db: LocalDb = {
    execute: (sql: string, params: unknown[] = []) => {
      const fail =
        sql.startsWith('INSERT OR REPLACE INTO kv') &&
        this.rng.chance(this.profile.kvWriteFailP);
      return this.dbQueue.run(this.dbLatency(), () => {
        if (sql.startsWith('SELECT value FROM kv')) {
          const value = this.kv.get(String(params[0]));
          return { rows: value === undefined ? [] : [{ value }] };
        }
        if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
          const key = String(params[0]);
          this.kvWriteAttempts.push({ key, ok: !fail });
          this.log.push(`db.setKv(${key})${fail ? ' -> throw' : ''}`);
          if (fail) throw new Error('disk full');
          this.kv.set(key, String(params[1]));
          return { rows: [] };
        }
        if (/FROM local_shot/.test(sql)) {
          return { rows: this.shotRows };
        }
        return { rows: [] };
      });
    },
    close: () => {},
  };

  get inFlight(): number {
    return this.notifeeQueue.inFlight + this.dbQueue.inFlight;
  }
}

let mockNative: FakeNative | null = null;
const native = (): FakeNative => {
  if (!mockNative) throw new Error('FakeNative not installed');
  return mockNative;
};

jest.mock('react-native-notify-kit', () => ({
  __esModule: true,
  default: {
    requestPermission: () => native().requestPermission(),
    getNotificationSettings: () => native().getNotificationSettings(),
    createChannel: () => native().createChannel(),
    createTriggerNotification: (notification: { id?: string }) =>
      native().createTriggerNotification(notification),
    getTriggerNotificationIds: () => native().getTriggerNotificationIds(),
    cancelTriggerNotification: (id: string) =>
      native().cancelTriggerNotification(id),
    openNotificationSettings: () => native().openNotificationSettings(),
    getInitialNotification: async () => null,
    onForegroundEvent: () => () => {},
    onBackgroundEvent: () => {},
  },
  AndroidImportance: { DEFAULT: 3, HIGH: 4 },
  RepeatFrequency: { NONE: -1, HOURLY: 0, DAILY: 1, WEEKLY: 2 },
  TriggerType: { TIMESTAMP: 0, INTERVAL: 1 },
  EventType: { DISMISSED: 0, PRESS: 1, DELIVERED: 3 },
}));

jest.mock('../../src/data/db', () => ({
  getDb: () => native().db,
}));

jest.mock(
  'react-native-safe-area-context',
  () =>
    jest.requireActual<{ default: unknown }>(
      'react-native-safe-area-context/jest/mock',
    ).default,
);

import { NotificationSettingsScreen } from '../../src/screens/NotificationSettingsScreen';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import { buildNotificationPlan } from '../../src/notifications/plan';
import {
  DEFAULT_NOTIFICATION_PREFS,
  notificationPrefsKeyForOwner,
  type NotificationPrefs,
} from '../../src/notifications/types';
import { computeConsistencySnapshot } from '../../src/consistency/store';
import { setActiveDataOwner } from '../../src/data/accountScope';
import type { RootStackParams } from '../../src/navigation/params';
import { color } from '../../src/design/tokens';

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) — every burst derives from a single 32-bit seed.
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
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  chance(p: number): boolean {
    return p > 0 && this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }
}

// ---------------------------------------------------------------------------
// Real navigator host: the Tabs route stands in for Settings' reminder row
// (`navigation.navigate('NotificationSettings')`, SettingsScreen.tsx:404).
// ---------------------------------------------------------------------------

const Stack = createNativeStackNavigator<RootStackParams>();
const navigationRef = createNavigationContainerRef<RootStackParams>();
const theme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: color.surface,
    primary: color.court,
  },
};

const HOST_ROW_LABEL = 'Notifications';

function TabsHost() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParams>>();
  return (
    <View>
      <Text>Settings host</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={HOST_ROW_LABEL}
        onPress={() => navigation.navigate('NotificationSettings')}
      >
        <Text>Notifications row</Text>
      </Pressable>
    </View>
  );
}

function StressApp() {
  return (
    <NavigationContainer ref={navigationRef} theme={theme}>
      <Stack.Navigator
        screenOptions={{
          headerShown: false,
          animation: 'fade_from_bottom',
          contentStyle: { backgroundColor: color.surface },
        }}
      >
        <Stack.Screen
          name="Tabs"
          component={TabsHost}
          options={{ headerShown: false, animation: 'none' }}
        />
        <Stack.Screen
          name="NotificationSettings"
          component={NotificationSettingsScreen}
          options={{ title: 'Notifications' }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

// ---------------------------------------------------------------------------
// Screen controls and the intent model.
// ---------------------------------------------------------------------------

const TOGGLE_FIELDS = {
  'All reminders': 'enabled',
  'Practice nudge': 'practiceReminder',
  'Streak defense': 'streakDefense',
  'Weekly recap': 'weeklyRecap',
  'Welcome back': 'comeback',
} as const;
type ToggleLabel = keyof typeof TOGGLE_FIELDS;

const PRESETS = {
  'Morning, 7:30 AM': 7 * 60 + 30,
  'Midday, 12:00 PM': 12 * 60,
  'Evening, 5:30 PM': 17 * 60 + 30,
  'Night, 7:30 PM': 19 * 60 + 30,
} as const;
type PresetLabel = keyof typeof PRESETS;

const SCREEN_LABELS = [
  'Back',
  'Turn on reminders',
  'Open system settings',
  'Check again',
  ...(Object.keys(TOGGLE_FIELDS) as ToggleLabel[]),
  ...(Object.keys(PRESETS) as PresetLabel[]),
  'Reminder 30 minutes earlier',
  'Reminder 30 minutes later',
] as const;
type ScreenLabel = (typeof SCREEN_LABELS)[number];
type Label = ScreenLabel | typeof HOST_ROW_LABEL;

const ALERT_COPIES = [
  'Reminders weren’t turned on',
  'Couldn’t open Settings from here',
  'This change couldn’t be saved on this phone',
  'Reminders couldn’t be scheduled on this phone',
  'Couldn’t check notification permission',
  'Notifications are off in system settings',
] as const;

type PrefsModel = Omit<NotificationPrefs, 'version'>;

interface IntentModel {
  prefs: PrefsModel;
  depth: 1 | 2;
  focuses: number;
  turnOnTaps: number;
  promptsRequested: number;
  openSettingsTaps: number;
  checkAgainTaps: number;
  lastRequestOutcome: NativeOutcome | null;
}

function isToggle(label: Label): label is ToggleLabel {
  return label in TOGGLE_FIELDS;
}
function isPreset(label: Label): label is PresetLabel {
  return label in PRESETS;
}

// ---------------------------------------------------------------------------
// Rendering / input helpers.
// ---------------------------------------------------------------------------

async function flushMicrotasks(ticks = 24): Promise<void> {
  for (let i = 0; i < ticks; i += 1) await Promise.resolve();
}

async function settle(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
  });
}

/**
 * Drains the store's async chains: flush microtasks, fire pending fake timers
 * (native latency), repeat until no fake native op is in flight for two
 * consecutive rounds. Ambient library timers (react-native-screens'
 * DelayedFreeze, React Navigation's linking guard) are not pending user work
 * and are ignored.
 */
async function quiesce(fake: FakeNative): Promise<boolean> {
  let idleRounds = 0;
  for (let i = 0; i < 400; i += 1) {
    await settle();
    idleRounds = fake.inFlight === 0 ? idleRounds + 1 : 0;
    if (idleRounds >= 2) return true;
    await act(async () => {
      jest.runOnlyPendingTimers();
      await flushMicrotasks();
    });
  }
  return false;
}

function isDescendant(
  node: TestRenderer.ReactTestInstance,
  ancestor: TestRenderer.ReactTestInstance,
): boolean {
  let cursor = node.parent;
  while (cursor) {
    if (cursor === ancestor) return true;
    cursor = cursor.parent;
  }
  return false;
}

/** Outermost composite nodes carrying the label + onPress (one per control). */
function pressables(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const matches = renderer.root.findAll(
    node =>
      typeof node.type !== 'string' &&
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
  return matches.filter(
    node => !matches.some(other => other !== node && isDescendant(node, other)),
  );
}

function textIncludes(
  renderer: TestRenderer.ReactTestRenderer,
  needle: string,
): number {
  return renderer.root.findAllByType(Text).filter(node => {
    const children = Array.isArray(node.props.children)
      ? node.props.children
      : [node.props.children];
    return children.some(
      (c: unknown) => typeof c === 'string' && c.includes(needle),
    );
  }).length;
}

function currentRoute(): string {
  return navigationRef.isReady()
    ? (navigationRef.getCurrentRoute()?.name ?? 'none')
    : 'none';
}

function reachable(label: Label): boolean {
  const route = currentRoute();
  if (label === HOST_ROW_LABEL) return route === 'Tabs';
  return route === 'NotificationSettings';
}

type TapResult =
  'hit' | 'miss:absent' | 'miss:disabled' | 'miss:covered' | 'miss:modal';

/** One discrete press event with the real Pressable's gating. */
async function tap(
  renderer: TestRenderer.ReactTestRenderer,
  label: Label,
  fake: FakeNative,
): Promise<TapResult> {
  if (fake.promptOpen) return 'miss:modal';
  if (!reachable(label)) return 'miss:covered';
  const nodes = pressables(renderer, label);
  const node = nodes[0];
  if (!node) return 'miss:absent';
  if (node.props.disabled === true) return 'miss:disabled';
  const onPress = node.props.onPress as (() => void) | undefined;
  if (typeof onPress !== 'function') return 'miss:absent';
  act(() => {
    onPress();
  });
  return 'hit';
}

const ALL_LABELS: readonly Label[] = [HOST_ROW_LABEL, ...SCREEN_LABELS];

/** Controls a user can currently press (present, enabled, on the focused route). */
function visibleControls(renderer: TestRenderer.ReactTestRenderer): Label[] {
  return ALL_LABELS.filter(label => {
    if (!reachable(label)) return false;
    const node = pressables(renderer, label)[0];
    return node !== undefined && node.props.disabled !== true;
  });
}

function resolveTapTarget(
  renderer: TestRenderer.ReactTestRenderer,
  step: Extract<Step, { kind: 'tap' }>,
): Label {
  const pool = step.anyControl ? ALL_LABELS : visibleControls(renderer);
  const list = pool.length ? pool : ALL_LABELS;
  const label =
    list[Math.min(list.length - 1, Math.floor(step.u * list.length))];
  return label ?? HOST_ROW_LABEL;
}

function applyIntent(model: IntentModel, label: Label, fake: FakeNative) {
  if (label === HOST_ROW_LABEL) {
    model.depth = 2;
    model.focuses += 1;
    return;
  }
  if (label === 'Back') {
    model.depth = 1;
    return;
  }
  if (label === 'Turn on reminders') {
    const outcome: NativeOutcome =
      fake.authorizationStatus === 1
        ? 'grant'
        : fake.authorizationStatus === 0
          ? 'deny'
          : fake.peekRequestOutcome(model.promptsRequested++);
    model.turnOnTaps += 1;
    model.lastRequestOutcome = outcome;
    if (outcome === 'grant') {
      model.prefs.enabled = true;
      model.prefs.promptDismissed = true;
    }
    return;
  }
  if (label === 'Open system settings') {
    model.openSettingsTaps += 1;
    return;
  }
  if (label === 'Check again') {
    model.checkAgainTaps += 1;
    return;
  }
  if (isToggle(label)) {
    const field = TOGGLE_FIELDS[label];
    model.prefs[field] = !model.prefs[field];
    return;
  }
  if (isPreset(label)) {
    model.prefs.practiceReminderMinutes = PRESETS[label];
    return;
  }
  if (label === 'Reminder 30 minutes earlier') {
    model.prefs.practiceReminderMinutes =
      (model.prefs.practiceReminderMinutes - 30 + 1440) % 1440;
    return;
  }
  if (label === 'Reminder 30 minutes later') {
    model.prefs.practiceReminderMinutes =
      (model.prefs.practiceReminderMinutes + 30) % 1440;
  }
}

// ---------------------------------------------------------------------------
// Scenario generation.
// ---------------------------------------------------------------------------

/**
 * `tap` resolves its target at execution time: with `anyControl=false` the
 * u∈[0,1) roll indexes the controls that are currently present AND enabled on
 * the focused route (what a user can actually see); with `anyControl=true`
 * it indexes the full label list (models pressing a control that is mid-
 * transition, disabled or already gone). Resolution is deterministic because
 * the whole run is (seeded rng + fake timers).
 */
type Step =
  | { kind: 'tap'; u: number; anyControl: boolean; times: number }
  | { kind: 'press'; label: Label; times: number }
  | { kind: 'advance'; ms: number }
  | { kind: 'flush' }
  | { kind: 'system'; authorizationStatus: number };

interface Scenario {
  seed: number;
  owner: string;
  initialPrefs: NotificationPrefs;
  initialAuthorizationStatus: number;
  initialStorePermission: 'granted' | 'denied' | 'undetermined' | 'unknown';
  profile: FaultProfile;
  steps: Step[];
  /** Notifications already pending in the system tray at start. */
  initialTrayIds?: string[];
}

const OWNERS = [
  'device-guest',
  '55555555-5555-4555-8555-555555555555',
] as const;

function generateScenario(seed: number): Scenario {
  const rng = new Rng(seed);
  const faulty = rng.chance(0.4);
  const profile: FaultProfile = {
    notifeeLatencyMin: 0,
    notifeeLatencyMax: rng.pick([0, 5, 20, 60]),
    dbLatencyMin: 0,
    dbLatencyMax: rng.pick([0, 5, 20]),
    kvWriteFailP: faulty ? rng.pick([0, 0.15, 0.5]) : 0,
    createFailP: faulty ? rng.pick([0, 0.1, 0.3]) : 0,
    settingsReadFailP: faulty ? rng.pick([0, 0.2]) : 0,
    openSettingsFailP: faulty ? rng.pick([0, 0.5, 1]) : 0,
    requestOutcomes: Array.from({ length: 4 }, () =>
      rng.pick<NativeOutcome>(['grant', 'grant', 'grant', 'deny', 'throw']),
    ),
  };
  const initialAuthorizationStatus = rng.pick([-1, -1, 0, 1, 1]);
  const enabled = initialAuthorizationStatus === 1 ? rng.chance(0.6) : false;
  const initialPrefs: NotificationPrefs = {
    ...DEFAULT_NOTIFICATION_PREFS,
    enabled,
    promptDismissed: enabled || rng.chance(0.3),
    practiceReminder: rng.chance(0.8),
    practiceReminderMinutes: rng.pick([450, 720, 1050, 1170, 0, 1410, 600]),
    streakDefense: rng.chance(0.7),
    weeklyRecap: rng.chance(0.7),
    comeback: rng.chance(0.7),
  };
  const initialStorePermission = rng.chance(0.15)
    ? 'unknown'
    : initialAuthorizationStatus === 1
      ? 'granted'
      : initialAuthorizationStatus === 0
        ? 'denied'
        : 'undetermined';

  const stepCount = rng.int(8, 40);
  const steps: Step[] = [];
  // Every burst starts on the host and enters the screen at least once.
  steps.push({ kind: 'tap', u: 0, anyControl: false, times: rng.int(1, 3) });
  for (let i = 0; i < stepCount; i += 1) {
    const roll = rng.next();
    if (roll < 0.62) {
      steps.push({
        kind: 'tap',
        u: rng.next(),
        anyControl: rng.chance(0.2),
        times: rng.chance(0.35) ? rng.int(2, 3) : 1,
      });
    } else if (roll < 0.85) {
      steps.push({ kind: 'advance', ms: rng.int(1, 80) });
    } else if (roll < 0.95) {
      steps.push({ kind: 'flush' });
    } else {
      steps.push({ kind: 'system', authorizationStatus: rng.pick([0, 1]) });
    }
  }
  return {
    seed,
    owner: rng.pick(OWNERS),
    initialPrefs,
    initialAuthorizationStatus,
    initialStorePermission,
    profile,
    steps,
  };
}

// ---------------------------------------------------------------------------
// Execution + invariants.
// ---------------------------------------------------------------------------

interface BurstStats {
  /** Tap steps with 2–3 presses of the same target. */
  multiTapSteps: number;
  /** Accepted presses while a native/db op was in flight. */
  hitsDuringAsync: number;
  /** Accepted Back presses while a native/db op was in flight. */
  backDuringAsync: number;
  /** Accepted host→screen navigations. */
  navigations: number;
  /** Peak number of overlapping requestPermission calls (no prompt open). */
  overlappingPermissionRequests: number;
}

interface BurstOutcome {
  seed: number;
  ok: boolean;
  violations: string[];
  taps: number;
  hits: number;
  steps: number;
  stats: BurstStats;
  quiesced: boolean;
  trace: string[];
  profile: FaultProfile;
  initial: {
    prefs: NotificationPrefs;
    authorizationStatus: number;
    storePermission: Scenario['initialStorePermission'];
    owner: string;
  };
  final: {
    prefs: NotificationPrefs;
    permission: string;
    persistFailed: boolean;
    scheduleFailed: boolean;
    routes: string[];
    tray: string[];
    requestPermissionCalls: number;
    settingsReadCalls: number;
    openSettingsCalls: number;
  };
}

const consoleErrors: string[] = [];
const consoleWarns: string[] = [];
const unhandled: string[] = [];
const fetchSpy = jest.fn();

const SHOT_ROWS = (nowMs: number): Record<string, unknown>[] => {
  const day = 24 * 60 * 60 * 1000;
  return [
    {
      id: 'shot-yesterday',
      session_id: null,
      shot_type: 'dink',
      captured_at: new Date(nowMs - day).toISOString(),
      overall_score: 71,
      result_kind: 'scored',
    },
    {
      id: 'shot-today',
      session_id: null,
      shot_type: 'dink',
      captured_at: new Date(nowMs - 60 * 60 * 1000).toISOString(),
      overall_score: 74,
      result_kind: 'scored',
    },
  ];
};

/** Awaits a promise whose chain goes through the fake native (timers). */
async function pumped<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  void promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  for (let i = 0; i < 400 && !done; i += 1) {
    await flushMicrotasks();
    jest.runOnlyPendingTimers();
  }
  return promise;
}

async function expectedPlanIds(prefs: NotificationPrefs): Promise<string[]> {
  const snapshot = await pumped(computeConsistencySnapshot());
  return buildNotificationPlan(prefs, {
    nowMs: Date.now(),
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
  })
    .map(item => item.id)
    .sort();
}

function stripVersion(prefs: NotificationPrefs): PrefsModel {
  return {
    enabled: prefs.enabled,
    practiceReminder: prefs.practiceReminder,
    practiceReminderMinutes: prefs.practiceReminderMinutes,
    streakDefense: prefs.streakDefense,
    weeklyRecap: prefs.weeklyRecap,
    comeback: prefs.comeback,
    promptDismissed: prefs.promptDismissed,
  };
}

async function runBurst(scenario: Scenario): Promise<BurstOutcome> {
  const rng = new Rng(scenario.seed ^ 0x9e3779b9);
  const fake = new FakeNative(
    rng,
    scenario.profile,
    scenario.initialAuthorizationStatus,
    SHOT_ROWS(Date.now()),
  );
  for (const id of scenario.initialTrayIds ?? []) {
    fake.tray.set(id, { id, createdSeq: 0 });
  }
  mockNative = fake;
  consoleErrors.length = 0;
  consoleWarns.length = 0;
  unhandled.length = 0;
  fetchSpy.mockClear();

  setActiveDataOwner(scenario.owner);
  fake.kv.set(
    notificationPrefsKeyForOwner(scenario.owner),
    JSON.stringify(scenario.initialPrefs),
  );
  useNotificationStore.setState({
    hydrated: true,
    ownerKey: scenario.owner,
    prefs: { ...scenario.initialPrefs },
    permission: scenario.initialStorePermission,
    persistFailed: false,
    scheduleFailed: false,
  });

  const model: IntentModel = {
    prefs: stripVersion(scenario.initialPrefs),
    depth: 1,
    focuses: 0,
    turnOnTaps: 0,
    promptsRequested: 0,
    openSettingsTaps: 0,
    checkAgainTaps: 0,
    lastRequestOutcome: null,
  };
  const trace: string[] = [];
  const violations: string[] = [];
  let taps = 0;
  let hits = 0;
  const stats: BurstStats = {
    multiTapSteps: 0,
    hitsDuringAsync: 0,
    backDuringAsync: 0,
    navigations: 0,
    overlappingPermissionRequests: 0,
  };

  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<StressApp />);
  });
  await settle();

  const doTap = async (label: Label) => {
    taps += 1;
    const busy = fake.inFlight > 0;
    const result = await tap(renderer, label, fake);
    if (result === 'hit') {
      hits += 1;
      if (busy) stats.hitsDuringAsync += 1;
      if (busy && label === 'Back') stats.backDuringAsync += 1;
      if (label === HOST_ROW_LABEL) stats.navigations += 1;
      applyIntent(model, label, fake);
    }
    trace.push(`tap ${label} -> ${result}${busy ? ' (native busy)' : ''}`);
    // Every discrete event checks the "no duplicate control / alert" invariant.
    checkDuplicates(renderer, violations, `after tap ${label}`);
  };

  for (const step of scenario.steps) {
    switch (step.kind) {
      case 'tap': {
        const label = resolveTapTarget(renderer, step);
        if (step.times > 1) stats.multiTapSteps += 1;
        for (let i = 0; i < step.times; i += 1) await doTap(label);
        break;
      }
      case 'press':
        if (step.times > 1) stats.multiTapSteps += 1;
        for (let i = 0; i < step.times; i += 1) await doTap(step.label);
        break;
      case 'advance':
        await act(async () => {
          jest.advanceTimersByTime(step.ms);
          await flushMicrotasks();
        });
        trace.push(`advance ${step.ms}ms`);
        break;
      case 'flush':
        await settle();
        trace.push('flush');
        break;
      case 'system':
        // iOS Settings can only flip an already-determined authorization.
        if (fake.authorizationStatus !== -1 && !fake.promptOpen) {
          fake.authorizationStatus = step.authorizationStatus;
          trace.push(`system permission -> ${step.authorizationStatus}`);
        } else {
          trace.push('system permission -> (undetermined, no-op)');
        }
        break;
    }
  }

  const quiesced = await quiesce(fake);
  stats.overlappingPermissionRequests = fake.requestPermissionMaxConcurrent;
  if (!quiesced) violations.push('did not quiesce: native ops still in flight');

  // ---- invariants -----------------------------------------------------------
  const state = useNotificationStore.getState();
  const rootState = navigationRef.isReady()
    ? navigationRef.getRootState()
    : undefined;
  const routes = rootState ? rootState.routes.map(r => r.name) : [];

  const expectedRoutes =
    model.depth === 2 ? ['Tabs', 'NotificationSettings'] : ['Tabs'];
  if (JSON.stringify(routes) !== JSON.stringify(expectedRoutes)) {
    violations.push(
      `navigation: routes ${JSON.stringify(routes)} expected ${JSON.stringify(expectedRoutes)}`,
    );
  }

  const finalPrefs = stripVersion(state.prefs);
  if (JSON.stringify(finalPrefs) !== JSON.stringify(model.prefs)) {
    violations.push(
      `prefs: store ${JSON.stringify(finalPrefs)} expected ${JSON.stringify(model.prefs)}`,
    );
  }

  if (fake.requestPermissionCalls !== model.turnOnTaps) {
    violations.push(
      `permit: ${fake.requestPermissionCalls} system prompts for ${model.turnOnTaps} accepted taps`,
    );
  }
  if (fake.promptsShown > model.promptsRequested) {
    violations.push(
      `permit: ${fake.promptsShown} system prompts shown for ${model.promptsRequested} prompting taps`,
    );
  }
  if (fake.openSettingsCalls !== model.openSettingsTaps) {
    violations.push(
      `settings: ${fake.openSettingsCalls} openSettings for ${model.openSettingsTaps} accepted taps`,
    );
  }
  const expectedSettingsReads = model.focuses + model.checkAgainTaps;
  if (fake.settingsReadCalls !== expectedSettingsReads) {
    violations.push(
      `permission reads: ${fake.settingsReadCalls} for ${model.focuses} focus + ${model.checkAgainTaps} recheck`,
    );
  }

  const turnOn = pressables(renderer, 'Turn on reminders')[0];
  if (turnOn && turnOn.props.disabled === true) {
    violations.push(
      'loading: "Turn on reminders" still disabled after quiescence',
    );
  }

  checkDuplicates(renderer, violations, 'after quiescence');

  if (!state.scheduleFailed) {
    const enabledAndGranted =
      state.prefs.enabled && state.permission === 'granted';
    const expectedTray = enabledAndGranted
      ? await expectedPlanIds(state.prefs)
      : [];
    const tray = [...fake.tray.keys()].sort();
    if (JSON.stringify(tray) !== JSON.stringify(expectedTray)) {
      violations.push(
        `tray: scheduled ${JSON.stringify(tray)} expected ${JSON.stringify(expectedTray)} for final prefs (scheduleFailed=false)`,
      );
    }
  } else if (fake.createFailures === 0) {
    violations.push('scheduleFailed=true without any native scheduling fault');
  }

  const lastWrite = fake.kvWriteAttempts.at(-1);
  if (lastWrite && !lastWrite.ok !== state.persistFailed) {
    violations.push(
      `persistFailed=${state.persistFailed} but last kv write ok=${lastWrite.ok}`,
    );
  }
  if (!lastWrite && state.persistFailed) {
    violations.push('persistFailed=true without any kv write');
  }
  if (!state.persistFailed) {
    const stored = fake.kv.get(notificationPrefsKeyForOwner(scenario.owner));
    const storedPrefs = stored
      ? (JSON.parse(stored) as NotificationPrefs)
      : null;
    if (
      !storedPrefs ||
      JSON.stringify(stripVersion(storedPrefs)) !== JSON.stringify(finalPrefs)
    ) {
      violations.push(
        `persistence: kv ${stored ?? 'null'} != store prefs ${JSON.stringify(finalPrefs)}`,
      );
    }
  }

  if (consoleErrors.length) {
    violations.push(
      `console.error x${consoleErrors.length}: ${consoleErrors[0]}`,
    );
  }
  if (consoleWarns.length) {
    violations.push(`console.warn x${consoleWarns.length}: ${consoleWarns[0]}`);
  }
  if (unhandled.length) {
    violations.push(
      `unhandled rejection x${unhandled.length}: ${unhandled[0]}`,
    );
  }
  if (fetchSpy.mock.calls.length) {
    violations.push(`network: fetch called ${fetchSpy.mock.calls.length}x`);
  }

  const outcome: BurstOutcome = {
    seed: scenario.seed,
    ok: violations.length === 0,
    violations,
    taps,
    hits,
    steps: scenario.steps.length,
    stats,
    quiesced,
    trace: [...trace, ...fake.log.map(l => `  ${l}`)],
    profile: scenario.profile,
    initial: {
      prefs: scenario.initialPrefs,
      authorizationStatus: scenario.initialAuthorizationStatus,
      storePermission: scenario.initialStorePermission,
      owner: scenario.owner,
    },
    final: {
      prefs: state.prefs,
      permission: state.permission,
      persistFailed: state.persistFailed,
      scheduleFailed: state.scheduleFailed,
      routes,
      tray: [...fake.tray.keys()].sort(),
      requestPermissionCalls: fake.requestPermissionCalls,
      settingsReadCalls: fake.settingsReadCalls,
      openSettingsCalls: fake.openSettingsCalls,
    },
  };

  await act(async () => {
    renderer.unmount();
  });
  await quiesce(fake);
  mockNative = null;
  return outcome;
}

function checkDuplicates(
  renderer: TestRenderer.ReactTestRenderer,
  violations: string[],
  when: string,
) {
  for (const label of SCREEN_LABELS) {
    const count = pressables(renderer, label).length;
    if (count > 1) {
      violations.push(`duplicate control "${label}" x${count} ${when}`);
    }
  }
  for (const copy of ALERT_COPIES) {
    const count = textIncludes(renderer, copy);
    if (count > 1)
      violations.push(`duplicate alert "${copy}" x${count} ${when}`);
  }
}

// ---------------------------------------------------------------------------
// Suite.
// ---------------------------------------------------------------------------

const ITER = Number(process.env.STRESS_ITER ?? 24);
const BASE_SEED = Number(process.env.STRESS_SEED ?? 20260904);
const ONLY_SEED = process.env.STRESS_ONLY_SEED
  ? Number(process.env.STRESS_ONLY_SEED)
  : null;
const SEEDS = process.env.STRESS_SEEDS
  ? process.env.STRESS_SEEDS.split(',').map(Number)
  : null;
const REPEAT = Number(process.env.STRESS_REPEAT ?? 1);
const OUT = process.env.STRESS_OUT ?? null;

const onUnhandled = (reason: unknown) => {
  unhandled.push(reason instanceof Error ? reason.message : String(reason));
};

let openSettingsSpy: jest.SpyInstance;

beforeAll(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(2026, 8, 4, 10, 0, 0));
  jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(' '));
  });
  jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    consoleWarns.push(args.map(String).join(' '));
  });
  openSettingsSpy = jest
    .spyOn(Linking, 'openSettings')
    .mockImplementation(() => native().openSettings());
  (globalThis as { fetch: unknown }).fetch = fetchSpy;
  process.on('unhandledRejection', onUnhandled);
});

afterAll(() => {
  process.off('unhandledRejection', onUnhandled);
  openSettingsSpy.mockRestore();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('NotificationSettingsScreen — rapid interaction stress (real navigator)', () => {
  it(
    `seeded campaign: ${
      ONLY_SEED !== null
        ? `seed ${ONLY_SEED}`
        : SEEDS
          ? `seeds ${SEEDS.join(',')}`
          : `${ITER} bursts from ${BASE_SEED}`
    }${REPEAT > 1 ? ` x${REPEAT}` : ''}`,
    async () => {
      const seeds =
        ONLY_SEED !== null
          ? [ONLY_SEED]
          : (SEEDS ?? Array.from({ length: ITER }, (_, i) => BASE_SEED + i));
      const results: BurstOutcome[] = [];
      const perSeed = new Map<number, { runs: number; failures: number }>();
      for (const seed of seeds) {
        for (let k = 0; k < REPEAT; k += 1) {
          const outcome = await runBurst(generateScenario(seed));
          results.push(outcome);
          const entry = perSeed.get(seed) ?? { runs: 0, failures: 0 };
          entry.runs += 1;
          if (!outcome.ok) entry.failures += 1;
          perSeed.set(seed, entry);
        }
      }
      const failed = results.filter(r => !r.ok);
      const verbose = ONLY_SEED !== null || SEEDS !== null;
      const table = {
        unit: 'scr-notificationsettingsscreen',
        lens: 'rapid-interaction',
        baseSeed: BASE_SEED,
        repeat: REPEAT,
        iterations: results.length,
        taps: results.reduce((n, r) => n + r.taps, 0),
        hits: results.reduce((n, r) => n + r.hits, 0),
        stats: {
          multiTapSteps: results.reduce((n, r) => n + r.stats.multiTapSteps, 0),
          hitsDuringAsync: results.reduce(
            (n, r) => n + r.stats.hitsDuringAsync,
            0,
          ),
          backDuringAsync: results.reduce(
            (n, r) => n + r.stats.backDuringAsync,
            0,
          ),
          navigations: results.reduce((n, r) => n + r.stats.navigations, 0),
          overlappingPermissionRequests: Math.max(
            0,
            ...results.map(r => r.stats.overlappingPermissionRequests),
          ),
        },
        failed: [...new Set(failed.map(r => r.seed))],
        failRateBySeed: Object.fromEntries(
          [...perSeed.entries()]
            .filter(([, v]) => v.failures > 0)
            .map(([seed, v]) => [seed, `${v.failures}/${v.runs}`]),
        ),
        results: results.map(r =>
          verbose || !r.ok ? r : { ...r, trace: undefined },
        ),
      };
      if (OUT) fs.writeFileSync(OUT, JSON.stringify(table, null, 2));
      if (ONLY_SEED !== null) {
        // Replay mode prints the full trace for minimisation.
        process.stdout.write(`${JSON.stringify(results[0], null, 2)}\n`);
      }
      expect(
        [...perSeed.entries()]
          .filter(([, v]) => v.failures > 0)
          .map(([seed, v]) => ({
            seed,
            failRate: `${v.failures}/${v.runs}`,
            violations: results.find(r => r.seed === seed && !r.ok)?.violations,
          })),
      ).toEqual([]);
    },
    10 * 60 * 1000,
  );

  /**
   * Minimised from campaign seeds 20260906/20260912/20260922/… (see the
   * seed table): two rapid presses on one reminder toggle (ON then OFF, the
   * second landing while the first sync's native calls are still in flight).
   * Expected: the tray ends equal to the plan for the final prefs (comeback
   * off → no ps.comeback.* scheduled). Observed: syncNow runs are not
   * serialised — the second run's `cancelAllPlanned()` snapshot predates the
   * first run's creates, so the first run's comeback notifications survive
   * and will fire although the toggle shows OFF.
   */
  it('minimized: ON→OFF double press on "Welcome back" leaves no orphan comeback reminders', async () => {
    const prefs: NotificationPrefs = {
      ...DEFAULT_NOTIFICATION_PREFS,
      enabled: true,
      promptDismissed: true,
      practiceReminder: true,
      practiceReminderMinutes: 450,
      streakDefense: true,
      weeklyRecap: true,
      comeback: false,
    };
    const outcome = await runBurst({
      seed: 1,
      owner: OWNERS[0],
      initialPrefs: prefs,
      initialAuthorizationStatus: 1,
      initialStorePermission: 'granted',
      initialTrayIds: [
        'ps.reminder.practice',
        'ps.reminder.streak',
        'ps.reminder.weekly',
      ],
      profile: {
        notifeeLatencyMin: 10,
        notifeeLatencyMax: 10,
        dbLatencyMin: 0,
        dbLatencyMax: 0,
        kvWriteFailP: 0,
        createFailP: 0,
        settingsReadFailP: 0,
        openSettingsFailP: 0,
        requestOutcomes: ['grant'],
      },
      steps: [
        { kind: 'press', label: HOST_ROW_LABEL, times: 1 },
        // Focus permission refresh settles; tray == plan for `prefs`.
        { kind: 'advance', ms: 500 },
        { kind: 'press', label: 'Welcome back', times: 1 },
        // 2 ms later — kv write done, sync #1 has issued getTriggerIds.
        { kind: 'advance', ms: 2 },
        { kind: 'press', label: 'Welcome back', times: 1 },
      ],
    });
    process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
    expect(outcome.final.prefs.comeback).toBe(false);
    expect(outcome.violations).toEqual([]);
  });

  /**
   * Minimised from campaign seeds 20261147/20261155/20261196/20261199: two
   * "Turn on reminders" presses from two mounts of the screen (press, back,
   * re-open, press — the `requesting` guard is per mount), then the user
   * switches "All reminders" OFF once the first press has enabled them.
   * Expected: the last user intent (OFF) wins. Observed: the second, still
   * in-flight `requestPermissionAndEnable()` completes afterwards and writes
   * `enabled: true`, re-enabling reminders the user just switched off.
   */
  it('minimized: a late "Turn on reminders" completion must not override a later "All reminders" OFF', async () => {
    const outcome = await runBurst({
      seed: 2,
      owner: OWNERS[0],
      initialPrefs: { ...DEFAULT_NOTIFICATION_PREFS, enabled: false },
      initialAuthorizationStatus: 1,
      initialStorePermission: 'granted',
      profile: {
        notifeeLatencyMin: 10,
        notifeeLatencyMax: 10,
        dbLatencyMin: 0,
        dbLatencyMax: 0,
        kvWriteFailP: 0,
        createFailP: 0,
        settingsReadFailP: 0,
        openSettingsFailP: 0,
        requestOutcomes: ['grant'],
      },
      steps: [
        { kind: 'press', label: HOST_ROW_LABEL, times: 1 },
        { kind: 'advance', ms: 500 },
        { kind: 'press', label: 'Turn on reminders', times: 1 },
        { kind: 'press', label: 'Back', times: 1 },
        { kind: 'press', label: HOST_ROW_LABEL, times: 1 },
        { kind: 'press', label: 'Turn on reminders', times: 1 },
        // First request resolves (granted → enabled) while the second is
        // still queued behind the focus permission read.
        { kind: 'advance', ms: 12 },
        { kind: 'press', label: 'All reminders', times: 1 },
      ],
    });
    process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
    expect(outcome.violations).toEqual([]);
    expect(outcome.final.prefs.enabled).toBe(false);
  });
});
