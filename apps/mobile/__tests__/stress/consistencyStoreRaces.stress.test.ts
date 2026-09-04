/**
 * STRESS — minimized interleavings distilled from the seeded campaign in
 * consistencyStoreConcurrency.stress.test.ts (seeds 2, 18, 43, 47, 14 and
 * the `crossOwnerSnapshotTicks` observation). Each probe scripts the exact
 * order in which parked SQLite reads/writes complete, so a failure here is a
 * reproduced defect in src/consistency/store.ts, not scheduler luck.
 *
 * Contract under test (store.ts doc-comment + AGENTS.md replay-from-facts):
 *   - a completed drill is durable in the owner ledger (no lost update);
 *   - one ceremony per milestone, persisted BEFORE it is shown;
 *   - the "Day N secured" moment surfaces once per day;
 *   - state shown under an owner key belongs to that owner.
 */

const mockKv = new Map<string, string>();
type ShotRow = {
  id: string;
  sessionId: string | null;
  shotType: string;
  capturedAt: string;
  overallScore: number | null;
  resultKind: string;
};
const mockShotsByOwner = new Map<string, ShotRow[]>();
const mockSched = {
  pending: [] as Array<{ label: string; release: () => void }>,
  faultOwners: new Set<string>(),
  activeOwner: (): string => 'unset',
  park(label: string): Promise<void> {
    return new Promise<void>(resolve => {
      mockSched.pending.push({ label, release: resolve });
    });
  },
};

jest.mock('../../src/data/db', () => ({ getDb: () => ({}) }));
jest.mock('../../src/data/repository', () => ({
  getKv: async (_db: unknown, key: string) => {
    await mockSched.park(`getKv:${key}`);
    return mockKv.get(key) ?? null;
  },
  setKv: async (_db: unknown, key: string, value: string) => {
    await mockSched.park(`setKv:${key}`);
    mockKv.set(key, value);
  },
  listActivityShots: async () => {
    const owner = mockSched.activeOwner();
    await mockSched.park(`listShots:${owner}`);
    if (mockSched.faultOwners.has(owner)) {
      throw new Error(`injected activity read failure for ${owner}`);
    }
    return [...(mockShotsByOwner.get(owner) ?? [])];
  },
}));

import * as accountScope from '../../src/data/accountScope';
import {
  consistencyKeyForOwner,
  parseConsistencyLedger,
  useConsistencyStore,
} from '../../src/consistency/store';

const { setActiveDataOwner, SIGNED_OUT_DATA_OWNER } = accountScope;
mockSched.activeOwner = accountScope.getActiveDataOwner;

const OWNER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEY_A = consistencyKeyForOwner(OWNER_A);
const DAY = 86_400_000;
const NOW = Date.parse('2026-06-15T12:00:00.000Z'); // mid-day UTC, quiet

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

/** Release the first parked op whose label starts with `prefix`. */
async function release(prefix: string): Promise<void> {
  await flush();
  const index = mockSched.pending.findIndex(p => p.label.startsWith(prefix));
  if (index < 0) {
    throw new Error(
      `no parked op matching ${prefix}; pending=${mockSched.pending.map(p => p.label).join(',')}`,
    );
  }
  const [next] = mockSched.pending.splice(index, 1);
  next!.release();
  await flush();
}

/** Release everything (FIFO) until the store is quiescent. */
async function drain(): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    await flush();
    if (mockSched.pending.length === 0) {
      await flush();
      if (mockSched.pending.length === 0) return;
    }
    mockSched.pending.shift()!.release();
  }
  throw new Error('drain did not reach quiescence in 200 releases');
}

/** Drive a store call to completion by releasing its parked I/O in order. */
async function settle<T>(call: Promise<T>): Promise<T> {
  await drain();
  return call;
}

function streak(
  owner: string,
  days: number,
  shotType: string,
  trainedToday: boolean,
): ShotRow[] {
  const rows: ShotRow[] = [];
  for (let d = trainedToday ? 0 : 1; d <= days; d += 1) {
    rows.push({
      id: `${owner.slice(0, 4)}-shot-${d}`,
      sessionId: null,
      shotType,
      capturedAt: new Date(NOW - d * DAY - 60_000).toISOString(),
      overallScore: 6,
      resultKind: 'scored',
    });
  }
  return rows;
}

