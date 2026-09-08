// H04-01 round-4 adversarial tests for the hardened §8.2 acceptance check and the
// §8.3 negative-control harness embedded in docs/security/ADVISORIES_2026-09-08.md
// (candidate 7aafae061d0eb74e98306b636a5efdbfffed59e1).
//
// The scripts under test are extracted verbatim from the document. Each case runs
// the §8.2 `node -e` payload in a throwaway working directory that mirrors the
// paths the script hard-codes (document, audit reports, apps/mobile/node_modules)
// so exactly one input is mutated per case. Assertions state what the document
// CLAIMS the check does; a failing assertion is a confirmed break.
//
// Prerequisites: `pnpm install --frozen-lockfile`, `(cd apps/mobile && npm ci)`, and
// the §8.2 sequence run once so artifacts/advisories/{mobile,pnpm}.json exist
// (or run `bash` on the §8.2 fence — the B0 test does this itself).
//
// Run: node --test tools/attack/h04-01/r4-acceptance-check.attack.test.mjs

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const DOC_REL = "docs/security/ADVISORIES_2026-09-08.md";
const doc = fs.readFileSync(path.join(repoRoot, DOC_REL), "utf8");

// ---- verbatim extraction of the two fences -----------------------------------------------

function fence82() {
  const start = doc.indexOf(
    "\n```sh\nmkdir -p artifacts/advisories\npnpm audit --json > artifacts/advisories/pnpm.json;",
  );
  assert.ok(start > 0, "§8.2 fence not found");
  const end = doc.indexOf("\n```\n", start + 1);
  const body = doc.slice(start + "\n```sh\n".length, end + 1);
  const marker = "node -e '";
  const s = body.indexOf(marker) + marker.length;
  const e = body.lastIndexOf("'");
  return { shell: body, script: body.slice(s, e) };
}

function fence83() {
  const start = doc.indexOf("\n````sh\nnode - <<'EOF'\n");
  assert.ok(start > 0, "§8.3 fence not found");
  const end = doc.indexOf("\n````\n", start + 1);
  return doc.slice(start + "\n````sh\n".length, end + 1);
}

const { shell: shell82, script } = fence82();
const harness83 = fence83();

const ART = path.join(repoRoot, "artifacts/advisories");
const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

let realMobile;
let realPnpm;
function loadReports() {
  realMobile = fs.readFileSync(path.join(ART, "mobile.json"), "utf8");
  realPnpm = fs.readFileSync(path.join(ART, "pnpm.json"), "utf8");
}

function makeCwd({ docText = doc, mobile = realMobile, pnpm = realPnpm, artifacts = true } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "h04-01-r4-"));
  tmpDirs.push(cwd);
  fs.mkdirSync(path.join(cwd, "docs/security"), { recursive: true });
  fs.writeFileSync(path.join(cwd, DOC_REL), docText);
  fs.mkdirSync(path.join(cwd, "apps/mobile"), { recursive: true });
  fs.symlinkSync(
    path.join(repoRoot, "apps/mobile/node_modules"),
    path.join(cwd, "apps/mobile/node_modules"),
    "dir",
  );
  if (artifacts) {
    fs.mkdirSync(path.join(cwd, "artifacts/advisories"), { recursive: true });
    if (mobile !== null)
      fs.writeFileSync(path.join(cwd, "artifacts/advisories/mobile.json"), mobile);
    if (pnpm !== null) fs.writeFileSync(path.join(cwd, "artifacts/advisories/pnpm.json"), pnpm);
  }
  return cwd;
}

function runCheck(cwd) {
  const r = spawnSync(process.execPath, ["-e", script], { cwd, encoding: "utf8" });
  const logPath = path.join(cwd, "artifacts/advisories/disposition-coverage.log");
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : null;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, log };
}

// ---- document surgery helpers (same conventions as the §8.3 harness) ---------------------

