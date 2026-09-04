/**
 * STRESS — consistency engine, lens: boundary / malformed input.
 *
 * `buildConsistencySnapshot` is replayed from raw activity facts that come
 * out of SQLite (`String(...)` / `Number(...)` casts) and the drill ledger
 * (any string survives the parser). A corrupt row must never make the
 * pure engine throw, emit a non-finite number, fabricate or ERASE a streak,
 * or disagree with itself between two orderings of the same facts.
 *
 * Three campaigns:
 *   1. `boundary`  — hostile field CONTENT at the production boundary: every
 *      string field is `String(x)` and every score `Number(x)` exactly as
 *      repository.ts / store.ts coerce SQLite rows, so every case here is
 *      reachable from persisted data. Garbage time zones and asOf instants
 *      (clock jumps) ride along.
 *   2. `raw-types` — the same corruptions WITHOUT coercion (wrong JS types
 *      straight into the typed engine). Not reachable today; documents the
 *      engine's own contract.
 *   3. `reference` — well-formed seeded histories cross-checked against a
 *      deliberately independent model of the streak economy (day bucketing
 *      via a different Intl path, shields, XP, milestones).
 *
 * Seeded (mulberry32): every iteration is replayable from its seed.
 *   STRESS_ITER=<n>   iterations per campaign (default 200, CI-fast)
 *   STRESS_OUT=<dir>  write the seed → outcome table as JSON
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  buildConsistencySnapshot,
  dayOrdinal,
  type ConsistencySnapshot,
  type TrainingActivityInput,
} from '../../src/consistency/engine';
import {
  SHIELD_EARN_EVERY_DAYS,
  SHIELD_MAX_HELD,
  STREAK_MILESTONES,
  XP_EXTRA_ACTIVITY_CAP,
  XP_PER_EXTRA_ACTIVITY,
  XP_PER_TRAINED_DAY,
} from '../../src/consistency/milestones';

const ITER = Math.max(1, Number(process.env['STRESS_ITER'] ?? 200));
const OUT_DIR = process.env['STRESS_OUT'];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}
function int(rng: () => number, max: number): number {
  return Math.floor(rng() * max);
}
function shuffled<T>(rng: () => number, items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = int(rng, i + 1);
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

interface Row {
  seed: number;
  campaign: string;
  activities: number;
  timeZone: string;
  asOfIso: string;
  outcome: 'HELD' | 'BROKEN';
  detail?: string;
  /** Smallest activity subset (same options) that still reproduces `detail`. */
  minimized?: unknown[];
  /** Failures across 10 identical re-runs of the minimized case. */
  rerunFailures?: number;
}
const table: Row[] = [];
afterAll(() => {
  if (!OUT_DIR) return;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, 'engine-boundary.json'),
    JSON.stringify(
      {
        campaign: 'consistency-engine-boundary',
        iterations: table.length,
        broken: table.filter(r => r.outcome === 'BROKEN').length,
        rows: table,
      },
      null,
      1,
    ),
  );
});

// ─── Atoms ─────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const BIG = 'x'.repeat(70_000);
const AS_OF_VALID = '2026-03-20T18:30:00.000Z';
const AS_OF_MS = Date.parse(AS_OF_VALID);
/** "Now" instants straddling DST transitions in both hemispheres. */
const AS_OF_DST = [
  AS_OF_VALID,
  '2026-03-08T09:59:59.000Z', // US spring-forward (02:00 PST)
  '2026-03-08T10:00:00.000Z',
  '2026-03-29T00:59:59.000Z', // EU spring-forward
  '2026-04-04T13:59:59.000Z', // NZ / Lord Howe fall-back
  '2026-04-05T14:00:00.000Z',
  '2026-10-25T00:59:59.000Z', // EU fall-back
  '2026-11-01T08:59:59.000Z', // US fall-back (01:59:59 PDT)
  '2026-11-01T09:00:00.000Z',
  '2026-12-31T23:59:59.999Z',
  '2027-01-01T00:00:00.000Z',
  '2028-02-29T12:00:00.000Z', // leap day
] as const;

const VALID_ZONES = [
  'UTC',
  'America/Los_Angeles',
  'America/New_York',
  'America/St_Johns',
  'Europe/London',
  'Asia/Kolkata',
  'Asia/Kathmandu',
  'Australia/Lord_Howe',
  'Pacific/Auckland',
  'Pacific/Kiritimati',
  'Pacific/Apia',
  'Pacific/Pago_Pago',
  'Etc/GMT+12',
  'Etc/GMT-14',
] as const;
const HOSTILE_ZONES = [
  '',
  ' ',
  'UTC ',
  ' UTC',
  'utc',
  'america/los_angeles',
  'Mars/Olympus_Mons',
  'Etc/GMT+25',
  'GMT+5',
  '+05:30',
  '__proto__',
  'constructor',
  'UTC\u0000',
  '\u0000',
  BIG,
  '../../UTC',
  '🕰️',
  'America/New_York\u0301',
] as const;

