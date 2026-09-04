/**
 * xc journey-progress-streaks — DST transitions and exact midnight sweeps.
 *
 * 1. For every DST zone and every 2026 offset change, activities are placed
 *    at 5-minute wall-clock steps from 20:00 the day before to 04:00 the day
 *    after (both instants of an ambiguous hour, gap times skipped and
 *    recorded), and the engine's day assignment is compared to the oracle.
 *    A three-day run across the transition must read exactly 3, and asOf at
 *    00:00:00.000 two days later must read 0 (no shields yet).
 * 2. For EVERY zone, asOf is swept in 1 ms steps across local midnight
 *    (23:59:59.990 → 00:00:00.010) with a trained "yesterday" and an untrained
 *    "today"; streak/trainedToday/atRisk must flip exactly at .000, never a
 *    millisecond early or late. The same sweep with the activity itself at
 *    the boundary proves an activity at 23:59:59.999 belongs to the earlier
 *    day and 00:00:00.000 to the later day.
 *
 * Raw table: artifacts/xc-journey-progress-streaks/dst-midnight.json
 */
import { buildConsistencySnapshot } from '../../src/consistency/engine';
import { aggregatePracticeHistory } from '../../src/progress/practiceHistory';
import { verifiedCapture } from '../../scripts/xc-journey-progress-streaks/captureFixture';
import {
  nodeVersion,
  DST_ZONES,
  ZONES,
  addDaysToKey,
  localDayOf,
  offsetAt,
  resolveWallClock,
  transitionsIn,
  wallClock,
  writeArtifact,
} from '../../scripts/xc-journey-progress-streaks/oracle';

interface TransitionRecord {
  zone: string;
  transitionIso: string;
  transitionLocalDay: string;
  offsetBeforeMin: number;
  offsetAfterMin: number;
  probes: number;
  ambiguousInstants: number;
  gapWallClocks: string[];
  dayMismatches: string[];
  streakAcrossTransition: number;
  streakTwoDaysLater: number;
  practiceAcrossTransition: number;
}

interface SweepRecord {
  zone: string;
  boundaryDay: string;
  boundaryIso: string;
  offsetAtBoundaryMin: number;
  asOfSweep: Array<{
    deltaMs: number;
    asOfDay: string;
    currentStreak: number;
    trainedToday: boolean;
    atRisk: boolean;
    practiceCurrentDays: number;
    practicedToday: boolean;
  }>;
  activitySweep: Array<{
    deltaMs: number;
    engineDay: string;
    oracleDay: string;
  }>;
  violations: string[];
}

const transitionRecords: TransitionRecord[] = [];
const sweepRecords: SweepRecord[] = [];

afterAll(() => {
  writeArtifact('dst-midnight.json', {
    generatedAt: new Date().toISOString(),
    node: nodeVersion,
    transitions: transitionRecords,
    midnightSweeps: sweepRecords,
    totals: {
      transitions: transitionRecords.length,
      transitionProbes: transitionRecords.reduce((s, r) => s + r.probes, 0),
      sweeps: sweepRecords.length,
      sweepPoints: sweepRecords.reduce(
        (s, r) => s + r.asOfSweep.length + r.activitySweep.length,
        0,
      ),
      violations:
        transitionRecords.reduce((s, r) => s + r.dayMismatches.length, 0) +
        sweepRecords.reduce((s, r) => s + r.violations.length, 0),
    },
  });
});

