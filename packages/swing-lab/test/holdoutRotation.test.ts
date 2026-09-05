import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HELD_OUT_CASE_IDS } from "../src/coachGates.js";
import { REPO_ROOT } from "../src/engine/corpus.js";
import {
  auditSuccessorDesignations,
  decodeHoldoutLedger,
  evaluateCertificationReadiness,
  evaluateHoldout,
  HOLDOUT_LEDGER_PATH,
  HoldoutLedgerError,
  INSPECTION_BUDGETS,
  isHoldoutTier,
  loadHoldoutLedger,
  type HoldoutEntry,
  type HoldoutLedger,
  type HoldoutTier,
  type InspectionEvent,
  type SuccessorDesignation,
} from "../src/holdoutRotation.js";

/**
 * I14 holdout-rotation governance.
 *
 * Unit tests pin the enforcement rules (over-inspected ACTIVE holdouts
 * block certification until retired with an uninspected label-blind
 * successor); integration tests pin the honest state of the repo's real
 * held-out cases: wm-dink-01 and afn-vic-rally1 were inspected far past
 * any locked-test budget (committed labels, failure dossiers, ownership
 * reviews, hundreds of referencing artifacts), so the ledger retires them
 * to regression, and their successors are pending an external front-door
 * freeze — certification therefore stays BLOCKED. This suite must never
 * be edited to flip that verdict without new external evidence.
 */

const tmpRoots: string[] = [];
afterAll(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true });
});

function event(overrides: Partial<InspectionEvent> = {}): InspectionEvent {
  return {
    kind: "benchmark_evaluation",
    dateIso: "2026-08-29",
    workstream: "test",
    evidence: "synthetic unit-test event",
    ...overrides,
  };
}

function entry(overrides: Partial<HoldoutEntry> = {}): HoldoutEntry {
  return {
    caseId: "case-x",
    tier: "LOCKED_TEST",
    status: "ACTIVE",
    firstHeldOutAtIso: "2026-08-01",
    inspections: [],
    retirement: null,
    notes: "",
    ...overrides,
  };
}

function successor(overrides: Partial<SuccessorDesignation> = {}): SuccessorDesignation {
  return {
    caseId: "fresh-y",
    tier: "SHADOW_HOLDOUT",
    designatedAtIso: "2026-08-29",
    designationRule: "unit-test rule",
    registryRef: "unit-test",
    labelBlind: true,
    inspectionCount: 0,
    pendingExternal: "",
    ...overrides,
  };
}

function ledger(overrides: Partial<HoldoutLedger> = {}): HoldoutLedger {
  return {
    schemaVersion: 1,
    policyVersion: "holdout-rotation-v1",
    generatedAtIso: "2026-08-29T00:00:00.000Z",
    holdouts: [],
    successors: [],
    ...overrides,
  };
}

describe("holdout tier budgets", () => {
  it("SHADOW_HOLDOUT tolerates zero inspections", () => {
    expect(INSPECTION_BUDGETS.SHADOW_HOLDOUT).toBe(0);
    const evaluation = evaluateHoldout(entry({ tier: "SHADOW_HOLDOUT", inspections: [event()] }));
    expect(evaluation.verdict).toBe("OVER_INSPECTED");
  });

  it("LOCKED_TEST within its frozen budget stays WITHIN_BUDGET", () => {
    const evaluation = evaluateHoldout(entry({ inspections: [event(), event(), event()] }));
    expect(evaluation.verdict).toBe("WITHIN_BUDGET");
    expect(evaluation.violations).toEqual([]);
  });

  it("LOCKED_TEST past its budget is OVER_INSPECTED with an explicit violation", () => {
    const evaluation = evaluateHoldout(
      entry({ inspections: [event(), event(), event(), event()] }),
    );
    expect(evaluation.verdict).toBe("OVER_INSPECTED");
    expect(evaluation.violations.join(" ")).toContain("must be retired to regression");
  });

  it("DEV and VALIDATION tiers are unbounded iteration tiers", () => {
    const many = Array.from({ length: 500 }, () => event());
    expect(evaluateHoldout(entry({ tier: "DEV", inspections: many })).verdict).toBe(
      "WITHIN_BUDGET",
    );
    expect(evaluateHoldout(entry({ tier: "VALIDATION", inspections: many })).verdict).toBe(
      "WITHIN_BUDGET",
    );
  });
});

