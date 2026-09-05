/**
 * Gate 11 (mobile failure modes) — data-layer certification at jest level.
 *
 * Native execution is BLOCKED_EXTERNAL (no iPhone/Mac in this environment);
 * these tests certify the JS contracts the failure modes flow through:
 *   - network offline / drop during upload → durable outbox, bounded retry
 *   - slow backend → every API request is time-bounded (typed 408, no hang)
 *   - API failure → transient (5xx) vs permanent (4xx) classification
 *   - expired auth → 401 is transient: rows survive until a fresh sign-in
 *   - backgrounded / foregrounded → AppState 'active' re-triggers the drain
 *   - sign-out during pending work → runtime cleared; no cross-account drain
 */
import { AppState } from 'react-native';
import type { LocalDb } from '../src/data/db';
import { ApiError, api, API_REQUEST_TIMEOUT_MS } from '../src/data/api';
import {
  OUTBOX_MAX_ATTEMPTS,
  drainOutbox,
  isPermanentSyncFailure,
} from '../src/data/sync';
import {
  clearSyncRuntime,
  configureSyncRuntime,
  triggerOutboxSync,
} from '../src/data/syncRuntime';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../src/data/accountScope';

jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));

import { getDb } from '../src/data/db';

function fakeDb() {
  interface OutboxRow {
    id: number;
    owner_key: string;
    kind: string;
    payload: string;
    attempts: number;
    last_error: string | null;
  }
  const outbox: OutboxRow[] = [];
  let nextId = 1;
  const db: LocalDb = {
    async execute(sql: string, params: unknown[] = []) {
      if (sql === 'BEGIN IMMEDIATE' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('INSERT OR REPLACE INTO sync_receipt')) {
        return { rows: [] };
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
      if (sql.startsWith('DELETE FROM outbox')) {
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
          const quarantine = /SET attempts = (\d+),/.exec(sql);
          if (quarantine) row.attempts = Number(quarantine[1]);
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
  return { db, push, outbox };
}

const permittedAnalysis = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
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
  analysisPermitId: 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee',
};

describe('Gate 11 — transient vs permanent sync-failure classification', () => {
  it('classifies offline / network faults as transient', () => {
    expect(isPermanentSyncFailure(new Error('Network request failed'))).toBe(
      false,
    );
    expect(isPermanentSyncFailure(new TypeError('fetch failed'))).toBe(false);
  });

  it('classifies server 5xx as transient', () => {
    expect(isPermanentSyncFailure(new ApiError(500, 'internal', 'boom'))).toBe(
      false,
    );
    expect(
      isPermanentSyncFailure(new ApiError(503, 'unavailable', 'down')),
    ).toBe(false);
  });

  it('classifies expired auth (401), timeout (408), throttling (429) as transient', () => {
    expect(
      isPermanentSyncFailure(new ApiError(401, 'auth.expired', 'expired')),
    ).toBe(false);
    expect(
      isPermanentSyncFailure(new ApiError(408, 'network.timeout', 'slow')),
    ).toBe(false);
    expect(
      isPermanentSyncFailure(new ApiError(429, 'rate.limited', 'later')),
    ).toBe(false);
  });

  it('classifies unretryable 4xx as permanent', () => {
    expect(
      isPermanentSyncFailure(new ApiError(422, 'shot.invalid', 'bad')),
    ).toBe(true);
    expect(
      isPermanentSyncFailure(new ApiError(403, 'access.denied', 'no')),
    ).toBe(true);
  });
});

describe('Gate 11 — drop during upload / expired auth keep rows durable', () => {
  beforeEach(() => setActiveDataOwner(GUEST_DATA_OWNER));
  afterAll(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

  const noopSessionTransport = {
    createSession: async () => {},
    finalizeSession: async () => {},
  };

  it('a server 5xx mid-upload never consumes the attempt budget', async () => {
    const { db, push, outbox } = fakeDb();
    push('shot.sync', permittedAnalysis);
    const result = await drainOutbox(db, {
      syncShots: async () => {
        throw new ApiError(503, 'unavailable', 'deploy in progress');
      },
      ...noopSessionTransport,
    });
    expect(result).toMatchObject({ synced: 0, failed: 1, remaining: 1 });
    expect(outbox[0]!.attempts).toBe(0);
    expect(outbox[0]!.last_error).toContain('deploy in progress');
  });

  it('an expired bearer (401) keeps the shot queued for after re-auth', async () => {
    const { db, push, outbox } = fakeDb();
    push('shot.sync', permittedAnalysis);
    const result = await drainOutbox(db, {
      syncShots: async () => {
        throw new ApiError(401, 'auth.expired', 'token expired');
      },
      ...noopSessionTransport,
    });
    expect(result).toMatchObject({ synced: 0, failed: 1, remaining: 1 });
    expect(outbox[0]!.attempts).toBe(0);
  });

  it('a permanently rejected payload (422) consumes bounded attempts', async () => {
    const { db, push, outbox } = fakeDb();
    push('shot.sync', permittedAnalysis);
    const failing = {
      syncShots: async () => {
        throw new ApiError(422, 'shot.invalid', 'schema mismatch');
      },
      ...noopSessionTransport,
    };
    for (let attempt = 0; attempt < 8; attempt++) {
      await drainOutbox(db, failing);
    }
    expect(outbox[0]!.attempts).toBe(8);
    // Exhausted rows are excluded from the drain but stay durable on device.
    const after = await drainOutbox(db, failing);
    expect(after).toMatchObject({ synced: 0, failed: 0, remaining: 1 });
    expect(outbox[0]!.attempts).toBe(8);
  });

  it('a corrupt outbox payload fails alone without poisoning the batch', async () => {
    const { db, push, outbox } = fakeDb();
    push('shot.sync', permittedAnalysis);
    outbox.push({
      id: 999,
      owner_key: GUEST_DATA_OWNER,
      kind: 'shot.sync',
      payload: '{not json',
      attempts: 0,
      last_error: null,
    });
    const result = await drainOutbox(db, {
      syncShots: async shots => ({
        acceptedIds: shots.map(shot => (shot as { id: string }).id),
        rejected: [],
      }),
      ...noopSessionTransport,
    });
    // Fix round 9 (Q1.4): the quarantined row is reported apart from `failed`
    // — the server never saw it, so it must not move the owner's back-off.
    expect(result).toEqual({
      synced: 1,
      failed: 0,
      remaining: 1,
      quarantined: 1,
    });
    const corrupt = outbox.find(row => row.id === 999);
    // Fix round 8 (S1): a row that can never become a request is quarantined
    // ONCE — its whole budget is spent in that one drain with a truthful
    // last_error — so no later drain re-reads, re-charges or reports it.
    // (It used to be charged one attempt per drain, eight failing drains.)
    expect(corrupt?.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    expect(corrupt?.last_error).not.toBeNull();
  });
});

describe('Gate 11 — slow backend: every API request is time-bounded', () => {
  afterEach(() => {
    jest.useRealTimers();
    delete (globalThis as { fetch?: unknown }).fetch;
  });

  it('a backend that never responds surfaces a typed 408, not a hang', async () => {
    jest.useFakeTimers();
    (globalThis as { fetch?: unknown }).fetch = jest.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(new Error('Aborted')),
          );
        }),
    );
    const pending = api.request(
      { baseUrl: 'https://api.test', token: 'bearer' },
      'POST',
      '/v1/shots:sync',
      { shots: [] },
    );
    const settled = pending.catch((error: unknown) => error);
    jest.advanceTimersByTime(API_REQUEST_TIMEOUT_MS + 1);
    const error = await settled;
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(408);
    expect((error as ApiError).code).toBe('network.timeout');
    expect(isPermanentSyncFailure(error)).toBe(false);
  });

  it('a genuine network fault is rethrown untouched (still transient)', async () => {
    (globalThis as { fetch?: unknown }).fetch = jest.fn(() =>
      Promise.reject(new TypeError('Network request failed')),
    );
    await expect(
      api.request(
        { baseUrl: 'https://api.test', token: 'bearer' },
        'GET',
        '/v1/anything',
      ),
    ).rejects.toThrow('Network request failed');
  });
});

describe('Gate 11 — backgrounding and sign-out during pending work', () => {
  const session = {
    canonicalAppUserId: '33333333-3333-4333-8333-333333333333',
    apiBaseUrl: 'https://api.test',
    bearerToken: 'bearer-token',
  } as Parameters<typeof configureSyncRuntime>[0];

  let drains: number;

  beforeEach(() => {
    drains = 0;
    const { db, push } = fakeDb();
    push(
      'shot.sync',
      permittedAnalysis,
      canonicalDataOwner(session.canonicalAppUserId),
    );
    (getDb as jest.Mock).mockReturnValue(db);
    setActiveDataOwner(canonicalDataOwner(session.canonicalAppUserId));
    (globalThis as { fetch?: unknown }).fetch = jest.fn(() => {
      drains += 1;
      return Promise.reject(new TypeError('Network request failed'));
    });
  });

  afterEach(() => {
    clearSyncRuntime();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    delete (globalThis as { fetch?: unknown }).fetch;
    jest.restoreAllMocks();
  });

  it('returning to the foreground re-triggers the outbox drain', async () => {
    let appStateHandler: ((state: string) => void) | null = null;
    jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_event, handler) => {
        appStateHandler = handler as (state: string) => void;
        return { remove: () => {} } as ReturnType<
          typeof AppState.addEventListener
        >;
      });
    configureSyncRuntime(session);
    await Promise.resolve();
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
    const drainsAfterConfigure = drains;
    expect(drainsAfterConfigure).toBeGreaterThanOrEqual(1);
    expect(appStateHandler).not.toBeNull();
    appStateHandler!('active');
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
    expect(drains).toBeGreaterThan(drainsAfterConfigure);
  });

  it('sign-out during pending work stops all future drains — fail closed', async () => {
    configureSyncRuntime(session);
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
    const drainsBeforeSignOut = drains;
    clearSyncRuntime();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    triggerOutboxSync();
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
    expect(drains).toBe(drainsBeforeSignOut);
  });

  it('a stale trigger from a previous account never drains the new owner', async () => {
    configureSyncRuntime(session);
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
    const drainsBefore = drains;
    // The account switches but a queued trigger from the old runtime fires.
    setActiveDataOwner(
      canonicalDataOwner('44444444-4444-4444-8444-444444444444'),
    );
    triggerOutboxSync();
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
    expect(drains).toBe(drainsBefore);
  });
});
