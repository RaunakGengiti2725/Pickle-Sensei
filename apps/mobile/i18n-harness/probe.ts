import { DEFAULT_MODEL_MANIFEST, ModelRegistry } from '@pickle/model-registry';
import { buildConsistencySnapshot } from '../src/consistency/engine';
import { streakDefenseCopy } from '../src/notifications/copy';
import { buildNotificationPlan } from '../src/notifications/plan';
import {
  DEFAULT_NOTIFICATION_PREFS,
  formatReminderMinutes,
} from '../src/notifications/types';
import { sessionDayLabel } from '../src/progress/gameplayProgression';
import { buildPracticeHistory } from '../src/progress/practiceHistory';
import {
  buildTechniqueDashboard,
  formatSignedDelta,
} from '../src/progress/techniqueDashboard';
import { percent } from '../src/screens/ProgressScreen';
import { analysisFacts, pendingCaptures, trainingActivities } from './fixtures';
import {
  FIXED_INSTANTS,
  type LocaleUnderTest,
  type RuntimeState,
  defaultLocaleForState,
} from './matrix';
import { type ShimEvent, withRuntimeState } from './runtimeState';

declare const process: {
  version: string;
  versions: Record<string, string | undefined>;
};

/**
 * One probe run = every locale-sensitive site in apps/mobile evaluated once
 * under (runtime state, default locale, process time zone). `production`
 * rows call the shipped module; `replica` rows re-run inline JSX expressions
 * verbatim (they cannot be imported without rendering the screen) and cite
 * the exact lines they copy so a reviewer can diff them against source.
 */

export interface ProbeRow {
  site: string;
  kind: 'production' | 'replica';
  file: string;
  input: string;
  output: string;
  /** Does this output change with the device locale/zone by design? */
  expectation: 'locale-invariant' | 'zone-derived' | 'locale-formatted';
}

export interface ProbeRun {
  state: RuntimeState;
  locale: string;
  defaultLocale: string;
  processZone: string;
  node: string;
  icu: string;
  rows: ProbeRow[];
  shimEvents: ShimEvent[];
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

/** Wall-clock `HH:mm` of an instant in `zone`, via an explicit-locale
 * formatter so the reading itself is locale-independent. */
export function wallClock(ms: number, zone: string): string {
  return new Intl.DateTimeFormat('en-US-u-hc-h23', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ms));
}

/** `YYYY-MM-DD` of an instant in `zone` (same technique the app's
 * consistency engine uses for its machine day keys). */
