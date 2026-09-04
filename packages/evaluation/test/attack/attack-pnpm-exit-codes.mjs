#!/usr/bin/env node
/**
 * Adversarial harness: does `pnpm --filter @pickle/evaluation bench:compare`
 * preserve the compare CLI's documented exit codes (2 invalid input,
 * 3 non-comparable) across pnpm major versions?
 *
 *   PNPM9_BIN=$(command -v pnpm) PNPM10_BIN=~/pnpm10/node_modules/.bin/pnpm \
 *     node packages/evaluation/test/attack/attack-pnpm-exit-codes.mjs [--out <report.json>]
 *
 * Both binaries are REQUIRED (the script exits 2 if either is missing — a
 * missing runtime is not a pass). It writes nothing into the repository:
 * candidates live in a mkdtemp scratch, the committed baseline is read-only
 * input. Exit 0 when every observation matches the table pinned below
 * (observed at 4d812e1a), exit 1 when any differs, so a change in pnpm's
 * exit-code propagation is caught instead of silently re-labelling results.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const BASELINE = join(REPO_ROOT, "datasets/reports/regression/baseline.json");
const TSX_BIN = join(REPO_ROOT, "packages/swing-lab/node_modules/.bin/tsx");
const CLI = join(REPO_ROOT, "packages/evaluation/src/regression/cli.ts");

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const reportPath = outIndex >= 0 ? resolve(args[outIndex + 1] ?? "") : null;

function need(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required (absolute path to a pnpm binary)`);
    process.exit(2);
  }
  return value;
}

const pnpm9 = need("PNPM9_BIN");
const pnpm10 = need("PNPM10_BIN");

function version(bin) {
  const result = spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${bin} --version failed: ${result.stderr}`);
  return result.stdout.trim();
}

const v9 = version(pnpm9);
const v10 = version(pnpm10);
if (!v9.startsWith("9.")) {
  console.error(`PNPM9_BIN reports ${v9}, expected a 9.x binary`);
  process.exit(2);
}
if (!v10.startsWith("10.")) {
  console.error(`PNPM10_BIN reports ${v10}, expected a 10.x binary`);
  process.exit(2);
}

const scratch = mkdtempSync(join(tmpdir(), "pickle-regression-pnpm-attack-"));
const baselineText = readFileSync(BASELINE, "utf8");
const baseline = JSON.parse(baselineText);

const contract2 = join(scratch, "contract2.json");
writeFileSync(
  contract2,
  `${JSON.stringify({ ...baseline, contractVersion: 2, runId: "contract2" }, null, 2)}\n`,
);

const cut = baselineText.indexOf('"runId"') + 12;
const truncated = join(scratch, "truncated.json");
writeFileSync(truncated, baselineText.slice(0, cut));

const clean = join(scratch, "clean.json");
writeFileSync(clean, `${JSON.stringify({ ...baseline, runId: "clean" }, null, 2)}\n`);

/** Documented compare exit codes, and what each launcher was observed to return at 4d812e1a. */
const EXPECTED = [
  { candidate: "contract2", direct: 3, pnpm9: 1, pnpm10: 3 },
  { candidate: "truncated", direct: 2, pnpm9: 1, pnpm10: 2 },
  { candidate: "clean", direct: 0, pnpm9: 0, pnpm10: 0 },
];

const files = { contract2, truncated, clean };
const env = { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" };

function run(command, argv) {
  const result = spawnSync(command, argv, { cwd: REPO_ROOT, encoding: "utf8", env });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stderrTail: result.stderr.trim().split("\n").slice(-3).join("\n"),
  };
}

const observations = [];
let mismatches = 0;
for (const row of EXPECTED) {
  const candidate = files[row.candidate];
  const direct = run(TSX_BIN, [CLI, "compare", BASELINE, candidate]);
  const via9 = run(pnpm9, [
    "-s",
    "--filter",
    "@pickle/evaluation",
    "bench:compare",
    BASELINE,
    candidate,
  ]);
  const via10 = run(pnpm10, [
    "-s",
    "--filter",
    "@pickle/evaluation",
    "bench:compare",
    BASELINE,
    candidate,
  ]);
  const observed = { direct: direct.status, pnpm9: via9.status, pnpm10: via10.status };
  const ok =
    observed.direct === row.direct &&
    observed.pnpm9 === row.pnpm9 &&
    observed.pnpm10 === row.pnpm10;
  if (!ok) mismatches += 1;
  observations.push({
    candidate: row.candidate,
    expected: { direct: row.direct, pnpm9: row.pnpm9, pnpm10: row.pnpm10 },
    observed,
    matchesPinnedTable: ok,
    stderr: { direct: direct.stderrTail, pnpm9: via9.stderrTail, pnpm10: via10.stderrTail },
  });
  console.log(
    `${row.candidate.padEnd(10)} direct=${observed.direct} pnpm${v9}=${observed.pnpm9} pnpm${v10}=${observed.pnpm10} ${ok ? "as pinned" : "DIFFERS"}`,
  );
}

const report = {
  harness: "attack-pnpm-exit-codes",
  repoRoot: REPO_ROOT,
  pnpm9: { bin: pnpm9, version: v9 },
  pnpm10: { bin: pnpm10, version: v10 },
  node: process.version,
  observations,
  verdict:
    mismatches === 0
      ? "pnpm 9.x collapses compare exit 3 (non-comparable) and exit 2 (invalid input) to exit 1; pnpm 10.x preserves them"
      : `${mismatches} row(s) differ from the pinned table`,
};
if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
rmSync(scratch, { recursive: true, force: true });
process.exit(mismatches === 0 ? 0 : 1);