describe('xc journey-progress-streaks: DST transitions', () => {
  const cases = DST_ZONES.flatMap(zone =>
    transitionsIn(zone, 2026).map(transition => [zone, transition] as const),
  );
  it('found at least two transitions in every DST zone', () => {
    for (const zone of DST_ZONES) {
      expect(transitionsIn(zone, 2026).length).toBeGreaterThanOrEqual(2);
    }
  });

  it.each(cases)(
    '%s transition at %d: day assignment and 3-day run are exact',
    (zone, transition) => {
      const transitionDay = localDayOf(transition, zone);
      const before = addDaysToKey(transitionDay, -1);
      const after = addDaysToKey(transitionDay, 1);
      const record: TransitionRecord = {
        zone,
        transitionIso: new Date(transition).toISOString(),
        transitionLocalDay: transitionDay,
        offsetBeforeMin: offsetAt(transition - 1000, zone) / 60_000,
        offsetAfterMin: offsetAt(transition, zone) / 60_000,
        probes: 0,
        ambiguousInstants: 0,
        gapWallClocks: [],
        dayMismatches: [],
        streakAcrossTransition: -1,
        streakTwoDaysLater: -1,
        practiceAcrossTransition: -1,
      };

      // 5-minute wall-clock probes 20:00 (day before) → 04:00 (day after).
      const probes: Array<{ day: string; atIso: string }> = [];
      for (const [day, startHour, endHour] of [
        [before, 20, 24],
        [transitionDay, 0, 24],
        [after, 0, 4],
      ] as const) {
        for (
          let minutes = startHour * 60;
          minutes < endHour * 60;
          minutes += 5
        ) {
          const wc = wallClock(day, Math.floor(minutes / 60), minutes % 60);
          const resolution = resolveWallClock(wc, zone);
          if (resolution.kind === 'gap') {
            record.gapWallClocks.push(
              `${day}T${String(wc.hour).padStart(2, '0')}:${String(wc.minute).padStart(2, '0')}`,
            );
            continue;
          }
          if (resolution.kind === 'ambiguous') record.ambiguousInstants += 2;
          for (const instant of resolution.instants as readonly number[]) {
            probes.push({ day, atIso: new Date(instant).toISOString() });
          }
        }
      }
      // The transition instant itself and its neighbours.
      for (const delta of [-1, 0, 1]) {
        const instant = transition + delta;
        probes.push({
          day: localDayOf(instant, zone),
          atIso: new Date(instant).toISOString(),
        });
      }
      record.probes = probes.length;

      const asOfIso = resolveWallClock(wallClock(after, 12), zone).instants[0]!;
      const snapshot = buildConsistencySnapshot(
        probes.map(probe => ({ kind: 'stroke' as const, atIso: probe.atIso })),
        { asOfIso: new Date(asOfIso).toISOString(), timeZone: zone },
      );
      // Every probe must be bucketed on the day the oracle built it for.
      const perDay = new Map<string, number>();
      for (const probe of probes)
        perDay.set(probe.day, (perDay.get(probe.day) ?? 0) + 1);
      for (const [day, count] of perDay) {
        const bucket = snapshot.days[day];
        const observed = bucket ? bucket.strokeCount : -1;
        if (observed !== count) {
          record.dayMismatches.push(
            `${day}: engine=${observed} oracle=${count}`,
          );
        }
      }
      const total = Object.values(snapshot.days).reduce(
        (s, d) => s + d.strokeCount,
        0,
      );
      if (total !== probes.length) {
        record.dayMismatches.push(
          `total engine=${total} oracle=${probes.length}`,
        );
      }
      record.streakAcrossTransition = snapshot.currentStreak;

      const twoDaysLater = resolveWallClock(
        wallClock(addDaysToKey(after, 2), 0),
        zone,
      );
      const later = buildConsistencySnapshot(
        probes.map(probe => ({ kind: 'stroke' as const, atIso: probe.atIso })),
        {
          asOfIso: new Date(
            (twoDaysLater.kind === 'gap'
              ? resolveWallClock(wallClock(addDaysToKey(after, 2), 1), zone)
              : twoDaysLater
            ).instants[0]!,
          ).toISOString(),
          timeZone: zone,
        },
      );
      record.streakTwoDaysLater = later.currentStreak;

      const history = aggregatePracticeHistory(
        probes.map((probe, index) => verifiedCapture(`p${index}`, probe.atIso)),
        {
          asOfIso: new Date(asOfIso).toISOString(),
          timeZone: zone,
          rangeDays: 7,
        },
      );
      record.practiceAcrossTransition = history.streak.currentDays;
      transitionRecords.push(record);

      expect(record.dayMismatches).toEqual([]);
      expect(record.streakAcrossTransition).toBe(3);
      expect(snapshot.longestStreak).toBe(3);
      expect(snapshot.trainedToday).toBe(true);
      expect(record.practiceAcrossTransition).toBe(3);
      expect(history.streak.longestDays).toBe(3);
      // Day after `after` untrained, then asOf two days after: run broken.
      expect(record.streakTwoDaysLater).toBe(0);
      expect(later.longestStreak).toBe(3);
    },
  );
});

