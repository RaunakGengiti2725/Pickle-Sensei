import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateCertificationReadiness,
  evaluateHoldout,
  HOLDOUT_LEDGER_PATH,
  HOLDOUT_ROTATION_POLICY_VERSION,
  loadHoldoutLedger,
  type CertificationReadiness,
  type HoldoutEntry,
  type HoldoutLedger,
  type SuccessorDesignation,
} from "../../src/holdoutRotation.js";

/**
 * Adversarial pass 3 (tester #3) — S3: empty / malformed holdout ledgers.
 *
 * Module contract (holdoutRotation.ts header): "the checker treats a missing
 * or malformed ledger as NOT_EVALUABLE, which blocks certification exactly
 * like FAIL". A ledger with `holdouts: []` and NO `successors` key is
 * malformed and must yield NOT_EVALUABLE (or at minimum BLOCKED) — never
 * ELIGIBLE and never an uncaught TypeError. Failing assertions here are the
 * BROKEN evidence for the finding; they are not to be weakened.
 */

type LooseLedger = Record<string, unknown>;

/** Builds a ledger object from raw JSON so type-level guarantees cannot hide the attack. */
function rawLedger(overrides: LooseLedger): HoldoutLedger {
  const base: LooseLedger = {
    schemaVersion: 1,
    policyVersion: HOLDOUT_ROTATION_POLICY_VERSION,
    generatedAtIso: "2026-09-04T00:00:00.000Z",
    holdouts: [],
    successors: [],
  };
  const merged = { ...base, ...overrides };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete merged[key];
  }
  return JSON.parse(JSON.stringify(merged)) as HoldoutLedger;
}

function evaluateSafely(
  ledger: HoldoutLedger,
): { kind: "result"; result: CertificationReadiness } | { kind: "threw"; error: unknown } {
  try {
    return { kind: "result", result: evaluateCertificationReadiness(ledger) };
  } catch (error) {
    return { kind: "threw", error };
  }
}

const NOT_ELIGIBLE = new Set(["NOT_EVALUABLE", "BLOCKED"]);

function expectNotEvaluableOrBlocked(ledger: HoldoutLedger, label: string): void {
  const outcome = evaluateSafely(ledger);
  if (outcome.kind === "threw") {
    // The assigned contract: NOT_EVALUABLE/BLOCKED rather than TypeError.
    expect.fail(`${label}: evaluateCertificationReadiness threw ${String(outcome.error)}`);
  }
  expect(NOT_ELIGIBLE.has(outcome.result.status), `${label}: status=${outcome.result.status}`).toBe(
    true,
  );
}

describe("S3 — holdouts: [] with no successors key", () => {
  it("assigned attack: must be NOT_EVALUABLE/BLOCKED, not ELIGIBLE or TypeError", () => {
    expectNotEvaluableOrBlocked(
      rawLedger({ holdouts: [], successors: undefined }),
      "holdouts:[] + missing successors",
    );
  });

  it("holdouts: [] AND successors: [] (structurally valid but empty) must not certify anything", () => {
    // An empty ledger has zero holdouts backing any claim; ELIGIBLE here means
    // "certification may proceed with no holdout evidence at all".
    expectNotEvaluableOrBlocked(rawLedger({ holdouts: [], successors: [] }), "empty ledger");
  });

  it.each([
    ["holdouts key missing", { holdouts: undefined }],
    ["holdouts null", { holdouts: null }],
    ["holdouts is an object", { holdouts: {} }],
    ["successors null", { successors: null }],
    ["successors is a string", { successors: "none" }],
    ["schemaVersion 99", { schemaVersion: 99 }],
    ["policyVersion mismatch", { policyVersion: "holdout-rotation-v0" }],
    [
      "entirely empty object",
      {
        schemaVersion: undefined,
        policyVersion: undefined,
        generatedAtIso: undefined,
        holdouts: undefined,
        successors: undefined,
      },
    ],
  ])("malformed ledger (%s) must be NOT_EVALUABLE/BLOCKED, not TypeError", (label, overrides) => {
    expectNotEvaluableOrBlocked(rawLedger(overrides as LooseLedger), label);
  });
});

