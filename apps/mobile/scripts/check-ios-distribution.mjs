#!/usr/bin/env node
/**
 * Linux-validatable iOS distribution preconditions.
 *
 * This checks everything about the TestFlight path that can be verified
 * WITHOUT a Mac: static build/signing configuration, privacy manifest, usage
 * strings, and the fastlane lane files. It cannot — and does not claim to —
 * build, sign, archive, or upload; those steps require Xcode on a Mac
 * (docs/DISTRIBUTION.md).
 *
 * Usage: node scripts/check-ios-distribution.mjs   (exit 0 = all green)
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePbxproj } from './pbxproj.js';

const mobileRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(mobileRoot, '..', '..');
const failures = [];

function check(label, ok) {
  if (!ok) failures.push(label);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
}

function readText(relPath) {
  const abs = join(mobileRoot, relPath);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
}

// --- project.pbxproj: the app target's Debug AND Release configurations ------
// A Release archive is what TestFlight/App Review receive, so every shipping
// setting is asserted per configuration (never "appears somewhere in the
// file", which the Debug block alone satisfies) and against EVERY definition
// Xcode can evaluate for it: the target's own value, `KEY[sdk=iphoneos*]`
// conditionals, and the project-level value the target inherits when it does
// not override the key (or says `$(inherited)`).
const project = parsePbxproj(
  readText('ios/PickleSensei.xcodeproj/project.pbxproj') ?? '',
);
const appTarget = project.appTarget('PickleSensei');
const configurations = project.effectiveSettings(appTarget);
check(
  'pbxproj: app target has exactly the Debug and Release configurations',
  Array.from(configurations.keys()).sort().join(',') === 'Debug,Release',
);

const EMPTY_CONFIGURATION = {
  baseConfigurations: [],
  definitions: () => [],
  values: () => [],
  describe: key => `${key} undefined`,
};
function configuration(name) {
  return configurations.get(name) ?? EMPTY_CONFIGURATION;
}
function perConfiguration(label, predicate) {
  for (const name of ['Debug', 'Release']) {
    check(`pbxproj [${name}]: ${label}`, predicate(configuration(name), name));
  }
}
/** Every definition of `key` (all levels, all conditions) satisfies `test`
 * and at least one exists. */
function pinnedSetting(label, key, test) {
  perConfiguration(label, s => {
    const values = s.values(key);
    const ok = values.length > 0 && values.every(test);
    if (!ok) console.log(`     ${s.describe(key)}`);
    return ok;
  });
}
function agreesAcrossConfigurations(key) {
  const values = new Set(
    Array.from(configurations.values()).flatMap(s => s.values(key)),
  );
  return values.size === 1;
}

