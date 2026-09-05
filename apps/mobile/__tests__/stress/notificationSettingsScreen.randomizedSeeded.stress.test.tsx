import React from 'react';
import { Linking, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import * as fs from 'fs';
import * as path from 'path';
import * as v8 from 'v8';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createNavigationContainerRef,
  DefaultTheme,
  NavigationContainer,
  useNavigation,
} from '@react-navigation/native';
import {
  createNativeStackNavigator,
  type NativeStackNavigationProp,
} from '@react-navigation/native-stack';

/**
 * SEEDED RANDOMIZED LONG-RUN stress harness for NotificationSettingsScreen.
 *
 * What is REAL here: the production screen, the real zustand
 * notificationStore, the real SchedulerPort implementation
 * (`NotifeeScheduler` in src/notifications/service.ts), the real kv
 * repository (`getKv`/`setKv`), the real consistency snapshot reader, the
 * real @react-navigation NavigationContainer + native-stack navigator (so
 * `useNavigation`, `useFocusEffect`, push/pop/blur/focus are the library's
 * own), SafeAreaProvider (the library's own jest mock — insets contexts are
 * real) and QueryClientProvider, mirroring App.tsx.
 *
 * What is MOCKED (native seams only):
 *   - `react-native-notify-kit` (the notification TurboModule) — a Notifee-
 *     shaped fake with fault injection: permission status, request result,
 *     thrown reads, and scheduling failures. Same-id `createTriggerNotification`
 *     REPLACES like Notifee does, so duplicate ids are impossible by design.
 *   - `src/data/db` (`@op-engineering/op-sqlite`) — in-memory kv table with a
 *     "disk full" fault flag.
 *   - `Linking.openSettings` — RN's own jest mock, driven to resolve/reject.
 * The other RootNavigator routes are heavy native screens; the host stack
 * registers `Tabs` and `ConsentSettings` as one-line stand-ins that only
 * navigate (mirroring SettingsScreen's "Notifications" row →
 * `navigation.navigate('NotificationSettings')`).
 *
 * Generator: a hand-rolled xorshift32 RNG produces sequences of 5..60
 * legal / near-legal actions over the screen's public surface: every
 * pressable and switch on the screen, navigation (Back, re-open, push an
 * overlay route on top, pop it — blur/focus cycles), OS-level events
 * (permission status changes, request outcomes, scheduling/persistence/
 * deep-link faults) and "bursts" (2–3 taps with no microtask flush between
 * them). Near-legal = tapping a control that is absent, disabled, or covered
 * by another route; those must be exact no-ops.
 *
 * INVARIANTS (model-checked after EVERY step, once the microtask queue is
 * idle):
 *   I1  no exception escapes a render or a handler; no console.error /
 *       console.warn is emitted by React, navigation, or the app.
 *   I2  store prefs are structurally valid: version 1, booleans, integer
 *       practiceReminderMinutes in [0, 1440); JSON round-trip through
 *       parseNotificationPrefs is the identity.
 *   I3  store prefs equal the oracle (sequential application of every
 *       effective tap: toggles flip, presets set, ±30m wraps mod 1440,
 *       "Turn on reminders" → granted ⇒ enabled+promptDismissed).
 *   I4  persistence: persistFailed ⇔ the last kv write failed; the kv row for
 *       the owner equals the prefs of the last successful write.
 *   I5  scheduling converges: scheduleFailed ⇔ the last sync failed; after a
 *       successful sync the OS trigger ids are exactly buildNotificationPlan
 *       (prefs at that sync, fact-free context) when enabled && permission
 *       granted, otherwise none — and a foreign (non-`ps.`) trigger is never
 *       cancelled.
 *   I6  UI ⇔ state: the set of visible controls is exactly what the oracle
 *       expects for {enabled, permission, requestFailed}; every switch's
 *       accessibilityState.checked mirrors prefs; the time label and the
 *       selected preset mirror practiceReminderMinutes; presets/steppers are
 *       disabled iff the practice nudge is off; the master caption never
 *       claims "Scheduled…" unless enabled && granted; each failure copy
 *       (save, schedule, request, settings deep-link) is shown iff its flag
 *       is set; "Turn on reminders" is disabled while a request is pending
 *       and a second tap during that window is a no-op.
 *   I7  navigation: the native-stack route names equal the oracle's stack;
 *       the screen is mounted iff it is on the stack; every (re)focus re-reads
 *       the OS permission into the store.
 *   I8  determinism: the same seed replayed twice yields a byte-identical
 *       trace (action + outcome + state digest per step).
 *
 * Campaign knobs (env): STRESS_ITER (sequence count, default 40),
 * STRESS_SEED_BASE (first seed, default 1), STRESS_SEED (replay one seed),
 * STRESS_DETERMINISM_EVERY (replay every Nth seed twice, default 10),
 * STRESS_OUT (directory for the JSON seed→outcome table + traces).
 */

// ---------------------------------------------------------------- mocks ---

type FakeTrigger = { notification: { id?: string }; trigger: unknown };

const mockNative = {
  /** AuthorizationStatus the OS reports on read: -1 | 0 | 1 | 2. */
  authorizationStatus: 1,
  readThrows: false,
  /** AuthorizationStatus the OS returns from the permission prompt. */
  requestStatus: 1,
  requestThrows: false,
  /** Trigger reads/writes reject ("scheduler unavailable"). */
  scheduleFails: false,
  triggers: new Map<string, FakeTrigger>(),
  log: [] as string[],
  reset() {
    this.authorizationStatus = 1;
    this.readThrows = false;
    this.requestStatus = 1;
    this.requestThrows = false;
    this.scheduleFails = false;
    this.triggers = new Map();
    this.log = [];
  },
};

