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
// A key_filepath argument may only name the .p8 path through the environment,
// directly or via a local that is itself assigned from the environment.
const KEY_FILEPATH_ENV_SOURCE =
  /^ENV(?:\.fetch\(|\[)["']APP_STORE_CONNECT_API_KEY_KEY_FILEPATH["'][)\]]$/;
const EXPECTED_SHORT_VERSION_SOURCE = '$(MARKETING_VERSION)';
const EXPECTED_BUNDLE_VERSION_SOURCE = '$(CURRENT_PROJECT_VERSION)';

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
 * build configuration that sets it), quotes removed — INCLUDING conditional
 * overrides (`"SETTING[sdk=iphoneos*]" = value;`, `[arch=...]`, `[config=...]`,
 * chained conditions), which win over the plain line for the builds they match;
 * sdk=iphoneos* is the device / App Store archive. Xcode quotes such keys, so
 * both the bare and the quoted spelling are recognised; a different setting
 * that merely contains the name (OTHER_SETTING, SETTING_SUFFIX) is not.
 */
function pbxSettingValues(text, setting) {
  const key = `${setting}(?:\\[[^\\]]*\\])*`;
  const re = new RegExp(
    `(?<![\\w.])(?:"${key}"|${key})\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^;\\s]+))\\s*;`,
    'g',
  );
  return [...stripCStyleComments(text, ['"']).matchAll(re)].map(m =>
    m[1] !== undefined ? m[1] : m[2],
  );
}

/**
 * Every `<string>` value that directly follows `<key>name</key>` in a plist,
 * XML comments removed. A key whose value is not a `<string>` yields nothing.
 */
function plistStringValues(plist, name) {
  const stripped = plist.replace(/<!--[\s\S]*?-->/g, '');
  const re = new RegExp(
    `<key>\\s*${name}\\s*</key>\\s*<string>([^<]*)</string>`,
    'g',
  );
  return [...stripped.matchAll(re)].map(m => m[1].trim());
}

/**
 * The Ruby expression starting at `start`: everything up to the first
 * top-level `,`, newline or closing bracket, with strings and nested
 * brackets kept whole.
 */
function rubyExpressionAt(text, start) {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) {
        if (text[j] === '\\') j += 1;
        j += 1;
      }
      i = j + 1;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) break;
      depth -= 1;
    } else if (depth === 0 && (ch === ',' || ch === '\n')) break;
    i += 1;
  }
  return text.slice(start, i).trim();
}

/**
 * Every value passed for keyword/hash key `name` anywhere in (comment-stripped)
 * Ruby source, in every spelling Ruby accepts: `name: v`, `:name => v`,
 * `"name" => v`, `'name' => v`, `"name": v`. A flag that is turned on in ANY
 * spelling is therefore seen, whatever other hash still carries `name: false`.
 */
function rubyArgValues(source, name) {
  const re = new RegExp(
    `(?:(?<![\\w:])${name}:(?!:)|(?<!\\w):${name}\\s*=>|(["'])${name}\\1\\s*(?:=>|:(?!:)))\\s*`,
    'g',
  );
  return [...blankRubyStrings(source).matchAll(re)].map(m =>
    rubyExpressionAt(source, m.index + m[0].length),
  );
}

/** Every right-hand side assigned to the Ruby local `name` (`name = expr`). */
function rubyAssignments(source, name) {
  const re = new RegExp(`(?<![\\w.:])${name}\\s*=(?![=>~])\\s*`, 'g');
  return [...blankRubyStrings(source).matchAll(re)].map(m =>
    rubyExpressionAt(source, m.index + m[0].length),
  );
}

/**
 * Same-length copy of Ruby source with the contents of string literals blanked
 * out, so key/assignment searches cannot match text inside a string. A string
 * used as a hash key (`"name" => v`, `"name": v`) is kept.
 */
