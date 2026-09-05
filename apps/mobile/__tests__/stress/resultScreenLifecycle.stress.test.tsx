/**
 * STRESS — ResultScreen × lifecycle interruption (unit `scr-resultscreen`,
 * lens `lifecycle`).
 *
 * The REAL app is mounted (App.tsx → Gate → providers → RootNavigator →
 * ResultScreen) with only the native seams replaced: op-sqlite (node:sqlite),
 * the Keychain vault, AppState, PickleAuth / PickleVideoCapture native modules
 * and `fetch` (an in-process account server that mints, rotates and revokes
 * sessions). Every asynchronous completion — SQLite reads, network responses,
 * pose-sidecar file reads — parks behind a gate and is released in an order
 * drawn from a seeded RNG, so each iteration is one replayable interleaving
 * of ResultScreen's four loaders (evidence, pose sidecar, sync status,
 * practice set) with:
 *
 *   background/foreground · goBack while requests are in flight · kill +
 *   relaunch (fresh module registry, re-hydrate from the persisted Keychain
 *   record + SQLite) · cancel mid-flight (route change) · bearer rotation
 *   mid-request · account switch (sign out, sign in as another user) ·
 *   refresh-token revoke-later · abort timeouts via the fake clock.
 *
 * Invariants checked after EVERY step and at quiescence:
 *   I1 no error boundary ("Something went wrong") — no crash on the core flow;
 *   I2 no cross-account leakage: user A's result content never renders while
 *      user B is the signed-in account (and vice-versa), the active data
 *      owner always matches the signed-in account, the live API bearer only
 *      ever belongs to the signed-in account;
 *   I3 the vault never holds another account's refresh token, and the
 *      persisted record is replayed idempotently by re-hydrate (same user,
 *      same owner, a bearer the server recognises);
 *   I4 no leaked timers / AppState listeners after the tree is unmounted:
 *      every live timer is attributed to its scheduler; anything owned by a
 *      screen, hook or component is a leak, and the two session singletons
 *      (sessionKeeper refresh, syncRuntime outbox retry) may only survive
 *      while a session exists;
 *   I5 no React "update on an unmounted component" / act() noise from a late
 *      completion;
 *   I6 a signed-out or revoked device shows no result content at all;
 *   I7 liveness — once every parked completion has landed, the signed-in
 *      account's own result IS on screen (no vacuous pass).
 *
 * Scale: STRESS_ITER iterations (default 10, ~1.2 s each; the campaign
 * runs 100), STRESS_SEED base seed
 * (default 20260904). Per-seed outcomes are written as a JSON table to
 * STRESS_OUT (default: <os tmpdir>/result-lifecycle-stress.json). Replay a
 * single seed with STRESS_SEED=<seed> STRESS_ITER=1, or a minimised explicit
 * schedule with STRESS_SCHEDULE="switch,drain,advance:2000,signout,drain"
 * (comma-separated step labels as printed in the JSON). STRESS_DEBUG=1 adds
 * the rendered text after every drain to the trace.
 *
 *   cd apps/mobile && STRESS_ITER=100 npx jest --ci --detectOpenHandles \
 *     __tests__/stress/resultScreenLifecycle.stress.test.tsx
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { NavigationContainerRefWithCurrent } from '@react-navigation/native';
import type { ReactTestRenderer } from 'react-test-renderer';
import type { RootStackParams } from '../../src/navigation/params';
import type { ShotAnalysis } from '@pickle/shared-types';
import type { CapturedClip } from '../../src/camera/capture';
import type { AnalysisRecord } from '@pickle/swing-domain';

// ─── Shared harness state (module-level in THIS file: survives the module
// registry resets a kill/relaunch performs, exactly like a device's SQLite
// file, Keychain and the remote server survive an app kill) ────────────────

interface Pending {
  id: number;
  kind: 'db' | 'fetch' | 'file';
  label: string;
  settle: () => void;
  /** Fail the operation (network/socket torn down) instead of completing it. */
  fail: (error: Error) => void;
}

type AppStateStatus = 'active' | 'background' | 'inactive';

const mockHarness = {
  nav: null as NavigationContainerRefWithCurrent<RootStackParams> | null,
  hold: false,
  pending: [] as Pending[],
  nextPendingId: 1,
  sqlite: null as SqliteHandle | null,
  keychain: new Map<string, { username: string; password: string }>(),
  appState: {
    current: 'active' as AppStateStatus,
    listeners: new Map<(state: AppStateStatus) => void, string>(),
  },
  files: new Map<string, string>(),
  appleIdentity: null as null | {
    user: string;
    identityToken: string;
    email: string;
    givenName: string;
  },
  server: null as FakeAccountServer | null,
  trace: [] as string[],
};

const DEBUG = process.env['STRESS_DEBUG'] === '1';

function trace(line: string): void {
  mockHarness.trace.push(line);
  if (DEBUG) process.stderr.write(`${line}\n`);
}

function gated<T>(
  kind: Pending['kind'],
  label: string,
  produce: () => T,
  onPark?: (cancel: () => void) => void,
): Promise<T> {
  if (!mockHarness.hold) {
    // Promise jobs (never queueMicrotask/setImmediate — fake timers own those).
    return Promise.resolve().then(produce);
  }
  return new Promise<T>((resolve, reject) => {
    const id = mockHarness.nextPendingId++;
    const entry: Pending = {
      id,
      kind,
      label,
      settle: () => {
        try {
          resolve(produce());
        } catch (error) {
          reject(error);
        }
      },
      fail: error => {
        const index = mockHarness.pending.indexOf(entry);
        if (index !== -1) mockHarness.pending.splice(index, 1);
        reject(error);
      },
    };
    mockHarness.pending.push(entry);
    onPark?.(() => {
      const abort = new Error('The operation was aborted.');
      abort.name = 'AbortError';
      entry.fail(abort);
    });
  });
}

// ─── node:sqlite behind op-sqlite (shared across relaunches) ────────────────

interface SqliteHandle {
  prepare(sql: string): {
    all(...params: unknown[]): Record<string, unknown>[];
    run(...params: unknown[]): unknown;
  };
  exec(sql: string): void;
  close(): void;
}

const { DatabaseSync: MockDatabaseSync } = jest.requireActual(
  'node:sqlite',
) as {
  DatabaseSync: new (location: string) => SqliteHandle;
};

function runSql(
  sql: string,
  params: unknown[],
): { rows: Record<string, unknown>[] } {
  const db =
    mockHarness.sqlite ??
    (mockHarness.sqlite = new MockDatabaseSync(':memory:'));
  const trimmed = sql.trim().toUpperCase();
  const statement = db.prepare(sql);
  if (/^(SELECT|PRAGMA|WITH)/.test(trimmed)) {
    return { rows: statement.all(...params) };
  }
  statement.run(...params);
  return { rows: [] };
}

const mockSqliteApi = {
  executeSync: (sql: string, params: unknown[] = []) => runSql(sql, params),
  execute: (sql: string, params: unknown[] = []) =>
    gated('db', sql.trim().slice(0, 48).replace(/\s+/g, ' '), () =>
      runSql(sql, params),
    ),
  close: () => {},
};

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => mockSqliteApi,
}));

// ─── Keychain vault (survives relaunch; wiped only by an explicit reset) ────

