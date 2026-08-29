/**
 * Paddle-track identity via TEMPORAL ownership evidence.
 *
 * The reach tether (offlineStroke FUSION.paddleReach*) is a spatial envelope:
 * it can only reject a paddle center that is far from every measured target
 * wrist AT ITS MOMENT. A foreign paddle track (identity switch to an
 * opponent's / partner's paddle) that hovers within reach of an idle target
 * wrist passes it. Identity, however, is temporal: a paddle held by the
 * target MOVES WITH the target's hand across the whole event — before and
 * after any single moment — while a foreign paddle moves with someone else's.
 *
 * This module measures that association from whole-event trajectories:
 *  - motion synchrony between the paddle track and each target wrist
 *    trajectory (speed-profile correlation over the shared timeline);
 *  - co-movement at the paddle's own activity peak (does the hand that
 *    supposedly holds this paddle move when the paddle moves?);
 *  - the mirror check at the target's activity peak (does the paddle move
 *    when the target's hand moves?);
 *  - contradiction evidence against NON-target wrist trajectories, when
 *    measured (a paddle that synchronizes better with an opponent's hand);
 *  - fragment provenance: temporal gaps in the track are surfaced so a
 *    verdict formed across an occlusion/re-acquisition is disclosed.
 *
 * All motion is torso-normalized. Every quantity is measured or null —
 * absence of measurement is never counter-evidence, so sparse or fragmented
 * tracks yield "undetermined", not "foreign".
 */

export const PADDLE_TRACK_IDENTITY_VERSION = "paddle-track-identity-1";

export interface TimedPoint {
  timestampMs: number;
  x: number;
  y: number;
}

export interface PaddleTrackIdentityInput {
  /** The paddle track under assessment (normalized image coords). */
  paddleCenters: ReadonlyArray<TimedPoint>;
  /** Target wrist trajectories (one per wrist that has a measured track). */
  targetWristTracks: ReadonlyArray<ReadonlyArray<TimedPoint>>;
  /** Non-target (opponent/partner) wrist trajectories, when measured. */
  otherWristTracks?: ReadonlyArray<ReadonlyArray<TimedPoint>>;
  /** Video aspect (width/height) so distances are isotropic. */
  aspect: number;
  /** Torso span (image-height units) for speed normalization. */
  torsoSpan: number;
}

export type PaddleIdentityVerdict = "target_consistent" | "foreign" | "undetermined";

export interface PaddleTrackIdentityEvidence {
  paddleSamples: number;
  paddleSpeedSamples: number;
  /** Fragment provenance: gaps larger than IDENTITY.maxStepMs in the track. */
  paddleTrackGaps: { count: number; maxGapMs: number };
  /** Strongest paddle activity peak (torso spans / s), null when unmeasured. */
  paddlePeak: { tMs: number; torsoPerSec: number } | null;
  /** Target-hand activity at the paddle's peak, relative to that hand's own
   *  in-track maximum (0..1); null when no wrist was measured there. */
  targetActivityAtPaddlePeak: number | null;
  /** Strongest target-wrist activity peak across measured wrist tracks. */
  targetPeak: { tMs: number; torsoPerSec: number } | null;
  /** Paddle activity at the target's peak, relative to the paddle's own
   *  maximum (0..1); null when the paddle was not measured there. */
  paddleActivityAtTargetPeak: number | null;
  /** |paddle peak − target peak| in ms; null when either is unmeasured. */
  peakSeparationMs: number | null;
  /** Best speed-profile correlation against any target wrist track. */
  targetSynchrony: number | null;
  /** Best speed-profile correlation against any NON-target wrist track. */
  otherSynchrony: number | null;
  notes: string[];
}

export interface PaddleTrackIdentityAssessment {
  version: typeof PADDLE_TRACK_IDENTITY_VERSION;
  verdict: PaddleIdentityVerdict;
  evidence: PaddleTrackIdentityEvidence;
}

/** Generic identity-evidence constants. Activity/quiet fractions reuse the
 * estimator's existing motion-support / corroboration precedents
 * (motionSupportFullFraction 0.35, corroborationFloor 0.25); they are not
 * tuned to any single fixture. */
