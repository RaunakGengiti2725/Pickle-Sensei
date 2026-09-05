/**
 * Lifecycle-interruption stress campaign for SettingsScreen, rendered inside
 * the REAL App tree (SafeAreaProvider → QueryClientProvider → RootErrorBoundary
 * → Gate → RootNavigator → Settings tab). Stores, hooks, navigation, the
 * session keeper and the SQLite/Keychain persistence paths are the production
 * modules; only native modules (SQLite, Keychain, WebView, RevenueCat,
 * AppState, Sign in with Apple) and `fetch` are replaced.
 *
 * Every iteration is a seeded, replayable schedule of lifecycle actions
 * (background/foreground, tab focus/blur, warm unmount/remount, kill/relaunch
 * with Keychain+SQLite surviving, held/failed/401'd in-flight requests, token
 * rotation, server-side revocation, sign-out, account switch) executed against
 * a deterministic fake backend that serves two accounts. Invariants are
 * checked after every action and at teardown:
 *   - rendered text never shows the other account's identity/profile/access
 *   - store state (api session, access, consent, profile owner, Keychain)
 *     never belongs to a previous user
 *   - every outbound request carries the CURRENT account's credential
 *   - Keychain/SQLite never hold access or provider tokens
 *   - no React render error / error boundary
 *   - after sign-out + unmount: zero live timers and zero AppState listeners
 *   - kill/relaunch re-hydrates the same account with the server's current
 *     refresh token (idempotent re-hydrate)
 *
 * Default is a small campaign so the suite stays fast; the full run is:
 *   STRESS_ITER=100 STRESS_OUT=/tmp/settings-lifecycle.json \
 *     npx jest --ci --detectOpenHandles __tests__/stress/settingsScreen.lifecycle.stress.test.tsx
 * Replay specific seeds with STRESS_SEEDS=17,42.
 */
import type React from 'react';
import type TestRenderer from 'react-test-renderer';

declare const require: (id: string) => unknown;

// ─── Node helpers (typed narrowly; jest's CJS transform cannot `import()`) ───

const fs = require('fs') as {
  writeFileSync: (p: string, data: string) => void;
  mkdirSync: (p: string, options: { recursive: true }) => void;
};
const path = require('path') as {
  join: (...parts: string[]) => string;
  dirname: (p: string) => string;
  resolve: (...parts: string[]) => string;
};
const os = require('os') as { tmpdir: () => string };

// ─── Timer instrumentation (installed before any app module loads) ───────────

interface TrackedTimer {
  kind: 'timeout' | 'interval';
  delayMs: number;
  process: number;
  origin: string;
}

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const realSetImmediate = globalThis.setImmediate;

const liveTimers = new Map<unknown, TrackedTimer>();
/** Bumped on every simulated process kill; timers of dead processes die. */
let processGeneration = 0;

function originOf(stack: string | undefined): string {
  return (stack ?? '')
    .split('\n')
    .slice(2, 7)
    .map(line => line.trim().replace(/^at\s+/, ''))
    .filter(line => !/node_modules\/(react|scheduler|jest-mock)\//.test(line))
    .join(' <- ');
}

globalThis.setTimeout = ((
  fn: (...args: unknown[]) => void,
  delayMs?: number,
  ...args: unknown[]
) => {
  const handle: ReturnType<typeof realSetTimeout> = realSetTimeout(
    (...inner: unknown[]) => {
      liveTimers.delete(handle);
      fn(...inner);
    },
    delayMs,
    ...args,
  );
  liveTimers.set(handle, {
    kind: 'timeout',
    delayMs: Number(delayMs) || 0,
    process: processGeneration,
    origin: originOf(new Error().stack),
  });
  return handle;
}) as unknown as typeof setTimeout;

globalThis.clearTimeout = ((handle: unknown) => {
  liveTimers.delete(handle);
  realClearTimeout(handle as ReturnType<typeof realSetTimeout>);
}) as typeof clearTimeout;

globalThis.setInterval = ((
  fn: (...args: unknown[]) => void,
  delayMs?: number,
  ...args: unknown[]
) => {
  const handle = realSetInterval(fn, delayMs, ...args);
  liveTimers.set(handle, {
    kind: 'interval',
    delayMs: Number(delayMs) || 0,
    process: processGeneration,
    origin: originOf(new Error().stack),
  });
  return handle;
}) as unknown as typeof setInterval;

globalThis.clearInterval = ((handle: unknown) => {
  liveTimers.delete(handle);
  realClearInterval(handle as ReturnType<typeof realSetInterval>);
}) as typeof clearInterval;

function liveTimersOfCurrentProcess(): TrackedTimer[] {
  return [...liveTimers.values()].filter(t => t.process === processGeneration);
}

/** Models process death: every timer the dead process armed stops existing. */
function killProcessTimers(): void {
  for (const [handle, timer] of [...liveTimers.entries()]) {
    if (timer.process !== processGeneration) continue;
    if (timer.kind === 'interval') {
      realClearInterval(handle as ReturnType<typeof realSetInterval>);
    } else {
      realClearTimeout(handle as ReturnType<typeof realSetTimeout>);
    }
    liveTimers.delete(handle);
  }
}

// ─── Native module mocks ─────────────────────────────────────────────────────

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
/** The "device disk": survives kill/relaunch, wiped between iterations. */
let mockSqlite: DatabaseSync = new DatabaseSync(':memory:');

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => ({
    executeSync: (sql: string) => ({ rows: mockSqlite.prepare(sql).all() }),
    execute: async (sql: string, params: unknown[] = []) => ({
      rows: mockSqlite
        .prepare(sql)
        .all(...(params as (string | number | null)[])),
    }),
    close: () => {},
  }),
}));

/** The "device Keychain": survives kill/relaunch, wiped between iterations. */
const mockKeychain = new Map<string, { username: string; password: string }>();

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
    mockKeychain.set(options.service ?? 'default', { username, password });
    return { service: options.service ?? 'default', storage: 'keychain' };
  },
  getGenericPassword: async (options: { service?: string } = {}) => {
    const entry = mockKeychain.get(options.service ?? 'default');
    return entry
      ? { service: options.service ?? 'default', ...entry, storage: 'keychain' }
      : false;
  },
  resetGenericPassword: async (options: { service?: string } = {}) =>
    mockKeychain.delete(options.service ?? 'default'),
}));

jest.mock(
  'react-native-safe-area-context',
  () =>
    (
      require('react-native-safe-area-context/jest/mock') as {
        default: unknown;
      }
    ).default,
);

jest.mock('react-native-webview', () => {
  const ReactModule = require('react') as typeof React;
  const { View } = require('react-native') as typeof import('react-native');
  const MockWebView = (props: Record<string, unknown>) =>
    ReactModule.createElement(View, props);
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});

