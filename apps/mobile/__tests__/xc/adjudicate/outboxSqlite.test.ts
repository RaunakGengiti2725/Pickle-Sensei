/**
 * Adjudication reproductions (xc-journeys / journey-history-library-delete,
 * journey-offline-first) against a REAL SQLite engine behind LocalDb:
 *
 *  1. saveAnalysis (BEGIN IMMEDIATE via inTransaction) racing drainOutbox's
 *     receipt transaction (BEGIN IMMEDIATE via raw execute) on the ONE shared
 *     connection: the loser's BEGIN throws "cannot start a transaction within
 *     a transaction", its catch-ROLLBACK tears down the winner's transaction,
 *     and the scored rating is lost (no local_shot row, no outbox row).
 *  2. Head-of-line starvation: drainOutbox reads `ORDER BY id ASC LIMIT 50`
 *     filtered by attempts < OUTBOX_MAX_ATTEMPTS, and transient rejections
 *     never increment attempts — 50 rows that keep failing transiently
 *     (shot.session_not_found for a session.create the server refused for
 *     good) block every newer row forever.
 */
import type { ShotAnalysis } from '@pickle/shared-types';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import { saveAnalysis } from '../../../src/data/repository';
import {
  drainOutbox,
  OUTBOX_MAX_ATTEMPTS,
  SESSION_NOT_FOUND_REJECTION,
  type SyncTransport,
} from '../../../src/data/sync';
import { openNodeSqliteLocalDb } from './nodeSqliteDb';

const owner = '11111111-1111-4111-8111-111111111111';
const permitId = '22222222-2222-4222-8222-222222222222';

function shot(id: string, sessionId: string | null = null): ShotAnalysis {
  return {
    id,
    sessionId,
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
}

const uuid = (n: number) =>
  `aaaaaaaa-bbbb-4ccc-8ddd-${String(n).padStart(12, '0')}`;

describe('adjudication: outbox on a real SQLite connection', () => {
  beforeEach(() => setActiveDataOwner(owner));
  afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

  it('saveAnalysis started inside the drain receipt transaction loses the scored rating', async () => {
    const sqlite = openNodeSqliteLocalDb();
    const { db } = sqlite;
    // Shot A is already queued; the drain will get it accepted.
    await saveAnalysis(db, shot(uuid(1)), permitId);

    const transport: SyncTransport = {
      syncShots: async shots => ({
        acceptedIds: (shots as Array<{ id: string }>).map(s => s.id),
        rejected: [],
      }),
      createSession: async () => {},
      finalizeSession: async () => {},
    };

    // The moment the drain is INSIDE its BEGIN IMMEDIATE (about to insert the
    // receipt), a scored run on the Analyze screen persists shot B.
    let saveB: Promise<void> | null = null;
    let saveBError: unknown = null;
    sqlite.beforeStatement = async sql => {
      if (sql.includes('INSERT OR REPLACE INTO sync_receipt') && !saveB) {
        sqlite.beforeStatement = null;
        saveB = saveAnalysis(db, shot(uuid(2)), permitId).catch(error => {
          saveBError = error;
        });
        await saveB;
      }
    };

    let drainError: unknown = null;
    await drainOutbox(db, transport).catch(error => {
      drainError = error;
    });
    await saveB;

    const shots = sqlite
      .all(`SELECT id FROM local_shot WHERE owner_key = ? ORDER BY id`, [owner])
      .map(r => r['id']);
    const outbox = sqlite.all(
      `SELECT kind, payload FROM outbox WHERE owner_key = ?`,
      [owner],
    );
    const queuedB = outbox.some(r => String(r['payload']).includes(uuid(2)));
    const errors = sqlite.trace
      .filter(t => t.outcome === 'error')
      .map(t => t.error);

    console.log(
      `[adjudicate] saveB error=${String(saveBError)} drainError=${String(drainError)} local_shot=${JSON.stringify(shots)} queuedB=${queuedB} sqliteErrors=${JSON.stringify(errors)}`,
    );
    // Expected product behaviour: shot B (a scored, permit-backed rating) is
    // durably stored and queued for sync regardless of a concurrent drain.
    expect(saveBError).toBeNull();
    expect(shots).toContain(uuid(2));
    expect(queuedB).toBe(true);
  });

  it('50 transiently-rejected rows starve every newer outbox row indefinitely', async () => {
    const sqlite = openNodeSqliteLocalDb();
    const { db } = sqlite;
    const deadSession = '33333333-3333-4333-8333-333333333333';
    // 50 shots of a practice set whose session.create the server refused for
    // good (its row exhausted the attempt budget and left the drain window).
    for (let i = 1; i <= 50; i++)
      await saveAnalysis(db, shot(uuid(i), deadSession), permitId);
    // A brand-new standalone rating queued afterwards.
    await saveAnalysis(db, shot(uuid(999)), permitId);

    const sent: string[][] = [];
    const transport: SyncTransport = {
      syncShots: async shots => {
        const ids = (
          shots as Array<{ id: string; sessionId: string | null }>
        ).map(s => s.id);
        sent.push(ids);
        return {
          acceptedIds: (
            shots as Array<{ id: string; sessionId: string | null }>
          )
            .filter(s => s.sessionId === null)
            .map(s => s.id),
          rejected: (shots as Array<{ id: string; sessionId: string | null }>)
            .filter(s => s.sessionId !== null)
            .map(s => ({
              id: s.id,
              code: SESSION_NOT_FOUND_REJECTION,
              message: 'session not found',
            })),
        };
      },
      createSession: async () => {},
      finalizeSession: async () => {},
    };

    const drains = OUTBOX_MAX_ATTEMPTS * 3;
    let remaining = -1;
    for (let i = 0; i < drains; i++) {
      remaining = (await drainOutbox(db, transport)).remaining;
    }
    const everSentNew = sent.some(ids => ids.includes(uuid(999)));
    const attempts = sqlite.all(
      `SELECT max(attempts) AS a FROM outbox WHERE owner_key = ?`,
      [owner],
    )[0]?.['a'];

    console.log(
      `[adjudicate] drains=${drains} everSentNew=${everSentNew} remaining=${remaining} maxAttempts=${String(attempts)}`,
    );
    // Expected product behaviour: a newer, independently valid rating is
    // sent within a bounded number of drains even while older rows keep
    // failing transiently.
    expect(everSentNew).toBe(true);
  });
});
