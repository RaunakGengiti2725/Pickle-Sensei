/**
 * AUDIT (structural pass 1, mobile-home-progress-library): consistency store
 * concurrency, owner-switch, and persistence ordering.
 *
 * Probes the untested paths called out by the architecture map:
 *  - two overlapping refresh() calls serialize through `refreshQueue`;
 *  - an owner switch while a refresh is mid-flight discards that refresh's
 *    results (no write, no ledger persist for the old owner);
 *  - a signed-out hydrate clears celebration / daySecured so nothing leaks
 *    to the next owner;
 *  - consumeDaySecured() persistence vs a refresh that read the ledger
 *    before the marker landed.
 *
 * SQLite is replaced by an in-memory kv + shot table whose promise
 * resolution can be deferred per call to force interleavings.
 */

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

const mockKv = new Map<string, string>();
const mockShots: Array<{
  id: string;
  sessionId: string | null;
  shotType: string;
  capturedAt: string;
  overallScore: number | null;
  resultKind: string;
}> = [];

/** Gates: when set, the next matching repository call blocks on them. */
const mockGates: {
  shots: Deferred<void> | null;
  setKv: Deferred<void> | null;
} = { shots: null, setKv: null };
const mockSetKvCalls: Array<{ key: string; value: string }> = [];

jest.mock('../../src/data/db', () => ({
  getDb: () => ({}),
}));

jest.mock('../../src/data/repository', () => ({
  getKv: async (_db: unknown, key: string) => mockKv.get(key) ?? null,
  setKv: async (_db: unknown, key: string, value: string) => {
    if (mockGates.setKv) {
      const gate = mockGates.setKv;
      mockGates.setKv = null;
      await gate.promise;
    }
    mockSetKvCalls.push({ key, value });
    mockKv.set(key, value);
  },
  listActivityShots: async () => {
    if (mockGates.shots) {
      const gate = mockGates.shots;
      mockGates.shots = null;
      await gate.promise;
    }
    return [...mockShots];
  },
}));

import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';
import {
  consistencyKeyForOwner,
  useConsistencyStore,
} from '../../src/consistency/store';

const ownerA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ownerB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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

async function flush(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}

