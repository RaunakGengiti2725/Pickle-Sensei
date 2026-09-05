/**
 * StrokeEvent — the first-class unit of analysis.
 *
 * A capture contains 0..N temporally localized hitting motions. Everything
 * downstream (contact, phases, stroke class, sequences) must operate on ONE
 * isolated event, never on a multi-swing window. Proposals answer "where are
 * plausible distinct hitting motions?", not "what stroke is this?".
 *
 * Signals: the TARGET-associated paddle speed series when it covers enough
 * of the clip, else the target's dominant-wrist speed series (recorded).
 * Selection: a contact estimate inside exactly one event wins; without an
 * anchor, a decisive prominence leader wins; two comparable leaders =
 * MULTI_STROKE_AMBIGUOUS and fine analysis abstains (Rule: never average
 * peaks, never stretch windows, never silently pick one of two swings).
 */

export const STROKE_EVENT_VERSION = "stroke-event-1 (heuristic, uncalibrated)";

export interface StrokeEventProposal {
  eventId: string; // E1, E2, ... in time order
  startMs: number;
  peakMs: number;
  endMs: number;
  peakSpeed: number;
  /** peak / local-baseline ratio (heuristic prominence). */
  prominence: number;
  source: "paddle" | "wrist";
  confidence: number;
  /** Present when the peak was under the absolute speed floor and was
   * admitted by the prominence-gated low-amplitude tier (compact strokes). */
  lowAmplitude?: true;
}

export type TargetEventSelection =
  | {
      status: "selected";
      event: StrokeEventProposal;
      via: "contact" | "prominence" | "paddle_confirmation";
      /** Present when a non-null contact estimate fell OUTSIDE every proposed
       * event (±60ms): selection proceeded on prominence/paddle evidence alone
       * and the contact estimate does NOT belong to the selected event —
       * downstream must never anchor fine analysis of this event on it. */
      contactOrphaned?: true;
    }
  | { status: "ambiguous"; reason: string; leaders: string[] }
  | { status: "none"; reason: string };

const EVENT_GATES = {
  minPeakSpeed: 0.5, // normalized u/s — below this nothing is a swing
  minPeakFractionOfMax: 0.3,
  boundaryFraction: 0.25, // walk to sustained <25% of event peak
  mergeValleyFraction: 0.6, // peaks with a shallow valley between = one event
  maxBoundaryReachMs: 1200,
  minEventSpanMs: 160,
  ambiguityProminenceRatio: 1.3,
} as const;

/** Low-amplitude tier (wrist source only): compact strokes — punch volleys,
 * short smashes — move the wrist far less than full swings in normalized
 * image units (measured gold compact strokes peak at 0.31–0.46, under the
 * 0.5 floor). A sub-floor peak is admitted only when it is decisively
 * distinct from its own local baseline: minProminence 4 is the SAME
 * boundary the miner already treats as "is this a stroke at all?"
 * (mineVideo.ts) — below it nothing is admitted here. Measured on the dev
 * event bench, this tier admits exactly the missed compact stroke and adds
 * zero proposals inside explicitly labeled non-event spans and zero
 * unmatched proposals. Tier-2 proposals never alter
 * tier-1 output: they are added only where no tier-1 event exists and
 * carry `lowAmplitude` + a confidence penalty so downstream consumers see
 * the weaker evidence. */
const LOW_AMPLITUDE_GATES = {
  minPeakSpeed: 0.3,
  minProminence: 4,
  confidencePenalty: 0.15,
} as const;

/** v2 fragment-glue gates: gluing exists to reunite ONE movement (swing +
 * follow-through burst split by a brief dip), never to fuse two distinct
 * strokes. Two fragments whose peaks are far apart AND comparably strong are
 * two hitting motions; gluing them would fabricate a multi-swing event.
 * The measured rally1 fragmentation (400ms + 234ms fragments 167ms apart,
 * peaks ≈480ms apart) stays glued; synthetic rapid consecutive strokes with
 * peaks ≥550ms apart stay distinct. */
const GLUE_GATES = {
  maxGapMs: 350,
  distinctPeakSeparationMs: 550,
  distinctPeakRatio: 0.6,
} as const;

