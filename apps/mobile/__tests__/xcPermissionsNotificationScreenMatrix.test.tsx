/**
 * xc-journey-notifications-permissions — NOTIFICATION SETTINGS SCREEN state
 * matrix + priming-card journey.
 *
 * The store harness (xcPermissionsNotificationStoreMatrix) proves what the
 * store does; this suite proves what the PLAYER SEES for every reachable
 * store state and that every state keeps at least one recovery control:
 *
 *   permission ∈ {granted, denied, undetermined, unknown}
 *   × prefs.enabled ∈ {false, true}
 *   × persistFailed ∈ {false, true}
 *   × scheduleFailed ∈ {false, true}
 *   × settings deep-link ∈ {opens, throws}
 *
 * For each of the 64 rows the real NotificationSettingsScreen is rendered
 * against a fake SchedulerPort and the visible controls, captions and
 * recovery paths are recorded to an artifact. Copy is checked against the
 * dossier rules (docs/APP_STORE_SUBMISSION.md + AGENTS.md).
 *
 * Plus the revoke-later journeys the row matrix cannot express:
 *   - granted+enabled → OS permission revoked → Settings focus → denied card
 *     with "Open system settings" → permission restored → focus → active again.
 *   - denied + deep-link failure → manual path copy → "Check again"-equivalent
 *     recovery via focus.
 *   - priming card: Turn on → denied → card disappears (reminders reachable
 *     from Settings); Turn on → prompt throws → "Try again" + Settings copy;
 *     Not now → dismissed, no system prompt.
 *
 * Artifacts: $XC_PERMISSIONS_ARTIFACT_DIR (default
 * <repo>/artifacts/xc-journey-notifications-permissions).
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import type {
  PermissionState,
  SchedulerPort,
} from '../src/notifications/service';
import type { PlannedNotification } from '../src/notifications/types';
import { DEFAULT_NOTIFICATION_PREFS } from '../src/notifications/types';
import { setActiveDataOwner } from '../src/data/accountScope';

const mockKvTable = new Map<string, string>();

jest.mock('../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        const value = mockKvTable.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        mockKvTable.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
  };
});

const mockGoBack = jest.fn();
const mockNavigate = jest.fn();
// The focus effect is re-run on demand by bumping this counter (simulates the
// player returning from the Settings app).
let mockFocusEpoch = 0;
const mockFocusTriggers = new Set<() => void>();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const ReactModule = require('react') as typeof import('react');
    const [, force] = ReactModule.useState(0);
    ReactModule.useEffect(() => {
      const trigger = () => force(n => n + 1);
      mockFocusTriggers.add(trigger);
      return () => {
        mockFocusTriggers.delete(trigger);
      };
    }, []);
    ReactModule.useEffect(() => callback(), [callback, mockFocusEpoch]);
  },
}));

class FakeScheduler implements SchedulerPort {
  permission: PermissionState = 'undetermined';
  requestResult: PermissionState = 'granted';
  requestError: Error | null = null;
  permissionStateError: Error | null = null;
  openSettingsError: Error | null = null;
  applyError: Error | null = null;
  live: PlannedNotification[] = [];
  ops: string[] = [];
  requestCalls = 0;
  openSettingsCalls = 0;
  permissionStateCalls = 0;

  async permissionState(): Promise<PermissionState> {
    this.permissionStateCalls += 1;
    this.ops.push('permissionState');
    if (this.permissionStateError) throw this.permissionStateError;
    return this.permission;
  }
  async requestPermission(): Promise<PermissionState> {
    this.requestCalls += 1;
    this.ops.push('requestPermission');
    if (this.requestError) throw this.requestError;
    this.permission = this.requestResult;
    return this.requestResult;
  }
  async applyPlan(plan: readonly PlannedNotification[]): Promise<void> {
    this.ops.push(`applyPlan(${plan.length})`);
    if (this.applyError) throw this.applyError;
    this.live = [...plan];
  }
  async cancelAllPlanned(): Promise<void> {
    this.ops.push('cancelAllPlanned');
    this.live = [];
  }
  async openSystemSettings(): Promise<void> {
    this.openSettingsCalls += 1;
    this.ops.push('openSystemSettings');
    if (this.openSettingsError) throw this.openSettingsError;
  }
  reset() {
    this.permission = 'undetermined';
    this.requestResult = 'granted';
    this.requestError = null;
    this.permissionStateError = null;
    this.openSettingsError = null;
    this.applyError = null;
    this.live = [];
    this.ops = [];
    this.requestCalls = 0;
    this.openSettingsCalls = 0;
    this.permissionStateCalls = 0;
  }
}

const mockScheduler = new FakeScheduler();
jest.mock('../src/notifications/service', () => ({
  getScheduler: () => mockScheduler,
}));

jest.mock('../src/consistency/store', () => ({
  computeConsistencySnapshot: async () => ({
    currentStreak: 2,
    trainedToday: false,
    totalActivities: 5,
    shieldsAvailable: 0,
    nextStreakMilestone: null,
  }),
}));

import { useNotificationStore } from '../src/notifications/notificationStore';
import { NotificationSettingsScreen } from '../src/screens/NotificationSettingsScreen';
import { NotificationPrimingCard } from '../src/notifications/NotificationPrimingCard';

// ---------------------------------------------------------------------------
// Artifact plumbing
// ---------------------------------------------------------------------------

declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { resolve: resolvePath, join: joinPath } = require('path') as {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
};
const ARTIFACT_DIR =
  process.env['XC_PERMISSIONS_ARTIFACT_DIR'] ??
  resolvePath(
    __dirname,
    '..',
    '..',
    '..',
    'artifacts',
    'xc-journey-notifications-permissions',
  );
function writeArtifact(name: string, value: unknown): string {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const file = joinPath(ARTIFACT_DIR, name);
  writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

const BANNED_COPY = [
  /android/i,
  /google play/i,
  /guest mode/i,
  /live court/i,
  /\bDUPR\b/,
  /swingvision/i,
  /pb vision/i,
  /selkirk/i,
  /joola/i,
  /\d+(\.\d+)?\s?%/,
  /\bmost accurate\b/i,
  /\bbest\b/i,
  /\b#1\b/,
  /replaces? (a|your) coach/i,
  /as good as a coach/i,
  /\bpush notification/i,
];

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

const owner = '77777777-7777-4777-8777-777777777777';

type StorePermission = PermissionState | 'unknown';

function setStoreState(state: {
  permission: StorePermission;
  enabled: boolean;
  persistFailed: boolean;
  scheduleFailed: boolean;
}) {
  useNotificationStore.setState({
    hydrated: true,
    ownerKey: owner,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS, enabled: state.enabled },
    permission: state.permission,
    persistFailed: state.persistFailed,
    scheduleFailed: state.scheduleFailed,
  });
}

function resetStore() {
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
    persistFailed: false,
    scheduleFailed: false,
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
  });
}

async function render(element: React.ReactElement): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  await flush();
  return renderer;
}

async function unmount(renderer: ReactTestRenderer) {
  await act(async () => {
    renderer.unmount();
  });
}

async function refocus() {
  mockFocusEpoch += 1;
  await act(async () => {
    mockFocusTriggers.forEach(trigger => trigger());
  });
  await flush();
}

function textContent(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node =>
      React.Children.toArray(node.props.children)
        .filter(child => typeof child === 'string')
        .join(''),
    )
    .join('\n');
}

/** The Pressable elements (carry role/state/disabled + onPress). */
function pressables(renderer: ReactTestRenderer): ReactTestInstance[] {
  return renderer.root.findAll(
    node =>
      typeof node.props.accessibilityLabel === 'string' &&
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityRole !== undefined,
  );
}

