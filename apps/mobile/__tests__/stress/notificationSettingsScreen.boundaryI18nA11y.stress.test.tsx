/**
 * STRESS — NotificationSettingsScreen × BOUNDARY / I18N / A11Y.
 *
 * The real screen is mounted inside the providers the app uses
 * (SafeAreaProvider → QueryClientProvider → NavigationContainer → native
 * stack, with a stub "Tabs" route underneath so the header Back pops a real
 * route). Stores and hooks are real; only the SQLite kv (in-memory Map with
 * failure injection), the notification scheduler (SchedulerPort fake) and
 * the consistency snapshot are doubled — all native boundaries.
 *
 * Every variant is a pure function of its seed (test-support/stress/
 * notificationSettingsStress.ts → scenarioFromSeed): font scale × width ×
 * permission form a fixed grid over the seed, the persisted-kv payload
 * (200+ char Latin / CJK / Arabic / ZWJ emoji / combining marks / German
 * compounds / bidi controls / NUL / 10k+60k blobs; zero / negative / huge /
 * float / NaN-string numerics), failure injections, the wall-clock instant
 * (DST edges), locale (RTL for ar-EG) and a 0–7 tap sequence come from the
 * seed's RNG stream.
 *
 * Per variant the harness asserts:
 *   - mount/hydrate never throws and React logs no console.error;
 *   - the persisted-prefs contract (independent oracle): every switch shows a
 *     boolean, the time label is `h:mm AM|PM` of an integer in [0,1440), no
 *     payload string leaks into any <Text>, nothing renders NaN/undefined;
 *   - every interactive host node has an interactive role, a label,
 *     boolean state where applicable, and a ≥44pt target (style + wrapper +
 *     hitSlop), and no two ENABLED interactives share a label;
 *   - after each tap the store and the tree match an oracle model of the
 *     screen (presets, ±30m wrap, switches, opt-in grant/deny/error,
 *     system-settings recovery, permission re-check);
 *   - a persist failure surfaces exactly one alert row and a scheduling
 *     failure another; the kv round-trips when persistence works;
 *   - when reminders are active the applied plan's practice reminder fires
 *     at the chosen wall-clock minutes in the PROCESS time zone (or the
 *     chosen time falls in a DST gap), strictly ≥ 90 s in the future;
 *   - Back pops the route in the real navigator.
 *
 * Scale:   STRESS_ITER=<n>  seeds per run (default 36 = one full grid pass)
 * Replay:  STRESS_ONLY=<seed>[,<seed>…]
 * Base:    STRESS_SEED_BASE=<n> first seed (default 1)
 * Output:  STRESS_OUT=<dir>  JSON tables + rendered trees (default
 *          artifacts/stress); STRESS_TREES=all keeps every variant's tree.
 * Zones:   for tz in UTC Pacific/Kiritimati Etc/GMT+12 America/New_York \
 *            Europe/Berlin Australia/Sydney Asia/Kolkata Pacific/Chatham; do
 *            TZ=$tz STRESS_ITER=200 npx jest --ci __tests__/stress/notificationSettingsScreen.boundaryI18nA11y.stress.test.tsx
 *          done
 */
import React from 'react';
import { Dimensions, I18nManager } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  NavigationContainer,
  type NavigationState,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type {
  PermissionState,
  SchedulerPort,
} from '../../src/notifications/service';
import type { PlannedNotification } from '../../src/notifications/types';
import {
  DEFAULT_NOTIFICATION_PREFS,
  notificationPrefsKeyForOwner,
} from '../../src/notifications/types';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
  useNotificationStore,
} from '../../src/notifications/notificationStore';
import {
  MINUTES_IN_DAY,
  MIN_TARGET_PT,
  PREF_BOOL_KEYS,
  PRESETS,
  TIME_STEP_MINUTES,
  auditTree,
  expectedTimeLabel,
  isDstGap,
  localMinutesOf,
  presetAccessibilityLabel,
  scenarioFromSeed,
  type PrefBoolKey,
  type Scenario,
  type SeedResult,
  type TreeNode,
} from '../../test-support/stress/notificationSettingsStress';

// Node built-ins for the artifacts; the mobile tsconfig has no node typings.
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

// ─── Native doubles ──────────────────────────────────────────────────────────

