/**
 * Adjudication reproductions for area xc-ux-a11y-i18n (locale/time zone).
 *
 * Jest sandboxes `process.env`, so the zone cannot be switched in-process:
 * each block runs only when the process was started under that TZ, e.g.
 *   cd apps/mobile && TZ=Pacific/Auckland npx jest --ci __tests__/adjudicateXcUxA11yI18nLocale.test.ts
 *   cd apps/mobile && TZ=Europe/Berlin npx jest --ci __tests__/adjudicateXcUxA11yI18nLocale.test.ts
 *   cd apps/mobile && TZ=America/Los_Angeles npx jest --ci __tests__/adjudicateXcUxA11yI18nLocale.test.ts
 *
 * `expected` blocks assert the EXPECTED behaviour (`test.failing` while the
 * defect is present — a fix flips them to plain `test`); `reproduction`
 * blocks pin the defective output observed on 4d812e1a.
 */
import { buildNotificationPlan } from '../src/notifications/plan';
import { DEFAULT_NOTIFICATION_PREFS } from '../src/notifications/types';

declare const process: { env: Record<string, string | undefined> };
const TZ = process.env.TZ ?? '';
const inZone = (...zones: string[]) => (zones.includes(TZ) ? test : test.skip);

/** Mirrors StreakCalendarScreen.tsx selected-day title and
 * AchievementsShowcase.tsx formatEarnedDay: `${day}T12:00:00Z` anchor. */
function productionDayTitle(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

describe('A1 — calendar day labels anchored at 12:00Z roll to the next day at UTC+12 and beyond', () => {
  const east = ['Pacific/Auckland', 'Pacific/Fiji', 'Pacific/Kiritimati'];

  inZone(...east).failing(
    'expected: selected day 2026-09-04 renders as September 4',
    () => {
      expect(productionDayTitle('2026-09-04')).toBe('Friday, September 4');
    },
  );

  inZone(...east)('reproduction: the 12:00Z anchor renders September 5', () => {
    expect(productionDayTitle('2026-09-04')).toBe('Saturday, September 5');
  });

  test('control: ProgressScreen local-noon anchor names the selected day in the current zone', () => {
    expect(
      new Date('2026-09-04T12:00:00').toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      }),
    ).toBe('Sep 4');
  });
});

function localWallClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
}

function planOn(localDay: string) {
  const nowMs = new Date(`${localDay}T09:00:00`).getTime();
  const plan = buildNotificationPlan(
    { ...DEFAULT_NOTIFICATION_PREFS, enabled: true },
    { nowMs, streakDays: 3, practicedToday: false, hasAnyHistory: true },
  );
  return Object.fromEntries(
    plan.map(p => [p.id, localWallClock(p.timestampMs)]),
  );
}

describe('A2 — notifications/plan.ts anchors on local midnight + minutes, drifting on DST transition days', () => {
  inZone('Europe/Berlin').failing(
    'expected: 2026-03-29 (spring forward) keeps 17:30 / 19:30',
    () => {
      const times = planOn('2026-03-29');
      expect(times['ps.reminder.practice']).toBe('17:30');
      expect(times['ps.reminder.streak']).toBe('19:30');
    },
  );

  inZone('Europe/Berlin')(
    'reproduction: 2026-03-29 plans 18:30 / 20:30',
    () => {
      const times = planOn('2026-03-29');
      expect(times['ps.reminder.practice']).toBe('18:30');
      expect(times['ps.reminder.streak']).toBe('20:30');
    },
  );

  inZone('America/Los_Angeles').failing(
    'expected: 2026-11-01 (fall back) keeps 17:30 / 19:30',
    () => {
      const times = planOn('2026-11-01');
      expect(times['ps.reminder.practice']).toBe('17:30');
      expect(times['ps.reminder.streak']).toBe('19:30');
    },
  );

  inZone('America/Los_Angeles')(
    'reproduction: 2026-11-01 plans 16:30 / 18:30',
    () => {
      const times = planOn('2026-11-01');
      expect(times['ps.reminder.practice']).toBe('16:30');
      expect(times['ps.reminder.streak']).toBe('18:30');
    },
  );

  test('control: a non-transition day is exact in the current zone', () => {
    for (const day of ['2026-03-28', '2026-10-31', '2026-07-15']) {
      const times = planOn(day);
      expect(times['ps.reminder.practice']).toBe('17:30');
      expect(times['ps.reminder.streak']).toBe('19:30');
    }
  });
});
