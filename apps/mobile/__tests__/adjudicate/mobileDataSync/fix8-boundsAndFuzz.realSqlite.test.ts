/**
 * Fix round 8 (candidate A) — the constants this branch states, pinned.
 *
 * R1  accept + `shot.session_not_found` pathology: exactly
 *     `1 + SESSION_CREATE_REARM_BOUND` createSession and as many syncShots
 *     calls per set until a NEW read joins it; the shot's lifetime refusal
 *     count (what the Result copy reads) equals what the server issued.
 * O1  an exhausted set with a parked read is asked for again on later drains
 *     exactly `SESSION_CREATE_REARM_BOUND` times without a new read; a
 *     revival the server accepts releases and delivers the parked read in
 *     that same drain.
 * S2  ≥200 seeded malformed payload shapes across every outbox kind: the
 *     drain completes, every healthy row syncs, every malformed row is
 *     quarantined ONCE (attempts = OUTBOX_MAX_ATTEMPTS, truthful last_error)
 *     and never re-read, and the connection lease is not leaked.
 * F2  UploadQueueStatus: a parked read at attempts = OUTBOX_MAX_ATTEMPTS is
 *     pending, not exhausted.
 * F3  an accepted upload whose settlement (receipt + delete) fails on the
 *     device keeps its row, uncharged, and is offered again by the next drain
 *     (the server's apply_synced_shot upsert is idempotent); a receipt is
 *     never written for a row the settlement could not delete.
 *
 * Real node:sqlite through the op-sqlite shim; real transaction / sync /
 * repository / accountScope modules.
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
import { deriveUploadQueueStatus } from '../../../src/data/offlineCapabilities';
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
const SET_A = 'a8a8a8a8-0000-4000-8000-000000000001';
const SET_B = 'a8a8a8a8-0000-4000-8000-000000000002';

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
  await db.execute(`DELETE FROM outbox`);
  await db.execute(`DELETE FROM local_shot`);
  await db.execute(`DELETE FROM local_session`);
  await db.execute(`DELETE FROM sync_receipt`);
}

interface CountingTransport extends SyncTransport {
  creates: string[];
  offers: string[][];
  trials: number;
}

/** Accepts every set; answers every shot with `shot.session_not_found`. */
function acceptSetDisownShotsTransport(): CountingTransport {
  const creates: string[] = [];
  const offers: string[][] = [];
  return {
    creates,
    offers,
    trials: 0,
    async createSession(session) {
      creates.push(String((session as { id: unknown }).id));
    },
    async finalizeSession() {},
    async syncShots(shots) {
      const ids = shots.map(s => String((s as { id: unknown }).id));
      offers.push(ids);
      return {
        acceptedIds: [],
        rejected: ids.map(id => ({
          id,
          code: SESSION_NOT_FOUND_REJECTION,
          message: 'Session not found for this shot.',
        })),
      };
    },
  };
}

/** Refuses every set with a permanent 409 until `acceptFrom` creates have
 * been refused; accepts every shot whose set it has accepted. */
function refusingSetTransport(acceptFrom: number): CountingTransport {
  const creates: string[] = [];
  const offers: string[][] = [];
  const known = new Set<string>();
  return {
    creates,
    offers,
    trials: 0,
    async createSession(session) {
      const id = String((session as { id: unknown }).id);
      creates.push(id);
      if (creates.length <= acceptFrom) {
        throw new ApiError(409, 'session.id_conflict', 'conflict');
      }
      known.add(id);
    },
    async finalizeSession() {},
    async syncShots(shots) {
      const entries = shots as Array<{ id: string; sessionId: string | null }>;
      offers.push(entries.map(e => e.id));
      return {
        acceptedIds: entries
          .filter(e => e.sessionId === null || known.has(e.sessionId))
          .map(e => e.id),
        rejected: entries
          .filter(e => e.sessionId !== null && !known.has(e.sessionId))
          .map(e => ({
            id: e.id,
            code: SESSION_NOT_FOUND_REJECTION,
            message: 'Session not found for this shot.',
          })),
      };
    },
  };
}

