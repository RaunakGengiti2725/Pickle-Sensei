// node --test tools/release/check-release-manifest.test.mjs
//
// Pins the release-manifest checker against the committed tree and against
// synthetic mutations of its inputs. Every mutation case asserts the exact
// check label that must flip, so a regression in the checker (rather than in
// the tree) is caught by name.
import assert from "node:assert/strict";
import { test } from "node:test";

import { loadInputs, readRuntimeConfigConst, runChecks } from "./check-release-manifest.mjs";

const COMMITTED_ORIGIN = "https://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api";
const COMMITTED_APP_STORE_ID = "6806918402";

function clone(value) {
  return structuredClone(value);
}

function failuresMatching(result, pattern) {
  return result.failures.filter((label) => pattern.test(label));
}

function withManifest(inputs, mutate) {
  const next = { ...inputs, manifest: clone(inputs.manifest) };
  mutate(next.manifest);
  return next;
}

function withRuntimeConfig(inputs, replacer) {
  return { ...inputs, runtimeConfig: replacer(inputs.runtimeConfig) };
}

const inputs = loadInputs();

test("committed tree: every release-manifest check passes", () => {
  const result = runChecks(inputs);
  assert.deepEqual(result.failures, []);
  assert.ok(result.results.length > 40, "checks executed");
});

test("readRuntimeConfigConst resolves string, null and absent declarations", () => {
  assert.equal(readRuntimeConfigConst(inputs.runtimeConfig, "API_BASE_URL"), COMMITTED_ORIGIN);
  assert.equal(
    readRuntimeConfigConst(inputs.runtimeConfig, "APP_STORE_ID"),
    COMMITTED_APP_STORE_ID,
  );
  assert.equal(readRuntimeConfigConst("const X: string | null = null;", "X"), null);
  assert.equal(readRuntimeConfigConst("const X: string | null =\n  'a';", "X"), "a");
  assert.equal(readRuntimeConfigConst('const X = "b";', "X"), "b");
  assert.equal(readRuntimeConfigConst("const Y = 'a';", "X"), undefined);
  assert.equal(readRuntimeConfigConst("const X: string | null = process.env.X;", "X"), undefined);
});

// --- RCD-04: production origin / App Store id -------------------------------

test("RCD-04: manifest production.apiOrigin 'tbd' FAILS", () => {
  const result = runChecks(
    withManifest(inputs, (m) => {
      m.environments.production.apiOrigin = "tbd";
    }),
  );
  assert.ok(failuresMatching(result, /production apiOrigin is a real https origin/).length === 1);
  assert.ok(failuresMatching(result, /production apiOrigin equals runtimeConfig\.ts/).length === 1);
});

test("RCD-04: manifest production.apiOrigin equal to the committed origin PASSES", () => {
  const result = runChecks(
    withManifest(inputs, (m) => {
      m.environments.production.apiOrigin = COMMITTED_ORIGIN;
    }),
  );
  assert.deepEqual(failuresMatching(result, /production apiOrigin/), []);
});

test("RCD-04: manifest production.apiOrigin differing from runtimeConfig FAILS", () => {
  const result = runChecks(
    withManifest(inputs, (m) => {
      m.environments.production.apiOrigin = "https://example.invalid/functions/v1/api";
    }),
  );
  assert.equal(failuresMatching(result, /production apiOrigin equals runtimeConfig\.ts/).length, 1);
});

test("RCD-04: runtimeConfig API_BASE_URL = null FAILS", () => {
  const result = runChecks(
    withRuntimeConfig(inputs, (src) =>
      src.replace(
        /const API_BASE_URL: string \| null =\s*'[^']*';/,
        "const API_BASE_URL: string | null = null;",
      ),
    ),
  );
  assert.equal(failuresMatching(result, /API_BASE_URL is a committed https origin/).length, 1);
  assert.equal(failuresMatching(result, /production apiOrigin equals runtimeConfig\.ts/).length, 1);
});

test("RCD-04: runtimeConfig APP_STORE_ID differing from manifest appStoreId FAILS", () => {
  const result = runChecks(
    withRuntimeConfig(inputs, (src) =>
      src.replace(
        `const APP_STORE_ID: string | null = '${COMMITTED_APP_STORE_ID}';`,
        "const APP_STORE_ID: string | null = '1';",
      ),
    ),
  );
  assert.equal(failuresMatching(result, /APP_STORE_ID equals manifest appStoreId/).length, 1);
});

