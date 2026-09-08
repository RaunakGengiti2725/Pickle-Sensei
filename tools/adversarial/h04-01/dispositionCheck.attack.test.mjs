// H04-01 adversarial suite — attacks on the §8.2 acceptance check of
// docs/security/ADVISORIES_2026-09-08.md. The check is extracted VERBATIM from the doc's
// fenced block and executed against crafted audit reports in a sandbox directory, so the
// candidate's own machine check is what is being probed (no candidate file is modified).
//
// Run: node --test tools/adversarial/h04-01/
import assert from "node:assert/strict";
import test from "node:test";

import {
  DOC_GHSA_IDS,
  EMPTY_PNPM_REPORT,
  extractDispositionCheckScript,
  npmAuditReport,
  pnpmAuditReport,
  readDoc,
  runDispositionCheck,
  writeArtifact,
} from "./helpers.mjs";

const GHSA_NOT_IN_DOC = "GHSA-aaaa-bbbb-cccc";

function viaFor(id, extra = {}) {
  return {
    source: 1,
    name: "some-package",
    dependency: "some-package",
    title: "synthetic advisory",
    url: `https://github.com/advisories/${id}`,
    severity: "moderate",
    cwe: [],
    cvss: { score: 0, vectorString: null },
    range: "<1.0.0",
    ...extra,
  };
}

function mobileWith(vias) {
  return npmAuditReport({
    "some-package": {
      name: "some-package",
      severity: "moderate",
      isDirect: true,
      via: vias,
      effects: [],
      range: "<1.0.0",
      nodes: ["node_modules/some-package"],
      fixAvailable: false,
    },
  });
}

test("A1 positive control: the three documented GHSA ids pass the extracted check (exit 0)", () => {
  const res = runDispositionCheck(
    { mobile: mobileWith(DOC_GHSA_IDS.map((id) => viaFor(id))), pnpm: EMPTY_PNPM_REPORT },
    "positive",
  );
  writeArtifact("A1-positive.log", res.stdout + res.stderr);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /advisories=3 missing=0/);
});

test("A2 negative control: an undispositioned GHSA in mobile.json fails the check (exit 1)", () => {
  const res = runDispositionCheck(
    { mobile: mobileWith([viaFor(GHSA_NOT_IN_DOC)]), pnpm: EMPTY_PNPM_REPORT },
    "mobile-missing",
  );
  writeArtifact("A2-mobile-missing.log", res.stdout + res.stderr);
  assert.equal(res.status, 1);
  assert.match(res.stdout, new RegExp(`${GHSA_NOT_IN_DOC}: MISSING disposition`));
});

test("A3 negative control: an undispositioned pnpm advisory (github_advisory_id) fails the check", () => {
  const pnpm = pnpmAuditReport({
    1: {
      github_advisory_id: GHSA_NOT_IN_DOC,
      module_name: "some-package",
      severity: "high",
      url: `https://github.com/advisories/${GHSA_NOT_IN_DOC}`,
      vulnerable_versions: "<1.0.0",
    },
  });
  const res = runDispositionCheck({ mobile: npmAuditReport({}), pnpm }, "pnpm-missing");
  writeArtifact("A3-pnpm-missing.log", res.stdout + res.stderr);
  assert.equal(res.status, 1);
});

test("A4 negative control: blanking a Disposition row fails the check", () => {
  const doc = readDoc().replace(
    /\| Disposition {9}\| \*\*ACCEPTED RISK\*\* — identical rationale to §4\.1/,
    "| Disposition         | TBD",
  );
  assert.notEqual(doc, readDoc(), "fixture did not modify the §4.2 Disposition row");
  const res = runDispositionCheck(
    { mobile: mobileWith(DOC_GHSA_IDS.map((id) => viaFor(id))), pnpm: EMPTY_PNPM_REPORT, doc },
    "blanked",
  );
  assert.equal(res.status, 1);
  assert.match(res.stdout, /GHSA-5p2g-fcmc-qvqq: MISSING disposition/);
});

