/**
 * STRESS — consistency engine under the CONCURRENCY lens (timezones, DST,
 * clock jumps). `buildConsistencySnapshot` is the pure core every store
 * refresh replays; if it is not a deterministic function of (activities,
 * asOf, timeZone) then two interleaved refreshes can disagree, so the
 * campaign fires it from `Promise.all` bursts with permuted inputs, across
 * DST transitions, half-hour and +14 zones, the Samoa day skip, invalid
 * zones and device clocks that jump backwards, and cross-checks every
 * result against an INDEPENDENT reference walk.
 *
 * Every iteration is replayable from its seed; the per-seed table lands in
 * artifacts/stress/consistency-engine-concurrency.json (STRESS_OUT overrides
 * the directory). STRESS_ITER scales the campaign (default keeps the suite
 * fast).
 */
import {
  buildConsistencySnapshot,
  dayFromOrdinal,
  dayOrdinal,
  formatDayKey,
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
  momentumLevelForXp,
} from '../../src/consistency/milestones';

declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

const OUT_DIR =
  process.env.STRESS_OUT ?? join(__dirname, '..', '..', 'artifacts', 'stress');
const ITERATIONS = Math.max(
  1,
  Number.parseInt(process.env.STRESS_ITER ?? '', 10) || 120,
);
const BURST = 16;

// ─── Seeded PRNG (mulberry32) ───────────────────────────────────────────────

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
type Rng = () => number;
const pick = <T>(rng: Rng, items: readonly T[]): T =>
  items[Math.floor(rng() * items.length)]!;
const int = (rng: Rng, lo: number, hi: number): number =>
  lo + Math.floor(rng() * (hi - lo + 1));
