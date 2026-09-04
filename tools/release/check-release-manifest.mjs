#!/usr/bin/env node
/**
 * Release-manifest consistency check (Linux-validatable).
 *
 * Verifies that infra/release/release-manifest.json is internally coherent
 * and agrees with the mobile projects' committed version/build numbers (in
 * EVERY build configuration, comments ignored), that the manifest contract is
 * pinned (schemaVersion, every release-blocking step, every irreversible
 * action, unique ids), that every mandatory monitoring line from
 * docs/RELEASE_PLAN_V1.md §6 is present with a non-empty signal + alarm, that
 * every rollback hook and irreversible action requires human authorization,
 * and that no real staging/production origin has been committed prematurely
 * (they are BLOCKED_EXTERNAL and must stay "tbd" until provisioned by a human).
 *
 * This script executes no release action. Exit 0 = all green.
 *
 * Usage: node tools/release/check-release-manifest.mjs   (or `pnpm release:check`)
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MANIFEST_PATH = "infra/release/release-manifest.json";
const PBXPROJ_PATH = "apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj";
const GRADLE_PATH = "apps/mobile/android/app/build.gradle";
const RUNTIME_CONFIG_PATH = "apps/mobile/src/config/runtimeConfig.ts";

export const REQUIRED_SCHEMA_VERSION = 1;

export const REQUIRED_RELEASE_BLOCKING_STEP_IDS = [
  "claim_gate_language_check",
  "privacy_disclosure_sync",
  "flag_drift_check",
  "distribution_preconditions",
];

export const REQUIRED_MONITORING_IDS = [
  "silent_failure_rate",
  "target_wrong_lock",
  "excess_abstention",
  "envelope_verdict_distribution",
  "crash_free_sessions",
  "pipeline_latency",
  "session_engine_states",
  "consent_ledger_integrity",
  "flag_drift",
];

export const REQUIRED_ROLLBACK_IDS = [
  "mobile_pause_phased_release",
  "mobile_expedited_resubmission",
  "server_side_kill_switch",
  "backend_image_rollback",
  "db_forward_fix",
  "db_snapshot_restore",
];

export const REQUIRED_IRREVERSIBLE_ACTION_IDS = [
  "app_store_submission",
  "testflight_external_distribution",
  "production_db_migration",
  "production_snapshot_restore",
  "signing_certificate_rotation",
  "enable_distribute_external_flag",
  "external_accuracy_or_latency_claim",
];

/**
 * Removes `//` line comments and `/* ... *\/` block comments while leaving
 * string literals (delimited by any of `quotes`) intact, so a value that only
 * survives inside a comment can never satisfy a check. Line structure is
 * preserved (newlines inside block comments are kept).
 */
