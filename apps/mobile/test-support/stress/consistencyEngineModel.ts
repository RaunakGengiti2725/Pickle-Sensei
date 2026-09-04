/**
 * Seeded randomized model-checker for the consistency ENGINE
 * (`src/consistency/engine.ts` + `milestones.ts`).
 *
 * A sequence is a list of legal / near-legal actions over the engine's
 * public input — add an activity (valid, malformed, future, at a local
 * midnight boundary), add a run of consecutive trained days, advance the
 * clock, jump the clock backwards, set the clock onto a DST/leap/year
 * transition, change the timezone (valid, half-hour, +14, invalid). After
 * EVERY step the snapshot is rebuilt and checked against
 *   (a) the invariants documented in engine.ts / AGENTS.md (INV-xx below),
 *   (b) monotonicity relations against the previous step, and
 *   (c) an independent reference model (different day-key derivation,
 *       different walk structure).
 * Every failure carries the seed, the step and the invariant id; the
 * campaign shrinks the action list of each failing seed with ddmin.
 */
import {
  buildConsistencySnapshot,
  type ConsistencySnapshot,
  type TrainingActivityInput,
} from '../../src/consistency/engine';
import {
  momentumLevelForXp,
  SHIELD_EARN_EVERY_DAYS,
  SHIELD_MAX_HELD,
  STREAK_MILESTONES,
  VOLUME_ACHIEVEMENTS,
  XP_EXTRA_ACTIVITY_CAP,
  XP_PER_EXTRA_ACTIVITY,
  XP_PER_TRAINED_DAY,
} from '../../src/consistency/milestones';
import { Rng, stableJson } from './seededRng';

export const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

// ─── Zones & clock anchors ─────────────────────────────────────────────────

export const VALID_TIME_ZONES: readonly string[] = [
  'UTC',
  'America/New_York',
  'America/Los_Angeles',
  'America/St_Johns', // -3:30, DST
  'America/Santiago', // southern-hemisphere DST
  'Europe/London',
  'Europe/Berlin',
  'Africa/Casablanca', // Ramadan-shifted DST
  'Asia/Kolkata', // +5:30, no DST
  'Asia/Kathmandu', // +5:45
  'Asia/Tehran',
  'Australia/Lord_Howe', // 30-minute DST shift
  'Australia/Sydney',
  'Pacific/Auckland', // +12/+13
  'Pacific/Chatham', // +12:45/+13:45
  'Pacific/Kiritimati', // +14, no DST
  'Pacific/Apia', // +13/+14, skipped 2011-12-30
  'Pacific/Pago_Pago', // -11
];

export const INVALID_TIME_ZONES: readonly string[] = [
  'Mars/Olympus_Mons',
  '',
  'Not/AZone',
  'GMT+25:00',
  'utc ',
];

/** UTC instants straddling DST, leap-day, year and month transitions. */
export const CLOCK_ANCHORS: readonly string[] = [
  '2026-03-08T06:59:30.000Z', // US spring forward at 07:00Z
  '2026-03-08T07:00:30.000Z',
  '2026-11-01T05:59:30.000Z', // US fall back at 06:00Z
  '2026-11-01T06:00:30.000Z',
  '2026-03-29T00:59:30.000Z', // EU spring forward at 01:00Z
  '2026-03-29T01:00:30.000Z',
  '2026-10-25T00:59:30.000Z', // EU fall back at 01:00Z
  '2026-10-25T01:00:30.000Z',
  '2026-04-05T13:59:30.000Z', // NZ fall back at 14:00Z
  '2026-09-27T13:59:30.000Z', // NZ spring forward at 14:00Z
  '2026-04-05T02:59:30.000Z', // Sydney fall back at 16:00Z (prev day) — near
  '2026-10-04T15:59:30.000Z', // Sydney spring forward at 16:00Z
  '2026-12-31T23:59:59.999Z',
  '2027-01-01T00:00:00.000Z',
  '2028-02-28T23:59:59.000Z', // leap day
  '2028-02-29T12:00:00.000Z',
  '2028-03-01T00:00:00.000Z',
  '2026-02-28T23:59:59.000Z',
  '2026-06-30T23:59:59.999Z',
];

const SHOT_TYPES: readonly string[] = [
  'dink',
  'volley',
  'forehand_drive',
  'backhand_drive',
  'serve',
  'return',
  'third_shot_drop',
  'overhead',
];

const RESULT_KINDS: readonly string[] = [
  'scored',
  'scored',
  'scored',
  'low_confidence',
  'abstain',
  'not_analyzable',
];

// ─── Actions ───────────────────────────────────────────────────────────────

export type EngineAction =
  | { type: 'add'; input: TrainingActivityInput }
  | { type: 'addRun'; inputs: TrainingActivityInput[] }
  | { type: 'advance'; ms: number }
  | { type: 'jumpBack'; ms: number }
  | { type: 'setClock'; iso: string }
  | { type: 'setZone'; timeZone: string };

export interface EngineWorld {
  activities: TrainingActivityInput[];
  asOfMs: number;
  timeZone: string;
}

const resolvedZones = new Map<string, string>();

export function resolveZone(timeZone: string): string {
  const cached = resolvedZones.get(timeZone);
  if (cached !== undefined) return cached;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions()
      .timeZone;
  } catch {
    resolved = 'UTC';
  }
  resolvedZones.set(timeZone, resolved);
  return resolved;
}

const dayKeyFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Reference day key: `en-CA` renders ISO-like `YYYY-MM-DD` directly, which
 * is a different derivation from the engine's formatToParts assembly.
 */
export function refDayKey(ms: number, timeZone: string): string {
  const zone = resolveZone(timeZone);
  let formatter = dayKeyFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dayKeyFormatters.set(zone, formatter);
  }
  const text = formatter.format(new Date(ms));
  // en-CA yields "2026-03-08"; guard against any locale-data surprise.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw new Error(`reference day key unparseable: ${text}`);
  return text;
}

