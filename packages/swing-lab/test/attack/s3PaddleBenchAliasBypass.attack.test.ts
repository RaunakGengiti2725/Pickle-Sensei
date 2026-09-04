import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../src/engine/corpus.js";
import { loadHeldOutCaseIds, loadHoldoutLedger } from "../../src/holdoutRotation.js";
import { heldOutManifestViolations, type BenchManifestCase } from "../../src/paddleBench.js";

/**
 * S3 attack: paddle-bench's held-out refusal keys on the manifest `id`
 * string only. The labels and run directory a case actually opens are named
 * by `labels` / `runDir`, so the committed labels of a retired holdout can be
 * scored as "development" simply by giving the manifest case another id (or
 * the same id with trailing whitespace). The module header promises the
 * ledger check happens "before any label or run file is opened" — the check
 * must therefore look at what is opened, not only at the label the manifest
 * author chose.
 */

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tsxBin = join(pkgRoot, "node_modules", ".bin", "tsx");
const cli = join(pkgRoot, "src", "paddleBench.ts");
const benchDir = join(REPO_ROOT, "datasets", "paddle-bench");

const retiredWithLabels = loadHoldoutLedger(REPO_ROOT)
  .holdouts.filter((h) => h.status === "RETIRED_TO_REGRESSION")
  .map((h) => h.caseId)
  .find((id) => {
    try {
      return readdirSync(join(benchDir, "bundles", id, "annotation")).length > 0;
    } catch {
      return false;
    }
  });

function scratchManifest(caseId: string, retired: string): string {
  const scratch = mkdtempSync(join(tmpdir(), "paddle-bench-alias-"));
  symlinkSync(join(benchDir, "bundles"), join(scratch, "bundles"), "dir");
  mkdirSync(join(scratch, "runs", retired), { recursive: true });
  mkdirSync(join(scratch, "results"));
  // Minimal run output so the case is scoreable (no observations at all).
  writeFileSync(
    join(scratch, "runs", retired, "debug.json"),
    JSON.stringify({ paddle: { observations: [] } }),
  );
  const labels = readdirSync(join(benchDir, "bundles", retired, "annotation"))[0]!;
  const manifest = {
    schemaVersion: 1,
    provenance: "licensed",
    cases: [
      {
        id: caseId,
        video: `videos/${retired}.mp4`,
        labels: `bundles/${retired}/annotation/${labels}`,
        runDir: `runs/${retired}`,
        role: "development",
      },
    ],
  };
  const path = join(scratch, "paddle-bench.json");
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return path;
}

function runPaddleBench(manifest: string) {
  const result = spawnSync(tsxBin, [cli, manifest], {
    cwd: pkgRoot,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 120_000,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("S3: paddle-bench scores a retired holdout's labels under an aliased id", () => {
  it("precondition: a retired holdout has committed labels under datasets/paddle-bench/bundles", () => {
    expect(retiredWithLabels).toBeDefined();
  });

  for (const alias of [(id: string) => `${id}-dev`, (id: string) => `${id} `]) {
    const label = alias("<retired>");
    it(`CLI refuses manifest id ${JSON.stringify(label)} whose labels/runDir are the retired case`, () => {
      const retired = retiredWithLabels!;
      const manifest = scratchManifest(alias(retired), retired);
      const run = runPaddleBench(manifest);
      expect(run.status, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).not.toBe(0);
      expect(run.stdout).not.toContain("REAL PADDLE BENCHMARK");
      expect(readdirSync(join(dirname(manifest), "results"))).toEqual([]);
    });
  }

  it("heldOutManifestViolations flags a case whose labels path names a held-out case", () => {
    const retired = retiredWithLabels!;
    const benchCase: BenchManifestCase = {
      id: `${retired}-dev`,
      video: `videos/${retired}.mp4`,
      labels: `bundles/${retired}/annotation/devin-visual-v1.json`,
      runDir: `runs/${retired}`,
      role: "development",
    };
    const violations = heldOutManifestViolations([benchCase], loadHeldOutCaseIds(REPO_ROOT));
    expect(violations.join("\n")).toContain(retired);
  });

  it("control: the same case under its real id is refused", () => {
    const retired = retiredWithLabels!;
    const manifest = scratchManifest(retired, retired);
    const run = runPaddleBench(manifest);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(retired);
    expect(JSON.parse(readFileSync(manifest, "utf8")).cases[0].role).toBe("development");
  });
});
