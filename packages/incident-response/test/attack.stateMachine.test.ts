/**
 * Adversarial variants of shared-packages-ops::SPO-4 against the fix in
 * e82addc3 (stateMachine.ts). Every test passes on the candidate; 21 of them
 * fail on 4d812e1a (see the attack report). Kept as regression pins for the
 * variants the adjudication test does not cover: closed P1 → P0, closed-check
 * precedence over the blank-note check, the wider blank alphabet (Cc/Cf/Zs/Zl/Zp),
 * content that must NOT be treated as blank, escalation anchoring, and the
 * close guard with a blank ref injected after attachPostmortem().
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
  isClosed,
  nextRequiredStep,
  type Incident,
  type Severity,
} from "../src/index.js";

const meta = { at: "2026-09-04T00:00:00Z", actor: "oncall", note: "n" };

function declared(severity: Severity): Incident {
  return declareIncident({
    id: `inc-${severity}`,
    severity,
    failureClass: "queue_stall",
    title: "t",
    detectionSource: "monitoring_alert",
    detectedAt: meta.at,
    affectedSurfaces: ["media"],
    declaredBy: "oncall",
    note: "declared",
  });
}

function closeAll(start: Incident): Incident {
  let inc = start;
  for (const step of REQUIRED_SEQUENCES[inc.severity].slice(1)) {
    if (step === "postmortem") inc = attachPostmortem(inc, "docs/pm.md");
    inc = advance(inc, { step, ...meta });
  }
  expect(isClosed(inc)).toBe(true);
  return inc;
}

describe("attack: closed is terminal for every severity pair", () => {
  it("closed P1 → P0 throws InvalidTransitionError", () => {
    const inc = closeAll(declared("P1"));
    expect(() => escalate(inc, "P0", meta)).toThrow(InvalidTransitionError);
  });

  it("closed P0 → P1/P0 throws (de-escalation / no-op error is acceptable)", () => {
    const inc = closeAll(declared("P0"));
    expect(() => escalate(inc, "P1", meta)).toThrow(InvalidEscalationError);
    expect(() => escalate(inc, "P0", meta)).toThrow(InvalidEscalationError);
  });

  it("closed check takes precedence over the blank-note check", () => {
    const inc = closeAll(declared("P2"));
    expect(() => escalate(inc, "P0", { ...meta, note: "" })).toThrow(InvalidTransitionError);
  });
});

const BLANKS: Record<string, string> = {
  nul: "\u0000",
  del: "\u007f",
  c1NextLine: "\u0085",
  softHyphen: "\u00ad",
  alm: "\u061c",
  choseongSpaceOgham: "\u1680",
  mongolianVowelSeparator: "\u180e",
  hairSpace: "\u200a",
  lrm: "\u200e",
  lineSeparator: "\u2028",
  paragraphSeparator: "\u2029",
  mediumMathematicalSpace: "\u205f",
  wordJoiner: "\u2060",
  ideographicSpace: "\u3000",
  tagCharacter: "\u{e0001}",
  mixed: " \u00a0\ufeff\u200b\t\r\n\u0000",
};

describe("attack: the whole blank alphabet is rejected by advance/escalate/attachPostmortem", () => {
  for (const [name, text] of Object.entries(BLANKS)) {
    it(name, () => {
      expect(() => advance(declared("P2"), { step: "investigating", ...meta, note: text })).toThrow(
        /non-empty note/,
      );
      expect(() => escalate(declared("P2"), "P1", { ...meta, note: text })).toThrow(
        /non-empty note/,
      );
      expect(() => attachPostmortem(declared("P1"), text)).toThrow(/postmortemRef/);
    });
  }
});

describe("attack: real content is never mistaken for blank", () => {
  const CONTENT = [
    "a",
    "0",
    " x ",
    "é",
    "\u0301", // lone combining mark (Mn)
    "👍",
    "🏴\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}", // base emoji + tag sequence
    "\ud800", // lone surrogate (Cs)
  ];
  for (const text of CONTENT) {
    it(JSON.stringify(text), () => {
      expect(() => attachPostmortem(declared("P1"), text)).not.toThrow();
      expect(() =>
        advance(declared("P2"), { step: "investigating", ...meta, note: text }),
      ).not.toThrow();
    });
  }

  it("5 MB blank / 5 MB blank + one character stays linear", () => {
    const big = " ".repeat(5_000_000);
    const started = Date.now();
    expect(() => attachPostmortem(declared("P1"), big)).toThrow(/postmortemRef/);
    expect(() => attachPostmortem(declared("P1"), `${big}x`)).not.toThrow();
    expect(() => attachPostmortem(declared("P1"), `x${big}`)).not.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("attack: escalation anchoring cannot be used to skip steps", () => {
  it("escalate does not mutate its input, even when it throws", () => {
    const open = declared("P2");
    const snapshot = JSON.stringify(open);
    escalate(open, "P0", meta);
    expect(JSON.stringify(open)).toBe(snapshot);
    const closed = closeAll(declared("P2"));
    const closedSnapshot = JSON.stringify(closed);
    expect(() => escalate(closed, "P0", meta)).toThrow(InvalidTransitionError);
    expect(JSON.stringify(closed)).toBe(closedSnapshot);
  });

  it("P2 at validating → P1 rewinds to declared; closed/postmortem are not reachable", () => {
    let inc = declared("P2");
    for (const step of ["investigating", "fix_in_progress", "validating"] as const) {
      inc = advance(inc, { step, ...meta });
    }
    const esc = escalate(inc, "P1", meta);
    expect(currentStep(esc)).toBe("declared");
    expect(nextRequiredStep(esc)).toBe("evidence_preserved");
    expect(() => advance(esc, { step: "closed", ...meta })).toThrow(InvalidTransitionError);
    expect(() => advance(esc, { step: "postmortem", ...meta })).toThrow(InvalidTransitionError);
  });

  it("steps completed at the lower severity give no credit past the first gap", () => {
    let inc = declared("P2");
    for (const step of ["investigating", "fix_in_progress"] as const) {
      inc = advance(inc, { step, ...meta });
    }
    const afterEvidence = advance(escalate(inc, "P1", meta), {
      step: "evidence_preserved",
      ...meta,
    });
    expect(nextRequiredStep(afterEvidence)).toBe("investigating");
    expect(() => advance(afterEvidence, { step: "closed", ...meta })).toThrow(
      InvalidTransitionError,
    );
    expect(() => advance(afterEvidence, { step: "fix_in_progress", ...meta })).toThrow(
      InvalidTransitionError,
    );
  });

  it("P2 → P1 → P0 with no work in between still requires the full P0 chain", () => {
    const inc = escalate(escalate(declared("P2"), "P1", meta), "P0", meta);
    expect(inc.severity).toBe("P0");
    expect(inc.timeline.map((entry) => entry.step)).toEqual(["declared", "declared", "declared"]);
    expect(nextRequiredStep(inc)).toBe("rollout_halted");
  });

  it("P1 with an attached postmortem → P0 keeps the ref and restarts at declared", () => {
    let inc = declared("P1");
    for (const step of [
      "evidence_preserved",
      "investigating",
      "fix_in_progress",
      "validating",
    ] as const) {
      inc = advance(inc, { step, ...meta });
    }
    inc = advance(attachPostmortem(inc, "docs/pm-p1.md"), { step: "postmortem", ...meta });
    const esc = escalate(inc, "P0", meta);
    expect(esc.severity).toBe("P0");
    expect(currentStep(esc)).toBe("declared");
    expect(nextRequiredStep(esc)).toBe("rollout_halted");
    expect(esc.postmortemRef).toBe("docs/pm-p1.md");
  });
});

describe("attack: close guard reads the ref, not just its nullness", () => {
  it("P0 with a zero-width ref injected after attachPostmortem cannot close", () => {
    let inc = declared("P0");
    for (const step of REQUIRED_SEQUENCES.P0.slice(1, -1)) {
      if (step === "postmortem") inc = attachPostmortem(inc, "docs/pm.md");
      inc = advance(inc, { step, ...meta });
    }
    const zeroWidth: Incident = { ...inc, postmortemRef: "\u200b\u2060" };
    expect(() => advance(zeroWidth, { step: "closed", ...meta })).toThrow(IncompleteResponseError);
    const nulled: Incident = { ...inc, postmortemRef: null };
    expect(() => advance(nulled, { step: "closed", ...meta })).toThrow(IncompleteResponseError);
    expect(isClosed(advance(inc, { step: "closed", ...meta }))).toBe(true);
  });

  it("P2 (no postmortem required) still closes regardless of the ref", () => {
    let inc = declared("P2");
    for (const step of ["investigating", "fix_in_progress", "validating"] as const) {
      inc = advance(inc, { step, ...meta });
    }
    const blankRef: Incident = { ...inc, postmortemRef: " " };
    expect(isClosed(advance(blankRef, { step: "closed", ...meta }))).toBe(true);
    expect(isClosed(advance(inc, { step: "closed", ...meta }))).toBe(true);
  });
});
