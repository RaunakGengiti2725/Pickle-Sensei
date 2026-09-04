#!/usr/bin/env node
// Mutation-testing harness for the analysis pipeline + scoring chain.
//
// For every mutant in mutants.json this script:
//   1. materialises a pristine copy of HEAD in a throwaway git worktree under
//      /tmp (node_modules are copied in; pnpm workspace links are relative so
//      they resolve inside the copy) — the checked-out repository is never
//      written to;
//   2. applies the mutant's exact-string edits (each anchor must match exactly
//      `count` times, otherwise the mutant is refused as "anchor drift");
//   3. runs `tsc` for the mutated package, `vitest run` (JSON reporter) for
//      every package in `testPackages`, then the canonical regression bench
//      (`bench:regression`) and `bench:compare` against the committed baseline;
//   4. restores the pristine file bytes and records exit codes, failing test
//      ids, comparator regressions/improvements and wall-clock per stage.
//
// Output: <out>/results.json (machine table), <out>/matrix.md (human table),
// <out>/<MUTANT_ID>/{mutant.diff,typecheck.log,vitest-*.json,vitest-*.log,
// bench.log,compare.json,compare.txt,bench/<id>.json}.
//
// Usage:
//   node tools/mutation-pipeline-scoring/run.mjs [--only ID[,ID]] [--with-pins]
//        [--pins-only] [--skip-tests] [--skip-bench] [--skip-typecheck]
//        [--tree DIR] [--out DIR] [--keep-tree] [--merge] [--list]
//
//   --with-pins  copies the new `pinTests` files into the worktree so they run
//                alongside the existing suites (they are never written to the
//                checked-out repository's history by this script).
//   --pins-only  implies --with-pins and runs ONLY the pin files (fast loop for
//                confirming that a pin kills the mutant it targets).
//   --merge      with --only: keep the other mutants' rows from an existing
//                <out>/results.json and replace only the rerun ids (used to
//                re-execute a corrected mutant spec inside a finished table).
//
// Replay a single mutant exactly as recorded in results.json:
//   node tools/mutation-pipeline-scoring/run.mjs --only SEG-02
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const MUTANTS_PATH = join(HERE, "mutants.json");
const DEFAULT_TREE = "/tmp/mutation-pipeline-scoring/tree";
const DEFAULT_OUT = "/tmp/mutation-pipeline-scoring/out";
const BASELINE_REL = "datasets/reports/regression/baseline.json";

function parseArgs(argv) {
  const args = {
    only: null,
    withPins: false,
    pinsOnly: false,
    skipTests: false,
    skipBench: false,
    skipTypecheck: false,
    tree: DEFAULT_TREE,
    out: DEFAULT_OUT,
    keepTree: false,
    merge: false,
    list: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--only":
        args.only = new Set(
          next()
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        );
        break;
      case "--with-pins":
        args.withPins = true;
        break;
      case "--pins-only":
        args.withPins = true;
        args.pinsOnly = true;
        break;
      case "--skip-tests":
        args.skipTests = true;
        break;
      case "--skip-bench":
        args.skipBench = true;
        break;
      case "--skip-typecheck":
        args.skipTypecheck = true;
        break;
      case "--tree":
        args.tree = resolve(next());
        break;
      case "--out":
        args.out = resolve(next());
        break;
      case "--keep-tree":
        args.keepTree = true;
        break;
      case "--merge":
        args.merge = true;
        break;
      case "--list":
        args.list = true;
        break;
      case "--help":
      case "-h":
        process.stdout.write(
          readFileSync(fileURLToPath(import.meta.url), "utf8").split("import {")[0],
        );
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument ${arg}`);
    }
  }
  return args;
}

function log(message) {
  process.stderr.write(`[mutation] ${new Date().toISOString()} ${message}\n`);
}

function run(cmd, cmdArgs, { cwd, logPath, env } = {}) {
  const started = Date.now();
  const result = spawnSync(cmd, cmdArgs, {
    cwd,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  const wallMs = Date.now() - started;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (logPath) {
    writeFileSync(
      logPath,
      `$ (cd ${cwd ?? process.cwd()} && ${[cmd, ...cmdArgs].join(" ")})\n` +
        `exit=${result.status} signal=${result.signal ?? ""} wallMs=${wallMs}\n` +
        `----- stdout -----\n${stdout}\n----- stderr -----\n${stderr}\n`,
    );
  }
  return {
    command: [cmd, ...cmdArgs].join(" "),
    cwd,
    exitCode: result.status,
    signal: result.signal ?? null,
    error: result.error ? String(result.error) : null,
    stdout,
    stderr,
    wallMs,
  };
}

function git(args, cwd = REPO_ROOT, { raw = false } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr.trim()}`);
  }
  return raw ? result.stdout : result.stdout.trim();
}

