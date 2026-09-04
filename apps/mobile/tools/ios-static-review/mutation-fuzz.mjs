#!/usr/bin/env node
/**
 * Adversarial mutation fuzz for the iOS release-configuration guards.
 *
 * Copies the shipping iOS configuration (Info.plist, entitlements, privacy
 * manifest, project.pbxproj, shared scheme, Podfile, fastlane, AppDelegate,
 * PickleNative sources, runtimeConfig.ts, the dossier) into sandboxes, applies
 * a catalogue of regressions a developer could plausibly introduce (drop a
 * usage string, flip ATS, add a background mode, ship -Onone, log a token,
 * ...) plus seeded random compositions, then runs BOTH Linux guards against
 * each sandbox:
 *
 *   A. scripts/check-ios-distribution.mjs          (repo's existing gate)
 *   B. tools/ios-static-review/audit.mjs           (this review's harness)
 *
 * and records whether each guard exits non-zero. A mutation that no guard
 * catches is a coverage gap; a benign mutation that a guard rejects is a
 * false positive. Every case records its seed and the exact mutation list so
 * any row is replayable with `--replay <caseId>`.
 *
 * Usage:
 *   node tools/ios-static-review/mutation-fuzz.mjs \
 *        [--random 400] [--seed 20260904] [--workers 4] \
 *        [--out <matrix.json>] [--work-dir <dir>] [--replay <caseId>]
 *
 * Only reads the repository; all writes go to the work dir and --out.
 */
import { execFile } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const mobileRoot = resolve(here, '..', '..');
const repoRoot = resolve(mobileRoot, '..', '..');

const args = process.argv.slice(2);
const argValue = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : dflt;
};
const RANDOM_CASES = Number.parseInt(argValue('--random', '400'), 10);
const SEED = Number.parseInt(argValue('--seed', '20260904'), 10);
const WORKERS = Number.parseInt(argValue('--workers', '4'), 10);
const OUT = argValue('--out', null);
const WORK_DIR = argValue(
  '--work-dir',
  join(tmpdir(), 'ios-static-review-fuzz'),
);
const REPLAY = argValue('--replay', null);

// ─────────────────────────── file set ────────────────────────────────────

const F = {
  info: 'apps/mobile/ios/PickleSensei/Info.plist',
  ent: 'apps/mobile/ios/PickleSensei/PickleSensei.entitlements',
  priv: 'apps/mobile/ios/PickleSensei/PrivacyInfo.xcprivacy',
  pbx: 'apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj',
  scheme:
    'apps/mobile/ios/PickleSensei.xcodeproj/xcshareddata/xcschemes/PickleSensei.xcscheme',
  appDelegate: 'apps/mobile/ios/PickleSensei/AppDelegate.swift',
  podfile: 'apps/mobile/ios/Podfile',
  fastfile: 'apps/mobile/ios/fastlane/Fastfile',
  appfile: 'apps/mobile/ios/fastlane/Appfile',
  runtimeConfig: 'apps/mobile/src/config/runtimeConfig.ts',
  dossier: 'docs/APP_STORE_SUBMISSION.md',
  cameraEngine:
    'apps/mobile/ios/LocalPods/PickleNative/Sources/Core/CameraEngine.swift',
  auth: 'apps/mobile/ios/LocalPods/PickleNative/Sources/PickleAuth.swift',
  guided:
    'apps/mobile/ios/LocalPods/PickleNative/Sources/GuidedCaptureViewController.swift',
  videoCapture:
    'apps/mobile/ios/LocalPods/PickleNative/Sources/PickleVideoCapture.swift',
};

// Directories copied into every sandbox (symlinks dereferenced).
const COPY = [
  'apps/mobile/ios/PickleSensei',
  'apps/mobile/ios/PickleSensei.xcodeproj',
  'apps/mobile/ios/Podfile',
  'apps/mobile/ios/Podfile.lock',
  'apps/mobile/ios/fastlane',
  'apps/mobile/ios/LocalPods/PickleNative',
  'apps/mobile/src',
  'apps/mobile/scripts/check-ios-distribution.mjs',
  'apps/mobile/tools/ios-static-review/plist.mjs',
  'apps/mobile/tools/ios-static-review/audit.mjs',
  'docs/APP_STORE_SUBMISSION.md',
];

// ─────────────────────────── PRNG (replayable) ───────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

// ─────────────────────────── mutation helpers ────────────────────────────

