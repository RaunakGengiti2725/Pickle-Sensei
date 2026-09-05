/**
 * STRESS / failure-injection — `useRankCelebrationStore.maybeCelebrate`
 * (src/progress/rankCelebration.ts) against a faulting SQLite key-value
 * store, hostile persisted records, mid-flight owner switches, walkthrough
 * gating and concurrent reports.
 *
 * Each seed is a short random script: 2–7 steps drawn from {report a rank,
 * dismiss the ceremony, show/hide the walkthrough, switch the active data
 * owner}. Every KV read/write the store performs during the script can be
 * faulted independently: throw synchronously, reject, resolve slowly (1–30s
 * of fake time), never resolve, or (reads) return a malformed record —
 * garbage JSON, arrays, unknown tiers, string/NaN/huge ratings.
 *
 * Oracle:
 *   P1 every `maybeCelebrate` settles within 60s of fake time. When a fault
 *      never resolves this is expected to fail for that report — and the
 *      table records how many LATER reports (with a healthy store) it also
 *      took down, since the store serializes through one promise chain;
 *   P2 no report rejects (the store swallows storage faults by contract);
 *   P3 the persisted record, when present, is well-formed and describes a
 *      summary that was actually reported while that owner was active;
 *   P4 every ceremony raised is a placement or a strictly upward move whose
 *      summary was reported and whose `from` state was a persisted record;
 *   P5 no duplicate ceremony: the same target tier celebrates again only
 *      after the record moved below it;
 *   P6 persist-before-show: at the moment a ceremony is raised the record
 *      for its summary is already durable;
 *   P7 no ceremony is raised while the walkthrough is visible;
 *   P8 owner isolation: a record for owner X is only ever written while X
 *      is the active owner (covers the owner switch between read and write).
 */
import type { PlayerRankSummary } from '@pickle/shared-types';
import {
  PLAYER_RANK_TIERS,
  playerRankDivisionForRating,
} from '@pickle/shared-types';
import {
  chance,
  fail,
  int,
  mulberry32,
  pick,
  planCampaign,
  StressTable,
  type Rng,
} from '../../test-support/stress/seededStress';

type ReadFault =
  'ok' | 'throw-sync' | 'reject' | 'slow' | 'never' | 'malformed';
type WriteFault =
  'ok' | 'throw-sync' | 'reject' | 'slow' | 'never' | 'write-then-reject';

// Weighted draws. `never` is rare on purpose: one hung op wedges the store's
// promise chain for the rest of the seed, which would otherwise mask every
// other fault in the script.
const READ_FAULTS: readonly ReadFault[] = [
  ...Array<ReadFault>(10).fill('ok'),
  'throw-sync',
  'throw-sync',
  'reject',
  'reject',
  'slow',
  'slow',
  'malformed',
  'malformed',
  'malformed',
  'never',
];
const WRITE_FAULTS: readonly WriteFault[] = [
  ...Array<WriteFault>(10).fill('ok'),
  'throw-sync',
  'throw-sync',
  'reject',
  'reject',
  'slow',
  'slow',
  'write-then-reject',
  'write-then-reject',
  'never',
];

const MALFORMED_RECORDS = [
  'not json',
  '[]',
  '[{"tier":"gold","rating":5}]',
  '{"tier":"mythic","rating":5}',
  '{"tier":"gold","rating":"5"}',
  '{"tier":"gold","rating":null}',
  '{"tier":"gold"}',
  '{"rating":5}',
  '{"tier":5,"rating":5}',
  '{"tier":"gold","rating":1e308}',
  '{"tier":"gold","rating":-5}',
  '{"tier":"gold","rating":99}',
  '{"version":2,"tier":"gold","rating":5}',
  '0',
  '""',
  'null',
  '{}',
];

interface DbEvent {
  op: 'read' | 'write';
  key: string;
  fault: ReadFault | WriteFault;
  ownerAtCall: string;
  value?: string;
}

/**
 * The faulting KV store the mocked `getDb()` returns. Fault dispositions are
 * queued per op kind by the scenario; the store consumes them in call order,
 * falling back to `ok` when the queue runs dry.
 */