/** Sample cadence and timestamp de-jitter.
 *
 * Every speed sample is a finite difference — displacement over the
 * interval since the previous sample (see dominantWristSpeeds) — so it is
 * the MEAN velocity over its own interval, and presentation-stamp jitter
 * leaks straight into the signal: a 2 ms wobble on a 16.7 ms interval moves
 * a speed by 12%, enough to flip the 25% boundary walk, the 60% merge
 * valley, the 30%-of-max peak gate and the 350 ms fragment glue on real
 * wrist series (measured: 2 ms jitter moved a gold serve's start by 402 ms
 * — a 0.847 secondary peak against a 0.831 gate). A frame emitted by a
 * fixed-rate camera measured a WHOLE number of frame intervals of
 * displacement regardless of where its stamp landed, so each sample whose
 * interval is within the jitter tolerance of k × the local cadence
 * (k ≥ 1: k − 1 frames without a wrist observation in between) is re-timed
 * to exactly k × cadence, displacement preserved (value × interval /
 * (k × cadence)). The re-timed value is then a pure function of the frames'
 * content, not of their stamps. Stamp wobble is a few milliseconds whatever
 * the frame rate, so the tolerance is absolute (`jitterToleranceMs`), capped
 * to a fraction of the cadence for very fast rates; an interval that fits no
 * multiple is a genuine cadence irregularity whose measured speed is kept
 * as is.
 *
 * The cadence of a sample is the robust mean of the TRAILING
 * `localWindowIntervals` intervals (those within tolerance of their median,
 * so a dropped frame or a pull-down long frame is outvoted), snapped to the
 * nearest standard frame rate within `standardRateSnapFraction` so integer
 * stamps of a 59.94 fps capture (16/17 ms) re-time to one 60 fps grid — and
 * never taken from declared metadata (XC-CV-4: nominalFrameRate can be
 * wrong). TRAILING (causal) by design: the streaming engine runs this
 * proposer over every growing prefix of the session, and a statistic over
 * the whole series gives the same physical sample a different value in the
 * prefix than in the batch (measured: a 60→30 fps cadence drop mid-session
 * moved already-closed bounds by 15–35 ms). With a trailing window every
 * sample's value depends on its past only, so prefix and batch agree
 * exactly whatever the cadence does.
 *
 * The same wobble also flips every gate that compares TIMES — the 350 ms
 * fragment glue, the 550 ms distinct-peak separation, the boundary reach,
 * the overlap merges (measured: a glue gap of exactly 350 ms became 351 ms
 * under 2 ms jitter and un-glued the serve's preparation, a 402 ms start
 * shift). So each sample also carries a GRID time: the previous sample's
 * grid time plus k × cadence when the interval was re-timed, plus the
 * measured interval otherwise. Every time gate inside the proposer is
 * evaluated on grid times (`gridSpan`), so decisions are a function of frame
 * counts, not stamps; reported bounds are the samples' real stamps, which a
 * 2 ms wobble moves by 2 ms. Grid times are only ever DIFFERENCED over at
 * most a boundary reach, so the cadence-snap drift (a 59.94 fps capture on
 * the 60 fps grid: 0.1%) stays under a millisecond; comparisons against
 * other series (paddle samples, clip bounds) use the real stamps.
 *
 * Smoothing stays the three-sample mean the gates were calibrated on — and
 * that mean spans 50 ms at 60 fps but 100 ms at 30 fps and 125 ms at 24 fps,
 * so a short stroke's smoothed peak is attenuated more at a slower cadence
 * while the noise baseline is not (measured on the gold compact strokes:
 * 0.463 → 0.339 at 30 fps, 0.319 at 24 fps; 0.449 → 0.362 at 24 fps). The
 * speed floors and the low-amplitude prominence gate therefore scale by
 * (reference / cadence) ** floorScaleExponent below the reference cadence
 * (×0.71 at 30 fps against the measured 0.69–0.73), so the same physical
 * stroke clears the same gate at 60, 30 and 24 fps. */
const CADENCE = {
  /** Mirrors dominantWristSpeeds: no emitter produces one speed over a
   * longer gap, so longer intervals are dropouts, not cadence. */
  maxSampleIntervalMs: 150,
  jitterToleranceMs: 5,
  jitterToleranceFraction: 0.35,
  standardRatesFps: [24, 25, 30, 48, 50, 60, 90, 120, 240],
  standardRateSnapFraction: 0.1,
  /** The cadence the speed floors (EVENT_GATES.minPeakSpeed,
   * LOW_AMPLITUDE_GATES.minPeakSpeed) were calibrated at. */
  referenceCadenceMs: 1000 / 60,
  /** Floors scale by (reference / cadence) ** exponent below the reference
   * cadence: 0.5 → ×0.71 at 30 fps, ×0.63 at 24 fps (see CADENCE). */
  floorScaleExponent: 0.5,
  /** Trailing intervals (including the sample's own) the local cadence is
   * estimated from — long enough to outvote a pull-down long frame or a
   * dropped frame, short enough to follow a real cadence change within a
   * fraction of a stroke. */
  localWindowIntervals: 8,
} as const;

