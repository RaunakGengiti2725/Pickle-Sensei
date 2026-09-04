import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/engine/corpus.js";
import {
  deriveHeldOutCaseIds,
  evaluateCertificationReadiness,
  evaluateHoldout,
  HOLDOUT_LEDGER_PATH,
  HOLDOUT_ROTATION_POLICY_VERSION,
  HoldoutLedgerError,
  INSPECTION_BUDGETS,
  loadCertificationReadiness,
  loadHeldOutCaseIds,
  loadHoldoutLedger,
  type HoldoutEntry,
  type HoldoutLedger,
  type SuccessorDesignation,
} from "../src/holdoutRotation.js";
import { speedGapClipPlan } from "../src/oodSpeedGapMeasure.js";

/**
 * SL-02 / SL-03 structural audit of holdout-rotation governance.
 *
 * The module header promises that a missing or malformed ledger is
 * NOT_EVALUABLE and that certification is blocked until every retired
 * holdout has a distinct, uninspected, label-blind SHADOW_HOLDOUT successor.
 * These tests pin the fail-CLOSED shape of that promise: anything the checker
 * cannot evaluate must never come out ELIGIBLE, every ledger-declared
 * successor must be treated as held out by the lab tools, and the
 * fresh-candidate enumeration must never read a designated successor.
 */

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

function retired(caseId: string, successorId: string | null): HoldoutEntry {
  return entry({
    caseId,
    status: "RETIRED_TO_REGRESSION",
    inspections: Array.from({ length: 4 }, () => ({
      kind: "benchmark_evaluation" as const,
      dateIso: "2026-08-29",
      workstream: "test",
      evidence: "synthetic unit-test event",
    })),
    retirement: {
      dateIso: "2026-08-29",
      workstream: "test",
      reason: "over budget",
      regressionRole: "regression fixture",
      successorId,
    },
  });
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
    policyVersion: HOLDOUT_ROTATION_POLICY_VERSION,
    generatedAtIso: "2026-08-29T00:00:00.000Z",
    holdouts: [],
    successors: [],
    ...overrides,
  };
}

describe("NOT_EVALUABLE: empty, missing and malformed ledgers never certify", () => {
  it("an empty ledger (no holdouts) is NOT_EVALUABLE, not ELIGIBLE", () => {
    const readiness = evaluateCertificationReadiness(ledger());
    expect(readiness.status).toBe("NOT_EVALUABLE");
    expect(readiness.reasons.length).toBeGreaterThan(0);
    expect(readiness.reasons.join(" ")).toMatch(/no holdouts/i);
  });

  it("a ledger without a successors array is NOT_EVALUABLE instead of throwing", () => {
    const { successors: _dropped, ...withoutSuccessors } = ledger({ holdouts: [entry()] });
    void _dropped;
    const readiness = evaluateCertificationReadiness(withoutSuccessors);
    expect(readiness.status).toBe("NOT_EVALUABLE");
    expect(readiness.reasons.join(" ")).toContain("successors");
  });

  it("non-object, null and array ledgers are NOT_EVALUABLE", () => {
    for (const bad of [null, undefined, 42, "ledger", [], true]) {
      const readiness = evaluateCertificationReadiness(bad);
      expect(readiness.status, `input ${JSON.stringify(bad)}`).toBe("NOT_EVALUABLE");
      expect(readiness.holdouts).toEqual([]);
    }
  });

  it("holdout entries with missing case ids or non-array inspections are NOT_EVALUABLE", () => {
    const missingId = evaluateCertificationReadiness(
      ledger({ holdouts: [{ ...entry(), caseId: "" }] }),
    );
    expect(missingId.status).toBe("NOT_EVALUABLE");
    const badInspections = evaluateCertificationReadiness(
      ledger({ holdouts: [{ ...entry(), inspections: 4 as unknown as [] }] }),
    );
    expect(badInspections.status).toBe("NOT_EVALUABLE");
    expect(badInspections.reasons.join(" ")).toContain("inspections");
  });

  it("a ledger written under another policy version is NOT_EVALUABLE", () => {
    const readiness = evaluateCertificationReadiness(
      ledger({ policyVersion: "holdout-rotation-v0", holdouts: [entry()] }),
    );
    expect(readiness.status).toBe("NOT_EVALUABLE");
    expect(readiness.reasons.join(" ")).toContain("holdout-rotation-v0");
  });

  it("duplicate holdout or successor case ids are NOT_EVALUABLE", () => {
    const dupHoldouts = evaluateCertificationReadiness(
      ledger({ holdouts: [entry({ caseId: "a" }), entry({ caseId: "a" })] }),
    );
    expect(dupHoldouts.status).toBe("NOT_EVALUABLE");
    const dupSuccessors = evaluateCertificationReadiness(
      ledger({ holdouts: [entry()], successors: [successor(), successor()] }),
    );
    expect(dupSuccessors.status).toBe("NOT_EVALUABLE");
  });

  it("loadHoldoutLedger wraps a missing file in a governance error naming the ledger path", () => {
    const emptyRepo = mkdtempSync(join(tmpdir(), "holdout-ledger-missing-"));
    let caught: unknown = null;
    try {
      loadHoldoutLedger(emptyRepo);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HoldoutLedgerError);
    const governance = caught as HoldoutLedgerError;
    expect(governance.code).toBe("MISSING");
    expect(governance.message).toContain(HOLDOUT_LEDGER_PATH);
    expect(governance.message).not.toMatch(/^ENOENT/);
  });

  it("loadHoldoutLedger wraps unparsable JSON and wrong-shape ledgers in a governance error", () => {
    const repo = mkdtempSync(join(tmpdir(), "holdout-ledger-malformed-"));
    const ledgerFile = join(repo, HOLDOUT_LEDGER_PATH);
    mkdirSync(join(repo, "datasets", "holdouts"), { recursive: true });

    writeFileSync(ledgerFile, "{ not json");
    expect(() => loadHoldoutLedger(repo)).toThrow(HoldoutLedgerError);
    try {
      loadHoldoutLedger(repo);
    } catch (error) {
      expect((error as HoldoutLedgerError).code).toBe("UNPARSABLE");
    }

    writeFileSync(
      ledgerFile,
      JSON.stringify({ policyVersion: HOLDOUT_ROTATION_POLICY_VERSION, holdouts: "none" }),
    );
    try {
      loadHoldoutLedger(repo);
      expect.unreachable("wrong-shape ledger must not load");
    } catch (error) {
      expect(error).toBeInstanceOf(HoldoutLedgerError);
      expect((error as HoldoutLedgerError).code).toBe("MALFORMED");
    }
  });

  it("loadCertificationReadiness reports a missing or malformed ledger as NOT_EVALUABLE", () => {
    const emptyRepo = mkdtempSync(join(tmpdir(), "holdout-readiness-missing-"));
    const missing = loadCertificationReadiness(emptyRepo);
    expect(missing.status).toBe("NOT_EVALUABLE");
    expect(missing.reasons.join(" ")).toContain(HOLDOUT_LEDGER_PATH);

    mkdirSync(join(emptyRepo, "datasets", "holdouts"), { recursive: true });
    writeFileSync(join(emptyRepo, HOLDOUT_LEDGER_PATH), "[]");
    const malformed = loadCertificationReadiness(emptyRepo);
    expect(malformed.status).toBe("NOT_EVALUABLE");
  });

  it("the committed ledger loads and is evaluable (BLOCKED, never NOT_EVALUABLE)", () => {
    const readiness = loadCertificationReadiness(REPO_ROOT);
    expect(readiness.status).toBe("BLOCKED");
  });
});