const TECHNIQUES = [
  'dink',
  'volley',
  'forehand_drive',
  'backhand_drive',
  'serve',
  'third_shot_drop',
] as const;
const HOSTILE_STRINGS = [
  '',
  ' ',
  '\u0000',
  'dink\u0000',
  BIG,
  '👨‍👩‍👧‍👦'.repeat(2_000),
  '\u00e9',
  'e\u0301',
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'valueOf',
  'hasOwnProperty',
  '../../etc/passwd',
  '%2e%2e%2f',
  '\ud800',
  'DINK',
  'dink ',
  '_',
  '___',
] as const;

const HOSTILE_ISO = [
  '',
  ' ',
  'not-a-date',
  'null',
  'undefined',
  'NaN',
  '0',
  '12345',
  '1741000000000',
  '2026-02-30T10:00:00.000Z',
  '2026-13-01T10:00:00.000Z',
  '2026-03-10T25:00:00.000Z',
  '2026-03-10T10:00:00',
  '2026-03-10 10:00:00',
  '2026-03-10',
  '2026-3-1',
  '2026-03-10T10:00:00.000+05:30',
  '2026-03-10T10:00:00.000-12:00',
  '2026-03-10T10:00:00.000Z\u0000',
  '\uFEFF2026-03-10T10:00:00.000Z',
  '٢٠٢٦-٠٣-١٠T10:00:00.000Z',
  '1970-01-01T00:00:00.000Z',
  '1969-12-31T23:59:59.999Z',
  '1900-01-01T00:00:00.000Z',
  '1000-01-01T00:00:00.000Z',
  '0999-12-31T00:00:00.000Z',
  '0099-01-01T00:00:00.000Z',
  '0000-01-01T00:00:00.000Z',
  '-000001-01-01T00:00:00.000Z',
  '-100000-01-01T00:00:00.000Z',
  '+010000-01-01T00:00:00.000Z',
  '+275760-09-13T00:00:00.000Z',
  '-271821-04-20T00:00:00.000Z',
  '2099-12-31T23:59:59.999Z',
  '2026-03-21T00:00:00.000Z',
  BIG,
] as const;

const HOSTILE_SCORES: readonly unknown[] = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  -0,
  0,
  10,
  10.0000001,
  -1,
  11,
  250,
  1e308,
  -1e308,
  5e-324,
  2 ** 53,
  '7',
  '',
  null,
  undefined,
  true,
  {},
  [],
  [7],
];

function validIso(rng: () => number): string {
  const daysBack = int(rng, 45);
  const ms = AS_OF_MS - daysBack * DAY_MS - int(rng, DAY_MS);
  return new Date(ms).toISOString();
}

function validActivity(rng: () => number): TrainingActivityInput {
  const kind = pick(rng, ['stroke', 'session_stroke', 'drill'] as const);
  if (kind === 'drill') {
    return {
      kind,
      atIso: validIso(rng),
      label: pick(rng, ['Dink ladder', 'Reset wall', 'Contact shadow']),
    };
  }
  const scored = rng() < 0.7;
  return {
    kind,
    atIso: validIso(rng),
    shotType: pick(rng, TECHNIQUES),
    overallScore: scored ? Math.round(rng() * 100) / 10 : null,
    resultKind: scored ? 'scored' : pick(rng, ['low_confidence', 'abstain']),
  };
}

function corruptedActivity(rng: () => number): Record<string, unknown> {
  const base = validActivity(rng) as unknown as Record<string, unknown>;
  const corrupt = (key: string, pool: readonly unknown[]) => {
    const roll = rng();
    if (roll < 0.45) base[key] = pick(rng, pool);
    else if (roll < 0.55) delete base[key];
  };
  corrupt('kind', [
    'DRILL',
    'Stroke',
    '',
    null,
    undefined,
    42,
    '__proto__',
    'drill\u0000',
  ]);
  corrupt('atIso', [...HOSTILE_ISO, null, undefined, 1741000000000, {}, []]);
  corrupt('shotType', [...HOSTILE_STRINGS, null, 42, {}]);
  corrupt('overallScore', HOSTILE_SCORES);
  corrupt('resultKind', [
    'SCORED',
    'scored ',
    '',
    null,
    42,
    '__proto__',
    'abstain',
    'low_confidence',
  ]);
  corrupt('label', [...HOSTILE_STRINGS, null, 42, {}]);
  if (rng() < 0.1) base[pick(rng, HOSTILE_STRINGS)] = pick(rng, HOSTILE_SCORES);
  return base;
}

/** Wrong JS types straight into the engine (violates its TS contract). */
function rawHostileActivity(rng: () => number): TrainingActivityInput {
  return corruptedActivity(rng) as unknown as TrainingActivityInput;
}

/**
 * The production boundary: repository.ts `listActivityShots` casts every
 * SQLite column with `String(...)` / `Number(...)`, store.ts derives `kind`
 * from `session_id`, and drill rows come out of `parseConsistencyLedger`
 * (all strings). Only the CONTENT can be hostile — never the JS type.
 */
