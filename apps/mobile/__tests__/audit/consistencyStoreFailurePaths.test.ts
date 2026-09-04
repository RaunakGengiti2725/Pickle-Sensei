/**
 * Execution-audit harness (mobile-home-progress-library, pass 2).
 *
 * Drives the consistency store through the persistence-failure and
 * owner-switch branches that the shipped suites leave uncovered
 * (store.ts: unreadable ledger fallback, celebration setKv failure,
 * drill-record setKv failure, day-secured consumption setKv failure,
 * owner switch mid-refresh). Every branch is expected to fail closed and
 * quietly: no throw, no console noise, no derived state for a foreign owner.
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
const mockFlags: {
  failSetKv: boolean;
  failGetKv: boolean;
  listShotsGate: Promise<void> | null;
} = { failSetKv: false, failGetKv: false, listShotsGate: null };

jest.mock('../../src/data/db', () => ({
  getDb: () => ({}),
}));

jest.mock('../../src/data/repository', () => ({
  getKv: async (_db: unknown, key: string) => {
    if (mockFlags.failGetKv) throw new Error('kv read failed');
    return mockKv.get(key) ?? null;
  },
  setKv: async (_db: unknown, key: string, value: string) => {
    if (mockFlags.failSetKv) throw new Error('kv write failed');
    mockKv.set(key, value);
  },
  listActivityShots: async () => {
    if (mockFlags.listShotsGate) await mockFlags.listShotsGate;
    return [...mockShots];
  },
}));

import {
  getActiveDataOwner,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';
import {
  consistencyKeyForOwner,
  loadConsistencyActivities,
  parseConsistencyLedger,
  useConsistencyStore,
} from '../../src/consistency/store';

const owner = '22222222-2222-4222-8222-222222222222';
const otherOwner = '33333333-3333-4333-8333-333333333333';

/** Let the queued `run` start and reach its awaited history read. */
async function settleMicrotasks(rounds = 4) {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

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

const consoleError = jest.spyOn(console, 'error');
const consoleWarn = jest.spyOn(console, 'warn');

beforeEach(() => {
  mockKv.clear();
  mockShots.length = 0;
  mockFlags.failSetKv = false;
  mockFlags.failGetKv = false;
  mockFlags.listShotsGate = null;
  consoleError.mockClear();
  consoleWarn.mockClear();
  useConsistencyStore.setState({
    hydrated: false,
    ownerKey: null,
    snapshot: null,
    loadError: false,
    celebration: null,
    daySecured: null,
  });
  setActiveDataOwner(owner);
});

afterEach(() => {
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

afterAll(() => {
  consoleError.mockRestore();
  consoleWarn.mockRestore();
});

describe('audit: consistency store failure paths', () => {
  it('parseConsistencyLedger tolerates every malformed shape without throwing', () => {
    for (const raw of [
      'not json',
      '[]',
      '"str"',
      '42',
      'null',
      '{"drills":"x","celebrated":[1],"daySecuredShownDay":5}',
      '{"drills":[null,1,{"id":"a"},{"completedAtIso":"x"}]}',
    ]) {
      const ledger = parseConsistencyLedger(raw);
      expect(ledger.drills).toEqual([]);
      expect(ledger.celebrated).toEqual({});
      expect(ledger.daySecuredShownDay ?? null).toBeNull();
    }
  });

  it('an unreadable ledger falls back to shot-derived activities (no loadError)', async () => {
    addShot(0);
    addShot(1);
    mockFlags.failGetKv = true;
    const loaded = await loadConsistencyActivities();
    expect(loaded.activities).toHaveLength(2);
    expect(loaded.ledger.drills).toEqual([]);
    await useConsistencyStore.getState().refresh();
    const state = useConsistencyStore.getState();
    expect(state.loadError).toBe(false);
    expect(state.snapshot?.currentStreak).toBe(2);
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it('a celebration whose ledger write fails is skipped, the snapshot still lands, and it retries next refresh', async () => {
    addShot(0);
    mockFlags.failSetKv = true;
    await useConsistencyStore.getState().refresh();
    let state = useConsistencyStore.getState();
    expect(state.snapshot?.currentStreak).toBe(1);
    expect(state.celebration).toBeNull();
    expect(state.loadError).toBe(false);
    expect(mockKv.has(consistencyKeyForOwner(owner))).toBe(false);

    mockFlags.failSetKv = false;
    await useConsistencyStore.getState().refresh();
    state = useConsistencyStore.getState();
    expect(state.celebration?.achievementId).toBe('streak.1');
    const ledger = parseConsistencyLedger(
      mockKv.get(consistencyKeyForOwner(owner)) ?? null,
    );
    expect(Object.keys(ledger.celebrated)).toContain('streak.1');
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('a drill completion whose ledger write fails does not throw and still refreshes', async () => {
    mockFlags.failSetKv = true;
    await expect(
      useConsistencyStore.getState().recordDrillCompletion({
        id: 'drill-1',
        slug: 'reset-drill',
        title: 'Reset drill',
        completedAtIso: isoDaysAgo(0),
      }),
    ).resolves.toBeUndefined();
    const state = useConsistencyStore.getState();
    expect(state.snapshot).not.toBeNull();
    // The un-persisted drill cannot count: today is not a trained day.
    expect(state.snapshot?.trainedToday).toBe(false);
    expect(mockKv.has(consistencyKeyForOwner(owner))).toBe(false);
  });

  it('a duplicate drill id is not recorded twice', async () => {
    const record = {
      id: 'drill-dup',
      slug: 'reset-drill',
      title: 'Reset drill',
      completedAtIso: isoDaysAgo(0),
    };
    await useConsistencyStore.getState().recordDrillCompletion(record);
    await useConsistencyStore.getState().recordDrillCompletion(record);
    const ledger = parseConsistencyLedger(
      mockKv.get(consistencyKeyForOwner(owner)) ?? null,
    );
    expect(ledger.drills).toHaveLength(1);
    expect(useConsistencyStore.getState().snapshot?.trainedToday).toBe(true);
  });

  it('consuming the Day N secured moment with a failing kv write still returns it once and clears state', async () => {
    addShot(0);
    await useConsistencyStore.getState().refresh();
    expect(useConsistencyStore.getState().daySecured).not.toBeNull();
    mockFlags.failSetKv = true;
    const consumed = useConsistencyStore.getState().consumeDaySecured();
    expect(consumed?.streak).toBe(1);
    expect(useConsistencyStore.getState().daySecured).toBeNull();
    expect(useConsistencyStore.getState().consumeDaySecured()).toBeNull();
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
    expect(consoleError).not.toHaveBeenCalled();
    // The durable marker never landed, but the consumption is remembered in
    // this process: the next refresh must not hand the same day out again
    // (the documented worst case is a repeat after a RESTART, not in-session).
    mockFlags.failSetKv = false;
    await useConsistencyStore.getState().refresh();
    expect(useConsistencyStore.getState().snapshot?.trainedToday).toBe(true);
    expect(useConsistencyStore.getState().daySecured).toBeNull();
    const ledger = parseConsistencyLedger(
      mockKv.get(consistencyKeyForOwner(owner)) ?? null,
    );
    expect(ledger.daySecuredShownDay).toBeNull();
  });

  it('consumeDaySecured for a signed-out owner returns null and persists nothing', async () => {
    useConsistencyStore.setState({
      daySecured: {
        day: '2026-09-04',
        streak: 1,
        xpToday: 10,
        shieldsAvailable: 0,
        nextMilestone: null,
      },
    });
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    expect(useConsistencyStore.getState().consumeDaySecured()).toBeNull();
    expect(useConsistencyStore.getState().daySecured).toBeNull();
    expect(mockKv.size).toBe(0);
  });

  it('an owner switch mid-refresh never writes the old owner’s snapshot', async () => {
    addShot(0);
    let release!: () => void;
    mockFlags.listShotsGate = new Promise<void>(resolve => {
      release = resolve;
    });
    const pending = useConsistencyStore.getState().refresh();
    await settleMicrotasks();
    setActiveDataOwner(otherOwner);
    release();
    await pending;
    const state = useConsistencyStore.getState();
    expect(getActiveDataOwner()).toBe(otherOwner);
    expect(state.snapshot).toBeNull();
    expect(state.ownerKey).toBeNull();
    expect(mockKv.has(consistencyKeyForOwner(owner))).toBe(false);
    expect(mockKv.has(consistencyKeyForOwner(otherOwner))).toBe(false);
  });

  it('an owner switch mid-refresh with a failing history read never flags the new owner', async () => {
    let release!: () => void;
    mockFlags.listShotsGate = new Promise<void>((_resolve, reject) => {
      release = () => reject(new Error('history read failed'));
    });
    const pending = useConsistencyStore.getState().refresh();
    await settleMicrotasks();
    setActiveDataOwner(otherOwner);
    release();
    await pending;
    expect(useConsistencyStore.getState().loadError).toBe(false);
    expect(useConsistencyStore.getState().ownerKey).toBeNull();
  });

  it('hydrate for a signed-out owner resets every field and marks hydrated', async () => {
    useConsistencyStore.setState({
      snapshot: null,
      celebration: {
        kind: 'streak',
        achievementId: 'streak.1',
        title: 'x',
        blurb: 'y',
        reward: 'z',
        rarity: 'common',
        value: 1,
        streakAtCelebration: 1,
      },
    });
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    await useConsistencyStore.getState().hydrate();
    const state = useConsistencyStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.ownerKey).toBe(SIGNED_OUT_DATA_OWNER);
    expect(state.celebration).toBeNull();
    expect(state.daySecured).toBeNull();
    expect(state.loadError).toBe(false);
  });

  it('serialized refreshes: a failing refresh does not block the next one in the queue', async () => {
    mockFlags.failGetKv = false;
    let release!: () => void;
    mockFlags.listShotsGate = new Promise<void>((_resolve, reject) => {
      release = () => reject(new Error('first read failed'));
    });
    const first = useConsistencyStore.getState().refresh();
    await settleMicrotasks();
    mockFlags.listShotsGate = null;
    addShot(0);
    const second = useConsistencyStore.getState().refresh();
    release();
    await Promise.all([first, second]);
    const state = useConsistencyStore.getState();
    expect(state.loadError).toBe(false);
    expect(state.snapshot?.currentStreak).toBe(1);
  });
});
