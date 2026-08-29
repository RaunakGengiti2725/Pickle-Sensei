import type { Handedness } from "@pickle/shared-types";
import { toLegacyPoseFrames, type PoseSequence } from "@pickle/swing-domain";

/**
 * Stroke recognition taxonomy v3 + the hierarchical HEURISTIC baseline —
 * PORT of packages/swing-lab/src/strokeHeuristic.ts (stroke-heuristic-4).
 *
 * WHY THIS FILE EXISTS: the mobile app wires AUTO DETECT (declared-null
 * stroke routing, see analysis-pipeline/strokeAutoResolution.ts) and must not
 * depend on @pickle/swing-lab, whose package drags in node-only tooling.
 * The classifier itself is pure TypeScript over pose frames, so it lives
 * here in the deterministic geometry bundle.
 *
 * DEDUP FOLLOW-UP (intentionally not done this wave): swing-lab keeps its
 * own byte-equivalent copy for the desktop lab; a later wave should delete
 * that copy and re-export from here. Until then, behavioral changes must be
 * made in BOTH files or (better) not at all without calibration data.
 *
 * This is measured geometry, not a learned classifier, and it says so:
 * predictions stop at the deepest taxonomy level the evidence supports.
 * Level 1 separates OVERHEAD / SWING (bounce information does not exist yet,
 * so volley-vs-groundstroke is NOT claimable at L1). Level 2 decides
 * FOREHAND/BACKHAND from the dominant wrist's position relative to the body
 * midline in the PLAYER's frame (camera-facing corrected). Level 3 commits to
 * DINK vs DRIVE only when contact height and swing speed agree with margin —
 * which today they never can without bounce observation.
 *
 * stroke-heuristic-2 hardened CONTACT-POINT provenance and the OVERHEAD
 * claim against single-point tracking failures (plausibility gate, skeletal
 * corroboration, abstention band). stroke-heuristic-3 adds NON-STROKE
 * abstention gates found by red-teaming AUTO DETECT: measured non-motion
 * (a walk-through, an aborted/checked swing, a static reach) and degenerate
 * torso normalization must abstain instead of committing an identity.
 * stroke-heuristic-3.1 ports stroke-heuristic-5's FACING CONSENSUS (E10-F4):
 * the camera-facing sign is decided by the shoulder x-order majority across
 * ±200ms of the reference (near-profile frames cannot vote), never by the
 * single nearest frame alone, whose x-order a transient mid-swing shoulder
 * crossing can invert and mirror the side call at full confidence.
 *
 * stroke-heuristic-3.1 ports swing-lab's stroke-heuristic-5 additions in
 * lockstep:
 *  - CONTACT-EVIDENCE CAP (E10-F1): when the reference is only the isolated
 *    event's motion peak (no contact event was ever measured) AND no
 *    plausible paddle point corroborates a contact, nothing in the input
 *    distinguishes the motion from a ball-less swing — the side commitment
 *    is treated as degraded-trust (degraded abstention band +
 *    DEGRADED_CONFIDENCE_CAP instead of the 0.8 ceiling).
 *  - HANDEDNESS CROSS-CHECK (E10-F2): the side decision assumes the paddle
 *    is in the declared hand, but the declaration is player-supplied
 *    context, not evidence. A verifiable, decisive contradiction between
 *    the measured dominant-motion wrist and the declared side abstains; a
 *    non-decisive contradiction degrades the side confidence instead.
 * The swing-lab stroke-heuristic-4 absence-of-measurement gates are still
 * NOT ported (tracked separately).
 *
 * stroke-heuristic-3.1 adds the SYMMETRIC BIMANUAL gate (E10-F5, ported in
 * lockstep with swing-lab's stroke-heuristic-5): wheelchair rim propulsion
 * moves BOTH wrists in a synchronized, similar-magnitude, WIDE-SEPARATION
 * arc — a shape the single-dominant-wrist energy/travel gates cannot see.
 * When the rival wrist mirrors the dominant wrist's motion step-for-step
 * AND the wrists stay far apart (each hand on its own wheel rim), no
 * single-arm stroke identity is attributable — abstain. Genuine two-handed
 * backhands keep BOTH hands on ONE grip, so their wrist separation stays
 * small and the gate does not fire. (swing-lab's stroke-heuristic-4
 * absence-of-measurement gates are NOT yet ported here — that dedup/port
 * remains a follow-up.)
 *
 * stroke-heuristic-4 closes three absence-of-measurement holes found by
 * benchmarking against the wave-c/d stroke gold on committed wave-a pose
 * slices (strokeHeuristicBench):
 *
 *  4. The non-swing SPEED gate only fires on measured in-window samples —
 *     a window that contains ZERO samples of an otherwise long series must
 *     not read as "no swing energy".
 *  5. Torso normalization is checked against the SEQUENCE's own median
 *     torso extent: a reference frame whose torso extent has transiently
 *     collapsed clears the absolute floor yet still yields a garbage
 *     midline/normalization — abstain.
 *  6. Dominant-wrist attribution requires the RIVAL wrist to have been
 *     measured near the reference: a rival with zero measured frames has
 *     zero travel by absence, so "this wrist moved more" is unverifiable.
 *
 * declared / annotated / predicted stroke stay separate records everywhere.
 */

export const STROKE_TAXONOMY_V3 = {
  version: "pickleball-stroke-taxonomy-v3",
  labels: [
    "FOREHAND_DRIVE",
    "BACKHAND_DRIVE",
    "SERVE",
    "RETURN",
    "FOREHAND_DINK",
    "BACKHAND_DINK",
    "FOREHAND_VOLLEY",
    "BACKHAND_VOLLEY",
    "DROP",
    "RESET",
    "OVERHEAD",
    "SPEEDUP",
    "UNKNOWN",
  ] as const,
} as const;
export type StrokeV3 = (typeof STROKE_TAXONOMY_V3.labels)[number];

export const STROKE_HEURISTIC_VERSION = "stroke-heuristic-6 (uncalibrated)";

