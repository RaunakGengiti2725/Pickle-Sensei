#!/usr/bin/env node
/**
 * Version-triple audit: every place the shipped iOS version/build/bundle
 * identity is declared must agree.
 *
 * Sources read (all committed, Linux-readable):
 *   - apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj
 *       MARKETING_VERSION / CURRENT_PROJECT_VERSION / PRODUCT_BUNDLE_IDENTIFIER
 *       / TARGETED_DEVICE_FAMILY / IPHONEOS_DEPLOYMENT_TARGET / DEVELOPMENT_TEAM
 *   - apps/mobile/ios/PickleSensei/Info.plist (must source version keys from
 *     build settings, display name)
 *   - apps/mobile/package.json version
 *   - apps/mobile/android/app/build.gradle versionName / versionCode /
 *     applicationId (still asserted by release:check although Android does
 *     not ship)
 *   - infra/release/release-manifest.json versionScheme
 *   - apps/mobile/src/config/runtimeConfig.ts APP_VERSION / APP_STORE_ID /
 *     API_BASE_URL
 *   - apps/mobile/ios/fastlane/Appfile app_identifier / team_id
 *   - docs/APP_STORE_SUBMISSION.md §1 identity facts (bundle id, team,
 *     marketing version, Apple ID)
 *   - optional: a Mac-run PickleSensei-Info.plist (--mac-plist <path>) — the
 *     built app's CFBundleShortVersionString / CFBundleVersion / identifier
 *
 * Exit 0 when every comparison agrees, 1 otherwise. Never edits anything.
 *
 * Usage: node tools/release/xc-readiness/version-triple.mjs [--json out.json] [--mac-plist path]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const jsonOut = argValue("--json");
const macPlistPath = argValue("--mac-plist");

const read = (rel) => readFileSync(join(repoRoot, rel), "utf8");
const uniq = (arr) => [...new Set(arr)];
const allMatches = (text, re) => uniq([...text.matchAll(re)].map((m) => m[1]));

// --- pbxproj -----------------------------------------------------------------
const pbx = read("apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj");
const pbxproj = {
  marketingVersion: allMatches(pbx, /MARKETING_VERSION = ([^;]+);/g),
  currentProjectVersion: allMatches(pbx, /CURRENT_PROJECT_VERSION = ([^;]+);/g),
  bundleId: allMatches(pbx, /PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g),
  deviceFamily: allMatches(pbx, /TARGETED_DEVICE_FAMILY = ([^;]+);/g),
  deploymentTarget: allMatches(pbx, /IPHONEOS_DEPLOYMENT_TARGET = ([^;]+);/g),
  team: allMatches(pbx, /DEVELOPMENT_TEAM = ([^;]+);/g),
};

// --- Info.plist --------------------------------------------------------------
const plist = read("apps/mobile/ios/PickleSensei/Info.plist");
const plistValue = (key) =>
  new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist)?.[1] ?? null;
const infoPlist = {
  shortVersion: plistValue("CFBundleShortVersionString"),
  bundleVersion: plistValue("CFBundleVersion"),
  identifier: plistValue("CFBundleIdentifier"),
  displayName: plistValue("CFBundleDisplayName"),
};

// --- package.json / gradle / manifest / runtimeConfig / Appfile ------------
const pkg = JSON.parse(read("apps/mobile/package.json"));
const gradleText = read("apps/mobile/android/app/build.gradle");
const gradle = {
  versionName: /versionName "([^"]+)"/.exec(gradleText)?.[1] ?? null,
  versionCode: /versionCode (\d+)/.exec(gradleText)?.[1] ?? null,
  applicationId: /applicationId "([^"]+)"/.exec(gradleText)?.[1] ?? null,
};
const manifest = JSON.parse(read("infra/release/release-manifest.json"));
const rc = read("apps/mobile/src/config/runtimeConfig.ts");
const runtimeConfig = {
  appVersion: /const APP_VERSION = '([^']+)';/.exec(rc)?.[1] ?? null,
  appStoreId: /const APP_STORE_ID: string \| null = '([^']+)';/.exec(rc)?.[1] ?? null,
  apiBaseUrl: /const API_BASE_URL: string \| null =\s*'([^']+)';/.exec(rc)?.[1] ?? null,
  iosRevenueCatKeyPrefix:
    /const REVENUECAT_IOS_PUBLIC_SDK_KEY: string \| null =\s*'([^_']+)_/.exec(rc)?.[1] ?? null,
};
const appfileText = read("apps/mobile/ios/fastlane/Appfile");
const appfile = {
  appIdentifier: /app_identifier\("([^"]+)"\)/.exec(appfileText)?.[1] ?? null,
  teamId: /team_id\("([^"]+)"\)/.exec(appfileText)?.[1] ?? null,
};

// --- dossier §1 identity facts ---------------------------------------------
const dossierText = read("docs/APP_STORE_SUBMISSION.md");
const dossierRow = (label) => {
  const re = new RegExp(`^\\|\\s*${label}\\s*\\|\\s*(.*?)\\s*\\|`, "m");
  return re.exec(dossierText)?.[1] ?? null;
};
const dossier = {
  bundleId: /`([^`]+)`/.exec(dossierRow("Bundle ID") ?? "")?.[1] ?? null,
  team: /`([^`]+)`/.exec(dossierRow("Apple Developer team") ?? "")?.[1] ?? null,
  marketingVersion: dossierRow("Marketing version"),
  appleId: /Apple ID `(\d+)`/.exec(dossierText)?.[1] ?? null,
  minimumIos: dossierRow("Minimum iOS"),
  buildNumberNote: dossierRow("Build number"),
  validatedBuild: /Build (\d+) was validated/.exec(dossierRow("Build number") ?? "")?.[1] ?? null,
};

// --- optional Mac evidence ---------------------------------------------------
let macPlist = null;
if (macPlistPath && existsSync(macPlistPath)) {
  try {
    const out = execFileSync(
      "python3",
      [
        "-c",
        'import plistlib,sys,json;d=plistlib.load(open(sys.argv[1],"rb"));print(json.dumps({k:d.get(k) for k in ["CFBundleShortVersionString","CFBundleVersion","CFBundleIdentifier","CFBundleDisplayName","MinimumOSVersion","UIDeviceFamily"]}))',
        macPlistPath,
      ],
      { encoding: "utf8" },
    );
    macPlist = JSON.parse(out);
  } catch (err) {
    macPlist = { error: String(err) };
  }
}

// --- comparisons -------------------------------------------------------------
const checks = [];
const check = (id, ok, detail, level = "HARD") => checks.push({ id, ok, level, detail });

const mv = manifest.versionScheme.marketingVersion;
const bn = manifest.versionScheme.buildNumber;

check(
  "pbxproj.marketingVersion.single",
  pbxproj.marketingVersion.length === 1,
  pbxproj.marketingVersion,
);
check(
  "pbxproj.currentProjectVersion.single",
  pbxproj.currentProjectVersion.length === 1,
  pbxproj.currentProjectVersion,
);
check("pbxproj.bundleId.single", pbxproj.bundleId.length === 1, pbxproj.bundleId);
check(
  "pbxproj.marketingVersion == manifest",
  pbxproj.marketingVersion[0] === mv,
  `${pbxproj.marketingVersion[0]} vs ${mv}`,
);
check(
  "pbxproj.currentProjectVersion == manifest.buildNumber",
  Number(pbxproj.currentProjectVersion[0]) === bn,
  `${pbxproj.currentProjectVersion[0]} vs ${bn}`,
);
check(
  "runtimeConfig.APP_VERSION == manifest",
  runtimeConfig.appVersion === mv,
  `${runtimeConfig.appVersion} vs ${mv}`,
);
check(
  "gradle.versionName == manifest",
  gradle.versionName === mv,
  `${gradle.versionName} vs ${mv}`,
);
check(
  "gradle.versionCode == manifest.buildNumber",
  Number(gradle.versionCode) === bn,
  `${gradle.versionCode} vs ${bn}`,
);
check(
  "Info.plist sources CFBundleShortVersionString from $(MARKETING_VERSION)",
  infoPlist.shortVersion === "$(MARKETING_VERSION)",
  infoPlist.shortVersion,
);
check(
  "Info.plist sources CFBundleVersion from $(CURRENT_PROJECT_VERSION)",
  infoPlist.bundleVersion === "$(CURRENT_PROJECT_VERSION)",
  infoPlist.bundleVersion,
);
check(
  "Info.plist sources CFBundleIdentifier from $(PRODUCT_BUNDLE_IDENTIFIER)",
  infoPlist.identifier === "$(PRODUCT_BUNDLE_IDENTIFIER)",
  infoPlist.identifier,
);
check(
  'Info.plist displayName == "Pickle Sensei"',
  infoPlist.displayName === "Pickle Sensei",
  infoPlist.displayName,
);
check(
  "bundleId agrees: pbxproj/Appfile/gradle/dossier",
  uniq([pbxproj.bundleId[0], appfile.appIdentifier, gradle.applicationId, dossier.bundleId])
    .length === 1,
  [pbxproj.bundleId[0], appfile.appIdentifier, gradle.applicationId, dossier.bundleId],
);
check(
  "team agrees: pbxproj/Appfile/dossier",
  uniq([...pbxproj.team, appfile.teamId, dossier.team]).length === 1,
  [...pbxproj.team, appfile.teamId, dossier.team],
);
check(
  "dossier marketing version == manifest",
  dossier.marketingVersion === mv,
  `${dossier.marketingVersion} vs ${mv}`,
);
check(
  "dossier minimum iOS == pbxproj deployment target",
  pbxproj.deploymentTarget.length === 1 && dossier.minimumIos === pbxproj.deploymentTarget[0],
  [dossier.minimumIos, pbxproj.deploymentTarget],
);
check(
  "runtimeConfig.APP_STORE_ID == dossier Apple ID",
  runtimeConfig.appStoreId !== null && runtimeConfig.appStoreId === dossier.appleId,
  `${runtimeConfig.appStoreId} vs ${dossier.appleId}`,
);
check(
  "pbxproj iPhone-only",
  pbxproj.deviceFamily.length === 1 && pbxproj.deviceFamily[0] === "1",
  pbxproj.deviceFamily,
);
check(
  "runtimeConfig iOS RevenueCat key is production (appl_)",
  runtimeConfig.iosRevenueCatKeyPrefix === "appl",
  runtimeConfig.iosRevenueCatKeyPrefix,
);

// SOFT: agree-in-spirit checks the existing release:check does not cover.
check(
  "apps/mobile/package.json version == manifest marketingVersion",
  pkg.version === mv,
  `${pkg.version} vs ${mv}`,
  "SOFT",
);
check(
  "manifest.buildNumber >= last validated App Store build (dossier)",
  dossier.validatedBuild === null || bn >= Number(dossier.validatedBuild),
  `manifest ${bn} vs dossier validated build ${dossier.validatedBuild}`,
  "SOFT",
);
check(
  "manifest.environments.production.apiOrigin describes the committed runtimeConfig API origin",
  manifest.environments.production.apiOrigin !== "tbd" || runtimeConfig.apiBaseUrl === null,
  `manifest production.apiOrigin=${manifest.environments.production.apiOrigin}; runtimeConfig API_BASE_URL=${runtimeConfig.apiBaseUrl}`,
  "SOFT",
);
check(
  'manifest.environments.development.mobileConfig ("all null") matches runtimeConfig defaults',
  !/all null/.test(manifest.environments.development.mobileConfig) ||
    runtimeConfig.apiBaseUrl === null,
  `manifest says "${manifest.environments.development.mobileConfig}"; runtimeConfig API_BASE_URL=${runtimeConfig.apiBaseUrl}`,
  "SOFT",
);

let gitTags = [];
try {
  gitTags = execFileSync("git", ["tag", "-l"], { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
} catch {
  /* ignore */
}
check(
  "gitTag rule: a v<version>-build.<build> tag exists for the validated build",
  dossier.validatedBuild === null ||
    gitTags.some(
      (t) =>
        t === `v${mv}-build.${dossier.validatedBuild}` ||
        t === `v${mv}.0-build.${dossier.validatedBuild}`,
    ),
  `tags=${JSON.stringify(gitTags)}; expected v${mv}-build.${dossier.validatedBuild}`,
  "SOFT",
);

