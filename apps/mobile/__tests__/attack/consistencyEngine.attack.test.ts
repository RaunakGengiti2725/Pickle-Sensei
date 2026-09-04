/**
 * Adversarial pass (mobile-home-progress-library #1, pass 3) against the
 * pure consistency engine: corrupt timestamps, clock skew, shield
 * semantics, legacy-lenient Date.parse inputs, huge histories, DST and
 * unicode. Every assertion states the rule the engine documents; a failure
 * here is a finding, not a fixture problem.
 */
import {
  buildConsistencySnapshot,
  dayHeatLevel,
  specialistTitle,
  type TrainingActivityInput,
} from '../../src/consistency/engine';
import {
  SHIELD_EARN_EVERY_DAYS,
  STREAK_MILESTONES,
  XP_EXTRA_ACTIVITY_CAP,
  XP_PER_EXTRA_ACTIVITY,
  XP_PER_TRAINED_DAY,
} from '../../src/consistency/milestones';

const TZ = 'UTC';

function stroke(
  atIso: string,
  extra: Partial<TrainingActivityInput> = {},
): TrainingActivityInput {
  return {
    kind: 'stroke',
    atIso,
    shotType: 'dink',
    overallScore: 6,
    resultKind: 'scored',
    ...extra,
  };
}

function marchDay(day: number, hour = 10): string {
  return `2026-03-${String(day).padStart(2, '0')}T${String(hour).padStart(
    2,
    '0',
  )}:00:00.000Z`;
}

function snapshotAsOf(activities: TrainingActivityInput[], asOfIso: string) {
  return buildConsistencySnapshot(activities, { asOfIso, timeZone: TZ });
}

describe('S1 — invalid / skewed activity timestamps', () => {
  const asOfIso = marchDay(10, 18);

  it('ignores "2026-13-45T00:00:00Z", "", "NaN" and a +48h row; counts only valid rows', () => {
    const valid = [stroke(marchDay(9)), stroke(marchDay(10, 9))];
    const invalid = [
      stroke('2026-13-45T00:00:00Z'),
      stroke(''),
      stroke('NaN'),
      stroke(new Date(Date.parse(asOfIso) + 48 * 3_600_000).toISOString()),
    ];
    // Interleave so ordering cannot mask a skipped-row bug.
    const activities = [
      invalid[0]!,
      valid[0]!,
      invalid[1]!,
      invalid[2]!,
      valid[1]!,
      invalid[3]!,
    ];
    const snapshot = snapshotAsOf(activities, asOfIso);
    expect(snapshot.totalActivities).toBe(2);
    expect(snapshot.scoredAnalysisCount).toBe(2);
    expect(Object.keys(snapshot.days).sort()).toEqual([
      '2026-03-09',
      '2026-03-10',
    ]);
    expect(snapshot.currentStreak).toBe(2);
    expect(snapshot.trainedToday).toBe(true);
    // No day bucket may carry an invalid row.
    for (const day of Object.values(snapshot.days)) {
      for (const activity of day.activities) {
        expect(Number.isFinite(Date.parse(activity.atIso))).toBe(true);
      }
    }
  });

  it('ignores every invalid row when ONLY invalid rows exist (empty snapshot, no throw)', () => {
    const snapshot = snapshotAsOf(
      [
        stroke('2026-13-45T00:00:00Z'),
        stroke(''),
        stroke('NaN'),
        stroke('undefined'),
        stroke('null'),
        stroke('Invalid Date'),
        stroke('2026-03-10T25:00:00Z'),
        stroke('2026-03-10T10:60:00Z'),
        stroke(marchDay(12)),
      ],
      asOfIso,
    );
    expect(snapshot.totalActivities).toBe(0);
    expect(snapshot.currentStreak).toBe(0);
    expect(snapshot.days).toEqual({});
    expect(snapshot.nextStreakMilestone?.days).toBe(1);
  });

  it('drops a row one millisecond after asOf but keeps one at exactly asOf', () => {
    const asOfMs = Date.parse(asOfIso);
    const snapshot = snapshotAsOf(
      [
        stroke(new Date(asOfMs).toISOString()),
        stroke(new Date(asOfMs + 1).toISOString()),
      ],
      asOfIso,
    );
    expect(snapshot.totalActivities).toBe(1);
  });

  it('a future row on the SAME local day (clock skew of +5 min) is skipped, so today may look untrained', () => {
    const asOfMs = Date.parse(asOfIso);
    const snapshot = snapshotAsOf(
      [
        stroke(marchDay(9)),
        stroke(new Date(asOfMs + 5 * 60_000).toISOString()),
      ],
      asOfIso,
    );
    // Documented rule: anything after asOf is not evidence yet. The streak
    // is not broken (today is still open), only "at risk".
    expect(snapshot.totalActivities).toBe(1);
    expect(snapshot.trainedToday).toBe(false);
    expect(snapshot.atRisk).toBe(true);
    expect(snapshot.currentStreak).toBe(1);
  });

  it('is identical whether the invalid rows come first, last or shuffled (seed 1337)', () => {
    let seed = 1337;
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const base = [
      stroke(marchDay(8)),
      stroke(marchDay(9)),
      stroke(marchDay(10, 9)),
      stroke('2026-13-45T00:00:00Z'),
      stroke(''),
      stroke('NaN'),
      stroke(marchDay(12)),
    ];
    const reference = snapshotAsOf(base, asOfIso);
    for (let round = 0; round < 25; round += 1) {
      const shuffled = [...base];
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rand() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      expect(snapshotAsOf(shuffled, asOfIso)).toEqual(reference);
    }
  });
});

