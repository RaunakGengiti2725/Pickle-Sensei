/**
 * Fix round 9 (R4, ported from candidate B's adversary) — every durable
 * outbox state is built through the REAL modules in one store, then three
 * views are compared row-for-row against SQL truth:
 *
 *   SQL row (attempts, refusals, quarantined, last_error)
 *   getShotOutboxStatus(shot)          (Result surface)
 *   deriveUploadQueueStatus(rows)      (queue banner)
 *   the next drain's ACTUAL offer set  (what the server is asked)
 *
 * States: queued, retrying, parked, re-armed, paused (cap), exhausted,
 * quarantined, released. A row the queue calls pending is offered by the
 * next drain unless it is parked under a set the server still refuses; a row
 * the queue calls finished / paused / quarantined is offered 0 times.
 * Real `node:sqlite`.
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
  deriveUploadQueueStatus,
  type OutboxRowStatus,
} from '../../../src/data/offlineCapabilities';
import {
  getShotOutboxStatus,
  hasShotSyncReceipt,
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
  realAnalysis,
  shotId,
} from '../../../adjudicate/mobile-data-sync/fixtures';

const OWNER = canonicalDataOwner(CANONICAL_USER);
const SET_PARKED = 'f9f9f9f9-0000-4000-8000-0000000000a1';
const SET_RELEASED = 'f9f9f9f9-0000-4000-8000-0000000000a2';
const SET_REARMED = 'f9f9f9f9-0000-4000-8000-0000000000a3';
const SET_PAUSED = 'f9f9f9f9-0000-4000-8000-0000000000a4';

const S_QUEUED = shotId(0xf9a1);
const S_RETRYING = shotId(0xf9a2);
const S_PARKED = shotId(0xf9a3);
const S_REARMED_OLD = shotId(0xf9a4);
const S_REARMED_NEW = shotId(0xf9a5);
const S_PAUSED = shotId(0xf9a6);
const S_EXHAUSTED = shotId(0xf9a7);
const S_RELEASED_OLD = shotId(0xf9a8);
const S_RELEASED_NEW = shotId(0xf9a9);
const RETRYING_REFUSALS = 3;

function setInput(id: string): SessionInput {
  return {
    id,
    mode: 'practice_set',
    shotType: 'forehand_drive',
    focusCheckpoint: null,
    startedAt: '2026-08-26T18:00:00.000Z',
  };
}

type CreatePolicy = 'accept' | 'refuse';
type ShotPolicy = 'accept' | 'refuse' | 'not_found';

/** A server model: a set is known once its create was accepted; a shot of an
 * unknown set is answered `shot.session_not_found` (as `apply_synced_shot`
 * does), every other shot follows `shotPolicy`. */
interface Scripted extends SyncTransport {
  creates: string[];
  offers: string[][];
  knownSets: Set<string>;
  createPolicy: (setId: string) => CreatePolicy;
  shotPolicy: (shotId: string) => ShotPolicy;
  /** When set, every shot request fails before reaching the server. */
  networkDown: boolean;
}

function scripted(): Scripted {
  const t: Scripted = {
    creates: [],
    offers: [],
    knownSets: new Set<string>(),
    createPolicy: () => 'accept',
    shotPolicy: () => 'accept',
    networkDown: false,
    async createSession(session) {
      const id = String((session as { id: unknown }).id);
      t.creates.push(id);
      if (t.createPolicy(id) === 'refuse') {
        throw new ApiError(400, 'session.invalid', 'Session shape is invalid.');
      }
      t.knownSets.add(id);
    },
    async finalizeSession() {},
    async syncShots(shots) {
      const ids = shots.map(s => String((s as { id: unknown }).id));
      t.offers.push(ids);
      if (t.networkDown) throw new TypeError('Network request failed');
      const acceptedIds: string[] = [];
      const rejected: Array<{ id: string; code: string; message: string }> = [];
      for (const shot of shots) {
        const { id: rawId, sessionId } = shot as {
          id: unknown;
          sessionId: unknown;
        };
        const id = String(rawId);
        const unknownSet =
          typeof sessionId === 'string' && !t.knownSets.has(sessionId);
        const policy = unknownSet ? 'not_found' : t.shotPolicy(id);
        if (policy === 'accept') acceptedIds.push(id);
        else if (policy === 'not_found') {
          rejected.push({
            id,
            code: SESSION_NOT_FOUND_REJECTION,
            message: 'Session not found for this shot.',
          });
        } else {
          rejected.push({
            id,
            code: 'shot.invalid_payload',
            message: 'Shot shape is invalid.',
          });
        }
      }
      return { acceptedIds, rejected };
    },
  };
  return t;
}

