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
 *                                               CURRENT_PROJECT_VERSION /
 *                                               PRODUCT_BUNDLE_IDENTIFIER /
 *                                               PRODUCT_NAME / INFOPLIST_FILE
 *                                               present in EVERY configuration
 *                                               of the application target
 *   <INFOPLIST_FILE>                            CFBundleShortVersionString and
 *                                               CFBundleVersion sourced from
 *                                               those build settings (never
 *                                               hardcoded), in the plist the
 *                                               pbxproj really points at
 *   app.json                                    `name` is the module the
 *                                               native app starts, `displayName`
 *                                               is the Info.plist display name
 *   ios/PickleSensei/AppDelegate.swift          withModuleName: "<app.json name>"
 *   src/config/runtimeConfig.ts                 APP_VERSION = marketingVersion
 *
 * Build numbers are compared exactly: the manifest build must be a positive
 * integer JSON can represent exactly (<= Number.MAX_SAFE_INTEGER), every other
 * build number stays a decimal string / BigInt, so two distinct builds can
 * never round to the same double.
 *
 * Nothing here chooses, bumps or writes a version or build number: when the
 * committed identity cannot ship (already uploaded, drifted), the owner
 * commits a new identity and re-runs every gate against it.
 *
 * Usage (from apps/mobile):
 *   node scripts/release-identity.mjs --check                 human-readable summary
 *   node scripts/release-identity.mjs --check --json          identity JSON on stdout
 *   --require-committed        refuse unless HEAD is readable and every
 *                              identity file is tracked and byte-identical to
 *                              its HEAD blob (a quiet `git status` — skip-
 *                              worktree, assume-unchanged, ignored files — is
 *                              not proof)
 *   --assert-version <v>       refuse unless <v> equals the manifest version
 *   --assert-build <n>         refuse unless <n> equals the manifest build —
 *                              fastlane passes the archive's
 *                              CFBundleShortVersionString / CFBundleVersion
 *   --assert-git-sha <sha>     refuse unless HEAD is exactly <sha> (fastlane
 *                              passes the sha captured before the archive)
 *   --latest-uploaded <n>      refuse unless the manifest build is greater
 *                              than <n> (the newest build App Store Connect
 *                              already holds)
 *   --mobile-root <dir>        check a different apps/mobile tree (tests)
 *
 * Every flag may be given once; repeated, unknown or malformed flags refuse.
 * Exit 0 = the identity is coherent and every assertion held.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FLAGS_WITH_VALUE = new Set([
  '--assert-version',
  '--assert-build',
  '--assert-git-sha',
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
const UPLOADED_BUILD_PATTERN = /^\d+$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const APPLICATION_PRODUCT_TYPE = 'com.apple.product-type.application';

class RefusalError extends Error {}

function parseArgs(argv) {
  const options = {
    check: false,
    json: false,
    requireCommitted: false,
    assertVersion: null,
    assertBuild: null,
    assertGitSha: null,
    latestUploaded: null,
    mobileRoot: null,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!FLAGS_WITHOUT_VALUE.has(flag) && !FLAGS_WITH_VALUE.has(flag)) {
      throw new RefusalError(`unknown argument ${flag}`);
    }
    if (seen.has(flag)) {
      throw new RefusalError(
        `${flag} given more than once; every flag may be given once`,
      );
    }
    seen.add(flag);
    if (FLAGS_WITHOUT_VALUE.has(flag)) {
      if (flag === '--check') options.check = true;
      if (flag === '--json') options.json = true;
      if (flag === '--require-committed') options.requireCommitted = true;
      continue;
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
      options.assertBuild = value;
    } else if (flag === '--assert-git-sha') {
      if (!GIT_SHA_PATTERN.test(value)) {
        throw new RefusalError(
          `--assert-git-sha ${JSON.stringify(value)} is not a 40-hex commit sha`,
        );
      }
      options.assertGitSha = value;
    } else if (flag === '--latest-uploaded') {
      if (!UPLOADED_BUILD_PATTERN.test(value)) {
        throw new RefusalError(
          `--latest-uploaded ${JSON.stringify(value)} is not a non-negative integer build number`,
        );
      }
      options.latestUploaded = value;
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
    projectDir: join(mobileRoot, 'ios'),
    pbxproj: join(
      mobileRoot,
      'ios',
      'PickleSensei.xcodeproj',
      'project.pbxproj',
    ),
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

/** The body of the pbxproj object `id` (its lines between `= {` and `};`). */
function pbxObject(pbxproj, id) {
  const match = pbxproj.match(
    new RegExp(
      `^\\t\\t${id}(?: /\\* [^*]* \\*/)? = \\{\\n((?:\\t\\t\\t.*\\n)*?)\\t\\t\\};`,
      'm',
    ),
  );
  return match ? match[1] : null;
}

/** `SETTING = value;` inside one XCBuildConfiguration body, or null. */
function buildSetting(body, setting) {
  const match = body.match(
    new RegExp(`^\\t\\t\\t\\t${setting} = ("?)([^;"]+)\\1;$`, 'm'),
  );
  return match ? match[2].trim() : null;
}

/**
 * The build configurations of the ONE application target: `[{name, body}]`.
 * Refuses when the project has no (or several) application targets, or when a
 * configuration list / configuration object cannot be found.
 */
function applicationConfigurations(pbxproj, pbxPath) {
  const targets = [];
  for (const match of pbxproj.matchAll(
    /^\t\t([0-9A-F]{24}) \/\* ([^*]*) \*\/ = \{\n\t\t\tisa = PBXNativeTarget;\n((?:\t\t\t.*\n)*?)\t\t\};/gm,
  )) {
    const body = match[3];
    const productType = body.match(/^\t\t\tproductType = "([^"]+)";$/m);
    if (productType && productType[1] === APPLICATION_PRODUCT_TYPE) {
      const list = body.match(
        /^\t\t\tbuildConfigurationList = ([0-9A-F]{24})/m,
      );
      targets.push({ name: match[2].trim(), listId: list ? list[1] : null });
    }
  }
  if (targets.length !== 1) {
    throw new RefusalError(
      `${pbxPath}: expected exactly one application target, found ${targets.length}`,
    );
  }
  const [target] = targets;
  const list = target.listId ? pbxObject(pbxproj, target.listId) : null;
  if (list === null) {
    throw new RefusalError(
      `${pbxPath}: application target ${JSON.stringify(target.name)} has no readable build configuration list`,
    );
  }
  const configurations = [];
  for (const match of list.matchAll(
    /^\t\t\t\t([0-9A-F]{24}) \/\* ([^*]*) \*\/,$/gm,
  )) {
    const body = pbxObject(pbxproj, match[1]);
    if (body === null || !/^\t\t\tisa = XCBuildConfiguration;$/m.test(body)) {
      throw new RefusalError(
        `${pbxPath}: build configuration ${match[2].trim()} (${match[1]}) of the application target is not readable`,
      );
    }
    configurations.push({ name: match[2].trim(), body });
  }
  if (configurations.length === 0) {
    throw new RefusalError(
      `${pbxPath}: application target ${JSON.stringify(target.name)} has no build configurations`,
    );
  }
  return { target: target.name, configurations };
}

/** The `<string>` that follows `<key>name</key>` in a plist, or null. */
function plistString(plist, key) {
  const match = plist.match(
    new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`),
  );
  return match ? match[1] : null;
}

/**
 * Collects `setting` from every configuration; reports configurations that
 * lack it and values that differ from `expected`. Returns the distinct values.
 */
function expectSetting(problems, configurations, setting, expected, pbxPath) {
  const values = new Map();
  const missing = [];
  for (const { name, body } of configurations) {
    const value = buildSetting(body, setting);
    if (value === null) {
      missing.push(name);
    } else {
      values.set(value, [...(values.get(value) ?? []), name]);
    }
  }
  if (missing.length > 0) {
    problems.push(
      `${pbxPath}: ${setting} is not set in configuration(s) ${missing.join(', ')} of the application target`,
    );
  }
  if (expected !== null) {
    for (const [value, names] of values) {
      if (value !== expected) {
        problems.push(
          `${pbxPath}: ${setting} = ${value} in configuration(s) ${names.join(', ')}; the verified manifest says ${expected}`,
        );
      }
    }
  }
  return [...values.keys()];
}

/**
 * Runs git against the repository that holds `repoRoot`. Every failure — git
 * missing, not a repository, no HEAD, path not tracked — surfaces as `null`
 * so the caller fails closed.
 */
function gitRunner(repoRoot) {
  return args => {
    const result = spawnSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    if (result.error || result.status !== 0) {
      return null;
    }
    return result.stdout.trim();
  };
}

/**
 * The identity is committed iff HEAD is readable and every identity file is
 * tracked AND its working-tree blob is exactly the blob HEAD commits for it.
 * `git status` alone is not consulted for the verdict: skip-worktree and
 * assume-unchanged bits silence it, and ignored files never appear in it.
 */
function gitState(repoRoot, files) {
  const git = gitRunner(repoRoot);
  const head = git(['rev-parse', '--verify', 'HEAD']);
  const gitSha = head !== null && GIT_SHA_PATTERN.test(head) ? head : null;
  if (gitSha === null) {
    return {
      gitSha: null,
      committed: false,
      uncommitted: [
        'no git HEAD is readable for this tree (git not runnable, not a repository, or no commit yet)',
      ],
    };
  }
  const uncommitted = [];
  for (const file of files) {
    const tracked = git([
      'ls-files',
      '--full-name',
      '--error-unmatch',
      '--',
      file,
    ]);
    if (tracked === null || tracked === '') {
      uncommitted.push(`${file}: not tracked by git (no commit holds it)`);
      continue;
    }
    const headBlob = git([
      'rev-parse',
      '--verify',
      '--quiet',
      `HEAD:${tracked}`,
    ]);
    const workBlob = git(['hash-object', '--', file]);
    if (headBlob === null) {
      uncommitted.push(`${file}: not present in HEAD ${gitSha}`);
    } else if (workBlob === null || workBlob !== headBlob) {
      uncommitted.push(
        `${file}: working tree content differs from HEAD:${tracked} (${gitSha})`,
      );
    }
  }
  return { gitSha, committed: uncommitted.length === 0, uncommitted };
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
  if (!Number.isSafeInteger(buildNumber) || buildNumber <= 0) {
    problems.push(
      `${paths.manifest}: versionScheme.buildNumber must be a positive integer no greater than ${Number.MAX_SAFE_INTEGER} (it ships as CFBundleVersion and is compared exactly), got ${JSON.stringify(buildNumber)}`,
    );
  }
  if (problems.length > 0) {
    throw new RefusalError(problems.join('\n'));
  }
  const buildNumberText = String(buildNumber);

  const pbxproj = readRequired(paths.pbxproj);
  const { configurations } = applicationConfigurations(pbxproj, paths.pbxproj);
  expectSetting(
    problems,
    configurations,
    'MARKETING_VERSION',
    marketingVersion,
    paths.pbxproj,
  );
  expectSetting(
    problems,
    configurations,
    'CURRENT_PROJECT_VERSION',
    buildNumberText,
    paths.pbxproj,
  );
  const bundleIdentifiers = expectSetting(
    problems,
    configurations,
    'PRODUCT_BUNDLE_IDENTIFIER',
    null,
    paths.pbxproj,
  );
  if (bundleIdentifiers.length !== 1) {
    problems.push(
      `${paths.pbxproj}: expected one PRODUCT_BUNDLE_IDENTIFIER across configurations, found ${JSON.stringify(bundleIdentifiers)}`,
    );
  }
  const productNames = expectSetting(
    problems,
    configurations,
    'PRODUCT_NAME',
    null,
    paths.pbxproj,
  );
  const plistFiles = expectSetting(
    problems,
    configurations,
    'INFOPLIST_FILE',
    null,
    paths.pbxproj,
  ).map(file => resolve(paths.projectDir, file));

  const displayNames = new Set();
  for (const plistPath of plistFiles) {
    const infoPlist = readRequired(plistPath);
    const shortVersion = plistString(infoPlist, 'CFBundleShortVersionString');
    if (shortVersion !== '$(MARKETING_VERSION)') {
      problems.push(
        `${plistPath}: CFBundleShortVersionString must be $(MARKETING_VERSION) so the committed build setting ships, got ${JSON.stringify(shortVersion)}`,
      );
    }
    const bundleVersion = plistString(infoPlist, 'CFBundleVersion');
    if (bundleVersion !== '$(CURRENT_PROJECT_VERSION)') {
      problems.push(
        `${plistPath}: CFBundleVersion must be $(CURRENT_PROJECT_VERSION) so the committed build setting ships, got ${JSON.stringify(bundleVersion)}`,
      );
    }
    const displayName = plistString(infoPlist, 'CFBundleDisplayName');
    if (!displayName) {
      problems.push(`${plistPath}: CFBundleDisplayName missing`);
    } else {
      displayNames.add(displayName);
    }
  }
  if (displayNames.size > 1) {
    problems.push(
      `${paths.pbxproj}: the configurations' Info.plist files disagree on CFBundleDisplayName: ${JSON.stringify([...displayNames])}`,
    );
  }
  const [displayName = null] = displayNames;

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
  if (
    typeof moduleName === 'string' &&
    (productNames.length !== 1 || productNames[0] !== moduleName)
  ) {
    problems.push(
      `${paths.appJson}: name ${JSON.stringify(moduleName)} does not match PRODUCT_NAME ${JSON.stringify(productNames)} in ${paths.pbxproj}`,
    );
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
    ...plistFiles,
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
    configurations: configurations.map(({ name }) => name),
    ...gitState(resolve(mobileRoot, '..', '..'), identityFiles),
    identityFiles,
  };
}

function enforce(identity, options) {
  const refusals = [];
  const buildNumberText = String(identity.buildNumber);
  if (options.requireCommitted && !identity.committed) {
    refusals.push(
      `the release identity is uncommitted — it cannot be proven to be the identity HEAD commits; commit it before building:\n  ${identity.uncommitted.join('\n  ')}`,
    );
  }
  if (
    options.assertGitSha !== null &&
    identity.gitSha !== options.assertGitSha
  ) {
    refusals.push(
      identity.gitSha === null
        ? `HEAD is not readable for this tree, so it cannot be the captured commit ${options.assertGitSha}`
        : `HEAD ${identity.gitSha} is not the commit ${options.assertGitSha} whose identity was verified before the archive`,
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
  if (options.assertBuild !== null && options.assertBuild !== buildNumberText) {
    refusals.push(
      `archive CFBundleVersion ${options.assertBuild} differs from the verified manifest buildNumber ${buildNumberText}`,
    );
  }
  if (
    options.latestUploaded !== null &&
    BigInt(buildNumberText) <= BigInt(options.latestUploaded)
  ) {
    refusals.push(
      `committed build ${buildNumberText} is not greater than ${options.latestUploaded}, the newest build App Store Connect already holds; the owner must commit a coherent build identity greater than ${options.latestUploaded} (manifest, project.pbxproj and every other identity file) and re-run the gates — nothing here picks it`,
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
    `  module ${identity.moduleName}, display name ${JSON.stringify(identity.displayName)}, configurations ${identity.configurations.join(', ')}`,
    `  git ${identity.gitSha ?? 'unknown'} — identity files ${identity.committed ? 'committed (identical to HEAD)' : 'NOT committed'}`,
  ];
  if (options.assertVersion !== null || options.assertBuild !== null) {
    lines.push('  archive identity matches the verified manifest');
  }
  if (options.assertGitSha !== null) {
    lines.push('  HEAD is the commit verified before the archive');
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