jest.mock('react-native-purchases', () => ({
  __esModule: true,
  default: {
    isConfigured: async () => true,
    configure: () => {},
    getAppUserID: async () => 'user',
    logIn: async () => ({}),
    getOfferings: async () => ({ current: null }),
    getCustomerInfo: async () => ({ entitlements: { active: {} } }),
    restorePurchases: async () => ({ entitlements: { active: {} } }),
    purchasePackage: async () => ({
      customerInfo: { entitlements: { active: {} } },
    }),
    checkTrialOrIntroductoryPriceEligibility: async () => ({}),
  },
}));

// ─── Seeded RNG (mulberry32) ─────────────────────────────────────────────────

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
    return items[this.int(items.length)] as T;
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

// ─── Fake backend: two canonical accounts ────────────────────────────────────

type AccountKey = 'A' | 'B';

interface Account {
  key: AccountKey;
  id: string;
  email: string;
  identityToken: string;
  givenName: string;
  familyName: string;
  firstName: string;
  skillLevel: string;
  premium: boolean;
  modelTrainingActive: boolean;
  /** Strings that must never render while another account is signed in. */
  markers: string[];
}

const ACCOUNTS: Record<AccountKey, Account> = {
  A: {
    key: 'A',
    id: '11111111-1111-4111-8111-111111111111',
    email: 'ava-alpha@example.com',
    identityToken: 'idtok-A',
    givenName: 'Ava',
    familyName: 'Alpha',
    firstName: 'Avalanche',
    skillLevel: 'Beginner',
    premium: false,
    modelTrainingActive: true,
    markers: [
      'ava-alpha@example.com',
      'Ava Alpha',
      'Avalanche',
      '2 free ratings left',
      'Training: contributing',
    ],
  },
  B: {
    key: 'B',
    id: '22222222-2222-4222-8222-222222222222',
    email: 'bo-bravo@example.com',
    identityToken: 'idtok-B',
    givenName: 'Bo',
    familyName: 'Bravo',
    firstName: 'Boreal',
    skillLevel: 'Advanced',
    premium: true,
    modelTrainingActive: false,
    markers: [
      'bo-bravo@example.com',
      'Bo Bravo',
      'Boreal',
      'Pro active',
      'Training: off',
    ],
  },
};

