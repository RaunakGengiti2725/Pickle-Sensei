import { buildNotificationPlan } from '../../src/notifications/plan';
import {
  DEFAULT_NOTIFICATION_PREFS,
  NOTIFICATION_ID_PREFIX,
  type NotificationPrefs,
} from '../../src/notifications/types';
import { randomPatch } from '../../testing/stress/notificationsFixtures';
import {
  pick,
  randomInt,
  recordStress,
  seededRandom,
  stressSeeds,
} from '../../testing/stress/stressEvidence';

/**
 * Seeded property checks for the pure planner — the contract every
 * concurrent sync relies on. Per seed: 25 random (prefs, context) pairs
 * with the clock anywhere in 2024–2030 (DST edges included) and a second
 * skewed clock (±1s … ±40 days).
 *
 *   P1 deterministic: same input twice ⇒ byte-identical plan (idempotent).
 *   P2 no duplicate ids; every id under the `ps.` prefix; screens ∈
 *      {Home, Performance}; disabled ⇒ empty plan.
 *   P3 every timestamp ≥ nowMs + 90s (a sync never self-fires), and the
 *      practice/weekly/comeback slots land within their windows.
 *   P4 under clock skew the plan for the skewed clock still satisfies P3
 *      against the skewed clock (no past-dated reminders after a jump).
 *
 * Replay: STRESS_SEED=<seed> npx jest notificationPlanProperties
 */

const SUITE = 'notificationPlanProperties';
const MIN_LEAD_MS = 90_000;
const DAY_MS = 86_400_000;
const CASES_PER_SEED = 25;

function randomClock(random: () => number): number {
  const start = Date.UTC(2024, 0, 1);
  const end = Date.UTC(2030, 11, 31);
  return start + Math.floor(random() * (end - start));
}

function randomSkew(random: () => number): number {
  const magnitude = pick(random, [
    1_000,
    60_000,
    3_600_000,
    DAY_MS,
    7 * DAY_MS,
    40 * DAY_MS,
  ]);
  return (random() < 0.5 ? -1 : 1) * Math.floor(magnitude * (0.5 + random()));
}

function checkPlan(
  prefs: NotificationPrefs,
  nowMs: number,
  context: Parameters<typeof buildNotificationPlan>[1],
): string[] {
  const violations: string[] = [];
  const plan = buildNotificationPlan(prefs, context);
  const again = buildNotificationPlan(prefs, context);
  if (JSON.stringify(plan) !== JSON.stringify(again)) {
    violations.push('P1.deterministic');
  }
  const ids = plan.map(item => item.id);
  if (new Set(ids).size !== ids.length) violations.push('P2.uniqueIds');
  if (!ids.every(id => id.startsWith(NOTIFICATION_ID_PREFIX))) {
    violations.push('P2.prefix');
  }
  if (
    !plan.every(item => item.screen === 'Home' || item.screen === 'Performance')
  ) {
    violations.push('P2.screen');
  }
  if (!prefs.enabled && plan.length > 0) violations.push('P2.disabledEmpty');
  for (const item of plan) {
    if (item.timestampMs < nowMs + MIN_LEAD_MS) {
      violations.push(`P3.lead:${item.id}`);
    }
    if (
      item.id === 'ps.reminder.practice' &&
      item.timestampMs > nowMs + 2 * DAY_MS
    ) {
      violations.push('P3.practiceWindow');
    }
    if (item.id === 'ps.reminder.weekly') {
      if (item.timestampMs > nowMs + 15 * DAY_MS)
        violations.push('P3.weeklyWindow');
      if (new Date(item.timestampMs).getDay() !== 0)
        violations.push('P3.weeklySunday');
    }
    const rung = /^ps\.comeback\.(\d)$/.exec(item.id);
    if (rung) {
      const days = [3, 7, 14][Number(rung[1]) - 1]!;
      const distance = item.timestampMs - nowMs;
      if (distance < (days - 1) * DAY_MS || distance > (days + 1) * DAY_MS) {
        violations.push(`P3.comebackRung:${item.id}`);
      }
    }
  }
  return violations;
}

async function iteration(seed: number) {
  const random = seededRandom(seed);
  const violations: string[] = [];
  let cases = 0;
  for (let i = 0; i < CASES_PER_SEED; i += 1) {
    const prefs: NotificationPrefs = {
      ...DEFAULT_NOTIFICATION_PREFS,
      ...randomPatch(random),
      enabled: random() < 0.85,
      version: 1,
    };
    const nowMs = randomClock(random);
    const base = {
      nowMs,
      streakDays: randomInt(random, 0, 40),
      practicedToday: random() < 0.5,
      hasAnyHistory: random() < 0.7,
      shieldsAvailable: randomInt(random, 0, 3),
      milestoneEve:
        random() < 0.3 ? { title: 'Two-week streak', days: 14 } : null,
    };
    for (const v of checkPlan(prefs, nowMs, base)) {
      violations.push(`case${i}:${v}`);
    }
    const skew = randomSkew(random);
    const skewed = { ...base, nowMs: nowMs + skew };
    for (const v of checkPlan(prefs, nowMs + skew, skewed)) {
      violations.push(`case${i}:skew(${skew}):P4.${v}`);
    }
    cases += 2;
  }
  return { ok: violations.length === 0, violations, cases };
}

describe('buildNotificationPlan seeded properties', () => {
  it('holds P1–P4 for every seed', async () => {
    const failures: string[] = [];
    let executed = 0;
    for (const seed of stressSeeds(`${SUITE}.planProperties`)) {
      const outcome = await recordStress(
        SUITE,
        'planProperties',
        seed,
        { seed, casesPerSeed: CASES_PER_SEED },
        () => iteration(seed),
      );
      executed += 1;
      if (!outcome.ok) failures.push(`seed=${seed} ${JSON.stringify(outcome)}`);
    }
    expect(executed).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  });
});
