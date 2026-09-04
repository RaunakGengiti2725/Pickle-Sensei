import type { Incident, ResponseStep, TimelineEntry } from "./incident.js";
import { currentStep } from "./incident.js";
import type { Severity } from "./severity.js";
import { isAtLeastAsSevere } from "./severity.js";

/**
 * Required-response state machines. Each severity has a mandatory ordered
 * sequence of steps; steps cannot be skipped or reordered, and an incident
 * cannot close until every required step has been completed with a note.
 *
 * P0 responds to active harm: stop the bleeding first (halt rollout, disable
 * the feature/model, roll back), preserve evidence before it rots, then
 * investigate, fix, validate, and write the postmortem.
 */
export const REQUIRED_SEQUENCES: Record<Severity, readonly ResponseStep[]> = {
  P0: [
    "declared",
    "rollout_halted",
    "feature_disabled",
    "rolled_back",
    "evidence_preserved",
    "investigating",
    "fix_in_progress",
    "validating",
    "postmortem",
    "closed",
  ],
  P1: [
    "declared",
    "evidence_preserved",
    "investigating",
    "fix_in_progress",
    "validating",
    "postmortem",
    "closed",
  ],
  P2: ["declared", "investigating", "fix_in_progress", "validating", "closed"],
};

export class InvalidTransitionError extends Error {
  readonly incidentId: string;
  readonly from: ResponseStep;
  readonly attempted: ResponseStep;
  readonly expected: ResponseStep | null;

  constructor(
    incidentId: string,
    from: ResponseStep,
    attempted: ResponseStep,
    expected: ResponseStep | null,
  ) {
    super(
      expected === null
        ? `incident ${incidentId}: no transition allowed from terminal step "${from}"`
        : `incident ${incidentId}: cannot go from "${from}" to "${attempted}"; required next step is "${expected}"`,
    );
    this.name = "InvalidTransitionError";
    this.incidentId = incidentId;
    this.from = from;
    this.attempted = attempted;
    this.expected = expected;
  }
}

export class IncompleteResponseError extends Error {
  readonly incidentId: string;
  readonly missing: readonly ResponseStep[];

  constructor(incidentId: string, missing: readonly ResponseStep[]) {
    super(`incident ${incidentId}: cannot close, missing required steps: ${missing.join(", ")}`);
    this.name = "IncompleteResponseError";
    this.incidentId = incidentId;
    this.missing = missing;
  }
}

/** The single step an incident must complete next, or null when closed. */
export function nextRequiredStep(incident: Incident): ResponseStep | null {
  const sequence = REQUIRED_SEQUENCES[incident.severity];
  const current = currentStep(incident);
  const index = sequence.indexOf(current);
  if (index === -1) {
    throw new Error(
      `incident ${incident.id}: step "${current}" is not part of the ${incident.severity} sequence`,
    );
  }
  return index === sequence.length - 1 ? null : sequence[index + 1]!;
}

export interface AdvanceInput {
  step: ResponseStep;
  at: string;
  actor: string;
  note: string;
}

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

/**
 * Advance an incident to its next required step. Throws
 * InvalidTransitionError on any skip, reorder, or transition out of "closed",
 * and IncompleteResponseError when closing a postmortem-required incident
 * without a non-blank postmortemRef.
 */
export function advance(incident: Incident, input: AdvanceInput): Incident {
  const current = currentStep(incident);
  const expected = nextRequiredStep(incident);
  if (expected === null || input.step !== expected) {
    throw new InvalidTransitionError(incident.id, current, input.step, expected);
  }
  if (isBlank(input.note)) {
    throw new Error(`incident ${incident.id}: step "${input.step}" requires a non-empty note`);
  }
  if (input.step === "closed" && requiresPostmortem(incident) && !hasPostmortem(incident)) {
    throw new IncompleteResponseError(incident.id, ["postmortem"]);
  }
  const entry: TimelineEntry = {
    at: input.at,
    step: input.step,
    actor: input.actor,
    note: input.note,
  };
  return { ...incident, timeline: [...incident.timeline, entry] };
}

export function attachPostmortem(incident: Incident, postmortemRef: string): Incident {
  if (isBlank(postmortemRef)) {
    throw new Error(`incident ${incident.id}: postmortemRef must be a non-empty path or URL`);
  }
  return { ...incident, postmortemRef };
}

function requiresPostmortem(incident: Incident): boolean {
  return REQUIRED_SEQUENCES[incident.severity].includes("postmortem");
}

function hasPostmortem(incident: Incident): boolean {
  return incident.postmortemRef !== null && !isBlank(incident.postmortemRef);
}

export class InvalidEscalationError extends Error {
  constructor(incidentId: string, from: Severity, to: Severity) {
    super(
      `incident ${incidentId}: cannot de-escalate from ${from} to ${to} — severity only goes up`,
    );
    this.name = "InvalidEscalationError";
  }
}

/**
 * Escalate an incident to a higher severity. The completed timeline is
 * preserved; any steps required by the new severity that were not part of the
 * old sequence must still be completed in order, so escalation re-derives the
 * remaining sequence rather than granting credit for skipped mitigations.
 * A closed incident is terminal: escalating it throws InvalidTransitionError
 * (declare a new incident instead of reopening the record).
 */
export function escalate(
  incident: Incident,
  to: Severity,
  input: { at: string; actor: string; note: string },
): Incident {
  if (to === incident.severity || isAtLeastAsSevere(incident.severity, to)) {
    throw new InvalidEscalationError(incident.id, incident.severity, to);
  }
  const current = currentStep(incident);
  if (current === "closed") {
    throw new InvalidTransitionError(incident.id, current, current, null);
  }
  if (isBlank(input.note)) {
    throw new Error(`incident ${incident.id}: escalation to ${to} requires a non-empty note`);
  }
  const completed = new Set(incident.timeline.map((entry) => entry.step));
  const sequence = REQUIRED_SEQUENCES[to];
  // Rewind to the last step in the new sequence completed without gaps.
  let anchor: ResponseStep = "declared";
  for (const step of sequence) {
    if (step === "closed" || !completed.has(step)) break;
    anchor = step;
  }
  const entry: TimelineEntry = {
    at: input.at,
    step: anchor,
    actor: input.actor,
    note: `escalated ${incident.severity} -> ${to}: ${input.note}`,
  };
  return { ...incident, severity: to, timeline: [...incident.timeline, entry] };
}

/** Steps of the required sequence not yet completed, in order. */
export function remainingSteps(incident: Incident): readonly ResponseStep[] {
  const sequence = REQUIRED_SEQUENCES[incident.severity];
  const current = currentStep(incident);
  const index = sequence.indexOf(current);
  return sequence.slice(index + 1);
}

export function isClosed(incident: Incident): boolean {
  return currentStep(incident) === "closed";
}