pinnedSetting(
  'PRODUCT_BUNDLE_IDENTIFIER = com.picklesensei',
  'PRODUCT_BUNDLE_IDENTIFIER',
  v => v === 'com.picklesensei',
);
pinnedSetting('MARKETING_VERSION set', 'MARKETING_VERSION', v =>
  /^\d+\.\d+(\.\d+)?$/.test(v),
);
check(
  'pbxproj: MARKETING_VERSION identical in Debug and Release',
  agreesAcrossConfigurations('MARKETING_VERSION'),
);
pinnedSetting('CURRENT_PROJECT_VERSION set', 'CURRENT_PROJECT_VERSION', v =>
  /^\d+$/.test(v),
);
check(
  'pbxproj: CURRENT_PROJECT_VERSION identical in Debug and Release',
  agreesAcrossConfigurations('CURRENT_PROJECT_VERSION'),
);
pinnedSetting('DEVELOPMENT_TEAM set', 'DEVELOPMENT_TEAM', v =>
  /^[A-Z0-9]{10}$/.test(v),
);
check(
  'pbxproj: DEVELOPMENT_TEAM identical in Debug and Release',
  agreesAcrossConfigurations('DEVELOPMENT_TEAM'),
);
pinnedSetting(
  'iPhone-only (TARGETED_DEVICE_FAMILY = 1; v1 launch decision)',
  'TARGETED_DEVICE_FAMILY',
  v => v === '1',
);
pinnedSetting(
  'IPHONEOS_DEPLOYMENT_TARGET = 15.1 (dossier: iOS 15.1+)',
  'IPHONEOS_DEPLOYMENT_TARGET',
  v => v === '15.1',
);
pinnedSetting(
  'entitlements wired (CODE_SIGN_ENTITLEMENTS = PickleSensei/PickleSensei.entitlements)',
  'CODE_SIGN_ENTITLEMENTS',
  v => v === 'PickleSensei/PickleSensei.entitlements',
);
pinnedSetting(
  'INFOPLIST_FILE = PickleSensei/Info.plist',
  'INFOPLIST_FILE',
  v => v === 'PickleSensei/Info.plist',
);
// The only xcconfig layer Xcode may add on top is the CocoaPods-generated
// one for this target (not committed; generated from the Podfile). Any other
// base configuration is a place settings could hide from this gate.
perConfiguration(
  'base xcconfig is only the CocoaPods one for this target (project level: none)',
  (s, name) =>
    s.baseConfigurations.every(
      ({ level, path }) =>
        level === 'target' &&
        path ===
          `Target Support Files/Pods-PickleSensei/Pods-PickleSensei.${name.toLowerCase()}.xcconfig`,
    ),
);
{
  const release = configuration('Release');
  const debugDefinitions = [
    ...release
      .values('GCC_PREPROCESSOR_DEFINITIONS')
      .filter(v => /\bDEBUG(=1)?\b/.test(v)),
    ...release
      .values('SWIFT_ACTIVE_COMPILATION_CONDITIONS')
      .filter(v => /\bDEBUG\b/.test(v)),
  ];
  check(
    'pbxproj [Release]: no DEBUG preprocessor definition or Swift compilation condition (target, project, or conditional)',
    debugDefinitions.length === 0,
  );
  if (debugDefinitions.length > 0) {
    console.log(`     ${release.describe('GCC_PREPROCESSOR_DEFINITIONS')}`);
    console.log(
      `     ${release.describe('SWIFT_ACTIVE_COMPILATION_CONDITIONS')}`,
    );
  }
  const optimisation = release.values('SWIFT_OPTIMIZATION_LEVEL');
  check(
    'pbxproj [Release]: Swift optimisation not -Onone (target, project, or conditional)',
    optimisation.every(v => v !== '-Onone'),
  );
  if (optimisation.includes('-Onone'))
    console.log(`     ${release.describe('SWIFT_OPTIMIZATION_LEVEL')}`);
}

// --- SwiftPM: every linked product is imported by compiled Swift -------------
// An unused package still ships in the binary (size, undeclared SDK in the
// dossier, and a min-iOS above the deployment target produces linker warnings
// on every Mac build).
function swiftFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (
      entry === 'Pods' ||
      entry === 'build' ||
      entry === '.build' ||
      entry === 'node_modules'
    )
      continue;
    const full = join(dir, entry);
    const stat = statSync(full); // follows LocalPods symlinks like CocoaPods
    if (stat.isDirectory()) swiftFiles(full, out);
    else if (stat.isFile() && entry.endsWith('.swift')) out.push(full);
  }
  return out;
}
const importedModules = new Set(
  [
    ...swiftFiles(join(mobileRoot, 'ios')),
    ...swiftFiles(join(repoRoot, 'native')),
  ].flatMap(file =>
    Array.from(
      readFileSync(file, 'utf8').matchAll(
        /^\s*(?:@\w+\s+)*import\s+(?:(?:class|struct|enum|protocol|func|var|let|typealias)\s+)?(\w+)/gm,
      ),
      m => m[1],
    ),
  ),
);
const linkedProducts = project.linkedPackageProducts(appTarget);
const unusedProducts = linkedProducts.filter(p => !importedModules.has(p));
check(
  `pbxproj: every linked SwiftPM product is imported by Swift under ios/ or native/${
    unusedProducts.length ? ` (unused: ${unusedProducts.join(', ')})` : ''
  }`,
  unusedProducts.length === 0,
);
const remotePackages = project
  .remotePackageUrls()
  .map(url => basename(url.replace(/\.git$/, '')).toLowerCase());
const packageResolved = readText(
  'ios/PickleSensei.xcworkspace/xcshareddata/swiftpm/Package.resolved',
);
const pinned =
  packageResolved === null
    ? []
    : JSON.parse(packageResolved).pins.map(pin => pin.identity.toLowerCase());
