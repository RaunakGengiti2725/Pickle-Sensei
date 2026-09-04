/**
 * STRESS · scr-resultdetailsscreen · lens `lifecycle`
 *
 * ResultDetailsScreen rendered inside the REAL RootNavigator (real
 * NavigationContainer, native-stack and bottom-tabs), with the real
 * ResultScreen evidence hook, the real repository over a real SQLite
 * database (node:sqlite standing in for the op-sqlite native module), the
 * real training store + training API and the real in-memory ApiSession.
 * Only native seams are doubled: op-sqlite, safe-area, svg, gradients,
 * Google Sign-In, the notification bridge, AppState and `fetch`.
 *
 * Every asynchronous boundary the screen crosses (each SQLite `execute`,
 * each `fetch`, each pose-sidecar artifact read) is captured as a pending
 * operation whose delivery order is chosen by a SEEDED schedule. Between
 * deliveries the schedule interleaves lifecycle interruptions:
 *
 *   - background / foreground (AppState change events)
 *   - unmount mid-request (back, popToTop, params change on the live route)
 *   - kill / relaunch (root unmount, db handle closed, in-memory stores
 *     reset, session re-established from the "vault", remount, re-navigate)
 *   - cancel mid-flight (route params change while evidence is loading)
 *   - token rotation mid-request (a request in flight bears the previous
 *     bearer; the server answers it 401 exactly as an expired token would)
 *   - account switch / sign-out (Gate semantics: navigator unmounted while
 *     the owner changes, then remounted for the new owner)
 *   - permission revoke-later (the sidecar artifact read starts failing)
 *
 * Invariants checked after every iteration settles:
 *   I1  the breakdown never shows another owner's evidence — a deep link to
 *       owner A's analysis under owner B renders "Result missing";
 *   I2  the training store never holds another owner's plan, and never
 *       stays `loading` once every request was delivered;
 *   I3  a 401 for a bearer that was rotated away never signs the user out;
 *   I4  kill / relaunch re-hydrates to the identical rendered text and does
 *       not duplicate rows (idempotent re-hydrate);
 *   I5  after the final unmount no timers, AppState listeners or
 *       notification subscriptions remain; no pending operation is left
 *       uncancelled and no React/RN error was logged;
 *   I6  no render/effect ever threw.
 *
 * Replay: `STRESS_SEED=<n> npx jest --ci __tests__/stress/resultDetailsScreen.lifecycle`
 * Scale:  `STRESS_ITER=<n>` (default 12; the campaign in the report ran 120)
 * Table:  `STRESS_OUT=/abs/path.json` writes the seed → outcome table.
 * Leaks:  add `--detectOpenHandles`.
 */

// ─── Native seams ───────────────────────────────────────────────────────────

// apps/mobile types only `jest` (no @types/node): declare the exact Node
// surface this harness drives, as the other node:sqlite suites do.
declare const require: (id: string) => unknown;

interface SqliteStatement {
  all(...params: (string | number | null)[]): Record<string, unknown>[];
}
interface DatabaseSync {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (location: string) => DatabaseSync;
};
const fs = require('fs') as {
  writeFileSync: (p: string, data: string) => void;
  mkdirSync: (p: string, options: { recursive: true }) => void;
};
const path = require('path') as {
  dirname: (p: string) => string;
};

type SettleMode = 'ok' | 'network-error';

interface PendingOp {
  id: number;
  kind: 'db' | 'fetch' | 'artifact';
  label: string;
  /** Owner/bearer captured when the request was issued (fetch only). */
  bearer: string | null;
  settle: (mode: SettleMode) => void;
}

// One mutable "device" per test file: the SQLite file survives every
// kill / relaunch and account switch, exactly like the real store.
// (`mock` prefix: referenced from hoisted jest.mock factories.)
const mockDevice = {
  sqlite: null as DatabaseSync | null,
  pending: [] as PendingOp[],
  nextOpId: 1,
  /** While seeding, deliver synchronously so fixtures land in order. */
  immediate: true,
  dbOpens: 0,
  dbCloses: 0,
  artifactRevoked: false,
  artifactBytes: '',
};

function mockToSqlParams(params: unknown[]): (string | number | null)[] {
  return params.map(value => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'number' || typeof value === 'string') return value;
    return JSON.stringify(value);
  });
}

function mockEnqueue<T>(
  kind: PendingOp['kind'],
  label: string,
  bearer: string | null,
  produce: (mode: SettleMode) => T,
): Promise<T> {
  if (mockDevice.immediate) {
    return Promise.resolve().then(() => produce('ok'));
  }
  return new Promise<T>((resolve, reject) => {
    mockDevice.pending.push({
      id: mockDevice.nextOpId++,
      kind,
      label,
      bearer,
      settle: mode => {
        try {
          resolve(produce(mode));
        } catch (error) {
          reject(error);
        }
      },
    });
  });
}

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    if (!mockDevice.sqlite) {
      throw new Error('harness did not open a database');
    }
    const real = mockDevice.sqlite;
    mockDevice.dbOpens += 1;
    return {
      executeSync: (sql: string) => ({ rows: real.prepare(sql).all() }),
      execute: (sql: string, params: unknown[] = []) => {
        // Statements run at issue time (SQLite serializes them on-device);
        // only the DELIVERY of the result is deferred to the schedule.
        const rows = real.prepare(sql).all(...mockToSqlParams(params));
        return mockEnqueue(
          'db',
          sql.trim().split(/\s+/).slice(0, 4).join(' '),
          null,
          () => ({ rows }),
        );
      },
      close: () => {
        mockDevice.dbCloses += 1;
      },
    };
  },
}));

