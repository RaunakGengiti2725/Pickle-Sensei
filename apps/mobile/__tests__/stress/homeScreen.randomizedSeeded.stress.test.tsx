/**
 * STRESS — HomeScreen, lens `randomized-seeded` (seeded randomized long-run).
 *
 * The REAL `RootNavigator` (NavigationContainer + native-stack + bottom tabs +
 * PremiumTabBar) is mounted under the app's SafeAreaProvider/QueryClient
 * providers with the REAL HomeScreen, PlayerRankBanner, NotificationPrimingCard
 * and the REAL zustand stores (app, consistency, notification, api session,
 * rank celebration, access). The production `getDb()` runs its migrations
 * against a real SQLite (`node:sqlite`) behind the op-sqlite native seam;
 * shots are written through the production repository (`saveAnalysis`).
 *
 * Mocked (native / network boundaries only): op-sqlite (→ node:sqlite, with a
 * fault switch), `globalThis.fetch` (seeded responder for /v1/progress and
 * /v1/rank: ok | http500 | network | garbage | slow5s | slow20s), the notifee
 * native module (permission outcome), reanimated/svg/gradient/safe-area (repo
 * jest mocks), the auth store (its module pulls the Apple/Google SDKs), the
 * billing deps of the access store, and the OTHER screens registered on the
 * navigator (they are separate units and pull camera/vision natives): each is
 * replaced by a marker that reports its route name/params and offers Back.
 *
 * Generator: per seed, a deterministic RNG (mulberry32) builds a world
 * (owner mode, seeded shots, kv chart preference, fetch mode, permission
 * outcome, access variant) and 5–60 legal/near-legal actions over the
 * screen's public surface (every pressable, pull-to-refresh, retry, tab and
 * stack navigation, relaunch, external events: new shot persisted, SQLite
 * fault on/off, network mode changes, clock ticks). Actions that are not
 * applicable to the current UI are recorded as `skipped` (near-legal).
 *
 * INVARIANTS model-checked after EVERY step (I1–I14):
 *  I1  render/act never throws; no React/console.error; no unhandled
 *      rejection.
 *  I2  exactly one of {Loading, Error, Content} is on screen and it matches
 *      the oracle (loaded/loadError lifecycle incl. in-flight progress fetch).
 *  I3  SQLite failure at load → the exact ErrorState copy; retry with a
 *      healthy database recovers to Content (HomeScreen.tsx:144-150, 205-217).
 *  I4  canonical progress failure never produces the load error
 *      (HomeScreen.tsx:134-142 isolation).
 *  I5  Recent reads = first ≤5 rows of the owner's real shots by capturedAt
 *      desc, in order, with the right labels and scores; "N latest" count.
 *  I6  Latest technique = first scored row with a non-null score, else the
 *      synced daily average when progress loaded, else "—".
 *  I7  Week chart: exactly one tab selected; it equals the oracle (last
 *      persisted kv value at load, user taps since); kv ∈ {scores, reads}.
 *  I8  Streak badge number == consistency store snapshot.currentStreak (or 0)
 *      and equals the rank banner's streak (cross-surface consistency).
 *  I9  Navigation: each control lands on its declared route with declared
 *      params (Analyze gate: guest → ConnectAccount, exhausted → Paywall).
 *  I10 Rank banner fold-out mounted iff expanded (after the 180ms fold-away);
 *      the banner unmounts with the content tree (ErrorState/LoadingState
 *      replace it), so a load failure resets it to collapsed.
 *  I11 Notification card visible iff store says so; Turn on / Not now
 *      outcomes follow the permission result; failure copy on throw.
 *  I12 Pull-to-refresh: RefreshControl.refreshing true from a pull until the
 *      FIRST pull-started load settles (each onRefresh's `finally` clears it,
 *      HomeScreen.tsx:229-232 — overlapping pulls are not tracked).
 *  I13 Profile pill / greeting reflect the app store profile.
 *  I14 Determinism: replaying the same seed yields an identical trace.
 *
 * Scale: STRESS_ITER (default 40; campaign ≥2000), STRESS_SEED base,
 * STRESS_SHARD=i/n, STRESS_REPLAY=<seed> (one seed), STRESS_REPLAY_EVERY
 * (determinism replay cadence, default 1 = every seed), STRESS_OUT (JSON
 * table dir, default artifacts/stress). Every failure is minimized (ddmin
 * over the action list) and recorded with its seed.
 */
import React from 'react';
import { Pressable, RefreshControl, Text, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useIsFocused,
  useNavigation,
  useRoute,
} from '@react-navigation/native';
import type { ShotAnalysis } from '@pickle/shared-types';
import { RootNavigator } from '../../src/navigation/RootNavigator';
import { getDb } from '../../src/data/db';
import {
  saveAnalysis,
  saveLocalOnlyAnalysis,
  setKv,
} from '../../src/data/repository';
import {
  GUEST_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import { useAppStore } from '../../src/state/appStore';
import { useConsistencyStore } from '../../src/consistency/store';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import { DEFAULT_NOTIFICATION_PREFS } from '../../src/notifications/types';
import { useRankCelebrationStore } from '../../src/progress/rankCelebration';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
} from '../../src/state/accessStore';
import type {
  BillingAccessDependencies,
  CanonicalAccessState,
} from '../../src/billing/types';
import { useAuthStore } from '../../src/auth/authStore';
import {
  WEEK_CHART_KV_KEY,
  type WeekChart,
} from '../../src/screens/HomeScreen';

// apps/mobile types only `jest` (no @types/node); declare the exact Node
// surface this harness drives (same pattern as __tests__/matrix).
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
  memoryUsage(): { heapUsed: number };
};

interface SqliteStatement {
  all(...params: (string | number | null)[]): Record<string, unknown>[];
}
interface DatabaseSync {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (location: string) => DatabaseSync;
};
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

// ---------------------------------------------------------------------------
// Native / network seams
// ---------------------------------------------------------------------------

const mockSqlite: { real: DatabaseSync | null; fault: boolean } = {
  real: null,
  fault: false,
};

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    const db = mockSqlite.real;
    if (!db) throw new Error('stress harness did not open a database');
    return {
      executeSync: (sql: string) => ({ rows: db.prepare(sql).all() }),
      execute: async (sql: string, params: unknown[] = []) => {
        if (mockSqlite.fault) {
          throw new Error('SQLITE_BUSY: database is locked');
        }
        return {
          rows: db.prepare(sql).all(...(params as (string | number | null)[])),
        };
      },
      close: () => {
        // The harness owns the node:sqlite handle lifecycle.
      },
    };
  },
}));