test("A5 FAIL-OPEN: an advisory whose `via.url` carries no GHSA id passes the check although metadata reports 1 vulnerability", () => {
  // npm's legacy advisory URLs (https://npmjs.com/advisories/<n>) and mirrors that publish
  // CVE-only urls have no GHSA token; the check silently drops the advisory instead of
  // failing, so "every advisory has a disposition" is not what it proves.
  const mobile = mobileWith([
    viaFor(GHSA_NOT_IN_DOC, { url: "https://www.npmjs.com/advisories/1234" }),
  ]);
  const res = runDispositionCheck({ mobile, pnpm: EMPTY_PNPM_REPORT }, "no-ghsa-url");
  writeArtifact("A5-no-ghsa-url.log", res.stdout + res.stderr);
  assert.equal(mobile.metadata.vulnerabilities.total, 1);
  assert.equal(
    res.status,
    1,
    `expected exit 1 for an advisory without a disposition; got ${res.status}: ${res.stdout}`,
  );
});

test("A6 FAIL-OPEN: an advisory whose `via.url` is null passes the check although metadata reports 1 vulnerability", () => {
  const mobile = mobileWith([viaFor(GHSA_NOT_IN_DOC, { url: null })]);
  const res = runDispositionCheck({ mobile, pnpm: EMPTY_PNPM_REPORT }, "null-url");
  writeArtifact("A6-null-url.log", res.stdout + res.stderr);
  assert.equal(res.status, 1, `got ${res.status}: ${res.stdout}`);
});

test("A7 FAIL-OPEN: a pnpm advisory without `github_advisory_id` passes the check although metadata reports 1 high", () => {
  const pnpm = pnpmAuditReport({
    1: {
      module_name: "some-package",
      severity: "high",
      url: "https://www.npmjs.com/advisories/1234",
      vulnerable_versions: "<1.0.0",
    },
  });
  const res = runDispositionCheck({ mobile: npmAuditReport({}), pnpm }, "pnpm-no-ghsa");
  writeArtifact("A7-pnpm-no-ghsa.log", res.stdout + res.stderr);
  assert.equal(pnpm.metadata.vulnerabilities.high, 1);
  assert.equal(res.status, 1, `got ${res.status}: ${res.stdout}`);
});

test("A8 FAIL-OPEN: metadata total > 0 but zero identifiable ids is not treated as a discrepancy", () => {
  // Same class as A5–A7 from the other side: the check never reconciles the ids it found
  // against metadata.vulnerabilities.total, so "advisories=0 missing=0" is printed while the
  // report itself says total=16.
  const mobile = mobileWith([viaFor(GHSA_NOT_IN_DOC, { url: null })]);
  mobile.metadata.vulnerabilities.total = 16;
  mobile.metadata.vulnerabilities.high = 9;
  mobile.metadata.vulnerabilities.moderate = 7;
  const res = runDispositionCheck({ mobile, pnpm: EMPTY_PNPM_REPORT }, "total-mismatch");
  writeArtifact("A8-total-mismatch.log", res.stdout + res.stderr);
  assert.equal(res.status, 1, `got ${res.status}: ${res.stdout}`);
});

test("A9 fail-closed: malformed reports (missing metadata / npm error object) exit non-zero", () => {
  const malformed = runDispositionCheck(
    {
      mobile: { error: { code: "ENOAUDIT", summary: "registry unreachable" } },
      pnpm: EMPTY_PNPM_REPORT,
    },
    "npm-error",
  );
  assert.notEqual(malformed.status, 0);
  const noVulnMap = runDispositionCheck(
    { mobile: { metadata: { vulnerabilities: { total: 0 } } }, pnpm: EMPTY_PNPM_REPORT },
    "no-vuln-map",
  );
  assert.notEqual(noVulnMap.status, 0);
});

test("A10 scope gap: the machine check never reads a deno audit result", () => {
  // The objective covers "npm/pnpm audit and deno lock review", but the §8.2 program only
  // consumes mobile.json and pnpm.json; a Deno-only advisory (e.g. a jsr package in
  // supabase/functions/api/__wf__/deno.lock, which the doc does not review) cannot fail it.
  const { nodeScript, manifestCommand } = extractDispositionCheckScript();
  writeArtifact("A10-extracted-check.sh", `${manifestCommand}\nnode -e '${nodeScript}'\n`);
  assert.equal(
    /deno/i.test(manifestCommand + nodeScript),
    true,
    "the acceptance check consumes no deno audit output: a Deno-only advisory can never fail it",
  );
});
