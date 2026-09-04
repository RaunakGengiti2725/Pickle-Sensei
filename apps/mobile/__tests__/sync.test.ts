/** Outbox sync engine tests over a fake LocalDb (no native module needed). */
import type { LocalDb } from '../src/data/db';
import {
  drainOutbox,
  OUTBOX_MAX_ATTEMPTS,
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
  interface LocalSessionRow {
    owner_key: string;
    id: string;
    mode: string;
    shot_type: string | null;
    focus_checkpoint: string | null;
    started_at: string;
  }
  const outbox: OutboxRow[] = [];
  const sessions: LocalSessionRow[] = [];
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
        const kind = /VALUES \(\?, '([a-z.]+)', \?\)/.exec(sql)?.[1];
        outbox.push({
          id: nextId++,
          owner_key: String(params[0]),
          kind: kind ?? String(params[1]),
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
      if (sql.startsWith('SELECT id, attempts, payload FROM outbox')) {
        return {
          rows: outbox
            .filter(
              r =>
                r.owner_key === String(params[0]) &&
                r.kind === 'session.create',
            )
            .map(r => ({ id: r.id, attempts: r.attempts, payload: r.payload })),
        };
      }
      if (sql.startsWith('SELECT id, mode, shot_type')) {
        return {
          rows: sessions
            .filter(
              s => s.owner_key === String(params[0]) && s.id === params[1],
            )
            .map(s => ({
              id: s.id,
              mode: s.mode,
              shot_type: s.shot_type,
              focus_checkpoint: s.focus_checkpoint,
              started_at: s.started_at,
            })),
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
  const push = (
    kind: string,
    payload: unknown,
    owner = GUEST_DATA_OWNER,
    attempts = 0,
  ) => {
    outbox.push({
      id: nextId++,
      owner_key: owner,
      kind,
      payload: JSON.stringify(payload),
      attempts,
      last_error: null,
    });
  };
  const pushSession = (
    session: Omit<LocalSessionRow, 'owner_key'>,
    owner = GUEST_DATA_OWNER,
  ) => {
    sessions.push({ owner_key: owner, ...session });
  };
  return { db, push, pushSession, outbox, receipts };
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

  describe('shot.session_not_found makes progress on every drain', () => {
    const sessionId = '11111111-2222-4333-8444-555555555555';
    const notFound = {
      id: analysis.id,
      code: SESSION_NOT_FOUND_REJECTION,
      message: 'Session not found or not yours.',
    };

    it('does not spend the retry budget while a retryable session.create row is still queued (ordering artifact)', async () => {
      // The session.create row is behind a transient failure (offline); the
      // shot's rejection is the ordering artifact the row will resolve on
      // the next pass, so the shot keeps its full attempt budget.
      const { db, push, outbox } = fakeDb();
      push('shot.sync', { ...permittedAnalysis, sessionId });
      push('session.create', { id: sessionId, mode: 'practice_set' });
      const result = await drainOutbox(db, {
        syncShots: async () => ({ acceptedIds: [], rejected: [notFound] }),
        createSession: async () => {
          throw new Error('offline');
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

    it('re-queues session.create from the local session row when the sync entry is gone, then syncs the shot', async () => {
      const { db, push, pushSession, outbox, receipts } = fakeDb();
      push('shot.sync', { ...permittedAnalysis, sessionId });
      pushSession({
        id: sessionId,
        mode: 'practice_set',
        shot_type: 'forehand_drive',
        focus_checkpoint: null,
        started_at: '2026-08-26T17:59:00.000Z',
      });
      const known = new Set<string>();
      const calls: string[] = [];
      const transport = {
        syncShots: async (shots: unknown[]) => {
          calls.push('syncShots');
          const [shot] = shots as Array<{ id: string; sessionId: string }>;
          return known.has(shot!.sessionId)
            ? { acceptedIds: [shot!.id], rejected: [] }
            : { acceptedIds: [], rejected: [notFound] };
        },
        createSession: async (session: unknown) => {
          calls.push('createSession');
          known.add((session as { id: string }).id);
        },
        finalizeSession: async () => {},
      };
      const first = await drainOutbox(db, transport);
      expect(first).toMatchObject({ synced: 0, failed: 1, remaining: 2 });
      expect(outbox[0]).toMatchObject({ kind: 'shot.sync', attempts: 1 });
      expect(outbox[0]!.last_error).toContain(SESSION_NOT_FOUND_REJECTION);
      expect(outbox[1]).toMatchObject({
        kind: 'session.create',
        attempts: 0,
        payload: JSON.stringify({
          id: sessionId,
          mode: 'practice_set',
          shotType: 'forehand_drive',
          focusCheckpoint: null,
          startedAt: '2026-08-26T17:59:00.000Z',
        }),
      });

      const second = await drainOutbox(db, transport);
      expect(calls).toEqual(['syncShots', 'createSession', 'syncShots']);
      expect(second).toMatchObject({ synced: 2, failed: 0, remaining: 0 });
      expect(outbox).toHaveLength(0);
      expect(receipts).toEqual([
        { owner: GUEST_DATA_OWNER, entityId: analysis.id },
      ]);
    });

    it('re-queues session.create only once — a second not_found with the row queued spends no budget', async () => {
      const { db, push, pushSession, outbox } = fakeDb();
      push('shot.sync', { ...permittedAnalysis, sessionId });
      pushSession({
        id: sessionId,
        mode: 'practice_set',
        shot_type: null,
        focus_checkpoint: null,
        started_at: '2026-08-26T17:59:00.000Z',
      });
      const transport = {
        syncShots: async () => ({ acceptedIds: [], rejected: [notFound] }),
        createSession: async () => {
          throw new Error('offline');
        },
        finalizeSession: async () => {},
      };
      await drainOutbox(db, transport);
      await drainOutbox(db, transport);
      await drainOutbox(db, transport);
      expect(outbox.filter(r => r.kind === 'session.create')).toHaveLength(1);
      expect(outbox[0]).toMatchObject({ kind: 'shot.sync', attempts: 1 });
    });

    it('N consecutive not_found drains with no session.create row and no local session spend the budget and end terminal', async () => {
      // The set's session was never committed (commitPracticeSet failed and
      // nothing can repair it): every drain is progress, and the row stops
      // being retried once the budget is spent, with the reason on the row.
      const { db, push, outbox } = fakeDb();
      push('shot.sync', { ...permittedAnalysis, sessionId });
      let syncCalls = 0;
      const transport = {
        syncShots: async () => {
          syncCalls += 1;
          return { acceptedIds: [], rejected: [notFound] };
        },
        createSession: async () => {},
        finalizeSession: async () => {},
      };
      for (let n = 1; n <= OUTBOX_MAX_ATTEMPTS; n++) {
        const result = await drainOutbox(db, transport);
        expect(result).toMatchObject({ synced: 0, failed: 1, remaining: 1 });
        expect(outbox).toHaveLength(1);
        expect(outbox[0]!.attempts).toBe(n);
        expect(outbox[0]!.last_error).toContain(SESSION_NOT_FOUND_REJECTION);
      }
      expect(syncCalls).toBe(OUTBOX_MAX_ATTEMPTS);
      expect(outbox[0]!.last_error).toContain('no local session');
      expect(outbox[0]!.last_error).toContain('will not sync');

      // Terminal: the row is no longer eligible and the server is not asked again.
      const after = await drainOutbox(db, transport);
      expect(after).toMatchObject({ synced: 0, failed: 0, remaining: 1 });
      expect(syncCalls).toBe(OUTBOX_MAX_ATTEMPTS);
      expect(outbox[0]!.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    });

    it('a shot behind an exhausted session.create row spends its budget too, naming the exhausted row', async () => {
      const { db, push, outbox } = fakeDb();
      push('shot.sync', { ...permittedAnalysis, sessionId });
      push(
        'session.create',
        { id: sessionId, mode: 'practice_set' },
        GUEST_DATA_OWNER,
        OUTBOX_MAX_ATTEMPTS,
      );
      const transport = {
        syncShots: async () => ({ acceptedIds: [], rejected: [notFound] }),
        createSession: async () => {
          throw new Error('must not be asked: the row is exhausted');
        },
        finalizeSession: async () => {},
      };
      for (let n = 1; n <= OUTBOX_MAX_ATTEMPTS; n++) {
        await drainOutbox(db, transport);
        expect(outbox[0]!.attempts).toBe(n);
      }
      expect(outbox[0]!.last_error).toContain(SESSION_NOT_FOUND_REJECTION);
      expect(outbox[0]!.last_error).toContain('exhausted');
      expect(outbox).toHaveLength(2);
      const after = await drainOutbox(db, transport);
      expect(after).toMatchObject({ synced: 0, failed: 0, remaining: 2 });
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