jest.mock('react-native-linear-gradient', () => {
  const ReactModule = require('react') as typeof import('react');
  const { View: RNView } =
    require('react-native') as typeof import('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    ReactModule.createElement(RNView, null, props.children);
  return { __esModule: true, default: MockGradient };
});

jest.mock('react-native-svg', () => {
  const ReactModule = require('react') as typeof import('react');
  const { View: RNView } =
    require('react-native') as typeof import('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    ReactModule.createElement(RNView, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Line: Mock,
    Path: Mock,
    Polyline: Mock,
    Polygon: Mock,
    Rect: Mock,
    Defs: Mock,
    LinearGradient: Mock,
    RadialGradient: Mock,
    Stop: Mock,
    G: Mock,
    Text: Mock,
    Ellipse: Mock,
    ClipPath: Mock,
    Mask: Mock,
  };
});

jest.mock('react-native-safe-area-context', () => {
  const mock = require('react-native-safe-area-context/jest/mock') as {
    default: unknown;
  };
  return mock.default;
});

// The auth store module pulls the Apple/Google sign-in SDKs; the navigator
// and tab bar only read `session.localOnly` / `session.provider` from it.
jest.mock('../../src/auth/authStore', () => {
  const { create } = require('zustand') as typeof import('zustand');
  const store = create(() => ({
    hydrated: true,
    session: null as null | {
      provider: 'guest' | 'apple';
      localOnly: boolean;
      subject: string;
      canonicalAppUserId: string | null;
      displayName: string | null;
      email: string | null;
    },
    busy: false,
    error: null,
    signInWithApple: async () => undefined,
    signInWithGoogle: async () => undefined,
    clearError: () => undefined,
  }));
  return { __esModule: true, useAuthStore: store };
});

// Screens the navigator registers besides Home are separate units with
// camera/vision/billing natives; each becomes a focus-aware route marker.
function mockMarkerModule(exportName: string) {
  {
    const ReactModule = require('react') as typeof import('react');
    const RN = require('react-native') as typeof import('react-native');
    const nav =
      require('@react-navigation/native') as typeof import('@react-navigation/native');
    const Marker = () => {
      const navigation = nav.useNavigation();
      const route = nav.useRoute();
      const focused = nav.useIsFocused();
      return ReactModule.createElement(
        RN.View,
        { testID: 'route-box', accessibilityState: { selected: focused } },
        ReactModule.createElement(
          RN.Text,
          {
            testID: 'route-marker',
            accessibilityState: { selected: focused },
          },
          route.name,
        ),
        ReactModule.createElement(
          RN.Text,
          { testID: 'route-params' },
          JSON.stringify(route.params ?? null),
        ),
        ReactModule.createElement(RN.Pressable, {
          accessibilityLabel: `Back from ${route.name}`,
          testID: 'route-back',
          onPress: () => {
            if (navigation.canGoBack()) navigation.goBack();
          },
        }),
      );
    };
    return { __esModule: true, [exportName]: Marker };
  }
}
jest.mock('../../src/screens/LibraryScreen', () =>
  mockMarkerModule('LibraryScreen'),
);
jest.mock('../../src/screens/ProgressScreen', () =>
  mockMarkerModule('ProgressScreen'),
);
jest.mock('../../src/screens/SettingsScreen', () =>
  mockMarkerModule('SettingsScreen'),
);
jest.mock('../../src/screens/AnalyzeScreen', () =>
  mockMarkerModule('AnalyzeScreen'),
);
jest.mock('../../src/screens/DrillLibraryScreen', () =>
  mockMarkerModule('DrillLibraryScreen'),
);
jest.mock('../../src/screens/ResultScreen', () =>
  mockMarkerModule('ResultScreen'),
);
jest.mock('../../src/screens/ResultDetailsScreen', () =>
  mockMarkerModule('ResultDetailsScreen'),
);
jest.mock('../../src/screens/FormReviewScreen', () =>
  mockMarkerModule('FormReviewScreen'),
);
jest.mock('../../src/screens/StreakCalendarScreen', () =>
  mockMarkerModule('StreakCalendarScreen'),
);
jest.mock('../../src/screens/PaywallScreen', () =>
  mockMarkerModule('PaywallScreen'),
);
jest.mock('../../src/screens/SignInScreen', () =>
  mockMarkerModule('SignInScreen'),
);
jest.mock('../../src/screens/ManageAccountScreen', () =>
  mockMarkerModule('ManageAccountScreen'),
);
jest.mock('../../src/screens/ConsentSettingsScreen', () =>
  mockMarkerModule('ConsentSettingsScreen'),
);
jest.mock('../../src/screens/NotificationSettingsScreen', () =>
  mockMarkerModule('NotificationSettingsScreen'),
);

// Keep the imports above "used" for the type checker (markers use them
// through require at mock-evaluation time).
void useIsFocused;
void useNavigation;
void useRoute;
void Pressable;
void View;

const notifee = (
  require('react-native-notify-kit') as {
    default: {
      requestPermission: jest.Mock;
      getNotificationSettings: jest.Mock;
    };
  }
).default;

// ---------------------------------------------------------------------------
// Deterministic RNG + plan generation
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  int(min: number, maxInclusive: number): number {
    return min + Math.floor(this.next() * (maxInclusive - min + 1));
  }
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  weighted<T>(table: ReadonlyArray<[T, number]>): T {
    const total = table.reduce((sum, [, w]) => sum + w, 0);
    let roll = this.next() * total;
    for (const [item, w] of table) {
      roll -= w;
      if (roll < 0) return item;
    }
    const last = table[table.length - 1];
    if (!last) throw new Error('weighted from empty table');
    return last[0];
  }
}

type FetchMode =
  'ok' | 'http500' | 'network' | 'garbage' | 'slow5s' | 'slow20s';
type NotifMode = 'granted' | 'denied' | 'throws';
type OwnerMode = 'guest' | 'canonical';
type AccessVariant = 'free' | 'exhausted';

interface SeedShot {
  id: string;
  shotType: string;
  daysAgo: number;
  hour: number;
  scored: boolean;
  score: number | null;
}

interface WorldSpec {
  owner: OwnerMode;
  access: AccessVariant;
  fetchMode: FetchMode;
  notif: NotifMode;
  initialPermission: number;
  kvChart: string | null;
  shots: SeedShot[];
  profile: {
    firstName?: string;
    skillLevel: string;
    focusCheckpoint: string;
  } | null;
}

type Action =
  | { kind: 'pressStreakBadge' }
  | { kind: 'pressRankStreak' }
  | { kind: 'pressRankToggle' }
  | { kind: 'pressAnalyze' }
  | { kind: 'pressDrills' }
  | { kind: 'pressRecent'; index: number }
  | { kind: 'pressChart'; chart: WeekChart }
  | { kind: 'notifTurnOn' }
  | { kind: 'notifNotNow' }
  | { kind: 'pullRefresh' }
  | { kind: 'retry' }
  | { kind: 'back' }
  | { kind: 'tab'; tab: 'Home' | 'Library' | 'Progress' | 'Settings' }
  | { kind: 'insertShot'; shot: SeedShot }
  | { kind: 'dbFault'; on: boolean }
  | { kind: 'fetchMode'; mode: FetchMode }
  | { kind: 'tick'; ms: number }
  | { kind: 'relaunch' };

interface Plan {
  seed: number;
  world: WorldSpec;
  actions: Action[];
}

const SHOT_TYPES = [
  'serve',
  'return',
  'forehand_drive',
  'backhand_drive',
  'third_shot_drop',
  'dink',
  'volley',
  'overhead',
] as const;

const FETCH_MODES: readonly FetchMode[] = [
  'ok',
  'http500',
  'network',
  'garbage',
  'slow5s',
  'slow20s',
];

function shotSpec(rng: Rng, id: string): SeedShot {
  const scored = rng.chance(0.7);
  return {
    id,
    shotType: rng.pick(SHOT_TYPES),
    daysAgo: rng.weighted([
      [0, 3],
      [1, 3],
      [rng.int(2, 6), 3],
      [rng.int(7, 20), 2],
    ]),
    hour: rng.int(6, 21),
    scored,
    score: scored ? rng.int(20, 95) / 10 : null,
  };
}