type SpeedPoint = { timestampMs: number; value: number };

/** A de-jittered sample: real stamp for reporting, grid time for gates. */
type GridPoint = SpeedPoint & { gridMs: number; cadenceMs: number | null };

/** Difference of two grid times, rounded so an exact whole number of frames
 * (21 × 1000/60 = 350) compares exactly against a millisecond gate. */
function gridSpan(fromMs: number, toMs: number): number {
  return Math.round((toMs - fromMs) * 1e6) / 1e6;
}

export interface ObservedCadence {
  /** Robust mean interval, snapped to a standard frame rate. */
  intervalMs: number;
  /** Inter-quartile interval range: the spread of the regular cadence. */
  spreadMs: number;
}

function snapToStandardRate(observed: number): number {
  let nearestStandard = observed;
  let nearestDistance = Infinity;
  for (const fps of CADENCE.standardRatesFps) {
    const standard = 1000 / fps;
    const distance = Math.abs(observed - standard);
    if (distance <= standard * CADENCE.standardRateSnapFraction && distance < nearestDistance) {
      nearestStandard = standard;
      nearestDistance = distance;
    }
  }
  return nearestStandard;
}

function jitterToleranceMs(nominalMs: number): number {
  return Math.min(CADENCE.jitterToleranceMs, nominalMs * CADENCE.jitterToleranceFraction);
}

/** Robust cadence of a set of positive intervals: the mean of the intervals
 * within jitter tolerance of their median (the majority interval class of a
 * pull-down or mixed-cadence window), snapped to a standard frame rate. */
function robustCadenceMs(intervals: ReadonlyArray<number>): number {
  const ranked = [...intervals].sort((a, b) => a - b);
  const median = ranked[Math.floor(ranked.length / 2)]!;
  const tolerance = jitterToleranceMs(median);
  let total = 0;
  let count = 0;
  for (const interval of ranked) {
    if (Math.abs(interval - median) <= tolerance) {
      total += interval;
      count += 1;
    }
  }
  return snapToStandardRate(total / count);
}

/** Observed sample cadence of a whole time-sorted series, or null when no
 * two samples are within `maxSampleIntervalMs` of each other. */
export function observedCadence(
  sorted: ReadonlyArray<{ timestampMs: number }>,
): ObservedCadence | null {
  const intervals: number[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const interval = sorted[index]!.timestampMs - sorted[index - 1]!.timestampMs;
    if (interval > 0 && interval <= CADENCE.maxSampleIntervalMs) intervals.push(interval);
  }
  if (intervals.length === 0) return null;
  const ranked = [...intervals].sort((a, b) => a - b);
  const lower = ranked[Math.floor(ranked.length * 0.25)]!;
  const upper = ranked[Math.floor(ranked.length * 0.75)]!;
  return { intervalMs: robustCadenceMs(intervals), spreadMs: upper - lower };
}

/** Observed sample interval of a time-sorted series (see observedCadence). */
export function observedSampleIntervalMs(
  sorted: ReadonlyArray<{ timestampMs: number }>,
): number | null {
  return observedCadence(sorted)?.intervalMs ?? null;
}

/** Whole frame intervals a measured interval spans at the given cadence, or
 * null when it is not within jitter tolerance of any multiple. */
function frameMultiple(intervalMs: number, cadenceMs: number): number | null {
  const frames = Math.max(1, Math.round(intervalMs / cadenceMs));
  return Math.abs(intervalMs - frames * cadenceMs) <= jitterToleranceMs(cadenceMs) ? frames : null;
}

/** Per-sample re-timing against the TRAILING local cadence (see CADENCE). */
function retimeToLocalCadence(sorted: ReadonlyArray<SpeedPoint>): GridPoint[] {
  const out: GridPoint[] = [];
  const trailing: number[] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const sample = sorted[index]!;
    if (index === 0) {
      out.push({
        timestampMs: sample.timestampMs,
        gridMs: sample.timestampMs,
        cadenceMs: null,
        value: sample.value,
      });
      continue;
    }
    const interval = sample.timestampMs - sorted[index - 1]!.timestampMs;
    const previousGridMs = out[index - 1]!.gridMs;
    if (interval <= 0 || interval > CADENCE.maxSampleIntervalMs) {
      out.push({
        timestampMs: sample.timestampMs,
        gridMs: previousGridMs + Math.max(0, interval),
        cadenceMs: null,
        value: sample.value,
      });
      continue;
    }
    trailing.push(interval);
    if (trailing.length > CADENCE.localWindowIntervals) trailing.shift();
    const cadence = robustCadenceMs(trailing);
    const frames = frameMultiple(interval, cadence);
    if (frames === null) {
      out.push({
        timestampMs: sample.timestampMs,
        gridMs: previousGridMs + interval,
        cadenceMs: null,
        value: sample.value,
      });
      continue;
    }
    out.push({
      timestampMs: sample.timestampMs,
      gridMs: previousGridMs + frames * cadence,
      cadenceMs: cadence,
      value: (sample.value * interval) / (frames * cadence),
    });
  }
  return out;
}

