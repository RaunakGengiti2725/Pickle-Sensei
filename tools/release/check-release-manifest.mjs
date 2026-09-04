#!/usr/bin/env node
/**
 * Release-manifest consistency check (Linux-validatable).
 *
 * Verifies that infra/release/release-manifest.json is internally coherent
 * and agrees with the mobile projects' committed version/build numbers and
 * the committed public runtime configuration (production API origin and
 * App Store id in apps/mobile/src/config/runtimeConfig.ts), that the recorded
 * shipping state (last shipped TestFlight build, docs/APP_STORE_SUBMISSION.md
 * §1) is consistent with the fastlane-assigned build-number scheme, that
 * every mandatory monitoring line from docs/RELEASE_PLAN_V1.md §6 is present,
 * and that every rollback hook and irreversible action carries an explicit
 * requiresHumanAuthorization flag.
 *
 * This script executes no release action. Exit 0 = all green.
 *
 * Usage: node tools/release/check-release-manifest.mjs   (or `pnpm release:check`)
 * Tests: node --test tools/release/check-release-manifest.test.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const INPUT_PATHS = {
  manifest: "infra/release/release-manifest.json",
  pbxproj: "apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj",
  gradle: "apps/mobile/android/app/build.gradle",
  runtimeConfig: "apps/mobile/src/config/runtimeConfig.ts",
  appStoreSubmission: "docs/APP_STORE_SUBMISSION.md",
};

/** Read every input the checks need from a repository checkout. */
export function loadInputs(repoRoot = REPO_ROOT) {
  const read = (relPath) => readFileSync(join(repoRoot, relPath), "utf8");
  return {
    manifest: JSON.parse(read(INPUT_PATHS.manifest)),
    pbxproj: read(INPUT_PATHS.pbxproj),
    gradle: read(INPUT_PATHS.gradle),
    runtimeConfig: read(INPUT_PATHS.runtimeConfig),
    appStoreSubmission: read(INPUT_PATHS.appStoreSubmission),
  };
}

/**
 * Resolve the effective value of a `const NAME: string | null = <literal>;`
 * declaration in runtimeConfig.ts. Returns the string, `null` for a literal
 * null, or `undefined` when the declaration is absent or not a plain literal
 * (which the checks treat as a failure — the value must be statically known).
 */
export function readRuntimeConfigConst(source, name) {
  const pattern = new RegExp(
    `const ${name}(?:\\s*:\\s*string\\s*\\|\\s*null)?\\s*=\\s*(null|'([^']*)'|"([^"]*)")\\s*;`,
  );
  const match = pattern.exec(source);
  if (!match) return undefined;
  if (match[1] === "null") return null;
  return match[2] ?? match[3];
}

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

const REQUIRED_ROLLBACK_IDS = [
  "mobile_pause_phased_release",
  "mobile_expedited_resubmission",
  "server_side_kill_switch",
  "backend_image_rollback",
  "db_forward_fix",
  "db_snapshot_restore",
];

