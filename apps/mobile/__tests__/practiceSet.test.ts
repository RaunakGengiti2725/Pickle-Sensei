import type { ShotAnalysis } from '@pickle/shared-types';
import type { LocalDb } from '../src/data/db';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import { saveAnalysis } from '../src/data/repository';
import { drainOutbox, SESSION_NOT_FOUND_REJECTION } from '../src/data/sync';
import {
  commitPracticeSet,
  commitPracticeSetForAnalysis,
  currentPracticeSetId,
  notePracticeSetAnalysis,
  planPracticeSet,
  PRACTICE_SET_COMMIT_ATTEMPTS,
  PRACTICE_SET_IDLE_TIMEOUT_MS,
  PRACTICE_SET_MODE,
  practiceSetKeyForOwner,
  resumeOrStartPracticeSet,
} from '../src/analysis/practiceSet';
import { createMemoryDb } from '../harness/outbox/memoryDb';

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

/**
 * XCF-07: the scored analysis is durable (saveAnalysis committed, with the
 * plan's sessionId) BEFORE the set is committed. A failed saveSession used to
 * be swallowed by the screen, leaving a shot that names a session which
 * exists nowhere — rejected by the server as shot.session_not_found forever.
 * These run over the harness's independent SQLite model (real transactions,
 * json_extract, unknown SQL throws) with statement-level faults injected.
 */
