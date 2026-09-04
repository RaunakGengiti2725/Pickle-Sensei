/**
 * STRESS — consistency store + bootstrap hook, lens `randomized-seeded`.
 *
 * Seeded randomized long-run over the store's public API
 * (`hydrate`/`refresh`/`recordDrillCompletion`/`consumeDaySecured`/
 * `dismissCelebration`) and `useConsistencyBootstrap` (mount / owner change /
 * AppState foreground / unmount), against an in-memory SQLite stand-in with
 * seeded microtask latency and fault injection (kv read / kv write / shot
 * read failures, corrupted ledgers). Owner switches and sign-outs happen
 * mid-flight; the wall clock is a jest fake clock that the sequence advances
 * across local midnights.
 *
 * Invariants (AGENTS.md "Consistency", store.ts header):
 *   ST-01 snapshot == pure engine replay of the ACTIVE owner's facts
 *   ST-02 signed-out ⇒ snapshot null; ownerKey tracks the active owner
 *   ST-03 no cross-owner leak: kv for owner A only ever holds A's drills,
 *         and the surfaced snapshot never contains another owner's activity
 *   ST-04 drill ledger: unique ids, ≤ 2000, drills recorded fault-free and
 *         awaited are never lost
 *   ST-05 one ceremony per (owner, achievement) — never re-celebrated after
 *         dismissal; celebrated ids ⊆ earned ids of that owner
 *   ST-06 "Day N secured" consumed at most once per (owner, day) when the
 *         consumption write succeeded
 *   ST-07 loadError is true iff the last refresh could not read facts
 *   ST-08 refresh never throws / rejects; hook refreshes on 'active' only
 *   ST-09 same seed twice → identical trace (determinism)
 *
 *   STRESS_ITER=<n>  sequences (default 60; campaign ≥ 2000)
 *   STRESS_SEED=<n>  campaign seed (default 20260904)
 *   STRESS_ONLY=<s>  replay one iteration seed with the full trace
 *   STRESS_OUT=<dir> artifact directory
 *   STRESS_STRICT=1  known reproduced defects (KNOWN_DEFECTS below) fail the
 *                    suite instead of being counted as BROKEN-KNOWN
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { AppState } from 'react-native';
import * as mockAccountScope from '../../src/data/accountScope';

interface MockShot {
  id: string;
  sessionId: string | null;
  shotType: string;
  capturedAt: string;
  overallScore: number | null;
  resultKind: string;
}

interface FaultState {
  kvRead: boolean;
  kvWrite: boolean;
  shotsRead: boolean;
}

const mockDb = {
  kv: new Map<string, string>(),
  shots: new Map<string, MockShot[]>(),
  faults: { kvRead: false, kvWrite: false, shotsRead: false } as FaultState,
  /** Seeded microtask latency per call; replaced per sequence. */
  latency: (): number => 0,
  setKvCalls: 0,
  setKvFailures: 0,
};

async function mockSpin(ticks: number): Promise<void> {
  for (let index = 0; index < ticks; index += 1) await Promise.resolve();
}

jest.mock('../../src/data/db', () => ({
  getDb: () => ({}),
}));

jest.mock('../../src/data/repository', () => ({
  getKv: async (_db: unknown, key: string) => {
    await mockSpin(mockDb.latency());
    if (mockDb.faults.kvRead) throw new Error('kv read fault');
    return mockDb.kv.get(key) ?? null;
  },
  setKv: async (_db: unknown, key: string, value: string) => {
    await mockSpin(mockDb.latency());
    mockDb.setKvCalls += 1;
    if (mockDb.faults.kvWrite) {
      mockDb.setKvFailures += 1;
      throw new Error('kv write fault');
    }
    mockDb.kv.set(key, value);
  },
  listActivityShots: async () => {
    await mockSpin(mockDb.latency());
    if (mockDb.faults.shotsRead) throw new Error('shots read fault');
    // The store queries by the active owner; mirror that here.
    const owner = mockAccountScope.getActiveDataOwner();
    return [...(mockDb.shots.get(owner) ?? [])];
  },
}));

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
import { useConsistencyBootstrap } from '../../src/consistency/useConsistencyBootstrap';
import {
  envInt,
  envString,
  fnv1a,
  iterationSeed,
  joinPath,
  Rng,
  stableJson,
  writeArtifact,
} from '../../test-support/stress/seededRng';
import { snapshotFingerprint } from '../../test-support/stress/consistencyEngineModel';

declare const __dirname: string;

const ITER = envInt('STRESS_ITER', 60);
const CAMPAIGN_SEED = envInt('STRESS_SEED', 20260904);
const ONLY = envString('STRESS_ONLY');
const OUT_DIR =
  envString('STRESS_OUT') ??
  joinPath(__dirname, '..', '..', 'artifacts', 'stress');
