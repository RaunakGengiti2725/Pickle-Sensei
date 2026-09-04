/**
 * STRESS — consistency store under the CONCURRENCY lens.
 *
 * The real `useConsistencyStore` (zustand) runs over an in-memory SQLite
 * stand-in whose every read/write parks on a SEEDED SCHEDULER: the driver
 * releases parked operations one at a time in a seed-determined order, so
 * each iteration is one exact interleaving of
 *
 *   refresh × N (duplicate calls, call-during-call, foreground bursts)
 *   hydrate
 *   recordDrillCompletion (same id twice, distinct ids in flight together)
 *   consumeDaySecured / dismissCelebration at arbitrary points
 *   owner rotation A → B → A and logout (SIGNED_OUT) mid-request
 *   device clock jumps (fake Date) and device time-zone changes
 *   injected activity-read failures (loadError path)
 *
 * and every iteration is replayable from `seed`. Invariants checked:
 *   no deadlock (bounded scheduler steps + wall time), ledger has no
 *   duplicate drill rows, no lost drill (every completion recorded while the
 *   owner was stable is in the ledger), one ceremony per milestone per owner
 *   (durable-before-shown), "Day N secured" surfaces once per day, state at
 *   quiescence equals a fresh engine replay of the owner's facts, no
 *   cross-owner snapshot/celebration at quiescence, signed-out ⇒ empty.
 *
 * Results: artifacts/stress/consistency-store-concurrency.json (STRESS_OUT
 * overrides the directory, STRESS_ITER scales the campaign).
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

/** Seeded scheduler: async I/O parks here until the driver releases it. */
const mockSched = {
  pending: [] as Array<{ label: string; release: () => void }>,
  releases: 0,
  faultOwners: new Set<string>(),
  activeOwner: (): string => 'unset',
  park(label: string): Promise<void> {
    return new Promise<void>(resolve => {
      mockSched.pending.push({ label, release: resolve });
    });
  },
};
const realNow: () => number = Date.now.bind(Date);

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
  buildConsistencySnapshot,
  type ConsistencySnapshot,
  type TrainingActivityInput,
} from '../../src/consistency/engine';
import {
  consistencyKeyForOwner,
  parseConsistencyLedger,
  useConsistencyStore,
  type ConsistencyDrillRecord,
} from '../../src/consistency/store';

const { setActiveDataOwner, SIGNED_OUT_DATA_OWNER } = accountScope;
mockSched.activeOwner = accountScope.getActiveDataOwner;

declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

const OUT_DIR =
  process.env.STRESS_OUT ?? join(__dirname, '..', '..', 'artifacts', 'stress');
const ITERATIONS = Math.max(
  1,
  Number.parseInt(process.env.STRESS_ITER ?? '', 10) || 60,
);
/** Replay: STRESS_SEEDS=2,14,47 runs exactly those seeds instead of 1..N. */
const SEEDS: number[] = (process.env.STRESS_SEEDS ?? '')
  .split(',')
  .map(s => Number.parseInt(s.trim(), 10))
  .filter(n => Number.isInteger(n) && n > 0);
if (SEEDS.length === 0) {
  for (let seed = 1; seed <= ITERATIONS; seed += 1) SEEDS.push(seed);
}
const MAX_STEPS = 5_000;
const MAX_IDLE_FLUSHES = 50;
const MAX_WALL_MS_PER_SEED = 4_000;

const OWNER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ZONES = [
  'UTC',
  'America/New_York',
  'Asia/Kolkata',
  'Pacific/Chatham',
  'Pacific/Kiritimati',
  'Australia/Lord_Howe',
  'Pacific/Pago_Pago',
] as const;
const DAY = 86_400_000;

// ─── Seeded PRNG ────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rng = () => number;
const pick = <T>(rng: Rng, items: readonly T[]): T =>
  items[Math.floor(rng() * items.length)]!;
