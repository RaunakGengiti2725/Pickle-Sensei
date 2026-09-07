/**
 * Adversarial matrix for notifications/plan.ts (candidate 04058fd1, cluster
 * xc-ux-a11y-i18n::XC-UAI-02): every reminder must land on the configured
 * wall-clock time on EVERY day of 2025–2027 for EVERY 15-minute reminder
 * slot the settings UI can produce — including DST transition days, zones
 * whose transitions happen at midnight (America/Santiago, America/Havana,
 * America/Asuncion), 30-minute DST shifts (Australia/Lord_Howe), :45 offsets
 * (Pacific/Chatham, Asia/Kathmandu) and the UTC±12..14 extremes.
 *
 * Jest inherits the process zone, so run once per zone, e.g.
 *   cd apps/mobile && for tz in Europe/Berlin America/Los_Angeles America/Santiago \
 *     America/Havana America/Asuncion Australia/Lord_Howe Pacific/Chatham \
 *     Asia/Kathmandu Pacific/Auckland Pacific/Kiritimati Pacific/Pago_Pago UTC; do \
 *     TZ=$tz npx jest --ci __tests__/xc/attack/notificationPlanZoneMatrix.test.ts || exit 1; done
 *
 * A wall-clock slot that does not exist on a day (spring-forward gap) is
 * skipped — no engine can honour it; the assertion is only that the planner
 * never drifts on a slot that DOES exist.
 */
import { buildNotificationPlan } from '../../../src/notifications/plan';
import { DEFAULT_NOTIFICATION_PREFS } from '../../../src/notifications/types';

declare const process: { env: Record<string, string | undefined> };
const ZONE =
  process.env['TZ'] ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

const MIN_LEAD_MS = 90_000;

function exists(
  y: number,
  m: number,
  d: number,
  h: number,
  min: number,
): boolean {
  const t = new Date(y, m, d, h, min, 0, 0);
  return (
    t.getFullYear() === y &&
    t.getMonth() === m &&
    t.getDate() === d &&
    t.getHours() === h &&
    t.getMinutes() === min
  );
}

