/**
 * Minimized reproductions of every BROKEN finding the seeded campaigns in
 * this directory surfaced (store-failure-injection seeds 3 / 8 / 98 / 192 / 1,
 * screen-bootstrap seed 9, engine adversarial payload `ancient-year-0099`).
 *
 * Each `it` asserts the behaviour the module contract promises; a red case
 * here IS the finding (see the campaign report). Every case is deterministic —
 * no RNG, no wall clock — and finishes in fake-timer time.
 *
 *   F1  an unreadable / malformed ledger read is treated as an EMPTY ledger
 *       and then written back → drill history wiped, milestone ceremonies and
 *       "Day N secured" replayed        (store.ts loadConsistencyActivities +
 *       refresh celebration write + consumeDaySecured read-modify-write)
 *   F2  one activity row whose timestamp parses to a year < 1000 makes
 *       dayOrdinal() NaN → the streak walk never runs → currentStreak 0,
 *       XP 0, trainedDays 0 while trainedToday stays true   (engine.ts)
 *   F3  a never-settling repository call parks the module-level refreshQueue
 *       forever: no timeout, every later refresh (retry, foreground, drill
 *       completion) waits behind it, the screen keeps its "0 DAY STREAK"
 *       empty state with no error / retry               (store.ts refresh)
 *   F4  a failed drill write is swallowed with no state signal (documented
 *       in store.ts as deliberate; recorded here for the lens, P3)
 *   F5  sign out → sign in as another account: the previous account's snapshot
 *       is never cleared, so while (or if) the new account's first history
 *       read fails / hangs the screen shows the OLD account's streak under the
 *       new ownerKey — and `!snapshot && loadError` hides the error card
 *       (store.ts hydrate/refresh error path + useConsistencyBootstrap null
 *       owner + StreakCalendarScreen)
 */
import { FaultRepository } from '../../test-support/stress/consistency/faultRepo';

let mockRepo = new FaultRepository();

jest.mock('../../src/data/db', () => ({
  getDb: () => mockRepo.getDb(),
}));

jest.mock('../../src/data/repository', () => ({
  getKv: (db: unknown, key: string) => mockRepo.getKv(db, key),
  setKv: (db: unknown, key: string, value: string) =>
    mockRepo.setKv(db, key, value),
  listActivityShots: (db: unknown) => mockRepo.listActivityShots(db),
}));

import type { ActivityShotRow } from '../../src/data/repository';
import {
  buildConsistencySnapshot,
  dayOrdinal,
  type TrainingActivityInput,
} from '../../src/consistency/engine';
import {
  consistencyKeyForOwner,
  parseConsistencyLedger,
} from '../../src/consistency/store';
import {
  installDeviceTimeZoneShim,
  setDeviceTimeZone,
} from '../../test-support/stress/consistency/deviceShim';

type StoreModule = typeof import('../../src/consistency/store');
type ScopeModule = typeof import('../../src/data/accountScope');

const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW_ISO = '2026-04-20T18:00:00.000Z';
const DAY_MS = 86_400_000;

let restoreZoneShim: (() => void) | null = null;

beforeAll(() => {
  restoreZoneShim = installDeviceTimeZoneShim();
});

afterAll(() => {
  restoreZoneShim?.();
});

beforeEach(() => {
  jest.useFakeTimers({ now: Date.parse(NOW_ISO) });
  setDeviceTimeZone('UTC');
  mockRepo = new FaultRepository();
  jest.resetModules();
});

afterEach(() => {
  jest.useRealTimers();
  setDeviceTimeZone(null);
});

function loadStore(): {
  store: StoreModule['useConsistencyStore'];
  setOwner: ScopeModule['setActiveDataOwner'];
} {
  const storeModule = jest.requireActual(
    '../../src/consistency/store',
  ) as StoreModule;
  const scopeModule = jest.requireActual(
    '../../src/data/accountScope',
  ) as ScopeModule;
  mockRepo.ownerResolver = scopeModule.getActiveDataOwner;
  scopeModule.setActiveDataOwner(OWNER);
  return {
    store: storeModule.useConsistencyStore,
    setOwner: scopeModule.setActiveDataOwner,
  };
}

function shot(id: string, daysAgo: number): ActivityShotRow {
  return {
    id,
    sessionId: null,
    shotType: 'dink',
    capturedAt: new Date(
      Date.parse(NOW_ISO) - daysAgo * DAY_MS - 60_000,
    ).toISOString(),
    overallScore: 7.5,
    resultKind: 'scored',
  };
}

