/**
 * Adversarial close-out probes for candidate a2e143e4 (pkg-swing-lab::ADJ-02,
 * round 2).
 *
 * The candidate closes every fail-open axis of the adjudicated finding (a
 * 150k-ledger seeded differential fuzz against an independent oracle found
 * zero status mismatches, zero throws and no order dependence of the status).
 * What remains are three P3 gaps in the NEW decoder / error surface, each
 * pinned by a FAILING case below. Production code is not modified on this
 * branch. None of these inputs can be produced by JSON.parse, so the on-disk
 * ledger path (loadHoldoutLedger) is unaffected; they bite only callers that
 * hand a JS value straight to evaluateCertificationReadiness.
 *
 * Plane: Linux (pure TypeScript, no Apple runtime involved).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";
import {
  decodeHoldoutLedger,
  evaluateCertificationReadiness,
  HOLDOUT_ROTATION_POLICY_VERSION,
  type HoldoutLedger,
} from "../src/holdoutRotation.js";
import * as publicApi from "../src/index.js";

const tmpRoots: string[] = [];
afterAll(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true });
});

function ledger(overrides: Record<string, unknown> = {}): HoldoutLedger {
  return {
    schemaVersion: 1,
    policyVersion: HOLDOUT_ROTATION_POLICY_VERSION,
    generatedAtIso: "2026-09-01T00:00:00Z",
    holdouts: [
      {
        caseId: "case-a",
        tier: "LOCKED_TEST",
        status: "ACTIVE",
        firstHeldOutAtIso: "2026-08-01",
        inspections: [],
        retirement: null,
        notes: "",
      },
    ],
    successors: [],
    ...overrides,
  } as unknown as HoldoutLedger;
}

describe("attack a2e143e4: decoder must be total over JS values, not just JSON values", () => {
  it("sparse (hole-only) holdouts array is NOT_EVALUABLE, not accepted-then-crash", () => {
    // decodeHoldoutEntry is driven by Array.prototype.forEach, which skips
    // holes, so a ledger whose holdouts are all holes decodes ok:true with
    // zero defects; auditSuccessorDesignations then feeds the holes to
    // `new Map(...)` and throws a raw TypeError ("Iterator value undefined is
    // not an entry object"). The empty-ledger guard (`length === 0`) does not
    // fire either because the array reports length 3.
    const input = ledger({ holdouts: new Array(3) });
    expect(decodeHoldoutLedger(input).ok).toBe(false);
    let readiness: ReturnType<typeof evaluateCertificationReadiness> | undefined;
    expect(() => {
      readiness = evaluateCertificationReadiness(input);
    }).not.toThrow();
    expect(readiness?.status).toBe("NOT_EVALUABLE");
    expect(readiness?.reasons.length).toBeGreaterThan(0);
  });

  it("BigInt schemaVersion is reported as a defect instead of throwing from JSON.stringify", () => {
    // The schemaVersion defect message interpolates JSON.stringify(input.schemaVersion);
    // JSON.stringify throws on BigInt, so the decoder escapes with a raw
    // TypeError ("Do not know how to serialize a BigInt") instead of NOT_EVALUABLE.
    const input = ledger({ schemaVersion: 1n });
    let readiness: ReturnType<typeof evaluateCertificationReadiness> | undefined;
    expect(() => {
      readiness = evaluateCertificationReadiness(input);
    }).not.toThrow();
    expect(readiness?.status).toBe("NOT_EVALUABLE");
    expect(readiness?.reasons.join("\n")).toMatch(/schemaVersion/);
  });

  it("cyclic object in a closed-enum field is reported as a defect instead of throwing", () => {
    // requireOneOf formats `got ${JSON.stringify(value)}`; a self-referencing
    // object makes JSON.stringify throw "Converting circular structure to JSON".
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const input = ledger({
      holdouts: [
        {
          caseId: "case-a",
          tier: "LOCKED_TEST",
          status: cyclic,
          firstHeldOutAtIso: "2026-08-01",
          inspections: [],
          retirement: null,
          notes: "",
        },
      ],
    });
    let readiness: ReturnType<typeof evaluateCertificationReadiness> | undefined;
    expect(() => {
      readiness = evaluateCertificationReadiness(input);
    }).not.toThrow();
    expect(readiness?.status).toBe("NOT_EVALUABLE");
    expect(readiness?.reasons.join("\n")).toMatch(/holdouts\[0\]\.status/);
  });
});

describe("attack a2e143e4: package entry point exposes the new typed error surface", () => {
  it("HoldoutLedgerError is reachable from @pickle/swing-lab so callers can narrow loadHoldoutLedger failures", () => {
    // index.ts re-exports loadHoldoutLedger and evaluateHoldout, both of which
    // now throw HoldoutLedgerError (with a .code discriminator), but the class
    // itself is not re-exported — a consumer of the package cannot
    // `instanceof` the error or type its `.code` without deep-importing
    // src/holdoutRotation.ts.
    const api = publicApi as unknown as Record<string, unknown>;
    expect(typeof api.HoldoutLedgerError).toBe("function");
    const root = mkdtempSync(`${tmpdir()}/attack-a2e143e4-`);
    tmpRoots.push(root);
    let thrown: unknown;
    try {
      publicApi.loadHoldoutLedger(root);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(api.HoldoutLedgerError as new () => Error);
    expect((thrown as { code?: string }).code).toBe("LEDGER_UNREADABLE");
  });

  it("decodeHoldoutLedger and HOLDOUT_LEDGER_SCHEMA_VERSION are reachable from @pickle/swing-lab", () => {
    // The candidate pins the ledger schema (HOLDOUT_LEDGER_SCHEMA_VERSION) and
    // documents decodeHoldoutLedger as the structural gate, yet neither is on
    // the package entry point; a package consumer cannot pre-validate a
    // ledger or learn which schema this build accepts.
    const api = publicApi as unknown as Record<string, unknown>;
    expect(typeof api.decodeHoldoutLedger).toBe("function");
    expect(api.HOLDOUT_LEDGER_SCHEMA_VERSION).toBe(1);
  });
});
