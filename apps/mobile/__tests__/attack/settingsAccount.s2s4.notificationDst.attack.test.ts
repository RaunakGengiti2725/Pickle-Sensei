import { buildNotificationPlan } from '../../src/notifications/plan';
import type { NotificationPlanContext } from '../../src/notifications/plan';
import {
  DEFAULT_NOTIFICATION_PREFS,
  type NotificationPrefs,
} from '../../src/notifications/types';

declare const process: { env: Record<string, string | undefined> };

/**
 * ADVERSARIAL PASS 3 — mobile-settings-account, scenarios S2 + S4.
 *
 * The reminder planner promises "All math is LOCAL time — reminders belong
 * to the player's clock" (plan.ts). `atLocalMinutes` computes
 * `localMidnight + minutes * 60_000`, i.e. it adds ELAPSED milliseconds to
 * midnight. On a day whose local clock jumps (US DST: 23h on spring-forward,
 * 25h on fall-back) that is not "17:30 on the player's clock".
 *
 * This suite must run in a DST-observing zone. Jest's `process.env` copy
 * does not reach V8's timezone cache, so set TZ on the PROCESS:
 *
 *   cd apps/mobile && TZ=America/Los_Angeles npx jest \
 *     __tests__/attack/settingsAccount.s2s4.notificationDst.attack.test.ts
 *
 * Under any other TZ the DST cases are reported as SKIPPED (never as passed).
 * Assertions state the EXPECTED behaviour (17:30 / 18:00 local); a failure
 * is the reproduction.
 */

const janOffset = new Date(2026, 0, 15, 12).getTimezoneOffset();
const julOffset = new Date(2026, 6, 15, 12).getTimezoneOffset();
const inLosAngeles = janOffset === 480 && julOffset === 420;
const describeLA = inLosAngeles ? describe : describe.skip;

const allOn: NotificationPrefs = {
  ...DEFAULT_NOTIFICATION_PREFS,
  enabled: true,
  practiceReminderMinutes: 17 * 60 + 30,
};

function context(
  overrides: Partial<NotificationPlanContext> = {},
): NotificationPlanContext {
  return {
    nowMs: 0,
    streakDays: 0,
    practicedToday: false,
    hasAnyHistory: true,
    ...overrides,
  };
}

function local(timestampMs: number) {
  const d = new Date(timestampMs);
  return {
    y: d.getFullYear(),
    m: d.getMonth() + 1,
    d: d.getDate(),
    weekday: d.getDay(),
    hh: d.getHours(),
    mm: d.getMinutes(),
    iso: d.toString(),
  };
}

function find(plan: ReturnType<typeof buildNotificationPlan>, id: string) {
  const item = plan.find(entry => entry.id === id);
  if (!item) throw new Error(`plan is missing ${id}`);
  return item;
}

// US DST 2026: spring forward Sun 2026-03-08 02:00 → 03:00 PST→PDT,
//              fall back    Sun 2026-11-01 02:00 → 01:00 PDT→PST.
const SPRING_FORWARD = { y: 2026, m: 3, d: 8 };
const FALL_BACK = { y: 2026, m: 11, d: 1 };

describeLA(
  'S2 — practice reminder on the US spring-forward day (TZ=America/Los_Angeles)',
  () => {
    it('precondition: the process really is in America/Los_Angeles with a 23h March 8', () => {
      expect(inLosAngeles).toBe(true);
      const midnight = new Date(2026, 2, 8, 0, 0, 0).getTime();
      const nextMidnight = new Date(2026, 2, 9, 0, 0, 0).getTime();
      expect((nextMidnight - midnight) / 3_600_000).toBe(23);
    });

    it('nowMs = 10:00 on Mar 8 2026 → trigger is 17:30 LOCAL the same day', () => {
      const now = new Date(2026, 2, 8, 10, 0, 0).getTime();
      const plan = buildNotificationPlan(allOn, context({ nowMs: now }));
      const at = local(find(plan, 'ps.reminder.practice').timestampMs);
      expect({ d: at.d, hh: at.hh, mm: at.mm }).toEqual({
        d: SPRING_FORWARD.d,
        hh: 17,
        mm: 30,
      });
    });

    it('nowMs = 18:00 on the eve (Mar 7) rolls to Mar 8 at 17:30 LOCAL', () => {
      const now = new Date(2026, 2, 7, 18, 0, 0).getTime();
      const plan = buildNotificationPlan(allOn, context({ nowMs: now }));
      const at = local(find(plan, 'ps.reminder.practice').timestampMs);
      expect({ d: at.d, hh: at.hh, mm: at.mm }).toEqual({
        d: SPRING_FORWARD.d,
        hh: 17,
        mm: 30,
      });
    });

    it('a 01:30 reminder requested on Mar 8 (a wall-clock minute that exists) stays 01:30 → rolls to Mar 9 01:30', () => {
      // 01:30 exists on Mar 8 (the skipped hour is 02:00–02:59); at 10:00 it is
      // already past so the planner should land on Mar 9 01:30 local.
      const now = new Date(2026, 2, 8, 10, 0, 0).getTime();
      const plan = buildNotificationPlan(
        { ...allOn, practiceReminderMinutes: 90 },
        context({ nowMs: now }),
      );
      const at = local(find(plan, 'ps.reminder.practice').timestampMs);
      expect({ d: at.d, hh: at.hh, mm: at.mm }).toEqual({
        d: 9,
        hh: 1,
        mm: 30,
      });
    });

    it('streak defense on Mar 8 lands at 19:30 LOCAL', () => {
      const now = new Date(2026, 2, 8, 10, 0, 0).getTime();
      const plan = buildNotificationPlan(
        allOn,
        context({ nowMs: now, streakDays: 4, practicedToday: false }),
      );
      const at = local(find(plan, 'ps.reminder.streak').timestampMs);
      expect({ d: at.d, hh: at.hh, mm: at.mm }).toEqual({
        d: SPRING_FORWARD.d,
        hh: 19,
        mm: 30,
      });
    });

    it('comeback rungs armed on Mar 6 cross the DST boundary and still land at 18:30 LOCAL', () => {
      const now = new Date(2026, 2, 6, 10, 0, 0).getTime();
      const plan = buildNotificationPlan(allOn, context({ nowMs: now }));
      const rungs = plan
        .filter(item => item.id.startsWith('ps.comeback.'))
        .map(item => local(item.timestampMs));
      expect(rungs.map(r => [r.d, r.hh, r.mm])).toEqual([
        [9, 18, 30],
        [13, 18, 30],
        [20, 18, 30],
      ]);
    });
  },
);

