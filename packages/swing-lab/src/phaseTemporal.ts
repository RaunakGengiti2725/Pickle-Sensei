/**
 * phase.paddle-temporal.v1 — real-video phase segmentation built on measured
 * paddle kinematics with a wrist fallback, contact-anchored when a contact
 * estimate exists.
 *
 * The frozen phase.geometry.v1 (synthetic-tuned wrist geometry) measured
 * 870–1280ms median boundary error on real labels; the paddle-speed signal
 * measured 20–162ms. This module productizes that finding:
 *
 *   ACCELERATION start — last sustained sub-threshold (25% of peak) speed
 *                        sample walking BACK from the anchor
 *   CONTACT           — the multimodal contact estimate when available,
 *                       else the speed peak (confidence reduced)
 *   FOLLOW_THROUGH end— first sustained sub-threshold sample AFTER anchor
 *   PREPARATION start — last sustained near-rest (10% of peak) before
 *                       acceleration
 *   RECOVERY end      — first sustained near-rest (15%) after follow-through
 *
 * Missing-paddle policy: with paddle coverage < 40% of the window the wrist
 * series substitutes at reduced confidence; if neither covers the window,
 * exact boundaries are ABSTAINED rather than guessed.
 */

export const PHASE_TEMPORAL_VERSION = "phase.paddle-temporal.v1 (heuristic, uncalibrated)";

export interface TemporalPhaseBoundaries {
  version: string;
  source: "paddle" | "wrist";
  anchor: "contact_estimate" | "speed_peak";
  /**
   * ADDITIVE (W5): what the timeline is anchored on.
   *   - ABSENT            → legacy anchored output (byte-stable with pre-W5
   *                         artifacts); the `anchor` field already carries
   *                         "contact_estimate".
   *   - "event_peak"      → anchor-free mode: segmented around the measured
   *                         kinematic peak of the selected stroke event; NO
   *                         contact boundary exists. UIs must label such a
   *                         timeline "from motion evidence; exact contact not
   *                         established".
   *   - "contact_estimate"→ reserved for future explicit emission on anchored
   *                         outputs (not emitted today to preserve byte
   *                         identity of anchored artifacts).
   */
  anchorBasis?: "contact_estimate" | "event_peak";
  confidence: number;
  preparationStartMs: number | null;
  accelerationStartMs: number;
  /**
   * Contact boundary. In anchor-free mode (anchorBasis === "event_peak") NO
   * contact is established: the in-process value is Number.NaN — the type
   * stays `number` because frozen consumers (report.ts renderReport) do
   * arithmetic on it — and JSON serialization turns NaN into null, so every
   * artifact consumer (cascadeWaterfall ordering check, strokeBench D-rows,
   * report.json readers) sees `"contactMs": null`, i.e. the contact boundary
   * is explicitly ABSENT. Consumers must gate on
   * `anchorBasis === "event_peak"` / `Number.isFinite(contactMs)` in-process.
   */
  contactMs: number;
  /** ADDITIVE (W5): measured kinematic apex; emitted in anchor-free mode. */
  motionPeakMs?: number;
  followThroughEndMs: number;
  recoveryEndMs: number | null;
  /**
   * Anchor-relative copies for research use: t=0 at contact when anchored,
   * t=0 at the measured motion peak in anchor-free mode.
   */
  relative: {
    preparationStartMs: number | null;
    accelerationStartMs: number;
    followThroughEndMs: number;
    recoveryEndMs: number | null;
  };
}

export type TemporalPhaseOutcome =
  | { status: "segmented"; boundaries: TemporalPhaseBoundaries }
  | { status: "abstained"; reason: string };