/** Three consecutive trained days ending today → streak.1 and streak.3 earned. */
function seedThreeDayHistory(): void {
  mockRepo.shots.set(OWNER, [shot('s0', 0), shot('s1', 1), shot('s2', 2)]);
}

function seedLedger(ledger: {
  drills?: {
    id: string;
    slug: string;
    title: string;
    completedAtIso: string;
  }[];
  celebrated?: Record<string, string>;
  daySecuredShownDay?: string | null;
}): void {
  mockRepo.kv.set(
    consistencyKeyForOwner(OWNER),
    JSON.stringify({
      version: 1,
      drills: ledger.drills ?? [],
      celebrated: ledger.celebrated ?? {},
      daySecuredShownDay: ledger.daySecuredShownDay ?? null,
    }),
  );
}

function persistedLedger() {
  return parseConsistencyLedger(
    mockRepo.kv.get(consistencyKeyForOwner(OWNER)) ?? null,
  );
}

async function settled(
  promise: Promise<unknown>,
  budgetMs = 60_000,
): Promise<'resolved' | 'rejected' | 'hung'> {
  let status: 'resolved' | 'rejected' | 'hung' = 'hung';
  promise.then(
    () => {
      status = 'resolved';
    },
    () => {
      status = 'rejected';
    },
  );
  await jest.advanceTimersByTimeAsync(0);
  for (
    let elapsed = 0;
    status === 'hung' && elapsed < budgetMs;
    elapsed += 1_000
  ) {
    await jest.advanceTimersByTimeAsync(1_000);
  }
  return status;
}

const DRILL = {
  id: 'drill-yesterday',
  slug: 'dink-ladder',
  title: 'Dink ladder',
  completedAtIso: new Date(Date.parse(NOW_ISO) - DAY_MS).toISOString(),
};

describe('F1 — unreadable ledger read is written back as an empty ledger', () => {
  // Transient read failures: the row on disk is intact the whole time, only
  // this one read failed. Anything written back from the EMPTY fallback
  // destroys data that was never lost.
  const READ_FAULTS = [
    {
      label: 'getKv rejects (SQLITE_IOERR)',
      arm: () => mockRepo.arm('getKv', { kind: 'reject' }),
    },
    {
      label: 'getKv throws synchronously',
      arm: () => mockRepo.arm('getKv', { kind: 'throw' }),
    },
    {
      label: 'getKv rejects with a non-Error',
      arm: () => mockRepo.arm('getKv', { kind: 'reject-non-error' }),
    },
    {
      label: 'getKv resolves only after 45s (slow success — control case)',
      arm: () => mockRepo.arm('getKv', { kind: 'timeout', delayMs: 45_000 }),
    },
  ];
  // Weaker variant: the driver hands back garbage for an intact row (the
  // stress campaign's `malformed` / `partial` getKv faults). Same write-back.
  const GARBAGE_READS = [
    {
      label: 'getKv returns truncated JSON',
      arm: () => mockRepo.arm('getKv', { kind: 'partial' }),
    },
    {
      label: 'getKv returns non-ledger JSON (`true`)',
      arm: () =>
        mockRepo.arm('getKv', { kind: 'malformed', variant: 'json-true' }),
    },
  ];

  for (const fault of [...READ_FAULTS, ...GARBAGE_READS]) {
    it(`keeps persisted drills when a refresh's ledger read fails once: ${fault.label}`, async () => {
      seedThreeDayHistory();
      seedLedger({ drills: [DRILL], celebrated: {} });
      const before = persistedLedger();
      expect(before.drills.map(d => d.id)).toEqual([DRILL.id]);

      const { store } = loadStore();
      fault.arm();
      expect(await settled(store.getState().refresh())).toBe('resolved');

      // The only kv write the store performed was the celebration marker;
      // it must not have dropped the drill that was already on disk.
      const written = mockRepo.writes.map(w => parseConsistencyLedger(w.value));
      expect(written.length).toBeGreaterThan(0);
      expect(persistedLedger().drills.map(d => d.id)).toEqual([DRILL.id]);
    });
  }

  it('does not replay an already-celebrated milestone after one failed ledger read', async () => {
    seedThreeDayHistory();
    seedLedger({
      celebrated: { 'streak.1': '2026-04-18', 'streak.3': '2026-04-20' },
    });
    const { store } = loadStore();
    mockRepo.arm('getKv', { kind: 'reject' });
    expect(await settled(store.getState().refresh())).toBe('resolved');
    expect(store.getState().celebration).toBeNull();
    expect(Object.keys(persistedLedger().celebrated).sort()).toEqual([
      'streak.1',
      'streak.3',
    ]);
  });

  it('does not re-arm "Day N secured" after one failed ledger read', async () => {
    seedThreeDayHistory();
    seedLedger({
      celebrated: { 'streak.1': 'x', 'streak.3': 'x' },
      daySecuredShownDay: '2026-04-20',
    });
    const { store } = loadStore();
    expect(await settled(store.getState().refresh())).toBe('resolved');
    expect(store.getState().daySecured).toBeNull();

    mockRepo.arm('getKv', { kind: 'reject' });
    expect(await settled(store.getState().refresh())).toBe('resolved');
    expect(store.getState().daySecured).toBeNull();
  });

  it('consumeDaySecured after a garbage ledger read does not wipe drills', async () => {
    seedThreeDayHistory();
    seedLedger({
      drills: [DRILL],
      celebrated: { 'streak.1': 'x', 'streak.3': 'x' },
    });
    const { store } = loadStore();
    expect(await settled(store.getState().refresh())).toBe('resolved');
    expect(store.getState().daySecured?.day).toBe('2026-04-20');

    mockRepo.arm('getKv', { kind: 'malformed', variant: 'json-array' });
    store.getState().consumeDaySecured();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(persistedLedger().drills.map(d => d.id)).toEqual([DRILL.id]);
  });
});