function generatePlan(seed: number): Plan {
  const rng = new Rng(seed);
  const owner: OwnerMode = rng.chance(0.55) ? 'canonical' : 'guest';
  const shotCount = rng.weighted<number>([
    [0, 2],
    [1, 2],
    [rng.int(2, 5), 4],
    [rng.int(6, 12), 3],
  ]);
  const shots: SeedShot[] = [];
  for (let i = 0; i < shotCount; i += 1) {
    shots.push(shotSpec(rng, `seed-${seed}-shot-${i}`));
  }
  const world: WorldSpec = {
    owner,
    access: rng.chance(0.7) ? 'free' : 'exhausted',
    fetchMode: rng.pick(FETCH_MODES),
    notif: rng.weighted([
      ['granted', 5],
      ['denied', 3],
      ['throws', 2],
    ]),
    initialPermission: rng.weighted([
      [-1, 6],
      [0, 2],
      [1, 2],
    ]),
    kvChart: rng.weighted<string | null>([
      [null, 5],
      ['scores', 2],
      ['reads', 2],
      ['garbage-value', 1],
    ]),
    shots,
    profile: rng.chance(0.85)
      ? {
          ...(rng.chance(0.6)
            ? { firstName: rng.pick(['Ava', 'Raj', 'Mo']) }
            : {}),
          skillLevel: rng.pick(['3.0', '3.5', '4.0']),
          focusCheckpoint: rng.pick(['contact_position', 'preparation']),
        }
      : null,
  };
  const length = rng.int(5, 60);
  const actions: Action[] = [];
  let inserted = 0;
  for (let i = 0; i < length; i += 1) {
    const kind = rng.weighted<Action['kind']>([
      ['pressStreakBadge', 4],
      ['pressRankStreak', 3],
      ['pressRankToggle', 6],
      ['pressAnalyze', 4],
      ['pressDrills', 4],
      ['pressRecent', 6],
      ['pressChart', 7],
      ['notifTurnOn', 3],
      ['notifNotNow', 3],
      ['pullRefresh', 6],
      ['retry', 6],
      ['back', 14],
      ['tab', 5],
      ['insertShot', 5],
      ['dbFault', 4],
      ['fetchMode', 4],
      ['tick', 7],
      ['relaunch', 2],
    ]);
    switch (kind) {
      case 'pressRecent':
        actions.push({ kind, index: rng.int(0, 4) });
        break;
      case 'pressChart':
        actions.push({ kind, chart: rng.chance(0.5) ? 'scores' : 'reads' });
        break;
      case 'tab':
        actions.push({
          kind,
          tab: rng.pick(['Home', 'Library', 'Progress', 'Settings'] as const),
        });
        break;
      case 'insertShot':
        actions.push({
          kind,
          shot: shotSpec(rng, `seed-${seed}-live-${inserted}`),
        });
        inserted += 1;
        break;
      case 'dbFault':
        actions.push({ kind, on: rng.chance(0.4) });
        break;
      case 'fetchMode':
        actions.push({ kind, mode: rng.pick(FETCH_MODES) });
        break;
      case 'tick':
        actions.push({ kind, ms: rng.pick([16, 200, 1000, 5000, 16000]) });
        break;
      default:
        actions.push({ kind } as Action);
    }
  }
  return { seed, world, actions };
}

// ---------------------------------------------------------------------------
// World: fixed clock, database, stores, fetch, navigator mount
// ---------------------------------------------------------------------------

const FIXED_NOW_ISO = '2026-09-04T18:30:00.000Z';
const CANONICAL_USER_ID = '7f1a2b3c-4d5e-4f60-8a71-92b3c4d5e6f7';
const API_BASE_URL = 'https://stress.invalid';
const FOLD_AWAY_MS = 180;
const PROGRESS_TIMEOUT_MS = 15_000;
const LOAD_ERROR_COPY =
  'Your saved reads could not be opened. Try again to load your real court history.';

const freeAccess: CanonicalAccessState = {
  premium: false,
  entitlements: [],
  freeRatings: {
    limit: 2,
    used: 1,
    reserved: 0,
    remaining: 1,
    availableToReserve: 1,
  },
  canStartRating: true,
  paywallRequired: false,
};
const exhaustedAccess: CanonicalAccessState = {
  ...freeAccess,
  freeRatings: {
    limit: 2,
    used: 2,
    reserved: 0,
    remaining: 0,
    availableToReserve: 0,
  },
  canStartRating: false,
  paywallRequired: true,
};

function billingDependencies(
  access: CanonicalAccessState,
): BillingAccessDependencies {
  return {
    store: {
      configure: async () => undefined,
      loadPlans: async () => {
        throw new Error('stress harness: store plans unavailable');
      },
      purchase: async () => {
        throw new Error('stress harness: purchase unavailable');
      },
      restore: async () => {
        throw new Error('stress harness: restore unavailable');
      },
      readEntitlement: async () => ({
        premium: false,
        productId: null,
        expirationDate: null,
      }),
    },
    backend: {
      getAccess: async () => access,
      syncBilling: async () => ({ access }),
    },
  } as unknown as BillingAccessDependencies;
}

function progressPayload() {
  return {
    series: [
      {
        day: '2026-09-02',
        shot_type: 'dink',
        scoring_model_version: 'sm-v1',
        shot_count: 3,
        avg_score: 63,
        best_score: 71,
      },
    ],
    improving: [],
    needsAttention: [],
    streak: {
      currentDays: 2,
      longestDays: 5,
      practicedToday: false,
      lastPracticeDate: '2026-09-03',
    },
  };
}

function rankPayload() {
  return {
    rank: {
      rating: 5.2,
      tier: 'gold',
      techniqueCount: 1,
      techniques: [
        { shot_type: 'dink', score: 5.2, captured_at: '2026-09-02T10:00:00Z' },
      ],
    },
  };
}

interface FetchInit {
  signal?: {
    aborted: boolean;
    addEventListener(t: 'abort', l: () => void): void;
  };
}
interface MockResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

const world = {
  fetchMode: 'ok' as FetchMode,
  fetchLog: [] as string[],
};

function fetchDelay(mode: FetchMode): number {
  if (mode === 'slow5s') return 5000;
  if (mode === 'slow20s') return 20_000;
  return 0;
}

function progressDeliveredOk(mode: FetchMode): boolean {
  // slow20s exceeds the 15s AbortController budget → rejected → null.
  return mode === 'ok' || mode === 'slow5s';
}

