// Structural audit probes for tools/release/check-release-manifest.mjs.
//
// Each test states the invariant the checker is documented to pin
// (docs/RELEASE_OPERATIONS.md §1/§7/§8) and feeds the checker a manifest or
// project file that violates it. A failing test = the checker accepts the
// violation on the audited commit.
//
//   node --test tools/release/__audit__/
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  GRADLE,
  MANIFEST,
  PBXPROJ,
  RUNTIME_CONFIG,
  readFixture,
  readManifest,
  readRepoFile,
  replaceNth,
  runCheckerWith,
  writeFixture,
  writeManifest,
} from "./fixture.mjs";

const manifest = readManifest();
const { marketingVersion, buildNumber } = manifest.versionScheme;

test("baseline: checker passes on the audited commit", () => {
  const r = runCheckerWith(() => {});
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("pbxproj: a Debug/Release MARKETING_VERSION split must FAIL", () => {
  const r = runCheckerWith((root) => {
    const pbx = readFixture(root, PBXPROJ);
    const needle = `MARKETING_VERSION = ${marketingVersion};`;
    assert.ok(pbx.split(needle).length - 1 >= 2, "fixture has two build configurations");
    // Second configuration (Release) drifts; Debug still matches.
    writeFixture(root, PBXPROJ, replaceNth(pbx, needle, "MARKETING_VERSION = 9.9;", 1));
  });
  assert.equal(r.status, 1, `checker accepted a Release-only version drift:\n${r.stdout}`);
});

test("pbxproj: a Debug/Release CURRENT_PROJECT_VERSION split must FAIL", () => {
  const r = runCheckerWith((root) => {
    const pbx = readFixture(root, PBXPROJ);
    const needle = `CURRENT_PROJECT_VERSION = ${buildNumber};`;
    writeFixture(root, PBXPROJ, replaceNth(pbx, needle, "CURRENT_PROJECT_VERSION = 42;", 1));
  });
  assert.equal(r.status, 1, `checker accepted a Release-only build-number drift:\n${r.stdout}`);
});

test("build.gradle: versionCode only present in a comment must FAIL", () => {
  const r = runCheckerWith((root) => {
    const gradle = readFixture(root, GRADLE);
    const mutated = gradle.replace(
      `versionCode ${buildNumber}`,
      `// versionCode ${buildNumber}\n        versionCode 77`,
    );
    assert.notEqual(mutated, gradle);
    writeFixture(root, GRADLE, mutated);
  });
  assert.equal(r.status, 1, `checker matched a commented-out versionCode:\n${r.stdout}`);
});

test("build.gradle: versionName only present in a comment must FAIL", () => {
  const r = runCheckerWith((root) => {
    const gradle = readFixture(root, GRADLE);
    const mutated = gradle.replace(
      `versionName "${marketingVersion}"`,
      `// versionName "${marketingVersion}"\n        versionName "9.9"`,
    );
    assert.notEqual(mutated, gradle);
    writeFixture(root, GRADLE, mutated);
  });
  assert.equal(r.status, 1, `checker matched a commented-out versionName:\n${r.stdout}`);
});

test("runtimeConfig: APP_VERSION only present in a comment must FAIL", () => {
  const r = runCheckerWith((root) => {
    const cfg = readFixture(root, RUNTIME_CONFIG);
    const needle = `const APP_VERSION = '${marketingVersion}';`;
    assert.ok(cfg.includes(needle));
    writeFixture(
      root,
      RUNTIME_CONFIG,
      cfg.replace(needle, `// ${needle}\nconst APP_VERSION = '9.9';`),
    );
  });
  assert.equal(r.status, 1, `checker matched a commented-out APP_VERSION:\n${r.stdout}`);
});

test("rollbackHooks: db_snapshot_restore with requiresHumanAuthorization=false must FAIL", () => {
  // release-manifest.json says the hook "requires release owner + privacy
  // owner with written rationale"; RELEASE_OPERATIONS §7 says irreversible /
  // real-user-data hooks carry requiresHumanAuthorization: true.
  const r = runCheckerWith((root) => {
    const m = readManifest();
    const hook = m.rollbackHooks.find((h) => h.id === "db_snapshot_restore");
    hook.requiresHumanAuthorization = false;
    writeManifest(root, m);
  });
  assert.equal(r.status, 1, `checker accepted an unauthorised snapshot restore:\n${r.stdout}`);
});

test("irreversibleActions: deleting app_store_submission must FAIL", () => {
  // RELEASE_OPERATIONS §8 lists seven irreversible actions; the manifest
  // $comment says tooling must never treat them as authorised.
  const r = runCheckerWith((root) => {
    const m = readManifest();
    m.irreversibleActions = m.irreversibleActions.filter((a) => a.id !== "app_store_submission");
    writeManifest(root, m);
  });
  assert.equal(
    r.status,
    1,
    `checker accepted a manifest without app_store_submission:\n${r.stdout}`,
  );
});

test("irreversibleActions: a single unrelated entry must FAIL", () => {
  const r = runCheckerWith((root) => {
    const m = readManifest();
    m.irreversibleActions = [{ id: "anything", requiresHumanAuthorization: true }];
    writeManifest(root, m);
  });
  assert.equal(r.status, 1, `checker accepted an arbitrary irreversibleActions set:\n${r.stdout}`);
});

test("monitoringHooks: duplicate id with conflicting severity must FAIL", () => {
  const r = runCheckerWith((root) => {
    const m = readManifest();
    const dup = { ...m.monitoringHooks.find((h) => h.id === "flag_drift"), severity: "P1" };
    m.monitoringHooks.push(dup);
    writeManifest(root, m);
  });
  assert.equal(r.status, 1, `checker accepted duplicate monitoring ids:\n${r.stdout}`);
});

test("schemaVersion: an unknown schemaVersion must FAIL", () => {
  const r = runCheckerWith((root) => {
    const m = readManifest();
    m.schemaVersion = 999;
    writeManifest(root, m);
  });
  assert.equal(r.status, 1, `checker accepted schemaVersion 999:\n${r.stdout}`);
});

test("manifest: malformed JSON must produce a FAIL line, not a stack trace", () => {
  const r = runCheckerWith((root) => {
    writeFixture(root, MANIFEST, "{ not json");
  });
  assert.notEqual(r.status, 0);
  assert.ok(
    /FAIL/.test(r.stdout + r.stderr) && !/at .*check-release-manifest\.mjs/.test(r.stderr),
    `malformed manifest surfaced as a stack trace:\n${r.stderr}`,
  );
});

test("manifest: missing file must produce a FAIL line, not a stack trace", () => {
  const r = runCheckerWith((root) => {
    rmSync(join(root, MANIFEST));
  });
  assert.notEqual(r.status, 0);
  assert.ok(
    /FAIL/.test(r.stdout + r.stderr) && !/ENOENT/.test(r.stderr),
    `missing manifest surfaced as a raw exception:\n${r.stderr}`,
  );
});

// --- invariants the checker DOES hold (expected to pass on the audited commit) --

test("holds: manifest marketingVersion drift vs pbxproj FAILs", () => {
  const r = runCheckerWith((root) => {
    const m = readManifest();
    m.versionScheme.marketingVersion = "1.1";
    writeManifest(root, m);
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL pbxproj: MARKETING_VERSION = 1\.1/);
});

test("holds: production apiOrigin set to a real origin FAILs (manifest says tbd)", () => {
  const r = runCheckerWith((root) => {
    const m = readManifest();
    m.environments.production.apiOrigin = "https://example.invalid";
    writeManifest(root, m);
  });
  assert.equal(r.status, 1);
});

test("holds: removing a mandatory monitoring hook FAILs", () => {
  const r = runCheckerWith((root) => {
    const m = readManifest();
    m.monitoringHooks = m.monitoringHooks.filter((h) => h.id !== "consent_ledger_integrity");
    writeManifest(root, m);
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL monitoringHooks: consent_ledger_integrity present/);
});

test("holds: irreversible action with requiresHumanAuthorization=false FAILs", () => {
  const r = runCheckerWith((root) => {
    const m = readManifest();
    m.irreversibleActions[0].requiresHumanAuthorization = false;
    writeManifest(root, m);
  });
  assert.equal(r.status, 1);
});

test("holds: the single-quote APP_VERSION match is backed by apps/mobile prettier config", () => {
  // The checker only accepts `const APP_VERSION = '<v>';`. apps/mobile pins
  // singleQuote: true, so a double-quoted literal cannot survive format:check.
  assert.match(readRepoFile("apps/mobile/.prettierrc.js"), /singleQuote:\s*true/);
});