export function stripComments(text, quotes = ['"', "'", "`"]) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (quotes.includes(ch)) {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) {
        if (text[j] === "\\") j += 1;
        j += 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "/" && next === "/") {
      let j = text.indexOf("\n", i);
      if (j === -1) j = text.length;
      i = j;
    } else if (ch === "/" && next === "*") {
      let j = text.indexOf("*/", i + 2);
      if (j === -1) j = text.length;
      out += text.slice(i, j).replace(/[^\n]/g, "");
      i = j + 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/**
 * Every effective (non-comment) value of an Xcode build setting in a
 * project.pbxproj, in file order, with surrounding quotes removed. One entry
 * per build configuration (Debug, Release, ...) that sets it.
 */
export function pbxSettingValues(pbxproj, setting) {
  const stripped = stripComments(pbxproj, ['"']);
  const re = new RegExp(
    `(?<![\\w.])${setting}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^;\\s]+))\\s*;`,
    "g",
  );
  const values = [];
  for (const match of stripped.matchAll(re)) {
    values.push(match[1] !== undefined ? match[1] : match[2]);
  }
  return values;
}

/** Every effective `versionName "X"` in build.gradle (Groovy; comments stripped). */
export function gradleVersionNames(gradle) {
  return [
    ...stripComments(gradle, ['"', "'"]).matchAll(/\bversionName\s*=?\s*(["'])([^"']*)\1/g),
  ].map((m) => m[2]);
}

/** Every effective `versionCode N` in build.gradle (Groovy; comments stripped). */
export function gradleVersionCodes(gradle) {
  return [...stripComments(gradle, ['"', "'"]).matchAll(/\bversionCode\s*=?\s*(\d+)\b/g)].map(
    (m) => m[1],
  );
}

/** Every effective `const APP_VERSION = 'X';` (single or double quoted) in runtimeConfig.ts. */
export function runtimeAppVersions(runtimeConfig) {
  return [
    ...stripComments(runtimeConfig).matchAll(/\bconst\s+APP_VERSION\s*=\s*(["'])([^"']*)\1\s*;/g),
  ].map((m) => m[2]);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function describeValues(values) {
  return values.length === 0 ? "none found" : `found ${values.length}: ${values.join(", ")}`;
}

/**
 * Runs every check against the repository rooted at `repoRoot`.
 * Returns the printed lines and the labels of the failed checks.
 */
export function runReleaseManifestChecks(repoRoot) {
  const failures = [];
  const lines = [];

  function check(label, ok) {
    if (!ok) failures.push(label);
    lines.push(`${ok ? "ok  " : "FAIL"} ${label}`);
  }

  function read(relPath) {
    return readFileSync(join(repoRoot, relPath), "utf8");
  }

  // --- manifest is readable JSON ------------------------------------------------
  let manifest;
  try {
    manifest = JSON.parse(read(MANIFEST_PATH));
  } catch (error) {
    check(`manifest: ${MANIFEST_PATH} is readable JSON (${error.message})`, false);
    return { lines, failures };
  }
  const isObject = manifest !== null && typeof manifest === "object" && !Array.isArray(manifest);
  check(`manifest: ${MANIFEST_PATH} is a JSON object`, isObject);
  if (!isObject) return { lines, failures };

  /** A top-level list; a missing or non-array list is a FAIL and reads as empty. */
  function list(name) {
    const value = manifest[name];
    const ok = Array.isArray(value);
    check(`${name}: is an array`, ok);
    return ok ? value : [];
  }

  // --- manifest contract ----------------------------------------------------------
  check(
    `manifest: schemaVersion === ${REQUIRED_SCHEMA_VERSION}`,
    manifest.schemaVersion === REQUIRED_SCHEMA_VERSION,
  );

  // --- version scheme agrees with committed mobile projects (every configuration) ---
  const marketingVersion = manifest.versionScheme?.marketingVersion;
  const buildNumber = manifest.versionScheme?.buildNumber;
  check(
    "manifest: marketingVersion is MAJOR.MINOR[.PATCH]",
    typeof marketingVersion === "string" && /^\d+\.\d+(\.\d+)?$/.test(marketingVersion),
  );
  check(
    "manifest: buildNumber is a positive integer",
    Number.isInteger(buildNumber) && buildNumber >= 1,
  );

  /** `values` must have at least `min` entries and every one must equal `expected`. */
  function checkAllEqual(label, values, expected, min) {
    check(
      `${label} (${describeValues(values)}; need >= ${min}, all equal)`,
      values.length >= min && values.every((value) => value === expected),
    );
  }

  const pbxproj = read(PBXPROJ_PATH);
  checkAllEqual(
    `pbxproj: MARKETING_VERSION = ${marketingVersion} in every build configuration`,
    pbxSettingValues(pbxproj, "MARKETING_VERSION"),
    marketingVersion,
    2,
  );
  checkAllEqual(
    `pbxproj: CURRENT_PROJECT_VERSION = ${buildNumber} in every build configuration`,
    pbxSettingValues(pbxproj, "CURRENT_PROJECT_VERSION"),
    String(buildNumber),
    2,
  );

  const gradle = read(GRADLE_PATH);
  checkAllEqual(
    `build.gradle: effective versionName "${marketingVersion}"`,
    gradleVersionNames(gradle),
    marketingVersion,
    1,
  );
  checkAllEqual(
    `build.gradle: effective versionCode ${buildNumber}`,
    gradleVersionCodes(gradle),
    String(buildNumber),
    1,
  );

  const runtimeConfig = read(RUNTIME_CONFIG_PATH);
  checkAllEqual(
    `runtimeConfig.ts: effective APP_VERSION = '${marketingVersion}'`,
    runtimeAppVersions(runtimeConfig),
    marketingVersion,
    1,
  );

  // --- environment separation --------------------------------------------------
  const envs = manifest.environments ?? {};
  for (const name of ["development", "staging", "production"]) {
    check(`environments: ${name} defined`, typeof envs[name] === "object");
  }
  check(
    "environments: development has no API origin (local-first default)",
    envs.development?.apiOrigin === null,
  );
  for (const name of ["staging", "production"]) {
    check(
      `environments: ${name} origin/bucket still "tbd" (BLOCKED_EXTERNAL — no real URL committed)`,
      envs[name]?.apiOrigin === "tbd" && envs[name]?.mediaBucket === "tbd",
    );
  }
  check(
    "environments: only production carries real user data",
    envs.production?.realUserData === true &&
      envs.staging?.realUserData === false &&
      envs.development?.realUserData === false,
  );

  // --- release-blocking steps: every pinned step present, none deleted --------
  const releaseBlockingSteps = list("releaseBlockingSteps");
  const stepIds = new Set(releaseBlockingSteps.map((step) => step.id));
  for (const id of REQUIRED_RELEASE_BLOCKING_STEP_IDS) {
    check(`releaseBlockingSteps: ${id} present`, stepIds.has(id));
  }
  for (const step of releaseBlockingSteps) {
    check(
      `releaseBlockingSteps: ${step.id} has non-empty description + source`,
      isNonEmptyString(step.id) &&
        isNonEmptyString(step.description) &&
        isNonEmptyString(step.source),
    );
  }

  // --- monitoring hooks: every mandatory §6 line present, none deleted ---------
  const monitoringHooks = list("monitoringHooks");
  const monitoringIds = new Set(monitoringHooks.map((hook) => hook.id));
  for (const id of REQUIRED_MONITORING_IDS) {
    check(`monitoringHooks: ${id} present`, monitoringIds.has(id));
  }
  for (const hook of monitoringHooks) {
    check(
      `monitoringHooks: ${hook.id} has non-empty signal + alarm and severity P0|P1`,
      isNonEmptyString(hook.id) &&
        isNonEmptyString(hook.signal) &&
        isNonEmptyString(hook.alarm) &&
        (hook.severity === "P0" || hook.severity === "P1"),
    );
  }
  check(
    "monitoringHooks: consent integrity and silent-failure lines are P0",
    monitoringHooks
      .filter((hook) => ["consent_ledger_integrity", "silent_failure_rate"].includes(hook.id))
      .every((hook) => hook.severity === "P0"),
  );

  // --- rollback hooks: non-empty action, human authorization required ---------
  const rollbackHooks = list("rollbackHooks");
  const rollbackIds = new Set(rollbackHooks.map((hook) => hook.id));
  for (const id of REQUIRED_ROLLBACK_IDS) {
    check(`rollbackHooks: ${id} present`, rollbackIds.has(id));
  }
  for (const hook of rollbackHooks) {
    check(
      `rollbackHooks: ${hook.id} has non-empty action + requiresHumanAuthorization === true`,
      isNonEmptyString(hook.id) &&
        isNonEmptyString(hook.action) &&
        hook.requiresHumanAuthorization === true,
    );
  }

  // --- irreversible actions: every pinned id present, all human-authorized -----
  const irreversible = list("irreversibleActions");
  const irreversibleIds = new Set(irreversible.map((action) => action.id));
  for (const id of REQUIRED_IRREVERSIBLE_ACTION_IDS) {
    check(`irreversibleActions: ${id} present`, irreversibleIds.has(id));
  }
  for (const action of irreversible) {
    check(
      `irreversibleActions: ${action.id} requiresHumanAuthorization === true`,
      isNonEmptyString(action.id) && action.requiresHumanAuthorization === true,
    );
  }

  // --- ids are unique across every list ------------------------------------------
  const allIds = [
    ...monitoringHooks,
    ...rollbackHooks,
    ...irreversible,
    ...releaseBlockingSteps,
  ].map((entry) => entry.id);
  const duplicateIds = [...new Set(allIds.filter((id, index) => allIds.indexOf(id) !== index))];
  check(
    `manifest: ids are unique across monitoringHooks, rollbackHooks, irreversibleActions, releaseBlockingSteps${
      duplicateIds.length > 0 ? ` (duplicates: ${duplicateIds.join(", ")})` : ""
    }`,
    duplicateIds.length === 0,
  );

  return { lines, failures };
}

function main() {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const { lines, failures } = runReleaseManifestChecks(repoRoot);
  for (const line of lines) console.log(line);
  if (failures.length > 0) {
    console.error(`\n${failures.length} release-manifest check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll release-manifest checks passed.");
  console.log(
    "NOT validated here (external/Mac-only): signing, archive, TestFlight upload, store submission, live monitoring wiring.",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