if (macPlist && !macPlist.error) {
  check(
    "mac plist CFBundleShortVersionString == manifest",
    macPlist.CFBundleShortVersionString === mv,
    `${macPlist.CFBundleShortVersionString} vs ${mv}`,
  );
  check(
    "mac plist CFBundleVersion == manifest.buildNumber",
    Number(macPlist.CFBundleVersion) === bn,
    `${macPlist.CFBundleVersion} vs ${bn}`,
  );
  check(
    "mac plist CFBundleIdentifier == pbxproj",
    macPlist.CFBundleIdentifier === pbxproj.bundleId[0],
    macPlist.CFBundleIdentifier,
  );
  check(
    "mac plist MinimumOSVersion == pbxproj deployment target",
    macPlist.MinimumOSVersion === pbxproj.deploymentTarget[0],
    macPlist.MinimumOSVersion,
  );
}

let gitSha = "unknown";
try {
  gitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
} catch {
  /* ignore */
}

const report = {
  tool: "xc-readiness/version-triple",
  gitSha,
  generatedAt: new Date().toISOString(),
  sources: {
    pbxproj,
    infoPlist,
    packageJson: { version: pkg.version },
    gradle,
    manifestVersionScheme: manifest.versionScheme,
    manifestEnvironments: manifest.environments,
    runtimeConfig,
    appfile,
    dossier,
    gitTags,
    macPlist: macPlist ?? "not provided",
  },
  checks,
  hardFailures: checks.filter((c) => c.level === "HARD" && !c.ok).length,
  softFailures: checks.filter((c) => c.level === "SOFT" && !c.ok).length,
};
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2));

for (const c of checks)
  console.log(`${c.ok ? "ok  " : "FAIL"} [${c.level}] ${c.id}  — ${JSON.stringify(c.detail)}`);
console.log(
  `\nversion-triple: ${report.hardFailures} hard failure(s), ${report.softFailures} soft disagreement(s)`,
);
process.exit(report.hardFailures > 0 ? 1 : 0);
