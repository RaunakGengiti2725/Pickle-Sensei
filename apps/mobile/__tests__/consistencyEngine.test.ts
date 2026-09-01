import {
  buildConsistencySnapshot,
  dayHeatLevel,
  flameIntensityForStreak,
  type TrainingActivityInput,
} from '../src/consistency/engine';
import {
  momentumLevelForXp,
  SHIELD_MAX_HELD,
  xpCostForLevel,
} from '../src/consistency/milestones';

/**
 * The consistency engine is replayed from raw activity facts, so these tests
 * pin the exact rules of the streak economy: what counts as a trained day,
 * how shields bank and spend, how Momentum XP accrues, and when milestones
 * unlock. All fixtures use UTC so the local-day math is byte-stable in CI.
 */

const TZ = 'UTC';

function stroke(
  day: number,
  extra: Partial<TrainingActivityInput> = {},
): TrainingActivityInput {
  return {
    kind: 'stroke',
    atIso: `2026-03-${String(day).padStart(2, '0')}T10:00:00.000Z`,
    shotType: 'dink',
    overallScore: 6,
    resultKind: 'scored',
    ...extra,
  };
}

function snapshotAsOfDay(
  activities: TrainingActivityInput[],
  day: number,
  hour = 18,
) {
  return buildConsistencySnapshot(activities, {
    asOfIso: `2026-03-${String(day).padStart(2, '0')}T${String(hour).padStart(
      2,
      '0',
    )}:00:00.000Z`,
    timeZone: TZ,
  });
}

