/**
 * xc-journey-account-switch — the USER journey through the real authStore:
 * sign out → sign in as another account on the same device.
 *
 * Everything below the store is real: production `getDb()` migrations on a
 * real SQLite engine, the real Keychain-vault module over the in-memory
 * Keychain mock, the real ApiSession / sessionKeeper / syncRuntime /
 * accessStore / trainingStore / appStore / notification / consistency /
 * rank stores. Only the network is faked — by a server that answers strictly
 * by bearer and logs which identity every request was made AS.
 *
 * Journey (jest runs the `it`s in order, sharing the device state):
 *   A signs in (Apple) and fills every store → A signs out: every store is
 *   empty/fail-closed, A's tokens are gone from device + revoked server-side
 *   → B signs in (Google): every store shows B's data and none of A's; the
 *   device never speaks to the server as A again → late A callbacks (refresh,
 *   access, onboarding save, outbox drain, 401) land AFTER the switch and
 *   cannot touch B → B revoked elsewhere → A back → relaunch restores only
 *   the last signed-in account → guest bucket ↔ account isolation →
 *   deleting A leaves B's local data intact → raw evidence to disk.
 */
import { NativeModules } from 'react-native';
import { useAuthStore } from '../../src/auth/authStore';
import {
  bearerTokenFor,
  clearApiSession,
  getApiSession,
  reportApiUnauthorized,
} from '../../src/account/apiSession';
import {
  SESSION_VAULT_SERVICE,
  loadPersistedSession,
} from '../../src/account/sessionVault';
import {
  refreshSessionNow,
  stopSessionKeeper,
} from '../../src/account/sessionKeeper';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  profileKeyForOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { getDb } from '../../src/data/db';
import {
  getAnalysis,
  getKv,
  getShotOutboxStatus,
  hasShotSyncReceipt,
  listShots,
  saveAnalysis,
} from '../../src/data/repository';
import {
  clearSyncRuntime,
  triggerOutboxSync,
} from '../../src/data/syncRuntime';
import {
  clearAccessStoreConfiguration,
  useAccessStore,
} from '../../src/state/accessStore';
import {
  clearTrainingStoreConfiguration,
  useTrainingStore,
} from '../../src/training/store';
import { useAppStore } from '../../src/state/appStore';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import {
  DEFAULT_NOTIFICATION_PREFS,
  notificationPrefsKeyForOwner,
} from '../../src/notifications/types';
import type {
  PermissionState,
  SchedulerPort,
} from '../../src/notifications/service';
import type { PlannedNotification } from '../../src/notifications/types';
import { useConsistencyStore } from '../../src/consistency/store';
import {
  rankCelebrationKeyForOwner,
  useRankCelebrationStore,
} from '../../src/progress/rankCelebration';
import * as Keychain from 'react-native-keychain';
import {
  IDENTITY_A,
  IDENTITY_B,
  OWNER_A,
  OWNER_B,
  PERMIT_A,
  PERMIT_B,
  RANK_GOLD,
  RANK_SILVER,
  buildAnalysis,
  buildProfile,
  heapNumbers,
  ownerSnapshot,
  ownershipMatrix,
  writeEvidence,
} from '../../testing/xc-account-switch/fixtures';
import {
  openRealSqlite,
  type RealSqliteHandle,
} from '../../testing/xc-account-switch/realSqlite';
import { FakeAccountServer } from '../../testing/xc-account-switch/fakeServer';

// ─── Seams ───────────────────────────────────────────────────────────────────

let mockHandle: RealSqliteHandle | null = null;
jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    if (!mockHandle) throw new Error('real sqlite handle not opened');
    return mockHandle;
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

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

class FakeScheduler implements SchedulerPort {
  permission: PermissionState = 'granted';
  appliedPlans: PlannedNotification[][] = [];
  cancelAllCalls = 0;
  async permissionState(): Promise<PermissionState> {
    return this.permission;
  }
  async requestPermission(): Promise<PermissionState> {
    return this.permission;
  }
  async applyPlan(plan: readonly PlannedNotification[]): Promise<void> {
    this.appliedPlans.push([...plan]);
  }
  async cancelAllPlanned(): Promise<void> {
    this.cancelAllCalls += 1;
  }
  async openSystemSettings(): Promise<void> {}
}

