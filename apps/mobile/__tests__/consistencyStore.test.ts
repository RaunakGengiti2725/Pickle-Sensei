/**
 * Consistency store behavior: one durable ceremony per milestone, the
 * once-per-day "Day N secured" moment, and drill-ledger days counting
 * toward the streak. SQLite is replaced by an in-memory kv + shot table.
 */

const mockKv = new Map<string, string>();
const mockShots: Array<{
  id: string;
  sessionId: string | null;
  shotType: string;
  capturedAt: string;
  overallScore: number | null;
  resultKind: string;
}> = [];

const mockRead = jest.fn(async (key: string) => mockKv.get(key) ?? null);
const mockWrite = jest.fn(async (key: string, value: string) => {
  mockKv.set(key, value);
});

jest.mock('../src/data/db', () => ({
  getDb: () => ({}),
}));

jest.mock('../src/data/repository', () => ({
  getKv: async (
    _db: unknown,
    key: string,
    options?: { preserveEmpty?: boolean },
  ) => {
    const value = await mockRead(key);
    return options?.preserveEmpty ? value : value || null;
  },
  setKv: (_db: unknown, key: string, value: string) => mockWrite(key, value),
  listActivityShots: async () => [...mockShots],
}));

import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../src/data/accountScope';
import {
  computeConsistencySnapshot,
  consistencyKeyForOwner,
  loadConsistencyActivities,
  parseConsistencyLedger,
  useConsistencyStore,
} from '../src/consistency/store';

const owner = '22222222-2222-4222-8222-222222222222';

/** Day 0 = one second ago (always inside today, never "future"); earlier
 * days pin to local noon, which is always inside that local calendar day. */
