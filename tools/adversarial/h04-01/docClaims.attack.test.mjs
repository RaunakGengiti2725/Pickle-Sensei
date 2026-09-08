// H04-01 adversarial suite — re-derives the factual claims of
// docs/security/ADVISORIES_2026-09-08.md from the live registry, the audit tools, the
// installed mobile tree and a production bundle, and fails where a claim does not hold.
//
// Prerequisites: root `pnpm install --frozen-lockfile`, `cd apps/mobile && npm ci`, deno on
// PATH (or ~/.deno/bin), network access to registry.npmjs.org and the GitHub advisory API.
// Run: node --test tools/adversarial/h04-01/
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DOC_GHSA_IDS,
  MOBILE_DIR,
  REPO_ROOT,
  ensureArtifactDir,
  ghsaIdsFromNpmAudit,
  npmView,
  readDoc,
  run,
  writeArtifact,
} from "./helpers.mjs";

const DENO = fs.existsSync(path.join(os.homedir(), ".deno/bin/deno"))
  ? path.join(os.homedir(), ".deno/bin/deno")
  : "deno";

const doc = readDoc();

test("B1 audit reproduction: apps/mobile npm audit yields exactly the 16 labels / 3 GHSA ids the doc dispositions", () => {
  const res = run("npm", ["audit", "--json"], { cwd: MOBILE_DIR, timeout: 300_000 });
  writeArtifact("B1-mobile-audit.json", res.stdout);
  assert.equal(res.status, 1, "npm audit exits 1 when advisories exist (doc §8.1)");
  const report = JSON.parse(res.stdout);
  assert.deepEqual(report.metadata.vulnerabilities, {
    info: 0,
    low: 0,
    moderate: 7,
    high: 9,
    critical: 0,
    total: 16,
  });
  assert.deepEqual([...ghsaIdsFromNpmAudit(report)].sort(), [...DOC_GHSA_IDS].sort());

  const labels = Object.keys(report.vulnerabilities).sort();
  assert.equal(labels.length, 16);
  // every label has a §5 row whose severity matches npm's
  for (const [label, v] of Object.entries(report.vulnerabilities)) {
    const row = doc.split("\n").find((l) => l.startsWith(`| \`${label}@`));
    assert.ok(row, `no §5 row for ${label}`);
    assert.ok(
      row.includes(`| ${v.severity} `),
      `§5 severity for ${label} != ${v.severity}: ${row}`,
    );
  }
});

test("B2 audit reproduction: workspace pnpm audit is clean (exit 0, 0 advisories)", () => {
  const res = run("pnpm", ["audit", "--json"], { timeout: 300_000 });
  writeArtifact("B2-pnpm-audit.json", res.stdout);
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.deepEqual(report.metadata.vulnerabilities, {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
  });
  assert.equal(Object.keys(report.advisories).length, 0);
});