jest.mock('react-native-notify-kit', () => {
  const notifee = {
    requestPermission: async () => {
      mockNative.log.push('requestPermission');
      if (mockNative.requestThrows) throw new Error('prompt unavailable');
      return { authorizationStatus: mockNative.requestStatus };
    },
    getNotificationSettings: async () => {
      mockNative.log.push('getNotificationSettings');
      if (mockNative.readThrows) throw new Error('settings unavailable');
      return { authorizationStatus: mockNative.authorizationStatus };
    },
    createChannel: async () => 'reminders',
    createTriggerNotification: async (
      notification: { id?: string },
      trigger: unknown,
    ) => {
      mockNative.log.push(`create:${notification.id ?? '?'}`);
      if (mockNative.scheduleFails) throw new Error('scheduler unavailable');
      const id = notification.id ?? 'mock-id';
      mockNative.triggers.set(id, { notification, trigger });
      return id;
    },
    getTriggerNotificationIds: async () => {
      mockNative.log.push('getTriggerNotificationIds');
      if (mockNative.scheduleFails) throw new Error('scheduler unavailable');
      return [...mockNative.triggers.keys()];
    },
    cancelTriggerNotification: async (id: string) => {
      mockNative.log.push(`cancel:${id}`);
      mockNative.triggers.delete(id);
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

const mockKv = {
  table: new Map<string, string>(),
  writeFails: false,
  reset() {
    this.table = new Map();
    this.writeFails = false;
  },
};

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        const value = mockKv.table.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        if (mockKv.writeFails) throw new Error('disk full');
        mockKv.table.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

import { NotificationSettingsScreen } from '../../src/screens/NotificationSettingsScreen';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import { buildNotificationPlan } from '../../src/notifications/plan';
import {
  DEFAULT_NOTIFICATION_PREFS,
  formatReminderMinutes,
  notificationPrefsKeyForOwner,
  parseNotificationPrefs,
  type NotificationPrefs,
} from '../../src/notifications/types';
import type { PermissionState } from '../../src/notifications/service';
import {
  GUEST_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import type { RootStackParams } from '../../src/navigation/params';
import { color } from '../../src/design/tokens';

// ------------------------------------------------------------ host stack ---

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

function TabsHost() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParams>>();
  return (
    <Text
      accessibilityRole="button"
      accessibilityLabel="Notifications"
      onPress={() => navigation.navigate('NotificationSettings')}
    >
      Settings host
    </Text>
  );
}

function OverlayHost() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParams>>();
  return (
    <Text
      accessibilityRole="button"
      accessibilityLabel="Overlay back"
      onPress={() => navigation.goBack()}
    >
      Overlay host
    </Text>
  );
}

function Host() {
  const [client] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      }),
  );
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={client}>
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
            <Stack.Screen name="ConsentSettings" component={OverlayHost} />
          </Stack.Navigator>
        </NavigationContainer>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

// ------------------------------------------------------------------- rng ---

class Rng {
  private state: number;
  constructor(seed: number) {
    // murmur3 fmix32 so that small consecutive seeds start far apart
    let h = (seed >>> 0) ^ 0x9e3779b9;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h = (h ^ (h >>> 16)) >>> 0;
    this.state = h || 0x9e3779b9;
    for (let i = 0; i < 4; i++) this.next();
  }
  next(): number {
    let x = this.state;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.state = x;
    return x / 0x100000000;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  bool(): boolean {
    return this.next() < 0.5;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]!;
  }
  weighted<T>(items: readonly (readonly [T, number])[]): T {
    const total = items.reduce((sum, [, w]) => sum + w, 0);
    let roll = this.next() * total;
    for (const [item, weight] of items) {
      roll -= weight;
      if (roll < 0) return item;
    }
    return items[items.length - 1]![0];
  }
}

// --------------------------------------------------------------- actions ---

const TIME_PRESETS = [
  { label: 'Morning', minutes: 7 * 60 + 30 },
  { label: 'Midday', minutes: 12 * 60 },
  { label: 'Evening', minutes: 17 * 60 + 30 },
  { label: 'Night', minutes: 19 * 60 + 30 },
] as const;

const SWITCHES = [
  ['All reminders', 'enabled'],
  ['Practice nudge', 'practiceReminder'],
  ['Streak defense', 'streakDefense'],
  ['Weekly recap', 'weeklyRecap'],
  ['Welcome back', 'comeback'],
] as const;

type SwitchLabel = (typeof SWITCHES)[number][0];
type PresetLabel = (typeof TIME_PRESETS)[number]['label'];

type OsStatus = -1 | 0 | 1 | 2 | 'throws';

type UserAction =
  | { kind: 'back' }
  | { kind: 'open' }
  | { kind: 'overlayPush' }
  | { kind: 'overlayPop' }
  | { kind: 'turnOn' }
  | { kind: 'openSettings' }
  | { kind: 'checkAgain' }
  | { kind: 'switch'; label: SwitchLabel }
  | { kind: 'preset'; label: PresetLabel }
  | { kind: 'step'; direction: -1 | 1 };

type EnvAction =
  | { kind: 'osPermission'; status: OsStatus }
  | { kind: 'osRequestResult'; status: OsStatus }
  | { kind: 'scheduleFails'; on: boolean }
  | { kind: 'kvWriteFails'; on: boolean }
  | { kind: 'settingsLinkFails'; on: boolean };

type Action = UserAction | EnvAction | { kind: 'burst'; taps: UserAction[] };

const USER_ACTION_TABLE: readonly (readonly [() => UserAction, number])[] = [
  [() => ({ kind: 'back' }), 3],
  [() => ({ kind: 'open' }), 4],
  [() => ({ kind: 'overlayPush' }), 2],
  [() => ({ kind: 'overlayPop' }), 2],
  [() => ({ kind: 'turnOn' }), 8],
  [() => ({ kind: 'openSettings' }), 4],
  [() => ({ kind: 'checkAgain' }), 3],
  [() => ({ kind: 'switch', label: 'All reminders' }), 6],
  [() => ({ kind: 'switch', label: 'Practice nudge' }), 6],
  [() => ({ kind: 'switch', label: 'Streak defense' }), 4],
  [() => ({ kind: 'switch', label: 'Weekly recap' }), 4],
  [() => ({ kind: 'switch', label: 'Welcome back' }), 4],
  [() => ({ kind: 'preset', label: 'Morning' }), 3],
  [() => ({ kind: 'preset', label: 'Midday' }), 3],
  [() => ({ kind: 'preset', label: 'Evening' }), 3],
  [() => ({ kind: 'preset', label: 'Night' }), 3],
  [() => ({ kind: 'step', direction: -1 }), 5],
  [() => ({ kind: 'step', direction: 1 }), 5],
];

const OS_STATUSES: readonly OsStatus[] = [-1, 0, 1, 2, 'throws'];

/** Any user action, legal or not (near-legal: absent/disabled/covered). */
function generateAnyUserAction(rng: Rng): UserAction {
  return rng.weighted(USER_ACTION_TABLE)();
}

function actionForLabel(label: string): UserAction | null {
  if (label === 'Back') return { kind: 'back' };
  if (label === 'Open system settings') return { kind: 'openSettings' };
  if (label === 'Turn on reminders') return { kind: 'turnOn' };
  if (label === 'Check again') return { kind: 'checkAgain' };
  if (label === 'Reminder 30 minutes earlier')
    return { kind: 'step', direction: -1 };
  if (label === 'Reminder 30 minutes later')
    return { kind: 'step', direction: 1 };
  const sw = SWITCHES.find(([l]) => l === label);
  if (sw) return { kind: 'switch', label: sw[0] };
  const preset = TIME_PRESETS.find(p => label.startsWith(`${p.label}, `));
  if (preset) return { kind: 'preset', label: preset.label };
  return null;
}

/** Actions that are legal (visible + enabled) in the model's current state,
 * with navigation taps weighted below on-screen controls. */
function generateLegalUserAction(rng: Rng, model: Model): UserAction {
  const top = model.stack[model.stack.length - 1];
  if (top === 'Tabs') return { kind: 'open' };
  if (top === 'ConsentSettings') return { kind: 'overlayPop' };
  const legal: (readonly [UserAction, number])[] = [
    [{ kind: 'overlayPush' }, 1],
  ];
  for (const [label, { disabled }] of expectedControls(model)) {
    if (disabled) continue;
    const action = actionForLabel(label);
    if (!action) continue;
    let weight = action.kind === 'back' ? 1 : 3;
    // Drive the ±30m stepper across the midnight wrap when it is near it.
    if (action.kind === 'step') {
      const minutes = model.prefs.practiceReminderMinutes;
      if (
        (action.direction < 0 && minutes <= 90) ||
        (action.direction > 0 && minutes >= 1350)
      )
        weight = 14;
    }
    legal.push([action, weight]);
  }
  return rng.weighted(legal);
}

function generateUserAction(rng: Rng, model: Model): UserAction {
  return rng.next() < 0.85
    ? generateLegalUserAction(rng, model)
    : generateAnyUserAction(rng);
}

/** State-aware draw: the model is a deterministic function of the seed, so
 * the whole sequence is still replayable from the seed alone. */
function generateAction(rng: Rng, model: Model): Action {
  const family = rng.weighted<'user' | 'env' | 'burst'>([
    ['user', 68],
    ['env', 22],
    ['burst', 10],
  ]);
  if (family === 'user') return generateUserAction(rng, model);
  if (family === 'burst') {
    const count = 2 + rng.int(2);
    const taps: UserAction[] = [];
    for (let i = 0; i < count; i++) taps.push(generateUserAction(rng, model));
    return { kind: 'burst', taps };
  }
  return rng.weighted<() => EnvAction>([
    [() => ({ kind: 'osPermission', status: rng.pick(OS_STATUSES) }), 6],
    [() => ({ kind: 'osRequestResult', status: rng.pick(OS_STATUSES) }), 5],
    [() => ({ kind: 'scheduleFails', on: rng.bool() }), 3],
    [() => ({ kind: 'kvWriteFails', on: rng.bool() }), 3],
    [() => ({ kind: 'settingsLinkFails', on: rng.bool() }), 2],
  ])();
}

type InitialKv =
  | { kind: 'empty' }
  | { kind: 'garbage'; raw: string }
  | { kind: 'prefs'; raw: string };

interface Scenario {
  seed: number;
  initialOs: OsStatus;
  initialKv: InitialKv;
  length: number;
  /** Explicit action list (minimized replays); null = draw from the seed. */
  actions: Action[] | null;
}

/** Draws the launch conditions; the run then continues the SAME rng for the
 * per-step action draws, so `new Rng(seed)` + this prefix replays a seed. */
function drawScenarioSetup(rng: Rng, seed: number): Scenario {
  const length = 5 + rng.int(56); // 5..60
  const initialOs = rng.pick(OS_STATUSES);
  let initialKv: InitialKv;
  const kvRoll = rng.int(10);
  if (kvRoll < 3) initialKv = { kind: 'empty' };
  else if (kvRoll < 5)
    initialKv = {
      kind: 'garbage',
      raw: rng.pick(['{not json', '[]', 'null', '42', '{"version":2}', '""']),
    };
  else {
    const minutesPool = [
      rng.int(1440),
      rng.int(1440),
      0,
      30,
      60,
      1439,
      1410,
      1380,
      -30,
      1440,
      90.5,
      'noon',
    ] as const;
    const stored = {
      version: 1,
      enabled: rng.bool(),
      practiceReminder: rng.bool(),
      practiceReminderMinutes: rng.pick(minutesPool),
      streakDefense: rng.bool(),
      weeklyRecap: rng.bool(),
      comeback: rng.bool(),
      promptDismissed: rng.bool(),
    };
    initialKv = { kind: 'prefs', raw: JSON.stringify(stored) };
  }
  return { seed, initialOs, initialKv, length, actions: null };
}

function generateScenario(seed: number): Scenario {
  return drawScenarioSetup(new Rng(seed), seed);
}

function describeAction(action: Action): string {
  switch (action.kind) {
    case 'switch':
      return `switch:${action.label}`;
    case 'preset':
      return `preset:${action.label}`;
    case 'step':
      return `step:${action.direction > 0 ? '+30' : '-30'}`;
    case 'osPermission':
      return `os:permission=${action.status}`;
    case 'osRequestResult':
      return `os:request=${action.status}`;
    case 'scheduleFails':
      return `os:scheduleFails=${action.on}`;
    case 'kvWriteFails':
      return `os:kvWriteFails=${action.on}`;
    case 'settingsLinkFails':
      return `os:settingsLinkFails=${action.on}`;
    case 'burst':
      return `burst[${action.taps.map(describeAction).join(',')}]`;
    default:
      return action.kind;
  }
}

// ---------------------------------------------------------------- oracle ---

type StorePermission = PermissionState | 'unknown';

function permissionFromOs(status: OsStatus): StorePermission {
  if (status === 'throws') return 'unknown';
  if (status === -1) return 'undetermined';
  return status === 0 ? 'denied' : 'granted';
}

const FOREIGN_TRIGGER_ID = 'com.other.app.reminder';

interface Model {
  prefs: NotificationPrefs;
  permission: StorePermission;
  persistFailed: boolean;
  scheduleFailed: boolean;
  kvPrefs: NotificationPrefs | null;
  triggers: Set<string>;
  // screen-local
  requestFailed: boolean;
  settingsOpenFailed: boolean;
  // environment
  os: OsStatus;
  requestResult: OsStatus;
  scheduleFails: boolean;
  kvWriteFails: boolean;
  settingsLinkFails: boolean;
  // navigation
  stack: string[];
}

function planIds(prefs: NotificationPrefs): Set<string> {
  return new Set(
    buildNotificationPlan(prefs, {
      nowMs: Date.now(),
      streakDays: 0,
      practicedToday: false,
      hasAnyHistory: false,
    }).map(item => item.id),
  );
}

function modelSync(model: Model) {
  if (model.scheduleFails) {
    model.scheduleFailed = true;
    return;
  }
  model.scheduleFailed = false;
  const shouldSchedule = model.prefs.enabled && model.permission === 'granted';
  model.triggers = new Set([
    FOREIGN_TRIGGER_ID,
    ...(shouldSchedule ? planIds(model.prefs) : []),
  ]);
}

function modelSetPrefs(model: Model, patch: Partial<NotificationPrefs>) {
  model.prefs = { ...model.prefs, ...patch, version: 1 };
  if (model.kvWriteFails) {
    model.persistFailed = true;
  } else {
    model.persistFailed = false;
    model.kvPrefs = model.prefs;
  }
  modelSync(model);
}

function screenOnTop(model: Model): boolean {
  return model.stack[model.stack.length - 1] === 'NotificationSettings';
}

function screenMounted(model: Model): boolean {
  return model.stack.includes('NotificationSettings');
}

/** Controls the oracle expects on the settings screen (accessibility labels). */
function expectedControls(model: Model): Map<string, { disabled: boolean }> {
  const controls = new Map<string, { disabled: boolean }>();
  const on = (label: string, disabled = false) =>
    controls.set(label, { disabled });
  on('Back');
  const denied = model.permission === 'denied';
  if (denied) on('Open system settings');
  if (model.prefs.enabled && model.permission === 'unknown') on('Check again');
  if (!model.prefs.enabled && !denied) {
    on('Turn on reminders');
    if (model.requestFailed) on('Open system settings');
  }
  if (model.prefs.enabled) {
    for (const [label] of SWITCHES) on(label);
    const timeDisabled = !model.prefs.practiceReminder;
    for (const preset of TIME_PRESETS) {
      on(
        `${preset.label}, ${formatReminderMinutes(preset.minutes)}`,
        timeDisabled,
      );
    }
    on('Reminder 30 minutes earlier', timeDisabled);
    on('Reminder 30 minutes later', timeDisabled);
  }
  return controls;
}

// ------------------------------------------------------------- renderer ---

type Renderer = TestRenderer.ReactTestRenderer;

const COPY = {
  scheduled: 'Scheduled from your real practice history',
  pausedUnknown: 'Paused — notification permission couldn’t be checked',
  pausedAllowed: 'Paused until notifications are allowed',
  saveFailed: 'This change couldn’t be saved on this phone',
  scheduleFailed: 'Reminders couldn’t be scheduled on this phone',
  requestFailed: 'Reminders weren’t turned on — the system didn’t confirm',
  settingsFailed: 'Couldn’t open Settings from here',
  deniedTitle: 'Notifications are off in system settings',
  unknownTitle: 'Couldn’t check notification permission',
  hostSettings: 'Settings host',
  hostOverlay: 'Overlay host',
} as const;

function allText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

interface ControlNode {
  label: string;
  disabled: boolean;
  checked: boolean | undefined;
  selected: boolean | undefined;
  onPress: () => void;
}

/** Every pressable on screen, keyed by accessibility label. The composite
 * PressableScale/BrandToggle node (the one carrying `disabled`) is taken. */
function visibleControls(renderer: Renderer): Map<string, ControlNode> {
  const map = new Map<string, ControlNode>();
  const nodes = renderer.root.findAll(
    node =>
      typeof node.props.accessibilityLabel === 'string' &&
      typeof node.props.onPress === 'function' &&
      typeof node.type !== 'string',
  );
  for (const node of nodes) {
    const label = node.props.accessibilityLabel as string;
    if (map.has(label)) continue;
    const state = (node.props.accessibilityState ?? {}) as {
      checked?: boolean;
      selected?: boolean;
      disabled?: boolean;
    };
    map.set(label, {
      label,
      disabled: node.props.disabled === true || state.disabled === true,
      checked: state.checked,
      selected: state.selected,
      onPress: node.props.onPress as () => void,
    });
  }
  return map;
}

const HOST_LABELS = new Set(['Notifications', 'Overlay back']);

async function settle() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
    });
  }
}