export function segmentPhasesTemporal(input: {
  window: { startMs: number; endMs: number };
  contactMs: number | null;
  paddleSpeeds: ReadonlyArray<{ timestampMs: number; value: number }> | null;
  wristSpeeds: ReadonlyArray<{ timestampMs: number; value: number }> | null;
}): TemporalPhaseOutcome {
  const windowLength = Math.max(1, input.window.endMs - input.window.startMs);
  const coverage = (series: ReadonlyArray<{ timestampMs: number }> | null): number => {
    if (!series || series.length < 2) return 0;
    const inWindow = series.filter(
      (sample) =>
        sample.timestampMs >= input.window.startMs && sample.timestampMs <= input.window.endMs,
    );
    if (inWindow.length < 2) return 0;
    return (inWindow[inWindow.length - 1]!.timestampMs - inWindow[0]!.timestampMs) / windowLength;
  };
  const paddleCoverage = coverage(input.paddleSpeeds);
  const wristCoverage = coverage(input.wristSpeeds);
  let source: "paddle" | "wrist";
  let series: ReadonlyArray<{ timestampMs: number; value: number }>;
  let confidence: number;
  if (paddleCoverage >= 0.4 && input.paddleSpeeds) {
    source = "paddle";
    series = input.paddleSpeeds;
    confidence = 0.6;
  } else if (wristCoverage >= 0.5 && input.wristSpeeds) {
    source = "wrist";
    series = input.wristSpeeds;
    confidence = 0.4; // wrist is a proxy for the hitting system, not the paddle
  } else {
    return {
      status: "abstained",
      reason: `insufficient kinematic coverage (paddle ${(paddleCoverage * 100).toFixed(0)}%, wrist ${(wristCoverage * 100).toFixed(0)}%)`,
    };
  }

  const inWindow = series
    .filter(
      (sample) =>
        sample.timestampMs >= input.window.startMs - 400 &&
        sample.timestampMs <= input.window.endMs + 400,
    )
    .sort((a, b) => a.timestampMs - b.timestampMs);
  if (inWindow.length < 6) {
    return { status: "abstained", reason: "too few kinematic samples" };
  }

  // Anchor: contact estimate when available; else the peak nearest contactMs
  // would be circular, so use the global in-window peak.
  let anchor: "contact_estimate" | "speed_peak";
  let anchorMs: number;
  if (input.contactMs !== null) {
    anchor = "contact_estimate";
    anchorMs = input.contactMs;
  } else {
    anchor = "speed_peak";
    anchorMs = inWindow.reduce((best, sample) =>
      sample.value > best.value ? sample : best,
    ).timestampMs;
    confidence *= 0.8;
  }
  const peakValue = inWindow.reduce((best, sample) => Math.max(best, sample.value), 0);
  if (peakValue < 0.4) {
    return { status: "abstained", reason: "no meaningful swing speed in window" };
  }
  const accelThreshold = 0.25 * peakValue;
  const restThreshold = 0.1 * peakValue;
  const recoverThreshold = 0.15 * peakValue;
  const sustained = (index: number, threshold: number, direction: -1 | 1): boolean => {
    const neighbor = inWindow[index + direction];
    return neighbor !== undefined ? neighbor.value < threshold : true;
  };

  const anchorIndex = nearestIndex(inWindow, anchorMs);
  let accelerationStartMs = inWindow[Math.max(0, anchorIndex)]!.timestampMs;
  for (let index = anchorIndex; index >= 0; index -= 1) {
    if (inWindow[index]!.value < accelThreshold && sustained(index, accelThreshold, -1)) break;
    accelerationStartMs = inWindow[index]!.timestampMs;
  }
  let followThroughEndMs = inWindow[Math.min(inWindow.length - 1, anchorIndex)]!.timestampMs;
  for (let index = anchorIndex; index < inWindow.length; index += 1) {
    if (inWindow[index]!.value < accelThreshold && sustained(index, accelThreshold, 1)) break;
    followThroughEndMs = inWindow[index]!.timestampMs;
  }
  // ORDERING INVARIANT (cascade-measured defect: followEnd ≤ contact when the
  // nearest sample sits before a sparse post-contact gap). Follow-through must
  // END after contact; the first real observation after the anchor is the
  // minimum honest bound. No post-contact samples at all → abstain, never
  // emit an inverted timeline.
  if (followThroughEndMs <= anchorMs) {
    const firstAfterAnchor = inWindow.find((sample) => sample.timestampMs > anchorMs);
    if (!firstAfterAnchor) {
      return {
        status: "abstained",
        reason:
          "PHASE_NO_POST_CONTACT_EVIDENCE: no kinematic samples after the contact anchor inside the event",
      };
    }
    followThroughEndMs = firstAfterAnchor.timestampMs;
  }
  // ORDERING INVARIANT (held-out one-shot defect, 2026-08-28: accel landed
  // 10ms AFTER the contact anchor when the nearest-to-anchor sample sits past
  // a sparse pre-contact gap — an impossible timeline). Acceleration must
  // START at or before contact; the last real observation at/before the
  // anchor is the maximum honest bound. No pre-contact samples at all →
  // abstain, never emit an inverted timeline. Mirror of the followEnd repair.
  if (accelerationStartMs > anchorMs) {
    const lastBeforeAnchor = [...inWindow]
      .reverse()
      .find((sample) => sample.timestampMs <= anchorMs);
    if (!lastBeforeAnchor) {
      return {
        status: "abstained",
        reason:
          "PHASE_NO_PRE_CONTACT_EVIDENCE: no kinematic samples before the contact anchor inside the event",
      };
    }
    accelerationStartMs = lastBeforeAnchor.timestampMs;
  }
  let preparationStartMs: number | null = null;
  for (let index = nearestIndex(inWindow, accelerationStartMs) - 1; index >= 0; index -= 1) {
    if (inWindow[index]!.value < restThreshold && sustained(index, restThreshold, -1)) {
      preparationStartMs = inWindow[index]!.timestampMs;
      break;
    }
  }
  let recoveryEndMs: number | null = null;
  for (
    let index = nearestIndex(inWindow, followThroughEndMs) + 1;
    index < inWindow.length;
    index += 1
  ) {
    if (inWindow[index]!.value < recoverThreshold && sustained(index, recoverThreshold, 1)) {
      recoveryEndMs = inWindow[index]!.timestampMs;
      break;
    }
  }

  return {
    status: "segmented",
    boundaries: {
      version: PHASE_TEMPORAL_VERSION,
      source,
      anchor,
      confidence,
      preparationStartMs,
      accelerationStartMs,
      contactMs: anchorMs,
      followThroughEndMs,
      recoveryEndMs,
      relative: {
        preparationStartMs: preparationStartMs !== null ? preparationStartMs - anchorMs : null,
        accelerationStartMs: accelerationStartMs - anchorMs,
        followThroughEndMs: followThroughEndMs - anchorMs,
        recoveryEndMs: recoveryEndMs !== null ? recoveryEndMs - anchorMs : null,
      },
    },
  };
}