test("RCD-04: manifest without appStoreId FAILS", () => {
  const result = runChecks(
    withManifest(inputs, (m) => {
      delete m.appStoreId;
    }),
  );
  assert.equal(failuresMatching(result, /appStoreId is a numeric Apple app id/).length, 1);
  assert.equal(failuresMatching(result, /APP_STORE_ID equals manifest appStoreId/).length, 1);
});

test("RCD-04: production mediaBucket 'tbd' FAILS", () => {
  const result = runChecks(
    withManifest(inputs, (m) => {
      m.environments.production.mediaBucket = "tbd";
    }),
  );
  assert.equal(failuresMatching(result, /production mediaBucket is recorded/).length, 1);
});

test("RCD-04: staging apiOrigin may be 'tbd' or a distinct https origin, never the production origin", () => {
  const distinct = runChecks(
    withManifest(inputs, (m) => {
      m.environments.staging.apiOrigin = "https://staging.example.invalid/functions/v1/api";
    }),
  );
  assert.deepEqual(failuresMatching(distinct, /staging apiOrigin/), []);
  const shared = runChecks(
    withManifest(inputs, (m) => {
      m.environments.staging.apiOrigin = COMMITTED_ORIGIN;
    }),
  );
  assert.equal(failuresMatching(shared, /staging apiOrigin/).length, 1);
});

// --- RCD-05: fastlane-assigned build numbers --------------------------------

test("RCD-05: manifest without lastShippedBuildNumber FAILS", () => {
  const result = runChecks(
    withManifest(inputs, (m) => {
      delete m.versionScheme.lastShippedBuildNumber;
    }),
  );
  assert.equal(failuresMatching(result, /lastShippedBuildNumber is a positive integer/).length, 1);
  assert.equal(failuresMatching(result, /is a floor <= lastShippedBuildNumber/).length, 1);
});

test("RCD-05: committed buildNumber above lastShippedBuildNumber FAILS (floor violated)", () => {
  const result = runChecks(
    withManifest(inputs, (m) => {
      m.versionScheme.lastShippedBuildNumber = m.versionScheme.buildNumber - 1;
    }),
  );
  assert.equal(failuresMatching(result, /is a floor <= lastShippedBuildNumber/).length, 1);
});

test("RCD-05: lastShippedBuildNumber not recorded in docs/APP_STORE_SUBMISSION.md §1 FAILS", () => {
  const result = runChecks(
    withManifest(inputs, (m) => {
      m.versionScheme.lastShippedBuildNumber = 999;
    }),
  );
  assert.equal(failuresMatching(result, /APP_STORE_SUBMISSION\.md §1 records Build 999/).length, 1);
});

test("RCD-05: buildNumber rule must describe the fastlane-assigned scheme", () => {
  const result = runChecks(
    withManifest(inputs, (m) => {
      m.versionScheme.rules.buildNumber =
        "monotonically increasing integer; MUST equal iOS CURRENT_PROJECT_VERSION and Android versionCode";
    }),
  );
  assert.equal(
    failuresMatching(result, /buildNumber rule describes the fastlane-assigned scheme/).length,
    1,
  );
});

test("RCD-05: lastShippedBuildNumber (>= 3) agrees with docs/APP_STORE_SUBMISSION.md §1", () => {
  assert.ok(inputs.manifest.versionScheme.lastShippedBuildNumber >= 3);
  assert.match(
    inputs.appStoreSubmission,
    new RegExp(`\\bBuild ${inputs.manifest.versionScheme.lastShippedBuildNumber}\\b`),
  );
});

// --- existing invariants stay pinned ----------------------------------------

test("monitoring hook deletion and unauthorized irreversible actions still FAIL", () => {
  const result = runChecks(
    withManifest(inputs, (m) => {
      m.monitoringHooks = m.monitoringHooks.filter((h) => h.id !== "consent_ledger_integrity");
      m.irreversibleActions[0].requiresHumanAuthorization = false;
    }),
  );
  assert.equal(failuresMatching(result, /consent_ledger_integrity present/).length, 1);
  assert.equal(failuresMatching(result, /requiresHumanAuthorization === true/).length, 1);
});
