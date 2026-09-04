#!/usr/bin/env node
/**
 * Release-manifest consistency check (Linux-validatable).
 *
 * Verifies that infra/release/release-manifest.json pins the release
 * contract (schemaVersion, every release-blocking step, every irreversible
 * action, explicit human authorization on every rollback hook and
 * irreversible action, non-empty monitoring/rollback text, unique ids) and
 * agrees with the mobile projects' committed version/build numbers in EVERY
 * build configuration, that every mandatory monitoring line from
 * docs/RELEASE_PLAN_V1.md §6 is present, and that no real staging/production
 * origin has been committed prematurely (they are BLOCKED_EXTERNAL and must
 * stay "tbd" until provisioned by a human).
 *
 * Version comparisons run on the effective (comment-stripped) sources, and
 * every occurrence must agree: a Release-only drift or a correct value that
 * survives only inside a comment is a failure.
 *
 * This script executes no release action. Exit 0 = all green.
 *
 * Usage: node tools/release/check-release-manifest.mjs   (or `pnpm release:check`)
 * Tests: node --test tools/release/check-release-manifest.test.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// --- pure helpers (also imported by the unit tests) ----------------------------

/**
 * Removes comments while leaving string literals intact, so a `//` inside a
 * URL or a `#` inside a Ruby `"#{...}"` interpolation is not a comment. Each
 * comment is replaced by the empty string; newlines outside comments stay.
 *
 * @param {string} text
 * @param {{ line?: string[], block?: boolean }} [options]
 *   line  — comment openers that run to end of line (default `["//"]`)
 *   block — whether `/* ... *\/` block comments are stripped (default true)
 */