/**
 * Constants derived from the DEV sandbox pose/paddle data (W9-forensics.txt,
 * wave-b). Held-out cases were never measured. n=2 measurable dev cases —
 * these are documented anchors, not calibrated statistics.
 *
 * PADDLE_REACH_ARM_LENGTHS — verified-good paddle tracks sit 0.36–0.41
 *   arm-lengths from the dominant wrist at contact (wm-volley-02 0.41,
 *   afn-sasebo-rally2 0.36). 1.2 arm-lengths is ~3× the measured-good
 *   distance and still under the anatomical maximum a real paddle center
 *   can reach (hand + grip + half a paddle ≈ 0.5–0.6 arm), with 2D
 *   foreshortening headroom.
 * PADDLE_REACH_TORSO_UNITS — fallback when the arm is not measurable.
 *   Dev arm/torso ratios: 0.72 (rally2) and 1.30 (wm-volley crouch), so
 *   1.2×arm ≈ 0.9–1.6 torso units; 1.5 sits at the generous end.
 * PADDLE_POINT_CONFIDENCE_FLOOR — the stale mid-body track that shadowed
 *   rally2's real (raised) paddle carried per-observation confidence
 *   0.08–0.28 near contact; the verified-good wm-volley track carried
 *   0.68–0.85. 0.3 separates them with margin on both sides. An observation
 *   that carries NO confidence (mobile's minimal paddle shape) is treated as
 *   below the floor — unverifiable trust is not trust.
 * OVERHEAD_WINDOW_MS — the raise apex of the dev overhead sits 81–147ms
 *   BEFORE the estimated contact (fast smash + 30fps sampling + estimator
 *   30ms late): a ±80ms window sees at most one visibility-gated frame
 *   (median −0.28, blind slice), so the corroboration window is ±150ms.
 *   The ±80ms median is still computed and recorded as evidence.
 * OVERHEAD_WRIST_RAISE_TORSO / OVERHEAD_MIN_RAISED_FRAMES — the dev overhead
 *   shows 3 frames at vis≥0.5 raised +0.37..+0.64 torso above the shoulder
 *   line inside ±150ms; the dev volley's maximum is −0.24 (never raised).
 *   Threshold +0.25 (same as the point-height threshold) with ≥2 frames.
 * OVERHEAD_ELBOW_RAISE_TORSO — same scan for the elbow: dev overhead
 *   +0.20..+0.26 (3 frames) vs dev volley max −0.50. Threshold +0.10.
 * SIDE_MARGIN_DEGRADED_BAND — with degraded provenance the side commitment
 *   additionally requires margin ≥ 0.5 shoulder-widths (good-provenance dev
 *   commitments measure 1.99–2.32; the universal floor stays 0.15).
 *
 * Non-stroke gates (stroke-heuristic-3, red-team derived — conservative
 * floors, NOT calibrated statistics):
 * NON_SWING_SPEED_FLOOR — far below the slow-swing intensity boundary
 *   already in this file (0.9 u/s): a MEASURED speed series whose window
 *   peak never reaches 0.25 u/s is not a swing. When no series is measured
 *   the gate cannot fire — absence of measurement is never evidence.
 * NON_SWING_TRAVEL_FLOOR / MIN_TRAVEL_SAMPLE_FRAMES — dominant-wrist path
 *   length across ±200ms of the reference. The synthetic dev swing measures
 *   ≈0.4u and the rally2-shaped jitter fixture ≈0.25u; a held-still reach
 *   measures ≈0. The gate fires only below 0.05u AND when the wrist was
 *   actually measured in ≥5 nearby frames — sparse visibility must never
 *   masquerade as stillness.
 * MIN_WINDOW_SPEED_SAMPLES (stroke-heuristic-4) — the speed gate needs ≥3
 *   MEASURED samples inside the event window to claim "no swing energy";
 *   an empty window slice of a long series is absence, not evidence.
 * TORSO_COLLAPSE_MEDIAN_RATIO / TORSO_MEDIAN_MIN_FRAMES (stroke-heuristic-4)
 *   — relative torso-collapse gate. Dev anchors: a transiently occluded
 *   reference frame measured 41% of the sequence median torso extent and
 *   produced a wrong side commit; the smallest legitimate reference in the
 *   same bench measured 65%. 0.6 separates them; the median needs ≥5
 *   measured torso frames to be meaningful.
 * HANDEDNESS_CONTRADICTION_TRAVEL_RATIO (stroke-heuristic-3.1) — a
 *   declared-handedness contradiction is DECISIVE only when the
 *   off-declaration wrist's ±200ms travel is at least this multiple of the
 *   declared wrist's travel, with both wrists measured in
 *   ≥MIN_TRAVEL_SAMPLE_FRAMES frames. One-armed swings measure extreme
 *   ratios (the E10-F2 fixture measures 0.471u vs 0.000u rival over 25
 *   frames each; the swing-lab wave-a bench L1/L2 outcomes are unchanged by
 *   this gate); a two-handed backhand moves both wrists together (ratio ≈1)
 *   and must NOT abstain. 1.5 is a conservative red-team floor, not a
 *   calibrated statistic.
 * TORSO_MIN_EXTENT — normalized image units. Real torsos measure ≈0.12–0.24
 *   (synthetic default 0.2); below 0.04 the hip line has collapsed onto the
 *   shoulder line (e.g. chair-back occlusion) and every torso-normalized
 *   ratio in this file is meaningless — abstain instead of dividing by it.
 * SHOULDER_MIN_SEPARATION — normalized image units. The side decision
 *   normalizes the contact→midline offset by the IMAGE-PLANE shoulder
 *   separation and reads the facing sign from the shoulder x-order. Frontal
 *   and rear fixtures measure ≈0.16–0.2; the near-profile E10-F3 fixture
 *   measures 0.005 — estimator-noise scale, where the 0.02 clamp on
 *   shoulderWidth only prevents a divide-by-zero without making the ratio
 *   meaningful. 0.04 mirrors TORSO_MIN_EXTENT's reasoning; the strict `<`
 *   keeps the mid-rotation crossing fixture (E10-F4, exactly 0.04u at
 *   contact) outside the gate.
 *
 * Facing-consensus constants (stroke-heuristic-3.1, red-team derived —
 * conservative floors, NOT calibrated statistics):
 * FACING_WINDOW_MS — same ±200ms neighborhood the dominant-wrist travel
 *   scan already uses: wide enough for repeated measurements, narrow
 *   enough that the player has not genuinely turned around.
 * FACING_MIN_SHOULDER_SEPARATION — image-plane |Δx| below which a frame's
 *   shoulder x-order is noise-scale and cannot vote. The near-profile
 *   red-team fixture measures 0.005u; real synthetic/dev shoulder widths
 *   measure ≥0.1u even mid-turn. 0.03 sits above the 0.02 width clamp.
 * FACING_MIN_VOTES / FACING_CONSENSUS_MIN_RATIO — a consensus needs ≥3
 *   voting frames with a ≥2/3 majority. Below that the facing is genuinely
 *   ambiguous near the reference: fall back to the single-frame sign
 *   (separation-guarded) with the side confidence capped at the degraded
 *   ceiling, or abstain when even that frame is near-profile.
 */
const PADDLE_REACH_ARM_LENGTHS = 1.2;
const PADDLE_REACH_TORSO_UNITS = 1.5;
const PADDLE_POINT_CONFIDENCE_FLOOR = 0.3;
const WRIST_RELIABLE_VISIBILITY = 0.5;
const OVERHEAD_POINT_RAISE_TORSO = 0.25;
const OVERHEAD_WINDOW_MS = 150;
const OVERHEAD_MEDIAN_WINDOW_MS = 80;
const OVERHEAD_WRIST_RAISE_TORSO = 0.25;
const OVERHEAD_ELBOW_RAISE_TORSO = 0.1;
const OVERHEAD_MIN_RAISED_FRAMES = 2;
const SIDE_MARGIN_FLOOR = 0.15;
const SIDE_MARGIN_DEGRADED_BAND = 0.5;
const DEGRADED_CONFIDENCE_CAP = 0.6;
const NON_SWING_SPEED_FLOOR = 0.25;
const MIN_WINDOW_SPEED_SAMPLES = 3;
const NON_SWING_TRAVEL_FLOOR = 0.05;
const MIN_TRAVEL_SAMPLE_FRAMES = 5;
const TORSO_MIN_EXTENT = 0.04;
const TORSO_COLLAPSE_MEDIAN_RATIO = 0.6;
const TORSO_MEDIAN_MIN_FRAMES = 5;
const SHOULDER_MIN_SEPARATION = 0.04;
const HANDEDNESS_CONTRADICTION_TRAVEL_RATIO = 1.5;
const FACING_WINDOW_MS = 200;
const FACING_MIN_SHOULDER_SEPARATION = 0.03;
const FACING_MIN_VOTES = 3;
const FACING_CONSENSUS_MIN_RATIO = 2 / 3;

