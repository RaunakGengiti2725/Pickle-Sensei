import type { Result } from "@pickle/shared-types";
import { fail, failure, ok } from "@pickle/shared-types";
import { toLegacyPoseFrames, type BallObservation, type PoseSequence } from "@pickle/swing-domain";
import { consecutiveSpeedSeries, median, movingAverage } from "./kinematics.js";

/**
 * Offline stroke-window detection for replayed videos, which have no
 * capture-time trigger. Same signal family as the native temporal trigger:
 * the swinging wrist's speed profile. Deterministic; abstains when no
 * distinct stroke motion exists.
 */

export const OFFLINE_TRIGGER_VERSION = "offline-trigger-1";

export interface OfflineStrokeWindow {
  startMs: number;
  endMs: number;
  peakMotionMs: number;
  confidence: number;
}

export function detectOfflineStrokeWindow(sequence: PoseSequence): Result<OfflineStrokeWindow> {
  const frames = toLegacyPoseFrames(sequence);
  if (frames.length < 12) {
    return fail(
      failure(
        "low_confidence",
        "offline_trigger.too_few_frames",
        `Only ${frames.length} pose frames; at least 12 are required.`,
      ),
    );
  }
  const aspect = sequence.video.height > 0 ? sequence.video.width / sequence.video.height : 1;
  // The STRIKING wrist is the one with the most PROMINENT peak, not the most
  // total motion — an off-hand fidgeting (or holding a spare ball) can
  // out-sum a compact volley on the hitting side.
  const candidates = (["right_wrist", "left_wrist"] as const)
    .map((name) => {
      const series = consecutiveSpeedSeries(frames, name, aspect);
      if (series.length < 8) return null;
      const smoothed = movingAverage(
        series.map((sample) => sample.value),
        5,
      );
      let peakIndex = 0;
      for (let index = 1; index < smoothed.length; index += 1) {
        if (smoothed[index]! > smoothed[peakIndex]!) peakIndex = index;
      }
      const baseline = median(smoothed);
      return {
        series,
        smoothed,
        peakIndex,
        prominence: smoothed[peakIndex]! / Math.max(1e-6, baseline),
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((a, b) => b.prominence - a.prominence);
  if (candidates.length === 0) {
    return fail(
      failure(
        "low_confidence",
        "offline_trigger.wrist_not_tracked",
        "Neither wrist was measured on enough frames to find a stroke.",
      ),
    );
  }
  const chosenCandidate = candidates[0]!;
  const chosen = chosenCandidate.series;
  const smoothed = chosenCandidate.smoothed;
  const peakIndex = chosenCandidate.peakIndex;
  const peakValue = smoothed[peakIndex]!;
  const baseline = median(smoothed);
  if (peakValue < Math.max(baseline * 2.5, 1e-6)) {
    return fail(
      failure(
        "low_confidence",
        "offline_trigger.no_distinct_stroke",
        "Wrist motion has no distinct stroke peak; the video looks like idle movement.",
      ),
    );
  }

  // Refine the event time on the raw series near the smoothed peak.
  let refined = peakIndex;
  let best = -1;
  for (
    let index = Math.max(0, peakIndex - 3);
    index <= Math.min(chosen.length - 1, peakIndex + 3);
    index += 1
  ) {
    if (chosen[index]!.value > best) {
      best = chosen[index]!.value;
      refined = index;
    }
  }
  const peakMs = chosen[refined]!.timestampMs;

  // Window: walk to sustained quiet (below 12% of peak) on both sides, then
  // pad so preparation and recovery survive for the phase segmenter.
  const quietThreshold = peakValue * 0.12;
  let startIndex = refined;
  while (startIndex > 0 && smoothed[startIndex - 1]! >= quietThreshold) startIndex -= 1;
  let endIndex = refined;
  while (endIndex < smoothed.length - 1 && smoothed[endIndex + 1]! >= quietThreshold) {
    endIndex += 1;
  }
  const firstMs = frames[0]!.timestampMs;
  const lastMs = frames[frames.length - 1]!.timestampMs;
  const startMs = Math.max(firstMs, chosen[startIndex]!.timestampMs - 900);
  const endMs = Math.min(lastMs, chosen[endIndex]!.timestampMs + 700);

  const prominence = Math.min(1, peakValue / (baseline * 6 + 1e-9));
  const coverage = Math.min(1, chosen.length / frames.length);
  return ok({
    startMs,
    endMs,
    peakMotionMs: peakMs,
    confidence: Math.max(0.05, Math.min(0.95, 0.5 * prominence + 0.5 * coverage)),
  });
}

/**
 * Evidence-based contact estimation (v4: calibrated, target-gated,
 * reliability-weighted temporal fusion).
 *
 * Signals, each independently measured and reported:
 * - paddle speed peaks (when a measured paddle track exists)
 * - wrist speed peaks (always available from pose)
 * - ball direction changes, GATED by distance to the target's paddle/wrist
 *   (an opponent-side turn must not create target contact)
 * - ball–paddle / ball–wrist proximity minimum (when a ball track exists)
 *
 * v4 replaces the v3 flat weighted mean + 250ms disagreement veto with a
 * temporal kernel density: every signal occurrence contributes a Gaussian
 * kernel centred at (timestamp − its expected lag prior) whose height is its
 * reliability-weighted mass and whose width is its temporal uncertainty. The
 * estimate is the density argmax; the full (downsampled) distribution ships
 * in the result for calibration work. Abstention happens only when total
 * evidence mass is insufficient or the density is multi-modal with
 * comparable, well-separated peaks — a weak outlier can no longer veto
 * strong agreeing evidence.
 *
 * Priors (offsets, widths, reliabilities, gates) are generic constants tuned
 * ONLY on the three dev gold cases (wm-volley-02, afn-sasebo-rally1/2);
 * offset priors are currently 0 because the measured dev lead/lag of motion
 * peaks vs gold contact has inconsistent sign (volley paddle peak +10ms,
 * rally2 whip −383ms) — the uncertainty lives in the kernel widths instead.
 */

export const CONTACT_ESTIMATOR_VERSION = "contact-evidence-4.3";

/** Coarse stroke family used to pick temporal priors. Derived from the
 * declared stroke or a predicted family; "unknown" is always safe. */
export type StrokeFamily = "volley" | "dink" | "drive" | "serve" | "overhead" | "unknown";

export interface ContactEvidenceSignal {
  signal:
    | "paddle_speed_peak"
    | "wrist_speed_peak"
    | "ball_direction_change"
    | "ball_paddle_proximity"
    | "ball_wrist_proximity";
  timestampMs: number;
  weight: number;
  detail: string;
}

/** One point of the fused temporal evidence density (peak-normalized). */
export interface ContactDistributionPoint {
  tMs: number;
  density: number;
}

/** A local maximum of the fused density, reported when modes compete. */
export interface ContactMode {
  tMs: number;
  /** Density of this mode relative to the top mode (top mode = 1). */
  share: number;
}

export type ContactEstimate =
  | {
      status: "estimated";
      estimatedContactMs: number;
      confidence: number;
      /** True only when ball evidence exists AND the ball was still observed
       * near the estimated moment. */
      ballConfirmed: boolean;
      /** Same, for the measured paddle track. */
      paddleConfirmed: boolean;
      /** Explicit reasons the estimate is weaker than it could be. */
      limitingFactors: string[];
      supportingEvidence: ContactEvidenceSignal[];
      /** Fused evidence density over time (downsampled, peak = 1). */
      contactDistribution?: ContactDistributionPoint[];
      /** Density modes (top first) — the runner-ups the estimate beat. */
      modes?: ContactMode[];
      /** Per-kernel fusion internals (only when includeFusionKernels). */
      fusionKernels?: Array<{
        signal: ContactEvidenceSignal["signal"];
        tMs: number;
        mass: number;
        sigmaMs: number;
        note: string;
      }>;
    }
  | {
      status: "abstained";
      reason: string;
      /** Present when the abstention has structured causes (e.g. modes). */
      limitingFactors?: string[];
      /** Competing modes, top first, when the density was multi-modal. */
      modes?: ContactMode[];
      contactDistribution?: ContactDistributionPoint[];
      /** Per-kernel fusion internals (only when includeFusionKernels). */
      fusionKernels?: Array<{
        signal: ContactEvidenceSignal["signal"];
        tMs: number;
        mass: number;
        sigmaMs: number;
        note: string;
      }>;
    };

/**
 * FUSION PRIORS — dev-tuned generic constants (n=3 gold contacts; see module
 * comment). Reliability expresses how much a signal family is trusted;
 * sigma its temporal uncertainty; offset its expected lag (signal time −
 * contact time), currently 0 everywhere.
 */
const FUSION = {
  reliability: {
    ball_direction_change: 1.0,
    ball_paddle_proximity: 0.85,
    paddle_speed_peak: 0.6,
    wrist_speed_peak: 0.5,
    ball_wrist_proximity: 0.45,
  },
  sigmaMs: {
    ball_direction_change: 60,
    ball_paddle_proximity: 70,
    paddle_speed_peak: 100,
    wrist_speed_peak: 120,
    ball_wrist_proximity: 90,
  },
  offsetMs: {
    ball_direction_change: 0,
    ball_paddle_proximity: 0,
    paddle_speed_peak: 0,
    wrist_speed_peak: 0,
    ball_wrist_proximity: 0,
  },
  /** Compact strokes (volley/dink): the wrist peak decouples from contact
   * (dev-measured 0…−151ms; held-out folklore says it can lag too), so the
   * wrist kernel widens instead of shifting. */
  compactWristSigmaMs: 150,
  /** An extremum attained at the first/last sample of a truncated series is
   * right/left-censored — the true extremum may lie beyond the data. */
  boundaryCensorFactor: 0.3,
  boundarySigmaFactor: 1.5,
  /** A ball sample adjacent to a temporal gap larger than this (occlusion)
   * is censored the same way as a track edge: a turn or proximity minimum
   * measured across the gap actually happened somewhere INSIDE it, so its
   * time cannot anchor a contact at the sample. */
  gapCensorMs: 150,
  /** A paddle is held in the hand: a paddle center farther than this from
   * every measured target wrist at that moment cannot be the target's
   * paddle (an identity-switched track, e.g. the opponent's paddle). Ramp,
   * in torso spans; no wrist measured near the moment → no discount. */
  paddleReachFullTorso: 1.2,
  paddleReachRejectTorso: 2.0,
  /** Paddle and wrist are rigidly coupled: a speed peak in one modality with
   * the other modality measured-quiet at that moment is discounted. */
  corroborationBandMs: 60,
  corroborationFullRatio: 1.5,
  corroborationFloor: 0.25,
  /** Local-maxima extraction. */
  maximaMergeMs: 70,
  maximaFloorFraction: 0.15,
  maximaCap: 6,
  minPaddlePeakSpeed: 0.5, // u/s — below this a paddle "peak" is idle drift
  /** A wrist "peak" below this (torso spans per second) is idle drift /
   * pose jitter, not a stroke (dev-measured real stroke peaks: 5–8 torso/s). */
  minWristPeakTorsoPerSec: 0.5,
  /** A body/paddle speed above this (torso spans per second) is not human
   * motion but a tracking glitch (landmark jump / identity swap): the
   * measurement is invalid and the peak is rejected outright. Dev-measured
   * real peaks: 5–8 torso/s; the rally2 glitch read 38 torso/s. */
  maxMotionTorsoPerSec: 25,
  /** Target gating for ball evidence, distances in torso spans. */
  paddleGateFullTorso: 0.55,
  paddleGateRejectTorso: 1.2,
  wristGateFullTorso: 0.9,
  wristGateRejectTorso: 1.8,
  /** Extended strokes (drive/serve/overhead) contact the ball at the far end
   * of an extended arm + paddle — roughly one extra torso span from the
   * wrist than compact strokes (arm ~0.6 torso + paddle ~0.8 torso reach vs
   * the compact block where the paddle sits near the body). The wrist gate
   * is a PROXY gate that only applies when no paddle track exists at the
   * moment; for extended families the compact-tuned radii reject the ball at
   * a legitimate contact point (Wave-E measured: gold drive contact ball sat
   * 1.70 torso from the wrist — past the 0.9 full-trust radius). Compact and
   * unknown families keep the tighter radii. */
  extendedWristGateFullTorso: 1.8,
  extendedWristGateRejectTorso: 2.6,
  extendedWristProximityFullTorso: 2.2,
  ungatedTurnFactor: 0.5, // no target reference near the turn → half weight
  /** Ball-track observation confidence below which ball evidence is ramped
   * down. The tracker's heuristic confidence is ≥0.35 by construction
   * (base 0.35 + non-negative terms), so anything lower marks degraded or
   * foreign-provenance detections that must not drive a contact marker. */
  ballObservationConfidenceFull: 0.35,
  /** Ball-turn shape quality. */
  minTurnAngleDeg: 35,
  turnSpeedRatioFloor: 0.35,
  /** The ball modality (turns + proximity are correlated observations of the
   * same object) may not carry more total mass than its best signal. */
  ballFamilyMassCap: 1.0,
  /** A playable ball FLIES: ball evidence around a moment where the track
   * never exceeds a walking-pace drift is jitter/hover, not a hit
   * (dev-measured: volley inbound ≈7.6 torso/s; rally1 jitter cluster
   * ≈2–3 torso/s). Ramp, in torso spans per second. */
  ballFlightMinTorsoPerSec: 2,
  ballFlightFullTorsoPerSec: 6,
  ballFlightBandMs: 120,
  ballFlightUnknownFactor: 0.5,
  /** Target contact requires target MOTION: ball evidence at a moment where
   * every measured motion series is quiet (relative to its own window max)
   * is discounted — spatial nearness without action is not a hit. */
  motionSupportBandMs: 120,
  motionSupportFullFraction: 0.35,
  /** Proximity quality ramp (torso spans). */
  proximityFullTorso: 0.9,
  proximitySpanTorso: 0.65,
  wristProximityFullTorso: 1.5,
  wristProximitySpanTorso: 1.0,
  /** Fallback torso span (image-height units) when pose can't measure one. */
  defaultTorsoSpan: 0.18,
  /** Fusion grid + decision thresholds. */
  gridStepMs: 5,
  minTotalMass: 0.15,
  modeComparableRatio: 0.45,
  modeSeparationMs: 300,
  modeMergeMs: 120,
  /** Comparable near modes (≥ this ratio, within separation) resolve to the
   * LATER mode: paddle whip precedes contact (dev-measured). */
  lateModeRatio: 0.8,
  presenceMs: 100,
  /** Ball evidence must retain this much post-discount mass to CONFIRM the
   * estimate — kernels discounted to dust are not corroboration. */
  ballConfirmMinMass: 0.2,
  /** A fused estimate this far from the scanned movement's own peak motion
   * describes a DIFFERENT moment than the stroke under analysis (only wide
   * fallback scans can trip this; event-scoped scans are ±450ms by
   * construction). */
  maxPeakDivergenceMs: 700,
  distributionPoints: 64,
} as const;

interface KernelContribution {
  signal: ContactEvidenceSignal["signal"];
  tMs: number;
  mass: number;
  sigmaMs: number;
  note: string;
  /** Ball kernels only: true when the evidence is spatially tied to a
   * measured target reference (gated turn / proximity minimum). Untethered
   * ball motion alone must never place a target contact marker. */
  tethered?: boolean;
  /** Ball kernels only: the underlying detection's confidence is below the
   * tracker's constructive floor — such evidence may support timing but
   * never CONFIRM an estimate. */
  lowConfidence?: boolean;
  /** Product of the boundary/gap censor factors applied to this kernel's
   * mass (1 when uncensored). Censoring removes an anchor but not the
   * underlying uncertainty: the censored-away mass stays in the confidence
   * denominator, so losing information can never RAISE confidence. */
  censorFactor?: number;
}

export function estimateContact(input: {
  sequence: PoseSequence;
  window: { startMs: number; endMs: number; peakMotionMs: number | null };
  ballObservations: readonly BallObservation[] | null;
  /** Measured paddle center speeds (normalized u/s); null when untracked. */
  paddleSpeeds?: ReadonlyArray<{ timestampMs: number; value: number }> | null;
  /** Measured paddle centers, for ball–paddle proximity evidence. */
  paddleCenters?: ReadonlyArray<{ timestampMs: number; x: number; y: number }> | null;
  /** OPTIONAL (v4): target wrist positions over time (normalized image
   * coords, both wrists welcome) — used to gate ball evidence to the target
   * when the paddle track is missing at that moment. */
  targetWrists?: ReadonlyArray<{ timestampMs: number; x: number; y: number }> | null;
  /** OPTIONAL (v4): coarse stroke family for temporal priors. */
  strokeFamily?: StrokeFamily | null;
  /** OPTIONAL (v4): attach per-kernel fusion internals (calibration/debug). */
  includeFusionKernels?: boolean;
}): ContactEstimate {
  const frames = toLegacyPoseFrames(input.sequence).filter(
    (frame) => frame.timestampMs >= input.window.startMs && frame.timestampMs <= input.window.endMs,
  );
  const aspect =
    input.sequence.video.height > 0 ? input.sequence.video.width / input.sequence.video.height : 1;
  const family: StrokeFamily = input.strokeFamily ?? "unknown";
  const compact = family === "volley" || family === "dink";
  const extended = family === "drive" || family === "serve" || family === "overhead";
  const wristGateFull = extended ? FUSION.extendedWristGateFullTorso : FUSION.wristGateFullTorso;
  const wristGateReject = extended
    ? FUSION.extendedWristGateRejectTorso
    : FUSION.wristGateRejectTorso;
  const wristProximityFull = extended
    ? FUSION.extendedWristProximityFullTorso
    : FUSION.wristProximityFullTorso;
  const measuredTorso = medianTorsoSpan(frames, aspect);
  const torso = measuredTorso ?? FUSION.defaultTorsoSpan;

  const kernels: KernelContribution[] = [];
  /** Gating/rejection decisions, routed into the matching family's detail. */
  const gatingNotes: Array<{ signal: ContactEvidenceSignal["signal"]; note: string }> = [];
  const limitingFactors: string[] = [];

  // A paddle is held in the target's hand: paddle centers beyond arm+paddle
  // reach of every measured target wrist at their moment belong to a
  // different object (identity-switched track — e.g. the opponent's paddle)
  // and must not act as a target reference, proximity anchor, or presence.
  // No wrist measured near the moment → the center is kept (absence of
  // measurement is not counter-evidence).
  const paddleCentersAll = input.paddleCenters ?? null;
  const paddleCenters = paddleCentersAll
    ? paddleCentersAll.filter((center) => {
        const wristDistance = nearestWristDistanceTo(
          center.timestampMs,
          center.x,
          center.y,
          aspect,
          input.targetWrists ?? null,
          frames,
        );
        return wristDistance === null || wristDistance / torso < FUSION.paddleReachRejectTorso;
      })
    : null;
  if (paddleCentersAll && paddleCenters && paddleCenters.length < paddleCentersAll.length) {
    limitingFactors.push("paddle_track_beyond_reach");
    gatingNotes.push({
      signal: "paddle_speed_peak",
      note: `${paddleCentersAll.length - paddleCenters.length}/${paddleCentersAll.length} paddle center(s) beyond ${FUSION.paddleReachRejectTorso} torso of every measured target wrist → not the target's paddle, excluded`,
    });
  }
  const paddleReachAt = (tMs: number): number => {
    if (!paddleCentersAll || paddleCentersAll.length === 0) return 1;
    let nearest: { timestampMs: number; x: number; y: number } | null = null;
    for (const center of paddleCentersAll) {
      if (Math.abs(center.timestampMs - tMs) > 60) continue;
      if (
        nearest === null ||
        Math.abs(center.timestampMs - tMs) < Math.abs(nearest.timestampMs - tMs)
      ) {
        nearest = center;
      }
    }
    if (nearest === null) return 1;
    const wristDistance = nearestWristDistanceTo(
      nearest.timestampMs,
      nearest.x,
      nearest.y,
      aspect,
      input.targetWrists ?? null,
      frames,
    );
    if (wristDistance === null) return 1;
    const torsoDistance = wristDistance / torso;
    return clamp01(
      (FUSION.paddleReachRejectTorso - torsoDistance) /
        (FUSION.paddleReachRejectTorso - FUSION.paddleReachFullTorso),
    );
  };

  // ── Motion family 1: paddle speed peaks ─────────────────────────────────
  const paddle = input.paddleSpeeds
    ?.filter(
      (sample) =>
        sample.timestampMs >= input.window.startMs && sample.timestampMs <= input.window.endMs,
    )
    .sort((a, b) => a.timestampMs - b.timestampMs);
  // Wrist series (dominant wrist by total motion — v3 rule, unchanged).
  const right = consecutiveSpeedSeries(frames, "right_wrist", aspect);
  const leftSeries = consecutiveSpeedSeries(frames, "left_wrist", aspect);
  const wrist =
    sum(right.map((sample) => sample.value)) >= sum(leftSeries.map((sample) => sample.value))
      ? right
      : leftSeries;

  const plausible = (
    peak: { timestampMs: number; value: number },
    signal: "paddle_speed_peak" | "wrist_speed_peak",
  ): boolean => {
    if (peak.value / torso <= FUSION.maxMotionTorsoPerSec) return true;
    gatingNotes.push({
      signal,
      note: `peak ${peak.value.toFixed(2)} u/s @${Math.round(peak.timestampMs)}ms = ${(peak.value / torso).toFixed(0)} torso/s > ${FUSION.maxMotionTorsoPerSec} → tracking glitch, rejected`,
    });
    if (!limitingFactors.includes("implausible_motion_peak_rejected")) {
      limitingFactors.push("implausible_motion_peak_rejected");
    }
    return false;
  };

  if (paddle && paddle.length >= 5) {
    const maxima = localMaxima(
      paddle,
      (peak) => peak.value >= FUSION.minPaddlePeakSpeed && plausible(peak, "paddle_speed_peak"),
    );
    // Linear value shares: stronger peaks carry more of the family's mass;
    // a flat multi-peak profile stays honestly spread.
    const totalValue = sum(maxima.map((peak) => peak.value));
    for (const peak of maxima) {
      const reach = paddleReachAt(peak.timestampMs);
      if (reach <= 0) {
        gatingNotes.push({
          signal: "paddle_speed_peak",
          note: `peak ${peak.value.toFixed(2)} u/s @${Math.round(peak.timestampMs)}ms rejected: paddle center beyond reach of every measured target wrist → not the target's paddle`,
        });
        if (!limitingFactors.includes("paddle_track_beyond_reach")) {
          limitingFactors.push("paddle_track_beyond_reach");
        }
        continue;
      }
      const censor = (peak.boundary ? FUSION.boundaryCensorFactor : 1) * reach;
      const corroboration = corroborationFactor(wrist, peak.timestampMs);
      kernels.push({
        signal: "paddle_speed_peak",
        tMs: peak.timestampMs - FUSION.offsetMs.paddle_speed_peak,
        mass:
          FUSION.reliability.paddle_speed_peak * (peak.value / totalValue) * censor * corroboration,
        sigmaMs:
          FUSION.sigmaMs.paddle_speed_peak * (peak.boundary ? FUSION.boundarySigmaFactor : 1),
        censorFactor: peak.boundary ? FUSION.boundaryCensorFactor : 1,
        note: `${peak.value.toFixed(2)} u/s${peak.boundary ? ", boundary-censored" : ""}${reach < 1 ? `, paddle-reach ×${reach.toFixed(2)}` : ""}${corroboration < 1 ? `, wrist-corroboration ×${corroboration.toFixed(2)}` : ""}`,
      });
    }
  }

  // ── Motion family 2: wrist speed peaks ──────────────────────────────────
  if (wrist.length >= 5) {
    const maxima = localMaxima(
      wrist,
      (peak) =>
        peak.value / torso >= FUSION.minWristPeakTorsoPerSec && plausible(peak, "wrist_speed_peak"),
    );
    const totalValue = sum(maxima.map((peak) => peak.value));
    const sigma = compact ? FUSION.compactWristSigmaMs : FUSION.sigmaMs.wrist_speed_peak;
    for (const peak of maxima) {
      const censor = peak.boundary ? FUSION.boundaryCensorFactor : 1;
      const corroboration =
        paddle && paddle.length >= 5 ? corroborationFactor(paddle, peak.timestampMs) : 1;
      kernels.push({
        signal: "wrist_speed_peak",
        tMs: peak.timestampMs - FUSION.offsetMs.wrist_speed_peak,
        mass:
          FUSION.reliability.wrist_speed_peak * (peak.value / totalValue) * censor * corroboration,
        sigmaMs: sigma * (peak.boundary ? FUSION.boundarySigmaFactor : 1),
        censorFactor: censor,
        note: `${peak.value.toFixed(2)} u/s${peak.boundary ? ", boundary-censored" : ""}${corroboration < 1 ? `, paddle-corroboration ×${corroboration.toFixed(2)}` : ""}`,
      });
    }
  }

  // ── Ball families: turns + proximity, target-gated ──────────────────────
  const ball = input.ballObservations
    ?.filter(
      (observation) =>
        observation.timestampMs >= input.window.startMs - 250 &&
        observation.timestampMs <= input.window.endMs + 250,
    )
    .sort((a, b) => a.timestampMs - b.timestampMs);
  const ballKernels: KernelContribution[] = [];
  if (ball && ball.length >= 4) {
    // All direction changes, each gated by distance to the target's
    // paddle/wrist AT that moment (torso-normalized, aspect-corrected).
    const turns = directionChanges(ball);
    const gated: Array<{
      turn: (typeof turns)[number];
      quality: number;
      gapCensored: boolean;
      note: string;
      tethered: boolean;
    }> = [];
    let rejectedTurns = 0;
    for (const turn of turns) {
      const reference = nearestTargetReference(
        turn.timestampMs,
        turn.x,
        turn.y,
        aspect,
        paddleCenters,
        input.targetWrists ?? null,
        frames,
      );
      let gate: number;
      let gateNote: string;
      if (reference === null) {
        gate = FUSION.ungatedTurnFactor;
        gateNote = "ungated (no target reference near turn)";
      } else {
        const torsoDistance = reference.distance / torso;
        const [full, reject] =
          reference.source === "paddle"
            ? [FUSION.paddleGateFullTorso, FUSION.paddleGateRejectTorso]
            : [wristGateFull, wristGateReject];
        gate =
          torsoDistance <= full
            ? 1
            : torsoDistance >= reject
              ? 0
              : (reject - torsoDistance) / (reject - full);
        gateNote = `${torsoDistance.toFixed(2)} torso from target ${reference.source}${gate === 0 ? " → REJECTED" : gate < 1 ? ` → ×${gate.toFixed(2)}` : ""}`;
      }
      if (gate <= 0) {
        rejectedTurns += 1;
        gatingNotes.push({
          signal: "ball_direction_change",
          note: `turn@${Math.round(turn.timestampMs)}ms ${turn.angleDeg.toFixed(0)}° rejected: ${gateNote}`,
        });
        continue;
      }
      const angleFactor = Math.min(1, turn.angleDeg / 90);
      const ratioFactor = Math.min(1, Math.max(FUSION.turnSpeedRatioFloor, turn.speedRatio));
      // A turn measured across an occlusion gap happened somewhere INSIDE
      // the gap; its sample time cannot anchor a contact (censored like a
      // track edge).
      const gapCensored = turn.dtInMs > FUSION.gapCensorMs || turn.dtOutMs > FUSION.gapCensorMs;
      const quality =
        angleFactor * ratioFactor * gate * (gapCensored ? FUSION.boundaryCensorFactor : 1);
      gated.push({
        turn,
        quality,
        gapCensored,
        note: `${turn.angleDeg.toFixed(0)}°, speed ratio ${turn.speedRatio.toFixed(2)}, ${gateNote}${gapCensored ? ", across occlusion gap (censored)" : ""}`,
        tethered: reference !== null,
      });
    }
    if (rejectedTurns > 0 && gated.length === 0) {
      limitingFactors.push("ball_turns_rejected_far_from_target");
    }
    const totalQuality = sum(gated.map((entry) => entry.quality));
    for (const entry of gated) {
      ballKernels.push({
        signal: "ball_direction_change",
        tethered: entry.tethered,
        tMs: entry.turn.timestampMs - FUSION.offsetMs.ball_direction_change,
        // q·(q/Σq): a single strong gated turn carries the full reliability;
        // several comparable turns share it (ambiguity is not certainty).
        mass:
          FUSION.reliability.ball_direction_change * entry.quality * (entry.quality / totalQuality),
        sigmaMs:
          FUSION.sigmaMs.ball_direction_change *
          (entry.gapCensored ? FUSION.boundarySigmaFactor : 1),
        censorFactor: entry.gapCensored ? FUSION.boundaryCensorFactor : 1,
        note: entry.note,
      });
    }

    // Proximity minimum: ball–paddle when a paddle track exists, wrist
    // fallback otherwise. Boundary minima are censored (track died there).
    const paddleProximity =
      paddleCenters && paddleCenters.length > 0
        ? closestBallToPoints(ball, paddleCenters, aspect)
        : null;
    if (paddleProximity) {
      const torsoDistance = paddleProximity.distance / torso;
      const quality = clamp01(
        (FUSION.proximityFullTorso - torsoDistance) / FUSION.proximitySpanTorso,
      );
      const boundary = censoredBallSample(ball, paddleProximity.timestampMs);
      if (quality > 0) {
        ballKernels.push({
          signal: "ball_paddle_proximity",
          tethered: true,
          tMs: paddleProximity.timestampMs - FUSION.offsetMs.ball_paddle_proximity,
          mass:
            FUSION.reliability.ball_paddle_proximity *
            quality *
            (boundary ? FUSION.boundaryCensorFactor : 1),
          sigmaMs:
            FUSION.sigmaMs.ball_paddle_proximity * (boundary ? FUSION.boundarySigmaFactor : 1),
          censorFactor: boundary ? FUSION.boundaryCensorFactor : 1,
          note: `min ${torsoDistance.toFixed(2)} torso (${paddleProximity.distance.toFixed(3)} u)${boundary ? ", at track edge/occlusion gap (censored)" : ""}`,
        });
      } else {
        gatingNotes.push({
          signal: "ball_paddle_proximity",
          note: `proximity minimum ${torsoDistance.toFixed(2)} torso from target paddle → rejected`,
        });
        limitingFactors.push("ball_never_near_target_paddle");
      }
    } else {
      const wristProximity = closestBallToWrist(ball, frames, aspect, input.targetWrists ?? null);
      if (wristProximity) {
        const torsoDistance = wristProximity.distance / torso;
        const quality = clamp01(
          (wristProximityFull - torsoDistance) / FUSION.wristProximitySpanTorso,
        );
        const boundary = censoredBallSample(ball, wristProximity.timestampMs);
        if (quality > 0) {
          ballKernels.push({
            signal: "ball_wrist_proximity",
            tethered: true,
            tMs: wristProximity.timestampMs - FUSION.offsetMs.ball_wrist_proximity,
            mass:
              FUSION.reliability.ball_wrist_proximity *
              quality *
              (boundary ? FUSION.boundaryCensorFactor : 1),
            sigmaMs:
              FUSION.sigmaMs.ball_wrist_proximity * (boundary ? FUSION.boundarySigmaFactor : 1),
            censorFactor: boundary ? FUSION.boundaryCensorFactor : 1,
            note: `min ${torsoDistance.toFixed(2)} torso (wrist fallback; no paddle track)${boundary ? ", at track edge/occlusion gap (censored)" : ""}`,
          });
        } else {
          gatingNotes.push({
            signal: "ball_wrist_proximity",
            note: `proximity minimum ${torsoDistance.toFixed(2)} torso from target wrist → rejected`,
          });
          limitingFactors.push("ball_never_near_target");
        }
      }
    }
  }

  // Target contact requires target motion: ball evidence at a moment where
  // every measured motion series is quiet is discounted (time-gating, the
  // temporal complement of the spatial gate above).
  const motionSeries = [wrist, ...(paddle && paddle.length >= 5 ? [paddle] : [])].filter(
    (series) => series.length >= 5,
  );
  for (const kernel of ballKernels) {
    const support = motionSupportAt(kernel.tMs, motionSeries);
    if (support < 1) {
      kernel.mass *= support;
      kernel.note += `, target motion quiet at this moment ×${support.toFixed(2)}`;
    }
    // A playable ball flies; jitter on a hovering/drifting track is not a hit.
    const flight = ballFlightFactor(ball ?? [], kernel.tMs, aspect, torso);
    if (flight.factor < 1) {
      kernel.mass *= flight.factor;
      kernel.note += `, ball at drift speed ${flight.torsoPerSec === null ? "unknown" : flight.torsoPerSec.toFixed(1) + " torso/s"} ×${flight.factor.toFixed(2)}`;
    }
    // Detections the tracker itself barely trusts must not drive a marker.
    const observationConfidence = nearestBallConfidence(ball ?? [], kernel.tMs);
    if (observationConfidence !== null) {
      const confidenceFactor = clamp01(
        observationConfidence / FUSION.ballObservationConfidenceFull,
      );
      if (confidenceFactor < 1) {
        kernel.mass *= confidenceFactor;
        kernel.lowConfidence = true;
        kernel.note += `, ball observation confidence ${observationConfidence.toFixed(2)} ×${confidenceFactor.toFixed(2)}`;
      }
    }
  }
  // The ball modality's sub-signals are correlated observations of the same
  // object; together they may not exceed the modality's full trust.
  const ballMass = sum(ballKernels.map((kernel) => kernel.mass));
  if (ballMass > FUSION.ballFamilyMassCap) {
    const scale = FUSION.ballFamilyMassCap / ballMass;
    for (const kernel of ballKernels) kernel.mass *= scale;
  }
  kernels.push(...ballKernels);

  // Ball motion with no spatial tie to the target and no target motion
  // evidence at all cannot place a TARGET contact marker: an untethered
  // turn could belong to the opponent's hit, a bounce, or a stray object.
  const motionKernelCount = kernels.filter((kernel) => !kernel.signal.startsWith("ball_")).length;
  const tetheredBallCount = kernels.filter(
    (kernel) => kernel.signal.startsWith("ball_") && kernel.tethered === true,
  ).length;
  if (kernels.length > 0 && motionKernelCount === 0 && tetheredBallCount === 0) {
    return {
      status: "abstained",
      reason:
        "All surviving contact evidence is ball motion untethered to the target (no target reference near any turn, and no target motion evidence): cannot attribute a contact to the target.",
      limitingFactors: [...limitingFactors, "ball_evidence_untethered"],
    };
  }

  if (kernels.length === 0) {
    return {
      status: "abstained",
      reason: "No contact evidence: wrist not tracked and no ball track exists.",
      ...(gatingNotes.length > 0 ? { limitingFactors: [...limitingFactors] } : {}),
    };
  }

  const totalMass = sum(kernels.map((kernel) => kernel.mass));
  if (totalMass < FUSION.minTotalMass) {
    return {
      status: "abstained",
      reason: `Contact evidence too weak: reliability-weighted mass ${totalMass.toFixed(2)} < ${FUSION.minTotalMass} (${kernels.length} kernel(s) survived gating).`,
      limitingFactors: [...limitingFactors, "insufficient_evidence_mass"],
    };
  }

  // ── Temporal kernel density over the scan span ──────────────────────────
  const gridStart =
    Math.floor(Math.min(input.window.startMs, ...kernels.map((kernel) => kernel.tMs)) / 10) * 10 -
    50;
  const gridEnd =
    Math.ceil(Math.max(input.window.endMs, ...kernels.map((kernel) => kernel.tMs)) / 10) * 10 + 50;
  const densityAt = (tMs: number): number =>
    sum(
      kernels.map(
        (kernel) => kernel.mass * Math.exp(-((tMs - kernel.tMs) ** 2) / (2 * kernel.sigmaMs ** 2)),
      ),
    );
  const grid: Array<{ tMs: number; density: number }> = [];
  for (let tMs = gridStart; tMs <= gridEnd; tMs += FUSION.gridStepMs) {
    grid.push({ tMs, density: densityAt(tMs) });
  }

  // Local maxima of the density → modes (merged within modeMergeMs).
  const rawModes: Array<{ tMs: number; density: number }> = [];
  for (let index = 1; index < grid.length - 1; index += 1) {
    if (
      grid[index]!.density > grid[index - 1]!.density &&
      grid[index]!.density >= grid[index + 1]!.density
    ) {
      rawModes.push(grid[index]!);
    }
  }
  if (rawModes.length === 0) rawModes.push(grid.reduce((a, b) => (b.density > a.density ? b : a)));
  rawModes.sort((a, b) => b.density - a.density);
  const modes: Array<{ tMs: number; density: number }> = [];
  for (const mode of rawModes) {
    if (modes.every((kept) => Math.abs(kept.tMs - mode.tMs) > FUSION.modeMergeMs)) {
      modes.push(mode);
    }
  }

  const distribution = downsampleDistribution(grid, modes[0]!.density);

  // Multi-modal abstention: comparable, well-separated peaks — no single
  // defensible moment. (Both modes are reported; downstream can inspect.)
  if (modes.length > 1) {
    const top = modes[0]!;
    const runnerUp = modes[1]!;
    if (
      runnerUp.density >= FUSION.modeComparableRatio * top.density &&
      Math.abs(runnerUp.tMs - top.tMs) > FUSION.modeSeparationMs
    ) {
      return {
        status: "abstained",
        reason: `Contact evidence is multi-modal: comparable clusters at ~${Math.round(top.tMs)}ms and ~${Math.round(runnerUp.tMs)}ms (${Math.round((runnerUp.density / top.density) * 100)}% as strong, ${Math.round(Math.abs(runnerUp.tMs - top.tMs))}ms apart); no single moment is defensible.`,
        limitingFactors: [...limitingFactors, "contact_evidence_multimodal"],
        modes: modes.slice(0, 4).map((mode) => ({
          tMs: Math.round(mode.tMs),
          share: round3(mode.density / top.density),
        })),
        contactDistribution: distribution,
        ...(input.includeFusionKernels
          ? {
              fusionKernels: kernels.map((kernel) => ({
                signal: kernel.signal,
                tMs: Math.round(kernel.tMs),
                mass: round3(kernel.mass),
                sigmaMs: Math.round(kernel.sigmaMs),
                note: kernel.note,
              })),
            }
          : {}),
      };
    }
  }

  // Near-comparable modes resolve to the LATER one: contact follows peak
  // acceleration; the paddle whip precedes it (dev-measured prior).
  let chosen = modes[0]!;
  for (const mode of modes.slice(1)) {
    if (
      mode.density >= FUSION.lateModeRatio * modes[0]!.density &&
      Math.abs(mode.tMs - modes[0]!.tMs) <= FUSION.modeSeparationMs &&
      mode.tMs > chosen.tMs
    ) {
      chosen = mode;
    }
  }
  const estimatedContactMs = Math.round(chosen.tMs);

  // Ball-contradiction: contact requires the ball AT the paddle. If the ball
  // was MEASURED near the fused moment but far from every target reference,
  // the observation refutes contact there — the motion cluster is a swing
  // phase (e.g. follow-through whip), not the hit. Thresholds are the same
  // proximity constants that gate positive ball evidence.
  const nearMomentObservations = (ball ?? []).filter(
    (observation) => Math.abs(observation.timestampMs - estimatedContactMs) <= 60,
  );
  if (nearMomentObservations.length > 0) {
    // Benefit of the doubt: the LEAST-contradicting nearby observation
    // decides (ratio of torso-distance to the modality's proximity limit;
    // > 1 = beyond where positive proximity evidence would score at all).
    let bestRatio: number | null = null;
    let bestDetail: string | null = null;
    for (const observation of nearMomentObservations) {
      const reference = nearestTargetReference(
        observation.timestampMs,
        observation.x,
        observation.y,
        aspect,
        paddleCenters,
        input.targetWrists ?? null,
        frames,
      );
      if (reference === null) continue;
      const limit = reference.source === "paddle" ? FUSION.proximityFullTorso : wristProximityFull;
      const ratio = reference.distance / torso / limit;
      if (bestRatio === null || ratio < bestRatio) {
        bestRatio = ratio;
        bestDetail = `${(reference.distance / torso).toFixed(2)} torso from target ${reference.source} at ${Math.round(observation.timestampMs)}ms`;
      }
    }
    if (bestRatio !== null && bestRatio > 1) {
      return {
        status: "abstained",
        reason: `Ball observed away from the target at the fused moment (${bestDetail}, estimate ${estimatedContactMs}ms): the measured ball refutes contact there; the motion cluster is a swing phase, not the hit.`,
        limitingFactors: [...limitingFactors, "ball_observed_away_from_target_at_moment"],
        modes: modes.slice(0, 4).map((mode) => ({
          tMs: Math.round(mode.tMs),
          share: round3(mode.density / modes[0]!.density),
        })),
        contactDistribution: distribution,
      };
    }
  }

  // A fused moment far from the scanned movement's own peak motion means the
  // surviving evidence describes a DIFFERENT moment than the stroke under
  // analysis (measured on dev: rally1's dead-ball drift cluster sat 1.4s
  // before the detected swing). Estimating there would be confidently wrong.
  if (
    input.window.peakMotionMs !== null &&
    Math.abs(estimatedContactMs - input.window.peakMotionMs) > FUSION.maxPeakDivergenceMs
  ) {
    return {
      status: "abstained",
      reason: `Fused contact evidence peaks at ${estimatedContactMs}ms but the scanned movement's peak motion is at ${Math.round(input.window.peakMotionMs)}ms (${Math.round(Math.abs(estimatedContactMs - input.window.peakMotionMs))}ms apart): the strongest tracked evidence belongs to a different moment than the stroke under analysis.`,
      limitingFactors: [...limitingFactors, "contact_far_from_motion_peak"],
      modes: modes.slice(0, 4).map((mode) => ({
        tMs: Math.round(mode.tMs),
        share: round3(mode.density / modes[0]!.density),
      })),
      contactDistribution: distribution,
    };
  }

  // Confirmation demands presence AT the moment, not just any evidence:
  // a modality that produced a signal but was lost around the estimate
  // cannot confirm it — and kernels discounted to dust are not
  // corroboration either (mass floor).
  const ballMassTotal = sum(
    kernels
      .filter(
        (kernel) =>
          kernel.signal.startsWith("ball_") &&
          kernel.tethered === true &&
          kernel.lowConfidence !== true,
      )
      .map((kernel) => kernel.mass),
  );
  const ballSignal = kernels.some((kernel) => kernel.signal.startsWith("ball_"));
  const ballPresent = (ball ?? []).some(
    (observation) => Math.abs(observation.timestampMs - estimatedContactMs) <= FUSION.presenceMs,
  );
  const ballConfirmed = ballSignal && ballPresent && ballMassTotal >= FUSION.ballConfirmMinMass;
  if (!ballSignal) limitingFactors.push("no_ball_evidence");
  else if (!ballPresent) limitingFactors.push("ball_lost_at_contact");
  else if (ballMassTotal < FUSION.ballConfirmMinMass) {
    limitingFactors.push("ball_evidence_weak");
  }

  const paddleSignal = kernels.some((kernel) => kernel.signal === "paddle_speed_peak");
  const paddlePresent = (paddleCenters ?? []).some(
    (center) => Math.abs(center.timestampMs - estimatedContactMs) <= FUSION.presenceMs,
  );
  const paddleConfirmed = paddleSignal && paddlePresent;
  if (!paddleSignal) limitingFactors.push("no_paddle_evidence");
  else if (!paddlePresent) limitingFactors.push("paddle_lost_at_contact");

  // Confidence: how much of the total evidence mass coheres at the estimate,
  // plus modality diversity; unconfirmed modalities cap it (v3 convention).
  // The denominator restores censored-away mass: a censored kernel is lost
  // information, and coherence over the surviving mass alone would let
  // censoring RAISE confidence by silencing dissent.
  const dissentMass = sum(kernels.map((kernel) => kernel.mass / (kernel.censorFactor ?? 1)));
  const coherence = chosen.density / dissentMass;
  const familiesNear = new Set(
    kernels
      .filter((kernel) => Math.abs(kernel.tMs - estimatedContactMs) <= 150)
      .map((kernel) => kernel.signal),
  );
  const ballNear = [...familiesNear].some((signal) => signal.startsWith("ball_"));
  let confidence =
    0.18 +
    0.55 * clamp01(coherence) +
    0.06 * Math.min(3, familiesNear.size) +
    (ballNear ? 0.08 : 0);
  confidence = Math.max(0.05, Math.min(0.95, confidence));
  if (!ballConfirmed) confidence = Math.min(confidence, 0.7);
  if (!ballConfirmed && !paddleConfirmed) confidence = Math.min(confidence, 0.55);

  // One supportingEvidence entry per signal family: the dominant kernel,
  // with every gating/censoring decision recorded in the detail string.
  const supportingEvidence: ContactEvidenceSignal[] = [];
  for (const signalName of [
    "paddle_speed_peak",
    "wrist_speed_peak",
    "ball_direction_change",
    "ball_paddle_proximity",
    "ball_wrist_proximity",
  ] as const) {
    const familyKernels = kernels.filter((kernel) => kernel.signal === signalName);
    if (familyKernels.length === 0) continue;
    const dominant = familyKernels.reduce((a, b) => (b.mass > a.mass ? b : a));
    const others = familyKernels.length - 1;
    supportingEvidence.push({
      signal: signalName,
      timestampMs: dominant.tMs,
      weight: round3(sum(familyKernels.map((kernel) => kernel.mass))),
      detail: `${dominant.note}${others > 0 ? ` (+${others} lesser peak(s))` : ""}`,
    });
  }
  const unroutedNotes: string[] = [];
  for (const { signal: signalName, note } of gatingNotes) {
    const entry = supportingEvidence.find((signal) => signal.signal === signalName);
    if (entry) entry.detail += `; ${note}`;
    else unroutedNotes.push(`${signalName}: ${note}`);
  }
  if (unroutedNotes.length > 0 && supportingEvidence.length > 0) {
    supportingEvidence[0]!.detail += `; gating: ${unroutedNotes.join("; ")}`;
  }

  return {
    status: "estimated",
    estimatedContactMs,
    confidence,
    ballConfirmed,
    paddleConfirmed,
    limitingFactors,
    supportingEvidence,
    contactDistribution: distribution,
    modes: modes.slice(0, 4).map((mode) => ({
      tMs: Math.round(mode.tMs),
      share: round3(mode.density / modes[0]!.density),
    })),
    ...(input.includeFusionKernels
      ? {
          fusionKernels: kernels.map((kernel) => ({
            signal: kernel.signal,
            tMs: Math.round(kernel.tMs),
            mass: round3(kernel.mass),
            sigmaMs: Math.round(kernel.sigmaMs),
            note: kernel.note,
          })),
        }
      : {}),
  };
}

/** Local maxima of a timed series: strictly above the previous sample and at
 * least the next; peaks within `maximaMergeMs` merge (larger wins); a noise
 * floor and a cap keep the kernel set small. First/last-sample extrema are
 * flagged `boundary` (censored — the true extremum may lie beyond). */
function localMaxima(
  series: ReadonlyArray<{ timestampMs: number; value: number }>,
  keep?: (peak: { timestampMs: number; value: number }) => boolean,
): Array<{ timestampMs: number; value: number; boundary: boolean }> {
  if (series.length === 0) return [];
  let candidates: Array<{ timestampMs: number; value: number; boundary: boolean }> = [];
  for (let index = 0; index < series.length; index += 1) {
    const value = series[index]!.value;
    const previous = index > 0 ? series[index - 1]!.value : -Infinity;
    const next = index < series.length - 1 ? series[index + 1]!.value : -Infinity;
    const isBoundary = index === 0 || index === series.length - 1;
    const isMax = isBoundary ? value > Math.max(previous, next) : value > previous && value >= next;
    if (isMax)
      candidates.push({ timestampMs: series[index]!.timestampMs, value, boundary: isBoundary });
  }
  if (keep) candidates = candidates.filter((peak) => keep(peak));
  const maxValue = Math.max(...candidates.map((peak) => peak.value), 0);
  const filtered = candidates.filter((peak) => peak.value >= maxValue * FUSION.maximaFloorFraction);
  filtered.sort((a, b) => b.value - a.value);
  const merged: typeof filtered = [];
  for (const peak of filtered) {
    if (
      merged.every((kept) => Math.abs(kept.timestampMs - peak.timestampMs) > FUSION.maximaMergeMs)
    ) {
      merged.push(peak);
    }
    if (merged.length >= FUSION.maximaCap) break;
  }
  return merged.sort((a, b) => a.timestampMs - b.timestampMs);
}

/** Peak ball step-speed near a moment (aspect-corrected, torso spans per
 * second) mapped onto the flight ramp: full weight at flying speed, fading
 * to zero at drift speed. Null speed (no measurable step in the band) keeps
 * a conservative partial factor — absence of measurement is not proof of
 * drift. */
function ballFlightFactor(
  ball: readonly BallObservation[],
  tMs: number,
  aspect: number,
  torso: number,
): { factor: number; torsoPerSec: number | null } {
  let peak: number | null = null;
  for (let index = 1; index < ball.length; index += 1) {
    const previous = ball[index - 1]!;
    const current = ball[index]!;
    const dtMs = current.timestampMs - previous.timestampMs;
    if (dtMs <= 0 || dtMs > 150) continue;
    const midMs = (current.timestampMs + previous.timestampMs) / 2;
    if (Math.abs(midMs - tMs) > FUSION.ballFlightBandMs) continue;
    const speed =
      (Math.hypot((current.x - previous.x) * aspect, current.y - previous.y) / dtMs) * 1000;
    if (peak === null || speed > peak) peak = speed;
  }
  if (peak === null) return { factor: FUSION.ballFlightUnknownFactor, torsoPerSec: null };
  const torsoPerSec = peak / torso;
  const factor = clamp01(
    (torsoPerSec - FUSION.ballFlightMinTorsoPerSec) /
      (FUSION.ballFlightFullTorsoPerSec - FUSION.ballFlightMinTorsoPerSec),
  );
  return { factor, torsoPerSec };
}

/** Best motion support for a moment: the largest interpolated speed at
 * `tMs` across the measured motion series, each relative to a fraction of
 * its own in-window maximum. 1 = at least one series was clearly moving;
 * <1 = every measured series was quiet. No series measured near the moment
 * → 1 (absence of measurement is not counter-evidence). */
function motionSupportAt(
  tMs: number,
  motionSeries: ReadonlyArray<ReadonlyArray<{ timestampMs: number; value: number }>>,
): number {
  const supports: number[] = [];
  for (const series of motionSeries) {
    const value = interpolateValue(series, tMs, FUSION.motionSupportBandMs);
    if (value === null) continue;
    const max = Math.max(...series.map((sample) => sample.value));
    if (max <= 1e-6) continue;
    supports.push(clamp01(value / (FUSION.motionSupportFullFraction * max)));
  }
  return supports.length === 0 ? 1 : Math.max(...supports);
}

/** Confidence of the ball observation nearest a moment (within the flight
 * band); null when no observation is near enough to attribute. */
function nearestBallConfidence(ball: readonly BallObservation[], tMs: number): number | null {
  let best: BallObservation | null = null;
  for (const observation of ball) {
    if (Math.abs(observation.timestampMs - tMs) > FUSION.ballFlightBandMs) continue;
    if (
      best === null ||
      Math.abs(observation.timestampMs - tMs) < Math.abs(best.timestampMs - tMs)
    ) {
      best = observation;
    }
  }
  return best === null ? null : best.confidence;
}

/** Cross-modal corroboration: the OTHER motion series' time-interpolated
 * value at `tMs`, as a ratio to that series' median. Rigid paddle–wrist
 * coupling means a genuine speed peak in one shows elevated speed in the
 * other; a quiet other-series discounts the peak. No sample within the band
 * → no discount (absence of measurement is not counter-evidence). */
function corroborationFactor(
  other: ReadonlyArray<{ timestampMs: number; value: number }>,
  tMs: number,
): number {
  if (other.length === 0) return 1;
  const interpolated = interpolateValue(other, tMs, FUSION.corroborationBandMs);
  if (interpolated === null) return 1;
  const med = median(other.map((sample) => sample.value));
  if (med <= 1e-6) return 1;
  const ratio = interpolated / med;
  return Math.max(FUSION.corroborationFloor, Math.min(1, ratio / FUSION.corroborationFullRatio));
}

function interpolateValue(
  series: ReadonlyArray<{ timestampMs: number; value: number }>,
  tMs: number,
  maxGapMs: number,
): number | null {
  let before: { timestampMs: number; value: number } | null = null;
  let after: { timestampMs: number; value: number } | null = null;
  for (const sample of series) {
    if (sample.timestampMs <= tMs && (!before || sample.timestampMs > before.timestampMs)) {
      before = sample;
    }
    if (sample.timestampMs >= tMs && (!after || sample.timestampMs < after.timestampMs)) {
      after = sample;
    }
  }
  const beforeOk = before !== null && tMs - before.timestampMs <= maxGapMs;
  const afterOk = after !== null && after.timestampMs - tMs <= maxGapMs;
  if (beforeOk && afterOk) {
    if (after!.timestampMs === before!.timestampMs) return before!.value;
    const t = (tMs - before!.timestampMs) / (after!.timestampMs - before!.timestampMs);
    return before!.value + (after!.value - before!.value) * t;
  }
  if (beforeOk) return before!.value;
  if (afterOk) return after!.value;
  return null;
}

/** Median shoulder-mid→hip-mid distance over the frames (aspect-corrected
 * image-height units); null when the torso was never fully measured. */
function medianTorsoSpan(
  frames: ReturnType<typeof toLegacyPoseFrames>,
  aspect: number,
): number | null {
  const spans: number[] = [];
  for (const frame of frames) {
    const get = (name: string) =>
      frame.landmarks.find((mark) => mark.name === name && mark.visibility >= 0.3) ?? null;
    const leftShoulder = get("left_shoulder");
    const rightShoulder = get("right_shoulder");
    const leftHip = get("left_hip");
    const rightHip = get("right_hip");
    if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) continue;
    spans.push(
      Math.hypot(
        ((leftShoulder.x + rightShoulder.x - (leftHip.x + rightHip.x)) / 2) * aspect,
        (leftShoulder.y + rightShoulder.y - (leftHip.y + rightHip.y)) / 2,
      ),
    );
  }
  if (spans.length === 0) return null;
  return median(spans);
}

/** Nearest target reference (paddle center preferred, then provided target
 * wrists, then sequence wrist landmarks) to the given image point, looking
 * only at references measured within a small time band. Distances are
 * aspect-corrected. Null = nothing measured near that moment. */
function nearestTargetReference(
  tMs: number,
  x: number,
  y: number,
  aspect: number,
  paddleCenters: ReadonlyArray<{ timestampMs: number; x: number; y: number }> | null,
  targetWrists: ReadonlyArray<{ timestampMs: number; x: number; y: number }> | null,
  frames: ReturnType<typeof toLegacyPoseFrames>,
): { distance: number; source: "paddle" | "wrist" } | null {
  const distanceTo = (px: number, py: number) => Math.hypot((px - x) * aspect, py - y);
  if (paddleCenters && paddleCenters.length > 0) {
    let best: number | null = null;
    for (const center of paddleCenters) {
      if (Math.abs(center.timestampMs - tMs) > 60) continue;
      const distance = distanceTo(center.x, center.y);
      if (best === null || distance < best) best = distance;
    }
    if (best !== null) return { distance: best, source: "paddle" };
  }
  let bestWrist: number | null = null;
  for (const wristPoint of targetWrists ?? []) {
    if (Math.abs(wristPoint.timestampMs - tMs) > 80) continue;
    const distance = distanceTo(wristPoint.x, wristPoint.y);
    if (bestWrist === null || distance < bestWrist) bestWrist = distance;
  }
  for (const frame of frames) {
    if (Math.abs(frame.timestampMs - tMs) > 80) continue;
    for (const mark of frame.landmarks) {
      if (!mark.name.endsWith("wrist")) continue;
      const distance = distanceTo(mark.x, mark.y);
      if (bestWrist === null || distance < bestWrist) bestWrist = distance;
    }
  }
  return bestWrist !== null ? { distance: bestWrist, source: "wrist" } : null;
}

/** Every direction change ≥ minTurnAngleDeg along the ball track. dtIn/dtOut
 * report the temporal step to the neighboring samples so callers can censor
 * turns measured across an occlusion gap. */
function directionChanges(ball: readonly BallObservation[]): Array<{
  timestampMs: number;
  angleDeg: number;
  speedRatio: number;
  x: number;
  y: number;
  dtInMs: number;
  dtOutMs: number;
}> {
  const turns: Array<{
    timestampMs: number;
    angleDeg: number;
    speedRatio: number;
    x: number;
    y: number;
    dtInMs: number;
    dtOutMs: number;
  }> = [];
  for (let index = 1; index < ball.length - 1; index += 1) {
    const previous = ball[index - 1]!;
    const current = ball[index]!;
    const next = ball[index + 1]!;
    const inVec = { x: current.x - previous.x, y: current.y - previous.y };
    const outVec = { x: next.x - current.x, y: next.y - current.y };
    const inMag = Math.hypot(inVec.x, inVec.y);
    const outMag = Math.hypot(outVec.x, outVec.y);
    if (inMag < 1e-6 || outMag < 1e-6) continue;
    const cos = Math.min(
      1,
      Math.max(-1, (inVec.x * outVec.x + inVec.y * outVec.y) / (inMag * outMag)),
    );
    const angleDeg = (Math.acos(cos) * 180) / Math.PI;
    if (angleDeg < FUSION.minTurnAngleDeg) continue;
    turns.push({
      timestampMs: current.timestampMs,
      angleDeg,
      speedRatio: outMag / inMag,
      x: current.x,
      y: current.y,
      dtInMs: current.timestampMs - previous.timestampMs,
      dtOutMs: next.timestampMs - current.timestampMs,
    });
  }
  return turns;
}

/** A ball sample at a track edge or adjacent to a temporal gap larger than
 * gapCensorMs: an extremum attained there is censored — the true extremum
 * may lie beyond the edge or inside the gap. */
function censoredBallSample(ball: readonly BallObservation[], timestampMs: number): boolean {
  const index = ball.findIndex((observation) => observation.timestampMs === timestampMs);
  if (index < 0) return false;
  const previousGap = index > 0 ? timestampMs - ball[index - 1]!.timestampMs : Infinity;
  const nextGap = index < ball.length - 1 ? ball[index + 1]!.timestampMs - timestampMs : Infinity;
  return previousGap > FUSION.gapCensorMs || nextGap > FUSION.gapCensorMs;
}

/** Nearest measured target wrist distance (provided targetWrists first, then
 * sequence wrist landmarks) to a point at a moment; null when no wrist was
 * measured within the band. */
function nearestWristDistanceTo(
  tMs: number,
  x: number,
  y: number,
  aspect: number,
  targetWrists: ReadonlyArray<{ timestampMs: number; x: number; y: number }> | null,
  frames: ReturnType<typeof toLegacyPoseFrames>,
): number | null {
  const distanceTo = (px: number, py: number) => Math.hypot((px - x) * aspect, py - y);
  let best: number | null = null;
  for (const wristPoint of targetWrists ?? []) {
    if (Math.abs(wristPoint.timestampMs - tMs) > 80) continue;
    const distance = distanceTo(wristPoint.x, wristPoint.y);
    if (best === null || distance < best) best = distance;
  }
  for (const frame of frames) {
    if (Math.abs(frame.timestampMs - tMs) > 80) continue;
    for (const mark of frame.landmarks) {
      if (!mark.name.endsWith("wrist")) continue;
      const distance = distanceTo(mark.x, mark.y);
      if (best === null || distance < best) best = distance;
    }
  }
  return best;
}

function closestBallToPoints(
  ball: readonly BallObservation[],
  points: ReadonlyArray<{ timestampMs: number; x: number; y: number }>,
  aspect: number,
): { timestampMs: number; distance: number } | null {
  let best: { timestampMs: number; distance: number } | null = null;
  for (const observation of ball) {
    let nearest: { timestampMs: number; x: number; y: number } | null = null;
    let nearestDelta = Infinity;
    for (const point of points) {
      const delta = Math.abs(point.timestampMs - observation.timestampMs);
      if (delta < nearestDelta) {
        nearestDelta = delta;
        nearest = point;
      }
    }
    if (!nearest || nearestDelta > 60) continue;
    const distance = Math.hypot((nearest.x - observation.x) * aspect, nearest.y - observation.y);
    if (!best || distance < best.distance) {
      best = { timestampMs: observation.timestampMs, distance };
    }
  }
  return best;
}

function closestBallToWrist(
  ball: readonly BallObservation[],
  frames: ReturnType<typeof toLegacyPoseFrames>,
  aspect: number,
  targetWrists: ReadonlyArray<{ timestampMs: number; x: number; y: number }> | null,
): { timestampMs: number; distance: number } | null {
  let best: { timestampMs: number; distance: number } | null = null;
  for (const observation of ball) {
    let bestDistance: number | null = null;
    for (const wristPoint of targetWrists ?? []) {
      if (Math.abs(wristPoint.timestampMs - observation.timestampMs) > 50) continue;
      const distance = Math.hypot(
        (wristPoint.x - observation.x) * aspect,
        wristPoint.y - observation.y,
      );
      if (bestDistance === null || distance < bestDistance) bestDistance = distance;
    }
    if (bestDistance === null) {
      let nearestFrame: ReturnType<typeof toLegacyPoseFrames>[number] | null = null;
      let nearestDelta = Infinity;
      for (const frame of frames) {
        const delta = Math.abs(frame.timestampMs - observation.timestampMs);
        if (delta < nearestDelta && frame.landmarks.some((mark) => mark.name.endsWith("wrist"))) {
          nearestDelta = delta;
          nearestFrame = frame;
        }
      }
      if (!nearestFrame || nearestDelta > 50) continue;
      for (const mark of nearestFrame.landmarks) {
        if (!mark.name.endsWith("wrist")) continue;
        const distance = Math.hypot((mark.x - observation.x) * aspect, mark.y - observation.y);
        if (bestDistance === null || distance < bestDistance) bestDistance = distance;
      }
    }
    if (bestDistance === null) continue;
    if (!best || bestDistance < best.distance) {
      best = { timestampMs: observation.timestampMs, distance: bestDistance };
    }
  }
  return best;
}

function downsampleDistribution(
  grid: ReadonlyArray<{ tMs: number; density: number }>,
  peakDensity: number,
): ContactDistributionPoint[] {
  if (grid.length === 0 || peakDensity <= 0) return [];
  const step = Math.max(1, Math.ceil(grid.length / FUSION.distributionPoints));
  const points: ContactDistributionPoint[] = [];
  for (let index = 0; index < grid.length; index += step) {
    points.push({
      tMs: Math.round(grid[index]!.tMs),
      density: round3(grid[index]!.density / peakDensity),
    });
  }
  return points;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
