/**
 * Adversarial round 3 (attack branch) — MDS-C3 terminal-state gaps in the
 * candidate `devin/fix2-mds-c2-c1-c3-sqlite-txn` merged onto 3bd08da5.
 *
 * The cluster: "a shot whose session row never syncs is retried forever with
 * no terminal state". The candidate settles a shot ONLY when its
 * `session.create` outbox row exists and has spent its attempt budget
 * (sync.ts `deadSessions`). Two real paths fall outside that:
 *
 *  1. The session row never reached the outbox at all. The capture flow saves
 *     the scored shot first (`runCaptureAnalysis` → `saveAnalysis` with the
 *     plan's sessionId) and only afterwards commits the practice set
 *     (`AnalyzeScreen` → `commitPracticeSet(...).catch(() => {})`, a separate
 *     transaction, best-effort). A kill or a failed `saveSession` between the
 *     two leaves a shot whose sessionId no `session.create` row will ever
 *     name. The server answers `shot.session_not_found` on every drain, the
 *     client keeps it transient, attempts stay 0, and nothing ever settles it
 *     — the original bug, unchanged.
 *
 *  2. The orphan verdict is irreversible on the client while the server-side
 *     condition is not. `apply_synced_shot` accepts a shot the moment its
 *     session exists for the owner, and `POST /v1/sessions` is an idempotent
 *     upsert. Once a shot carries `shot.session_orphaned:` it is excluded from
 *     every later drain by the SQL predicate in `selectOutboxPage`, so a
 *     session.create row that DOES later land (re-queued for the same id and
 *     accepted) never brings the shot with it. The base commit would have
 *     retried and delivered that shot.
 */
import type { LocalDb } from '../../../src/data/db';
import { createRealOpSqliteModule } from '../../../adjudicate/mobile-data-sync/realSqliteOpMock';

const mockSqlite = createRealOpSqliteModule();
jest.mock('@op-engineering/op-sqlite', () => ({
  open: (options: { name: string }) => mockSqlite.open(options),
}));