function accessFor(account: Account): Record<string, unknown> {
  return account.premium
    ? {
        premium: true,
        entitlements: ['premium'],
        canStartRating: true,
        paywallRequired: false,
        freeRatings: {
          limit: 2,
          used: 2,
          reserved: 0,
          remaining: 0,
          availableToReserve: 0,
        },
      }
    : {
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

function consentFor(account: Account): Record<string, unknown> {
  return {
    subjectPseudonym: `pseud-${account.key}`,
    scopes: [
      {
        scope: 'model_training',
        active: account.modelTrainingActive,
        consentVersion: account.modelTrainingActive
          ? 'model-training-v1'
          : null,
        lastAction: account.modelTrainingActive ? 'granted' : null,
        lastActionAt: account.modelTrainingActive
          ? '2026-09-01T00:00:00.000Z'
          : null,
      },
      {
        scope: 'evaluation_telemetry',
        active: false,
        consentVersion: null,
        lastAction: null,
        lastActionAt: null,
      },
    ],
  };
}

function profileFor(account: Account): Record<string, unknown> {
  return {
    onboardingState: 'complete',
    profile: {
      first_name: account.firstName,
      gender: 'other',
      skill_level: account.skillLevel,
      handedness: 'right',
      primary_goal: 'dinks',
      biggest_problem: 'consistency',
    },
  };
}

interface RequestRecord {
  id: number;
  method: string;
  path: string;
  /** Which account the credential on the request belongs to (null: none). */
  credentialOwner: AccountKey | null;
  credentialKind: 'access' | 'refresh' | 'identity' | 'logout' | 'none';
  /** Which account was signed in (authStore) when the request was sent. */
  signedInAtSend: AccountKey | null;
  /** Process generation the request was sent from. */
  process: number;
  outcome: 'immediate' | 'held' | 'released' | 'failed' | 'dropped' | '401';
  status: number | null;
}

interface PendingRequest {
  record: RequestRecord;
  respond: () => Response;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
}

class FakeBackend {
  readonly log: RequestRecord[] = [];
  readonly pending: PendingRequest[] = [];
  /** Live tokens → account. Rotation deletes the old refresh token. */
  private accessTokens = new Map<string, AccountKey>();
  private refreshTokens = new Map<string, AccountKey>();
  /** The refresh token the server currently considers valid per account. */
  readonly currentRefreshToken = new Map<AccountKey, string>();
  /** Accounts whose sessions were revoked server-side (refresh → 401). */
  readonly revoked = new Set<AccountKey>();
  /** When set, the next bearer-authenticated route answers 401 (the access
   * token expired server-side; the client must rotate and retry later). */
  expireBearerOnNextRequest = false;
  private counter = 0;
  private nextId = 1;
  holdProbability = 0;
  bearerLifetimeSec = 3600;
  rng = new Rng(0);
  currentSignedIn: () => AccountKey | null = () => null;

  private mintSession(account: AccountKey): Record<string, unknown> {
    this.counter += 1;
    const accessToken = `acc-${account}-${this.counter}`;
    const refreshToken = `ref-${account}-${this.counter}`;
    this.accessTokens.set(accessToken, account);
    this.refreshTokens.set(refreshToken, account);
    this.currentRefreshToken.set(account, refreshToken);
    return {
      accessToken,
      refreshToken,
      expiresAt: Math.floor(Date.now() / 1000) + this.bearerLifetimeSec,
    };
  }

  /** Server-side revocation of every session of the account (support tool,
   * password reset, account deletion elsewhere): refresh tokens die. */
  revoke(account: AccountKey): void {
    this.revoked.add(account);
    for (const [token, owner] of [...this.refreshTokens.entries()]) {
      if (owner === account) this.refreshTokens.delete(token);
    }
    for (const [token, owner] of [...this.accessTokens.entries()]) {
      if (owner === account) this.accessTokens.delete(token);
    }
  }

  private credentialOf(
    init: RequestInit | undefined,
    path: string,
  ): Pick<RequestRecord, 'credentialOwner' | 'credentialKind'> & {
    token: string | null;
  } {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = headers.Authorization ?? headers.authorization ?? '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (path === '/v1/auth/refresh') {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        refreshToken?: string;
      };
      const token = body.refreshToken ?? null;
      const owner = token ? this.ownerOfRefresh(token) : null;
      return { credentialOwner: owner, credentialKind: 'refresh', token };
    }
    if (path === '/v1/auth/logout') {
      // Sent AFTER authStore cleared the session (best-effort device revoke):
      // bears the just-abandoned access token by design.
      return {
        credentialOwner: bearer ? this.ownerOfAccess(bearer) : null,
        credentialKind: 'logout',
        token: bearer,
      };
    }
    if (path === '/v1/account/bootstrap') {
      const owner = (Object.values(ACCOUNTS).find(
        a => a.identityToken === bearer,
      )?.key ?? null) as AccountKey | null;
      return {
        credentialOwner: owner,
        credentialKind: 'identity',
        token: bearer,
      };
    }
    if (bearer) {
      return {
        credentialOwner:
          this.accessTokens.get(bearer) ?? this.ownerOfAccess(bearer),
        credentialKind: 'access',
        token: bearer,
      };
    }
    return { credentialOwner: null, credentialKind: 'none', token: null };
  }

  /** Token owner from its shape, for tokens the server no longer honours. */
  private ownerOfAccess(token: string): AccountKey | null {
    const match = /^acc-([AB])-/.exec(token);
    return match ? (match[1] as AccountKey) : null;
  }
  private ownerOfRefresh(token: string): AccountKey | null {
    const match = /^ref-([AB])-/.exec(token);
    return match ? (match[1] as AccountKey) : null;
  }

  private answer(
    method: string,
    path: string,
    init: RequestInit | undefined,
    record: RequestRecord,
  ): () => Response {
    return () => {
      const credential = this.credentialOf(init, path);
      if (path === '/v1/account/bootstrap') {
        const account = credential.credentialOwner;
        if (!account || this.revoked.has(account)) {
          return json(record, 401, { error: { message: 'invalid token' } });
        }
        const details = ACCOUNTS[account];
        return json(record, 200, {
          user: { id: details.id, email: details.email },
          onboardingState: 'complete',
          session: this.mintSession(account),
        });
      }
      if (path === '/v1/auth/refresh') {
        const owner = credential.token
          ? this.refreshTokens.get(credential.token)
          : undefined;
        if (!owner) {
          return json(record, 401, { error: { message: 'refresh refused' } });
        }
        this.refreshTokens.delete(credential.token!);
        return json(record, 200, { session: this.mintSession(owner) });
      }
      if (path === '/v1/auth/logout') {
        const owner = credential.token
          ? this.accessTokens.get(credential.token)
          : undefined;
        if (!owner) {
          return json(record, 401, { error: { message: 'unauthorized' } });
        }
        // scope=local: this device's session dies, i.e. every token minted
        // for it (the fake keeps one live session per account).
        this.accessTokens.delete(credential.token!);
        for (const [token, who] of [...this.refreshTokens.entries()]) {
          if (who === owner) this.refreshTokens.delete(token);
        }
        return json(record, 200, { ok: true });
      }
      const owner = credential.token
        ? this.accessTokens.get(credential.token)
        : undefined;
      if (!owner) {
        return json(record, 401, { error: { message: 'unauthorized' } });
      }
      if (this.expireBearerOnNextRequest) {
        this.expireBearerOnNextRequest = false;
        this.accessTokens.delete(credential.token!);
        record.outcome = '401';
        return json(record, 401, { error: { message: 'token expired' } });
      }
      const details = ACCOUNTS[owner];
      switch (`${method} ${path}`) {
        case 'GET /v1/me':
          return json(record, 200, profileFor(details));
        case 'GET /v1/me/access':
          return json(record, 200, accessFor(details));
        case 'GET /v1/me/consent/status':
          return json(record, 200, consentFor(details));
        default:
          return json(record, 404, { error: { message: 'not found' } });
      }
    };
  }

  readonly fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const requestPath = url.replace(
      /^https?:\/\/[^/]+\/functions\/v1\/api/,
      '',
    );
    const method = init?.method ?? 'GET';
    const credential = this.credentialOf(init, requestPath);
    const record: RequestRecord = {
      id: this.nextId++,
      method,
      path: requestPath,
      credentialOwner: credential.credentialOwner,
      credentialKind: credential.credentialKind,
      signedInAtSend: this.currentSignedIn(),
      process: processGeneration,
      outcome: 'immediate',
      status: null,
    };
    this.log.push(record);
    const respond = this.answer(method, requestPath, init, record);
    if (this.rng.next() < this.holdProbability) {
      record.outcome = 'held';
      return new Promise<Response>((resolve, reject) => {
        this.pending.push({ record, respond, resolve, reject });
      });
    }
    return Promise.resolve(respond());
  };

  releaseOne(index: number): RequestRecord | null {
    const entry = this.pending.splice(index, 1)[0];
    if (!entry) return null;
    if (entry.record.outcome === 'held') entry.record.outcome = 'released';
    entry.resolve(entry.respond());
    return entry.record;
  }

  failOne(index: number): RequestRecord | null {
    const entry = this.pending.splice(index, 1)[0];
    if (!entry) return null;
    entry.record.outcome = 'failed';
    entry.record.status = 0;
    entry.reject(new TypeError('Network request failed'));
    return entry.record;
  }

  releaseAll(): number {
    let released = 0;
    while (this.pending.length > 0) {
      this.releaseOne(0);
      released += 1;
    }
    return released;
  }

  /** Process death: in-flight requests of the dead process never settle. */
  dropAll(): number {
    const dropped = this.pending.splice(0, this.pending.length);
    for (const entry of dropped) entry.record.outcome = 'dropped';
    return dropped.length;
  }
}

function json(record: RequestRecord, status: number, body: unknown): Response {
  record.status = status;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => 'application/json' },
  } as unknown as Response;
}

const backend = new FakeBackend();
globalThis.fetch = backend.fetch as typeof fetch;

// ─── Per-process app runtime (fresh module registry after every "kill") ──────

type AuthStoreModule = typeof import('../../src/auth/authStore');
type AppStoreModule = typeof import('../../src/state/appStore');
type AccessStoreModule = typeof import('../../src/state/accessStore');
type ConsentStoreModule = typeof import('../../src/state/consentStore');
type ApiSessionModule = typeof import('../../src/account/apiSession');
type DataOwnerModule = typeof import('../../src/data/accountScope');
type ReactNativeModule = typeof import('react-native');
type TestRendererModule = typeof import('react-test-renderer');

interface AppStateListener {
  handler: (state: string) => void;
  origin: string;
}

const liveAppStateListeners = new Set<AppStateListener>();

interface Runtime {
  React: typeof React;
  RN: ReactNativeModule;
  TR: TestRendererModule;
  App: React.ComponentType;
  auth: AuthStoreModule;
  app: AppStoreModule;
  access: AccessStoreModule;
  consent: ConsentStoreModule;
  apiSession: ApiSessionModule;
  dataOwner: DataOwnerModule;
}

