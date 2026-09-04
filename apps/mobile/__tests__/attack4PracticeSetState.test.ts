/**
 * ADVERSARIAL PASS 3 / tester #4 — S6 + S7: practice-set state attacks over a
 * fake LocalDb with an injected clock. Corrupt kv, TRY AGAIN handoffs, the
 * idle boundary to the millisecond, clock skew, hostile ids. Every `it`
 * pins what 4d812e1a actually does; titles carry the classification.
 */
import type { LocalDb } from '../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import {
  commitPracticeSet,
  currentPracticeSetId,
  notePracticeSetAnalysis,
  planPracticeSet,
  PRACTICE_SET_IDLE_TIMEOUT_MS,
  practiceSetKeyForOwner,
} from '../src/analysis/practiceSet';

const owner = '44444444-4444-4444-8444-444444444444';
const otherOwner = '55555555-5555-4555-8555-555555555555';
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const T0 = '2026-09-04T12:00:00.000Z';
const MIN = 60_000;
const TRY_AGAIN_SET = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STORED_SET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function plus(ms: number, from = T0): string {
  return new Date(Date.parse(from) + ms).toISOString();
}

interface SessionRow {
  owner: string;
  id: string;
  mode: string;
  shotType: string | null;
}

function fakeDb() {
  const kv = new Map<string, string>();
  const sessions: SessionRow[] = [];
  const outbox: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const writes: string[] = [];
  const db: LocalDb = {
    async execute(statement: string, params: unknown[] = []) {
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
      writes.push(statement);
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
        });
        return { rows: [] };
      }
      if (statement.includes('INSERT INTO outbox')) {
        outbox.push({
          kind: /'([a-z.]+)'/.exec(statement)?.[1] ?? 'unknown',
          payload: JSON.parse(String(params[1])) as Record<string, unknown>,
        });
        return { rows: [] };
      }
      throw new Error(`fakeDb: unhandled sql ${statement}`);
    },
    close() {},
  };
  return { db, kv, sessions, outbox, writes };
}

function storedSet(lastActivityAtIso: string, sessionId = STORED_SET) {
  return JSON.stringify({
    sessionId,
    shotType: 'forehand_drive',
    startedAtIso: plus(-60 * MIN),
    lastActivityAtIso,
  });
}

beforeEach(() => setActiveDataOwner(owner));
afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

// ─── S6: corrupt kv + TRY AGAIN preferredSessionId ──────────────────────────