const mockKv = new Map<string, string>();
let mockKvWriteFails = false;
let mockKvWrites = 0;

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        const value = mockKv.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        mockKvWrites += 1;
        if (mockKvWriteFails) throw new Error('SQLITE_FULL (injected)');
        mockKv.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

class FakeScheduler implements SchedulerPort {
  permission: PermissionState = 'undetermined';
  permissionStateError: Error | null = null;
  requestResult: PermissionState = 'granted';
  requestError: Error | null = null;
  applyError: Error | null = null;
  openSettingsError: Error | null = null;
  appliedPlans: PlannedNotification[][] = [];
  cancelAllCalls = 0;
  openSettingsCalls = 0;

  reset() {
    this.permission = 'undetermined';
    this.permissionStateError = null;
    this.requestResult = 'granted';
    this.requestError = null;
    this.applyError = null;
    this.openSettingsError = null;
    this.appliedPlans = [];
    this.cancelAllCalls = 0;
    this.openSettingsCalls = 0;
  }
  async permissionState(): Promise<PermissionState> {
    if (this.permissionStateError) throw this.permissionStateError;
    return this.permission;
  }
  async requestPermission(): Promise<PermissionState> {
    if (this.requestError) throw this.requestError;
    this.permission = this.requestResult;
    return this.requestResult;
  }
  async applyPlan(plan: readonly PlannedNotification[]): Promise<void> {
    if (this.applyError) throw this.applyError;
    this.appliedPlans.push([...plan]);
  }
  async cancelAllPlanned(): Promise<void> {
    this.cancelAllCalls += 1;
  }
  async openSystemSettings(): Promise<void> {
    this.openSettingsCalls += 1;
    if (this.openSettingsError) throw this.openSettingsError;
  }
}
const mockScheduler = new FakeScheduler();
jest.mock('../../src/notifications/service', () => ({
  getScheduler: () => mockScheduler,
}));

const mockSnapshot = {
  currentStreak: 0,
  trainedToday: false,
  totalActivities: 0,
  shieldsAvailable: 0,
  nextStreakMilestone: null as null,
};
jest.mock('../../src/consistency/store', () => ({
  computeConsistencySnapshot: async () => mockSnapshot,
}));

import { NotificationSettingsScreen } from '../../src/screens/NotificationSettingsScreen';

// ─── Campaign parameters ─────────────────────────────────────────────────────

const ITER = Number(process.env.STRESS_ITER ?? 36);
const SEED_BASE = Number(process.env.STRESS_SEED_BASE ?? 1);
const ONLY = process.env.STRESS_ONLY ?? null;
const OUT_DIR =
  process.env.STRESS_OUT ?? join(__dirname, '..', '..', 'artifacts', 'stress');
const KEEP_ALL_TREES = process.env.STRESS_TREES === 'all';
const TEST_FILE =
  '__tests__/stress/notificationSettingsScreen.boundaryI18nA11y.stress.test.tsx';

function seeds(): number[] {
  if (ONLY) {
    const list = ONLY.split(',').map(s => Number(s.trim()));
    if (list.some(n => !Number.isInteger(n))) {
      throw new Error(`STRESS_ONLY must be <seed>[,<seed>…], got ${ONLY}`);
    }
    return list;
  }
  if (!Number.isInteger(ITER) || ITER < 1) {
    throw new Error(`STRESS_ITER must be a positive integer, got ${ITER}`);
  }
  return Array.from({ length: ITER }, (_, i) => SEED_BASE + i);
}

const processTz = (): string =>
  new Intl.DateTimeFormat().resolvedOptions().timeZone;

// ─── Mounting inside the real providers/navigator ────────────────────────────

type StackParams = { Tabs: undefined; NotificationSettings: undefined };
const Stack = createNativeStackNavigator<StackParams>();
const TabsStub = () => null;

interface Mounted {
  renderer: TestRenderer.ReactTestRenderer;
  routeNames: () => string[];
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
  });
}