describe("tier and budget: unknown tiers fail closed and budgets are frozen", () => {
  it("INSPECTION_BUDGETS is frozen", () => {
    expect(Object.isFrozen(INSPECTION_BUDGETS)).toBe(true);
    expect(() => {
      (INSPECTION_BUDGETS as Record<string, number>).SHADOW_HOLDOUT = 99;
    }).toThrow();
    expect(INSPECTION_BUDGETS.SHADOW_HOLDOUT).toBe(0);
  });

  it("an unknown tier is never WITHIN_BUDGET and carries an explicit violation", () => {
    const evaluation = evaluateHoldout(entry({ tier: "PRODUCTION" as never }));
    expect(evaluation.verdict).not.toBe("WITHIN_BUDGET");
    expect(evaluation.violations.join(" ")).toContain("PRODUCTION");
    expect(Number.isFinite(evaluation.budget)).toBe(false);
  });

  it("an unknown tier blocks certification even with zero inspections", () => {
    const readiness = evaluateCertificationReadiness(
      ledger({ holdouts: [entry({ tier: "production" as never })] }),
    );
    expect(readiness.status).toBe("BLOCKED");
    expect(readiness.reasons.join(" ")).toContain("production");
  });

  it("a known tier with zero inspections and no retirements is ELIGIBLE (control)", () => {
    const readiness = evaluateCertificationReadiness(ledger({ holdouts: [entry()] }));
    expect(readiness.status).toBe("ELIGIBLE");
    expect(readiness.reasons).toEqual([]);
  });
});

