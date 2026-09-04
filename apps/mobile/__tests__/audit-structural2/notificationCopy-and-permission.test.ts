/**
 * AUDIT PROBE (structural #2, mobile-settings-account) — copy rotation and
 * permission mapping.
 *
 * 1. copy.ts picks a variant by UTC epoch-day of the DELIVERY timestamp. The
 *    concern was repeat/skip near local midnight west of UTC. Delivery
 *    timestamps for consecutive local days are exactly 24h apart on plain
 *    days, so the UTC day index advances by one per day regardless of zone.
 *    Only a DST day (23h apart) can collapse two deliveries onto one UTC day,
 *    and only when the local delivery time sits within an hour after UTC
 *    midnight (e.g. 4:30 PM Pacific = 00:30 UTC).
 * 2. service.ts maps every authorizationStatus other than -1/0 to granted.
 *    react-native-notify-kit's enum has exactly four members
 *    (NOT_DETERMINED -1, DENIED 0, AUTHORIZED 1, PROVISIONAL 2); PROVISIONAL
 *    delivers quietly and is documented as deliverable.
 *
 * Timestamps are built with Date.UTC + an explicit Pacific offset so the
 * probe is independent of the host zone.
 *
 * Run: cd apps/mobile && npx jest __tests__/audit-structural2/notificationCopy-and-permission.test.ts
 */
// The package root touches the native module at import; the enum module is
// plain JS.
const { AuthorizationStatus } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('react-native-notify-kit/dist/types/Notification') as {
    AuthorizationStatus: Record<string, number | string>;
  };
import {
  practiceReminderCopy,
  weeklyRecapCopy,
} from '../../src/notifications/copy';

const PDT_OFFSET_H = 7;
const PST_OFFSET_H = 8;

/** Local Pacific wall-clock → epoch ms, given the offset in force that day. */
function pacific(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
  offsetHours: number,
): number {
  return Date.UTC(year, monthIndex, day, hour + offsetHours, minute, 0, 0);
}

describe('AUDIT: copy variant rotation across local days (Pacific, west of UTC)', () => {
  it('a 7:00 PM local delivery on consecutive plain days never repeats a variant back-to-back', () => {
    const seen: string[] = [];
    for (let day = 1; day <= 10; day += 1) {
      seen.push(
        practiceReminderCopy(pacific(2026, 7, day, 19, 0, PDT_OFFSET_H)).title,
      );
    }
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]).not.toBe(seen[i - 1]);
    }
  });

  it('a 5:30 PM local delivery (already past UTC midnight) also advances once per day', () => {
    const seen: string[] = [];
    for (let day = 1; day <= 10; day += 1) {
      seen.push(
        practiceReminderCopy(pacific(2026, 7, day, 17, 30, PDT_OFFSET_H)).title,
      );
    }
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]).not.toBe(seen[i - 1]);
    }
    const sunday = pacific(2026, 7, 2, 18, 0, PDT_OFFSET_H);
    expect(weeklyRecapCopy(sunday).title).toBe(weeklyRecapCopy(sunday).title);
  });

  it('a 4:30 PM local delivery across the 2026-03-08 spring-forward day does not repeat', () => {
    // Sat 2026-03-07 16:30 PST = 00:30 UTC Mar 8; Sun 2026-03-08 16:30 PDT =
    // 23:30 UTC Mar 8 — both on UTC day Mar 8.
    const saturday = practiceReminderCopy(
      pacific(2026, 2, 7, 16, 30, PST_OFFSET_H),
    ).title;
    const sunday = practiceReminderCopy(
      pacific(2026, 2, 8, 16, 30, PDT_OFFSET_H),
    ).title;
    console.log(
      JSON.stringify({
        probe: 'notificationCopy/spring-forward-4-30pm',
        saturday,
        sunday,
      }),
    );
    expect(sunday).not.toBe(saturday);
  });
});

describe('AUDIT: permission status enum coverage', () => {
  it('the vendored enum has exactly the four documented members', () => {
    const numeric = Object.values(AuthorizationStatus).filter(
      (v): v is number => typeof v === 'number',
    );
    expect(numeric.sort((a, b) => a - b)).toEqual([-1, 0, 1, 2]);
    expect(AuthorizationStatus['PROVISIONAL']).toBe(2);
  });
});