/**
 * Symmetric-bimanual (rim-propulsion) gate constants (stroke-heuristic-3.1,
 * red-team derived from the E10-F5 fixture — conservative floors, NOT
 * calibrated statistics):
 * BIMANUAL_MIN_PAIRED_STEPS — the gate only judges MEASUREMENTS: it needs
 *   ≥5 consecutive-frame steps (±200ms) where BOTH wrists were measured in
 *   both frames. Sparse rival visibility never fires it.
 * BIMANUAL_TRAVEL_RATIO — rival-wrist path length ≥ 0.7× the dominant
 *   wrist's. One-armed strokes measure near-still off hands (the synthetic
 *   dev swing's off wrist is static, ratio ≈ 0); a symmetric rim push is
 *   ratio ≈ 1.0 by construction.
 * BIMANUAL_SYNC_FRACTION / BIMANUAL_STEP_MOTION_FLOOR — of the paired steps
 *   where either wrist moved ≥ 0.01u, ≥70% must be synchronized: vertical
 *   displacements share a sign and step magnitudes are within 2× of each
 *   other. The rim-push fixture measures 1.0; a swing with an incidentally
 *   moving off hand (balance arm) shares neither consistently.
 * BIMANUAL_WIDE_SEPARATION_SW — mean inter-wrist distance ≥ 0.9
 *   shoulder-widths across the paired steps. Hands on separate wheel rims
 *   sit ≈1.4 shoulder-widths apart (fixture); a genuine two-handed backhand
 *   keeps both hands on ONE grip (≈0.2–0.4 shoulder-widths), so wide
 *   separation is what makes symmetric motion a NON-stroke signature.
 */
const BIMANUAL_MIN_PAIRED_STEPS = 5;
const BIMANUAL_TRAVEL_RATIO = 0.7;
const BIMANUAL_SYNC_FRACTION = 0.7;
const BIMANUAL_STEP_MOTION_FLOOR = 0.01;
const BIMANUAL_WIDE_SEPARATION_SW = 0.9;

/**
 * Minimal paddle observation the heuristic actually reads. swing-lab's
 * TrackedPaddleObservation is structurally assignable to this, so the lab
 * can pass its tracks through unchanged when it adopts this port.
 * `confidence` is optional: mobile's minimal shape omits it, and a missing
 * confidence is treated as below the trust floor (degraded provenance).
 */
export interface HeuristicPaddleObservation {
  timestampMs: number;
  center: { x: number; y: number };
  confidence?: number;
}

/**
 * Structurally identical to swing-lab's StrokePrediction and to the fusion
 * engine's HierarchicalStrokePrediction (strokeAutoResolution.ts) — an
 * adapter passes it through unchanged.
 */
export interface HeuristicStrokePrediction {
  taxonomyVersion: string;
  classifierVersion: string;
  /** Deepest label the evidence supports (may be coarse, e.g. "FOREHAND"). */
  label: string;
  /** Mapped v3 leaf when depth reaches 3 (or OVERHEAD at depth 1); else null. */
  leaf: StrokeV3 | null;
  taxonomyDepth: 1 | 2 | 3;
  /** Heuristic, uncalibrated. */
  confidence: number;
  evidence: string[];
  limitingFactors: string[];
  /** ADDITIVE (v2): where the contact point came from. */
  contactPointSource?: "paddle" | "wrist" | null;
  /** ADDITIVE (v2): provenance quality of the contact point. */
  contactPointReliability?: "strong" | "degraded" | null;
}