function must(text, re, label) {
  if (!re.test(text)) throw new Error(`mutation anchor not found: ${label}`);
  return text;
}
function removePlistKey(text, key) {
  // Removes `<key>K</key>` plus its single value element, matching nested
  // <array>/<dict> by depth so inner closers are not mistaken for the end.
  const keyRe = new RegExp(`\\n[\\t ]*<key>${key}</key>\\s*`);
  const km = keyRe.exec(text);
  if (!km) throw new Error(`mutation anchor not found: plist key ${key}`);
  const valueStart = km.index + km[0].length;
  const open =
    /^<(string|integer|real|date|data|true|false|array|dict)(\/?)>/.exec(
      text.slice(valueStart),
    );
  if (!open) throw new Error(`plist key ${key}: no value element`);
  let end;
  if (open[2] === '/') {
    end = valueStart + open[0].length;
  } else if (open[1] === 'array' || open[1] === 'dict') {
    const tag = open[1];
    const tagRe = new RegExp(`<(/?)${tag}(/?)>`, 'g');
    tagRe.lastIndex = valueStart;
    let depth = 0;
    let m;
    while ((m = tagRe.exec(text)) !== null) {
      if (m[2] === '/') {
        if (depth === 0) {
          end = m.index + m[0].length;
          break;
        }
        continue;
      }
      depth += m[1] === '/' ? -1 : 1;
      if (depth === 0) {
        end = m.index + m[0].length;
        break;
      }
    }
    if (end === undefined)
      throw new Error(`plist key ${key}: unterminated <${tag}>`);
  } else {
    const close = text.indexOf(`</${open[1]}>`, valueStart);
    end = close + `</${open[1]}>`.length;
  }
  return text.slice(0, km.index) + text.slice(end);
}
function insertTopLevel(text, xml) {
  // before the final </dict> of the top-level dict
  const idx = text.lastIndexOf('</dict>');
  return `${text.slice(0, idx)}${xml}\n${text.slice(idx)}`;
}
function setPbx(text, key, value, which /* 'Release' | 'Debug' | 'all' */) {
  // Replace inside the configuration blocks whose name matches.
  return text.replace(
    /([0-9A-F]{24} \/\* (Debug|Release) \*\/ = \{\s*isa = XCBuildConfiguration;[\s\S]*?\n\t\t\};)/g,
    (block, _all, name) => {
      if (which !== 'all' && name !== which) return block;
      const re = new RegExp(`\\n\\t\\t\\t\\t${key} = [^\\n]*;`);
      if (re.test(block))
        return block.replace(re, `\n\t\t\t\t${key} = ${value};`);
      return block.replace(
        'buildSettings = {',
        `buildSettings = {\n\t\t\t\t${key} = ${value};`,
      );
    },
  );
}
function removePbx(text, key, which) {
  return text.replace(
    /([0-9A-F]{24} \/\* (Debug|Release) \*\/ = \{\s*isa = XCBuildConfiguration;[\s\S]*?\n\t\t\};)/g,
    (block, _all, name) => {
      if (which !== 'all' && name !== which) return block;
      return block.replace(new RegExp(`\\n\\t\\t\\t\\t${key} = [^\\n]*;`), '');
    },
  );
}
function appendSwift(text, code) {
  return `${text}\n\n${code}\n`;
}

/**
 * Catalogue. `expect`:
 *   'detect' — a real release regression; at least one guard must exit 1
 *   'benign' — no semantic change; guards must stay green
 *   'observe' — record only (declared-but-unused, etc.)
 */
