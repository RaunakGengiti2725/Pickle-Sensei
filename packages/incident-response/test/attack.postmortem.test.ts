import { describe, expect, it } from "vitest";
import {
  IncompleteResponseError,
  InvalidTransitionError,
  REQUIRED_SEQUENCES,
  addEvidence,
  advance,
  attachPostmortem,
  currentStep,
  declareIncident,
  escalate,
  isClosed,
  nextRequiredStep,
  type Incident,
  type ResponseStep,
  type Severity,
} from "../src/index.js";

/**
 * Adversarial pass (shared-packages-ops #2, pass 3) against the incident
 * state machine: whitespace / unicode-only postmortem refs, note validation
 * bypass, timeline corruption, escalation interleavings, clock skew.
 * FINDING tests pin current behaviour so the repro is executable; the
 * expected behaviour is in the test name.
 */

const AT = "2026-08-29T01:00:00Z";

function makeIncident(severity: Severity, id = "INC-ATTACK"): Incident {
  return declareIncident({
    id,
    severity,
    failureClass: "confident_wrong_coaching_at_scale",
    title: "attack",
    detectionSource: "red_team",
    detectedAt: "2026-08-29T00:00:00Z",
    affectedSurfaces: ["feature_flag:coaching_v2"],
    declaredBy: "red-team",
    note: "declared",
  });
}

/** Advance through every step up to (not including) the given step. */
function advanceUntil(incident: Incident, stop: ResponseStep): Incident {
  let current = incident;
  for (const step of REQUIRED_SEQUENCES[incident.severity]) {
    if (step === "declared") continue;
    if (step === stop) break;
    current = advance(current, { step, at: AT, actor: "oncall", note: `did ${step}` });
  }
  return current;
}

function readyToClose(severity: Severity): Incident {
  return advanceUntil(makeIncident(severity), "closed");
}

const closeInput = { step: "closed" as const, at: AT, actor: "oncall", note: "closing" };

describe("attack: whitespace / degenerate postmortem refs on P0 close", () => {
  const degenerate: Array<[string, string]> = [
    ["three spaces", "   "],
    ["empty string", ""],
    ["tab + newline", "\t\n"],
    ["NBSP", "\u00a0"],
    ["zero-width space", "\u200b"],
    ["BOM", "\ufeff"],
    ["ideographic space", "\u3000"],
    ["the literal string 'null'", "null"],
    ["the literal string 'undefined'", "undefined"],
  ];

  for (const [label, ref] of degenerate) {
    it(`FINDING: attachPostmortem(inc, ${label}) lets a P0 close — expected IncompleteResponseError`, () => {
      const inc = attachPostmortem(readyToClose("P0"), ref);
      expect(inc.postmortemRef).toBe(ref);
      // Pins current behaviour: only `=== null` is checked, so the close
      // succeeds and a P0 is "done" with no postmortem document.
      const closed = advance(inc, closeInput);
      expect(isClosed(closed)).toBe(true);
      expect(closed.postmortemRef).toBe(ref);
    });
  }

  it("FINDING: same on P1 (also postmortem-required) with '   '", () => {
    const inc = attachPostmortem(readyToClose("P1"), "   ");
    expect(isClosed(advance(inc, closeInput))).toBe(true);
  });

  it("HELD: P0 close with postmortemRef === null → IncompleteResponseError(missing=[postmortem])", () => {
    const inc = readyToClose("P0");
    expect(inc.postmortemRef).toBeNull();
    expect(() => advance(inc, closeInput)).toThrow(IncompleteResponseError);
    try {
      advance(inc, closeInput);
    } catch (error) {
      expect((error as IncompleteResponseError).missing).toEqual(["postmortem"]);
    }
  });

  it("HELD: a real ref closes; P2 (no postmortem step) closes with ref null", () => {
    expect(
      isClosed(advance(attachPostmortem(readyToClose("P0"), "docs/postmortems/x.md"), closeInput)),
    ).toBe(true);
    expect(isClosed(advance(readyToClose("P2"), closeInput))).toBe(true);
  });

  it("FINDING: attachPostmortem accepts a ref BEFORE the postmortem step and even after close (no state guard)", () => {
    // Attaching at "declared" is allowed, so the ref can be pre-seeded long
    // before any postmortem exists; attaching after close silently rewrites
    // the closed record's ref. Expected: reject both (append-only record).
    const early = attachPostmortem(makeIncident("P0"), "docs/postmortems/premature.md");
    expect(early.postmortemRef).toBe("docs/postmortems/premature.md");
    const closed = advance(attachPostmortem(readyToClose("P0"), "a.md"), closeInput);
    const rewritten = attachPostmortem(closed, "b.md");
    expect(rewritten.postmortemRef).toBe("b.md");
    expect(isClosed(rewritten)).toBe(true);
  });

  it("FINDING: attachPostmortem(inc, null as never) resets the ref; the close then correctly throws — ref can be revoked silently", () => {
    const withRef = attachPostmortem(readyToClose("P0"), "docs/postmortems/x.md");
    const revoked = attachPostmortem(withRef, null as unknown as string);
    expect(revoked.postmortemRef).toBeNull();
    expect(() => advance(revoked, closeInput)).toThrow(IncompleteResponseError);
  });
});

