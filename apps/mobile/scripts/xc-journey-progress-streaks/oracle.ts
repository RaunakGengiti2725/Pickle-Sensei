/**
 * Deterministic oracle helpers for the cross-cutting `journey-progress-streaks`
 * adversarial harness (apps/mobile/__tests__/xc/journeyProgressStreaks.*).
 *
 * Everything here is INDEPENDENT of the production engine: instants are built
 * from wall-clock components through `Intl` offset resolution (not through the
 * engine's day formatter), and streak expectations are derived from the
 * documented rules over plain calendar-day strings. The harness then asserts
 * the production code (`consistency/engine.ts`, `progress/practiceHistory.ts`,
 * `screens/StreakCalendarScreen.tsx`, `notifications/plan.ts`) agrees.
 *
 * No production code is imported here so the oracle can never be "right by
 * construction" through the code under test.
 */

declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  version: string;
};

const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (dir: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

/** Node process env / version, typed locally (the mobile tsconfig has no
 * node types; this mirrors the `declare const` pattern of existing tests). */
export const nodeEnv: Record<string, string | undefined> = process.env;
export const nodeVersion: string = process.version;

export const DAY_MS = 86_400_000;

/** IANA zones spanning UTC-12 … UTC+14, both DST hemispheres, 30/45-minute
 * offsets, and zones whose DST shift happens exactly at midnight. */
export const ZONES = [
  'Etc/GMT+12', // UTC-12 fixed
  'Pacific/Pago_Pago', // UTC-11 fixed
  'Pacific/Honolulu', // UTC-10 fixed
  'America/Anchorage', // UTC-9/-8, northern DST
  'America/Los_Angeles', // UTC-8/-7, northern DST
  'America/Denver', // UTC-7/-6, northern DST
  'America/New_York', // UTC-5/-4, northern DST
  'America/St_Johns', // UTC-3:30/-2:30, half-hour DST
  'America/Santiago', // UTC-4/-3, southern DST, shift at 24:00
  'America/Asuncion', // UTC-4/-3, southern DST, shift at 00:00
  'UTC',
  'Europe/London', // UTC+0/+1
  'Europe/Berlin', // UTC+1/+2
  'Asia/Tehran', // UTC+3:30 fixed since 2022
  'Asia/Kolkata', // UTC+5:30 fixed
  'Asia/Kathmandu', // UTC+5:45 fixed
  'Asia/Tokyo', // UTC+9 fixed
  'Australia/Lord_Howe', // UTC+10:30/+11, 30-minute DST
  'Australia/Sydney', // UTC+10/+11, southern DST
  'Pacific/Auckland', // UTC+12/+13, southern DST
  'Pacific/Chatham', // UTC+12:45/+13:45
  'Pacific/Apia', // UTC+13 fixed
  'Pacific/Kiritimati', // UTC+14 fixed
] as const;

export type Zone = (typeof ZONES)[number];

/** Zones with a DST transition in 2026 (used to pick transition days). */
export const DST_ZONES: readonly Zone[] = [
  'America/Anchorage',
  'America/Los_Angeles',
  'America/Denver',
  'America/New_York',
  'America/St_Johns',
  'America/Santiago',
  'America/Asuncion',
  'Europe/London',
  'Europe/Berlin',
  'Australia/Lord_Howe',
  'Australia/Sydney',
  'Pacific/Auckland',
  'Pacific/Chatham',
];

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) — every failure records the seed that produced it.
// ---------------------------------------------------------------------------

export interface Rng {
  next(): number;
  int(minInclusive: number, maxInclusive: number): number;
  pick<T>(items: readonly T[]): T;
  chance(probability: number): boolean;
}

export function makeRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(minInclusive, maxInclusive) {
      return (
        minInclusive + Math.floor(next() * (maxInclusive - minInclusive + 1))
      );
    },
    pick(items) {
      const item = items[Math.floor(next() * items.length)];
      if (item === undefined) throw new Error('pick from empty list');
      return item;
    },
    chance(probability) {
      return next() < probability;
    },
  };
}

// ---------------------------------------------------------------------------
// Wall-clock <-> instant conversion through Intl (independent of the engine).
// ---------------------------------------------------------------------------

export interface WallClock {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
  millisecond: number;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = partsFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatters.set(zone, formatter);
  }
  return formatter;
}