function installFetch() {
  const fetchMock = (url: string, init?: FetchInit): Promise<MockResponse> =>
    new Promise((resolve, reject) => {
      const mode = world.fetchMode;
      const path = url.startsWith(API_BASE_URL)
        ? url.slice(API_BASE_URL.length)
        : url;
      world.fetchLog.push(`${path}:${mode}`);
      const respond = () => {
        switch (mode) {
          case 'network':
            reject(new TypeError('Network request failed'));
            return;
          case 'http500':
            resolve({
              ok: false,
              status: 500,
              json: async () => ({ error: 'internal' }),
            });
            return;
          case 'garbage':
            resolve({
              ok: true,
              status: 200,
              json: async () => {
                throw new SyntaxError('Unexpected token < in JSON');
              },
            });
            return;
          default:
            resolve({
              ok: true,
              status: 200,
              json: async () =>
                path === '/v1/rank' ? rankPayload() : progressPayload(),
            });
        }
      };
      const delay = fetchDelay(mode);
      if (delay === 0) {
        respond();
        return;
      }
      const timer = setTimeout(respond, delay);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        const error = new Error('Aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
}

function shotCapturedAt(spec: SeedShot): string {
  const base = new Date(FIXED_NOW_ISO).getTime();
  const at = new Date(base - spec.daysAgo * 86_400_000);
  at.setUTCHours(spec.hour, (spec.hour * 7) % 60, 0, 0);
  return at.toISOString();
}

function analysisFor(spec: SeedShot): ShotAnalysis {
  return {
    id: spec.id,
    sessionId: null,
    shotType: spec.shotType as ShotAnalysis['shotType'],
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: shotCapturedAt(spec),
    timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
    phases: [],
    measurements: [],
    checkpoints: [],
    overallScore: spec.score,
    analysisConfidence: spec.scored ? 0.9 : 0.4,
    resultKind: spec.scored ? 'scored' : 'low_confidence',
    guidance: spec.scored ? null : 'Move the phone back.',
    priorityFix: null,
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'stress-native-1',
      poseModelVersion: 'stress-pose-1',
      paddleModelVersion: 'stress-paddle-1',
      strokeDetectorVersion: 'stress-stroke-1',
      phaseModelVersion: 'stress-phase-1',
      scoringModelVersion: 'sm-v1',
      shotConfigVersion: `${spec.shotType}@1`,
    },
    source: 'real',
  } as ShotAnalysis;
}

async function persistShot(spec: SeedShot): Promise<void> {
  const analysis = analysisFor(spec);
  if (spec.scored) {
    await saveAnalysis(getDb(), analysis, `permit-${spec.id}`);
  } else {
    await saveLocalOnlyAnalysis(getDb(), analysis);
  }
}

// ---------------------------------------------------------------------------
// Oracle (model of the screen's documented behaviour)
// ---------------------------------------------------------------------------

interface ModelShot {
  id: string;
  shotType: string;
  capturedAt: string;
  score: number | null;
  scored: boolean;
}

interface InFlightLoad {
  finishAt: number;
  localOk: boolean;
  progressOk: boolean;
  fromPull: boolean;
  mountId: number;
}

interface Model {
  shots: ModelShot[];
  kvChart: string | null;
  dbFault: boolean;
  session: boolean;
  mountId: number;
  loaded: boolean;
  loadError: boolean;
  view: ModelShot[];
  weekChart: WeekChart;
  progressOk: boolean;
  expanded: boolean;
  foldOutUntil: number | null;
  refreshing: boolean;
  inFlight: InFlightLoad[];
  /** Whether Home is the focused route (tabs + stack). */
  homeFocused: boolean;
  route: string;
  routeParams: unknown;
}

function sortedShots(shots: ModelShot[]): ModelShot[] {
  return [...shots].sort((a, b) =>
    a.capturedAt < b.capturedAt ? 1 : a.capturedAt > b.capturedAt ? -1 : 0,
  );
}

function parseWeekChartLikeScreen(value: string | null): WeekChart {
  return value === 'reads' ? 'reads' : 'scores';
}

function now(): number {
  return Date.now();
}

function modelTriggerLoad(model: Model, fromPull: boolean, mode: FetchMode) {
  const localOk = !model.dbFault;
  if (fromPull) model.refreshing = true;
  if (!localOk) {
    // load(): listShots rejects → catch → setLoadError; finally setLoaded.
    // ErrorState replaces the content tree → PlayerRankBanner unmounts.
    model.loadError = true;
    model.loaded = true;
    model.expanded = false;
    model.foldOutUntil = null;
    model.inFlight.push({
      finishAt: now(),
      localOk: false,
      progressOk: false,
      fromPull,
      mountId: model.mountId,
    });
    return;
  }
  // Local reads resolve within microtasks: recent/latest/chart apply now.
  model.view = sortedShots(model.shots).slice(0, 250);
  model.weekChart = parseWeekChartLikeScreen(model.kvChart);
  const delay = model.session ? fetchDelay(mode) : 0;
  const finishAt =
    now() + (model.session ? Math.min(delay, PROGRESS_TIMEOUT_MS) : 0);
  model.inFlight.push({
    finishAt,
    localOk: true,
    progressOk: model.session ? progressDeliveredOk(mode) : false,
    fromPull,
    mountId: model.mountId,
  });
}

function modelSettle(model: Model) {
  const t = now();
  const due = model.inFlight
    .filter(load => load.finishAt <= t)
    .sort((a, b) => a.finishAt - b.finishAt);
  model.inFlight = model.inFlight.filter(load => load.finishAt > t);
  for (const load of due) {
    if (load.mountId !== model.mountId) continue;
    if (load.fromPull) model.refreshing = false;
    if (load.localOk) {
      model.progressOk = load.progressOk;
      model.loadError = false;
    }
    model.loaded = true;
  }
  if (model.foldOutUntil !== null && t >= model.foldOutUntil) {
    model.foldOutUntil = null;
  }
}

function modelScreen(model: Model): 'loading' | 'error' | 'content' {
  if (!model.loaded) return 'loading';
  if (model.loadError) return 'error';
  return 'content';
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

type Renderer = TestRenderer.ReactTestRenderer;
type Instance = TestRenderer.ReactTestInstance;

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function Shell() {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <RootNavigator />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

async function settle() {
  for (let i = 0; i < 12; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      jest.advanceTimersByTime(0);
    });
  }
}

async function advance(ms: number) {
  // Advance in slices so timers scheduled by timers (fold-away, fetch
  // resolution → state) interleave with effects deterministically.
  const slice = 100;
  let remaining = ms;
  while (remaining > 0) {
    const step = Math.min(slice, remaining);
    await act(async () => {
      jest.advanceTimersByTime(step);
      await Promise.resolve();
    });
    remaining -= step;
  }
  await settle();
}

function textOf(node: Instance): string {
  const parts: string[] = [];
  const walk = (child: unknown) => {
    if (typeof child === 'string' || typeof child === 'number') {
      parts.push(String(child));
    } else if (Array.isArray(child)) {
      child.forEach(walk);
    } else if (child && typeof child === 'object' && 'props' in child) {
      walk((child as { props: { children?: unknown } }).props.children);
    }
  };
  walk(node.props.children);
  return parts.join('');
}

function allTexts(renderer: Renderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .map(node => textOf(node))
    .filter(text => text.length > 0);
}

function findPressables(
  renderer: Renderer,
  match: { label?: string | RegExp; testID?: string },
): Instance[] {
  const nodes = renderer.root.findAll(node => {
    if (typeof node.props.onPress !== 'function') return false;
    if (match.testID !== undefined && node.props.testID !== match.testID) {
      return false;
    }
    if (match.label !== undefined) {
      const label = node.props.accessibilityLabel;
      if (typeof label !== 'string') return false;
      if (typeof match.label === 'string') {
        if (label !== match.label) return false;
      } else if (!match.label.test(label)) {
        return false;
      }
    }
    return true;
  });
  // PressableScale forwards the handler to its inner <Pressable> (last).
  const byHandler = new Map<unknown, Instance>();
  for (const node of nodes) byHandler.set(node.props.onPress, node);
  return [...byHandler.values()];
}

function pressable(
  renderer: Renderer,
  match: { label?: string | RegExp; testID?: string },
): Instance | null {
  const nodes = findPressables(renderer, match);
  return nodes.length ? nodes[nodes.length - 1]! : null;
}

async function press(node: Instance) {
  await act(async () => {
    node.props.onPress();
  });
  await settle();
}

function focusedMarker(renderer: Renderer): {
  name: string;
  params: unknown;
  back: Instance;
} | null {
  const boxes = renderer.root.findAll(
    node =>
      node.props.testID === 'route-box' &&
      node.props.accessibilityState?.selected === true,
  );
  const container = boxes[boxes.length - 1];
  if (!container) return null;
  const marker = container.findAll(n => n.props.testID === 'route-marker')[0];
  const params = container.findAll(n => n.props.testID === 'route-params')[0];
  const back = container.findAll(n => n.props.testID === 'route-back')[0];
  if (!marker || !params || !back) return null;
  return {
    name: textOf(marker),
    params: JSON.parse(textOf(params) || 'null') as unknown,
    back,
  };
}

interface Observation {
  screen: 'loading' | 'error' | 'content' | 'none';
  route: string;
  params: unknown;
  recent: string[];
  latestScore: string | null;
  chart: WeekChart | null;
  streak: string | null;
  bannerStreak: string | null;
  foldOut: boolean;
  notifCard: boolean;
  notifFailure: boolean;
  refreshing: boolean | null;
  errorCopy: string | null;
  pill: string | null;
  greeting: string | null;
  latestCount: string | null;
  markers: string[];
}

function observe(renderer: Renderer): Observation {
  const texts = allTexts(renderer);
  const marker = focusedMarker(renderer);
  const loading = texts.includes('Loading your court…');
  const errorTitle = texts.includes('Your court couldn’t load');
  const brand = renderer.root.findAll(
    n => n.props.testID === 'home-streak-badge',
  );
  const screen: Observation['screen'] = loading
    ? 'loading'
    : errorTitle
      ? 'error'
      : brand.length
        ? 'content'
        : 'none';
  const recent = findPressables(renderer, { label: /^Open .* result$/ }).map(
    node => `${node.props.accessibilityLabel}|${textOf(node)}`,
  );
  const scoresTab = pressable(renderer, { testID: 'home-week-chart-scores' });
  const readsTab = pressable(renderer, { testID: 'home-week-chart-reads' });
  const selected = (node: Instance | null) =>
    node?.props.accessibilityState?.selected === true;
  let chart: WeekChart | null = null;
  if (selected(scoresTab) && !selected(readsTab)) chart = 'scores';
  else if (selected(readsTab) && !selected(scoresTab)) chart = 'reads';
  const streakBadge = brand[brand.length - 1];
  const streak = streakBadge
    ? (textOf(streakBadge).match(/(\d+)/)?.[1] ?? null)
    : null;
  const bannerStreakNode = pressable(renderer, {
    testID: 'player-rank-banner-streak',
  });
  const bannerStreak = bannerStreakNode
    ? (String(bannerStreakNode.props.accessibilityLabel).match(
        /^(\d+) /,
      )?.[1] ?? null)
    : null;
  const latestIndex = texts.indexOf('Latest technique');
  let latestScore: string | null = null;
  if (latestIndex >= 0) {
    // The technique card renders: title, copy, score ('—' or n.n), then dupr.
    const after = texts.slice(latestIndex + 1, latestIndex + 6);
    latestScore = after.find(t => t === '—' || /^\d+\.\d$/.test(t)) ?? null;
  }
  const refresh = renderer.root.findAllByType(RefreshControl)[0];
  const latestCount = texts.find(t => /^\d+ latest$/.test(t)) ?? null;
  const markers = renderer.root
    .findAll(
      n => n.props.testID === 'route-marker' && typeof n.type === 'string',
    )
    .map(n => `${textOf(n)}${n.props.accessibilityState?.selected ? '*' : ''}`);
  return {
    markers,
    screen,
    route: marker ? marker.name : screen === 'none' ? 'unknown' : 'Home',
    params: marker ? marker.params : null,
    recent,
    latestScore,
    chart,
    streak,
    bannerStreak,
    foldOut:
      renderer.root.findAll(
        n => n.props.testID === 'player-rank-banner-fold-out',
      ).length > 0,
    notifCard:
      renderer.root.findAll(n => n.props.testID === 'notification-priming-card')
        .length > 0,
    notifFailure:
      renderer.root.findAll(
        n => n.props.testID === 'notification-priming-failure',
      ).length > 0,
    refreshing: refresh ? Boolean(refresh.props.refreshing) : null,
    errorCopy: errorTitle
      ? (texts[texts.indexOf('Your court couldn’t load') + 1] ?? null)
      : null,
    pill:
      texts.find(t => t === 'NEW PLAYER' || t.startsWith('SELF · ')) ?? null,
    greeting: texts.find(t => t.startsWith('Ready when you are')) ?? null,
    latestCount,
  };
}

// ---------------------------------------------------------------------------
// Invariant checks
// ---------------------------------------------------------------------------

class InvariantViolation extends Error {
  constructor(
    readonly invariant: string,
    detail: string,
  ) {
    super(`${invariant}: ${detail}`);
    this.name = 'InvariantViolation';
  }
}

function expectInvariant(invariant: string, ok: boolean, detail: () => string) {
  if (!ok) throw new InvariantViolation(invariant, detail());
}

function checkInvariants(
  model: Model,
  spec: WorldSpec,
  obs: Observation,
  consoleErrors: string[],
  rejections: string[],
) {
  expectInvariant(
    'I1.console',
    consoleErrors.length === 0,
    () => `console.error: ${consoleErrors.join(' || ')}`,
  );
  expectInvariant(
    'I1.rejection',
    rejections.length === 0,
    () => `unhandled rejection: ${rejections.join(' || ')}`,
  );

  // Route (I9)
  expectInvariant(
    'I9.route',
    obs.route === model.route,
    () =>
      `route ${obs.route} expected ${model.route} (markers ${obs.markers.join(
        ',',
      )})`,
  );
  if (model.route === 'Result') {
    expectInvariant(
      'I9.params',
      JSON.stringify(obs.params) === JSON.stringify(model.routeParams),
      () =>
        `Result params ${JSON.stringify(obs.params)} expected ${JSON.stringify(
          model.routeParams,
        )}`,
    );
  }

  // Screen lifecycle (I2/I3/I4). Home stays mounted under tabs/stack, so the
  // Home tree is always observable.
  const expectedScreen = modelScreen(model);
  expectInvariant(
    'I2.screen',
    obs.screen === expectedScreen,
    () => `screen ${obs.screen} expected ${expectedScreen}`,
  );
  if (expectedScreen === 'error') {
    expectInvariant(
      'I3.copy',
      obs.errorCopy === LOAD_ERROR_COPY,
      () => `error copy ${JSON.stringify(obs.errorCopy)}`,
    );
  }
  if (expectedScreen !== 'content') return;

  // Recent reads (I5)
  const expectedRecent = model.view
    .slice(0, 5)
    .map(
      shot =>
        `Open ${shot.shotType.replace(/_/g, ' ')} result|` +
        `${shot.score === null ? '—' : shot.score.toFixed(1)}`,
    );
  const observedRecent = obs.recent.map(entry => {
    const [label, body] = entry.split('|');
    const score = body?.match(/(—|\d+\.\d)(?!.*(—|\d+\.\d))/)?.[1] ?? '';
    return `${label}|${score}`;
  });
  expectInvariant(
    'I5.recent',
    JSON.stringify(observedRecent) === JSON.stringify(expectedRecent),
    () =>
      `recent ${JSON.stringify(observedRecent)} expected ${JSON.stringify(
        expectedRecent,
      )}`,
  );
  expectInvariant(
    'I5.count',
    (model.view.length === 0 && obs.latestCount === null) ||
      obs.latestCount === `${Math.min(5, model.view.length)} latest`,
    () => `latest count ${obs.latestCount} for ${model.view.length} shots`,
  );

  // Latest technique (I6)
  const latestScored = model.view.find(s => s.scored && s.score !== null);
  const expectedLatest = latestScored
    ? latestScored.score!.toFixed(1)
    : model.progressOk
      ? '6.3'
      : '—';
  expectInvariant(
    'I6.latest',
    obs.latestScore === expectedLatest,
    () => `latest technique ${obs.latestScore} expected ${expectedLatest}`,
  );

  // Week chart (I7)
  expectInvariant(
    'I7.chart',
    obs.chart === model.weekChart,
    () => `chart ${obs.chart} expected ${model.weekChart}`,
  );

  // Streak surfaces (I8)
  const storeStreak = String(
    useConsistencyStore.getState().snapshot?.currentStreak ?? 0,
  );
  expectInvariant(
    'I8.streak',
    obs.streak === storeStreak && obs.bannerStreak === storeStreak,
    () => `badge ${obs.streak} banner ${obs.bannerStreak} store ${storeStreak}`,
  );

  // Rank banner fold-out (I10)
  if (model.expanded) {
    expectInvariant(
      'I10.foldOut',
      obs.foldOut,
      () => 'expanded but no fold-out',
    );
  } else if (model.foldOutUntil === null) {
    expectInvariant(
      'I10.foldOut',
      !obs.foldOut,
      () => 'collapsed and fold-away elapsed but fold-out still mounted',
    );
  }

  // Notification card (I11)
  const notif = useNotificationStore.getState();
  const expectedCard =
    notif.hydrated &&
    !notif.prefs.enabled &&
    !notif.prefs.promptDismissed &&
    notif.permission !== 'denied';
  expectInvariant(
    'I11.card',
    obs.notifCard === expectedCard,
    () => `card ${obs.notifCard} expected ${expectedCard}`,
  );

  // Pull-to-refresh (I12)
  expectInvariant(
    'I12.refreshing',
    obs.refreshing === model.refreshing,
    () => `refreshing ${obs.refreshing} expected ${model.refreshing}`,
  );

  // Profile (I13)
  const expectedPill = spec.profile
    ? `SELF · ${spec.profile.skillLevel}`
    : 'NEW PLAYER';
  const expectedGreeting = spec.profile?.firstName
    ? `Ready when you are, ${spec.profile.firstName}.`
    : 'Ready when you are.';
  expectInvariant(
    'I13.profile',
    obs.pill === expectedPill && obs.greeting === expectedGreeting,
    () => `pill ${obs.pill} greeting ${obs.greeting}`,
  );
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface StepTrace {
  step: number;
  action: string;
  applied: boolean;
  now: number;
  obs: Omit<Observation, 'params'> & { params: string };
}

interface RunResult {
  seed: number;
  length: number;
  world: WorldSpec;
  actions: Action[];
  steps: StepTrace[];
  outcome: 'passed' | 'failed';
  failure: {
    step: number;
    action: string;
    invariant: string;
    message: string;
  } | null;
  fetchLog: string[];
}

function describeAction(action: Action): string {
  switch (action.kind) {
    case 'pressRecent':
      return `pressRecent[${action.index}]`;
    case 'pressChart':
      return `pressChart:${action.chart}`;
    case 'tab':
      return `tab:${action.tab}`;
    case 'insertShot':
      return `insertShot:${action.shot.scored ? 'scored' : 'low'}:${action.shot.shotType}:d${action.shot.daysAgo}`;
    case 'dbFault':
      return `dbFault:${action.on ? 'on' : 'off'}`;
    case 'fetchMode':
      return `fetchMode:${action.mode}`;
    case 'tick':
      return `tick:${action.ms}`;
    default:
      return action.kind;
  }
}

function resetStores(spec: WorldSpec) {
  useAppStore.setState({
    hydrated: true,
    ownerKey: spec.owner === 'guest' ? GUEST_DATA_OWNER : CANONICAL_USER_ID,
    profile: spec.profile
      ? {
          ...(spec.profile.firstName
            ? { firstName: spec.profile.firstName }
            : {}),
          skillLevel: spec.profile.skillLevel,
          handedness: 'right',
          goal: 'dinks',
          biggestProblem: 'consistency',
          focusCheckpoint: spec.profile.focusCheckpoint as
            'contact_position' | 'preparation',
        }
      : null,
    hydrateError: null,
  });
  useConsistencyStore.setState({
    hydrated: false,
    ownerKey: null,
    snapshot: null,
    loadError: false,
    celebration: null,
    daySecured: null,
  });
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
    persistFailed: false,
    scheduleFailed: false,
  });
  useRankCelebrationStore.setState({ current: null, pending: null });
}

async function bootStores() {
  // Mirrors App.tsx bootstraps: useNotificationBootstrap/useConsistencyBootstrap.
  await act(async () => {
    await useConsistencyStore.getState().hydrate();
    await useNotificationStore.getState().hydrate();
  });
}

async function mountShell(): Promise<Renderer> {
  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(<Shell />);
  });
  await settle();
  return renderer;
}

