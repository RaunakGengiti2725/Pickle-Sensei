/**
 * STRESS · scr-libraryscreen · lens `lifecycle` — LIFECYCLE INTERRUPTION.
 *
 * Mounts the REAL LibraryScreen inside the REAL React Navigation tree the app
 * uses (NavigationContainer → native stack → bottom tabs with the real
 * PremiumTabBar; the sibling tab/stack routes are inert stubs), driven by the
 * REAL authStore / apiSession / sessionKeeper / syncRuntime / trainingStore /
 * accessStore / accountScope and the REAL getDb() schema + migrations. Only
 * the process edges are faked:
 *
 *   - @op-engineering/op-sqlite  → node:sqlite on a per-iteration in-memory
 *                                  "disk" (survives kill/relaunch, optional
 *                                  read-fault window = permission revoked later)
 *   - react-native-keychain      → Map (survives kill/relaunch)
 *   - fetch                      → scripted server: /v1/account/bootstrap,
 *                                  /v1/auth/refresh, /v1/auth/logout,
 *                                  /v1/me/saved-drills, /v1/catalog/drills/:slug,
 *                                  /v1/training-plans/current; seeded latency,
 *                                  bearer expiry, refresh-token rotation,
 *                                  server-side revocation
 *   - AppState / PickleAuth      → controlled emitters / scripted Apple sign-in
 *   - reanimated / linear-gradient / safe-area-context → inert views (native)
 *   - runtimeConfig              → https://api.example.test (never the network)
 *
 * A "process" is a fresh jest module registry (`jest.resetModules()` + a
 * re-require of React, react-native, react-test-renderer, navigation and the
 * app modules), so kill/relaunch really drops every in-memory singleton
 * (stores, db handle, training API, api session, keeper) and re-hydrates from
 * the Keychain map + SQLite only. The shell mirrors App.tsx's Gate: hydrate
 * on mount, LoadingState until hydrated, a signed-out surface without a
 * session, the navigator keyed by the desired data owner (Gate unmounts the
 * RootNavigator whenever appStore's owner no longer matches the session).
 *
 * Every iteration is a seeded schedule (mulberry32) of lifecycle steps —
 * focus/blur, push/pop over the screen, background/foreground, unmount while
 * reads are in flight, kill/relaunch (+ re-entrant double hydrate), sign-out,
 * sign-in / account switch A↔B mid-request, bearer rotation mid-request,
 * server-side session revocation later, local read-fault later + retry, tab
 * switches — with invariants checked after every settled step:
 *
 *   crossUserIsolation   text/labels from account X never render while the
 *                        session owner is not X (A↔B, guest, signed-out)
 *   readsMatchOwner      settled Reads tab shows exactly the owner's counts
 *   noEmptyStateOnFault  a failed local read never renders the first-run
 *                        empty state for an owner that has data
 *   noStuckLoading       "Opening your library…" never survives a settle
 *   trainingRecovers     saved drills/plan reach `ready` for the owner with a
 *                        healthy server through a path the app offers
 *                        (already ready → "Try again" → leave + re-enter the
 *                        tab); the path taken is recorded per row
 *   revokeSignsOut       server revocation → session null, vault cleared,
 *                        nothing rendered from the revoked account; a
 *                        relaunch stays signed out (idempotent re-hydrate)
 *   rehydrateIdempotent  every relaunch lands on the persisted owner; the
 *                        one exception is the SQLite-kept guest marker
 *                        under a faulted local database, which must land
 *                        signed out with localDataError set (counted)
 *   noLeakedHandles      after unmount + keeper/sync stop, no AppState
 *                        listeners remain, pending timers drain within three
 *                        rounds without re-arming or touching sign-in
 *                        state (app-owned one-shots still pending are
 *                        recorded), no request is issued by a dead process
 *   noErrorBoundary      no render error surfaced from the tree
 *
 * Defaults are suite-fast (STRESS_ITER=12 seeded iterations + fixed
 * scenarios). Campaign: `STRESS_ITER=120 npx jest --ci --detectOpenHandles
 * __tests__/stress/libraryScreenLifecycle`. Replay one seed:
 * `STRESS_SEED=<seed>`. The JSON table (seed → inputs, observed, invariants)
 * is written to artifacts/stress-libraryscreen-lifecycle/ (STRESS_ARTIFACT_DIR
 * overrides).
 */
import type { ReactTestRenderer } from 'react-test-renderer';
import type { NavigationContainerRefWithCurrent } from '@react-navigation/native';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import {
  fs,
  loadNodeSqlite,
  nodeProcess,
  path,
  type SqliteDatabaseSync,
  type SqlInputValue,
} from '../../xc-harness/lifecycle-persistence/nodeShim';
import {
  CANONICAL_ID,
  OTHER_CANONICAL_ID,
} from '../../xc-harness/lifecycle-persistence/seeds';

declare const require: (id: string) => unknown;
declare const __dirname: string;

/** Real elapsed time; the global clock is faked for the whole suite. */
const wallClock = (
  require('node:perf_hooks') as { performance: { now: () => number } }
).performance;

// ─── Persistent "disk" (survives kill/relaunch inside one iteration) ─────────

interface Disk {
  sqlite: SqliteDatabaseSync | null;
  /** When true, every async read against the local store throws — the local
   * data permission was revoked after launch. Migrations (executeSync) still
   * run, mirroring a store that opens but refuses to read. */
  faultReads: boolean;
  keychain: Map<string, { username: string; password: string }>;
  sqlCalls: number;
}

const mockDisk: Disk = {
  sqlite: null,
  faultReads: false,
  keychain: new Map(),
  sqlCalls: 0,
};

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    const run = (sql: string, params: unknown[]) => {
      const inner = mockDisk.sqlite;
      if (!inner) throw new Error('harness: no disk for this iteration');
      mockDisk.sqlCalls += 1;
      const rows = inner
        .prepare(sql)
        .all(...(params as SqlInputValue[])) as Record<string, unknown>[];
      return { rows };
    };
    return {
      executeSync: (sql: string, params: unknown[] = []) => run(sql, params),
      execute: async (sql: string, params: unknown[] = []) => {
        if (mockDisk.faultReads && /^\s*SELECT/i.test(sql)) {
          throw new Error('SQLITE_AUTH: local store read refused');
        }
        return run(sql, params);
      },
      close: () => {},
    };
  },
}));

jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY:
      'AccessibleAfterFirstUnlockThisDeviceOnly',
  },
  setGenericPassword: async (
    username: string,
    password: string,
    options: { service?: string } = {},
  ) => {
    mockDisk.keychain.set(options.service ?? '__default__', {
      username,
      password,
    });
    return { service: options.service, storage: 'mock' };
  },
  getGenericPassword: async (options: { service?: string } = {}) => {
    const item = mockDisk.keychain.get(options.service ?? '__default__');
    if (!item) return false;
    return { service: options.service, storage: 'mock', ...item };
  },
  resetGenericPassword: async (options: { service?: string } = {}) =>
    mockDisk.keychain.delete(options.service ?? '__default__'),
}));

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: jest.fn(),
    hasPlayServices: jest.fn(async () => true),
    hasPreviousSignIn: jest.fn(() => false),
    signIn: jest.fn(async () => ({ type: 'cancelled' })),
    signInSilently: jest.fn(async () => ({ type: 'noSavedCredentialFound' })),
    signOut: jest.fn(async () => {}),
    revokeAccess: jest.fn(async () => {}),
  },
}));

const API_BASE = 'https://api.example.test';
jest.mock('../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.example.test',
    revenueCatPublicSdkKey: null,
    googleIosClientId: 'test-ios-client.apps.googleusercontent.com',
    googleWebClientId: 'test-web-client.apps.googleusercontent.com',
    appVersion: '1.0',
    legalPrivacyUrl: null,
    legalTermsUrl: null,
    appStoreId: null,
    appStoreWriteReviewUrl: null,
  }),
}));