jest.mock('react-native-keychain', () => {
  const DEFAULT_SERVICE = '__default__';
  return {
    ACCESSIBLE: {
      AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY:
        'AccessibleAfterFirstUnlockThisDeviceOnly',
      WHEN_UNLOCKED: 'AccessibleWhenUnlocked',
    },
    setGenericPassword: async (
      username: string,
      password: string,
      options: { service?: string } = {},
    ) => {
      mockHarness.keychain.set(options.service ?? DEFAULT_SERVICE, {
        username,
        password,
      });
      return { service: options.service ?? DEFAULT_SERVICE, storage: 'mock' };
    },
    getGenericPassword: async (options: { service?: string } = {}) => {
      const service = options.service ?? DEFAULT_SERVICE;
      const item = mockHarness.keychain.get(service);
      return item ? { service, storage: 'mock', ...item } : false;
    },
    resetGenericPassword: async (options: { service?: string } = {}) =>
      mockHarness.keychain.delete(options.service ?? DEFAULT_SERVICE),
  };
});

// ─── Navigation ref intercept (the real RootNavigator owns the container) ──

jest.mock('@react-navigation/native', () => {
  const actual = jest.requireActual<typeof import('@react-navigation/native')>(
    '@react-navigation/native',
  );
  return {
    ...actual,
    createNavigationContainerRef: () => {
      const ref = actual.createNavigationContainerRef<RootStackParams>();
      mockHarness.nav = ref;
      return ref;
    },
  };
});

// ─── Native UI modules without a JS fallback under jest ────────────────────

jest.mock(
  'react-native-safe-area-context',
  () =>
    (
      jest.requireActual('react-native-safe-area-context/jest/mock') as {
        default: unknown;
      }
    ).default,
);
jest.mock('react-native-webview', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const WebView = () => React.createElement(View, null);
  return { __esModule: true, default: WebView, WebView };
});
jest.mock('react-native-linear-gradient', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const Gradient = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return { __esModule: true, default: Gradient };
});
jest.mock('react-native-purchases', () => ({
  __esModule: true,
  default: {
    configure: jest.fn(),
    setLogLevel: jest.fn(),
    isConfigured: jest.fn(async () => false),
    getCustomerInfo: jest.fn(async () => ({ entitlements: { active: {} } })),
    getOfferings: jest.fn(async () => ({ current: null })),
    addCustomerInfoUpdateListener: jest.fn(() => () => {}),
    logIn: jest.fn(async () => ({
      customerInfo: { entitlements: { active: {} } },
    })),
    logOut: jest.fn(async () => ({ entitlements: { active: {} } })),
  },
  LOG_LEVEL: { ERROR: 'ERROR', WARN: 'WARN', INFO: 'INFO', DEBUG: 'DEBUG' },
  PURCHASES_ERROR_CODE: {},
}));
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: jest.fn(),
    hasPlayServices: jest.fn(async () => true),
    signIn: jest.fn(),
    signInSilently: jest.fn(),
    signOut: jest.fn(),
    getTokens: jest.fn(),
  },
  statusCodes: {},
  isSuccessResponse: () => false,
  isErrorWithCode: () => false,
}));
jest.mock('react-native-svg', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return new Proxy(
    { __esModule: true, default: Mock },
    { get: (target, key) => (key in target ? (target as never)[key] : Mock) },
  );
});

// ─── In-process account server (bootstrap / refresh / logout / data) ───────

type UserKey = 'A' | 'B';

interface ServerSession {
  user: UserKey;
  accessToken: string;
  refreshToken: string;
  expiresAtSec: number;
  refreshRevoked: boolean;
}

interface FakeResponse {
  status: number;
  body: unknown;
}

const USERS: Record<
  UserKey,
  { id: string; email: string; identityToken: string; givenName: string }
> = {
  A: {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'alpha@example.test',
    identityToken: 'apple-identity-token-A',
    givenName: 'Alpha',
  },
  B: {
    id: '22222222-2222-4222-8222-222222222222',
    email: 'bravo@example.test',
    identityToken: 'apple-identity-token-B',
    givenName: 'Bravo',
  },
};

class FakeAccountServer {
  private counter = 0;
  readonly sessions: ServerSession[] = [];
  /** Next refresh call fails transiently (503) once, then clears. */
  transientRefreshFault = false;
  readonly log: string[] = [];

  private mint(user: UserKey): ServerSession {
    this.counter += 1;
    const session: ServerSession = {
      user,
      accessToken: `access-${user}-${this.counter}`,
      refreshToken: `refresh-${user}-${this.counter}`,
      expiresAtSec: Math.floor(Date.now() / 1000) + 3600,
      refreshRevoked: false,
    };
    this.sessions.push(session);
    return session;
  }

  private bearerOf(headers: Record<string, string> | undefined): string | null {
    const value = headers?.['Authorization'] ?? headers?.['authorization'];
    return value?.startsWith('Bearer ') ? value.slice(7) : null;
  }

  liveSessionFor(bearer: string | null): ServerSession | null {
    if (!bearer) return null;
    return (
      this.sessions.find(
        session =>
          session.accessToken === bearer &&
          !session.refreshRevoked &&
          session.expiresAtSec * 1000 > Date.now(),
      ) ?? null
    );
  }

  /** Server-side "permission revoked later": every session of the user dies. */
  revokeUser(user: UserKey): void {
    for (const session of this.sessions) {
      if (session.user === user) session.refreshRevoked = true;
    }
  }

  userForIdentity(token: string | null): UserKey | null {
    for (const key of ['A', 'B'] as const) {
      if (USERS[key].identityToken === token) return key;
    }
    return null;
  }

  private sessionPayload(session: ServerSession) {
    return {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: session.expiresAtSec,
    };
  }

  handle(
    url: string,
    method: string,
    headers: Record<string, string> | undefined,
    body: unknown,
  ): FakeResponse {
    const pathname = new URL(url).pathname.replace(/^\/functions\/v1\/api/, '');
    this.log.push(`${method} ${pathname}`);
    const bearer = this.bearerOf(headers);

    if (pathname === '/v1/account/bootstrap' && method === 'POST') {
      const user = this.userForIdentity(bearer);
      if (!user) {
        return {
          status: 401,
          body: { error: { code: 'auth.rejected', message: 'bad identity' } },
        };
      }
      const session = this.mint(user);
      return {
        status: 200,
        body: {
          user: { id: USERS[user].id, email: USERS[user].email },
          onboardingState: 'complete',
          session: this.sessionPayload(session),
        },
      };
    }

    if (pathname === '/v1/auth/refresh' && method === 'POST') {
      if (this.transientRefreshFault) {
        this.transientRefreshFault = false;
        return { status: 503, body: { error: { code: 'unavailable' } } };
      }
      const refreshToken =
        body && typeof body === 'object'
          ? (body as { refreshToken?: unknown }).refreshToken
          : null;
      const current = this.sessions.find(
        session => session.refreshToken === refreshToken,
      );
      if (!current || current.refreshRevoked) {
        return {
          status: 401,
          body: { error: { code: 'auth.revoked', message: 'revoked' } },
        };
      }
      current.refreshRevoked = true;
      const next = this.mint(current.user);
      return { status: 200, body: { session: this.sessionPayload(next) } };
    }

    if (pathname === '/v1/auth/logout' && method === 'POST') {
      const session = this.liveSessionFor(bearer);
      if (session) session.refreshRevoked = true;
      return { status: 200, body: {} };
    }

    const session = this.liveSessionFor(bearer);
    if (!session) {
      return {
        status: 401,
        body: { error: { code: 'auth.required', message: 'sign in' } },
      };
    }

    if (pathname === '/v1/me' && method === 'GET') {
      return {
        status: 200,
        body: {
          onboardingState: 'complete',
          profile: {
            skill_level: 'intermediate',
            handedness: 'right',
            primary_goal: 'drives',
            biggest_problem: 'consistency',
            first_name: USERS[session.user].givenName,
          },
        },
      };
    }
    if (pathname === '/v1/me/access' && method === 'GET') {
      return { status: 200, body: accessPayload() };
    }
    if (pathname === '/v1/billing/sync' && method === 'POST') {
      return {
        status: 200,
        body: {
          billing: { premium: false, entitlements: [] },
          access: accessPayload(),
        },
      };
    }
    if (pathname === '/v1/shots:sync' && method === 'POST') {
      const shots =
        body && typeof body === 'object'
          ? ((body as { shots?: unknown }).shots as Array<{ id?: unknown }>)
          : [];
      return {
        status: 200,
        body: {
          acceptedIds: (Array.isArray(shots) ? shots : [])
            .map(shot => shot?.id)
            .filter((id): id is string => typeof id === 'string'),
          rejected: [],
        },
      };
    }
    if (pathname === '/v1/training-plans/current' && method === 'GET') {
      return { status: 200, body: { plan: null } };
    }
    if (pathname === '/v1/me/saved-drills' && method === 'GET') {
      return { status: 200, body: { drills: [] } };
    }
    if (pathname === '/v1/sessions' && method === 'POST') {
      return { status: 200, body: {} };
    }
    return {
      status: 404,
      body: { error: { code: 'not_found', message: pathname } },
    };
  }
}