const scheduler = new FakeScheduler();
const notificationDeps = () => ({
  scheduler,
  loadContext: async () => ({
    nowMs: new Date(2026, 7, 27, 10, 0, 0).getTime(),
    streakDays: 1,
    practicedToday: false,
    hasAnyHistory: true,
  }),
});

const nativeModules = NativeModules as { PickleAuth?: unknown };
const server = new FakeAccountServer();
let realFetch: typeof fetch;

const SHOT_SHARED = 'shot-journey-0001';
const SHOT_A_LATE = 'shot-journey-late-A';
const SHOT_B_ONLY = 'shot-journey-B-only';
const SHOT_GUEST = 'shot-journey-guest';

const evidence: {
  engine: string | null;
  steps: Array<{ step: string; detail?: unknown }>;
  storeMatrix: Record<string, Record<string, unknown>>;
  serverLog: unknown[];
  matrices: Record<string, unknown>;
  heap: Record<string, unknown>;
} = {
  engine: null,
  steps: [],
  storeMatrix: {},
  serverLog: [],
  matrices: {},
  heap: {},
};

function handle(): RealSqliteHandle {
  if (!mockHandle) throw new Error('handle missing');
  return mockHandle;
}

function step(name: string, detail?: unknown): void {
  evidence.steps.push({ step: name, detail });
}

/** Lets every queued microtask/immediate settle (the runtimes chain awaits). */
async function flush(rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  rounds = 200,
): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    if (await predicate()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function vaultRecord(): Record<string, unknown> | null {
  const item = __keychainStore.get(SESSION_VAULT_SERVICE);
  return item ? (JSON.parse(item.password) as Record<string, unknown>) : null;
}

/** Everything the UI would read after a switch, captured in one object. */
async function storeMatrix(label: string): Promise<Record<string, unknown>> {
  const db = getDb();
  const owner = getActiveDataOwner();
  const shots = await listShots(db);
  const access = useAccessStore.getState();
  const training = useTrainingStore.getState();
  const app = useAppStore.getState();
  const notif = useNotificationStore.getState();
  const consistency = useConsistencyStore.getState();
  const rank = useRankCelebrationStore.getState();
  const api = getApiSession();
  const out = {
    activeOwner: owner,
    authSession: useAuthStore.getState().session
      ? {
          provider: useAuthStore.getState().session?.provider,
          canonicalAppUserId:
            useAuthStore.getState().session?.canonicalAppUserId,
          localOnly: useAuthStore.getState().session?.localOnly,
        }
      : null,
    apiSessionOwner: api?.canonicalAppUserId ?? null,
    bearerForA: bearerTokenFor(IDENTITY_A.canonicalAppUserId) !== null,
    bearerForB: bearerTokenFor(IDENTITY_B.canonicalAppUserId) !== null,
    vaultOwner: vaultRecord()?.['canonicalAppUserId'] ?? null,
    shotIds: shots.map(s => s.id),
    shotScores: shots.map(s => s.overallScore),
    accessStatus: access.status,
    accessPremium: access.canonicalAccess?.premium ?? null,
    accessUsed: access.canonicalAccess?.freeRatings.used ?? null,
    trainingSavedSlugs: training.savedDrills.map(d => d.slug),
    trainingStatus: training.savedStatus,
    profileOwner: app.ownerKey,
    profileFirstName: app.profile?.firstName ?? null,
    notificationOwner: notif.ownerKey,
    notificationEnabled: notif.prefs.enabled,
    consistencyOwner: consistency.ownerKey,
    consistencySnapshotPresent: consistency.snapshot !== null,
    rankCurrent: rank.current?.toTier ?? null,
  };
  evidence.storeMatrix[label] = out;
  return out;
}

function serverRequestsAs(label: 'A' | 'B', fromSeq: number): number {
  return server.log.filter(r => r.seq > fromSeq && r.as === label).length;
}

function lastSeq(): number {
  return server.log[server.log.length - 1]?.seq ?? 0;
}

async function hydrateEverything(): Promise<void> {
  await useAppStore.getState().hydrate();
  await useNotificationStore.getState().hydrate(notificationDeps());
  await useConsistencyStore.getState().hydrate();
}

/** In-memory process death: every store forgets, Keychain + SQLite survive. */
function simulateRelaunch(): void {
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  clearAccessStoreConfiguration();
  clearTrainingStoreConfiguration();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    hydrated: false,
    session: null,
    busy: false,
    error: null,
    deletionCleanup: null,
  });
  useAppStore.setState({ hydrated: false, ownerKey: null, profile: null });
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
  });
  useConsistencyStore.setState({
    hydrated: false,
    ownerKey: null,
    snapshot: null,
  });
  useRankCelebrationStore.setState({ current: null, pending: null });
}

