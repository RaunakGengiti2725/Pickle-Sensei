import { z } from "zod";
import {
  STABILITY_SLO_VERSION,
  aggregateStabilitySlo,
  evaluateStabilitySlo,
  guardRolloutAdvance,
  stabilityRolloutDecision,
  type RolloutAdvanceVerdict,
  type StabilityRolloutDecision,
  type StabilitySloEvaluation,
  type StabilitySloEvent,
  type StabilitySloWindowMetrics,
} from "@pickle/shared-types";

/**
 * Server-side stability SLO guard for the canary rollout machinery
 * (`stability-slo-v1`, packages/shared-types/src/stabilitySlo.ts).
 *
 * The guard holds the latest OBSERVED stability window and derives the
 * rollout decision from it. It is opt-in by observation: until a real
 * window has been submitted, the guard is INACTIVE and the flag /
 * model-bundle endpoints behave exactly as before — an absent pipeline is
 * an honest "no stability evidence", not a fabricated pass OR a
 * retroactive block on unrelated operations. Once a window exists:
 *  - `pause` (any SLO breached) and `hold` (any SLO not yet evaluable)
 *    block ADVANCING rollout percentages;
 *  - holding at, or reducing below, the current percentage is ALWAYS
 *    allowed — a breach can never trap operators or prevent a rollback.
 */

const StabilityEventBaseSchema = z.object({
  userKey: z.string().min(1).max(200),
  sessionKey: z.string().min(1).max(200).nullable(),
  at: z.iso.datetime(),
});

export const StabilitySloEventSchema: z.ZodType<StabilitySloEvent> = z.discriminatedUnion("kind", [
  StabilityEventBaseSchema.extend({ kind: z.literal("session_started") }),
  StabilityEventBaseSchema.extend({ kind: z.literal("session_ended_clean") }),
  StabilityEventBaseSchema.extend({
    kind: z.literal("crash"),
    fatal: z.boolean(),
    fingerprint: z.string().min(1).max(200),
  }),
  StabilityEventBaseSchema.extend({
    kind: z.literal("memory_pressure_termination"),
  }),
  StabilityEventBaseSchema.extend({ kind: z.literal("analysis_started") }),
  StabilityEventBaseSchema.extend({ kind: z.literal("analysis_completed") }),
  StabilityEventBaseSchema.extend({
    kind: z.literal("analysis_failed"),
    failureKind: z.string().min(1).max(200),
  }),
  StabilityEventBaseSchema.extend({
    kind: z.literal("camera_startup_succeeded"),
  }),
  StabilityEventBaseSchema.extend({
    kind: z.literal("camera_startup_failed"),
    reason: z.string().min(1).max(200),
  }),
  StabilityEventBaseSchema.extend({ kind: z.literal("try_again_rearmed") }),
  StabilityEventBaseSchema.extend({
    kind: z.literal("try_again_failed"),
    reason: z.string().min(1).max(200),
  }),
  StabilityEventBaseSchema.extend({
    kind: z.literal("session_flow_failed"),
    reason: z.string().min(1).max(200),
  }),
]);

export const StabilityWindowSubmission = z.object({
  windowId: z.string().min(1).max(120),
  events: z.array(StabilitySloEventSchema).max(100_000),
});

export interface StabilityWindowState {
  windowId: string;
  submittedAtIso: string;
  metrics: StabilitySloWindowMetrics;
  evaluation: StabilitySloEvaluation;
  decision: StabilityRolloutDecision;
}

export interface StabilityGuard {
  /** Aggregate + evaluate one observed window and make it the current one. */
  submitWindow(windowId: string, events: readonly StabilitySloEvent[]): StabilityWindowState;
  /** The latest observed window, or null when none has been submitted. */
  currentWindow(): StabilityWindowState | null;
  /**
   * Verdict for changing a rollout percentage. `active: false` (no window
   * observed yet) never blocks — the guard has no evidence either way and
   * says so instead of inventing a pass or a breach.
   */
  checkRolloutChange(
    currentRolloutPercent: number,
    requestedRolloutPercent: number,
  ): { active: false } | { active: true; verdict: RolloutAdvanceVerdict };
}

export function createStabilityGuard(
  nowIso: () => string = () => new Date().toISOString(),
): StabilityGuard {
  let window: StabilityWindowState | null = null;
  return {
    submitWindow(windowId, events) {
      const metrics = aggregateStabilitySlo(events);
      const evaluation = evaluateStabilitySlo(metrics);
      const decision = stabilityRolloutDecision(evaluation);
      window = {
        windowId,
        submittedAtIso: nowIso(),
        metrics,
        evaluation,
        decision,
      };
      return window;
    },
    currentWindow: () => window,
    checkRolloutChange(currentRolloutPercent, requestedRolloutPercent) {
      if (window === null) return { active: false };
      return {
        active: true,
        verdict: guardRolloutAdvance(
          window.decision,
          currentRolloutPercent,
          requestedRolloutPercent,
        ),
      };
    },
  };
}

export { STABILITY_SLO_VERSION };