function accessPayload() {
  return {
    premium: false,
    entitlements: [],
    canStartRating: true,
    paywallRequired: false,
    freeRatings: {
      limit: 2,
      used: 0,
      reserved: 0,
      remaining: 2,
      availableToReserve: 2,
    },
  };
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = init?.headers;
  if (!raw) return out;
  if (raw instanceof Headers) {
    raw.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(raw)) {
    for (const [key, value] of raw) out[key] = value;
    return out;
  }
  return { ...(raw as Record<string, string>) };
}

function fakeFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers = headersOf(init);
  let body: unknown = null;
  if (typeof init?.body === 'string') {
    try {
      body = JSON.parse(init.body);
    } catch {
      body = null;
    }
  }
  const signal = init?.signal ?? null;
  if (signal?.aborted) {
    const abort = new Error('The operation was aborted.');
    abort.name = 'AbortError';
    return Promise.reject(abort);
  }
  const label = `${method} ${new URL(url).pathname.split('/').slice(-2).join('/')}`;
  return gated(
    'fetch',
    label,
    () => {
      const server = mockHarness.server;
      if (!server) throw new TypeError('Network request failed');
      const result = server.handle(url, method, headers, body);
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { 'content-type': 'application/json' },
      });
    },
    cancel => {
      signal?.addEventListener('abort', cancel, { once: true });
    },
  );
}

// ─── Seeded RNG (mulberry32) ────────────────────────────────────────────────

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

function pick<T>(rng: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error('empty pick');
  return item;
}

// ─── Schedule vocabulary ───────────────────────────────────────────────────

type Step =
  | { op: 'open'; target: 'own' | 'foreign' | 'unknown' }
  | { op: 'release'; count: number }
  | { op: 'drain' }
  | { op: 'advance'; ms: number }
  | { op: 'background' }
  | { op: 'foreground' }
  | { op: 'back' }
  | { op: 'rotate' }
  | { op: 'rotateTransient' }
  | { op: 'revoke' }
  | { op: 'switch' }
  | { op: 'signout' }
  | { op: 'kill' };

const STEP_WEIGHTS: Array<[Step['op'], number]> = [
  ['open', 22],
  ['release', 22],
  ['drain', 8],
  ['advance', 8],
  ['background', 5],
  ['foreground', 5],
  ['back', 8],
  ['rotate', 5],
  ['rotateTransient', 2],
  ['revoke', 3],
  ['switch', 5],
  ['signout', 2],
  ['kill', 5],
];

function drawStep(rng: () => number): Step {
  const total = STEP_WEIGHTS.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rng() * total;
  let op: Step['op'] = 'release';
  for (const [candidate, weight] of STEP_WEIGHTS) {
    roll -= weight;
    if (roll <= 0) {
      op = candidate;
      break;
    }
  }
  switch (op) {
    case 'open':
      return {
        op,
        target: pick(rng, ['own', 'own', 'own', 'foreign', 'unknown'] as const),
      };
    case 'release':
      return { op, count: 1 + Math.floor(rng() * 4) };
    case 'advance':
      return { op, ms: pick(rng, [250, 2_000, 9_000, 35_000, 3_500_000]) };
    default:
      return { op } as Step;
  }
}

/** Inverse of stepLabel — lets STRESS_SCHEDULE replay a minimised schedule. */
function parseStep(label: string): Step {
  const [op, arg] = label.split(':');
  switch (op) {
    case 'open':
      if (arg !== 'own' && arg !== 'foreign' && arg !== 'unknown') {
        throw new Error(`bad open target in "${label}"`);
      }
      return { op, target: arg };
    case 'release':
      return { op, count: Number(arg) };
    case 'advance':
      return { op, ms: Number(arg) };
    case 'drain':
    case 'background':
    case 'foreground':
    case 'back':
    case 'rotate':
    case 'rotateTransient':
    case 'revoke':
    case 'switch':
    case 'signout':
    case 'kill':
      return { op };
    default:
      throw new Error(`unknown step "${label}"`);
  }
}

function buildSchedule(seed: number): Step[] {
  const explicit = process.env['STRESS_SCHEDULE'];
  if (explicit) return explicit.split(',').map(s => parseStep(s.trim()));
  const rng = mulberry32(seed);
  const length = 10 + Math.floor(rng() * 9);
  const steps: Step[] = [{ op: 'open', target: 'own' }];
  for (let i = 1; i < length; i += 1) steps.push(drawStep(rng));
  steps.push({ op: 'drain' });
  return steps;
}

function stepLabel(step: Step): string {
  switch (step.op) {
    case 'open':
      return `open:${step.target}`;
    case 'release':
      return `release:${step.count}`;
    case 'advance':
      return `advance:${step.ms}`;
    default:
      return step.op;
  }
}

// ─── Fixtures: one scored analysis per account, with a real pose sidecar ───

const ANALYSIS_ID: Record<UserKey, string> = {
  A: 'analysis-alpha-0001',
  B: 'analysis-bravo-0002',
};
const CAPTURE_ID: Record<UserKey, string> = {
  A: 'capture-alpha-0001',
  B: 'capture-bravo-0002',
};
const SESSION_ID: Record<UserKey, string> = {
  A: 'set-alpha-0001',
  B: 'set-bravo-0002',
};
const CAPTURED_AT: Record<UserKey, string> = {
  A: '2026-08-11T09:15:00.000Z',
  B: '2026-08-23T17:45:00.000Z',
};
const VAULT_SERVICE = 'com.picklesensei.auth.session';
/**
 * Strings that belong to exactly one account, wherever they render (Home rank
 * card, recent reads, greeting, ResultScreen, celebration overlays). Seeing
 * one while the OTHER account (or nobody) is signed in is cross-account state.
 */
const MARKERS: Record<UserKey, string[]> = {
  A: ['7.1', 'forehand drive', 'FOREHAND DRIVE', 'Alpha'],
  B: ['4.6', 'backhand drive', 'BACKHAND DRIVE', 'Bravo'],
};
/** Strings that render ONLY on ResultScreen for that account (I7 liveness). */
const RESULT_MARKERS: Record<UserKey, string[]> = {
  A: ['FOREHAND DRIVE', 'Contact position scored 48'],
  B: ['BACKHAND DRIVE', 'Contact position scored 40'],
};

