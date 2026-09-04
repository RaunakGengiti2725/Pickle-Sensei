/**
 * STRESS — unit `mod-notifications`, lens `randomized-seeded`, pure layer.
 *
 * Seeded fuzz of `buildNotificationPlan` + `parseNotificationPrefs` +
 * `formatReminderMinutes` (notifications/plan.ts, types.ts): random legal
 * preferences × random instants across 2025–2027 (every wall-clock minute,
 * DST weekends included) × random streak facts, checked against the
 * planner's documented contract after every call:
 *
 *   P-01 master off ⇒ empty plan
 *   P-02 every timestamp ≥ now + 90 s (a sync must never self-fire)
 *   P-03 ids unique, all under `ps.`, all in PLANNED_NOTIFICATION_IDS
 *   P-04 practice reminder: present iff enabled; lands on the configured
 *        wall-clock (when that slot exists that day) today or tomorrow; daily
 *   P-05 streak defense: only while streakDays > 0; today 19:30 when no
 *        capture yet and it is ≥ 90 s away; tomorrow 19:30 after a captured
 *        day; omitted (never a false claim) past the cut-off; one-shot
 *   P-06 weekly recap: only with history; next Sunday 18:00 (≤ 7 days out);
 *        weekly
 *   P-07 comeback ladder: exactly +3/+7/+14 local days at 18:30, one-shot,
 *        strictly increasing
 *   P-08 copy non-empty; screen ∈ {Home, Performance}; lock-screen safe
 *        (no digits other than the streak count / milestone day)
 *   P-09 determinism: same inputs ⇒ deep-equal plan
 *   P-10 parse: never throws on junk; always yields version-1 prefs with an
 *        in-range integer minute; round-trips every legal prefs object
 *   P-11 formatReminderMinutes: total function over all numbers
 *
 * Runs in the process zone. Zone sweep, e.g.:
 *   cd apps/mobile && for tz in UTC America/Los_Angeles Europe/Berlin \
 *     America/Santiago Australia/Lord_Howe Asia/Kathmandu; do \
 *     TZ=$tz STRESS_ITER=20000 npx jest --ci __tests__/stress/notificationPlanRandomized.stress.test.ts || exit 1; done
 *   STRESS_OUT=/tmp/plan-stress.json writes the seed → outcome table.
 */
import {
  buildNotificationPlan,
  type NotificationPlanContext,
} from '../../src/notifications/plan';
import {
  DEFAULT_NOTIFICATION_PREFS,
  NOTIFICATION_ID_PREFIX,
  PLANNED_NOTIFICATION_IDS,
  formatReminderMinutes,
  parseNotificationPrefs,
  type NotificationPrefs,
  type PlannedNotification,
} from '../../src/notifications/types';

// Node built-ins for the raw artifacts. The mobile tsconfig excludes node
// typings (see be-mobile-sync-outbox.test.ts), so the shims stay local.
declare const require: (id: string) => unknown;
declare const process: { env: Record<string, string | undefined> };
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { dirname } = require('path') as { dirname: (path: string) => string };

const ITER = Math.max(1, Number(process.env['STRESS_ITER'] ?? 4000));
const BASE_SEED = Number(process.env['STRESS_SEED'] ?? 1);
const OUT = process.env['STRESS_OUT'];
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const MIN_LEAD_MS = 90_000;

class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x9e3779b9) >>> 0;
    let z = this.state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    z = (z ^ (z >>> 15)) >>> 0;
    return z / 4294967296;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  bool(p = 0.5): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error('pick from empty');
    return item;
  }
}

function seedFor(index: number): number {
  return (
    (Math.imul(BASE_SEED, 0x9e3779b1) ^ Math.imul(index + 1, 0x85ebca77)) >>> 0
  );
}

interface Case {
  seed: number;
  prefs: NotificationPrefs;
  context: NotificationPlanContext;
}

