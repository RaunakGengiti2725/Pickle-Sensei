#!/usr/bin/env node
/**
 * Runs every scenario in scenarios.mjs against a fresh sandbox and writes a JSON + Markdown
 * report. Exit 0 always (this is a reporting harness — the assertions live in
 * release-config-attacks.test.mjs). Usage:
 *
 *   node tools/release/attack/run-attacks.mjs [--out <dir>] [--only <id>[,<id>]]
 *
 * Env: ATTACK_SEED (default 20260904).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSandbox, destroySandbox, repoRoot, runBoth } from "./sandbox.mjs";
import { generated, scenarios } from "./scenarios.mjs";

const args = process.argv.slice(2);
const outDir = args.includes("--out")
  ? args[args.indexOf("--out") + 1]
  : join(repoRoot, "artifacts", "release-attacks");
const only = args.includes("--only") ? new Set(args[args.indexOf("--only") + 1].split(",")) : null;
mkdirSync(outDir, { recursive: true });

function matches(expectation, result) {
  if (expectation === "any") return true;
  return expectation === "pass" ? result.exitCode === 0 : result.exitCode === 1;
}

function classify(scenario, results) {
  const releaseOk = matches(scenario.expect.releaseCheck, results.releaseCheck);
  const distOk = matches(scenario.expect.distributionCheck, results.distributionCheck);
  return releaseOk && distOk ? "HELD" : "BROKEN";
}

const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
const rows = [];
for (const scenario of scenarios) {
  if (only && !only.has(scenario.id)) continue;
  const root = createSandbox();
  const started = Date.now();
  try {
    scenario.mutate(root);
    const results = runBoth(root);
    const verdict = classify(scenario, results);
    rows.push({
      id: scenario.id,
      assigned: scenario.assigned,
      title: scenario.title,
      invariant: scenario.invariant,
      expect: scenario.expect,
      verdict,
      durationMs: Date.now() - started,
      releaseCheck: {
        exitCode: results.releaseCheck.exitCode,
        failLines: results.releaseCheck.failLines,
      },
      distributionCheck: {
        exitCode: results.distributionCheck.exitCode,
        failLines: results.distributionCheck.failLines,
      },
    });
    writeFileSync(
      join(outDir, `${scenario.id}.log`),
      [
        `# ${scenario.id} — ${scenario.title}`,
        `# HEAD ${head}  seed ${generated.seed}`,
        `# invariant: ${scenario.invariant}`,
        `# expect: release:check=${scenario.expect.releaseCheck} check:distribution=${scenario.expect.distributionCheck}`,
        `# verdict: ${verdict}`,
        "",
        `$ node tools/release/check-release-manifest.mjs   # exit ${results.releaseCheck.exitCode}`,
        results.releaseCheck.stdout,
        results.releaseCheck.stderr,
        `$ (cd apps/mobile && node scripts/check-ios-distribution.mjs)   # exit ${results.distributionCheck.exitCode}`,
        results.distributionCheck.stdout,
        results.distributionCheck.stderr,
      ].join("\n"),
    );
  } finally {
    destroySandbox(root);
  }
}

const report = {
  head,
  seed: generated.seed,
  generated,
  command: "node tools/release/attack/run-attacks.mjs",
  scenarios: rows,
  totals: {
    executed: rows.length,
    held: rows.filter((r) => r.verdict === "HELD").length,
    broken: rows.filter((r) => r.verdict === "BROKEN").length,
  },
};
writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

const md = [
  `# release-config attack report — ${head.slice(0, 8)} (seed ${generated.seed})`,
  "",
  "| id | assigned | verdict | release:check exit (expected) | check:distribution exit (expected) | title |",
  "|---|---|---|---|---|---|",
  ...rows.map(
    (r) =>
      `| ${r.id} | ${r.assigned ? "yes" : "extra"} | ${r.verdict} | ${r.releaseCheck.exitCode} (${r.expect.releaseCheck}) | ${r.distributionCheck.exitCode} (${r.expect.distributionCheck}) | ${r.title.replaceAll("|", "\\|")} |`,
  ),
  "",
  `executed ${report.totals.executed}, HELD ${report.totals.held}, BROKEN ${report.totals.broken}`,
  "",
];
writeFileSync(join(outDir, "report.md"), md.join("\n"));
console.log(md.join("\n"));
console.log(`artifacts: ${outDir}`);