const int = (rng: Rng, lo: number, hi: number): number =>
  lo + Math.floor(rng() * (hi - lo + 1));

// ─── Device time-zone shim ──────────────────────────────────────────────────
// `deviceTimeZone()` reads `Intl.DateTimeFormat().resolvedOptions().timeZone`;
// TZ cannot be switched inside a jest worker, so calls WITHOUT an explicit
// timeZone are given the scenario's zone. Calls that pass one (the engine)
// are untouched.

const RealDTF = Intl.DateTimeFormat;
let deviceZone = 'UTC';
let dtfSpy: jest.SpyInstance | null = null;
function installZoneShim(): void {
  dtfSpy = jest
    .spyOn(Intl, 'DateTimeFormat')
    .mockImplementation(
      ((locales?: string | string[], options?: Intl.DateTimeFormatOptions) =>
        new RealDTF(
          locales,
          options?.timeZone ? options : { ...options, timeZone: deviceZone },
        )) as never,
    );
}
function removeZoneShim(): void {
  dtfSpy?.mockRestore();
  dtfSpy = null;
}

// ─── Scenario ───────────────────────────────────────────────────────────────

function shotsFor(
  owner: string,
  rng: Rng,
  nowMs: number,
  streakDays: number,
  shotType: string,
  trainedToday: boolean,
): ShotRow[] {
  const rows: ShotRow[] = [];
  let n = 0;
  for (let d = trainedToday ? 0 : 1; d <= streakDays; d += 1) {
    const perDay = int(rng, 1, 3);
    for (let i = 0; i < perDay; i += 1) {
      // Local-noon-ish anchoring is not possible without the zone; keep
      // instants strictly inside the day by offsetting a few hours from now.
      const ms = nowMs - d * DAY - int(rng, 0, 3 * 60 * 60_000) - 1_000;
      rows.push({
        id: `${owner.slice(0, 4)}-shot-${n}`,
        sessionId: rng() < 0.3 ? `${owner.slice(0, 4)}-session-${d}` : null,
        shotType,
        capturedAt: new Date(ms).toISOString(),
        overallScore: rng() < 0.8 ? int(rng, 30, 95) / 10 : null,
        resultKind: rng() < 0.8 ? 'scored' : 'low_confidence',
      });
      n += 1;
    }
  }
  return rows;
}

type Op =
  | { kind: 'refresh' }
  | { kind: 'hydrate' }
  | { kind: 'drill'; record: ConsistencyDrillRecord }
  | { kind: 'consume' }
  | { kind: 'dismiss' }
  | { kind: 'rotate'; owner: string }
  | { kind: 'clock'; deltaMs: number }
  | { kind: 'zone'; zone: string }
  | { kind: 'fault'; owner: string; on: boolean };

interface Scenario {
  seed: number;
  zone: string;
  startNowMs: number;
  ops: Op[];
}

const START_INSTANTS = [
  '2026-03-08T06:59:30.000Z', // NY spring-forward edge
  '2026-11-01T05:59:30.000Z', // NY fall-back edge
  '2026-04-05T15:59:30.000Z', // Lord Howe DST end
  '2026-01-01T00:00:10.000Z', // UTC year boundary just passed
  '2026-06-15T23:59:40.000Z', // seconds before a UTC day boundary
  '2026-06-15T12:00:00.000Z', // mid-day, quiet
  '2026-09-04T10:14:59.000Z', // Kiritimati just before local midnight
];