const offersTo = (t: Scripted, id: string) =>
  t.offers.filter(page => page.includes(id)).length;

interface Row {
  id: number;
  kind: string;
  attempts: number;
  refusals: number;
  quarantined: number;
  lastError: string | null;
  shot: string | null;
  set: string | null;
}

async function outboxRows(db: LocalDb): Promise<Row[]> {
  const { rows } = await db.execute(
    `SELECT id, kind, attempts, refusals, quarantined, last_error,
            CASE WHEN json_valid(payload) AND kind = 'shot.sync'
                 THEN json_extract(payload, '$.id') END AS shot,
            CASE WHEN json_valid(payload) AND kind = 'session.create'
                 THEN json_extract(payload, '$.id') END AS set_id
     FROM outbox WHERE owner_key = ? ORDER BY id`,
    [OWNER],
  );
  return rows.map(r => ({
    id: Number(r['id']),
    kind: String(r['kind']),
    attempts: Number(r['attempts']),
    refusals: Number(r['refusals']),
    quarantined: Number(r['quarantined']),
    lastError: r['last_error'] === null ? null : String(r['last_error']),
    shot: r['shot'] === null ? null : String(r['shot']),
    set: r['set_id'] === null ? null : String(r['set_id']),
  }));
}

function toStatusRows(rows: Row[]): OutboxRowStatus[] {
  return rows.map(r => ({
    kind: r.kind,
    attempts: r.attempts,
    lastError: r.lastError,
    quarantined: r.quarantined === 1,
  }));
}

async function save(
  db: LocalDb,
  id: string,
  set: string | null = null,
): Promise<void> {
  await saveAnalysis(
    db,
    realAnalysis({ id, sessionId: set }),
    PERMIT_ID,
    set === null ? {} : { session: setInput(set) },
  );
}

