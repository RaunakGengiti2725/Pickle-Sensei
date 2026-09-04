import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveHeldOutCaseIds,
  evaluateCertificationReadiness,
  loadCertificationReadiness,
  type HoldoutLedger,
  type HoldoutTier,
} from "../../src/holdoutRotation.js";

/**
 * S2 attack: the ledger-derived held-out set must fail CLOSED on the same
 * ledger states that certification readiness already refuses.
 *
 * `validateHoldoutLedger` accepts any non-empty string as a tier (only
 * `status` is checked against its enum). Readiness then reports INVALID_TIER
 * / "must be SHADOW_HOLDOUT" and BLOCKS — but `deriveHeldOutCaseIds` silently
 * treats the same case as NOT protected, so paddle-bench, the label queues
 * and the fresh-candidate enumeration all see a designated successor whose
 * tier carries a trailing space, a lowercase spelling or a zero-width
 * character as ordinary development footage. A ledger the checker calls
 * invalid must not un-protect a case; it must be rejected or the case held.
 */

function ledger(): HoldoutLedger {
  return {
    schemaVersion: 1,
    policyVersion: "holdout-rotation-v1",
    generatedAtIso: "2026-09-01T00:00:00.000Z",
    holdouts: [
      {
        caseId: "old-1",
        tier: "LOCKED_TEST",
        status: "RETIRED_TO_REGRESSION",
        firstHeldOutAtIso: "2026-08-28",
        inspections: [
          { kind: "committed_label", dateIso: "2026-08-28", workstream: "w", evidence: "e" },
          { kind: "failure_dossier", dateIso: "2026-08-28", workstream: "w", evidence: "e" },
          { kind: "human_frame_review", dateIso: "2026-08-28", workstream: "w", evidence: "e" },
          { kind: "benchmark_evaluation", dateIso: "2026-08-29", workstream: "w", evidence: "e" },
        ],
        retirement: {
          dateIso: "2026-08-29",
          workstream: "w",
          reason: "over budget",
          regressionRole: "pinned",
          successorId: "succ-1",
        },
        notes: "",
      },
    ],
    successors: [
      {
        caseId: "succ-1",
        tier: "SHADOW_HOLDOUT",
        designatedAtIso: "2026-08-29",
        designationRule: "rule",
        registryRef: "registry",
        labelBlind: true,
        inspectionCount: 0,
        pendingExternal: "",
      },
    ],
  };
}

const TIER_TYPOS = ["SHADOW_HOLDOUT ", "shadow_holdout", "SHADOW-HOLDOUT", "SHADOW_HOLDOUT\u200b"];

describe("S2: held-out derivation fails open on tiers readiness refuses", () => {
  it("control: a well-formed successor is held out and the ledger is ELIGIBLE", () => {
    const l = ledger();
    expect(evaluateCertificationReadiness(l).status).toBe("ELIGIBLE");
    expect([...deriveHeldOutCaseIds(l).all].sort()).toEqual(["old-1", "succ-1"]);
  });

  for (const tier of TIER_TYPOS) {
    it(`a designated successor with tier ${JSON.stringify(tier)} stays held out`, () => {
      const l = ledger();
      l.successors[0]!.tier = tier as HoldoutTier;
      // Readiness already treats this ledger as unfit.
      expect(evaluateCertificationReadiness(l).status).toBe("BLOCKED");
      // The held-out set must not silently un-protect the successor.
      let held: ReadonlySet<string> | null = null;
      try {
        held = deriveHeldOutCaseIds(l).all;
      } catch {
        return; // throwing (MALFORMED) is an acceptable fail-closed outcome
      }
      expect(held, `tier ${JSON.stringify(tier)} → held-out ${[...held]}`).toContain("succ-1");
    });
  }

  it("an ACTIVE holdout with an INVALID_TIER verdict stays held out", () => {
    const l = ledger();
    l.holdouts.push({
      caseId: "active-1",
      tier: "SHADOW_HOLDOUT " as HoldoutTier,
      status: "ACTIVE",
      firstHeldOutAtIso: "2026-08-30",
      inspections: [],
      retirement: null,
      notes: "",
    });
    const readiness = evaluateCertificationReadiness(l);
    expect(readiness.status).toBe("BLOCKED");
    expect(readiness.holdouts.find((h) => h.caseId === "active-1")?.verdict).toBe("INVALID_TIER");
    let held: ReadonlySet<string> | null = null;
    try {
      held = deriveHeldOutCaseIds(l).all;
    } catch {
      return;
    }
    expect([...held]).toContain("active-1");
  });
});

describe("S2: readiness accepts a ledger that contradicts itself about a successor", () => {
  it("a successor also listed as an ACTIVE DEV holdout with 5 inspections is not ELIGIBLE", () => {
    const l = ledger();
    l.holdouts.push({
      caseId: "succ-1",
      tier: "DEV",
      status: "ACTIVE",
      firstHeldOutAtIso: "2026-08-01",
      inspections: Array.from({ length: 5 }, () => ({
        kind: "human_frame_review" as const,
        dateIso: "2026-08-02",
        workstream: "w",
        evidence: "e",
      })),
      retirement: null,
      notes: "",
    });
    // The designation says inspectionCount 0 / label-blind; the holdout entry
    // for the same case id records five inspections in a DEV tier.
    expect(evaluateCertificationReadiness(l).status).not.toBe("ELIGIBLE");
  });
});

describe("S2: loadCertificationReadiness is NOT_EVALUABLE, not a crash, for unreadable ledgers", () => {
  it("ledger path that is a directory (EISDIR)", () => {
    const root = mkdtempSync(join(tmpdir(), "ledger-eisdir-"));
    mkdirSync(join(root, "datasets", "holdouts", "ledger.json"), { recursive: true });
    expect(loadCertificationReadiness(root).status).toBe("NOT_EVALUABLE");
  });

  it("ledger file without read permission (EACCES)", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores mode bits
    const root = mkdtempSync(join(tmpdir(), "ledger-eacces-"));
    mkdirSync(join(root, "datasets", "holdouts"), { recursive: true });
    const path = join(root, "datasets", "holdouts", "ledger.json");
    writeFileSync(path, JSON.stringify(ledger()));
    chmodSync(path, 0o000);
    try {
      expect(loadCertificationReadiness(root).status).toBe("NOT_EVALUABLE");
    } finally {
      chmodSync(path, 0o600);
    }
  });
});
