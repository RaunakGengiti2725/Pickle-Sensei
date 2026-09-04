import { describe, expect, it } from "vitest";
import {
  DETECTION_SOURCES,
  FAILURE_CLASSES,
  IncompleteResponseError,
  InvalidEscalationError,
  InvalidTransitionError,
  REQUIRED_SEQUENCES,
  RESPONSE_STEPS,
  SEVERITIES,
  addEvidence,
  advance,
  attachPostmortem,
  currentStep,
  declareIncident,
  escalate,
  isAtLeastAsSevere,
  isClosed,
  nextRequiredStep,
  remainingSteps,
  type Incident,
  type ResponseStep,
  type Severity,
} from "../src/index.js";
import {
  check,
  describeFailures,
  executeSteps,
  findNonFinite,
  readStressEnv,
  runCampaign,
  type Rng,
} from "../../../tools/stress-kit/kit.js";

/**
 * SEEDED RANDOMIZED LONG-RUN over the incident-response public API.
 *
 * Model-checked invariants (stateMachine.ts / incident.ts doc comments):
 *  I1  the timeline is append-only and starts at `declared`; every step in it
 *      is a RESPONSE_STEP; currentStep is its last entry.
 *  I2  only the single next required step of REQUIRED_SEQUENCES[severity]
 *      is accepted; skips, reorders, repeats and any advance out of `closed`
 *      throw InvalidTransitionError and return no new value.
 *  I3  a whitespace-only note is rejected.
 *  I4  P0/P1 cannot reach `closed` while postmortemRef === null
 *      (IncompleteResponseError); P2 can.
 *  I5  escalation only goes UP in severity; equal/lower throws
 *      InvalidEscalationError. After escalation the completed steps are
 *      preserved, and the anchor is the longest gap-free prefix of the new
 *      sequence already completed.
 *  I6  evidence is append-only; every operation returns a new object and the
 *      input incident is never mutated (deep-frozen inputs).
 *  I7  remainingSteps + [currentStep] is a suffix of the required sequence;
 *      isClosed ⇔ remainingSteps is empty.
 *  I8  no NaN/Infinity in the incident (numbers never appear, so a hit is a bug).
 */

type Action =
  | {
      kind: "advance";
      mode: "next" | "skip" | "repeat" | "random";
      stepIndex: number;
      note: number;
    }
  | { kind: "evidence" }
  | { kind: "postmortem"; ref: string }
  | { kind: "escalate"; to: number; note: number };

const NOTES = ["did the thing", "  ", "", "\t\n", "rolled back model to v3"];

