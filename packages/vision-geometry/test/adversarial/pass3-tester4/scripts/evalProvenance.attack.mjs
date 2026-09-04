#!/usr/bin/env node
/**
 * ADVERSARIAL PASS 3 / TESTER 4 — S6: bench-provenance hazard.
 *
 *   node packages/vision-geometry/test/adversarial/pass3-tester4/scripts/evalProvenance.attack.mjs [--restore]
 *
 * 1. asserts `git status --porcelain datasets/` is clean BEFORE,
 * 2. runs `pnpm --filter @pickle/vision-geometry eval`,
 * 3. re-checks the porcelain status and compares every tracked dataset file's
 *    blob hash with HEAD,
 * 4. exits 1 (BROKEN) when any tracked artifact under datasets/ is no longer
 *    byte-identical to HEAD; exits 0 (HELD) otherwise.
 *
 * `--restore` writes the HEAD bytes of every dirtied tracked file back (via
 * `git show HEAD:<path>`, never `git checkout`/`git restore`) after the check,
 * so the working tree is left as it was found. Nothing under datasets/ is
 * ever committed or otherwise edited by this script.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "../../../../../..");
const restore = process.argv.includes("--restore");

function git(args) {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8" });
}

function porcelain() {
  return git(["status", "--porcelain", "datasets/"]).replace(/\s+$/, "");
}

function blobHash(path) {
  return git(["hash-object", path]).trim();
}

function headHash(path) {
  return git(["rev-parse", `HEAD:${path}`]).trim();
}

const head = git(["rev-parse", "HEAD"]).trim();
const before = porcelain();
if (before !== "") {
  console.error("PRECONDITION FAILED: datasets/ is already dirty before eval:\n" + before);
  process.exit(2);
}

const evalRun = spawnSync("pnpm", ["--filter", "@pickle/vision-geometry", "eval"], {
  cwd: REPO,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
const evalTail = `${evalRun.stdout}\n${evalRun.stderr}`.trim().split("\n").slice(-8).join("\n");

const after = porcelain();
// porcelain v1: two status columns, a space, then the path.
const dirtied = after
  .split("\n")
  .filter((line) => line.length > 3)
  .map((line) => line.slice(3).trim());

const report = {
  scenario: "S6 eval → git status --porcelain datasets/",
  head,
  evalExitCode: evalRun.status,
  porcelainBefore: before,
  porcelainAfter: after,
  files: dirtied.map((path) => ({
    path,
    headBlob: headHash(path),
    worktreeBlob: blobHash(path),
    byteIdentical: headHash(path) === blobHash(path),
  })),
  verdict: dirtied.length === 0 ? "HELD" : "BROKEN",
};

if (dirtied.length > 0) {
  report.diffStat = git(["diff", "--stat", "--", "datasets/"]).trim();
  report.diff = git(["diff", "--", "datasets/"]);
}

if (restore) {
  for (const path of dirtied) {
    const bytes = execFileSync("git", ["show", `HEAD:${path}`], { cwd: REPO });
    writeFileSync(join(REPO, path), bytes);
  }
  report.restored = dirtied.map((path) => ({
    path,
    byteIdentical: headHash(path) === blobHash(path),
  }));
  report.porcelainAfterRestore = porcelain();
}

console.log(JSON.stringify({ ...report, diff: undefined, evalTail }, null, 2));
if (report.diff) {
  console.log("--- git diff -- datasets/ ---");
  console.log(report.diff);
}
process.exit(report.verdict === "HELD" && evalRun.status === 0 ? 0 : 1);