const mockDbState = {
  table: new Map<string, string>(),
  readFaults: [] as ReadFault[],
  writeFaults: [] as WriteFault[],
  slowMs: 5_000,
  malformedIndex: 0,
  events: [] as DbEvent[],
  activeOwner: () => 'signed-out',
  execute(sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
    const key = String(params[0]);
    if (sql.startsWith('SELECT value FROM kv')) {
      const fault = this.readFaults.shift() ?? 'ok';
      this.events.push({
        op: 'read',
        key,
        fault,
        ownerAtCall: this.activeOwner(),
      });
      switch (fault) {
        case 'throw-sync':
          throw new Error('SQLITE_IOERR: disk I/O error');
        case 'reject':
          return Promise.reject(new Error('SQLITE_BUSY: database is locked'));
        case 'never':
          return new Promise(() => {});
        case 'malformed': {
          const value =
            MALFORMED_RECORDS[this.malformedIndex % MALFORMED_RECORDS.length]!;
          this.malformedIndex += 1;
          return Promise.resolve({ rows: [{ value }] });
        }
        case 'slow':
        case 'ok': {
          const value = this.table.get(key);
          const result = { rows: value === undefined ? [] : [{ value }] };
          if (fault === 'ok') return Promise.resolve(result);
          return new Promise(resolve =>
            setTimeout(() => resolve(result), this.slowMs),
          );
        }
      }
    }
    if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
      const fault = this.writeFaults.shift() ?? 'ok';
      const value = String(params[1]);
      this.events.push({
        op: 'write',
        key,
        fault,
        value,
        ownerAtCall: this.activeOwner(),
      });
      switch (fault) {
        case 'throw-sync':
          throw new Error('SQLITE_FULL: database or disk is full');
        case 'reject':
          return Promise.reject(new Error('SQLITE_READONLY'));
        case 'never':
          return new Promise(() => {});
        case 'write-then-reject':
          this.table.set(key, value);
          return Promise.reject(new Error('SQLITE_IOERR after commit'));
        case 'slow':
          return new Promise(resolve =>
            setTimeout(() => {
              this.table.set(key, value);
              resolve({ rows: [] });
            }, this.slowMs),
          );
        case 'ok':
          this.table.set(key, value);
          return Promise.resolve({ rows: [] });
      }
    }
    return Promise.resolve({ rows: [] });
  },
};

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    execute: (sql: string, params: unknown[] = []) =>
      mockDbState.execute(sql, params),
    close() {},
  }),
}));

type RankCelebrationModule =
  typeof import('../../src/progress/rankCelebration');
type WalkthroughModule =
  typeof import('../../src/walkthrough/walkthroughStore');
type AccountScopeModule = typeof import('../../src/data/accountScope');

interface Modules {
  celebration: RankCelebrationModule;
  walkthrough: WalkthroughModule;
  scope: AccountScopeModule;
}

/** Fresh module instances per seed: the store's promise chain is module
 * state, so a hung seed must not poison the next one. */
function freshModules(): Modules {
  let modules!: Modules;
  jest.isolateModules(() => {
    modules = {
      celebration: jest.requireActual<Modules['celebration']>(
        '../../src/progress/rankCelebration',
      ),
      walkthrough: jest.requireActual<Modules['walkthrough']>(
        '../../src/walkthrough/walkthroughStore',
      ),
      scope: jest.requireActual<Modules['scope']>(
        '../../src/data/accountScope',
      ),
    };
  });
  return modules;
}

const OWNERS = [
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
  'device-guest',
];

const TIER_KEYS = PLAYER_RANK_TIERS.map(tier => tier.key);

function tierIndex(tier: string): number {
  return TIER_KEYS.indexOf(tier as (typeof TIER_KEYS)[number]);
}

