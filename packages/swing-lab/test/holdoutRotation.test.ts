import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HELD_OUT_CASE_IDS } from "../src/coachGates.js";
import { REPO_ROOT } from "../src/engine/corpus.js";
import {
  evaluateCertificationReadiness,
  evaluateHoldout,
  HOLDOUT_LEDGER_PATH,
  INSPECTION_BUDGETS,
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