export function classifyStroke(input: {
  sequence: PoseSequence;
  window: { startMs: number; endMs: number };
  contactMs: number | null;
  /** Measured kinematic peak of the ISOLATED event — the only permitted
   * reference when contact is missing (never a window midpoint). */
  eventPeakMs?: number | null;
  handedness: Handedness;
  paddle: readonly HeuristicPaddleObservation[] | null;
  paddleSpeeds: ReadonlyArray<{ timestampMs: number; value: number }> | null;
  wristSpeeds: ReadonlyArray<{ timestampMs: number; value: number }> | null;
}): HeuristicStrokePrediction {
  const evidence: string[] = [];
  const limitingFactors: string[] = [];
  const frames = toLegacyPoseFrames(input.sequence);
  let contactMs: number;
  let referenceIsEventPeak = false;
  if (input.contactMs !== null) {
    contactMs = input.contactMs;
  } else if (input.eventPeakMs !== null && input.eventPeakMs !== undefined) {
    contactMs = input.eventPeakMs;
    referenceIsEventPeak = true;
    limitingFactors.push("reference_is_event_peak_not_contact");
  } else {
    return unknown("no_contact_and_no_event_peak_reference", evidence, limitingFactors);
  }

  const frame = nearestFrame(frames, contactMs);
  if (!frame) {
    return unknown("no_pose_frame_near_contact", evidence, limitingFactors);
  }
  const joints = new Map(frame.landmarks.map((mark) => [mark.name, mark]));
  const leftShoulder = joints.get("left_shoulder");
  const rightShoulder = joints.get("right_shoulder");
  const leftHip = joints.get("left_hip");
  const rightHip = joints.get("right_hip");
  if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) {
    return unknown("torso_not_measured_at_contact", evidence, limitingFactors);
  }
  const shoulderY = (leftShoulder.y + rightShoulder.y) / 2;
  const hipY = (leftHip.y + rightHip.y) / 2;
  const midX = (leftShoulder.x + rightShoulder.x) / 2;
  const shoulderWidth = Math.max(0.02, Math.abs(rightShoulder.x - leftShoulder.x));
  const torso = Math.max(0.02, hipY - shoulderY);

  // ── Gate: degenerate torso normalization (stroke-heuristic-3) ──────────
  // Every height/raise judgement below divides by the torso extent. When
  // the measured hip line has collapsed onto the shoulder line the divisor
  // is noise and any point reads as "torso-units above the shoulders" —
  // abstain instead of normalizing by a degenerate quantity.
  const rawTorsoExtent = hipY - shoulderY;
  if (rawTorsoExtent < TORSO_MIN_EXTENT) {
    evidence.push(
      `torso extent ${rawTorsoExtent.toFixed(3)}u at reference (floor ${TORSO_MIN_EXTENT})`,
    );
    return unknown("torso_extent_degenerate_normalization_unreliable", evidence, limitingFactors);
  }

  // ── Gate: transient torso collapse vs the sequence median (v4) ────────
  // An occluded reference frame can clear the absolute floor while still
  // measuring a fraction of the player's own median torso extent — the
  // midline and every torso-normalized ratio at that instant are garbage.
  const medianTorso = medianTorsoExtent(frames);
  if (medianTorso !== null && rawTorsoExtent < TORSO_COLLAPSE_MEDIAN_RATIO * medianTorso) {
    evidence.push(
      `torso extent ${rawTorsoExtent.toFixed(3)}u at reference vs sequence median ${medianTorso.toFixed(3)}u ` +
        `(< ${TORSO_COLLAPSE_MEDIAN_RATIO}× — transient collapse)`,
    );
    return unknown("torso_extent_collapsed_vs_sequence_median", evidence, limitingFactors);
  }

  const wristInfo = dominantWristInfo(frames, contactMs);

  // ── Gate: dominant-wrist attribution must be verifiable (v4) ──────────
  // The dominant wrist is chosen by comparative travel. When the rival
  // wrist was NEVER measured near the reference its travel is zero by
  // absence, so the comparison is unverifiable — the visible arm may be
  // the non-striking one. Abstain rather than commit an unattributable side.
  if (wristInfo.measuredFrames > 0 && wristInfo.rivalMeasuredFrames === 0) {
    evidence.push(
      `rival (${wristInfo.side === "right" ? "left" : "right"}) wrist has 0 measured frames ±200ms — dominant-wrist travel comparison unverifiable`,
    );
    return unknown(
      "dominant_wrist_attribution_unverifiable_rival_unmeasured",
      evidence,
      limitingFactors,
    );
  }

  // ── Gate: symmetric bimanual motion is not a stroke (v3.1) ────────────
  // Wheelchair rim propulsion pushes BOTH wheel rims at once: the wrists
  // move with high synchrony and similar magnitude while staying roughly a
  // wheelbase apart. No single-arm stroke identity is attributable to that
  // shape. The gate acts only on paired MEASUREMENTS of both wrists, and
  // wide separation keeps genuine two-handed backhands (both hands on one
  // grip, small separation) out of its reach.
  const bimanual = bimanualMotionInfo(frames, contactMs);
  if (
    bimanual.pairedSteps >= BIMANUAL_MIN_PAIRED_STEPS &&
    wristInfo.travel >= NON_SWING_TRAVEL_FLOOR &&
    bimanual.rivalTravel >= BIMANUAL_TRAVEL_RATIO * wristInfo.travel &&
    bimanual.movingSteps > 0 &&
    bimanual.synchronizedSteps / bimanual.movingSteps >= BIMANUAL_SYNC_FRACTION &&
    bimanual.meanSeparation / shoulderWidth >= BIMANUAL_WIDE_SEPARATION_SW
  ) {
    evidence.push(
      `both wrists move together ±200ms: rival travel ${bimanual.rivalTravel.toFixed(3)}u vs dominant ${wristInfo.travel.toFixed(3)}u ` +
        `(ratio floor ${BIMANUAL_TRAVEL_RATIO}), ${bimanual.synchronizedSteps}/${bimanual.movingSteps} moving steps synchronized ` +
        `(floor ${BIMANUAL_SYNC_FRACTION}), mean wrist separation ${(bimanual.meanSeparation / shoulderWidth).toFixed(2)} shoulder-widths ` +
        `(wide-grip floor ${BIMANUAL_WIDE_SEPARATION_SW}) — rim-propulsion signature`,
    );
    return unknown("symmetric_bimanual_motion_rim_propulsion_signature", evidence, limitingFactors);
  }

  // ── Gates: measured non-motion is not a stroke (stroke-heuristic-3) ────
  // Both gates act only on MEASUREMENTS: a speed series that never reaches
  // walking-arm pace inside the event window, or a repeatedly-measured
  // dominant wrist that barely moved around the reference. Absent
  // measurements never fire them.
  const speeds =
    input.paddleSpeeds && input.paddleSpeeds.length >= 5
      ? { series: input.paddleSpeeds, source: "paddle" }
      : input.wristSpeeds && input.wristSpeeds.length >= 5
        ? { series: input.wristSpeeds, source: "wrist" }
        : null;
  if (speeds) {
    const windowSamples = speeds.series.filter(
      (sample) =>
        sample.timestampMs >= input.window.startMs && sample.timestampMs <= input.window.endMs,
    );
    const windowPeak = windowSamples.reduce((best, sample) => Math.max(best, sample.value), 0);
    if (windowSamples.length >= MIN_WINDOW_SPEED_SAMPLES && windowPeak < NON_SWING_SPEED_FLOOR) {
      evidence.push(
        `${speeds.source} speed peak ${windowPeak.toFixed(2)} u/s over ${windowSamples.length} in-window samples (non-swing floor ${NON_SWING_SPEED_FLOOR})`,
      );
      return unknown("no_swing_energy_in_window", evidence, limitingFactors);
    }
    if (windowSamples.length > 0 && windowSamples.length < MIN_WINDOW_SPEED_SAMPLES) {
      limitingFactors.push("speed_window_sparsely_sampled_gate_not_applicable");
    }
  }
  if (
    wristInfo.measuredFrames >= MIN_TRAVEL_SAMPLE_FRAMES &&
    wristInfo.travel < NON_SWING_TRAVEL_FLOOR
  ) {
    evidence.push(
      `dominant wrist travelled ${wristInfo.travel.toFixed(3)}u over ${wristInfo.measuredFrames} measured frames ±200ms (non-swing floor ${NON_SWING_TRAVEL_FLOOR})`,
    );
    return unknown("no_swing_motion_near_reference", evidence, limitingFactors);
  }

  // ── Contact point with kinematic plausibility (stroke-heuristic-2) ─────
  // Measured paddle center near contact when available AND within reach of
  // the dominant wrist; else the dominant-motion wrist. Source + provenance
  // quality are recorded so downstream consumers can weigh the claim.
  const armLength = estimateArmLength(frames, contactMs, wristInfo.side);
  const reachLimit =
    armLength !== null ? PADDLE_REACH_ARM_LENGTHS * armLength : PADDLE_REACH_TORSO_UNITS * torso;

  let contactPoint: { x: number; y: number } | null = null;
  let contactPointSource: "paddle" | "wrist" | null = null;
  let contactPointReliability: "strong" | "degraded" = "degraded";

  const paddleNear = input.paddle
    ?.filter((observation) => Math.abs(observation.timestampMs - contactMs) <= 80)
    .sort((a, b) => Math.abs(a.timestampMs - contactMs) - Math.abs(b.timestampMs - contactMs))[0];
  const paddleNearConfidence = paddleNear?.confidence ?? null;
  const paddleNearTrusted =
    paddleNearConfidence !== null && paddleNearConfidence >= PADDLE_POINT_CONFIDENCE_FLOOR;

  if (paddleNear && wristInfo.point) {
    const wristDistance = Math.hypot(
      paddleNear.center.x - wristInfo.point.x,
      paddleNear.center.y - wristInfo.point.y,
    );
    if (wristDistance <= reachLimit) {
      contactPoint = paddleNear.center;
      contactPointSource = "paddle";
      contactPointReliability = paddleNearTrusted ? "strong" : "degraded";
      evidence.push(
        `paddle center at contact (${paddleNear.center.x.toFixed(2)}, ${paddleNear.center.y.toFixed(2)}) — ` +
          `${wristDistance.toFixed(2)}u from wrist (reach limit ${reachLimit.toFixed(2)}u ${armLength !== null ? `= 1.2×arm ${armLength.toFixed(2)}u` : `= 1.5×torso ${torso.toFixed(2)}u`}), track conf ${paddleNearConfidence === null ? "unreported" : paddleNearConfidence.toFixed(2)}`,
      );
      if (contactPointReliability === "degraded") {
        limitingFactors.push("paddle_point_low_track_confidence");
      }
    } else {
      contactPoint = wristInfo.point;
      contactPointSource = "wrist";
      contactPointReliability =
        wristInfo.visibility >= WRIST_RELIABLE_VISIBILITY ? "strong" : "degraded";
      evidence.push(
        `paddle center (${paddleNear.center.x.toFixed(2)}, ${paddleNear.center.y.toFixed(2)}) is ${wristDistance.toFixed(2)}u from the dominant wrist ` +
          `(> reach limit ${reachLimit.toFixed(2)}u) — using wrist (${wristInfo.point.x.toFixed(2)}, ${wristInfo.point.y.toFixed(2)}) instead`,
      );
      limitingFactors.push("paddle_point_implausible_used_wrist");
      if (contactPointReliability === "degraded") {
        limitingFactors.push("wrist_low_visibility_at_contact");
      }
    }
  } else if (paddleNear && !wristInfo.point) {
    // Plausibility unverifiable: the wrist is not measured at contact. A
    // confident paddle track may still carry the point (degraded); a
    // low-confidence one leaves NO reliable contact point — abstain rather
    // than guess (both sources unreliable).
    if (paddleNearTrusted) {
      contactPoint = paddleNear.center;
      contactPointSource = "paddle";
      contactPointReliability = "degraded";
      evidence.push(
        `paddle center at contact (${paddleNear.center.x.toFixed(2)}, ${paddleNear.center.y.toFixed(2)}), track conf ${paddleNearConfidence!.toFixed(2)} — wrist invisible, plausibility unverified`,
      );
      limitingFactors.push("paddle_plausibility_unverified_wrist_invisible");
    } else {
      limitingFactors.push("paddle_point_low_track_confidence");
      limitingFactors.push("wrist_invisible_at_contact");
      return unknown(
        "contact_point_unreliable_paddle_unverified_wrist_invisible",
        evidence,
        limitingFactors,
      );
    }
  } else if (wristInfo.point) {
    contactPoint = wristInfo.point;
    contactPointSource = "wrist";
    contactPointReliability =
      wristInfo.visibility >= WRIST_RELIABLE_VISIBILITY ? "strong" : "degraded";
    evidence.push(
      `wrist at contact (${wristInfo.point.x.toFixed(2)}, ${wristInfo.point.y.toFixed(2)}) — paddle not tracked at contact`,
    );
    limitingFactors.push("paddle_not_tracked_at_contact");
    if (contactPointReliability === "degraded") {
      limitingFactors.push("wrist_low_visibility_at_contact");
    }
  }
  if (!contactPoint) {
    return unknown("no_contact_point_measurable", evidence, limitingFactors);
  }

  // ── Level 1: vertical motion class ─────────────────────────────────────
  const aboveShoulder = (shoulderY - contactPoint.y) / torso; // >0 above
  const pointRaised = aboveShoulder > OVERHEAD_POINT_RAISE_TORSO;

  // Skeletal raise corroboration around contact (stroke-heuristic-2): the
  // contact POINT is one measurement of one instant; the raise of the
  // dominant wrist/elbow across the contact window is repeated, independent
  // evidence. Both are recorded; disagreements are resolved by provenance.
  const raise = scanRaiseWindow(frames, contactMs, wristInfo.side);
  if (raise.wristMeasuredFrames > 0) {
    evidence.push(
      `overhead window ±${OVERHEAD_WINDOW_MS}ms: dominant wrist ≥${OVERHEAD_WRIST_RAISE_TORSO} torso above shoulder line in ` +
        `${raise.wristRaisedFrames}/${raise.wristMeasuredFrames} measured frames (max ${raise.maxWristRaise === null ? "n/a" : raise.maxWristRaise.toFixed(2)}); ` +
        `elbow ≥${OVERHEAD_ELBOW_RAISE_TORSO} in ${raise.elbowRaisedFrames}/${raise.elbowMeasuredFrames}`,
    );
  }
  if (raise.medianWristRaise80 !== null) {
    evidence.push(
      `±${OVERHEAD_MEDIAN_WINDOW_MS}ms wrist-raise median ${raise.medianWristRaise80.toFixed(2)} torso over ${raise.wristMeasuredFrames80} frame(s)`,
    );
  }
  const windowWristRaised = raise.wristRaisedFrames >= OVERHEAD_MIN_RAISED_FRAMES;
  const windowElbowRaised = raise.elbowRaisedFrames >= OVERHEAD_MIN_RAISED_FRAMES;
  const windowMeasured = raise.wristMeasuredFrames > 0 || raise.elbowMeasuredFrames > 0;

  if (pointRaised) {
    evidence.push(`contact ${aboveShoulder.toFixed(2)} torso-units above shoulders`);
    if (windowWristRaised || windowElbowRaised) {
      // Point and skeleton agree — the strong OVERHEAD claim.
      return {
        taxonomyVersion: STROKE_TAXONOMY_V3.version,
        classifierVersion: STROKE_HEURISTIC_VERSION,
        label: "OVERHEAD",
        leaf: "OVERHEAD",
        taxonomyDepth: 1,
        confidence: clamp(0.5 + aboveShoulder / 2, 0.5, 0.85),
        evidence,
        limitingFactors,
        contactPointSource,
        contactPointReliability,
      };
    }
    if (!windowMeasured) {
      // No skeletal window data at all: the point stands alone. Claimable
      // only on strong provenance, at reduced confidence.
      if (contactPointReliability === "strong") {
        limitingFactors.push("overhead_uncorroborated_skeletal_window_unmeasured");
        return {
          taxonomyVersion: STROKE_TAXONOMY_V3.version,
          classifierVersion: STROKE_HEURISTIC_VERSION,
          label: "OVERHEAD",
          leaf: "OVERHEAD",
          taxonomyDepth: 1,
          confidence: clamp(0.5 + aboveShoulder / 2, 0.5, DEGRADED_CONFIDENCE_CAP),
          evidence,
          limitingFactors,
          contactPointSource,
          contactPointReliability,
        };
      }
      limitingFactors.push("overhead_point_degraded_and_uncorroborated_no_claim");
      return unknown(null, evidence, limitingFactors, contactPointSource, contactPointReliability);
    }
    // Window measured and quiet: repeated skeletal measurements contradict
    // the single high point. A high point that the skeleton never supports
    // is the confidently-wrong OVERHEAD pattern — do not claim it.
    limitingFactors.push("contact_point_high_but_skeleton_quiet_no_overhead_claim");
    if (contactPointReliability === "degraded") {
      // Degraded point + contradicting skeleton: nothing trustworthy left.
      return unknown(
        "contact_point_contradicted_by_skeletal_window",
        evidence,
        limitingFactors,
        contactPointSource,
        contactPointReliability,
      );
    }
    // Strong point, quiet skeleton — fall through to side classification on
    // the point; the tension is recorded above.
  } else if (windowWristRaised && windowElbowRaised) {
    // Contact point at/below shoulders but BOTH joints were repeatedly
    // measured above the shoulder line around contact.
    if (contactPointReliability === "degraded") {
      // Dev-measured failure (rally2): stale mid-body paddle box (track
      // conf 0.08) + jittered single-frame wrist vs 3 high-visibility raised
      // wrist frames + 3 raised elbow frames. Repeated high-visibility
      // skeletal evidence outweighs one low-provenance point.
      limitingFactors.push("contact_point_contradicts_overhead_but_degraded_window_wins");
      const raisedFrames = raise.wristRaisedFrames + raise.elbowRaisedFrames;
      return {
        taxonomyVersion: STROKE_TAXONOMY_V3.version,
        classifierVersion: STROKE_HEURISTIC_VERSION,
        label: "OVERHEAD",
        leaf: "OVERHEAD",
        taxonomyDepth: 1,
        confidence: clamp(0.45 + 0.05 * raisedFrames, 0.45, 0.7),
        evidence,
        limitingFactors,
        contactPointSource,
        contactPointReliability,
      };
    }
    // Strong point at mid/low body wins over the window; record the tension.
    limitingFactors.push("skeletal_raise_present_but_reliable_point_not_overhead");
  }

  evidence.push(
    `contact height: ${contactPoint.y < shoulderY ? "above" : contactPoint.y < hipY ? "between shoulders and hips" : "below hips"}`,
  );
  limitingFactors.push("bounce_not_observed_volley_vs_groundstroke_unresolved");

  // ── Level 2: side (forehand/backhand) in the player's frame ────────────
  if (input.handedness === "ambidextrous") {
    limitingFactors.push("ambidextrous_declared_side_unresolvable");
    return unknown(null, evidence, limitingFactors, contactPointSource, contactPointReliability);
  }
  // ── Gate: degenerate shoulder separation (side normalization) ─────────
  // Both the facing sign (shoulder x-order) and the offset normalization
  // base (shoulderWidth) come from the image-plane shoulder separation.
  // In a near-profile view that separation collapses to estimator-noise
  // scale and both quantities are meaningless — abstain from the side
  // decision regardless of contact-point provenance or margin.
  const rawShoulderSeparation = Math.abs(rightShoulder.x - leftShoulder.x);
  if (rawShoulderSeparation < SHOULDER_MIN_SEPARATION) {
    evidence.push(
      `image-plane shoulder separation ${rawShoulderSeparation.toFixed(3)}u at reference (floor ${SHOULDER_MIN_SEPARATION})`,
    );
    return unknown(
      "shoulder_separation_degenerate_side_decision_unreliable",
      evidence,
      limitingFactors,
      contactPointSource,
      contactPointReliability,
    );
  }
  // ── Cross-check: declared handedness vs dominant-motion wrist (3.1) ───
  // The forehand/backhand decision below assumes the paddle is in the
  // DECLARED hand. Declared handedness is context, not evidence: when the
  // measured dominant-motion wrist sits on the opposite side, the premise
  // is contradicted by measurement and the side call would be mirrored.
  const declaredWristSide: "left" | "right" = input.handedness === "right" ? "right" : "left";
  let handednessContradicted = false;
  if (wristInfo.side !== declaredWristSide) {
    evidence.push(
      `dominant-motion wrist is ${wristInfo.side} (travel ${wristInfo.travel.toFixed(3)}u over ${wristInfo.measuredFrames} frames vs rival ${wristInfo.rivalTravel.toFixed(3)}u over ${wristInfo.rivalMeasuredFrames}) — declared ${input.handedness}-handed`,
    );
    const decisive =
      wristInfo.measuredFrames >= MIN_TRAVEL_SAMPLE_FRAMES &&
      wristInfo.rivalMeasuredFrames >= MIN_TRAVEL_SAMPLE_FRAMES &&
      wristInfo.travel >= HANDEDNESS_CONTRADICTION_TRAVEL_RATIO * wristInfo.rivalTravel;
    if (decisive) {
      return unknown(
        "declared_handedness_contradicted_by_dominant_motion_wrist",
        evidence,
        limitingFactors,
        contactPointSource,
        contactPointReliability,
      );
    }
    // A non-decisive contradiction with the DECLARED wrist glimpsed in
    // fewer than MIN_TRAVEL_SAMPLE_FRAMES frames leaves the side premise
    // resting on an arm whose ownership is contradicted while the declared
    // alternative is unmeasurable: neither confirmable nor refutable.
    if (wristInfo.rivalMeasuredFrames < MIN_TRAVEL_SAMPLE_FRAMES) {
      return unknown(
        "declared_wrist_too_sparsely_measured_under_handedness_contradiction",
        evidence,
        limitingFactors,
        contactPointSource,
        contactPointReliability,
      );
    }
    handednessContradicted = true;
    limitingFactors.push("declared_handedness_unconfirmed_by_dominant_motion_wrist");
  }
  // Facing sign: rear view keeps anatomical right on image right (+1);
  // front view mirrors it (-1). Decided by multi-frame consensus over
  // ±FACING_WINDOW_MS — never by the single nearest frame alone, whose
  // x-order a transient mid-swing shoulder crossing can invert.
  const facingVotes = scanFacingWindow(frames, contactMs);
  const nearestSeparation = Math.abs(rightShoulder.x - leftShoulder.x);
  const nearestSign = rightShoulder.x >= leftShoulder.x ? 1 : -1;
  let facing: 1 | -1;
  let facingDegraded = false;
  if (facingVotes.consensus !== null) {
    facing = facingVotes.consensus;
    evidence.push(
      `${facing === 1 ? "rear-ish" : "front-ish"} view (facing consensus ${facing === 1 ? facingVotes.rear : facingVotes.front}/${facingVotes.rear + facingVotes.front} voting frames ±${FACING_WINDOW_MS}ms)`,
    );
    if (nearestSeparation >= FACING_MIN_SHOULDER_SEPARATION && nearestSign !== facing) {
      evidence.push(
        `shoulder x-order at the reference frame is inverted vs consensus (transient crossing) — consensus wins`,
      );
      limitingFactors.push("facing_sign_at_reference_overridden_by_consensus");
    }
  } else if (nearestSeparation >= FACING_MIN_SHOULDER_SEPARATION) {
    facing = nearestSign;
    evidence.push(
      `${facing === 1 ? "rear-ish" : "front-ish"} view (single-frame shoulder order — consensus unavailable: ${facingVotes.rear}/${facingVotes.front} rear/front votes, ${facingVotes.skippedSmallSeparation} near-profile frame(s) skipped)`,
    );
    limitingFactors.push("facing_consensus_unavailable_single_frame_shoulder_order");
    facingDegraded = true;
  } else {
    evidence.push(
      `shoulder separation ${nearestSeparation.toFixed(3)}u at reference (floor ${FACING_MIN_SHOULDER_SEPARATION}) and no facing consensus (${facingVotes.rear}/${facingVotes.front} rear/front votes)`,
    );
    return unknown(
      "facing_unmeasurable_no_consensus_and_degenerate_shoulder_separation",
      evidence,
      limitingFactors,
      contactPointSource,
      contactPointReliability,
    );
  }
  const offset = ((contactPoint.x - midX) / shoulderWidth) * facing;
  // offset > 0 = contact on the player's RIGHT side.
  const dominantRight = input.handedness === "right";
  const sameSide = dominantRight ? offset > 0 : offset < 0;
  const sideMargin = Math.abs(offset);
  const side = sameSide ? "FOREHAND" : "BACKHAND";
  evidence.push(
    `contact ${sideMargin.toFixed(2)} shoulder-widths ${offset > 0 ? "right" : "left"} of midline (${input.handedness}-handed → ${side.toLowerCase()})`,
  );
  if (sideMargin < SIDE_MARGIN_FLOOR) {
    limitingFactors.push("contact_too_close_to_midline_for_confident_side");
    return unknown(null, evidence, limitingFactors, contactPointSource, contactPointReliability);
  }
  // ── Contact-evidence gate (stroke-heuristic-5 port) ───────────────────
  // An event-peak reference with no plausible paddle point means NO
  // measurement ties this motion to a ball contact: the side may be read
  // from geometry, but the identity claim never earns full confidence —
  // the same degraded-trust band and cap as a low-provenance contact point.
  const contactEvidenceAbsent = referenceIsEventPeak && contactPointSource !== "paddle";
  const sideTrustDegraded = contactPointReliability === "degraded" || contactEvidenceAbsent;
  // Abstention band (stroke-heuristic-2): a low-provenance contact point
  // does not earn a low-margin side call — an honest UNKNOWN beats a
  // confidently-wrong guess under the usable-result contract.
  if (sideTrustDegraded && sideMargin < SIDE_MARGIN_DEGRADED_BAND) {
    limitingFactors.push(
      contactPointReliability === "degraded"
        ? "side_margin_within_degraded_abstention_band"
        : "side_margin_within_no_contact_evidence_abstention_band",
    );
    return unknown(null, evidence, limitingFactors, contactPointSource, contactPointReliability);
  }
  const sideConfidenceCap =
    sideTrustDegraded || handednessContradicted || facingDegraded ? DEGRADED_CONFIDENCE_CAP : 0.8;
  if (contactPointReliability === "degraded") {
    limitingFactors.push("contact_point_degraded_confidence_capped");
  }
  if (contactEvidenceAbsent) {
    limitingFactors.push("no_contact_evidence_confidence_capped");
  }
  if (facingDegraded) {
    limitingFactors.push("facing_single_frame_confidence_capped");
  }
  const sideConfidence = clamp(0.45 + sideMargin * 0.5, 0.45, sideConfidenceCap);

  // ── Level 3: intensity class (dink vs drive) ───────────────────────────
  if (!speeds) {
    limitingFactors.push("no_speed_series_for_intensity");
    return {
      taxonomyVersion: STROKE_TAXONOMY_V3.version,
      classifierVersion: STROKE_HEURISTIC_VERSION,
      label: side,
      leaf: null,
      taxonomyDepth: 2,
      confidence: sideConfidence,
      evidence,
      limitingFactors,
      contactPointSource,
      contactPointReliability,
    };
  }
  const inWindow = speeds.series.filter(
    (sample) =>
      sample.timestampMs >= input.window.startMs && sample.timestampMs <= input.window.endMs,
  );
  const peak = inWindow.reduce((best, sample) => Math.max(best, sample.value), 0);
  const lowContact = contactPoint.y > hipY - 0.35 * torso;
  const intensity = peak < 0.9 ? "slow" : peak >= 1.4 ? "fast" : "medium";
  evidence.push(
    `${speeds.source} speed peak ${peak.toFixed(2)} u/s (${intensity} swing, ${lowContact ? "low" : "mid/high"} contact)`,
  );
  // Without bounce observation, DRIVE/VOLLEY/DINK/DROP/RESET cannot be
  // separated defensibly — a fast volley is as fast as a drive. The
  // intensity stays EVIDENCE; the commitment stops at depth 2.
  limitingFactors.push("bounce_not_observed_level3_uncommitted");
  return {
    taxonomyVersion: STROKE_TAXONOMY_V3.version,
    classifierVersion: STROKE_HEURISTIC_VERSION,
    label: side,
    leaf: null,
    taxonomyDepth: 2,
    confidence: sideConfidence,
    evidence,
    limitingFactors,
    contactPointSource,
    contactPointReliability,
  };
}

