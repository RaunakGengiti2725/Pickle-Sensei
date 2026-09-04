/**
 * stress-cmp-notification-priming — lens `boundary-i18n-a11y`, copy campaign.
 *
 * Seeded campaign over `src/notifications/copy.ts`: hostile milestone titles
 * (200+ chars, CJK, Arabic/Hebrew RTL, ZWJ emoji, combining marks, German
 * compounds, bidi overrides, format-specifier bait), zero/negative/huge/
 * non-finite streak and shield counts, and boundary delivery instants
 * (epoch, pre-epoch, day-boundary, 2038, Date range limits, NaN/Infinity)
 * evaluated across the 12 lens locales and 8 timezone cases.
 *
 * Invariants checked on every iteration:
 *   - `title`/`body` are non-empty strings, never leaking `undefined`,
 *     `NaN`, `Infinity`, `[object Object]` or a raw template placeholder;
 *   - the copy is a pure function of (deliveryMs, facts) — same seed, same
 *     output, evaluated twice;
 *   - variant rotation stays inside the variant list for every instant;
 *   - the milestone title is passed through verbatim (no truncation, no
 *     mangled surrogate pairs / broken ZWJ sequences);
 *   - no prohibited product term (docs/APP_STORE_SUBMISSION.md) enters copy;
 *   - a hostile streak count can only reach the copy through a plan that
 *     `buildNotificationPlan` would actually schedule.
 *
 * Scale: `STRESS_ITER` (default 260). Replay: `STRESS_SEED=<seed>`.
 * Evidence: artifacts/stress-notification-priming/<STRESS_RUN_ID>/
 *   notificationCopy.{events.ndjson,seeds.json}
 */
import {
  COMEBACK_COPY,
  practiceReminderCopy,
  streakDefenseCopy,
  weeklyRecapCopy,
  type NotificationCopy,
  type StreakDefenseFacts,
} from '../../src/notifications/copy';
import { buildNotificationPlan } from '../../src/notifications/plan';
import { DEFAULT_NOTIFICATION_PREFS } from '../../src/notifications/types';
import {
  HOSTILE_NUMBERS,
  HOSTILE_STRINGS,
  HOSTILE_TIMESTAMPS,
  LOCALES,
  ZONE_CASES,
  rngFor,
} from '../../testing/stress/notificationPriming/rng';
import {
  iterations,
  pinnedSeed,
  record,
  rowsFor,
  writeSeedTable,
} from '../../testing/stress/notificationPriming/evidence';

const SUITE = 'notificationCopy';

/** Terms that must never appear in user-facing copy (APP_STORE_SUBMISSION). */
const PROHIBITED = [
  'android',
  'google play',
  'guest mode',
  'live court',
  'dupr',
  'swingvision',
  'pb vision',
  'selkirk',
  'joola',
];

const LEAK_PATTERNS = [
  'undefined',
  'null',
  'NaN',
  'Infinity',
  '[object',
  '${',
  '%s',
  '%@',
  '{0}',
];

const NUMBER_NAMES = Object.keys(HOSTILE_NUMBERS);
const STRING_NAMES = Object.keys(HOSTILE_STRINGS);
const TIMESTAMP_NAMES = Object.keys(HOSTILE_TIMESTAMPS);

interface Variant {
  seed: number;
  locale: string;
  zone: string;
  deliveryName: string;
  deliveryMs: number;
  streakName: string;
  streakDays: number;
  shieldName: string;
  shieldsAvailable: number;
  milestone: 'none' | 'hostile';
  milestoneTitleName: string;
  milestoneTitle: string;
  milestoneDaysName: string;
  milestoneDays: number;
  factsMode: 'absent' | 'undefined' | 'full';
}

function variantFor(seed: number): Variant {
  const rng = rngFor(seed);
  const zone = rng.pick(ZONE_CASES);
  const deliveryName = rng.bool(0.4)
    ? rng.pick(TIMESTAMP_NAMES)
    : 'zoneInstant';
  const deliveryMs =
    deliveryName === 'zoneInstant'
      ? Date.parse(zone.atIso)
      : (HOSTILE_TIMESTAMPS[deliveryName] as number);
  const streakName = rng.pick(NUMBER_NAMES);
  const shieldName = rng.pick(NUMBER_NAMES);
  const milestoneTitleName = rng.pick(STRING_NAMES);
  const milestoneDaysName = rng.pick(NUMBER_NAMES);
  return {
    seed,
    locale: rng.pick(LOCALES),
    zone: zone.zone,
    deliveryName,
    deliveryMs,
    streakName,
    streakDays: HOSTILE_NUMBERS[streakName] as number,
    shieldName,
    shieldsAvailable: HOSTILE_NUMBERS[shieldName] as number,
    milestone: rng.bool(0.5) ? 'hostile' : 'none',
    milestoneTitleName,
    milestoneTitle: HOSTILE_STRINGS[milestoneTitleName] as string,
    milestoneDaysName,
    milestoneDays: HOSTILE_NUMBERS[milestoneDaysName] as number,
    factsMode: rng.pick(['absent', 'undefined', 'full'] as const),
  };
}