/** De-jitter (see CADENCE), then the 3-sample mean. */
function smoothSpeedSeries(sorted: ReadonlyArray<SpeedPoint>): GridPoint[] {
  const series = retimeToLocalCadence(sorted);
  return series.map((sample, index) => {
    const window = series.slice(Math.max(0, index - 1), index + 2);
    const total = window.reduce((sum, entry) => sum + entry.value, 0);
    return {
      timestampMs: sample.timestampMs,
      gridMs: sample.gridMs,
      cadenceMs: sample.cadenceMs,
      value: total / window.length,
    };
  });
}

/** Event bounds on the de-jittered grid clock (see CADENCE), carried by
 * body proposals so the glue and relaxation gates stay stamp-independent. */
interface GridBounds {
  startMs: number;
  peakMs: number;
  endMs: number;
}

type BodyProposal = StrokeEventProposal & { grid: GridBounds };

function stripGrid(event: BodyProposal): StrokeEventProposal {
  const { grid: _grid, ...proposal } = event;
  return proposal;
}

export function proposeStrokeEvents(input: {
  paddleSpeeds: ReadonlyArray<{ timestampMs: number; value: number }> | null;
  wristSpeeds: ReadonlyArray<{ timestampMs: number; value: number }> | null;
  clipStartMs: number;
  clipEndMs: number;
}): { events: StrokeEventProposal[]; source: "paddle" | "wrist" | "none" } {
  const body = proposeBodyEvents(input);
  return { events: body.events.map(stripGrid), source: body.source };
}