function makeScenario(seed: number): Scenario {
  const rng = mulberry32(seed);
  const zone = pick(rng, ZONES);
  const startNowMs = Date.parse(pick(rng, START_INSTANTS));
  const ops: Op[] = [];
  const count = int(rng, 6, 18);
  let drillN = 0;
  const drillIds = ['drill-x', 'drill-y', 'drill-z'];
  for (let i = 0; i < count; i += 1) {
    const r = rng();
    if (r < 0.26) ops.push({ kind: 'refresh' });
    else if (r < 0.36) ops.push({ kind: 'hydrate' });
    else if (r < 0.58) {
      // Same id reused often → idempotency; distinct ids → lost-update probe.
      const id = rng() < 0.5 ? pick(rng, drillIds) : `drill-${drillN++}`;
      ops.push({
        kind: 'drill',
        record: {
          id,
          slug: 'contact-shadow-reps',
          title: 'Contact Shadow Reps',
          completedAtIso: new Date(
            startNowMs - int(rng, 0, 30_000),
          ).toISOString(),
        },
      });
    } else if (r < 0.68) ops.push({ kind: 'consume' });
    else if (r < 0.74) ops.push({ kind: 'dismiss' });
    else if (r < 0.84) {
      ops.push({
        kind: 'rotate',
        owner: pick(rng, [OWNER_A, OWNER_B, SIGNED_OUT_DATA_OWNER]),
      });
    } else if (r < 0.9) {
      // Backwards and forwards jumps: seconds, an hour, a day, a week.
      ops.push({
        kind: 'clock',
        deltaMs: pick(rng, [-90_000, 45_000, 3_600_000, DAY, -DAY, 7 * DAY]),
      });
    } else if (r < 0.95) ops.push({ kind: 'zone', zone: pick(rng, ZONES) });
    else
      ops.push({
        kind: 'fault',
        owner: pick(rng, [OWNER_A, OWNER_B]),
        on: rng() < 0.6,
      });
  }
  return { seed, zone, startNowMs, ops };
}

// ─── Driver ─────────────────────────────────────────────────────────────────

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

interface Observed {
  celebrations: Array<{ owner: string | null; id: string }>;
  daySecuredArmed: Array<{ owner: string | null; day: string }>;
  consumedDays: string[];
  /** ticks where ownerKey ≠ active owner while a snapshot was visible. */
  staleOwnerTicks: number;
  /** ticks where the visible snapshot's technique belonged to another owner. */
  crossOwnerSnapshotTicks: number;
}

interface Row {
  seed: number;
  zone: string;
  ops: number;
  steps: number;
  wallMs: number;
  finalOwner: string;
  ledgerDrills: number;
  outcome: 'HELD' | 'BROKEN';
  problems: string[];
  trace?: string[];
  observations: Record<string, unknown>;
}

const rows: Row[] = [];

afterAll(() => {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    join(OUT_DIR, 'consistency-store-concurrency.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        iterations: ITERATIONS,
        executed: rows.length,
        broken: rows.filter(r => r.outcome === 'BROKEN').map(r => r.seed),
        problemHistogram: rows
          .flatMap(r => r.problems)
          .reduce<Record<string, number>>((acc, p) => {
            const key = p.split(':')[0]!;
            acc[key] = (acc[key] ?? 0) + 1;
            return acc;
          }, {}),
        rows,
      },
      null,
      2,
    ),
  );
});

function resetWorld(): void {
  mockKv.clear();
  mockShotsByOwner.clear();
  mockSched.pending.length = 0;
  mockSched.releases = 0;
  mockSched.faultOwners.clear();
  useConsistencyStore.setState({
    hydrated: false,
    ownerKey: null,
    snapshot: null,
    loadError: false,
    celebration: null,
    daySecured: null,
  });
}

const TECH: Record<string, string> = { [OWNER_A]: 'dink', [OWNER_B]: 'serve' };