const STRICT = envInt('STRESS_STRICT', 0) === 1;
/**
 * Reproduced defects in the production store (see the campaign findings):
 * recorded, minimized and counted on every run, fatal only under
 * STRESS_STRICT=1 so the suite keeps pinning everything else meanwhile.
 *   ST-04-drill-lost          read-modify-write races on the single ledger
 *                             blob (concurrent recordDrillCompletion /
 *                             refresh / consumeDaySecured) drop recorded
 *                             drills; a refresh after a failed ledger READ
 *                             persists an empty ledger over the real one.
 *   ST-05b-celebration-scope  a pending ceremony survives sign-out
 *                             (refresh's signed-out branch keeps it) and
 *                             owner change (`state.celebration ??`), so the
 *                             next owner is shown the previous owner's card.
 *   ST-05-repeat-celebration  the failed-read refresh above also re-runs
 *                             every ceremony (celebrated map read as empty).
 *   ST-06-day-secured-twice   same failed-read path forgets
 *                             `daySecuredShownDay`; and a moment raised for
 *                             owner A can be consumed (and persisted) under
 *                             owner B after a switch.
 *   ST-06-day-secured-stale   when persisting `celebrated` fails, refresh
 *                             returns early with the new snapshot but the
 *                             previous day's `daySecured` still pending.
 */
const KNOWN_DEFECTS = new Set<string>(
  STRICT
    ? []
    : [
        'ST-04-drill-lost',
        'ST-05b-celebration-scope',
        'ST-05-repeat-celebration',
        'ST-06-day-secured-twice',
        'ST-06-day-secured-stale',
      ],
);

const OWNERS = [
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
] as const;
const { SIGNED_OUT_DATA_OWNER, setActiveDataOwner, getActiveDataOwner } =
  mockAccountScope;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const SHOT_TYPES = ['dink', 'volley', 'serve', 'third_shot_drop'];

type StoreAction =
  | { type: 'hydrate'; await: boolean }
  | { type: 'refresh'; await: boolean; count: number }
  | { type: 'addShot'; owner: string; shot: MockShot }
  | { type: 'recordDrill'; drills: ConsistencyDrillRecord[]; await: boolean }
  | { type: 'consumeDaySecured' }
  | { type: 'dismissCelebration' }
  | { type: 'switchOwner'; owner: string; awaitPending: boolean }
  | { type: 'signOut' }
  | { type: 'advanceClock'; ms: number }
  | { type: 'fault'; fault: keyof FaultState; on: boolean }
  | { type: 'corruptLedger'; owner: string; raw: string }
  | { type: 'mountHook'; owner: string | null }
  | { type: 'setHookOwner'; owner: string | null }
  | { type: 'appState'; state: 'active' | 'background' | 'inactive' }
  | { type: 'unmountHook' }
  | { type: 'settle' };

interface Violation {
  step: number;
  invariant: string;
  detail: string;
}

interface StoreModel {
  /** Drills recorded fault-free + awaited, per owner (expected present). */
  expectedDrills: Map<string, Map<string, ConsistencyDrillRecord>>;
  /** Every drill id ever handed to recordDrillCompletion, per owner. */
  attemptedDrills: Map<string, Set<string>>;
  /** Celebrations surfaced (observed non-null celebration ids) per owner. */
  celebrated: Map<string, Set<string>>;
  lastCelebration: object | null;
  /** Consumed "Day N secured" (owner → set of days) with a clean persist. */
  consumed: Map<string, Set<string>>;
}

function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function activitiesFor(owner: string): TrainingActivityInput[] {
  const shots = mockDb.shots.get(owner) ?? [];
  const ledger = parseConsistencyLedger(
    mockDb.kv.get(consistencyKeyForOwner(owner)) ?? null,
  );
  const activities: TrainingActivityInput[] = shots.map(shot => ({
    kind: shot.sessionId ? 'session_stroke' : 'stroke',
    atIso: shot.capturedAt,
    shotType: shot.shotType,
    overallScore: shot.overallScore,
    resultKind: shot.resultKind,
  }));
  for (const drill of ledger.drills) {
    activities.push({
      kind: 'drill',
      atIso: drill.completedAtIso,
      label: drill.title || drill.slug,
    });
  }
  return activities;
}

function expectedSnapshot(owner: string): ConsistencySnapshot {
  return buildConsistencySnapshot(activitiesFor(owner), {
    asOfIso: new Date().toISOString(),
    timeZone: deviceTimeZone(),
  });
}

function HookHost({ owner }: { owner: string | null }): null {
  useConsistencyBootstrap(owner);
  return null;
}

let appStateHandlers: Array<(state: string) => void> = [];

function makeShot(rng: Rng, nowMs: number, id: string): MockShot {
  const daysAgo = rng.weighted(
    [0, 1, rng.int(2, 10), rng.int(11, 60)],
    [5, 3, 3, 1],
  );
  const capturedAt = new Date(
    nowMs - daysAgo * DAY_MS - rng.int(0, 5 * HOUR_MS),
  ).toISOString();
  const scored = rng.chance(0.75);
  return {
    id,
    sessionId: rng.chance(0.3) ? `session-${rng.int(1, 5)}` : null,
    shotType: rng.pick(SHOT_TYPES),
    capturedAt,
    overallScore: scored ? rng.int(2, 9) : null,
    resultKind: scored ? 'scored' : rng.pick(['low_confidence', 'abstain']),
  };
}

