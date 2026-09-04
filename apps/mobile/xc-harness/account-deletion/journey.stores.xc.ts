/**
 * xc-journey-settings-account-deletion — store-level execution harness.
 *
 * Real modules under test: authStore (sign-in, completeAccountDeletion,
 * hydrate), sessionVault (Keychain mock), repository + db (REAL SQLite via
 * node:sqlite behind the op-sqlite mock), appStore, notificationStore,
 * consentStore, account/deletion client, sync drain. The only doubles are
 * the network (FakeEdge, stateful, fault-injectable) and the OS scheduler.
 *
 * Every scenario writes a JSON record to XC_ARTIFACT_DIR (see helpers/artifactDir.ts) so a failure is
 * replayable from its seed + fault plan.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

jest.mock('@op-engineering/op-sqlite', () => {
  const { sqliteHandle } = jest.requireActual<
    typeof import('./helpers/sqliteSingleton')
  >('./helpers/sqliteSingleton');
  const { opSqliteFromHandle } = jest.requireActual<
    typeof import('./helpers/nodeSqlite')
  >('./helpers/nodeSqlite');
  return opSqliteFromHandle(sqliteHandle);
});

jest.mock('../../src/notifications/service', () => {
  const { scheduler } = jest.requireActual<
    typeof import('./helpers/schedulerSingleton')
  >('./helpers/schedulerSingleton');
  return {
    getScheduler: () => scheduler,
    subscribeToNotificationPresses: () => () => {},
    registerBackgroundNotificationHandler: () => {},
    screenTargetFromNotificationData: () => null,
  };
});

const mockGoogleSignin = {
  configure: jest.fn(),
  hasPlayServices: jest.fn().mockResolvedValue(true),
  signIn: jest.fn(),
  signInSilently: jest.fn(),
  signOut: jest.fn().mockResolvedValue(undefined),
  revokeAccess: jest.fn().mockResolvedValue(undefined),
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

import { useAuthStore } from '../../src/auth/authStore';
import { getApiSession } from '../../src/account/apiSession';
import {
  AccountDeletionError,
  confirmAccountDeletion,
  requestAccountDeletion,
  type AccountDeletionSurvey,
} from '../../src/account/deletion';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { getDb } from '../../src/data/db';
import {
  OWNER_SCOPED_KV_NAMESPACES,
  getKv,
  saveAnalysis,
} from '../../src/data/repository';
import { triggerOutboxSync } from '../../src/data/syncRuntime';
import { useAppStore } from '../../src/state/appStore';
import { useConsentStore } from '../../src/state/consentStore';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import type { Profile } from '../../src/state/profile';
import {
  DEVICE_LEVEL_KV_KEYS,
  OWNER_SCOPED_TABLES,
  analysisFor,
  classifySurvival,
  seedDeviceLevel,
  seedOwner,
} from './helpers/localSeed';
import { grepDatabase } from './helpers/nodeSqlite';
import {
  SESSION_VAULT_SERVICE,
  advanceClock,
  heapNumbers,
  installGlobalFetch,
  installNativeAuth,
  keychainSnapshot,
  processSnapshot,
  relaunchProcess,
  resetWorld,
  scheduler,
  sqliteHandle,
} from './helpers/world';
import { XC_ARTIFACT_DIR } from './helpers/artifactDir';

const ARTIFACT_DIR = XC_ARTIFACT_DIR;
const records: Record<string, unknown>[] = [];
function record(name: string, data: Record<string, unknown>): void {
  records.push({ scenario: name, ...data, heap: heapNumbers() });
}
afterAll(() => {
  writeFileSync(
    join(ARTIFACT_DIR, 'stores.scenarios.json'),
    JSON.stringify(records, null, 2),
  );
});

installGlobalFetch();

const PROFILE: Profile = {
  firstName: 'Pat',
  skillLevel: 'intermediate',
  handedness: 'right',
  goal: 'consistency',
  biggestProblem: 'popping up dinks',
  focusCheckpoint: 'contact_position',
};

/** Mirrors App.tsx Gate: owner switch, then app/notification/consent
 * hydration for that owner. */