async function signInA(): Promise<void> {
  await useAuthStore.getState().signInWithApple();
  expect(useAuthStore.getState().error).toBeNull();
  expect(getActiveDataOwner()).toBe(OWNER_A);
}

async function signInB(): Promise<void> {
  await useAuthStore.getState().signInWithGoogle();
  expect(useAuthStore.getState().error).toBeNull();
  expect(getActiveDataOwner()).toBe(OWNER_B);
}

async function outboxDrained(shotId: string): Promise<boolean> {
  return (await getShotOutboxStatus(getDb(), shotId)).state === 'absent';
}

beforeAll(() => {
  mockHandle = openRealSqlite();
  evidence.engine = mockHandle.engine;
  evidence.heap['start'] = heapNumbers();
  realFetch = server.install();
  nativeModules.PickleAuth = {
    signInWithApple: jest.fn().mockResolvedValue({
      user: 'apple-user-opaque',
      identityToken: 'apple-identity-token',
      authorizationCode: 'one-use-apple-code',
      email: IDENTITY_A.email,
      givenName: 'Ada',
      familyName: 'Alpha',
    }),
  };
  mockGoogleSignin.hasPlayServices.mockResolvedValue(true);
  mockGoogleSignin.signOut.mockResolvedValue(null);
  mockGoogleSignin.revokeAccess.mockResolvedValue(null);
  mockGoogleSignin.hasPreviousSignIn.mockReturnValue(false);
  mockGoogleSignin.signIn.mockResolvedValue({
    type: 'success',
    data: {
      user: {
        id: 'google-uid-b',
        name: IDENTITY_B.displayName,
        email: IDENTITY_B.email,
      },
      idToken: 'google-id-token',
    },
  });
  __keychainStore.clear();
  simulateRelaunch();
});

afterAll(() => {
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  clearAccessStoreConfiguration();
  clearTrainingStoreConfiguration();
  delete nativeModules.PickleAuth;
  globalThis.fetch = realFetch;
  evidence.heap['end'] = heapNumbers();
  evidence.serverLog = server.log;
  evidence.matrices['final'] = ownershipMatrix(handle());
  const path = writeEvidence('auth-journey.json', evidence);
  console.log(`[xc] auth journey evidence → ${path}`);
  try {
    getDb().close();
  } catch {
    // best effort
  }
  mockHandle?.close();
});