function makeAnalysis(user: UserKey): ShotAnalysis {
  const phase = (
    key: ShotAnalysis['phases'][number]['key'],
    startMs: number,
    endMs: number,
    representativeMs = startMs + (endMs - startMs) / 2,
  ) => ({ key, startMs, representativeMs, endMs, confidence: 0.8 });
  const checkpoint = (
    key: ShotAnalysis['checkpoints'][number]['key'],
    score: number,
    band: ShotAnalysis['checkpoints'][number]['band'],
    direction: ShotAnalysis['checkpoints'][number]['direction'],
  ) => ({
    key,
    score,
    confidence: 0.8,
    band,
    direction,
    severity: (100 - score) / 100,
    applicable: true,
  });
  const shotType = user === 'A' ? 'forehand_drive' : 'backhand_drive';
  return {
    id: ANALYSIS_ID[user],
    sessionId: SESSION_ID[user],
    shotType,
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: CAPTURED_AT[user],
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
      checkpoint('sequencing', 82, 'green', 'none'),
      checkpoint('paddle_path', 61, 'red', 'low'),
      checkpoint('contact_position', user === 'A' ? 48 : 40, 'red', 'late'),
      checkpoint('follow_through', 80, 'green', 'short'),
      checkpoint('recovery', 92, 'green', 'none'),
    ],
    overallScore: user === 'A' ? 7.1 : 4.6,
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
      shotConfigVersion: `${shotType}@1`,
    },
    source: 'real',
  };
}

// ─── Runtime: one launched app instance (fresh module registry each launch) ──

interface Runtime {
  React: typeof import('react');
  TR: typeof import('react-test-renderer');
  RN: typeof import('react-native');
  App: typeof import('../../App').default;
  authStore: typeof import('../../src/auth/authStore');
  accountScope: typeof import('../../src/data/accountScope');
  apiSession: typeof import('../../src/account/apiSession');
  sessionKeeper: typeof import('../../src/account/sessionKeeper');
  db: typeof import('../../src/data/db');
  repository: typeof import('../../src/data/repository');
  tree: ReactTestRenderer | null;
}

function loadRuntime(): Runtime {
  // A fresh module registry per launch (react-native's index exposes lazy
  // getters that resolve against the CURRENT registry, so isolateModules —
  // whose registry vanishes when its callback returns — would silently split
  // NativeModules/AppState between two worlds).
  jest.resetModules();
  const load = (): Runtime => {
    const RN = require('react-native') as typeof import('react-native');
    const nativeModules = RN.NativeModules as Record<string, unknown>;
    nativeModules['PickleAuth'] = {
      signInWithApple: async () => {
        const identity = mockHarness.appleIdentity;
        if (!identity) throw new Error('No Apple identity available.');
        return {
          user: identity.user,
          identityToken: identity.identityToken,
          email: identity.email,
          givenName: identity.givenName,
          familyName: 'Tester',
        };
      },
    };
    nativeModules['PickleVideoCapture'] = {
      readTextFile: (uri: string) =>
        gated('file', `read ${uri.split('/').pop()}`, () => {
          const text = mockHarness.files.get(uri);
          if (text === undefined) throw new Error(`missing artifact ${uri}`);
          return text;
        }),
    };
    // AppState with a real listener registry so leaks are countable.
    const appState = RN.AppState as unknown as {
      currentState: AppStateStatus;
      addEventListener: (
        type: string,
        handler: (state: AppStateStatus) => void,
      ) => { remove: () => void };
    };
    Object.defineProperty(appState, 'currentState', {
      configurable: true,
      get: () => mockHarness.appState.current,
    });
    appState.addEventListener = (type, handler) => {
      if (type !== 'change') return { remove: () => {} };
      mockHarness.appState.listeners.set(handler, timerOrigin());
      return {
        remove: () => {
          mockHarness.appState.listeners.delete(handler);
        },
      };
    };

    return {
      React: require('react') as typeof import('react'),
      TR: require('react-test-renderer') as typeof import('react-test-renderer'),
      RN,
      App: (require('../../App') as typeof import('../../App')).default,
      authStore:
        require('../../src/auth/authStore') as typeof import('../../src/auth/authStore'),
      accountScope:
        require('../../src/data/accountScope') as typeof import('../../src/data/accountScope'),
      apiSession:
        require('../../src/account/apiSession') as typeof import('../../src/account/apiSession'),
      sessionKeeper:
        require('../../src/account/sessionKeeper') as typeof import('../../src/account/sessionKeeper'),
      db: require('../../src/data/db') as typeof import('../../src/data/db'),
      repository:
        require('../../src/data/repository') as typeof import('../../src/data/repository'),
      tree: null,
    };
  };
  return load();
}

async function flush(rt: Runtime, rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await rt.TR.act(async () => {});
  }
}

function mountApp(rt: Runtime): void {
  rt.TR.act(() => {
    rt.tree = rt.TR.create(rt.React.createElement(rt.App));
  });
}

async function unmountApp(rt: Runtime): Promise<void> {
  const tree = rt.tree;
  if (!tree) return;
  await rt.TR.act(async () => {
    tree.unmount();
  });
  rt.tree = null;
}

function renderedText(rt: Runtime): string {
  const tree = rt.tree;
  if (!tree) return '';
  const chunks: string[] = [];
  const visit = (node: unknown): void => {
    if (node === null || node === undefined || typeof node === 'boolean')
      return;
    if (typeof node === 'string' || typeof node === 'number') {
      chunks.push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const json = node as { children?: unknown };
    visit(json.children);
  };
  visit(tree.toJSON());
  return chunks.join('\n');
}

function routeNames(): string[] {
  const nav = mockHarness.nav;
  if (!nav?.isReady()) return [];
  return nav.getRootState()?.routes.map(route => route.name) ?? [];
}

// ─── Seeding through the REAL repository API (owner-scoped rows) ───────────

async function seedAccountData(rt: Runtime, user: UserKey): Promise<void> {
  const { generateSwingSequence } =
    require('@pickle/evaluation') as typeof import('@pickle/evaluation');
  const { serializePoseSequence, sha256Hex } =
    require('@pickle/swing-domain') as typeof import('@pickle/swing-domain');
  trace(`seed ${user}: modules loaded`);
  const { sequence, window } = generateSwingSequence();
  const sidecarJson = serializePoseSequence(sequence);
  trace(`seed ${user}: sequence built`);
  const poseUri = `file:///captures/${CAPTURE_ID[user]}.pose.json`;
  mockHarness.files.set(poseUri, sidecarJson);
  const analysis = makeAnalysis(user);
  const clip: CapturedClip = {
    uri: `file:///captures/${CAPTURE_ID[user]}.mov`,
    durationMs: window.endMs,
    fps: 60,
    width: 1080,
    height: 1080,
    capturedAtIso: CAPTURED_AT[user],
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: window.startMs,
      endMs: window.endMs,
      peakMotionMs: window.peakMs,
      confidence: 0.86,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    targetSeed: { x: 0.5, y: 0.6, source: 'live_camera_tap' },
    captureEvidence: {
      schemaVersion: 1,
      window: 'detected_motion',
      poseSource: 'apple_vision_body_pose',
      poseModelVersion: 'apple-vision-bodypose-1',
      triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
      motionUnit: 'normalized_image_units_per_second',
      analysisInputFrameCount: sequence.frames.length,
      poseFrameCount: sequence.frames.length,
      poseMissingFrameCount: 0,
      trackedDurationMs: window.endMs,
      meanCanonicalJointVisibility: 0.9,
      meanJointCoverage: 0.9,
      minimumJointCoverage: 0.8,
      fullBodyVisibleFrameCount: sequence.frames.length,
      jointMotion: [
        {
          joint: 'right_wrist',
          sampleCount: 4,
          meanNormalizedPerSecond: 0.6,
          peakNormalizedPerSecond: 1.4,
        },
      ],
    },
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    preRollMs: 2000,
    postRollMs: 1500,
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: poseUri,
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
  const record = {
    id: analysis.id,
    captureId: CAPTURE_ID[user],
    createdAtIso: CAPTURED_AT[user],
    engineVersion: 'on-device-fusion-1',
    strokeIntent: {
      declaredStroke: analysis.shotType,
      predictedStroke: null,
      resolutionBasis: 'declared',
      resolvedProfileId: analysis.shotType.toUpperCase(),
      resolvedProfileVersion: 'technique-profile-v1',
      disagreement: null,
    },
    result: null,
    uncertainty: {
      analysisConfidence: 0.84,
      presentation: 'normal',
      limitingFactors: ['paddle_track_unavailable'],
    },
  } as unknown as AnalysisRecord;

  const db = rt.db.getDb();
  trace(`seed ${user}: db open`);
  await rt.repository.savePendingCapture(
    db,
    CAPTURE_ID[user],
    analysis.shotType,
    clip,
    analysis.shotType,
  );
  trace(`seed ${user}: capture saved`);
  await rt.repository.saveAnalysis(db, analysis, `permit-${user}`);
  trace(`seed ${user}: analysis saved`);
  await rt.repository.saveAnalysisRecord(db, record);
  trace(`seed ${user}: record saved`);
}

// ─── One iteration ─────────────────────────────────────────────────────────

interface StepRecord {
  step: string;
  pendingBefore: string[];
  routes: string[];
  user: UserKey | 'none';
  violations: string[];
}

interface IterationResult {
  seed: number;
  outcome: 'HELD' | 'BROKEN';
  steps: number;
  releasedCompletions: number;
  schedule: string[];
  violations: string[];
  trace: StepRecord[];
  serverCalls: number;
  durationMs: number;
}

const consoleErrors: string[] = [];
const originalConsoleError = console.error;

function installConsoleCapture(): void {
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(' '));
  };
}
function restoreConsole(): void {
  console.error = originalConsoleError;
}