describe("successor integrity", () => {
  it("a retired holdout naming itself as successor blocks certification", () => {
    const readiness = evaluateCertificationReadiness(
      ledger({
        holdouts: [retired("hot", "hot")],
        successors: [successor({ caseId: "hot" })],
      }),
    );
    expect(readiness.status).toBe("BLOCKED");
    expect(readiness.reasons.join(" ")).toMatch(/hot.*(itself|own successor)/i);
  });

  it("two retired holdouts sharing one successor block certification", () => {
    const readiness = evaluateCertificationReadiness(
      ledger({
        holdouts: [retired("a", "fresh-y"), retired("b", "fresh-y")],
        successors: [successor()],
      }),
    );
    expect(readiness.status).toBe("BLOCKED");
    expect(readiness.reasons.join(" ")).toMatch(/fresh-y.*(shared|more than one|multiple)/i);
  });

  it("a successor that is not SHADOW_HOLDOUT tier blocks certification", () => {
    for (const tier of ["DEV", "VALIDATION", "LOCKED_TEST"] as const) {
      const readiness = evaluateCertificationReadiness(
        ledger({ holdouts: [retired("a", "fresh-y")], successors: [successor({ tier })] }),
      );
      expect(readiness.status, tier).toBe("BLOCKED");
      expect(readiness.reasons.join(" "), tier).toContain("SHADOW_HOLDOUT");
    }
  });

  it("a successor that is itself a retired holdout blocks certification", () => {
    const readiness = evaluateCertificationReadiness(
      ledger({
        holdouts: [retired("a", "b"), retired("b", "fresh-y")],
        successors: [successor({ caseId: "b" }), successor()],
      }),
    );
    expect(readiness.status).toBe("BLOCKED");
    expect(readiness.reasons.join(" ")).toMatch(/b.*retired/i);
  });

  it("distinct, uninspected, label-blind SHADOW_HOLDOUT successors per retiree stay ELIGIBLE", () => {
    const readiness = evaluateCertificationReadiness(
      ledger({
        holdouts: [retired("a", "fresh-y"), retired("b", "fresh-z")],
        successors: [successor(), successor({ caseId: "fresh-z" })],
      }),
    );
    expect(readiness.status).toBe("ELIGIBLE");
    expect(readiness.reasons).toEqual([]);
  });
});

describe("ledger-derived held-out set", () => {
  it("contains retired holdouts, protected active holdouts, and SHADOW_HOLDOUT/LOCKED_TEST successors", () => {
    const heldOut = deriveHeldOutCaseIds(
      ledger({
        holdouts: [
          retired("old", "fresh-y"),
          entry({ caseId: "locked-active", tier: "LOCKED_TEST" }),
          entry({ caseId: "dev-case", tier: "DEV" }),
        ],
        successors: [
          successor(),
          successor({ caseId: "fresh-locked", tier: "LOCKED_TEST" }),
          successor({ caseId: "fresh-dev", tier: "DEV" }),
        ],
      }),
    );
    expect([...heldOut.retired].sort()).toEqual(["old"]);
    expect([...heldOut.protected].sort()).toEqual(["fresh-locked", "fresh-y", "locked-active"]);
    expect([...heldOut.all].sort()).toEqual(["fresh-locked", "fresh-y", "locked-active", "old"]);
    expect(heldOut.all.has("dev-case")).toBe(false);
    expect(heldOut.all.has("fresh-dev")).toBe(false);
  });

  it("the committed ledger yields both retired ids and both designated successors", () => {
    const heldOut = loadHeldOutCaseIds(REPO_ROOT);
    const real = loadHoldoutLedger(REPO_ROOT);
    for (const holdout of real.holdouts) {
      expect(heldOut.all.has(holdout.caseId), holdout.caseId).toBe(true);
    }
    for (const designated of real.successors) {
      expect(heldOut.protected.has(designated.caseId), designated.caseId).toBe(true);
      expect(heldOut.all.has(designated.caseId), designated.caseId).toBe(true);
    }
  });
});

describe("fresh-candidate enumeration never reads a designated successor", () => {
  it("the real fresh-candidates directory is enumerated without the ledger successors", () => {
    const real = loadHoldoutLedger(REPO_ROOT);
    const plan = speedGapClipPlan();
    const enumerated = new Set(plan.freshCandidates.map((clip) => clip.id));
    expect(enumerated.size).toBeGreaterThan(0);
    for (const designated of real.successors) {
      expect(enumerated.has(designated.caseId), designated.caseId).toBe(false);
      expect(plan.heldOut).toContain(designated.caseId);
    }
    for (const clip of plan.freshCandidates) {
      expect(clip.path).toMatch(/fresh-candidates\/.+\.mp4$/);
    }
  });

  it("a successor dropped into a fresh-candidates directory is excluded by the plan", () => {
    const freshDir = mkdtempSync(join(tmpdir(), "fresh-candidates-"));
    for (const name of ["keep-me.mp4", "fresh-y.mp4", "notes.txt"]) {
      writeFileSync(join(freshDir, name), "");
    }
    const plan = speedGapClipPlan({
      freshDir,
      ledger: ledger({ holdouts: [retired("old", "fresh-y")], successors: [successor()] }),
    });
    expect(plan.freshCandidates.map((clip) => clip.id)).toEqual(["keep-me"]);
  });

  it("a tune positive that the ledger holds out aborts the plan", () => {
    const freshDir = mkdtempSync(join(tmpdir(), "fresh-candidates-"));
    expect(() =>
      speedGapClipPlan({
        freshDir,
        ledger: ledger({ holdouts: [retired("wm-volley-02", null)] }),
      }),
    ).toThrow(/wm-volley-02/);
  });
});
