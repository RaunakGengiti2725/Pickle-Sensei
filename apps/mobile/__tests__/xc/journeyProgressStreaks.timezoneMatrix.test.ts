/**
 * xc journey-progress-streaks — deterministic multi-timezone streak matrix.
 *
 * For every zone in ZONES (UTC-12 … UTC+14, 13 DST zones, 30/45-minute
 * offsets) and every seed, a scenario of 0/1/many activities is generated from
 * WALL-CLOCK components (independent Intl offset resolution), then the
 * production engines are asserted against the reference rules:
 *   - consistency/engine.ts   buildConsistencySnapshot (streak, shields, days)
 *   - progress/practiceHistory.ts aggregatePracticeHistory (verified streak)
 * plus a metamorphic check: the same day pattern expressed as UTC-noon
 * instants under timeZone 'UTC' must yield identical streak arithmetic.
 *
 * Every case (inputs + expected + observed) is written to
 * artifacts/xc-journey-progress-streaks/timezone-matrix.json so any failure is
 * replayable from its (zone, seed).
 */
import {
  buildConsistencySnapshot,
  type TrainingActivityInput,
} from '../../src/consistency/engine';
import {
  SHIELD_EARN_EVERY_DAYS,
  SHIELD_MAX_HELD,
} from '../../src/consistency/milestones';
import { aggregatePracticeHistory } from '../../src/progress/practiceHistory';
import { verifiedCapture } from '../../scripts/xc-journey-progress-streaks/captureFixture';
import {
  nodeEnv,
  nodeVersion,
  ZONES,
  localDayOf,
  referenceConsistency,
  referencePracticeStreak,
  writeArtifact,
} from '../../scripts/xc-journey-progress-streaks/oracle';
import {
  generateScenario,
  type Scenario,
} from '../../scripts/xc-journey-progress-streaks/scenarios';

const SEEDS_PER_ZONE = Number(nodeEnv.XC_SEEDS_PER_ZONE ?? 120);
const DAY_MS = 86_400_000;

interface CaseRecord {
  zone: string;
  seed: number;
  mix: string;
  asOfVariant: string;
  asOfIso: string;
  asOfWallClock: string;
  activityCount: number;
  expectedTrainedDays: string[];
  expected: ReturnType<typeof referenceConsistency>;
  engine: {
    asOfDay: string;
    currentStreak: number;
    longestStreak: number;
    totalTrainedDays: number;
    trainedToday: boolean;
    atRisk: boolean;
    shieldsAvailable: number;
    shieldedDayCount: number;
    trainedLast7: number;
    dayKeys: string[];
  };
  practice: ReturnType<typeof referencePracticeStreak> & { asOfDay: string };
  mismatches: string[];
  replay: Scenario;
}

function toEngineInputs(scenario: Scenario): TrainingActivityInput[] {
  return scenario.activities.map(activity => ({
    kind: activity.kind,
    atIso: activity.atIso,
    shotType: activity.kind === 'drill' ? undefined : activity.shotType,
    overallScore: activity.score,
    resultKind: activity.score === null ? 'low_confidence' : 'scored',
    label: activity.kind === 'drill' ? 'Kitchen-line dink ladder' : undefined,
  }));
}

/** `inject.engineAsOfShiftMs` skews ONLY the asOf handed to production code —
 * used to prove the harness notices an off-by-one day. */