describeLA(
  'S4 — fall-back day and the DST-changing Sundays (TZ=America/Los_Angeles)',
  () => {
    it('precondition: Nov 1 2026 is a 25h local day', () => {
      const midnight = new Date(2026, 10, 1, 0, 0, 0).getTime();
      const nextMidnight = new Date(2026, 10, 2, 0, 0, 0).getTime();
      expect((nextMidnight - midnight) / 3_600_000).toBe(25);
    });

    it('nowMs = 10:00 on Nov 1 2026 → practice trigger is 17:30 LOCAL the same day', () => {
      const now = new Date(2026, 10, 1, 10, 0, 0).getTime();
      const plan = buildNotificationPlan(allOn, context({ nowMs: now }));
      const at = local(find(plan, 'ps.reminder.practice').timestampMs);
      expect({ d: at.d, hh: at.hh, mm: at.mm }).toEqual({
        d: FALL_BACK.d,
        hh: 17,
        mm: 30,
      });
    });

    it('weekly recap planned on Tue Mar 3 lands on the DST-changing Sunday Mar 8 at 18:00 LOCAL', () => {
      const now = new Date(2026, 2, 3, 10, 0, 0).getTime();
      const plan = buildNotificationPlan(allOn, context({ nowMs: now }));
      const at = local(find(plan, 'ps.reminder.weekly').timestampMs);
      expect({ weekday: at.weekday, d: at.d, hh: at.hh, mm: at.mm }).toEqual({
        weekday: 0,
        d: SPRING_FORWARD.d,
        hh: 18,
        mm: 0,
      });
    });

    it('weekly recap planned on Tue Oct 27 lands on the DST-changing Sunday Nov 1 at 18:00 LOCAL', () => {
      const now = new Date(2026, 9, 27, 10, 0, 0).getTime();
      const plan = buildNotificationPlan(allOn, context({ nowMs: now }));
      const at = local(find(plan, 'ps.reminder.weekly').timestampMs);
      expect({ weekday: at.weekday, d: at.d, hh: at.hh, mm: at.mm }).toEqual({
        weekday: 0,
        d: FALL_BACK.d,
        hh: 18,
        mm: 0,
      });
    });

    it('weekly recap planned ON the DST Sunday morning still fires that evening at 18:00 LOCAL', () => {
      const now = new Date(2026, 10, 1, 9, 0, 0).getTime();
      const plan = buildNotificationPlan(allOn, context({ nowMs: now }));
      const at = local(find(plan, 'ps.reminder.weekly').timestampMs);
      expect({ d: at.d, hh: at.hh, mm: at.mm }).toEqual({
        d: FALL_BACK.d,
        hh: 18,
        mm: 0,
      });
    });
  },
);

describeLA(
  'S2/S4 sweep — every day of 2026 at 10:00 local must plan the 17:30 reminder at 17:30',
  () => {
    it('lists the days whose local trigger time is not 17:30 (expected: none)', () => {
      const offenders: string[] = [];
      for (let day = new Date(2026, 0, 1, 10); day.getFullYear() === 2026;) {
        const plan = buildNotificationPlan(
          allOn,
          context({ nowMs: day.getTime() }),
        );
        const at = local(find(plan, 'ps.reminder.practice').timestampMs);
        if (at.hh !== 17 || at.mm !== 30) {
          offenders.push(
            `${at.y}-${String(at.m).padStart(2, '0')}-${String(at.d).padStart(2, '0')} → ${at.hh}:${String(at.mm).padStart(2, '0')} (${at.iso})`,
          );
        }
        day = new Date(
          day.getFullYear(),
          day.getMonth(),
          day.getDate() + 1,
          10,
        );
      }
      expect(offenders).toEqual([]);
    });
  },
);

describe('S2/S4 guard — this file only proves something under TZ=America/Los_Angeles', () => {
  it('reports the timezone the suite actually ran in', () => {
    // A UTC run has no DST and cannot exercise the defect; the describe
    // blocks above are then SKIPPED, not passed. This test exists so the
    // run log always shows which zone produced the result.
    expect(typeof janOffset).toBe('number');
    console.info(
      `[attack s2s4] TZ=${process.env.TZ ?? '(unset)'} janOffset=${janOffset} julOffset=${julOffset} dstCasesRan=${inLosAngeles}`,
    );
  });
});
