/**
 * STRESS / failure-injection — consistency engine + milestones under
 * timezones, DST transitions, clock jumps and malformed input.
 *
 * Every seed builds a random activity history (shots, session strokes,
 * drills) with timestamps deliberately placed on local-midnight edges, inside
 * DST gaps and repeated hours, across extreme offsets (UTC-12 … UTC+14,
 * half/quarter-hour zones, Lord Howe's 30-minute DST) and with corrupted
 * rows mixed in (unparseable / empty / numeric / future timestamps, NaN /
 * string / infinite scores, unknown result kinds). The engine's snapshot is
 * compared against an independent oracle written from the rules in
 * milestones.ts (gap-based streak walk, not a day-by-day loop).
 *
 * Replay: `STRESS_SEED=<seed> npx jest --ci consistencyEngine.oracle`.
 * STRESS_ITER=<n> sets the campaign size (default 60).
 */
import {
  buildConsistencySnapshot,
  dayFromOrdinal,
  dayOrdinal,
  type ConsistencySnapshot,
  type TrainingActivityInput,
} from '../../src/consistency/engine';
import {
  SHIELD_EARN_EVERY_DAYS,
  SHIELD_MAX_HELD,
  STREAK_MILESTONES,
  VOLUME_ACHIEVEMENTS,
  XP_EXTRA_ACTIVITY_CAP,
  XP_PER_EXTRA_ACTIVITY,
  XP_PER_TRAINED_DAY,
} from '../../src/consistency/milestones';
import {
  summarizeRows,
  writeJsonArtifact,
  type StressRow,
} from '../../test-support/stress/consistency/artifacts';
import {
  campaignSeeds,
  chance,
  int,
  makePrng,
  pick,
  shuffle,
  weighted,
  type Rng,
} from '../../test-support/stress/consistency/prng';
import {
  DST_EDGE_INSTANTS,
  dayKeyIn,
  STRESS_ZONES,
  zoneIsValid,
} from '../../test-support/stress/consistency/deviceShim';
import { nodeProcess } from '../../xc-harness/lifecycle-persistence/nodeShim';

const DAY_MS = 86_400_000;
const RealDate = Date;

// ---------------------------------------------------------------------------
// Oracle — independent of engine.ts. Day keys → ordinals through
// Date.UTC/setUTCFullYear (engine uses Date.parse), streak via sorted gaps
// (engine walks every day).
// ---------------------------------------------------------------------------

function oracleOrdinal(dayKey: string): number | null {
  const match = /^(-?\d+)-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) return null;
  const date = new Date(0);
  date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const ms = date.getTime();
  return Number.isFinite(ms) ? Math.floor(ms / DAY_MS) : null;
}

interface OracleDay {
  count: number;
  scored: number;
  scoreSum: number;
  drills: number;
}

interface OracleResult {
  asOfDay: string;
  currentStreak: number;
  longestStreak: number;
  shieldsAvailable: number;
  shieldsEarnedTotal: number;
  shieldedDayCount: number;
  momentumXp: number;
  totalTrainedDays: number;
  totalActivities: number;
  scoredAnalysisCount: number;
  trainedToday: boolean;
  atRisk: boolean;
  trainedLast7: number;
  earnedIds: string[];
  nextMilestoneDays: number | null;
  shieldedDays: string[];
  trainedDays: string[];
}

