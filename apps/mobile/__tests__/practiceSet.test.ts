import type { LocalDb } from '../src/data/db';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import {
  commitPracticeSet,
  currentPracticeSetId,
  notePracticeSetAnalysis,
  planPracticeSet,
  PRACTICE_SET_IDLE_TIMEOUT_MS,
  PRACTICE_SET_MODE,
  practiceSetKeyForOwner,
  resumeOrStartPracticeSet,
} from '../src/analysis/practiceSet';

/**
 * Practice set lifecycle over a fake LocalDb: one sitting = one sessionId,
 * resumed while analyses keep landing, ended by the idle timeout, and always
 * re-joined by a TRY AGAIN handoff. The kv record is owner-scoped so two
 * accounts on one device can never share a set.
 */

const ownerA = '11111111-1111-4111-8111-111111111111';
const ownerB = '22222222-2222-4222-8222-222222222222';
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface SessionRow {
  owner: string;
  id: string;
  mode: string;
  shotType: string | null;
  focusCheckpoint: string | null;
  startedAt: string;
}

interface OutboxRow {
  owner: string;
  kind: string;
  payload: Record<string, unknown>;
}

function fakeDb() {
  const kv = new Map<string, string>();
  const sessions: SessionRow[] = [];
  const outbox: OutboxRow[] = [];
  const sql: string[] = [];
  const db: LocalDb = {
    async execute(statement: string, params: unknown[] = []) {
      sql.push(statement);
      if (
        statement === 'BEGIN IMMEDIATE' ||
        statement === 'COMMIT' ||
        statement === 'ROLLBACK'
      ) {
        return { rows: [] };
      }
      if (statement.startsWith('SELECT value FROM kv')) {
        const value = kv.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
        kv.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      if (statement.includes('INSERT OR REPLACE INTO local_session')) {
        sessions.push({
          owner: String(params[0]),
          id: String(params[1]),
          mode: String(params[2]),
          shotType: params[3] === null ? null : String(params[3]),
          focusCheckpoint: params[4] === null ? null : String(params[4]),
          startedAt: String(params[5]),
        });
        return { rows: [] };
      }
      if (statement.startsWith('SELECT 1 FROM outbox')) {
        // enqueueSessionCreate: is a session.create for `$.id` still queued?
        const hit = outbox.some(
          row =>
            row.owner === params[0] &&
            row.kind === 'session.create' &&
            row.payload['id'] === params[2],
        );
        return { rows: hit ? [{ '1': 1 }] : [] };
      }
      if (statement.startsWith('SELECT 1 AS paused FROM outbox')) {
        // resumePausedShots: a saved set resumes its paused shots; the fake
        // holds no shot.sync rows, so there is nothing to resume.
        return { rows: [] };
      }
      if (statement.includes('INSERT INTO outbox')) {
        const kind = /'([a-z.]+)'/.exec(statement)?.[1] ?? 'unknown';
        outbox.push({
          owner: String(params[0]),
          kind,
          payload: JSON.parse(String(params[1])) as Record<string, unknown>,
        });
        return { rows: [] };
      }
      throw new Error(`fakeDb: unhandled sql ${statement}`);
    },
    close() {},
  };
  return { db, kv, sessions, outbox, sql };
}

const T0 = '2026-09-02T17:00:00.000Z';
function plus(ms: number, from = T0): string {
  return new Date(Date.parse(from) + ms).toISOString();
}

describe('resumeOrStartPracticeSet', () => {
  beforeEach(() => setActiveDataOwner(ownerA));
  afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

  it('creates a practice_set session row, its session.create outbox entry, and the owner-scoped kv record', async () => {
    const { db, kv, sessions, outbox } = fakeDb();
    const result = await resumeOrStartPracticeSet(db, {
      shotType: 'forehand_drive',
      nowIso: T0,
    });
    expect(result.resumed).toBe(false);
    expect(result.sessionId).toMatch(UUID);

    expect(sessions).toEqual([
      {
        owner: ownerA,
        id: result.sessionId,
        mode: PRACTICE_SET_MODE,
        shotType: 'forehand_drive',
        focusCheckpoint: null,
        startedAt: T0,
      },
    ]);
    expect(PRACTICE_SET_MODE).toBe('practice_set');
    expect(outbox).toEqual([
      {
        owner: ownerA,
        kind: 'session.create',
        payload: {
          id: result.sessionId,
          mode: 'practice_set',
          shotType: 'forehand_drive',
          focusCheckpoint: null,
          startedAt: T0,
        },
      },
    ]);
    expect(JSON.parse(kv.get(practiceSetKeyForOwner(ownerA))!)).toEqual({
      sessionId: result.sessionId,
      shotType: 'forehand_drive',
      startedAtIso: T0,
      lastActivityAtIso: T0,
    });
  });

  it('resumes the live set within the idle timeout and touches lastActivity', async () => {
    const { db, kv, sessions } = fakeDb();
    const first = await resumeOrStartPracticeSet(db, {
      shotType: 'dink',
      nowIso: T0,
    });
    const later = plus(PRACTICE_SET_IDLE_TIMEOUT_MS); // exactly at the edge
    const second = await resumeOrStartPracticeSet(db, {
      shotType: 'dink',
      nowIso: later,
    });
    expect(second).toEqual({ sessionId: first.sessionId, resumed: true });
    expect(sessions).toHaveLength(1); // no second session row
    expect(JSON.parse(kv.get(practiceSetKeyForOwner(ownerA))!)).toMatchObject({
      sessionId: first.sessionId,
      startedAtIso: T0,
      lastActivityAtIso: later,
    });
  });

  it('starts a new set once the idle timeout has elapsed', async () => {
    const { db, sessions, outbox } = fakeDb();
    const first = await resumeOrStartPracticeSet(db, {
      shotType: 'dink',
      nowIso: T0,
    });
    const second = await resumeOrStartPracticeSet(db, {
      shotType: 'dink',
      nowIso: plus(PRACTICE_SET_IDLE_TIMEOUT_MS + 1),
    });
    expect(second.resumed).toBe(false);
    expect(second.sessionId).toMatch(UUID);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(sessions.map(row => row.id)).toEqual([
      first.sessionId,
      second.sessionId,
    ]);
    expect(outbox.map(row => row.kind)).toEqual([
      'session.create',
      'session.create',
    ]);
  });

  it('a TRY AGAIN handoff sessionId wins, even over a live set and after the timeout', async () => {
    const { db, kv, sessions } = fakeDb();
    const handoffSet = '99999999-9999-4999-8999-999999999999';
    // Some other set is live.
    const live = await resumeOrStartPracticeSet(db, {
      shotType: 'serve',
      nowIso: T0,
    });
    expect(live.sessionId).not.toBe(handoffSet);

    const rejoined = await resumeOrStartPracticeSet(db, {
      shotType: 'forehand_drive',
      nowIso: plus(PRACTICE_SET_IDLE_TIMEOUT_MS * 3),
      preferredSessionId: handoffSet,
    });
    expect(rejoined).toEqual({ sessionId: handoffSet, resumed: true });
    // No new session row: the handoff's set already exists (it produced the
    // attempt the player is retrying).
    expect(sessions).toHaveLength(1);
    // The rejoined set becomes the live set.
    expect(JSON.parse(kv.get(practiceSetKeyForOwner(ownerA))!)).toMatchObject({
      sessionId: handoffSet,
      shotType: 'forehand_drive',
    });
    await expect(
      currentPracticeSetId(db, plus(PRACTICE_SET_IDLE_TIMEOUT_MS * 3 + 1)),
    ).resolves.toBe(handoffSet);
  });

  it('an empty or null preferredSessionId falls through to the normal resume logic', async () => {
    const { db } = fakeDb();
    const first = await resumeOrStartPracticeSet(db, {
      shotType: 'dink',
      nowIso: T0,
      preferredSessionId: null,
    });
    expect(first.resumed).toBe(false);
    const second = await resumeOrStartPracticeSet(db, {
      shotType: 'dink',
      nowIso: plus(1_000),
      preferredSessionId: '',
    });
    expect(second).toEqual({ sessionId: first.sessionId, resumed: true });
  });

  it('keys the live set per owner — two accounts on one device never share a sitting', async () => {
    const { db, kv } = fakeDb();
    const a = await resumeOrStartPracticeSet(db, {
      shotType: 'dink',
      nowIso: T0,
    });
    setActiveDataOwner(ownerB);
    const b = await resumeOrStartPracticeSet(db, {
      shotType: 'dink',
      nowIso: plus(1_000),
    });
    expect(b.resumed).toBe(false);
    expect(b.sessionId).not.toBe(a.sessionId);
    expect(practiceSetKeyForOwner(ownerA)).toBe(`practice.set:${ownerA}`);
    expect(JSON.parse(kv.get(`practice.set:${ownerA}`)!).sessionId).toBe(
      a.sessionId,
    );
    expect(JSON.parse(kv.get(`practice.set:${ownerB}`)!).sessionId).toBe(
      b.sessionId,
    );
    // Back on A, A's set is still live.
    setActiveDataOwner(ownerA);
    await expect(currentPracticeSetId(db, plus(2_000))).resolves.toBe(
      a.sessionId,
    );
  });

  it('the guest bucket is writable: local-only use gets a set too', async () => {
    setActiveDataOwner(GUEST_DATA_OWNER);
    const { db, sessions } = fakeDb();
    const result = await resumeOrStartPracticeSet(db, {
      shotType: null,
      nowIso: T0,
    });
    expect(result.sessionId).toMatch(UUID);
    expect(sessions[0]).toMatchObject({
      owner: GUEST_DATA_OWNER,
      shotType: null,
    });
  });

  it('returns sessionId null while signed out and touches nothing', async () => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    const { db, sql } = fakeDb();
    await expect(
      resumeOrStartPracticeSet(db, { shotType: 'dink', nowIso: T0 }),
    ).resolves.toEqual({ sessionId: null, resumed: false });
    await expect(currentPracticeSetId(db, T0)).resolves.toBeNull();
    await notePracticeSetAnalysis(db, 'anything', T0);
    expect(sql).toEqual([]);
  });

  it('treats a corrupt kv record as no live set', async () => {
    const { db, kv } = fakeDb();
    kv.set(practiceSetKeyForOwner(ownerA), '{not json');
    await expect(currentPracticeSetId(db, T0)).resolves.toBeNull();
    const result = await resumeOrStartPracticeSet(db, {
      shotType: 'dink',
      nowIso: T0,
    });
    expect(result.resumed).toBe(false);
    kv.set(
      practiceSetKeyForOwner(ownerA),
      JSON.stringify({ sessionId: 42, startedAtIso: T0 }),
    );
    await expect(currentPracticeSetId(db, T0)).resolves.toBeNull();
  });

  it('rejects an unparseable clock instead of guessing', async () => {
    const { db } = fakeDb();
    await expect(
      resumeOrStartPracticeSet(db, { shotType: 'dink', nowIso: 'yesterday' }),
    ).rejects.toThrow('parseable ISO timestamp');
  });
});