function unknown(
  reason: string | null,
  evidence: string[],
  limitingFactors: string[],
  contactPointSource: "paddle" | "wrist" | null = null,
  contactPointReliability: "strong" | "degraded" | null = null,
): HeuristicStrokePrediction {
  if (reason) limitingFactors.push(reason);
  return {
    taxonomyVersion: STROKE_TAXONOMY_V3.version,
    classifierVersion: STROKE_HEURISTIC_VERSION,
    label: "UNKNOWN",
    leaf: "UNKNOWN",
    taxonomyDepth: 1,
    confidence: 0.2,
    evidence,
    limitingFactors,
    contactPointSource,
    contactPointReliability,
  };
}

/** Median torso extent (hip line minus shoulder line) over all frames where
 * all four torso joints are present; null below TORSO_MEDIAN_MIN_FRAMES. */
function medianTorsoExtent(frames: ReturnType<typeof toLegacyPoseFrames>): number | null {
  const extents: number[] = [];
  for (const frame of frames) {
    const find = (name: string) => frame.landmarks.find((landmark) => landmark.name === name);
    const leftShoulder = find("left_shoulder");
    const rightShoulder = find("right_shoulder");
    const leftHip = find("left_hip");
    const rightHip = find("right_hip");
    if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) continue;
    extents.push((leftHip.y + rightHip.y) / 2 - (leftShoulder.y + rightShoulder.y) / 2);
  }
  if (extents.length < TORSO_MEDIAN_MIN_FRAMES) return null;
  extents.sort((a, b) => a - b);
  return extents[Math.floor(extents.length / 2)] ?? null;
}

