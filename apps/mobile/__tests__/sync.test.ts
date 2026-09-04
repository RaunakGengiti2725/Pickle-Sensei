/** Outbox sync engine tests over a fake LocalDb (no native module needed). */
import type { LocalDb } from '../src/data/db';
import {
  drainOutbox,
  SESSION_NOT_FOUND_REJECTION,
  toSyncPayload,
} from '../src/data/sync';
import type { ShotAnalysis } from '@pickle/shared-types';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';

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
  const receipts: Array<{ owner: string; entityId: string }> = [];
  let nextId = 1;
  const db: LocalDb = {
    async execute(sql: string, params: unknown[] = []) {
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
      if (sql.includes('INSERT INTO outbox')) {
        outbox.push({
          id: nextId++,
          owner_key: String(params[0]),
          kind: String(params[1] ?? 'shot.sync'),
          payload: String(params[params.length - 1]),
          attempts: 0,
          last_error: null,
        });
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
      if (sql.startsWith('SELECT 1 FROM outbox')) {
        const hit = outbox.some(r => {
          if (
            r.owner_key !== params[0] ||
            r.attempts >= Number(params[1]) ||
            r.kind !== 'session.create'
          ) {
            return false;
          }
          try {
            return (JSON.parse(r.payload) as { id?: unknown }).id === params[2];
          } catch {
            return false;
          }
        });
        return { rows: hit ? [{ '1': 1 }] : [] };
      }
      if (sql.startsWith('SELECT mode, shot_type')) {
        return { rows: [] };
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
  return { db, push, outbox, receipts };
}

const analysis: ShotAnalysis = {
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
};

const analysisPermitId = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const permittedAnalysis = {
  ...analysis,
  analysisPermitId,
};

describe('toSyncPayload', () => {
  it('emits the canonical shot-sync shape with the full version vector', () => {
    const payload = toSyncPayload(analysis, analysisPermitId);
    expect(payload.id).toBe(analysis.id);
    expect(payload.analysisPermitId).toBe(analysisPermitId);
    expect(payload.capturedAt).toBe(analysis.capturedAtIso);
    expect(payload.confidence).toBe(analysis.analysisConfidence);
    expect(
      (payload.versionVector as Record<string, string>).scoringModelVersion,
    ).toBe('sm-v1');
  });
});

describe('drainOutbox', () => {
  beforeEach(() => setActiveDataOwner(GUEST_DATA_OWNER));
  afterAll(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

  it('syncs pending shots and clears the outbox', async () => {
    const { db, push, receipts } = fakeDb();
    push('shot.sync', permittedAnalysis);
    push('shot.sync', {
      ...permittedAnalysis,
      id: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    });
    const sent: unknown[][] = [];
    const result = await drainOutbox(db, {
      syncShots: async shots => {
        sent.push(shots);
        return {
          acceptedIds: shots.map(shot => (shot as { id: string }).id),
          rejected: [],
        };
      },
      createSession: async () => {},
      finalizeSession: async () => {},
    });
    expect(result.synced).toBe(2);
    expect(result.remaining).toBe(0);
    expect(sent[0]).toHaveLength(2);
    expect(receipts).toEqual([
      { owner: GUEST_DATA_OWNER, entityId: analysis.id },
      {
        owner: GUEST_DATA_OWNER,
        entityId: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      },
    ]);
  });

  it('keeps offline failures durable and retryable forever — transient errors never consume the attempt budget', async () => {
    const { db, push, outbox } = fakeDb();
    push('shot.sync', permittedAnalysis);
    const failing = {
      syncShots: async () => {
        throw new Error('offline');
      },
      createSession: async () => {},
      finalizeSession: async () => {},
    };
    const first = await drainOutbox(db, failing);
    expect(first.failed).toBe(1);
    expect(first.remaining).toBe(1);
    expect(outbox[0]!.attempts).toBe(0);
    expect(outbox[0]!.last_error).toContain('offline');
    const second = await drainOutbox(db, failing);
    expect(second.remaining).toBe(1);
    expect(outbox[0]!.attempts).toBe(0);
  });

  it('keeps server-rejected shots queued with the typed rejection', async () => {
    const { db, push, outbox } = fakeDb();
    push('shot.sync', permittedAnalysis);
    const result = await drainOutbox(db, {
      syncShots: async () => ({
        acceptedIds: [],
        rejected: [
          {
            id: analysis.id,
            code: 'access.permit_not_reserved',
            message: 'Analysis permit is no longer reserved.',
          },
        ],
      }),
      createSession: async () => {},
      finalizeSession: async () => {},
    });
    expect(result).toMatchObject({ synced: 0, failed: 1, remaining: 1 });
    expect(outbox[0]).toMatchObject({
      attempts: 1,
      last_error:
        'access.permit_not_reserved: Analysis permit is no longer reserved.',
    });
  });

  it('does not spend the retry budget on a shot whose queued practice-set session has not synced yet', async () => {
    // The set's session.create row is queued with the shot; when the session
    // pass cannot reach the server this drain, the shot's session_not_found
    // is an ordering artifact, not a permanent failure, so the row keeps its
    // full attempt budget for the next pass.
    const { db, push, outbox } = fakeDb();
    const sessionId = '11111111-2222-4333-8444-555555555555';
    push('shot.sync', { ...permittedAnalysis, sessionId });
    push('session.create', { id: sessionId, mode: 'practice_set' });
    const result = await drainOutbox(db, {
      syncShots: async () => ({
        acceptedIds: [],
        rejected: [
          {
            id: analysis.id,
            code: SESSION_NOT_FOUND_REJECTION,
            message: 'Session not found or not yours.',
          },
        ],
      }),
      createSession: async () => {
        throw new TypeError('Network request failed');
      },
      finalizeSession: async () => {},
    });
    expect(result).toMatchObject({ synced: 0, failed: 2, remaining: 2 });
    expect(outbox[0]).toMatchObject({
      kind: 'shot.sync',
      attempts: 0,
      last_error: `${SESSION_NOT_FOUND_REJECTION}: Session not found or not yours.`,
    });
    expect(outbox[1]).toMatchObject({ kind: 'session.create', attempts: 0 });
  });

  it('counts the attempt on a shot whose practice set nothing on the device knows (bounded, not retried forever)', async () => {
    // No session.create row and no local session row can ever make the
    // server learn this set, so the shot spends its own budget one drain at
    // a time instead of being re-sent unchanged for as long as the app lives.
    const { db, push, outbox } = fakeDb();
    push('shot.sync', {
      ...permittedAnalysis,
      sessionId: '11111111-2222-4333-8444-555555555555',
    });
    const result = await drainOutbox(db, {
      syncShots: async () => ({
        acceptedIds: [],
        rejected: [
          {
            id: analysis.id,
            code: SESSION_NOT_FOUND_REJECTION,
            message: 'Session not found or not yours.',
          },
        ],
      }),
      createSession: async () => {},
      finalizeSession: async () => {},
    });
    expect(result).toMatchObject({ synced: 0, failed: 1, remaining: 1 });
    expect(outbox[0]).toMatchObject({
      attempts: 1,
      last_error: `${SESSION_NOT_FOUND_REJECTION}: Session not found or not yours.`,
    });
  });

  it('fails closed when a legacy outbox row has no permit', async () => {
    const { db, push, outbox } = fakeDb();
    push('shot.sync', analysis);
    const result = await drainOutbox(db, {
      syncShots: async () => ({ acceptedIds: [], rejected: [] }),
      createSession: async () => {},
      finalizeSession: async () => {},
    });
    expect(result).toMatchObject({ synced: 0, failed: 1, remaining: 1 });
    expect(outbox[0]?.last_error).toContain(
      'shot.sync_missing_analysis_permit',
    );
  });

  it('processes session outbox kinds through their endpoints', async () => {
    const { db, push } = fakeDb();
    push('session.create', { id: 's1', mode: 'live' });
    push('session.finalize', { id: 's1' });
    const calls: string[] = [];
    const result = await drainOutbox(db, {
      syncShots: async () => ({ acceptedIds: [], rejected: [] }),
      createSession: async () => void calls.push('create'),
      finalizeSession: async id => void calls.push(`finalize:${id}`),
    });
    expect(result.synced).toBe(2);
    expect(calls).toEqual(['create', 'finalize:s1']);
  });

  it('creates a session before syncing the shot that references it (same batch)', async () => {
    // A practice set queues session.create and its first shot.sync together;
    // the server rejects a shot whose session it has never seen
    // (shot.session_not_found), so the session row must drain FIRST even
    // though the shot row was enqueued in the same batch.
    const sessionId = 'dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const { db, push, outbox } = fakeDb();
    push('shot.sync', { ...permittedAnalysis, sessionId });
    push('session.create', {
      id: sessionId,
      mode: 'practice_set',
      shotType: 'forehand_drive',
      focusCheckpoint: null,
      startedAt: '2026-08-26T17:59:00.000Z',
    });
    const calls: string[] = [];
    const result = await drainOutbox(db, {
      syncShots: async shots => {
        calls.push('syncShots');
        expect(shots).toHaveLength(1);
        expect((shots[0] as { sessionId: string }).sessionId).toBe(sessionId);
        return {
          acceptedIds: shots.map(shot => (shot as { id: string }).id),
          rejected: [],
        };
      },
      createSession: async session => {
        calls.push('createSession');
        expect((session as { id: string }).id).toBe(sessionId);
      },
      finalizeSession: async () => void calls.push('finalizeSession'),
    });
    expect(calls).toEqual(['createSession', 'syncShots']);
    expect(result).toMatchObject({ synced: 2, failed: 0, remaining: 0 });
    expect(outbox).toHaveLength(0);
  });

  it('drains session.finalize ahead of shots too, keeping evaluation trials last', async () => {
    const { db, push } = fakeDb();
    push('shot.sync', permittedAnalysis);
    push('evaluation.trial', { trialId: 't1' });
    push('session.finalize', { id: 's1' });
    const calls: string[] = [];
    await drainOutbox(db, {
      syncShots: async shots => {
        calls.push('syncShots');
        return {
          acceptedIds: shots.map(shot => (shot as { id: string }).id),
          rejected: [],
        };
      },
      createSession: async () => void calls.push('createSession'),
      finalizeSession: async id => void calls.push(`finalize:${id}`),
      uploadEvaluationTrials: async trials => {
        calls.push('uploadEvaluationTrials');
        return {
          acceptedTrialIds: trials.map(
            trial => (trial as { trialId: string }).trialId,
          ),
          rejected: [],
        };
      },
    });
    expect(calls).toEqual([
      'finalize:s1',
      'syncShots',
      'uploadEvaluationTrials',
    ]);
  });

  it('never drains rows belonging to another account', async () => {
    const ownerA = '11111111-1111-4111-8111-111111111111';
    const ownerB = '22222222-2222-4222-8222-222222222222';
    const { db, push, outbox } = fakeDb();
    push('shot.sync', permittedAnalysis, ownerA);
    push(
      'shot.sync',
      {
        ...permittedAnalysis,
        id: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      },
      ownerB,
    );
    setActiveDataOwner(ownerA);
    const sent: unknown[] = [];
    const result = await drainOutbox(db, {
      syncShots: async shots => {
        sent.push(...shots);
        return {
          acceptedIds: shots.map(shot => (shot as { id: string }).id),
          rejected: [],
        };
      },
      createSession: async () => {},
      finalizeSession: async () => {},
    });
    expect(result).toMatchObject({ synced: 1, remaining: 0 });
    expect(sent).toHaveLength(1);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.owner_key).toBe(ownerB);
  });
});