function routeNames(): string[] {
  if (!navigationRef.isReady()) return [];
  const state = navigationRef.getRootState();
  return state ? state.routes.map(route => route.name) : [];
}

// -------------------------------------------------------------- executor ---

class InvariantViolation extends Error {
  constructor(
    readonly invariant: string,
    detail: string,
  ) {
    super(`${invariant}: ${detail}`);
  }
}

function check(invariant: string, condition: boolean, detail: () => string) {
  if (!condition) throw new InvariantViolation(invariant, detail());
}

function prefsEqual(a: NotificationPrefs, b: NotificationPrefs): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

interface StepRecord {
  i: number;
  action: string;
  outcome: string;
  digest: string;
}

interface RunResult {
  seed: number;
  status: 'pass' | 'fail';
  steps: number;
  /** The concrete actions that ran (drawn from the seed or replayed). */
  actions: Action[];
  trace: StepRecord[];
  failure?: {
    step: number;
    action: string;
    invariant: string;
    detail: string;
    consoleErrors: string[];
  };
}

function digestOf(model: Model, renderer: Renderer): string {
  const state = useNotificationStore.getState();
  return JSON.stringify({
    prefs: state.prefs,
    permission: state.permission,
    persistFailed: state.persistFailed,
    scheduleFailed: state.scheduleFailed,
    triggers: [...mockNative.triggers.keys()].sort(),
    routes: routeNames(),
    controls: [...visibleControls(renderer).keys()].sort(),
    model: {
      requestFailed: model.requestFailed,
      settingsOpenFailed: model.settingsOpenFailed,
    },
  });
}