/** Shoulder x-order votes across ±FACING_WINDOW_MS of the reference.
 * Frames vote rear (+1) when the right shoulder sits at image-right of the
 * left, front (-1) otherwise; frames whose image-plane shoulder separation
 * is below FACING_MIN_SHOULDER_SEPARATION are near-profile — their x-order
 * is noise-scale — and are skipped. A consensus exists when ≥FACING_MIN_VOTES
 * frames voted and one sign holds ≥FACING_CONSENSUS_MIN_RATIO of the votes. */
function scanFacingWindow(
  frames: ReturnType<typeof toLegacyPoseFrames>,
  contactMs: number,
): { consensus: 1 | -1 | null; rear: number; front: number; skippedSmallSeparation: number } {
  let rear = 0;
  let front = 0;
  let skippedSmallSeparation = 0;
  for (const frame of frames) {
    if (Math.abs(frame.timestampMs - contactMs) > FACING_WINDOW_MS) continue;
    const find = (name: string) => frame.landmarks.find((landmark) => landmark.name === name);
    const leftShoulder = find("left_shoulder");
    const rightShoulder = find("right_shoulder");
    if (!leftShoulder || !rightShoulder) continue;
    if (Math.abs(rightShoulder.x - leftShoulder.x) < FACING_MIN_SHOULDER_SEPARATION) {
      skippedSmallSeparation += 1;
      continue;
    }
    if (rightShoulder.x >= leftShoulder.x) rear += 1;
    else front += 1;
  }
  const total = rear + front;
  let consensus: 1 | -1 | null = null;
  if (total >= FACING_MIN_VOTES) {
    if (rear / total >= FACING_CONSENSUS_MIN_RATIO) consensus = 1;
    else if (front / total >= FACING_CONSENSUS_MIN_RATIO) consensus = -1;
  }
  return { consensus, rear, front, skippedSmallSeparation };
}

