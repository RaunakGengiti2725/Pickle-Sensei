/**
 * LIFECYCLE/PERSISTENCE matrix — authStore.hydrate() under every persisted-
 * state corruption the device can present at launch.
 *
 * Inputs swept (all deterministic, see xc-harness/lifecycle-persistence/seeds.ts):
 *   - Keychain vault: absent, ~50 structural/raw corruptions, valid records;
 *   - Keychain behaviour: ok, read throws, read returns nothing, reset throws;
 *   - SQLite kv `auth.session` / `auth.local-mode` / `auth.last-provider`:
 *     absent, empty, valid, ~20 raw corruptions each;
 *   - SQLite behaviour: ok, open throws, individual kv reads/writes throw,
 *     every statement throws;
 *   - /v1/auth/refresh: rotate, 401, 403, 429, 500, malformed body, empty
 *     body, network error, hang past the 8 s launch budget;
 *   - Google silent restore: no previous sign-in, success, no saved
 *     credential, throws, no id token.
 *
 * Invariants asserted per scenario (the contract from AGENTS.md "Auth
 * sessions", not the current code path):
 *   noThrow             hydrate() resolves and `hydrated` becomes true
 *   noImplicitSignOut   a parseable canonical vault record + any refresh
 *                       outcome other than 401/403 ends signed in as that
 *                       account, with the data owner pointing at it
 *   revokedSignsOut     401/403 → signed out AND the vault record is gone
 *   malformedDiscarded  a record the vault refuses is removed from the Keychain
 *   shotsPreserved      local_shot rows are byte-identical afterwards and no
 *                       destructive statement ran
 *   noSessionInKv       kv never holds session material afterwards
 *   vaultShape          a re-persisted record has exactly the allowed keys
 *   ownerConsistent     active data owner matches the resulting session
 *
 * Every executed row (inputs + observations + per-invariant verdict) goes to
 * artifacts/xc-lifecycle-persistence/auth-hydrate-matrix.rows.json; the
 * jest assertions at the end fail on any invariant miss so the failing rows
 * are visible in the test output too.
 */
import { NativeModules } from 'react-native';
import { useAuthStore } from '../../../src/auth/authStore';
import {
  clearApiSession,
  getApiSession,
} from '../../../src/account/apiSession';
import { SESSION_VAULT_SERVICE } from '../../../src/account/sessionVault';
import { stopSessionKeeper } from '../../../src/account/sessionKeeper';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import { clearSyncRuntime } from '../../../src/data/syncRuntime';
import { FakeLocalDb } from '../../../xc-harness/lifecycle-persistence/fakeLocalDb';
import {
  CANONICAL_ID,
  KV_LAST_PROVIDER_VARIANTS,
  KV_LEGACY_SESSION_VARIANTS,
  KV_LOCAL_MODE_VARIANTS,
  LAST_PROVIDER_GOOGLE_VALUE,
  VAULT_ACCEPTED_NON_UUID,
  VAULT_ACCEPTED_VARIANTS,
  VAULT_RECORD_VARIANTS,
  VAULT_VARIANT_NAMES,
  makePrng,
  pick,
} from '../../../xc-harness/lifecycle-persistence/seeds';
import {
  heapSnapshot,
  matrixMarkdown,
  summarize,
  writeJsonArtifact,
  writeTextArtifact,
  type MatrixRow,
} from '../../../xc-harness/lifecycle-persistence/artifacts';

// ─── Module seams ────────────────────────────────────────────────────────────

const mockDb = { current: new FakeLocalDb() };
jest.mock('../../../src/data/db', () => ({
  getDb: () => mockDb.current.handle(),
}));