function wall(ms: number): string {
  const t = new Date(ms);
  return `${t.getFullYear()}-${t.getMonth() + 1}-${t.getDate()} ${String(
    t.getHours(),
  ).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
}

function eachDay(cb: (y: number, m: number, d: number) => void): void {
  for (let y = 2025; y <= 2027; y += 1) {
    for (let m = 0; m < 12; m += 1) {
      for (let d = 1; d <= 31; d += 1) {
        if (new Date(y, m, d, 12).getMonth() !== m) continue;
        cb(y, m, d);
      }
    }
  }
}

describe(`attack: reminder wall-clock matrix in TZ=${ZONE}`, () => {
  it('practice reminder (every 15-min slot) lands on the configured wall-clock today or tomorrow', () => {
    const failures: string[] = [];
    let checked = 0;
    // 00:05 local: every slot from 00:15 on is "today", 00:00 is "tomorrow";
    // 23:50 local: every slot is "tomorrow" (crosses into a 23h/25h day).
    const NOW_CLOCKS: ReadonlyArray<readonly [number, number]> = [
      [0, 5],
      [23, 50],
    ];
    eachDay((y, m, d) => {
      for (const [nowH, nowMin] of NOW_CLOCKS) {
        const nowMs = new Date(y, m, d, nowH, nowMin, 0, 0).getTime();
        if (Number.isNaN(nowMs)) continue;
        for (let minutes = 0; minutes < 24 * 60; minutes += 15) {
          const h = Math.floor(minutes / 60);
          const min = minutes % 60;
          const [plan] = buildNotificationPlan(
            {
              ...DEFAULT_NOTIFICATION_PREFS,
              enabled: true,
              practiceReminder: true,
              practiceReminderMinutes: minutes,
              streakDefense: false,
              weeklyRecap: false,
              comeback: false,
            },
            {
              nowMs,
              streakDays: 0,
              practicedToday: false,
              hasAnyHistory: true,
            },
          );
          // Spring-forward gap: the configured wall-clock never happens today.
          // Both "fire at the shifted hour" and "fire tomorrow" are defensible,
          // so only the existing-slot behaviour is asserted.
          if (!exists(y, m, d, h, min)) continue;
          const todayMs = new Date(y, m, d, h, min, 0, 0).getTime();
          const expectToday = todayMs >= nowMs + MIN_LEAD_MS;
          const target = expectToday
            ? { y, m, d }
            : (() => {
                const t = new Date(y, m, d + 1, 12);
                return { y: t.getFullYear(), m: t.getMonth(), d: t.getDate() };
              })();
          if (!exists(target.y, target.m, target.d, h, min)) continue;
          checked += 1;
          const expected = new Date(
            target.y,
            target.m,
            target.d,
            h,
            min,
            0,
            0,
          ).getTime();
          if (plan?.timestampMs !== expected) {
            failures.push(
              `now ${wall(nowMs)} slot ${h}:${String(min).padStart(2, '0')} → ${
                plan ? wall(plan.timestampMs) : 'none'
              } expected ${wall(expected)}`,
            );
          }
        }
      }
    });
    expect(checked).toBeGreaterThan(200_000);
    expect(failures.slice(0, 10)).toEqual([]);
  });

  it('streak defense / weekly recap / comeback rungs keep 19:30 / Sun 18:00 / 18:30 on every day', () => {
    const failures: string[] = [];
    eachDay((y, m, d) => {
      const morning = new Date(y, m, d, 9, 0, 0, 0).getTime();
      for (const practicedToday of [false, true]) {
        const plan = buildNotificationPlan(
          { ...DEFAULT_NOTIFICATION_PREFS, enabled: true },
          {
            nowMs: morning,
            streakDays: 5,
            practicedToday,
            hasAnyHistory: true,
          },
        );
        const byId = new Map(plan.map(p => [p.id, p.timestampMs]));
        const streak = new Date(byId.get('ps.reminder.streak')!);
        const streakDay = practicedToday
          ? new Date(y, m, d + 1, 12).getDate()
          : d;
        if (
          streak.getHours() !== 19 ||
          streak.getMinutes() !== 30 ||
          streak.getDate() !== streakDay
        ) {
          failures.push(
            `${y}-${m + 1}-${d} practicedToday=${practicedToday} streak → ${wall(
              streak.getTime(),
            )}`,
          );
        }
        const weekly = new Date(byId.get('ps.reminder.weekly')!);
        if (
          weekly.getDay() !== 0 ||
          weekly.getHours() !== 18 ||
          weekly.getMinutes() !== 0 ||
          weekly.getTime() < morning + MIN_LEAD_MS ||
          weekly.getTime() > morning + 8 * 86_400_000
        ) {
          failures.push(
            `${y}-${m + 1}-${d} weekly → ${wall(weekly.getTime())}`,
          );
        }
        [3, 7, 14].forEach((days, index) => {
          const rung = new Date(byId.get(`ps.comeback.${index + 1}` as never)!);
          const expected = new Date(y, m, d + days, 12);
          if (
            rung.getHours() !== 18 ||
            rung.getMinutes() !== 30 ||
            rung.getDate() !== expected.getDate() ||
            rung.getMonth() !== expected.getMonth()
          ) {
            failures.push(
              `${y}-${m + 1}-${d} comeback.${index + 1} → ${wall(
                rung.getTime(),
              )}`,
            );
          }
        });
      }
    });
    expect(failures.slice(0, 10)).toEqual([]);
  });

  it('a sync inside the repeated fall-back hour still schedules strictly in the future', () => {
    const failures: string[] = [];
    eachDay((y, m, d) => {
      // Probe each quarter hour of the day for a 25h day (offset changes).
      const start = new Date(y, m, d, 0, 0, 0, 0);
      const end = new Date(y, m, d + 1, 0, 0, 0, 0);
      if (end.getTime() - start.getTime() === 86_400_000) return;
      for (let t = start.getTime(); t < end.getTime(); t += 15 * 60_000) {
        const plan = buildNotificationPlan(
          { ...DEFAULT_NOTIFICATION_PREFS, enabled: true },
          {
            nowMs: t,
            streakDays: 2,
            practicedToday: false,
            hasAnyHistory: true,
          },
        );
        for (const item of plan) {
          if (item.timestampMs < t + MIN_LEAD_MS) {
            failures.push(
              `${wall(t)} → ${item.id} at ${wall(item.timestampMs)} is not ahead`,
            );
          }
        }
      }
    });
    expect(failures.slice(0, 10)).toEqual([]);
  });
});