describe('S6 — corrupt practice.set kv + TRY AGAIN handoff', () => {
  const corruptPayloads: Array<[string, string]> = [
    ['truncated JSON', '{"sessionId":"' + STORED_SET + '","shotTy'],
    ['JSON null', 'null'],
    ['JSON array', '[]'],
    ['JSON string', '"' + STORED_SET + '"'],
    [
      'empty sessionId',
      JSON.stringify({
        sessionId: '',
        shotType: null,
        startedAtIso: T0,
        lastActivityAtIso: T0,
      }),
    ],
    [
      'numeric sessionId',
      JSON.stringify({
        sessionId: 42,
        shotType: null,
        startedAtIso: T0,
        lastActivityAtIso: T0,
      }),
    ],
    [
      'missing lastActivityAtIso',
      JSON.stringify({
        sessionId: STORED_SET,
        shotType: null,
        startedAtIso: T0,
      }),
    ],
    [
      'object shotType',
      JSON.stringify({
        sessionId: STORED_SET,
        shotType: {},
        startedAtIso: T0,
        lastActivityAtIso: T0,
      }),
    ],
    ['unicode garbage', '\uFFFD💥{{{'],
    [
      'prototype pollution attempt',
      '{"__proto__":{"sessionId":"' +
        STORED_SET +
        '"},"sessionId":"' +
        STORED_SET +
        '","startedAtIso":"' +
        T0 +
        '","lastActivityAtIso":"' +
        T0 +
        '"}',
    ],
  ];

  it.each(corruptPayloads)(
    '[HELD] %s: the TRY AGAIN id wins (resumed=true), the plan writes nothing, the corrupt bytes are left untouched',
    async (_label, corrupt) => {
      const { db, kv, writes } = fakeDb();
      const key = practiceSetKeyForOwner(owner);
      kv.set(key, corrupt);
      const plan = await planPracticeSet(db, {
        shotType: 'dink',
        nowIso: T0,
        preferredSessionId: TRY_AGAIN_SET,
      });
      expect(plan).not.toBeNull();
      expect(plan!.sessionId).toBe(TRY_AGAIN_SET);
      expect(plan!.resumed).toBe(true);
      expect(plan!.owner).toBe(owner);
      // The stored record did not name this set, so the handoff's own
      // stroke/time are used — nothing from the corrupt bytes leaks in.
      expect(plan!.shotType).toBe('dink');
      expect(plan!.startedAtIso).toBe(T0);
      expect(writes).toHaveLength(0);
      expect(kv.get(key)).toBe(corrupt);
    },
  );

  it.each(corruptPayloads)(
    '[HELD] %s without a handoff: a NEW set is planned (not "repaired" into the corrupt one), still no writes',
    async (_label, corrupt) => {
      const { db, kv, writes } = fakeDb();
      const key = practiceSetKeyForOwner(owner);
      kv.set(key, corrupt);
      const plan = await planPracticeSet(db, {
        shotType: 'forehand_drive',
        nowIso: T0,
      });
      expect(plan!.resumed).toBe(false);
      expect(plan!.sessionId).toMatch(UUID);
      expect(plan!.sessionId).not.toBe(STORED_SET);
      expect(writes).toHaveLength(0);
      expect(kv.get(key)).toBe(corrupt);
      expect(await currentPracticeSetId(db, T0)).toBeNull();
    },
  );

  it('[HELD] a prototype-pollution kv payload does not leak: the plan for a corrupt-but-parseable record ignores inherited keys', async () => {
    const { db, kv } = fakeDb();
    kv.set(
      practiceSetKeyForOwner(owner),
      '{"__proto__":{"sessionId":"' +
        STORED_SET +
        '","startedAtIso":"' +
        T0 +
        '","lastActivityAtIso":"' +
        T0 +
        '","shotType":null}}',
    );
    const plan = await planPracticeSet(db, { shotType: null, nowIso: T0 });
    expect(plan!.resumed).toBe(false);
    expect(plan!.sessionId).not.toBe(STORED_SET);
    expect(({} as { sessionId?: unknown }).sessionId).toBeUndefined();
  });

  it('[HELD] TRY AGAIN wins over a LIVE stored set of a different id — and commit does NOT write a new session row (the handoff set already exists)', async () => {
    const { db, kv, sessions, outbox } = fakeDb();
    kv.set(practiceSetKeyForOwner(owner), storedSet(plus(-1 * MIN)));
    const plan = await planPracticeSet(db, {
      shotType: 'forehand_drive',
      nowIso: T0,
      preferredSessionId: TRY_AGAIN_SET,
    });
    expect(plan!.sessionId).toBe(TRY_AGAIN_SET);
    expect(plan!.resumed).toBe(true);
    await commitPracticeSet(db, plan!);
    expect(sessions).toHaveLength(0);
    expect(outbox).toHaveLength(0);
    // The kv now names the handoff set — the live-set pointer moved.
    expect(JSON.parse(kv.get(practiceSetKeyForOwner(owner))!)).toMatchObject({
      sessionId: TRY_AGAIN_SET,
      lastActivityAtIso: T0,
    });
  });

  it('[HELD] TRY AGAIN into a set that expired 3 hours ago still wins (a re-record always joins the attempt it came from)', async () => {
    const { db, kv } = fakeDb();
    kv.set(
      practiceSetKeyForOwner(owner),
      storedSet(plus(-180 * MIN), TRY_AGAIN_SET),
    );
    const plan = await planPracticeSet(db, {
      shotType: 'dink',
      nowIso: T0,
      preferredSessionId: TRY_AGAIN_SET,
    });
    expect(plan!.sessionId).toBe(TRY_AGAIN_SET);
    expect(plan!.resumed).toBe(true);
    // Continuing the stored record: ITS stroke and start time are kept.
    expect(plan!.shotType).toBe('forehand_drive');
    expect(plan!.startedAtIso).toBe(plus(-60 * MIN));
  });

  it('[OBSERVED] hostile preferredSessionId values: empty string falls through to the stored set; whitespace / unicode / 10k chars are accepted verbatim as the set id', async () => {
    const { db, kv } = fakeDb();
    kv.set(practiceSetKeyForOwner(owner), storedSet(plus(-1 * MIN)));
    const empty = await planPracticeSet(db, {
      shotType: null,
      nowIso: T0,
      preferredSessionId: '',
    });
    expect(empty!.sessionId).toBe(STORED_SET);
    for (const hostile of [
      '   ',
      '🎾',
      'x'.repeat(10_000),
      "'; DROP TABLE kv;--",
    ]) {
      const plan = await planPracticeSet(db, {
        shotType: null,
        nowIso: T0,
        preferredSessionId: hostile,
      });
      expect(plan!.sessionId).toBe(hostile);
      expect(plan!.resumed).toBe(true);
    }
  });

  it("[HELD] another owner's live set is never visible: owner B plans a fresh set while A's record is live", async () => {
    const { db, kv } = fakeDb();
    kv.set(practiceSetKeyForOwner(owner), storedSet(plus(-1 * MIN)));
    setActiveDataOwner(otherOwner);
    const plan = await planPracticeSet(db, { shotType: null, nowIso: T0 });
    expect(plan!.owner).toBe(otherOwner);
    expect(plan!.resumed).toBe(false);
    expect(plan!.sessionId).not.toBe(STORED_SET);
    expect(kv.has(practiceSetKeyForOwner(otherOwner))).toBe(false);
  });

  it('[HELD] signed out: plan is null, nothing is read into a set, nothing is written', async () => {
    const { db, kv, writes } = fakeDb();
    kv.set(practiceSetKeyForOwner(owner), storedSet(plus(-1 * MIN)));
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    expect(
      await planPracticeSet(db, {
        shotType: null,
        nowIso: T0,
        preferredSessionId: TRY_AGAIN_SET,
      }),
    ).toBeNull();
    await notePracticeSetAnalysis(db, TRY_AGAIN_SET, T0);
    expect(await currentPracticeSetId(db, T0)).toBeNull();
    expect(writes).toHaveLength(0);
  });
});

