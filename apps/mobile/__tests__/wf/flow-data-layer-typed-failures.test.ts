/**
 * Data-layer zero-silent-failure audit (workflow: data-layer-typed-failures).
 *
 * Drives the store/repository mutations that sit behind user controls —
 * consent toggle, delete-account confirmation, outbox sync — through their
 * success, failure and stale-session branches and pins what each one does
 * with a failure. Tests whose name starts with "DEFECT:" document behavior
 * that was confirmed while auditing and is reported as an issue; they pass
 * against the current code so the evidence is executable. Flip their
 * expectations when the defect is fixed (the swallowed local-purge failure
 * and the indistinguishable exhausted shot were fixed on main and are now
 * pinned as such below).
 */
import type { LocalDb } from '../../src/data/db';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  OUTBOX_MAX_ATTEMPTS,
  drainOutbox,
  isPermanentSyncFailure,
} from '../../src/data/sync';
import { ApiError } from '../../src/data/api';
import {
  getShotOutboxStatus,
  hasShotSyncReceipt,
  purgeOwnerData,
} from '../../src/data/repository';
import {
  clearApiSession,
  establishApiSession,
  getApiSession,
} from '../../src/account/apiSession';
import { MODEL_TRAINING_CONSENT_VERSION } from '../../src/account/consentApi';
import { useConsentStore } from '../../src/state/consentStore';

const mockGetDb = jest.fn<LocalDb, []>();
jest.mock('../../src/data/db', () => ({
  getDb: () => mockGetDb(),
}));
jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));

// Imported after the db mock so the auth store's persistence goes through it.
import { useAuthStore } from '../../src/auth/authStore';

const CANONICAL_ID = '7fc2c743-028f-4ec6-942c-a84508f3be38';

const session = {
  apiBaseUrl: 'https://api.test',
  bearerToken: 'token-1',
  canonicalAppUserId: CANONICAL_ID,
  provider: 'apple' as const,
};

function consentStatusBody(modelTrainingActive: boolean) {
  return {
    subjectPseudonym: 'b0000000-0000-0000-0000-000000000002',
    scopes: [
      {
        scope: 'video_analysis',
        active: false,
        consentVersion: null,
        lastAction: null,
        lastActionAt: null,
      },
      {
        scope: 'model_training',
        active: modelTrainingActive,
        consentVersion: modelTrainingActive
          ? MODEL_TRAINING_CONSENT_VERSION
          : null,
        lastAction: modelTrainingActive ? 'granted' : 'withdrawn',
        lastActionAt: '2026-08-29T00:00:00.000Z',
      },
    ],
  };
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: () => Promise.resolve(body) } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function resetConsentStore() {
  useConsentStore.setState({
    availability: 'loading',
    modelTrainingActive: false,
    lastActionAt: null,
    busy: false,
    error: null,
  });
}

