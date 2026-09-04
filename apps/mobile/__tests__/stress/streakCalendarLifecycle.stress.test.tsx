/**
 * STRESS · scr-streakcalendarscreen · lens `lifecycle`
 *
 * StreakCalendarScreen rendered through the REAL RootNavigator (native stack
 * + bottom tabs + NavigationContainer), the real consistency/app stores, the
 * real `useConsistencyBootstrap` and the App.tsx owner gate (see
 * xc-harness/stress/streakCalendarLifecycle/Host.tsx), driven by a seeded
 * schedule of lifecycle interruptions:
 *
 *   background/foreground · unmount (Back) mid-refresh · kill + cold
 *   relaunch (in-flight statements orphaned, every in-memory store reset,
 *   re-hydrate from the fake SQLite) ·
 *   account switch / sign-out mid-refresh · token rotation mid-refresh ·
 *   storage revoked-later · concurrent store writes · double hydrate ·
 *   month/day taps · clock past midnight · assorted waits.
 *
 * Only native/storage boundaries are mocked: SQLite (latency + fault +
 * kill-orphaning double), safe-area, linear-gradient, svg, the auth store
 * (a plain zustand store — the harness plays the vault), notifications, and
 * the screens RootNavigator merely registers.
 *
 * Every iteration is replayable from its seed:
 *   STRESS_SEED=<n>  npx jest --ci __tests__/stress/streakCalendarLifecycle
 * Campaign size: STRESS_ITER (default 24; campaigns run >= 100) from
 * STRESS_SEED_BASE (default 1000). Artifacts (JSON row table + summary)
 * land in <repo>/artifacts/stress/scr-streakcalendarscreen-lifecycle/
 * (override with STRESS_ARTIFACT_DIR).
 */
import type { StressLocalDb } from '../../xc-harness/stress/streakCalendarLifecycle/fakeDb';

const mockWorld: { db: StressLocalDb | null } = { db: null };

jest.mock('../../src/data/db', () => ({
  __esModule: true,
  getDb: () => {
    if (!mockWorld.db) throw new Error('stress: no db installed');
    return mockWorld.db;
  },
  closeDb: () => undefined,
}));
jest.mock('react-native-safe-area-context', () => {
  const mock = require('react-native-safe-area-context/jest/mock');
  return mock.default ?? mock;
});
jest.mock('react-native-linear-gradient', () => {
  const React = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});
jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  // Every named export (Circle, Polygon, RadialGradient, …) renders as a
  // plain View so no screen in the real navigator trips on a missing shape.
  return new Proxy(
    { __esModule: true, default: Mock },
    {
      get: (target, prop) =>
        prop in target ? target[prop as keyof typeof target] : Mock,
    },
  );
});
jest.mock('../../src/auth/authStore', () => {
  const { create } = require('zustand');
  const useAuthStore = create(() => ({
    hydrated: true,
    session: null,
    busy: false,
    error: null,
    signInWithApple: jest.fn(async () => undefined),
    signInWithGoogle: jest.fn(async () => undefined),
    clearError: jest.fn(),
  }));
  return { __esModule: true, useAuthStore };
});
const mockNotificationSubscriptions = { live: 0 };
jest.mock('../../src/notifications/service', () => ({
  __esModule: true,
  subscribeToNotificationPresses: () => {
    mockNotificationSubscriptions.live += 1;
    return () => {
      mockNotificationSubscriptions.live -= 1;
    };
  },
}));
jest.mock('../../src/screens/HomeScreen', () => {
  const React = require('react');
  const { Pressable, Text } = require('react-native');
  const { useNavigation } = require('@react-navigation/native');
  const HomeScreen = () => {
    const navigation = useNavigation();
    return React.createElement(
      Pressable,
      {
        accessibilityLabel: 'Open streak calendar',
        testID: 'stress-home',
        onPress: () => navigation.navigate('StreakCalendar'),
      },
      React.createElement(Text, null, 'Home stub'),
    );
  };
  return { HomeScreen };
});
// Screens RootNavigator only registers (never reached by this lens) are
// stubbed so their native/data imports stay out of the process graph.
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
jest.mock('../../src/screens/NotificationSettingsScreen', () => ({
  NotificationSettingsScreen: () => null,
}));