function checkInvariants(model: Model, renderer: Renderer) {
  const state = useNotificationStore.getState();
  const prefs = state.prefs;

  // I2 structural validity
  check(
    'I2.structure',
    prefs.version === 1 &&
      [
        prefs.enabled,
        prefs.practiceReminder,
        prefs.streakDefense,
        prefs.weeklyRecap,
        prefs.comeback,
        prefs.promptDismissed,
      ].every(v => typeof v === 'boolean') &&
      Number.isInteger(prefs.practiceReminderMinutes) &&
      prefs.practiceReminderMinutes >= 0 &&
      prefs.practiceReminderMinutes < 1440,
    () => `invalid prefs ${JSON.stringify(prefs)}`,
  );
  check(
    'I2.roundtrip',
    prefsEqual(parseNotificationPrefs(JSON.stringify(prefs)), prefs),
    () => `prefs not round-trip stable ${JSON.stringify(prefs)}`,
  );

  // I3 oracle prefs
  check(
    'I3.prefs',
    prefsEqual(prefs, model.prefs),
    () =>
      `store ${JSON.stringify(prefs)} != model ${JSON.stringify(model.prefs)}`,
  );
  check(
    'I3.permission',
    state.permission === model.permission,
    () => `store permission ${state.permission} != model ${model.permission}`,
  );

  // I4 persistence
  check(
    'I4.persistFailed',
    state.persistFailed === model.persistFailed,
    () =>
      `persistFailed ${state.persistFailed} != model ${model.persistFailed}`,
  );
  const kvRaw = mockKv.table.get(
    notificationPrefsKeyForOwner(GUEST_DATA_OWNER),
  );
  if (model.kvPrefs) {
    check(
      'I4.kvRow',
      kvRaw !== undefined &&
        prefsEqual(JSON.parse(kvRaw) as NotificationPrefs, model.kvPrefs),
      () =>
        `kv row ${kvRaw} != last successful write ${JSON.stringify(model.kvPrefs)}`,
    );
  }

  // I5 scheduling
  check(
    'I5.scheduleFailed',
    state.scheduleFailed === model.scheduleFailed,
    () =>
      `scheduleFailed ${state.scheduleFailed} != model ${model.scheduleFailed}`,
  );
  const osTriggers = new Set(mockNative.triggers.keys());
  check(
    'I5.foreignTriggerKept',
    osTriggers.has(FOREIGN_TRIGGER_ID),
    () => `foreign trigger cancelled; os=${[...osTriggers].join(',')}`,
  );
  if (!model.scheduleFailed) {
    check(
      'I5.triggersConverged',
      setsEqual(osTriggers, model.triggers),
      () =>
        `os triggers [${[...osTriggers].sort().join(',')}] != expected [${[
          ...model.triggers,
        ]
          .sort()
          .join(',')}] for prefs ${JSON.stringify(prefs)} permission ${
          state.permission
        }`,
    );
  }

  // I7 navigation
  const routes = routeNames();
  check(
    'I7.routes',
    JSON.stringify(routes) === JSON.stringify(model.stack),
    () =>
      `routes ${JSON.stringify(routes)} != model ${JSON.stringify(model.stack)}`,
  );
  const controls = visibleControls(renderer);
  const screenControls = new Map(
    [...controls].filter(([label]) => !HOST_LABELS.has(label)),
  );
  const text = allText(renderer);
  if (!screenMounted(model)) {
    check(
      'I7.unmounted',
      screenControls.size === 0 && !text.includes('Reminders are scheduled'),
      () =>
        `screen controls still present after pop: ${[...screenControls.keys()].join(',')}`,
    );
    return;
  }

  // I6 UI ⇔ state
  const expected = expectedControls(model);
  const actualLabels = new Set(screenControls.keys());
  check(
    'I6.controls',
    setsEqual(actualLabels, new Set(expected.keys())),
    () =>
      `visible [${[...actualLabels].sort().join(' | ')}] != expected [${[
        ...expected.keys(),
      ]
        .sort()
        .join(' | ')}]`,
  );
  for (const [label, { disabled }] of expected) {
    const actual = screenControls.get(label)!;
    check(
      'I6.disabled',
      actual.disabled === disabled,
      () => `${label} disabled=${actual.disabled}, expected ${disabled}`,
    );
  }
  if (model.prefs.enabled) {
    for (const [label, key] of SWITCHES) {
      const actual = screenControls.get(label)!;
      check(
        'I6.switchChecked',
        actual.checked === model.prefs[key],
        () =>
          `${label} checked=${actual.checked}, prefs.${key}=${model.prefs[key]}`,
      );
    }
    const timeLabel = `Reminder time ${formatReminderMinutes(
      model.prefs.practiceReminderMinutes,
    )}`;
    check(
      'I6.timeLabel',
      renderer.root.findAll(node => node.props.accessibilityLabel === timeLabel)
        .length > 0,
      () => `time label "${timeLabel}" not rendered`,
    );
    for (const preset of TIME_PRESETS) {
      const control = screenControls.get(
        `${preset.label}, ${formatReminderMinutes(preset.minutes)}`,
      )!;
      const shouldSelect =
        model.prefs.practiceReminderMinutes === preset.minutes;
      check(
        'I6.presetSelected',
        control.selected === shouldSelect,
        () =>
          `${preset.label} selected=${control.selected}, expected ${shouldSelect}`,
      );
    }
    const active = model.permission === 'granted';
    check(
      'I6.masterCaption',
      text.includes(COPY.scheduled) === active &&
        text.includes(COPY.pausedUnknown) ===
          (!active && model.permission === 'unknown') &&
        text.includes(COPY.pausedAllowed) ===
          (!active && model.permission !== 'unknown'),
      () => `master caption mismatch for permission ${model.permission}`,
    );
    check(
      'I6.unknownCard',
      text.includes(COPY.unknownTitle) === (model.permission === 'unknown'),
      () =>
        `unknown-permission card mismatch for permission ${model.permission}`,
    );
  } else {
    check(
      'I6.noScheduledClaim',
      !text.includes(COPY.scheduled),
      () => 'caption claims a schedule while reminders are disabled',
    );
  }
  check(
    'I6.deniedCard',
    text.includes(COPY.deniedTitle) === (model.permission === 'denied'),
    () => `denied card mismatch for permission ${model.permission}`,
  );
  check(
    'I6.saveFailedCopy',
    text.includes(COPY.saveFailed) === model.persistFailed,
    () =>
      `save-failed copy shown=${text.includes(COPY.saveFailed)}, persistFailed=${model.persistFailed}`,
  );
  check(
    'I6.scheduleFailedCopy',
    text.includes(COPY.scheduleFailed) === model.scheduleFailed,
    () =>
      `schedule-failed copy shown=${text.includes(COPY.scheduleFailed)}, scheduleFailed=${model.scheduleFailed}`,
  );
  const enableCard = !model.prefs.enabled && model.permission !== 'denied';
  check(
    'I6.requestFailedCopy',
    text.includes(COPY.requestFailed) === (enableCard && model.requestFailed),
    () =>
      `request-failed copy shown=${text.includes(COPY.requestFailed)}, expected ${enableCard && model.requestFailed}`,
  );
  const settingsCopyExpected =
    model.settingsOpenFailed &&
    (model.permission === 'denied' || (enableCard && model.requestFailed));
  check(
    'I6.settingsFailedCopy',
    text.includes(COPY.settingsFailed) === settingsCopyExpected,
    () =>
      `settings-failed copy shown=${text.includes(COPY.settingsFailed)}, expected ${settingsCopyExpected}`,
  );
}