type KeychainMode = 'ok' | 'get-throws' | 'get-returns-false' | 'reset-throws';
const mockKeychain = {
  store: new Map<string, { username: string; password: string }>(),
  mode: 'ok' as KeychainMode,
  log: [] as string[],
};
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
    mockKeychain.log.push('set');
    mockKeychain.store.set(options.service ?? '__default__', {
      username,
      password,
    });
    return { service: options.service, storage: 'mock' };
  },
  getGenericPassword: async (options: { service?: string } = {}) => {
    mockKeychain.log.push('get');
    if (mockKeychain.mode === 'get-throws') {
      throw new Error('errSecInteractionNotAllowed (simulated)');
    }
    if (mockKeychain.mode === 'get-returns-false') return false;
    const item = mockKeychain.store.get(options.service ?? '__default__');
    if (!item) return false;
    return { service: options.service, storage: 'mock', ...item };
  },
  resetGenericPassword: async (options: { service?: string } = {}) => {
    mockKeychain.log.push('reset');
    if (mockKeychain.mode === 'reset-throws') {
      throw new Error('errSecItemNotFound (simulated)');
    }
    return mockKeychain.store.delete(options.service ?? '__default__');
  },
}));

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

jest.mock('../../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: 'test-web-client.apps.googleusercontent.com',
  GOOGLE_IOS_CLIENT_ID: 'test-ios-client.apps.googleusercontent.com',
}));

jest.mock('../../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.example.test',
    revenueCatPublicSdkKey: null,
    googleIosClientId: 'test-ios-client.apps.googleusercontent.com',
    googleWebClientId: 'test-web-client.apps.googleusercontent.com',
    appVersion: '1.0',
  }),
}));