import React from 'react';
import { AppState, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import { StressApp } from '../../xc-harness/stress/streakCalendarLifecycle/Host';
import { useConsistencyStore } from '../../src/consistency/store';
import { useAppStore } from '../../src/state/appStore';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { useAuthStore } from '../../src/auth/authStore';
import type { ConsistencySnapshot } from '../../src/consistency/engine';
import { buildConsistencySnapshot } from '../../src/consistency/engine';
import type { TrainingActivityInput } from '../../src/consistency/engine';
import { StressLocalDb as StressLocalDbImpl } from '../../xc-harness/stress/streakCalendarLifecycle/fakeDb';
import {
  LAUNCH_INSTANT,
  OWNER_IDS,
  PROFILE_JSON,
  type HarnessSession,
  type OwnerTag,
  sessionFor,
  shotRowsFor,
} from '../../xc-harness/stress/streakCalendarLifecycle/fixtures';
import {
  describeStep,
  generateScenario,
  minimizeSteps,
  type Scenario,
  type Step,
} from '../../xc-harness/stress/streakCalendarLifecycle/schedule';
import {
  fs,
  nodeProcess,
  path,
} from '../../xc-harness/lifecycle-persistence/nodeShim';

declare const __dirname: string;

// ---------------------------------------------------------------------------
// Process model. A cold launch (`boot`) resets every in-memory singleton a
// killed process would lose — the consistency and app zustand stores, the
// active data owner, the auth session (the harness plays the Keychain vault
// and re-installs it, exactly as authStore.hydrate() does) and the AppState
// listener table. Persisted state (the fake SQLite) survives.
//
// A fresh module registry per relaunch is NOT used on purpose: the RN Jest
// preset's component mocks are bound to the root registry's React, so an
// isolated registry renders with two Reacts and every hook throws.
// ---------------------------------------------------------------------------
const appStateListeners = new Set<(state: string) => void>();
(AppState.addEventListener as unknown as jest.Mock).mockImplementation(
  (_type: string, handler: (state: string) => void) => {
    appStateListeners.add(handler);
    return { remove: () => appStateListeners.delete(handler) };
  },
);

type AuthStoreLike = {
  getState: () => { session: HarnessSession | null };
  setState: (partial: { session: HarnessSession | null }) => void;
};
const authStore = useAuthStore as unknown as AuthStoreLike;

interface Proc {
  renderer: TestRenderer.ReactTestRenderer | null;
  caught: unknown[];
  celebrations: { owner: string | null; id: string }[];
  unsubscribe: () => void;
}

function boot(): Proc {
  useConsistencyStore.setState(useConsistencyStore.getInitialState(), true);
  useAppStore.setState(useAppStore.getInitialState(), true);
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  authStore.setState({ session: null });
  appStateListeners.clear();
  const celebrations: Proc['celebrations'] = [];
  let lastCelebration: string | null = null;
  const unsubscribe = useConsistencyStore.subscribe(state => {
    const id = state.celebration?.achievementId ?? null;
    if (id && id !== lastCelebration) {
      celebrations.push({ owner: state.ownerKey, id });
    }
    lastCelebration = id;
  });
  return { renderer: null, caught: [], celebrations, unsubscribe };
}

async function mount(proc: Proc): Promise<void> {
  await act(async () => {
    proc.renderer = TestRenderer.create(
      <StressApp hooks={{ onCaught: error => proc.caught.push(error) }} />,
    );
  });
}

// ---------------------------------------------------------------------------
// Owner / expected-state model.
// ---------------------------------------------------------------------------
type WritableOwner = Exclude<OwnerTag, 'signed-out'>;

function ownerKeyFor(owner: OwnerTag): string {
  if (owner === 'signed-out') return SIGNED_OUT_DATA_OWNER;
  if (owner === 'guest') return GUEST_DATA_OWNER;
  return canonicalDataOwner(OWNER_IDS[owner]);
}

function tagForOwnerKey(key: string | null): OwnerTag | null {
  if (key === null) return null;
  for (const tag of ['alpha', 'bravo', 'guest', 'signed-out'] as const) {
    if (ownerKeyFor(tag) === key) return tag;
  }
  return null;
}

interface LedgerShape {
  drills?: {
    id: string;
    slug: string;
    title: string;
    completedAtIso: string;
  }[];
}

function ledgerDrills(
  db: StressLocalDb,
  ownerKey: string,
): LedgerShape['drills'] {
  const raw = db.kv.get(`consistency:${ownerKey}`);
  if (!raw) return [];
  try {
    return (JSON.parse(raw) as LedgerShape).drills ?? [];
  } catch {
    return [];
  }
}

function expectedActivities(
  db: StressLocalDb,
  owner: WritableOwner,
): TrainingActivityInput[] {
  const key = ownerKeyFor(owner);
  const shots = db.shots.get(key) ?? [];
  const activities: TrainingActivityInput[] = shots.map(s => ({
    kind: 'stroke' as const,
    atIso: s.capturedAt,
    shotType: s.shotType,
    overallScore: s.overallScore,
    resultKind: s.resultKind,
  }));
  for (const drill of ledgerDrills(db, key) ?? []) {
    activities.push({
      kind: 'drill',
      atIso: drill.completedAtIso,
      label: drill.title || drill.slug,
    });
  }
  return activities;
}

function expectedSnapshot(
  db: StressLocalDb,
  owner: WritableOwner,
): ConsistencySnapshot {
  return buildConsistencySnapshot(expectedActivities(db, owner), {
    asOfIso: new Date().toISOString(),
    timeZone: 'UTC',
  });
}

function trainedDays(snapshot: ConsistencySnapshot): string[] {
  return Object.entries(snapshot.days)
    .filter(([, day]) => !day.shielded)
    .map(([key]) => key)
    .sort();
}

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Which device account a snapshot belongs to. Fixture histories are
 * disjoint enough that shotDays(X) ⊆ trained(snapshot) ⊆ shotDays(X) ∪
 * drillDays(X) holds for at most one X, regardless of when the snapshot was
 * computed (drills are only ever recorded "today", never on another
 * account's past training day).
 */
function attribute(
  db: StressLocalDb,
  snapshot: ConsistencySnapshot,
): WritableOwner | 'unknown' {
  const trained = new Set(trainedDays(snapshot));
  const matches: WritableOwner[] = [];
  for (const owner of ['alpha', 'bravo', 'guest'] as const) {
    const key = ownerKeyFor(owner);
    const shotDays = new Set(
      (db.shots.get(key) ?? []).map(s => dayOf(s.capturedAt)),
    );
    const drillDays = new Set(
      (ledgerDrills(db, key) ?? []).map(d => dayOf(d.completedAtIso)),
    );
    if (![...shotDays].every(d => trained.has(d))) continue;
    if (![...trained].every(d => shotDays.has(d) || drillDays.has(d))) continue;
    matches.push(owner);
  }
  const [only] = matches;
  return matches.length === 1 && only ? only : 'unknown';
}

// ---------------------------------------------------------------------------
// Rendered-tree readers (react-test-renderer instance tree).
// ---------------------------------------------------------------------------
function textOf(node: ReactTestInstance): string {
  const parts: string[] = [];
  const walk = (child: unknown): void => {
    if (child === null || child === undefined || typeof child === 'boolean') {
      return;
    }
    if (typeof child === 'string' || typeof child === 'number') {
      parts.push(String(child));
      return;
    }
    if (Array.isArray(child)) {
      child.forEach(walk);
      return;
    }
    if (typeof child === 'object' && 'props' in (child as object)) {
      walk((child as { props: { children?: unknown } }).props.children);
    }
  };
  walk(node.props.children);
  return parts.join('');
}

interface ScreenView {
  navigatorMounted: boolean;
  calendarMounted: boolean;
  heroStreak: number | null;
  heroDaysTrained: number | null;
  errorCard: boolean;
  welcome: boolean;
  loading: boolean;
}

function readScreen(proc: Proc): ScreenView {
  const renderer = proc.renderer;
  if (!renderer) {
    return {
      navigatorMounted: false,
      calendarMounted: false,
      heroStreak: null,
      heroDaysTrained: null,
      errorCard: false,
      welcome: false,
      loading: false,
    };
  }
  const root = renderer.root;
  const byTestId = (id: string) =>
    root.findAll(n => n.props.testID === id && typeof n.type === 'string');
  const hero = byTestId('streak-hero')[0];
  const error = byTestId('streak-load-error').length > 0;
  let heroStreak: number | null = null;
  let heroDaysTrained: number | null = null;
  if (hero) {
    const texts = hero
      .findAllByType(Text)
      .map(textOf)
      .filter(t => t.length > 0);
    // Hero layout: [streak, 'DAY STREAK', ..., longest, 'LONGEST', trained,
    // 'DAYS TRAINED', ...] — read the value that precedes each label.
    const streakIdx = texts.indexOf('DAY STREAK');
    const trainedIdx = texts.indexOf('DAYS TRAINED');
    if (streakIdx > 0) heroStreak = Number(texts[streakIdx - 1]);
    if (trainedIdx > 0) heroDaysTrained = Number(texts[trainedIdx - 1]);
  }
  return {
    navigatorMounted:
      byTestId('stress-home').length > 0 || Boolean(hero) || error,
    calendarMounted: Boolean(hero) || error,
    heroStreak,
    heroDaysTrained,
    errorCard: error,
    welcome: byTestId('stress-welcome').length > 0,
    loading:
      root.findAll(n => n.props.accessibilityRole === 'progressbar').length > 0,
  };
}

function findPressable(
  proc: Proc,
  match: (label: string) => boolean,
): ReactTestInstance | null {
  if (!proc.renderer) return null;
  // Composite nodes included: Pressable keeps `onPress` on the element and
  // turns it into responder handlers on the host View.
  const nodes = proc.renderer.root.findAll(
    n =>
      typeof n.props.accessibilityLabel === 'string' &&
      match(n.props.accessibilityLabel) &&
      typeof n.props.onPress === 'function' &&
      !n.props.disabled &&
      !(n.props.accessibilityState && n.props.accessibilityState.disabled),
  );
  return nodes[0] ?? null;
}

// ---------------------------------------------------------------------------
// Scenario runner.
// ---------------------------------------------------------------------------
interface Violation {
  invariant: string;
  stepIndex: number;
  step: string;
  detail: string;
}

interface Row {
  seed: number;
  latencyMs: number;
  initialOwner: WritableOwner;
  steps: string[];
  executedSteps: number;
  relaunches: number;
  outcome: 'HELD' | 'BROKEN';
  violations: Violation[];
  /** Screen-level foreign renders: another account's numbers on the hero. */
  foreignRenders: number;
  /** Store-level foreign snapshots observed while the navigator was mounted. */
  foreignSnapshots: number;
  /**
   * Previous account's snapshot still in the store while Gate showed
   * LoadingState (unrenderable; transient until the new owner's refresh).
   */
  gatedStaleSnapshots: number;
  gatedStaleDetail: string | null;
  actWarnings: number;
  consoleErrors: string[];
  orphanedStatements: number;
  /** Steps that actually took effect, by kind (a no-op step is not counted). */
  applied: Record<string, number>;
  /** observe() calls that found StreakCalendarScreen mounted / showing its error card. */
  calendarObservations: number;
  errorCardObservations: number;
  /** Distinct hero (streak, days) pairs rendered by the calendar. */
  heroValues: string[];
  celebrations: number;
  wallMs: number;
}

async function flush(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

interface RunOptions {
  /** Stop at the first violation (used by the minimizer). */
  stopOnFirst?: boolean;
}

async function runScenario(
  scenario: Scenario,
  options: RunOptions = {},
): Promise<Row> {
  const startedWall = jest.getRealSystemTime();
  jest.setSystemTime(new Date(LAUNCH_INSTANT));
  const launchMs = Date.now();

  const db = new StressLocalDbImpl();
  db.latencyMs = scenario.latencyMs;
  mockWorld.db = db;

  const consoleErrors: string[] = [];
  let actWarnings = 0;
  const errorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args) => {
      const text = args
        .map(a => (typeof a === 'string' ? a : String(a)))
        .join(' ');
      if (text.includes('not wrapped in act')) {
        actWarnings += 1;
        return;
      }
      consoleErrors.push(text.slice(0, 400));
    });
  const warnSpy = jest
    .spyOn(console, 'warn')
    .mockImplementation(() => undefined);

  let proc = boot();
  // Persisted world: profiles + shots for every account.
  for (const owner of ['alpha', 'bravo', 'guest'] as const) {
    const key = ownerKeyFor(owner);
    db.shots.set(key, shotRowsFor(owner, launchMs));
    db.kv.set(`profile:${key}`, PROFILE_JSON);
  }

  const violations: Violation[] = [];
  let foreignRenders = 0;
  let foreignSnapshots = 0;
  let gatedStale = 0;
  let gatedStaleDetail: string | null = null;
  const appliedByKind: Record<string, number> = {};
  let calendarObservations = 0;
  let errorCardObservations = 0;
  const heroValues = new Set<string>();
  /** Celebrations raised across every process of this scenario. */
  const allCelebrations: Proc['celebrations'] = [];
  let relaunches = 0;
  let drillCounter = 0;
  let stepIndex = -1;
  let currentStep = 'launch';
  let vault: HarnessSession | null = null;
  /** Owner the harness has committed (what the auth layer told the app). */
  let committed: OwnerTag = 'signed-out';

  const violate = (invariant: string, detail: string) => {
    violations.push({ invariant, stepIndex, step: currentStep, detail });
  };

  const signIn = (owner: WritableOwner, tokenGeneration = 0) => {
    // Mirrors authStore: install the owner scope first, then publish the
    // session (installApiSession → set({ session })).
    const session = sessionFor(owner, tokenGeneration);
    vault = session;
    committed = owner;
    setActiveDataOwner(ownerKeyFor(owner));
    authStore.setState({ session });
  };
  const signOut = () => {
    vault = null;
    committed = 'signed-out';
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    authStore.setState({ session: null });
  };

  const observe = () => {
    if (proc.caught.length > 0) {
      violate('noCrash', `error boundary caught: ${String(proc.caught[0])}`);
      proc.caught.length = 0;
    }
    const state = useConsistencyStore.getState();
    const view = readScreen(proc);
    const activeTag = tagForOwnerKey(getActiveDataOwner());
    if (view.calendarMounted) {
      calendarObservations += 1;
      if (view.errorCard) errorCardObservations += 1;
      if (view.heroStreak !== null) {
        heroValues.add(`${view.heroStreak}/${view.heroDaysTrained}`);
      }
    }
    if (state.snapshot) {
      const owner = attribute(db, state.snapshot);
      if (owner === 'unknown') {
        violate('snapshotAttributable', 'snapshot matches no device account');
      } else if (
        activeTag &&
        activeTag !== 'signed-out' &&
        owner !== activeTag
      ) {
        const detail = `store holds ${owner}'s snapshot (streak ${state.snapshot.currentStreak}) while ${activeTag} is the active owner; store.ownerKey=${tagForOwnerKey(state.ownerKey)}`;
        if (view.navigatorMounted) {
          // Renderable: HomeScreen/StreakCalendarScreen read `snapshot`.
          foreignSnapshots += 1;
          violate('noForeignSnapshot', detail);
          if (
            view.calendarMounted &&
            view.heroStreak === state.snapshot.currentStreak
          ) {
            foreignRenders += 1;
            violate(
              'noForeignRender',
              `StreakCalendarScreen shows ${owner}'s hero (streak ${view.heroStreak}, ${view.heroDaysTrained} days) to ${activeTag}`,
            );
          }
        } else {
          // Gate is showing LoadingState, so nothing can render it — but the
          // previous account's snapshot is still in memory, re-stamped with
          // the new ownerKey (store.hydrate sets ownerKey without clearing
          // snapshot). Recorded, not a violation.
          gatedStale += 1;
          if (gatedStaleDetail === null) gatedStaleDetail = detail;
        }
      }
    }
    if (view.calendarMounted) {
      if (view.errorCard !== (!state.snapshot && state.loadError)) {
        violate(
          'errorCardIffNoSnapshotAndLoadError',
          `errorCard=${view.errorCard} snapshot=${Boolean(state.snapshot)} loadError=${state.loadError}`,
        );
      }
      if (view.heroStreak !== null) {
        const expectedStreak = state.snapshot?.currentStreak ?? 0;
        const expectedTrained = state.snapshot?.totalTrainedDays ?? 0;
        if (
          view.heroStreak !== expectedStreak ||
          view.heroDaysTrained !== expectedTrained
        ) {
          violate(
            'heroMatchesStore',
            `hero streak=${view.heroStreak}/${expectedStreak} trained=${view.heroDaysTrained}/${expectedTrained}`,
          );
        }
      }
    }
    if (committed === 'signed-out' && view.navigatorMounted) {
      violate(
        'signedOutHidesNavigator',
        'RootNavigator mounted while signed out',
      );
    }
  };

  /** Drain fake timers until storage, the store and the tree stop moving. */
  const settle = async () => {
    const step = Math.max(1, scenario.latencyMs);
    let quiet = 0;
    let changes = 0;
    const unsub = useConsistencyStore.subscribe(() => {
      changes += 1;
    });
    const unsubApp = useAppStore.subscribe(() => {
      changes += 1;
    });
    for (let i = 0; i < 400 && quiet < 3; i += 1) {
      changes = 0;
      await flush(step);
      if (db.pending === 0 && changes === 0) quiet += 1;
      else quiet = 0;
    }
    unsub();
    unsubApp();
    if (db.pending !== 0) {
      violate('settles', `storage still has ${db.pending} pending statements`);
    }
  };

  const unmountProc = async () => {
    await act(async () => {
      proc.renderer?.unmount();
    });
    proc.renderer = null;
  };

  const leakCheck = (label: string) => {
    if (appStateListeners.size !== 0) {
      violate(
        'noLeakedAppStateListeners',
        `${label}: ${appStateListeners.size} AppState listener(s) survive unmount`,
      );
    }
    if (mockNotificationSubscriptions.live !== 0) {
      violate(
        'noLeakedNotificationSubscriptions',
        `${label}: ${mockNotificationSubscriptions.live} notification subscription(s) survive unmount`,
      );
    }
  };

  const applyStep = async (step: Step): Promise<boolean> => {
    switch (step.kind) {
      case 'open': {
        const view = readScreen(proc);
        if (!view.navigatorMounted || view.calendarMounted) return false;
        const node = findPressable(proc, l => l === 'Open streak calendar');
        if (!node) return false;
        await act(async () => {
          node.props.onPress();
        });
        return true;
      }
      case 'back': {
        if (!readScreen(proc).calendarMounted) return false;
        const node = findPressable(proc, l => l === 'Back');
        if (!node) return false;
        await act(async () => {
          node.props.onPress();
        });
        return true;
      }
      case 'background':
      case 'foreground': {
        const next = step.kind === 'background' ? 'background' : 'active';
        await act(async () => {
          for (const listener of [...appStateListeners]) listener(next);
        });
        return true;
      }
      case 'kill_relaunch': {
        // Process death: the tree is gone, every in-flight statement fails,
        // and whatever the dying process' continuations do to the in-memory
        // stores is discarded by the cold boot below.
        await unmountProc();
        leakCheck('kill');
        proc.unsubscribe();
        allCelebrations.push(...proc.celebrations);
        db.kill();
        for (let i = 0; i < 50 && db.inFlightAll > 0; i += 1) {
          await flush(Math.max(1, scenario.latencyMs));
        }
        await flush(1);
        relaunches += 1;
        db.relaunch();
        proc = boot();
        if (vault) {
          const session = vault;
          const owner = committed as WritableOwner;
          // authStore.hydrate(): owner scope from the vault, then session.
          setActiveDataOwner(ownerKeyFor(owner));
          authStore.setState({ session });
        } else {
          setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
        }
        await mount(proc);
        return true;
      }
      case 'switch_owner': {
        if (committed === step.to) return false;
        await act(async () => {
          signIn(step.to);
        });
        return true;
      }
      case 'sign_out': {
        if (committed === 'signed-out') return false;
        await act(async () => {
          signOut();
        });
        return true;
      }
      case 'rotate_token': {
        if (!vault) return false;
        const current = vault;
        await act(async () => {
          signIn(committed as WritableOwner, current.tokenGeneration + 1);
        });
        return true;
      }
      case 'storage_fault':
        db.fault = step.on ? step.scope : false;
        return true;
      case 'record_drill': {
        if (committed === 'signed-out') return false;
        drillCounter += 1;
        await act(async () => {
          void useConsistencyStore
            .getState()
            .recordDrillCompletion({
              id: `stress-drill-${drillCounter}`,
              slug: 'dink-ladder',
              title: 'Dink ladder',
              completedAtIso: new Date().toISOString(),
            })
            .catch(() => undefined);
        });
        return true;
      }
      case 'rehydrate': {
        await act(async () => {
          void useConsistencyStore.getState().hydrate();
        });
        return true;
      }
      case 'tap_day': {
        // DayCell label: `YYYY-MM-DD, trained, N activities` / `…, shield protected`.
        const node = findPressable(proc, l =>
          /^\d{4}-\d{2}-\d{2}, (trained|shield)/.test(l),
        );
        if (!node) return false;
        await act(async () => {
          node.props.onPress();
        });
        return true;
      }
      case 'prev_month':
      case 'next_month': {
        const label =
          step.kind === 'prev_month' ? 'Previous month' : 'Next month';
        const node = findPressable(proc, l => l === label);
        if (!node) return false;
        await act(async () => {
          node.props.onPress();
        });
        return true;
      }
      case 'try_again': {
        if (!readScreen(proc).errorCard) return false;
        const node = findPressable(proc, l => l === 'Try again');
        if (!node) return false;
        await act(async () => {
          node.props.onPress();
        });
        return true;
      }
      case 'clock_jump':
        jest.setSystemTime(Date.now() + step.hours * 3_600_000);
        return true;
      case 'wait':
        await flush(step.ms);
        return true;
      default:
        return false;
    }
  };

  let executedSteps = 0;
  try {
    // Cold launch signed in as the initial owner (vault already holds it).
    signIn(scenario.initialOwner);
    await mount(proc);
    // Let the launch settle so the first `open` finds the navigator.
    await settle();
    observe();

    for (let i = 0; i < scenario.steps.length; i += 1) {
      const step = scenario.steps[i];
      if (!step) continue;
      stepIndex = i;
      currentStep = describeStep(step);
      const applied = await applyStep(step);
      if (applied) {
        executedSteps += 1;
        appliedByKind[step.kind] = (appliedByKind[step.kind] ?? 0) + 1;
      }
      // A single microtask/timer tick so mid-flight interleavings are real.
      await flush(0);
      observe();
      if (options.stopOnFirst && violations.length > 0) break;
    }

    if (!(options.stopOnFirst && violations.length > 0)) {
      // ---- Settle and check the resting state. -------------------------
      stepIndex = scenario.steps.length;
      currentStep = 'settle';
      db.fault = false;
      await settle();
      // Storage is back; the app's own recovery path is the next foreground
      // (useConsistencyBootstrap refreshes on 'active'). Nothing else may be
      // needed for the store to come back clean.
      await act(async () => {
        for (const listener of [...appStateListeners]) listener('background');
      });
      await act(async () => {
        for (const listener of [...appStateListeners]) listener('active');
      });
      await settle();
      observe();
      const state = useConsistencyStore.getState();
      if (committed === 'signed-out') {
        if (
          state.snapshot !== null ||
          state.ownerKey !== SIGNED_OUT_DATA_OWNER
        ) {
          violate(
            'signedOutClearsStore',
            `snapshot=${Boolean(state.snapshot)} ownerKey=${state.ownerKey}`,
          );
        }
      } else {
        const expected = expectedSnapshot(db, committed);
        const got = state.snapshot;
        if (!got) {
          violate(
            'settledSnapshotPresent',
            `no snapshot for ${committed} (loadError=${state.loadError})`,
          );
        } else if (
          got.currentStreak !== expected.currentStreak ||
          got.totalTrainedDays !== expected.totalTrainedDays ||
          got.asOfDay !== expected.asOfDay ||
          JSON.stringify(trainedDays(got)) !==
            JSON.stringify(trainedDays(expected))
        ) {
          violate(
            'settledSnapshotCorrect',
            `got streak=${got.currentStreak} trained=${got.totalTrainedDays} asOf=${got.asOfDay}; expected streak=${expected.currentStreak} trained=${expected.totalTrainedDays} asOf=${expected.asOfDay}`,
          );
        }
        if (state.loadError)
          violate(
            'settledNoLoadError',
            'loadError still true after storage restored',
          );

        // ---- Idempotent re-hydrate: two more hydrates change nothing. ----
        currentStep = 'rehydrate×2';
        const kvBefore = JSON.stringify(db.kvSnapshot());
        const snapBefore = JSON.stringify(state.snapshot);
        const celebrationsBefore = proc.celebrations.length;
        await act(async () => {
          void useConsistencyStore.getState().hydrate();
          void useConsistencyStore.getState().hydrate();
        });
        await settle();
        observe();
        const after = useConsistencyStore.getState();
        if (JSON.stringify(after.snapshot) !== snapBefore) {
          violate(
            'idempotentRehydrate',
            'snapshot changed across a double hydrate',
          );
        }
        if (JSON.stringify(db.kvSnapshot()) !== kvBefore) {
          violate(
            'idempotentRehydrate',
            'persisted kv changed across a double hydrate',
          );
        }
        if (proc.celebrations.length !== celebrationsBefore) {
          violate(
            'idempotentRehydrate',
            'a re-hydrate raised a new celebration',
          );
        }
      }

      // ---- Celebrations: each milestone at most once per owner, across
      // relaunches too (the ledger persists what was celebrated). ---------
      allCelebrations.push(...proc.celebrations);
      proc.celebrations.length = 0;
      const seen = new Set<string>();
      for (const c of allCelebrations) {
        const key = `${c.owner}:${c.id}`;
        if (seen.has(key)) violate('celebrateOnce', `${key} celebrated twice`);
        seen.add(key);
      }

      // ---- Final unmount: nothing may survive. --------------------------
      currentStep = 'unmount';
      await unmountProc();
      await flush(50);
      leakCheck('final');
      if (jest.getTimerCount() !== 0) {
        violate(
          'noLeakedTimers',
          `${jest.getTimerCount()} fake timer(s) pending after unmount`,
        );
      }
    }
  } catch (error) {
    violate(
      'noThrow',
      `runner threw: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  } finally {
    if (proc.renderer) {
      try {
        await unmountProc();
      } catch {
        // already reported
      }
    }
    proc.unsubscribe();
    mockNotificationSubscriptions.live = 0;
    jest.clearAllTimers();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    mockWorld.db = null;
  }
  if (consoleErrors.length > 0) {
    violate('consoleClean', consoleErrors.slice(0, 3).join(' | '));
  }

  return {
    seed: scenario.seed,
    latencyMs: scenario.latencyMs,
    initialOwner: scenario.initialOwner,
    steps: scenario.steps.map(describeStep),
    executedSteps,
    relaunches,
    outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
    violations,
    foreignRenders,
    foreignSnapshots,
    gatedStaleSnapshots: gatedStale,
    gatedStaleDetail,
    actWarnings,
    consoleErrors,
    orphanedStatements: db.orphaned,
    applied: appliedByKind,
    calendarObservations,
    errorCardObservations,
    heroValues: [...heroValues].sort(),
    celebrations: allCelebrations.length,
    wallMs: jest.getRealSystemTime() - startedWall,
  };
}

// ---------------------------------------------------------------------------
// Artifacts.
// ---------------------------------------------------------------------------
function artifactDir(): string {
  const configured = nodeProcess.env['STRESS_ARTIFACT_DIR'];
  const dir =
    configured && configured.length > 0
      ? configured
      : path.resolve(
          __dirname,
          '../../../../artifacts/stress/scr-streakcalendarscreen-lifecycle',
        );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(name: string, value: unknown): string {
  const file = path.join(artifactDir(), name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return file;
}

function envInt(name: string, fallback: number): number {
  const raw = nodeProcess.env[name];
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// ---------------------------------------------------------------------------
// Campaign.
// ---------------------------------------------------------------------------
const REPLAY_SEED = nodeProcess.env['STRESS_SEED'];
const ITERATIONS = REPLAY_SEED ? 1 : envInt('STRESS_ITER', 24);
const SEED_BASE = REPLAY_SEED
  ? Number(REPLAY_SEED)
  : envInt('STRESS_SEED_BASE', 1000);
const MINIMIZE = nodeProcess.env['STRESS_MINIMIZE'] !== '0';
const FLAKE_RUNS = 10;

beforeAll(() => {
  jest.useFakeTimers();
});

afterAll(() => {
  jest.useRealTimers();
});

describe('StreakCalendarScreen · lifecycle interruption stress', () => {
  test(
    `seeded campaign: ${ITERATIONS} interleaving(s) from seed ${SEED_BASE}`,
    async () => {
      const rows: Row[] = [];
      for (let i = 0; i < ITERATIONS; i += 1) {
        const scenario = generateScenario(SEED_BASE + i);
        rows.push(await runScenario(scenario));
      }

      const broken = rows.filter(r => r.outcome === 'BROKEN');
      const minimized: {
        seed: number;
        invariants: string[];
        originalSteps: number;
        minimizedSteps: string[];
        minimizedLatencyMs: number;
        minimizedInitialOwner: WritableOwner;
        flakeRate: string;
        replay: Record<string, unknown>;
      }[] = [];

      if (MINIMIZE) {
        // Minimize one seed per distinct invariant set (cheap, and every
        // extra seed of the same class is already in the row table).
        const byInvariants = new Map<string, Row>();
        for (const row of broken) {
          const key = [...new Set(row.violations.map(v => v.invariant))]
            .sort()
            .join('+');
          if (!byInvariants.has(key)) byInvariants.set(key, row);
        }
        for (const [key, row] of byInvariants) {
          const target = new Set(key.split('+'));
          const failsSame = async (candidate: Scenario) => {
            const result = await runScenario(candidate, { stopOnFirst: false });
            const got = new Set(result.violations.map(v => v.invariant));
            return [...target].every(inv => got.has(inv));
          };
          const scenario = generateScenario(row.seed);
          const small = await minimizeSteps(scenario, failsSame);
          let failures = 0;
          for (let k = 0; k < FLAKE_RUNS; k += 1) {
            if (await failsSame(small)) failures += 1;
          }
          minimized.push({
            seed: row.seed,
            invariants: [...target].sort(),
            originalSteps: scenario.steps.length,
            minimizedSteps: small.steps.map(describeStep),
            minimizedLatencyMs: small.latencyMs,
            minimizedInitialOwner: small.initialOwner,
            flakeRate: `${failures}/${FLAKE_RUNS}`,
            replay: {
              command: `STRESS_SEED=${row.seed} npx jest --ci __tests__/stress/streakCalendarLifecycle`,
              minimizedScenario: small,
            },
          });
        }
      }

      const invariantCounts: Record<string, number> = {};
      for (const row of rows) {
        for (const inv of new Set(row.violations.map(v => v.invariant))) {
          invariantCounts[inv] = (invariantCounts[inv] ?? 0) + 1;
        }
      }
      const summary = {
        unit: 'scr-streakcalendarscreen',
        lens: 'lifecycle',
        seedBase: SEED_BASE,
        iterations: ITERATIONS,
        executed: rows.length,
        held: rows.length - broken.length,
        broken: broken.length,
        brokenSeeds: broken.map(r => r.seed),
        invariantCounts,
        totalExecutedSteps: rows.reduce((n, r) => n + r.executedSteps, 0),
        totalRelaunches: rows.reduce((n, r) => n + r.relaunches, 0),
        foreignRenders: rows.reduce((n, r) => n + r.foreignRenders, 0),
        foreignSnapshots: rows.reduce((n, r) => n + r.foreignSnapshots, 0),
        gatedStaleSnapshots: rows.reduce(
          (n, r) => n + r.gatedStaleSnapshots,
          0,
        ),
        gatedStaleSeeds: rows
          .filter(r => r.gatedStaleSnapshots > 0)
          .map(r => r.seed),
        appliedByKind: rows.reduce<Record<string, number>>((acc, r) => {
          for (const [kind, n] of Object.entries(r.applied)) {
            acc[kind] = (acc[kind] ?? 0) + n;
          }
          return acc;
        }, {}),
        calendarObservations: rows.reduce(
          (n, r) => n + r.calendarObservations,
          0,
        ),
        errorCardObservations: rows.reduce(
          (n, r) => n + r.errorCardObservations,
          0,
        ),
        heroValues: [...new Set(rows.flatMap(r => r.heroValues))].sort(),
        celebrations: rows.reduce((n, r) => n + r.celebrations, 0),
        orphanedStatements: rows.reduce((n, r) => n + r.orphanedStatements, 0),
        actWarnings: rows.reduce((n, r) => n + r.actWarnings, 0),
        latencies: Object.fromEntries(
          [...new Set(rows.map(r => r.latencyMs))]
            .sort((a, b) => a - b)
            .map(l => [
              `${l}ms`,
              {
                runs: rows.filter(r => r.latencyMs === l).length,
                broken: rows.filter(
                  r => r.latencyMs === l && r.outcome === 'BROKEN',
                ).length,
              },
            ]),
        ),
        minimized,
        wallMs: rows.reduce((n, r) => n + r.wallMs, 0),
        node: nodeProcess.version,
      };
      const rowsFile = writeJson(`rows-${SEED_BASE}-${ITERATIONS}.json`, rows);
      const summaryFile = writeJson(
        `summary-${SEED_BASE}-${ITERATIONS}.json`,
        summary,
      );
      console.log(
        `[stress:lifecycle] executed=${rows.length} held=${summary.held} broken=${summary.broken} ` +
          `invariants=${JSON.stringify(invariantCounts)} rows=${rowsFile} summary=${summaryFile}`,
      );

      expect(rows).toHaveLength(ITERATIONS);
      expect(
        broken.map(r => ({ seed: r.seed, violations: r.violations })),
      ).toEqual([]);
    },
    // ~1–3 s per scenario with relaunches; campaign runs set STRESS_ITER.
    Math.max(60_000, ITERATIONS * 12_000),
  );
});