function runCase(
  scenario: Scenario,
  inject: { engineAsOfShiftMs: number } = { engineAsOfShiftMs: 0 },
): CaseRecord {
  const asOfMs = Date.parse(scenario.asOfIso);
  const engineAsOfIso = new Date(
    asOfMs + inject.engineAsOfShiftMs,
  ).toISOString();
  const expectedAsOfDay = localDayOf(asOfMs, scenario.zone);
  const trainedDays = new Set<string>();
  const mismatches: string[] = [];

  for (const activity of scenario.activities) {
    const atMs = Date.parse(activity.atIso);
    // Oracle self-consistency: the generated instant renders back to the
    // wall-clock day it was built from.
    const roundTrip = localDayOf(atMs, scenario.zone);
    if (roundTrip !== activity.localDay) {
      mismatches.push(
        `oracle round-trip ${activity.atIso} → ${roundTrip}, built for ${activity.localDay}`,
      );
    }
    if (atMs <= asOfMs) trainedDays.add(activity.localDay);
  }

  const expected = referenceConsistency(trainedDays, expectedAsOfDay, {
    shieldEvery: SHIELD_EARN_EVERY_DAYS,
    shieldMax: SHIELD_MAX_HELD,
  });

  const snapshot = buildConsistencySnapshot(toEngineInputs(scenario), {
    asOfIso: engineAsOfIso,
    timeZone: scenario.zone,
  });
  const engine = {
    asOfDay: snapshot.asOfDay,
    currentStreak: snapshot.currentStreak,
    longestStreak: snapshot.longestStreak,
    totalTrainedDays: snapshot.totalTrainedDays,
    trainedToday: snapshot.trainedToday,
    atRisk: snapshot.atRisk,
    shieldsAvailable: snapshot.shieldsAvailable,
    shieldedDayCount: snapshot.shieldedDayCount,
    trainedLast7: snapshot.trainedLast7,
    dayKeys: Object.keys(snapshot.days).sort(),
  };

  if (engine.asOfDay !== expectedAsOfDay) {
    mismatches.push(
      `asOfDay engine=${engine.asOfDay} expected=${expectedAsOfDay}`,
    );
  }
  for (const key of [
    'currentStreak',
    'longestStreak',
    'totalTrainedDays',
    'trainedToday',
    'atRisk',
    'shieldsAvailable',
    'shieldedDayCount',
    'trainedLast7',
  ] as const) {
    if (engine[key] !== expected[key]) {
      mismatches.push(`${key} engine=${engine[key]} expected=${expected[key]}`);
    }
  }
  const expectedKeys = [...trainedDays, ...expected.shieldedDays].sort();
  if (engine.dayKeys.join(',') !== expectedKeys.join(',')) {
    mismatches.push(
      `dayKeys engine=[${engine.dayKeys}] expected=[${expectedKeys}]`,
    );
  }
  // Per-day activity counts: every accepted activity lands on its own day.
  const perDay = new Map<string, number>();
  for (const activity of scenario.activities) {
    if (Date.parse(activity.atIso) <= asOfMs) {
      perDay.set(activity.localDay, (perDay.get(activity.localDay) ?? 0) + 1);
    }
  }
  for (const [day, count] of perDay) {
    const entry = snapshot.days[day];
    const observed =
      entry === undefined
        ? -1
        : entry.strokeCount + entry.sessionStrokeCount + entry.drillCount;
    if (observed !== count) {
      mismatches.push(
        `day ${day} activityCount engine=${observed} expected=${count}`,
      );
    }
  }
  const acceptedTotal = [...perDay.values()].reduce((a, b) => a + b, 0);
  if (snapshot.totalActivities !== acceptedTotal) {
    mismatches.push(
      `totalActivities engine=${snapshot.totalActivities} expected=${acceptedTotal}`,
    );
  }

  // Metamorphic: same day pattern as UTC-noon instants under 'UTC'.
  const utcInputs: TrainingActivityInput[] = scenario.activities
    .filter(activity => Date.parse(activity.atIso) <= asOfMs)
    .map(activity => ({
      kind: activity.kind,
      atIso: `${activity.localDay}T12:00:00.000Z`,
      shotType: activity.kind === 'drill' ? undefined : activity.shotType,
      overallScore: activity.score,
      resultKind: activity.score === null ? 'low_confidence' : 'scored',
    }));
  const utcSnapshot = buildConsistencySnapshot(utcInputs, {
    asOfIso: `${expectedAsOfDay}T12:00:00.000Z`,
    timeZone: 'UTC',
  });
  for (const key of [
    'currentStreak',
    'longestStreak',
    'totalTrainedDays',
    'trainedToday',
    'atRisk',
    'shieldsAvailable',
    'shieldedDayCount',
    'momentumXp',
    'runXp',
    'trainedLast7',
    'totalActivities',
    'scoredAnalysisCount',
  ] as const) {
    if (snapshot[key] !== utcSnapshot[key]) {
      mismatches.push(
        `metamorphic ${key} zone=${snapshot[key]} utc=${utcSnapshot[key]}`,
      );
    }
  }
  if (
    JSON.stringify(snapshot.earned.map(e => e.id)) !==
    JSON.stringify(utcSnapshot.earned.map(e => e.id))
  ) {
    mismatches.push('metamorphic earned achievement ids differ');
  }

  // practiceHistory: verified-capture streak over the same instants.
  const captures = scenario.activities.map((activity, index) =>
    verifiedCapture(`c${index}`, activity.atIso),
  );
  const history = aggregatePracticeHistory(captures, {
    asOfIso: engineAsOfIso,
    timeZone: scenario.zone,
    rangeDays: 7,
  });
  const expectedPractice = referencePracticeStreak(
    trainedDays,
    expectedAsOfDay,
  );
  const practice = { ...history.streak, asOfDay: history.asOfDay };
  if (history.asOfDay !== expectedAsOfDay) {
    mismatches.push(
      `practice asOfDay=${history.asOfDay} expected=${expectedAsOfDay}`,
    );
  }
  for (const key of [
    'currentDays',
    'longestDays',
    'practicedToday',
    'lastPracticeDay',
  ] as const) {
    if (history.streak[key] !== expectedPractice[key]) {
      mismatches.push(
        `practice.${key} engine=${history.streak[key]} expected=${expectedPractice[key]}`,
      );
    }
  }
  if (history.lifetime.activeDayCount !== trainedDays.size) {
    mismatches.push(
      `practice.lifetime.activeDayCount=${history.lifetime.activeDayCount} expected=${trainedDays.size}`,
    );
  }
  if (history.lifetime.eligibleCaptureCount !== acceptedTotal) {
    mismatches.push(
      `practice.lifetime.eligibleCaptureCount=${history.lifetime.eligibleCaptureCount} expected=${acceptedTotal}`,
    );
  }

  return {
    zone: scenario.zone,
    seed: scenario.seed,
    mix: scenario.mix,
    asOfVariant: scenario.asOfVariant,
    asOfIso: scenario.asOfIso,
    asOfWallClock: scenario.asOfWallClock,
    activityCount: scenario.activities.length,
    expectedTrainedDays: [...trainedDays].sort(),
    expected,
    engine,
    practice,
    mismatches,
    replay: scenario,
  };
}

