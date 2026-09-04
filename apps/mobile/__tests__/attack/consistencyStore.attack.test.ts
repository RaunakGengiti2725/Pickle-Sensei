/**
 * Adversarial pass (mobile-home-progress-library #1, pass 3) against the
 * consistency store's persisted ledger: the 2,000-record cap, corrupt
 * ledgers, unicode payloads, rapid repeats, owner switches mid-write and
 * a failing kv. SQLite is replaced by an in-memory kv + shot table.
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
let mockSetKvCalls = 0;
let mockGetKvGate: (() => Promise<void>) | null = null;
let mockSetKvFailure: Error | null = null;

jest.mock('../../src/data/db', () => ({
  getDb: () => ({}),
}));

jest.mock('../../src/data/repository', () => ({
  getKv: async (_db: unknown, key: string) => {
    if (mockGetKvGate) await mockGetKvGate();
    return mockKv.get(key) ?? null;
  },
  setKv: async (_db: unknown, key: string, value: string) => {
    mockSetKvCalls += 1;
    if (mockSetKvFailure) throw mockSetKvFailure;
    mockKv.set(key, value);
  },
  listActivityShots: async () => [...mockShots],
}));

import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';
import {
  consistencyKeyForOwner,
  parseConsistencyLedger,
  useConsistencyStore,
  type ConsistencyDrillRecord,
} from '../../src/consistency/store';

const owner = '33333333-3333-4333-8333-333333333333';
const otherOwner = '44444444-4444-4444-8444-444444444444';

function isoDaysAgo(days: number, hour = 12): string {
  if (days === 0) return new Date(Date.now() - 1_000).toISOString();
  const date = new Date();
  date.setHours(hour, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

function drill(index: number, daysAgo = 0): ConsistencyDrillRecord {
  return {
    id: `drill-${String(index).padStart(5, '0')}`,
    slug: `slug-${index}`,
    title: `Drill ${index}`,
    completedAtIso: isoDaysAgo(daysAgo),
  };
}

function readLedger() {
  return parseConsistencyLedger(
    mockKv.get(consistencyKeyForOwner(owner)) ?? null,
  );
}

beforeEach(() => {
  mockKv.clear();
  mockShots.length = 0;
  mockSetKvCalls = 0;
  mockGetKvGate = null;
  mockSetKvFailure = null;
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

describe('S7 — ledger with 2,500 drill completions', () => {
  it('caps at the newest 2,000 records and the persisted JSON shrinks', async () => {
    // 2,500 records spread across the past 2,500 days, oldest first.
    const seeded: ConsistencyDrillRecord[] = [];
    for (let i = 0; i < 2_500; i += 1) {
      seeded.push(drill(i, 2_500 - i));
    }
    const before = JSON.stringify({
      version: 1,
      drills: seeded,
      celebrated: { 'streak.1': '2020-01-01' },
      daySecuredShownDay: '2020-01-02',
    });
    mockKv.set(consistencyKeyForOwner(owner), before);

    const newest = drill(2_500, 0);
    await useConsistencyStore.getState().recordDrillCompletion(newest);

    const after = mockKv.get(consistencyKeyForOwner(owner))!;
    expect(after.length).toBeLessThan(before.length);
    const ledger = readLedger();
    expect(ledger.drills).toHaveLength(2_000);
    // Newest record is last; the oldest surviving record is #501 (2,501
    // total − 2,000 kept).
    expect(ledger.drills[ledger.drills.length - 1]).toEqual(newest);
    expect(ledger.drills[0]!.id).toBe('drill-00501');
    expect(ledger.drills.map(d => d.id)).toEqual(
      [...seeded.slice(501), newest].map(d => d.id),
    );
    // Unrelated ledger fields survive the rewrite.
    expect(ledger.celebrated['streak.1']).toBe('2020-01-01');
    expect(ledger.daySecuredShownDay).toBe('2020-01-02');
    console.info(
      `[attack] ledger bytes before=${before.length} after=${after.length}`,
    );
  });

  it('a duplicate id against a 2,500 ledger is a no-op write (ledger untouched, still 2,500)', async () => {
    const seeded: ConsistencyDrillRecord[] = [];
    for (let i = 0; i < 2_500; i += 1) seeded.push(drill(i, 2_500 - i));
    const before = JSON.stringify({
      version: 1,
      drills: seeded,
      celebrated: {},
    });
    mockKv.set(consistencyKeyForOwner(owner), before);

    await useConsistencyStore
      .getState()
      .recordDrillCompletion({ ...drill(7, 1), title: 'renamed' });
    expect(mockSetKvCalls).toBe(0);
    expect(mockKv.get(consistencyKeyForOwner(owner))).toBe(before);
    // The early return skips refresh(): nothing changed, nothing recomputed.
    expect(useConsistencyStore.getState().snapshot).toBeNull();
    // An explicit refresh still replays the oversize ledger in full.
    await useConsistencyStore.getState().refresh();
    expect(useConsistencyStore.getState().snapshot?.totalActivities).toBe(
      2_500,
    );
  });

  it('the cap is stable under 50 sequential completions past the limit', async () => {
    const seeded: ConsistencyDrillRecord[] = [];
    for (let i = 0; i < 2_000; i += 1) seeded.push(drill(i, 2_000 - i));
    mockKv.set(
      consistencyKeyForOwner(owner),
      JSON.stringify({ version: 1, drills: seeded, celebrated: {} }),
    );
    for (let i = 2_000; i < 2_050; i += 1) {
      await useConsistencyStore.getState().recordDrillCompletion(drill(i, 0));
    }
    const ledger = readLedger();
    expect(ledger.drills).toHaveLength(2_000);
    expect(ledger.drills[0]!.id).toBe('drill-00050');
    expect(ledger.drills[1_999]!.id).toBe('drill-02049');
  });
});

describe('extra — corrupt ledgers, unicode, failures, owner switches', () => {
  it('parseConsistencyLedger survives every corrupt shape without throwing', () => {
    const shapes = [
      'null',
      '[]',
      '"string"',
      '42',
      '{',
      '{"version":1,"drills":"nope","celebrated":[1,2]}',
      '{"drills":[null,1,"x",{"id":"","completedAtIso":"2026-01-01T00:00:00Z"},{"id":"ok","completedAtIso":"2026-01-01T00:00:00Z"}]}',
      '{"drills":[{"id":{"nested":true},"completedAtIso":["a"]}],"celebrated":{"streak.1":1,"streak.3":"2026-01-01"},"daySecuredShownDay":7}',
      '\uFEFF{"drills":[]}',
      JSON.stringify({ __proto__: { polluted: true }, drills: [] }),
    ];
    for (const raw of shapes) {
      const ledger = parseConsistencyLedger(raw);
      expect(ledger.version).toBe(1);
      expect(Array.isArray(ledger.drills)).toBe(true);
      expect(typeof ledger.celebrated).toBe('object');
      expect(
        ledger.daySecuredShownDay === null ||
          typeof ledger.daySecuredShownDay === 'string',
      ).toBe(true);
    }
    const nested = parseConsistencyLedger(shapes[7]!);
    expect(nested.drills).toEqual([
      { id: '[object Object]', slug: '', title: '', completedAtIso: 'a' },
    ]);
    expect(nested.celebrated).toEqual({ 'streak.3': '2026-01-01' });
    expect(nested.daySecuredShownDay).toBeNull();
    // Prototype pollution through the ledger must not leak.
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('records a drill with unicode / emoji / RTL / huge title and replays it', async () => {
    const title = '🏓 ثالث Drop — 「第三球」'.repeat(200);
    await useConsistencyStore.getState().recordDrillCompletion({
      id: 'unicode-1',
      slug: 'ünïcødé-🏓',
      title,
      completedAtIso: isoDaysAgo(0),
    });
    const ledger = readLedger();
    expect(ledger.drills[0]!.title).toBe(title);
    const state = useConsistencyStore.getState();
    expect(state.snapshot?.trainedToday).toBe(true);
    expect(
      state.snapshot?.days[state.snapshot.asOfDay]?.activities[0]?.label,
    ).toBe(title);
  });

  it('a drill with an invalid completedAtIso is persisted but never counted', async () => {
    await useConsistencyStore.getState().recordDrillCompletion({
      id: 'bad-time',
      slug: 'x',
      title: 'x',
      completedAtIso: '2026-13-45T00:00:00Z',
    });
    expect(readLedger().drills).toHaveLength(1);
    expect(useConsistencyStore.getState().snapshot?.totalActivities).toBe(0);
    expect(useConsistencyStore.getState().snapshot?.trainedToday).toBe(false);
  });

  it('a setKv failure never rejects recordDrillCompletion and refresh still runs', async () => {
    mockSetKvFailure = new Error('database is locked');
    mockShots.push({
      id: 's1',
      sessionId: null,
      shotType: 'dink',
      capturedAt: isoDaysAgo(0),
      overallScore: 6,
      resultKind: 'scored',
    });
    await expect(
      useConsistencyStore.getState().recordDrillCompletion(drill(1, 0)),
    ).resolves.toBeUndefined();
    expect(mockKv.has(consistencyKeyForOwner(owner))).toBe(false);
    const state = useConsistencyStore.getState();
    // refresh() ran: the shot alone makes today trained. The celebration
    // could not be persisted so it is skipped (durable-before-shown).
    expect(state.snapshot?.trainedToday).toBe(true);
    expect(state.celebration).toBeNull();
    expect(state.loadError).toBe(false);
  });

  it('owner switch while getKv is pending: nothing is written under the old owner', async () => {
    let release!: () => void;
    mockGetKvGate = () =>
      new Promise<void>(resolve => {
        release = resolve;
      });
    const pending = useConsistencyStore
      .getState()
      .recordDrillCompletion(drill(1, 0));
    await Promise.resolve();
    setActiveDataOwner(otherOwner);
    mockGetKvGate = null;
    release();
    await pending;
    expect(mockKv.has(consistencyKeyForOwner(owner))).toBe(false);
    expect(mockKv.has(consistencyKeyForOwner(otherOwner))).toBe(false);
    expect(mockSetKvCalls).toBe(0);
    // The owner guard returns before refresh(): no state is published for
    // the old owner (the new owner's hydrate() owns the next publish).
    expect(useConsistencyStore.getState().ownerKey).toBeNull();
    expect(useConsistencyStore.getState().snapshot).toBeNull();
  });

  it('signed-out process: recordDrillCompletion is a no-op and writes nothing', async () => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    await useConsistencyStore.getState().recordDrillCompletion(drill(1, 0));
    expect(mockKv.size).toBe(0);
    expect(mockSetKvCalls).toBe(0);
  });

  it('rapid repeat of the SAME id (10 concurrent calls) persists exactly one record', async () => {
    await Promise.all(
      Array.from({ length: 10 }, () =>
        useConsistencyStore.getState().recordDrillCompletion(drill(1, 0)),
      ),
    );
    const ledger = readLedger();
    // Every call read an empty ledger before any wrote, so each wrote the
    // same single record — the id de-dupe holds on the persisted result.
    expect(ledger.drills).toHaveLength(1);
    expect(ledger.drills[0]!.id).toBe('drill-00001');
  });

  // FINDING (P3, pre-existing on main): recordDrillCompletion is an unserialised
  // read-modify-write of the ledger. Two DIFFERENT drills completing in the
  // same async window both read the same base and the second setKv
  // overwrites the first — a completed drill vanishes from the local ledger
  // (store.ts:391-401). `it.failing` documents the rule; flip once fixed.
  it.failing(
    'two DIFFERENT drills completing concurrently must both survive in the ledger (store.ts:391-401)',
    async () => {
      await Promise.all([
        useConsistencyStore.getState().recordDrillCompletion(drill(1, 1)),
        useConsistencyStore.getState().recordDrillCompletion(drill(2, 0)),
      ]);
      expect(readLedger().drills.map(d => d.id)).toEqual([
        'drill-00001',
        'drill-00002',
      ]);
    },
  );

  it('documents the lost update: concurrent different drills → only one persisted', async () => {
    await Promise.all([
      useConsistencyStore.getState().recordDrillCompletion(drill(1, 1)),
      useConsistencyStore.getState().recordDrillCompletion(drill(2, 0)),
    ]);
    const ids = readLedger().drills.map(d => d.id);
    console.info(
      `[attack][finding] concurrent drills persisted=${JSON.stringify(ids)}`,
    );
    expect(ids).toHaveLength(1);
    // Sequential completion of the same two drills keeps both.
    mockKv.clear();
    await useConsistencyStore.getState().recordDrillCompletion(drill(1, 1));
    await useConsistencyStore.getState().recordDrillCompletion(drill(2, 0));
    expect(readLedger().drills.map(d => d.id)).toEqual([
      'drill-00001',
      'drill-00002',
    ]);
  });

  it('a corrupt ledger string is replaced by a valid one on the next completion', async () => {
    mockKv.set(consistencyKeyForOwner(owner), '{not json');
    await useConsistencyStore.getState().recordDrillCompletion(drill(1, 0));
    const ledger = readLedger();
    expect(ledger.drills).toHaveLength(1);
    expect(() =>
      JSON.parse(mockKv.get(consistencyKeyForOwner(owner))!),
    ).not.toThrow();
    expect(useConsistencyStore.getState().snapshot?.trainedToday).toBe(true);
  });
});