// ─── S7: idle boundary + nothing commits before a score ─────────────────────

describe('S7 — idle boundary (20 min) and read-only planning', () => {
  it('[HELD] PRACTICE_SET_IDLE_TIMEOUT_MS is exactly 20 minutes', () => {
    expect(PRACTICE_SET_IDLE_TIMEOUT_MS).toBe(20 * MIN);
  });

  it.each([
    ['19 min idle', 19 * MIN, true],
    ['exactly 20 min idle (inclusive boundary)', 20 * MIN, true],
    ['20 min + 1 ms idle', 20 * MIN + 1, false],
    ['21 min idle', 21 * MIN, false],
    ['0 ms idle', 0, true],
    ['-1 ms (activity stamped 1 ms in the future — clock skew)', -1, false],
    ['-5 min (device clock jumped back)', -5 * MIN, false],
  ])(
    '[HELD] %s (idleMs=%i) → resumed=%s; the plan issues NO write and kv is byte-identical afterwards',
    async (_label, idleMs, resumed) => {
      const { db, kv, writes } = fakeDb();
      const key = practiceSetKeyForOwner(owner);
      const raw = storedSet(plus(-idleMs));
      kv.set(key, raw);
      const plan = await planPracticeSet(db, {
        shotType: 'forehand_drive',
        nowIso: T0,
      });
      expect(plan!.resumed).toBe(resumed);
      if (resumed) expect(plan!.sessionId).toBe(STORED_SET);
      else expect(plan!.sessionId).not.toBe(STORED_SET);
      expect(await currentPracticeSetId(db, T0)).toBe(
        resumed ? STORED_SET : null,
      );
      expect(writes).toHaveLength(0);
      expect(kv.get(key)).toBe(raw);
    },
  );

  it('[HELD] 21 min idle: the OLD set is not touched until a score commits; commit then writes exactly one session row, one session.create entry, and one kv stamp', async () => {
    const { db, kv, sessions, outbox, writes } = fakeDb();
    const key = practiceSetKeyForOwner(owner);
    kv.set(key, storedSet(plus(-21 * MIN)));
    const plan = await planPracticeSet(db, {
      shotType: 'forehand_drive',
      nowIso: T0,
    });
    expect(writes).toHaveLength(0);
    // "Analysis abstained" → the caller never commits: still nothing.
    expect(kv.get(key)).toBe(storedSet(plus(-21 * MIN)));
    expect(sessions).toHaveLength(0);

    await commitPracticeSet(db, plan!);
    expect(sessions).toEqual([
      {
        owner,
        id: plan!.sessionId,
        mode: 'practice_set',
        shotType: 'forehand_drive',
      },
    ]);
    expect(outbox).toEqual([
      {
        kind: 'session.create',
        payload: expect.objectContaining({
          id: plan!.sessionId,
          mode: 'practice_set',
        }),
      },
    ]);
    expect(JSON.parse(kv.get(key)!)).toEqual({
      sessionId: plan!.sessionId,
      shotType: 'forehand_drive',
      startedAtIso: T0,
      lastActivityAtIso: T0,
    });
    expect(
      writes.filter(w => w.includes('INSERT OR REPLACE INTO kv')),
    ).toHaveLength(1);
  });

  it('[HELD] 19 min idle: commit of a RESUMED plan writes no session row and only refreshes the activity stamp', async () => {
    const { db, kv, sessions, outbox } = fakeDb();
    const key = practiceSetKeyForOwner(owner);
    kv.set(key, storedSet(plus(-19 * MIN)));
    const plan = await planPracticeSet(db, {
      shotType: 'dink',
      nowIso: T0,
    });
    expect(plan!.resumed).toBe(true);
    // A resumed set keeps ITS stroke, not the new run's.
    expect(plan!.shotType).toBe('forehand_drive');
    await commitPracticeSet(db, plan!);
    expect(sessions).toHaveLength(0);
    expect(outbox).toHaveLength(0);
    expect(JSON.parse(kv.get(key)!)).toEqual({
      sessionId: STORED_SET,
      shotType: 'forehand_drive',
      startedAtIso: plus(-60 * MIN),
      lastActivityAtIso: T0,
    });
  });

  it('[HELD] a plan taken at 19 min but committed 5 min later (long "Measuring") is still committed as resumed — the boundary is evaluated at plan time only', async () => {
    const { db, kv, sessions } = fakeDb();
    const key = practiceSetKeyForOwner(owner);
    kv.set(key, storedSet(plus(-19 * MIN)));
    const plan = await planPracticeSet(db, { shotType: null, nowIso: T0 });
    expect(plan!.resumed).toBe(true);
    await commitPracticeSet(db, plan!, plus(5 * MIN));
    expect(sessions).toHaveLength(0);
    expect(JSON.parse(kv.get(key)!).lastActivityAtIso).toBe(plus(5 * MIN));
  });

  it('[HELD] two plans taken for the SAME expired set before either commits both start NEW sets with different ids (no shared session row)', async () => {
    const { db, kv, sessions } = fakeDb();
    kv.set(practiceSetKeyForOwner(owner), storedSet(plus(-21 * MIN)));
    const [p1, p2] = await Promise.all([
      planPracticeSet(db, { shotType: null, nowIso: T0 }),
      planPracticeSet(db, { shotType: null, nowIso: T0 }),
    ]);
    expect(p1!.resumed).toBe(false);
    expect(p2!.resumed).toBe(false);
    expect(p1!.sessionId).not.toBe(p2!.sessionId);
    await commitPracticeSet(db, p1!);
    await commitPracticeSet(db, p2!);
    expect(sessions.map(s => s.id).sort()).toEqual(
      [p1!.sessionId, p2!.sessionId].sort(),
    );
    // Last commit wins the live pointer.
    expect(await currentPracticeSetId(db, T0)).toBe(p2!.sessionId);
  });

  it('[HELD] unparseable / non-ISO lastActivity stamps end the set instead of throwing', async () => {
    for (const stamp of ['not-a-date', '', '2026-13-45T99:99:99Z', '1e309']) {
      const { db, kv } = fakeDb();
      kv.set(
        practiceSetKeyForOwner(owner),
        JSON.stringify({
          sessionId: STORED_SET,
          shotType: null,
          startedAtIso: T0,
          lastActivityAtIso: stamp,
        }),
      );
      const plan = await planPracticeSet(db, { shotType: null, nowIso: T0 });
      expect(plan!.resumed).toBe(false);
      expect(await currentPracticeSetId(db, T0)).toBeNull();
    }
  });

  it('[HELD] an unparseable nowIso is rejected loudly (the caller cannot plan against a garbage clock)', async () => {
    const { db } = fakeDb();
    await expect(
      planPracticeSet(db, { shotType: null, nowIso: 'yesterday' }),
    ).rejects.toThrow(/parseable ISO/);
  });

  it('[HELD] notePracticeSetAnalysis on a 21-min-idle set re-arms it as the live set (an older-set handoff becomes live again)', async () => {
    const { db, kv } = fakeDb();
    kv.set(practiceSetKeyForOwner(owner), storedSet(plus(-21 * MIN)));
    expect(await currentPracticeSetId(db, T0)).toBeNull();
    await notePracticeSetAnalysis(db, STORED_SET, T0);
    expect(await currentPracticeSetId(db, T0)).toBe(STORED_SET);
    expect(await currentPracticeSetId(db, plus(20 * MIN))).toBe(STORED_SET);
    expect(await currentPracticeSetId(db, plus(20 * MIN + 1))).toBeNull();
  });
});