describe("S3 extra — malformed entries inside an otherwise well-formed ledger", () => {
  /** Deliberately loose: several cases feed malformed shapes past the static types. */
  const entry = (overrides: LooseLedger): HoldoutEntry =>
    JSON.parse(
      JSON.stringify({
        caseId: "case-x",
        tier: "LOCKED_TEST",
        status: "ACTIVE",
        firstHeldOutAtIso: "2026-08-01",
        inspections: [],
        retirement: null,
        notes: "",
        ...overrides,
      }),
    ) as HoldoutEntry;

  const retirementTo = (successorId: string, reason = "x") => ({
    dateIso: "2026-08-30",
    workstream: "attack",
    reason,
    regressionRole: "regression fixture",
    successorId,
  });

  const successor = (overrides: Partial<SuccessorDesignation>): SuccessorDesignation => ({
    caseId: "fresh-y",
    tier: "SHADOW_HOLDOUT",
    designatedAtIso: "2026-08-29",
    designationRule: "attack rule",
    registryRef: "attack",
    labelBlind: true,
    inspectionCount: 0,
    pendingExternal: "",
    ...overrides,
  });

  it("unknown tier must not be silently WITHIN_BUDGET (budget lookup yields undefined)", () => {
    const bogus = entry({
      tier: "BOGUS_TIER",
      inspections: Array.from({ length: 500 }, (_, i) => ({
        kind: "human_frame_review",
        dateIso: `2026-08-${String((i % 28) + 1).padStart(2, "0")}`,
        workstream: "attack",
        evidence: `evt-${i}`,
      })),
    });
    let evaluation;
    try {
      evaluation = evaluateHoldout(bogus);
    } catch (error) {
      // A thrown validation error is acceptable strictness.
      expect(String(error)).toMatch(/tier/i);
      return;
    }
    expect(evaluation.verdict, "500 inspections on an unknown tier evaluated as").not.toBe(
      "WITHIN_BUDGET",
    );
    expect(Number.isFinite(evaluation.budget), `budget=${String(evaluation.budget)}`).toBe(true);
  });

  it("unknown tier with 500 inspections must not leave certification ELIGIBLE", () => {
    const bogus = entry({
      tier: "BOGUS_TIER",
      inspections: Array.from({ length: 500 }, () => ({
        kind: "human_frame_review",
        dateIso: "2026-08-01",
        workstream: "attack",
        evidence: "x",
      })),
    });
    expectNotEvaluableOrBlocked(rawLedger({ holdouts: [bogus] }), "unknown tier ACTIVE holdout");
  });

  it("missing inspections array must be NOT_EVALUABLE/BLOCKED, not TypeError", () => {
    const broken = entry({ inspections: undefined });
    expectNotEvaluableOrBlocked(rawLedger({ holdouts: [broken] }), "inspections missing");
  });

  it("a retired holdout whose designated successor IS ITSELF (self-succession) must not be ELIGIBLE", () => {
    const retired = entry({
      caseId: "wm-dink-01",
      status: "RETIRED_TO_REGRESSION",
      retirement: retirementTo("wm-dink-01", "over-inspected"),
      inspections: Array.from({ length: 10 }, () => ({
        kind: "committed_label",
        dateIso: "2026-08-01",
        workstream: "attack",
        evidence: "x",
      })),
    });
    const selfSuccessor = successor({ caseId: "wm-dink-01" });
    expectNotEvaluableOrBlocked(
      rawLedger({ holdouts: [retired], successors: [selfSuccessor] }),
      "self-succession",
    );
  });

  it("a successor that is also an over-inspected ACTIVE holdout must not be ELIGIBLE", () => {
    const retired = entry({
      caseId: "old-1",
      status: "RETIRED_TO_REGRESSION",
      retirement: retirementTo("new-1"),
    });
    const contaminated = entry({
      caseId: "new-1",
      tier: "SHADOW_HOLDOUT",
      inspections: [
        { kind: "human_frame_review", dateIso: "2026-08-31", workstream: "attack", evidence: "x" },
      ],
    });
    // The successor designation claims zero inspections while the ledger's own
    // holdout entry for the same case records one. Contradiction ⇒ not eligible.
    expectNotEvaluableOrBlocked(
      rawLedger({
        holdouts: [retired, contaminated],
        successors: [successor({ caseId: "new-1", inspectionCount: 0 })],
      }),
      "successor contradicts its own holdout entry",
    );
  });

  it("duplicate successor designations for one caseId (last-wins Map) must not flip BLOCKED → ELIGIBLE", () => {
    const retired = entry({
      caseId: "old-1",
      status: "RETIRED_TO_REGRESSION",
      retirement: retirementTo("new-1"),
    });
    const dirty = successor({ caseId: "new-1", labelBlind: false, inspectionCount: 7 });
    const clean = successor({ caseId: "new-1" });
    const dirtyFirst = evaluateSafely(
      rawLedger({ holdouts: [retired], successors: [dirty, clean] }),
    );
    const cleanFirst = evaluateSafely(
      rawLedger({ holdouts: [retired], successors: [clean, dirty] }),
    );
    expect(dirtyFirst.kind).toBe("result");
    expect(cleanFirst.kind).toBe("result");
    if (dirtyFirst.kind === "result" && cleanFirst.kind === "result") {
      // Order of designations must not decide certification.
      expect(dirtyFirst.result.status).toBe(cleanFirst.result.status);
      expect(NOT_ELIGIBLE.has(dirtyFirst.result.status)).toBe(true);
    }
  });

  it("unicode / whitespace successor ids: 'new-1 ' vs 'new-1' must not resolve to each other", () => {
    const retired = entry({
      caseId: "old-1",
      status: "RETIRED_TO_REGRESSION",
      retirement: retirementTo("new-1 "),
    });
    const outcome = evaluateSafely(
      rawLedger({ holdouts: [retired], successors: [successor({ caseId: "new-1" })] }),
    );
    expect(outcome.kind).toBe("result");
    if (outcome.kind === "result") {
      expect(outcome.result.status).toBe("BLOCKED");
      expect(outcome.result.reasons.join("\n")).toMatch(/no successor designation exists/);
    }
  });
});

