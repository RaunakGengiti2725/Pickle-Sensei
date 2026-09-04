/**
 * STRESS — consistency store + bootstrap hook, lens: boundary / malformed
 * input with fault injection.
 *
 * The store is the handler between SQLite (kv ledger + shot rows) and the
 * UI. Under a corrupt ledger, hostile shot rows, a throwing / lying
 * repository, owner switches mid-flight, foreground storms and clock jumps
 * it must: never reject out of `hydrate` / `refresh` /
 * `recordDrillCompletion` / `consumeDaySecured`, never leave an unhandled
 * rejection behind the hook's `void hydrate()`, never write to another
 * owner's key or while signed out, never lose persisted drills on a
 * rewrite, and only ever expose a finite, self-consistent snapshot.
 *
 * Seeded (mulberry32): every iteration is replayable from its seed.
 *   STRESS_ITER=<n>   iterations for the campaign (default 150, CI-fast)
 *   STRESS_OUT=<dir>  write the seed → outcome table as JSON
 */
import * as fs from 'fs';
import * as path from 'path';
import React from 'react';
import { AppState } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

interface MockShot {
  id: string;
  sessionId: string | null;
  shotType: string;
  capturedAt: string;
  overallScore: number | null;
  resultKind: string;
}
interface KvWrite {
  key: string;
  value: string;
  ownerAtWrite: string;
}
type Fault = 'ok' | 'throw' | 'reject' | 'lie';

const mockKv = new Map<string, unknown>();
const mockWrites: KvWrite[] = [];
const mockShots: MockShot[] = [];
const mockFaults = {
  getKv: 'ok' as Fault,
  setKv: 'ok' as Fault,
  shots: 'ok' as Fault,
};
const mockCounters = { getKv: 0, setKv: 0, shots: 0 };
/** While set, repository reads/writes park here until `release()` is called. */
const mockGate: {
  current: { promise: Promise<void>; release: () => void } | null;
} = { current: null };
const mockOwnerProbe = { get: (): string => '' };

function makeGate(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const promise = new Promise<void>(resolve => {
    release = resolve;
  });
  return { promise, release };
}

jest.mock('../../src/data/db', () => ({ getDb: () => ({}) }));
jest.mock('../../src/data/repository', () => ({
  getKv: async (_db: unknown, key: string) => {
    mockCounters.getKv += 1;
    if (mockFaults.getKv === 'throw')
      throw new Error('kv read failed: SQLITE_CORRUPT');
    if (mockGate.current) await mockGate.current.promise;
    if (mockFaults.getKv === 'reject') throw new Error('kv read failed late');
    if (mockFaults.getKv === 'lie') return 42;
    return mockKv.get(key) ?? null;
  },
  setKv: async (_db: unknown, key: string, value: string) => {
    mockCounters.setKv += 1;
    if (mockFaults.setKv === 'throw')
      throw new Error('kv write failed: SQLITE_FULL');
    if (mockGate.current) await mockGate.current.promise;
    if (mockFaults.setKv === 'reject') throw new Error('kv write failed late');
    mockWrites.push({ key, value, ownerAtWrite: mockOwnerProbe.get() });
    mockKv.set(key, value);
  },
  listActivityShots: async () => {
    mockCounters.shots += 1;
    if (mockFaults.shots === 'throw') throw new Error('shot query failed');
    if (mockGate.current) await mockGate.current.promise;
    if (mockFaults.shots === 'reject')
      throw new Error('shot query failed late');
    if (mockFaults.shots === 'lie') return null;
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
  parseConsistencyLedger,
  useConsistencyStore,
  type ConsistencyDrillRecord,
} from '../../src/consistency/store';
import { useConsistencyBootstrap } from '../../src/consistency/useConsistencyBootstrap';
import type { ConsistencySnapshot } from '../../src/consistency/engine';

mockOwnerProbe.get = getActiveDataOwner;

const ITER = Math.max(1, Number(process.env['STRESS_ITER'] ?? 150));
const OUT_DIR = process.env['STRESS_OUT'];

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
function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}
function int(rng: () => number, max: number): number {
  return Math.floor(rng() * max);
}

interface Row {
  seed: number;
  campaign: string;
  ledger: string;
  shots: number;
  steps: string[];
  writes: number;
  outcome: 'HELD' | 'BROKEN';
  detail?: string;
  rerunFailures?: number;
  /** Smallest {ledger, shotCount, steps} that still reproduces the same failure class. */
  minimized?: { ledger: string; shotCount: number; steps: Step[] };
}
const table: Row[] = [];
afterAll(() => {
  if (!OUT_DIR) return;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, 'store-faults.json'),
    JSON.stringify(
      {
        campaign: 'consistency-store-faults',
        iterations: table.length,
        broken: table.filter(r => r.outcome === 'BROKEN').length,
        rows: table,
      },
      null,
      1,
    ),
  );
});

