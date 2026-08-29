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
  saveAnalysis,
} from '../src/data/repository';

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
      expect.stringContaining('INSERT OR REPLACE INTO local_shot'),
      expect.stringContaining('INSERT INTO outbox'),
      'COMMIT',
    ]);
    expect(calls[1]?.params[0]).toBe(ownerA);
    expect(calls[2]?.params[0]).toBe(ownerA);
    expect(JSON.parse(String(calls[2]?.params[1]))).toMatchObject({
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
});
