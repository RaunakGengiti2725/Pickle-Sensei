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
}

export type TargetEventSelection =
  | { status: "selected"; event: StrokeEventProposal; via: "contact" | "prominence" | "paddle_confirmation" }
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

export function proposeStrokeEvents(input: {
  paddleSpeeds: ReadonlyArray<{ timestampMs: number; value: number }> | null;
  wristSpeeds: ReadonlyArray<{ timestampMs: number; value: number }> | null;
  clipStartMs: number;
  clipEndMs: number;
}): { events: StrokeEventProposal[]; source: "paddle" | "wrist" | "none" } {
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
  // Light smoothing (3-sample) to suppress single-frame jitter.
  const smoothed = sorted.map((sample, index) => {
    const window = sorted.slice(Math.max(0, index - 1), index + 2);
    return {
      timestampMs: sample.timestampMs,
      value: window.reduce((total, entry) => total + entry.value, 0) / window.length,
    };
  });
  const globalPeak = smoothed.reduce((best, sample) => Math.max(best, sample.value), 0);
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
      EVENT_GATES.mergeValleyFraction *
        Math.min(smoothed[previous]!.value, smoothed[peak]!.value);
    if (shallow) {
      if (smoothed[peak]!.value > smoothed[previous]!.value) merged[merged.length - 1] = peak;
    } else {
      merged.push(peak);
    }
  }

  const events: StrokeEventProposal[] = [];
  for (const peakIndex of merged) {
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
    if (endMs - startMs < EVENT_GATES.minEventSpanMs) continue;
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
    events.push({
      eventId: "", // assigned after time-ordering below
      startMs,
      peakMs,
      endMs,
      peakSpeed: peakValue,
      prominence,
      source,
      confidence: Math.max(0.2, Math.min(0.9, 0.4 + (prominence - 1) * 0.12)),
    });
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
  paddleSpeeds: ReadonlyArray<{ timestampMs: number; value: number }> | null;
  wristSpeeds: ReadonlyArray<{ timestampMs: number; value: number }> | null;
  clipStartMs: number;
  clipEndMs: number;
}): { events: StrokeEventProposalV2[]; source: "wrist" | "paddle_fallback" | "none" } {
  const body = proposeStrokeEvents({
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
  const glued: StrokeEventProposal[] = [];
  for (const event of body.events) {
    const previous = glued[glued.length - 1];
    if (previous && event.startMs - previous.endMs <= 350) {
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
  if (input.wristSpeeds && input.wristSpeeds.length >= 4) {
    const sorted = [...input.wristSpeeds].sort((a, b) => a.timestampMs - b.timestampMs);
    const smoothed = sorted.map((sample, index) => {
      const window = sorted.slice(Math.max(0, index - 1), index + 2);
      return {
        timestampMs: sample.timestampMs,
        value: window.reduce((total, entry) => total + entry.value, 0) / window.length,
      };
    });
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
    source === "wrist" ? (input.paddleSpeeds ?? []).slice().sort((a, b) => a.timestampMs - b.timestampMs) : [];
  const paddleMax = paddle.reduce((best, sample) => Math.max(best, sample.value), 0);
  const events: StrokeEventProposalV2[] = baseEvents.map((event) => {
    const inside = paddle.filter(
      (sample) => sample.timestampMs >= event.startMs - 80 && sample.timestampMs <= event.endMs + 80,
    );
    let paddlePeakMs: number | null = null;
    let bestInside = 0;
    for (const sample of inside) {
      if (sample.value > bestInside) {
        bestInside = sample.value;
        paddlePeakMs = sample.timestampMs;
      }
    }
    const decisive = paddleMax > 0 && bestInside >= 0.5 * paddleMax && bestInside >= EVENT_GATES.minPeakSpeed;
    const some = bestInside >= EVENT_GATES.minPeakSpeed * 0.6;
    const paddleSupport = decisive ? 1 : some ? 0.5 : 0;
    const paddleConfirmed = decisive;
    // Refine the interior peak toward the paddle peak (contact vicinity) —
    // boundaries stay body-defined so the movement identity cannot shift.
    const refinedPeakMs =
      paddleConfirmed && paddlePeakMs !== null && Math.abs(paddlePeakMs - event.peakMs) <= 250
        ? paddlePeakMs
        : event.peakMs;
    const confidence = Math.max(
      0.15,
      Math.min(
        0.95,
        event.confidence + 0.15 * paddleSupport - (paddle.length > 0 && paddleSupport === 0 ? 0.1 : 0),
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
    return { status: "selected", event: confirmed[0]!, via: "paddle_confirmation" };
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
    // Contact outside all events: fall through to prominence with a flag —
    // callers should treat this as suspicious.
  }
  if (events.length === 1) {
    return { status: "selected", event: events[0]!, via: "prominence" };
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
  return { status: "selected", event: byProminence[0]!, via: "prominence" };
}
