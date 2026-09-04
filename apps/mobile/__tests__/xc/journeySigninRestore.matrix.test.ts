/**
 * xc `journey-signin-restore` — SEEDED ADVERSARIAL MATRIX.
 *
 * Each scenario is generated from a seed: a provider, a bearer lifetime and a
 * random program of 3–9 steps drawn from {sign-in (with bootstrap faults or
 * a Keychain write failure), kill+relaunch (with launch-refresh faults),
 * in-app rotation (with faults), foreground, sign-out (with faults),
 * server-side revocation, another device signing in / out, vault
 * corruption}. The program runs against the stateful fake session server
 * through the REAL authStore / sessionVault / sessionKeeper / apiSession
 * modules (kill = jest.resetModules, so only the Keychain + SQLite kv
 * survive), and after EVERY step an independent oracle checks:
 *
 *   I1 signed-in UI state ⇔ model says signed in
 *   I2 signed in ⇒ vault == {version 1, provider, id, CURRENT server refresh
 *      token, email, displayName} exactly (or absent when the Keychain write
 *      failed — that scenario is also asserted to sign out at next launch)
 *   I3 bearer in memory == server's current access token when the model has
 *      one; absent otherwise
 *   I4 signed out ⇒ Keychain empty, apiSession null, data owner SIGNED_OUT,
 *      kv holds no token, no live keeper timer
 *   I5 no access / provider ID token / Apple code in Keychain, kv, console
 *      or UI state, ever; Keychain holds ≤ 1 refresh token and it is the
 *      current one
 *   I6 the client never replays a spent refresh token
 *   I7 other devices' server sessions are never touched by this device
 *   I8 a sign-out with a bearer in memory and a reachable server revokes
 *      exactly this device's session
 *
 * Every failure is recorded with its seed + full program (replay with
 * `XC_MATRIX_ONLY_SEED=<seed>`). Scale: XC_MATRIX_SCENARIOS (default 400)
 * seeds from XC_MATRIX_SEED_BASE (default 1_000_000). Raw table →
 * artifacts/xc-journey-signin-restore/matrix.json (+ matrix-failures.json).
 */
// Node globals, typed the way the other __tests__ do (RN tsconfig ships no
// node types). `require` loads a FRESH app process after jest.resetModules().
declare const require: (id: string) => unknown;
declare const process: { env: Record<string, string | undefined> };
import type { LocalDb } from '../../src/data/db';
import {
  ACCESS_PREFIX,
  APPLE_CODE_PREFIX,
  FakeAuthServer,
  ID_TOKEN_PREFIX,
  Prng,
  REFRESH_PREFIX,
  captureConsole,
  findSecrets,
  heapNumbers,
  redactCall,
  safeStringify,
  secretsOfKind,
  writeArtifact,
  type Fault,
  type ServerSession,
} from '../../test-support/xc/journeySigninRestore.support';