function summaryFor(rng: Rng): PlayerRankSummary {
  const tier = pick(rng, PLAYER_RANK_TIERS);
  const next = PLAYER_RANK_TIERS[tierIndex(tier.key) + 1] ?? null;
  const ceiling = next ? next.minRating : 10;
  const rating =
    Math.round(
      (tier.minRating + rng() * (ceiling - tier.minRating - 0.01)) * 100,
    ) / 100;
  const { division, label: divisionLabel } =
    playerRankDivisionForRating(rating);
  return {
    rating,
    tier: tier.key,
    tierLabel: tier.label,
    division,
    divisionLabel,
    techniqueCount: int(rng, 1, 4),
    scoredAnalysisCount: int(rng, 1, 40),
    techniques: [],
    nextTier: next
      ? {
          key: next.key,
          label: next.label,
          minRating: next.minRating,
          pointsNeeded: Math.round((next.minRating - rating) * 100) / 100,
        }
      : null,
  };
}

type Step =
  | { kind: 'report'; summary: PlayerRankSummary; await: boolean }
  | { kind: 'dismiss' }
  | { kind: 'walkthrough'; visible: boolean }
  | { kind: 'owner'; owner: string }
  | { kind: 'advance'; ms: number };

interface Scenario {
  seed: number;
  initialOwner: string;
  initialRecord: string | null;
  readFaults: ReadFault[];
  writeFaults: WriteFault[];
  slowMs: number;
  steps: Step[];
}

function scenarioFor(seed: number): Scenario {
  const rng = mulberry32(seed);
  const initialOwner = chance(rng, 0.1) ? 'signed-out' : pick(rng, OWNERS);
  let initialRecord: string | null = null;
  const roll = rng();
  if (roll < 0.45) {
    const tier = pick(rng, PLAYER_RANK_TIERS);
    initialRecord = JSON.stringify({
      version: 1,
      tier: tier.key,
      rating: Math.round((tier.minRating + rng()) * 100) / 100,
    });
  } else if (roll < 0.7) {
    initialRecord = pick(rng, MALFORMED_RECORDS);
  }
  const stepCount = int(rng, 2, 7);
  const steps: Step[] = [];
  for (let i = 0; i < stepCount; i += 1) {
    const kind = rng();
    if (kind < 0.55) {
      steps.push({
        kind: 'report',
        summary: summaryFor(rng),
        await: chance(rng, 0.65),
      });
    } else if (kind < 0.7) {
      steps.push({ kind: 'dismiss' });
    } else if (kind < 0.82) {
      steps.push({ kind: 'walkthrough', visible: chance(rng, 0.5) });
    } else if (kind < 0.9) {
      steps.push({
        kind: 'owner',
        owner: pick(rng, [...OWNERS, 'signed-out']),
      });
    } else {
      steps.push({ kind: 'advance', ms: int(rng, 0, 40_000) });
    }
  }
  const readFaults: ReadFault[] = [];
  const writeFaults: WriteFault[] = [];
  for (let i = 0; i < stepCount; i += 1) {
    readFaults.push(pick(rng, READ_FAULTS));
    writeFaults.push(pick(rng, WRITE_FAULTS));
  }
  return {
    seed,
    initialOwner,
    initialRecord,
    readFaults,
    writeFaults,
    slowMs: int(rng, 1_000, 30_000),
    steps,
  };
}

interface CeremonyEvent {
  toTier: string;
  fromTier: string | null;
  fromRating: number | null;
  summary: PlayerRankSummary;
  owner: string;
  walkthroughVisible: boolean;
  /** KV value for the owner's key at the instant the ceremony was raised. */
  durableAtRaise: string | undefined;
  /** How many db events had happened when the ceremony was raised. */
  eventIndex: number;
}

function parseRecord(raw: string | undefined | null) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record['tier'] !== 'string' || tierIndex(record['tier']) < 0) {
      return null;
    }
    if (
      typeof record['rating'] !== 'number' ||
      !Number.isFinite(record['rating'])
    ) {
      return null;
    }
    return { tier: record['tier'], rating: record['rating'] };
  } catch {
    return null;
  }
}

const CAMPAIGN = 'progressRankCelebrationFaults';
const plan = planCampaign(CAMPAIGN, 21_000, 40);
const table = new StressTable(CAMPAIGN, plan);

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