const CATALOGUE = [
  // Info.plist usage strings / ATS / background / URL / metadata
  {
    id: 'info.drop_camera_string',
    file: 'info',
    expect: 'detect',
    apply: t => removePlistKey(t, 'NSCameraUsageDescription'),
  },
  {
    id: 'info.drop_mic_string',
    file: 'info',
    expect: 'observe',
    apply: t => removePlistKey(t, 'NSMicrophoneUsageDescription'),
  },
  {
    id: 'info.drop_photos_string',
    file: 'info',
    expect: 'observe',
    apply: t => removePlistKey(t, 'NSPhotoLibraryUsageDescription'),
  },
  {
    id: 'info.ats_arbitrary_true',
    file: 'info',
    expect: 'detect',
    apply: t =>
      must(t, /NSAllowsArbitraryLoads<\/key>\s*<false\/>/, 'ATS').replace(
        /(NSAllowsArbitraryLoads<\/key>\s*)<false\/>/,
        '$1<true/>',
      ),
  },
  {
    id: 'info.ats_drop_dict',
    file: 'info',
    expect: 'detect',
    apply: t => removePlistKey(t, 'NSAppTransportSecurity'),
  },
  {
    id: 'info.ats_web_content_true',
    file: 'info',
    expect: 'detect',
    apply: t =>
      t.replace(
        /(<key>NSAllowsLocalNetworking<\/key>)/,
        '<key>NSAllowsArbitraryLoadsInWebContent</key>\n\t\t<true/>\n\t\t$1',
      ),
  },
  {
    id: 'info.ats_media_true',
    file: 'info',
    expect: 'detect',
    apply: t =>
      t.replace(
        /(<key>NSAllowsLocalNetworking<\/key>)/,
        '<key>NSAllowsArbitraryLoadsForMedia</key>\n\t\t<true/>\n\t\t$1',
      ),
  },
  {
    id: 'info.ats_insecure_exception_domain',
    file: 'info',
    expect: 'detect',
    apply: t =>
      t.replace(
        /(<key>NSAllowsLocalNetworking<\/key>)/,
        '<key>NSExceptionDomains</key>\n\t\t<dict>\n\t\t\t<key>example.com</key>\n\t\t\t<dict>\n\t\t\t\t<key>NSExceptionAllowsInsecureHTTPLoads</key>\n\t\t\t\t<true/>\n\t\t\t</dict>\n\t\t</dict>\n\t\t$1',
      ),
  },
  {
    id: 'info.add_background_audio',
    file: 'info',
    expect: 'detect',
    apply: t =>
      insertTopLevel(
        t,
        '\t<key>UIBackgroundModes</key>\n\t<array>\n\t\t<string>audio</string>\n\t</array>',
      ),
  },
  {
    id: 'info.add_background_fetch',
    file: 'info',
    expect: 'detect',
    apply: t =>
      insertTopLevel(
        t,
        '\t<key>UIBackgroundModes</key>\n\t<array>\n\t\t<string>fetch</string>\n\t</array>',
      ),
  },
  {
    id: 'info.url_scheme_typo',
    file: 'info',
    expect: 'detect',
    apply: t =>
      must(t, /ku9j3985cijj4e636t7s7efn8r1vsu8m/, 'scheme').replace(
        'ku9j3985cijj4e636t7s7efn8r1vsu8m',
        'ku9j3985cijj4e636t7s7efn8r1vsu8n',
      ),
  },
  {
    id: 'info.url_scheme_not_reversed',
    file: 'info',
    expect: 'detect',
    apply: t =>
      t.replace(
        'com.googleusercontent.apps.278019487172-ku9j3985cijj4e636t7s7efn8r1vsu8m',
        '278019487172-ku9j3985cijj4e636t7s7efn8r1vsu8m.apps.googleusercontent.com',
      ),
  },
  {
    id: 'info.url_scheme_extra',
    file: 'info',
    expect: 'detect',
    apply: t =>
      t.replace(
        /(<string>com\.googleusercontent\.apps\.[^<]+<\/string>)/,
        '$1\n\t\t\t\t<string>picklesensei</string>',
      ),
  },
  {
    id: 'info.url_types_dropped',
    file: 'info',
    expect: 'detect',
    apply: t => removePlistKey(t, 'CFBundleURLTypes'),
  },
  {
    id: 'info.orientation_landscape',
    file: 'info',
    expect: 'detect',
    apply: t =>
      t.replace(
        /(<string>UIInterfaceOrientationPortrait<\/string>)/,
        '$1\n\t\t<string>UIInterfaceOrientationLandscapeLeft</string>',
      ),
  },
  {
    id: 'info.encryption_true',
    file: 'info',
    expect: 'detect',
    apply: t =>
      must(
        t,
        /ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/,
        'ITS',
      ).replace(
        /(ITSAppUsesNonExemptEncryption<\/key>\s*)<false\/>/,
        '$1<true/>',
      ),
  },
  {
    id: 'info.encryption_dropped',
    file: 'info',
    expect: 'detect',
    apply: t => removePlistKey(t, 'ITSAppUsesNonExemptEncryption'),
  },
  {
    id: 'info.display_name_changed',
    file: 'info',
    expect: 'detect',
    apply: t =>
      must(t, /<string>Pickle Sensei<\/string>/, 'name').replace(
        '<string>Pickle Sensei</string>',
        '<string>PickleSensei Dev</string>',
      ),
  },
  {
    id: 'info.version_hardcoded',
    file: 'info',
    expect: 'detect',
    apply: t =>
      t.replace(
        '<string>$(MARKETING_VERSION)</string>',
        '<string>1.0</string>',
      ),
  },
  {
    id: 'info.add_location_string_unused',
    file: 'info',
    expect: 'observe',
    apply: t =>
      insertTopLevel(
        t,
        '\t<key>NSLocationWhenInUseUsageDescription</key>\n\t<string>Court location.</string>',
      ),
  },
  {
    id: 'info.add_queries_schemes',
    file: 'info',
    expect: 'observe',
    apply: t =>
      insertTopLevel(
        t,
        '\t<key>LSApplicationQueriesSchemes</key>\n\t<array>\n\t\t<string>youtube</string>\n\t</array>',
      ),
  },
  {
    id: 'info.duplicate_key',
    file: 'info',
    expect: 'detect',
    apply: t =>
      insertTopLevel(
        t,
        '\t<key>NSCameraUsageDescription</key>\n\t<string>dup</string>',
      ),
  },
  {
    id: 'info.benign_whitespace',
    file: 'info',
    expect: 'benign',
    apply: t => t.replace(/\t/g, '    '),
  },
  {
    id: 'info.benign_comment',
    file: 'info',
    expect: 'benign',
    apply: t => t.replace('<dict>', '<dict>\n\t<!-- reviewed 2026-09-04 -->'),
  },
  {
    id: 'info.benign_reorder',
    file: 'info',
    expect: 'benign',
    apply: t => {
      const cam =
        /\n[\t ]*<key>NSCameraUsageDescription<\/key>\s*<string>[\s\S]*?<\/string>/.exec(
          t,
        )[0];
      return insertTopLevel(
        t.replace(cam, ''),
        cam.trimStart().replace(/^/, '\t'),
      );
    },
  },

  // entitlements
  {
    id: 'ent.drop_applesignin',
    file: 'ent',
    expect: 'detect',
    apply: t => removePlistKey(t, 'com.apple.developer.applesignin'),
  },
  {
    id: 'ent.add_push',
    file: 'ent',
    expect: 'detect',
    apply: t =>
      insertTopLevel(
        t,
        '\t<key>aps-environment</key>\n\t<string>production</string>',
      ),
  },
  {
    id: 'ent.add_healthkit',
    file: 'ent',
    expect: 'detect',
    apply: t =>
      insertTopLevel(
        t,
        '\t<key>com.apple.developer.healthkit</key>\n\t<true/>',
      ),
  },
  {
    id: 'ent.applesignin_empty',
    file: 'ent',
    expect: 'detect',
    apply: t => t.replace('<string>Default</string>', ''),
  },

  // privacy manifest
  {
    id: 'priv.drop_userdefaults',
    file: 'priv',
    expect: 'detect',
    apply: t =>
      must(t, /NSPrivacyAccessedAPICategoryUserDefaults/, 'ud').replace(
        /\n[\t ]*<dict>\s*<key>NSPrivacyAccessedAPIType<\/key>\s*<string>NSPrivacyAccessedAPICategoryUserDefaults<\/string>[\s\S]*?<\/dict>/,
        '',
      ),
  },
  {
    id: 'priv.drop_file_timestamp',
    file: 'priv',
    expect: 'detect',
    apply: t =>
      t.replace(
        /\n[\t ]*<dict>\s*<key>NSPrivacyAccessedAPIType<\/key>\s*<string>NSPrivacyAccessedAPICategoryFileTimestamp<\/string>[\s\S]*?<\/dict>/,
        '',
      ),
  },
  {
    id: 'priv.tracking_true',
    file: 'priv',
    expect: 'detect',
    apply: t =>
      must(t, /NSPrivacyTracking<\/key>\s*<false\/>/, 'tracking').replace(
        /(NSPrivacyTracking<\/key>\s*)<false\/>/,
        '$1<true/>',
      ),
  },
  {
    id: 'priv.add_tracking_domain',
    file: 'priv',
    expect: 'detect',
    apply: t =>
      insertTopLevel(
        t,
        '\t<key>NSPrivacyTrackingDomains</key>\n\t<array>\n\t\t<string>tracker.example</string>\n\t</array>',
      ),
  },
  {
    id: 'priv.bogus_reason',
    file: 'priv',
    expect: 'detect',
    apply: t => t.replace('<string>CA92.1</string>', '<string>ZZZZ.9</string>'),
  },
  {
    id: 'priv.collected_type_tracks',
    file: 'priv',
    expect: 'detect',
    apply: t =>
      must(
        t,
        /NSPrivacyCollectedDataTypeTracking<\/key>\s*<false\/>/,
        'cdt',
      ).replace(
        /(NSPrivacyCollectedDataTypeTracking<\/key>\s*)<false\/>/,
        '$1<true/>',
      ),
  },
  {
    id: 'priv.add_device_id_type',
    file: 'priv',
    expect: 'detect',
    apply: t =>
      t.replace(
        /(<key>NSPrivacyCollectedDataTypes<\/key>\s*<array>)/,
        '$1\n\t\t<dict>\n\t\t\t<key>NSPrivacyCollectedDataType</key>\n\t\t\t<string>NSPrivacyCollectedDataTypeDeviceID</string>\n\t\t\t<key>NSPrivacyCollectedDataTypeLinked</key>\n\t\t\t<true/>\n\t\t\t<key>NSPrivacyCollectedDataTypeTracking</key>\n\t\t\t<false/>\n\t\t\t<key>NSPrivacyCollectedDataTypePurposes</key>\n\t\t\t<array/>\n\t\t</dict>',
      ),
  },

  // project.pbxproj release settings
  {
    id: 'pbx.strip_no',
    file: 'pbx',
    expect: 'detect',
    apply: t => setPbx(t, 'COPY_PHASE_STRIP', 'NO', 'Release'),
  },
  {
    id: 'pbx.assertions_yes',
    file: 'pbx',
    expect: 'detect',
    apply: t => setPbx(t, 'ENABLE_NS_ASSERTIONS', 'YES', 'Release'),
  },
  {
    id: 'pbx.metal_debug_yes',
    file: 'pbx',
    expect: 'detect',
    apply: t => setPbx(t, 'MTL_ENABLE_DEBUG_INFO', 'YES', 'Release'),
  },
  {
    id: 'pbx.validate_product_no',
    file: 'pbx',
    expect: 'detect',
    apply: t => setPbx(t, 'VALIDATE_PRODUCT', 'NO', 'Release'),
  },
  {
    id: 'pbx.release_swift_onone',
    file: 'pbx',
    expect: 'detect',
    apply: t => setPbx(t, 'SWIFT_OPTIMIZATION_LEVEL', '"-Onone"', 'Release'),
  },
  {
    id: 'pbx.release_gcc_o0',
    file: 'pbx',
    expect: 'detect',
    apply: t => setPbx(t, 'GCC_OPTIMIZATION_LEVEL', '0', 'Release'),
  },
  {
    id: 'pbx.release_testability',
    file: 'pbx',
    expect: 'detect',
    apply: t => setPbx(t, 'ENABLE_TESTABILITY', 'YES', 'Release'),
  },
  {
    id: 'pbx.release_only_active_arch',
    file: 'pbx',
    expect: 'detect',
    apply: t => setPbx(t, 'ONLY_ACTIVE_ARCH', 'YES', 'Release'),
  },
  {
    id: 'pbx.release_debug_condition',
    file: 'pbx',
    expect: 'detect',
    apply: t =>
      setPbx(
        t,
        'SWIFT_ACTIVE_COMPILATION_CONDITIONS',
        '"$(inherited) DEBUG"',
        'Release',
      ),
  },
  {
    id: 'pbx.release_debug_preprocessor',
    file: 'pbx',
    expect: 'detect',
    apply: t =>
      setPbx(
        t,
        'GCC_PREPROCESSOR_DEFINITIONS',
        '(\n\t\t\t\t\t"DEBUG=1",\n\t\t\t\t\t"$(inherited)",\n\t\t\t\t)',
        'Release',
      ),
  },
  {
    id: 'pbx.debug_drop_debug_condition',
    file: 'pbx',
    expect: 'detect',
    apply: t => removePbx(t, 'SWIFT_ACTIVE_COMPILATION_CONDITIONS', 'Debug'),
  },
  {
    id: 'pbx.device_family_universal',
    file: 'pbx',
    expect: 'detect',
    apply: t => setPbx(t, 'TARGETED_DEVICE_FAMILY', '"1,2"', 'all'),
  },
  {
    id: 'pbx.deployment_target_14',
    file: 'pbx',
    expect: 'detect',
    apply: t => setPbx(t, 'IPHONEOS_DEPLOYMENT_TARGET', '14.0', 'Release'),
  },
  {
    id: 'pbx.bundle_id_typo',
    file: 'pbx',
    expect: 'detect',
    apply: t =>
      t.replace(
        /PRODUCT_BUNDLE_IDENTIFIER = com\.picklesensei;/g,
        'PRODUCT_BUNDLE_IDENTIFIER = com.picklesensei.dev;',
      ),
  },
  {
    id: 'pbx.team_changed',
    file: 'pbx',
    expect: 'detect',
    apply: t =>
      t.replace(
        /DEVELOPMENT_TEAM = H26U6W4K6V;/g,
        'DEVELOPMENT_TEAM = ABCDE12345;',
      ),
  },
  {
    id: 'pbx.marketing_version_drift',
    file: 'pbx',
    expect: 'detect',
    apply: t => setPbx(t, 'MARKETING_VERSION', '1.1', 'Release'),
  },
  {
    id: 'pbx.drop_entitlements_release',
    file: 'pbx',
    expect: 'detect',
    apply: t => removePbx(t, 'CODE_SIGN_ENTITLEMENTS', 'Release'),
  },
  {
    id: 'pbx.bitcode_yes_release',
    file: 'pbx',
    expect: 'detect',
    apply: t => setPbx(t, 'ENABLE_BITCODE', 'YES', 'Release'),
  },
  {
    id: 'pbx.benign_comment',
    file: 'pbx',
    expect: 'benign',
    apply: t => t.replace('// !$*UTF8*$!', '// !$*UTF8*$!\n/* reviewed */'),
  },
  {
    id: 'pbx.benign_debug_onone',
    file: 'pbx',
    expect: 'benign',
    apply: t => setPbx(t, 'SWIFT_OPTIMIZATION_LEVEL', '"-Onone"', 'Debug'),
  },

  // scheme
  {
    id: 'scheme.archive_debug',
    file: 'scheme',
    expect: 'detect',
    apply: t =>
      must(
        t,
        /<ArchiveAction\s+buildConfiguration = "Release"/,
        'archive',
      ).replace(
        /(<ArchiveAction\s+buildConfiguration = )"Release"/,
        '$1"Debug"',
      ),
  },
  {
    id: 'scheme.launch_debug',
    file: 'scheme',
    expect: 'detect',
    apply: t =>
      t.replace(
        /(<LaunchAction\s+buildConfiguration = )"Release"/,
        '$1"Debug"',
      ),
  },
  {
    id: 'scheme.benign_reformat',
    file: 'scheme',
    expect: 'benign',
    apply: t => t.replace(/\n {3}/g, '\n\t'),
  },

  // AppDelegate / Podfile / fastlane / runtimeConfig
  {
    id: 'appdelegate.always_metro',
    file: 'appDelegate',
    expect: 'detect',
    apply: t =>
      must(t, /#if DEBUG/, 'ifdebug').replace(
        /#if DEBUG[\s\S]*?#endif/,
        'RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")',
      ),
  },
  {
    id: 'appdelegate.print_added',
    file: 'appDelegate',
    expect: 'detect',
    apply: t =>
      t.replace(
        'func application(',
        'func application(\n    _ debugApp: UIApplication, willFinishLaunchingWithOptions o: [UIApplication.LaunchOptionsKey: Any]?) -> Bool { print("launch \\(o ?? [:])"); return true }\n  func application(',
      ),
  },
  {
    id: 'podfile.new_arch_off',
    file: 'podfile',
    expect: 'detect',
    apply: t =>
      must(t, /RCT_NEW_ARCH_ENABLED'\] = '1'/, 'newarch').replace(
        "RCT_NEW_ARCH_ENABLED'] = '1'",
        "RCT_NEW_ARCH_ENABLED'] = '0'",
      ),
  },
  {
    id: 'podfile.catalyst_on',
    file: 'podfile',
    expect: 'detect',
    apply: t =>
      must(t, /mac_catalyst_enabled\s*=>\s*false/, 'catalyst').replace(
        /mac_catalyst_enabled\s*=>\s*false/,
        'mac_catalyst_enabled => true',
      ),
  },
  {
    id: 'fastfile.build_debug',
    file: 'fastfile',
    expect: 'detect',
    apply: t =>
      must(t, /configuration: "Release"/, 'cfg').replace(
        'configuration: "Release"',
        'configuration: "Debug"',
      ),
  },
  {
    id: 'fastfile.auto_submit',
    file: 'fastfile',
    expect: 'detect',
    apply: t =>
      must(t, /submit_for_review: false/, 'submit').replace(
        'submit_for_review: false',
        'submit_for_review: true',
      ),
  },
  {
    id: 'fastfile.external_testers',
    file: 'fastfile',
    expect: 'detect',
    apply: t =>
      must(t, /distribute_external: false/, 'ext').replace(
        'distribute_external: false',
        'distribute_external: true',
      ),
  },
  {
    id: 'runtime.ios_client_id_changed',
    file: 'runtimeConfig',
    expect: 'detect',
    apply: t =>
      must(t, /ku9j3985cijj4e636t7s7efn8r1vsu8m/, 'client').replace(
        'ku9j3985cijj4e636t7s7efn8r1vsu8m',
        'zzzz3985cijj4e636t7s7efn8r1vsu8m',
      ),
  },
  {
    id: 'runtime.app_version_drift',
    file: 'runtimeConfig',
    expect: 'detect',
    apply: t =>
      must(t, /APP_VERSION\s*=\s*'1\.0'/, 'ver').replace(
        /(APP_VERSION\s*=\s*)'1\.0'/,
        "$1'1.0.1'",
      ),
  },

  // Swift shipping code — API use vs declarations
  {
    id: 'swift.add_location_manager',
    file: 'cameraEngine',
    expect: 'detect',
    apply: t =>
      appendSwift(
        t,
        'import CoreLocation\nfinal class CourtLocator { let manager = CLLocationManager() }',
      ),
  },
  {
    id: 'swift.add_contacts',
    file: 'cameraEngine',
    expect: 'detect',
    apply: t =>
      appendSwift(t, 'import Contacts\nlet contactStore = CNContactStore()'),
  },
  {
    id: 'swift.add_photo_library_write',
    file: 'videoCapture',
    expect: 'detect',
    apply: t =>
      appendSwift(
        t,
        'func saveClip(_ url: URL) { UISaveVideoAtPathToSavedPhotosAlbum(url.path, nil, nil, nil) }',
      ),
  },
  {
    id: 'swift.add_mic_request_with_string',
    file: 'cameraEngine',
    expect: 'observe',
    apply: t =>
      appendSwift(
        t,
        'func askMic() { AVCaptureDevice.requestAccess(for: .audio) { _ in } }',
      ),
  },
  {
    id: 'swift.add_tracking',
    file: 'cameraEngine',
    expect: 'detect',
    apply: t =>
      appendSwift(
        t,
        'import AdSupport\nlet idfa = ASIdentifierManager.shared().advertisingIdentifier',
      ),
  },
  {
    id: 'swift.add_bg_task',
    file: 'guided',
    expect: 'detect',
    apply: t =>
      appendSwift(
        t,
        'let bgTask = UIApplication.shared.beginBackgroundTask(withName: "finish") {}',
      ),
  },
  {
    id: 'swift.add_remote_notifications',
    file: 'appDelegate',
    expect: 'detect',
    apply: t =>
      appendSwift(
        t,
        'extension AppDelegate { func registerPush() { UIApplication.shared.registerForRemoteNotifications() } }',
      ),
  },
  {
    id: 'swift.add_keychain_group',
    file: 'auth',
    expect: 'detect',
    apply: t =>
      appendSwift(
        t,
        'let sharedQuery: [String: Any] = [kSecAttrAccessGroup as String: "group.com.picklesensei"]',
      ),
  },
  {
    id: 'swift.add_http_literal',
    file: 'auth',
    expect: 'detect',
    apply: t =>
      appendSwift(
        t,
        'let legacyEndpoint = URL(string: "http://api.picklesensei.example/v1")!',
      ),
  },
  {
    id: 'swift.add_print',
    file: 'guided',
    expect: 'detect',
    apply: t =>
      appendSwift(t, 'func debugDump(_ s: String) { print("guided: \\(s)") }'),
  },
  {
    id: 'swift.add_nslog',
    file: 'auth',
    expect: 'detect',
    apply: t => appendSwift(t, 'func trace(_ s: String) { NSLog("%@", s) }'),
  },
  {
    id: 'swift.log_token_public',
    file: 'auth',
    expect: 'detect',
    apply: t =>
      must(t, /stage=bridge_entered/, 'stage').replace(
        'appleAuthLogger.notice("stage=bridge_entered")',
        'appleAuthLogger.notice("stage=bridge_entered token=\\(String(describing: credentialCache?.identityToken), privacy: .public)")',
      ),
  },
  {
    id: 'swift.log_email_public',
    file: 'auth',
    expect: 'detect',
    apply: t =>
      t.replace(
        'appleAuthLogger.notice("stage=bridge_entered")',
        'appleAuthLogger.notice("stage=bridge_entered email=\\(credential.email ?? "", privacy: .public)")',
      ),
  },
  {
    id: 'swift.drop_idle_timer_restore',
    file: 'guided',
    expect: 'detect',
    apply: t => {
      const re =
        /UIApplication\.shared\.isIdleTimerDisabled = (false|SessionCaptureCoordinator\.anyActive\(\))/g;
      must(t, re, 'idle');
      return t.replace(re, '_ = UIApplication.shared.isIdleTimerDisabled');
    },
  },
  {
    id: 'swift.drop_idle_timer_restore_session',
    file: 'videoCapture',
    expect: 'detect',
    apply: t => {
      const re =
        /UIApplication\.shared\.isIdleTimerDisabled = (false|SessionCaptureCoordinator\.anyActive\(\))/g;
      must(t, re, 'idle');
      return t.replace(re, '_ = UIApplication.shared.isIdleTimerDisabled');
    },
  },
  {
    id: 'swift.add_boot_time_undeclared',
    file: 'cameraEngine',
    expect: 'observe',
    apply: t =>
      appendSwift(t, 'let uptime = ProcessInfo.processInfo.systemUptime'),
  },
  {
    id: 'swift.add_disk_space',
    file: 'cameraEngine',
    expect: 'detect',
    apply: t =>
      appendSwift(
        t,
        'let free = try? URL(fileURLWithPath: NSHomeDirectory()).resourceValues(forKeys: [.volumeAvailableCapacityKey]).volumeAvailableCapacity',
      ),
  },
  {
    id: 'swift.add_active_keyboards',
    file: 'cameraEngine',
    expect: 'detect',
    apply: t => appendSwift(t, 'let modes = UITextInputMode.activeInputModes'),
  },
  {
    id: 'swift.benign_comment_print',
    file: 'guided',
    expect: 'benign',
    apply: t =>
      appendSwift(t, '// print("never compiled")\n/* NSLog("nor this") */'),
  },
  {
    id: 'swift.benign_private_interpolation',
    file: 'auth',
    expect: 'benign',
    apply: t =>
      t.replace(
        'appleAuthLogger.notice("stage=bridge_entered")',
        'appleAuthLogger.notice("stage=bridge_entered user=\\(String(describing: bundleID))")',
      ),
  },
];