describe('F2 — one ancient-year row zeroes the whole streak', () => {
  const zones = [
    'UTC',
    'Asia/Katmandu',
    'America/Los_Angeles',
    'Pacific/Chatham',
  ];
  const ancientYears = ['0099', '0001', '0999'];

  for (const zone of zones) {
    for (const year of ancientYears) {
      for (const position of ['first', 'last'] as const) {
        it(`ignores or isolates a ${year}-dated row (${position} in history) in ${zone} instead of zeroing today's streak`, () => {
          const healthy: TrainingActivityInput[] = [0, 1, 2].map(daysAgo => ({
            kind: 'stroke',
            atIso: new Date(
              Date.parse(NOW_ISO) - daysAgo * DAY_MS - 60_000,
            ).toISOString(),
            shotType: 'dink',
            overallScore: 7,
            resultKind: 'scored',
          }));
          const baseline = buildConsistencySnapshot(healthy, {
            asOfIso: NOW_ISO,
            timeZone: zone,
          });
          expect(baseline.currentStreak).toBe(3);

          const ancient: TrainingActivityInput = {
            kind: 'stroke',
            atIso: `${year}-03-29T12:00:00.000Z`,
            shotType: 'dink',
          };
          // dayOrdinal('99-03-29') is NaN; `[...keys].map(dayOrdinal).sort((a, b) => a - b)`
          // has an inconsistent comparator, so where the NaN lands depends on
          // insertion order — hence both positions.
          const poisoned = buildConsistencySnapshot(
            position === 'first'
              ? [ancient, ...healthy]
              : [...healthy, ancient],
            { asOfIso: NOW_ISO, timeZone: zone },
          );
          // The row is decades-to-millennia in the past: it may add a trained
          // day, but it must never erase the run that ends today.
          expect(poisoned.trainedToday).toBe(true);
          expect(poisoned.currentStreak).toBe(3);
          expect(poisoned.totalTrainedDays).toBeGreaterThanOrEqual(3);
          expect(poisoned.momentumXp).toBeGreaterThanOrEqual(
            baseline.momentumXp,
          );
        });
      }
    }
  }

  it('dayOrdinal is finite for every day key the engine can produce (root cause)', () => {
    // Intl with year:'numeric' prints year 99 as "99", so the engine builds
    // the key "99-03-29"; Date.parse('99-03-29T00:00:00.000Z') is NaN.
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = formatter.formatToParts(
      Date.parse('0099-03-29T12:00:00.000Z'),
    );
    const year = parts.find(p => p.type === 'year')?.value;
    const key = `${year}-03-29`;
    expect(Number.isFinite(dayOrdinal(key))).toBe(true);
  });
});