import {
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import { ApiError } from '../../../src/data/api';
import { getDb } from '../../../src/data/db';
import {
  getShotOutboxStatus,
  hasShotSyncReceipt,
  saveAnalysis,
  saveSession,
} from '../../../src/data/repository';
import {
  OUTBOX_MAX_ATTEMPTS,
  SESSION_NOT_FOUND_REJECTION,
  SESSION_ORPHANED_VERDICT,
  drainOutbox,
  type SyncTransport,
} from '../../../src/data/sync';
import {
  CANONICAL_USER,
  PERMIT_ID,
  outboxRows,
  realAnalysis,
  shotId,
} from '../../../adjudicate/mobile-data-sync/fixtures';

const OWNER = canonicalDataOwner(CANONICAL_USER);
const NEVER_QUEUED_SESSION = 'abababab-0000-4000-8000-000000000001';
const LATE_SESSION = 'cdcdcdcd-0000-4000-8000-000000000001';

interface Emulator extends SyncTransport {
  knownSessions: Set<string>;
  /** Session ids `createSession` must refuse with 409 session.id_conflict. */
  refuseSessions: Set<string>;
  offered: string[][];
}

/** Mirrors supabase/functions/api: createSession is an idempotent upsert
 * (409 only while the id belongs to someone else); apply_synced_shot rejects
 * `shot.session_not_found` until the owner's session row exists, then
 * accepts. */
function serverEmulator(): Emulator {
  const knownSessions = new Set<string>();
  const refuseSessions = new Set<string>();
  const offered: string[][] = [];
  return {
    knownSessions,
    refuseSessions,
    offered,
    async createSession(session) {
      const id = String((session as { id: unknown }).id);
      if (refuseSessions.has(id)) {
        throw new ApiError(
          409,
          'session.id_conflict',
          'Session id belongs to another user.',
        );
      }
      knownSessions.add(id);
    },
    async finalizeSession() {},
    async syncShots(shots) {
      const acceptedIds: string[] = [];
      const rejected: Array<{ id: string; code: string; message: string }> = [];
      const ids: string[] = [];
      for (const raw of shots) {
        const shot = raw as { id: string; sessionId: string | null };
        ids.push(shot.id);
        if (shot.sessionId && !knownSessions.has(shot.sessionId)) {
          rejected.push({
            id: shot.id,
            code: SESSION_NOT_FOUND_REJECTION,
            message: 'Session not found for this shot.',
          });
        } else {
          acceptedIds.push(shot.id);
        }
      }
      offered.push(ids);
      return { acceptedIds, rejected };
    },
  };
}

async function saveShot(
  db: LocalDb,
  n: number,
  sessionId: string | null,
): Promise<void> {
  await saveAnalysis(db, realAnalysis({ id: shotId(n), sessionId }), PERMIT_ID);
}

async function queueSession(db: LocalDb, id: string): Promise<void> {
  await saveSession(db, {
    id,
    mode: 'practice_set',
    shotType: 'forehand_drive',
    focusCheckpoint: null,
    startedAt: '2026-08-26T18:00:00.000Z',
  });
}

describe('ATTACK fix3 / MDS-C3: terminal state must exist and must not lose a deliverable shot (real SQLite)', () => {
  let db: LocalDb;

  beforeEach(async () => {
    setActiveDataOwner(OWNER);
    db = getDb();
    await db.execute(`DELETE FROM outbox`);
    await db.execute(`DELETE FROM local_shot`);
    await db.execute(`DELETE FROM local_session`);
    await db.execute(`DELETE FROM sync_receipt`);
  });

  afterAll(() => {
    getDb().close();
    mockSqlite.reset();
  });

  it('a shot whose session.create row never reached the outbox (kill between saveAnalysis and commitPracticeSet) reaches a terminal state within the attempt budget', async () => {
    const server = serverEmulator();
    // runCaptureAnalysis saved the scored shot with the plan's sessionId; the
    // process died before AnalyzeScreen's best-effort commitPracticeSet ran,
    // so no session.create row — and no local_session row — exists for it.
    await saveShot(db, 0x500, NEVER_QUEUED_SESSION);

    // Twice the whole attempt budget of drains: more than any bounded retry
    // policy needs to settle a row.
    const drains = OUTBOX_MAX_ATTEMPTS * 2;
    for (let i = 0; i < drains; i++) {
      await drainOutbox(db, server);
    }

    const status = await getShotOutboxStatus(db, shotId(0x500));
    const rows = await outboxRows(db, OWNER);
    const offeredCount = server.offered.filter(ids =>
      ids.includes(shotId(0x500)),
    ).length;

    // Expected (the cluster's contract): the shot either synced or has a
    // terminal verdict — `exhausted` or `orphaned` — and stops being offered.
    // Observed on the candidate: still `queued`, attempts 0, last_error
    // `shot.session_not_found: …`, offered to the server on every one of the
    // 16 drains, forever.
    const delivered = await hasShotSyncReceipt(db, shotId(0x500));
    expect({
      delivered,
      state: status.state,
      offeredToServerEveryDrain: offeredCount === drains,
      row: rows[0] ?? null,
    }).toMatchObject({
      delivered: false,
      state: expect.stringMatching(/^(exhausted|orphaned)$/),
      offeredToServerEveryDrain: false,
    });
  });

  it('a session.create row that lands AFTER its shot was settled as orphaned brings the shot with it (server would now accept it)', async () => {
    const server = serverEmulator();
    server.refuseSessions.add(LATE_SESSION);
    await saveShot(db, 0x600, LATE_SESSION);
    await queueSession(db, LATE_SESSION);

    // Exhaust the session row (8 permanent refusals) → the shot is settled
    // with the client-only `shot.session_orphaned` verdict.
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i++) {
      await drainOutbox(db, server);
    }
    expect(await getShotOutboxStatus(db, shotId(0x600))).toMatchObject({
      state: 'orphaned',
      attempts: 0,
    });
    expect(
      (await outboxRows(db, OWNER)).find(r => r.kind === 'session.create')
        ?.attempts,
    ).toBe(OUTBOX_MAX_ATTEMPTS);

    // The server-side condition clears (the id no longer belongs to someone
    // else) and a session.create row for the SAME id is queued again; the
    // idempotent upsert accepts it and the server now knows LATE_SESSION.
    server.refuseSessions.delete(LATE_SESSION);
    await queueSession(db, LATE_SESSION);
    const offeredBefore = server.offered
      .flat()
      .filter(id => id === shotId(0x600)).length;

    const recovery = await drainOutbox(db, server);
    expect(server.knownSessions.has(LATE_SESSION)).toBe(true);

    // Expected: the shot is offered again now that its session exists, is
    // accepted, gets a receipt and leaves the outbox (the base commit, which
    // never stopped retrying it, delivers it here).
    // Observed on the candidate: `selectOutboxPage` filters
    // `last_error LIKE 'shot.session_orphaned:%'` out of every pass, so the
    // shot is never offered again — {synced:1, failed:0} for the session
    // only, no receipt, row still orphaned. A server-acceptable rating is
    // lost for good.
    const offeredAfter = server.offered
      .flat()
      .filter(id => id === shotId(0x600)).length;
    expect(offeredAfter).toBeGreaterThan(offeredBefore);
    expect(await hasShotSyncReceipt(db, shotId(0x600))).toBe(true);
    expect(recovery.synced).toBeGreaterThanOrEqual(2);
    const shotRows = (await outboxRows(db, OWNER)).filter(
      r => r.kind === 'shot.sync',
    );
    expect(shotRows).toHaveLength(0);
    expect(
      shotRows.some(r =>
        r.last_error?.startsWith(`${SESSION_ORPHANED_VERDICT}:`),
      ),
    ).toBe(false);
  });
});