function pressableByLabel(
  renderer: ReactTestRenderer,
  label: string,
): ReactTestInstance | null {
  return (
    pressables(renderer).find(
      node => node.props.accessibilityLabel === label,
    ) ?? null
  );
}

async function press(renderer: ReactTestRenderer, label: string) {
  const node = pressableByLabel(renderer, label);
  if (!node) {
    throw new Error(
      `No pressable "${label}". Visible: ${pressables(renderer)
        .map(n => String(n.props.accessibilityLabel))
        .join(', ')}`,
    );
  }
  expect(
    node.props.accessibilityState?.disabled ?? node.props.disabled,
  ).not.toBe(true);
  await act(async () => {
    node.props.onPress();
  });
  await flush();
}

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

const PERMISSIONS: StorePermission[] = [
  'granted',
  'denied',
  'undetermined',
  'unknown',
];

const RECOVERY_LABELS = [
  'Turn on reminders',
  'Open system settings',
  'Check again',
  'All reminders',
] as const;

interface MatrixRow {
  permission: StorePermission;
  enabled: boolean;
  persistFailed: boolean;
  scheduleFailed: boolean;
  deepLink: 'opens' | 'throws';
  permissionAfterFocus: StorePermission;
  controls: string[];
  enabledControls: string[];
  recoveryControls: string[];
  masterCaption: string | null;
  showsDeniedCard: boolean;
  showsUnknownCard: boolean;
  showsEnableCard: boolean;
  showsPersistAlert: boolean;
  showsScheduleAlert: boolean;
  showsManualSettingsPath: boolean;
  openSettingsCalls: number;
  minStepsToRequestPermission: number | null;
  violations: string[];
}