async function gateHydrate(): Promise<string> {
  const session = useAuthStore.getState().session;
  const owner =
    session?.provider === 'guest'
      ? GUEST_DATA_OWNER
      : session?.canonicalAppUserId
        ? canonicalDataOwner(session.canonicalAppUserId)
        : SIGNED_OUT_DATA_OWNER;
  setActiveDataOwner(owner);
  await useAppStore.getState().hydrate();
  await useNotificationStore.getState().hydrate({ expectedOwnerKey: owner });
  await useConsentStore.getState().hydrate();
  return owner;
}

async function signInApple(subject: string): Promise<string> {
  installNativeAuth(subject);
  await useAuthStore.getState().signInWithApple();
  const session = useAuthStore.getState().session;
  if (!session?.canonicalAppUserId) {
    throw new Error(
      `sign-in failed: ${JSON.stringify(useAuthStore.getState().error)}`,
    );
  }
  return session.canonicalAppUserId;
}

async function signInGoogle(subject: string): Promise<string> {
  mockGoogleSignin.signIn.mockResolvedValueOnce({
    type: 'success',
    data: {
      idToken: `token-for:${subject}`,
      user: { name: 'Pat Player', email: `${subject}@gmail.example` },
    },
  });
  await useAuthStore.getState().signInWithGoogle();
  const session = useAuthStore.getState().session;
  if (!session?.canonicalAppUserId) {
    throw new Error(
      `google sign-in failed: ${JSON.stringify(useAuthStore.getState().error)}`,
    );
  }
  return session.canonicalAppUserId;
}

/** Fully populated signed-in account on this device: profile saved through
 * /v1/me/onboarding, notifications enabled and scheduled, model-training
 * consent granted server-side, every owner-scoped table + namespace seeded. */
async function populateAccount(seedTag: string) {
  const owner = await gateHydrate();
  await useAppStore.getState().completeOnboarding(PROFILE);
  await useNotificationStore.getState().requestPermissionAndEnable();
  await useNotificationStore.getState().setPrefs({
    practiceReminderMinutes: 20 * 60,
  });
  await useConsentStore.getState().setModelTrainingConsent(true);
  const seeded = await seedOwner(getDb(), owner, seedTag);
  return { owner, seeded };
}

async function seedOtherOwner(seedTag: string, owner: string) {
  const active = getActiveDataOwner();
  const seeded = await seedOwner(getDb(), owner, seedTag);
  setActiveDataOwner(active);
  return seeded;
}

async function localMarkers() {
  const db = getDb();
  return {
    lastProvider: await getKv(db, 'auth.last-provider'),
    localMode: await getKv(db, 'auth.local-mode'),
    legacySession: await getKv(db, 'auth.session'),
  };
}

async function fullDeletion(survey: AccountDeletionSurvey | null) {
  const challenge = await requestAccountDeletion(getApiSession(), survey);
  advanceClock(5_000);
  const result = await confirmAccountDeletion(
    getApiSession(),
    challenge.challenge,
  );
  await useAuthStore.getState().completeAccountDeletion();
  return result;
}