describe('xc journey-progress-streaks: 1 ms midnight sweeps in every zone', () => {
  const fixedBoundaryDays = [
    '2026-03-09',
    '2026-11-02',
    '2026-01-01',
    '2026-06-16',
  ];
  /** Fixed days plus, for DST zones, the transition day and the day after —
   * which covers zones whose shift happens at midnight itself. */
  const boundaryDaysFor = (zone: (typeof ZONES)[number]): string[] => {
    const days = new Set(fixedBoundaryDays);
    if (DST_ZONES.includes(zone)) {
      for (const transition of transitionsIn(zone, 2026)) {
        const day = localDayOf(transition, zone);
        days.add(day);
        days.add(addDaysToKey(day, 1));
      }
    }
    return [...days].sort();
  };

  it.each(
    ZONES.flatMap(zone =>
      boundaryDaysFor(zone).map(day => [zone, day] as const),
    ),
  )(
    '%s midnight of %s flips streak state exactly at .000',
    (zone, boundaryDay) => {
      const yesterday = addDaysToKey(boundaryDay, -1);
      let midnight = resolveWallClock(wallClock(boundaryDay, 0), zone);
      let boundaryNote = '';
      if (midnight.kind === 'gap') {
        // Zones shifting at 00:00 have no midnight; the day starts at 01:00.
        midnight = resolveWallClock(wallClock(boundaryDay, 1), zone);
        boundaryNote = ' (00:00 does not exist; day starts 01:00)';
      }
      const boundaryMs = midnight.instants[0]!;
      const record: SweepRecord = {
        zone,
        boundaryDay: boundaryDay + boundaryNote,
        boundaryIso: new Date(boundaryMs).toISOString(),
        offsetAtBoundaryMin: offsetAt(boundaryMs, zone) / 60_000,
        asOfSweep: [],
        activitySweep: [],
        violations: [],
      };

      // (a) trained yesterday at noon, untrained today; sweep asOf.
      const yesterdayNoon = resolveWallClock(wallClock(yesterday, 12), zone)
        .instants[0]!;
      const activities = [
        {
          kind: 'stroke' as const,
          atIso: new Date(yesterdayNoon).toISOString(),
        },
      ];
      const captures = [
        verifiedCapture('y', new Date(yesterdayNoon).toISOString()),
      ];
      for (let delta = -10; delta <= 10; delta += 1) {
        const asOfMs = boundaryMs + delta;
        const asOfIso = new Date(asOfMs).toISOString();
        const snapshot = buildConsistencySnapshot(activities, {
          asOfIso,
          timeZone: zone,
        });
        const history = aggregatePracticeHistory(captures, {
          asOfIso,
          timeZone: zone,
          rangeDays: 7,
        });
        record.asOfSweep.push({
          deltaMs: delta,
          asOfDay: snapshot.asOfDay,
          currentStreak: snapshot.currentStreak,
          trainedToday: snapshot.trainedToday,
          atRisk: snapshot.atRisk,
          practiceCurrentDays: history.streak.currentDays,
          practicedToday: history.streak.practicedToday,
        });
        const expectedDay = delta < 0 ? yesterday : boundaryDay;
        if (snapshot.asOfDay !== expectedDay) {
          record.violations.push(
            `asOf ${delta}ms: engine asOfDay=${snapshot.asOfDay} expected=${expectedDay}`,
          );
        }
        if (history.asOfDay !== expectedDay) {
          record.violations.push(
            `asOf ${delta}ms: practice asOfDay=${history.asOfDay} expected=${expectedDay}`,
          );
        }
        // Streak is 1 on both sides of midnight (yesterday counts until the
        // day after tomorrow); only trainedToday/atRisk flip.
        if (snapshot.currentStreak !== 1) {
          record.violations.push(
            `asOf ${delta}ms: currentStreak=${snapshot.currentStreak} expected=1`,
          );
        }
        if (snapshot.trainedToday !== delta < 0) {
          record.violations.push(
            `asOf ${delta}ms: trainedToday=${snapshot.trainedToday}`,
          );
        }
        if (snapshot.atRisk !== delta >= 0) {
          record.violations.push(`asOf ${delta}ms: atRisk=${snapshot.atRisk}`);
        }
        if (
          history.streak.currentDays !== 1 ||
          history.streak.practicedToday !== delta < 0
        ) {
          record.violations.push(
            `asOf ${delta}ms: practice currentDays=${history.streak.currentDays} practicedToday=${history.streak.practicedToday}`,
          );
        }
      }

      // (b) sweep the ACTIVITY across midnight with asOf fixed at today noon.
      const todayNoon = resolveWallClock(wallClock(boundaryDay, 12), zone)
        .instants[0]!;
      for (let delta = -10; delta <= 10; delta += 1) {
        const atIso = new Date(boundaryMs + delta).toISOString();
        const snapshot = buildConsistencySnapshot([{ kind: 'stroke', atIso }], {
          asOfIso: new Date(todayNoon).toISOString(),
          timeZone: zone,
        });
        const engineDay = Object.keys(snapshot.days)[0] ?? '';
        const oracleDay = localDayOf(boundaryMs + delta, zone);
        record.activitySweep.push({ deltaMs: delta, engineDay, oracleDay });
        const expectedDay = delta < 0 ? yesterday : boundaryDay;
        if (engineDay !== expectedDay || oracleDay !== expectedDay) {
          record.violations.push(
            `activity ${delta}ms: engine=${engineDay} oracle=${oracleDay} expected=${expectedDay}`,
          );
        }
        if (snapshot.trainedToday !== delta >= 0) {
          record.violations.push(
            `activity ${delta}ms: trainedToday=${snapshot.trainedToday}`,
          );
        }
      }
      sweepRecords.push(record);
      expect(record.violations).toEqual([]);
    },
  );
});