describe('S2 — exactly 7 trained days, one miss, then activity (shield)', () => {
  const activities = [
    ...[1, 2, 3, 4, 5, 6, 7].map(day => stroke(marchDay(day))),
    // day 8 missed
    stroke(marchDay(9)),
  ];

  it('banks one shield on day 7, spends it on day 8, and the run continues to 8', () => {
    expect(SHIELD_EARN_EVERY_DAYS).toBe(7);
    const snapshot = snapshotAsOf(activities, marchDay(9, 18));
    expect(snapshot.shieldsEarnedTotal).toBe(1);
    expect(snapshot.shieldsAvailable).toBe(0);
    expect(snapshot.shieldedDayCount).toBe(1);
    expect(snapshot.currentStreak).toBe(8);
    expect(snapshot.longestStreak).toBe(8);
    expect(snapshot.totalTrainedDays).toBe(8);
    expect(snapshot.trainedToday).toBe(true);
    expect(snapshot.atRisk).toBe(false);
  });

  it('the shielded day grants 0 XP, heat 0, no activities and is flagged shielded', () => {
    const snapshot = snapshotAsOf(activities, marchDay(9, 18));
    const shielded = snapshot.days['2026-03-08'];
    expect(shielded).toBeDefined();
    expect(shielded!.shielded).toBe(true);
    expect(shielded!.xp).toBe(0);
    expect(shielded!.activities).toEqual([]);
    expect(shielded!.scoreAvg).toBeNull();
    expect(dayHeatLevel(shielded)).toBe(0);
    // Total XP equals the sum over trained days only.
    const trainedXp = Object.values(snapshot.days)
      .filter(d => !d.shielded)
      .reduce((sum, d) => sum + d.xp, 0);
    expect(snapshot.momentumXp).toBe(trainedXp);
    expect(snapshot.runXp).toBe(trainedXp);
  });

  it('with the shield spent, a SECOND consecutive miss breaks the run', () => {
    const twoMisses = [
      ...[1, 2, 3, 4, 5, 6, 7].map(day => stroke(marchDay(day))),
      stroke(marchDay(10)),
    ];
    const snapshot = snapshotAsOf(twoMisses, marchDay(10, 18));
    expect(snapshot.shieldedDayCount).toBe(1);
    expect(snapshot.currentStreak).toBe(1);
    expect(snapshot.longestStreak).toBe(7);
    expect(snapshot.days['2026-03-08']?.shielded).toBe(true);
    expect(snapshot.days['2026-03-09']).toBeUndefined();
  });

  it('a shield is NOT spent while today is still open (miss = today)', () => {
    const snapshot = snapshotAsOf(
      [1, 2, 3, 4, 5, 6, 7].map(day => stroke(marchDay(day))),
      marchDay(8, 18),
    );
    expect(snapshot.shieldsAvailable).toBe(1);
    expect(snapshot.shieldedDayCount).toBe(0);
    expect(snapshot.currentStreak).toBe(7);
    expect(snapshot.atRisk).toBe(true);
  });

  it('day 14 after a bridged day 8 banks the second shield (run counts trained days only)', () => {
    const acts = [
      ...[1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15].map(day =>
        stroke(marchDay(day)),
      ),
    ];
    const snapshot = snapshotAsOf(acts, marchDay(15, 18));
    // 14 trained days → run 14 → second shield banked on 2026-03-15.
    expect(snapshot.currentStreak).toBe(14);
    expect(snapshot.shieldsEarnedTotal).toBe(2);
    expect(snapshot.shieldsAvailable).toBe(1);
  });
});