export const PHASE_TEMPORAL_V2_VERSION =
  "phase.paddle-temporal.v2 (event-local, anchor-or-abstain; heuristic, uncalibrated)";

/**
 * Version stamped ONLY on anchor-free outputs, so an artifact reader can tell
 * the two timeline kinds apart without inspecting boundary fields. The phrase
 * "exact contact not established" is embedded verbatim for honest UI labeling.
 */
export const PHASE_TEMPORAL_V2_ANCHOR_FREE_VERSION =
  "phase.paddle-temporal.v2.1 (event-local, anchor-free around measured motion peak; timeline from motion evidence — exact contact not established; heuristic, uncalibrated)";

/**
 * v2 principles (learned from v1's measured failure modes):
 * - EVENT-LOCAL: the kinematic series is sliced to ONE stroke event, so a
 *   neighboring swing can never supply the anchor (v1's >2s failures).
 * - ANCHORED WHEN POSSIBLE: a contact estimate inside the event anchors the
 *   timeline exactly as before — that path is byte-identical to pre-W5
 *   output (regression-pinned in test/phaseTemporal.test.ts).
 * - ANCHOR-FREE OTHERWISE (W5): with NO contact estimate but a decisive
 *   measured kinematic peak inside the event, segment
 *   preparation → acceleration → motion-peak → deceleration/follow-through →
 *   recovery around that peak and emit NO contact boundary
 *   (contactMs = NaN in-process ⇒ null in JSON; anchorBasis = "event_peak").
 *   This replaces the former blanket PHASE_CONTACT_ANCHOR_MISSING abstention
 *   that made honest-abstain timelines (usable-result-v1 clause c)
 *   structurally unreachable.
 * - NOT A FREE PASS: weak / short / noisy / edge-peaked series still abstain,
 *   with precise reasons (PHASE_NO_MOTION_EVIDENCE, PHASE_PEAK_NOT_PROMINENT,
 *   PHASE_PEAK_OUTSIDE_EVENT, PHASE_NO_PRE/POST_PEAK_EVIDENCE,
 *   PHASE_PEAK_MISMATCH). Anchor-free gates are STRICTER than anchored ones
 *   because the peak itself must carry the whole timeline.
 * - Wrist fallback only for the SERIES (reduced confidence), never for the
 *   anchor.
 */
