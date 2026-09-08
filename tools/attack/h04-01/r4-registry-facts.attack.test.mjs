// H04-01 round-4 fact re-verification: every registry / GitHub-advisory / lockfile / tree
// statement the corrected r4 document (docs/security/ADVISORIES_2026-09-08.md at 7aafae06)
// asserts as VERIFIED is re-derived here from the live sources. A failing assertion means the
// document states a fact the registry or the checkout contradicts.
//
// Needs network access to registry.npmjs.org and api.github.com plus `(cd apps/mobile && npm ci)`.
// Run: node --test tools/attack/h04-01/r4-registry-facts.attack.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const doc = fs.readFileSync(path.join(repoRoot, "docs/security/ADVISORIES_2026-09-08.md"), "utf8");

function npmView(spec, field) {
  const r = spawnSync("npm", ["view", spec, field, "--json"], {
    encoding: "utf8",
    cwd: os.tmpdir(),
  });
  assert.equal(r.status, 0, `npm view ${spec} ${field}: ${r.stderr}`);
  return r.stdout.trim() === "" ? undefined : JSON.parse(r.stdout);
}

// Same source the document cites (§2 #10: `gh api /advisories/<id>`); authenticated `gh` avoids the
// 60/h anonymous rate limit, anonymous fetch is the fallback when gh is absent.
async function ghsa(id) {
  const g = spawnSync("gh", ["api", `/advisories/${id}`], { cwd: repoRoot, encoding: "utf8" });
  if (g.status === 0) return JSON.parse(g.stdout);
  const res = await fetch(`https://api.github.com/advisories/${id}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "h04-01-attack" },
  });
  assert.equal(res.status, 200, `GitHub advisory ${id}: HTTP ${res.status} (gh: ${g.stderr})`);
  return res.json();
}

describe("§4.x advisory records vs api.github.com", () => {
  test("GHSA-w3rx-r6r6-pgpr: CVE-2025-71330, high, CVSS 7.5, image-size <= 2.0.2, no patched version, published 2026-06-10", async () => {
    const a = await ghsa("GHSA-w3rx-r6r6-pgpr");
    assert.equal(a.cve_id, "CVE-2025-71330");
    assert.equal(a.severity, "high");
    assert.equal(a.cvss.score, 7.5);
    assert.deepEqual(
      a.vulnerabilities.map((v) => [
        v.package.ecosystem,
        v.package.name,
        v.vulnerable_version_range,
        v.first_patched_version,
      ]),
      [["npm", "image-size", "<= 2.0.2", null]],
    );
    assert.ok(a.published_at.startsWith("2026-06-10"), a.published_at);
    assert.match(doc, /### 4\.1 GHSA-w3rx-r6r6-pgpr \/ CVE-2025-71330/);
  });

  test("GHSA-5p2g-fcmc-qvqq: CVE-2025-71329, high, CVSS 7.5, image-size <= 2.0.2, no patched version, published 2026-06-10", async () => {
    const a = await ghsa("GHSA-5p2g-fcmc-qvqq");
    assert.equal(a.cve_id, "CVE-2025-71329");
    assert.equal(a.severity, "high");
    assert.equal(a.cvss.score, 7.5);
    assert.deepEqual(
      a.vulnerabilities.map((v) => [
        v.package.name,
        v.vulnerable_version_range,
        v.first_patched_version,
      ]),
      [["image-size", "<= 2.0.2", null]],
    );
    assert.ok(a.published_at.startsWith("2026-06-10"), a.published_at);
    assert.match(doc, /### 4\.2 GHSA-5p2g-fcmc-qvqq \/ CVE-2025-71329/);
  });

  test("GHSA-vcc3-ghjq-m6fr: CVE-2026-45822, medium, no CVSS score, decode-uri-component <= 0.4.2 patched in 0.5.0, published 2026-08-31", async () => {
    const a = await ghsa("GHSA-vcc3-ghjq-m6fr");
    assert.equal(a.cve_id, "CVE-2026-45822");
    assert.equal(a.severity, "medium");
    assert.equal(a.cvss.score, null);
    assert.deepEqual(
      a.vulnerabilities.map((v) => [
        v.package.name,
        v.vulnerable_version_range,
        v.first_patched_version,
      ]),
      [["decode-uri-component", "<= 0.4.2", "0.5.0"]],
    );
    assert.ok(a.published_at.startsWith("2026-08-31"), a.published_at);
    assert.match(doc, /### 4\.3 GHSA-vcc3-ghjq-m6fr \/ CVE-2026-45822/);
    assert.match(doc, /published 2026-08-31/);
  });
});

describe("§4.1 / §6 / §9 react-native@0.86.3 tree facts vs registry.npmjs.org", () => {
  test("community-cli-plugin@0.86.3 and metro-config@0.86.3 declare metro ^0.84.3; metro-config@0.84.6 pins metro 0.84.6", () => {
    assert.equal(
      npmView("@react-native/community-cli-plugin@0.86.3", "dependencies.metro"),
      "^0.84.3",
    );
    assert.equal(
      npmView("@react-native/metro-config@0.86.3", "dependencies.metro-config"),
      "^0.84.3",
    );
    assert.equal(npmView("metro-config@0.84.6", "dependencies.metro"), "0.84.6");
  });

  test("metro dropped image-size between 0.84.4 and 0.84.5; 0.87.0 (shipping) still depends on image-size ^1.0.2", () => {
    assert.equal(npmView("metro@0.84.4", "dependencies.image-size"), "^1.0.2");
    assert.equal(npmView("metro@0.84.5", "dependencies.image-size"), undefined);
    assert.equal(npmView("metro@0.84.6", "dependencies.image-size"), undefined);
    assert.equal(npmView("metro@0.87.0", "dependencies.image-size"), "^1.0.2");
    assert.equal(
      npmView("@react-native/community-cli-plugin@0.87.1", "dependencies.metro"),
      "^0.87.0",
    );
  });

  test("publication dates quoted in §4.1: metro 0.84.5 = 2026-08-19, 0.84.6 = 2026-09-02; image-size 2.0.2 and 1.2.1 both 2025-04-02; latest image-size tags 2.0.2 / legacy 1.2.1", () => {
    const t = npmView("metro", "time");
    assert.ok(t["0.84.5"].startsWith("2026-08-19"), t["0.84.5"]);
    assert.ok(t["0.84.6"].startsWith("2026-09-02"), t["0.84.6"]);
    const is = npmView("image-size", "time");
    assert.ok(is["2.0.2"].startsWith("2025-04-02"));
    assert.ok(is["1.2.1"].startsWith("2025-04-02"));
    assert.deepEqual(npmView("image-size", "dist-tags"), { latest: "2.0.2", legacy: "1.2.1" });
    assert.match(doc, /metro@0\.84\.5` \(published 2026-08-19\)/);
  });

  test("react-native@0.86.3 is older than the shipping 0.87.1 (a downgrade, as §6 says), and 0.87.1 is dist-tag latest", () => {
    const t = npmView("react-native", "time");
    assert.ok(new Date(t["0.86.3"]) < new Date(t["0.87.1"]), `${t["0.86.3"]} vs ${t["0.87.1"]}`);
    assert.equal(npmView("react-native", "dist-tags.latest"), "0.87.1");
    const mobilePkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "apps/mobile/package.json"), "utf8"),
    );
    assert.equal(mobilePkg.dependencies["react-native"], "0.87.1");
  });
});