function nearestFrame(frames: ReturnType<typeof toLegacyPoseFrames>, timestampMs: number) {
  let best: (typeof frames)[number] | null = null;
  let bestDelta = Infinity;
  for (const frame of frames) {
    const delta = Math.abs(frame.timestampMs - timestampMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = frame;
    }
  }
  return best && bestDelta <= 80 ? best : null;
}

/** The wrist that moved more around contact (±200ms), with its side,
 * visibility at the nearest frame, total path length, and how many nearby
 * frames actually measured it — so both provenance and MOTION can be
 * judged (stroke-heuristic-3 uses travel for the non-swing gate). */
function dominantWristInfo(
  frames: ReturnType<typeof toLegacyPoseFrames>,
  contactMs: number,
): {
  side: "left" | "right";
  point: { x: number; y: number } | null;
  visibility: number;
  travel: number;
  measuredFrames: number;
  rivalTravel: number;
  rivalMeasuredFrames: number;
} {
  const nearby = frames.filter((frame) => Math.abs(frame.timestampMs - contactMs) <= 200);
  const travel = { left: 0, right: 0 };
  const measured = { left: 0, right: 0 };
  const previous: { left?: { x: number; y: number }; right?: { x: number; y: number } } = {};
  for (const frame of nearby) {
    for (const sideName of ["left", "right"] as const) {
      const mark = frame.landmarks.find(
        (landmark) => landmark.name === `${sideName}_wrist` && landmark.visibility >= 0.25,
      );
      if (!mark) continue;
      measured[sideName] += 1;
      const prior = previous[sideName];
      if (prior) travel[sideName] += Math.hypot(mark.x - prior.x, mark.y - prior.y);
      previous[sideName] = { x: mark.x, y: mark.y };
    }
  }
  const chosen = travel.right >= travel.left ? "right" : "left";
  const frame = nearestFrame(frames, contactMs);
  const mark = frame?.landmarks.find(
    (landmark) => landmark.name === `${chosen}_wrist` && landmark.visibility >= 0.25,
  );
  const rival = chosen === "right" ? "left" : "right";
  return {
    side: chosen,
    point: mark ? { x: mark.x, y: mark.y } : null,
    visibility: mark?.visibility ?? 0,
    travel: travel[chosen],
    measuredFrames: measured[chosen],
    rivalTravel: travel[rival],
    rivalMeasuredFrames: measured[rival],
  };
}