function proposeBodyEvents(input: {
  paddleSpeeds: ReadonlyArray<{ timestampMs: number; value: number }> | null;
  wristSpeeds: ReadonlyArray<{ timestampMs: number; value: number }> | null;
  clipStartMs: number;
  clipEndMs: number;
}): { events: BodyProposal[]; source: "paddle" | "wrist" | "none" } {
  const clipLength = Math.max(1, input.clipEndMs - input.clipStartMs);
  const coverage = (series: ReadonlyArray<{ timestampMs: number }> | null): number => {
    if (!series || series.length < 4) return 0;
    return (series[series.length - 1]!.timestampMs - series[0]!.timestampMs) / clipLength;
  };
  let source: "paddle" | "wrist";
  let series: ReadonlyArray<{ timestampMs: number; value: number }>;
  if (input.paddleSpeeds && coverage(input.paddleSpeeds) >= 0.35) {
    source = "paddle";
    series = input.paddleSpeeds;
  } else if (input.wristSpeeds && coverage(input.wristSpeeds) >= 0.4) {
    source = "wrist";
    series = input.wristSpeeds;
  } else {
    return { events: [], source: "none" };
  }
  const sorted = [...series].sort((a, b) => a.timestampMs - b.timestampMs);
  const smoothed = smoothSpeedSeries(sorted);
  const globalPeak = smoothed.reduce((best, sample) => Math.max(best, sample.value), 0);
  // Speed floors are defined at the reference cadence; at a slower cadence
  // they scale down with the sample interval (see CADENCE.floorScaleExponent).
  const floorScale = (index: number): number => {
    const cadence = smoothed[index]!.cadenceMs;
    if (cadence === null || cadence <= CADENCE.referenceCadenceMs) return 1;
    return Math.pow(CADENCE.referenceCadenceMs / cadence, CADENCE.floorScaleExponent);
  };
  const thresholdAt = (index: number): number =>
    Math.max(
      EVENT_GATES.minPeakSpeed * floorScale(index),
      globalPeak * EVENT_GATES.minPeakFractionOfMax,
    );

  // Local maxima above the (cadence-scaled) threshold.
  const peaks: number[] = [];
  for (let index = 1; index < smoothed.length - 1; index += 1) {
    const value = smoothed[index]!.value;
    if (value < thresholdAt(index)) continue;
    if (value >= smoothed[index - 1]!.value && value > smoothed[index + 1]!.value) {
      peaks.push(index);
    }
  }
  // Merge peaks whose interleaving valley never drops meaningfully.
  const merged: number[] = [];
  for (const peak of peaks) {
    const previous = merged[merged.length - 1];
    if (previous === undefined) {
      merged.push(peak);
      continue;
    }
    let valley = Infinity;
    for (let index = previous; index <= peak; index += 1) {
      valley = Math.min(valley, smoothed[index]!.value);
    }
    const shallow =
      valley >
      EVENT_GATES.mergeValleyFraction * Math.min(smoothed[previous]!.value, smoothed[peak]!.value);
    if (shallow) {
      if (smoothed[peak]!.value > smoothed[previous]!.value) merged[merged.length - 1] = peak;
    } else {
      merged.push(peak);
    }
  }

  const buildEvent = (peakIndex: number): BodyProposal | null => {
    const peakValue = smoothed[peakIndex]!.value;
    const boundary = peakValue * EVENT_GATES.boundaryFraction;
    const peakGridMs = smoothed[peakIndex]!.gridMs;
    let startIndex = peakIndex;
    while (
      startIndex > 0 &&
      smoothed[startIndex - 1]!.value >= boundary &&
      gridSpan(smoothed[startIndex - 1]!.gridMs, peakGridMs) <= EVENT_GATES.maxBoundaryReachMs
    ) {
      startIndex -= 1;
    }
    let endIndex = peakIndex;
    while (
      endIndex < smoothed.length - 1 &&
      smoothed[endIndex + 1]!.value >= boundary &&
      gridSpan(peakGridMs, smoothed[endIndex + 1]!.gridMs) <= EVENT_GATES.maxBoundaryReachMs
    ) {
      endIndex += 1;
    }
    const startGridMs = smoothed[startIndex]!.gridMs;
    const endGridMs = smoothed[endIndex]!.gridMs;
    if (gridSpan(startGridMs, endGridMs) < EVENT_GATES.minEventSpanMs) return null;
    // Local baseline: median outside the event, within ±1.5s context.
    const context = smoothed.filter(
      (sample) =>
        gridSpan(sample.gridMs, startGridMs) <= 1500 &&
        gridSpan(endGridMs, sample.gridMs) <= 1500 &&
        (sample.gridMs < startGridMs || sample.gridMs > endGridMs),
    );
    const contextValues = context.map((sample) => sample.value).sort((a, b) => a - b);
    const baseline = contextValues[Math.floor(contextValues.length / 2)] ?? 0.05;
    const prominence = peakValue / Math.max(0.05, baseline);
    return {
      eventId: "", // assigned after time-ordering below
      startMs: smoothed[startIndex]!.timestampMs,
      peakMs: smoothed[peakIndex]!.timestampMs,
      endMs: smoothed[endIndex]!.timestampMs,
      peakSpeed: peakValue,
      prominence,
      source,
      confidence: Math.max(0.2, Math.min(0.9, 0.4 + (prominence - 1) * 0.12)),
      grid: { startMs: startGridMs, peakMs: peakGridMs, endMs: endGridMs },
    };
  };

  const events: BodyProposal[] = [];
  for (const peakIndex of merged) {
    const event = buildEvent(peakIndex);
    if (event) events.push(event);
  }
  events.sort((a, b) => a.grid.startMs - b.grid.startMs);
  // Merge time-overlapping proposals (can occur across shallow valleys).
  const distinct: BodyProposal[] = [];
  for (const event of events) {
    const previous = distinct[distinct.length - 1];
    if (previous && gridSpan(event.grid.startMs, previous.grid.endMs) >= 80) {
      if (event.peakSpeed > previous.peakSpeed) distinct[distinct.length - 1] = event;
    } else {
      distinct.push(event);
    }
  }
  // Low-amplitude tier (wrist only): admit sub-floor peaks that are
  // decisively prominent, and only where tier-1 proposed nothing — the
  // tier-1 output above is never altered (see LOW_AMPLITUDE_GATES).
  if (source === "wrist") {
    const lowThresholdAt = (index: number): number =>
      Math.max(
        LOW_AMPLITUDE_GATES.minPeakSpeed * floorScale(index),
        globalPeak * EVENT_GATES.minPeakFractionOfMax,
      );
    const lowEvents: BodyProposal[] = [];
    for (let index = 1; index < smoothed.length - 1; index += 1) {
      const value = smoothed[index]!.value;
      if (value < lowThresholdAt(index) || value >= thresholdAt(index)) continue;
      if (value < smoothed[index - 1]!.value || value <= smoothed[index + 1]!.value) continue;
      const event = buildEvent(index);
      // Prominence is peak / local baseline; the peak is attenuated by the
      // cadence exactly like the floors while the baseline (noise) is not,
      // so the prominence gate scales with the same factor.
      if (!event || event.prominence < LOW_AMPLITUDE_GATES.minProminence * floorScale(index)) {
        continue;
      }
      if (
        distinct.some(
          (existing) =>
            event.grid.startMs <= existing.grid.endMs && event.grid.endMs >= existing.grid.startMs,
        )
      ) {
        continue;
      }
      event.lowAmplitude = true;
      event.confidence = Math.max(0.15, event.confidence - LOW_AMPLITUDE_GATES.confidencePenalty);
      const previous = lowEvents[lowEvents.length - 1];
      if (previous && event.grid.startMs <= previous.grid.endMs) {
        if (event.peakSpeed > previous.peakSpeed) lowEvents[lowEvents.length - 1] = event;
      } else {
        lowEvents.push(event);
      }
    }
    distinct.push(...lowEvents);
    distinct.sort((a, b) => a.grid.startMs - b.grid.startMs);
  }
  distinct.forEach((event, index) => {
    event.eventId = `E${index + 1}`;
  });
  return { events: distinct, source };
}