function boundaryHostileActivity(rng: () => number): TrainingActivityInput {
  const raw = corruptedActivity(rng);
  const kind: TrainingActivityInput['kind'] =
    raw['kind'] === 'drill'
      ? 'drill'
      : raw['kind'] === 'session_stroke'
        ? 'session_stroke'
        : 'stroke';
  const atIso = String(raw['atIso']);
  if (kind === 'drill') {
    const title = String(raw['label'] ?? '');
    const slug = String(raw['shotType'] ?? '');
    return { kind, atIso, label: title || slug };
  }
  const score = raw['overallScore'];
  return {
    kind,
    atIso,
    shotType: String(raw['shotType']),
    overallScore: score === null || score === undefined ? null : Number(score),
    resultKind: String(raw['resultKind']),
  };
}

function firstJsonDifference(a: unknown, b: unknown): string {
  const left = JSON.stringify(a, null, 1).split('\n');
  const right = JSON.stringify(b, null, 1).split('\n');
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    if (left[i] !== right[i])
      return `${left[i]?.trim()} vs ${right[i]?.trim()}`.slice(0, 160);
  }
  return 'identical';
}

// ─── Invariants that hold for ANY input ────────────────────────────────────

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function invariantViolation(
  snapshot: ConsistencySnapshot,
  inputCount: number,
): string | null {
  const counts: Array<[string, unknown]> = [
    ['currentStreak', snapshot.currentStreak],
    ['longestStreak', snapshot.longestStreak],
    ['shieldsAvailable', snapshot.shieldsAvailable],
    ['shieldsEarnedTotal', snapshot.shieldsEarnedTotal],
    ['shieldedDayCount', snapshot.shieldedDayCount],
    ['momentumXp', snapshot.momentumXp],
    ['runXp', snapshot.runXp],
    ['trainedLast7', snapshot.trainedLast7],
    ['totalTrainedDays', snapshot.totalTrainedDays],
    ['totalActivities', snapshot.totalActivities],
    ['scoredAnalysisCount', snapshot.scoredAnalysisCount],
    ['momentum.level', snapshot.momentum.level],
    ['momentum.xpIntoLevel', snapshot.momentum.xpIntoLevel],
    ['momentum.xpForNextLevel', snapshot.momentum.xpForNextLevel],
  ];
  for (const [name, value] of counts) {
    if (!isCount(value))
      return `${name} is not a non-negative integer: ${String(value)}`;
  }
  if (
    !DAY_KEY.test(snapshot.asOfDay) ||
    !Number.isFinite(dayOrdinal(snapshot.asOfDay))
  ) {
    return `asOfDay not a calendar day key: ${snapshot.asOfDay}`;
  }
  if (typeof snapshot.timeZone !== 'string' || snapshot.timeZone.length === 0) {
    return 'timeZone empty';
  }
  if (snapshot.currentStreak > snapshot.longestStreak)
    return 'currentStreak > longestStreak';
  if (snapshot.shieldsAvailable > SHIELD_MAX_HELD)
    return 'shieldsAvailable > cap';
  if (
    snapshot.shieldsAvailable + snapshot.shieldedDayCount >
    snapshot.shieldsEarnedTotal
  ) {
    return 'shields spent + held exceed shields earned';
  }
  if (snapshot.trainedLast7 > 7) return 'trainedLast7 > 7';
  if (snapshot.totalActivities > inputCount)
    return 'totalActivities exceeds inputs';
  if (snapshot.totalTrainedDays > snapshot.totalActivities)
    return 'trained days exceed activities';
  if (snapshot.scoredAnalysisCount > snapshot.totalActivities)
    return 'scored exceeds activities';
  if (
    snapshot.atRisk !== (snapshot.currentStreak > 0 && !snapshot.trainedToday)
  ) {
    return 'atRisk disagrees with streak/trainedToday';
  }
  if (snapshot.trainedToday && snapshot.currentStreak < 1) {
    return `trainedToday but currentStreak=${snapshot.currentStreak} (streak erased)`;
  }
  if (snapshot.totalActivities > 0 && snapshot.totalTrainedDays === 0) {
    return 'activities counted but zero trained days (history not walked)';
  }
  if (snapshot.trainedToday && !snapshot.days[snapshot.asOfDay]) {
    return 'trainedToday but no day record for today';
  }

  let trained = 0;
  let shielded = 0;
  let xpSum = 0;
  let activitySum = 0;
  let scoredSum = 0;
  for (const [key, day] of Object.entries(snapshot.days)) {
    if (!DAY_KEY.test(key) || !Number.isFinite(dayOrdinal(key)))
      return `day key invalid: ${key}`;
    if (day.day !== key) return `day.day (${day.day}) != key (${key})`;
    if (dayOrdinal(key) > dayOrdinal(snapshot.asOfDay))
      return `day ${key} is after asOfDay`;
    for (const [name, value] of [
      ['strokeCount', day.strokeCount],
      ['sessionStrokeCount', day.sessionStrokeCount],
      ['drillCount', day.drillCount],
      ['scoredCount', day.scoredCount],
      ['xp', day.xp],
    ] as const) {
      if (!isCount(value))
        return `${key}.${name} not a count: ${String(value)}`;
    }
    const volume = day.strokeCount + day.sessionStrokeCount + day.drillCount;
    if (volume !== day.activities.length)
      return `${key}: counts (${volume}) != activities (${day.activities.length})`;
    if (day.scoredCount > volume) return `${key}: scoredCount > volume`;
    if (day.scoredCount > 0) {
      if (typeof day.scoreAvg !== 'number' || !Number.isFinite(day.scoreAvg)) {
        return `${key}: scoreAvg not finite with ${day.scoredCount} scored (${String(day.scoreAvg)})`;
      }
    } else if (day.scoreAvg !== null) {
      return `${key}: scoreAvg without scored analyses`;
    }
    for (const activity of day.activities) {
      if (typeof activity.label !== 'string')
        return `${key}: activity label not string`;
      if (activity.score !== null && !Number.isFinite(activity.score))
        return `${key}: activity score not finite`;
      if (typeof activity.atIso !== 'string')
        return `${key}: activity atIso not string`;
    }
    if (day.shielded) {
      shielded += 1;
      if (volume !== 0 || day.xp !== 0)
        return `${key}: shielded day carries activity or xp`;
    } else {
      trained += 1;
      if (volume === 0) return `${key}: trained day with no activities`;
      if (day.xp < XP_PER_TRAINED_DAY)
        return `${key}: trained day below base xp`;
    }
    xpSum += day.xp;
    activitySum += day.activities.length;
    scoredSum += day.scoredCount;
  }
  if (trained !== snapshot.totalTrainedDays)
    return `days record ${trained} trained, snapshot says ${snapshot.totalTrainedDays}`;
  if (shielded !== snapshot.shieldedDayCount)
    return `days record ${shielded} shielded, snapshot says ${snapshot.shieldedDayCount}`;
  if (xpSum !== snapshot.momentumXp)
    return `sum(day.xp)=${xpSum} != momentumXp=${snapshot.momentumXp}`;
  if (activitySum !== snapshot.totalActivities)
    return `sum(day activities)=${activitySum} != totalActivities=${snapshot.totalActivities}`;
  if (scoredSum !== snapshot.scoredAnalysisCount)
    return `sum(day scored)=${scoredSum} != scoredAnalysisCount=${snapshot.scoredAnalysisCount}`;
  if (snapshot.runXp > snapshot.momentumXp) return 'runXp > momentumXp';

  const earnedIds = snapshot.earned.map(e => e.id);
  if (new Set(earnedIds).size !== earnedIds.length)
    return 'duplicate earned ids';
  for (const earned of snapshot.earned) {
    if (!DAY_KEY.test(earned.earnedOnDay))
      return `earnedOnDay invalid: ${earned.earnedOnDay}`;
  }
  for (const milestone of STREAK_MILESTONES) {
    const reached = snapshot.longestStreak >= milestone.days;
    if (reached !== earnedIds.includes(milestone.id)) {
      return `milestone ${milestone.id} earned=${!reached} but longestStreak=${snapshot.longestStreak}`;
    }
  }
  if (snapshot.nextStreakMilestone) {
    if (
      snapshot.nextStreakMilestone.daysAway !==
      snapshot.nextStreakMilestone.days - snapshot.currentStreak
    ) {
      return 'nextStreakMilestone.daysAway inconsistent';
    }
    if (snapshot.nextStreakMilestone.daysAway < 1)
      return 'nextStreakMilestone already reached';
  }
  if ('polluted' in {} || Object.keys(Object.prototype).length > 0)
    return 'Object.prototype polluted';
  return null;
}

