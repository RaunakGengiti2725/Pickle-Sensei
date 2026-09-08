/**
 * ATTACK AREA: deletion -> relaunch -> re-sign-in, with a real migrated SQLite
 * database behind the auth store (not a kv Map), under: double-tapped
 * completion, persistently failing local purge, and relaunch after deletion.
 *
 * Invariants under attack (AGENTS.md "Auth sessions", program invariants):
 *  - a confirmed deletion leaves NO local rows for the deleted owner (history,
 *    outbox, receipts, journal, pending purchase, profile);
 *  - the next launch must not try to refresh a deleted account;
 *  - a failed local purge is reported as failed, never as complete (unknown or
 *    corrupt state never becomes "successful deletion");
 *  - a fresh account signed in afterwards starts with an empty history and is
 *    never blocked by the previous account's deletion tombstone;
 *  - double-tapping the completion never crashes, never leaves the store
 *    busy forever, and never resurrects the deleted owner.
 */
import { NativeModules } from 'react-native';
import {
  captureAccountDeletionContext,
  useAuthStore,
} from '../../src/auth/authStore';
import { clearApiSession, getApiSession } from '../../src/account/apiSession';
import { SESSION_VAULT_SERVICE } from '../../src/account/sessionVault';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import { stopBillingLifecycle } from '../../src/billing/lifecycle';
import { pendingFulfilmentKeyForOwner } from '../../src/billing/pendingFulfilment';
import { useAppStore } from '../../src/state/appStore';
import {
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  profileKeyForOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { listShots } from '../../src/data/repository';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import {
  advFixture,
  advOpenDb,
  advRows,
  advSeedCapture,
  type AdvStore,
} from '../../testSupport/advJourneyHarness';
import { closeSqliteTestDatabases } from '../../testSupport/sqlite';
import * as Keychain from 'react-native-keychain';

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

let mockStore: AdvStore | null = null;
jest.mock('../../src/data/db', () => ({
  getDb: () => {
    if (!mockStore) throw new Error('database not open');
    return mockStore.db;
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

const DELETED = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const SUCCESSOR = '8ad3d854-139a-4fd7-a53d-b95619a4cf49';
const FAR_FUTURE_SECONDS = Math.floor(Date.now() / 1000) + 3600;

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}
const bootstrapBody = (
  id: string,
  tokens: { access: string; refresh: string },
) => ({
  user: { id, email: 'pat@example.com' },
  onboardingState: 'complete',
  session: {
    accessToken: tokens.access,
    refreshToken: tokens.refresh,
    expiresAt: FAR_FUTURE_SECONDS,
  },
});
const refreshBody = (tokens: { access: string; refresh: string }) => ({
  session: {
    accessToken: tokens.access,
    refreshToken: tokens.refresh,
    expiresAt: FAR_FUTURE_SECONDS,
  },
});
function installRoutes(
  routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>,
): jest.Mock {
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    for (const [suffix, handler] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return handler(init);
    }
    throw new Error(`network down (${url})`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}
function calls(fetchMock: jest.Mock, suffix: string) {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith(suffix));
}
function vaultRecord(): Record<string, unknown> | null {
  const item = __keychainStore.get(SESSION_VAULT_SERVICE);
  return item ? (JSON.parse(item.password) as Record<string, unknown>) : null;
}
function seedVault(owner: string, refreshToken: string) {
  __keychainStore.set(SESSION_VAULT_SERVICE, {
    username: 'session',
    password: JSON.stringify({
      version: 1,
      provider: 'apple',
      canonicalAppUserId: owner,
      refreshToken,
      email: 'pat@example.com',
      displayName: 'Pat Player',
    }),
  });
}
function kvKeysFor(store: AdvStore, owner: string): string[] {
  return store.native
    .prepare('SELECT key FROM kv WHERE key LIKE ?')
    .all(`%:${owner}`)
    .map(row => String(row.key));
}

/** Everything a real session leaves behind for `owner`. */
function seedOwnerFootprint(store: AdvStore, owner: string) {
  advSeedCapture(store, owner, 'cap-1', advFixture(`cap-${owner}`).clip);
  store.native
    .prepare(
      `INSERT INTO local_shot (owner_key, id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, payload)
       VALUES (?, 'shot-1', NULL, 'forehand_drive', '2026-09-06T12:00:00.000Z', 71, 0.9, 'scored', 'real', '{}')`,
    )
    .run(owner);
  store.native
    .prepare(
      `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', '{"id":"shot-1"}')`,
    )
    .run(owner);
  store.native
    .prepare(
      `INSERT INTO sync_receipt (owner_key, kind, entity_id) VALUES (?, 'shot.sync', 'shot-0')`,
    )
    .run(owner);
  const kv = store.native.prepare('INSERT INTO kv(key, value) VALUES(?, ?)');
  kv.run(profileKeyForOwner(owner), JSON.stringify({ displayName: 'Pat' }));
  kv.run(`practice.set:${owner}`, '{"shots":["shot-1"]}');
  kv.run(
    pendingFulfilmentKeyForOwner(owner),
    JSON.stringify({
      schemaVersion: 2,
      id: '33333333-3333-4333-8333-333333333333',
      owner,
      source: 'purchase',
      state: 'pending',
      completedAtMs: 1_756_684_800_000,
      attempts: 1,
      lastAttemptAtMs: 1_756_684_801_000,
      transaction: {
        productId: 'pickle_sensei_pro_annual',
        transactionId: '2000000000000009',
        purchasedAt: '2026-09-01T00:00:00.000Z',
      },
    }),
  );
}
function footprint(store: AdvStore, owner: string) {
  return {
    captures: advRows(store, 'local_capture', owner).length,
    shots: advRows(store, 'local_shot', owner).length,
    outbox: advRows(store, 'outbox', owner).length,
    receipts: advRows(store, 'sync_receipt', owner).length,
    kv: kvKeysFor(store, owner).length,
  };
}
const EMPTY = { captures: 0, shots: 0, outbox: 0, receipts: 0, kv: 0 };
const FULL = { captures: 1, shots: 1, outbox: 1, receipts: 1, kv: 3 };

async function launchSignedIn(fetchMock: jest.Mock, owner: string) {
  seedVault(owner, `refresh-${owner.slice(0, 4)}`);
  await useAuthStore.getState().hydrate();
  expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(owner);
  expect(getActiveDataOwner()).toBe(owner);
  expect(calls(fetchMock, '/v1/auth/refresh')).toHaveLength(1);
}

const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  __keychainStore.clear();
  stopBillingLifecycle();
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  mockStore = advOpenDb();
  useAuthStore.setState({
    hydrated: false,
    session: null,
    busy: false,
    error: null,
    deletionCleanup: null,
  });
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    ownerContext: null,
    awaitingApiSession: false,
    profile: null,
    hydrateError: null,
  });
  mockGoogleSignin.hasPreviousSignIn.mockReturnValue(false);
  mockGoogleSignin.signInSilently.mockResolvedValue({
    type: 'noSavedCredentialFound',
    data: null,
  });
  mockGoogleSignin.hasPlayServices.mockResolvedValue(true);
  mockGoogleSignin.signOut.mockResolvedValue(null);
  mockGoogleSignin.revokeAccess.mockResolvedValue(null);
  nativeModules.PickleAuth = {
    signInWithApple: jest.fn().mockResolvedValue({
      user: 'apple-user-opaque',
      identityToken: 'apple-identity-token',
      authorizationCode: 'one-use-apple-code',
      email: 'pat@privaterelay.example',
      givenName: 'Pat',
      familyName: 'Player',
    }),
  };
  installRoutes({});
});
afterEach(async () => {
  jest.useRealTimers();
  stopBillingLifecycle();
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  delete nativeModules.PickleAuth;
  globalThis.fetch = realFetch;
  // Background persistence started by sign-in may still be draining.
  for (let attempt = 0; ; attempt += 1) {
    try {
      closeSqliteTestDatabases();
      break;
    } catch (error) {
      if (attempt >= 100) throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  mockStore = null;
});

describe('deletion -> relaunch -> re-sign-in', () => {
  it('deletes every local trace of the deleted owner, refuses to refresh it on relaunch, and a successor account signs in to an EMPTY history', async () => {
    const store = mockStore!;
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-1', refresh: 'refresh-2' })),
      '/v1/account/bootstrap': () =>
        response(
          bootstrapBody(SUCCESSOR, {
            access: 'access-s',
            refresh: 'refresh-s',
          }),
        ),
    });
    await launchSignedIn(fetchMock, DELETED);
    seedOwnerFootprint(store, DELETED);
    expect(footprint(store, DELETED)).toEqual(FULL);

    // Server confirmed the deletion (ManageAccountScreen.onDeleted).
    await useAuthStore.getState().completeAccountDeletion();

    const afterDeletion = useAuthStore.getState();
    expect(afterDeletion.session).toBeNull();
    expect(afterDeletion.busy).toBe(false);
    expect(afterDeletion.deletionCleanup).toEqual({ localPurge: 'complete' });
    expect(afterDeletion.restoreState).toEqual({
      status: 'signed_out',
      reason: 'account_deleted',
    });
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(getApiSession()).toBeNull();
    expect(vaultRecord()).toBeNull();
    expect(footprint(store, DELETED)).toEqual(EMPTY);

    // Relaunch: nothing to restore, and the dead account is never refreshed.
    useAuthStore.setState({ hydrated: false });
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().restoreState).toEqual({
      status: 'signed_out',
      reason: 'account_deleted',
    });
    expect(calls(fetchMock, '/v1/auth/refresh')).toHaveLength(1);
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);

    // Re-sign-in with the same Apple ID: the backend issues a NEW account.
    await useAuthStore.getState().signInWithApple();
    const signedIn = useAuthStore.getState();
    expect(signedIn.error).toBeNull();
    expect(signedIn.session?.canonicalAppUserId).toBe(SUCCESSOR);
    expect(getActiveDataOwner()).toBe(SUCCESSOR);
    expect(vaultRecord()).toMatchObject({
      canonicalAppUserId: SUCCESSOR,
      refreshToken: 'refresh-s',
    });
    expect(await listShots(store.db)).toEqual([]);
    expect(footprint(store, SUCCESSOR)).toEqual(EMPTY);
    expect(footprint(store, DELETED)).toEqual(EMPTY);

    // Relaunch as the successor: the deletion tombstone must not block it.
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    useAuthStore.setState({ hydrated: false, session: null });
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(SUCCESSOR);
    expect(getActiveDataOwner()).toBe(SUCCESSOR);
    expect(calls(fetchMock, '/v1/auth/refresh')).toHaveLength(2);
  });

  it('a persistently failing local purge is reported as FAILED (never complete), signs the account out anyway, and never leaks the leftovers to the successor', async () => {
    const store = mockStore!;
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-1', refresh: 'refresh-2' })),
      '/v1/account/bootstrap': () =>
        response(
          bootstrapBody(SUCCESSOR, {
            access: 'access-s',
            refresh: 'refresh-s',
          }),
        ),
    });
    await launchSignedIn(fetchMock, DELETED);
    seedOwnerFootprint(store, DELETED);
    // Persistent storage fault on one owner-scoped table: every purge attempt
    // fails inside its transaction.
    store.native.exec(
      `CREATE TRIGGER adv_disk_fault BEFORE DELETE ON local_shot
       BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;`,
    );

    await useAuthStore.getState().completeAccountDeletion();

    const state = useAuthStore.getState();
    expect(state.deletionCleanup).toEqual({ localPurge: 'failed' });
    expect(state.session).toBeNull();
    expect(state.busy).toBe(false);
    expect(vaultRecord()).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    // Transactional: the failed purge changed nothing (no half-deleted owner).
    expect(footprint(store, DELETED)).toEqual(FULL);

    // The successor signs in: none of the leftovers are theirs.
    await useAuthStore.getState().signInWithApple();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(SUCCESSOR);
    expect(await listShots(store.db)).toEqual([]);
    expect(footprint(store, SUCCESSOR)).toEqual(EMPTY);
    // And the relaunch never tries to refresh the deleted account.
    expect(calls(fetchMock, '/v1/auth/refresh')).toHaveLength(1);
  });

  it('double-tapping completion (ManageAccountScreen path, captured context) never throws, never leaves the store busy, and purges exactly the deleted owner', async () => {
    const store = mockStore!;
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-1', refresh: 'refresh-2' })),
    });
    await launchSignedIn(fetchMock, DELETED);
    seedOwnerFootprint(store, DELETED);
    // A bystander owner's rows on the same phone must survive.
    seedOwnerFootprint(store, SUCCESSOR);
    const context = captureAccountDeletionContext();

    const outcome = await Promise.all([
      useAuthStore.getState().completeAccountDeletion(context),
      useAuthStore.getState().completeAccountDeletion(context),
    ]);
    expect(outcome).toEqual([
      { localPurge: 'complete' },
      { localPurge: 'complete' },
    ]);

    const state = useAuthStore.getState();
    expect(state.session).toBeNull();
    expect(state.busy).toBe(false);
    expect(state.error).toBeNull();
    expect(state.deletionCleanup).toEqual({ localPurge: 'complete' });
    expect(state.restoreState).toEqual({
      status: 'signed_out',
      reason: 'account_deleted',
    });
    expect(vaultRecord()).toBeNull();
    expect(footprint(store, DELETED)).toEqual(EMPTY);
    expect(footprint(store, SUCCESSOR)).toEqual(FULL);
    expect(
      store.calls.filter(
        call =>
          call.sql.startsWith('DELETE FROM local_shot') &&
          call.params[0] === SUCCESSOR,
      ),
    ).toHaveLength(0);

    useAuthStore.setState({ hydrated: false });
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session).toBeNull();
    expect(calls(fetchMock, '/v1/auth/refresh')).toHaveLength(1);
  });

  it('double-tapped completion with a failing purge reports FAILED on both taps and in the store — never "not_needed" or "complete"', async () => {
    const store = mockStore!;
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-1', refresh: 'refresh-2' })),
    });
    await launchSignedIn(fetchMock, DELETED);
    seedOwnerFootprint(store, DELETED);
    store.native.exec(
      `CREATE TRIGGER adv_disk_fault BEFORE DELETE ON local_shot
       BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;`,
    );
    const context = captureAccountDeletionContext();

    const outcome = await Promise.all([
      useAuthStore.getState().completeAccountDeletion(context),
      useAuthStore.getState().completeAccountDeletion(context),
    ]);
    expect(outcome).toEqual([
      { localPurge: 'failed' },
      { localPurge: 'failed' },
    ]);
    const state = useAuthStore.getState();
    expect(state.deletionCleanup).toEqual({ localPurge: 'failed' });
    expect(state.session).toBeNull();
    expect(state.busy).toBe(false);
    expect(vaultRecord()).toBeNull();
    expect(footprint(store, DELETED)).toEqual(FULL);
  });

  it('deletion completed while the refresh that launched the session is still in flight: the late credential is discarded', async () => {
    const store = mockStore!;
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
    let releaseRefresh!: (value: Response) => void;
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        new Promise<Response>(resolve => {
          releaseRefresh = resolve;
        }),
    });
    seedVault(DELETED, 'refresh-1');
    const hydrate = useAuthStore.getState().hydrate();
    await jest.advanceTimersByTimeAsync(8_000);
    await hydrate;
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(DELETED);
    seedOwnerFootprint(store, DELETED);

    await useAuthStore.getState().completeAccountDeletion();
    expect(useAuthStore.getState().session).toBeNull();
    expect(footprint(store, DELETED)).toEqual(EMPTY);
    expect(vaultRecord()).toBeNull();

    releaseRefresh(
      response(refreshBody({ access: 'late-access', refresh: 'late-refresh' })),
    );
    for (let turn = 0; turn < 100; turn += 1) await Promise.resolve();
    await jest.advanceTimersByTimeAsync(1_000);

    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(vaultRecord()).toBeNull();
    expect(useAuthStore.getState().restoreState).toEqual({
      status: 'signed_out',
      reason: 'account_deleted',
    });
    useAuthStore.setState({ hydrated: false });
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session).toBeNull();
    expect(calls(fetchMock, '/v1/auth/refresh')).toHaveLength(1);
  });
});