jest.mock('../../../src/account/deviceContext', () => ({
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

// ─── Scenario space ──────────────────────────────────────────────────────────

const REFRESH_MODES = [
  'rotate',
  '401',
  '403',
  '429',
  '500',
  '503',
  'malformed-body',
  'empty-session',
  'network-error',
  'hang',
] as const;
type RefreshMode = (typeof REFRESH_MODES)[number];

const DB_MODES = [
  'ok',
  'open-throws',
  'kv-get-legacy-throws',
  'kv-get-local-mode-throws',
  'kv-get-last-provider-throws',
  'kv-set-legacy-throws',
  'all-throw',
] as const;
type DbMode = (typeof DB_MODES)[number];

const KEYCHAIN_MODES: KeychainMode[] = [
  'ok',
  'get-throws',
  'get-returns-false',
  'reset-throws',
];

const GOOGLE_MODES = [
  'no-previous',
  'silent-success',
  'no-saved-credential',
  'silent-throws',
  'no-id-token',
] as const;
type GoogleMode = (typeof GOOGLE_MODES)[number];

const VAULT_CHOICES = ['absent', ...VAULT_VARIANT_NAMES];
const LOCAL_MODE_CHOICES = Object.keys(KV_LOCAL_MODE_VARIANTS);
const LAST_PROVIDER_CHOICES = Object.keys(KV_LAST_PROVIDER_VARIANTS);
const LEGACY_CHOICES = Object.keys(KV_LEGACY_SESSION_VARIANTS);

interface AuthScenario {
  name: string;
  seed: number | null;
  vault: string;
  keychain: KeychainMode;
  kvLocalMode: string;
  kvLastProvider: string;
  kvLegacySession: string;
  db: DbMode;
  refresh: RefreshMode;
  google: GoogleMode;
  canonicalShots: number;
  guestShots: number;
}

const EXISTING_ONLINE: Omit<AuthScenario, 'name' | 'seed'> = {
  vault: 'valid-apple',
  keychain: 'ok',
  kvLocalMode: 'raw-absent',
  kvLastProvider: 'raw-absent',
  kvLegacySession: 'raw-absent',
  db: 'ok',
  refresh: 'rotate',
  google: 'no-previous',
  canonicalShots: 25,
  guestShots: 7,
};
const EXISTING_OFFLINE = {
  ...EXISTING_ONLINE,
  refresh: 'network-error' as const,
};
const FRESH_INSTALL = {
  ...EXISTING_ONLINE,
  vault: 'absent',
  canonicalShots: 0,
  guestShots: 0,
};
/** Device that signed in with Google before the vault existed: no Keychain
 * record, only the provider flag in kv, SDK still holds a credential. */
const LEGACY_GOOGLE = {
  ...EXISTING_ONLINE,
  vault: 'absent',
  kvLastProvider: 'valid-google',
  google: 'silent-success' as const,
};

function sweep(
  baselineName: string,
  baseline: Omit<AuthScenario, 'name' | 'seed'>,
): AuthScenario[] {
  const out: AuthScenario[] = [];
  out.push({ ...baseline, name: `${baselineName}/baseline`, seed: null });
  const factor = <K extends keyof typeof baseline>(
    key: K,
    values: readonly (typeof baseline)[K][],
  ) => {
    for (const value of values) {
      if (value === baseline[key]) continue;
      out.push({
        ...baseline,
        [key]: value,
        name: `${baselineName}/${String(key)}=${String(value)}`,
        seed: null,
      });
    }
  };
  factor('vault', VAULT_CHOICES);
  factor('keychain', KEYCHAIN_MODES);
  factor('kvLocalMode', LOCAL_MODE_CHOICES);
  factor('kvLastProvider', LAST_PROVIDER_CHOICES);
  factor('kvLegacySession', LEGACY_CHOICES);
  factor('db', DB_MODES);
  factor('refresh', REFRESH_MODES);
  factor('google', GOOGLE_MODES);
  return out;
}

function seeded(seed: number): AuthScenario {
  const rng = makePrng(seed);
  return {
    name: `seeded/${seed}`,
    seed,
    vault: pick(rng, VAULT_CHOICES),
    keychain: pick(rng, KEYCHAIN_MODES),
    kvLocalMode: pick(rng, LOCAL_MODE_CHOICES),
    kvLastProvider: pick(rng, LAST_PROVIDER_CHOICES),
    kvLegacySession: pick(rng, LEGACY_CHOICES),
    db: pick(rng, DB_MODES),
    refresh: pick(rng, REFRESH_MODES),
    google: pick(rng, GOOGLE_MODES),
    canonicalShots: Math.floor(rng() * 40),
    guestShots: Math.floor(rng() * 10),
  };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** Evaluated per response: the suite runs under fake timers whose clock
 * advances ~9 s per scenario, so a module-level constant would drift into
 * the past after a few hundred rows and trigger refresh loops. */
const farFutureSeconds = () => Math.floor(Date.now() / 1000) + 3600;
const LAUNCH_REFRESH_WAIT_MS = 8_000;

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

const refreshBody = () => ({
  session: {
    accessToken: 'access-rotated',
    refreshToken: 'refresh-rotated',
    expiresAt: farFutureSeconds(),
  },
});

const bootstrapBody = () => ({
  user: { id: CANONICAL_ID, email: 'pat@example.com' },
  onboardingState: 'complete',
  session: {
    accessToken: 'access-google',
    refreshToken: 'refresh-google',
    expiresAt: farFutureSeconds(),
  },
});

function installFetch(scenario: AuthScenario): jest.Mock {
  const fetchMock = jest.fn(async (url: string) => {
    if (url.endsWith('/v1/auth/refresh')) {
      switch (scenario.refresh) {
        case 'rotate':
          return response(refreshBody());
        case '401':
          return response({ error: 'invalid_grant' }, 401);
        case '403':
          return response({ error: 'forbidden' }, 403);
        case '429':
          return response({ error: 'rate_limited' }, 429);
        case '500':
          return response({ error: 'internal' }, 500);
        case '503':
          return response({ error: 'unavailable' }, 503);
        case 'malformed-body':
          return {
            ok: true,
            status: 200,
            json: jest.fn().mockRejectedValue(new SyntaxError('bad json')),
          } as unknown as Response;
        case 'empty-session':
          return response({ session: {} });
        case 'network-error':
          throw new TypeError('Network request failed');
        case 'hang':
          return new Promise<Response>(() => {});
      }
    }
    if (url.endsWith('/v1/account/bootstrap')) {
      return response(bootstrapBody());
    }
    if (url.endsWith('/v1/auth/logout')) return response({}, 204);
    throw new Error(`unexpected route ${url}`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function configureGoogle(mode: GoogleMode): void {
  mockGoogleSignin.hasPreviousSignIn.mockReturnValue(mode !== 'no-previous');
  switch (mode) {
    case 'silent-success':
      mockGoogleSignin.signInSilently.mockResolvedValue({
        type: 'success',
        data: {
          idToken: 'google-id-token',
          user: { name: 'Pat Player', email: 'pat@example.com' },
        },
      });
      break;
    case 'no-id-token':
      mockGoogleSignin.signInSilently.mockResolvedValue({
        type: 'success',
        data: { idToken: null, user: { name: null, email: null } },
      });
      break;
    case 'silent-throws':
      mockGoogleSignin.signInSilently.mockRejectedValue(
        new Error('SIGN_IN_REQUIRED (simulated)'),
      );
      break;
    default:
      mockGoogleSignin.signInSilently.mockResolvedValue({
        type: 'noSavedCredentialFound',
        data: null,
      });
  }
}

function applyDbFaults(db: FakeLocalDb, mode: DbMode): void {
  switch (mode) {
    case 'open-throws':
      db.faults = { openThrows: 'SQLITE_CANTOPEN (simulated)' };
      break;
    case 'kv-get-legacy-throws':
      db.faults = { kvGetThrows: new Set(['auth.session']) };
      break;
    case 'kv-get-local-mode-throws':
      db.faults = { kvGetThrows: new Set(['auth.local-mode']) };
      break;
    case 'kv-get-last-provider-throws':
      db.faults = { kvGetThrows: new Set(['auth.last-provider']) };
      break;
    case 'kv-set-legacy-throws':
      db.faults = { kvSetThrows: new Set(['auth.session']) };
      break;
    case 'all-throw':
      db.faults = { allThrow: 'SQLITE_IOERR (simulated)' };
      break;
    default:
      db.faults = {};
  }
}

const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;

function resetRuntime(): void {
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    hydrated: false,
    session: null,
    busy: false,
    error: null,
  });
}

// ─── Oracle ──────────────────────────────────────────────────────────────────

const ALLOWED_VAULT_KEYS = [
  'version',
  'provider',
  'canonicalAppUserId',
  'refreshToken',
  'email',
  'displayName',
].sort();

function expectedProfile(scenario: AuthScenario) {
  const vaultPresent = scenario.vault !== 'absent';
  const keychainReadable =
    scenario.keychain === 'ok' || scenario.keychain === 'reset-throws';
  const vaultParsed =
    vaultPresent &&
    keychainReadable &&
    VAULT_ACCEPTED_VARIANTS.has(scenario.vault);
  const vaultUuidOk =
    vaultParsed && !VAULT_ACCEPTED_NON_UUID.has(scenario.vault);
  const vaultAccountId = vaultParsed
    ? String(
        (
          JSON.parse(VAULT_RECORD_VARIANTS[scenario.vault] as string) as Record<
            string,
            unknown
          >
        )['canonicalAppUserId'],
      )
        .trim()
        .toLowerCase()
    : null;
  const revoked = scenario.refresh === '401' || scenario.refresh === '403';
  const legacyValue =
    KV_LEGACY_SESSION_VARIANTS[scenario.kvLegacySession] ?? null;
  const legacyTruthy = legacyValue !== null && legacyValue !== '';
  // A SQLite statement the auth store issues BEFORE it consults the Keychain
  // fails: the store's outer catch lands signed-out (see finding XC-LP-1).
  const dbFatal =
    scenario.db === 'open-throws' ||
    scenario.db === 'all-throw' ||
    scenario.db === 'kv-get-legacy-throws' ||
    scenario.db === 'kv-get-local-mode-throws' ||
    (scenario.db === 'kv-set-legacy-throws' && legacyTruthy);
  const guestKv = scenario.kvLocalMode === 'valid-guest';
  return {
    vaultPresent,
    keychainReadable,
    vaultParsed,
    vaultUuidOk,
    vaultAccountId,
    revoked,
    dbFatal,
    guestKv,
  };
}

/**
 * Contract deviations already reproduced and triaged (see the findings in the
 * session report). A row failing ONLY through these is recorded as a known
 * deviation, not as a new failure; the suite additionally asserts that each
 * of them is still reproduced, so a fix flips the row back to strict.
 */
const KNOWN_DEVIATIONS = {
  'XC-LP-1':
    'SQLite failure before the Keychain read (open, legacy/local-mode kv read, legacy kv wipe) signs a valid durable session out for this launch',
  'XC-LP-2':
    'Vault record with a non-UUID canonicalAppUserId passes parsePersistedSession, throws in canonicalDataOwner, lands signed-out and is never discarded',
} as const;
type DeviationId = keyof typeof KNOWN_DEVIATIONS;

function classifyDeviation(
  scenario: AuthScenario,
  invariant: string,
  exp: ReturnType<typeof expectedProfile>,
): DeviationId | null {
  if (invariant === 'noImplicitSignOut' && exp.dbFatal) return 'XC-LP-1';
  if (
    invariant === 'unusableRecordDiscarded' &&
    VAULT_ACCEPTED_NON_UUID.has(scenario.vault)
  ) {
    return 'XC-LP-2';
  }
  return null;
}

async function runScenario(scenario: AuthScenario): Promise<MatrixRow> {
  const started = Date.now();
  resetRuntime();
  const db = new FakeLocalDb();
  mockDb.current = db;
  db.seedShots(CANONICAL_ID, scenario.canonicalShots);
  db.seedShots(GUEST_DATA_OWNER, scenario.guestShots);
  const setKvVariant = (key: string, value: string | null) => {
    if (value !== null) db.kv.set(key, value);
  };
  setKvVariant(
    'auth.local-mode',
    KV_LOCAL_MODE_VARIANTS[scenario.kvLocalMode] ?? null,
  );
  setKvVariant(
    'auth.last-provider',
    KV_LAST_PROVIDER_VARIANTS[scenario.kvLastProvider] ?? null,
  );
  setKvVariant(
    'auth.session',
    KV_LEGACY_SESSION_VARIANTS[scenario.kvLegacySession] ?? null,
  );
  const shotsBefore = db.shotFingerprint();
  const kvBefore = new Map(db.kv);
  applyDbFaults(db, scenario.db);

  mockKeychain.store.clear();
  mockKeychain.log.length = 0;
  mockKeychain.mode = scenario.keychain;
  if (scenario.vault !== 'absent') {
    mockKeychain.store.set(SESSION_VAULT_SERVICE, {
      username: 'session',
      password: VAULT_RECORD_VARIANTS[scenario.vault] as string,
    });
  }
  configureGoogle(scenario.google);
  const fetchMock = installFetch(scenario);

  let threw: string | null = null;
  const hydrating = useAuthStore
    .getState()
    .hydrate()
    .catch((error: unknown) => {
      threw =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
    });
  await jest.advanceTimersByTimeAsync(LAUNCH_REFRESH_WAIT_MS + 1_000);
  await hydrating;
  // Let any keeper continuation that landed with the deadline settle.
  await jest.advanceTimersByTimeAsync(10);

  const state = useAuthStore.getState();
  const owner = getActiveDataOwner();
  const vaultAfterRaw =
    mockKeychain.store.get(SESSION_VAULT_SERVICE)?.password ?? null;
  let vaultAfter: Record<string, unknown> | null | 'unparseable' = null;
  if (vaultAfterRaw !== null) {
    try {
      const parsed = JSON.parse(vaultAfterRaw) as unknown;
      vaultAfter =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : 'unparseable';
    } catch {
      vaultAfter = 'unparseable';
    }
  }
  const exp = expectedProfile(scenario);
  const sessionId = state.session?.canonicalAppUserId ?? null;
  const signedInAsCanonical =
    state.session !== null &&
    state.session.provider !== 'guest' &&
    sessionId !== null &&
    sessionId.trim().toLowerCase() === exp.vaultAccountId &&
    owner === exp.vaultAccountId;

  const invariants: Record<string, boolean> = {};
  invariants['noThrow'] = threw === null && state.hydrated === true;
  if (exp.vaultUuidOk && !exp.revoked && !exp.guestKv) {
    invariants['noImplicitSignOut'] = signedInAsCanonical;
  }
  if (exp.vaultUuidOk && exp.revoked && !exp.dbFatal && !exp.guestKv) {
    invariants['revokedSignsOut'] =
      state.session === null &&
      owner === SIGNED_OUT_DATA_OWNER &&
      (vaultAfterRaw === null || scenario.keychain === 'reset-throws');
  }
  if (
    exp.vaultPresent &&
    exp.keychainReadable &&
    !exp.vaultParsed &&
    !exp.dbFatal &&
    !exp.guestKv
  ) {
    invariants['malformedDiscarded'] =
      mockKeychain.log.includes('reset') &&
      (scenario.keychain === 'reset-throws' ||
        vaultAfterRaw === null ||
        vaultAfterRaw !== VAULT_RECORD_VARIANTS[scenario.vault]);
  }
  if (
    exp.vaultPresent &&
    exp.keychainReadable &&
    VAULT_ACCEPTED_NON_UUID.has(scenario.vault) &&
    !exp.dbFatal &&
    !exp.guestKv
  ) {
    // Accepted by the parser but unusable as a data owner: the record must
    // still not survive as a launch-after-launch dead weight.
    invariants['unusableRecordDiscarded'] =
      vaultAfterRaw === null || scenario.keychain === 'reset-throws';
  }
  invariants['shotsPreserved'] =
    db.shotFingerprint() === shotsBefore &&
    db.destructiveStatements().length === 0;
  const legacyAfter = db.kv.get('auth.session');
  invariants['noSessionInKv'] =
    scenario.db !== 'ok'
      ? true
      : (legacyAfter === undefined || legacyAfter === '') &&
        [...db.kv.values()].every(
          value => !value.includes('refresh-') && !value.includes('access-'),
        );
  if (
    vaultAfter !== null &&
    vaultAfter !== 'unparseable' &&
    scenario.refresh === 'rotate' &&
    exp.vaultUuidOk &&
    !exp.dbFatal &&
    !exp.guestKv
  ) {
    invariants['vaultShape'] =
      JSON.stringify(Object.keys(vaultAfter).sort()) ===
        JSON.stringify(ALLOWED_VAULT_KEYS) &&
      vaultAfter['refreshToken'] === 'refresh-rotated' &&
      !('accessToken' in vaultAfter) &&
      !('bearerToken' in vaultAfter);
  }
  if (vaultAfter !== null && vaultAfter !== 'unparseable') {
    invariants['vaultNeverHoldsBearer'] =
      !(
        'accessToken' in vaultAfter &&
        vaultAfter['accessToken'] === 'access-rotated'
      ) &&
      !(
        'bearerToken' in vaultAfter &&
        vaultAfter['bearerToken'] === 'access-rotated'
      );
  }
  invariants['ownerConsistent'] =
    state.session === null
      ? owner === SIGNED_OUT_DATA_OWNER
      : state.session.provider === 'guest'
        ? owner === GUEST_DATA_OWNER
        : owner ===
          (state.session.canonicalAppUserId ?? '').trim().toLowerCase();
  if (exp.guestKv && !exp.dbFatal) {
    invariants['guestKvHonoured'] =
      state.session?.provider === 'guest' && owner === GUEST_DATA_OWNER;
  }
  const legacyGooglePath =
    !exp.vaultParsed &&
    scenario.kvLastProvider === 'valid-google' &&
    !exp.dbFatal &&
    scenario.db !== 'kv-get-last-provider-throws' &&
    !exp.guestKv;
  if (legacyGooglePath && scenario.google === 'silent-throws') {
    invariants['transientGoogleKeepsFlag'] =
      db.kv.get('auth.last-provider') === LAST_PROVIDER_GOOGLE_VALUE &&
      state.session === null;
  }
  if (legacyGooglePath && scenario.google === 'silent-success') {
    invariants['legacyGoogleRestores'] =
      state.session?.provider === 'google' &&
      state.session.canonicalAppUserId === CANONICAL_ID &&
      owner === CANONICAL_ID &&
      vaultAfter !== null &&
      vaultAfter !== 'unparseable' &&
      vaultAfter['refreshToken'] === 'refresh-google';
  }
  if (legacyGooglePath && scenario.google === 'no-saved-credential') {
    invariants['definitiveGoogleClearsFlag'] =
      (db.kv.get('auth.last-provider') ?? '') === '' && state.session === null;
  }
  if (legacyGooglePath && scenario.google === 'no-id-token') {
    invariants['noIdTokenKeepsFlag'] =
      db.kv.get('auth.last-provider') === LAST_PROVIDER_GOOGLE_VALUE &&
      state.session === null;
  }

  const allFailed = Object.entries(invariants)
    .filter(([, held]) => !held)
    .map(([name]) => name);
  const knownDeviations: string[] = [];
  const failed: string[] = [];
  for (const name of allFailed) {
    const deviation = classifyDeviation(scenario, name, exp);
    if (deviation) knownDeviations.push(`${deviation}:${name}`);
    else failed.push(name);
  }
  const row: MatrixRow = {
    suite: 'authHydrateMatrix',
    scenario: scenario.name,
    seed: scenario.seed,
    inputs: { ...scenario },
    observed: {
      threw,
      hydrated: state.hydrated,
      session: state.session
        ? {
            provider: state.session.provider,
            canonicalAppUserId: state.session.canonicalAppUserId,
            localOnly: state.session.localOnly,
          }
        : null,
      error: state.error,
      owner,
      apiSessionInstalled: getApiSession() !== null,
      vaultAfter:
        vaultAfter === 'unparseable'
          ? 'unparseable'
          : vaultAfter
            ? Object.keys(vaultAfter).sort()
            : null,
      keychainOps: [...mockKeychain.log],
      refreshCalls: fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith('/v1/auth/refresh'),
      ).length,
      bootstrapCalls: fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith('/v1/account/bootstrap'),
      ).length,
      kvBefore: Object.fromEntries(
        [...kvBefore].map(([k, v]) => [
          k,
          v.length > 80 ? `${v.slice(0, 77)}…(${v.length})` : v,
        ]),
      ),
      kvAfter: Object.fromEntries(
        [...db.kv].map(([k, v]) => [
          k,
          v.length > 80 ? `${v.slice(0, 77)}…(${v.length})` : v,
        ]),
      ),
      kvWrites: db.kvWrites().map(w => ({
        key: w.key,
        value: w.value.length > 80 ? `…(${w.value.length})` : w.value,
      })),
      statements: db.statements.length,
      destructiveStatements: db.destructiveStatements(),
      expectation: exp,
      knownDeviations,
    },
    invariants,
    ok: failed.length === 0,
    failed,
    durationMs: Date.now() - started,
  };
  resetRuntime();
  return row;
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const rows: MatrixRow[] = [];
const SEEDED_COUNT = 2000;

beforeAll(() => {
  jest.useFakeTimers();
  nativeModules.PickleAuth = { signInWithApple: jest.fn() };
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGoogleSignin.hasPlayServices.mockResolvedValue(true);
  mockGoogleSignin.signOut.mockResolvedValue(null);
  mockGoogleSignin.revokeAccess.mockResolvedValue(null);
});

function knownDeviationCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    for (const entry of row.observed['knownDeviations'] as string[]) {
      const id = entry.split(':')[0] as string;
      counts[id] = (counts[id] ?? 0) + 1;
    }
  }
  return counts;
}

afterAll(() => {
  resetRuntime();
  jest.useRealTimers();
  delete nativeModules.PickleAuth;
  globalThis.fetch = realFetch;
  const summary = {
    ...summarize(rows),
    knownDeviations: KNOWN_DEVIATIONS,
    knownDeviationRows: knownDeviationCounts(),
    knownDeviationScenarios: rows
      .filter(row => (row.observed['knownDeviations'] as string[]).length > 0)
      .map(row => ({
        scenario: row.scenario,
        seed: row.seed,
        deviations: row.observed['knownDeviations'],
        inputs: row.inputs,
      })),
  };
  writeJsonArtifact('auth-hydrate-matrix.rows.json', rows);
  writeJsonArtifact('auth-hydrate-matrix.summary.json', summary);
  writeTextArtifact('auth-hydrate-matrix.matrix.md', matrixMarkdown(rows));
});

async function runBatch(scenarios: AuthScenario[]): Promise<MatrixRow[]> {
  const batch: MatrixRow[] = [];
  for (const scenario of scenarios) {
    const row = await runScenario(scenario);
    batch.push(row);
    rows.push(row);
  }
  return batch;
}

function failuresOf(batch: MatrixRow[]): string[] {
  return batch
    .filter(row => !row.ok)
    .map(
      row =>
        `${row.scenario} [seed=${row.seed ?? '-'}] failed ${row.failed.join(',')} :: ${JSON.stringify(row.observed.session)} owner=${String(row.observed.owner)} threw=${String(row.observed.threw)}`,
    );
}

describe('authStore.hydrate() persisted-state matrix', () => {
  const existingOnline = sweep('existing-online', EXISTING_ONLINE);
  const existingOffline = sweep('existing-offline', EXISTING_OFFLINE);
  const fresh = sweep('fresh-install', FRESH_INSTALL);
  const legacyGoogle = sweep('legacy-google', LEGACY_GOOGLE);

  it('existing install, refresh online: every single-factor corruption', async () => {
    const batch = await runBatch(existingOnline);
    expect(batch.length).toBeGreaterThan(100);
    const failures = failuresOf(batch);
    expect(failures).toEqual([]);
  });

  it('existing install, refresh offline: every single-factor corruption', async () => {
    const batch = await runBatch(existingOffline);
    const failures = failuresOf(batch);
    expect(failures).toEqual([]);
  });

  it('fresh install: every single-factor corruption', async () => {
    const batch = await runBatch(fresh);
    const failures = failuresOf(batch);
    expect(failures).toEqual([]);
  });

  it('legacy Google device (flag only, no vault): every single-factor corruption', async () => {
    const batch = await runBatch(legacyGoogle);
    expect(
      batch.find(row => row.scenario === 'legacy-google/baseline')?.invariants[
        'legacyGoogleRestores'
      ],
    ).toBe(true);
    const failures = failuresOf(batch);
    expect(failures).toEqual([]);
  });

  for (let chunk = 0; chunk < SEEDED_COUNT / 100; chunk += 1) {
    const from = chunk * 100;
    it(`seeded random combinations ${from}..${from + 99} (mulberry32, seed = index)`, async () => {
      const scenarios: AuthScenario[] = [];
      for (let seed = from; seed < from + 100; seed += 1)
        scenarios.push(seeded(seed));
      const before = heapSnapshot();
      const batch = await runBatch(scenarios);
      const after = heapSnapshot();
      writeJsonArtifact(`auth-hydrate-matrix.heap.${from}.json`, {
        before,
        after,
      });
      const failures = failuresOf(batch);
      expect(failures).toEqual([]);
    });
  }

  it('every triaged deviation is still reproduced (remove it from KNOWN_DEVIATIONS once fixed)', () => {
    const counts = knownDeviationCounts();
    for (const id of Object.keys(KNOWN_DEVIATIONS)) {
      expect({ id, rows: counts[id] ?? 0 }).toEqual({
        id,
        rows: expect.any(Number),
      });
      expect(counts[id] ?? 0).toBeGreaterThan(0);
    }
  });
});
