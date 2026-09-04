#!/usr/bin/env node
/**
 * Mutation-testing harness for the auth/session contract.
 *
 * For every mutant in mutants.json: swap one exact source snippet in the
 * target file, run the suites that depend on that file, restore the original
 * bytes (verified by hash), and record whether the suites FAILED (mutant
 * killed — and by which tests) or PASSED (mutant survived — a test-quality
 * gap). The source tree is left byte-identical; the runner refuses to start
 * when a target file already has uncommitted changes.
 *
 *   mobile plane: cd apps/mobile && npx jest --ci --silent --json --findRelatedTests <file>
 *                 (every existing suite that transitively imports the mutated module)
 *   edge plane:   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json .
 *
 * Usage:
 *   node tools/mutation-auth/run.mjs [--plane mobile|edge|all] [--only SK-01,ED-06]
 *        [--out <dir>] [--suites existing|all] [--baseline]
 *
 *   --suites existing  ignores the tests added on the attack branch under
 *                      apps/mobile/__tests__/xc/ and supabase/functions/api/__wf__/xc_*
 *                      so the matrix reflects the suites that existed at the
 *                      start commit; `all` includes them (the re-run that must
 *                      kill every former survivor).
 *   --baseline         also runs each plane unmutated first and aborts if red.
 *
 * Outputs (under --out, default artifacts/mutation-auth/<timestamp>):
 *   results.json   one row per mutant (status, exit code, killing tests, timings)
 *   matrix.md      human-readable killed/survived table
 *   <id>.log       raw runner output per mutant
 *   <id>.jest.json jest --json output (mobile) / <id>.junit.xml (edge)
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MOBILE_DIR = join(repoRoot, "apps", "mobile");
const EDGE_TEST_DIR = join(repoRoot, "supabase", "functions", "api", "__wf__");
const NEW_MOBILE_TESTS = "__tests__/xc/";
const NEW_EDGE_TEST_GLOB = "xc_*";

function parseArgs(argv) {
  const args = { plane: "all", only: null, out: null, suites: "existing", baseline: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--plane") args.plane = argv[++i];
    else if (arg === "--only") args.only = new Set(argv[++i].split(",").map((s) => s.trim()));
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--suites") args.suites = argv[++i];
    else if (arg === "--baseline") args.baseline = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!["mobile", "edge", "all"].includes(args.plane)) throw new Error("--plane mobile|edge|all");
  if (!["existing", "all"].includes(args.suites)) throw new Error("--suites existing|all");
  return args;
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function run(command, argv, cwd, extraEnv = {}) {
  const started = Date.now();
  const result = spawnSync(command, argv, {
    cwd,
    env: { ...process.env, ...extraEnv, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return {
    exitCode: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    durationMs: Date.now() - started,
    command: `${command} ${argv.join(" ")}`,
    cwd: relative(repoRoot, cwd) || ".",
    error: result.error ? String(result.error) : null,
  };
}

function gitClean(paths) {
  const result = spawnSync("git", ["status", "--porcelain", "--", ...paths], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.trim() === "";
}

function mobileArgs(mutantFile, jsonOut, suites) {
  const argv = ["jest", "--ci", "--silent", "--json", `--outputFile=${jsonOut}`];
  if (suites === "existing") argv.push("--testPathIgnorePatterns", NEW_MOBILE_TESTS);
  argv.push("--findRelatedTests", relative(MOBILE_DIR, join(repoRoot, mutantFile)));
  return argv;
}

function edgeArgs(junitOut, suites) {
  const argv = ["test", "-A", "--no-check", "--config", "deno.json", `--junit-path=${junitOut}`];
  if (suites === "existing") argv.push(`--ignore=${NEW_EDGE_TEST_GLOB}`);
  argv.push(".");
  return argv;
}

function parseJestJson(path) {
  if (!existsSync(path)) return { failedSuites: [], killedBy: [], parseError: "no jest json" };
  const report = JSON.parse(readFileSync(path, "utf8"));
  const failedSuites = [];
  const killedBy = [];
  for (const suite of report.testResults ?? []) {
    const rel = relative(MOBILE_DIR, suite.name).split("\\").join("/");
    if (suite.status !== "passed") failedSuites.push(rel);
    for (const assertion of suite.assertionResults ?? []) {
      if (assertion.status === "failed") {
        killedBy.push(`${rel} › ${[...assertion.ancestorTitles, assertion.title].join(" › ")}`);
      }
    }
    if (suite.status === "failed" && (suite.assertionResults ?? []).length === 0) {
      killedBy.push(`${rel} › <suite failed to run: ${(suite.message ?? "").split("\n")[0]}>`);
    }
  }
  return {
    failedSuites,
    killedBy,
    numTotalTests: report.numTotalTests,
    numFailedTests: report.numFailedTests,
    numTotalTestSuites: report.numTotalTestSuites,
    numFailedTestSuites: report.numFailedTestSuites,
  };
}

function decodeXml(text) {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

function parseJunit(path) {
  if (!existsSync(path)) return { failedSuites: [], killedBy: [], parseError: "no junit xml" };
  const xml = readFileSync(path, "utf8");
  const killedBy = [];
  const failedSuites = new Set();
  const testcase = /<testcase\b([^>]*)>([\s\S]*?)<\/testcase>/g;
  let match;
  while ((match = testcase.exec(xml)) !== null) {
    const attrs = match[1];
    const body = match[2];
    if (!/<failure\b|<error\b/.test(body)) continue;
    const name = decodeXml(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? "?");
    const classname = decodeXml(/\bclassname="([^"]*)"/.exec(attrs)?.[1] ?? "?");
    const rel = classname.startsWith("/")
      ? relative(EDGE_TEST_DIR, classname).split("\\").join("/")
      : classname.replace(/^\.\//, "");
    failedSuites.add(rel);
    killedBy.push(`${rel} › ${name}`);
  }
  const totals = /<testsuites\b([^>]*)>/.exec(xml)?.[1] ?? "";
  const num = (key) => Number(new RegExp(`\\b${key}="(\\d+)"`).exec(totals)?.[1] ?? NaN);
  return {
    failedSuites: [...failedSuites],
    killedBy,
    numTotalTests: num("tests"),
    numFailedTests: num("failures") + num("errors"),
  };
}

function applyMutant(mutant) {
  const absolute = join(repoRoot, mutant.file);
  const original = readFileSync(absolute, "utf8");
  const occurrences = original.split(mutant.find).length - 1;
  if (occurrences !== 1) {
    return { ok: false, reason: `find snippet occurs ${occurrences} times (must be exactly 1)` };
  }
  const mutated = original.replace(mutant.find, () => mutant.replace);
  if (mutated === original) return { ok: false, reason: "replace produced identical source" };
  writeFileSync(absolute, mutated);
  return {
    ok: true,
    restore() {
      writeFileSync(absolute, original);
      const restored = readFileSync(absolute, "utf8");
      if (sha256(restored) !== sha256(original)) {
        throw new Error(`restore of ${mutant.file} did not reproduce the original bytes`);
      }
    },
    originalSha256: sha256(original),
    mutatedSha256: sha256(mutated),
  };
}

function runPlane(mutant, outDir, suites) {
  if (mutant.plane === "mobile") {
    const jsonOut = join(outDir, `${mutant.id}.jest.json`);
    const result = run("npx", mobileArgs(mutant.file, jsonOut, suites), MOBILE_DIR);
    return { ...result, ...parseJestJson(jsonOut), reportPath: relative(repoRoot, jsonOut) };
  }
  const junitOut = join(outDir, `${mutant.id}.junit.xml`);
  const result = run("deno", edgeArgs(junitOut, suites), EDGE_TEST_DIR);
  return { ...result, ...parseJunit(junitOut), reportPath: relative(repoRoot, junitOut) };
}

function runBaseline(plane, outDir, suites) {
  const id = `baseline-${plane}`;
  const pseudo = {
    id,
    plane,
    file:
      plane === "mobile" ? "apps/mobile/src/auth/authStore.ts" : "supabase/functions/api/index.ts",
  };
  const result = runPlane(pseudo, outDir, suites);
  writeFileSync(
    join(outDir, `${id}.log`),
    `${result.command}\n\n${result.stdout}\n${result.stderr}`,
  );
  return result;
}

function toolVersions() {
  const v = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    return (r.stdout || r.stderr || "").trim().split("\n")[0];
  };
  return { node: process.version, npx: v("npx", ["--version"]), deno: v("deno", ["--version"]) };
}

function gitHead() {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  return r.stdout.trim();
}

function renderMatrix(rows, meta) {
  const lines = [
    `# Auth/session mutation matrix`,
    ``,
    `- commit: \`${meta.head}\``,
    `- suites: \`${meta.suites}\` (${meta.suites === "existing" ? "attack-branch tests ignored" : "attack-branch tests included"})`,
    `- generated: ${meta.generatedAt}`,
    `- node ${meta.tools.node}, ${meta.tools.deno}`,
    ``,
    `| id | plane | status | file › symbol | mutation | exit | failed/total | killed by |`,
    `|---|---|---|---|---|---|---|---|`,
  ];
  for (const row of rows) {
    const killedBy =
      row.killedBy.length === 0
        ? ""
        : row.killedBy.length <= 3
          ? row.killedBy.map((t) => `\`${t}\``).join("<br>")
          : `${row.killedBy
              .slice(0, 3)
              .map((t) => `\`${t}\``)
              .join("<br>")}<br>… +${row.killedBy.length - 3} more`;
    lines.push(
      `| ${row.id} | ${row.plane} | **${row.status}** | \`${row.file}\` › ${row.symbol} | ${row.description} | ${row.exitCode ?? ""} | ${row.numFailedTests ?? "?"}/${row.numTotalTests ?? "?"} | ${killedBy} |`,
    );
  }
  const killed = rows.filter((r) => r.status === "killed").length;
  const survived = rows.filter((r) => r.status === "survived").length;
  const invalid = rows.filter((r) => r.status === "invalid").length;
  lines.push(
    ``,
    `**${rows.length} mutants: ${killed} killed, ${survived} survived, ${invalid} invalid** — mutation score ${rows.length - invalid > 0 ? Math.round((killed / (rows.length - invalid)) * 100) : 0}% (killed / valid).`,
  );
  return lines.join("\n") + "\n";
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const catalogue = JSON.parse(readFileSync(join(repoRoot, "tools/mutation-auth/mutants.json")));
  let mutants = catalogue.mutants.filter((m) => args.plane === "all" || m.plane === args.plane);
  if (args.only) mutants = mutants.filter((m) => args.only.has(m.id));
  if (mutants.length === 0) throw new Error("no mutants selected");

  const ids = new Set();
  for (const m of mutants) {
    if (ids.has(m.id)) throw new Error(`duplicate mutant id ${m.id}`);
    ids.add(m.id);
  }

  const targetFiles = [...new Set(mutants.map((m) => m.file))];
  if (!gitClean(targetFiles)) {
    throw new Error(
      `refusing to mutate: uncommitted changes in ${targetFiles.join(", ")} (git status --porcelain)`,
    );
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = args.out
    ? resolve(process.cwd(), args.out)
    : join(repoRoot, "artifacts", "mutation-auth", stamp);
  mkdirSync(outDir, { recursive: true });
  const meta = {
    head: gitHead(),
    suites: args.suites,
    generatedAt: new Date().toISOString(),
    tools: toolVersions(),
    planes: [...new Set(mutants.map((m) => m.plane))],
  };
  console.log(`mutation-auth: ${mutants.length} mutants → ${relative(repoRoot, outDir)}`);

  if (args.baseline) {
    for (const plane of meta.planes) {
      const base = runBaseline(plane, outDir, args.suites);
      console.log(
        `baseline ${plane}: exit ${base.exitCode} (${base.numFailedTests ?? "?"} failed / ${base.numTotalTests ?? "?"} tests, ${base.durationMs} ms)`,
      );
      if (base.exitCode !== 0) {
        throw new Error(`baseline ${plane} is red; fix that before measuring mutants`);
      }
    }
  }

  const rows = [];
  for (const mutant of mutants) {
    const applied = applyMutant(mutant);
    let row;
    if (!applied.ok) {
      row = {
        ...mutant,
        status: "invalid",
        exitCode: null,
        killedBy: [],
        failedSuites: [],
        reason: applied.reason,
      };
      console.log(`${mutant.id} invalid: ${applied.reason}`);
    } else {
      try {
        const result = runPlane(mutant, outDir, args.suites);
        writeFileSync(
          join(outDir, `${mutant.id}.log`),
          `# ${mutant.id} — ${mutant.description}\n# ${result.cwd}$ ${result.command}\n# exit ${result.exitCode}\n\n${result.stdout}\n${result.stderr}`,
        );
        const status = result.exitCode === 0 ? "survived" : "killed";
        row = {
          ...mutant,
          status,
          exitCode: result.exitCode,
          command: `(cd ${result.cwd} && ${result.command})`,
          durationMs: result.durationMs,
          numTotalTests: result.numTotalTests,
          numFailedTests: result.numFailedTests,
          failedSuites: result.failedSuites,
          killedBy: result.killedBy,
          reportPath: result.reportPath,
          logPath: relative(repoRoot, join(outDir, `${mutant.id}.log`)),
          originalSha256: applied.originalSha256,
          mutatedSha256: applied.mutatedSha256,
          runnerError: result.error,
        };
        console.log(
          `${mutant.id} ${status.toUpperCase()} (exit ${result.exitCode}, ${result.numFailedTests ?? "?"}/${result.numTotalTests ?? "?"} failed, ${result.durationMs} ms)${
            row.killedBy[0] ? ` ← ${row.killedBy[0]}` : ""
          }`,
        );
      } finally {
        applied.restore();
      }
    }
    rows.push(row);
    writeFileSync(join(outDir, "results.json"), JSON.stringify({ meta, mutants: rows }, null, 2));
    writeFileSync(join(outDir, "matrix.md"), renderMatrix(rows, meta));
  }

  if (!gitClean(targetFiles)) {
    throw new Error("source tree is dirty after the run — restore failed");
  }
  const survived = rows.filter((r) => r.status === "survived");
  const invalid = rows.filter((r) => r.status === "invalid");
  console.log(
    `done: ${rows.length - survived.length - invalid.length} killed, ${survived.length} survived, ${invalid.length} invalid → ${relative(repoRoot, join(outDir, "matrix.md"))}`,
  );
  if (survived.length > 0) console.log(`survived: ${survived.map((r) => r.id).join(", ")}`);
  process.exitCode = survived.length > 0 || invalid.length > 0 ? 1 : 0;
}

main();
