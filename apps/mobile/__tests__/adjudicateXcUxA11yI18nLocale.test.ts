/**
 * Adjudication reproductions for area xc-ux-a11y-i18n (locale/time zone).
 *
 * Jest sandboxes `process.env`; timezone-sensitive cases run the production
 * pure modules in a child Node process started with the required TZ. Every
 * zone runs on every invocation, including the raw-JS hazard controls.
 *
 * `expected` blocks assert the product contract against the production code;
 * `hazard` blocks pin the raw JS behaviour that produced the defect observed
 * on 4d812e1a (a 12:00Z anchor formatted in the device zone; local midnight
 * plus minutes across a DST transition) so the trap stays documented.
 */
import { formatDayKey } from '../src/consistency/engine';
import { buildNotificationPlan } from '../src/notifications/plan';
import { DEFAULT_NOTIFICATION_PREFS } from '../src/notifications/types';

import { execFileSync } from 'node:child_process';
import path from 'node:path';

interface ZoneSample {
  zone: string;
  title: string;
  noonUtcTitle: string;
  plans: Record<string, Record<string, string>>;
  hazards: Record<string, string[]>;
}
const zoneSamples = new Map<string, ZoneSample>();
function sampleZone(zone: string): ZoneSample {
  const cached = zoneSamples.get(zone);
  if (cached) return cached;
  const script = `
    const fs = require('node:fs');
    const ts = require('typescript');
    require.extensions['.ts'] = (module, filename) => {
      const source = fs.readFileSync(filename, 'utf8');
      module._compile(ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
      }).outputText, filename);
    };
    const { formatDayKey } = require('./src/consistency/engine.ts');
    const { buildNotificationPlan } = require('./src/notifications/plan.ts');
    const { DEFAULT_NOTIFICATION_PREFS } = require('./src/notifications/types.ts');
    const wallClock = ms => { const d = new Date(ms); return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0'); };
    const plans = {}, hazards = {};
    for (const day of ['2026-03-29', '2026-11-01']) {
      plans[day] = Object.fromEntries(buildNotificationPlan(
        {...DEFAULT_NOTIFICATION_PREFS, enabled:true},
        {nowMs:new Date(day+'T09:00:00').getTime(), streakDays:3, practicedToday:false, hasAnyHistory:true}
      ).map(p => [p.id, wallClock(p.timestampMs)]));
      const midnight = new Date(day+'T09:00:00'); midnight.setHours(0,0,0,0);
      hazards[day] = [17*60+30,19*60+30].map(minutes => wallClock(midnight.getTime()+minutes*60000));
    }
    process.stdout.write(JSON.stringify({zone:Intl.DateTimeFormat().resolvedOptions().timeZone,
      title:formatDayKey('2026-09-04',{weekday:'long',month:'long',day:'numeric'}),
      noonUtcTitle:new Date('2026-09-04T12:00:00Z').toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'}), plans, hazards}));
  `;
  const value = JSON.parse(
    execFileSync(process.execPath, ['-e', script], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, TZ: zone },
      encoding: 'utf8',
      timeout: 10000,
    }),
  ) as ZoneSample;
  expect(value.zone).toBe(zone);
  zoneSamples.set(zone, value);
  return value;
}

/** The production formatter behind the StreakCalendarScreen selected-day
 * title and AchievementsShowcase's "Earned" label. */
function productionDayTitle(day: string): string {
  return formatDayKey(day, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

describe('A1 — calendar day labels anchored at 12:00Z roll to the next day at UTC+12 and beyond', () => {
  const east = ['Pacific/Auckland', 'Pacific/Fiji', 'Pacific/Kiritimati'];

  test.each(east)(
    'expected: selected day 2026-09-04 renders as September 4 in %s',
    zone => {
      expect(sampleZone(zone).title).toBe('Friday, September 4');
    },
  );

  test('expected: selected day 2026-09-04 renders as September 4 in the current zone', () => {
    expect(productionDayTitle('2026-09-04')).toBe('Friday, September 4');
  });

  test.each(east)('hazard: a 12:00Z anchor renders September 5 in %s', zone => {
    expect(sampleZone(zone).noonUtcTitle).toBe('Saturday, September 5');
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
  test.each(['Europe/Berlin'])(
    'expected: 2026-03-29 (spring forward) keeps 17:30 / 19:30',
    zone => {
      const times = sampleZone(zone).plans['2026-03-29'];
      if (!times) throw new Error(`Missing spring-forward plan for ${zone}`);
      expect(times['ps.reminder.practice']).toBe('17:30');
      expect(times['ps.reminder.streak']).toBe('19:30');
    },
  );

  test.each(['Europe/Berlin'])(
    'hazard: midnight + minutes on 2026-03-29 lands at 18:30 / 20:30',
    zone => {
      expect(sampleZone(zone).hazards['2026-03-29']).toEqual([
        '18:30',
        '20:30',
      ]);
    },
  );

  test.each(['America/Los_Angeles'])(
    'expected: 2026-11-01 (fall back) keeps 17:30 / 19:30',
    zone => {
      const times = sampleZone(zone).plans['2026-11-01'];
      if (!times) throw new Error(`Missing fall-back plan for ${zone}`);
      expect(times['ps.reminder.practice']).toBe('17:30');
      expect(times['ps.reminder.streak']).toBe('19:30');
    },
  );

  test.each(['America/Los_Angeles'])(
    'hazard: midnight + minutes on 2026-11-01 lands at 16:30 / 18:30',
    zone => {
      expect(sampleZone(zone).hazards['2026-11-01']).toEqual([
        '16:30',
        '18:30',
      ]);
    },
  );

  test('expected: DST transition days keep 17:30 / 19:30 in the current zone', () => {
    // EU, US and NZ transition days of 2026.
    for (const day of [
      '2026-03-29',
      '2026-10-25',
      '2026-03-08',
      '2026-11-01',
      '2026-04-05',
      '2026-09-27',
    ]) {
      const times = planOn(day);
      expect(times['ps.reminder.practice']).toBe('17:30');
      expect(times['ps.reminder.streak']).toBe('19:30');
    }
  });

  test('control: a non-transition day is exact in the current zone', () => {
    for (const day of ['2026-03-28', '2026-10-31', '2026-07-15']) {
      const times = planOn(day);
      expect(times['ps.reminder.practice']).toBe('17:30');
      expect(times['ps.reminder.streak']).toBe('19:30');
    }
  });
});