describe('xc notification settings screen — state × deep-link matrix', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockKvTable.clear();
    mockScheduler.reset();
    mockFocusEpoch = 0;
    setActiveDataOwner(owner);
    resetStore();
  });

  it('every store state renders a recoverable surface with dossier-safe copy (64 rows)', async () => {
    const rows: MatrixRow[] = [];
    for (const permission of PERMISSIONS) {
      for (const enabled of [false, true]) {
        for (const persistFailed of [false, true]) {
          for (const scheduleFailed of [false, true]) {
            for (const deepLink of ['opens', 'throws'] as const) {
              mockScheduler.reset();
              if (permission === 'unknown') {
                mockScheduler.permissionStateError = new Error(
                  'UNUserNotificationCenter unavailable',
                );
              } else {
                mockScheduler.permission = permission;
              }
              mockScheduler.openSettingsError =
                deepLink === 'throws'
                  ? new Error('Linking.openURL failed')
                  : null;
              setStoreState({
                permission,
                enabled,
                persistFailed,
                scheduleFailed,
              });

              const renderer = await render(<NotificationSettingsScreen />);
              const violations: string[] = [];
              const permissionAfterFocus =
                useNotificationStore.getState().permission;

              // Exercise the deep link wherever it is offered.
              let showsManualSettingsPath = false;
              if (pressableByLabel(renderer, 'Open system settings')) {
                await press(renderer, 'Open system settings');
                showsManualSettingsPath = textContent(renderer).includes(
                  'Couldn’t open Settings from here',
                );
                if (deepLink === 'throws' && !showsManualSettingsPath) {
                  violations.push(
                    'deep-link failure without the manual Settings path copy',
                  );
                }
                if (deepLink === 'opens' && showsManualSettingsPath) {
                  violations.push(
                    'manual Settings path shown on a successful deep link',
                  );
                }
              }

              const text = textContent(renderer);
              const all = pressables(renderer);
              const controls = all.map(n => String(n.props.accessibilityLabel));
              const enabledControls = all
                .filter(
                  n =>
                    !(n.props.accessibilityState?.disabled ?? n.props.disabled),
                )
                .map(n => String(n.props.accessibilityLabel));
              const recoveryControls = RECOVERY_LABELS.filter(label =>
                enabledControls.includes(label),
              );
              const showsDeniedCard = text.includes(
                'Notifications are off in system settings',
              );
              const showsUnknownCard = text.includes(
                'Couldn’t check notification permission',
              );
              const showsEnableCard = text.includes('Stay match-ready.');
              const masterCaption = text.includes(
                'Scheduled from your real practice history',
              )
                ? 'Scheduled from your real practice history'
                : text.includes(
                      'Paused — notification permission couldn’t be checked',
                    )
                  ? 'Paused — notification permission couldn’t be checked'
                  : text.includes('Paused until notifications are allowed')
                    ? 'Paused until notifications are allowed'
                    : null;

              // Steps from this screen to a control that asks the OS for
              // permission (Turn on reminders) or re-reads it (Check again /
              // Open system settings + return).
              let minStepsToRequestPermission: number | null = null;
              if (permissionAfterFocus === 'granted') {
                minStepsToRequestPermission = 0;
              } else if (
                recoveryControls.includes('Turn on reminders') ||
                recoveryControls.includes('Open system settings') ||
                recoveryControls.includes('Check again')
              ) {
                minStepsToRequestPermission = 1;
              } else if (recoveryControls.includes('All reminders')) {
                // Master switch off → enable card → Turn on reminders.
                minStepsToRequestPermission = 2;
              }

              // Invariants -----------------------------------------------
              if (enabledControls.filter(l => l !== 'Back').length === 0) {
                violations.push('no enabled control besides Back');
              }
              if (recoveryControls.length === 0) {
                violations.push('no recovery control at all');
              }
              if (permission === 'denied' && !showsDeniedCard) {
                violations.push('denied permission without the denied card');
              }
              if (
                permission === 'denied' &&
                !recoveryControls.includes('Open system settings')
              ) {
                violations.push(
                  'denied permission without "Open system settings"',
                );
              }
              if (
                permission === 'unknown' &&
                enabled &&
                !recoveryControls.includes('Check again')
              ) {
                violations.push(
                  'unknown permission while enabled without "Check again"',
                );
              }
              if (
                !enabled &&
                permission !== 'denied' &&
                !recoveryControls.includes('Turn on reminders')
              ) {
                violations.push('reminders off without "Turn on reminders"');
              }
              if (
                persistFailed !==
                text.includes('This change couldn’t be saved on this phone')
              ) {
                violations.push('persistFailed alert mismatch');
              }
              if (
                scheduleFailed !==
                text.includes('Reminders couldn’t be scheduled on this phone')
              ) {
                violations.push('scheduleFailed alert mismatch');
              }
              const claimsActive =
                masterCaption === 'Scheduled from your real practice history';
              if (
                claimsActive !== (enabled && permissionAfterFocus === 'granted')
              ) {
                violations.push(
                  `master caption claims active=${claimsActive} but enabled=${enabled} permission=${permissionAfterFocus}`,
                );
              }
              for (const rule of BANNED_COPY) {
                if (rule.test(text))
                  violations.push(`banned copy matched ${rule}`);
              }

              rows.push({
                permission,
                enabled,
                persistFailed,
                scheduleFailed,
                deepLink,
                permissionAfterFocus,
                controls,
                enabledControls,
                recoveryControls: [...recoveryControls],
                masterCaption,
                showsDeniedCard,
                showsUnknownCard,
                showsEnableCard,
                showsPersistAlert: text.includes(
                  'This change couldn’t be saved on this phone',
                ),
                showsScheduleAlert: text.includes(
                  'Reminders couldn’t be scheduled on this phone',
                ),
                showsManualSettingsPath,
                openSettingsCalls: mockScheduler.openSettingsCalls,
                minStepsToRequestPermission,
                violations,
              });
              await unmount(renderer);
            }
          }
        }
      }
    }

    const failing = rows.filter(r => r.violations.length > 0);
    const twoStepRows = rows.filter(r => r.minStepsToRequestPermission === 2);
    writeArtifact('notification-screen-matrix.json', {
      generatedAt: new Date().toISOString(),
      rowCount: rows.length,
      failingRows: failing.length,
      observations: {
        OBS2_TWO_STEP_RECOVERY:
          'rows where the only way to (re)ask for permission is master switch OFF → "Turn on reminders" (enabled=true with a non-granted, non-denied, non-unknown permission — undetermined). Reachability from a real device state is UNKNOWN from Linux (iOS wipes both prefs kv and authorization on reinstall).',
        rows: twoStepRows.map(r => ({
          permission: r.permission,
          enabled: r.enabled,
          persistFailed: r.persistFailed,
          scheduleFailed: r.scheduleFailed,
          deepLink: r.deepLink,
          recoveryControls: r.recoveryControls,
          masterCaption: r.masterCaption,
        })),
      },
      rows,
    });
    expect(rows).toHaveLength(64);
    expect(failing).toEqual([]);
    // Pin the observation so a change in either direction is visible.
    expect(twoStepRows.map(r => r.permission)).toEqual(
      new Array<StorePermission>(8).fill('undetermined'),
    );
  });

  it('revoke-later: granted+enabled → OS revokes → focus shows denied recovery → restore → focus reactivates', async () => {
    mockScheduler.permission = 'granted';
    setStoreState({
      permission: 'granted',
      enabled: true,
      persistFailed: false,
      scheduleFailed: false,
    });
    const renderer = await render(<NotificationSettingsScreen />);
    const trace: string[] = [];
    expect(textContent(renderer)).toContain(
      'Scheduled from your real practice history',
    );
    trace.push('focus#1 granted → active caption');

    // The player revokes the permission in the Settings app and returns.
    mockScheduler.permission = 'denied';
    await refocus();
    let text = textContent(renderer);
    expect(useNotificationStore.getState().permission).toBe('denied');
    expect(text).toContain('Notifications are off in system settings');
    expect(text).toContain('Paused until notifications are allowed');
    expect(text).not.toContain('Scheduled from your real practice history');
    expect(pressableByLabel(renderer, 'Open system settings')).not.toBeNull();
    trace.push('focus#2 denied → denied card + paused caption');

    // Deep link works: no manual path copy.
    await press(renderer, 'Open system settings');
    expect(mockScheduler.openSettingsCalls).toBe(1);
    expect(textContent(renderer)).not.toContain(
      'Couldn’t open Settings from here',
    );
    trace.push('tap Open system settings → opens (no manual copy)');

    // Deep link fails: manual path copy appears, still no dead end.
    mockScheduler.openSettingsError = new Error('Linking failed');
    await press(renderer, 'Open system settings');
    text = textContent(renderer);
    expect(text).toContain('Couldn’t open Settings from here');
    expect(text).toContain('Settings app →');
    expect(text).toContain('Notifications → Pickle Sensei');
    trace.push('tap Open system settings → throws → manual Settings path copy');

    // Permission restored in Settings; back to the screen.
    mockScheduler.openSettingsError = null;
    mockScheduler.permission = 'granted';
    await refocus();
    text = textContent(renderer);
    expect(useNotificationStore.getState().permission).toBe('granted');
    expect(text).not.toContain('Notifications are off in system settings');
    expect(text).toContain('Scheduled from your real practice history');
    trace.push('focus#3 granted → active again');

    // Focus alone does NOT re-apply the plan (the bootstrap hook does that on
    // AppState active; the screen only re-reads the permission). Recorded,
    // not asserted as a contract — the queue is reconciled on foreground.
    trace.push(`scheduler ops: ${mockScheduler.ops.join(' → ')}`);

    writeArtifact('notification-screen-revoke-later.json', {
      generatedAt: new Date().toISOString(),
      trace,
      schedulerOps: mockScheduler.ops,
      liveAfter: mockScheduler.live.map(n => n.id),
    });
    await unmount(renderer);
  });

  it('denied while OFF: the only offered path is the system settings, and re-allowing brings back "Turn on reminders"', async () => {
    mockScheduler.permission = 'denied';
    setStoreState({
      permission: 'denied',
      enabled: false,
      persistFailed: false,
      scheduleFailed: false,
    });
    const renderer = await render(<NotificationSettingsScreen />);
    expect(pressableByLabel(renderer, 'Turn on reminders')).toBeNull();
    expect(pressableByLabel(renderer, 'Open system settings')).not.toBeNull();
    expect(textContent(renderer)).not.toContain('Stay match-ready.');

    mockScheduler.permission = 'undetermined';
    await refocus();
    expect(pressableByLabel(renderer, 'Turn on reminders')).not.toBeNull();
    expect(pressableByLabel(renderer, 'Open system settings')).toBeNull();

    // Turn on → OS prompt → granted → scheduled.
    mockScheduler.requestResult = 'granted';
    await press(renderer, 'Turn on reminders');
    expect(mockScheduler.requestCalls).toBe(1);
    expect(useNotificationStore.getState().prefs.enabled).toBe(true);
    expect(mockScheduler.live.length).toBeGreaterThan(0);
    expect(textContent(renderer)).toContain(
      'Scheduled from your real practice history',
    );
    await unmount(renderer);
  });

  it('prompt throws → request-failed copy + Open system settings; second attempt succeeds', async () => {
    mockScheduler.permission = 'undetermined';
    setStoreState({
      permission: 'undetermined',
      enabled: false,
      persistFailed: false,
      scheduleFailed: false,
    });
    const renderer = await render(<NotificationSettingsScreen />);
    mockScheduler.requestError = new Error('UNUserNotificationCenter error 1');
    await press(renderer, 'Turn on reminders');
    let text = textContent(renderer);
    expect(useNotificationStore.getState().permission).toBe('unknown');
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
    expect(text).toContain('Reminders weren’t turned on');
    expect(text).toContain('allow notifications in Settings');
    expect(pressableByLabel(renderer, 'Open system settings')).not.toBeNull();
    expect(pressableByLabel(renderer, 'Turn on reminders')).not.toBeNull();

    mockScheduler.openSettingsError = new Error('Linking failed');
    await press(renderer, 'Open system settings');
    expect(textContent(renderer)).toContain('Couldn’t open Settings from here');

    mockScheduler.requestError = null;
    mockScheduler.requestResult = 'granted';
    await press(renderer, 'Turn on reminders');
    text = textContent(renderer);
    expect(mockScheduler.requestCalls).toBe(2);
    expect(useNotificationStore.getState().prefs.enabled).toBe(true);
    expect(text).not.toContain('Reminders weren’t turned on');
    expect(text).toContain('Scheduled from your real practice history');
    await unmount(renderer);
  });

  it('unknown while ON: "Check again" re-reads the permission and re-syncs the queue', async () => {
    mockScheduler.permissionStateError = new Error('center unavailable');
    setStoreState({
      permission: 'unknown',
      enabled: true,
      persistFailed: false,
      scheduleFailed: false,
    });
    const renderer = await render(<NotificationSettingsScreen />);
    expect(textContent(renderer)).toContain(
      'Couldn’t check notification permission',
    );
    expect(textContent(renderer)).toContain(
      'Paused — notification permission couldn’t be checked',
    );
    // Still failing: card stays, nothing scheduled.
    await press(renderer, 'Check again');
    expect(useNotificationStore.getState().permission).toBe('unknown');
    expect(mockScheduler.live).toEqual([]);
    expect(pressableByLabel(renderer, 'Check again')).not.toBeNull();

    // Recovered: card goes, plan applied.
    mockScheduler.permissionStateError = null;
    mockScheduler.permission = 'granted';
    await press(renderer, 'Check again');
    expect(useNotificationStore.getState().permission).toBe('granted');
    expect(mockScheduler.live.length).toBeGreaterThan(0);
    expect(textContent(renderer)).not.toContain(
      'Couldn’t check notification permission',
    );
    expect(textContent(renderer)).toContain(
      'Scheduled from your real practice history',
    );
    await unmount(renderer);
  });

  it('schedule failure surfaces an alert and any setting change retries', async () => {
    mockScheduler.permission = 'granted';
    mockScheduler.applyError = new Error('UNUserNotificationCenter add failed');
    setStoreState({
      permission: 'granted',
      enabled: true,
      persistFailed: false,
      scheduleFailed: false,
    });
    const renderer = await render(<NotificationSettingsScreen />);
    await press(renderer, 'Weekly recap');
    expect(useNotificationStore.getState().scheduleFailed).toBe(true);
    expect(textContent(renderer)).toContain(
      'Reminders couldn’t be scheduled on this phone',
    );
    mockScheduler.applyError = null;
    await press(renderer, 'Weekly recap');
    expect(useNotificationStore.getState().scheduleFailed).toBe(false);
    expect(textContent(renderer)).not.toContain(
      'Reminders couldn’t be scheduled on this phone',
    );
    expect(mockScheduler.live.length).toBeGreaterThan(0);
    await unmount(renderer);
  });
});

