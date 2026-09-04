/**
 * STRESS — unit `scr-signinscreen`, lens `lifecycle` (LIFECYCLE INTERRUPTION).
 *
 * The REAL App tree is mounted (SafeAreaProvider → QueryClientProvider →
 * RootErrorBoundary → Gate → Welcome / SignInScreen / LoadingState / main
 * marker) over the REAL authStore, appStore, notification + consistency
 * stores, apiSession, sessionKeeper, syncRuntime, sessionVault and
 * bootstrapCanonicalAccount. Only native modules are replaced: the SQLite
 * driver (kv map), the Keychain (repo auto-mock), the Apple/Google sign-in
 * SDKs (held promises), the notification scheduler, safe-area/svg leaves and
 * `fetch` — which is a stateful fake account server (GoTrue-style refresh
 * rotation with the parent-token exception, server-side revocation, logout)
 * that processes every request AT ARRIVAL and delivers the response only
 * when the schedule says so (or never: kill/relaunch, client timeout).
 *
 * Every scenario is a seeded (mulberry32) schedule of lifecycle events drawn
 * from the actions enabled in the current state:
 *   mount / unmount (mid-request) / kill+relaunch (timers dropped, module
 *   runtime reset, Keychain + SQLite survive, hydrate re-runs) / background /
 *   foreground / go to sign-in / back / tap Apple / tap Google / tap while
 *   busy / OS notification permission revoked or granted later (optionally
 *   with the OS query held) / provider ok|cancel|fail (mid-flight cancel) /
 *   deliver a held server response out of order (bootstrap, refresh = token
 *   rotation mid-request, logout, /v1/me) / advance the fake clock (1s … 3h: client
 *   timeouts, keeper rotations, backoff, expiry) / sign out (account switch
 *   happens when the next sign-in picks another user) / revoke the session
 *   server-side (permission revoke-later) / an API route reporting 401 /
 *   re-hydrate.
 *
 * Invariants (any violation ⇒ the seed FAILS and is written to the JSON
 * table with its full step log, replayable with STRESS_SEED=<n>):
 *   I1  auth.session user == model (bootstrap ok ⇒ that user; live refresh
 *       401 / sign-out ⇒ none; relaunch ⇒ the Keychain record's user).
 *   I2  Signed in ⇒ apiSession is null only while a launch refresh is still
 *       pending/retrying, else bound to the SAME canonical user with a
 *       bearer the fake server issued for that user; the active data owner
 *       is that user's; the Keychain record (if any) is that user's.
 *   I3  Signed out & idle ⇒ no apiSession, no Keychain record, owner
 *       signed-out, no keeper/sync timers or AppState listeners alive.
 *   I4  No previous user's state: appStore.ownerKey/profile belong to the
 *       current user; every authenticated request carried a bearer issued
 *       to the user the app was signed in as when it was sent.
 *   I5  Stale responses (delivered to a dead keeper generation, an unmounted
 *       tree or a previous process) never mutate auth/api/keychain state.
 *   I6  A live refresh `ok` is adopted exactly (bearer + refresh token in
 *       memory, refresh token in the Keychain); every refresh request carries
 *       a token the server would accept (current, or its parent).
 *   I7  Access tokens / provider ID tokens never reach Keychain or SQLite.
 *   I8  UI ⇔ store: SignInScreen buttons disabled + spinner iff busy; error
 *       card iff a non-cancel error; main marker ⇒ signed in; SignInScreen
 *       ⇒ signed out; the tapped-while-busy provider is never invoked twice.
 *   I9  Unmount: every AppState listener registered by the tree is removed;
 *       end of scenario (signed out, unmounted, +10s): zero auth/account/sync
 *       timers, zero AppState listeners.
 *   I10 Permission revoke-later: once the OS permission query has answered,
 *       the notification store mirrors the OS state after a foreground; the
 *       reminder plan is never applied for the signed-out owner; the
 *       notification store's owner is the active owner.
 *
 * Defaults are small enough for the suite (STRESS_ITER=120 seeds × 40
 * steps). STRESS_ITER / STRESS_STEPS / STRESS_SEED (replay one) /
 * STRESS_OUT (artifact dir) override. Run with --detectOpenHandles.
 */
import React from 'react';
import { AppState, NativeModules, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import * as Keychain from 'react-native-keychain';
import type { LocalDb } from '../../src/data/db';

/** Node globals the RN tsconfig does not declare (pattern shared with
 * __tests__/xc/xcMatrixNetworkAuth2.keeper.test.ts). */
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  version: string;
};
const fs = require('fs') as {
  mkdirSync: (p: string, options: { recursive: true }) => void;
  writeFileSync: (p: string, data: string) => void;
};
const path = require('path') as {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
};

// ─── Native module seams (everything else is the real app) ───────────────────

jest.mock('react-native-safe-area-context', () => {
  const ReactActual = jest.requireActual('react');
  const { View: RNView } = jest.requireActual('react-native');
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

jest.mock('react-native-svg', () => {
  const ReactActual = jest.requireActual('react');
  const { View: RNView } = jest.requireActual('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    ReactActual.createElement(RNView, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Line: Mock,
    Path: Mock,
    Polyline: Mock,
    Rect: Mock,
    Defs: Mock,
    LinearGradient: Mock,
    Stop: Mock,
    G: Mock,
    Ellipse: Mock,
  };
});

/** SQLite → the kv table only (the auth flag keys + owner-scoped profiles);
 * every other statement answers an empty result set, which the sync,
 * consistency and notification stores treat as "nothing stored yet". */
const mockKv = new Map<string, string>();
function mockCurrentDb(): LocalDb {
  return {
    async execute(sql: string, params: unknown[] = []) {
      const statement = sql.trim().replace(/\s+/g, ' ');
      if (statement.startsWith('SELECT value FROM kv')) {
        const value = mockKv.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
        mockKv.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  };
}
jest.mock('../../src/data/db', () => ({ getDb: () => mockCurrentDb() }));

const mockGoogleSignin = {
  configure: jest.fn(),
  hasPlayServices: jest.fn(),
  signIn: jest.fn(),
  signInSilently: jest.fn(),
  hasPreviousSignIn: jest.fn(),
  signOut: jest.fn(),
  revokeAccess: jest.fn(),
};
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: mockGoogleSignin,
}));

jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: 'test-web-client.apps.googleusercontent.com',
  GOOGLE_IOS_CLIENT_ID: 'test-ios-client.apps.googleusercontent.com',
}));

jest.mock('../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.example.test',
    revenueCatPublicSdkKey: null,
    googleIosClientId: 'test-ios-client.apps.googleusercontent.com',
    googleWebClientId: 'test-web-client.apps.googleusercontent.com',
    appVersion: '1.0',
    legalPrivacyUrl: null,
    legalTermsUrl: null,
  }),
}));

jest.mock('../../src/account/deviceContext', () => ({
  getAccountBootstrapEnvironment: () => ({
    locale: 'en-US',
    timezone: 'America/Los_Angeles',
    device: {
      platform: 'ios',
      osVersion: '18.5',
      appVersion: '1.0',
      model: 'iOS phone',
    },
  }),
}));

/** Notification permission as the OS would answer it. `holdNext` parks the
 * next permissionState() call so a revoke-later / account switch can land
 * while the OS query is still pending. */