function shuffled<T>(rng: Rng, items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

// ─── Zones and hostile instants ─────────────────────────────────────────────

const ZONES = [
  'UTC',
  'America/New_York', // DST spring-forward 2026-03-08, fall-back 2026-11-01
  'America/Los_Angeles',
  'America/St_Johns', // -03:30 with DST
  'Europe/London', // DST 2026-03-29 / 2026-10-25
  'Europe/Berlin',
  'Asia/Kolkata', // +05:30, no DST
  'Asia/Kathmandu', // +05:45
  'Australia/Lord_Howe', // +10:30 / +11 (30-minute DST shift)
  'Australia/Sydney', // southern DST
  'Pacific/Chatham', // +12:45 / +13:45
  'Pacific/Kiritimati', // +14
  'Pacific/Apia', // skipped 2011-12-30 entirely
  'Pacific/Pago_Pago', // -11
  'America/Santiago',
  'America/Sao_Paulo',
  'Africa/Casablanca',
  'Etc/GMT-14',
  'Etc/GMT+12',
] as const;

const INVALID_ZONES = ['Mars/Olympus', '', 'GMT+25', 'Not/A_Zone'] as const;

/** Instants near known DST edges / day skips / year boundaries. */
const HOT_INSTANTS = [
  '2026-03-08T06:59:59.000Z', // NY 01:59:59 EST → 03:00 EDT one second later
  '2026-03-08T07:00:00.000Z',
  '2026-11-01T05:59:59.000Z', // NY 01:59:59 EDT (first)
  '2026-11-01T06:00:00.000Z', // NY 01:00:00 EST (second 1am)
  '2026-03-29T00:59:59.000Z', // London 00:59:59 GMT → 02:00 BST
  '2026-03-29T01:00:00.000Z',
  '2026-10-25T00:59:59.000Z',
  '2026-10-25T01:00:00.000Z',
  '2026-10-04T15:59:59.000Z', // Lord Howe DST start (02:00 → 02:30)
  '2026-10-04T16:00:00.000Z',
  '2026-04-05T15:59:59.000Z', // Lord Howe DST end (02:00 → 01:30)
  '2026-04-05T16:00:00.000Z',
  '2011-12-29T09:59:59.000Z', // Apia: 23:59:59 on 29 Dec, then 31 Dec
  '2011-12-29T10:00:00.000Z',
  '2025-12-31T23:59:59.000Z', // year boundary
  '2026-01-01T00:00:00.000Z',
  '2024-02-29T12:00:00.000Z', // leap day
  '2026-02-28T23:59:59.999Z',
] as const;

const SHOT_TYPES = [
  'dink',
  'volley',
  'third_shot_drop',
  'serve',
  'forehand_drive',
] as const;

// ─── Independent reference implementation ───────────────────────────────────

function refDayKey(ms: number, timeZone: string): string {
  // en-CA renders YYYY-MM-DD; explicit numeric parts for stability.
  return new Date(ms).toLocaleDateString('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function refResolveZone(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions()
      .timeZone;
  } catch {
    return 'UTC';
  }
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

interface RefResult {
  asOfDay: string;
  timeZone: string;
  currentStreak: number;
  longestStreak: number;
  shieldsAvailable: number;
  shieldsEarnedTotal: number;
  shieldedDayCount: number;
  momentumXp: number;
  runXp: number;
  trainedToday: boolean;
  atRisk: boolean;
  trainedLast7: number;
  totalTrainedDays: number;
  totalActivities: number;
  scoredAnalysisCount: number;
  dayKeys: string[];
  shieldedDays: string[];
  dayXp: Record<string, number>;
  earnedStreakIds: string[];
  sessions100Day: string | null;
  specialist: string | null;
}

function reference(
  activities: readonly TrainingActivityInput[],
  asOfIso: string,
  timeZoneIn: string,
): RefResult {
  const timeZone = refResolveZone(timeZoneIn);
  const asOfMsRaw = Date.parse(asOfIso);
  const asOfMs = Number.isFinite(asOfMsRaw) ? asOfMsRaw : Date.now();
  const asOfDay = refDayKey(asOfMs, timeZone);
  const perDay = new Map<string, TrainingActivityInput[]>();
  let totalActivities = 0;
  let scoredAnalysisCount = 0;
  const byTechnique = new Map<string, number>();
  for (const input of activities) {
    const ms = Date.parse(input.atIso);
    if (!Number.isFinite(ms)) continue;
    if (Number.isFinite(asOfMsRaw) && ms > asOfMsRaw) continue;
    const day = refDayKey(ms, timeZone);
    if (day > asOfDay) continue;
    totalActivities += 1;
    const list = perDay.get(day) ?? [];
    list.push(input);
    perDay.set(day, list);
    if (
      input.resultKind === 'scored' &&
      typeof input.overallScore === 'number' &&
      Number.isFinite(input.overallScore)
    ) {
      scoredAnalysisCount += 1;
      if (input.shotType) {
        byTechnique.set(
          input.shotType,
          (byTechnique.get(input.shotType) ?? 0) + 1,
        );
      }
    }
  }
  const dayKeys = [...perDay.keys()].sort();
  const result: RefResult = {
    asOfDay,
    timeZone,
    currentStreak: 0,
    longestStreak: 0,
    shieldsAvailable: 0,
    shieldsEarnedTotal: 0,
    shieldedDayCount: 0,
    momentumXp: 0,
    runXp: 0,
    trainedToday: perDay.has(asOfDay),
    atRisk: false,
    trainedLast7: 0,
    totalTrainedDays: 0,
    totalActivities,
    scoredAnalysisCount,
    dayKeys,
    shieldedDays: [],
    dayXp: {},
    earnedStreakIds: [],
    sessions100Day: null,
    specialist: null,
  };
  if (dayKeys.length === 0) return result;

  let run = 0;
  let cumulative = 0;
  const bonusGiven = new Set<string>();
  for (let day = dayKeys[0]!; day <= asOfDay; day = addDays(day, 1)) {
    const list = perDay.get(day);
    if (list) {
      run += 1;
      result.totalTrainedDays += 1;
      result.longestStreak = Math.max(result.longestStreak, run);
      let xp =
        XP_PER_TRAINED_DAY +
        Math.min(
          (list.length - 1) * XP_PER_EXTRA_ACTIVITY,
          XP_EXTRA_ACTIVITY_CAP,
        );
      for (const milestone of STREAK_MILESTONES) {
        if (run === milestone.days && !bonusGiven.has(milestone.id)) {
          bonusGiven.add(milestone.id);
          xp += milestone.bonusXp;
          result.earnedStreakIds.push(milestone.id);
        }
      }
      result.momentumXp += xp;
      result.runXp = run === 1 ? xp : result.runXp + xp;
      result.dayXp[day] = xp;
      if (run % SHIELD_EARN_EVERY_DAYS === 0) {
        result.shieldsEarnedTotal += 1;
        result.shieldsAvailable = Math.min(
          result.shieldsAvailable + 1,
          SHIELD_MAX_HELD,
        );
      }
      cumulative += list.length;
      if (
        result.sessions100Day === null &&
        cumulative >= VOLUME_ACHIEVEMENTS.sessions100.threshold
      ) {
        result.sessions100Day = day;
      }
      continue;
    }
    if (day === asOfDay) break;
    if (run === 0) continue;
    if (result.shieldsAvailable > 0) {
      result.shieldsAvailable -= 1;
      result.shieldedDayCount += 1;
      result.shieldedDays.push(day);
      result.dayXp[day] = 0;
    } else {
      run = 0;
      result.runXp = 0;
    }
  }
  result.currentStreak = run;
  result.atRisk = run > 0 && !result.trainedToday;
  for (let i = 6; i >= 0; i -= 1) {
    if (perDay.has(addDays(asOfDay, -i))) result.trainedLast7 += 1;
  }
  const specialist = [...byTechnique.entries()]
    .filter(([, n]) => n >= VOLUME_ACHIEVEMENTS.specialist.threshold)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  result.specialist = specialist ? specialist[0].replace(/_/g, ' ') : null;
  return result;
}

// ─── Scenario generator ─────────────────────────────────────────────────────

interface Scenario {
  seed: number;
  timeZone: string;
  asOfIso: string;
  activities: TrainingActivityInput[];
  /** Activities dated after asOf (device clock jumped back). */
  futureCount: number;
}

function makeScenario(seed: number): Scenario {
  const rng = mulberry32(seed);
  const useInvalid = rng() < 0.08;
  const timeZone = useInvalid ? pick(rng, INVALID_ZONES) : pick(rng, ZONES);
  const anchor = Date.parse(pick(rng, HOT_INSTANTS));
  // Spread activities over up to ~120 days before the anchor, dense enough
  // to build streaks, sparse enough to miss days and spend shields.
  const spanDays = int(rng, 1, 120);
  const count = int(rng, 0, 90);
  const activities: TrainingActivityInput[] = [];
  const DAY = 86_400_000;
  for (let i = 0; i < count; i += 1) {
    const daysBack = int(rng, 0, spanDays);
    // Bias toward local midnight edges: pick minute offsets near 0/59.
    const edge = rng() < 0.5;
    const withinDay = edge
      ? pick(rng, [0, 1, 59, 60, 1439, 1438, 1380, 300, 420, 30 * 60]) *
          60_000 +
        int(rng, 0, 999)
      : int(rng, 0, DAY - 1);
    const ms = anchor - daysBack * DAY - (anchor % DAY) + withinDay;
    const kind = pick(rng, ['stroke', 'session_stroke', 'drill'] as const);
    const scored = kind !== 'drill' && rng() < 0.7;
    activities.push({
      kind,
      atIso: new Date(ms).toISOString(),
      ...(kind !== 'drill' ? { shotType: pick(rng, SHOT_TYPES) } : {}),
      ...(kind !== 'drill'
        ? {
            overallScore: scored ? int(rng, 0, 100) / 10 : null,
            resultKind: scored ? 'scored' : 'low_confidence',
          }
        : { label: rng() < 0.5 ? 'Contact Shadow Reps' : undefined }),
    });
  }
  // Clock jump backwards: some activities land AFTER asOf.
  let futureCount = 0;
  if (rng() < 0.35) {
    futureCount = int(rng, 1, 4);
    for (let i = 0; i < futureCount; i += 1) {
      activities.push({
        kind: 'stroke',
        atIso: new Date(anchor + int(rng, 1, 3 * DAY)).toISOString(),
        shotType: 'dink',
        overallScore: 6,
        resultKind: 'scored',
      });
    }
  }
  // Hostile instants: unparsable, empty.
  if (rng() < 0.3) {
    activities.push({ kind: 'stroke', atIso: 'not-a-date' });
    activities.push({ kind: 'drill', atIso: '' });
  }
  // Clock skew on asOf itself: sometimes nudge by ±1 minute around the edge.
  const asOfMs = anchor + (rng() < 0.5 ? 0 : int(rng, -90_000, 90_000));
  return {
    seed,
    timeZone,
    asOfIso: new Date(asOfMs).toISOString(),
    activities,
    futureCount,
  };
}

// ─── Assertions ─────────────────────────────────────────────────────────────

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

function checkAgainstReference(
  snapshot: ConsistencySnapshot,
  ref: RefResult,
  scenario: Scenario,
): string[] {
  const problems: string[] = [];
  const eq = (name: string, got: unknown, want: unknown) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      problems.push(
        `${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`,
      );
    }
  };
  eq('asOfDay', snapshot.asOfDay, ref.asOfDay);
  eq('timeZone', snapshot.timeZone, ref.timeZone);
  eq('currentStreak', snapshot.currentStreak, ref.currentStreak);
  eq('longestStreak', snapshot.longestStreak, ref.longestStreak);
  eq('shieldsAvailable', snapshot.shieldsAvailable, ref.shieldsAvailable);
  eq('shieldsEarnedTotal', snapshot.shieldsEarnedTotal, ref.shieldsEarnedTotal);
  eq('shieldedDayCount', snapshot.shieldedDayCount, ref.shieldedDayCount);
  eq('momentumXp', snapshot.momentumXp, ref.momentumXp);
  eq('runXp', snapshot.runXp, ref.runXp);
  eq('trainedToday', snapshot.trainedToday, ref.trainedToday);
  eq('atRisk', snapshot.atRisk, ref.atRisk);
  eq('trainedLast7', snapshot.trainedLast7, ref.trainedLast7);
  eq('totalTrainedDays', snapshot.totalTrainedDays, ref.totalTrainedDays);
  eq('totalActivities', snapshot.totalActivities, ref.totalActivities);
  eq(
    'scoredAnalysisCount',
    snapshot.scoredAnalysisCount,
    ref.scoredAnalysisCount,
  );
  eq('momentum', snapshot.momentum, momentumLevelForXp(ref.momentumXp));
  const trainedKeys = Object.values(snapshot.days)
    .filter(d => !d.shielded)
    .map(d => d.day)
    .sort();
  eq('trainedDayKeys', trainedKeys, ref.dayKeys);
  const shieldedKeys = Object.values(snapshot.days)
    .filter(d => d.shielded)
    .map(d => d.day)
    .sort();
  eq('shieldedDayKeys', shieldedKeys, ref.shieldedDays);
  for (const [day, entry] of Object.entries(snapshot.days)) {
    if (!DAY_KEY.test(day)) problems.push(`invalid day key ${day}`);
    if (entry.day !== day) problems.push(`day entry mismatch ${day}`);
    if (entry.xp !== ref.dayXp[day]) {
      problems.push(`xp[${day}] got ${entry.xp} want ${ref.dayXp[day]}`);
    }
    if (dayFromOrdinal(dayOrdinal(day)) !== day) {
      problems.push(`ordinal round-trip broke for ${day}`);
    }
    if (entry.shielded) {
      if (entry.activities.length !== 0 || entry.xp !== 0) {
        problems.push(`shielded day ${day} carries activity/xp`);
      }
    } else {
      const total =
        entry.strokeCount + entry.sessionStrokeCount + entry.drillCount;
      if (total !== entry.activities.length || total === 0) {
        problems.push(`trained day ${day} count mismatch`);
      }
      if (entry.scoredCount === 0 && entry.scoreAvg !== null) {
        problems.push(`scoreAvg without scored on ${day}`);
      }
      if (
        entry.scoreAvg !== null &&
        (entry.scoreAvg < 0 ||
          entry.scoreAvg > 10 ||
          !Number.isFinite(entry.scoreAvg))
      ) {
        problems.push(`scoreAvg out of range on ${day}`);
      }
      for (let i = 1; i < entry.activities.length; i += 1) {
        if (entry.activities[i - 1]!.atIso > entry.activities[i]!.atIso) {
          problems.push(`activities unsorted on ${day}`);
          break;
        }
      }
    }
  }
  // Sum of day xp equals momentum XP.
  const xpSum = Object.values(snapshot.days).reduce((s, d) => s + d.xp, 0);
  eq('sum(days.xp)', xpSum, snapshot.momentumXp);
  // Milestones.
  const streakIds = snapshot.earned
    .filter(e => e.id.startsWith('streak.'))
    .map(e => e.id);
  eq('earnedStreakIds', streakIds, ref.earnedStreakIds);
  const sessions100 = snapshot.earned.find(
    e => e.id === VOLUME_ACHIEVEMENTS.sessions100.id,
  );
  eq('sessions100Day', sessions100?.earnedOnDay ?? null, ref.sessions100Day);
  const specialist = snapshot.earned.find(
    e => e.id === VOLUME_ACHIEVEMENTS.specialist.id,
  );
  eq('specialist', specialist?.detail ?? null, ref.specialist);
  const ids = snapshot.earned.map(e => e.id);
  if (new Set(ids).size !== ids.length) problems.push('duplicate earned ids');
  const next = STREAK_MILESTONES.find(m => m.days > ref.currentStreak) ?? null;
  eq(
    'nextStreakMilestone',
    snapshot.nextStreakMilestone
      ? {
          id: snapshot.nextStreakMilestone.id,
          daysAway: snapshot.nextStreakMilestone.daysAway,
        }
      : null,
    next ? { id: next.id, daysAway: next.days - ref.currentStreak } : null,
  );
  // Structural bounds.
  if (snapshot.shieldsAvailable > SHIELD_MAX_HELD)
    problems.push('shields > cap');
  if (snapshot.currentStreak > snapshot.longestStreak)
    problems.push('current > longest');
  if (snapshot.trainedLast7 > 7) problems.push('trainedLast7 > 7');
  if (snapshot.totalTrainedDays > snapshot.totalActivities)
    problems.push('days > activities');
  // Future (clock-jump) activities never count.
  const validCount = scenario.activities.filter(a => {
    const ms = Date.parse(a.atIso);
    return Number.isFinite(ms) && ms <= Date.parse(scenario.asOfIso);
  }).length;
  if (snapshot.totalActivities > validCount) {
    problems.push(
      `future activities counted (${snapshot.totalActivities} > ${validCount})`,
    );
  }
  return problems;
}

