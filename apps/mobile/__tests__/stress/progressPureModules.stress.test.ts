/**
 * STRESS / concurrency + numeric boundaries — the pure progress modules:
 * `progress/playerRank` (+ the shared `computePlayerRank` formula it wraps),
 * `progress/gameplayProgression`, `progress/duprEstimate`,
 * `progress/techniqueDashboard`.
 *
 * These modules have no shared mutable state, so the concurrency lens reduces
 * to what a burst of concurrent callers can observe: every call in a
 * `Promise.all` burst over permuted copies of the same history must produce
 * the same answer (idempotency / input-order independence), including with
 * duplicated row ids ("two actors on the same row"), clock skew (future
 * timestamps, same-instant ties written as different strings, unparseable
 * strings), empty histories and huge histories inside a bounded wall time.
 *
 * Seeded: `STRESS_SEED=<n> STRESS_ITER=1` replays one iteration;
 * `STRESS_REPORT_DIR=<dir>` writes the seed → outcome table.
 */

import {
  computePlayerRank,
  PLAYER_RANK_TIERS,
  RANK_FORM_WINDOW,
  playerRankDivisionForRating,
  type PlayerRankSummary,
} from '@pickle/shared-types';
import type {
  LiveSessionHistoryRow,
  RealAnalysisFact,
} from '../../src/data/repository';
import {
  duprEstimate,
  formatDuprEstimate,
} from '../../src/progress/duprEstimate';
import { buildGameplayProgression } from '../../src/progress/gameplayProgression';
import {
  rankFromFacts,
  resolvePlayerRank,
  summaryFromServer,
  type PlayerRankFactLike,
  type ServerPlayerRank,
} from '../../src/progress/playerRank';
import {
  buildTechniqueDashboard,
  type TechniqueDashboardOptions,
} from '../../src/progress/techniqueDashboard';
import {
  SeededRng,
  stressBaseSeed,
  stressIterations,
  writeStressReport,
} from '../../test-support/stress/seededScheduler';

const ITERATIONS = stressIterations(30);
const BASE_SEED = stressBaseSeed(5000);
/** Per-call wall-time budget for a huge history (ms). */
const HUGE_BUDGET_MS = 2000;

interface Row {
  seed: number;
  outcome: 'HELD' | 'BROKEN';
  size: number;
  violations: string[];
  note?: string;
}

const SHOT_TYPES = ['dink', 'drive', 'serve', 'volley', 'lob', 'drop'] as const;

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Timestamp generator — the clock-skew surface shared by every module.
// ---------------------------------------------------------------------------

const ANCHOR_MS = Date.parse('2026-08-31T18:00:00.000Z');

function timestampFor(rng: SeededRng, spreadDays: number): string {
  const roll = rng.float();
  if (roll < 0.04) return 'not-a-date';
  if (roll < 0.06) return '';
  if (roll < 0.09) {
    // Same instant, different string spelling (offset form).
    const ms = ANCHOR_MS - rng.int(0, spreadDays) * 86_400_000;
    return new Date(ms).toISOString().replace('Z', '+00:00');
  }
  if (roll < 0.14) {
    // Clock skew: a device clock ahead of the reference instant.
    return new Date(ANCHOR_MS + rng.int(1, 400) * 86_400_000).toISOString();
  }
  if (roll < 0.16) return '1970-01-01T00:00:00.000Z';
  if (roll < 0.17) return '+275760-09-13T00:00:00.000Z';
  if (roll < 0.19) {
    // Exact-instant duplicates: a burst of imports landing on one ms.
    return new Date(ANCHOR_MS - 3 * 86_400_000).toISOString();
  }
  const ms =
    ANCHOR_MS -
    rng.int(0, spreadDays) * 86_400_000 -
    rng.int(0, 86_400_000 - 1);
  return new Date(ms).toISOString();
}

function scoreFor(rng: SeededRng): number | null {
  const roll = rng.float();
  if (roll < 0.06) return null;
  if (roll < 0.08) return Number.NaN;
  if (roll < 0.1) return Number.POSITIVE_INFINITY;
  if (roll < 0.12) return -0.01;
  if (roll < 0.14) return 10.01;
  if (roll < 0.17) return 0;
  if (roll < 0.2) return 10;
  if (roll < 0.23) return 9.995;
  if (roll < 0.26) return rng.int(0, 100) / 10;
  return Math.round(rng.float() * 1000) / 100;
}

/** In-contract score: 0–10 with one decimal (the scoring engine's output
 * shape, enforced again by the API contract), or null for an abstention. */
