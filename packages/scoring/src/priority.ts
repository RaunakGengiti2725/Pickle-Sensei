import type { CheckpointKey, PriorityFix } from "@pickle/shared-types";
import type { CheckpointResultDetail, ShotScoringConfig } from "./types.js";

/**
 * Coaching-priority engine (spec p. 35).
 * P_j = Severity × Confidence × CoachPriority × Changeability × GoalRelevance,
 * then dependency rules promote root causes: a faulty upstream checkpoint that
 * plausibly produces the downstream fault (e.g. poor preparation → late paddle
 * path → late contact) is preferred over the symptom, even when the symptom's
 * raw score is lower.
 */

export interface PriorityOptions {
  /** GoalRelevance_j per checkpoint; defaults to 1. */
  goalRelevance?: Partial<Record<CheckpointKey, number>>;
  /** Current session focus — gets stickiness so coaching stays consistent. */
  focusCheckpoint?: CheckpointKey;
  /** Minimum severity for a checkpoint to be considered a fix at all. */
  minSeverity?: number;
  /** Minimum severity for an upstream cause to claim a downstream effect. */
  causeSeverityThreshold?: number;
  /** How much of a downstream effect's priority flows to its root cause. */
  dependencyBoost?: number;
  /** Multiplier applied to the current focus checkpoint. */
  focusStickiness?: number;
}

interface Scored {
  key: CheckpointKey;
  basePriority: number;
  effectivePriority: number;
  severity: number;
  confidence: number;
  boostedBy: CheckpointKey | null;
}

const DEFAULTS = {
  minSeverity: 0.12,
  causeSeverityThreshold: 0.25,
  dependencyBoost: 0.6,
  focusStickiness: 1.25,
} as const;

export function selectPriorityFix(
  config: ShotScoringConfig,
  results: CheckpointResultDetail[],
  options: PriorityOptions = {},
): PriorityFix | null {
  const minSeverity = options.minSeverity ?? DEFAULTS.minSeverity;
  const causeThreshold = options.causeSeverityThreshold ?? DEFAULTS.causeSeverityThreshold;
  const boost = options.dependencyBoost ?? DEFAULTS.dependencyBoost;
  const stickiness = options.focusStickiness ?? DEFAULTS.focusStickiness;

  const byKey = new Map(results.map((r) => [r.key, r]));
  const cfgByKey = new Map(config.checkpoints.map((c) => [c.key, c]));

  const scored: Scored[] = [];
  for (const r of results) {
    if (!r.observed || r.score === null) continue;
    if (r.severity < minSeverity) continue;
    const cfg = cfgByKey.get(r.key);
    if (!cfg) continue;
    const goal = options.goalRelevance?.[r.key] ?? 1;
    let base = r.severity * r.confidence * cfg.coachPriority * cfg.changeability * goal;
    if (options.focusCheckpoint === r.key) base *= stickiness;
    scored.push({
      key: r.key,
      basePriority: base,
      effectivePriority: base,
      severity: r.severity,
      confidence: r.confidence,
      boostedBy: null,
    });
  }
  if (scored.length === 0) return null;

  const scoredByKey = new Map(scored.map((s) => [s.key, s]));

  // Dependency promotion: transfer part of each faulty effect's priority to a
  // faulty cause. Chains propagate cause-ward because we iterate until stable
  // (graph is small — 11 nodes max — and boosts only increase monotonically
  // toward a fixed point since we take max()).
  let changed = true;
  let iterations = 0;
  while (changed && iterations < config.dependencies.length + 2) {
    changed = false;
    iterations++;
    for (const edge of config.dependencies) {
      const cause = scoredByKey.get(edge.cause);
      const effect = scoredByKey.get(edge.effect);
      if (!cause || !effect) continue;
      const causeResult = byKey.get(edge.cause);
      if (!causeResult || causeResult.severity < causeThreshold) continue;
      const candidate = Math.max(
        cause.effectivePriority,
        cause.basePriority + boost * effect.effectivePriority,
      );
      if (candidate > cause.effectivePriority + 1e-12) {
        cause.effectivePriority = candidate;
        cause.boostedBy = edge.effect;
        changed = true;
      }
    }
  }

  scored.sort(
    (a, b) =>
      b.effectivePriority - a.effectivePriority ||
      b.severity - a.severity ||
      a.key.localeCompare(b.key),
  );
  const top = scored[0];
  if (!top) return null;

  return {
    checkpoint: top.key,
    reasonKey: top.boostedBy ? `root_cause_of:${top.boostedBy}` : "highest_weighted_priority",
    severity: top.severity,
    confidence: top.confidence,
  };
}