function runCase(
  seed: number,
  campaign: string,
  activities: readonly TrainingActivityInput[],
  options: { asOfIso: string; timeZone: string },
): Row {
  const rng = mulberry32(seed ^ 0x5bd1e995);
  const before = JSON.stringify(activities);
  const row: Row = {
    seed,
    campaign,
    activities: activities.length,
    timeZone: String(options.timeZone).slice(0, 40),
    asOfIso: String(options.asOfIso).slice(0, 40),
    outcome: 'HELD',
  };
  let snapshot: ConsistencySnapshot;
  try {
    snapshot = buildConsistencySnapshot(activities, options);
  } catch (error) {
    return { ...row, outcome: 'BROKEN', detail: `threw: ${String(error)}` };
  }
  const violation = invariantViolation(snapshot, activities.length);
  if (violation) return { ...row, outcome: 'BROKEN', detail: violation };
  if (JSON.stringify(activities) !== before) {
    return { ...row, outcome: 'BROKEN', detail: 'input mutated' };
  }
  const again = buildConsistencySnapshot(shuffled(rng, activities), options);
  if (JSON.stringify(again) !== JSON.stringify(snapshot)) {
    return {
      ...row,
      outcome: 'BROKEN',
      detail: `not deterministic under input order: ${firstJsonDifference(snapshot, again)}`,
    };
  }
  return row;
}

