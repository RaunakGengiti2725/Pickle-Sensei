/**
 * STRESS / failure-injection — consistency store + bootstrap contract.
 *
 * Seeded campaign: every seed builds an owner history (shots + drill
 * ledger, sometimes pre-corrupted), a device zone and a start instant
 * (often on a DST edge), then drives the store through a random sequence
 * of hydrate / refresh / concurrent refresh / foreground bursts / drill
 * completions / owner switches / clock jumps / zone changes while the
 * SQLite-backed dependencies (`getDb`, `listActivityShots`, `getKv`,
 * `setKv`) are made to throw, reject, reject with non-Errors, stall, stall
 * for 45 s, never settle, return malformed rows / ledgers, or return partial
 * data. Fake timers are advanced up to 60 s per operation.
 *
 * Invariants (all asserted; the JSON table under artifacts/stress/consistency
 * records every row, seed → outcome, so any failure replays with
 * `STRESS_SEED=<seed> npx jest consistencyStore.failureInjection`):
 *   settles_within_60s          every public call settles inside 60 s
 *   never_rejects               public calls never reject (callers `void` them)
 *   owner_scope                 state.ownerKey is the active owner once settled
 *   no_snapshot_signed_out      signed-out never shows a snapshot
 *   truth_after_clean_refresh   a fault-free refresh equals the engine oracle
 *   load_error_visible          unreadable history → loadError, last good kept
 *   load_error_clears           a clean refresh clears loadError
 *   hydrated_after_hydrate      hydrate() settles with hydrated=true
 *   ledger_drills_monotone      persisted drill ids never disappear
 *   ledger_celebrated_monotone  persisted celebrations never disappear
 *   ledger_written_valid        every ledger the store writes parses back
 *   celebration_once            one ceremony per achievement id
 *   day_secured_once            "Day N secured" consumed once per day
 *   drill_loss_not_fake_success a drill whose write failed is never counted
 *                               (the silent loss itself is RECORDED per row
 *                               as observed.drillsLostSilently, not asserted:
 *                               store.ts documents the swallow on purpose)
 *   recovers_after_faults_clear a clean refresh after the storm equals truth
 *
 * STRESS_ITER=<n> sets the number of seeds (default 48). STRESS_SEED=<n>
 * replays one seed.
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
import { SIGNED_OUT_DATA_OWNER } from '../../src/data/accountScope';
import {
  buildConsistencySnapshot,
  type ConsistencySnapshot,
  type TrainingActivityInput,
} from '../../src/consistency/engine';
import {
  consistencyKeyForOwner,
  parseConsistencyLedger,
} from '../../src/consistency/store';
import {
  summarizeRows,
  writeJsonArtifact,
  type StressRow,
} from '../../test-support/stress/consistency/artifacts';
import {
  FAULT_KINDS,
  MALFORMED_KV_VARIANT_NAMES,
  MALFORMED_KV_VARIANTS,
  MALFORMED_SHOT_VARIANT_NAMES,
  type DepName,
  type Fault,
  type FaultKind,
} from '../../test-support/stress/consistency/faultRepo';
import {
  campaignSeeds,
  chance,
  int,
  makePrng,
  pick,
  weighted,
  type Rng,
} from '../../test-support/stress/consistency/prng';
import {
  DST_EDGE_INSTANTS,
  dayKeyIn,
  installDeviceTimeZoneShim,
  setDeviceTimeZone,
  STRESS_ZONES,
  zoneIsValid,
} from '../../test-support/stress/consistency/deviceShim';
import { nodeProcess } from '../../xc-harness/lifecycle-persistence/nodeShim';

type StoreModule = typeof import('../../src/consistency/store');
type ScopeModule = typeof import('../../src/data/accountScope');

const RealDate = Date;
const OWNER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SETTLE_BUDGET_MS = 60_000;
const SETTLE_STEP_MS = 1_000;
const SHOT_TYPES = ['dink', 'forehand_drive', 'serve', 'third_shot_drop'];

type OpType =
  | 'hydrate'
  | 'refresh'
  | 'concurrentRefresh'
  | 'foregroundBurst'
  | 'recordDrill'
  | 'recordDrillDuplicate'
  | 'consumeDaySecured'
  | 'dismissCelebration'
  | 'switchOwner'
  | 'switchOwnerMidFlight'
  | 'signOut'
  | 'advanceClock'
  | 'jumpBack'
  | 'jumpForward'
  | 'changeZone';

interface PlannedFault {
  dep: DepName;
  fault: Fault;
}

interface Op {
  type: OpType;
  faults: PlannedFault[];
  detail: Record<string, unknown>;
}

type SettleStatus = 'resolved' | 'rejected' | 'hung';

interface Settled {
  status: SettleStatus;
  reason?: string;
  elapsedMs: number;
}

interface OpObservation {
  op: OpType;
  detail: Record<string, unknown>;
  faultsArmed: string[];
  faultsConsumed: string[];
  status: SettleStatus | 'n/a';
  reason?: string;
  ownerKey: string | null;
  activeOwner: string;
  hydrated: boolean;
  loadError: boolean;
  snapshot: SnapshotDigest | null;
  celebration: string | null;
  daySecuredDay: string | null;
  ledgerDrillIds: string[] | null;
  violations: string[];
}

interface SnapshotDigest {
  asOfDay: string;
  timeZone: string;
  currentStreak: number;
  momentumXp: number;
  totalTrainedDays: number;
  totalActivities: number;
  shieldsAvailable: number;
  trainedToday: boolean;
  earned: string[];
  dayCount: number;
}

function digest(snapshot: ConsistencySnapshot | null): SnapshotDigest | null {
  if (!snapshot) return null;
  return {
    asOfDay: snapshot.asOfDay,
    timeZone: snapshot.timeZone,
    currentStreak: snapshot.currentStreak,
    momentumXp: snapshot.momentumXp,
    totalTrainedDays: snapshot.totalTrainedDays,
    totalActivities: snapshot.totalActivities,
    shieldsAvailable: snapshot.shieldsAvailable,
    trainedToday: snapshot.trainedToday,
    earned: snapshot.earned.map(e => e.id),
    dayCount: Object.keys(snapshot.days).length,
  };
}

function sameDigest(a: SnapshotDigest | null, b: SnapshotDigest | null) {
  return JSON.stringify(a) === JSON.stringify(b);
}

let restoreZoneShim: (() => void) | null = null;

beforeAll(() => {
  restoreZoneShim = installDeviceTimeZoneShim();
});

afterAll(() => {
  restoreZoneShim?.();
});

afterEach(() => {
  jest.useRealTimers();
  setDeviceTimeZone(null);
});

/** Settle a promise under fake timers: drain microtasks, then advance the
 * clock in 1 s steps until it settles or the 60 s budget is spent. */