/** Applies one tap; returns the outcome tag. Sync `act` only — the caller
 * decides whether the microtask queue is flushed before the next tap. */
function tap(
  model: Model,
  renderer: Renderer,
  action: UserAction,
  pendingRequest: { active: boolean },
): string {
  const controls = visibleControls(renderer);
  const press = (label: string) => {
    const node = controls.get(label);
    if (!node) return 'absent';
    if (node.disabled) return 'disabled';
    act(() => {
      node.onPress();
    });
    return 'pressed';
  };
  const screenTappable = screenOnTop(model);

  switch (action.kind) {
    case 'open': {
      if (model.stack[model.stack.length - 1] !== 'Tabs') return 'absent';
      const outcome = press('Notifications');
      if (outcome === 'pressed') {
        model.stack.push('NotificationSettings');
        // remount → screen-local state is fresh; focus re-reads permission
        model.requestFailed = false;
        model.settingsOpenFailed = false;
        model.permission = permissionFromOs(model.os);
      }
      return outcome;
    }
    case 'back': {
      if (!screenTappable) return 'absent';
      const outcome = press('Back');
      if (outcome === 'pressed') {
        model.stack.pop();
        model.requestFailed = false;
        model.settingsOpenFailed = false;
      }
      return outcome;
    }
    case 'overlayPush': {
      if (!screenTappable) return 'absent';
      // The app pushes sibling routes from the settings screen through
      // navigation; the harness drives the same navigator call.
      act(() => {
        navigationRef.navigate('ConsentSettings');
      });
      model.stack.push('ConsentSettings');
      return 'pushed';
    }
    case 'overlayPop': {
      if (model.stack[model.stack.length - 1] !== 'ConsentSettings')
        return 'absent';
      const outcome = press('Overlay back');
      if (outcome === 'pressed') {
        model.stack.pop();
        // refocus → useFocusEffect → refreshPermission
        model.permission = permissionFromOs(model.os);
      }
      return outcome;
    }
    case 'turnOn': {
      if (!screenTappable) return 'absent';
      const outcome = press('Turn on reminders');
      if (outcome !== 'pressed') return outcome;
      pendingRequest.active = true;
      const result = permissionFromOs(model.requestResult);
      model.permission = result;
      if (result === 'granted') {
        model.requestFailed = false;
        modelSetPrefs(model, { enabled: true, promptDismissed: true });
      } else {
        model.requestFailed = result !== 'denied';
      }
      return outcome;
    }
    case 'openSettings': {
      if (!screenTappable) return 'absent';
      const outcome = press('Open system settings');
      if (outcome === 'pressed')
        model.settingsOpenFailed = model.settingsLinkFails;
      return outcome;
    }
    case 'checkAgain': {
      if (!screenTappable) return 'absent';
      const outcome = press('Check again');
      if (outcome === 'pressed') {
        model.permission = permissionFromOs(model.os);
        modelSync(model);
      }
      return outcome;
    }
    case 'switch': {
      if (!screenTappable) return 'absent';
      const outcome = press(action.label);
      if (outcome === 'pressed') {
        const key = SWITCHES.find(([label]) => label === action.label)![1];
        modelSetPrefs(model, {
          [key]: !model.prefs[key],
        } as Partial<NotificationPrefs>);
      }
      return outcome;
    }
    case 'preset': {
      if (!screenTappable) return 'absent';
      const preset = TIME_PRESETS.find(p => p.label === action.label)!;
      const outcome = press(
        `${preset.label}, ${formatReminderMinutes(preset.minutes)}`,
      );
      if (outcome === 'pressed')
        modelSetPrefs(model, { practiceReminderMinutes: preset.minutes });
      return outcome;
    }
    case 'step': {
      if (!screenTappable) return 'absent';
      const outcome = press(
        action.direction > 0
          ? 'Reminder 30 minutes later'
          : 'Reminder 30 minutes earlier',
      );
      if (outcome === 'pressed') {
        modelSetPrefs(model, {
          practiceReminderMinutes:
            (model.prefs.practiceReminderMinutes +
              action.direction * 30 +
              1440) %
            1440,
        });
      }
      return outcome;
    }
    default:
      return 'absent';
  }
}