// ─── Module seams ────────────────────────────────────────────────────────────

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
const API_BASE_URL = 'https://api.example.test';
jest.mock('../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.example.test',
    revenueCatPublicSdkKey: null,
    googleIosClientId: 'test-ios-client.apps.googleusercontent.com',
    googleWebClientId: 'test-web-client.apps.googleusercontent.com',
    appVersion: '1.0',
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

// ─── App process ─────────────────────────────────────────────────────────────

type KeychainItem = { username: string; password: string; accessible?: string };
interface KeychainModule {
  __keychainStore: Map<string, KeychainItem>;
  setGenericPassword: (...args: unknown[]) => Promise<unknown>;
}

interface AppProcess {
  auth: typeof import('../../src/auth/authStore');
  api: typeof import('../../src/account/apiSession');
  keeper: typeof import('../../src/account/sessionKeeper');
  scope: typeof import('../../src/data/accountScope');
  sync: typeof import('../../src/data/syncRuntime');
  rn: typeof import('react-native');
  keychainModule: KeychainModule;
  keychain: Map<string, KeychainItem>;
  appleSignIn: jest.Mock;
}

function loadApp(): AppProcess {
  const rn = require('react-native') as typeof import('react-native');
  const keychainModule = require('react-native-keychain') as KeychainModule;
  const appleSignIn = jest.fn();
  (rn.NativeModules as { PickleAuth?: unknown }).PickleAuth = {
    signInWithApple: appleSignIn,
  };
  return {
    auth: require('../../src/auth/authStore') as AppProcess['auth'],
    api: require('../../src/account/apiSession') as AppProcess['api'],
    keeper: require('../../src/account/sessionKeeper') as AppProcess['keeper'],
    scope: require('../../src/data/accountScope') as AppProcess['scope'],
    sync: require('../../src/data/syncRuntime') as AppProcess['sync'],
    rn,
    keychainModule,
    keychain: keychainModule.__keychainStore,
    appleSignIn,
  };
}

function kill(app: AppProcess): Array<readonly [string, KeychainItem]> {
  const snapshot = [...app.keychain.entries()].map(
    ([service, item]) => [service, { ...item }] as const,
  );
  app.keeper.stopSessionKeeper();
  app.sync.clearSyncRuntime();
  app.api.clearApiSession();
  delete (app.rn.NativeModules as { PickleAuth?: unknown }).PickleAuth;
  jest.resetModules();
  return snapshot;
}

function launch(keychain: Array<readonly [string, KeychainItem]>): AppProcess {
  const app = loadApp();
  app.keychain.clear();
  for (const [service, item] of keychain) app.keychain.set(service, item);
  return app;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
}

// ─── Scenario program ────────────────────────────────────────────────────────

const SESSION_VAULT_SERVICE = 'com.picklesensei.auth.session';
const ACCOUNTS = [
  {
    subject: 'subA',
    userId: '7fc2c743-028f-4ec6-942c-a84508f3be38',
    email: 'pat@example.com',
  },
  {
    subject: 'subB',
    userId: '2b1f6d0e-5c3a-4f7b-9e8d-1a2b3c4d5e6f',
    email: 'sam@example.com',
  },
] as const;

type FaultName =
  | 'none'
  | 'network'
  | 'status400'
  | 'status401'
  | 'status403'
  | 'status429'
  | 'status500'
  | 'status502'
  | 'status503'
  | 'malformed'
  | 'delay';

const TRANSIENT: FaultName[] = [
  'network',
  'status400',
  'status429',
  'status500',
  'status502',
  'status503',
  'malformed',
];
const REFUSALS: FaultName[] = ['status401', 'status403'];

function faultOf(name: FaultName, prng: Prng): Fault | null {
  switch (name) {
    case 'none':
      return null;
    case 'network':
      return { kind: 'network' };
    case 'malformed':
      return { kind: 'malformed' };
    case 'delay':
      return { kind: 'delay', ms: 1 + prng.int(8) };
    default:
      return { kind: 'status', status: Number(name.slice('status'.length)) };
  }
}

type Step =
  | {
      op: 'signin';
      provider: 'apple' | 'google';
      account: 0 | 1;
      fault: FaultName;
      keychainFails: boolean;
    }
  | { op: 'relaunch'; fault: FaultName }
  | { op: 'rotate'; fault: FaultName }
  | { op: 'foreground'; fault: FaultName }
  | { op: 'signout'; fault: FaultName }
  | { op: 'revoke-server' }
  | { op: 'other-device'; provider: 'apple' | 'google'; signsOut: boolean }
  | { op: 'corrupt-vault'; mutation: string };

interface Scenario {
  seed: number;
  provider: 'apple' | 'google';
  accessLifetimeSeconds: number;
  steps: Step[];
}

const CORRUPTIONS = [
  'not-json',
  'array',
  'version-2',
  'provider-facebook',
  'missing-refresh',
  'empty-refresh',
  'numeric-id',
  'empty-id',
  'truncated',
] as const;

function generate(seed: number): Scenario {
  const prng = new Prng(seed);
  const provider = prng.pick(['apple', 'google'] as const);
  const accessLifetimeSeconds = prng.pick([3600, 3600, 3600, 240, 20]);
  const stepCount = 3 + prng.int(7);
  const steps: Step[] = [];
  const pickFault = (weights: Array<[FaultName, number]>): FaultName => {
    const total = weights.reduce((s, [, w]) => s + w, 0);
    let r = prng.next() * total;
    for (const [name, w] of weights) {
      r -= w;
      if (r < 0) return name;
    }
    const last = weights[weights.length - 1];
    if (!last) throw new Error('pickFault needs at least one weight');
    return last[0];
  };
  const launchFault = () =>
    pickFault([
      ['none', 8],
      ['delay', 2],
      ['network', 2],
      ['status500', 1],
      ['status502', 1],
      ['status503', 1],
      ['status429', 1],
      ['status400', 1],
      ['malformed', 1],
      ['status401', 1],
      ['status403', 1],
    ]);
  // Every program starts with a sign-in attempt.
  steps.push({
    op: 'signin',
    provider,
    account: 0,
    fault: pickFault([
      ['none', 10],
      ['network', 1],
      ['status401', 1],
      ['status500', 1],
      ['malformed', 1],
    ]),
    keychainFails: prng.chance(0.08),
  });
  for (let i = 1; i < stepCount; i += 1) {
    const roll = prng.next();
    if (roll < 0.34) steps.push({ op: 'relaunch', fault: launchFault() });
    else if (roll < 0.48) steps.push({ op: 'rotate', fault: launchFault() });
    else if (roll < 0.56)
      steps.push({ op: 'foreground', fault: launchFault() });
    else if (roll < 0.7)
      steps.push({
        op: 'signout',
        fault: pickFault([
          ['none', 6],
          ['network', 1],
          ['status500', 1],
        ]),
      });
    else if (roll < 0.78) steps.push({ op: 'revoke-server' });
    else if (roll < 0.86)
      steps.push({
        op: 'other-device',
        provider: prng.pick(['apple', 'google'] as const),
        signsOut: prng.chance(0.5),
      });
    else if (roll < 0.92)
      steps.push({ op: 'corrupt-vault', mutation: prng.pick(CORRUPTIONS) });
    else
      steps.push({
        op: 'signin',
        provider: prng.pick(['apple', 'google'] as const),
        account: prng.pick([0, 1] as const),
        fault: pickFault([
          ['none', 8],
          ['network', 1],
          ['status500', 1],
        ]),
        keychainFails: prng.chance(0.08),
      });
  }
  return { seed, provider, accessLifetimeSeconds, steps };
}

function corrupt(raw: string, mutation: string): string {
  // A vault that was already corrupted by an earlier step may not parse; a
  // second mutation still yields a malformed record (which is the point).
  let record: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      record = parsed as Record<string, unknown>;
    }
  } catch {
    record = {};
  }
  switch (mutation) {
    case 'not-json':
      return '{not json';
    case 'array':
      return JSON.stringify([record]);
    case 'version-2':
      return JSON.stringify({ ...record, version: 2 });
    case 'provider-facebook':
      return JSON.stringify({ ...record, provider: 'facebook' });
    case 'missing-refresh': {
      const { refreshToken: _dropped, ...rest } = record;
      void _dropped;
      return JSON.stringify(rest);
    }
    case 'empty-refresh':
      return JSON.stringify({ ...record, refreshToken: '' });
    case 'numeric-id':
      return JSON.stringify({ ...record, canonicalAppUserId: 42 });
    case 'empty-id':
      return JSON.stringify({ ...record, canonicalAppUserId: '' });
    case 'truncated':
      return raw.slice(0, Math.max(1, raw.length - 7));
    default:
      throw new Error(`unknown mutation ${mutation}`);
  }
}

