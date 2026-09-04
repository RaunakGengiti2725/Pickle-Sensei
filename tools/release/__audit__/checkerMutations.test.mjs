// Structural audit probes for tools/release/check-release-manifest.mjs.
//
// Each test states a contract the release manifest / checker claims to
// enforce (manifest $comment, versionScheme.rules, docs/RELEASE_OPERATIONS.md)
// and applies a mutation that violates it. The checker MUST exit 1 with a
// FAIL line. A failing test here == the checker silently accepts a violation.
//
// Run: node --test "tools/release/__audit__/*.test.mjs"
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GRADLE,
  MANIFEST,
  PBXPROJ,
  RUNTIME_CONFIG,
  countOccurrences,
  readManifest,
  replaceNth,
  runChecker,
} from "./checkerHarness.mjs";

function expectFail(result, why) {
  assert.equal(result.status, 1, `${why}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.ok(
    result.failLines.length > 0,
    `${why} — expected at least one "FAIL" line, got none.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

test("sanity: unmodified inputs pass the checker (exit 0)", () => {
  const r = runChecker();
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

// ---------------------------------------------------------------- versions --

test("pbxproj: a Debug/Release MARKETING_VERSION split must FAIL (rule: iOS MARKETING_VERSION MUST equal the manifest)", () => {
  const { marketingVersion } = readManifest().versionScheme;
  const needle = `MARKETING_VERSION = ${marketingVersion};`;
  const r = runChecker(({ read, write }) => {
    const text = read(PBXPROJ);
    assert.equal(countOccurrences(text, needle), 2, "expected Debug + Release configs");
    // Release config (second occurrence) ships a different version.
    write(PBXPROJ, replaceNth(text, needle, "MARKETING_VERSION = 9.9;", 1));
  });
  expectFail(
    r,
    "Release configuration carries MARKETING_VERSION 9.9 while Debug matches the manifest",
  );
});

test("pbxproj: a Debug/Release CURRENT_PROJECT_VERSION split must FAIL (rule: build MUST equal iOS CURRENT_PROJECT_VERSION)", () => {
  const { buildNumber } = readManifest().versionScheme;
  const needle = `CURRENT_PROJECT_VERSION = ${buildNumber};`;
  const r = runChecker(({ read, write }) => {
    const text = read(PBXPROJ);
    assert.equal(countOccurrences(text, needle), 2, "expected Debug + Release configs");
    write(PBXPROJ, replaceNth(text, needle, "CURRENT_PROJECT_VERSION = 999;", 1));
  });
  expectFail(
    r,
    "Release configuration carries CURRENT_PROJECT_VERSION 999 while Debug matches the manifest",
  );
});

test("build.gradle: versionCode only present in a comment must FAIL", () => {
  const { buildNumber } = readManifest().versionScheme;
  const r = runChecker(({ read, write }) => {
    const text = read(GRADLE);
    const needle = `versionCode ${buildNumber}`;
    assert.ok(text.includes(needle));
    write(
      GRADLE,
      text.replace(
        needle,
        `versionCode ${buildNumber + 41} // previously versionCode ${buildNumber}`,
      ),
    );
  });
  expectFail(
    r,
    "the live versionCode differs from the manifest; the manifest value only survives inside a comment",
  );
});

test("build.gradle: versionName only present in a comment must FAIL", () => {
  const { marketingVersion } = readManifest().versionScheme;
  const r = runChecker(({ read, write }) => {
    const text = read(GRADLE);
    const needle = `versionName "${marketingVersion}"`;
    assert.ok(text.includes(needle));
    write(
      GRADLE,
      text.replace(needle, `versionName "9.9" // previously versionName "${marketingVersion}"`),
    );
  });
  expectFail(
    r,
    "the live versionName differs from the manifest; the manifest value only survives inside a comment",
  );
});

test("runtimeConfig.ts: APP_VERSION only present in a comment must FAIL", () => {
  const { marketingVersion } = readManifest().versionScheme;
  const r = runChecker(({ read, write }) => {
    const text = read(RUNTIME_CONFIG);
    const needle = `const APP_VERSION = '${marketingVersion}';`;
    assert.ok(text.includes(needle));
    write(RUNTIME_CONFIG, text.replace(needle, `// ${needle}\nconst APP_VERSION = '9.9';`));
  });
  expectFail(
    r,
    "the live APP_VERSION differs from the manifest; the manifest value only survives inside a comment",
  );
});

// ---------------------------------------------------------------- manifest --

test("manifest: an unknown schemaVersion must FAIL (checker is written against schema 1)", () => {
  const r = runChecker(({ writeManifest }) => {
    const m = readManifest();
    m.schemaVersion = 999;
    writeManifest(m);
  });
  expectFail(r, "schemaVersion 999 is not the schema this checker understands");
});

test("manifest: a rollback hook with requiresHumanAuthorization=false for an irreversible rollback must FAIL", () => {
  // db_snapshot_restore is listed under irreversibleActions as
  // production_snapshot_restore (requiresHumanAuthorization=true); the
  // rollback hook for the same operation must not be flippable to false.
  const r = runChecker(({ writeManifest }) => {
    const m = readManifest();
    const hook = m.rollbackHooks.find((h) => h.id === "db_snapshot_restore");
    assert.ok(hook, "db_snapshot_restore rollback hook exists");
    hook.requiresHumanAuthorization = false;
    writeManifest(m);
  });
  expectFail(r, "db_snapshot_restore rollback hook flipped to requiresHumanAuthorization=false");
});

test("manifest: removing app_store_submission from irreversibleActions must FAIL (the human-only set is a contract)", () => {
  const r = runChecker(({ writeManifest }) => {
    const m = readManifest();
    const before = m.irreversibleActions.length;
    m.irreversibleActions = m.irreversibleActions.filter((a) => a.id !== "app_store_submission");
    assert.equal(m.irreversibleActions.length, before - 1);
    writeManifest(m);
  });
  expectFail(
    r,
    "app_store_submission no longer declared as an irreversible, human-authorised action",
  );
});

test("manifest: removing the privacy_disclosure_sync release-blocking step must FAIL", () => {
  const r = runChecker(({ writeManifest }) => {
    const m = readManifest();
    const before = m.releaseBlockingSteps.length;
    m.releaseBlockingSteps = m.releaseBlockingSteps.filter(
      (s) => s.id !== "privacy_disclosure_sync",
    );
    assert.equal(m.releaseBlockingSteps.length, before - 1);
    writeManifest(m);
  });
  expectFail(r, "privacy_disclosure_sync (declared release-blocking) silently dropped");
});

test("manifest: deleting releaseBlockingSteps entirely must FAIL", () => {
  const r = runChecker(({ writeManifest }) => {
    const m = readManifest();
    delete m.releaseBlockingSteps;
    writeManifest(m);
  });
  expectFail(r, "releaseBlockingSteps absent");
});

test("manifest: duplicate monitoring hook ids must FAIL", () => {
  const r = runChecker(({ writeManifest }) => {
    const m = readManifest();
    const dup = { ...m.monitoringHooks[0] };
    m.monitoringHooks.push(dup);
    writeManifest(m);
  });
  expectFail(r, "monitoring hook id duplicated");
});

test("manifest: a rollback hook whose id shadows another (duplicate) must FAIL", () => {
  const r = runChecker(({ writeManifest }) => {
    const m = readManifest();
    m.rollbackHooks.push({ ...m.rollbackHooks[0], action: "something else" });
    writeManifest(m);
  });
  expectFail(r, "rollback hook id duplicated");
});

// ---------------------------------------------------------- error handling --

test("checker: a missing manifest reports a FAIL line (not an uncaught ENOENT stack trace)", () => {
  const r = runChecker(({ remove }) => remove(MANIFEST));
  assert.notEqual(r.status, 0);
  assert.ok(
    r.failLines.length > 0 && !/ENOENT|at .*node:internal/.test(r.stderr),
    `expected a FAIL line and no stack trace.\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
  );
});

test("checker: a malformed manifest reports a FAIL line (not an uncaught SyntaxError stack trace)", () => {
  const r = runChecker(({ write }) => write(MANIFEST, "{ not json"));
  assert.notEqual(r.status, 0);
  assert.ok(
    r.failLines.length > 0 && !/SyntaxError|at .*node:internal/.test(r.stderr),
    `expected a FAIL line and no stack trace.\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
  );
});

// -------------------------------------------------- contracts that DO hold --

test("holds: marketingVersion without MINOR fails", () => {
  const r = runChecker(({ writeManifest }) => {
    const m = readManifest();
    m.versionScheme.marketingVersion = "1";
    writeManifest(m);
  });
  expectFail(r, "marketingVersion '1'");
});

test("holds: buildNumber 0 fails", () => {
  const r = runChecker(({ writeManifest }) => {
    const m = readManifest();
    m.versionScheme.buildNumber = 0;
    writeManifest(m);
  });
  expectFail(r, "buildNumber 0");
});

test("holds: a real production apiOrigin in the manifest fails", () => {
  const r = runChecker(({ writeManifest }) => {
    const m = readManifest();
    m.environments.production.apiOrigin = "https://example.invalid";
    writeManifest(m);
  });
  expectFail(r, "production apiOrigin not 'tbd'");
});

test("holds: a monitoring hook with severity P2 fails", () => {
  const r = runChecker(({ writeManifest }) => {
    const m = readManifest();
    m.monitoringHooks[0].severity = "P2";
    writeManifest(m);
  });
  expectFail(r, "severity P2");
});

test("holds: an irreversible action with requiresHumanAuthorization=false fails", () => {
  const r = runChecker(({ writeManifest }) => {
    const m = readManifest();
    m.irreversibleActions[0].requiresHumanAuthorization = false;
    writeManifest(m);
  });
  expectFail(r, "irreversible action flipped to false");
});

test("holds: removing a required monitoring hook fails", () => {
  const r = runChecker(({ writeManifest }) => {
    const m = readManifest();
    m.monitoringHooks = m.monitoringHooks.filter((h) => h.id !== "consent_ledger_integrity");
    writeManifest(m);
  });
  expectFail(r, "consent_ledger_integrity removed");
});

test("holds: removing a required rollback hook fails", () => {
  const r = runChecker(({ writeManifest }) => {
    const m = readManifest();
    m.rollbackHooks = m.rollbackHooks.filter((h) => h.id !== "server_side_kill_switch");
    writeManifest(m);
  });
  expectFail(r, "server_side_kill_switch removed");
});

test("holds: pbxproj with BOTH configurations changed fails", () => {
  const r = runChecker(({ read, write }) => {
    write(
      PBXPROJ,
      read(PBXPROJ).replaceAll("MARKETING_VERSION = 1.0;", "MARKETING_VERSION = 9.9;"),
    );
  });
  expectFail(r, "both configs at 9.9");
});
