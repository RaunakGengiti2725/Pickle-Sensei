// H04-01 adversarial tests for the §8.2 acceptance check embedded in
// docs/security/ADVISORIES_2026-09-08.md. The script under test is extracted
// verbatim from the document and executed with `node -e` inside a throwaway
// working directory that mirrors the paths the script hard-codes, so each
// case controls exactly one input: the two audit reports and the document.
//
// Run: node --test tools/attack/h04-01/acceptance-script.attack.test.mjs

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const DOC_REL = "docs/security/ADVISORIES_2026-09-08.md";
const docPath = path.join(repoRoot, DOC_REL);
const doc = fs.readFileSync(docPath, "utf8");

const realMobile = fs.readFileSync(path.join(repoRoot, "artifacts/advisories/mobile.json"), "utf8");
const realPnpm = fs.readFileSync(path.join(repoRoot, "artifacts/advisories/pnpm.json"), "utf8");

/** The `node -e '…'` payload from the §8.2 fenced block, verbatim. */
function extractAcceptanceScript() {
  const fenceStart = doc.indexOf("```sh\npnpm audit --json > artifacts/advisories/pnpm.json;");
  assert.ok(fenceStart > 0, "§8.2 sh fence not found");
  const fenceEnd = doc.indexOf("\n```\n", fenceStart);
  const block = doc.slice(fenceStart, fenceEnd);
  const marker = "node -e '";
  const start = block.indexOf(marker) + marker.length;
  const end = block.lastIndexOf("'");
  assert.ok(start > marker.length && end > start, "node -e payload not found");
  return {
    manifestPrefix: block.slice("```sh\n".length, block.indexOf(marker)),
    script: block.slice(start, end),
  };
}

const { manifestPrefix, script } = extractAcceptanceScript();

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * Build a cwd with the exact relative paths the script reads/writes.
 * `mobile`/`pnpm` are raw file contents (strings) or `null` to omit the file.
 */
function makeCwd({
  docText = doc,
  mobile = realMobile,
  pnpm = realPnpm,
  staleLog = null,
  artifactsDir = true,
} = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "h04-01-attack-"));
  tmpDirs.push(cwd);
  fs.mkdirSync(path.join(cwd, "docs/security"), { recursive: true });
  fs.writeFileSync(path.join(cwd, DOC_REL), docText);
  fs.mkdirSync(path.join(cwd, "apps/mobile"), { recursive: true });
  fs.symlinkSync(
    path.join(repoRoot, "apps/mobile/node_modules"),
    path.join(cwd, "apps/mobile/node_modules"),
    "dir",
  );
  if (artifactsDir) {
    fs.mkdirSync(path.join(cwd, "artifacts/advisories"), { recursive: true });
    if (mobile !== null)
      fs.writeFileSync(path.join(cwd, "artifacts/advisories/mobile.json"), mobile);
    if (pnpm !== null) fs.writeFileSync(path.join(cwd, "artifacts/advisories/pnpm.json"), pnpm);
    if (staleLog !== null)
      fs.writeFileSync(path.join(cwd, "artifacts/advisories/disposition-coverage.log"), staleLog);
  }
  return cwd;
}

function runCheck(cwd) {
  const r = spawnSync(process.execPath, ["-e", script], { cwd, encoding: "utf8" });
  const logPath = path.join(cwd, "artifacts/advisories/disposition-coverage.log");
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : null;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, log };
}

function withRow(text, sectionHeading, rowLabel, newRowBody) {
  const secStart = text.indexOf(sectionHeading);
  assert.ok(secStart >= 0, `heading ${sectionHeading} not found`);
  const secEnd = text.indexOf("\n### ", secStart + 1);
  const section = text.slice(secStart, secEnd);
  const rowRe = new RegExp(`^\\| ${rowLabel} +\\|[^\\n]*$`, "m");
  assert.ok(rowRe.test(section), `row ${rowLabel} not found in ${sectionHeading}`);
  const replaced = section.replace(rowRe, `| ${rowLabel} | ${newRowBody} |`);
  return text.slice(0, secStart) + replaced + text.slice(secEnd);
}