function applyEnv(model: Model, action: EnvAction): string {
  switch (action.kind) {
    case 'osPermission':
      model.os = action.status;
      mockNative.readThrows = action.status === 'throws';
      if (action.status !== 'throws')
        mockNative.authorizationStatus = action.status;
      return 'set';
    case 'osRequestResult':
      model.requestResult = action.status;
      mockNative.requestThrows = action.status === 'throws';
      if (action.status !== 'throws') mockNative.requestStatus = action.status;
      return 'set';
    case 'scheduleFails':
      model.scheduleFails = action.on;
      mockNative.scheduleFails = action.on;
      return 'set';
    case 'kvWriteFails':
      model.kvWriteFails = action.on;
      mockKv.writeFails = action.on;
      return 'set';
    case 'settingsLinkFails':
      model.settingsLinkFails = action.on;
      return 'set';
    default:
      return 'set';
  }
}

const openSettingsMock = Linking.openSettings as jest.Mock;
let currentModel: Model | null = null;

async function runScenario(scenario: Scenario): Promise<RunResult> {
  // react-native's jest setup wraps native modules in jest.fn(); their
  // recorded calls (~1.5k per step) would otherwise grow the heap unbounded
  // across a long campaign.
  jest.clearAllMocks();
  const consoleErrors: string[] = [];
  const errorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(' '));
    });
  const warnSpy = jest
    .spyOn(console, 'warn')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(' '));
    });

  mockNative.reset();
  mockKv.reset();
  mockNative.triggers.set(FOREIGN_TRIGGER_ID, {
    notification: { id: FOREIGN_TRIGGER_ID },
    trigger: null,
  });
  setActiveDataOwner(GUEST_DATA_OWNER);
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
    persistFailed: false,
    scheduleFailed: false,
  });

  const model: Model = {
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
    persistFailed: false,
    scheduleFailed: false,
    kvPrefs: null,
    triggers: new Set([FOREIGN_TRIGGER_ID]),
    requestFailed: false,
    settingsOpenFailed: false,
    os: scenario.initialOs,
    requestResult: 1,
    scheduleFails: false,
    kvWriteFails: false,
    settingsLinkFails: false,
    stack: ['Tabs'],
  };
  currentModel = model;
  openSettingsMock.mockImplementation(async () => {
    if (currentModel?.settingsLinkFails) throw new Error('no settings url');
  });

  applyEnv(model, { kind: 'osPermission', status: scenario.initialOs });
  const kvKey = notificationPrefsKeyForOwner(GUEST_DATA_OWNER);
  if (scenario.initialKv.kind !== 'empty') {
    mockKv.table.set(kvKey, scenario.initialKv.raw);
  }
  model.prefs = parseNotificationPrefs(
    scenario.initialKv.kind === 'empty' ? null : scenario.initialKv.raw,
  );
  if (scenario.initialKv.kind === 'prefs') {
    // hydrate() never rewrites the row; the oracle compares against the
    // stored raw only after the first successful write.
    model.kvPrefs = null;
  }

  const trace: StepRecord[] = [];
  const executed: Action[] = [];
  const rng = new Rng(scenario.seed);
  drawScenarioSetup(rng, scenario.seed); // fast-forward past the setup draws
  const stepCount = scenario.actions
    ? scenario.actions.length
    : scenario.length;
  let renderer = null as Renderer | null;
  let result: RunResult;
  try {
    // App launch: the store hydrates from kv, reads the OS permission and
    // reconciles the schedule — exactly what App.tsx does before any screen.
    await useNotificationStore.getState().hydrate();
    model.permission = permissionFromOs(model.os);
    modelSync(model);

    await act(async () => {
      renderer = TestRenderer.create(<Host />);
    });
    await settle();
    const r = renderer!;

    const pendingRequest = { active: false };
    // Step 0: Settings → Notifications (the real app's entry into the screen).
    tap(model, r, { kind: 'open' }, pendingRequest);
    await settle();
    checkInvariants(model, r);
    check('I1.console', consoleErrors.length === 0, () =>
      consoleErrors.join('\n'),
    );
    trace.push({
      i: 0,
      action: 'open',
      outcome: 'pressed',
      digest: digestOf(model, r),
    });

    for (let i = 0; i < stepCount; i++) {
      const action = scenario.actions
        ? scenario.actions[i]!
        : generateAction(rng, model);
      executed.push(action);
      let outcome: string;
      try {
        if (action.kind === 'burst') {
          const outcomes: string[] = [];
          const pending = { active: false };
          for (const sub of action.taps) {
            if (pending.active && sub.kind === 'turnOn') {
              // I6: a second tap while the request is pending must hit a
              // disabled button.
              const node = visibleControls(r).get('Turn on reminders');
              check(
                'I6.requestingDisabled',
                node === undefined || node.disabled,
                () => 'Turn on reminders enabled while a request is pending',
              );
              outcomes.push(node ? 'disabled' : 'absent');
              continue;
            }
            outcomes.push(tap(model, r, sub, pending));
          }
          outcome = outcomes.join(',');
        } else if (
          action.kind === 'osPermission' ||
          action.kind === 'osRequestResult' ||
          action.kind === 'scheduleFails' ||
          action.kind === 'kvWriteFails' ||
          action.kind === 'settingsLinkFails'
        ) {
          outcome = applyEnv(model, action);
        } else {
          outcome = tap(model, r, action, { active: false });
        }
        await settle();
        checkInvariants(model, r);
        check('I1.console', consoleErrors.length === 0, () =>
          consoleErrors.join('\n'),
        );
      } catch (error) {
        const violation =
          error instanceof InvariantViolation
            ? error
            : new InvariantViolation(
                'I1.exception',
                error instanceof Error
                  ? `${error.name}: ${error.message}`
                  : String(error),
              );
        trace.push({
          i: i + 1,
          action: describeAction(action),
          outcome: 'VIOLATION',
          digest: digestOf(model, r),
        });
        result = {
          seed: scenario.seed,
          status: 'fail',
          steps: i + 1,
          actions: executed,
          trace,
          failure: {
            step: i + 1,
            action: describeAction(action),
            invariant: violation.invariant,
            detail: violation.message,
            consoleErrors: [...consoleErrors],
          },
        };
        return result;
      }
      trace.push({
        i: i + 1,
        action: describeAction(action),
        outcome,
        digest: digestOf(model, r),
      });
    }
    result = {
      seed: scenario.seed,
      status: 'pass',
      steps: stepCount,
      actions: executed,
      trace,
    };
    return result;
  } finally {
    if (renderer) {
      const r = renderer as Renderer;
      await act(async () => {
        r.unmount();
      });
      await settle();
    }
    currentModel = null;
    openSettingsMock.mockReset();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  }
}

