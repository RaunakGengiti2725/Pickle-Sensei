// Regression suite for tools/release/check-release-manifest.mjs.
//
// Copies the files the checker reads into a scratch repo root, applies ONE
// mutation, and asserts the checker's verdict. Every rule is covered by a
// positive fixture (the unmodified tree, or a same-value rewrite) and a
// negative fixture (the drift the rule must reject).
//
// Run: node --test tools/release/
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { runReleaseManifestChecks } from "./check-release-manifest.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const MANIFEST = "infra/release/release-manifest.json";
const PBX = "apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj";
const GRADLE = "apps/mobile/android/app/build.gradle";
const RTC = "apps/mobile/src/config/runtimeConfig.ts";
const FILES = [MANIFEST, PBX, GRADLE, RTC];

const manifest = JSON.parse(readFileSync(join(repoRoot, MANIFEST), "utf8"));
const VERSION = manifest.versionScheme.marketingVersion;
const BUILD = manifest.versionScheme.buildNumber;

const scratchRoots = [];
after(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
});

/** Scratch copy of the checked files with `mutations` ({relPath: text => text|null}). */
function scratch(mutations = {}) {
  const root = mkdtempSync(join(tmpdir(), "release-check-"));
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
    if (after === null) rmSync(dst);
    else {
      assert.notEqual(after, before, `${rel}: mutation was a no-op`);
      writeFileSync(dst, after);
    }
  }
  return root;
}

function editJson(fn) {
  return (text) => JSON.stringify(fn(JSON.parse(text)), null, 2) + "\n";
}