function abbreviate(value: unknown): unknown {
  if (typeof value === 'string' && value.length > 60) {
    return `${value.slice(0, 40)}…(${value.length} chars)`;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        abbreviate(k),
        abbreviate(v),
      ]),
    );
  }
  return value;
}

/** Greedy one-at-a-time delta debugging over the activity list. */
function minimizeAndRerun(
  row: Row,
  activities: readonly TrainingActivityInput[],
  options: { asOfIso: string; timeZone: string },
): Row {
  if (row.outcome !== 'BROKEN') return row;
  const failureClass = (detail: string | undefined): string =>
    (detail ?? '')
      .replace(/^\d{4}-\d{2}-\d{2}: /, '')
      .replace(/\d+(\.\d+)?/g, 'N')
      .replace(/: .*$/, '');
  const target = failureClass(row.detail);
  const sameClass = (candidate: readonly TrainingActivityInput[]): boolean => {
    const outcome = runCase(row.seed, row.campaign, candidate, options);
    return (
      outcome.outcome === 'BROKEN' && failureClass(outcome.detail) === target
    );
  };
  let current = [...activities];
  let shrunk = true;
  while (shrunk) {
    shrunk = false;
    let i = 0;
    while (i < current.length) {
      const candidate = [...current.slice(0, i), ...current.slice(i + 1)];
      if (sameClass(candidate)) {
        current = candidate;
        shrunk = true;
      } else {
        i += 1;
      }
    }
  }
  let rerunFailures = 0;
  for (let i = 0; i < 10; i += 1) if (sameClass(current)) rerunFailures += 1;
  return { ...row, minimized: current.map(abbreviate), rerunFailures };
}

// ─── Independent reference model (well-formed inputs only) ─────────────────

