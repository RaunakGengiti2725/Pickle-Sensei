/**
 * STRESS — mod-session-flow / failure-injection lens, part 3:
 * sessionScoreProgression (src/flow/sessionProgress.ts) fed malformed /
 * partial event views and random resolution sequences.
 *
 * Per seed: a session of N events is resolved one event at a time in a random
 * order into random terminal shapes (including contract-violating ones —
 * ready without a record, scored without a score, unknown resultKind,
 * unknown state, non-finite / out-of-range scores). After EVERY step the
 * progression is recomputed and checked for:
 *   - monotonicity: pending never grows, resolved never shrinks, plotted
 *     points are append-only with frozen scores, best never drops, window
 *     never shrinks
 *   - honesty: a point exists ONLY for a ready+scored event with a numeric
 *     score; buckets + contract-violations account for every event
 *   - order independence: a shuffled copy of the same views folds identically
 *   - arithmetic: start/end/delta/best/windowSize recomputed independently
 *
 * STRESS_ITER / STRESS_SEED as in the sibling suites; table written to
 * artifacts/stress/mod-session-flow/sessionProgress.failureInjection.json.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { AnalysisRecord } from '@pickle/swing-domain';
import type { SessionEventView } from '../../src/flow/session';
import {
  sessionScoreProgression,
  type SessionScoreProgression,
} from '../../src/flow/sessionProgress';

function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeighted<T extends string>(
  rng: () => number,
  weights: Record<T, number>,
): T {
  const entries = Object.entries(weights) as Array<[T, number]>;
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng() * total;
  for (const [key, weight] of entries) {
    roll -= weight;
    if (roll < 0) return key;
  }
  return entries[entries.length - 1]![0];
}

function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

const DEFAULT_ITERATIONS = 64;

function campaignSeeds(base: number): number[] {
  const one = process.env.STRESS_SEED;
  if (one !== undefined && one !== '') return [Number(one)];
  const raw = process.env.STRESS_ITER;
  const iterations =
    raw !== undefined && raw !== '' ? Number(raw) : DEFAULT_ITERATIONS;
  return Array.from({ length: iterations }, (_, i) => base + i);
}

const ARTIFACT_DIR = path.resolve(
  __dirname,
  '../../../../artifacts/stress/mod-session-flow',
);

function writeCampaignTable(name: string, table: object): string {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const file = path.join(ARTIFACT_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(table, null, 2));
  return file;
}

// ─── Known findings ─────────────────────────────────────────────────────────

const KNOWN_FINDINGS = {
  /** sessionProgress.ts:98-108 — only `overallScore === null` is refused;
   * a scored result carrying NaN / ±Infinity / a non-number is plotted as
   * a point and poisons startAverage/endAverage/delta/best (NaN or
   * Infinity propagate through meanScore/round1). Reachability from a
   * server-accepted AnalysisRecord is not shown here (the edge parser owns
   * that contract) — this pins the module's own defensiveness. */
  P1_NONFINITE_SCORE_PLOTTED: 'P1_NONFINITE_SCORE_PLOTTED',
  /** sessionProgress.ts:94-108 — the fold only recognises
   * `resultKind === 'low_confidence'`; a result with any OTHER unknown kind
   * and a numeric score is plotted as if scored, contradicting the module's
   * "contract violations land in NO bucket" rule (lines 25-27). */
  P2_UNKNOWN_RESULT_KIND_PLOTTED: 'P2_UNKNOWN_RESULT_KIND_PLOTTED',
} as const;
const KNOWN_FINDING_SET = new Set<string>(Object.values(KNOWN_FINDINGS));

// ─── Terminal shapes an event can be resolved into ──────────────────────────

type Shape =
  | 'scored'
  | 'scored_zero'
  | 'scored_ten'
  | 'low_confidence'
  | 'low_confidence_with_score'
  | 'resultless'
  | 'abstained'
  | 'ready_no_record'
  | 'ready_analysis_null'
  | 'scored_null_score'
  | 'scored_nan'
  | 'scored_infinity'
  | 'scored_negative'
  | 'scored_over_ten'
  | 'scored_string'
  | 'unknown_result_kind'
  | 'unknown_state';

