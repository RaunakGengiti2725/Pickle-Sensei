#!/usr/bin/env node
/**
 * Launch-gate mutation runner.
 *
 *   node tools/mutation/launch-gate/run.mjs [--suite full|targeted]
 *        [--only ID[,ID...]] [--skip-tsc] [--run-id NAME] [--out DIR]
 *        [--extra-tests GLOB[,GLOB...]] [--ignore-tests REGEX[,REGEX...]]
 *        [--check] [--rebuild DIR]
 *
 * --ignore-tests passes Jest `--testPathIgnorePatterns` — use it to replay the
 * PRE-pin matrix after new pins exist (e.g. `--ignore-tests __tests__/mutation`).
 * --extra-tests is only meaningful with `--suite targeted`: Jest treats every
 * positional path as a filter, so combining it with `full` would silently
 * shrink the run to just those files — the runner refuses that combination.
 *
 * --check only verifies every mutant still applies to the current tree and
 * writes the diffs (no tests run; result `applies`). --rebuild DIR re-derives
 * matrix.json/matrix.md of a finished run from its raw <ID>.jest.json files.
 *
 * For every mutant in mutants.mjs: refuse to start on a dirty tree, apply the
 * exact-match substitution(s) to the production file, run `npx tsc --noEmit`
 * (unless --skip-tsc) and the mobile Jest suite (`npx jest --ci --silent
 * --json`), then restore the ORIGINAL BYTES read before mutation and re-check
 * the tree is clean. Classification:
 *
 *   killed          — jest exit != 0 (list of failing suites/tests recorded)
 *   survived        — jest exit 0 with the mutant applied
 *   failed_to_apply — a `find` string was absent or ambiguous; nothing ran
 *   error           — the runner itself failed (recorded, never a pass)
 *
 * `tsc` is recorded separately (`tscExit`): a mutant that only fails the type
 * check is still `survived` for Jest — babel-jest strips types, so a type
 * error alone would not stop the mutated app from running.
 *
 * Output (all under --out, default artifacts/mutation/launch-gate/<run-id>/):
 *   matrix.json          — one row per mutant, full classification + evidence
 *   matrix.md            — human table of the same
 *   <ID>.jest.json       — raw Jest --json result for that mutant
 *   <ID>.jest.log        — raw Jest stdout+stderr
 *   <ID>.tsc.log         — raw tsc output
 *   <ID>.diff            — the applied mutation as a unified diff (replayable)
 *   run.json             — run metadata (HEAD sha, node, jest cmd, timings)
 *
 * Replay one mutant exactly: `--only <ID>` (same suite flag). An entry may be
 * the full id (`LG06-device-history-default-arg`) or just its short code
 * (`LG06`) — the part before the first `-`. Nothing here calls git for
 * anything but read-only status/rev-parse.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MUTANTS } from "./mutants.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const mobileDir = path.join(repoRoot, "apps", "mobile");

/** Suites that pin the launch gate directly — a fast inner loop. The `full`
 * suite is the repository's canonical mobile command and is what the report
 * classifies on. */
export const TARGETED_SUITES = [
  "__tests__/launchGate.test.ts",
  "__tests__/onboardingScreen.test.tsx",
  "__tests__/appStorePreAuthOnboarding.test.ts",
  "__tests__/onboardingAccount.test.ts",
  "__tests__/wf/flow-launch-onboarding-gate.test.tsx",
  "__tests__/wf/flow-launch-onboarding-screen.test.tsx",
  "__tests__/wf/flow-launch-onboarding-splash-welcome.test.tsx",
  "__tests__/wf/App.buttons.test.tsx",
  "__tests__/wf/WelcomeScreen.buttons.test.tsx",
  "__tests__/wf/OnboardingScreen.buttons.test.tsx",
  "__tests__/wf/fix-6-gateLoadingAndErrorBoundary.test.tsx",
];