function contractScoreFor(rng: SeededRng): number | null {
  const roll = rng.float();
  if (roll < 0.06) return null;
  if (roll < 0.1) return 0;
  if (roll < 0.14) return 10;
  return rng.int(0, 100) / 10;
}

function sizeFor(rng: SeededRng): number {
  const roll = rng.float();
  if (roll < 0.1) return 0;
  if (roll < 0.2) return 1;
  if (roll < 0.85) return rng.int(2, 60);
  return rng.int(1500, 4000);
}

// ---------------------------------------------------------------------------
// playerRank / computePlayerRank
// ---------------------------------------------------------------------------

type DuplicateMode = 'none' | 'exact' | 'conflicting';

function generateFacts(
  rng: SeededRng,
  size: number,
  duplicates: DuplicateMode,
): { facts: PlayerRankFactLike[]; duplicateIdsDiffer: boolean } {
  const facts: PlayerRankFactLike[] = [];
  let duplicateIdsDiffer = false;
  for (let i = 0; i < size; i += 1) {
    const kindRoll = rng.float();
    const fact: PlayerRankFactLike = {
      id: `row-${i.toString().padStart(6, '0')}`,
      shotType: rng.chance(0.03) ? '' : rng.pick(SHOT_TYPES),
      capturedAt: timestampFor(rng, 120),
      overallScore: scoreFor(rng),
      resultKind:
        kindRoll < 0.8 ? 'scored' : kindRoll < 0.95 ? 'abstained' : 'error',
    };
    if (rng.chance(0.15)) {
      fact.source = rng.chance(0.85) ? 'real' : 'demo';
    }
    facts.push(fact);
    // Two actors on the same row id: an exact duplicate or a conflicting copy.
    if (duplicates !== 'none' && i > 0 && rng.chance(0.08)) {
      const original = rng.pick(facts);
      const twin = { ...original };
      if (duplicates === 'conflicting') {
        twin.overallScore = scoreFor(rng);
        if (
          isCountable(original) &&
          isCountable(twin) &&
          twin.overallScore !== original.overallScore
        ) {
          duplicateIdsDiffer = true;
        }
      }
      facts.push(twin);
    }
  }
  return { facts, duplicateIdsDiffer };
}

/** Independent re-derivation of the tier thresholds (0/3.5/5/6.5/7.5). */
function tierKeyForRating(rating: number): string {
  let key: string = PLAYER_RANK_TIERS[0].key;
  for (const tier of PLAYER_RANK_TIERS) {
    if (rating >= tier.minRating) key = tier.key;
  }
  return key;
}