// Native UI modules the real tab bar / screen import.
jest.mock('react-native-safe-area-context', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };
  const frame = { x: 0, y: 0, width: 390, height: 844 };
  return {
    SafeAreaInsetsContext: React.createContext(insets),
    SafeAreaFrameContext: React.createContext(frame),
    SafeAreaView: View,
    SafeAreaProvider: View,
    initialWindowMetrics: null,
    useSafeAreaInsets: () => insets,
    useSafeAreaFrame: () => frame,
  };
});
jest.mock('react-native-reanimated', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const AnimatedView = (props: Record<string, unknown>) =>
    React.createElement(View, props);
  return {
    __esModule: true,
    default: {
      View: AnimatedView,
      createAnimatedComponent:
        (Component: React.ComponentType<Record<string, unknown>>) =>
        (props: Record<string, unknown>) =>
          React.createElement(Component, props),
    },
    Easing: { out: (fn: unknown) => fn, cubic: () => 0 },
    interpolate: () => 0,
    useAnimatedStyle: (updater: () => object) => updater(),
    useSharedValue: (init: unknown) => ({ value: init }),
    withTiming: (toValue: unknown) => toValue,
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

// ─── Seeded RNG ──────────────────────────────────────────────────────────────

class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }
  /** mulberry32 */
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
  pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(this.next() * items.length)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

// ─── Accounts & seeded data ──────────────────────────────────────────────────

type OwnerKey = 'A' | 'B' | 'G';
const ACCOUNT_ID: Record<'A' | 'B', string> = {
  A: CANONICAL_ID,
  B: OTHER_CANONICAL_ID,
};

interface OwnerData {
  key: OwnerKey;
  shots: number;
  captures: number;
  savedDrills: number;
  plan: boolean;
}

/** Marker tokens embedded in every owner-specific string the screen can
 * render (shot types, capture strokes, drill titles, plan shot type). */
const MARKER = /\b(?:SHOT|CLIP|DRILL|PLAN)([ABG])\d+\b/g;

function markersIn(text: string): Set<OwnerKey> {
  const owners = new Set<OwnerKey>();
  for (const match of text.matchAll(MARKER)) {
    owners.add(match[1] as OwnerKey);
  }
  return owners;
}

function uuidFor(owner: OwnerKey, kind: string, index: number): string {
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  const ownerByte = owner === 'A' ? 0xa1 : owner === 'B' ? 0xb2 : 0xc3;
  const kindByte = kind.charCodeAt(0);
  const tag = `${hex(ownerByte)}${hex(kindByte)}${hex(index)}`;
  return `${tag}00-0000-4000-8000-${tag}000000`;
}

// ─── Scripted server ─────────────────────────────────────────────────────────

interface ServerSession {
  account: 'A' | 'B';
  accessToken: string;
  /** Every bearer this session chain ever issued → its expiry. Like a JWT, an
   * earlier bearer stays valid until it expires even after a later rotation;
   * only revocation kills the whole chain. */
  bearers: Map<string, number>;
  refreshToken: string;
  /** Rotated-away refresh tokens stay accepted for a short reuse window
   * (Supabase-style), then refuse. */
  retiredRefresh: Map<string, number>;
  expiresAtMs: number;
  revoked: boolean;
}

interface ServerRequest {
  at: number;
  proc: number;
  method: string;
  path: string;
  status: number | null;
  bearer: string | null;
}

class ScriptedServer {
  sessions = new Map<string, ServerSession>();
  requests: ServerRequest[] = [];
  unexpected: string[] = [];
  bearerLifeMs = 3_600_000;
  maxLatencyMs = 0;
  /** Requests issued after the process that owns them was killed. */
  deadProcRequests = 0;
  private inflightByProc = new Map<number, number>();
  private counter = 0;
  private pendingTimers = 0;
  private rng: Rng;
  currentProc = 0;
  liveProcs = new Set<number>();
  refreshReuseWindowMs = 10_000;

  constructor(rng: Rng) {
    this.rng = rng;
  }

  inflight(proc: number): number {
    return this.inflightByProc.get(proc) ?? 0;
  }

  pendingServerTimers(): number {
    return this.pendingTimers;
  }

  /** The latency timers died with `jest.clearAllTimers()`; forget them. */
  dropPendingTimers(): void {
    this.pendingTimers = 0;
  }

  private mint(account: 'A' | 'B'): ServerSession {
    this.counter += 1;
    const session: ServerSession = {
      account,
      accessToken: `acc-${account}-${this.counter}`,
      bearers: new Map(),
      refreshToken: `ref-${account}-${this.counter}`,
      retiredRefresh: new Map(),
      expiresAtMs: Date.now() + this.bearerLifeMs,
      revoked: false,
    };
    session.bearers.set(session.accessToken, session.expiresAtMs);
    this.sessions.set(session.refreshToken, session);
    return session;
  }

  private rotate(session: ServerSession): ServerSession {
    this.counter += 1;
    session.retiredRefresh.set(session.refreshToken, Date.now());
    this.sessions.delete(session.refreshToken);
    session.accessToken = `acc-${session.account}-${this.counter}`;
    session.refreshToken = `ref-${session.account}-${this.counter}`;
    session.expiresAtMs = Date.now() + this.bearerLifeMs;
    session.bearers.set(session.accessToken, session.expiresAtMs);
    this.sessions.set(session.refreshToken, session);
    return session;
  }

  private findByRefresh(token: string): ServerSession | null {
    const live = this.sessions.get(token);
    if (live) return live;
    for (const session of this.sessions.values()) {
      const retiredAt = session.retiredRefresh.get(token);
      if (
        retiredAt !== undefined &&
        Date.now() - retiredAt <= this.refreshReuseWindowMs
      ) {
        return session;
      }
    }
    return null;
  }

  private findByBearer(
    bearer: string | null,
  ): { session: ServerSession; expiresAtMs: number } | null {
    if (!bearer) return null;
    for (const session of this.sessions.values()) {
      const expiresAtMs = session.bearers.get(bearer);
      if (expiresAtMs !== undefined) return { session, expiresAtMs };
    }
    return null;
  }

  /** Server-side "permission revoked later": every token of the account dies. */
  revokeAccount(account: 'A' | 'B'): void {
    for (const session of this.sessions.values()) {
      if (session.account === account) session.revoked = true;
    }
  }

  /** Expire the current bearer(s) now so the next request 401s and the
   * keeper must rotate mid-flight. */
  expireBearers(): void {
    for (const session of this.sessions.values()) {
      session.expiresAtMs = Date.now() - 1;
      for (const bearer of session.bearers.keys()) {
        session.bearers.set(bearer, session.expiresAtMs);
      }
    }
  }

  private delay(signal: AbortSignal | null | undefined): Promise<void> {
    const ms = this.maxLatencyMs === 0 ? 0 : this.rng.int(0, this.maxLatencyMs);
    if (ms === 0) return Promise.resolve();
    this.pendingTimers += 1;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = () => {
        if (settled) return false;
        settled = true;
        this.pendingTimers -= 1;
        return true;
      };
      const timer = setTimeout(() => {
        if (settle()) resolve();
      }, ms);
      signal?.addEventListener('abort', () => {
        if (!settle()) return;
        clearTimeout(timer);
        reject(new Error('aborted'));
      });
    });
  }

  readonly fetch = async (
    url: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const proc = this.currentProc;
    const route = url.startsWith(API_BASE) ? url.slice(API_BASE.length) : url;
    const headers = (init.headers ?? {}) as Record<string, string>;
    const authorization = headers['Authorization'] ?? headers['authorization'];
    const bearer = authorization?.startsWith('Bearer ')
      ? authorization.slice(7)
      : null;
    const record: ServerRequest = {
      at: Date.now(),
      proc,
      method: init.method ?? 'GET',
      path: route,
      status: null,
      bearer,
    };
    this.requests.push(record);
    if (!this.liveProcs.has(proc)) this.deadProcRequests += 1;
    this.inflightByProc.set(proc, this.inflight(proc) + 1);
    try {
      await this.delay(init.signal);
      const response = this.respond(route, init, bearer);
      record.status = response.status;
      return response;
    } finally {
      this.inflightByProc.set(proc, this.inflight(proc) - 1);
    }
  };

  private respond(
    route: string,
    init: RequestInit,
    bearer: string | null,
  ): Response {
    const body = () => {
      try {
        return JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
      } catch {
        return {};
      }
    };
    if (route === '/v1/account/bootstrap') {
      const token = bearer ?? '';
      const account =
        token === 'idtok-A' ? 'A' : token === 'idtok-B' ? 'B' : null;
      if (!account) {
        return json(401, { error: { message: 'bad identity token' } });
      }
      const session = this.mint(account);
      return json(200, {
        user: { id: ACCOUNT_ID[account], email: `${account}@example.test` },
        onboardingState: 'complete',
        session: {
          accessToken: session.accessToken,
          refreshToken: session.refreshToken,
          expiresAt: Math.floor(session.expiresAtMs / 1000),
        },
      });
    }
    if (route === '/v1/auth/refresh') {
      const token = String(body()['refreshToken'] ?? '');
      const session = this.findByRefresh(token);
      if (!session || session.revoked) {
        return json(401, { error: { message: 'refresh token refused' } });
      }
      const rotated = this.rotate(session);
      return json(200, {
        session: {
          accessToken: rotated.accessToken,
          refreshToken: rotated.refreshToken,
          expiresAt: Math.floor(rotated.expiresAtMs / 1000),
        },
      });
    }
    if (route === '/v1/auth/logout') {
      const found = this.findByBearer(bearer);
      if (found) found.session.revoked = true;
      return new Response(null, { status: 204 });
    }
    const found = this.findByBearer(bearer);
    if (!found || found.session.revoked || found.expiresAtMs <= Date.now()) {
      return json(401, { error: { message: 'unauthorized' } });
    }
    const { session } = found;
    const owner = ownerData[session.account];
    if (route === '/v1/me/saved-drills') {
      return json(200, {
        items: Array.from({ length: owner.savedDrills }, (_, i) =>
          savedDrillPayload(owner.key, i + 1),
        ),
      });
    }
    const detail = /^\/v1\/catalog\/drills\/([^/?]+)$/.exec(route);
    if (detail) {
      const slug = decodeURIComponent(detail[1] ?? '');
      const parsed = /^drill-([abg])-(\d+)$/i.exec(slug);
      if (!parsed) return json(404, { error: { message: 'no such drill' } });
      const key = (parsed[1] ?? 'a').toUpperCase() as OwnerKey;
      return json(200, drillDetailPayload(key, Number(parsed[2])));
    }
    if (route === '/v1/training-plans/current') {
      return json(200, {
        plan: owner.plan ? planPayload(owner.key) : null,
      });
    }
    if (route === '/v1/me/access') {
      return json(200, {
        premium: false,
        entitlement: null,
        freeRatings: { used: 0, limit: 2, reserved: 0, availableToReserve: 2 },
        scoredCount: 0,
        canStartRating: true,
      });
    }
    this.unexpected.push(`${init.method ?? 'GET'} ${route}`);
    return json(404, { error: { message: 'unexpected route in harness' } });
  }
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function savedDrillPayload(owner: OwnerKey, index: number) {
  return {
    id: uuidFor(owner, 'd', index),
    slug: `drill-${owner.toLowerCase()}-${index}`,
    title: `Reviewed DRILL${owner}${index}`,
    description: 'Reviewed catalog work.',
    coach_name: `Coach DRILL${owner}${index}`,
    equipment: [],
    difficulty_min: null,
    difficulty_max: null,
    saved_at: '2026-09-01T10:00:00.000Z',
  };
}