function bootProcess(): Runtime {
  jest.resetModules();
  const ReactModule = require('react') as typeof React;
  const RN = require('react-native') as ReactNativeModule;
  const TR = require('react-test-renderer') as TestRendererModule;
  const addEventListener = RN.AppState.addEventListener as unknown as jest.Mock;
  if (typeof addEventListener.mockImplementation !== 'function') {
    throw new Error('AppState.addEventListener is not the jest preset mock');
  }
  addEventListener.mockImplementation(
    (type: string, handler: (state: string) => void) => {
      const entry: AppStateListener = {
        handler,
        origin: originOf(new Error().stack),
      };
      if (type === 'change') liveAppStateListeners.add(entry);
      return {
        remove: () => {
          liveAppStateListeners.delete(entry);
        },
      };
    },
  );
  const App = (require('../../App') as { default: React.ComponentType })
    .default;
  return {
    React: ReactModule,
    RN,
    TR,
    App,
    auth: require('../../src/auth/authStore') as AuthStoreModule,
    app: require('../../src/state/appStore') as AppStoreModule,
    access: require('../../src/state/accessStore') as AccessStoreModule,
    consent: require('../../src/state/consentStore') as ConsentStoreModule,
    apiSession: require('../../src/account/apiSession') as ApiSessionModule,
    dataOwner: require('../../src/data/accountScope') as DataOwnerModule,
  };
}

// ─── Schedule model ──────────────────────────────────────────────────────────

type Action =
  | { t: 'launch' }
  | { t: 'signIn'; who: AccountKey }
  | { t: 'tab'; name: 'Settings' | 'Home' | 'Progress' }
  | { t: 'background' }
  | { t: 'foreground' }
  | { t: 'releaseOne'; slot: number }
  | { t: 'releaseAll' }
  | { t: 'failOne'; slot: number }
  | { t: 'expireBearer' }
  | { t: 'revokeServer' }
  | { t: 'signOut' }
  | { t: 'unmount' }
  | { t: 'mount' }
  | { t: 'kill' }
  | { t: 'retry' }
  | { t: 'settle' };

interface SeedParams {
  holdProbability: number;
  bearerLifetimeSec: number;
  length: number;
}

function paramsFor(rng: Rng): SeedParams {
  return {
    holdProbability: rng.pick([0, 0.25, 0.5, 0.75]),
    // 3600: keeper idles; 200: under the 5-minute foreground threshold so
    // every foreground rotates; 45: already inside the 60s pre-expiry window.
    bearerLifetimeSec: rng.pick([3600, 200, 45]),
    length: 10 + rng.int(12),
  };
}

/** Generates a state-aware schedule so most actions are meaningful; the
 * executor tolerates any action in any state regardless. */
function generateSchedule(rng: Rng, params: SeedParams): Action[] {
  const actions: Action[] = [{ t: 'launch' }, { t: 'signIn', who: 'A' }];
  let mounted = true;
  let alive = true;
  let signedIn: AccountKey | null = 'A';
  let backgrounded = false;
  actions.push({ t: 'tab', name: 'Settings' });
  while (actions.length < params.length) {
    const candidates: (readonly [Action, number])[] = [];
    if (!alive) {
      candidates.push([{ t: 'launch' }, 10]);
    } else if (!mounted) {
      candidates.push([{ t: 'mount' }, 6], [{ t: 'kill' }, 2]);
    } else {
      candidates.push(
        [{ t: 'tab', name: 'Settings' }, 4],
        [{ t: 'tab', name: 'Home' }, 2],
        [{ t: 'tab', name: 'Progress' }, 1],
        [{ t: backgrounded ? 'foreground' : 'background' }, 3],
        [{ t: 'unmount' }, 1],
        [{ t: 'kill' }, 2],
        [{ t: 'expireBearer' }, 2],
        [{ t: 'retry' }, 2],
        [{ t: 'settle' }, 2],
      );
      if (signedIn) {
        candidates.push(
          [{ t: 'signOut' }, 2],
          [{ t: 'signIn', who: signedIn === 'A' ? 'B' : 'A' }, 2],
          [{ t: 'revokeServer' }, 1],
        );
      } else {
        candidates.push([{ t: 'signIn', who: rng.pick(['A', 'B']) }, 6]);
      }
    }
    if (params.holdProbability > 0) {
      candidates.push(
        [{ t: 'releaseOne', slot: rng.int(4) }, 4],
        [{ t: 'releaseAll' }, 3],
        [{ t: 'failOne', slot: rng.int(4) }, 2],
      );
    }
    const action = rng.weighted(candidates);
    actions.push(action);
    switch (action.t) {
      case 'launch':
        alive = true;
        mounted = true;
        backgrounded = false;
        break;
      case 'mount':
        mounted = true;
        break;
      case 'unmount':
        mounted = false;
        break;
      case 'kill':
        alive = false;
        mounted = false;
        break;
      case 'background':
        backgrounded = true;
        break;
      case 'foreground':
        backgrounded = false;
        break;
      case 'signOut':
        signedIn = null;
        break;
      case 'revokeServer':
        // The next rotation refuses; the executor decides when that lands.
        break;
      case 'signIn':
        signedIn = action.who;
        break;
      default:
        break;
    }
    if (action.t === 'signIn') actions.push({ t: 'tab', name: 'Settings' });
  }
  return actions;
}

// ─── Executor ────────────────────────────────────────────────────────────────

interface Violation {
  step: number;
  action: string;
  invariant: string;
  detail: string;
}

interface IterationResult {
  seed: number;
  params: SeedParams;
  schedule: string[];
  outcome: 'pass' | 'fail' | 'error';
  violations: Violation[];
  error: string | null;
  requests: number;
  heldRequests: number;
  droppedRequests: number;
  rotations: number;
  /** Steps at which the Gate showed the "profile couldn’t load" retry state
   * (a failed/401'd GET /v1/me) — a legitimate offline state, recorded for
   * evidence rather than treated as a violation. */
  profileErrorSteps: string[];
  /** `#id proc method path cred(kind:owner) as:<signedIn> outcome status` */
  requestLog: string[];
  consoleErrors: string[];
  durationMs: number;
}

function describeAction(action: Action): string {
  switch (action.t) {
    case 'signIn':
      return `signIn:${action.who}`;
    case 'tab':
      return `tab:${action.name}`;
    case 'releaseOne':
    case 'failOne':
      return `${action.t}:${action.slot}`;
    default:
      return action.t;
  }
}

function collectTexts(
  rt: Runtime,
  renderer: TestRenderer.ReactTestRenderer,
): string[] {
  return renderer.root
    .findAllByType(rt.RN.Text)
    .map(t =>
      rt.React.Children.toArray(
        (t.props as { children?: React.ReactNode }).children,
      )
        .filter(c => typeof c === 'string' || typeof c === 'number')
        .join(''),
    )
    .filter(Boolean);
}

interface Pressable {
  onPress: () => void;
}