const S43 = "### 4.3 GHSA-vcc3-ghjq-m6fr";
const sectionOf = (text, heading) => {
  const a = text.indexOf(heading);
  assert.ok(a >= 0, "heading not found: " + heading);
  let b = text.indexOf("\n### ", a + 1);
  if (b < 0) b = text.length;
  return [a, b];
};
const setRow = (text, heading, label, body) => {
  const [a, b] = sectionOf(text, heading);
  const re = new RegExp("^\\| " + label + " +\\|[^\\n]*$", "m");
  const sec = text.slice(a, b);
  assert.ok(re.test(sec), "row not found: " + label);
  return text.slice(0, a) + sec.replace(re, "| " + label + " | " + body + " |") + text.slice(b);
};
const dropRow = (text, heading, label) => {
  const [a, b] = sectionOf(text, heading);
  const re = new RegExp("^\\| " + label + " +\\|[^\\n]*\\n", "m");
  const sec = text.slice(a, b);
  assert.ok(re.test(sec), "row not found: " + label);
  return text.slice(0, a) + sec.replace(re, "") + text.slice(b);
};
const appendToSection = (text, heading, extra) => {
  const [, b] = sectionOf(text, heading);
  return text.slice(0, b) + "\n" + extra + "\n" + text.slice(b);
};