describe("certification readiness enforcement", () => {
  const overInspected = entry({
    caseId: "hot-case",
    inspections: [event(), event(), event(), event()],
  });

  it("an over-inspected ACTIVE holdout blocks certification", () => {
    const readiness = evaluateCertificationReadiness(ledger({ holdouts: [overInspected] }));
    expect(readiness.status).toBe("BLOCKED");
    expect(readiness.reasons.join(" ")).toContain("hot-case");
  });

  it("retiring without naming a successor still blocks certification", () => {
    const retired = entry({
      ...overInspected,
      status: "RETIRED_TO_REGRESSION",
      retirement: {
        dateIso: "2026-08-29",
        workstream: "test",
        reason: "over budget",
        regressionRole: "regression fixture",
        successorId: null,
      },
    });
    const readiness = evaluateCertificationReadiness(ledger({ holdouts: [retired] }));
    expect(readiness.status).toBe("BLOCKED");
    expect(readiness.reasons.join(" ")).toContain("retired without a designated");
  });

  it("a named successor missing from the designation list blocks certification", () => {
    const retired = entry({
      ...overInspected,
      status: "RETIRED_TO_REGRESSION",
      retirement: {
        dateIso: "2026-08-29",
        workstream: "test",
        reason: "over budget",
        regressionRole: "regression fixture",
        successorId: "ghost",
      },
    });
    const readiness = evaluateCertificationReadiness(ledger({ holdouts: [retired] }));
    expect(readiness.status).toBe("BLOCKED");
    expect(readiness.reasons.join(" ")).toContain("no successor designation exists");
  });

  it("an inspected or non-label-blind successor blocks certification", () => {
    const retired = entry({
      ...overInspected,
      status: "RETIRED_TO_REGRESSION",
      retirement: {
        dateIso: "2026-08-29",
        workstream: "test",
        reason: "over budget",
        regressionRole: "regression fixture",
        successorId: "fresh-y",
      },
    });
    const inspectedSuccessor = evaluateCertificationReadiness(
      ledger({ holdouts: [retired], successors: [successor({ inspectionCount: 2 })] }),
    );
    expect(inspectedSuccessor.status).toBe("BLOCKED");
    expect(inspectedSuccessor.reasons.join(" ")).toContain("must start uninspected");

    const labeledSuccessor = evaluateCertificationReadiness(
      ledger({ holdouts: [retired], successors: [successor({ labelBlind: false })] }),
    );
    expect(labeledSuccessor.status).toBe("BLOCKED");
    expect(labeledSuccessor.reasons.join(" ")).toContain("not label-blind");
  });

  it("a successor with a pending external step keeps certification blocked", () => {
    const retired = entry({
      ...overInspected,
      status: "RETIRED_TO_REGRESSION",
      retirement: {
        dateIso: "2026-08-29",
        workstream: "test",
        reason: "over budget",
        regressionRole: "regression fixture",
        successorId: "fresh-y",
      },
    });
    const readiness = evaluateCertificationReadiness(
      ledger({
        holdouts: [retired],
        successors: [successor({ pendingExternal: "front-door freeze required" })],
      }),
    );
    expect(readiness.status).toBe("BLOCKED");
    expect(readiness.reasons.join(" ")).toContain("front-door freeze required");
  });

  it("retirement plus a clean designated successor makes certification ELIGIBLE", () => {
    const retired = entry({
      ...overInspected,
      status: "RETIRED_TO_REGRESSION",
      retirement: {
        dateIso: "2026-08-29",
        workstream: "test",
        reason: "over budget",
        regressionRole: "regression fixture",
        successorId: "fresh-y",
      },
    });
    const readiness = evaluateCertificationReadiness(
      ledger({ holdouts: [retired], successors: [successor()] }),
    );
    expect(readiness.status).toBe("ELIGIBLE");
    expect(readiness.reasons).toEqual([]);
  });
});