const SHAPE_WEIGHTS: Record<Shape, number> = {
  scored: 40,
  scored_zero: 3,
  scored_ten: 3,
  low_confidence: 8,
  low_confidence_with_score: 3,
  resultless: 5,
  abstained: 10,
  ready_no_record: 4,
  ready_analysis_null: 3,
  scored_null_score: 4,
  scored_nan: 3,
  scored_infinity: 2,
  scored_negative: 2,
  scored_over_ten: 2,
  scored_string: 2,
  unknown_result_kind: 3,
  unknown_state: 3,
};

/** Shapes the module documents as landing in NO bucket (contract violations). */
const NO_BUCKET: ReadonlySet<Shape> = new Set<Shape>([
  'ready_no_record',
  'ready_analysis_null',
  'scored_null_score',
  'unknown_state',
]);
/** Shapes that must produce a plotted point. */
const PLOTTED: ReadonlySet<Shape> = new Set<Shape>([
  'scored',
  'scored_zero',
  'scored_ten',
  'scored_negative',
  'scored_over_ten',
]);
/** Shapes plotted with a non-finite score (known finding). */
const PLOTTED_NONFINITE: ReadonlySet<Shape> = new Set<Shape>([
  'scored_nan',
  'scored_infinity',
  'scored_string',
]);
const NO_READ: ReadonlySet<Shape> = new Set<Shape>([
  'low_confidence',
  'low_confidence_with_score',
  'resultless',
  'abstained',
]);

function pendingView(index: number, processing: boolean): SessionEventView {
  return {
    eventId: `E${index + 1}`,
    index,
    startMs: index * 1000,
    peakMs: index * 1000 + 400,
    endMs: index * 1000 + 800,
    closeReason: 'gap',
    state: processing ? 'processing' : 'pending',
    analysis: null,
    techniqueFamily: null,
    abstainReason: null,
    pendingReason: processing ? null : 'AWAITING',
  } as unknown as SessionEventView;
}

function resolvedView(
  base: SessionEventView,
  shape: Shape,
  score: number,
): SessionEventView {
  const record = (result: unknown): AnalysisRecord =>
    ({
      id: `rec-${base.eventId}`,
      strokeResolution: { kind: 'unresolved', reason: 'stress' },
      result,
    }) as unknown as AnalysisRecord;
  const ready = (analysis: unknown): SessionEventView =>
    ({
      ...base,
      state: 'ready',
      analysis,
      pendingReason: null,
    }) as SessionEventView;
  switch (shape) {
    case 'scored':
      return ready(record({ resultKind: 'scored', overallScore: score }));
    case 'scored_zero':
      return ready(record({ resultKind: 'scored', overallScore: 0 }));
    case 'scored_ten':
      return ready(record({ resultKind: 'scored', overallScore: 10 }));
    case 'low_confidence':
      return ready(
        record({ resultKind: 'low_confidence', overallScore: null }),
      );
    case 'low_confidence_with_score':
      return ready(
        record({ resultKind: 'low_confidence', overallScore: score }),
      );
    case 'resultless':
      return ready(record(null));
    case 'abstained':
      return {
        ...base,
        state: 'abstained',
        abstainReason: 'STRESS_ABSTAIN',
        pendingReason: null,
      } as SessionEventView;
    case 'ready_no_record':
      return ready(undefined);
    case 'ready_analysis_null':
      return ready(null);
    case 'scored_null_score':
      return ready(record({ resultKind: 'scored', overallScore: null }));
    case 'scored_nan':
      return ready(record({ resultKind: 'scored', overallScore: Number.NaN }));
    case 'scored_infinity':
      return ready(
        record({
          resultKind: 'scored',
          overallScore: Number.POSITIVE_INFINITY,
        }),
      );
    case 'scored_negative':
      return ready(record({ resultKind: 'scored', overallScore: -3.5 }));
    case 'scored_over_ten':
      return ready(record({ resultKind: 'scored', overallScore: 42 }));
    case 'scored_string':
      return ready(record({ resultKind: 'scored', overallScore: '7.5' }));
    case 'unknown_result_kind':
      return ready(record({ resultKind: 'weird', overallScore: score }));
    case 'unknown_state':
      return { ...base, state: 'exploded' } as unknown as SessionEventView;
  }
}

// ─── Independent oracle ─────────────────────────────────────────────────────

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

interface Oracle {
  plotted: Array<{ eventId: string; index: number; score: unknown }>;
  noRead: number;
  pending: number;
  noBucket: number;
  nonFinite: number;
  unknownKind: number;
}