describe('commitPracticeSetForAnalysis (XCF-07)', () => {
  const shotId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const permitId = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  beforeEach(() => setActiveDataOwner(ownerA));
  afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

  function analysisIn(sessionId: string | null): ShotAnalysis {
    return {
      id: shotId,
      sessionId,
      shotType: 'forehand_drive',
      cameraView: 'side',
      handedness: 'right',
      capturedAtIso: T0,
      timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
      phases: [],
      measurements: [],
      checkpoints: [],
      overallScore: 7.4,
      analysisConfidence: 0.9,
      resultKind: 'scored',
      guidance: null,
      priorityFix: null,
      versionVector: {
        appVersion: '0.1.0',
        modelBundleVersion: 'test-native-1',
        poseModelVersion: 'test-pose-1',
        paddleModelVersion: 'test-paddle-1',
        strokeDetectorVersion: 'test-stroke-1',
        phaseModelVersion: 'test-phase-1',
        scoringModelVersion: 'sm-v1',
        shotConfigVersion: 'forehand_drive@1',
      },
      source: 'real',
    };
  }

  /** Wraps the model so chosen statements fail with a storage error. */
  function faultyDb(shouldFail: (sql: string, occurrence: number) => boolean) {
    const store = createMemoryDb();
    const seen = new Map<string, number>();
    const failures: string[] = [];
    const db: LocalDb = {
      async execute(sql, params) {
        const key = sql.replace(/\s+/g, ' ').trim();
        const occurrence = (seen.get(key) ?? 0) + 1;
        seen.set(key, occurrence);
        if (shouldFail(key, occurrence)) {
          failures.push(key);
          throw new Error('disk I/O error');
        }
        return store.db.execute(sql, params);
      },
      close() {},
    };
    return { db, store, failures };
  }

  const isSessionInsert = (sql: string) =>
    sql.startsWith('INSERT OR REPLACE INTO local_session');

  /** Server stand-in that only knows sessions delivered via createSession. */
  function serverTransport() {
    const known = new Set<string>();
    return {
      syncShots: async (shots: unknown[]) => {
        const acceptedIds: string[] = [];
        const rejected: Array<{ id: string; code: string; message: string }> =
          [];
        for (const shot of shots as Array<{
          id: string;
          sessionId: string | null;
        }>) {
          if (shot.sessionId === null || known.has(shot.sessionId))
            acceptedIds.push(shot.id);
          else
            rejected.push({
              id: shot.id,
              code: SESSION_NOT_FOUND_REJECTION,
              message: 'Session not found or not yours.',
            });
        }
        return { acceptedIds, rejected };
      },
      createSession: async (session: unknown) => {
        known.add((session as { id: string }).id);
      },
      finalizeSession: async () => {},
    };
  }

  it('retries a session write that fails once and commits the set with the shot still attached', async () => {
    const { db, store, failures } = faultyDb(
      (sql, occurrence) => isSessionInsert(sql) && occurrence === 1,
    );
    const plan = (await planPracticeSet(db, {
      shotType: 'forehand_drive',
      nowIso: T0,
    }))!;
    await saveAnalysis(db, analysisIn(plan.sessionId), permitId);

    const outcome = await commitPracticeSetForAnalysis(
      db,
      plan,
      shotId,
      plus(1_000),
    );
    expect(outcome).toEqual({ kind: 'committed', attempts: 2 });
    expect(failures).toHaveLength(1);
    expect(PRACTICE_SET_COMMIT_ATTEMPTS).toBeGreaterThanOrEqual(2);

    const snap = store.snapshot();
    expect(snap.sessions).toEqual([
      expect.objectContaining({ owner_key: ownerA, id: plan.sessionId }),
    ]);
    expect(snap.outbox.map(r => r.kind)).toEqual([
      'shot.sync',
      'session.create',
    ]);
    expect(snap.shots[0]).toMatchObject({ session_id: plan.sessionId });
    expect(JSON.parse(snap.kv[0]!.value)).toMatchObject({
      sessionId: plan.sessionId,
    });
    // A healthy drain converges: session first, then the shot.
    const result = await drainOutbox(db, serverTransport());
    expect(result).toEqual({ synced: 2, failed: 0, remaining: 0 });
  });

  it('detaches the durable shot from a set whose session write keeps failing, so the shot can still sync', async () => {
    const { db, store, failures } = faultyDb(isSessionInsert);
    const plan = (await planPracticeSet(db, {
      shotType: 'forehand_drive',
      nowIso: T0,
    }))!;
    await saveAnalysis(db, analysisIn(plan.sessionId), permitId);

    const outcome = await commitPracticeSetForAnalysis(
      db,
      plan,
      shotId,
      plus(1_000),
    );
    expect(outcome).toEqual({
      kind: 'detached',
      attempts: PRACTICE_SET_COMMIT_ATTEMPTS,
      error: 'disk I/O error',
    });
    expect(failures).toHaveLength(PRACTICE_SET_COMMIT_ATTEMPTS);

    const snap = store.snapshot();
    // Nothing of the set survives: no session row, no session.create, no kv
    // record (the next analysis starts a fresh set instead of joining a
    // ghost).
    expect(snap.sessions).toEqual([]);
    expect(snap.kv).toEqual([]);
    expect(snap.outbox).toHaveLength(1);
    expect(snap.outbox[0]!.kind).toBe('shot.sync');
    // Local row and queued payload were reassigned together.
    expect(snap.shots[0]).toMatchObject({ id: shotId, session_id: null });
    expect(JSON.parse(snap.shots[0]!.payload)).toMatchObject({
      id: shotId,
      sessionId: null,
    });
    expect(JSON.parse(snap.outbox[0]!.payload)).toMatchObject({
      id: shotId,
      sessionId: null,
      analysisPermitId: permitId,
    });
    // The server has never heard of the session and never will — the
    // detached shot is accepted on the first healthy drain.
    const result = await drainOutbox(db, serverTransport());
    expect(result).toEqual({ synced: 1, failed: 0, remaining: 0 });
    expect(store.snapshot().receipts).toEqual([
      { owner_key: ownerA, kind: 'shot.sync', entity_id: shotId },
    ]);
  });

  it('surfaces the failure when neither the session nor the detachment can be written, leaving the shot untouched', async () => {
    const { db, store } = faultyDb(
      sql =>
        isSessionInsert(sql) || sql.startsWith('UPDATE outbox SET payload'),
    );
    const plan = (await planPracticeSet(db, {
      shotType: 'forehand_drive',
      nowIso: T0,
    }))!;
    await saveAnalysis(db, analysisIn(plan.sessionId), permitId);
    const before = JSON.stringify(store.snapshot());

    await expect(
      commitPracticeSetForAnalysis(db, plan, shotId, plus(1_000)),
    ).rejects.toThrow('disk I/O error');
    // The half-applied detachment rolled back: local row and outbox payload
    // still agree with each other.
    expect(JSON.stringify(store.snapshot())).toBe(before);
  });

  it('a resumed set only re-stamps activity; a failing stamp is retried and then reported without touching the shot', async () => {
    const { db, store } = faultyDb(() => false);
    const first = (await planPracticeSet(db, {
      shotType: 'forehand_drive',
      nowIso: T0,
    }))!;
    await commitPracticeSet(db, first, T0);
    const resumed = (await planPracticeSet(db, {
      shotType: 'forehand_drive',
      nowIso: plus(30_000),
    }))!;
    expect(resumed).toMatchObject({
      sessionId: first.sessionId,
      resumed: true,
    });
    await saveAnalysis(db, analysisIn(resumed.sessionId), permitId);

    let kvWrites = 0;
    const stampFails: LocalDb = {
      async execute(sql, params) {
        if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
          kvWrites += 1;
          throw new Error('disk I/O error');
        }
        return db.execute(sql, params);
      },
      close() {},
    };
    const outcome = await commitPracticeSetForAnalysis(
      stampFails,
      resumed,
      shotId,
      plus(31_000),
    );
    expect(outcome).toEqual({
      kind: 'activity_not_recorded',
      attempts: PRACTICE_SET_COMMIT_ATTEMPTS,
      error: 'disk I/O error',
    });
    expect(kvWrites).toBe(PRACTICE_SET_COMMIT_ATTEMPTS);
    // The session exists durably (row + session.create), so the shot keeps
    // its sessionId and syncs behind it.
    const snap = store.snapshot();
    expect(snap.sessions).toHaveLength(1);
    expect(snap.shots[0]).toMatchObject({ session_id: first.sessionId });
    const result = await drainOutbox(db, serverTransport());
    expect(result).toEqual({ synced: 2, failed: 0, remaining: 0 });
  });
});