// ─── Atoms ─────────────────────────────────────────────────────────────────

const OWNER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BIG = 'x'.repeat(70_000);
const HOSTILE_STRINGS = [
  '',
  '\u0000',
  BIG,
  '👨‍👩‍👧‍👦'.repeat(1_000),
  '\u00e9',
  'e\u0301',
  '__proto__',
  'constructor',
  'prototype',
  '../../etc/passwd',
  'consistency:../other-owner',
  '\ud800',
  'dink',
  'third_shot_drop',
] as const;
const HOSTILE_ISO = [
  '',
  'not-a-date',
  '12345',
  '2026-02-30T10:00:00.000Z',
  '0099-01-01T00:00:00.000Z',
  '0999-12-31T00:00:00.000Z',
  '+010000-01-01T00:00:00.000Z',
  '+275760-09-13T00:00:00.000Z',
  '1970-01-01T00:00:00.000Z',
  '2099-12-31T23:59:59.999Z',
  BIG,
] as const;
const HOSTILE_NUMBERS = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  -0,
  1e308,
  -1e308,
  5e-324,
  2 ** 53,
  -1,
  11,
] as const;

function isoDaysAgo(days: number, rng: () => number): string {
  if (days === 0)
    return new Date(Date.now() - 1_000 - int(rng, 3_600_000)).toISOString();
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

/** A row exactly as repository.ts would hand it over (String/Number coerced). */
function hostileShot(rng: () => number, index: number): MockShot {
  const hostile = rng() < 0.4;
  const scored = rng() < 0.7;
  return {
    id:
      hostile && rng() < 0.3
        ? String(pick(rng, HOSTILE_STRINGS))
        : `shot-${index}`,
    sessionId: rng() < 0.5 ? null : 'session-1',
    shotType: hostile && rng() < 0.5 ? pick(rng, HOSTILE_STRINGS) : 'dink',
    capturedAt:
      hostile && rng() < 0.5
        ? pick(rng, HOSTILE_ISO)
        : isoDaysAgo(int(rng, 12), rng),
    overallScore: scored
      ? hostile && rng() < 0.5
        ? pick(rng, HOSTILE_NUMBERS)
        : Math.round(rng() * 100) / 10
      : null,
    resultKind: scored
      ? 'scored'
      : pick(rng, ['low_confidence', 'abstain', pick(rng, HOSTILE_STRINGS)]),
  };
}

function hostileDrill(
  rng: () => number,
  index: number,
): ConsistencyDrillRecord {
  const hostile = rng() < 0.5;
  return {
    id: hostile && rng() < 0.3 ? pick(rng, HOSTILE_STRINGS) : `drill-${index}`,
    slug: hostile ? pick(rng, HOSTILE_STRINGS) : 'dink-ladder',
    title: hostile ? pick(rng, HOSTILE_STRINGS) : 'Dink ladder',
    completedAtIso:
      hostile && rng() < 0.5
        ? pick(rng, HOSTILE_ISO)
        : isoDaysAgo(int(rng, 12), rng),
  };
}

const LEDGER_STRATEGIES = [
  'absent',
  'valid',
  'truncated',
  'junk',
  'wrong-types',
  'proto-pollution',
  'future-schema',
  'oversized',
  'not-object',
  'lie-non-string',
] as const;

function validLedger(rng: () => number): Record<string, unknown> {
  return {
    version: 1,
    drills: Array.from({ length: int(rng, 6) }, (_, i) => ({
      id: `seed-drill-${i}`,
      slug: 'reset-wall',
      title: 'Reset wall',
      completedAtIso: isoDaysAgo(int(rng, 12), rng),
    })),
    celebrated: rng() < 0.5 ? { 'streak.1': '2026-01-01' } : {},
    daySecuredShownDay: null,
  };
}

function seedLedger(
  rng: () => number,
  strategy: (typeof LEDGER_STRATEGIES)[number],
): void {
  const key = consistencyKeyForOwner(OWNER_A);
  const valid = JSON.stringify(validLedger(rng));
  switch (strategy) {
    case 'absent':
      return;
    case 'valid':
      mockKv.set(key, valid);
      return;
    case 'truncated':
      mockKv.set(key, valid.slice(0, int(rng, valid.length)));
      return;
    case 'junk': {
      const bytes = Array.from({ length: int(rng, 64) }, () =>
        String.fromCharCode(int(rng, 0x10000)),
      );
      mockKv.set(key, bytes.join(''));
      return;
    }
    case 'wrong-types':
      mockKv.set(
        key,
        JSON.stringify({
          version: pick(rng, ['1', 1.5, null, [], {}]),
          drills: pick(rng, [
            null,
            'x',
            42,
            {},
            [
              null,
              1,
              'x',
              [],
              { id: 1, completedAtIso: 2 },
              { id: {}, completedAtIso: [] },
            ],
          ]),
          celebrated: pick(rng, [
            null,
            [],
            'x',
            { 'streak.1': 1 },
            { 'streak.7': null, 'streak.3': '2026-01-01' },
          ]),
          daySecuredShownDay: pick(rng, [1, {}, [], true]),
        }),
      );
      return;
    case 'proto-pollution':
      mockKv.set(
        key,
        '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"drills":[{"__proto__":{"polluted":true},"id":"d","completedAtIso":"2026-03-01T00:00:00.000Z"}],"celebrated":{"__proto__":"x","constructor":"y"}}',
      );
      return;
    case 'future-schema':
      mockKv.set(
        key,
        JSON.stringify({
          version: 2,
          drills: [
            {
              id: 'v2-drill',
              slug: 'reset-wall',
              title: 'Reset wall',
              completedAtIso: isoDaysAgo(1, rng),
              durationSec: 90,
            },
          ],
          celebrated: {},
          daySecuredShownDay: null,
          weeklyGoal: { target: 5 },
        }),
      );
      return;
    case 'oversized':
      mockKv.set(
        key,
        JSON.stringify({
          version: 1,
          drills: Array.from({ length: 2_500 }, (_, i) => ({
            id: `big-${i}`,
            slug: i % 100 === 0 ? BIG : 's',
            title: 't',
            completedAtIso: isoDaysAgo(int(rng, 12), rng),
          })),
          celebrated: {},
          daySecuredShownDay: null,
        }),
      );
      return;
    case 'not-object':
      mockKv.set(
        key,
        pick(rng, [
          'null',
          '[]',
          '"str"',
          '42',
          'true',
          '[{"id":"x","completedAtIso":"2026-03-01T00:00:00.000Z"}]',
        ]),
      );
      return;
    case 'lie-non-string':
      mockKv.set(key, pick(rng, [42, { drills: [] }, [], true]));
      return;
  }
}

// ─── Harness ───────────────────────────────────────────────────────────────

const appStateHandlers = new Set<(state: string) => void>();
/**
 * Rejections that escaped `hydrate` / `refresh` / `recordDrillCompletion`.
 * The hook fires these with `void`, so a rejection would be an unhandled
 * rejection in the app; the wrappers below record it (and swallow it so
 * the campaign can keep going and classify the seed).
 */
let unhandled: unknown[] = [];
const ORIGINAL_ACTIONS = {
  hydrate: useConsistencyStore.getState().hydrate,
  refresh: useConsistencyStore.getState().refresh,
  recordDrillCompletion: useConsistencyStore.getState().recordDrillCompletion,
};
function recordRejection<A extends unknown[]>(
  label: string,
  action: (...args: A) => Promise<void>,
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await action(...args);
    } catch (error) {
      unhandled.push(`${label} rejected: ${String(error)}`);
    }
  };
}

