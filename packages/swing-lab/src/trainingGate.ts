import type { RightsProfile } from "./engine/rights.js";
import { trainingEligible } from "./engine/rights.js";

/**
 * Per-event training gate for dataset releases.
 *
 * A release's per-event records are consumed downstream as training input, so
 * every record must carry an explicit eligibility verdict. Default is
 * QUARANTINE: only development-split events whose source rights are cleared
 * for training may ever be marked eligible. Held-out, test-held-out, shadow,
 * coach-holdout, unassigned, and unknown-rights events are quarantined with
 * explicit reasons.
 */
export const TRAINING_SPLITS: ReadonlySet<string> = new Set(["development"]);

export interface EventTrainingGate {
  trainingEligible: boolean;
  quarantineReasons: string[];
}

export function gateEventForTraining(
  split: string,
  rights: RightsProfile | null,
): EventTrainingGate {
  const reasons: string[] = [];
  if (!TRAINING_SPLITS.has(split)) {
    reasons.push(
      `split '${split}' is quarantined from training (only ${[...TRAINING_SPLITS].join(", ")} may train)`,
    );
  }
  if (!rights) {
    reasons.push("no corpus rights record resolved for source — unknown rights are quarantined");
  } else if (!trainingEligible(rights)) {
    reasons.push(
      `source rights are not training-eligible (train=${rights.train}, store=${rights.store}, analyze=${rights.analyze})`,
    );
  }
  return { trainingEligible: reasons.length === 0, quarantineReasons: reasons };
}