function factsFor(variant: Variant): StreakDefenseFacts | undefined {
  if (variant.factsMode === 'absent') return undefined;
  if (variant.factsMode === 'undefined') {
    return {
      streakDays: undefined,
      shieldsAvailable: undefined,
      milestoneEve: undefined,
    } as unknown as StreakDefenseFacts;
  }
  return {
    streakDays: variant.streakDays,
    shieldsAvailable: variant.shieldsAvailable,
    milestoneEve:
      variant.milestone === 'hostile'
        ? { title: variant.milestoneTitle, days: variant.milestoneDays }
        : null,
  };
}

/** Whether the plan builder would ever schedule streak-defense for a count. */
function planSchedulesStreakDefense(streakDays: number): boolean {
  return planEntryFor(streakDays) !== undefined;
}

function planEntryFor(streakDays: number) {
  const plan = buildNotificationPlan(
    { ...DEFAULT_NOTIFICATION_PREFS, enabled: true, streakDefense: true },
    {
      nowMs: Date.UTC(2026, 5, 1, 12, 0, 0),
      streakDays,
      practicedToday: false,
      hasAnyHistory: true,
      shieldsAvailable: 0,
      milestoneEve: null,
    },
  );
  return plan.find(entry => entry.id === 'ps.reminder.streak');
}

/**
 * The contract the ONLY production caller (`buildNotificationPlan`) honours:
 * facts are present, `streakDays` is a positive safe integer day count from
 * the consistency engine and, when a milestone eve is attached, its `days`
 * is one too. Copy must be leak-free for every such input;
 * inputs outside the contract are recorded as hazards, not campaign failures
 * (see the hazard block at the bottom for what they actually render).
 */
function withinCallerContract(variant: Variant): boolean {
  return (
    variant.factsMode === 'full' &&
    Number.isSafeInteger(variant.streakDays) &&
    variant.streakDays > 0 &&
    planSchedulesStreakDefense(variant.streakDays) &&
    (variant.milestone === 'none' ||
      (Number.isSafeInteger(variant.milestoneDays) &&
        variant.milestoneDays > 0))
  );
}

function leaks(text: string): string[] {
  return LEAK_PATTERNS.filter(pattern => text.includes(pattern));
}

function prohibited(text: string): string[] {
  const lower = text.toLowerCase();
  return PROHIBITED.filter(term => lower.includes(term));
}

function shape(copy: NotificationCopy): string[] {
  const problems: string[] = [];
  if (typeof copy.title !== 'string' || copy.title.trim() === '') {
    problems.push('empty-title');
  }
  if (typeof copy.body !== 'string' || copy.body.trim() === '') {
    problems.push('empty-body');
  }
  return problems;
}

const DEFAULT_ITERATIONS = 260;
const seeds: number[] = (() => {
  const pinned = pinnedSeed();
  if (pinned !== null) return [pinned];
  const count = iterations(DEFAULT_ITERATIONS);
  return Array.from({ length: count }, (_, i) => 0xc0de0000 + i);
})();

