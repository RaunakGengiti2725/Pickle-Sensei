import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HELD_OUT_BUNDLES } from "../src/labelQueueV2.js";
import { HELD_OUT_CASES } from "../src/learningCurveModality.js";
import { OWNERSHIP_CASES } from "../src/ownershipBench.js";

/**
 * HELD-OUT EXCLUSION CONSISTENCY PIN.
 *
 * The held-out exclusion list is declared independently in several research
 * tools (exported constants, module-local literals, and per-case split
 * metadata). Every copy must name exactly the same cases: a partial or
 * misspelled copy would silently let a held-out case leak into a bench,
 * curve, or label queue. This test pins all known copies to the canonical
 * exported list and scans swing-lab/vision-geometry sources for any literal
 * Set/array that names one held-out case without the other.
 */

const CANONICAL = [...HELD_OUT_BUNDLES].sort();

const REPO_ROOT = resolve(__dirname, "..", "..", "..");

function tsSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsSourceFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("held-out exclusion list consistency", () => {
  it("exported constants agree with the canonical list", () => {
    expect([...HELD_OUT_CASES].sort()).toEqual(CANONICAL);
  });

  it("ownership bench split table marks exactly the canonical cases held_out", () => {
    const heldOut = Object.entries(OWNERSHIP_CASES)
      .filter(([, info]) => info.split === "held_out")
      .map(([id]) => id)
      .sort();
    expect(heldOut).toEqual(CANONICAL);
  });

  it("paddle-bench.json held-out roles match the canonical list", () => {
    const bench = JSON.parse(
      readFileSync(join(REPO_ROOT, "datasets", "paddle-bench", "paddle-bench.json"), "utf8"),
    ) as { cases: Array<{ id: string; role: string }> };
    const heldOut = bench.cases
      .filter((c) => c.role === "held_out" || c.role === "test_held_out")
      .map((c) => c.id)
      .sort();
    expect(heldOut).toEqual(CANONICAL);
  });

  it("no source literal names one held-out case without the other", () => {
    const roots = [
      join(REPO_ROOT, "packages", "swing-lab", "src"),
      join(REPO_ROOT, "packages", "vision-geometry", "src"),
    ];
    const literalPattern = /new Set\(\[([^\]]*)\]\)|=\s*\[([^\]]*)\]\s*as const/g;
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of tsSourceFiles(root)) {
        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(literalPattern)) {
          const body = match[1] ?? match[2] ?? "";
          const named = CANONICAL.filter((name) => body.includes(name));
          if (named.length > 0 && named.length !== CANONICAL.length) {
            offenders.push(`${file}: literal names only ${named.join(", ")}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
