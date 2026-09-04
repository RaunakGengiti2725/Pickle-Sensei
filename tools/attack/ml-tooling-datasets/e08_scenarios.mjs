#!/usr/bin/env node
// Adversarial scenarios S4-S7 against packages/swing-lab/test/e08FreshHoldoutGuard.test.ts.
//
// Runs ONLY against a scratch checkout (git worktree) — refuses to touch a tree that is
// the same directory as this script's repo. Every mutation is reverted before the next
// scenario (backup + restore), and the tree is checked clean at the end with git status.
//
// Usage:
//   node tools/attack/ml-tooling-datasets/e08_scenarios.mjs --worktree /path/to/scratch \
//        [--out /path/to/results.json] [--seed 20260904]
//
// Each scenario records: mutation, vitest exit code, failing test names, registry-integrity
// exit code, and a verdict:
//   HELD   = e08 behaved as the guard promises (fails on the tamper it claims to catch)
//   GAP    = e08 passes although the registry/tree is inconsistent (not a promised check)
//   BROKEN = e08 passes although the tamper is one it explicitly claims to catch
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ownRepo = resolve(here, "..", "..", "..");

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const worktree = resolve(arg("--worktree", ""));
const outPath = arg("--out", join(process.cwd(), "e08-scenarios.json"));
const seed = Number(arg("--seed", "20260904"));
if (!worktree || !existsSync(join(worktree, "datasets", "pickleball", "registry.json"))) {
  console.error(
    "--worktree must point at a scratch checkout containing datasets/pickleball/registry.json",
  );
  process.exit(2);
}
if (worktree === ownRepo) {
  console.error(`refusing to mutate the primary checkout ${ownRepo}; pass a scratch worktree`);
  process.exit(2);
}

// xorshift32 — deterministic byte/offset choices, seed recorded in the output.
let rngState = seed >>> 0 || 1;
function rand() {
  rngState ^= rngState << 13;
  rngState >>>= 0;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  rngState >>>= 0;
  return rngState / 0x100000000;
}

const registryPath = join(worktree, "datasets", "pickleball", "registry.json");
const freshDir = join(worktree, "datasets", "pickleball", "fresh-candidates");
const swingLab = join(worktree, "packages", "swing-lab");
const integrityScript = join(here, "registry_integrity.py");