// ─── Timer ledger: explains WHO owns every timer jest still counts ──────────

interface TimerEntry {
  kind: string;
  /** Innermost frame that called the timer API (who literally scheduled it). */
  direct: string;
  /** First app frame (src/ or App.tsx) on the stack, if any. */
  app: string | null;
  clear: () => void;
}

const timerLedger = new Map<unknown, TimerEntry>();

function frameLabel(frame: string): string {
  const match = /(apps\/mobile\/[^:)]+|node_modules\/(@[^/]+\/)?[^/]+)/.exec(
    frame,
  );
  return match?.[1] ?? frame.trim();
}

function stackOrigin(): { direct: string; app: string | null } {
  const frames = (new Error().stack ?? '')
    .split('\n')
    .slice(1)
    .filter(f => !f.includes('__tests__/stress') && !f.includes('fake-timers'));
  const app = frames.find(f => /apps\/mobile\/(src|App\.tsx)/.test(f));
  return {
    direct: frameLabel(frames[0] ?? '?'),
    app: app ? frameLabel(app) : null,
  };
}

function timerOrigin(): string {
  const { direct, app } = stackOrigin();
  return app && app !== direct ? `${direct} ← ${app}` : direct;
}

function installTimerLedger(): void {
  const g = globalThis as unknown as {
    setTimeout: (...args: unknown[]) => unknown;
    setInterval: (...args: unknown[]) => unknown;
    setImmediate: (...args: unknown[]) => unknown;
    requestAnimationFrame: (...args: unknown[]) => unknown;
    clearTimeout: (id: unknown) => void;
    clearInterval: (id: unknown) => void;
    clearImmediate: (id: unknown) => void;
    cancelAnimationFrame: (id: unknown) => void;
  };
  const wrapSchedule = (
    name:
      'setTimeout' | 'setInterval' | 'setImmediate' | 'requestAnimationFrame',
    repeating: boolean,
  ) => {
    const original = g[name];
    const clearName = (
      {
        setTimeout: 'clearTimeout',
        setInterval: 'clearInterval',
        setImmediate: 'clearImmediate',
        requestAnimationFrame: 'cancelAnimationFrame',
      } as const
    )[name];
    const originalClear = g[clearName];
    g[name] = (...args: unknown[]) => {
      const origin = stackOrigin();
      const callback = args[0] as (...cbArgs: unknown[]) => void;
      const handle: { id: unknown } = { id: undefined };
      const wrapped = (...cbArgs: unknown[]) => {
        if (!repeating) timerLedger.delete(handle.id);
        return callback(...cbArgs);
      };
      const id = original(wrapped, ...args.slice(1));
      handle.id = id;
      timerLedger.set(id, {
        kind: name,
        ...origin,
        clear: () => originalClear(id),
      });
      return id;
    };
  };
  wrapSchedule('setTimeout', false);
  wrapSchedule('setInterval', true);
  wrapSchedule('setImmediate', false);
  wrapSchedule('requestAnimationFrame', false);
  for (const name of [
    'clearTimeout',
    'clearInterval',
    'clearImmediate',
    'cancelAnimationFrame',
  ] as const) {
    const original = g[name];
    g[name] = (id: unknown) => {
      timerLedger.delete(id);
      return original(id);
    };
  }
}

const SINGLETON_OWNER =
  /src\/(data\/syncRuntime|account\/sessionKeeper|account\/sessionLifecycle)\.ts/;

/**
 * Exact liveness: jest only exposes a COUNT, so each ledger entry is cleared
 * and kept only if the count drops — a stale ledger row (a timer that fired
 * through a path the wrapper could not observe) is dropped. Destructive by
 * design: every caller is modelling process death right after.
 */
function collectLiveTimers(): TimerEntry[] {
  const live: TimerEntry[] = [];
  for (const [id, entry] of [...timerLedger.entries()]) {
    const before = jest.getTimerCount();
    entry.clear();
    if (jest.getTimerCount() < before) live.push(entry);
    timerLedger.delete(id);
  }
  return live;
}

function excerptAround(text: string, needle: string): string {
  const at = text.indexOf(needle);
  if (at === -1) return '';
  return text.slice(Math.max(0, at - 120), at + needle.length + 120);
}

function describeTimers(entries: TimerEntry[]): string {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const label = `${entry.kind} ${entry.direct}${entry.app && entry.app !== entry.direct ? ` ← ${entry.app}` : ''}`;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, n]) => `${n}× ${label}`)
    .join('; ');
}

class Session {
  rt: Runtime;
  signedIn: UserKey | 'none' = 'none';
  released = 0;
  readonly violations: string[] = [];
  readonly stepTrace: StepRecord[] = [];
  lastOpen: { target: 'own' | 'foreign' | 'unknown'; user: UserKey } | null =
    null;

  constructor(rt: Runtime) {
    this.rt = rt;
  }

  currentUser(): UserKey | 'none' {
    const session = this.rt.authStore.useAuthStore.getState().session;
    if (!session?.canonicalAppUserId) return 'none';
    if (session.canonicalAppUserId === USERS.A.id) return 'A';
    if (session.canonicalAppUserId === USERS.B.id) return 'B';
    return 'none';
  }

  violate(message: string): void {
    this.violations.push(message);
  }

  async settle(count: number, rng: () => number): Promise<void> {
    for (let i = 0; i < count && mockHarness.pending.length > 0; i += 1) {
      const index = Math.floor(rng() * mockHarness.pending.length);
      const [entry] = mockHarness.pending.splice(index, 1);
      if (!entry) break;
      trace(`  settle #${entry.id} ${entry.kind} ${entry.label}`);
      await this.rt.TR.act(async () => {
        entry.settle();
      });
      await flush(this.rt, 2);
      this.released += 1;
    }
  }