describe('fix round 8 — stated bounds and malformed-shape fuzz (real SQLite)', () => {
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

  it('R1: accept + session_not_found costs exactly 1 + SESSION_CREATE_REARM_BOUND createSession and syncShots calls per set, then the set is paused with a truthful lifetime count until a new read joins it', async () => {
    const transport = acceptSetDisownShotsTransport();
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x800), sessionId: SET_A }),
      PERMIT_ID,
      { session: setInput(SET_A) },
    );
    const results: number[] = [];
    for (let d = 0; d < 40; d += 1) {
      results.push((await drainOutbox(db, transport)).failed);
    }
    const bound = 1 + SESSION_CREATE_REARM_BOUND;
    expect({
      creates: transport.creates.length,
      offers: transport.offers.length,
      // Every one of those offers was refused, and only those drains fail.
      failedDrains: results.filter(f => f > 0).length,
    }).toEqual({ creates: bound, offers: bound, failedDrains: bound });

    // The Result copy reads the lifetime refusal count — what the server
    // actually issued — and the row says why nothing more is sent.
    // Re-pinned (fix9, Q1.3): the shot of a paused set reports its own
    // `paused` state — `rejected` would promise a retry no drain performs.
    const paused = await getShotOutboxStatus(db, shotId(0x800));
    expect(paused).toEqual({
      state: 'paused',
      attempts: bound,
      lastError: expect.stringContaining(
        'paused until a new read joins the set',
      ),
    });
    const rows = await outboxRows(db, OWNER);
    expect(rows.map(r => r.kind)).toEqual(['shot.sync']);
    expect(await drainOutbox(db, transport)).toEqual({
      synced: 0,
      failed: 0,
      remaining: 1,
    });

    // A new read joining the set is the ONE occasion the set's budget is
    // renewed: the set is already known to the server (its create was
    // accepted), so the read is offered first and each refusal re-queues the
    // set from `local_session` — SESSION_CREATE_REARM_BOUND more creates,
    // 1 + SESSION_CREATE_REARM_BOUND more offers — then paused again. The
    // lifetime counts only ever grow.
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x801), sessionId: SET_A }),
      PERMIT_ID,
      { session: setInput(SET_A) },
    );
    for (let d = 0; d < 40; d += 1) await drainOutbox(db, transport);
    expect({
      creates: transport.creates.length,
      offers: transport.offers.length,
    }).toEqual({
      creates: bound + SESSION_CREATE_REARM_BOUND,
      offers: 2 * bound,
    });
    // Re-pinned (fix9, Q1.3): both shots of the re-paused set report
    // `paused` with their lifetime refusal counts.
    expect(await getShotOutboxStatus(db, shotId(0x800))).toMatchObject({
      state: 'paused',
      attempts: 2 * bound,
    });
    expect(await getShotOutboxStatus(db, shotId(0x801))).toMatchObject({
      state: 'paused',
      attempts: bound,
    });
    expect(
      (await outboxRows(db, OWNER)).filter(r => r.kind === 'session.create'),
    ).toEqual([]);
  });

  it('O1: an exhausted set with a parked read is asked for again exactly SESSION_CREATE_REARM_BOUND more times across later drains; the parked read is offered once at most, uncharged', async () => {
    const transport = refusingSetTransport(Number.POSITIVE_INFINITY);
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x810), sessionId: SET_A }),
      PERMIT_ID,
      { session: setInput(SET_A) },
    );
    const createsPerDrain: number[] = [];
    for (let d = 0; d < 30; d += 1) {
      const before = transport.creates.length;
      await drainOutbox(db, transport);
      createsPerDrain.push(transport.creates.length - before);
    }
    expect(createsPerDrain).toEqual([
      ...Array.from(
        { length: OUTBOX_MAX_ATTEMPTS + SESSION_CREATE_REARM_BOUND },
        () => 1,
      ),
      ...Array.from(
        { length: 30 - OUTBOX_MAX_ATTEMPTS - SESSION_CREATE_REARM_BOUND },
        () => 0,
      ),
    ]);
    // The drain that exhausts the set offers its shot once (the set's
    // refusal and the shot's `shot.session_not_found` land in the same
    // drain); the verdict parks it uncharged and it is never offered again.
    expect(transport.offers).toEqual([[shotId(0x810)]]);
    expect(await getShotOutboxStatus(db, shotId(0x810))).toMatchObject({
      state: 'orphaned',
      attempts: 0,
      lastError: expect.stringContaining(SESSION_ORPHANED_VERDICT),
    });
    const rows = await outboxRows(db, OWNER);
    expect(rows.map(r => [r.kind, r.attempts])).toEqual([
      ['session.create', OUTBOX_MAX_ATTEMPTS],
      ['shot.sync', 0],
    ]);
  });

  it('O1: a revival the server accepts releases the parked read and delivers it in that same drain', async () => {
    // Refuses the first OUTBOX_MAX_ATTEMPTS creates (the set exhausts), then
    // accepts: the first automatic revival lands.
    const transport = refusingSetTransport(OUTBOX_MAX_ATTEMPTS);
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x820), sessionId: SET_A }),
      PERMIT_ID,
      { session: setInput(SET_A) },
    );
    for (let d = 0; d < OUTBOX_MAX_ATTEMPTS; d += 1) {
      await drainOutbox(db, transport);
    }
    expect(await getShotOutboxStatus(db, shotId(0x820))).toMatchObject({
      state: 'orphaned',
      attempts: 0,
    });
    expect(transport.offers).toEqual([[shotId(0x820)]]);

    const revived = await drainOutbox(db, transport);
    expect(revived).toEqual({ synced: 2, failed: 0, remaining: 0 });
    expect(transport.creates).toHaveLength(OUTBOX_MAX_ATTEMPTS + 1);
    expect(transport.offers).toEqual([[shotId(0x820)], [shotId(0x820)]]);
    expect(await hasShotSyncReceipt(db, shotId(0x820))).toBe(true);
    expect(await getShotOutboxStatus(db, shotId(0x820))).toEqual({
      state: 'absent',
    });
    expect(await outboxRows(db, OWNER)).toEqual([]);
  });

  it('S2: ≥200 seeded malformed payload shapes across every kind — the drain completes, healthy rows sync, every malformed row is quarantined once and never re-read, no lease is leaked', async () => {
    let seed = 0x5eed;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pick = <T>(items: readonly T[]): T =>
      items[Math.floor(random() * items.length)]!;

    const rawTexts = [
      '{not json',
      '',
      ' ',
      'null',
      '[]',
      '[1,2,3]',
      '"just a string"',
      '42',
      'true',
      '\u00ff\u00fe not json',
      '{"id": ',
      '{}',
      '{"id": null}',
      '{"id": 42}',
      '{"id": ""}',
      '{"id": []}',
      '{"id": {}}',
      '{"trialId": null}',
    ];
    const idVariants: unknown[] = [undefined, null, 42, '', [], {}, true];
    const permitVariants: unknown[] = [undefined, null, 42, '', [], {}];
    const sessionVariants: unknown[] = [42, {}, [], true];
    const checkpointVariants: unknown[] = [
      'nope',
      42,
      null,
      {},
      [null],
      [1],
      ['x'],
      [[]],
    ];
    const kinds = [
      'shot.sync',
      'session.create',
      'session.finalize',
      'evaluation.trial',
      'bogus.kind',
    ] as const;

    const generate = (): { kind: string; payload: string } => {
      const family = random();
      if (family < 0.3) return { kind: pick(kinds), payload: pick(rawTexts) };
      if (family < 0.5) {
        const id = pick(idVariants);
        return {
          kind: pick(kinds),
          payload: JSON.stringify(
            id === undefined ? { mode: 'practice_set' } : { id, trialId: id },
          ),
        };
      }
      // A shot whose request cannot be built: bad id, permit, session or
      // checkpoints (one or several at once).
      const shot: Record<string, unknown> = {
        ...realAnalysis({ id: shotId(0x1000 + Math.floor(random() * 4096)) }),
        analysisPermitId: PERMIT_ID,
      };
      let broke = false;
      if (random() < 0.4) {
        const id = pick(idVariants);
        if (id === undefined) delete shot['id'];
        else shot['id'] = id;
        broke = true;
      }
      if (random() < 0.4) {
        const permit = pick(permitVariants);
        if (permit === undefined) delete shot['analysisPermitId'];
        else shot['analysisPermitId'] = permit;
        broke = true;
      }
      if (random() < 0.4) {
        shot['sessionId'] = pick(sessionVariants);
        broke = true;
      }
      if (!broke || random() < 0.4) {
        shot['checkpoints'] = pick(checkpointVariants);
      }
      return { kind: 'shot.sync', payload: JSON.stringify(shot) };
    };

    const shapes = new Set<string>();
    const malformed: Array<{ kind: string; payload: string }> = [];
    while (malformed.length < 240) {
      const next = generate();
      const key = `${next.kind}\u0000${next.payload}`;
      if (shapes.has(key)) continue;
      shapes.add(key);
      malformed.push(next);
    }
    expect(malformed.length).toBeGreaterThanOrEqual(200);

    // Healthy rows before, among and after the malformed ones.
    await saveAnalysis(db, realAnalysis({ id: shotId(0x830) }), PERMIT_ID);
    for (const [i, row] of malformed.entries()) {
      if (i === 120) {
        await saveAnalysis(
          db,
          realAnalysis({ id: shotId(0x831), sessionId: SET_B }),
          PERMIT_ID,
          { session: setInput(SET_B) },
        );
      }
      await db.execute(
        `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, ?, ?)`,
        [OWNER, row.kind, row.payload],
      );
    }
    await saveAnalysis(db, realAnalysis({ id: shotId(0x832) }), PERMIT_ID);

    const transport: CountingTransport = {
      ...refusingSetTransport(0),
      async uploadEvaluationTrials(trials) {
        transport.trials += trials.length;
        return {
          acceptedTrialIds: trials.map(t =>
            String((t as { trialId: unknown }).trialId),
          ),
          rejected: [],
        };
      },
    };

    const first = await drainOutbox(db, transport);
    const rows = await outboxRows(db, OWNER);
    expect({
      healthy: [
        await hasShotSyncReceipt(db, shotId(0x830)),
        await hasShotSyncReceipt(db, shotId(0x831)),
        await hasShotSyncReceipt(db, shotId(0x832)),
      ],
      synced: first.synced,
      remaining: first.remaining,
      // Everything the drain could not turn into a request is quarantined:
      // budget spent in one statement, a truthful reason, never re-read.
      quarantined: rows.every(
        r =>
          r.attempts === OUTBOX_MAX_ATTEMPTS &&
          r.last_error !== null &&
          r.last_error.length > 0,
      ),
      leftUnderBudget: rows.filter(r => r.attempts < OUTBOX_MAX_ATTEMPTS)
        .length,
    }).toEqual({
      healthy: [true, true, true],
      // The three healthy shots and SET_B's create, plus every seeded row
      // that WAS a buildable request (the server accepted it): all of it
      // left the queue, and only quarantined rows remain.
      synced: malformed.length + 4 - rows.length,
      remaining: rows.length,
      quarantined: true,
      leftUnderBudget: 0,
    });
    // Re-pinned (fix9, Q1.4): quarantined rows are reported apart from
    // `failed` — the server never saw them, so the runtime's back-off does
    // not move for them.
    expect({ failed: first.failed, quarantined: first.quarantined }).toEqual({
      failed: 0,
      quarantined: rows.length,
    });
    expect(rows.length).toBeGreaterThanOrEqual(200);

    // Quarantined once: later drains re-read nothing and report nothing.
    expect(await drainOutbox(db, transport)).toEqual({
      synced: 0,
      failed: 0,
      remaining: rows.length,
    });
    expect(await outboxRows(db, OWNER)).toEqual(rows);

    // No lease leaked: a repository write and a further drain both complete.
    await saveAnalysis(db, realAnalysis({ id: shotId(0x833) }), PERMIT_ID);
    expect(await drainOutbox(db, transport)).toEqual({
      synced: 1,
      failed: 0,
      remaining: rows.length,
    });
    expect(await hasShotSyncReceipt(db, shotId(0x833))).toBe(true);
  });

  it('F2: UploadQueueStatus counts a parked read at attempts = OUTBOX_MAX_ATTEMPTS as pending, not exhausted', () => {
    expect(
      deriveUploadQueueStatus([
        {
          kind: 'shot.sync',
          attempts: OUTBOX_MAX_ATTEMPTS,
          lastError: `${SESSION_ORPHANED_VERDICT}: Its practice set was refused.`,
        },
        { kind: 'shot.sync', attempts: 0, lastError: null },
      ]),
    ).toEqual({ state: 'queued', pending: 2 });
    expect(
      deriveUploadQueueStatus([
        {
          kind: 'shot.sync',
          attempts: OUTBOX_MAX_ATTEMPTS,
          lastError: `${SESSION_ORPHANED_VERDICT}: Its practice set was refused.`,
        },
        {
          kind: 'session.create',
          attempts: OUTBOX_MAX_ATTEMPTS,
          lastError: 'ApiError: 409 session.id_conflict',
        },
      ]),
    ).toEqual({ state: 'needs_attention', pending: 1, exhausted: 1 });
  });

  it('F3: an accepted upload whose settlement fails on the device is re-offered uncharged and settles idempotently on the next drain', async () => {
    const id = shotId(0x8f3);
    await saveAnalysis(db, realAnalysis({ id }), PERMIT_ID);
    const offers: string[][] = [];
    const transport: SyncTransport = {
      async createSession() {},
      async finalizeSession() {},
      async syncShots(shots) {
        const ids = shots.map(s => String((s as { id: unknown }).id));
        offers.push(ids);
        return { acceptedIds: ids, rejected: [] };
      },
    };
    let failSettlement = true;
    const faulty: LocalDb = {
      async execute(sql, params) {
        if (failSettlement && sql.startsWith('DELETE FROM outbox')) {
          failSettlement = false;
          throw new Error('SQLITE_FULL: database or disk is full');
        }
        return db.execute(sql, params);
      },
      close() {
        db.close();
      },
    };

    expect(await drainOutbox(faulty, transport)).toEqual({
      synced: 0,
      failed: 1,
      remaining: 1,
    });
    expect(offers).toEqual([[id]]);
    // The settlement transaction rolled back as a unit: no receipt without
    // the deletion, the row keeps its place and its budget.
    expect(await hasShotSyncReceipt(db, id)).toBe(false);
    expect(await outboxRows(db, OWNER)).toEqual([
      {
        id: expect.any(Number),
        kind: 'shot.sync',
        attempts: 0,
        last_error: expect.stringContaining('SQLITE_FULL'),
      },
    ]);
    // No lease leaked by the failed settlement.
    await saveAnalysis(db, realAnalysis({ id: shotId(0x8f4) }), PERMIT_ID);

    expect(await drainOutbox(faulty, transport)).toEqual({
      synced: 2,
      failed: 0,
      remaining: 0,
    });
    expect(offers).toEqual([[id], [id, shotId(0x8f4)]]);
    expect(await hasShotSyncReceipt(db, id)).toBe(true);
    expect(await hasShotSyncReceipt(db, shotId(0x8f4))).toBe(true);
    expect(await outboxRows(db, OWNER)).toEqual([]);
  });
});