describe("attack: note validation and step ordering", () => {
  it("HELD: whitespace-only, NBSP-only, BOM-only and empty notes are rejected on every step", () => {
    const inc = makeIncident("P0");
    for (const note of ["", "   ", "\t\n", "\u00a0", "\u3000", "\ufeff"]) {
      expect(() => advance(inc, { step: "rollout_halted", at: AT, actor: "oncall", note })).toThrow(
        /non-empty note/,
      );
    }
  });

  it("FINDING (P3): zero-width space / word joiner / Mongolian vowel separator pass the non-empty note check (not White_Space, so trim() keeps them)", () => {
    const inc = makeIncident("P0");
    for (const note of ["\u200b", "\u2060", "\u180e", "\u200b\u200b\u200b"]) {
      const next = advance(inc, { step: "rollout_halted", at: AT, actor: "oncall", note });
      expect(currentStep(next)).toBe("rollout_halted");
    }
  });

  it("HELD: every skip, repeat and backward transition throws InvalidTransitionError (P0 exhaustive)", () => {
    const seq = REQUIRED_SEQUENCES.P0;
    for (let i = 1; i < seq.length; i += 1) {
      const inc = advanceUntil(makeIncident("P0"), seq[i]!);
      for (const step of seq) {
        if (step === seq[i]) continue;
        expect(() => advance(inc, { step, at: AT, actor: "x", note: "n" })).toThrow(
          InvalidTransitionError,
        );
      }
    }
  });

  it("HELD: closed is terminal — every step including 'closed' again throws", () => {
    const closed = advance(attachPostmortem(readyToClose("P0"), "x.md"), closeInput);
    for (const step of REQUIRED_SEQUENCES.P0) {
      expect(() => advance(closed, { step, at: AT, actor: "x", note: "n" })).toThrow(
        InvalidTransitionError,
      );
    }
    expect(nextRequiredStep(closed)).toBeNull();
  });

  it("HELD: a P2 (shorter sequence) cannot be advanced through P0-only steps", () => {
    const inc = makeIncident("P2");
    expect(() => advance(inc, { step: "rollout_halted", at: AT, actor: "x", note: "n" })).toThrow(
      InvalidTransitionError,
    );
  });

  it("HELD: rapid repeat of the same advance on the SAME immutable input always yields identical results (pure)", () => {
    const inc = makeIncident("P0");
    const a = advance(inc, { step: "rollout_halted", at: AT, actor: "x", note: "n" });
    const b = advance(inc, { step: "rollout_halted", at: AT, actor: "x", note: "n" });
    expect(a).toEqual(b);
    expect(inc.timeline).toHaveLength(1);
  });
});