async function runPlan(plan: Plan): Promise<RunResult> {
  const { seed, world: spec, actions } = plan;
  const consoleErrors: string[] = [];
  const rejections: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(a => String(a)).join(' '));
  };
  const onRejection = (reason: unknown) => {
    rejections.push(String(reason));
  };
  process.on('unhandledRejection', onRejection);

  jest.setSystemTime(new Date(FIXED_NOW_ISO));
  jest.clearAllTimers();
  world.fetchMode = spec.fetchMode;
  world.fetchLog = [];
  mockSqlite.fault = false;
  mockSqlite.real = new DatabaseSync(':memory:');

  notifee.getNotificationSettings.mockImplementation(async () => ({
    authorizationStatus: spec.initialPermission,
  }));
  notifee.requestPermission.mockImplementation(async () => {
    if (spec.notif === 'throws') throw new Error('notification module down');
    return { authorizationStatus: spec.notif === 'granted' ? 1 : 0 };
  });

  const authStore = useAuthStore as unknown as {
    setState: (partial: Record<string, unknown>) => void;
  };
  if (spec.owner === 'guest') {
    setActiveDataOwner(GUEST_DATA_OWNER);
    clearApiSession();
    clearAccessStoreConfiguration();
    authStore.setState({
      session: {
        provider: 'guest',
        localOnly: true,
        subject: 'guest',
        canonicalAppUserId: null,
        displayName: null,
        email: null,
      },
    });
  } else {
    setActiveDataOwner(CANONICAL_USER_ID);
    establishApiSession({
      apiBaseUrl: API_BASE_URL,
      bearerToken: 'stress-bearer',
      canonicalAppUserId: CANONICAL_USER_ID,
      provider: 'apple',
    });
    configureAccessStore(
      billingDependencies(
        spec.access === 'free' ? freeAccess : exhaustedAccess,
      ),
    );
    authStore.setState({
      session: {
        provider: 'apple',
        localOnly: false,
        subject: 'apple-subject',
        canonicalAppUserId: CANONICAL_USER_ID,
        displayName: 'Stress Tester',
        email: null,
      },
    });
  }

  const model: Model = {
    shots: [],
    kvChart: spec.kvChart,
    dbFault: false,
    session: spec.owner === 'canonical',
    mountId: 1,
    loaded: false,
    loadError: false,
    view: [],
    weekChart: 'scores',
    progressOk: false,
    expanded: false,
    foldOutUntil: null,
    refreshing: false,
    inFlight: [],
    homeFocused: true,
    route: 'Home',
    routeParams: null,
  };

  const steps: StepTrace[] = [];
  let renderer: Renderer | null = null;
  let failure: RunResult['failure'] = null;

  const record = (step: number, action: string, applied: boolean) => {
    if (!renderer) return;
    const obs = observe(renderer);
    steps.push({
      step,
      action,
      applied,
      now: now() - new Date(FIXED_NOW_ISO).getTime(),
      obs: { ...obs, params: JSON.stringify(obs.params) },
    });
  };

  try {
    // Seed the world through the production repository.
    for (const shot of spec.shots) {
      await persistShot(shot);
      model.shots.push({
        id: shot.id,
        shotType: shot.shotType,
        capturedAt: shotCapturedAt(shot),
        score: shot.score,
        scored: shot.scored,
      });
    }
    if (spec.kvChart !== null) {
      await setKv(getDb(), WEEK_CHART_KV_KEY, spec.kvChart);
    }
    resetStores(spec);
    await bootStores();

    renderer = await mountShell();
    modelTriggerLoad(model, false, world.fetchMode);
    modelSettle(model);
    record(0, 'mount', true);
    checkInvariants(model, spec, observe(renderer), consoleErrors, rejections);

    for (let i = 0; i < actions.length; i += 1) {
      const action = actions[i]!;
      const label = describeAction(action);
      let applied = true;
      const screen = modelScreen(model);
      const onHomeContent = model.route === 'Home' && screen === 'content';
      switch (action.kind) {
        case 'pressStreakBadge':
        case 'pressRankStreak': {
          const node = onHomeContent
            ? pressable(renderer, {
                testID:
                  action.kind === 'pressStreakBadge'
                    ? 'home-streak-badge'
                    : 'player-rank-banner-streak',
              })
            : null;
          if (!node) {
            applied = false;
            break;
          }
          await press(node);
          model.route = 'StreakCalendar';
          model.routeParams = null;
          break;
        }
        case 'pressRankToggle': {
          const node = onHomeContent
            ? pressable(renderer, { testID: 'player-rank-banner-toggle' })
            : null;
          if (!node) {
            applied = false;
            break;
          }
          await press(node);
          model.expanded = !model.expanded;
          model.foldOutUntil = model.expanded ? null : now() + FOLD_AWAY_MS;
          break;
        }
        case 'pressAnalyze': {
          const node = onHomeContent
            ? pressable(renderer, {
                label:
                  'Stroke Analysis. Analyze one movement with fast, detailed feedback.',
              })
            : null;
          if (!node) {
            applied = false;
            break;
          }
          await press(node);
          if (spec.owner === 'guest') model.route = 'ConnectAccount';
          else if (spec.access === 'exhausted') model.route = 'Paywall';
          else model.route = 'Analyze';
          model.routeParams = null;
          break;
        }
        case 'pressDrills': {
          const node = onHomeContent
            ? pressable(renderer, {
                label: 'Drill Library. Guided drills you can search.',
              })
            : null;
          if (!node) {
            applied = false;
            break;
          }
          await press(node);
          model.route = 'DrillLibrary';
          model.routeParams = null;
          break;
        }
        case 'pressRecent': {
          const cards = onHomeContent
            ? findPressables(renderer, { label: /^Open .* result$/ })
            : [];
          const node = cards[action.index];
          if (!node) {
            applied = false;
            break;
          }
          await press(node);
          const target = model.view[action.index];
          model.route = 'Result';
          model.routeParams = { analysisId: target?.id ?? null };
          break;
        }
        case 'pressChart': {
          const node = onHomeContent
            ? pressable(renderer, { testID: `home-week-chart-${action.chart}` })
            : null;
          if (!node) {
            applied = false;
            break;
          }
          await press(node);
          model.weekChart = action.chart;
          if (!model.dbFault) model.kvChart = action.chart;
          break;
        }
        case 'notifTurnOn':
        case 'notifNotNow': {
          const node = onHomeContent
            ? pressable(renderer, {
                label:
                  action.kind === 'notifTurnOn'
                    ? 'Turn on practice reminders'
                    : 'Not now',
              })
            : null;
          if (!node || node.props.disabled) {
            applied = false;
            break;
          }
          await press(node);
          break;
        }
        case 'pullRefresh': {
          const control = onHomeContent
            ? renderer.root.findAllByType(RefreshControl)[0]
            : undefined;
          if (!control) {
            applied = false;
            break;
          }
          await act(async () => {
            control.props.onRefresh();
          });
          modelTriggerLoad(model, true, world.fetchMode);
          await settle();
          break;
        }
        case 'retry': {
          const node =
            model.route === 'Home' && screen === 'error'
              ? pressable(renderer, { label: 'Try again' })
              : null;
          if (!node) {
            applied = false;
            break;
          }
          await act(async () => {
            node.props.onPress();
          });
          model.loaded = false;
          model.loadError = false;
          model.expanded = false;
          model.foldOutUntil = null;
          modelTriggerLoad(model, false, world.fetchMode);
          await settle();
          break;
        }
        case 'back': {
          const marker = focusedMarker(renderer);
          if (!marker || model.route === 'Home') {
            applied = false;
            break;
          }
          const tabRoutes = ['Library', 'Performance', 'Settings'];
          await press(marker.back);
          if (tabRoutes.includes(marker.name)) {
            // Tabs: goBack from a tab returns to the first tab (Home) only
            // when history allows; the navigator decides — observe it.
            const after = focusedMarker(renderer);
            if (after) {
              model.route = after.name;
              applied = true;
              break;
            }
          }
          model.route = 'Home';
          model.routeParams = null;
          modelTriggerLoad(model, false, world.fetchMode);
          await settle();
          break;
        }
        case 'tab': {
          const inTabs = [
            'Home',
            'Library',
            'Performance',
            'Settings',
          ].includes(model.route);
          const node = inTabs
            ? pressable(renderer, { label: action.tab })
            : null;
          if (!node) {
            applied = false;
            break;
          }
          const targetRoute =
            action.tab === 'Progress' ? 'Performance' : action.tab;
          const wasHome = model.route === 'Home';
          await press(node);
          model.route = targetRoute;
          model.routeParams = null;
          if (targetRoute === 'Home' && !wasHome) {
            modelTriggerLoad(model, false, world.fetchMode);
            await settle();
          }
          break;
        }
        case 'insertShot': {
          try {
            await act(async () => {
              await persistShot(action.shot);
            });
            model.shots.push({
              id: action.shot.id,
              shotType: action.shot.shotType,
              capturedAt: shotCapturedAt(action.shot),
              score: action.shot.score,
              scored: action.shot.scored,
            });
          } catch {
            applied = false;
          }
          await settle();
          break;
        }
        case 'dbFault':
          mockSqlite.fault = action.on;
          model.dbFault = action.on;
          break;
        case 'fetchMode':
          world.fetchMode = action.mode;
          break;
        case 'tick':
          await advance(action.ms);
          break;
        case 'relaunch': {
          await act(async () => {
            renderer?.unmount();
          });
          jest.clearAllTimers();
          model.inFlight = [];
          model.mountId += 1;
          model.loaded = false;
          model.loadError = false;
          model.expanded = false;
          model.foldOutUntil = null;
          model.refreshing = false;
          model.route = 'Home';
          model.routeParams = null;
          model.progressOk = false;
          resetStores(spec);
          await bootStores();
          renderer = await mountShell();
          modelTriggerLoad(model, false, world.fetchMode);
          break;
        }
        default:
          applied = false;
      }
      await settle();
      modelSettle(model);
      record(i + 1, label, applied);
      checkInvariants(
        model,
        spec,
        observe(renderer),
        consoleErrors,
        rejections,
      );
    }
  } catch (error) {
    const step = steps.length ? steps[steps.length - 1]!.step : -1;
    const action = steps.length ? steps[steps.length - 1]!.action : 'setup';
    const invariant =
      error instanceof InvariantViolation ? error.invariant : 'I1.throw';
    failure = {
      step: step + (error instanceof InvariantViolation ? 0 : 1),
      action,
      invariant,
      message:
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
    };
  } finally {
    try {
      await act(async () => {
        renderer?.unmount();
      });
    } catch {
      // Unmount failures are reported through the failure record already.
    }
    jest.clearAllTimers();
    try {
      getDb().close();
    } catch {
      // No open handle.
    }
    mockSqlite.real?.close();
    mockSqlite.real = null;
    mockSqlite.fault = false;
    clearApiSession();
    clearAccessStoreConfiguration();
    process.off('unhandledRejection', onRejection);
    console.error = originalError;
    // jest.fn bookkeeping (mock.calls/contexts of every mocked component)
    // would otherwise retain every rendered tree across 2000 sequences.
    jest.clearAllMocks();
  }

  return {
    seed,
    length: actions.length,
    world: spec,
    actions,
    steps,
    outcome: failure ? 'failed' : 'passed',
    failure,
    fetchLog: world.fetchLog,
  };
}

