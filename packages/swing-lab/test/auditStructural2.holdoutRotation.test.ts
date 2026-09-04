import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HELD_OUT_CASE_IDS } from "../src/coachGates.js";
import { REPO_ROOT } from "../src/engine/corpus.js";
import {
  evaluateCertificationReadiness,
  HOLDOUT_LEDGER_PATH,
  loadHoldoutLedger,
  type HoldoutEntry,
  type HoldoutLedger,
  type SuccessorDesignation,
} from "../src/holdoutRotation.js";
import { HELD_OUT_BUNDLES } from "../src/labelQueueV2.js";

/**
 * Structural audit (pass 1, auditor #2) — holdoutRotation governance.
 *
 * The module header promises: "the checker treats a missing or malformed
 * ledger as NOT_EVALUABLE, which blocks certification exactly like FAIL"
 * and "certification claims are blocked until ... at least one such
 * successor exists". These tests assert exactly that. A FAILING test here
 * is a reproduced finding on 4d812e1a.
 */

const tmp = mkdtempSync(join(tmpdir(), "audit-holdout-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

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

function retired(caseId: string, successorId: string | null): HoldoutEntry {
  return {
    caseId,
    tier: "LOCKED_TEST",
    status: "RETIRED_TO_REGRESSION",
    firstHeldOutAtIso: "2026-08-01",
    inspections: [],
    retirement: {
      dateIso: "2026-08-29",
      workstream: "audit",
      reason: "audit fixture",
      regressionRole: "regression",
      successorId,
    },
    notes: "",
  };
}

function successor(overrides: Partial<SuccessorDesignation> = {}): SuccessorDesignation {
  return {
    caseId: "fresh-y",
    tier: "SHADOW_HOLDOUT",
    designatedAtIso: "2026-08-29",
    designationRule: "audit",
    registryRef: "audit",
    labelBlind: true,
    inspectionCount: 0,
    pendingExternal: "",
    ...overrides,
  };
}

function writeLedger(root: string, contents: string): void {
  mkdirSync(join(root, "datasets/holdouts"), { recursive: true });
  writeFileSync(join(root, HOLDOUT_LEDGER_PATH), contents);
}

describe("audit: fail-closed on empty / malformed ledgers", () => {
  it("a ledger with zero holdouts and zero successors is NOT eligible for certification", () => {
    const readiness = evaluateCertificationReadiness(ledger());
    expect(readiness.status).not.toBe("ELIGIBLE");
  });

  it("a ledger whose `successors` key is missing yields NOT_EVALUABLE, not a TypeError", () => {
    const malformed = ledger({ holdouts: [retired("case-x", "fresh-y")] });
    delete (malformed as Partial<HoldoutLedger>).successors;
    let readiness: ReturnType<typeof evaluateCertificationReadiness> | null = null;
    expect(() => {
      readiness = evaluateCertificationReadiness(malformed);
    }).not.toThrow();
    expect(readiness!.status).toBe("NOT_EVALUABLE");
  });

  it("a ledger whose `holdouts` is not an array yields NOT_EVALUABLE, not a TypeError", () => {
    const malformed = ledger();
    (malformed as unknown as { holdouts: unknown }).holdouts = { caseId: "oops" };
    let readiness: ReturnType<typeof evaluateCertificationReadiness> | null = null;
    expect(() => {
      readiness = evaluateCertificationReadiness(malformed);
    }).not.toThrow();
    expect(readiness!.status).toBe("NOT_EVALUABLE");
  });

  it("loadHoldoutLedger on a MISSING ledger does not throw (doc: NOT_EVALUABLE)", () => {
    const root = join(tmp, "missing");
    mkdirSync(root, { recursive: true });
    expect(() => loadHoldoutLedger(root)).not.toThrow();
  });

  it("loadHoldoutLedger on a MALFORMED (non-JSON) ledger does not throw (doc: NOT_EVALUABLE)", () => {
    const root = join(tmp, "malformed");
    writeLedger(root, "{ this is not json");
    expect(() => loadHoldoutLedger(root)).not.toThrow();
  });

  it("loadHoldoutLedger validates shape beyond policyVersion (holdouts must be an array)", () => {
    const root = join(tmp, "shape");
    writeLedger(root, JSON.stringify({ policyVersion: "holdout-rotation-v1", holdouts: "nope" }));
    let loaded: HoldoutLedger | null = null;
    let threw = false;
    try {
      loaded = loadHoldoutLedger(root);
    } catch {
      threw = true;
    }
    // Either reject at load time with a validation error, or hand back a
    // ledger the evaluator can process. Silently returning a non-array is
    // neither.
    if (!threw) {
      expect(Array.isArray(loaded?.holdouts)).toBe(true);
    }
  });
});

describe("audit: successor designation trust", () => {
  it("a successor that IS a retired (contaminated) holdout cannot serve", () => {
    const readiness = evaluateCertificationReadiness(
      ledger({
        holdouts: [retired("case-a", "case-b"), retired("case-b", "case-a")],
        successors: [successor({ caseId: "case-a" }), successor({ caseId: "case-b" })],
      }),
    );
    expect(readiness.status).toBe("BLOCKED");
  });

  it("a successor whose tier is not SHADOW_HOLDOUT cannot serve", () => {
    const readiness = evaluateCertificationReadiness(
      ledger({
        holdouts: [retired("case-a", "fresh-y")],
        successors: [successor({ tier: "DEV" })],
      }),
    );
    expect(readiness.status).toBe("BLOCKED");
  });
});

describe("audit: real ledger — self-declared successor inspectionCount vs committed artifacts", () => {
  // The ledger's own provenanceNote says artifact-file counts come from
  // `grep -rl <caseId> datasets/` and it books such references as
  // `benchmark_evaluation` inspections for the retired cases. Apply the same
  // rule to the successors it declares uninspected.
  const real = loadHoldoutLedger(REPO_ROOT);

  for (const s of real.successors) {
    it(`${s.caseId}: inspectionCount=${s.inspectionCount} is consistent with committed measurement artifacts`, () => {
      let files: string[] = [];
      try {
        files = execFileSync(
          "grep",
          [
            "-rl",
            "--include=*.json",
            s.caseId,
            join(REPO_ROOT, "datasets/experiments"),
            join(REPO_ROOT, "datasets/paddle-bench"),
            join(REPO_ROOT, "datasets/ball-bench"),
          ],
          { encoding: "utf8" },
        )
          .trim()
          .split("\n")
          .filter(Boolean);
      } catch (error) {
        // grep exits 1 when nothing matches
        const status = (error as { status?: number }).status;
        if (status !== 1) throw error;
      }
      const measurementFiles = files.filter((f) =>
        /measurement|probe|bench|results|summary/i.test(f),
      );
      if (s.inspectionCount === 0) {
        expect(
          measurementFiles.map((f) => f.replace(`${REPO_ROOT}/`, "")),
          `${s.caseId} declared uninspected`,
        ).toEqual([]);
      }
    });
  }

  it("no committed artifact records a human visually screening frames of a successor declared inspectionCount=0", () => {
    // holdoutRotation.ts line 9: "Every inspection — a human viewing frames,
    // a committed label, a failure dossier..." counts. The ledger says the
    // successors' content "was never opened or viewed"; the committed g18
    // summary is checked for the opposite statement.
    const g18 = readFileSync(
      join(REPO_ROOT, "datasets/experiments/wave-g/g18-fresh-footage-summary.json"),
      "utf8",
    );
    for (const s of real.successors) {
      if (s.inspectionCount !== 0) continue;
      const mentionsVisualScreening = g18
        .split("\n")
        .some((line) => line.includes(s.caseId) && /visual screening|montage|viewed/i.test(line));
      expect(mentionsVisualScreening, `${s.caseId} declared never viewed`).toBe(false);
    }
  });
});

describe("audit: held-out lists are ledger-derived (verified_ok candidate)", () => {
  it("coachGates and labelQueueV2 held-out ids equal the ledger's governed holdout ids", () => {
    const real = loadHoldoutLedger(REPO_ROOT);
    const governed = [...real.holdouts.map((h) => h.caseId)].sort();
    expect([...HELD_OUT_CASE_IDS].sort()).toEqual(governed);
    expect([...HELD_OUT_BUNDLES].sort()).toEqual(governed);
  });
});
