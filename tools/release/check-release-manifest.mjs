#!/usr/bin/env node
/**
 * Release-manifest consistency check (Linux-validatable).
 *
 * Verifies that infra/release/release-manifest.json is internally coherent
 * and agrees with the mobile projects' committed version/build numbers, that
 * every mandatory monitoring line from docs/RELEASE_PLAN_V1.md §6 is present,
 * that every rollback hook and irreversible action carries an explicit
 * requiresHumanAuthorization flag, and that no real staging/production origin
 * has been committed prematurely (they are BLOCKED_EXTERNAL and must stay
 * "tbd" until provisioned by a human).
 *
 * This script executes no release action. Exit 0 = all green.
 *
 * Usage: node tools/release/check-release-manifest.mjs   (or `pnpm release:check`)
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

  const manifest = JSON.parse(read("infra/release/release-manifest.json"));

  // --- version scheme agrees with committed mobile projects -------------------
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

  const pbxproj = read("apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj");
  check(
    `pbxproj: MARKETING_VERSION = ${marketingVersion}`,
    pbxproj.includes(`MARKETING_VERSION = ${marketingVersion};`),
  );
  check(
    `pbxproj: CURRENT_PROJECT_VERSION = ${buildNumber}`,
    pbxproj.includes(`CURRENT_PROJECT_VERSION = ${buildNumber};`),
  );

  const gradle = read("apps/mobile/android/app/build.gradle");
  check(
    `build.gradle: versionName "${marketingVersion}"`,
    gradle.includes(`versionName "${marketingVersion}"`),
  );
  check(
    `build.gradle: versionCode ${buildNumber}`,
    new RegExp(`versionCode ${buildNumber}\\b`).test(gradle),
  );

  const runtimeConfig = read("apps/mobile/src/config/runtimeConfig.ts");
  check(
    `runtimeConfig.ts: APP_VERSION = '${marketingVersion}'`,
    runtimeConfig.includes(`const APP_VERSION = '${marketingVersion}';`),
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

  // --- monitoring hooks: every mandatory §6 line present, none deleted ---------
  const REQUIRED_MONITORING_IDS = [
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
  const monitoringIds = new Set((manifest.monitoringHooks ?? []).map((hook) => hook.id));
  for (const id of REQUIRED_MONITORING_IDS) {
    check(`monitoringHooks: ${id} present`, monitoringIds.has(id));
  }
  for (const hook of manifest.monitoringHooks ?? []) {
    check(
      `monitoringHooks: ${hook.id} has signal, alarm, severity`,
      typeof hook.signal === "string" &&
        typeof hook.alarm === "string" &&
        (hook.severity === "P0" || hook.severity === "P1"),
    );
  }
  check(
    "monitoringHooks: consent integrity and silent-failure lines are P0",
    (manifest.monitoringHooks ?? [])
      .filter((hook) => ["consent_ledger_integrity", "silent_failure_rate"].includes(hook.id))
      .every((hook) => hook.severity === "P0"),
  );

  // --- rollback hooks: explicit authorization flags ----------------------------
  const REQUIRED_ROLLBACK_IDS = [
    "mobile_pause_phased_release",
    "mobile_expedited_resubmission",
    "server_side_kill_switch",
    "backend_image_rollback",
    "db_forward_fix",
    "db_snapshot_restore",
  ];
  const rollbackIds = new Set((manifest.rollbackHooks ?? []).map((hook) => hook.id));
  for (const id of REQUIRED_ROLLBACK_IDS) {
    check(`rollbackHooks: ${id} present`, rollbackIds.has(id));
  }
  for (const hook of manifest.rollbackHooks ?? []) {
    check(
      `rollbackHooks: ${hook.id} has action + explicit requiresHumanAuthorization`,
      typeof hook.action === "string" && typeof hook.requiresHumanAuthorization === "boolean",
    );
  }

  // --- irreversible actions all require human authorization --------------------
  const irreversible = manifest.irreversibleActions ?? [];
  check("irreversibleActions: non-empty", irreversible.length > 0);
  for (const action of irreversible) {
    check(
      `irreversibleActions: ${action.id} requiresHumanAuthorization === true`,
      action.requiresHumanAuthorization === true,
    );
  }

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
