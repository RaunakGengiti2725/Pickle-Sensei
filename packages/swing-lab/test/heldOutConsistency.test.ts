import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadHeldOutCaseIds } from "../src/holdoutRotation.js";
import { HELD_OUT_BUNDLES } from "../src/labelQueueV2.js";
import { HELD_OUT_CASES } from "../src/learningCurveModality.js";
import { OWNERSHIP_CASES } from "../src/ownershipBench.js";
import { heldOutManifestViolations } from "../src/paddleBench.js";

/**
 * HELD-OUT EXCLUSION CONSISTENCY PIN.
 *
 * The holdout ledger (datasets/holdouts/ledger.json) is the canonical source
 * of held-out case ids: retired holdouts (contaminated, regression fixtures
 * only) plus every budget-protected SHADOW_HOLDOUT / LOCKED_TEST holdout or
 * designated successor. Some research tools still carry their own copy of
 * the retired list (exported constants, module-local literals, per-case split
 * metadata). Every copy must agree with the ledger: a partial or misspelled
 * copy would silently let a held-out case leak into a bench, curve, or label
 * queue, and a literal that names a designated successor would mean a tool
 * learned about it from somewhere other than the ledger.
 */

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const LEDGER = loadHeldOutCaseIds(REPO_ROOT);
const RETIRED = [...LEDGER.retired].sort();
const PROTECTED = [...LEDGER.protected].sort();
const ALL = [...LEDGER.all].sort();

function tsSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsSourceFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function readManifest(): { cases: Array<{ id: string; role: string }> } {
  return JSON.parse(
    readFileSync(join(REPO_ROOT, "datasets", "paddle-bench", "paddle-bench.json"), "utf8"),
  ) as { cases: Array<{ id: string; role: string }> };
}

describe("held-out exclusion list consistency", () => {
  it("the ledger holds out at least one retired case and one protected successor", () => {
    expect(RETIRED.length).toBeGreaterThan(0);
    expect(PROTECTED.length).toBeGreaterThan(0);
    expect(ALL).toEqual([...new Set([...RETIRED, ...PROTECTED])].sort());
  });

  it("the label queue's exported list is exactly the ledger-derived held-out set", () => {
    expect([...HELD_OUT_BUNDLES].sort()).toEqual(ALL);
    expect(Object.isFrozen(HELD_OUT_BUNDLES)).toBe(true);
  });

  it("the learning-curve constant names exactly the retired holdouts", () => {
    expect([...HELD_OUT_CASES].sort()).toEqual(RETIRED);
  });

  it("ownership bench split table marks exactly the retired holdouts held_out", () => {
    const heldOut = Object.entries(OWNERSHIP_CASES)
      .filter(([, info]) => info.split === "held_out")
      .map(([id]) => id)
      .sort();
    expect(heldOut).toEqual(RETIRED);
    for (const id of PROTECTED) expect(id in OWNERSHIP_CASES, id).toBe(false);
  });

  it("paddle-bench.json declares exactly the retired holdouts held out and lists no protected case", () => {
    const bench = readManifest();
    const heldOut = bench.cases
      .filter((c) => c.role === "held_out" || c.role === "test_held_out")
      .map((c) => c.id)
      .sort();
    expect(heldOut).toEqual(RETIRED);
    for (const benchCase of bench.cases) {
      expect(LEDGER.protected.has(benchCase.id), benchCase.id).toBe(false);
    }
    expect(heldOutManifestViolations(bench.cases, LEDGER)).toEqual([]);
  });

  it("heldOutManifestViolations refuses protected ids under any role and retired ids relabelled as development", () => {
    const protectedId = PROTECTED[0]!;
    const retiredId = RETIRED[0]!;
    for (const role of ["dev", "development", "held_out", "test_held_out", undefined]) {
      const benchCase = role === undefined ? { id: protectedId } : { id: protectedId, role };
      const violations = heldOutManifestViolations([benchCase], LEDGER);
      expect(violations, `protected ${role}`).toHaveLength(1);
      expect(violations[0], `protected ${role}`).toContain(protectedId);
    }
    expect(
      heldOutManifestViolations([{ id: retiredId, role: "development" }], LEDGER),
    ).toHaveLength(1);
    expect(heldOutManifestViolations([{ id: retiredId, role: "held_out" }], LEDGER)).toEqual([]);
    expect(heldOutManifestViolations([{ id: retiredId, role: "test_held_out" }], LEDGER)).toEqual(
      [],
    );
    expect(heldOutManifestViolations([{ id: "afn-sasebo-rally1", role: "dev" }], LEDGER)).toEqual(
      [],
    );
  });

  it("no source literal names one retired holdout without the other, and none names a protected case", () => {
    const roots = [
      join(REPO_ROOT, "packages", "swing-lab", "src"),
      join(REPO_ROOT, "packages", "vision-geometry", "src"),
    ];
    const literalPattern = /new Set\(\[([^\]]*)\]\)|=\s*\[([^\]]*)\]\s*as const/g;
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of tsSourceFiles(root)) {
        const source = readFileSync(file, "utf8");
        for (const id of PROTECTED) {
          if (source.includes(id)) offenders.push(`${file}: names protected case ${id}`);
        }
        for (const match of source.matchAll(literalPattern)) {
          const body = match[1] ?? match[2] ?? "";
          const named = RETIRED.filter((name) => body.includes(name));
          if (named.length > 0 && named.length !== RETIRED.length) {
            offenders.push(`${file}: literal names only ${named.join(", ")}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