function isCountable(fact: PlayerRankFactLike): boolean {
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

function checkSummaryShape(
  summary: PlayerRankSummary | null,
  facts: readonly PlayerRankFactLike[],
): string[] {
  const violations: string[] = [];
  const countable = facts.filter(isCountable);
  if (countable.length === 0) {
    if (summary !== null)
      violations.push('non-null summary for uncountable history');
    return violations;
  }
  if (summary === null) {
    violations.push('null summary although countable analyses exist');
    return violations;
  }
  if (!(summary.rating >= 0 && summary.rating <= 10)) {
    violations.push(`rating out of range: ${summary.rating}`);
  }
  if (Math.round(summary.rating * 100) / 100 !== summary.rating) {
    violations.push(`rating not 2-decimal: ${summary.rating}`);
  }
  if (summary.tier !== tierKeyForRating(summary.rating)) {
    violations.push(
      `tier ${summary.tier} inconsistent with rating ${summary.rating}`,
    );
  }
  const { division } = playerRankDivisionForRating(summary.rating);
  if (summary.division !== division) violations.push('division inconsistent');
  if (summary.scoredAnalysisCount !== countable.length) {
    violations.push(
      `scoredAnalysisCount ${summary.scoredAnalysisCount} != countable ${countable.length}`,
    );
  }
  const distinctShots = new Set(countable.map(f => f.shotType)).size;
  if (
    summary.techniqueCount !== distinctShots ||
    summary.techniques.length !== distinctShots
  ) {
    violations.push('techniqueCount != distinct scored shot types');
  }
  for (let i = 1; i < summary.techniques.length; i += 1) {
    const prev = summary.techniques[i - 1]!;
    const next = summary.techniques[i]!;
    if (prev.score < next.score)
      violations.push('techniques not sorted by score desc');
  }
  for (const technique of summary.techniques) {
    if (!(technique.score >= 0 && technique.score <= 10)) {
      violations.push(`technique score out of range ${technique.score}`);
    }
    if (
      technique.sampledCount !== undefined &&
      technique.sampledCount > RANK_FORM_WINDOW
    ) {
      violations.push('sampledCount exceeds form window');
    }
  }
  if (summary.nextTier) {
    const expected =
      Math.round(summary.nextTier.minRating * 100 - summary.rating * 100) / 100;
    if (summary.nextTier.pointsNeeded !== expected) {
      violations.push('pointsNeeded arithmetic mismatch');
    }
    if (summary.nextTier.pointsNeeded <= 0)
      violations.push('pointsNeeded <= 0');
  } else if (summary.tier !== 'diamond') {
    violations.push('nextTier null below diamond');
  }
  return violations;
}

function serverVariant(
  rng: SeededRng,
  local: PlayerRankSummary | null,
): ServerPlayerRank | null {
  if (rng.chance(0.25)) return null;
  const localCount = local?.scoredAnalysisCount ?? 0;
  const countRoll = rng.float();
  const scoredShotCount =
    countRoll < 0.2
      ? null
      : countRoll < 0.5
        ? localCount
        : rng.int(0, localCount * 2 + 5);
  const rating = rng.chance(0.2)
    ? rng.pick([0, 3.5, 5, 6.5, 7.5, 10])
    : Math.round(rng.float() * 1000) / 100;
  return {
    rating,
    tier: rng.chance(0.1) ? 'unknown-tier' : PLAYER_RANK_TIERS[0].key,
    techniqueCount: rng.int(0, 6),
    scoredShotCount,
    updatedAt: rng.chance(0.5) ? new Date(ANCHOR_MS).toISOString() : null,
    techniques: Array.from({ length: rng.int(0, 6) }, () => ({
      shotType: rng.pick(SHOT_TYPES),
      score: Math.round(rng.float() * 1000) / 100,
      capturedAt: timestampFor(rng, 60),
    })),
  };
}

async function playerRankIteration(
  seed: number,
  duplicates: DuplicateMode = 'none',
): Promise<Row> {
  const rng = new SeededRng(seed);
  const size = sizeFor(rng);
  const { facts, duplicateIdsDiffer } = generateFacts(rng, size, duplicates);
  const violations: string[] = [];
  const permutations = rng.int(4, 12);
  const startedAt = Date.now();
  const burst = await Promise.all(
    Array.from({ length: permutations }, (_, i) =>
      Promise.resolve().then(() =>
        rankFromFacts(i === 0 ? facts : rng.shuffle(facts)),
      ),
    ),
  );
  const elapsed = Date.now() - startedAt;
  if (size >= 1500 && elapsed > HUGE_BUDGET_MS * permutations) {
    violations.push(
      `huge history burst took ${elapsed}ms for ${permutations} calls`,
    );
  }
  const reference = burst[0] ?? null;
  violations.push(...checkSummaryShape(reference, facts));
  const divergent = burst.filter(s => !deepEqual(s, reference)).length;
  let note: string | undefined;
  if (divergent > 0) {
    violations.push(
      `computePlayerRank not order-independent: ${divergent}/${permutations} permutations differ${duplicateIdsDiffer ? ' [conflicting duplicate ids present]' : ''}`,
    );
  }
  if (duplicates === 'exact') {
    // A row seen twice (same id, same content) is still one analysis: does
    // the formula dedupe by id, or does the evidence count inflate?
    const deduped = rankFromFacts(
      facts.filter(
        (fact, index) => facts.findIndex(f => f.id === fact.id) === index,
      ),
    );
    if (!deepEqual(deduped, reference)) {
      note = `exact duplicate ids change the summary (count ${deduped?.scoredAnalysisCount ?? 0} → ${reference?.scoredAnalysisCount ?? 0})`;
    }
  } else if (duplicates === 'conflicting' && divergent > 0) {
    note = `order-dependent under conflicting duplicate ids (${divergent}/${permutations} permutations differ)`;
  }
  // Duplicate calls with the same server payload resolve identically and
  // follow the "more evidence wins, ties to the account" rule.
  const server = serverVariant(rng, reference);
  const resolved = await Promise.all(
    Array.from({ length: 6 }, () =>
      Promise.resolve().then(() =>
        resolvePlayerRank(rng.shuffle(facts), server),
      ),
    ),
  );
  const first = resolved[0] ?? null;
  if (resolved.some(r => !deepEqual(r, first))) {
    violations.push('resolvePlayerRank burst not idempotent');
    if (duplicates === 'conflicting' && !note) {
      note =
        'order-dependent under conflicting duplicate ids (shuffled burst differs)';
    }
  }
  if (server && reference && first) {
    const account = summaryFromServer(server);
    const expectedSource =
      account.scoredAnalysisCount >= reference.scoredAnalysisCount
        ? 'account'
        : 'device';
    if (first.source !== expectedSource) {
      violations.push(
        `resolve chose ${first.source}, expected ${expectedSource}`,
      );
    }
    if (!(account.rating >= 0 && account.rating <= 10)) {
      violations.push('summaryFromServer rating out of range');
    }
    if (server.tier === 'unknown-tier') {
      if (account.tier !== tierKeyForRating(server.rating)) {
        violations.push('unknown server tier not re-derived from rating');
      }
    }
  } else if (server && !reference && first?.source !== 'account') {
    violations.push('server-only history did not resolve to account');
  } else if (!server && reference && first?.source !== 'device') {
    violations.push('device-only history did not resolve to device');
  } else if (!server && !reference && first !== null) {
    violations.push('empty history resolved to a rank');
  }
  return {
    seed,
    outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
    size: facts.length,
    violations,
    ...(note ? { note } : {}),
  };
}

// ---------------------------------------------------------------------------
// duprEstimate
// ---------------------------------------------------------------------------

function duprIteration(seed: number): Row {
  const rng = new SeededRng(seed);
  const violations: string[] = [];
  const inputs: number[] = [
    0,
    10,
    -0,
    5,
    9.95,
    9.94999,
    0.05,
    -1e9,
    1e9,
    Number.MAX_VALUE,
    -Number.MAX_VALUE,
    Number.MIN_VALUE,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  for (let i = 0; i < 200; i += 1) inputs.push(rng.float() * 12 - 1);
  const sorted = [...inputs].sort((a, b) => a - b);
  let previous = Number.NEGATIVE_INFINITY;
  for (const input of sorted) {
    const estimate = duprEstimate(input);
    if (!(estimate >= 1 && estimate <= 7)) {
      violations.push(`estimate(${input}) = ${estimate} outside [1, 7]`);
    }
    if (Math.round(estimate * 10) / 10 !== estimate) {
      violations.push(`estimate(${input}) = ${estimate} not one decimal`);
    }
    if (estimate < previous) {
      violations.push(
        `estimate not monotone at ${input}: ${estimate} < ${previous}`,
      );
    }
    previous = estimate;
    if (duprEstimate(input) !== estimate)
      violations.push('estimate not idempotent');
    const formatted = formatDuprEstimate(input);
    if (!/^\(≈ DUPR \d\.\d\)$/.test(formatted)) {
      violations.push(`format(${input}) = ${formatted}`);
    }
  }
  if (
    duprEstimate(0) !== 1 ||
    duprEstimate(5) !== 4 ||
    duprEstimate(10) !== 7
  ) {
    violations.push('documented anchors 0→1.0, 5→4.0, 10→7.0 broken');
  }
  return {
    seed,
    outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
    size: inputs.length,
    violations,
  };
}

// ---------------------------------------------------------------------------
// gameplayProgression
// ---------------------------------------------------------------------------

function summaryJson(rng: SeededRng): string | null {
  const roll = rng.float();
  if (roll < 0.08) return null;
  if (roll < 0.12) return '{not json';
  if (roll < 0.15) return JSON.stringify({ version: 2, source: 'live' });
  if (roll < 0.18) return JSON.stringify([1, 2, 3]);
  if (roll < 0.2) return 'null';
  const source = rng.chance(0.75) ? 'live' : 'replay';
  const scoredCount = rng.chance(0.15) ? 0 : rng.int(0, 400);
  const averageRoll = rng.float();
  const sessionAverage =
    averageRoll < 0.1
      ? null
      : averageRoll < 0.15
        ? 'oops'
        : Math.round(rng.float() * 100) / 10;
  return JSON.stringify({
    version: 1,
    engineVersion: 'stress',
    source,
    durationMs: rng.int(0, 10_000_000),
    strokeCount: rng.chance(0.05) ? -3 : rng.int(0, 600),
    scoredCount,
    noReadCount: rng.int(0, 50),
    pendingCount: rng.int(0, 50),
    startAverage: Math.round(rng.float() * 100) / 10,
    endAverage: Math.round(rng.float() * 100) / 10,
    delta: rng.chance(0.1) ? null : Math.round((rng.float() * 8 - 4) * 10) / 10,
    bestScore: Math.round(rng.float() * 100) / 10,
    sessionAverage,
    cuesSpoken: rng.int(0, 30),
    topCorrection: rng.chance(0.5) ? 'paddle-ready' : null,
  });
}

function gameplayIteration(seed: number): Row {
  const rng = new SeededRng(seed);
  const size = sizeFor(rng);
  const rows: LiveSessionHistoryRow[] = Array.from(
    { length: size },
    (_, i) => ({
      id: `session-${i}`,
      startedAt: timestampFor(rng, 200),
      endedAt: rng.chance(0.1) ? null : timestampFor(rng, 200),
      summary: summaryJson(rng),
    }),
  );
  const violations: string[] = [];
  const startedAt = Date.now();
  const progression = buildGameplayProgression(rows);
  const again = buildGameplayProgression(rows);
  const elapsed = Date.now() - startedAt;
  if (size >= 1500 && elapsed > HUGE_BUDGET_MS) {
    violations.push(`huge history took ${elapsed}ms`);
  }
  if (!deepEqual(progression, again)) violations.push('not idempotent');
  const liveIds = rows
    .filter(row => {
      if (row.summary === null) return false;
      try {
        const parsed = JSON.parse(row.summary) as {
          version?: unknown;
          source?: unknown;
        } | null;
        return (
          parsed !== null &&
          typeof parsed === 'object' &&
          !Array.isArray(parsed) &&
          parsed.version === 1 &&
          parsed.source === 'live'
        );
      } catch {
        return false;
      }
    })
    .map(row => row.id);
  if (
    !deepEqual(
      progression.sessions.map(s => s.sessionId),
      liveIds,
    )
  ) {
    violations.push('sessions != live rows in input order');
  }
  const scored = progression.sessions.filter(
    s => s.average !== null && s.scoredCount > 0,
  );
  if (!deepEqual(progression.scoredSessions, scored))
    violations.push('scoredSessions mismatch');
  if (
    !deepEqual(
      progression.trendPoints,
      scored.map(s => s.average),
    )
  ) {
    violations.push('trendPoints mismatch');
  }
  if (progression.firstAverage !== (scored[0]?.average ?? null))
    violations.push('firstAverage');
  if (progression.latestAverage !== (scored.at(-1)?.average ?? null))
    violations.push('latestAverage');
  if (scored.length >= 2) {
    const expected =
      Math.round(
        ((scored.at(-1)!.average as number) - (scored[0]!.average as number)) *
          10,
      ) / 10;
    if (progression.overallDelta !== expected)
      violations.push('overallDelta arithmetic');
  } else if (progression.overallDelta !== null) {
    violations.push('overallDelta present with < 2 scored sessions');
  }
  const bestAverage = scored.reduce(
    (best, s) => Math.max(best, s.average as number),
    Number.NEGATIVE_INFINITY,
  );
  if (scored.length === 0) {
    if (progression.bestSession !== null)
      violations.push('bestSession for no scored sessions');
  } else if (progression.bestSession?.average !== bestAverage) {
    violations.push('bestSession is not the max average');
  }
  const totalScored = progression.sessions.reduce(
    (n, s) => n + s.scoredCount,
    0,
  );
  const totalStrokes = progression.sessions.reduce(
    (n, s) => n + s.strokeCount,
    0,
  );
  if (progression.totalScoredSwings !== totalScored)
    violations.push('totalScoredSwings');
  if (progression.totalStrokeEvents !== totalStrokes)
    violations.push('totalStrokeEvents');
  if (
    progression.improvedSessions !==
    progression.sessions.filter(s => s.delta !== null && s.delta > 0).length
  ) {
    violations.push('improvedSessions');
  }
  for (const s of progression.sessions) {
    if (s.scoredCount < 0 || s.strokeCount < 0)
      violations.push('negative counts leaked');
    if (s.average !== null && !Number.isFinite(s.average))
      violations.push('non-finite average');
  }
  return {
    seed,
    outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
    size,
    violations,
  };
}

// ---------------------------------------------------------------------------
// techniqueDashboard
// ---------------------------------------------------------------------------

const TIME_ZONES = [
  'UTC',
  'America/Los_Angeles',
  'Asia/Kolkata',
  'Pacific/Kiritimati',
  'Pacific/Pago_Pago',
];

/**
 * In-contract histories: a stroke's scoring model / shot config version is a
 * function of WHEN the read happened (versions ship with app builds), so an
 * upgrade instant splits old from new. `wild` histories instead assign
 * versions at random per read — including two reads of one stroke at the
 * same millisecond on different versions — and out-of-range scores.
 */
function generateDashboardFacts(
  rng: SeededRng,
  size: number,
  wild: boolean,
): { facts: RealAnalysisFact[]; sameInstantVersionConflict: boolean } {
  const facts: RealAnalysisFact[] = [];
  const seenInstant = new Map<string, Set<string>>();
  let sameInstantVersionConflict = false;
  const modelUpgradeMs = ANCHOR_MS - rng.int(0, 200) * 86_400_000;
  const configUpgradeMs = ANCHOR_MS - rng.int(0, 200) * 86_400_000;
  for (let i = 0; i < size; i += 1) {
    const shotType = rng.pick(SHOT_TYPES);
    const capturedAt = timestampFor(rng, 200);
    const capturedMs = Date.parse(capturedAt);
    const scoringModelVersion = wild
      ? rng.chance(0.8)
        ? 'model-2'
        : 'model-1'
      : capturedMs >= modelUpgradeMs
        ? 'model-2'
        : 'model-1';
    const shotConfigVersion = wild
      ? rng.chance(0.9)
        ? 'config-1'
        : 'config-0'
      : capturedMs >= configUpgradeMs
        ? 'config-1'
        : 'config-0';
    const versionKey = `${scoringModelVersion}/${shotConfigVersion}`;
    const instantKey = `${shotType}@${Date.parse(capturedAt)}`;
    const versions = seenInstant.get(instantKey) ?? new Set<string>();
    if (versions.size > 0 && !versions.has(versionKey))
      sameInstantVersionConflict = true;
    versions.add(versionKey);
    seenInstant.set(instantKey, versions);
    const score = wild ? scoreFor(rng) : contractScoreFor(rng);
    facts.push({
      id: `fact-${i.toString().padStart(6, '0')}`,
      shotType,
      capturedAt,
      overallScore: score,
      confidence: 0.9,
      resultKind: rng.chance(0.85) ? 'scored' : 'low_confidence',
      scoringModelVersion,
      shotConfigVersion,
      sessionId: null,
      priorityCheckpoint: null,
      checkpointScores: {},
    });
  }
  return { facts, sameInstantVersionConflict };
}

function dashboardIteration(seed: number, wildScores = false): Row {
  const rng = new SeededRng(seed);
  const size = sizeFor(rng);
  const { facts, sameInstantVersionConflict } = generateDashboardFacts(
    rng,
    size,
    wildScores,
  );
  const options: TechniqueDashboardOptions = {
    asOfIso: new Date(ANCHOR_MS + rng.int(-3, 3) * 3_600_000).toISOString(),
    timeZone: rng.pick(TIME_ZONES),
    range: rng.pick(['7d', '28d', '90d'] as const),
  };
  const violations: string[] = [];
  const permutations = rng.int(3, 8);
  const startedAt = Date.now();
  const results = Array.from({ length: permutations }, (_, i) =>
    buildTechniqueDashboard(i === 0 ? facts : rng.shuffle(facts), options),
  );
  const elapsed = Date.now() - startedAt;
  if (size >= 1500 && elapsed > HUGE_BUDGET_MS * permutations) {
    violations.push(`huge history took ${elapsed}ms for ${permutations} calls`);
  }
  const reference = results[0]!;
  const divergent = results.filter(r => !deepEqual(r, reference)).length;
  let note: string | undefined;
  if (divergent > 0) {
    if (sameInstantVersionConflict) {
      note = `order-dependent when same-instant reads of one stroke carry different model/config versions (${divergent}/${permutations} permutations differ)`;
    }
    violations.push(
      `buildTechniqueDashboard not order-independent: ${divergent}/${permutations} differ${sameInstantVersionConflict ? ' [same-instant version conflict present]' : ''}`,
    );
  }
  const asOfMs = Date.parse(options.asOfIso);
  if (wildScores) {
    const leaked = reference.reads.filter(
      r => !Number.isFinite(r.score) || r.score < 0 || r.score > 10,
    ).length;
    if (leaked > 0) {
      note = `${note ? `${note}; ` : ''}${leaked} out-of-range/non-finite scores aggregated into stats (avg=${reference.avgScore.current}, best=${reference.bestScore.current})`;
    }
  }
  if (reference.buckets.length > 13)
    violations.push(`buckets ${reference.buckets.length} > 13`);
  if (
    reference.buckets.reduce((n, b) => n + b.count, 0) !==
    reference.reads.length
  ) {
    violations.push('bucket counts != reads');
  }
  if (reference.reads.length !== reference.scoredReps.current) {
    violations.push('reads.length != scoredReps.current');
  }
  for (let i = 0; i < reference.reads.length; i += 1) {
    const read = reference.reads[i]!;
    if (read.capturedAtMs > asOfMs)
      violations.push('future read inside window (clock skew leak)');
    if (!wildScores && !(read.score >= 0 && read.score <= 10)) {
      violations.push(`read score ${read.score} out of range`);
    }
    if (i > 0) {
      const prev = reference.reads[i - 1]!;
      if (
        prev.capturedAtMs > read.capturedAtMs ||
        (prev.capturedAtMs === read.capturedAtMs &&
          prev.id.localeCompare(read.id) > 0)
      ) {
        violations.push('reads not ascending (time, id)');
      }
    }
  }
  if (reference.reads.length === 0) {
    if (
      reference.avgScore.current !== null ||
      reference.bestScore.current !== null
    ) {
      violations.push('stats present for an empty window');
    }
    if (reference.scoredDays.current !== 0)
      violations.push('scoredDays for empty window');
  } else if (!wildScores) {
    const tenths = reference.reads.reduce(
      (n, r) => n + Math.round(r.score * 10),
      0,
    );
    if (reference.avgScore.current !== tenths / reference.reads.length / 10) {
      violations.push('avgScore.current != mean of reads');
    }
    if (
      reference.bestScore.current !==
      Math.max(...reference.reads.map(r => r.score))
    ) {
      violations.push('bestScore.current != max of reads');
    }
    const days = new Set(reference.reads.map(r => r.day)).size;
    if (reference.scoredDays.current !== days)
      violations.push('scoredDays.current != distinct days');
    if (days > reference.windowDays)
      violations.push('more scored days than window days');
  }
  const previousFields = [
    reference.scoredReps.previous,
    reference.scoredDays.previous,
    reference.avgScore.previous,
    reference.bestScore.previous,
  ];
  const allNull = previousFields.every(v => v === null);
  const noneNull =
    reference.scoredReps.previous !== null &&
    reference.scoredDays.previous !== null;
  if (!allNull && !noneNull)
    violations.push('previous-window fields partially populated');
  if (
    reference.personalBest &&
    reference.personalBest.score <= reference.personalBest.previousBest
  ) {
    violations.push('personal best does not strictly beat the prior best');
  }
  if (reference.personalBest && allNull) {
    violations.push('personal best without any pre-window history');
  }
  if (reference.avgScore.current === null && reference.insight !== null) {
    violations.push('insight without a scored window');
  }
  for (const bucket of reference.buckets) {
    if (
      !wildScores &&
      bucket.avg !== null &&
      !(bucket.avg >= 0 && bucket.avg <= 10)
    ) {
      violations.push('bucket avg out of range');
    }
    if ((bucket.count === 0) !== (bucket.avg === null))
      violations.push('bucket count/avg disagree');
  }
  return {
    seed,
    outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
    size,
    violations,
    ...(note ? { note } : {}),
  };
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

interface Campaign {
  name: string;
  /** `probe` campaigns feed out-of-contract inputs (duplicate ids, scores the
   * engine can never emit) and only RECORD what the module does — they are
   * evidence for the report, not pass/fail assertions on the contract. */
  kind: 'assert' | 'probe';
  rows: Row[];
}

const campaigns: Campaign[] = [];

afterAll(() => {
  writeStressReport('progressPureModules.json', {
    suite: 'progressPureModules',
    iterationsPerModule: ITERATIONS,
    baseSeed: BASE_SEED,
    campaigns: campaigns.map(c => ({
      name: c.name,
      kind: c.kind,
      iterations: c.rows.length,
      held: c.rows.filter(r => r.outcome === 'HELD').length,
      broken: c.rows.filter(r => r.outcome === 'BROKEN').length,
      noted: c.rows.filter(r => r.note !== undefined).length,
      rows: c.rows,
    })),
  });
});

function failuresOf(rows: Row[]): string[] {
  return rows
    .filter(r => r.outcome === 'BROKEN')
    .map(r => `seed=${r.seed} size=${r.size} ${r.violations.join(' | ')}`);
}

describe('progress pure modules — seeded boundary/permutation stress', () => {
  it(`playerRank: ${ITERATIONS} seeded histories, permuted bursts are order-independent and well-formed`, async () => {
    const rows: Row[] = [];
    for (let i = 0; i < ITERATIONS; i += 1)
      rows.push(await playerRankIteration(BASE_SEED + i));
    campaigns.push({ name: 'playerRank', kind: 'assert', rows });
    expect(rows).toHaveLength(ITERATIONS);
    expect(failuresOf(rows)).toEqual([]);
  }, 180_000);

  it(`duprEstimate: ${ITERATIONS} seeded sweeps stay in [1, 7], one decimal, monotone`, () => {
    const rows: Row[] = [];
    for (let i = 0; i < ITERATIONS; i += 1)
      rows.push(duprIteration(BASE_SEED + i));
    campaigns.push({ name: 'duprEstimate', kind: 'assert', rows });
    expect(failuresOf(rows)).toEqual([]);
  });

  it(`gameplayProgression: ${ITERATIONS} seeded histories (empty, corrupt, replay, huge)`, () => {
    const rows: Row[] = [];
    for (let i = 0; i < ITERATIONS; i += 1)
      rows.push(gameplayIteration(BASE_SEED + i));
    campaigns.push({ name: 'gameplayProgression', kind: 'assert', rows });
    expect(failuresOf(rows)).toEqual([]);
  }, 120_000);

  it(`techniqueDashboard: ${ITERATIONS} seeded histories with clock skew, permuted, across zones/ranges`, () => {
    const rows: Row[] = [];
    for (let i = 0; i < ITERATIONS; i += 1)
      rows.push(dashboardIteration(BASE_SEED + i));
    campaigns.push({ name: 'techniqueDashboard', kind: 'assert', rows });
    expect(failuresOf(rows)).toEqual([]);
  }, 180_000);

  // Probes: out-of-contract inputs the data layer cannot produce (local_shot
  // has PRIMARY KEY (owner_key, id); the scoring engine emits 0–10 one-decimal
  // scores). They document behaviour for the report without asserting it.
  it(`probe: ${ITERATIONS} histories where one row id appears twice (exact copies)`, async () => {
    const rows: Row[] = [];
    for (let i = 0; i < ITERATIONS; i += 1) {
      rows.push(await playerRankIteration(BASE_SEED + 100_000 + i, 'exact'));
    }
    campaigns.push({
      name: 'probe:playerRank:exact-duplicate-ids',
      kind: 'probe',
      rows,
    });
    expect(rows).toHaveLength(ITERATIONS);
  }, 180_000);

  it(`probe: ${ITERATIONS} histories where one row id appears twice with conflicting scores`, async () => {
    const rows: Row[] = [];
    for (let i = 0; i < ITERATIONS; i += 1) {
      rows.push(
        await playerRankIteration(BASE_SEED + 200_000 + i, 'conflicting'),
      );
    }
    campaigns.push({
      name: 'probe:playerRank:conflicting-duplicate-ids',
      kind: 'probe',
      rows,
    });
    expect(rows).toHaveLength(ITERATIONS);
  }, 180_000);

  it(`probe: ${ITERATIONS} dashboards fed random per-read versions and non-finite / out-of-range scores`, () => {
    const rows: Row[] = [];
    for (let i = 0; i < ITERATIONS; i += 1) {
      rows.push(dashboardIteration(BASE_SEED + 300_000 + i, true));
    }
    campaigns.push({
      name: 'probe:techniqueDashboard:wild-scores',
      kind: 'probe',
      rows,
    });
    expect(rows).toHaveLength(ITERATIONS);
  }, 180_000);

  it('computePlayerRank: the documented 8-window form weighting is exact at the boundary', () => {
    // 9 analyses, oldest first 0..8 → window is the newest 8 (scores 1..8),
    // weights 8..1 → Σ w*s = 8*8+7*7+…+1*1 = 204, Σ w = 36 → 5.67 (2 dp).
    const analyses = Array.from({ length: 9 }, (_, i) => ({
      id: `a${i}`,
      shotType: 'dink',
      overallScore: i,
      resultKind: 'scored',
      capturedAt: new Date(ANCHOR_MS + i * 1000).toISOString(),
    }));
    const summary = computePlayerRank(analyses);
    expect(summary?.techniques[0]?.score).toBe(5.67);
    expect(summary?.techniques[0]?.sampledCount).toBe(RANK_FORM_WINDOW);
    expect(summary?.scoredAnalysisCount).toBe(9);
    expect(computePlayerRank([...analyses].reverse())).toEqual(summary);
  });
});
