#!/usr/bin/env node
/**
 * iOS native static review harness (Linux-runnable, no Xcode).
 *
 * Cross-checks the shipping iOS configuration against the native code that
 * actually ships in the app binary and against docs/APP_STORE_SUBMISSION.md:
 *
 *   - Info.plist usage strings  <-> privacy-sensitive API usage in shipping
 *     Swift/ObjC (both directions: declared-but-unused and used-but-undeclared)
 *   - PrivacyInfo.xcprivacy required-reason categories <-> API usage, and
 *     reason codes that Apple restricts to third-party SDKs
 *   - entitlements <-> code paths that need them
 *   - App Transport Security exceptions, background modes, URL types
 *     (reversed Google client id must match runtimeConfig.ts)
 *   - Release build settings in project.pbxproj + the shared scheme
 *   - os.Logger / print / NSLog usage and `.public` interpolations
 *   - shared-scheme target references that resolve to real targets
 *   - optional: a Mac-built Info.plist (binary) decoded via python3 plistlib
 *     and diffed against the source plist (`--mac-info-plist <path>`)
 *
 * Every row carries `file:line` evidence. Exit code 1 when any row fails.
 *
 * Usage:
 *   node tools/ios-static-review/audit.mjs [--json <out.json>] \
 *        [--mac-info-plist <PickleSensei-Info.plist>]
 *
 * This script only reads files. It never claims Apple runtime behaviour:
 * rows derived from source are labelled `INFERRED`, rows derived from a Mac
 * artifact are labelled `VERIFIED_MAC_ARTIFACT`.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dictGet, parsePlist, toPlain } from './plist.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const mobileRoot = resolve(here, '..', '..');
const repoRoot = resolve(mobileRoot, '..', '..');

const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
const jsonOut = argValue('--json');
const macInfoPlist = argValue('--mac-info-plist');

const rows = [];
const usageMatrix = [];
const reasonMatrix = [];
const buildMatrix = [];
function row(id, category, status, detail, evidence, provenance = 'INFERRED') {
  rows.push({ id, category, status, detail, evidence, provenance });
}
const pass = (id, cat, detail, evidence, prov) =>
  row(id, cat, 'pass', detail, evidence, prov);
const fail = (id, cat, detail, evidence, prov) =>
  row(id, cat, 'fail', detail, evidence, prov);
const unknown = (id, cat, detail, evidence, prov) =>
  row(id, cat, 'unknown', detail, evidence, prov);

function rel(p) {
  return relative(repoRoot, p).split('\\').join('/');
}

function read(absPath) {
  return readFileSync(absPath, 'utf8');
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

/** Every `file:line` where `re` matches, excluding // and /* comment lines. */
function grep(files, re, { includeComments = false } = {}) {
  const hits = [];
  for (const f of files) {
    const text = f.text;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!includeComments) {
        const trimmed = line.trim();
        if (
          trimmed.startsWith('//') ||
          trimmed.startsWith('*') ||
          trimmed.startsWith('/*')
        ) {
          continue;
        }
      }
      const g = new RegExp(
        re.source,
        re.flags.includes('g') ? re.flags : `${re.flags}g`,
      );
      let m;
      while ((m = g.exec(line)) !== null) {
        hits.push({
          file: f.displayPath,
          line: i + 1,
          text: line.trim(),
          match: m[0],
        });
        if (m[0].length === 0) break;
      }
    }
  }
  return hits;
}

function fmtHits(hits, max = 6) {
  const shown = hits.slice(0, max).map(h => `${h.file}:${h.line}`);
  return hits.length > max
    ? `${shown.join(', ')} (+${hits.length - max} more)`
    : shown.join(', ');
}

// ───────────────────────────── inputs ─────────────────────────────────────

const iosRoot = join(mobileRoot, 'ios');
const paths = {
  infoPlist: join(iosRoot, 'PickleSensei', 'Info.plist'),
  entitlements: join(iosRoot, 'PickleSensei', 'PickleSensei.entitlements'),
  privacy: join(iosRoot, 'PickleSensei', 'PrivacyInfo.xcprivacy'),
  pbxproj: join(iosRoot, 'PickleSensei.xcodeproj', 'project.pbxproj'),
  scheme: join(
    iosRoot,
    'PickleSensei.xcodeproj',
    'xcshareddata',
    'xcschemes',
    'PickleSensei.xcscheme',
  ),
  podfile: join(iosRoot, 'Podfile'),
  podspec: join(iosRoot, 'LocalPods', 'PickleNative', 'PickleNative.podspec'),
  appDelegate: join(iosRoot, 'PickleSensei', 'AppDelegate.swift'),
  runtimeConfig: join(mobileRoot, 'src', 'config', 'runtimeConfig.ts'),
  dossier: join(repoRoot, 'docs', 'APP_STORE_SUBMISSION.md'),
  fastfile: join(iosRoot, 'fastlane', 'Fastfile'),
};

for (const [name, p] of Object.entries(paths)) {
  if (!existsSync(p)) {
    fail('input.exists', 'inputs', `${name} missing`, rel(p));
  }
}
if (rows.some(r => r.status === 'fail')) {
  finish();
}

function parseOrFail(id, text, path) {
  try {
    const node = parsePlist(text);
    pass(
      id,
      'inputs',
      'plist parses (no duplicate keys, well-formed)',
      rel(path),
    );
    return node;
  } catch (error) {
    fail(id, 'inputs', `plist does not parse: ${error.message}`, rel(path));
    return null;
  }
}
const infoText = read(paths.infoPlist);
const info = parseOrFail('inputs.info_plist_parses', infoText, paths.infoPlist);
const entText = read(paths.entitlements);
const ent = parseOrFail(
  'inputs.entitlements_parses',
  entText,
  paths.entitlements,
);
const privText = read(paths.privacy);
const priv = parseOrFail(
  'inputs.privacy_manifest_parses',
  privText,
  paths.privacy,
);
if (!info || !ent || !priv) {
  finish();
}
const infoPlain = toPlain(info);
const entPlain = toPlain(ent);
const privPlain = toPlain(priv);
const pbx = read(paths.pbxproj);
const scheme = read(paths.scheme);
const runtimeConfig = read(paths.runtimeConfig);
const dossier = read(paths.dossier);
const appDelegate = read(paths.appDelegate);
const fastfile = read(paths.fastfile);

function infoLine(key) {
  const node = dictGet(info, key);
  return node
    ? `${rel(paths.infoPlist)}:${node.keyLine}`
    : `${rel(paths.infoPlist)} (key absent)`;
}

