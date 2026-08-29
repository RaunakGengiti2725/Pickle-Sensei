/**
 * Score-version governance (spec pp. 22, 44): every score carries the
 * scoring model version that produced it, versions are incomparable unless an
 * explicit calibration declaration says otherwise, and progress lines never
 * silently span incomparable versions — a boundary is either a rendered
 * version transition or a reprocessing under the new model as a NEW analysis
 * run. Historical runs are immutable: reprocessing appends, never overwrites.
 */

export class ScoreVersioningError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ScoreVersioningError";
  }
}

function assertVersion(version: string, field: string): void {
  if (version.trim() === "") {
    throw new ScoreVersioningError(
      "version.missing",
      `${field} must be a non-empty scoring model version.`,
    );
  }
}

/**
 * An explicit, evidence-backed declaration that scores from two model
 * versions may be plotted on the same continuous progress line. Absent a
 * declaration, versions are incomparable — that is the only safe default.
 */
export interface ComparabilityDeclaration {
  fromVersion: string;
  toVersion: string;
  /** Reference to the calibration evidence (report id/URI), never free-form "trust me". */
  calibrationEvidenceRef: string;
  declaredAtIso: string;
}

export class ScoreVersionRegistry {
  private readonly declarations = new Map<string, ComparabilityDeclaration>();

  private static key(a: string, b: string): string {
    return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
  }

  declareComparable(declaration: ComparabilityDeclaration): void {
    assertVersion(declaration.fromVersion, "fromVersion");
    assertVersion(declaration.toVersion, "toVersion");
    if (declaration.fromVersion === declaration.toVersion) {
      throw new ScoreVersioningError(
        "comparability.self",
        "A version is always comparable with itself; declaring it is a smell.",
      );
    }
    if (declaration.calibrationEvidenceRef.trim() === "") {
      throw new ScoreVersioningError(
        "comparability.no_evidence",
        "Comparability requires a calibration evidence reference.",
      );
    }
    const key = ScoreVersionRegistry.key(declaration.fromVersion, declaration.toVersion);
    if (this.declarations.has(key)) {
      throw new ScoreVersioningError(
        "comparability.duplicate",
        "Comparability between these versions is already declared; declarations are immutable.",
      );
    }
    this.declarations.set(key, Object.freeze({ ...declaration }));
  }

  /** Same version, or an explicit declaration. Comparability is NOT transitive. */
  areComparable(a: string, b: string): boolean {
    assertVersion(a, "version a");
    assertVersion(b, "version b");
    if (a === b) return true;
    return this.declarations.has(ScoreVersionRegistry.key(a, b));
  }

  declarationFor(a: string, b: string): ComparabilityDeclaration | null {
    return this.declarations.get(ScoreVersionRegistry.key(a, b)) ?? null;
  }
}

export interface VersionedProgressPoint {
  /** ISO date (YYYY-MM-DD) or any lexically ordered day key. */
  day: string;
  scoringModelVersion: string;
  score: number;
}

export interface ProgressSegment {
  /** Versions inside one segment are pairwise comparable by declaration. */
  versions: string[];
  points: VersionedProgressPoint[];
}

export interface VersionTransition {
  day: string;
  fromVersion: string;
  toVersion: string;
  /** Always false here: comparable boundaries never become transitions. */
  comparable: false;
}

export interface ProgressLine {
  segments: ProgressSegment[];
  /** Rendered boundaries between incomparable segments — never hidden. */
  transitions: VersionTransition[];
}

/**
 * Split a chronological series into segments that never span incomparable
 * versions. Each incomparable boundary becomes an explicit transition marker
 * the UI must render — a single continuous line across it is impossible.
 */
export function buildProgressLine(
  points: readonly VersionedProgressPoint[],
  registry: ScoreVersionRegistry,
): ProgressLine {
  for (const point of points) assertVersion(point.scoringModelVersion, "point.scoringModelVersion");
  const ordered = [...points].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const segments: ProgressSegment[] = [];
  const transitions: VersionTransition[] = [];
  for (const point of ordered) {
    const current = segments[segments.length - 1];
    const joinable =
      current !== undefined &&
      current.versions.every((v) => registry.areComparable(v, point.scoringModelVersion));
    if (joinable) {
      if (!current.versions.includes(point.scoringModelVersion)) {
        current.versions.push(point.scoringModelVersion);
      }
      current.points.push(point);
      continue;
    }
    if (current !== undefined) {
      const last = current.points[current.points.length - 1]!;
      transitions.push({
        day: point.day,
        fromVersion: last.scoringModelVersion,
        toVersion: point.scoringModelVersion,
        comparable: false,
      });
    }
    segments.push({ versions: [point.scoringModelVersion], points: [point] });
  }
  return { segments, transitions };
}