describe("certification readiness fails closed (ADJ-02)", () => {
  const retiredTo = (caseId: string, successorId: string) =>
    entry({
      caseId,
      status: "RETIRED_TO_REGRESSION",
      inspections: [event(), event(), event(), event()],
      retirement: {
        dateIso: "2026-08-29",
        workstream: "test",
        reason: "over budget",
        regressionRole: "regression fixture",
        successorId,
      },
    });

  it("an empty ledger (no holdouts, no successors) is NOT_EVALUABLE with a reason", () => {
    const readiness = evaluateCertificationReadiness(ledger());
    expect(readiness.status).toBe("NOT_EVALUABLE");
    expect(readiness.reasons.length).toBeGreaterThan(0);
  });

  it("a ledger without a successors array is NOT_EVALUABLE and does not throw", () => {
    const malformed = { ...ledger({ holdouts: [entry()] }) } as Partial<HoldoutLedger>;
    delete malformed.successors;
    let readiness: ReturnType<typeof evaluateCertificationReadiness> | null = null;
    expect(() => {
      readiness = evaluateCertificationReadiness(malformed as HoldoutLedger);
    }).not.toThrow();
    expect(readiness!.status).toBe("NOT_EVALUABLE");
    expect(readiness!.reasons.length).toBeGreaterThan(0);
  });

  it("a ledger whose holdouts is not an array is NOT_EVALUABLE and does not throw", () => {
    const malformed = ledger();
    (malformed as unknown as { holdouts: unknown }).holdouts = "nope";
    let readiness: ReturnType<typeof evaluateCertificationReadiness> | null = null;
    expect(() => {
      readiness = evaluateCertificationReadiness(malformed);
    }).not.toThrow();
    expect(readiness!.status).toBe("NOT_EVALUABLE");
  });

  it("loadHoldoutLedger on a missing file raises a typed governance error, not raw ENOENT", () => {
    const root = mkdtempSync(join(tmpdir(), "holdout-missing-"));
    tmpRoots.push(root);
    let caught: unknown = null;
    try {
      loadHoldoutLedger(root);
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeNull();
    expect((caught as { code?: string }).code).not.toBe("ENOENT");
    expect(String(caught)).toMatch(/holdout ledger/i);
  });

  it("loadHoldoutLedger on a non-JSON file raises a typed governance error, not SyntaxError", () => {
    const root = mkdtempSync(join(tmpdir(), "holdout-nonjson-"));
    tmpRoots.push(root);
    mkdirSync(join(root, "datasets", "holdouts"), { recursive: true });
    writeFileSync(join(root, HOLDOUT_LEDGER_PATH), "{ this is not json");
    let caught: unknown = null;
    try {
      loadHoldoutLedger(root);
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeNull();
    expect(caught).not.toBeInstanceOf(SyntaxError);
    expect(String(caught)).toMatch(/holdout ledger/i);
  });

  it("loadHoldoutLedger rejects holdouts:'nope' (shape validated beyond policyVersion)", () => {
    const root = mkdtempSync(join(tmpdir(), "holdout-shape-"));
    tmpRoots.push(root);
    mkdirSync(join(root, "datasets", "holdouts"), { recursive: true });
    writeFileSync(
      join(root, HOLDOUT_LEDGER_PATH),
      JSON.stringify({ policyVersion: "holdout-rotation-v1", holdouts: "nope" }),
    );
    let loaded: HoldoutLedger | null = null;
    let caught: unknown = null;
    try {
      loaded = loadHoldoutLedger(root);
    } catch (error) {
      caught = error;
    }
    if (caught === null) {
      expect(Array.isArray(loaded?.holdouts)).toBe(true);
    } else {
      expect(caught).not.toBeInstanceOf(TypeError);
      expect(String(caught)).toMatch(/holdout ledger/i);
    }
  });

  it("an unknown tier with 500 inspections is never WITHIN_BUDGET", () => {
    const bogus = entry({
      tier: "BOGUS" as HoldoutTier,
      inspections: Array.from({ length: 500 }, () => event()),
    });
    let outcome: string;
    try {
      outcome = evaluateHoldout(bogus).verdict;
    } catch (error) {
      expect(String(error)).toMatch(/tier/i);
      return;
    }
    expect(outcome).not.toBe("WITHIN_BUDGET");
    const readiness = evaluateCertificationReadiness(ledger({ holdouts: [bogus] }));
    expect(readiness.status).toBe("BLOCKED");
    expect(readiness.reasons.join(" ")).toMatch(/tier/i);
  });

  it("self-succession is BLOCKED with a reason", () => {
    const readiness = evaluateCertificationReadiness(
      ledger({
        holdouts: [retiredTo("old-1", "old-1")],
        successors: [successor({ caseId: "old-1" })],
      }),
    );
    expect(readiness.status).toBe("BLOCKED");
    expect(readiness.reasons.join(" ")).toContain("old-1");
  });

  it("a successor whose tier is DEV (not SHADOW_HOLDOUT) is BLOCKED with a reason", () => {
    const readiness = evaluateCertificationReadiness(
      ledger({
        holdouts: [retiredTo("old-1", "fresh-y")],
        successors: [successor({ tier: "DEV" })],
      }),
    );
    expect(readiness.status).toBe("BLOCKED");
    expect(readiness.reasons.join(" ")).toContain("fresh-y");
  });

  it("one successor shared by two retired holdouts is BLOCKED with a reason", () => {
    const readiness = evaluateCertificationReadiness(
      ledger({
        holdouts: [retiredTo("old-1", "fresh-y"), retiredTo("old-2", "fresh-y")],
        successors: [successor()],
      }),
    );
    expect(readiness.status).toBe("BLOCKED");
    expect(readiness.reasons.join(" ")).toContain("fresh-y");
  });

  it("a successor that is itself a RETIRED holdout is BLOCKED with a reason", () => {
    const readiness = evaluateCertificationReadiness(
      ledger({
        holdouts: [retiredTo("old-1", "fresh-y"), retiredTo("fresh-y", "fresh-z")],
        successors: [successor(), successor({ caseId: "fresh-z" })],
      }),
    );
    expect(readiness.status).toBe("BLOCKED");
    expect(readiness.reasons.join(" ")).toContain("fresh-y");
  });
});

describe("ledger decoder: structural defects are NOT_EVALUABLE, never partial verdicts", () => {
  const writeLedger = (label: string, body: string): string => {
    const root = mkdtempSync(join(tmpdir(), `holdout-${label}-`));
    tmpRoots.push(root);
    mkdirSync(join(root, "datasets", "holdouts"), { recursive: true });
    writeFileSync(join(root, HOLDOUT_LEDGER_PATH), body);
    return root;
  };

  it("rejects non-object inputs with a defect that names the holdout ledger", () => {
    for (const input of [null, undefined, "ledger", 42, [], true]) {
      const decoded = decodeHoldoutLedger(input);
      expect(decoded.ok, JSON.stringify(input)).toBe(false);
      if (!decoded.ok) {
        expect(decoded.defects.length).toBeGreaterThan(0);
        expect(decoded.defects.join(" ")).toMatch(/holdout ledger/i);
      }
    }
  });

  it("names the JSON path of every malformed field instead of stopping at the first", () => {
    const decoded = decodeHoldoutLedger({
      ...ledger(),
      holdouts: [{ ...entry(), caseId: 7, inspections: "nope" }],
      successors: [{ ...successor(), labelBlind: "yes", inspectionCount: "0" }],
    });
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      const text = decoded.defects.join("\n");
      expect(text).toContain("holdouts[0].caseId");
      expect(text).toContain("holdouts[0].inspections");
      expect(text).toContain("successors[0].labelBlind");
      expect(text).toContain("successors[0].inspectionCount");
    }
  });

  it("a null retirement record is structurally valid (policy flags it); a malformed one is a defect", () => {
    const noRecord = decodeHoldoutLedger(
      ledger({ holdouts: [entry({ status: "RETIRED_TO_REGRESSION", retirement: null })] }),
    );
    expect(noRecord.ok).toBe(true);
    const badRecord = decodeHoldoutLedger({
      ...ledger(),
      holdouts: [{ ...entry({ status: "RETIRED_TO_REGRESSION" }), retirement: { successorId: 3 } }],
    });
    expect(badRecord.ok).toBe(false);
    if (!badRecord.ok) {
      expect(badRecord.defects.join(" ")).toContain("holdouts[0].retirement");
    }
  });

  it("accepts the committed real ledger verbatim (extra provenance keys are allowed)", () => {
    const raw: unknown = JSON.parse(readFileSync(join(REPO_ROOT, HOLDOUT_LEDGER_PATH), "utf8"));
    const decoded = decodeHoldoutLedger(raw);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.ledger.holdouts.length).toBeGreaterThan(0);
      expect(decoded.ledger.successors.length).toBeGreaterThan(0);
    }
  });

  it("a ledger under a different policy version is NOT_EVALUABLE under this policy", () => {
    const readiness = evaluateCertificationReadiness(
      ledger({ holdouts: [entry()], policyVersion: "holdout-rotation-v0" }),
    );
    expect(readiness.status).toBe("NOT_EVALUABLE");
    expect(readiness.reasons.join(" ")).toContain("holdout-rotation-v0");
  });

  it("duplicate holdout or successor case ids make the ledger NOT_EVALUABLE", () => {
    const dupHoldouts = evaluateCertificationReadiness(
      ledger({ holdouts: [entry({ caseId: "twin" }), entry({ caseId: "twin" })] }),
    );
    expect(dupHoldouts.status).toBe("NOT_EVALUABLE");
    expect(dupHoldouts.reasons.join(" ")).toContain("twin");

    const dupSuccessors = evaluateCertificationReadiness(
      ledger({ holdouts: [entry()], successors: [successor(), successor()] }),
    );
    expect(dupSuccessors.status).toBe("NOT_EVALUABLE");
    expect(dupSuccessors.reasons.join(" ")).toContain("fresh-y");
  });

  it("a NOT_EVALUABLE result carries no per-holdout evaluations", () => {
    const readiness = evaluateCertificationReadiness({
      ...ledger({ holdouts: [entry()] }),
      successors: "nope",
    } as unknown as HoldoutLedger);
    expect(readiness.status).toBe("NOT_EVALUABLE");
    expect(readiness.holdouts).toEqual([]);
  });

  it("loadHoldoutLedger raises HoldoutLedgerError with a distinct code per failure", () => {
    const missing = mkdtempSync(join(tmpdir(), "holdout-code-missing-"));
    tmpRoots.push(missing);
    const attempts: [string, string][] = [
      [missing, "LEDGER_UNREADABLE"],
      [writeLedger("code-json", "not json"), "LEDGER_UNPARSEABLE"],
      [
        writeLedger("code-shape", JSON.stringify({ ...ledger(), holdouts: "nope" })),
        "LEDGER_MALFORMED",
      ],
      [
        writeLedger(
          "code-policy",
          JSON.stringify(ledger({ holdouts: [entry()], policyVersion: "holdout-rotation-v0" })),
        ),
        "LEDGER_POLICY_MISMATCH",
      ],
    ];
    for (const [root, code] of attempts) {
      let caught: unknown = null;
      try {
        loadHoldoutLedger(root);
      } catch (error) {
        caught = error;
      }
      expect(caught, code).toBeInstanceOf(HoldoutLedgerError);
      expect((caught as HoldoutLedgerError).code).toBe(code);
      expect(String(caught)).toMatch(/holdout ledger/i);
    }
  });

  it("loadHoldoutLedger preserves the underlying fs / JSON failure as the error cause", () => {
    const root = writeLedger("cause", "{ nope");
    let caught: unknown = null;
    try {
      loadHoldoutLedger(root);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HoldoutLedgerError);
    expect((caught as HoldoutLedgerError).cause).toBeInstanceOf(SyntaxError);
  });
});