export function dayKeyIn(ms: number, zone: string): string {
  const parts: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms))) {
    if (part.type === 'year' || part.type === 'month' || part.type === 'day') {
      parts[part.type] = part.value;
    }
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function collectRows(processZone: string, deviceLocale: string): ProbeRow[] {
  const rows: ProbeRow[] = [];
  const push = (row: ProbeRow) => rows.push(row);
  const asOfMs = Date.parse(FIXED_INSTANTS.asOf);

  // --- deviceContext.ts:16 — what the app sends the server at bootstrap.
  const resolved = Intl.DateTimeFormat().resolvedOptions();
  push({
    site: 'deviceContext.currentLocaleAndTimezone',
    kind: 'replica',
    file: 'apps/mobile/src/account/deviceContext.ts:16-24',
    input: 'Intl.DateTimeFormat().resolvedOptions()',
    output: json({ locale: resolved.locale, timeZone: resolved.timeZone }),
    expectation: 'locale-formatted',
  });
  const deviceZone = resolved.timeZone;

  // --- progress/techniqueDashboard.ts (production; device-zone day keys,
  // hard-coded English month labels).
  const dashboard = buildTechniqueDashboard(analysisFacts(), {
    asOfIso: FIXED_INSTANTS.asOf,
    timeZone: deviceZone,
    range: '28d',
  });
  push({
    site: 'techniqueDashboard.buckets.label',
    kind: 'production',
    file: 'apps/mobile/src/progress/techniqueDashboard.ts:419-426',
    input: json({ asOf: FIXED_INSTANTS.asOf, range: '28d', facts: 14 }),
    output: json(dashboard.buckets.map(bucket => [bucket.key, bucket.label])),
    expectation: 'zone-derived',
  });
  push({
    site: 'techniqueDashboard.personalBest.day',
    kind: 'production',
    file: 'apps/mobile/src/progress/techniqueDashboard.ts:68-76',
    input: json({ asOf: FIXED_INSTANTS.asOf }),
    output: json(dashboard.personalBest),
    expectation: 'zone-derived',
  });
  push({
    site: 'techniqueDashboard.stats',
    kind: 'production',
    file: 'apps/mobile/src/progress/techniqueDashboard.ts:86-100',
    input: json({ asOf: FIXED_INSTANTS.asOf }),
    output: json({
      scoredReps: dashboard.scoredReps,
      scoredDays: dashboard.scoredDays,
      avgScore: dashboard.avgScore,
      bestScore: dashboard.bestScore,
      insight: dashboard.insight,
    }),
    expectation: 'zone-derived',
  });
  push({
    site: 'techniqueDashboard.formatSignedDelta',
    kind: 'production',
    file: 'apps/mobile/src/progress/techniqueDashboard.ts:109-112',
    input: json([1.25, -0.04, -2.5, 0, 1234.5]),
    output: json([1.25, -0.04, -2.5, 0, 1234.5].map(v => formatSignedDelta(v))),
    expectation: 'locale-invariant',
  });

  // --- consistency/engine.ts (production; explicit en-US day-key formatter).
  const snapshot = buildConsistencySnapshot(trainingActivities(), {
    asOfIso: FIXED_INSTANTS.asOf,
    timeZone: deviceZone,
  });
  push({
    site: 'consistencyEngine.snapshot',
    kind: 'production',
    file: 'apps/mobile/src/consistency/engine.ts:makeDayFormatter',
    input: json({ asOf: FIXED_INSTANTS.asOf, activities: 14 }),
    output: json({
      asOfDay: snapshot.asOfDay,
      days: Object.keys(snapshot.days).sort(),
      currentStreak: snapshot.currentStreak,
      longestStreak: snapshot.longestStreak,
      trainedToday: snapshot.trainedToday,
      momentumXp: snapshot.momentumXp,
      earned: snapshot.earned.map(e => [e.id, e.earnedOnDay]),
    }),
    expectation: 'zone-derived',
  });

  // --- progress/practiceHistory.ts (production).
  const history = buildPracticeHistory(pendingCaptures(), {
    asOfIso: FIXED_INSTANTS.asOf,
    timeZone: deviceZone,
    range: '28d',
  });
  push({
    site: 'practiceHistory.buckets',
    kind: 'production',
    file: 'apps/mobile/src/progress/practiceHistory.ts:585-591',
    input: json({ asOf: FIXED_INSTANTS.asOf, range: '28d', captures: 14 }),
    output: json({
      buckets: history.buckets.map(b => [b.key, b.label, b.count]),
      activeDays: history.activeDays,
      currentStreak: history.currentStreak,
      longestStreak: history.longestStreak,
    }),
    expectation: 'zone-derived',
  });

  // --- progress/gameplayProgression.ts sessionDayLabel (production; Date
  // local getters, English months).
  push({
    site: 'gameplayProgression.sessionDayLabel',
    kind: 'production',
    file: 'apps/mobile/src/progress/gameplayProgression.ts:122-141',
    input: json([
      FIXED_INSTANTS.lateEvening,
      FIXED_INSTANTS.justAfterUtcMidnight,
    ]),
    output: json([
      sessionDayLabel(FIXED_INSTANTS.lateEvening),
      sessionDayLabel(FIXED_INSTANTS.justAfterUtcMidnight),
    ]),
    expectation: 'zone-derived',
  });

  // --- notifications/plan.ts (production; local Date arithmetic). Planned
  // at 09:00 local on each DST day so the same-day reminders are in range.
  for (const day of FIXED_INSTANTS.dstDays) {
    const nowMs = Date.parse(`${day}T09:00:00`);
    const plan = buildNotificationPlan(
      { ...DEFAULT_NOTIFICATION_PREFS, enabled: true },
      {
        nowMs,
        streakDays: 4,
        practicedToday: false,
        hasAnyHistory: true,
        shieldsAvailable: 1,
        milestoneEve: { title: 'Week One', days: 7 },
      },
    );
    push({
      site: `notificationPlan.localWallClock.${day}`,
      kind: 'production',
      file: 'apps/mobile/src/notifications/plan.ts:47-77',
      input: json({ nowLocal: `${day}T09:00:00`, nowMs }),
      output: json(
        plan.map(item => ({
          id: item.id,
          iso: new Date(item.timestampMs).toISOString(),
          local: `${dayKeyIn(item.timestampMs, processZone)} ${wallClock(
            item.timestampMs,
            processZone,
          )}`,
        })),
      ),
      expectation: 'zone-derived',
    });
  }
  push({
    site: 'notificationCopy.streakDefense',
    kind: 'production',
    file: 'apps/mobile/src/notifications/copy.ts:100-130',
    input: json({ streakDays: 12, shieldsAvailable: 2 }),
    output: json(
      streakDefenseCopy(asOfMs, {
        streakDays: 12,
        shieldsAvailable: 2,
        milestoneEve: null,
      }),
    ),
    expectation: 'locale-invariant',
  });
  push({
    site: 'notificationTypes.formatReminderMinutes',
    kind: 'production',
    file: 'apps/mobile/src/notifications/types.ts:114-123',
    input: json([0, 5 * 60 + 30, 12 * 60, 17 * 60 + 30, 23 * 60 + 59]),
    output: json(
      [0, 5 * 60 + 30, 12 * 60, 17 * 60 + 30, 23 * 60 + 59].map(
        formatReminderMinutes,
      ),
    ),
    expectation: 'locale-invariant',
  });

  // --- screens/ProgressScreen.tsx percent() (production export).
  push({
    site: 'ProgressScreen.percent',
    kind: 'production',
    file: 'apps/mobile/src/screens/ProgressScreen.tsx:152-157',
    input: json([0.756, 0.005, 1.2, null]),
    output: json([0.756, 0.005, 1.2, null].map(percent)),
    expectation: 'locale-invariant',
  });

  // --- @pickle/model-registry resolve() version ordering via localeCompare
  // with the DEFAULT locale (production).
  const registry = new ModelRegistry(DEFAULT_MODEL_MANIFEST);
  const resolvedPose = registry.resolve({
    task: 'pose_estimation',
    platform: 'ios',
  });
  const resolvedStroke = registry.resolve({
    task: 'stroke_classification',
    platform: 'ios',
  });
  push({
    site: 'modelRegistry.resolve.localeCompare',
    kind: 'production',
    file: 'packages/model-registry/src/registry.ts:125',
    input: json({
      platform: 'ios',
      tasks: ['pose_estimation', 'stroke_classification'],
    }),
    output: json([
      resolvedPose && `${resolvedPose.id}@${resolvedPose.version}`,
      resolvedStroke && `${resolvedStroke.id}@${resolvedStroke.version}`,
    ]),
    expectation: 'locale-invariant',
  });
  // Adversarial replica of the same comparator with Turkish dotless/dotted i:
  // shows the comparator IS collation-dependent; production versions are
  // ASCII digits so `modelRegistry.resolve.localeCompare` above must not move.
  push({
    site: 'localeCompare.numericVersionSort',
    kind: 'replica',
    file: 'packages/model-registry/src/registry.ts:125',
    input: json(['v10', 'v9', 'i1', 'I2', 'ı3', 'v1.10', 'v1.9']),
    output: json(
      ['v10', 'v9', 'i1', 'I2', 'ı3', 'v1.10', 'v1.9'].sort((a, b) =>
        b.localeCompare(a, undefined, { numeric: true }),
      ),
    ),
    expectation: 'locale-formatted',
  });

  // --- Inline JSX replicas (default locale, default zone).
  const late = new Date(FIXED_INSTANTS.lateEvening);
  const early = new Date(FIXED_INSTANTS.justAfterUtcMidnight);
  push({
    site: 'LibraryScreen.captureRowMeta',
    kind: 'replica',
    file: 'apps/mobile/src/screens/LibraryScreen.tsx:493-496',
    input: json({
      durationMs: 3_400,
      capturedAtIso: FIXED_INSTANTS.lateEvening,
    }),
    output: `${Math.round(3_400 / 1000)}s clip · ${late.toLocaleDateString()}`,
    expectation: 'locale-formatted',
  });
  push({
    site: 'LibraryScreen.dateBlock',
    kind: 'replica',
    file: 'apps/mobile/src/screens/LibraryScreen.tsx:541-547',
    input: json({ capturedAt: FIXED_INSTANTS.lateEvening }),
    output: json({
      month: late
        .toLocaleDateString(undefined, { month: 'short' })
        .toUpperCase(),
      day: late.getDate(),
      time: late.toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      }),
    }),
    expectation: 'locale-formatted',
  });
  // Same `.toUpperCase()` over every month of the year, against the
  // device-locale casing: Turkish/Azeri dotted İ is lost by the
  // locale-blind upper-caser ("Eki" → "EKI", should be "EKİ"). The
  // device locale is passed explicitly because V8's zero-argument
  // `toLocaleUpperCase()` ignores the process default locale for the
  // Turkish special-casing (verified: LANG=tr_TR node → "NIS").
  const monthCasing = Array.from({ length: 12 }, (_, month) => {
    const label = new Date(Date.UTC(2026, month, 15, 12)).toLocaleDateString(
      undefined,
      { month: 'short' },
    );
    return [
      label.toUpperCase(),
      label.toLocaleUpperCase(deviceLocale),
    ] as const;
  });
  push({
    site: 'LibraryScreen.monthUpperCase.vsLocaleUpperCase',
    kind: 'replica',
    file: 'apps/mobile/src/screens/LibraryScreen.tsx:541-543, apps/mobile/src/screens/HomeScreen.tsx:579-584',
    input: json({ months: 12, day: 15 }),
    output: json(
      monthCasing
        .filter(([blind, aware]) => blind !== aware)
        .map(([blind, aware]) => ({ rendered: blind, localeAware: aware })),
    ),
    expectation: 'locale-formatted',
  });
  push({
    site: 'HomeScreen.recentShotDate',
    kind: 'replica',
    file: 'apps/mobile/src/screens/HomeScreen.tsx:579-590',
    input: json({ capturedAt: FIXED_INSTANTS.lateEvening }),
    output: json({
      date: late
        .toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        .toUpperCase(),
      time: late.toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      }),
    }),
    expectation: 'locale-formatted',
  });
  push({
    site: 'ProgressScreen.captureDate',
    kind: 'replica',
    file: 'apps/mobile/src/screens/ProgressScreen.tsx:766-774',
    input: json({ capturedAtIso: FIXED_INSTANTS.justAfterUtcMidnight }),
    output: early.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }),
    expectation: 'locale-formatted',
  });
  push({
    site: 'ProgressScreen.shortDayLabel',
    kind: 'replica',
    file: 'apps/mobile/src/screens/ProgressScreen.tsx:143-150',
    input: json({ day: FIXED_INSTANTS.noonAnchorDay }),
    output: new Date(
      `${FIXED_INSTANTS.noonAnchorDay}T12:00:00`,
    ).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    expectation: 'locale-formatted',
  });
  push({
    site: 'StreakCalendarScreen.selectedDayTitle',
    kind: 'replica',
    file: 'apps/mobile/src/screens/StreakCalendarScreen.tsx:606-609',
    input: json({ selectedDay: FIXED_INSTANTS.noonAnchorDay }),
    output: new Date(
      `${FIXED_INSTANTS.noonAnchorDay}T12:00:00Z`,
    ).toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    }),
    expectation: 'locale-formatted',
  });
  push({
    site: 'StreakCalendarScreen.activityTime',
    kind: 'replica',
    file: 'apps/mobile/src/screens/StreakCalendarScreen.tsx:665-668',
    input: json({ atIso: FIXED_INSTANTS.justAfterUtcMidnight }),
    output: early.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    }),
    expectation: 'locale-formatted',
  });
  push({
    site: 'AchievementsShowcase.formatEarnedDay',
    kind: 'replica',
    file: 'apps/mobile/src/consistency/AchievementsShowcase.tsx:129-135',
    input: json({ day: FIXED_INSTANTS.noonAnchorDay }),
    output: new Date(
      `${FIXED_INSTANTS.noonAnchorDay}T12:00:00Z`,
    ).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    expectation: 'locale-formatted',
  });
  // Monday-first weekday strip and English month names vs what Intl says the
  // locale's week starts on.
  const weekInfo = localeWeekInfo();
  push({
    site: 'StreakCalendarScreen.weekdayStrip',
    kind: 'replica',
    file: 'apps/mobile/src/screens/StreakCalendarScreen.tsx:50-63',
    input: json({ hardCoded: ['M', 'T', 'W', 'T', 'F', 'S', 'S'] }),
    output: json({
      hardCodedFirstDay: 'monday',
      localeFirstDay: weekInfo,
      localeMonthLong: new Date(
        `${FIXED_INSTANTS.noonAnchorDay}T12:00:00`,
      ).toLocaleDateString(undefined, { month: 'long' }),
      hardCodedMonthLong: 'September',
    }),
    expectation: 'locale-formatted',
  });
  push({
    site: 'ProgressScreen.formatTrackedTime',
    kind: 'replica',
    file: 'apps/mobile/src/screens/ProgressScreen.tsx:133-139',
    input: json([4_560, 42_400, 125_000]),
    output: json([4_560, 42_400, 125_000].map(formatTrackedTimeReplica)),
    expectation: 'locale-invariant',
  });
  push({
    site: 'PaywallScreen.savingsLabel',
    kind: 'replica',
    file: 'apps/mobile/src/screens/PaywallScreen.tsx:68-75',
    input: json({ monthly: 7.99, annual: 59.99 }),
    output: `SAVE ${Math.round(((7.99 * 12 - 59.99) / (7.99 * 12)) * 100)}%`,
    expectation: 'locale-invariant',
  });
  // DrillLibraryScreen's local search folds case with the locale-blind
  // `toLowerCase()`, so a query typed with the Turkish capital İ (shift-I on
  // a Turkish keyboard) never reaches the ASCII "dink" catalog text.
  const matchesQueryReplica = (haystack: string, query: string): boolean => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return haystack.toLowerCase().includes(needle);
  };
  push({
    site: 'DrillLibraryScreen.matchesQuery',
    kind: 'replica',
    file: 'apps/mobile/src/screens/DrillLibraryScreen.tsx:137-144',
    input: json(['DINK', 'Dİnk', 'drıve', 'Drive']),
    output: json(
      Object.fromEntries(
        ['DINK', 'Dİnk', 'drıve', 'Drive'].map(q => [
          q,
          matchesQueryReplica('Wall dink rally Drive and dink targets', q),
        ]),
      ),
    ),
    expectation: 'locale-invariant',
  });
  push({
    site: 'Number.toFixed.default',
    kind: 'replica',
    file: 'apps/mobile/src/screens/HomeScreen.tsx:608',
    input: json([7.25, 1234.5, 0.05]),
    output: json([7.25, 1234.5, 0.05].map(v => v.toFixed(1))),
    expectation: 'locale-invariant',
  });

  return rows;
}