  async drain(rng: () => number): Promise<void> {
    let guard = 0;
    while (mockHarness.pending.length > 0 && guard < 400) {
      await this.settle(1, rng);
      guard += 1;
    }
    if (mockHarness.pending.length > 0) {
      this.violate(
        `drain did not converge (${mockHarness.pending.length} pending)`,
      );
    }
    await flush(this.rt, 3);
  }

  checkInvariants(where: string): void {
    const text = renderedText(this.rt);
    const user = this.currentUser();
    if (text.includes('Something went wrong')) {
      this.violate(`${where}: I1 error boundary rendered`);
    }
    if (user !== 'none') {
      const other: UserKey = user === 'A' ? 'B' : 'A';
      for (const marker of MARKERS[other]) {
        if (text.includes(marker) && !MARKERS[user].includes(marker)) {
          this.violate(
            `${where}: I2 marker "${marker}" of account ${other} rendered while signed-in=${user} [routes=${routeNames().join('>')}; text=${excerptAround(text, marker)}]`,
          );
        }
      }
    } else {
      for (const marker of [...MARKERS.A, ...MARKERS.B]) {
        if (text.includes(marker)) {
          this.violate(
            `${where}: I6 result content "${marker}" rendered while signed out [routes=${routeNames().join('>')}; text=${excerptAround(text, marker)}]`,
          );
        }
      }
    }
    const owner = this.rt.accountScope.getActiveDataOwner();
    if (user !== 'none') {
      const expected = this.rt.accountScope.canonicalDataOwner(USERS[user].id);
      if (owner !== expected) {
        this.violate(
          `${where}: I2 active data owner ${owner} ≠ ${expected} for ${user}`,
        );
      }
    }
    const api = this.rt.apiSession.getApiSession();
    if (api && user !== 'none' && api.canonicalAppUserId !== USERS[user].id) {
      this.violate(
        `${where}: I2 api session bound to ${api.canonicalAppUserId} while ${user} signed in`,
      );
    }
    // A sign-in in flight (busy) legitimately has its API session configured
    // before the store publishes `session` (establishSyncedAccount → persist
    // last-provider → set); only an IDLE signed-out state must have none.
    if (
      api &&
      user === 'none' &&
      !this.rt.authStore.useAuthStore.getState().busy
    ) {
      this.violate(`${where}: I2 api session alive while signed out`);
    }
    const vault = mockHarness.keychain.get(VAULT_SERVICE);
    if (vault && user !== 'none') {
      try {
        const parsed = JSON.parse(vault.password) as {
          canonicalAppUserId?: unknown;
          refreshToken?: unknown;
        };
        if (
          parsed.canonicalAppUserId &&
          parsed.canonicalAppUserId !== USERS[user].id
        ) {
          this.violate(
            `${where}: I3 vault holds ${String(parsed.canonicalAppUserId)} while ${user} signed in`,
          );
        }
        const server = mockHarness.server;
        if (server && typeof parsed.refreshToken === 'string') {
          const owner = server.sessions.find(
            s => s.refreshToken === parsed.refreshToken,
          );
          if (owner && owner.user !== user) {
            this.violate(
              `${where}: I3 vault refresh token belongs to ${owner.user}`,
            );
          }
        }
      } catch {
        this.violate(`${where}: I3 vault record is not JSON`);
      }
    }
  }