describe("S3 extra — loadHoldoutLedger on missing / malformed files", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function repoWithLedger(contents: string | null): string {
    const root = mkdtempSync(join(tmpdir(), "attack3-holdout-"));
    dirs.push(root);
    if (contents !== null) {
      mkdirSync(join(root, "datasets", "holdouts"), { recursive: true });
      writeFileSync(join(root, HOLDOUT_LEDGER_PATH), contents);
    }
    return root;
  }

  it("documents: a MISSING ledger file throws ENOENT rather than producing NOT_EVALUABLE", () => {
    const root = repoWithLedger(null);
    // The header promises NOT_EVALUABLE for a missing ledger; the only API
    // that reads the file throws instead, so callers must implement the
    // promised semantics themselves. Recorded as evidence, not weakened.
    expect(() => loadHoldoutLedger(root)).toThrow(/ENOENT/);
  });

  it("documents: a syntactically broken ledger file throws SyntaxError rather than NOT_EVALUABLE", () => {
    const root = repoWithLedger("{ this is not json");
    expect(() => loadHoldoutLedger(root)).toThrow(SyntaxError);
  });

  it("a ledger file with holdouts: [] and no successors key round-trips through load + evaluate as NOT_EVALUABLE/BLOCKED", () => {
    const root = repoWithLedger(
      JSON.stringify({
        schemaVersion: 1,
        policyVersion: HOLDOUT_ROTATION_POLICY_VERSION,
        generatedAtIso: "2026-09-04T00:00:00.000Z",
        holdouts: [],
      }),
    );
    const ledger = loadHoldoutLedger(root);
    expectNotEvaluableOrBlocked(ledger, "loaded ledger without successors");
  });

  it("a ledger file whose top level is an array passes loadHoldoutLedger only if policyVersion matches — and it cannot", () => {
    const root = repoWithLedger("[]");
    expect(() => loadHoldoutLedger(root)).toThrow(/policyVersion/);
  });
});