describe('extra — lenient Date.parse inputs and huge histories', () => {
  const asOfIso = marchDay(10, 18);

  it('records how V8 treats non-ISO strings ("12", "0", "March") — documents whether they count', () => {
    // '2026-02-30' is NOT rejected by V8 — it rolls to 2026-03-02.
    const probes = [
      '12',
      '0',
      'March',
      '2026',
      '2026-3-1',
      '3/1/2026',
      '2026-02-30T00:00:00Z',
    ];
    const results = probes.map(p => ({
      p,
      parsed: Date.parse(p),
      counted: snapshotAsOf([stroke(p)], asOfIso).totalActivities,
    }));
    for (const r of results) {
      // Whatever V8 decides, the engine must agree with Date.parse — a
      // finite parse counts, NaN does not. (Legacy forms like "12" parse to
      // 2001-12-01 in V8; the engine counts them. Documented, not a break:
      // captured_at is written by the app as ISO.)
      expect(r.counted).toBe(Number.isFinite(r.parsed) ? 1 : 0);
    }
  });

  it('an epoch-0 corrupted row (1970) does not crash and walks the calendar in bounded time', () => {
    const started = Date.now();
    const snapshot = snapshotAsOf(
      [stroke('1970-01-01T00:00:00.000Z'), stroke(marchDay(10, 9))],
      asOfIso,
    );
    const elapsed = Date.now() - started;
    expect(snapshot.totalActivities).toBe(2);
    expect(snapshot.totalTrainedDays).toBe(2);
    expect(snapshot.currentStreak).toBe(1);
    expect(snapshot.longestStreak).toBe(1);
    expect(elapsed).toBeLessThan(2_000);
  });

  // FINDING (P3, pre-existing on main): Intl 'numeric' years < 1000 format
  // as "999", not "0999", so dayOrdinal("999-01-01") is NaN. The NaN passes
  // the `> asOfOrdinal` guard, is bucketed and counted, and — because
  // listActivityShots orders by captured_at ASC, so such a row is FIRST —
  // becomes firstOrdinal, which skips the whole chronological walk:
  // streak 0 / trainedDays 0 / XP 0 while trainedToday stays true.
  // `it.failing` documents the expected rule; flip to `it` once fixed.
  it.failing(
    'a single year-0999 row sorted first must not erase the real streak (engine.ts:148-150, 280-283)',
    () => {
      const valid = [
        stroke(marchDay(8)),
        stroke(marchDay(9)),
        stroke(marchDay(10, 9)),
      ];
      const corruptFirst = snapshotAsOf(
        [stroke('0999-01-01T00:00:00.000Z'), ...valid],
        asOfIso,
      );
      const clean = snapshotAsOf(valid, asOfIso);
      expect(corruptFirst.currentStreak).toBe(clean.currentStreak);
      expect(corruptFirst.totalTrainedDays).toBe(clean.totalTrainedDays);
      expect(corruptFirst.momentumXp).toBe(clean.momentumXp);
    },
  );

  it('the same corrupt row placed LAST leaves the streak intact — the result is order-dependent (documents the finding)', () => {
    const valid = [
      stroke(marchDay(8)),
      stroke(marchDay(9)),
      stroke(marchDay(10, 9)),
    ];
    const corruptLast = snapshotAsOf(
      [...valid, stroke('0999-01-01T00:00:00.000Z')],
      asOfIso,
    );
    const corruptFirst = snapshotAsOf(
      [stroke('0999-01-01T00:00:00.000Z'), ...valid],
      asOfIso,
    );
    console.info(
      `[attack][finding] year<1000 corrupt-first=${JSON.stringify({
        totalActivities: corruptFirst.totalActivities,
        totalTrainedDays: corruptFirst.totalTrainedDays,
        currentStreak: corruptFirst.currentStreak,
        trainedToday: corruptFirst.trainedToday,
        momentumXp: corruptFirst.momentumXp,
      })} corrupt-last=${JSON.stringify({
        totalActivities: corruptLast.totalActivities,
        totalTrainedDays: corruptLast.totalTrainedDays,
        currentStreak: corruptLast.currentStreak,
        trainedToday: corruptLast.trainedToday,
        momentumXp: corruptLast.momentumXp,
      })}`,
    );
    expect(corruptLast.currentStreak).toBe(3);
    expect(corruptLast.totalActivities).toBe(4);
    // The corrupt row is counted but never lands in a day bucket.
    expect(Object.keys(corruptLast.days).sort()).toEqual([
      '2026-03-08',
      '2026-03-09',
      '2026-03-10',
    ]);
  });

  it('year >= 1000 far-past rows (e.g. 1000-01-01) are handled: bounded walk, streak intact', () => {
    const started = Date.now();
    const snapshot = snapshotAsOf(
      [stroke('1000-01-01T00:00:00.000Z'), stroke(marchDay(10, 9))],
      asOfIso,
    );
    const elapsed = Date.now() - started;
    console.info(`[attack] year-1000 walk elapsed ${elapsed}ms`);
    expect(snapshot.totalActivities).toBe(2);
    expect(snapshot.totalTrainedDays).toBe(2);
    expect(snapshot.currentStreak).toBe(1);
    expect(elapsed).toBeLessThan(10_000);
  });

  it('a negative-year row (-000001) is finite for Date.parse; the engine must not throw on it', () => {
    expect(() =>
      snapshotAsOf([stroke('-000001-01-01T00:00:00.000Z')], asOfIso),
    ).not.toThrow();
  });

  it('50,000 activities on one day cap XP and keep heat at 3', () => {
    const many: TrainingActivityInput[] = [];
    for (let i = 0; i < 50_000; i += 1) {
      many.push(stroke(marchDay(10, 9), { overallScore: (i % 10) + 0.5 }));
    }
    const snapshot = snapshotAsOf(many, asOfIso);
    const today = snapshot.days['2026-03-10']!;
    expect(snapshot.totalActivities).toBe(50_000);
    const dayOneBonus = STREAK_MILESTONES.find(m => m.days === 1)?.bonusXp ?? 0;
    expect(today.xp).toBe(
      XP_PER_TRAINED_DAY +
        Math.min(49_999 * XP_PER_EXTRA_ACTIVITY, XP_EXTRA_ACTIVITY_CAP) +
        dayOneBonus,
    );
    expect(dayHeatLevel(today)).toBe(3);
    expect(today.scoreAvg).toBe(5);
  });

  it('non-finite overallScore with resultKind scored is not counted as scored', () => {
    const snapshot = snapshotAsOf(
      [
        stroke(marchDay(10, 9), { overallScore: Number.NaN }),
        stroke(marchDay(10, 9), { overallScore: Number.POSITIVE_INFINITY }),
        stroke(marchDay(10, 9), { overallScore: null }),
        stroke(marchDay(10, 9), { overallScore: 7 }),
      ],
      asOfIso,
    );
    expect(snapshot.scoredAnalysisCount).toBe(1);
    expect(snapshot.days['2026-03-10']!.scoreAvg).toBe(7);
    expect(snapshot.days['2026-03-10']!.scoredCount).toBe(1);
  });
});

