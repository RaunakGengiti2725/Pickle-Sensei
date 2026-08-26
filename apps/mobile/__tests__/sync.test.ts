/** Outbox sync engine tests over a fake LocalDb (no native module needed). */
import type { LocalDb } from '../src/data/db';
import { drainOutbox, toSyncPayload } from '../src/data/sync';
import type { ShotAnalysis } from '@pickle/shared-types';

function fakeDb() {
  interface OutboxRow {
    id: number;
    kind: string;
    payload: string;
    attempts: number;
    last_error: string | null;
  }
  const outbox: OutboxRow[] = [];
  let nextId = 1;
  const db: LocalDb = {
    async execute(sql: string, params: unknown[] = []) {
      if (sql.includes('INSERT INTO outbox')) {
        outbox.push({
          id: nextId++,
          kind: String(params[0] ?? 'shot.sync'),
          payload: String(params[params.length - 1]),
          attempts: 0,
          last_error: null,
        });
        return { rows: [] };
      }
      if (sql.startsWith('SELECT id, kind, payload')) {
        return {
          rows: outbox
            .filter(r => r.attempts < Number(params[0]))
            .map(r => ({ ...r })),
        };
      }
      if (sql.startsWith('DELETE FROM outbox')) {
        const idx = outbox.findIndex(r => r.id === params[0]);
        if (idx >= 0) outbox.splice(idx, 1);
        return { rows: [] };
      }
      if (sql.startsWith('UPDATE outbox')) {
        const row = outbox.find(r => r.id === params[1]);
        if (row) {
          row.attempts += 1;
          row.last_error = String(params[0]);
        }
        return { rows: [] };
      }
      if (sql.startsWith('SELECT count(*)')) {
        return { rows: [{ n: outbox.length }] };
      }
      throw new Error(`fakeDb: unhandled sql ${sql}`);
    },
    close() {},
  };
  const push = (kind: string, payload: unknown) => {
    outbox.push({
      id: nextId++,
      kind,
      payload: JSON.stringify(payload),
      attempts: 0,
      last_error: null,
    });
  };
  return { db, push, outbox };
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
    modelBundleVersion: 'fixture-1',
    poseModelVersion: 'fixture-1',
    paddleModelVersion: 'fixture-1',
    strokeDetectorVersion: 'fixture-1',
    phaseModelVersion: 'fixture-1',
    scoringModelVersion: 'sm-v1',
    shotConfigVersion: 'forehand_drive@1',
  },
  source: 'fixture',
};

describe('toSyncPayload', () => {
  it('emits the canonical shot-sync shape with the full version vector', () => {
    const payload = toSyncPayload(analysis);
    expect(payload.id).toBe(analysis.id);
    expect(payload.capturedAt).toBe(analysis.capturedAtIso);
    expect(payload.confidence).toBe(analysis.analysisConfidence);
    expect(
      (payload.versionVector as Record<string, string>).scoringModelVersion,
    ).toBe('sm-v1');
  });
});

describe('drainOutbox', () => {
  it('syncs pending shots and clears the outbox', async () => {
    const { db, push } = fakeDb();
    push('shot.sync', analysis);
    push('shot.sync', {
      ...analysis,
      id: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    });
    const sent: unknown[][] = [];
    const result = await drainOutbox(db, {
      syncShots: async shots => {
        sent.push(shots);
        return { acceptedIds: [] };
      },
      createSession: async () => {},
      finalizeSession: async () => {},
    });
    expect(result.synced).toBe(2);
    expect(result.remaining).toBe(0);
    expect(sent[0]).toHaveLength(2);
  });

  it('keeps failed items with an attempt count — retries never duplicate', async () => {
    const { db, push, outbox } = fakeDb();
    push('shot.sync', analysis);
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
    expect(outbox[0]!.attempts).toBe(1);
    const second = await drainOutbox(db, failing);
    expect(second.remaining).toBe(1);
    expect(outbox[0]!.attempts).toBe(2);
  });

  it('processes session outbox kinds through their endpoints', async () => {
    const { db, push } = fakeDb();
    push('session.create', { id: 's1', mode: 'live' });
    push('session.finalize', { id: 's1' });
    const calls: string[] = [];
    const result = await drainOutbox(db, {
      syncShots: async () => ({ acceptedIds: [] }),
      createSession: async () => void calls.push('create'),
      finalizeSession: async id => void calls.push(`finalize:${id}`),
    });
    expect(result.synced).toBe(2);
    expect(calls).toEqual(['create', 'finalize:s1']);
  });
});
