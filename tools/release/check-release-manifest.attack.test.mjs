// Adversarial suite for tools/release/check-release-manifest.mjs (attack on 333de233).
//
// Xcode build settings can be CONDITIONAL: `"SETTING[sdk=iphoneos*]" = value;`
// (also `[arch=...]`, `[config=...]`). The override wins over the plain
// `SETTING = value;` line for matching builds — `sdk=iphoneos*` is exactly the
// device/App Store archive. project.pbxproj already uses this form
// (`"CODE_SIGN_IDENTITY[sdk=iphoneos*]"`), so a conditional version override is
// a realistic drift path. `pbxSettingValues` only matches the unconditional
// spelling, so the gate prints `ok pbxproj: MARKETING_VERSION = X in every build
// configuration` while the archive would ship a different version.
//
// Run: node --test tools/release/check-release-manifest.attack.test.mjs
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { pbxSettingValues, runReleaseManifestChecks } from "./check-release-manifest.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const MANIFEST = "infra/release/release-manifest.json";
const PBX = "apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj";
const GRADLE = "apps/mobile/android/app/build.gradle";
const RTC = "apps/mobile/src/config/runtimeConfig.ts";
const FILES = [MANIFEST, PBX, GRADLE, RTC];

const manifest = JSON.parse(readFileSync(join(repoRoot, MANIFEST), "utf8"));
const VERSION = manifest.versionScheme.marketingVersion;
const BUILD = manifest.versionScheme.buildNumber;
const BUMPED_VERSION = `${VERSION}.99`;
const BUMPED_BUILD = String(BUILD + 99);

const scratchRoots = [];
after(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
});

function scratch(mutations) {
  const root = mkdtempSync(join(tmpdir(), "release-check-attack-"));
  scratchRoots.push(root);
  for (const rel of FILES) {
    const dst = join(root, rel);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(join(repoRoot, rel), dst);
  }
  for (const [rel, fn] of Object.entries(mutations)) {
    const dst = join(root, rel);
    const before = readFileSync(dst, "utf8");
    const after = fn(before);
    assert.notEqual(after, before, `${rel}: mutation was a no-op`);
    writeFileSync(dst, after);
  }
  return root;
}

function replaceNth(text, needle, replacement, n) {
  let idx = -1;
  for (let i = 0; i <= n; i += 1) {
    idx = text.indexOf(needle, idx + 1);
    assert.ok(idx >= 0, `occurrence ${n} of ${JSON.stringify(needle)} not found`);
  }
  return text.slice(0, idx) + replacement + text.slice(idx + needle.length);
}

/** Append a conditional override right after the n-th unconditional `setting = value;`. */
function addConditional(setting, value, condition, override, n = 1) {
  return (pbx) =>
    replaceNth(
      pbx,
      `${setting} = ${value};`,
      `${setting} = ${value};\n\t\t\t\t"${setting}[${condition}]" = ${override};`,
      n,
    );
}

function assertFails(result, labelPattern) {
  assert.ok(
    result.failures.some((label) => labelPattern.test(label)),
    `expected a FAIL matching ${labelPattern}; failures: ${JSON.stringify(result.failures)}`,
  );
}

describe("precondition: conditional build settings are a form this pbxproj already uses", () => {
  it('project.pbxproj contains a "SETTING[sdk=iphoneos*]" = value; line', () => {
    const pbx = readFileSync(join(repoRoot, PBX), "utf8");
    assert.match(pbx, /"[A-Z_]+\[sdk=iphoneos\*\]" = /);
  });
});

describe("pbxSettingValues must see conditional overrides of the setting", () => {
  it('extracts "MARKETING_VERSION[sdk=iphoneos*]" = X; as a MARKETING_VERSION value', () => {
    const fixture = [
      "\t\t\t\tMARKETING_VERSION = 1.0;",
      '\t\t\t\t"MARKETING_VERSION[sdk=iphoneos*]" = 1.1;',
      '\t\t\t\t"MARKETING_VERSION[arch=arm64]" = "1.2";',
    ].join("\n");
    const values = pbxSettingValues(fixture, "MARKETING_VERSION");
    assert.ok(
      values.includes("1.1"),
      `sdk-conditional override missing: ${JSON.stringify(values)}`,
    );
    assert.ok(
      values.includes("1.2"),
      `arch-conditional override missing: ${JSON.stringify(values)}`,
    );
  });

  it("does not treat an unrelated setting with the same suffix as a match", () => {
    const fixture =
      '\t\t\t\t"OTHER_MARKETING_VERSION[sdk=iphoneos*]" = 9.9;\n\t\t\t\tMARKETING_VERSION = 1.0;';
    assert.deepEqual(pbxSettingValues(fixture, "MARKETING_VERSION"), ["1.0"]);
  });
});

describe("release:check must fail when a conditional override drifts the version triple", () => {
  it(`Release: "MARKETING_VERSION[sdk=iphoneos*]" = ${BUMPED_VERSION}; -> FAIL`, () => {
    const result = runReleaseManifestChecks(
      scratch({
        [PBX]: addConditional("MARKETING_VERSION", VERSION, "sdk=iphoneos*", BUMPED_VERSION),
      }),
    );
    assertFails(result, /pbxproj: MARKETING_VERSION/);
  });

  it(`Release: "CURRENT_PROJECT_VERSION[sdk=iphoneos*]" = ${BUMPED_BUILD}; -> FAIL`, () => {
    const result = runReleaseManifestChecks(
      scratch({
        [PBX]: addConditional("CURRENT_PROJECT_VERSION", BUILD, "sdk=iphoneos*", BUMPED_BUILD),
      }),
    );
    assertFails(result, /pbxproj: CURRENT_PROJECT_VERSION/);
  });

  it(`Release: "MARKETING_VERSION[arch=arm64]" = ${BUMPED_VERSION}; -> FAIL`, () => {
    const result = runReleaseManifestChecks(
      scratch({
        [PBX]: addConditional("MARKETING_VERSION", VERSION, "arch=arm64", BUMPED_VERSION),
      }),
    );
    assertFails(result, /pbxproj: MARKETING_VERSION/);
  });

  it(`Debug: "MARKETING_VERSION[config=Release]" = ${BUMPED_VERSION}; -> FAIL`, () => {
    const result = runReleaseManifestChecks(
      scratch({
        [PBX]: addConditional("MARKETING_VERSION", VERSION, "config=Release", BUMPED_VERSION, 0),
      }),
    );
    assertFails(result, /pbxproj: MARKETING_VERSION/);
  });

  it("a same-value conditional override still passes", () => {
    const result = runReleaseManifestChecks(
      scratch({ [PBX]: addConditional("MARKETING_VERSION", VERSION, "sdk=iphoneos*", VERSION) }),
    );
    assert.deepEqual(result.failures, []);
  });
});
