/**
 * Full-App-tree harness for the first-launch journey.
 *
 * Renders the REAL `App.tsx` with the REAL zustand stores (auth, app,
 * notification, consistency, walkthrough) and the real Welcome / Onboarding /
 * SignIn / Splash screens. Only the native edges are replaced:
 *
 *   - `src/data/db` → an in-memory kv-backed LocalDb that records every SQL
 *     statement (`db.ledger`) and supports fault injection / deferred writes
 *     for a named kv key, so persistence failures are reproducible.
 *   - react-native-keychain / react-native-notify-kit / react-native-video →
 *     the repo's existing `__mocks__` (auto-applied).
 *   - `globalThis.fetch` → a recording stub that REJECTS every call; the
 *     pre-auth journey must never reach the network, and the ledger proves it.
 *   - safe-area-context → zero insets; RootNavigator → a marker view (the
 *     journey under test ends at SignIn; the signed-in app is out of scope).
 *
 * This module must be imported BEFORE `App` (module mocks register on
 * import). The test files import it first.
 */
import React from 'react';
import { AppState, Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { LocalDb } from '../../src/data/db';
import {
  JourneyLog,
  accessibleStrings,
  pressableRecords,
  pressables,
  screenDump,
  visibleText,
  type JourneyStep,
} from './journeyEvidence';

jest.mock('react-native-safe-area-context', () => {
  const ReactActual = require('react');
  const { View: RNView } = require('react-native');
  const passthrough = (props: { children?: React.ReactNode }) =>
    ReactActual.createElement(RNView, null, props.children);
  return {
    SafeAreaProvider: passthrough,
    SafeAreaView: passthrough,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: {
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 0, bottom: 0, left: 0, right: 0 },
    },
  };
});

jest.mock('../../src/navigation/RootNavigator', () => {
  const ReactActual = require('react');
  const { View: RNView } = require('react-native');
  return {
    __esModule: true,
    RootNavigator: () =>
      ReactActual.createElement(RNView, { testID: 'RootNavigator' }),
  };
});

// ─── Fake device database ───────────────────────────────────────────────────

export interface DbStatement {
  sql: string;
  params: unknown[];
}

type Deferred = { resolve: () => void; reject: (error: Error) => void };

const mockDbState = {
  kv: new Map<string, string>(),
  ledger: [] as DbStatement[],
  /** kv keys whose next write rejects (consumed per write unless sticky). */
  failWriteKeys: new Map<string, { sticky: boolean; message: string }>(),
  /** kv keys whose writes park until `releaseWrite(key)` is called. */
  deferWriteKeys: new Set<string>(),
  pendingWrites: new Map<string, Deferred[]>(),
};

function mockFakeDb(): LocalDb {
  return {
    async execute(sql: string, params: unknown[] = []) {
      const statement = sql.trim().replace(/\s+/g, ' ');
      mockDbState.ledger.push({ sql: statement, params });
      if (statement.startsWith('SELECT value FROM kv')) {
        const value = mockDbState.kv.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
        const key = String(params[0]);
        const fault = mockDbState.failWriteKeys.get(key);
        if (fault) {
          if (!fault.sticky) mockDbState.failWriteKeys.delete(key);
          throw new Error(fault.message);
        }
        if (mockDbState.deferWriteKeys.has(key)) {
          await new Promise<void>((resolve, reject) => {
            const queue = mockDbState.pendingWrites.get(key) ?? [];
            queue.push({ resolve, reject });
            mockDbState.pendingWrites.set(key, queue);
          });
        }
        mockDbState.kv.set(key, String(params[1]));
        return { rows: [] };
      }
      if (statement.startsWith('DELETE FROM kv')) {
        mockDbState.kv.delete(String(params[0]));
        return { rows: [] };
      }
      // Any other table (shots, outbox, sessions…) is empty on a fresh device.
      return { rows: [] };
    },
    close() {},
  };
}

jest.mock('../../src/data/db', () => ({ getDb: () => mockFakeDb() }));