function formatTrackedTimeReplica(milliseconds: number): string {
  const seconds = milliseconds / 1_000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60);
  return `${minutes}m ${remaining}s`;
}

interface LocaleWithWeekInfo {
  getWeekInfo?: () => { firstDay: number };
  weekInfo?: { firstDay: number };
}

/** ISO weekday (1 = Monday … 7 = Sunday) the default locale starts its week
 * on, or 'unavailable' when the engine lacks Intl.Locale week info. */
function localeWeekInfo(): number | 'unavailable' {
  const tag = Intl.DateTimeFormat().resolvedOptions().locale;
  const locale = new Intl.Locale(tag) as unknown as LocaleWithWeekInfo;
  const info = locale.getWeekInfo?.() ?? locale.weekInfo;
  return info ? info.firstDay : 'unavailable';
}

export function runProbe(
  state: RuntimeState,
  locale: LocaleUnderTest,
): ProbeRun {
  const defaultLocale = defaultLocaleForState(state, locale);
  const processZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const icu = process.versions.icu ?? 'unknown';
  return withRuntimeState(state, defaultLocale, events => ({
    state,
    locale: locale.tag,
    defaultLocale,
    processZone,
    node: process.version,
    icu,
    rows: collectRows(processZone, defaultLocale),
    shimEvents: [...events],
  }));
}
