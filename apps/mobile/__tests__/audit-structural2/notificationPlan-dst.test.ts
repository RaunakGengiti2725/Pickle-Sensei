/**
 * AUDIT PROBE (structural #2, mobile-settings-account).
 *
 * plan.ts `atLocalMinutes` = local midnight + N minutes of ELAPSED time. On a
 * DST transition day the elapsed-time offset and the wall clock disagree by
 * an hour, so a 7:00 PM practice reminder is planned for 8:00 PM (spring
 * forward) or 6:00 PM (fall back) local time. The native rolling-repeat
 * expansion derives every later occurrence's calendar components from this
 * first timestamp (INFERRED from react-native-notify-kit NotifeeCore.m), so
 * a sync on that day carries the wrong hour forward until the next sync.
 *
 * Run with the process zone pinned (Node reads TZ at startup only):
 *   cd apps/mobile && TZ=America/New_York npx jest __tests__/audit-structural2/notificationPlan-dst.test.ts
 * A guard asserts the zone actually applies; it fails loudly otherwise.
 */
import { buildNotificationPlan } from '../../src/notifications/plan';
import { DEFAULT_NOTIFICATION_PREFS } from '../../src/notifications/types';

// The mobile tsconfig has no Node types (matches liveCourt.test.ts).
declare const process: { env: Record<string, string | undefined> };

function localHourMinute(ms: number): string {
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

describe('AUDIT: reminder wall-clock time on DST transition days', () => {
  function assertZoneApplied() {
    expect(process.env.TZ).toBe('America/New_York');
    // 2026-03-08 02:30 America/New_York does not exist (clocks jump 2→3).
    const probe = new Date(2026, 2, 8, 2, 30, 0);
    expect(probe.getTimezoneOffset()).not.toBe(0);
    // Offsets differ across the transition: -300 (EST) vs -240 (EDT).
    expect(new Date(2026, 2, 7, 12).getTimezoneOffset()).toBe(300);
    expect(new Date(2026, 2, 9, 12).getTimezoneOffset()).toBe(240);
  }

  it('spring forward (2026-03-08): the 7:00 PM practice reminder must be planned for 19:00 local', () => {
    assertZoneApplied();
    const nowMs = new Date(2026, 2, 8, 9, 0, 0).getTime(); // 9:00 AM local
    const plan = buildNotificationPlan(
      {
        ...DEFAULT_NOTIFICATION_PREFS,
        enabled: true,
        practiceReminder: true,
        practiceReminderMinutes: 19 * 60,
        streakDefense: true,
        weeklyRecap: false,
        comeback: false,
      },
      { nowMs, streakDays: 3, practicedToday: false, hasAnyHistory: true },
    );
    const practice = plan.find(p => p.id === 'ps.reminder.practice')!;
    const streak = plan.find(p => p.id === 'ps.reminder.streak')!;
    console.log(
      JSON.stringify({
        probe: 'notificationPlan-dst/spring-forward',
        practiceLocal: localHourMinute(practice.timestampMs),
        streakLocal: localHourMinute(streak.timestampMs),
      }),
    );
    expect(localHourMinute(practice.timestampMs)).toBe('19:00');
    expect(localHourMinute(streak.timestampMs)).toBe('19:30');
  });

  it('fall back (2026-11-01): the 7:00 PM practice reminder must be planned for 19:00 local', () => {
    assertZoneApplied();
    const nowMs = new Date(2026, 10, 1, 9, 0, 0).getTime();
    const plan = buildNotificationPlan(
      {
        ...DEFAULT_NOTIFICATION_PREFS,
        enabled: true,
        practiceReminder: true,
        practiceReminderMinutes: 19 * 60,
        streakDefense: false,
        weeklyRecap: true,
        comeback: false,
      },
      { nowMs, streakDays: 0, practicedToday: false, hasAnyHistory: true },
    );
    const practice = plan.find(p => p.id === 'ps.reminder.practice')!;
    const weekly = plan.find(p => p.id === 'ps.reminder.weekly')!;
    console.log(
      JSON.stringify({
        probe: 'notificationPlan-dst/fall-back',
        practiceLocal: localHourMinute(practice.timestampMs),
        weeklyLocal: localHourMinute(weekly.timestampMs),
        weeklyDay: new Date(weekly.timestampMs).getDay(),
      }),
    );
    expect(localHourMinute(practice.timestampMs)).toBe('19:00');
    // 2026-11-01 is a Sunday: the recap is due today at 18:00 local.
    expect(localHourMinute(weekly.timestampMs)).toBe('18:00');
  });

  it('non-transition day (control): 19:00 local as expected', () => {
    assertZoneApplied();
    const nowMs = new Date(2026, 2, 9, 9, 0, 0).getTime();
    const plan = buildNotificationPlan(
      {
        ...DEFAULT_NOTIFICATION_PREFS,
        enabled: true,
        practiceReminder: true,
        practiceReminderMinutes: 19 * 60,
      },
      { nowMs, streakDays: 0, practicedToday: false, hasAnyHistory: false },
    );
    const practice = plan.find(p => p.id === 'ps.reminder.practice')!;
    expect(localHourMinute(practice.timestampMs)).toBe('19:00');
  });
});
