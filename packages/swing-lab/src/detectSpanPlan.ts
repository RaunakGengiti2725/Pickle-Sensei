/**
 * Detector-span planning — how much video the expensive paddle detector
 * processes.
 *
 * HULL (default, exact legacy math from analyzeVideo.ts): one contiguous
 * span from the padded union hull of the pose pre-pass events, floored to a
 * minimum length and clamped to the stroke window. Between two distant
 * events the hull also covers the dead time separating them — frames no
 * plausible event neighborhood needs.
 *
 * TIGHT (behind --tight-window): one padded+floored segment PER pre-pass
 * event, merged when they touch, each clamped to the hull. The union is a
 * subset of the hull by construction, so with a single merged segment the
 * plan is IDENTICAL to the hull (same math, same clamps) and every stage
 * output is unchanged; frames are only ever saved in the gaps between
 * well-separated events. Every event keeps its full pad and floor, so a
 * boundary the hull covered near an event is still covered — the plan can
 * never trim an event's own neighborhood, only inter-event dead time.
 */

import { toLegacyPoseFrames, type PoseSequence } from "@pickle/swing-domain";

export const DETECT_SPAN_PLAN_VERSION = "detect-span-plan-1";

/** Dominant-wrist speed series (normalized u/s) from the pose sequence —
 * the pipeline's pre-pass input (moved verbatim from analyzeVideo.ts). */
export function dominantWristSpeeds(
  sequence: PoseSequence,
  window: { startMs: number; endMs: number },
): Array<{ timestampMs: number; value: number }> {
  // Choose the wrist with more total travel inside the window.
  const travel = { left: 0, right: 0 };
  const last: Record<string, { x: number; y: number } | undefined> = {};
  const perWrist: Record<"left" | "right", Array<{ timestampMs: number; value: number }>> = {
    left: [],
    right: [],
  };
  const legacy = toLegacyPoseFrames(sequence);
  for (const frame of legacy) {
    for (const sideName of ["left", "right"] as const) {
      const mark = frame.landmarks.find(
        (landmark) => landmark.name === `${sideName}_wrist` && landmark.visibility >= 0.25,
      );
      if (!mark) continue;
      const prior = last[sideName];
      if (prior) {
        const dtSec =
          perWrist[sideName].length > 0
            ? (frame.timestampMs - perWrist[sideName][perWrist[sideName].length - 1]!.timestampMs) /
              1000
            : 0.04;
        const step = Math.hypot(mark.x - prior.x, mark.y - prior.y);
        if (dtSec > 0 && dtSec <= 0.15) {
          perWrist[sideName].push({ timestampMs: frame.timestampMs, value: step / dtSec });
          if (frame.timestampMs >= window.startMs && frame.timestampMs <= window.endMs) {
            travel[sideName] += step;
          }
        }
      }
      last[sideName] = { x: mark.x, y: mark.y };
    }
  }
  return travel.right >= travel.left ? perWrist.right : perWrist.left;
}

/** Preparation + follow-through context around a kinematic event. */
export const EVENT_CONTEXT_PAD_MS = 600;
/** Detector-span floor: a bare peak span starves the tracker (measured:
 * 240ms span → paddle coverage 17% → UNTRACKED). */
export const MIN_DETECT_SPAN_MS = 1500;

export interface SpanSegment {
  startMs: number;
  endMs: number;
}

interface EventLike {
  startMs: number;
  endMs: number;
}

/** Pad an interval, grow it symmetrically to the floor, clamp to bounds. */
function padFloorClamp(interval: EventLike, bounds: SpanSegment): SpanSegment {
  const startMs = interval.startMs - EVENT_CONTEXT_PAD_MS;
  const endMs = interval.endMs + EVENT_CONTEXT_PAD_MS;
  const deficit = MIN_DETECT_SPAN_MS - (endMs - startMs);
  const grow = deficit > 0 ? deficit / 2 : 0;
  return {
    startMs: Math.max(bounds.startMs, startMs - grow),
    endMs: Math.min(bounds.endMs, endMs + grow),
  };
}

/**
 * Legacy hull plan — byte-for-byte the analyzeVideo.ts inline derivation:
 * pad the min..max hull of all events, floor, clamp to the stroke window;
 * no events → the whole stroke window.
 */
export function planDetectSpanHull(
  strokeWindow: SpanSegment,
  events: readonly EventLike[],
): SpanSegment {
  if (events.length === 0) return { startMs: strokeWindow.startMs, endMs: strokeWindow.endMs };
  const hull = {
    startMs: Math.min(...events.map((event) => event.startMs)),
    endMs: Math.max(...events.map((event) => event.endMs)),
  };
  const clamped = padFloorClamp(hull, strokeWindow);
  // An event hull entirely outside the stroke window clamps to an inverted
  // (empty) span, starving the detector of every frame. Fall back to the
  // whole stroke window, exactly as when no events were proposed.
  if (clamped.endMs <= clamped.startMs) {
    return { startMs: strokeWindow.startMs, endMs: strokeWindow.endMs };
  }
  return clamped;
}

/**
 * Tight plan: per-event padded+floored segments, clamped to the HULL (the
 * tight plan may never process a frame the hull plan would not), merged
 * when they overlap or touch. Sorted, disjoint, non-empty.
 */
export function planDetectSpanSegments(
  strokeWindow: SpanSegment,
  events: readonly EventLike[],
): SpanSegment[] {
  const hull = planDetectSpanHull(strokeWindow, events);
  if (events.length === 0) return [hull];
  const padded = events
    .map((event) => padFloorClamp(event, hull))
    .filter((segment) => segment.endMs > segment.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  const merged: SpanSegment[] = [];
  for (const segment of padded) {
    const previous = merged[merged.length - 1];
    if (previous && segment.startMs <= previous.endMs) {
      previous.endMs = Math.max(previous.endMs, segment.endMs);
    } else {
      merged.push({ ...segment });
    }
  }
  return merged.length > 0 ? merged : [hull];
}

/** Total covered milliseconds of a disjoint segment list. */
export function segmentsCoverageMs(segments: readonly SpanSegment[]): number {
  return segments.reduce(
    (total, segment) => total + Math.max(0, segment.endMs - segment.startMs),
    0,
  );
}