function appendRow(text, sectionHeading, afterRowLabel, newRowLine) {
  const secStart = text.indexOf(sectionHeading);
  const secEnd = text.indexOf("\n### ", secStart + 1);
  const section = text.slice(secStart, secEnd);
  const rowRe = new RegExp(`^\\| ${afterRowLabel} +\\|[^\\n]*$`, "m");
  const m = section.match(rowRe);
  assert.ok(m, `row ${afterRowLabel} not found`);
  const idx = section.indexOf(m[0]) + m[0].length;
  return (
    text.slice(0, secStart) +
    section.slice(0, idx) +
    "\n" +
    newRowLine +
    section.slice(idx) +
    text.slice(secEnd)
  );
}

const SEC_43 = "### 4.3 GHSA-vcc3-ghjq-m6fr";
const SEC_42 = "### 4.2 GHSA-5p2g-fcmc-qvqq";

describe("baseline — the candidate document against the real audit reports", () => {
  test("exits 0 with advisories=3 missing=0 floors=1 badFloors=0 (matches §8.2 claim)", () => {
    const r = runCheck(makeCwd());
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /advisories=3 missing=0 floors=1 badFloors=0/);
    assert.match(r.log, /\nexit 0\n$/);
  });

  test("candidate's own negative control (1): §4.2 Disposition = TBD → exit 1", () => {
    const mutated = withRow(doc, SEC_42, "Disposition", "TBD");
    const r = runCheck(makeCwd({ docText: mutated }));
    assert.equal(r.status, 1);
    assert.match(r.stdout, /GHSA-5p2g-fcmc-qvqq: MISSING disposition/);
  });

  test("candidate's own negative control (2): floor query-string@9.4.0 → exit 1", () => {
    const mutated = withRow(doc, SEC_43, "Remediation floor", "`query-string@9.4.0`");
    const r = runCheck(makeCwd({ docText: mutated }));
    assert.equal(r.status, 1);
    assert.match(r.stdout, /INSIDE vulnerable range/);
    assert.match(r.stdout, /badFloors=1/);
  });
});

describe("A1 — fresh-checkout reproducibility of the documented acceptance sequence", () => {
  let worktree;
  before(() => {
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), "h04-01-fresh-"));
    tmpDirs.push(worktree);
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).stdout.trim();
    const wt = spawnSync("git", ["worktree", "add", "--detach", worktree, head], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(wt.status, 0, wt.stderr);
  });
  after(() => {
    spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd: repoRoot });
  });

  test("artifacts/ is git-ignored and not committed, so a clean checkout has no artifacts/advisories dir", () => {
    const ls = spawnSync("git", ["ls-files", "artifacts"], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(ls.stdout.trim(), "");
    const ignored = spawnSync("git", ["check-ignore", "-q", "artifacts/advisories/pnpm.json"], {
      cwd: repoRoot,
    });
    assert.equal(ignored.status, 0, "artifacts/advisories/pnpm.json is expected to be git-ignored");
    assert.equal(fs.existsSync(path.join(worktree, "artifacts")), false);
  });

  test("the §8.2 fenced sequence contains no mkdir, so its first redirect fails on a clean checkout before any audit runs", () => {
    assert.doesNotMatch(manifestPrefix, /mkdir/);
    // Only the redirect target matters here; the audit itself is not reached
    // because bash resolves the redirection before exec'ing pnpm.
    const r = spawnSync("bash", ["-c", "pnpm audit --json > artifacts/advisories/pnpm.json"], {
      cwd: worktree,
      encoding: "utf8",
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /No such file or directory/);
    assert.equal(fs.existsSync(path.join(worktree, "artifacts/advisories/pnpm.json")), false);
  });

  test('on a clean checkout the node -e check must still reach check (a) and write its log (documented: "audit did not execute" → exit 1)', () => {
    const r = spawnSync(process.execPath, ["-e", script], { cwd: worktree, encoding: "utf8" });
    assert.equal(r.status, 1);
    // Observed: uncaught ENOENT, no "audit report malformed" line, no log.
    assert.match(
      r.stdout,
      /audit report malformed \(audit did not execute\)/,
      "stderr was: " + r.stderr,
    );
    assert.equal(
      fs.existsSync(path.join(worktree, "artifacts/advisories/disposition-coverage.log")),
      true,
    );
  });
});

