/**
 * Adversarial pass (shared-packages-ops #1, pass 3) — incident-response
 * state machine. `it(...)` = HELD / OBSERVED (pinned current behaviour);
 * `it.fails(...)` = EXPECTED contract that is currently broken.
 */
import { describe, expect, it } from "vitest";
import {
  REQUIRED_SEQUENCES,
  advance,
  attachPostmortem,
  currentStep,
  declareIncident,
  escalate,
  isClosed,
  nextRequiredStep,
  remainingSteps,
  type Incident,
  type ResponseStep,
  type Severity,
} from "../src/index.js";

function declare(severity: Severity): Incident {
  return declareIncident({
    id: `inc-${severity}`,
    severity,
    failureClass: "queue_stall",
    title: "attack",
    detectionSource: "red_team",
    detectedAt: "2026-09-04T12:00:00.000Z",
    affectedSurfaces: ["queue"],
    declaredBy: "tester",
    note: "declared",
  });
}

function step(step: ResponseStep, at = "2026-09-04T12:30:00.000Z") {
  return { step, at, actor: "tester", note: `did ${step}` };
}

function runToBeforeClose(severity: Severity): Incident {
  let inc = declare(severity);
  const seq = REQUIRED_SEQUENCES[severity];
  for (const s of seq.slice(1, -1)) inc = advance(inc, step(s));
  return inc;
}

describe("closing / postmortem", () => {
  it("HELD: P0 and P1 cannot close without a postmortemRef; P2 can", () => {
    for (const sev of ["P0", "P1"] as const) {
      const inc = runToBeforeClose(sev);
      expect(() => advance(inc, step("closed"))).toThrowError(/missing required steps: postmortem/);
      expect(isClosed(advance(attachPostmortem(inc, "docs/pm.md"), step("closed")))).toBe(true);
    }
    expect(isClosed(advance(runToBeforeClose("P2"), step("closed")))).toBe(true);
  });

  it("OBSERVED: attachPostmortem('') and attachPostmortem('   ') satisfy the postmortem requirement — an empty ref counts as a written postmortem", () => {
    const inc = runToBeforeClose("P0");
    expect(isClosed(advance(attachPostmortem(inc, ""), step("closed")))).toBe(true);
    expect(isClosed(advance(attachPostmortem(inc, "   "), step("closed")))).toBe(true);
  });

  it.fails("EXPECTED: a blank postmortemRef is not a postmortem", () => {
    const inc = runToBeforeClose("P0");
    expect(() => advance(attachPostmortem(inc, ""), step("closed"))).toThrowError();
  });

  it("OBSERVED: a note made only of zero-width space (U+200B) passes the non-empty-note gate; NBSP / BOM / tabs do not", () => {
    const inc = declare("P2");
    expect(() => advance(inc, { ...step("investigating"), note: "\u00a0\ufeff\t\n" })).toThrowError(
      /non-empty note/,
    );
    const advanced = advance(inc, { ...step("investigating"), note: "\u200b" });
    expect(currentStep(advanced)).toBe("investigating");
  });

  it("HELD: 1,000 rapid repeats of the same next step from the same base all produce an identical single-step result (pure)", () => {
    const inc = declare("P2");
    const results = new Set<string>();
    for (let i = 0; i < 1000; i++) results.add(JSON.stringify(advance(inc, step("investigating"))));
    expect(results.size).toBe(1);
    expect(inc.timeline).toHaveLength(1);
  });

  it("HELD: every skip / reorder / repeat / post-close transition is rejected for all three severities", () => {
    for (const sev of ["P0", "P1", "P2"] as const) {
      const seq = REQUIRED_SEQUENCES[sev];
      let inc = declare(sev);
      for (let i = 1; i < seq.length; i++) {
        const expected = seq[i]!;
        for (const candidate of ["declared", ...seq] as ResponseStep[]) {
          if (candidate === expected) continue;
          if (candidate === "closed" && expected !== "closed") {
            expect(() => advance(inc, step("closed"))).toThrowError(/cannot go from/);
            continue;
          }
          expect(() => advance(inc, step(candidate))).toThrowError(
            /cannot go from|no transition allowed/,
          );
        }
        inc =
          expected === "closed"
            ? advance(attachPostmortem(inc, "pm"), step("closed"))
            : advance(inc, step(expected));
      }
      expect(isClosed(inc)).toBe(true);
      for (const s of seq)
        expect(() => advance(inc, step(s))).toThrowError(/no transition allowed from terminal/);
    }
  });
});

describe("clock skew / timestamps", () => {
  it("OBSERVED: `at` is never validated — a step dated BEFORE the previous one, non-ISO text, and empty string are all accepted", () => {
    let inc = declare("P2");
    inc = advance(inc, step("investigating", "2026-09-04T11:00:00.000Z"));
    inc = advance(inc, step("fix_in_progress", "yesterday"));
    inc = advance(inc, step("validating", ""));
    expect(inc.timeline.map((t) => t.at)).toEqual([
      "2026-09-04T12:00:00.000Z",
      "2026-09-04T11:00:00.000Z",
      "yesterday",
      "",
    ]);
  });
});