describe("tier governance: unknown tiers have no budget to be within", () => {
  it("isHoldoutTier is a closed check over the frozen tier list", () => {
    expect(isHoldoutTier("LOCKED_TEST")).toBe(true);
    expect(isHoldoutTier("BOGUS")).toBe(false);
    expect(isHoldoutTier("constructor")).toBe(false);
    expect(isHoldoutTier(undefined)).toBe(false);
  });

  it("an ungoverned tier is UNGOVERNED_TIER even with zero inspections", () => {
    const evaluation = evaluateHoldout(entry({ tier: "BOGUS" as HoldoutTier }));
    expect(evaluation.verdict).toBe("UNGOVERNED_TIER");
    expect(Number.isFinite(evaluation.budget)).toBe(true);
    expect(evaluation.violations.join(" ")).toMatch(/tier/i);
    expect(evaluation.violations.join(" ")).toContain("case-x");
  });

  it("a prototype key is not a governed tier", () => {
    const evaluation = evaluateHoldout(entry({ tier: "toString" as HoldoutTier }));
    expect(evaluation.verdict).toBe("UNGOVERNED_TIER");
  });

  it("evaluateHoldout refuses a structurally malformed entry instead of guessing", () => {
    const malformed = { ...entry(), inspections: "nope" } as unknown as HoldoutEntry;
    expect(() => evaluateHoldout(malformed)).toThrow(HoldoutLedgerError);
    expect(() => evaluateHoldout(malformed)).toThrow(/holdout ledger/i);
  });
});