function findPressables(
  renderer: TestRenderer.ReactTestRenderer,
  predicate: (props: Record<string, unknown>) => boolean,
): Pressable[] {
  const matches = renderer.root.findAll(instance => {
    if (typeof instance.type === 'string') return false;
    const props = instance.props as Record<string, unknown>;
    return typeof props.onPress === 'function' && predicate(props);
  });
  // Nested wrappers (PressableScale → Pressable) both match; keep outermost.
  return matches
    .filter(instance => {
      let parent = instance.parent;
      while (parent) {
        if (matches.includes(parent)) return false;
        parent = parent.parent;
      }
      return true;
    })
    .map(instance => instance.props as unknown as Pressable);
}

interface Snapshot {
  account: AccountKey | null;
  profile: string | null;
  hydrated: boolean;
}

function profileKeyOf(profile: {
  firstName?: string | null;
  skillLevel: string;
}): string {
  return `${profile.firstName ?? ''}/${profile.skillLevel}`;
}

class Session {
  readonly rt: Runtime;
  renderer: TestRenderer.ReactTestRenderer | null = null;
  constructor(rt: Runtime) {
    this.rt = rt;
  }
}

class Iteration {
  readonly seed: number;
  readonly rng: Rng;
  readonly params: SeedParams;
  readonly schedule: Action[];
  readonly violations: Violation[] = [];
  readonly consoleErrors: string[] = [];
  readonly profileErrorSteps: string[] = [];
  session: Session | null = null;
  step = 0;
  currentAction = 'init';
  rotations = 0;
  private appState: 'active' | 'background' = 'active';
  /** Per call-site maximum AppState listener count seen at a steady state. */
  private steadyListenerBaseline = new Map<string, number>();

  constructor(seed: number, schedule?: Action[]) {
    this.seed = seed;
    this.rng = new Rng(seed);
    this.params = paramsFor(this.rng);
    if (schedule) this.params.holdProbability = 0;
    this.schedule =
      schedule ?? generateSchedule(new Rng(seed ^ 0x9e3779b9), this.params);
    backend.rng = new Rng(seed ^ 0x7f4a7c15);
    backend.holdProbability = this.params.holdProbability;
    backend.bearerLifetimeSec = this.params.bearerLifetimeSec;
    backend.currentSignedIn = () => this.signedInAccount();
  }

  private signedInAccount(): AccountKey | null {
    const rt = this.session?.rt;
    if (!rt) return null;
    const session = rt.auth.useAuthStore.getState().session;
    if (!session || session.localOnly) return null;
    return (
      (Object.values(ACCOUNTS).find(a => a.id === session.canonicalAppUserId)
        ?.key as AccountKey | undefined) ?? null
    );
  }

  private violate(invariant: string, detail: string): void {
    this.violations.push({
      step: this.step,
      action: this.currentAction,
      invariant,
      detail,
    });
  }

  private async act(fn: () => void | Promise<void>): Promise<void> {
    const session = this.session;
    if (!session) {
      await fn();
      return;
    }
    await session.rt.TR.act(async () => {
      await fn();
    });
  }

  /** Lets microtasks, immediates and due (0ms) timers drain a few rounds. */
  async settle(rounds = 6): Promise<void> {
    for (let i = 0; i < rounds; i += 1) {
      await this.act(async () => {
        await new Promise<void>(resolve => realSetImmediate(resolve));
        await new Promise<void>(resolve => {
          realSetTimeout(resolve, 0);
        });
      });
    }
  }

  private setNativeAppleIdentity(who: AccountKey): void {
    const account = ACCOUNTS[who];
    const rt = this.session!.rt;
    (rt.RN.NativeModules as Record<string, unknown>).PickleAuth = {
      signInWithApple: async () => ({
        user: `apple-${who}`,
        identityToken: account.identityToken,
        email: account.email,
        givenName: account.givenName,
        familyName: account.familyName,
      }),
    };
  }

  private async mount(): Promise<void> {
    const session = this.session!;
    if (session.renderer) return;
    await session.rt.TR.act(async () => {
      session.renderer = session.rt.TR.create(
        session.rt.React.createElement(session.rt.App),
      );
    });
    await this.settle();
  }

  private async unmount(): Promise<void> {
    const session = this.session;
    if (!session?.renderer) return;
    const renderer = session.renderer;
    session.renderer = null;
    await session.rt.TR.act(async () => {
      renderer.unmount();
    });
    await this.settle();
    // Let short one-shot timers scheduled by the teardown itself (navigator
    // transition-end delays and the like) fire before judging leaks.
    await this.act(
      () =>
        new Promise<void>(resolve => {
          realSetTimeout(resolve, 100);
        }),
    );
    await this.settle(2);
  }

  private async launch(): Promise<void> {
    if (this.session) return;
    this.session = new Session(bootProcess());
    this.appState = 'active';
    await this.mount();
  }

  private async kill(): Promise<void> {
    if (!this.session) return;
    // Process death: the tree is gone, timers stop, listeners vanish,
    // in-flight requests never come back. Keychain and SQLite survive.
    await this.unmount();
    backend.dropAll();
    killProcessTimers();
    liveAppStateListeners.clear();
    processGeneration += 1;
    this.session = null;
  }

  private async press(
    predicate: (props: Record<string, unknown>) => boolean,
    pick: 'first' | 'last',
  ): Promise<boolean> {
    const renderer = this.session?.renderer;
    if (!renderer) return false;
    const matches = findPressables(renderer, predicate);
    const target = pick === 'first' ? matches[0] : matches[matches.length - 1];
    if (!target) return false;
    await this.act(() => target.onPress());
    await this.settle();
    return true;
  }

  private pressLabel(label: string, pick: 'first' | 'last' = 'first') {
    return this.press(props => props.accessibilityLabel === label, pick);
  }

  private async signIn(who: AccountKey): Promise<void> {
    if (!this.session?.renderer) return;
    this.setNativeAppleIdentity(who);
    // Real UI path: Welcome → "I already have an account" → SignIn →
    // "Continue with Apple". Each step is a no-op when that screen is absent.
    await this.pressLabel('I already have an account');
    await this.pressLabel('Continue with Apple');
  }

  private async signOut(): Promise<void> {
    if (!this.session?.renderer) return;
    await this.pressLabel('Settings');
    const opened = await this.pressLabel('Sign out', 'first');
    if (!opened) return;
    await this.pressLabel('Sign out', 'last');
  }

  private async emitAppState(state: 'active' | 'background'): Promise<void> {
    this.appState = state;
    await this.act(() => {
      for (const listener of [...liveAppStateListeners])
        listener.handler(state);
    });
    await this.settle();
  }

