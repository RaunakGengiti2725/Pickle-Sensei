/**
 * INT-deletion-managed-media adversary — local purge boundary.
 *
 * Attacks against the post-confirmation local cleanup that
 * `completeAccountDeletion` runs on the device:
 *  ADV-M01 purge deletes ONLY the intended owner (a second account and a
 *          prefix-colliding owner key must survive, device-level kv too);
 *  ADV-M02 the captured media files referenced by the purged rows must be
 *          handed to some removal path (managed media), not just the rows;
 *  ADV-M03 a purge that fails on one table is atomic (no half-purged owner),
 *          is reported as `failed`, and a retry with the same immutable
 *          context completes it without touching the other account.
 */
import { NativeModules } from 'react-native';
import * as Keychain from 'react-native-keychain';
import {
  captureAccountDeletionContext,
  useAuthStore,
} from '../../src/auth/authStore';
import { clearApiSession } from '../../src/account/apiSession';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import { useAppStore } from '../../src/state/appStore';
import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';
import {
  getKv,
  OWNER_SCOPED_KV_NAMESPACES,
  setKv,
} from '../../src/data/repository';
import { clearAccessStoreConfiguration } from '../../src/state/accessStore';
import {
  closeSqliteTestDatabases,
  createSqliteTestDb,
} from '../../testSupport/sqlite';

let mockDatabase: ReturnType<typeof createSqliteTestDb>;
jest.mock('../../src/data/db', () => ({
  getDb: () => mockDatabase.db,
}));
jest.mock('../../src/data/syncRuntime', () => ({
  configureSyncRuntime: jest.fn(),
  clearSyncRuntime: jest.fn(),
}));
jest.mock('../../src/billing/lifecycle', () => ({
  startBillingLifecycle: jest.fn(),
  stopBillingLifecycle: jest.fn(),
}));
jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: 'test-web-client.apps.googleusercontent.com',
  GOOGLE_IOS_CLIENT_ID: 'test-ios-client.apps.googleusercontent.com',
}));
jest.mock('../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.example.test',
    revenueCatPublicSdkKey: null,
    appVersion: '1.0',
  }),
}));
jest.mock('../../src/account/deviceContext', () => ({
  getAccountBootstrapEnvironment: () => ({
    locale: 'en-US',
    timezone: 'UTC',
    device: {
      platform: 'ios',
      osVersion: '18.5',
      appVersion: '1.0',
      model: 'test',
    },
  }),
}));
const mockGoogleSignin = {
  configure: jest.fn(),
  hasPlayServices: jest.fn(),
  hasPreviousSignIn: jest.fn(),
  signInSilently: jest.fn(),
  signIn: jest.fn(),
  signOut: jest.fn(),
  revokeAccess: jest.fn(),
};
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: mockGoogleSignin,
}));
const mockPurchases = {
  configure: jest.fn(),
  logIn: jest.fn(),
  logOut: jest.fn(),
  getCustomerInfo: jest.fn(),
  purchasePackage: jest.fn(),
  purchaseProduct: jest.fn(),
  restorePurchases: jest.fn(),
  syncPurchases: jest.fn(),
};
jest.mock('react-native-purchases', () => ({
  __esModule: true,
  default: mockPurchases,
}));

const OWNER_A = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const OWNER_B = '11111111-1111-4111-8111-111111111111';
/** Same UUID as A but a different version nibble: a `LIKE`/prefix bug or a
 * case-insensitive compare gone wrong would take this owner down with A. */
const OWNER_A_LOOKALIKE = '7fc2c743-028f-4ec6-942c-a84508f3be39';
const OWNER_TABLES = [
  'local_shot',
  'local_session',
  'local_capture',
  'local_analysis_record',
  'outbox',
  'sync_receipt',
] as const;
const DEVICE_KV = {
  'walkthrough.device-complete': 'seen',
  'review.prompt-state': '{"shown":1}',
  'onboarding.pending-profile': '{"version":1}',
};

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};
const nativeModules = NativeModules as Record<string, unknown>;
const originalNativeAuth = nativeModules.PickleAuth;
const originalNativeCapture = nativeModules.PickleVideoCapture;
const originalFetch = globalThis.fetch;

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn(async () => body),
  } as unknown as Response;
}

