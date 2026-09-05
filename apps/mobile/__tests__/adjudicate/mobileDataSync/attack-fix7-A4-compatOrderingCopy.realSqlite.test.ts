/**
 * Adversary round 7 — candidate `devin/fix6-mds-sqlite-a` @ 9a00ceb1.
 * Upgrade/compat rows, ordering & receipts, migrations, and the data-layer
 * truth behind every ResultScreen outbox-state string (claim 6).
 * Real `node:sqlite`, real modules; planted rows stand for pre-fix state.
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
  finishSession,
  getShotOutboxStatus,
  hasShotSyncReceipt,
  saveAnalysis,
  type SessionInput,
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
  realAnalysis,
  shotId,
} from '../../../adjudicate/mobile-data-sync/fixtures';

const OWNER = canonicalDataOwner(CANONICAL_USER);
const SET_X = 'a5a5a5a5-0000-4000-8000-000000000001';
const SET_Y = 'a5a5a5a5-0000-4000-8000-000000000002';

function setInput(id: string): SessionInput {
  return {
    id,
    mode: 'practice_set',
    shotType: 'forehand_drive',
    focusCheckpoint: null,
    startedAt: '2026-08-26T18:00:00.000Z',
  };
}
type Sync = Awaited<ReturnType<SyncTransport['syncShots']>>;
const idsOf = (shots: unknown[]) =>
  shots.map(s => String((s as { id: string }).id));
const acceptAll = (shots: unknown[]): Sync => ({
  acceptedIds: idsOf(shots),
  rejected: [],
});
const rejectAll =
  (code: string, message = 'Session not found or not yours.') =>
  (shots: unknown[]): Sync => ({
    acceptedIds: [],
    rejected: idsOf(shots).map(id => ({ id, code, message })),
  });

function recording(script: {
  createSession?: (session: unknown) => Promise<void>;
  finalizeSession?: (id: string) => Promise<void>;
  syncShots?: (shots: unknown[]) => Promise<Sync>;
}) {
  const calls: string[] = [];
  const transport: SyncTransport = {
    async createSession(session) {
      calls.push(`create:${String((session as { id: string }).id)}`);
      await (script.createSession ?? (async () => {}))(session);
    },
    async finalizeSession(id) {
      calls.push(`finalize:${id}`);
      await (script.finalizeSession ?? (async () => {}))(id);
    },
    async syncShots(shots) {
      calls.push(`shots:${idsOf(shots).join(',')}`);
      return (script.syncShots ?? (async s => acceptAll(s)))(shots);
    },
  };
  return { transport, calls };
}
const conflict409 = async () => {
  throw new ApiError(
    409,
    'session.id_conflict',
    'Session id belongs to another user.',
  );
};

async function wipe(db: LocalDb): Promise<void> {
  for (const table of ['local_shot', 'local_session', 'outbox', 'sync_receipt'])
    await db.execute(`DELETE FROM ${table}`);
}
async function saveShot(db: LocalDb, n: number, set: string) {
  await saveAnalysis(
    db,
    realAnalysis({ id: shotId(n), sessionId: set }),
    PERMIT_ID,
    { session: setInput(set) },
  );
}
async function exhaustSet(db: LocalDb) {
  const refuse = recording({
    createSession: conflict409,
    syncShots: async s => rejectAll(SESSION_NOT_FOUND_REJECTION)(s),
  });
  for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i += 1)
    await drainOutbox(db, refuse.transport);
  return refuse.calls.length;
}

describe('attack-fix7-A4 compat / ordering / receipts / copy (claim 6)', () => {
  let db: LocalDb;
  beforeAll(() => {
    setActiveDataOwner(OWNER);
    db = getDb();
  });
  beforeEach(async () => {
    await wipe(db);
  });

  it('A4.1 probe — LOCAL_MIGRATIONS + account-scoped schema are idempotent on a db already at the new version', async () => {
    await saveShot(db, 1, SET_X);
    const schemaBefore = (
      await db.execute(
        `SELECT type, name, sql FROM sqlite_master ORDER BY name`,
      )
    ).rows;
    db.close();
    const reopened = getDb();
    const schemaAfter = (
      await reopened.execute(
        `SELECT type, name, sql FROM sqlite_master ORDER BY name`,
      )
    ).rows;
    expect(schemaAfter).toEqual(schemaBefore);
    expect((await getShotOutboxStatus(reopened, shotId(1))).state).toBe(
      'queued',
    );
    db = reopened;
  });

  it('A4.2 probe — pre-fix rows: NULL owner_key is impossible; d29b95f5 parked marker is honoured; corrupt shot payload is isolated after 8 drains; exhausted shot with an old last_error stays exhausted', async () => {
    await expect(
      db.execute(
        `INSERT INTO outbox (owner_key, kind, payload) VALUES (NULL, 'shot.sync', '{}')`,
      ),
    ).rejects.toThrow(/NOT NULL/);

    // d29b95f5 parked marker (same verdict prefix), set X dead.
    await saveShot(db, 1, SET_X);
    await saveShot(db, 2, SET_X);
    await db.execute(
      `UPDATE outbox SET attempts = ?, last_error = 'Error: Session id belongs to another user.'
       WHERE owner_key = ? AND kind = 'session.create'`,
      [OUTBOX_MAX_ATTEMPTS, OWNER],
    );
    await db.execute(
      `UPDATE outbox SET last_error = ? WHERE owner_key = ? AND kind = 'shot.sync'
         AND json_extract(payload, '$.id') = ?`,
      [
        `${SESSION_ORPHANED_VERDICT}: Session not found or not yours. Its practice set was refused (Error: Session id belongs to another user.); this read is paused until the set is accepted.`,
        OWNER,
        shotId(1),
      ],
    );
    // Old-build exhausted shot (attempts 8, session_not_found last_error).
    await db.execute(
      `UPDATE outbox SET attempts = ?, last_error = 'shot.session_not_found: Session not found or not yours.'
       WHERE owner_key = ? AND kind = 'shot.sync' AND json_extract(payload, '$.id') = ?`,
      [OUTBOX_MAX_ATTEMPTS, OWNER, shotId(2)],
    );
    // Corrupt payload row.
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', '{"id":')`,
      [OWNER],
    );
    expect((await getShotOutboxStatus(db, shotId(1))).state).toBe('orphaned');
    expect((await getShotOutboxStatus(db, shotId(2))).state).toBe('exhausted');

    const t = recording({});
    const failedPerDrain: number[] = [];
    const quarantinedPerDrain: number[] = [];
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS + 2; i += 1) {
      const r = await drainOutbox(db, t.transport);
      failedPerDrain.push(r.failed);
      quarantinedPerDrain.push(r.quarantined ?? 0);
    }
    // The dead set is never re-asked (it was exhausted by an earlier build:
    // no refusal recorded, so no automatic revival — a new read of the set
    // re-arms it), the parked and exhausted shots never offered, the corrupt
    // row quarantined ONCE (S1: charged straight to exhausted with a truthful
    // last_error in the first drain, never re-read) then silent. Re-pinned
    // (fix9, Q1.4): the quarantine is reported apart from `failed` — the
    // server never saw the row, so no drain of this owner counts as failed.
    expect(t.calls).toEqual([]);
    expect(failedPerDrain).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(quarantinedPerDrain).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect((await getShotOutboxStatus(db, shotId(1))).state).toBe('orphaned');
    expect((await getShotOutboxStatus(db, shotId(2))).state).toBe('exhausted');

    // A new shot of set X re-arms the set; the server accepts: the d29b95f5
    // parked shot is unparked and delivered, the old exhausted shot is not
    // (its copy says it will not be sent again — and it is not).
    await saveShot(db, 3, SET_X);
    const ok = recording({});
    const r = await drainOutbox(db, ok.transport);
    expect(ok.calls).toEqual([
      `create:${SET_X}`,
      `shots:${shotId(1)},${shotId(3)}`,
    ]);
    expect(r).toEqual({ synced: 3, failed: 0, remaining: 2 });
    expect(await hasShotSyncReceipt(db, shotId(1))).toBe(true);
    expect(await hasShotSyncReceipt(db, shotId(2))).toBe(false);
    expect((await getShotOutboxStatus(db, shotId(2))).state).toBe('exhausted');
  });

  it('A4.3 BREAK — copy: an orphaned read says "Sync is paused until the set is accepted, then this read is sent again automatically", but nothing ever asks the server for the set again', async () => {
    await saveShot(db, 1, SET_X);
    const refusals = await exhaustSet(db);
    expect(refusals).toBe(OUTBOX_MAX_ATTEMPTS + 1);
    const status = await getShotOutboxStatus(db, shotId(1));
    expect(status.state).toBe('orphaned');
    // The server-side condition changes (the set id is free again / the
    // account regains it). The practice set is past its 20-minute idle window
    // so no new shot can join it: the only re-arm trigger is gone.
    const accepting = recording({});
    for (let i = 0; i < 20; i += 1) await drainOutbox(db, accepting.transport);
    // Expected (claim 6, ResultScreen orphaned copy): the set is asked for
    // again and the read is sent automatically once accepted.
    // OBSERVED: zero network calls in 20 drains; the read is orphaned for
    // good while its copy promises an automatic resend — the truthful state
    // for this row is the terminal `exhausted` wording or a copy that names
    // the real trigger (a new read in the same set).
    expect({
      calls: accepting.calls,
      state: (await getShotOutboxStatus(db, shotId(1))).state,
      receipt: await hasShotSyncReceipt(db, shotId(1)),
    }).toEqual({
      calls: [`create:${SET_X}`, `shots:${shotId(1)}`],
      state: 'absent',
      receipt: true,
    });
  });

  it('A4.4 probe — ordering within one drain: every session row (create + finalize, incl. the re-armed one) before any shot; unparked shots ride the same drain', async () => {
    await saveShot(db, 1, SET_X);
    await finishSession(db, SET_X, { shots: 1 });
    await saveShot(db, 2, SET_Y);
    await db.execute(
      `UPDATE outbox SET attempts = ?, last_error = 'Error: refused'
       WHERE owner_key = ? AND kind = 'session.create' AND json_extract(payload, '$.id') = ?`,
      [OUTBOX_MAX_ATTEMPTS, OWNER, SET_Y],
    );
    await db.execute(
      `UPDATE outbox SET last_error = ? WHERE owner_key = ? AND kind = 'shot.sync'
         AND json_extract(payload, '$.id') = ?`,
      [`${SESSION_ORPHANED_VERDICT}: parked`, OWNER, shotId(2)],
    );
    await saveShot(db, 3, SET_Y); // re-arms Y
    const t = recording({});
    const r = await drainOutbox(db, t.transport);
    expect(t.calls).toEqual([
      `create:${SET_X}`,
      `finalize:${SET_X}`,
      `create:${SET_Y}`,
      `shots:${shotId(1)},${shotId(2)},${shotId(3)}`,
    ]);
    expect(r).toEqual({ synced: 6, failed: 0, remaining: 0 });
  });

  it('A4.5 probe — a shot whose outbox row vanished while its batch was on the wire gets no receipt; the surviving rows do', async () => {
    await saveShot(db, 1, SET_X);
    await saveShot(db, 2, SET_X);
    const t = recording({
      syncShots: async shots => {
        await db.execute(
          `DELETE FROM outbox WHERE owner_key = ? AND kind = 'shot.sync' AND json_extract(payload, '$.id') = ?`,
          [OWNER, shotId(1)],
        );
        return acceptAll(shots);
      },
    });
    const r = await drainOutbox(db, t.transport);
    expect(r).toEqual({ synced: 3, failed: 0, remaining: 0 });
    expect(await hasShotSyncReceipt(db, shotId(1))).toBe(false);
    expect(await hasShotSyncReceipt(db, shotId(2))).toBe(true);
  });

  it('A4.6 probe — every reachable outbox state maps to one ResultScreen string; the `rejected` state is only reachable with attempts in 1..7', async () => {
    await saveShot(db, 1, SET_X);
    const states: string[] = [];
    states.push((await getShotOutboxStatus(db, shotId(1))).state); // queued → "still in the secure outbox"
    await db.execute(
      `DELETE FROM outbox WHERE owner_key = ? AND kind = 'session.create'`,
      [OWNER],
    );
    const perm = recording({
      syncShots: async s => rejectAll('shot.permit_invalid', 'bad')(s),
    });
    for (let i = 1; i <= OUTBOX_MAX_ATTEMPTS; i += 1) {
      await drainOutbox(db, perm.transport);
      const s = await getShotOutboxStatus(db, shotId(1));
      states.push(`${s.state}:${s.state === 'absent' ? '' : s.attempts}`);
    }
    expect(states).toEqual([
      'queued',
      'rejected:1',
      'rejected:2',
      'rejected:3',
      'rejected:4',
      'rejected:5',
      'rejected:6',
      'rejected:7',
      'exhausted:8',
    ]);
    // Once exhausted the row is never offered again (copy: "will not be sent again").
    const before = perm.calls.length;
    await drainOutbox(db, perm.transport);
    expect(perm.calls.length).toBe(before);
  });
});