type MockPermission = 'granted' | 'denied' | 'undetermined';
const mockScheduler = {
  permission: 'granted' as MockPermission,
  holdNext: false,
  heldPermission: [] as {
    value: MockPermission;
    resolve: (s: MockPermission) => void;
  }[],
  applyPlanOwners: [] as string[],
  async permissionState(): Promise<MockPermission> {
    if (this.holdNext) {
      this.holdNext = false;
      const value = this.permission;
      return new Promise<MockPermission>(resolve => {
        this.heldPermission.push({ value, resolve });
      });
    }
    return this.permission;
  },
  async requestPermission(): Promise<MockPermission> {
    return this.permission;
  },
  async applyPlan() {
    this.applyPlanOwners.push(getActiveDataOwner());
  },
  async cancelAllPlanned() {},
  async openSystemSettings() {},
};
jest.mock('../../src/notifications/service', () => ({
  getScheduler: () => mockScheduler,
}));

// Leaves outside the sign-in lifecycle: the signed-in shell (a marker so the
// Gate's hand-off is observable), the MP4 splash (its Animated completion
// never fires under jest) and the three global overlays.
jest.mock('../../src/navigation/RootNavigator', () => {
  const ReactActual = jest.requireActual('react');
  const { View: RNView } = jest.requireActual('react-native');
  return {
    __esModule: true,
    RootNavigator: () =>
      ReactActual.createElement(RNView, { testID: 'RootNavigator' }),
  };
});
jest.mock('../../src/screens/SplashScreen', () => {
  const ReactActual = jest.requireActual('react');
  const { View: RNView } = jest.requireActual('react-native');
  return {
    __esModule: true,
    SplashScreen: (props: { ready: boolean; onFinished: () => void }) => {
      ReactActual.useEffect(() => {
        if (props.ready) props.onFinished();
      }, [props.ready, props.onFinished]);
      return ReactActual.createElement(RNView, { testID: 'SplashScreen' });
    },
  };
});
jest.mock('../../src/components/RankUpCelebration', () => ({
  __esModule: true,
  RankUpCelebration: () => null,
}));
jest.mock('../../src/consistency/StreakCelebration', () => ({
  __esModule: true,
  StreakCelebration: () => null,
}));
jest.mock('../../src/walkthrough/FirstRunWalkthrough', () => ({
  __esModule: true,
  FirstRunWalkthrough: () => null,
}));

import App from '../../App';
import { useAuthStore } from '../../src/auth/authStore';
import { useAppStore } from '../../src/state/appStore';
import {
  clearApiSession,
  getApiSession,
  reportApiUnauthorized,
} from '../../src/account/apiSession';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { SESSION_VAULT_SERVICE } from '../../src/account/sessionVault';
import { useNotificationStore } from '../../src/notifications/notificationStore';

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

// ─── Seeded RNG ──────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
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
  constructor(private readonly next: () => number) {}
  float(): number {
    return this.next();
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }
  weighted<T>(entries: readonly (readonly [T, number])[]): T {
    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    let roll = this.next() * total;
    for (const [value, weight] of entries) {
      roll -= weight;
      if (roll < 0) return value;
    }
    return entries[entries.length - 1]![0];
  }
}

// ─── Fake account server (GoTrue-style rotation semantics) ───────────────────

interface ServerUser {
  id: string;
  email: string;
  firstName: string;
  appleSubject: string;
  googleId: string;
}

const USERS: readonly ServerUser[] = [
  {
    id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    email: 'ana@example.test',
    firstName: 'Ana',
    appleSubject: 'apple-sub-ana',
    googleId: 'google-uid-ana',
  },
  {
    id: '7fc2c743-028f-4ec6-942c-a84508f3be38',
    email: 'bo@example.test',
    firstName: 'Bo',
    appleSubject: 'apple-sub-bo',
    googleId: 'google-uid-bo',
  },
  {
    id: 'c1a4d6e2-9b3f-4a7c-8d2e-1f0b3c5d7e9a',
    email: 'cy@example.test',
    firstName: 'Cy',
    appleSubject: 'apple-sub-cy',
    googleId: 'google-uid-cy',
  },
];

type Route = 'bootstrap' | 'refresh' | 'logout' | 'me' | 'other';
type Outcome = 'ok' | 'refused' | 'unavailable' | 'network' | 'malformed';

interface ServerSession {
  id: number;
  userId: string;
  /** Current refresh token; `parent` is the one it was rotated from. */
  refresh: string;
  parent: string | null;
  access: string;
  expiresAtMs: number;
  revoked: boolean;
}

interface HeldRequest {
  id: number;
  epoch: number;
  gen: number;
  route: Route;
  url: string;
  method: string;
  bearer: string | null;
  bodyRefreshToken: string | null;
  /** The user the app was signed in as when the request was sent. */
  appUserAtSend: string | null;
  /** Decided at arrival (the server has already processed side effects). */
  outcome: Outcome;
  status: number;
  body: unknown;
  aborted: boolean;
  delivered: boolean;
  deliveredTo: 'live' | 'stale' | 'lost' | null;
  resolve: (response: Response) => void;
  reject: (reason: unknown) => void;
  /** For refresh: the tokens the response carries. */
  tokens: { access: string; refresh: string } | null;
  /** For bootstrap: which user the ID token named. */
  userId: string | null;
  sentAtMs: number;
}

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => {
      if (body === undefined) throw new Error('empty body');
      return body;
    },
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as unknown as Response;
}

function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

class FakeServer {
  sessions: ServerSession[] = [];
  issuedAccess = new Set<string>();
  issuedProviderTokens = new Set<string>();
  accessOwner = new Map<string, string>();
  held: HeldRequest[] = [];
  log: HeldRequest[] = [];
  private nextId = 1;
  private nextSession = 1;
  private tokenCounter = 0;
  /** Short-lived bearers make foreground / timer rotations frequent. */
  bearerTtlMs = 3600_000;

  constructor(private readonly rng: Rng) {}

  private mint(userId: string): { access: string; refresh: string } {
    this.tokenCounter += 1;
    const access = `access.${userId.slice(0, 8)}.${this.tokenCounter}`;
    const refresh = `refresh.${userId.slice(0, 8)}.${this.tokenCounter}`;
    this.issuedAccess.add(access);
    this.accessOwner.set(access, userId);
    return { access, refresh };
  }

  sessionView(session: ServerSession) {
    return {
      accessToken: session.access,
      refreshToken: session.refresh,
      expiresAt: Math.floor(session.expiresAtMs / 1000),
    };
  }

  liveSessionForUser(userId: string): ServerSession | null {
    return this.sessions.find(s => s.userId === userId && !s.revoked) ?? null;
  }

  bearerUser(bearer: string | null): string | null {
    if (!bearer) return null;
    const session = this.sessions.find(s => s.access === bearer);
    if (!session || session.revoked) return null;
    return session.userId;
  }

  revokeUser(userId: string): void {
    for (const s of this.sessions) if (s.userId === userId) s.revoked = true;
  }