check(
  'Package.resolved: no pin without a referenced remote package (stale lock)',
  remotePackages.length > 0 || pinned.length === 0,
);
check(
  'Package.resolved: every referenced remote package is pinned',
  remotePackages.every(name => pinned.includes(name)),
);
const dossier = readFileSync(
  join(repoRoot, 'docs', 'APP_STORE_SUBMISSION.md'),
  'utf8',
);
const sdkRow =
  /\| Third-party SDKs in binary\s*\|([^|]*)\|/.exec(dossier)?.[1] ?? '';
check(
  'dossier: every remote SwiftPM package appears in "Third-party SDKs in binary"',
  remotePackages.every(name => sdkRow.toLowerCase().includes(name)),
);

const infoPlist = readText('ios/PickleSensei/Info.plist') ?? '';
check(
  'Info.plist: camera usage description present',
  infoPlist.includes('NSCameraUsageDescription'),
);
check(
  'Info.plist: microphone usage description present',
  infoPlist.includes('NSMicrophoneUsageDescription'),
);
check(
  'Info.plist: photo library usage description present (video import)',
  infoPlist.includes('NSPhotoLibraryUsageDescription'),
);
check(
  'Info.plist: ATS arbitrary loads disabled',
  /NSAllowsArbitraryLoads<\/key>\s*<false\/>/.test(infoPlist),
);
check(
  'Info.plist: version pulled from build settings',
  infoPlist.includes('$(MARKETING_VERSION)') &&
    infoPlist.includes('$(CURRENT_PROJECT_VERSION)'),
);
check(
  'Info.plist: export-compliance exemption declared (ITSAppUsesNonExemptEncryption=false)',
  /ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/.test(infoPlist),
);

const privacy = readText('ios/PickleSensei/PrivacyInfo.xcprivacy') ?? '';
check(
  'PrivacyInfo.xcprivacy: accessed-API declarations present',
  privacy.includes('NSPrivacyAccessedAPITypes'),
);
const resourcePaths = project.resourcePaths(appTarget);
check(
  "PrivacyInfo.xcprivacy: copied by the app target's Resources build phase",
  resourcePaths.some(p => basename(p) === 'PrivacyInfo.xcprivacy'),
);
const appFonts = Array.from(
  (
    /<key>UIAppFonts<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(
      infoPlist,
    )?.[1] ?? ''
  ).matchAll(/<string>([^<]+)<\/string>/g),
  m => m[1],
);
check(
  'Info.plist: every UIAppFonts file is copied by the Resources build phase',
  appFonts.length > 0 &&
    appFonts.every(font => resourcePaths.some(p => basename(p) === font)),
);

const entitlements = readText('ios/PickleSensei/PickleSensei.entitlements');
check('entitlements file exists', entitlements !== null);
check(
  'entitlements: Sign in with Apple capability declared',
  (entitlements ?? '').includes('com.apple.developer.applesignin'),
);
check(
  'Podfile.lock committed (deterministic pods)',
  readText('ios/Podfile.lock') !== null,
);

const fastfile = readText('ios/fastlane/Fastfile') ?? '';
check(
  'fastlane: beta (TestFlight) lane defined',
  /lane :beta do/.test(fastfile),
);
check(
  'fastlane: release (App Store) lane defined, binary-only, no auto-submit',
  /lane :release do/.test(fastfile) &&
    fastfile.includes('submit_for_review: false'),
);
check(
  'fastlane: internal-only distribution (no external without review)',
  fastfile.includes('distribute_external: false'),
);
check(
  'fastlane: no hardcoded credentials',
  !/FASTLANE_PASSWORD|-----BEGIN/.test(fastfile) &&
    /ENV\.fetch\("APP_STORE_CONNECT_API_KEY_KEY_ID"\)/.test(fastfile),
);

const appfile = readText('ios/fastlane/Appfile') ?? '';
const appfileTeam = /team_id\("(\w+)"\)/.exec(appfile)?.[1] ?? null;
check(
  'fastlane: Appfile identifies app + team without secrets',
  appfile.includes('com.picklesensei') &&
    appfileTeam !== null &&
    !/password|apple_id\(/.test(appfile),
);
pinnedSetting(
  'DEVELOPMENT_TEAM matches fastlane Appfile team_id',
  'DEVELOPMENT_TEAM',
  v => appfileTeam !== null && v === appfileTeam,
);

if (failures.length > 0) {
  console.error(`\n${failures.length} distribution precondition(s) failed.`);
  process.exit(1);
}
console.log('\nAll Linux-validatable distribution preconditions passed.');
console.log(
  'NOT validated here (Mac-only): pod install, archive, signing, TestFlight upload.',
);