function makeDrill(
  rng: Rng,
  nowMs: number,
  id: string,
): ConsistencyDrillRecord {
  const daysAgo = rng.weighted([0, 1, rng.int(2, 8)], [6, 3, 2]);
  return {
    id,
    slug: rng.pick(['contact-shadow', 'wall-dinks', 'split-step']),
    title: rng.chance(0.9) ? 'Contact Shadow Reps' : '',
    completedAtIso: new Date(
      nowMs - daysAgo * DAY_MS - rng.int(0, 4 * HOUR_MS),
    ).toISOString(),
  };
}

function generateStoreActions(
  rng: Rng,
  startMs: number,
  length: number,
): StoreAction[] {
  const actions: StoreAction[] = [];
  let clock = startMs;
  let nextId = 1;
  let currentOwner: string = rng.pick(OWNERS);
  actions.push({
    type: 'switchOwner',
    owner: currentOwner,
    awaitPending: true,
  });
  actions.push({ type: 'hydrate', await: true });
  for (let step = 2; step < length; step += 1) {
    const kind = rng.weighted(
      [
        'hydrate',
        'refresh',
        'addShot',
        'recordDrill',
        'consume',
        'dismiss',
        'switchOwner',
        'signOut',
        'advance',
        'fault',
        'corrupt',
        'mountHook',
        'setHookOwner',
        'appState',
        'unmountHook',
        'settle',
      ] as const,
      [3, 10, 16, 10, 6, 4, 5, 2, 8, 5, 2, 3, 2, 6, 2, 8],
    );
    switch (kind) {
      case 'hydrate':
        actions.push({ type: 'hydrate', await: rng.chance(0.7) });
        break;
      case 'refresh':
        actions.push({
          type: 'refresh',
          await: rng.chance(0.6),
          count: rng.weighted([1, 2, 3], [6, 3, 1]),
        });
        break;
      case 'addShot': {
        const owner = rng.chance(0.8) ? currentOwner : rng.pick(OWNERS);
        actions.push({
          type: 'addShot',
          owner,
          shot: makeShot(rng, clock, `shot-${nextId++}`),
        });
        break;
      }
      case 'recordDrill': {
        const count = rng.weighted([1, 2, 3], [6, 3, 1]);
        const drills: ConsistencyDrillRecord[] = [];
        for (let index = 0; index < count; index += 1) {
          drills.push(
            makeDrill(
              rng,
              clock,
              rng.chance(0.15) && nextId > 1
                ? `drill-${rng.int(1, nextId - 1)}`
                : `drill-${nextId++}`,
            ),
          );
        }
        actions.push({ type: 'recordDrill', drills, await: rng.chance(0.7) });
        break;
      }
      case 'consume':
        actions.push({ type: 'consumeDaySecured' });
        break;
      case 'dismiss':
        actions.push({ type: 'dismissCelebration' });
        break;
      case 'switchOwner': {
        currentOwner = rng.pick(OWNERS);
        actions.push({
          type: 'switchOwner',
          owner: currentOwner,
          awaitPending: rng.chance(0.5),
        });
        break;
      }
      case 'signOut':
        actions.push({ type: 'signOut' });
        break;
      case 'advance': {
        const ms = rng.weighted(
          [
            rng.int(1, HOUR_MS),
            rng.int(HOUR_MS, DAY_MS),
            rng.int(DAY_MS, 3 * DAY_MS),
          ],
          [3, 4, 3],
        );
        clock += ms;
        actions.push({ type: 'advanceClock', ms });
        break;
      }
      case 'fault':
        actions.push({
          type: 'fault',
          fault: rng.pick(['kvRead', 'kvWrite', 'shotsRead'] as const),
          on: rng.chance(0.5),
        });
        break;
      case 'corrupt':
        actions.push({
          type: 'corruptLedger',
          owner: rng.pick(OWNERS),
          raw: rng.pick([
            '{not json',
            '[]',
            '{"drills":"nope","celebrated":[1]}',
            'null',
            '{"drills":[{"id":"","completedAtIso":"x"}],"daySecuredShownDay":5}',
          ]),
        });
        break;
      case 'mountHook':
        actions.push({
          type: 'mountHook',
          owner: rng.chance(0.8) ? currentOwner : null,
        });
        break;
      case 'setHookOwner':
        actions.push({
          type: 'setHookOwner',
          owner: rng.chance(0.7) ? currentOwner : null,
        });
        break;
      case 'appState':
        actions.push({
          type: 'appState',
          state: rng.weighted(
            ['active', 'background', 'inactive'] as const,
            [5, 3, 1],
          ),
        });
        break;
      case 'unmountHook':
        actions.push({ type: 'unmountHook' });
        break;
      case 'settle':
        actions.push({ type: 'settle' });
        break;
    }
  }
  return actions;
}

