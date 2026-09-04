import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  HELD_OUT_CASE_IDS,
  HELD_OUT_EXCLUSION_IDS,
  isHeldOutQueueItem,
} from "../src/coachGates.js";
import { REPO_ROOT } from "../src/engine/corpus.js";
import {
  benchExcludedCaseIds,
  certificationReadinessForRepo,
  evaluateCertificationReadiness,
  evaluateHoldout,
  heldOutCaseIds,
  HOLDOUT_LEDGER_PATH,
  HOLDOUT_ROTATION_POLICY_VERSION,
  HoldoutLedgerError,
  INSPECTION_BUDGETS,
  loadHoldoutLedger,
  scanCommittedArtifactExposure,
  validateHoldoutLedger,
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

function retiredTo(caseId: string, successorId: string | null): HoldoutEntry {
  return entry({
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
}

/** Evaluate an arbitrary (possibly malformed) value without letting a throw escape. */
function evaluateRaw(raw: unknown): { threw: unknown; status: string | null; reasons: string[] } {
  try {
    const readiness = evaluateCertificationReadiness(raw);
    return { threw: null, status: readiness.status, reasons: readiness.reasons };
  } catch (error) {
    return { threw: error, status: null, reasons: [] };
  }
}

describe("fail-closed: empty and malformed ledgers are NOT_EVALUABLE, never ELIGIBLE or a TypeError", () => {
  it("an empty ledger (no holdouts, no successors) is NOT_EVALUABLE with a reason", () => {
    const readiness = evaluateCertificationReadiness(ledger());
    expect(readiness.status).toBe("NOT_EVALUABLE");
    expect(readiness.reasons.length).toBeGreaterThan(0);
    expect(readiness.reasons.join(" ")).toMatch(/no holdouts|zero holdouts|governs no/i);
  });

  it("a ledger whose `successors` key is missing is NOT_EVALUABLE and does not throw", () => {
    const { successors: _dropped, ...withoutSuccessors } = ledger({ holdouts: [entry()] });
    const result = evaluateRaw(withoutSuccessors);
    expect(result.threw).toBeNull();
    expect(result.status).toBe("NOT_EVALUABLE");
    expect(result.reasons.join(" ")).toContain("successors");
  });

  it.each([
    ["holdouts is a string", { holdouts: "nope" }],
    ["holdouts is null", { holdouts: null }],
    ["holdouts is an object", { holdouts: { caseId: "x" } }],
    ["successors is null", { successors: null }],
    ["successors is a string", { successors: "nope" }],
    ["schemaVersion is unknown", { schemaVersion: 99 }],
    ["policyVersion mismatches", { policyVersion: "holdout-rotation-v0" }],
  ])("malformed ledger (%s) is NOT_EVALUABLE and does not throw", (_label, patch) => {
    const result = evaluateRaw({ ...ledger({ holdouts: [entry()] }), ...patch });
    expect(result.threw).toBeNull();
    expect(result.status).toBe("NOT_EVALUABLE");
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it.each([null, undefined, 42, "ledger", [], {}])(
    "non-object or empty-object input %p is NOT_EVALUABLE and does not throw",
    (raw) => {
      const result = evaluateRaw(raw);
      expect(result.threw).toBeNull();
      expect(result.status).toBe("NOT_EVALUABLE");
    },
  );

  it("a holdout entry without an inspections array is NOT_EVALUABLE, not a TypeError", () => {
    const broken = { ...entry(), inspections: undefined };
    const result = evaluateRaw(ledger({ holdouts: [broken as unknown as HoldoutEntry] }));
    expect(result.threw).toBeNull();
    expect(result.status).toBe("NOT_EVALUABLE");
    expect(result.reasons.join(" ")).toContain("inspections");
  });

  it("validateHoldoutLedger lists every shape problem and accepts the real ledger", () => {
    expect(validateHoldoutLedger(loadHoldoutLedger())).toEqual([]);
    const problems = validateHoldoutLedger({ holdouts: "nope" });
    expect(problems.some((p) => p.includes("policyVersion"))).toBe(true);
    expect(problems.some((p) => p.includes("holdouts"))).toBe(true);
    expect(problems.some((p) => p.includes("successors"))).toBe(true);
  });
});

describe("fail-closed: tier and budget validation", () => {
  it("an unknown tier with 500 inspections is never WITHIN_BUDGET (typed validation error)", () => {
    const bogus = entry({
      tier: "BOGUS" as HoldoutTier,
      inspections: Array.from({ length: 500 }, () => event()),
    });
    let verdict: string | null = null;
    let thrown: unknown = null;
    try {
      verdict = evaluateHoldout(bogus).verdict;
    } catch (error) {
      thrown = error;
    }
    expect(verdict).not.toBe("WITHIN_BUDGET");
    expect(thrown).toBeInstanceOf(HoldoutLedgerError);
    expect((thrown as HoldoutLedgerError).message).toContain("BOGUS");
  });

  it("an unknown tier inside a ledger makes certification NOT_EVALUABLE, not ELIGIBLE", () => {
    const bogus = entry({ tier: "BOGUS" as HoldoutTier });
    const result = evaluateRaw(ledger({ holdouts: [bogus] }));
    expect(result.threw).toBeNull();
    expect(result.status).toBe("NOT_EVALUABLE");
    expect(result.reasons.join(" ")).toContain("BOGUS");
  });

  it("budgets are frozen at runtime", () => {
    expect(Object.isFrozen(INSPECTION_BUDGETS)).toBe(true);
    expect(() => {
      (INSPECTION_BUDGETS as Record<HoldoutTier, number>).SHADOW_HOLDOUT = 99;
    }).toThrow(TypeError);
    expect(INSPECTION_BUDGETS.SHADOW_HOLDOUT).toBe(0);
  });
});

describe("fail-closed: successor designations are cross-checked, not trusted", () => {
  it("self-succession is BLOCKED with a reason", () => {
    const readiness = evaluateCertificationReadiness(
      ledger({
        holdouts: [retiredTo("old-1", "old-1")],
        successors: [successor({ caseId: "old-1" })],
      }),
    );
    expect(readiness.status).toBe("BLOCKED");
    expect(readiness.reasons.join(" ")).toMatch(/old-1.*(itself|self)/i);
  });

  it("a successor whose tier is not SHADOW_HOLDOUT (e.g. DEV) is BLOCKED with a reason", () => {
    const readiness = evaluateCertificationReadiness(
      ledger({
        holdouts: [retiredTo("old-1", "fresh-y")],
        successors: [successor({ tier: "DEV" })],
      }),
    );
    expect(readiness.status).toBe("BLOCKED");
    expect(readiness.reasons.join(" ")).toMatch(/fresh-y.*DEV.*SHADOW_HOLDOUT/);
  });

  it("one successor shared by two retired holdouts is BLOCKED with a reason", () => {
    const readiness = evaluateCertificationReadiness(
      ledger({
        holdouts: [retiredTo("old-1", "fresh-y"), retiredTo("old-2", "fresh-y")],
        successors: [successor()],
      }),
    );
    expect(readiness.status).toBe("BLOCKED");
    expect(readiness.reasons.join(" ")).toMatch(/fresh-y.*(old-1.*old-2|old-2.*old-1)/);
  });

  it("a successor that is itself a RETIRED holdout is BLOCKED with a reason", () => {
    const readiness = evaluateCertificationReadiness(
      ledger({
        holdouts: [retiredTo("old-1", "old-2"), retiredTo("old-2", "fresh-y")],
        successors: [successor({ caseId: "old-2" }), successor()],
      }),
    );
    expect(readiness.status).toBe("BLOCKED");
    expect(readiness.reasons.join(" ")).toMatch(/old-2.*retired/i);
  });

  it("a successor that is an inspected ACTIVE holdout contradicts its zero count and is BLOCKED", () => {
    const readiness = evaluateCertificationReadiness(
      ledger({
        holdouts: [
          retiredTo("old-1", "fresh-y"),
          entry({ caseId: "fresh-y", tier: "SHADOW_HOLDOUT", inspections: [event()] }),
        ],
        successors: [successor()],
      }),
    );
    expect(readiness.status).toBe("BLOCKED");
    expect(readiness.reasons.join(" ")).toContain("fresh-y");
  });

  it("duplicate designations for one successor id can never flip BLOCKED to ELIGIBLE", () => {
    const dirty = successor({ labelBlind: false, inspectionCount: 7 });
    const clean = successor();
    for (const successors of [
      [dirty, clean],
      [clean, dirty],
    ]) {
      const readiness = evaluateCertificationReadiness(
        ledger({ holdouts: [retiredTo("old-1", "fresh-y")], successors }),
      );
      expect(readiness.status).not.toBe("ELIGIBLE");
      expect(readiness.reasons.join(" ")).toContain("fresh-y");
    }
  });

  it("negative or non-integer inspectionCount is not 'zero inspections'", () => {
    for (const inspectionCount of [-1, 0.5, Number.NaN]) {
      const readiness = evaluateCertificationReadiness(
        ledger({
          holdouts: [retiredTo("old-1", "fresh-y")],
          successors: [successor({ inspectionCount })],
        }),
      );
      expect(readiness.status, String(inspectionCount)).not.toBe("ELIGIBLE");
    }
  });
});

describe("fail-closed: loadHoldoutLedger surfaces typed governance errors", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });
  function tempRoot(contents: string | null): string {
    const root = mkdtempSync(join(tmpdir(), "holdout-ledger-"));
    roots.push(root);
    if (contents !== null) {
      mkdirSync(join(root, "datasets", "holdouts"), { recursive: true });
      writeFileSync(join(root, HOLDOUT_LEDGER_PATH), contents);
    }
    return root;
  }
  function loadError(root: string): HoldoutLedgerError {
    try {
      loadHoldoutLedger(root);
    } catch (error) {
      expect(error).toBeInstanceOf(HoldoutLedgerError);
      return error as HoldoutLedgerError;
    }
    throw new Error("loadHoldoutLedger did not throw");
  }

  it("a missing ledger file is a LEDGER_MISSING governance error, not a raw ENOENT", () => {
    const error = loadError(tempRoot(null));
    expect(error.code).toBe("LEDGER_MISSING");
    expect(error.code).not.toBe("ENOENT");
    expect(error.message).toContain(HOLDOUT_LEDGER_PATH);
  });

  it("a non-JSON ledger file is a LEDGER_NOT_JSON governance error, not a raw SyntaxError", () => {
    const error = loadError(tempRoot("{ this is not json"));
    expect(error.code).toBe("LEDGER_NOT_JSON");
    expect(error).not.toBeInstanceOf(SyntaxError);
  });

  it("a ledger whose holdouts is not an array is a LEDGER_MALFORMED error listing the problems", () => {
    const error = loadError(
      tempRoot(
        JSON.stringify({ policyVersion: HOLDOUT_ROTATION_POLICY_VERSION, holdouts: "nope" }),
      ),
    );
    expect(error.code).toBe("LEDGER_MALFORMED");
    expect(error.problems.join(" ")).toContain("holdouts");
  });

  it("a ledger whose entries lack an inspections array is rejected at load time", () => {
    const broken = { ...entry(), inspections: undefined };
    const error = loadError(
      tempRoot(JSON.stringify(ledger({ holdouts: [broken as HoldoutEntry] }))),
    );
    expect(error.code).toBe("LEDGER_MALFORMED");
    expect(error.problems.join(" ")).toContain("inspections");
  });

  it("certificationReadinessForRepo turns missing/malformed ledgers into NOT_EVALUABLE", () => {
    for (const root of [tempRoot(null), tempRoot("not json"), tempRoot("{}")]) {
      const readiness = certificationReadinessForRepo(root);
      expect(readiness.status).toBe("NOT_EVALUABLE");
      expect(readiness.reasons.join(" ")).toContain(HOLDOUT_LEDGER_PATH);
    }
  });

  it("a well-formed ledger with zero holdouts round-trips through load + evaluate as NOT_EVALUABLE", () => {
    const root = tempRoot(JSON.stringify(ledger()));
    expect(evaluateCertificationReadiness(loadHoldoutLedger(root)).status).toBe("NOT_EVALUABLE");
    expect(certificationReadinessForRepo(root).status).toBe("NOT_EVALUABLE");
  });
});

describe("successor inspectionCount is cross-checked against committed datasets/ artifacts", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });
  function repoWith(contents: HoldoutLedger): string {
    const root = mkdtempSync(join(tmpdir(), "holdout-artifacts-"));
    roots.push(root);
    mkdirSync(join(root, "datasets", "holdouts"), { recursive: true });
    writeFileSync(join(root, HOLDOUT_LEDGER_PATH), JSON.stringify(contents));
    return root;
  }
  const cleanLedger = ledger({
    holdouts: [retiredTo("old-1", "fresh-y")],
    successors: [successor({ registryRef: "datasets/pickleball/registry.json#freshCandidates" })],
  });

  it("control: with no artifacts naming the successor the loaded ledger is ELIGIBLE", () => {
    const root = repoWith(cleanLedger);
    mkdirSync(join(root, "datasets", "pickleball"), { recursive: true });
    writeFileSync(
      join(root, "datasets", "pickleball", "registry.json"),
      JSON.stringify({ freshCandidates: { items: [{ id: "fresh-y", labelBlind: true }] } }),
    );
    const readiness = evaluateCertificationReadiness(loadHoldoutLedger(root));
    expect(readiness.status, readiness.reasons.join("\n")).toBe("ELIGIBLE");
    expect(readiness.artifactScan.repoRoot).toBe(root);
  });

  it("a committed annotation bundle directory named after the successor BLOCKS certification", () => {
    const root = repoWith(cleanLedger);
    const bundle = join(root, "datasets", "paddle-bench", "bundles", "fresh-y", "annotation");
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, "devin-visual-v1.json"), JSON.stringify({ frames: [] }));
    const readiness = evaluateCertificationReadiness(loadHoldoutLedger(root));
    expect(readiness.status).toBe("BLOCKED");
    expect(readiness.reasons.join("\n")).toContain("fresh-y");
    expect(readiness.reasons.join("\n")).toContain("datasets/paddle-bench/bundles/fresh-y");
  });

  it("an experiment summary that merely mentions the successor id BLOCKS certification", () => {
    const root = repoWith(cleanLedger);
    const wave = join(root, "datasets", "experiments", "wave-z");
    mkdirSync(wave, { recursive: true });
    writeFileSync(join(wave, "summary.json"), JSON.stringify({ clips: ["fresh-y"] }));
    const readiness = evaluateCertificationReadiness(loadHoldoutLedger(root));
    expect(readiness.status).toBe("BLOCKED");
    expect(readiness.reasons.join("\n")).toContain("datasets/experiments/wave-z/summary.json");
  });

  it("an explicit repoRoot option scans even an in-memory ledger; media files alone are not exposure", () => {
    const root = repoWith(cleanLedger);
    const fresh = join(root, "datasets", "pickleball", "fresh-candidates");
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(fresh, "fresh-y.mp4"), Buffer.from([0, 0, 0, 0]));
    expect(evaluateCertificationReadiness(cleanLedger, { repoRoot: root }).status).toBe("ELIGIBLE");
    writeFileSync(join(fresh, "notes.md"), "screened fresh-y frames by eye");
    const blocked = evaluateCertificationReadiness(cleanLedger, { repoRoot: root });
    expect(blocked.status).toBe("BLOCKED");
    expect(scanCommittedArtifactExposure(root, ["fresh-y"]).get("fresh-y")).toEqual([
      "datasets/pickleball/fresh-candidates/notes.md",
    ]);
  });
});