describe('notePracticeSetAnalysis / currentPracticeSetId', () => {
  beforeEach(() => setActiveDataOwner(ownerA));
  afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

  it('touching the live set extends it past the original timeout', async () => {
    const { db } = fakeDb();
    const { sessionId } = await resumeOrStartPracticeSet(db, {
      shotType: 'dink',
      nowIso: T0,
    });
    const midway = plus(PRACTICE_SET_IDLE_TIMEOUT_MS - 60_000);
    await notePracticeSetAnalysis(db, sessionId!, midway);
    // Beyond the ORIGINAL timeout but within the touched one.
    await expect(
      currentPracticeSetId(db, plus(PRACTICE_SET_IDLE_TIMEOUT_MS + 60_000)),
    ).resolves.toBe(sessionId);
    // And past the touched one it is gone.
    await expect(
      currentPracticeSetId(db, plus(PRACTICE_SET_IDLE_TIMEOUT_MS + 1, midway)),
    ).resolves.toBeNull();
  });

  it('noting an analysis in a set the kv no longer names makes that set live again', async () => {
    const { db, kv } = fakeDb();
    const older = '77777777-7777-4777-8777-777777777777';
    await resumeOrStartPracticeSet(db, { shotType: 'dink', nowIso: T0 });
    await notePracticeSetAnalysis(db, older, plus(5_000));
    expect(JSON.parse(kv.get(practiceSetKeyForOwner(ownerA))!)).toEqual({
      sessionId: older,
      shotType: null,
      startedAtIso: plus(5_000),
      lastActivityAtIso: plus(5_000),
    });
    await expect(currentPracticeSetId(db, plus(6_000))).resolves.toBe(older);
  });

  it('is a non-creating read: no kv write, no session row', async () => {
    const { db, sql, sessions } = fakeDb();
    await expect(currentPracticeSetId(db, T0)).resolves.toBeNull();
    expect(sql.every(statement => statement.startsWith('SELECT'))).toBe(true);
    expect(sessions).toHaveLength(0);
  });

  it('a future-dated activity stamp (clock rolled back) ends the set rather than pinning it forever', async () => {
    const { db } = fakeDb();
    const { sessionId } = await resumeOrStartPracticeSet(db, {
      shotType: 'dink',
      nowIso: T0,
    });
    expect(sessionId).not.toBeNull();
    await expect(currentPracticeSetId(db, plus(-60_000))).resolves.toBeNull();
  });
});