// Random generators (seeded). Each returns {id, file, expect, apply}.
function randomFlipBoolean(rng, fileKey) {
  return {
    id: `rand.flip_bool.${fileKey}`,
    file: fileKey,
    expect: 'observe',
    apply: t => {
      const bools = [...t.matchAll(/<(true|false)\/>/g)];
      if (bools.length === 0) throw new Error('no booleans');
      const target = pick(rng, bools);
      const flipped = target[1] === 'true' ? '<false/>' : '<true/>';
      return `${t.slice(0, target.index)}${flipped}${t.slice(target.index + target[0].length)}`;
    },
  };
}
function randomDropTopLevelKey(rng, fileKey) {
  return {
    id: `rand.drop_key.${fileKey}`,
    file: fileKey,
    expect: 'observe',
    apply: t => {
      const keys = [...t.matchAll(/\n\t<key>([^<]+)<\/key>/g)].map(m => m[1]);
      if (keys.length === 0) throw new Error('no keys');
      const key = pick(rng, keys);
      return removePlistKey(t, key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    },
  };
}
function randomSchemeCharEdit(rng) {
  return {
    id: 'rand.url_scheme_char',
    file: 'info',
    expect: 'detect',
    apply: t => {
      const scheme =
        'com.googleusercontent.apps.278019487172-ku9j3985cijj4e636t7s7efn8r1vsu8m';
      const i = Math.floor(rng() * scheme.length);
      const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
      let c = pick(rng, alphabet.split(''));
      if (c === scheme[i]) c = c === 'a' ? 'b' : 'a';
      const mutated = `${scheme.slice(0, i)}${c}${scheme.slice(i + 1)}`;
      return must(t, new RegExp(scheme), 'scheme').replace(scheme, mutated);
    },
  };
}
function randomPbxReleaseSetting(rng) {
  const choices = [
    ['COPY_PHASE_STRIP', 'NO'],
    ['ENABLE_NS_ASSERTIONS', 'YES'],
    ['MTL_ENABLE_DEBUG_INFO', 'YES'],
    ['VALIDATE_PRODUCT', 'NO'],
    ['SWIFT_OPTIMIZATION_LEVEL', '"-Onone"'],
    ['GCC_OPTIMIZATION_LEVEL', '0'],
    ['ENABLE_TESTABILITY', 'YES'],
    ['ONLY_ACTIVE_ARCH', 'YES'],
    ['TARGETED_DEVICE_FAMILY', '"1,2"'],
    ['IPHONEOS_DEPLOYMENT_TARGET', pick(rng, ['13.0', '14.0', '16.0'])],
    ['SWIFT_ACTIVE_COMPILATION_CONDITIONS', '"$(inherited) DEBUG"'],
  ];
  const [k, v] = pick(rng, choices);
  return {
    id: `rand.pbx_release.${k}=${v}`,
    file: 'pbx',
    expect: 'detect',
    apply: t => setPbx(t, k, v, 'Release'),
  };
}
function randomCatalogue(rng) {
  return pick(rng, CATALOGUE);
}
const RANDOM_FAMILIES = [
  rng => randomFlipBoolean(rng, pick(rng, ['info', 'priv'])),
  rng => randomDropTopLevelKey(rng, pick(rng, ['info', 'info', 'ent', 'priv'])),
  randomSchemeCharEdit,
  randomPbxReleaseSetting,
  randomCatalogue,
  randomCatalogue,
];

function composeExpectation(muts) {
  if (muts.some(m => m.expect === 'detect')) return 'detect';
  if (muts.every(m => m.expect === 'benign')) return 'benign';
  return 'observe';
}

function buildCases() {
  const cases = [];
  cases.push({ id: 'baseline', seed: null, mutations: [], expect: 'benign' });
  for (const m of CATALOGUE)
    cases.push({ id: m.id, seed: null, mutations: [m], expect: m.expect });
  for (let i = 0; i < RANDOM_CASES; i += 1) {
    const caseSeed = (SEED * 1000003 + i) >>> 0;
    const rng = mulberry32(caseSeed);
    const count = 1 + Math.floor(rng() * 3);
    const muts = [];
    for (let j = 0; j < count; j += 1)
      muts.push(pick(rng, RANDOM_FAMILIES)(rng));
    cases.push({
      id: `random-${i}`,
      seed: caseSeed,
      mutations: muts,
      expect: composeExpectation(muts),
    });
  }
  return cases;
}

// ─────────────────────────── sandbox + runners ───────────────────────────

function makeSandbox(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const relPath of COPY) {
    const src = join(repoRoot, relPath);
    const dst = join(dir, relPath);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst, { recursive: true, dereference: true });
  }
}