async function mountScreen(): Promise<Mounted> {
  const queryClient = new QueryClient();
  let routes: string[] = ['Tabs', 'NotificationSettings'];
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 47, bottom: 34, left: 0, right: 0 },
        }}
      >
        <QueryClientProvider client={queryClient}>
          <NavigationContainer
            initialState={{
              routes: [{ name: 'Tabs' }, { name: 'NotificationSettings' }],
            }}
            onStateChange={(state: NavigationState | undefined) => {
              routes = state ? state.routes.map(r => r.name) : [];
            }}
          >
            <Stack.Navigator>
              <Stack.Screen name="Tabs" component={TabsStub} />
              <Stack.Screen
                name="NotificationSettings"
                component={NotificationSettingsScreen}
                options={{ title: 'Notifications' }}
              />
            </Stack.Navigator>
          </NavigationContainer>
        </QueryClientProvider>
      </SafeAreaProvider>,
    );
  });
  await flush();
  return { renderer, routeNames: () => routes };
}

function hostByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
): TestRenderer.ReactTestInstance | null {
  const matches = renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      node.props.accessibilityLabel === label &&
      typeof node.props.onClick === 'function',
  );
  return matches[0] ?? null;
}

/** Drives the press through the host node's click path (Pressability). */
async function tap(node: TestRenderer.ReactTestInstance) {
  await act(async () => {
    node.props.onClick();
  });
  await flush();
}

function treeJson(
  renderer: TestRenderer.ReactTestRenderer,
): TreeNode | TreeNode[] | null {
  return renderer.toJSON() as unknown as TreeNode | TreeNode[] | null;
}

function serializeTree(tree: unknown): string {
  return JSON.stringify(
    tree,
    (key, value: unknown) => {
      if (typeof value === 'function') return `[fn ${key}]`;
      if (key === 'children' && value === null) return undefined;
      return value;
    },
    1,
  );
}

// ─── Oracle model of the screen ──────────────────────────────────────────────

interface Model {
  bools: Record<PrefBoolKey, boolean>;
  minutes: number;
  permission: 'granted' | 'denied' | 'undetermined' | 'unknown';
  requestFailed: boolean;
  settingsOpenFailed: boolean;
}

const SWITCH_TO_KEY: Record<string, PrefBoolKey> = {
  'All reminders': 'enabled',
  'Practice nudge': 'practiceReminder',
  'Streak defense': 'streakDefense',
  'Weekly recap': 'weeklyRecap',
  'Welcome back': 'comeback',
};

function expectedVisibleControls(model: Model): Set<string> {
  const labels = new Set<string>(['Back']);
  const denied = model.permission === 'denied';
  if (denied) labels.add('Open system settings');
  if (model.bools.enabled && model.permission === 'unknown')
    labels.add('Check again');
  if (!model.bools.enabled && !denied) {
    labels.add('Turn on reminders');
    if (model.requestFailed) labels.add('Open system settings');
  } else if (model.bools.enabled) {
    for (const label of Object.keys(SWITCH_TO_KEY)) labels.add(label);
    for (let i = 0; i < PRESETS.length; i += 1)
      labels.add(presetAccessibilityLabel(i));
    labels.add('Reminder 30 minutes earlier');
    labels.add('Reminder 30 minutes later');
  }
  return labels;
}

