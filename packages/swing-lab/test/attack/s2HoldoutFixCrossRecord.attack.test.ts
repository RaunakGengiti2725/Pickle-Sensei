import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HELD_OUT_CASE_IDS } from "../../src/coachGates.js";
import { isHeldOutCase } from "../../src/coachProgramOps.js";
import { REPO_ROOT } from "../../src/engine/corpus.js";
import {
  deriveHeldOutCaseIds,
  evaluateCertificationReadiness,
  HoldoutLedgerError,
  loadCertificationReadiness,
  loadHoldoutLedger,
  loadHeldOutCaseIds,
  HOLDOUT_LEDGER_PATH,
  type HoldoutEntry,
  type HoldoutLedger,
  type InspectionEvent,
  type SuccessorDesignation,
} from "../../src/holdoutRotation.js";

/**
 * S2 attack on the ADJ-02/ADJ-03 holdout-governance fix.
 *
 * The fix validates each ledger record in isolation and keys every held-out
 * decision on the record's own fields. These cases probe what happens when
 * the ledger contradicts itself across records, when a tier is invalid on a
 * record the exclusion set ignores, when the ledger path is unreadable for a
 * reason other than ENOENT, when a manifest aliases a held-out case, and
 * whether the static coach-gate held-out list was ever joined to the ledger.
 */

function event(overrides: Partial<InspectionEvent> = {}): InspectionEvent {
  return {
    kind: "benchmark_evaluation",
    dateIso: "2026-08-29",
    workstream: "attack",
    evidence: "synthetic attack event",
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
    designationRule: "attack rule",
    registryRef: "attack",
    labelBlind: true,
    inspectionCount: 0,
    pendingExternal: "",
    ...overrides,
  };
}

function retired(caseId: string, successorId: string | null): HoldoutEntry {
  return entry({
    caseId,
    status: "RETIRED_TO_REGRESSION",
    inspections: [event(), event(), event(), event()],
    retirement: {
      dateIso: "2026-08-29",
      workstream: "attack",
      reason: "over budget",
      regressionRole: "regression fixture",
      successorId,
    },
  });
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

describe("S2-A: successor designation contradicted by the holdout record of the same case id", () => {
  it("a successor that is also an ACTIVE DEV holdout with hundreds of recorded inspections cannot be ELIGIBLE", () => {
    const inspections = Array.from({ length: 300 }, () => event({ kind: "human_frame_review" }));
    const readiness = evaluateCertificationReadiness(
      ledger({
        holdouts: [retired("a", "fresh-y"), entry({ caseId: "fresh-y", tier: "DEV", inspections })],
        successors: [successor({ caseId: "fresh-y", inspectionCount: 0 })],
      }),
    );
    expect(readiness.status, readiness.reasons.join("\n")).toBe("BLOCKED");
    expect(readiness.reasons.join("\n")).toMatch(/fresh-y/);
  });

  it("a successor whose holdout record says VALIDATION is not a SHADOW_HOLDOUT successor", () => {
    const readiness = evaluateCertificationReadiness(
      ledger({
        holdouts: [retired("a", "fresh-y"), entry({ caseId: "fresh-y", tier: "VALIDATION" })],
        successors: [successor({ caseId: "fresh-y", tier: "SHADOW_HOLDOUT" })],
      }),
    );
    expect(readiness.status, readiness.reasons.join("\n")).toBe("BLOCKED");
  });

  it("a designated successor that no retiree names is still validated (label-blind, SHADOW_HOLDOUT)", () => {
    const contaminated = evaluateCertificationReadiness(
      ledger({
        holdouts: [entry({ caseId: "active-ok" })],
        successors: [successor({ caseId: "orphan", labelBlind: false, inspectionCount: 0 })],
      }),
    );
    expect(contaminated.status, contaminated.reasons.join("\n")).toBe("BLOCKED");

    const devTier = evaluateCertificationReadiness(
      ledger({
        holdouts: [entry({ caseId: "active-ok" })],
        successors: [successor({ caseId: "orphan", tier: "DEV" })],
      }),
    );
    expect(devTier.status, devTier.reasons.join("\n")).toBe("BLOCKED");
  });
});

describe("S2-B: the ledger-derived held-out set must fail closed on records certification already rejects", () => {
  it("a designated successor is held out whatever tier its record claims", () => {
    for (const tier of ["DEV", "VALIDATION", "BOGUS", "shadow_holdout"] as const) {
      const badLedger = ledger({
        holdouts: [retired("a", "fresh-y")],
        successors: [successor({ caseId: "fresh-y", tier: tier as SuccessorDesignation["tier"] })],
      });
      expect(evaluateCertificationReadiness(badLedger).status, tier).toBe("BLOCKED");
      const heldOut = deriveHeldOutCaseIds(badLedger);
      expect(heldOut.all.has("fresh-y"), `successor tier ${tier} must be held out`).toBe(true);
    }
  });

  it("an ACTIVE holdout on an unknown tier is held out (its inspection budget is undefined, so zero)", () => {
    for (const tier of ["SHADOW_HOLDOUT ", "shadow_holdout", "LOCKED-TEST", "BOGUS"] as const) {
      const badLedger = ledger({
        holdouts: [entry({ caseId: "case-x", tier: tier as HoldoutEntry["tier"] })],
      });
      expect(evaluateCertificationReadiness(badLedger).status, tier).toBe("BLOCKED");
      const heldOut = deriveHeldOutCaseIds(badLedger);
      expect(heldOut.all.has("case-x"), `holdout tier '${tier}' must be held out`).toBe(true);
    }
  });
});

describe("S2-C: loadHoldoutLedger maps every unreadable-ledger failure to HoldoutLedgerError", () => {
  it("a directory at the ledger path is a typed governance error, not raw EISDIR", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "holdout-ledger-dir-"));
    mkdirSync(join(repoRoot, HOLDOUT_LEDGER_PATH), { recursive: true });
    let thrown: unknown;
    try {
      loadHoldoutLedger(repoRoot);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HoldoutLedgerError);
    expect(loadCertificationReadiness(repoRoot).status).toBe("NOT_EVALUABLE");
  });
});

