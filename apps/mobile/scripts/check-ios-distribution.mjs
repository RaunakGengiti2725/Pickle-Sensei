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
 * Build settings are checked in EVERY build configuration of project.pbxproj
 * (Debug and Release alike), and the fastlane files are checked on their
 * effective, comment-stripped text — a Release-only drift or a flag that is
 * flipped with the old value left in a `#` comment fails the gate.
 *
 * Usage: node scripts/check-ios-distribution.mjs   (exit 0 = all green)
 * Tests: npx jest __tests__/wf/flow-ios-distribution-gate.test.ts
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

const EXPECTED_BUNDLE_ID = 'com.picklesensei';
const EXPECTED_DEVICE_FAMILY = '1'; // iPhone-only, v1 launch decision
const EXPECTED_DEVELOPMENT_TEAM = 'H26U6W4K6V';
const EXPECTED_ENTITLEMENTS = 'PickleSensei/PickleSensei.entitlements';
const EXPECTED_KEY_CONTENT = 'ENV.fetch("APP_STORE_CONNECT_API_KEY_KEY")';
const MIN_CONFIGURATIONS = 2; // Debug + Release

function check(label, ok) {
  if (!ok) failures.push(label);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
}

function readText(relPath) {
  const abs = join(mobileRoot, relPath);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
}

/**
 * Removes comments while leaving string literals intact (a `#` inside a Ruby
 * `"#{...}"` interpolation or a `//` inside a quoted path is not a comment).
 * `line` lists the end-of-line comment openers; `block` strips `/* ... *\/`.
 */
function stripComments(text, { line, block }) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n && text[j] !== ch) {
        if (text[j] === '\\') j += 1;
        j += 1;
      }
      out += text.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }
    if (block && text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (line.some(marker => text.startsWith(marker, i))) {
      const end = text.indexOf('\n', i);
      i = end < 0 ? n : end;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const stripPbxprojComments = text =>
  stripComments(text, { line: ['//'], block: true });
const stripRubyComments = text =>
  stripComments(text, { line: ['#'], block: false });

function unquote(value) {
  const v = value.trim();
  return v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"'
    ? v.slice(1, -1)
    : v;
}

/** Every effective `KEY = value;` occurrence in the pbxproj, in file order. */
function buildSettingValues(pbxproj, key) {
  const re = new RegExp(
    `(?:^|[\\s{;])${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|[^;]*?)\\s*;`,
    'g',
  );
  return [...pbxproj.matchAll(re)].map(m => unquote(m[1]));
}

function describe(values) {
  return values.length === 0 ? 'none found' : `found: ${values.join(', ')}`;
}

/** All occurrences (>= MIN_CONFIGURATIONS) must equal `expected`. */
function checkEveryConfiguration(pbxproj, key, expected, why) {
  const values = buildSettingValues(pbxproj, key);
  check(
    `pbxproj: ${key} = ${expected} in every build configuration${why ? ` (${why})` : ''} (>= ${MIN_CONFIGURATIONS} occurrences; ${describe(values)})`,
    values.length >= MIN_CONFIGURATIONS && values.every(v => v === expected),
  );
  return values;
}

/** All occurrences (>= MIN_CONFIGURATIONS) must match `pattern` and agree. */
function checkConsistentConfiguration(pbxproj, key, pattern) {
  const values = buildSettingValues(pbxproj, key);
  check(
    `pbxproj: ${key} set and identical in every build configuration (>= ${MIN_CONFIGURATIONS} occurrences; ${describe(values)})`,
    values.length >= MIN_CONFIGURATIONS &&
      values.every(v => pattern.test(v) && v === values[0]),
  );
}

const pbxproj = stripPbxprojComments(
  readText('ios/PickleSensei.xcodeproj/project.pbxproj') ?? '',
);
checkEveryConfiguration(
  pbxproj,
  'PRODUCT_BUNDLE_IDENTIFIER',
  EXPECTED_BUNDLE_ID,
);
checkConsistentConfiguration(pbxproj, 'MARKETING_VERSION', /^\d+(\.\d+)+$/);
checkConsistentConfiguration(pbxproj, 'CURRENT_PROJECT_VERSION', /^\d+$/);
const developmentTeams = checkEveryConfiguration(
  pbxproj,
  'DEVELOPMENT_TEAM',
  EXPECTED_DEVELOPMENT_TEAM,
);
checkEveryConfiguration(
  pbxproj,
  'TARGETED_DEVICE_FAMILY',
  EXPECTED_DEVICE_FAMILY,
  'iPhone-only; v1 launch decision',
);
checkEveryConfiguration(
  pbxproj,
  'CODE_SIGN_ENTITLEMENTS',
  EXPECTED_ENTITLEMENTS,
  'entitlements wired',
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

// The raw Fastfile is scanned for secrets (a key pasted into a comment is
// still a leak); everything else is judged on the effective, comment-stripped
// text so a flag cannot be flipped with the old value left in a `#` comment.
const rawFastfile = readText('ios/fastlane/Fastfile') ?? '';
const fastfile = stripRubyComments(rawFastfile);
check(
  'fastlane: beta (TestFlight) lane defined',
  /lane :beta do/.test(fastfile),
);
check(
  'fastlane: release (App Store) lane defined, binary-only, no auto-submit (effective submit_for_review: false)',
  /lane :release do/.test(fastfile) &&
    /submit_for_review:\s*false\b/.test(fastfile) &&
    !/submit_for_review:\s*true\b/.test(fastfile),
);
check(
  'fastlane: internal-only distribution (effective distribute_external: false; external needs App Review)',
  /distribute_external:\s*false\b/.test(fastfile) &&
    !/distribute_external:\s*true\b/.test(fastfile),
);
const keyContents = [...fastfile.matchAll(/\bkey_content:\s*([^,}\n]+)/g)].map(
  m => m[1].trim(),
);
check(
  `fastlane: key_content is ${EXPECTED_KEY_CONTENT} (environment-provided, never a literal; ${describe(keyContents)})`,
  keyContents.length >= 1 && keyContents.every(v => v === EXPECTED_KEY_CONTENT),
);
check(
  'fastlane: no hardcoded credentials',
  !/FASTLANE_PASSWORD|-----BEGIN/.test(rawFastfile) &&
    /ENV\.fetch\("APP_STORE_CONNECT_API_KEY_KEY_ID"\)/.test(fastfile),
);

const appfile = stripRubyComments(readText('ios/fastlane/Appfile') ?? '');
const appfileTeam = /team_id\("(\w+)"\)/.exec(appfile)?.[1] ?? null;
check(
  'fastlane: Appfile identifies app + team without secrets',
  appfile.includes(EXPECTED_BUNDLE_ID) &&
    appfileTeam !== null &&
    !/password|apple_id\(/.test(appfile),
);
check(
  `fastlane: Appfile team matches DEVELOPMENT_TEAM in every project.pbxproj configuration (${appfileTeam ?? 'none'})`,
  appfileTeam !== null &&
    developmentTeams.length >= MIN_CONFIGURATIONS &&
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