  /** `fetch`: process at arrival, hold the response. */
  fetch = (
    context: { epoch: number; gen: number; appUser: string | null },
    url: string,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = headers['Authorization'] ?? headers['authorization'] ?? null;
    const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    let bodyRefreshToken: string | null = null;
    if (typeof init?.body === 'string') {
      try {
        const parsed = JSON.parse(init.body) as { refreshToken?: unknown };
        if (typeof parsed.refreshToken === 'string') {
          bodyRefreshToken = parsed.refreshToken;
        }
      } catch {
        // not JSON
      }
    }
    const route: Route = url.endsWith('/v1/account/bootstrap')
      ? 'bootstrap'
      : url.endsWith('/v1/auth/refresh')
        ? 'refresh'
        : url.endsWith('/v1/auth/logout')
          ? 'logout'
          : url.endsWith('/v1/me')
            ? 'me'
            : 'other';

    let resolve!: (response: Response) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<Response>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const request: HeldRequest = {
      id: this.nextId++,
      epoch: context.epoch,
      gen: context.gen,
      route,
      url,
      method: init?.method ?? 'GET',
      bearer,
      bodyRefreshToken,
      appUserAtSend: context.appUser,
      outcome: 'ok',
      status: 200,
      body: undefined,
      aborted: false,
      delivered: false,
      deliveredTo: null,
      resolve,
      reject,
      tokens: null,
      userId: null,
      sentAtMs: Date.now(),
    };
    this.process(request);
    this.held.push(request);
    this.log.push(request);
    init?.signal?.addEventListener('abort', () => {
      if (request.delivered) return;
      request.aborted = true;
      request.delivered = true;
      this.held = this.held.filter(r => r !== request);
      reject(abortError());
    });
    return promise;
  };

  private process(request: HeldRequest): void {
    switch (request.route) {
      case 'bootstrap': {
        const idToken = request.bearer ?? '';
        const user = USERS.find(u => idToken === `idtoken.${u.id}`) ?? null;
        request.userId = user?.id ?? null;
        const outcome = this.rng.weighted<Outcome>([
          ['ok', 74],
          ['refused', 10],
          ['unavailable', 8],
          ['network', 6],
          ['malformed', 2],
        ]);
        request.outcome = outcome;
        if (!user || outcome === 'refused') {
          request.outcome = 'refused';
          request.status = 401;
          request.body = {
            error: { message: 'Identity token could not be verified.' },
          };
          return;
        }
        if (outcome === 'unavailable') {
          request.status = 503;
          request.body = { error: { message: 'Account service unavailable.' } };
          return;
        }
        if (outcome === 'network' || outcome === 'malformed') return;
        // Processed: a fresh server session for this device.
        const tokens = this.mint(user.id);
        const session: ServerSession = {
          id: this.nextSession++,
          userId: user.id,
          refresh: tokens.refresh,
          parent: null,
          access: tokens.access,
          expiresAtMs: Date.now() + this.bearerTtlMs,
          revoked: false,
        };
        this.sessions.push(session);
        request.tokens = tokens;
        request.status = 200;
        request.body = {
          user: { id: user.id, email: user.email },
          onboardingState: 'complete',
          session: this.sessionView(session),
        };
        return;
      }
      case 'refresh': {
        const token = request.bodyRefreshToken;
        const outcome = this.rng.weighted<Outcome>([
          ['ok', 72],
          ['unavailable', 14],
          ['network', 10],
          ['malformed', 4],
        ]);
        request.outcome = outcome;
        if (outcome === 'unavailable') {
          request.status = 503;
          request.body = { error: { message: 'Session refresh unavailable.' } };
          return;
        }
        if (outcome === 'network' || outcome === 'malformed') return;
        const current = this.sessions.find(s => s.refresh === token) ?? null;
        const viaParent = this.sessions.find(s => s.parent === token) ?? null;
        if (current && !current.revoked) {
          const minted = this.mint(current.userId);
          current.parent = current.refresh;
          current.refresh = minted.refresh;
          current.access = minted.access;
          current.expiresAtMs = Date.now() + this.bearerTtlMs;
          request.tokens = minted;
          request.status = 200;
          request.body = { session: this.sessionView(current) };
          return;
        }
        if (viaParent && !viaParent.revoked) {
          // GoTrue: the parent of the active token returns the active token
          // (a lost response must not end the session).
          request.tokens = {
            access: viaParent.access,
            refresh: viaParent.refresh,
          };
          request.status = 200;
          request.body = { session: this.sessionView(viaParent) };
          return;
        }
        request.outcome = 'refused';
        request.status = 401;
        request.body = {
          error: {
            message: 'The session could not be refreshed. Sign in again.',
          },
        };
        return;
      }
      case 'logout': {
        const outcome = this.rng.weighted<Outcome>([
          ['ok', 88],
          ['unavailable', 8],
          ['network', 4],
        ]);
        request.outcome = outcome;
        if (outcome === 'unavailable') {
          request.status = 503;
          request.body = { error: { message: 'Sign-out unavailable.' } };
          return;
        }
        if (outcome === 'network') return;
        const session = this.sessions.find(s => s.access === request.bearer);
        if (session) session.revoked = true;
        request.status = 204;
        request.body = undefined;
        return;
      }
      case 'me': {
        const outcome = this.rng.weighted<Outcome>([
          ['ok', 84],
          ['unavailable', 10],
          ['network', 6],
        ]);
        request.outcome = outcome;
        const userId = this.bearerUser(request.bearer);
        if (!userId) {
          request.outcome = 'refused';
          request.status = 401;
          request.body = { error: { message: 'Unauthorized.' } };
          return;
        }
        if (outcome === 'unavailable') {
          request.status = 503;
          request.body = { error: { message: 'Profile unavailable.' } };
          return;
        }
        if (outcome === 'network') return;
        const user = USERS.find(u => u.id === userId)!;
        request.status = 200;
        request.body = {
          onboardingState: 'complete',
          profile: {
            skill_level: 'intermediate',
            handedness: 'right',
            primary_goal: 'consistency',
            biggest_problem: 'popups',
            first_name: user.firstName,
          },
        };
        return;
      }
      default:
        request.outcome = 'refused';
        request.status = 404;
        request.body = { error: { message: 'Not found.' } };
    }
  }

  deliver(request: HeldRequest): void {
    if (request.delivered) return;
    request.delivered = true;
    this.held = this.held.filter(r => r !== request);
    if (request.outcome === 'network') {
      request.reject(new TypeError('Network request failed'));
      return;
    }
    if (request.outcome === 'malformed') {
      request.resolve(fakeResponse(200, { unexpected: true }));
      return;
    }
    request.resolve(fakeResponse(request.status, request.body));
  }

  /** Kill: responses in flight are lost; the server keeps its side effects. */
  abandonAll(): void {
    for (const request of this.held) {
      request.delivered = true;
      request.deliveredTo = 'lost';
    }
    this.held = [];
  }
}

// ─── Timer / listener attribution ────────────────────────────────────────────

function originOf(stack: string | undefined): string {
  if (!stack) return 'unknown';
  for (const line of stack.split('\n').slice(1)) {
    const m = /apps\/mobile\/((?:src|App)[^:)]*)/.exec(line);
    if (m && m[1]) return m[1];
  }
  return 'external';
}

const liveTimers = new Map<unknown, string>();
const appStateListeners = new Map<(state: string) => void, string>();

function installTimerTracking(): () => void {
  const g = globalThis as unknown as {
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
  };
  const fakeSetTimeout = g.setTimeout;
  const fakeClearTimeout = g.clearTimeout;
  const tracked = ((
    handler: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    const origin = originOf(new Error().stack);
    const handle: ReturnType<typeof setTimeout> = fakeSetTimeout(() => {
      liveTimers.delete(handle);
      handler(...args);
    }, ms);
    liveTimers.set(handle, origin);
    return handle;
  }) as unknown as typeof setTimeout;
  g.setTimeout = tracked;
  g.clearTimeout = ((handle: unknown) => {
    liveTimers.delete(handle);
    fakeClearTimeout(handle as ReturnType<typeof setTimeout>);
  }) as typeof clearTimeout;
  return () => {
    g.setTimeout = fakeSetTimeout;
    g.clearTimeout = fakeClearTimeout;
  };
}