function randomPrefs(rng: Rng): NotificationPrefs {
  return {
    version: 1,
    enabled: rng.bool(0.85),
    practiceReminder: rng.bool(0.7),
    practiceReminderMinutes: rng.bool(0.5)
      ? rng.int(0, 95) * 15
      : rng.int(0, 1439),
    streakDefense: rng.bool(0.7),
    weeklyRecap: rng.bool(0.7),
    comeback: rng.bool(0.7),
    promptDismissed: rng.bool(),
  };
}

function randomNow(rng: Rng): number {
  const year = rng.int(2025, 2027);
  const flavour = rng.int(0, 9);
  if (flavour < 6) {
    return new Date(
      year,
      rng.int(0, 11),
      rng.int(1, 28),
      rng.int(0, 23),
      rng.int(0, 59),
      rng.int(0, 59),
      rng.int(0, 999),
    ).getTime();
  }
  if (flavour < 8) {
    // Around the streak cut-off / minute boundaries: 19:28:30 .. 19:31:30.
    return new Date(
      year,
      rng.int(0, 11),
      rng.int(1, 28),
      19,
      rng.int(28, 31),
      rng.int(0, 59),
      rng.int(0, 999),
    ).getTime();
  }
  // DST transition weekends (US/EU/AU/Chile): late Mar/Sep/Oct/Nov, Sundays 0–4h.
  const month = rng.pick([2, 3, 8, 9, 10]);
  for (let day = 1; day <= 31; day += 1) {
    const candidate = new Date(
      year,
      month,
      day,
      rng.int(0, 4),
      rng.int(0, 59),
      0,
      0,
    );
    if (candidate.getMonth() !== month) break;
    if (candidate.getDay() === 0 && rng.bool(0.35)) return candidate.getTime();
  }
  return new Date(year, month, 15, 2, 30, 0, 0).getTime();
}

function randomCase(seed: number): Case {
  const rng = new Rng(seed);
  const prefs = randomPrefs(rng);
  const nowMs = randomNow(rng);
  const streakDays = rng.bool(0.35)
    ? 0
    : rng.bool(0.8)
      ? rng.int(1, 60)
      : rng.int(61, 1000);
  const context: NotificationPlanContext = {
    nowMs,
    streakDays,
    practicedToday: rng.bool(),
    hasAnyHistory: rng.bool(0.7),
  };
  if (rng.bool(0.6)) context.shieldsAvailable = rng.int(0, 5);
  if (rng.bool(0.3))
    context.milestoneEve = {
      title: rng.pick(['Week One', 'Fortnight', 'Iron Month']),
      days: rng.pick([7, 14, 30]),
    };
  else if (rng.bool(0.5)) context.milestoneEve = null;
  return { seed, prefs, context };
}

