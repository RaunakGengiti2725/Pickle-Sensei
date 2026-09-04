/**
 * xc journey-progress-streaks — notification planner wall-clock honesty in
 * the PROCESS time zone across every 2026 DST transition of that zone (and on
 * fixed reference days for zones without DST). Run per zone through
 *   node scripts/xc-journey-progress-streaks/run-tz-processes.mjs
 *
 * Contract: a reminder configured for HH:MM local must be planned at HH:MM
 * local on the intended calendar day — on a DST day exactly as on any other.
 * Artifact: artifacts/xc-journey-progress-streaks/notification-dst.<zone>.json
 */
import { buildNotificationPlan } from '../../src/notifications/plan';
import {
  DEFAULT_NOTIFICATION_PREFS,
  type NotificationPrefs,
} from '../../src/notifications/types';
import {
  nodeEnv,
  nodeVersion,
  addDaysToKey,
  dayDiff,
  localDayOf,
  processZone,
  transitionsIn,
  writeArtifact,
} from '../../scripts/xc-journey-progress-streaks/oracle';

const ZONE = processZone();
const allOn: NotificationPrefs = {
  ...DEFAULT_NOTIFICATION_PREFS,
  enabled: true,
};

function localWall(ms: number): { day: string; hh: number; mm: number } {
  const d = new Date(ms);
  return { day: localDayOf(ms, ZONE), hh: d.getHours(), mm: d.getMinutes() };
}

/** Local wall clock → instant using the runtime's own zone (the planner's
 * model), for building `nowMs`. Never used for the expectations. */
function localInstant(day: string, hh: number, mm = 0): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
}

interface Probe {
  scenario: string;
  nowLocal: string;
  id: string;
  expectedDay: string;
  expectedHHMM: string;
  observedDay: string;
  observedHHMM: string;
  observedIso: string;
  ok: boolean;
}

const probes: Probe[] = [];
const hhmm = (hh: number, mm: number) =>
  `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;

function check(
  scenario: string,
  nowMs: number,
  id: string,
  timestampMs: number | undefined,
  expectedDay: string,
  expectedMinutes: number,
): Probe {
  const now = localWall(nowMs);
  const observed = timestampMs === undefined ? null : localWall(timestampMs);
  const probe: Probe = {
    scenario,
    nowLocal: `${now.day} ${hhmm(now.hh, now.mm)} ${ZONE}`,
    id,
    expectedDay,
    expectedHHMM: hhmm(Math.floor(expectedMinutes / 60), expectedMinutes % 60),
    observedDay: observed?.day ?? '(not planned)',
    observedHHMM: observed ? hhmm(observed.hh, observed.mm) : '(not planned)',
    observedIso:
      timestampMs === undefined ? '' : new Date(timestampMs).toISOString(),
    ok: false,
  };
  probe.ok =
    probe.observedDay === expectedDay &&
    probe.observedHHMM === probe.expectedHHMM;
  probes.push(probe);
  return probe;
}

afterAll(() => {
  writeArtifact(
    `notification-dst.${(nodeEnv.TZ ?? ZONE).replace(/\//g, '_')}.json`,
    {
      zone: ZONE,
      node: nodeVersion,
      transitions: transitionsIn(ZONE, 2026).map(t =>
        new Date(t).toISOString(),
      ),
      probes,
      failures: probes.filter(p => !p.ok),
    },
  );
});

/** Days to exercise: each 2026 transition day of the zone (and its eve), or
 * two ordinary days when the zone has no transitions. */
function focusDays(): Array<{ label: string; day: string }> {
  const transitions = transitionsIn(ZONE, 2026);
  if (transitions.length === 0) {
    return [
      { label: 'ordinary-spring', day: '2026-03-08' },
      { label: 'ordinary-autumn', day: '2026-11-01' },
    ];
  }
  return transitions.map(t => ({
    label: `transition@${new Date(t).toISOString()}`,
    day: localDayOf(t, ZONE),
  }));
}