test("B3 deno lock review: every deno.lock in the repo audits clean AND deno audit detects a seeded vulnerable lock", () => {
  const locks = run("git", ["ls-files", "*deno.lock", "**/deno.lock"])
    .stdout.trim()
    .split("\n")
    .filter(Boolean);
  assert.ok(locks.length >= 2, `expected deno.lock files, got ${JSON.stringify(locks)}`);
  const lines = [];
  for (const lock of locks) {
    const cwd = path.join(REPO_ROOT, path.dirname(lock));
    const res = run(DENO, ["audit", `--lock=${path.basename(lock)}`], { cwd, timeout: 300_000 });
    lines.push(`${lock}: exit ${res.status}\n${res.stdout}${res.stderr}`);
    assert.equal(res.status, 0, `${lock}: ${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /No known vulnerabilities found/);
  }
  writeArtifact("B3-deno-audits.log", lines.join("\n"));

  // Detection sanity: a lockfile that pins the vulnerable versions must NOT audit clean,
  // otherwise "No known vulnerabilities found" would be meaningless for the real locks.
  const probe = fs.mkdtempSync(path.join(ensureArtifactDir(), "deno-probe-"));
  fs.writeFileSync(
    path.join(probe, "main.ts"),
    'import "npm:image-size@1.2.1";\nimport "npm:decode-uri-component@0.2.2";\n',
  );
  fs.writeFileSync(path.join(probe, "deno.json"), JSON.stringify({ nodeModulesDir: "none" }));
  const install = run(DENO, ["install", "--entrypoint", "main.ts"], {
    cwd: probe,
    timeout: 300_000,
  });
  assert.equal(install.status, 0, install.stderr);
  const audit = run(DENO, ["audit"], { cwd: probe, timeout: 300_000 });
  writeArtifact("B3-deno-probe-audit.log", audit.stdout + audit.stderr);
  assert.notEqual(
    audit.status,
    0,
    "deno audit did not flag a lock with known-vulnerable npm packages",
  );
  for (const id of DOC_GHSA_IDS) assert.match(audit.stdout + audit.stderr, new RegExp(id));
});

test("B4 registry facts behind the upgrade rejections hold", () => {
  // image-size: no patched release on any line the audit could move to
  const imageSizeVersions = npmView("image-size", "versions");
  assert.equal(
    imageSizeVersions.at(-1),
    "2.0.2",
    "a newer image-size exists — re-evaluate 'no patched release'",
  );
  const ghsa = run(
    "gh",
    ["api", "/advisories/GHSA-w3rx-r6r6-pgpr", "--jq", ".vulnerabilities[0].first_patched_version"],
    {
      timeout: 60_000,
    },
  );
  if (ghsa.status === 0) assert.equal(ghsa.stdout.trim(), "");

  // metro: image-size dropped only on the 0.84 line; every 0.85+/0.86/0.87 release still has it
  for (const v of ["0.85.0", "0.86.0", "0.87.0"]) {
    assert.equal(npmView(`metro@${v}`, "dependencies.image-size"), "^1.0.2", `metro@${v}`);
  }
  assert.equal(npmView("metro@0.84.5", "dependencies.image-size"), null);
  assert.equal(npmView("metro@0.84.6", "dependencies.image-size"), null);
  const metroVersions = npmView("metro", "versions").filter((v) => /^0\.8[7-9]\./.test(v));
  assert.deepEqual(
    metroVersions,
    ["0.87.0"],
    "a newer metro 0.87+/0.88 exists — re-evaluate the rejection",
  );
  assert.equal(
    npmView("@react-native/community-cli-plugin@0.87.1", "dependencies.metro"),
    "^0.87.0",
  );
  assert.equal(
    npmView("@react-native/metro-config@0.87.1", "dependencies.metro-config"),
    "^0.87.0",
  );
  assert.equal(
    npmView("react-native@0.87.1", "dependencies.@react-native/community-cli-plugin"),
    "0.87.1",
  );

  // decode-uri-component: 0.5.0 is the first patched version and is ESM-only
  assert.equal(npmView("decode-uri-component@0.5.0", "type"), "module");
  assert.equal(npmView("query-string@7.1.3", "type"), null, "query-string@7.1.3 is CommonJS");
  assert.equal(npmView("query-string@7.1.3", "dependencies.decode-uri-component"), "^0.2.2");
  assert.equal(
    npmView("@react-navigation/core", "version"),
    "7.21.13",
    "a newer @react-navigation/core exists — re-evaluate",
  );
  assert.equal(npmView("@react-navigation/core@7.21.13", "dependencies.query-string"), "^7.1.3");
  const qs9 = npmView("query-string@9", "dependencies.decode-uri-component");
  assert.ok(Array.isArray(qs9) || typeof qs9 === "string");
});

test("B5 documented override failure reproduces: decode-uri-component@0.5.0 under query-string@7.1.3 throws on parse()", () => {
  const dir = fs.mkdtempSync(path.join(ensureArtifactDir(), "override-probe-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "override-probe",
      private: true,
      dependencies: { "query-string": "7.1.3" },
      overrides: { "decode-uri-component": "0.5.0" },
    }),
  );
  const install = run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: dir,
    timeout: 300_000,
  });
  assert.equal(install.status, 0, install.stderr);
  const probe = run(
    "node",
    ["-e", 'const q=require("query-string"); console.log(JSON.stringify(q.parse("?a=%20b")))'],
    { cwd: dir, timeout: 60_000 },
  );
  writeArtifact("B5-override-probe.log", `exit ${probe.status}\n${probe.stdout}${probe.stderr}`);
  assert.equal(
    probe.status,
    1,
    "override no longer breaks query-string@7 — re-evaluate the rejection",
  );
  assert.match(probe.stderr, /decodeComponent is not a function/);
});

test("B6 reachability: no linking prop / URL parsing path into @react-navigation, no associated domains, single URL scheme", () => {
  const src = path.join(MOBILE_DIR, "src");
  const grep = (pattern) =>
    run("grep", [
      "-rnE",
      pattern,
      src,
      "--include=*.ts",
      "--include=*.tsx",
      "--exclude-dir=__tests__",
    ]).stdout.trim();
  const containers = grep("<NavigationContainer");
  assert.equal(
    containers.split("\n").filter(Boolean).length,
    1,
    `expected one NavigationContainer:\n${containers}`,
  );
  assert.match(containers, /navigation\/RootNavigator\.tsx/);
  assert.equal(grep("\\blinking(=|:)"), "", "a linking prop/option is passed somewhere");
  assert.equal(
    grep("getStateFromPath|useLinkTo|useLinkProps|useLinkBuilder|getActionFromState"),
    "",
  );
  assert.equal(
    grep("Linking\\.(getInitialURL|addEventListener)"),
    "",
    "an inbound URL listener exists",
  );

  const plist = fs.readFileSync(path.join(MOBILE_DIR, "ios/PickleSensei/Info.plist"), "utf8");
  const schemes = [
    ...plist.matchAll(/<string>(com\.googleusercontent\.apps\.[^<]+|[a-z][a-z0-9+.-]*)<\/string>/g),
  ]
    .map((m) => m[1])
    .filter((s) => s.startsWith("com.googleusercontent.apps."));
  assert.equal(schemes.length, 1, "expected exactly the Google Sign-In reverse-client-id scheme");
  assert.equal((plist.match(/CFBundleURLSchemes/g) ?? []).length, 1);

  const entitlements = fs.readFileSync(
    path.join(MOBILE_DIR, "ios/PickleSensei/PickleSensei.entitlements"),
    "utf8",
  );
  assert.doesNotMatch(entitlements, /associated-domains/);
  assert.match(entitlements, /com\.apple\.developer\.applesignin/);

  const assets = run("git", ["ls-files", "apps/mobile"]).stdout.split("\n");
  const risky = assets.filter((f) => /\.(icns|jxl|heif|heic|tga|pnm|ico|dds|ktx)$/i.test(f));
  assert.deepEqual(risky, [], "committed assets include a format the image-size advisories cover");
  assert.equal(
    assets.filter((f) => /\.png$/i.test(f)).length,
    64,
    "PNG count drifted from the doc's 64",
  );
});

test("B7 reachability: a production iOS bundle contains query-string/decode-uri-component but no Metro/image-size module", () => {
  const out = fs.mkdtempSync(path.join(ensureArtifactDir(), "bundle-"));
  const res = run(
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
      path.join(out, "main.jsbundle"),
      "--assets-dest",
      path.join(out, "assets"),
      "--sourcemap-output",
      path.join(out, "main.jsbundle.map"),
    ],
    { cwd: MOBILE_DIR, timeout: 900_000 },
  );
  fs.writeFileSync(path.join(out, "bundle.log"), res.stdout + res.stderr);
  assert.equal(res.status, 0, res.stderr.slice(-2000));
  const map = JSON.parse(fs.readFileSync(path.join(out, "main.jsbundle.map"), "utf8"));
  const sources = map.sources ?? map.sections.flatMap((s) => s.map.sources);
  const count = (seg) => sources.filter((s) => s.includes(seg)).length;
  const summary = {
    sources: sources.length,
    "image-size": count("/node_modules/image-size/"),
    metro: count("/node_modules/metro/"),
    "metro-config": count("/node_modules/metro-config/"),
    "metro-transform-worker": count("/node_modules/metro-transform-worker/"),
    "@react-native/metro-config": count("/@react-native/metro-config/"),
    "community-cli-plugin": count("/@react-native/community-cli-plugin/"),
    "new-app-screen": count("/@react-native/new-app-screen/"),
    "query-string": count("/node_modules/query-string/"),
    "decode-uri-component": count("/node_modules/decode-uri-component/"),
    getStateFromPath: count("/getStateFromPath."),
  };
  writeArtifact("B7-bundle-modules.json", summary);
  for (const k of [
    "image-size",
    "metro",
    "metro-config",
    "metro-transform-worker",
    "@react-native/metro-config",
    "community-cli-plugin",
    "new-app-screen",
  ]) {
    assert.equal(summary[k], 0, `${k} is in the shipped bundle`);
  }
  assert.equal(summary["decode-uri-component"], 1);
  assert.equal(summary["query-string"], 1);
  assert.equal(summary.getStateFromPath, 1);

  // Bundled importers of query-string: only getStateFromPath (parse) and getPathFromState (stringify).
  const bundle = fs.readFileSync(path.join(out, "main.jsbundle"), "utf8");
  const lines = bundle.split("\n");
  const qsMarker = lines.findIndex((l) => l.includes("exports.stringifyUrl = "));
  assert.ok(qsMarker > 0, "query-string module body not found in bundle");
  const modFooter = /^},(\d+),\[([\d,]*)\]\);$/;
  const footers = lines.map((l, i) => ({ i, m: l.match(modFooter) })).filter((x) => x.m);
  const qsFooter = footers.find((f) => f.i > qsMarker);
  assert.ok(qsFooter, "could not locate the query-string module footer");
  const qsId = qsFooter.m[1];
  const importers = footers.filter((f) => f.m[2].split(",").includes(qsId)).map((f) => f.m[1]);
  assert.equal(
    importers.length,
    2,
    `query-string has ${importers.length} bundled importers (expected getStateFromPath + getPathFromState)`,
  );
});

test("B8 doc hygiene: prettier-clean, no forbidden copy, every VERIFIED artifact path is under the gitignored artifacts/ dir", () => {
  const prettier = run("npx", ["prettier", "--check", "docs/security/ADVISORIES_2026-09-08.md"], {
    timeout: 120_000,
  });
  assert.equal(prettier.status, 0, prettier.stdout + prettier.stderr);
  assert.doesNotMatch(
    doc,
    /android|google play|guest mode|live court|dupr|swingvision|pb vision|selkirk|joola/i,
  );
  const artifactRefs = [...doc.matchAll(/`(artifacts\/[^`]+)`/g)].map((m) => m[1]);
  assert.ok(artifactRefs.length > 5);
  const ignored = run("git", ["check-ignore", "-q", "artifacts/advisories/pnpm.json"]);
  assert.equal(ignored.status, 0, "artifacts/ is not gitignored");
  const committed = artifactRefs.filter(
    (p) =>
      fs.existsSync(path.join(REPO_ROOT, p)) &&
      run("git", ["ls-files", "--error-unmatch", p]).status === 0,
  );
  assert.deepEqual(committed, [], "doc artifacts unexpectedly committed");
});