afterAll(() => {
  const path = table.write();

  console.log(
    `[${CAMPAIGN}] executed=${table.rows.length} broken=${table.broken.length} → ${path}`,
  );
});

async function runSeed(seed: number) {
  const scenario = scenarioFor(seed);
  const failures: string[] = [];
  const modules = freshModules();
  const { celebration, walkthrough, scope } = modules;
  const { useRankCelebrationStore, rankCelebrationKeyForOwner } = celebration;

  mockDbState.table = new Map();
  mockDbState.readFaults = [...scenario.readFaults];
  mockDbState.writeFaults = [...scenario.writeFaults];
  mockDbState.slowMs = scenario.slowMs;
  mockDbState.malformedIndex = seed % MALFORMED_RECORDS.length;
  mockDbState.events = [];
  mockDbState.activeOwner = () => scope.getActiveDataOwner();

  scope.setActiveDataOwner(scenario.initialOwner);
  if (
    scenario.initialRecord !== null &&
    scenario.initialOwner !== 'signed-out'
  ) {
    mockDbState.table.set(
      rankCelebrationKeyForOwner(scenario.initialOwner),
      scenario.initialRecord,
    );
  }

  // Everything reported, keyed by the owner active at report time.
  const reportedByOwner = new Map<string, PlayerRankSummary[]>();
  const ceremonies: CeremonyEvent[] = [];
  const unsubscribe = useRankCelebrationStore.subscribe((state, previous) => {
    if (state.current && state.current !== previous.current) {
      const owner = scope.getActiveDataOwner();
      ceremonies.push({
        toTier: state.current.toTier,
        fromTier: state.current.fromTier,
        fromRating: state.current.fromRating,
        summary: state.current.summary,
        owner,
        walkthroughVisible: walkthrough.useWalkthroughStore.getState().visible,
        durableAtRaise: mockDbState.table.get(
          rankCelebrationKeyForOwner(owner),
        ),
        eventIndex: mockDbState.events.length,
      });
    }
  });

  const pending: Array<{
    index: number;
    settled: 'pending' | 'resolved' | 'rejected';
    error?: unknown;
  }> = [];
  const track = (index: number, promise: Promise<void>) => {
    const entry: (typeof pending)[number] = { index, settled: 'pending' };
    pending.push(entry);
    promise.then(
      () => {
        entry.settled = 'resolved';
      },
      error => {
        entry.settled = 'rejected';
        entry.error = error;
      },
    );
  };

  let neverInjected = false;
  for (const [index, step] of scenario.steps.entries()) {
    switch (step.kind) {
      case 'report': {
        const owner = scope.getActiveDataOwner();
        const list = reportedByOwner.get(owner) ?? [];
        list.push(step.summary);
        reportedByOwner.set(owner, list);
        const promise = useRankCelebrationStore
          .getState()
          .maybeCelebrate(step.summary);
        track(index, promise);
        if (step.await) {
          await jest.advanceTimersByTimeAsync(scenario.slowMs + 1);
        } else {
          await Promise.resolve();
        }
        break;
      }
      case 'dismiss':
        useRankCelebrationStore.getState().dismiss();
        break;
      case 'walkthrough':
        walkthrough.useWalkthroughStore.setState({
          visible: step.visible,
          queued: false,
        });
        break;
      case 'owner':
        scope.setActiveDataOwner(step.owner);
        break;
      case 'advance':
        await jest.advanceTimersByTimeAsync(step.ms);
        break;
    }
  }
  await jest.advanceTimersByTimeAsync(60_000);
  await Promise.resolve();
  unsubscribe();

  const events = mockDbState.events;
  neverInjected = events.some(event => event.fault === 'never');
  const firstNever = events.findIndex(event => event.fault === 'never');

  // P1 / P2
  const notes: string[] = [];
  const stuck = pending.filter(entry => entry.settled === 'pending');
  const rejected = pending.filter(entry => entry.settled === 'rejected');
  if (rejected.length > 0) {
    failures.push(fail('P2-rejected', String(rejected[0]!.error)));
  }
  if (stuck.length > 0) {
    if (!neverInjected) {
      failures.push(
        fail(
          'P1-hang',
          `${stuck.length} report(s) pending with no never-fault`,
        ),
      );
    } else if (stuck.length > 1) {
      // The report awaiting the hung op cannot settle — that is the injected
      // fault. Every LATER report hanging too is the store's own doing.
      failures.push(
        fail(
          'P1-queue-hang',
          `${stuck.length - 1} later report(s) with a healthy store never settled behind a never-resolving KV op (db event #${firstNever})`,
        ),
      );
    } else {
      notes.push(
        `own report hung on injected never-op (db event #${firstNever})`,
      );
    }
  }

  // P3: persisted records are well-formed and were actually reported.
  for (const [key, value] of mockDbState.table) {
    const owner = key.slice('rank.celebrated:'.length);
    const wasInitial =
      owner === scenario.initialOwner && value === scenario.initialRecord;
    if (wasInitial) continue;
    const record = parseRecord(value);
    if (!record) {
      failures.push(fail('P3-corrupt-record', `${key}=${value}`));
      continue;
    }
    const reported = reportedByOwner.get(owner) ?? [];
    if (
      !reported.some(s => s.tier === record.tier && s.rating === record.rating)
    ) {
      failures.push(fail('P3-unreported-record', `${key}=${value}`));
    }
  }

  // P8: writes only under the active owner's key.
  for (const event of events) {
    if (event.op !== 'write') continue;
    if (event.key !== `rank.celebrated:${event.ownerAtCall}`) {
      failures.push(
        fail(
          'P8-owner-leak',
          `${event.key} written while ${event.ownerAtCall} active`,
        ),
      );
    }
    if (event.ownerAtCall === 'signed-out') {
      failures.push(fail('P8-signed-out-write', event.key));
    }
  }

  // P4–P7 over raised ceremonies.
  // Records the store could legitimately have read: the initial one, every
  // write that reached the table, and every injected malformed read (the
  // store may accept some of those — e.g. a finite rating outside [0,10]).
  const persistedRecords = new Set<string>();
  if (scenario.initialRecord) persistedRecords.add(scenario.initialRecord);
  let malformedCursor = seed % MALFORMED_RECORDS.length;
  for (const event of events) {
    if (event.op === 'read' && event.fault === 'malformed') {
      persistedRecords.add(
        MALFORMED_RECORDS[malformedCursor % MALFORMED_RECORDS.length]!,
      );
      malformedCursor += 1;
    }
    if (
      event.op === 'write' &&
      event.fault !== 'never' &&
      event.fault !== 'throw-sync' &&
      event.fault !== 'reject'
    ) {
      persistedRecords.add(event.value!);
    }
  }
  const raisedByOwnerTier = new Map<string, number>();
  for (const [index, ceremony] of ceremonies.entries()) {
    const to = tierIndex(ceremony.toTier);
    if (to < 0) failures.push(fail('P4-unknown-tier', ceremony.toTier));
    if (ceremony.fromTier !== null && tierIndex(ceremony.fromTier) >= to) {
      failures.push(
        fail('P4-not-upward', `${ceremony.fromTier}→${ceremony.toTier}`),
      );
    }
    const reported = reportedByOwner.get(ceremony.owner) ?? [];
    if (!reported.includes(ceremony.summary)) {
      failures.push(
        fail(
          'P4-unreported-summary',
          `${ceremony.toTier} ${ceremony.summary.rating}`,
        ),
      );
    }
    if (ceremony.fromTier !== null) {
      const fromMatches = [...persistedRecords].some(raw => {
        const record = parseRecord(raw);
        return (
          record &&
          record.tier === ceremony.fromTier &&
          record.rating === ceremony.fromRating
        );
      });
      if (!fromMatches) {
        failures.push(
          fail(
            'P4-from-not-persisted',
            `${ceremony.fromTier}@${ceremony.fromRating}`,
          ),
        );
      }
      if (
        ceremony.fromRating !== null &&
        (ceremony.fromRating < 0 || ceremony.fromRating > 10)
      ) {
        notes.push(
          `lenient stored rating ${ceremony.fromRating} accepted as count-up start`,
        );
      }
    }
    // P6: the summary's record reached the table before the ceremony was
    // raised. A ceremony raised while the table already moved on (a lower
    // rank landed while it sat in `pending`) is recorded as stale.
    const durableBefore = events.slice(0, ceremony.eventIndex).some(e => {
      if (
        e.op !== 'write' ||
        e.fault === 'never' ||
        e.fault === 'throw-sync' ||
        e.fault === 'reject'
      )
        return false;
      const record = parseRecord(e.value);
      return (
        record !== null &&
        record.tier === ceremony.summary.tier &&
        record.rating === ceremony.summary.rating
      );
    });
    if (!durableBefore) {
      failures.push(
        fail(
          'P6-shown-before-persisted',
          `${ceremony.toTier} raised with kv=${ceremony.durableAtRaise}`,
        ),
      );
    }
    const durable = parseRecord(ceremony.durableAtRaise);
    if (
      durable &&
      (durable.tier !== ceremony.summary.tier ||
        durable.rating !== ceremony.summary.rating)
    ) {
      failures.push(
        fail(
          'P6-stale-pending',
          `${ceremony.toTier}@${ceremony.summary.rating} shown while record is ${durable.tier}@${durable.rating}`,
        ),
      );
    }
    // P7
    if (ceremony.walkthroughVisible) {
      failures.push(fail('P7-over-walkthrough', ceremony.toTier));
    }
    // P5: same owner+tier twice requires an intervening downward record.
    const key = `${ceremony.owner}:${ceremony.toTier}`;
    const previousIndex = raisedByOwnerTier.get(key);
    if (previousIndex !== undefined) {
      const previous = ceremonies[previousIndex]!;
      const writesBetween = events
        .slice(previous.eventIndex, ceremony.eventIndex)
        .filter(
          e =>
            e.op === 'write' && e.key === `rank.celebrated:${ceremony.owner}`,
        );
      const movedLower = writesBetween.some(e => {
        const record = parseRecord(e.value);
        return record !== null && tierIndex(record.tier) < to;
      });
      if (!movedLower) {
        failures.push(fail('P5-duplicate-ceremony', ceremony.toTier));
      }
    }
    raisedByOwnerTier.set(key, index);
  }

  const detail = {
    initialOwner: scenario.initialOwner,
    initialRecord: scenario.initialRecord,
    steps: scenario.steps.map(step =>
      step.kind === 'report'
        ? `report:${step.summary.tier}@${step.summary.rating}${step.await ? '' : ':fire'}`
        : step.kind === 'walkthrough'
          ? `walkthrough:${step.visible}`
          : step.kind === 'owner'
            ? `owner:${step.owner}`
            : step.kind === 'advance'
              ? `advance:${step.ms}`
              : 'dismiss',
    ),
    dbEvents: events.map(e => `${e.op}:${e.fault}`),
    slowMs: scenario.slowMs,
    ceremonies: ceremonies.map(c => `${c.fromTier ?? '∅'}→${c.toTier}`),
    reports: pending.length,
    stuck: stuck.length,
    finalKv: Object.fromEntries(mockDbState.table),
    ...(notes.length > 0 ? { notes } : {}),
  };
  const faultLabel =
    [
      ...new Set(events.map(e => `${e.op}=${e.fault}`)),
      ...(scenario.initialRecord && !parseRecord(scenario.initialRecord)
        ? ['initial=malformed']
        : []),
    ].join('+') || 'no-db-op';
  return table.record(seed, faultLabel, failures, detail);
}

