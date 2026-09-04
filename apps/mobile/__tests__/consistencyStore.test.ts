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

jest.mock('../src/data/db', () => ({
  getDb: () => ({}),
}));

const mockControl = { failSetKv: false };

jest.mock('../src/data/repository', () => ({
  getKv: async (_db: unknown, key: string) => mockKv.get(key) ?? null,
  setKv: async (_db: unknown, key: string, value: string) => {
    if (mockControl.failSetKv) throw new Error('disk full');
    mockKv.set(key, value);
  },
  listActivityShots: async () => [...mockShots],
}));

import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../src/data/accountScope';
import {
  consistencyKeyForOwner,
  useConsistencyStore,
} from '../src/consistency/store';

const owner = '22222222-2222-4222-8222-222222222222';
const otherOwner = '33333333-3333-4333-8333-333333333333';

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
  mockControl.failSetKv = false;
  useConsistencyStore.setState({
    hydrated: false,
    ownerKey: null,
    snapshot: null,
    celebration: null,
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

  it('keeps every completion when several land at once', async () => {
    await useConsistencyStore.getState().hydrate();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        useConsistencyStore.getState().recordDrillCompletion({
          id: `completion-${i}`,
          slug: 'contact-shadow',
          title: 'Contact Shadow Reps',
          completedAtIso: isoDaysAgo(0),
        }),
      ),
    );
    const ledger = JSON.parse(mockKv.get(consistencyKeyForOwner(owner))!) as {
      drills: Array<{ id: string }>;
    };
    expect(ledger.drills.map(d => d.id).sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => `completion-${i}`).sort(),
    );
    const snapshot = useConsistencyStore.getState().snapshot;
    expect(snapshot?.days[snapshot.asOfDay]?.drillCount).toBe(10);
  });

  it('remembers a consumed moment for the session even when the marker write fails', async () => {
    addShot(0);
    await useConsistencyStore.getState().hydrate();
    mockControl.failSetKv = true;
    expect(useConsistencyStore.getState().consumeDaySecured()).toMatchObject({
      streak: 1,
    });
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
    mockControl.failSetKv = false;

    await useConsistencyStore.getState().refresh();
    expect(useConsistencyStore.getState().daySecured).toBeNull();
  });

  it('discards a moment consumed after the owner changed instead of stamping the new owner', async () => {
    addShot(0);
    await useConsistencyStore.getState().hydrate();
    expect(useConsistencyStore.getState().daySecured).not.toBeNull();

    setActiveDataOwner(otherOwner);
    expect(useConsistencyStore.getState().consumeDaySecured()).toBeNull();
    expect(useConsistencyStore.getState().daySecured).toBeNull();
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
    expect(mockKv.has(consistencyKeyForOwner(otherOwner))).toBe(false);

    // The moment was never shown to its owner: it is still armed for them.
    setActiveDataOwner(owner);
    await useConsistencyStore.getState().hydrate();
    expect(useConsistencyStore.getState().daySecured).toMatchObject({
      streak: 1,
    });
  });
});