describe('journey: Settings → delete account → local wipe → relaunch (stores)', () => {
  test('S1 apple: full deletion purges every owner-scoped table/namespace, keeps the other owner and device-level kv, relaunches signed out', async () => {
    const { edge } = resetWorld({ seed: 'S1' });
    const canonicalId = await signInApple('apple-subject-S1');
    const { owner, seeded } = await populateAccount('S1');
    const otherOwner = canonicalDataOwner(
      '99999999-9999-4999-8999-999999999999',
    );
    const otherSeeded = await seedOtherOwner('S1-other', otherOwner);
    const deviceKeys = await seedDeviceLevel(getDb());

    // Preconditions — the account is fully live.
    for (const table of OWNER_SCOPED_TABLES) {
      expect(seeded.tables[table]).toBeGreaterThan(0);
    }
    expect(seeded.kvKeys).toHaveLength(OWNER_SCOPED_KV_NAMESPACES.length);
    expect(keychainSnapshot()).toEqual([
      expect.objectContaining({ service: SESSION_VAULT_SERVICE }),
    ]);
    expect(scheduler.pending.length).toBeGreaterThan(0);
    expect(useConsentStore.getState().modelTrainingActive).toBe(true);
    expect(edge.users.get(canonicalId)?.consent.modelTraining).toBe(true);
    expect(edge.users.get(canonicalId)?.profile).not.toBeNull();
    expect(edge.log.filter(e => e.status === 404)).toEqual([]);
    edge.seedScoredShots(canonicalId, 2);
    const before = processSnapshot();

    const result = await fullDeletion({
      reason: 'privacy',
      wanted: 'nothing',
      details: 'Please erase everything.',
      platform: 'ios',
      appVersion: '1.0',
    });
    expect(result.appleAuthorizationRevocation).toBe('revoked');

    // Server: account, sessions and consent gone; ledger + anonymized survey kept.
    const server = edge.snapshot();
    expect(server.users).toEqual([]);
    expect(server.liveAccessTokens).toBe(0);
    expect(server.liveRefreshTokens).toBe(0);
    expect(server.deletionRequests).toEqual([]);
    expect(server.feedback).toEqual([
      expect.objectContaining({ userId: null, reason: 'privacy' }),
    ]);
    expect(server.ledger).toEqual([
      expect.objectContaining({ scoredCount: 2 }),
    ]);

    // Local: no deleted-owner row, no sentinel anywhere, other owner intact.
    const survival = classifySurvival(sqliteHandle, owner, [otherOwner]);
    expect(survival.deletedOwnerRows).toEqual([]);
    expect(survival.sentinelHits).toEqual([]);
    expect(survival.unclassified).toEqual([]);
    expect(grepDatabase(sqliteHandle, canonicalId)).toEqual([]);
    const otherSurvival = classifySurvival(sqliteHandle, otherOwner, [owner]);
    const otherRowsByTable: Record<string, number> = {};
    for (const row of otherSurvival.deletedOwnerRows) {
      otherRowsByTable[row.table] = (otherRowsByTable[row.table] ?? 0) + 1;
    }
    for (const table of OWNER_SCOPED_TABLES) {
      expect(otherRowsByTable[table]).toBe(otherSeeded.tables[table]);
    }
    expect(otherRowsByTable['kv']).toBe(OWNER_SCOPED_KV_NAMESPACES.length);
    for (const key of deviceKeys) {
      expect(await getKv(getDb(), key)).not.toBeNull();
    }
    expect(useAuthStore.getState().deletionCleanup).toEqual({
      localPurge: 'complete',
    });

    // Durable session + restore markers.
    expect(keychainSnapshot()).toEqual([]);
    expect(await localMarkers()).toEqual({
      lastProvider: null,
      localMode: null,
      legacySession: null,
    });

    // Relaunch: no refresh attempt, signed-out owner, everything default.
    const logBefore = edge.log.length;
    relaunchProcess();
    await useAuthStore.getState().hydrate();
    const gateOwner = await gateHydrate();
    const after = processSnapshot();
    expect(after.auth.session).toBeNull();
    expect(after.auth.error).toBeNull();
    expect(gateOwner).toBe(SIGNED_OUT_DATA_OWNER);
    expect(after.app.hasProfile).toBe(false);
    expect(after.notifications.ownerKey).toBe(SIGNED_OUT_DATA_OWNER);
    expect(after.notifications.prefs.enabled).toBe(false);
    expect(after.scheduler.pendingCount).toBe(0);
    expect(after.scheduler.cancelAllCalls).toBeGreaterThan(0);
    expect(after.consent.availability).toBe('signed_out');
    expect(after.consent.modelTrainingActive).toBe(false);
    expect(edge.log.slice(logBefore)).toEqual([]);

    record('S1', {
      seed: 'S1',
      before,
      after,
      server,
      survival: {
        totalRows: survival.totalRows,
        deletedOwnerRows: survival.deletedOwnerRows.length,
        otherOwnerRows: survival.otherOwnerRows.length,
        deviceRows: survival.deviceRows.length,
        sentinelHits: survival.sentinelHits.length,
        otherRowsByTable,
      },
      requestLog: edge.log,
    });
  });

  test('S2 google: deletion clears the google silent-restore marker and disconnects the SDK', async () => {
    const { edge } = resetWorld({ seed: 'S2' });
    const canonicalId = await signInGoogle('google-subject-S2');
    const { owner } = await populateAccount('S2');
    expect(JSON.parse((await localMarkers()).lastProvider ?? 'null')).toEqual(
      expect.objectContaining({ provider: 'google' }),
    );

    await fullDeletion(null);

    expect(edge.users.has(canonicalId)).toBe(false);
    expect(edge.snapshot().feedback).toEqual([]);
    expect(mockGoogleSignin.revokeAccess).toHaveBeenCalled();
    expect(mockGoogleSignin.signOut).toHaveBeenCalled();
    expect(await localMarkers()).toEqual({
      lastProvider: null,
      localMode: null,
      legacySession: null,
    });
    const survival = classifySurvival(sqliteHandle, owner, []);
    expect(survival.deletedOwnerRows).toEqual([]);
    expect(keychainSnapshot()).toEqual([]);

    relaunchProcess();
    mockGoogleSignin.signInSilently.mockClear();
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session).toBeNull();
    expect(mockGoogleSignin.signInSilently).not.toHaveBeenCalled();
    record('S2', { seed: 'S2', server: edge.snapshot(), requestLog: edge.log });
  });

  test('S3 challenge lifecycle: confirm before request, wrong challenge, too fast, expired', async () => {
    const { edge } = resetWorld({ seed: 'S3' });
    const canonicalId = await signInApple('apple-subject-S3');
    await populateAccount('S3');
    const outcomes: Record<string, unknown> = {};
    const attempt = async (label: string, fn: () => Promise<unknown>) => {
      try {
        const value = await fn();
        outcomes[label] = { ok: true, value };
      } catch (error) {
        outcomes[label] =
          error instanceof AccountDeletionError
            ? {
                ok: false,
                code: error.code,
                retryable: error.retryable,
                message: error.message,
              }
            : { ok: false, thrown: String(error) };
      }
      expect(edge.users.has(canonicalId)).toBe(true);
    };

    await attempt('confirm_without_request', () =>
      confirmAccountDeletion(
        getApiSession(),
        '11111111-1111-4111-8111-111111111111',
      ),
    );
    await attempt('confirm_non_uuid', () =>
      confirmAccountDeletion(getApiSession(), 'not-a-challenge'),
    );
    const challenge = await requestAccountDeletion(getApiSession(), null);
    await attempt('confirm_wrong_challenge', () =>
      confirmAccountDeletion(
        getApiSession(),
        '22222222-2222-4222-8222-222222222222',
      ),
    );
    advanceClock(1_000);
    await attempt('confirm_too_fast_1s', () =>
      confirmAccountDeletion(getApiSession(), challenge.challenge),
    );
    advanceClock(15 * 60_000);
    await attempt('confirm_expired', () =>
      confirmAccountDeletion(getApiSession(), challenge.challenge),
    );

    expect(outcomes['confirm_without_request']).toMatchObject({
      ok: false,
      retryable: false,
    });
    expect(outcomes['confirm_wrong_challenge']).toMatchObject({
      ok: false,
      retryable: false,
    });
    expect(outcomes['confirm_too_fast_1s']).toMatchObject({
      ok: false,
      retryable: true,
    });
    expect(outcomes['confirm_expired']).toMatchObject({
      ok: false,
      retryable: false,
    });
    // A fresh request after expiry still works end to end.
    const fresh = await requestAccountDeletion(getApiSession(), null);
    advanceClock(3_000);
    const done = await confirmAccountDeletion(getApiSession(), fresh.challenge);
    expect(done.appleAuthorizationRevocation).toBe('revoked');
    expect(edge.users.has(canonicalId)).toBe(false);
    record('S3', { seed: 'S3', outcomes, requestLog: edge.log });
  });

  test('S4 request-step faults never delete anything and map to the documented copy', async () => {
    const { edge } = resetWorld({ seed: 'S4' });
    const canonicalId = await signInApple('apple-subject-S4');
    await populateAccount('S4');
    const table: Array<Record<string, unknown>> = [];
    const faults = [
      { kind: 'network_error' } as const,
      { kind: 'invalid_json' } as const,
      { kind: 'status', status: 429 } as const,
      { kind: 'status', status: 500 } as const,
      { kind: 'status', status: 503 } as const,
      { kind: 'status', status: 401 } as const,
      { kind: 'status', status: 400 } as const,
    ];
    for (const fault of faults) {
      edge.injectFault('/v1/me/delete-request', fault);
      try {
        await requestAccountDeletion(getApiSession(), null);
        table.push({ fault, ok: true });
      } catch (error) {
        const e = error as AccountDeletionError;
        table.push({
          fault,
          code: e.code,
          retryable: e.retryable,
          message: e.message,
        });
      }
      expect(edge.users.has(canonicalId)).toBe(true);
    }
    expect(table).toEqual([
      expect.objectContaining({
        retryable: true,
        message:
          'Account deletion is temporarily offline. Nothing was deleted — please try again.',
      }),
      expect.objectContaining({
        retryable: false,
        message: 'The server returned an invalid deletion response.',
      }),
      expect.objectContaining({ retryable: true }),
      expect.objectContaining({ retryable: true }),
      expect.objectContaining({ retryable: true }),
      expect.objectContaining({
        retryable: false,
        message:
          'Your sign-in has expired. Sign in again, then delete your account.',
      }),
      expect.objectContaining({ retryable: false }),
    ]);
    // Still fully signed in with intact local data afterwards.
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(keychainSnapshot()).toHaveLength(1);
    record('S4', { seed: 'S4', table, requestLog: edge.log });
  });

  test('S5 survey variants reach the server before deletion and are anonymized after', async () => {
    const { edge } = resetWorld({ seed: 'S5' });
    const surveys: Array<[string, AccountDeletionSurvey | null]> = [
      ['skipped', null],
      [
        'q2_skipped',
        {
          reason: 'too_expensive',
          wanted: null,
          details: null,
          platform: 'ios',
          appVersion: '1.0',
        },
      ],
      [
        'complete_long_details',
        {
          reason: 'other',
          wanted: 'content',
          details: 'x'.repeat(700),
          platform: 'ios',
          appVersion: '1.0',
        },
      ],
    ];
    const results: Record<string, unknown> = {};
    for (const [label, survey] of surveys) {
      relaunchProcess();
      const canonicalId = await signInApple(`apple-subject-S5-${label}`);
      await gateHydrate();
      const req = await requestAccountDeletion(getApiSession(), survey);
      const sent = edge.log.filter(
        entry => entry.path === '/v1/me/delete-request',
      );
      const lastBody = sent[sent.length - 1]?.body as Record<
        string,
        unknown
      > | null;
      advanceClock(3_000);
      await confirmAccountDeletion(getApiSession(), req.challenge);
      await useAuthStore.getState().completeAccountDeletion();
      results[label] = {
        sentBody: lastBody,
        userDeleted: !edge.users.has(canonicalId),
      };
    }
    const feedback = edge.snapshot().feedback;
    expect(feedback).toHaveLength(2);
    expect(feedback.every(row => row.userId === null)).toBe(true);
    expect(feedback[0]).toMatchObject({
      reason: 'too_expensive',
      wanted: null,
      details: null,
    });
    expect(feedback[1]).toMatchObject({ reason: 'other', wanted: 'content' });
    expect((feedback[1]?.details ?? '').length).toBeLessThanOrEqual(500);
    expect(
      (results['skipped'] as { sentBody: Record<string, unknown> | null })
        .sentBody,
    ).toBeNull();
    record('S5', { seed: 'S5', results, feedback, requestLog: edge.log });
  });

  test('S6 local purge failure: three attempts, session still gone, user told cleanup failed', async () => {
    const { edge } = resetWorld({ seed: 'S6' });
    await signInApple('apple-subject-S6');
    const { owner } = await populateAccount('S6');
    sqliteHandle.failOn = /DELETE FROM local_shot/;
    const sqlBefore = sqliteHandle.log.length;
    await fullDeletion(null);
    sqliteHandle.failOn = null;
    const purgeAttempts = sqliteHandle.log
      .slice(sqlBefore)
      .filter(stmt => /DELETE FROM local_shot/.test(stmt.sql)).length;
    expect(purgeAttempts).toBe(3);
    expect(useAuthStore.getState().deletionCleanup).toEqual({
      localPurge: 'failed',
    });
    expect(useAuthStore.getState().session).toBeNull();
    expect(keychainSnapshot()).toEqual([]);
    const survival = classifySurvival(sqliteHandle, owner, []);
    // Documented behaviour: rows survive and the UI tells the user to delete
    // the app. Recorded, not asserted away.
    const survivingByTable: Record<string, number> = {};
    for (const row of survival.deletedOwnerRows) {
      survivingByTable[row.table] = (survivingByTable[row.table] ?? 0) + 1;
    }
    expect(survival.deletedOwnerRows.length).toBeGreaterThan(0);

    // Relaunch signs in nobody and never retries the purge on its own.
    relaunchProcess();
    await useAuthStore.getState().hydrate();
    await gateHydrate();
    const afterRelaunch = classifySurvival(sqliteHandle, owner, []);
    record('S6', {
      seed: 'S6',
      purgeAttempts,
      survivingByTable,
      survivingAfterRelaunch: afterRelaunch.deletedOwnerRows.length,
      requestLog: edge.log,
    });
    expect(afterRelaunch.deletedOwnerRows.length).toBe(
      survival.deletedOwnerRows.length,
    );
  });

  test('S7 local purge transient failure: second attempt succeeds → complete', async () => {
    resetWorld({ seed: 'S7' });
    await signInApple('apple-subject-S7');
    const { owner } = await populateAccount('S7');
    sqliteHandle.failOn = /DELETE FROM local_shot/;
    sqliteHandle.failRemaining = 2;
    const sqlBefore = sqliteHandle.log.length;
    await fullDeletion(null);
    const failures = sqliteHandle.log
      .slice(sqlBefore)
      .filter(stmt => /DELETE FROM local_shot/.test(stmt.sql)).length;
    expect(failures).toBe(3);
    expect(useAuthStore.getState().deletionCleanup).toEqual({
      localPurge: 'complete',
    });
    expect(classifySurvival(sqliteHandle, owner, []).deletedOwnerRows).toEqual(
      [],
    );
    record('S7', { seed: 'S7', purgeAttempts: failures });
  });

  test('S8 401 on relaunch (refresh refused): implicit sign-out clears the vault, local rows stay (no deletion happened)', async () => {
    const { edge } = resetWorld({ seed: 'S8' });
    const canonicalId = await signInApple('apple-subject-S8');
    const { owner } = await populateAccount('S8');
    // Another device deleted the account: server rows vanish, this device's
    // Keychain still holds a refresh token.
    edge.users.delete(canonicalId);
    for (const [token, id] of edge.refreshTokens) {
      if (id === canonicalId) edge.refreshTokens.delete(token);
    }
    relaunchProcess();
    await useAuthStore.getState().hydrate();
    const gateOwner = await gateHydrate();
    const snap = processSnapshot();
    expect(snap.auth.session).toBeNull();
    // dropRevokedSession(): the ONE implicit sign-out is silent (error null).
    expect(snap.auth.error).toBeNull();
    expect(gateOwner).toBe(SIGNED_OUT_DATA_OWNER);
    expect(keychainSnapshot()).toEqual([]);
    expect(snap.scheduler.pendingCount).toBe(0);
    const survival = classifySurvival(sqliteHandle, owner, []);
    record('S8', {
      seed: 'S8',
      snap,
      localRowsSurviving: survival.deletedOwnerRows.length,
      requestLog: edge.log,
    });
    expect(edge.log.some(e => e.path === '/v1/auth/refresh')).toBe(true);
  });

  test('S9 lost delete-confirm response: server deleted, client says "Nothing was deleted", retry says sign-in expired, local data never purged', async () => {
    const { edge } = resetWorld({ seed: 'S9' });
    const canonicalId = await signInApple('apple-subject-S9');
    const { owner } = await populateAccount('S9');
    const challenge = await requestAccountDeletion(getApiSession(), null);
    advanceClock(5_000);
    edge.injectFault('/v1/me/delete-confirm', { kind: 'lost_response' });
    let firstError: AccountDeletionError | null = null;
    try {
      await confirmAccountDeletion(getApiSession(), challenge.challenge);
    } catch (error) {
      firstError = error as AccountDeletionError;
    }
    expect(firstError).toBeInstanceOf(AccountDeletionError);
    expect(edge.users.has(canonicalId)).toBe(false); // server side: gone
    // Screen behaviour (ManageAccountScreen.confirmDeletion): retryable →
    // stays armed with the same challenge and shows the error copy.
    let retryError: AccountDeletionError | null = null;
    try {
      await confirmAccountDeletion(getApiSession(), challenge.challenge);
    } catch (error) {
      retryError = error as AccountDeletionError;
    }
    const survival = classifySurvival(sqliteHandle, owner, []);
    // Relaunch: refresh refused → signed out, but nothing purges the owner.
    relaunchProcess();
    await useAuthStore.getState().hydrate();
    await gateHydrate();
    const afterRelaunch = classifySurvival(sqliteHandle, owner, []);
    const finding = {
      seed: 'S9',
      firstError: firstError && {
        code: firstError.code,
        retryable: firstError.retryable,
        message: firstError.message,
      },
      retryError: retryError && {
        code: retryError.code,
        retryable: retryError.retryable,
        message: retryError.message,
      },
      serverDeleted: !edge.users.has(canonicalId),
      localRowsSurvivingImmediately: survival.deletedOwnerRows.length,
      localRowsSurvivingAfterRelaunch: afterRelaunch.deletedOwnerRows.length,
      keychainAfterRelaunch: keychainSnapshot(),
      relaunchAuth: processSnapshot().auth,
      requestLog: edge.log,
    };
    record('S9', finding);
    writeFileSync(
      join(ARTIFACT_DIR, 'finding.lost-confirm-response.json'),
      JSON.stringify(finding, null, 2),
    );
    // Pinned observations (this is the failure mode, not the desired state).
    expect(firstError?.message).toBe(
      'Account deletion is temporarily offline. Nothing was deleted — please try again.',
    );
    expect(retryError?.message).toBe(
      'Your sign-in has expired. Sign in again, then delete your account.',
    );
    expect(afterRelaunch.deletedOwnerRows.length).toBeGreaterThan(0);
  });

  test('S10 in-flight shot sync racing the purge re-creates sync_receipt rows for the deleted owner', async () => {
    const { edge } = resetWorld({ seed: 'S10' });
    await signInApple('apple-subject-S10');
    const { owner } = await populateAccount('S10');
    // One more analysis whose outbox row is drained while deletion runs.
    await saveAnalysis(getDb(), analysisFor(owner, 'S10-race', null), 'S10-p');
    let release: () => void = () => {};
    const until = new Promise<void>(resolve => {
      release = resolve;
    });
    edge.injectFault('/v1/shots:sync', { kind: 'hold', until });
    triggerOutboxSync();
    // Let the drain reach the held network call.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(
      edge.log.filter(e => e.path === '/v1/shots:sync' && e.effectApplied),
    ).toHaveLength(1);

    await fullDeletion(null);
    const purged = classifySurvival(sqliteHandle, owner, []);
    expect(purged.deletedOwnerRows).toEqual([]);

    release();
    await new Promise(resolve => setTimeout(resolve, 50));
    const afterRace = classifySurvival(sqliteHandle, owner, []);
    const finding = {
      seed: 'S10',
      rowsAfterPurge: purged.deletedOwnerRows.length,
      rowsAfterLateSyncResponse: afterRace.deletedOwnerRows.map(r => ({
        table: r.table,
        row: r.row,
      })),
      requestLog: edge.log,
    };
    record('S10', finding);
    writeFileSync(
      join(ARTIFACT_DIR, 'finding.sync-race-receipt.json'),
      JSON.stringify(finding, null, 2),
    );
    expect(afterRace.deletedOwnerRows.length).toBeGreaterThan(0);
    expect(new Set(afterRace.deletedOwnerRows.map(r => r.table))).toEqual(
      new Set(['sync_receipt']),
    );
  });

  test('S11 in-memory state after deletion is signed-out/default before any relaunch', async () => {
    resetWorld({ seed: 'S11' });
    await signInApple('apple-subject-S11');
    await populateAccount('S11');
    await fullDeletion(null);
    // What App.tsx Gate does on the SAME process after onDeleted().
    const gateOwner = await gateHydrate();
    const snap = processSnapshot();
    expect(gateOwner).toBe(SIGNED_OUT_DATA_OWNER);
    expect(snap.apiSession).toBeNull();
    expect(snap.app).toEqual({
      hydrated: true,
      ownerKey: SIGNED_OUT_DATA_OWNER,
      hasProfile: false,
    });
    expect(snap.notifications.ownerKey).toBe(SIGNED_OUT_DATA_OWNER);
    expect(snap.scheduler.pendingCount).toBe(0);
    expect(snap.consent).toEqual({
      availability: 'signed_out',
      modelTrainingActive: false,
    });
    record('S11', { seed: 'S11', snap });
  });

  test('S12 device-level kv keys are not owner-scoped and survive deletion (legal §7 device-only data)', async () => {
    resetWorld({ seed: 'S12' });
    await signInApple('apple-subject-S12');
    await populateAccount('S12');
    const keys = await seedDeviceLevel(getDb());
    await fullDeletion(null);
    const values: Record<string, string | null> = {};
    for (const key of keys) values[key] = await getKv(getDb(), key);
    expect(Object.values(values).every(v => v !== null && v !== '')).toBe(true);
    expect(keys).toEqual([...DEVICE_LEVEL_KV_KEYS]);
    record('S12', { seed: 'S12', values });
  });
});