async function settle(promise: Promise<unknown>): Promise<Settled> {
  let status: SettleStatus | 'pending' = 'pending';
  let reason: string | undefined;
  promise.then(
    () => {
      status = 'resolved';
    },
    (error: unknown) => {
      status = 'rejected';
      reason = error instanceof Error ? error.message : String(error);
    },
  );
  let elapsed = 0;
  await jest.advanceTimersByTimeAsync(0);
  while (status === 'pending' && elapsed < SETTLE_BUDGET_MS) {
    await jest.advanceTimersByTimeAsync(SETTLE_STEP_MS);
    elapsed += SETTLE_STEP_MS;
  }
  if (status === 'pending') return { status: 'hung', elapsedMs: elapsed };
  return { status, reason, elapsedMs: elapsed };
}

function shotAt(
  id: string,
  ms: number,
  rng: Rng,
  ownerSeed: number,
): ActivityShotRow {
  const scored = chance(rng, 0.8);
  return {
    id,
    sessionId: chance(rng, 0.3)
      ? `session-${ownerSeed}-${Math.floor(ms / 3_600_000)}`
      : null,
    shotType: pick(rng, SHOT_TYPES),
    capturedAt: new Date(ms).toISOString(),
    overallScore: scored ? Math.round((3 + rng() * 7) * 10) / 10 : null,
    resultKind: scored ? 'scored' : 'low_confidence',
  };
}

function seedHistory(
  rng: Rng,
  owner: string,
  nowMs: number,
  dayBudget: number,
  ownerSeed: number,
): void {
  const rows: ActivityShotRow[] = [];
  const dayMs = 86_400_000;
  let counter = 0;
  for (let back = 0; back < dayBudget; back += 1) {
    // Dense recent history so streaks, shields and milestones fire.
    if (back > 0 && chance(rng, 0.3)) continue;
    const shots = int(rng, 1, 4);
    for (let i = 0; i < shots; i += 1) {
      // Spread across the whole UTC day so local-midnight boundaries in
      // every zone are crossed by some shots.
      const offset =
        back === 0 ? int(rng, 1, 3_600_000) : int(rng, 0, dayMs - 1);
      const ms = nowMs - back * dayMs - offset;
      rows.push(shotAt(`shot-${ownerSeed}-${counter}`, ms, rng, ownerSeed));
      counter += 1;
    }
  }
  mockRepo.shots.set(owner, rows);
}