describe('xc journey-progress-streaks: timezone matrix', () => {
  const records: CaseRecord[] = [];

  afterAll(() => {
    const failures = records.filter(record => record.mismatches.length > 0);
    const byZone: Record<
      string,
      { cases: number; failures: number; mixes: Record<string, number> }
    > = {};
    for (const record of records) {
      const zone = (byZone[record.zone] ??= {
        cases: 0,
        failures: 0,
        mixes: {},
      });
      zone.cases += 1;
      zone.mixes[record.mix] = (zone.mixes[record.mix] ?? 0) + 1;
      if (record.mismatches.length > 0) zone.failures += 1;
    }
    writeArtifact('timezone-matrix.json', {
      generatedAt: new Date().toISOString(),
      node: nodeVersion,
      icuTimeZoneCount:
        (
          Intl as unknown as {
            supportedValuesOf?: (key: string) => string[];
          }
        ).supportedValuesOf?.('timeZone').length ?? null,
      zones: ZONES,
      seedsPerZone: SEEDS_PER_ZONE,
      totalCases: records.length,
      totalActivities: records.reduce((sum, r) => sum + r.activityCount, 0),
      failures: failures.length,
      byZone,
      failingSeeds: failures.map(f => ({
        zone: f.zone,
        seed: f.seed,
        mismatches: f.mismatches,
      })),
      cases: records,
    });
  });

  it.each(ZONES.map(zone => [zone] as const))(
    '%s: engine + practiceHistory agree with the wall-clock oracle for every seed',
    zone => {
      const failing: string[] = [];
      for (let seed = 1; seed <= SEEDS_PER_ZONE; seed += 1) {
        const scenario = generateScenario(
          zone,
          seed * 7919 + ZONES.indexOf(zone),
        );
        const record = runCase(scenario);
        records.push(record);
        if (record.mismatches.length > 0) {
          failing.push(
            `seed=${record.seed} mix=${record.mix} asOf=${record.asOfWallClock}: ${record.mismatches.join('; ')}`,
          );
        }
      }
      expect(failing).toEqual([]);
    },
  );

  it('detects an injected one-day asOf skew in every zone (harness sensitivity)', () => {
    const insensitive: string[] = [];
    for (const zone of ZONES) {
      let caught = 0;
      let tried = 0;
      for (let seed = 1; seed <= 20; seed += 1) {
        const scenario = generateScenario(zone, seed * 104729 + 17);
        if (scenario.activities.length === 0) continue;
        tried += 1;
        const skewed = runCase(scenario, { engineAsOfShiftMs: DAY_MS });
        if (skewed.mismatches.length > 0) caught += 1;
      }
      // Every non-empty scenario moves asOfDay by one, which the oracle must
      // flag (asOfDay/trainedToday/atRisk/streak) — a silent harness is a bug.
      if (caught !== tried)
        insensitive.push(`${zone}: caught ${caught}/${tried}`);
    }
    expect(insensitive).toEqual([]);
  });

  it('covers 0, 1 and many activities and every asOf boundary variant', () => {
    const mixes = new Set(records.map(r => r.mix));
    const variants = new Set(records.map(r => r.asOfVariant));
    expect([...mixes].sort()).toEqual([
      'consecutive',
      'gappy',
      'many',
      'none',
      'single',
    ]);
    expect(variants.size).toBe(7);
    expect(records.some(r => r.activityCount >= 100)).toBe(true);
    expect(
      records.some(r =>
        r.replay.activities.some(a => a.resolution !== 'unique'),
      ),
    ).toBe(true);
  });
});