function bootstrap(owner: string, suffix: string) {
  return response({
    user: { id: owner, email: 'pat@example.test' },
    onboardingState: 'complete',
    session: {
      accessToken: `access-${suffix}`,
      refreshToken: `refresh-${suffix}`,
      expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
    },
  });
}

function installRoutes(
  routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>,
) {
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    const route = routes[new URL(url).pathname];
    if (!route) throw new Error('Offline');
    return route(init);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function captureUri(owner: string, n: number) {
  return `file:///var/mobile/Containers/Data/Application/APP/Documents/captures/${owner}/clip-${n}.mov`;
}

function seedOwner(owner: string) {
  const { native } = mockDatabase;
  const iso = '2026-09-01T00:00:00Z';
  native
    .prepare(
      `INSERT INTO local_shot (owner_key, id, shot_type, captured_at, confidence, result_kind, source, payload)
       VALUES (?, ?, 'forehand_drive', ?, 0.9, 'scored', 'capture', '{}')`,
    )
    .run(owner, `shot-${owner}`, iso);
  native
    .prepare(
      'INSERT INTO local_session (owner_key, id, mode, started_at) VALUES (?, ?, ?, ?)',
    )
    .run(owner, `session-${owner}`, 'practice_set', iso);
  for (const n of [1, 2]) {
    native
      .prepare(
        `INSERT INTO local_capture
         (owner_key, id, uri, shot_type, captured_at, duration_ms, fps, width, height, status, payload)
         VALUES (?, ?, ?, 'forehand_drive', ?, 2000, 30, 1080, 1920, 'analyzed', ?)`,
      )
      .run(
        owner,
        `capture-${owner}-${n}`,
        captureUri(owner, n),
        iso,
        JSON.stringify({
          uri: captureUri(owner, n),
          poster: { uri: captureUri(owner, n).replace('.mov', '.jpg') },
          poseSequence: {
            uri: captureUri(owner, n).replace('.mov', '.pose.json'),
          },
        }),
      );
  }
  native
    .prepare(
      `INSERT INTO local_analysis_record
       (owner_key, id, capture_id, created_at, engine_version, scoring_model_version, record)
       VALUES (?, ?, ?, ?, 'e1', 'm1', '{}')`,
    )
    .run(owner, `record-${owner}`, `capture-${owner}-1`, iso);
  native
    .prepare(
      "INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot', '{}')",
    )
    .run(owner);
  native
    .prepare(
      "INSERT INTO sync_receipt (owner_key, kind, entity_id) VALUES (?, 'shot', ?)",
    )
    .run(owner, `shot-${owner}`);
  for (const namespace of OWNER_SCOPED_KV_NAMESPACES) {
    native
      .prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)')
      .run(`${namespace}:${owner}`, `value-of-${owner}`);
  }
}

function ownerFootprint(owner: string) {
  const tables = Object.fromEntries(
    OWNER_TABLES.map(table => [table, mockDatabase.count(table, owner)]),
  );
  const kv = mockDatabase.native
    .prepare('SELECT key FROM kv WHERE key LIKE ? ORDER BY key')
    .all(`%:${owner}`)
    .map(row => String(row.key));
  return { tables, kv };
}