function timersFrom(prefixes: readonly string[]): string[] {
  return [...liveTimers.values()].filter(origin =>
    prefixes.some(p => origin.startsWith(p)),
  );
}

function listenersFrom(prefixes: readonly string[]): string[] {
  return [...appStateListeners.values()].filter(origin =>
    prefixes.some(p => origin.startsWith(p)),
  );
}

const RUNTIME_ORIGINS = [
  'src/account/sessionKeeper',
  'src/data/syncRuntime',
] as const;
const AUTH_ORIGINS = ['src/account/', 'src/auth/', 'src/data/syncRuntime'];

// ─── Harness ─────────────────────────────────────────────────────────────────

type Renderer = TestRenderer.ReactTestRenderer;
type NativeApple = { signInWithApple: jest.Mock };
const nativeModules = NativeModules as { PickleAuth?: NativeApple };

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface ProviderCall {
  epoch: number;
  provider: 'apple' | 'google';
  deferred: Deferred<unknown>;
  settled: boolean;
}

interface Snapshot {
  user: string | null;
  bearer: string | null;
  refresh: string | null;
  owner: string;
  keychain: string | null;
  busy: boolean;
}

interface StepRecord {
  step: number;
  action: string;
  detail?: string;
  violations: string[];
}

interface ScenarioResult {
  seed: number;
  outcome: 'HELD' | 'BROKEN';
  steps: number;
  violations: string[];
  actions: Record<string, number>;
  requests: number;
  /** `<route>:<outcome>[:stale|lost]` → count, from the fake server's log. */
  requestMix: Record<string, number>;
  relaunches: number;
  signIns: number;
  accountSwitches: number;
  log: StepRecord[];
}

