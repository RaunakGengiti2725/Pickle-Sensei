import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CellResult } from "./runCell.js";
import type { CellSpec, MatrixScale } from "./shapes.js";

/**
 * Raw-evidence writer: JSON tables + a replay bundle for every violating
 * cell, so any failure is reproducible with `runCell(spec)` from the
 * serialized `CellSpec` alone.
 */

export interface MatrixSummary {
  harnessVersion: string;
  synthVersion: string;
  masterSeed: number;
  scale: MatrixScale;
  startedAtIso: string;
  finishedAtIso: string;
  wallClockMs: number;
  cells: number;
  degenerateCells: number;
  violatingCells: number;
  violationsByInvariant: Record<string, number>;
  outcomes: Record<string, number>;
  /** Cells whose fusion stage was skipped by the frame budget, with the reason. */
  notRun: Array<{ cellId: string; windowFrames: number; skipped: string }>;
  deliveryGuided: Record<string, number>;
  deliveryImported: Record<string, number>;
  /** outcome × resolution family / fps / duration id / trigger. */
  outcomeByResolution: Record<string, Record<string, number>>;
  outcomeByFps: Record<string, Record<string, number>>;
  outcomeByDuration: Record<string, Record<string, number>>;
  outcomeByTrigger: Record<string, Record<string, number>>;
  fusionFailureCodes: Record<string, number>;
  preGateReasons: Record<string, number>;
  envelopeUnsupportedDimensions: Record<string, number>;
  /**
   * Cells whose resolution differs but every other axis (fps, duration,
   * trigger, master seed) is identical: outcome spread and score spread
   * across resolutions. Content is the same body; only the container and
   * jitter magnitude change.
   */
  aspectSensitivity: AspectSensitivityRow[];
  heap: {
    maxHeapUsedDeltaBytes: number;
    maxHeapUsedDeltaCell: string;
    maxRssBytes: number;
    maxRssCell: string;
    maxSidecarBytes: number;
    maxSidecarCell: string;
    maxFusionDurationMs: number;
    maxFusionDurationCell: string;
    maxPoseFrames: number;
    maxPoseFramesCell: string;
  };
  scoredWithoutBlock: number;
  scoredButMobileBlocked: number;
  /**
   * Gate-vs-outcome cross tabs. These are observations about where the
   * measured gates and the fusion outcome disagree, listed by cell so the
   * findings can cite exact replayable inputs.
   */
  gateCrossTab: {
    qualityRefusedButGatePassed: number;
    scoredDespitePreGateRefusal: string[];
    scoredDespiteQualityRefusal: string[];
    scoredBelowMinEffectiveFps: string[];
    scoredWithEnvelopeUnsupported: string[];
    importedDeliveryScoredDespiteAnyGateRefusal: string[];
    /** analyzeCapture scored an in-memory sequence whose serialized form the sidecar parser refused. */
    scoredOnParserRejectedInput: string[];
  };
  /** analyzeCapture wall time per cell keyed by window frame count (scaling evidence). */
  fusionMsByWindowFrames: Array<{ windowFrames: number; cellId: string; fusionMs: number }>;
}

export interface AspectSensitivityRow {
  group: string;
  cells: number;
  outcomes: Record<string, number>;
  scoredOverallScores: Record<string, number>;
  scoreSpread: number | null;
  contactMsSpread: number | null;
}

function bump(table: Record<string, number>, key: string): void {
  table[key] = (table[key] ?? 0) + 1;
}

function bump2(table: Record<string, Record<string, number>>, row: string, key: string): void {
  const inner = (table[row] ??= {});
  inner[key] = (inner[key] ?? 0) + 1;
}

