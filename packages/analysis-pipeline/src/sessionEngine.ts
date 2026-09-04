import type { AnalysisRecord } from "@pickle/swing-domain";

/**
 * HOME OF THE SESSION MULTI-EVENT ENGINE (moved from packages/swing-lab in
 * Wave B / W6). The mobile app cannot import @pickle/swing-lab — that package
 * carries node-only tooling (fs/child_process CLIs) — but the engine itself is
 * pure TS, and @pickle/analysis-pipeline is already consumed by mobile from
 * TypeScript source. swing-lab re-exports everything from here
 * (packages/swing-lab/src/sessionEngine.ts) so every existing import path and
 * workstream E's tests + replay validation keep working unchanged.
 *
 * FILE LAYOUT (two sections):
 *
 *  SECTION 1 — STROKE-EVENT-2 CANONICAL PROPOSER, VERBATIM MIRROR of
 *  packages/swing-lab/src/strokeEvents.ts. The engine composes the canonical
 *  proposer (never re-implements its semantics), but analysis-pipeline cannot
 *  depend on swing-lab (swing-lab already depends on analysis-pipeline — the
 *  dependency would be circular), so the proposer travels with the engine as
 *  a byte-identical mirror. TWO drift guards keep the copies honest:
 *    (a) packages/analysis-pipeline/test/sessionEngine.test.ts byte-compares
 *        this section against swing-lab/src/strokeEvents.ts — any edit to
 *        either file without the other fails CI;
 *    (b) swing-lab's replay suite (test/sessionEngine.test.ts) streams real
 *        rallies through THIS engine (via the shim) and asserts exact-bound
 *        equality against swing-lab's own batch proposer.
 *  The mirror is intentionally NOT exported from the package index: the
 *  workspace-canonical proposer API for lab/offline consumers remains
 *  swing-lab's strokeEvents.ts. Only the proposal TYPES are re-exported
 *  (SessionStrokeEvent.proposal is part of the engine's public shape).
 *
 *  SECTION 2 — the SessionEventEngine, byte-moved from
 *  packages/swing-lab/src/sessionEngine.ts (only the import statements
 *  changed; the proposer now lives in this module). Its regression net is
 *  workstream E's 13 tests, still running in packages/swing-lab through the
 *  re-export shim.
 */

// === BEGIN VERBATIM MIRROR: packages/swing-lab/src/strokeEvents.ts ===
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

export interface SpeedSeriesSample {
  timestampMs: number;
  value: number;
}

/** What the dropped prefix of one speed stream still contributes to the
 * proposer (see StrokeEventStreamPrefix). */
export interface SpeedStreamPrefix {
  /** Fraction of the clip the WHOLE stream covers (the window alone would
   * under-report it). */
  coverage: number;
  /** The sample immediately preceding the window: smooths the window's first
   * sample with its true neighbour; never a peak itself. */
  leadIn: SpeedSeriesSample | null;
  /** Highest 3-sample-smoothed speed among the dropped samples: keeps the
   * 30%-of-global-peak proposal floor at the full-stream value. */
  peakSmoothedSpeed: number;
}

/**
 * Declares that the series passed in are the TRAILING WINDOW of a longer
 * stream (SessionEventEngine) rather than the whole clip. The proposer then
 * behaves exactly as if the dropped prefix were still present: `wrist` and
 * `paddle` carry each stream's contribution (null while nothing of that
 * stream was dropped) and `paddlePeakSpeed` is the highest raw paddle speed
 * dropped (keeps the paddle confirm normalization at the full-stream max;
 * null when no paddle sample was dropped). Offline callers pass the whole
 * clip and omit it.
 */
export interface StrokeEventStreamPrefix {
  wrist: SpeedStreamPrefix | null;
  paddle: SpeedStreamPrefix | null;
  paddlePeakSpeed: number | null;
}

const isFiniteSample = (sample: SpeedSeriesSample): boolean =>
  Number.isFinite(sample.timestampMs) && Number.isFinite(sample.value);

/** Non-finite samples (NaN/±Infinity timestamp or value) carry no evidence
 * and must never reach coverage, smoothing, gating or output fields. */
function finiteSamples(
  series: ReadonlyArray<SpeedSeriesSample> | null,
): ReadonlyArray<SpeedSeriesSample> | null {
  if (!series) return null;
  return series.every(isFiniteSample) ? series : series.filter(isFiniteSample);
}

/** A clip with non-finite or non-positive length cannot gate coverage —
 * the proposer abstains (typed) instead of treating it as a 1ms clip. */
function isUsableClip(clipStartMs: number, clipEndMs: number): boolean {
  return Number.isFinite(clipStartMs) && Number.isFinite(clipEndMs) && clipEndMs > clipStartMs;
}

/** Light smoothing (3-sample) to suppress single-frame jitter. `leadIn`, when
 * present, is the true predecessor of `sorted[0]` (see StrokeEventStreamPrefix). */
function smoothSeries(
  sorted: ReadonlyArray<SpeedSeriesSample>,
  leadIn: SpeedSeriesSample | null,
): SpeedSeriesSample[] {
  return sorted.map((sample, index) => {
    const window = sorted.slice(Math.max(0, index - 1), index + 2);
    if (index === 0 && leadIn) window.unshift(leadIn);
    return {
      timestampMs: sample.timestampMs,
      value: window.reduce((total, entry) => total + entry.value, 0) / window.length,
    };
  });
}