describe('fix round 9 — R4 state matrix: SQL truth = status = queue banner = offer set', () => {
  let db: LocalDb;
  beforeAll(() => {
    setActiveDataOwner(OWNER);
    db = getDb();
  });
  afterAll(() => {
    db.close();
  });

  it('builds all eight states through the real modules and the four views agree row-for-row', async () => {
    const t = scripted();

    // ── parked (3 sets whose create the server refuses 8 times) ─────────
    await save(db, S_PARKED, SET_PARKED);
    await save(db, S_RELEASED_OLD, SET_RELEASED);
    await save(db, S_REARMED_OLD, SET_REARMED);
    t.createPolicy = () => 'refuse';
    for (let d = 0; d < OUTBOX_MAX_ATTEMPTS; d += 1) await drainOutbox(db, t);
    for (const id of [S_PARKED, S_RELEASED_OLD, S_REARMED_OLD]) {
      // Offered once (the drain that exhausted the create), answered
      // not_found for the SET's fault: uncharged, parked.
      expect(await getShotOutboxStatus(db, id)).toMatchObject({
        state: 'orphaned',
        attempts: 0,
      });
      expect(offersTo(t, id)).toBe(1);
    }
    expect(t.creates).toHaveLength(3 * OUTBOX_MAX_ATTEMPTS);

    // ── exhausted (8 genuine refusals) ──────────────────────────────────
    t.shotPolicy = () => 'refuse';
    await save(db, S_EXHAUSTED);
    for (let d = 0; d < OUTBOX_MAX_ATTEMPTS; d += 1) await drainOutbox(db, t);
    expect(await getShotOutboxStatus(db, S_EXHAUSTED)).toMatchObject({
      state: 'exhausted',
      attempts: OUTBOX_MAX_ATTEMPTS,
    });
    expect(offersTo(t, S_EXHAUSTED)).toBe(OUTBOX_MAX_ATTEMPTS);

    // ── paused (set accepted, shot disowned until the re-arm cap) ───────
    t.createPolicy = () => 'accept';
    t.shotPolicy = () => 'not_found';
    await save(db, S_PAUSED, SET_PAUSED);
    let pausedAfter = 0;
    for (let d = 0; d < 12; d += 1) {
      await drainOutbox(db, t);
      pausedAfter += 1;
      if ((await getShotOutboxStatus(db, S_PAUSED)).state === 'paused') break;
    }
    const paused = await getShotOutboxStatus(db, S_PAUSED);
    expect(paused.state).toBe('paused');
    const pausedOffers = offersTo(t, S_PAUSED);
    expect(pausedOffers).toBeGreaterThan(0);
    expect(pausedOffers).toBeLessThan(OUTBOX_MAX_ATTEMPTS);
    for (let d = 0; d < 5; d += 1) await drainOutbox(db, t);
    expect(offersTo(t, S_PAUSED)).toBe(pausedOffers);
    expect(pausedAfter).toBeLessThanOrEqual(pausedOffers);

    // ── quarantined (a row no request can be built from) ────────────────
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', 'null')`,
      [OWNER],
    );
    const quarantineDrain = await drainOutbox(db, t);
    expect(quarantineDrain).toMatchObject({ failed: 0, quarantined: 1 });

    // ── retrying (3 refusals, budget left; stays live) ──────────────────
    t.shotPolicy = () => 'refuse';
    await save(db, S_RETRYING);
    for (let d = 0; d < RETRYING_REFUSALS; d += 1) await drainOutbox(db, t);
    expect(await getShotOutboxStatus(db, S_RETRYING)).toMatchObject({
      state: 'rejected',
      attempts: RETRYING_REFUSALS,
    });
    expect(offersTo(t, S_EXHAUSTED)).toBe(OUTBOX_MAX_ATTEMPTS);
    expect(offersTo(t, S_PAUSED)).toBe(pausedOffers);

    // ── released (set re-armed by a new read, create ACCEPTED, then the
    //    shot request never reaches the server) ─────────────────────────
    t.shotPolicy = () => 'accept';
    await save(db, S_RELEASED_NEW, SET_RELEASED);
    t.networkDown = true;
    const offersBeforeRelease = t.offers.length;
    await drainOutbox(db, t);
    t.networkDown = false;
    // 8 refusals, SESSION_CREATE_REARM_BOUND automatic revivals (one create
    // each, refused) spent by the drains above, then the new read's re-arm.
    expect(t.creates.filter(id => id === SET_RELEASED)).toHaveLength(
      OUTBOX_MAX_ATTEMPTS + SESSION_CREATE_REARM_BOUND + 1,
    );
    expect(t.offers.length).toBeGreaterThan(offersBeforeRelease);
    for (const id of [S_RELEASED_OLD, S_RELEASED_NEW]) {
      expect(await hasShotSyncReceipt(db, id)).toBe(false);
      expect(await getShotOutboxStatus(db, id)).toMatchObject({
        state: 'queued',
        attempts: 0,
      });
    }

    // ── re-armed (new read into a refused set: live create, old shot still
    //    parked until that create is accepted) ──────────────────────────
    await save(db, S_REARMED_NEW, SET_REARMED);

    // ── queued ──────────────────────────────────────────────────────────
    await save(db, S_QUEUED);

    // ── SQL truth ───────────────────────────────────────────────────────
    const rows = await outboxRows(db);
    const byShot = new Map(rows.filter(r => r.shot).map(r => [r.shot, r]));
    const creates = rows.filter(r => r.kind === 'session.create');
    expect(creates.map(c => [c.set, c.attempts]).sort()).toEqual(
      [
        [SET_PARKED, OUTBOX_MAX_ATTEMPTS],
        [SET_REARMED, 0],
      ].sort(),
    );
    const sqlTruth = {
      queued: [0, 0, 0, null],
      retrying: [RETRYING_REFUSALS, RETRYING_REFUSALS, 0, 'network'],
      parked: [0, 0, 0, 'orphaned'],
      rearmedOld: [0, 0, 0, 'orphaned'],
      rearmedNew: [0, 0, 0, null],
      paused: [pausedOffers, pausedOffers, 0, 'paused'],
      exhausted: [OUTBOX_MAX_ATTEMPTS, OUTBOX_MAX_ATTEMPTS, 0, 'refused'],
      releasedOld: [0, 0, 0, 'network'],
      releasedNew: [0, 0, 0, 'network'],
    };
    const describe = (r: Row | undefined) => {
      if (!r) return 'missing';
      const e = r.lastError;
      const label =
        e === null
          ? null
          : e.startsWith('shot.session_orphaned')
            ? 'orphaned'
            : e.startsWith('shot.session_paused')
              ? 'paused'
              : e.includes('Network request failed')
                ? 'network'
                : e.startsWith('shot.invalid_payload')
                  ? 'refused'
                  : e;
      return [r.attempts, r.refusals, r.quarantined, label];
    };
    expect({
      queued: describe(byShot.get(S_QUEUED)),
      retrying: describe(byShot.get(S_RETRYING)),
      parked: describe(byShot.get(S_PARKED)),
      rearmedOld: describe(byShot.get(S_REARMED_OLD)),
      rearmedNew: describe(byShot.get(S_REARMED_NEW)),
      paused: describe(byShot.get(S_PAUSED)),
      exhausted: describe(byShot.get(S_EXHAUSTED)),
      releasedOld: describe(byShot.get(S_RELEASED_OLD)),
      releasedNew: describe(byShot.get(S_RELEASED_NEW)),
    }).toEqual(sqlTruth);
    const nullRow = rows.find(r => r.kind === 'shot.sync' && r.shot === null);
    expect(nullRow).toMatchObject({ quarantined: 1, refusals: 0 });

    // ── view 2: getShotOutboxStatus, row for row ────────────────────────
    const states = new Map<string, string>();
    for (const id of byShot.keys()) {
      if (id) states.set(id, (await getShotOutboxStatus(db, id)).state);
    }
    expect(Object.fromEntries(states)).toEqual({
      [S_QUEUED]: 'queued',
      [S_RETRYING]: 'rejected',
      [S_PARKED]: 'orphaned',
      [S_REARMED_OLD]: 'orphaned',
      [S_REARMED_NEW]: 'queued',
      [S_PAUSED]: 'paused',
      [S_EXHAUSTED]: 'exhausted',
      [S_RELEASED_OLD]: 'queued',
      [S_RELEASED_NEW]: 'queued',
    });

    // ── view 3: deriveUploadQueueStatus over the same rows ──────────────
    // 9 shot rows + 1 quarantined + 2 create rows = 12; finished = the
    // exhausted shot + the refused set's create; paused 1; quarantined 1;
    // the rest (including the two parked shots) are pending.
    expect(rows).toHaveLength(12);
    expect(deriveUploadQueueStatus(toStatusRows(rows))).toEqual({
      state: 'needs_attention',
      pending: 8,
      exhausted: 2,
      quarantined: 1,
      paused: 1,
    });

    // ── view 4: the next drain's actual offer set ───────────────────────
    t.createPolicy = id => (id === SET_PARKED ? 'refuse' : 'accept');
    t.offers.length = 0;
    t.creates.length = 0;
    const final = await drainOutbox(db, t);
    const offered = new Set(t.offers.flat());
    expect([...offered].sort()).toEqual(
      [
        S_QUEUED,
        S_RETRYING,
        S_REARMED_OLD,
        S_REARMED_NEW,
        S_RELEASED_OLD,
        S_RELEASED_NEW,
      ].sort(),
    );
    expect(t.creates).toEqual([SET_REARMED]);
    expect(final).toMatchObject({ synced: 7, failed: 0 });
    expect(final.quarantined ?? 0).toBe(0);
    for (const id of offered) {
      expect(await hasShotSyncReceipt(db, id)).toBe(true);
      expect(await getShotOutboxStatus(db, id)).toEqual({ state: 'absent' });
    }
    // Rows the banner called finished / paused, and the parked shot of a
    // set the server still refuses, were not offered and did not move.
    const after = await outboxRows(db);
    const afterByShot = new Map(
      after.filter(r => r.shot).map(r => [r.shot, r]),
    );
    expect(describe(afterByShot.get(S_PARKED))).toEqual(sqlTruth.parked);
    expect(describe(afterByShot.get(S_PAUSED))).toEqual(sqlTruth.paused);
    expect(describe(afterByShot.get(S_EXHAUSTED))).toEqual(sqlTruth.exhausted);
    expect(after.find(r => r.kind === 'shot.sync' && r.shot === null)).toEqual(
      nullRow,
    );
    expect(deriveUploadQueueStatus(toStatusRows(after))).toEqual({
      state: 'needs_attention',
      pending: 1,
      exhausted: 2,
      quarantined: 1,
      paused: 1,
    });
  });
});