export function summarize(
  results: CellResult[],
  degenerate: CellResult[],
  meta: {
    masterSeed: number;
    scale: MatrixScale;
    startedAtIso: string;
    finishedAtIso: string;
    wallClockMs: number;
  },
): MatrixSummary {
  const all = [...results, ...degenerate];
  const first = all[0];
  const summary: MatrixSummary = {
    harnessVersion: first?.harnessVersion ?? "",
    synthVersion: first?.synthVersion ?? "",
    masterSeed: meta.masterSeed,
    scale: meta.scale,
    startedAtIso: meta.startedAtIso,
    finishedAtIso: meta.finishedAtIso,
    wallClockMs: meta.wallClockMs,
    cells: results.length,
    degenerateCells: degenerate.length,
    violatingCells: all.filter((r) => r.violations.length > 0).length,
    violationsByInvariant: {},
    outcomes: {},
    notRun: [],
    deliveryGuided: {},
    deliveryImported: {},
    outcomeByResolution: {},
    outcomeByFps: {},
    outcomeByDuration: {},
    outcomeByTrigger: {},
    fusionFailureCodes: {},
    preGateReasons: {},
    envelopeUnsupportedDimensions: {},
    aspectSensitivity: [],
    heap: {
      maxHeapUsedDeltaBytes: 0,
      maxHeapUsedDeltaCell: "",
      maxRssBytes: 0,
      maxRssCell: "",
      maxSidecarBytes: 0,
      maxSidecarCell: "",
      maxFusionDurationMs: 0,
      maxFusionDurationCell: "",
      maxPoseFrames: 0,
      maxPoseFramesCell: "",
    },
    scoredWithoutBlock: 0,
    scoredButMobileBlocked: 0,
    gateCrossTab: {
      qualityRefusedButGatePassed: 0,
      scoredDespitePreGateRefusal: [],
      scoredDespiteQualityRefusal: [],
      scoredBelowMinEffectiveFps: [],
      scoredWithEnvelopeUnsupported: [],
      importedDeliveryScoredDespiteAnyGateRefusal: [],
      scoredOnParserRejectedInput: [],
    },
    fusionMsByWindowFrames: [],
  };

  for (const r of all) {
    for (const v of r.violations) bump(summary.violationsByInvariant, v.invariant);
    bump(summary.outcomes, r.fusion.outcome);
    if (r.fusion.outcome === "not_run") {
      summary.notRun.push({
        cellId: r.spec.cellId,
        windowFrames: r.fusion.windowFrames,
        skipped: r.fusion.skipped ?? "",
      });
    } else {
      summary.fusionMsByWindowFrames.push({
        windowFrames: r.fusion.windowFrames,
        cellId: r.spec.cellId,
        fusionMs: Number(r.fusion.durationMs.toFixed(1)),
      });
    }
    bump(summary.deliveryGuided, r.delivery.guided);
    if (r.delivery.imported !== null) bump(summary.deliveryImported, r.delivery.imported);
    const x = summary.gateCrossTab;
    if (r.preGate.qualityRefusedButGatePassed) x.qualityRefusedButGatePassed += 1;
    if (r.fusion.outcome === "scored") {
      if (!r.preGate.ok) x.scoredDespitePreGateRefusal.push(r.spec.cellId);
      if (!r.poseQuality.analyzable) x.scoredDespiteQualityRefusal.push(r.spec.cellId);
      if (r.poseQuality.reasons.includes("insufficient_fps")) {
        x.scoredBelowMinEffectiveFps.push(r.spec.cellId);
      }
      if (r.envelope.overall === "UNSUPPORTED") x.scoredWithEnvelopeUnsupported.push(r.spec.cellId);
      if (!r.sidecar.ok) x.scoredOnParserRejectedInput.push(r.spec.cellId);
      if (
        r.delivery.imported === "scored" &&
        (!r.preGate.ok || !r.poseQuality.analyzable || r.envelope.overall === "UNSUPPORTED")
      ) {
        x.importedDeliveryScoredDespiteAnyGateRefusal.push(r.spec.cellId);
      }
    }
    bump2(summary.outcomeByResolution, r.spec.resolution.id, r.fusion.outcome);
    bump2(summary.outcomeByFps, `fps_${r.spec.fps}`, r.fusion.outcome);
    bump2(summary.outcomeByDuration, r.spec.duration.id, r.fusion.outcome);
    bump2(summary.outcomeByTrigger, r.spec.trigger, r.fusion.outcome);
    if (r.fusion.failure) bump(summary.fusionFailureCodes, r.fusion.failure.code);
    for (const reason of r.preGate.reasons) bump(summary.preGateReasons, reason);
    if (r.preGate.failure) bump(summary.preGateReasons, `failure:${r.preGate.failure.code}`);
    for (const dim of r.envelope.unsupported) bump(summary.envelopeUnsupportedDimensions, dim);
    if (r.fusion.outcome === "scored") {
      if (r.envelope.mobileWouldBlock) summary.scoredButMobileBlocked += 1;
      else summary.scoredWithoutBlock += 1;
    }
    const h = summary.heap;
    if (r.fusion.heapUsedDeltaBytes > h.maxHeapUsedDeltaBytes) {
      h.maxHeapUsedDeltaBytes = r.fusion.heapUsedDeltaBytes;
      h.maxHeapUsedDeltaCell = r.spec.cellId;
    }
    if (r.fusion.rssAfterBytes > h.maxRssBytes) {
      h.maxRssBytes = r.fusion.rssAfterBytes;
      h.maxRssCell = r.spec.cellId;
    }
    if (r.input.sidecarBytes > h.maxSidecarBytes) {
      h.maxSidecarBytes = r.input.sidecarBytes;
      h.maxSidecarCell = r.spec.cellId;
    }
    if (r.fusion.durationMs > h.maxFusionDurationMs) {
      h.maxFusionDurationMs = r.fusion.durationMs;
      h.maxFusionDurationCell = r.spec.cellId;
    }
    if (r.input.poseFrameCount > h.maxPoseFrames) {
      h.maxPoseFrames = r.input.poseFrameCount;
      h.maxPoseFramesCell = r.spec.cellId;
    }
  }

  const groups = new Map<string, CellResult[]>();
  for (const r of results) {
    const key = `fps_${r.spec.fps}|${r.spec.duration.id}|${r.spec.trigger}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  for (const [group, rows] of groups) {
    const outcomes: Record<string, number> = {};
    const scores: Record<string, number> = {};
    const contacts: number[] = [];
    for (const r of rows) {
      bump(outcomes, r.fusion.outcome);
      if (r.fusion.outcome === "scored" && r.fusion.overallScore !== null) {
        scores[r.spec.resolution.id] = r.fusion.overallScore;
      }
      if (r.fusion.contactMs !== null) contacts.push(r.fusion.contactMs);
    }
    const scoreValues = Object.values(scores);
    summary.aspectSensitivity.push({
      group,
      cells: rows.length,
      outcomes,
      scoredOverallScores: scores,
      scoreSpread:
        scoreValues.length > 1 ? Math.max(...scoreValues) - Math.min(...scoreValues) : null,
      contactMsSpread: contacts.length > 1 ? Math.max(...contacts) - Math.min(...contacts) : null,
    });
  }
  summary.fusionMsByWindowFrames.sort((a, b) => a.windowFrames - b.windowFrames);
  return summary;
}

/** Compact per-cell row for the matrix table (no nested record payloads). */
export function toTableRow(r: CellResult): Record<string, unknown> {
  return {
    cellId: r.spec.cellId,
    seed: r.spec.seed,
    handed: r.spec.handed,
    width: r.spec.resolution.width,
    height: r.spec.resolution.height,
    fps: r.spec.fps,
    durationId: r.spec.duration.id,
    trigger: r.spec.trigger,
    poseFrames: r.input.poseFrameCount,
    videoFrames: r.input.videoFrameCount,
    clipDurationMs: r.input.clipDurationMs,
    outOfFrameLandmarkFraction: Number(r.input.outOfFrameLandmarkFraction.toFixed(4)),
    sidecarBytes: r.input.sidecarBytes,
    sidecarOk: r.sidecar.ok,
    sidecarFailure: r.sidecar.failure?.code ?? null,
    envelopeOverall: r.envelope.overall,
    envelopeUnsupported: r.envelope.unsupported.join("|"),
    envelopeDegraded: r.envelope.degraded.join("|"),
    frameGate: r.frameGate.analyzable,
    frameReasons: r.frameGate.reasons.join("|"),
    poseQuality: r.poseQuality.analyzable,
    poseReasons: r.poseQuality.reasons.join("|"),
    preGateOk: r.preGate.ok,
    preGateFailure: r.preGate.failure?.code ?? null,
    qualityRefusedButGatePassed: r.preGate.qualityRefusedButGatePassed,
    windowFrames: r.fusion.windowFrames,
    fusionOutcome: r.fusion.outcome,
    fusionSkipped: r.fusion.skipped,
    fusionFailure: r.fusion.failure?.code ?? null,
    fusionThrown: r.fusion.thrown,
    resultKind: r.fusion.resultKind,
    overallScore: r.fusion.overallScore,
    analysisConfidence: r.fusion.analysisConfidence,
    presentation: r.fusion.presentation,
    contactMs: r.fusion.contactMs,
    phases: r.fusion.phases.map((p) => `${p.key}:${p.startMs}-${p.endMs}`).join("|"),
    modelRuns: r.fusion.modelRuns.map((m) => `${m.task}=${m.status}`).join("|"),
    fusionMs: Number(r.fusion.durationMs.toFixed(2)),
    heapDeltaBytes: r.fusion.heapUsedDeltaBytes,
    rssBytes: r.fusion.rssAfterBytes,
    deterministic: r.determinism.checked ? r.determinism.identical : null,
    determinismSkipped: r.determinism.skipped,
    deliveryGuided: r.delivery.guided,
    deliveryImported: r.delivery.imported,
    violations: r.violations.map((v) => v.invariant).join("|"),
  };
}

export interface ReplayBundle {
  cellId: string;
  spec: CellSpec;
  replay: string;
  violations: CellResult["violations"];
  result: CellResult;
}

export function writeArtifacts(
  outDir: string,
  summary: MatrixSummary,
  results: CellResult[],
  degenerate: CellResult[],
): { summaryPath: string; tablePath: string; violationsPath: string; resultsPath: string } {
  mkdirSync(outDir, { recursive: true });
  const all = [...results, ...degenerate];
  const summaryPath = join(outDir, "summary.json");
  const tablePath = join(outDir, "matrix.jsonl");
  const violationsPath = join(outDir, "violations.json");
  const resultsPath = join(outDir, "results.json");
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  writeFileSync(tablePath, all.map((r) => JSON.stringify(toTableRow(r))).join("\n") + "\n");
  const bundles: ReplayBundle[] = all
    .filter((r) => r.violations.length > 0)
    .map((r) => ({
      cellId: r.spec.cellId,
      spec: r.spec,
      replay: `XC_MATRIX_REPLAY_CELL='${r.spec.cellId}' XC_MATRIX_SEED=${r.spec.masterSeed} pnpm --filter @pickle/swing-lab exec vitest run test/xcMatrixMedia1.test.ts`,
      violations: r.violations,
      result: r,
    }));
  writeFileSync(violationsPath, JSON.stringify(bundles, null, 2));
  writeFileSync(resultsPath, JSON.stringify(all));
  return { summaryPath, tablePath, violationsPath, resultsPath };
}