export function proposeStrokeEvents(input: {
  paddleSpeeds: ReadonlyArray<SpeedSeriesSample> | null;
  wristSpeeds: ReadonlyArray<SpeedSeriesSample> | null;
  clipStartMs: number;
  clipEndMs: number;
  streamPrefix?: StrokeEventStreamPrefix | undefined;
}): { events: StrokeEventProposal[]; source: "paddle" | "wrist" | "none" } {
  if (!isUsableClip(input.clipStartMs, input.clipEndMs)) return { events: [], source: "none" };
  const clipLength = input.clipEndMs - input.clipStartMs;
  const paddleSpeeds = finiteSamples(input.paddleSpeeds);
  const wristSpeeds = finiteSamples(input.wristSpeeds);
  const coverage = (
    series: ReadonlyArray<{ timestampMs: number }> | null,
    prefix: SpeedStreamPrefix | null,
  ): number => {
    if (prefix) return prefix.coverage;
    if (!series || series.length < 4) return 0;
    return (series[series.length - 1]!.timestampMs - series[0]!.timestampMs) / clipLength;
  };
  let source: "paddle" | "wrist";
  let series: ReadonlyArray<SpeedSeriesSample>;
  let prefix: SpeedStreamPrefix | null;
  if (paddleSpeeds && coverage(paddleSpeeds, input.streamPrefix?.paddle ?? null) >= 0.35) {
    source = "paddle";
    series = paddleSpeeds;
    prefix = input.streamPrefix?.paddle ?? null;
  } else if (wristSpeeds && coverage(wristSpeeds, input.streamPrefix?.wrist ?? null) >= 0.4) {
    source = "wrist";
    series = wristSpeeds;
    prefix = input.streamPrefix?.wrist ?? null;
  } else {
    return { events: [], source: "none" };
  }
  const sorted = [...series].sort((a, b) => a.timestampMs - b.timestampMs);
  const smoothed = smoothSeries(sorted, prefix?.leadIn ?? null);
  const globalPeak = smoothed.reduce(
    (best, sample) => Math.max(best, sample.value),
    prefix?.peakSmoothedSpeed ?? 0,
  );
  const threshold = Math.max(
    EVENT_GATES.minPeakSpeed,
    globalPeak * EVENT_GATES.minPeakFractionOfMax,
  );

  // Local maxima above threshold.
  const peaks: number[] = [];
  for (let index = 1; index < smoothed.length - 1; index += 1) {
    const value = smoothed[index]!.value;
    if (value < threshold) continue;
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

  const buildEvent = (peakIndex: number): StrokeEventProposal | null => {
    const peakValue = smoothed[peakIndex]!.value;
    const boundary = peakValue * EVENT_GATES.boundaryFraction;
    const peakMs = smoothed[peakIndex]!.timestampMs;
    let startIndex = peakIndex;
    while (
      startIndex > 0 &&
      smoothed[startIndex - 1]!.value >= boundary &&
      peakMs - smoothed[startIndex - 1]!.timestampMs <= EVENT_GATES.maxBoundaryReachMs
    ) {
      startIndex -= 1;
    }
    let endIndex = peakIndex;
    while (
      endIndex < smoothed.length - 1 &&
      smoothed[endIndex + 1]!.value >= boundary &&
      smoothed[endIndex + 1]!.timestampMs - peakMs <= EVENT_GATES.maxBoundaryReachMs
    ) {
      endIndex += 1;
    }
    const startMs = smoothed[startIndex]!.timestampMs;
    const endMs = smoothed[endIndex]!.timestampMs;
    if (endMs - startMs < EVENT_GATES.minEventSpanMs) return null;
    // Local baseline: median outside the event, within ±1.5s context.
    const context = smoothed.filter(
      (sample) =>
        sample.timestampMs >= startMs - 1500 &&
        sample.timestampMs <= endMs + 1500 &&
        (sample.timestampMs < startMs || sample.timestampMs > endMs),
    );
    const contextValues = context.map((sample) => sample.value).sort((a, b) => a - b);
    const baseline = contextValues[Math.floor(contextValues.length / 2)] ?? 0.05;
    const prominence = peakValue / Math.max(0.05, baseline);
    return {
      eventId: "", // assigned after time-ordering below
      startMs,
      peakMs,
      endMs,
      peakSpeed: peakValue,
      prominence,
      source,
      confidence: Math.max(0.2, Math.min(0.9, 0.4 + (prominence - 1) * 0.12)),
    };
  };

  const events: StrokeEventProposal[] = [];
  for (const peakIndex of merged) {
    const event = buildEvent(peakIndex);
    if (event) events.push(event);
  }
  events.sort((a, b) => a.startMs - b.startMs);
  // Merge time-overlapping proposals (can occur across shallow valleys).
  const distinct: StrokeEventProposal[] = [];
  for (const event of events) {
    const previous = distinct[distinct.length - 1];
    if (previous && event.startMs <= previous.endMs - 80) {
      if (event.peakSpeed > previous.peakSpeed) distinct[distinct.length - 1] = event;
    } else {
      distinct.push(event);
    }
  }
  // Low-amplitude tier (wrist only): admit sub-floor peaks that are
  // decisively prominent, and only where tier-1 proposed nothing — the
  // tier-1 output above is never altered (see LOW_AMPLITUDE_GATES).
  if (source === "wrist") {
    const lowThreshold = Math.max(
      LOW_AMPLITUDE_GATES.minPeakSpeed,
      globalPeak * EVENT_GATES.minPeakFractionOfMax,
    );
    const lowEvents: StrokeEventProposal[] = [];
    for (let index = 1; index < smoothed.length - 1; index += 1) {
      const value = smoothed[index]!.value;
      if (value < lowThreshold || value >= threshold) continue;
      if (value < smoothed[index - 1]!.value || value <= smoothed[index + 1]!.value) continue;
      const event = buildEvent(index);
      if (!event || event.prominence < LOW_AMPLITUDE_GATES.minProminence) continue;
      if (
        distinct.some(
          (existing) => event.startMs <= existing.endMs && event.endMs >= existing.startMs,
        )
      ) {
        continue;
      }
      event.lowAmplitude = true;
      event.confidence = Math.max(0.15, event.confidence - LOW_AMPLITUDE_GATES.confidencePenalty);
      const previous = lowEvents[lowEvents.length - 1];
      if (previous && event.startMs <= previous.endMs) {
        if (event.peakSpeed > previous.peakSpeed) lowEvents[lowEvents.length - 1] = event;
      } else {
        lowEvents.push(event);
      }
    }
    distinct.push(...lowEvents);
    distinct.sort((a, b) => a.startMs - b.startMs);
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
  "stroke-event-2 (body proposes · paddle confirms; heuristic, uncalibrated)";

export interface StrokeEventProposalV2 extends StrokeEventProposal {
  /** True when a paddle-speed peak lands inside the proposal (±80ms). */
  paddleConfirmed: boolean;
  /** Paddle peak time inside the event, when confirmed (refines contact search). */
  paddlePeakMs: number | null;
  /** 0 none · 0.5 paddle activity inside · 1 decisive paddle peak inside. */
  paddleSupport: number;
}

export function proposeStrokeEventsV2(input: {
  paddleSpeeds: ReadonlyArray<SpeedSeriesSample> | null;
  wristSpeeds: ReadonlyArray<SpeedSeriesSample> | null;
  clipStartMs: number;
  clipEndMs: number;
  streamPrefix?: StrokeEventStreamPrefix | undefined;
}): { events: StrokeEventProposalV2[]; source: "wrist" | "paddle_fallback" | "none" } {
  if (!isUsableClip(input.clipStartMs, input.clipEndMs)) return { events: [], source: "none" };
  const wristSpeeds = finiteSamples(input.wristSpeeds);
  const paddleSpeeds = finiteSamples(input.paddleSpeeds);
  const body = proposeStrokeEvents({
    paddleSpeeds: null,
    wristSpeeds,
    clipStartMs: input.clipStartMs,
    clipEndMs: input.clipEndMs,
    streamPrefix: input.streamPrefix,
  });
  // Wrist series are noisier than paddle series: one physical stroke can
  // fragment into swing + follow-through bursts separated by a brief dip
  // (measured: rally1 gold stroke split into 400ms + 234ms proposals 167ms
  // apart, dropping gold overlap to 40%). Adjacent body proposals separated
  // by ≤350ms are one movement — merged BEFORE paddle confirmation so the
  // paddle still cannot redefine boundaries.
  const glued: StrokeEventProposal[] = [];
  for (const event of body.events) {
    const previous = glued[glued.length - 1];
    // A later fragment that is BOTH far from the previous peak and comparably
    // strong is a distinct stroke — never glued (GLUE_GATES).
    const distinctStroke =
      previous !== undefined &&
      event.peakMs - previous.peakMs >= GLUE_GATES.distinctPeakSeparationMs &&
      event.peakSpeed >= GLUE_GATES.distinctPeakRatio * previous.peakSpeed;
    if (previous && !distinctStroke && event.startMs - previous.endMs <= GLUE_GATES.maxGapMs) {
      previous.endMs = event.endMs;
      if (event.peakSpeed > previous.peakSpeed) {
        previous.peakMs = event.peakMs;
        previous.peakSpeed = event.peakSpeed;
      }
      previous.prominence = Math.max(previous.prominence, event.prominence);
      previous.confidence = Math.max(previous.confidence, event.confidence);
    } else {
      glued.push({ ...event });
    }
  }
  // Boundary relaxation (two-threshold hysteresis): the core walk stops at
  // sustained <25% of peak, which on noisy wrist series clips preparation
  // and follow-through (measured: proposals systematically narrower than
  // gold events — volley 240/800ms, rally2 123/670ms overlap). Boundaries
  // extend while smoothed wrist speed stays ≥ max(12% of peak, 0.08),
  // within the same reach cap. Peaks and event identity are untouched.
  if (wristSpeeds && wristSpeeds.length >= 4) {
    const sorted = [...wristSpeeds].sort((a, b) => a.timestampMs - b.timestampMs);
    const smoothed = smoothSeries(sorted, input.streamPrefix?.wrist?.leadIn ?? null);
    for (const event of glued) {
      const relax = Math.max(0.12 * event.peakSpeed, 0.08);
      let startIndex = smoothed.findIndex((sample) => sample.timestampMs >= event.startMs);
      if (startIndex < 0) startIndex = 0;
      while (
        startIndex > 0 &&
        smoothed[startIndex - 1]!.value >= relax &&
        event.peakMs - smoothed[startIndex - 1]!.timestampMs <= EVENT_GATES.maxBoundaryReachMs
      ) {
        startIndex -= 1;
      }
      let endIndex = smoothed.findIndex((sample) => sample.timestampMs >= event.endMs);
      if (endIndex < 0) endIndex = smoothed.length - 1;
      while (
        endIndex < smoothed.length - 1 &&
        smoothed[endIndex + 1]!.value >= relax &&
        smoothed[endIndex + 1]!.timestampMs - event.peakMs <= EVENT_GATES.maxBoundaryReachMs
      ) {
        endIndex += 1;
      }
      event.startMs = Math.min(event.startMs, smoothed[startIndex]!.timestampMs);
      event.endMs = Math.max(event.endMs, smoothed[endIndex]!.timestampMs);
    }
    // Relaxation may make neighbors touch; clamp at midpoints, never merge
    // here (movement identity was already decided by the glue pass).
    for (let index = 1; index < glued.length; index += 1) {
      const previous = glued[index - 1]!;
      const current = glued[index]!;
      if (current.startMs < previous.endMs) {
        const midpoint = (previous.peakMs + current.peakMs) / 2;
        previous.endMs = Math.min(previous.endMs, midpoint);
        current.startMs = Math.max(current.startMs, midpoint);
      }
    }
  }
  glued.forEach((event, index) => {
    event.eventId = `E${index + 1}`;
  });
  let baseEvents = glued;
  let source: "wrist" | "paddle_fallback" | "none" = body.source === "wrist" ? "wrist" : "none";
  if (baseEvents.length === 0 && paddleSpeeds) {
    const paddleOnly = proposeStrokeEvents({
      paddleSpeeds,
      wristSpeeds: null,
      clipStartMs: input.clipStartMs,
      clipEndMs: input.clipEndMs,
      streamPrefix: input.streamPrefix,
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
      ? (paddleSpeeds ?? []).slice().sort((a, b) => a.timestampMs - b.timestampMs)
      : [];
  const droppedPaddlePeak =
    source === "wrist" ? (input.streamPrefix?.paddlePeakSpeed ?? null) : null;
  const paddlePresent = paddle.length > 0 || droppedPaddlePeak !== null;
  const paddleMax = paddle.reduce(
    (best, sample) => Math.max(best, sample.value),
    droppedPaddlePeak ?? 0,
  );
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
        event.confidence + 0.15 * paddleSupport - (paddlePresent && paddleSupport === 0 ? 0.1 : 0),
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
// === END VERBATIM MIRROR: packages/swing-lab/src/strokeEvents.ts ===

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — SessionEventEngine (byte-moved from
// packages/swing-lab/src/sessionEngine.ts; imports resolved in-module).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SESSION MULTI-EVENT ENGINE — the canonical continuous-play segmenter.
 *
 * Session mode (HANDOFF_V2 §1): target lock → play → E1, E2, E3… — each
 * StrokeEvent analyzed independently while RECORDING NEVER STOPS. This module
 * is the pure, streaming-friendly core of that mode. It owns exactly one
 * question: "which closed StrokeEvents exist so far in this session?" —
 * everything downstream keeps operating on the atomic unit ONE TARGET
 * ATHLETE + ONE StrokeEvent.
 *
 * Contracts this module composes (never re-implements semantics of):
 *
 *  1. EVENT IDENTITY = stroke-event-2 (D-030, strokeEvents.ts). The engine
 *     never invents its own proposer: on every reconciliation it runs
 *     `proposeStrokeEventsV2` over the accumulated series (target BODY
 *     motion proposes; paddle only confirms/ranks/refines). Emitted events
 *     carry the canonical `StrokeEventProposalV2` — no second event type.
 *     The series handed to the proposer is a TRAILING WINDOW of the stream
 *     (see "BOUNDED RECONCILIATION WINDOW" below) so per-sample cost does
 *     not grow with session length; the proposer's `streamPrefix` input
 *     carries what the dropped samples still contribute (the smoothing
 *     neighbour of the window's first sample, the global-peak proposal
 *     floor, the paddle confirm normalization), so the window proposes the
 *     same events the full series would.
 *
 *  2. EVENT COMPLETION = D-029 adaptive settle-or-valley-or-safety
 *     (eventCompletionBench.ts, ADAPTIVE variant). Constants are mirrored
 *     verbatim in `SESSION_COMPLETION` (each field cites the bench line).
 *     The VALLEY condition is the multi-event segmentation primitive: in
 *     continuous play the athlete never settles — the dip-then-rise of the
 *     next stroke is what closes the previous one.
 *
 * APPEND-ONLY RECONCILIATION RULE (the one rule that makes streaming sound):
 * closed events NEVER change retroactively. Each reconciliation diffs the
 * fresh batch proposals against the emission frontier (endMs of the last
 * emitted event):
 *   - a batch proposal whose peak lies at/before the frontier is the same
 *     physical movement as an already-emitted event → ignored (if it now
 *     extends meaningfully past the frontier, a quality note records the
 *     suppression — recorded, not silent);
 *   - a batch proposal whose peak lies after the frontier is a NEW candidate
 *     and may close per D-029;
 *   - wrist samples at/before the frontier arriving late are DROPPED and
 *     counted (`droppedLateSamples`) — they may not rewrite history. Paddle
 *     samples are kept regardless: per D-030 paddle evidence can never
 *     create/delete/re-bound a proposal, so late paddle history only feeds
 *     the confirm-normalization of FUTURE candidates.
 *
 * BOUNDED RECONCILIATION WINDOW (why push() cost is independent of session
 * length): a peak can only still become, or still change, a proposal while
 * the stream is within the ±1200ms boundary reach cap of it, and its bounds
 * walk at most that far back; the local-baseline median that scores its
 * prominence looks a further 1500ms back (strokeEvents.ts L243). So after
 * every push the engine drops wrist/paddle samples older than
 *   min(start of the still-open candidate, lastSample − 2·1200) − 1500,
 * additionally keeping the LAST EMITTED event's samples (from its start −
 * 1500) while a new proposal could still glue onto it (gap ≤ 350ms,
 * GLUE_GATES.maxGapMs). Everything the dropped samples still contribute to
 * the batch is carried through `streamPrefix`: the window's true predecessor
 * sample (exact 3-sample smoothing at the edge), the highest smoothed wrist
 * speed dropped (the 30%-of-global-peak floor keeps rising exactly as it
 * would over the full series) and the highest raw paddle speed dropped. Two
 * consequences are deliberate and recorded: wrist samples arriving later
 * than the window (older than its first sample) are dropped and counted like
 * samples behind the frontier, and paddle_fallback batches are ignored while
 * a trimmed body proposal still clears the proposal floor (the full series
 * would still hold it and not fall back).
 * Once an emitted event has left the window, its retro-suppression check
 * (SESSION_EVENT_RETRO_SUPPRESSED) is made against the global-peak floor
 * (carried floor + window) — the one full-series rule that can still drop
 * it — instead of the batch itself.
 *
 * BOUND-STABILITY WAIT (why emission is not instant on settle): proposal
 * boundaries walk outward while smoothed wrist speed stays above the
 * relaxation floor, capped at ±1200ms from the peak (EVENT_GATES.
 * maxBoundaryReachMs, strokeEvents.ts L41 — mirrored as BOUND_STABILITY_MS;
 * not exported there). A settle-closed LAST candidate is therefore emitted
 * only once the stream has passed peak+1200ms, so no future sample can
 * still relax its end boundary. Rapid consecutive strokes do not wait: the
 * moment the NEXT candidate crests as its own proposal, the batch has
 * already midpoint-clamped the shared boundary and the previous event is
 * emitted immediately. Safety-closed events (trigger+2500ms) are past the
 * reach cap by construction. Measured emission delay stays comfortably
 * inside the shipped fixed 1.5s post-roll for the settle path (peak+1200
 * vs trigger+1500) and inside endMs+2500 always (replay-verified).
 */

export const SESSION_ENGINE_VERSION =
  "session-engine-1 (streaming reconcile over stroke-event-2 · D-029 completion · append-only)";

/** D-029 ADAPTIVE completion constants, mirrored VERBATIM from
 * eventCompletionBench.ts (the promoted-candidate semantics). Every field
 * cites its source line in that file so drift is reviewable. */
export const SESSION_COMPLETION = {
  /** Min follow-through before completion may fire (bench L122). */
  minFollowThroughMs: 300,
  /** Settle floor: quiet means < max(floor, fraction·peak) (bench L115). */
  settleFloor: 0.15,
  settlePeakFraction: 0.25,
  /** Quiet must be sustained this long to settle (bench L125). */
  settleQuietMs: 400,
  /** Valley candidate: dip below this fraction of peak (bench L133). */
  valleyDipFraction: 0.6,
  /** Rise ≥ this × valley (and ≥ 2× settle threshold) closes at the valley
   * (bench L136). */
  valleyRiseRatio: 1.5,
  /** The rise must occur at least this long after the valley (bench L136). */
  valleyMinDwellMs: 80,
  /** Hard safety max: trigger + this always closes (bench L117). */
  safetyMaxMs: 2500,
} as const;

/** Mirror of EVENT_GATES.maxBoundaryReachMs (strokeEvents.ts L41, private
 * there): once the stream passes peak+this, no sample can extend the
 * proposal's boundaries any further — bounds are stable and freezable. */
export const BOUND_STABILITY_MS = 1200;

/** Mirror of the ±1.5s local-baseline context the proposer's prominence
 * median looks at (strokeEvents.ts L243, literal there): the earliest sample
 * a proposal's SCORE can depend on is its start minus this. */
const BASELINE_CONTEXT_MS = 1500;

/** The window is never trimmed below the proposer's minimum series length. */
const MIN_WINDOW_SAMPLES = 4;

/** Mirror of the boundary-relaxation floor (strokeEvents.ts, literal there):
 * a proposal's bounds extend while smoothed speed stays ≥ max(12% of its
 * peak, this), within the reach cap. */
const RELAXATION_FLOOR = 0.08;
const RELAXATION_PEAK_FRACTION = 0.12;

/** Hard bound on how far back the peak chain (see chainStartMs) is followed.
 * Reached only when the smoothed speed has not once dipped to 60% of two
 * consecutive proposal-floor peaks, or their spans have kept touching, for
 * this long — continuous activity with no quiet moment. */
const CHAIN_RETENTION_CAP_MS = 30_000;

export interface SpeedSample {
  timestampMs: number;
  /** Normalized u/s, same units as dominantWristSpeeds / paddleSpeedSeries. */
  value: number;
}

export type SessionEventState = "pending" | "processing" | "ready" | "abstained";

export type SessionEventCloseReason =
  /** D-029 settle: quiet < max(0.15, 25% peak) sustained 400ms. */
  | "settle"
  /** D-029 next-stroke valley: dip <60% peak then ≥1.5× rise → end at valley. */
  | "next_stroke_valley"
  /** D-029 hard safety max: trigger + 2500ms. */
  | "safety_max"
  /** A newer candidate crested as its own proposal before any D-029
   * condition fired inside the available samples (boundary already
   * midpoint-clamped by the batch) — recorded distinctly, never silent. */
  | "next_event_proposed"
  /** Stream ended (user stopped recording) with the candidate still open. */
  | "flush";

/** ONE closed stroke event of the session — the atomic analysis unit.
 * `proposal` IS the canonical StrokeEventProposalV2 (frozen at emission);
 * the analysis lifecycle fields are the only mutable part. */
export interface SessionStrokeEvent {
  /** Session-scoped stable id E1, E2, … in emission (= time) order. The
   * per-batch ids from proposeStrokeEventsV2 are run-relative and are
   * renumbered here once, at emission. */
  eventId: string;
  proposal: StrokeEventProposalV2;
  /** Stream time (latest sample timestamp) at which the engine closed the
   * event — replay-verified ≤ proposal.endMs + safetyMaxMs. */
  closedAtMs: number;
  closeReason: SessionEventCloseReason;
  /** Per-event analysis lifecycle: pending → processing → ready|abstained. */
  state: SessionEventState;
  /** Per-event analysis slot — exactly what the analysis pipeline produces
   * for one capture (analyzeCapture/analyzeVideo envelope). Never a new
   * result shape. */
  analysis: AnalysisRecord | null;
  abstainReason: string | null;
}

/** TargetIdentity-shaped reference (playerTracker.ts L182) — the session
 * points at the locked athlete; it never re-decides identity. */
export interface SessionTargetRef {
  trackId: number | null;
  seedMode: "user_tapped_person" | "user_selected_court_half" | "auto_single_player" | null;
  lockedAtMs: number | null;
  /** Heuristic, uncalibrated (same caveat as TargetIdentity.confidence). */
  confidence: number | null;
}

export interface SessionCaptureMeta {
  startedAtIso: string | null;
  fps: number | null;
  source: "live" | "replay";
}

export interface SessionQualityState {
  wristSamples: number;
  paddleSamples: number;
  /** Late wrist samples at/before the frontier or behind the reconciliation
   * window — dropped, never rewritten. */
  droppedLateSamples: number;
  lastSampleMs: number | null;
  /** Recorded oddities (e.g. suppressed merged proposals) — never silent. */
  notes: string[];
}

export interface Session {
  sessionId: string;
  target: SessionTargetRef;
  captureMeta: SessionCaptureMeta;
  events: SessionStrokeEvent[];
  modelVersions: {
    sessionEngine: string;
    strokeEvents: string;
    completion: string;
  };
  qualityState: SessionQualityState;
}

interface CompletionOutcome {
  closed: boolean;
  reason: Extract<SessionEventCloseReason, "settle" | "next_stroke_valley" | "safety_max"> | null;
  /** Where D-029 would end the clip (diagnostic; canonical endMs stays the
   * proposal's — bounds are stroke-event-2's job, timing is D-029's). */
  adaptiveEndMs: number | null;
}

/**
 * D-029 ADAPTIVE completion scan, mirrored from eventCompletionBench.ts
 * L105–L142: trigger = the RAW wrist-speed peak inside the event's bounds
 * (the bench used the labeled event; the engine uses the proposed one),
 * then settle-or-valley-or-safety on the samples after the trigger.
 */
function adaptiveCompletion(
  speeds: readonly SpeedSample[],
  event: { startMs: number; endMs: number },
): CompletionOutcome {
  const pool = speeds.filter(
    (sample) => sample.timestampMs >= event.startMs && sample.timestampMs <= event.endMs,
  );
  if (pool.length === 0) return { closed: false, reason: null, adaptiveEndMs: null };
  const peak = pool.reduce((best, sample) => (sample.value > best.value ? sample : best));
  const trigger = peak.timestampMs;
  const settleThreshold = Math.max(
    SESSION_COMPLETION.settleFloor,
    SESSION_COMPLETION.settlePeakFraction * peak.value,
  );
  let quietSince: number | null = null;
  let valley: SpeedSample | null = null;
  for (const sample of speeds) {
    if (sample.timestampMs < trigger) continue;
    if (sample.timestampMs < trigger + SESSION_COMPLETION.minFollowThroughMs) continue;
    if (sample.value < settleThreshold) {
      quietSince ??= sample.timestampMs;
      if (sample.timestampMs - quietSince >= SESSION_COMPLETION.settleQuietMs) {
        return { closed: true, reason: "settle", adaptiveEndMs: sample.timestampMs };
      }
    } else {
      quietSince = null;
    }
    if (
      sample.value < SESSION_COMPLETION.valleyDipFraction * peak.value &&
      (valley === null || sample.value < valley.value)
    ) {
      valley = sample;
    }
    if (
      valley &&
      sample.value >=
        Math.max(settleThreshold * 2, SESSION_COMPLETION.valleyRiseRatio * valley.value) &&
      sample.timestampMs > valley.timestampMs + SESSION_COMPLETION.valleyMinDwellMs
    ) {
      return { closed: true, reason: "next_stroke_valley", adaptiveEndMs: valley.timestampMs };
    }
    if (sample.timestampMs > trigger + SESSION_COMPLETION.safetyMaxMs) {
      return {
        closed: true,
        reason: "safety_max",
        adaptiveEndMs: trigger + SESSION_COMPLETION.safetyMaxMs,
      };
    }
  }
  // Stream still short of any condition — stay open and keep listening
  // (the bench's "ran out of replay data" fallback is not a live outcome;
  // the caller's flush() handles end-of-recording).
  return { closed: false, reason: null, adaptiveEndMs: null };
}

export class SessionEventEngine {
  /** Trailing reconciliation window of the wrist/paddle streams (sorted). */
  private readonly wrist: SpeedSample[] = [];
  private readonly paddle: SpeedSample[] = [];
  private readonly events: SessionStrokeEvent[] = [];
  private frontierMs = Number.NEGATIVE_INFINITY;
  private droppedLateSamples = 0;
  private acceptedWristSamples = 0;
  private acceptedPaddleSamples = 0;
  /** What the samples trimmed from the window still contribute to the batch
   * (see StrokeEventStreamPrefix); samples older than `windowCutoffMs` have
   * been trimmed (or, arriving late, are folded/dropped the same way). */
  private wristLeadIn: SpeedSample | null = null;
  private wristPeakSmoothedFloor = 0;
  private paddleLeadIn: SpeedSample | null = null;
  private paddlePeakSmoothedFloor = 0;
  private paddlePeakFloor: number | null = null;
  private windowCutoffMs = Number.NEGATIVE_INFINITY;
  /** Full-stream spans (accepted samples), for the paddle coverage gate. */
  private firstWristMs = Number.POSITIVE_INFINITY;
  private firstPaddleMs = Number.POSITIVE_INFINITY;
  private lastPaddleMs = Number.NEGATIVE_INFINITY;
  /** Start of the earliest still-open candidate after the last reconcile. */
  private openCandidateStartMs: number | null = null;
  /** Highest peakSpeed of any wrist-sourced proposal the batch has ever
   * made, and the same over proposals prominent enough for the low-amplitude
   * tier: whether the full series would still hold a body proposal (and so
   * never fall back to the paddle) once the window holds none. */
  private pastWristPeak = 0;
  private pastProminentWristPeak = 0;
  private paddleFallbackActive = false;
  private readonly notes: string[] = [];
  private readonly suppressionNoted = new Set<number>();
  private readonly retroNoted = new Set<string>();
  /** Emitted events whose start has left the window: wrist-sourced ones
   * ascending by peakSpeed (judged against the global-peak floor),
   * paddle-sourced ones (judged by the full-series source). */
  private readonly retroPending: SessionStrokeEvent[] = [];
  private readonly retroPendingPaddle: SessionStrokeEvent[] = [];
  /** Index of the first emitted event whose start is still inside the window. */
  private retroWindowCursor = 0;

  constructor(
    private readonly options: {
      sessionId: string;
      target?: Partial<SessionTargetRef>;
      captureMeta?: Partial<SessionCaptureMeta>;
    },
  ) {}

  /**
   * Feed incremental samples (any batch size ≥ 1; recording never stops).
   * Returns the events that CLOSED because of this push, in time order —
   * the caller dispatches per-event analysis from exactly this return.
   */
  push(input: {
    wrist?: readonly SpeedSample[];
    paddle?: readonly SpeedSample[];
  }): SessionStrokeEvent[] {
    for (const sample of input.paddle ?? []) {
      if (!Number.isFinite(sample.timestampMs) || !Number.isFinite(sample.value)) continue;
      this.acceptedPaddleSamples += 1;
      this.firstPaddleMs = Math.min(this.firstPaddleMs, sample.timestampMs);
      this.lastPaddleMs = Math.max(this.lastPaddleMs, sample.timestampMs);
      if (sample.timestampMs < this.windowCutoffMs) {
        // Behind the window: can only feed the confirm normalization.
        this.paddlePeakFloor = Math.max(this.paddlePeakFloor ?? 0, sample.value);
        continue;
      }
      insertSorted(this.paddle, sample);
    }
    for (const sample of input.wrist ?? []) {
      if (!Number.isFinite(sample.timestampMs) || !Number.isFinite(sample.value)) continue;
      if (sample.timestampMs <= this.frontierMs || sample.timestampMs < this.windowCutoffMs) {
        // Late data behind the frontier (or behind the reconciliation
        // window) could only rewrite closed events.
        this.droppedLateSamples += 1;
        continue;
      }
      this.acceptedWristSamples += 1;
      this.firstWristMs = Math.min(this.firstWristMs, sample.timestampMs);
      insertSorted(this.wrist, sample);
    }
    const emitted = this.reconcile(false);
    this.trimWindow();
    return emitted;
  }

  /** Convenience for one-sample-per-frame live feeding. */
  pushWristSample(sample: SpeedSample): SessionStrokeEvent[] {
    return this.push({ wrist: [sample] });
  }

  /**
   * End of recording (user stopped the session). Closes every remaining
   * candidate: with its D-029 reason when a condition already held inside
   * the available samples (only the bound-stability wait was pending),
   * otherwise as an explicit "flush".
   */
  flush(): SessionStrokeEvent[] {
    return this.reconcile(true);
  }

  /** The still-open trailing candidate, for live UI ("stroke in progress").
   * Never emitted from here; bounds may still move until closure. */
  activeProposal(): StrokeEventProposalV2 | null {
    const batch = this.propose();
    const open = batch.filter((event) => event.peakMs > this.frontierMs);
    return open.length > 0 ? { ...open[open.length - 1]! } : null;
  }

  /** Immutable-ish view of the session (events/proposals copied). */
  snapshot(): Session {
    return {
      sessionId: this.options.sessionId,
      target: {
        trackId: this.options.target?.trackId ?? null,
        seedMode: this.options.target?.seedMode ?? null,
        lockedAtMs: this.options.target?.lockedAtMs ?? null,
        confidence: this.options.target?.confidence ?? null,
      },
      captureMeta: {
        startedAtIso: this.options.captureMeta?.startedAtIso ?? null,
        fps: this.options.captureMeta?.fps ?? null,
        source: this.options.captureMeta?.source ?? "live",
      },
      events: this.events.map((event) => ({ ...event, proposal: { ...event.proposal } })),
      modelVersions: {
        sessionEngine: SESSION_ENGINE_VERSION,
        strokeEvents: STROKE_EVENT_VERSION_2,
        completion:
          "adaptive-completion (D-029 settle-or-valley-or-safety; constants mirrored from eventCompletionBench.ts)",
      },
      qualityState: {
        wristSamples: this.acceptedWristSamples + this.droppedLateSamples,
        paddleSamples: this.acceptedPaddleSamples,
        droppedLateSamples: this.droppedLateSamples,
        lastSampleMs: this.lastSampleMs(),
        notes: [...this.notes],
      },
    };
  }

  /** Per-event analysis lifecycle. The PROPOSAL is frozen; only the analysis
   * slot and state may move (pending → processing → ready|abstained, with an
   * honest processing → pending revert when analysis could not start).
   * `ready` and `abstained` are TERMINAL: a second outcome signal for the
   * same event is a caller bug and throws instead of rewriting history.
   * `ready` requires a real AnalysisRecord — an event can never be counted
   * as analyzed without one. */
  markEvent(
    eventId: string,
    state: SessionEventState,
    outcome?: { analysis?: AnalysisRecord | null; abstainReason?: string | null },
  ): SessionStrokeEvent {
    const event = this.events.find((entry) => entry.eventId === eventId);
    if (!event) throw new Error(`unknown session event '${eventId}'`);
    if (event.state === "ready" || event.state === "abstained") {
      throw new Error(
        `session event '${eventId}' is already terminal ('${event.state}') — ` +
          `per-event outcomes are append-only and cannot be rewritten (got '${state}')`,
      );
    }
    if (state === "pending" && event.state !== "processing") {
      throw new Error(
        `session event '${eventId}' cannot revert to 'pending' from '${event.state}'`,
      );
    }
    if (state === "ready" && !outcome?.analysis) {
      throw new Error(
        `session event '${eventId}' cannot be marked 'ready' without an AnalysisRecord — ` +
          `an unanalyzed event must stay pending/processing or abstain`,
      );
    }
    event.state = state;
    if (outcome?.analysis !== undefined) event.analysis = outcome.analysis;
    if (outcome?.abstainReason !== undefined) event.abstainReason = outcome.abstainReason;
    return event;
  }

  /** Read-only per-event state lookup (for callers that must not risk a
   * terminal-overwrite throw before deciding whether to record an outcome). */
  eventState(eventId: string): SessionEventState | null {
    return this.events.find((entry) => entry.eventId === eventId)?.state ?? null;
  }

  private lastSampleMs(): number | null {
    const last = this.wrist[this.wrist.length - 1]?.timestampMs;
    return last ?? null;
  }

  /** Canonical proposals over the reconciliation window (stroke-event-2).
   * Clip bounds are the observed sample span — in proposeStrokeEventsV2 they
   * only gate coverage, so a live session (full coverage by construction)
   * sees identical events to the offline batch run; `streamPrefix` carries
   * what the trimmed samples still contribute. */
  private propose(): StrokeEventProposalV2[] {
    if (this.wrist.length < MIN_WINDOW_SAMPLES) return [];
    const hasPaddle = this.paddle.length > 0 || this.paddlePeakFloor !== null;
    const clipStartMs = this.wrist[0]!.timestampMs;
    const clipEndMs = this.wrist[this.wrist.length - 1]!.timestampMs;
    const batch = proposeStrokeEventsV2({
      paddleSpeeds: this.paddle.length > 0 ? this.paddle : null,
      wristSpeeds: this.wrist,
      clipStartMs,
      clipEndMs,
      streamPrefix:
        this.wristLeadIn === null && !hasPaddle
          ? undefined
          : {
              wrist:
                this.wristLeadIn === null
                  ? null
                  : {
                      coverage: 1,
                      leadIn: this.wristLeadIn,
                      peakSmoothedSpeed: this.wristPeakSmoothedFloor,
                    },
              paddle: hasPaddle
                ? {
                    coverage:
                      this.acceptedPaddleSamples < 4
                        ? 0
                        : (this.lastPaddleMs - this.firstPaddleMs) /
                          (clipEndMs - this.firstWristMs),
                    leadIn: this.paddleLeadIn,
                    peakSmoothedSpeed: this.paddlePeakSmoothedFloor,
                  }
                : null,
              paddlePeakSpeed: this.paddlePeakFloor,
            },
    });
    if (batch.source === "wrist") {
      // A peak is a settled proposal once two samples follow it (its own
      // smoothed value and its right neighbour's are final); one at the
      // stream's edge may still turn out to be a rising flank.
      const lastMs = this.wrist[this.wrist.length - 1]!.timestampMs;
      const settledBeforeMs = this.wrist[this.wrist.length - 2]!.timestampMs;
      for (const event of batch.events) {
        if (event.peakMs >= settledBeforeMs) continue;
        this.pastWristPeak = Math.max(this.pastWristPeak, event.peakSpeed);
        // Prominence is final once its ±1.5s baseline context has arrived.
        if (
          event.endMs + BASELINE_CONTEXT_MS <= lastMs &&
          event.prominence >= LOW_AMPLITUDE_GATES.minProminence
        ) {
          this.pastProminentWristPeak = Math.max(this.pastProminentWristPeak, event.peakSpeed);
        }
      }
    }
    this.paddleFallbackActive = false;
    if (batch.source !== "wrist") {
      // The full series falls back to the paddle only while NO wrist peak
      // clears the current proposal floor; a trimmed body proposal that
      // still clears it keeps the fallback shut.
      const relativeFloor = this.globalWristPeak() * EVENT_GATES.minPeakFractionOfMax;
      const floor = Math.max(EVENT_GATES.minPeakSpeed, relativeFloor);
      const lowFloor = Math.max(LOW_AMPLITUDE_GATES.minPeakSpeed, relativeFloor);
      const bodyHeld = this.pastWristPeak >= floor || this.pastProminentWristPeak >= lowFloor;
      if (batch.source === "paddle_fallback") {
        if (bodyHeld) return [];
        this.paddleFallbackActive = true;
      } else if (hasPaddle && !bodyHeld) {
        // Body empty over the full series too: trimmed paddle peaks may be
        // sourcing the full-series batch.
        this.paddleFallbackActive = true;
      }
    }
    return batch.events;
  }

  /**
   * Drop the samples no current or future proposal can depend on (see
   * "BOUNDED RECONCILIATION WINDOW"), folding their contribution into the
   * stream prefix. Runs after every reconcile.
   */
  private trimWindow(): void {
    const lastMs = this.lastSampleMs();
    if (lastMs === null) return;
    // A peak can only (still) become, or change, a proposal while the stream
    // is within the reach cap of it; its start walks at most the reach cap
    // back. Everything chained to such a live peak stays with it.
    const openStartMs = this.openCandidateStartMs ?? Number.POSITIVE_INFINITY;
    const livePeakFromMs = Math.min(openStartMs, lastMs - BOUND_STABILITY_MS);
    let keepFromMs = Math.min(
      openStartMs,
      lastMs - 2 * BOUND_STABILITY_MS,
      chainStartMs(
        this.wrist,
        this.wristLeadIn,
        this.wristPeakSmoothedFloor,
        livePeakFromMs,
        lastMs,
      ),
    );
    if (this.paddle.length > 0) {
      // A paddle peak past the frontier is a dormant fallback proposal: it
      // becomes a candidate the moment body proposals disappear, however
      // much later, so it (and its glue reach behind the frontier) stays.
      keepFromMs = Math.min(
        keepFromMs,
        chainStartMs(
          this.paddle,
          this.paddleLeadIn,
          this.paddlePeakSmoothedFloor,
          Math.min(livePeakFromMs, this.frontierMs - BOUND_STABILITY_MS),
          lastMs,
        ),
      );
    }
    // The window must be chain-closed: a peak kept for context would
    // resurface as its own proposal if the peak that silences it were cut.
    let cutoffMs = keepFromMs - BASELINE_CONTEXT_MS;
    for (;;) {
      let closedFromMs = chainStartMs(
        this.wrist,
        this.wristLeadIn,
        this.wristPeakSmoothedFloor,
        cutoffMs,
        lastMs,
      );
      if (this.paddle.length > 0) {
        closedFromMs = Math.min(
          closedFromMs,
          chainStartMs(
            this.paddle,
            this.paddleLeadIn,
            this.paddlePeakSmoothedFloor,
            cutoffMs,
            lastMs,
          ),
        );
      }
      if (closedFromMs >= keepFromMs) break;
      keepFromMs = closedFromMs;
      cutoffMs = keepFromMs - BASELINE_CONTEXT_MS;
    }
    let drop = 0;
    while (drop < this.wrist.length && this.wrist[drop]!.timestampMs < cutoffMs) drop += 1;
    drop = Math.min(drop, this.wrist.length - MIN_WINDOW_SAMPLES);
    if (drop > 0) {
      for (let index = 0; index < drop; index += 1) {
        this.wristPeakSmoothedFloor = Math.max(
          this.wristPeakSmoothedFloor,
          smoothedAt(this.wrist, this.wristLeadIn, index),
        );
      }
      this.wristLeadIn = this.wrist[drop - 1]!;
      this.wrist.splice(0, drop);
      this.windowCutoffMs = cutoffMs;
      let paddleDrop = 0;
      while (paddleDrop < this.paddle.length && this.paddle[paddleDrop]!.timestampMs < cutoffMs) {
        this.paddlePeakFloor = Math.max(this.paddlePeakFloor ?? 0, this.paddle[paddleDrop]!.value);
        this.paddlePeakSmoothedFloor = Math.max(
          this.paddlePeakSmoothedFloor,
          smoothedAt(this.paddle, this.paddleLeadIn, paddleDrop),
        );
        paddleDrop += 1;
      }
      if (paddleDrop > 0) {
        this.paddleLeadIn = this.paddle[paddleDrop - 1]!;
        this.paddle.splice(0, paddleDrop);
      }
    }
    // The retro floor check must see every push: the stream edge's 2-sample
    // smoothing can lift the global peak for a single push.
    this.retireRetroChecks();
  }

  /** The full series' global smoothed wrist peak: carried floor + window. */
  private globalWristPeak(): number {
    let globalPeak = this.wristPeakSmoothedFloor;
    for (let index = 0; index < this.wrist.length; index += 1) {
      globalPeak = Math.max(globalPeak, smoothedAt(this.wrist, this.wristLeadIn, index));
    }
    return globalPeak;
  }

  private reconcile(flush: boolean): SessionStrokeEvent[] {
    const emitted: SessionStrokeEvent[] = [];
    const lastMs = this.lastSampleMs();
    if (lastMs === null) return emitted;
    // Loop: emitting a candidate moves the frontier, which can make the next
    // candidate immediately closable within the same push.
    for (;;) {
      const batch = this.propose();
      this.noteSuppressedMergers(batch);
      this.noteRetroSubthreshold(batch);
      const candidates = batch.filter((event) => event.peakMs > this.frontierMs);
      const candidate = candidates[0];
      this.openCandidateStartMs = candidate?.startMs ?? null;
      if (!candidate) break;
      const hasNewerCandidate = candidates.length > 1;
      const completion = adaptiveCompletion(this.wrist, candidate);
      let reason: SessionEventCloseReason | null = null;
      if (hasNewerCandidate) {
        // The next stroke already crested as its own proposal: the batch has
        // midpoint-clamped the shared boundary, so bounds are final. Close
        // with the D-029 reason when one fired, else record the distinct
        // "next_event_proposed" outcome.
        reason = completion.closed ? completion.reason : "next_event_proposed";
      } else if (completion.closed && completion.reason === "safety_max") {
        // trigger+2500 is beyond the ±1200ms boundary reach — bounds stable.
        reason = "safety_max";
      } else if (completion.closed && lastMs >= candidate.peakMs + BOUND_STABILITY_MS) {
        // Settle/valley on the trailing candidate: wait for the boundary
        // reach cap so no future sample can still relax the end bound.
        reason = completion.reason;
      } else if (flush) {
        reason = completion.closed ? completion.reason : "flush";
      }
      if (!reason) break;
      const eventId = `E${this.events.length + 1}`;
      const proposal: StrokeEventProposalV2 = Object.freeze({ ...candidate, eventId });
      const event: SessionStrokeEvent = {
        eventId,
        proposal,
        closedAtMs: lastMs,
        closeReason: reason,
        state: "pending",
        analysis: null,
        abstainReason: null,
      };
      this.events.push(event);
      emitted.push(event);
      this.frontierMs = Math.max(this.frontierMs, proposal.endMs);
    }
    return emitted;
  }

  /**
   * CAUSAL vs ACAUSAL divergence, recorded — never silent. strokeEvents.ts
   * only proposes peaks ≥ max(0.5, 30% of the GLOBAL smoothed peak); in a
   * live stream the global peak only grows, so a weak early stroke that was
   * a valid proposal when it closed can be retro-suppressed from later
   * full-series batch runs by a much stronger stroke (measured on
   * afn-sasebo-rally2: a 0.60 u/s movement at 67–1401ms vanishes once the
   * 6.87 u/s stroke arrives). The emitted event stays (append-only; it was
   * proposed over all evidence available at close time) and is flagged for
   * downstream confidence handling.
   */
  private noteRetroSubthreshold(batch: readonly StrokeEventProposalV2[]): void {
    // Only events whose span the window still holds can be judged against
    // the batch; older ones are judged against the carried floor (see
    // retireRetroChecks).
    for (let index = this.retroWindowCursor; index < this.events.length; index += 1) {
      const event = this.events[index]!;
      if (this.retroNoted.has(event.eventId)) continue;
      const stillProposed = batch.some(
        (proposal) =>
          proposal.peakMs >= event.proposal.startMs - 1 &&
          proposal.peakMs <= event.proposal.endMs + 1,
      );
      if (stillProposed) continue;
      this.noteRetro(event);
    }
  }

  /** Events whose start has left the window move to the floor-judged set;
   * any of them now under 30% of the global peak (carried floor + window) is
   * retro-suppressed exactly as the full-series batch would have dropped it. */
  private retireRetroChecks(): void {
    const windowStartMs = this.wrist[0]!.timestampMs;
    while (
      this.retroWindowCursor < this.events.length &&
      this.events[this.retroWindowCursor]!.proposal.startMs <= windowStartMs
    ) {
      const event = this.events[this.retroWindowCursor]!;
      this.retroWindowCursor += 1;
      if (this.retroNoted.has(event.eventId)) continue;
      if (event.proposal.source === "paddle") {
        this.retroPendingPaddle.push(event);
        continue;
      }
      let low = 0;
      let high = this.retroPending.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (this.retroPending[mid]!.proposal.peakSpeed <= event.proposal.peakSpeed) low = mid + 1;
        else high = mid;
      }
      this.retroPending.splice(low, 0, event);
    }
    // While the full series is in paddle fallback, the batch judges emitted
    // events by paddle proposals, not the wrist floor; the verdict is
    // deferred to the next wrist-sourced push — which no longer proposes any
    // paddle-sourced event at all.
    if (this.paddleFallbackActive) return;
    while (this.retroPendingPaddle.length > 0) this.noteRetro(this.retroPendingPaddle.shift()!);
    if (this.retroPending.length === 0) return;
    const floor = this.globalWristPeak() * EVENT_GATES.minPeakFractionOfMax;
    while (this.retroPending.length > 0 && this.retroPending[0]!.proposal.peakSpeed < floor) {
      this.noteRetro(this.retroPending.shift()!);
    }
  }

  private noteRetro(event: SessionStrokeEvent): void {
    this.retroNoted.add(event.eventId);
    this.notes.push(
      `SESSION_EVENT_RETRO_SUPPRESSED: ${event.eventId} (peak ${event.proposal.peakSpeed.toFixed(2)} u/s ` +
        `at ${Math.round(event.proposal.peakMs)}ms) is no longer proposed by the full-series batch ` +
        `(a later stroke raised the relative proposal floor); kept append-only, flagged`,
    );
  }

  /** A batch proposal whose peak sits at/before the frontier is the same
   * movement as an emitted event; if it now stretches well past the frontier
   * it can never be re-emitted (append-only) — record that, once. */
  private noteSuppressedMergers(batch: readonly StrokeEventProposalV2[]): void {
    for (const proposal of batch) {
      if (proposal.peakMs > this.frontierMs) continue;
      if (proposal.endMs <= this.frontierMs + 500) continue;
      const key = Math.round(proposal.peakMs);
      if (this.suppressionNoted.has(key)) continue;
      this.suppressionNoted.add(key);
      this.notes.push(
        `SESSION_SUPPRESSED_MERGED_PROPOSAL: batch proposal at peak ${key}ms extends ` +
          `${Math.round(proposal.endMs - this.frontierMs)}ms past the closed-event frontier; ` +
          `closed events are append-only and were not re-bounded`,
      );
    }
  }
}

/**
 * The earliest sample time the batch's proposals from `liveFromMs` on can
 * still depend on, over one speed series: the start bound of the oldest peak
 * CHAINED to a live one. Every way the batch lets one peak decide another's
 * fate needs the two to be chained — consecutive activity peaks (smoothed
 * local maxima at/above the low-amplitude floor) are chained when their
 * relaxed spans touch or glue (≤ GLUE_GATES.maxGapMs apart: overlap drops,
 * low-tier suppression, fragment glue, midpoint clamps) or, for two peaks at
 * the proposal floor, when the smoothed speed between them never dips to 60%
 * of the weaker (they would merge into one peak). Both links can only break,
 * never form, as the floors rise, so a break stays a break. The series edge
 * counts as a peak that may still crest at the proposal floor while it is
 * within reach of the stream's last sample; the chain is never followed
 * further back than CHAIN_RETENTION_CAP_MS.
 */
function chainStartMs(
  series: readonly SpeedSample[],
  leadIn: SpeedSample | null,
  peakSmoothedFloor: number,
  liveFromMs: number,
  streamLastMs: number,
): number {
  const length = series.length;
  if (length === 0) return Number.POSITIVE_INFINITY;
  const smoothed = series.map((_, index) => smoothedAt(series, leadIn, index));
  // The edge sample's smoothed value is provisional (its right neighbour has
  // not arrived) and may still fall; only settled values may raise the floor.
  const globalPeak = smoothed
    .slice(0, -1)
    .reduce((best, value) => Math.max(best, value), peakSmoothedFloor);
  const relativeFloor = globalPeak * EVENT_GATES.minPeakFractionOfMax;
  const threshold = Math.max(EVENT_GATES.minPeakSpeed, relativeFloor);
  const lowThreshold = Math.max(LOW_AMPLITUDE_GATES.minPeakSpeed, relativeFloor);
  const reach = (index: number, value: number): { startMs: number; endMs: number } => {
    const relax = Math.max(RELAXATION_PEAK_FRACTION * value, RELAXATION_FLOOR);
    const peakMs = series[index]!.timestampMs;
    let start = index;
    while (
      start > 0 &&
      smoothed[start - 1]! >= relax &&
      peakMs - series[start - 1]!.timestampMs <= BOUND_STABILITY_MS
    ) {
      start -= 1;
    }
    let end = index;
    while (
      end < length - 1 &&
      smoothed[end + 1]! >= relax &&
      series[end + 1]!.timestampMs - peakMs <= BOUND_STABILITY_MS
    ) {
      end += 1;
    }
    return { startMs: series[start]!.timestampMs, endMs: series[end]!.timestampMs };
  };
  const peaks: Array<{ index: number; value: number; startMs: number; endMs: number }> = [];
  for (let index = 1; index < length - 1; index += 1) {
    const value = smoothed[index]!;
    if (value < lowThreshold) continue;
    if (value >= smoothed[index - 1]! && value > smoothed[index + 1]!) {
      peaks.push({ index, value, ...reach(index, value) });
    }
  }
  const edge = length - 1;
  if (series[edge]!.timestampMs >= streamLastMs - BOUND_STABILITY_MS) {
    peaks.push({ index: edge, value: threshold, ...reach(edge, 0) });
  } else if (smoothed[edge]! >= lowThreshold && smoothed[edge]! >= smoothed[edge - 1]!) {
    peaks.push({ index: edge, value: smoothed[edge]!, ...reach(edge, smoothed[edge]!) });
  }
  if (peaks.length === 0) return series[edge]!.timestampMs;
  let head = peaks.findIndex((peak) => series[peak.index]!.timestampMs >= liveFromMs);
  if (head < 0) head = peaks.length - 1;
  // Peak merging skips sub-floor peaks: the valley is judged between the
  // chain's earliest proposal-floor peak and the nearest one before the chain.
  let floorHead = head;
  while (floorHead < peaks.length && peaks[floorHead]!.value < threshold) floorHead += 1;
  while (head > 0) {
    if (series[peaks[head]!.index]!.timestampMs < streamLastMs - CHAIN_RETENTION_CAP_MS) break;
    if (peaks[head]!.startMs <= peaks[head - 1]!.endMs + GLUE_GATES.maxGapMs) {
      head -= 1;
      if (peaks[head]!.value >= threshold) floorHead = head;
      continue;
    }
    if (floorHead >= peaks.length) break;
    let previous = head - 1;
    while (previous >= 0 && peaks[previous]!.value < threshold) previous -= 1;
    if (previous < 0) break;
    let valley = Number.POSITIVE_INFINITY;
    for (let index = peaks[previous]!.index; index <= peaks[floorHead]!.index; index += 1) {
      valley = Math.min(valley, smoothed[index]!);
    }
    const weaker = Math.min(peaks[previous]!.value, peaks[floorHead]!.value);
    if (valley <= EVENT_GATES.mergeValleyFraction * weaker) break;
    head = previous;
    floorHead = previous;
  }
  let startMs = Number.POSITIVE_INFINITY;
  for (let index = head; index < peaks.length; index += 1) {
    startMs = Math.min(startMs, peaks[index]!.startMs);
  }
  return startMs;
}

/** Full-series 3-sample smoothed value of window sample `index` (the lead-in
 * stands in for the trimmed left neighbour of the first sample). */
function smoothedAt(
  series: readonly SpeedSample[],
  leadIn: SpeedSample | null,
  index: number,
): number {
  const left = index === 0 ? leadIn : series[index - 1]!;
  const right = series[index + 1];
  const sum = (left?.value ?? 0) + series[index]!.value + (right?.value ?? 0);
  return sum / ((left ? 1 : 0) + 1 + (right ? 1 : 0));
}

function insertSorted(series: SpeedSample[], sample: SpeedSample): void {
  const last = series[series.length - 1];
  if (!last || sample.timestampMs >= last.timestampMs) {
    series.push({ ...sample });
    return;
  }
  let low = 0;
  let high = series.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (series[mid]!.timestampMs <= sample.timestampMs) low = mid + 1;
    else high = mid;
  }
  series.splice(low, 0, { ...sample });
}