beforeEach(() => {
  mockKv.clear();
  mockShots.length = 0;
  mockSetKvCalls.length = 0;
  mockGates.shots = null;
  mockGates.setKv = null;
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

afterEach(() => {
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('AUDIT consistency store concurrency', () => {
  it('serializes overlapping refresh() calls and both resolve to the same snapshot', async () => {
    addShot(1);
    addShot(0);
    const gate = deferred<void>();
    mockGates.shots = gate;
    const first = useConsistencyStore.getState().refresh();
    const second = useConsistencyStore.getState().refresh();
    await flush();
    // Nothing written while the first run is blocked on the shot read.
    expect(useConsistencyStore.getState().snapshot).toBeNull();
    gate.resolve();
    await Promise.all([first, second]);
    const state = useConsistencyStore.getState();
    expect(state.ownerKey).toBe(ownerA);
    expect(state.snapshot?.currentStreak).toBe(2);
    expect(state.loadError).toBe(false);
    // Exactly one celebration persist for the milestone, not one per call.
    const ledgerWrites = mockSetKvCalls.filter(
      call => call.key === consistencyKeyForOwner(ownerA),
    );
    expect(ledgerWrites).toHaveLength(1);
  });

  it('discards a mid-flight refresh when the owner changes before the write', async () => {
    addShot(2);
    addShot(1);
    addShot(0);
    const gate = deferred<void>();
    mockGates.shots = gate;
    const inFlight = useConsistencyStore.getState().refresh();
    await flush();
    // Owner A signs out while A's shots are still loading.
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    gate.resolve();
    await inFlight;
    const state = useConsistencyStore.getState();
    expect(state.snapshot).toBeNull();
    expect(state.celebration).toBeNull();
    expect(state.daySecured).toBeNull();
    // No ledger for A was persisted by the discarded run.
    expect(mockKv.has(consistencyKeyForOwner(ownerA))).toBe(false);
    expect(mockSetKvCalls).toHaveLength(0);
  });

  it('never persists owner A ledger under owner B after a switch mid-refresh', async () => {
    addShot(2);
    addShot(1);
    addShot(0);
    const gate = deferred<void>();
    mockGates.shots = gate;
    const inFlight = useConsistencyStore.getState().refresh();
    await flush();
    setActiveDataOwner(ownerB);
    gate.resolve();
    await inFlight;
    expect(mockKv.has(consistencyKeyForOwner(ownerA))).toBe(false);
    expect(mockKv.has(consistencyKeyForOwner(ownerB))).toBe(false);
    expect(useConsistencyStore.getState().snapshot).toBeNull();
  });

  it('a signed-out hydrate clears celebration and daySecured before the next owner', async () => {
    addShot(2);
    addShot(1);
    addShot(0);
    await useConsistencyStore.getState().hydrate();
    expect(useConsistencyStore.getState().celebration).not.toBeNull();
    expect(useConsistencyStore.getState().daySecured).not.toBeNull();

    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    await useConsistencyStore.getState().hydrate();
    expect(useConsistencyStore.getState()).toMatchObject({
      snapshot: null,
      celebration: null,
      daySecured: null,
      ownerKey: SIGNED_OUT_DATA_OWNER,
    });

    // Owner B has no history: no ceremony inherited from A.
    mockShots.length = 0;
    setActiveDataOwner(ownerB);
    await useConsistencyStore.getState().hydrate();
    expect(useConsistencyStore.getState().celebration).toBeNull();
    expect(useConsistencyStore.getState().daySecured).toBeNull();
    expect(useConsistencyStore.getState().snapshot?.currentStreak).toBe(0);
  });

  it('a refresh that reads the ledger before consumeDaySecured persists does not re-arm the moment', async () => {
    addShot(1);
    addShot(0);
    await useConsistencyStore.getState().hydrate();
    expect(useConsistencyStore.getState().daySecured).not.toBeNull();

    // Hold the marker write so the concurrent refresh reads the stale ledger.
    const gate = deferred<void>();
    mockGates.setKv = gate;
    const consumed = useConsistencyStore.getState().consumeDaySecured();
    expect(consumed).not.toBeNull();
    expect(useConsistencyStore.getState().daySecured).toBeNull();

    const overlapping = useConsistencyStore.getState().refresh();
    await flush();
    gate.resolve();
    await overlapping;
    await flush();

    // The moment was consumed once today; the overlapping refresh must not
    // re-arm it (the banner would otherwise show twice in one session).
    expect(useConsistencyStore.getState().daySecured).toBeNull();
    const ledger = JSON.parse(mockKv.get(consistencyKeyForOwner(ownerA))!);
    expect(ledger.daySecuredShownDay).toBe(consumed!.day);
  });

  it('does not overwrite the persisted daySecured marker with a stale ledger from an earlier read', async () => {
    addShot(2);
    addShot(1);
    addShot(0);
    await useConsistencyStore.getState().hydrate();
    // Streak-3 celebration already persisted by hydrate; dismiss it so a
    // later refresh has nothing new to celebrate.
    useConsistencyStore.getState().dismissCelebration();
    const consumed = useConsistencyStore.getState().consumeDaySecured();
    expect(consumed).not.toBeNull();
    await flush();
    const persisted = JSON.parse(mockKv.get(consistencyKeyForOwner(ownerA))!);
    expect(persisted.daySecuredShownDay).toBe(consumed!.day);

    // A later refresh must keep the marker (it only rewrites the ledger when
    // new milestones need marking, spreading the ledger it just read).
    await useConsistencyStore.getState().refresh();
    const after = JSON.parse(mockKv.get(consistencyKeyForOwner(ownerA))!);
    expect(after.daySecuredShownDay).toBe(consumed!.day);
    expect(useConsistencyStore.getState().daySecured).toBeNull();
  });
});