describe('A2 — "audits executed" detection (check a) when the registry is unreachable', () => {
  const npmEconnrefused = fs.readFileSync(
    path.join(here, "fixtures/npm-audit-econnrefused.json"),
    "utf8",
  );
  const pnpmEconnrefused = fs.readFileSync(
    path.join(here, "fixtures/pnpm-audit-econnrefused.json"),
    "utf8",
  );

  test("captured shapes: npm audit writes a JSON error object; pnpm audit writes an EMPTY stdout", () => {
    const parsed = JSON.parse(npmEconnrefused);
    assert.match(parsed.message, /ECONNREFUSED/);
    assert.ok(parsed.error);
    assert.equal(pnpmEconnrefused, "");
  });

  test('npm audit ECONNREFUSED body → exit 1 with the documented "audit report malformed" log line', () => {
    const r = runCheck(makeCwd({ mobile: npmEconnrefused }));
    assert.equal(r.status, 1);
    assert.match(r.stdout, /audit report malformed \(audit did not execute\)/);
    assert.match(r.log, /audit report malformed[\s\S]*\nexit 1\n$/);
  });

  test('pnpm audit ECONNREFUSED (empty pnpm.json): check (a) must report "audit did not execute" and rewrite the artifact log with exit 1', () => {
    const stale = "advisories=3 missing=0 floors=1 badFloors=0\nexit 0\n";
    const r = runCheck(makeCwd({ pnpm: pnpmEconnrefused, staleLog: stale }));
    assert.equal(r.status, 1);
    // Expected: the documented check-(a) path. Observed: uncaught SyntaxError
    // before check (a) runs; the stale "exit 0" artifact is left in place.
    assert.match(
      r.stdout,
      /audit report malformed \(audit did not execute\)/,
      "stderr was: " + r.stderr,
    );
    assert.notEqual(r.log, stale, "disposition-coverage.log still claims exit 0");
    assert.match(r.log ?? "", /\nexit 1\n$/);
  });

  test("missing mobile.json (npm audit never wrote the file): check (a) must report it and rewrite the artifact log with exit 1", () => {
    const stale = "advisories=3 missing=0 floors=1 badFloors=0\nexit 0\n";
    const r = runCheck(makeCwd({ mobile: null, staleLog: stale }));
    assert.equal(r.status, 1);
    assert.match(
      r.stdout,
      /audit report malformed \(audit did not execute\)/,
      "stderr was: " + r.stderr,
    );
    assert.notEqual(r.log, stale, "disposition-coverage.log still claims exit 0");
  });

  test("audit that ran but reported ZERO advisories (e.g. mirror without advisory data) is NOT a vacuous pass — the floor row trips check (c) because query-string is absent from the report", () => {
    const empty = JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {},
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
        dependencies: { prod: 1, dev: 0, optional: 0, peer: 0, peerOptional: 0, total: 1 },
      },
    });
    const r = runCheck(makeCwd({ mobile: empty }));
    assert.equal(r.status, 1);
    assert.match(r.stdout, /advisories=0 missing=0 floors=1 badFloors=1/);
    assert.match(r.stdout, /package not in audit report/);
  });
});

