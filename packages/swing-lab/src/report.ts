import type { AnalysisRecord } from "@pickle/swing-domain";
import type { CaptureQualityReport, ContactEstimate, OfflineStrokeWindow } from "@pickle/vision-geometry";
import type { BallCandidateDiagnostics } from "./ballCandidates.js";
import type { BallAblation } from "./ballTracker.js";
import type { StrokePrediction } from "./strokeHeuristic.js";
import type { KineticEvent } from "./strokeSequence.js";

/**
 * The printed lab report. Verdicts are verbatim from the pipeline — a report
 * line never says more than the underlying record can prove.
 */

export interface PaddleAssociationSummary {
  meanTargetWristDistance: number | null;
  meanOtherWristDistance: number | null;
  rejectedOtherPlayerTracks: number;
  selectionMargin: number | null;
  switchEvents: number;
  risks: string[];
}

export type PaddleReportEntry =
  | {
      status: "tracked";
      trackId: number;
      observationCount: number;
      windowCoverage: number;
      meanDetectorScore: number;
      meanWristDistance: number | null;
      candidateTracks: number;
      detector: string;
      inferenceMsPerFrame: number;
      confidenceModel: string;
      association?: PaddleAssociationSummary;
    }
  | {
      status: "untracked";
      reason: string;
      candidateTracks: number;
      detector: string;
      inferenceMsPerFrame: number;
      association?: PaddleAssociationSummary | null;
    }
  | { status: "unavailable"; reason: string };

export interface PlayerStageReport {
  targetTrackId: number;
  policy: string;
  aliasTrackIds?: number[];
  selectionConfidence: number;
  targetCoverage: number;
  lossPeriods: number;
  candidateTracks: Array<{ trackId: number; coverage: number; meanTorsoSpan: number }>;
  risks: string[];
}

export type BallStageReportEntry =
  | {
      status: "tracked";
      trackId: number;
      observationCount: number;
      windowOverlapMs: number;
      medianSpeed: number;
      minPaddleDistance: number | null;
      gatedTracks: number;
      ablation: BallAblation;
      confidenceModel: string;
      timeline?: { states: string[]; reacquisition: string; bridgePointCount: number };
    }
  | { status: "untracked"; reason: string; gatedTracks: number; ablation: BallAblation }
  | { status: "unavailable"; reason: string };

export interface LabRunReport {
  video: string;
  outDir: string;
  stroke: string;
  poseSequenceSha256: string;
  quality: CaptureQualityReport | null;
  window: OfflineStrokeWindow | null;
  contact: ContactEstimate | null;
  ballDiagnostics: BallCandidateDiagnostics | null;
  ballModality: "measured" | "unavailable" | "not_run";
  ballStage: BallStageReportEntry | null;
  paddle: PaddleReportEntry | null;
  player?: PlayerStageReport | null;
  detectSpan?: {
    mode: "full-window" | "event-gated";
    startMs: number;
    endMs: number;
    windowMs: number;
    spanMs: number;
    prePassEvents: number;
  } | null;
  /** Present only when --two-pass ran (adaptive detector schedule). */
  paddleSchedule?: import("./paddleSchedule.js").TwoPassSchedule | null;
  scene?: {
    detector: string;
    cutCount: number;
    cuts: number[];
    analysisSegment: { startMs: number; endMs: number };
    risks: string[];
  } | null;
  events?: {
    version: string;
    source: "paddle" | "wrist" | "paddle_fallback" | "none";
    proposals: import("./strokeEvents.js").StrokeEventProposal[];
  } | null;
  targetEvent?: import("./strokeEvents.js").TargetEventSelection | null;
  contactScanNote?: string | null;
  temporalPhases?: import("./phaseTemporal.js").TemporalPhaseOutcome | null;
  temporalPhasesV2?: import("./phaseTemporal.js").TemporalPhaseOutcome | null;
  strokePrediction: StrokePrediction | null | undefined;
  kineticEvents: KineticEvent[] | null;
  timings: Record<string, number>;
  outcome:
    | { kind: "not_run"; detail: string }
    | { kind: "rejected"; detail: string }
    | { kind: "not_analyzable"; detail: string }
    | { kind: "abstained"; detail: string }
    | { kind: "analyzed"; record: AnalysisRecord };
}

const line = "─".repeat(64);

