/**
 * ADVERSARY (performance-bounds): corrupt persisted timestamps vs. the
 * consistency engine's day-by-day replay.
 *
 * `buildConsistencySnapshot` walks EVERY calendar day from the earliest
 * activity to today (engine.ts `for (ordinal = firstOrdinal; …)`), allocating
 * a Date + toISOString per day. The only guard on `atIso` is "parses and is
 * not in the future". A single persisted row whose `captured_at` (or a kv
 * ledger drill's `completedAtIso`) is far in the past therefore turns the
 * replay — run on hydrate at app launch and on every refresh, on the JS
 * thread — into a walk over hundreds of thousands of days.
 *
 * A second boundary sits in the same walk: a year the day formatter renders
 * with fewer than four digits (`0100-…`) produces a day key `Date.parse`
 * cannot read, so its ordinal is NaN; NaN poisons the ordinal sort and the
 * walk's `firstOrdinal`, and the GENUINE history disappears from the streak.
 */
import type { LocalDb } from '../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  buildConsistencySnapshot,
  type TrainingActivityInput,
} from '../../src/consistency/engine';
import {
  consistencyKeyForOwner,
  computeConsistencySnapshot,
  parseConsistencyLedger,
} from '../../src/consistency/store';
import { saveLocalOnlyAnalysis, setKv } from '../../src/data/repository';
import type { ShotAnalysis } from '@pickle/shared-types';
import {
  closeSqliteTestDatabases,
  createSqliteTestDb,
} from '../../testSupport/sqlite';

let mockDb: LocalDb | null = null;
jest.mock('../../src/data/db', () => ({
  getDb: () => {
    if (!mockDb) throw new Error('test db not configured');
    return mockDb;
  },
}));

const owner = '44444444-4444-4444-8444-444444444444';
const AS_OF = '2026-09-08T12:00:00.000Z';
const TODAY = '2026-09-08';
/** ~5x a realistic three-year, three-shots-a-day replay measured in V8
 * (≈50 ms here); Hermes on device is several times slower than V8. */
const SINGLE_CORRUPT_ROW_BUDGET_MS = 250;

function timed<T>(fn: () => T): { result: T; ms: number } {
  const start = performance.now();
  const result = fn();
  return { result, ms: performance.now() - start };
}

function activity(atIso: string): TrainingActivityInput {
  return {
    kind: 'stroke',
    atIso,
    shotType: 'forehand_drive',
    overallScore: null,
    resultKind: 'low_confidence',
  };
}

function realisticHistory(days: number): TrainingActivityInput[] {
  const activities: TrainingActivityInput[] = [];
  const asOfMs = Date.parse(AS_OF);
  for (let day = 0; day < days; day += 1) {
    for (let shot = 0; shot < 3; shot += 1) {
      activities.push({
        kind: 'stroke',
        atIso: new Date(
          asOfMs - day * 86_400_000 - shot * 60_000,
        ).toISOString(),
        shotType: 'forehand_drive',
        overallScore: 6.5,
        resultKind: 'scored',
      });
    }
  }
  return activities;
}

function localOnlyAnalysis(id: string, capturedAtIso: string): ShotAnalysis {
  return {
    id,
    sessionId: null,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso,
    timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
    phases: [],
    measurements: [],
    checkpoints: [],
    overallScore: null,
    analysisConfidence: 0.2,
    resultKind: 'low_confidence',
    guidance: null,
    priorityFix: null,
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'test-native-1',
      poseModelVersion: 'test-pose-1',
      paddleModelVersion: 'test-paddle-1',
      strokeDetectorVersion: 'test-stroke-1',
      phaseModelVersion: 'test-phase-1',
      scoringModelVersion: 'sm-v1',
      shotConfigVersion: 'forehand_drive@1',
    },
    source: 'real',
  };
}

