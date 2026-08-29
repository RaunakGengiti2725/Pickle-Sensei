/**
 * Score-version governance (directive: spec p. 22/44). Every persisted score
 * carries its `scoringModelVersion`; scores produced under different model
 * versions are incomparable unless a comparability rule explicitly says
 * otherwise. Progress lines never silently span incomparable versions — the
 * series is segmented and a `version_transition` marker is rendered at each
 * boundary, or the caller reprocesses under the new model as a NEW analysis
 * run. Historical runs are immutable: reprocessing appends, never overwrites.
 */

export interface VersionedScore {
  /** The analysis run that produced this score. */
  runId: string;
  shotId: string;
  scoringModelVersion: string;
  /** 0..10 overall score, or null when the model abstained. */
  overallScore: number | null;
  /** When the underlying shot was captured (ISO-8601). */
  capturedAt: string;
  /** When this score was computed (ISO-8601). */
  scoredAt: string;
}

/**
 * An explicit, directional-symmetric declaration that scores from two model
 * versions live on the same scale and may appear on one continuous progress
 * line. Absence of a rule means NOT comparable — the safe default.
 */
export interface ComparabilityRule {
  versionA: string;
  versionB: string;
  /** Why these versions are score-compatible (audit trail; must be non-empty). */
  rationale: string;
}

export class VersionComparability {
  private readonly pairs = new Set<string>();

  constructor(rules: readonly ComparabilityRule[] = []) {
    for (const rule of rules) {
      if (rule.rationale.trim() === "") {
        throw new Error(
          `Comparability rule ${rule.versionA}<->${rule.versionB} requires a non-empty rationale.`,
        );
      }
      this.pairs.add(pairKey(rule.versionA, rule.versionB));
    }
  }

  /** Reflexive; otherwise true only for explicitly declared pairs. */
  isComparable(versionA: string, versionB: string): boolean {
    if (versionA === versionB) return true;
    return this.pairs.has(pairKey(versionA, versionB));
  }
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

export interface ProgressSegment {
  scoringModelVersion: string;
  points: VersionedScore[];
}

export type ProgressLineElement =
  | { kind: "segment"; segment: ProgressSegment }
  | {
      kind: "version_transition";
      fromVersion: string;
      toVersion: string;
      /** ISO-8601 timestamp of the first point after the transition. */
      at: string;
    };

/**
 * Builds a renderable progress line from versioned scores. Points are ordered
 * by capture time; whenever consecutive points were scored under versions
 * that are not comparable, the line is broken into separate segments joined
 * by an explicit `version_transition` element. Deltas (improvement claims)
 * may only ever be computed within a single segment.
 */
export function buildProgressLine(
  scores: readonly VersionedScore[],
  comparability: VersionComparability,
): ProgressLineElement[] {
  for (const score of scores) {
    if (score.scoringModelVersion.trim() === "") {
      throw new Error(`Score for shot ${score.shotId} is missing scoringModelVersion.`);
    }
  }
  const ordered = [...scores].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  const elements: ProgressLineElement[] = [];
  let current: ProgressSegment | null = null;
  for (const point of ordered) {
    if (current === null) {
      current = { scoringModelVersion: point.scoringModelVersion, points: [point] };
      continue;
    }
    if (comparability.isComparable(current.scoringModelVersion, point.scoringModelVersion)) {
      current.points.push(point);
      continue;
    }
    elements.push({ kind: "segment", segment: current });
    elements.push({
      kind: "version_transition",
      fromVersion: current.scoringModelVersion,
      toVersion: point.scoringModelVersion,
      at: point.capturedAt,
    });
    current = { scoringModelVersion: point.scoringModelVersion, points: [point] };
  }
  if (current !== null) elements.push({ kind: "segment", segment: current });
  return elements;
}

/**
 * Improvement between the first and last scored point of ONE segment. Returns
 * null when the segment has fewer than two scored points — a single point is
 * not a trend. Cross-segment deltas are structurally impossible: this function
 * only accepts one segment.
 */
export function segmentDelta(segment: ProgressSegment): number | null {
  const scored = segment.points.filter(
    (point): point is VersionedScore & { overallScore: number } => point.overallScore !== null,
  );
  if (scored.length < 2) return null;
  const first = scored[0]!;
  const last = scored[scored.length - 1]!;
  return last.overallScore - first.overallScore;
}

export interface AnalysisRun {
  runId: string;
  shotId: string;
  scoringModelVersion: string;
  overallScore: number | null;
  capturedAt: string;
  scoredAt: string;
  /** The run this one reprocessed, when applicable. The old run stays intact. */
  reprocessedFromRunId: string | null;
}

/**
 * Append-only ledger of analysis runs. A run, once recorded, can never be
 * mutated or replaced: recording a run with an existing runId throws, and
 * reprocessing a shot under a new model version creates a NEW run that
 * references (but does not touch) the run it supersedes. Reads return
 * defensive copies so callers cannot mutate stored history.
 */
export class AnalysisRunLedger {
  private readonly runs = new Map<string, AnalysisRun>();