// Shipping native sources = app target sources + the PickleNative local pod
// (its podspec globs, symlinks resolved). Nothing else under native/ ships.
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const podspecText = read(paths.podspec);
const podspecGlobs = [...podspecText.matchAll(/"(Sources\/[^"]+)"/g)].map(
  m => m[1],
);
const podRoot = dirname(paths.podspec);
const shippingSet = new Map();
function addShipping(p) {
  const real = realpathSync(p);
  if (!shippingSet.has(real)) {
    shippingSet.set(real, {
      displayPath: rel(p),
      realPath: rel(real),
      text: read(real),
    });
  }
}
for (const p of walk(join(iosRoot, 'PickleSensei'))) {
  if (/\.(swift|m|mm|h)$/.test(p)) addShipping(p);
}
for (const glob of podspecGlobs) {
  if (glob.includes('*')) {
    const dir = join(podRoot, dirname(glob));
    const exts = /\{([^}]+)\}/.exec(glob)?.[1].split(',') ?? ['swift'];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      const st = statSync(p);
      if (st.isFile() && exts.some(e => entry.name.endsWith(`.${e}`)))
        addShipping(p);
    }
  } else {
    const p = join(podRoot, glob);
    if (existsSync(p)) addShipping(p);
    else
      fail(
        'podspec.source',
        'inputs',
        `podspec source missing: ${glob}`,
        rel(paths.podspec),
      );
  }
}
const shipping = [...shippingSet.values()];
pass(
  'inputs.shipping_sources',
  'inputs',
  `${shipping.length} shipping native source files resolved from app target + PickleNative.podspec`,
  shipping.map(f => f.displayPath).join(', '),
);

// JS sources (for URL-scheme / Linking cross-checks only).
const jsFiles = walk(join(mobileRoot, 'src'))
  .filter(p => /\.(ts|tsx)$/.test(p) && !p.includes('__tests__'))
  .map(p => ({ displayPath: rel(p), realPath: rel(p), text: read(p) }));

// ─────────────────────── 1. usage strings vs API use ──────────────────────

/**
 * Each entry: Info.plist key, the API patterns that REQUIRE it (would crash
 * or be rejected without it), and patterns that merely relate to it.
 */