export function renderReport(report: LabRunReport): string {
  const rows: string[] = [line, `swing-lab · ${report.video}`, line];
  rows.push(`pose sequence sha256  ${report.poseSequenceSha256.slice(0, 16)}…`);

  if (report.quality) {
    const q = report.quality;
    rows.push(
      `capture quality       ${q.analyzable ? "ANALYZABLE" : `REJECTED (${q.reasons.join(", ")})`}`,
      `  frames ${q.stats.frameCount} · ${q.stats.effectiveFps.toFixed(1)} fps · ` +
        `pose conf ${q.stats.meanFrameConfidence.toFixed(2)} · ` +
        `full-body ${(q.stats.fullBodyFrameRate * 100).toFixed(0)}% · ` +
        `torso ${q.stats.medianTorsoLengthNorm.toFixed(3)}`,
      `  not evaluated: ${q.notEvaluated.join(", ")}`,
    );
  }
  if (report.window) {
    rows.push(
      `stroke window         ${report.window.startMs}–${report.window.endMs}ms ` +
        `(peak ${report.window.peakMotionMs}ms, conf ${report.window.confidence.toFixed(2)})`,
    );
  }
  if (report.player) {
    const player = report.player;
    rows.push(
      `player identity       TARGET P${player.targetTrackId} (${player.policy}, conf ${player.selectionConfidence.toFixed(2)}) · ` +
        `coverage ${(player.targetCoverage * 100).toFixed(0)}% · loss periods ${player.lossPeriods} · ` +
        `aliases [${(player.aliasTrackIds ?? []).map((id) => `P${id}`).join(" ") || "none"}] · ` +
        `candidates [${player.candidateTracks
          .map((track) => `P${track.trackId}:${(track.coverage * 100).toFixed(0)}%`)
          .join(" ")}]`,
    );
    if (player.risks.length > 0) rows.push(`  identity risks: ${player.risks.join("; ")}`);
  }
  if (report.paddle) {
    const paddle = report.paddle;
    if (paddle.status === "tracked") {
      rows.push(
        `paddle track          TRACKED · id ${paddle.trackId} · ` +
          `${paddle.observationCount} obs · window coverage ${(paddle.windowCoverage * 100).toFixed(0)}% · ` +
          `det score ${paddle.meanDetectorScore.toFixed(2)} · ` +
          `wrist dist ${paddle.meanWristDistance?.toFixed(3) ?? "n/a"}`,
        `  detector ${paddle.detector} · ${paddle.inferenceMsPerFrame}ms/frame · ` +
          `confidence: ${paddle.confidenceModel}`,
      );
      if (paddle.association) {
        const association = paddle.association;
        rows.push(
          `  association: target-wrist ${association.meanTargetWristDistance?.toFixed(3) ?? "n/a"} vs ` +
            `other-players ${association.meanOtherWristDistance?.toFixed(3) ?? "n/a"} · ` +
            `rejected other-player tracks ${association.rejectedOtherPlayerTracks} · ` +
            `margin ${association.selectionMargin?.toFixed(2) ?? "n/a"} · switches ${association.switchEvents}`,
        );
        if (association.risks.length > 0) {
          rows.push(`  association risks: ${association.risks.join("; ")}`);
        }
      }
    } else if (paddle.status === "untracked") {
      rows.push(
        `paddle track          UNTRACKED — ${paddle.reason} ` +
          `(${paddle.candidateTracks} candidate tracks; detector ${paddle.detector})`,
      );
    } else {
      rows.push(`paddle track          UNAVAILABLE — ${paddle.reason}`);
    }
  }
  if (report.ballStage) {
    const stage = report.ballStage;
    if (stage.status === "tracked") {
      rows.push(
        `ball track            TRACKED · id ${stage.trackId} · ${stage.observationCount} obs · ` +
          `window overlap ${stage.windowOverlapMs}ms · median speed ${stage.medianSpeed.toFixed(2)} u/s · ` +
          `min paddle dist ${stage.minPaddleDistance?.toFixed(3) ?? "n/a"}`,
        `  confidence: ${stage.confidenceModel}`,
      );
    } else if (stage.status === "untracked") {
      rows.push(`ball track            UNTRACKED — ${stage.reason} (${stage.gatedTracks} gated tracks)`);
    } else {
      rows.push(`ball track            UNAVAILABLE — ${stage.reason}`);
    }
    if (stage.status === "tracked" && stage.timeline) {
      rows.push(
        `  ball states: ${stage.timeline.states.join(" → ")}`,
        `  reacquisition: ${stage.timeline.reacquisition}` +
          (stage.timeline.bridgePointCount > 0
            ? ` · bridge ${stage.timeline.bridgePointCount} PREDICTED points (not observations)`
            : ""),
      );
    }
    if (stage.status !== "unavailable") {
      const ablation = stage.ablation;
      rows.push(
        `  temporal ablation: raw ${ablation.stageA_rawCandidatesPerSec.toFixed(0)}/s → ` +
          `associated ${ablation.stageB_tracks} tracks (${ablation.stageB_trackedObsPerSec.toFixed(0)} obs/s) → ` +
          `physics+context ${ablation.stageC_tracks} tracks (${ablation.stageC_trackedObsPerSec.toFixed(0)} obs/s)`,
      );
    }
  }
  if (report.contact) {
    const contact = report.contact;
    if (contact.status === "estimated") {
      const confirmations = [
        contact.ballConfirmed ? "ball-confirmed" : null,
        contact.paddleConfirmed ? "paddle-confirmed" : null,
      ].filter((value): value is string => value !== null);
      rows.push(
        `contact estimate      ${contact.estimatedContactMs}ms ` +
          `(conf ${contact.confidence.toFixed(2)}, ` +
          `${confirmations.length > 0 ? confirmations.join(" + ") : "motion-only"}) via ` +
          contact.supportingEvidence
            .map((signal) => `${signal.signal}@${signal.timestampMs}ms`)
            .join(" + "),
      );
      if (contact.limitingFactors.length > 0) {
        rows.push(`  contact limits: ${contact.limitingFactors.join("; ")}`);
      }
    } else {
      rows.push(`contact estimate      ABSTAINED — ${contact.reason}`);
    }
  }
  if (report.ballDiagnostics) {
    const b = report.ballDiagnostics;
    rows.push(
      `ball candidates       ${report.ballModality.toUpperCase()} · ` +
        `${b.trajectoryCount} trajectories (${b.trajectoriesPerSecond.toFixed(1)}/s), ` +
        `${b.windowCandidates} in window` +
        (b.chosenId
          ? `, best coverage ${(b.chosenCoverage * 100).toFixed(0)}% / ${b.chosenPoints} pts`
          : ""),
    );
  }

  rows.push(line);
  switch (report.outcome.kind) {
    case "analyzed": {
      const record = report.outcome.record;
      const result = record.result;
      if (result && result.resultKind === "scored") {
        rows.push(`VERDICT: SCORED       ${result.overallScore}/10 (${report.stroke})`);
        rows.push(
          `  confidence ${result.analysisConfidence.toFixed(2)} · ` +
            `phases ${result.phases.length} · faults ${record.faults.length}`,
        );
        for (const checkpoint of result.checkpoints.filter((entry) => entry.applicable)) {
          rows.push(
            `  ${checkpoint.key.padEnd(22)} ${String(checkpoint.score ?? "—").padStart(3)} ` +
              `${checkpoint.band}${checkpoint.confidence < 0.5 ? " (low conf)" : ""}`,
          );
        }
        if (result.priorityFix) {
          rows.push(
            `  priority fix: ${result.priorityFix.checkpoint} (${result.priorityFix.reasonKey})`,
          );
        }
      } else if (result) {
        rows.push(`VERDICT: LOW CONFIDENCE — not scored`);
        if (result.guidance) rows.push(`  guidance: ${result.guidance}`);
      }
      if (result) {
        rows.push(
          `  phases: ${result.phases
            .map((span) => `${span.key} ${span.startMs}-${span.endMs}ms`)
            .join(" · ")}`,
        );
      }
      rows.push(
        `  limiting factors: ${record.uncertainty.limitingFactors.join("; ") || "none reported"}`,
      );
      rows.push(
        `  modalities: pose=${record.modalities.pose} paddle=${record.modalities.paddle} ` +
          `ball=${record.modalities.ball} court=${record.modalities.court}`,
      );
      break;
    }
    case "abstained":
      rows.push(`VERDICT: ABSTAINED — ${report.outcome.detail}`);
      break;
    case "not_analyzable":
      rows.push(`VERDICT: NOT ANALYZABLE — ${report.outcome.detail}`);
      break;
    case "rejected":
      rows.push(`VERDICT: REJECTED — ${report.outcome.detail}`);
      break;
    case "not_run":
      rows.push(`VERDICT: NOT RUN — ${report.outcome.detail}`);
      break;
  }
  if (report.detectSpan) {
    const span = report.detectSpan;
    rows.push(
      `detector span         ${span.mode} · ${span.spanMs}ms of ${span.windowMs}ms window ` +
        `(${Math.round((span.spanMs / Math.max(1, span.windowMs)) * 100)}%) · pre-pass events ${span.prePassEvents}`,
    );
    if (report.paddleSchedule) {
      const schedule = report.paddleSchedule;
      rows.push(
        `detector schedule     two-pass · sparse stride ${schedule.sparse.stride} (${schedule.planned.sparseFrames} frames) + ` +
          `${schedule.denseRegions.length} dense region(s) (+${schedule.planned.denseOnlyFrames} frames) · ` +
          `${schedule.planned.totalFrames}/${schedule.planned.fullScanFrames} of full scan`,
      );
    }
  }
  if (report.scene) {
    const scene = report.scene;
    rows.push(
      `scene validity        ${scene.cutCount === 0 ? "SINGLE SHOT" : `${scene.cutCount} CUT(S)`} [${scene.detector}] · ` +
        `analysis shot ${Math.round(scene.analysisSegment.startMs)}–${Math.round(scene.analysisSegment.endMs)}ms`,
    );
    for (const risk of scene.risks) rows.push(`  ${risk}`);
  }
  if (report.events) {
    const events = report.events;
    rows.push(
      `stroke events (${events.source}): ` +
        (events.proposals.length === 0
          ? "none proposed"
          : events.proposals
              .map(
                (event) =>
                  `${event.eventId}[${Math.round(event.startMs)}–${Math.round(event.endMs)} peak ${Math.round(event.peakMs)} prom ${event.prominence.toFixed(1)}]`,
              )
              .join(" ")),
    );
    if (report.targetEvent) {
      const target = report.targetEvent;
      rows.push(
        target.status === "selected"
          ? `  TARGET EVENT: ${target.event.eventId} (via ${target.via}, conf ${target.event.confidence.toFixed(2)})`
          : target.status === "ambiguous"
            ? `  TARGET EVENT: AMBIGUOUS — ${target.reason} [${target.leaders.join(", ")}]`
            : `  TARGET EVENT: NONE — ${target.reason}`,
      );
    }
  }
  if (report.contactScanNote) {
    rows.push(`  contact scan: ${report.contactScanNote}`)
  }
  if (report.temporalPhasesV2) {
    const phases = report.temporalPhasesV2;
    rows.push(
      phases.status === "segmented"
        ? `phases v2 (event)     [${phases.boundaries.source}, ${phases.boundaries.anchor}, conf ${phases.boundaries.confidence.toFixed(2)}] ` +
            `prep ${phases.boundaries.preparationStartMs ?? "—"} · accel ${Math.round(phases.boundaries.accelerationStartMs)} · ` +
            `contact ${Number.isFinite(phases.boundaries.contactMs) ? Math.round(phases.boundaries.contactMs) : "— (anchor-free)"} · followEnd ${Math.round(phases.boundaries.followThroughEndMs)} · ` +
            `recoveryEnd ${phases.boundaries.recoveryEndMs !== null ? Math.round(phases.boundaries.recoveryEndMs) : "—"}`
        : `phases v2 (event)     ABSTAINED — ${phases.reason}`,
    );
  }
  if (report.temporalPhases) {
    const phases = report.temporalPhases;
    if (phases.status === "segmented") {
      const boundaries = phases.boundaries;
      rows.push(
        `temporal phases       [${boundaries.source}, ${boundaries.anchor}, conf ${boundaries.confidence.toFixed(2)}] ` +
          `prep ${boundaries.preparationStartMs ?? "—"} · accel ${Math.round(boundaries.accelerationStartMs)} · ` +
          `contact ${Math.round(boundaries.contactMs)} · followEnd ${Math.round(boundaries.followThroughEndMs)} · ` +
          `recoveryEnd ${boundaries.recoveryEndMs !== null ? Math.round(boundaries.recoveryEndMs) : "—"}`,
      );
    } else {
      rows.push(`temporal phases       ABSTAINED — ${phases.reason}`);
    }
  }
  if (report.strokePrediction) {
    const prediction = report.strokePrediction;
    rows.push(
      `stroke prediction     ${prediction.label} · conf ${prediction.confidence.toFixed(2)} · ` +
        `depth ${prediction.taxonomyDepth}/3 · declared ${report.stroke} (kept separate)`,
      `  evidence: ${prediction.evidence.join("; ")}`,
    );
    if (prediction.limitingFactors.length > 0) {
      rows.push(`  stroke limits: ${prediction.limitingFactors.join("; ")}`);
    }
  }
  if (report.kineticEvents && report.kineticEvents.length > 0) {
    rows.push(
      `kinetic sequence (EXPERIMENTAL): ` +
        report.kineticEvents
          .map(
            (event) =>
              `${event.event.replace(/_/g, " ")}@${event.tRelContactMs !== null ? `${event.tRelContactMs >= 0 ? "+" : ""}${event.tRelContactMs}ms` : `${event.tMs}ms`}`,
          )
          .join(" → "),
    );
  }
  const timingEntries = Object.entries(report.timings);
  if (timingEntries.length > 0) {
    rows.push(
      `timings: ${timingEntries.map(([stage, ms]) => `${stage}=${ms}ms`).join(" · ")}`,
    );
  }
  rows.push(line, `artifacts: ${report.outDir}`, line);
  return rows.join("\n");
}