describe('F3 — a never-settling repository call poisons refreshQueue forever', () => {
  it('a hung history read does not block a later refresh once the dependency is healthy again', async () => {
    seedThreeDayHistory();
    seedLedger({ celebrated: { 'streak.1': 'x', 'streak.3': 'x' } });
    const { store } = loadStore();

    mockRepo.arm('listActivityShots', { kind: 'never' });
    const first = store.getState().refresh();
    expect(await settled(first)).toBe('hung');
    mockRepo.clearFaults();

    // Foreground / "Try again" → a fresh refresh. It must reach the repo
    // within 60 s and produce either a snapshot or a visible loadError.
    const readsBefore = mockRepo.calls.filter(
      c => c.dep === 'listActivityShots',
    ).length;
    const second = store.getState().refresh();
    const status = await settled(second);
    const readsAfter = mockRepo.calls.filter(
      c => c.dep === 'listActivityShots',
    ).length;
    expect({ status, newReads: readsAfter - readsBefore }).toEqual({
      status: 'resolved',
      newReads: 1,
    });
    const state = store.getState();
    expect(state.snapshot !== null || state.loadError).toBe(true);
  });

  it('a hung ledger read inside recordDrillCompletion does not hang the drill flow', async () => {
    seedThreeDayHistory();
    const { store } = loadStore();
    mockRepo.arm('getKv', { kind: 'never' });
    expect(await settled(store.getState().recordDrillCompletion(DRILL))).toBe(
      'resolved',
    );
  });

  it('a hung history read surfaces as loadError (retry control) within 60 s instead of an empty state', async () => {
    seedThreeDayHistory();
    const { store } = loadStore();
    mockRepo.arm('listActivityShots', { kind: 'never' });
    void store.getState().hydrate();
    await settled(new Promise(() => undefined), 60_000);
    const state = store.getState();
    // Either the data or a visible failure — never "nothing" after a minute.
    expect(state.snapshot !== null || state.loadError).toBe(true);
  });
});

describe("F5 — previous account's snapshot shown under the new account", () => {
  const OWNER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const SIGNED_OUT = 'signed-out';

  async function signInAsBWith(
    fault: Parameters<FaultRepository['arm']>[1],
  ): Promise<{
    store: StoreModule['useConsistencyStore'];
    snapshotA: unknown;
  }> {
    seedThreeDayHistory();
    seedLedger({ celebrated: { 'streak.1': 'x', 'streak.3': 'x' } });
    const { store, setOwner } = loadStore();
    expect(await settled(store.getState().hydrate())).toBe('resolved');
    const snapshotA = store.getState().snapshot;
    expect(snapshotA?.currentStreak).toBe(3);

    // Real path: authStore signs out (owner → signed-out; App.tsx hands the
    // hook ownerKey=null, which hydrates nothing), then B signs in.
    setOwner(SIGNED_OUT);
    await jest.advanceTimersByTimeAsync(2_000);
    setOwner(OWNER_B);
    mockRepo.arm('listActivityShots', fault);
    void store.getState().hydrate();
    await settled(new Promise(() => undefined), 60_000);
    return { store, snapshotA };
  }

  for (const fault of [
    { kind: 'reject' as const },
    { kind: 'throw' as const },
    { kind: 'never' as const },
  ]) {
    it(`does not present account A's streak as account B's when B's first history read ${fault.kind}s`, async () => {
      const { store, snapshotA } = await signInAsBWith(fault);
      const state = store.getState();
      expect(state.ownerKey).toBe(OWNER_B);
      // Either B's data, or nothing (with the error card) — never A's.
      expect(state.snapshot === null || state.snapshot !== snapshotA).toBe(
        true,
      );
    });
  }

  it("signing out clears the signed-out process of the previous account's snapshot", async () => {
    seedThreeDayHistory();
    seedLedger({ celebrated: { 'streak.1': 'x', 'streak.3': 'x' } });
    const { store, setOwner } = loadStore();
    expect(await settled(store.getState().hydrate())).toBe('resolved');
    setOwner(SIGNED_OUT);
    await jest.advanceTimersByTimeAsync(2_000);
    // Nothing in the module reacts to the owner becoming signed-out unless a
    // refresh happens to run; the snapshot of the signed-out account stays.
    expect(store.getState().snapshot).toBeNull();
  });
});

describe('F4 — a failed drill write is swallowed silently (documented; P3)', () => {
  it('records the observed contract: no loadError, drill absent from snapshot and disk', async () => {
    seedThreeDayHistory();
    seedLedger({ celebrated: { 'streak.1': 'x', 'streak.3': 'x' } });
    const { store } = loadStore();
    mockRepo.arm('setKv', { kind: 'reject' });
    expect(await settled(store.getState().recordDrillCompletion(DRILL))).toBe(
      'resolved',
    );
    const state = store.getState();
    expect(persistedLedger().drills).toEqual([]);
    expect(state.snapshot?.days['2026-04-19']?.drillCount ?? 0).toBe(0);
    // This is the swallow store.ts documents; the lens asks for a visible
    // signal. Recorded as HELD-by-contract / P3 rather than asserted red.
    expect(state.loadError).toBe(false);
  });
});