// ─── Campaign ───────────────────────────────────────────────────────────────

/**
 * Canonical form for cross-permutation comparison: the engine sorts a day's
 * activities by (atIso, label) only, so two activities sharing both keys
 * keep INPUT order — the aggregate facts must still be byte-identical, and
 * the raw ordering is recorded separately as `burstOrderStable`.
 */
function canonical(snapshot: ConsistencySnapshot): string {
  const days: Record<string, unknown> = {};
  for (const [key, day] of Object.entries(snapshot.days)) {
    days[key] = {
      ...day,
      activities: [...day.activities].map(a => JSON.stringify(a)).sort(),
    };
  }
  return JSON.stringify({ ...snapshot, days });
}

/** Dotted path of the first leaf that differs between two JSON values. */
function firstDifference(a: unknown, b: unknown, path = '$'): string | null {
  if (a === b) return null;
  if (
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    a === null ||
    b === null ||
    Array.isArray(a) !== Array.isArray(b)
  ) {
    return `${path}: ${JSON.stringify(a)?.slice(0, 120)} ≠ ${JSON.stringify(b)?.slice(0, 120)}`;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  for (const key of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
    const found = firstDifference(ao[key], bo[key], `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

interface Row {
  seed: number;
  timeZone: string;
  asOfIso: string;
  activities: number;
  futureCount: number;
  /** Aggregates + canonicalised day lists identical across the burst. */
  burstIdentical: boolean;
  /** Raw JSON identical across the burst (input-order sensitivity probe). */
  burstOrderStable: boolean;
  monotoneUnderFuture: boolean;
  referenceProblems: string[];
  burstDiff?: string;
  outcome: 'HELD' | 'BROKEN';
}

const rows: Row[] = [];

afterAll(() => {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    join(OUT_DIR, 'consistency-engine-concurrency.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        iterations: ITERATIONS,
        burst: BURST,
        executed: rows.length,
        broken: rows.filter(r => r.outcome === 'BROKEN').map(r => r.seed),
        orderUnstableSeeds: rows
          .filter(r => !r.burstOrderStable)
          .map(r => r.seed),
        rows,
      },
      null,
      2,
    ),
  );
});

describe('consistency engine — concurrency / timezone / clock-jump campaign', () => {
  it(`is a deterministic, reference-equal function across ${ITERATIONS} seeded scenarios × ${BURST}-way bursts`, async () => {
    const broken: Array<{ seed: number; why: string[] }> = [];
    for (let seed = 1; seed <= ITERATIONS; seed += 1) {
      const scenario = makeScenario(seed);
      const rng = mulberry32(seed ^ 0x9e3779b9);
      const options = {
        asOfIso: scenario.asOfIso,
        timeZone: scenario.timeZone,
      };

      // Concurrent burst: same facts, permuted order, interleaved via
      // Promise.all — every result must be byte-identical.
      const burst = await Promise.all(
        Array.from({ length: BURST }, (_, i) =>
          Promise.resolve().then(() =>
            buildConsistencySnapshot(
              i === 0
                ? scenario.activities
                : shuffled(rng, scenario.activities),
              options,
            ),
          ),
        ),
      );
      const canon = burst.map(canonical);
      const raw = burst.map(s => JSON.stringify(s));
      const burstIdentical = canon.every(json => json === canon[0]);
      const burstOrderStable = raw.every(json => json === raw[0]);
      const odd = canon.findIndex(json => json !== canon[0]);
      const burstDiff =
        odd < 0
          ? undefined
          : (firstDifference(JSON.parse(canon[0]!), JSON.parse(canon[odd]!)) ??
            'unlocated');

      const snapshot = buildConsistencySnapshot(scenario.activities, options);
      const ref = reference(
        scenario.activities,
        scenario.asOfIso,
        scenario.timeZone,
      );
      const referenceProblems = checkAgainstReference(snapshot, ref, scenario);

      // Clock jump: dropping the post-asOf activities must not change anything.
      const asOfMs = Date.parse(scenario.asOfIso);
      const past = scenario.activities.filter(a => {
        const ms = Date.parse(a.atIso);
        return !Number.isFinite(ms) || ms <= asOfMs;
      });
      const monotoneUnderFuture =
        canonical(buildConsistencySnapshot(past, options)) ===
        canonical(snapshot);

      const why: string[] = [...referenceProblems];
      if (!burstIdentical) why.push(`burst results differ: ${burstDiff}`);
      if (!monotoneUnderFuture)
        why.push('future activities changed the snapshot');
      rows.push({
        seed,
        timeZone: scenario.timeZone,
        asOfIso: scenario.asOfIso,
        activities: scenario.activities.length,
        futureCount: scenario.futureCount,
        burstIdentical,
        burstOrderStable,
        monotoneUnderFuture,
        referenceProblems,
        ...(burstDiff ? { burstDiff } : {}),
        outcome: why.length === 0 ? 'HELD' : 'BROKEN',
      });
      if (why.length > 0) broken.push({ seed, why });
    }
    expect(broken).toEqual([]);
  });

  it('advancing the clock one untrained day at a time never grows the streak and spends shields before breaking', () => {
    // Hand-built ladder: 15 straight days → 2 shields banked, then silence.
    const zone = 'Australia/Lord_Howe';
    const start = Date.parse('2026-09-20T02:00:00.000Z');
    const DAY = 86_400_000;
    const activities: TrainingActivityInput[] = Array.from(
      { length: 15 },
      (_, i) => ({
        kind: 'stroke',
        atIso: new Date(start + i * DAY).toISOString(),
        shotType: 'dink',
        overallScore: 6,
        resultKind: 'scored',
      }),
    );
    let previous = buildConsistencySnapshot(activities, {
      asOfIso: new Date(start + 14 * DAY).toISOString(),
      timeZone: zone,
    });
    expect(previous.currentStreak).toBe(15);
    expect(previous.shieldsAvailable).toBe(2);
    const trace: Array<{
      day: string;
      streak: number;
      shields: number;
      atRisk: boolean;
    }> = [];
    for (let d = 15; d < 22; d += 1) {
      const next = buildConsistencySnapshot(activities, {
        asOfIso: new Date(start + d * DAY).toISOString(),
        timeZone: zone,
      });
      trace.push({
        day: next.asOfDay,
        streak: next.currentStreak,
        shields: next.shieldsAvailable,
        atRisk: next.atRisk,
      });
      expect(next.currentStreak).toBeLessThanOrEqual(previous.currentStreak);
      expect(next.shieldsAvailable).toBeLessThanOrEqual(
        previous.shieldsAvailable,
      );
      previous = next;
    }
    // Day 15 (today open): still 15, at risk. Days 16,17: shields bridge.
    // Day 18: no shield left → run resets to 0.
    expect(trace.map(t => t.streak)).toEqual([15, 15, 15, 0, 0, 0, 0]);
    expect(trace.map(t => t.shields)).toEqual([2, 1, 0, 0, 0, 0, 0]);
    expect(trace[0]?.atRisk).toBe(true);
  });

  it('formatDayKey renders the key itself in every zone (never a neighbouring day)', () => {
    const keys = [
      '2026-03-08',
      '2026-11-01',
      '2011-12-30',
      '2025-12-31',
      '2024-02-29',
    ];
    for (const key of keys) {
      const rendered = formatDayKey(key, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
      // en-US default locale in this runtime → MM/DD/YYYY; reassemble.
      const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(rendered);
      expect(m).not.toBeNull();
      expect(`${m![3]}-${m![1]}-${m![2]}`).toBe(key);
    }
    expect(formatDayKey('garbage', { year: 'numeric' })).toBe('garbage');
  });

  it('never throws on invalid zones and falls back to UTC day math', () => {
    for (const zone of INVALID_ZONES) {
      const snapshot = buildConsistencySnapshot(
        [
          {
            kind: 'stroke',
            atIso: '2026-03-08T23:30:00.000Z',
            shotType: 'dink',
            overallScore: 5,
            resultKind: 'scored',
          },
        ],
        { asOfIso: '2026-03-09T00:30:00.000Z', timeZone: zone },
      );
      expect(snapshot.timeZone).toBe('UTC');
      expect(snapshot.asOfDay).toBe('2026-03-09');
      expect(snapshot.currentStreak).toBe(1);
      expect(snapshot.atRisk).toBe(true);
    }
  });

  it('a day’s scoreAvg does not depend on the order the facts arrive in (minimized from seeds 27/33)', () => {
    // Sum 14.6 / 4 = 3.65 exactly in decimal; in binary the running sum
    // lands on either side of the .x5 tie depending on addition order.
    const scores = [7, 2.3, 4.6, 0.7];
    const at = '2026-03-01T10:00:00.000Z';
    const options = { asOfIso: '2026-03-01T20:00:00.000Z', timeZone: 'UTC' };
    const facts = (order: number[]): TrainingActivityInput[] =>
      order.map(i => ({
        kind: 'stroke',
        atIso: at,
        shotType: `s${i}`,
        overallScore: scores[i]!,
        resultKind: 'scored',
      }));
    const averages = new Set(
      [
        [0, 1, 2, 3],
        [3, 2, 1, 0],
        [1, 3, 0, 2],
        [2, 0, 3, 1],
      ].map(
        order =>
          buildConsistencySnapshot(facts(order), options).days['2026-03-01']!
            .scoreAvg,
      ),
    );
    expect([...averages]).toHaveLength(1);
  });
});
