import { streakDefenseCopy } from '../src/notifications/copy';
import { buildNotificationPlan } from '../src/notifications/plan';
import { DEFAULT_NOTIFICATION_PREFS } from '../src/notifications/types';

/**
 * Streak-defense copy: honest, specific, lock-screen safe. The number it
 * names is the streak that is guaranteed true at delivery (plan.ts only
 * schedules the reminder for days whose state is already known), and the
 * milestone-eve variant fires exactly when tonight's session unlocks one.
 */

const DAY_MS = 86_400_000;
/** Delivery instants pinned to known parities of the day-rotation index. */
const EVEN_DAY_MS = DAY_MS * 20_000 + 70_200_000; // 7:30 PM of an even day.
const ODD_DAY_MS = DAY_MS * 20_001 + 70_200_000;

describe('streakDefenseCopy', () => {
  it('leads with the streak count and the one-analysis ask', () => {
    const copy = streakDefenseCopy(EVEN_DAY_MS, {
      streakDays: 17,
      shieldsAvailable: 0,
      milestoneEve: null,
    });
    expect(copy.title).toBe('17 days strong 🔥');
    expect(copy.body).toBe('Complete one analysis tonight to keep it alive.');
  });

  it('speaks in the singular for a one-day run', () => {
    const copy = streakDefenseCopy(ODD_DAY_MS, {
      streakDays: 1,
      shieldsAvailable: 0,
      milestoneEve: null,
    });
    expect(`${copy.title} ${copy.body}`).toContain('1 day strong');
  });

  it('outranks everything with the milestone-eve variant', () => {
    const copy = streakDefenseCopy(EVEN_DAY_MS, {
      streakDays: 29,
      shieldsAvailable: 2,
      milestoneEve: { title: '30 Day Club', days: 30 },
    });
    expect(copy.title).toBe('30 Day Club is one session away.');
    expect(copy.body).toContain('day 30 unlocks it');
  });

  it('mentions a banked shield honestly when one exists', () => {
    // Three variants rotate when a shield is banked; day index 20003 % 3 = 2
    // lands on the shield variant.
    const shieldDayMs = DAY_MS * 20_003 + 70_200_000;
    const copy = streakDefenseCopy(shieldDayMs, {
      streakDays: 9,
      shieldsAvailable: 1,
      milestoneEve: null,
    });
    expect(copy.body).toContain('Streak Shield');
  });

  it('falls back to fact-free copy without streak facts', () => {
    const copy = streakDefenseCopy(EVEN_DAY_MS);
    expect(copy.title).toBe('Your streak is alive.');
    expect(copy.body).not.toMatch(/\d/);
  });
});

describe('buildNotificationPlan streak defense wiring', () => {
  const prefs = {
    ...DEFAULT_NOTIFICATION_PREFS,
    enabled: true,
    practiceReminder: false,
    weeklyRecap: false,
    comeback: false,
  };

  it('feeds the live streak facts into the scheduled reminder', () => {
    const nowMs = new Date(2026, 2, 10, 10, 0, 0).getTime();
    const plan = buildNotificationPlan(prefs, {
      nowMs,
      streakDays: 29,
      practicedToday: false,
      hasAnyHistory: true,
      shieldsAvailable: 1,
      milestoneEve: { title: '30 Day Club', days: 30 },
    });
    const defense = plan.find(entry => entry.id === 'ps.reminder.streak');
    expect(defense?.title).toBe('30 Day Club is one session away.');
  });

  it('schedules nothing without a live streak', () => {
    const nowMs = new Date(2026, 2, 10, 10, 0, 0).getTime();
    const plan = buildNotificationPlan(prefs, {
      nowMs,
      streakDays: 0,
      practicedToday: false,
      hasAnyHistory: true,
    });
    expect(
      plan.find(entry => entry.id === 'ps.reminder.streak'),
    ).toBeUndefined();
  });
});