function parseArgs(argv) {
  const args = {
    suite: "full",
    only: null,
    skipTsc: false,
    check: false,
    rebuild: null,
    runId: new Date().toISOString().replace(/[:.]/g, "-"),
    out: null,
    extraTests: [],
    ignoreTests: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[i];
    };
    if (a === "--suite") args.suite = next();
    else if (a === "--only") args.only = next().split(",").filter(Boolean);
    else if (a === "--skip-tsc") args.skipTsc = true;
    else if (a === "--check") args.check = true;
    else if (a === "--rebuild") args.rebuild = next();
    else if (a === "--run-id") args.runId = next();
    else if (a === "--out") args.out = next();
    else if (a === "--extra-tests") args.extraTests = next().split(",").filter(Boolean);
    else if (a === "--ignore-tests") args.ignoreTests = next().split(",").filter(Boolean);
    else throw new Error(`unknown argument ${a}`);
  }
  if (args.suite !== "full" && args.suite !== "targeted") {
    throw new Error(`--suite must be full|targeted, got ${args.suite}`);
  }
  if (args.suite === "full" && args.extraTests.length > 0) {
    throw new Error(
      "--extra-tests narrows Jest to those paths; with --suite full it would NOT run the full suite. Drop it (full already discovers every __tests__ file) or use --suite targeted.",
    );
  }
  args.out = args.out ?? path.join(repoRoot, "artifacts", "mutation", "launch-gate", args.runId);
  return args;
}