function oracleSnapshot(
  activities: readonly TrainingActivityInput[],
  zone: string,
  asOfIso: string,
  nowMs: number,
): OracleResult {
  const effectiveZone = zoneIsValid(zone) ? zone : 'UTC';
  const asOfMsRaw = Date.parse(asOfIso);
  const asOfMs = Number.isFinite(asOfMsRaw) ? asOfMsRaw : nowMs;
  const asOfDay = dayKeyIn(effectiveZone, asOfMs);
  const asOfOrdinal = oracleOrdinal(asOfDay)!;

  const byDay = new Map<string, OracleDay>();
  const scoredByTechnique = new Map<string, number>();
  let totalActivities = 0;
  let scoredAnalysisCount = 0;
  for (const activity of activities) {
    const atMs = Date.parse(activity.atIso);
    if (!Number.isFinite(atMs)) continue;
    if (Number.isFinite(asOfMsRaw) && atMs > asOfMsRaw) continue;
    const day = dayKeyIn(effectiveZone, atMs);
    const ordinal = oracleOrdinal(day);
    if (ordinal === null || ordinal > asOfOrdinal) continue;
    const bucket = byDay.get(day) ?? {
      count: 0,
      scored: 0,
      scoreSum: 0,
      drills: 0,
    };
    bucket.count += 1;
    if (activity.kind === 'drill') bucket.drills += 1;
    const scored =
      activity.resultKind === 'scored' &&
      typeof activity.overallScore === 'number' &&
      Number.isFinite(activity.overallScore);
    if (scored) {
      bucket.scored += 1;
      bucket.scoreSum += activity.overallScore as number;
      scoredAnalysisCount += 1;
      if (activity.shotType) {
        scoredByTechnique.set(
          activity.shotType,
          (scoredByTechnique.get(activity.shotType) ?? 0) + 1,
        );
      }
    }
    totalActivities += 1;
    byDay.set(day, bucket);
  }

  const trained = [...byDay.entries()]
    .map(([day, bucket]) => ({ day, ordinal: oracleOrdinal(day)!, bucket }))
    .sort((a, b) => a.ordinal - b.ordinal);

  let run = 0;
  let longest = 0;
  let shields = 0;
  let shieldsEarnedTotal = 0;
  let shieldedDayCount = 0;
  let xp = 0;
  let cumulative = 0;
  const awarded = new Set<number>();
  const earnedIds: string[] = [];
  const shieldedDays: string[] = [];
  let sessions100 = false;

  const miss = (fromOrdinalExclusive: number, toOrdinalExclusive: number) => {
    for (
      let ordinal = fromOrdinalExclusive + 1;
      ordinal < toOrdinalExclusive;
      ordinal += 1
    ) {
      if (run === 0) continue;
      if (shields > 0) {
        shields -= 1;
        shieldedDayCount += 1;
        shieldedDays.push(dayFromOrdinalUtc(ordinal));
      } else {
        run = 0;
      }
    }
  };

  let previous: number | null = null;
  for (const entry of trained) {
    if (previous !== null) miss(previous, entry.ordinal);
    run += 1;
    if (run > longest) longest = run;
    let dayXp =
      XP_PER_TRAINED_DAY +
      Math.min(
        (entry.bucket.count - 1) * XP_PER_EXTRA_ACTIVITY,
        XP_EXTRA_ACTIVITY_CAP,
      );
    for (const milestone of STREAK_MILESTONES) {
      if (run === milestone.days && !awarded.has(milestone.days)) {
        awarded.add(milestone.days);
        dayXp += milestone.bonusXp;
        earnedIds.push(milestone.id);
      }
    }
    xp += dayXp;
    if (run % SHIELD_EARN_EVERY_DAYS === 0) {
      shieldsEarnedTotal += 1;
      shields = Math.min(shields + 1, SHIELD_MAX_HELD);
    }
    cumulative += entry.bucket.count;
    if (
      !sessions100 &&
      cumulative >= VOLUME_ACHIEVEMENTS.sessions100.threshold
    ) {
      sessions100 = true;
      earnedIds.push(VOLUME_ACHIEVEMENTS.sessions100.id);
    }
    previous = entry.ordinal;
  }
  if (previous !== null) miss(previous, asOfOrdinal);

  const specialist = [...scoredByTechnique.entries()]
    .filter(([, count]) => count >= VOLUME_ACHIEVEMENTS.specialist.threshold)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (specialist) earnedIds.push(VOLUME_ACHIEVEMENTS.specialist.id);

  const trainedToday = byDay.has(asOfDay);
  let trainedLast7 = 0;
  for (const entry of trained) {
    if (entry.ordinal >= asOfOrdinal - 6 && entry.ordinal <= asOfOrdinal)
      trainedLast7 += 1;
  }
  const next = STREAK_MILESTONES.find(m => m.days > run) ?? null;

  return {
    asOfDay,
    currentStreak: run,
    longestStreak: longest,
    shieldsAvailable: shields,
    shieldsEarnedTotal,
    shieldedDayCount,
    momentumXp: xp,
    totalTrainedDays: trained.length,
    totalActivities,
    scoredAnalysisCount,
    trainedToday,
    atRisk: run > 0 && !trainedToday,
    trainedLast7,
    earnedIds,
    nextMilestoneDays: next ? next.days : null,
    shieldedDays,
    trainedDays: trained.map(entry => entry.day),
  };
}