beforeAll(() => {
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, handler) => {
      const fn = handler as (state: string) => void;
      appStateHandlers.add(fn);
      return { remove: () => appStateHandlers.delete(fn) } as ReturnType<
        typeof AppState.addEventListener
      >;
    });
  useConsistencyStore.setState({
    hydrate: recordRejection('hydrate', ORIGINAL_ACTIONS.hydrate),
    refresh: recordRejection('refresh', ORIGINAL_ACTIONS.refresh),
    recordDrillCompletion: recordRejection(
      'recordDrillCompletion',
      ORIGINAL_ACTIONS.recordDrillCompletion,
    ),
  });
});
afterAll(() => {
  useConsistencyStore.setState(ORIGINAL_ACTIONS);
  jest.restoreAllMocks();
});

function Host({ owner }: { owner: string | null }): null {
  useConsistencyBootstrap(owner);
  return null;
}

async function settle(): Promise<void> {
  // Drain the store's serial refresh queue and any microtasks behind it.
  for (let i = 0; i < 4; i += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

async function resetWorld(): Promise<void> {
  mockGate.current?.release();
  mockGate.current = null;
  mockFaults.getKv = 'ok';
  mockFaults.setKv = 'ok';
  mockFaults.shots = 'ok';
  await settle();
  mockKv.clear();
  mockWrites.length = 0;
  mockShots.length = 0;
  mockCounters.getKv = 0;
  mockCounters.setKv = 0;
  mockCounters.shots = 0;
  appStateHandlers.clear();
  unhandled = [];
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

function snapshotViolation(
  snapshot: ConsistencySnapshot | null,
): string | null {
  if (!snapshot) return null;
  const counters = [
    snapshot.currentStreak,
    snapshot.longestStreak,
    snapshot.shieldsAvailable,
    snapshot.shieldsEarnedTotal,
    snapshot.shieldedDayCount,
    snapshot.momentumXp,
    snapshot.runXp,
    snapshot.trainedLast7,
    snapshot.totalTrainedDays,
    snapshot.totalActivities,
    snapshot.scoredAnalysisCount,
  ];
  if (
    counters.some(v => !Number.isFinite(v) || v < 0 || !Number.isInteger(v))
  ) {
    return `non-finite/negative counter: ${JSON.stringify(counters)}`;
  }
  for (const [day, record] of Object.entries(snapshot.days)) {
    if (record.scoreAvg !== null && !Number.isFinite(record.scoreAvg))
      return `${day}: scoreAvg ${record.scoreAvg}`;
    for (const activity of record.activities) {
      if (activity.score !== null && !Number.isFinite(activity.score))
        return `${day}: activity score ${activity.score}`;
      if (typeof activity.label !== 'string') return `${day}: label not string`;
    }
  }
  if (
    typeof snapshot.asOfDay !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.asOfDay)
  ) {
    return `asOfDay not a calendar day key: ${snapshot.asOfDay}`;
  }
  return null;
}

type Step =
  | 'hydrate'
  | 'refresh'
  | 'foreground'
  | 'background'
  | 'drill'
  | 'consume'
  | 'dismiss'
  | 'switch-owner-b'
  | 'switch-signed-out'
  | 'switch-owner-a'
  | 'fault-kv-throw'
  | 'fault-kv-reject'
  | 'fault-kv-lie'
  | 'fault-set-throw'
  | 'fault-set-reject'
  | 'fault-shots-throw'
  | 'fault-shots-lie'
  | 'faults-clear'
  | 'gate-open'
  | 'gate-close'
  | 'mutate-shots'
  | 'corrupt-ledger';
const STEPS: readonly Step[] = [
  'hydrate',
  'refresh',
  'refresh',
  'foreground',
  'foreground',
  'background',
  'drill',
  'drill',
  'consume',
  'dismiss',
  'switch-owner-b',
  'switch-signed-out',
  'switch-owner-a',
  'fault-kv-throw',
  'fault-kv-reject',
  'fault-kv-lie',
  'fault-set-throw',
  'fault-set-reject',
  'fault-shots-throw',
  'fault-shots-lie',
  'faults-clear',
  'faults-clear',
  'gate-open',
  'gate-close',
  'mutate-shots',
  'corrupt-ledger',
];

interface Scenario {
  seed: number;
  ledger: (typeof LEDGER_STRATEGIES)[number];
  shotCount: number;
  steps: Step[];
}

function scenarioFor(seed: number): Scenario {
  const rng = mulberry32(seed);
  return {
    seed,
    ledger: pick(rng, LEDGER_STRATEGIES),
    shotCount: int(rng, 30),
    steps: Array.from({ length: 1 + int(rng, 10) }, () => pick(rng, STEPS)),
  };
}

/** Runs one seeded scenario against the real store + hook; returns the violation, if any. */
async function runScenario(
  scenario: Scenario,
): Promise<{ detail: string | null; writes: number }> {
  const rng = mulberry32(scenario.seed ^ 0x9e3779b9);
  await resetWorld();
  seedLedger(rng, scenario.ledger);
  const persistedBefore = parseConsistencyLedger(
    typeof mockKv.get(consistencyKeyForOwner(OWNER_A)) === 'string'
      ? (mockKv.get(consistencyKeyForOwner(OWNER_A)) as string)
      : null,
  );
  for (let i = 0; i < scenario.shotCount; i += 1)
    mockShots.push(hostileShot(rng, i));
  setActiveDataOwner(OWNER_A);

  const store = useConsistencyStore;
  const pending: Array<Promise<unknown>> = [];
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Host owner={OWNER_A} />);
  });
  let drills = 0;
  const guard = (promise: Promise<unknown>, label: string): void => {
    pending.push(
      promise.then(
        () => null,
        (error: unknown) => `${label} rejected: ${String(error)}`,
      ),
    );
  };

  for (const step of scenario.steps) {
    switch (step) {
      case 'hydrate':
        guard(store.getState().hydrate(), 'hydrate');
        break;
      case 'refresh':
        guard(store.getState().refresh(), 'refresh');
        break;
      case 'foreground':
        await act(async () => {
          for (const handler of appStateHandlers) handler('active');
        });
        break;
      case 'background':
        await act(async () => {
          for (const handler of appStateHandlers)
            handler(pick(rng, ['background', 'inactive', 'unknown', '']));
        });
        break;
      case 'drill': {
        const record = hostileDrill(rng, drills);
        drills += 1;
        guard(
          store.getState().recordDrillCompletion(record),
          'recordDrillCompletion',
        );
        break;
      }
      case 'consume':
        try {
          const moment = store.getState().consumeDaySecured();
          if (moment && !Number.isFinite(moment.streak))
            return {
              detail: 'consumeDaySecured returned non-finite streak',
              writes: mockWrites.length,
            };
          if (store.getState().daySecured !== null)
            return {
              detail: 'daySecured not cleared by consume',
              writes: mockWrites.length,
            };
        } catch (error) {
          return {
            detail: `consumeDaySecured threw: ${String(error)}`,
            writes: mockWrites.length,
          };
        }
        break;
      case 'dismiss':
        store.getState().dismissCelebration();
        if (store.getState().celebration !== null)
          return {
            detail: 'celebration not cleared',
            writes: mockWrites.length,
          };
        break;
      case 'switch-owner-b':
        setActiveDataOwner(OWNER_B);
        await act(async () => {
          renderer.update(<Host owner={OWNER_B} />);
        });
        break;
      case 'switch-signed-out':
        setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
        await act(async () => {
          renderer.update(<Host owner={null} />);
        });
        break;
      case 'switch-owner-a':
        setActiveDataOwner(OWNER_A);
        await act(async () => {
          renderer.update(<Host owner={OWNER_A} />);
        });
        break;
      case 'fault-kv-throw':
        mockFaults.getKv = 'throw';
        break;
      case 'fault-kv-reject':
        mockFaults.getKv = 'reject';
        break;
      case 'fault-kv-lie':
        mockFaults.getKv = 'lie';
        break;
      case 'fault-set-throw':
        mockFaults.setKv = 'throw';
        break;
      case 'fault-set-reject':
        mockFaults.setKv = 'reject';
        break;
      case 'fault-shots-throw':
        mockFaults.shots = 'throw';
        break;
      case 'fault-shots-lie':
        mockFaults.shots = 'lie';
        break;
      case 'faults-clear':
        mockFaults.getKv = 'ok';
        mockFaults.setKv = 'ok';
        mockFaults.shots = 'ok';
        break;
      case 'gate-close':
        if (!mockGate.current) mockGate.current = makeGate();
        break;
      case 'gate-open':
        mockGate.current?.release();
        mockGate.current = null;
        break;
      case 'mutate-shots':
        mockShots.push(hostileShot(rng, mockShots.length));
        if (rng() < 0.5) mockShots.splice(int(rng, mockShots.length), 1);
        break;
      case 'corrupt-ledger':
        seedLedger(
          rng,
          pick(rng, ['truncated', 'junk', 'wrong-types', 'not-object']),
        );
        break;
    }
    // Let a few microtasks run between steps so operations genuinely overlap.
    if (rng() < 0.5) await Promise.resolve();
  }

  mockGate.current?.release();
  mockGate.current = null;
  mockFaults.getKv = 'ok';
  mockFaults.setKv = 'ok';
  mockFaults.shots = 'ok';
  const rejections = (await Promise.all(pending)).filter(
    (r): r is string => typeof r === 'string',
  );
  await act(async () => {
    await settle();
  });
  const stateBeforeUnmount = store.getState();
  await act(async () => {
    renderer.unmount();
  });
  const readsBeforeLateEvent = mockCounters.getKv + mockCounters.shots;
  for (const handler of appStateHandlers) handler('active');
  await settle();

  if (rejections.length > 0)
    return { detail: rejections[0]!, writes: mockWrites.length };
  if (unhandled.length > 0)
    return {
      detail: `unhandled rejection: ${String(unhandled[0])}`,
      writes: mockWrites.length,
    };
  if (appStateHandlers.size > 0)
    return {
      detail: 'AppState listener survived unmount',
      writes: mockWrites.length,
    };
  if (mockCounters.getKv + mockCounters.shots !== readsBeforeLateEvent) {
    return {
      detail: 'foreground after unmount still triggered a refresh',
      writes: mockWrites.length,
    };
  }
  if ('polluted' in {} || Object.keys(Object.prototype).length > 0) {
    return { detail: 'Object.prototype polluted', writes: mockWrites.length };
  }
  const violation = snapshotViolation(stateBeforeUnmount.snapshot);
  if (violation) return { detail: violation, writes: mockWrites.length };

  for (const write of mockWrites) {
    if (write.ownerAtWrite === SIGNED_OUT_DATA_OWNER)
      return {
        detail: `wrote ${write.key} while signed out`,
        writes: mockWrites.length,
      };
    if (write.key !== consistencyKeyForOwner(write.ownerAtWrite)) {
      return {
        detail: `cross-owner write: key=${write.key} active=${write.ownerAtWrite}`,
        writes: mockWrites.length,
      };
    }
    try {
      JSON.parse(write.value);
    } catch {
      return {
        detail: `wrote non-JSON to ${write.key}`,
        writes: mockWrites.length,
      };
    }
    const reparsed = parseConsistencyLedger(write.value);
    if (
      JSON.stringify(parseConsistencyLedger(JSON.stringify(reparsed))) !==
      JSON.stringify(reparsed)
    ) {
      return {
        detail: 'written ledger is not a parse fixpoint',
        writes: mockWrites.length,
      };
    }
    // A 'corrupt-ledger' step destroys the persisted drills itself, so only
    // scenarios without one can blame the store for a dropped drill.
    if (
      write.key === consistencyKeyForOwner(OWNER_A) &&
      scenario.ledger !== 'oversized' &&
      !scenario.steps.includes('corrupt-ledger')
    ) {
      const ids = new Set(reparsed.drills.map(d => d.id));
      const lost = persistedBefore.drills.find(d => !ids.has(d.id));
      if (lost)
        return {
          detail: `rewrite dropped persisted drill ${lost.id}`,
          writes: mockWrites.length,
        };
    }
  }
  return { detail: null, writes: mockWrites.length };
}