function seedLedger(rng: Rng, owner: string, nowMs: number): string {
  const key = consistencyKeyForOwner(owner);
  const roll = rng();
  if (roll < 0.3) return 'absent';
  if (roll < 0.55) {
    const variant = pick(rng, MALFORMED_KV_VARIANT_NAMES);
    mockRepo.kv.set(key, MALFORMED_KV_VARIANTS[variant] ?? 'not-json');
    return `malformed:${variant}`;
  }
  const drills = Array.from({ length: int(rng, 0, 5) }, (_, i) => ({
    id: `seed-drill-${i}`,
    slug: 'dink-ladder',
    title: 'Dink ladder',
    completedAtIso: new Date(
      nowMs - int(rng, 0, 20) * 86_400_000 - int(rng, 0, 86_399_000),
    ).toISOString(),
  }));
  const celebrated: Record<string, string> = {};
  for (const id of ['streak.1', 'streak.3', 'streak.7']) {
    if (chance(rng, 0.5)) celebrated[id] = '2026-01-01';
  }
  mockRepo.kv.set(
    key,
    JSON.stringify({
      version: 1,
      drills,
      celebrated,
      daySecuredShownDay: chance(rng, 0.3) ? dayKeyIn('UTC', nowMs) : null,
    }),
  );
  return `valid:${drills.length}d:${Object.keys(celebrated).length}c`;
}

function randomFault(rng: Rng, dep: DepName, sticky: boolean): Fault {
  // A kv write is atomic: there is no "malformed" write, only a lost one.
  const kinds: readonly FaultKind[] =
    dep === 'setKv'
      ? FAULT_KINDS.filter(kind => kind !== 'malformed')
      : FAULT_KINDS;
  const kind: FaultKind = pick(rng, kinds);
  const fault: Fault = { kind, sticky };
  if (kind === 'slow') fault.delayMs = int(rng, 50, 5_000);
  if (kind === 'timeout') fault.delayMs = int(rng, 30_000, 59_000);
  if (kind === 'malformed') {
    fault.variant =
      dep === 'listActivityShots'
        ? pick(rng, MALFORMED_SHOT_VARIANT_NAMES)
        : pick(rng, MALFORMED_KV_VARIANT_NAMES);
  }
  return fault;
}

const READ_DEPS: readonly DepName[] = ['getDb', 'listActivityShots', 'getKv'];
const WRITE_DEPS: readonly DepName[] = ['getDb', 'getKv', 'setKv'];

function planFaults(
  rng: Rng,
  deps: readonly DepName[],
  probability: number,
  sticky: boolean,
): PlannedFault[] {
  if (!chance(rng, probability)) return [];
  const count = int(rng, 1, Math.min(2, deps.length));
  const chosen = new Set<DepName>();
  while (chosen.size < count) chosen.add(pick(rng, deps));
  return [...chosen].map(dep => ({
    dep,
    fault: randomFault(rng, dep, sticky),
  }));
}

function planOps(rng: Rng): Op[] {
  const ops: Op[] = [
    {
      type: 'hydrate',
      faults: planFaults(rng, READ_DEPS, 0.6, false),
      detail: {},
    },
  ];
  const length = int(rng, 6, 12);
  let drillCounter = 0;
  for (let i = 0; i < length; i += 1) {
    const type = weighted<OpType>(rng, [
      ['refresh', 6],
      ['concurrentRefresh', 2],
      ['foregroundBurst', 2],
      ['recordDrill', 4],
      ['recordDrillDuplicate', 1],
      ['consumeDaySecured', 2],
      ['dismissCelebration', 1],
      ['switchOwner', 1],
      ['switchOwnerMidFlight', 1],
      ['signOut', 1],
      ['advanceClock', 2],
      ['jumpBack', 1],
      ['jumpForward', 1],
      ['changeZone', 1],
    ]);
    switch (type) {
      case 'refresh':
        ops.push({
          type,
          faults: planFaults(rng, [...READ_DEPS, 'setKv'], 0.7, false),
          detail: {},
        });
        break;
      case 'concurrentRefresh':
        ops.push({
          type,
          faults: planFaults(rng, READ_DEPS, 0.7, true),
          detail: { count: int(rng, 2, 4) },
        });
        break;
      case 'foregroundBurst':
        ops.push({
          type,
          faults: planFaults(rng, READ_DEPS, 0.7, true),
          detail: { count: int(rng, 2, 3) },
        });
        break;
      case 'recordDrill': {
        drillCounter += 1;
        ops.push({
          type,
          faults: planFaults(rng, WRITE_DEPS, 0.7, false),
          detail: {
            id: `drill-${drillCounter}`,
            daysAgo: weighted(rng, [
              [0, 6],
              [1, 2],
              [int(rng, 2, 30), 1],
            ]),
          },
        });
        break;
      }
      case 'recordDrillDuplicate':
        ops.push({
          type,
          faults: planFaults(rng, WRITE_DEPS, 0.5, false),
          detail: {
            id: drillCounter > 0 ? `drill-${drillCounter}` : 'seed-drill-0',
          },
        });
        break;
      case 'consumeDaySecured':
        ops.push({
          type,
          faults: planFaults(rng, WRITE_DEPS, 0.6, false),
          detail: {},
        });
        break;
      case 'switchOwnerMidFlight':
        ops.push({
          type,
          faults: [
            {
              dep: 'listActivityShots',
              fault: { kind: 'slow', delayMs: int(rng, 100, 3_000) },
            },
          ],
          detail: { to: chance(rng, 0.7) ? OWNER_B : SIGNED_OUT_DATA_OWNER },
        });
        break;
      case 'switchOwner':
        ops.push({
          type,
          faults: planFaults(rng, READ_DEPS, 0.4, false),
          detail: { to: chance(rng, 0.5) ? OWNER_B : OWNER_A },
        });
        break;
      case 'signOut':
        ops.push({ type, faults: [], detail: {} });
        break;
      case 'advanceClock':
        ops.push({
          type,
          faults: [],
          detail: {
            minutes: weighted(rng, [
              [int(rng, 1, 59), 3],
              [int(rng, 60, 1_800), 3],
            ]),
          },
        });
        break;
      case 'jumpBack':
        ops.push({ type, faults: [], detail: { days: int(rng, 1, 5) } });
        break;
      case 'jumpForward':
        ops.push({ type, faults: [], detail: { days: int(rng, 1, 40) } });
        break;
      case 'changeZone':
        ops.push({
          type,
          faults: [],
          detail: { zone: pick(rng, STRESS_ZONES) },
        });
        break;
      default:
        break;
    }
  }
  // Always finish with a clean refresh so every seed measures recovery.
  return ops;
}