async function signInAsA() {
  installRoutes({
    '/v1/account/bootstrap': () => bootstrap(OWNER_A, 'A'),
  });
  await useAuthStore.getState().signInWithApple();
  expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(OWNER_A);
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers({ now: Date.parse('2026-09-06T00:00:00Z') });
  mockDatabase = createSqliteTestDb();
  __keychainStore.clear();
  stopSessionKeeper();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    hydrated: false,
    session: null,
    busy: false,
    error: null,
    restoreState: { status: 'restoring' },
  });
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    ownerContext: null,
    awaitingApiSession: false,
    profile: null,
    hydrateError: null,
  });
  nativeModules.PickleAuth = {
    signInWithApple: jest.fn(async () => ({
      user: 'untrusted-provider-subject',
      identityToken: 'apple-id-token',
      authorizationCode: 'one-use-code',
      givenName: 'Pat',
    })),
  };
  mockGoogleSignin.hasPreviousSignIn.mockReturnValue(false);
  mockGoogleSignin.signInSilently.mockResolvedValue({
    type: 'noSavedCredentialFound',
    data: null,
  });
  mockGoogleSignin.signOut.mockResolvedValue(null);
  mockGoogleSignin.revokeAccess.mockResolvedValue(null);
  installRoutes({});
});

afterEach(async () => {
  stopSessionKeeper();
  clearApiSession();
  clearAccessStoreConfiguration();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  jest.restoreAllMocks();
  await useAuthStore.getState().signOut();
  closeSqliteTestDatabases();
  jest.useRealTimers();
  nativeModules.PickleAuth = originalNativeAuth;
  nativeModules.PickleVideoCapture = originalNativeCapture;
  globalThis.fetch = originalFetch;
});

describe('ADV-M01 delete only the intended owner', () => {
  it('purges every owner-scoped row and kv entry of A while B, a look-alike owner and device-level kv survive', async () => {
    await signInAsA();
    for (const owner of [OWNER_A, OWNER_B, OWNER_A_LOOKALIKE]) seedOwner(owner);
    for (const [key, value] of Object.entries(DEVICE_KV)) {
      await setKv(mockDatabase.db, key, value);
    }
    const before = {
      b: ownerFootprint(OWNER_B),
      lookalike: ownerFootprint(OWNER_A_LOOKALIKE),
    };
    expect(ownerFootprint(OWNER_A).tables).toEqual({
      local_shot: 1,
      local_session: 1,
      local_capture: 2,
      local_analysis_record: 1,
      outbox: 1,
      sync_receipt: 1,
    });

    const context = captureAccountDeletionContext();
    const cleanup = await useAuthStore
      .getState()
      .completeAccountDeletion(context);

    expect(cleanup).toEqual({ localPurge: 'complete' });
    expect(ownerFootprint(OWNER_A)).toEqual({
      tables: {
        local_shot: 0,
        local_session: 0,
        local_capture: 0,
        local_analysis_record: 0,
        outbox: 0,
        sync_receipt: 0,
      },
      kv: [],
    });
    expect(ownerFootprint(OWNER_B)).toEqual(before.b);
    expect(ownerFootprint(OWNER_A_LOOKALIKE)).toEqual(before.lookalike);
    expect(before.b.kv).toHaveLength(OWNER_SCOPED_KV_NAMESPACES.length);
    for (const [key, value] of Object.entries(DEVICE_KV)) {
      expect(await getKv(mockDatabase.db, key)).toBe(value);
    }
    expect(useAuthStore.getState().session).toBeNull();
    // Every DELETE the purge issued was bound to A, never a pattern or a
    // whole-table statement.
    const deletes = mockDatabase.calls.filter(call =>
      call.sql.trimStart().toUpperCase().startsWith('DELETE'),
    );
    expect(deletes.length).toBeGreaterThan(0);
    for (const call of deletes) {
      expect(call.sql).not.toMatch(/LIKE/i);
      expect(call.sql).toMatch(/WHERE/i);
      expect(String(call.params[0])).toMatch(
        call.sql.includes('FROM kv') ? new RegExp(`:${OWNER_A}$`) : /^.+$/,
      );
      if (!call.sql.includes('FROM kv')) expect(call.params[0]).toBe(OWNER_A);
    }
  });
});