/** Minimal in-memory outbox + receipts + kv fake (same SQL the sync engine emits). */
function fakeDb() {
  interface OutboxRow {
    id: number;
    owner_key: string;
    kind: string;
    payload: string;
    attempts: number;
    refusals?: number;
    quarantined?: number;
    last_error: string | null;
  }
  const outbox: OutboxRow[] = [];
  const receipts: Array<{ owner: string; entityId: string }> = [];
  const kv = new Map<string, string>();
  const log: string[] = [];
  let nextId = 1;
  const db: LocalDb = {
    async execute(sql: string, params: unknown[] = []) {
      log.push(sql);
      if (sql === 'BEGIN IMMEDIATE' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('INSERT OR REPLACE INTO sync_receipt')) {
        receipts.push({
          owner: String(params[0]),
          entityId: String(params[1]),
        });
        return { rows: [] };
      }
      if (sql.startsWith('SELECT 1 FROM sync_receipt')) {
        const hit = receipts.some(
          r => r.owner === params[0] && r.entityId === params[1],
        );
        return { rows: hit ? [{ 1: 1 }] : [] };
      }
      if (sql.startsWith('SELECT 1 AS known FROM outbox')) {
        // saveAnalysis idempotency: a shot.sync row or a receipt for the id.
        const known =
          outbox.some(r => {
            if (r.owner_key !== String(params[0]) || r.kind !== 'shot.sync') {
              return false;
            }
            try {
              return (
                (JSON.parse(r.payload) as { id?: string }).id === params[1]
              );
            } catch {
              return false;
            }
          }) ||
          receipts.some(
            r => r.owner === String(params[2]) && r.entityId === params[3],
          );
        return { rows: known ? [{ known: 1 }] : [] };
      }
      if (sql.startsWith('SELECT id, kind, payload')) {
        return {
          rows: outbox
            .filter(
              r =>
                r.owner_key === String(params[0]) &&
                r.attempts < Number(params[1]),
            )
            .map(r => ({ ...r })),
        };
      }
      if (
        sql.startsWith(
          'SELECT attempts, refusals, quarantined, last_error FROM outbox',
        )
      ) {
        // getShotOutboxStatus: the newest shot.sync row for this shot id.
        const row = [...outbox]
          .reverse()
          .find(
            r =>
              r.owner_key === String(params[0]) &&
              r.kind === 'shot.sync' &&
              (JSON.parse(r.payload) as { id?: string }).id === params[1],
          );
        return {
          rows: row
            ? [
                {
                  attempts: row.attempts,
                  refusals: row.refusals ?? 0,
                  quarantined: row.quarantined ?? 0,
                  last_error: row.last_error,
                },
              ]
            : [],
        };
      }
      if (sql.startsWith('DELETE FROM outbox WHERE owner_key = ? AND id')) {
        const idx = outbox.findIndex(
          r => r.owner_key === params[0] && r.id === params[1],
        );
        if (idx >= 0) outbox.splice(idx, 1);
        return { rows: [] };
      }
      if (sql.startsWith('UPDATE outbox')) {
        const row = outbox.find(
          r => r.owner_key === params[1] && r.id === params[2],
        );
        if (row) {
          if (sql.includes('attempts = attempts + 1')) row.attempts += 1;
          if (sql.includes('refusals = refusals + 1')) {
            row.refusals = (row.refusals ?? 0) + 1;
          }
          const quarantine = /SET attempts = (\d+), quarantined = 1,/.exec(sql);
          if (quarantine) {
            row.attempts = Number(quarantine[1]);
            row.quarantined = 1;
          }
          row.last_error = String(params[0]);
        }
        return { rows: [] };
      }
      if (sql.startsWith('SELECT ls.id AS id FROM local_session')) {
        // No local_session rows exist in this fake: no parked set to re-queue.
        return { rows: [] };
      }
      if (sql.startsWith('SELECT count(*)')) {
        return {
          rows: [
            { n: outbox.filter(row => row.owner_key === params[0]).length },
          ],
        };
      }
      if (sql.startsWith('DELETE FROM kv WHERE key = ?')) {
        kv.delete(String(params[0]));
        return { rows: [] };
      }
      if (sql.includes('DELETE FROM') && sql.includes('WHERE owner_key = ?')) {
        return { rows: [] };
      }
      throw new Error(`fakeDb: unhandled sql ${sql}`);
    },
    close() {},
  };
  const push = (kind: string, payload: unknown, owner = GUEST_DATA_OWNER) => {
    outbox.push({
      id: nextId++,
      owner_key: owner,
      kind,
      payload: JSON.stringify(payload),
      attempts: 0,
      last_error: null,
    });
  };
  return { db, push, outbox, receipts, kv, log };
}

const permittedAnalysis = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  analysisPermitId: 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  sessionId: null,
  shotType: 'forehand_drive',
  cameraView: 'side',
  handedness: 'right',
  capturedAtIso: '2026-08-26T18:00:00.000Z',
  timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
  phases: [],
  measurements: [],
  checkpoints: [],
  overallScore: 7.4,
  analysisConfidence: 0.9,
  resultKind: 'scored',
  guidance: null,
  priorityFix: null,
  versionVector: {
    appVersion: '0.1.0',
    modelBundleVersion: 'test-native-1',
    poseModelVersion: 'test-pose-1',
    paddleModelVersion: 'test-paddle-1',
    strokeDetectorVersion: 'test-stroke-1',
    phaseModelVersion: 'test-phase-1',
    scoringModelVersion: 'sm-v1',
    shotConfigVersion: 'forehand_drive@1',
  },
  source: 'real',
};

const noopTransport = {
  createSession: async () => {},
  finalizeSession: async () => {},
};

afterEach(() => {
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  mockGetDb.mockReset();
});