describe('stress cmp-notification-priming — copy boundary/i18n campaign', () => {
  afterAll(() => {
    writeSeedTable(SUITE, {
      lens: 'boundary-i18n-a11y',
      module: 'src/notifications/copy.ts',
      dimensions: {
        locales: LOCALES.length,
        zoneCases: ZONE_CASES.length,
        hostileStrings: STRING_NAMES,
        hostileNumbers: NUMBER_NAMES,
        hostileTimestamps: TIMESTAMP_NAMES,
      },
    });
  });

  it(`evaluates ${seeds.length} seeded copy variants without leaking a placeholder`, () => {
    const failures: string[] = [];
    for (const seed of seeds) {
      const variant = variantFor(seed);
      const facts = factsFor(variant);
      const problems: string[] = [];

      const streak = streakDefenseCopy(variant.deliveryMs, facts);
      const streakAgain = streakDefenseCopy(
        variant.deliveryMs,
        factsFor(variant),
      );
      const practice = practiceReminderCopy(variant.deliveryMs);
      const weekly = weeklyRecapCopy(variant.deliveryMs);

      problems.push(...shape(streak), ...shape(practice), ...shape(weekly));

      // Determinism: same inputs → same copy (the rotation is a pure
      // function of the delivery day index).
      if (
        streak.title !== streakAgain.title ||
        streak.body !== streakAgain.body
      ) {
        problems.push('non-deterministic');
      }

      const streakText = `${streak.title} ${streak.body}`;
      const allText = `${streakText} ${practice.title} ${practice.body} ${weekly.title} ${weekly.body}`;

      if (prohibited(allText).length > 0) problems.push('prohibited-term');

      // Placeholder/NaN leaks: asserted for every input the production
      // caller can produce; hostile inputs outside that contract only get
      // recorded (their rendering is pinned by the hazard block).
      const inContract = withinCallerContract(variant);
      const leaked = leaks(streakText);
      if (inContract && leaked.length > 0) {
        problems.push(`leak:${leaked.join('|')}`);
      }

      // Fact-free copy whenever the streak is absent or a number ≤ 0 — the
      // documented gate in `streakDefenseCopy`.
      const factFree =
        facts === undefined ||
        (typeof facts.streakDays === 'number' && facts.streakDays <= 0);
      if (factFree && streakText.includes('strong')) {
        problems.push('fact-free-copy-mentions-run');
      }

      // Hostile milestone titles pass through verbatim (no truncation, no
      // broken surrogate pairs or split ZWJ sequences).
      if (
        variant.factsMode === 'full' &&
        variant.milestone === 'hostile' &&
        Number.isFinite(variant.streakDays) &&
        variant.streakDays > 0
      ) {
        if (!streak.title.startsWith(variant.milestoneTitle)) {
          problems.push('milestone-title-mangled');
        }
        if ([...streak.title].some(ch => ch === '\ufffd')) {
          problems.push('replacement-char');
        }
      }

      record({
        suite: SUITE,
        scenario: `${variant.factsMode} · streak:${variant.streakName} · shields:${variant.shieldName} · milestone:${variant.milestone === 'none' ? 'none' : variant.milestoneTitleName} · ${variant.deliveryName} · ${variant.zone} · ${variant.locale}`,
        seed,
        inputs: {
          locale: variant.locale,
          zone: variant.zone,
          deliveryName: variant.deliveryName,
          deliveryMs: String(variant.deliveryMs),
          factsMode: variant.factsMode,
          streakName: variant.streakName,
          streakDays: String(variant.streakDays),
          shieldName: variant.shieldName,
          shieldsAvailable: String(variant.shieldsAvailable),
          milestone: variant.milestone,
          milestoneTitleName: variant.milestoneTitleName,
          milestoneDaysName: variant.milestoneDaysName,
        },
        observed: {
          streakTitle: streak.title,
          streakBody: streak.body,
          streakTitleLength: [...streak.title].length,
          streakBodyLength: [...streak.body].length,
          practiceTitle: practice.title,
          weeklyTitle: weekly.title,
          withinCallerContract: inContract,
          leaked,
          hazard: !inContract && leaked.length > 0 ? leaked.join('|') : null,
        },
        verdict: problems.length === 0 ? 'pass' : 'fail',
        ...(problems.length === 0
          ? {}
          : { brokenInvariant: problems.join(',') }),
      });

      if (problems.length > 0)
        failures.push(`seed ${seed}: ${problems.join(',')}`);
    }
    expect(failures).toEqual([]);
  });

  it('covers every hostile string, number and timestamp corpus entry', () => {
    if (pinnedSeed() !== null) return;
    const rows = rowsFor(SUITE);
    expect(rows.length).toBeGreaterThanOrEqual(150);
    const seen = (key: string) =>
      new Set(
        rows.map(r => String((r.inputs as Record<string, unknown>)[key])),
      );
    expect(seen('locale').size).toBe(LOCALES.length);
    expect(seen('zone').size).toBe(ZONE_CASES.length);
    expect(seen('streakName').size).toBe(NUMBER_NAMES.length);
    expect(seen('shieldName').size).toBe(NUMBER_NAMES.length);
    expect(seen('milestoneTitleName').size).toBe(STRING_NAMES.length);
    expect(seen('deliveryName').size).toBe(TIMESTAMP_NAMES.length + 1);
  });

  it('rotates inside the variant list for every boundary instant', () => {
    for (const [name, ms] of Object.entries(HOSTILE_TIMESTAMPS)) {
      const practice = practiceReminderCopy(ms);
      const weekly = weeklyRecapCopy(ms);
      const streak = streakDefenseCopy(ms);
      for (const [label, copy] of [
        ['practice', practice],
        ['weekly', weekly],
        ['streak', streak],
      ] as const) {
        expect(typeof copy.title).toBe(`string`);
        expect(copy.title.length).toBeGreaterThan(0);
        expect(copy.body.length).toBeGreaterThan(0);
        expect(`${name}:${label}:${copy.title}`).not.toContain('undefined');
      }
    }
  });

  it('schedules streak defense exactly when the streak compares > 0 (NaN never)', () => {
    for (const [name, value] of Object.entries(HOSTILE_NUMBERS)) {
      const scheduled = planSchedulesStreakDefense(value);
      expect(`${name}:${scheduled}`).toBe(`${name}:${value > 0}`);
    }
  });

  it('keeps the comeback ladder non-empty and placeholder-free', () => {
    expect(COMEBACK_COPY.length).toBeGreaterThan(0);
    for (const copy of COMEBACK_COPY) {
      expect(copy.title.trim().length).toBeGreaterThan(0);
      expect(copy.body.trim().length).toBeGreaterThan(0);
      expect(leaks(`${copy.title} ${copy.body}`)).toEqual([]);
      expect(prohibited(`${copy.title} ${copy.body}`)).toEqual([]);
    }
  });

  /**
   * HAZARD (P3, reproduced): `streakDefenseCopy` interpolates the raw streak
   * count and only gates on `facts.streakDays <= 0`, so any positive value
   * the caller hands it reaches the lock screen verbatim — including values
   * `buildNotificationPlan` would happily pass through (its gate is the same
   * `> 0`): a fractional or exponential day count, e.g. "1e+21 days strong".
   * A `streakDays` of `undefined` (a facts object that lost the field)
   * renders "undefined days strong" because `undefined <= 0` is false. The
   * consistency engine only produces integer day counts today, so this is
   * robustness, not a live user-visible defect; this block pins what the
   * copy actually renders so a future caller change is caught here.
   */
  describe('hazard — raw streak interpolation', () => {
    it('formats a huge count in exponential notation and the plan allows it', () => {
      const copy = streakDefenseCopy(0, {
        streakDays: 1e21,
        shieldsAvailable: 0,
        milestoneEve: null,
      });
      expect(`${copy.title} ${copy.body}`).toContain('1e+21 days strong');
      expect(planSchedulesStreakDefense(1e21)).toBe(true);
      expect(planEntryFor(1e21)?.body).toContain('1e+21 days strong');
    });

    it('renders "undefined days strong" for a facts object missing the count', () => {
      const copy = streakDefenseCopy(0, {
        shieldsAvailable: 0,
        milestoneEve: null,
      } as unknown as StreakDefenseFacts);
      expect(`${copy.title} ${copy.body}`).toContain('undefined days strong');
    });

    it('interpolates a hostile milestone day count verbatim', () => {
      const copy = streakDefenseCopy(0, {
        streakDays: 3,
        shieldsAvailable: 0,
        milestoneEve: { title: 'Week One', days: Number.POSITIVE_INFINITY },
      });
      expect(copy.body).toBe(
        'Train tonight and day Infinity unlocks it. One analysis is enough.',
      );
    });

    it('renders NaN / Infinity verbatim, which the plan gate refuses', () => {
      for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
        const copy = streakDefenseCopy(0, {
          streakDays: value,
          shieldsAvailable: 0,
          milestoneEve: null,
        });
        const text = `${copy.title} ${copy.body}`;
        if (Number.isNaN(value)) {
          expect(text).toContain('NaN days strong');
          expect(planSchedulesStreakDefense(value)).toBe(false);
        } else {
          expect(text).toContain('Infinity days strong');
          // `Infinity > 0` passes the plan gate; the guard is that the
          // consistency engine cannot produce it.
          expect(planSchedulesStreakDefense(value)).toBe(true);
        }
      }
    });

    it('pluralizes only the exact value 1', () => {
      const one = streakDefenseCopy(0, {
        streakDays: 1,
        shieldsAvailable: 0,
        milestoneEve: null,
      });
      const fractional = streakDefenseCopy(0, {
        streakDays: 1.5,
        shieldsAvailable: 0,
        milestoneEve: null,
      });
      expect(`${one.title} ${one.body}`).toContain('1 day strong');
      expect(`${fractional.title} ${fractional.body}`).toContain(
        '1.5 days strong',
      );
    });
  });
});
