/**
 * ADVERSARY fix round 8 / candidate B (d1c42d78) — claim 4's reset condition
 * ("reset ONLY by saveAnalysis of a NEW read into the set") and claim 3's
 * one-live-create rule under two racing sync-runtime generations. Real
 * modules, real node:sqlite.
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
  SESSION_NOT_FOUND_REJECTION,
  SESSION_REARM_LIMIT,
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
    'sync_set_state',
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
    `SELECT rearms FROM sync_set_state WHERE owner_key = ? AND session_id = ?`,
    [OWNER, SET],
  );
  return rows[0] ? Number(rows[0]['rearms']) : null;
}

describe('attack-fix8-b R5 — same-id re-save and racing generations (claims 3/4)', () => {
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
    // engine holds the shot (rearms == SESSION_REARM_LIMIT).
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
    expect(spent).toBe(SESSION_REARM_LIMIT);

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
    // EXPECTED (claim 4): the budget is reset only by a NEW read; the same
    // id re-saved neither resets sync_set_state nor adds a second queue row
    // for the same shot id, so no further offers/creates happen.
    // OBSERVED: sync_set_state reset (2 more creates), a second shot.sync
    // row for the same id, 4 more offers of the same shot.
    expect(observed).toEqual({
      rearmsAfterResave: SESSION_REARM_LIMIT,
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