function checkAgainstModel(
  renderer: TestRenderer.ReactTestRenderer,
  model: Model,
  scenario: Scenario,
  phase: string,
  failures: string[],
) {
  const store = useNotificationStore.getState();
  const tree = treeJson(renderer);
  const audit = auditTree(tree, {
    fontScale: scenario.fontScale,
    width: scenario.width,
    rtl: scenario.rtl,
    payloadStrings: scenario.payloadStrings,
  });
  for (const v of audit.violations) failures.push(`${phase}: a11y/text ${v}`);

  // Store ↔ model.
  for (const key of PREF_BOOL_KEYS) {
    if (store.prefs[key] !== model.bools[key]) {
      failures.push(
        `${phase}: store.prefs.${key}=${String(store.prefs[key])} expected ${String(model.bools[key])}`,
      );
    }
  }
  if (store.prefs.practiceReminderMinutes !== model.minutes) {
    failures.push(
      `${phase}: store minutes ${store.prefs.practiceReminderMinutes} expected ${model.minutes}`,
    );
  }
  if (
    !Number.isInteger(store.prefs.practiceReminderMinutes) ||
    store.prefs.practiceReminderMinutes < 0 ||
    store.prefs.practiceReminderMinutes >= MINUTES_IN_DAY
  ) {
    failures.push(
      `${phase}: store minutes out of range ${store.prefs.practiceReminderMinutes}`,
    );
  }
  if (store.permission !== model.permission) {
    failures.push(
      `${phase}: store.permission=${store.permission} expected ${model.permission}`,
    );
  }

  // Tree ↔ model: which controls exist, their state.
  const present = new Map<string, (typeof audit.interactives)[number]>();
  for (const it of audit.interactives) if (it.label) present.set(it.label, it);
  const expected = expectedVisibleControls(model);
  for (const label of expected) {
    if (!present.has(label))
      failures.push(`${phase}: control "${label}" missing from tree`);
  }
  for (const label of present.keys()) {
    if (!expected.has(label))
      failures.push(`${phase}: unexpected control "${label}" in tree`);
  }
  if (model.bools.enabled && model.permission !== 'denied') {
    for (const [label, key] of Object.entries(SWITCH_TO_KEY)) {
      const sw = present.get(label);
      if (sw && sw.checked !== model.bools[key]) {
        failures.push(
          `${phase}: switch "${label}" checked=${String(sw.checked)} expected ${String(model.bools[key])}`,
        );
      }
      if (sw && sw.role !== 'switch')
        failures.push(
          `${phase}: "${label}" role=${String(sw.role)} expected switch`,
        );
    }
    const timeDisabled = !model.bools.practiceReminder;
    PRESETS.forEach((preset, i) => {
      const node = present.get(presetAccessibilityLabel(i));
      if (!node) return;
      const shouldSelect = model.minutes === preset.minutes;
      if (node.selected !== shouldSelect) {
        failures.push(
          `${phase}: preset ${preset.label} selected=${String(node.selected)} expected ${String(shouldSelect)}`,
        );
      }
      if ((node.disabled ?? false) !== timeDisabled) {
        failures.push(
          `${phase}: preset ${preset.label} disabled=${String(node.disabled)} expected ${String(timeDisabled)}`,
        );
      }
    });
    for (const label of [
      'Reminder 30 minutes earlier',
      'Reminder 30 minutes later',
    ]) {
      const node = present.get(label);
      if (node && (node.disabled ?? false) !== timeDisabled) {
        failures.push(
          `${phase}: "${label}" disabled=${String(node.disabled)} expected ${String(timeDisabled)}`,
        );
      }
    }
    // Time label (and its accessibility label) must be the independent format.
    const want = expectedTimeLabel(model.minutes);
    const timeText = audit.texts.find(t => t.text === want);
    if (!timeText) {
      failures.push(
        `${phase}: time label "${want}" not rendered (texts: ${audit.texts
          .map(t => t.text)
          .filter(t => /AM|PM/.test(t))
          .join(' | ')})`,
      );
    }
    const labelled = renderer.root.findAll(
      n =>
        typeof n.type === 'string' &&
        n.props.accessibilityLabel === `Reminder time ${want}`,
    );
    if (labelled.length !== 1)
      failures.push(
        `${phase}: "Reminder time ${want}" accessibilityLabel count ${labelled.length}`,
      );
  }

  // Alerts: persist / schedule failure rows and inline errors. The
  // "couldn't open Settings" footnote lives in the denied card, or in the
  // opt-in card only underneath a failed prompt.
  const denied = model.permission === 'denied';
  const optInCard = !model.bools.enabled && !denied;
  const wantAlerts =
    (store.persistFailed ? 1 : 0) +
    (store.scheduleFailed ? 1 : 0) +
    (optInCard && model.requestFailed ? 1 : 0) +
    (model.settingsOpenFailed && (denied || (optInCard && model.requestFailed))
      ? 1
      : 0);
  if (audit.alerts !== wantAlerts) {
    failures.push(
      `${phase}: ${audit.alerts} alert(s) rendered, expected ${wantAlerts} (persistFailed=${store.persistFailed} scheduleFailed=${store.scheduleFailed} requestFailed=${model.requestFailed} settingsOpenFailed=${model.settingsOpenFailed})`,
    );
  }
  return audit;
}

// ─── One seed ────────────────────────────────────────────────────────────────