function drillDetailPayload(owner: OwnerKey, index: number) {
  const saved = savedDrillPayload(owner, index);
  return {
    drill: { ...saved, saved: true },
    mappings: [],
    instructionalMedia: [],
  };
}

function planPayload(owner: OwnerKey) {
  return {
    id: uuidFor(owner, 'p', 1),
    status: 'active',
    algorithmVersion: 'plan-v1',
    sourceShotId: uuidFor(owner, 's', 1),
    shotType: `PLAN${owner}1`,
    priorityCheckpoint: 'paddle_prep',
    priorityDirection: 'late',
    baselineScore: 61.5,
    baselineCheckpointScore: null,
    scoreDelta: null,
    reassessmentShotId: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    completedAt: null,
    items: [],
  };
}

// The server reads the owner table of the running iteration.
let ownerData: Record<OwnerKey, OwnerData> = {
  A: { key: 'A', shots: 0, captures: 0, savedDrills: 0, plan: false },
  B: { key: 'B', shots: 0, captures: 0, savedDrills: 0, plan: false },
  G: { key: 'G', shots: 0, captures: 0, savedDrills: 0, plan: false },
};

// ─── Process = fresh module registry ─────────────────────────────────────────

type ReactModule = typeof import('react');
type RNModule = typeof import('react-native');
type TestRendererModule = typeof import('react-test-renderer');
type NavModule = typeof import('@react-navigation/native');
type TabsModule = typeof import('@react-navigation/bottom-tabs');
type StackModule = typeof import('@react-navigation/native-stack');
type LibraryModule = typeof import('../../src/screens/LibraryScreen');
type TabBarModule = typeof import('../../src/navigation/PremiumTabBar');
type AuthModule = typeof import('../../src/auth/authStore');
type ApiSessionModule = typeof import('../../src/account/apiSession');
type KeeperModule = typeof import('../../src/account/sessionKeeper');
type SyncModule = typeof import('../../src/data/syncRuntime');
type ScopeModule = typeof import('../../src/data/accountScope');
type TrainingModule = typeof import('../../src/training/store');
type DbModule = typeof import('../../src/data/db');

/** Mirrors RootStackParams for the routes the harness drives. */
type HarnessParams = {
  Tabs:
    | { screen: 'Home' | 'Library' | 'Add' | 'Performance' | 'Settings' }
    | undefined;
  DrillLibrary: undefined;
  Result: undefined;
  Analyze: undefined;
  ConnectAccount: undefined;
};

interface Proc {
  id: number;
  React: ReactModule;
  RN: RNModule;
  TR: TestRendererModule;
  nav: NavModule;
  tabs: TabsModule;
  stack: StackModule;
  library: LibraryModule;
  tabBar: TabBarModule;
  auth: AuthModule;
  apiSession: ApiSessionModule;
  keeper: KeeperModule;
  sync: SyncModule;
  scope: ScopeModule;
  training: TrainingModule;
  db: DbModule;
  appStateListeners: Set<(state: string) => void>;
  renderer: ReactTestRenderer | null;
  navRef: NavigationContainerRefWithCurrent<HarnessParams>;
  timersAtLoad: number;
  /** Which Apple identity the scripted native sign-in returns next. */
  nextAppleIdentity: 'A' | 'B';
  renderErrors: string[];
}

let procCounter = 0;

function loadProcess(server: ScriptedServer): Proc {
  jest.resetModules();
  procCounter += 1;
  const id = procCounter;
  const React = require('react') as ReactModule;
  const RN = require('react-native') as RNModule;
  const TR = require('react-test-renderer') as TestRendererModule;
  const nav = require('@react-navigation/native') as NavModule;
  const tabs = require('@react-navigation/bottom-tabs') as TabsModule;
  const stack = require('@react-navigation/native-stack') as StackModule;
  const library = require('../../src/screens/LibraryScreen') as LibraryModule;
  const tabBar = require('../../src/navigation/PremiumTabBar') as TabBarModule;
  const auth = require('../../src/auth/authStore') as AuthModule;
  const apiSession =
    require('../../src/account/apiSession') as ApiSessionModule;
  const keeper = require('../../src/account/sessionKeeper') as KeeperModule;
  const sync = require('../../src/data/syncRuntime') as SyncModule;
  const scope = require('../../src/data/accountScope') as ScopeModule;
  const training = require('../../src/training/store') as TrainingModule;
  const db = require('../../src/data/db') as DbModule;

  const appStateListeners = new Set<(state: string) => void>();
  jest.spyOn(RN.AppState, 'addEventListener').mockImplementation(((
    _type: string,
    handler: (state: string) => void,
  ) => {
    appStateListeners.add(handler);
    return { remove: () => appStateListeners.delete(handler) };
  }) as unknown as typeof RN.AppState.addEventListener);

  const proc: Proc = {
    id,
    React,
    RN,
    TR,
    nav,
    tabs,
    stack,
    library,
    tabBar,
    auth,
    apiSession,
    keeper,
    sync,
    scope,
    training,
    db,
    appStateListeners,
    renderer: null,
    navRef: nav.createNavigationContainerRef<HarnessParams>(),
    timersAtLoad: jest.getTimerCount(),
    nextAppleIdentity: 'A',
    renderErrors: [],
  };

  (RN.NativeModules as { PickleAuth?: unknown }).PickleAuth = {
    signInWithApple: async () => {
      const identity = proc.nextAppleIdentity;
      return {
        user: `apple-${identity}`,
        identityToken: `idtok-${identity}`,
        authorizationCode: `code-${identity}`,
        email: `${identity}@example.test`,
        givenName: identity,
        familyName: 'Tester',
      };
    },
  };

  server.currentProc = id;
  server.liveProcs.add(id);
  return proc;
}

/** Real navigator tree mirroring RootNavigator: native stack over the
 * bottom tabs with the real PremiumTabBar; only LibraryScreen is the real
 * screen — the siblings are inert so the harness stays about this unit. */
function buildShell(proc: Proc) {
  const { React, RN, nav, tabs, stack, library, tabBar, auth, scope } = proc;
  const Stack = stack.createNativeStackNavigator<HarnessParams>();
  const Tabs = tabs.createBottomTabNavigator();
  const Stub = () =>
    React.createElement(RN.Text, null, `stub:${nav.useRoute().name}`);

  function MainTabs() {
    return React.createElement(Tabs.Navigator, {
      tabBar: (props: BottomTabBarProps) =>
        React.createElement(tabBar.PremiumTabBar, props),
      screenOptions: { headerShown: false, tabBarHideOnKeyboard: true },
      children: [
        React.createElement(Tabs.Screen, {
          key: 'Home',
          name: 'Home',
          component: Stub,
        }),
        React.createElement(Tabs.Screen, {
          key: 'Library',
          name: 'Library',
          component: library.LibraryScreen,
        }),
        React.createElement(Tabs.Screen, {
          key: 'Add',
          name: 'Add',
          component: Stub,
        }),
        React.createElement(Tabs.Screen, {
          key: 'Performance',
          name: 'Performance',
          component: Stub,
        }),
        React.createElement(Tabs.Screen, {
          key: 'Settings',
          name: 'Settings',
          component: Stub,
        }),
      ],
    });
  }

  function Navigator() {
    const stackScreen = (
      name: keyof HarnessParams,
      component: () => React.ReactElement,
    ) => React.createElement(Stack.Screen, { key: name, name, component });
    // createElement (not JSX: the automatic runtime would bind the top-level
    // React, not this process's) cannot infer the container's ParamList
    // generic from the ref the way JSX does.
    const Container =
      nav.NavigationContainer as unknown as React.ComponentType<{
        ref: NavigationContainerRefWithCurrent<HarnessParams>;
        children?: React.ReactNode;
      }>;
    return React.createElement(
      Container,
      { ref: proc.navRef },
      React.createElement(Stack.Navigator, {
        screenOptions: { headerShown: false },
        children: [
          stackScreen('Tabs', MainTabs),
          stackScreen('DrillLibrary', Stub),
          stackScreen('Result', Stub),
          stackScreen('Analyze', Stub),
          stackScreen('ConnectAccount', Stub),
        ],
      }),
    );
  }

  class Boundary extends React.Component<
    { children: React.ReactNode },
    { failed: string | null }
  > {
    state = { failed: null as string | null };
    static getDerivedStateFromError(error: unknown) {
      return { failed: error instanceof Error ? error.message : String(error) };
    }
    componentDidCatch(error: unknown) {
      proc.renderErrors.push(
        error instanceof Error ? error.message : String(error),
      );
    }
    render() {
      return this.state.failed
        ? React.createElement(RN.Text, null, `boundary:${this.state.failed}`)
        : this.props.children;
    }
  }

  /** Gate mirror: hydrate once, loading until hydrated, signed-out surface
   * without a session, navigator keyed by the desired owner. */
  function Shell() {
    const hydrated = auth.useAuthStore(s => s.hydrated);
    const session = auth.useAuthStore(s => s.session);
    const hydrate = auth.useAuthStore(s => s.hydrate);
    React.useEffect(() => {
      void hydrate();
    }, [hydrate]);
    if (!hydrated) return React.createElement(RN.Text, null, 'gate:loading');
    if (!session) return React.createElement(RN.Text, null, 'gate:signed-out');
    const owner =
      session.provider === 'guest'
        ? 'device-guest'
        : session.canonicalAppUserId
          ? scope.canonicalDataOwner(session.canonicalAppUserId)
          : 'unknown';
    return React.createElement(Navigator, { key: owner });
  }

  return () =>
    React.createElement(Boundary, null, React.createElement(Shell, null));
}