describe('consent toggle → consentStore (typed failure, no optimistic state)', () => {
  beforeEach(() => {
    resetConsentStore();
    establishApiSession(session);
  });

  it('a failed grant keeps the toggle OFF, clears busy and surfaces copy', async () => {
    const fetchFn = jest.fn(async () => {
      throw new Error('socket hang up');
    });
    useConsentStore.setState({ availability: 'ready' });
    await useConsentStore.getState().setModelTrainingConsent(true, fetchFn);
    const state = useConsentStore.getState();
    expect(state.busy).toBe(false);
    expect(state.modelTrainingActive).toBe(false);
    expect(state.error).toBe('Consent settings are temporarily unavailable.');
  });

  it('a second tap while busy is ignored (double-tap guard)', async () => {
    const first = deferred<Response>();
    const fetchFn = jest.fn(() => first.promise);
    useConsentStore.setState({ availability: 'ready' });
    const p1 = useConsentStore
      .getState()
      .setModelTrainingConsent(true, fetchFn);
    const p2 = useConsentStore
      .getState()
      .setModelTrainingConsent(true, fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    first.resolve(jsonResponse(consentStatusBody(true)));
    await Promise.all([p1, p2]);
    expect(useConsentStore.getState().modelTrainingActive).toBe(true);
    expect(useConsentStore.getState().busy).toBe(false);
  });

  it('a hydrate failure lands in an explicit unavailable state with copy', async () => {
    const fetchFn = jest.fn(async () => jsonResponse({}, false));
    await useConsentStore.getState().hydrate(fetchFn);
    expect(useConsentStore.getState()).toMatchObject({
      availability: 'unavailable',
      modelTrainingActive: false,
      error: 'Consent settings are temporarily unavailable.',
    });
  });

  it('a consent fetch that resolves after sign-out is discarded: the store stays signed_out and a toggle attempt says so', async () => {
    const pending = deferred<Response>();
    const slowFetch = jest.fn(() => pending.promise);
    const hydrating = useConsentStore.getState().hydrate(slowFetch);
    expect(useConsentStore.getState().availability).toBe('loading');

    // User signs out (SettingsScreen re-hydrates on session change).
    clearApiSession();
    await useConsentStore.getState().hydrate();
    expect(useConsentStore.getState().availability).toBe('signed_out');

    // The stale in-flight response now lands.
    pending.resolve(jsonResponse(consentStatusBody(true)));
    await hydrating;

    // The stale-session guard in consentStore.hydrate drops the response:
    // the signed-out store never advertises the previous account's grant.
    expect(getApiSession()).toBeNull();
    expect(useConsentStore.getState()).toMatchObject({
      availability: 'signed_out',
      modelTrainingActive: false,
    });

    // A toggle attempt while signed out sends nothing and says why.
    const toggleFetch = jest.fn();
    await useConsentStore
      .getState()
      .setModelTrainingConsent(false, toggleFetch);
    expect(toggleFetch).not.toHaveBeenCalled();
    expect(useConsentStore.getState().error).toBe(
      'Sign in to change this setting. Nothing was changed.',
    );
    expect(useConsentStore.getState().modelTrainingActive).toBe(false);
  });
});

describe('Delete account → completeAccountDeletion (post-confirmation purge)', () => {
  beforeEach(() => {
    useAuthStore.setState({
      hydrated: true,
      busy: false,
      error: null,
      session: {
        provider: 'apple',
        subject: 'apple-subject',
        canonicalAppUserId: CANONICAL_ID,
        localOnly: false,
        displayName: null,
        email: null,
      },
    });
    establishApiSession(session);
    setActiveDataOwner(canonicalDataOwner(CANONICAL_ID));
  });

  it('purges every owner-scoped table and kv namespace in ONE transaction and signs out', async () => {
    const { db, log } = fakeDb();
    mockGetDb.mockReturnValue(db);

    await useAuthStore.getState().completeAccountDeletion();

    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    const begin = log.indexOf('BEGIN IMMEDIATE');
    const commit = log.indexOf('COMMIT');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(commit).toBeGreaterThan(begin);
    const inTx = log.slice(begin + 1, commit);
    for (const table of [
      'local_shot',
      'local_session',
      'local_capture',
      'local_analysis_record',
      'outbox',
      'sync_receipt',
    ]) {
      expect(inTx).toContainEqual(
        expect.stringContaining(`DELETE FROM ${table}`),
      );
    }
    // profile, rank.celebrated, notifications, consistency, practice.set
    // (repository.ts OWNER_SCOPED_KV_NAMESPACES).
    expect(inTx.filter(sql => sql.startsWith('DELETE FROM kv'))).toHaveLength(
      5,
    );
    expect(log.includes('ROLLBACK')).toBe(false);
    expect(useAuthStore.getState().deletionCleanup).toEqual({
      localPurge: 'complete',
    });
  });

  it('a purge failure rolls the transaction back (no half-purged owner bucket)', async () => {
    const { db } = fakeDb();
    const log: string[] = [];
    const flaky: LocalDb = {
      async execute(sql, params) {
        log.push(sql);
        if (sql.includes('DELETE FROM outbox')) throw new Error('disk I/O');
        return db.execute(sql, params);
      },
      close() {},
    };
    await expect(
      purgeOwnerData(flaky, canonicalDataOwner(CANONICAL_ID)),
    ).rejects.toThrow('disk I/O');
    expect(log[log.length - 1]).toBe('ROLLBACK');
    expect(log).not.toContain('COMMIT');
  });

  it('a failed local purge after server-confirmed deletion is retried, never rethrown, and reported through deletionCleanup for the UI to tell the user', async () => {
    // Formerly a DEFECT pin (the failure was swallowed with nothing for the
    // UI to show); the store now records the outcome and ManageAccountScreen
    // alerts on `localPurge === 'failed'`.
    const { db } = fakeDb();
    let attempts = 0;
    const failing: LocalDb = {
      async execute(sql, params) {
        if (sql === 'BEGIN IMMEDIATE') {
          attempts += 1;
          throw new Error('database is locked');
        }
        return db.execute(sql, params);
      },
      close() {},
    };
    mockGetDb.mockReturnValue(failing);

    await expect(
      useAuthStore.getState().completeAccountDeletion(),
    ).resolves.toBeUndefined();

    // The account is signed out regardless — it no longer exists server-side…
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().error).toBeNull();
    // …the purge was given three chances…
    expect(attempts).toBe(3);
    // …and the fact that owner-scoped rows are still on disk is recorded.
    expect(useAuthStore.getState().deletionCleanup).toEqual({
      localPurge: 'failed',
    });
  });

  it('a local-only session has nothing to purge and says so', async () => {
    useAuthStore.setState({
      session: {
        provider: 'guest',
        subject: 'local-only',
        canonicalAppUserId: null,
        localOnly: true,
        displayName: null,
        email: null,
      },
    });
    const { db, log } = fakeDb();
    mockGetDb.mockReturnValue(db);
    await useAuthStore.getState().completeAccountDeletion();
    expect(log).not.toContain('BEGIN IMMEDIATE');
    expect(useAuthStore.getState().deletionCleanup).toEqual({
      localPurge: 'not_needed',
    });
  });
});