function describe_(action: StoreAction): string {
  switch (action.type) {
    case 'addShot':
      return `addShot ${action.owner.slice(0, 4)} ${action.shot.id}@${action.shot.capturedAt} ${action.shot.resultKind}`;
    case 'recordDrill':
      return `recordDrill${action.await ? '' : '(no-await)'} ${action.drills.map(d => `${d.id}@${d.completedAtIso}`).join(',')}`;
    case 'switchOwner':
      return `switchOwner ${action.owner.slice(0, 4)}${action.awaitPending ? '' : ' (mid-flight)'}`;
    case 'corruptLedger':
      return `corruptLedger ${action.owner.slice(0, 4)} ${JSON.stringify(action.raw)}`;
    case 'mountHook':
    case 'setHookOwner':
      return `${action.type} ${action.owner ? action.owner.slice(0, 4) : 'null'}`;
    case 'refresh':
      return `refresh ×${action.count}${action.await ? '' : ' (no-await)'}`;
    case 'hydrate':
      return `hydrate${action.await ? '' : ' (no-await)'}`;
    case 'advanceClock':
      return `advanceClock +${action.ms}ms`;
    case 'fault':
      return `fault ${action.fault}=${action.on}`;
    case 'appState':
      return `appState ${action.state}`;
    default:
      return action.type;
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

interface StepRecord {
  step: number;
  action: string;
  owner: string;
  fingerprint: string;
}

interface StoreRunResult {
  violations: Violation[];
  trace: StepRecord[];
  traceHash: string;
  refreshes: number;
}

function resetWorld(seed: number, startMs: number): void {
  mockDb.kv.clear();
  mockDb.shots.clear();
  mockDb.faults.kvRead = false;
  mockDb.faults.kvWrite = false;
  mockDb.faults.shotsRead = false;
  mockDb.setKvCalls = 0;
  mockDb.setKvFailures = 0;
  const latencyRng = new Rng(seed ^ 0x2545f491);
  mockDb.latency = () => latencyRng.weighted([0, 1, 2, 5], [4, 3, 2, 1]);
  appStateHandlers = [];
  jest.setSystemTime(startMs);
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useConsistencyStore.setState({
    hydrated: false,
    ownerKey: null,
    snapshot: null,
    loadError: false,
    celebration: null,
    daySecured: null,
  });
}

async function runStoreActions(
  seed: number,
  startMs: number,
  actions: readonly StoreAction[],
  options: { stopWhen?: (v: Violation) => boolean } = {},
): Promise<StoreRunResult> {
  resetWorld(seed, startMs);
  const model: StoreModel = {
    expectedDrills: new Map(),
    attemptedDrills: new Map(),
    celebrated: new Map(),
    lastCelebration: null,
    consumed: new Map(),
  };
  const violations: Violation[] = [];
  const trace: StepRecord[] = [];
  const pending: Promise<unknown>[] = [];
  let refreshes = 0;
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  let hookOwner: string | null = null;
  let hydrates = 0;
  const faultTag = () => {
    const on = (Object.keys(mockDb.faults) as Array<keyof FaultState>).filter(
      k => mockDb.faults[k],
    );
    return on.length > 0 ? ` [faults: ${on.join(',')}]` : '';
  };
  const originalRefresh = useConsistencyStore.getState().refresh;
  const originalHydrate = useConsistencyStore.getState().hydrate;
  const countingRefresh = async () => {
    refreshes += 1;
    return originalRefresh();
  };
  const countingHydrate = async () => {
    hydrates += 1;
    return originalHydrate();
  };
  useConsistencyStore.setState({
    refresh: countingRefresh,
    hydrate: countingHydrate,
  });
  const spy = jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, handler) => {
      const typed = handler as (state: string) => void;
      appStateHandlers.push(typed);
      return {
        remove: () => {
          appStateHandlers = appStateHandlers.filter(h => h !== typed);
        },
      } as ReturnType<typeof AppState.addEventListener>;
    });

  const store = () => useConsistencyStore.getState();
  const track = (promise: Promise<unknown>) => {
    const guarded = promise.catch(error => {
      violations.push({
        step: currentStep,
        invariant: 'ST-08-no-reject',
        detail: String(error),
      });
    });
    pending.push(guarded);
    return guarded;
  };
  let currentStep = 0;

  /**
   * `fresh` = the action just awaited a refresh of the ACTIVE owner and
   * everything in flight has landed, so the surfaced state must equal a pure
   * replay of the current facts. Between refreshes the snapshot is allowed to
   * be stale (background syncs mutate the DB without notifying the store).
   */
  const check = (step: number, action: StoreAction, fresh: boolean) => {
    const fail = (invariant: string, detail: string) =>
      violations.push({ step, invariant, detail: `${detail}${faultTag()}` });
    const owner = getActiveDataOwner();
    const state = store();
    const readable = !mockDb.faults.kvRead && !mockDb.faults.shotsRead;

    if (owner === SIGNED_OUT_DATA_OWNER) {
      if (fresh && state.snapshot !== null) {
        fail(
          'ST-02-signed-out-snapshot',
          `snapshot present while signed out (ownerKey ${state.ownerKey})`,
        );
      }
    } else {
      if (fresh && state.ownerKey !== owner) {
        fail(
          'ST-02-ownerKey',
          `ownerKey ${state.ownerKey} vs active ${owner} after an awaited refresh`,
        );
      }
      if (fresh && !mockDb.faults.shotsRead && state.loadError) {
        fail(
          'ST-07-loadError-stale',
          'loadError true after an awaited refresh with readable facts',
        );
      }
      if (fresh && mockDb.faults.shotsRead && !state.loadError) {
        fail(
          'ST-07-loadError-missing',
          'shots unreadable but loadError false after an awaited refresh',
        );
      }
      const facts = activitiesFor(owner);
      if (fresh && state.ownerKey === owner && !state.loadError && readable) {
        if (!state.snapshot) {
          fail(
            'ST-01-snapshot-missing',
            'no snapshot after an awaited refresh with readable facts',
          );
        }
      }
      if (
        fresh &&
        state.ownerKey === owner &&
        state.snapshot &&
        !state.loadError &&
        readable
      ) {
        const expected = expectedSnapshot(owner);
        if (
          snapshotFingerprint(expected) !== snapshotFingerprint(state.snapshot)
        ) {
          // Allow only the documented tie/rounding order effects (engine
          // lens INV-02b/c); anything else is a real divergence.
          const relax = (s: ConsistencySnapshot) =>
            stableJson({
              ...s,
              earned: [...s.earned].sort((a, b) => (a.id < b.id ? -1 : 1)),
              days: Object.fromEntries(
                Object.entries(s.days).map(([k, d]) => [
                  k,
                  {
                    ...d,
                    scoreAvg: null,
                    activities: d.activities.map(a => stableJson(a)).sort(),
                  },
                ]),
              ),
            });
          if (relax(expected) !== relax(state.snapshot)) {
            fail(
              'ST-01-snapshot-replay',
              `store snapshot ≠ engine replay of ${owner.slice(0, 4)} facts (${facts.length} activities): store total=${state.snapshot.totalActivities} streak=${state.snapshot.currentStreak} expected total=${expected.totalActivities} streak=${expected.currentStreak}`,
            );
          }
        }
        if (state.snapshot.totalActivities > facts.length) {
          fail(
            'ST-03-leak-count',
            `snapshot has ${state.snapshot.totalActivities} activities, owner has ${facts.length}`,
          );
        }
      }
      // ST-03 kv isolation: the owner's ledger only holds ids recorded for it.
      for (const candidate of OWNERS) {
        const ledger = parseConsistencyLedger(
          mockDb.kv.get(consistencyKeyForOwner(candidate)) ?? null,
        );
        const ids = ledger.drills.map(d => d.id);
        if (new Set(ids).size !== ids.length)
          fail(
            'ST-04-drill-unique',
            `${candidate.slice(0, 4)} ledger has duplicate drill ids`,
          );
        if (ids.length > 2000)
          fail(
            'ST-04-drill-cap',
            `${candidate.slice(0, 4)} ledger has ${ids.length} drills`,
          );
        const attempted = model.attemptedDrills.get(candidate);
        for (const id of ids) {
          if (!attempted?.has(id)) {
            fail(
              'ST-03-cross-owner-drill',
              `drill ${id} never recorded for ${candidate.slice(0, 4)} but present in its ledger`,
            );
          }
        }
        // ST-05: celebrated ids must be earned by that owner (at that clock).
        if (readable) {
          const earned = new Set(
            expectedSnapshot(candidate).earned.map(e => e.id),
          );
          for (const id of Object.keys(ledger.celebrated)) {
            if (!earned.has(id))
              fail(
                'ST-05-celebrated-not-earned',
                `${candidate.slice(0, 4)} celebrated ${id} but has not earned it`,
              );
          }
        }
      }
      if (action.type !== 'fault' && !mockDb.faults.kvWrite) {
        const expectedForOwner = model.expectedDrills.get(owner);
        if (expectedForOwner) {
          const ledger = parseConsistencyLedger(
            mockDb.kv.get(consistencyKeyForOwner(owner)) ?? null,
          );
          const present = new Set(ledger.drills.map(d => d.id));
          for (const id of expectedForOwner.keys()) {
            if (!present.has(id))
              fail(
                'ST-04-drill-lost',
                `drill ${id} (recorded fault-free, awaited) missing from ${owner.slice(0, 4)} ledger`,
              );
          }
        }
      }
    }

    // ST-05: a NEW celebration object (the modal re-opens per object) must
    // not repeat an id already celebrated for the owner it is shown under.
    const celebration = state.celebration;
    if (celebration && state.ownerKey) {
      if (model.lastCelebration !== celebration) {
        const seen = model.celebrated.get(state.ownerKey) ?? new Set<string>();
        if (seen.has(celebration.achievementId)) {
          fail(
            'ST-05-repeat-celebration',
            `${celebration.achievementId} celebrated again for ${state.ownerKey.slice(0, 4)}`,
          );
        }
        seen.add(celebration.achievementId);
        model.celebrated.set(state.ownerKey, seen);
        model.lastCelebration = celebration;
      }
      // ST-05b: after an awaited refresh the pending ceremony must belong to
      // the active owner (signed-out: none; signed-in: an earned id).
      if (fresh) {
        if (owner === SIGNED_OUT_DATA_OWNER) {
          fail(
            'ST-05b-celebration-scope',
            `${celebration.achievementId} still pending while signed out`,
          );
        } else if (readable && state.ownerKey === owner) {
          const earned = new Set(expectedSnapshot(owner).earned.map(e => e.id));
          if (!earned.has(celebration.achievementId)) {
            fail(
              'ST-05b-celebration-scope',
              `${celebration.achievementId} pending for ${owner.slice(0, 4)} who has not earned it`,
            );
          }
        }
      }
    } else if (!celebration) {
      model.lastCelebration = null;
    }

    void action;
  };

  const applyAction = async (step: number, action: StoreAction) => {
    switch (action.type) {
      case 'hydrate': {
        const p = track(store().hydrate());
        if (action.await) await p;
        break;
      }
      case 'refresh': {
        const ps: Promise<unknown>[] = [];
        for (let index = 0; index < action.count; index += 1)
          ps.push(track(store().refresh()));
        if (action.await) await Promise.all(ps);
        break;
      }
      case 'addShot': {
        const list = mockDb.shots.get(action.owner) ?? [];
        list.push(action.shot);
        mockDb.shots.set(action.owner, list);
        break;
      }
      case 'recordDrill': {
        const owner = getActiveDataOwner();
        const faultFree = !mockDb.faults.kvRead && !mockDb.faults.kvWrite;
        if (owner !== SIGNED_OUT_DATA_OWNER) {
          const attempted =
            model.attemptedDrills.get(owner) ?? new Set<string>();
          for (const drill of action.drills) attempted.add(drill.id);
          model.attemptedDrills.set(owner, attempted);
        }
        const ps = action.drills.map(drill =>
          track(store().recordDrillCompletion(drill)),
        );
        if (action.await) {
          await Promise.all(ps);
          if (
            owner !== SIGNED_OUT_DATA_OWNER &&
            faultFree &&
            getActiveDataOwner() === owner &&
            !mockDb.faults.kvRead &&
            !mockDb.faults.kvWrite
          ) {
            const map =
              model.expectedDrills.get(owner) ??
              new Map<string, ConsistencyDrillRecord>();
            for (const drill of action.drills)
              if (!map.has(drill.id)) map.set(drill.id, drill);
            model.expectedDrills.set(owner, map);
          }
        }
        break;
      }
      case 'consumeDaySecured': {
        const owner = getActiveDataOwner();
        const before = mockDb.setKvCalls;
        const failuresBefore = mockDb.setKvFailures;
        const moment = store().consumeDaySecured();
        if (moment && owner !== SIGNED_OUT_DATA_OWNER) {
          await settle();
          const persisted =
            mockDb.setKvCalls > before &&
            mockDb.setKvFailures === failuresBefore &&
            !mockDb.faults.kvRead;
          const set = model.consumed.get(owner) ?? new Set<string>();
          if (set.has(moment.day)) {
            violations.push({
              step,
              invariant: 'ST-06-day-secured-twice',
              detail: `Day secured for ${moment.day} (streak ${moment.streak}) consumed twice for ${owner.slice(0, 4)}${faultTag()}`,
            });
          }
          if (persisted) set.add(moment.day);
          model.consumed.set(owner, set);
          if (
            moment.day !== store().snapshot?.asOfDay &&
            store().ownerKey === owner
          ) {
            violations.push({
              step,
              invariant: 'ST-06-day-secured-stale',
              detail: `moment day ${moment.day} vs asOfDay ${store().snapshot?.asOfDay}${faultTag()}`,
            });
          }
        }
        break;
      }
      case 'dismissCelebration':
        store().dismissCelebration();
        break;
      case 'switchOwner': {
        if (action.awaitPending) await Promise.all(pending);
        setActiveDataOwner(action.owner);
        break;
      }
      case 'signOut':
        setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
        break;
      case 'advanceClock':
        jest.setSystemTime(Date.now() + action.ms);
        break;
      case 'fault':
        mockDb.faults[action.fault] = action.on;
        break;
      case 'corruptLedger':
        mockDb.kv.set(consistencyKeyForOwner(action.owner), action.raw);
        // Corruption wipes the ledger by design (parse → empty): drills are
        // gone and every ceremony may legitimately replay.
        model.expectedDrills.delete(action.owner);
        model.celebrated.delete(action.owner);
        model.consumed.delete(action.owner);
        break;
      case 'mountHook': {
        hookOwner = action.owner;
        const before = hydrates;
        await act(async () => {
          if (renderer) renderer.unmount();
          renderer = TestRenderer.create(<HookHost owner={hookOwner} />);
        });
        await settle();
        if (hookOwner && hydrates === before) {
          violations.push({
            step,
            invariant: 'ST-08-hook-hydrates',
            detail: 'mount with an owner did not hydrate/refresh',
          });
        }
        if (appStateHandlers.length !== 1) {
          violations.push({
            step,
            invariant: 'ST-08-hook-listener',
            detail: `${appStateHandlers.length} AppState listeners after mount`,
          });
        }
        break;
      }
      case 'setHookOwner': {
        if (!renderer) break;
        const before = hydrates;
        const changed = hookOwner !== action.owner;
        hookOwner = action.owner;
        await act(async () => {
          renderer!.update(<HookHost owner={hookOwner} />);
        });
        await settle();
        if (changed && hookOwner && hydrates === before) {
          violations.push({
            step,
            invariant: 'ST-08-hook-rehydrates',
            detail: 'owner change did not re-hydrate',
          });
        }
        break;
      }
      case 'appState': {
        const before = refreshes;
        const handlers = [...appStateHandlers];
        for (const handler of handlers) handler(action.state);
        await settle();
        if (renderer && handlers.length > 0) {
          if (action.state === 'active' && refreshes === before) {
            violations.push({
              step,
              invariant: 'ST-08-foreground-refresh',
              detail: 'AppState active did not refresh',
            });
          }
          if (action.state !== 'active' && refreshes !== before) {
            violations.push({
              step,
              invariant: 'ST-08-background-no-refresh',
              detail: `AppState ${action.state} triggered refresh`,
            });
          }
        }
        break;
      }
      case 'unmountHook': {
        if (!renderer) break;
        await act(async () => {
          renderer!.unmount();
        });
        renderer = null;
        if (appStateHandlers.length !== 0) {
          violations.push({
            step,
            invariant: 'ST-08-hook-cleanup',
            detail: `${appStateHandlers.length} AppState listeners after unmount`,
          });
        }
        break;
      }
      case 'settle':
        await Promise.all(pending);
        await settle();
        break;
    }
  };

  try {
    for (let index = 0; index < actions.length; index += 1) {
      const action = actions[index]!;
      currentStep = index + 1;
      const ownerBefore = getActiveDataOwner();
      const refreshesBefore = refreshes;
      try {
        await applyAction(currentStep, action);
      } catch (error) {
        violations.push({
          step: currentStep,
          invariant: 'ST-08-no-throw',
          detail: `${describe_(action)} → ${String(error)}`,
        });
      }
      // Observe after the action and again after everything in flight lands.
      // `fresh` = at least one refresh ran to completion during this step and
      // the active owner did not change under it (a duplicate drill id skips
      // the refresh entirely; a mid-flight owner change discards the result).
      check(currentStep, action, false);
      await Promise.all(pending);
      await settle();
      const fresh =
        refreshes > refreshesBefore && getActiveDataOwner() === ownerBefore;
      check(currentStep, action, fresh);
      const state = store();
      trace.push({
        step: currentStep,
        action: describe_(action),
        owner: getActiveDataOwner().slice(0, 4),
        fingerprint: fnv1a(
          stableJson({
            ownerKey: state.ownerKey,
            hydrated: state.hydrated,
            loadError: state.loadError,
            snapshot: state.snapshot
              ? snapshotFingerprint(state.snapshot)
              : null,
            celebration: state.celebration?.achievementId ?? null,
            daySecured: state.daySecured?.day ?? null,
            kv: [...mockDb.kv.entries()].sort(),
            refreshes,
          }),
        ),
      });
      if (options.stopWhen && violations.some(options.stopWhen)) break;
    }
  } finally {
    if (renderer) {
      await act(async () => {
        (renderer as TestRenderer.ReactTestRenderer).unmount();
      });
    }
    spy.mockRestore();
    await Promise.all(pending);
    await settle();
    useConsistencyStore.setState({
      refresh: originalRefresh,
      hydrate: originalHydrate,
    });
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  }

  return {
    violations,
    trace,
    traceHash: stableJson(trace.map(t => t.fingerprint)),
    refreshes,
  };
}