export const IDENTITY = {
  /** Consecutive samples farther apart than this form a fragment boundary. */
  maxStepMs: 400,
  /** Minimum consecutive-speed samples before any motion claim is made. */
  minSpeedSamples: 5,
  /** A track's activity peak below this (torso/s) is drift, not an event. */
  activePeakTorsoPerSec: 2.0,
  /** Interpolation band when reading one series at another's peak. */
  peakBandMs: 90,
  /** "Quiet at the other's peak": relative activity at or below this. */
  quietRelativeFraction: 0.35,
  /** Mirror check is stricter — a held paddle shows SOME motion at a swing. */
  paddleQuietRelativeFraction: 0.25,
  /** Peaks closer than this cannot support a foreign verdict (they may be
   *  the same physical event measured twice). */
  minPeakSeparationMs: 250,
  /** Minimum aligned sample pairs before a correlation is trusted. */
  synchronyMinPairs: 8,
  /** Correlation at or above this = the paddle moves with the target hand. */
  synchronyConsistent: 0.6,
  /** A measured correlation above this blocks a foreign verdict. */
  synchronyForeignCeiling: 0.4,
  /** Co-movement at the paddle peak at or above this = target-consistent. */
  coMovementConsistent: 0.5,
} as const;

interface SpeedSample {
  timestampMs: number;
  value: number; // torso spans per second
}

function speedSeries(
  points: ReadonlyArray<TimedPoint>,
  aspect: number,
  torsoSpan: number,
): { series: SpeedSample[]; gaps: { count: number; maxGapMs: number } } {
  const sorted = [...points].sort((a, b) => a.timestampMs - b.timestampMs);
  const series: SpeedSample[] = [];
  let gapCount = 0;
  let maxGapMs = 0;
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    const dtMs = current.timestampMs - previous.timestampMs;
    if (dtMs <= 0) continue;
    if (dtMs > IDENTITY.maxStepMs) {
      gapCount += 1;
      if (dtMs > maxGapMs) maxGapMs = dtMs;
      continue;
    }
    const distance = Math.hypot((current.x - previous.x) * aspect, current.y - previous.y);
    series.push({
      timestampMs: (current.timestampMs + previous.timestampMs) / 2,
      value: ((distance / dtMs) * 1000) / torsoSpan,
    });
  }
  return { series, gaps: { count: gapCount, maxGapMs } };
}

function peakOf(series: ReadonlyArray<SpeedSample>): { tMs: number; torsoPerSec: number } | null {
  let best: SpeedSample | null = null;
  for (const sample of series) {
    if (best === null || sample.value > best.value) best = sample;
  }
  return best === null ? null : { tMs: best.timestampMs, torsoPerSec: best.value };
}

function interpolateAt(series: ReadonlyArray<SpeedSample>, tMs: number): number | null {
  let before: SpeedSample | null = null;
  let after: SpeedSample | null = null;
  for (const sample of series) {
    if (sample.timestampMs <= tMs && (!before || sample.timestampMs > before.timestampMs)) {
      before = sample;
    }
    if (sample.timestampMs >= tMs && (!after || sample.timestampMs < after.timestampMs)) {
      after = sample;
    }
  }
  const beforeOk = before !== null && tMs - before.timestampMs <= IDENTITY.peakBandMs;
  const afterOk = after !== null && after.timestampMs - tMs <= IDENTITY.peakBandMs;
  if (beforeOk && afterOk) {
    if (after!.timestampMs === before!.timestampMs) return before!.value;
    const t = (tMs - before!.timestampMs) / (after!.timestampMs - before!.timestampMs);
    return before!.value + (after!.value - before!.value) * t;
  }
  if (beforeOk) return before!.value;
  if (afterOk) return after!.value;
  return null;
}

/** Pearson correlation between the paddle speed profile and a wrist speed
 * profile, aligned by interpolating the wrist series at each paddle sample
 * time. Null when too few pairs align or either side has no variance. */
function speedSynchrony(
  paddle: ReadonlyArray<SpeedSample>,
  wrist: ReadonlyArray<SpeedSample>,
): number | null {
  const pairs: Array<{ a: number; b: number }> = [];
  for (const sample of paddle) {
    const wristValue = interpolateAt(wrist, sample.timestampMs);
    if (wristValue === null) continue;
    pairs.push({ a: sample.value, b: wristValue });
  }
  if (pairs.length < IDENTITY.synchronyMinPairs) return null;
  const meanA = pairs.reduce((total, pair) => total + pair.a, 0) / pairs.length;
  const meanB = pairs.reduce((total, pair) => total + pair.b, 0) / pairs.length;
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (const pair of pairs) {
    covariance += (pair.a - meanA) * (pair.b - meanB);
    varianceA += (pair.a - meanA) ** 2;
    varianceB += (pair.b - meanB) ** 2;
  }
  if (varianceA <= 1e-12 || varianceB <= 1e-12) return null;
  return covariance / Math.sqrt(varianceA * varianceB);
}