describe("successor designation graph audit", () => {
  const retiredTo = (caseId: string, successorId: string) =>
    entry({
      caseId,
      status: "RETIRED_TO_REGRESSION",
      inspections: [event(), event(), event(), event()],
      retirement: {
        dateIso: "2026-08-29",
        workstream: "test",
        reason: "over budget",
        regressionRole: "regression fixture",
        successorId,
      },
    });

  it("a clean one-to-one designation has no findings", () => {
    expect(
      auditSuccessorDesignations(
        ledger({ holdouts: [retiredTo("old-1", "fresh-y")], successors: [successor()] }),
      ),
    ).toEqual([]);
  });

  it("reports every graph violation, each naming the offending case id", () => {
    const findings = auditSuccessorDesignations(
      ledger({
        holdouts: [
          retiredTo("old-1", "old-1"),
          retiredTo("old-2", "shared"),
          retiredTo("old-3", "shared"),
          retiredTo("old-4", "dev-tier"),
          retiredTo("old-5", "old-2"),
        ],
        successors: [
          successor({ caseId: "old-1" }),
          successor({ caseId: "shared" }),
          successor({ caseId: "dev-tier", tier: "DEV" }),
          successor({ caseId: "old-2" }),
        ],
      }),
    );
    const text = findings.join("\n");
    expect(text).toMatch(/old-1.*(itself|own successor|self)/i);
    expect(text).toMatch(/shared.*(old-2|old-3)/);
    expect(text).toMatch(/dev-tier.*DEV/);
    expect(text).toMatch(/old-2.*retired/i);
  });

  it("a successor that is also an inspected or non-shadow ACTIVE holdout is BLOCKED", () => {
    const inspectedActive = evaluateCertificationReadiness(
      ledger({
        holdouts: [
          retiredTo("old-1", "fresh-y"),
          entry({ caseId: "fresh-y", tier: "SHADOW_HOLDOUT", inspections: [event()] }),
        ],
        successors: [successor()],
      }),
    );
    expect(inspectedActive.status).toBe("BLOCKED");
    expect(inspectedActive.reasons.join(" ")).toContain("fresh-y");

    const lockedActive = evaluateCertificationReadiness(
      ledger({
        holdouts: [
          retiredTo("old-1", "fresh-y"),
          entry({ caseId: "fresh-y", tier: "LOCKED_TEST" }),
        ],
        successors: [successor()],
      }),
    );
    expect(lockedActive.status).toBe("BLOCKED");
    expect(lockedActive.reasons.join(" ")).toContain("fresh-y");
  });

  it("a successor that has become an uninspected ACTIVE shadow holdout still qualifies", () => {
    const readiness = evaluateCertificationReadiness(
      ledger({
        holdouts: [
          retiredTo("old-1", "fresh-y"),
          entry({ caseId: "fresh-y", tier: "SHADOW_HOLDOUT" }),
        ],
        successors: [successor()],
      }),
    );
    expect(readiness.status).toBe("ELIGIBLE");
    expect(readiness.reasons).toEqual([]);
  });

  it("ACTIVE holdouts within budget and no retirements remain ELIGIBLE", () => {
    const readiness = evaluateCertificationReadiness(ledger({ holdouts: [entry()] }));
    expect(readiness.status).toBe("ELIGIBLE");
    expect(readiness.reasons).toEqual([]);
  });
});