function sh(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runE08() {
  const jsonOut = join(worktree, ".e08-vitest.json");
  rmSync(jsonOut, { force: true });
  const run = sh(
    "npx",
    [
      "vitest",
      "run",
      "test/e08FreshHoldoutGuard.test.ts",
      "--reporter=json",
      `--outputFile=${jsonOut}`,
    ],
    { cwd: swingLab },
  );
  let failed = [];
  let passed = 0;
  if (existsSync(jsonOut)) {
    const report = JSON.parse(readFileSync(jsonOut, "utf8"));
    for (const file of report.testResults ?? []) {
      for (const assertion of file.assertionResults ?? []) {
        if (assertion.status === "failed") failed.push(assertion.title);
        if (assertion.status === "passed") passed += 1;
      }
    }
    rmSync(jsonOut, { force: true });
  }
  return {
    exit: run.code,
    passed,
    failed,
    stderrTail: run.stderr.split("\n").slice(-5).join("\n"),
  };
}

function runIntegrity() {
  const run = sh("python3", [integrityScript, worktree]);
  return {
    exit: run.code,
    violations: run.stdout.split("\n").filter((line) => line.startsWith("VIOLATION")),
  };
}

function gitStatus() {
  return sh("git", ["status", "--porcelain", "--", "datasets"], { cwd: worktree }).stdout.trim();
}

const results = {
  commit: sh("git", ["rev-parse", "HEAD"], { cwd: worktree }).stdout.trim(),
  seed,
  worktree,
  scenarios: [],
};

function record(entry) {
  results.scenarios.push(entry);
  console.log(`\n=== ${entry.id} ${entry.verdict} ===`);
  console.log(JSON.stringify(entry, null, 2));
}

// ---- baseline ---------------------------------------------------------------
{
  const e08 = runE08();
  const integrity = runIntegrity();
  record({
    id: "S0-baseline",
    mutation: "none",
    e08,
    integrity,
    verdict: e08.exit === 0 && integrity.exit === 0 ? "HELD" : "BROKEN",
    note: "clean scratch tree must pass both the guard and the integrity script",
  });
}

// ---- S4: flip one byte of a fresh-candidate mp4 -----------------------------
{
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  const items = registry.freshCandidates.items;
  const item = items[Math.floor(rand() * items.length)];
  const target = join(worktree, item.path);
  const backup = join(worktree, ".attack-bak.mp4");
  copyFileSync(target, backup);
  const size = statSync(target).size;
  const offset = Math.floor(rand() * size);
  const buf = readFileSync(target);
  const before = createHash("sha256").update(buf).digest("hex");
  buf[offset] ^= 0x01;
  writeFileSync(target, buf);
  const after = createHash("sha256").update(readFileSync(target)).digest("hex");
  const e08 = runE08();
  const integrity = runIntegrity();
  renameSync(backup, target);
  const expectFail = "each fresh-candidate file byte-matches its registered sha256";
  record({
    id: "S4-byte-flip-fresh-mp4",
    mutation: `${relative(worktree, target)} byte @${offset} XOR 0x01 (size ${size}); sha ${before.slice(0, 12)} -> ${after.slice(0, 12)}`,
    e08,
    integrity,
    verdict: e08.exit !== 0 && e08.failed.includes(expectFail) ? "HELD" : "BROKEN",
    note: `positive control: expects e08 test "${expectFail}" to fail`,
  });
}

// ---- S5: move a same-channel fresh clip into devPool ------------------------
{
  const original = readFileSync(registryPath, "utf8");
  const registry = JSON.parse(original);
  const fresh = registry.freshCandidates.items;
  const dev = registry.devPool.items;
  const channelOf = (item) => item.uploaderChannelId ?? item.uploader ?? "";
  // Prefer the coordinator's pair (yt-Y7DOO0j_1P4 shares a channel with yt-hktiyFnghIw); if
  // both are still fresh, keep yt-hktiyFnghIw as the holdout and move yt-Y7DOO0j_1P4 to dev.
  const mover = fresh.find((item) => item.id === "yt-Y7DOO0j_1P4") ?? fresh[0];
  const shadow = fresh.find((item) => item.id !== mover.id && channelOf(item) === channelOf(mover));
  const movedFile = join(worktree, mover.path);
  const newRel = mover.path.replace("fresh-candidates/", "dev-pool/");
  const newFile = join(worktree, newRel);
  renameSync(movedFile, newFile);
  registry.freshCandidates.items = fresh.filter((item) => item.id !== mover.id);
  registry.freshCandidates.totalBytes -= mover.media.clipBytes;
  registry.devPool.items = [
    ...dev,
    { ...mover, path: newRel, role: "dev_label_eligible", labelBlind: false },
  ];
  registry.devPool.totalBytes += mover.media.clipBytes;
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n");
  const e08 = runE08();
  const integrity = runIntegrity();
  renameSync(newFile, movedFile);
  writeFileSync(registryPath, original);
  record({
    id: "S5-same-channel-into-devPool",
    mutation: `moved ${mover.id} (channel ${channelOf(mover)}) fresh->dev; shadow holdout kept in fresh: ${shadow?.id ?? "none"}`,
    e08,
    integrity,
    verdict: e08.exit === 0 ? "GAP" : "HELD",
    note: "e08 disjointness is id-only: passing here means channel/session leakage between dev and holdout is not guarded by e08",
    integrityCatches:
      integrity.exit !== 0 && integrity.violations.some((v) => v.includes("pool.channel_disjoint")),
  });
}

// ---- S6: wrong devPool.totalBytes -------------------------------------------
{
  const original = readFileSync(registryPath, "utf8");
  const registry = JSON.parse(original);
  const wrong = registry.devPool.totalBytes + 1 + Math.floor(rand() * 1_000_000);
  const declared = registry.devPool.totalBytes;
  registry.devPool.totalBytes = wrong;
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n");
  const e08 = runE08();
  const integrity = runIntegrity();
  writeFileSync(registryPath, original);
  record({
    id: "S6-wrong-devPool-totalBytes",
    mutation: `devPool.totalBytes ${declared} -> ${wrong}`,
    e08,
    integrity,
    verdict: e08.exit === 0 ? "GAP" : "HELD",
    note: "e08 never reads totalBytes; registry_integrity.py must flag bytes.total",
    integrityCatches:
      integrity.exit !== 0 && integrity.violations.some((v) => v.includes("bytes.total")),
  });
}

// ---- S7: fresh id written into a datasets/**/annotations file ---------------
{
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  const freshId = registry.freshCandidates.items[0].id;
  const annotationDirs = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      if (entry.name === "annotations") annotationDirs.push(full);
      else walk(full);
    }
  };
  walk(join(worktree, "datasets"));
  const targetDir =
    annotationDirs.sort()[0] ?? join(worktree, "datasets", "pickleball", "annotations");
  mkdirSync(targetDir, { recursive: true });
  const leaked = join(targetDir, "attack-leak.json");
  writeFileSync(leaked, JSON.stringify({ clip_id: freshId, technique: "drive_forehand" }) + "\n");
  const e08 = runE08();
  const integrity = runIntegrity();
  rmSync(leaked, { force: true });
  if (!annotationDirs.length) rmSync(targetDir, { recursive: true, force: true });
  record({
    id: "S7-fresh-id-in-annotations-file",
    mutation: `wrote ${relative(worktree, leaked)} containing fresh id ${freshId}`,
    e08,
    integrity,
    verdict: e08.exit === 0 ? "GAP" : "HELD",
    note: "e08 'no fresh id in labeled artifact' only scans ta-bench/cases.json + corpus/{sources,recordings,splits}.json",
    integrityCatches:
      integrity.exit !== 0 && integrity.violations.some((v) => v.includes("fresh.no_labeled_ref")),
    annotationDirsFound: annotationDirs.map((dir) => relative(worktree, dir)),
  });
}

// ---- S7b: fresh id in the corpus file e08 DOES scan (positive control) ------
{
  const corpus = join(worktree, "datasets", "corpus", "recordings.json");
  const original = readFileSync(corpus, "utf8");
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  const freshId = registry.freshCandidates.items[registry.freshCandidates.items.length - 1].id;
  writeFileSync(corpus, original.replace(/\]\s*$/, `]\n// ${freshId}\n`));
  const e08 = runE08();
  writeFileSync(corpus, original);
  record({
    id: "S7b-fresh-id-in-corpus-recordings",
    mutation: `appended fresh id ${freshId} to datasets/corpus/recordings.json`,
    e08,
    verdict:
      e08.exit !== 0 && e08.failed.some((t) => t.includes("fresh-candidate id"))
        ? "HELD"
        : "BROKEN",
    note: "positive control for the labeled-artifact scan e08 does perform",
  });
}

const dirty = gitStatus();
results.treeCleanAfter = dirty === "";
results.gitStatusAfter = dirty;
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(results, null, 2) + "\n");
console.log(`\nwrote ${outPath}; tree clean after restore: ${results.treeCleanAfter}`);
process.exit(results.treeCleanAfter ? 0 : 3);