describe('ADV perf: consistency replay vs. corrupt far-past timestamps', () => {
  afterEach(() => {
    closeSqliteTestDatabases();
    mockDb = null;
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  });

  it('baseline: a three-year, 3-shots-a-day history replays inside the budget', () => {
    const { result, ms } = timed(() =>
      buildConsistencySnapshot(realisticHistory(3 * 365), {
        asOfIso: AS_OF,
        timeZone: 'UTC',
      }),
    );
    expect(result.totalTrainedDays).toBe(3 * 365);
    console.warn(`[adv] baseline 1095 trained days: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(SINGLE_CORRUPT_ROW_BUDGET_MS);
  });

  it('one corrupt year-1000 activity (≈375k-day walk) stays inside the replay budget', () => {
    const activities = [
      ...realisticHistory(30),
      activity('1000-01-01T00:00:00.000Z'),
    ];
    const { result, ms } = timed(() =>
      buildConsistencySnapshot(activities, {
        asOfIso: AS_OF,
        timeZone: 'UTC',
      }),
    );
    console.warn(`[adv] corrupt year-1000 row: ${ms.toFixed(1)} ms`);
    expect(result.totalTrainedDays).toBe(31);
    expect(ms).toBeLessThan(SINGLE_CORRUPT_ROW_BUDGET_MS);
  });

  it.each([['0100-01-01T00:00:00.000Z'], ['0001-01-01T00:00:00.000Z']])(
    'one corrupt %s activity ordered first does not erase the genuine history',
    atIso => {
      const activities = [
        activity(atIso),
        activity('2026-09-08T10:00:00.000Z'),
        activity('2026-09-07T10:00:00.000Z'),
      ];
      const { result } = timed(() =>
        buildConsistencySnapshot(activities, {
          asOfIso: AS_OF,
          timeZone: 'UTC',
        }),
      );
      expect(result.totalActivities).toBe(3);
      // The two genuine days must survive whatever happens to the corrupt one.
      expect(result.days[TODAY]).toBeDefined();
      expect(result.totalTrainedDays).toBeGreaterThanOrEqual(2);
      expect(result.currentStreak).toBeGreaterThanOrEqual(2);
    },
  );

  it('a persisted kv ledger drill completed at the JS Date floor is admitted by the parser and must not erase today from the replay', () => {
    const ledger = parseConsistencyLedger(
      JSON.stringify({
        version: 1,
        drills: [
          {
            id: 'd1',
            slug: 'shadow-dinks',
            title: 'Shadow dinks',
            // Date.parse accepts this (−271821-04-20 is the JS Date floor).
            completedAtIso: '-271821-04-20T00:00:00.000Z',
          },
        ],
        celebrated: {},
        daySecuredShownDay: null,
      }),
    );
    // Precondition (observed): the parser's only date guard is Date.parse.
    expect(ledger).not.toBeNull();
    if (!ledger) throw new Error('unreachable');
    const drill = ledger.drills[0];
    if (!drill) throw new Error('drill missing');
    const { result, ms } = timed(() =>
      buildConsistencySnapshot(
        [
          { kind: 'drill', atIso: drill.completedAtIso, label: drill.title },
          activity('2026-09-08T10:00:00.000Z'),
        ],
        { asOfIso: AS_OF, timeZone: 'UTC' },
      ),
    );
    console.warn(
      `[adv] Date-floor drill: ${ms.toFixed(1)} ms, trained ${result.totalTrainedDays}, days ${Object.keys(result.days).length}`,
    );
    expect(result.totalActivities).toBe(2);
    expect(ms).toBeLessThan(SINGLE_CORRUPT_ROW_BUDGET_MS);
    expect(result.days[TODAY]).toBeDefined();
    expect(result.totalTrainedDays).toBeGreaterThanOrEqual(1);
  });

  it('one corrupt local_shot.captured_at row (sorted first by SQL) does not erase today from the store snapshot', async () => {
    setActiveDataOwner(owner);
    const { db } = createSqliteTestDb();
    mockDb = db;
    await setKv(
      db,
      consistencyKeyForOwner(owner),
      JSON.stringify({
        version: 1,
        drills: [],
        celebrated: {},
        daySecuredShownDay: null,
      }),
    );
    await saveLocalOnlyAnalysis(
      db,
      localOnlyAnalysis(
        'aaaaaaaa-bbbb-4ccc-8ddd-000000000001',
        '0100-01-01T00:00:00.000Z',
      ),
    );
    const todayIso = new Date(Date.now() - 60_000).toISOString();
    await saveLocalOnlyAnalysis(
      db,
      localOnlyAnalysis('aaaaaaaa-bbbb-4ccc-8ddd-000000000002', todayIso),
    );
    const start = performance.now();
    const snapshot = await computeConsistencySnapshot();
    const ms = performance.now() - start;
    console.warn(
      `[adv] store replay with one year-0100 row: ${ms.toFixed(1)} ms`,
    );
    expect(snapshot.totalActivities).toBe(2);
    expect(snapshot.days[snapshot.asOfDay]).toBeDefined();
    expect(snapshot.totalTrainedDays).toBeGreaterThanOrEqual(1);
    expect(snapshot.currentStreak).toBeGreaterThanOrEqual(1);
    expect(ms).toBeLessThan(SINGLE_CORRUPT_ROW_BUDGET_MS);
  });
});
