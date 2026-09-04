// Unit tests for tools/release/check-release-manifest.mjs.
//
// Run: node --test tools/release/check-release-manifest.test.mjs
//
// Every scenario copies the checker into a scratch root next to synthetic
// (or mutated real) input files and runs it as a child process, so the
// assertions cover the real CLI contract: exit 1 plus a `FAIL <label>` line
// for every rejected tree, exit 0 for a coherent one. The helper tests import
// the pure parsing functions directly.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHECKER = "tools/release/check-release-manifest.mjs";
const MANIFEST = "infra/release/release-manifest.json";
const PBX = "apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj";
const GRADLE = "apps/mobile/android/app/build.gradle";
const RTC = "apps/mobile/src/config/runtimeConfig.ts";
const INPUTS = [MANIFEST, PBX, GRADLE, RTC];

const realManifest = JSON.parse(readFileSync(join(repoRoot, MANIFEST), "utf8"));
const VERSION = realManifest.versionScheme.marketingVersion;
const BUILD = realManifest.versionScheme.buildNumber;

function configuration(name, { marketing = VERSION, build = BUILD } = {}) {
  return `\t\t13B07F941A680F5B00A75B9A /* ${name} */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tCURRENT_PROJECT_VERSION = ${build};
\t\t\t\tINFOPLIST_FILE = PickleSensei/Info.plist;
\t\t\t\tMARKETING_VERSION = ${marketing};
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.picklesensei;
\t\t\t};
\t\t\tname = ${name};
\t\t};
`;
}

function pbxprojFixture(opts = {}) {
  return `// !$*UTF8*$!
{
/* Begin XCBuildConfiguration section */
${configuration("Debug", opts.debug)}${configuration("Release", opts.release)}/* End XCBuildConfiguration section */
}
`;
}

function gradleFixture({ versionName = `"${VERSION}"`, versionCode = String(BUILD) } = {}) {
  return `apply plugin: "com.android.application"
android {
    defaultConfig {
        applicationId "com.picklesensei"
        versionCode ${versionCode}
        versionName ${versionName}
    }
}
`;
}

function runtimeConfigFixture(line = `const APP_VERSION = '${VERSION}';`) {
  return `// Runtime config. See https://example.invalid/docs for details.
${line}
export const APP_STORE_URL = 'https://apps.apple.com/app/id6806918402';
export function getRuntimePublicConfig() {
  return { appVersion: APP_VERSION };
}
`;
}

function manifestText(edit = (m) => m) {
  return JSON.stringify(edit(structuredClone(realManifest)), null, 2) + "\n";
}

function fixture(overrides = {}) {
  return {
    [MANIFEST]: manifestText(),
    [PBX]: pbxprojFixture(),
    [GRADLE]: gradleFixture(),
    [RTC]: runtimeConfigFixture(),
    ...overrides,
  };
}

