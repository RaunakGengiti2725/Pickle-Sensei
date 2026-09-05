/**
 * STRESS / failure-injection — the pure progress math against hostile
 * persisted data and clock inputs:
 *
 *   rankFromFacts / resolvePlayerRank   (src/progress/playerRank.ts)
 *   buildGameplayProgression / sessionDayLabel (src/progress/gameplayProgression.ts)
 *   duprEstimate / formatDuprEstimate   (src/progress/duprEstimate.ts)
 *   buildTechniqueDashboard             (src/progress/techniqueDashboard.ts)
 *
 * Each seed generates a history whose size is drawn from {0, 1, 7, 8, 9,
 * 64, 500, 2000} (plus a 20 000-row campaign seed) and poisons a random
 * fraction of rows: NaN / ±Infinity / -0 / 5e-324 / 1e308 / out-of-range
 * scores, garbage / empty / far-future / far-past / duplicate timestamps,
 * duplicate and empty ids, empty and whitespace shot types, foreign result
 * kinds and sources, mixed scoring-model / shot-config versions, corrupt
 * session JSON, and (for the dashboard) invalid range / asOf / timezone
 * options — the "clock" dependency of this unit.
 *
 * Oracle (independent re-derivations, not the code under test):
 *   R  rank: never throws; null exactly when nothing is countable; every
 *      number finite; rating and technique scores in [0,10]; tier matches
 *      the rating band; counts agree with the countable set; the rating lies
 *      between the weakest and strongest technique; result is independent of
 *      input order.
 *   G  progression: never throws; only version-1 `live` records become
 *      sessions, in input order; trend/first/latest/best/delta/totals agree
 *      with the sessions; sessionDayLabel never throws.
 *   D  estimate: finite input → finite result in [1.0, 7.0], monotonic in
 *      the score, formatted with no leaked internals. Non-finite inputs are
 *      recorded (the function has no reachable non-finite caller).
 *   T  dashboard: invalid options throw the documented error and valid ones
 *      never throw; every number finite; reps/days/avg/best/buckets agree
 *      with `reads`; reads are ascending and never after asOf; no `previous`
 *      exists without history; a personal best strictly beats its prior;
 *      result is independent of input order; no leaked internals in copy.
 */
import type { PlayerRankFactLike } from '../../src/progress/playerRank';
import {
  rankFromFacts,
  resolvePlayerRank,
} from '../../src/progress/playerRank';
import type {
  LiveSessionHistoryRow,
  RealAnalysisFact,
} from '../../src/data/repository';
import {
  buildGameplayProgression,
  sessionDayLabel,
} from '../../src/progress/gameplayProgression';
import {
  duprEstimate,
  formatDuprEstimate,
} from '../../src/progress/duprEstimate';
import {
  buildTechniqueDashboard,
  type TechniqueDashboardOptions,
} from '../../src/progress/techniqueDashboard';
import { playerRankTierForRating } from '@pickle/shared-types';
import {
  chance,
  fail,
  int,
  leakedMarkers,
  mulberry32,
  nonFinitePaths,
  pick,
  planCampaign,
  shuffled,
  stringsIn,
  StressTable,
  type Rng,
} from '../../test-support/stress/seededStress';

const CAMPAIGN = 'progressRankBoundaries';
const plan = planCampaign(CAMPAIGN, 31_000, 48);
const table = new StressTable(CAMPAIGN, plan);

const SHOT_TYPES = ['dink', 'volley', 'third_shot_drop', 'serve', 'overhead'];
const AS_OF = '2026-09-01T12:00:00.000Z';
const AS_OF_MS = Date.parse(AS_OF);

// ─── Hostile primitives ────────────────────────────────────────────────────

const HOSTILE_SCORES: readonly number[] = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  -0,
  -0.01,
  -1,
  10.01,
  11,
  1e308,
  -1e308,
  5e-324,
  Number.MAX_SAFE_INTEGER,
  0,
  10,
  0.05,
  9.95,
  4.999999999,
  5.000000001,
];