/**
 * STROKE-EVENT-2 — EVENT PROPOSAL DECOUPLED FROM PADDLE REPRESENTATION.
 *
 * Measured failures of v1 (both recorded): (a) enabling tracklet merge
 * changed the paddle-speed profile and the selector chose a DIFFERENT
 * physical movement (rally1 contact 73ms → 2411ms); (b) the end-to-end
 * cascade found a selected event with 0% overlap vs gold. Root cause: v1
 * PROPOSES from paddle speeds whenever paddle coverage ≥ 0.35, so the
 * paddle representation defines which movement exists.
 *
 * v2 contract:
 *   PROPOSE  — target BODY motion only (dominant-wrist speed series);
 *              stable across every paddle/tracker change.
 *   CONFIRM  — paddle evidence RANKS and REFINES proposals: a paddle-speed
 *              peak inside a proposal marks it paddleConfirmed, nudges
 *              confidence, and refines the interior peak toward the paddle
 *              peak (sharper near contact). It can never create, delete,
 *              or re-bound a proposal.
 *   FALLBACK — if wrist coverage is genuinely insufficient (target pose
 *              lost), paddle-sourced proposals are used and FLAGGED
 *              (source "paddle", confidence penalty) — recorded, not silent.
 */
export const STROKE_EVENT_VERSION_2 =
  "stroke-event-2.2 (body proposes · paddle confirms; grid-timed on the observed cadence, floors scaled by sample interval; heuristic, uncalibrated)";

export interface StrokeEventProposalV2 extends StrokeEventProposal {
  /** True when a paddle-speed peak lands inside the proposal (±80ms). */
  paddleConfirmed: boolean;
  /** Paddle peak time inside the event, when confirmed (refines contact search). */
  paddlePeakMs: number | null;
  /** 0 none · 0.5 paddle activity inside · 1 decisive paddle peak inside. */
  paddleSupport: number;
}

