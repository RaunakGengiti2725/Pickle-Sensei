/**
 * ATTACK S3 — in a temporary git worktree of THIS repository, rename one
 * committed gold event file and confirm `datasetsInputTreeSha` changes and
 * `bench:compare` emits `CONFOUND provenance.datasetsTreeSha` (exit 0).
 *
 * The worktree is created with `--no-checkout` + a sparse checkout of the one
 * file so it costs milliseconds instead of materialising ~1 GB of datasets.
 * The rename is committed inside the worktree only (detached HEAD); the
 * worktree is removed again in afterAll. The main checkout is never touched.
 *
 * Extra probes on the same fixture:
 *   - a rename confined to `datasets/reports/` must NOT change the sha
 *     (documented exclusion of runner outputs from input provenance);
 *   - an uncommitted rename must NOT change the sha (HEAD-based) but must
 *     surface as an untracked dataset input / dirty tree.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  datasetsInputTreeSha,
  isTreeDirty,
  untrackedDatasetInputs,
} from "../../src/regression/run.js";
import { summary } from "../regressionFixtures.js";
import { REPO_ROOT, git, makeTempDir, runCli, writeEvidence } from "./attackUtil.js";

const GOLD_FILE =
  "datasets/paddle-bench/bundles/wavea-marne-serve/annotation/devin-visual-v4-waveD2-events.json";
const RENAMED = GOLD_FILE.replace("devin-visual-v4-waveD2-events.json", "renamed-events.json");
const REPORT_FILE = "datasets/reports/regression/README.md";

function commit(root: string, message: string): string {
  git(
    [
      "-c",
      "user.name=attack",
      "-c",
      "user.email=attack@example.invalid",
      "commit",
      "-q",
      "-m",
      message,
    ],
    root,
  );
  return git(["rev-parse", "HEAD"], root);
}

function summaryWithTree(treeSha: string, gitSha: string, runId: string) {
  return summary({
    runId,
    provenance: { ...summary().provenance, gitSha, datasetsTreeSha: treeSha },
  });
}

describe("S3: rename one committed gold event file in a temp worktree", () => {
  let worktree = "";
  let scratch = "";
  const mainTreeSha = datasetsInputTreeSha(REPO_ROOT);
  const mainGitSha = git(["rev-parse", "HEAD"], REPO_ROOT);

  beforeAll(() => {
    scratch = makeTempDir("attack-s3-out");
    worktree = join(makeTempDir("attack-s3-worktree"), "wt");
    git(["worktree", "add", "--detach", "--no-checkout", worktree, "HEAD"], REPO_ROOT);
    git(["sparse-checkout", "set", "--no-cone", GOLD_FILE, REPORT_FILE], worktree);
    git(["checkout", "--quiet", "HEAD"], worktree);
    expect(existsSync(join(worktree, GOLD_FILE))).toBe(true);
  });

  afterAll(() => {
    if (worktree) {
      git(["worktree", "remove", "--force", worktree], REPO_ROOT);
      git(["worktree", "prune"], REPO_ROOT);
    }
    expect(git(["status", "--porcelain", "--", "datasets"], REPO_ROOT)).toBe("");
  });

  it("precondition: the sparse worktree reproduces the main checkout's datasets tree sha", () => {
    expect(git(["ls-files", "--", GOLD_FILE], REPO_ROOT)).toBe(GOLD_FILE);
    expect(datasetsInputTreeSha(worktree)).toBe(mainTreeSha);
  });

  it("an UNCOMMITTED rename leaves the HEAD-based sha unchanged but is visible as dirty + untracked input", () => {
    git(["mv", "--sparse", GOLD_FILE, RENAMED], worktree);
    // git mv stages the rename; un-stage to model a raw filesystem rename.
    git(["reset", "-q", "--", GOLD_FILE, RENAMED], worktree);
    expect(datasetsInputTreeSha(worktree)).toBe(mainTreeSha);
    expect(isTreeDirty(worktree)).toBe(true);
    expect(untrackedDatasetInputs(worktree)).toContain(RENAMED);
    git(["add", "--sparse", "-A", "--", "datasets/paddle-bench"], worktree);
  });

  it("the COMMITTED rename changes datasetsTreeSha and compare emits CONFOUND provenance.datasetsTreeSha with exit 0", () => {
    const renamedGitSha = commit(worktree, "attack: rename gold event file");
    expect(git(["ls-files", "--", RENAMED], worktree)).toBe(RENAMED);
    const renamedTreeSha = datasetsInputTreeSha(worktree);
    expect(renamedTreeSha).not.toBe(mainTreeSha);

    const basePath = join(scratch, "baseline.json");
    const candPath = join(scratch, "candidate.json");
    writeFileSync(basePath, JSON.stringify(summaryWithTree(mainTreeSha, mainGitSha, "baseline")));
    writeFileSync(
      candPath,
      JSON.stringify(summaryWithTree(renamedTreeSha, renamedGitSha, "candidate")),
    );
    const human = runCli(["compare", basePath, candPath]);
    const json = runCli(["compare", basePath, candPath, "--json"]);
    const report = JSON.parse(json.stdout) as { exitCode: number; warnings: string[] };
    expect(json.exitCode).toBe(0);
    expect(human.exitCode).toBe(0);
    expect(report.warnings.some((w) => w.startsWith("CONFOUND provenance.datasetsTreeSha"))).toBe(
      true,
    );
    expect(human.stdout).toContain("CONFOUND provenance.datasetsTreeSha");
    writeEvidence("s3-gold-rename-tree-sha", {
      scenario: "S3",
      classification: "HELD",
      renamed: { from: GOLD_FILE, to: RENAMED },
      mainTreeSha,
      renamedTreeSha,
      exitCode: json.exitCode,
      warnings: report.warnings,
      humanReport: human.stdout,
    });
  });

  it("a rename confined to datasets/reports/ does NOT move the input tree sha (outputs are excluded)", () => {
    const before = datasetsInputTreeSha(worktree);
    git(["mv", "--sparse", REPORT_FILE, "datasets/reports/regression/README-renamed.md"], worktree);
    commit(worktree, "attack: rename a report file only");
    expect(datasetsInputTreeSha(worktree)).toBe(before);
  });
});