function faultLabel(planned: PlannedFault): string {
  const { dep, fault } = planned;
  const extra = [
    fault.variant ? `variant=${fault.variant}` : null,
    fault.delayMs !== undefined ? `delay=${fault.delayMs}` : null,
    fault.sticky ? 'sticky' : null,
  ]
    .filter(Boolean)
    .join(',');
  return `${fault.kind} ${dep}${extra ? ` (${extra})` : ''}`;
}

function truthActivities(owner: string): TrainingActivityInput[] {
  const shots = [...(mockRepo.shots.get(owner) ?? [])].sort((a, b) =>
    a.capturedAt < b.capturedAt ? -1 : a.capturedAt > b.capturedAt ? 1 : 0,
  );
  const activities: TrainingActivityInput[] = shots.map(shot => ({
    kind: shot.sessionId ? 'session_stroke' : 'stroke',
    atIso: shot.capturedAt,
    shotType: shot.shotType,
    overallScore: shot.overallScore,
    resultKind: shot.resultKind,
  }));
  const ledger = parseConsistencyLedger(
    mockRepo.kv.get(consistencyKeyForOwner(owner)) ?? null,
  );
  for (const drill of ledger.drills) {
    activities.push({
      kind: 'drill',
      atIso: drill.completedAtIso,
      label: drill.title || drill.slug,
    });
  }
  return activities;
}

function oracle(owner: string, zone: string, atMs: number): SnapshotDigest {
  return digest(
    buildConsistencySnapshot(truthActivities(owner), {
      asOfIso: new Date(atMs).toISOString(),
      timeZone: zoneIsValid(zone) ? zone : 'UTC',
    }),
  ) as SnapshotDigest;
}

/** What the production parser would read back from the persisted ledger:
 * the valid drills and celebrations on disk. Garbage entries the parser
 * drops are not "lost" when the store rewrites without them. */
function ledgerIds(
  owner: string,
): { drills: string[]; celebrated: string[] } | null {
  const raw = mockRepo.kv.get(consistencyKeyForOwner(owner));
  if (raw === undefined) return null;
  const ledger = parseConsistencyLedger(raw);
  return {
    drills: ledger.drills.map(drill => drill.id),
    celebrated: Object.keys(ledger.celebrated),
  };
}

function ledgerWriteIsValid(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return (
      Boolean(parsed) &&
      typeof parsed === 'object' &&
      parsed['version'] === 1 &&
      Array.isArray(parsed['drills']) &&
      Boolean(parsed['celebrated']) &&
      typeof parsed['celebrated'] === 'object' &&
      !Array.isArray(parsed['celebrated'])
    );
  } catch {
    return false;
  }
}

interface ScenarioResult {
  row: StressRow;
  observations: OpObservation[];
}

