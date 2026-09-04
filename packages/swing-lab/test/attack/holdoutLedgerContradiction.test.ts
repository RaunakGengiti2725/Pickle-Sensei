import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HOLDOUT_LEDGER_PATH,
  HOLDOUT_ROTATION_POLICY_VERSION,
  evaluateCertificationReadiness,
  loadHoldoutLedger,
  type HoldoutLedger,
} from "../../src/holdoutRotation.js";

/**
 * Adversarial pass 3 (tester #4) — S7: the ledger SAYS the designated
 * successor has inspectionCount 0, but the datasets/ tree in the same repo
 * root already holds an artifact that names that case (a committed
 * annotation bundle — the exact evidence kind the real ledger cites as
 * proof of a `committed_label` inspection). Certification readiness must
 * detect the contradiction and stay BLOCKED; a self-reported zero must not
 * be enough to certify.
 */

const SUCCESSOR = "yt-fresh-attack-01";

function ledgerWithCleanSuccessor(): HoldoutLedger {
  return {
    schemaVersion: 1,
    policyVersion: HOLDOUT_ROTATION_POLICY_VERSION,
    generatedAtIso: "2026-09-04T00:00:00.000Z",
    holdouts: [
      {
        caseId: "retired-case-01",
        tier: "LOCKED_TEST",
        status: "RETIRED_TO_REGRESSION",
        firstHeldOutAtIso: "2026-08-01",
        inspections: [
          {
            kind: "benchmark_evaluation",
            dateIso: "2026-08-02",
            workstream: "attack",
            evidence: "synthetic",
            artifactFileCount: 4,
          },
          { kind: "committed_label", dateIso: "2026-08-03", workstream: "attack", evidence: "s" },
          { kind: "failure_dossier", dateIso: "2026-08-04", workstream: "attack", evidence: "s" },
          {
            kind: "human_frame_review",
            dateIso: "2026-08-05",
            workstream: "attack",
            evidence: "s",
          },
        ],
        retirement: {
          dateIso: "2026-08-06",
          workstream: "attack",
          reason: "over budget",
          regressionRole: "pinned regression fixture",
          successorId: SUCCESSOR,
        },
        notes: "",
      },
    ],
    successors: [
      {
        caseId: SUCCESSOR,
        tier: "SHADOW_HOLDOUT",
        designatedAtIso: "2026-08-06",
        designationRule: "next chronological fresh candidate",
        registryRef: "datasets/pickleball/registry.json#freshCandidates",
        labelBlind: true,
        inspectionCount: 0,
        pendingExternal: "",
      },
    ],
  };
}

describe("S7 — successor inspectionCount 0 contradicted by a datasets/ artifact", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function tempRepoRoot(ledger: HoldoutLedger): string {
    const root = mkdtempSync(join(tmpdir(), "attack-s7-"));
    roots.push(root);
    mkdirSync(join(root, "datasets", "holdouts"), { recursive: true });
    writeFileSync(join(root, HOLDOUT_LEDGER_PATH), JSON.stringify(ledger, null, 2));
    return root;
  }

  it("control: with a clean datasets/ tree the ledger alone is ELIGIBLE", () => {
    const root = tempRepoRoot(ledgerWithCleanSuccessor());
    const readiness = evaluateCertificationReadiness(loadHoldoutLedger(root));
    expect(readiness.status).toBe("ELIGIBLE");
  });

  it("a committed annotation bundle for the successor must BLOCK certification", () => {
    const root = tempRepoRoot(ledgerWithCleanSuccessor());
    const bundleDir = join(root, "datasets", "paddle-bench", "bundles", SUCCESSOR, "annotation");
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(
      join(bundleDir, "devin-visual-v1.json"),
      JSON.stringify({ caseId: SUCCESSOR, frames: [{ index: 0, paddle: "visible" }] }),
    );

    const readiness = evaluateCertificationReadiness(loadHoldoutLedger(root));
    expect(readiness.status, JSON.stringify(readiness.reasons)).toBe("BLOCKED");
    expect(readiness.reasons.join("\n")).toContain(SUCCESSOR);
  });

  it("a failure dossier directory naming the successor must BLOCK certification", () => {
    const root = tempRepoRoot(ledgerWithCleanSuccessor());
    const dossier = join(
      root,
      "datasets",
      "ball-bench",
      "failures",
      `BALL_FALSE_POSITIVE_BACKGROUND-${SUCCESSOR}`,
    );
    mkdirSync(dossier, { recursive: true });
    writeFileSync(join(dossier, "report.json"), JSON.stringify({ caseId: SUCCESSOR }));

    const readiness = evaluateCertificationReadiness(loadHoldoutLedger(root));
    expect(readiness.status, JSON.stringify(readiness.reasons)).toBe("BLOCKED");
  });

  it("an experiment summary that merely references the successor id must BLOCK certification", () => {
    const root = tempRepoRoot(ledgerWithCleanSuccessor());
    const dir = join(root, "datasets", "experiments", "wave-x");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "summary.json"),
      JSON.stringify({ perCase: [{ caseId: SUCCESSOR, recall: 0.5 }] }),
    );

    const readiness = evaluateCertificationReadiness(loadHoldoutLedger(root));
    expect(readiness.status, JSON.stringify(readiness.reasons)).toBe("BLOCKED");
  });

  it("negative inspectionCount is not 'zero inspections'", () => {
    const ledger = ledgerWithCleanSuccessor();
    ledger.successors[0]!.inspectionCount = -1;
    const root = tempRepoRoot(ledger);
    const readiness = evaluateCertificationReadiness(loadHoldoutLedger(root));
    expect(readiness.status).toBe("BLOCKED");
  });

  it("NaN inspectionCount (from JSON `null`) is not 'zero inspections'", () => {
    const ledger = ledgerWithCleanSuccessor();
    (ledger.successors[0] as { inspectionCount: unknown }).inspectionCount = null;
    const root = tempRepoRoot(ledger);
    const readiness = evaluateCertificationReadiness(loadHoldoutLedger(root));
    expect(readiness.status).toBe("BLOCKED");
  });
});