function loadMutants() {
  const spec = JSON.parse(readFileSync(MUTANTS_PATH, "utf8"));
  const ids = new Set();
  for (const mutant of spec.mutants) {
    if (ids.has(mutant.id)) throw new Error(`duplicate mutant id ${mutant.id}`);
    ids.add(mutant.id);
    if (!Array.isArray(mutant.edits)) throw new Error(`${mutant.id}: edits must be an array`);
    for (const edit of mutant.edits) {
      if (typeof edit.find !== "string" || typeof edit.replace !== "string") {
        throw new Error(`${mutant.id}: every edit needs string find/replace`);
      }
      if (edit.find === edit.replace) throw new Error(`${mutant.id}: find === replace`);
    }
  }
  return spec;
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** Return {ok, text, problems}: the mutated text or a list of anchor problems. */
function applyEdits(original, edits, mutantId) {
  let text = original;
  const problems = [];
  for (const [i, edit] of edits.entries()) {
    const expected = edit.count ?? 1;
    const found = countOccurrences(text, edit.find);
    if (found !== expected) {
      problems.push(
        `${mutantId} edit[${i}]: anchor matched ${found}x, expected ${expected}x: ${JSON.stringify(edit.find.slice(0, 80))}`,
      );
      continue;
    }
    text = text.split(edit.find).join(edit.replace);
  }
  if (problems.length > 0) return { ok: false, text: original, problems };
  if (text === original && edits.length > 0) {
    problems.push(`${mutantId}: edits produced no change`);
    return { ok: false, text: original, problems };
  }
  return { ok: true, text, problems };
}

function listNodeModuleDirs(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (entry.name === "node_modules") {
        out.push(full);
        continue;
      }
      // apps/mobile is npm-managed and irrelevant to the bench; skip it.
      if (relative(root, full) === "apps/mobile") continue;
      walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

function ensureTree(tree, headSha) {
  const marker = join(tree, ".mutation-tree.json");
  if (existsSync(marker)) {
    const existing = JSON.parse(readFileSync(marker, "utf8"));
    if (existing.headSha === headSha) {
      log(`reusing worktree ${tree} @ ${headSha.slice(0, 12)}`);
      return;
    }
    log(
      `worktree ${tree} is at ${existing.headSha.slice(0, 12)}; rebuilding for ${headSha.slice(0, 12)}`,
    );
    removeTree(tree);
  } else if (existsSync(tree)) {
    throw new Error(`${tree} exists but is not a mutation worktree; refusing to touch it`);
  }
  mkdirSync(dirname(tree), { recursive: true });
  log(`git worktree add --detach ${tree} ${headSha.slice(0, 12)}`);
  git(["worktree", "add", "--detach", tree, headSha]);
  const dirs = listNodeModuleDirs(REPO_ROOT);
  log(`copying ${dirs.length} node_modules directories into the worktree`);
  for (const dir of dirs) {
    const rel = relative(REPO_ROOT, dir);
    const target = join(tree, rel);
    mkdirSync(dirname(target), { recursive: true });
    const cp = spawnSync("cp", ["-a", dir, target], { encoding: "utf8" });
    if (cp.status !== 0) throw new Error(`cp -a ${rel} failed: ${cp.stderr}`);
  }
  writeFileSync(marker, JSON.stringify({ headSha, createdAt: new Date().toISOString() }, null, 2));
}

function removeTree(tree) {
  const pruned = spawnSync("git", ["worktree", "remove", "--force", tree], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (pruned.status !== 0) {
    rmSync(tree, { recursive: true, force: true });
    spawnSync("git", ["worktree", "prune"], { cwd: REPO_ROOT, encoding: "utf8" });
  }
}

function copyPins(tree, pins) {
  const copied = [];
  for (const rel of pins) {
    const src = join(REPO_ROOT, rel);
    if (!existsSync(src)) {
      log(`WARNING: pin test ${rel} does not exist in the repository; skipping it`);
      continue;
    }
    const dst = join(tree, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    copied.push(rel);
  }
  return copied;
}

function removePins(tree, pins) {
  for (const rel of pins) rmSync(join(tree, rel), { force: true });
}

/** `packages/<name>/test/x.test.ts` -> Map("@pickle/<name>" -> ["test/x.test.ts"]). */
function pinFilesByPackage(pins) {
  const byPackage = new Map();
  for (const rel of pins) {
    const match = /^packages\/([^/]+)\/(.+)$/.exec(rel);
    if (!match) throw new Error(`pin test ${rel} is not under packages/<name>/`);
    const pkg = `@pickle/${match[1]}`;
    if (!byPackage.has(pkg)) byPackage.set(pkg, []);
    byPackage.get(pkg).push(match[2]);
  }
  return byPackage;
}

function parseVitestJson(path) {
  if (!existsSync(path)) return null;
  const report = JSON.parse(readFileSync(path, "utf8"));
  const failures = [];
  for (const file of report.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      if (assertion.status === "failed") {
        failures.push({
          file: relative(REPO_ROOT, file.name).replace(/^\.\.\/+/, ""),
          fullName: assertion.fullName,
          message: (assertion.failureMessages ?? []).join("\n").split("\n")[0]?.slice(0, 300) ?? "",
        });
      }
    }
    if (file.status === "failed" && (file.assertionResults ?? []).length === 0) {
      failures.push({
        file: file.name,
        fullName: "<suite failed to load>",
        message: (file.message ?? "").split("\n")[0]?.slice(0, 300) ?? "",
      });
    }
  }
  return {
    success: report.success === true,
    numTotalTests: report.numTotalTests ?? null,
    numPassedTests: report.numPassedTests ?? null,
    numFailedTests: report.numFailedTests ?? null,
    numPendingTests: report.numPendingTests ?? null,
    numFailedTestSuites: report.numFailedTestSuites ?? null,
    failures,
  };
}

function summariseCompare(comparePath) {
  if (!existsSync(comparePath)) return null;
  let report;
  try {
    report = JSON.parse(readFileSync(comparePath, "utf8"));
  } catch (error) {
    return { parseError: String(error) };
  }
  const metricDeltas = (report.metrics ?? [])
    .filter((m) => m.failing === true || m.baseline !== m.candidate)
    .map((m) => ({
      metric: m.metric,
      baseline: m.baseline ?? null,
      candidate: m.candidate ?? null,
      delta: m.delta ?? null,
      status: m.status,
      failing: m.failing === true,
    }));
  return {
    comparable: report.comparable,
    exitCode: report.exitCode,
    regressions: report.regressions ?? [],
    improvements: report.improvements ?? [],
    warnings: report.warnings ?? [],
    benchStatuses: (report.benches ?? []).map((b) => ({ benchId: b.benchId, status: b.status })),
    metricDeltas,
    candidateProvenance: report.candidate?.provenance ?? null,
  };
}

function classify(result) {
  const killers = [];
  if (result.typecheck && result.typecheck.exitCode !== 0) killers.push("typecheck");
  const unitFailed = Object.values(result.unitTests ?? {}).some(
    (entry) => entry.exitCode !== 0 || (entry.report && entry.report.success !== true),
  );
  if (unitFailed) killers.push("unit_tests");
  if (result.bench) {
    if (result.bench.regressionExitCode !== 0) killers.push("bench_regression_crashed");
    else if (result.bench.compareExitCode === 1) killers.push("bench_compare");
    else if (result.bench.compareExitCode === 3) killers.push("bench_compare_non_comparable");
    else if (result.bench.compareExitCode !== 0)
      killers.push(`bench_compare_exit_${result.bench.compareExitCode}`);
  }
  return {
    killed: killers.length > 0,
    killedBy: killers,
    unitTestsKill: killers.includes("unit_tests"),
    benchKill: killers.some((k) => k.startsWith("bench")),
    typecheckKill: killers.includes("typecheck"),
  };
}

function runMutant(spec, mutant, ctx) {
  const { tree, out, args } = ctx;
  const mutantOut = join(out, mutant.id);
  rmSync(mutantOut, { recursive: true, force: true });
  mkdirSync(mutantOut, { recursive: true });
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const result = {
    id: mutant.id,
    category: mutant.category,
    package: mutant.package,
    file: mutant.file,
    description: mutant.description,
    edits: mutant.edits,
    replay: `node tools/mutation-pipeline-scoring/run.mjs --only ${mutant.id}${args.pinsOnly ? " --pins-only" : args.withPins ? " --with-pins" : ""}`,
    startedAt,
    applied: false,
    anchorProblems: [],
    lineNumbers: [],
    typecheck: null,
    unitTests: {},
    bench: null,
    artifacts: { dir: mutantOut },
    classification: null,
    wallMs: null,
  };

  const treeFile = join(tree, mutant.file);
  const original = readFileSync(treeFile, "utf8");
  const pristine = git(["show", `${ctx.headSha}:${mutant.file}`], REPO_ROOT, { raw: true });
  if (original !== pristine) {
    throw new Error(`${mutant.file} in the worktree is not pristine before ${mutant.id}; aborting`);
  }
  const applied = applyEdits(original, mutant.edits, mutant.id);
  if (!applied.ok) {
    result.anchorProblems = applied.problems;
    result.classification = { killed: false, killedBy: [], refused: true };
    result.wallMs = Date.now() - started;
    log(`${mutant.id}: REFUSED (${applied.problems.join("; ")})`);
    return result;
  }
  for (const edit of mutant.edits) {
    let index = original.indexOf(edit.find);
    while (index !== -1) {
      result.lineNumbers.push(original.slice(0, index).split("\n").length);
      index = original.indexOf(edit.find, index + edit.find.length);
    }
  }
  result.lineNumbers.sort((a, b) => a - b);

  let restoreError = null;
  try {
    writeFileSync(treeFile, applied.text);
    result.applied = true;
    const diff = spawnSync("git", ["diff", "--", mutant.file], { cwd: tree, encoding: "utf8" });
    writeFileSync(join(mutantOut, "mutant.diff"), diff.stdout);

    if (!args.skipTypecheck && mutant.edits.length > 0) {
      log(`${mutant.id}: typecheck ${mutant.package}`);
      const tc = run("pnpm", ["-s", "--filter", mutant.package, "typecheck"], {
        cwd: tree,
        logPath: join(mutantOut, "typecheck.log"),
      });
      result.typecheck = {
        command: tc.command,
        exitCode: tc.exitCode,
        wallMs: tc.wallMs,
        log: join(mutantOut, "typecheck.log"),
        errorLines: tc.stdout
          .split("\n")
          .filter((line) => /error TS\d+/.test(line))
          .slice(0, 20),
      };
    }

    if (!args.skipTests) {
      const pinsByPackage = pinFilesByPackage(ctx.pins);
      const packages = args.pinsOnly ? [...pinsByPackage.keys()] : spec.testPackages;
      for (const pkg of packages) {
        const short = pkg.replace("@pickle/", "");
        const jsonPath = join(mutantOut, `vitest-${short}.json`);
        const logPath = join(mutantOut, `vitest-${short}.log`);
        const pinArgs = args.pinsOnly ? (pinsByPackage.get(pkg) ?? []) : [];
        log(`${mutant.id}: vitest ${pkg}${args.pinsOnly ? " (pins only)" : ""}`);
        const vt = run(
          "pnpm",
          [
            "-s",
            "--filter",
            pkg,
            "exec",
            "vitest",
            "run",
            ...pinArgs,
            "--reporter=default",
            "--reporter=json",
            `--outputFile.json=${jsonPath}`,
          ],
          { cwd: tree, logPath, env: { CI: "1" } },
        );
        result.unitTests[pkg] = {
          command: vt.command,
          exitCode: vt.exitCode,
          wallMs: vt.wallMs,
          log: logPath,
          json: jsonPath,
          report: parseVitestJson(jsonPath),
        };
      }
    }

    if (!args.skipBench) {
      const benchDir = join(mutantOut, "bench");
      mkdirSync(benchDir, { recursive: true });
      const runId = mutant.id.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      log(`${mutant.id}: bench:regression`);
      const bench = run(
        "pnpm",
        [
          "--filter",
          "@pickle/evaluation",
          "bench:regression",
          "--out-dir",
          benchDir,
          "--run-id",
          runId,
        ],
        { cwd: tree, logPath: join(benchDir, "bench.log") },
      );
      const summaryPath = join(benchDir, `${runId}.json`);
      const comparePath = join(mutantOut, "compare.json");
      const compareTxtPath = join(mutantOut, "compare.txt");
      let compare = null;
      let compareTxt = null;
      if (existsSync(summaryPath)) {
        log(`${mutant.id}: bench:compare`);
        compare = run(
          "pnpm",
          [
            "-s",
            "--filter",
            "@pickle/evaluation",
            "bench:compare",
            join(tree, BASELINE_REL),
            summaryPath,
            "--json",
          ],
          { cwd: tree, logPath: join(benchDir, "compare-json.log") },
        );
        writeFileSync(comparePath, compare.stdout);
        compareTxt = run(
          "pnpm",
          [
            "-s",
            "--filter",
            "@pickle/evaluation",
            "bench:compare",
            join(tree, BASELINE_REL),
            summaryPath,
          ],
          { cwd: tree, logPath: join(benchDir, "compare-text.log") },
        );
        writeFileSync(compareTxtPath, compareTxt.stdout + compareTxt.stderr);
      }
      result.bench = {
        regressionCommand: bench.command,
        regressionExitCode: bench.exitCode,
        regressionWallMs: bench.wallMs,
        regressionLog: join(benchDir, "bench.log"),
        summary: existsSync(summaryPath) ? summaryPath : null,
        compareCommand: compare?.command ?? null,
        compareExitCode: compare?.exitCode ?? null,
        compareTextExitCode: compareTxt?.exitCode ?? null,
        compareJson: compare ? comparePath : null,
        compareText: compareTxt ? compareTxtPath : null,
        compare: compare ? summariseCompare(comparePath) : null,
      };
    }
  } finally {
    writeFileSync(treeFile, pristine);
    const after = readFileSync(treeFile, "utf8");
    if (after !== pristine) {
      restoreError = new Error(`failed to restore ${mutant.file} after ${mutant.id}`);
    }
  }
  if (restoreError) throw restoreError;

  result.classification = classify(result);
  result.wallMs = Date.now() - started;
  const verdict = result.classification.killed
    ? `KILLED by ${result.classification.killedBy.join("+")}`
    : "SURVIVED";
  log(`${mutant.id}: ${verdict} (${Math.round(result.wallMs / 1000)}s)`);
  return result;
}

function renderMatrix(results, meta) {
  const cell = (v) => (v === null || v === undefined ? "n/a" : String(v));
  const lines = [];
  lines.push(`# Mutation matrix — ${meta.headSha.slice(0, 12)}`);
  lines.push("");
  lines.push(
    `Generated ${meta.finishedAt}; pins ${meta.withPins ? "INCLUDED" : "excluded"}; worktree ${meta.tree}.`,
  );
  lines.push("");
  lines.push(
    "| id | category | file:lines | typecheck | unit tests (failed/total) | bench:regression | bench:compare | verdict |",
  );
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    if (r.classification?.refused) {
      lines.push(
        `| ${r.id} | ${r.category} | ${r.file} | — | — | — | — | REFUSED (anchor drift) |`,
      );
      continue;
    }
    const tc = r.typecheck
      ? r.typecheck.exitCode === 0
        ? "pass"
        : `FAIL (exit ${r.typecheck.exitCode})`
      : "skipped";
    const unitEntries = Object.entries(r.unitTests);
    const failed = unitEntries.reduce(
      (n, [, e]) => n + (e.report?.numFailedTests ?? (e.exitCode !== 0 ? 1 : 0)),
      0,
    );
    const total = unitEntries.reduce((n, [, e]) => n + (e.report?.numTotalTests ?? 0), 0);
    const unit =
      unitEntries.length === 0
        ? "skipped"
        : failed > 0
          ? `FAIL ${failed}/${total}`
          : `pass 0/${total}`;
    const benchRun = r.bench
      ? r.bench.regressionExitCode === 0
        ? "ok"
        : `exit ${cell(r.bench.regressionExitCode)}`
      : "skipped";
    let cmp = "skipped";
    if (r.bench) {
      const code = r.bench.compareExitCode;
      const regs = r.bench.compare?.regressions?.length ?? 0;
      const imps = r.bench.compare?.improvements?.length ?? 0;
      cmp =
        code === null
          ? "no summary"
          : `exit ${code}` +
            (code === 1
              ? ` (${regs} regression${regs === 1 ? "" : "s"})`
              : imps > 0
                ? ` (${imps} improvement${imps === 1 ? "" : "s"} only)`
                : "");
    }
    const verdict = r.classification.killed
      ? `KILLED: ${r.classification.killedBy.join(", ")}`
      : "SURVIVED";
    lines.push(
      `| ${r.id} | ${r.category} | ${r.file}:${r.lineNumbers.join(",")} | ${tc} | ${unit} | ${benchRun} | ${cmp} | ${verdict} |`,
    );
  }
  lines.push("");
  const judged = results.filter((r) => !r.classification?.refused && r.id !== "CONTROL");
  const byCategory = new Map();
  for (const r of judged) {
    const entry = byCategory.get(r.category) ?? {
      total: 0,
      unit: 0,
      bench: 0,
      typecheck: 0,
      any: 0,
    };
    entry.total += 1;
    if (r.classification.unitTestsKill) entry.unit += 1;
    if (r.classification.benchKill) entry.bench += 1;
    if (r.classification.typecheckKill) entry.typecheck += 1;
    if (r.classification.killed) entry.any += 1;
    byCategory.set(r.category, entry);
  }
  lines.push(
    "| category | mutants | killed by unit tests | killed by bench:compare | killed by typecheck | killed by any | survived |",
  );
  lines.push("|---|---|---|---|---|---|---|");
  for (const [category, e] of [...byCategory.entries()].sort()) {
    lines.push(
      `| ${category} | ${e.total} | ${e.unit} | ${e.bench} | ${e.typecheck} | ${e.any} | ${e.total - e.any} |`,
    );
  }
  const totals = [...byCategory.values()].reduce(
    (acc, e) => ({
      total: acc.total + e.total,
      unit: acc.unit + e.unit,
      bench: acc.bench + e.bench,
      typecheck: acc.typecheck + e.typecheck,
      any: acc.any + e.any,
    }),
    { total: 0, unit: 0, bench: 0, typecheck: 0, any: 0 },
  );
  lines.push(
    `| **all** | ${totals.total} | ${totals.unit} | ${totals.bench} | ${totals.typecheck} | ${totals.any} | ${totals.total - totals.any} |`,
  );
  lines.push("");
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const spec = loadMutants();
  if (args.list) {
    for (const m of spec.mutants)
      process.stdout.write(`${m.id}\t${m.category}\t${m.file}\t${m.description}\n`);
    return;
  }
  const headSha = git(["rev-parse", "HEAD"]);
  const selected = spec.mutants.filter((m) => !args.only || args.only.has(m.id));
  if (args.only) {
    for (const id of args.only) {
      if (!spec.mutants.some((m) => m.id === id)) throw new Error(`unknown mutant id ${id}`);
    }
  }
  mkdirSync(args.out, { recursive: true });
  const previous = loadPreviousResults(args, headSha, selected);
  ensureTree(args.tree, headSha);
  const pins = args.withPins ? copyPins(args.tree, spec.pinTests) : [];
  if (pins.length > 0) log(`copied ${pins.length} pin test file(s) into the worktree`);

  const ctx = { tree: args.tree, out: args.out, args, headSha, pins };
  const results = [];
  const startedAt = new Date().toISOString();
  const ordered = () => {
    if (!previous) return results;
    const rerun = new Map(results.map((r) => [r.id, r]));
    return spec.mutants
      .map((m) => rerun.get(m.id) ?? previous.byId.get(m.id) ?? null)
      .filter((r) => r !== null);
  };
  try {
    for (const mutant of selected) {
      results.push(runMutant(spec, mutant, ctx));
      const partial = {
        headSha,
        startedAt,
        finishedAt: null,
        withPins: args.withPins,
        tree: args.tree,
        testPackages: spec.testPackages,
        pinTests: pins,
        node: process.version,
        mergedFrom: previous ? previous.meta : null,
        results: ordered(),
      };
      writeFileSync(join(args.out, "results.json"), JSON.stringify(partial, null, 2));
    }
  } finally {
    removePins(args.tree, pins);
    const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: args.tree,
      encoding: "utf8",
    }).stdout.trim();
    if (status.length > 0) log(`WARNING: worktree left dirty:\n${status}`);
    if (!args.keepTree) removeTree(args.tree);
  }
  const finishedAt = new Date().toISOString();
  const merged = ordered();
  const table = {
    headSha,
    startedAt,
    finishedAt,
    withPins: args.withPins,
    tree: args.tree,
    testPackages: spec.testPackages,
    pinTests: pins,
    node: process.version,
    mergedFrom: previous ? previous.meta : null,
    results: merged,
  };
  writeFileSync(join(args.out, "results.json"), JSON.stringify(table, null, 2));
  writeFileSync(join(args.out, "matrix.md"), renderMatrix(merged, table));
  process.stdout.write(renderMatrix(merged, table));
  const control = merged.find((r) => r.id === "CONTROL");
  if (control && control.classification?.killed) {
    log("CONTROL run was not clean — mutant verdicts are not trustworthy");
    process.exitCode = 2;
  }
  const refused = merged.filter((r) => r.classification?.refused);
  if (refused.length > 0) process.exitCode = 2;
}