  async run(step: Step, rng: () => number): Promise<void> {
    const rt = this.rt;
    const before = mockHarness.pending.map(p => `${p.kind}:${p.label}`);
    trace(
      `step ${stepLabel(step)} pending=${before.length} routes=${routeNames().join('>')}`,
    );
    switch (step.op) {
      case 'open': {
        const nav = mockHarness.nav;
        const user = this.currentUser();
        if (!nav?.isReady() || user === 'none') break;
        const other: UserKey = user === 'A' ? 'B' : 'A';
        const analysisId =
          step.target === 'own'
            ? ANALYSIS_ID[user]
            : step.target === 'foreign'
              ? ANALYSIS_ID[other]
              : 'analysis-does-not-exist';
        this.lastOpen = { target: step.target, user };
        await rt.TR.act(async () => {
          nav.navigate('Result', { analysisId });
        });
        await flush(rt, 2);
        break;
      }
      case 'release':
        await this.settle(step.count, rng);
        break;
      case 'drain': {
        await this.drain(rng);
        if (DEBUG)
          trace(`  screen: ${renderedText(rt).replace(/\n+/g, ' | ')}`);
        // I7 liveness: once every completion has landed, the OWN result is
        // actually on screen (guards against a vacuous "nothing leaked" pass).
        const routes = routeNames();
        const opened = this.lastOpen;
        if (
          opened?.target === 'own' &&
          routes[routes.length - 1] === 'Result' &&
          this.currentUser() === opened.user
        ) {
          const text = renderedText(rt);
          const missing = RESULT_MARKERS[opened.user].filter(
            marker => !text.includes(marker),
          );
          if (missing.length > 0) {
            this.violate(
              `drain: I7 own result for ${opened.user} not rendered after drain (missing ${missing.join(', ')}) [text=${text.slice(0, 400)}]`,
            );
          }
        }
        break;
      }
      case 'advance':
        await rt.TR.act(async () => {
          jest.advanceTimersByTime(step.ms);
        });
        await flush(rt, 2);
        break;
      case 'background':
        mockHarness.appState.current = 'background';
        await rt.TR.act(async () => {
          for (const listener of [...mockHarness.appState.listeners.keys()])
            listener('background');
        });
        await flush(rt, 2);
        break;
      case 'foreground':
        mockHarness.appState.current = 'active';
        await rt.TR.act(async () => {
          for (const listener of [...mockHarness.appState.listeners.keys()])
            listener('active');
        });
        await flush(rt, 2);
        break;
      case 'back': {
        const nav = mockHarness.nav;
        if (!nav?.isReady() || !nav.canGoBack()) break;
        await rt.TR.act(async () => {
          nav.goBack();
        });
        await rt.TR.act(async () => {
          jest.advanceTimersByTime(1_000);
        });
        await flush(rt, 2);
        break;
      }
      case 'rotate':
        await rt.TR.act(async () => {
          rt.sessionKeeper.refreshSessionNow();
        });
        await flush(rt, 2);
        break;
      case 'rotateTransient':
        if (mockHarness.server) mockHarness.server.transientRefreshFault = true;
        await rt.TR.act(async () => {
          rt.sessionKeeper.refreshSessionNow();
        });
        await flush(rt, 2);
        break;
      case 'revoke': {
        const user = this.currentUser();
        if (user === 'none' || !mockHarness.server) break;
        mockHarness.server.revokeUser(user);
        await rt.TR.act(async () => {
          rt.sessionKeeper.refreshSessionNow();
        });
        await flush(rt, 2);
        break;
      }
      case 'signout':
        // Sign-out is a Settings action: it exists only for a signed-in,
        // idle session (a sign-in still in flight shows no Settings tab).
        if (rt.authStore.useAuthStore.getState().busy) {
          trace('  signout: skipped — sign-in in flight, no Settings surface');
          break;
        }
        await rt.TR.act(async () => {
          void rt.authStore.useAuthStore.getState().signOut();
        });
        await flush(rt, 2);
        break;
      case 'switch': {
        const user = this.currentUser();
        const next: UserKey = user === 'A' ? 'B' : 'A';
        mockHarness.appleIdentity = {
          user: `apple-sub-${next}`,
          identityToken: USERS[next].identityToken,
          email: USERS[next].email,
          givenName: USERS[next].givenName,
        };
        await rt.TR.act(async () => {
          void (async () => {
            const store = rt.authStore.useAuthStore.getState();
            if (store.session) await store.signOut();
            await rt.authStore.useAuthStore.getState().signInWithApple();
          })();
        });
        await flush(rt, 2);
        break;
      }
      case 'kill': {
        // Kill: the tree is torn down WITHOUT settling in-flight local work
        // (SQLite/file completions belong to the dead process and are
        // discarded — a write that had not landed never lands). In-flight
        // network requests fail as the sockets close, which is when request
        // watchdog timers must be released; then a brand-new module registry
        // re-hydrates from Keychain + SQLite.
        const persistedBefore =
          mockHarness.keychain.get(VAULT_SERVICE)?.password ?? null;
        const userBefore = this.currentUser();
        await unmountApp(rt);
        await this.failInFlightFetches(rt);
        this.assertNoLeaks('kill');
        mockHarness.pending.splice(0, mockHarness.pending.length);
        this.rt = loadRuntime();
        mountApp(this.rt);
        await flush(this.rt, 2);
        // Idempotent re-hydrate: settle only this launch's work and compare.
        await this.drain(rng);
        const persistedAfter =
          mockHarness.keychain.get(VAULT_SERVICE)?.password ?? null;
        const userAfter = this.currentUser();
        trace(
          `  kill: before=${userBefore} vault=${persistedBefore ? 'yes' : 'no'} → after=${userAfter} vault=${persistedAfter ? 'yes' : 'no'} bearer=${this.rt.apiSession.getApiSession()?.bearerToken ?? 'null'} routes=${routeNames().join('>')}`,
        );
        if (
          persistedBefore &&
          userBefore !== 'none' &&
          userAfter !== userBefore
        ) {
          const server = mockHarness.server;
          const before = JSON.parse(persistedBefore) as {
            refreshToken?: string;
          };
          const stillValid = server?.sessions.some(
            s => s.refreshToken === before.refreshToken && !s.refreshRevoked,
          );
          if (stillValid) {
            this.violate(
              `kill: I3 re-hydrate lost signed-in account ${userBefore} (now ${userAfter}) although the refresh token was valid`,
            );
          }
        }
        if (userAfter !== 'none') {
          // The launch refresh may have hit a transient 5xx: the contract is
          // "signed in with local data, keeper retries with backoff". Give the
          // backoff up to RETRY_MAX (5 min) of fake time to land a bearer.
          let recoveredAfterMs = 0;
          const bearerLive = () => {
            const api = this.rt.apiSession.getApiSession();
            const live = mockHarness.server?.liveSessionFor(
              api?.bearerToken ?? null,
            );
            return Boolean(api && live && live.user === userAfter);
          };
          while (
            !bearerLive() &&
            this.currentUser() === userAfter &&
            recoveredAfterMs < 6 * 60_000
          ) {
            await this.rt.TR.act(async () => {
              jest.advanceTimersByTime(15_000);
            });
            recoveredAfterMs += 15_000;
            await flush(this.rt, 2);
            await this.drain(rng);
          }
          if (this.currentUser() !== userAfter) {
            // The retry was refused (401/403): legitimate only if the server
            // really no longer recognises the persisted refresh token.
            const persisted = persistedAfter
              ? (JSON.parse(persistedAfter) as { refreshToken?: string })
              : null;
            const stillValid = mockHarness.server?.sessions.some(
              s =>
                s.refreshToken === persisted?.refreshToken && !s.refreshRevoked,
            );
            if (stillValid) {
              this.violate(
                `kill: I3 ${userAfter} signed out during launch refresh retries although the refresh token was valid`,
              );
            } else {
              trace(
                `  kill: ${userAfter} signed out after ${recoveredAfterMs}ms — refresh token revoked server-side`,
              );
            }
          } else if (!bearerLive()) {
            this.violate(
              `kill: I3 re-hydrated ${userAfter} without a server-recognised bearer (none after ${recoveredAfterMs}ms of retries)`,
            );
          } else if (recoveredAfterMs > 0) {
            trace(
              `  kill: bearer recovered after ${recoveredAfterMs}ms of backoff`,
            );
          }
          if (persistedAfter) {
            const after = JSON.parse(persistedAfter) as {
              canonicalAppUserId?: string;
            };
            if (after.canonicalAppUserId !== USERS[userAfter].id) {
              this.violate(
                `kill: I3 vault record ${String(after.canonicalAppUserId)} ≠ re-hydrated ${userAfter}`,
              );
            }
          }
        }
        break;
      }
      default:
        break;
    }
    this.checkInvariants(stepLabel(step));
    this.stepTrace.push({
      step: stepLabel(step),
      pendingBefore: before,
      routes: routeNames(),
      user: this.currentUser(),
      violations: this.violations.slice(),
    });
  }

  /** Network torn down under the (already unmounted) tree: every parked
   * fetch rejects like a closed socket, so request watchdogs must clear. */
  async failInFlightFetches(rt: Runtime): Promise<void> {
    const fetches = mockHarness.pending.filter(p => p.kind === 'fetch');
    if (fetches.length === 0) return;
    await rt.TR.act(async () => {
      for (const entry of fetches) {
        trace(`  network down: ${entry.label}`);
        entry.fail(new TypeError('Network request failed'));
      }
    });
    await flush(rt, 3);
  }

  /**
   * I4 after the React tree is gone. Two owners are process singletons whose
   * lifetime is the signed-in SESSION, not any component: sessionKeeper's
   * refresh timer/foreground listener and syncRuntime's outbox retry
   * timer/listener. They may survive an unmount only while a session exists;
   * with no session (signed out / revoked) nothing at all may remain, and
   * anything owned by a screen, hook or component is a leak regardless.
   */
  assertNoLeaks(where: string): void {
    const sessionAlive =
      this.rt.authStore.useAuthStore.getState().session !== null;
    const totalBefore = jest.getTimerCount();
    const live = collectLiveTimers();
    const unattributed = totalBefore - live.length;
    // Jest's own RN preset cannot cancel the 16ms end-callback its
    // NativeAnimatedModule mock schedules, and React's scheduler keeps one
    // setImmediate for its work loop: neither is app code.
    const isHarnessArtifact = (entry: TimerEntry) =>
      /node_modules\/(@react-native\/jest-preset|scheduler)/.test(entry.direct);
    const owned = live.filter(entry => !isHarnessArtifact(entry));
    const treeOwned = owned.filter(
      entry => !SINGLETON_OWNER.test(entry.app ?? entry.direct),
    );
    const singletonOwned = owned.filter(entry =>
      SINGLETON_OWNER.test(entry.app ?? entry.direct),
    );
    if (treeOwned.length > 0) {
      this.violate(
        `${where}: I4 tree-owned timer(s) survive unmount [${describeTimers(treeOwned)}]`,
      );
    }
    if (singletonOwned.length > 0 && !sessionAlive) {
      this.violate(
        `${where}: I4 session-singleton timer(s) alive with no session [${describeTimers(singletonOwned)}]`,
      );
    }
    if (unattributed > 0) {
      this.violate(
        `${where}: I4 ${unattributed} timer(s) alive that no wrapped scheduler created`,
      );
    }
    trace(
      `  leaks@${where}: live=${live.length} artifacts=${live.length - owned.length} singleton=${singletonOwned.length} tree=${treeOwned.length} session=${sessionAlive}`,
    );
    const listenerOwners = [...mockHarness.appState.listeners.values()];
    const foreignListeners = listenerOwners.filter(
      o => !SINGLETON_OWNER.test(o),
    );
    if (foreignListeners.length > 0) {
      this.violate(
        `${where}: I4 tree-owned AppState listener(s) survive unmount [${foreignListeners.join('; ')}]`,
      );
    } else if (listenerOwners.length > 0 && !sessionAlive) {
      this.violate(
        `${where}: I4 AppState listener(s) registered with no session [${listenerOwners.join('; ')}]`,
      );
    }
    // Process death: whatever the dead process still had scheduled is gone.
    jest.clearAllTimers();
    timerLedger.clear();
    mockHarness.appState.listeners.clear();
  }
}