const HOSTILE_TIMESTAMPS: readonly string[] = [
  '',
  ' ',
  'not-a-date',
  'NaN',
  '2026-13-45T99:99:99.000Z',
  '2026-08-20',
  '2026-08-20T10:00:00',
  '2026-08-20T10:00:00+14:00',
  '2026-08-20T10:00:00-12:00',
  '1970-01-01T00:00:00.000Z',
  '0001-01-01T00:00:00.000Z',
  '+275760-09-13T00:00:00.000Z',
  '-271821-04-20T00:00:00.000Z',
  '9999-12-31T23:59:59.999Z',
  '2026-09-01T12:00:00.001Z', // 1ms after asOf
  '2027-01-01T00:00:00.000Z', // future
  '2026-09-01T12:00:00.000Z', // exactly asOf
  '2026-02-29T00:00:00.000Z', // not a leap year → rolls over
  '1e12',
  'Thu, 20 Aug 2026 10:00:00 GMT',
];

const RESULT_KINDS = ['scored', 'abstained', 'unscored', 'SCORED', '', 'error'];
const SOURCES: readonly (string | undefined)[] = [
  undefined,
  'real',
  'fixture',
  'replay',
  'REAL',
  '',
];

const SIZES = [0, 1, 7, 8, 9, 64, 500, 2000];

function validIso(rng: Rng, spanDays = 400): string {
  const ms = AS_OF_MS - int(rng, 0, spanDays * 86_400_000);
  return new Date(ms).toISOString();
}

function uuid(rng: Rng): string {
  const hex = () => Math.floor(rng() * 16).toString(16);
  const part = (n: number) => Array.from({ length: n }, hex).join('');
  return `${part(8)}-${part(4)}-4${part(3)}-8${part(3)}-${part(12)}`;
}

function score1(rng: Rng): number {
  return Math.round(rng() * 100) / 10;
}

/** Fraction of rows to poison; skewed so many seeds stay mostly healthy. */
function poisonRate(rng: Rng): number {
  return pick(rng, [0, 0, 0.05, 0.2, 0.5, 1]);
}

// ─── R: rankFromFacts ──────────────────────────────────────────────────────

function factFor(rng: Rng, rate: number, ids: string[]): RealAnalysisFact {
  const poison = chance(rng, rate);
  const id =
    poison && chance(rng, 0.3)
      ? pick(rng, ['', ...ids.slice(-3), 'dup'])
      : uuid(rng);
  ids.push(id);
  const shotType =
    poison && chance(rng, 0.2)
      ? pick(rng, ['', ' ', 'Dink', 'dink '])
      : pick(rng, SHOT_TYPES);
  const capturedAt =
    poison && chance(rng, 0.4) ? pick(rng, HOSTILE_TIMESTAMPS) : validIso(rng);
  const resultKind =
    poison && chance(rng, 0.3) ? pick(rng, RESULT_KINDS) : 'scored';
  const overallScore =
    resultKind === 'scored'
      ? poison && chance(rng, 0.5)
        ? pick(rng, HOSTILE_SCORES)
        : score1(rng)
      : chance(rng, 0.8)
        ? null
        : score1(rng);
  return {
    id,
    shotType,
    capturedAt,
    overallScore,
    confidence: chance(rng, 0.9) ? rng() : pick(rng, HOSTILE_SCORES),
    resultKind: resultKind as RealAnalysisFact['resultKind'],
    scoringModelVersion:
      poison && chance(rng, 0.3) ? pick(rng, ['v1', 'v2', '']) : 'v2',
    shotConfigVersion:
      poison && chance(rng, 0.3) ? pick(rng, ['c1', 'c2', '']) : 'c2',
    sessionId: null,
    priorityCheckpoint: null,
    checkpointScores: {},
  };
}

function toRankFact(
  fact: RealAnalysisFact,
  source: string | undefined,
): PlayerRankFactLike {
  return {
    id: fact.id,
    shotType: fact.shotType,
    capturedAt: fact.capturedAt,
    overallScore: fact.overallScore,
    resultKind: fact.resultKind,
    ...(source === undefined ? {} : { source }),
  };
}

function countable(fact: PlayerRankFactLike): boolean {
  return (
    fact.resultKind === 'scored' &&
    typeof fact.overallScore === 'number' &&
    Number.isFinite(fact.overallScore) &&
    fact.overallScore >= 0 &&
    fact.overallScore <= 10 &&
    fact.shotType.length > 0 &&
    (fact.source === undefined || fact.source === 'real')
  );
}

/** Countable rows whose full recency key (instant, id, raw string) collides —
 * the shared formula documents no tie-break beyond that key, and SQLite's
 * primary key makes such rows impossible on device. */