// ----------------------------------------------------------- minimizer ---

async function failsWith(
  scenario: Scenario,
  invariant: string,
): Promise<boolean> {
  const result = await runScenario(scenario);
  return result.status === 'fail' && result.failure!.invariant === invariant;
}

/** ddmin over the executed action list, preserving the seed's launch
 * conditions (OS permission, stored prefs). */
async function minimize(
  scenario: Scenario,
  executed: Action[],
  invariant: string,
): Promise<Scenario> {
  let actions = executed;
  let granularity = 2;
  while (actions.length >= 2) {
    const chunk = Math.ceil(actions.length / granularity);
    let reduced = false;
    for (let start = 0; start < actions.length; start += chunk) {
      const candidate = [
        ...actions.slice(0, start),
        ...actions.slice(start + chunk),
      ];
      if (candidate.length === 0) continue;
      if (await failsWith({ ...scenario, actions: candidate }, invariant)) {
        actions = candidate;
        granularity = Math.max(granularity - 1, 2);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (granularity >= actions.length) break;
      granularity = Math.min(granularity * 2, actions.length);
    }
  }
  return { ...scenario, actions };
}

// -------------------------------------------------------------- campaign ---

const ITER = Number(process.env.STRESS_ITER ?? 40);
const SEED_BASE = Number(process.env.STRESS_SEED_BASE ?? 1);
const ONLY_SEED = process.env.STRESS_SEED
  ? Number(process.env.STRESS_SEED)
  : null;
const DETERMINISM_EVERY = Number(process.env.STRESS_DETERMINISM_EVERY ?? 10);
const OUT_DIR = process.env.STRESS_OUT ?? null;
/** Comma-separated iteration indices after which a V8 heap snapshot is
 * written to STRESS_OUT (diagnostic; needs `NODE_OPTIONS=--expose-gc`). */
const HEAP_SNAPSHOT_AT = new Set(
  (process.env.STRESS_HEAP_SNAPSHOT_AT ?? '')
    .split(',')
    .filter(Boolean)
    .map(Number),
);

jest.setTimeout(6 * 60 * 60 * 1000);

function writeArtifact(name: string, value: unknown) {
  if (!OUT_DIR) return;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, name),
    JSON.stringify(value, null, 2),
    'utf8',
  );
}