async function runScenario(seed: number): Promise<ScenarioResult> {
  const started = RealDate.now();
  const rng = makePrng(seed);
  mockRepo = new FaultRepository();
  // The refresh queue is module state; a hung promise from a previous seed
  // would poison this one, so every seed gets a fresh module instance.
  jest.resetModules();
  const storeModule = jest.requireActual(
    '../../src/consistency/store',
  ) as StoreModule;
  const scopeModule = jest.requireActual(
    '../../src/data/accountScope',
  ) as ScopeModule;
  const store = storeModule.useConsistencyStore;
  mockRepo.ownerResolver = scopeModule.getActiveDataOwner;
  const setOwner = scopeModule.setActiveDataOwner;
  const activeOwner = scopeModule.getActiveDataOwner;

  const zone = pick(rng, STRESS_ZONES);
  let zoneCurrent: string = zone;
  const effectiveZone = (): string => {
    if (zoneCurrent === '') {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    }
    return zoneIsValid(zoneCurrent) ? zoneCurrent : 'UTC';
  };
  const startIso = chance(rng, 0.5)
    ? pick(rng, DST_EDGE_INSTANTS)
    : new Date(
        Date.UTC(
          2026,
          int(rng, 0, 11),
          int(rng, 1, 28),
          int(rng, 0, 23),
          int(rng, 0, 59),
          int(rng, 0, 59),
        ),
      ).toISOString();
  const startMs = Date.parse(startIso);
  jest.useFakeTimers({ now: startMs });
  setDeviceTimeZone(zone === '' ? null : zone);

  seedHistory(rng, OWNER_A, startMs, int(rng, 0, 40), 1);
  seedHistory(rng, OWNER_B, startMs, int(rng, 0, 6), 2);
  const ledgerInit = seedLedger(rng, OWNER_A, startMs);
  const ops = planOps(rng);
  setOwner(OWNER_A);
  store.setState({
    hydrated: false,
    ownerKey: null,
    snapshot: null,
    loadError: false,
    celebration: null,
    daySecured: null,
  });

  const invariants: Record<string, boolean> = {
    settles_within_60s: true,
    never_rejects: true,
    owner_scope: true,
    no_snapshot_signed_out: true,
    truth_after_clean_refresh: true,
    load_error_visible: true,
    load_error_clears: true,
    hydrated_after_hydrate: true,
    ledger_drills_monotone: true,
    ledger_celebrated_monotone: true,
    ledger_written_valid: true,
    celebration_once: true,
    day_secured_once: true,
    drill_loss_not_fake_success: true,
    recovers_after_faults_clear: true,
    trained_today_implies_streak: true,
  };
  const observations: OpObservation[] = [];
  const faultsConsumedAll: string[] = [];
  const celebrationsSeen = new Map<string, number>();
  const daySecuredDays = new Map<string, number>();
  let lastCelebration = store.getState().celebration;
  let previousLedger = ledgerIds(OWNER_A);
  let hungAt: string | null = null;
  const drillsLostSilently: string[] = [];

  const consumedDuring = (from: number) =>
    mockRepo.calls
      .slice(from)
      .filter(call => call.fault !== 'ok')
      .map(
        call =>
          `${call.fault} ${call.dep}${call.variant ? ` (variant=${call.variant})` : ''}`,
      );

  const noteCelebration = () => {
    const current = store.getState().celebration;
    if (current && current !== lastCelebration) {
      const key = `${store.getState().ownerKey ?? '?'}:${current.achievementId}`;
      celebrationsSeen.set(key, (celebrationsSeen.get(key) ?? 0) + 1);
    }
    lastCelebration = current;
  };

  const checkSnapshotSanity = (violations: string[]) => {
    const snapshot = store.getState().snapshot;
    if (!snapshot) return;
    if (
      snapshot.trainedToday &&
      (snapshot.currentStreak < 1 || snapshot.totalTrainedDays < 1)
    ) {
      invariants.trained_today_implies_streak = false;
      violations.push(
        `trained_today_implies_streak: trainedToday but streak=${snapshot.currentStreak} trainedDays=${snapshot.totalTrainedDays}`,
      );
    }
  };

  const checkLedger = (violations: string[]) => {
    const current = ledgerIds(OWNER_A);
    if (previousLedger && current) {
      for (const id of previousLedger.drills) {
        if (!current.drills.includes(id)) {
          invariants.ledger_drills_monotone = false;
          violations.push(`ledger_drills_monotone: lost drill ${id}`);
        }
      }
      for (const id of previousLedger.celebrated) {
        if (!current.celebrated.includes(id)) {
          invariants.ledger_celebrated_monotone = false;
          violations.push(`ledger_celebrated_monotone: lost ${id}`);
        }
      }
    }
    previousLedger = current;
  };

  const observe = (
    op: Op,
    settled: Settled | null,
    callsFrom: number,
    violations: string[],
  ): OpObservation => {
    const state = store.getState();
    const owner = activeOwner();
    if (settled && settled.status !== 'hung') {
      if (state.ownerKey !== owner) {
        invariants.owner_scope = false;
        violations.push(
          `owner_scope: state.ownerKey=${state.ownerKey} active=${owner}`,
        );
      }
    }
    if (
      owner === SIGNED_OUT_DATA_OWNER &&
      state.snapshot !== null &&
      settled &&
      settled.status === 'resolved'
    ) {
      invariants.no_snapshot_signed_out = false;
      violations.push('no_snapshot_signed_out');
    }
    noteCelebration();
    checkLedger(violations);
    checkSnapshotSanity(violations);
    const consumed = consumedDuring(callsFrom);
    faultsConsumedAll.push(...consumed);
    return {
      op: op.type,
      detail: op.detail,
      faultsArmed: op.faults.map(faultLabel),
      faultsConsumed: consumed,
      status: settled ? settled.status : 'n/a',
      reason: settled?.reason,
      ownerKey: state.ownerKey,
      activeOwner: owner,
      hydrated: state.hydrated,
      loadError: state.loadError,
      snapshot: digest(state.snapshot),
      celebration: state.celebration?.achievementId ?? null,
      daySecuredDay: state.daySecured?.day ?? null,
      ledgerDrillIds: ledgerIds(OWNER_A)?.drills ?? null,
      violations,
    };
  };

  const armAll = (op: Op) => {
    for (const planned of op.faults) mockRepo.arm(planned.dep, planned.fault);
  };

  // A drill op consumes one-shot getDb/getKv faults inside
  // recordDrillCompletion (swallowed there); only the history read of a
  // refresh-shaped op turns a getDb fault into an unreadable history.
  const historyReadFaulted = (from: number, op: Op) =>
    mockRepo.calls
      .slice(from)
      .some(
        call =>
          (call.dep === 'listActivityShots' ||
            (call.dep === 'getDb' &&
              op.type !== 'recordDrill' &&
              op.type !== 'recordDrillDuplicate')) &&
          (call.fault === 'throw' ||
            call.fault === 'reject' ||
            call.fault === 'reject-non-error'),
      );

  const anyFaultConsumed = (from: number) =>
    mockRepo.calls.slice(from).some(call => call.fault !== 'ok');

  const readFaultKindsConsumed = (from: number) =>
    new Set(
      mockRepo.calls
        .slice(from)
        .filter(call => call.fault !== 'ok')
        .map(call => call.fault),
    );

  for (const op of ops) {
    if (hungAt) break;
    const violations: string[] = [];
    const callsFrom = mockRepo.calls.length;
    const before = store.getState();
    const beforeDigest = digest(before.snapshot);
    let settled: Settled | null = null;

    switch (op.type) {
      case 'hydrate': {
        armAll(op);
        settled = await settle(store.getState().hydrate());
        if (settled.status === 'resolved' && !store.getState().hydrated) {
          invariants.hydrated_after_hydrate = false;
          violations.push('hydrated_after_hydrate');
        }
        break;
      }
      case 'refresh':
      case 'switchOwner': {
        if (op.type === 'switchOwner') {
          setOwner(String(op.detail['to']));
        }
        armAll(op);
        settled = await settle(store.getState().refresh());
        break;
      }
      case 'concurrentRefresh':
      case 'foregroundBurst': {
        armAll(op);
        const count = Number(op.detail['count']);
        const promises = Array.from({ length: count }, () =>
          store.getState().refresh(),
        );
        const results: Settled[] = [];
        for (const promise of promises) results.push(await settle(promise));
        mockRepo.clearFaults();
        settled = results.find(r => r.status === 'hung') ??
          results.find(r => r.status === 'rejected') ??
          results[results.length - 1] ?? { status: 'resolved', elapsedMs: 0 };
        break;
      }
      case 'recordDrill':
      case 'recordDrillDuplicate': {
        armAll(op);
        const id = String(op.detail['id']);
        const daysAgo = Number(op.detail['daysAgo'] ?? 0);
        const record = {
          id,
          slug: 'dink-ladder',
          title: 'Dink ladder',
          completedAtIso: new Date(
            Date.now() - daysAgo * 86_400_000 - 1_000,
          ).toISOString(),
        };
        const owner = activeOwner();
        settled = await settle(store.getState().recordDrillCompletion(record));
        if (
          settled.status === 'resolved' &&
          owner !== SIGNED_OUT_DATA_OWNER &&
          op.type === 'recordDrill'
        ) {
          const persisted = ledgerIds(owner)?.drills.includes(id) ?? false;
          const faulted = anyFaultConsumed(callsFrom);
          const kinds = readFaultKindsConsumed(callsFrom);
          const onlyDelays = [...kinds].every(
            kind => kind === 'slow' || kind === 'timeout',
          );
          if (!persisted && faulted && !onlyDelays) {
            if (!store.getState().loadError) {
              drillsLostSilently.push(`${id} after ${[...kinds].join('+')}`);
            }
            // The drill is gone; the snapshot must not pretend otherwise.
            const shown = store.getState().snapshot;
            const drillDay = dayKeyIn(
              zoneIsValid(zone) ? zone : 'UTC',
              Date.parse(record.completedAtIso),
            );
            if (shown && !store.getState().loadError) {
              const truth = buildConsistencySnapshot(truthActivities(owner), {
                asOfIso: new Date().toISOString(),
                timeZone: zoneIsValid(zone) ? zone : 'UTC',
              });
              const shownDrills = shown.days[drillDay]?.drillCount ?? 0;
              const truthDrills = truth.days[drillDay]?.drillCount ?? 0;
              if (shownDrills > truthDrills) {
                invariants.drill_loss_not_fake_success = false;
                violations.push(
                  `drill_loss_not_fake_success: ${id} not persisted but ${drillDay} shows drillCount=${shownDrills} vs truth ${truthDrills}`,
                );
              }
            }
          }
          if (!persisted && !faulted) {
            invariants.truth_after_clean_refresh = false;
            violations.push(
              `truth_after_clean_refresh: ${id} not persisted without any fault`,
            );
          }
        }
        break;
      }
      case 'consumeDaySecured': {
        armAll(op);
        const moment = store.getState().consumeDaySecured();
        // The persistence is fire-and-forget; give it the same 60 s window.
        settled = await settle(Promise.resolve());
        if (moment) {
          const key = `${activeOwner()}:${moment.day}`;
          daySecuredDays.set(key, (daySecuredDays.get(key) ?? 0) + 1);
          if ((daySecuredDays.get(key) ?? 0) > 1) {
            invariants.day_secured_once = false;
            violations.push(`day_secured_once: ${key} consumed twice`);
          }
        }
        mockRepo.clearFaults();
        break;
      }
      case 'dismissCelebration': {
        store.getState().dismissCelebration();
        settled = await settle(Promise.resolve());
        break;
      }
      case 'switchOwnerMidFlight': {
        armAll(op);
        const first = store.getState().refresh();
        setOwner(String(op.detail['to']));
        const second = store.getState().hydrate();
        const a = await settle(first);
        const b = await settle(second);
        settled =
          a.status === 'hung'
            ? a
            : b.status === 'hung'
              ? b
              : a.status === 'rejected'
                ? a
                : b;
        break;
      }
      case 'signOut': {
        setOwner(SIGNED_OUT_DATA_OWNER);
        settled = await settle(store.getState().hydrate());
        break;
      }
      case 'advanceClock': {
        jest.setSystemTime(Date.now() + Number(op.detail['minutes']) * 60_000);
        break;
      }
      case 'jumpBack': {
        jest.setSystemTime(Date.now() - Number(op.detail['days']) * 86_400_000);
        break;
      }
      case 'jumpForward': {
        jest.setSystemTime(Date.now() + Number(op.detail['days']) * 86_400_000);
        break;
      }
      case 'changeZone': {
        zoneCurrent = String(op.detail['zone']);
        setDeviceTimeZone(zoneCurrent === '' ? null : zoneCurrent);
        break;
      }
      default:
        break;
    }

    // Anything armed but never reached must not leak into the next op.
    mockRepo.clearFaults();

    if (settled) {
      if (settled.status === 'hung') {
        invariants.settles_within_60s = false;
        violations.push(
          `settles_within_60s: ${op.type} still pending after ${settled.elapsedMs} ms`,
        );
        hungAt = op.type;
      }
      if (settled.status === 'rejected') {
        invariants.never_rejects = false;
        violations.push(
          `never_rejects: ${op.type} rejected: ${settled.reason ?? '?'}`,
        );
      }
      const state = store.getState();
      const owner = activeOwner();
      const isRefreshLike =
        op.type === 'hydrate' ||
        op.type === 'refresh' ||
        op.type === 'switchOwner' ||
        op.type === 'concurrentRefresh' ||
        op.type === 'foregroundBurst' ||
        op.type === 'recordDrill' ||
        op.type === 'recordDrillDuplicate' ||
        op.type === 'switchOwnerMidFlight';
      // A duplicate drill returns before refreshing; only an op that
      // actually read the history can be judged against the oracle.
      const readHistory = mockRepo.calls
        .slice(callsFrom)
        .some(call => call.dep === 'listActivityShots');
      if (
        settled.status === 'resolved' &&
        isRefreshLike &&
        owner !== SIGNED_OUT_DATA_OWNER
      ) {
        if (
          historyReadFaulted(callsFrom, op) &&
          !anyCleanHistoryReadAfterFault(mockRepo.calls.slice(callsFrom))
        ) {
          if (!state.loadError) {
            invariants.load_error_visible = false;
            violations.push(
              'load_error_visible: history unreadable but loadError=false',
            );
          }
          if (
            beforeDigest &&
            !sameDigest(beforeDigest, digest(state.snapshot))
          ) {
            invariants.load_error_visible = false;
            violations.push(
              'load_error_visible: last good snapshot replaced on read failure',
            );
          }
        } else if (
          readHistory &&
          !anyFaultConsumed(callsFrom) &&
          op.type !== 'switchOwnerMidFlight'
        ) {
          const expectedNow = oracle(owner, effectiveZone(), Date.now());
          const expectedBefore = oracle(
            owner,
            effectiveZone(),
            Date.now() - settled.elapsedMs,
          );
          const actual = digest(state.snapshot);
          if (
            !sameDigest(actual, expectedNow) &&
            !sameDigest(actual, expectedBefore)
          ) {
            invariants.truth_after_clean_refresh = false;
            violations.push(
              `truth_after_clean_refresh: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expectedNow)}`,
            );
          }
          if (state.loadError) {
            invariants.load_error_clears = false;
            violations.push(
              'load_error_clears: loadError=true after a clean refresh',
            );
          }
        }
      }
    }

    for (const write of mockRepo.writes) {
      if (!ledgerWriteIsValid(write.value)) {
        invariants.ledger_written_valid = false;
        violations.push(`ledger_written_valid: ${write.value.slice(0, 80)}`);
      }
    }
    observations.push(observe(op, settled, callsFrom, violations));
  }

  const recoveryViolations: string[] = [];
  for (const [id, count] of celebrationsSeen) {
    if (count > 1) {
      invariants.celebration_once = false;
      recoveryViolations.push(`celebration_once: ${id} shown ${count}×`);
    }
  }

  // Recovery: faults gone, owner A signed in, one clean refresh → truth.
  mockRepo.clearFaults();
  setOwner(OWNER_A);
  const recoveryFrom = mockRepo.calls.length;
  const recovery = await settle(store.getState().refresh());
  if (recovery.status !== 'resolved') {
    invariants.recovers_after_faults_clear = false;
    recoveryViolations.push(
      `recovers_after_faults_clear: recovery refresh ${recovery.status}`,
    );
  } else {
    const state = store.getState();
    const expected = oracle(OWNER_A, effectiveZone(), Date.now());
    if (
      !sameDigest(digest(state.snapshot), expected) ||
      state.loadError ||
      state.ownerKey !== OWNER_A
    ) {
      invariants.recovers_after_faults_clear = false;
      recoveryViolations.push(
        `recovers_after_faults_clear: actual=${JSON.stringify(digest(state.snapshot))} loadError=${state.loadError} expected=${JSON.stringify(expected)}`,
      );
    }
  }
  observations.push(
    observe(
      { type: 'refresh', faults: [], detail: { phase: 'recovery' } },
      recovery,
      recoveryFrom,
      recoveryViolations,
    ),
  );

  const failed = Object.entries(invariants)
    .filter(([, held]) => !held)
    .map(([name]) => name);
  const row: StressRow = {
    suite: 'consistencyStore.failureInjection',
    seed,
    scenario: `zone=${zone || '<empty>'} start=${startIso} ledger=${ledgerInit} ops=${ops.length}`,
    faults: faultsConsumedAll,
    inputs: {
      zone,
      startIso,
      ledgerInit,
      shotsA: mockRepo.shots.get(OWNER_A)?.length ?? 0,
      shotsB: mockRepo.shots.get(OWNER_B)?.length ?? 0,
      ops: ops.map(op => ({
        type: op.type,
        detail: op.detail,
        faults: op.faults.map(faultLabel),
      })),
    },
    observed: {
      hungAt,
      finalState: {
        ownerKey: store.getState().ownerKey,
        hydrated: store.getState().hydrated,
        loadError: store.getState().loadError,
        snapshot: digest(store.getState().snapshot),
      },
      celebrationsSeen: Object.fromEntries(celebrationsSeen),
      daySecuredDays: Object.fromEntries(daySecuredDays),
      drillsLostSilently,
      violations: observations.flatMap(o => o.violations),
    },
    invariants,
    ok: failed.length === 0,
    failed,
    durationMs: RealDate.now() - started,
  };
  jest.useRealTimers();
  return { row, observations };
}