const drill = (id: string) => ({
  id,
  slug: 'contact-shadow-reps',
  title: 'Contact Shadow Reps',
  completedAtIso: new Date(NOW - 30_000).toISOString(),
});

const ledgerA = () => parseConsistencyLedger(mockKv.get(KEY_A) ?? null);

beforeEach(() => {
  jest.useFakeTimers({
    doNotFake: [
      'setImmediate',
      'clearImmediate',
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'nextTick',
      'queueMicrotask',
    ],
    now: new Date(NOW),
  });
  mockKv.clear();
  mockShotsByOwner.clear();
  mockSched.pending.length = 0;
  mockSched.faultOwners.clear();
  useConsistencyStore.setState({
    hydrated: false,
    ownerKey: null,
    snapshot: null,
    loadError: false,
    celebration: null,
    daySecured: null,
  });
  setActiveDataOwner(OWNER_A);
});

afterEach(async () => {
  await drain();
  jest.useRealTimers();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('consistency store — minimized races (campaign seeds 2/18/43/47/14)', () => {
  it('R1 two drill completions in flight together are both durable (seed 2: lost update)', async () => {
    mockShotsByOwner.set(OWNER_A, streak(OWNER_A, 2, 'dink', false));
    const store = useConsistencyStore.getState();
    const x = store.recordDrillCompletion(drill('drill-x'));
    const y = store.recordDrillCompletion(drill('drill-y'));
    await release('getKv'); // x reads ledger []
    await release('getKv'); // y reads ledger []
    await release('setKv'); // x writes [x]
    await release('setKv'); // y writes [y]  ← overwrites x
    await drain();
    await Promise.all([x, y]);
    expect(
      ledgerA()
        .drills.map(d => d.id)
        .sort(),
    ).toEqual(['drill-x', 'drill-y']);
  });

  it('R2 a drill write racing the ceremony write must not clobber the celebrated mark (seeds 18/43: double ceremony)', async () => {
    // 3 straight days → streak.3 is newly earned → refresh persists the mark.
    mockShotsByOwner.set(OWNER_A, streak(OWNER_A, 3, 'dink', true));
    const store = useConsistencyStore.getState();
    const surfaced: string[] = [];
    const unsubscribe = useConsistencyStore.subscribe((state, prev) => {
      if (state.celebration && state.celebration !== prev.celebration) {
        surfaced.push(state.celebration.achievementId);
      }
    });
    const refresh1 = store.refresh();
    await release('listShots');
    await release('getKv'); // refresh reads ledger (celebrated {})
    const drillCall = store.recordDrillCompletion(drill('drill-x'));
    await release('getKv'); // drill reads ledger (celebrated {})
    await release('setKv'); // refresh writes celebrated {streak.*}
    await refresh1;
    expect(surfaced).toContain('streak.3');
    expect(ledgerA().celebrated['streak.3']).toBeTruthy();
    await release('setKv'); // drill writes {drills:[x]} from its stale read
    const durableAfterDrillWrite = ledgerA().celebrated['streak.3'];
    await drain();
    await drillCall;
    store.dismissCelebration();
    await settle(store.refresh());
    unsubscribe();
    expect({
      markDurableAfterDrillWrite: Boolean(durableAfterDrillWrite),
      timesStreak3Surfaced: surfaced.filter(id => id === 'streak.3').length,
      ledgerDrills: ledgerA().drills.map(d => d.id),
    }).toEqual({
      markDurableAfterDrillWrite: true,
      timesStreak3Surfaced: 1,
      ledgerDrills: ['drill-x'],
    });
  });

  it('R3 consuming the day-secured moment must stick even when a drill write races the marker (seed 47: moment shown twice)', async () => {
    mockShotsByOwner.set(OWNER_A, streak(OWNER_A, 1, 'dink', true));
    const store = useConsistencyStore.getState();
    await settle(store.hydrate());
    const first = store.consumeDaySecured();
    expect(first?.day).toBeDefined();
    // consumeDaySecured's persist tail parks on getKv; a drill completes now.
    const drillCall = store.recordDrillCompletion(drill('drill-x'));
    await release('getKv'); // consume tail reads ledger
    await release('getKv'); // drill reads ledger (no marker yet)
    await release('setKv'); // consume tail writes daySecuredShownDay
    expect(ledgerA().daySecuredShownDay).toBe(first!.day);
    await release('setKv'); // drill writes {drills:[x]} from its stale read
    const markerAfterDrillWrite = ledgerA().daySecuredShownDay;
    await drain();
    await drillCall; // its trailing refresh re-reads the ledger
    const second = useConsistencyStore.getState().consumeDaySecured();
    expect({
      markerAfterDrillWrite,
      secondConsumeReturns: second?.day ?? null,
    }).toEqual({
      markerAfterDrillWrite: first!.day,
      secondConsumeReturns: null,
    });
  });

  it('R4 a pending ceremony does not follow the device to the next signed-in owner (seed 14: foreign celebration)', async () => {
    mockShotsByOwner.set(OWNER_A, streak(OWNER_A, 3, 'dink', true));
    mockShotsByOwner.set(OWNER_B, streak(OWNER_B, 1, 'serve', true));
    await settle(useConsistencyStore.getState().hydrate());
    expect(useConsistencyStore.getState().celebration?.achievementId).toBe(
      'streak.3',
    );
    // Owner A never dismissed the ceremony; the account switches (Gate →
    // useConsistencyBootstrap → hydrate).
    setActiveDataOwner(OWNER_B);
    await settle(useConsistencyStore.getState().hydrate());
    const state = useConsistencyStore.getState();
    expect(state.ownerKey).toBe(OWNER_B);
    expect(state.snapshot?.earned.map(e => e.id)).not.toContain('streak.3');
    expect(state.celebration).toBeNull();
  });

  it('R5 a failed load for the new owner must not leave the previous owner’s snapshot on screen', async () => {
    mockShotsByOwner.set(OWNER_A, streak(OWNER_A, 5, 'dink', true));
    mockShotsByOwner.set(OWNER_B, streak(OWNER_B, 1, 'serve', true));
    await settle(useConsistencyStore.getState().hydrate());
    expect(useConsistencyStore.getState().snapshot?.currentStreak).toBe(6);
    mockSched.faultOwners.add(OWNER_B);
    setActiveDataOwner(OWNER_B);
    await settle(useConsistencyStore.getState().hydrate());
    const state = useConsistencyStore.getState();
    expect(state.ownerKey).toBe(OWNER_B);
    expect(state.loadError).toBe(true);
    const visibleTechniques = new Set(
      Object.values(state.snapshot?.days ?? {}).flatMap(d =>
        d.activities.map(a => a.label),
      ),
    );
    expect([...visibleTechniques]).not.toContain('dink');
  });

  it('R6 duplicate completion of the SAME drill id is idempotent even when both calls are in flight (HELD)', async () => {
    mockShotsByOwner.set(OWNER_A, []);
    const store = useConsistencyStore.getState();
    const a = store.recordDrillCompletion(drill('drill-same'));
    const b = store.recordDrillCompletion(drill('drill-same'));
    await drain();
    await Promise.all([a, b]);
    expect(ledgerA().drills.map(d => d.id)).toEqual(['drill-same']);
    expect(useConsistencyStore.getState().snapshot?.totalActivities).toBe(1);
  });

  it('R7 logout mid-refresh leaves no snapshot behind (HELD)', async () => {
    mockShotsByOwner.set(OWNER_A, streak(OWNER_A, 3, 'dink', true));
    const store = useConsistencyStore.getState();
    const refresh = store.refresh();
    await release('listShots');
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    await useConsistencyStore.getState().hydrate();
    await drain();
    await refresh;
    const state = useConsistencyStore.getState();
    expect(state.ownerKey).toBe(SIGNED_OUT_DATA_OWNER);
    expect(state.snapshot).toBeNull();
    expect(state.celebration).toBeNull();
    expect(state.daySecured).toBeNull();
  });
});
