#!/usr/bin/env node
/**
 * Immutable release identity (W11-08).
 *
 * The release candidate's version/build identity is COMMITTED before any
 * verification runs and is the identity that ships. The verified manifest is
 * `infra/release/release-manifest.json` (`versionScheme.marketingVersion` /
 * `versionScheme.buildNumber`, the file `pnpm release:check` validates); this
 * script proves that every file the shipped binary derives its identity from
 * agrees with it, and refuses (exit 1, nothing on stdout) when any of them
 * drifts:
 *
 *   ios/PickleSensei.xcodeproj/project.pbxproj  MARKETING_VERSION /
 *                                               CURRENT_PROJECT_VERSION in
 *                                               EVERY configuration
 *   ios/PickleSensei/Info.plist                 CFBundleShortVersionString and
 *                                               CFBundleVersion sourced from
 *                                               those build settings (never
 *                                               hardcoded)
 *   app.json                                    `name` is the module the
 *                                               native app starts, `displayName`
 *                                               is the Info.plist display name
 *   ios/PickleSensei/AppDelegate.swift          withModuleName: "<app.json name>"
 *   src/config/runtimeConfig.ts                 APP_VERSION = marketingVersion
 *
 * Nothing here chooses, bumps or writes a version or build number: when the
 * committed identity cannot ship (already uploaded, drifted), the owner
 * commits a new identity and re-runs every gate against it.
 *
 * Usage (from apps/mobile):
 *   node scripts/release-identity.mjs --check                 human-readable summary
 *   node scripts/release-identity.mjs --check --json          identity JSON on stdout
 *   --require-committed        refuse unless every identity file is committed
 *                              (clean in `git status`) and HEAD is known
 *   --assert-version <v>       refuse unless <v> equals the manifest version
 *   --assert-build <n>         refuse unless <n> equals the manifest build —
 *                              fastlane passes the archive's
 *                              CFBundleShortVersionString / CFBundleVersion
 *   --latest-uploaded <n>      refuse unless the manifest build is greater
 *                              than <n> (the newest build App Store Connect
 *                              already holds)
 *   --mobile-root <dir>        check a different apps/mobile tree (tests)
 *
 * Exit 0 = the identity is coherent and every assertion held.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FLAGS_WITH_VALUE = new Set([
  '--assert-version',
  '--assert-build',
  '--latest-uploaded',
  '--mobile-root',
]);
const FLAGS_WITHOUT_VALUE = new Set([
  '--check',
  '--json',
  '--require-committed',
]);

const MARKETING_VERSION_PATTERN = /^\d+\.\d+(\.\d+)?$/;
const BUILD_NUMBER_PATTERN = /^[1-9]\d*$/;

class RefusalError extends Error {}

function parseArgs(argv) {
  const options = {
    check: false,
    json: false,
    requireCommitted: false,
    assertVersion: null,
    assertBuild: null,
    latestUploaded: null,
    mobileRoot: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (FLAGS_WITHOUT_VALUE.has(flag)) {
      if (flag === '--check') options.check = true;
      if (flag === '--json') options.json = true;
      if (flag === '--require-committed') options.requireCommitted = true;
      continue;
    }
    if (!FLAGS_WITH_VALUE.has(flag)) {
      throw new RefusalError(`unknown argument ${flag}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new RefusalError(`${flag} requires a value`);
    }
    index += 1;
    if (flag === '--assert-version') {
      if (!MARKETING_VERSION_PATTERN.test(value)) {
        throw new RefusalError(
          `--assert-version ${JSON.stringify(value)} is not a MAJOR.MINOR[.PATCH] version`,
        );
      }
      options.assertVersion = value;
    } else if (flag === '--assert-build') {
      if (!BUILD_NUMBER_PATTERN.test(value)) {
        throw new RefusalError(
          `--assert-build ${JSON.stringify(value)} is not a positive integer build number`,
        );
      }
      options.assertBuild = Number(value);
    } else if (flag === '--latest-uploaded') {
      if (!/^\d+$/.test(value)) {
        throw new RefusalError(
          `--latest-uploaded ${JSON.stringify(value)} is not a non-negative integer build number`,
        );
      }
      options.latestUploaded = Number(value);
    } else {
      options.mobileRoot = resolve(value);
    }
  }
  return options;
}

function identityPaths(mobileRoot) {
  return {
    manifest: resolve(
      mobileRoot,
      '..',
      '..',
      'infra',
      'release',
      'release-manifest.json',
    ),
    pbxproj: join(
      mobileRoot,
      'ios',
      'PickleSensei.xcodeproj',
      'project.pbxproj',
    ),
    infoPlist: join(mobileRoot, 'ios', 'PickleSensei', 'Info.plist'),
    appDelegate: join(mobileRoot, 'ios', 'PickleSensei', 'AppDelegate.swift'),
    appJson: join(mobileRoot, 'app.json'),
    runtimeConfig: join(mobileRoot, 'src', 'config', 'runtimeConfig.ts'),
  };
}

function readRequired(path) {
  if (!existsSync(path)) {
    throw new RefusalError(`identity file missing: ${path}`);
  }
  return readFileSync(path, 'utf8');
}

function parseJsonFile(path) {
  try {
    return JSON.parse(readRequired(path));
  } catch (error) {
    if (error instanceof RefusalError) throw error;
    throw new RefusalError(`${path} is not valid JSON: ${error.message}`);
  }
}

/** Every `<SETTING> = <value>;` occurrence in the pbxproj, in file order. */
function buildSettingValues(pbxproj, setting) {
  const pattern = new RegExp(`^\\s*${setting} = ("?)([^;"]+)\\1;`, 'gm');
  return Array.from(pbxproj.matchAll(pattern), match => match[2].trim());
}