async function runIteration(seed: number): Promise<IterationResult> {
  const started = Date.now();
  const schedule = buildSchedule(seed);
  const rng = mulberry32(seed ^ 0x9e3779b9);
  mockHarness.trace = [];
  consoleErrors.length = 0;

  // Device state: fresh SQLite + Keychain + server per iteration. User A has
  // signed in on this device before (vault record present) and both accounts
  // have one scored result stored under their own data owner.
  mockHarness.sqlite?.close();
  mockHarness.sqlite = null;
  mockHarness.keychain.clear();
  mockHarness.files.clear();
  mockHarness.appState.current = 'active';
  mockHarness.appState.listeners.clear();
  mockHarness.pending.splice(0, mockHarness.pending.length);
  mockHarness.hold = false;
  mockHarness.server = new FakeAccountServer();
  mockHarness.appleIdentity = {
    user: 'apple-sub-A',
    identityToken: USERS.A.identityToken,
    email: USERS.A.email,
    givenName: USERS.A.givenName,
  };

  // Prepare device data through a throwaway runtime with the gate open.
  {
    trace(`seed ${seed}: prep`);
    const prep = loadRuntime();
    trace('prep runtime loaded');
    for (const user of ['B', 'A'] as const) {
      prep.accountScope.setActiveDataOwner(
        prep.accountScope.canonicalDataOwner(USERS[user].id),
      );
      await seedAccountData(prep, user);
    }
    prep.accountScope.setActiveDataOwner(
      prep.accountScope.SIGNED_OUT_DATA_OWNER,
    );
    trace('prep data seeded');
    // Sign A in for real once (bootstrap → vault record), then "close" the app.
    await prep.TR.act(async () => {
      await prep.authStore.useAuthStore.getState().signInWithApple();
    });
    await flush(prep, 3);
    trace('prep sign-in done');
    if (
      prep.authStore.useAuthStore.getState().session?.canonicalAppUserId !==
      USERS.A.id
    ) {
      throw new Error(
        `prep sign-in failed: ${JSON.stringify(prep.authStore.useAuthStore.getState().error)}`,
      );
    }
    // "Close the app": the prep process dies with its keeper timers and
    // listeners; only SQLite, the Keychain record and the server survive.
    prep.sessionKeeper.stopSessionKeeper();
    jest.clearAllTimers();
    timerLedger.clear();
    mockHarness.appState.listeners.clear();
  }

  mockHarness.hold = true;
  const session = new Session(loadRuntime());
  trace('launch runtime loaded');
  mountApp(session.rt);
  await flush(session.rt, 2);
  trace('launch mounted');
  // Launch: settle hydrate work until the navigator is ready (bounded).
  for (let guard = 0; guard < 120 && !mockHarness.nav?.isReady(); guard += 1) {
    if (mockHarness.pending.length === 0) {
      await session.rt.TR.act(async () => {
        jest.advanceTimersByTime(250);
      });
      await flush(session.rt, 2);
      continue;
    }
    await session.settle(1, rng);
  }
  if (!mockHarness.nav?.isReady()) {
    session.violate(
      `launch: navigator never became ready (user=${session.currentUser()}, text=${renderedText(session.rt).slice(0, 200)})`,
    );
  }
  session.checkInvariants('launch');

  for (const step of schedule) {
    await session.run(step, rng);
  }

  // Unmounted mid-request: everything still parked now lands (or fails, for
  // requests) against the gone tree — late completions must be harmless (I5)
  // and must release every timer they held (I4).
  await unmountApp(session.rt);
  await session.failInFlightFetches(session.rt);
  await session.drain(rng);
  session.assertNoLeaks('final');
  mockHarness.hold = false;
  mockHarness.pending.splice(0, mockHarness.pending.length);

  const actNoise = consoleErrors.filter(line =>
    /not wrapped in act|unmounted component|Can't perform a React state update/.test(
      line,
    ),
  );
  for (const line of actNoise.slice(0, 3)) {
    session.violate(`I5 console.error: ${line.slice(0, 200)}`);
  }

  return {
    seed,
    outcome: session.violations.length === 0 ? 'HELD' : 'BROKEN',
    steps: schedule.length,
    releasedCompletions: session.released,
    schedule: schedule.map(stepLabel),
    violations: session.violations,
    trace: session.stepTrace,
    serverCalls: mockHarness.server?.log.length ?? 0,
    durationMs: Date.now() - started,
  };
}

// ─── Campaign ──────────────────────────────────────────────────────────────

const ITERATIONS = Number(process.env['STRESS_ITER'] ?? 10);
const BASE_SEED = Number(process.env['STRESS_SEED'] ?? 20260904);
const OUT_PATH =
  process.env['STRESS_OUT'] ??
  path.join(os.tmpdir(), 'result-lifecycle-stress.json');

beforeAll(() => {
  // Microtask queues stay real: React (queueMicrotask) and promise chains
  // must keep flowing between the scheduled interruptions; only the timers
  // the app itself owns (timeouts, intervals, immediates, frames, Date) are
  // under harness control.
  jest.useFakeTimers({
    doNotFake: [
      'nextTick',
      'queueMicrotask',
      'requestIdleCallback',
      'cancelIdleCallback',
    ],
  });
  installTimerLedger();
  (globalThis as { fetch: typeof fetch }).fetch = fakeFetch as typeof fetch;
  installConsoleCapture();
});

afterAll(() => {
  restoreConsole();
  jest.useRealTimers();
  mockHarness.sqlite?.close();
  mockHarness.sqlite = null;
});

test(
  `ResultScreen survives ${ITERATIONS} seeded lifecycle interleavings`,
  async () => {
    const results: IterationResult[] = [];
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = BASE_SEED + i;
      let result: IterationResult;
      try {
        result = await runIteration(seed);
      } catch (error) {
        result = {
          seed,
          outcome: 'BROKEN',
          steps: 0,
          releasedCompletions: 0,
          schedule: buildSchedule(seed).map(stepLabel),
          violations: [
            `harness exception: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
          ],
          trace: [],
          serverCalls: 0,
          durationMs: 0,
        };
        mockHarness.hold = false;
      }
      results.push(result);
      if (result.outcome === 'BROKEN') {
        fs.writeFileSync(
          `${OUT_PATH}.seed-${seed}.trace.log`,
          mockHarness.trace.join('\n'),
        );
      }
    }
    const summary = {
      unit: 'scr-resultscreen',
      lens: 'lifecycle',
      baseSeed: BASE_SEED,
      iterations: results.length,
      held: results.filter(r => r.outcome === 'HELD').length,
      broken: results.filter(r => r.outcome === 'BROKEN').map(r => r.seed),
      totalSteps: results.reduce((sum, r) => sum + r.steps, 0),
      totalReleasedCompletions: results.reduce(
        (sum, r) => sum + r.releasedCompletions,
        0,
      ),
      results,
    };
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, JSON.stringify(summary, null, 2));

    const broken = results.filter(r => r.outcome === 'BROKEN');
    expect(
      broken.map(r => ({ seed: r.seed, violations: r.violations.slice(0, 4) })),
    ).toEqual([]);
  },
  20 * 60 * 1000,
);
