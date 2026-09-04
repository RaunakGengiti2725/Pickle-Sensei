/**
 * Adversarial pass 3 (tester #4) — @pickle/incident-response.
 *
 * Attacks: closing a postmortem-required incident with an EMPTY postmortemRef,
 * escalation with an empty note, escalation from a closed incident, timeline
 * clock skew, corrupt timelines (foreign step / empty), whitespace-only /
 * Unicode notes, 10k rapid illegal advances, and severity-comparison edge
 * cases.
 */
import { describe, expect, it } from "vitest";
import {
  IncompleteResponseError,
  InvalidEscalationError,
  InvalidTransitionError,
  REQUIRED_SEQUENCES,
  advance,
  attachPostmortem,
  currentStep,
  declareIncident,
  escalate,
  isAtLeastAsSevere,
  isClosed,
  isSeverity,
  nextRequiredStep,
  remainingSteps,
  type Incident,
  type ResponseStep,
  type Severity,
} from "../src/index.js";

function make(severity: Severity): Incident {
  return declareIncident({
    id: "INC-A4",
    severity,
    failureClass: "confident_wrong_coaching_at_scale",
    title: "attack",
    detectionSource: "monitoring_alert",
    detectedAt: "2026-09-04T00:00:00Z",
    affectedSurfaces: [],
    declaredBy: "tester4",
    note: "declared",
  });
}

function through(
  inc: Incident,
  steps: readonly ResponseStep[],
  at = "2026-09-04T01:00:00Z",
): Incident {
  let cur = inc;
  for (const step of steps) {
    if (step === "postmortem") cur = attachPostmortem(cur, "docs/postmortems/INC-A4.md");
    cur = advance(cur, { step, at, actor: "tester4", note: `did ${step}` });
  }
  return cur;
}

