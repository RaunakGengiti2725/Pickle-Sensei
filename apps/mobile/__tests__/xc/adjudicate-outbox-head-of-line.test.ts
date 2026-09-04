/**
 * Adjudication repro (xc-performance / XCP-2): `drainOutbox` used to read a
 * strict `ORDER BY id ASC LIMIT 50` head window, and a transient rejection
 * never increments `attempts`, so 50 permanently-transient rows at the head
 * of the queue starved every newer row forever. The fake DB honours the
 * WHERE / ORDER BY / LIMIT of the drain query exactly like SQLite would (the
 * fixture in sync.test.ts does not), so the window selection is under test.
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
  last_attempt_at: string | null;
}

function sqliteLikeDb() {
  const outbox: OutboxRow[] = [];
  let nextId = 1;
  // Monotonic stand-in for strftime('now') at millisecond resolution.
  let clock = Date.parse('2026-08-26T18:00:00.000Z');
  const db: LocalDb = {
    async execute(sql: string, params: unknown[] = []) {
      if (sql === 'BEGIN IMMEDIATE' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('INSERT OR REPLACE INTO sync_receipt'))
        return { rows: [] };
      if (sql.startsWith('SELECT id, kind, payload')) {
        const limit = Number(/LIMIT (\d+)/.exec(sql)?.[1] ?? Infinity);
        const orderBy = /ORDER BY ([\s\S]*?)(?:LIMIT|$)/.exec(sql)?.[1] ?? '';
        const byAttemptRecency = orderBy.includes('last_attempt_at');
        return {
          rows: outbox
            .filter(
              r =>
                r.owner_key === String(params[0]) &&
                r.attempts < Number(params[1]),
            )
            .sort((a, b) => {
              if (byAttemptRecency) {
                // `last_attempt_at IS NOT NULL, last_attempt_at, id`: never
                // attempted first, then least recently attempted.
                if (a.last_attempt_at === null && b.last_attempt_at !== null)
                  return -1;
                if (a.last_attempt_at !== null && b.last_attempt_at === null)
                  return 1;
                if (
                  a.last_attempt_at !== null &&
                  b.last_attempt_at !== null &&
                  a.last_attempt_at !== b.last_attempt_at
                )
                  return a.last_attempt_at < b.last_attempt_at ? -1 : 1;
              }
              return a.id - b.id;
            })
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
          if (sql.includes('last_attempt_at =')) {
            clock += 1;
            row.last_attempt_at = new Date(clock).toISOString();
          }
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
      last_attempt_at: null,
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

/** A practice set whose session.create row was permanently rejected and has
 * burned its attempt budget: its shots are rejected as session_not_found
 * (transient — attempts stay 0) on every drain, forever. */
const orphanSession = 'dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function transportAccepting(healthyIds: ReadonlySet<string>) {
  const sent: string[][] = [];
  const transport = {
    syncShots: async (shots: unknown[]) => {
      const ids = shots.map(s => (s as { id: string }).id);
      sent.push(ids);
      return {
        acceptedIds: ids.filter(id => healthyIds.has(id)),
        rejected: ids
          .filter(id => !healthyIds.has(id))
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
  return { sent, transport };
}

describe('adjudicate: outbox head-of-line blocking', () => {
  beforeEach(() => setActiveDataOwner(GUEST_DATA_OWNER));
  afterAll(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

  it('50 head rows stuck on a transient rejection do not starve a newer healthy shot: it syncs within two drains', async () => {
    const { db, push, outbox } = sqliteLikeDb();
    for (let i = 0; i < 50; i++)
      push('shot.sync', shot(uuid(i), orphanSession));
    const healthyId = uuid(999);
    push('shot.sync', shot(healthyId, null));
    const { sent, transport } = transportAccepting(new Set([healthyId]));

    let last = { synced: 0, failed: 0, remaining: 0 };
    let drainsUntilHealthySynced = 0;
    for (let drain = 1; drain <= 20; drain++) {
      last = await drainOutbox(db, transport);
      if (
        drainsUntilHealthySynced === 0 &&
        sent.some(batch => batch.includes(healthyId))
      ) {
        drainsUntilHealthySynced = drain;
      }
    }

    // Observed on 4d812e1a: the healthy shot never left the device across 20
    // drains (only ever offered rows 1..50). Required: it is offered and its
    // row deleted within at most two drains.
    expect(drainsUntilHealthySynced).toBeGreaterThan(0);
    expect(drainsUntilHealthySynced).toBeLessThanOrEqual(2);
    expect(
      outbox.some(
        r => (JSON.parse(r.payload) as { id: string }).id === healthyId,
      ),
    ).toBe(false);
    expect(last.remaining).toBe(50);
    // The stuck rows stay durable and retryable: transient rejections never
    // consume the bounded attempt budget.
    expect(outbox.every(r => r.attempts === 0)).toBe(true);
    // Every stuck row was offered again at some point — nothing is dropped
    // from sync, the window rotates.
    for (let i = 0; i < 50; i++) {
      expect(sent.flat()).toContain(uuid(i));
    }
    // No drain ever sends more than the 50-row window.
    expect(sent.every(batch => batch.length <= 50)).toBe(true);
  });

  it('fewer than 50 stuck rows still deliver every newer healthy row in the same drain (10 stuck + 1 healthy → drain 1)', async () => {
    const { db, push, outbox } = sqliteLikeDb();
    for (let i = 0; i < 10; i++)
      push('shot.sync', shot(uuid(i), orphanSession));
    const healthyId = uuid(999);
    push('shot.sync', shot(healthyId, null));
    const { sent, transport } = transportAccepting(new Set([healthyId]));

    const first = await drainOutbox(db, transport);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(11);
    expect(sent[0]).toContain(healthyId);
    expect(first).toMatchObject({ synced: 1, failed: 10, remaining: 10 });
    expect(
      outbox.some(
        r => (JSON.parse(r.payload) as { id: string }).id === healthyId,
      ),
    ).toBe(false);
    expect(outbox.every(r => r.attempts === 0)).toBe(true);
  });

  it('rotates the window so a healthy row that itself failed once (offline) behind 50 stuck rows still syncs', async () => {
    const { db, push, outbox } = sqliteLikeDb();
    for (let i = 0; i < 50; i++)
      push('shot.sync', shot(uuid(i), orphanSession));
    const healthyId = uuid(999);
    push('shot.sync', shot(healthyId, null));

    // Drain 1 while online: the 50 stuck rows are attempted and rejected.
    const { sent, transport } = transportAccepting(new Set([healthyId]));
    await drainOutbox(db, transport);
    // Drain 2 offline: whichever rows are offered (the healthy one included)
    // fail transiently as a whole request.
    const offline = {
      syncShots: async () => {
        throw new Error('offline');
      },
      createSession: async () => {},
      finalizeSession: async () => {},
    };
    await drainOutbox(db, offline);
    expect(outbox.every(r => r.attempts === 0)).toBe(true);

    // Back online: the healthy row must still come around within the
    // rotation (at most ceil(51 / 50) = 2 further drains).
    let drains = 0;
    while (
      outbox.some(
        r => (JSON.parse(r.payload) as { id: string }).id === healthyId,
      ) &&
      drains < 2
    ) {
      await drainOutbox(db, transport);
      drains++;
    }
    expect(
      outbox.some(
        r => (JSON.parse(r.payload) as { id: string }).id === healthyId,
      ),
    ).toBe(false);
    expect(sent.some(batch => batch.includes(healthyId))).toBe(true);
    expect(outbox).toHaveLength(50);
  });
});