// ─── Scenario schedule ───────────────────────────────────────────────────────

type StepKind =
  | 'focus-library'
  | 'blur-to-home'
  | 'push-over'
  | 'pop'
  | 'background'
  | 'foreground'
  | 'advance'
  | 'unmount'
  | 'remount'
  | 'kill-relaunch'
  | 'kill-relaunch-double-hydrate'
  | 'sign-out'
  | 'sign-in-A'
  | 'sign-in-B'
  | 'switch-account'
  | 'expire-bearer'
  | 'revoke-server'
  | 'db-fault-on'
  | 'db-fault-off'
  | 'retry-reads'
  | 'tab-saved'
  | 'tab-reads'
  | 'settle';

interface Step {
  kind: StepKind;
  /** For 'advance': fake ms. For every other step: fake ms to advance BEFORE
   * the step (0 = interrupt at the very next microtask boundary). */
  ms: number;
}

type InitialState = 'signed-in-A' | 'signed-in-B' | 'guest' | 'signed-out';

interface Scenario {
  name: string;
  seed: number;
  initial: InitialState;
  owners: Record<OwnerKey, OwnerData>;
  maxLatencyMs: number;
  bearerLifeMs: number;
  steps: Step[];
}

const INTERRUPT_MS = [0, 0, 1, 5, 20, 60, 150, 400, 1200] as const;

const STEP_POOL: readonly StepKind[] = [
  'focus-library',
  'focus-library',
  'blur-to-home',
  'push-over',
  'pop',
  'background',
  'foreground',
  'advance',
  'unmount',
  'remount',
  'kill-relaunch',
  'kill-relaunch-double-hydrate',
  'sign-out',
  'sign-in-A',
  'sign-in-B',
  'switch-account',
  'expire-bearer',
  'revoke-server',
  'db-fault-on',
  'db-fault-off',
  'retry-reads',
  'tab-saved',
  'tab-reads',
  'settle',
];

function seededOwners(rng: Rng): Record<OwnerKey, OwnerData> {
  const make = (key: OwnerKey): OwnerData => ({
    key,
    shots: rng.int(0, 3),
    captures: rng.int(0, 2),
    savedDrills: key === 'G' ? 0 : rng.int(0, 2),
    plan: key === 'G' ? false : rng.chance(0.4),
  });
  return { A: make('A'), B: make('B'), G: make('G') };
}

function seededScenario(seed: number): Scenario {
  const rng = new Rng(seed);
  const owners = seededOwners(rng);
  // Owners with data make the isolation invariant meaningful.
  if (owners.A.shots + owners.A.captures === 0) owners.A.shots = 1;
  if (owners.B.shots + owners.B.captures === 0) owners.B.captures = 1;
  const initial = rng.pick<InitialState>([
    'signed-in-A',
    'signed-in-A',
    'signed-in-B',
    'guest',
    'signed-out',
  ]);
  const stepCount = rng.int(6, 14);
  const steps: Step[] = [];
  for (let i = 0; i < stepCount; i += 1) {
    const kind = rng.pick(STEP_POOL);
    steps.push({
      kind,
      ms: kind === 'advance' ? rng.int(0, 2_500) : rng.pick(INTERRUPT_MS),
    });
  }
  steps.push({ kind: 'focus-library', ms: 0 }, { kind: 'settle', ms: 0 });
  return {
    name: `seed-${seed}`,
    seed,
    initial,
    owners,
    maxLatencyMs: rng.pick([0, 40, 300, 1_200]),
    bearerLifeMs: rng.pick([3_600_000, 3_600_000, 90_000, 61_000]),
    steps,
  };
}

const FIXED_OWNERS: Record<OwnerKey, OwnerData> = {
  A: { key: 'A', shots: 2, captures: 1, savedDrills: 2, plan: true },
  B: { key: 'B', shots: 1, captures: 2, savedDrills: 1, plan: false },
  G: { key: 'G', shots: 1, captures: 1, savedDrills: 0, plan: false },
};

function fixed(
  name: string,
  initial: InitialState,
  steps: [StepKind, number][],
  options: { maxLatencyMs?: number; bearerLifeMs?: number } = {},
): Scenario {
  return {
    name,
    seed: -1,
    initial,
    owners: FIXED_OWNERS,
    maxLatencyMs: options.maxLatencyMs ?? 300,
    bearerLifeMs: options.bearerLifeMs ?? 3_600_000,
    steps: [
      ...steps.map(([kind, ms]) => ({ kind, ms })),
      { kind: 'focus-library', ms: 0 },
      { kind: 'settle', ms: 0 },
    ],
  };
}

const FIXED_SCENARIOS: Scenario[] = [
  fixed('blur-mid-read-then-refocus', 'signed-in-A', [
    ['focus-library', 0],
    ['blur-to-home', 1],
    ['focus-library', 5],
  ]),
  fixed('unmount-mid-read', 'signed-in-A', [
    ['focus-library', 0],
    ['unmount', 1],
    ['remount', 200],
  ]),
  fixed('background-foreground-mid-read', 'signed-in-A', [
    ['focus-library', 0],
    ['background', 1],
    ['foreground', 400],
  ]),
  fixed('kill-relaunch-mid-read', 'signed-in-A', [
    ['focus-library', 0],
    ['kill-relaunch', 1],
  ]),
  fixed('kill-relaunch-double-hydrate', 'signed-in-A', [
    ['focus-library', 0],
    ['kill-relaunch-double-hydrate', 5],
  ]),
  fixed('account-switch-mid-read-A-to-B', 'signed-in-A', [
    ['focus-library', 0],
    ['switch-account', 1],
  ]),
  fixed('account-switch-mid-saved-B-to-A', 'signed-in-B', [
    ['focus-library', 0],
    ['tab-saved', 5],
    ['switch-account', 1],
    ['tab-saved', 0],
  ]),
  fixed('guest-connect-account', 'guest', [
    ['focus-library', 0],
    ['sign-in-A', 5],
  ]),
  fixed('bearer-rotation-mid-request', 'signed-in-A', [
    ['focus-library', 0],
    ['expire-bearer', 1],
    ['tab-saved', 5],
  ]),
  fixed(
    'keeper-rotates-during-session',
    'signed-in-A',
    [
      ['focus-library', 0],
      ['advance', 120_000],
      ['tab-saved', 0],
    ],
    { bearerLifeMs: 90_000 },
  ),
  fixed('server-revoke-later-then-relaunch', 'signed-in-A', [
    ['focus-library', 0],
    ['revoke-server', 20],
    ['tab-saved', 0],
    ['expire-bearer', 0],
    ['tab-reads', 0],
    ['blur-to-home', 0],
    ['focus-library', 0],
    ['settle', 0],
    ['kill-relaunch', 0],
  ]),
  fixed('db-fault-later-then-retry', 'signed-in-A', [
    ['focus-library', 0],
    ['db-fault-on', 0],
    ['blur-to-home', 0],
    ['focus-library', 0],
    ['settle', 0],
    ['db-fault-off', 0],
    ['retry-reads', 0],
  ]),
  fixed('sign-out-mid-read-then-sign-in-B', 'signed-in-A', [
    ['focus-library', 0],
    ['sign-out', 1],
    ['sign-in-B', 20],
  ]),
  fixed('push-over-mid-read-pop', 'signed-in-A', [
    ['focus-library', 0],
    ['push-over', 1],
    ['pop', 50],
  ]),
];

// ─── Iteration runner ────────────────────────────────────────────────────────

/** How the final training check reached ready: already there, via the Saved
 * tab's "Try again", only by leaving and re-entering the tab, or not at all. */
type TrainingRecoveryPath = 'n/a' | 'ready' | 'retry' | 'refocus' | 'failed';

interface Row {
  scenario: string;
  seed: number;
  inputs: {
    initial: InitialState;
    owners: Record<OwnerKey, OwnerData>;
    maxLatencyMs: number;
    bearerLifeMs: number;
    steps: Step[];
  };
  observed: {
    processes: number;
    timersAfterTeardown: string[];
    drainRounds: number;
    requestLog: string[];
    requests: number;
    unexpectedRoutes: string[];
    deadProcRequests: number;
    relaunches: number;
    rotations: number;
    unauthorized: number;
    stepsRun: number;
    finalOwner: string | null;
    finalText: string;
    listenersAfterTeardown: number;
    timersDelta: number;
    sqlCalls: number;
    guestRelaunchesLostToDbFault: number;
    staleOwnerRenders: number;
    trainingErrorsSeen: number;
    trainingRecoveryPath: TrainingRecoveryPath;
    checks: number;
  };
  invariants: Record<string, boolean>;
  failed: string[];
  notes: string[];
  ok: boolean;
  durationMs: number;
}