function duplicateRecencyKeys(facts: readonly PlayerRankFactLike[]): number {
  const seen = new Map<string, number>();
  for (const fact of facts.filter(countable)) {
    const key = `${fact.shotType}\u0000${fact.id}\u0000${fact.capturedAt}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.values()].filter(count => count > 1).length;
}

function checkRank(
  rng: Rng,
  facts: readonly PlayerRankFactLike[],
  failures: string[],
  notes: string[],
) {
  let summary: ReturnType<typeof rankFromFacts>;
  try {
    summary = rankFromFacts(facts);
  } catch (error) {
    failures.push(fail('R1-throws', String(error)));
    return { rank: 'threw' };
  }
  const countableFacts = facts.filter(countable);
  if ((summary === null) !== (countableFacts.length === 0)) {
    failures.push(
      fail(
        'R2-null-mismatch',
        `summary ${summary ? 'present' : 'null'} with ${countableFacts.length} countable`,
      ),
    );
  }
  if (!summary) return { rank: null, countable: countableFacts.length };
  for (const path of nonFinitePaths(summary))
    failures.push(fail('R3-non-finite', path));
  if (!(summary.rating >= 0 && summary.rating <= 10)) {
    failures.push(fail('R3-rating-range', String(summary.rating)));
  }
  for (const technique of summary.techniques) {
    if (!(technique.score >= 0 && technique.score <= 10)) {
      failures.push(
        fail('R3-technique-range', `${technique.shotType}=${technique.score}`),
      );
    }
    if (!facts.some(f => f.capturedAt === technique.capturedAt)) {
      failures.push(fail('R3-invented-timestamp', technique.capturedAt));
    }
  }
  if (summary.tier !== playerRankTierForRating(summary.rating).key) {
    failures.push(fail('R3-tier-band', `${summary.tier} vs ${summary.rating}`));
  }
  const shotTypes = new Set(countableFacts.map(f => f.shotType));
  if (
    summary.techniqueCount !== shotTypes.size ||
    summary.techniques.length !== shotTypes.size
  ) {
    failures.push(
      fail(
        'R3-technique-count',
        `${summary.techniqueCount}/${summary.techniques.length} vs ${shotTypes.size}`,
      ),
    );
  }
  if (summary.scoredAnalysisCount !== countableFacts.length) {
    failures.push(
      fail(
        'R3-scored-count',
        `${summary.scoredAnalysisCount} vs ${countableFacts.length}`,
      ),
    );
  }
  const scores = summary.techniques.map(t => t.score);
  const lo = Math.min(...scores) - 0.005;
  const hi = Math.max(...scores) + 0.005;
  if (summary.rating < lo || summary.rating > hi) {
    failures.push(
      fail('R4-rating-outside-techniques', `${summary.rating} ∉ [${lo},${hi}]`),
    );
  }
  if (summary.nextTier && !(summary.nextTier.pointsNeeded > 0)) {
    failures.push(
      fail('R3-points-needed', String(summary.nextTier.pointsNeeded)),
    );
  }
  const reordered = rankFromFacts(shuffled(rng, facts));
  if (JSON.stringify(reordered) !== JSON.stringify(summary)) {
    const duplicates = duplicateRecencyKeys(facts);
    if (duplicates > 0) {
      notes.push(
        `R5 order-dependent only with ${duplicates} duplicate recency key(s)`,
      );
    } else {
      failures.push(
        fail('R5-order-dependent', 'shuffled input changed the summary'),
      );
    }
  }
  try {
    const resolved = resolvePlayerRank(facts, null);
    if (!resolved || resolved.source !== 'device') {
      failures.push(
        fail('R6-resolve', 'device rank not chosen with null server rank'),
      );
    }
  } catch (error) {
    failures.push(fail('R6-resolve-throws', String(error)));
  }
  return {
    rank: summary.tier,
    rating: summary.rating,
    countable: countableFacts.length,
  };
}

// ─── G: buildGameplayProgression ───────────────────────────────────────────

function summaryJson(rng: Rng, rate: number): string | null {
  const poison = chance(rng, rate);
  if (poison && chance(rng, 0.25)) {
    return pick(rng, [
      null,
      '',
      'not json',
      '[]',
      'null',
      '42',
      '{"version":2,"source":"live"}',
      '{"version":1}',
      '{"version":1,"source":"demo"}',
      '{"version":"1","source":"live"}',
      '{"version":1,"source":"live","sessionAverage":"7.5","scoredCount":"3"}',
    ]);
  }
  const scoredCount =
    poison && chance(rng, 0.3)
      ? pick(rng, [-1, 0.5, 1e308, Number.NaN, 2 ** 53])
      : int(rng, 0, 40);
  const average =
    scoredCount === 0 && !poison
      ? null
      : poison && chance(rng, 0.4)
        ? pick(rng, HOSTILE_SCORES)
        : score1(rng);
  const record = {
    version: 1,
    engineVersion: 'e1',
    source:
      poison && chance(rng, 0.3)
        ? pick(rng, ['replay', 'live', 'LIVE', ''])
        : 'live',
    durationMs: int(rng, 0, 3_600_000),
    strokeCount:
      poison && chance(rng, 0.2)
        ? pick(rng, [-5, 1e308, 0.5])
        : int(rng, 0, 80),
    scoredCount,
    noReadCount: 0,
    pendingCount: 0,
    startAverage: null,
    endAverage: null,
    delta:
      poison && chance(rng, 0.3)
        ? pick(rng, HOSTILE_SCORES)
        : chance(rng, 0.5)
          ? null
          : Math.round((rng() * 4 - 2) * 10) / 10,
    bestScore: average,
    sessionAverage: average,
    cuesSpoken: int(rng, 0, 20),
    topCorrection: poison && chance(rng, 0.2) ? 5 : null,
    correctionsByCheckpoint: {},
  };
  // JSON.stringify turns NaN/Infinity into null — exactly what a corrupt
  // writer would leave behind.
  return JSON.stringify(record);
}

function rowsFor(
  rng: Rng,
  size: number,
  rate: number,
): LiveSessionHistoryRow[] {
  const rows: LiveSessionHistoryRow[] = [];
  for (let i = 0; i < size; i += 1) {
    const poison = chance(rng, rate);
    rows.push({
      id: uuid(rng),
      startedAt:
        poison && chance(rng, 0.3)
          ? pick(rng, HOSTILE_TIMESTAMPS)
          : validIso(rng),
      endedAt: chance(rng, 0.8) ? validIso(rng) : null,
      summary: summaryJson(rng, rate),
    } as LiveSessionHistoryRow);
  }
  return rows;
}

function expectsLiveSession(summary: string | null): boolean {
  if (summary === null) return false;
  try {
    const raw = JSON.parse(summary) as unknown;
    return (
      typeof raw === 'object' &&
      raw !== null &&
      (raw as Record<string, unknown>)['version'] === 1 &&
      (raw as Record<string, unknown>)['source'] === 'live'
    );
  } catch {
    return false;
  }
}

function checkProgression(
  rows: readonly LiveSessionHistoryRow[],
  failures: string[],
) {
  let progression: ReturnType<typeof buildGameplayProgression>;
  try {
    progression = buildGameplayProgression(rows);
  } catch (error) {
    failures.push(fail('G1-throws', String(error)));
    return { progression: 'threw' };
  }
  const expectedIds = rows
    .filter(r => expectsLiveSession(r.summary))
    .map(r => r.id);
  const actualIds = progression.sessions.map(s => s.sessionId);
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    failures.push(
      fail(
        'G2-session-set',
        `${actualIds.length} sessions vs ${expectedIds.length} live records`,
      ),
    );
  }
  for (const path of nonFinitePaths(progression))
    failures.push(fail('G3-non-finite', path));
  const scored = progression.sessions.filter(
    s => s.average !== null && s.scoredCount > 0,
  );
  if (progression.scoredSessions.length !== scored.length) {
    failures.push(
      fail(
        'G4-scored-set',
        `${progression.scoredSessions.length} vs ${scored.length}`,
      ),
    );
  }
  const trend = scored.map(s => s.average as number);
  if (JSON.stringify(progression.trendPoints) !== JSON.stringify(trend)) {
    failures.push(fail('G4-trend', 'trendPoints differ from scored averages'));
  }
  if (
    progression.firstAverage !== (trend[0] ?? null) ||
    progression.latestAverage !== (trend.at(-1) ?? null)
  ) {
    failures.push(
      fail(
        'G4-first-latest',
        `${progression.firstAverage}/${progression.latestAverage}`,
      ),
    );
  }
  if (trend.length >= 2) {
    const delta = Math.round(((trend.at(-1) as number) - trend[0]!) * 10) / 10;
    if (progression.overallDelta !== delta)
      failures.push(
        fail('G4-delta', `${progression.overallDelta} vs ${delta}`),
      );
  } else if (progression.overallDelta !== null) {
    failures.push(
      fail('G4-delta-fabricated', String(progression.overallDelta)),
    );
  }
  const bestAverage = trend.length ? Math.max(...trend) : null;
  if ((progression.bestSession?.average ?? null) !== bestAverage) {
    failures.push(
      fail('G4-best', `${progression.bestSession?.average} vs ${bestAverage}`),
    );
  }
  const totalScored = progression.sessions.reduce(
    (sum, s) => sum + s.scoredCount,
    0,
  );
  if (progression.totalScoredSwings !== totalScored)
    failures.push(
      fail('G4-total-scored', String(progression.totalScoredSwings)),
    );
  const improved = progression.sessions.filter(
    s => s.delta !== null && s.delta > 0,
  ).length;
  if (progression.improvedSessions !== improved)
    failures.push(fail('G4-improved', String(progression.improvedSessions)));
  for (const row of rows.slice(0, 50)) {
    try {
      const label = sessionDayLabel(row.startedAt);
      if (typeof label !== 'string')
        failures.push(fail('G6-label-type', typeof label));
    } catch (error) {
      failures.push(
        fail('G6-label-throws', `${row.startedAt}: ${String(error)}`),
      );
    }
  }
  return {
    sessions: progression.sessions.length,
    scoredSessions: scored.length,
  };
}

// ─── D: duprEstimate ───────────────────────────────────────────────────────

function checkEstimate(rng: Rng, failures: string[], notes: string[]) {
  const inputs = [...HOSTILE_SCORES, score1(rng), score1(rng), rng() * 30 - 10];
  let previous: { score: number; estimate: number } | null = null;
  const finiteSorted = inputs.filter(Number.isFinite).sort((a, b) => a - b);
  for (const score of finiteSorted) {
    let estimate: number;
    try {
      estimate = duprEstimate(score);
    } catch (error) {
      failures.push(fail('D1-throws', `${score}: ${String(error)}`));
      continue;
    }
    if (!Number.isFinite(estimate) || estimate < 1 || estimate > 7) {
      failures.push(fail('D1-range', `${score} → ${estimate}`));
    }
    if (previous && estimate < previous.estimate) {
      failures.push(
        fail(
          'D2-monotonic',
          `${previous.score}→${previous.estimate} then ${score}→${estimate}`,
        ),
      );
    }
    previous = { score, estimate };
    const formatted = formatDuprEstimate(score);
    const leaked = leakedMarkers(formatted);
    if (leaked.length > 0)
      failures.push(fail('D3-leak', `${score} → ${formatted}`));
  }
  for (const score of inputs.filter(v => !Number.isFinite(v))) {
    const formatted = formatDuprEstimate(score);
    notes.push(`non-finite ${String(score)} → ${formatted}`);
  }
}

// ─── T: buildTechniqueDashboard ────────────────────────────────────────────

const TIME_ZONES = [
  'UTC',
  'America/Los_Angeles',
  'Asia/Kolkata',
  'Pacific/Kiritimati',
  'Pacific/Chatham',
  'Etc/GMT-14',
];
const BAD_TIME_ZONES = ['', 'Mars/Olympus', 'PST8PDT/???', 'UTC+99'];
const BAD_AS_OF = ['', 'now', 'NaN', '2026-13-01T00:00:00Z'];
const BAD_RANGES = ['1d', '', 'all', '7D'];

interface DashboardOptionsCase {
  options: TechniqueDashboardOptions;
  expectedError: string | null;
}

function optionsFor(rng: Rng): DashboardOptionsCase {
  const roll = rng();
  const valid: TechniqueDashboardOptions = {
    asOfIso: chance(rng, 0.7)
      ? AS_OF
      : pick(rng, [
          '2026-09-01T00:00:00.000Z',
          '2026-09-01T23:59:59.999Z',
          '2026-03-08T10:00:00.000Z',
          '2026-11-01T09:00:00.000Z',
        ]),
    timeZone: pick(rng, TIME_ZONES),
    range: pick(rng, ['7d', '28d', '90d'] as const),
  };
  if (roll < 0.7) return { options: valid, expectedError: null };
  if (roll < 0.8) {
    return {
      options: {
        ...valid,
        range: pick(rng, BAD_RANGES) as TechniqueDashboardOptions['range'],
      },
      expectedError: 'Unsupported technique dashboard range.',
    };
  }
  if (roll < 0.9) {
    return {
      options: { ...valid, asOfIso: pick(rng, BAD_AS_OF) },
      expectedError: 'asOfIso must be a parseable ISO timestamp.',
    };
  }
  return {
    options: { ...valid, timeZone: pick(rng, BAD_TIME_ZONES) },
    expectedError: 'timeZone must be a supported IANA timezone.',
  };
}

function checkDashboard(
  rng: Rng,
  facts: readonly RealAnalysisFact[],
  optionsCase: DashboardOptionsCase,
  failures: string[],
) {
  let dashboard: ReturnType<typeof buildTechniqueDashboard>;
  try {
    dashboard = buildTechniqueDashboard(facts, optionsCase.options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (optionsCase.expectedError === null) {
      failures.push(fail('T1-throws-valid', message));
    } else if (message !== optionsCase.expectedError) {
      failures.push(
        fail(
          'T1-wrong-error',
          `${message} (expected ${optionsCase.expectedError})`,
        ),
      );
    }
    return { dashboard: 'threw', expected: optionsCase.expectedError !== null };
  }
  if (optionsCase.expectedError !== null) {
    failures.push(fail('T1-accepted-invalid', optionsCase.expectedError));
    return { dashboard: 'accepted-invalid' };
  }
  for (const path of nonFinitePaths(dashboard))
    failures.push(fail('T2-non-finite', path));
  const asOfMs = Date.parse(optionsCase.options.asOfIso);
  const reads = dashboard.reads;
  if (dashboard.scoredReps.current !== reads.length) {
    failures.push(
      fail('T3-reps', `${dashboard.scoredReps.current} vs ${reads.length}`),
    );
  }
  if (dashboard.scoredDays.current !== new Set(reads.map(r => r.day)).size) {
    failures.push(fail('T3-days', String(dashboard.scoredDays.current)));
  }
  if (dashboard.buckets.length > 13)
    failures.push(fail('T3-bucket-count', String(dashboard.buckets.length)));
  const bucketReads = dashboard.buckets.reduce((sum, b) => sum + b.count, 0);
  if (bucketReads !== reads.length)
    failures.push(fail('T3-bucket-total', `${bucketReads} vs ${reads.length}`));
  for (const bucket of dashboard.buckets) {
    if ((bucket.avg === null) !== (bucket.count === 0))
      failures.push(fail('T3-bucket-avg', bucket.key));
    if (bucket.avg !== null && !(bucket.avg >= 0 && bucket.avg <= 10)) {
      failures.push(fail('T3-bucket-range', `${bucket.key}=${bucket.avg}`));
    }
  }
  // The aggregate checks assume the domain contract (finite 0–10 scores);
  // reads that break it are already reported by T2 and would only make the
  // oracle's own arithmetic meaningless.
  const wellFormed = reads.every(
    r => Number.isFinite(r.score) && r.score >= 0 && r.score <= 10,
  );
  if (reads.length === 0) {
    if (
      dashboard.avgScore.current !== null ||
      dashboard.bestScore.current !== null ||
      dashboard.insight !== null
    ) {
      failures.push(
        fail(
          'T3-fabricated-current',
          JSON.stringify([
            dashboard.avgScore.current,
            dashboard.bestScore.current,
            dashboard.insight,
          ]),
        ),
      );
    }
  } else if (wellFormed) {
    const mean =
      reads.reduce((sum, r) => sum + Math.round(r.score * 10), 0) /
      reads.length /
      10;
    if (Math.abs((dashboard.avgScore.current ?? Number.NaN) - mean) > 1e-9) {
      failures.push(fail('T3-avg', `${dashboard.avgScore.current} vs ${mean}`));
    }
    const best = Math.max(...reads.map(r => r.score));
    if (dashboard.bestScore.current !== best)
      failures.push(
        fail('T3-best', `${dashboard.bestScore.current} vs ${best}`),
      );
  }
  for (let i = 0; i < reads.length; i += 1) {
    const read = reads[i]!;
    if (read.capturedAtMs > asOfMs)
      failures.push(fail('T4-future-read', read.id));
    if (i > 0 && read.capturedAtMs < reads[i - 1]!.capturedAtMs)
      failures.push(fail('T4-order', read.id));
    const source = facts.some(
      f =>
        f.id === read.id &&
        Date.parse(f.capturedAt) === read.capturedAtMs &&
        f.resultKind === 'scored' &&
        f.overallScore !== null,
    );
    if (!source) failures.push(fail('T4-unknown-read', read.id));
  }
  if (dashboard.scoredReps.previous === null) {
    if (
      dashboard.scoredDays.previous !== null ||
      dashboard.avgScore.previous !== null ||
      dashboard.bestScore.previous !== null ||
      dashboard.personalBest !== null
    ) {
      failures.push(
        fail(
          'T5-previous-without-history',
          'a previous-window value exists with no history',
        ),
      );
    }
  }
  if (
    dashboard.personalBest &&
    Number.isFinite(dashboard.personalBest.score) &&
    Number.isFinite(dashboard.personalBest.previousBest) &&
    !(dashboard.personalBest.score > dashboard.personalBest.previousBest)
  ) {
    failures.push(
      fail(
        'T5-personal-best-not-strict',
        `${dashboard.personalBest.score} vs ${dashboard.personalBest.previousBest}`,
      ),
    );
  }
  for (const text of stringsIn({
    insight: dashboard.insight,
    labels: dashboard.buckets.map(b => b.label),
    pb: dashboard.personalBest?.day,
  })) {
    const leaked = leakedMarkers(text);
    if (leaked.length > 0) failures.push(fail('T7-leak', text));
  }
  const reordered = buildTechniqueDashboard(
    shuffled(rng, facts),
    optionsCase.options,
  );
  if (JSON.stringify(reordered) !== JSON.stringify(dashboard)) {
    // Separate "NaN made the math order-dependent" (already a T2 failure)
    // from a genuine ordering bug over well-formed scores.
    const clean = facts.filter(
      f =>
        f.overallScore === null ||
        (Number.isFinite(f.overallScore) &&
          f.overallScore >= 0 &&
          f.overallScore <= 10),
    );
    const cleanA = JSON.stringify(
      buildTechniqueDashboard(clean, optionsCase.options),
    );
    const cleanB = JSON.stringify(
      buildTechniqueDashboard(shuffled(rng, clean), optionsCase.options),
    );
    if (cleanA !== cleanB) {
      failures.push(
        fail(
          'T6-order-dependent',
          'shuffled well-formed input changed the dashboard',
        ),
      );
    } else {
      failures.push(
        fail(
          'T6-order-dependent-non-finite',
          'ordering differs only through non-finite scores',
        ),
      );
    }
  }
  return {
    reads: reads.length,
    previous: dashboard.scoredReps.previous,
    personalBest: dashboard.personalBest !== null,
  };
}

// ─── Runner ────────────────────────────────────────────────────────────────

afterAll(() => {
  const path = table.write();

  console.log(
    `[${CAMPAIGN}] executed=${table.rows.length} broken=${table.broken.length} → ${path}`,
  );
});

function runSeed(seed: number) {
  const rng = mulberry32(seed);
  const failures: string[] = [];
  const notes: string[] = [];
  // Every 16th seed is a 20 000-row history; STRESS_ITER scales how many.
  const size = seed % 16 === 15 ? 20_000 : pick(rng, SIZES);
  const rate = poisonRate(rng);
  const ids: string[] = [];
  const facts: RealAnalysisFact[] = [];
  for (let i = 0; i < size; i += 1) facts.push(factFor(rng, rate, ids));
  const sourceRate = rate;
  const rankFacts = facts.map(fact =>
    toRankFact(fact, chance(rng, sourceRate) ? pick(rng, SOURCES) : undefined),
  );
  const rows = rowsFor(rng, Math.min(size, 2_000), rate);
  const optionsCase = optionsFor(rng);

  const detail: Record<string, unknown> = {
    size,
    poisonRate: rate,
    options: optionsCase.options,
  };
  Object.assign(detail, { rank: checkRank(rng, rankFacts, failures, notes) });
  Object.assign(detail, { progression: checkProgression(rows, failures) });
  checkEstimate(rng, failures, notes);
  Object.assign(detail, {
    dashboard: checkDashboard(rng, facts, optionsCase, failures),
  });
  if (notes.length > 0) detail.notes = notes;

  const fault = [
    `size=${size}`,
    `poison=${rate}`,
    optionsCase.expectedError
      ? `options=${optionsCase.expectedError.split(' ')[0]}`
      : 'options=valid',
  ].join('+');
  return table.record(seed, fault, failures, detail);
}

// ─── Minimized repros (from campaign seeds) ────────────────────────────────

const BASE_FACT: RealAnalysisFact = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  shotType: 'dink',
  capturedAt: '2026-08-30T10:00:00.000Z',
  overallScore: 7,
  confidence: 0.9,
  resultKind: 'scored',
  scoringModelVersion: 'v1',
  shotConfigVersion: 'c1',
  sessionId: null,
  priorityCheckpoint: null,
  checkpointScores: {},
};
const UTC_28D: TechniqueDashboardOptions = {
  asOfIso: AS_OF,
  timeZone: 'UTC',
  range: '28d',
};

describe(`${CAMPAIGN}: minimized repros`, () => {
  // Seeds 31023, 31048, 31215 (T6): two scored reads of one stroke at the
  // same instant carrying different version tags. Whichever the caller lists
  // first is treated as "newest", so the comparability filter — and with it
  // every stat on the dashboard — depends on row order.
  it('same-instant reads with different versions must not make the dashboard order-dependent', () => {
    const rescored: RealAnalysisFact = {
      ...BASE_FACT,
      id: 'aaaaaaaa-0000-4000-8000-000000000002',
      overallScore: 3,
      scoringModelVersion: 'v2',
    };
    const older: RealAnalysisFact = {
      ...BASE_FACT,
      id: 'aaaaaaaa-0000-4000-8000-000000000003',
      capturedAt: '2026-08-20T10:00:00.000Z',
      overallScore: 5,
    };
    const forward = buildTechniqueDashboard(
      [BASE_FACT, rescored, older],
      UTC_28D,
    );
    const reversed = buildTechniqueDashboard(
      [rescored, BASE_FACT, older],
      UTC_28D,
    );
    expect({
      reps: reversed.scoredReps.current,
      avg: reversed.avgScore.current,
      best: reversed.bestScore.current,
    }).toEqual({
      reps: forward.scoredReps.current,
      avg: forward.avgScore.current,
      best: forward.bestScore.current,
    });
  });

  // Seeds 31033, 31038 (T2/T7): one scored row whose stored score is not a
  // finite 0–10 number (SQLite REAL columns accept ±Inf and text; the
  // repository maps them with a bare Number()). The rank formula skips such
  // rows; the dashboard folds them into every aggregate and the insight copy.
  it('a non-finite stored score must not poison the dashboard aggregates', () => {
    const corrupt: RealAnalysisFact = {
      ...BASE_FACT,
      id: 'aaaaaaaa-0000-4000-8000-000000000002',
      capturedAt: '2026-08-29T10:00:00.000Z',
      overallScore: Number.NEGATIVE_INFINITY,
    };
    const dashboard = buildTechniqueDashboard([BASE_FACT, corrupt], UTC_28D);
    expect({
      nonFinite: nonFinitePaths(dashboard),
      leakedInsight: dashboard.insight ? leakedMarkers(dashboard.insight) : [],
    }).toEqual({ nonFinite: [], leakedInsight: [] });
  });

  // Seeds 31012, 31125, 31141 (G3): two stored sessions whose averages are
  // finite but astronomically large; the difference overflows to Infinity.
  it('progression delta over two finite stored averages must stay finite', () => {
    const row = (id: string, sessionAverage: number): LiveSessionHistoryRow =>
      ({
        id,
        startedAt: '2026-08-20T10:00:00.000Z',
        endedAt: null,
        summary: JSON.stringify({
          version: 1,
          source: 'live',
          scoredCount: 1,
          sessionAverage,
          bestScore: sessionAverage,
        }),
      }) as LiveSessionHistoryRow;
    const progression = buildGameplayProgression([
      row('a', -1e308),
      row('b', 1e308),
    ]);
    expect(nonFinitePaths(progression)).toEqual([]);
  });
});

describe(`${CAMPAIGN}: hostile histories, numeric boundaries and clock inputs`, () => {
  it.each(plan.seeds)('seed %i', seed => {
    const row = runSeed(seed);
    if (row.outcome === 'broken') {
      console.log(
        `[${CAMPAIGN}] seed=${seed} BROKEN ${row.failures.join(' | ')}`,
      );
    }
    expect({ seed, fault: row.fault, failures: row.failures }).toEqual({
      seed,
      fault: row.fault,
      failures: [],
    });
  });
});