// ---------------------------------------------------------------------------
// Minimization (ddmin over the action list, same world)
// ---------------------------------------------------------------------------

async function minimize(
  plan: Plan,
  invariant: string,
): Promise<{
  actions: Action[];
  attempts: number;
  reproduced: boolean;
}> {
  let current = plan.actions;
  let attempts = 0;
  const budget = 48;
  const fails = async (actions: Action[]) => {
    attempts += 1;
    const result = await runPlan({ ...plan, actions });
    return result.failure !== null && result.failure.invariant === invariant;
  };
  // Confirm reproducibility first (a flaky seed is reported as such).
  const reproduced = await fails(current);
  if (!reproduced) return { actions: current, attempts, reproduced: false };
  let n = 2;
  while (current.length >= 2 && attempts < budget) {
    const chunk = Math.ceil(current.length / n);
    let reduced = false;
    for (
      let start = 0;
      start < current.length && attempts < budget;
      start += chunk
    ) {
      const candidate = [
        ...current.slice(0, start),
        ...current.slice(start + chunk),
      ];
      if (candidate.length === 0) continue;
      if (await fails(candidate)) {
        current = candidate;
        n = Math.max(n - 1, 2);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (n >= current.length) break;
      n = Math.min(n * 2, current.length);
    }
  }
  return { actions: current, attempts, reproduced: true };
}

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------

const ITER = Number(process.env.STRESS_ITER ?? 40);
const BASE_SEED = Number(process.env.STRESS_SEED ?? 20260904);
const REPLAY = process.env.STRESS_REPLAY
  ? Number(process.env.STRESS_REPLAY)
  : null;
const REPLAY_EVERY = Number(process.env.STRESS_REPLAY_EVERY ?? 1);
const [SHARD_INDEX, SHARD_COUNT] = (process.env.STRESS_SHARD ?? '0/1')
  .split('/')
  .map(Number) as [number, number];
const OUT_DIR =
  process.env.STRESS_OUT ?? join(__dirname, '..', '..', 'artifacts', 'stress');

const seeds: number[] = [];
if (REPLAY !== null) {
  seeds.push(REPLAY);
} else {
  for (let i = 0; i < ITER; i += 1) {
    if (i % SHARD_COUNT === SHARD_INDEX) seeds.push(BASE_SEED + i);
  }
}

interface TableRow {
  seed: number;
  length: number;
  applied: number;
  owner: OwnerMode;
  fetchMode: FetchMode;
  outcome: 'passed' | 'failed';
  deterministic: boolean | null;
  failure: RunResult['failure'];
  minimized: {
    actions: string[];
    attempts: number;
    reproduced: boolean;
  } | null;
  fetchCalls: number;
  heapMB: number;
}

const table: TableRow[] = [];
const traceLines: string[] = [];
const failureDetails: Array<{
  seed: number;
  world: WorldSpec;
  actions: Action[];
  minimizedActions: Action[];
  trace: StepTrace[];
  failure: RunResult['failure'];
}> = [];

function heapUsedMB(): number {
  const maybeGc = (globalThis as { gc?: () => void }).gc;
  if (typeof maybeGc === 'function') maybeGc();
  return Math.round(process.memoryUsage().heapUsed / 1048576);
}

function stripTrace(steps: StepTrace[]): string[] {
  return steps.map(
    step =>
      `${step.step}:${step.action}:${step.applied ? 'a' : 's'}:@${step.now}:` +
      JSON.stringify(step.obs),
  );
}

jest.useFakeTimers();

beforeAll(() => {
  installFetch();
});

afterAll(() => {
  mkdirSync(OUT_DIR, { recursive: true });
  const suffix =
    REPLAY !== null
      ? `replay-${REPLAY}`
      : SHARD_COUNT > 1
        ? `shard-${SHARD_INDEX}-of-${SHARD_COUNT}`
        : 'all';
  const summary = {
    unit: 'scr-homescreen',
    lens: 'randomized-seeded',
    baseSeed: BASE_SEED,
    iterations: table.length,
    passed: table.filter(row => row.outcome === 'passed').length,
    failed: table.filter(row => row.outcome === 'failed').length,
    nonDeterministic: table.filter(row => row.deterministic === false).length,
    stepsExecuted: table.reduce((sum, row) => sum + row.length + 1, 0),
    actionsApplied: table.reduce((sum, row) => sum + row.applied, 0),
    lengthMin: Math.min(...table.map(row => row.length)),
    lengthMax: Math.max(...table.map(row => row.length)),
    rows: table,
  };
  writeFileSync(
    join(OUT_DIR, `homescreen-randomized-seeded-${suffix}.json`),
    JSON.stringify(summary, null, 2),
  );
  writeFileSync(
    join(OUT_DIR, `homescreen-randomized-seeded-${suffix}-traces.jsonl`),
    traceLines.join('\n') + '\n',
  );
  if (failureDetails.length) {
    writeFileSync(
      join(OUT_DIR, `homescreen-randomized-seeded-${suffix}-failures.json`),
      JSON.stringify(failureDetails, null, 2),
    );
  }
});

describe(`HomeScreen seeded randomized long-run (${seeds.length} sequences)`, () => {
  for (const seed of seeds) {
    it(`seed ${seed}: invariants I1–I14 hold across every step`, async () => {
      const plan = generatePlan(seed);
      const first = await runPlan(plan);
      let deterministic: boolean | null = null;
      let replayDiff: string | null = null;
      if ((seed - BASE_SEED) % REPLAY_EVERY === 0 || first.failure) {
        const second = await runPlan(plan);
        const a = stripTrace(first.steps);
        const b = stripTrace(second.steps);
        deterministic =
          a.length === b.length &&
          a.every((line, index) => line === b[index]) &&
          JSON.stringify(first.failure) === JSON.stringify(second.failure);
        if (!deterministic) {
          const index = a.findIndex((line, i) => line !== b[i]);
          replayDiff = `first divergence at step ${index}: ${a[index] ?? '(end)'} vs ${
            b[index] ?? '(end)'
          }`;
        }
      }
      let minimized: TableRow['minimized'] = null;
      if (first.failure) {
        const result = await minimize(plan, first.failure.invariant);
        minimized = {
          actions: result.actions.map(describeAction),
          attempts: result.attempts,
          reproduced: result.reproduced,
        };
        failureDetails.push({
          seed,
          world: plan.world,
          actions: plan.actions,
          minimizedActions: result.actions,
          trace: first.steps,
          failure: first.failure,
        });
      }
      traceLines.push(
        JSON.stringify({
          seed,
          world: plan.world,
          outcome: first.outcome,
          deterministic,
          trace: stripTrace(first.steps),
        }),
      );
      table.push({
        seed,
        length: first.length,
        applied: first.steps.filter(step => step.applied).length,
        owner: plan.world.owner,
        fetchMode: plan.world.fetchMode,
        outcome: first.outcome,
        deterministic,
        failure: first.failure,
        minimized,
        fetchCalls: first.fetchLog.length,
        heapMB: heapUsedMB(),
      });
      if (first.failure) {
        throw new Error(
          `seed ${seed} step ${first.failure.step} (${first.failure.action}) ` +
            `${first.failure.invariant} — ${first.failure.message}` +
            (minimized
              ? `\nminimized (${minimized.actions.length} actions, ${minimized.attempts} attempts, ` +
                `reproduced=${minimized.reproduced}): ${minimized.actions.join(' → ')}`
              : ''),
        );
      }
      if (deterministic === false) {
        throw new Error(`seed ${seed} I14 determinism: ${replayDiff}`);
      }
      expect(first.steps.length).toBe(plan.actions.length + 1);
    });
  }
});