export function refOrdinal(day: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

export function refDayFromOrdinal(ordinal: number): string {
  const date = new Date(ordinal * DAY_MS);
  const y = String(date.getUTCFullYear()).padStart(4, '0');
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** First instant (ms) after `fromMs` whose local day differs — binary search. */
export function nextLocalDayBoundary(fromMs: number, timeZone: string): number {
  const startKey = refDayKey(fromMs, timeZone);
  let lo = fromMs;
  let hi = fromMs + 2 * DAY_MS;
  if (refDayKey(hi, timeZone) === startKey) return hi;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (refDayKey(mid, timeZone) === startKey) lo = mid;
    else hi = mid;
  }
  return hi;
}

function makeActivity(rng: Rng, atMs: number): TrainingActivityInput {
  const kind = rng.weighted(
    ['stroke', 'session_stroke', 'drill'] as const,
    [6, 2, 2],
  );
  const atIso = new Date(atMs).toISOString();
  if (kind === 'drill') {
    return {
      kind,
      atIso,
      label: rng.chance(0.85)
        ? rng.pick(['Contact Shadow Reps', 'Wall Dinks', 'Split Step Ladder'])
        : undefined,
    };
  }
  const resultKind = rng.pick(RESULT_KINDS);
  let overallScore: number | null | undefined;
  if (resultKind === 'scored') {
    overallScore = rng.weighted(
      [
        Math.round(rng.float() * 100) / 10,
        rng.int(0, 10),
        Number.NaN,
        Number.POSITIVE_INFINITY,
        null,
        undefined,
        -1,
        11,
      ],
      [10, 6, 1, 1, 1, 1, 1, 1],
    );
  } else {
    overallScore = rng.weighted([null, undefined, rng.int(0, 10)], [4, 3, 1]);
  }
  return {
    kind,
    atIso,
    shotType: rng.chance(0.92) ? rng.pick(SHOT_TYPES) : undefined,
    overallScore,
    resultKind,
    ...(rng.chance(0.1) ? { label: 'Custom label' } : {}),
  };
}

function randomInstantNear(rng: Rng, world: EngineWorld): number {
  const mode = rng.weighted(
    ['recent', 'deep', 'today', 'future', 'boundary'] as const,
    [8, 3, 4, 2, 3],
  );
  switch (mode) {
    case 'recent':
      return world.asOfMs - rng.int(0, 45 * 24) * HOUR_MS - rng.int(0, HOUR_MS);
    case 'deep':
      return world.asOfMs - rng.int(45, 420) * DAY_MS - rng.int(0, DAY_MS);
    case 'today':
      return world.asOfMs - rng.int(0, 6 * HOUR_MS);
    case 'future':
      return world.asOfMs + rng.int(1, 3 * DAY_MS);
    case 'boundary': {
      const base = world.asOfMs - rng.int(0, 20) * DAY_MS - DAY_MS;
      const boundary = nextLocalDayBoundary(base, world.timeZone);
      return boundary + rng.pick([-1, 0, 1, -1000, 999]);
    }
  }
}

function malformedActivity(
  rng: Rng,
  world: EngineWorld,
): TrainingActivityInput {
  const base = makeActivity(rng, world.asOfMs - HOUR_MS);
  const atIso = rng.pick([
    'not-a-date',
    '',
    '2026-02-30T10:00:00.000Z', // V8 rolls this to March 2
    '2026-13-01T00:00:00.000Z',
    'Infinity',
    '9999999999999999999',
    '2026-03-08T02:30:00', // no zone: host-local parse
    'Sun Mar 08 2026 02:30:00 GMT+0000',
  ]);
  return { ...base, atIso };
}

export function generateActions(
  rng: Rng,
  world: EngineWorld,
  length: number,
): EngineAction[] {
  const actions: EngineAction[] = [];
  // The generator evolves a shadow copy of the clock/zone so relative
  // instants stay meaningful as the sequence unfolds.
  const shadow: EngineWorld = { ...world, activities: [] };
  for (let step = 0; step < length; step += 1) {
    const kind = rng.weighted(
      [
        'add',
        'addMalformed',
        'addRun',
        'burst',
        'advance',
        'jumpBack',
        'setClock',
        'setZone',
      ] as const,
      [40, 6, 7, 5, 15, 5, 5, 8],
    );
    switch (kind) {
      case 'add': {
        actions.push({
          type: 'add',
          input: makeActivity(rng, randomInstantNear(rng, shadow)),
        });
        break;
      }
      case 'addMalformed': {
        actions.push({ type: 'add', input: malformedActivity(rng, shadow) });
        break;
      }
      case 'addRun': {
        const days = rng.weighted(
          [rng.int(2, 9), rng.int(7, 40), rng.int(60, 130), rng.int(360, 380)],
          [6, 4, 2, 1],
        );
        const endOffsetDays = rng.weighted([0, 1, rng.int(2, 30)], [5, 3, 2]);
        const inputs: TrainingActivityInput[] = [];
        for (let index = 0; index < days; index += 1) {
          const dayStart =
            shadow.asOfMs - (endOffsetDays + index) * DAY_MS - 12 * HOUR_MS;
          inputs.push(makeActivity(rng, dayStart + rng.int(-6, 6) * HOUR_MS));
        }
        actions.push({ type: 'addRun', inputs });
        break;
      }
      case 'burst': {
        const count = rng.int(5, 40);
        const at = randomInstantNear(rng, shadow);
        const inputs: TrainingActivityInput[] = [];
        const technique = rng.pick(SHOT_TYPES);
        for (let index = 0; index < count; index += 1) {
          const activity = makeActivity(rng, at + index * 1000);
          inputs.push(
            rng.chance(0.7) && activity.kind !== 'drill'
              ? {
                  ...activity,
                  shotType: technique,
                  resultKind: 'scored',
                  overallScore: rng.int(3, 9),
                }
              : activity,
          );
        }
        actions.push({ type: 'addRun', inputs });
        break;
      }
      case 'advance': {
        const ms = rng.weighted(
          [
            rng.int(1, HOUR_MS),
            rng.int(HOUR_MS, DAY_MS),
            rng.int(DAY_MS, 3 * DAY_MS),
            rng.int(3 * DAY_MS, 40 * DAY_MS),
          ],
          [3, 5, 5, 2],
        );
        shadow.asOfMs += ms;
        actions.push({ type: 'advance', ms });
        break;
      }
      case 'jumpBack': {
        const ms = rng.weighted(
          [rng.int(1, HOUR_MS), rng.int(HOUR_MS, 2 * DAY_MS)],
          [1, 2],
        );
        shadow.asOfMs -= ms;
        actions.push({ type: 'jumpBack', ms });
        break;
      }
      case 'setClock': {
        const iso = rng.pick(CLOCK_ANCHORS);
        shadow.asOfMs = Date.parse(iso);
        actions.push({ type: 'setClock', iso });
        break;
      }
      case 'setZone': {
        const timeZone = rng.chance(0.85)
          ? rng.pick(VALID_TIME_ZONES)
          : rng.pick(INVALID_TIME_ZONES);
        shadow.timeZone = timeZone;
        actions.push({ type: 'setZone', timeZone });
        break;
      }
    }
  }
  return actions;
}

export function initialWorld(rng: Rng): EngineWorld {
  const asOfMs = rng.chance(0.4)
    ? Date.parse(rng.pick(CLOCK_ANCHORS)) + rng.int(-HOUR_MS, HOUR_MS)
    : Date.UTC(2025, 0, 1) + rng.int(0, 3 * 365 * DAY_MS);
  return {
    activities: [],
    asOfMs,
    timeZone: rng.chance(0.9)
      ? rng.pick(VALID_TIME_ZONES)
      : rng.pick(INVALID_TIME_ZONES),
  };
}

export function applyAction(world: EngineWorld, action: EngineAction): void {
  switch (action.type) {
    case 'add':
      world.activities.push(action.input);
      break;
    case 'addRun':
      world.activities.push(...action.inputs);
      break;
    case 'advance':
      world.asOfMs += action.ms;
      break;
    case 'jumpBack':
      world.asOfMs -= action.ms;
      break;
    case 'setClock':
      world.asOfMs = Date.parse(action.iso);
      break;
    case 'setZone':
      world.timeZone = action.timeZone;
      break;
  }
}

// ─── Reference model ───────────────────────────────────────────────────────

interface RefDay {
  day: string;
  shielded: boolean;
  strokeCount: number;
  sessionStrokeCount: number;
  drillCount: number;
  scoredCount: number;
  scoreAvg: number | null;
  xp: number;
  activityCount: number;
}

export interface RefSnapshot {
  asOfDay: string;
  timeZone: string;
  days: Record<string, RefDay>;
  trainedToday: boolean;
  currentStreak: number;
  atRisk: boolean;
  longestStreak: number;
  shieldsAvailable: number;
  shieldsEarnedTotal: number;
  shieldedDayCount: number;
  momentumXp: number;
  runXp: number;
  trainedLast7: number;
  totalTrainedDays: number;
  totalActivities: number;
  scoredAnalysisCount: number;
  earnedIds: string[];
  specialistDetail: string | null;
  nextMilestoneDays: number | null;
}

function isScored(input: TrainingActivityInput): boolean {
  return (
    input.resultKind === 'scored' &&
    typeof input.overallScore === 'number' &&
    Number.isFinite(input.overallScore)
  );
}

export function referenceSnapshot(world: EngineWorld): RefSnapshot {
  const timeZone = resolveZone(world.timeZone);
  const asOfDay = refDayKey(world.asOfMs, timeZone);
  const asOfOrdinal = refOrdinal(asOfDay);

  interface Bucket {
    inputs: TrainingActivityInput[];
  }
  const buckets = new Map<string, Bucket>();
  let totalActivities = 0;
  let scoredAnalysisCount = 0;
  const perTechnique = new Map<string, number>();
  for (const input of world.activities) {
    const atMs = Date.parse(input.atIso);
    if (!Number.isFinite(atMs) || atMs > world.asOfMs) continue;
    const day = refDayKey(atMs, timeZone);
    if (refOrdinal(day) > asOfOrdinal) continue;
    totalActivities += 1;
    if (isScored(input)) {
      scoredAnalysisCount += 1;
      if (input.shotType) {
        perTechnique.set(
          input.shotType,
          (perTechnique.get(input.shotType) ?? 0) + 1,
        );
      }
    }
    const bucket = buckets.get(day);
    if (bucket) bucket.inputs.push(input);
    else buckets.set(day, { inputs: [input] });
  }

  const earnedIds: string[] = [];
  const days: Record<string, RefDay> = {};
  const empty: RefSnapshot = {
    asOfDay,
    timeZone,
    days,
    trainedToday: false,
    currentStreak: 0,
    atRisk: false,
    longestStreak: 0,
    shieldsAvailable: 0,
    shieldsEarnedTotal: 0,
    shieldedDayCount: 0,
    momentumXp: 0,
    runXp: 0,
    trainedLast7: 0,
    totalTrainedDays: 0,
    totalActivities: 0,
    scoredAnalysisCount: 0,
    earnedIds,
    specialistDetail: null,
    nextMilestoneDays: STREAK_MILESTONES[0]?.days ?? null,
  };
  if (buckets.size === 0) return empty;

  const ordinals = [...buckets.keys()].map(refOrdinal).sort((a, b) => a - b);
  let run = 0;
  let longest = 0;
  let shields = 0;
  let shieldsEarned = 0;
  let shieldedDays = 0;
  let xpTotal = 0;
  let runXp = 0;
  let trainedDays = 0;
  let cumulative = 0;
  const bonusGiven = new Set<number>();
  let sessions100 = false;

  for (let ordinal = ordinals[0]!; ordinal <= asOfOrdinal; ordinal += 1) {
    const day = refDayFromOrdinal(ordinal);
    const bucket = buckets.get(day);
    if (!bucket) {
      if (ordinal === asOfOrdinal) break; // today stays open
      if (run === 0) continue;
      if (shields > 0) {
        shields -= 1;
        shieldedDays += 1;
        days[day] = {
          day,
          shielded: true,
          strokeCount: 0,
          sessionStrokeCount: 0,
          drillCount: 0,
          scoredCount: 0,
          scoreAvg: null,
          xp: 0,
          activityCount: 0,
        };
      } else {
        run = 0;
        runXp = 0;
      }
      continue;
    }
    run += 1;
    trainedDays += 1;
    longest = Math.max(longest, run);
    const extra = Math.max(0, bucket.inputs.length - 1);
    let xp =
      XP_PER_TRAINED_DAY +
      Math.min(extra * XP_PER_EXTRA_ACTIVITY, XP_EXTRA_ACTIVITY_CAP);
    for (const milestone of STREAK_MILESTONES) {
      if (milestone.days !== run) continue;
      if (!bonusGiven.has(milestone.days)) {
        bonusGiven.add(milestone.days);
        xp += milestone.bonusXp;
      }
      if (!earnedIds.includes(milestone.id)) earnedIds.push(milestone.id);
    }
    xpTotal += xp;
    runXp = run === 1 ? xp : runXp + xp;
    if (run % SHIELD_EARN_EVERY_DAYS === 0) {
      shieldsEarned += 1;
      shields = Math.min(SHIELD_MAX_HELD, shields + 1);
    }
    cumulative += bucket.inputs.length;
    if (
      !sessions100 &&
      cumulative >= VOLUME_ACHIEVEMENTS.sessions100.threshold
    ) {
      sessions100 = true;
      earnedIds.push(VOLUME_ACHIEVEMENTS.sessions100.id);
    }
    let strokeCount = 0;
    let sessionStrokeCount = 0;
    let drillCount = 0;
    let scoredCount = 0;
    let scoreSum = 0;
    for (const input of bucket.inputs) {
      if (input.kind === 'stroke') strokeCount += 1;
      else if (input.kind === 'session_stroke') sessionStrokeCount += 1;
      else drillCount += 1;
      if (isScored(input)) {
        scoredCount += 1;
        scoreSum += input.overallScore as number;
      }
    }
    days[day] = {
      day,
      shielded: false,
      strokeCount,
      sessionStrokeCount,
      drillCount,
      scoredCount,
      scoreAvg:
        scoredCount > 0 ? Math.round((scoreSum / scoredCount) * 10) / 10 : null,
      xp,
      activityCount: bucket.inputs.length,
    };
  }

  let specialistDetail: string | null = null;
  const candidates = [...perTechnique.entries()]
    .filter(([, count]) => count >= VOLUME_ACHIEVEMENTS.specialist.threshold)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (candidates[0]) {
    specialistDetail = candidates[0][0].replace(/_/g, ' ');
    earnedIds.push(VOLUME_ACHIEVEMENTS.specialist.id);
  }

  let trainedLast7 = 0;
  for (let ordinal = asOfOrdinal - 6; ordinal <= asOfOrdinal; ordinal += 1) {
    if (buckets.has(refDayFromOrdinal(ordinal))) trainedLast7 += 1;
  }
  const trainedToday = buckets.has(asOfDay);
  const next = STREAK_MILESTONES.find(milestone => milestone.days > run);

  return {
    asOfDay,
    timeZone,
    days,
    trainedToday,
    currentStreak: run,
    atRisk: run > 0 && !trainedToday,
    longestStreak: longest,
    shieldsAvailable: shields,
    shieldsEarnedTotal: shieldsEarned,
    shieldedDayCount: shieldedDays,
    momentumXp: xpTotal,
    runXp,
    trainedLast7,
    totalTrainedDays: trainedDays,
    totalActivities,
    scoredAnalysisCount,
    earnedIds,
    specialistDetail,
    nextMilestoneDays: next ? next.days : null,
  };
}

// ─── Invariants ────────────────────────────────────────────────────────────

export interface Violation {
  step: number;
  invariant: string;
  detail: string;
}

function projectForCompare(snapshot: ConsistencySnapshot): Omit<
  ConsistencySnapshot,
  'earned'
> & {
  earned: Array<{ id: string; earnedOnDay: string; detail: string | null }>;
} {
  // `earned` order is not part of the documented contract; compare as a set.
  return {
    ...snapshot,
    earned: [...snapshot.earned]
      .map(entry => ({
        id: entry.id,
        earnedOnDay: entry.earnedOnDay,
        detail: entry.detail ?? null,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

export function snapshotFingerprint(snapshot: ConsistencySnapshot): string {
  return stableJson(projectForCompare(snapshot));
}

const MAX_TRAINED_DAY_XP =
  XP_PER_TRAINED_DAY +
  XP_EXTRA_ACTIVITY_CAP +
  STREAK_MILESTONES.reduce((sum, milestone) => sum + milestone.bonusXp, 0);

export function checkSnapshotInvariants(
  step: number,
  world: EngineWorld,
  snapshot: ConsistencySnapshot,
  rng: Rng,
): Violation[] {
  const out: Violation[] = [];
  const fail = (invariant: string, detail: string) =>
    out.push({ step, invariant, detail });

  const ref = referenceSnapshot(world);

  // INV-02 order independence: a shuffled input list yields the same snapshot.
  // `scoreAvg` is compared with a one-tenth tolerance because the engine sums
  // scores in input order and rounds to 1dp (floating-point summation order
  // can flip the rounding at x.x5 boundaries). The strict comparison is kept
  // as its own invariant so the campaign counts those flips separately.
  const shuffled = buildConsistencySnapshot(rng.shuffle(world.activities), {
    asOfIso: new Date(world.asOfMs).toISOString(),
    timeZone: world.timeZone,
  });
  const strictSame =
    snapshotFingerprint(shuffled) === snapshotFingerprint(snapshot);
  if (!strictSame) {
    const relaxed = (value: ConsistencySnapshot) =>
      stableJson({
        ...projectForCompare(value),
        days: Object.fromEntries(
          Object.entries(value.days).map(([key, day]) => [
            key,
            {
              ...day,
              scoreAvg: null,
              activities: day.activities.map(a => stableJson(a)).sort(),
            },
          ]),
        ),
      });
    if (relaxed(shuffled) !== relaxed(snapshot)) {
      fail(
        'INV-02-order-independence',
        'shuffled activities → different snapshot',
      );
    } else {
      const flips: string[] = [];
      const ties: string[] = [];
      for (const [key, day] of Object.entries(snapshot.days)) {
        const other = shuffled.days[key];
        if (!other) continue;
        if (stableJson(day.activities) !== stableJson(other.activities)) {
          const tied = day.activities.filter((a, index) => {
            const b = other.activities[index];
            return b && stableJson(a) !== stableJson(b);
          });
          ties.push(
            `${key}: ${tied.map(a => `${a.kind}@${a.atIso} "${a.label}"`).join(' / ')}`,
          );
        }
        if (day.scoreAvg !== other.scoreAvg) {
          if (
            day.scoreAvg === null ||
            other.scoreAvg === null ||
            Math.abs(day.scoreAvg - other.scoreAvg) > 0.1 + 1e-9
          ) {
            fail(
              'INV-02-order-independence',
              `${key} scoreAvg ${day.scoreAvg} vs shuffled ${other.scoreAvg}`,
            );
          } else {
            flips.push(
              `${key}: ${day.scoreAvg} vs ${other.scoreAvg} (${day.scoredCount} scored)`,
            );
          }
        }
      }
      if (flips.length > 0) {
        fail('INV-02b-scoreAvg-fp-order', flips.join('; '));
      }
      if (ties.length > 0) {
        fail('INV-02c-activity-tie-order', ties.join('; '));
      }
    }
  }

  // INV-03 day/zone resolution.
  if (snapshot.asOfDay !== ref.asOfDay) {
    fail('INV-03-asOfDay', `engine ${snapshot.asOfDay} vs ref ${ref.asOfDay}`);
  }
  if (snapshot.timeZone !== ref.timeZone) {
    fail(
      'INV-03-timeZone',
      `engine ${snapshot.timeZone} vs ref ${ref.timeZone}`,
    );
  }

  // INV-04 activity accounting.
  if (snapshot.totalActivities !== ref.totalActivities) {
    fail(
      'INV-04-totalActivities',
      `engine ${snapshot.totalActivities} vs ref ${ref.totalActivities}`,
    );
  }
  if (snapshot.scoredAnalysisCount !== ref.scoredAnalysisCount) {
    fail(
      'INV-04-scoredAnalysisCount',
      `engine ${snapshot.scoredAnalysisCount} vs ref ${ref.scoredAnalysisCount}`,
    );
  }

  // INV-05 streak bounds.
  if (
    snapshot.currentStreak < 0 ||
    snapshot.currentStreak > snapshot.longestStreak ||
    snapshot.longestStreak > snapshot.totalTrainedDays
  ) {
    fail(
      'INV-05-streak-bounds',
      `current ${snapshot.currentStreak} longest ${snapshot.longestStreak} trained ${snapshot.totalTrainedDays}`,
    );
  }
  if (
    snapshot.trainedLast7 < 0 ||
    snapshot.trainedLast7 > Math.min(7, snapshot.totalTrainedDays)
  ) {
    fail(
      'INV-05-trainedLast7',
      `trainedLast7 ${snapshot.trainedLast7} trained ${snapshot.totalTrainedDays}`,
    );
  }

  // INV-06 shields.
  if (
    snapshot.shieldsAvailable < 0 ||
    snapshot.shieldsAvailable > SHIELD_MAX_HELD
  ) {
    fail('INV-06-shield-cap', `shieldsAvailable ${snapshot.shieldsAvailable}`);
  }
  if (
    snapshot.shieldsAvailable + snapshot.shieldedDayCount >
    snapshot.shieldsEarnedTotal
  ) {
    fail(
      'INV-06-shield-ledger',
      `available ${snapshot.shieldsAvailable} + spent ${snapshot.shieldedDayCount} > earned ${snapshot.shieldsEarnedTotal}`,
    );
  }
  const shieldedDays = Object.values(snapshot.days).filter(day => day.shielded);
  if (shieldedDays.length !== snapshot.shieldedDayCount) {
    fail(
      'INV-06-shielded-days',
      `days shielded ${shieldedDays.length} vs count ${snapshot.shieldedDayCount}`,
    );
  }

  // INV-07 XP accounting.
  let xpSum = 0;
  for (const day of Object.values(snapshot.days)) {
    xpSum += day.xp;
    if (day.shielded) {
      if (
        day.xp !== 0 ||
        day.activities.length !== 0 ||
        day.scoreAvg !== null
      ) {
        fail(
          'INV-07-shielded-xp',
          `${day.day} shielded with xp ${day.xp} / ${day.activities.length} activities`,
        );
      }
    } else if (day.xp < XP_PER_TRAINED_DAY || day.xp > MAX_TRAINED_DAY_XP) {
      fail('INV-07-day-xp-range', `${day.day} xp ${day.xp}`);
    }
  }
  if (xpSum !== snapshot.momentumXp) {
    fail(
      'INV-07-xp-sum',
      `Σ days.xp ${xpSum} vs momentumXp ${snapshot.momentumXp}`,
    );
  }
  if (snapshot.runXp < 0 || snapshot.runXp > snapshot.momentumXp) {
    fail(
      'INV-07-runXp',
      `runXp ${snapshot.runXp} momentumXp ${snapshot.momentumXp}`,
    );
  }
  if (snapshot.currentStreak === 0 && snapshot.runXp !== 0) {
    fail('INV-07-runXp-reset', `runXp ${snapshot.runXp} with no live run`);
  }

  // INV-08 today semantics.
  const today = snapshot.days[snapshot.asOfDay];
  if (snapshot.trainedToday !== (today !== undefined && !today.shielded)) {
    fail(
      'INV-08-trainedToday',
      `trainedToday ${snapshot.trainedToday} but days[today]=${JSON.stringify(today ?? null)}`,
    );
  }
  if (today?.shielded)
    fail('INV-08-today-shielded', 'today rendered as shielded');
  if (
    snapshot.atRisk !== (snapshot.currentStreak > 0 && !snapshot.trainedToday)
  ) {
    fail(
      'INV-08-atRisk',
      `atRisk ${snapshot.atRisk} streak ${snapshot.currentStreak} trainedToday ${snapshot.trainedToday}`,
    );
  }
  for (const key of Object.keys(snapshot.days)) {
    if (key > snapshot.asOfDay)
      fail('INV-08-future-day', `day ${key} after ${snapshot.asOfDay}`);
    if (snapshot.days[key]!.day !== key)
      fail('INV-08-day-key', `days[${key}].day = ${snapshot.days[key]!.day}`);
  }

  // INV-09 per-day detail.
  let activitySum = 0;
  for (const day of Object.values(snapshot.days)) {
    activitySum += day.activities.length;
    const total = day.strokeCount + day.sessionStrokeCount + day.drillCount;
    if (total !== day.activities.length) {
      fail(
        'INV-09-day-counts',
        `${day.day}: counts ${total} vs activities ${day.activities.length}`,
      );
    }
    if (day.scoredCount > day.activities.length) {
      fail(
        'INV-09-scored-le-activities',
        `${day.day}: scored ${day.scoredCount} > ${day.activities.length}`,
      );
    }
    const scores = day.activities
      .map(a => a.score)
      .filter((s): s is number => s !== null);
    if (scores.length !== day.scoredCount) {
      fail(
        'INV-09-scored-count',
        `${day.day}: ${scores.length} scored activities vs scoredCount ${day.scoredCount}`,
      );
    }
    if (day.scoredCount === 0 && day.scoreAvg !== null) {
      fail(
        'INV-09-scoreAvg-null',
        `${day.day}: scoreAvg ${day.scoreAvg} without scored`,
      );
    }
    if (day.scoredCount > 0) {
      const min = Math.min(...scores);
      const max = Math.max(...scores);
      if (
        day.scoreAvg === null ||
        day.scoreAvg < min - 0.05 ||
        day.scoreAvg > max + 0.05
      ) {
        fail(
          'INV-09-scoreAvg-range',
          `${day.day}: avg ${day.scoreAvg} outside [${min}, ${max}]`,
        );
      }
    }
    for (const activity of day.activities) {
      const atMs = Date.parse(activity.atIso);
      const localDay = refDayKey(atMs, world.timeZone);
      if (localDay !== day.day) {
        fail(
          'INV-09-activity-day',
          `${activity.atIso} bucketed to ${day.day}, local day is ${localDay} (${ref.timeZone})`,
        );
      }
      if (!activity.label)
        fail('INV-09-label', `${activity.atIso} has empty label`);
    }
    for (let index = 1; index < day.activities.length; index += 1) {
      if (day.activities[index - 1]!.atIso > day.activities[index]!.atIso) {
        fail(
          'INV-09-activity-order',
          `${day.day}: activities not chronological`,
        );
      }
    }
  }
  if (activitySum !== snapshot.totalActivities) {
    fail(
      'INV-09-activity-total',
      `Σ day activities ${activitySum} vs totalActivities ${snapshot.totalActivities}`,
    );
  }
  const trainedDayCount = Object.values(snapshot.days).filter(
    day => !day.shielded,
  ).length;
  if (trainedDayCount !== snapshot.totalTrainedDays) {
    fail(
      'INV-09-trained-days',
      `trained day entries ${trainedDayCount} vs totalTrainedDays ${snapshot.totalTrainedDays}`,
    );
  }

  // INV-10 earned achievements.
  const ids = snapshot.earned.map(entry => entry.id);
  if (new Set(ids).size !== ids.length)
    fail('INV-10-earned-unique', `duplicate earned ids ${ids.join(',')}`);
  for (const milestone of STREAK_MILESTONES) {
    const has = ids.includes(milestone.id);
    if (has !== snapshot.longestStreak >= milestone.days) {
      fail(
        'INV-10-streak-milestone',
        `${milestone.id} earned=${has} longestStreak=${snapshot.longestStreak}`,
      );
    }
  }
  const has100 = ids.includes(VOLUME_ACHIEVEMENTS.sessions100.id);
  if (
    has100 !==
    snapshot.totalActivities >= VOLUME_ACHIEVEMENTS.sessions100.threshold
  ) {
    fail(
      'INV-10-sessions100',
      `earned=${has100} totalActivities=${snapshot.totalActivities}`,
    );
  }
  const hasSpecialist = ids.includes(VOLUME_ACHIEVEMENTS.specialist.id);
  if (hasSpecialist !== (ref.specialistDetail !== null)) {
    fail(
      'INV-10-specialist',
      `earned=${hasSpecialist} ref=${ref.specialistDetail}`,
    );
  }
  for (const entry of snapshot.earned) {
    if (entry.earnedOnDay > snapshot.asOfDay) {
      fail(
        'INV-10-earnedOnDay-future',
        `${entry.id} on ${entry.earnedOnDay} > ${snapshot.asOfDay}`,
      );
    }
    if (
      entry.id.startsWith('streak.') ||
      entry.id === VOLUME_ACHIEVEMENTS.sessions100.id
    ) {
      const day = snapshot.days[entry.earnedOnDay];
      if (!day || day.shielded) {
        fail(
          'INV-10-earnedOnDay-trained',
          `${entry.id} earned on ${entry.earnedOnDay} which is not a trained day`,
        );
      }
    }
    if (
      entry.id === VOLUME_ACHIEVEMENTS.specialist.id &&
      entry.detail !== ref.specialistDetail
    ) {
      fail(
        'INV-10-specialist-detail',
        `engine ${entry.detail} vs ref ${ref.specialistDetail}`,
      );
    }
  }

  // INV-11 next milestone.
  const expectedNext =
    STREAK_MILESTONES.find(m => m.days > snapshot.currentStreak) ?? null;
  if (
    (snapshot.nextStreakMilestone?.id ?? null) !== (expectedNext?.id ?? null)
  ) {
    fail(
      'INV-11-next-milestone',
      `next ${snapshot.nextStreakMilestone?.id ?? null} vs expected ${expectedNext?.id ?? null}`,
    );
  } else if (
    snapshot.nextStreakMilestone &&
    expectedNext &&
    snapshot.nextStreakMilestone.daysAway !==
      expectedNext.days - snapshot.currentStreak
  ) {
    fail(
      'INV-11-daysAway',
      `daysAway ${snapshot.nextStreakMilestone.daysAway} vs ${expectedNext.days - snapshot.currentStreak}`,
    );
  }

  // INV-12 momentum level.
  const level = momentumLevelForXp(snapshot.momentumXp);
  if (stableJson(level) !== stableJson(snapshot.momentum)) {
    fail(
      'INV-12-momentum-level',
      `momentum ${stableJson(snapshot.momentum)} vs ${stableJson(level)}`,
    );
  }
  if (
    snapshot.momentum.xpIntoLevel < 0 ||
    snapshot.momentum.xpIntoLevel >= snapshot.momentum.xpForNextLevel ||
    snapshot.momentum.level < 1
  ) {
    fail('INV-12-momentum-range', stableJson(snapshot.momentum));
  }

  // INV-16 independent reference model agreement.
  const refView = {
    ...ref,
    days: Object.fromEntries(
      Object.entries(ref.days).map(([key, day]) => [key, { ...day }]),
    ),
  };
  const engineView: RefSnapshot = {
    asOfDay: snapshot.asOfDay,
    timeZone: snapshot.timeZone,
    days: Object.fromEntries(
      Object.entries(snapshot.days).map(([key, day]) => [
        key,
        {
          day: day.day,
          shielded: day.shielded,
          strokeCount: day.strokeCount,
          sessionStrokeCount: day.sessionStrokeCount,
          drillCount: day.drillCount,
          scoredCount: day.scoredCount,
          scoreAvg: day.scoreAvg,
          xp: day.xp,
          activityCount: day.activities.length,
        },
      ]),
    ),
    trainedToday: snapshot.trainedToday,
    currentStreak: snapshot.currentStreak,
    atRisk: snapshot.atRisk,
    longestStreak: snapshot.longestStreak,
    shieldsAvailable: snapshot.shieldsAvailable,
    shieldsEarnedTotal: snapshot.shieldsEarnedTotal,
    shieldedDayCount: snapshot.shieldedDayCount,
    momentumXp: snapshot.momentumXp,
    runXp: snapshot.runXp,
    trainedLast7: snapshot.trainedLast7,
    totalTrainedDays: snapshot.totalTrainedDays,
    totalActivities: snapshot.totalActivities,
    scoredAnalysisCount: snapshot.scoredAnalysisCount,
    earnedIds: [...ids].sort(),
    specialistDetail:
      snapshot.earned.find(e => e.id === VOLUME_ACHIEVEMENTS.specialist.id)
        ?.detail ?? null,
    nextMilestoneDays: snapshot.nextStreakMilestone?.days ?? null,
  };
  refView.earnedIds = [...ref.earnedIds].sort();
  if (stableJson(engineView) !== stableJson(refView)) {
    const diffs: string[] = [];
    for (const key of Object.keys(refView) as (keyof RefSnapshot)[]) {
      const a = stableJson(engineView[key]);
      const b = stableJson(refView[key]);
      if (a !== b)
        diffs.push(`${key}: engine=${a.slice(0, 300)} ref=${b.slice(0, 300)}`);
    }
    fail('INV-16-reference-model', diffs.join(' | '));
  }

  return out;
}

export function checkTransitionInvariants(
  step: number,
  action: EngineAction,
  before: ConsistencySnapshot,
  after: ConsistencySnapshot,
  beforeWorld: EngineWorld,
  afterWorld: EngineWorld,
): Violation[] {
  const out: Violation[] = [];
  const fail = (invariant: string, detail: string) =>
    out.push({ step, invariant, detail });
  const beforeIds = new Set(before.earned.map(e => e.id));
  const afterIds = new Set(after.earned.map(e => e.id));
  const supersetOfEarned = () => {
    for (const id of beforeIds) {
      if (!afterIds.has(id)) return false;
    }
    return true;
  };

  if (action.type === 'add' || action.type === 'addRun') {
    // INV-14: adding evidence at a fixed clock/zone never takes anything away.
    const added = action.type === 'add' ? [action.input] : action.inputs;
    const nowValid = added.filter(input => {
      const atMs = Date.parse(input.atIso);
      return Number.isFinite(atMs) && atMs <= afterWorld.asOfMs;
    }).length;
    if (after.totalActivities !== before.totalActivities + nowValid) {
      fail(
        'INV-14-add-count',
        `totalActivities ${before.totalActivities} → ${after.totalActivities} after adding ${nowValid} valid`,
      );
    }
    if (
      after.totalTrainedDays < before.totalTrainedDays ||
      after.totalTrainedDays > before.totalTrainedDays + nowValid
    ) {
      fail(
        'INV-14-add-trained-days',
        `${before.totalTrainedDays} → ${after.totalTrainedDays}`,
      );
    }
    if (after.momentumXp < before.momentumXp)
      fail(
        'INV-14-add-xp',
        `momentumXp ${before.momentumXp} → ${after.momentumXp}`,
      );
    // Shields are banked at run % 7 === 0 over TRAINED days only and capped
    // at two, so training on a day that used to be shield-bridged shifts the
    // earn phase of the whole run: a later gap that was bridged before may
    // now break the run. Longest streak / shields earned are therefore not
    // monotone in the evidence — recorded separately as INV-14b.
    if (
      after.longestStreak < before.longestStreak ||
      after.shieldsEarnedTotal < before.shieldsEarnedTotal
    )
      fail(
        'INV-14b-add-shield-phase',
        `longest ${before.longestStreak} → ${after.longestStreak}, shieldsEarned ${before.shieldsEarnedTotal} → ${after.shieldsEarnedTotal}, shieldedDays ${before.shieldedDayCount} → ${after.shieldedDayCount}`,
      );
    if (after.scoredAnalysisCount < before.scoredAnalysisCount)
      fail(
        'INV-14-add-scored',
        `${before.scoredAnalysisCount} → ${after.scoredAnalysisCount}`,
      );
    if (!supersetOfEarned())
      fail(
        'INV-14-add-earned',
        `earned shrank: ${[...beforeIds].join(',')} → ${[...afterIds].join(',')}`,
      );
    if (after.currentStreak < before.currentStreak)
      fail(
        'INV-14-add-current-streak',
        `${before.currentStreak} → ${after.currentStreak}`,
      );
  }

  if (action.type === 'advance') {
    // INV-13: time moving forward only ever closes days.
    const newlyInRange = afterWorld.activities.filter(input => {
      const atMs = Date.parse(input.atIso);
      return (
        Number.isFinite(atMs) &&
        atMs > beforeWorld.asOfMs &&
        atMs <= afterWorld.asOfMs
      );
    }).length;
    if (after.totalActivities !== before.totalActivities + newlyInRange) {
      fail(
        'INV-13-advance-count',
        `totalActivities ${before.totalActivities} → ${after.totalActivities}, ${newlyInRange} newly in range`,
      );
    }
    if (after.longestStreak < before.longestStreak)
      fail(
        'INV-13-advance-longest',
        `${before.longestStreak} → ${after.longestStreak}`,
      );
    if (after.totalTrainedDays < before.totalTrainedDays)
      fail(
        'INV-13-advance-trained',
        `${before.totalTrainedDays} → ${after.totalTrainedDays}`,
      );
    if (after.momentumXp < before.momentumXp)
      fail('INV-13-advance-xp', `${before.momentumXp} → ${after.momentumXp}`);
    if (after.shieldsEarnedTotal < before.shieldsEarnedTotal)
      fail(
        'INV-13-advance-shields',
        `${before.shieldsEarnedTotal} → ${after.shieldsEarnedTotal}`,
      );
    if (after.shieldedDayCount < before.shieldedDayCount)
      fail(
        'INV-13-advance-shielded-days',
        `${before.shieldedDayCount} → ${after.shieldedDayCount}`,
      );
    if (!supersetOfEarned()) fail('INV-13-advance-earned', `earned shrank`);
    if (newlyInRange === 0) {
      if (
        after.currentStreak !== before.currentStreak &&
        after.currentStreak !== 0
      ) {
        fail(
          'INV-13-advance-streak',
          `currentStreak ${before.currentStreak} → ${after.currentStreak} without new evidence`,
        );
      }
      if (after.shieldsAvailable > before.shieldsAvailable) {
        fail(
          'INV-13-advance-shields-available',
          `${before.shieldsAvailable} → ${after.shieldsAvailable} without new evidence`,
        );
      }
      if (after.trainedLast7 > before.trainedLast7) {
        fail(
          'INV-13-advance-last7',
          `${before.trainedLast7} → ${after.trainedLast7} without new evidence`,
        );
      }
    }
  }

  if (action.type === 'setZone') {
    // INV-17: the zone changes bucketing, never which instants count.
    if (after.totalActivities !== before.totalActivities) {
      fail(
        'INV-17-zone-count',
        `totalActivities ${before.totalActivities} → ${after.totalActivities}`,
      );
    }
    if (after.scoredAnalysisCount !== before.scoredAnalysisCount) {
      fail(
        'INV-17-zone-scored',
        `${before.scoredAnalysisCount} → ${after.scoredAnalysisCount}`,
      );
    }
  }

  return out;
}

// ─── Sequence runner ───────────────────────────────────────────────────────

export interface EngineStepRecord {
  step: number;
  action: string;
  asOfIso: string;
  timeZone: string;
  activities: number;
  fingerprint: string;
}

export interface EngineSequenceResult {
  seed: number;
  length: number;
  violations: Violation[];
  trace: EngineStepRecord[];
  traceHash: string;
  maxStreak: number;
  maxActivities: number;
  zones: string[];
}

export function describeAction(action: EngineAction): string {
  switch (action.type) {
    case 'add':
      return `add ${action.input.kind}@${action.input.atIso}${action.input.resultKind ? ` ${action.input.resultKind}` : ''}`;
    case 'addRun':
      return `addRun ×${action.inputs.length} (${action.inputs[0]?.atIso ?? '?'} … ${action.inputs[action.inputs.length - 1]?.atIso ?? '?'})`;
    case 'advance':
      return `advance +${action.ms}ms`;
    case 'jumpBack':
      return `jumpBack -${action.ms}ms`;
    case 'setClock':
      return `setClock ${action.iso}`;
    case 'setZone':
      return `setZone ${JSON.stringify(action.timeZone)}`;
  }
}

export function buildSnapshotFor(world: EngineWorld): ConsistencySnapshot {
  return buildConsistencySnapshot(world.activities, {
    asOfIso: new Date(world.asOfMs).toISOString(),
    timeZone: world.timeZone,
  });
}

/** Executes a materialized action list from a fresh copy of `start`. */
export function runEngineActions(
  seed: number,
  start: EngineWorld,
  actions: readonly EngineAction[],
  options: {
    stopAtFirstViolation?: boolean;
    /** Stop as soon as a violation matching this predicate is recorded. */
    stopWhen?: (violation: Violation) => boolean;
    checkInvariants?: boolean;
  } = {},
): EngineSequenceResult {
  const checkInvariants = options.checkInvariants ?? true;
  const stopWhen = options.stopWhen;
  const checkRng = new Rng(seed ^ 0x5bd1e995);
  const world: EngineWorld = { ...start, activities: [...start.activities] };
  const violations: Violation[] = [];
  const trace: EngineStepRecord[] = [];
  const zones = new Set<string>([world.timeZone]);
  let maxStreak = 0;
  let maxActivities = 0;

  let previous: ConsistencySnapshot;
  try {
    previous = buildSnapshotFor(world);
    if (checkInvariants) {
      violations.push(...checkSnapshotInvariants(0, world, previous, checkRng));
    }
  } catch (error) {
    violations.push({
      step: 0,
      invariant: 'INV-01-no-throw',
      detail: String(error),
    });
    return {
      seed,
      length: actions.length,
      violations,
      trace,
      traceHash: '',
      maxStreak,
      maxActivities,
      zones: [...zones],
    };
  }
  trace.push({
    step: 0,
    action: 'init',
    asOfIso: new Date(world.asOfMs).toISOString(),
    timeZone: world.timeZone,
    activities: 0,
    fingerprint: snapshotFingerprint(previous),
  });

  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index]!;
    const step = index + 1;
    const beforeWorld: EngineWorld = {
      ...world,
      activities: [...world.activities],
    };
    applyAction(world, action);
    zones.add(world.timeZone);
    let snapshot: ConsistencySnapshot;
    try {
      snapshot = buildSnapshotFor(world);
    } catch (error) {
      violations.push({
        step,
        invariant: 'INV-01-no-throw',
        detail: `${describeAction(action)} → ${String(error)}`,
      });
      break;
    }
    maxStreak = Math.max(maxStreak, snapshot.longestStreak);
    maxActivities = Math.max(maxActivities, snapshot.totalActivities);
    trace.push({
      step,
      action: describeAction(action),
      asOfIso: new Date(world.asOfMs).toISOString(),
      timeZone: world.timeZone,
      activities: world.activities.length,
      fingerprint: snapshotFingerprint(snapshot),
    });
    const stepViolations = checkInvariants
      ? [
          ...checkSnapshotInvariants(step, world, snapshot, checkRng),
          ...checkTransitionInvariants(
            step,
            action,
            previous,
            snapshot,
            beforeWorld,
            world,
          ),
        ]
      : [];
    violations.push(...stepViolations);
    previous = snapshot;
    if (options.stopAtFirstViolation && stepViolations.length > 0) break;
    if (stopWhen && stepViolations.some(stopWhen)) break;
  }

  return {
    seed,
    length: actions.length,
    violations,
    trace,
    traceHash: stableJson(trace.map(t => t.fingerprint)),
    maxStreak,
    maxActivities,
    zones: [...zones],
  };
}

export interface EngineSequence {
  seed: number;
  start: EngineWorld;
  actions: EngineAction[];
}

export function generateEngineSequence(
  seed: number,
  minLength = 5,
  maxLength = 60,
): EngineSequence {
  const rng = new Rng(seed);
  const start = initialWorld(rng);
  const length = rng.int(minLength, maxLength);
  const actions = generateActions(rng, start, length);
  return { seed, start, actions };
}