jest.mock('react-native-safe-area-context', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const inset = { top: 0, right: 0, bottom: 0, left: 0 };
  const frame = { x: 0, y: 0, width: 390, height: 844 };
  return {
    SafeAreaProvider: (props: { children?: React.ReactNode }) =>
      React.createElement(View, null, props.children),
    SafeAreaView: (props: { children?: React.ReactNode; testID?: string }) =>
      React.createElement(View, { testID: props.testID }, props.children),
    SafeAreaInsetsContext: React.createContext(inset),
    SafeAreaFrameContext: React.createContext(frame),
    useSafeAreaInsets: () => inset,
    useSafeAreaFrame: () => frame,
    initialWindowMetrics: { insets: inset, frame },
  };
});
jest.mock('react-native-svg', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Defs: Mock,
    G: Mock,
    Line: Mock,
    Path: Mock,
    Polygon: Mock,
    Polyline: Mock,
    RadialGradient: Mock,
    LinearGradient: Mock,
    Rect: Mock,
    Stop: Mock,
  };
});
jest.mock('react-native-linear-gradient', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: jest.fn(),
    hasPlayServices: jest.fn(async () => true),
    signIn: jest.fn(),
    signInSilently: jest.fn(),
    hasPreviousSignIn: jest.fn(() => false),
    signOut: jest.fn(async () => {}),
    revokeAccess: jest.fn(async () => {}),
  },
}));
jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: 'stress-web-client.apps.googleusercontent.com',
  GOOGLE_IOS_CLIENT_ID: 'stress-ios-client.apps.googleusercontent.com',
}));
const API_BASE = 'https://api.stress.test';
jest.mock('../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.stress.test',
    revenueCatPublicSdkKey: null,
    googleIosClientId: 'stress-ios-client.apps.googleusercontent.com',
    googleWebClientId: 'stress-web-client.apps.googleusercontent.com',
    appVersion: '1.0.0',
    legalPrivacyUrl: null,
    legalTermsUrl: null,
  }),
}));

// Notification bridge (native): count live press subscriptions so a leaked
// navigator subscription is visible after unmount.
const mockNotificationSubscriptions = { live: 0, total: 0 };
jest.mock('../../src/notifications/service', () => ({
  subscribeToNotificationPresses: () => {
    mockNotificationSubscriptions.live += 1;
    mockNotificationSubscriptions.total += 1;
    return () => {
      mockNotificationSubscriptions.live -= 1;
    };
  },
}));

// `readCaptureArtifact` is the native file read behind the pose sidecar —
// the one bridge call the details screen makes. "Permission revoked later"
// flips it to rejecting after it has already succeeded once.
jest.mock('../../src/camera/capture', () => {
  const actual = jest.requireActual<Record<string, unknown>>(
    '../../src/camera/capture',
  );
  return {
    ...actual,
    readCaptureArtifact: (uri: string) =>
      mockEnqueue('artifact', `readCaptureArtifact ${uri}`, null, () => {
        if (mockDevice.artifactRevoked) {
          throw new Error('EACCES: file access revoked');
        }
        return mockDevice.artifactBytes;
      }),
  };
});

// Screens that are not under test: inert stubs (they pull camera, billing
// and other native surfaces). HomeScreen doubles as the navigation probe so
// the harness drives the REAL navigator the way a user's taps would.
const mockProbe: { navigation: NavigationLike | null } = { navigation: null };
interface NavigationLike {
  navigate(name: string, params?: Record<string, unknown>): void;
  goBack(): void;
  popToTop(): void;
  popTo(name: string, params?: Record<string, unknown>): void;
  canGoBack(): boolean;
  getState(): { routes: { name: string; params?: unknown }[] };
}
jest.mock('../../src/screens/HomeScreen', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { Text } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const { useNavigation } = jest.requireActual<
    typeof import('@react-navigation/native')
  >('@react-navigation/native');
  return {
    HomeScreen: () => {
      mockProbe.navigation = useNavigation() as unknown as NavigationLike;
      return React.createElement(Text, { testID: 'stub-home' }, 'Home');
    },
  };
});
function mockStubScreen(exportName: string) {
  const React = jest.requireActual<typeof import('react')>('react');
  const { Text } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    [exportName]: () =>
      React.createElement(Text, { testID: `stub-${exportName}` }, exportName),
  };
}
jest.mock('../../src/screens/LibraryScreen', () =>
  mockStubScreen('LibraryScreen'),
);
jest.mock('../../src/screens/ProgressScreen', () =>
  mockStubScreen('ProgressScreen'),
);
jest.mock('../../src/screens/SettingsScreen', () =>
  mockStubScreen('SettingsScreen'),
);
jest.mock('../../src/screens/AnalyzeScreen', () =>
  mockStubScreen('AnalyzeScreen'),
);
jest.mock('../../src/screens/DrillLibraryScreen', () =>
  mockStubScreen('DrillLibraryScreen'),
);
jest.mock('../../src/screens/FormReviewScreen', () =>
  mockStubScreen('FormReviewScreen'),
);
jest.mock('../../src/screens/StreakCalendarScreen', () =>
  mockStubScreen('StreakCalendarScreen'),
);
jest.mock('../../src/screens/PaywallScreen', () =>
  mockStubScreen('PaywallScreen'),
);
jest.mock('../../src/screens/SignInScreen', () =>
  mockStubScreen('SignInScreen'),
);
jest.mock('../../src/screens/ManageAccountScreen', () =>
  mockStubScreen('ManageAccountScreen'),
);
jest.mock('../../src/screens/ConsentSettingsScreen', () =>
  mockStubScreen('ConsentSettingsScreen'),
);
jest.mock('../../src/screens/NotificationSettingsScreen', () =>
  mockStubScreen('NotificationSettingsScreen'),
);
jest.mock('../../src/navigation/PremiumTabBar', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    PremiumTabBar: () => React.createElement(View, { testID: 'stub-tab-bar' }),
  };
});

// ─── Imports (after the hoisted mocks) ──────────────────────────────────────

import React from 'react';
import { AppState, Text } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import type {
  CheckpointKey,
  CheckpointScore,
  FaultDirection,
  PhaseKey,
  PhaseSpan,
  ScoreBand,
  ShotAnalysis,
} from '@pickle/shared-types';
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import { RootNavigator } from '../../src/navigation/RootNavigator';
import { ResultDetailsScreen } from '../../src/screens/ResultDetailsScreen';
import { LoadingState } from '../../src/design/components';
import { getDb } from '../../src/data/db';
import { saveAnalysis, savePendingCapture } from '../../src/data/repository';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  clearApiSession,
  establishApiSession,
  getApiSession,
  bearerTokenFor,
  setApiUnauthorizedListener,
} from '../../src/account/apiSession';
import { assertCapturedClip } from '../../src/camera/capture';
import { createTrainingApi } from '../../src/training/api';
import {
  clearTrainingStoreConfiguration,
  configureTrainingStore,
  useTrainingStore,
} from '../../src/training/store';
import { clearTryAgainHandoff } from '../../src/screens/tryAgainHandoff';

