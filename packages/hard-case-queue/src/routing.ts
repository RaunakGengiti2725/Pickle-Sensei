import {
  HARD_CASE_CATEGORIES,
  type HardCaseCategory,
  type HardCaseReport,
  type HardCaseSource,
} from "./types.js";

/**
 * Routing precedence:
 *   1. explicit `categoryHint` (must be a valid category — invalid hints are
 *      REJECTED loudly, never coerced or dropped);
 *   2. `stageHint` naming a cascade stage that is itself a category;
 *   3. per-source default;
 *   4. OTHER (the explicit "route me at triage" bucket).
 */
export class HardCaseRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HardCaseRoutingError";
  }
}

/**
 * Per-source defaults, used only when the report carries no usable stage
 * evidence. Only sources whose subsystem is unambiguous get a non-OTHER
 * default; everything else lands in OTHER for human triage rather than
 * being guessed into the wrong lane.
 */
export const SOURCE_DEFAULT_CATEGORY: Record<HardCaseSource, HardCaseCategory> = {
  user_feedback: "OTHER",
  shadow_disagreement: "OTHER",
  model_disagreement: "OTHER",
  high_uncertainty: "OTHER",
  unexpected_abstention: "AUTO",
  capture_envelope_failure: "CAPTURE",
  coach_disagreement: "COACHING",
  red_team: "OTHER",
  anomaly: "OTHER",
};

function isCategory(value: string): value is HardCaseCategory {
  return (HARD_CASE_CATEGORIES as readonly string[]).includes(value);
}

export function routeCategory(report: HardCaseReport): HardCaseCategory {
  if (report.categoryHint !== undefined) {
    if (!isCategory(report.categoryHint)) {
      throw new HardCaseRoutingError(
        `invalid categoryHint "${String(report.categoryHint)}" — valid: ${HARD_CASE_CATEGORIES.join(", ")}`,
      );
    }
    return report.categoryHint;
  }
  if (report.stageHint !== undefined) {
    const stage = report.stageHint.trim().toUpperCase();
    if (isCategory(stage)) return stage;
  }
  return SOURCE_DEFAULT_CATEGORY[report.source];
}