function oracle(
  shapes: ReadonlyMap<number, [Shape, number]>,
  total: number,
): Oracle {
  const out: Oracle = {
    plotted: [],
    noRead: 0,
    pending: 0,
    noBucket: 0,
    nonFinite: 0,
    unknownKind: 0,
  };
  for (let i = 0; i < total; i += 1) {
    const resolved = shapes.get(i);
    if (!resolved) {
      out.pending += 1;
      continue;
    }
    const [shape, score] = resolved;
    if (NO_BUCKET.has(shape)) out.noBucket += 1;
    else if (shape === 'unknown_result_kind') {
      out.unknownKind += 1;
      out.plotted.push({ eventId: `E${i + 1}`, index: i, score });
    } else if (NO_READ.has(shape)) out.noRead += 1;
    else if (PLOTTED.has(shape)) {
      const value =
        shape === 'scored'
          ? score
          : shape === 'scored_zero'
            ? 0
            : shape === 'scored_ten'
              ? 10
              : shape === 'scored_negative'
                ? -3.5
                : 42;
      out.plotted.push({ eventId: `E${i + 1}`, index: i, score: value });
    } else if (PLOTTED_NONFINITE.has(shape)) {
      out.nonFinite += 1;
      out.plotted.push({
        eventId: `E${i + 1}`,
        index: i,
        score:
          shape === 'scored_nan'
            ? Number.NaN
            : shape === 'scored_infinity'
              ? Number.POSITIVE_INFINITY
              : '7.5',
      });
    }
  }
  return out;
}

function checkAgainstOracle(
  progression: SessionScoreProgression,
  expected: Oracle,
  total: number,
  violations: string[],
  observations: Set<string>,
  step: string,
): void {
  const tag = `[${step}]`;
  if (progression.pendingCount !== expected.pending)
    violations.push(
      `${tag} pendingCount ${progression.pendingCount} != ${expected.pending}`,
    );
  if (progression.noReadCount !== expected.noRead)
    violations.push(
      `${tag} noReadCount ${progression.noReadCount} != ${expected.noRead}`,
    );
  if (progression.scoredCount !== expected.plotted.length)
    violations.push(
      `${tag} scoredCount ${progression.scoredCount} != ${expected.plotted.length}`,
    );
  if (progression.points.length !== progression.scoredCount)
    violations.push(`${tag} points/scoredCount mismatch`);
  const bucketed =
    progression.scoredCount +
    progression.noReadCount +
    progression.pendingCount +
    expected.noBucket;
  if (bucketed !== total)
    violations.push(`${tag} buckets ${bucketed} != events ${total}`);

  const expectedPoints = [...expected.plotted].sort(
    (a, b) => a.index - b.index,
  );
  progression.points.forEach((point, i) => {
    const want = expectedPoints[i];
    if (!want) {
      violations.push(`${tag} extra point ${point.eventId}`);
      return;
    }
    if (point.eventId !== want.eventId || point.eventIndex !== want.index)
      violations.push(
        `${tag} point order/identity ${point.eventId} vs ${want.eventId}`,
      );
    if (!Object.is(point.score, want.score) && point.score !== want.score)
      violations.push(
        `${tag} point score ${String(point.score)} != ${String(want.score)}`,
      );
    if (i > 0 && progression.points[i - 1]!.eventIndex >= point.eventIndex)
      violations.push(`${tag} points not strictly index-ordered`);
    if (point.endMs !== point.eventIndex * 1000 + 800)
      violations.push(`${tag} endMs not carried from the view`);
  });

  const n = progression.scoredCount;
  const window = n >= 6 ? 3 : n >= 4 ? 2 : 1;
  if (progression.windowSize !== window)
    violations.push(`${tag} windowSize ${progression.windowSize} != ${window}`);

  if (expected.unknownKind > 0)
    observations.add(KNOWN_FINDINGS.P2_UNKNOWN_RESULT_KIND_PLOTTED);
  if (expected.nonFinite > 0) {
    observations.add(KNOWN_FINDINGS.P1_NONFINITE_SCORE_PLOTTED);
    return;
  }
  const scores = progression.points.map(p => p.score);
  if (n === 0) {
    if (
      progression.startAverage !== null ||
      progression.endAverage !== null ||
      progression.delta !== null ||
      progression.best !== null
    )
      violations.push(`${tag} empty progression reports numbers`);
    return;
  }
  const mean = (xs: number[]): number =>
    xs.reduce((s, x) => s + x, 0) / xs.length;
  const start = round1(mean(scores.slice(0, window)));
  const end = round1(mean(scores.slice(-window)));
  if (progression.startAverage !== start)
    violations.push(
      `${tag} startAverage ${progression.startAverage} != ${start}`,
    );
  if (progression.endAverage !== end)
    violations.push(`${tag} endAverage ${progression.endAverage} != ${end}`);
  const delta = n >= 2 ? round1(end - start) : null;
  if (progression.delta !== delta)
    violations.push(`${tag} delta ${progression.delta} != ${delta}`);
  let best = progression.points[0]!;
  for (const point of progression.points)
    if (point.score > best.score) best = point;
  if (progression.best?.eventId !== best.eventId)
    violations.push(
      `${tag} best ${progression.best?.eventId} != ${best.eventId}`,
    );
  for (const point of progression.points) {
    if (!Number.isFinite(point.score))
      violations.push(`${tag} non-finite point without a non-finite shape`);
  }
}