describe("A3 — disposition-heading regex boundaries (check b)", () => {
  test("a non-final Disposition value is rejected (PENDING)", () => {
    const mutated = withRow(doc, SEC_43, "Disposition", "**PENDING** — awaiting decision");
    const r = runCheck(makeCwd({ docText: mutated }));
    assert.equal(r.status, 1);
    assert.match(r.stdout, /GHSA-vcc3-ghjq-m6fr: MISSING disposition/);
  });

  test('PENDING disposition + a "Disposition history" row that merely QUOTES **ACCEPTED RISK** is accepted as dispositioned', () => {
    let mutated = withRow(doc, SEC_43, "Disposition", "**PENDING** — awaiting decision");
    mutated = appendRow(
      mutated,
      SEC_43,
      "Disposition",
      "| Disposition history | round-2 recorded **ACCEPTED RISK**; superseded by this row |",
    );
    const r = runCheck(makeCwd({ docText: mutated }));
    // Expected: exit 1 (the Disposition row is PENDING). Observed below.
    assert.equal(r.status, 1, "regex matched a row that is not the Disposition row: " + r.stdout);
  });

  test('PENDING disposition + rationale text that NEGATES a keyword ("not **UPGRADED**") is accepted as dispositioned', () => {
    const mutated = withRow(
      doc,
      SEC_43,
      "Disposition",
      "**PENDING** — not **UPGRADED** because 0.5.0 is ESM-only; decision deferred",
    );
    const r = runCheck(makeCwd({ docText: mutated }));
    assert.equal(r.status, 1, "regex accepted a negated keyword: " + r.stdout);
  });

  test("heading demoted to #### (still a heading for a reader) is treated as MISSING — conservative, not a break", () => {
    const mutated = doc.replace(SEC_43, "#" + SEC_43);
    const r = runCheck(makeCwd({ docText: mutated }));
    assert.equal(r.status, 1);
    assert.match(r.stdout, /GHSA-vcc3-ghjq-m6fr: MISSING disposition/);
  });
});

describe("A4 — remediation-floor regex boundaries (check c)", () => {
  test("a SCOPED package floor inside the vulnerable range is silently ignored (floors count unchanged, exit 0)", () => {
    // mobile.json audits @react-navigation/core with range <=8.0.0-alpha.9; 7.21.13 is inside it.
    const mobile = JSON.parse(realMobile);
    assert.ok(
      mobile.vulnerabilities["@react-navigation/core"],
      "fixture assumption: @react-navigation/core is in mobile.json",
    );
    const mutated = appendRow(
      doc,
      SEC_43,
      "Remediation floor",
      "| Remediation floor   | `@react-navigation/core@7.21.13` — navigation major that resolves the fixed query-string |",
    );
    const r = runCheck(makeCwd({ docText: mutated }));
    // Expected: floors=2 badFloors=1 exit 1. Observed below.
    assert.equal(r.status, 1, "scoped floor was not evaluated: " + r.stdout);
  });

  test("a two-component version floor (query-string@9.4) inside the vulnerable range is silently ignored", () => {
    const mutated = withRow(doc, SEC_43, "Remediation floor", "`query-string@9.4`");
    const r = runCheck(makeCwd({ docText: mutated }));
    assert.equal(r.status, 1, "two-component floor was not evaluated: " + r.stdout);
  });

  test("a floor for a package the audit never reported is rejected (badFloors) — conservative", () => {
    const mutated = withRow(doc, SEC_43, "Remediation floor", "`left-pad@9.9.9`");
    const r = runCheck(makeCwd({ docText: mutated }));
    assert.equal(r.status, 1);
    assert.match(r.stdout, /package not in audit report/);
  });

  test("floor at the exact upper boundary of the range (9.4.1) is rejected", () => {
    const mutated = withRow(doc, SEC_43, "Remediation floor", "`query-string@9.4.1`");
    const r = runCheck(makeCwd({ docText: mutated }));
    assert.equal(r.status, 1);
    assert.match(r.stdout, /INSIDE vulnerable range/);
  });
});