interface Sequence {
  seed: number;
  startMs: number;
  actions: StoreAction[];
}

function generateSequence(seed: number): Sequence {
  const rng = new Rng(seed);
  const startMs = Date.UTC(2026, 0, 1) + rng.int(0, 400 * DAY_MS);
  const length = rng.int(5, 60);
  return { seed, startMs, actions: generateStoreActions(rng, startMs, length) };
}

interface SeedRow {
  seed: number;
  index: number;
  length: number;
  /** BROKEN = a fatal violation; BROKEN-KNOWN = only known-defect invariants fired. */
  outcome: 'HELD' | 'BROKEN' | 'BROKEN-KNOWN';
  deterministic: boolean;
  traceHash: string;
  refreshes: number;
  violations: Violation[];
  minimized?: {
    length: number;
    actions: string[];
    probes: number;
    violation: Violation;
  };
}

async function runIteration(seed: number, index: number): Promise<SeedRow> {
  const sequence = generateSequence(seed);
  const result = await runStoreActions(
    seed,
    sequence.startMs,
    sequence.actions,
  );
  const again = generateSequence(seed);
  const replay = await runStoreActions(seed, again.startMs, again.actions);
  const deterministic =
    replay.traceHash === result.traceHash &&
    stableJson(again.actions) === stableJson(sequence.actions) &&
    stableJson(replay.violations) === stableJson(result.violations);
  const fatal = result.violations.filter(v => !KNOWN_DEFECTS.has(v.invariant));
  const row: SeedRow = {
    seed,
    index,
    length: sequence.actions.length,
    outcome:
      result.violations.length === 0 && deterministic
        ? 'HELD'
        : fatal.length > 0 || !deterministic
          ? 'BROKEN'
          : 'BROKEN-KNOWN',
    deterministic,
    traceHash: fnv1a(result.traceHash),
    refreshes: result.refreshes,
    violations: result.violations.slice(0, 20),
  };
  if (!deterministic) {
    row.violations.unshift({
      step: -1,
      invariant: 'ST-09-determinism',
      detail: 'same seed → different trace',
    });
  }
  if (result.violations.length > 0) {
    const target = (fatal[0] ?? result.violations[0]!).invariant;
    const isTarget = (v: Violation) => v.invariant === target;
    let probes = 0;
    // Async ddmin: probe sequentially (the store is a process singleton).
    let current = [...sequence.actions];
    let chunk = Math.max(1, Math.floor(current.length / 2));
    while (chunk >= 1 && probes < 120) {
      let removedAny = false;
      for (let start = 0; start < current.length && probes < 120;) {
        const candidate = [
          ...current.slice(0, start),
          ...current.slice(start + chunk),
        ];
        probes += 1;
        const probe = await runStoreActions(seed, sequence.startMs, candidate, {
          stopWhen: isTarget,
        });
        if (
          candidate.length < current.length &&
          probe.violations.some(isTarget)
        ) {
          current = candidate;
          removedAny = true;
        } else {
          start += chunk;
        }
      }
      if (!removedAny) {
        if (chunk === 1) break;
        chunk = Math.floor(chunk / 2);
      }
    }
    const probe = await runStoreActions(seed, sequence.startMs, current, {
      stopWhen: isTarget,
    });
    row.minimized = {
      length: current.length,
      actions: [
        `init clock=${new Date(sequence.startMs).toISOString()} tz=${deviceTimeZone()}`,
        ...current.map(describe_),
      ],
      probes,
      violation: probe.violations.find(isTarget) ?? result.violations[0]!,
    };
  }
  return row;
}