export const db = {
  get kv(): Map<string, string> {
    return mockDbState.kv;
  },
  get ledger(): DbStatement[] {
    return mockDbState.ledger;
  },
  kvSnapshot(): Record<string, string> {
    return Object.fromEntries(
      [...mockDbState.kv.entries()].sort(([a], [b]) => a.localeCompare(b)),
    );
  },
  writes(): DbStatement[] {
    return mockDbState.ledger.filter(s =>
      /^(INSERT|UPDATE|DELETE)/i.test(s.sql),
    );
  },
  failNextWrite(key: string, message = 'disk I/O error (injected)'): void {
    mockDbState.failWriteKeys.set(key, { sticky: false, message });
  },
  failWrites(key: string, message = 'disk I/O error (injected)'): void {
    mockDbState.failWriteKeys.set(key, { sticky: true, message });
  },
  clearFaults(): void {
    mockDbState.failWriteKeys.clear();
  },
  deferWrites(key: string): void {
    mockDbState.deferWriteKeys.add(key);
  },
  releaseWrites(key: string): void {
    mockDbState.deferWriteKeys.delete(key);
    const queue = mockDbState.pendingWrites.get(key) ?? [];
    mockDbState.pendingWrites.delete(key);
    for (const d of queue) d.resolve();
  },
  pendingWriteCount(key: string): number {
    return mockDbState.pendingWrites.get(key)?.length ?? 0;
  },
  reset(): void {
    mockDbState.kv.clear();
    mockDbState.ledger.length = 0;
    mockDbState.failWriteKeys.clear();
    mockDbState.deferWriteKeys.clear();
    for (const queue of mockDbState.pendingWrites.values()) {
      for (const d of queue) d.reject(new Error('harness reset'));
    }
    mockDbState.pendingWrites.clear();
  },
};

// ─── Network guard ──────────────────────────────────────────────────────────

export const fetchCalls: { url: string; init: unknown }[] = [];
const guardedFetch = jest.fn(async (input: unknown, init?: unknown) => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : String((input as { url?: string })?.url ?? input);
  fetchCalls.push({ url, init });
  throw new Error(`network forbidden in journey harness: ${url}`);
});
globalThis.fetch = guardedFetch as unknown as typeof fetch;

// ─── Real modules (imported after the mocks above are registered) ───────────