async function runScenario(scenario: Scenario): Promise<Row> {
  resetWorld();
  const rng = mulberry32(scenario.seed ^ 0x51ed270b);
  const started = realNow();
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
    now: new Date(scenario.startNowMs),
  });
  deviceZone = scenario.zone;
  installZoneShim();

  // Owner A: a streak that crosses a milestone (3 or 7) so a ceremony and
  // the day-secured moment are both reachable; owner B: a shorter, distinct
  // history in a different technique so cross-owner leaks are detectable.
  const aStreak = pick(rng, [2, 3, 6, 7, 13]);
  const aTrainedToday = rng() < 0.5;
  mockShotsByOwner.set(
    OWNER_A,
    shotsFor(
      OWNER_A,
      rng,
      scenario.startNowMs,
      aStreak,
      TECH[OWNER_A]!,
      aTrainedToday,
    ),
  );
  mockShotsByOwner.set(
    OWNER_B,
    shotsFor(
      OWNER_B,
      rng,
      scenario.startNowMs,
      int(rng, 0, 4),
      TECH[OWNER_B]!,
      rng() < 0.5,
    ),
  );
  setActiveDataOwner(OWNER_A);

  const observed: Observed = {
    celebrations: [],
    daySecuredArmed: [],
    consumedDays: [],
    staleOwnerTicks: 0,
    crossOwnerSnapshotTicks: 0,
  };
  const unsubscribe = useConsistencyStore.subscribe((state, prev) => {
    if (
      state.celebration &&
      state.celebration.achievementId !== prev.celebration?.achievementId
    ) {
      observed.celebrations.push({
        owner: state.ownerKey,
        id: state.celebration.achievementId,
      });
    }
    if (state.daySecured && state.daySecured !== prev.daySecured) {
      observed.daySecuredArmed.push({
        owner: state.ownerKey,
        day: state.daySecured.day,
      });
    }
    if (
      state.snapshot &&
      state.ownerKey !== accountScope.getActiveDataOwner()
    ) {
      observed.staleOwnerTicks += 1;
    }
    if (state.snapshot && state.ownerKey && TECH[state.ownerKey]) {
      const foreign = Object.values(state.snapshot.days).some(day =>
        day.activities.some(
          a => a.kind !== 'drill' && a.label !== TECH[state.ownerKey!],
        ),
      );
      if (foreign) observed.crossOwnerSnapshotTicks += 1;
    }
  });

  // Drill completions whose call began AND ended under a stable owner must
  // be durable. Track (owner at start, owner at end, rotations during).
  let rotationEpoch = 0;
  const drillCalls: Array<{
    owner: string;
    id: string;
    epochStart: number;
    epochEnd: number;
  }> = [];
  const actors: Promise<unknown>[] = [];
  const consumedMoments: Array<{ day: string; owner: string }> = [];

  const launch = (op: Op) => {
    const store = useConsistencyStore.getState();
    switch (op.kind) {
      case 'refresh':
        actors.push(store.refresh());
        break;
      case 'hydrate':
        actors.push(store.hydrate());
        break;
      case 'drill': {
        const owner = accountScope.getActiveDataOwner();
        const entry = {
          owner,
          id: op.record.id,
          epochStart: rotationEpoch,
          epochEnd: -1,
        };
        drillCalls.push(entry);
        actors.push(
          store.recordDrillCompletion(op.record).then(() => {
            entry.epochEnd = rotationEpoch;
          }),
        );
        break;
      }
      case 'consume': {
        const owner = accountScope.getActiveDataOwner();
        const moment = store.consumeDaySecured();
        if (moment) {
          consumedMoments.push({ day: moment.day, owner });
          observed.consumedDays.push(moment.day);
        }
        break;
      }
      case 'dismiss':
        store.dismissCelebration();
        break;
      case 'rotate':
        if (accountScope.getActiveDataOwner() !== op.owner) {
          rotationEpoch += 1;
          setActiveDataOwner(op.owner);
          // App.tsx's bootstrap hook hydrates on every owner change.
          actors.push(useConsistencyStore.getState().hydrate());
        }
        break;
      case 'clock':
        jest.setSystemTime(new Date(Date.now() + op.deltaMs));
        break;
      case 'zone':
        deviceZone = op.zone;
        break;
      case 'fault':
        if (op.on) mockSched.faultOwners.add(op.owner);
        else mockSched.faultOwners.delete(op.owner);
        break;
    }
  };

  // Seeded interleaving: at each step either launch the next op or release
  // one parked I/O (chosen at random), so ops overlap in-flight I/O.
  let opIndex = 0;
  let steps = 0;
  let idle = 0;
  const problems: string[] = [];
  /** Exact interleaving: L:<op> launches, R:<io> releases. */
  const trace: string[] = [];
  const release = () => {
    const next = mockSched.pending.splice(
      int(rng, 0, mockSched.pending.length - 1),
      1,
    )[0]!;
    mockSched.releases += 1;
    trace.push(`R:${next.label}`);
    next.release();
  };
  let deadlocked = false;
  let settledCount = 0;
  const track = (p: Promise<unknown>) => {
    p.then(
      () => {
        settledCount += 1;
      },
      () => {
        settledCount += 1;
      },
    );
  };
  let tracked = 0;

  // Final foreground refresh with faults cleared so the oracle is exact.
  const finalOps: Op[] = [
    { kind: 'fault', owner: OWNER_A, on: false },
    { kind: 'fault', owner: OWNER_B, on: false },
    { kind: 'refresh' },
  ];
  const allOps = [...scenario.ops, ...finalOps];

  for (;;) {
    await flush();
    while (tracked < actors.length) {
      track(actors[tracked]!);
      tracked += 1;
    }
    steps += 1;
    if (steps > MAX_STEPS || realNow() - started > MAX_WALL_MS_PER_SEED) {
      deadlocked = true;
      break;
    }
    const canLaunch = opIndex < allOps.length;
    const canRelease = mockSched.pending.length > 0;
    // Hold the final ops until every earlier actor has settled so the
    // oracle compares against a quiescent store.
    const finalPhase = opIndex >= scenario.ops.length;
    const allSettled = settledCount === actors.length;
    if (finalPhase && !allSettled && !canRelease) {
      idle += 1;
      if (idle > MAX_IDLE_FLUSHES) {
        deadlocked = true;
        break;
      }
      continue;
    }
    if (finalPhase && !allSettled) {
      // Drain in-flight I/O before launching the closing refresh.
      release();
      continue;
    }
    if (!canLaunch && !canRelease) {
      if (allSettled) break;
      idle += 1;
      if (idle > MAX_IDLE_FLUSHES) {
        deadlocked = true;
        break;
      }
      continue;
    }
    idle = 0;
    if (canLaunch && (!canRelease || rng() < 0.45)) {
      const op = allOps[opIndex]!;
      trace.push(
        `L:${op.kind}${'record' in op ? `:${op.record.id}` : ''}${'owner' in op ? `:${op.owner.slice(0, 4)}` : ''}${'deltaMs' in op ? `:${op.deltaMs}` : ''}${'zone' in op ? `:${op.zone}` : ''}`,
      );
      launch(op);
      opIndex += 1;
    } else {
      release();
    }
  }
  await flush();
  unsubscribe();

  // ─── Oracle ───────────────────────────────────────────────────────────
  const finalOwner = accountScope.getActiveDataOwner();
  const state = useConsistencyStore.getState();
  if (deadlocked) {
    problems.push(
      `deadlock: ${settledCount}/${actors.length} actors settled after ${steps} steps, pending=${mockSched.pending.map(p => p.label).join(',')}`,
    );
  }

  for (const owner of [OWNER_A, OWNER_B]) {
    const ledger = parseConsistencyLedger(
      mockKv.get(consistencyKeyForOwner(owner)) ?? null,
    );
    const ids = ledger.drills.map(d => d.id);
    if (new Set(ids).size !== ids.length) {
      problems.push(
        `duplicate-drill-rows: owner ${owner.slice(0, 4)} ledger ${JSON.stringify(ids)}`,
      );
    }
    const stableCalls = drillCalls.filter(
      c => c.owner === owner && c.epochEnd === c.epochStart,
    );
    for (const call of stableCalls) {
      if (!ids.includes(call.id)) {
        problems.push(
          `lost-drill: owner ${owner.slice(0, 4)} completed ${call.id} under a stable owner but ledger has ${JSON.stringify(ids)}`,
        );
      }
    }
    // Every celebrated ceremony must be durable in the owner's ledger.
    for (const c of observed.celebrations) {
      if (c.owner === owner && !ledger.celebrated[c.id]) {
        problems.push(
          `celebration-not-durable: owner ${owner.slice(0, 4)} surfaced ${c.id} but ledger.celebrated=${JSON.stringify(ledger.celebrated)}`,
        );
      }
    }
  }

  const seenCeremony = new Set<string>();
  for (const c of observed.celebrations) {
    const key = `${c.owner}|${c.id}`;
    if (seenCeremony.has(key)) {
      problems.push(
        `double-ceremony: ${c.id} surfaced twice for owner ${String(c.owner).slice(0, 4)}`,
      );
    }
    seenCeremony.add(key);
  }

  // Day-secured: after a consumption for (owner, day), the moment for that
  // same (owner, day) must never be armed again.
  for (const consumed of consumedMoments) {
    const armedAfter = observed.daySecuredArmed.filter(
      a => a.owner === consumed.owner && a.day === consumed.day,
    ).length;
    const consumedCount = consumedMoments.filter(
      c => c.owner === consumed.owner && c.day === consumed.day,
    ).length;
    if (
      armedAfter > consumedCount &&
      !problems.some(p => p.startsWith('day-secured-rearmed'))
    ) {
      problems.push(
        `day-secured-rearmed: ${consumed.day} armed ${armedAfter}× for owner ${consumed.owner.slice(0, 4)} but consumed ${consumedCount}×`,
      );
    }
  }
  if (
    new Set(consumedMoments.map(c => `${c.owner}|${c.day}`)).size !==
    consumedMoments.length
  ) {
    problems.push(
      'day-secured-consumed-twice: the same (owner, day) moment was returned twice',
    );
  }
  // The consumption marker must survive to quiescence (every parked write
  // has been released by now) unless a later consumption replaced it.
  for (const owner of [OWNER_A, OWNER_B]) {
    const mine = consumedMoments.filter(c => c.owner === owner);
    if (mine.length === 0) continue;
    const last = mine[mine.length - 1]!;
    const ledger = parseConsistencyLedger(
      mockKv.get(consistencyKeyForOwner(owner)) ?? null,
    );
    if (ledger.daySecuredShownDay !== last.day) {
      problems.push(
        `day-secured-marker-lost: owner ${owner.slice(0, 4)} consumed ${last.day} but ledger.daySecuredShownDay=${String(ledger.daySecuredShownDay)}`,
      );
    }
  }

  // Quiescent state ≡ fresh engine replay of the active owner's facts.
  if (state.ownerKey !== finalOwner) {
    problems.push(
      `owner-mismatch: store.ownerKey=${state.ownerKey} active=${finalOwner}`,
    );
  }
  if (finalOwner === SIGNED_OUT_DATA_OWNER) {
    if (state.snapshot !== null || state.daySecured !== null) {
      problems.push(
        'signed-out-not-empty: snapshot/daySecured retained after logout',
      );
    }
  } else {
    const ledger = parseConsistencyLedger(
      mockKv.get(consistencyKeyForOwner(finalOwner)) ?? null,
    );
    const facts: TrainingActivityInput[] = (
      mockShotsByOwner.get(finalOwner) ?? []
    ).map(shot => ({
      kind: shot.sessionId ? 'session_stroke' : 'stroke',
      atIso: shot.capturedAt,
      shotType: shot.shotType,
      overallScore: shot.overallScore,
      resultKind: shot.resultKind,
    }));
    for (const drill of ledger.drills) {
      facts.push({
        kind: 'drill',
        atIso: drill.completedAtIso,
        label: drill.title || drill.slug,
      });
    }
    const expected = buildConsistencySnapshot(facts, {
      asOfIso: new Date().toISOString(),
      timeZone: deviceZone,
    });
    if (state.loadError) {
      problems.push(
        'load-error-after-clean-refresh: final refresh ran with faults cleared',
      );
    }
    if (!state.snapshot) {
      problems.push(
        'no-snapshot: active owner has facts but store.snapshot is null',
      );
    } else if (canonical(state.snapshot) !== canonical(expected)) {
      problems.push(
        `stale-snapshot: store ${summary(state.snapshot)} vs replay ${summary(expected)}`,
      );
    }
    if (state.celebration) {
      const earnedIds = new Set(expected.earned.map(e => e.id));
      if (!earnedIds.has(state.celebration.achievementId)) {
        problems.push(
          `foreign-celebration: ${state.celebration.achievementId} pending for owner ${finalOwner.slice(0, 4)} who never earned it`,
        );
      }
    }
    if (
      state.daySecured &&
      ledger.daySecuredShownDay === state.daySecured.day
    ) {
      problems.push(
        `day-secured-armed-after-shown: ${state.daySecured.day} armed while ledger says shown`,
      );
    }
  }

  removeZoneShim();
  jest.useRealTimers();

  return {
    seed: scenario.seed,
    zone: scenario.zone,
    ops: allOps.length,
    steps,
    wallMs: realNow() - started,
    finalOwner: finalOwner.slice(0, 4),
    ledgerDrills: parseConsistencyLedger(
      mockKv.get(consistencyKeyForOwner(OWNER_A)) ?? null,
    ).drills.length,
    outcome: problems.length === 0 ? 'HELD' : 'BROKEN',
    problems,
    ...(problems.length > 0 ? { trace } : {}),
    observations: {
      releases: mockSched.releases,
      celebrations: observed.celebrations.length,
      daySecuredArmed: observed.daySecuredArmed.length,
      consumed: observed.consumedDays.length,
      staleOwnerTicks: observed.staleOwnerTicks,
      crossOwnerSnapshotTicks: observed.crossOwnerSnapshotTicks,
      rotations: rotationEpoch,
      opKinds: scenario.ops.map(o => o.kind).join(','),
    },
  };
}

