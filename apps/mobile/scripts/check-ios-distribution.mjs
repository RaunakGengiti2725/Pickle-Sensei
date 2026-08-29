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
  'Info.plist: ATS arbitrary loads disabled',
  /NSAllowsArbitraryLoads<\/key>\s*<false\/>/.test(infoPlist),
);
check(
  'Info.plist: version pulled from build settings',
  infoPlist.includes('$(MARKETING_VERSION)') &&
    infoPlist.includes('$(CURRENT_PROJECT_VERSION)'),
);

const privacy = readText('ios/PickleSensei/PrivacyInfo.xcprivacy') ?? '';
check(
  'PrivacyInfo.xcprivacy: accessed-API declarations present',
  privacy.includes('NSPrivacyAccessedAPITypes'),
);

check(
  'entitlements file exists',
  readText('ios/PickleSensei/PickleSensei.entitlements') !== null,
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
  'fastlane: internal-only distribution (no external without review)',
  fastfile.includes('distribute_external: false'),
);
check(
  'fastlane: no hardcoded credentials',
  !/FASTLANE_PASSWORD|-----BEGIN/.test(fastfile) &&
    /ENV\.fetch\("APP_STORE_CONNECT_API_KEY_KEY_ID"\)/.test(fastfile),
);

const appfile = readText('ios/fastlane/Appfile') ?? '';
check(
  'fastlane: Appfile identifies app + team without secrets',
  appfile.includes('com.picklesensei') &&
    appfile.includes('H26U6W4K6V') &&
    !/password|apple_id\(/.test(appfile),
);

if (failures.length > 0) {
  console.error(`\n${failures.length} distribution precondition(s) failed.`);
  process.exit(1);
}
console.log('\nAll Linux-validatable distribution preconditions passed.');
console.log(
  'NOT validated here (Mac-only): pod install, archive, signing, TestFlight upload.',
);
