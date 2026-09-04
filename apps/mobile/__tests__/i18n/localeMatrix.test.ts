// The probe imports ProgressScreen's pure `percent` helper; that module graph
// reaches the SQLite binding, which never runs here.
jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));

import {
  ADVERSARIAL_ZONES,
  AUDIT_LOCALES,
  FIXED_INSTANTS,
  RUNTIME_STATES,
} from '../../i18n-harness/matrix';
import {
  type ProbeRow,
  type ProbeRun,
  dayKeyIn,
  runProbe,
  wallClock,
} from '../../i18n-harness/probe';
import { CAPTURE_INSTANTS } from '../../i18n-harness/fixtures';
import { buildNotificationPlan } from '../../src/notifications/plan';
import { DEFAULT_NOTIFICATION_PREFS } from '../../src/notifications/types';

/**
 * 12-locale × 2-runtime-state locale-formatting matrix for apps/mobile.
 *
 * The process time zone is a dimension too, and Node/jest cannot change it
 * at runtime, so `i18n-harness/run-locale-matrix.mjs` spawns this file once
 * per zone (and once per real `LANG` for the cross-check) and merges the
 * JSON each run writes to `PS_I18N_OUT`. Run alone it audits the current
 * zone only — still a complete 24-run matrix for that zone.
 *
 * Plain `test`s are invariants that must hold everywhere. `test.failing`
 * pins reproduced divergences: the assertion states the CORRECT behaviour,
 * jest requires it to fail today, and the moment production fixes the site
 * the pin flips red so the audit record is updated deliberately.
 */

// Node built-ins for the artifact write. The mobile tsconfig deliberately
// excludes node typings, so the shims stay local (same as
// importedRealFootageAnalysis.test.ts).
declare const require: (id: string) => unknown;
declare const process: {
  env: Record<string, string | undefined>;
  version: string;
  versions: Record<string, string | undefined>;
};
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { dirname } = require('path') as { dirname: (path: string) => string };

const processZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
const envLocale = new Intl.DateTimeFormat().resolvedOptions().locale;

const runs: ProbeRun[] = [];
for (const state of RUNTIME_STATES) {
  for (const locale of AUDIT_LOCALES) {
    runs.push(runProbe(state, locale));
  }
}
const envRun = runProbe('env', {
  tag: envLocale,
  region: new Intl.Locale(envLocale).region ?? '',
});

afterAll(() => {
  const out = process.env.PS_I18N_OUT;
  if (!out) return;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify(
      {
        processZone,
        envLocale,
        node: process.version,
        icu: process.versions.icu,
        locales: AUDIT_LOCALES.map(l => l.tag),
        states: RUNTIME_STATES,
        fixtures: { instants: CAPTURE_INSTANTS, ...FIXED_INSTANTS },
        runs: [...runs, envRun],
      },
      null,
      2,
    ),
  );
});

function rowsFor(site: string, subset: ProbeRun[] = runs): ProbeRow[] {
  return subset.map(run => {
    const row = run.rows.find(candidate => candidate.site === site);
    if (!row) throw new Error(`probe site ${site} missing from a run`);
    return row;
  });
}

