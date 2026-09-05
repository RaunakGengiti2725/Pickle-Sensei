import type { ShotAnalysis } from '@pickle/shared-types';
import type { LocalDb } from '../src/data/db';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import {
  getAnalysis,
  hasShotSyncReceipt,
  listRealAnalysisFacts,
  OWNER_SCOPED_KV_NAMESPACES,
  saveAnalysis,
} from '../src/data/repository';
import { practiceSetKeyForOwner } from '../src/analysis/practiceSet';

const ownerA = '11111111-1111-4111-8111-111111111111';
const permitId = '22222222-2222-4222-8222-222222222222';

const analysis: ShotAnalysis = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  sessionId: null,
  shotType: 'forehand_drive',
  cameraView: 'side',
  handedness: 'right',
  capturedAtIso: '2026-08-27T18:00:00.000Z',
  timestamps: { startMs: 0, contactMs: 900, endMs: 1800 },
  phases: [],
  measurements: [],
  checkpoints: [],
  overallScore: 7.8,
  analysisConfidence: 0.91,
  resultKind: 'scored',
  guidance: null,
  priorityFix: null,
  versionVector: {
    appVersion: '0.1.0',
    modelBundleVersion: 'validated-bundle-1',
    poseModelVersion: 'pose-1',
    paddleModelVersion: 'paddle-1',
    strokeDetectorVersion: 'stroke-1',
    phaseModelVersion: 'phase-1',
    scoringModelVersion: 'score-1',
    shotConfigVersion: 'forehand_drive@1',
  },
  source: 'real',
};

describe('account-scoped local repository', () => {
  afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

  it('atomically binds a real score and outbox entry to one owner', async () => {
    setActiveDataOwner(ownerA);
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db: LocalDb = {
      async execute(sql, params = []) {
        calls.push({ sql, params });
        return { rows: [] };
      },
      close() {},
    };

    await saveAnalysis(db, analysis, permitId);

    expect(calls.map(call => call.sql)).toEqual([
      'BEGIN IMMEDIATE',
      // Idempotency read: is this analysis id already queued or receipted?
      expect.stringContaining('SELECT 1 AS known FROM outbox'),
      expect.stringContaining('INSERT OR REPLACE INTO local_shot'),
      expect.stringContaining('INSERT INTO outbox'),
      'COMMIT',
    ]);
    expect(calls[1]?.params).toEqual([
      ownerA,
      analysis.id,
      ownerA,
      analysis.id,
    ]);
    expect(calls[2]?.params[0]).toBe(ownerA);
    expect(calls[3]?.params[0]).toBe(ownerA);
    expect(JSON.parse(String(calls[3]?.params[1]))).toMatchObject({
      id: analysis.id,
      analysisPermitId: permitId,
      source: 'real',
    });
  });

  it('scopes reads and acceptance receipts to the active owner', async () => {
    setActiveDataOwner(ownerA);
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db: LocalDb = {
      async execute(sql, params = []) {
        calls.push({ sql, params });
        if (sql.includes('SELECT payload')) {
          return { rows: [{ payload: JSON.stringify(analysis) }] };
        }
        if (sql.includes('SELECT 1 FROM sync_receipt')) {
          return { rows: [{ 1: 1 }] };
        }
        return { rows: [] };
      },
      close() {},
    };

    await expect(getAnalysis(db, analysis.id)).resolves.toEqual(analysis);
    await expect(hasShotSyncReceipt(db, analysis.id)).resolves.toBe(true);
    expect(calls[0]?.params).toEqual([ownerA, analysis.id]);
    expect(calls[1]?.params).toEqual([ownerA, analysis.id]);
  });

  it('refuses product writes while signed out', async () => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    const db: LocalDb = {
      async execute() {
        throw new Error('database should not be reached');
      },
      close() {},
    };
    await expect(saveAnalysis(db, analysis, permitId)).rejects.toThrow(
      'Sign in or continue locally',
    );
  });

  it('keeps legacy local use in its explicit guest bucket', () => {
    setActiveDataOwner(GUEST_DATA_OWNER);
    expect(GUEST_DATA_OWNER).toBe('device-guest');
  });

  it('pins every owner-scoped kv namespace to its key builder', () => {
    // A namespace missing here escapes account deletion; a key builder that
    // drifts from the list leaves orphaned rows behind.
    expect(OWNER_SCOPED_KV_NAMESPACES).toEqual([
      'profile',
      'rank.celebrated',
      'notifications',
      'consistency',
      'practice.set',
    ]);
    expect(practiceSetKeyForOwner(ownerA)).toBe(`practice.set:${ownerA}`);
  });

  it('exposes the practice-set tie, priority checkpoint, and applicable checkpoint scores as facts', async () => {
    setActiveDataOwner(ownerA);
    const sessionId = '33333333-3333-4333-8333-333333333333';
    const withSet: ShotAnalysis = {
      ...analysis,
      sessionId,
      priorityFix: {
        checkpoint: 'contact_position',
        reasonKey: 'lowest_applicable',
        severity: 0.6,
        confidence: 0.8,
      },
      checkpoints: [
        {
          key: 'contact_position',
          score: 48,
          confidence: 0.8,
          band: 'red',
          direction: 'late',
          severity: 0.6,
          applicable: true,
        },
        {
          key: 'follow_through',
          score: 81,
          confidence: 0.8,
          band: 'green',
          direction: 'none',
          severity: 0,
          applicable: true,
        },
        // Non-applicable and unobserved checkpoints never become scores.
        {
          key: 'recovery',
          score: 90,
          confidence: 0.8,
          band: 'green',
          direction: 'none',
          severity: 0,
          applicable: false,
        },
        {
          key: 'paddle_set',
          score: null,
          confidence: 0,
          band: 'unscored',
          direction: 'none',
          severity: 0,
          applicable: true,
        },
      ],
    };
    const db: LocalDb = {
      async execute() {
        return {
          rows: [
            { payload: JSON.stringify(withSet) },
            { payload: JSON.stringify(analysis) },
          ],
        };
      },
      close() {},
    };
    const facts = await listRealAnalysisFacts(db);
    expect(facts).toHaveLength(2);
    expect(facts[0]).toMatchObject({
      id: analysis.id,
      sessionId,
      priorityCheckpoint: 'contact_position',
      checkpointScores: { contact_position: 48, follow_through: 81 },
    });
    expect(facts[1]).toMatchObject({
      sessionId: null,
      priorityCheckpoint: null,
      checkpointScores: {},
    });
  });
});
