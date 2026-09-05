/**
 * Adversarial close-out probes for candidate 2934d45f (pkg-swing-lab::ADJ-02).
 *
 * Each case documents a fail-open or scaling defect in the CHANGED code of
 * src/holdoutRotation.ts. A FAILING case is the evidence for a finding;
 * production code is not modified on this branch. Compared against the
 * integrated baseline f702f0f8, the baseline was worse on every fail-closed
 * axis (27/46 focused failures), so only defects introduced or left open by
 * the candidate's new decoder / auditor are pinned here.
 *
 * Plane: Linux (pure TypeScript, no Apple runtime involved).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  auditSuccessorDesignations,
  decodeHoldoutLedger,
  evaluateCertificationReadiness,
  HOLDOUT_LEDGER_PATH,
  loadHoldoutLedger,
  type HoldoutEntry,
  type HoldoutLedger,
  type SuccessorDesignation,
} from "../src/holdoutRotation.js";

const tmpRoots: string[] = [];
afterAll(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true });
});

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
    designationRule: "attack-probe rule",
    registryRef: "attack-probe",
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
    generatedAtIso: "2026-08-29T00:00:00Z",
    holdouts: [entry()],
    successors: [],
    ...overrides,
  };
}

function writeLedgerAt(root: string, contents: string): void {
  mkdirSync(join(root, "datasets", "holdouts"), { recursive: true });
  writeFileSync(join(root, HOLDOUT_LEDGER_PATH), contents);
}

describe("attack 2934d45f — schema version is not pinned (ADJ-02 neighbourhood)", () => {
  it("a ledger written under a FUTURE schemaVersion is NOT_EVALUABLE, not ELIGIBLE", () => {
    // The candidate pins policyVersion (foreign policy => NOT_EVALUABLE) but
    // only checks schemaVersion >= 1, so a v2 ledger whose field semantics
    // this decoder was never written for is evaluated under v1 rules and can
    // certify. Same fail-open class the fix set out to close.
    const readiness = evaluateCertificationReadiness(ledger({ schemaVersion: 2 }));
    expect(readiness.status).toBe("NOT_EVALUABLE");
    expect(readiness.reasons.some((reason) => /schemaVersion/i.test(reason))).toBe(true);
  });

  it("decodeHoldoutLedger rejects a schemaVersion this decoder does not implement", () => {
    const decoded = decodeHoldoutLedger(ledger({ schemaVersion: 99 }));
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.defects.some((defect) => /schemaVersion/i.test(defect))).toBe(true);
    }
  });

  it("loadHoldoutLedger refuses a future-schema ledger with a typed governance error", () => {
    const root = mkdtempSync(join(tmpdir(), "attack-2934d45f-schema-"));
    tmpRoots.push(root);
    writeLedgerAt(root, JSON.stringify(ledger({ schemaVersion: 2 })));
    expect(() => loadHoldoutLedger(root)).toThrow(/holdout ledger/i);
  });
});

describe("attack 2934d45f — successor auditor scales quadratically in retirees", () => {
  // auditSuccessorDesignations accumulates claimants with
  // `[...(claimants.get(id) ?? []), entry.caseId]` — an O(n) copy per retiree
  // when many retirees name the same successor, i.e. O(n²) overall. Measured
  // on the candidate: 20k retirees ≈ 1.2 s, 50k ≈ 10 s (baseline f702f0f8:
  // 31 ms for 50k, albeit with the wrong verdict). A linear accumulation
  // finishes 60k in well under a second.
  it("60k retired holdouts sharing one successor audit in bounded time", () => {
    const retirees = Array.from({ length: 60_000 }, (_, index) =>
      entry({
        caseId: `retired-${index}`,
        status: "RETIRED_TO_REGRESSION",
        inspections: [],
        retirement: {
          dateIso: "2026-08-28",
          workstream: "attack-probe",
          reason: "attack-probe scale",
          regressionRole: "regression fixture",
          successorId: "fresh-y",
        },
      }),
    );
    const scaled = ledger({ holdouts: retirees, successors: [successor()] });
    const started = performance.now();
    const findings = auditSuccessorDesignations(scaled);
    const elapsedMs = performance.now() - started;
    expect(findings.some((finding) => /claimed by 60000 retired holdouts/.test(finding))).toBe(
      true,
    );
    expect(elapsedMs).toBeLessThan(3_000);
  });
});
