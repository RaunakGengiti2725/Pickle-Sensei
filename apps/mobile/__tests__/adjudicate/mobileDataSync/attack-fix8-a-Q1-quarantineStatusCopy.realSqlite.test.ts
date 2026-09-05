/**
 * Adversary round 8 — candidate `devin/fix8-mds-sqlite-a` @ 24fd777b.
 * Claims (2), (3), (6), (7): malformed rows are quarantined once with a
 * truthful `last_error`, never block healthy rows and never touch the owner's
 * backoff; `getShotOutboxStatus` / ResultScreen copy are truthful in every
 * reachable outbox state.
 *
 * Real `node:sqlite`, real modules; the transport is the only mock and it
 * models the edge function's documented responses (`shot.session_not_found`
 * per row; a whole-request 413 once the JSON body exceeds
 * MAX_JSON_BODY_BYTES = 5_000_000, see supabase/functions/api/index.ts).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ShotAnalysis } from '@pickle/shared-types';
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
  type SessionInput,
} from '../../../src/data/repository';
import { connectionWaiters } from '../../../src/data/transaction';
import {
  OUTBOX_MAX_ATTEMPTS,
  SESSION_NOT_FOUND_REJECTION,
  drainOutbox,
  type SyncTransport,
} from '../../../src/data/sync';
import {
  CANONICAL_USER,
  PERMIT_ID,
  acceptAllTransport,
  outboxRows,
  realAnalysis,
  shotId,
} from '../../../adjudicate/mobile-data-sync/fixtures';

const OWNER = canonicalDataOwner(CANONICAL_USER);
const SET = 'c8c8c8c8-0000-4000-8000-000000000001';
const MAX_JSON_BODY_BYTES = 5_000_000;

const RESULT_SCREEN = readFileSync(
  join(__dirname, '../../../src/screens/ResultScreen.tsx'),
  'utf8',
);

function setInput(id: string): SessionInput {
  return {
    id,
    mode: 'practice_set',
    shotType: 'forehand_drive',
    focusCheckpoint: null,
    startedAt: '2026-08-26T18:00:00.000Z',
  };
}

async function plantShotRow(
  db: LocalDb,
  payload: string | null,
  owner: string | null = OWNER,
): Promise<number> {
  await db.execute(
    `INSERT INTO outbox (owner_key, kind, payload, created_at) VALUES (?, 'shot.sync', ?, datetime('now'))`,
    [owner, payload],
  );
  const { rows } = await db.execute(`SELECT last_insert_rowid() AS id`);
  return Number(rows[0]?.['id']);
}

function offersOf(t: { syncCalls: unknown[][] }, id: string): number {
  return t.syncCalls.filter(page =>
    page.some(s => String((s as { id: unknown }).id) === id),
  ).length;
}

describe('attack-fix8-a Q1 — quarantine, page fairness and status/copy truth', () => {
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

  it('Q1.1 BREAK — a quarantined row (never offered) is reported as `exhausted` with 8 server refusals; ResultScreen then reads "Sync was refused 8 times"', async () => {
    const id = shotId(0xd100);
    // Passes json_valid and has a string id; fails the parse guard (no permit).
    const payload = JSON.stringify({ ...realAnalysis({ id }) });
    await plantShotRow(db, payload);
    const t = acceptAllTransport();
    expect(await drainOutbox(db, t)).toEqual({
      synced: 0,
      failed: 1,
      remaining: 1,
    });
    await drainOutbox(db, t);
    const [row] = await outboxRows(db, OWNER);
    const { rows } = await db.execute(
      `SELECT refusals FROM outbox WHERE id = ?`,
      [row?.id ?? -1],
    );
    const status = await getShotOutboxStatus(db, id);
    expect(offersOf(t, id)).toBe(0);
    expect(RESULT_SCREEN).toContain(
      'Sync was refused ${syncEvidence.attempts} times and this read will not be sent again',
    );
    // Observed: attempts 8, refusals 8, status { state: 'exhausted',
    // attempts: 8 } — the Result surface says the server refused it 8 times
    // although the server never saw it. Expected: a lifetime `refusals`
    // that counts server refusals only (0 here) and copy that does not
    // attribute the quarantine to the server.
    expect({
      refusals: Number(rows[0]?.['refusals']),
      reported: status.state === 'exhausted' ? status.attempts : status.state,
    }).toEqual({ refusals: 0, reported: 0 });
  });

  it('Q1.2 BREAK — one oversized shot in a page makes the whole request 413: the 5 healthy rows of the page are charged 8× and exhausted, never offered alone', async () => {
    const healthy = Array.from({ length: 5 }, (_, i) => shotId(0xd200 + i));
    for (const id of healthy) {
      await saveAnalysis(db, realAnalysis({ id }), PERMIT_ID);
    }
    // `phases` is copied verbatim into the sync payload (toSyncPayload).
    const huge = shotId(0xd2ff);
    await saveAnalysis(
      db,
      {
        ...realAnalysis({ id: huge }),
        phases: [{ name: 'g'.repeat(MAX_JSON_BODY_BYTES + 1) }],
      } as unknown as ShotAnalysis,
      PERMIT_ID,
    );
    const t = acceptAllTransport();
    const inner = t.syncShots.bind(t);
    t.syncShots = async shots => {
      if (JSON.stringify({ shots }).length > MAX_JSON_BODY_BYTES) {
        throw new ApiError(
          413,
          'http.payload_too_large',
          'Request body is too large.',
        );
      }
      return inner(shots);
    };
    for (let d = 0; d < OUTBOX_MAX_ATTEMPTS; d += 1) await drainOutbox(db, t);
    expect(connectionWaiters()).toBe(0);
    const statuses = await Promise.all(
      healthy.map(id => getShotOutboxStatus(db, id)),
    );
    const receipts = await Promise.all(
      healthy.map(id => hasShotSyncReceipt(db, id)),
    );
    // Observed: every healthy row { state: 'exhausted', attempts: 8,
    // lastError: 'Error: Request body is too large.' }, no receipts; the
    // healthy rows were only ever offered together with the oversized one.
    // Expected: the request-level refusal charged to the row that caused it
    // (or split/retried), healthy rows accepted.
    expect(receipts).toEqual([true, true, true, true, true]);
    expect(statuses.map(s => s.state)).toEqual(Array(5).fill('absent'));
  });

  it('Q1.3 BREAK — a paused set (rearms past the bound) reports `rejected` and ResultScreen promises "will be retried", but 50 drains offer the shot 0 times', async () => {
    const id = shotId(0xd300);
    await saveAnalysis(db, realAnalysis({ id, sessionId: SET }), PERMIT_ID, {
      session: setInput(SET),
    });
    const t: SyncTransport & { syncCalls: unknown[][] } = {
      syncCalls: [],
      async createSession() {},
      async finalizeSession() {},
      async syncShots(shots) {
        t.syncCalls.push(shots);
        return {
          acceptedIds: [],
          rejected: shots.map(s => ({
            id: String((s as { id: unknown }).id),
            code: SESSION_NOT_FOUND_REJECTION,
            message: 'Session not found for this shot.',
          })),
        };
      },
    };
    for (let d = 0; d < 6; d += 1) await drainOutbox(db, t);
    const status = await getShotOutboxStatus(db, id);
    expect(status).toMatchObject({ state: 'rejected', attempts: 3 });
    const before = offersOf(t, id);
    for (let d = 0; d < 50; d += 1) await drainOutbox(db, t);
    const offersWhilePaused = offersOf(t, id) - before;
    expect(offersWhilePaused).toBe(0);
    expect(RESULT_SCREEN).toContain(
      '. It stays in the secure outbox and will be retried; training unlocks only if the server accepts it.',
    );
    // Observed: state 'rejected' (→ "The server refused this read 3 of 8
    // times … It stays in the secure outbox and will be retried") while the
    // drain will not offer it again without a new read in the set.
    // Expected: a state whose copy does not promise a retry the code does
    // not perform (APP_STORE_SUBMISSION.md: no automatic-resend promise).
    expect(status.state).not.toBe('rejected');
  });

  it('Q1.4 BREAK — 10,000 quarantined rows ahead of one healthy row: the healthy row is delivered in drain 1 and nothing is re-read, but the drain reports failed = 10,000 (the runtime counts that as a failed drain and backs off)', async () => {
    for (let i = 0; i < 10_000; i += 1) {
      await db.execute(
        `INSERT INTO outbox (owner_key, kind, payload, created_at) VALUES (?, 'shot.sync', 'null', datetime('now'))`,
        [OWNER],
      );
    }
    const id = shotId(0xd400);
    await saveAnalysis(db, realAnalysis({ id }), PERMIT_ID);
    const t = acceptAllTransport();
    const first = await drainOutbox(db, t);
    expect(await hasShotSyncReceipt(db, id)).toBe(true);
    expect(offersOf(t, id)).toBe(1);
    const second = await drainOutbox(db, t);
    expect(second).toEqual({ synced: 0, failed: 0, remaining: 10_000 });
    const { rows } = await db.execute(
      `SELECT count(*) AS n, min(length(last_error)) AS mn, max(length(last_error)) AS mx,
              min(attempts) AS a0, max(attempts) AS a1
       FROM outbox WHERE owner_key = ?`,
      [OWNER],
    );
    expect(rows).toEqual([{ n: 10_000, mn: 38, mx: 38, a0: 8, a1: 8 }]);
    // Observed: { synced: 1, failed: 10000, remaining: 10000 } —
    // syncRuntime's `consecutiveFailures = result.failed > 0 ? +1 : 0` turns
    // the quarantine into one failed drain and a longer retry delay.
    // Expected under "never affect the owner's backoff": failed 0.
    expect(first).toEqual({ synced: 1, failed: 0, remaining: 10_000 });
  }, 60_000);

  it('Q1.5 probe — corrupt session.create (payload null) with healthy shots of the set: quarantined once, the set is re-queued from local_session and the shots deliver', async () => {
    const ids = [shotId(0xd500), shotId(0xd501)];
    for (const id of ids) {
      await saveAnalysis(db, realAnalysis({ id, sessionId: SET }), PERMIT_ID, {
        session: setInput(SET),
      });
    }
    await db.execute(
      `UPDATE outbox SET payload = 'null' WHERE owner_key = ? AND kind = 'session.create'`,
      [OWNER],
    );
    // Server model: a shot is accepted only once its set exists.
    const t = acceptAllTransport();
    t.syncShots = async shots => {
      t.syncCalls.push(shots);
      const known = shots.filter(s =>
        t.sessions.includes(String((s as { sessionId: unknown }).sessionId)),
      );
      return {
        acceptedIds: known.map(s => String((s as { id: unknown }).id)),
        rejected: shots
          .filter(s => !known.includes(s))
          .map(s => ({
            id: String((s as { id: unknown }).id),
            code: SESSION_NOT_FOUND_REJECTION,
            message: 'Session not found for this shot.',
          })),
      };
    };
    const results = [];
    for (let d = 0; d < 4; d += 1) results.push(await drainOutbox(db, t));
    expect(results.slice(0, 2)).toEqual([
      { synced: 0, failed: 3, remaining: 4 },
      { synced: 3, failed: 0, remaining: 1 },
    ]);
    expect(t.sessions).toEqual([SET]);
    expect(
      await Promise.all(ids.map(id => hasShotSyncReceipt(db, id))),
    ).toEqual([true, true]);
    const left = await outboxRows(db, OWNER);
    expect(left.map(r => [r.kind, r.attempts])).toEqual([
      ['session.create', 8],
    ]);
  });

  it('Q1.6 probe — payload shapes that pass json_valid: each drain resolves, quarantined rows are never re-read, valid-but-odd ids are offered and settled', async () => {
    const shapes: Array<[string, string | null]> = [
      [
        'id object',
        JSON.stringify({
          ...realAnalysis(),
          id: { a: 1 },
          analysisPermitId: PERMIT_ID,
        }),
      ],
      [
        'id number',
        JSON.stringify({
          ...realAnalysis(),
          id: 42,
          analysisPermitId: PERMIT_ID,
        }),
      ],
      [
        'id with NUL',
        JSON.stringify({
          ...realAnalysis({ id: 'a\u0000b' }),
          analysisPermitId: PERMIT_ID,
        }),
      ],
      [
        '__proto__ key',
        `{"__proto__":{"polluted":true},${JSON.stringify({ ...realAnalysis({ id: shotId(0xd601) }), analysisPermitId: PERMIT_ID }).slice(1)}`,
      ],
      [
        'deep nesting',
        JSON.stringify({
          ...realAnalysis({ id: shotId(0xd602) }),
          analysisPermitId: PERMIT_ID,
          guidance: JSON.parse(
            `${'['.repeat(2_000)}${']'.repeat(2_000)}`,
          ) as unknown,
        }),
      ],
      [
        '1 MB string',
        JSON.stringify({
          ...realAnalysis({ id: shotId(0xd603) }),
          analysisPermitId: PERMIT_ID,
          guidance: 'm'.repeat(1_000_000),
        }),
      ],
      [
        'session payload under shot kind',
        JSON.stringify({
          id: shotId(0xd604),
          mode: 'practice_set',
          shotType: 'forehand_drive',
          startedAt: 'x',
        }),
      ],
    ];
    // (A NULL owner_key row cannot exist: outbox.owner_key is NOT NULL in
    // this schema — the INSERT is refused by SQLite.)
    await expect(plantShotRow(db, '{"id":"x"}', null)).rejects.toThrow(
      'NOT NULL constraint failed: outbox.owner_key',
    );
    const t = acceptAllTransport();
    for (const [, payload] of shapes) {
      await plantShotRow(db, payload);
    }
    const results = [];
    for (let d = 0; d < 3; d += 1) results.push(await drainOutbox(db, t));
    expect(connectionWaiters()).toBe(0);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    // Valid-but-odd rows (NUL id, __proto__ key, deep guidance, 1 MB string)
    // are offered once and accepted; the rest are quarantined in drain 1.
    expect(results).toEqual([
      { synced: 4, failed: 3, remaining: 3 },
      { synced: 0, failed: 0, remaining: 3 },
      { synced: 0, failed: 0, remaining: 3 },
    ]);
    const left = await outboxRows(db, OWNER);
    expect(left.every(r => r.attempts === OUTBOX_MAX_ATTEMPTS)).toBe(true);
    expect(left.every(r => (r.last_error?.length ?? 0) <= 200)).toBe(true);
    expect(t.syncCalls.length).toBe(1);
  });

  it('Q1.7 probe — an accepted session.create does not revive a quarantined shot of the same set', async () => {
    const id = shotId(0xd700);
    await saveAnalysis(db, realAnalysis({ id, sessionId: SET }), PERMIT_ID, {
      session: setInput(SET),
    });
    await db.execute(
      `UPDATE outbox SET payload = json_remove(payload, '$.analysisPermitId') WHERE owner_key = ? AND kind = 'shot.sync'`,
      [OWNER],
    );
    const t = acceptAllTransport();
    for (let d = 0; d < 3; d += 1) await drainOutbox(db, t);
    expect(t.sessions).toEqual([SET]);
    expect(offersOf(t, id)).toBe(0);
    expect(await getShotOutboxStatus(db, id)).toMatchObject({
      state: 'exhausted',
      attempts: OUTBOX_MAX_ATTEMPTS,
    });
  });
});