describe('consistency store + bootstrap — seeded randomized long-run', () => {
  const rows: SeedRow[] = [];
  const startedAt = Date.now();

  beforeAll(() => {
    jest.useFakeTimers({
      doNotFake: [
        'setImmediate',
        'clearImmediate',
        'nextTick',
        'queueMicrotask',
      ],
      now: Date.UTC(2026, 0, 1),
    });
  });

  afterAll(() => {
    jest.useRealTimers();
    const broken = rows.filter(row => row.outcome !== 'HELD');
    const byInvariant: Record<string, number> = {};
    for (const row of broken) {
      for (const v of row.violations)
        byInvariant[v.invariant] = (byInvariant[v.invariant] ?? 0) + 1;
    }
    writeArtifact(OUT_DIR, 'consistency-store-randomized-seeded.json', {
      unit: 'mod-consistency-engine',
      lens: 'randomized-seeded',
      target: 'store + useConsistencyBootstrap',
      campaignSeed: CAMPAIGN_SEED,
      timeZone: deviceTimeZone(),
      iterations: rows.length,
      only: ONLY ?? null,
      strict: STRICT,
      knownDefects: [...KNOWN_DEFECTS],
      sequencesHeld: rows.length - broken.length,
      sequencesBroken: rows.filter(row => row.outcome === 'BROKEN').length,
      sequencesBrokenKnown: rows.filter(row => row.outcome === 'BROKEN-KNOWN')
        .length,
      stepsExecuted: rows.reduce((sum, row) => sum + row.length, 0),
      determinismReplays: rows.length,
      nonDeterministicSeeds: rows
        .filter(r => !r.deterministic)
        .map(r => r.seed),
      violationsByInvariant: byInvariant,
      failingSeeds: broken.map(row => ({
        seed: row.seed,
        firstViolation: row.violations[0],
        minimized: row.minimized,
      })),
      durationMs: Date.now() - startedAt,
      rows,
    });
  });

  if (ONLY !== undefined) {
    it(`replays seed ${ONLY} with a full trace`, async () => {
      const seed = Number(ONLY);
      const sequence = generateSequence(seed);
      const result = await runStoreActions(
        seed,
        sequence.startMs,
        sequence.actions,
      );
      const row = await runIteration(seed, -1);
      rows.push(row);
      writeArtifact(OUT_DIR, `consistency-store-seed-${seed}.json`, {
        seed,
        startIso: new Date(sequence.startMs).toISOString(),
        actions: sequence.actions.map(describe_),
        trace: result.trace,
        violations: result.violations,
        minimized: row.minimized ?? null,
      });
      expect(
        row.violations.filter(v => !KNOWN_DEFECTS.has(v.invariant)),
      ).toEqual([]);
    });
    return;
  }

  it(`holds every store/bootstrap invariant across ${ITER} seeded sequences`, async () => {
    for (let index = 0; index < ITER; index += 1) {
      rows.push(
        await runIteration(
          iterationSeed(CAMPAIGN_SEED ^ 0x51ed270b, index),
          index,
        ),
      );
    }
    const broken = rows.filter(row => row.outcome === 'BROKEN');
    expect(
      broken.map(row => ({
        seed: row.seed,
        first:
          row.violations.find(v => !KNOWN_DEFECTS.has(v.invariant)) ??
          row.violations[0],
        minimized: row.minimized?.actions,
        minimizedViolation: row.minimized?.violation,
      })),
    ).toEqual([]);
  }, 600_000);
});
