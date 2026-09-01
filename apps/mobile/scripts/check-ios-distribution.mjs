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
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function check(label, ok) {
  if (!ok) failures.push(label);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
}

function readText(relPath) {
  const abs = join(mobileRoot, relPath);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
}

const pbxproj = readText('ios/PickleSensei.xcodeproj/project.pbxproj') ?? '';
check(
  'pbxproj: PRODUCT_BUNDLE_IDENTIFIER = com.picklesensei',
  /PRODUCT_BUNDLE_IDENTIFIER = com\.picklesensei;/.test(pbxproj),
);
check(
  'pbxproj: MARKETING_VERSION set',
  /MARKETING_VERSION = [\d.]+;/.test(pbxproj),
);
check(
  'pbxproj: CURRENT_PROJECT_VERSION set',
  /CURRENT_PROJECT_VERSION = \d+;/.test(pbxproj),
);
check('pbxproj: DEVELOPMENT_TEAM set', /DEVELOPMENT_TEAM = \w+;/.test(pbxproj));
check(
  'pbxproj: iPhone-only (TARGETED_DEVICE_FAMILY = 1; v1 launch decision)',
  /TARGETED_DEVICE_FAMILY = 1;/.test(pbxproj) &&
    !/TARGETED_DEVICE_FAMILY = "1,2";/.test(pbxproj),
);
check(
  'pbxproj: entitlements wired',
  /CODE_SIGN_ENTITLEMENTS = PickleSensei\/PickleSensei\.entitlements;/.test(
    pbxproj,
  ),
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
check(
  'fastlane: Appfile team matches DEVELOPMENT_TEAM in project.pbxproj',
  appfileTeam !== null &&
    new RegExp(`DEVELOPMENT_TEAM = ${appfileTeam};`).test(pbxproj),
);

if (failures.length > 0) {
  console.error(`\n${failures.length} distribution precondition(s) failed.`);
  process.exit(1);
}
console.log('\nAll Linux-validatable distribution preconditions passed.');
console.log(
  'NOT validated here (Mac-only): pod install, archive, signing, TestFlight upload.',
);