export function proposeStrokeEventsV2(input: {
  paddleSpeeds: ReadonlyArray<{ timestampMs: number; value: number }> | null;
  wristSpeeds: ReadonlyArray<{ timestampMs: number; value: number }> | null;
  clipStartMs: number;
  clipEndMs: number;
}): { events: StrokeEventProposalV2[]; source: "wrist" | "paddle_fallback" | "none" } {
  const body = proposeBodyEvents({
    paddleSpeeds: null,
    wristSpeeds: input.wristSpeeds,
    clipStartMs: input.clipStartMs,
    clipEndMs: input.clipEndMs,
  });
  // Wrist series are noisier than paddle series: one physical stroke can
  // fragment into swing + follow-through bursts separated by a brief dip
  // (measured: rally1 gold stroke split into 400ms + 234ms proposals 167ms
  // apart, dropping gold overlap to 40%). Adjacent body proposals separated
  // by ≤350ms are one movement — merged BEFORE paddle confirmation so the
  // paddle still cannot redefine boundaries.
  const glued: BodyProposal[] = [];
  for (const event of body.events) {
    const previous = glued[glued.length - 1];
    // A later fragment that is BOTH far from the previous peak and comparably
    // strong is a distinct stroke — never glued (GLUE_GATES).
    const distinctStroke =
      previous !== undefined &&
      gridSpan(previous.grid.peakMs, event.grid.peakMs) >= GLUE_GATES.distinctPeakSeparationMs &&
      event.peakSpeed >= GLUE_GATES.distinctPeakRatio * previous.peakSpeed;
    if (
      previous &&
      !distinctStroke &&
      gridSpan(previous.grid.endMs, event.grid.startMs) <= GLUE_GATES.maxGapMs
    ) {
      previous.endMs = event.endMs;
      previous.grid.endMs = event.grid.endMs;
      if (event.peakSpeed > previous.peakSpeed) {
        previous.peakMs = event.peakMs;
        previous.grid.peakMs = event.grid.peakMs;
        previous.peakSpeed = event.peakSpeed;
      }
      previous.prominence = Math.max(previous.prominence, event.prominence);
      previous.confidence = Math.max(previous.confidence, event.confidence);
    } else {
      glued.push({ ...event, grid: { ...event.grid } });
    }
  }
  // Boundary relaxation (two-threshold hysteresis): the core walk stops at
  // sustained <25% of peak, which on noisy wrist series clips preparation
  // and follow-through (measured: proposals systematically narrower than
  // gold events — volley 240/800ms, rally2 123/670ms overlap). Boundaries
  // extend while smoothed wrist speed stays ≥ max(12% of peak, 0.08),
  // within the same reach cap. Peaks and event identity are untouched.
  if (input.wristSpeeds && input.wristSpeeds.length >= 4) {
    const sorted = [...input.wristSpeeds].sort((a, b) => a.timestampMs - b.timestampMs);
    const smoothed = smoothSpeedSeries(sorted);
    for (const event of glued) {
      const relax = Math.max(0.12 * event.peakSpeed, 0.08);
      let startIndex = smoothed.findIndex((sample) => sample.gridMs >= event.grid.startMs);
      if (startIndex < 0) startIndex = 0;
      while (
        startIndex > 0 &&
        smoothed[startIndex - 1]!.value >= relax &&
        gridSpan(smoothed[startIndex - 1]!.gridMs, event.grid.peakMs) <=
          EVENT_GATES.maxBoundaryReachMs
      ) {
        startIndex -= 1;
      }
      let endIndex = smoothed.findIndex((sample) => sample.gridMs >= event.grid.endMs);
      if (endIndex < 0) endIndex = smoothed.length - 1;
      while (
        endIndex < smoothed.length - 1 &&
        smoothed[endIndex + 1]!.value >= relax &&
        gridSpan(event.grid.peakMs, smoothed[endIndex + 1]!.gridMs) <=
          EVENT_GATES.maxBoundaryReachMs
      ) {
        endIndex += 1;
      }
      if (smoothed[startIndex]!.gridMs < event.grid.startMs) {
        event.startMs = smoothed[startIndex]!.timestampMs;
        event.grid.startMs = smoothed[startIndex]!.gridMs;
      }
      if (smoothed[endIndex]!.gridMs > event.grid.endMs) {
        event.endMs = smoothed[endIndex]!.timestampMs;
        event.grid.endMs = smoothed[endIndex]!.gridMs;
      }
    }
    // Relaxation may make neighbors touch; clamp at midpoints, never merge
    // here (movement identity was already decided by the glue pass).
    for (let index = 1; index < glued.length; index += 1) {
      const previous = glued[index - 1]!;
      const current = glued[index]!;
      if (current.grid.startMs < previous.grid.endMs) {
        const midpoint = (previous.peakMs + current.peakMs) / 2;
        previous.endMs = Math.min(previous.endMs, midpoint);
        current.startMs = Math.max(current.startMs, midpoint);
        const gridMidpoint = (previous.grid.peakMs + current.grid.peakMs) / 2;
        previous.grid.endMs = Math.min(previous.grid.endMs, gridMidpoint);
        current.grid.startMs = Math.max(current.grid.startMs, gridMidpoint);
      }
    }
  }
  glued.forEach((event, index) => {
    event.eventId = `E${index + 1}`;
  });
  let baseEvents: StrokeEventProposal[] = glued.map(stripGrid);
  let source: "wrist" | "paddle_fallback" | "none" = body.source === "wrist" ? "wrist" : "none";
  if (baseEvents.length === 0 && input.paddleSpeeds) {
    const paddleOnly = proposeStrokeEvents({
      paddleSpeeds: input.paddleSpeeds,
      wristSpeeds: null,
      clipStartMs: input.clipStartMs,
      clipEndMs: input.clipEndMs,
    });
    if (paddleOnly.events.length > 0) {
      baseEvents = paddleOnly.events.map((event) => ({
        ...event,
        confidence: Math.max(0.15, event.confidence - 0.2),
      }));
      source = "paddle_fallback";
    }
  }
  // Paddle CONFIRMATION applies only to body-sourced proposals; in the
  // paddle_fallback path the paddle already sourced the events — letting it
  // also "confirm" itself would double-count the same evidence.
  const paddle =
    source === "wrist"
      ? (input.paddleSpeeds ?? []).slice().sort((a, b) => a.timestampMs - b.timestampMs)
      : [];
  const paddleMax = paddle.reduce((best, sample) => Math.max(best, sample.value), 0);
  const events: StrokeEventProposalV2[] = baseEvents.map((event) => {
    const inside = paddle.filter(
      (sample) =>
        sample.timestampMs >= event.startMs - 80 && sample.timestampMs <= event.endMs + 80,
    );
    let paddlePeakMs: number | null = null;
    let bestInside = 0;
    for (const sample of inside) {
      if (sample.value > bestInside) {
        bestInside = sample.value;
        paddlePeakMs = sample.timestampMs;
      }
    }
    const decisive =
      paddleMax > 0 && bestInside >= 0.5 * paddleMax && bestInside >= EVENT_GATES.minPeakSpeed;
    const some = bestInside >= EVENT_GATES.minPeakSpeed * 0.6;
    const paddleSupport = decisive ? 1 : some ? 0.5 : 0;
    const paddleConfirmed = decisive;
    // Refine the interior peak toward the paddle peak (contact vicinity) —
    // boundaries stay body-defined so the movement identity cannot shift.
    // The peak stays interior: paddle samples come from an ±80ms halo
    // around the event, so an unclamped refinement could leave the span.
    const refinedPeakMs =
      paddleConfirmed && paddlePeakMs !== null && Math.abs(paddlePeakMs - event.peakMs) <= 250
        ? Math.min(Math.max(paddlePeakMs, event.startMs), event.endMs)
        : event.peakMs;
    const confidence = Math.max(
      0.15,
      Math.min(
        0.95,
        event.confidence +
          0.15 * paddleSupport -
          (paddle.length > 0 && paddleSupport === 0 ? 0.1 : 0),
      ),
    );
    return {
      ...event,
      peakMs: refinedPeakMs,
      confidence,
      paddleConfirmed,
      paddlePeakMs,
      paddleSupport,
    };
  });
  return { events, source };
}

