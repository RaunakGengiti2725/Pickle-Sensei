/**
 * Adversarial pass 3 (tester #4) — consistency store races and corrupt state.
 *
 * The SQLite repository is replaced by a CONTROLLABLE in-memory kv + shot
 * table: every call can be held (mockDeferred) and released in any order, so the
 * interleavings below are deterministic, not timing-dependent.
 *
 * Scenarios (assigned):
 *   - owner switch while refresh() awaits the DB;
 *   - two overlapping refresh() calls with listActivityShots resolving out
 *     of order;
 *   - consumeDaySecured() then setKv rejects;
 *   - corrupt ledger `{"version":1,"drillCompletions":"oops"}`;
 *   - recordDrillCompletion twice with the same id via Promise.all.
 * Plus: consumeDaySecured after an owner switch, refresh racing the
 * consumeDaySecured persistence, getKv/listActivityShots rejecting, huge
 * ledgers, unicode ids.
 */

type Shot = {
  id: string;
  sessionId: string | null;
  shotType: string;
  capturedAt: string;
  overallScore: number | null;
  resultKind: string;
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function mockDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const mockKv = new Map<string, string>();
const mockShots: Shot[] = [];
/** Pending listActivityShots calls, in call order, when `holdShots` is on. */
const mockShotCalls: Array<Deferred<Shot[]>> = [];
/** Pending getKv calls when `holdGetKv` is on. */
const mockGetKvCalls: Array<{ key: string; gate: Deferred<string | null> }> =
  [];
const mockControl = {
  holdShots: false,
  holdGetKv: false,
  setKvError: null as Error | null,
  getKvError: null as Error | null,
  shotsError: null as Error | null,
  setKvLog: [] as Array<{ key: string; value: string }>,
};

jest.mock('../src/data/db', () => ({
  getDb: () => ({}),
}));

jest.mock('../src/data/repository', () => ({
  getKv: async (_db: unknown, key: string) => {
    if (mockControl.getKvError) throw mockControl.getKvError;
    if (mockControl.holdGetKv) {
      const gate = mockDeferred<string | null>();
      mockGetKvCalls.push({ key, gate });
      return gate.promise;
    }
    return mockKv.get(key) ?? null;
  },
  setKv: async (_db: unknown, key: string, value: string) => {
    if (mockControl.setKvError) throw mockControl.setKvError;
    mockControl.setKvLog.push({ key, value });
    mockKv.set(key, value);
  },
  listActivityShots: async () => {
    if (mockControl.shotsError) throw mockControl.shotsError;
    if (mockControl.holdShots) {
      const gate = mockDeferred<Shot[]>();
      mockShotCalls.push(gate);
      return gate.promise;
    }
    return [...mockShots];
  },
}));

import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../src/data/accountScope';
import {
  consistencyKeyForOwner,
  parseConsistencyLedger,
  useConsistencyStore,
} from '../src/consistency/store';
import {
  STREAK_MILESTONES,
  XP_PER_TRAINED_DAY,
} from '../src/consistency/milestones';

const ownerA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ownerB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function isoDaysAgo(days: number): string {
  if (days === 0) return new Date(Date.now() - 1_000).toISOString();
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

function shot(daysAgo: number, id = `shot-${daysAgo}-${Math.random()}`): Shot {
  return {
    id,
    sessionId: null,
    shotType: 'dink',
    capturedAt: isoDaysAgo(daysAgo),
    overallScore: 6,
    resultKind: 'scored',
  };
}

function ledgerFor(owner: string) {
  return parseConsistencyLedger(
    mockKv.get(consistencyKeyForOwner(owner)) ?? null,
  );
}

/** Flush microtasks without advancing timers. */
async function tick(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}

const unhandled: unknown[] = [];
function onUnhandled(reason: unknown) {
  unhandled.push(reason);
}

interface NodeProcessLike {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
}
const nodeProcess = (globalThis as unknown as { process: NodeProcessLike })
  .process;

beforeAll(() => {
  nodeProcess.on('unhandledRejection', onUnhandled);
});

afterAll(() => {
  nodeProcess.off('unhandledRejection', onUnhandled);
});

beforeEach(() => {
  mockKv.clear();
  mockShots.length = 0;
  mockShotCalls.length = 0;
  mockGetKvCalls.length = 0;
  mockControl.holdShots = false;
  mockControl.holdGetKv = false;
  mockControl.setKvError = null;
  mockControl.getKvError = null;
  mockControl.shotsError = null;
  mockControl.setKvLog = [];
  unhandled.length = 0;
  useConsistencyStore.setState({
    hydrated: false,
    ownerKey: null,
    snapshot: null,
    loadError: false,
    celebration: null,
    daySecured: null,
  });
  setActiveDataOwner(ownerA);
});

afterEach(async () => {
  // Drain anything still queued so a held gate cannot leak into the next
  // test; release every gate with an empty result.
  for (const gate of mockShotCalls.splice(0)) gate.resolve([]);
  for (const call of mockGetKvCalls.splice(0)) call.gate.resolve(null);
  mockControl.holdShots = false;
  mockControl.holdGetKv = false;
  await tick();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  expect(unhandled).toEqual([]);
});

describe('attack4: owner switch mid-refresh', () => {
  it('a refresh started for owner A whose DB read lands after the switch to B writes nothing for A into B', async () => {
    mockShots.push(shot(2), shot(1), shot(0));
    mockControl.holdShots = true;

    const refreshA = useConsistencyStore.getState().refresh();
    await tick();
    expect(mockShotCalls).toHaveLength(1);

    // Account switch while A's read is in flight.
    setActiveDataOwner(ownerB);
    useConsistencyStore.setState({
      ownerKey: ownerB,
      snapshot: null,
      celebration: null,
      daySecured: null,
    });

    // A's shots arrive now — a 3-day streak that would celebrate streak.1 +
    // streak.3 and arm Day Secured.
    mockShotCalls[0]!.resolve([...mockShots]);
    await refreshA;

    const state = useConsistencyStore.getState();
    expect(state.ownerKey).toBe(ownerB);
    expect(state.snapshot).toBeNull();
    expect(state.celebration).toBeNull();
    expect(state.daySecured).toBeNull();
    // Neither owner's ledger was touched: no ceremony was persisted to B's
    // key, and nothing was written under A's key on B's behalf either.
    expect(mockKv.has(consistencyKeyForOwner(ownerB))).toBe(false);
    expect(mockKv.has(consistencyKeyForOwner(ownerA))).toBe(false);
    expect(mockControl.setKvLog).toEqual([]);
  });

  it('switching owners between the ledger read and the celebration write drops the write', async () => {
    mockShots.push(shot(2), shot(1), shot(0));
    mockControl.holdGetKv = true;

    const refreshA = useConsistencyStore.getState().refresh();
    await tick();
    // loadConsistencyActivities read shots (instant) and is now awaiting the
    // ledger read.
    expect(mockGetKvCalls).toHaveLength(1);
    expect(mockGetKvCalls[0]!.key).toBe(consistencyKeyForOwner(ownerA));

    setActiveDataOwner(ownerB);
    mockGetKvCalls[0]!.gate.resolve(null);
    await refreshA;

    expect(mockControl.setKvLog).toEqual([]);
    expect(useConsistencyStore.getState().snapshot).toBeNull();
  });

  it('switching to signed-out mid-refresh leaves the store empty', async () => {
    mockShots.push(shot(0));
    mockControl.holdShots = true;
    const refreshA = useConsistencyStore.getState().refresh();
    await tick();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    mockShotCalls[0]!.resolve([...mockShots]);
    await refreshA;
    expect(useConsistencyStore.getState().snapshot).toBeNull();
    expect(mockControl.setKvLog).toEqual([]);

    // The next refresh under the signed-out owner clears state and never
    // touches the DB.
    await useConsistencyStore.getState().refresh();
    expect(useConsistencyStore.getState()).toMatchObject({
      ownerKey: SIGNED_OUT_DATA_OWNER,
      snapshot: null,
      daySecured: null,
    });
    expect(mockShotCalls).toHaveLength(1);
  });

  it('recordDrillCompletion whose ledger read lands after an owner switch does not write A\u2019s drill into B', async () => {
    mockControl.holdGetKv = true;
    const record = useConsistencyStore.getState().recordDrillCompletion({
      id: 'drill-A-1',
      slug: 'dink-ladder',
      title: 'Dink ladder',
      completedAtIso: isoDaysAgo(0),
    });
    await tick();
    expect(mockGetKvCalls).toHaveLength(1);
    setActiveDataOwner(ownerB);
    mockControl.holdGetKv = false;
    mockGetKvCalls[0]!.gate.resolve(null);
    await record;
    expect(mockKv.has(consistencyKeyForOwner(ownerB))).toBe(false);
    expect(mockKv.has(consistencyKeyForOwner(ownerA))).toBe(false);
    expect(ledgerFor(ownerB).drills).toEqual([]);
  });

  it('consumeDaySecured after an owner switch must not stamp A\u2019s day into B\u2019s ledger', async () => {
    mockShots.push(shot(1), shot(0));
    await useConsistencyStore.getState().hydrate();
    const pending = useConsistencyStore.getState().daySecured;
    expect(pending).not.toBeNull();

    // Owner switches; B's hydrate has not run yet (state still holds A's
    // pending moment). The result surface consumes now.
    setActiveDataOwner(ownerB);
    const consumed = useConsistencyStore.getState().consumeDaySecured();
    await tick();

    // The moment was armed for A. Either it is not handed out at all, or if
    // it is, the durable stamp must land on A's ledger — never B's.
    const ledgerB = ledgerFor(ownerB);
    expect({
      consumedForOwner: consumed ? 'A-moment-handed-out' : null,
      ledgerBDaySecuredShownDay: ledgerB.daySecuredShownDay,
      ledgerBExists: mockKv.has(consistencyKeyForOwner(ownerB)),
    }).toEqual({
      consumedForOwner: consumed ? 'A-moment-handed-out' : null,
      ledgerBDaySecuredShownDay: null,
      ledgerBExists: false,
    });
  });
});

describe('attack4: overlapping refresh()', () => {
  it('two overlapping refreshes serialize: the second DB read starts only after the first completes, and the final snapshot is the latest list', async () => {
    mockControl.holdShots = true;
    const first = useConsistencyStore.getState().refresh();
    const second = useConsistencyStore.getState().refresh();
    await tick();
    // refreshQueue: only ONE listActivityShots call may be outstanding.
    expect(mockShotCalls).toHaveLength(1);

    // Resolve the first read with an OLD list (1 day) — the second read has
    // not even been issued yet, so "out of order" resolution is impossible
    // by construction.
    mockShotCalls[0]!.resolve([shot(0, 'old-1')]);
    await first;
    expect(useConsistencyStore.getState().snapshot?.totalActivities).toBe(1);
    await tick();
    expect(mockShotCalls).toHaveLength(2);
    mockShotCalls[1]!.resolve([
      shot(1, 'new-1'),
      shot(0, 'new-2'),
      shot(0, 'new-3'),
    ]);
    await second;
    const snapshot = useConsistencyStore.getState().snapshot!;
    expect(snapshot.totalActivities).toBe(3);
    expect(snapshot.currentStreak).toBe(2);
  });

  it('50 rapid refresh() calls issue 50 serialized reads and end on the last list', async () => {
    mockControl.holdShots = true;
    const calls = Array.from({ length: 50 }, () =>
      useConsistencyStore.getState().refresh(),
    );
    for (let i = 0; i < 50; i += 1) {
      await tick();
      expect(mockShotCalls).toHaveLength(i + 1);
      // Each read returns a different history; the last one has i+1 shots.
      mockShotCalls[i]!.resolve(
        Array.from({ length: i + 1 }, (_, j) => shot(0, `r${i}-${j}`)),
      );
    }
    await Promise.all(calls);
    expect(useConsistencyStore.getState().snapshot?.totalActivities).toBe(50);
    expect(mockShotCalls).toHaveLength(50);
  });

  it('a refresh whose DB read rejects sets loadError and does not poison the queue', async () => {
    mockControl.shotsError = new Error('SQLITE_BUSY');
    await useConsistencyStore.getState().refresh();
    expect(useConsistencyStore.getState()).toMatchObject({
      ownerKey: ownerA,
      loadError: true,
    });
    mockControl.shotsError = null;
    mockShots.push(shot(0));
    await useConsistencyStore.getState().refresh();
    expect(useConsistencyStore.getState()).toMatchObject({
      loadError: false,
      snapshot: expect.objectContaining({ totalActivities: 1 }),
    });
  });

  it('a getKv rejection during refresh still derives the snapshot from shots', async () => {
    mockControl.getKvError = new Error('disk I/O error');
    mockShots.push(shot(1), shot(0));
    await useConsistencyStore.getState().refresh();
    const state = useConsistencyStore.getState();
    expect(state.loadError).toBe(false);
    expect(state.snapshot?.currentStreak).toBe(2);
  });
});

describe('attack4: consumeDaySecured persistence failure', () => {
  it('setKv rejecting leaves the in-memory flag consumed and surfaces no unhandled rejection', async () => {
    mockShots.push(shot(0));
    await useConsistencyStore.getState().hydrate();
    expect(useConsistencyStore.getState().daySecured).not.toBeNull();

    mockControl.setKvError = new Error('SQLITE_FULL');
    const consumed = useConsistencyStore.getState().consumeDaySecured();
    expect(consumed).toMatchObject({ streak: 1 });
    expect(useConsistencyStore.getState().daySecured).toBeNull();
    // Second consume in the same tick: nothing left.
    expect(useConsistencyStore.getState().consumeDaySecured()).toBeNull();
    await tick();
    expect(unhandled).toEqual([]);
    expect(ledgerFor(ownerA).daySecuredShownDay).toBeNull();
  });

  it('after a failed persist, the next in-session refresh() does not hand the same day\u2019s moment out again', async () => {
    mockShots.push(shot(0));
    await useConsistencyStore.getState().hydrate();
    mockControl.setKvError = new Error('SQLITE_FULL');
    const consumed = useConsistencyStore.getState().consumeDaySecured();
    expect(consumed).not.toBeNull();
    await tick();
    mockControl.setKvError = null;

    // The comment in store.ts says the moment "could repeat after a
    // restart". Pin what actually happens on the next in-session refresh.
    await useConsistencyStore.getState().refresh();
    expect(useConsistencyStore.getState().daySecured).toBeNull();
  });

  it('a refresh() that reads the ledger before consumeDaySecured\u2019s write lands does not re-arm the consumed moment', async () => {
    mockShots.push(shot(0));
    await useConsistencyStore.getState().hydrate();
    const today = useConsistencyStore.getState().snapshot!.asOfDay;

    // Hold the ledger reads: consume issues one, refresh issues another.
    mockControl.holdGetKv = true;
    const consumed = useConsistencyStore.getState().consumeDaySecured();
    expect(consumed?.day).toBe(today);
    const refresh = useConsistencyStore.getState().refresh();
    await tick();
    expect(mockGetKvCalls).toHaveLength(2);

    // Both reads see the OLD ledger (no daySecuredShownDay) — the refresh
    // read simply happened before the consume write, as it would with a
    // real async SQLite bridge.
    mockGetKvCalls[1]!.gate.resolve(mockKv.get(mockGetKvCalls[1]!.key) ?? null);
    mockGetKvCalls[0]!.gate.resolve(mockKv.get(mockGetKvCalls[0]!.key) ?? null);
    mockControl.holdGetKv = false;
    await refresh;
    await tick();

    // The consume write did land …
    expect(ledgerFor(ownerA).daySecuredShownDay).toBe(today);
    // … and the already-consumed moment must not be armed again in memory.
    expect(useConsistencyStore.getState().daySecured).toBeNull();
  });
});

describe('attack4: ledger read-modify-write races', () => {
  it('a drill completion whose ledger read predates a refresh() celebration write keeps the celebrated marks', async () => {
    // 3-day streak: refresh() will persist celebrated streak.1 + streak.3.
    mockShots.push(shot(2), shot(1), shot(0));
    mockControl.holdGetKv = true;

    const drill = useConsistencyStore.getState().recordDrillCompletion({
      id: 'drill-race',
      slug: 'dink-ladder',
      title: 'Dink ladder',
      completedAtIso: isoDaysAgo(0),
    });
    const refresh = useConsistencyStore.getState().refresh();
    await tick();
    // [0] = drill's ledger read, [1] = refresh's ledger read.
    expect(mockGetKvCalls.map(c => c.key)).toEqual([
      consistencyKeyForOwner(ownerA),
      consistencyKeyForOwner(ownerA),
    ]);

    // Refresh's read returns first; its celebration write lands.
    mockControl.holdGetKv = false;
    mockGetKvCalls[1]!.gate.resolve(null);
    await refresh;
    expect(Object.keys(ledgerFor(ownerA).celebrated).sort()).toEqual([
      'streak.1',
      'streak.3',
    ]);
    expect(useConsistencyStore.getState().celebration).toMatchObject({
      achievementId: 'streak.3',
    });

    // Now the drill's (stale, empty) read resolves and it writes back.
    mockGetKvCalls[0]!.gate.resolve(null);
    await drill;

    const ledger = ledgerFor(ownerA);
    expect(ledger.drills.map(d => d.id)).toEqual(['drill-race']);
    // The celebrated marks persisted a moment ago must survive: otherwise
    // the next refresh replays the Kindling ceremony.
    expect(Object.keys(ledger.celebrated).sort()).toEqual([
      'streak.1',
      'streak.3',
    ]);
    useConsistencyStore.getState().dismissCelebration();
    await useConsistencyStore.getState().refresh();
    expect(useConsistencyStore.getState().celebration).toBeNull();
  });

  it('a refresh() celebration write whose ledger read predates a drill write must not erase the drill', async () => {
    mockShots.push(shot(2), shot(1), shot(0));
    mockControl.holdGetKv = true;

    const refresh = useConsistencyStore.getState().refresh();
    const drill = useConsistencyStore.getState().recordDrillCompletion({
      id: 'drill-lost',
      slug: 'dink-ladder',
      title: 'Dink ladder',
      completedAtIso: isoDaysAgo(0),
    });
    await tick();
    // [0] = drill's read (issued synchronously), [1] = refresh's ledger read
    // (issued after its queued shot read). Both are in flight together.
    expect(mockGetKvCalls).toHaveLength(2);

    // Drill's read resolves first and its write lands.
    mockControl.holdGetKv = false;
    mockGetKvCalls[0]!.gate.resolve(null);
    await tick();
    expect(ledgerFor(ownerA).drills.map(d => d.id)).toEqual(['drill-lost']);

    // Refresh's read (issued BEFORE the drill write) now returns the stale
    // pre-drill ledger; its celebration write follows.
    mockGetKvCalls[1]!.gate.resolve(null);
    await Promise.all([refresh, drill]);

    const ledger = ledgerFor(ownerA);
    expect(Object.keys(ledger.celebrated).sort()).toEqual([
      'streak.1',
      'streak.3',
    ]);
    expect(ledger.drills.map(d => d.id)).toEqual(['drill-lost']);
    await useConsistencyStore.getState().refresh();
    const today = useConsistencyStore.getState().snapshot!.asOfDay;
    expect(
      useConsistencyStore.getState().snapshot!.days[today]?.drillCount,
    ).toBe(1);
  });
});

describe('attack4: corrupt ledger', () => {
  it.each([
    '{"version":1,"drillCompletions":"oops"}',
    '{"version":1,"drills":"oops","celebrated":[1,2],"daySecuredShownDay":42}',
    '{"version":"x","drills":[null,1,"s",{"id":7,"completedAtIso":true},{"id":"","completedAtIso":"2026-01-01T00:00:00Z"}]}',
    '[]',
    'null',
    '"string"',
    '{not json',
    '\u0000\u0000\u0000',
    '{"version":1,"drills":[{"id":"\ud83e\udd52","slug":"\u0000","title":"\ufeff","completedAtIso":"not-a-date"}]}',
  ])(
    'ledger %j → snapshot still derives from shots, nothing throws',
    async raw => {
      mockKv.set(consistencyKeyForOwner(ownerA), raw);
      mockShots.push(shot(1), shot(0));
      await expect(
        useConsistencyStore.getState().refresh(),
      ).resolves.toBeUndefined();
      const state = useConsistencyStore.getState();
      expect(state.loadError).toBe(false);
      expect(state.snapshot?.currentStreak).toBe(2);
      expect(state.snapshot?.totalActivities).toBe(2);
      // The rewritten ledger (celebration write) is a well-formed ledger again.
      const after = ledgerFor(ownerA);
      expect(after.version).toBe(1);
      expect(Array.isArray(after.drills)).toBe(true);
      // Garbage rows are either dropped or normalised to string fields; the
      // engine then drops the unparseable dates (asserted via totalActivities).
      for (const drill of after.drills) {
        expect(typeof drill.id).toBe('string');
        expect(typeof drill.completedAtIso).toBe('string');
      }
      expect(typeof after.celebrated).toBe('object');
    },
  );

  it('a 4 MB ledger with 100k drill rows is parsed and capped at MAX_LEDGER_DRILLS on the next write', async () => {
    const drills = Array.from({ length: 100_000 }, (_, i) => ({
      id: `d${i}`,
      slug: 's',
      title: 't',
      completedAtIso: isoDaysAgo(0),
    }));
    mockKv.set(
      consistencyKeyForOwner(ownerA),
      JSON.stringify({
        version: 1,
        drills,
        celebrated: {},
        daySecuredShownDay: null,
      }),
    );
    await useConsistencyStore.getState().recordDrillCompletion({
      id: 'fresh',
      slug: 'fresh',
      title: 'Fresh',
      completedAtIso: isoDaysAgo(0),
    });
    const after = ledgerFor(ownerA);
    expect(after.drills).toHaveLength(2000);
    expect(after.drills[after.drills.length - 1]!.id).toBe('fresh');
    expect(useConsistencyStore.getState().snapshot?.trainedToday).toBe(true);
  });
});

describe('attack4: duplicate drill completion', () => {
  const record = {
    id: 'drill-dup',
    slug: 'third-shot-drop',
    title: 'Third shot drop',
    completedAtIso: isoDaysAgo(0),
  };

  it('recordDrillCompletion twice with the same id via Promise.all counts ONE completion and grants ONE activity of XP', async () => {
    await Promise.all([
      useConsistencyStore.getState().recordDrillCompletion(record),
      useConsistencyStore.getState().recordDrillCompletion({ ...record }),
    ]);
    const ledger = ledgerFor(ownerA);
    const snapshot = useConsistencyStore.getState().snapshot!;
    const today = snapshot.asOfDay;
    // One drill on a fresh streak: base day XP + the streak.1 bonus, and
    // NOT the +5 "extra activity" XP a second counted drill would add.
    const streak1 = STREAK_MILESTONES.find(m => m.days === 1)!;
    expect({
      ledgerDrillIds: ledger.drills.map(d => d.id),
      drillCount: snapshot.days[today]?.drillCount,
      totalActivities: snapshot.totalActivities,
      xpToday: snapshot.days[today]?.xp,
      setKvWrites: mockControl.setKvLog.filter(
        w => JSON.parse(w.value).drills?.length,
      ).length,
    }).toEqual({
      ledgerDrillIds: ['drill-dup'],
      drillCount: 1,
      totalActivities: 1,
      xpToday: XP_PER_TRAINED_DAY + streak1.bonusXp,
      setKvWrites: expect.any(Number),
    });
  });

  it('sequential duplicates are rejected (control case)', async () => {
    await useConsistencyStore.getState().recordDrillCompletion(record);
    await useConsistencyStore.getState().recordDrillCompletion({ ...record });
    expect(ledgerFor(ownerA).drills).toHaveLength(1);
  });

  it('10 concurrent completions with 10 DISTINCT ids all survive', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        useConsistencyStore.getState().recordDrillCompletion({
          ...record,
          id: `distinct-${i}`,
        }),
      ),
    );
    expect(
      ledgerFor(ownerA)
        .drills.map(d => d.id)
        .sort(),
    ).toEqual(Array.from({ length: 10 }, (_, i) => `distinct-${i}`).sort());
  });

  it('a drill whose setKv rejects still completes the call and refreshes', async () => {
    mockControl.setKvError = new Error('SQLITE_READONLY');
    mockShots.push(shot(0));
    await expect(
      useConsistencyStore.getState().recordDrillCompletion(record),
    ).resolves.toBeUndefined();
    expect(useConsistencyStore.getState().snapshot?.totalActivities).toBe(1);
    expect(ledgerFor(ownerA).drills).toEqual([]);
  });
});