function replaceNth(text, needle, replacement, n) {
  let idx = -1;
  for (let i = 0; i <= n; i += 1) {
    idx = text.indexOf(needle, idx + 1);
    assert.ok(idx >= 0, `occurrence ${n} of ${JSON.stringify(needle)} not found`);
  }
  return text.slice(0, idx) + replacement + text.slice(idx + needle.length);
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

function run(mutations) {
  return runReleaseManifestChecks(scratch(mutations));
}

function assertFails(result, labelPattern) {
  assert.ok(
    result.failures.some((label) => labelPattern.test(label)),
    `expected a FAIL matching ${labelPattern}; failures: ${JSON.stringify(result.failures)}`,
  );
}

function assertPasses(result, labelPattern) {
  assert.ok(
    result.lines.some((line) => line.startsWith("ok  ") && labelPattern.test(line)),
    `expected an ok line matching ${labelPattern}; lines: ${JSON.stringify(result.lines)}`,
  );
  assert.ok(
    !result.failures.some((label) => labelPattern.test(label)),
    `unexpected FAIL matching ${labelPattern}: ${JSON.stringify(result.failures)}`,
  );
}

describe("baseline", () => {
  it("the unmodified tree passes every check", () => {
    const result = run({});
    assert.deepEqual(result.failures, []);
  });

  it("the committed pbxproj carries >= 2 build configurations for every pinned setting", () => {
    const pbx = readFileSync(join(repoRoot, PBX), "utf8");
    assert.ok(countOccurrences(pbx, `MARKETING_VERSION = ${VERSION};`) >= 2);
    assert.ok(countOccurrences(pbx, `CURRENT_PROJECT_VERSION = ${BUILD};`) >= 2);
  });
});

describe("RCD-01: version triple is checked in every configuration, comments stripped", () => {
  const BUMPED = `${VERSION}.99`;

  it("exports pbxSettingValues, which extracts EVERY occurrence of a build setting", async () => {
    const mod = await import("./check-release-manifest.mjs");
    assert.equal(typeof mod.pbxSettingValues, "function");
    const pbx = readFileSync(join(repoRoot, PBX), "utf8");
    const marketing = mod.pbxSettingValues(pbx, "MARKETING_VERSION");
    const build = mod.pbxSettingValues(pbx, "CURRENT_PROJECT_VERSION");
    assert.ok(marketing.length >= 2, `found ${marketing.length} MARKETING_VERSION occurrences`);
    assert.ok(build.length >= 2, `found ${build.length} CURRENT_PROJECT_VERSION occurrences`);
    assert.deepEqual(
      marketing,
      marketing.map(() => VERSION),
    );
    assert.deepEqual(
      build,
      build.map(() => String(BUILD)),
    );
    // Quoted values are unwrapped; commented-out settings are not values.
    assert.deepEqual(
      mod.pbxSettingValues(
        'TARGETED_DEVICE_FAMILY = "1,2"; /* TARGETED_DEVICE_FAMILY = 1; */\n// TARGETED_DEVICE_FAMILY = 2;\n',
        "TARGETED_DEVICE_FAMILY",
      ),
      ["1,2"],
    );
  });

  it("exports stripComments, which removes // and /* */ comments but keeps string contents", async () => {
    const mod = await import("./check-release-manifest.mjs");
    assert.equal(typeof mod.stripComments, "function");
    const stripped = mod.stripComments(
      "const a = 'x // not a comment'; // real comment\n/* block\n APP_VERSION = '9.9'; */ const b = \"y /* z */\";",
    );
    assert.match(stripped, /const a = 'x \/\/ not a comment';/);
    assert.match(stripped, /const b = "y \/\* z \*\/";/);
    assert.doesNotMatch(stripped, /real comment|APP_VERSION/);
  });

  it("R1: fails when only the Release configuration's MARKETING_VERSION drifts", () => {
    const result = run({
      [PBX]: (t) =>
        replaceNth(t, `MARKETING_VERSION = ${VERSION};`, `MARKETING_VERSION = ${BUMPED};`, 1),
    });
    assertFails(result, /pbxproj: MARKETING_VERSION/);
  });

  it("R2: fails when only the Release configuration's CURRENT_PROJECT_VERSION drifts", () => {
    const result = run({
      [PBX]: (t) =>
        replaceNth(
          t,
          `CURRENT_PROJECT_VERSION = ${BUILD};`,
          `CURRENT_PROJECT_VERSION = ${BUILD + 6};`,
          1,
        ),
    });
    assertFails(result, /pbxproj: CURRENT_PROJECT_VERSION/);
  });

  it("R3: fails when both configurations drift and the old value survives only in a /* comment */", () => {
    const result = run({
      [PBX]: (t) =>
        t
          .split(`MARKETING_VERSION = ${VERSION};`)
          .join(`MARKETING_VERSION = ${BUMPED}; /* was MARKETING_VERSION = ${VERSION}; */`),
    });
    assertFails(result, /pbxproj: MARKETING_VERSION/);
  });

  it("fails when a pinned setting appears in fewer than 2 build configurations", () => {
    const result = run({
      [PBX]: (t) => replaceNth(t, `MARKETING_VERSION = ${VERSION};`, "", 1),
    });
    assertFails(result, /pbxproj: MARKETING_VERSION/);
  });

  it("passes when every configuration carries the manifest value (positive fixture)", () => {
    const result = run({
      [PBX]: (t) => `${t}\n/* trailing note: MARKETING_VERSION = ${BUMPED}; */\n`,
    });
    assertPasses(result, /pbxproj: MARKETING_VERSION/);
    assertPasses(result, /pbxproj: CURRENT_PROJECT_VERSION/);
  });

  it("R4: fails when build.gradle versionName drifts with the old value kept in a // comment", () => {
    const result = run({
      [GRADLE]: (t) =>
        t.replace(
          `versionName "${VERSION}"`,
          `versionName "${BUMPED}" // was versionName "${VERSION}"`,
        ),
    });
    assertFails(result, /build\.gradle: .*versionName/);
  });

  it("R5: fails when build.gradle versionCode drifts with the old value kept in a // comment", () => {
    const result = run({
      [GRADLE]: (t) =>
        t.replace(`versionCode ${BUILD}\n`, `versionCode ${BUILD}2 // was versionCode ${BUILD}\n`),
    });
    assertFails(result, /build\.gradle: .*versionCode/);
  });

  it("build.gradle: the correct value inside a /* block comment */ does not satisfy the check", () => {
    const result = run({
      [GRADLE]: (t) =>
        t.replace(
          `versionName "${VERSION}"`,
          `/* versionName "${VERSION}" */ versionName "${BUMPED}"`,
        ),
    });
    assertFails(result, /build\.gradle: .*versionName/);
  });

  it("build.gradle: passes with the manifest values (positive fixture with an unrelated comment)", () => {
    const result = run({
      [GRADLE]: (t) => t.replace(`versionName "${VERSION}"`, `versionName "${VERSION}" // release`),
    });
    assertPasses(result, /build\.gradle: .*versionName/);
    assertPasses(result, /build\.gradle: .*versionCode/);
  });

  it("R6: fails when runtimeConfig.ts APP_VERSION drifts with the old line kept as a // comment", () => {
    const result = run({
      [RTC]: (t) =>
        t.replace(
          `const APP_VERSION = '${VERSION}';`,
          `// const APP_VERSION = '${VERSION}';\nconst APP_VERSION = '${BUMPED}';`,
        ),
    });
    assertFails(result, /runtimeConfig\.ts: .*APP_VERSION/);
  });

  it("runtimeConfig.ts: the correct value inside a /* block comment */ does not satisfy the check", () => {
    const result = run({
      [RTC]: (t) =>
        t.replace(
          `const APP_VERSION = '${VERSION}';`,
          `/* const APP_VERSION = '${VERSION}'; */\nconst APP_VERSION = '${BUMPED}';`,
        ),
    });
    assertFails(result, /runtimeConfig\.ts: .*APP_VERSION/);
  });

  it("R7: passes when APP_VERSION uses double quotes with the same value (positive fixture)", () => {
    const result = run({
      [RTC]: (t) =>
        t.replace(`const APP_VERSION = '${VERSION}';`, `const APP_VERSION = "${VERSION}";`),
    });
    assertPasses(result, /runtimeConfig\.ts: .*APP_VERSION/);
    assert.deepEqual(result.failures, []);
  });
});

describe("RCD-02: manifest contract is pinned", () => {
  const REQUIRED_RELEASE_BLOCKING_STEP_IDS = [
    "claim_gate_language_check",
    "privacy_disclosure_sync",
    "flag_drift_check",
    "distribution_preconditions",
  ];
  const REQUIRED_IRREVERSIBLE_ACTION_IDS = [
    "app_store_submission",
    "testflight_external_distribution",
    "production_db_migration",
    "production_snapshot_restore",
    "signing_certificate_rotation",
    "enable_distribute_external_flag",
    "external_accuracy_or_latency_claim",
  ];

  it("schemaVersion: 1 passes, R8 (99) fails", () => {
    assertPasses(run({}), /schemaVersion/);
    assertFails(
      run({ [MANIFEST]: editJson((m) => ({ ...m, schemaVersion: 99 })) }),
      /schemaVersion/,
    );
    assertFails(
      run({ [MANIFEST]: editJson(({ schemaVersion: _drop, ...m }) => m) }),
      /schemaVersion/,
    );
  });

  it("R9: releaseBlockingSteps emptied fails on every required step id", () => {
    const result = run({ [MANIFEST]: editJson((m) => ({ ...m, releaseBlockingSteps: [] })) });
    for (const id of REQUIRED_RELEASE_BLOCKING_STEP_IDS) {
      assertFails(result, new RegExp(`releaseBlockingSteps: ${id}`));
    }
  });

  for (const id of REQUIRED_RELEASE_BLOCKING_STEP_IDS) {
    it(`releaseBlockingSteps: ${id} present passes; removing it fails`, () => {
      assertPasses(run({}), new RegExp(`releaseBlockingSteps: ${id} present`));
      const result = run({
        [MANIFEST]: editJson((m) => ({
          ...m,
          releaseBlockingSteps: m.releaseBlockingSteps.filter((s) => s.id !== id),
        })),
      });
      assertFails(result, new RegExp(`releaseBlockingSteps: ${id} present`));
    });
  }

  it("releaseBlockingSteps: empty description fails", () => {
    const result = run({
      [MANIFEST]: editJson((m) => ({
        ...m,
        releaseBlockingSteps: m.releaseBlockingSteps.map((s) =>
          s.id === "distribution_preconditions" ? { ...s, description: "  " } : s,
        ),
      })),
    });
    assertFails(result, /releaseBlockingSteps: distribution_preconditions has/);
  });

  it("R10: irreversibleActions replaced by an unrelated entry fails on every required id", () => {
    const result = run({
      [MANIFEST]: editJson((m) => ({
        ...m,
        irreversibleActions: [{ id: "something_else", requiresHumanAuthorization: true }],
      })),
    });
    for (const id of REQUIRED_IRREVERSIBLE_ACTION_IDS) {
      assertFails(result, new RegExp(`irreversibleActions: ${id} present`));
    }
  });

  for (const id of REQUIRED_IRREVERSIBLE_ACTION_IDS) {
    it(`irreversibleActions: ${id} present passes; removing it fails`, () => {
      assertPasses(run({}), new RegExp(`irreversibleActions: ${id} present`));
      const result = run({
        [MANIFEST]: editJson((m) => ({
          ...m,
          irreversibleActions: m.irreversibleActions.filter((a) => a.id !== id),
        })),
      });
      assertFails(result, new RegExp(`irreversibleActions: ${id} present`));
    });
  }

  it("irreversibleActions: requiresHumanAuthorization false fails", () => {
    const result = run({
      [MANIFEST]: editJson((m) => ({
        ...m,
        irreversibleActions: m.irreversibleActions.map((a) =>
          a.id === "app_store_submission" ? { ...a, requiresHumanAuthorization: false } : a,
        ),
      })),
    });
    assertFails(
      result,
      /irreversibleActions: app_store_submission requiresHumanAuthorization === true/,
    );
  });

  it("R11: rollbackHooks requiresHumanAuthorization === true passes; false fails for every hook", () => {
    assertPasses(run({}), /rollbackHooks: db_snapshot_restore has/);
    const result = run({
      [MANIFEST]: editJson((m) => ({
        ...m,
        rollbackHooks: m.rollbackHooks.map((h) => ({ ...h, requiresHumanAuthorization: false })),
      })),
    });
    for (const hook of manifest.rollbackHooks) {
      assertFails(result, new RegExp(`rollbackHooks: ${hook.id} has`));
    }
  });

  it("rollbackHooks: empty action fails", () => {
    const result = run({
      [MANIFEST]: editJson((m) => ({
        ...m,
        rollbackHooks: m.rollbackHooks.map((h) =>
          h.id === "server_side_kill_switch" ? { ...h, action: "" } : h,
        ),
      })),
    });
    assertFails(result, /rollbackHooks: server_side_kill_switch has/);
  });

  it("R13: monitoringHooks non-empty alarm passes; empty alarm fails", () => {
    assertPasses(run({}), /monitoringHooks: flag_drift has/);
    const result = run({
      [MANIFEST]: editJson((m) => ({
        ...m,
        monitoringHooks: m.monitoringHooks.map((h) =>
          h.id === "flag_drift" ? { ...h, alarm: "" } : h,
        ),
      })),
    });
    assertFails(result, /monitoringHooks: flag_drift has/);
  });

  it("monitoringHooks: whitespace-only signal fails", () => {
    const result = run({
      [MANIFEST]: editJson((m) => ({
        ...m,
        monitoringHooks: m.monitoringHooks.map((h) =>
          h.id === "pipeline_latency" ? { ...h, signal: "   " } : h,
        ),
      })),
    });
    assertFails(result, /monitoringHooks: pipeline_latency has/);
  });

  it("ids are unique: baseline passes; a duplicate in any list fails", () => {
    assertPasses(run({}), /ids are unique/);
    const dupMonitoring = run({
      [MANIFEST]: editJson((m) => ({
        ...m,
        monitoringHooks: [
          ...m.monitoringHooks,
          { id: "pipeline_latency", signal: "dup", alarm: "dup", severity: "P1" },
        ],
      })),
    });
    assertFails(dupMonitoring, /ids are unique/);
    const dupRollback = run({
      [MANIFEST]: editJson((m) => ({
        ...m,
        rollbackHooks: [...m.rollbackHooks, { ...m.rollbackHooks[0] }],
      })),
    });
    assertFails(dupRollback, /ids are unique/);
    const dupIrreversible = run({
      [MANIFEST]: editJson((m) => ({
        ...m,
        irreversibleActions: [...m.irreversibleActions, { ...m.irreversibleActions[0] }],
      })),
    });
    assertFails(dupIrreversible, /ids are unique/);
    const dupStep = run({
      [MANIFEST]: editJson((m) => ({
        ...m,
        releaseBlockingSteps: [...m.releaseBlockingSteps, { ...m.releaseBlockingSteps[0] }],
      })),
    });
    assertFails(dupStep, /ids are unique/);
  });

  it("ids are unique ACROSS lists: a step reusing a monitoring hook id fails", () => {
    const result = run({
      [MANIFEST]: editJson((m) => ({
        ...m,
        releaseBlockingSteps: [
          ...m.releaseBlockingSteps,
          { id: "flag_drift", description: "collides with monitoringHooks", source: "test" },
        ],
      })),
    });
    assertFails(result, /ids are unique/);
  });

  it("R17: a list that is not an array is a FAIL line, not an exception", () => {
    const result = run({ [MANIFEST]: editJson((m) => ({ ...m, rollbackHooks: "nope" })) });
    assertFails(result, /rollbackHooks/);
  });

  it("R15/R16: a missing or malformed manifest is a FAIL line, not an exception", () => {
    assertFails(run({ [MANIFEST]: () => null }), /manifest: .*release-manifest\.json/);
    assertFails(run({ [MANIFEST]: (t) => t.slice(0, -3) }), /manifest: .*release-manifest\.json/);
  });
});
