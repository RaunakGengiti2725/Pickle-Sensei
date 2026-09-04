/**
 * Structural audit (pass 1) — I14 holdout-rotation governance probes.
 *
 * A FAILING case is the evidence for a finding; a PASSING case is
 * `verified_ok`. Production code and the ledger are not modified.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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

function event(overrides: Partial<InspectionEvent> = {}): InspectionEvent {
  return {
    kind: "benchmark_evaluation",
    dateIso: "2026-08-29",
    workstream: "audit",
    evidence: "synthetic audit event",
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
    designationRule: "audit rule",
    registryRef: "audit",
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

const retiredWithSuccessor = (successorId: string) =>
  entry({
    caseId: "old-holdout",
    status: "RETIRED_TO_REGRESSION",
    inspections: [event(), event(), event(), event()],
    retirement: {
      dateIso: "2026-08-29",
      workstream: "audit",
      reason: "over budget",
      regressionRole: "regression",
      successorId,
    },
  });

describe("audit: NOT_EVALUABLE is reachable for missing/malformed ledgers (module contract)", () => {
  it("an empty ledger (no holdouts, no successors) is not ELIGIBLE", () => {
    // Nothing has been measured, so nothing can be certified: the module
    // header promises NOT_EVALUABLE for this shape, not a green verdict.
    const verdict = evaluateCertificationReadiness(ledger());
    expect(verdict.status).not.toBe("ELIGIBLE");
  });

  it("a ledger without a successors array is NOT_EVALUABLE rather than a TypeError", () => {
    const malformed = { ...ledger({ holdouts: [entry()] }) } as Partial<HoldoutLedger>;
    delete malformed.successors;
    let status: string | null = null;
    let typeError = false;
    try {
      status = evaluateCertificationReadiness(malformed as HoldoutLedger).status;
    } catch (error) {
      typeError = error instanceof TypeError;
    }
    expect(typeError).toBe(false);
    expect(status).toBe("NOT_EVALUABLE");
  });

  it("loadHoldoutLedger on a missing ledger file surfaces a governance error, not a raw ENOENT", () => {
    const root = mkdtempSync(join(tmpdir(), "audit-ledger-"));
    let code: string | undefined;
    let threw = false;
    try {
      loadHoldoutLedger(root);
    } catch (error) {
      threw = true;
      code = (error as { code?: string }).code;
    }
    expect(threw).toBe(true);
    // A raw fs ENOENT is the runtime tripping, not the documented
    // "missing ledger ⇒ NOT_EVALUABLE" governance verdict.
    expect(code).not.toBe("ENOENT");
  });

  it("loadHoldoutLedger rejects a ledger whose holdouts entries lack an inspections array", () => {
    const root = mkdtempSync(join(tmpdir(), "audit-ledger-"));
    mkdirSync(join(root, "datasets", "holdouts"), { recursive: true });
    writeFileSync(
      join(root, HOLDOUT_LEDGER_PATH),
      JSON.stringify({
        schemaVersion: 1,
        policyVersion: "holdout-rotation-v1",
        generatedAtIso: "x",
        holdouts: [{ caseId: "a", tier: "LOCKED_TEST", status: "ACTIVE" }],
        successors: [],
      }),
    );
    let failed = false;
    try {
      const loaded = loadHoldoutLedger(root);
      evaluateCertificationReadiness(loaded);
    } catch (error) {
      failed = !(error instanceof TypeError);
    }
    expect(failed).toBe(true);
  });
});

describe("audit: tier and budget validation", () => {
  it("an unknown tier does not silently evaluate as WITHIN_BUDGET", () => {
    const bogus = entry({
      tier: "GOLD_PLATED" as HoldoutTier,
      inspections: [event(), event(), event(), event(), event()],
    });
    let verdict: string | null = null;
    try {
      verdict = evaluateHoldout(bogus).verdict;
    } catch {
      verdict = "threw";
    }
    expect(verdict).not.toBe("WITHIN_BUDGET");
  });

  it("budgets are frozen (object cannot be mutated at runtime)", () => {
    const budgets = INSPECTION_BUDGETS as Record<HoldoutTier, number>;
    let mutated = false;
    try {
      budgets.SHADOW_HOLDOUT = 99;
      mutated = INSPECTION_BUDGETS.SHADOW_HOLDOUT === 99;
    } catch {
      // frozen — expected
    }
    if (mutated) budgets.SHADOW_HOLDOUT = 0;
    expect(mutated).toBe(false);
  });
});

describe("audit: successor integrity is cross-checked, not self-declared", () => {
  it("a successor that also appears as a holdout entry with inspections cannot back certification", () => {
    const l = ledger({
      holdouts: [
        retiredWithSuccessor("fresh-y"),
        entry({
          caseId: "fresh-y",
          tier: "SHADOW_HOLDOUT",
          status: "ACTIVE",
          inspections: [event({ kind: "human_frame_review" })],
        }),
      ],
      successors: [successor({ caseId: "fresh-y", inspectionCount: 0 })],
    });
    const verdict = evaluateCertificationReadiness(l);
    expect(verdict.status).toBe("BLOCKED");
  });

  it("a successor with a non-SHADOW_HOLDOUT tier (e.g. DEV) cannot back certification", () => {
    const l = ledger({
      holdouts: [retiredWithSuccessor("fresh-y")],
      successors: [successor({ caseId: "fresh-y", tier: "DEV" })],
    });
    expect(evaluateCertificationReadiness(l).status).toBe("BLOCKED");
  });

  it("a retired holdout cannot name itself as its successor", () => {
    const l = ledger({
      holdouts: [retiredWithSuccessor("old-holdout")],
      successors: [successor({ caseId: "old-holdout" })],
    });
    expect(evaluateCertificationReadiness(l).status).toBe("BLOCKED");
  });

  it("one successor cannot serve two retired holdouts", () => {
    const second = retiredWithSuccessor("fresh-y");
    second.caseId = "old-holdout-2";
    const l = ledger({
      holdouts: [retiredWithSuccessor("fresh-y"), second],
      successors: [successor({ caseId: "fresh-y" })],
    });
    expect(evaluateCertificationReadiness(l).status).toBe("BLOCKED");
  });

  it("a retired holdout whose successor is itself RETIRED cannot certify", () => {
    const retiredSuccessor = retiredWithSuccessor("fresh-z");
    retiredSuccessor.caseId = "fresh-y";
    const l = ledger({
      holdouts: [retiredWithSuccessor("fresh-y"), retiredSuccessor],
      successors: [successor({ caseId: "fresh-y" }), successor({ caseId: "fresh-z" })],
    });
    expect(evaluateCertificationReadiness(l).status).toBe("BLOCKED");
  });
});

describe("audit: real ledger successors against the ledger's own evidence rule", () => {
  /**
   * The ledger's provenanceNote states inspection exposure was reconstructed
   * with `grep -rl <caseId> datasets/`. SHADOW_HOLDOUT budget is 0. Apply the
   * identical rule to each designated successor, excluding only the ledger
   * itself (which names the successor by designation) and the acquisition
   * registry (the declared, metadata-only designation basis).
   */
  const referencingArtifacts = (caseId: string): string[] => {
    let out = "";
    try {
      out = execFileSync("grep", ["-rl", "--", caseId, "datasets"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (error) {
      const e = error as { status?: number; stdout?: string };
      if (e.status === 1) return [];
      out = e.stdout ?? "";
    }
    return out
      .split("\n")
      .filter((line) => line.length > 0)
      .filter((path) => !/holdouts\/ledger\.json$/.test(path))
      .filter((path) => !/pickleball\/registry\.json$/.test(path))
      .sort();
  };

  const real = loadHoldoutLedger();

  for (const s of real.successors) {
    it(`${s.caseId} (${s.tier}, budget ${INSPECTION_BUDGETS[s.tier]}) has zero committed artifact exposure`, () => {
      const files = referencingArtifacts(s.caseId);
      expect({ caseId: s.caseId, declaredInspectionCount: s.inspectionCount, files }).toEqual({
        caseId: s.caseId,
        declaredInspectionCount: 0,
        files: [],
      });
    });
  }

  /**
   * test/oodGateRedTeam.test.ts ("fresh-candidate real footage is not
   * blanket-rejected") and src/oodSpeedGapMeasure.ts:317-318 both enumerate
   * `datasets/pickleball/fresh-candidates/*.mp4` with no exclusion list and
   * evaluate/assert the frame gate on every file. Mirror that enumeration and
   * require the SHADOW_HOLDOUT successors to be absent from it.
   */
  it("fresh-candidate enumeration used by the OOD gate suite and speed-gap script excludes SHADOW_HOLDOUT successors", () => {
    const freshDir = join(REPO_ROOT, "datasets", "pickleball", "fresh-candidates");
    const enumerated = readdirSync(freshDir)
      .filter((f) => f.endsWith(".mp4"))
      .map((f) => f.replace(/\.mp4$/, ""));
    const shadowSuccessors = real.successors
      .filter((s) => s.tier === "SHADOW_HOLDOUT")
      .map((s) => s.caseId);
    expect(shadowSuccessors.length).toBeGreaterThan(0);
    expect(enumerated.filter((id) => shadowSuccessors.includes(id))).toEqual([]);
  });
});