describe('xc notification priming card — allow / deny / throw / not now', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockKvTable.clear();
    mockScheduler.reset();
    setActiveDataOwner(owner);
    resetStore();
    setStoreState({
      permission: 'undetermined',
      enabled: false,
      persistFailed: false,
      scheduleFailed: false,
    });
  });

  it('Turn on → OS denies → card disappears without a system prompt loop; Settings keeps the recovery path', async () => {
    mockScheduler.requestResult = 'denied';
    const renderer = await render(<NotificationPrimingCard />);
    expect(
      pressableByLabel(renderer, 'Turn on practice reminders'),
    ).not.toBeNull();
    await press(renderer, 'Turn on practice reminders');
    expect(mockScheduler.requestCalls).toBe(1);
    expect(useNotificationStore.getState().permission).toBe('denied');
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
    // Card is gone: no re-nag. Recovery lives in Settings (denied card).
    expect(renderer.toJSON()).toBeNull();
    await unmount(renderer);

    mockScheduler.permission = 'denied';
    const settings = await render(<NotificationSettingsScreen />);
    expect(textContent(settings)).toContain(
      'Notifications are off in system settings',
    );
    expect(pressableByLabel(settings, 'Open system settings')).not.toBeNull();
    await unmount(settings);
  });

  it('Turn on → prompt throws → "Try again" + Settings copy; retry grants and the card leaves', async () => {
    mockScheduler.requestError = new Error('prompt failed');
    const renderer = await render(<NotificationPrimingCard />);
    await press(renderer, 'Turn on practice reminders');
    const text = textContent(renderer);
    expect(text).toContain('Try again');
    expect(text).toContain('Reminders couldn’t be turned on');
    expect(text).toContain('phone’s Settings');
    for (const rule of BANNED_COPY) expect(text).not.toMatch(rule);
    expect(pressableByLabel(renderer, 'Not now')).not.toBeNull();

    mockScheduler.requestError = null;
    mockScheduler.requestResult = 'granted';
    await press(renderer, 'Turn on practice reminders');
    expect(mockScheduler.requestCalls).toBe(2);
    expect(useNotificationStore.getState().prefs.enabled).toBe(true);
    expect(renderer.toJSON()).toBeNull();
    await unmount(renderer);
  });

  it('Not now → dismissed forever, no system prompt; reminders remain reachable from Settings', async () => {
    const renderer = await render(<NotificationPrimingCard />);
    await press(renderer, 'Not now');
    expect(mockScheduler.requestCalls).toBe(0);
    expect(useNotificationStore.getState().prefs.promptDismissed).toBe(true);
    expect(renderer.toJSON()).toBeNull();
    await unmount(renderer);

    const again = await render(<NotificationPrimingCard />);
    expect(again.toJSON()).toBeNull();
    await unmount(again);

    const settings = await render(<NotificationSettingsScreen />);
    expect(pressableByLabel(settings, 'Turn on reminders')).not.toBeNull();
    await unmount(settings);
  });

  it('provisional/limited authorization (native status 2) is treated as granted end to end', async () => {
    // service.toPermissionState maps every nonzero authorizationStatus to
    // 'granted' (INFERRED from src/notifications/service.ts); the store and
    // UI therefore see provisional exactly like full authorization.
    const { getScheduler } = jest.requireActual<
      typeof import('../src/notifications/service')
    >('../src/notifications/service');
    // Same registry instance the service's lazy `require` resolves to (the
    // jest.requireMock copy is a different object — verified empirically).
    const notifyKit = (
      require('react-native-notify-kit') as {
        default: {
          getNotificationSettings: jest.Mock;
          requestPermission: jest.Mock;
        };
      }
    ).default;
    const { Linking } =
      jest.requireActual<typeof import('react-native')>('react-native');
    const openSettings = jest
      .spyOn(Linking, 'openSettings')
      .mockResolvedValue(undefined);
    const scheduler = getScheduler();
    const statuses: Array<{
      status: number;
      viaSettings: PermissionState;
      viaRequest: PermissionState;
    }> = [];
    for (const status of [-1, 0, 1, 2, 3, 4]) {
      notifyKit.getNotificationSettings.mockResolvedValueOnce({
        authorizationStatus: status,
      });
      notifyKit.requestPermission.mockResolvedValueOnce({
        authorizationStatus: status,
      });
      statuses.push({
        status,
        viaSettings: await scheduler.permissionState(),
        viaRequest: await scheduler.requestPermission(),
      });
    }
    await scheduler.openSystemSettings();
    expect(openSettings).toHaveBeenCalledTimes(1);
    openSettings.mockRestore();
    writeArtifact('notification-authorization-status-mapping.json', {
      generatedAt: new Date().toISOString(),
      note: 'mapped through the real NotifeeScheduler (getScheduler) against the jest react-native-notify-kit mock; iOS openSystemSettings → Linking.openSettings',
      statuses,
    });
    const mapped = (status: number) => statuses.find(s => s.status === status)!;
    expect(mapped(-1)).toMatchObject({
      viaSettings: 'undetermined',
      viaRequest: 'undetermined',
    });
    expect(mapped(0)).toMatchObject({
      viaSettings: 'denied',
      viaRequest: 'denied',
    });
    expect(mapped(1)).toMatchObject({
      viaSettings: 'granted',
      viaRequest: 'granted',
    });
    expect(mapped(2)).toMatchObject({
      viaSettings: 'granted',
      viaRequest: 'granted',
    });
    // Any unknown future nonzero status is also read as granted (recorded).
    expect(mapped(3).viaSettings).toBe('granted');
    expect(mapped(4).viaSettings).toBe('granted');

    // End to end through the store + UI: provisional behaves like granted.
    mockScheduler.requestResult = 'granted';
    const renderer = await render(<NotificationSettingsScreen />);
    await press(renderer, 'Turn on reminders');
    expect(useNotificationStore.getState().prefs.enabled).toBe(true);
    expect(mockScheduler.live.length).toBeGreaterThan(0);
    await unmount(renderer);
  });
});
