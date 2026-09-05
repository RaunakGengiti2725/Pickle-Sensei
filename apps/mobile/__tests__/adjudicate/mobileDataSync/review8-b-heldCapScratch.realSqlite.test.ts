/**
 * Review round 8 (candidate B, d1c42d78) — reviewer scratch probe: what state
 * does a shot reach when a set is accepted forever yet the server keeps
 * refusing the shot `shot.session_not_found` across MANY real new reads, so
 * the re-arm-held shot is charged all the way to OUTBOX_MAX_ATTEMPTS?
 * NOT part of the candidate; lives on devin/review8-sqlite-b-scratch only.
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
import { deriveUploadQueueStatus } from '../../../src/data/offlineCapabilities';
import {
  getShotOutboxStatus,
  saveAnalysis,
  type SessionInput,
} from '../../../src/data/repository';
import {
  OUTBOX_MAX_ATTEMPTS,
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
const SET_B = 'b8b8b8b8-0000-4000-8000-000000000002';

function setInput(id: string): SessionInput {
  return {
    id,
    mode: 'practice_set',
    shotType: 'forehand_drive',
    focusCheckpoint: null,
    startedAt: '2026-08-26T18:00:00.000Z',
  };
}

interface PingPong extends SyncTransport {
  creates: number;
  offers: number;
  offeredIds: string[];
}
function acceptCreateRefuseShots(): PingPong {
  const t: PingPong = {
    creates: 0,
    offers: 0,
    offeredIds: [],
    async createSession() {
      t.creates += 1;
    },
    async finalizeSession() {},
    async syncShots(shots) {
      t.offers += 1;
      for (const s of shots)
        t.offeredIds.push(String((s as { id: string }).id));
      return {
        acceptedIds: [],
        rejected: shots.map(s => ({
          id: String((s as { id: string }).id),
          code: SESSION_NOT_FOUND_REJECTION,
          message: 'Session not found for this shot.',
        })),
      };
    },
  };
  return t;
}

describe('review8 candidate B — held shot reaching the cap (real SQLite)', () => {
  let db: LocalDb;

  beforeEach(async () => {
    setActiveDataOwner(OWNER);
    db = getDb();
    await db.execute(`DELETE FROM outbox`);
    await db.execute(`DELETE FROM local_shot`);
    await db.execute(`DELETE FROM local_session`);
    await db.execute(`DELETE FROM sync_receipt`);
    await db.execute(`DELETE FROM sync_set_state`);
  });

  it('R4g — 12 real new reads into an accepted-but-refusing set: per-read call bound holds (2 creates + 2 syncs per read), but the first shot is offered 2 per read for life (26 offers) while its attempt count freezes at OUTBOX_MAX_ATTEMPTS-1 — the "≤8 offers per shot lifetime" claim does not hold', async () => {
    const t = acceptCreateRefuseShots();
    const first = shotId(0x9601);
    await saveAnalysis(
      db,
      realAnalysis({ id: first, sessionId: SET_B }),
      PERMIT_ID,
      { session: setInput(SET_B) },
    );
    const trace: string[] = [];
    for (let d = 0; d < 12; d += 1) await drainOutbox(db, t);
    for (let n = 0; n < 12; n += 1) {
      await saveAnalysis(
        db,
        realAnalysis({ id: shotId(0x9610 + n), sessionId: SET_B }),
        PERMIT_ID,
        { session: setInput(SET_B) },
      );
      for (let d = 0; d < 12; d += 1) await drainOutbox(db, t);
      const s = await getShotOutboxStatus(db, first);
      const firstOffers = t.offeredIds.filter(id => id === first).length;
      trace.push(
        `cycle${n + 1}: offers(first)=${firstOffers} status=${JSON.stringify(s)}`,
      );
    }
    const rows = await outboxRows(db, OWNER);
    const queue = deriveUploadQueueStatus(
      rows.map(r => ({
        kind: r.kind,
        attempts: r.attempts,
        lastError: r.last_error,
      })),
    );
    console.log(
      [
        ...trace,
        `creates=${t.creates} offers=${t.offers} rows=${rows.length}`,
        `queue=${JSON.stringify(queue)}`,
        `rows=${JSON.stringify(rows)}`,
      ].join('\n'),
    );
    const firstOffers = t.offeredIds.filter(id => id === first).length;
    // Per real new read: SESSION_REARM_LIMIT creates + SESSION_REARM_LIMIT
    // syncShots (plus the initial SESSION_REARM_LIMIT + 1 creates).
    expect(t.creates).toBe(3 + 12 * 2);
    expect(t.offers).toBe(2 + 12 * 2);
    // Finding: lifetime offers of one shot grow with every new read (2 each)
    // and the attempt count stops at OUTBOX_MAX_ATTEMPTS - 1 (parked
    // uncharged at the cap, then released with last_error cleared), so the
    // shot can never reach 'exhausted' and its copy under-reports refusals.
    expect(firstOffers).toBe(2 + 12 * 2);
    const firstStatus = await getShotOutboxStatus(db, first);
    expect(firstStatus).toMatchObject({
      state: 'rejected',
      attempts: OUTBOX_MAX_ATTEMPTS - 1,
    });
  });
});