describe('buildConsistencySnapshot', () => {
  it('returns an honest empty snapshot with the first milestone ahead', () => {
    const snapshot = snapshotAsOfDay([], 10);
    expect(snapshot.currentStreak).toBe(0);
    expect(snapshot.trainedToday).toBe(false);
    expect(snapshot.atRisk).toBe(false);
    expect(snapshot.momentumXp).toBe(0);
    expect(snapshot.earned).toEqual([]);
    expect(snapshot.nextStreakMilestone?.days).toBe(1);
    expect(snapshot.nextStreakMilestone?.daysAway).toBe(1);
  });

  it('counts a day only when something meaningful happened, and starts the streak', () => {
    const snapshot = snapshotAsOfDay([stroke(10)], 10);
    expect(snapshot.currentStreak).toBe(1);
    expect(snapshot.trainedToday).toBe(true);
    expect(snapshot.atRisk).toBe(false);
    // Base 20 XP + First Spark bonus 10.
    expect(snapshot.momentumXp).toBe(30);
    expect(snapshot.earned.map(e => e.id)).toEqual(['streak.1']);
    expect(snapshot.days['2026-03-10']?.xp).toBe(30);
  });

  it('caps the extra-activity XP bonus', () => {
    const five = Array.from({ length: 5 }, (_, i) =>
      stroke(10, { atIso: `2026-03-10T1${i}:00:00.000Z` }),
    );
    const snapshot = snapshotAsOfDay(five, 10);
    // 20 base + min(4·5, 15) = 35, plus the one-time First Spark 10.
    expect(snapshot.days['2026-03-10']?.xp).toBe(45);
    expect(snapshot.totalActivities).toBe(5);
  });

  it('grows the streak on consecutive days and unlocks Kindling at 3', () => {
    const snapshot = snapshotAsOfDay([stroke(8), stroke(9), stroke(10)], 10);
    expect(snapshot.currentStreak).toBe(3);
    expect(snapshot.earned.map(e => e.id)).toEqual(['streak.1', 'streak.3']);
    // 20+10, 20, 20+30.
    expect(snapshot.momentumXp).toBe(100);
    expect(snapshot.runXp).toBe(100);
  });

  it('breaks an unshielded streak but keeps the longest run', () => {
    const snapshot = snapshotAsOfDay(
      [stroke(1), stroke(2), stroke(3), stroke(6)],
      6,
    );
    expect(snapshot.currentStreak).toBe(1);
    expect(snapshot.longestStreak).toBe(3);
    // Kindling was earned in the first run and is not re-earned.
    expect(snapshot.earned.filter(e => e.id === 'streak.3')).toHaveLength(1);
  });

  it('leaves today open: an untrained today is at-risk, never a miss', () => {
    const snapshot = snapshotAsOfDay([stroke(8), stroke(9)], 10);
    expect(snapshot.currentStreak).toBe(2);
    expect(snapshot.trainedToday).toBe(false);
    expect(snapshot.atRisk).toBe(true);
  });

  it('banks a shield at 7 straight days and spends it on a missed day', () => {
    const week = [1, 2, 3, 4, 5, 6, 7].map(d => stroke(d));
    const seven = snapshotAsOfDay(week, 7);
    expect(seven.shieldsAvailable).toBe(1);
    expect(seven.earned.map(e => e.id)).toContain('streak.7');

    // Day 8 missed, day 9 trained: the shield bridges the gap.
    const bridged = snapshotAsOfDay([...week, stroke(9)], 9);
    expect(bridged.currentStreak).toBe(8);
    expect(bridged.shieldsAvailable).toBe(0);
    expect(bridged.shieldedDayCount).toBe(1);
    expect(bridged.days['2026-03-08']).toMatchObject({ shielded: true, xp: 0 });
  });

  it('holds at most two shields even when more are earned', () => {
    const threeWeeks = Array.from({ length: 21 }, (_, i) => stroke(i + 1));
    const snapshot = snapshotAsOfDay(threeWeeks, 21);
    expect(snapshot.shieldsEarnedTotal).toBe(3);
    expect(snapshot.shieldsAvailable).toBe(SHIELD_MAX_HELD);
  });

  it('survives exactly as many consecutive misses as banked shields', () => {
    const fortnight = Array.from({ length: 14 }, (_, i) => stroke(i + 1));
    // Two shields banked; miss the 15th and 16th, train the 17th.
    const survived = snapshotAsOfDay([...fortnight, stroke(17)], 17);
    expect(survived.currentStreak).toBe(15);
    expect(survived.shieldsAvailable).toBe(0);

    // Three misses is one more than the shields could cover.
    const broken = snapshotAsOfDay([...fortnight, stroke(18)], 18);
    expect(broken.currentStreak).toBe(1);
    expect(broken.longestStreak).toBe(14);
  });

  it('awards each milestone XP bonus once, ever', () => {
    const snapshot = snapshotAsOfDay(
      [stroke(1), stroke(2), stroke(3), stroke(10), stroke(11), stroke(12)],
      12,
    );
    // Run 1: 30 + 20 + 50 = 100. Run 2: 20 + 20 + 20 (no repeat bonuses).
    expect(snapshot.momentumXp).toBe(160);
    expect(snapshot.runXp).toBe(60);
  });

  it('counts trained days in the trailing week', () => {
    const snapshot = snapshotAsOfDay(
      [stroke(4), stroke(5), stroke(7), stroke(9), stroke(10)],
      10,
    );
    // Window Mar 4-10: trained 4, 5, 7, 9, 10 → 5 of 7.
    expect(snapshot.trainedLast7).toBe(5);
  });

  it('derives scored-day detail: averages, activity list, heat', () => {
    const snapshot = snapshotAsOfDay(
      [
        stroke(10, { overallScore: 7.8, atIso: '2026-03-10T09:00:00.000Z' }),
        stroke(10, {
          shotType: 'forehand_drive',
          overallScore: 6.1,
          atIso: '2026-03-10T11:00:00.000Z',
        }),
        {
          kind: 'drill',
          atIso: '2026-03-10T12:00:00.000Z',
          label: 'Dink ladder',
        },
      ],
      10,
    );
    const day = snapshot.days['2026-03-10']!;
    expect(day.scoredCount).toBe(2);
    expect(day.scoreAvg).toBe(7);
    expect(day.drillCount).toBe(1);
    expect(day.activities.map(a => a.label)).toEqual([
      'dink',
      'forehand drive',
      'Dink ladder',
    ]);
    expect(dayHeatLevel(day)).toBe(2);
  });

  it('unlocks volume achievements from cumulative evidence', () => {
    const grind: TrainingActivityInput[] = [];
    for (let day = 1; day <= 25; day += 1) {
      for (let i = 0; i < 4; i += 1) {
        grind.push(
          stroke(day, {
            atIso: `2026-03-${String(day).padStart(2, '0')}T1${i}:00:00.000Z`,
          }),
        );
      }
    }
    const snapshot = snapshotAsOfDay(grind, 25);
    const ids = snapshot.earned.map(e => e.id);
    expect(ids).toContain('volume.sessions100');
    const specialist = snapshot.earned.find(e => e.id === 'volume.specialist');
    expect(specialist?.detail).toBe('dink');
  });

  it("maps activities to the player's local calendar day", () => {
    const snapshot = buildConsistencySnapshot(
      [
        {
          kind: 'stroke',
          atIso: '2026-03-15T03:00:00.000Z', // Mar 14, 19:00 in Los Angeles.
          shotType: 'dink',
          overallScore: 6,
          resultKind: 'scored',
        },
      ],
      {
        asOfIso: '2026-03-15T04:00:00.000Z',
        timeZone: 'America/Los_Angeles',
      },
    );
    expect(snapshot.days['2026-03-14']).toBeTruthy();
    expect(snapshot.asOfDay).toBe('2026-03-14');
    expect(snapshot.trainedToday).toBe(true);
  });

  it('is deterministic regardless of input order', () => {
    const inputs = [stroke(3), stroke(1), stroke(2), stroke(5)];
    const forward = snapshotAsOfDay(inputs, 5);
    const reversed = snapshotAsOfDay([...inputs].reverse(), 5);
    expect(forward).toEqual(reversed);
  });
});

describe('flame + heat + momentum helpers', () => {
  it('escalates the flame with the streak', () => {
    expect(flameIntensityForStreak(0)).toBe(0);
    expect(flameIntensityForStreak(1)).toBe(1);
    expect(flameIntensityForStreak(3)).toBe(2);
    expect(flameIntensityForStreak(7)).toBe(3);
    expect(flameIntensityForStreak(14)).toBe(4);
    expect(flameIntensityForStreak(30)).toBe(5);
    expect(flameIntensityForStreak(365)).toBe(5);
  });

  it('levels up on a gentle, capped curve', () => {
    expect(momentumLevelForXp(0)).toEqual({
      level: 1,
      xpIntoLevel: 0,
      xpForNextLevel: 40,
    });
    expect(momentumLevelForXp(39).level).toBe(1);
    expect(momentumLevelForXp(40).level).toBe(2);
    expect(momentumLevelForXp(40 + 55).level).toBe(3);
    expect(xpCostForLevel(100)).toBe(300);
  });
});
