#!/usr/bin/env node
/**
 * Runs every release-config attack probe and emits a HELD / BROKEN / UNKNOWN
 * classification table.
 *
 * Convention: every `*.attack.test.mjs` test asserts the INVARIANT the docs
 * or manifest promise (e.g. "de-authorizing a rollback hook must fail the
 * gate"). A passing test therefore means the gate HELD; a failing test means
 * the attack BROKE through and the assertion message is the observed gap.
 * Scenarios that can only run on the Apple plane (S8) are produced by a
 * separate script and classified UNKNOWN on Linux.
 *
 * Usage: node tools/release/__attack__/run-attack-pass.mjs --out-dir <dir>
 *
 * Writes <dir>/attack-pass-report.json plus the raw TAP output of each suite.
 * Exits 0 when the pass completed (regardless of classification); exits 1
 * only when the harness itself could not run.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const outIdx = process.argv.indexOf("--out-dir");
const outDir =
  outIdx >= 0 ? process.argv[outIdx + 1] : join(repoRoot, "artifacts", "release-attack");
mkdirSync(outDir, { recursive: true });

const suites = [
  "release-config-gates.attack.test.mjs",
  "manifest-structure-and-ci-wiring.attack.test.mjs",
];

const rows = [];
const suiteRuns = [];

for (const suite of suites) {
  const abs = join(here, suite);
  const cmd = `node --test --test-reporter=tap ${relative(repoRoot, abs)}`;
  const res = spawnSync(process.execPath, ["--test", "--test-reporter=tap", abs], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const tapPath = join(outDir, `${suite}.tap`);
  writeFileSync(tapPath, res.stdout + (res.stderr ? `\n--- stderr ---\n${res.stderr}` : ""));
  suiteRuns.push({ suite, command: cmd, exitCode: res.status, tap: tapPath });
  rows.push(...parseTap(res.stdout, suite, cmd, tapPath));
}

// S8: Apple-plane scenario, static evidence only.
const s8Out = join(outDir, "s8-fastlane-build-number-race.json");
const s8Cmd = `node tools/release/__attack__/s8-fastlane-build-number-race.mjs --out ${s8Out}`;
const s8 = spawnSync(
  process.execPath,
  [join(here, "s8-fastlane-build-number-race.mjs"), "--out", s8Out],
  { cwd: repoRoot, encoding: "utf8" },
);
rows.push({
  id: "S8",
  name: "two near-simultaneous fastlane beta invocations derive the same build number; nothing in the repo detects it",
  suite: "s8-fastlane-build-number-race.mjs",
  command: s8Cmd,
  exitCode: s8.status,
  classification: s8.status === 0 ? "UNKNOWN" : "HARNESS_ERROR",
  detail:
    "Apple/ASC runtime not executed (never trigger a Mac run). Static extraction + seeded interleaving model; see artifact.",
  artifact: s8Out,
});

const summary = rows.reduce((acc, r) => {
  acc[r.classification] = (acc[r.classification] ?? 0) + 1;
  return acc;
}, {});

const report = {
  commit: gitRev(),
  generatedAt: new Date().toISOString(),
  convention:
    "test asserts the promised invariant → pass = HELD (gate rejected the attack), fail = BROKEN (attack passed the gate; `detail` is the observed gap)",
  suiteRuns,
  summary,
  rows,
};
const reportPath = join(outDir, "attack-pass-report.json");
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

for (const r of rows) {
  process.stdout.write(`${r.classification.padEnd(7)} ${r.id.padEnd(4)} ${r.name}\n`);
}
process.stdout.write(`\n${JSON.stringify(summary)}\nreport: ${reportPath}\n`);
process.exit(suiteRuns.some((s) => s.exitCode === null) || s8.status !== 0 ? 1 : 0);

// ---------------------------------------------------------------------------
function parseTap(tap, suite, command, tapPath) {
  const out = [];
  const lines = tap.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(not )?ok \d+ - (.*)$/.exec(lines[i]);
    if (!m) continue;
    const failed = Boolean(m[1]);
    const name = m[2].trim();
    const id = /^([SX]\d+[a-z]?)\b/.exec(name)?.[1] ?? "?";
    let detail = "";
    if (failed) {
      // Pull the YAML `error:` block that node's TAP reporter emits.
      for (let j = i + 1; j < lines.length && !/^(not )?ok \d+/.test(lines[j]); j += 1) {
        const em = /^(\s+)error:\s*(.*)$/.exec(lines[j]);
        if (em) {
          const scalar = em[2];
          if (scalar === "|-" || scalar === "|") {
            // YAML block scalar: indented lines until the next key at the
            // same indentation as `error:`.
            const keyIndent = em[1].length;
            const buf = [];
            for (let k = j + 1; k < lines.length; k += 1) {
              const indent = /^(\s*)/.exec(lines[k])[1].length;
              if (lines[k].trim() !== "" && indent <= keyIndent) break;
              buf.push(lines[k].trim());
            }
            detail = buf.filter(Boolean).join(" ");
          } else {
            detail = scalar.replace(/^'(.*)'$/, "$1").replace(/''/g, "'");
          }
          break;
        }
      }
    }
    out.push({
      id,
      name: name.replace(/^[SX]\d+[a-z]?\s+/, ""),
      suite,
      command,
      exitCode: failed ? 1 : 0,
      classification: failed ? "BROKEN" : "HELD",
      detail,
      artifact: tapPath,
    });
  }
  return out;
}

function gitRev() {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  return r.stdout.trim();
}