function distinctOutputs(site: string, subset: ProbeRun[] = runs): string[] {
  return [...new Set(rowsFor(site, subset).map(row => row.output))];
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
// techniqueDashboard compacts sparse ranges into `start:end` bucket keys.
const BUCKET_KEY = /^\d{4}-\d{2}-\d{2}(:\d{4}-\d{2}-\d{2})?$/;
const ALL_SITES = [...new Set(runs[0]!.rows.map(row => row.site))];

describe(`i18n locale matrix (zone ${processZone}, env ${envLocale})`, () => {
  test('every state × locale run produced the same set of sites', () => {
    expect(runs).toHaveLength(RUNTIME_STATES.length * AUDIT_LOCALES.length);
    for (const run of [...runs, envRun]) {
      expect(run.rows.map(row => row.site)).toEqual(ALL_SITES);
      expect(run.processZone).toBe(processZone);
    }
  });

  test('locale-invariant sites render identically under all 24 runs', () => {
    const invariant = runs[0]!.rows
      .filter(row => row.expectation === 'locale-invariant')
      .map(row => row.site);
    expect(invariant.length).toBeGreaterThanOrEqual(8);
    const drift = invariant
      .map(site => [site, distinctOutputs(site)] as const)
      .filter(([, outputs]) => outputs.length !== 1);
    expect(drift).toEqual([]);
  });

  test('zone-derived sites depend on the zone only, never on locale or state', () => {
    const zoneDerived = runs[0]!.rows
      .filter(row => row.expectation === 'zone-derived')
      .map(row => row.site);
    expect(zoneDerived.length).toBeGreaterThanOrEqual(6);
    const drift = zoneDerived
      .map(site => [site, distinctOutputs(site, [...runs, envRun])] as const)
      .filter(([, outputs]) => outputs.length !== 1);
    expect(drift).toEqual([]);
  });

  test('machine day keys stay YYYY-MM-DD Gregorian Latin under every locale', () => {
    for (const run of [...runs, envRun]) {
      const snapshot = JSON.parse(
        run.rows.find(r => r.site === 'consistencyEngine.snapshot')!.output,
      ) as { asOfDay: string; days: string[]; earned: [string, string][] };
      expect(snapshot.asOfDay).toMatch(DAY_KEY);
      expect(snapshot.asOfDay).toBe(
        dayKeyIn(Date.parse(FIXED_INSTANTS.asOf), processZone),
      );
      for (const day of snapshot.days) expect(day).toMatch(DAY_KEY);
      for (const [, day] of snapshot.earned) expect(day).toMatch(DAY_KEY);

      const buckets = JSON.parse(
        run.rows.find(r => r.site === 'techniqueDashboard.buckets.label')!
          .output,
      ) as [string, string][];
      for (const [key] of buckets) expect(key).toMatch(BUCKET_KEY);
      const history = JSON.parse(
        run.rows.find(r => r.site === 'practiceHistory.buckets')!.output,
      ) as { buckets: [string, string, number][] };
      for (const [key] of history.buckets) expect(key).toMatch(DAY_KEY);
    }
  });

  test('consistency engine buckets every fixture instant into the device-zone day', () => {
    const snapshot = JSON.parse(
      envRun.rows.find(r => r.site === 'consistencyEngine.snapshot')!.output,
    ) as { days: string[] };
    const asOfMs = Date.parse(FIXED_INSTANTS.asOf);
    const expected = [
      ...new Set(
        CAPTURE_INSTANTS.map(iso => Date.parse(iso))
          .filter(ms => ms <= asOfMs)
          .map(ms => dayKeyIn(ms, processZone)),
      ),
    ].sort();
    // 12 past instants; the ones straddling UTC midnight collapse into one
    // local day east of UTC, so 7..12 distinct days depending on the zone.
    expect(expected.length).toBeGreaterThanOrEqual(7);
    expect(snapshot.days).toEqual(expected);
  });

  test('hermes-ios state: no production site used an option Hermes iOS lacks', () => {
    const hermes = runs.filter(run => run.state === 'hermes-ios-en-region');
    expect(hermes).toHaveLength(AUDIT_LOCALES.length);
    for (const run of hermes) expect(run.shimEvents).toEqual([]);
  });

  test('hermes-ios state: device locale resolves to en-<region> or its ICU fallback, and formatToParts absence broke no site', () => {
    for (const run of runs.filter(r => r.state === 'hermes-ios-en-region')) {
      expect(run.defaultLocale).toMatch(/^en-[A-Z]{2}$/);
      const device = JSON.parse(
        run.rows.find(r => r.site === 'deviceContext.currentLocaleAndTimezone')!
          .output,
      ) as { locale: string; timeZone: string };
      // ICU has no data for e.g. en-FR/en-EG and resolves them to plain
      // `en`; regions with CLDR data (en-IN, en-DE) keep the region. Both
      // are recorded in the JSON artifact; here we only pin the language.
      expect([run.defaultLocale, 'en']).toContain(device.locale);
      expect(device.timeZone).toBe(processZone);
    }
    // The shim restored the API for the rest of this process.
    expect(typeof Intl.NumberFormat.prototype.formatToParts).toBe('function');
  });

  test('icu-full state: deviceContext reports exactly the device locale', () => {
    for (const run of runs.filter(r => r.state === 'icu-full')) {
      const device = JSON.parse(
        run.rows.find(r => r.site === 'deviceContext.currentLocaleAndTimezone')!
          .output,
      ) as { locale: string };
      expect(device.locale).toBe(run.locale);
    }
  });

  test('shimmed runs match the unshimmed process locale when they coincide (cross-check)', () => {
    const twins = runs.filter(run => run.defaultLocale === envLocale);
    for (const twin of twins) {
      for (const row of twin.rows) {
        const truth = envRun.rows.find(r => r.site === row.site)!;
        expect({ site: row.site, output: row.output }).toEqual({
          site: row.site,
          output: truth.output,
        });
      }
    }
    // Under the orchestrator's LANG runs this is ≥ 1; alone it may be 0.
    expect(twins.length).toBeGreaterThanOrEqual(0);
  });

  test('model registry resolve() ordering is locale-independent even though the comparator is not', () => {
    expect(distinctOutputs('modelRegistry.resolve.localeCompare')).toHaveLength(
      1,
    );
    // tr-TR collates dotless ı / dotted i differently from every other
    // audited locale: the comparator is collation-sensitive by design, and
    // only ASCII-digit versions in the manifest keep resolve() stable.
    const byLocale = Object.fromEntries(
      runs
        .filter(r => r.state === 'icu-full')
        .map(r => [
          r.locale,
          rowsFor('localeCompare.numericVersionSort', [r])[0]!.output,
        ]),
    );
    const distinct = [...new Set(Object.values(byLocale))];
    expect(distinct).toHaveLength(2);
    expect(byLocale['tr-TR']).not.toBe(byLocale['de-DE']);
  });
});

describe('reproduced divergences (pinned with test.failing)', () => {
  const anchorMs = Date.parse(`${FIXED_INSTANTS.noonAnchorDay}T12:00:00Z`);
  const shiftedZones: string[] = [
    ...ADVERSARIAL_ZONES,
    ...AUDIT_LOCALES.map(l => l.zone),
  ].filter(zone => dayKeyIn(anchorMs, zone) !== FIXED_INSTANTS.noonAnchorDay);

  test('the T12:00:00Z day anchor is tomorrow everywhere from UTC+12 up (New Zealand, Fiji, Chatham, Apia, Kiritimati)', () => {
    // Documents WHICH zones shift — the pins below depend on this set.
    expect(shiftedZones.sort()).toEqual(
      [
        'Pacific/Auckland',
        'Pacific/Fiji',
        'Pacific/Chatham',
        'Pacific/Apia',
        'Pacific/Kiritimati',
      ].sort(),
    );
  });

  test.failing(
    'StreakCalendarScreen:606 / AchievementsShowcase:130 render the selected day, not the next one, at UTC+12 and beyond',
    () => {
      for (const zone of shiftedZones) {
        const rendered = new Date(anchorMs).toLocaleDateString('en-US', {
          timeZone: zone,
          month: 'short',
          day: 'numeric',
        });
        expect({ zone, rendered }).toEqual({ zone, rendered: 'Sep 4' });
      }
    },
  );

  const anchorRowsShift =
    dayKeyIn(anchorMs, processZone) !== FIXED_INSTANTS.noonAnchorDay;
  (anchorRowsShift ? test.failing : test)(
    `in this process zone (${processZone}) the calendar/achievement day labels name the selected day`,
    () => {
      for (const site of [
        'StreakCalendarScreen.selectedDayTitle',
        'AchievementsShowcase.formatEarnedDay',
      ]) {
        for (const row of rowsFor(
          site,
          runs.filter(r => r.defaultLocale.startsWith('en')),
        )) {
          expect({ site, output: row.output }).toEqual({
            site,
            output: expect.stringMatching(/\b4\b/),
          });
        }
      }
    },
  );

  test('ProgressScreen:144 (local-time anchor) names the selected day in every zone', () => {
    for (const row of rowsFor(
      'ProgressScreen.shortDayLabel',
      runs.filter(r => r.defaultLocale.startsWith('en')),
    )) {
      expect(row.output).toMatch(/\b4\b/);
    }
  });

  const EXPECTED_WALL_CLOCK: Record<string, string> = {
    'ps.reminder.practice': '17:30',
    'ps.reminder.streak': '19:30',
    'ps.reminder.weekly': '18:00',
    'ps.comeback.1': '18:30',
    'ps.comeback.2': '18:30',
    'ps.comeback.3': '18:30',
  };

  // plan.ts anchors on `setHours(0,0,0,0)` then adds minutes: wrong whenever
  // local midnight of the target day does not exist (Santiago spring-forward)
  // or the UTC offset changes between that midnight and the reminder hour.
  function dstAffected(day: string, wall: string): boolean {
    const [hours, minutes] = wall.split(':').map(Number) as [number, number];
    const midnight = new Date(`${day}T09:00:00`);
    midnight.setHours(0, 0, 0, 0);
    const target = new Date(
      midnight.getTime() + (hours * 60 + minutes) * 60_000,
    );
    return (
      midnight.getHours() !== 0 ||
      midnight.getTimezoneOffset() !== target.getTimezoneOffset()
    );
  }

  const dstPlans = FIXED_INSTANTS.dstDays.map(day => {
    const nowMs = Date.parse(`${day}T09:00:00`);
    const plan = buildNotificationPlan(
      { ...DEFAULT_NOTIFICATION_PREFS, enabled: true },
      { nowMs, streakDays: 3, practicedToday: false, hasAnyHistory: true },
    );
    return {
      plannedOn: day,
      items: plan.map(item => ({
        id: item.id,
        day: dayKeyIn(item.timestampMs, processZone),
        wallClock: wallClock(item.timestampMs, processZone),
        expected: EXPECTED_WALL_CLOCK[item.id]!,
      })),
    };
  });
  const affectedItems = dstPlans.flatMap(plan =>
    plan.items.filter(item => dstAffected(item.day, item.expected)),
  );

  (affectedItems.length > 0 ? test.failing : test)(
    `notifications/plan.ts:47 keeps reminders at their wall-clock minute across DST (${processZone}: ${
      affectedItems.map(item => `${item.id}@${item.day}`).join(', ') ||
      'no DST boundary reached'
    })`,
    () => {
      expect(dstPlans.length).toBe(FIXED_INSTANTS.dstDays.length);
      for (const plan of dstPlans) {
        expect(plan.items.map(item => item.id)).toEqual(
          Object.keys(EXPECTED_WALL_CLOCK),
        );
        for (const item of plan.items) {
          expect({ plannedOn: plan.plannedOn, ...item }).toEqual({
            plannedOn: plan.plannedOn,
            ...item,
            wallClock: item.expected,
          });
        }
      }
    },
  );

  test.failing(
    'Progress hard-coded "Sep 4" labels match the region-formatted date style used one screen over',
    () => {
      for (const run of runs.filter(r => r.state === 'hermes-ios-en-region')) {
        const hardCoded = (
          JSON.parse(
            run.rows.find(r => r.site === 'practiceHistory.buckets')!.output,
          ) as { buckets: [string, string, number][] }
        ).buckets.find(([key]) => key === FIXED_INSTANTS.noonAnchorDay)?.[1];
        expect(hardCoded).toBeDefined();
        const regionStyle = run.rows.find(
          r => r.site === 'ProgressScreen.shortDayLabel',
        )!.output;
        expect({ locale: run.defaultLocale, hardCoded }).toEqual({
          locale: run.defaultLocale,
          hardCoded: regionStyle,
        });
      }
    },
  );

  test.failing(
    'notifications/types.ts:114 reminder time follows the region hour cycle like every other time on screen',
    () => {
      for (const run of runs.filter(r => r.state === 'hermes-ios-en-region')) {
        const reminder = (
          JSON.parse(
            run.rows.find(
              r => r.site === 'notificationTypes.formatReminderMinutes',
            )!.output,
          ) as string[]
        )[3];
        const regionStyle = new Date(2026, 8, 4, 17, 30).toLocaleTimeString(
          run.defaultLocale,
          { hour: 'numeric', minute: '2-digit' },
        );
        expect({ locale: run.defaultLocale, reminder }).toEqual({
          locale: run.defaultLocale,
          reminder: regionStyle,
        });
      }
    },
  );

  test.failing(
    'Library/Home month kicker `.toUpperCase()` keeps the dotted İ of Turkish "Nis"/"Eki" (renders NIS/EKI)',
    () => {
      for (const run of runs.filter(r => r.state === 'icu-full')) {
        const mismatches = JSON.parse(
          run.rows.find(
            r => r.site === 'LibraryScreen.monthUpperCase.vsLocaleUpperCase',
          )!.output,
        ) as { rendered: string; localeAware: string }[];
        expect({ locale: run.locale, mismatches }).toEqual({
          locale: run.locale,
          mismatches: [],
        });
      }
    },
  );

  test.failing(
    'DrillLibraryScreen:137 search folds the Turkish capital İ like it folds ASCII case',
    () => {
      expect(distinctOutputs('DrillLibraryScreen.matchesQuery')).toHaveLength(
        1,
      );
      const matched = JSON.parse(
        runs[0]!.rows.find(r => r.site === 'DrillLibraryScreen.matchesQuery')!
          .output,
      ) as Record<string, boolean>;
      expect(matched).toEqual({
        DINK: true,
        Dİnk: true,
        drıve: true,
        Drive: true,
      });
    },
  );

  test('the Turkish month-casing divergence is exactly April and October', () => {
    const tr = runs.find(r => r.state === 'icu-full' && r.locale === 'tr-TR')!;
    const mismatches = JSON.parse(
      tr.rows.find(
        r => r.site === 'LibraryScreen.monthUpperCase.vsLocaleUpperCase',
      )!.output,
    ) as { rendered: string; localeAware: string }[];
    expect(mismatches).toEqual([
      { rendered: 'NIS', localeAware: 'NİS' },
      { rendered: 'EKI', localeAware: 'EKİ' },
    ]);
    for (const run of runs.filter(
      r => r.state === 'icu-full' && r.locale !== 'tr-TR',
    )) {
      expect(
        run.rows.find(
          r => r.site === 'LibraryScreen.monthUpperCase.vsLocaleUpperCase',
        )!.output,
      ).toBe('[]');
    }
  });
});