function canonical(snapshot: ConsistencySnapshot): string {
  const days: Record<string, unknown> = {};
  for (const [key, day] of Object.entries(snapshot.days)) {
    days[key] = {
      ...day,
      activities: [...day.activities].map(a => JSON.stringify(a)).sort(),
    };
  }
  return JSON.stringify({ ...snapshot, days });
}

function summary(s: ConsistencySnapshot): string {
  return JSON.stringify({
    asOfDay: s.asOfDay,
    tz: s.timeZone,
    streak: s.currentStreak,
    xp: s.momentumXp,
    acts: s.totalActivities,
    days: Object.keys(s.days).length,
    earned: s.earned.map(e => e.id),
  });
}

// ─── Campaign ───────────────────────────────────────────────────────────────

afterEach(() => {
  removeZoneShim();
  jest.useRealTimers();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('consistency store — seeded interleaving campaign', () => {
  it(`holds its invariants across ${SEEDS.length} seeded interleavings`, async () => {
    const broken: Array<{ seed: number; problems: string[] }> = [];
    for (const seed of SEEDS) {
      const row = await runScenario(makeScenario(seed));
      rows.push(row);
      if (row.outcome === 'BROKEN')
        broken.push({ seed, problems: row.problems });
    }
    expect(broken).toEqual([]);
  });

  it('never deadlocks and stays inside the wall-time budget', () => {
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.filter(r => r.problems.some(p => p.startsWith('deadlock'))),
    ).toEqual([]);
    expect(Math.max(...rows.map(r => r.wallMs))).toBeLessThan(
      MAX_WALL_MS_PER_SEED,
    );
  });
});