describe("postmortem gate", () => {
  it("REPRO: attachPostmortem(inc, '') satisfies the postmortem gate — a P0 closes with an empty postmortemRef", () => {
    const seq = REQUIRED_SEQUENCES.P0;
    let inc = through(
      make("P0"),
      seq.slice(1, -1).filter((s) => s !== "postmortem"),
    );
    inc = attachPostmortem(inc, "");
    inc = advance(inc, { step: "postmortem", at: "t", actor: "a", note: "n" });
    inc = advance(inc, { step: "closed", at: "t", actor: "a", note: "n" });
    expect(isClosed(inc)).toBe(true);
    expect(inc.postmortemRef).toBe("");
  });

  it.fails(
    "EXPECTED: a blank / whitespace postmortemRef is treated as missing (BROKEN, P3)",
    () => {
      const seq = REQUIRED_SEQUENCES.P1;
      let inc = through(
        make("P1"),
        seq.slice(1, -1).filter((s) => s !== "postmortem"),
      );
      inc = attachPostmortem(inc, "   ");
      inc = advance(inc, { step: "postmortem", at: "t", actor: "a", note: "n" });
      expect(() => advance(inc, { step: "closed", at: "t", actor: "a", note: "n" })).toThrow(
        IncompleteResponseError,
      );
    },
  );

  it("HELD: with postmortemRef null the close is refused with the missing step named", () => {
    const seq = REQUIRED_SEQUENCES.P1;
    let inc = through(
      make("P1"),
      seq.slice(1, -1).filter((s) => s !== "postmortem"),
    );
    inc = advance(inc, { step: "postmortem", at: "t", actor: "a", note: "n" });
    let caught: unknown;
    try {
      advance(inc, { step: "closed", at: "t", actor: "a", note: "n" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(IncompleteResponseError);
    expect((caught as IncompleteResponseError).missing).toEqual(["postmortem"]);
  });

  it("P2 has no postmortem step and closes without a ref", () => {
    const inc = through(make("P2"), REQUIRED_SEQUENCES.P2.slice(1));
    expect(isClosed(inc)).toBe(true);
    expect(inc.postmortemRef).toBeNull();
  });
});

describe("note validation", () => {
  it("advance refuses whitespace-only notes (incl. NBSP? — pin) and accepts Unicode", () => {
    const inc = make("P2");
    expect(() =>
      advance(inc, { step: "investigating", at: "t", actor: "a", note: "   \n\t" }),
    ).toThrow(/non-empty note/);
    // U+00A0 NBSP and U+3000 ideographic space ARE trimmed by String.prototype.trim
    expect(() =>
      advance(inc, { step: "investigating", at: "t", actor: "a", note: "\u00a0\u3000" }),
    ).toThrow(/non-empty note/);
    // zero-width space is NOT whitespace for trim() → accepted as a "note" (pin)
    const zw = advance(inc, { step: "investigating", at: "t", actor: "a", note: "\u200b" });
    expect(zw.timeline.at(-1)!.note).toBe("\u200b");
    const uni = advance(inc, { step: "investigating", at: "t", actor: "a", note: "調査中 🏓" });
    expect(uni.timeline.at(-1)!.note).toBe("調査中 🏓");
  });

  it("REPRO: escalate() does not require a note (empty string accepted) unlike advance()", () => {
    const inc = escalate(make("P2"), "P0", { at: "t", actor: "a", note: "" });
    expect(inc.severity).toBe("P0");
    expect(inc.timeline.at(-1)!.note).toBe("escalated P2 -> P0: ");
  });

  it("advance with an empty actor is accepted (pin — no actor validation)", () => {
    const inc = advance(make("P2"), { step: "investigating", at: "t", actor: "", note: "n" });
    expect(inc.timeline.at(-1)!.actor).toBe("");
  });
});

describe("escalation", () => {
  it("HELD: same-severity and de-escalation are refused", () => {
    for (const [from, to] of [
      ["P0", "P0"],
      ["P0", "P1"],
      ["P1", "P2"],
      ["P0", "P2"],
    ] as const) {
      expect(() => escalate(make(from), to, { at: "t", actor: "a", note: "n" })).toThrow(
        InvalidEscalationError,
      );
    }
  });

  it("escalating a CLOSED P2 to P1 reopens it at 'declared' (closed is dropped from credit; no evidence step done)", () => {
    const closed = through(make("P2"), REQUIRED_SEQUENCES.P2.slice(1));
    const esc = escalate(closed, "P1", { at: "t", actor: "a", note: "worse than thought" });
    expect(isClosed(esc)).toBe(false);
    expect(currentStep(esc)).toBe("declared");
    expect(nextRequiredStep(esc)).toBe("evidence_preserved");
    // completed steps remain in the timeline; they are simply not credited
    expect(esc.timeline.filter((t) => t.step === "closed")).toHaveLength(1);
  });

  it("P1 fully investigated → P0 rewinds to 'declared' (mitigation steps were never done)", () => {
    const inc = through(make("P1"), ["evidence_preserved", "investigating", "fix_in_progress"]);
    const esc = escalate(inc, "P0", { at: "t", actor: "a", note: "n" });
    expect(currentStep(esc)).toBe("declared");
    expect(remainingSteps(esc)).toEqual(REQUIRED_SEQUENCES.P0.slice(1));
  });

  it("P0 credit is granted step-by-step: rollout_halted done → anchor rollout_halted, not further", () => {
    const inc = through(make("P1"), ["evidence_preserved", "investigating"]);
    // forge a P0-only step into a P1 timeline (corrupt store) then escalate
    const forged: Incident = {
      ...inc,
      timeline: [...inc.timeline, { at: "t", step: "rollout_halted", actor: "x", note: "forged" }],
    };
    const esc = escalate(forged, "P0", { at: "t", actor: "a", note: "n" });
    // declared ✓, rollout_halted ✓ (forged), feature_disabled ✗ → anchor rollout_halted
    expect(currentStep(esc)).toBe("rollout_halted");
    expect(nextRequiredStep(esc)).toBe("feature_disabled");
  });

  it("escalate() ignores ORDER of completed steps — a P1 that recorded steps out of order still gets gap-free credit only", () => {
    const inc = make("P1");
    const forged: Incident = {
      ...inc,
      timeline: [
        ...inc.timeline,
        { at: "t", step: "investigating", actor: "x", note: "out of order" },
      ],
    };
    const esc = escalate(forged, "P0", { at: "t", actor: "a", note: "n" });
    expect(currentStep(esc)).toBe("declared");
  });
});

describe("corrupt / skewed state", () => {
  it("empty timeline → currentStep throws a clear error; nextRequiredStep/isClosed propagate it", () => {
    const inc: Incident = { ...make("P2"), timeline: [] };
    expect(() => currentStep(inc)).toThrow(/empty timeline/);
    expect(() => nextRequiredStep(inc)).toThrow(/empty timeline/);
    expect(() => isClosed(inc)).toThrow(/empty timeline/);
  });

  it("a step foreign to the severity's sequence (e.g. P2 at 'rollout_halted') is refused on advance", () => {
    const inc: Incident = {
      ...make("P2"),
      timeline: [{ at: "t", step: "rollout_halted", actor: "x", note: "corrupt" }],
    };
    expect(() => nextRequiredStep(inc)).toThrow(/not part of the P2 sequence/);
    expect(() => advance(inc, { step: "investigating", at: "t", actor: "a", note: "n" })).toThrow(
      /not part of the P2 sequence/,
    );
    // remainingSteps() does NOT validate: indexOf = -1 → slice(0) = whole sequence (pin)
    expect(remainingSteps(inc)).toEqual(REQUIRED_SEQUENCES.P2);
  });

  it("REPRO: timeline `at` may go backwards / be garbage — no monotonicity or ISO validation (pin)", () => {
    let inc = make("P2");
    inc = advance(inc, {
      step: "investigating",
      at: "1999-01-01T00:00:00Z",
      actor: "a",
      note: "n",
    });
    inc = advance(inc, { step: "fix_in_progress", at: "not a date", actor: "a", note: "n" });
    inc = advance(inc, { step: "validating", at: "", actor: "a", note: "n" });
    expect(inc.timeline.map((t) => t.at)).toEqual([
      "2026-09-04T00:00:00Z",
      "1999-01-01T00:00:00Z",
      "not a date",
      "",
    ]);
  });

  it("an unknown severity string on a corrupt record makes REQUIRED_SEQUENCES lookup undefined → TypeError, not a silent pass", () => {
    const inc = { ...make("P2"), severity: "P3" as Severity };
    expect(isSeverity("P3")).toBe(false);
    expect(() => nextRequiredStep(inc)).toThrow(TypeError);
    expect(() => advance(inc, { step: "investigating", at: "t", actor: "a", note: "n" })).toThrow(
      TypeError,
    );
  });

  it("isAtLeastAsSevere is a total order over P0 > P1 > P2 and reflexive", () => {
    const sev: Severity[] = ["P0", "P1", "P2"];
    for (const a of sev) {
      for (const b of sev) {
        expect(isAtLeastAsSevere(a, b)).toBe(sev.indexOf(a) <= sev.indexOf(b));
      }
    }
  });
});

describe("rapid repeats / immutability", () => {
  it("10k illegal advances on a closed P2 all throw InvalidTransitionError with expected=null and leave the record untouched", () => {
    const closed = through(make("P2"), REQUIRED_SEQUENCES.P2.slice(1));
    const before = JSON.stringify(closed);
    for (let i = 0; i < 10_000; i++) {
      let caught: unknown;
      try {
        advance(closed, { step: "declared", at: "t", actor: "a", note: "n" });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(InvalidTransitionError);
      expect((caught as InvalidTransitionError).expected).toBeNull();
    }
    expect(JSON.stringify(closed)).toBe(before);
  });

  it("every skip / reorder from every position in every sequence is refused, and the error names the required step", () => {
    for (const severity of ["P0", "P1", "P2"] as const) {
      const seq = REQUIRED_SEQUENCES[severity];
      for (let i = 0; i < seq.length - 1; i++) {
        const inc = through(make(severity), seq.slice(1, i + 1));
        expect(currentStep(inc)).toBe(seq[i]);
        for (const attempted of seq) {
          if (attempted === seq[i + 1]) continue;
          let caught: unknown;
          try {
            advance(inc, { step: attempted, at: "t", actor: "a", note: "n" });
          } catch (e) {
            caught = e;
          }
          expect(caught, `${severity} ${seq[i]} -> ${attempted}`).toBeInstanceOf(
            InvalidTransitionError,
          );
          expect((caught as InvalidTransitionError).expected).toBe(seq[i + 1]);
        }
      }
    }
  });
});