function isoDaysAgo(days: number): string {
  if (days === 0) return new Date(Date.now() - 1_000).toISOString();
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

function addShot(daysAgo: number, score = 6) {
  mockShots.push({
    id: `shot-${mockShots.length}-${daysAgo}`,
    sessionId: null,
    shotType: 'dink',
    capturedAt: isoDaysAgo(daysAgo),
    overallScore: score,
    resultKind: 'scored',
  });
}

beforeEach(() => {
  mockKv.clear();
  mockShots.length = 0;
  mockRead.mockReset();
  mockRead.mockImplementation(async key => mockKv.get(key) ?? null);
  mockWrite.mockClear();
  useConsistencyStore.setState({
    hydrated: false,
    ownerKey: null,
    snapshot: null,
    loadError: false,
    celebration: null,
    queuedCelebrations: [],
    daySecured: null,
  });
  setActiveDataOwner(owner);
});

afterEach(() => {
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('useConsistencyStore', () => {
  it('stays empty for a signed-out process', async () => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    await useConsistencyStore.getState().hydrate();
    expect(useConsistencyStore.getState()).toMatchObject({
      hydrated: true,
      snapshot: null,
      celebration: null,
    });
  });

  it('celebrates the biggest new milestone once, durably', async () => {
    addShot(2);
    addShot(1);
    addShot(0);
    await useConsistencyStore.getState().hydrate();

    const state = useConsistencyStore.getState();
    expect(state.snapshot?.currentStreak).toBe(3);
    // Both streak.1 and streak.3 are newly earned — the ceremony headlines
    // Kindling (3 days) and the ledger marks both as celebrated.
    expect(state.celebration).toMatchObject({
      achievementId: 'streak.3',
      title: 'Kindling',
    });
    const ledger = JSON.parse(mockKv.get(consistencyKeyForOwner(owner))!);
    expect(Object.keys(ledger.celebrated)).toEqual(
      expect.arrayContaining(['streak.1', 'streak.3']),
    );

    // Dismiss, refresh: no repeat ceremony for the same milestones.
    useConsistencyStore.getState().dismissCelebration();
    await useConsistencyStore.getState().refresh();
    expect(useConsistencyStore.getState().celebration).toBeNull();
  });

  it('arms the Day N secured moment once per day', async () => {
    addShot(1);
    addShot(0);
    await useConsistencyStore.getState().hydrate();

    const before = useConsistencyStore.getState().daySecured;
    expect(before).toMatchObject({ streak: 2 });

    const consumed = useConsistencyStore.getState().consumeDaySecured();
    expect(consumed).toMatchObject({ streak: 2 });
    expect(useConsistencyStore.getState().consumeDaySecured()).toBeNull();

    // The consumption is durable: a fresh refresh does not re-arm today.
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
    await useConsistencyStore.getState().refresh();
    expect(useConsistencyStore.getState().daySecured).toBeNull();
  });

  it('does not arm the moment on an untrained day', async () => {
    addShot(1);
    await useConsistencyStore.getState().hydrate();
    expect(useConsistencyStore.getState().daySecured).toBeNull();
    expect(useConsistencyStore.getState().snapshot).toMatchObject({
      currentStreak: 1,
      atRisk: true,
    });
  });

  it('counts recorded drill completions as trained days', async () => {
    await useConsistencyStore.getState().hydrate();
    await useConsistencyStore.getState().recordDrillCompletion({
      id: 'completion-1',
      slug: 'contact-shadow',
      title: 'Contact Shadow Reps',
      completedAtIso: isoDaysAgo(0),
    });
    const snapshot = useConsistencyStore.getState().snapshot;
    expect(snapshot?.trainedToday).toBe(true);
    expect(snapshot?.currentStreak).toBe(1);
    expect(snapshot?.days[snapshot.asOfDay]?.drillCount).toBe(1);

    // Recording the same completion id twice never double-counts.
    await useConsistencyStore.getState().recordDrillCompletion({
      id: 'completion-1',
      slug: 'contact-shadow',
      title: 'Contact Shadow Reps',
      completedAtIso: isoDaysAgo(0),
    });
    expect(
      useConsistencyStore.getState().snapshot?.days[
        useConsistencyStore.getState().snapshot!.asOfDay
      ]?.drillCount,
    ).toBe(1);
  });

  it('does not treat a stored blank ledger as an absent row', async () => {
    addShot(2);
    addShot(1);
    addShot(0);
    const key = consistencyKeyForOwner(owner);
    mockKv.set(key, '');
    await useConsistencyStore.getState().hydrate();
    await useConsistencyStore.getState().recordDrillCompletion({
      id: 'new-drill',
      slug: 'contact-shadow',
      title: 'Contact Shadow Reps',
      completedAtIso: isoDaysAgo(0),
    });
    expect(useConsistencyStore.getState()).toMatchObject({
      snapshot: null,
      loadError: true,
      celebration: null,
      queuedCelebrations: [],
      daySecured: null,
    });
    expect(mockWrite).not.toHaveBeenCalled();
    expect(mockKv.get(key)).toBe('');
    await expect(computeConsistencySnapshot()).rejects.toThrow(
      'Consistency ledger could not be read.',
    );
  });

  it('treats a failed ledger read as unknown, not absence, even when shots would earn a ceremony', async () => {
    addShot(2);
    addShot(1);
    addShot(0);
    mockRead.mockRejectedValue(new Error('SQLITE_IOERR'));
    await expect(
      useConsistencyStore.getState().hydrate(),
    ).resolves.toBeUndefined();
    await useConsistencyStore.getState().refresh();
    expect(useConsistencyStore.getState()).toMatchObject({
      hydrated: true,
      ownerKey: owner,
      snapshot: null,
      loadError: true,
      celebration: null,
      queuedCelebrations: [],
      daySecured: null,
    });
    expect(mockWrite).not.toHaveBeenCalled();
    await expect(loadConsistencyActivities()).rejects.toThrow('SQLITE_IOERR');
    await expect(computeConsistencySnapshot()).rejects.toThrow('SQLITE_IOERR');
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('retains the last valid snapshot, drill history and durable markers across failed reads and a retry', async () => {
    addShot(1);
    addShot(0);
    const store = useConsistencyStore.getState();
    await store.recordDrillCompletion({
      id: 'older-drill',
      slug: 'contact-shadow',
      title: 'Contact Shadow Reps',
      completedAtIso: isoDaysAgo(2),
    });
    expect(useConsistencyStore.getState().snapshot?.currentStreak).toBe(3);
    store.dismissCelebration();
    expect(store.consumeDaySecured()).not.toBeNull();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    const snapshot = useConsistencyStore.getState().snapshot;
    const saved = mockKv.get(consistencyKeyForOwner(owner));
    mockWrite.mockClear();
    mockRead.mockRejectedValue(new Error('SQLITE_BUSY'));
    await Promise.all([store.refresh(), store.refresh(), store.refresh()]);
    expect(useConsistencyStore.getState().snapshot).toBe(snapshot);
    expect(useConsistencyStore.getState()).toMatchObject({
      loadError: true,
      celebration: null,
      queuedCelebrations: [],
      daySecured: null,
    });
    await store.recordDrillCompletion({
      id: 'new-drill',
      slug: 'contact-shadow',
      title: 'Contact Shadow Reps',
      completedAtIso: isoDaysAgo(0),
    });
    expect(mockWrite).not.toHaveBeenCalled();
    expect(mockKv.get(consistencyKeyForOwner(owner))).toBe(saved);
    await expect(computeConsistencySnapshot()).rejects.toThrow('SQLITE_BUSY');

    mockRead.mockImplementation(async key => mockKv.get(key) ?? null);
    await store.refresh();
    expect(useConsistencyStore.getState()).toMatchObject({
      loadError: false,
      celebration: null,
      queuedCelebrations: [],
      daySecured: null,
    });
    expect(useConsistencyStore.getState().snapshot?.currentStreak).toBe(3);
    expect(useConsistencyStore.getState().snapshot?.totalActivities).toBe(3);
    expect(mockKv.get(consistencyKeyForOwner(owner))).toBe(saved);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('preserves already earned requests but enqueues no duplicate from unknown markers', async () => {
    addShot(0);
    await useConsistencyStore.getState().refresh();
    addShot(1);
    addShot(2);
    await useConsistencyStore.getState().refresh();
    const before = useConsistencyStore.getState();
    expect(before.celebration?.achievementId).toBe('streak.1');
    expect(before.queuedCelebrations).toHaveLength(1);
    mockWrite.mockClear();
    mockRead.mockRejectedValue(new Error('ledger unavailable'));
    await useConsistencyStore.getState().refresh();
    await useConsistencyStore.getState().refresh();
    const after = useConsistencyStore.getState();
    expect(after.loadError).toBe(true);
    expect(after.snapshot).toBe(before.snapshot);
    expect(after.celebration).toBe(before.celebration);
    expect(after.queuedCelebrations).toBe(before.queuedCelebrations);
    expect(after.daySecured).toBe(before.daySecured);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('does not label another owner’s previous snapshot as current after a failed read', async () => {
    addShot(0);
    await useConsistencyStore.getState().refresh();
    expect(useConsistencyStore.getState().snapshot).not.toBeNull();
    const nextOwner = '33333333-3333-4333-8333-333333333333';
    setActiveDataOwner(nextOwner);
    mockRead.mockRejectedValue(new Error('ledger unavailable'));
    await useConsistencyStore.getState().refresh();
    expect(useConsistencyStore.getState()).toMatchObject({
      ownerKey: nextOwner,
      snapshot: null,
      daySecured: null,
      loadError: true,
    });
  });

  it('computes notification facts from drill history when the ledger is readable', async () => {
    mockKv.set(
      consistencyKeyForOwner(owner),
      JSON.stringify({
        version: 1,
        drills: [
          {
            id: 'today-drill',
            slug: 'contact-shadow',
            title: 'Contact Shadow Reps',
            completedAtIso: isoDaysAgo(0),
          },
        ],
        celebrated: {},
        daySecuredShownDay: null,
      }),
    );
    const snapshot = await computeConsistencySnapshot();
    expect(snapshot.currentStreak).toBe(1);
    expect(snapshot.trainedToday).toBe(true);
    expect(snapshot.totalActivities).toBe(1);
    expect(mockWrite).not.toHaveBeenCalled();
    expect(useConsistencyStore.getState().celebration).toBeNull();
  });
});

const invalidLedgers = [
  '',
  '{not-json',
  'null',
  '[]',
  '{}',
  JSON.stringify({
    version: 2,
    drills: [],
    celebrated: {},
    daySecuredShownDay: null,
  }),
  JSON.stringify({
    version: 1,
    drills: [],
    celebrated: null,
    daySecuredShownDay: null,
  }),
  JSON.stringify({
    version: 1,
    drills: [],
    celebrated: { 'streak.1': false },
    daySecuredShownDay: null,
  }),
  JSON.stringify({
    version: 1,
    drills: [],
    celebrated: {},
    daySecuredShownDay: 7,
  }),
  JSON.stringify({
    version: 1,
    drills: [],
    celebrated: {},
    daySecuredShownDay: 'not-a-day',
  }),
  JSON.stringify({
    version: 1,
    drills: [{}],
    celebrated: {},
    daySecuredShownDay: null,
  }),
];

describe('consistency ledger absence versus unknown state', () => {
  it('only a missing row produces an empty writable ledger', () => {
    expect(parseConsistencyLedger(null)).toEqual({
      version: 1,
      drills: [],
      celebrated: {},
      daySecuredShownDay: null,
    });
  });

  it.each(invalidLedgers)(
    'rejects an unreadable or unsupported ledger: %s',
    raw => {
      expect(parseConsistencyLedger(raw)).toBeNull();
    },
  );

  it.each(invalidLedgers)(
    'never overwrites unknown data through refresh, drill recording, or day consumption: %s',
    async raw => {
      addShot(0);
      const store = useConsistencyStore.getState();
      await store.refresh();
      store.dismissCelebration();
      const previous = useConsistencyStore.getState();
      expect(previous.daySecured).not.toBeNull();
      mockKv.set(consistencyKeyForOwner(owner), raw);
      mockWrite.mockClear();
      await store.refresh();
      expect(useConsistencyStore.getState().snapshot).toBe(previous.snapshot);
      expect(useConsistencyStore.getState()).toMatchObject({
        loadError: true,
        celebration: null,
        queuedCelebrations: [],
      });
      await store.recordDrillCompletion({
        id: 'new-drill',
        slug: 'contact-shadow',
        title: 'Contact Shadow Reps',
        completedAtIso: isoDaysAgo(0),
      });
      expect(store.consumeDaySecured()).toBe(previous.daySecured);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      await expect(computeConsistencySnapshot()).rejects.toThrow(
        'Consistency ledger could not be read.',
      );
      expect(mockWrite).not.toHaveBeenCalled();
      expect(mockKv.get(consistencyKeyForOwner(owner))).toBe(raw);
      expect(useConsistencyStore.getState().celebration).toBeNull();
      expect(useConsistencyStore.getState().queuedCelebrations).toEqual([]);
    },
  );
});