describe("§4.3 decode-uri-component / query-string facts vs registry.npmjs.org", () => {
  test("decode-uri-component@0.5.0 is ESM-only and was published 2026-06-29 (>= 7 days before the 2026-09-08 review; 71 days as §4.3 says)", () => {
    assert.equal(npmView("decode-uri-component@0.5.0", "type"), "module");
    const t = npmView("decode-uri-component", "time");
    assert.ok(t["0.5.0"].startsWith("2026-06-29T16:00"), t["0.5.0"]);
    // "71 days old" on the review date: 2026-06-29T16:00Z -> 2026-09-08 is 70.3 days at midnight, 71 after 16:00 UTC.
    const days = (Date.UTC(2026, 8, 8, 23, 59) - new Date(t["0.5.0"]).getTime()) / 86400000;
    assert.ok(days >= 70 && days < 72, `${days} days`);
    assert.ok(days >= 7);
    assert.match(doc, /0\.5\.0 is 71 days old/);
  });

  test("query-string 9.5.0 is the first release depending on decode-uri-component ^0.5.0 (9.4.1 still ^0.4.1); published 2026-08-06 (>= 7 days); latest is 9.5.1", () => {
    assert.equal(npmView("query-string@9.4.1", "dependencies.decode-uri-component"), "^0.4.1");
    assert.equal(npmView("query-string@9.5.0", "dependencies.decode-uri-component"), "^0.5.0");
    const t = npmView("query-string", "time");
    assert.ok(t["9.5.0"].startsWith("2026-08-06"), t["9.5.0"]);
    assert.equal(npmView("query-string", "dist-tags.latest"), "9.5.1");
    assert.match(
      doc,
      /query-string@9\.5\.0`[\s\S]{0,400}lies entirely outside the `<= 0\.4\.2` vulnerable range/,
    );
  });

  test("@react-navigation/core latest 7.21.13 still depends on query-string ^7.1.3; next is an 8.0.0 alpha", () => {
    const tags = npmView("@react-navigation/core", "dist-tags");
    assert.equal(tags.latest, "7.21.13");
    assert.match(tags.next, /^8\.0\.0-alpha\./);
    assert.equal(npmView("@react-navigation/core@7.21.13", "dependencies.query-string"), "^7.1.3");
  });
});

describe("installed tree and reachability preconditions (apps/mobile checkout)", () => {
  test("npm ls shows exactly one image-size@1.2.1 (via metro@0.87.0) and one decode-uri-component@0.2.2 (via query-string@7.1.3 <- @react-navigation/core@7.21.13)", () => {
    const r = spawnSync(
      "npm",
      ["ls", "image-size", "decode-uri-component", "query-string", "--json"],
      {
        cwd: path.join(repoRoot, "apps/mobile"),
        encoding: "utf8",
      },
    );
    const tree = JSON.parse(r.stdout);
    const found = {};
    const walk = (deps) => {
      for (const [name, d] of Object.entries(deps || {})) {
        if (["image-size", "decode-uri-component", "query-string"].includes(name)) {
          found[name] = found[name] || new Set();
          found[name].add(d.version);
        }
        walk(d.dependencies);
      }
    };
    walk(tree.dependencies);
    assert.deepEqual([...found["image-size"]], ["1.2.1"]);
    assert.deepEqual([...found["decode-uri-component"]], ["0.2.2"]);
    assert.deepEqual([...found["query-string"]], ["7.1.3"]);
    const dirs = ["image-size", "decode-uri-component", "query-string"].map((n) =>
      spawnSync(
        "find",
        ["node_modules", "-type", "d", "-name", n, "-path", "*/node_modules/" + n],
        {
          cwd: path.join(repoRoot, "apps/mobile"),
          encoding: "utf8",
        },
      )
        .stdout.trim()
        .split("\n"),
    );
    for (const list of dirs)
      assert.equal(list.length, 1, "single instance expected: " + list.join(", "));
  });

  test("shipping navigation has no deep-link surface: NavigationContainer has no `linking` prop and nothing calls getStateFromPath/useLinkTo/useLinkProps/useLinkBuilder", () => {
    const nav = fs.readFileSync(
      path.join(repoRoot, "apps/mobile/src/navigation/RootNavigator.tsx"),
      "utf8",
    );
    const container = nav.match(/<NavigationContainer[^>]*>/s);
    assert.ok(container, "NavigationContainer not found");
    assert.doesNotMatch(container[0], /\blinking\b/);
    const r = spawnSync(
      "grep",
      [
        "-rlE",
        "getStateFromPath|useLinkTo|useLinkProps|useLinkBuilder|linking=",
        "src",
        "App.tsx",
        "index.js",
        "--exclude-dir=__tests__",
      ],
      { cwd: path.join(repoRoot, "apps/mobile"), encoding: "utf8" },
    );
    assert.equal(r.stdout.trim(), "", "deep-link API usage found in shipping source:\n" + r.stdout);
  });

  test("Info.plist declares only the Google Sign-In return URL scheme (no JS-handled custom scheme) and no associated domains entitlement", () => {
    const plist = fs.readFileSync(
      path.join(repoRoot, "apps/mobile/ios/PickleSensei/Info.plist"),
      "utf8",
    );
    const urlTypes = plist.match(
      /<key>CFBundleURLTypes<\/key>\s*<array>([\s\S]*?)<\/array>\s*(?=<key>)/,
    );
    assert.ok(urlTypes);
    const names = [
      ...urlTypes[1].matchAll(/<key>CFBundleURLName<\/key>\s*<string>([^<]*)<\/string>/g),
    ].map((m) => m[1]);
    assert.deepEqual(names, ["GoogleSignInReturn"]);
    const ent = fs.readFileSync(
      path.join(repoRoot, "apps/mobile/ios/PickleSensei/PickleSensei.entitlements"),
      "utf8",
    );
    assert.doesNotMatch(ent, /associated-domains/);
  });
});

describe("§2 #11/#12 production bundle module-presence claims, rebuilt from this checkout", () => {
  test("release iOS bundle: 2001 modules; 0 from image-size/metro/@react-native/community-cli-plugin/new-app-screen; exactly 1 each from decode-uri-component and query-string; getStateFromPath present; no 'image-size' string", () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "h04-01-bundle-"));
    try {
      const r = spawnSync(
        "npx",
        [
          "react-native",
          "bundle",
          "--platform",
          "ios",
          "--dev",
          "false",
          "--minify",
          "false",
          "--entry-file",
          "index.js",
          "--bundle-output",
          path.join(outDir, "main.jsbundle"),
          "--sourcemap-output",
          path.join(outDir, "main.map"),
          "--reset-cache",
        ],
        {
          cwd: path.join(repoRoot, "apps/mobile"),
          encoding: "utf8",
          timeout: 600000,
          maxBuffer: 64 * 1024 * 1024,
        },
      );
      assert.equal(r.status, 0, r.stderr.slice(-2000));
      const map = JSON.parse(fs.readFileSync(path.join(outDir, "main.map"), "utf8"));
      const sources = map.sections.flatMap((s) => s.map.sources);
      assert.equal(sources.length, 2001);
      const count = (pkg) => sources.filter((s) => s.includes("/node_modules/" + pkg + "/")).length;
      for (const pkg of [
        "image-size",
        "metro",
        "metro-config",
        "metro-transform-worker",
        "@react-native/metro-config",
        "@react-native/community-cli-plugin",
        "@react-native/new-app-screen",
      ])
        assert.equal(count(pkg), 0, pkg);
      assert.equal(count("decode-uri-component"), 1);
      assert.equal(count("query-string"), 1);
      const bundle = fs.readFileSync(path.join(outDir, "main.jsbundle"), "utf8");
      assert.match(bundle, /getStateFromPath/);
      assert.doesNotMatch(bundle, /image-size/);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe("Deno lockfiles (§3 rows 'Deno — root deno.lock' / 'supabase/functions/api/deno.lock')", () => {
  for (const rel of ["deno.lock", "supabase/functions/api/deno.lock"]) {
    test(`${rel}: version 5, exactly 13 npm entries, no jsr/remote entries, and \`deno audit --lock\` reports no known vulnerabilities`, () => {
      const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, rel), "utf8"));
      assert.equal(lock.version, "5");
      assert.equal(Object.keys(lock.npm || {}).length, 13);
      assert.equal(Object.keys(lock.jsr || {}).length, 0);
      assert.equal(Object.keys(lock.remote || {}).length, 0);
      const r = spawnSync("deno", ["audit", "--lock=deno.lock"], {
        cwd: path.join(repoRoot, path.dirname(rel)),
        encoding: "utf8",
        timeout: 120000,
      });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout + r.stderr, /No known vulnerabilities found/);
    });
  }

  test("the two lockfiles pin the same 13 npm packages at the same versions (§3 'same 13 npm packages')", () => {
    const a = JSON.parse(fs.readFileSync(path.join(repoRoot, "deno.lock"), "utf8"));
    const b = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "supabase/functions/api/deno.lock"), "utf8"),
    );
    assert.deepEqual(Object.keys(a.npm).sort(), Object.keys(b.npm).sort());
  });
});