export function segmentPhasesTemporalV2(input: {
  /** peakMs is optional (additive): when the caller passes the selected
   *  event's kinematic peak it is cross-checked against the measured peak in
   *  anchor-free mode; wild disagreement abstains (PHASE_PEAK_MISMATCH). */
  event: { startMs: number; endMs: number; peakMs?: number };
  contactMs: number | null;
  paddleSpeeds: ReadonlyArray<{ timestampMs: number; value: number }> | null;
  wristSpeeds: ReadonlyArray<{ timestampMs: number; value: number }> | null;
}): TemporalPhaseOutcome {
  if (input.contactMs === null) {
    return segmentPhasesAnchorFree(input);
  }
  if (input.contactMs < input.event.startMs - 120 || input.contactMs > input.event.endMs + 120) {
    return {
      status: "abstained",
      reason: "PHASE_WRONG_EVENT: contact estimate lies outside the target event",
    };
  }
  const pad = 300;
  const slice = (
    series: ReadonlyArray<{ timestampMs: number; value: number }> | null,
  ): Array<{ timestampMs: number; value: number }> =>
    (series ?? []).filter(
      (sample) =>
        sample.timestampMs >= input.event.startMs - pad &&
        sample.timestampMs <= input.event.endMs + pad,
    );
  const paddleLocal = slice(input.paddleSpeeds);
  const wristLocal = slice(input.wristSpeeds);
  const eventLength = Math.max(1, input.event.endMs - input.event.startMs);
  const localCoverage = (series: Array<{ timestampMs: number }>): number =>
    series.length >= 2
      ? (series[series.length - 1]!.timestampMs - series[0]!.timestampMs) / eventLength
      : 0;
  let source: "paddle" | "wrist";
  let series: Array<{ timestampMs: number; value: number }>;
  let confidence: number;
  if (localCoverage(paddleLocal) >= 0.5) {
    source = "paddle";
    series = paddleLocal;
    confidence = 0.65;
  } else if (localCoverage(wristLocal) >= 0.6) {
    source = "wrist";
    series = wristLocal;
    confidence = 0.4;
  } else {
    return {
      status: "abstained",
      reason: "insufficient event-local kinematic coverage (paddle and wrist)",
    };
  }
  const result = segmentPhasesTemporal({
    window: input.event,
    contactMs: input.contactMs,
    paddleSpeeds: source === "paddle" ? series : null,
    wristSpeeds: source === "wrist" ? series : null,
  });
  if (result.status !== "segmented") return result;
  return {
    status: "segmented",
    boundaries: {
      ...result.boundaries,
      version: PHASE_TEMPORAL_V2_VERSION,
      confidence,
    },
  };
}

/**
 * ANCHOR-FREE segmentation (W5) — no contact estimate inside the event.
 *
 * The measured kinematic peak substitutes for the anchor, so the evidence
 * gates are deliberately STRICTER than the anchored path (which leans on an
 * independently-confirmed contact):
 *
 *   coverage        same series-quality gates as anchored (paddle ≥ 0.5,
 *                   wrist ≥ 0.6 of the event span)
 *   sample count    ≥ 8 samples in the padded event (anchored path: 6)
 *   peak strength   in-event peak ≥ 0.5 (anchored path: 0.4)
 *   peak prominence in-event peak ≥ 2× the median of the local series — a
 *                   flat/noisy series has no measurable apex and abstains
 *   apex ownership  the event must OWN its apex: a strictly larger sample in
 *                   the ±pad margin means the swing apex lies outside the
 *                   event (rising edge / neighboring swing) — abstain
 *   two-sided       ≥ 2 samples strictly before AND after the peak, and the
 *                   walked boundaries must straddle it (a timeline with no
 *                   measured acceleration or deceleration is not emitted)
 *   peak agreement  if the caller supplied the event's own peakMs, the
 *                   measured peak must agree within 250ms (~7–8 frames @30fps)
 *
 * All thresholds are heuristic and uncalibrated, like the rest of the module.
 * Emitted boundaries: preparation → acceleration → motion-peak →
 * deceleration/follow-through → recovery, with contactMs = NaN (⇒ null in
 * JSON: the contact boundary is explicitly ABSENT), anchorBasis =
 * "event_peak", anchor = "speed_peak" (legacy vocabulary), and confidence
 * reduced by the same ×0.8 anchor-free penalty v1 applied to its speed-peak
 * fallback.
 */