const IS_ACT_ENV = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };

function renderedJson(proc: Proc): string {
  if (!proc.renderer) return '';
  try {
    return JSON.stringify(proc.renderer.toJSON()) ?? '';
  } catch {
    return '<toJSON-failed>';
  }
}

function renderedText(proc: Proc): string {
  if (!proc.renderer) return '<unmounted>';
  try {
    return proc.renderer.root
      .findAllByType(proc.RN.Text)
      .map(node => {
        const children = node.props['children'] as unknown;
        return Array.isArray(children)
          ? children.map(String).join('')
          : String(children);
      })
      .join('|');
  } catch {
    return '<no-text>';
  }
}

function sessionOwner(proc: Proc): OwnerKey | 'none' {
  const session = proc.auth.useAuthStore.getState().session;
  if (!session) return 'none';
  if (session.provider === 'guest') return 'G';
  if (session.canonicalAppUserId === ACCOUNT_ID.A) return 'A';
  if (session.canonicalAppUserId === ACCOUNT_ID.B) return 'B';
  return 'none';
}

async function runScenario(scenario: Scenario): Promise<Row> {
  const started = wallClock.now();
  const rng = new Rng(scenario.seed >= 0 ? scenario.seed : 7_919);
  const invariants: Record<string, boolean> = {
    crossUserIsolation: true,
    readsMatchOwner: true,
    noEmptyStateOnFault: true,
    noStuckLoading: true,
    trainingRecovers: true,
    revokeSignsOut: true,
    rehydrateIdempotent: true,
    noLeakedHandles: true,
    noErrorBoundary: true,
    noUnexpectedRoutes: true,
  };
  const notes: string[] = [];
  const fail = (name: string, note: string) => {
    invariants[name] = false;
    notes.push(`${name}: ${note}`);
  };

  ownerData = scenario.owners;
  const sqlite = loadNodeSqlite();
  if (!sqlite) throw new Error('node:sqlite unavailable (Node >= 22.13)');
  mockDisk.sqlite = new sqlite.DatabaseSync(':memory:');
  mockDisk.faultReads = false;
  mockDisk.keychain = new Map();
  mockDisk.sqlCalls = 0;

  const server = new ScriptedServer(rng);
  server.maxLatencyMs = scenario.maxLatencyMs;
  server.bearerLifeMs = scenario.bearerLifeMs;
  (globalThis as { fetch: unknown }).fetch = server.fetch;
  jest.setSystemTime(new Date('2026-09-05T12:00:00.000Z'));
  const randomSpy = jest
    .spyOn(Math, 'random')
    .mockImplementation(() => rng.next());

  let relaunches = 0;
  let guestRelaunchesLostToDbFault = 0;
  let staleOwnerRenders = 0;
  let trainingErrorsSeen = 0;
  let checks = 0;
  let revokedOwner: OwnerKey | null = null;
  let expectedPersistedOwner: OwnerKey | 'none' =
    scenario.initial === 'signed-in-A'
      ? 'A'
      : scenario.initial === 'signed-in-B'
        ? 'B'
        : scenario.initial === 'guest'
          ? 'G'
          : 'none';
  let faultWindowSinceLastRead = false;

  // ── Seed the disk through the production schema (a previous run's data).
  let proc = loadProcess(server);
  {
    const dbHandle = proc.db.getDb();
    const inner = mockDisk.sqlite;
    const ownerKeyFor = (key: OwnerKey) =>
      key === 'G'
        ? 'device-guest'
        : proc.scope.canonicalDataOwner(ACCOUNT_ID[key]);
    for (const owner of Object.values(scenario.owners)) {
      const ownerKey = ownerKeyFor(owner.key);
      for (let i = 1; i <= owner.shots; i += 1) {
        const id = uuidFor(owner.key, 's', i);
        const shotType = `SHOT${owner.key}${i}`;
        inner
          .prepare(
            `INSERT INTO local_shot (owner_key, id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, favorite, payload)
             VALUES (?, ?, NULL, ?, ?, ?, ?, 'scored', 'real', 0, ?)`,
          )
          .run(
            ownerKey,
            id,
            shotType,
            `2026-09-0${i}T09:00:00.000Z`,
            60 + i,
            0.9,
            JSON.stringify({ id, shotType, source: 'real' }),
          );
      }
      for (let i = 1; i <= owner.captures; i += 1) {
        const id = uuidFor(owner.key, 'c', i);
        inner
          .prepare(
            `INSERT INTO local_capture (owner_key, id, uri, shot_type, captured_at, duration_ms, fps, width, height, status, payload)
             VALUES (?, ?, ?, ?, ?, 4000, 30, 1080, 1920, 'awaiting_model', NULL)`,
          )
          .run(
            ownerKey,
            id,
            `file:///captures/${owner.key}-${i}.mov`,
            `CLIP${owner.key}${i}`,
            `2026-09-0${i}T10:00:00.000Z`,
          );
      }
    }
    if (scenario.initial === 'guest') {
      inner
        .prepare(`INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`)
        .run('auth.local-mode', JSON.stringify({ version: 1, mode: 'guest' }));
    } else if (
      scenario.initial === 'signed-in-A' ||
      scenario.initial === 'signed-in-B'
    ) {
      const account = scenario.initial === 'signed-in-A' ? 'A' : 'B';
      // A previous run signed in and persisted its refresh token.
      const minted = await bootstrapDirect(server, account);
      mockDisk.keychain.set('com.picklesensei.auth.session', {
        username: 'session',
        password: JSON.stringify({
          version: 1,
          provider: 'apple',
          canonicalAppUserId: ACCOUNT_ID[account],
          refreshToken: minted.refreshToken,
          email: `${account}@example.test`,
          displayName: `${account} Tester`,
        }),
      });
    }
    dbHandle.close();
  }
  // The seeding boot is not a launch; the first real launch is a cold one.
  server.liveProcs.delete(proc.id);
  jest.clearAllTimers();
  timerOrigins.clear();

  // ── Helpers bound to the current process.
  const act = async (fn: () => void | Promise<void>) => {
    await proc.TR.act(async () => {
      await fn();
    });
  };
  const flush = async () => {
    await act(async () => {
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
    });
  };
  const advance = async (ms: number) => {
    if (ms > 0) {
      await act(async () => {
        jest.advanceTimersByTime(ms);
      });
    }
    await flush();
  };
  const busy = () => {
    const training = proc.training.useTrainingStore.getState();
    const text = renderedText(proc);
    return (
      server.inflight(proc.id) > 0 ||
      proc.auth.useAuthStore.getState().busy ||
      !proc.auth.useAuthStore.getState().hydrated ||
      training.savedStatus === 'loading' ||
      training.planStatus === 'loading' ||
      text.includes('Opening your library') ||
      text.includes('gate:loading')
    );
  };
  const settle = async (capMs = 12_000) => {
    let elapsed = 0;
    await flush();
    while (busy() && elapsed < capMs) {
      await advance(25);
      elapsed += 25;
    }
    // Let any follow-up request that the settled state triggers land too.
    await advance(1);
    let extra = 0;
    while (busy() && extra < 2_000) {
      await advance(25);
      extra += 25;
    }
  };
  const mount = () => {
    const Root = buildShell(proc);
    proc.TR.act(() => {
      proc.renderer = proc.TR.create(proc.React.createElement(Root, null));
    });
  };
  const unmount = () => {
    const renderer = proc.renderer;
    if (!renderer) return;
    proc.TR.act(() => {
      renderer.unmount();
    });
    proc.renderer = null;
  };
  const navigateLibrary = () => {
    const ref = proc.navRef.current;
    if (!ref) return false;
    proc.TR.act(() => {
      ref.navigate('Tabs', { screen: 'Library' });
    });
    return true;
  };
  const pressText = (text: string) => {
    if (!proc.renderer) return false;
    // Find a Text with exactly this content, then the nearest pressable parent.
    const texts = proc.renderer.root.findAll(
      node => node.type === proc.RN.Text && node.props['children'] === text,
    );
    for (const textNode of texts) {
      let cursor = textNode.parent;
      while (cursor) {
        if (typeof cursor.props['onPress'] === 'function') {
          const onPress = cursor.props['onPress'] as () => void;
          proc.TR.act(() => onPress());
          return true;
        }
        cursor = cursor.parent;
      }
    }
    return false;
  };
  const libraryFocused = () => {
    const ref = proc.navRef.current;
    if (!ref || !proc.renderer) return false;
    const route = ref.getCurrentRoute();
    return String(route?.name) === 'Library';
  };
  const emitAppState = (state: 'active' | 'background') => {
    proc.TR.act(() => {
      for (const listener of [...proc.appStateListeners]) listener(state);
    });
  };
  const killProcess = () => {
    // The OS kills the process: no cleanups run, timers die with it, only
    // the disk + Keychain survive. In-flight requests never land.
    server.liveProcs.delete(proc.id);
    proc.renderer = null;
    jest.clearAllTimers();
    timerOrigins.clear();
    server.dropPendingTimers();
  };
  const launch = async (doubleHydrate: boolean) => {
    proc = loadProcess(server);
    relaunches += 1;
    mount();
    if (doubleHydrate) {
      // Re-entrant hydrate (RootErrorBoundary retry / Gate remount) while the
      // launch refresh may be in flight.
      await advance(rng.pick(INTERRUPT_MS));
      await act(async () => {
        void proc.auth.useAuthStore.getState().hydrate();
      });
    }
  };

  // ── Invariant checks at a settled point.
  const check = (label: string) => {
    checks += 1;
    const owner = sessionOwner(proc);
    const rendered = renderedJson(proc);
    const seen = markersIn(rendered);
    const text = renderedText(proc);
    if (proc.renderErrors.length > 0 || text.includes('boundary:')) {
      fail('noErrorBoundary', `${label}: ${proc.renderErrors.join(' / ')}`);
    }
    for (const marker of seen) {
      if (marker !== owner) {
        staleOwnerRenders += 1;
        const otherHuman =
          (marker === 'A' || marker === 'B') && marker !== owner;
        if (otherHuman || owner === 'none') {
          fail(
            'crossUserIsolation',
            `${label}: rendered ${marker} data while session owner is ${owner}`,
          );
        }
      }
    }
    if (text.includes('Opening your library')) {
      fail('noStuckLoading', `${label}: loading state survived settle`);
    }
    if (owner !== 'none' && libraryFocused() && proc.renderer) {
      const data = scenario.owners[owner];
      const total = data.shots + data.captures;
      const readsTab =
        !text.includes('Saved drills|') || text.includes('analyzed');
      const showsCounts = /(\d+) analyzed read/.exec(text);
      const showsEmpty = text.includes('Your measured reads, in one place.');
      const showsError = text.includes(proc.library.READS_LOAD_ERROR_TITLE);
      if (readsTab && !text.includes('Saved drills|')) {
        if (showsError) {
          if (!faultWindowSinceLastRead && !mockDisk.faultReads) {
            fail(
              'readsMatchOwner',
              `${label}: read error shown without a fault window`,
            );
          }
        } else if (showsCounts) {
          const analyzed = Number(showsCounts[1]);
          const pending = /(\d+) pending clip/.exec(text);
          const pendingCount = pending ? Number(pending[1]) : -1;
          if (analyzed !== data.shots || pendingCount !== data.captures) {
            fail(
              'readsMatchOwner',
              `${label}: owner ${owner} shows ${analyzed}/${pendingCount}, seeded ${data.shots}/${data.captures}`,
            );
          }
        } else if (showsEmpty) {
          if (total > 0) {
            fail(
              mockDisk.faultReads || faultWindowSinceLastRead
                ? 'noEmptyStateOnFault'
                : 'readsMatchOwner',
              `${label}: owner ${owner} has ${total} rows but the empty state rendered`,
            );
          }
        } else if (text.includes('Reads|Saved drills')) {
          // Header rendered but neither counts, empty, nor error: loading
          // was already checked above; anything else is a stuck render.
          if (!text.includes('Opening your library')) {
            fail(
              'noStuckLoading',
              `${label}: reads tab settled without content`,
            );
          }
        }
      }
      const training = proc.training.useTrainingStore.getState();
      if (owner === 'A' || owner === 'B') {
        if (
          training.savedStatus === 'error' ||
          training.planStatus === 'error'
        ) {
          trainingErrorsSeen += 1;
        }
      }
    }
    if (revokedOwner && revokedOwner === owner) {
      // The account was revoked server-side; once its bearer AND refresh are
      // refused the app must have signed out. Checked at the dedicated step.
    }
  };

  // ── Launch.
  await launch(false);
  await settle();
  check('launch');
  if (sessionOwner(proc) !== expectedPersistedOwner) {
    fail(
      'rehydrateIdempotent',
      `launch: hydrated as ${sessionOwner(proc)}, persisted ${expectedPersistedOwner}`,
    );
  }

  let stepsRun = 0;
  for (const step of scenario.steps) {
    if (step.kind !== 'advance') await advance(step.ms);
    const owner = sessionOwner(proc);
    switch (step.kind) {
      case 'advance':
        await advance(step.ms);
        break;
      case 'settle':
        await settle();
        break;
      case 'focus-library':
        if (proc.renderer && proc.navRef.current) {
          faultWindowSinceLastRead = mockDisk.faultReads;
          navigateLibrary();
        }
        break;
      case 'blur-to-home':
        if (proc.navRef.current) {
          proc.TR.act(() => {
            proc.navRef.current?.navigate('Tabs', { screen: 'Home' });
          });
        }
        break;
      case 'push-over':
        if (proc.navRef.current) {
          proc.TR.act(() => {
            proc.navRef.current?.navigate('DrillLibrary');
          });
        }
        break;
      case 'pop':
        if (proc.navRef.current?.canGoBack()) {
          proc.TR.act(() => {
            proc.navRef.current?.goBack();
          });
        }
        break;
      case 'background':
        emitAppState('background');
        break;
      case 'foreground':
        emitAppState('active');
        break;
      case 'unmount':
        unmount();
        break;
      case 'remount':
        if (!proc.renderer) mount();
        break;
      case 'kill-relaunch':
      case 'kill-relaunch-double-hydrate': {
        killProcess();
        const dbFaultedAtLaunch = mockDisk.faultReads;
        await launch(step.kind === 'kill-relaunch-double-hydrate');
        await settle();
        const landed = sessionOwner(proc);
        if (landed !== expectedPersistedOwner) {
          // The guest marker is the one piece of sign-in state kept in
          // SQLite (accounts live in the Keychain), so a launch whose local
          // database is failing cannot see it: the contract is then signed
          // out WITH the local-data error surfaced — never a different
          // owner, never a crash — and the marker survives for the next
          // healthy launch.
          const localDataError =
            proc.auth.useAuthStore.getState().localDataError;
          if (
            expectedPersistedOwner === 'G' &&
            dbFaultedAtLaunch &&
            landed === 'none' &&
            localDataError !== null
          ) {
            guestRelaunchesLostToDbFault += 1;
          } else {
            fail(
              'rehydrateIdempotent',
              `relaunch ${relaunches}: hydrated as ${landed}, persisted ${expectedPersistedOwner}${dbFaultedAtLaunch ? ' (local database faulted at launch)' : ''}`,
            );
          }
        }
        break;
      }
      case 'sign-out':
        if (owner !== 'none') {
          expectedPersistedOwner = 'none';
          await act(async () => {
            void proc.auth.useAuthStore.getState().signOut();
          });
        }
        break;
      case 'sign-in-A':
      case 'sign-in-B': {
        const target = step.kind === 'sign-in-A' ? 'A' : 'B';
        // Sign-in is reachable from the signed-out gate or from a guest
        // session (Connect account); a synced account signs out first.
        if (owner === 'A' || owner === 'B') break;
        if (revokedOwner === target) break;
        proc.nextAppleIdentity = target;
        expectedPersistedOwner = target;
        await act(async () => {
          void proc.auth.useAuthStore.getState().signInWithApple();
        });
        break;
      }
      case 'switch-account': {
        if (owner !== 'A' && owner !== 'B') break;
        const target = owner === 'A' ? 'B' : 'A';
        if (revokedOwner === target) break;
        proc.nextAppleIdentity = target;
        expectedPersistedOwner = target;
        await act(async () => {
          const store = proc.auth.useAuthStore.getState();
          void store.signOut().then(() => store.signInWithApple());
        });
        break;
      }
      case 'expire-bearer':
        server.expireBearers();
        break;
      case 'revoke-server': {
        if (owner !== 'A' && owner !== 'B') break;
        server.revokeAccount(owner);
        revokedOwner = owner;
        expectedPersistedOwner = 'none';
        // Force the app to notice: the next training request 401s, the
        // keeper's refresh is refused, the ONE implicit sign-out fires.
        server.expireBearers();
        break;
      }
      case 'db-fault-on':
        mockDisk.faultReads = true;
        break;
      case 'db-fault-off':
        mockDisk.faultReads = false;
        break;
      case 'retry-reads':
        pressText('Try again');
        break;
      case 'tab-saved':
        pressText('Saved drills');
        break;
      case 'tab-reads':
        pressText('Reads');
        break;
    }
    stepsRun += 1;
    // Interrupt steps are checked after they settle so the invariant reads
    // a stable tree; the interleaving itself came from `ms`.
    await settle();
    if (step.kind === 'revoke-server' && revokedOwner) {
      // Drive a request so the 401 → refresh → 401 chain happens now.
      pressText('Saved drills');
      await settle();
      pressText('Reads');
      await settle();
    }
    if (revokedOwner) {
      const s = proc.auth.useAuthStore.getState();
      const stillRevoked = sessionOwner(proc) === revokedOwner;
      const vault = mockDisk.keychain.get('com.picklesensei.auth.session');
      const anyRequestSinceRevoke = server.requests.some(
        r => r.status === 401 && r.path !== '/v1/auth/refresh',
      );
      if (anyRequestSinceRevoke && stillRevoked && !s.busy) {
        // A 401 on a route while revoked must have chained into the keeper's
        // refresh refusal by the time everything settled.
        const refreshRefused = server.requests.some(
          r => r.path === '/v1/auth/refresh' && r.status === 401,
        );
        if (refreshRefused) {
          fail(
            'revokeSignsOut',
            `after revoke: session still ${revokedOwner} though refresh was refused`,
          );
        }
      }
      if (!stillRevoked && vault) {
        fail('revokeSignsOut', 'after revoke: Keychain still holds a session');
      }
    }
    check(`step ${stepsRun} ${step.kind}`);
  }

  // ── Final: training must have recovered for a live synced owner with a
  // healthy (non-revoked) server when the Library is focused. Recovery paths
  // the real app offers, tried in order and recorded: already ready → the
  // Saved tab's "Try again" (reloads saved drills only) → leaving and
  // re-entering the tab (focus effect reloads saved drills AND the plan).
  const finalOwner = sessionOwner(proc);
  let trainingRecoveryPath: TrainingRecoveryPath = 'n/a';
  if ((finalOwner === 'A' || finalOwner === 'B') && proc.renderer) {
    pressText('Saved drills');
    await settle();
    let training = proc.training.useTrainingStore.getState();
    const ready = () =>
      training.savedStatus === 'ready' && training.planStatus === 'ready';
    trainingRecoveryPath = 'ready';
    if (!ready()) {
      trainingRecoveryPath = 'retry';
      pressText('Try again');
      await settle();
      training = proc.training.useTrainingStore.getState();
    }
    if (!ready() && proc.navRef.current) {
      trainingRecoveryPath = 'refocus';
      proc.TR.act(() => {
        proc.navRef.current?.navigate('Tabs', { screen: 'Home' });
      });
      await settle();
      navigateLibrary();
      await settle();
      pressText('Saved drills');
      await settle();
      training = proc.training.useTrainingStore.getState();
    }
    if (!ready()) {
      trainingRecoveryPath = 'failed';
      fail(
        'trainingRecovers',
        `final: saved=${training.savedStatus} plan=${training.planStatus} (${training.savedError?.message ?? ''})`,
      );
    } else {
      const data = scenario.owners[finalOwner];
      if (training.savedDrills.length !== data.savedDrills) {
        fail(
          'trainingRecovers',
          `final: ${training.savedDrills.length} saved drills, seeded ${data.savedDrills}`,
        );
      }
      const savedText = renderedText(proc);
      for (const marker of markersIn(renderedJson(proc))) {
        if (marker !== finalOwner) {
          fail(
            'crossUserIsolation',
            `final saved tab: rendered ${marker} while owner ${finalOwner}`,
          );
        }
      }
      if (
        data.savedDrills > 0 &&
        !savedText.includes(`${data.savedDrills} saved`)
      ) {
        fail(
          'trainingRecovers',
          `final: saved count line missing in "${savedText.slice(0, 200)}"`,
        );
      }
    }
    check('final saved tab');
  }
  const finalText = renderedText(proc);

  // ── Teardown. The screen unmounts first: whatever it registered must be
  // gone once its effects clean up. Then the app quiesces (in-flight launch
  // refresh / sync land, since the keeper + sync runtime are owned by the
  // signed-in session, not the screen) and the session-level services stop;
  // after that nothing may remain registered and timers must be back at the
  // process baseline.
  const listenersBeforeUnmount = proc.appStateListeners.size;
  unmount();
  await flush();
  const listenersAfterUnmount = proc.appStateListeners.size;
  if (listenersAfterUnmount > listenersBeforeUnmount) {
    fail(
      'noLeakedHandles',
      `${listenersAfterUnmount - listenersBeforeUnmount} AppState listener(s) added by the screen survive its unmount`,
    );
  }
  for (let round = 0; round < 8 && server.inflight(proc.id) > 0; round += 1) {
    await act(async () => {
      jest.runOnlyPendingTimers();
    });
    await flush();
  }
  proc.keeper.stopSessionKeeper();
  proc.sync.clearSyncRuntime();
  proc.apiSession.clearApiSession();
  await flush();
  const listenersAfterTeardown = proc.appStateListeners.size;
  // React's act() leaves its own queueMicrotask jobs in the fake clock (jest
  // counts them as timers) and may enqueue more right after an act() settles;
  // zero-length ticks drain those without firing any real timer, so what
  // remains was armed by application or library code.
  const drainActJobs = async () => {
    for (let i = 0; i < 3; i += 1) {
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    }
  };
  await drainActJobs();
  const pendingTimers = () =>
    jest.getTimerCount() - server.pendingServerTimers() - proc.timersAtLoad;
  const appOwned = (origin: string) =>
    origin.includes('/apps/mobile/src/') && !origin.includes('node_modules');
  // Rule: once the session services stopped, whatever is still armed (a
  // library one-shot such as bottom-tabs' 32ms "transition end" timer, or an
  // app one-shot orphaned by an interrupted flow) must drain within a few
  // rounds without re-arming, and firing it must not touch sign-in state —
  // a late callback that changes the session/owner is exactly the
  // "state from a previous launch" the lens is after. App-owned one-shots
  // that were still pending are kept in the row for the report.
  const originsAfterTeardown = [...timerOrigins.values()];
  const appTimersAfterTeardown = originsAfterTeardown.filter(appOwned);
  const authBeforeDrain = proc.auth.useAuthStore.getState();
  const ownerBeforeDrain = proc.scope.getActiveDataOwner();
  let drainRounds = 0;
  while (pendingTimers() > 0 && drainRounds < 3) {
    drainRounds += 1;
    await act(async () => {
      jest.runOnlyPendingTimers();
    });
    await flush();
    await drainActJobs();
  }
  const timersDelta = pendingTimers();
  const authAfterDrain = proc.auth.useAuthStore.getState();
  if (listenersAfterTeardown !== 0) {
    fail(
      'noLeakedHandles',
      `${listenersAfterTeardown} AppState listener(s) remain after unmount + keeper/sync stop`,
    );
  }
  if (
    authAfterDrain.session?.canonicalAppUserId !==
      authBeforeDrain.session?.canonicalAppUserId ||
    authAfterDrain.session?.provider !== authBeforeDrain.session?.provider ||
    authAfterDrain.hydrated !== authBeforeDrain.hydrated ||
    proc.scope.getActiveDataOwner() !== ownerBeforeDrain
  ) {
    fail(
      'noLeakedHandles',
      `late timer callback changed sign-in state after teardown (${appTimersAfterTeardown.join(' | ')})`,
    );
  }
  if (timersDelta > 0) {
    const origins = [...timerOrigins.values()].slice(-timersDelta);
    fail(
      'noLeakedHandles',
      `${timersDelta} timer(s) re-armed through ${drainRounds} drain round(s) after teardown: ${origins.join(' | ')}`,
    );
  }
  if (server.deadProcRequests > 0) {
    fail(
      'noLeakedHandles',
      `${server.deadProcRequests} request(s) issued by a killed process`,
    );
  }
  if (server.unexpected.length > 0) {
    fail('noUnexpectedRoutes', server.unexpected.join(', '));
  }

  jest.clearAllTimers();
  timerOrigins.clear();
  randomSpy.mockRestore();
  mockDisk.sqlite.close();
  mockDisk.sqlite = null;

  const failed = Object.entries(invariants)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  return {
    scenario: scenario.name,
    seed: scenario.seed,
    inputs: {
      initial: scenario.initial,
      owners: scenario.owners,
      maxLatencyMs: scenario.maxLatencyMs,
      bearerLifeMs: scenario.bearerLifeMs,
      steps: scenario.steps,
    },
    observed: {
      processes: relaunches,
      timersAfterTeardown: originsAfterTeardown,
      drainRounds,
      requestLog: server.requests
        .slice(0, 80)
        .map(
          r =>
            `${r.at}ms p${r.proc} ${r.method} ${r.path} -> ${r.status ?? 'dropped'}${r.bearer ? ` [${r.bearer}]` : ''}`,
        ),
      requests: server.requests.length,
      unexpectedRoutes: server.unexpected,
      deadProcRequests: server.deadProcRequests,
      relaunches: relaunches - 1,
      rotations: server.requests.filter(
        r => r.path === '/v1/auth/refresh' && r.status === 200,
      ).length,
      unauthorized: server.requests.filter(r => r.status === 401).length,
      stepsRun,
      finalOwner,
      finalText: finalText.slice(0, 400),
      listenersAfterTeardown,
      timersDelta,
      sqlCalls: mockDisk.sqlCalls,
      guestRelaunchesLostToDbFault,
      staleOwnerRenders,
      trainingErrorsSeen,
      trainingRecoveryPath,
      checks,
    },
    invariants,
    failed,
    notes,
    ok: failed.length === 0,
    durationMs: Math.round(wallClock.now() - started),
  };
}