// ─── Seeded RNG (mulberry32) ────────────────────────────────────────────────

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
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

// ─── Two owners on one device ───────────────────────────────────────────────

interface OwnerFixture {
  name: 'alpha' | 'beta';
  canonicalAppUserId: string;
  owner: string;
  analysisId: string;
  /** Second attempt of the same session (renders attempt chips). */
  attemptId: string;
  sessionId: string;
  captureId: string;
  overallScore: number;
  /**
   * Per-owner contact_position checkpoint score. The breakdown renders it
   * verbatim ("Contact position scored N"), so it is the on-screen proof of
   * WHOSE analysis is showing; the overall score is not rendered there.
   */
  contactScore: number;
  /** Server-side plan marker rendered by the training section. */
  planMarker: string;
  bearerSerial: number;
}

const owners: Record<'alpha' | 'beta', OwnerFixture> = {
  alpha: {
    name: 'alpha',
    canonicalAppUserId: 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa',
    owner: canonicalDataOwner('aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa'),
    analysisId: '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a01',
    attemptId: '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a02',
    sessionId: 'set-alpha',
    captureId: 'capture-alpha',
    overallScore: 7.1,
    contactScore: 48,
    planMarker: 'alpha_plan_marker',
    bearerSerial: 0,
  },
  beta: {
    name: 'beta',
    canonicalAppUserId: 'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb',
    owner: canonicalDataOwner('bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb'),
    analysisId: '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b01',
    attemptId: '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b02',
    sessionId: 'set-beta',
    captureId: 'capture-beta',
    overallScore: 3.4,
    contactScore: 27,
    planMarker: 'beta_plan_marker',
    bearerSerial: 0,
  },
};
const otherOf = (owner: OwnerFixture): OwnerFixture =>
  owner.name === 'alpha' ? owners.beta : owners.alpha;

function phase(
  key: PhaseKey,
  startMs: number,
  endMs: number,
  representativeMs = startMs + (endMs - startMs) / 2,
): PhaseSpan {
  return { key, startMs, representativeMs, endMs, confidence: 0.8 };
}
function checkpoint(
  key: CheckpointKey,
  score: number | null,
  band: ScoreBand,
  direction: FaultDirection,
  overrides: Partial<CheckpointScore> = {},
): CheckpointScore {
  return {
    key,
    score,
    confidence: 0.8,
    band,
    direction,
    severity: score === null ? 0 : (100 - score) / 100,
    applicable: true,
    ...overrides,
  };
}

function analysisFor(
  owner: OwnerFixture,
  id: string,
  capturedAtIso: string,
): ShotAnalysis {
  return {
    id,
    sessionId: owner.sessionId,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso,
    timestamps: { startMs: 0, contactMs: 1900, endMs: 3200 },
    phases: [
      phase('ready', 0, 900),
      phase('prepare', 900, 1500),
      phase('accelerate', 1500, 1900),
      phase('contact', 1880, 1920, 1900),
      phase('follow_through', 1920, 2400),
      phase('recover', 2400, 3200),
    ],
    measurements: [],
    checkpoints: [
      checkpoint('ready_position', 85, 'green', 'none'),
      checkpoint('athletic_base', 72, 'yellow', 'narrow'),
      checkpoint('preparation', 88, 'green', 'none'),
      checkpoint('paddle_set', 90, 'green', 'none'),
      checkpoint('swing_length', null, 'unscored', 'none'),
      checkpoint('sequencing', 82, 'green', 'none'),
      checkpoint('paddle_path', 61, 'red', 'low'),
      checkpoint('contact_position', owner.contactScore, 'red', 'late'),
      checkpoint('face_wrist_stability', 30, 'red', 'unstable', {
        applicable: false,
      }),
      checkpoint('follow_through', 80, 'green', 'short'),
      checkpoint('recovery', 92, 'green', 'none'),
    ],
    overallScore: owner.overallScore,
    analysisConfidence: 0.84,
    resultKind: 'scored',
    guidance: null,
    priorityFix: {
      checkpoint: 'contact_position',
      reasonKey: 'lowest_score',
      severity: 0.52,
      confidence: 0.8,
    },
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'on-device-fusion-1',
      poseModelVersion: 'apple-vision-bodypose-1',
      paddleModelVersion: 'none',
      strokeDetectorVersion: 'temporal-stroke-heuristic-2',
      phaseModelVersion: 'phase-geometry-1',
      scoringModelVersion: 'sm-v1',
      shotConfigVersion: 'forehand_drive@1',
    },
    source: 'real',
  };
}

function poseSidecarJson(): { json: string; frameCount: number } {
  const { sequence } = generateSwingSequence();
  return {
    json: serializePoseSequence(sequence),
    frameCount: sequence.frames.length,
  };
}

// ─── Server double (fetch) ──────────────────────────────────────────────────

// Bearer → owner. A bearer that was rotated away is no longer accepted: the
// server answers 401 exactly as it does for an expired access token.
const bearerBook = new Map<string, OwnerFixture>();
function currentBearer(owner: OwnerFixture): string {
  return `bearer-${owner.name}-${owner.bearerSerial}`;
}
function rotateBearer(owner: OwnerFixture): void {
  owner.bearerSerial += 1;
  bearerBook.set(currentBearer(owner), owner);
}

function planFor(owner: OwnerFixture) {
  return {
    plan: {
      id: `11111111-1111-4111-8111-${owner.name === 'alpha' ? '000000000001' : '000000000002'}`,
      status: 'active',
      algorithmVersion: 'plan-v1',
      sourceShotId: owner.analysisId,
      shotType: 'forehand_drive',
      priorityCheckpoint: 'contact_position',
      priorityDirection: owner.planMarker,
      baselineScore: owner.overallScore * 10,
      baselineCheckpointScore: null,
      reassessmentShotId: null,
      scoreDelta: null,
      createdAt: '2026-09-01T11:00:00.000Z',
      completedAt: null,
      items: [],
    },
  };
}