describe('outbox sync: durable failures stay typed and bounded', () => {
  beforeEach(() => setActiveDataOwner(GUEST_DATA_OWNER));

  it('classifies the failure taxonomy: 4xx permanent; 401/408/429/5xx/network retryable', () => {
    expect(isPermanentSyncFailure(new ApiError(422, 'x', 'bad'))).toBe(true);
    expect(isPermanentSyncFailure(new ApiError(401, 'x', 'expired'))).toBe(
      false,
    );
    expect(isPermanentSyncFailure(new ApiError(408, 'x', 'timeout'))).toBe(
      false,
    );
    expect(isPermanentSyncFailure(new ApiError(429, 'x', 'limited'))).toBe(
      false,
    );
    expect(isPermanentSyncFailure(new ApiError(503, 'x', 'down'))).toBe(false);
    expect(
      isPermanentSyncFailure(new TypeError('Network request failed')),
    ).toBe(false);
  });

  it('a transient shot-sync failure records the error without consuming the attempt budget', async () => {
    const { db, push, outbox } = fakeDb();
    push('shot.sync', permittedAnalysis);
    const result = await drainOutbox(db, {
      ...noopTransport,
      syncShots: async () => {
        throw new TypeError('Network request failed');
      },
    });
    expect(result).toMatchObject({ synced: 0, failed: 1, remaining: 1 });
    expect(outbox[0]).toMatchObject({
      attempts: 0,
      last_error: 'TypeError: Network request failed',
    });
  });

  it('an accepted shot writes its receipt and deletes the outbox row atomically', async () => {
    const { db, push, receipts, log } = fakeDb();
    push('shot.sync', permittedAnalysis);
    await drainOutbox(db, {
      ...noopTransport,
      syncShots: async () => ({
        acceptedIds: [permittedAnalysis.id],
        rejected: [],
      }),
    });
    const begin = log.indexOf('BEGIN IMMEDIATE');
    expect(log[begin + 1]).toContain('INSERT OR REPLACE INTO sync_receipt');
    expect(log[begin + 2]).toContain('DELETE FROM outbox');
    expect(log[begin + 3]).toBe('COMMIT');
    expect(receipts).toEqual([
      { owner: GUEST_DATA_OWNER, entityId: permittedAnalysis.id },
    ]);
    expect(await hasShotSyncReceipt(db, permittedAnalysis.id)).toBe(true);
  });

  it('a permanently rejected shot exhausts its budget, is never retried, and is distinguishable from a pending shot for the UI', async () => {
    // Formerly a DEFECT pin: the only signal Result consulted was the sync
    // receipt, so an exhausted shot read like a pending one. Result now
    // derives its sync evidence from hasShotSyncReceipt THEN
    // getShotOutboxStatus, whose rejected/exhausted states carry the attempt
    // count and the server's last error.
    const { db, push, outbox } = fakeDb();
    push('shot.sync', permittedAnalysis);
    expect(await getShotOutboxStatus(db, permittedAnalysis.id)).toEqual({
      state: 'queued',
      attempts: 0,
      lastError: null,
    });
    const rejecting = {
      ...noopTransport,
      syncShots: async () => ({
        acceptedIds: [],
        rejected: [
          {
            id: permittedAnalysis.id,
            code: 'permit_invalid',
            message: 'Permit was not issued for this shot.',
          },
        ],
      }),
    };
    await drainOutbox(db, rejecting);
    // Declined once but still inside the budget: rejected, not exhausted.
    expect(await getShotOutboxStatus(db, permittedAnalysis.id)).toMatchObject({
      state: 'rejected',
      attempts: 1,
      lastError: expect.stringContaining('permit_invalid'),
    });
    for (let i = 1; i < OUTBOX_MAX_ATTEMPTS; i++) {
      await drainOutbox(db, rejecting);
    }
    expect(outbox[0]?.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    expect(outbox[0]?.last_error).toContain('permit_invalid');

    // Exhausted: subsequent drains no longer even read the row…
    const calls = jest.fn(rejecting.syncShots);
    const result = await drainOutbox(db, { ...rejecting, syncShots: calls });
    expect(calls).not.toHaveBeenCalled();
    expect(result).toMatchObject({ synced: 0, failed: 0, remaining: 1 });

    // …there is still no receipt (nothing was accepted)…
    expect(await hasShotSyncReceipt(db, permittedAnalysis.id)).toBe(false);
    // …but the outbox status names the dead end, with the server's reason,
    // so the UI can stop promising the server will accept it.
    expect(await getShotOutboxStatus(db, permittedAnalysis.id)).toEqual({
      state: 'exhausted',
      attempts: OUTBOX_MAX_ATTEMPTS,
      lastError: expect.stringContaining('permit_invalid'),
    });
    // A shot that was never queued is `absent`, not mistaken for pending.
    expect(await getShotOutboxStatus(db, 'never-queued')).toEqual({
      state: 'absent',
    });
  });

  it('a transient evaluation-trial upload failure leaves the attempt budget intact, exactly like shots and sessions', async () => {
    const { db, push, outbox } = fakeDb();
    push('shot.sync', permittedAnalysis);
    push('session.create', { id: 'session-1' });
    push('evaluation.trial', { trialId: 'trial-1' });
    const offline = async () => {
      throw new TypeError('Network request failed');
    };
    await drainOutbox(db, {
      syncShots: offline,
      createSession: offline,
      finalizeSession: offline,
      uploadEvaluationTrials: offline,
    });
    const byKind = Object.fromEntries(outbox.map(r => [r.kind, r.attempts]));
    expect(byKind['shot.sync']).toBe(0);
    expect(byKind['session.create']).toBe(0);
    expect(byKind['evaluation.trial']).toBe(0);
    const trial = outbox.find(r => r.kind === 'evaluation.trial');
    expect(trial?.last_error).toContain('Network request failed');
  });
});
