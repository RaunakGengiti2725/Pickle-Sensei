/**
 * Static pins for the iOS project surfaces that the existing Linux guards
 * (check-ios-distribution.mjs, check-release-manifest.mjs, the compliance jest
 * suites) were shown NOT to look at by tools/attack/mobile-ios-config/run.mjs.
 *
 *   node --test tools/attack/mobile-ios-config/ios-config-pins.test.mjs
 *   PICKLE_REPO_ROOT=/path/to/worktree node --test tools/attack/mobile-ios-config/ios-config-pins.test.mjs
 *
 * Every assertion here passes on 4d812e1a and fails on the corresponding
 * mutation in scenarios.mjs (S4, S7, E1, E2, E3, E5, E6, E17, E18, E19).
 * Dependency-free (node:test + node:crypto) so it runs in a bare checkout.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT =
  process.env.PICKLE_REPO_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const pbxproj = read("apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj");
const runtimeConfig = read("apps/mobile/src/config/runtimeConfig.ts");
const manifest = JSON.parse(read("infra/release/release-manifest.json"));
const dossier = read("docs/APP_STORE_SUBMISSION.md");

/** Every XCBuildConfiguration object: { level, name, settings }. */
const buildConfigurations = Array.from(
  pbxproj.matchAll(
    /= \{\s*isa = XCBuildConfiguration;([\s\S]*?)buildSettings = \{([\s\S]*?)\n\t\t\t\};\s*name = (Debug|Release);\s*\};/g,
  ),
  (m) => ({
    level: /baseConfigurationReference/.test(m[1]) ? "target" : "project",
    name: m[3],
    settings: m[2],
  }),
);

function config(level, name) {
  const found = buildConfigurations.filter((c) => c.level === level && c.name === name);
  assert.equal(found.length, 1, `exactly one ${level}-level ${name} configuration`);
  return found[0].settings;
}
const targetConfig = (name) => config("target", name);
const projectConfig = (name) => config("project", name);
const setting = (block, key) => {
  const m = new RegExp(`^\\s*${key} = (.*?);$`, "m").exec(block);
  return m ? m[1] : null;
};

const debug = targetConfig("Debug");
const release = targetConfig("Release");

test("Podfile.lock PODFILE CHECKSUM is the SHA-1 of the committed Podfile", () => {
  const lock = read("apps/mobile/ios/Podfile.lock");
  const declared = /^PODFILE CHECKSUM: ([0-9a-f]{40})$/m.exec(lock)?.[1];
  assert.ok(declared, "PODFILE CHECKSUM line present");
  const actual = createHash("sha1")
    .update(readFileSync(join(ROOT, "apps/mobile/ios/Podfile")))
    .digest("hex");
  assert.equal(declared, actual);
});

for (const key of [
  "PRODUCT_BUNDLE_IDENTIFIER",
  "MARKETING_VERSION",
  "CURRENT_PROJECT_VERSION",
  "DEVELOPMENT_TEAM",
  "CODE_SIGN_ENTITLEMENTS",
  "TARGETED_DEVICE_FAMILY",
  "IPHONEOS_DEPLOYMENT_TARGET",
  "SUPPORTED_PLATFORMS",
  "INFOPLIST_FILE",
]) {
  test(`${key} is set identically in the Debug and Release app-target configurations`, () => {
    const d = setting(debug, key);
    const r = setting(release, key);
    assert.ok(d, `${key} present in Debug`);
    assert.ok(r, `${key} present in Release`);
    assert.equal(r, d);
  });
}

test("Release app-target values match the release manifest and the dossier", () => {
  assert.equal(setting(release, "PRODUCT_BUNDLE_IDENTIFIER"), "com.picklesensei");
  assert.equal(setting(release, "MARKETING_VERSION"), manifest.versionScheme.marketingVersion);
  assert.equal(
    setting(release, "CURRENT_PROJECT_VERSION"),
    String(manifest.versionScheme.buildNumber),
  );
  assert.equal(setting(release, "TARGETED_DEVICE_FAMILY"), "1");
});

test("no DEBUG compilation condition or preprocessor definition reaches a Release configuration", () => {
  for (const block of [release, projectConfig("Release")]) {
    assert.doesNotMatch(block, /SWIFT_ACTIVE_COMPILATION_CONDITIONS = .*\bDEBUG\b/);
    assert.doesNotMatch(block, /DEBUG=1/);
  }
  assert.match(projectConfig("Debug"), /SWIFT_ACTIVE_COMPILATION_CONDITIONS = .*\bDEBUG\b/);
});

test("app.json registration name equals the module name AppDelegate.swift starts", () => {
  const appJson = JSON.parse(read("apps/mobile/app.json"));
  const appDelegate = read("apps/mobile/ios/PickleSensei/AppDelegate.swift");
  const moduleName = /withModuleName: "([^"]+)"/.exec(appDelegate)?.[1];
  assert.ok(moduleName, "AppDelegate.swift passes withModuleName");
  assert.equal(appJson.name, moduleName);
});

test("Podfile keeps ENV['RCT_NEW_ARCH_ENABLED'] = '1' (Podfile comment: removing it crashes the app at startup)", () => {
  assert.match(read("apps/mobile/ios/Podfile"), /^ENV\['RCT_NEW_ARCH_ENABLED'\] = '1'$/m);
});

test("runtimeConfig APP_STORE_ID equals the Apple ID recorded in docs/APP_STORE_SUBMISSION.md", () => {
  const appStoreId = /const APP_STORE_ID: string \| null = '(\d+)';/.exec(runtimeConfig)?.[1];
  assert.ok(appStoreId, "APP_STORE_ID literal present");
  const dossierId = /Apple ID `(\d+)`/.exec(dossier)?.[1];
  assert.ok(dossierId, "dossier records the Apple ID");
  assert.equal(appStoreId, dossierId);
});