// ─── Iteration ──────────────────────────────────────────────────────────────

interface SeedRow {
  seed: number;
  verdict: 'HELD' | 'HELD_KNOWN' | 'BROKEN';
  eventCount: number;
  shapes: Record<string, Shape>;
  resolutionOrder: string[];
  injectedFaults: number;
  observations: string[];
  violations: string[];
  final: {
    scoredCount: number;
    noReadCount: number;
    pendingCount: number;
    delta: number | null | string;
    best: string | null;
  };
}

function runIteration(seed: number): SeedRow {
  const rng = makeRng(seed);
  const total = 1 + Math.floor(rng() * 14);
  const views: SessionEventView[] = Array.from({ length: total }, (_, i) =>
    pendingView(i, rng() < 0.3),
  );
  const order = shuffled(
    Array.from({ length: total }, (_, i) => i),
    rng,
  );
  const leaveUnresolved = Math.floor(rng() * Math.min(3, total));
  const steps = order.slice(0, total - leaveUnresolved);
  const shapes = new Map<number, [Shape, number]>();
  const shapeById: Record<string, Shape> = {};
  const violations: string[] = [];
  const observations = new Set<string>();
  let injectedFaults = 0;

  let previous = sessionScoreProgression(views);
  checkAgainstOracle(
    previous,
    oracle(shapes, total),
    total,
    violations,
    observations,
    'start',
  );
  const frozenScores = new Map<string, number>();

  for (const index of steps) {
    const shape = pickWeighted(rng, SHAPE_WEIGHTS);
    const score = Math.round(rng() * 100) / 10;
    shapes.set(index, [shape, score]);
    shapeById[`E${index + 1}`] = shape;
    if (
      (!PLOTTED.has(shape) && !NO_READ.has(shape)) ||
      shape === 'low_confidence_with_score'
    )
      injectedFaults += 1;
    if (shape === 'scored_negative' || shape === 'scored_over_ten')
      injectedFaults += 1;
    views[index] = resolvedView(views[index]!, shape, score);

    const next = sessionScoreProgression(views);
    const step = `resolve E${index + 1} as ${shape}`;
    checkAgainstOracle(
      next,
      oracle(shapes, total),
      total,
      violations,
      observations,
      step,
    );

    // Monotonicity across the resolution sequence.
    if (next.pendingCount > previous.pendingCount)
      violations.push(`[${step}] pendingCount grew`);
    if (
      next.scoredCount + next.noReadCount <
      previous.scoredCount + previous.noReadCount
    )
      violations.push(`[${step}] resolved count shrank`);
    if (next.windowSize < previous.windowSize)
      violations.push(`[${step}] windowSize shrank`);
    if (next.points.length < previous.points.length)
      violations.push(`[${step}] points removed`);
    for (const point of next.points) {
      const frozen = frozenScores.get(point.eventId);
      if (frozen !== undefined && !Object.is(frozen, point.score))
        violations.push(`[${step}] plotted score for ${point.eventId} changed`);
      frozenScores.set(point.eventId, point.score);
    }
    if (
      previous.best &&
      next.best &&
      Number.isFinite(previous.best.score) &&
      Number.isFinite(next.best.score) &&
      next.best.score < previous.best.score
    )
      violations.push(`[${step}] best score dropped`);
    if (previous.best && !next.best) violations.push(`[${step}] best vanished`);

    // Order independence: a shuffled copy folds identically.
    const reordered = sessionScoreProgression(shuffled(views, rng));
    if (JSON.stringify(reordered) !== JSON.stringify(next))
      violations.push(`[${step}] order-dependent result`);
    previous = next;
  }

  for (const code of observations)
    if (!KNOWN_FINDING_SET.has(code))
      violations.push(`unknown observation ${code}`);

  return {
    seed,
    verdict:
      violations.length > 0
        ? 'BROKEN'
        : observations.size > 0
          ? 'HELD_KNOWN'
          : 'HELD',
    eventCount: total,
    shapes: shapeById,
    resolutionOrder: steps.map(i => `E${i + 1}`),
    injectedFaults,
    observations: [...observations].sort(),
    violations,
    final: {
      scoredCount: previous.scoredCount,
      noReadCount: previous.noReadCount,
      pendingCount: previous.pendingCount,
      delta:
        previous.delta === null || Number.isFinite(previous.delta)
          ? previous.delta
          : String(previous.delta),
      best: previous.best?.eventId ?? null,
    },
  };
}