/** Failure class: same message modulo dates/numbers (a minimized case must stay in it). */
function failureClass(detail: string): string {
  return detail
    .replace(/-?\d{1,6}-\d{2}-\d{2}/g, 'D')
    .replace(/-?\d+(\.\d+)?/g, 'N');
}

/** Greedy delta-debugging over steps and shot count (shots first, then steps). */
async function minimizeScenario(
  scenario: Scenario,
  detail: string,
): Promise<Scenario> {
  const wanted = failureClass(detail);
  const stillFails = async (candidate: Scenario): Promise<boolean> => {
    const result = await runScenario(candidate);
    return result.detail !== null && failureClass(result.detail) === wanted;
  };
  let best = scenario;
  for (const shotCount of [0, 1, 2, 4, 8, 16]) {
    if (shotCount >= best.shotCount) break;
    const candidate = { ...best, shotCount };
    if (await stillFails(candidate)) {
      best = candidate;
      break;
    }
  }
  for (let i = 0; i < best.steps.length;) {
    const steps = best.steps.filter((_, k) => k !== i);
    const candidate = { ...best, steps };
    if (await stillFails(candidate)) best = candidate;
    else i += 1;
  }
  return best;
}

// ─── Campaign ──────────────────────────────────────────────────────────────

describe('consistency store + bootstrap hook under faults and malformed persisted state', () => {
  it(`seeded fault-injection sequences never reject, never cross owners, never leave a bad snapshot (${ITER} seeded cases)`, async () => {
    const failures: Row[] = [];
    for (let iteration = 0; iteration < ITER; iteration += 1) {
      const seed = 12_000_000 + iteration;
      const scenario = scenarioFor(seed);
      const result = await runScenario(scenario);
      const row: Row = {
        seed,
        campaign: 'store-faults',
        ledger: scenario.ledger,
        shots: scenario.shotCount,
        steps: scenario.steps,
        writes: result.writes,
        outcome: result.detail ? 'BROKEN' : 'HELD',
      };
      if (result.detail) {
        row.detail = result.detail;
        let rerunFailures = 0;
        for (let i = 0; i < 10; i += 1) {
          if ((await runScenario(scenario)).detail) rerunFailures += 1;
        }
        row.rerunFailures = rerunFailures;
        const small = await minimizeScenario(scenario, result.detail);
        row.minimized = {
          ledger: small.ledger,
          shotCount: small.shotCount,
          steps: small.steps,
        };
        failures.push(row);
      }
      table.push(row);
    }
    await resetWorld();
    expect(failures).toEqual([]);
  }, 600_000);

  it('null owner: the hook neither hydrates nor reads storage; unmount removes the listener', async () => {
    await resetWorld();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Host owner={null} />);
    });
    expect(mockCounters.getKv + mockCounters.shots).toBe(0);
    expect(useConsistencyStore.getState().hydrated).toBe(false);
    expect(appStateHandlers.size).toBe(1);
    await act(async () => {
      renderer.unmount();
    });
    expect(appStateHandlers.size).toBe(0);
  });

  it('foreground with a throwing repository never surfaces a rejection from the hook', async () => {
    await resetWorld();
    setActiveDataOwner(OWNER_A);
    mockFaults.shots = 'throw';
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Host owner={OWNER_A} />);
    });
    await act(async () => {
      for (let i = 0; i < 25; i += 1)
        for (const handler of appStateHandlers) handler('active');
      await settle();
    });
    expect(unhandled).toEqual([]);
    expect(useConsistencyStore.getState().loadError).toBe(true);
    expect(useConsistencyStore.getState().hydrated).toBe(true);
    expect(mockWrites).toEqual([]);
    mockFaults.shots = 'ok';
    mockShots.push({
      id: 's',
      sessionId: null,
      shotType: 'dink',
      capturedAt: new Date(Date.now() - 1000).toISOString(),
      overallScore: 6,
      resultKind: 'scored',
    });
    await act(async () => {
      for (const handler of appStateHandlers) handler('active');
      await settle();
    });
    expect(useConsistencyStore.getState().loadError).toBe(false);
    expect(useConsistencyStore.getState().snapshot?.trainedToday).toBe(true);
    await act(async () => {
      renderer.unmount();
    });
  });

  it('owner switch while the ledger read is parked never writes or publishes under the old owner', async () => {
    await resetWorld();
    setActiveDataOwner(OWNER_A);
    mockShots.push({
      id: 's',
      sessionId: null,
      shotType: 'dink',
      capturedAt: new Date(Date.now() - 1000).toISOString(),
      overallScore: 6,
      resultKind: 'scored',
    });
    mockGate.current = makeGate();
    const hydrateA = useConsistencyStore.getState().hydrate();
    await Promise.resolve();
    setActiveDataOwner(OWNER_B);
    mockGate.current.release();
    mockGate.current = null;
    await hydrateA;
    await settle();
    expect(
      mockWrites.filter(w => w.key === consistencyKeyForOwner(OWNER_A)),
    ).toEqual([]);
    expect(useConsistencyStore.getState().snapshot).toBeNull();
    // Signed out mid-flight: same rule.
    setActiveDataOwner(OWNER_A);
    mockGate.current = makeGate();
    const hydrateAgain = useConsistencyStore.getState().hydrate();
    await Promise.resolve();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    mockGate.current.release();
    mockGate.current = null;
    await hydrateAgain;
    await settle();
    expect(mockWrites).toEqual([]);
    expect(useConsistencyStore.getState().snapshot).toBeNull();
  });

  it('a FUTURE-schema ledger never throws, keeps its drills, and is rewritten as parseable JSON (observed downgrade recorded)', async () => {
    await resetWorld();
    setActiveDataOwner(OWNER_A);
    mockShots.push({
      id: 's',
      sessionId: null,
      shotType: 'dink',
      capturedAt: new Date(Date.now() - 1000).toISOString(),
      overallScore: 6,
      resultKind: 'scored',
    });
    const v2 = {
      version: 2,
      drills: [
        {
          id: 'v2-drill',
          slug: 'reset-wall',
          title: 'Reset wall',
          completedAtIso: new Date(Date.now() - 2000).toISOString(),
          durationSec: 90,
        },
      ],
      celebrated: {},
      daySecuredShownDay: null,
      weeklyGoal: { target: 5 },
    };
    mockKv.set(consistencyKeyForOwner(OWNER_A), JSON.stringify(v2));
    await useConsistencyStore.getState().hydrate();
    await settle();
    expect(unhandled).toEqual([]);
    expect(mockWrites).toHaveLength(1);
    const written = JSON.parse(mockWrites[0]!.value) as Record<string, unknown>;
    const drills = written['drills'] as Array<Record<string, unknown>>;
    expect(drills.map(d => d['id'])).toEqual(['v2-drill']);
    const kept = {
      version: written['version'],
      weeklyGoal: written['weeklyGoal'] ?? null,
      durationSec: drills[0]?.['durationSec'] ?? null,
    };
    table.push({
      seed: 0,
      campaign: 'future-schema',
      ledger: 'future-schema',
      shots: 1,
      steps: ['hydrate'],
      writes: mockWrites.length,
      outcome: 'HELD',
      detail: `v2 ledger rewritten as ${JSON.stringify(kept)} (version 2 + unknown fields ${
        kept.version === 2 && kept.weeklyGoal !== null ? 'kept' : 'DROPPED'
      })`,
    });
  });

  it('a 70KB drill title is persisted verbatim (no byte cap on the ledger row)', async () => {
    await resetWorld();
    setActiveDataOwner(OWNER_A);
    await useConsistencyStore.getState().recordDrillCompletion({
      id: 'big',
      slug: 'big',
      title: BIG,
      completedAtIso: new Date(Date.now() - 1000).toISOString(),
    });
    await settle();
    const stored = mockKv.get(consistencyKeyForOwner(OWNER_A));
    expect(typeof stored).toBe('string');
    table.push({
      seed: 0,
      campaign: 'byte-cap',
      ledger: 'absent',
      shots: 0,
      steps: ['drill'],
      writes: mockWrites.length,
      outcome: 'HELD',
      detail: `ledger row bytes after one 70KB-title drill: ${(stored as string).length}`,
    });
    expect((stored as string).length).toBeGreaterThan(70_000);
  });

  async function hydrateWithOneShotToday(): Promise<number> {
    await resetWorld();
    setActiveDataOwner(OWNER_A);
    const realNow = Date.now();
    mockShots.push({
      id: 's',
      sessionId: null,
      shotType: 'dink',
      capturedAt: new Date(realNow - 1000).toISOString(),
      overallScore: 6,
      resultKind: 'scored',
    });
    await useConsistencyStore.getState().hydrate();
    await settle();
    expect(useConsistencyStore.getState().snapshot?.trainedToday).toBe(true);
    return realNow;
  }

  async function refreshAtClock(now: number): Promise<void> {
    jest.useFakeTimers({
      now,
      doNotFake: [
        'nextTick',
        'queueMicrotask',
        'setImmediate',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
      ],
    });
    try {
      await useConsistencyStore.getState().refresh();
      await settle();
    } finally {
      jest.useRealTimers();
    }
  }

  it('clock jumps: backwards past every shot, forwards a week, to 1969 and back never throw, never write, never publish a bad snapshot', async () => {
    const realNow = await hydrateWithOneShotToday();
    const writesAfterHydrate = mockWrites.length;
    const jumps = [
      realNow - 3 * 86_400_000,
      realNow + 7 * 86_400_000,
      Date.UTC(1969, 11, 31),
      realNow,
    ];
    for (const now of jumps) {
      await refreshAtClock(now);
      expect(snapshotViolation(useConsistencyStore.getState().snapshot)).toBe(
        null,
      );
      expect(useConsistencyStore.getState().loadError).toBe(false);
      expect(unhandled).toEqual([]);
    }
    expect(useConsistencyStore.getState().snapshot?.trainedToday).toBe(true);
    expect(mockWrites.length).toBe(writesAfterHydrate);
  });

  it('clock jump to a five-digit year still yields a calendar-day asOfDay (engine dayOrdinal boundary reached through the store)', async () => {
    await hydrateWithOneShotToday();
    await refreshAtClock(Date.UTC(10_000, 0, 1));
    expect(unhandled).toEqual([]);
    expect(snapshotViolation(useConsistencyStore.getState().snapshot)).toBe(
      null,
    );
  });

  const DRILL_IDS = ['drill-0', 'drill-1', 'drill-2'];
  /** Three persisted drills + a celebrated streak.1, then ONE failed kv read
   * (SQLITE_BUSY / IOERR) while the shot query still succeeds. */
  async function transientLedgerReadFailure(): Promise<void> {
    await resetWorld();
    setActiveDataOwner(OWNER_A);
    mockShots.push({
      id: 's',
      sessionId: null,
      shotType: 'dink',
      capturedAt: new Date(Date.now() - 1000).toISOString(),
      overallScore: 6,
      resultKind: 'scored',
    });
    for (let i = 0; i < 3; i += 1) {
      await useConsistencyStore.getState().recordDrillCompletion({
        id: `drill-${i}`,
        slug: 'reset-wall',
        title: 'Reset wall',
        completedAtIso: new Date(Date.now() - 5_000 - i).toISOString(),
      });
    }
    await useConsistencyStore.getState().hydrate();
    await settle();
    const persisted = parseConsistencyLedger(
      mockKv.get(consistencyKeyForOwner(OWNER_A)) as string,
    );
    expect(persisted.drills.map(d => d.id).sort()).toEqual(DRILL_IDS);
    expect(Object.keys(persisted.celebrated)).toContain('streak.1');
    expect(useConsistencyStore.getState().celebration?.achievementId).toBe(
      'streak.1',
    );
    useConsistencyStore.getState().dismissCelebration();

    mockFaults.getKv = 'throw';
    await useConsistencyStore.getState().refresh();
    await settle();
    mockFaults.getKv = 'ok';
    expect(unhandled).toEqual([]);
  }

  it('a TRANSIENT ledger read failure must not make the next milestone write clobber persisted drills', async () => {
    await transientLedgerReadFailure();
    const after = parseConsistencyLedger(
      mockKv.get(consistencyKeyForOwner(OWNER_A)) as string,
    );
    expect(after.drills.map(d => d.id).sort()).toEqual(DRILL_IDS);
  });

  it('a TRANSIENT ledger read failure must not replay an already-dismissed celebration', async () => {
    await transientLedgerReadFailure();
    expect(useConsistencyStore.getState().celebration).toBeNull();
  });
});
