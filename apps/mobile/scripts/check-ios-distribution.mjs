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

const EXPECTED_BUNDLE_ID = 'com.picklesensei';
const EXPECTED_DEVELOPMENT_TEAM = 'H26U6W4K6V';
// iPhone-only (v1 launch decision).
const EXPECTED_DEVICE_FAMILY = '1';
const EXPECTED_KEY_CONTENT = 'ENV.fetch("APP_STORE_CONNECT_API_KEY_KEY")';

/** Copies `text` without its comments; string literals (any of `quotes`) stay intact. */
function stripCStyleComments(text, quotes) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (quotes.includes(ch)) {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) {
        if (text[j] === '\\') j += 1;
        j += 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && next === '/') {
      let j = text.indexOf('\n', i);
      if (j === -1) j = text.length;
      i = j;
    } else if (ch === '/' && next === '*') {
      let j = text.indexOf('*/', i + 2);
      if (j === -1) j = text.length;
      out += text.slice(i, j).replace(/[^\n]/g, '');
      i = j + 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** Copies Ruby source without `#` comments; `#` inside a string literal is kept. */
function stripRubyComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) {
        if (text[j] === '\\') j += 1;
        j += 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '#') {
      let j = text.indexOf('\n', i);
      if (j === -1) j = text.length;
      i = j;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/**
 * Every effective value of an Xcode build setting in project.pbxproj (one per
 * build configuration that sets it), quotes removed.
 */
function pbxSettingValues(text, setting) {
  const re = new RegExp(
    `(?<![\\w.])${setting}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^;\\s]+))\\s*;`,
    'g',
  );
  return [...stripCStyleComments(text, ['"']).matchAll(re)].map(m =>
    m[1] !== undefined ? m[1] : m[2],
  );
}

function describeValues(values) {
  return values.length === 0
    ? 'none found'
    : `found ${values.length}: ${values.join(', ')}`;
}

/** `setting` must appear in >= 2 build configurations and equal `expected` in all of them. */
function checkPbxSetting(label, values, expected) {
  check(
    `${label} (${describeValues(values)}; need >= 2, all equal)`,
    values.length >= 2 && values.every(value => value === expected),
  );
}

function check(label, ok) {
  if (!ok) failures.push(label);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
}

function readText(relPath) {
  const abs = join(mobileRoot, relPath);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
}

const pbxproj = readText('ios/PickleSensei.xcodeproj/project.pbxproj') ?? '';
const developmentTeams = pbxSettingValues(pbxproj, 'DEVELOPMENT_TEAM');
checkPbxSetting(
  `pbxproj: PRODUCT_BUNDLE_IDENTIFIER = ${EXPECTED_BUNDLE_ID} in every build configuration`,
  pbxSettingValues(pbxproj, 'PRODUCT_BUNDLE_IDENTIFIER'),
  EXPECTED_BUNDLE_ID,
);
check(
  'pbxproj: MARKETING_VERSION set',
  /MARKETING_VERSION = [\d.]+;/.test(pbxproj),
);
check(
  'pbxproj: CURRENT_PROJECT_VERSION set',
  /CURRENT_PROJECT_VERSION = \d+;/.test(pbxproj),
);
checkPbxSetting(
  `pbxproj: DEVELOPMENT_TEAM = ${EXPECTED_DEVELOPMENT_TEAM} in every build configuration`,
  developmentTeams,
  EXPECTED_DEVELOPMENT_TEAM,
);
checkPbxSetting(
  `pbxproj: iPhone-only, TARGETED_DEVICE_FAMILY = ${EXPECTED_DEVICE_FAMILY} in every build configuration`,
  pbxSettingValues(pbxproj, 'TARGETED_DEVICE_FAMILY'),
  EXPECTED_DEVICE_FAMILY,
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

// Every Fastfile rule reads the comment-stripped source: a flag that only
// survives inside a `#` comment is neither a safeguard nor a violation.
const fastfile = stripRubyComments(readText('ios/fastlane/Fastfile') ?? '');
check(
  'fastlane: beta (TestFlight) lane defined',
  /lane :beta do/.test(fastfile),
);
check(
  'fastlane: release (App Store) lane defined, binary-only, no auto-submit (submit_for_review: false, never true)',
  /lane :release do/.test(fastfile) &&
    /\bsubmit_for_review:\s*false\b/.test(fastfile) &&
    !/\bsubmit_for_review:\s*true\b/.test(fastfile),
);
check(
  'fastlane: internal-only distribution (distribute_external: false, never true)',
  /\bdistribute_external:\s*false\b/.test(fastfile) &&
    !/\bdistribute_external:\s*true\b/.test(fastfile),
);
const keyContentArgs = [
  ...fastfile.matchAll(/\bkey_content:\s*([^,}\n]+)/g),
].map(m => m[1].trim());
check(
  `fastlane: no hardcoded credentials (key_content only from ${EXPECTED_KEY_CONTENT}; ${describeValues(keyContentArgs)})`,
  !/FASTLANE_PASSWORD|-----BEGIN/.test(fastfile) &&
    /ENV\.fetch\("APP_STORE_CONNECT_API_KEY_KEY_ID"\)/.test(fastfile) &&
    keyContentArgs.length >= 1 &&
    keyContentArgs.every(arg => arg === EXPECTED_KEY_CONTENT),
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
  'fastlane: Appfile team matches DEVELOPMENT_TEAM in every project.pbxproj build configuration',
  appfileTeam !== null &&
    developmentTeams.length >= 2 &&
    developmentTeams.every(team => team === appfileTeam),
);

if (failures.length > 0) {
  console.error(`\n${failures.length} distribution precondition(s) failed.`);
  process.exit(1);
}
console.log('\nAll Linux-validatable distribution preconditions passed.');
console.log(
  'NOT validated here (Mac-only): pod install, archive, signing, TestFlight upload.',
);