function slotExists(
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

function localDayIndex(ms: number): number {
  const d = new Date(ms);
  return Math.round(
    new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime() /
      86_400_000,
  );
}

function daysBetween(fromMs: number, toMs: number): number {
  return localDayIndex(toMs) - localDayIndex(fromMs);
}

function wall(ms: number): { h: number; m: number } {
  const d = new Date(ms);
  return { h: d.getHours(), m: d.getMinutes() };
}

function checkPlan(c: Case, plan: PlannedNotification[]): string[] {
  const out: string[] = [];
  const { prefs, context } = c;
  const now = context.nowMs;
  const byId = new Map(plan.map(item => [item.id, item]));

  if (!prefs.enabled) {
    if (plan.length) out.push(`P-01 master off but ${plan.length} planned`);
    return out;
  }

  const ids = plan.map(p => p.id);
  if (new Set(ids).size !== ids.length)
    out.push(`P-03 duplicate ids ${ids.join(',')}`);
  for (const item of plan) {
    if (!item.id.startsWith(NOTIFICATION_ID_PREFIX))
      out.push(`P-03 id ${item.id} lacks prefix`);
    if (!(PLANNED_NOTIFICATION_IDS as readonly string[]).includes(item.id))
      out.push(`P-03 id ${item.id} unknown`);
    if (!Number.isFinite(item.timestampMs))
      out.push(`P-02 ${item.id} non-finite timestamp`);
    else if (item.timestampMs < now + MIN_LEAD_MS) {
      out.push(
        `P-02 ${item.id} at ${new Date(item.timestampMs).toISOString()} < now+90s (${new Date(now).toISOString()})`,
      );
    }
    if (!item.title || !item.body) out.push(`P-08 ${item.id} empty copy`);
    if (item.screen !== 'Home' && item.screen !== 'Performance')
      out.push(`P-08 ${item.id} screen ${String(item.screen)}`);
    if (item.title.length > 60)
      out.push(
        `P-08 ${item.id} title too long for a lock screen (${item.title.length})`,
      );
  }

  // P-04 practice
  const practice = byId.get('ps.reminder.practice');
  if (prefs.practiceReminder !== Boolean(practice))
    out.push(
      `P-04 practice present=${Boolean(practice)} want ${prefs.practiceReminder}`,
    );
  if (practice) {
    if (practice.repeat !== 'daily') out.push('P-04 practice not daily');
    const wantH = Math.floor(prefs.practiceReminderMinutes / 60);
    const wantM = prefs.practiceReminderMinutes % 60;
    const t = new Date(practice.timestampMs);
    const days = daysBetween(now, practice.timestampMs);
    if (days < 0 || days > 1)
      out.push(`P-04 practice ${days} days out (want 0 or 1)`);
    if (slotExists(t.getFullYear(), t.getMonth(), t.getDate(), wantH, wantM)) {
      const w = wall(practice.timestampMs);
      if (w.h !== wantH || w.m !== wantM)
        out.push(`P-04 practice at ${w.h}:${w.m} want ${wantH}:${wantM}`);
    }
    // Today's slot skipped only when it was too close.
    if (days === 1) {
      const todaySlot = new Date(now);
      todaySlot.setHours(wantH, wantM, 0, 0);
      if (
        todaySlot.getTime() >= now + MIN_LEAD_MS &&
        slotExists(
          todaySlot.getFullYear(),
          todaySlot.getMonth(),
          todaySlot.getDate(),
          wantH,
          wantM,
        )
      ) {
        out.push(
          `P-04 practice pushed to tomorrow although today's slot ${todaySlot.toISOString()} was ≥ 90s away`,
        );
      }
    }
  }

  // P-05 streak
  const streak = byId.get('ps.reminder.streak');
  const todayCut = new Date(now);
  todayCut.setHours(19, 30, 0, 0);
  const streakWanted =
    prefs.streakDefense &&
    context.streakDays > 0 &&
    (context.practicedToday || todayCut.getTime() >= now + MIN_LEAD_MS);
  if (Boolean(streak) !== streakWanted)
    out.push(`P-05 streak present=${Boolean(streak)} want ${streakWanted}`);
  if (streak) {
    if (streak.repeat !== null) out.push('P-05 streak repeats');
    const days = daysBetween(now, streak.timestampMs);
    const wantDays = context.practicedToday ? 1 : 0;
    if (days !== wantDays)
      out.push(`P-05 streak ${days} days out, want ${wantDays}`);
    const t = new Date(streak.timestampMs);
    if (slotExists(t.getFullYear(), t.getMonth(), t.getDate(), 19, 30)) {
      const w = wall(streak.timestampMs);
      if (w.h !== 19 || w.m !== 30) out.push(`P-05 streak at ${w.h}:${w.m}`);
    }
    // Honest copy: the streak count in the title/body must be THE streak.
    const digits = `${streak.title} ${streak.body}`.match(/\d+/g) ?? [];
    for (const digit of digits) {
      const n = Number(digit);
      if (
        n !== context.streakDays &&
        n !== (context.milestoneEve?.days ?? -1)
      ) {
        out.push(
          `P-08 streak copy mentions ${n} (streak ${context.streakDays})`,
        );
      }
    }
  }

  // P-06 weekly
  const weekly = byId.get('ps.reminder.weekly');
  const weeklyWanted = prefs.weeklyRecap && context.hasAnyHistory;
  if (Boolean(weekly) !== weeklyWanted)
    out.push(`P-06 weekly present=${Boolean(weekly)} want ${weeklyWanted}`);
  if (weekly) {
    if (weekly.repeat !== 'weekly') out.push('P-06 weekly not weekly');
    if (weekly.screen !== 'Performance')
      out.push('P-06 weekly must open Progress');
    const t = new Date(weekly.timestampMs);
    if (t.getDay() !== 0) out.push(`P-06 weekly on weekday ${t.getDay()}`);
    const days = daysBetween(now, weekly.timestampMs);
    if (days < 0 || days > 7) out.push(`P-06 weekly ${days} days out`);
    if (slotExists(t.getFullYear(), t.getMonth(), t.getDate(), 18, 0)) {
      const w = wall(weekly.timestampMs);
      if (w.h !== 18 || w.m !== 0) out.push(`P-06 weekly at ${w.h}:${w.m}`);
    }
  }

  // P-07 comeback
  const rungs = [
    byId.get('ps.comeback.1'),
    byId.get('ps.comeback.2'),
    byId.get('ps.comeback.3'),
  ];
  if (prefs.comeback !== rungs.every(Boolean))
    out.push(
      `P-07 comeback rungs ${rungs.filter(Boolean).length}/3 want ${prefs.comeback ? 3 : 0}`,
    );
  if (prefs.comeback) {
    const wantDays = [3, 7, 14];
    let previous = -Infinity;
    rungs.forEach((rung, index) => {
      if (!rung) return;
      if (rung.repeat !== null) out.push(`P-07 rung ${index + 1} repeats`);
      const days = daysBetween(now, rung.timestampMs);
      if (days !== wantDays[index])
        out.push(
          `P-07 rung ${index + 1} ${days} days out want ${wantDays[index]}`,
        );
      const t = new Date(rung.timestampMs);
      if (slotExists(t.getFullYear(), t.getMonth(), t.getDate(), 18, 30)) {
        const w = wall(rung.timestampMs);
        if (w.h !== 18 || w.m !== 30)
          out.push(`P-07 rung ${index + 1} at ${w.h}:${w.m}`);
      }
      if (rung.timestampMs <= previous)
        out.push(`P-07 rung ${index + 1} not after rung ${index}`);
      previous = rung.timestampMs;
    });
  }
  return out;
}

const JUNK = [
  '',
  'null',
  'true',
  '0',
  '[]',
  '{}',
  '{',
  '"x"',
  '{"version":1}',
  '{"version":1,"practiceReminderMinutes":1440}',
  '{"version":1,"practiceReminderMinutes":-1}',
  '{"version":1,"practiceReminderMinutes":"1050"}',
  '{"version":1,"practiceReminderMinutes":90.5}',
  '{"version":1,"practiceReminderMinutes":null}',
  '{"version":1,"enabled":1,"streakDefense":"true"}',
  '{"__proto__":{"enabled":true},"version":1}',
  '{"version":1,"enabled":true,"practiceReminderMinutes":1e309}',
];

function randomJunk(rng: Rng): string {
  if (rng.bool(0.5)) return rng.pick(JUNK);
  const bytes: string[] = [];
  const n = rng.int(0, 24);
  for (let i = 0; i < n; i += 1)
    bytes.push(String.fromCharCode(rng.int(32, 126)));
  return bytes.join('');
}

function checkParse(rng: Rng, prefs: NotificationPrefs): string[] {
  const out: string[] = [];
  const back = parseNotificationPrefs(JSON.stringify(prefs));
  if (JSON.stringify(back) !== JSON.stringify(prefs))
    out.push(`P-10 legal prefs did not round-trip: ${JSON.stringify(back)}`);
  const junk = randomJunk(rng);
  let parsed: NotificationPrefs;
  try {
    parsed = parseNotificationPrefs(junk);
  } catch (error) {
    return [
      ...out,
      `P-10 parse threw on ${JSON.stringify(junk)}: ${String(error)}`,
    ];
  }
  if (parsed.version !== 1) out.push('P-10 parsed version != 1');
  const m = parsed.practiceReminderMinutes;
  if (!Number.isInteger(m) || m < 0 || m >= 1440)
    out.push(
      `P-10 parsed minutes ${m} out of range for ${JSON.stringify(junk)}`,
    );
  for (const key of [
    'enabled',
    'practiceReminder',
    'streakDefense',
    'weeklyRecap',
    'comeback',
    'promptDismissed',
  ] as const) {
    if (typeof parsed[key] !== 'boolean')
      out.push(`P-10 parsed ${key} not boolean for ${JSON.stringify(junk)}`);
  }
  if (
    Object.keys(parsed).length !==
    Object.keys(DEFAULT_NOTIFICATION_PREFS).length
  )
    out.push('P-10 parsed prefs carry extra keys');
  const anyMinutes = rng.pick([
    rng.int(-5000, 5000),
    rng.next() * 3000 - 1000,
    Number.NaN,
    Infinity,
    -Infinity,
    1439.5,
  ]);
  const label = formatReminderMinutes(anyMinutes);
  if (
    typeof label !== 'string' ||
    !/^(1[0-2]|[1-9]):[0-5]\d (AM|PM)$/.test(label)
  ) {
    // NaN/Infinity have no honest label; anything else must format.
    if (Number.isFinite(anyMinutes))
      out.push(
        `P-11 formatReminderMinutes(${anyMinutes}) = ${JSON.stringify(label)}`,
      );
  }
  return out;
}

interface Row {
  seed: number;
  outcome: 'HELD' | 'BROKEN';
  violations: string[];
  nowIso: string;
  minutes: number;
  planned: number;
}

const rows: Row[] = [];
let executed = 0;

afterAll(() => {
  if (!OUT) return;
  const broken = rows.filter(r => r.outcome === 'BROKEN');
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        unit: 'mod-notifications/plan',
        lens: 'randomized-seeded',
        timeZone: ZONE,
        baseSeed: BASE_SEED,
        iterations: ITER,
        scenariosExecuted: executed,
        held: rows.length - broken.length,
        broken: broken.length,
        failingSeeds: broken.map(r => r.seed),
        results: rows,
      },
      null,
      2,
    ),
  );
});

