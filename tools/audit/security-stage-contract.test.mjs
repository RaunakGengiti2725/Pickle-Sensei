// The "security" verification stage is documented in three places as a
// secret AND dependency scan; this pins each documented promise against what
// the scripts actually execute.
//
// Run: node --test tools/audit/security-stage-contract.test.mjs
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const verifyCloud = read("scripts/verify-cloud.sh");
const securityScan = read("scripts/security-scan.sh");
const ci = read(".github/workflows/ci.yml");
const gitleaksToml = read(".gitleaks.toml");

const stageSecurityBody = verifyCloud.match(/stage_security\(\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";

test("verify-cloud.sh documents the security stage as a secret/dependency scan", () => {
  assert.match(verifyCloud, /security\s+scripts\/security-scan\.sh \(secret\/dependency scan\)/);
});

test("stage_security runs a dependency audit (pnpm audit / npm audit) as documented", () => {
  assert.ok(stageSecurityBody.length > 0, "stage_security() not found");
  assert.match(
    stageSecurityBody,
    /\b(pnpm|npm)\s+audit\b/,
    `stage_security() body runs only: ${stageSecurityBody.trim().split("\n").pop()?.trim()}`,
  );
});

test("some CI job runs a dependency audit", () => {
  assert.match(ci, /\b(pnpm|npm)\s+audit\b/, "ci.yml never runs pnpm audit or npm audit");
});

test("mobile dependency install in verify-cloud does not opt out of auditing while nothing else audits", () => {
  const optsOut = /npm ci[^\n]*--no-audit/.test(verifyCloud);
  const auditsElsewhere =
    /\b(pnpm|npm)\s+audit\b/.test(verifyCloud) || /\b(pnpm|npm)\s+audit\b/.test(ci);
  assert.ok(
    !optsOut || auditsElsewhere,
    "npm ci --no-audit and no audit anywhere in verify-cloud.sh or ci.yml",
  );
});

test("security-scan.sh header: history scan is 'of HEAD' — implementation passes no --log-opts by default", () => {
  assert.match(securityScan, /working tree \+ full git history of HEAD/);
  // Default invocation: `gitleaks git … .` with no --log-opts → gitleaks runs
  // `git log --all`, i.e. every ref in the clone, not HEAD's ancestry.
  const defaultHistoryCall = securityScan.match(/else\s*\n\s*run_scan history git( [^\n]*)?\n/);
  assert.ok(defaultHistoryCall, "default history invocation not found");
  assert.match(
    defaultHistoryCall[1] ?? "",
    /--log-opts/,
    "no --log-opts in the default history scan → scans all refs, contradicting the header",
  );
});

test("security-scan.sh header: tree scan is 'tracked, untracked, unignored' — gitleaks dir has no gitignore filter", () => {
  assert.match(securityScan, /working tree only \(tracked, untracked, unignored\)/);
  // gitleaks `dir` walks every file; the script passes nothing to skip
  // gitignored paths, so the header over-promises (see security-scan-probes.sh
  // tree_scan_skips_gitignored).
  assert.match(
    securityScan,
    /run_scan tree dir[^\n]*(--gitignore|--ignore-gitignored|git ls-files)/,
  );
});

test(".gitleaks.toml directory allowlists are justified as gitignored — each one must actually be gitignored repo-wide", () => {
  // The block says these trees "are gitignored … and can never reach the
  // repository". The patterns are unanchored ((?:^|/)dir/), so the claim must
  // hold for that directory name at ANY depth; probe the repo root and a
  // nested location with `git check-ignore`.
  const block =
    gitleaksToml.match(
      /description = "gitignored build, dependency, and media artifact directories"\s*\npaths = \[\n([\s\S]*?)\n\]/,
    )?.[1] ?? "";
  const dirs = [...block.matchAll(/'''\(\?:\^\|\/\)(.+?)\/'''/g)]
    .map((m) => m[1].replace(/\\\./g, ".").replace(/\[\^\/\]\*/g, ""))
    .filter((d) => !d.includes("("));
  assert.ok(dirs.length >= 8, `parsed allowlisted directories: ${dirs}`);
  const notIgnored = [];
  for (const dir of dirs) {
    for (const probe of [`${dir}/x`, `services/api/${dir}/x`]) {
      const r = spawnSync("git", ["check-ignore", "-q", probe], { cwd: root });
      if (r.status !== 0) notIgnored.push(probe);
    }
  }
  assert.deepEqual(
    notIgnored,
    [],
    `allowlisted as "gitignored" but git does not ignore: ${notIgnored.join(", ")}`,
  );
});