/** A faulted read followed (in the same op) by a clean read means the
 * later refresh in a burst legitimately cleared the error. */
function anyCleanHistoryReadAfterFault(
  calls: FaultRepository['calls'],
): boolean {
  let seenFault = false;
  for (const call of calls) {
    if (call.dep !== 'listActivityShots') continue;
    if (call.fault !== 'ok') seenFault = true;
    else if (seenFault) return true;
  }
  return false;
}

describe('consistency store — seeded failure-injection campaign', () => {
  const seeds = campaignSeeds(nodeProcess.env, 48, 1);

  it(`holds every invariant across ${seeds.length} seeded fault storms`, async () => {
    const rows: StressRow[] = [];
    const traces: Record<number, OpObservation[]> = {};
    for (const seed of seeds) {
      const { row, observations } = await runScenario(seed);
      rows.push(row);
      traces[seed] = observations;
    }
    const summary = summarizeRows('consistencyStore.failureInjection', rows, {
      replay:
        'STRESS_SEED=<seed> npx jest --ci consistencyStore.failureInjection',
    });
    writeJsonArtifact('store-failure-injection.rows.json', rows);
    writeJsonArtifact('store-failure-injection.traces.json', traces);
    writeJsonArtifact('store-failure-injection.summary.json', summary);

    const totalFaults = rows.reduce((sum, row) => sum + row.faults.length, 0);
    expect(totalFaults).toBeGreaterThanOrEqual(Math.min(60, seeds.length * 2));

    const failures = rows
      .filter(row => !row.ok)
      .map(row => `seed ${row.seed}: ${row.failed.join(', ')}`);
    expect(failures).toEqual([]);
  }, 300_000);
});