  private async run(action: Action): Promise<void> {
    switch (action.t) {
      case 'launch':
        await this.launch();
        return;
      case 'signIn':
        await this.signIn(action.who);
        return;
      case 'tab':
        await this.pressLabel(action.name);
        return;
      case 'background':
        if (this.appState === 'active') await this.emitAppState('background');
        return;
      case 'foreground':
        if (this.appState === 'background') await this.emitAppState('active');
        return;
      case 'releaseOne': {
        const index = backend.pending.length
          ? action.slot % backend.pending.length
          : 0;
        await this.act(() => {
          backend.releaseOne(index);
        });
        await this.settle();
        return;
      }
      case 'failOne': {
        const index = backend.pending.length
          ? action.slot % backend.pending.length
          : 0;
        await this.act(() => {
          backend.failOne(index);
        });
        await this.settle();
        return;
      }
      case 'releaseAll':
        await this.act(() => {
          backend.releaseAll();
        });
        await this.settle();
        return;
      case 'expireBearer':
        backend.expireBearerOnNextRequest = true;
        return;
      case 'retry':
        await this.pressLabel('Try again');
        return;
      case 'revokeServer': {
        const who = this.signedInAccount();
        if (who) {
          backend.revoke(who);
          backend.expireBearerOnNextRequest = true;
        }
        return;
      }
      case 'signOut':
        await this.signOut();
        return;
      case 'unmount':
        await this.unmount();
        return;
      case 'mount':
        if (this.session) await this.mount();
        return;
      case 'kill':
        await this.kill();
        return;
      case 'settle':
        await this.settle(10);
        return;
      default:
        return;
    }
  }

  // ── Invariants ────────────────────────────────────────────────────────────

  private checkInvariants(): void {
    const session = this.session;
    if (!session) {
      this.checkDeviceStorage(null, false);
      return;
    }
    const rt = session.rt;
    const auth = rt.auth.useAuthStore.getState();
    const who = this.signedInAccount();
    const current = who ? ACCOUNTS[who] : null;
    const others = Object.values(ACCOUNTS).filter(a => a.key !== who);

    // Rendered text never contains another account's identity/profile/access.
    if (session.renderer) {
      const texts = collectTexts(rt, session.renderer);
      const joined = texts.join('\n');
      for (const other of others) {
        for (const marker of other.markers) {
          if (joined.includes(marker)) {
            this.violate(
              'render.no-previous-user-state',
              `signed in as ${who ?? 'nobody'} but rendered "${marker}" (account ${other.key})`,
            );
          }
        }
      }
      if (joined.includes('Something went wrong')) {
        this.violate(
          'render.no-crash',
          `RootErrorBoundary rendered: ${texts.filter(t => /wrong/.test(t)).join(' | ')}`,
        );
      }
      if (joined.includes('Your coaching profile couldn’t load')) {
        this.profileErrorSteps.push(`${this.step}:${this.currentAction}`);
      }
    }

    // API session belongs to the signed-in account (or is absent).
    const api = rt.apiSession.getApiSession();
    if (api && (!current || api.canonicalAppUserId !== current.id)) {
      this.violate(
        'apiSession.matches-auth-session',
        `api session for ${api.canonicalAppUserId} while auth session is ${auth.session?.canonicalAppUserId ?? 'null'}`,
      );
    }
    if (api && !api.bearerToken.startsWith(`acc-${who}-`)) {
      this.violate(
        'apiSession.bearer-owner',
        `bearer ${api.bearerToken} installed for account ${who}`,
      );
    }

    // Access snapshot is either absent or the current account's server truth.
    const access = rt.access.useAccessStore.getState();
    if (access.canonicalAccess) {
      if (!current) {
        this.violate(
          'access.cleared-when-signed-out',
          `canonicalAccess present (premium=${access.canonicalAccess.premium}) with no synced session`,
        );
      } else if (access.canonicalAccess.premium !== current.premium) {
        this.violate(
          'access.no-stale-response',
          `account ${who} shows premium=${access.canonicalAccess.premium}`,
        );
      }
    }

    // Consent reflects the current account when it claims to be ready.
    const consent = rt.consent.useConsentStore.getState();
    if (consent.availability === 'ready') {
      if (!current) {
        this.violate(
          'consent.cleared-when-signed-out',
          `consent availability=ready modelTrainingActive=${consent.modelTrainingActive} with no synced session`,
        );
      } else if (consent.modelTrainingActive !== current.modelTrainingActive) {
        this.violate(
          'consent.no-stale-response',
          `account ${who} shows modelTrainingActive=${consent.modelTrainingActive}`,
        );
      }
    }

    // Profile store: once hydrated for an owner, the profile is that owner's.
    const app = rt.app.useAppStore.getState();
    if (
      app.hydrated &&
      app.profile &&
      auth.session?.canonicalAppUserId &&
      !auth.session.localOnly
    ) {
      const expectedOwner = rt.dataOwner.canonicalDataOwner(
        auth.session.canonicalAppUserId,
      );
      if (app.ownerKey === expectedOwner && current) {
        if (
          app.profile.firstName !== current.firstName ||
          app.profile.skillLevel !== current.skillLevel
        ) {
          this.violate(
            'profile.no-previous-user-state',
            `owner ${app.ownerKey} has profile ${app.profile.firstName}/${app.profile.skillLevel}, expected ${current.firstName}/${current.skillLevel}`,
          );
        }
      }
    }

    // Every request carried the credential of the account signed in when it
    // was sent (bootstrap carries an identity token, exempt by construction).
    for (const record of backend.log) {
      if (
        record.credentialKind === 'access' ||
        record.credentialKind === 'refresh'
      ) {
        if (
          record.credentialOwner &&
          record.signedInAtSend !== record.credentialOwner
        ) {
          this.violate(
            'request.credential-is-current-account',
            `#${record.id} ${record.method} ${record.path} sent ${record.credentialKind} of ${record.credentialOwner} while signed in as ${record.signedInAtSend ?? 'nobody'}`,
          );
          record.credentialOwner = null; // report once
        }
      }
    }

    this.checkDeviceStorage(who, true);

    // AppState listeners: at a steady signed-in state no call site may hold
    // more listeners than it did at an earlier steady state (a duplicate from
    // the same call site = a subscription that survived a cycle/remount).
    if (session.renderer && current && backend.pending.length === 0) {
      const perSite = new Map<string, number>();
      for (const l of liveAppStateListeners) {
        const site = l.origin.split(' <- ')[0] ?? l.origin;
        perSite.set(site, (perSite.get(site) ?? 0) + 1);
      }
      for (const [site, count] of perSite) {
        const seen = this.steadyListenerBaseline.get(site);
        if (seen === undefined) {
          this.steadyListenerBaseline.set(site, count);
        } else if (count > seen) {
          this.violate(
            'listeners.no-accumulation',
            `${count} AppState listeners from ${site} (was ${seen}); all: ${[...liveAppStateListeners].map(l => l.origin).join(' || ')}`,
          );
        }
      }
    }
    if (!session.renderer) {
      // Unmounted (warm): only non-UI code (session keeper, sync runtime —
      // both owned by the signed-in session, not the tree) may still hold an
      // AppState listener, and no UI-originated timer may survive.
      const uiListeners = [...liveAppStateListeners].filter(l =>
        /src\/(screens|components|hooks|navigation|design)|App\.tsx|@react-navigation/.test(
          l.origin,
        ),
      );
      if (
        uiListeners.length > 0 ||
        (!current && liveAppStateListeners.size > 0)
      ) {
        this.violate(
          'listeners.released-on-unmount',
          `${liveAppStateListeners.size} AppState listeners after unmount (signed in: ${who ?? 'nobody'}): ${[...liveAppStateListeners].map(l => l.origin).join(' || ')}`,
        );
      }
      const uiTimers = liveTimersOfCurrentProcess().filter(t =>
        /src\/(screens|components|hooks|navigation|design)|App\.tsx|@react-navigation|Animated/.test(
          t.origin,
        ),
      );
      if (uiTimers.length > 0) {
        this.violate(
          'timers.released-on-unmount',
          uiTimers
            .map(t => `${t.kind}(${t.delayMs}ms) ${t.origin}`)
            .join(' || '),
        );
      }
    }
  }