const HTTPS_ORIGIN = /^https:\/\/[^\s'"]+$/;

/**
 * Run every check against already-loaded inputs. Pure: no I/O, no exit.
 * Returns `{ results, failures }` where each result is `{ label, ok }`.
 */
export function runChecks({ manifest, pbxproj, gradle, runtimeConfig, appStoreSubmission }) {
  const results = [];
  const check = (label, ok) => {
    results.push({ label, ok: ok === true });
  };

  // --- version scheme agrees with committed mobile projects -----------------
  const scheme = manifest.versionScheme ?? {};
  const marketingVersion = scheme.marketingVersion;
  const buildNumber = scheme.buildNumber;
  check(
    "manifest: marketingVersion is MAJOR.MINOR[.PATCH]",
    typeof marketingVersion === "string" && /^\d+\.\d+(\.\d+)?$/.test(marketingVersion),
  );
  check(
    "manifest: buildNumber is a positive integer",
    Number.isInteger(buildNumber) && buildNumber >= 1,
  );

  check(
    `pbxproj: MARKETING_VERSION = ${marketingVersion}`,
    pbxproj.includes(`MARKETING_VERSION = ${marketingVersion};`),
  );
  check(
    `pbxproj: CURRENT_PROJECT_VERSION = ${buildNumber}`,
    pbxproj.includes(`CURRENT_PROJECT_VERSION = ${buildNumber};`),
  );

  check(
    `build.gradle: versionName "${marketingVersion}"`,
    gradle.includes(`versionName "${marketingVersion}"`),
  );
  check(
    `build.gradle: versionCode ${buildNumber}`,
    new RegExp(`versionCode ${buildNumber}\\b`).test(gradle),
  );

  check(
    `runtimeConfig.ts: APP_VERSION = '${marketingVersion}'`,
    runtimeConfig.includes(`const APP_VERSION = '${marketingVersion}';`),
  );

  // --- build numbers are assigned by fastlane; the committed value is a floor -
  // Fastfile `beta`/`release` lanes archive with
  // CURRENT_PROJECT_VERSION=latest_testflight_build_number + 1, so the committed
  // pbxproj/gradle value never ships through them. The manifest records the
  // last build that actually shipped (docs/APP_STORE_SUBMISSION.md §1) so the
  // committed floor can be checked against reality.
  const lastShipped = scheme.lastShippedBuildNumber;
  check(
    "manifest: lastShippedBuildNumber is a positive integer",
    Number.isInteger(lastShipped) && lastShipped >= 1,
  );
  check(
    `manifest: committed buildNumber (${buildNumber}) is a floor <= lastShippedBuildNumber (${lastShipped})`,
    Number.isInteger(lastShipped) && Number.isInteger(buildNumber) && buildNumber <= lastShipped,
  );
  check(
    "manifest: buildNumber rule describes the fastlane-assigned scheme (latest_testflight_build_number + 1)",
    typeof scheme.rules?.buildNumber === "string" &&
      scheme.rules.buildNumber.includes("latest_testflight_build_number + 1"),
  );
  check(
    `docs/APP_STORE_SUBMISSION.md §1 records Build ${lastShipped}`,
    Number.isInteger(lastShipped) &&
      new RegExp(`\\bBuild ${lastShipped}\\b`).test(appStoreSubmission),
  );

  // --- environment separation ----------------------------------------------
  const envs = manifest.environments ?? {};
  for (const name of ["development", "staging", "production"]) {
    check(`environments: ${name} defined`, typeof envs[name] === "object" && envs[name] !== null);
  }
  check(
    "environments: development has no API origin (local-first default)",
    envs.development?.apiOrigin === null,
  );

  // The production origin is public, non-secret configuration and IS committed
  // (apps/mobile talks to the Supabase Edge Function). The manifest must record
  // the same origin the shipping binary is built with.
  const committedOrigin = readRuntimeConfigConst(runtimeConfig, "API_BASE_URL");
  const productionOrigin = envs.production?.apiOrigin;
  check(
    "runtimeConfig.ts: API_BASE_URL is a committed https origin (not null)",
    typeof committedOrigin === "string" && HTTPS_ORIGIN.test(committedOrigin),
  );
  check(
    'environments: production apiOrigin is a real https origin (not "tbd")',
    typeof productionOrigin === "string" && HTTPS_ORIGIN.test(productionOrigin),
  );
  check(
    `environments: production apiOrigin equals runtimeConfig.ts API_BASE_URL (${committedOrigin ?? "null"})`,
    typeof committedOrigin === "string" && productionOrigin === committedOrigin,
  );
  check(
    'environments: production mediaBucket is recorded (not "tbd")',
    "mediaBucket" in (envs.production ?? {}) && envs.production.mediaBucket !== "tbd",
  );
  check(
    'environments: staging apiOrigin is "tbd" (unprovisioned) or an https origin distinct from production',
    envs.staging?.apiOrigin === "tbd" ||
      (typeof envs.staging?.apiOrigin === "string" &&
        HTTPS_ORIGIN.test(envs.staging.apiOrigin) &&
        envs.staging.apiOrigin !== productionOrigin),
  );
  check(
    "environments: only production carries real user data",
    envs.production?.realUserData === true &&
      envs.staging?.realUserData === false &&
      envs.development?.realUserData === false,
  );

  // --- App Store record agrees with the committed runtime config ------------
  const committedAppStoreId = readRuntimeConfigConst(runtimeConfig, "APP_STORE_ID");
  const manifestAppStoreId = manifest.appStoreId;
  check(
    "manifest: appStoreId is a numeric Apple app id",
    typeof manifestAppStoreId === "string" && /^\d+$/.test(manifestAppStoreId),
  );
  check(
    `runtimeConfig.ts: APP_STORE_ID equals manifest appStoreId (${manifestAppStoreId ?? "missing"})`,
    typeof committedAppStoreId === "string" && committedAppStoreId === manifestAppStoreId,
  );

  // --- monitoring hooks: every mandatory §6 line present, none deleted -------
  const monitoringHooks = manifest.monitoringHooks ?? [];
  const monitoringIds = new Set(monitoringHooks.map((hook) => hook.id));
  for (const id of REQUIRED_MONITORING_IDS) {
    check(`monitoringHooks: ${id} present`, monitoringIds.has(id));
  }
  for (const hook of monitoringHooks) {
    check(
      `monitoringHooks: ${hook.id} has signal, alarm, severity`,
      typeof hook.signal === "string" &&
        typeof hook.alarm === "string" &&
        (hook.severity === "P0" || hook.severity === "P1"),
    );
  }
  check(
    "monitoringHooks: consent integrity and silent-failure lines are P0",
    monitoringHooks
      .filter((hook) => ["consent_ledger_integrity", "silent_failure_rate"].includes(hook.id))
      .every((hook) => hook.severity === "P0"),
  );

  // --- rollback hooks: explicit authorization flags --------------------------
  const rollbackHooks = manifest.rollbackHooks ?? [];
  const rollbackIds = new Set(rollbackHooks.map((hook) => hook.id));
  for (const id of REQUIRED_ROLLBACK_IDS) {
    check(`rollbackHooks: ${id} present`, rollbackIds.has(id));
  }
  for (const hook of rollbackHooks) {
    check(
      `rollbackHooks: ${hook.id} has action + explicit requiresHumanAuthorization`,
      typeof hook.action === "string" && typeof hook.requiresHumanAuthorization === "boolean",
    );
  }

  // --- irreversible actions all require human authorization ------------------
  const irreversible = manifest.irreversibleActions ?? [];
  check("irreversibleActions: non-empty", irreversible.length > 0);
  for (const action of irreversible) {
    check(
      `irreversibleActions: ${action.id} requiresHumanAuthorization === true`,
      action.requiresHumanAuthorization === true,
    );
  }

  return { results, failures: results.filter((r) => !r.ok).map((r) => r.label) };
}

function main() {
  const { results, failures } = runChecks(loadInputs());
  for (const { label, ok } of results) {
    console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} release-manifest check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll release-manifest checks passed.");
  console.log(
    "NOT validated here (external/Mac-only): signing, archive, TestFlight upload, store submission, live monitoring wiring.",
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
