/**
 * Adjudication repro (xc-performance / perf-sqlite-sync): `drainOutbox` reads
 * `ORDER BY id ASC LIMIT 50` and a transient rejection never increments
 * `attempts`, so 50 permanently-transient rows at the head of the queue starve
 * every newer row forever. The fake DB honours ORDER BY / LIMIT exactly like
 * SQLite would (the fixture in sync.test.ts does not).
 */
import type { LocalDb } from '../../src/data/db';
import { drainOutbox, SESSION_NOT_FOUND_REJECTION } from '../../src/data/sync';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

interface OutboxRow {
  id: number;
  owner_key: string;
  kind: string;
  payload: string;
  attempts: number;
  last_error: string | null;
}

function sqliteLikeDb() {
  const outbox: OutboxRow[] = [];
  let nextId = 1;
  const db: LocalDb = {
    async execute(sql: string, params: unknown[] = []) {
      if (sql === 'BEGIN IMMEDIATE' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('INSERT OR REPLACE INTO sync_receipt'))
        return { rows: [] };
      if (sql.startsWith('SELECT id, kind, payload')) {
        const limit = Number(/LIMIT (\d+)/.exec(sql)?.[1] ?? Infinity);
        return {
          rows: outbox
            .filter(
              r =>
                r.owner_key === String(params[0]) &&
                r.attempts < Number(params[1]),
            )
            .sort((a, b) => a.id - b.id)
            .slice(0, limit)
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
      if (sql.startsWith('SELECT count(*)')) {
        return {
          rows: [{ n: outbox.filter(r => r.owner_key === params[0]).length }],
        };
      }
      throw new Error(`sqliteLikeDb: unhandled sql ${sql}`);
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

const shot = (id: string, sessionId: string | null) => ({
  id,
  sessionId,
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
    modelBundleVersion: 'm',
    poseModelVersion: 'p',
    paddleModelVersion: 'pd',
    strokeDetectorVersion: 's',
    phaseModelVersion: 'ph',
    scoringModelVersion: 'sm',
    shotConfigVersion: 'forehand_drive@1',
  },
  source: 'real',
  analysisPermitId: 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee',
});

const uuid = (n: number) =>
  `${n.toString(16).padStart(8, '0')}-bbbb-4ccc-8ddd-eeeeeeeeeeee`;

describe('adjudicate: outbox head-of-line blocking', () => {
  beforeEach(() => setActiveDataOwner(GUEST_DATA_OWNER));
  afterAll(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

  it('50 head rows stuck on a transient rejection starve a newer healthy shot across 20 drains', async () => {
    const { db, push, outbox } = sqliteLikeDb();
    // A practice set whose session.create row was permanently rejected
    // (e.g. contract error) and has already burned its attempt budget, so
    // it is no longer selected — but its 50 shots stay transient forever.
    const orphanSession = 'dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    for (let i = 0; i < 50; i++)
      push('shot.sync', shot(uuid(i), orphanSession));
    const healthyId = uuid(999);
    push('shot.sync', shot(healthyId, null));

    const sent: string[][] = [];
    const transport = {
      syncShots: async (shots: unknown[]) => {
        const ids = shots.map(s => (s as { id: string }).id);
        sent.push(ids);
        return {
          acceptedIds: ids.filter(id => id === healthyId),
          rejected: ids
            .filter(id => id !== healthyId)
            .map(id => ({
              id,
              code: SESSION_NOT_FOUND_REJECTION,
              message: 'Session not found or not yours.',
            })),
        };
      },
      createSession: async () => {},
      finalizeSession: async () => {},
    };

    let last = { synced: 0, failed: 0, remaining: 0 };
    for (let drain = 0; drain < 20; drain++) {
      last = await drainOutbox(db, transport);
    }
    const everOffered = sent.some(batch => batch.includes(healthyId));

    // Observed on 4d812e1a: healthy shot never leaves the device.
    expect(everOffered).toBe(false);
    expect(outbox.some(r => JSON.parse(r.payload).id === healthyId)).toBe(true);
    expect(last.remaining).toBe(51);
    expect(outbox.every(r => r.attempts === 0)).toBe(true);
  });
});