async function runSeed(
  seed: number,
): Promise<{ result: SeedResult; trees: Record<string, string> }> {
  const started = Date.now();
  const scenario = scenarioFromSeed(seed);
  const failures: string[] = [];
  const consoleErrors: string[] = [];
  const trees: Record<string, string> = {};

  // Environment for this variant.
  mockKv.clear();
  mockKvWrites = 0;
  mockKvWriteFails = scenario.persistFails;
  mockScheduler.reset();
  mockScheduler.permission =
    scenario.permission === 'error' ? 'undetermined' : scenario.permission;
  mockScheduler.permissionStateError =
    scenario.permission === 'error'
      ? new Error('UNNotificationCenter unavailable (injected)')
      : null;
  mockScheduler.requestResult =
    scenario.promptResult === 'error' ? 'undetermined' : scenario.promptResult;
  mockScheduler.requestError =
    scenario.promptResult === 'error'
      ? new Error('prompt failed (injected)')
      : null;
  mockScheduler.applyError = scenario.scheduleFails
    ? new Error('trigger rejected (injected)')
    : null;
  mockScheduler.openSettingsError = scenario.openSettingsFails
    ? new Error('Linking failed (injected)')
    : null;
  mockSnapshot.currentStreak = scenario.streakDays;
  mockSnapshot.trainedToday = scenario.practicedToday;
  mockSnapshot.totalActivities = scenario.hasAnyHistory ? 12 : 0;

  setActiveDataOwner(scenario.ownerId);
  if (scenario.kvPrefsRaw !== null && scenario.owner !== 'signed-out') {
    mockKv.set(
      notificationPrefsKeyForOwner(scenario.ownerId),
      scenario.kvPrefsRaw,
    );
  }
  if (scenario.kvPendingRaw !== null) {
    mockKv.set(PENDING_NOTIFICATION_ONBOARDING_KV_KEY, scenario.kvPendingRaw);
  }
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
    persistFailed: false,
    scheduleFailed: false,
  });

  const nowMs = Date.parse(scenario.now.iso);
  const dateNow = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
  const dims = jest.spyOn(Dimensions, 'get').mockImplementation(
    () =>
      ({
        width: scenario.width,
        height: 844,
        scale: 3,
        fontScale: scenario.fontScale,
      }) as ReturnType<typeof Dimensions.get>,
  );
  const previousRtl = I18nManager.isRTL;
  (I18nManager as { isRTL: boolean }).isRTL = scenario.rtl;
  const consoleError = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(
        args
          .map(a => (a instanceof Error ? a.message : String(a)))
          .join(' ')
          .slice(0, 300),
      );
    });

  let renderer: TestRenderer.ReactTestRenderer | null = null;
  let actionsExecuted = 0;
  let plannedPracticeLocalMinutes: number | null = null;
  let dstGap = false;
  let finalMinutes: number | null = null;
  let timeLabel: string | null = null;
  let lastAudit: ReturnType<typeof auditTree> | null = null;

  try {
    // App-level bootstrap: hydrate before the screen is reached.
    await act(async () => {
      await useNotificationStore.getState().hydrate();
    });

    const model: Model = {
      bools: { ...scenario.expectedBools },
      minutes: scenario.expectedMinutes,
      permission:
        scenario.permission === 'error' ? 'unknown' : scenario.permission,
      requestFailed: false,
      settingsOpenFailed: false,
    };
    const signedOut = scenario.owner === 'signed-out';

    const mounted = await mountScreen();
    renderer = mounted.renderer;
    lastAudit = checkAgainstModel(renderer, model, scenario, 'mount', failures);
    trees.mount = serializeTree(treeJson(renderer));

    const initialFailureCount = failures.length;

    for (const action of scenario.actions) {
      const visible = expectedVisibleControls(model);
      let label: string | null = null;
      switch (action.kind) {
        case 'turn-on':
          label = 'Turn on reminders';
          break;
        case 'switch':
          label = String(action.target);
          break;
        case 'preset':
          label = presetAccessibilityLabel(Number(action.target));
          break;
        case 'earlier':
          label = 'Reminder 30 minutes earlier';
          break;
        case 'later':
          label = 'Reminder 30 minutes later';
          break;
        case 'open-settings':
          label = 'Open system settings';
          break;
        case 'check-again':
          label = 'Check again';
          break;
      }
      if (!visible.has(label)) continue; // not reachable in this state — skip
      const node = hostByLabel(renderer, label);
      if (!node) {
        failures.push(
          `action ${actionsExecuted} (${action.kind}): "${label}" expected visible but not found`,
        );
        break;
      }
      const wasDisabled = node.props.accessibilityState?.disabled === true;
      await tap(node);
      actionsExecuted += 1;

      // Advance the oracle.
      if (!wasDisabled && !signedOut) {
        switch (action.kind) {
          case 'turn-on':
            if (scenario.promptResult === 'granted') {
              model.permission = 'granted';
              model.bools.enabled = true;
              model.bools.promptDismissed = true;
              model.requestFailed = false;
            } else if (scenario.promptResult === 'denied') {
              model.permission = 'denied';
              model.requestFailed = false;
            } else {
              model.permission = 'unknown';
              model.requestFailed = true;
            }
            break;
          case 'switch': {
            const key = SWITCH_TO_KEY[label]!;
            model.bools[key] = !model.bools[key];
            break;
          }
          case 'preset':
            model.minutes = PRESETS[Number(action.target)]!.minutes;
            break;
          case 'earlier':
            model.minutes =
              (model.minutes - TIME_STEP_MINUTES + MINUTES_IN_DAY) %
              MINUTES_IN_DAY;
            break;
          case 'later':
            model.minutes =
              (model.minutes + TIME_STEP_MINUTES) % MINUTES_IN_DAY;
            break;
          case 'open-settings':
            model.settingsOpenFailed = scenario.openSettingsFails;
            break;
          case 'check-again':
            model.permission =
              scenario.permission === 'error' ? 'unknown' : scenario.permission;
            break;
        }
      } else if (!wasDisabled && signedOut && action.kind === 'turn-on') {
        // Signed-out: the prompt still runs, but setPrefs is a no-op.
        if (scenario.promptResult === 'granted') {
          model.permission = 'granted';
          model.requestFailed = false;
        } else if (scenario.promptResult === 'denied') {
          model.permission = 'denied';
          model.requestFailed = false;
        } else {
          model.permission = 'unknown';
          model.requestFailed = true;
        }
      } else if (!wasDisabled && signedOut && action.kind === 'open-settings') {
        model.settingsOpenFailed = scenario.openSettingsFails;
      } else if (!wasDisabled && signedOut && action.kind === 'check-again') {
        model.permission =
          scenario.permission === 'error' ? 'unknown' : scenario.permission;
      }
      lastAudit = checkAgainstModel(
        renderer,
        model,
        scenario,
        `after ${action.kind}#${actionsExecuted}`,
        failures,
      );
      if (failures.length > initialFailureCount) {
        trees[`after-${action.kind}-${actionsExecuted}`] = serializeTree(
          treeJson(renderer),
        );
        break;
      }
    }

    // Persistence round-trip (only when the kv accepts writes and we wrote).
    const store = useNotificationStore.getState();
    finalMinutes = store.prefs.practiceReminderMinutes;
    timeLabel = expectedTimeLabel(finalMinutes);
    if (!signedOut && !scenario.persistFails && mockKvWrites > 0) {
      const raw = mockKv.get(notificationPrefsKeyForOwner(scenario.ownerId));
      if (!raw) failures.push('persist: no kv row after a successful write');
      else {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        for (const key of PREF_BOOL_KEYS) {
          if (parsed[key] !== store.prefs[key])
            failures.push(
              `persist: kv ${key}=${String(parsed[key])} store ${String(store.prefs[key])}`,
            );
        }
        if (
          parsed['practiceReminderMinutes'] !==
          store.prefs.practiceReminderMinutes
        ) {
          failures.push(
            `persist: kv minutes ${String(parsed['practiceReminderMinutes'])} store ${store.prefs.practiceReminderMinutes}`,
          );
        }
        if (parsed['version'] !== 1)
          failures.push(`persist: kv version ${String(parsed['version'])}`);
      }
    }
    if (
      scenario.persistFails &&
      mockKvWrites > 0 &&
      !signedOut &&
      !store.persistFailed
    ) {
      failures.push('persist: write failed but persistFailed=false');
    }

    // Scheduling contract in the PROCESS time zone.
    const lastPlan =
      mockScheduler.appliedPlans[mockScheduler.appliedPlans.length - 1];
    if (
      store.prefs.enabled &&
      store.permission === 'granted' &&
      !scenario.scheduleFails &&
      !signedOut
    ) {
      if (!lastPlan)
        failures.push('schedule: active reminders but no plan applied');
      else {
        for (const item of lastPlan) {
          if (item.timestampMs < nowMs + 90_000)
            failures.push(
              `schedule: ${item.id} fires ${item.timestampMs - nowMs}ms after now (< 90s)`,
            );
          if (!item.title || !item.body)
            failures.push(`schedule: ${item.id} has empty copy`);
        }
        const practice = lastPlan.find(p => p.id === 'ps.reminder.practice');
        if (store.prefs.practiceReminder) {
          if (!practice)
            failures.push('schedule: practice nudge on but not planned');
          else {
            plannedPracticeLocalMinutes = localMinutesOf(practice.timestampMs);
            dstGap = isDstGap(
              practice.timestampMs,
              store.prefs.practiceReminderMinutes,
            );
            if (
              plannedPracticeLocalMinutes !==
                store.prefs.practiceReminderMinutes &&
              !dstGap
            ) {
              failures.push(
                `schedule: practice reminder local ${plannedPracticeLocalMinutes} ≠ chosen ${store.prefs.practiceReminderMinutes} (tz ${processTz()}, now ${scenario.now.label})`,
              );
            }
            if (practice.repeat !== 'daily')
              failures.push(
                `schedule: practice repeat=${String(practice.repeat)}`,
              );
          }
        } else if (practice)
          failures.push('schedule: practice nudge off but planned');
      }
    }
    if (
      scenario.scheduleFails &&
      store.prefs.enabled &&
      store.permission === 'granted' &&
      !signedOut &&
      !store.scheduleFailed
    ) {
      failures.push('schedule: applyPlan threw but scheduleFailed=false');
    }

    // Back pops the real route.
    if (scenario.pressBackAtEnd) {
      const back = hostByLabel(renderer, 'Back');
      if (!back) failures.push('back: header Back control missing');
      else {
        await tap(back);
        const routes = mounted.routeNames();
        if (routes.length !== 1 || routes[0] !== 'Tabs')
          failures.push(`back: routes after Back = ${routes.join(',')}`);
      }
    }
  } catch (error) {
    failures.push(
      `threw: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    );
  } finally {
    if (renderer) {
      const r = renderer;
      await act(async () => {
        r.unmount();
      });
    }
    consoleError.mockRestore();
    (I18nManager as { isRTL: boolean }).isRTL = previousRtl;
    dims.mockRestore();
    dateNow.mockRestore();
    mockKvWriteFails = false;
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  }

  for (const m of consoleErrors) failures.push(`console.error: ${m}`);

  const { payloadStrings: _payloadStrings, kvPrefsRaw, ...rest } = scenario;
  void _payloadStrings;
  const result: SeedResult = {
    seed,
    outcome: failures.length === 0 ? 'HELD' : 'BROKEN',
    tz: processTz(),
    scenario: {
      ...rest,
      kvPrefsRawPreview: kvPrefsRaw === null ? null : kvPrefsRaw.slice(0, 200),
      kvPrefsRawLength: kvPrefsRaw?.length ?? 0,
    },
    interactives: lastAudit?.interactives.length ?? 0,
    texts: lastAudit?.texts.length ?? 0,
    alerts: lastAudit?.alerts ?? 0,
    clipRisks: lastAudit?.clipRisks ?? [],
    rtlUnsafe: lastAudit?.rtlUnsafe ?? [],
    actionsExecuted,
    finalMinutes,
    timeLabel,
    plannedPracticeLocalMinutes,
    dstGap,
    consoleErrors,
    failures,
    durationMs: Date.now() - started,
    replay: `TZ=${processTz()} STRESS_ONLY=${seed} npx jest --ci ${TEST_FILE}`,
  };
  return { result, trees };
}

// ─── Campaign ────────────────────────────────────────────────────────────────

const results: SeedResult[] = [];
const savedTrees: Record<string, Record<string, string>> = {};
let savedClipTree = false;

afterAll(() => {
  const tz = processTz().replace(/[^A-Za-z0-9+-]/g, '_');
  const suffix = `${ONLY ? `-only-${ONLY.replace(/,/g, '_')}` : ''}-${tz}`;
  const broken = results.filter(r => r.outcome === 'BROKEN');
  const cells = new Map<string, number>();
  for (const r of results) {
    const key = `${r.scenario.fontScale}x@${r.scenario.width}pt/${r.scenario.permission}`;
    cells.set(key, (cells.get(key) ?? 0) + 1);
  }
  const clipRiskTally = new Map<string, number>();
  for (const r of results) {
    for (const risk of r.clipRisks) {
      const key = risk.replace(/^#\d+(\/[A-Za-z]+\[\d+\])*: /, '');
      clipRiskTally.set(key, (clipRiskTally.get(key) ?? 0) + 1);
    }
  }
  const summary = {
    unit: 'scr-notificationsettingsscreen',
    lens: 'boundary-i18n-a11y',
    tz: processTz(),
    seeds: results.map(r => r.seed),
    executed: results.length,
    held: results.length - broken.length,
    broken: broken.length,
    brokenSeeds: broken.map(r => r.seed),
    actionsExecuted: results.reduce((n, r) => n + r.actionsExecuted, 0),
    gridCells: Object.fromEntries([...cells.entries()].sort()),
    locales: Object.fromEntries(
      results.reduce(
        (m, r) => m.set(r.scenario.locale, (m.get(r.scenario.locale) ?? 0) + 1),
        new Map<string, number>(),
      ),
    ),
    hydrationKinds: Object.fromEntries(
      results.reduce(
        (m, r) =>
          m.set(r.scenario.hydration, (m.get(r.scenario.hydration) ?? 0) + 1),
        new Map<string, number>(),
      ),
    ),
    nowInstants: Object.fromEntries(
      results.reduce(
        (m, r) =>
          m.set(r.scenario.now.label, (m.get(r.scenario.now.label) ?? 0) + 1),
        new Map<string, number>(),
      ),
    ),
    dstGapSeeds: results.filter(r => r.dstGap).map(r => r.seed),
    clipRisks: Object.fromEntries(
      [...clipRiskTally.entries()].sort((a, b) => b[1] - a[1]),
    ),
    rtlUnsafe: [...new Set(results.flatMap(r => r.rtlUnsafe))],
    minTargetPt: MIN_TARGET_PT,
    totalDurationMs: results.reduce((n, r) => n + r.durationMs, 0),
    failures: broken.map(r => ({
      seed: r.seed,
      replay: r.replay,
      failures: r.failures,
    })),
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    join(OUT_DIR, `notification-settings-summary${suffix}.json`),
    JSON.stringify(summary, null, 2),
  );
  writeFileSync(
    join(OUT_DIR, `notification-settings-results${suffix}.json`),
    JSON.stringify(results, null, 2),
  );
  const treesDir = join(OUT_DIR, `notification-settings-trees${suffix}`);
  mkdirSync(treesDir, { recursive: true });
  for (const [seed, byPhase] of Object.entries(savedTrees)) {
    for (const [phase, json] of Object.entries(byPhase)) {
      writeFileSync(join(treesDir, `seed-${seed}-${phase}.json`), json);
    }
  }
});

describe('NotificationSettingsScreen × boundary/i18n/a11y (seeded, real navigator)', () => {
  it.each(seeds().map(s => [s] as const))('seed=%i', async seed => {
    const { result, trees } = await runSeed(seed);
    results.push(result);
    const keep =
      result.outcome === 'BROKEN' ||
      KEEP_ALL_TREES ||
      results.length <= 3 ||
      (result.clipRisks.length > 0 && !savedClipTree);
    if (keep) {
      savedTrees[String(seed)] = trees;
      if (result.clipRisks.length > 0) savedClipTree = true;
    }
    if (result.outcome === 'BROKEN') {
      throw new Error(
        `seed ${seed} BROKEN — replay: ${result.replay}\n` +
          `scenario: ${JSON.stringify({
            fontScale: result.scenario.fontScale,
            width: result.scenario.width,
            permission: result.scenario.permission,
            locale: result.scenario.locale,
            owner: result.scenario.owner,
            hydration: result.scenario.hydration,
            payloadIds: result.scenario.payloadIds,
            now: result.scenario.now.label,
            actions: result.scenario.actions,
          })}\n` +
          result.failures.map(f => `  - ${f}`).join('\n'),
      );
    }
  });
});