/** A previous run's sign-in: mint a server session directly (what the
 * bootstrap route would have returned) so the vault can hold its refresh
 * token before the first launch under test. */
async function bootstrapDirect(
  server: ScriptedServer,
  account: 'A' | 'B',
): Promise<{ refreshToken: string }> {
  const savedLatency = server.maxLatencyMs;
  server.maxLatencyMs = 0;
  const response = await server.fetch(`${API_BASE}/v1/account/bootstrap`, {
    method: 'POST',
    headers: { Authorization: `Bearer idtok-${account}` },
    body: '{}',
  });
  server.maxLatencyMs = savedLatency;
  const payload = (await response.json()) as {
    session: { refreshToken: string };
  };
  server.requests.length = 0;
  return { refreshToken: payload.session.refreshToken };
}

// ─── Artifacts ───────────────────────────────────────────────────────────────

function artifactDir(): string {
  const configured = nodeProcess.env['STRESS_ARTIFACT_DIR'];
  const dir =
    configured && configured.length > 0
      ? configured
      : path.resolve(
          __dirname,
          '../../../../artifacts/stress-libraryscreen-lifecycle',
        );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Suite ───────────────────────────────────────────────────────────────────

const ITERATIONS = Number(nodeProcess.env['STRESS_ITER'] ?? 12);
const SEED_BASE = Number(nodeProcess.env['STRESS_SEED_BASE'] ?? 1_000);
const ONLY_SEED = nodeProcess.env['STRESS_SEED'];

const realFetch = globalThis.fetch;
const rows: Row[] = [];

/**
 * Records where every live (fake) timer was created so a leak is reported by
 * origin (`src/account/sessionKeeper.ts:99`) instead of as a bare count.
 */
const timerOrigins = new Map<unknown, string>();
function originOf(stack: string | undefined): string {
  const frames = (stack ?? '')
    .split('\n')
    .slice(1)
    .map(line => line.trim().replace(/^at\s+/, ''))
    .filter(line => !line.includes('ledgerSet'));
  const app = frames.find(
    line =>
      line.includes('/apps/mobile/src/') && !line.includes('node_modules'),
  );
  return app ?? frames.slice(0, 3).join(' < ');
}
function installTimerLedger(): () => void {
  const g = globalThis as unknown as {
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
    setInterval: typeof setInterval;
    clearInterval: typeof clearInterval;
    setImmediate: typeof setImmediate;
    clearImmediate: typeof clearImmediate;
    requestAnimationFrame: (cb: (t: number) => void) => number;
    cancelAnimationFrame: (id: number) => void;
  };
  const original = {
    setTimeout: g.setTimeout,
    clearTimeout: g.clearTimeout,
    setInterval: g.setInterval,
    clearInterval: g.clearInterval,
    setImmediate: g.setImmediate,
    clearImmediate: g.clearImmediate,
    requestAnimationFrame: g.requestAnimationFrame,
    cancelAnimationFrame: g.cancelAnimationFrame,
  };
  const ledgerSetImmediate = ((
    handler: (...args: unknown[]) => void,
    ...args: unknown[]
  ) => {
    const origin = `setImmediate ${originOf(new Error().stack)}`;
    const id: unknown = original.setImmediate(
      (...inner: unknown[]) => {
        timerOrigins.delete(id);
        handler(...inner);
      },
      ...args,
    );
    timerOrigins.set(id, origin);
    return id;
  }) as unknown as typeof setImmediate;
  const ledgerRaf = (cb: (t: number) => void) => {
    const origin = `requestAnimationFrame ${originOf(new Error().stack)}`;
    let id = 0;
    id = original.requestAnimationFrame(t => {
      timerOrigins.delete(id);
      cb(t);
    });
    timerOrigins.set(id, origin);
    return id;
  };
  const ledgerSetTimeout = ((
    handler: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    const origin = `setTimeout(${ms ?? 0}ms) ${originOf(new Error().stack)}`;
    const id: unknown = original.setTimeout(
      (...inner: unknown[]) => {
        timerOrigins.delete(id);
        handler(...inner);
      },
      ms,
      ...args,
    );
    timerOrigins.set(id, origin);
    return id;
  }) as unknown as typeof setTimeout;
  const ledgerSetInterval = ((
    handler: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    const id = original.setInterval(handler, ms, ...args);
    timerOrigins.set(
      id,
      `setInterval(${ms ?? 0}ms) ${originOf(new Error().stack)}`,
    );
    return id;
  }) as unknown as typeof setInterval;
  g.setTimeout = ledgerSetTimeout;
  g.setInterval = ledgerSetInterval;
  g.setImmediate = ledgerSetImmediate;
  g.requestAnimationFrame = ledgerRaf;
  g.clearImmediate = ((id: unknown) => {
    timerOrigins.delete(id);
    original.clearImmediate(id as ReturnType<typeof setImmediate>);
  }) as typeof clearImmediate;
  g.cancelAnimationFrame = (id: number) => {
    timerOrigins.delete(id);
    original.cancelAnimationFrame(id);
  };
  g.clearTimeout = ((id: unknown) => {
    timerOrigins.delete(id);
    original.clearTimeout(id as ReturnType<typeof setTimeout>);
  }) as typeof clearTimeout;
  g.clearInterval = ((id: unknown) => {
    timerOrigins.delete(id);
    original.clearInterval(id as ReturnType<typeof setInterval>);
  }) as typeof clearInterval;
  return () => {
    g.setTimeout = original.setTimeout;
    g.clearTimeout = original.clearTimeout;
    g.setInterval = original.setInterval;
    g.clearInterval = original.clearInterval;
    g.setImmediate = original.setImmediate;
    g.clearImmediate = original.clearImmediate;
    g.requestAnimationFrame = original.requestAnimationFrame;
    g.cancelAnimationFrame = original.cancelAnimationFrame;
  };
}
let uninstallTimerLedger: (() => void) | null = null;

beforeAll(() => {
  IS_ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;
  jest.useFakeTimers();
  uninstallTimerLedger = installTimerLedger();
});

afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
  uninstallTimerLedger?.();
  jest.useRealTimers();
  const dir = artifactDir();
  const summary = {
    unit: 'scr-libraryscreen',
    lens: 'lifecycle',
    executed: rows.length,
    passed: rows.filter(r => r.ok).length,
    failed: rows
      .filter(r => !r.ok)
      .map(r => ({
        scenario: r.scenario,
        seed: r.seed,
        failed: r.failed,
        notes: r.notes,
      })),
    invariantFailures: Object.fromEntries(
      Object.keys(rows[0]?.invariants ?? {}).map(name => [
        name,
        rows.filter(r => r.invariants[name] === false).length,
      ]),
    ),
    totals: {
      requests: rows.reduce((n, r) => n + r.observed.requests, 0),
      relaunches: rows.reduce((n, r) => n + r.observed.relaunches, 0),
      rotations: rows.reduce((n, r) => n + r.observed.rotations, 0),
      unauthorized: rows.reduce((n, r) => n + r.observed.unauthorized, 0),
      checks: rows.reduce((n, r) => n + r.observed.checks, 0),
      staleOwnerRenders: rows.reduce(
        (n, r) => n + r.observed.staleOwnerRenders,
        0,
      ),
      trainingErrorsSeen: rows.reduce(
        (n, r) => n + r.observed.trainingErrorsSeen,
        0,
      ),
      guestRelaunchesLostToDbFault: rows.reduce(
        (n, r) => n + r.observed.guestRelaunchesLostToDbFault,
        0,
      ),
      durationMs: rows.reduce((n, r) => n + r.durationMs, 0),
    },
    trainingRecoveryPaths: rows.reduce<Record<string, number>>((acc, r) => {
      const key = r.observed.trainingRecoveryPath;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
    /** App-owned one-shot timers still pending when the session services
     * had stopped (drained without re-arming or side effects), by origin. */
    appTimersPendingAtTeardown: rows
      .flatMap(r =>
        r.observed.timersAfterTeardown
          .filter(
            origin =>
              origin.includes('/apps/mobile/src/') &&
              !origin.includes('node_modules'),
          )
          .map(origin => ({ origin, scenario: r.scenario, seed: r.seed })),
      )
      .reduce<Record<string, { count: number; scenarios: string[] }>>(
        (acc, entry) => {
          const key = entry.origin.replace(/^.*\/apps\/mobile\//, '');
          const bucket = acc[key] ?? { count: 0, scenarios: [] };
          bucket.count += 1;
          const label = `${entry.scenario}#${entry.seed}`;
          if (!bucket.scenarios.includes(label)) bucket.scenarios.push(label);
          acc[key] = bucket;
          return acc;
        },
        {},
      ),
    node: nodeProcess.version,
    iterations: ITERATIONS,
    seedBase: SEED_BASE,
  };
  fs.writeFileSync(
    path.join(dir, 'library-lifecycle-rows.json'),
    JSON.stringify(rows, null, 2) + '\n',
  );
  fs.writeFileSync(
    path.join(dir, 'library-lifecycle-summary.json'),
    JSON.stringify(summary, null, 2) + '\n',
  );
});

describe('STRESS scr-libraryscreen · lifecycle interruption (real navigator + stores)', () => {
  const seeded = ONLY_SEED
    ? [seededScenario(Number(ONLY_SEED))]
    : Array.from({ length: ITERATIONS }, (_, i) =>
        seededScenario(SEED_BASE + i),
      );
  const scenarios = ONLY_SEED ? seeded : [...FIXED_SCENARIOS, ...seeded];

  for (const scenario of scenarios) {
    test(`${scenario.name} (${scenario.initial}, ${scenario.steps.length} steps)`, async () => {
      const row = await runScenario(scenario);
      rows.push(row);
      expect({
        scenario: row.scenario,
        seed: row.seed,
        failed: row.failed,
        notes: row.notes,
      }).toEqual({
        scenario: row.scenario,
        seed: row.seed,
        failed: [],
        notes: [],
      });
    });
  }
});
