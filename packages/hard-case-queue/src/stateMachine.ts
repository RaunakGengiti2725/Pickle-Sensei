import type { HardCaseState } from "./types.js";

/**
 * new → triaged → in-review → resolved | regression
 * resolved → regression        (a resolved case that recurs reopens — it can
 *                               never be silently re-closed or dropped)
 * regression → triaged         (a regression re-enters the pipeline)
 *
 * There is no transition out of the queue and no delete: cases only ever
 * move between these states.
 */
export const HARD_CASE_TRANSITIONS: Record<HardCaseState, readonly HardCaseState[]> = {
  new: ["triaged"],
  triaged: ["in-review"],
  "in-review": ["resolved", "regression"],
  resolved: ["regression"],
  regression: ["triaged"],
};

export class HardCaseTransitionError extends Error {
  constructor(
    readonly entryId: string,
    readonly from: HardCaseState,
    readonly to: HardCaseState,
  ) {
    super(
      `illegal transition ${from} → ${to} on ${entryId}; allowed from "${from}": ${
        HARD_CASE_TRANSITIONS[from].join(", ") || "(none)"
      }`,
    );
    this.name = "HardCaseTransitionError";
  }
}

export function assertTransition(entryId: string, from: HardCaseState, to: HardCaseState): void {
  if (!HARD_CASE_TRANSITIONS[from].includes(to)) {
    throw new HardCaseTransitionError(entryId, from, to);
  }
}
