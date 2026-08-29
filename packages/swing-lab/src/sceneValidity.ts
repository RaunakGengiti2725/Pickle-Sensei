/**
 * SCENE VALIDITY — the guard that makes every downstream claim referentially
 * honest.
 *
 * Regression origin: on `afn-vic-rally1` (original cut) the pipeline emitted a
 * ball track and a "ball-confirmed contact" inside a whiteboard INTERVIEW
 * scene — marker/hand motion satisfied the ball gates and the writer's wrist
 * peak supplied contact evidence. Nothing in the system knew the clip changed
 * shots.
 *
 * Policy: analysis happens inside ONE shot. The dominant shot (by pose-frame
 * mass) is chosen; tracks, events and contact are clipped to it; multi-shot
 * clips are flagged so capture quality degrades instead of silently mixing
 * scenes.
 */

export const SCENE_DETECTOR_VERSION = "luma-histogram-chi2-1";

export interface ScenesFile {
  schemaVersion: 1;
  detector: string;
  cuts: number[];
  segments: Array<{ startMs: number; endMs: number }>;
  scores: Array<{ t: number; d: number }>;
}

export interface SceneDecision {
  multiShot: boolean;
  cutCount: number;
  cuts: number[];
  /** The shot analysis is restricted to. */
  analysisSegment: { startMs: number; endMs: number };
  segments: Array<{ startMs: number; endMs: number }>;
  risks: string[];
}

/**
 * Choose the analysis shot: the segment holding the most pose frames (the
 * gameplay shot in practice), with a minimum-duration guard so a 100ms flash
 * cannot become "the scene".
 */
export function decideScene(
  scenes: ScenesFile,
  poseTimestampsMs: readonly number[],
  minSegmentMs = 700,
): SceneDecision {
  const risks: string[] = [];
  const usable = scenes.segments.filter(
    (segment) => segment.endMs - segment.startMs >= minSegmentMs,
  );
  const segments = usable.length > 0 ? usable : scenes.segments;
  let best = segments[0]!;
  let bestMass = -1;
  for (const segment of segments) {
    const mass = poseTimestampsMs.filter(
      (timestamp) => timestamp >= segment.startMs && timestamp < segment.endMs,
    ).length;
    if (mass > bestMass) {
      bestMass = mass;
      best = segment;
    }
  }
  const multiShot = scenes.cuts.length > 0;
  if (multiShot) {
    risks.push(
      `SCENE_MULTI_SHOT: ${scenes.cuts.length} cut(s) detected (${scenes.cuts.join(", ")}ms); analysis restricted to ${Math.round(best.startMs)}–${Math.round(best.endMs)}ms`,
    );
  }
  const covered = poseTimestampsMs.filter(
    (timestamp) => timestamp >= best.startMs && timestamp < best.endMs,
  ).length;
  if (poseTimestampsMs.length > 0 && covered / poseTimestampsMs.length < 0.6) {
    risks.push(
      `SCENE_FRAGMENTED: the analysis shot holds only ${Math.round((covered / poseTimestampsMs.length) * 100)}% of pose frames`,
    );
  }
  return {
    multiShot,
    cutCount: scenes.cuts.length,
    cuts: scenes.cuts,
    analysisSegment: best,
    segments,
    risks,
  };
}

/** True when a span would cross a shot boundary (must never be analyzed). */
export function crossesCut(
  cuts: readonly number[],
  span: { startMs: number; endMs: number },
): boolean {
  return cuts.some((cut) => cut > span.startMs && cut < span.endMs);
}

/** Intersect a span with the analysis shot; null when disjoint. */
export function clampToScene(
  span: { startMs: number; endMs: number },
  scene: { startMs: number; endMs: number },
): { startMs: number; endMs: number } | null {
  const startMs = Math.max(span.startMs, scene.startMs);
  const endMs = Math.min(span.endMs, scene.endMs);
  return endMs > startMs ? { startMs, endMs } : null;
}