const USAGE_KEYS = [
  {
    key: 'NSCameraUsageDescription',
    requiredBy:
      /AVCaptureDevice\.(requestAccess|authorizationStatus)\(for:\s*\.video\)|AVCaptureDevice\.default\((?![^)]*\.audio)|AVCaptureDeviceDiscoverySession|AVCaptureVideoDataOutput/,
    dossierClaim: /Camera \(used\)/,
  },
  {
    key: 'NSMicrophoneUsageDescription',
    requiredBy:
      /AVCaptureDevice\.(requestAccess|authorizationStatus)\(for:\s*\.audio\)|AVAudioSession[^\n]*requestRecordPermission|AVAudioRecorder|AVCaptureAudioDataOutput|\.builtInMicrophone|AVCaptureDevice\.default\(for:\s*\.audio\)|AVAudioApplication\.requestRecordPermission|\.playAndRecord|\.record\b/,
    dossierClaim: /Microphone \(declared, never requested/,
  },
  {
    key: 'NSPhotoLibraryUsageDescription',
    requiredBy:
      /PHPhotoLibrary\.(requestAuthorization|authorizationStatus)|PHAssetChangeRequest|PHAssetCreationRequest|UISaveVideoAtPathToSavedPhotosAlbum|UIImageWriteToSavedPhotosAlbum|PHAsset\.fetchAssets|PHImageManager/,
    relatedBy: /PHPickerViewController|PHPickerConfiguration/,
    dossierClaim: /Photo Library \(used, system picker\)/,
  },
  {
    key: 'NSPhotoLibraryAddUsageDescription',
    requiredBy:
      /UISaveVideoAtPathToSavedPhotosAlbum|UIImageWriteToSavedPhotosAlbum|PHAssetChangeRequest\.creationRequestFor|PHAssetCreationRequest|\.addOnly/,
  },
  {
    key: 'NSLocationWhenInUseUsageDescription',
    requiredBy: /CLLocationManager|CLGeocoder/,
  },
  {
    key: 'NSLocationAlwaysAndWhenInUseUsageDescription',
    requiredBy: /requestAlwaysAuthorization/,
  },
  {
    key: 'NSContactsUsageDescription',
    requiredBy: /CNContactStore|ABAddressBook/,
  },
  { key: 'NSCalendarsUsageDescription', requiredBy: /EKEventStore/ },
  {
    key: 'NSRemindersUsageDescription',
    requiredBy:
      /EKEventStore\(\)[^\n]*reminder|requestAccess\(to:\s*\.reminder/,
  },
  {
    key: 'NSMotionUsageDescription',
    requiredBy:
      /CMMotionManager|CMPedometer|CMMotionActivityManager|CMAltimeter/,
  },
  { key: 'NSHealthShareUsageDescription', requiredBy: /HKHealthStore/ },
  {
    key: 'NSBluetoothAlwaysUsageDescription',
    requiredBy: /CBCentralManager|CBPeripheralManager/,
  },
  {
    key: 'NSSpeechRecognitionUsageDescription',
    requiredBy: /SFSpeechRecognizer/,
  },
  {
    key: 'NSFaceIDUsageDescription',
    requiredBy:
      /LAContext\(\)[\s\S]{0,200}evaluatePolicy|\.deviceOwnerAuthenticationWithBiometrics/,
  },
  {
    key: 'NSUserTrackingUsageDescription',
    requiredBy: /ATTrackingManager|ASIdentifierManager|advertisingIdentifier/,
  },
  {
    key: 'NSLocalNetworkUsageDescription',
    requiredBy: /NWBrowser|NetServiceBrowser|NWListener|Bonjour|NSNetService/,
  },
  {
    key: 'NSSiriUsageDescription',
    requiredBy: /INPreferences\.requestSiriAuthorization/,
  },
  {
    key: 'NSAppleMusicUsageDescription',
    requiredBy: /MPMediaLibrary\.requestAuthorization|SKCloudServiceController/,
  },
  { key: 'NSHomeKitUsageDescription', requiredBy: /HMHomeManager/ },
  {
    key: 'NSNFCReaderUsageDescription',
    requiredBy: /NFCNDEFReaderSession|NFCTagReaderSession/,
  },
];

const declaredUsageKeys = Object.keys(infoPlain).filter(k =>
  /^NS.*UsageDescription$/.test(k),
);
for (const spec of USAGE_KEYS) {
  const declared = Object.hasOwn(infoPlain, spec.key);
  const required = grep(shipping, spec.requiredBy);
  const related = spec.relatedBy ? grep(shipping, spec.relatedBy) : [];
  const dossierMatch = spec.dossierClaim
    ? spec.dossierClaim.test(dossier)
    : null;
  usageMatrix.push({
    key: spec.key,
    declared,
    requiredByApiHits: required.length,
    relatedApiHits: related.length,
    hits: required.map(h => `${h.file}:${h.line}`),
    related: related.map(h => `${h.file}:${h.line}`),
    dossierClaimFound: dossierMatch,
  });
  if (required.length > 0 && !declared) {
    fail(
      `usage.${spec.key}.undeclared`,
      'usage-strings',
      `${spec.key} absent from Info.plist but a requiring API is used`,
      fmtHits(required),
    );
  } else if (required.length > 0 && declared) {
    pass(
      `usage.${spec.key}.declared_and_used`,
      'usage-strings',
      `${spec.key} declared; requiring API used`,
      `${infoLine(spec.key)}; ${fmtHits(required)}`,
    );
  } else if (declared && required.length === 0) {
    // Declared but nothing in shipping code can trigger the prompt.
    const kind =
      related.length > 0
        ? 'related API only (no prompt path)'
        : 'no API path at all';
    row(
      `usage.${spec.key}.declared_unused`,
      'usage-strings',
      'info',
      `${spec.key} declared but no shipping code path can request it (${kind})`,
      `${infoLine(spec.key)}${related.length ? `; related: ${fmtHits(related)}` : ''}`,
    );
  }
  if (spec.dossierClaim) {
    (dossierMatch ? pass : fail)(
      `usage.${spec.key}.dossier`,
      'usage-strings',
      `dossier statement for ${spec.key} ${dossierMatch ? 'present' : 'MISSING'}`,
      `${rel(paths.dossier)} /${spec.dossierClaim.source}/`,
    );
  }
}
for (const k of declaredUsageKeys) {
  if (!USAGE_KEYS.some(s => s.key === k)) {
    unknown(
      `usage.${k}.unmodelled`,
      'usage-strings',
      `${k} declared; not modelled by this harness`,
      infoLine(k),
    );
  }
}

// Microphone string text vs behaviour: the string must not promise a feature
// the shipping capture path cannot deliver (docs say video only).
{
  const mic = infoPlain.NSMicrophoneUsageDescription ?? '';
  const audioInput = grep(shipping, USAGE_KEYS[1].requiredBy);
  const promisesAudio = /audio|sound|voice/i.test(mic);
  if (promisesAudio && audioInput.length === 0) {
    row(
      'usage.NSMicrophoneUsageDescription.text_vs_code',
      'usage-strings',
      'warn',
      `Microphone string describes recording court audio ("${mic}") but no shipping code adds an audio input or requests record permission`,
      `${infoLine('NSMicrophoneUsageDescription')}; dossier acknowledges at ${rel(paths.dossier)} (search "Microphone (declared, never requested")`,
    );
  } else {
    pass(
      'usage.NSMicrophoneUsageDescription.text_vs_code',
      'usage-strings',
      'microphone string consistent with code',
      infoLine('NSMicrophoneUsageDescription'),
    );
  }
}

// ───────────────── 2. PrivacyInfo required-reason APIs vs code ────────────

const REQUIRED_REASON = [
  {
    category: 'NSPrivacyAccessedAPICategoryUserDefaults',
    api: /\bUserDefaults\b|NSUserDefaults|CFPreferences/,
    appReasons: ['CA92.1', '1C8F.1', 'AC6B.1'],
    sdkOnlyReasons: ['C56D.1'],
  },
  {
    category: 'NSPrivacyAccessedAPICategoryFileTimestamp',
    api: /\.creationDate\b|\.modificationDate\b|contentModificationDateKey|creationDateKey|attributesOfItem\(atPath|fileModificationDate|\bl?f?stat\(|getattrlist|\.contentModificationDate\b/,
    appReasons: ['DDA9.1', 'C617.1', '3B52.1'],
    sdkOnlyReasons: ['0A2A.1'],
  },
  {
    category: 'NSPrivacyAccessedAPICategorySystemBootTime',
    api: /systemUptime|mach_absolute_time|mach_continuous_time|KERN_BOOTTIME/,
    appReasons: ['35F9.1', '8FFB.1', '3D61.1'],
    sdkOnlyReasons: [],
  },
  {
    category: 'NSPrivacyAccessedAPICategoryDiskSpace',
    api: /volumeAvailableCapacity|systemFreeSize|systemSize\b|\bstatfs\(|\bstatvfs\(|volumeTotalCapacity/,
    appReasons: ['85F4.1', 'E174.1', '7D9E.1', 'B728.1'],
    sdkOnlyReasons: [],
  },
  {
    category: 'NSPrivacyAccessedAPICategoryActiveKeyboards',
    api: /activeInputModes/,
    appReasons: ['3EC4.1', '54BD.1'],
    sdkOnlyReasons: [],
  },
];

const declaredApis = new Map();
const apiTypesNode = dictGet(priv, 'NSPrivacyAccessedAPITypes');
if (apiTypesNode && apiTypesNode.type === 'array') {
  for (const entry of apiTypesNode.value) {
    const cat = dictGet(entry, 'NSPrivacyAccessedAPIType');
    const reasons = dictGet(entry, 'NSPrivacyAccessedAPITypeReasons');
    if (cat && reasons) {
      declaredApis.set(cat.value, {
        line: cat.line,
        reasons: reasons.value.map(r => ({ code: r.value, line: r.line })),
      });
    }
  }
}
for (const spec of REQUIRED_REASON) {
  const hits = grep(shipping, spec.api);
  const declared = declaredApis.get(spec.category);
  reasonMatrix.push({
    category: spec.category,
    declaredReasons: declared ? declared.reasons.map(r => r.code) : [],
    appCodeHits: hits.map(h => `${h.file}:${h.line}`),
  });
  if (hits.length > 0 && !declared) {
    fail(
      `privacy.${spec.category}.undeclared`,
      'privacy-manifest',
      `${spec.category} used by shipping code but not declared`,
      fmtHits(hits),
    );
  } else if (hits.length > 0) {
    pass(
      `privacy.${spec.category}.declared`,
      'privacy-manifest',
      `${spec.category} used and declared`,
      `${rel(paths.privacy)}:${declared.line}; ${fmtHits(hits)}`,
    );
  } else if (declared) {
    // React Native core declares these three itself; the app manifest is the
    // aggregate written by `pod install`, so "declared, no app hit" is fine.
    row(
      `privacy.${spec.category}.declared_no_app_hit`,
      'privacy-manifest',
      'info',
      `${spec.category} declared; no direct hit in shipping app code (covered by React Native core / pods aggregation)`,
      `${rel(paths.privacy)}:${declared.line}`,
    );
  }
  if (declared) {
    for (const r of declared.reasons) {
      if (spec.sdkOnlyReasons.includes(r.code)) {
        row(
          `privacy.${spec.category}.${r.code}.sdk_only_reason`,
          'privacy-manifest',
          'warn',
          `${r.code} is a reason Apple restricts to third-party SDK manifests ("may only be declared by third-party SDKs"); it appears in the APP manifest (aggregated by react_native_post_install from a pod manifest, e.g. GoogleUtilities)`,
          `${rel(paths.privacy)}:${r.line}`,
        );
      } else if (!spec.appReasons.includes(r.code)) {
        fail(
          `privacy.${spec.category}.${r.code}.unknown_reason`,
          'privacy-manifest',
          `${r.code} is not a known reason for ${spec.category}`,
          `${rel(paths.privacy)}:${r.line}`,
        );
      }
    }
  }
}
for (const [cat, d] of declaredApis) {
  if (!REQUIRED_REASON.some(s => s.category === cat)) {
    fail(
      `privacy.${cat}.unknown_category`,
      'privacy-manifest',
      `unknown required-reason category`,
      `${rel(paths.privacy)}:${d.line}`,
    );
  }
}
{
  const tracking = dictGet(priv, 'NSPrivacyTracking');
  (tracking && tracking.value === false ? pass : fail)(
    'privacy.tracking_false',
    'privacy-manifest',
    'NSPrivacyTracking is false',
    `${rel(paths.privacy)}:${tracking?.keyLine ?? '?'}`,
  );
  const domains = privPlain.NSPrivacyTrackingDomains ?? [];
  (domains.length === 0 ? pass : fail)(
    'privacy.no_tracking_domains',
    'privacy-manifest',
    `NSPrivacyTrackingDomains count=${domains.length}`,
    rel(paths.privacy),
  );
  const collected = privPlain.NSPrivacyCollectedDataTypes ?? [];
  const trackingTypes = collected.filter(
    c => c.NSPrivacyCollectedDataTypeTracking === true,
  );
  (trackingTypes.length === 0 ? pass : fail)(
    'privacy.no_collected_type_tracks',
    'privacy-manifest',
    `collected data types=${collected.length}, tracking=true on ${trackingTypes.length}`,
    rel(paths.privacy),
  );
  // Provider-only entries the dossier says must NOT be duplicated into the
  // app-target manifest.
  const providerOnly = [
    'NSPrivacyCollectedDataTypePhoneNumber',
    'NSPrivacyCollectedDataTypeCoarseLocation',
    'NSPrivacyCollectedDataTypeDeviceID',
  ];
  const dup = collected.filter(c =>
    providerOnly.includes(c.NSPrivacyCollectedDataType),
  );
  (dup.length === 0 ? pass : fail)(
    'privacy.no_provider_only_types',
    'privacy-manifest',
    `provider-only data types present in app manifest: ${dup.map(d => d.NSPrivacyCollectedDataType).join(',') || 'none'}`,
    rel(paths.privacy),
  );
}

// ─────────────────────────── 3. entitlements ──────────────────────────────

const ENTITLEMENTS = [
  {
    key: 'com.apple.developer.applesignin',
    neededBy: /ASAuthorizationAppleIDProvider|ASAuthorizationAppleIDCredential/,
  },
  {
    key: 'aps-environment',
    neededBy:
      /registerForRemoteNotifications|didRegisterForRemoteNotificationsWithDeviceToken/,
  },
  {
    key: 'com.apple.developer.associated-domains',
    neededBy: /NSUserActivity\b[\s\S]{0,60}webpageURL|continue userActivity/,
  },
  {
    key: 'com.apple.security.application-groups',
    neededBy:
      /UserDefaults\(suiteName|containerURL\(forSecurityApplicationGroupIdentifier/,
  },
  { key: 'keychain-access-groups', neededBy: /kSecAttrAccessGroup/ },
  { key: 'com.apple.developer.healthkit', neededBy: /HKHealthStore/ },
  {
    key: 'com.apple.developer.in-app-payments',
    neededBy: /PKPaymentAuthorizationViewController|PKPaymentRequest/,
  },
  {
    key: 'com.apple.developer.networking.wifi-info',
    neededBy: /CNCopyCurrentNetworkInfo|NEHotspotNetwork/,
  },
];
for (const spec of ENTITLEMENTS) {
  const declared = Object.hasOwn(entPlain, spec.key);
  const hits = grep(shipping, spec.neededBy);
  if (hits.length > 0 && !declared) {
    fail(
      `entitlement.${spec.key}.missing`,
      'entitlements',
      `${spec.key} required by code but absent`,
      fmtHits(hits),
    );
  } else if (hits.length > 0) {
    pass(
      `entitlement.${spec.key}.present`,
      'entitlements',
      `${spec.key} declared and used`,
      `${rel(paths.entitlements)}:${dictGet(ent, spec.key).keyLine}; ${fmtHits(hits)}`,
    );
  } else if (declared) {
    fail(
      `entitlement.${spec.key}.unused`,
      'entitlements',
      `${spec.key} declared but nothing in shipping code needs it`,
      `${rel(paths.entitlements)}:${dictGet(ent, spec.key).keyLine}`,
    );
  }
}
for (const k of Object.keys(entPlain)) {
  if (!ENTITLEMENTS.some(s => s.key === k)) {
    unknown(
      `entitlement.${k}.unmodelled`,
      'entitlements',
      `${k} declared; not modelled`,
      `${rel(paths.entitlements)}:${dictGet(ent, k).keyLine}`,
    );
  }
}
{
  const wired = [...pbx.matchAll(/CODE_SIGN_ENTITLEMENTS = ([^;]+);/g)].map(
    m => m[1],
  );
  (wired.length >= 2 &&
    wired.every(w => w === 'PickleSensei/PickleSensei.entitlements')
    ? pass
    : fail)(
    'entitlement.wired_all_configs',
    'entitlements',
    `CODE_SIGN_ENTITLEMENTS set in ${wired.length} app configurations: ${[...new Set(wired)].join(',')}`,
    rel(paths.pbxproj),
  );
  const applesignin = entPlain['com.apple.developer.applesignin'];
  (Array.isArray(applesignin) && applesignin.includes('Default') ? pass : fail)(
    'entitlement.applesignin_default',
    'entitlements',
    'applesignin value is ["Default"]',
    rel(paths.entitlements),
  );
  (/Sign in with Apple \(`com\.apple\.developer\.applesignin`\)/.test(dossier)
    ? pass
    : fail)(
    'entitlement.dossier',
    'entitlements',
    'dossier lists Sign in with Apple entitlement',
    rel(paths.dossier),
  );
  // No entitlement key for In-App Purchase exists (capability is App-ID side);
  // check the dossier states IAP and that nothing else (push) is claimed.
  (/No push notifications entitlement/.test(dossier) &&
    !Object.hasOwn(entPlain, 'aps-environment')
    ? pass
    : fail)(
    'entitlement.no_push',
    'entitlements',
    'no aps-environment; dossier says reminders are local only',
    rel(paths.entitlements),
  );
}

// ─────────────────────────────── 4. ATS ───────────────────────────────────

{
  const ats = infoPlain.NSAppTransportSecurity ?? {};
  const atsNode = dictGet(info, 'NSAppTransportSecurity');
  const atsLine = atsNode
    ? `${rel(paths.infoPlist)}:${atsNode.keyLine}`
    : infoLine('NSAppTransportSecurity');
  (ats.NSAllowsArbitraryLoads === false ? pass : fail)(
    'ats.arbitrary_loads_false',
    'ats',
    `NSAllowsArbitraryLoads=${JSON.stringify(ats.NSAllowsArbitraryLoads)}`,
    atsLine,
  );
  (ats.NSAllowsArbitraryLoadsInWebContent !== true ? pass : fail)(
    'ats.no_arbitrary_web',
    'ats',
    `NSAllowsArbitraryLoadsInWebContent=${JSON.stringify(ats.NSAllowsArbitraryLoadsInWebContent)}`,
    atsLine,
  );
  (ats.NSAllowsArbitraryLoadsForMedia !== true ? pass : fail)(
    'ats.no_arbitrary_media',
    'ats',
    `NSAllowsArbitraryLoadsForMedia=${JSON.stringify(ats.NSAllowsArbitraryLoadsForMedia)}`,
    atsLine,
  );
  const domains = ats.NSExceptionDomains ?? {};
  const insecure = Object.entries(domains).filter(
    ([, v]) =>
      v.NSExceptionAllowsInsecureHTTPLoads === true ||
      v.NSTemporaryExceptionAllowsInsecureHTTPLoads === true,
  );
  (insecure.length === 0 ? pass : fail)(
    'ats.no_insecure_exception_domains',
    'ats',
    `exception domains=${Object.keys(domains).length}, insecure-HTTP=${insecure.map(([d]) => d).join(',') || 'none'}`,
    atsLine,
  );
  if (ats.NSAllowsLocalNetworking === true) {
    const documented = /NSAllowsLocalNetworking|local networking/i.test(
      dossier,
    );
    row(
      'ats.local_networking_exception',
      'ats',
      documented ? 'info' : 'warn',
      `NSAllowsLocalNetworking=true ships in Release (React Native template default for Metro); ${documented ? 'documented in dossier' : 'NOT mentioned in docs/APP_STORE_SUBMISSION.md'}`,
      `${rel(paths.infoPlist)}:${dictGet(atsNode, 'NSAllowsLocalNetworking')?.keyLine}`,
    );
  }
  // Every URL literal the JS or native code talks to must be https.
  const httpLiterals = grep(
    [...shipping, ...jsFiles],
    /['"`]http:\/\/(?!localhost|127\.0\.0\.1|10\.0\.2\.2)[^'"`\s]+/,
  );
  (httpLiterals.length === 0 ? pass : fail)(
    'ats.no_plain_http_literals',
    'ats',
    `plain http:// literals in shipping code: ${httpLiterals.length}`,
    httpLiterals.length
      ? fmtHits(httpLiterals)
      : `${shipping.length + jsFiles.length} files scanned`,
  );
}

// ───────────────────────── 5. background modes ────────────────────────────

{
  const bg = infoPlain.UIBackgroundModes;
  (bg === undefined ? pass : fail)(
    'background.no_modes',
    'background',
    `UIBackgroundModes=${JSON.stringify(bg)}`,
    infoLine('UIBackgroundModes'),
  );
  (/Background modes\s*\|\s*None declared/.test(dossier) ? pass : fail)(
    'background.dossier',
    'background',
    'dossier says no background modes',
    rel(paths.dossier),
  );
  const bgTask = grep(
    shipping,
    /beginBackgroundTask|BGTaskScheduler|BGAppRefreshTask|setMinimumBackgroundFetchInterval/,
  );
  (bgTask.length === 0 ? pass : fail)(
    'background.no_bg_task_apis',
    'background',
    `background task APIs used: ${bgTask.length}`,
    bgTask.length ? fmtHits(bgTask) : 'none in shipping sources',
  );
  // Camera flows must react to backgrounding (REVIEW.md: tear down on background).
  const bgObservers = grep(
    shipping,
    /didEnterBackgroundNotification|willResignActiveNotification|AVCaptureSessionWasInterrupted/,
  );
  (bgObservers.length > 0 ? pass : fail)(
    'background.camera_observers',
    'background',
    `camera/background lifecycle observers: ${bgObservers.length}`,
    fmtHits(bgObservers),
  );
  const idle = grep(shipping, /isIdleTimerDisabled = true/);
  const idleReset = grep(
    shipping,
    /isIdleTimerDisabled = (false|SessionCaptureCoordinator\.anyActive\(\))/,
  );
  const unrestored = [...new Set(idle.map(h => h.file))].filter(
    f => !idleReset.some(r => r.file === f),
  );
  (unrestored.length === 0 ? pass : fail)(
    'background.idle_timer_restored',
    'background',
    `isIdleTimerDisabled set=true at ${idle.length} sites, restored at ${idleReset.length}; files that disable without restoring: ${unrestored.join(',') || 'none'}`,
    `${fmtHits(idle)} | ${fmtHits(idleReset)}`,
  );
}

// ───────────────────────────── 6. URL types ───────────────────────────────

{
  const urlTypes = infoPlain.CFBundleURLTypes ?? [];
  const schemes = urlTypes.flatMap(t => t.CFBundleURLSchemes ?? []);
  const iosClient = /GOOGLE_IOS_CLIENT_ID(?::\s*[\w |]+)?\s*=\s*'([^']+)'/.exec(
    runtimeConfig,
  )?.[1];
  const expectedScheme = iosClient
    ? iosClient.split('.').reverse().join('.')
    : null;
  const rcLine = iosClient
    ? lineOf(runtimeConfig, runtimeConfig.indexOf('GOOGLE_IOS_CLIENT_ID'))
    : '?';
  (expectedScheme && schemes.includes(expectedScheme) ? pass : fail)(
    'url.google_reversed_client_id_matches',
    'url-types',
    `reversed iOS client id ${expectedScheme ?? '(not found in runtimeConfig)'} ${schemes.includes(expectedScheme) ? 'present' : 'ABSENT'} in CFBundleURLSchemes=${JSON.stringify(schemes)}`,
    `${infoLine('CFBundleURLTypes')}; ${rel(paths.runtimeConfig)}:${rcLine}`,
  );
  const unexpected = schemes.filter(s => s !== expectedScheme);
  (unexpected.length === 0 ? pass : fail)(
    'url.no_unexpected_schemes',
    'url-types',
    `custom URL schemes beyond the Google callback: ${JSON.stringify(unexpected)}`,
    infoLine('CFBundleURLTypes'),
  );
  (new Set(schemes).size === schemes.length ? pass : fail)(
    'url.no_duplicate_schemes',
    'url-types',
    'no duplicate schemes',
    infoLine('CFBundleURLTypes'),
  );
  // Inbound URL handling: no JS listener → no openURL delegate needed; the
  // Google SDK completes its ASWebAuthenticationSession flow itself.
  const inbound = grep(
    jsFiles,
    /Linking\.(addEventListener|getInitialURL)|useLinking|linking:\s*\{/,
  );
  const delegateOpenUrl = /open url: URL|openURL/.test(appDelegate);
  if (inbound.length > 0 && !delegateOpenUrl) {
    fail(
      'url.inbound_handler',
      'url-types',
      'JS listens for inbound URLs but AppDelegate has no openURL handler',
      fmtHits(inbound),
    );
  } else {
    pass(
      'url.inbound_handler',
      'url-types',
      `inbound JS URL listeners=${inbound.length}, AppDelegate openURL=${delegateOpenUrl}; consistent`,
      `${rel(paths.appDelegate)}; ${jsFiles.length} JS files scanned`,
    );
  }
  // canOpenURL(non-http scheme) needs LSApplicationQueriesSchemes.
  const canOpen = grep(jsFiles, /Linking\.canOpenURL\(/);
  const queries = infoPlain.LSApplicationQueriesSchemes ?? [];
  const customSchemeLiterals = grep(
    jsFiles,
    /['"`](?!https?:|mailto:|tel:|sms:|itms-apps:|itms:|app-settings:)[a-z][a-z0-9+.-]+:\/\/[^'"`]*['"`]/,
  );
  row(
    'url.can_open_url_queries',
    'url-types',
    'info',
    `Linking.canOpenURL sites=${canOpen.length}; LSApplicationQueriesSchemes=${JSON.stringify(queries)}; custom-scheme literals in JS=${customSchemeLiterals.length}`,
    `${fmtHits(canOpen)} ${customSchemeLiterals.length ? `| ${fmtHits(customSchemeLiterals)}` : ''}`,
  );
  (infoPlain.UISupportedInterfaceOrientations?.length === 1 &&
    infoPlain.UISupportedInterfaceOrientations[0] ===
      'UIInterfaceOrientationPortrait'
    ? pass
    : fail)(
    'plist.portrait_only',
    'plist',
    `UISupportedInterfaceOrientations=${JSON.stringify(infoPlain.UISupportedInterfaceOrientations)}`,
    infoLine('UISupportedInterfaceOrientations'),
  );
  (infoPlain.ITSAppUsesNonExemptEncryption === false ? pass : fail)(
    'plist.export_compliance',
    'plist',
    `ITSAppUsesNonExemptEncryption=${infoPlain.ITSAppUsesNonExemptEncryption}`,
    infoLine('ITSAppUsesNonExemptEncryption'),
  );
  (infoPlain.CFBundleDisplayName === 'Pickle Sensei' ? pass : fail)(
    'plist.display_name',
    'plist',
    `CFBundleDisplayName=${infoPlain.CFBundleDisplayName}`,
    infoLine('CFBundleDisplayName'),
  );
  (infoPlain.CFBundleShortVersionString === '$(MARKETING_VERSION)' &&
    infoPlain.CFBundleVersion === '$(CURRENT_PROJECT_VERSION)'
    ? pass
    : fail)(
    'plist.versions_from_build_settings',
    'plist',
    'version keys substitute from build settings',
    infoLine('CFBundleShortVersionString'),
  );
}

// ───────────────── 7. Release build settings (pbxproj + scheme) ───────────

function parseBuildConfigurations(text) {
  const configs = [];
  const re =
    /([0-9A-F]{24}) \/\* (\w+) \*\/ = \{\s*isa = XCBuildConfiguration;([\s\S]*?)\n\t\t\};/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, id, name, body] = m;
    const settings = {};
    const startLine = lineOf(text, m.index);
    // Line-based: a setting starts at depth-4 `KEY = ` and ends at the first
    // line that closes with `;` at depth 4 (multi-line lists end with `);`).
    const bodyLines = body.split('\n');
    let current = null;
    for (let i = 0; i < bodyLines.length; i += 1) {
      const line = bodyLines[i];
      if (current === null) {
        const start = /^\t{4}("[^"]+"|[A-Za-z0-9_]+) = (.*)$/.exec(line);
        if (!start) continue;
        current = {
          key: start[1].replace(/^"|"$/g, ''),
          value: start[2],
          line: startLine + i,
        };
        if (/;$/.test(start[2])) {
          settings[current.key] = {
            value: start[2].replace(/;$/, '').trim(),
            line: current.line,
          };
          current = null;
        }
      } else {
        current.value += `\n${line}`;
        if (/^\t{4}\);$/.test(line)) {
          settings[current.key] = {
            value: current.value.replace(/;$/, '').trim(),
            line: current.line,
          };
          current = null;
        }
      }
    }
    configs.push({ id, name, settings, line: startLine });
  }
  // Owner: which configuration list references each id.
  const listRe =
    /([0-9A-F]{24}) \/\* Build configuration list for (\w+) "([^"]+)" \*\/ = \{\s*isa = XCConfigurationList;\s*buildConfigurations = \(([\s\S]*?)\);/g;
  while ((m = listRe.exec(text)) !== null) {
    const [, , ownerKind, ownerName, ids] = m;
    for (const id of ids.match(/[0-9A-F]{24}/g) ?? []) {
      const c = configs.find(x => x.id === id);
      if (c) {
        c.ownerKind = ownerKind;
        c.ownerName = ownerName;
      }
    }
  }
  return configs;
}
const configs = parseBuildConfigurations(pbx);
const releaseConfigs = configs.filter(c => c.name === 'Release');
const debugConfigs = configs.filter(c => c.name === 'Debug');
(releaseConfigs.length === 2 && debugConfigs.length === 2 ? pass : fail)(
  'build.configs_found',
  'release-build',
  `parsed ${configs.length} build configurations: ${configs.map(c => `${c.ownerKind}/${c.ownerName}/${c.name}`).join(', ')}`,
  rel(paths.pbxproj),
);

function effective(key, name) {
  // target setting overrides project setting
  const target = configs.find(
    c => c.name === name && c.ownerKind === 'PBXNativeTarget',
  )?.settings[key];
  const project = configs.find(
    c => c.name === name && c.ownerKind === 'PBXProject',
  )?.settings[key];
  return target ?? project ?? null;
}
const RELEASE_EXPECTATIONS = [
  { key: 'COPY_PHASE_STRIP', expect: 'YES' },
  { key: 'ENABLE_NS_ASSERTIONS', expect: 'NO' },
  { key: 'MTL_ENABLE_DEBUG_INFO', expect: 'NO' },
  { key: 'VALIDATE_PRODUCT', expect: 'YES' },
  { key: 'ENABLE_TESTABILITY', expect: null, forbid: 'YES' },
  { key: 'ONLY_ACTIVE_ARCH', expect: null, forbid: 'YES' },
  { key: 'GCC_OPTIMIZATION_LEVEL', expect: null, forbid: '0' },
  { key: 'SWIFT_OPTIMIZATION_LEVEL', expect: null, forbid: '"-Onone"' },
  { key: 'ENABLE_BITCODE', expect: null, forbid: 'YES' },
  { key: 'TARGETED_DEVICE_FAMILY', expect: '1' },
  { key: 'IPHONEOS_DEPLOYMENT_TARGET', expect: '15.1' },
  { key: 'PRODUCT_BUNDLE_IDENTIFIER', expect: 'com.picklesensei' },
  { key: 'DEVELOPMENT_TEAM', expect: 'H26U6W4K6V' },
  { key: 'MARKETING_VERSION', expect: '1.0' },
  { key: 'CURRENT_PROJECT_VERSION', expect: '1' },
];
for (const e of RELEASE_EXPECTATIONS) {
  const v = effective(e.key, 'Release');
  const val = v?.value ?? '(inherited/default)';
  const ok = e.expect !== null ? val === e.expect : val !== e.forbid;
  buildMatrix.push({
    key: e.key,
    release: val,
    debug: effective(e.key, 'Debug')?.value ?? '(inherited/default)',
    ok,
  });
  (ok ? pass : fail)(
    `build.release.${e.key}`,
    'release-build',
    `Release ${e.key}=${val}${e.expect !== null ? ` (expected ${e.expect})` : ` (must not be ${e.forbid})`}`,
    v
      ? `${rel(paths.pbxproj)}:${v.line}`
      : `${rel(paths.pbxproj)} (Xcode default)`,
  );
}
{
  const relSwiftConds = releaseConfigs.map(
    c => c.settings.SWIFT_ACTIVE_COMPILATION_CONDITIONS?.value ?? '',
  );
  (relSwiftConds.every(v => !/\bDEBUG\b/.test(v)) ? pass : fail)(
    'build.release.no_swift_DEBUG_condition',
    'release-build',
    `Release SWIFT_ACTIVE_COMPILATION_CONDITIONS=${JSON.stringify(relSwiftConds)}`,
    rel(paths.pbxproj),
  );
  const relGcc = releaseConfigs.map(
    c => c.settings.GCC_PREPROCESSOR_DEFINITIONS?.value ?? '',
  );
  (relGcc.every(v => !/DEBUG=1/.test(v)) ? pass : fail)(
    'build.release.no_DEBUG_preprocessor',
    'release-build',
    `Release GCC_PREPROCESSOR_DEFINITIONS=${JSON.stringify(relGcc)}`,
    rel(paths.pbxproj),
  );
  const dbgSwift = debugConfigs.map(
    c => c.settings.SWIFT_ACTIVE_COMPILATION_CONDITIONS?.value ?? '',
  );
  (dbgSwift.some(v => /\bDEBUG\b/.test(v)) ? pass : fail)(
    'build.debug.has_DEBUG_condition',
    'release-build',
    `Debug SWIFT_ACTIVE_COMPILATION_CONDITIONS=${JSON.stringify(dbgSwift)} (AppDelegate #if DEBUG relies on it)`,
    rel(paths.pbxproj),
  );
  // AppDelegate: Release must load main.jsbundle, Debug Metro.
  (/#if DEBUG[\s\S]*?jsBundleURL\(forBundleRoot: "index"\)[\s\S]*?#else[\s\S]*?url\(forResource: "main", withExtension: "jsbundle"\)[\s\S]*?#endif/.test(
    appDelegate,
  )
    ? pass
    : fail)(
    'build.appdelegate_bundle_url',
    'release-build',
    'bundleURL(): Metro under #if DEBUG, main.jsbundle otherwise',
    `${rel(paths.appDelegate)}:${lineOf(appDelegate, appDelegate.indexOf('#if DEBUG'))}`,
  );
  (/RCTReactNativeFactory|RCTAppDelegate/.test(appDelegate) ? pass : fail)(
    'build.appdelegate_rn_factory',
    'release-build',
    'AppDelegate uses RCTReactNativeFactory (RN 0.87 new-arch entry)',
    rel(paths.appDelegate),
  );
  (/RCT_NEW_ARCH_ENABLED'\] = '1'/.test(read(paths.podfile)) ? pass : fail)(
    'build.podfile_new_arch_pinned',
    'release-build',
    "Podfile pins ENV['RCT_NEW_ARCH_ENABLED']='1'",
    rel(paths.podfile),
  );
  (/mac_catalyst_enabled\s*(?:=>|:)\s*false/.test(read(paths.podfile))
    ? pass
    : fail)(
    'build.podfile_no_catalyst',
    'release-build',
    'Podfile disables Mac Catalyst',
    rel(paths.podfile),
  );
  (/configuration: "Release"/.test(fastfile) ? pass : fail)(
    'build.fastlane_release_config',
    'release-build',
    'fastlane build lane uses Release',
    rel(paths.fastfile),
  );
}
// Scheme
{
  const action = name =>
    new RegExp(`<${name}[^>]*?buildConfiguration = "(\\w+)"`, 's').exec(
      scheme,
    )?.[1];
  const archive = action('ArchiveAction');
  const launch = action('LaunchAction');
  const test = action('TestAction');
  (archive === 'Release' ? pass : fail)(
    'scheme.archive_release',
    'release-build',
    `ArchiveAction buildConfiguration=${archive}`,
    rel(paths.scheme),
  );
  (launch === 'Release' &&
    /Xcode scheme Run configuration is Release/.test(dossier)
    ? pass
    : fail)(
    'scheme.launch_matches_dossier',
    'release-build',
    `LaunchAction buildConfiguration=${launch}; dossier requires Release for Run`,
    rel(paths.scheme),
  );
  row(
    'scheme.test_configuration',
    'release-build',
    'info',
    `TestAction buildConfiguration=${test}`,
    rel(paths.scheme),
  );
  // Every BlueprintIdentifier the scheme references must exist as a target.
  const blueprintRe =
    /BlueprintIdentifier = "([0-9A-F]{24})"[\s\S]*?BlueprintName = "([^"]+)"/g;
  let m;
  const seen = new Set();
  while ((m = blueprintRe.exec(scheme)) !== null) {
    const [, id, name] = m;
    if (seen.has(id)) continue;
    seen.add(id);
    const exists = new RegExp(
      `${id} /\\* ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\*/ = \\{\\s*isa = PBXNativeTarget;`,
    ).test(pbx);
    const line = lineOf(scheme, m.index);
    (exists ? pass : fail)(
      `scheme.blueprint.${name}`,
      'release-build',
      `scheme references target ${name} (${id}) — ${exists ? 'exists' : 'NOT FOUND in project.pbxproj'}`,
      `${rel(paths.scheme)}:${line}${exists ? '' : `; ${rel(paths.pbxproj)} has 0 occurrences of ${id}`}`,
    );
  }
}

// ───────────────────────────── 8. logging ─────────────────────────────────

{
  const printHits = grep(
    shipping,
    /(^|[^.\w])print\(|NSLog\(|debugPrint\(|os_log\(/,
  );
  (printHits.length === 0 ? pass : fail)(
    'logging.no_print_nslog',
    'logging',
    `print/NSLog/os_log call sites in shipping code: ${printHits.length}`,
    printHits.length ? fmtHits(printHits) : `${shipping.length} files scanned`,
  );
  const loggerDecls = grep(shipping, /\bLogger\(/);
  row(
    'logging.logger_instances',
    'logging',
    'info',
    `os.Logger instances: ${loggerDecls.length}`,
    fmtHits(loggerDecls),
  );
  const publicInterp = [];
  for (const f of shipping) {
    const re = /\\\(([^()]*(?:\([^()]*\))?[^()]*?),\s*privacy:\s*\.public\)/g;
    let m;
    while ((m = re.exec(f.text)) !== null) {
      publicInterp.push({
        file: f.displayPath,
        line: lineOf(f.text, m.index),
        expr: m[1].trim(),
      });
    }
  }
  const SENSITIVE =
    /identityToken|authorizationCode|email|fullName|givenName|familyName|password|secret|refreshToken|accessToken|\.user\b(?!\.isEmpty)|jwt|bearer/i;
  const leaks = publicInterp.filter(
    p => SENSITIVE.test(p.expr) && !/\.count\b|\.isEmpty\b|^!/.test(p.expr),
  );
  (leaks.length === 0 ? pass : fail)(
    'logging.no_public_sensitive_interpolation',
    'logging',
    `\\(…, privacy: .public) interpolations=${publicInterp.length}; sensitive-looking=${leaks.length}`,
    publicInterp.map(p => `${p.file}:${p.line} \\(${p.expr})`).join('; '),
  );
  // Default (redacted) interpolations of sensitive values are fine, but list them.
  const plainInterp = grep(shipping, /Logger|appleAuthLogger/).length;
  row(
    'logging.logger_call_sites',
    'logging',
    'info',
    `logger call sites: ${plainInterp}`,
    `${shipping.length} files`,
  );
  // Info.plist must not carry secrets.
  const secretLike = grep(
    [
      { displayPath: rel(paths.infoPlist), text: infoText },
      { displayPath: rel(paths.runtimeConfig), text: runtimeConfig },
    ],
    /sk_live|sk_test|-----BEGIN|eyJ[A-Za-z0-9_-]{20,}\.eyJ|service_role|SUPABASE_SERVICE_ROLE|appl_[A-Za-z0-9]{20,}[^'"]*secret/i,
    { includeComments: true },
  );
  (secretLike.length === 0 ? pass : fail)(
    'logging.no_secret_literals',
    'logging',
    `secret-looking literals in Info.plist/runtimeConfig: ${secretLike.length}`,
    secretLike.length ? fmtHits(secretLike) : 'none',
  );
}

// ───────────────── 9. dossier identity cross-check ────────────────────────

{
  const checks = [
    ['bundle id', /com\.picklesensei/],
    ['team', /H26U6W4K6V/],
    ['min iOS 15.1', /15\.1/],
    ['iPhone-only', /iPhone[- ]only/i],
    ['marketing version 1.0', /\b1\.0\b/],
  ];
  for (const [label, re] of checks) {
    (re.test(dossier) ? pass : fail)(
      `dossier.${label.replace(/\W+/g, '_')}`,
      'dossier',
      `dossier mentions ${label}`,
      rel(paths.dossier),
    );
  }
  const appVersion = /APP_VERSION\s*=\s*'([^']+)'/.exec(runtimeConfig)?.[1];
  (appVersion === effective('MARKETING_VERSION', 'Release')?.value
    ? pass
    : fail)(
    'dossier.app_version_matches_pbxproj',
    'dossier',
    `runtimeConfig APP_VERSION=${appVersion} vs MARKETING_VERSION=${effective('MARKETING_VERSION', 'Release')?.value}`,
    `${rel(paths.runtimeConfig)}; ${rel(paths.pbxproj)}`,
  );
}

// ───────────── 10. optional Mac-built Info.plist comparison ───────────────

if (macInfoPlist) {
  if (!existsSync(macInfoPlist)) {
    unknown(
      'mac.info_plist_missing',
      'mac-artifact',
      `--mac-info-plist path not found`,
      macInfoPlist,
      'UNKNOWN',
    );
  } else {
    let built = null;
    try {
      const out = execFileSync(
        'python3',
        [
          '-c',
          'import plistlib,json,sys; print(json.dumps(plistlib.load(open(sys.argv[1],"rb")), default=str))',
          macInfoPlist,
        ],
        { encoding: 'utf8' },
      );
      built = JSON.parse(out);
    } catch (error) {
      unknown(
        'mac.info_plist_decode',
        'mac-artifact',
        `could not decode binary plist: ${error.message}`,
        macInfoPlist,
        'UNKNOWN',
      );
    }
    if (built) {
      const prov = 'VERIFIED_MAC_ARTIFACT';
      const same = (id, label, a, b) =>
        (JSON.stringify(a) === JSON.stringify(b) ? pass : fail)(
          id,
          'mac-artifact',
          `${label}: built=${JSON.stringify(b)} source=${JSON.stringify(a)}`,
          macInfoPlist,
          prov,
        );
      same(
        'mac.usage.camera',
        'NSCameraUsageDescription',
        infoPlain.NSCameraUsageDescription,
        built.NSCameraUsageDescription,
      );
      same(
        'mac.usage.microphone',
        'NSMicrophoneUsageDescription',
        infoPlain.NSMicrophoneUsageDescription,
        built.NSMicrophoneUsageDescription,
      );
      same(
        'mac.usage.photos',
        'NSPhotoLibraryUsageDescription',
        infoPlain.NSPhotoLibraryUsageDescription,
        built.NSPhotoLibraryUsageDescription,
      );
      same(
        'mac.ats',
        'NSAppTransportSecurity',
        infoPlain.NSAppTransportSecurity,
        built.NSAppTransportSecurity,
      );
      same(
        'mac.url_types',
        'CFBundleURLTypes',
        infoPlain.CFBundleURLTypes,
        built.CFBundleURLTypes,
      );
      same(
        'mac.background_modes',
        'UIBackgroundModes',
        infoPlain.UIBackgroundModes,
        built.UIBackgroundModes,
      );
      same(
        'mac.export_compliance',
        'ITSAppUsesNonExemptEncryption',
        infoPlain.ITSAppUsesNonExemptEncryption,
        built.ITSAppUsesNonExemptEncryption,
      );
      same(
        'mac.orientations',
        'UISupportedInterfaceOrientations',
        infoPlain.UISupportedInterfaceOrientations,
        built.UISupportedInterfaceOrientations,
      );
      (built.CFBundleIdentifier === 'com.picklesensei' ? pass : fail)(
        'mac.bundle_id',
        'mac-artifact',
        `built CFBundleIdentifier=${built.CFBundleIdentifier}`,
        macInfoPlist,
        prov,
      );
      (built.CFBundleShortVersionString ===
        effective('MARKETING_VERSION', 'Release')?.value &&
        built.CFBundleVersion ===
          effective('CURRENT_PROJECT_VERSION', 'Release')?.value
        ? pass
        : fail)(
        'mac.versions_substituted',
        'mac-artifact',
        `built version=${built.CFBundleShortVersionString} (${built.CFBundleVersion})`,
        macInfoPlist,
        prov,
      );
      (JSON.stringify(built.UIDeviceFamily) === '[1]' ? pass : fail)(
        'mac.device_family_iphone',
        'mac-artifact',
        `built UIDeviceFamily=${JSON.stringify(built.UIDeviceFamily)}`,
        macInfoPlist,
        prov,
      );
      (built.MinimumOSVersion === '15.1' ? pass : fail)(
        'mac.min_os',
        'mac-artifact',
        `built MinimumOSVersion=${built.MinimumOSVersion}`,
        macInfoPlist,
        prov,
      );
      const usageInBuilt = Object.keys(built)
        .filter(k => /UsageDescription$/.test(k))
        .sort();
      same(
        'mac.usage_key_set',
        'set of *UsageDescription keys',
        declaredUsageKeys.sort(),
        usageInBuilt,
      );
    }
  }
}

// ─────────────────────────────── output ───────────────────────────────────

function finish() {
  const summary = {
    tool: 'ios-static-review/audit',
    generatedAt: new Date().toISOString(),
    repoRoot: rel(repoRoot) || '.',
    inputs: Object.fromEntries(
      Object.entries(paths).map(([k, v]) => [k, rel(v)]),
    ),
    macInfoPlist: macInfoPlist ?? null,
    counts: {
      total: rows.length,
      pass: rows.filter(r => r.status === 'pass').length,
      fail: rows.filter(r => r.status === 'fail').length,
      warn: rows.filter(r => r.status === 'warn').length,
      info: rows.filter(r => r.status === 'info').length,
      unknown: rows.filter(r => r.status === 'unknown').length,
    },
    matrices: {
      usageStrings: usageMatrix,
      requiredReasonApis: reasonMatrix,
      releaseBuildSettings: buildMatrix,
    },
    rows,
  };
  const text = JSON.stringify(summary, null, 2);
  if (jsonOut) writeFileSync(jsonOut, `${text}\n`);
  for (const r of rows) {
    const tag = {
      pass: 'ok  ',
      fail: 'FAIL',
      warn: 'WARN',
      info: 'info',
      unknown: 'UNK ',
    }[r.status];
    console.log(
      `${tag} [${r.category}] ${r.id} — ${r.detail}\n       ${r.evidence}`,
    );
  }
  console.log(
    `\n${summary.counts.pass} pass, ${summary.counts.fail} fail, ${summary.counts.warn} warn, ${summary.counts.info} info, ${summary.counts.unknown} unknown${jsonOut ? ` → ${jsonOut}` : ''}`,
  );
  process.exit(summary.counts.fail > 0 ? 1 : 0);
}

finish();