import App from '../../App';
import { useAppStore } from '../../src/state/appStore';
import { useAuthStore } from '../../src/auth/authStore';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import { useConsistencyStore } from '../../src/consistency/store';
import { DEFAULT_NOTIFICATION_PREFS } from '../../src/notifications/types';
import {
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { EXIT_MS } from '../../src/screens/SplashScreen';
import * as Keychain from 'react-native-keychain';
import notifee from 'react-native-notify-kit';

export const keychain = (
  Keychain as unknown as { __keychainStore: Map<string, unknown> }
).__keychainStore;
export const notifeeMock = notifee as unknown as {
  requestPermission: jest.Mock;
  getNotificationSettings: jest.Mock;
  createTriggerNotification: jest.Mock;
  cancelTriggerNotification: jest.Mock;
  getTriggerNotificationIds: jest.Mock;
};

export { SIGNED_OUT_DATA_OWNER, getActiveDataOwner };

export type Renderer = TestRenderer.ReactTestRenderer;

const mounted: Renderer[] = [];

// ─── Domain constants ───────────────────────────────────────────────────────

export const STEP_ORDER = [
  'name',
  'gender',
  'level',
  'handedness',
  'goal',
  'problem',
  'reveal',
  'notifications',
] as const;
export type StepName = (typeof STEP_ORDER)[number];

export const STEP_TITLES: Record<StepName, string> = {
  name: 'What should we call you?',
  gender: 'How do you identify?',
  level: 'Where is your game today?',
  handedness: 'Which side is home?',
  goal: 'What do you want to own?',
  problem: 'What breaks down most?',
  reveal: 'One focus.',
  notifications: 'Stay match-ready.',
};

export const CHOICES: Record<
  'gender' | 'level' | 'handedness' | 'goal' | 'problem',
  { label: string; value: string }[]
> = {
  gender: [
    { label: 'Female', value: 'female' },
    { label: 'Male', value: 'male' },
    { label: 'Non-binary', value: 'nonbinary' },
    { label: 'Prefer not to say', value: 'prefer_not_to_say' },
  ],
  level: [
    { label: 'Brand new', value: 'Beginner' },
    { label: '2.5', value: '2.5' },
    { label: '3.0', value: '3.0' },
    { label: '3.5', value: '3.5' },
    { label: '4.0', value: '4.0' },
    { label: '4.5', value: '4.5' },
    { label: '5.0+', value: '5.0+' },
  ],
  handedness: [
    { label: 'Right-handed', value: 'right' },
    { label: 'Left-handed', value: 'left' },
  ],
  goal: [
    { label: 'Dinks', value: 'dinks' },
    { label: 'Drives', value: 'drives' },
    { label: 'Third-shot drops', value: 'drops' },
    { label: 'Serve', value: 'serve' },
    { label: 'Volleys', value: 'volleys' },
    { label: 'Footwork', value: 'footwork' },
    { label: 'All-around', value: 'all-around' },
  ],
  problem: [
    { label: 'Consistency', value: 'consistency' },
    { label: 'Control', value: 'control' },
    { label: 'Power', value: 'power' },
    { label: 'Contact', value: 'contact' },
    { label: 'Footwork', value: 'footwork' },
    { label: 'Placement', value: 'placement' },
    { label: 'Not sure', value: 'not sure' },
  ],
};

export const WELCOME_TEXT = 'See the stroke.';
export const SIGNIN_TEXT = 'Your ratings,';
export const LOADING_TEXT = 'Getting things ready';
export const PENDING_PROFILE_KEY = 'onboarding.pending-profile';
export const PENDING_NOTIFICATIONS_KEY = 'onboarding.pending-notifications';

export type Stage =
  | 'loading'
  | 'welcome'
  | `onboarding:${StepName}`
  | 'signin'
  | 'app'
  | 'unknown';

// ─── Runtime reset ──────────────────────────────────────────────────────────

export function resetRuntime(): void {
  while (mounted.length > 0) unmount(mounted[mounted.length - 1]!);
  db.reset();
  fetchCalls.length = 0;
  guardedFetch.mockClear();
  keychain.clear();
  notifeeMock.requestPermission.mockReset();
  notifeeMock.requestPermission.mockImplementation(async () => ({
    authorizationStatus: 1,
  }));
  notifeeMock.getNotificationSettings.mockReset();
  notifeeMock.getNotificationSettings.mockImplementation(async () => ({
    authorizationStatus: -1,
  }));
  notifeeMock.createTriggerNotification.mockClear();
  notifeeMock.cancelTriggerNotification.mockClear();
  notifeeMock.getTriggerNotificationIds.mockClear();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    hydrated: false,
    session: null,
    busy: false,
    error: null,
    deletionCleanup: null,
  });
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
    onboardingBusy: false,
    onboardingError: null,
    lastShotType: 'forehand_drive',
  });
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
    persistFailed: false,
    scheduleFailed: false,
  });
  useConsistencyStore.setState({ hydrated: false } as never);
  (AppState.addEventListener as jest.Mock).mockClear();
}

// ─── Rendering / flushing ───────────────────────────────────────────────────

/** Flush pending promises and any due timers a few rounds deep. */
export async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      jest.advanceTimersByTime(1);
      await Promise.resolve();
    });
  }
}

export async function mountApp(): Promise<Renderer> {
  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(<App />);
  });
  mounted.push(renderer);
  await settle();
  return renderer;
}

export function unmount(renderer: Renderer): void {
  const index = mounted.indexOf(renderer);
  if (index >= 0) mounted.splice(index, 1);
  act(() => renderer.unmount());
}

function hostNodes(renderer: Renderer, testID: string) {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && node.props.testID === testID,
  );
}

export function splashVisible(renderer: Renderer): boolean {
  return hostNodes(renderer, 'splash-screen').length > 0;
}

/** Lets the intro video end and the overlay cross-fade out. */
export async function finishSplash(renderer: Renderer): Promise<void> {
  const [video] = hostNodes(renderer, 'splash-video');
  if (!video) throw new Error('splash video not mounted');
  await act(async () => {
    video.props.onEnd();
  });
  await act(async () => {
    jest.advanceTimersByTime(EXIT_MS + 50);
  });
  await settle(2);
}