describe("real ledger: wm-dink-01 and afn-vic-rally1 inspection history", () => {
  const real = loadHoldoutLedger();

  it("covers exactly the coach-gates held-out case ids", () => {
    expect(new Set(real.holdouts.map((h) => h.caseId))).toEqual(new Set(HELD_OUT_CASE_IDS));
  });

  it("both cases are honestly recorded as over-budget and retired to regression", () => {
    for (const holdout of real.holdouts) {
      expect(holdout.tier).toBe("LOCKED_TEST");
      expect(holdout.inspections.length).toBeGreaterThan(INSPECTION_BUDGETS.LOCKED_TEST);
      expect(holdout.status).toBe("RETIRED_TO_REGRESSION");
      expect(holdout.retirement, `${holdout.caseId} retirement record`).not.toBeNull();
      expect(holdout.retirement?.successorId, `${holdout.caseId} successor`).toBeTruthy();
    }
  });

  it("every recorded inspection cites committed repo evidence, not bare counts", () => {
    for (const holdout of real.holdouts) {
      for (const inspection of holdout.inspections) {
        expect(inspection.evidence.length).toBeGreaterThan(20);
        expect(inspection.workstream.length).toBeGreaterThan(0);
      }
    }
  });

  it("cited label and dossier artifacts actually exist for both cases", () => {
    for (const caseId of HELD_OUT_CASE_IDS) {
      const bundle = join(
        REPO_ROOT,
        "datasets",
        "paddle-bench",
        "bundles",
        caseId,
        "annotation",
        "devin-visual-v1.json",
      );
      expect(() => readFileSync(bundle, "utf8"), `${caseId} annotation bundle`).not.toThrow();
    }
  });

  it("successors are chronological fresh candidates that are still label-blind in the registry", () => {
    const registry = JSON.parse(
      readFileSync(join(REPO_ROOT, "datasets", "pickleball", "registry.json"), "utf8"),
    ) as {
      freshCandidates: { items: { id: string; role: string; labelBlind: boolean }[] };
    };
    const freshById = new Map(registry.freshCandidates.items.map((item) => [item.id, item]));
    expect(real.successors.length).toBeGreaterThan(0);
    for (const designated of real.successors) {
      const registered = freshById.get(designated.caseId);
      expect(registered, `${designated.caseId} must be a registered fresh candidate`).toBeDefined();
      expect(registered?.labelBlind, `${designated.caseId} labelBlind`).toBe(true);
      expect(registered?.role, `${designated.caseId} role`).toBe("fresh_candidate");
      expect(designated.inspectionCount).toBe(0);
      expect(designated.tier).toBe("SHADOW_HOLDOUT");
    }
  });

  it("successors never overlap the retired (contaminated) case ids", () => {
    const retiredIds = new Set(real.holdouts.map((h) => h.caseId));
    for (const designated of real.successors) {
      expect(retiredIds.has(designated.caseId)).toBe(false);
    }
  });

  it("certification claims stay BLOCKED until the successor front-door freeze happens", () => {
    const readiness = evaluateCertificationReadiness(real);
    expect(readiness.status).toBe("BLOCKED");
    expect(readiness.reasons.join(" ")).toContain("pending external step");
    for (const evaluation of readiness.holdouts) {
      expect(evaluation.verdict).toBe("RETIRED");
    }
  });
});