function generate(rng: Rng, length: number): Action[] {
  const actions: Action[] = [];
  for (let i = 0; i < length; i += 1) {
    const roll = rng.next();
    if (roll < 0.6) {
      const modeRoll = rng.next();
      actions.push({
        kind: "advance",
        mode:
          modeRoll < 0.6
            ? "next"
            : modeRoll < 0.75
              ? "skip"
              : modeRoll < 0.85
                ? "repeat"
                : "random",
        stepIndex: rng.int(RESPONSE_STEPS.length),
        note: rng.int(NOTES.length),
      });
    } else if (roll < 0.75) {
      actions.push({ kind: "evidence" });
    } else if (roll < 0.87) {
      actions.push({
        kind: "postmortem",
        ref: `docs/postmortems/SYNTHETIC-STRESS-${rng.int(100)}.md`,
      });
    } else {
      actions.push({
        kind: "escalate",
        to: rng.int(SEVERITIES.length),
        note: rng.int(NOTES.length),
      });
    }
  }
  return actions;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

interface Model {
  severity: Severity;
  steps: ResponseStep[];
  evidence: number;
  postmortem: string | null;
}

function modelNext(model: Model): ResponseStep | null {
  const sequence = REQUIRED_SEQUENCES[model.severity];
  const current = model.steps[model.steps.length - 1]!;
  const index = sequence.indexOf(current);
  return index === sequence.length - 1 ? null : sequence[index + 1]!;
}

function checkInvariants(incident: Incident, model: Model): void {
  check(incident.timeline[0]?.step === "declared", "I1 starts declared", () => "");
  check(
    incident.timeline.length === model.steps.length &&
      incident.timeline.every((entry, i) => entry.step === model.steps[i]),
    "I1 timeline",
    () => `${incident.timeline.map((e) => e.step).join(">")} vs ${model.steps.join(">")}`,
  );
  check(
    incident.timeline.every((e) => (RESPONSE_STEPS as readonly string[]).includes(e.step)),
    "I1 steps valid",
    () => "",
  );
  check(currentStep(incident) === model.steps[model.steps.length - 1], "I1 currentStep", () => "");
  check(incident.severity === model.severity, "I5 severity", () => incident.severity);
  check(incident.evidence.length === model.evidence, "I6 evidence count", () => "");
  check(incident.postmortemRef === model.postmortem, "I4 postmortemRef", () => "");
  const sequence = REQUIRED_SEQUENCES[incident.severity];
  const remaining = remainingSteps(incident);
  const current = currentStep(incident);
  const idx = sequence.indexOf(current);
  check(idx !== -1, "I7 current in sequence", () => current);
  check(
    JSON.stringify(remaining) === JSON.stringify(sequence.slice(idx + 1)),
    "I7 remaining suffix",
    () => JSON.stringify(remaining),
  );
  check(isClosed(incident) === (remaining.length === 0), "I7 isClosed", () => "");
  check(nextRequiredStep(incident) === (remaining[0] ?? null), "I7 nextRequiredStep", () => "");
  const nonFinite = findNonFinite(incident);
  check(nonFinite === null, "I8 finite", () => nonFinite ?? "");
}

function execute(actions: readonly Action[]) {
  let tick = 0;
  const at = (): string => new Date(Date.UTC(2026, 8, 4, 12, 0, tick++)).toISOString();
  const initialSeverity = SEVERITIES[actions.length % SEVERITIES.length]!;
  let incident: Incident = deepFreeze(
    declareIncident({
      id: `SYNTHETIC-STRESS-INC-${actions.length}`,
      severity: initialSeverity,
      failureClass: FAILURE_CLASSES[actions.length % FAILURE_CLASSES.length]!,
      title: "synthetic stress incident",
      detectionSource: DETECTION_SOURCES[actions.length % DETECTION_SOURCES.length]!,
      detectedAt: at(),
      affectedSurfaces: ["SYNTHETIC-STRESS.flag"],
      declaredBy: "SYNTHETIC-STRESS.actor",
      note: "declared for stress",
    }),
  );
  const model: Model = {
    severity: initialSeverity,
    steps: ["declared"],
    evidence: 0,
    postmortem: null,
  };
  checkInvariants(incident, model);

  const expectThrow = (fn: () => Incident, cls: new (...args: never[]) => Error, label: string) => {
    const before = JSON.stringify(incident);
    let thrown: unknown = null;
    try {
      fn();
    } catch (error) {
      thrown = error;
    }
    check(thrown instanceof cls, label, () => `expected ${cls.name}, got ${String(thrown)}`);
    check(JSON.stringify(incident) === before, `${label} (input untouched)`, () => "");
  };

  return executeSteps(actions, (action) => {
    if (action.kind === "evidence") {
      const next = addEvidence(incident, {
        capturedAt: at(),
        description: "synthetic evidence",
        location: null,
      });
      check(next !== incident, "I6 new object", () => "");
      check(next.evidence.length === incident.evidence.length + 1, "I6 appended", () => "");
      incident = deepFreeze(next);
      model.evidence += 1;
      checkInvariants(incident, model);
      return { evidence: model.evidence };
    }
    if (action.kind === "postmortem") {
      incident = deepFreeze(attachPostmortem(incident, action.ref));
      model.postmortem = action.ref;
      checkInvariants(incident, model);
      return { postmortem: true };
    }
    if (action.kind === "escalate") {
      const to = SEVERITIES[action.to]!;
      const note = NOTES[action.note]!;
      const input = { at: at(), actor: "SYNTHETIC-STRESS.actor", note };
      if (to === incident.severity || isAtLeastAsSevere(incident.severity, to)) {
        expectThrow(
          () => escalate(incident, to, input),
          InvalidEscalationError,
          "I5 no de-escalation",
        );
        return { escalate: "rejected", from: incident.severity, to };
      }
      const next = escalate(incident, to, input);
      // Model: anchor = longest gap-free completed prefix of the new sequence (excluding closed).
      const completed = new Set(model.steps.filter((s) => s !== "closed"));
      let anchor: ResponseStep = "declared";
      for (const step of REQUIRED_SEQUENCES[to]) {
        if (step === "closed" || !completed.has(step)) break;
        anchor = step;
      }
      model.severity = to;
      model.steps.push(anchor);
      check(
        next.timeline.length === incident.timeline.length + 1 &&
          incident.timeline.every(
            (e, i) =>
              next.timeline[i] === e || JSON.stringify(next.timeline[i]) === JSON.stringify(e),
          ),
        "I5 history preserved",
        () => "",
      );
      incident = deepFreeze(next);
      checkInvariants(incident, model);
      return { escalate: "ok", to, anchor };
    }
    // advance
    const expected = modelNext(model);
    let step: ResponseStep;
    if (action.mode === "next" && expected !== null) step = expected;
    else if (action.mode === "repeat") step = model.steps[model.steps.length - 1]!;
    else if (action.mode === "skip" && expected !== null) {
      const sequence = REQUIRED_SEQUENCES[model.severity];
      const idx = sequence.indexOf(expected);
      step = sequence[Math.min(idx + 1 + (action.stepIndex % 2), sequence.length - 1)]!;
    } else step = RESPONSE_STEPS[action.stepIndex]!;
    const note = NOTES[action.note]!;
    const input = { step, at: at(), actor: "SYNTHETIC-STRESS.actor", note };
    if (expected === null || step !== expected) {
      expectThrow(() => advance(incident, input), InvalidTransitionError, "I2 illegal advance");
      return { advance: "illegal", step, expected };
    }
    if (note.trim().length === 0) {
      expectThrow(() => advance(incident, input), Error, "I3 empty note");
      return { advance: "empty-note", step };
    }
    const needsPostmortem = REQUIRED_SEQUENCES[model.severity].includes("postmortem");
    if (step === "closed" && needsPostmortem && model.postmortem === null) {
      expectThrow(() => advance(incident, input), IncompleteResponseError, "I4 postmortem gate");
      return { advance: "postmortem-gate" };
    }
    const next = advance(incident, input);
    model.steps.push(step);
    incident = deepFreeze(next);
    checkInvariants(incident, model);
    return { advance: "ok", step };
  });
}

const env = readStressEnv(300);

describe("incident-response seeded randomized long-run", () => {
  it("invariants I1–I8 hold for every seed and every step; same seed → same trace", () => {
    const report = runCampaign<Action>({
      campaign: "incident-response",
      env,
      minLength: 5,
      maxLength: 60,
      generate,
      execute,
    });
    expect(report.sequencesExecuted).toBe(env.iterations);
    expect(describeFailures(report)).toBe("");
    expect(report.broken + report.nondeterministic).toBe(0);
  });
});