function dayFromOrdinalUtc(ordinal: number): string {
  const date = new Date(ordinal * DAY_MS);
  const year = date.getUTCFullYear();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${String(year).padStart(4, '0')}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const SHOT_TYPES = [
  'dink',
  'forehand_drive',
  'serve',
  'third_shot_drop',
  'backhand_volley',
];
const MALFORMED_AT = [
  '',
  'not-a-date',
  'null',
  '2026-13-45T00:00:00Z',
  '2026-02-30T12:00:00Z',
  'NaN',
  '   ',
  '1e12',
  '2026-06-30T23:59:60.000Z',
  'Tuesday',
];

type Fault = string;

interface Generated {
  activities: TrainingActivityInput[];
  faults: Fault[];
  edgeInstants: number;
}

/** Instants around local midnight of `day` in `zone`, found by search so the
 * generator does not depend on any offset table. */
function localMidnightMs(zone: string, dayKey: string): number | null {
  // Find any instant inside the day, then bisect back to its first ms.
  const ordinal = oracleOrdinal(dayKey);
  if (ordinal === null) return null;
  const noonUtc = ordinal * DAY_MS + 12 * 3_600_000;
  let inside: number | null = null;
  for (const delta of [0, -14, 14, -12, 12, -10, 10, -6, 6, -3, 3]) {
    const candidate = noonUtc + delta * 3_600_000;
    if (dayKeyIn(zone, candidate) === dayKey) {
      inside = candidate;
      break;
    }
  }
  if (inside === null) return null;
  let lo = inside - DAY_MS - 3_600_000;
  let hi = inside;
  // Invariant: dayKeyIn(hi) === dayKey, dayKeyIn(lo) !== dayKey.
  if (dayKeyIn(zone, lo) === dayKey) return null;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (dayKeyIn(zone, mid) === dayKey) hi = mid;
    else lo = mid;
  }
  return hi;
}