function nativeError(code: string, message: string) {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

class Harness {
  readonly rng: Rng;
  readonly server: FakeServer;
  renderer: Renderer | null = null;
  epoch = 0;
  /** Bumped whenever the app's keeper/sync generation is replaced. */
  gen = 0;
  expectedUser: string | null = null;
  lastSignedInUser: string | null = null;
  providerCalls: ProviderCall[] = [];
  violations: string[] = [];
  log: StepRecord[] = [];
  actionCounts: Record<string, number> = {};
  relaunches = 0;
  signIns = 0;
  accountSwitches = 0;
  appleCalls = 0;
  googleCalls = 0;
  /** Index of the step whose action was a foreground event (for I10). */
  lastForegroundStep = -1;
  private stepViolations: string[] = [];

  constructor(readonly seed: number) {
    const next = mulberry32(seed);
    this.rng = new Rng(next);
    this.server = new FakeServer(new Rng(mulberry32(seed ^ 0x9e3779b9)));
    this.server.bearerTtlMs = this.rng.weighted([
      [3600_000, 60],
      [600_000, 25],
      [90_000, 15],
    ]);
  }

  // ── wiring ──

  install(): void {
    const server = this.server;
    globalThis.fetch = ((url: string, init?: RequestInit) =>
      server.fetch(
        {
          epoch: this.epoch,
          gen: this.gen,
          appUser: useAuthStore.getState().session?.canonicalAppUserId ?? null,
        },
        url,
        init,
      )) as unknown as typeof fetch;

    nativeModules.PickleAuth = {
      signInWithApple: jest.fn(() => {
        this.appleCalls += 1;
        const d = deferred<unknown>();
        this.providerCalls.push({
          epoch: this.epoch,
          provider: 'apple',
          deferred: d,
          settled: false,
        });
        return d.promise;
      }),
    };
    mockGoogleSignin.hasPreviousSignIn.mockReturnValue(false);
    mockGoogleSignin.hasPlayServices.mockResolvedValue(true);
    mockGoogleSignin.signOut.mockResolvedValue(null);
    mockGoogleSignin.revokeAccess.mockResolvedValue(null);
    mockGoogleSignin.signIn.mockImplementation(() => {
      this.googleCalls += 1;
      const d = deferred<unknown>();
      this.providerCalls.push({
        epoch: this.epoch,
        provider: 'google',
        deferred: d,
        settled: false,
      });
      return d.promise;
    });
  }

  // ── observation helpers ──

  private text(): string {
    if (!this.renderer) return '';
    return this.renderer.root
      .findAllByType(Text)
      .map(node => node.props.children)
      .flat()
      .filter((c): c is string => typeof c === 'string')
      .join(' ');
  }

  private control(label: string): TestRenderer.ReactTestInstance | null {
    if (!this.renderer) return null;
    const matches = this.renderer.root.findAll(
      node =>
        node.props.accessibilityLabel === label &&
        typeof node.props.onPress === 'function' &&
        node.props.accessibilityState !== undefined,
    );
    return matches[0] ?? null;
  }

  screen():
    'none' | 'loading' | 'welcome' | 'signin' | 'main' | 'error' | 'other' {
    if (!this.renderer) return 'none';
    if (
      this.renderer.root.findAll(n => n.props.testID === 'RootNavigator').length
    ) {
      return 'main';
    }
    const copy = this.text();
    if (copy.includes('Your ratings,')) return 'signin';
    if (copy.includes('See the stroke.')) return 'welcome';
    if (
      copy.includes('Getting things ready') ||
      copy.includes('Loading your account')
    ) {
      return 'loading';
    }
    if (
      copy.includes('couldn’t load') ||
      copy.includes('Something went wrong')
    ) {
      return 'error';
    }
    return 'other';
  }

  snapshot(): Snapshot {
    const api = getApiSession();
    return {
      user: useAuthStore.getState().session?.canonicalAppUserId ?? null,
      bearer: api?.bearerToken ?? null,
      refresh: api?.refreshToken ?? null,
      owner: getActiveDataOwner(),
      keychain: __keychainStore.get(SESSION_VAULT_SERVICE)?.password ?? null,
      busy: useAuthStore.getState().busy,
    };
  }

  keychainUser(): string | null {
    const item = __keychainStore.get(SESSION_VAULT_SERVICE);
    if (!item) return null;
    try {
      const parsed = JSON.parse(item.password) as {
        canonicalAppUserId?: unknown;
      };
      return typeof parsed.canonicalAppUserId === 'string'
        ? parsed.canonicalAppUserId
        : null;
    } catch {
      return null;
    }
  }

  keychainRefresh(): string | null {
    const item = __keychainStore.get(SESSION_VAULT_SERVICE);
    if (!item) return null;
    try {
      const parsed = JSON.parse(item.password) as { refreshToken?: unknown };
      return typeof parsed.refreshToken === 'string'
        ? parsed.refreshToken
        : null;
    } catch {
      return null;
    }
  }

  fail(code: string, detail: string): void {
    this.stepViolations.push(`${code}: ${detail}`);
  }

  async flush(): Promise<void> {
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(0);
      });
    }
  }

  // ── lifecycle actions ──

  async mount(): Promise<void> {
    this.gen += 1; // Gate → hydrate() → clearSyncedRuntime()
    await act(async () => {
      this.renderer = TestRenderer.create(<App />);
    });
    await this.flush();
  }

  async unmount(): Promise<void> {
    const renderer = this.renderer;
    if (!renderer) return;
    const before = appStateListeners.size;
    await act(async () => {
      renderer.unmount();
    });
    this.renderer = null;
    await this.flush();
    const treeOwned = listenersFrom([
      'App',
      'src/notifications/',
      'src/consistency/',
    ]);
    if (treeOwned.length) {
      this.fail(
        'I9',
        `AppState listeners survive unmount: ${treeOwned.join(',')} (was ${before})`,
      );
    }
  }

  /** Process death + cold start: timers and in-flight responses are gone,
   * module singletons start empty, Keychain/SQLite persist, hydrate re-runs. */
  async relaunch(): Promise<void> {
    if (this.renderer) {
      await act(async () => {
        this.renderer!.unmount();
      });
      this.renderer = null;
    }
    this.server.abandonAll();
    for (const call of this.providerCalls) call.settled = true;
    mockScheduler.heldPermission = [];
    mockScheduler.holdNext = false;
    useNotificationStore.setState({
      hydrated: false,
      ownerKey: null,
      permission: 'unknown',
    });
    this.epoch += 1;
    this.relaunches += 1;
    jest.clearAllTimers();
    liveTimers.clear();
    appStateListeners.clear();
    stopSessionKeeper();
    clearSyncRuntime();
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    useAuthStore.setState({
      hydrated: false,
      session: null,
      busy: false,
      error: null,
      localDataError: null,
      deletionCleanup: null,
    });
    useAppStore.setState({
      hydrated: false,
      ownerKey: null,
      profile: null,
      hydrateError: null,
      onboardingBusy: false,
      onboardingError: null,
    });
    this.expectedUser = this.keychainUser();
    await this.mount();
  }

  async appState(next: 'background' | 'inactive' | 'active'): Promise<void> {
    await act(async () => {
      for (const listener of [...appStateListeners.keys()]) listener(next);
    });
    await this.flush();
  }

  async press(label: string): Promise<boolean> {
    const node = this.control(label);
    if (!node || node.props.disabled) return false;
    await act(async () => {
      node.props.onPress();
    });
    await this.flush();
    return true;
  }

  async tapWhileBusy(): Promise<void> {
    const label = this.rng.pick([
      'Continue with Apple',
      'Continue with Google',
    ]);
    const node = this.control(label);
    if (!node) return;
    const apple = this.appleCalls;
    const google = this.googleCalls;
    await act(async () => {
      node.props.onPress();
      node.props.onPress();
    });
    await this.flush();
    if (this.appleCalls !== apple || this.googleCalls !== google) {
      this.fail('I8', `provider invoked again while busy (${label})`);
    }
  }

  pendingProvider(): ProviderCall | null {
    return (
      this.providerCalls.find(c => !c.settled && c.epoch === this.epoch) ?? null
    );
  }

  async settleProvider(
    call: ProviderCall,
    kind: 'ok' | 'cancel' | 'fail',
  ): Promise<void> {
    call.settled = true;
    const user = this.rng.pick(USERS);
    if (kind === 'ok') {
      this.gen += 1; // signIn → clearSyncedRuntime() before bootstrap
      if (call.provider === 'apple') {
        call.deferred.resolve({
          user: user.appleSubject,
          identityToken: `idtoken.${user.id}`,
          authorizationCode: 'code-1',
          email: user.email,
          givenName: user.firstName,
          familyName: 'Player',
        });
      } else {
        call.deferred.resolve({
          type: 'success',
          data: {
            user: {
              id: user.googleId,
              name: `${user.firstName} Player`,
              email: user.email,
              photo: null,
              familyName: 'Player',
              givenName: user.firstName,
            },
            scopes: [],
            idToken: `idtoken.${user.id}`,
            serverAuthCode: null,
          },
        });
      }
      this.server.issuedProviderTokens.add(`idtoken.${user.id}`);
    } else if (kind === 'cancel') {
      if (call.provider === 'apple') {
        call.deferred.reject(nativeError('auth.canceled', 'Sign-in canceled.'));
      } else {
        call.deferred.resolve({ type: 'cancelled', data: null });
      }
    } else if (call.provider === 'apple') {
      call.deferred.reject(nativeError('auth.failed', 'Apple sign-in failed.'));
    } else {
      call.deferred.reject(
        nativeError('SIGN_IN_ERROR', 'Google sign-in failed.'),
      );
    }
    await this.flush();
    if (kind !== 'ok') {
      if (useAuthStore.getState().busy)
        this.fail('I8', 'busy after provider settled');
      const error = useAuthStore.getState().error;
      if (kind === 'fail' && !error)
        this.fail('I8', 'no error after provider failure');
      if (kind === 'cancel' && error?.code !== 'auth.canceled') {
        this.fail('I8', `cancel surfaced as ${error?.code ?? 'no error'}`);
      }
    }
  }

  async deliver(request: HeldRequest): Promise<void> {
    const before = this.snapshot();
    // Keeper generation only scopes refreshes; other routes are live for the
    // whole process (the store re-checks the owner itself).
    const live =
      request.epoch === this.epoch &&
      (request.route !== 'refresh' || request.gen === this.gen);
    const previousUser = this.expectedUser;
    request.deliveredTo = live ? 'live' : 'stale';
    this.server.deliver(request);
    await this.flush();
    const after = this.snapshot();

    switch (request.route) {
      case 'bootstrap': {
        if (request.epoch !== this.epoch) break;
        if (request.outcome === 'ok' && request.userId) {
          this.gen += 1; // establishSyncedAccount → keepSessionAlive
          this.expectedUser = request.userId;
          this.signIns += 1;
          if (
            this.lastSignedInUser &&
            this.lastSignedInUser !== request.userId
          ) {
            this.accountSwitches += 1;
          }
          this.lastSignedInUser = request.userId;
          if (after.bearer !== request.tokens?.access) {
            this.fail(
              'I2',
              `bootstrap ok but bearer=${after.bearer} != ${request.tokens?.access}`,
            );
          }
          if (this.keychainRefresh() !== request.tokens?.refresh) {
            this.fail(
              'I6',
              'Keychain refresh token != bootstrap refresh token',
            );
          }
        } else {
          this.gen += 1; // signIn catch → clearSyncedRuntime()
          const error = useAuthStore.getState().error;
          if (!error)
            this.fail('I8', `bootstrap ${request.outcome} left no error`);
          if (after.user !== previousUser) {
            this.fail(
              'I1',
              `bootstrap ${request.outcome} changed user ${previousUser} → ${after.user}`,
            );
          }
        }
        if (useAuthStore.getState().busy)
          this.fail('I8', 'busy after bootstrap settled');
        break;
      }
      case 'refresh': {
        if (!live) {
          this.assertUnchanged(
            'I5',
            `stale refresh ${request.outcome}`,
            before,
            after,
          );
          break;
        }
        if (request.outcome === 'refused') {
          this.gen += 1; // onRevoked → dropRevokedSession
          this.expectedUser = null;
        } else if (request.outcome === 'ok' && request.tokens) {
          if (after.user === request.appUserAtSend) {
            if (
              after.bearer !== request.tokens.access ||
              after.refresh !== request.tokens.refresh
            ) {
              this.fail(
                'I6',
                `live refresh ok not adopted: bearer=${after.bearer} refresh=${after.refresh} expected ${request.tokens.access}/${request.tokens.refresh}`,
              );
            }
            if (this.keychainRefresh() !== request.tokens.refresh) {
              this.fail(
                'I6',
                'Keychain refresh token not rotated with the live refresh',
              );
            }
          }
        } else if (after.user !== before.user) {
          this.fail(
            'I1',
            `transient refresh ${request.outcome} changed user ${before.user} → ${after.user}`,
          );
        }
        break;
      }
      case 'logout':
      case 'me':
      default:
        break;
    }
  }

  private assertUnchanged(
    code: string,
    what: string,
    a: Snapshot,
    b: Snapshot,
  ): void {
    const keys: (keyof Snapshot)[] = [
      'user',
      'bearer',
      'refresh',
      'owner',
      'keychain',
    ];
    for (const key of keys) {
      if (a[key] !== b[key]) {
        this.fail(
          code,
          `${what} mutated ${key}: ${String(a[key])} → ${String(b[key])}`,
        );
      }
    }
  }

  async signOut(): Promise<void> {
    this.gen += 1;
    this.expectedUser = null;
    await act(async () => {
      void useAuthStore.getState().signOut();
    });
    await this.flush();
  }

  async rehydrate(): Promise<void> {
    this.gen += 1;
    this.expectedUser = this.keychainUser();
    await act(async () => {
      void useAuthStore.getState().hydrate();
    });
    await this.flush();
  }

  async advance(ms: number): Promise<void> {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
    await this.flush();
  }

  // ── invariants after every step ──

  checkInvariants(): void {
    const state = useAuthStore.getState();
    const user = state.session?.canonicalAppUserId ?? null;
    const api = getApiSession();
    const screen = this.screen();
    const bootstrapPending = this.server.held.some(
      r => r.route === 'bootstrap' && r.epoch === this.epoch,
    );
    const refreshPending = this.server.held.some(
      r =>
        r.route === 'refresh' && r.epoch === this.epoch && r.gen === this.gen,
    );
    const keeperTimer = timersFrom(['src/account/sessionKeeper']).length > 0;

    // I1
    if (user !== this.expectedUser) {
      this.fail(
        'I1',
        `session user ${user} != expected ${this.expectedUser} (screen=${screen})`,
      );
    }

    // I2 / I3
    if (user) {
      if (api) {
        if (api.canonicalAppUserId !== user) {
          this.fail(
            'I2',
            `apiSession bound to ${api.canonicalAppUserId} while signed in as ${user}`,
          );
        }
        const owner = this.server.accessOwner.get(api.bearerToken);
        if (owner !== user) {
          this.fail(
            'I2',
            `bearer ${api.bearerToken} was issued to ${owner ?? 'nobody'}, not ${user}`,
          );
        }
      } else if (!refreshPending && !keeperTimer) {
        this.fail(
          'I2',
          'signed in without an apiSession and no refresh pending/scheduled',
        );
      }
      if (getActiveDataOwner() !== canonicalDataOwner(user)) {
        this.fail(
          'I2',
          `active owner ${getActiveDataOwner()} != ${canonicalDataOwner(user)}`,
        );
      }
      const kcUser = this.keychainUser();
      if (kcUser && kcUser !== user) {
        this.fail('I2', `Keychain holds ${kcUser} while signed in as ${user}`);
      }
    } else if (!state.busy && !bootstrapPending) {
      if (api)
        this.fail(
          'I3',
          `signed out but apiSession for ${api.canonicalAppUserId} remains`,
        );
      if (this.keychainUser())
        this.fail('I3', `signed out but Keychain holds ${this.keychainUser()}`);
      if (getActiveDataOwner() !== SIGNED_OUT_DATA_OWNER) {
        this.fail('I3', `signed out but owner ${getActiveDataOwner()}`);
      }
      const runtime = [
        ...timersFrom(RUNTIME_ORIGINS).map(o => `timer:${o}`),
        ...listenersFrom(RUNTIME_ORIGINS).map(o => `listener:${o}`),
      ];
      if (runtime.length)
        this.fail('I3', `signed out but runtime alive: ${runtime.join(',')}`);
    }

    // I4 — appStore owner/profile vs current user
    const app = useAppStore.getState();
    if (
      user &&
      app.hydrated &&
      app.ownerKey === canonicalDataOwner(user) &&
      app.profile
    ) {
      const expectedName = USERS.find(u => u.id === user)?.firstName;
      if (app.profile.firstName !== expectedName) {
        this.fail(
          'I4',
          `profile ${app.profile.firstName} shown for ${expectedName}`,
        );
      }
    }
    if (screen === 'main') {
      if (!user) this.fail('I8', 'main marker rendered while signed out');
      if (user && app.ownerKey !== canonicalDataOwner(user)) {
        this.fail(
          'I4',
          `main rendered with appStore owner ${app.ownerKey} for ${user}`,
        );
      }
    }
    if (screen === 'signin' && user)
      this.fail('I8', 'SignInScreen rendered while signed in');

    // I10
    const notifications = useNotificationStore.getState();
    if (mockScheduler.heldPermission.length === 0 && this.renderer) {
      if (
        this.lastForegroundStep === this.log.length &&
        notifications.permission !== mockScheduler.permission
      ) {
        this.fail(
          'I10',
          `notification permission ${notifications.permission} after foreground, OS says ${mockScheduler.permission}`,
        );
      }
      if (
        notifications.hydrated &&
        notifications.ownerKey !== getActiveDataOwner()
      ) {
        this.fail(
          'I10',
          `notification store owner ${notifications.ownerKey} != active ${getActiveDataOwner()}`,
        );
      }
    }
    const badPlans = mockScheduler.applyPlanOwners.filter(
      o => o === SIGNED_OUT_DATA_OWNER,
    );
    if (badPlans.length) {
      this.fail(
        'I10',
        `reminder plan applied for the signed-out owner (${badPlans.length}x)`,
      );
      mockScheduler.applyPlanOwners = [];
    }

    // I7
    const secrets = [
      ...this.server.issuedAccess,
      ...this.server.issuedProviderTokens,
    ];
    for (const [service, item] of __keychainStore) {
      for (const secret of secrets) {
        if (item.password.includes(secret))
          this.fail('I7', `${service} holds ${secret}`);
      }
    }
    for (const [key, value] of mockKv) {
      for (const secret of secrets) {
        if (value.includes(secret))
          this.fail('I7', `kv ${key} holds ${secret}`);
      }
      if (value.includes('refresh.'))
        this.fail('I7', `kv ${key} holds a refresh token`);
    }

    // I8 — SignInScreen busy/error UI mirrors the store
    if (screen === 'signin') {
      const copy = this.text();
      const apple = this.control('Continue with Apple');
      const google = this.control('Continue with Google');
      const busyUi = copy.includes('Signing in securely…');
      if (busyUi !== state.busy)
        this.fail('I8', `spinner=${busyUi} busy=${state.busy}`);
      for (const node of [apple, google]) {
        if (node && Boolean(node.props.disabled) !== state.busy) {
          this.fail(
            'I8',
            `${node.props.accessibilityLabel} disabled=${node.props.disabled} busy=${state.busy}`,
          );
        }
      }
      const cardShown =
        copy.includes('SIGN-IN FAILED') || copy.includes('NOT CONFIGURED YET');
      const cardExpected = Boolean(
        state.error && state.error.code !== 'auth.canceled',
      );
      if (cardShown !== cardExpected) {
        this.fail(
          'I8',
          `error card=${cardShown} error=${state.error?.code ?? 'none'}`,
        );
      }
    }
  }

  /** I4 (server side): every authenticated request carried a bearer the
   * server issued to the user the app was signed in as when it was sent. */
  checkRequestLog(): void {
    for (const request of this.server.log) {
      if (request.route !== 'me') continue;
      const owner = this.server.accessOwner.get(request.bearer ?? '') ?? null;
      if (owner !== request.appUserAtSend) {
        this.fail(
          'I4',
          `GET /v1/me #${request.id} sent bearer of ${owner} while signed in as ${request.appUserAtSend}`,
        );
      }
    }
    for (const request of this.server.log) {
      if (request.route !== 'refresh') continue;
      if (request.outcome === 'refused') {
        const knownSession = this.server.sessions.find(
          s =>
            s.refresh === request.bodyRefreshToken ||
            s.parent === request.bodyRefreshToken,
        );
        if (knownSession && !knownSession.revoked) {
          this.fail(
            'I6',
            `refresh #${request.id} sent a spent token ${request.bodyRefreshToken}`,
          );
        }
      }
    }
  }

  // ── schedule ──

  enabledActions(): string[] {
    const actions: string[] = [];
    const mounted = this.renderer !== null;
    const screen = this.screen();
    const state = useAuthStore.getState();
    const user = state.session?.canonicalAppUserId ?? null;
    if (!mounted) actions.push('mount');
    if (mounted)
      actions.push('unmount', 'background', 'foreground', 'inactive');
    actions.push('relaunch', 'advance');
    if (screen === 'welcome') actions.push('go_signin');
    if (screen === 'signin') {
      actions.push('back');
      if (!state.busy) actions.push('tap_apple', 'tap_google');
      if (state.busy) actions.push('tap_while_busy');
      if (state.error) actions.push('dismiss_error');
    }
    if (this.pendingProvider())
      actions.push('provider_ok', 'provider_cancel', 'provider_fail');
    actions.push(
      mockScheduler.permission === 'granted'
        ? 'permission_revoke'
        : 'permission_grant',
    );
    if (mockScheduler.heldPermission.length) actions.push('permission_settle');
    if (this.server.held.some(r => r.epoch === this.epoch))
      actions.push('respond');
    if (user && screen !== 'loading') actions.push('sign_out');
    if (user && this.server.liveSessionForUser(user))
      actions.push('server_revoke');
    if (user && getApiSession()) actions.push('api_401');
    if (
      mounted &&
      state.hydrated &&
      !state.busy &&
      !this.server.held.some(
        r => r.route === 'refresh' && r.epoch === this.epoch,
      )
    ) {
      actions.push('rehydrate');
    }
    return actions;
  }

  private weight(action: string): number {
    switch (action) {
      case 'respond':
        return 22;
      case 'provider_ok':
        return 14;
      case 'go_signin':
        return 12;
      case 'tap_apple':
      case 'tap_google':
        return 9;
      case 'advance':
        return 8;
      case 'foreground':
      case 'background':
        return 5;
      case 'mount':
        return 20;
      case 'relaunch':
        return 2;
      case 'unmount':
        return 2;
      case 'sign_out':
        return 6;
      case 'server_revoke':
        return 3;
      case 'api_401':
        return 3;
      case 'rehydrate':
        return 2;
      case 'provider_cancel':
      case 'provider_fail':
        return 3;
      case 'tap_while_busy':
        return 4;
      case 'dismiss_error':
        return 4;
      case 'back':
        return 2;
      case 'inactive':
        return 2;
      case 'permission_revoke':
      case 'permission_grant':
        return 2;
      case 'permission_settle':
        return 8;
      default:
        return 1;
    }
  }

  async step(index: number): Promise<void> {
    const enabled = this.enabledActions();
    const action = this.rng.weighted(
      enabled.map(a => [a, this.weight(a)] as const),
    );
    this.actionCounts[action] = (this.actionCounts[action] ?? 0) + 1;
    let detail: string | undefined;
    this.stepViolations = [];
    switch (action) {
      case 'mount':
        await this.mount();
        break;
      case 'unmount':
        await this.unmount();
        break;
      case 'relaunch':
        await this.relaunch();
        detail = `expected=${this.expectedUser?.slice(0, 8) ?? 'none'}`;
        break;
      case 'background':
        await this.appState('background');
        break;
      case 'inactive':
        await this.appState('inactive');
        break;
      case 'foreground':
        await this.appState('active');
        this.lastForegroundStep = index;
        break;
      case 'permission_revoke':
      case 'permission_grant': {
        mockScheduler.permission =
          action === 'permission_revoke' ? 'denied' : 'granted';
        mockScheduler.holdNext = this.rng.float() < 0.5;
        detail = `${mockScheduler.permission}${mockScheduler.holdNext ? ' (next query held)' : ''}`;
        break;
      }
      case 'permission_settle': {
        const held = mockScheduler.heldPermission.shift();
        if (held) {
          await act(async () => {
            held.resolve(held.value);
          });
          await this.flush();
          detail = held.value;
        }
        break;
      }
      case 'go_signin':
        await this.press('I already have an account');
        break;
      case 'back':
        await this.press('Back');
        break;
      case 'dismiss_error':
        await this.press('Dismiss sign-in error');
        break;
      case 'tap_apple':
        await this.press('Continue with Apple');
        break;
      case 'tap_google':
        await this.press('Continue with Google');
        break;
      case 'tap_while_busy':
        await this.tapWhileBusy();
        break;
      case 'provider_ok':
      case 'provider_cancel':
      case 'provider_fail': {
        const call = this.pendingProvider();
        if (call) {
          await this.settleProvider(
            call,
            action.slice('provider_'.length) as 'ok' | 'cancel' | 'fail',
          );
          detail = call.provider;
        }
        break;
      }
      case 'respond': {
        const candidates = this.server.held.filter(r => r.epoch === this.epoch);
        const request = this.rng.pick(candidates);
        detail = `#${request.id} ${request.route} ${request.outcome} gen${request.gen}${request.gen === this.gen ? '' : '(stale)'}`;
        await this.deliver(request);
        break;
      }
      case 'advance': {
        const ms = this.rng.weighted([
          [1_000, 20],
          [5_000, 15],
          [16_000, 15],
          [31_000, 12],
          [6 * 60_000, 12],
          [56 * 60_000, 10],
          [3 * 3600_000, 6],
        ]);
        detail = `${ms}ms`;
        await this.advance(ms);
        break;
      }
      case 'sign_out':
        await this.signOut();
        break;
      case 'server_revoke': {
        const user = useAuthStore.getState().session?.canonicalAppUserId;
        if (user) this.server.revokeUser(user);
        break;
      }
      case 'api_401': {
        const api = getApiSession();
        if (api) {
          await act(async () => {
            reportApiUnauthorized(api.bearerToken);
          });
          await this.flush();
        }
        break;
      }
      case 'rehydrate':
        await this.rehydrate();
        break;
      default:
        throw new Error(`unknown action ${action}`);
    }
    this.checkInvariants();
    this.log.push({
      step: index,
      action,
      ...(detail ? { detail } : {}),
      violations: [...this.stepViolations],
    });
    this.violations.push(
      ...this.stepViolations.map(v => `step ${index} ${action}: ${v}`),
    );
  }

  /** Drain: deliver everything, sign out, unmount, then prove nothing leaks. */
  async teardown(): Promise<void> {
    this.stepViolations = [];
    for (let round = 0; round < 6 && this.server.held.length; round += 1) {
      for (const request of [...this.server.held]) await this.deliver(request);
    }
    for (const call of this.providerCalls) {
      if (!call.settled) await this.settleProvider(call, 'cancel');
    }
    if (useAuthStore.getState().session) {
      await this.signOut();
      for (const request of [...this.server.held]) await this.deliver(request);
    }
    for (const held of mockScheduler.heldPermission.splice(0))
      held.resolve(held.value);
    await this.flush();
    if (this.renderer) await this.unmount();
    await this.advance(10_000);
    for (const request of [...this.server.held]) await this.deliver(request);
    await this.flush();
    const leaks = [
      ...timersFrom(AUTH_ORIGINS).map(o => `timer:${o}`),
      ...[...appStateListeners.values()].map(o => `listener:${o}`),
    ];
    if (leaks.length) this.fail('I9', `after teardown: ${leaks.join(',')}`);
    if (getApiSession())
      this.fail('I9', 'apiSession survives sign-out + unmount');
    this.checkRequestLog();
    this.violations.push(...this.stepViolations.map(v => `teardown: ${v}`));
  }

  result(steps: number): ScenarioResult {
    const requestMix: Record<string, number> = {};
    for (const request of this.server.log) {
      const tag = request.aborted
        ? 'aborted'
        : request.deliveredTo === 'stale'
          ? 'stale'
          : request.deliveredTo === 'lost'
            ? 'lost'
            : 'live';
      const key = `${request.route}:${request.outcome}:${tag}`;
      requestMix[key] = (requestMix[key] ?? 0) + 1;
    }
    return {
      seed: this.seed,
      outcome: this.violations.length ? 'BROKEN' : 'HELD',
      steps,
      violations: this.violations,
      actions: this.actionCounts,
      requests: this.server.log.length,
      requestMix,
      relaunches: this.relaunches,
      signIns: this.signIns,
      accountSwitches: this.accountSwitches,
      log: this.log,
    };
  }
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const ITER = Number(process.env.STRESS_ITER ?? 120);
const STEPS = Number(process.env.STRESS_STEPS ?? 40);
const ONLY_SEED = process.env.STRESS_SEED
  ? Number(process.env.STRESS_SEED)
  : null;