/** Cold launch: mount, wait for hydration, let the splash finish. */
export async function launchToFirstScreen(): Promise<Renderer> {
  const renderer = await mountApp();
  await finishSplash(renderer);
  return renderer;
}

// ─── Reading the screen ─────────────────────────────────────────────────────

export function allText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join('');
}

export function stageOf(renderer: Renderer): Stage {
  if (hostNodes(renderer, 'RootNavigator').length > 0) return 'app';
  const text = allText(renderer);
  if (text.includes(SIGNIN_TEXT)) return 'signin';
  if (text.includes(WELCOME_TEXT)) return 'welcome';
  for (const step of STEP_ORDER) {
    if (text.includes(STEP_TITLES[step])) return `onboarding:${step}`;
  }
  if (text.includes(LOADING_TEXT)) return 'loading';
  return 'unknown';
}

export function progressValue(
  renderer: Renderer,
): { now: number; max: number } | null {
  const bars = renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      node.props.accessibilityRole === 'progressbar' &&
      typeof node.props.accessibilityLabel === 'string' &&
      node.props.accessibilityLabel.startsWith('Onboarding step'),
  );
  if (bars.length === 0) return null;
  const value = bars[0]!.props.accessibilityValue as {
    now: number;
    max: number;
  };
  return { now: value.now, max: value.max };
}

export function pressableLabels(renderer: Renderer): string[] {
  return pressableRecords(renderer)
    .map(p => p.label)
    .sort();
}

export function findPressable(renderer: Renderer, label: string) {
  const matches = pressables(renderer).filter(
    node => node.props.accessibilityLabel === label,
  );
  if (matches.length === 0) {
    throw new Error(
      `No pressable labeled "${label}". Present: ${pressableLabels(renderer).join(', ')}`,
    );
  }
  if (matches.length > 1) {
    throw new Error(`${matches.length} pressables labeled "${label}"`);
  }
  return matches[0]!;
}

export function hasPressable(renderer: Renderer, label: string): boolean {
  return pressables(renderer).some(
    node => node.props.accessibilityLabel === label,
  );
}

export function isDisabled(renderer: Renderer, label: string): boolean {
  const node = findPressable(renderer, label);
  return Boolean(
    node.props.disabled ?? node.props.accessibilityState?.disabled,
  );
}

/** Presses like a user: the control must exist, be enabled and be a control. */
export async function press(renderer: Renderer, label: string): Promise<void> {
  const node = findPressable(renderer, label);
  if (node.props.disabled ?? node.props.accessibilityState?.disabled) {
    throw new Error(`"${label}" is disabled`);
  }
  if (!['button', 'radio', 'link'].includes(node.props.accessibilityRole)) {
    throw new Error(
      `"${label}" has accessibilityRole ${String(node.props.accessibilityRole)}`,
    );
  }
  await act(async () => {
    node.props.onPress();
  });
  await settle(3);
}

export async function typeName(
  renderer: Renderer,
  text: string,
): Promise<void> {
  const inputs = renderer.root.findAllByType(TextInput);
  if (inputs.length !== 1) {
    throw new Error(`expected one TextInput, found ${inputs.length}`);
  }
  await act(async () => {
    inputs[0]!.props.onChangeText(text);
  });
  await settle(1);
}

export function nameInput(
  renderer: Renderer,
): { value: string; placeholder: string | null } | null {
  const inputs = renderer.root.findAllByType(TextInput);
  if (inputs.length === 0) return null;
  const props = inputs[0]!.props;
  return {
    value: typeof props.value === 'string' ? props.value : '',
    placeholder:
      typeof props.placeholder === 'string' ? props.placeholder : null,
  };
}

export async function appStateChange(
  next: 'active' | 'background' | 'inactive',
): Promise<void> {
  const calls = (AppState.addEventListener as jest.Mock).mock.calls as [
    string,
    (state: string) => void,
  ][];
  await act(async () => {
    for (const [event, handler] of calls) {
      if (event === 'change') handler(next);
    }
  });
  await settle(3);
}

// ─── Evidence capture ───────────────────────────────────────────────────────