function generate(rng: Rng, zone: string, asOfMs: number): Generated {
  const effectiveZone = zoneIsValid(zone) ? zone : 'UTC';
  const asOfDay = dayKeyIn(effectiveZone, asOfMs);
  const asOfOrdinal = oracleOrdinal(asOfDay)!;
  const activities: TrainingActivityInput[] = [];
  const faults: Fault[] = [];
  let edgeInstants = 0;
  const span = weighted(rng, [
    [int(rng, 1, 10), 3],
    [int(rng, 10, 45), 3],
    [int(rng, 45, 130), 2],
    [int(rng, 300, 400), 1],
  ]);
  const density = pick(rng, [0.95, 0.8, 0.6, 0.35]);
  let idCounter = 0;
  for (let back = 0; back < span; back += 1) {
    if (!chance(rng, density)) continue;
    const ordinal = asOfOrdinal - back;
    const dayKey = dayFromOrdinalUtc(ordinal);
    const midnight = localMidnightMs(effectiveZone, dayKey);
    const nextMidnight = localMidnightMs(
      effectiveZone,
      dayFromOrdinalUtc(ordinal + 1),
    );
    if (midnight === null || nextMidnight === null) continue;
    const count = weighted(rng, [
      [1, 4],
      [2, 3],
      [int(rng, 3, 6), 2],
      [int(rng, 7, 15), 1],
    ]);
    for (let i = 0; i < count; i += 1) {
      const placement = weighted(rng, [
        ['anywhere', 5],
        ['first-ms', 1],
        ['last-ms', 1],
        ['second-after-midnight', 1],
        ['second-before-next-midnight', 1],
        ['dst-hour', 1],
      ]);
      let ms: number;
      switch (placement) {
        case 'first-ms':
          ms = midnight;
          edgeInstants += 1;
          break;
        case 'last-ms':
          ms = nextMidnight - 1;
          edgeInstants += 1;
          break;
        case 'second-after-midnight':
          ms = midnight + 1_000;
          edgeInstants += 1;
          break;
        case 'second-before-next-midnight':
          ms = nextMidnight - 1_000;
          edgeInstants += 1;
          break;
        case 'dst-hour':
          // 01:00–03:59 local: the hours DST transitions skip or repeat.
          ms = midnight + int(rng, 60, 239) * 60_000;
          edgeInstants += 1;
          break;
        default:
          ms = midnight + int(rng, 0, nextMidnight - midnight - 1);
      }
      if (ms > asOfMs) {
        // Generated inside "today" but after the as-of instant: legitimate
        // future-skip case the oracle also applies.
        faults.push('future-in-today');
      }
      const kind = pick(rng, [
        'stroke',
        'stroke',
        'session_stroke',
        'drill',
      ] as const);
      idCounter += 1;
      if (kind === 'drill') {
        activities.push({
          kind,
          atIso: new Date(ms).toISOString(),
          label: `Drill ${idCounter}`,
        });
      } else {
        const scoredRoll = rng();
        const shotType = pick(rng, SHOT_TYPES);
        if (scoredRoll < 0.7) {
          activities.push({
            kind,
            atIso: new Date(ms).toISOString(),
            shotType,
            overallScore: Math.round((2 + rng() * 8) * 10) / 10,
            resultKind: 'scored',
          });
        } else if (scoredRoll < 0.85) {
          activities.push({
            kind,
            atIso: new Date(ms).toISOString(),
            shotType,
            overallScore: null,
            resultKind: 'low_confidence',
          });
        } else {
          // Malformed score / kind combinations.
          const variant = pick(rng, [
            'nan-score',
            'string-score',
            'infinite-score',
            'scored-null',
            'unknown-kind',
          ]);
          faults.push(`malformed-score:${variant}`);
          const base = { kind, atIso: new Date(ms).toISOString(), shotType };
          switch (variant) {
            case 'nan-score':
              activities.push({
                ...base,
                overallScore: Number.NaN,
                resultKind: 'scored',
              });
              break;
            case 'string-score':
              activities.push({
                ...base,
                overallScore: '7.5' as unknown as number,
                resultKind: 'scored',
              });
              break;
            case 'infinite-score':
              activities.push({
                ...base,
                overallScore: Number.POSITIVE_INFINITY,
                resultKind: 'scored',
              });
              break;
            case 'scored-null':
              activities.push({
                ...base,
                overallScore: null,
                resultKind: 'scored',
              });
              break;
            default:
              activities.push({
                ...base,
                overallScore: 6.1,
                resultKind: 'mystery' as never,
              });
          }
        }
      }
    }
  }
  // Corrupted timestamps and future rows.
  const corruptCount = weighted(rng, [
    [0, 3],
    [int(rng, 1, 3), 4],
    [int(rng, 4, 8), 1],
  ]);
  for (let i = 0; i < corruptCount; i += 1) {
    const variant = weighted(rng, [
      ['unparseable', 4],
      ['future-1d', 2],
      ['future-1y', 1],
      ['future-1s', 2],
      ['epoch-0', 1],
      ['year-2099', 1],
    ]);
    faults.push(`malformed-at:${variant}`);
    let atIso: string;
    switch (variant) {
      case 'unparseable':
        atIso = pick(rng, MALFORMED_AT);
        break;
      case 'future-1d':
        atIso = new Date(asOfMs + DAY_MS).toISOString();
        break;
      case 'future-1y':
        atIso = new Date(asOfMs + 365 * DAY_MS).toISOString();
        break;
      case 'future-1s':
        atIso = new Date(asOfMs + 1_000).toISOString();
        break;
      case 'epoch-0':
        atIso = '1970-01-01T00:00:00.000Z';
        break;
      default:
        atIso = '2099-12-31T23:59:59.000Z';
    }
    activities.push({
      kind: 'stroke',
      atIso,
      shotType: 'dink',
      overallScore: 5,
      resultKind: 'scored',
    });
  }
  return { activities: shuffle(rng, activities), faults, edgeInstants };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

function compare(
  snapshot: ConsistencySnapshot,
  expected: OracleResult,
): { invariants: Record<string, boolean>; details: string[] } {
  const details: string[] = [];
  const check = (name: string, actual: unknown, wanted: unknown) => {
    const ok = JSON.stringify(actual) === JSON.stringify(wanted);
    if (!ok)
      details.push(
        `${name}: engine=${JSON.stringify(actual)} oracle=${JSON.stringify(wanted)}`,
      );
    return ok;
  };
  const trainedDays = Object.values(snapshot.days)
    .filter(day => !day.shielded)
    .map(day => day.day)
    .sort();
  const shieldedDays = Object.values(snapshot.days)
    .filter(day => day.shielded)
    .map(day => day.day)
    .sort();
  const invariants: Record<string, boolean> = {
    as_of_day: check('asOfDay', snapshot.asOfDay, expected.asOfDay),
    day_bucketing: check(
      'trainedDays',
      trainedDays,
      [...expected.trainedDays].sort(),
    ),
    current_streak: check(
      'currentStreak',
      snapshot.currentStreak,
      expected.currentStreak,
    ),
    longest_streak: check(
      'longestStreak',
      snapshot.longestStreak,
      expected.longestStreak,
    ),
    shields: check(
      'shields',
      [
        snapshot.shieldsAvailable,
        snapshot.shieldsEarnedTotal,
        snapshot.shieldedDayCount,
        shieldedDays,
      ],
      [
        expected.shieldsAvailable,
        expected.shieldsEarnedTotal,
        expected.shieldedDayCount,
        [...expected.shieldedDays].sort(),
      ],
    ),
    momentum_xp: check('momentumXp', snapshot.momentumXp, expected.momentumXp),
    totals: check(
      'totals',
      [
        snapshot.totalTrainedDays,
        snapshot.totalActivities,
        snapshot.scoredAnalysisCount,
      ],
      [
        expected.totalTrainedDays,
        expected.totalActivities,
        expected.scoredAnalysisCount,
      ],
    ),
    today_flags: check(
      'todayFlags',
      [snapshot.trainedToday, snapshot.atRisk, snapshot.trainedLast7],
      [expected.trainedToday, expected.atRisk, expected.trainedLast7],
    ),
    earned: check(
      'earned',
      [...snapshot.earned.map(e => e.id)].sort(),
      [...expected.earnedIds].sort(),
    ),
    next_milestone: check(
      'nextMilestone',
      snapshot.nextStreakMilestone?.days ?? null,
      expected.nextMilestoneDays,
    ),
    earned_once:
      snapshot.earned.length === new Set(snapshot.earned.map(e => e.id)).size,
    // Semantic sanity independent of the oracle.
    trained_today_implies_streak:
      !snapshot.trainedToday || snapshot.currentStreak >= 1,
    day_xp_sums:
      Object.values(snapshot.days).reduce((sum, day) => sum + day.xp, 0) ===
      snapshot.momentumXp,
    ordinal_roundtrip: Object.keys(snapshot.days).every(
      day => dayFromOrdinal(dayOrdinal(day)) === day,
    ),
  };
  if (!invariants.earned_once)
    details.push('earned_once: duplicate achievement ids');
  if (!invariants.trained_today_implies_streak)
    details.push(
      `trained_today_implies_streak: streak=${snapshot.currentStreak}`,
    );
  if (!invariants.day_xp_sums)
    details.push('day_xp_sums: Σ days[].xp ≠ momentumXp');
  if (!invariants.ordinal_roundtrip)
    details.push(
      'ordinal_roundtrip: a day key does not survive dayOrdinal/dayFromOrdinal',
    );
  return { invariants, details };
}

function runSeed(seed: number): StressRow {
  const started = RealDate.now();
  const rng = makePrng(seed);
  const zone = pick(rng, STRESS_ZONES);
  const asOfIso = chance(rng, 0.5)
    ? pick(rng, DST_EDGE_INSTANTS)
    : new Date(
        Date.UTC(
          int(rng, 2024, 2028),
          int(rng, 0, 11),
          int(rng, 1, 28),
          int(rng, 0, 23),
          int(rng, 0, 59),
          int(rng, 0, 59),
        ),
      ).toISOString();
  const asOfMs = Date.parse(asOfIso);
  const generated = generate(rng, zone, asOfMs);
  const faults = [...generated.faults];

  // Clock jump: the as-of instant the engine is asked about may sit before
  // some activities (device clock moved back), far after (moved forward), or
  // be unparseable (falls back to Date.now()).
  const jump = weighted(rng, [
    ['none', 5],
    ['back-hours', 2],
    ['back-days', 2],
    ['forward-days', 2],
    ['forward-year', 1],
    ['invalid-asof', 1],
  ]);
  let engineAsOf = asOfIso;
  let engineAsOfMs = asOfMs;
  switch (jump) {
    case 'back-hours':
      engineAsOfMs = asOfMs - int(rng, 1, 30) * 3_600_000;
      engineAsOf = new Date(engineAsOfMs).toISOString();
      break;
    case 'back-days':
      engineAsOfMs = asOfMs - int(rng, 1, 20) * DAY_MS;
      engineAsOf = new Date(engineAsOfMs).toISOString();
      break;
    case 'forward-days':
      engineAsOfMs = asOfMs + int(rng, 1, 40) * DAY_MS;
      engineAsOf = new Date(engineAsOfMs).toISOString();
      break;
    case 'forward-year':
      engineAsOfMs = asOfMs + 366 * DAY_MS;
      engineAsOf = new Date(engineAsOfMs).toISOString();
      break;
    case 'invalid-asof':
      engineAsOf = pick(rng, MALFORMED_AT);
      break;
    default:
      break;
  }
  if (jump !== 'none') faults.push(`clock:${jump}`);
  if (!zoneIsValid(zone)) faults.push(`zone:${zone === '' ? '<empty>' : zone}`);

  const nowMs = asOfMs;
  jest.useFakeTimers({ now: nowMs });
  let snapshot: ConsistencySnapshot | null = null;
  let thrown: string | null = null;
  const t0 = RealDate.now();
  try {
    snapshot = buildConsistencySnapshot(generated.activities, {
      asOfIso: engineAsOf,
      timeZone: zone,
    });
  } catch (error) {
    thrown =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
  }
  const engineMs = RealDate.now() - t0;
  jest.useRealTimers();

  const expected = oracleSnapshot(
    generated.activities,
    zone,
    engineAsOf,
    nowMs,
  );
  let invariants: Record<string, boolean>;
  let details: string[];
  if (snapshot) {
    ({ invariants, details } = compare(snapshot, expected));
    invariants.no_throw = true;
  } else {
    invariants = { no_throw: false };
    details = [`engine threw: ${thrown}`];
  }
  invariants.fast_enough = engineMs < 2_000;
  if (!invariants.fast_enough) details.push(`fast_enough: ${engineMs} ms`);

  const failed = Object.entries(invariants)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  return {
    suite: 'consistencyEngine.oracle',
    seed,
    scenario: `zone=${zone || '<empty>'} asOf=${asOfIso} jump=${jump} activities=${generated.activities.length}`,
    faults,
    inputs: {
      zone,
      asOfIso,
      engineAsOf,
      activities: generated.activities.length,
      edgeInstants: generated.edgeInstants,
      jump,
    },
    observed: {
      engineMs,
      thrown,
      snapshot: snapshot
        ? {
            asOfDay: snapshot.asOfDay,
            timeZone: snapshot.timeZone,
            currentStreak: snapshot.currentStreak,
            longestStreak: snapshot.longestStreak,
            momentumXp: snapshot.momentumXp,
            shields: [
              snapshot.shieldsAvailable,
              snapshot.shieldsEarnedTotal,
              snapshot.shieldedDayCount,
            ],
            totals: [
              snapshot.totalTrainedDays,
              snapshot.totalActivities,
              snapshot.scoredAnalysisCount,
            ],
            trainedToday: snapshot.trainedToday,
            earned: snapshot.earned.map(e => e.id),
          }
        : null,
      oracle: {
        asOfDay: expected.asOfDay,
        currentStreak: expected.currentStreak,
        momentumXp: expected.momentumXp,
        totals: [
          expected.totalTrainedDays,
          expected.totalActivities,
          expected.scoredAnalysisCount,
        ],
      },
      details,
    },
    invariants,
    ok: failed.length === 0,
    failed,
    durationMs: RealDate.now() - started,
  };
}

// ---------------------------------------------------------------------------
// Deterministic adversarial payloads (each replayable by id)
// ---------------------------------------------------------------------------

interface Payload {
  id: string;
  zone: string;
  asOfIso: string;
  activities: TrainingActivityInput[];
  budgetMs: number;
}

const stroke = (
  atIso: string,
  extra: Partial<TrainingActivityInput> = {},
): TrainingActivityInput => ({
  kind: 'stroke',
  atIso,
  shotType: 'dink',
  overallScore: 6,
  resultKind: 'scored',
  ...extra,
});

const ADVERSARIAL_PAYLOADS: Payload[] = [
  {
    id: 'ancient-year-0099',
    zone: 'UTC',
    asOfIso: '2026-03-29T12:00:00.000Z',
    activities: [
      stroke('0099-01-01T00:00:00.000Z'),
      stroke('2026-03-28T12:00:00.000Z'),
      stroke('2026-03-29T09:00:00.000Z'),
    ],
    budgetMs: 2_000,
  },
  {
    id: 'ancient-year-0001',
    zone: 'America/New_York',
    asOfIso: '2026-03-29T12:00:00.000Z',
    activities: [
      stroke('0001-01-01T00:00:00.000Z'),
      stroke('2026-03-29T09:00:00.000Z'),
    ],
    budgetMs: 2_000,
  },
  {
    id: 'ancient-year-1000',
    zone: 'UTC',
    asOfIso: '2026-03-29T12:00:00.000Z',
    activities: [
      stroke('1000-06-15T00:00:00.000Z'),
      stroke('2026-03-29T09:00:00.000Z'),
    ],
    budgetMs: 2_000,
  },
  {
    id: 'epoch-1970',
    zone: 'Asia/Kolkata',
    asOfIso: '2026-03-29T12:00:00.000Z',
    activities: [
      stroke('1970-01-01T00:00:00.000Z'),
      stroke('2026-03-29T09:00:00.000Z'),
    ],
    budgetMs: 2_000,
  },
  {
    id: 'negative-epoch-1900',
    zone: 'UTC',
    asOfIso: '2026-03-29T12:00:00.000Z',
    activities: [
      stroke('1900-01-01T00:00:00.000Z'),
      stroke('2026-03-29T09:00:00.000Z'),
    ],
    budgetMs: 2_000,
  },
  {
    id: 'numeric-string-timestamp',
    zone: 'UTC',
    asOfIso: '2026-03-29T12:00:00.000Z',
    activities: [stroke('1774785600000'), stroke('2026-03-29T09:00:00.000Z')],
    budgetMs: 2_000,
  },
  {
    id: 'asof-before-all-activity',
    zone: 'Pacific/Kiritimati',
    asOfIso: '2020-01-01T00:00:00.000Z',
    activities: [
      stroke('2026-03-29T09:00:00.000Z'),
      stroke('2026-03-28T09:00:00.000Z'),
    ],
    budgetMs: 2_000,
  },
  {
    id: 'asof-year-9999',
    zone: 'UTC',
    asOfIso: '9999-12-31T23:59:59.000Z',
    activities: [stroke('2026-03-29T09:00:00.000Z')],
    budgetMs: 10_000,
  },
];

describe('consistency engine — seeded timezone/DST/clock-jump/malformed-input campaign', () => {
  const seeds = campaignSeeds(nodeProcess.env, 60, 1);

  afterEach(() => {
    jest.useRealTimers();
  });

  it(`matches the independent oracle across ${seeds.length} seeds`, () => {
    const rows = seeds.map(runSeed);
    const summary = summarizeRows('consistencyEngine.oracle', rows, {
      replay: 'STRESS_SEED=<seed> npx jest --ci consistencyEngine.oracle',
      zones: STRESS_ZONES,
    });
    writeJsonArtifact('engine-oracle.rows.json', rows);
    writeJsonArtifact('engine-oracle.summary.json', summary);

    const totalFaults = rows.reduce((sum, row) => sum + row.faults.length, 0);
    expect(totalFaults).toBeGreaterThanOrEqual(Math.min(60, seeds.length));
    const failures = rows
      .filter(row => !row.ok)
      .map(
        row =>
          `seed ${row.seed}: ${row.failed.join(', ')} :: ${(row.observed as { details: string[] }).details.join(' | ')}`,
      );
    expect(failures).toEqual([]);
  });

  it('survives adversarial timestamps within a CPU budget and agrees with the oracle', () => {
    const rows: StressRow[] = [];
    for (const payload of ADVERSARIAL_PAYLOADS) {
      const started = RealDate.now();
      const nowMs = Date.parse(payload.asOfIso);
      jest.useFakeTimers({ now: nowMs });
      let snapshot: ConsistencySnapshot | null = null;
      let thrown: string | null = null;
      const t0 = RealDate.now();
      try {
        snapshot = buildConsistencySnapshot(payload.activities, {
          asOfIso: payload.asOfIso,
          timeZone: payload.zone,
        });
      } catch (error) {
        thrown =
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error);
      }
      const engineMs = RealDate.now() - t0;
      jest.useRealTimers();
      const expected = oracleSnapshot(
        payload.activities,
        payload.zone,
        payload.asOfIso,
        nowMs,
      );
      let invariants: Record<string, boolean>;
      let details: string[];
      if (snapshot) {
        ({ invariants, details } = compare(snapshot, expected));
        invariants.no_throw = true;
      } else {
        invariants = { no_throw: false };
        details = [`engine threw: ${thrown}`];
      }
      invariants.within_budget = engineMs <= payload.budgetMs;
      if (!invariants.within_budget)
        details.push(`within_budget: ${engineMs} ms > ${payload.budgetMs} ms`);
      const failed = Object.entries(invariants)
        .filter(([, ok]) => !ok)
        .map(([name]) => name);
      rows.push({
        suite: 'consistencyEngine.adversarial',
        seed: 0,
        scenario: payload.id,
        faults: [payload.id],
        inputs: {
          zone: payload.zone,
          asOfIso: payload.asOfIso,
          activities: payload.activities,
        },
        observed: {
          engineMs,
          thrown,
          currentStreak: snapshot?.currentStreak ?? null,
          trainedToday: snapshot?.trainedToday ?? null,
          totalTrainedDays: snapshot?.totalTrainedDays ?? null,
          totalActivities: snapshot?.totalActivities ?? null,
          momentumXp: snapshot?.momentumXp ?? null,
          dayKeys: snapshot ? Object.keys(snapshot.days).length : null,
          oracle: {
            currentStreak: expected.currentStreak,
            totalTrainedDays: expected.totalTrainedDays,
            momentumXp: expected.momentumXp,
          },
          details,
        },
        invariants,
        ok: failed.length === 0,
        failed,
        durationMs: RealDate.now() - started,
      });
    }
    writeJsonArtifact('engine-adversarial.rows.json', rows);
    const failures = rows
      .filter(row => !row.ok)
      .map(
        row =>
          `${row.scenario}: ${row.failed.join(', ')} :: ${(row.observed as { details: string[] }).details.join(' | ')}`,
      );
    expect(failures).toEqual([]);
  }, 120_000);
});