function blankRubyStrings(text) {
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
      const literal = text.slice(i, j + 1);
      const isHashKey = /^\s*(?:=>|:(?!:))/.test(text.slice(j + 1));
      out += isHashKey ? literal : literal.replace(/[^"'\n]/g, ' ');
      i = j + 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
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
const marketingVersions = pbxSettingValues(pbxproj, 'MARKETING_VERSION');
check(
  `pbxproj: MARKETING_VERSION is one MAJOR.MINOR[.PATCH] value in every build configuration (${describeValues(marketingVersions)}; need >= 2, all equal)`,
  marketingVersions.length >= 2 &&
    /^\d+\.\d+(\.\d+)?$/.test(marketingVersions[0]) &&
    marketingVersions.every(value => value === marketingVersions[0]),
);
const projectVersions = pbxSettingValues(pbxproj, 'CURRENT_PROJECT_VERSION');
check(
  `pbxproj: CURRENT_PROJECT_VERSION is one positive integer in every build configuration (${describeValues(projectVersions)}; need >= 2, all equal)`,
  projectVersions.length >= 2 &&
    /^[1-9]\d*$/.test(projectVersions[0]) &&
    projectVersions.every(value => value === projectVersions[0]),
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
const shortVersionSources = plistStringValues(
  infoPlist,
  'CFBundleShortVersionString',
);
const bundleVersionSources = plistStringValues(infoPlist, 'CFBundleVersion');
check(
  `Info.plist: version pulled from build settings (CFBundleShortVersionString = ${EXPECTED_SHORT_VERSION_SOURCE}: ${describeValues(shortVersionSources)}; CFBundleVersion = ${EXPECTED_BUNDLE_VERSION_SOURCE}: ${describeValues(bundleVersionSources)})`,
  shortVersionSources.length >= 1 &&
    shortVersionSources.every(v => v === EXPECTED_SHORT_VERSION_SOURCE) &&
    bundleVersionSources.length >= 1 &&
    bundleVersionSources.every(v => v === EXPECTED_BUNDLE_VERSION_SOURCE),
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
// Safety flags: every spelling of the argument, anywhere in the Fastfile, must
// be the literal `false` — a flag turned on in any hash (or computed at run
// time) is a violation even if another hash still carries `flag: false`.
const submitForReview = rubyArgValues(fastfile, 'submit_for_review');
check(
  `fastlane: release (App Store) lane defined, binary-only, no auto-submit (every submit_for_review argument is literally false; ${describeValues(submitForReview)})`,
  /lane :release do/.test(fastfile) &&
    submitForReview.length >= 1 &&
    submitForReview.every(value => value === 'false'),
);
const distributeExternal = rubyArgValues(fastfile, 'distribute_external');
check(
  `fastlane: internal-only distribution (every distribute_external argument is literally false; ${describeValues(distributeExternal)})`,
  distributeExternal.length >= 1 &&
    distributeExternal.every(value => value === 'false'),
);
const keyContentArgs = rubyArgValues(fastfile, 'key_content');
check(
  `fastlane: no hardcoded credentials (every key_content argument is exactly ${EXPECTED_KEY_CONTENT}; ${describeValues(keyContentArgs)})`,
  !/FASTLANE_PASSWORD|-----BEGIN/.test(fastfile) &&
    /ENV\.fetch\("APP_STORE_CONNECT_API_KEY_KEY_ID"\)/.test(fastfile) &&
    keyContentArgs.length >= 1 &&
    keyContentArgs.every(arg => arg === EXPECTED_KEY_CONTENT),
);
const keyFilepathArgs = rubyArgValues(fastfile, 'key_filepath');
function keyFilepathFromEnv(arg) {
  if (KEY_FILEPATH_ENV_SOURCE.test(arg)) return true;
  if (!/^[a-z_]\w*$/.test(arg)) return false;
  const assignments = rubyAssignments(fastfile, arg);
  return (
    assignments.length >= 1 &&
    assignments.every(rhs => KEY_FILEPATH_ENV_SOURCE.test(rhs))
  );
}
check(
  `fastlane: no committed key path (every key_filepath argument comes from ENV["APP_STORE_CONNECT_API_KEY_KEY_FILEPATH"]; ${describeValues(keyFilepathArgs)})`,
  keyFilepathArgs.every(keyFilepathFromEnv),
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