export function storeSnapshot(): Record<string, unknown> {
  const auth = useAuthStore.getState();
  const app = useAppStore.getState();
  const notif = useNotificationStore.getState();
  return {
    activeDataOwner: getActiveDataOwner(),
    auth: {
      hydrated: auth.hydrated,
      session: auth.session,
      busy: auth.busy,
      error: auth.error,
    },
    app: {
      hydrated: app.hydrated,
      ownerKey: app.ownerKey,
      profile: app.profile,
      hydrateError: app.hydrateError,
      onboardingBusy: app.onboardingBusy,
      onboardingError: app.onboardingError,
    },
    notifications: {
      hydrated: notif.hydrated,
      ownerKey: notif.ownerKey,
      permission: notif.permission,
      prefs: notif.prefs,
    },
    keychainEntries: keychain.size,
  };
}

export function counters(): Record<string, number> {
  return {
    fetchCalls: fetchCalls.length,
    osPermissionPrompts: notifeeMock.requestPermission.mock.calls.length,
    kvWrites: db.writes().length,
    dbStatements: db.ledger.length,
    pendingTimers: jest.getTimerCount(),
  };
}

export function capture(
  log: JourneyLog,
  renderer: Renderer,
  action: string,
): JourneyStep {
  const tree = renderer.toJSON();
  return log.record(
    {
      action,
      stage: stageOf(renderer),
      progress: progressValue(renderer),
      pressables: pressableRecords(renderer),
      textInput: nameInput(renderer),
      kv: db.kvSnapshot(),
      stores: storeSnapshot(),
      counters: counters(),
      screen: screenDump(tree),
    },
    tree,
  );
}

/** Every user-visible string plus accessible labels/hints/placeholders. */
export function surfaceStrings(renderer: Renderer): string[] {
  const tree = renderer.toJSON();
  return [
    ...visibleText(tree)
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean),
    ...accessibleStrings(tree),
  ];
}

// ─── Invariants shared by every scenario ────────────────────────────────────

/** Labels that may appear on each pre-auth stage. Anything else is a finding. */
export function allowedPressables(stage: Stage): string[] | null {
  switch (stage) {
    case 'welcome':
      return ['I already have an account', 'Start your first read'];
    case 'signin':
      return [
        'Back',
        'Continue with Apple',
        'Continue with Google',
        'Dismiss sign-in error',
      ];
    case 'onboarding:name':
    case 'onboarding:reveal':
      return ['Back', 'Continue'];
    case 'onboarding:gender':
    case 'onboarding:level':
    case 'onboarding:handedness':
    case 'onboarding:goal':
    case 'onboarding:problem': {
      const step = stage.slice('onboarding:'.length) as keyof typeof CHOICES;
      return ['Back', 'Continue', ...CHOICES[step].map(c => c.label)];
    }
    case 'onboarding:notifications':
      return ['Back', 'Finishing setup…', 'Not now', 'Turn on reminders'];
    default:
      return null;
  }
}

/**
 * Strings the user typed themselves (their first name) are echoed by the
 * reveal step and must not count as app copy.
 */
export function surfaceStringsExcludingEcho(
  renderer: Renderer,
  userEcho: string,
): string[] {
  const echo = userEcho.trim();
  return surfaceStrings(renderer).map(s => (echo ? s.split(echo).join('') : s));
}

export function assertNoSkipAffordance(
  renderer: Renderer,
  userEcho = '',
): void {
  const strings = surfaceStringsExcludingEcho(renderer, userEcho);
  const skipHits = strings.filter(s => /skip/i.test(s));
  expect(skipHits).toEqual([]);
  // Controls are checked on their raw labels: a control may never be a skip
  // whatever the user typed.
  const controlHits = pressableRecords(renderer).filter(
    p => /skip|leave setup/i.test(p.label) || /skip/i.test(p.hint ?? ''),
  );
  expect(controlHits).toEqual([]);
  expect(hostNodes(renderer, 'onboarding-leave-dialog')).toHaveLength(0);
}

export function assertStageControls(renderer: Renderer, userEcho = ''): Stage {
  const stage = stageOf(renderer);
  const allowed = allowedPressables(stage);
  if (allowed) {
    const labels = pressableLabels(renderer);
    const unexpected = labels.filter(l => !allowed.includes(l));
    expect(unexpected).toEqual([]);
  }
  assertNoSkipAffordance(renderer, userEcho);
  return stage;
}