function git(...argv) {
  const r = spawnSync("git", argv, { cwd: repoRoot, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${argv.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** Production files this harness is allowed to mutate — anything else dirty
 * in the tree is fine (e.g. new harness files), but these must be pristine. */
function assertMutationTargetsClean(files) {
  const status = git("status", "--porcelain", "--", ...files);
  if (status !== "") {
    throw new Error(`refusing to mutate: production targets are dirty:\n${status}`);
  }
}

/** Unified diff of the mutation via `diff -u` on two scratch copies. */
function unifiedDiff(relFile, originalText, mutatedText, scratchDir) {
  const a = path.join(scratchDir, "a.tmp");
  const b = path.join(scratchDir, "b.tmp");
  fs.writeFileSync(a, originalText);
  fs.writeFileSync(b, mutatedText);
  const r = spawnSync("diff", ["-u", "--label", `a/${relFile}`, "--label", `b/${relFile}`, a, b], {
    encoding: "utf8",
  });
  fs.rmSync(a);
  fs.rmSync(b);
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(`diff failed: ${r.stderr}`);
  }
  return r.stdout;
}

function occurrences(haystack, needle) {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function applyEdits(original, edits) {
  let text = original;
  for (const [i, edit] of edits.entries()) {
    const n = occurrences(text, edit.find);
    if (n !== 1) {
      return {
        ok: false,
        reason: `edit #${i + 1}: expected exactly 1 occurrence of find-string, got ${n}`,
      };
    }
    text = text.replace(edit.find, () => edit.replace);
  }
  if (text === original) return { ok: false, reason: "mutation is a no-op" };
  return { ok: true, text };
}

function run(cmd, argv, cwd, logPath) {
  const started = Date.now();
  const r = spawnSync(cmd, argv, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
  });
  const out = `$ ${cmd} ${argv.join(" ")}\n(cwd ${cwd})\n\n${r.stdout ?? ""}\n${r.stderr ?? ""}\n\nexit ${r.status}\n`;
  fs.writeFileSync(logPath, out);
  return { status: r.status, ms: Date.now() - started };
}

function summarizeJest(jsonPath) {
  if (!fs.existsSync(jsonPath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  } catch {
    return null;
  }
  const failingSuites = [];
  const failingTests = [];
  for (const suite of parsed.testResults ?? []) {
    const rel = path.relative(mobileDir, suite.name);
    if (suite.status === "failed") failingSuites.push(rel);
    for (const t of suite.assertionResults ?? []) {
      if (t.status === "failed") {
        failingTests.push(`${rel} :: ${t.fullName}`);
      }
    }
    if (suite.status === "failed" && (suite.assertionResults ?? []).length === 0) {
      failingTests.push(
        `${rel} :: <suite failed to run: ${String(suite.message ?? "").split("\n")[0]}>`,
      );
    }
  }
  return {
    numTotalTests: parsed.numTotalTests,
    numPassedTests: parsed.numPassedTests,
    numFailedTests: parsed.numFailedTests,
    numTotalTestSuites: parsed.numTotalTestSuites,
    numFailedTestSuites: parsed.numFailedTestSuites,
    success: parsed.success,
    failingSuites,
    failingTests,
  };
}

function jestArgs(args, outputFile) {
  const argv = ["jest", "--ci", "--silent", "--json", `--outputFile=${outputFile}`];
  if (args.suite === "targeted") argv.push(...TARGETED_SUITES);
  argv.push(...args.extraTests);
  if (args.ignoreTests.length > 0) {
    argv.push("--testPathIgnorePatterns", ...args.ignoreTests);
  }
  return argv;
}

function writeMarkdown(rows, meta, mdPath) {
  const lines = [];
  lines.push(`# Launch-gate mutation matrix — ${meta.runId}`);
  lines.push("");
  lines.push(`- HEAD: \`${meta.head}\``);
  lines.push(`- suite: \`${meta.suite}\`  · jest: \`${meta.jestCommand}\``);
  lines.push(`- node: \`${meta.node}\`  · started: ${meta.startedAt}  · wall: ${meta.wallMs} ms`);
  lines.push("");
  const counts = rows.reduce((acc, r) => {
    acc[r.result] = (acc[r.result] ?? 0) + 1;
    return acc;
  }, {});
  lines.push(
    `**killed ${counts.killed ?? 0} · survived ${counts.survived ?? 0} · failed_to_apply ${counts.failed_to_apply ?? 0} · error ${counts.error ?? 0}** (of ${rows.length})`,
  );
  lines.push("");
  lines.push("| id | class | result | tsc | jest failed tests | killed by (suites) | title |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const r of rows) {
    const tsc = r.tscExit === null ? "skipped" : r.tscExit === 0 ? "ok" : `exit ${r.tscExit}`;
    const failed = r.jest ? `${r.jest.numFailedTests}/${r.jest.numTotalTests}` : "—";
    const by = r.jest
      ? r.jest.failingSuites.map((s) => `\`${s}\``).join("<br>")
      : (r.reason ?? "—");
    lines.push(
      `| ${r.id} | ${r.cls} | **${r.result}** | ${tsc} | ${failed} | ${by} | ${r.title.replace(/\|/g, "\\|")} |`,
    );
  }
  lines.push("");
  fs.writeFileSync(mdPath, lines.join("\n"));
}

/** Re-derive matrix.json / matrix.md from the raw per-mutant artifacts of a
 * finished run (no tests re-run). */
function rebuild(outDir) {
  const matrixPath = path.join(outDir, "matrix.json");
  const prior = JSON.parse(fs.readFileSync(matrixPath, "utf8"));
  const rows = prior.mutants.map((row) => {
    const jestJson = row.artifacts?.jestJson ? path.join(repoRoot, row.artifacts.jestJson) : null;
    const jest = jestJson ? summarizeJest(jestJson) : null;
    return { ...row, jest: jest ?? row.jest };
  });
  const meta = { ...prior.meta, rebuiltAt: new Date().toISOString() };
  fs.writeFileSync(matrixPath, JSON.stringify({ meta, mutants: rows }, null, 2));
  writeMarkdown(rows, meta, path.join(outDir, "matrix.md"));
  process.stderr.write(`rebuilt ${path.relative(repoRoot, matrixPath)}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.rebuild) {
    rebuild(path.resolve(repoRoot, args.rebuild));
    return;
  }
  fs.mkdirSync(args.out, { recursive: true });
  const head = git("rev-parse", "HEAD");
  const startedAt = new Date().toISOString();
  const wallStart = Date.now();

  const shortCode = (id) => id.split("-")[0];
  const matchesOnly = (m, wanted) => m.id === wanted || shortCode(m.id) === wanted;
  const selected = args.only
    ? MUTANTS.filter((m) => args.only.some((wanted) => matchesOnly(m, wanted)))
    : MUTANTS;
  if (args.only) {
    const missing = args.only.filter((wanted) => !MUTANTS.some((m) => matchesOnly(m, wanted)));
    if (missing.length) throw new Error(`unknown mutant id(s): ${missing.join(", ")}`);
  }
  const ids = new Set();
  for (const m of MUTANTS) {
    if (ids.has(m.id)) throw new Error(`duplicate mutant id ${m.id}`);
    ids.add(m.id);
  }

  const targets = [...new Set(MUTANTS.map((m) => m.file))];
  assertMutationTargetsClean(targets);

  const jestCommand = `npx ${jestArgs(args, "<out>/<ID>.jest.json").join(" ")}`;
  const rows = [];

  for (const m of selected) {
    const absFile = path.join(repoRoot, m.file);
    const original = fs.readFileSync(absFile);
    const originalText = original.toString("utf8");
    const row = {
      id: m.id,
      cls: m.cls,
      file: m.file,
      title: m.title,
      expected: m.expected,
      result: "error",
      reason: null,
      tscExit: null,
      tscMs: null,
      jestExit: null,
      jestMs: null,
      jest: null,
      artifacts: {},
    };
    process.stderr.write(`\n▶ ${m.id} — ${m.title}\n`);
    const applied = applyEdits(originalText, m.edits);
    if (!applied.ok) {
      row.result = "failed_to_apply";
      row.reason = applied.reason;
      rows.push(row);
      process.stderr.write(`  ✗ failed_to_apply: ${applied.reason}\n`);
      continue;
    }
    const diffPath = path.join(args.out, `${m.id}.diff`);
    fs.writeFileSync(diffPath, unifiedDiff(m.file, originalText, applied.text, args.out));
    row.artifacts.diff = path.relative(repoRoot, diffPath);
    if (args.check) {
      row.result = "applies";
      rows.push(row);
      process.stderr.write(`  ✓ applies (${m.edits.length} edit(s))\n`);
      continue;
    }
    try {
      fs.writeFileSync(absFile, applied.text);
      if (!args.skipTsc) {
        const tscLog = path.join(args.out, `${m.id}.tsc.log`);
        const tsc = run("npx", ["tsc", "--noEmit"], mobileDir, tscLog);
        row.tscExit = tsc.status;
        row.tscMs = tsc.ms;
        row.artifacts.tscLog = path.relative(repoRoot, tscLog);
      }
      const jestJson = path.join(args.out, `${m.id}.jest.json`);
      const jestLog = path.join(args.out, `${m.id}.jest.log`);
      const jest = run("npx", jestArgs(args, jestJson), mobileDir, jestLog);
      row.jestExit = jest.status;
      row.jestMs = jest.ms;
      row.jest = summarizeJest(jestJson);
      row.artifacts.jestJson = path.relative(repoRoot, jestJson);
      row.artifacts.jestLog = path.relative(repoRoot, jestLog);
      if (jest.status === 0 && row.jest?.success === true) row.result = "survived";
      else if (jest.status !== 0 || row.jest?.success === false) row.result = "killed";
      else {
        row.result = "error";
        row.reason = "jest produced no parseable --json result";
      }
    } catch (error) {
      row.result = "error";
      row.reason = error instanceof Error ? error.message : String(error);
    } finally {
      fs.writeFileSync(absFile, original);
      const restored = fs.readFileSync(absFile);
      if (!restored.equals(original)) {
        throw new Error(`restore failed for ${m.file}; tree is NOT clean`);
      }
    }
    assertMutationTargetsClean(targets);
    rows.push(row);
    process.stderr.write(
      `  ${row.result === "killed" ? "☠" : row.result === "survived" ? "⚠ SURVIVED" : "✗"} ${row.result}` +
        (row.jest
          ? ` — ${row.jest.numFailedTests} failing test(s) in ${row.jest.failingSuites.length} suite(s)`
          : "") +
        (row.tscExit !== null ? ` · tsc exit ${row.tscExit}` : "") +
        "\n",
    );
  }

  const meta = {
    runId: args.runId,
    head,
    suite: args.suite,
    jestCommand,
    node: process.version,
    startedAt,
    finishedAt: new Date().toISOString(),
    wallMs: Date.now() - wallStart,
    only: args.only,
    skipTsc: args.skipTsc,
    extraTests: args.extraTests,
    totals: rows.reduce((acc, r) => {
      acc[r.result] = (acc[r.result] ?? 0) + 1;
      return acc;
    }, {}),
  };
  fs.writeFileSync(path.join(args.out, "run.json"), JSON.stringify(meta, null, 2));
  fs.writeFileSync(
    path.join(args.out, "matrix.json"),
    JSON.stringify({ meta, mutants: rows }, null, 2),
  );
  writeMarkdown(rows, meta, path.join(args.out, "matrix.md"));
  process.stderr.write(`\n${JSON.stringify(meta.totals)} → ${path.relative(repoRoot, args.out)}\n`);
  const survivors = rows.filter((r) => r.result !== "killed");
  process.exitCode = survivors.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 2;
  });
}