describe("S2-D: coach-gate held-out list is not derived from the ledger", () => {
  const heldOut = loadHeldOutCaseIds(REPO_ROOT);
  const realLedger = loadHoldoutLedger(REPO_ROOT);

  it("coachProgramOps.isHeldOutCase recognises every ledger-held-out id (successors included)", () => {
    for (const designated of realLedger.successors) {
      expect(isHeldOutCase(designated.caseId), designated.caseId).toBe(true);
    }
  });

  it("coachGates.HELD_OUT_CASE_IDS is the ledger-derived set, not a hand-copied pair", () => {
    expect([...HELD_OUT_CASE_IDS].sort()).toEqual([...heldOut.all].sort());
  });
});

describe("S2-E: paddle-bench keys the held-out check on the manifest id only", () => {
  const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const tsxBin = join(pkgRoot, "node_modules", ".bin", "tsx");
  const cli = join(pkgRoot, "src", "paddleBench.ts");

  it("a manifest that aliases a designated successor's label and run files under a fresh id is refused", () => {
    const successorId = loadHoldoutLedger(REPO_ROOT).successors[0]!.caseId;
    const dir = mkdtempSync(join(tmpdir(), "paddle-bench-alias-"));
    const labelsRel = `bundles/${successorId}/annotation/devin-visual-v1.json`;
    const runRel = `runs/${successorId}`;
    mkdirSync(dirname(join(dir, labelsRel)), { recursive: true });
    mkdirSync(join(dir, runRel), { recursive: true });
    writeFileSync(
      join(dir, labelsRel),
      JSON.stringify({
        annotatorId: "attacker",
        paddleFrames: [{ tMs: 0, visibility: "visible", point: { x: 0.5, y: 0.5 } }],
      }),
    );
    writeFileSync(
      join(dir, runRel, "debug.json"),
      JSON.stringify({
        paddle: { observations: [{ t: 0, x: 0.45, y: 0.45, w: 0.1, h: 0.1, conf: 0.9 }] },
      }),
    );
    const manifest = join(dir, "paddle-bench.json");
    writeFileSync(
      manifest,
      JSON.stringify({
        schemaVersion: 1,
        provenance: "licensed",
        cases: [
          {
            id: "totally-not-a-holdout",
            video: `videos/${successorId}.mp4`,
            labels: labelsRel,
            runDir: runRel,
            role: "development",
          },
        ],
      }),
    );
    const run = spawnSync(tsxBin, [cli, manifest], {
      cwd: pkgRoot,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
      timeout: 120_000,
    });
    expect(run.status, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).not.toBe(0);
    expect(run.stdout).not.toContain("REAL PADDLE BENCHMARK");
    expect(run.stderr).toContain(successorId);
  });
});