describe(`xc journey-progress-streaks: notification plan wall clock in TZ=${ZONE}`, () => {
  it.each(focusDays())(
    'plans every reminder at its configured local time around $label ($day)',
    ({ label, day }) => {
      const eve = addDaysToKey(day, -1);
      const failures: Probe[] = [];
      const record = (p: Probe) => {
        if (!p.ok) failures.push(p);
      };

      // (1) Morning of the shift day, streak alive, nothing captured yet:
      //     streak defense TODAY 19:30, weekly recap on the next Sunday 18:00,
      //     daily practice reminder today at 17:30 (default).
      {
        const nowMs = localInstant(day, 9, 0);
        const plan = buildNotificationPlan(allOn, {
          nowMs,
          streakDays: 4,
          practicedToday: false,
          hasAnyHistory: true,
        });
        const by = new Map(plan.map(item => [item.id, item.timestampMs]));
        record(
          check(
            `${label} morning`,
            nowMs,
            'ps.reminder.streak',
            by.get('ps.reminder.streak'),
            day,
            19 * 60 + 30,
          ),
        );
        record(
          check(
            `${label} morning`,
            nowMs,
            'ps.reminder.practice',
            by.get('ps.reminder.practice'),
            day,
            17 * 60 + 30,
          ),
        );
        const weekdayOfDay = new Date(`${day}T12:00:00Z`).getUTCDay();
        const sunday = addDaysToKey(day, (7 - weekdayOfDay) % 7);
        record(
          check(
            `${label} morning`,
            nowMs,
            'ps.reminder.weekly',
            by.get('ps.reminder.weekly'),
            sunday,
            18 * 60,
          ),
        );
        for (const [index, days] of [3, 7, 14].entries()) {
          record(
            check(
              `${label} morning`,
              nowMs,
              `ps.comeback.${index + 1}`,
              by.get(`ps.comeback.${index + 1}` as never),
              addDaysToKey(day, days),
              18 * 60 + 30,
            ),
          );
        }
      }

      // (2) Eve of the shift, 22:00, already trained: defense TOMORROW 19:30,
      //     daily reminder configured 07:00 → tomorrow 07:00 (crosses the shift).
      {
        const nowMs = localInstant(eve, 22, 0);
        const prefs: NotificationPrefs = {
          ...allOn,
          practiceReminderMinutes: 7 * 60,
        };
        const plan = buildNotificationPlan(prefs, {
          nowMs,
          streakDays: 9,
          practicedToday: true,
          hasAnyHistory: true,
        });
        const by = new Map(plan.map(item => [item.id, item.timestampMs]));
        record(
          check(
            `${label} eve`,
            nowMs,
            'ps.reminder.streak',
            by.get('ps.reminder.streak'),
            day,
            19 * 60 + 30,
          ),
        );
        record(
          check(
            `${label} eve`,
            nowMs,
            'ps.reminder.practice',
            by.get('ps.reminder.practice'),
            day,
            7 * 60,
          ),
        );
      }

      // (3) Shift day 09:00 with a late reminder (23:30): must stay on the
      //     shift day, never spill into the next calendar day.
      {
        const nowMs = localInstant(day, 9, 0);
        const prefs: NotificationPrefs = {
          ...allOn,
          practiceReminderMinutes: 23 * 60 + 30,
        };
        const plan = buildNotificationPlan(prefs, {
          nowMs,
          streakDays: 0,
          practicedToday: false,
          hasAnyHistory: false,
        });
        const by = new Map(plan.map(item => [item.id, item.timestampMs]));
        record(
          check(
            `${label} late-reminder`,
            nowMs,
            'ps.reminder.practice',
            by.get('ps.reminder.practice'),
            day,
            23 * 60 + 30,
          ),
        );
      }

      // (4) Calendar-day arithmetic of the comeback ladder from the eve.
      {
        const nowMs = localInstant(eve, 12, 0);
        const plan = buildNotificationPlan(allOn, {
          nowMs,
          streakDays: 0,
          practicedToday: false,
          hasAnyHistory: false,
        });
        for (const item of plan.filter(p => p.id.startsWith('ps.comeback.'))) {
          const rung = Number(item.id.slice(-1));
          const days = [3, 7, 14][rung - 1]!;
          const observed = localWall(item.timestampMs);
          const p = check(
            `${label} ladder`,
            nowMs,
            item.id,
            item.timestampMs,
            addDaysToKey(eve, days),
            18 * 60 + 30,
          );
          record(p);
          expect(dayDiff(observed.day, eve)).toBe(days);
        }
      }

      expect(
        failures.map(
          f =>
            `${f.scenario} ${f.id}: expected ${f.expectedDay} ${f.expectedHHMM}, observed ${f.observedDay} ${f.observedHHMM}`,
        ),
      ).toEqual([]);
    },
  );
});