function traceKey(result: RunResult): string {
  return JSON.stringify(
    result.trace.map(step => [step.action, step.outcome, step.digest]),
  );
}

describe('NotificationSettingsScreen — seeded randomized long-run (real navigator/store/service)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('replays one seed when STRESS_SEED is set', async () => {
    if (ONLY_SEED === null) return;
    const scenario = generateScenario(ONLY_SEED);
    const result = await runScenario(scenario);
    writeArtifact(`replay-${ONLY_SEED}.json`, { scenario, result });
    if (result.status === 'fail') {
      throw new Error(
        `seed ${ONLY_SEED} failed at step ${result.failure!.step} (${result.failure!.action}): ${result.failure!.detail}`,
      );
    }
  });

  it(`holds every invariant across ${ITER} seeded sequences (seeds ${SEED_BASE}..${SEED_BASE + ITER - 1})`, async () => {
    if (ONLY_SEED !== null) return;
    const table: Array<{
      seed: number;
      status: string;
      steps: number;
      length: number;
      actions?: string[];
      failure?: RunResult['failure'];
      deterministic?: boolean;
      heapUsedMB: number;
    }> = [];
    const failures: Array<{
      seed: number;
      result: RunResult;
      minimized: Scenario;
      rerunFailures: number;
    }> = [];
    const traces: Record<string, string[]> = {};
    const outcomeHistogram: Record<string, number> = {};
    let stepsExecuted = 0;
    for (let n = 0; n < ITER; n++) {
      const seed = SEED_BASE + n;
      const scenario = generateScenario(seed);
      const result = await runScenario(scenario);
      stepsExecuted += result.steps;
      traces[String(seed)] = result.trace.map(
        step => `${step.action} -> ${step.outcome}`,
      );
      for (const step of result.trace) {
        const key = `${step.action.split(/[:[]/)[0]}:${step.outcome}`;
        outcomeHistogram[key] = (outcomeHistogram[key] ?? 0) + 1;
      }
      if (typeof global.gc === 'function') global.gc();
      if (OUT_DIR && HEAP_SNAPSHOT_AT.has(n)) {
        fs.mkdirSync(OUT_DIR, { recursive: true });
        v8.writeHeapSnapshot(path.join(OUT_DIR, `heap-${n}.heapsnapshot`));
      }
      const row: (typeof table)[number] = {
        seed,
        status: result.status,
        steps: result.steps,
        length: scenario.length,
        heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1e5) / 10,
      };
      if (result.status === 'fail') {
        row.failure = result.failure;
        row.actions = result.actions.map(describeAction);
        const minimized = await minimize(
          scenario,
          result.actions,
          result.failure!.invariant,
        );
        let rerunFailures = 0;
        for (let k = 0; k < 10; k++) {
          if ((await runScenario(scenario)).status === 'fail') rerunFailures++;
        }
        failures.push({ seed, result, minimized, rerunFailures });
        writeArtifact(`failure-${seed}.json`, {
          scenario,
          result,
          minimized: {
            ...minimized,
            actions: (minimized.actions ?? []).map(describeAction),
          },
          rerunFailures10: rerunFailures,
        });
      } else if (DETERMINISM_EVERY > 0 && n % DETERMINISM_EVERY === 0) {
        // I8 determinism: replay → identical trace.
        const replay = await runScenario(scenario);
        stepsExecuted += replay.steps;
        row.deterministic = traceKey(replay) === traceKey(result);
        if (!row.deterministic) {
          writeArtifact(`nondeterministic-${seed}.json`, { result, replay });
        }
      }
      table.push(row);
    }
    const summary = {
      iterations: ITER,
      seedBase: SEED_BASE,
      stepsExecuted,
      failures: failures.map(f => ({
        seed: f.seed,
        invariant: f.result.failure!.invariant,
        step: f.result.failure!.step,
        detail: f.result.failure!.detail,
        minimizedActions: (f.minimized.actions ?? []).map(describeAction),
        rerunFailures10: f.rerunFailures,
      })),
      nondeterministic: table
        .filter(r => r.deterministic === false)
        .map(r => r.seed),
      determinismChecked: table.filter(r => r.deterministic !== undefined)
        .length,
      outcomeHistogram,
    };
    writeArtifact('results.json', { summary, table });
    writeArtifact('traces.json', traces);
    expect(summary.nondeterministic).toEqual([]);
    expect(summary.failures).toEqual([]);
  });
});