  record(run: AnalysisRun): AnalysisRun {
    if (run.scoringModelVersion.trim() === "") {
      throw new Error(`Analysis run ${run.runId} is missing scoringModelVersion.`);
    }
    if (this.runs.has(run.runId)) {
      throw new Error(
        `Analysis run ${run.runId} already exists; runs are immutable and may not be overwritten.`,
      );
    }
    if (run.reprocessedFromRunId !== null) {
      const source = this.runs.get(run.reprocessedFromRunId);
      if (!source) {
        throw new Error(
          `Analysis run ${run.runId} claims to reprocess unknown run ${run.reprocessedFromRunId}.`,
        );
      }
      if (source.shotId !== run.shotId) {
        throw new Error(
          `Analysis run ${run.runId} reprocesses run ${run.reprocessedFromRunId} for a different shot.`,
        );
      }
    }
    const stored: AnalysisRun = { ...run };
    this.runs.set(stored.runId, stored);
    return { ...stored };
  }

  /**
   * Re-score a shot under a new model version as a NEW run. The original run
   * is preserved verbatim — both runs, their versions, and their timestamps
   * remain queryable forever.
   */
  reprocess(
    sourceRunId: string,
    next: {
      runId: string;
      scoringModelVersion: string;
      overallScore: number | null;
      scoredAt: string;
    },
  ): AnalysisRun {
    const source = this.runs.get(sourceRunId);
    if (!source) throw new Error(`Cannot reprocess unknown run ${sourceRunId}.`);
    return this.record({
      runId: next.runId,
      shotId: source.shotId,
      scoringModelVersion: next.scoringModelVersion,
      overallScore: next.overallScore,
      capturedAt: source.capturedAt,
      scoredAt: next.scoredAt,
      reprocessedFromRunId: sourceRunId,
    });
  }

  get(runId: string): AnalysisRun | null {
    const run = this.runs.get(runId);
    return run ? { ...run } : null;
  }

  /** All runs for a shot, oldest first — history is never collapsed. */
  runsForShot(shotId: string): AnalysisRun[] {
    return [...this.runs.values()]
      .filter((run) => run.shotId === shotId)
      .sort((a, b) => a.scoredAt.localeCompare(b.scoredAt))
      .map((run) => ({ ...run }));
  }

  /**
   * The latest run per shot under exactly the given model version — the input
   * for a single-version progress line after a reprocessing pass. Shots never
   * scored under this version are omitted, never substituted from another
   * version.
   */
  latestRunsUnderVersion(scoringModelVersion: string): AnalysisRun[] {
    const byShot = new Map<string, AnalysisRun>();
    for (const run of this.runs.values()) {
      if (run.scoringModelVersion !== scoringModelVersion) continue;
      const existing = byShot.get(run.shotId);
      if (!existing || run.scoredAt > existing.scoredAt) byShot.set(run.shotId, run);
    }
    return [...byShot.values()]
      .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
      .map((run) => ({ ...run }));
  }
}
