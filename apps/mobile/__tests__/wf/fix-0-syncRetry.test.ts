/**
 * Outbox retry hygiene: per-item rejections the server marks as its own
 * (transient) failure keep the row's attempt budget intact, and the runtime's
 * retry cadence backs off exponentially with jitter instead of every device
 * retrying on the same fixed beat.
 */
import type { LocalDb } from '../../src/data/db';
import {
  OUTBOX_MAX_ATTEMPTS,
  drainOutbox,
  isTransientSyncRejection,
  type SyncTransport,
} from '../../src/data/sync';
import {
  SYNC_RETRY_BASE_MS,
  SYNC_RETRY_JITTER_RATIO,
  SYNC_RETRY_MAX_MS,
  nextSyncRetryDelayMs,
} from '../../src/data/syncRuntime';
import {
  GUEST_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));

interface OutboxRow {
  id: number;
  owner_key: string;
  kind: string;
  payload: string;
  attempts: number;
  last_error: string | null;
}

function fakeDb() {
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
  const push = (kind: string, payload: unknown) => {
    outbox.push({
      id: nextId++,
      owner_key: GUEST_DATA_OWNER,
      kind,
      payload: JSON.stringify(payload),
      attempts: 0,
      last_error: null,
    });
  };
  return { db, push, outbox };
}

const SHOT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const analysis = {
  id: SHOT_ID,
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

const TRIAL_ID = 'dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function transportRejectingShots(code: string): SyncTransport {
  return {
    syncShots: jest.fn(async () => ({
      acceptedIds: [],
      rejected: [{ id: SHOT_ID, code, message: `server said ${code}` }],
    })),
    uploadEvaluationTrials: jest.fn(async () => ({
      acceptedTrialIds: [],
      rejected: [],
    })),
  } as unknown as SyncTransport;
}

beforeEach(() => {
  setActiveDataOwner(GUEST_DATA_OWNER);
});

describe('transient per-item rejections keep the attempt budget', () => {
  it.each([
    'shot.write_failed',
    'evaluation.trial_write_failed',
    'auth.required',
  ])('%s is transient', code => {
    expect(isTransientSyncRejection(code)).toBe(true);
  });

  it.each([
    'shot.invalid_payload',
    'shot.id_conflict',
    'access.paywall_required',
  ])('%s is a permanent verdict', code => {
    expect(isTransientSyncRejection(code)).toBe(false);
  });

  it('a server-side write failure records the reason without burning an attempt', async () => {
    const { db, push, outbox } = fakeDb();
    push('shot.sync', analysis);
    const transport = transportRejectingShots('shot.write_failed');

    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS + 2; i += 1) {
      const result = await drainOutbox(db, transport);
      expect(result.failed).toBe(1);
      expect(result.remaining).toBe(1);
    }
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.attempts).toBe(0);
    expect(outbox[0]!.last_error).toContain('shot.write_failed');
    expect(transport.syncShots).toHaveBeenCalledTimes(OUTBOX_MAX_ATTEMPTS + 2);
  });

  it('a contract rejection still consumes the bounded budget', async () => {
    const { db, push, outbox } = fakeDb();
    push('shot.sync', analysis);
    const transport = transportRejectingShots('shot.invalid_payload');

    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i += 1) {
      await drainOutbox(db, transport);
    }
    expect(outbox[0]!.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    const parked = await drainOutbox(db, transport);
    expect(parked.failed).toBe(0);
    expect(transport.syncShots).toHaveBeenCalledTimes(OUTBOX_MAX_ATTEMPTS);
  });

  it('one corrupt trial row fails alone; the well-formed trial still uploads', async () => {
    const { db, outbox } = fakeDb();
    outbox.push({
      id: 1,
      owner_key: GUEST_DATA_OWNER,
      kind: 'evaluation.trial',
      payload: '{not json',
      attempts: 0,
      last_error: null,
    });
    outbox.push({
      id: 2,
      owner_key: GUEST_DATA_OWNER,
      kind: 'evaluation.trial',
      payload: JSON.stringify({ trialId: TRIAL_ID, schemaVersion: 1 }),
      attempts: 0,
      last_error: null,
    });
    const transport = {
      syncShots: jest.fn(),
      uploadEvaluationTrials: jest.fn(
        async (trials: Array<{ trialId: string }>) => ({
          acceptedTrialIds: trials.map(t => t.trialId),
          rejected: [],
        }),
      ),
    } as unknown as SyncTransport;

    const result = await drainOutbox(db, transport);
    expect(result).toEqual({ synced: 1, failed: 1, remaining: 1 });
    expect(transport.uploadEvaluationTrials).toHaveBeenCalledTimes(1);
    expect(transport.uploadEvaluationTrials).toHaveBeenCalledWith([
      { trialId: TRIAL_ID, schemaVersion: 1 },
    ]);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.id).toBe(1);
    expect(outbox[0]!.attempts).toBe(1);
  });
});

describe('nextSyncRetryDelayMs', () => {
  it('doubles per consecutive failure and is capped', () => {
    const fixed = () => 0.5;
    expect(nextSyncRetryDelayMs(0, fixed)).toBe(SYNC_RETRY_BASE_MS);
    expect(nextSyncRetryDelayMs(1, fixed)).toBe(SYNC_RETRY_BASE_MS * 2);
    expect(nextSyncRetryDelayMs(2, fixed)).toBe(SYNC_RETRY_BASE_MS * 4);
    expect(nextSyncRetryDelayMs(3, fixed)).toBe(SYNC_RETRY_BASE_MS * 8);
    expect(nextSyncRetryDelayMs(4, fixed)).toBe(SYNC_RETRY_MAX_MS);
    expect(nextSyncRetryDelayMs(50, fixed)).toBe(SYNC_RETRY_MAX_MS);
  });

  it('jitter stays within ±ratio of the base and never goes negative', () => {
    const low = nextSyncRetryDelayMs(0, () => 0);
    const high = nextSyncRetryDelayMs(0, () => 1);
    expect(low).toBe(
      Math.round(SYNC_RETRY_BASE_MS * (1 - SYNC_RETRY_JITTER_RATIO)),
    );
    expect(high).toBe(
      Math.round(SYNC_RETRY_BASE_MS * (1 + SYNC_RETRY_JITTER_RATIO)),
    );
    for (let i = 0; i < 200; i += 1) {
      const delay = nextSyncRetryDelayMs(i % 12);
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(
        Math.round(SYNC_RETRY_MAX_MS * (1 + SYNC_RETRY_JITTER_RATIO)),
      );
    }
  });
});