/**
 * Improvement delta between two scored points. Refuses — rather than
 * fabricating — a number when the versions are not comparable.
 */
export function computeProgressDelta(
  earlier: VersionedProgressPoint,
  later: VersionedProgressPoint,
  registry: ScoreVersionRegistry,
): number {
  if (!registry.areComparable(earlier.scoringModelVersion, later.scoringModelVersion)) {
    throw new ScoreVersioningError(
      "progress.incomparable_versions",
      `Cannot compute progress from ${earlier.scoringModelVersion} to ${later.scoringModelVersion}: ` +
        "no calibration declares these versions comparable. Reprocess under one model " +
        "(as a new analysis run) or render a version transition instead.",
    );
  }
  return later.score - earlier.score;
}

export interface AnalysisRunInput {
  captureId: string;
  scoringModelVersion: string;
  overallScore: number | null;
  producedAtIso: string;
}

export interface AnalysisRun extends AnalysisRunInput {
  runId: string;
  /** Set when this run reprocesses an earlier run's capture under a new model. */
  supersedesRunId: string | null;
}

/**
 * Append-only run ledger. A capture may be analyzed many times (one run per
 * model version pass); no run is ever mutated or deleted, so history under
 * the old model survives reprocessing under the new one.
 */
export class AnalysisRunLedger {
  private readonly runs = new Map<string, Readonly<AnalysisRun>>();
  private sequence = 0;

  private append(run: AnalysisRun): Readonly<AnalysisRun> {
    if (this.runs.has(run.runId)) {
      throw new ScoreVersioningError(
        "run.already_recorded",
        `Analysis run ${run.runId} already exists; runs are immutable and never overwritten.`,
      );
    }
    const frozen = Object.freeze({ ...run });
    this.runs.set(run.runId, frozen);
    return frozen;
  }

  recordRun(input: AnalysisRunInput): Readonly<AnalysisRun> {
    assertVersion(input.scoringModelVersion, "scoringModelVersion");
    this.sequence += 1;
    return this.append({ ...input, runId: `run-${this.sequence}`, supersedesRunId: null });
  }

  /**
   * Reprocess a capture under a different model version: a NEW run that
   * points at the run it supersedes. The superseded run stays untouched —
   * same score, same version, same timestamp.
   */
  reprocess(
    supersededRunId: string,
    update: Pick<AnalysisRunInput, "scoringModelVersion" | "overallScore" | "producedAtIso">,
  ): Readonly<AnalysisRun> {
    assertVersion(update.scoringModelVersion, "scoringModelVersion");
    const superseded = this.runs.get(supersededRunId);
    if (!superseded) {
      throw new ScoreVersioningError(
        "run.not_found",
        `Cannot reprocess unknown run ${supersededRunId}.`,
      );
    }
    if (superseded.scoringModelVersion === update.scoringModelVersion) {
      throw new ScoreVersioningError(
        "run.same_version_reprocess",
        "Reprocessing under the same scoring model version would duplicate, not supersede.",
      );
    }
    this.sequence += 1;
    return this.append({
      captureId: superseded.captureId,
      scoringModelVersion: update.scoringModelVersion,
      overallScore: update.overallScore,
      producedAtIso: update.producedAtIso,
      runId: `run-${this.sequence}`,
      supersedesRunId: supersededRunId,
    });
  }

  getRun(runId: string): Readonly<AnalysisRun> | null {
    return this.runs.get(runId) ?? null;
  }

  /** All runs for a capture in recording order — every version pass preserved. */
  runsForCapture(captureId: string): ReadonlyArray<Readonly<AnalysisRun>> {
    return [...this.runs.values()].filter((run) => run.captureId === captureId);
  }
}