function referenceDayKey(ms: number, timeZone: string): string {
  // Different Intl path than the engine (en-CA yields YYYY-MM-DD directly).
  return new Date(ms).toLocaleDateString('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}
function referenceOrdinal(key: string): number {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

interface Reference {
  currentStreak: number;
  longestStreak: number;
  shieldsAvailable: number;
  shieldsEarnedTotal: number;
  shieldedDayCount: number;
  momentumXp: number;
  totalTrainedDays: number;
  trainedLast7: number;
  trainedToday: boolean;
  earnedStreakIds: string[];
}

function referenceModel(
  activities: readonly TrainingActivityInput[],
  asOfIso: string,
  timeZone: string,
): Reference {
  const asOfMs = Date.parse(asOfIso);
  const todayKey = referenceDayKey(asOfMs, timeZone);
  const today = referenceOrdinal(todayKey);
  const perDay = new Map<number, number>();
  for (const activity of activities) {
    const ms = Date.parse(activity.atIso);
    if (ms > asOfMs) continue;
    const ordinal = referenceOrdinal(referenceDayKey(ms, timeZone));
    if (ordinal > today) continue;
    perDay.set(ordinal, (perDay.get(ordinal) ?? 0) + 1);
  }
  const reference: Reference = {
    currentStreak: 0,
    longestStreak: 0,
    shieldsAvailable: 0,
    shieldsEarnedTotal: 0,
    shieldedDayCount: 0,
    momentumXp: 0,
    totalTrainedDays: 0,
    trainedLast7: 0,
    trainedToday: perDay.has(today),
    earnedStreakIds: [],
  };
  if (perDay.size === 0) return reference;
  const first = Math.min(...perDay.keys());
  let run = 0;
  const awarded = new Set<string>();
  for (let ordinal = first; ordinal <= today; ordinal += 1) {
    const volume = perDay.get(ordinal);
    if (volume) {
      run += 1;
      reference.totalTrainedDays += 1;
      reference.longestStreak = Math.max(reference.longestStreak, run);
      let xp =
        XP_PER_TRAINED_DAY +
        Math.min((volume - 1) * XP_PER_EXTRA_ACTIVITY, XP_EXTRA_ACTIVITY_CAP);
      for (const milestone of STREAK_MILESTONES) {
        if (run === milestone.days && !awarded.has(milestone.id)) {
          awarded.add(milestone.id);
          reference.earnedStreakIds.push(milestone.id);
          xp += milestone.bonusXp;
        }
      }
      reference.momentumXp += xp;
      if (run % SHIELD_EARN_EVERY_DAYS === 0) {
        reference.shieldsEarnedTotal += 1;
        reference.shieldsAvailable = Math.min(
          reference.shieldsAvailable + 1,
          SHIELD_MAX_HELD,
        );
      }
      continue;
    }
    if (ordinal === today) break;
    if (run === 0) continue;
    if (reference.shieldsAvailable > 0) {
      reference.shieldsAvailable -= 1;
      reference.shieldedDayCount += 1;
    } else {
      run = 0;
    }
  }
  reference.currentStreak = run;
  for (let ordinal = today - 6; ordinal <= today; ordinal += 1) {
    if (perDay.has(ordinal)) reference.trainedLast7 += 1;
  }
  return reference;
}

function hostileOptions(rng: () => number): {
  asOfIso: string;
  timeZone: string;
} {
  const timeZone =
    rng() < 0.3 ? pick(rng, HOSTILE_ZONES) : pick(rng, VALID_ZONES);
  const asOfRoll = rng();
  const asOfIso =
    asOfRoll < 0.7
      ? AS_OF_VALID
      : asOfRoll < 0.85
        ? pick(rng, HOSTILE_ISO)
        : (pick(rng, [
            null,
            undefined,
            0,
            NaN,
            {},
            1741000000000,
          ]) as unknown as string);
  return { asOfIso, timeZone };
}

// ─── Campaigns ─────────────────────────────────────────────────────────────

describe('buildConsistencySnapshot under boundary / malformed input', () => {
  it(`boundary: hostile field content (String/Number-coerced like repository.ts) + hostile options never throw, invariants hold, order-independent (${ITER} seeded cases)`, () => {
    const failures: Row[] = [];
    for (let iteration = 0; iteration < ITER; iteration += 1) {
      const seed = 9_000_000 + iteration;
      const rng = mulberry32(seed);
      const count = int(rng, 40);
      const hostileShare = rng();
      const activities = Array.from({ length: count }, () =>
        rng() < hostileShare
          ? boundaryHostileActivity(rng)
          : validActivity(rng),
      );
      const options = hostileOptions(rng);
      const row = minimizeAndRerun(
        runCase(seed, 'boundary', activities, options),
        activities,
        options,
      );
      table.push(row);
      if (row.outcome === 'BROKEN') failures.push(row);
    }
    expect(failures).toEqual([]);
  });

  it(`raw-types: wrong JS types straight into the engine never throw, invariants hold (${ITER} seeded cases)`, () => {
    const failures: Row[] = [];
    for (let iteration = 0; iteration < ITER; iteration += 1) {
      const seed = 10_000_000 + iteration;
      const rng = mulberry32(seed);
      const count = int(rng, 40);
      const hostileShare = rng();
      const activities = Array.from({ length: count }, () =>
        rng() < hostileShare ? rawHostileActivity(rng) : validActivity(rng),
      );
      const options = hostileOptions(rng);
      const row = minimizeAndRerun(
        runCase(seed, 'raw-types', activities, options),
        activities,
        options,
      );
      table.push(row);
      if (row.outcome === 'BROKEN') failures.push(row);
    }
    expect(failures).toEqual([]);
  });

  it(`well-formed seeded histories agree with the independent reference model (${ITER} seeded cases)`, () => {
    const failures: Row[] = [];
    for (let iteration = 0; iteration < ITER; iteration += 1) {
      const seed = 11_000_000 + iteration;
      const rng = mulberry32(seed);
      // Bias toward dense histories so shields and long runs actually occur.
      const count = int(rng, 120);
      const window = 1 + int(rng, 60);
      const asOfIso = pick(rng, AS_OF_DST);
      // Clock jump: 15% of histories hold rows stamped up to 3 days AFTER "now".
      const jumpMs = rng() < 0.15 ? 3 * DAY_MS : 0;
      const asOfMs = Date.parse(asOfIso);
      const activities: TrainingActivityInput[] = Array.from(
        { length: count },
        () => {
          const activity = validActivity(rng);
          const ms =
            asOfMs + jumpMs - int(rng, window) * DAY_MS - int(rng, DAY_MS);
          return { ...activity, atIso: new Date(ms).toISOString() };
        },
      );
      const timeZone = pick(rng, VALID_ZONES);
      const options = { asOfIso, timeZone };
      const row = minimizeAndRerun(
        runCase(seed, 'reference', activities, options),
        activities,
        options,
      );
      if (!row.detail?.startsWith('threw')) {
        const snapshot = buildConsistencySnapshot(activities, options);
        const reference = referenceModel(activities, asOfIso, timeZone);
        const actual: Reference = {
          currentStreak: snapshot.currentStreak,
          longestStreak: snapshot.longestStreak,
          shieldsAvailable: snapshot.shieldsAvailable,
          shieldsEarnedTotal: snapshot.shieldsEarnedTotal,
          shieldedDayCount: snapshot.shieldedDayCount,
          momentumXp: snapshot.momentumXp,
          totalTrainedDays: snapshot.totalTrainedDays,
          trainedLast7: snapshot.trainedLast7,
          trainedToday: snapshot.trainedToday,
          earnedStreakIds: snapshot.earned
            .map(e => e.id)
            .filter(id => id.startsWith('streak.')),
        };
        if (JSON.stringify(actual) !== JSON.stringify(reference)) {
          row.outcome = 'BROKEN';
          row.detail = `${row.detail ? `${row.detail}; ` : ''}reference mismatch: engine=${JSON.stringify(actual)} reference=${JSON.stringify(reference)}`;
        }
      }
      table.push(row);
      if (row.outcome === 'BROKEN') failures.push(row);
    }
    expect(failures).toEqual([]);
  });

  it('a single row with a non-4-digit year must not erase the rest of the history (any position)', () => {
    // Intl renders year 999 as "999" and 10000 as "10000"; `dayOrdinal`
    // only parses YYYY. SQLite returns rows ORDER BY captured_at ASC, so a
    // "0999-…" or "+010000-…" string sorts FIRST — the production order.
    const recent: TrainingActivityInput[] = [
      {
        kind: 'stroke',
        atIso: '2026-03-19T10:00:00.000Z',
        shotType: 'dink',
        overallScore: 6,
        resultKind: 'scored',
      },
      {
        kind: 'stroke',
        atIso: '2026-03-20T10:00:00.000Z',
        shotType: 'dink',
        overallScore: 6,
        resultKind: 'scored',
      },
    ];
    const clean = buildConsistencySnapshot(recent, {
      asOfIso: AS_OF_VALID,
      timeZone: 'UTC',
    });
    expect(clean.currentStreak).toBe(2);
    const outcomes: Array<Record<string, unknown>> = [];
    for (const atIso of [
      '0099-01-01T00:00:00.000Z',
      '0999-12-31T00:00:00.000Z',
      '+010000-01-01T00:00:00.000Z',
      '12345',
    ]) {
      for (const position of [0, 1, 2]) {
        const activities = [...recent];
        activities.splice(position, 0, {
          kind: 'stroke',
          atIso,
          shotType: 'dink',
          overallScore: 6,
          resultKind: 'scored',
        });
        const poisoned = buildConsistencySnapshot(activities, {
          asOfIso: AS_OF_VALID,
          timeZone: 'UTC',
        });
        const dayActivities = Object.values(poisoned.days).reduce(
          (sum, day) => sum + day.activities.length,
          0,
        );
        outcomes.push({
          atIso,
          position,
          currentStreak: poisoned.currentStreak,
          trainedToday: poisoned.trainedToday,
          totalActivities: poisoned.totalActivities,
          dayActivities,
        });
      }
    }
    // Expected: the corrupt row is either skipped (2 counted) or bucketed
    // into a walkable day (3 counted) — but the streak is never erased and
    // the day records never disagree with the totals.
    expect(
      outcomes.filter(
        o =>
          o['currentStreak'] !== 2 ||
          o['trainedToday'] !== true ||
          o['dayActivities'] !== o['totalActivities'],
      ),
    ).toEqual([]);
  });

  it('non-4-digit-year asOf instants (clock jump) still yield a walkable asOfDay', () => {
    const recent: TrainingActivityInput[] = [
      {
        kind: 'stroke',
        atIso: '0999-12-30T10:00:00.000Z',
        shotType: 'dink',
        overallScore: 6,
        resultKind: 'scored',
      },
      {
        kind: 'stroke',
        atIso: '0999-12-31T10:00:00.000Z',
        shotType: 'dink',
        overallScore: 6,
        resultKind: 'scored',
      },
    ];
    const snapshot = buildConsistencySnapshot(recent, {
      asOfIso: '0999-12-31T18:00:00.000Z',
      timeZone: 'UTC',
    });
    expect(Number.isFinite(dayOrdinal(snapshot.asOfDay))).toBe(true);
    expect(snapshot.totalTrainedDays).toBe(2);
  });

  it('day average is independent of activity order (float summation)', () => {
    // Minimized from seed 11000052 (Pacific/Apia): 0.1+7.7+7.4+3.4 rounds
    // to 4.6 or 4.7 depending on summation order.
    const scores = [0.1, 7.7, 7.4, 3.4];
    const build = (order: number[]) =>
      buildConsistencySnapshot(
        order.map((i, k) => ({
          kind: 'stroke' as const,
          atIso: `2026-03-10T10:0${k}:00.000Z`,
          shotType: 'dink',
          overallScore: scores[i]!,
          resultKind: 'scored',
        })),
        { asOfIso: AS_OF_VALID, timeZone: 'UTC' },
      ).days['2026-03-10']?.scoreAvg;
    expect(build([0, 1, 2, 3])).toBe(build([3, 2, 1, 0]));
  });

  it('score overflow never yields a non-finite day average', () => {
    const snapshot = buildConsistencySnapshot(
      [
        {
          kind: 'stroke',
          atIso: '2026-03-20T10:00:00.000Z',
          shotType: 'dink',
          overallScore: 1e308,
          resultKind: 'scored',
        },
        {
          kind: 'stroke',
          atIso: '2026-03-20T11:00:00.000Z',
          shotType: 'dink',
          overallScore: 1e308,
          resultKind: 'scored',
        },
      ],
      { asOfIso: AS_OF_VALID, timeZone: 'UTC' },
    );
    expect(Number.isFinite(snapshot.days['2026-03-20']?.scoreAvg)).toBe(true);
  });

  it('garbage time zones fall back to UTC and garbage asOf instants never throw', () => {
    for (const timeZone of HOSTILE_ZONES) {
      const snapshot = buildConsistencySnapshot([], {
        asOfIso: AS_OF_VALID,
        timeZone,
      });
      expect(typeof snapshot.timeZone).toBe('string');
      expect(snapshot.timeZone.length).toBeGreaterThan(0);
    }
    for (const asOfIso of HOSTILE_ISO) {
      expect(() =>
        buildConsistencySnapshot([], { asOfIso, timeZone: 'UTC' }),
      ).not.toThrow();
    }
  });

  it('prototype-key techniques and labels are inert', () => {
    const activities: TrainingActivityInput[] = [
      '__proto__',
      'constructor',
      'prototype',
      'toString',
      'hasOwnProperty',
    ].flatMap(name =>
      Array.from({ length: 30 }, (_, i) => ({
        kind: 'stroke' as const,
        atIso: `2026-03-${String(1 + (i % 20)).padStart(2, '0')}T10:0${i % 10}:00.000Z`,
        shotType: name,
        overallScore: 7,
        resultKind: 'scored',
        label: name,
      })),
    );
    const snapshot = buildConsistencySnapshot(activities, {
      asOfIso: AS_OF_VALID,
      timeZone: 'UTC',
    });
    expect(invariantViolation(snapshot, activities.length)).toBeNull();
    const specialist = snapshot.earned.find(e => e.id === 'volume.specialist');
    expect(typeof specialist?.detail).toBe('string');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('unicode normalization pairs are distinct techniques (no silent merge, no crash)', () => {
    const nfc = 'caf\u00e9';
    const nfd = 'cafe\u0301';
    const activities: TrainingActivityInput[] = [nfc, nfd].flatMap(name =>
      Array.from({ length: 13 }, (_, i) => ({
        kind: 'stroke' as const,
        atIso: `2026-03-${String(1 + i).padStart(2, '0')}T10:00:00.000Z`,
        shotType: name,
        overallScore: 7,
        resultKind: 'scored',
      })),
    );
    const snapshot = buildConsistencySnapshot(activities, {
      asOfIso: AS_OF_VALID,
      timeZone: 'UTC',
    });
    expect(invariantViolation(snapshot, activities.length)).toBeNull();
    // 13 + 13 scored but neither form reaches the 25-of-one-technique bar.
    expect(snapshot.earned.some(e => e.id === 'volume.specialist')).toBe(false);
  });

  it('one far-past row (clock jump / corrupt captured_at) does not cost a full-history day walk', () => {
    const recent: TrainingActivityInput = {
      kind: 'stroke',
      atIso: '2026-03-19T10:00:00.000Z',
      shotType: 'dink',
      overallScore: 6,
      resultKind: 'scored',
    };
    const time = (activities: TrainingActivityInput[]): number => {
      const startedAt = Date.now();
      for (let i = 0; i < 10; i += 1)
        buildConsistencySnapshot(activities, {
          asOfIso: AS_OF_VALID,
          timeZone: 'UTC',
        });
      return (Date.now() - startedAt) / 10;
    };
    const baselineMs = time([recent]);
    const epochMs = time([
      recent,
      { ...recent, atIso: '1970-01-01T00:00:00.000Z' },
    ]);
    const year1000Ms = time([
      recent,
      { ...recent, atIso: '1000-01-01T00:00:00.000Z' },
    ]);
    table.push({
      seed: 0,
      campaign: 'perf',
      activities: 2,
      timeZone: 'UTC',
      asOfIso: AS_OF_VALID,
      outcome: year1000Ms < 50 ? 'HELD' : 'BROKEN',
      detail: `ms per snapshot: recent-only=${baselineMs.toFixed(2)} +1970-row=${epochMs.toFixed(2)} +1000-row=${year1000Ms.toFixed(2)}`,
    });
    // A refresh runs on every foreground; one row must not turn it into
    // hundreds of thousands of Date allocations.
    expect(year1000Ms).toBeLessThan(50);
  });

  it('handles a 10,000-activity, 20-year history within budget', () => {
    const rng = mulberry32(2026);
    const activities = Array.from({ length: 10_000 }, () => {
      const activity = validActivity(rng);
      const ms = AS_OF_MS - int(rng, 365 * 20) * DAY_MS - int(rng, DAY_MS);
      return { ...activity, atIso: new Date(ms).toISOString() };
    });
    const startedAt = Date.now();
    const snapshot = buildConsistencySnapshot(activities, {
      asOfIso: AS_OF_VALID,
      timeZone: 'America/Los_Angeles',
    });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(invariantViolation(snapshot, activities.length)).toBeNull();
  });
});