export function stripComments(text, { line = ["//"], block = true } = {}) {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < n && text[j] !== quote) {
        if (text[j] === "\\") j += 1;
        j += 1;
      }
      out += text.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }
    if (block && text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    const opener = line.find((marker) => text.startsWith(marker, i));
    if (opener !== undefined) {
      const end = text.indexOf("\n", i);
      i = end < 0 ? n : end;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function unquote(value) {
  const v = value.trim();
  const q = v[0];
  if ((q === '"' || q === "'") && v.length >= 2 && v[v.length - 1] === q) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Every effective `KEY = value;` build-setting occurrence in a project.pbxproj,
 * in file order, unquoted. One entry per build configuration that sets it.
 */
export function extractBuildSettingValues(pbxproj, key) {
  const re = new RegExp(`(?:^|[\\s{;])${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|[^;]*?)\\s*;`, "g");
  const values = [];
  for (const match of stripComments(pbxproj).matchAll(re)) {
    values.push(unquote(match[1]));
  }
  return values;
}

/**
 * Every effective `key value` / `key = value` occurrence in a build.gradle
 * (Groovy or Kotlin DSL), in file order, unquoted.
 */
export function extractGradleValues(gradle, key) {
  const re = new RegExp(`\\b${key}\\b\\s*=?\\s*("[^"]*"|'[^']*'|[^\\s,)]+)`, "g");
  const values = [];
  for (const match of stripComments(gradle).matchAll(re)) {
    values.push(unquote(match[1]));
  }
  return values;
}

/** Every effective `const APP_VERSION = '<v>';` value in runtimeConfig.ts. */
export function extractAppVersions(runtimeConfig) {
  const re = /\bconst\s+APP_VERSION\s*(?::\s*[^=]+?)?=\s*(["'`])([^"'`]*)\1/g;
  const values = [];
  for (const match of stripComments(runtimeConfig).matchAll(re)) {
    values.push(match[2]);
  }
  return values;
}

// --- manifest contract ----------------------------------------------------------

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

const MANIFEST = "infra/release/release-manifest.json";
const PBXPROJ = "apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj";
const GRADLE = "apps/mobile/android/app/build.gradle";
const RUNTIME_CONFIG = "apps/mobile/src/config/runtimeConfig.ts";

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const nonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;

function describe(values) {
  return values.length === 0 ? "none found" : `found: ${values.join(", ")}`;
}

export function main(repoRoot) {
  const failures = [];

  function check(label, ok) {
    if (!ok) failures.push(label);
    console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  }

  /** Reads an input file; an unreadable input is a reported FAIL, not a crash. */
  function readInput(relPath) {
    let text;
    try {
      text = readFileSync(join(repoRoot, relPath), "utf8");
    } catch (error) {
      check(`${relPath}: readable (${error.code ?? error.message})`, false);
      return null;
    }
    check(`${relPath}: readable`, true);
    return text;
  }

  /** `manifest[key]` as an array of `{ id: string }` records, reporting shape errors. */
  function entries(manifest, key) {
    const list = manifest[key];
    check(`${key}: is an array`, Array.isArray(list));
    if (!Array.isArray(list)) return [];
    check(
      `${key}: every entry is an object with a string id`,
      list.every((entry) => isRecord(entry) && nonEmptyString(entry.id)),
    );
    return list.filter((entry) => isRecord(entry) && nonEmptyString(entry.id));
  }

  function checkUniqueIds(label, ids) {
    const seen = new Set();
    const duplicates = new Set();
    for (const id of ids) {
      if (seen.has(id)) duplicates.add(id);
      seen.add(id);
    }
    check(
      `${label}: ids unique${duplicates.size ? ` (duplicated: ${[...duplicates].join(", ")})` : ""}`,
      duplicates.size === 0,
    );
  }

  // --- manifest parses ------------------------------------------------------------
  const manifestText = readInput(MANIFEST);
  let manifest = {};
  if (manifestText !== null) {
    let parsed;
    try {
      parsed = JSON.parse(manifestText);
    } catch (error) {
      check(`${MANIFEST}: parses as JSON (${error.message})`, false);
    }
    if (parsed !== undefined) {
      check(`${MANIFEST}: is a JSON object`, isRecord(parsed));
      if (isRecord(parsed)) manifest = parsed;
    }
  }

  check(
    `manifest: schemaVersion === ${REQUIRED_SCHEMA_VERSION}`,
    manifest.schemaVersion === REQUIRED_SCHEMA_VERSION,
  );

  // --- version scheme agrees with EVERY committed mobile build configuration --------
  const versionScheme = isRecord(manifest.versionScheme) ? manifest.versionScheme : {};
  const marketingVersion = versionScheme.marketingVersion;
  const buildNumber = versionScheme.buildNumber;
  check(
    "manifest: marketingVersion is MAJOR.MINOR[.PATCH]",
    typeof marketingVersion === "string" && /^\d+\.\d+(\.\d+)?$/.test(marketingVersion),
  );
  check(
    "manifest: buildNumber is a positive integer",
    Number.isInteger(buildNumber) && buildNumber >= 1,
  );
  const expectedBuild = String(buildNumber);

  const pbxproj = readInput(PBXPROJ);
  if (pbxproj !== null) {
    for (const [key, expected] of [
      ["MARKETING_VERSION", marketingVersion],
      ["CURRENT_PROJECT_VERSION", expectedBuild],
    ]) {
      const values = extractBuildSettingValues(pbxproj, key);
      check(
        `pbxproj: ${key} = ${expected} in every build configuration (>= 2 occurrences; ${describe(values)})`,
        values.length >= 2 && values.every((value) => value === expected),
      );
    }
  }

  const gradle = readInput(GRADLE);
  if (gradle !== null) {
    for (const [key, expected] of [
      ["versionName", marketingVersion],
      ["versionCode", expectedBuild],
    ]) {
      const values = extractGradleValues(gradle, key);
      check(
        `build.gradle: effective ${key} ${JSON.stringify(expected)} (comment-stripped; ${describe(values)})`,
        values.length >= 1 && values.every((value) => value === expected),
      );
    }
  }

  const runtimeConfig = readInput(RUNTIME_CONFIG);
  if (runtimeConfig !== null) {
    const values = extractAppVersions(runtimeConfig);
    check(
      `runtimeConfig.ts: effective APP_VERSION = '${marketingVersion}' (comment-stripped; ${describe(values)})`,
      values.length >= 1 && values.every((value) => value === marketingVersion),
    );
  }

  // --- environment separation --------------------------------------------------
  const envs = isRecord(manifest.environments) ? manifest.environments : {};
  for (const name of ["development", "staging", "production"]) {
    check(`environments: ${name} defined`, isRecord(envs[name]));
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

  // --- release-blocking steps: every committed step stays, none weakened ----------
  const steps = entries(manifest, "releaseBlockingSteps");
  const stepIds = new Set(steps.map((step) => step.id));
  for (const id of REQUIRED_RELEASE_BLOCKING_STEP_IDS) {
    check(`releaseBlockingSteps: ${id} present`, stepIds.has(id));
  }
  for (const step of steps) {
    check(
      `releaseBlockingSteps: ${step.id} description is non-empty`,
      nonEmptyString(step.description),
    );
    check(`releaseBlockingSteps: ${step.id} source is non-empty`, nonEmptyString(step.source));
  }
  checkUniqueIds("releaseBlockingSteps", [...steps.map((step) => step.id)]);

  // --- monitoring hooks: every mandatory §6 line present, none deleted ---------
  const monitoring = entries(manifest, "monitoringHooks");
  const monitoringIds = new Set(monitoring.map((hook) => hook.id));
  for (const id of REQUIRED_MONITORING_IDS) {
    check(`monitoringHooks: ${id} present`, monitoringIds.has(id));
  }
  for (const hook of monitoring) {
    check(`monitoringHooks: ${hook.id} signal is non-empty`, nonEmptyString(hook.signal));
    check(`monitoringHooks: ${hook.id} alarm is non-empty`, nonEmptyString(hook.alarm));
    check(
      `monitoringHooks: ${hook.id} severity is P0 or P1`,
      hook.severity === "P0" || hook.severity === "P1",
    );
  }
  check(
    "monitoringHooks: consent integrity and silent-failure lines are P0",
    monitoring
      .filter((hook) => ["consent_ledger_integrity", "silent_failure_rate"].includes(hook.id))
      .every((hook) => hook.severity === "P0"),
  );
  checkUniqueIds("monitoringHooks", [...monitoring.map((hook) => hook.id)]);

  // --- rollback hooks: every one is a human decision ---------------------------
  const rollback = entries(manifest, "rollbackHooks");
  const rollbackIds = new Set(rollback.map((hook) => hook.id));
  for (const id of REQUIRED_ROLLBACK_IDS) {
    check(`rollbackHooks: ${id} present`, rollbackIds.has(id));
  }
  for (const hook of rollback) {
    check(`rollbackHooks: ${hook.id} action is non-empty`, nonEmptyString(hook.action));
    check(
      `rollbackHooks: ${hook.id} requiresHumanAuthorization === true`,
      hook.requiresHumanAuthorization === true,
    );
  }
  checkUniqueIds("rollbackHooks", [...rollback.map((hook) => hook.id)]);

  // --- irreversible actions: the committed set stays, all human-authorized ------
  const irreversible = entries(manifest, "irreversibleActions");
  const irreversibleIds = new Set(irreversible.map((action) => action.id));
  for (const id of REQUIRED_IRREVERSIBLE_ACTION_IDS) {
    check(`irreversibleActions: ${id} present`, irreversibleIds.has(id));
  }
  for (const action of irreversible) {
    check(
      `irreversibleActions: ${action.id} requiresHumanAuthorization === true`,
      action.requiresHumanAuthorization === true,
    );
  }
  checkUniqueIds("irreversibleActions", [...irreversible.map((action) => action.id)]);

  checkUniqueIds(
    "manifest: ids unique across monitoringHooks, rollbackHooks, irreversibleActions, releaseBlockingSteps",
    [
      ...monitoring.map((hook) => hook.id),
      ...rollback.map((hook) => hook.id),
      ...irreversible.map((action) => action.id),
      ...steps.map((step) => step.id),
    ],
  );

  if (failures.length > 0) {
    console.error(`\n${failures.length} release-manifest check(s) failed.`);
    return 1;
  }
  console.log("\nAll release-manifest checks passed.");
  console.log(
    "NOT validated here (external/Mac-only): signing, archive, TestFlight upload, store submission, live monitoring wiring.",
  );
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  process.exitCode = main(repoRoot);
}
