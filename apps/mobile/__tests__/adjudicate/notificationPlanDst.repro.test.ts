/**
 * Adjudication reproduction (mobile-settings-account, base 4d812e1a).
 *
 * Candidate N4: plan.ts `atLocalMinutes()` adds `minutes * 60_000` to local
 * midnight, i.e. ELAPSED time rather than wall-clock time, so on a DST
 * transition day the reminder lands one hour off the time the user picked.
 *
 * Run with: TZ=America/Los_Angeles npx jest __tests__/adjudicate/notificationPlanDst
 */
import { buildNotificationPlan } from '../../src/notifications/plan';
import { DEFAULT_NOTIFICATION_PREFS } from '../../src/notifications/types';

const inLosAngeles = Intl.DateTimeFormat().resolvedOptions().timeZone;

describe('N4 — reminder wall-clock time on DST transition days', () => {
  it('precondition: process runs in America/Los_Angeles', () => {
    expect(inLosAngeles).toBe('America/Los_Angeles');
    // 2026-03-08 is a 23h local day; 2026-11-01 is a 25h local day.
    expect(
      (new Date(2026, 2, 9).getTime() - new Date(2026, 2, 8).getTime()) / 3.6e6,
    ).toBe(23);
    expect(
      (new Date(2026, 10, 2).getTime() - new Date(2026, 10, 1).getTime()) /
        3.6e6,
    ).toBe(25);
  });

  function practiceHour(nowLocal: Date, minutes: number): number {
    const plan = buildNotificationPlan(
      {
        ...DEFAULT_NOTIFICATION_PREFS,
        enabled: true,
        practiceReminderMinutes: minutes,
        streakDefense: false,
        weeklyRecap: false,
        comeback: false,
      },
      {
        nowMs: nowLocal.getTime(),
        streakDays: 0,
        practicedToday: false,
        hasAnyHistory: true,
      },
    );
    const practice = plan.find(n => n.id === 'ps.reminder.practice');
    expect(practice).toBeDefined();
    const fireAt = new Date(practice!.timestampMs);
    expect(fireAt.getDate()).toBe(nowLocal.getDate());
    return fireAt.getHours() * 60 + fireAt.getMinutes();
  }

  it('spring forward (2026-03-08): a 7:00 PM reminder is planned for 19:00 local', () => {
    expect(practiceHour(new Date(2026, 2, 8, 10, 0, 0), 19 * 60)).toBe(19 * 60);
  });

  it('fall back (2026-11-01): a 7:00 PM reminder is planned for 19:00 local', () => {
    expect(practiceHour(new Date(2026, 10, 1, 10, 0, 0), 19 * 60)).toBe(
      19 * 60,
    );
  });

  it('control — an ordinary day plans 19:00 local', () => {
    expect(practiceHour(new Date(2026, 7, 25, 10, 0, 0), 19 * 60)).toBe(
      19 * 60,
    );
  });

  it('sweep — every day of 2026 at 10:00 local plans the 17:30 reminder at 17:30', () => {
    const offDays: string[] = [];
    for (
      let d = new Date(2026, 0, 1);
      d.getFullYear() === 2026;
      d.setDate(d.getDate() + 1)
    ) {
      const now = new Date(
        d.getFullYear(),
        d.getMonth(),
        d.getDate(),
        10,
        0,
        0,
      );
      const got = practiceHour(now, 17 * 60 + 30);
      if (got !== 17 * 60 + 30) offDays.push(`${now.toDateString()} → ${got}`);
    }
    expect(offDays).toEqual([]);
  });
});
