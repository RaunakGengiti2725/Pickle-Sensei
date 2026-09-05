/**
 * PORT of round-8 candidate B's adversary R5 (cb1fe96a) to candidate A's
 * durable columns: `sync_set_state.rearms` → `local_session.rearms`, whose
 * value once the set is PAUSED is the sentinel SESSION_CREATE_REARM_BOUND + 1
 * (B's `SESSION_REARM_LIMIT`). The behavioural assertions are unchanged: the
 * set's budget is reset only by a NEW read, the same analysis id saved twice
 * adds no second `shot.sync` row and no offer, and two racing drain
 * generations never hold two live `session.create` rows. Real modules, real
 * node:sqlite.
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
import { getDb } from '../../../src/data/db';
import {
  getShotOutboxStatus,
  saveAnalysis,
  type SessionInput,
} from '../../../src/data/repository';
import {
  OUTBOX_MAX_ATTEMPTS,
  SESSION_CREATE_REARM_BOUND,
  SESSION_NOT_FOUND_REJECTION,
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
const SET = 'a8a8a8a8-0000-4000-8000-0000000000b5';

function setInput(id: string): SessionInput {
  return {
    id,
    mode: 'practice_set',
    shotType: 'forehand_drive',
    focusCheckpoint: null,
    startedAt: '2026-08-26T18:00:00.000Z',
  };
}

async function clearAll(db: LocalDb): Promise<void> {
  for (const table of [
    'outbox',
    'local_shot',
    'local_session',
    'sync_receipt',
    'kv',
  ]) {
    await db.execute(`DELETE FROM ${table}`);
  }
}

function ids(shots: unknown[]): string[] {
  return shots.map(s => String((s as { id: unknown }).id));
}

function acceptCreateRefuseShots(): SyncTransport & {
  creates: number;
  offers: string[];
} {
  const t = {
    creates: 0,
    offers: [] as string[],
    async createSession() {
      t.creates += 1;
    },
    async finalizeSession() {},
    async syncShots(shots: unknown[]) {
      const offered = ids(shots);
      t.offers.push(...offered);
      return {
        acceptedIds: [],
        rejected: offered.map(id => ({
          id,
          code: SESSION_NOT_FOUND_REJECTION,
          message: 'Session not found for this shot.',
        })),
      };
    },
  };
  return t;
}

async function rearms(db: LocalDb): Promise<number | null> {
  const { rows } = await db.execute(
    `SELECT rearms FROM local_session WHERE owner_key = ? AND id = ?`,
    [OWNER, SET],
  );
  return rows[0] ? Number(rows[0]['rearms']) : null;
}

/** `local_session.rearms` once the set is paused (B's SESSION_REARM_LIMIT). */
const PAUSED_REARMS = SESSION_CREATE_REARM_BOUND + 1;

describe('attack-fix8-b R5 (ported) — same-id re-save and racing generations', () => {
  let db: LocalDb;

  beforeEach(async () => {
    setActiveDataOwner(OWNER);
    db = getDb();
    await clearAll(db);
  });

  afterAll(() => {
    getDb().close();
    mockSqlite.reset();
  });

  it('G1 — re-saving the SAME analysis id (not a new read) must not reset the re-arm budget nor duplicate the queue row', async () => {
    const server = acceptCreateRefuseShots();
    const first = realAnalysis({ id: shotId(0xe501), sessionId: SET });
    await saveAnalysis(db, first, PERMIT_ID, { session: setInput(SET) });
    // Spend the set's re-arm budget: accept create, refuse shot, until the
    // engine holds the shot (the set is paused: rearms == PAUSED_REARMS).
    for (let i = 0; i < 12; i += 1) await drainOutbox(db, server);
    const spent = await rearms(db);
    const offersBefore = server.offers.length;
    const createsBefore = server.creates;
    const rowsBefore = (await outboxRows(db, OWNER)).filter(
      r => r.kind === 'shot.sync',
    ).length;
    console.log('attack-fix8-b G1 spent', {
      rearms: spent,
      creates: server.creates,
      offers: offersBefore,
      shotRows: rowsBefore,
      status: await getShotOutboxStatus(db, first.id),
    });
    expect(spent).toBe(PAUSED_REARMS);

    // The SAME analysis id saved again (an API-level re-save; the capture
    // flow mints a fresh uuid per run, so this is reachable only through
    // the repository API).
    await saveAnalysis(db, first, PERMIT_ID, { session: setInput(SET) });
    const shotRows = (await outboxRows(db, OWNER)).filter(
      r => r.kind === 'shot.sync',
    );
    for (let i = 0; i < 12; i += 1) await drainOutbox(db, server);
    const observed = {
      rearmsAfterResave: await rearms(db),
      shotRowsAfterResave: shotRows.length,
      offersAdded: server.offers.length - offersBefore,
      createsTotal: server.creates,
    };
    console.log('attack-fix8-b G1 observed', observed);
    // EXPECTED: the budget is reset only by a NEW read; the same id re-saved
    // neither resets `local_session.rearms` nor adds a second queue row for
    // the same shot id, so no further offers/creates happen.
    expect(observed).toEqual({
      rearmsAfterResave: PAUSED_REARMS,
      shotRowsAfterResave: rowsBefore,
      offersAdded: 0,
      createsTotal: createsBefore,
    });
  });

  it('G2 — two sync-runtime generations draining the same owner concurrently: exactly one live create, no shot offered twice per drain', async () => {
    const a = acceptCreateRefuseShots();
    const b = acceptCreateRefuseShots();
    for (let i = 0; i < 5; i += 1) {
      await saveAnalysis(
        db,
        realAnalysis({ id: shotId(0xe600 + i), sessionId: SET }),
        PERMIT_ID,
        { session: setInput(SET) },
      );
    }
    const [ra, rb] = await Promise.all([
      drainOutbox(db, a),
      drainOutbox(db, b),
    ]);
    console.log('attack-fix8-b G2', {
      ra,
      rb,
      creates: [a.creates, b.creates],
      offers: [a.offers.length, b.offers.length],
      rows: (await outboxRows(db, OWNER)).map(r => [
        r.kind,
        r.attempts,
        r.last_error,
      ]),
    });
    // Claim 3: one (owner, session) never has two live session.create
    // rows and both generations combined never create twice per drain.
    expect(a.creates + b.creates).toBeLessThanOrEqual(2);
    const live = (await outboxRows(db, OWNER)).filter(
      r => r.kind === 'session.create' && r.attempts < OUTBOX_MAX_ATTEMPTS,
    );
    expect(live.length).toBeLessThanOrEqual(1);
    // Each shot: attempts charged once per drain generation at most.
    for (const r of (await outboxRows(db, OWNER)).filter(
      r => r.kind === 'shot.sync',
    )) {
      expect(r.attempts).toBeLessThanOrEqual(2);
    }
  });
});