// ─── Campaign ───────────────────────────────────────────────────────────────

describe('stress/failure-injection: sessionScoreProgression', () => {
  it('stays monotone and honest across seeded resolution sequences with malformed views', () => {
    const seeds = campaignSeeds(9_000);
    const rows = seeds.map(runIteration);
    const broken = rows.filter(row => row.verdict === 'BROKEN');
    const totalFaults = rows.reduce((sum, row) => sum + row.injectedFaults, 0);
    const observationCounts: Record<string, number> = {};
    for (const row of rows)
      for (const code of row.observations)
        observationCounts[code] = (observationCounts[code] ?? 0) + 1;

    const file = writeCampaignTable('sessionProgress.failureInjection', {
      campaign: 'sessionProgress.failureInjection',
      unit: 'apps/mobile/src/flow/sessionProgress.ts',
      iterations: rows.length,
      resolutionSteps: rows.reduce(
        (sum, row) => sum + row.resolutionOrder.length,
        0,
      ),
      injectedFaults: totalFaults,
      verdicts: {
        HELD: rows.filter(r => r.verdict === 'HELD').length,
        HELD_KNOWN: rows.filter(r => r.verdict === 'HELD_KNOWN').length,
        BROKEN: broken.length,
      },
      observationCounts,
      knownFindings: KNOWN_FINDINGS,
      rows,
    });

    expect(rows.length).toBe(seeds.length);
    if (seeds.length >= DEFAULT_ITERATIONS)
      expect(totalFaults).toBeGreaterThanOrEqual(60);
    expect({
      brokenSeeds: broken.map(row => ({
        seed: row.seed,
        violations: row.violations,
      })),
      table: file,
    }).toEqual({ brokenSeeds: [], table: file });
  });

  it('is replayable: the same seed produces the same outcome row', () => {
    const seed = Number(process.env.STRESS_SEED ?? 9_013);
    expect(runIteration(seed)).toEqual(runIteration(seed));
  });

  test.failing(
    `${KNOWN_FINDINGS.P2_UNKNOWN_RESULT_KIND_PLOTTED}: a result of unknown kind must land in no bucket, not be plotted`,
    () => {
      const progression = sessionScoreProgression([
        resolvedView(pendingView(0, false), 'unknown_result_kind', 9.9),
      ]);
      expect(progression.points).toEqual([]);
      expect(progression.scoredCount).toBe(0);
    },
  );

  test.failing(
    `${KNOWN_FINDINGS.P1_NONFINITE_SCORE_PLOTTED}: a scored result with a NaN score must not be plotted or poison the averages`,
    () => {
      const views = [
        resolvedView(pendingView(0, false), 'scored', 6),
        resolvedView(pendingView(1, false), 'scored_nan', 0),
        resolvedView(pendingView(2, false), 'scored', 8),
      ];
      const progression = sessionScoreProgression(views);
      expect(progression.points.every(p => Number.isFinite(p.score))).toBe(
        true,
      );
      expect(Number.isFinite(progression.startAverage)).toBe(true);
      expect(Number.isFinite(progression.endAverage)).toBe(true);
      expect(Number.isFinite(progression.delta)).toBe(true);
    },
  );
});