/** The `<string>` that follows `<key>name</key>` in a plist, or null. */
function plistString(plist, key) {
  const match = plist.match(
    new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`),
  );
  return match ? match[1] : null;
}

function expectAll(problems, label, values, expected, path) {
  if (values.length === 0) {
    problems.push(`${path}: no ${label} build setting found`);
    return;
  }
  const drifted = values.filter(value => value !== expected);
  if (drifted.length > 0) {
    problems.push(
      `${path}: ${label} = ${[...new Set(drifted)].join(', ')} in ${drifted.length} of ${values.length} configuration(s); the verified manifest says ${expected}`,
    );
  }
}

function gitState(repoRoot, files) {
  const run = args => {
    const result = spawnSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const gitSha = run(['rev-parse', 'HEAD']);
  const status =
    gitSha === null ? null : run(['status', '--porcelain', '--', ...files]);
  return {
    gitSha: gitSha && /^[0-9a-f]{40}$/.test(gitSha) ? gitSha : null,
    committed: gitSha !== null && status !== null && status === '',
    uncommitted:
      status === null ? [] : status.split('\n').filter(line => line !== ''),
  };
}

function resolveIdentity(mobileRoot) {
  const paths = identityPaths(mobileRoot);
  const problems = [];

  const manifest = parseJsonFile(paths.manifest);
  const scheme =
    manifest && typeof manifest === 'object'
      ? manifest.versionScheme
      : undefined;
  const marketingVersion =
    scheme && typeof scheme === 'object' ? scheme.marketingVersion : undefined;
  const buildNumber =
    scheme && typeof scheme === 'object' ? scheme.buildNumber : undefined;
  if (
    typeof marketingVersion !== 'string' ||
    !MARKETING_VERSION_PATTERN.test(marketingVersion)
  ) {
    problems.push(
      `${paths.manifest}: versionScheme.marketingVersion must be a MAJOR.MINOR[.PATCH] string, got ${JSON.stringify(marketingVersion)}`,
    );
  }
  if (!Number.isInteger(buildNumber) || buildNumber <= 0) {
    problems.push(
      `${paths.manifest}: versionScheme.buildNumber must be a positive integer, got ${JSON.stringify(buildNumber)}`,
    );
  }
  if (problems.length > 0) {
    throw new RefusalError(problems.join('\n'));
  }

  const pbxproj = readRequired(paths.pbxproj);
  expectAll(
    problems,
    'MARKETING_VERSION',
    buildSettingValues(pbxproj, 'MARKETING_VERSION'),
    marketingVersion,
    paths.pbxproj,
  );
  expectAll(
    problems,
    'CURRENT_PROJECT_VERSION',
    buildSettingValues(pbxproj, 'CURRENT_PROJECT_VERSION'),
    String(buildNumber),
    paths.pbxproj,
  );
  const bundleIdentifiers = [
    ...new Set(buildSettingValues(pbxproj, 'PRODUCT_BUNDLE_IDENTIFIER')),
  ];
  if (bundleIdentifiers.length !== 1) {
    problems.push(
      `${paths.pbxproj}: expected one PRODUCT_BUNDLE_IDENTIFIER across configurations, found ${JSON.stringify(bundleIdentifiers)}`,
    );
  }

  const infoPlist = readRequired(paths.infoPlist);
  const shortVersion = plistString(infoPlist, 'CFBundleShortVersionString');
  if (shortVersion !== '$(MARKETING_VERSION)') {
    problems.push(
      `${paths.infoPlist}: CFBundleShortVersionString must be $(MARKETING_VERSION) so the committed build setting ships, got ${JSON.stringify(shortVersion)}`,
    );
  }
  const bundleVersion = plistString(infoPlist, 'CFBundleVersion');
  if (bundleVersion !== '$(CURRENT_PROJECT_VERSION)') {
    problems.push(
      `${paths.infoPlist}: CFBundleVersion must be $(CURRENT_PROJECT_VERSION) so the committed build setting ships, got ${JSON.stringify(bundleVersion)}`,
    );
  }
  const displayName = plistString(infoPlist, 'CFBundleDisplayName');
  if (!displayName) {
    problems.push(`${paths.infoPlist}: CFBundleDisplayName missing`);
  }

  const appJson = parseJsonFile(paths.appJson);
  const moduleName =
    appJson && typeof appJson === 'object' ? appJson.name : undefined;
  const appDisplayName =
    appJson && typeof appJson === 'object' ? appJson.displayName : undefined;
  if (typeof moduleName !== 'string' || moduleName === '') {
    problems.push(`${paths.appJson}: name must be a non-empty string`);
  }
  const appDelegate = readRequired(paths.appDelegate);
  const startedModule = appDelegate.match(/withModuleName:\s*"([^"]+)"/);
  if (!startedModule) {
    problems.push(`${paths.appDelegate}: withModuleName: "<name>" not found`);
  } else if (startedModule[1] !== moduleName) {
    problems.push(
      `${paths.appJson}: name ${JSON.stringify(moduleName)} is not the module the native app starts (${paths.appDelegate} withModuleName: ${JSON.stringify(startedModule[1])})`,
    );
  }
  if (typeof moduleName === 'string') {
    const productNames = [
      ...new Set(buildSettingValues(pbxproj, 'PRODUCT_NAME')),
    ];
    if (productNames.length !== 1 || productNames[0] !== moduleName) {
      problems.push(
        `${paths.appJson}: name ${JSON.stringify(moduleName)} does not match PRODUCT_NAME ${JSON.stringify(productNames)} in ${paths.pbxproj}`,
      );
    }
  }
  if (displayName && appDisplayName !== undefined) {
    // React Native's app.json displayName is the target's default display
    // name; Info.plist is the committed user-visible name. app.json may spell
    // it without the space (the module name) but must not name a different app.
    const normalize = value => String(value).replace(/\s+/g, '').toLowerCase();
    if (normalize(appDisplayName) !== normalize(displayName)) {
      problems.push(
        `${paths.appJson}: displayName ${JSON.stringify(appDisplayName)} does not name the Info.plist CFBundleDisplayName ${JSON.stringify(displayName)}`,
      );
    }
  }

  const runtimeConfig = readRequired(paths.runtimeConfig);
  const appVersion = runtimeConfig.match(/^const APP_VERSION = '([^']*)';$/m);
  if (!appVersion) {
    problems.push(
      `${paths.runtimeConfig}: const APP_VERSION = '<version>'; not found`,
    );
  } else if (appVersion[1] !== marketingVersion) {
    problems.push(
      `${paths.runtimeConfig}: APP_VERSION = ${JSON.stringify(appVersion[1])}; the verified manifest says ${marketingVersion}`,
    );
  }

  if (problems.length > 0) {
    throw new RefusalError(problems.join('\n'));
  }

  const identityFiles = [
    paths.manifest,
    paths.pbxproj,
    paths.infoPlist,
    paths.appDelegate,
    paths.appJson,
    paths.runtimeConfig,
  ];
  return {
    marketingVersion,
    buildNumber,
    bundleIdentifier: bundleIdentifiers[0],
    moduleName,
    displayName,
    ...gitState(resolve(mobileRoot, '..', '..'), identityFiles),
    identityFiles,
  };
}

function enforce(identity, options) {
  const refusals = [];
  if (options.requireCommitted && !identity.committed) {
    refusals.push(
      identity.gitSha === null
        ? 'the release identity cannot be proven committed: no git HEAD is readable for this tree'
        : `the release identity has uncommitted changes; commit them before building:\n  ${identity.uncommitted.join('\n  ')}`,
    );
  }
  if (
    options.assertVersion !== null &&
    options.assertVersion !== identity.marketingVersion
  ) {
    refusals.push(
      `archive CFBundleShortVersionString ${options.assertVersion} differs from the verified manifest marketingVersion ${identity.marketingVersion}`,
    );
  }
  if (
    options.assertBuild !== null &&
    options.assertBuild !== identity.buildNumber
  ) {
    refusals.push(
      `archive CFBundleVersion ${options.assertBuild} differs from the verified manifest buildNumber ${identity.buildNumber}`,
    );
  }
  if (
    options.latestUploaded !== null &&
    identity.buildNumber <= options.latestUploaded
  ) {
    refusals.push(
      `committed build ${identity.buildNumber} is not greater than ${options.latestUploaded}, the newest build App Store Connect already holds; the owner must commit a coherent build identity greater than ${options.latestUploaded} (manifest, project.pbxproj and every other identity file) and re-run the gates — nothing here picks it`,
    );
  }
  if (refusals.length > 0) {
    throw new RefusalError(refusals.join('\n'));
  }
}

function main(argv) {
  const options = parseArgs(argv);
  const mobileRoot =
    options.mobileRoot ??
    resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const identity = resolveIdentity(mobileRoot);
  enforce(identity, options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(identity)}\n`);
    return;
  }
  const lines = [
    `release identity: ${identity.marketingVersion} (${identity.buildNumber}) ${identity.bundleIdentifier}`,
    `  module ${identity.moduleName}, display name ${JSON.stringify(identity.displayName)}`,
    `  git ${identity.gitSha ?? 'unknown'} — identity files ${identity.committed ? 'committed' : 'NOT committed'}`,
  ];
  if (options.assertVersion !== null || options.assertBuild !== null) {
    lines.push('  archive identity matches the verified manifest');
  }
  if (options.latestUploaded !== null) {
    lines.push(
      `  greater than the newest uploaded build (${options.latestUploaded})`,
    );
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  if (error instanceof RefusalError) {
    process.stderr.write(`release identity refused:\n${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