interface FetchLog {
  url: string;
  bearer: string | null;
  outcome: string;
}
const fetchLog: FetchLog[] = [];

function installFetch(): void {
  const fakeFetch = (input: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const bearer = headers['Authorization']?.replace(/^Bearer\s+/, '') ?? null;
    const label = `${init?.method ?? 'GET'} ${input.replace(API_BASE, '')}`;
    return mockEnqueue('fetch', label, bearer, mode => {
      if (mode === 'network-error') {
        fetchLog.push({ url: input, bearer, outcome: 'network-error' });
        throw new TypeError('Network request failed');
      }
      const owner = bearer ? bearerBook.get(bearer) : undefined;
      const stale = owner !== undefined && currentBearer(owner) !== bearer;
      if (!owner || stale) {
        fetchLog.push({
          url: input,
          bearer,
          outcome: stale ? '401-stale-bearer' : '401-unknown-bearer',
        });
        return response(401, { error: { code: 'auth.unauthorized' } });
      }
      if (input.endsWith('/v1/training-plans/current')) {
        fetchLog.push({ url: input, bearer, outcome: '200-plan' });
        return response(200, planFor(owner));
      }
      fetchLog.push({ url: input, bearer, outcome: '404' });
      return response(404, { error: { code: 'not_found' } });
    });
  };
  (globalThis as { fetch: unknown }).fetch = fakeFetch;
}

function response(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  } as unknown as Response;
}

// ─── Timer attribution ──────────────────────────────────────────────────────

// Wraps the (fake) timer globals so a timer still scheduled after the final
// unmount can be named by the frame that created it.
const liveTimers = new Map<unknown, { kind: string; origin: string }>();

function originFrame(): string {
  const stack = (new Error().stack ?? '').split('\n').slice(3);
  const frame = stack.find(
    line =>
      !line.includes('stress.test') &&
      !line.includes('fake-timers') &&
      !line.includes('node_modules/react-native/Libraries/Core/Timers'),
  );
  return (frame ?? stack[0] ?? '?')
    .trim()
    .replace(/^at\s+/, '')
    .slice(0, 140);
}

function installTimerAttribution(): void {
  const g = globalThis as unknown as {
    setTimeout: (...args: unknown[]) => unknown;
    setInterval: (...args: unknown[]) => unknown;
    clearTimeout: (id: unknown) => void;
    clearInterval: (id: unknown) => void;
    setImmediate: (...args: unknown[]) => unknown;
    clearImmediate: (id: unknown) => void;
  };
  const rawSetTimeout = g.setTimeout;
  const rawSetInterval = g.setInterval;
  const rawClearTimeout = g.clearTimeout;
  const rawClearInterval = g.clearInterval;
  const rawSetImmediate = g.setImmediate;
  const rawClearImmediate = g.clearImmediate;
  g.setImmediate = (callback: unknown, ...rest: unknown[]) => {
    const origin = originFrame();
    const id: unknown = rawSetImmediate(
      (...args: unknown[]) => {
        liveTimers.delete(id);
        (callback as (...a: unknown[]) => void)(...args);
      },
      ...rest,
    );
    liveTimers.set(id, { kind: 'immediate', origin });
    return id;
  };
  g.clearImmediate = (id: unknown) => {
    liveTimers.delete(id);
    rawClearImmediate(id);
  };
  g.setTimeout = (callback: unknown, ...rest: unknown[]) => {
    const origin = originFrame();
    const id: unknown = rawSetTimeout(
      (...args: unknown[]) => {
        liveTimers.delete(id);
        (callback as (...a: unknown[]) => void)(...args);
      },
      ...rest,
    );
    liveTimers.set(id, { kind: 'timeout', origin });
    return id;
  };
  g.setInterval = (callback: unknown, ...rest: unknown[]) => {
    const id = rawSetInterval(callback, ...rest);
    liveTimers.set(id, { kind: 'interval', origin: originFrame() });
    return id;
  };
  g.clearTimeout = (id: unknown) => {
    liveTimers.delete(id);
    rawClearTimeout(id);
  };
  g.clearInterval = (id: unknown) => {
    liveTimers.delete(id);
    rawClearInterval(id);
  };
}