async function runGuard(dir, script, extraArgs = []) {
  try {
    const { stdout, stderr } = await execFileP(
      'node',
      [join(dir, script), ...extraArgs],
      { cwd: dir, maxBuffer: 16 * 1024 * 1024 },
    );
    return { exit: 0, stdout, stderr };
  } catch (error) {
    const stdout = error.stdout ?? '';
    // A guard that exits non-zero without printing a FAIL row threw instead
    // of reporting; that is a harness defect, not a detection.
    const crashed =
      typeof error.code !== 'number' ||
      error.code > 1 ||
      !/^FAIL/m.test(stdout);
    return {
      exit: error.code ?? 1,
      stdout,
      stderr: error.stderr ?? '',
      crashed,
    };
  }
}

function failingLabels(stdout) {
  return stdout
    .split('\n')
    .filter(l => /^FAIL/.test(l))
    .map(l =>
      l
        .replace(/^FAIL\s+(\[[^\]]+\]\s+)?/, '')
        .split(' — ')[0]
        .trim(),
    );
}

async function runCase(c, dir) {
  makeSandbox(dir);
  const applied = [];
  for (const m of c.mutations) {
    const abs = join(dir, F[m.file]);
    const before = readFileSync(abs, 'utf8');
    let after;
    try {
      after = m.apply(before);
    } catch (error) {
      applied.push({
        id: m.id,
        file: F[m.file],
        applied: false,
        error: error.message,
      });
      continue;
    }
    writeFileSync(abs, after);
    applied.push({
      id: m.id,
      file: F[m.file],
      applied: after !== before,
      bytesDelta: after.length - before.length,
    });
  }
  const [dist, audit] = await Promise.all([
    runGuard(dir, 'apps/mobile/scripts/check-ios-distribution.mjs'),
    runGuard(dir, 'apps/mobile/tools/ios-static-review/audit.mjs'),
  ]);
  // The audit's one pre-existing failing row (stale scheme test target) is
  // present in every sandbox; count it out so detection reflects the mutation.
  const auditFails = failingLabels(audit.stdout).filter(
    l => l !== 'scheme.blueprint.PickleSenseiTests',
  );
  const distFails = failingLabels(dist.stdout);
  const detectedBy = [];
  if (distFails.length > 0 || dist.exit !== 0)
    detectedBy.push('check-ios-distribution');
  if (auditFails.length > 0) detectedBy.push('audit');
  const detected = detectedBy.length > 0;
  let verdict;
  if (c.expect === 'detect') verdict = detected ? 'killed' : 'ESCAPED';
  else if (c.expect === 'benign')
    verdict = detected ? 'FALSE_POSITIVE' : 'clean';
  else verdict = detected ? 'observed_detected' : 'observed_undetected';
  if (audit.crashed || dist.crashed) verdict = 'GUARD_CRASHED';
  return {
    caseId: c.id,
    seed: c.seed,
    expect: c.expect,
    mutations: applied,
    anyApplied: applied.some(a => a.applied),
    checkIosDistribution: { exit: dist.exit, failing: distFails },
    audit: {
      exit: audit.exit,
      failing: auditFails,
      crashed: audit.crashed ?? false,
      stderr: audit.crashed ? audit.stderr.slice(0, 2000) : undefined,
    },
    detectedBy,
    verdict,
  };
}