describe('planPracticeSet / commitPracticeSet (deferred commit)', () => {
  beforeEach(() => setActiveDataOwner(ownerA));
  afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

  it('planning writes nothing — an abstained or failed run leaves no set behind', async () => {
    const { db, sql, sessions, outbox, kv } = fakeDb();
    const plan = await planPracticeSet(db, {
      shotType: 'forehand_drive',
      nowIso: T0,
    });
    expect(plan).not.toBeNull();
    expect(plan!.resumed).toBe(false);
    expect(plan!.sessionId).toMatch(UUID);
    expect(sql.every(statement => statement.startsWith('SELECT'))).toBe(true);
    expect(sessions).toHaveLength(0);
    expect(outbox).toHaveLength(0);
    expect(kv.size).toBe(0);
  });

  it('committing a new plan writes the session row, its sync entry and the kv record once', async () => {
    const { db, sessions, outbox, kv } = fakeDb();
    const plan = (await planPracticeSet(db, {
      shotType: 'dink',
      nowIso: T0,
    }))!;
    await commitPracticeSet(db, plan, plus(4_000));
    expect(sessions).toEqual([
      {
        owner: ownerA,
        id: plan.sessionId,
        mode: PRACTICE_SET_MODE,
        shotType: 'dink',
        focusCheckpoint: null,
        startedAt: T0,
      },
    ]);
    expect(outbox).toEqual([
      {
        owner: ownerA,
        kind: 'session.create',
        payload: expect.objectContaining({ id: plan.sessionId }),
      },
    ]);
    expect(JSON.parse(kv.get(practiceSetKeyForOwner(ownerA))!)).toEqual({
      sessionId: plan.sessionId,
      shotType: 'dink',
      startedAtIso: T0,
      lastActivityAtIso: plus(4_000),
    });
    // A second analysis in the same sitting resumes the committed set and
    // creates no second session row.
    const next = (await planPracticeSet(db, {
      shotType: 'dink',
      nowIso: plus(60_000),
    }))!;
    expect(next).toMatchObject({ sessionId: plan.sessionId, resumed: true });
    await commitPracticeSet(db, next);
    expect(sessions).toHaveLength(1);
    expect(outbox).toHaveLength(1);
  });

  it('a TRY AGAIN handoff plan resumes that exact set without a session row', async () => {
    const { db, sessions } = fakeDb();
    const handedOff = '99999999-9999-4999-8999-999999999999';
    const plan = (await planPracticeSet(db, {
      shotType: 'serve',
      nowIso: T0,
      preferredSessionId: handedOff,
    }))!;
    expect(plan).toMatchObject({ sessionId: handedOff, resumed: true });
    await commitPracticeSet(db, plan);
    expect(sessions).toHaveLength(0);
    await expect(currentPracticeSetId(db, plus(1_000))).resolves.toBe(
      handedOff,
    );
  });

  it('returns null while signed out', async () => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    const { db, sql } = fakeDb();
    await expect(
      planPracticeSet(db, { shotType: 'dink', nowIso: T0 }),
    ).resolves.toBeNull();
    expect(sql).toHaveLength(0);
  });
});