  /** `processAlive` false = the app was killed: the vault may legitimately
   * still hold the last signed-in account until the next launch restores it. */
  private checkDeviceStorage(
    who: AccountKey | null,
    processAlive: boolean,
  ): void {
    const vault = mockKeychain.get('com.picklesensei.auth.session');
    if (mockKeychain.size > 1) {
      this.violate(
        'keychain.single-item',
        `${mockKeychain.size} keychain services`,
      );
    }
    if (vault) {
      if (/acc-|idtok-/.test(vault.password)) {
        this.violate('keychain.no-access-or-identity-token', vault.password);
      }
      const parsed = JSON.parse(vault.password) as {
        canonicalAppUserId?: string;
        refreshToken?: string;
      };
      const owner = Object.values(ACCOUNTS).find(
        a => a.id === parsed.canonicalAppUserId,
      );
      if (processAlive && backend.pending.length === 0) {
        if (!who) {
          this.violate(
            'keychain.cleared-on-sign-out',
            `vault still holds ${owner?.key ?? parsed.canonicalAppUserId} after sign-out`,
          );
        } else if (owner?.key !== who) {
          this.violate(
            'keychain.current-account',
            `vault holds ${owner?.key ?? 'unknown'} while signed in as ${who}`,
          );
        } else {
          const serverCurrent = backend.currentRefreshToken.get(who);
          if (serverCurrent && parsed.refreshToken !== serverCurrent) {
            this.violate(
              'keychain.refresh-token-is-current',
              `vault has ${parsed.refreshToken}, server's current is ${serverCurrent}`,
            );
          }
        }
      }
    }
    const rows = mockSqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    for (const { name } of rows) {
      const cells = mockSqlite.prepare(`SELECT * FROM "${name}"`).all();
      for (const row of cells) {
        const serialized = JSON.stringify(row);
        if (/acc-[AB]-|ref-[AB]-|idtok-/.test(serialized)) {
          this.violate('sqlite.no-session-material', `${name}: ${serialized}`);
        }
      }
    }
  }

  private checkTeardownLeaks(): void {
    const timers = liveTimersOfCurrentProcess();
    if (timers.length > 0) {
      this.violate(
        'teardown.no-leaked-timers',
        timers.map(t => `${t.kind}(${t.delayMs}ms) ${t.origin}`).join(' || '),
      );
    }
    if (liveAppStateListeners.size > 0) {
      this.violate(
        'teardown.no-leaked-listeners',
        [...liveAppStateListeners].map(l => l.origin).join(' || '),
      );
    }
    const rt = this.session?.rt;
    if (rt) {
      if (rt.apiSession.getApiSession()) {
        this.violate(
          'teardown.api-session-cleared',
          'api session survives sign-out',
        );
      }
      if (rt.access.useAccessStore.getState().canonicalAccess) {
        this.violate(
          'teardown.access-cleared',
          'canonicalAccess survives sign-out',
        );
      }
      if (rt.auth.useAuthStore.getState().session) {
        this.violate(
          'teardown.signed-out',
          `session ${rt.auth.useAuthStore.getState().session?.canonicalAppUserId} survives sign-out`,
        );
      }
    }
    if (mockKeychain.size > 0) {
      this.violate(
        'teardown.keychain-cleared',
        [...mockKeychain.keys()].join(','),
      );
    }
  }

  /** Two consecutive cold launches from the same persisted device state
   * (network fully available, nothing held) must land on the same account
   * with the same profile — and that account must be the vault's owner,
   * unless the server revoked it, in which case both launches sign out. */
  private async checkRehydrateIdempotent(): Promise<void> {
    const vaultOwner = this.persistedAccount();
    const savedHold = backend.holdProbability;
    backend.holdProbability = 0;
    backend.expireBearerOnNextRequest = false;
    try {
      const snapshots: Snapshot[] = [];
      for (const round of [1, 2]) {
        await this.kill();
        this.currentAction = `relaunch-check-${round}`;
        await this.launch();
        await this.settle(10);
        await this.recoverProfileError();
        snapshots.push(this.snapshot());
        this.checkInvariants();
      }
      const [first, second] = snapshots as [Snapshot, Snapshot];
      const expectedAccount =
        vaultOwner && !backend.revoked.has(vaultOwner) ? vaultOwner : null;
      if (
        first.account !== expectedAccount ||
        !first.hydrated ||
        (expectedAccount &&
          first.profile !== profileKeyOf(ACCOUNTS[expectedAccount]))
      ) {
        this.violate(
          'rehydrate.restores-persisted-account',
          `vault=${vaultOwner ?? 'empty'} revoked=${vaultOwner ? backend.revoked.has(vaultOwner) : false} relaunch=${JSON.stringify(first)}`,
        );
      }
      if (JSON.stringify(first) !== JSON.stringify(second)) {
        this.violate(
          'rehydrate.idempotent',
          `launch1=${JSON.stringify(first)} launch2=${JSON.stringify(second)}`,
        );
      }
    } finally {
      backend.holdProbability = savedHold;
    }
  }

  /** Which account the device Keychain would restore on the next launch. */
  private persistedAccount(): AccountKey | null {
    const entry = mockKeychain.get('com.picklesensei.auth.session');
    if (!entry) return null;
    return (
      (Object.values(ACCOUNTS).find(a => entry.password.includes(a.id))?.key as
        AccountKey | undefined) ?? null
    );
  }