/**
 * `--merge`: load <out>/results.json so the rows for mutants NOT selected by
 * `--only` are carried over verbatim. Refuses to merge across different HEAD
 * SHAs or pin modes, since those rows would not be comparable.
 */
function loadPreviousResults(args, headSha, selected) {
  if (!args.merge) return null;
  if (!args.only) throw new Error("--merge requires --only (otherwise every row is rerun anyway)");
  const path = join(args.out, "results.json");
  if (!existsSync(path)) throw new Error(`--merge: ${path} does not exist`);
  const table = JSON.parse(readFileSync(path, "utf8"));
  if (table.headSha !== headSha) {
    throw new Error(`--merge: previous table is for ${table.headSha}, HEAD is ${headSha}`);
  }
  if (Boolean(table.withPins) !== args.withPins) {
    throw new Error("--merge: previous table's pin mode differs from this run");
  }
  const byId = new Map((table.results ?? []).map((r) => [r.id, r]));
  const rerunIds = selected.map((m) => m.id);
  log(`merging into existing table (${byId.size} rows); rerunning ${rerunIds.join(",")}`);
  return {
    byId,
    meta: {
      startedAt: table.startedAt ?? null,
      finishedAt: table.finishedAt ?? null,
      rerunIds,
      previousMergedFrom: table.mergedFrom ?? null,
    },
  };
}

main();
