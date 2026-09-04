#!/usr/bin/env node
/**
 * mobile-ios-config mutation harness.
 *
 * For every scenario in ./scenarios.mjs: create a detached git worktree of
 * the baseline commit, apply ONE configuration mutation there, run the Linux
 * guards that should notice, and record exit code + output. Production files
 * in the source checkout are never touched.
 *
 *   node tools/attack/mobile-ios-config/run.mjs [--sha <commit>] [--only <id,id>]
 *        [--out <dir>] [--keep]
 *
 * Exit code: 0 when every check behaved as the scenario declared (guards
 * declared `fail` failed with the expected message, guards declared `pass`
 * passed), 1 otherwise. A `pass` declaration is a DOCUMENTED GAP, not a
 * success — see results.json `gaps`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, createWorktree, git, removeWorktree, run } from "./lib.mjs";
import { scenarios } from "./scenarios.mjs";

const argv = process.argv.slice(2);
const opt = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : fallback;
};
const sha = git(["rev-parse", opt("--sha", "HEAD")]);
const only = opt("--only", "").split(",").filter(Boolean);
const keep = argv.includes("--keep");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = opt("--out", join(REPO_ROOT, "artifacts", "attack", "mobile-ios-config", stamp));
const worktreeBase = join(
  process.env.HOME ?? REPO_ROOT,
  "attack-worktrees",
  "mobile-ios-config",
  stamp,
);
mkdirSync(outDir, { recursive: true });

const selected = only.length ? scenarios.filter((s) => only.includes(s.id)) : scenarios;
if (!selected.length) {
  console.error("no scenarios selected");
  process.exit(2);
}

const results = [];
let surprises = 0;

for (const scenario of selected) {
  const dir = join(worktreeBase, scenario.id);
  const record = {
    id: scenario.id,
    assigned: Boolean(scenario.assigned),
    title: scenario.title,
    sha,
    worktree: dir,
    detail: null,
    diff: null,
    checks: [],
  };
  console.log(`\n=== ${scenario.id} — ${scenario.title}`);
  createWorktree(sha, dir);
  try {
    scenario.mutate(dir);
    record.detail = scenario.detail ?? null;
    record.diff = git(["diff", "--no-color"], dir);
    if (!record.diff && !scenario.control) {
      throw new Error("mutation produced an empty diff");
    }
    writeFileSync(join(outDir, `${scenario.id}.diff`), record.diff + "\n");

    for (const check of scenario.checks) {
      const cwd = check.cwd === "mobile" ? join(dir, "apps", "mobile") : dir;
      const env = check.envFromWorktree ? { [check.envFromWorktree]: dir } : {};
      const res = run(check.cmd, check.args, cwd, env);
      const logName = `${scenario.id}.${check.name.replace(/[^\w.-]+/g, "_")}.log`;
      writeFileSync(
        join(outDir, logName),
        `$ ${res.command}\n(cwd ${res.cwd})\nexit ${res.exitCode}\n\n${res.output}`,
      );
      const failed = res.exitCode !== 0;
      const messages = check.mustContain.map((m) => ({
        text: m,
        found: res.output.includes(m),
      }));
      const asDeclared =
        check.expect === "fail" ? failed && messages.every((m) => m.found) : !failed;
      const verdict =
        check.expect === "fail"
          ? failed
            ? messages.every((m) => m.found)
              ? "HELD"
              : "HELD (different message)"
            : "BROKEN (guard did not fire)"
          : failed
            ? "UNEXPECTED FAIL"
            : scenario.control
              ? "PASS (control)"
              : "GAP (guard blind to this mutation, as documented)";
      if (!asDeclared) surprises += 1;
      record.checks.push({
        name: check.name,
        command: res.command,
        cwd: res.cwd.replace(dir, "<worktree>"),
        expect: check.expect,
        exitCode: res.exitCode,
        mustContain: messages,
        verdict,
        asDeclared,
        log: join(outDir, logName),
      });
      console.log(
        `  ${asDeclared ? "ok " : "!! "} ${check.name} → exit ${res.exitCode} → ${verdict}`,
      );
    }
  } catch (err) {
    record.error = String(err?.stack ?? err);
    surprises += 1;
    console.log(`  !!  error: ${record.error}`);
  } finally {
    if (!keep) removeWorktree(dir);
  }
  results.push(record);
}

const summary = {
  sha,
  generatedAt: new Date().toISOString(),
  outDir,
  scenarios: results.length,
  checks: results.reduce((n, r) => n + r.checks.length, 0),
  held: results.flatMap((r) => r.checks).filter((c) => c.verdict.startsWith("HELD")).length,
  gaps: results
    .flatMap((r) => r.checks.map((c) => ({ scenario: r.id, ...c })))
    .filter((c) => c.verdict.startsWith("GAP"))
    .map((c) => ({ scenario: c.scenario, check: c.name, exitCode: c.exitCode })),
  surprises,
  results,
};
writeFileSync(join(outDir, "results.json"), JSON.stringify(summary, null, 2));

const lines = [
  `# mobile-ios-config mutation results @ ${sha.slice(0, 8)}`,
  "",
  "| scenario | check | exit | verdict |",
  "|---|---|---|---|",
];
for (const r of results) {
  if (r.error) lines.push(`| ${r.id} | (harness error) | – | ERROR |`);
  for (const c of r.checks) {
    lines.push(`| ${r.id} | ${c.name} | ${c.exitCode} | ${c.verdict} |`);
  }
}
writeFileSync(join(outDir, "results.md"), lines.join("\n") + "\n");

console.log(
  `\n${summary.checks} checks: ${summary.held} HELD, ${summary.gaps.length} GAP, ${surprises} surprises → ${outDir}`,
);
process.exit(surprises ? 1 : 0);