/** Minimal GitHub-flavoured Markdown rendering model: strip HTML comments and fenced code. */
function visibleTableRows(text) {
  const noComments = text.replace(/<!--[\s\S]*?-->/g, "");
  const noFences = noComments.replace(/^(`{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, "");
  return noFences.split("\n").filter((l) => /^\|/.test(l));
}

// ---- B0: baseline — the committed sequence run through a real shell ----------------------

describe("B0 baseline — §8.2 and §8.3 fences run VERBATIM through bash from the repo root", () => {
  test("§8.2 fence (mkdir; pnpm audit; npm audit; node -e) exits 0 and reports advisories=3 missing=0 stale=0 floors=1 badFloors=0", () => {
    const r = spawnSync("bash", ["-c", shell82], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /advisories=3 missing=0 stale=0 floors=1 badFloors=0/);
    assert.match(r.stdout, /GHSA-vcc3-ghjq-m6fr: dispositioned ACCEPTED RISK/);
    assert.match(r.stdout, /GHSA-w3rx-r6r6-pgpr: dispositioned ACCEPTED RISK/);
    assert.match(r.stdout, /GHSA-5p2g-fcmc-qvqq: dispositioned ACCEPTED RISK/);
    const log = fs.readFileSync(path.join(ART, "disposition-coverage.log"), "utf8");
    assert.ok(log.endsWith("\nexit 0\n"), log);
    loadReports();
  });

  test("fresh audits today still contain exactly the 3 GHSA ids / 16 labels / 388 pnpm deps the document describes (no drift since the review)", () => {
    loadReports();
    const m = JSON.parse(realMobile);
    const p = JSON.parse(realPnpm);
    assert.deepEqual(m.metadata.vulnerabilities, {
      info: 0,
      low: 0,
      moderate: 7,
      high: 9,
      critical: 0,
      total: 16,
    });
    assert.equal(Object.keys(m.vulnerabilities).length, 16);
    const ids = new Set();
    for (const v of Object.values(m.vulnerabilities))
      for (const via of v.via) if (via && via.url) ids.add(via.url.split("/").pop());
    assert.deepEqual([...ids].sort(), [
      "GHSA-5p2g-fcmc-qvqq",
      "GHSA-vcc3-ghjq-m6fr",
      "GHSA-w3rx-r6r6-pgpr",
    ]);
    assert.equal(Object.keys(p.advisories || {}).length, 0);
    assert.equal(p.metadata.dependencies, 388);
  });

  test("§8.3 harness fence exits 0 with controls=21 failed=0 (candidate's own claim reproduces)", () => {
    const r = spawnSync("bash", ["-c", harness83], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /controls=21 failed=0/);
  });
});

// ---- B1: rows the RENDERED document does not show still satisfy the check ----------------

describe("B1 — a Disposition row hidden from the rendered document is counted as the disposition (§8.2 b claims table parsing, not keyword search)", () => {
  test("§4.3 real Disposition row deleted + the same row inside an HTML comment → check still exits 0", () => {
    loadReports();
    const mutated = appendToSection(
      dropRow(doc, S43, "Disposition"),
      S43,
      "<!--\n| Disposition | **ACCEPTED RISK** — hidden from every Markdown renderer |\n-->",
    );
    // The rendered §4.3 table has NO Disposition row at all.
    const [a, b] = sectionOf(mutated, S43);
    const visible = visibleTableRows(mutated.slice(a, b)).filter((l) =>
      /^\| Disposition +\|/.test(l),
    );
    assert.equal(visible.length, 0, "precondition: the rendered section shows no Disposition row");
    const r = runCheck(makeCwd({ docText: mutated }));
    assert.equal(r.status, 1, "expected MISSING disposition; got exit 0:\n" + r.stdout);
    assert.match(r.stdout, /GHSA-vcc3-ghjq-m6fr: MISSING disposition/);
  });

  test("§4.3 real Disposition row deleted + the same row inside a fenced code block → check still exits 0", () => {
    loadReports();
    const mutated = appendToSection(
      dropRow(doc, S43, "Disposition"),
      S43,
      "```\n| Disposition | **ACCEPTED RISK** — rendered as code, not as a table |\n```",
    );
    const r = runCheck(makeCwd({ docText: mutated }));
    assert.equal(r.status, 1, "expected MISSING disposition; got exit 0:\n" + r.stdout);
  });

  test("whole dispositioned §4.3 wrapped in an HTML comment, followed by a VISIBLE §4.3 whose Disposition is **PENDING** → check exits 0 (first heading wins, hidden or not)", () => {
    loadReports();
    const [a, b] = sectionOf(doc, S43);
    const hidden = doc.slice(a, b);
    const visiblePending =
      S43 +
      " / CVE-2026-45822 — `decode-uri-component` exponential decoding DoS\n\n| Aspect | Finding |\n| --- | --- |\n| Disposition | **PENDING** — awaiting a decision |\n";
    const mutated =
      doc.slice(0, a) + "<!--\n" + hidden + "\n-->\n\n" + visiblePending + doc.slice(b);
    // What a reader sees: one §4.3, disposition PENDING.
    const rows = visibleTableRows(mutated).filter((l) => /^\| Disposition +\|/.test(l));
    assert.equal(rows.filter((l) => /PENDING/.test(l)).length, 1);
    assert.equal(
      rows.filter((l) => /ACCEPTED RISK/.test(l)).length,
      2,
      "only §4.1 and §4.2 remain ACCEPTED RISK in the rendered doc",
    );
    const r = runCheck(makeCwd({ docText: mutated }));
    assert.equal(
      r.status,
      1,
      "expected MISSING disposition for the visible PENDING §4.3; got exit 0:\n" + r.stdout,
    );
  });
});

// ---- B2: advisories without a GHSA id are silently dropped from the criterion ------------

describe('B2 — "every advisory has a disposition" only counts advisories that carry a GHSA id; others vanish from the check', () => {
  test("pnpm.json reporting 1 high advisory whose github_advisory_id is null → check exits 0 with advisories=3 and never names the advisory", () => {
    loadReports();
    const p = JSON.parse(realPnpm);
    p.advisories = {
      1234: {
        id: 1234,
        module_name: "left-pad",
        severity: "high",
        title: "Fixture advisory without a GHSA id",
        url: "https://npmjs.com/advisories/1234",
        github_advisory_id: null,
        cves: ["CVE-2026-0001"],
        vulnerable_versions: "<1.0.0",
        patched_versions: ">=1.0.0",
        findings: [{ version: "0.1.0", paths: ["left-pad"] }],
      },
    };
    p.metadata.vulnerabilities.high = 1;
    const r = runCheck(makeCwd({ pnpm: JSON.stringify(p) }));
    assert.equal(r.status, 1, "pnpm metadata says high=1 but the check passed:\n" + r.stdout);
  });

  test("mobile.json with an extra labelled package whose `via` object has a non-GHSA url → exit 0, metadata total=17 while advisories=3", () => {
    loadReports();
    const m = JSON.parse(realMobile);
    m.vulnerabilities["left-pad"] = {
      name: "left-pad",
      severity: "high",
      isDirect: false,
      via: [
        {
          source: 1234,
          name: "left-pad",
          dependency: "left-pad",
          title: "Fixture advisory with an npm (non-GHSA) url",
          url: "https://npmjs.com/advisories/1234",
          severity: "high",
          cwe: [],
          cvss: {},
          range: "<1.0.0",
        },
      ],
      effects: [],
      range: "<1.0.0",
      nodes: ["node_modules/left-pad"],
      fixAvailable: true,
    };
    m.metadata.vulnerabilities.high += 1;
    m.metadata.vulnerabilities.total += 1;
    const r = runCheck(makeCwd({ mobile: JSON.stringify(m) }));
    assert.equal(
      r.status,
      1,
      "npm metadata total=17 but the check passed with advisories=3:\n" + r.stdout,
    );
  });

  test("the check never reconciles metadata.vulnerabilities totals against the GHSA ids it extracted (a report whose every `via` lost its url passes with advisories=0 when the doc has no GHSA headings)", () => {
    loadReports();
    const m = JSON.parse(realMobile);
    for (const v of Object.values(m.vulnerabilities))
      v.via = v.via.map((via) =>
        via && typeof via === "object"
          ? { ...via, url: "https://npmjs.com/advisories/" + via.source }
          : via,
      );
    // Document variant with no GHSA sections at all (as a clean-tree review would be written).
    const noSections = doc
      .split("\n")
      .filter((l) => !/^### [0-9.]+ GHSA-/.test(l))
      .join("\n")
      .replace(/^\| Remediation floor +\|[^\n]*\n/m, "");
    const r = runCheck(makeCwd({ docText: noSections, mobile: JSON.stringify(m) }));
    assert.equal(
      r.status,
      1,
      "16 labelled vulnerabilities (metadata total=16) but check passed:\n" + r.stdout,
    );
  });
});

// ---- B3: remediation-floor boundary — prerelease versions inside the range ---------------

describe("B3 — §8.2 (d) claims a floor is rejected when it satisfies the audited range; prerelease versions numerically inside `5.0.0 - 9.4.1` are accepted", () => {
  for (const ver of ["9.4.1-beta.0", "9.0.0-rc.1", "5.0.0-alpha.1"]) {
    test(`floor query-string@${ver} (inside 5.0.0 - 9.4.1 by version ordering) → reported "outside vulnerable range", exit 0`, () => {
      loadReports();
      const mutated = setRow(doc, S43, "Remediation floor", "`query-string@" + ver + "`");
      const r = runCheck(makeCwd({ docText: mutated }));
      assert.equal(r.status, 1, `prerelease ${ver} accepted as outside the range:\n` + r.stdout);
      assert.match(r.stdout, /INSIDE vulnerable range/);
    });
  }

  test("semver ordering ground truth: 9.4.1-beta.0 < 9.4.1 and > 5.0.0, and satisfies the audited range once prereleases are considered", () => {
    const semverMod = require_(path.join(repoRoot, "apps/mobile/node_modules/semver"));
    assert.ok(semverMod.lt("9.4.1-beta.0", "9.4.1"));
    assert.ok(semverMod.gt("9.4.1-beta.0", "5.0.0"));
    assert.equal(
      semverMod.satisfies("9.4.1-beta.0", "5.0.0 - 9.4.1"),
      false,
      "default semver mode excludes prereleases — the check relies on this",
    );
    assert.equal(
      semverMod.satisfies("9.4.1-beta.0", "5.0.0 - 9.4.1", { includePrerelease: true }),
      true,
    );
  });

  test('floor query-string@99.0.0 (no such release on the registry) is accepted as a "real" floor (§8.2 d wording) — existence is never checked', () => {
    loadReports();
    const mutated = setRow(doc, S43, "Remediation floor", "`query-string@99.0.0`");
    const r = runCheck(makeCwd({ docText: mutated }));
    assert.equal(r.status, 1, "non-existent version accepted as remediation floor:\n" + r.stdout);
  });
});

// ---- B4: disposition vocabulary vs audit state -------------------------------------------

describe("B4 — a disposition that contradicts the audit report is accepted", () => {
  test("§4.3 Disposition = **NOT APPLICABLE** (defined in §4 as 'package not present') while mobile.json still reports decode-uri-component@0.2.2 → exit 0", () => {
    loadReports();
    const m = JSON.parse(realMobile);
    assert.ok(
      m.vulnerabilities["decode-uri-component"],
      "precondition: package present in the audit",
    );
    const mutated = setRow(doc, S43, "Disposition", "**NOT APPLICABLE** — package not present");
    const r = runCheck(makeCwd({ docText: mutated }));
    assert.equal(
      r.status,
      1,
      "NOT APPLICABLE accepted for a package the audit reports as present:\n" + r.stdout,
    );
  });

  test("§4.3 Disposition = **UPGRADED** while the fresh audit still reports the identical vulnerable version → exit 0", () => {
    loadReports();
    const mutated = setRow(
      doc,
      S43,
      "Disposition",
      "**UPGRADED** — dependency changed in this review",
    );
    const r = runCheck(makeCwd({ docText: mutated }));
    assert.equal(
      r.status,
      1,
      "UPGRADED accepted although the advisory is still reported:\n" + r.stdout,
    );
  });
});

// ---- B5: the §8.3 harness itself on a clean checkout -------------------------------------

describe("B5 — §8.3 harness on a clean checkout (artifacts/ absent): the same uncaught-ENOENT class §9 says round 4 fixed for §8.2", () => {
  test("harness exits 1 with an uncaught ENOENT stack trace on stderr and writes no negative-controls log", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "h04-01-r4-clean-"));
    tmpDirs.push(cwd);
    fs.mkdirSync(path.join(cwd, "docs/security"), { recursive: true });
    fs.writeFileSync(path.join(cwd, DOC_REL), doc);
    fs.mkdirSync(path.join(cwd, "apps/mobile"), { recursive: true });
    fs.symlinkSync(
      path.join(repoRoot, "apps/mobile/node_modules"),
      path.join(cwd, "apps/mobile/node_modules"),
      "dir",
    );
    const r = spawnSync("bash", ["-c", harness83], { cwd, encoding: "utf8" });
    const logPath = path.join(
      cwd,
      "artifacts/advisories/disposition-coverage.negative-controls.log",
    );
    // Documented contract for the sibling §8.2 check: diagnose on stdout, always write the log.
    assert.notEqual(r.status, 0);
    assert.ok(
      fs.existsSync(logPath),
      "harness left no artifact; stderr was:\n" + r.stderr.slice(0, 400),
    );
    assert.doesNotMatch(
      r.stderr,
      /ENOENT/,
      "uncaught ENOENT instead of a diagnosed 'audit did not execute'",
    );
  });
});

// ---- B6: network failure at the audit step, run for real through the committed fence ----

describe("B6 — registry unreachable while the manifest command runs (npm_config_registry → closed port)", () => {
  test("§8.2 fence exits 1, diagnoses 'audit did not execute' on stdout, and does not leave a stale exit-0 log behind", () => {
    loadReports();
    const cwd = makeCwd({ artifacts: false });
    // Give the throwaway checkout a real lockfile-less pnpm workspace root and the mobile manifest,
    // so both audit commands actually run against the unreachable registry.
    fs.copyFileSync(path.join(repoRoot, "package.json"), path.join(cwd, "package.json"));
    fs.copyFileSync(path.join(repoRoot, "pnpm-lock.yaml"), path.join(cwd, "pnpm-lock.yaml"));
    fs.copyFileSync(
      path.join(repoRoot, "pnpm-workspace.yaml"),
      path.join(cwd, "pnpm-workspace.yaml"),
    );
    fs.copyFileSync(
      path.join(repoRoot, "apps/mobile/package.json"),
      path.join(cwd, "apps/mobile/package.json"),
    );
    fs.copyFileSync(
      path.join(repoRoot, "apps/mobile/package-lock.json"),
      path.join(cwd, "apps/mobile/package-lock.json"),
    );
    // A stale success log from an earlier good run must be overwritten, not left as evidence.
    fs.mkdirSync(path.join(cwd, "artifacts/advisories"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "artifacts/advisories/disposition-coverage.log"),
      "advisories=3 missing=0 stale=0 floors=1 badFloors=0\nexit 0\n",
    );
    const r = spawnSync("bash", ["-c", shell82], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        npm_config_registry: "http://127.0.0.1:9/",
        npm_config_fetch_retries: "0",
        npm_config_fetch_retry_mintimeout: "1",
        npm_config_fetch_retry_maxtimeout: "1",
        npm_config_audit_level: "none",
      },
      timeout: 120000,
    });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /audit did not execute/);
    const log = fs.readFileSync(
      path.join(cwd, "artifacts/advisories/disposition-coverage.log"),
      "utf8",
    );
    assert.ok(log.endsWith("\nexit 1\n"), "stale exit-0 log survived a failed audit:\n" + log);
  });
});

// ---- B7: semver dependency absent (npm ci not run) ---------------------------------------

describe("B7 — apps/mobile/node_modules/semver absent: §8.2 (d) says the check fails rather than guesses", () => {
  test("exit 1 with the documented 'semver unavailable' line and a written log", () => {
    loadReports();
    const cwd = makeCwd();
    fs.unlinkSync(path.join(cwd, "apps/mobile/node_modules"));
    fs.mkdirSync(path.join(cwd, "apps/mobile/node_modules"));
    const r = runCheck(cwd);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /semver unavailable/);
    assert.ok(r.log && r.log.endsWith("\nexit 1\n"));
    assert.equal(r.stderr.trim(), "");
  });
});

// ---- B9: corrupt persisted report that passes wellFormed() ------------------------------

describe("B9 — corrupt mobile.json that passes wellFormed() (metadata intact, `vulnerabilities` key absent/null): §8.2 says the log is ALWAYS written and malformed reports are diagnosed on stdout", () => {
  for (const [name, mutate] of [
    [
      "vulnerabilities key deleted",
      (m) => {
        delete m.vulnerabilities;
      },
    ],
    [
      "vulnerabilities: null",
      (m) => {
        m.vulnerabilities = null;
      },
    ],
  ]) {
    test(`${name} → exits via finish() with a written log and nothing on stderr (no uncaught TypeError)`, () => {
      loadReports();
      const m = JSON.parse(realMobile);
      mutate(m);
      const r = runCheck(makeCwd({ mobile: JSON.stringify(m) }));
      assert.equal(r.status, 1);
      assert.doesNotMatch(r.stderr, /TypeError/, "uncaught exception:\n" + r.stderr.slice(0, 300));
      assert.ok(
        r.log !== null && r.log.endsWith("\nexit 1\n"),
        "disposition-coverage.log not written",
      );
    });
  }

  test("truncated mobile.json (npm killed mid-write) is diagnosed as SyntaxError with a written exit-1 log", () => {
    loadReports();
    const r = runCheck(
      makeCwd({ mobile: realMobile.slice(0, Math.floor(realMobile.length * 0.6)) }),
    );
    assert.equal(r.status, 1);
    assert.match(r.stdout, /mobile\.json: SyntaxError \(audit did not execute\)/);
    assert.ok(r.log && r.log.endsWith("\nexit 1\n"));
    assert.equal(r.stderr.trim(), "");
  });
});

// ---- B8: CRLF checkout (core.autocrlf) of the same document ------------------------------

describe("B8 — the document checked out with CRLF line endings", () => {
  test("check still recognises the three dispositions (exit 0) — or reports MISSING for a byte-identical rendered document", () => {
    loadReports();
    const r = runCheck(makeCwd({ docText: doc.replace(/\n/g, "\r\n") }));
    assert.equal(r.status, 0, "CRLF document rejected:\n" + r.stdout);
    assert.match(r.stdout, /advisories=3 missing=0 stale=0 floors=1 badFloors=0/);
  });
});