describe('xc account switch — authStore journey A → signed out → B on one device', () => {
  it('A signs in with Apple and fills every account-bound store + a synced shot', async () => {
    await signInA();
    expect(getApiSession()?.canonicalAppUserId).toBe(
      IDENTITY_A.canonicalAppUserId,
    );
    expect(bearerTokenFor(IDENTITY_B.canonicalAppUserId)).toBeNull();
    expect(vaultRecord()).toMatchObject({
      provider: 'apple',
      canonicalAppUserId: IDENTITY_A.canonicalAppUserId,
    });

    await saveAnalysis(
      getDb(),
      buildAnalysis({
        id: SHOT_SHARED,
        overallScore: 8.1,
        capturedAtIso: '2026-08-27T18:00:00.000Z',
      }),
      PERMIT_A,
    );
    triggerOutboxSync();
    await waitFor(() => outboxDrained(SHOT_SHARED), 'A outbox drain');
    expect(await hasShotSyncReceipt(getDb(), SHOT_SHARED)).toBe(true);
    expect(server.account('A').receivedShotIds).toEqual([SHOT_SHARED]);
    expect(server.account('B').receivedShotIds).toEqual([]);

    await hydrateEverything();
    await useAccessStore.getState().refreshAccess();
    await useTrainingStore.getState().loadSavedDrills();
    await useNotificationStore
      .getState()
      .setPrefs({ enabled: true }, notificationDeps());
    await useRankCelebrationStore.getState().maybeCelebrate(RANK_GOLD);

    const matrix = await storeMatrix('A signed in');
    expect(matrix).toMatchObject({
      activeOwner: OWNER_A,
      apiSessionOwner: IDENTITY_A.canonicalAppUserId,
      bearerForA: true,
      bearerForB: false,
      vaultOwner: IDENTITY_A.canonicalAppUserId,
      shotIds: [SHOT_SHARED],
      accessStatus: 'ready',
      accessPremium: true,
      accessUsed: 2,
      trainingSavedSlugs: ['drill-a'],
      profileOwner: OWNER_A,
      profileFirstName: 'Ada',
      notificationOwner: OWNER_A,
      notificationEnabled: true,
      consistencyOwner: OWNER_A,
    });
    // The canonical profile was persisted under A's key only.
    expect(await getKv(getDb(), profileKeyForOwner(OWNER_A))).toContain('Ada');
    expect(await getKv(getDb(), profileKeyForOwner(OWNER_B))).toBeNull();
    expect(
      await getKv(getDb(), notificationPrefsKeyForOwner(OWNER_A)),
    ).toContain('"enabled":true');
    expect(
      await getKv(getDb(), rankCelebrationKeyForOwner(OWNER_A)),
    ).not.toBeNull();
    expect(matrix.rankCurrent).toBe('gold');
    // The ceremony is a blocking root Modal; A must dismiss it before any
    // Settings → sign-out tap is reachable (see the carry-over probe for the
    // implicit-sign-out path where nobody dismisses it).
    useRankCelebrationStore.getState().dismiss();
    step('A signed in + seeded', matrix);
  });

  it('A signs out: every store is empty or fail-closed, device holds no A token, server session revoked', async () => {
    const before = lastSeq();
    await useAuthStore.getState().signOut();
    await flush();

    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(bearerTokenFor(IDENTITY_A.canonicalAppUserId)).toBeNull();
    expect(vaultRecord()).toBeNull();
    expect(await loadPersistedSession()).toBeNull();
    expect(server.account('A').logoutCalls).toBe(1);
    expect(server.account('A').liveAccessTokens).toBe(0);

    // Runtime stores reset to fail-closed defaults synchronously.
    expect(useAccessStore.getState()).toMatchObject({
      status: 'idle',
      canonicalAccess: null,
    });
    expect(useTrainingStore.getState().savedDrills).toEqual([]);
    expect(await useAccessStore.getState().refreshAccess()).toBe(false);
    expect(useAccessStore.getState().status).toBe('unconfigured');
    expect(await useTrainingStore.getState().loadSavedDrills()).toBe(false);

    // Signed-out hydration: nothing readable, reminders cancelled.
    const cancelsBefore = scheduler.cancelAllCalls;
    await hydrateEverything();
    expect(scheduler.cancelAllCalls).toBe(cancelsBefore + 1);
    const matrix = await storeMatrix('signed out');
    expect(matrix).toMatchObject({
      activeOwner: SIGNED_OUT_DATA_OWNER,
      authSession: null,
      apiSessionOwner: null,
      bearerForA: false,
      bearerForB: false,
      vaultOwner: null,
      shotIds: [],
      accessPremium: null,
      trainingSavedSlugs: [],
      profileFirstName: null,
      notificationEnabled: DEFAULT_NOTIFICATION_PREFS.enabled,
      consistencySnapshotPresent: false,
      rankCurrent: null,
    });
    await expect(
      saveAnalysis(getDb(), buildAnalysis({ id: 'shot-signed-out' }), PERMIT_A),
    ).rejects.toThrow(
      'Sign in or continue locally before saving product data.',
    );
    // Nothing went to the server as A after sign-out (the logout itself is
    // the last request bearing A's token).
    const asA = server.log.filter(r => r.seq > before && r.as === 'A');
    expect(asA.map(r => r.path)).toEqual(['/v1/auth/logout']);
    // A's rows are still physically present — unreadable, not destroyed.
    expect(ownershipMatrix(handle())['local_shot']?.[OWNER_A]).toBe(1);
    step('A signed out', matrix);
  });

  it('B signs in with Google: every store shows only B, the device never speaks as A again', async () => {
    const before = lastSeq();
    await signInB();
    expect(getApiSession()?.canonicalAppUserId).toBe(
      IDENTITY_B.canonicalAppUserId,
    );
    expect(bearerTokenFor(IDENTITY_A.canonicalAppUserId)).toBeNull();
    expect(vaultRecord()).toMatchObject({
      provider: 'google',
      canonicalAppUserId: IDENTITY_B.canonicalAppUserId,
    });
    expect(JSON.stringify(vaultRecord())).not.toContain(
      IDENTITY_A.canonicalAppUserId,
    );

    await hydrateEverything();
    await useAccessStore.getState().refreshAccess();
    await useTrainingStore.getState().loadSavedDrills();
    const matrix = await storeMatrix('B signed in');
    expect(matrix).toMatchObject({
      activeOwner: OWNER_B,
      apiSessionOwner: IDENTITY_B.canonicalAppUserId,
      bearerForA: false,
      bearerForB: true,
      vaultOwner: IDENTITY_B.canonicalAppUserId,
      shotIds: [],
      accessStatus: 'ready',
      accessPremium: false,
      accessUsed: 1,
      trainingSavedSlugs: ['drill-b'],
      profileOwner: OWNER_B,
      profileFirstName: 'Bo',
      notificationOwner: OWNER_B,
      notificationEnabled: DEFAULT_NOTIFICATION_PREFS.enabled,
      consistencyOwner: OWNER_B,
      rankCurrent: null,
    });
    expect(await getAnalysis(getDb(), SHOT_SHARED)).toBeNull();
    // B's first resolved rank is a PLACEMENT (from: null) — A's gold record
    // under `rank.celebrated:A` is not B's history.
    expect(
      await getKv(getDb(), rankCelebrationKeyForOwner(OWNER_B)),
    ).toBeNull();
    await useRankCelebrationStore.getState().maybeCelebrate(RANK_SILVER);
    expect(useRankCelebrationStore.getState().current).toMatchObject({
      fromTier: null,
      toTier: 'silver',
      summary: { rating: 3.1 },
    });
    useRankCelebrationStore.getState().dismiss();
    expect(await getKv(getDb(), rankCelebrationKeyForOwner(OWNER_A))).toContain(
      '"gold"',
    );
    expect(serverRequestsAs('A', before)).toBe(0);
    expect(
      server.log.filter(r => r.seq > before && r.as === 'unknown'),
    ).toEqual([]);

    // B records the SAME shot id A had, and a B-only shot; both sync as B.
    await saveAnalysis(
      getDb(),
      buildAnalysis({
        id: SHOT_SHARED,
        overallScore: 3.3,
        capturedAtIso: '2026-08-28T09:00:00.000Z',
      }),
      PERMIT_B,
    );
    await saveAnalysis(
      getDb(),
      buildAnalysis({
        id: SHOT_B_ONLY,
        overallScore: 5.5,
        capturedAtIso: '2026-08-28T09:05:00.000Z',
      }),
      PERMIT_B,
    );
    triggerOutboxSync();
    await waitFor(() => outboxDrained(SHOT_B_ONLY), 'B outbox drain');
    expect((await getAnalysis(getDb(), SHOT_SHARED))?.overallScore).toBe(3.3);
    expect(server.account('B').receivedShotIds.sort()).toEqual(
      [SHOT_SHARED, SHOT_B_ONLY].sort(),
    );
    expect(server.account('A').receivedShotIds).toEqual([SHOT_SHARED]);
    // Physical table: two rows share the id, one per owner, both intact.
    const rows = handle()
      .dumpTable('local_shot')
      .filter(r => r['id'] === SHOT_SHARED)
      .map(r => [r['owner_key'], r['overall_score']]);
    expect(rows.sort()).toEqual([
      [OWNER_A, 8.1],
      [OWNER_B, 3.3],
    ]);
    step('B signed in + seeded', matrix);
  });

  it('late callbacks from A (refresh, access, onboarding save, outbox, 401) land after the switch and cannot touch B', async () => {
    // Back to A so its in-flight work can be armed.
    await useAuthStore.getState().signOut();
    await flush();
    await signInA();
    await hydrateEverything();
    const aBearerBefore = bearerTokenFor(IDENTITY_A.canonicalAppUserId);
    expect(aBearerBefore).not.toBeNull();

    // Arm four in-flight A operations behind server holds. The server
    // processes each immediately (state + log entry); only the replies wait.
    const armSeq = lastSeq();
    const refreshHold = server.hold('/v1/auth/refresh');
    refreshSessionNow();
    const accessHold = server.hold('/v1/me/access');
    const accessPromise = useAccessStore.getState().refreshAccess();
    const onboardingHold = server.hold('/v1/me/onboarding');
    const onboardingPromise = useAppStore
      .getState()
      .completeOnboarding(buildProfile({ firstName: 'AdaLate' }));
    const syncHold = server.hold('/v1/shots:sync');
    await saveAnalysis(
      getDb(),
      buildAnalysis({
        id: SHOT_A_LATE,
        overallScore: 9.9,
        capturedAtIso: '2026-08-29T10:00:00.000Z',
      }),
      PERMIT_A,
    );
    triggerOutboxSync();
    await waitFor(
      () =>
        server.heldCount('/v1/auth/refresh') === 1 &&
        server.heldCount('/v1/me/access') === 1 &&
        server.heldCount('/v1/me/onboarding') === 1 &&
        server.heldCount('/v1/shots:sync') === 1,
      'all four A requests parked',
    );
    const parked = server.log.filter(r => r.seq > armSeq);
    expect(parked.map(r => [r.path, r.as]).sort()).toEqual(
      [
        ['/v1/auth/refresh', 'refresh:A'],
        ['/v1/me/access', 'A'],
        ['/v1/me/onboarding', 'A'],
        ['/v1/shots:sync', 'A'],
      ].sort(),
    );
    // The server has already rotated A's session: fresh A tokens are in the
    // parked refresh reply and will land on a device that now belongs to B.
    expect(server.account('A').refreshRotations).toBe(1);

    // The switch happens while all of them are pending.
    await useAuthStore.getState().signOut();
    await flush();
    await signInB();
    // App.tsx re-hydrates every owner-scoped store on the owner change and
    // Settings refreshes access; do the same so B's state is fully formed
    // BEFORE A's stale replies land.
    await hydrateEverything();
    await useAccessStore.getState().refreshAccess();
    await useTrainingStore.getState().loadSavedDrills();
    const bBearer = bearerTokenFor(IDENTITY_B.canonicalAppUserId);
    const bVault = vaultRecord();
    const bProfileBefore = await getKv(getDb(), profileKeyForOwner(OWNER_B));
    const bSnapshotBefore = ownerSnapshot(handle(), OWNER_B);
    const bMatrixBefore = await storeMatrix('B before stale A replies');
    expect(bMatrixBefore).toMatchObject({
      accessPremium: false,
      profileFirstName: 'Bo',
      trainingSavedSlugs: ['drill-b'],
    });
    const before = lastSeq();

    // A's stale 401 (for the bearer it was using) arrives now.
    reportApiUnauthorized(String(aBearerBefore));
    // Release everything.
    refreshHold.release();
    accessHold.release();
    onboardingHold.release();
    syncHold.release();
    await Promise.all([accessPromise, onboardingPromise]);
    await flush(50);

    // Runtime: still B, with B's tokens; A's rotated tokens were dropped.
    expect(getActiveDataOwner()).toBe(OWNER_B);
    expect(getApiSession()?.canonicalAppUserId).toBe(
      IDENTITY_B.canonicalAppUserId,
    );
    expect(bearerTokenFor(IDENTITY_B.canonicalAppUserId)).toBe(bBearer);
    expect(bearerTokenFor(IDENTITY_A.canonicalAppUserId)).toBeNull();
    expect(vaultRecord()).toEqual(bVault);
    // The refresh reply for A carried fresh A tokens; none reached the device.
    expect(JSON.stringify(vaultRecord())).not.toContain('refresh-A-');
    expect(JSON.stringify([...__keychainStore.values()])).not.toMatch(
      /refresh-A-/,
    );
    // Access: A's premium=true reply was discarded; B still reads its own.
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(false);
    expect(useAccessStore.getState().canonicalAccess?.freeRatings.used).toBe(1);
    expect(useAccessStore.getState().status).toBe('ready');
    expect(useAppStore.getState().onboardingBusy).toBe(false);
    // Profile: A's late save landed under A's key, never B's, never in state.
    expect(await getKv(getDb(), profileKeyForOwner(OWNER_A))).toContain(
      'AdaLate',
    );
    expect(await getKv(getDb(), profileKeyForOwner(OWNER_B))).toBe(
      bProfileBefore,
    );
    expect(useAppStore.getState().profile?.firstName).not.toBe('AdaLate');
    // Outbox: the drain that started as A wrote A's receipt, nothing for B.
    await waitFor(async () => {
      setActiveDataOwner(OWNER_A);
      const done = await hasShotSyncReceipt(getDb(), SHOT_A_LATE);
      setActiveDataOwner(OWNER_B);
      return done;
    }, 'A late receipt');
    expect(server.account('A').receivedShotIds).toContain(SHOT_A_LATE);
    expect(server.account('B').receivedShotIds).not.toContain(SHOT_A_LATE);
    expect(ownerSnapshot(handle(), OWNER_B)).toEqual(bSnapshotBefore);
    expect(await hasShotSyncReceipt(getDb(), SHOT_A_LATE)).toBe(false);
    // The stale 401 did not trigger a refresh or a sign-out for B.
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      IDENTITY_B.canonicalAppUserId,
    );
    expect(useAuthStore.getState().error).toBeNull();
    expect(
      server.log.filter(r => r.seq > before && r.as === 'refresh:B'),
    ).toEqual([]);
    // After the switch the device made NO request as A (nor with a dead
    // token): the stale replies did not provoke retries under A's identity.
    const afterSwitch = server.log.filter(r => r.seq > before);
    expect(
      afterSwitch.filter(r => r.as === 'A' || r.as === 'refresh:A'),
    ).toEqual([]);
    expect(afterSwitch.filter(r => r.as === 'unknown')).toEqual([]);
    // Every UI-visible value B had before the stale replies is unchanged.
    const bMatrixAfter = await storeMatrix('B after stale A replies');
    expect(bMatrixAfter).toEqual(bMatrixBefore);
    step('late A callbacks after switch', {
      parked,
      afterSwitch,
      bBearerStable: bearerTokenFor(IDENTITY_B.canonicalAppUserId) === bBearer,
    });
  });

  it('B revoked elsewhere → implicit sign-out; A signs in and sees only A', async () => {
    server.revokeRefresh('B');
    refreshSessionNow();
    await waitFor(
      () => useAuthStore.getState().session === null,
      'revoked sign-out',
    );
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(vaultRecord()).toBeNull();
    expect(getApiSession()).toBeNull();

    await signInA();
    const shots = await listShots(getDb());
    expect(shots.map(s => s.id).sort()).toEqual(
      [SHOT_A_LATE, SHOT_SHARED].sort(),
    );
    expect(shots.find(s => s.id === SHOT_SHARED)?.overallScore).toBe(8.1);
    expect(shots.map(s => s.id)).not.toContain(SHOT_B_ONLY);
    step('B revoked → A back', { shots: shots.map(s => s.id) });
  });

  it('relaunch restores ONLY the last signed-in account; relaunch after sign-out restores nobody', async () => {
    simulateRelaunch();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().hydrated).toBe(true);
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      IDENTITY_A.canonicalAppUserId,
    );
    expect(getActiveDataOwner()).toBe(OWNER_A);
    expect(getApiSession()?.canonicalAppUserId).toBe(
      IDENTITY_A.canonicalAppUserId,
    );
    expect((await listShots(getDb())).map(s => s.id).sort()).toEqual(
      [SHOT_A_LATE, SHOT_SHARED].sort(),
    );
    await hydrateEverything();
    expect(useAppStore.getState().profile?.firstName).toBe('AdaLate');

    await useAuthStore.getState().signOut();
    await flush();
    simulateRelaunch();
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().hydrated).toBe(true);
    expect(useAuthStore.getState().session).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(getApiSession()).toBeNull();
    expect(await listShots(getDb())).toEqual([]);
    await hydrateEverything();
    expect(useAppStore.getState().profile).toBeNull();
    // Nothing was refreshed on this relaunch: no vault → no refresh call.
    step('relaunch semantics', {
      afterSignOutRestore: useAuthStore.getState().session,
    });
  });

  it('device guest bucket and account buckets never see each other', async () => {
    await useAuthStore.getState().continueAsGuest();
    expect(getActiveDataOwner()).toBe(GUEST_DATA_OWNER);
    expect(await listShots(getDb())).toEqual([]);
    await saveAnalysis(
      getDb(),
      buildAnalysis({ id: SHOT_GUEST, overallScore: 6.0 }),
      '0c0c0c0c-3333-4333-8333-0c0c0c0c0c0c',
    );
    expect((await listShots(getDb())).map(s => s.id)).toEqual([SHOT_GUEST]);

    await signInA();
    const aShots = (await listShots(getDb())).map(s => s.id);
    expect(aShots).not.toContain(SHOT_GUEST);
    expect(aShots.sort()).toEqual([SHOT_A_LATE, SHOT_SHARED].sort());
    // Guest rows are still there, still guest-owned, never re-homed.
    expect(ownershipMatrix(handle())['local_shot']?.[GUEST_DATA_OWNER]).toBe(1);

    await useAuthStore.getState().signOut();
    await flush();
    await useAuthStore.getState().continueAsGuest();
    expect((await listShots(getDb())).map(s => s.id)).toEqual([SHOT_GUEST]);
    step('guest ↔ account isolation', { aShots });
  });

  it('deleting A purges only A; B signs in afterwards with its own data intact', async () => {
    await useAuthStore.getState().signOut();
    await flush();
    await signInA();
    const bBefore = ownerSnapshot(handle(), OWNER_B);
    const guestBefore = ownerSnapshot(handle(), GUEST_DATA_OWNER);
    await useAuthStore.getState().completeAccountDeletion();
    expect(useAuthStore.getState().deletionCleanup).toEqual({
      localPurge: 'complete',
    });
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    const matrix = ownershipMatrix(handle());
    for (const table of Object.keys(matrix)) {
      expect(matrix[table]?.[OWNER_A]).toBeUndefined();
    }
    expect(await getKv(getDb(), profileKeyForOwner(OWNER_A))).toBeNull();
    expect(ownerSnapshot(handle(), OWNER_B)).toEqual(bBefore);
    expect(ownerSnapshot(handle(), GUEST_DATA_OWNER)).toEqual(guestBefore);

    await signInB();
    const shots = await listShots(getDb());
    expect(shots.map(s => s.id).sort()).toEqual(
      [SHOT_B_ONLY, SHOT_SHARED].sort(),
    );
    expect(shots.find(s => s.id === SHOT_SHARED)?.overallScore).toBe(3.3);
    evidence.matrices['after A deletion'] = matrix;
    step('A deleted, B intact', { shots: shots.map(s => s.id) });
  });

  it('no access/refresh/provider token ever reached SQLite; the vault holds exactly one refresh token', async () => {
    const dump = JSON.stringify(
      ['kv', 'local_shot', 'local_session', 'local_capture', 'outbox'].map(t =>
        handle().dumpTable(t),
      ),
    );
    expect(dump).not.toMatch(/access-[AB]-\d+/);
    expect(dump).not.toMatch(/refresh-[AB]-\d+/);
    expect(dump).not.toContain('apple-identity-token');
    expect(dump).not.toContain('google-id-token');
    expect(dump).not.toContain('one-use-apple-code');
    const vault = vaultRecord();
    expect(vault?.['canonicalAppUserId']).toBe(IDENTITY_B.canonicalAppUserId);
    const vaultText = JSON.stringify([...__keychainStore.values()]);
    expect(vaultText.match(/refresh-[AB]-\d+/g)?.length).toBe(1);
    expect(vaultText).not.toMatch(/access-[AB]-\d+/);
    // The server log names identities, never tokens.
    expect(JSON.stringify(server.log)).not.toMatch(/(access|refresh)-[AB]-\d+/);
    step('secret hygiene', { statements: handle().statementLog.length });
  });
});