describe('ADV-M02 managed media of the deleted owner', () => {
  it('hands every capture, poster and pose-sidecar file of the purged rows to a native removal path', async () => {
    await signInAsA();
    seedOwner(OWNER_A);
    seedOwner(OWNER_B);
    const nativeCalls: Array<{ method: string; args: unknown[] }> = [];
    const recorder = <T extends object>(target: T) =>
      new Proxy(target, {
        get(base, property) {
          const value = Reflect.get(base, property);
          if (typeof property === 'symbol') return value;
          if (typeof value === 'function') {
            return (...args: unknown[]) => {
              nativeCalls.push({ method: property, args });
              return Reflect.apply(value, base, args);
            };
          }
          return (...args: unknown[]) => {
            nativeCalls.push({ method: property, args });
            return Promise.resolve(undefined);
          };
        },
        has: () => true,
      });
    nativeModules.PickleVideoCapture = recorder({
      capture: async () => undefined,
      importVideo: async () => undefined,
      cancel: () => undefined,
      addListener: () => undefined,
      removeListeners: () => undefined,
    });
    const filesOfA = mockDatabase.native
      .prepare('SELECT uri, payload FROM local_capture WHERE owner_key = ?')
      .all(OWNER_A)
      .flatMap(row => {
        const payload = JSON.parse(String(row.payload)) as {
          poster: { uri: string };
          poseSequence: { uri: string };
        };
        return [String(row.uri), payload.poster.uri, payload.poseSequence.uri];
      });
    expect(filesOfA).toHaveLength(6);

    const cleanup = await useAuthStore
      .getState()
      .completeAccountDeletion(captureAccountDeletionContext());

    expect(cleanup).toEqual({ localPurge: 'complete' });
    expect(mockDatabase.count('local_capture', OWNER_A)).toBe(0);
    expect(mockDatabase.count('local_capture', OWNER_B)).toBe(2);
    const serialized = JSON.stringify(nativeCalls);
    // The rows are gone, so nothing can ever find these files again: each
    // must have been passed to the native layer for deletion before the row
    // purge committed. B's files must never appear.
    for (const uri of filesOfA) expect(serialized).toContain(uri);
    expect(serialized).not.toContain(captureUri(OWNER_B, 1));
  });
});

describe('ADV-M03 purge failure is atomic, reported, and retryable', () => {
  it('a failing DELETE leaves A fully intact (no half purge), reports failed, and a retry completes without touching B', async () => {
    await signInAsA();
    seedOwner(OWNER_A);
    seedOwner(OWNER_B);
    const beforeA = ownerFootprint(OWNER_A);
    const beforeB = ownerFootprint(OWNER_B);
    // A persistent storage fault on one owner table, raised by SQLite itself
    // so the driver's transaction path (not a JS spy) sees it every attempt.
    mockDatabase.native.exec(
      "CREATE TRIGGER adv_outbox_fault BEFORE DELETE ON outbox BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END",
    );
    let failures = 0;
    mockDatabase.observeStatements(call => {
      if (call.sql === 'ROLLBACK') failures += 1;
    });
    const context = captureAccountDeletionContext();

    const failed = await useAuthStore
      .getState()
      .completeAccountDeletion(context);

    expect(failed).toEqual({ localPurge: 'failed' });
    expect(failures).toBeGreaterThanOrEqual(3);
    expect(ownerFootprint(OWNER_A)).toEqual(beforeA);
    expect(ownerFootprint(OWNER_B)).toEqual(beforeB);
    expect(useAuthStore.getState().session).toBeNull();

    mockDatabase.observeStatements(null);
    mockDatabase.native.exec('DROP TRIGGER adv_outbox_fault');
    const retried = await useAuthStore
      .getState()
      .completeAccountDeletion(context);

    expect(retried).toEqual({ localPurge: 'complete' });
    expect(ownerFootprint(OWNER_A)).toEqual({
      tables: {
        local_shot: 0,
        local_session: 0,
        local_capture: 0,
        local_analysis_record: 0,
        outbox: 0,
        sync_receipt: 0,
      },
      kv: [],
    });
    expect(ownerFootprint(OWNER_B)).toEqual(beforeB);
  });
});