function segmentPhasesAnchorFree(input: {
  event: { startMs: number; endMs: number; peakMs?: number };
  paddleSpeeds: ReadonlyArray<{ timestampMs: number; value: number }> | null;
  wristSpeeds: ReadonlyArray<{ timestampMs: number; value: number }> | null;
}): TemporalPhaseOutcome {
  const pad = 300;
  const slice = (
    series: ReadonlyArray<{ timestampMs: number; value: number }> | null,
  ): Array<{ timestampMs: number; value: number }> =>
    (series ?? [])
      .filter(
        (sample) =>
          sample.timestampMs >= input.event.startMs - pad &&
          sample.timestampMs <= input.event.endMs + pad,
      )
      .sort((a, b) => a.timestampMs - b.timestampMs);
  const paddleLocal = slice(input.paddleSpeeds);
  const wristLocal = slice(input.wristSpeeds);
  const eventLength = Math.max(1, input.event.endMs - input.event.startMs);
  const localCoverage = (series: Array<{ timestampMs: number }>): number =>
    series.length >= 2
      ? (series[series.length - 1]!.timestampMs - series[0]!.timestampMs) / eventLength
      : 0;
  let source: "paddle" | "wrist";
  let series: Array<{ timestampMs: number; value: number }>;
  let confidence: number;
  if (localCoverage(paddleLocal) >= 0.5) {
    source = "paddle";
    series = paddleLocal;
    confidence = 0.52; // 0.65 anchored-paddle × 0.8 anchor-free penalty
  } else if (localCoverage(wristLocal) >= 0.6) {
    source = "wrist";
    series = wristLocal;
    confidence = 0.32; // 0.4 anchored-wrist × 0.8 anchor-free penalty
  } else {
    return {
      status: "abstained",
      reason:
        "PHASE_INSUFFICIENT_COVERAGE: insufficient event-local kinematic coverage (paddle and wrist) — anchor-free mode requires the same series quality as anchored",
    };
  }

  if (series.length < 8) {
    return {
      status: "abstained",
      reason: `PHASE_NO_MOTION_EVIDENCE: only ${series.length} kinematic samples inside the event (anchor-free mode needs ≥ 8)`,
    };
  }
  const inEvent = series.filter(
    (sample) =>
      sample.timestampMs >= input.event.startMs && sample.timestampMs <= input.event.endMs,
  );
  if (inEvent.length < 4) {
    return {
      status: "abstained",
      reason: `PHASE_NO_MOTION_EVIDENCE: only ${inEvent.length} kinematic samples strictly inside the event`,
    };
  }
  const peakSample = inEvent.reduce((best, sample) => (sample.value > best.value ? sample : best));
  if (peakSample.value < 0.5) {
    return {
      status: "abstained",
      reason: `PHASE_NO_MOTION_EVIDENCE: in-event peak speed ${peakSample.value.toFixed(2)} below the anchor-free floor (0.5)`,
    };
  }
  const sortedValues = series.map((sample) => sample.value).sort((a, b) => a - b);
  const medianValue = sortedValues[Math.floor(sortedValues.length / 2)]!;
  if (medianValue > 0 && peakSample.value < 2 * medianValue) {
    return {
      status: "abstained",
      reason: `PHASE_PEAK_NOT_PROMINENT: in-event peak ${peakSample.value.toFixed(2)} is not decisive vs the local median ${medianValue.toFixed(2)} (needs ≥ 2×) — no measurable swing apex without an anchor`,
    };
  }
  const padMax = series.reduce((best, sample) => Math.max(best, sample.value), 0);
  if (padMax > peakSample.value) {
    return {
      status: "abstained",
      reason:
        "PHASE_PEAK_OUTSIDE_EVENT: a stronger kinematic peak sits in the margin just outside the event — the event does not own its swing apex",
    };
  }
  if (
    input.event.peakMs !== undefined &&
    Math.abs(peakSample.timestampMs - input.event.peakMs) > 250
  ) {
    return {
      status: "abstained",
      reason: `PHASE_PEAK_MISMATCH: measured kinematic peak ${Math.round(peakSample.timestampMs)}ms disagrees with the event's own peak ${Math.round(input.event.peakMs)}ms by more than 250ms`,
    };
  }
  const peakIndex = series.indexOf(peakSample);
  if (peakIndex < 2) {
    return {
      status: "abstained",
      reason:
        "PHASE_NO_PRE_PEAK_EVIDENCE: fewer than 2 kinematic samples before the motion peak — acceleration cannot be measured",
    };
  }
  if (peakIndex > series.length - 3) {
    return {
      status: "abstained",
      reason:
        "PHASE_NO_POST_PEAK_EVIDENCE: fewer than 2 kinematic samples after the motion peak — deceleration/follow-through cannot be measured",
    };
  }

  // Same threshold-walking recipe as the anchored path (25% / 10% / 15% of
  // peak with the sustained-neighbor check), around the measured peak.
  const peakMs = peakSample.timestampMs;
  const accelThreshold = 0.25 * peakSample.value;
  const restThreshold = 0.1 * peakSample.value;
  const recoverThreshold = 0.15 * peakSample.value;
  const sustained = (index: number, threshold: number, direction: -1 | 1): boolean => {
    const neighbor = series[index + direction];
    return neighbor !== undefined ? neighbor.value < threshold : true;
  };
  let accelerationStartMs = peakMs;
  for (let index = peakIndex; index >= 0; index -= 1) {
    if (series[index]!.value < accelThreshold && sustained(index, accelThreshold, -1)) break;
    accelerationStartMs = series[index]!.timestampMs;
  }
  let followThroughEndMs = peakMs;
  for (let index = peakIndex; index < series.length; index += 1) {
    if (series[index]!.value < accelThreshold && sustained(index, accelThreshold, 1)) break;
    followThroughEndMs = series[index]!.timestampMs;
  }
  // ORDERING INVARIANT: the timeline must straddle the peak. The first real
  // observation on the far side is the minimum honest bound (mirror of the
  // anchored repair); by the two-sided gates above such samples exist.
  if (accelerationStartMs >= peakMs) {
    accelerationStartMs = series[peakIndex - 1]!.timestampMs;
  }
  if (followThroughEndMs <= peakMs) {
    followThroughEndMs = series[peakIndex + 1]!.timestampMs;
  }
  let preparationStartMs: number | null = null;
  for (let index = nearestIndex(series, accelerationStartMs) - 1; index >= 0; index -= 1) {
    if (series[index]!.value < restThreshold && sustained(index, restThreshold, -1)) {
      preparationStartMs = series[index]!.timestampMs;
      break;
    }
  }
  let recoveryEndMs: number | null = null;
  for (
    let index = nearestIndex(series, followThroughEndMs) + 1;
    index < series.length;
    index += 1
  ) {
    if (series[index]!.value < recoverThreshold && sustained(index, recoverThreshold, 1)) {
      recoveryEndMs = series[index]!.timestampMs;
      break;
    }
  }

  // MONOTONICITY (belt & braces — unreachable by construction): never emit a
  // disordered timeline.
  const ordered =
    (preparationStartMs === null || preparationStartMs <= accelerationStartMs) &&
    accelerationStartMs < peakMs &&
    peakMs < followThroughEndMs &&
    (recoveryEndMs === null || followThroughEndMs <= recoveryEndMs);
  if (!ordered) {
    return {
      status: "abstained",
      reason:
        "PHASE_DISORDERED_BOUNDARIES: anchor-free boundaries failed the monotonic ordering invariant",
    };
  }

  return {
    status: "segmented",
    boundaries: {
      version: PHASE_TEMPORAL_V2_ANCHOR_FREE_VERSION,
      source,
      anchor: "speed_peak",
      anchorBasis: "event_peak",
      confidence,
      preparationStartMs,
      accelerationStartMs,
      // Explicitly ABSENT contact boundary: NaN in-process, null in JSON.
      contactMs: Number.NaN,
      motionPeakMs: peakMs,
      followThroughEndMs,
      recoveryEndMs,
      relative: {
        preparationStartMs: preparationStartMs !== null ? preparationStartMs - peakMs : null,
        accelerationStartMs: accelerationStartMs - peakMs,
        followThroughEndMs: followThroughEndMs - peakMs,
        recoveryEndMs: recoveryEndMs !== null ? recoveryEndMs - peakMs : null,
      },
    },
  };
}

function nearestIndex(series: ReadonlyArray<{ timestampMs: number }>, tMs: number): number {
  let best = 0;
  let bestDelta = Infinity;
  for (const [index, sample] of series.entries()) {
    const delta = Math.abs(sample.timestampMs - tMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = index;
    }
  }
  return best;
}