/** Wall clock of an instant in `zone`, via Intl parts (h23, Gregorian). */
export function wallClockOf(ms: number, zone: string): WallClock {
  const parts = partsFormatter(zone).formatToParts(new Date(ms));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find(candidate => candidate.type === type);
    if (!part) throw new Error(`missing ${type} part for ${zone}`);
    return Number(part.value);
  };
  const date = new Date(ms);
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    // Some ICU builds render midnight as "24" with hourCycle h23 quirks.
    hour: read('hour') % 24,
    minute: read('minute'),
    second: read('second'),
    millisecond: date.getUTCMilliseconds(),
  };
}

/** `YYYY-MM-DD` for the wall clock of `ms` in `zone`. */
export function localDayOf(ms: number, zone: string): string {
  const wc = wallClockOf(ms, zone);
  return dayKey(wc.year, wc.month, wc.day);
}

export function dayKey(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** UTC offset (ms) of `zone` at instant `ms`. */
export function offsetAt(ms: number, zone: string): number {
  const wc = wallClockOf(ms, zone);
  const asUtc = Date.UTC(
    wc.year,
    wc.month - 1,
    wc.day,
    wc.hour,
    wc.minute,
    wc.second,
  );
  return asUtc - Math.floor(ms / 1000) * 1000;
}

export type WallClockResolution =
  | { kind: 'unique'; instants: [number] }
  | { kind: 'ambiguous'; instants: [number, number] }
  | { kind: 'gap'; instants: [] };

/**
 * Every instant whose wall clock in `zone` equals `wc`. Two for a fall-back
 * overlap, none inside a spring-forward gap, otherwise exactly one.
 */
export function resolveWallClock(
  wc: WallClock,
  zone: string,
): WallClockResolution {
  const guess = Date.UTC(
    wc.year,
    wc.month - 1,
    wc.day,
    wc.hour,
    wc.minute,
    wc.second,
    wc.millisecond,
  );
  const offsets = new Set<number>();
  for (const probe of [guess - DAY_MS, guess, guess + DAY_MS]) {
    offsets.add(offsetAt(probe, zone));
  }
  const matches: number[] = [];
  for (const offset of offsets) {
    const candidate = guess - offset;
    const back = wallClockOf(candidate, zone);
    if (
      back.year === wc.year &&
      back.month === wc.month &&
      back.day === wc.day &&
      back.hour === wc.hour &&
      back.minute === wc.minute &&
      back.second === wc.second &&
      back.millisecond === wc.millisecond
    ) {
      matches.push(candidate);
    }
  }
  matches.sort((a, b) => a - b);
  if (matches.length === 0) return { kind: 'gap', instants: [] };
  if (matches.length === 1) return { kind: 'unique', instants: [matches[0]!] };
  return { kind: 'ambiguous', instants: [matches[0]!, matches[1]!] };
}

/** Local `day` (YYYY-MM-DD) at `hour:minute:second.ms` in `zone`. */
export function wallClock(
  day: string,
  hour: number,
  minute = 0,
  second = 0,
  millisecond = 0,
): WallClock {
  const [y, m, d] = day.split('-').map(Number);
  return {
    year: y!,
    month: m!,
    day: d!,
    hour,
    minute,
    second,
    millisecond,
  };
}

/** Calendar arithmetic on YYYY-MM-DD keys through UTC (proleptic Gregorian). */
export function addDaysToKey(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const ms = Date.UTC(y!, m! - 1, d! + delta);
  const date = new Date(ms);
  return dayKey(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
  );
}

export function dayDiff(later: string, earlier: string): number {
  const [ly, lm, ld] = later.split('-').map(Number);
  const [ey, em, ed] = earlier.split('-').map(Number);
  return Math.round(
    (Date.UTC(ly!, lm! - 1, ld!) - Date.UTC(ey!, em! - 1, ed!)) / DAY_MS,
  );
}

/** Instants (UTC ms) at which the zone's UTC offset changes during `year`. */
export function transitionsIn(zone: string, year: number): number[] {
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  const transitions: number[] = [];
  let previous = offsetAt(start, zone);
  for (let probe = start + 3_600_000; probe <= end; probe += 3_600_000) {
    const current = offsetAt(probe, zone);
    if (current !== previous) {
      // Binary search the exact second inside the last hour.
      let lo = probe - 3_600_000;
      let hi = probe;
      while (hi - lo > 1000) {
        const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
        if (offsetAt(mid, zone) === previous) lo = mid;
        else hi = mid;
      }
      transitions.push(hi);
      previous = current;
    }
  }
  return transitions;
}

// ---------------------------------------------------------------------------
// Reference streak rules over plain day keys.
// ---------------------------------------------------------------------------

export interface ReferenceConsistency {
  currentStreak: number;
  longestStreak: number;
  totalTrainedDays: number;
  trainedToday: boolean;
  atRisk: boolean;
  shieldsAvailable: number;
  shieldedDayCount: number;
  shieldedDays: string[];
  trainedLast7: number;
}

/**
 * Documented consistency rules (engine.ts header + milestones.ts): a run
 * grows on each trained day; every `shieldEvery` consecutive trained days
 * bank a shield (max `shieldMax` held); an untrained past day spends a shield
 * if one is banked, otherwise resets the run; today is never a miss.
 */
export function referenceConsistency(
  trainedDays: ReadonlySet<string>,
  asOfDay: string,
  rules: { shieldEvery: number; shieldMax: number },
): ReferenceConsistency {
  const sorted = [...trainedDays].filter(d => d <= asOfDay).sort();
  const first = sorted[0];
  const result: ReferenceConsistency = {
    currentStreak: 0,
    longestStreak: 0,
    totalTrainedDays: 0,
    trainedToday: false,
    atRisk: false,
    shieldsAvailable: 0,
    shieldedDayCount: 0,
    shieldedDays: [],
    trainedLast7: 0,
  };
  if (!first) return result;
  let run = 0;
  let shields = 0;
  for (let day = first; day <= asOfDay; day = addDaysToKey(day, 1)) {
    if (trainedDays.has(day)) {
      run += 1;
      result.totalTrainedDays += 1;
      result.longestStreak = Math.max(result.longestStreak, run);
      if (run % rules.shieldEvery === 0) {
        shields = Math.min(shields + 1, rules.shieldMax);
      }
      continue;
    }
    if (day === asOfDay) break;
    if (run === 0) continue;
    if (shields > 0) {
      shields -= 1;
      result.shieldedDayCount += 1;
      result.shieldedDays.push(day);
    } else {
      run = 0;
    }
  }
  result.currentStreak = run;
  result.shieldsAvailable = shields;
  result.trainedToday = trainedDays.has(asOfDay);
  result.atRisk = run > 0 && !result.trainedToday;
  for (let back = 0; back < 7; back += 1) {
    if (trainedDays.has(addDaysToKey(asOfDay, -back))) result.trainedLast7 += 1;
  }
  return result;
}

export interface ReferencePracticeStreak {
  currentDays: number;
  longestDays: number;
  practicedToday: boolean;
  lastPracticeDay: string | null;
}

/**
 * Verified-practice streak (practiceHistory.ts / server progress): longest
 * run of consecutive active days; the current run counts only when the latest
 * active day is today or yesterday.
 */
export function referencePracticeStreak(
  activeDays: ReadonlySet<string>,
  asOfDay: string,
): ReferencePracticeStreak {
  const sorted = [...activeDays].filter(d => d <= asOfDay).sort();
  if (sorted.length === 0) {
    return {
      currentDays: 0,
      longestDays: 0,
      practicedToday: false,
      lastPracticeDay: null,
    };
  }
  let longest = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i += 1) {
    run = dayDiff(sorted[i]!, sorted[i - 1]!) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  const latest = sorted[sorted.length - 1]!;
  let current = 0;
  if (dayDiff(asOfDay, latest) <= 1) {
    current = 1;
    for (let i = sorted.length - 2; i >= 0; i -= 1) {
      if (dayDiff(sorted[i + 1]!, sorted[i]!) !== 1) break;
      current += 1;
    }
  }
  return {
    currentDays: current,
    longestDays: longest,
    practicedToday: latest === asOfDay,
    lastPracticeDay: latest,
  };
}

// ---------------------------------------------------------------------------
// Artifact output — raw JSON tables land under artifacts/ (git-ignored).
// ---------------------------------------------------------------------------

export function artifactDir(): string {
  const dir =
    process.env.XC_ARTIFACT_DIR ??
    join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'artifacts',
      'xc-journey-progress-streaks',
    );
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeArtifact(name: string, value: unknown): string {
  const path = join(artifactDir(), name);
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
  return path;
}

export function processZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