// ─── Oracle model ────────────────────────────────────────────────────────────

interface Model {
  signedIn: boolean;
  account: (typeof ACCOUNTS)[number] | null;
  provider: 'apple' | 'google' | null;
  /** This device's session on the server (may be revoked). */
  session: ServerSession | null;
  hasBearer: boolean;
  /** A session keeper is running (rotation timers + foreground listener). */
  keeperAlive: boolean;
  /** The Keychain write failed for the CURRENT run: the vault still holds
   * whatever it held before (a previous record, or nothing). */
  vaultLost: boolean;
  /** What the Keychain holds when `vaultLost`: the previous record (exact
   * bytes + the server session it names) or null. */
  staleVault: {
    raw: string;
    session: ServerSession | null;
    account: (typeof ACCOUNTS)[number];
    provider: 'apple' | 'google';
  } | null;
  /** Vault bytes were corrupted: next launch must sign out without network. */
  vaultCorrupt: boolean;
  /** The last transition to signed-out was the user's explicit sign-out. */
  explicitSignOut: boolean;
  /** Sessions that belong to other devices and must never be touched. */
  otherDevices: Array<{ session: ServerSession; revokedByItself: boolean }>;
  /** Server sessions this device forgot without being able to revoke them. */
  orphaned: string[];
  /** Failed sign-in attempts made while already signed in (characterized:
   * the run keeps its UI session but loses bearer + keeper until relaunch). */
  degradedBySigninFailure: number;
}

interface Violation {
  invariant: string;
  detail: string;
}

interface StepResult {
  step: Step;
  violations: Violation[];
  callsDelta: number;
  model: Record<string, unknown>;
}

function vaultRecord(app: AppProcess): Record<string, unknown> | null {
  const item = app.keychain.get(SESSION_VAULT_SERVICE);
  if (!item) return null;
  try {
    return JSON.parse(item.password) as Record<string, unknown>;
  } catch {
    return { unparseable: item.password.length };
  }
}