/**
 * Paired two-wrist motion statistics across ±200ms of the reference, for
 * the symmetric-bimanual gate (v3.1). Only consecutive-frame steps where
 * BOTH wrists are measured (visibility ≥ 0.25) in both frames count —
 * absence of measurement never contributes. A step is "moving" when either
 * wrist displaces ≥ BIMANUAL_STEP_MOTION_FLOOR, and "synchronized" when
 * both vertical displacements share a sign and the step magnitudes are
 * within 2× of each other. rivalTravel is the NON-dominant wrist's path
 * length over the same paired steps; meanSeparation is the mean inter-wrist
 * distance.
 */
function bimanualMotionInfo(
  frames: ReturnType<typeof toLegacyPoseFrames>,
  contactMs: number,
): {
  pairedSteps: number;
  movingSteps: number;
  synchronizedSteps: number;
  rivalTravel: number;
  meanSeparation: number;
} {
  const nearby = frames.filter((frame) => Math.abs(frame.timestampMs - contactMs) <= 200);
  const travel = { left: 0, right: 0 };
  let pairedSteps = 0;
  let movingSteps = 0;
  let synchronizedSteps = 0;
  let separationSum = 0;
  let separationSamples = 0;
  let prior: { left: { x: number; y: number }; right: { x: number; y: number } } | null = null;
  for (const frame of nearby) {
    const left = frame.landmarks.find(
      (landmark) => landmark.name === "left_wrist" && landmark.visibility >= 0.25,
    );
    const right = frame.landmarks.find(
      (landmark) => landmark.name === "right_wrist" && landmark.visibility >= 0.25,
    );
    if (!left || !right) {
      prior = null;
      continue;
    }
    separationSum += Math.hypot(right.x - left.x, right.y - left.y);
    separationSamples += 1;
    if (prior) {
      pairedSteps += 1;
      const dL = { x: left.x - prior.left.x, y: left.y - prior.left.y };
      const dR = { x: right.x - prior.right.x, y: right.y - prior.right.y };
      const magL = Math.hypot(dL.x, dL.y);
      const magR = Math.hypot(dR.x, dR.y);
      travel.left += magL;
      travel.right += magR;
      if (Math.max(magL, magR) >= BIMANUAL_STEP_MOTION_FLOOR) {
        movingSteps += 1;
        const verticalAgree = dL.y * dR.y > 0;
        const similarMagnitude = Math.min(magL, magR) * 2 >= Math.max(magL, magR);
        if (verticalAgree && similarMagnitude) synchronizedSteps += 1;
      }
    }
    prior = { left: { x: left.x, y: left.y }, right: { x: right.x, y: right.y } };
  }
  const rivalTravel = Math.min(travel.left, travel.right);
  return {
    pairedSteps,
    movingSteps,
    synchronizedSteps,
    rivalTravel,
    meanSeparation: separationSamples > 0 ? separationSum / separationSamples : 0,
  };
}

/**
 * Dominant-arm length (|shoulder→elbow| + |elbow→wrist|) as the median over
 * frames within ±300ms of contact where all three joints are measured at
 * visibility ≥ 0.5. Null when fewer than 3 such frames exist (falls back to
 * torso units at the call site).
 */
function estimateArmLength(
  frames: ReturnType<typeof toLegacyPoseFrames>,
  contactMs: number,
  side: "left" | "right",
): number | null {
  const lengths: number[] = [];
  for (const frame of frames) {
    if (Math.abs(frame.timestampMs - contactMs) > 300) continue;
    const find = (name: string) =>
      frame.landmarks.find(
        (landmark) => landmark.name === name && landmark.visibility >= WRIST_RELIABLE_VISIBILITY,
      );
    const shoulder = find(`${side}_shoulder`);
    const elbow = find(`${side}_elbow`);
    const wrist = find(`${side}_wrist`);
    if (!shoulder || !elbow || !wrist) continue;
    lengths.push(
      Math.hypot(shoulder.x - elbow.x, shoulder.y - elbow.y) +
        Math.hypot(elbow.x - wrist.x, elbow.y - wrist.y),
    );
  }
  if (lengths.length < 3) return null;
  lengths.sort((a, b) => a - b);
  return lengths[Math.floor(lengths.length / 2)] ?? null;
}

/**
 * Raise evidence for the dominant wrist/elbow relative to the per-frame
 * shoulder line across ±OVERHEAD_WINDOW_MS of contact (visibility-gated at
 * 0.5 — only well-measured frames count). Frames whose own torso extent is
 * degenerate are skipped: they cannot support a normalized raise claim.
 * Also computes the ±80ms visibility-gated median, recorded as evidence: on
 * the dev overhead that slice holds a single post-contact frame (the arm
 * has already dropped), so the DECISION uses the raised-frame counts over
 * the wider window.
 */
function scanRaiseWindow(
  frames: ReturnType<typeof toLegacyPoseFrames>,
  contactMs: number,
  side: "left" | "right",
): {
  wristMeasuredFrames: number;
  wristRaisedFrames: number;
  maxWristRaise: number | null;
  elbowMeasuredFrames: number;
  elbowRaisedFrames: number;
  wristMeasuredFrames80: number;
  medianWristRaise80: number | null;
} {
  let wristMeasuredFrames = 0;
  let wristRaisedFrames = 0;
  let maxWristRaise: number | null = null;
  let elbowMeasuredFrames = 0;
  let elbowRaisedFrames = 0;
  const raises80: number[] = [];
  for (const frame of frames) {
    const delta = Math.abs(frame.timestampMs - contactMs);
    if (delta > OVERHEAD_WINDOW_MS) continue;
    const find = (name: string, minVisibility: number) =>
      frame.landmarks.find(
        (landmark) => landmark.name === name && landmark.visibility >= minVisibility,
      );
    const leftShoulder = find("left_shoulder", 0);
    const rightShoulder = find("right_shoulder", 0);
    const leftHip = find("left_hip", 0);
    const rightHip = find("right_hip", 0);
    if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) continue;
    const shoulderY = (leftShoulder.y + rightShoulder.y) / 2;
    const torsoExtent = (leftHip.y + rightHip.y) / 2 - shoulderY;
    if (torsoExtent < TORSO_MIN_EXTENT) continue;
    const torso = torsoExtent;
    const wrist = find(`${side}_wrist`, WRIST_RELIABLE_VISIBILITY);
    if (wrist) {
      const raiseAmount = (shoulderY - wrist.y) / torso;
      wristMeasuredFrames += 1;
      if (raiseAmount >= OVERHEAD_WRIST_RAISE_TORSO) wristRaisedFrames += 1;
      if (maxWristRaise === null || raiseAmount > maxWristRaise) maxWristRaise = raiseAmount;
      if (delta <= OVERHEAD_MEDIAN_WINDOW_MS) raises80.push(raiseAmount);
    }
    const elbow = find(`${side}_elbow`, WRIST_RELIABLE_VISIBILITY);
    if (elbow) {
      elbowMeasuredFrames += 1;
      if ((shoulderY - elbow.y) / torso >= OVERHEAD_ELBOW_RAISE_TORSO) elbowRaisedFrames += 1;
    }
  }
  raises80.sort((a, b) => a - b);
  const medianWristRaise80 =
    raises80.length === 0
      ? null
      : raises80.length % 2 === 1
        ? raises80[(raises80.length - 1) / 2]!
        : (raises80[raises80.length / 2 - 1]! + raises80[raises80.length / 2]!) / 2;
  return {
    wristMeasuredFrames,
    wristRaisedFrames,
    maxWristRaise,
    elbowMeasuredFrames,
    elbowRaisedFrames,
    wristMeasuredFrames80: raises80.length,
    medianWristRaise80,
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}
