/**
 * Structural audit #2 (pass 1) — consistency store timing assumptions.
 *
 * The store serializes refreshes through `refreshQueue`, re-checks the
 * active owner before every state/persist write, caps the drill ledger at
 * 2000 records and persists the "Day N secured" consumption fire-and-forget.
 * None of that was exercised under overlap by the existing suite. Each
 * `it` below pins one of those assumptions with an in-memory kv whose
 * latency the test controls.
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

/** Per-call hooks the tests use to hold a read or a write open. */
const gates = {
  listShots: null as null | (() => Promise<void>),
  getKv: null as null | (() => Promise<void>),
  setKv: null as null | ((key: string) => Promise<void>),
  failSetKv: false,
};
const calls: string[] = [];

jest.mock('../../src/data/db', () => ({
  getDb: () => ({}),
}));

jest.mock('../../src/data/repository', () => ({
  getKv: async (_db: unknown, key: string) => {
    calls.push(`getKv:${key}`);
    if (gates.getKv) await gates.getKv();
    return mockKv.get(key) ?? null;
  },
  setKv: async (_db: unknown, key: string, value: string) => {
    calls.push(`setKv:${key}`);
    if (gates.setKv) await gates.setKv(key);
    if (gates.failSetKv) throw new Error('disk full');
    mockKv.set(key, value);
  },
  listActivityShots: async () => {
    calls.push('listActivityShots:start');
    if (gates.listShots) await gates.listShots();
    calls.push('listActivityShots:end');
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

const ownerA = '22222222-2222-4222-8222-222222222222';
const ownerB = '33333333-3333-4333-8333-333333333333';

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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = () => new Promise<void>(r => setTimeout(r, 0));

beforeEach(() => {
  mockKv.clear();
  mockShots.length = 0;
  calls.length = 0;
  gates.listShots = null;
  gates.getKv = null;
  gates.setKv = null;
  gates.failSetKv = false;
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

describe('audit: consistency store under overlap', () => {
  it('two overlapping refresh() calls never interleave their history reads', async () => {
    addShot(0);
    const hold = deferred();
    let holds = 0;
    gates.listShots = () => {
      holds += 1;
      return holds === 1 ? hold.promise : Promise.resolve();
    };
    const first = useConsistencyStore.getState().refresh();
    const second = useConsistencyStore.getState().refresh();
    await tick();
    // Only the first read has started; the second is queued behind it.
    expect(calls.filter(c => c === 'listActivityShots:start')).toHaveLength(1);
    hold.resolve();
    await Promise.all([first, second]);
    const starts = calls
      .map((c, i) => [c, i] as const)
      .filter(([c]) => c === 'listActivityShots:start')
      .map(([, i]) => i);
    const ends = calls
      .map((c, i) => [c, i] as const)
      .filter(([c]) => c === 'listActivityShots:end')
      .map(([, i]) => i);
    expect(starts).toHaveLength(2);
    expect(ends[0]!).toBeLessThan(starts[1]!);
    expect(useConsistencyStore.getState().snapshot?.currentStreak).toBe(1);
  });

  it('an owner switch mid-refresh discards the stale owner’s result: no state write, no kv write under the old owner', async () => {
    addShot(2);
    addShot(1);
    addShot(0); // Owner A would earn streak.1 + streak.3 → a ceremony write.
    const hold = deferred();
    gates.listShots = () => hold.promise;
    const staleRefresh = useConsistencyStore.getState().hydrate();
    await tick();

    // Sign A out, sign B in while A's history read is still in flight.
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    const signedOut = useConsistencyStore.getState().refresh();
    setActiveDataOwner(ownerB);
    mockShots.length = 0; // B has no activity.
    gates.listShots = null;
    const hydrateB = useConsistencyStore.getState().hydrate();

    hold.resolve();
    await Promise.all([staleRefresh, signedOut, hydrateB]);

    const state = useConsistencyStore.getState();
    expect(state.ownerKey).toBe(ownerB);
    expect(state.snapshot?.currentStreak ?? 0).toBe(0);
    expect(state.celebration).toBeNull();
    // A's ceremony must not have been persisted after A signed out.
    expect(mockKv.has(consistencyKeyForOwner(ownerA))).toBe(false);
    expect(
      calls.filter(c => c === `setKv:${consistencyKeyForOwner(ownerA)}`),
    ).toHaveLength(0);
  });

  it('a failed ceremony persist shows the snapshot without the ceremony, then retries on the next refresh', async () => {
    addShot(0);
    gates.failSetKv = true;
    await useConsistencyStore.getState().hydrate();
    let state = useConsistencyStore.getState();
    expect(state.snapshot?.currentStreak).toBe(1);
    expect(state.celebration).toBeNull();
    expect(state.loadError).toBe(false);

    gates.failSetKv = false;
    await useConsistencyStore.getState().refresh();
    state = useConsistencyStore.getState();
    expect(state.celebration).toMatchObject({ achievementId: 'streak.1' });
    const ledger = JSON.parse(mockKv.get(consistencyKeyForOwner(ownerA))!);
    expect(Object.keys(ledger.celebrated)).toEqual(['streak.1']);
  });

  it('a corrupt persisted ledger derives from shots instead of failing the refresh', async () => {
    addShot(0);
    mockKv.set(consistencyKeyForOwner(ownerA), '{not json');
    await useConsistencyStore.getState().hydrate();
    const state = useConsistencyStore.getState();
    expect(state.loadError).toBe(false);
    expect(state.snapshot?.currentStreak).toBe(1);
  });

  it('the drill ledger keeps the NEWEST 2000 completions when the cap is exceeded', async () => {
    const drills = Array.from({ length: 2000 }, (_, i) => ({
      id: `d-${i}`,
      slug: 'contact-shadow',
      title: 'Contact Shadow Reps',
      completedAtIso: isoDaysAgo(1),
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
    await useConsistencyStore.getState().hydrate();
    await useConsistencyStore.getState().recordDrillCompletion({
      id: 'd-newest',
      slug: 'contact-shadow',
      title: 'Contact Shadow Reps',
      completedAtIso: isoDaysAgo(0),
    });
    const ledger = JSON.parse(mockKv.get(consistencyKeyForOwner(ownerA))!) as {
      drills: Array<{ id: string }>;
    };
    expect(ledger.drills).toHaveLength(2000);
    expect(ledger.drills[0]!.id).toBe('d-1');
    expect(ledger.drills.at(-1)!.id).toBe('d-newest');
    expect(useConsistencyStore.getState().snapshot?.trainedToday).toBe(true);
  });

  it('a refresh that overlaps the consumeDaySecured persist does not re-arm the same day’s moment', async () => {
    addShot(1);
    addShot(0);
    await useConsistencyStore.getState().hydrate();
    expect(useConsistencyStore.getState().daySecured).toMatchObject({
      streak: 2,
    });

    // The banner consumes the moment; its ledger write is slow (real SQLite
    // I/O), and Home refreshes on focus before the write lands.
    const slowWrite = deferred();
    gates.setKv = () => slowWrite.promise;
    const consumed = useConsistencyStore.getState().consumeDaySecured();
    expect(consumed).toMatchObject({ streak: 2 });
    expect(useConsistencyStore.getState().daySecured).toBeNull();

    const overlapping = useConsistencyStore.getState().refresh();
    await tick();
    slowWrite.resolve();
    await overlapping;
    await tick();

    // Once consumed, today's moment must stay consumed in this process.
    expect(useConsistencyStore.getState().daySecured).toBeNull();
  });

  it('a consumeDaySecured persist failure keeps today’s moment consumed for the rest of this process', async () => {
    addShot(1);
    addShot(0);
    await useConsistencyStore.getState().hydrate();
    gates.failSetKv = true;
    expect(useConsistencyStore.getState().consumeDaySecured()).toMatchObject({
      streak: 2,
    });
    await tick();
    gates.failSetKv = false;

    // The store comment says the worst case is a repeat "after a restart".
    // Without a restart, the very next refresh must not re-arm it.
    await useConsistencyStore.getState().refresh();
    expect(useConsistencyStore.getState().daySecured).toBeNull();
  });
});