describe('extra — time zones and unicode', () => {
  it('an invalid IANA zone falls back to UTC and reports the resolved zone', () => {
    const snapshot = buildConsistencySnapshot([stroke(marchDay(10, 9))], {
      asOfIso: marchDay(10, 18),
      timeZone: 'Mars/Olympus_Mons',
    });
    expect(snapshot.timeZone).toBe('UTC');
    expect(snapshot.currentStreak).toBe(1);
  });

  it('a DST spring-forward day still counts as one local day (America/New_York 2026-03-08)', () => {
    // 2026-03-08 02:00 local → 03:00. 01:30 EST and 03:30 EDT are the same day.
    const snapshot = buildConsistencySnapshot(
      [
        stroke('2026-03-08T06:30:00.000Z'), // 01:30 EST
        stroke('2026-03-08T07:30:00.000Z'), // 03:30 EDT
        stroke('2026-03-07T17:00:00.000Z'), // 12:00 EST day before
      ],
      { asOfIso: '2026-03-08T23:00:00.000Z', timeZone: 'America/New_York' },
    );
    expect(Object.keys(snapshot.days).sort()).toEqual([
      '2026-03-07',
      '2026-03-08',
    ]);
    expect(snapshot.days['2026-03-08']!.strokeCount).toBe(2);
    expect(snapshot.currentStreak).toBe(2);
  });

  it('Pacific/Kiritimati (+14) vs Pacific/Pago_Pago (-11): same instant, different calendar days', () => {
    const at = '2026-03-10T01:00:00.000Z';
    const east = buildConsistencySnapshot([stroke(at)], {
      asOfIso: '2026-03-10T23:00:00.000Z',
      timeZone: 'Pacific/Kiritimati',
    });
    const west = buildConsistencySnapshot([stroke(at)], {
      asOfIso: '2026-03-10T23:00:00.000Z',
      timeZone: 'Pacific/Pago_Pago',
    });
    expect(Object.keys(east.days)).toEqual(['2026-03-10']);
    expect(Object.keys(west.days)).toEqual(['2026-03-09']);
  });

  it('asOfIso that is itself invalid does not throw and still yields a day key', () => {
    const snapshot = buildConsistencySnapshot([stroke(marchDay(1))], {
      asOfIso: 'not-a-date',
      timeZone: TZ,
    });
    expect(snapshot.asOfDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('specialistTitle survives unicode / emoji / empty technique names', () => {
    expect(specialistTitle('third_shot_drop')).toBe(
      'Third Shot Drop Specialist',
    );
    expect(specialistTitle('')).toBe(' Specialist');
    expect(specialistTitle('__')).toBe(' Specialist');
    expect(specialistTitle('🏓_smash')).toBe('🏓 Smash Specialist');
    expect(specialistTitle('ß_dink')).toBe('SS Dink Specialist');
  });
});