describe("escalation", () => {
  it("HELD: P2→P1 and P1→P0 escalation never grants credit for mitigation steps that were not performed", () => {
    let p2 = declare("P2");
    for (const s of ["investigating", "fix_in_progress", "validating"] as const)
      p2 = advance(p2, step(s));
    const p1 = escalate(p2, "P1", { at: "t", actor: "a", note: "worse" });
    expect(currentStep(p1)).toBe("declared");
    expect(nextRequiredStep(p1)).toBe("evidence_preserved");
    expect(remainingSteps(p1)).toEqual(REQUIRED_SEQUENCES.P1.slice(1));

    let p1b = declare("P1");
    for (const s of ["evidence_preserved", "investigating"] as const) p1b = advance(p1b, step(s));
    const p0 = escalate(p1b, "P0", { at: "t", actor: "a", note: "harm" });
    expect(currentStep(p0)).toBe("declared");
    expect(nextRequiredStep(p0)).toBe("rollout_halted");
  });

  it("OBSERVED: a CLOSED incident can be escalated — the terminal state is silently reopened at the anchor step", () => {
    const closed = advance(runToBeforeClose("P2"), step("closed"));
    expect(isClosed(closed)).toBe(true);
    const reopened = escalate(closed, "P0", {
      at: "t",
      actor: "a",
      note: "postmortem found active harm",
    });
    expect(isClosed(reopened)).toBe(false);
    expect(currentStep(reopened)).toBe("declared");
    expect(reopened.severity).toBe("P0");
    // advance from the reopened state works as if never closed
    expect(currentStep(advance(reopened, step("rollout_halted")))).toBe("rollout_halted");
  });

  it("HELD: escalating twice in a row (P2→P1→P0) is allowed and both escalation notes stay on the timeline", () => {
    const p1 = escalate(declare("P2"), "P1", { at: "t", actor: "a", note: "one" });
    const p0 = escalate(p1, "P0", { at: "t", actor: "a", note: "two" });
    expect(p0.timeline.map((t) => t.note)).toEqual([
      "declared",
      "escalated P2 -> P1: one",
      "escalated P1 -> P0: two",
    ]);
  });

  it("OBSERVED: escalation does NOT require a non-empty note (advance does)", () => {
    const p1 = escalate(declare("P2"), "P1", { at: "t", actor: "", note: "" });
    expect(p1.timeline.at(-1)?.note).toBe("escalated P2 -> P1: ");
  });

  it("OBSERVED: escalation re-anchors on the SET of completed steps, so a P0 escalated after a P1 completed evidence_preserved... still restarts at declared (conservative)", () => {
    let p1 = declare("P1");
    for (const s of [
      "evidence_preserved",
      "investigating",
      "fix_in_progress",
      "validating",
      "postmortem",
    ] as const) {
      p1 = advance(p1, step(s));
    }
    const p0 = escalate(p1, "P0", { at: "t", actor: "a", note: "x" });
    expect(currentStep(p0)).toBe("declared");
    expect(remainingSteps(p0)).toHaveLength(REQUIRED_SEQUENCES.P0.length - 1);
  });
});

describe("corrupt timelines", () => {
  it("HELD: an empty timeline throws from currentStep/advance/remainingSteps", () => {
    const corrupt: Incident = { ...declare("P2"), timeline: [] };
    expect(() => currentStep(corrupt)).toThrowError(/empty timeline/);
    expect(() => advance(corrupt, step("investigating"))).toThrowError(/empty timeline/);
    expect(() => remainingSteps(corrupt)).toThrowError(/empty timeline/);
  });

  it("OBSERVED: a P2 incident whose last step is outside the P2 sequence: nextRequiredStep THROWS but remainingSteps returns the FULL sequence including 'declared'", () => {
    const corrupt: Incident = {
      ...declare("P2"),
      timeline: [
        ...declare("P2").timeline,
        { at: "t", step: "rollout_halted", actor: "a", note: "n" },
      ],
    };
    expect(() => nextRequiredStep(corrupt)).toThrowError(/is not part of the P2 sequence/);
    expect(remainingSteps(corrupt)).toEqual(REQUIRED_SEQUENCES.P2);
  });

  it("OBSERVED: an unknown severity string on a corrupt record makes nextRequiredStep crash with TypeError (REQUIRED_SEQUENCES lookup is undefined)", () => {
    const corrupt = { ...declare("P2"), severity: "P3" as Severity };
    expect(() => nextRequiredStep(corrupt)).toThrowError(TypeError);
    expect(() => remainingSteps(corrupt)).toThrowError(TypeError);
  });
});
