/**
 * Frozen GATE B latency targets for the primary metric
 * TRUE-MOVEMENT-COMPLETION -> RESULT-INTERACTIVE on a physical iPhone.
 *
 * Frozen 2026-08-29 BEFORE any device measurement exists (so a future device
 * run cannot tune its own pass bar). Changing any number requires a new
 * version string and a decision-log entry — never edit v1 in place.
 */

export const IPHONE_LATENCY_TARGETS_VERSION = "iphone-latency-targets-v1" as const;

export interface IphoneLatencyTargetsV1 {
  version: typeof IPHONE_LATENCY_TARGETS_VERSION;
  metric: "TRUE_MOVEMENT_COMPLETION_TO_RESULT_INTERACTIVE";
  /** Percentile the verdict is judged on. */
  judgedPercentile: "p95";
  idealMs: number;
  strongMs: number;
  maxMs: number;
}

export const IPHONE_LATENCY_TARGETS: IphoneLatencyTargetsV1 = {
  version: IPHONE_LATENCY_TARGETS_VERSION,
  metric: "TRUE_MOVEMENT_COMPLETION_TO_RESULT_INTERACTIVE",
  judgedPercentile: "p95",
  idealMs: 2000,
  strongMs: 3000,
  maxMs: 5000,
};

export type LatencyVerdict = "IDEAL" | "STRONG" | "MAX" | "FAIL";

/** Verdict for a judged latency value against the frozen targets. */
export function latencyVerdict(
  judgedMs: number,
  targets: IphoneLatencyTargetsV1 = IPHONE_LATENCY_TARGETS,
): LatencyVerdict {
  if (!Number.isFinite(judgedMs) || judgedMs < 0) {
    throw new Error(`latencyVerdict: invalid judged latency ${judgedMs}`);
  }
  if (judgedMs <= targets.idealMs) return "IDEAL";
  if (judgedMs <= targets.strongMs) return "STRONG";
  if (judgedMs <= targets.maxMs) return "MAX";
  return "FAIL";
}