describe(`stress plan randomized-seeded in TZ=${ZONE} (${ITER} cases, base seed ${BASE_SEED})`, () => {
  it('every case holds P-01..P-11 and replays identically', () => {
    const failures: string[] = [];
    for (let index = 0; index < ITER; index += 1) {
      const seed = seedFor(index);
      const c = randomCase(seed);
      const rng = new Rng(seed ^ 0x5bd1e995);
      let violations: string[];
      let planned = 0;
      try {
        const plan = buildNotificationPlan(c.prefs, c.context);
        const again = buildNotificationPlan(c.prefs, c.context);
        planned = plan.length;
        violations = checkPlan(c, plan);
        if (JSON.stringify(plan) !== JSON.stringify(again))
          violations.push('P-09 non-deterministic plan');
        violations.push(...checkParse(rng, c.prefs));
      } catch (error) {
        violations = [`P-00 threw: ${String(error)}`];
      }
      executed += 1;
      rows.push({
        seed,
        outcome: violations.length ? 'BROKEN' : 'HELD',
        violations,
        nowIso: new Date(c.context.nowMs).toISOString(),
        minutes: c.prefs.practiceReminderMinutes,
        planned,
      });
      if (violations.length) {
        failures.push(
          `seed ${seed} now=${new Date(c.context.nowMs).toISOString()} prefs=${JSON.stringify(c.prefs)} ctx=${JSON.stringify(c.context)}\n  ${violations.join('\n  ')}`,
        );
      }
    }
    expect(failures).toEqual([]);
  }, 600_000);
});