  /** The Gate's "profile couldn’t load" state only offers "Try again"; a
   * user taps it. Bounded so a broken backend cannot loop forever. */
  private async recoverProfileError(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!(await this.pressLabel('Try again'))) return;
      await this.settle(6);
    }
  }

  private snapshot(): Snapshot {
    const rt = this.session?.rt;
    if (!rt) return { account: null, profile: null, hydrated: false };
    const app = rt.app.useAppStore.getState();
    return {
      account: this.signedInAccount(),
      profile: app.profile ? profileKeyOf(app.profile) : null,
      hydrated: app.hydrated && rt.auth.useAuthStore.getState().hydrated,
    };
  }

  async execute(): Promise<IterationResult> {
    const started = Date.now();
    let error: string | null = null;
    const consoleError = console.error;
    console.error = (...args: unknown[]) => {
      this.consoleErrors.push(
        `[step ${this.step} ${this.currentAction}] ${args
          .map(a => (a instanceof Error ? (a.stack ?? a.message) : String(a)))
          .join(' ')
          .slice(0, 600)}`,
      );
    };
    try {
      for (const [index, action] of this.schedule.entries()) {
        this.step = index;
        this.currentAction = describeAction(action);
        await this.run(action);
        this.checkInvariants();
      }
      // Quiesce: let every held response land, then verify once more.
      this.currentAction = 'quiesce';
      if (!this.session) await this.launch();
      await this.act(() => {
        backend.releaseAll();
      });
      await this.settle(10);
      this.checkInvariants();
      await this.checkRehydrateIdempotent();
      // Teardown: explicit sign-out through the real UI, then unmount, then
      // nothing may be left running.
      this.currentAction = 'teardown';
      if (this.signedInAccount()) {
        if (!this.session?.renderer) await this.mount();
        await this.recoverProfileError();
        await this.signOut();
      }
      await this.act(() => {
        backend.releaseAll();
      });
      await this.settle(10);
      await this.unmount();
      await this.settle(10);
      this.checkInvariants();
      this.checkTeardownLeaks();
    } catch (caught) {
      error =
        caught instanceof Error
          ? (caught.stack ?? caught.message)
          : String(caught);
    } finally {
      console.error = consoleError;
      // Reset the "device" for the next iteration.
      await this.kill();
      backend.releaseAll();
      mockKeychain.clear();
      mockSqlite.close();
      mockSqlite = new DatabaseSync(':memory:');
    }
    this.rotations = backend.log.filter(
      r => r.path === '/v1/auth/refresh' && r.status === 200,
    ).length;
    const renderErrors = this.consoleErrors.filter(
      m =>
        /The above error occurred|Uncaught|Error:/.test(m) && !/act\(/.test(m),
    );
    for (const message of renderErrors) {
      this.violations.push({
        step: -1,
        action: 'console',
        invariant: 'console.no-render-errors',
        detail: message,
      });
    }
    const result: IterationResult = {
      seed: this.seed,
      params: this.params,
      schedule: this.schedule.map(describeAction),
      outcome: error ? 'error' : this.violations.length ? 'fail' : 'pass',
      violations: this.violations,
      error,
      requests: backend.log.length,
      heldRequests: backend.log.filter(r => r.outcome !== 'immediate').length,
      droppedRequests: backend.log.filter(r => r.outcome === 'dropped').length,
      rotations: this.rotations,
      profileErrorSteps: this.profileErrorSteps,
      requestLog: backend.log.map(
        r =>
          `#${r.id} p${r.process} ${r.method} ${r.path} ${r.credentialKind}:${r.credentialOwner ?? '-'} as:${r.signedInAtSend ?? '-'} ${r.outcome} ${r.status ?? '-'}`,
      ),
      consoleErrors: this.consoleErrors,
      durationMs: Date.now() - started,
    };
    backend.log.length = 0;
    backend.revoked.clear();
    backend.currentRefreshToken.clear();
    backend.expireBearerOnNextRequest = false;
    return result;
  }
}

// ─── Campaign ────────────────────────────────────────────────────────────────

const ITERATIONS = Number(process.env.STRESS_ITER ?? 12);
const BASE_SEED = Number(process.env.STRESS_SEED ?? 20260904);
const EXPLICIT_SEEDS = (process.env.STRESS_SEEDS ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(Number);
const OUT_FILE =
  process.env.STRESS_OUT ??
  path.join(os.tmpdir(), 'stress-scr-settingsscreen-lifecycle.json');

const seeds =
  EXPLICIT_SEEDS.length > 0
    ? EXPLICIT_SEEDS
    : Array.from({ length: ITERATIONS }, (_, i) => BASE_SEED + i);

jest.setTimeout(Math.max(120_000, seeds.length * 6_000));

describe('SettingsScreen lifecycle interruption stress (real App tree)', () => {
  test(`${seeds.length} seeded interleavings hold every lifecycle invariant`, async () => {
    const results: IterationResult[] = [];
    for (const seed of seeds) {
      results.push(await new Iteration(seed).execute());
    }
    const summary = {
      unit: 'scr-settingsscreen',
      lens: 'lifecycle',
      executed: results.length,
      passed: results.filter(r => r.outcome === 'pass').length,
      failed: results.filter(r => r.outcome === 'fail').length,
      errored: results.filter(r => r.outcome === 'error').length,
      totalRequests: results.reduce((n, r) => n + r.requests, 0),
      totalHeldRequests: results.reduce((n, r) => n + r.heldRequests, 0),
      totalRotations: results.reduce((n, r) => n + r.rotations, 0),
      actionsExecuted: results.reduce((n, r) => n + r.schedule.length, 0),
      baseSeed: BASE_SEED,
      seeds,
      results,
    };
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify(summary, null, 2));
    const failures = results.filter(r => r.outcome !== 'pass');
    expect(
      failures.map(r => ({
        seed: r.seed,
        outcome: r.outcome,
        error: r.error?.split('\n')[0] ?? null,
        violations: r.violations.map(
          v =>
            `${v.invariant} @${v.step}:${v.action} — ${v.detail.slice(0, 300)}`,
        ),
      })),
    ).toEqual([]);
    expect(summary.executed).toBe(seeds.length);
  });

  // Minimized deterministic interleaving (no RNG): the shortest schedule
  // that still exposes a signed-out process holding the previous account's
  // consent state. Kept as a regression pin next to the campaign.
  test('minimized: sign-out leaves no consent state of the previous account', async () => {
    const result = await new Iteration(0, [
      { t: 'launch' },
      { t: 'signIn', who: 'A' },
      { t: 'tab', name: 'Settings' },
      { t: 'signOut' },
    ]).execute();
    expect(result.error).toBeNull();
    expect(
      result.violations.map(
        v =>
          `${v.invariant} @${v.step}:${v.action} — ${v.detail.slice(0, 300)}`,
      ),
    ).toEqual([]);
  });
});