const OUT_DIR =
  process.env.STRESS_OUT ??
  path.resolve(
    __dirname,
    '../../../../artifacts/stress/scr-signinscreen-lifecycle',
  );

const realFetch = globalThis.fetch;
const realRandom = Math.random;
let restoreTimers: (() => void) | null = null;

async function runScenario(seed: number): Promise<ScenarioResult> {
  const harness = new Harness(seed);
  Math.random = mulberry32(seed ^ 0x1234567);
  harness.install();
  let steps = 0;
  try {
    for (; steps < STEPS; steps += 1) await harness.step(steps);
  } catch (error) {
    harness.violations.push(
      `step ${steps} threw: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    );
  }
  try {
    await harness.teardown();
  } catch (error) {
    harness.violations.push(
      `teardown threw: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    );
  }
  return harness.result(steps);
}

function resetProcessState(): void {
  jest.clearAllTimers();
  liveTimers.clear();
  appStateListeners.clear();
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  __keychainStore.clear();
  mockKv.clear();
  mockScheduler.permission = 'granted';
  mockScheduler.holdNext = false;
  mockScheduler.heldPermission = [];
  mockScheduler.applyPlanOwners = [];
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    permission: 'unknown',
  });
  useAuthStore.setState({
    hydrated: false,
    session: null,
    busy: false,
    error: null,
    localDataError: null,
    deletionCleanup: null,
  });
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
    onboardingBusy: false,
    onboardingError: null,
  });
}

