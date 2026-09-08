// H04-01 adversarial re-verification of the registry / advisory facts the
// candidate document (docs/security/ADVISORIES_2026-09-08.md §4, §6, §7)
// relies on for its three ACCEPTED RISK dispositions. Each assertion is a
// claim quoted from the document; a failure means the document is wrong.
//
// Network: npm registry + api.github.com (unauthenticated advisory endpoint).
// Run: node --test tools/attack/h04-01/registry-facts.attack.test.mjs

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const doc = fs.readFileSync(path.join(repoRoot, "docs/security/ADVISORIES_2026-09-08.md"), "utf8");
const mobile = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "artifacts/advisories/mobile.json"), "utf8"),
);

function npmView(spec, field) {
  const r = spawnSync("npm", ["view", spec, field, "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, `npm view ${spec} ${field}: ${r.stderr}`);
  return r.stdout.trim() === "" ? undefined : JSON.parse(r.stdout);
}

// Same source the document cites (§2 #10): `gh api /advisories/<id>`.
function ghAdvisory(id) {
  const r = spawnSync("gh", ["api", `/advisories/${id}`], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(r.status, 0, `gh api /advisories/${id}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("A5 — §4.3 decode-uri-component / query-string remediation floor", () => {
  test("doc names query-string@9.5.0 as the remediation floor and says 9.4.x is insufficient", () => {
    assert.match(doc, /^\| Remediation floor +\| `query-string@9\.5\.0`/m);
    assert.match(doc, /9\.4\.x|\^9\.4\.0/);
  });

  test("registry: 9.4.0 and 9.4.1 depend on decode-uri-component ^0.4.1 (vulnerable), 9.5.0 is the first on ^0.5.0", () => {
    assert.equal(npmView("query-string@9.4.0", "dependencies.decode-uri-component"), "^0.4.1");
    assert.equal(npmView("query-string@9.4.1", "dependencies.decode-uri-component"), "^0.4.1");
    assert.equal(npmView("query-string@9.5.0", "dependencies.decode-uri-component"), "^0.5.0");
    assert.equal(npmView("query-string@9.5.1", "dependencies.decode-uri-component"), "^0.5.0");
  });

  test("audited vulnerable range for query-string is 5.0.0 - 9.4.1 (so 9.5.0 is the first release outside it)", () => {
    assert.equal(mobile.vulnerabilities["query-string"].range, "5.0.0 - 9.4.1");
    assert.equal(mobile.vulnerabilities["decode-uri-component"].range, "<=0.4.2");
  });

  test('9.5.0 was published ≥ 7 days before the review date (2026-09-08) — the ≥7-day rule would have allowed it, so "no compatible upgrade" must rest on compatibility, not age', () => {
    const times = npmView("query-string", "time");
    const published = new Date(times["9.5.0"]);
    const reviewDate = new Date("2026-09-08T00:00:00Z");
    assert.ok(reviewDate - published >= 7 * 24 * 3600 * 1000, `9.5.0 published ${times["9.5.0"]}`);
  });

  test("installed @react-navigation/core@7.21.13 declares query-string ^7.1.3, and @next (8.0.0-alpha.x) declares ^9.4.0 which still admits 9.4.x", () => {
    const installed = JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, "apps/mobile/node_modules/@react-navigation/core/package.json"),
        "utf8",
      ),
    );
    assert.equal(installed.version, "7.21.13");
    assert.equal(installed.dependencies["query-string"], "^7.1.3");
    const tags = npmView("@react-navigation/core", "dist-tags");
    assert.equal(tags.latest, "7.21.13");
    assert.match(tags.next, /^8\.0\.0-alpha\./);
    assert.equal(
      npmView(`@react-navigation/core@${tags.next}`, "dependencies.query-string"),
      "^9.4.0",
    );
    const semver = createRequire(path.join(repoRoot, "apps/mobile/package.json"))("semver");
    assert.equal(semver.satisfies("9.4.1", "^9.4.0"), true);
    assert.equal(semver.satisfies("9.4.1", ">=9.5.0"), false);
  });

  test('decode-uri-component@0.5.0 is ESM-only ("type": "module") — the doc\'s stated reason an override breaks query-string@7', () => {
    assert.equal(npmView("decode-uri-component@0.5.0", "type"), "module");
    assert.equal(npmView("decode-uri-component", "dist-tags.latest"), "0.5.0");
  });

  test("§2 #14 override probe reproduces: query-string@7.1.3 + overrides decode-uri-component@0.5.0 → parse() throws", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "h04-01-override-"));
    tmpDirs.push(dir);
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "probe",
        private: true,
        dependencies: { "query-string": "7.1.3" },
        overrides: { "decode-uri-component": "0.5.0" },
      }),
    );
    const install = spawnSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(install.status, 0, install.stderr);
    const installed = JSON.parse(
      fs.readFileSync(path.join(dir, "node_modules/decode-uri-component/package.json"), "utf8"),
    );
    assert.equal(installed.version, "0.5.0");
    const probe = spawnSync(
      process.execPath,
      [
        "-e",
        "const q=require('query-string'); console.log(q.stringify({a:'b c'},{sort:false})); console.log(q.parse('a=%20b'))",
      ],
      { cwd: dir, encoding: "utf8" },
    );
    assert.notEqual(probe.status, 0, "expected parse() to throw under the override");
    assert.match(probe.stderr, /TypeError/);
  });
});

describe("A5 — §4.1/§4.2 image-size and metro facts", () => {
  test("GitHub advisory metadata: both image-size advisories have NO patched version and range <= 2.0.2", () => {
    for (const id of ["GHSA-w3rx-r6r6-pgpr", "GHSA-5p2g-fcmc-qvqq"]) {
      const adv = ghAdvisory(id);
      const vulns = adv.vulnerabilities.filter(
        (v) => v.package.ecosystem === "npm" && v.package.name === "image-size",
      );
      assert.ok(vulns.length > 0, `${id}: no npm/image-size entry`);
      for (const v of vulns) {
        assert.equal(
          v.first_patched_version,
          null,
          `${id}: first_patched_version=${v.first_patched_version}`,
        );
        assert.equal(v.vulnerable_version_range, "<= 2.0.2");
      }
    }
  });

  test("registry: newest image-size releases (2.0.2, 1.2.1) both predate the advisories and sit inside the range", () => {
    const times = npmView("image-size", "time");
    assert.equal(npmView("image-size", "dist-tags.latest"), "2.0.2");
    assert.ok(times["2.0.2"].startsWith("2025-04-02"));
    assert.ok(times["1.2.1"].startsWith("2025-04-02"));
    const newer = Object.entries(times)
      .filter(([k]) => !["created", "modified"].includes(k))
      .filter(([, t]) => new Date(t) > new Date("2025-04-03T00:00:00Z"));
    assert.deepEqual(newer, [], "a newer image-size release exists: " + JSON.stringify(newer));
  });

  test("metro: 0.84.5/0.84.6 dropped image-size, but 0.87.0 (newest, and the only line RN 0.87.1 accepts) still declares image-size ^1.0.2", () => {
    assert.equal(npmView("metro@0.84.5", "dependencies.image-size"), undefined);
    assert.equal(npmView("metro@0.84.6", "dependencies.image-size"), undefined);
    assert.equal(npmView("metro@0.87.0", "dependencies.image-size"), "^1.0.2");
    assert.equal(npmView("metro", "dist-tags.latest"), "0.87.0");
    const cli = JSON.parse(
      fs.readFileSync(
        path.join(
          repoRoot,
          "apps/mobile/node_modules/@react-native/community-cli-plugin/package.json",
        ),
        "utf8",
      ),
    );
    assert.equal(cli.dependencies.metro, "^0.87.0");
    const installedMetro = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "apps/mobile/node_modules/metro/package.json"), "utf8"),
    );
    assert.equal(installedMetro.version, "0.87.0");
    assert.equal(installedMetro.dependencies["image-size"], "^1.0.2");
  });

  test('repo assets contain no .icns/.jxl/.heif/.heic input for image-size (doc §4.1 "Untrusted input? No")', () => {
    const r = spawnSync("git", ["ls-files", "apps/mobile"], { cwd: repoRoot, encoding: "utf8" });
    const risky = r.stdout.split("\n").filter((f) => /\.(icns|jxl|heif|heic)$/i.test(f));
    assert.deepEqual(risky, []);
  });
});
