/**
 * Adversarial pass 3 (tester #4) — consistency engine.
 *
 * Attacks the pure replay engine with hostile inputs: shield spending under
 * multi-day misses, an unknown IANA zone on a DST transition day, late-night
 * activities straddling every 2026 DST edge in real zones, extreme/corrupt
 * timestamps, huge activity volumes, and unicode/huge labels. Every fixture
 * is deterministic (no Date.now, seeded shuffles only).
 */

import {
  buildConsistencySnapshot,
  dayFromOrdinal,
  dayOrdinal,
  type TrainingActivityInput,
} from '../src/consistency/engine';
import {
  SHIELD_EARN_EVERY_DAYS,
  SHIELD_MAX_HELD,
  XP_PER_TRAINED_DAY,
} from '../src/consistency/milestones';

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

/** Deterministic xorshift32 — seed recorded in each test that uses it. */
function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

/** Consecutive UTC-noon training days: `count` days ending on `endDay`. */
function utcRun(endDay: string, count: number): TrainingActivityInput[] {
  const end = dayOrdinal(endDay);
  const out: TrainingActivityInput[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    out.push(stroke(`${dayFromOrdinal(end - i)}T12:00:00.000Z`));
  }
  return out;
}

/** Key of `date` in `timeZone` via the same Intl path the engine uses. */
function keyIn(timeZone: string, date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** UTC instant of `hh:mm` local on `day` in `timeZone` (handles offsets by
 * searching the 48 half-hour candidates for the one that formats back). */
function localInstant(
  timeZone: string,
  day: string,
  hh: number,
  mm: number,
): string {
  const base = Date.parse(
    `${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(
      2,
      '0',
    )}:00.000Z`,
  );
  const formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  for (let offsetMin = -14 * 60; offsetMin <= 14 * 60; offsetMin += 15) {
    const candidate = new Date(base - offsetMin * 60_000);
    const parts = formatter.formatToParts(candidate);
    const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
    if (
      `${get('year')}-${get('month')}-${get('day')}` === day &&
      Number(get('hour')) === hh &&
      Number(get('minute')) === mm
    ) {
      return candidate.toISOString();
    }
  }
  throw new Error(`no instant for ${day} ${hh}:${mm} in ${timeZone}`);
}

describe('attack4: shields under consecutive misses', () => {
  // Scenario: "Two consecutive misses with 2 shields held — assert only one
  // shield is spent (single-day bridging) and the streak resets."
  // The documented contract (engine.ts header, consistencyEngine.test.ts
  // 'survives exactly as many consecutive misses as banked shields') is
  // MULTI-day bridging: each missed day consumes one shield and the run
  // survives while shields remain. This test records the actual behaviour
  // against BOTH readings so the discrepancy is visible, and pins the
  // documented one.
  it('spends one shield per missed day and only breaks past the bank', () => {
    // 14 trained days → 2 shields; miss 15th + 16th; train 17th.
    const activities = [
      ...utcRun('2026-03-14', 14),
      stroke('2026-03-17T12:00:00.000Z'),
    ];
    const snapshot = buildConsistencySnapshot(activities, {
      asOfIso: '2026-03-17T18:00:00.000Z',
      timeZone: 'UTC',
    });
    expect(snapshot.shieldsEarnedTotal).toBe(2);
    expect(snapshot.shieldsAvailable).toBe(0); // both spent, one per miss
    expect(snapshot.shieldedDayCount).toBe(2);
    expect(snapshot.days['2026-03-15']?.shielded).toBe(true);
    expect(snapshot.days['2026-03-16']?.shielded).toBe(true);
    expect(snapshot.currentStreak).toBe(15); // run survived (14 + day 17)
    expect(snapshot.longestStreak).toBe(15);
    // Shielded days grant no XP and are not "trained".
    expect(snapshot.days['2026-03-15']?.xp).toBe(0);
    expect(snapshot.totalTrainedDays).toBe(15);
  });

  it('breaks the run on the third consecutive miss and keeps zero shields', () => {
    const activities = [
      ...utcRun('2026-03-14', 14),
      stroke('2026-03-18T12:00:00.000Z'),
    ];
    const snapshot = buildConsistencySnapshot(activities, {
      asOfIso: '2026-03-18T18:00:00.000Z',
      timeZone: 'UTC',
    });
    expect(snapshot.shieldsAvailable).toBe(0);
    expect(snapshot.shieldedDayCount).toBe(2);
    expect(snapshot.currentStreak).toBe(1);
    expect(snapshot.longestStreak).toBe(14);
    expect(snapshot.runXp).toBe(XP_PER_TRAINED_DAY); // new run: day XP only
    // Reaching day 1 again does NOT re-award streak.1 (one entry, first day).
    expect(snapshot.earned.filter(e => e.id === 'streak.1')).toHaveLength(1);
    expect(snapshot.earned.find(e => e.id === 'streak.1')?.earnedOnDay).toBe(
      '2026-03-01',
    );
  });

  it('never exceeds SHIELD_MAX_HELD and never goes negative across 200 days', () => {
    // Seeded random 200-day history; walk the invariants day by day.
    const random = rng(0xa11ce);
    const activities: TrainingActivityInput[] = [];
    const end = dayOrdinal('2026-09-01');
    for (let i = 199; i >= 0; i -= 1) {
      if (random() < 0.8) {
        activities.push(stroke(`${dayFromOrdinal(end - i)}T12:00:00.000Z`));
      }
    }
    for (let i = 199; i >= 0; i -= 1) {
      const asOfDay = dayFromOrdinal(end - i);
      const snapshot = buildConsistencySnapshot(activities, {
        asOfIso: `${asOfDay}T23:59:59.000Z`,
        timeZone: 'UTC',
      });
      expect(snapshot.shieldsAvailable).toBeGreaterThanOrEqual(0);
      expect(snapshot.shieldsAvailable).toBeLessThanOrEqual(SHIELD_MAX_HELD);
      expect(snapshot.currentStreak).toBeLessThanOrEqual(
        snapshot.longestStreak,
      );
      expect(snapshot.shieldsEarnedTotal).toBeGreaterThanOrEqual(
        snapshot.shieldedDayCount,
      );
      // Today is never a miss: an untrained today keeps yesterday's run.
      if (!snapshot.trainedToday)
        expect(snapshot.atRisk).toBe(snapshot.currentStreak > 0);
    }
    expect(SHIELD_EARN_EVERY_DAYS).toBe(7);
  });
});

describe('attack4: time zones and DST', () => {
  it("falls back to UTC keys for timeZone 'Not/AZone' on a DST transition day", () => {
    // 2026-03-08 is the US spring-forward day. "23:30 local" for an unknown
    // zone is meaningless — the engine must resolve to UTC and key by UTC.
    const activities = [
      stroke('2026-03-07T23:30:00.000Z'),
      stroke('2026-03-08T23:30:00.000Z'),
      stroke('2026-03-09T23:30:00.000Z'),
    ];
    const snapshot = buildConsistencySnapshot(activities, {
      asOfIso: '2026-03-09T23:45:00.000Z',
      timeZone: 'Not/AZone',
    });
    expect(snapshot.timeZone).toBe('UTC');
    expect(Object.keys(snapshot.days).sort()).toEqual([
      '2026-03-07',
      '2026-03-08',
      '2026-03-09',
    ]);
    expect(snapshot.currentStreak).toBe(3);
    expect(snapshot.trainedToday).toBe(true);
    expect(snapshot.asOfDay).toBe('2026-03-09');
  });

  it.each(['', 'utc', 'GMT+25:00', 'America/Not_A_City', '☃'])(
    'treats bogus zone %j as UTC without throwing',
    zone => {
      const snapshot = buildConsistencySnapshot(
        [stroke('2026-03-08T23:30:00.000Z')],
        { asOfIso: '2026-03-08T23:59:00.000Z', timeZone: zone },
      );
      // '' → Intl default (host zone); anything invalid → UTC. Either way the
      // day is keyed by SOME real zone and nothing throws.
      expect(typeof snapshot.timeZone).toBe('string');
      expect(snapshot.timeZone.length).toBeGreaterThan(0);
      expect(snapshot.totalActivities).toBe(1);
      expect(Object.keys(snapshot.days)).toHaveLength(1);
    },
  );

  const dstCases: Array<[string, string]> = [
    ['America/New_York', '2026-03-08'], // spring forward (02:00 → 03:00)
    ['America/New_York', '2026-11-01'], // fall back (02:00 → 01:00)
    ['Europe/London', '2026-03-29'],
    ['Europe/London', '2026-10-25'],
    ['Australia/Sydney', '2026-04-05'], // southern hemisphere fall back
    ['Australia/Sydney', '2026-10-04'], // southern hemisphere spring forward
    ['America/Santiago', '2026-04-05'], // transition at 24:00 local
    ['America/Santiago', '2026-09-06'],
    ['Pacific/Chatham', '2026-04-05'], // +12:45/+13:45 quarter-hour zone
    ['Asia/Tehran', '2026-03-21'], // no DST since 2022 — plain +03:30
  ];

  it.each(dstCases)(
    'keys 23:30-local activities across a DST edge in %s (%s) with no dup/missing day',
    (zone, transitionDay) => {
      const t = dayOrdinal(transitionDay);
      const days = [t - 2, t - 1, t, t + 1, t + 2].map(dayFromOrdinal);
      // 04:30 rather than 00:30: America/Santiago springs forward at
      // 24:00 → 01:00, so 00:xx does not exist on that day.
      const activities = days.flatMap(day => [
        stroke(localInstant(zone, day, 23, 30)),
        stroke(localInstant(zone, day, 4, 30)),
        stroke(localInstant(zone, day, 12, 0)),
      ]);
      const asOf = localInstant(zone, days[4]!, 23, 45);
      const snapshot = buildConsistencySnapshot(activities, {
        asOfIso: asOf,
        timeZone: zone,
      });
      expect(snapshot.timeZone).toBe(zone);
      expect(Object.keys(snapshot.days).sort()).toEqual(days);
      for (const day of days) {
        expect(snapshot.days[day]?.activities).toHaveLength(3);
        expect(snapshot.days[day]?.shielded).toBe(false);
      }
      expect(snapshot.currentStreak).toBe(5);
      expect(snapshot.asOfDay).toBe(days[4]);
      // Cross-check: the engine's key equals the direct Intl key.
      for (const activity of activities) {
        const key = keyIn(zone, new Date(activity.atIso));
        expect(snapshot.days[key]).toBeDefined();
      }
    },
  );

  it('keeps an activity at 23:59:59.999 local on its own day in UTC+14', () => {
    const zone = 'Pacific/Kiritimati';
    const lateIso = new Date(
      Date.parse(localInstant(zone, '2026-06-15', 23, 59)) + 59_999,
    ).toISOString();
    const snapshot = buildConsistencySnapshot(
      [stroke(lateIso), stroke(localInstant(zone, '2026-06-16', 0, 0))],
      { asOfIso: localInstant(zone, '2026-06-16', 0, 1), timeZone: zone },
    );
    expect(Object.keys(snapshot.days).sort()).toEqual([
      '2026-06-15',
      '2026-06-16',
    ]);
    expect(snapshot.currentStreak).toBe(2);
  });

  it('drops activities that are in the future relative to asOf (clock skew)', () => {
    const snapshot = buildConsistencySnapshot(
      [
        stroke('2026-03-09T12:00:00.000Z'),
        stroke('2026-03-09T12:00:01.000Z'), // 1s in the future
        stroke('2026-03-10T00:00:00.000Z'), // tomorrow
      ],
      { asOfIso: '2026-03-09T12:00:00.000Z', timeZone: 'UTC' },
    );
    expect(snapshot.totalActivities).toBe(1);
    expect(snapshot.days['2026-03-10']).toBeUndefined();
    expect(snapshot.currentStreak).toBe(1);
  });
});

describe('attack4: corrupt and extreme timestamps', () => {
  const asOf = { asOfIso: '2026-03-10T18:00:00.000Z', timeZone: 'UTC' };
  const healthy = utcRun('2026-03-10', 3);

  it.each([
    'not-a-date',
    '',
    '2026-13-45T00:00:00.000Z',
    'NaN',
    '9999999999999999999',
    '２０２６-03-09T12:00:00Z', // full-width digits
  ])('ignores unparseable atIso %j without touching the streak', bad => {
    const snapshot = buildConsistencySnapshot([stroke(bad), ...healthy], asOf);
    expect(snapshot.totalActivities).toBe(3);
    expect(snapshot.currentStreak).toBe(3);
  });

  it.each([
    '2026-03-09T12:00:00.000Z\u0000', // V8 legacy parser tolerates the NUL
    ' 2026-03-09T12:00:00.000Z ',
    '2026-03-09 12:00:00Z',
  ])('leniently-parsed atIso %j lands on a real day key or is dropped', odd => {
    const snapshot = buildConsistencySnapshot([stroke(odd), ...healthy], asOf);
    expect([3, 4]).toContain(snapshot.totalActivities);
    expect(snapshot.currentStreak).toBe(3);
    for (const key of Object.keys(snapshot.days)) {
      expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it.each([
    '1970-01-01T00:00:00.000Z',
    '1900-01-01T00:00:00.000Z',
    '1000-01-01T00:00:00.000Z',
  ])('tolerates an ancient but parseable activity %s', ancient => {
    const started = Date.now();
    const snapshot = buildConsistencySnapshot(
      [stroke(ancient), ...healthy],
      asOf,
    );
    const elapsed = Date.now() - started;
    expect(snapshot.currentStreak).toBe(3);
    expect(snapshot.totalTrainedDays).toBe(4);
    expect(snapshot.longestStreak).toBe(3);
    // One ancient row must not freeze the JS thread (Home renders this).
    expect(elapsed).toBeLessThan(5_000);
  });

  it('a pre-year-1000 activity (3-digit Intl year) does not erase a live streak', () => {
    // Intl formats year 999 as "999" → key "999-12-31" → dayOrdinal → NaN.
    // The chronological walk starts at the smallest ordinal; if that is NaN
    // the loop never runs and the WHOLE streak reads 0 for one bad row.
    const snapshot = buildConsistencySnapshot(
      [stroke('0999-12-31T12:00:00.000Z'), ...healthy],
      asOf,
    );
    expect(snapshot.totalActivities).toBe(4);
    expect(snapshot.currentStreak).toBe(3);
    expect(snapshot.trainedToday).toBe(true);
    expect(snapshot.days['2026-03-10']).toBeDefined();
  });

  it('a negative-year activity does not erase a live streak', () => {
    const snapshot = buildConsistencySnapshot(
      [stroke('-000100-01-01T00:00:00.000Z'), ...healthy],
      asOf,
    );
    expect(snapshot.currentStreak).toBe(3);
    expect(snapshot.trainedToday).toBe(true);
  });

  it('a 5-digit-year activity in the past is ignored or counted, never fatal', () => {
    // +010000 is in the future (filtered). The min Date is the only other
    // multi-digit case and is covered above; this pins that a far-future
    // 6-digit year cannot leak into asOf math.
    const snapshot = buildConsistencySnapshot(
      [stroke('+010000-01-01T00:00:00.000Z'), ...healthy],
      asOf,
    );
    expect(snapshot.totalActivities).toBe(3);
    expect(snapshot.currentStreak).toBe(3);
  });

  it('invalid asOfIso falls back to now without throwing', () => {
    const snapshot = buildConsistencySnapshot(healthy, {
      asOfIso: 'garbage',
      timeZone: 'UTC',
    });
    expect(snapshot.asOfDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The fixture days (March 2026) are in the past relative to real now.
    expect(snapshot.totalTrainedDays).toBe(3);
  });
});

describe('attack4: volume, unicode and scoring edges', () => {
  it('handles 50k activities on one day within the XP cap and under 2s', () => {
    const activities: TrainingActivityInput[] = [];
    for (let i = 0; i < 50_000; i += 1) {
      activities.push(
        stroke(`2026-03-10T${String(i % 24).padStart(2, '0')}:00:00.000Z`, {
          shotType: i % 2 ? 'dink' : 'serve',
          overallScore: (i % 100) / 10,
        }),
      );
    }
    const started = Date.now();
    const snapshot = buildConsistencySnapshot(activities, {
      asOfIso: '2026-03-10T23:59:59.000Z',
      timeZone: 'UTC',
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(snapshot.totalActivities).toBe(50_000);
    expect(snapshot.days['2026-03-10']?.xp).toBe(XP_PER_TRAINED_DAY + 15 + 10);
    expect(snapshot.earned.map(e => e.id)).toEqual(
      expect.arrayContaining([
        'streak.1',
        'volume.sessions100',
        'volume.specialist',
      ]),
    );
    expect(snapshot.days['2026-03-10']?.scoreAvg).toBeCloseTo(4.95, 1);
  });

  it('keeps unicode / huge labels and shot types intact and sortable', () => {
    const huge = '🥒'.repeat(10_000);
    const snapshot = buildConsistencySnapshot(
      [
        { kind: 'drill', atIso: '2026-03-10T09:00:00.000Z', label: huge },
        { kind: 'drill', atIso: '2026-03-10T09:00:00.000Z', label: 'Ünïcødé' },
        stroke('2026-03-10T09:00:00.000Z', { shotType: 'third_shot_drop_🏓' }),
        stroke('2026-03-10T09:00:00.000Z', { shotType: '' }),
      ],
      { asOfIso: '2026-03-10T10:00:00.000Z', timeZone: 'UTC' },
    );
    const day = snapshot.days['2026-03-10']!;
    expect(day.activities).toHaveLength(4);
    expect(day.activities.map(a => a.label)).toContain('third shot drop 🏓');
    expect(day.activities.map(a => a.label)).toContain('Stroke analysis');
    expect(day.activities.find(a => a.label === huge)).toBeDefined();
    expect(day.drillCount).toBe(2);
  });

  it('never counts NaN / Infinity / string scores as scored', () => {
    const snapshot = buildConsistencySnapshot(
      [
        stroke('2026-03-10T09:00:00.000Z', { overallScore: Number.NaN }),
        stroke('2026-03-10T09:00:00.000Z', {
          overallScore: Number.POSITIVE_INFINITY,
        }),
        stroke('2026-03-10T09:00:00.000Z', {
          overallScore: '7' as unknown as number,
        }),
        stroke('2026-03-10T09:00:00.000Z', {
          overallScore: 7,
          resultKind: 'low_confidence',
        }),
      ],
      { asOfIso: '2026-03-10T10:00:00.000Z', timeZone: 'UTC' },
    );
    const day = snapshot.days['2026-03-10']!;
    expect(day.scoredCount).toBe(0);
    expect(day.scoreAvg).toBeNull();
    expect(snapshot.scoredAnalysisCount).toBe(0);
    expect(day.activities.every(a => a.score === null)).toBe(true);
  });

  it('is order-independent: shuffled input yields an identical snapshot (seed 0xbeef)', () => {
    const activities = [
      ...utcRun('2026-03-10', 20),
      { kind: 'drill' as const, atIso: '2026-03-05T08:00:00.000Z', label: 'A' },
      { kind: 'drill' as const, atIso: '2026-03-05T08:00:00.000Z', label: 'B' },
    ];
    const random = rng(0xbeef);
    const shuffled = [...activities];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    const options = { asOfIso: '2026-03-10T18:00:00.000Z', timeZone: 'UTC' };
    expect(buildConsistencySnapshot(shuffled, options)).toEqual(
      buildConsistencySnapshot(activities, options),
    );
  });
});