describe('scr-signinscreen × lifecycle: seeded interruption campaign over the real App tree', () => {
  beforeAll(() => {
    jest.useFakeTimers();
    restoreTimers = installTimerTracking();
    (AppState.addEventListener as jest.Mock).mockImplementation(
      (_type: string, listener: (state: string) => void) => {
        appStateListeners.set(listener, originOf(new Error().stack));
        return {
          remove: () => {
            appStateListeners.delete(listener);
          },
        };
      },
    );
  });

  afterAll(() => {
    resetProcessState();
    restoreTimers?.();
    globalThis.fetch = realFetch;
    Math.random = realRandom;
    delete nativeModules.PickleAuth;
    jest.useRealTimers();
  });

  it(
    `holds every lifecycle invariant across ${ONLY_SEED !== null ? 'seed ' + ONLY_SEED : ITER + ' seeded schedules'}`,
    async () => {
      const seeds =
        ONLY_SEED !== null
          ? [ONLY_SEED]
          : Array.from({ length: ITER }, (_, i) => 1000 + i);
      const results: ScenarioResult[] = [];
      const startedAt = Date.now();
      for (const seed of seeds) {
        resetProcessState();
        results.push(await runScenario(seed));
      }
      resetProcessState();

      const failed = results.filter(r => r.outcome === 'BROKEN');
      const totals = results.reduce(
        (acc, r) => {
          acc.steps += r.steps;
          acc.requests += r.requests;
          for (const [key, count] of Object.entries(r.requestMix)) {
            acc.requestMix[key] = (acc.requestMix[key] ?? 0) + count;
          }
          acc.relaunches += r.relaunches;
          acc.signIns += r.signIns;
          acc.accountSwitches += r.accountSwitches;
          for (const [action, count] of Object.entries(r.actions)) {
            acc.actions[action] = (acc.actions[action] ?? 0) + count;
          }
          return acc;
        },
        {
          steps: 0,
          requests: 0,
          relaunches: 0,
          signIns: 0,
          accountSwitches: 0,
          actions: {} as Record<string, number>,
          requestMix: {} as Record<string, number>,
        },
      );
      const report = {
        unit: 'scr-signinscreen',
        lens: 'lifecycle',
        suite: '__tests__/stress/signInScreen.lifecycle.stress.test.tsx',
        node: process.version,
        config: {
          iter: seeds.length,
          stepsPerSeed: STEPS,
          onlySeed: ONLY_SEED,
        },
        scenariosExecuted: results.length,
        stepsExecuted: totals.steps,
        requests: totals.requests,
        requestMix: totals.requestMix,
        relaunches: totals.relaunches,
        signIns: totals.signIns,
        accountSwitches: totals.accountSwitches,
        actions: totals.actions,
        held: results.length - failed.length,
        broken: failed.length,
        failedSeeds: failed.map(r => r.seed),
        table: results.map(r => ({
          seed: r.seed,
          outcome: r.outcome,
          steps: r.steps,
          requests: r.requests,
          requestMix: r.requestMix,
          relaunches: r.relaunches,
          signIns: r.signIns,
          accountSwitches: r.accountSwitches,
          violations: r.violations,
        })),
        failures: failed,
      };
      fs.mkdirSync(OUT_DIR, { recursive: true });
      const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-');
      const file = path.join(
        OUT_DIR,
        `lifecycle-${ONLY_SEED !== null ? 'seed-' + ONLY_SEED : 'campaign'}-${stamp}.json`,
      );
      fs.writeFileSync(file, JSON.stringify(report, null, 2));

      expect(results.length).toBe(seeds.length);
      expect(totals.steps).toBe(seeds.length * STEPS);
      expect(
        failed.map(r => ({ seed: r.seed, violations: r.violations })),
      ).toEqual([]);
    },
    Math.max(30_000, (ONLY_SEED !== null ? 1 : ITER) * 500),
  );
});