function checkInvariants(
  app: AppProcess,
  model: Model,
  server: FakeAuthServer,
  consoleLines: string[],
): Violation[] {
  const v: Violation[] = [];
  const state = app.auth.useAuthStore.getState();
  const uiSignedIn = state.session !== null;
  if (uiSignedIn !== model.signedIn) {
    v.push({
      invariant: 'I1',
      detail: `ui signedIn=${uiSignedIn} model=${model.signedIn}`,
    });
  }
  const vault = vaultRecord(app);
  const vaultRaw = app.keychain.get(SESSION_VAULT_SERVICE)?.password ?? null;
  const api = app.api.getApiSession();
  const expectedVaultRaw = expectedVault(model);
  if (model.signedIn && model.session && model.account) {
    if (model.vaultCorrupt) {
      // Bytes are garbage by construction; checked at the next launch.
    } else if (vaultRaw !== expectedVaultRaw) {
      v.push({
        invariant: 'I2',
        detail: `vault mismatch: keys=${JSON.stringify(vault ? Object.keys(vault) : null)} lost=${model.vaultLost} refresh ${vault?.['refreshToken'] === model.session.refreshToken ? 'current' : 'NOT current'}`,
      });
    }
    if (state.session?.canonicalAppUserId !== model.account.userId) {
      v.push({
        invariant: 'I1',
        detail: 'ui session names a different account',
      });
    }
    if (app.scope.getActiveDataOwner() !== model.account.userId) {
      v.push({
        invariant: 'I1',
        detail: 'data owner is not the signed-in account',
      });
    }
    if (model.hasBearer) {
      if (api?.bearerToken !== model.session.accessToken) {
        v.push({
          invariant: 'I3',
          detail: `bearer ${api ? 'stale' : 'missing'} vs server current`,
        });
      }
      if (
        app.api.bearerTokenFor(model.account.userId) !==
        model.session.accessToken
      ) {
        v.push({
          invariant: 'I3',
          detail: 'bearerTokenFor() != server current access',
        });
      }
    } else if (api !== null) {
      v.push({
        invariant: 'I3',
        detail: 'bearer present although the refresh never succeeded',
      });
    }
  } else {
    if (vault !== null)
      v.push({ invariant: 'I4', detail: 'vault present while signed out' });
    if (app.keychain.size !== 0)
      v.push({
        invariant: 'I4',
        detail: 'Keychain not empty while signed out',
      });
    if (api !== null)
      v.push({
        invariant: 'I4',
        detail: 'apiSession present while signed out',
      });
    if (app.scope.getActiveDataOwner() !== app.scope.SIGNED_OUT_DATA_OWNER) {
      v.push({
        invariant: 'I4',
        detail: 'data owner not SIGNED_OUT while signed out',
      });
    }
    if (model.explicitSignOut && mockKv.get('auth.last-provider')) {
      v.push({
        invariant: 'I4',
        detail: 'legacy provider flag still set after explicit sign-out',
      });
    }
  }
  // I5 — leak scan
  const keychainBlob = JSON.stringify([...app.keychain.entries()]);
  for (const [prefix, label] of [
    [ACCESS_PREFIX, 'access token'],
    [ID_TOKEN_PREFIX, 'provider id token'],
    [APPLE_CODE_PREFIX, 'apple authorization code'],
  ] as const) {
    if (secretsOfKind(keychainBlob, prefix).length)
      v.push({ invariant: 'I5', detail: `${label} in Keychain` });
  }
  const refreshInKeychain = secretsOfKind(keychainBlob, REFRESH_PREFIX);
  if (refreshInKeychain.length > 1)
    v.push({
      invariant: 'I5',
      detail: 'more than one refresh token in Keychain',
    });
  if (refreshInKeychain.length === 1 && !model.vaultCorrupt) {
    const allowed = expectedVaultRaw
      ? secretsOfKind(expectedVaultRaw, REFRESH_PREFIX)
      : [];
    if (refreshInKeychain[0] !== allowed[0]) {
      v.push({
        invariant: 'I5',
        detail: 'Keychain refresh token is not the expected current one',
      });
    }
  }
  if (findSecrets(JSON.stringify([...mockKv.entries()])).length)
    v.push({ invariant: 'I5', detail: 'token in SQLite kv' });
  if (findSecrets(consoleLines.join('\n')).length)
    v.push({ invariant: 'I5', detail: 'token in console output' });
  if (findSecrets(safeStringify(state)).length)
    v.push({ invariant: 'I5', detail: 'token in auth UI state' });
  // I6
  if (server.reusedRefreshTokens.length)
    v.push({
      invariant: 'I6',
      detail: `spent refresh token replayed ×${server.reusedRefreshTokens.length}`,
    });
  // I7
  for (const other of model.otherDevices) {
    const revoked = other.session.revokedAt !== null;
    if (revoked !== other.revokedByItself) {
      v.push({
        invariant: 'I7',
        detail: `other device ${other.session.device} revoked=${revoked} expected=${other.revokedByItself}`,
      });
    }
  }
  return v;
}