async function main() {
  let cases = buildCases();
  if (REPLAY) {
    cases = cases.filter(c => c.id === REPLAY);
    if (cases.length === 0) throw new Error(`no case ${REPLAY}`);
  }
  mkdirSync(WORK_DIR, { recursive: true });
  const results = new Array(cases.length);
  let next = 0;
  const started = Date.now();
  async function worker(w) {
    const dir = join(WORK_DIR, `sandbox-${w}`);
    while (next < cases.length) {
      const i = next++;
      results[i] = await runCase(cases[i], dir);
      if (i % 25 === 0)
        process.stderr.write(
          `  ${i + 1}/${cases.length} (${results[i].caseId}: ${results[i].verdict})\n`,
        );
    }
    rmSync(dir, { recursive: true, force: true });
  }
  await Promise.all(
    Array.from({ length: Math.min(WORKERS, cases.length) }, (_, w) =>
      worker(w),
    ),
  );

  const tally = {};
  for (const r of results) tally[r.verdict] = (tally[r.verdict] ?? 0) + 1;
  const escaped = results.filter(r => r.verdict === 'ESCAPED');
  const falsePositives = results.filter(r => r.verdict === 'FALSE_POSITIVE');
  const crashed = results.filter(r => r.verdict === 'GUARD_CRASHED');
  const byGuard = {
    onlyCheckIosDistribution: results.filter(
      r =>
        r.detectedBy.length === 1 &&
        r.detectedBy[0] === 'check-ios-distribution',
    ).length,
    onlyAudit: results.filter(
      r => r.detectedBy.length === 1 && r.detectedBy[0] === 'audit',
    ).length,
    both: results.filter(r => r.detectedBy.length === 2).length,
    neither: results.filter(r => r.detectedBy.length === 0).length,
  };
  const summary = {
    tool: 'ios-static-review/mutation-fuzz',
    generatedAt: new Date().toISOString(),
    seed: SEED,
    randomCases: RANDOM_CASES,
    catalogueCases: CATALOGUE.length,
    totalCases: results.length,
    durationMs: Date.now() - started,
    tally,
    byGuard,
    escaped: escaped.map(r => ({
      caseId: r.caseId,
      seed: r.seed,
      mutations: r.mutations.map(m => m.id),
    })),
    falsePositives: falsePositives.map(r => ({
      caseId: r.caseId,
      seed: r.seed,
      mutations: r.mutations.map(m => m.id),
      failing: [...r.checkIosDistribution.failing, ...r.audit.failing],
    })),
    crashed: crashed.map(r => ({
      caseId: r.caseId,
      seed: r.seed,
      stderr: r.audit.stderr,
    })),
    replay:
      'node apps/mobile/tools/ios-static-review/mutation-fuzz.mjs --replay <caseId> --seed <seed>',
    results,
  };
  if (OUT) writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ ...summary, results: undefined }, null, 2));
  const bad = escaped.length + falsePositives.length + crashed.length;
  process.exit(bad > 0 ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(2);
});