/** Runs the checker against `files` (rel path → text | null to omit). */
function runChecker(files) {
  const root = mkdtempSync(join(tmpdir(), "release-check-test-"));
  try {
    mkdirSync(join(root, dirname(CHECKER)), { recursive: true });
    cpSync(join(repoRoot, CHECKER), join(root, CHECKER));
    for (const [rel, text] of Object.entries(files)) {
      if (text === null) continue;
      mkdirSync(join(root, dirname(rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    const r = spawnSync(process.execPath, [join(root, CHECKER)], { cwd: root, encoding: "utf8" });
    const output = r.stdout + r.stderr;
    return {
      exit: r.status,
      output,
      failLines: output.split("\n").filter((line) => line.startsWith("FAIL ")),
      threw: /^\s+at .*\.mjs:\d+|TypeError|SyntaxError|ENOENT/m.test(r.stderr),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function expectPass(files, why) {
  const r = runChecker(files);
  assert.equal(r.exit, 0, `${why}\n${r.output}`);
  assert.deepEqual(r.failLines, [], why);
}

function expectFail(files, pattern, why) {
  const r = runChecker(files);
  assert.equal(r.exit, 1, `${why}: expected exit 1\n${r.output}`);
  assert.ok(r.failLines.length > 0, `${why}: expected a FAIL line\n${r.output}`);
  assert.ok(
    r.failLines.some((line) => pattern.test(line)),
    `${why}: no FAIL line matched ${pattern}\n${r.failLines.join("\n")}`,
  );
  assert.equal(r.threw, false, `${why}: checker threw instead of reporting\n${r.output}`);
  return r;
}

describe("baseline", () => {
  test("synthetic coherent tree passes", () => {
    expectPass(fixture(), "coherent fixture");
  });

  test("the committed repository tree passes", () => {
    const files = Object.fromEntries(
      INPUTS.map((rel) => [rel, readFileSync(join(repoRoot, rel), "utf8")]),
    );
    expectPass(files, "committed tree");
  });
});

describe("project.pbxproj: every build configuration must carry the manifest version triple", () => {
  test("Release-only MARKETING_VERSION drift fails", () => {
    expectFail(
      fixture({ [PBX]: pbxprojFixture({ release: { marketing: "1.1" } }) }),
      /MARKETING_VERSION/,
      "Release configuration drift",
    );
  });

  test("Release-only CURRENT_PROJECT_VERSION drift fails", () => {
    expectFail(
      fixture({ [PBX]: pbxprojFixture({ release: { build: 7 } }) }),
      /CURRENT_PROJECT_VERSION/,
      "Release build-number drift",
    );
  });

  test("Debug-only drift fails too (all occurrences, not any)", () => {
    expectFail(
      fixture({ [PBX]: pbxprojFixture({ debug: { marketing: "0.9" } }) }),
      /MARKETING_VERSION/,
      "Debug configuration drift",
    );
  });

  test("fewer than two MARKETING_VERSION / CURRENT_PROJECT_VERSION occurrences fails", () => {
    const single = pbxprojFixture().replace(configuration("Release"), "");
    assert.equal(single.split("MARKETING_VERSION = ").length - 1, 1);
    const r = expectFail(fixture({ [PBX]: single }), /MARKETING_VERSION/, "single configuration");
    assert.ok(r.failLines.some((line) => /CURRENT_PROJECT_VERSION/.test(line)));
  });

  test("correct value surviving only inside a /* comment */ fails", () => {
    const shadowed = pbxprojFixture()
      .split(`MARKETING_VERSION = ${VERSION};`)
      .join(`MARKETING_VERSION = 1.1; /* was MARKETING_VERSION = ${VERSION}; */`);
    expectFail(fixture({ [PBX]: shadowed }), /MARKETING_VERSION/, "comment shadow");
  });

  test("correct value surviving only after a // comment marker fails", () => {
    const shadowed = pbxprojFixture()
      .split(`CURRENT_PROJECT_VERSION = ${BUILD};`)
      .join(`CURRENT_PROJECT_VERSION = 9; // CURRENT_PROJECT_VERSION = ${BUILD};`);
    expectFail(fixture({ [PBX]: shadowed }), /CURRENT_PROJECT_VERSION/, "line-comment shadow");
  });

  test("quoted values are accepted", () => {
    const quoted = pbxprojFixture()
      .split(`MARKETING_VERSION = ${VERSION};`)
      .join(`MARKETING_VERSION = "${VERSION}";`);
    expectPass(fixture({ [PBX]: quoted }), "quoted MARKETING_VERSION");
  });
});

describe("build.gradle: effective (comment-stripped) versionName / versionCode", () => {
  test("versionName changed with the old value kept in a // comment fails", () => {
    expectFail(
      fixture({
        [GRADLE]: gradleFixture({ versionName: `"1.1" // was versionName "${VERSION}"` }),
      }),
      /versionName/,
      "versionName comment shadow",
    );
  });

  test("versionCode changed with the old value kept in a // comment fails", () => {
    expectFail(
      fixture({ [GRADLE]: gradleFixture({ versionCode: `12 // was versionCode ${BUILD}` }) }),
      /versionCode/,
      "versionCode comment shadow",
    );
  });

  test("correct versionName only inside /* */ fails", () => {
    expectFail(
      fixture({
        [GRADLE]: gradleFixture({ versionName: `/* versionName "${VERSION}" */ "2.0"` }),
      }),
      /versionName/,
      "versionName block-comment shadow",
    );
  });

  test("versionCode with a longer prefix-matching number fails", () => {
    expectFail(
      fixture({ [GRADLE]: gradleFixture({ versionCode: `${BUILD}0` }) }),
      /versionCode/,
      "versionCode 10 vs 1",
    );
  });

  test("versionName assigned with '=' and single quotes is accepted", () => {
    expectPass(
      fixture({ [GRADLE]: gradleFixture({ versionName: `= '${VERSION}'` }) }),
      "gradle assignment form",
    );
  });
});

describe("runtimeConfig.ts: effective APP_VERSION", () => {
  test("new value with the old line commented out fails", () => {
    expectFail(
      fixture({
        [RTC]: runtimeConfigFixture(
          `// const APP_VERSION = '${VERSION}';\nconst APP_VERSION = '1.1';`,
        ),
      }),
      /APP_VERSION/,
      "APP_VERSION line-comment shadow",
    );
  });

  test("correct value only inside a block comment fails", () => {
    expectFail(
      fixture({
        [RTC]: runtimeConfigFixture(
          `/* const APP_VERSION = '${VERSION}'; */\nconst APP_VERSION = '1.2';`,
        ),
      }),
      /APP_VERSION/,
      "APP_VERSION block-comment shadow",
    );
  });

  test("APP_VERSION missing fails", () => {
    expectFail(
      fixture({ [RTC]: runtimeConfigFixture("const OTHER = 1;") }),
      /APP_VERSION/,
      "APP_VERSION missing",
    );
  });

  test("same value with double quotes passes", () => {
    expectPass(
      fixture({ [RTC]: runtimeConfigFixture(`const APP_VERSION = "${VERSION}";`) }),
      "double-quoted APP_VERSION",
    );
  });
});

describe("manifest contract", () => {
  test("schemaVersion must be exactly 1", () => {
    expectFail(
      fixture({ [MANIFEST]: manifestText((m) => ({ ...m, schemaVersion: 99 })) }),
      /schemaVersion/,
      "schemaVersion 99",
    );
    expectFail(
      fixture({ [MANIFEST]: manifestText((m) => ({ ...m, schemaVersion: "1" })) }),
      /schemaVersion/,
      "schemaVersion string",
    );
  });

  test("releaseBlockingSteps emptied fails", () => {
    expectFail(
      fixture({ [MANIFEST]: manifestText((m) => ({ ...m, releaseBlockingSteps: [] })) }),
      /releaseBlockingSteps/,
      "no release-blocking steps",
    );
  });

  for (const id of ["distribution_preconditions", "privacy_disclosure_sync"]) {
    test(`releaseBlockingSteps: removing ${id} fails`, () => {
      expectFail(
        fixture({
          [MANIFEST]: manifestText((m) => ({
            ...m,
            releaseBlockingSteps: m.releaseBlockingSteps.filter((s) => s.id !== id),
          })),
        }),
        new RegExp(`releaseBlockingSteps: ${id}`),
        `drop ${id}`,
      );
    });
  }

  test("every releaseBlockingStep id committed at the contract baseline is required", () => {
    for (const step of realManifest.releaseBlockingSteps) {
      expectFail(
        fixture({
          [MANIFEST]: manifestText((m) => ({
            ...m,
            releaseBlockingSteps: m.releaseBlockingSteps.filter((s) => s.id !== step.id),
          })),
        }),
        new RegExp(`releaseBlockingSteps: ${step.id}`),
        `drop ${step.id}`,
      );
    }
  });

  test("releaseBlockingSteps entry with an empty description fails", () => {
    expectFail(
      fixture({
        [MANIFEST]: manifestText((m) => ({
          ...m,
          releaseBlockingSteps: m.releaseBlockingSteps.map((s, i) =>
            i === 0 ? { ...s, description: "" } : s,
          ),
        })),
      }),
      /releaseBlockingSteps/,
      "empty step description",
    );
  });

  test("irreversibleActions replaced by an unrelated entry fails for every required id", () => {
    const r = expectFail(
      fixture({
        [MANIFEST]: manifestText((m) => ({
          ...m,
          irreversibleActions: [{ id: "something_else", requiresHumanAuthorization: true }],
        })),
      }),
      /irreversibleActions: app_store_submission present/,
      "irreversible actions removed",
    );
    for (const id of [
      "app_store_submission",
      "testflight_external_distribution",
      "production_db_migration",
      "production_snapshot_restore",
      "signing_certificate_rotation",
      "enable_distribute_external_flag",
      "external_accuracy_or_latency_claim",
    ]) {
      assert.ok(
        r.failLines.some((line) => line.includes(`irreversibleActions: ${id} present`)),
        `missing FAIL for ${id}`,
      );
    }
  });

  test("irreversibleActions with requiresHumanAuthorization !== true fails", () => {
    expectFail(
      fixture({
        [MANIFEST]: manifestText((m) => ({
          ...m,
          irreversibleActions: m.irreversibleActions.map((a) =>
            a.id === "app_store_submission" ? { ...a, requiresHumanAuthorization: "yes" } : a,
          ),
        })),
      }),
      /irreversibleActions: app_store_submission requiresHumanAuthorization === true/,
      "irreversible action authorization weakened",
    );
  });

  test("rollbackHooks[].requiresHumanAuthorization === false fails", () => {
    const r = expectFail(
      fixture({
        [MANIFEST]: manifestText((m) => ({
          ...m,
          rollbackHooks: m.rollbackHooks.map((h) => ({ ...h, requiresHumanAuthorization: false })),
        })),
      }),
      /rollbackHooks: .* requiresHumanAuthorization === true/,
      "rollback authorization flipped",
    );
    assert.equal(
      r.failLines.filter((line) => /requiresHumanAuthorization === true/.test(line)).length,
      realManifest.rollbackHooks.length,
    );
  });

  test("a single rollback hook flipped to false fails and names the hook", () => {
    expectFail(
      fixture({
        [MANIFEST]: manifestText((m) => ({
          ...m,
          rollbackHooks: m.rollbackHooks.map((h) =>
            h.id === "db_snapshot_restore" ? { ...h, requiresHumanAuthorization: false } : h,
          ),
        })),
      }),
      /rollbackHooks: db_snapshot_restore requiresHumanAuthorization === true/,
      "db_snapshot_restore flipped",
    );
  });

  test("rollbackHooks: empty action string fails", () => {
    expectFail(
      fixture({
        [MANIFEST]: manifestText((m) => ({
          ...m,
          rollbackHooks: m.rollbackHooks.map((h) =>
            h.id === "db_forward_fix" ? { ...h, action: "   " } : h,
          ),
        })),
      }),
      /rollbackHooks: db_forward_fix .*action/,
      "blank rollback action",
    );
  });

  test("monitoringHooks: empty alarm fails", () => {
    expectFail(
      fixture({
        [MANIFEST]: manifestText((m) => ({
          ...m,
          monitoringHooks: m.monitoringHooks.map((h) =>
            h.id === "flag_drift" ? { ...h, alarm: "" } : h,
          ),
        })),
      }),
      /monitoringHooks: flag_drift .*alarm/,
      "empty alarm",
    );
  });

  test("monitoringHooks: empty signal fails", () => {
    expectFail(
      fixture({
        [MANIFEST]: manifestText((m) => ({
          ...m,
          monitoringHooks: m.monitoringHooks.map((h) =>
            h.id === "pipeline_latency" ? { ...h, signal: "" } : h,
          ),
        })),
      }),
      /monitoringHooks: pipeline_latency .*signal/,
      "empty signal",
    );
  });

  test("duplicate monitoring hook id fails on the uniqueness rule itself", () => {
    expectFail(
      fixture({
        [MANIFEST]: manifestText((m) => ({
          ...m,
          monitoringHooks: [
            ...m.monitoringHooks,
            {
              id: "pipeline_latency",
              signal: "dup",
              alarm: "dup",
              severity: "P1",
            },
          ],
        })),
      }),
      /monitoringHooks: ids unique/,
      "duplicate monitoring id",
    );
  });

  test("duplicate ids within rollbackHooks / irreversibleActions / releaseBlockingSteps fail", () => {
    expectFail(
      fixture({
        [MANIFEST]: manifestText((m) => ({
          ...m,
          rollbackHooks: [...m.rollbackHooks, { ...m.rollbackHooks[0] }],
        })),
      }),
      /rollbackHooks: ids unique/,
      "duplicate rollback id",
    );
    expectFail(
      fixture({
        [MANIFEST]: manifestText((m) => ({
          ...m,
          irreversibleActions: [...m.irreversibleActions, { ...m.irreversibleActions[0] }],
        })),
      }),
      /irreversibleActions: ids unique/,
      "duplicate irreversible id",
    );
    expectFail(
      fixture({
        [MANIFEST]: manifestText((m) => ({
          ...m,
          releaseBlockingSteps: [...m.releaseBlockingSteps, { ...m.releaseBlockingSteps[0] }],
        })),
      }),
      /releaseBlockingSteps: ids unique/,
      "duplicate step id",
    );
  });

  test("an id reused across lists fails", () => {
    expectFail(
      fixture({
        [MANIFEST]: manifestText((m) => ({
          ...m,
          releaseBlockingSteps: [
            ...m.releaseBlockingSteps,
            { id: "flag_drift", description: "reused id", source: "test" },
          ],
        })),
      }),
      /manifest: ids unique across/,
      "cross-list duplicate",
    );
  });

  test("a well-formed extra entry in every list still passes", () => {
    expectPass(
      fixture({
        [MANIFEST]: manifestText((m) => ({
          ...m,
          monitoringHooks: [
            ...m.monitoringHooks,
            { id: "extra_monitor", signal: "s", alarm: "a", severity: "P1" },
          ],
          rollbackHooks: [
            ...m.rollbackHooks,
            {
              id: "extra_rollback",
              subsystem: "api",
              action: "do the thing",
              requiresHumanAuthorization: true,
            },
          ],
          irreversibleActions: [
            ...m.irreversibleActions,
            { id: "extra_irreversible", requiresHumanAuthorization: true },
          ],
          releaseBlockingSteps: [
            ...m.releaseBlockingSteps,
            { id: "extra_step", description: "d", source: "s" },
          ],
        })),
      }),
      "additive manifest change",
    );
  });
});

describe("diagnostic quality: malformed input yields FAIL lines, not stack traces", () => {
  test("manifest missing", () => {
    expectFail(fixture({ [MANIFEST]: null }), /release-manifest\.json/, "manifest missing");
  });

  test("manifest malformed JSON", () => {
    expectFail(
      fixture({ [MANIFEST]: manifestText().slice(0, -3) }),
      /release-manifest\.json/,
      "malformed manifest",
    );
  });

  test("rollbackHooks not an array", () => {
    expectFail(
      fixture({ [MANIFEST]: manifestText((m) => ({ ...m, rollbackHooks: "nope" })) }),
      /rollbackHooks: is an array/,
      "rollbackHooks string",
    );
  });

  test("pbxproj missing", () => {
    expectFail(fixture({ [PBX]: null }), /project\.pbxproj/, "pbxproj missing");
  });
});

describe("parsing helpers", () => {
  test("extractBuildSettingValues returns every effective occurrence in order", async () => {
    const { extractBuildSettingValues } = await import("./check-release-manifest.mjs");
    const text = pbxprojFixture({ release: { marketing: "1.1" } });
    assert.deepEqual(extractBuildSettingValues(text, "MARKETING_VERSION"), [VERSION, "1.1"]);
    assert.deepEqual(extractBuildSettingValues(text, "CURRENT_PROJECT_VERSION"), [
      String(BUILD),
      String(BUILD),
    ]);
    assert.deepEqual(
      extractBuildSettingValues(
        `MARKETING_VERSION = 2.0; /* MARKETING_VERSION = 1.0; */`,
        "MARKETING_VERSION",
      ),
      ["2.0"],
    );
    assert.deepEqual(
      extractBuildSettingValues(
        `\tPRODUCT_BUNDLE_IDENTIFIER = "com.picklesensei";`,
        "PRODUCT_BUNDLE_IDENTIFIER",
      ),
      ["com.picklesensei"],
    );
    assert.deepEqual(extractBuildSettingValues("nothing here", "MARKETING_VERSION"), []);
  });

  test("stripComments is string-aware", async () => {
    const { stripComments } = await import("./check-release-manifest.mjs");
    assert.equal(
      stripComments(`const url = "https://x.test/a"; // trailing\n/* block */ const b = '//not';`),
      `const url = "https://x.test/a"; \n const b = '//not';`,
    );
    assert.equal(
      stripComments(`key: "#{ENV.fetch('X')}", # comment\nother: 1 # more`, {
        line: ["#"],
        block: false,
      }),
      `key: "#{ENV.fetch('X')}", \nother: 1 `,
    );
    assert.equal(stripComments("a /* unterminated"), "a ");
    assert.equal(stripComments("a\\/b // c"), "a\\/b ");
  });

  test("extractGradleValues / extractAppVersions honour comments", async () => {
    const { extractGradleValues, extractAppVersions } =
      await import("./check-release-manifest.mjs");
    assert.deepEqual(
      extractGradleValues(
        gradleFixture({ versionName: `"1.1" // versionName "1.0"` }),
        "versionName",
      ),
      ["1.1"],
    );
    assert.deepEqual(
      extractGradleValues(gradleFixture({ versionCode: `12 // versionCode 1` }), "versionCode"),
      ["12"],
    );
    assert.deepEqual(extractGradleValues(`versionCode = 42\nversionName = '3.0'`, "versionCode"), [
      "42",
    ]);
    assert.deepEqual(extractGradleValues(`versionCode = 42\nversionName = '3.0'`, "versionName"), [
      "3.0",
    ]);
    assert.deepEqual(
      extractAppVersions(`// const APP_VERSION = '1.0';\nconst APP_VERSION = "1.1";`),
      ["1.1"],
    );
    assert.deepEqual(extractAppVersions(`export const APP_VERSION = '2.0';`), ["2.0"]);
  });
});