/** Exact bytes the Keychain must hold for the model, or null for none. */
function expectedVault(model: Model): string | null {
  if (!model.signedIn || !model.session || !model.account) return null;
  if (model.vaultLost) return model.staleVault?.raw ?? null;
  return JSON.stringify({
    version: 1,
    provider: model.provider,
    canonicalAppUserId: model.account.userId,
    refreshToken: model.session.refreshToken,
    email: model.account.email,
    displayName: 'Pat Player',
  });
}

// ─── Runner ──────────────────────────────────────────────────────────────────

interface ScenarioRow {
  seed: number;
  provider: string;
  accessLifetimeSeconds: number;
  stepCount: number;
  ok: boolean;
  durationMs: number;
  serverCalls: number;
  orphanedServerSessions: number;
  degradedBySigninFailure: number;
  steps: StepResult[];
  calls?: ReturnType<typeof redactCall>[];
}

async function runScenario(scenario: Scenario): Promise<ScenarioRow> {
  const startedAt = Date.now();
  const prng = new Prng(scenario.seed ^ 0x9e3779b9);
  const server = new FakeAuthServer({
    prng,
    baseUrl: API_BASE_URL,
    accessLifetimeSeconds: scenario.accessLifetimeSeconds,
  });
  for (const account of ACCOUNTS)
    server.registerAccount(account.subject, account.userId, account.email);
  const restoreFetch = server.install();
  const capture = captureConsole();
  mockKv.clear();
  jest.clearAllMocks();
  mockGoogleSignin.hasPreviousSignIn.mockReturnValue(false);
  mockGoogleSignin.signInSilently.mockResolvedValue({
    type: 'noSavedCredentialFound',
    data: null,
  });
  mockGoogleSignin.hasPlayServices.mockResolvedValue(true);
  mockGoogleSignin.signOut.mockResolvedValue(null);

  jest.resetModules();
  let app = launch([]);
  server.device = 'this-device';
  const model: Model = {
    signedIn: false,
    account: null,
    provider: null,
    session: null,
    hasBearer: false,
    keeperAlive: false,
    vaultLost: false,
    staleVault: null,
    vaultCorrupt: false,
    explicitSignOut: false,
    otherDevices: [],
    orphaned: [],
    degradedBySigninFailure: 0,
  };
  const signOutModel = (explicit: boolean) => {
    model.signedIn = false;
    model.session = null;
    model.hasBearer = false;
    model.keeperAlive = false;
    model.vaultLost = false;
    model.staleVault = null;
    model.vaultCorrupt = false;
    model.explicitSignOut = explicit;
  };
  /** What a refresh attempt (launch, rotation or foreground) does to the model. */
  const applyRefreshOutcome = (fault: FaultName) => {
    if (fault === 'none' || fault === 'delay') {
      if (model.session && model.session.revokedAt !== null) {
        signOutModel(false); // the server refused: the one implicit sign-out
      } else {
        // A successful rotation re-persists the vault, repairing a lost or
        // corrupted record.
        model.hasBearer = true;
        model.keeperAlive = true;
        model.vaultLost = false;
        model.staleVault = null;
        model.vaultCorrupt = false;
      }
    } else if (REFUSALS.includes(fault)) {
      signOutModel(false);
    } else if (!TRANSIENT.includes(fault)) {
      throw new Error(`fault ${fault} has no oracle outcome`);
    }
    // transient: bearer state unchanged
  };
  const results: StepResult[] = [];
  let ok = true;

  const arm = (
    provider: 'apple' | 'google',
    account: (typeof ACCOUNTS)[number],
  ) => {
    if (provider === 'apple') {
      app.appleSignIn.mockResolvedValue({
        user: 'apple-user',
        identityToken: server.issueIdToken('apple', account.subject),
        authorizationCode: server.issueAppleAuthorizationCode(),
        email: null,
        givenName: 'Pat',
        familyName: 'Player',
      });
    } else {
      mockGoogleSignin.signIn.mockResolvedValue({
        type: 'success',
        data: {
          user: { id: 'google-uid', name: 'Pat Player', email: account.email },
          idToken: server.issueIdToken('google', account.subject),
        },
      });
    }
  };
  const signIn = (provider: 'apple' | 'google') =>
    provider === 'apple'
      ? app.auth.useAuthStore.getState().signInWithApple()
      : app.auth.useAuthStore.getState().signInWithGoogle();

  try {
    for (const step of scenario.steps) {
      const callsBefore = server.calls.length;
      switch (step.op) {
        case 'signin': {
          const account = ACCOUNTS[step.account];
          const fault = faultOf(step.fault, prng);
          if (fault) server.queueFault('bootstrap', fault);
          arm(step.provider, account);
          const original = app.keychainModule.setGenericPassword;
          if (step.keychainFails) {
            app.keychainModule.setGenericPassword = () =>
              Promise.reject(new Error('errSecInteractionNotAllowed'));
          }
          const previousSession = model.signedIn ? model.session : null;
          const previousVaultRaw =
            app.keychain.get(SESSION_VAULT_SERVICE)?.password ?? null;
          // The valid record the Keychain holds right now (if any), with the
          // identity it names — what survives if the coming write fails.
          const previousDurable: Model['staleVault'] =
            model.vaultCorrupt || !model.signedIn
              ? null
              : model.vaultLost
                ? model.staleVault
                : model.session && model.account && model.provider
                  ? {
                      raw: expectedVault(model) ?? '',
                      session: model.session,
                      account: model.account,
                      provider: model.provider,
                    }
                  : null;
          try {
            await signIn(step.provider);
            await server.settleDelays();
          } finally {
            app.keychainModule.setGenericPassword = original;
          }
          if (step.fault === 'none' || step.fault === 'delay') {
            // Signing in while signed in: the store clears the previous
            // runtime first WITHOUT revoking it server-side.
            if (previousSession && !previousSession.revokedAt) {
              model.orphaned.push(previousSession.sessionId);
            }
            const live = server
              .liveSessionsFor(account.userId)
              .filter(
                s =>
                  s.device === 'this-device' &&
                  s.spentRefreshTokens.length === 0,
              );
            model.session = live[live.length - 1] ?? null;
            model.signedIn = model.session !== null;
            model.account = account;
            model.provider = step.provider;
            model.hasBearer = true;
            model.keeperAlive = true;
            model.explicitSignOut = false;
            model.vaultLost = step.keychainFails;
            model.vaultCorrupt = step.keychainFails && model.vaultCorrupt;
            model.staleVault =
              step.keychainFails &&
              previousDurable &&
              previousDurable.raw === previousVaultRaw
                ? previousDurable
                : null;
            if (
              step.keychainFails &&
              previousVaultRaw !== null &&
              !model.staleVault &&
              !model.vaultCorrupt
            ) {
              // Unexpected Keychain content survived a failed write.
              results.push({
                step,
                violations: [
                  {
                    invariant: 'I2',
                    detail: 'unmodelled Keychain content after failed write',
                  },
                ],
                callsDelta: server.calls.length - callsBefore,
                model: summarizeModel(model),
              });
              ok = false;
            }
            if (!model.session) {
              results.push({
                step,
                violations: [
                  {
                    invariant: 'I1',
                    detail:
                      'bootstrap succeeded on server but no fresh session found',
                  },
                ],
                callsDelta: server.calls.length - callsBefore,
                model: summarizeModel(model),
              });
              ok = false;
            }
          } else {
            // Failed sign-in: the store reports an error and changes nothing
            // durable. A run that was ALREADY signed in keeps its UI session
            // and vault but `clearSyncedRuntime()` already dropped its bearer
            // and keeper (characterized; recovered by the next launch).
            if (model.signedIn) {
              model.hasBearer = false;
              model.keeperAlive = false;
              model.degradedBySigninFailure += 1;
            }
            if (app.auth.useAuthStore.getState().error === null) {
              results.push({
                step,
                violations: [
                  {
                    invariant: 'I1',
                    detail: 'failed bootstrap produced no error',
                  },
                ],
                callsDelta: server.calls.length - callsBefore,
                model: summarizeModel(model),
              });
              ok = false;
            }
          }
          break;
        }
        case 'relaunch': {
          const snapshot = kill(app);
          app = launch(snapshot);
          const fault = faultOf(step.fault, prng);
          if (fault) server.queueFault('refresh', fault);
          const t0 = Date.now();
          await app.auth.useAuthStore.getState().hydrate();
          const hydrateMs = Date.now() - t0;
          await server.settleDelays();
          if (hydrateMs >= 8_000) {
            results.push({
              step,
              violations: [
                { invariant: 'budget', detail: `hydrate took ${hydrateMs} ms` },
              ],
              callsDelta: server.calls.length - callsBefore,
              model: summarizeModel(model),
            });
            ok = false;
          }
          // The launch trusts exactly what the Keychain holds.
          const restorable =
            model.signedIn &&
            !model.vaultCorrupt &&
            (!model.vaultLost || model.staleVault !== null);
          if (!restorable) {
            signOutModel(model.explicitSignOut);
            if (server.calls.length !== callsBefore) {
              results.push({
                step,
                violations: [
                  {
                    invariant: 'I4',
                    detail: 'network call on a launch with no valid vault',
                  },
                ],
                callsDelta: server.calls.length - callsBefore,
                model: summarizeModel(model),
              });
              ok = false;
            }
          } else {
            if (model.vaultLost && model.staleVault) {
              // The previous record survived the failed write: the launch
              // restores THAT identity, not the one the run had in memory.
              model.account = model.staleVault.account;
              model.provider = model.staleVault.provider;
              model.session = model.staleVault.session;
              model.vaultLost = false;
              model.staleVault = null;
            }
            model.hasBearer = false;
            model.keeperAlive = true;
            if (model.session === null) {
              // Stale record naming a session the fake server never had.
              signOutModel(false);
            } else {
              applyRefreshOutcome(step.fault);
            }
          }
          server.clearFaults();
          break;
        }
        case 'rotate':
        case 'foreground': {
          const fault = faultOf(step.fault, prng);
          const willCall =
            model.signedIn &&
            model.keeperAlive &&
            (step.op === 'rotate' ||
              !model.hasBearer ||
              scenario.accessLifetimeSeconds < 5 * 60);
          if (fault && willCall) server.queueFault('refresh', fault);
          if (step.op === 'rotate') {
            app.keeper.refreshSessionNow();
          } else {
            const appState = app.rn.AppState.addEventListener as jest.Mock;
            for (const [event, listener] of appState.mock.calls) {
              if (event === 'change')
                (listener as (s: string) => void)('active');
            }
          }
          await settle();
          await server.settleDelays();
          if (willCall) applyRefreshOutcome(step.fault);
          server.clearFaults();
          break;
        }
        case 'signout': {
          const fault = faultOf(step.fault, prng);
          if (fault) server.queueFault('logout', fault);
          const hadBearer = model.signedIn && model.hasBearer;
          const session = model.session;
          await app.auth.useAuthStore.getState().signOut();
          await server.settleDelays();
          if (session && model.signedIn) {
            if (
              hadBearer &&
              (step.fault === 'none' || step.fault === 'delay')
            ) {
              if (session.revokedAt === null) {
                results.push({
                  step,
                  violations: [
                    {
                      invariant: 'I8',
                      detail:
                        'sign-out with a bearer did not revoke the server session',
                    },
                  ],
                  callsDelta: server.calls.length - callsBefore,
                  model: summarizeModel(model),
                });
                ok = false;
              }
            } else if (session.revokedAt === null) {
              model.orphaned.push(session.sessionId);
            }
          }
          signOutModel(true);
          server.clearFaults();
          break;
        }
        case 'revoke-server': {
          if (model.session && model.session.revokedAt === null) {
            model.session.revokedAt = Date.now();
          }
          break;
        }
        case 'other-device': {
          // Another phone signs in as the same account (or account A when
          // this device is signed out) and maybe signs out; this device's
          // process is untouched.
          const account = model.account ?? ACCOUNTS[0];
          const idToken = server.issueIdToken(step.provider, account.subject);
          server.device = `other-${results.length}`;
          const response = await server.handle(
            `${API_BASE_URL}/v1/account/bootstrap`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${idToken}` },
              body: JSON.stringify({ locale: 'en-US' }),
            },
          );
          const body = (await response.json()) as {
            session: { accessToken: string };
          };
          const other = server.sessionByAccessToken(body.session.accessToken);
          server.device = 'this-device';
          if (!other)
            throw new Error('other device bootstrap produced no session');
          if (step.signsOut) {
            await server.handle(`${API_BASE_URL}/v1/auth/logout`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${other.accessToken}` },
            });
          }
          model.otherDevices.push({
            session: other,
            revokedByItself: step.signsOut,
          });
          break;
        }
        case 'corrupt-vault': {
          const item = app.keychain.get(SESSION_VAULT_SERVICE);
          if (item) {
            app.keychain.set(SESSION_VAULT_SERVICE, {
              ...item,
              password: corrupt(item.password, step.mutation),
            });
            model.vaultCorrupt = true;
          }
          break;
        }
        default: {
          const never: never = step;
          throw new Error(`unknown step ${JSON.stringify(never)}`);
        }
      }
      const violations = checkInvariants(app, model, server, capture.lines);
      if (violations.length) ok = false;
      results.push({
        step,
        violations,
        callsDelta: server.calls.length - callsBefore,
        model: summarizeModel(model),
      });
    }
  } finally {
    app.keeper.stopSessionKeeper();
    app.sync.clearSyncRuntime();
    app.api.clearApiSession();
    app.keychain.clear();
    restoreFetch();
    capture.restore();
  }
  const row: ScenarioRow = {
    seed: scenario.seed,
    provider: scenario.provider,
    accessLifetimeSeconds: scenario.accessLifetimeSeconds,
    stepCount: scenario.steps.length,
    ok,
    durationMs: Date.now() - startedAt,
    serverCalls: server.calls.length,
    orphanedServerSessions: model.orphaned.length,
    degradedBySigninFailure: model.degradedBySigninFailure,
    steps: results,
  };
  if (!ok) row.calls = server.calls.map(redactCall);
  return row;
}