describe("attack: clock skew and timeline corruption", () => {
  it("FINDING (P3): timestamps are not validated — a step can be completed 'before' the previous one, or with garbage", () => {
    const inc = makeIncident("P0");
    const skewed = advance(inc, {
      step: "rollout_halted",
      at: "1970-01-01T00:00:00Z",
      actor: "x",
      note: "time travel",
    });
    expect(skewed.timeline[1]!.at).toBe("1970-01-01T00:00:00Z");
    const garbage = advance(inc, {
      step: "rollout_halted",
      at: "not-a-date",
      actor: "x",
      note: "n",
    });
    expect(garbage.timeline[1]!.at).toBe("not-a-date");
  });

  it("HELD: a corrupt timeline whose last step is outside the severity sequence makes advance() throw", () => {
    const inc = makeIncident("P2");
    const corrupt: Incident = {
      ...inc,
      timeline: [...inc.timeline, { at: AT, step: "rollout_halted", actor: "x", note: "n" }],
    };
    expect(() =>
      advance(corrupt, { step: "investigating", at: AT, actor: "x", note: "n" }),
    ).toThrow(/not part of the P2 sequence/);
  });

  it("HELD: an empty timeline throws rather than treating the incident as declared", () => {
    const inc: Incident = { ...makeIncident("P0"), timeline: [] };
    expect(() => currentStep(inc)).toThrow(/empty timeline/);
    expect(() => advance(inc, { step: "rollout_halted", at: AT, actor: "x", note: "n" })).toThrow();
  });

  it("FINDING (P3): a timeline whose LAST entry is 'declared' but which already contains later steps is trusted (only the tail is inspected)", () => {
    // Someone (or a bad merge) appends a second "declared" after "validating";
    // the machine rewinds to declared and requires the full sequence again,
    // but the earlier entries remain and `remainingSteps` is now wrong relative
    // to what was actually done. Not exploitable for closing early — pinned
    // so it is visible.
    const inc = advanceUntil(makeIncident("P0"), "postmortem");
    const rewound: Incident = {
      ...inc,
      timeline: [...inc.timeline, { at: AT, step: "declared", actor: "x", note: "re-declared" }],
    };
    expect(nextRequiredStep(rewound)).toBe("rollout_halted");
    expect(() => advance(rewound, { step: "postmortem", at: AT, actor: "x", note: "n" })).toThrow(
      InvalidTransitionError,
    );
  });
});

describe("attack: escalation interleavings", () => {
  it("HELD: escalating P2→P0 at 'validating' rewinds to 'declared' (P0 mitigations were never done) and cannot close", () => {
    const inc = advanceUntil(makeIncident("P2"), "closed");
    expect(currentStep(inc)).toBe("validating");
    const escalated = escalate(inc, "P0", { at: AT, actor: "x", note: "worse than thought" });
    expect(escalated.severity).toBe("P0");
    expect(currentStep(escalated)).toBe("declared");
    expect(() => advance(escalated, closeInput)).toThrow(InvalidTransitionError);
  });

  it("HELD: de-escalation and same-severity escalation throw; a closed incident can still be escalated (re-opens)", () => {
    const inc = makeIncident("P1");
    expect(() => escalate(inc, "P2", { at: AT, actor: "x", note: "n" })).toThrow();
    expect(() => escalate(inc, "P1", { at: AT, actor: "x", note: "n" })).toThrow();
    const closed = advance(readyToClose("P2"), closeInput);
    const reopened = escalate(closed, "P0", { at: AT, actor: "x", note: "n" });
    expect(isClosed(reopened)).toBe(false);
    expect(reopened.severity).toBe("P0");
  });

  it("FINDING (P3): escalation accepts an empty note (advance() rejects one)", () => {
    const inc = makeIncident("P2");
    const escalated = escalate(inc, "P1", { at: AT, actor: "x", note: "" });
    expect(escalated.severity).toBe("P1");
    expect(escalated.timeline.at(-1)!.note).toBe("escalated P2 -> P1: ");
  });

  it("HELD: P1→P0 after 'evidence_preserved' anchors at 'declared' — P0 requires halted/disabled/rolled_back first, no credit for skipped mitigations", () => {
    const inc = advanceUntil(makeIncident("P1"), "investigating");
    expect(currentStep(inc)).toBe("evidence_preserved");
    const escalated = escalate(inc, "P0", { at: AT, actor: "x", note: "n" });
    expect(currentStep(escalated)).toBe("declared");
  });
});

describe("attack: evidence log and huge inputs", () => {
  it("HELD: evidence is append-only via spread; a 10k-entry log survives and the input is not mutated", () => {
    let inc = makeIncident("P0");
    const original = inc;
    for (let i = 0; i < 10_000; i += 1) {
      inc = addEvidence(inc, { capturedAt: AT, description: `e${i}`, location: null });
    }
    expect(inc.evidence).toHaveLength(10_000);
    expect(original.evidence).toHaveLength(0);
  });

  it("FINDING (P3): evidence entries with empty description are accepted", () => {
    const inc = addEvidence(makeIncident("P0"), {
      capturedAt: AT,
      description: "",
      location: null,
    });
    expect(inc.evidence[0]!.description).toBe("");
  });

  it("HELD: a 1 MiB unicode postmortem ref is stored verbatim (no truncation, no throw)", () => {
    const ref = "🥒".repeat(262_144); // 1 MiB of UTF-16 code units
    const inc = attachPostmortem(readyToClose("P0"), ref);
    expect(inc.postmortemRef).toHaveLength(ref.length);
    expect(isClosed(advance(inc, closeInput))).toBe(true);
  });
});