export function assessPaddleTrackIdentity(
  input: PaddleTrackIdentityInput,
): PaddleTrackIdentityAssessment {
  const notes: string[] = [];
  const torso = input.torsoSpan > 0 ? input.torsoSpan : null;
  const { series: paddleSpeed, gaps } =
    torso !== null
      ? speedSeries(input.paddleCenters, input.aspect, torso)
      : { series: [], gaps: { count: 0, maxGapMs: 0 } };

  const wristSeries = (torso !== null ? input.targetWristTracks : [])
    .map((track) => speedSeries(track, input.aspect, torso!).series)
    .filter((series) => series.length >= IDENTITY.minSpeedSamples);
  const otherSeries = (torso !== null ? (input.otherWristTracks ?? []) : [])
    .map((track) => speedSeries(track, input.aspect, torso!).series)
    .filter((series) => series.length >= IDENTITY.minSpeedSamples);

  const paddlePeak = peakOf(paddleSpeed);
  const evidence: PaddleTrackIdentityEvidence = {
    paddleSamples: input.paddleCenters.length,
    paddleSpeedSamples: paddleSpeed.length,
    paddleTrackGaps: gaps,
    paddlePeak,
    targetActivityAtPaddlePeak: null,
    targetPeak: null,
    paddleActivityAtTargetPeak: null,
    peakSeparationMs: null,
    targetSynchrony: null,
    otherSynchrony: null,
    notes,
  };

  if (torso === null) {
    notes.push("torso span unmeasured: no motion can be normalized");
    return { version: PADDLE_TRACK_IDENTITY_VERSION, verdict: "undetermined", evidence };
  }
  if (paddleSpeed.length < IDENTITY.minSpeedSamples) {
    notes.push(
      `paddle speed unmeasurable: ${paddleSpeed.length} consecutive-step sample(s) < ${IDENTITY.minSpeedSamples}`,
    );
    return { version: PADDLE_TRACK_IDENTITY_VERSION, verdict: "undetermined", evidence };
  }
  if (wristSeries.length === 0) {
    notes.push("no target wrist trajectory with enough samples: association unmeasurable");
    return { version: PADDLE_TRACK_IDENTITY_VERSION, verdict: "undetermined", evidence };
  }
  if (gaps.count > 0) {
    notes.push(
      `fragmented track: ${gaps.count} gap(s) > ${IDENTITY.maxStepMs}ms (max ${Math.round(gaps.maxGapMs)}ms) — speeds measured within fragments only`,
    );
  }

  // Motion synchrony: best correlation against any target wrist trajectory.
  let targetSynchrony: number | null = null;
  for (const series of wristSeries) {
    const correlation = speedSynchrony(paddleSpeed, series);
    if (correlation === null) continue;
    if (targetSynchrony === null || correlation > targetSynchrony) targetSynchrony = correlation;
  }
  evidence.targetSynchrony = targetSynchrony === null ? null : round3(targetSynchrony);

  // Contradiction evidence: best correlation against any non-target wrist.
  let otherSynchrony: number | null = null;
  for (const series of otherSeries) {
    const correlation = speedSynchrony(paddleSpeed, series);
    if (correlation === null) continue;
    if (otherSynchrony === null || correlation > otherSynchrony) otherSynchrony = correlation;
  }
  evidence.otherSynchrony = otherSynchrony === null ? null : round3(otherSynchrony);

  // Ownership history around the paddle's own activity peak: does any target
  // hand move when this paddle moves? (Relative to each hand's own maximum,
  // so a compact stroke is not penalized for being compact.)
  let targetActivityAtPaddlePeak: number | null = null;
  if (paddlePeak !== null) {
    for (const series of wristSeries) {
      const max = Math.max(...series.map((sample) => sample.value));
      if (max <= 1e-9) continue;
      const at = interpolateAt(series, paddlePeak.tMs);
      if (at === null) continue;
      const relative = at / max;
      if (targetActivityAtPaddlePeak === null || relative > targetActivityAtPaddlePeak) {
        targetActivityAtPaddlePeak = relative;
      }
    }
  }
  evidence.targetActivityAtPaddlePeak =
    targetActivityAtPaddlePeak === null ? null : round3(targetActivityAtPaddlePeak);

  // Mirror check at the target's own strongest activity peak.
  let targetPeak: { tMs: number; torsoPerSec: number } | null = null;
  for (const series of wristSeries) {
    const peak = peakOf(series);
    if (peak !== null && (targetPeak === null || peak.torsoPerSec > targetPeak.torsoPerSec)) {
      targetPeak = peak;
    }
  }
  evidence.targetPeak = targetPeak;
  let paddleActivityAtTargetPeak: number | null = null;
  if (targetPeak !== null && paddlePeak !== null && paddlePeak.torsoPerSec > 1e-9) {
    const at = interpolateAt(paddleSpeed, targetPeak.tMs);
    if (at !== null) paddleActivityAtTargetPeak = at / paddlePeak.torsoPerSec;
  }
  evidence.paddleActivityAtTargetPeak =
    paddleActivityAtTargetPeak === null ? null : round3(paddleActivityAtTargetPeak);
  evidence.peakSeparationMs =
    paddlePeak !== null && targetPeak !== null
      ? Math.round(Math.abs(paddlePeak.tMs - targetPeak.tMs))
      : null;

  // ── Verdict ──────────────────────────────────────────────────────────────
  if (
    targetSynchrony !== null &&
    targetSynchrony >= IDENTITY.synchronyConsistent &&
    (otherSynchrony === null || targetSynchrony >= otherSynchrony)
  ) {
    notes.push(`speed profiles synchronized with a target hand (r=${targetSynchrony.toFixed(2)})`);
    return { version: PADDLE_TRACK_IDENTITY_VERSION, verdict: "target_consistent", evidence };
  }
  if (
    targetActivityAtPaddlePeak !== null &&
    targetActivityAtPaddlePeak >= IDENTITY.coMovementConsistent
  ) {
    notes.push(
      `a target hand co-moves at the paddle's activity peak (${targetActivityAtPaddlePeak.toFixed(2)} of its own max)`,
    );
    return { version: PADDLE_TRACK_IDENTITY_VERSION, verdict: "target_consistent", evidence };
  }

  // Foreign: every element measured, and each independently contradicts
  // target ownership. Any unmeasured element → undetermined, never foreign.
  const foreign =
    paddlePeak !== null &&
    paddlePeak.torsoPerSec >= IDENTITY.activePeakTorsoPerSec &&
    targetActivityAtPaddlePeak !== null &&
    targetActivityAtPaddlePeak <= IDENTITY.quietRelativeFraction &&
    targetPeak !== null &&
    targetPeak.torsoPerSec >= IDENTITY.activePeakTorsoPerSec &&
    paddleActivityAtTargetPeak !== null &&
    paddleActivityAtTargetPeak <= IDENTITY.paddleQuietRelativeFraction &&
    evidence.peakSeparationMs !== null &&
    evidence.peakSeparationMs >= IDENTITY.minPeakSeparationMs &&
    (targetSynchrony === null || targetSynchrony <= IDENTITY.synchronyForeignCeiling);
  if (foreign) {
    notes.push(
      `activity peaks contradict ownership: paddle peak ${paddlePeak!.torsoPerSec.toFixed(1)} torso/s @${Math.round(paddlePeak!.tMs)}ms with every target hand quiet (${targetActivityAtPaddlePeak!.toFixed(2)} rel), target peak ${targetPeak!.torsoPerSec.toFixed(1)} torso/s @${Math.round(targetPeak!.tMs)}ms with the paddle quiet (${paddleActivityAtTargetPeak!.toFixed(2)} rel), ${evidence.peakSeparationMs}ms apart`,
    );
    if (otherSynchrony !== null && otherSynchrony > (targetSynchrony ?? -1)) {
      notes.push(
        `contradiction: paddle synchronizes better with a NON-target hand (r=${otherSynchrony.toFixed(2)} vs target ${targetSynchrony === null ? "unmeasured" : targetSynchrony.toFixed(2)})`,
      );
    }
    return { version: PADDLE_TRACK_IDENTITY_VERSION, verdict: "foreign", evidence };
  }

  notes.push("evidence insufficient to confirm or contradict ownership");
  return { version: PADDLE_TRACK_IDENTITY_VERSION, verdict: "undetermined", evidence };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
