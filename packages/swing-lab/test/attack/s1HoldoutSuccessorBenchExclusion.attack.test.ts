import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../src/engine/corpus.js";
import { loadHeldOutCaseIds, loadHoldoutLedger } from "../../src/holdoutRotation.js";
import { HELD_OUT_BUNDLES } from "../../src/labelQueueV2.js";

/**
 * S1 attack: smuggle a ledger-designated SHADOW_HOLDOUT successor into a
 * paddle-bench manifest as a "dev" case and score it.
 *
 * The holdout ledger (datasets/holdouts/ledger.json) is the single source of
 * truth for which case ids are held out. A successor with inspection budget 0
 * must never be scored by any lab tool — one benchmark evaluation is one
 * inspection too many — and a retired (contaminated) holdout may keep running
 * as a regression fixture only when the manifest declares it as held out,
 * never relabelled as development footage. The paddle-bench CLI must refuse
 * both with a non-zero exit and a message naming the case and the ledger.
 */

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tsxBin = join(pkgRoot, "node_modules", ".bin", "tsx");
const cli = join(pkgRoot, "src", "paddleBench.ts");
const committedManifest = join(REPO_ROOT, "datasets", "paddle-bench", "paddle-bench.json");

function runPaddleBench(manifest: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(tsxBin, [cli, manifest], {
    cwd: pkgRoot,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 120_000,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function writeManifest(cases: Array<{ id: string; role: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), "paddle-bench-attack-"));
  const manifest = {
    schemaVersion: 1,
    provenance: "licensed",
    cases: cases.map((benchCase) => ({
      id: benchCase.id,
      video: `videos/${benchCase.id}.mp4`,
      labels: `bundles/${benchCase.id}/annotation/devin-visual-v1.json`,
      runDir: `runs/${benchCase.id}`,
      role: benchCase.role,
    })),
  };
  const path = join(dir, "paddle-bench.json");
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return path;
}

describe("S1: paddle-bench refuses ledger-held-out case ids", () => {
  const ledger = loadHoldoutLedger(REPO_ROOT);
  const successorIds = ledger.successors.map((designated) => designated.caseId);
  const retiredIds = ledger.holdouts
    .filter((holdout) => holdout.status === "RETIRED_TO_REGRESSION")
    .map((holdout) => holdout.caseId);

  it("the committed ledger designates at least one SHADOW_HOLDOUT successor (attack precondition)", () => {
    expect(successorIds.length).toBeGreaterThan(0);
    expect(retiredIds.length).toBeGreaterThan(0);
  });

  it("a manifest listing a designated successor as 'dev' exits non-zero before scoring", () => {
    const smuggled = successorIds[0]!;
    const manifest = writeManifest([{ id: smuggled, role: "dev" }]);
    const run = runPaddleBench(manifest);
    expect(run.status, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).not.toBe(0);
    expect(run.stderr).toContain(smuggled);
    expect(run.stderr).toMatch(/held.?out|holdout/i);
    expect(run.stderr).toContain("datasets/holdouts/ledger.json");
    expect(run.stdout).not.toContain("REAL PADDLE BENCHMARK");
  });

  it("a designated successor is refused whatever role the manifest claims", () => {
    for (const role of ["held_out", "test_held_out", "development"]) {
      const manifest = writeManifest([{ id: successorIds[successorIds.length - 1]!, role }]);
      const run = runPaddleBench(manifest);
      expect(run.status, role).not.toBe(0);
      expect(run.stdout, role).not.toContain("REAL PADDLE BENCHMARK");
    }
  });

  it("a retired holdout relabelled as 'development' exits non-zero", () => {
    const manifest = writeManifest([{ id: retiredIds[0]!, role: "development" }]);
    const run = runPaddleBench(manifest);
    expect(run.status, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).not.toBe(0);
    expect(run.stderr).toContain(retiredIds[0]!);
    expect(run.stderr).toMatch(/retired/i);
    expect(run.stdout).not.toContain("REAL PADDLE BENCHMARK");
  });

  it("the committed manifest still scores (retired fixtures declared held out, no successor listed)", () => {
    const committed = JSON.parse(readFileSync(committedManifest, "utf8")) as {
      cases: Array<{ id: string; role: string }>;
    };
    for (const benchCase of committed.cases) {
      expect(successorIds, benchCase.id).not.toContain(benchCase.id);
    }
    // Score from a scratch copy of the manifest whose data dirs link back to
    // the committed ones, so the run's results file lands outside the repo.
    const scratch = mkdtempSync(join(tmpdir(), "paddle-bench-committed-"));
    for (const dir of ["bundles", "runs", "videos"]) {
      symlinkSync(join(dirname(committedManifest), dir), join(scratch, dir), "dir");
    }
    const manifest = join(scratch, "paddle-bench.json");
    writeFileSync(manifest, readFileSync(committedManifest));
    const run = runPaddleBench(manifest);
    expect(run.status, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0);
    expect(run.stdout).toContain("REAL PADDLE BENCHMARK");
  });
});

describe("S1: the label queue's held-out list is the ledger's, not a hand-copied pair", () => {
  it("HELD_OUT_BUNDLES covers every retired holdout and every designated successor", () => {
    const heldOut = loadHeldOutCaseIds(REPO_ROOT);
    expect([...HELD_OUT_BUNDLES].sort()).toEqual([...heldOut.all].sort());
    const ledger = loadHoldoutLedger(REPO_ROOT);
    for (const designated of ledger.successors) {
      expect(HELD_OUT_BUNDLES).toContain(designated.caseId);
    }
    for (const holdout of ledger.holdouts) {
      expect(HELD_OUT_BUNDLES).toContain(holdout.caseId);
    }
  });
});