function describeLiveTimers(): string {
  const buckets = new Map<string, number>();
  for (const timer of liveTimers.values()) {
    const key = `${timer.kind} @ ${timer.origin}`;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return [...buckets.entries()]
    .map(([key, count]) => `${count}× ${key}`)
    .join('; ');
}

// ─── AppState double ────────────────────────────────────────────────────────

type AppStateHandler = (state: string) => void;
const appStateListeners = new Set<AppStateHandler>();
const appStateMock = AppState as unknown as {
  currentState: string;
  addEventListener: jest.Mock;
};

function installAppState(): void {
  appStateMock.currentState = 'active';
  appStateMock.addEventListener.mockImplementation(
    (_type: string, handler: AppStateHandler) => {
      appStateListeners.add(handler);
      return {
        remove: () => {
          appStateListeners.delete(handler);
        },
      };
    },
  );
}

function emitAppState(state: 'background' | 'active' | 'inactive'): void {
  appStateMock.currentState = state;
  for (const handler of [...appStateListeners]) handler(state);
}

// ─── Session lifecycle (what authStore.installApiSession does) ──────────────

const unauthorizedEvents: string[] = [];

function establishOwnerSession(owner: OwnerFixture): void {
  setActiveDataOwner(owner.owner);
  establishApiSession({
    apiBaseUrl: API_BASE,
    bearerToken: currentBearer(owner),
    canonicalAppUserId: owner.canonicalAppUserId,
    provider: 'apple',
  });
  configureTrainingStore(
    createTrainingApi({
      baseUrl: API_BASE,
      get token() {
        return bearerTokenFor(owner.canonicalAppUserId);
      },
    }),
  );
  setApiUnauthorizedListener(session => {
    unauthorizedEvents.push(session.bearerToken);
  });
}

function signOutSession(): void {
  clearApiSession();
  clearTrainingStoreConfiguration();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
}

/** Process death: every in-memory store is gone, SQLite stays. */
function killProcess(): void {
  getDb().close();
  clearApiSession();
  clearTrainingStoreConfiguration();
  clearTryAgainHandoff();
  mockDevice.pending.length = 0;
}

// ─── Host (Gate semantics: navigator unmounted while the owner changes) ─────

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function Host(props: { owner: OwnerFixture | null; epoch: number }) {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        {props.owner ? (
          <RootNavigator key={`${props.owner.name}:${props.epoch}`} />
        ) : (
          <LoadingState dark label="Loading your account" />
        )}
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

// ─── Rendering helpers ──────────────────────────────────────────────────────

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function allText(renderer: ReactTestRenderer | null): string {
  if (!renderer) return '';
  return renderer.root
    .findAllByType(Text)
    .map(node =>
      React.Children.toArray(node.props.children)
        .filter(child => typeof child === 'string' || typeof child === 'number')
        .join(''),
    )
    .join('\n');
}

/**
 * The TOPMOST ResultDetailsScreen instance. The native stack renders routes
 * in stack order and keeps every route below the focused one mounted, and a
 * deep link can stack a second ResultDetails on the first — so the last
 * instance in document order is the focused route's screen.
 */
function focusedDetailsNode(
  renderer: ReactTestRenderer | null,
): ReactTestInstance | null {
  if (!renderer) return null;
  const screens = renderer.root.findAllByType(ResultDetailsScreen);
  return screens[screens.length - 1] ?? null;
}

/** Text of the focused ResultDetails screen only. */
function detailsText(renderer: ReactTestRenderer | null): string {
  const screen = focusedDetailsNode(renderer);
  if (!screen) return '';
  return screen
    .findAllByType(Text)
    .map(node =>
      React.Children.toArray(node.props.children)
        .filter(child => typeof child === 'string' || typeof child === 'number')
        .join(''),
    )
    .join('\n');
}

function rootRoutes(): { name: string; params?: unknown }[] {
  const nav = mockProbe.navigation;
  if (!nav) return [];
  try {
    // Home lives in the Tabs child; the parent state is the root stack.
    const parent = (
      nav as unknown as { getParent: () => NavigationLike | undefined }
    ).getParent();
    return (parent ?? nav).getState().routes;
  } catch {
    return [];
  }
}

function routeNames(): string[] {
  return rootRoutes().map(route => route.name);
}

/** analysisId of the FOCUSED route when it is ResultDetails, else null. */
function focusedDetailsId(): string | null {
  const top = rootRoutes().at(-1);
  if (!top || top.name !== 'ResultDetails') return null;
  const params = top.params as { analysisId?: unknown } | undefined;
  return typeof params?.analysisId === 'string' ? params.analysisId : null;
}

// ─── The seeded schedule ────────────────────────────────────────────────────

type Action =
  | 'deliver-one'
  | 'deliver-random'
  | 'deliver-all'
  | 'fail-fetch'
  | 'advance-timers'
  | 'background'
  | 'foreground'
  | 'rotate-token'
  | 'switch-account'
  | 'sign-out-in'
  | 'kill-relaunch'
  | 'go-back'
  | 'pop-to-top'
  | 'reopen-details'
  | 'change-params'
  | 'open-foreign-deeplink'
  | 'revoke-artifact'
  | 'press-back-button';

const ACTIONS: readonly Action[] = [
  'deliver-one',
  'deliver-one',
  'deliver-one',
  'deliver-random',
  'deliver-random',
  'deliver-all',
  'fail-fetch',
  'advance-timers',
  'advance-timers',
  'background',
  'foreground',
  'rotate-token',
  'switch-account',
  'sign-out-in',
  'kill-relaunch',
  'go-back',
  'pop-to-top',
  'reopen-details',
  'change-params',
  'open-foreign-deeplink',
  'revoke-artifact',
  'press-back-button',
];

interface IterationResult {
  seed: number;
  outcome: 'HELD' | 'BROKEN';
  steps: string[];
  violations: string[];
  finalOwner: string;
  finalRoute: string | null;
  finalAnalysisId: string | null;
  deliveredOps: number;
  fetches: number;
  relaunches: number;
  accountSwitches: number;
  durationMs: number;
  /** Rendered text at settle (before the final unmount), for diagnosis. */
  finalText: string;
}

interface World {
  renderer: ReactTestRenderer | null;
  owner: OwnerFixture | null;
  epoch: number;
  steps: string[];
  violations: string[];
  delivered: number;
  relaunches: number;
  accountSwitches: number;
  consoleErrors: string[];
  finalText: string;
}

async function render(world: World): Promise<void> {
  await act(async () => {
    if (world.renderer) {
      world.renderer.update(<Host owner={world.owner} epoch={world.epoch} />);
    } else {
      world.renderer = TestRenderer.create(
        <Host owner={world.owner} epoch={world.epoch} />,
      );
    }
  });
  await flush();
}

async function openDetails(
  world: World,
  analysisId: string,
  viaResult: boolean,
): Promise<void> {
  const nav = mockProbe.navigation;
  if (!nav) throw new Error('navigation probe missing (Home not mounted)');
  await act(async () => {
    if (viaResult) nav.navigate('Result', { analysisId });
    nav.navigate('ResultDetails', { analysisId });
  });
  await flush();
}

function detailsMounted(): boolean {
  return routeNames().includes('ResultDetails');
}

async function deliver(world: World, index: number, mode: SettleMode) {
  const op = mockDevice.pending.splice(index, 1)[0];
  if (!op) return;
  world.delivered += 1;
  await act(async () => {
    op.settle(mode);
    await Promise.resolve();
  });
  await flush();
}

async function deliverAll(world: World): Promise<void> {
  // Deliveries can enqueue follow-up operations (a resolved evidence read
  // starts the sidecar read); loop until the device is quiet.
  for (
    let guard = 0;
    guard < 200 && mockDevice.pending.length > 0;
    guard += 1
  ) {
    await deliver(world, 0, 'ok');
  }
  if (mockDevice.pending.length > 0) {
    world.violations.push(
      `device never went quiet: ${mockDevice.pending.length} ops still pending`,
    );
  }
  await act(async () => {
    jest.advanceTimersByTime(50);
  });
  await flush();
}

// Drain everything; if an earlier injected network error left the training
// plan in `error`, retry it so both sides of an I4 comparison reflect the
// same server answer (the comparison is about re-hydration, not the network).
async function settleTrainingPlan(world: World): Promise<void> {
  await deliverAll(world);
  if (useTrainingStore.getState().planStatus === 'error') {
    await act(async () => {
      void useTrainingStore.getState().loadCurrentPlan();
    });
    await flush();
    await deliverAll(world);
  }
}

async function relaunch(world: World, owner: OwnerFixture): Promise<void> {
  await act(async () => {
    world.renderer?.unmount();
  });
  world.renderer = null;
  killProcess();
  world.relaunches += 1;
  // authStore.hydrate(): the vault restores the same canonical user, the
  // refresh token mints a NEW access token, then the navigator mounts.
  rotateBearer(owner);
  establishOwnerSession(owner);
  world.owner = owner;
  world.epoch += 1;
  await render(world);
}

async function switchOwner(world: World, next: OwnerFixture | null) {
  // Gate: the owner changes → `ready` flips false → navigator unmounts.
  world.owner = null;
  await render(world);
  if (next) {
    rotateBearer(next);
    establishOwnerSession(next);
  } else {
    signOutSession();
  }
  world.owner = next;
  world.epoch += 1;
  world.accountSwitches += 1;
  await render(world);
}

async function step(world: World, rng: Rng, action: Action): Promise<void> {
  const owner = world.owner;
  switch (action) {
    case 'deliver-one':
      if (mockDevice.pending.length > 0) await deliver(world, 0, 'ok');
      break;
    case 'deliver-random':
      if (mockDevice.pending.length > 0) {
        await deliver(world, rng.int(mockDevice.pending.length), 'ok');
      }
      break;
    case 'deliver-all':
      await deliverAll(world);
      break;
    case 'fail-fetch': {
      const index = mockDevice.pending.findIndex(op => op.kind === 'fetch');
      if (index >= 0) await deliver(world, index, 'network-error');
      break;
    }
    case 'advance-timers':
      await act(async () => {
        jest.advanceTimersByTime(rng.pick([16, 250, 1000, 5000]));
      });
      await flush();
      break;
    case 'background':
      await act(async () => {
        emitAppState(rng.chance(0.5) ? 'inactive' : 'background');
        emitAppState('background');
      });
      await flush();
      break;
    case 'foreground':
      await act(async () => {
        emitAppState('active');
      });
      await flush();
      break;
    case 'rotate-token':
      if (owner) {
        rotateBearer(owner);
        establishApiSession({
          apiBaseUrl: API_BASE,
          bearerToken: currentBearer(owner),
          canonicalAppUserId: owner.canonicalAppUserId,
          provider: 'apple',
        });
        await flush();
      }
      break;
    case 'switch-account':
      if (owner) {
        const next = otherOf(owner);
        await switchOwner(world, next);
        if (rng.chance(0.5)) {
          await openDetails(world, next.analysisId, rng.chance(0.5));
        }
      }
      break;
    case 'sign-out-in': {
      await switchOwner(world, null);
      const back = rng.pick([owners.alpha, owners.beta]);
      await switchOwner(world, back);
      if (rng.chance(0.6)) {
        await openDetails(world, back.analysisId, rng.chance(0.5));
      }
      break;
    }
    case 'kill-relaunch': {
      if (!owner) break;
      const targeted = focusedDetailsId();
      if (targeted) {
        // I4 — idempotent re-hydrate: settle, snapshot, kill, relaunch to
        // the same route, settle, compare.
        await settleTrainingPlan(world);
        const before = detailsText(world.renderer);
        const rowsBefore = countRows();
        await relaunch(world, owner);
        await openDetails(world, targeted, rng.chance(0.5));
        await settleTrainingPlan(world);
        const after = detailsText(world.renderer);
        if (before !== after) {
          const beforeLines = before.split('\n');
          const afterLines = after.split('\n');
          const onlyBefore = beforeLines.filter(l => !afterLines.includes(l));
          const onlyAfter = afterLines.filter(l => !beforeLines.includes(l));
          world.violations.push(
            `I4 re-hydrate differs after kill/relaunch: -[${onlyBefore.slice(0, 4).join(' | ')}] +[${onlyAfter.slice(0, 4).join(' | ')}]`,
          );
        }
        const rowsAfter = countRows();
        if (JSON.stringify(rowsBefore) !== JSON.stringify(rowsAfter)) {
          world.violations.push(
            `I4 re-hydrate changed row counts ${JSON.stringify(rowsBefore)} → ${JSON.stringify(rowsAfter)}`,
          );
        }
      } else {
        await relaunch(world, owner);
        if (rng.chance(0.7)) {
          await openDetails(world, owner.analysisId, rng.chance(0.5));
        }
      }
      break;
    }
    case 'go-back':
      if (mockProbe.navigation && detailsMounted()) {
        await act(async () => {
          mockProbe.navigation?.goBack();
        });
        await flush();
      }
      break;
    case 'pop-to-top':
      if (mockProbe.navigation && detailsMounted()) {
        await act(async () => {
          mockProbe.navigation?.popToTop();
        });
        await flush();
      }
      break;
    case 'reopen-details':
      if (owner && mockProbe.navigation) {
        const id = rng.chance(0.75) ? owner.analysisId : owner.attemptId;
        await openDetails(world, id, rng.chance(0.5));
      }
      break;
    case 'change-params':
      // navigate() to the mounted ResultDetails with different params
      // updates the live route: the evidence effect must cancel the
      // in-flight read and start over.
      if (owner && mockProbe.navigation && detailsMounted()) {
        const id =
          focusedDetailsId() === owner.analysisId
            ? owner.attemptId
            : owner.analysisId;
        await act(async () => {
          mockProbe.navigation?.navigate('ResultDetails', { analysisId: id });
        });
        await flush();
      }
      break;
    case 'open-foreign-deeplink':
      // A stale link / notification to the OTHER owner's analysis.
      if (owner && mockProbe.navigation) {
        await openDetails(world, otherOf(owner).analysisId, false);
      }
      break;
    case 'revoke-artifact':
      mockDevice.artifactRevoked = true;
      break;
    case 'press-back-button':
      if (world.renderer && detailsMounted()) {
        const backs = world.renderer.root.findAll(
          node =>
            node.props['accessibilityLabel'] === 'Back' &&
            typeof node.props['onPress'] === 'function',
        );
        const target = backs[backs.length - 1];
        if (target) {
          await act(async () => {
            (target.props['onPress'] as () => void)();
          });
          await flush();
        }
      }
      break;
    default: {
      const exhaustive: never = action;
      throw new Error(`unknown action ${String(exhaustive)}`);
    }
  }
}

function countRows(): Record<string, number> {
  const sqlite = mockDevice.sqlite;
  if (!sqlite) return {};
  const counts: Record<string, number> = {};
  for (const table of [
    'local_shot',
    'local_capture',
    'local_analysis_record',
    'outbox',
    'sync_receipt',
    'kv',
  ]) {
    const row = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).all()[0];
    counts[table] = Number(row?.['n'] ?? 0);
  }
  return counts;
}

const scoreMarker = (owner: OwnerFixture): string =>
  `Contact position scored ${owner.contactScore}`;

function checkInvariants(world: World): void {
  const owner = world.owner;
  const text = allText(world.renderer);
  const training = useTrainingStore.getState();
  const focusedId = focusedDetailsId();

  if (owner && focusedId) {
    const other = otherOf(owner);
    const ownsTarget =
      focusedId === owner.analysisId || focusedId === owner.attemptId;
    const screen = focusedDetailsNode(world.renderer);
    const screenText = detailsText(world.renderer);
    const showsMissing = screenText.includes('Result missing');
    const showsBreakdown =
      screen !== null &&
      screen.findAll(
        node => node.props['testID'] === 'result-details-breakdown',
      ).length > 0;
    if (ownsTarget) {
      if (!showsBreakdown || showsMissing) {
        world.violations.push(
          `I1 owner ${owner.name} owns ${focusedId} but breakdown=${showsBreakdown} missing=${showsMissing}`,
        );
      }
      if (!screenText.includes(scoreMarker(owner))) {
        world.violations.push(
          `I1 breakdown does not show ${owner.name}'s "${scoreMarker(owner)}"`,
        );
      }
    } else if (!showsMissing || showsBreakdown) {
      world.violations.push(
        `I1 foreign analysis ${focusedId} under ${owner.name}: breakdown=${showsBreakdown} missing=${showsMissing}`,
      );
    }
    // Whole tree: no screen anywhere in the stack may show the other owner.
    if (text.includes(scoreMarker(other))) {
      world.violations.push(
        `I1 previous owner's "${scoreMarker(other)}" visible under ${owner.name}`,
      );
    }
    if (text.includes(other.planMarker.replace(/_/g, ' '))) {
      world.violations.push(
        `I1 previous owner's plan marker rendered under ${owner.name}`,
      );
    }
    if (screenText.includes('Opening your result')) {
      world.violations.push(
        'I1 details still "Opening your result…" after settle',
      );
    }
  }

  if (training.planStatus === 'loading') {
    world.violations.push('I2 training store stuck in loading after settle');
  }
  const plan = training.currentPlan;
  if (plan) {
    const planOwner =
      plan.priorityDirection === owners.alpha.planMarker
        ? owners.alpha
        : plan.priorityDirection === owners.beta.planMarker
          ? owners.beta
          : null;
    if (!owner || !planOwner || planOwner.name !== owner.name) {
      world.violations.push(
        `I2 training store holds plan of ${planOwner?.name ?? '?'} while owner is ${owner?.name ?? 'signed-out'}`,
      );
    }
  }
  if (!owner && training.planStatus === 'ready') {
    world.violations.push('I2 training store ready while signed out');
  }

  if (unauthorizedEvents.length > 0) {
    world.violations.push(
      `I3 unauthorized listener fired for ${unauthorizedEvents.join(',')}`,
    );
  }
  const session = getApiSession();
  if (owner && session?.canonicalAppUserId !== owner.canonicalAppUserId) {
    world.violations.push(
      `I3 api session belongs to ${session?.canonicalAppUserId ?? 'nobody'} while owner is ${owner.name}`,
    );
  }
}

async function teardown(world: World): Promise<void> {
  await act(async () => {
    world.renderer?.unmount();
  });
  world.renderer = null;
  await flush();
  // Zero-delay work scheduled by the unmount itself (immediates, a final
  // rAF) is allowed to run; anything re-armed or long-lived is a leak.
  await act(async () => {
    jest.advanceTimersByTime(0);
  });
  await flush();
  const timers = jest.getTimerCount();
  if (timers !== 0) {
    world.violations.push(
      `I5 ${timers} timers still scheduled after unmount: ${describeLiveTimers()}`,
    );
  }
  if (appStateListeners.size !== 0) {
    world.violations.push(
      `I5 ${appStateListeners.size} AppState listeners after unmount`,
    );
  }
  if (mockNotificationSubscriptions.live !== 0) {
    world.violations.push(
      `I5 ${mockNotificationSubscriptions.live} notification subscriptions after unmount`,
    );
  }
  if (world.consoleErrors.length > 0) {
    world.violations.push(
      `I5 console.error: ${world.consoleErrors.slice(0, 3).join(' | ')}`,
    );
  }
}

async function runIteration(seed: number): Promise<IterationResult> {
  const started = Date.now();
  const rng = new Rng(seed);
  const world: World = {
    renderer: null,
    owner: null,
    epoch: 0,
    steps: [],
    violations: [],
    delivered: 0,
    relaunches: 0,
    accountSwitches: 0,
    consoleErrors: [],
    finalText: '',
  };
  unauthorizedEvents.length = 0;
  mockDevice.pending.length = 0;
  mockDevice.artifactRevoked = false;
  mockDevice.immediate = false;
  fetchLog.length = 0;

  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    world.consoleErrors.push(args.map(String).join(' ').slice(0, 160));
  };

  try {
    const first = rng.pick([owners.alpha, owners.beta]);
    rotateBearer(first);
    establishOwnerSession(first);
    world.owner = first;
    world.steps.push(`start:${first.name}`);
    await render(world);
    await openDetails(world, first.analysisId, rng.chance(0.5));
    world.steps.push(`open:${first.name}`);

    const stepCount = 6 + rng.int(9);
    for (let i = 0; i < stepCount; i += 1) {
      const action = rng.pick(ACTIONS);
      world.steps.push(action);
      await step(world, rng, action);
    }

    await deliverAll(world);
    world.finalText = allText(world.renderer);
    checkInvariants(world);
  } catch (error) {
    world.violations.push(
      `I6 threw: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    );
  } finally {
    try {
      await teardown(world);
    } finally {
      console.error = originalError;
      if (world.owner) signOutSession();
      mockDevice.pending.length = 0;
    }
  }

  return {
    seed,
    outcome: world.violations.length === 0 ? 'HELD' : 'BROKEN',
    steps: world.steps,
    violations: world.violations,
    finalOwner: world.owner?.name ?? 'signed-out',
    finalRoute: routeNames().at(-1) ?? null,
    finalAnalysisId: focusedDetailsId(),
    deliveredOps: world.delivered,
    fetches: fetchLog.length,
    relaunches: world.relaunches,
    accountSwitches: world.accountSwitches,
    durationMs: Date.now() - started,
    finalText: world.finalText.replace(/\s+/g, ' ').slice(0, 2500),
  };
}

// ─── Fixture seeding (once per "device") ────────────────────────────────────

async function seedOwner(owner: OwnerFixture): Promise<void> {
  setActiveDataOwner(owner.owner);
  const db = getDb();
  const sidecar = poseSidecarJson();
  mockDevice.artifactBytes = sidecar.json;
  const clip = assertCapturedClip({
    captureMode: 'imported_video',
    uri: `file:///captures/${owner.name}.mov`,
    durationMs: 3400,
    fps: 30,
    width: 720,
    height: 1280,
    capturedAtIso: '2026-09-01T10:00:00.000Z',
    posterUri: `file:///captures/${owner.name}.poster.jpg`,
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: `file:///captures/${owner.name}.pose.json`,
      frameCount: sidecar.frameCount,
      sha256: sha256Hex(sidecar.json),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  });
  await savePendingCapture(db, owner.captureId, 'forehand_drive', clip);
  await saveAnalysis(
    db,
    analysisFor(owner, owner.attemptId, '2026-09-01T09:55:00.000Z'),
    `permit-${owner.name}-1`,
  );
  await saveAnalysis(
    db,
    analysisFor(owner, owner.analysisId, '2026-09-01T10:00:00.000Z'),
    `permit-${owner.name}-2`,
  );
  for (const id of [owner.attemptId, owner.analysisId]) {
    await db.execute(
      `INSERT INTO local_analysis_record
        (owner_key, id, capture_id, created_at, engine_version, scoring_model_version, record)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        owner.owner,
        id,
        owner.captureId,
        '2026-09-01T10:00:01.000Z',
        'fusion-1',
        'sm-v1',
        JSON.stringify({
          id,
          captureId: owner.captureId,
          strokeIntent: {
            declaredStroke: 'forehand_drive',
            predictedStroke: null,
            resolutionBasis: 'declared',
            resolvedProfileId: 'FOREHAND_DRIVE',
            resolvedProfileVersion: 'technique-profile-v1',
            disagreement: null,
          },
          result: null,
          uncertainty: {
            analysisConfidence: 0.84,
            presentation: 'normal',
            limitingFactors: ['paddle_track_unavailable'],
          },
        }),
      ],
    );
  }
  // Owner alpha's newest read is synced; beta's is still queued — both real
  // sync-evidence branches are exercised.
  if (owner.name === 'alpha') {
    await db.execute(
      `INSERT INTO sync_receipt (owner_key, kind, entity_id) VALUES (?, 'shot.sync', ?)`,
      [owner.owner, owner.analysisId],
    );
  }
}

// ─── Suite ──────────────────────────────────────────────────────────────────

const ITERATIONS = Math.max(1, Number(process.env['STRESS_ITER'] ?? 12));
const BASE_SEED = Number(process.env['STRESS_SEED_BASE'] ?? 20260904);
const ONLY_SEED = process.env['STRESS_SEED']
  ? Number(process.env['STRESS_SEED'])
  : null;
const OUT_PATH = process.env['STRESS_OUT'] ?? null;

describe('ResultDetailsScreen · lifecycle interruption stress', () => {
  const results: IterationResult[] = [];

  beforeAll(async () => {
    // Microtasks stay real so React/act and promise chains flow as on
    // device; only macrotasks (timers, immediates, rAF) are under the clock.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    installTimerAttribution();
    mockDevice.sqlite = new DatabaseSync(':memory:');
    mockDevice.immediate = true;
    installFetch();
    installAppState();
    await seedOwner(owners.alpha);
    await seedOwner(owners.beta);
    signOutSession();
    mockDevice.immediate = false;
  });

  afterAll(() => {
    jest.useRealTimers();
    mockDevice.sqlite?.close();
    mockDevice.sqlite = null;
    if (OUT_PATH) {
      fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
      fs.writeFileSync(
        OUT_PATH,
        JSON.stringify(
          {
            unit: 'scr-resultdetailsscreen',
            lens: 'lifecycle',
            baseSeed: BASE_SEED,
            iterations: results.length,
            held: results.filter(r => r.outcome === 'HELD').length,
            broken: results
              .filter(r => r.outcome === 'BROKEN')
              .map(r => r.seed),
            dbOpens: mockDevice.dbOpens,
            dbCloses: mockDevice.dbCloses,
            results,
          },
          null,
          2,
        ),
      );
    }
  });

  const seeds =
    ONLY_SEED !== null
      ? [ONLY_SEED]
      : Array.from({ length: ITERATIONS }, (_, i) => BASE_SEED + i);

  it.each(seeds.map(seed => [seed]))(
    'seed %i: every lifecycle interleaving holds I1–I6',
    async seed => {
      const result = await runIteration(seed);
      results.push(result);
      expect({
        seed: result.seed,
        steps: result.steps,
        violations: result.violations,
      }).toEqual({ seed: result.seed, steps: result.steps, violations: [] });
    },
  );
});