describe(`${CAMPAIGN}: SQLite/KV faults into the rank ceremony store`, () => {
  it.each(plan.seeds)('seed %i', async seed => {
    const row = await runSeed(seed);
    if (row.outcome === 'broken') {
      console.log(
        `[${CAMPAIGN}] seed=${seed} BROKEN ${row.failures.join(' | ')}`,
      );
    }
    expect({ seed, fault: row.fault, failures: row.failures }).toEqual({
      seed,
      fault: row.fault,
      failures: [],
    });
  });
});

describe(`${CAMPAIGN}: minimized repro`, () => {
  it('one KV read that never resolves must not block later reports with a healthy store', async () => {
    const { celebration, scope } = freshModules();
    mockDbState.table = new Map();
    mockDbState.readFaults = ['never'];
    mockDbState.writeFaults = [];
    mockDbState.events = [];
    mockDbState.activeOwner = () => scope.getActiveDataOwner();
    scope.setActiveDataOwner(OWNERS[0]!);
    const rng = mulberry32(1);
    const first = summaryFor(rng);
    const second = summaryFor(rng);

    let firstSettled = false;
    let secondSettled = false;
    void celebration.useRankCelebrationStore
      .getState()
      .maybeCelebrate(first)
      .then(() => {
        firstSettled = true;
      });
    await Promise.resolve();
    void celebration.useRankCelebrationStore
      .getState()
      .maybeCelebrate(second)
      .then(() => {
        secondSettled = true;
      });
    await jest.advanceTimersByTimeAsync(60_000);
    await Promise.resolve();

    expect(firstSettled).toBe(false); // the hung read is the injected fault
    // The second report used a healthy store (only one read fault queued) —
    // it must settle and persist its record within 60s.
    expect({ secondSettled, kv: [...mockDbState.table.keys()] }).toEqual({
      secondSettled: true,
      kv: [celebration.rankCelebrationKeyForOwner(OWNERS[0]!)],
    });
  });

  // Seed 21027 (P6): a promotion earned while the walkthrough is showing is
  // parked as `pending`; a later report that moves the durable record DOWN
  // does not clear it, so dismissing the tour celebrates a tier the record no
  // longer holds. Healthy store throughout.
  it('a pending ceremony must not outlive a downward record change', async () => {
    const { celebration, walkthrough, scope } = freshModules();
    mockDbState.table = new Map();
    mockDbState.readFaults = [];
    mockDbState.writeFaults = [];
    mockDbState.events = [];
    mockDbState.activeOwner = () => scope.getActiveDataOwner();
    scope.setActiveDataOwner(OWNERS[0]!);
    const key = celebration.rankCelebrationKeyForOwner(OWNERS[0]!);
    mockDbState.table.set(
      key,
      JSON.stringify({ version: 1, tier: 'silver', rating: 4.5 }),
    );

    const summaryAt = (tierKey: string, rating: number): PlayerRankSummary => {
      const tier = PLAYER_RANK_TIERS.find(t => t.key === tierKey)!;
      const next = PLAYER_RANK_TIERS[tierIndex(tier.key) + 1] ?? null;
      const { division, label: divisionLabel } =
        playerRankDivisionForRating(rating);
      return {
        rating,
        tier: tier.key,
        tierLabel: tier.label,
        division,
        divisionLabel,
        techniqueCount: 2,
        scoredAnalysisCount: 12,
        techniques: [],
        nextTier: next
          ? {
              key: next.key,
              label: next.label,
              minRating: next.minRating,
              pointsNeeded: Math.round((next.minRating - rating) * 100) / 100,
            }
          : null,
      };
    };

    walkthrough.useWalkthroughStore.setState({ visible: true, queued: false });
    await celebration.useRankCelebrationStore
      .getState()
      .maybeCelebrate(summaryAt('diamond', 8));
    await celebration.useRankCelebrationStore
      .getState()
      .maybeCelebrate(summaryAt('silver', 4.83));
    walkthrough.useWalkthroughStore.setState({ visible: false, queued: false });
    await jest.advanceTimersByTimeAsync(1_000);

    const state = celebration.useRankCelebrationStore.getState();
    expect({
      record: JSON.parse(mockDbState.table.get(key)!).tier,
      shown: state.current?.toTier ?? null,
      pending: state.pending?.toTier ?? null,
    }).toEqual({ record: 'silver', shown: null, pending: null });
  });
});