/** v2 selection: contact anchor first (unchanged), then prominence with a
 * PADDLE-CONFIRMATION tie-break — two comparable body peaks where exactly
 * one has decisive paddle evidence is not ambiguous, it is confirmed. */
export function selectTargetEventV2(
  events: readonly StrokeEventProposalV2[],
  contactMs: number | null,
): TargetEventSelection {
  const base = selectTargetEvent(events, contactMs);
  if (base.status !== "ambiguous") return base;
  const leaders = events.filter((event) => base.leaders.includes(event.eventId));
  const confirmed = leaders.filter((event) => event.paddleConfirmed);
  if (confirmed.length === 1) {
    const orphaned =
      contactMs !== null &&
      !events.some((event) => contactMs >= event.startMs - 60 && contactMs <= event.endMs + 60);
    return {
      status: "selected",
      event: confirmed[0]!,
      via: "paddle_confirmation",
      ...(orphaned ? { contactOrphaned: true as const } : {}),
    };
  }
  return base;
}

export function selectTargetEvent(
  events: readonly StrokeEventProposal[],
  contactMs: number | null,
): TargetEventSelection {
  if (events.length === 0) {
    return { status: "none", reason: "no stroke events proposed" };
  }
  let contactOrphaned = false;
  if (contactMs !== null) {
    const containing = events.filter(
      (event) => contactMs >= event.startMs - 60 && contactMs <= event.endMs + 60,
    );
    if (containing.length === 1) {
      return { status: "selected", event: containing[0]!, via: "contact" };
    }
    if (containing.length > 1) {
      return {
        status: "ambiguous",
        reason: "EVENT_CONTACT_AMBIGUOUS: contact estimate falls inside multiple events",
        leaders: containing.map((event) => event.eventId),
      };
    }
    // Contact outside all events: fall through to prominence, RECORDED via
    // contactOrphaned — the estimate does not belong to whatever is selected.
    contactOrphaned = true;
  }
  const orphanFlag = contactOrphaned ? { contactOrphaned: true as const } : {};
  if (events.length === 1) {
    return { status: "selected", event: events[0]!, via: "prominence", ...orphanFlag };
  }
  const byProminence = [...events].sort((a, b) => b.prominence - a.prominence);
  const ratio = byProminence[0]!.prominence / Math.max(1e-6, byProminence[1]!.prominence);
  if (ratio < EVENT_GATES.ambiguityProminenceRatio) {
    return {
      status: "ambiguous",
      reason: `MULTI_STROKE_AMBIGUOUS: ${events.length} events with comparable prominence (ratio ${ratio.toFixed(2)})`,
      leaders: [byProminence[0]!.eventId, byProminence[1]!.eventId],
    };
  }
  return { status: "selected", event: byProminence[0]!, via: "prominence", ...orphanFlag };
}