describe("ledger-derived held-out exclusion set", () => {
  const real = loadHoldoutLedger();

  it("heldOutCaseIds(real ledger) is the governed holdouts plus every zero-budget successor", () => {
    const ids = heldOutCaseIds(real);
    expect(ids).toEqual([...ids].sort());
    for (const holdout of real.holdouts) expect(ids).toContain(holdout.caseId);
    for (const designated of real.successors) {
      expect(INSPECTION_BUDGETS[designated.tier]).toBe(0);
      expect(ids).toContain(designated.caseId);
    }
    expect(ids).toContain("yt-tuKiznvDJ4E");
    expect(ids).toContain("yt-hktiyFnghIw");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("benchExcludedCaseIds(real ledger) names exactly the zero-budget cases that no bench may score", () => {
    const excluded = benchExcludedCaseIds(real);
    expect(excluded).toEqual(["yt-hktiyFnghIw", "yt-tuKiznvDJ4E"]);
    for (const holdout of real.holdouts) {
      expect(excluded, `${holdout.caseId} is a retired regression fixture`).not.toContain(
        holdout.caseId,
      );
    }
  });

  it("coach-gates HELD_OUT_CASE_IDS is derived from the ledger, and the exclusion set unions the successors", () => {
    expect([...HELD_OUT_CASE_IDS]).toEqual(real.holdouts.map((h) => h.caseId));
    expect([...HELD_OUT_EXCLUSION_IDS]).toEqual(heldOutCaseIds(real));
    expect(isHeldOutQueueItem("wm-dink-01-E03")).toBe(true);
    expect(isHeldOutQueueItem("yt-tuKiznvDJ4E-E01")).toBe(true);
    expect(isHeldOutQueueItem("yt-hktiyFnghIw-E07")).toBe(true);
    expect(isHeldOutQueueItem("pb-open-01-E01")).toBe(false);
  });
});

describe("paddle-bench CLI enforces the ledger's SHADOW_HOLDOUT exclusion", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it("refuses a manifest that lists a designated successor as a dev case, naming it and the ledger", () => {
    const successorId = benchExcludedCaseIds(loadHoldoutLedger())[0]!;
    const dir = mkdtempSync(join(tmpdir(), "paddle-bench-contaminated-"));
    roots.push(dir);
    const manifestPath = join(dir, "paddle-bench.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        provenance: "real",
        cases: [
          {
            id: successorId,
            role: "dev",
            labels: `bundles/${successorId}/annotation/devin-visual-v1.json`,
            runDir: `runs/${successorId}`,
          },
        ],
      }),
    );
    const tsx = join(REPO_ROOT, "packages", "swing-lab", "node_modules", ".bin", "tsx");
    const run = spawnSync(tsx, ["src/paddleBench.ts", manifestPath], {
      cwd: join(REPO_ROOT, "packages", "swing-lab"),
      encoding: "utf8",
      timeout: 120_000,
    });
    const combined = `${run.stdout}\n${run.stderr}`;
    expect(run.status, combined).not.toBe(0);
    expect(combined).toContain(successorId);
    expect(combined).toContain(HOLDOUT_LEDGER_PATH);
    expect(combined).toMatch(/SHADOW_HOLDOUT|successor/);
    expect(new RegExp(`^${successorId}: labeled \\d+`, "m").test(run.stdout)).toBe(false);
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

  it("the self-declared inspectionCount 0 of both successors is contradicted by committed artifacts, and that BLOCKS", () => {
    const readiness = evaluateCertificationReadiness(real);
    expect(readiness.artifactScan.repoRoot).toBe(REPO_ROOT);
    for (const designated of real.successors) {
      const exposure = readiness.artifactScan.exposures.find((e) => e.caseId === designated.caseId);
      expect(exposure, `${designated.caseId} exposure`).toBeDefined();
      expect(exposure!.files.length).toBeGreaterThan(0);
      expect(readiness.reasons.join("\n")).toMatch(
        new RegExp(`${designated.caseId}.*inspectionCount 0.*contradicted`),
      );
    }
    expect(readiness.status).toBe("BLOCKED");
  });

  it("certificationReadinessForRepo() on the real repo agrees with the loaded ledger", () => {
    const fromRepo = certificationReadinessForRepo();
    expect(fromRepo.status).toBe("BLOCKED");
    expect(fromRepo.reasons).toEqual(evaluateCertificationReadiness(real).reasons);
  });
});