function summarizeModel(model: Model): Record<string, unknown> {
  return {
    signedIn: model.signedIn,
    provider: model.provider,
    hasBearer: model.hasBearer,
    keeperAlive: model.keeperAlive,
    vaultLost: model.vaultLost,
    staleVault: model.staleVault ? model.staleVault.account.subject : null,
    vaultCorrupt: model.vaultCorrupt,
    sessionRevoked: model.session ? model.session.revokedAt !== null : null,
    rotations: model.session?.spentRefreshTokens.length ?? null,
    otherDevices: model.otherDevices.length,
    orphaned: model.orphaned.length,
  };
}

// ─── The run ─────────────────────────────────────────────────────────────────

const SCENARIOS = Number(process.env['XC_MATRIX_SCENARIOS'] ?? 400);
const SEED_BASE = Number(process.env['XC_MATRIX_SEED_BASE'] ?? 1_000_000);
const ONLY_SEED = process.env['XC_MATRIX_ONLY_SEED']
  ? Number(process.env['XC_MATRIX_ONLY_SEED'])
  : null;

jest.setTimeout(20 * 60_000);

describe('seeded adversarial matrix', () => {
  it(`runs ${ONLY_SEED === null ? SCENARIOS : 1} seeded sign-in/restore programs with zero invariant violations`, async () => {
    const seeds =
      ONLY_SEED === null
        ? Array.from({ length: SCENARIOS }, (_, i) => SEED_BASE + i)
        : [ONLY_SEED];
    const rows: ScenarioRow[] = [];
    const heap: Array<Record<string, number | string>> = [];
    const opCounts: Record<string, number> = {};
    const faultCounts: Record<string, number> = {};
    const runStartedAt = Date.now();
    heap.push({ at: 0, ...heapNumbers() });
    for (const [i, seed] of seeds.entries()) {
      const scenario = generate(seed);
      for (const step of scenario.steps) {
        opCounts[step.op] = (opCounts[step.op] ?? 0) + 1;
        if ('fault' in step)
          faultCounts[`${step.op}:${step.fault}`] =
            (faultCounts[`${step.op}:${step.fault}`] ?? 0) + 1;
      }
      rows.push(await runScenario(scenario));
      if ((i + 1) % 50 === 0) heap.push({ at: i + 1, ...heapNumbers() });
    }
    heap.push({ at: seeds.length, ...heapNumbers() });
    const failures = rows.filter(r => !r.ok);
    const summary = {
      generatedAt: new Date().toISOString(),
      seedBase: SEED_BASE,
      scenarios: seeds.length,
      onlySeed: ONLY_SEED,
      totalSteps: rows.reduce((s, r) => s + r.stepCount, 0),
      totalServerCalls: rows.reduce((s, r) => s + r.serverCalls, 0),
      failures: failures.length,
      failureSeeds: failures.map(f => f.seed),
      orphanedServerSessions: rows.reduce(
        (s, r) => s + r.orphanedServerSessions,
        0,
      ),
      scenariosWithOrphans: rows.filter(r => r.orphanedServerSessions > 0)
        .length,
      degradedBySigninFailure: rows.reduce(
        (s, r) => s + r.degradedBySigninFailure,
        0,
      ),
      opCounts,
      faultCounts,
      wallMs: Date.now() - runStartedAt,
      heap,
      replay:
        'cd apps/mobile && XC_MATRIX_ONLY_SEED=<seed> npx jest --ci __tests__/xc/journeySigninRestore.matrix.test.ts',
    };
    writeArtifact('matrix.json', { summary, rows });
    writeArtifact('matrix-failures.json', failures);
    writeArtifact(
      'matrix-invariants.json',
      Object.fromEntries(
        ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'budget'].map(inv => [
          inv,
          rows.reduce(
            (n, r) =>
              n +
              r.steps.filter(s => s.violations.some(v => v.invariant === inv))
                .length,
            0,
          ),
        ]),
      ),
    );
    expect(
      failures.map(f => ({
        seed: f.seed,
        violations: f.steps.flatMap(s => s.violations),
      })),
    ).toEqual([]);
    expect(rows).toHaveLength(seeds.length);
  });
});
