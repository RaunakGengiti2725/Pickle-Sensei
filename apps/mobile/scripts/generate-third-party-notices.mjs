#!/usr/bin/env node
/**
 * Offline iOS notice/resource generation. This is NOT a rights certification or
 * evidence of which modules made it into a linked binary. Npm dependency closure
 * and SwiftPM pins are conservative candidates; CocoaPods facade license IDs are
 * not legal text. No runtime, Xcode project, font, or splash input is modified.
 *
 * node scripts/generate-third-party-notices.mjs --check
 * node scripts/generate-third-party-notices.mjs --generate
 * node scripts/generate-third-party-notices.mjs --write-candidate
 * node scripts/generate-third-party-notices.mjs --check-app /path/PickleSensei.app
 *
 * --generate refuses incomplete evidence. --write-candidate explicitly writes an
 * INCOMPLETE notice resource but STILL exits nonzero. --check never blesses it.
 * --check-app reads only the three named legal/privacy resources, not app config,
 * credentials, the executable, devices, or dSYMs. It also refuses incomplete
 * source coverage. No build or upload commands are invoked.
 *
 * Source maintenance only (not a build step):
 * --capture --swift-checkouts /path/SourcePackages/checkouts [--fetch-public]
 * Captures raw source texts and SHA-256 receipts in third-party-notices.sources.json.
 * --fetch-public is the ONLY network opt-in; it reads public versioned GitHub
 * licenses/NOTICE files, pins their resolved revisions, and does not install code.
 * Review source/coverage changes before accepting a new capture. Normal generation
 * never fetches, and never silently updates a receipt when a local input changes.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';
import process from 'node:process';
import console from 'node:console';

const { fetch, AbortSignal, structuredClone } = globalThis;

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const RECEIPT = 'scripts/third-party-notices.sources.json';
export const OUTPUT = 'assets/legal/ThirdPartyNotices.txt';
export const PRIVACY_DIR = 'assets/legal/SentryPrivacy.bundle';
export const SENTRY_VERSION = '9.24.0';
export const SENTRY_FRAMEWORK = `ios/Pods/sentry-xcframeworks/${SENTRY_VERSION}/Sentry.xcframework`;
export const SENTRY_PRIVACY = `${SENTRY_FRAMEWORK}/ios-arm64_arm64e/Sentry.framework/PrivacyInfo.xcprivacy`;
export const VENDOR_ARCHIVE_SHA256 =
  'c530edd27b20f7c151e73d84a34ee03474e3d5ddab65ffe9d30366f80149668a';
export const VENDOR_PRIVACY_SHA256 =
  '118b16e0e97ffe8b6f1f01b7e04f68e5da764474a4d39d2933b0eeaef3cdc0ca';
export const REFERENCE_BUNDLE_SHA256 =
  '14c8d6b14ae52e5e1619aab176dba45241ab7aae3993e770c7eb2ff85c8284f1';
export const REFERENCE_MAP_SHA256 =
  '35a80b409aa76aacc6eb4964d1d8da4ef475fed08315dd3d63a3956887522cc1';
export const REFERENCE_DEBUG_ID = '2699028f-7b2a-4383-aede-200d7b31b2f2';
const ACK =
  'ios/Pods/Target Support Files/Pods-PickleSensei/Pods-PickleSensei-acknowledgements.markdown';
const SWIFT_LOCK =
  'ios/PickleSensei.xcworkspace/xcshareddata/swiftpm/Package.resolved';
// Only these exact reviewed transitions may bridge the old JS map's lock
// binding. Its original digest stays intact; it is never current-build proof.
const SUPABASE_UNLINK_INPUTS = {
  before: '934e5fab9a5c2dbf29feb21efa14a0b6f0a01172abb4f3f94bc252c923dc9b51',
  after: 'c5ccefcb6a0670f9b299d9e9635d09da2df8744315f8cd5e826b0c8e491703ed',
};
// W11 changed only the qs lock entry and an xcode@3.0.1-scoped uuid override.
// Neither package is in the exact historical map. Any other input/version
// change must fail closed, not silently rebind old evidence to a newer build.
const HOST_TOOL_PATCH_INPUTS = [
  {
    path: 'package.json',
    sha256: '0e7c3e1a6c736ba262d99b33401ee9a1848c20ee2f9ba23b549d3f397ce42e61',
    updatedInputSha256:
      '155c0b018bfa451c6beb358e1827168c44b6b399d0c57bada40a2f0f175aa716',
  },
  {
    path: 'package-lock.json',
    sha256: 'de3de17fa6e7ec0490c25b97bdb3a8d1aa27adbc7921dd77f532e29655ed93b0',
    updatedInputSha256:
      '2294bb3f0c0a6d4794d28bce12863b8ca36b1371121ff2f1b6309fb1a194db58',
  },
];
const HOST_TOOL_PATCHES = [
  { lockPath: 'node_modules/qs', before: '6.15.3', after: '6.16.0' },
  { lockPath: 'node_modules/uuid', before: '7.0.3', after: '11.1.1' },
];
const LOCK_INPUTS = [
  'package.json',
  'package-lock.json',
  'ios/Podfile.lock',
  SWIFT_LOCK,
];
const LEGAL_FILE =
  /^_?(?:(?:un)?licen[cs]es?(?:[._-].*)?|copying(?:[._-].*)?|copyright(?:[._-].*)?|(?:third[-_ ]?party[-_ ]?)?notices?(?:[._-].*)?|ofl(?:[._-].*)?)$/i;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = values => [...values].sort(cmp);
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const readJSON = path => JSON.parse(readFileSync(path, 'utf8'));

// Explicit host-created wrapper, NOT the SDK's Info.plist or an SDK signature.
// The vendor PrivacyInfo.xcprivacy is copied byte-for-byte into this separate
// BNDL so it cannot overwrite PickleSensei.app/PrivacyInfo.xcprivacy.
export const PRIVACY_WRAPPER = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.picklesensei.resources.SentryPrivacy</string>
  <key>CFBundleName</key>
  <string>SentryPrivacy</string>
  <key>CFBundlePackageType</key>
  <string>BNDL</string>
  <key>CFBundleShortVersionString</key>
  <string>9.24.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
</dict>
</plist>
`;

// These source versions are selected by RN 0.87.1's ORIGINAL podspecs, not
// the generated prebuilt facades (which misleadingly label everything MIT).
const NATIVE_UPSTREAM = [
  [
    'pod:boost',
    '1.84.0',
    'react-native-community/boost-for-react-native',
    'v1.84.0',
  ],
  ['pod:DoubleConversion', '1.1.6', 'google/double-conversion', 'v1.1.6'],
  ['pod:fast_float', '8.0.0', 'fastfloat/fast_float', 'v8.0.0'],
  ['pod:fmt', '12.1.0', 'fmtlib/fmt', '12.1.0'],
  ['pod:glog', '0.3.5', 'google/glog', 'v0.3.5'],
  ['pod:RCT-Folly', '2024.11.18.00', 'facebook/folly', 'v2024.11.18.00'],
  ['pod:SocketRocket', '0.7.1', 'facebookincubator/SocketRocket', '0.7.1'],
  [
    'pod:hermes-engine',
    '250829098.0.17',
    'facebook/hermes',
    'hermes-v250829098.0.17',
  ],
  ['native:Sentry', SENTRY_VERSION, 'getsentry/sentry-cocoa', SENTRY_VERSION],
];
const NATIVE_IDS = new Set(NATIVE_UPSTREAM.map(([id]) => id));
const SWIFT_REQUIRED = {
  'supabase-swift': ['LICENSE'],
  'swift-asn1': ['LICENSE.txt', 'NOTICE.txt'],
  'swift-clocks': ['LICENSE'],
  'swift-concurrency-extras': ['LICENSE'],
  'swift-crypto': ['LICENSE.txt', 'NOTICE.txt'],
  'swift-http-types': ['LICENSE.txt', 'NOTICE.txt'],
  'xctest-dynamic-overlay': ['LICENSE'],
};
const POD_NPM = {
  BVLinearGradient: 'react-native-linear-gradient',
  RNGoogleSignin: '@react-native-google-signin/google-signin',
  RNKeychain: 'react-native-keychain',
  RNNotifee: 'react-native-notify-kit',
  RNPurchases: 'react-native-purchases',
  RNReanimated: 'react-native-reanimated',
  RNScreens: 'react-native-screens',
  RNSentry: '@sentry/react-native',
  RNSVG: 'react-native-svg',
  RNWorklets: 'react-native-worklets',
  'op-sqlite': '@op-engineering/op-sqlite',
  'react-native-safe-area-context': 'react-native-safe-area-context',
  'react-native-video': 'react-native-video',
  'react-native-webview': 'react-native-webview',
};

export function hasLicenseText(text) {
  // Reject SPDX identifiers, URL-only pointers, and empty/placeholder files.
  // This is a truncation/presence check, not a legal interpretation of a grant.
  const searchable = text
    .replace(/^[ \t]*(?:\/\/|\*)/gm, '')
    .replace(/\s+/g, ' ');
  return (
    text.length > 180 &&
    /permission is hereby granted|redistribution and use|terms and conditions|permission to use, copy|permission to use this software|permission is granted to anyone|disclaims copyright|free and unencumbered software released into the public domain|affirmer hereby.*waives|each contributor licenses you to do everything/i.test(
      searchable,
    )
  );
}

export function readmeLicenseSection(bytes) {
  const text = bytes.toString('utf8');
  const heading = /^(?:#{1,6}[ \t]+)?Licen[cs]e[ \t]*\r?$/im.exec(text);
  if (!heading) return null;
  const startByte = Buffer.byteLength(text.slice(0, heading.index));
  // EOF is intentional: never truncate a license's final warranty/NOTICE or
  // rewrite Markdown entities. The enclosing raw source hash is also pinned.
  const section = bytes.subarray(startByte);
  return hasLicenseText(section.toString('utf8'))
    ? { startByte, endByte: bytes.length }
    : null;
}

function legalKind(path) {
  return /(?:^|\/)(?:notice|copyright)(?:[._-]|$)/i.test(path)
    ? 'notice-text'
    : 'license-text';
}

function walkFiles(root, prefix = '') {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (['.git', 'node_modules', '.build'].includes(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory())
      files.push(...walkFiles(join(root, entry.name), rel));
    else if (entry.isFile()) files.push(rel);
    // Never follow arbitrary nested symlinks while gathering legal sources.
  }
  return sorted(files);
}

export function resolveLockedPackage(packages, from, name) {
  let at = from;
  while (true) {
    const candidate = at
      ? `${at}/node_modules/${name}`
      : `node_modules/${name}`;
    if (packages[candidate]) return candidate;
    if (!at) return null;
    const parent = posix.dirname(at);
    at = parent === '.' ? '' : parent;
  }
}

export function npmClosure(lock) {
  if (lock.lockfileVersion !== 3 || !lock.packages?.['']) {
    throw new Error('Expected npm package-lock v3 with a root package');
  }
  const queue = [''];
  const reached = new Set();
  const edges = [];
  const missing = [];
  while (queue.length) {
    const from = queue.shift();
    if (reached.has(from)) continue;
    reached.add(from);
    const pkg = lock.packages[from];
    const names = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
      // Installed peer dependencies can be runtime dependencies even if a
      // devDependency also names them. Do not use the lock's dev flag as proof.
      ...(from ? Object.keys(pkg.peerDependencies ?? {}) : []),
    ]);
    for (const name of sorted(names)) {
      const optional =
        name in (pkg.optionalDependencies ?? {}) ||
        (!Object.hasOwn(pkg.dependencies ?? {}, name) &&
          pkg.peerDependenciesMeta?.[name]?.optional === true);
      const to = resolveLockedPackage(lock.packages, from, name);
      if (to) {
        edges.push({ from, name, to, optional });
        queue.push(to);
      } else if (!optional) {
        missing.push(`${from || '(app)'} -> ${name}`);
      }
    }
  }
  reached.delete('');
  return { paths: sorted(reached), edges, missing: sorted(missing) };
}

export function parsePodVersions(text) {
  const pods = new Map();
  const section = text.split(/^DEPENDENCIES:/m)[0];
  for (const line of section.split('\n')) {
    const match = line.match(/^ {2}- "?([^\s/(]+)(?:\/[^\s(]+)? \(([^)]+)\)/);
    if (!match) continue;
    const [, name, version] = match;
    if (pods.has(name) && pods.get(name) !== version) {
      throw new Error(`Conflicting CocoaPods versions for ${name}`);
    }
    pods.set(name, version);
  }
  if (!pods.size) throw new Error('No CocoaPods versions found');
  return [...pods].sort(([a], [b]) => cmp(a, b));
}

export function fontNames(bytes) {
  // Decode the font's OWN name table. Do not rewrite a font or substitute a
  // copyright year/designer from the accompanying license file.
  const count = bytes.readUInt16BE(4);
  let nameOffset;
  for (let i = 0; i < count; i++) {
    const offset = 12 + i * 16;
    if (bytes.toString('ascii', offset, offset + 4) === 'name') {
      nameOffset = bytes.readUInt32BE(offset + 8);
    }
  }
  if (nameOffset === undefined) throw new Error('Font has no name table');
  const records = bytes.readUInt16BE(nameOffset + 2);
  const stringOffset = nameOffset + bytes.readUInt16BE(nameOffset + 4);
  const names = [];
  for (let i = 0; i < records; i++) {
    const at = nameOffset + 6 + i * 12;
    const platform = bytes.readUInt16BE(at);
    const encoding = bytes.readUInt16BE(at + 2);
    const language = bytes.readUInt16BE(at + 4);
    const nameID = bytes.readUInt16BE(at + 6);
    if (![0, 1, 3, 5, 6, 7, 8, 9, 11, 13, 14].includes(nameID)) continue;
    const length = bytes.readUInt16BE(at + 8);
    const start = stringOffset + bytes.readUInt16BE(at + 10);
    const raw = bytes.subarray(start, start + length);
    if (raw.length !== length) throw new Error('Truncated font name table');
    let text;
    if (platform === 0 || platform === 3) {
      text = Buffer.from(raw).swap16().toString('utf16le');
    } else if (platform === 1 && [...raw].every(byte => byte < 128)) {
      text = raw.toString('ascii');
    } else continue; // Do not guess an unsupported legacy character encoding.
    names.push({
      nameID,
      platform,
      encoding,
      language,
      sha256: sha256(raw),
      text,
    });
  }
  return names;
}

function component(id, name, version, role, extra = {}) {
  return { id, name, version, role, sourceIds: [], issues: [], ...extra };
}

function buildTool(name) {
  if (/^@sentry\/cli(?:-|$)/.test(name)) {
    return 'Sentry CLI is a host build/upload tool, not the MIT Sentry runtime SDK. No future-MIT conversion is assumed; redistribution of the tool needs separate review.';
  }
  if (name === 'hermes-compiler') {
    return 'Host hermesc compiler selected by RN, not the linked hermes-engine iOS runtime.';
  }
  return null;
}

function addSource(receipt, id, bytes, details) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  // TextDecoder normally strips BOMs. Preserve them, as well as CRLF/trailing
  // whitespace, by requiring an exact UTF-8 round trip.
  const rawText = bytes.toString('utf8');
  if (!Buffer.from(rawText).equals(bytes) || text.includes('\0')) {
    throw new Error(`Not a raw UTF-8 legal text: ${id}`);
  }
  const source = {
    id,
    ...details,
    sha256: sha256(bytes),
    bytes: bytes.length,
    text: rawText,
  };
  const previous = receipt.sources.find(item => item.id === id);
  if (previous && previous.sha256 !== source.sha256)
    throw new Error(`Source collision: ${id}`);
  if (!previous) receipt.sources.push(source);
  return id;
}

function addLocal(receipt, root, path, kind = legalKind(path), extra = {}) {
  return addSource(receipt, `local:${path}`, readFileSync(join(root, path)), {
    kind,
    path,
    provenance: 'installed-file',
    ...extra,
  });
}

function guard(receipt, root, path, purpose) {
  if (!receipt.guards.some(item => item.path === path)) {
    receipt.guards.push({
      path,
      sha256: sha256(readFileSync(join(root, path))),
      purpose,
    });
  }
}

function collectNpm(receipt, root, lock) {
  const closure = npmClosure(lock);
  receipt.npmClosure = closure;
  for (const missing of closure.missing)
    receipt.gaps.push(`Unresolved npm dependency edge: ${missing}`);
  for (const path of closure.paths) {
    const locked = lock.packages[path];
    const name = path.split('node_modules/').at(-1);
    const toolReason = buildTool(name);
    const item = component(
      `npm:${path}`,
      name,
      locked.version,
      toolReason ? 'build-tool-only' : 'npm-runtime-closure-candidate',
      {
        lockPath: path,
        integrity: locked.integrity ?? null,
        resolved: locked.resolved ?? null,
        declaredLicense: locked.license ?? null,
        ...(toolReason ? { roleEvidence: toolReason } : {}),
      },
    );
    receipt.components.push(item);
    if (!existsSync(join(root, path, 'package.json'))) {
      item.issues.push(
        'Locked package is not installed; no installed source license inspected',
      );
      continue;
    }
    const installed = readJSON(join(root, path, 'package.json'));
    if (installed.version !== locked.version || installed.name !== name) {
      item.issues.push(
        `Installed identity does not match lock: ${installed.name}@${installed.version}`,
      );
      continue;
    }
    guard(receipt, root, `${path}/package.json`, 'npm-installed-identity');
    for (const file of walkFiles(join(root, path)).filter(file =>
      LEGAL_FILE.test(posix.basename(file)),
    )) {
      const fullPath = `${path}/${file}`;
      item.sourceIds.push(
        addLocal(receipt, root, fullPath, legalKind(file), {
          package: name,
          version: locked.version,
          integrity: locked.integrity ?? null,
        }),
      );
    }
    // Some exact published packages put their entire license in README rather
    // than LICENSE. Capture that raw section, not a paraphrase or SPDX fallback.
    if (!sourceLicensePresent(receipt, item)) {
      for (const file of walkFiles(join(root, path)).filter(file =>
        /^readme(?:\.md|\.txt)?$/i.test(file),
      )) {
        const bytes = readFileSync(join(root, path, file));
        const section = readmeLicenseSection(bytes);
        if (!section) continue;
        const fullPath = `${path}/${file}`;
        guard(
          receipt,
          root,
          fullPath,
          'full-source-for-unmodified-license-excerpt',
        );
        item.sourceIds.push(
          addSource(
            receipt,
            `local:${fullPath}#bytes=${section.startByte}-${section.endByte}`,
            bytes.subarray(section.startByte, section.endByte),
            {
              kind: 'license-text',
              provenance: 'installed-file-excerpt',
              path: fullPath,
              package: name,
              version: locked.version,
              integrity: locked.integrity ?? null,
              sourceFileSha256: sha256(bytes),
              startByte: section.startByte,
              endByte: section.endByte,
            },
          ),
        );
      }
    }
    // Missing text remains unresolved unless an exact-version upstream source
    // is captured below. Never synthesize a generic license from the SPDX field.
  }
}

function collectPods(receipt, root) {
  const text = readFileSync(join(root, 'ios/Podfile.lock'), 'utf8');
  if (
    !readFileSync(join(root, 'ios/Pods/Manifest.lock')).equals(
      Buffer.from(text),
    )
  ) {
    receipt.gaps.push(
      'Pods/Manifest.lock differs from Podfile.lock; installed Pods are not the locked set',
    );
  }
  guard(receipt, root, 'ios/Pods/Manifest.lock', 'installed-pods-lock');
  const ackId = addLocal(receipt, root, ACK, 'generated-acknowledgements', {
    provenance: 'cocoapods-generated-text-not-complete-coverage',
  });
  guard(
    receipt,
    root,
    ACK.replace('.markdown', '.plist'),
    'generated-acknowledgements-plist',
  );
  const ack = receipt.sources.find(source => source.id === ackId).text;
  receipt.components.push(
    component(
      'generated:CocoaPods',
      'CocoaPods acknowledgements',
      text.match(/COCOAPODS: (.+)/)?.[1] ?? 'unknown',
      'generated-notices',
      {
        sourceIds: [ackId],
        roleEvidence:
          'Unmodified generated text is preserved, including its omissions. Heading presence is not evidence of a full license.',
      },
    ),
  );
  for (const [name, version] of parsePodVersions(text)) {
    const id = `pod:${name}`;
    const specPath = `ios/Pods/Local Podspecs/${name}.podspec.json`;
    const spec = existsSync(join(root, specPath))
      ? readJSON(join(root, specPath))
      : null;
    if (spec) guard(receipt, root, specPath, 'podspec-source-selection');
    const item = component(id, name, version, 'native-pod-candidate', {
      declaredLicense: spec?.license ?? null,
      generatedAcknowledgementHeading: ack.includes(`\n## ${name}\n`),
      specChecksum:
        text.match(
          new RegExp(
            `^  ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: ([a-f0-9]{40})$`,
            'm',
          ),
        )?.[1] ?? null,
    });
    receipt.components.push(item);
    if (spec && spec.version !== version)
      item.issues.push('Installed podspec version differs from lock');
    if (NATIVE_IDS.has(id)) {
      item.role = 'prebuilt-native-component-candidate';
      item.roleEvidence =
        'Needs upstream component notices; generated facade MIT metadata is not the component license.';
    } else if (name === 'PickleNative') {
      item.role = 'first-party-outside-third-party-notices';
      item.roleEvidence =
        'Local app source. No third-party license or ownership certification is inferred from the empty generated acknowledgement.';
    } else if (name === 'Yoga' && version === '0.0.0') {
      const yogaSpec =
        'node_modules/react-native/ReactCommon/yoga/Yoga.podspec';
      const original = readFileSync(join(root, yogaSpec), 'utf8');
      guard(receipt, root, yogaSpec, 'yoga-original-source-version-selection');
      if (
        !original.includes("spec.version = '0.0.0'") ||
        !original.includes('facebook/react-native.git')
      ) {
        item.issues.push('Yoga placeholder-version mapping changed');
      } else {
        item.sourceIds = [
          ...receipt.components.find(
            entry => entry.id === 'npm:node_modules/react-native',
          ).sourceIds,
        ];
        item.roleEvidence =
          'Yoga.podspec hardcodes 0.0.0 but selects the RN source tag from the installed RN package version. Its original source header points to the RN root LICENSE; the placeholder is not an upstream Yoga release number.';
      }
    } else if (POD_NPM[name]) {
      const npm = receipt.components.find(
        entry => entry.id === `npm:node_modules/${POD_NPM[name]}`,
      );
      if (npm?.version === version) item.sourceIds = [...npm.sourceIds];
      else item.issues.push('Pod/npm version mapping is unresolved');
    } else if (
      /^(?:React(?:-|$|Common|Codegen|AppDependencyProvider|NativeDependencies)|RCT(?:Deprecation|Required|SwiftUI|SwiftUIWrapper|TypeSafety)$|Yoga$|FBLazyVector$)/.test(
        name,
      )
    ) {
      const rn = receipt.components.find(
        entry => entry.id === 'npm:node_modules/react-native',
      );
      if (rn?.version === version) {
        item.sourceIds = [...rn.sourceIds];
        item.roleEvidence =
          'RN-owned component of the same locked RN version. Third-party prebuilt components are separately enumerated, not covered by this MIT mapping.';
      } else
        item.issues.push(
          'RN component version differs from installed react-native',
        );
    } else {
      const dir = `ios/Pods/${name}`;
      for (const file of walkFiles(join(root, dir)).filter(file =>
        LEGAL_FILE.test(posix.basename(file)),
      )) {
        item.sourceIds.push(
          addLocal(receipt, root, `${dir}/${file}`, legalKind(file), {
            version,
          }),
        );
      }
      if (!item.sourceIds.length)
        item.issues.push('No installed pod source license found');
    }
  }
  for (const file of walkFiles(
    join(root, 'ios/Pods/ReactNativeDependencies-artifacts'),
  )) {
    guard(
      receipt,
      root,
      `ios/Pods/ReactNativeDependencies-artifacts/${file}`,
      'prebuilt-archive-identity-not-license-coverage',
    );
  }
  for (const file of walkFiles(
    join(root, 'ios/Pods/ReactNativeCore-artifacts'),
  )) {
    guard(
      receipt,
      root,
      `ios/Pods/ReactNativeCore-artifacts/${file}`,
      'prebuilt-archive-identity-not-license-coverage',
    );
  }
  for (const file of walkFiles(
    join(root, 'ios/Pods/hermes-engine-artifacts'),
  )) {
    guard(
      receipt,
      root,
      `ios/Pods/hermes-engine-artifacts/${file}`,
      'prebuilt-archive-identity-not-license-coverage',
    );
  }
  for (const file of walkFiles(
    join(root, 'node_modules/react-native/third-party-podspecs'),
  ).filter(file => file.endsWith('.podspec'))) {
    guard(
      receipt,
      root,
      `node_modules/react-native/third-party-podspecs/${file}`,
      'original-prebuilt-component-version-selection',
    );
  }
  guard(
    receipt,
    root,
    'node_modules/react-native/scripts/cocoapods/helpers.rb',
    'original-prebuilt-component-version-selection',
  );
}

function collectSwift(receipt, root, checkouts) {
  for (const pin of readJSON(join(root, SWIFT_LOCK)).pins) {
    const item = component(
      `swiftpm:${pin.identity}`,
      pin.identity,
      pin.state.version,
      'swiftpm-pin-candidate',
      { repository: pin.location, revision: pin.state.revision },
    );
    receipt.components.push(item);
    if (!checkouts) {
      item.issues.push(
        'Source checkout required during capture; use --swift-checkouts',
      );
      continue;
    }
    const dir = join(checkouts, pin.identity);
    const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    if (head !== pin.state.revision) {
      item.issues.push(`Checkout revision mismatch: ${head}`);
      continue;
    }
    for (const path of walkFiles(dir).filter(file =>
      LEGAL_FILE.test(posix.basename(file)),
    )) {
      const bytes = readFileSync(join(dir, path));
      const committed = execFileSync(
        'git',
        ['-C', dir, 'show', `${pin.state.revision}:${path}`],
        { maxBuffer: 8 * 1024 * 1024 },
      );
      if (!bytes.equals(committed))
        throw new Error(
          `Modified SwiftPM legal source: ${pin.identity}/${path}`,
        );
      item.sourceIds.push(
        addSource(receipt, `swiftpm:${pin.identity}/${path}`, bytes, {
          kind: legalKind(path),
          provenance: 'locked-git-source',
          pathInRepository: path,
          repository: pin.location,
          revision: head,
          version: pin.state.version,
        }),
      );
    }
    if (!item.sourceIds.length)
      item.issues.push('No LICENSE/NOTICE in exact SwiftPM source');
    const manifest = readFileSync(join(dir, 'Package.swift'));
    const original = execFileSync('git', [
      '-C',
      dir,
      'show',
      `${head}:Package.swift`,
    ]);
    if (!manifest.equals(original))
      throw new Error(`Modified SwiftPM source manifest: ${pin.identity}`);
    item.packageManifestSha256 = sha256(manifest);
  }
}

async function publicBytes(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30000),
    headers: { 'User-Agent': 'PickleSensei-notice-source-capture' },
  });
  if (!response.ok)
    throw new Error(`${response.status} fetching public legal source ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function importUpstream(receipt, id, version, repository, ref) {
  const item = receipt.components.find(entry => entry.id === id);
  if (!item || item.version !== version)
    throw new Error(`Upstream mapping version mismatch: ${id}@${version}`);
  const commit = JSON.parse(
    (
      await publicBytes(
        `https://api.github.com/repos/${repository}/commits/${ref}`,
      )
    ).toString('utf8'),
  );
  const revision = commit.sha;
  if (!/^[a-f0-9]{40}$/.test(revision))
    throw new Error(`No resolved source revision for ${repository}@${ref}`);
  const tree = JSON.parse(
    (
      await publicBytes(
        `https://api.github.com/repos/${repository}/git/trees/${revision}?recursive=1`,
      )
    ).toString('utf8'),
  );
  if (tree.truncated)
    throw new Error(
      `Truncated legal source enumeration for ${repository}@${ref}`,
    );
  const paths = tree.tree
    .filter(
      entry =>
        entry.type === 'blob' && LEGAL_FILE.test(posix.basename(entry.path)),
    )
    .map(entry => entry.path);
  for (const path of sorted(paths)) {
    const url = `https://raw.githubusercontent.com/${repository}/${revision}/${path}`;
    const bytes = await publicBytes(url);
    item.sourceIds.push(
      addSource(receipt, `upstream:${repository}@${revision}/${path}`, bytes, {
        kind: legalKind(path),
        provenance: 'versioned-upstream-source',
        repository,
        version,
        requestedRef: ref,
        revision,
        pathInRepository: path,
        url,
      }),
    );
  }
  item.upstream = {
    repository,
    version,
    ref,
    revision,
    licensePaths: sorted(paths),
  };
  if (!paths.length)
    item.issues.push('Versioned upstream tree has no separate license text');
  console.log(`Captured ${id}@${version}: ${paths.join(', ')}`);
}

function reuseUpstream(receipt, previous, item) {
  const old = previous?.components.find(
    entry =>
      entry.id === item.id &&
      entry.version === item.version &&
      entry.integrity === item.integrity,
  );
  if (!old?.upstream) return false;
  const sources = old.sourceIds
    .map(id => previous.sources.find(source => source.id === id))
    .filter(
      source =>
        source?.provenance === 'versioned-upstream-source' ||
        source?.provenance === 'published-npm-git-source',
    );
  if (!sources.length) return false;
  for (const source of sources) {
    if (sha256(Buffer.from(source.text)) !== source.sha256)
      throw new Error(`Corrupt cached upstream source: ${source.id}`);
    if (!receipt.sources.some(entry => entry.id === source.id))
      receipt.sources.push(structuredClone(source));
    item.sourceIds.push(source.id);
  }
  item.upstream = structuredClone(old.upstream);
  return true;
}

function sourceLicensePresent(receipt, item) {
  return item.sourceIds.some(id => {
    const source = receipt.sources.find(entry => entry.id === id);
    return source?.kind === 'license-text' && hasLicenseText(source.text);
  });
}

async function importNpmSource(receipt, item, cache) {
  // Npm's publication gitHead and tarball integrity bind this upstream read to
  // the exact installed lock version, not a repository's current default branch.
  const registryURL = `https://registry.npmjs.org/${encodeURIComponent(item.name)}/${item.version}`;
  const registryBytes = await publicBytes(registryURL);
  const published = JSON.parse(registryBytes.toString('utf8'));
  if (
    published.name !== item.name ||
    published.version !== item.version ||
    published.dist?.integrity !== item.integrity
  ) {
    throw new Error(
      'Published npm identity/integrity differs from installed lock',
    );
  }
  const revision = published.gitHead;
  if (!/^[a-f0-9]{40}$/.test(revision))
    throw new Error(
      'Publication has no exact gitHead; no license is borrowed from a different version',
    );
  const repoURL =
    typeof published.repository === 'string'
      ? published.repository
      : published.repository?.url;
  const match = repoURL?.match(
    /github\.com[/:]([^/]+\/[^/#]+?)(?:\.git)?(?:#.*)?$/,
  );
  if (!match)
    throw new Error(
      'Publication has no supported public GitHub source repository',
    );
  const repository = match[1];
  const key = `${repository}@${revision}`;
  let tree = cache.get(key);
  if (!tree) {
    tree = JSON.parse(
      (
        await publicBytes(
          `https://api.github.com/repos/${repository}/git/trees/${revision}?recursive=1`,
        )
      ).toString('utf8'),
    );
    if (tree.truncated)
      throw new Error('Truncated exact-version legal source enumeration');
    cache.set(key, tree);
  }
  const directory = published.repository?.directory;
  const paths = sorted(
    tree.tree
      .filter(
        entry =>
          entry.type === 'blob' &&
          LEGAL_FILE.test(posix.basename(entry.path)) &&
          (!directory ||
            !entry.path.includes('/') ||
            entry.path.startsWith(`${directory}/`)),
      )
      .map(entry => entry.path),
  );
  for (const path of paths) {
    const id = `upstream:${key}/${path}`;
    if (!receipt.sources.some(source => source.id === id)) {
      const url = `https://raw.githubusercontent.com/${repository}/${revision}/${path}`;
      addSource(receipt, id, await publicBytes(url), {
        kind: legalKind(path),
        provenance: 'published-npm-git-source',
        repository,
        version: item.version,
        revision,
        pathInRepository: path,
        url,
      });
    }
    item.sourceIds.push(id);
  }
  item.upstream = {
    repository,
    revision,
    publishedPackage: item.name,
    publishedVersion: item.version,
    registryURL,
    registrySha256: sha256(registryBytes),
    integrity: published.dist.integrity,
    licensePaths: paths,
  };
  if (!sourceLicensePresent(receipt, item))
    throw new Error(
      'Exact-version source has no complete separate license text',
    );
  console.log(`Captured ${item.name}@${item.version}: ${paths.join(', ')}`);
}

// Read tar archives in memory ONLY for source-notice capture. Nothing from an
// upstream archive is extracted to a filesystem or executed. GNU long names and
// POSIX pax paths are supported; a truncated archive fails closed.
export function tarFiles(bytes) {
  const files = [];
  let longName;
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const string = (start, length) =>
      header.toString('utf8', start, start + length).split('\0')[0];
    const size = Number.parseInt(string(124, 12).trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0)
      throw new Error('Invalid source tar member size');
    const type = string(156, 1);
    const body = bytes.subarray(offset + 512, offset + 512 + size);
    if (body.length !== size) throw new Error('Truncated source tar member');
    const path =
      longName ?? [string(345, 155), string(0, 100)].filter(Boolean).join('/');
    longName = undefined;
    if (type === 'L') longName = body.toString('utf8').split('\0')[0];
    else if (type === 'x') {
      for (const record of body.toString('utf8').split('\n')) {
        const match = record.match(/^\d+ path=(.+)$/);
        if (match) longName = match[1];
      }
    } else if (type === '0' || type === '') files.push({ path, bytes: body });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

export function licenseCommentBlocks(text) {
  const comments = /(?:^[ \t]*\/\/[^\n]*(?:\n|$))+|\/\*[\s\S]*?\*\//gm;
  return [...text.matchAll(comments)]
    .filter(match =>
      /copyright|permission is hereby granted|redistribution and use/i.test(
        match[0],
      ),
    )
    .map(match => ({
      text: match[0],
      startByte: Buffer.byteLength(text.slice(0, match.index)),
      endByte: Buffer.byteLength(text.slice(0, match.index + match[0].length)),
    }));
}

async function importSentryInline(receipt, item) {
  const { repository, revision } = item.upstream;
  const inventory = () =>
    sorted(
      receipt.sources
        .filter(
          source =>
            source.repository === repository &&
            source.revision === revision &&
            source.startByte !== undefined,
        )
        .map(source => source.id),
    );
  if (item.upstream.inlineNoticeCapture === 'source-comment-blocks-v1') {
    item.upstream.inlineSourceIds ??= inventory();
    return;
  }
  const archiveURL = `https://codeload.github.com/${repository}/tar.gz/${revision}`;
  const archive = await publicBytes(archiveURL);
  const files = tarFiles(gunzipSync(archive));
  const inspected = [];
  for (const entry of files) {
    const path = entry.path.split('/').slice(1).join('/');
    if (
      !path.startsWith('Sources/') ||
      !/\.(?:c|cpp|h|hpp|m|mm|swift)$/.test(path)
    )
      continue;
    inspected.push(path);
    for (const block of licenseCommentBlocks(entry.bytes.toString('utf8'))) {
      // Preserve even copyright-only source notices. A root Sentry MIT label
      // does not erase the Karl Stenerud / KSCrash and other embedded notices.
      const id = `upstream:${repository}@${revision}/${path}#bytes=${block.startByte}-${block.endByte}`;
      item.sourceIds.push(
        addSource(receipt, id, Buffer.from(block.text), {
          kind: hasLicenseText(block.text) ? 'license-text' : 'notice-text',
          provenance: 'versioned-upstream-source',
          repository,
          version: item.version,
          requestedRef: item.upstream.ref,
          revision,
          pathInRepository: path,
          url: `https://raw.githubusercontent.com/${repository}/${revision}/${path}`,
          sourceFileSha256: sha256(entry.bytes),
          startByte: block.startByte,
          endByte: block.endByte,
        }),
      );
    }
  }
  if (!inspected.some(path => path.startsWith('Sources/SentryCrash/')))
    throw new Error('Sentry vendored source enumeration is empty');
  item.upstream.inlineNoticeCapture = 'source-comment-blocks-v1';
  item.upstream.inlineSourceIds = inventory();
  item.upstream.sourceArchive = {
    url: archiveURL,
    sha256: sha256(archive),
    inspectedPaths: sorted(inspected),
  };
  console.log(
    `Captured Sentry source comment notices from ${inspected.length} source files (no SDK execution).`,
  );
}

function collectFontsAndPrivacy(receipt, root) {
  for (const path of [
    ...walkFiles(join(root, 'assets/fonts')).map(
      file => `assets/fonts/${file}`,
    ),
    ...walkFiles(join(root, 'android/app/src/main/assets/fonts')).map(
      file => `android/app/src/main/assets/fonts/${file}`,
    ),
    ...walkFiles(join(root, 'assets/brand'))
      .filter(file => /splash/i.test(file))
      .map(file => `assets/brand/${file}`),
    ...walkFiles(join(root, 'ios/PickleSensei/Images.xcassets'))
      .filter(file => /splash/i.test(file))
      .map(file => `ios/PickleSensei/Images.xcassets/${file}`),
    'ios/PickleSensei/LaunchScreen.storyboard',
  ])
    guard(receipt, root, path, 'preserve-font-and-splash-input-bytes');
  const ofl = addLocal(receipt, root, 'assets/fonts/Manrope-OFL.txt');
  const fonts = [
    ...walkFiles(join(root, 'assets/fonts'))
      .filter(file => /\.ttf$/i.test(file))
      .map(file => `assets/fonts/${file}`),
    'ios/Pods/GoogleSignIn/GoogleSignIn/Sources/Resources/Roboto-Bold.ttf',
  ];
  for (const path of fonts) {
    const bytes = readFileSync(join(root, path));
    const names = fontNames(bytes);
    guard(receipt, root, path, 'preserve-font-and-splash-input-bytes');
    const version =
      names.find(name => name.nameID === 5)?.text ?? 'unresolved-font-version';
    const item = component(
      `font:${posix.basename(path)}`,
      posix.basename(path),
      version,
      'bundled-font',
      { fontPath: path, fontSha256: sha256(bytes), nameTable: names },
    );
    receipt.components.push(item);
    // The legal name records themselves are source evidence, not newly invented
    // author attributions. Retain each distinct text verbatim in its own section.
    for (const text of sorted(
      new Set(
        names
          .filter(name => [0, 7, 13, 14].includes(name.nameID))
          .map(name => name.text),
      ),
    )) {
      item.sourceIds.push(
        addSource(
          receipt,
          `font-name:${sha256(Buffer.from(text))}`,
          Buffer.from(text),
          {
            kind: 'font-embedded-notice',
            provenance: 'font-name-table-decoded-without-editing-font',
          },
        ),
      );
    }
    if (path.startsWith('assets/fonts/Manrope')) {
      item.sourceIds.push(ofl);
      const copyright = names
        .filter(name => name.nameID === 0)
        .map(name => name.text)
        .join('\n');
      const source = receipt.sources.find(entry => entry.id === ofl);
      if (
        copyright.includes('2019') &&
        source.text.includes('Copyright 2018')
      ) {
        item.roleEvidence =
          'Manrope font embeds 2019 copyright but accompanying full OFL says 2018. Both originals are retained; exact font release/license provenance remains unresolved, not silently rewritten.';
      }
    } else {
      const google = receipt.components.find(
        entry => entry.id === 'pod:GoogleSignIn',
      );
      item.sourceIds.push(...google.sourceIds);
      item.roleEvidence =
        'Roboto-Bold.ttf is distributed in locked GoogleSignIn 9.2.0 sources with its Apache LICENSE. Embedded font copyright/license records are retained as well; GoogleSignIn authors are not substituted for font authors.';
    }
  }
  guard(
    receipt,
    root,
    'node_modules/@sentry/react-native/RNSentry.podspec',
    'sentry-cocoa-version-selection',
  );
  guard(
    receipt,
    root,
    'node_modules/@sentry/react-native/scripts/sentry_utils.rb',
    'sentry-archive-expected-checksum',
  );
  const spec = readFileSync(
    join(root, 'node_modules/@sentry/react-native/RNSentry.podspec'),
    'utf8',
  );
  if (!spec.includes(`sentry_cocoa_version = '${SENTRY_VERSION}'`))
    throw new Error('Sentry Cocoa version mapping changed');
  const helper = readFileSync(
    join(root, 'node_modules/@sentry/react-native/scripts/sentry_utils.rb'),
    'utf8',
  );
  if (!helper.includes(VENDOR_ARCHIVE_SHA256))
    throw new Error('Sentry upstream expected archive checksum changed');
  const vendor = readFileSync(join(root, SENTRY_PRIVACY));
  const simulator = `${SENTRY_FRAMEWORK}/ios-arm64_x86_64-simulator/Sentry.framework/PrivacyInfo.xcprivacy`;
  if (!vendor.equals(readFileSync(join(root, simulator))))
    throw new Error(
      'Sentry iOS device and simulator vendor privacy resources differ',
    );
  guard(receipt, root, SENTRY_PRIVACY, 'vendor-privacy-resource-unmodified');
  guard(receipt, root, simulator, 'vendor-privacy-resource-unmodified');
  const infoPath = `${SENTRY_FRAMEWORK}/ios-arm64_arm64e/Sentry.framework/Info.plist`;
  const info = JSON.parse(
    execFileSync(
      'plutil',
      ['-convert', 'json', '-o', '-', join(root, infoPath)],
      { encoding: 'utf8' },
    ),
  );
  if (
    info.CFBundleShortVersionString !== SENTRY_VERSION ||
    info.CFBundleVersion !== SENTRY_VERSION
  )
    throw new Error('Downloaded Sentry framework version mismatch');
  guard(receipt, root, infoPath, 'downloaded-sdk-version');
  const privacySource = addLocal(
    receipt,
    root,
    SENTRY_PRIVACY,
    'vendor-privacy-resource',
    { version: SENTRY_VERSION },
  );
  receipt.privacyResource = {
    version: SENTRY_VERSION,
    sourceId: privacySource,
    archiveURL: `https://github.com/getsentry/sentry-cocoa/releases/download/${SENTRY_VERSION}/Sentry.xcframework.zip`,
    expectedArchiveSha256: VENDOR_ARCHIVE_SHA256,
    archiveEvidence:
      'Expected hash from locked installed RNSentry downloader; archive is no longer cached. This is NOT independent verification of the downloaded archive or SDK signature.',
    wrapper:
      'Host-created resource-only BNDL; not a vendor-signed SDK bundle. Copy only the unmodified vendor privacy resource, never the framework Info.plist or app privacy declarations.',
  };
  receipt.components.push(
    component(
      'native:Sentry',
      'Sentry Cocoa',
      SENTRY_VERSION,
      'prebuilt-native-component-candidate',
      {
        declaredLicense: 'MIT (requires actual upstream text)',
        roleEvidence:
          'Static XCFramework selected by locked @sentry/react-native 8.24.0; not @sentry/cli (FSL build tool).',
      },
    ),
  );
}

export async function capture({
  root = ROOT,
  checkouts,
  fetchPublic = false,
} = {}) {
  const receipt = {
    schemaVersion: 1,
    scope:
      'iOS locked dependency notice candidates; not a legal or linked-binary certification',
    inputs: [],
    components: [],
    sources: [],
    guards: [],
    gaps: [],
  };
  for (const path of LOCK_INPUTS)
    receipt.inputs.push({
      path,
      sha256: sha256(readFileSync(join(root, path))),
    });
  collectNpm(receipt, root, readJSON(join(root, 'package-lock.json')));
  collectPods(receipt, root);
  collectSwift(receipt, root, checkouts);
  collectFontsAndPrivacy(receipt, root);
  const previous = existsSync(join(root, RECEIPT))
    ? readJSON(join(root, RECEIPT))
    : null;
  for (const mapping of NATIVE_UPSTREAM) {
    const item = receipt.components.find(entry => entry.id === mapping[0]);
    const reused = reuseUpstream(receipt, previous, item);
    if (
      reused &&
      (item.upstream.repository !== mapping[2] ||
        item.upstream.ref !== mapping[3])
    ) {
      throw new Error(`Cached native source mapping changed: ${item.id}`);
    }
    if (!reused) {
      if (fetchPublic) await importUpstream(receipt, ...mapping);
      else
        item.issues.push(
          'Matching upstream license/NOTICE capture required (--fetch-public only during source maintenance)',
        );
    }
  }
  const sentry = receipt.components.find(item => item.id === 'native:Sentry');
  if (
    sentry.upstream &&
    (fetchPublic ||
      sentry.upstream.inlineNoticeCapture === 'source-comment-blocks-v1')
  ) {
    await importSentryInline(receipt, sentry);
  }
  if (sentry.upstream?.inlineNoticeCapture !== 'source-comment-blocks-v1') {
    sentry.issues.push(
      'Vendored SentryCrash and other inline source notices have not been captured',
    );
  }
  // A copyright-bearing source may explicitly incorporate a standard license
  // by URL. Retain that source AND the full referenced version, not just its ID.
  // This is different from guessing a license from package.json metadata.
  const apache = receipt.sources.find(
    source =>
      source.id === 'local:ios/Pods/GoogleSignIn/LICENSE' &&
      source.sha256 ===
        'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30',
  );
  if (apache) {
    for (const item of receipt.components.filter(entry =>
      entry.id.startsWith('npm:'),
    )) {
      const pointer = item.sourceIds
        .map(id => receipt.sources.find(source => source.id === id))
        .find(
          source =>
            source?.provenance === 'installed-file' &&
            /copyright/i.test(source.text) &&
            source.text.includes(
              'Licensed under the Apache License, Version 2.0',
            ) &&
            /https?:\/\/www\.apache\.org\/licenses\/LICENSE-2\.0/.test(
              source.text,
            ) &&
            !hasLicenseText(source.text),
        );
      if (pointer) {
        item.sourceIds.push(apache.id);
        item.licenseReferenceEvidence = {
          sourceId: pointer.id,
          fullTextSourceId: apache.id,
          reference:
            'Apache License, Version 2.0, explicitly incorporated by the original copyright-bearing source. Full standard text is identical to the pinned Apache-2.0 document; no Google authorship is assigned to this package.',
        };
      }
    }
  }
  const publicTrees = new Map();
  for (const item of receipt.components.filter(
    entry => entry.id.startsWith('npm:') && entry.role !== 'build-tool-only',
  )) {
    if (sourceLicensePresent(receipt, item)) continue;
    if (reuseUpstream(receipt, previous, item)) continue;
    if (fetchPublic) {
      try {
        await importNpmSource(receipt, item, publicTrees);
      } catch (error) {
        item.issues.push(`Versioned source unresolved: ${error.message}`);
      }
    } else {
      // Negative provenance evidence is still evidence. Keep the previous
      // exact-identity failure reason when recapturing offline; never turn an
      // unsuccessful public lookup into a claim that no notice is needed.
      const prior = previous?.components.find(
        entry =>
          entry.id === item.id &&
          entry.version === item.version &&
          entry.integrity === item.integrity,
      );
      item.issues.push(
        ...(prior?.issues.filter(issue =>
          issue.startsWith('Versioned source unresolved:'),
        ) ?? []),
      );
    }
  }
  if (previous?.manropeProvenance) {
    const proof = previous.manropeProvenance;
    const license = previous.sources.find(
      source => source.id === proof.sourceId,
    );
    if (license)
      recordManropeProof(receipt, { ...proof, licenseText: license.text });
  }
  if (
    previous?.artifactEvidence &&
    json(previous.inputs) === json(receipt.inputs)
  ) {
    receipt.artifactEvidence = structuredClone(previous.artifactEvidence);
    receipt.noticeMembershipArtifactId = previous.noticeMembershipArtifactId;
  }
  if (previous?.historicalSwiftPM) {
    receipt.historicalSwiftPM = structuredClone(previous.historicalSwiftPM);
    const historicalSourceIds = new Set(
      receipt.historicalSwiftPM.components.flatMap(item => item.sourceIds),
    );
    for (const source of previous.sources) {
      if (
        historicalSourceIds.has(source.id) &&
        !receipt.sources.some(item => item.id === source.id)
      )
        receipt.sources.push(structuredClone(source));
    }
  }
  receipt.components.sort((a, b) => cmp(a.id, b.id));
  receipt.sources.sort((a, b) => cmp(a.id, b.id));
  receipt.guards.sort((a, b) => cmp(a.path, b.path));
  for (const item of receipt.components)
    item.sourceIds = sorted(new Set(item.sourceIds));
  receipt.gaps.sort(cmp);
  return receipt;
}

export function dependencyPath(receipt, target) {
  const queue = [['']];
  const visited = new Set();
  while (queue.length) {
    const path = queue.shift();
    const from = path.at(-1);
    if (from === target) return path.map(value => value || '(app)');
    if (visited.has(from)) continue;
    visited.add(from);
    for (const edge of [...receipt.npmClosure.edges]
      .filter(edge => edge.from === from)
      .sort((a, b) => cmp(a.to, b.to))) {
      queue.push([...path, edge.to]);
    }
  }
  return [];
}

export function mappingSourceIndices(map) {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const indices = new Set();
  let source = 0;
  let line = 0;
  let column = 0;
  let name = 0;
  for (const mappedLine of map.mappings.split(';')) {
    let generatedColumn = 0;
    for (const segment of mappedLine.split(',')) {
      if (!segment) continue;
      const fields = [];
      let value = 0;
      let shift = 0;
      for (const character of segment) {
        const digit = alphabet.indexOf(character);
        if (digit < 0 || shift > 50)
          throw new Error('Invalid source-map VLQ mapping');
        value += (digit & 31) * 2 ** shift;
        if (!Number.isSafeInteger(value))
          throw new Error('Source-map VLQ value exceeds safe integer range');
        if (digit & 32) shift += 5;
        else {
          fields.push(Math.floor(value / 2) * (value % 2 ? -1 : 1));
          value = 0;
          shift = 0;
        }
      }
      if (shift || ![1, 4, 5].includes(fields.length))
        throw new Error('Truncated source-map mapping segment');
      generatedColumn += fields[0];
      if (generatedColumn < 0)
        throw new Error('Invalid generated mapping column');
      if (fields.length > 1) {
        source += fields[1];
        line += fields[2];
        column += fields[3];
        if (
          source < 0 ||
          source >= map.sources.length ||
          line < 0 ||
          column < 0
        )
          throw new Error('Source-map mapping refers outside its source table');
        indices.add(source);
        if (fields.length === 5) {
          name += fields[4];
          if (!Array.isArray(map.names) || name < 0 || name >= map.names.length)
            throw new Error('Source-map mapping refers outside its name table');
        }
      }
    }
  }
  if (!indices.size)
    throw new Error('Source map has no source-bearing mappings');
  return [...indices].sort((a, b) => a - b);
}

export function mapMembership(receipt, map) {
  if (
    map.version !== 3 ||
    !Array.isArray(map.sources) ||
    !map.sources.length ||
    typeof map.mappings !== 'string' ||
    !map.mappings.length ||
    map.sections
  ) {
    throw new Error(
      'Expected a complete, flattened Metro/Hermes v3 source map',
    );
  }
  const packages = receipt.components
    .filter(item => item.id.startsWith('npm:'))
    .sort(
      (a, b) =>
        b.lockPath.length - a.lockPath.length || cmp(a.lockPath, b.lockPath),
    );
  const sourcePaths = map.sources.map(source => {
    if (typeof source !== 'string' || !source)
      throw new Error('Source map contains an empty or non-string source');
    return source
      .replaceAll('\\', '/')
      .replace(/^file:\/\//, '')
      .replace(/[?#].*$/, '');
  });
  const roots = sorted(
    new Set(
      sourcePaths
        .filter(path => path.includes('/node_modules/'))
        .map(path => path.slice(0, path.indexOf('/node_modules/'))),
    ),
  );
  const members = new Map();
  const unknown = [];
  const normalized = [];
  for (const path of sourcePaths) {
    const marker = path.indexOf('node_modules/');
    if (marker >= 0) {
      const local = path.slice(marker);
      if (local.split('/').includes('..'))
        throw new Error('Unsafe source map package path');
      const pkg = packages.find(item => local.startsWith(`${item.lockPath}/`));
      if (!pkg) unknown.push(local);
      else {
        const sources = members.get(pkg.lockPath) ?? [];
        sources.push(local);
        members.set(pkg.lockPath, sources);
      }
      normalized.push(local);
      continue;
    }
    const root = roots.find(root => path.startsWith(`${root}/`));
    const workspace = roots
      .map(root => posix.resolve(root, '../..'))
      .find(root => path.startsWith(`${root}/packages/`));
    if (root) normalized.push(`app:${path.slice(root.length + 1)}`);
    else if (workspace)
      normalized.push(`workspace:${path.slice(workspace.length + 1)}`);
    else if (/^(?:__prelude__|__debugid__|prelude|sentry-debug-id)$/.test(path))
      normalized.push(`generated:${path}`);
    else if (!path.startsWith('/') && !path.split('/').includes('..'))
      normalized.push(`app:${path}`);
    else
      unknown.push(
        path.replace(/^.*\/(?:apps\/mobile|packages)\//, 'unrecognized:/'),
      );
  }
  return {
    sourceCount: map.sources.length,
    normalizedSources: sorted(new Set(normalized)),
    npmMembers: [...members]
      .sort(([a], [b]) => cmp(a, b))
      .map(([path, sources]) => ({
        path,
        version: packages.find(item => item.lockPath === path).version,
        sources: sorted(new Set(sources)),
      })),
    unknownSources: sorted(new Set(unknown)),
  };
}

export function inspectArtifact(
  receipt,
  mapBytes,
  bundleBytes,
  expectedBundleSha256,
) {
  if (
    !/^[a-f0-9]{64}$/.test(expectedBundleSha256 ?? '') ||
    sha256(bundleBytes) !== expectedBundleSha256
  ) {
    throw new Error(
      'Explicit expected bundle SHA-256 does not match the supplied artifact',
    );
  }
  const map = JSON.parse(mapBytes.toString('utf8'));
  const membership = mapMembership(receipt, map);
  const mappedIndices = mappingSourceIndices(map);
  const debugIDs = sorted(
    new Set(
      [map.debugId, map.debug_id].filter(
        value => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value),
      ),
    ),
  );
  return {
    schemaVersion: 1,
    bundle: {
      name: 'main.jsbundle',
      sha256: sha256(bundleBytes),
      bytes: bundleBytes.length,
      magic: bundleBytes.subarray(0, 8).toString('hex'),
      hermesVersion:
        bundleBytes.length >= 12 ? bundleBytes.readUInt32LE(8) : null,
    },
    sourceMap: {
      sha256: sha256(mapBytes),
      bytes: mapBytes.length,
      version: map.version,
      debugIDs,
      debugIDsInBundle: debugIDs.filter(id =>
        bundleBytes.includes(Buffer.from(id)),
      ),
      metadataKeys: sorted(Object.keys(map)),
      mappedSourceCount: mappedIndices.length,
      sourcesContentCount: Array.isArray(map.sourcesContent)
        ? map.sourcesContent.length
        : null,
      sourcesSha256: sha256(Buffer.from(json(membership.normalizedSources))),
    },
    ...membership,
    unresolvedPackages: receipt.components
      .filter(
        item =>
          item.id.startsWith('npm:') &&
          item.role !== 'build-tool-only' &&
          !sourceLicensePresent(receipt, item),
      )
      .map(item => ({
        id: item.id,
        version: item.version,
        observed: membership.npmMembers.some(
          member => member.path === item.lockPath,
        ),
        dependencyPath: dependencyPath(receipt, item.lockPath),
        directParents: sorted(
          new Set(
            receipt.npmClosure.edges
              .filter(edge => edge.to === item.lockPath)
              .map(edge => edge.from),
          ),
        ),
      })),
  };
}

export async function inspectManrope(receipt) {
  const repository = 'expo/google-fonts';
  const version = '0.4.2';
  const revision = '7d9999db538bec7b0ab13cbc33a5530f6ae1a859';
  const base = `https://raw.githubusercontent.com/${repository}/${revision}/font-packages/manrope`;
  const packageBytes = await publicBytes(`${base}/package.json`);
  const packageInfo = JSON.parse(packageBytes.toString('utf8'));
  if (
    packageInfo.name !== '@expo-google-fonts/manrope' ||
    packageInfo.version !== version
  )
    throw new Error('Manrope publisher version mismatch');
  const license = await publicBytes(`${base}/LICENSE_FONT`);
  const metadataBytes = await publicBytes(`${base}/metadata.json`);
  const metadata = JSON.parse(metadataBytes.toString('utf8'));
  const fonts = [];
  for (const item of receipt.components.filter(item =>
    item.id.startsWith('font:Manrope_'),
  )) {
    const weight = item.name.slice('Manrope_'.length, -'.ttf'.length);
    const url = `${base}/${weight}/${item.name}`;
    const bytes = await publicBytes(url);
    const googleURL =
      metadata.files[weight === '400Regular' ? 'regular' : weight.slice(0, 3)];
    const googleBytes = await publicBytes(googleURL);
    fonts.push({
      name: item.name,
      version: fontNames(bytes).find(name => name.nameID === 5)?.text,
      url,
      googleURL,
      sha256: sha256(bytes),
      googleSha256: sha256(googleBytes),
      installedSha256: item.fontSha256,
      matches:
        sha256(bytes) === item.fontSha256 &&
        sha256(googleBytes) === item.fontSha256,
    });
  }
  return {
    repository,
    version,
    revision,
    packageURL: `${base}/package.json`,
    packageSha256: sha256(packageBytes),
    metadataURL: `${base}/metadata.json`,
    metadataSha256: sha256(metadataBytes),
    googleVersion: metadata.version,
    packageText: packageBytes.toString('utf8'),
    metadataText: metadataBytes.toString('utf8'),
    licenseURL: `${base}/LICENSE_FONT`,
    licenseSha256: sha256(license),
    licenseText: license.toString('utf8'),
    fonts,
  };
}

function evidenceDigest(value) {
  const body = { ...value };
  delete body.evidenceSha256;
  return sha256(Buffer.from(json(body)));
}

export function recordManropeProof(receipt, proof) {
  if (
    proof.fonts.length !== 4 ||
    proof.fonts.some(font => !font.matches || font.version !== 'Version 4.504')
  ) {
    throw new Error(
      'Manrope release fonts are not byte-identical to the protected app fonts',
    );
  }
  const original = receipt.sources.find(
    source => source.id === 'local:assets/fonts/Manrope-OFL.txt',
  );
  if (
    original.sha256 !== proof.licenseSha256 ||
    sha256(Buffer.from(proof.licenseText)) !== proof.licenseSha256
  ) {
    throw new Error(
      'Manrope publisher LICENSE_FONT differs from the original accompanying OFL',
    );
  }
  const sourceId = addSource(
    receipt,
    `upstream:${proof.repository}@${proof.revision}/font-packages/manrope/LICENSE_FONT`,
    Buffer.from(proof.licenseText),
    {
      kind: 'license-text',
      provenance: 'versioned-font-release',
      repository: proof.repository,
      version: '4.504',
      publisherPackage: '@expo-google-fonts/manrope',
      publisherVersion: proof.version,
      revision: proof.revision,
      pathInRepository: 'font-packages/manrope/LICENSE_FONT',
      url: proof.licenseURL,
    },
  );
  const details = { ...proof };
  delete details.licenseText;
  receipt.manropeProvenance = {
    ...details,
    sourceId,
    interpretation:
      'The exact Expo 0.4.2 / Google Fonts v20 binaries co-distribute the 2018 OFL and embed the 2019 copyright. Both original texts remain intact; no font, attribution, license year or reserved font name is rewritten.',
  };
  receipt.manropeProvenance.evidenceSha256 = evidenceDigest(
    receipt.manropeProvenance,
  );
  for (const item of receipt.components.filter(item =>
    item.id.startsWith('font:Manrope_'),
  )) {
    item.sourceIds = sorted(new Set([...item.sourceIds, sourceId]));
    item.roleEvidence = receipt.manropeProvenance.interpretation;
  }
  receipt.sources.sort((a, b) => cmp(a.id, b.id));
}

export function fontProvenanceProblems(receipt, item) {
  if (!item.id.startsWith('font:Manrope_')) return [];
  const proof = receipt.manropeProvenance;
  const source = receipt.sources.find(source => source.id === proof?.sourceId);
  const font = proof?.fonts?.find(font => font.name === item.name);
  if (
    !proof ||
    evidenceDigest(proof) !== proof.evidenceSha256 ||
    proof.repository !== 'expo/google-fonts' ||
    proof.version !== '0.4.2' ||
    proof.revision !== '7d9999db538bec7b0ab13cbc33a5530f6ae1a859' ||
    proof.googleVersion !== 'v20' ||
    source?.version !== '4.504' ||
    source.publisherPackage !== '@expo-google-fonts/manrope' ||
    source.publisherVersion !== proof.version ||
    source.repository !== proof.repository ||
    source.revision !== proof.revision ||
    source.url !== proof.licenseURL ||
    source.sha256 !== proof.licenseSha256 ||
    proof.licenseSha256 !==
      'e01b637272e0cbdfb240184dd98ea5cc671556d9894dae2668d92ab2c906787c' ||
    !item.sourceIds.includes(proof.sourceId) ||
    !item.sourceIds.includes('local:assets/fonts/Manrope-OFL.txt') ||
    font?.version !== item.version ||
    font.sha256 !== item.fontSha256 ||
    font.googleSha256 !== item.fontSha256 ||
    font.installedSha256 !== item.fontSha256 ||
    !font.url.includes(`/${proof.revision}/`) ||
    !font.googleURL.startsWith('https://fonts.gstatic.com/s/manrope/v20/') ||
    sha256(Buffer.from(proof.packageText ?? '')) !== proof.packageSha256 ||
    sha256(Buffer.from(proof.metadataText ?? '')) !== proof.metadataSha256
  ) {
    return [
      `${item.id}: exact font-release license correspondence is missing or changed; 2018/2019 originals must remain intact`,
    ];
  }
  const pkg = JSON.parse(proof.packageText);
  const metadata = JSON.parse(proof.metadataText);
  const weight = item.name.slice('Manrope_'.length, -'.ttf'.length);
  if (
    pkg.name !== '@expo-google-fonts/manrope' ||
    pkg.version !== proof.version ||
    metadata.files[weight === '400Regular' ? 'regular' : weight.slice(0, 3)] !==
      font.googleURL
  ) {
    return [
      `${item.id}: publisher version or Google Fonts source binding changed`,
    ];
  }
  return [];
}

export function candidateArtifact(receipt) {
  return (
    receipt.artifactEvidence?.find(
      artifact => artifact.id === receipt.noticeMembershipArtifactId,
    ) ?? null
  );
}

export function selectedNpmPaths(
  receipt,
  artifact = candidateArtifact(receipt),
) {
  return artifact
    ? new Set((artifact.npmMembers ?? []).map(member => member.path))
    : null;
}

function exclusionClassification(path) {
  if (path === 'node_modules/standard-navigation')
    return 'type-only-import-in-pinned-importer';
  if (path === 'node_modules/boolbase')
    return 'separate-svg-css-feature-not-observed';
  if (
    [
      'node_modules/ansi-fragments',
      'node_modules/bser',
      'node_modules/fb-watchman',
      'node_modules/tr46',
    ].includes(path)
  )
    return 'host-tool-chain-not-observed';
  return 'not-observed-in-this-exact-source-map';
}

function isReviewedSwiftUnlink(history) {
  return (
    history?.kind === 'historical-source-only' &&
    history.lockInput?.path === SWIFT_LOCK &&
    history.lockInput.sha256 === SUPABASE_UNLINK_INPUTS.before &&
    history.unlinkedInputSha256 === SUPABASE_UNLINK_INPUTS.after
  );
}

function isReviewedHostToolPatch(history) {
  return (
    history?.kind === 'historical-host-tool-maintenance' &&
    json(history.inputs) === json(HOST_TOOL_PATCH_INPUTS) &&
    json(history.packages) === json(HOST_TOOL_PATCHES)
  );
}

function artifactLockedInputs(receipt, artifact) {
  if (
    artifact.kind !== 'historical-reference' ||
    artifact.bundle?.sha256 !== REFERENCE_BUNDLE_SHA256 ||
    artifact.sourceMap?.sha256 !== REFERENCE_MAP_SHA256
  )
    return receipt.inputs;

  const swift = receipt.historicalSwiftPM;
  const host = receipt.historicalHostTools;
  const hostOnly =
    isReviewedHostToolPatch(host) &&
    host.packages.every(
      patch =>
        !artifact.npmMembers?.some(member => member.path === patch.lockPath),
    );
  // Reconstruct only the exact historical inputs. New/future artifact bindings
  // still use current inputs, and newly observed host tools require notices.
  return receipt.inputs.map(input => {
    if (
      isReviewedSwiftUnlink(swift) &&
      !receipt.components.some(item => item.id.startsWith('swiftpm:')) &&
      input.path === SWIFT_LOCK &&
      input.sha256 === swift.unlinkedInputSha256
    )
      return swift.lockInput;
    const previous =
      hostOnly &&
      host.inputs.find(
        entry =>
          entry.path === input.path &&
          entry.updatedInputSha256 === input.sha256,
      );
    return previous ? { path: previous.path, sha256: previous.sha256 } : input;
  });
}

export function artifactProblems(receipt, artifact) {
  if (!artifact)
    return ['No artifact-specific source-map membership evidence selected'];
  const errors = [];
  if (artifact.evidenceSha256 !== evidenceDigest(artifact))
    errors.push('Artifact evidence digest mismatch');
  if (!['historical-reference', 'current-build'].includes(artifact.kind))
    errors.push('Artifact evidence kind is missing');
  if (
    artifact.id !==
    `hermes:${artifact.bundle?.sha256}:map:${artifact.sourceMap?.sha256}`
  )
    errors.push('Artifact identity does not match its bundle/map hashes');
  if (
    artifact.kind === 'current-build' &&
    (artifact.bundle?.sha256 === REFERENCE_BUNDLE_SHA256 ||
      artifact.sourceMap?.sha256 === REFERENCE_MAP_SHA256 ||
      artifact.sourceMap?.debugIDs?.includes(REFERENCE_DEBUG_ID))
  )
    errors.push(
      'Known historical Release evidence cannot be promoted to current-build evidence',
    );
  if (
    artifact.lockedInputsSha256 !==
    sha256(Buffer.from(json(artifactLockedInputs(receipt, artifact))))
  )
    errors.push('Artifact dependency lock binding changed');
  if (
    !/^[a-f0-9]{64}$/.test(artifact.bundle?.sha256 ?? '') ||
    !/^[a-f0-9]{64}$/.test(artifact.sourceMap?.sha256 ?? '') ||
    artifact.bundle?.magic !== 'c61fbc03c103191f' ||
    !Number.isInteger(artifact.bundle.hermesVersion) ||
    artifact.bundle.bytes <= 32
  )
    errors.push('Artifact is not an identified Hermes bundle/map pair');
  if (
    artifact.sourceMap?.debugIDs?.length !== 1 ||
    json(artifact.sourceMap.debugIDs) !==
      json(artifact.sourceMap.debugIDsInBundle)
  )
    errors.push(
      'Source-map debug ID does not match the supplied Hermes bundle',
    );
  if (
    !Number.isInteger(artifact.sourceMap?.mappedSourceCount) ||
    artifact.sourceMap.mappedSourceCount < 1 ||
    artifact.sourceMap.mappedSourceCount > artifact.sourceCount ||
    artifact.sourceMap.sourcesContentCount !== artifact.sourceCount
  )
    errors.push('Artifact source-map completeness evidence is missing');
  if (artifact.unknownSources?.length)
    errors.push('Source map contains unclassified source paths');
  if (
    !Array.isArray(artifact.normalizedSources) ||
    !artifact.normalizedSources.length ||
    artifact.normalizedSources.some(
      path =>
        path.startsWith('/') ||
        path.includes('\\') ||
        path.split('/').includes('..'),
    )
  )
    errors.push('Artifact membership paths are missing or non-portable');
  else {
    if (
      sha256(Buffer.from(json(artifact.normalizedSources))) !==
      artifact.sourceMap.sourcesSha256
    )
      errors.push('Source-map membership digest mismatch');
    const normalized = mapMembership(receipt, {
      version: 3,
      sources: artifact.normalizedSources,
      mappings: 'AAAA',
    });
    if (json(normalized.npmMembers) !== json(artifact.npmMembers))
      errors.push('Source-map package membership was changed');
  }
  for (const member of artifact.npmMembers ?? []) {
    const pkg = receipt.components.find(item => item.lockPath === member.path);
    if (!pkg || member.version !== pkg.version)
      errors.push(`Artifact package version is unbound: ${member.path}`);
  }
  for (const excluded of artifact.exclusions ?? []) {
    const path = excluded.id.slice('npm:'.length);
    const pkg = receipt.components.find(item => item.lockPath === path);
    const parents = sorted(
      new Set(
        receipt.npmClosure.edges
          .filter(edge => edge.to === path)
          .map(edge => edge.from),
      ),
    );
    if (
      !pkg ||
      excluded.version !== pkg.version ||
      excluded.observed ||
      artifact.npmMembers.some(member => member.path === path) ||
      json(excluded.dependencyPath) !== json(dependencyPath(receipt, path)) ||
      json(excluded.directParents) !== json(parents) ||
      excluded.classification !== exclusionClassification(path)
    )
      errors.push(
        `Artifact exclusion is not supported by the locked dependency graph: ${path}`,
      );
  }
  if (
    !artifact.npmMembers?.some(
      member => member.path === 'node_modules/react-native',
    ) ||
    !artifact.npmMembers?.some(member => member.path === 'node_modules/react')
  )
    errors.push('Artifact lacks the required app runtime source anchors');
  return sorted(new Set(errors));
}

export function makeArtifactEvidence(receipt, observed, { kind, label }) {
  const inputs = artifactLockedInputs(receipt, { ...observed, kind });
  const artifact = {
    ...observed,
    id: `hermes:${observed.bundle.sha256}:map:${observed.sourceMap.sha256}`,
    kind,
    label,
    lockedInputsSha256: sha256(Buffer.from(json(inputs))),
    exclusions: observed.unresolvedPackages
      .filter(item => !item.observed)
      .map(item => ({
        ...item,
        classification: exclusionClassification(item.id.slice('npm:'.length)),
        scope:
          'Absent only from this exact hashed source-map/bundle pair. Not an exclusion from any future artifact.',
      })),
  };
  artifact.evidenceSha256 = evidenceDigest(artifact);
  const errors = artifactProblems(receipt, artifact);
  if (errors.length) throw new Error(errors.join('; '));
  return artifact;
}

export function recordArtifactEvidence(receipt, observed, options) {
  const artifact = makeArtifactEvidence(receipt, observed, options);
  if (artifact.kind === 'current-build') {
    const problems = freshArtifactProblems(receipt, artifact).filter(
      problem =>
        !problem.startsWith('New bundled member requires notice regeneration:'),
    );
    if (problems.length) throw new Error(problems.join('; '));
  }
  receipt.artifactEvidence = [
    ...(receipt.artifactEvidence ?? []).filter(
      previous => previous.id !== artifact.id,
    ),
    artifact,
  ].sort((a, b) => cmp(a.id, b.id));
  receipt.noticeMembershipArtifactId = artifact.id;
  return artifact;
}

export function freshArtifactProblems(receipt, artifact) {
  const errors = artifactProblems(receipt, artifact);
  if (
    artifact.bundle.sha256 === REFERENCE_BUNDLE_SHA256 ||
    artifact.sourceMap.sha256 === REFERENCE_MAP_SHA256 ||
    artifact.sourceMap.debugIDs.includes(REFERENCE_DEBUG_ID)
  )
    errors.push(
      'Historical Release evidence cannot certify the current app; supply the fresh Release map/bundle pair',
    );
  for (const previous of receipt.artifactEvidence ?? []) {
    if (
      previous.kind === 'historical-reference' &&
      (previous.bundle.sha256 === artifact.bundle.sha256 ||
        previous.sourceMap.sha256 === artifact.sourceMap.sha256 ||
        previous.sourceMap.debugIDs.some(id =>
          artifact.sourceMap.debugIDs.includes(id),
        ))
    ) {
      errors.push(
        'Historical Release evidence cannot certify the current app; supply the fresh Release map/bundle pair',
      );
    }
  }
  const covered = selectedNpmPaths(receipt);
  for (const member of artifact.npmMembers) {
    if (covered && !covered.has(member.path))
      errors.push(
        `New bundled member requires notice regeneration: ${member.path}@${member.version}`,
      );
  }
  return sorted(new Set(errors));
}

export function coverageProblems(
  receipt,
  { artifact = candidateArtifact(receipt) } = {},
) {
  const problems = [...receipt.gaps];
  const selected = selectedNpmPaths(receipt, artifact);
  if (artifact) problems.push(...artifactProblems(receipt, artifact));
  const sources = new Map(receipt.sources.map(source => [source.id, source]));
  for (const item of receipt.components) {
    if (item.id.startsWith('npm:') && selected && !selected.has(item.lockPath))
      continue;
    if (
      item.role === 'first-party-outside-third-party-notices' ||
      (item.role === 'build-tool-only' && !selected?.has(item.lockPath))
    )
      continue;
    for (const issue of item.issues)
      problems.push(`${item.id}@${item.version}: ${issue}`);
    if (
      /\b(?:A?GPL|LGPL|MPL|CDDL|SSPL|FSL)[-\d ]/i.test(
        JSON.stringify(item.declaredLicense ?? ''),
      )
    ) {
      problems.push(
        `${item.id}@${item.version}: license-specific redistribution obligations require review beyond a bundled text copy`,
      );
    }
    const evidence = item.sourceIds.map(id => sources.get(id));
    if (item.id === 'native:Sentry') {
      if (!item.upstream?.inlineSourceIds?.length)
        problems.push(
          'native:Sentry: vendored source notice inventory is missing',
        );
      for (const id of item.upstream?.inlineSourceIds ?? []) {
        if (!item.sourceIds.includes(id) || !sources.has(id))
          problems.push(
            `native:Sentry: required vendored notice missing: ${id}`,
          );
      }
    }
    const requiredPaths = item.id.startsWith('swiftpm:')
      ? SWIFT_REQUIRED[item.name]
      : item.upstream?.licensePaths;
    if (item.id.startsWith('swiftpm:') && !requiredPaths) {
      problems.push(`${item.id}: unreviewed SwiftPM source/NOTICE coverage`);
    }
    for (const path of requiredPaths ?? []) {
      if (
        !evidence.some(
          source =>
            source?.pathInRepository === path &&
            source.revision === (item.revision ?? item.upstream.revision),
        )
      ) {
        problems.push(
          `${item.id}: required original LICENSE/NOTICE missing: ${path}`,
        );
      }
    }
    if (item.role === 'bundled-font')
      problems.push(...fontProvenanceProblems(receipt, item));
    for (const id of item.sourceIds) {
      if (!sources.has(id)) problems.push(`${item.id}: missing source ${id}`);
    }
    if (
      item.role !== 'generated-notices' &&
      !evidence.some(
        source =>
          source?.kind === 'license-text' && hasLicenseText(source.text),
      )
    ) {
      problems.push(
        `${item.id}@${item.version}: full source license is unresolved (license IDs and NOTICE alone do not suffice)`,
      );
    }
  }
  return sorted(new Set(problems));
}

function sourceIsBound(receipt, item, source) {
  if (!source) return false;
  if (item.id.startsWith('npm:')) {
    if (source.path?.startsWith(`${item.lockPath}/`)) {
      return (
        source.package === item.name &&
        source.version === item.version &&
        source.integrity === item.integrity
      );
    }
    if (source.provenance === 'published-npm-git-source') {
      return (
        item.upstream?.repository === source.repository &&
        item.upstream?.revision === source.revision &&
        source.version === item.version
      );
    }
    const reference = item.licenseReferenceEvidence;
    const pointer = receipt.sources.find(
      entry => entry.id === reference?.sourceId,
    );
    return (
      source.id === reference?.fullTextSourceId &&
      source.sha256 ===
        'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30' &&
      pointer?.path?.startsWith(`${item.lockPath}/`) &&
      pointer.version === item.version &&
      pointer.text.includes('Licensed under the Apache License, Version 2.0') &&
      /copyright/i.test(pointer.text)
    );
  }
  if (item.id.startsWith('swiftpm:'))
    return (
      source.provenance === 'locked-git-source' &&
      source.revision === item.revision &&
      source.version === item.version &&
      source.repository === item.repository
    );
  if (item.upstream && source.provenance === 'versioned-upstream-source') {
    return (
      source.version === item.version &&
      source.repository === item.upstream.repository &&
      source.revision === item.upstream.revision
    );
  }
  if (item.id.startsWith('pod:')) {
    if (source.path?.startsWith(`ios/Pods/${item.name}/`))
      return source.version === item.version;
    const packageName = POD_NPM[item.name] ?? 'react-native';
    const npm = receipt.components.find(
      entry => entry.id === `npm:node_modules/${packageName}`,
    );
    return (
      !!npm?.sourceIds.includes(source.id) &&
      (npm.version === item.version ||
        (item.name === 'Yoga' && item.version === '0.0.0'))
    );
  }
  if (item.role === 'bundled-font') {
    if (source.kind === 'font-embedded-notice')
      return item.nameTable.some(
        name =>
          [0, 7, 13, 14].includes(name.nameID) && name.text === source.text,
      );
    if (item.name.startsWith('Manrope_'))
      return (
        source.id === 'local:assets/fonts/Manrope-OFL.txt' ||
        (source.provenance === 'versioned-font-release' &&
          source.id === receipt.manropeProvenance?.sourceId &&
          !fontProvenanceProblems(receipt, item).length)
      );
    return (
      item.name === 'Roboto-Bold.ttf' &&
      source.id === 'local:ios/Pods/GoogleSignIn/LICENSE'
    );
  }
  return item.id === 'generated:CocoaPods' && source.id === `local:${ACK}`;
}

export function validateReceipt(
  receipt,
  { root = ROOT, installed = false } = {},
) {
  const errors = [];
  if (receipt.schemaVersion !== 1) return ['Unsupported notice source schema'];
  const history = receipt.historicalSwiftPM;
  const historicalComponents = Array.isArray(history?.components)
    ? history.components
    : [];
  if (
    history &&
    (!isReviewedSwiftUnlink(history) || !Array.isArray(history.components))
  )
    errors.push('Historical SwiftPM unlink receipt is invalid');
  const hostHistory = receipt.historicalHostTools;
  if (hostHistory && !isReviewedHostToolPatch(hostHistory))
    errors.push('Historical host-tool maintenance receipt is invalid');
  for (const item of historicalComponents) {
    if (
      !item.id.startsWith('swiftpm:') ||
      item.role !== 'historical-source-only'
    )
      errors.push(`Unsupported historical evidence classification: ${item.id}`);
  }
  const allPaths = [
    ...receipt.inputs,
    ...receipt.guards,
    ...receipt.sources.filter(source => source.path),
    ...(history?.lockInput ? [history.lockInput] : []),
    ...(Array.isArray(hostHistory?.inputs) ? hostHistory.inputs : []),
  ].map(item => item.path);
  if (
    allPaths.some(
      path =>
        path.startsWith('/') ||
        path.split('/').includes('..') ||
        path.includes('\\'),
    )
  ) {
    return ['Source receipt contains an unsafe non-workspace path'];
  }
  if (
    json(sorted(receipt.inputs.map(input => input.path))) !==
    json(sorted(LOCK_INPUTS))
  )
    errors.push('Required locked input coverage changed');
  const componentIDs = new Set();
  for (const item of receipt.components) {
    if (componentIDs.has(item.id))
      errors.push(`Duplicate component ID: ${item.id}`);
    componentIDs.add(item.id);
    let role;
    if (item.id.startsWith('npm:'))
      role = buildTool(item.name)
        ? 'build-tool-only'
        : 'npm-runtime-closure-candidate';
    else if (item.id.startsWith('pod:')) {
      role = NATIVE_IDS.has(item.id)
        ? 'prebuilt-native-component-candidate'
        : item.name === 'PickleNative'
          ? 'first-party-outside-third-party-notices'
          : 'native-pod-candidate';
    } else if (item.id.startsWith('swiftpm:')) role = 'swiftpm-pin-candidate';
    else if (item.id.startsWith('font:')) role = 'bundled-font';
    else if (item.id === 'native:Sentry')
      role = 'prebuilt-native-component-candidate';
    else if (item.id === 'generated:CocoaPods') role = 'generated-notices';
    if (!role || item.role !== role)
      errors.push(
        `Unsupported evidence classification: ${item.id} (${item.role})`,
      );
  }
  for (const [id, version] of NATIVE_UPSTREAM) {
    if (
      !receipt.components.some(
        item => item.id === id && item.version === version,
      )
    )
      errors.push(
        `Required native component missing/version changed: ${id}@${version}`,
      );
  }
  const expectedFonts = walkFiles(join(root, 'assets/fonts'))
    .filter(path => /\.ttf$/i.test(path))
    .map(path => `font:${path}`);
  expectedFonts.push('font:Roboto-Bold.ttf');
  if (
    json(
      sorted(
        receipt.components
          .filter(item => item.id.startsWith('font:'))
          .map(item => item.id),
      ),
    ) !== json(sorted(expectedFonts))
  )
    errors.push('Bundled font coverage changed');
  const generated = receipt.components.find(
    item => item.id === 'generated:CocoaPods',
  );
  if (!generated?.sourceIds.includes(`local:${ACK}`))
    errors.push('Full generated CocoaPods acknowledgements are missing');
  const ids = new Set();
  for (const source of receipt.sources) {
    if (ids.has(source.id)) errors.push(`Duplicate source ID: ${source.id}`);
    ids.add(source.id);
    const bytes = Buffer.from(source.text, 'utf8');
    if (sha256(bytes) !== source.sha256 || bytes.length !== source.bytes)
      errors.push(`Raw source bytes/hash mismatch: ${source.id}`);
    if (
      [
        'versioned-upstream-source',
        'published-npm-git-source',
        'versioned-font-release',
      ].includes(source.provenance) &&
      (!/^[a-f0-9]{40}$/.test(source.revision) ||
        !source.url.includes(`/${source.revision}/`) ||
        !source.version)
    ) {
      errors.push(`Unversioned upstream legal source: ${source.id}`);
    }
  }
  for (const item of [...receipt.components, ...historicalComponents]) {
    for (const id of item.sourceIds) {
      if (
        !sourceIsBound(
          receipt,
          item,
          receipt.sources.find(source => source.id === id),
        )
      ) {
        errors.push(
          `Unbound license/NOTICE source for ${item.id}@${item.version}: ${id}`,
        );
      }
    }
  }
  for (const input of [
    ...receipt.inputs,
    ...(installed
      ? receipt.guards
      : receipt.guards.filter(
          item =>
            item.purpose === 'preserve-font-and-splash-input-bytes' &&
            !item.path.startsWith('ios/Pods/'),
        )),
  ]) {
    try {
      if (sha256(readFileSync(join(root, input.path))) !== input.sha256)
        errors.push(`Pinned input changed: ${input.path}`);
    } catch {
      errors.push(`Pinned input missing: ${input.path}`);
    }
  }
  if (installed) {
    for (const source of receipt.sources.filter(
      item =>
        item.path &&
        [
          'installed-file',
          'installed-file-excerpt',
          'cocoapods-generated-text-not-complete-coverage',
        ].includes(item.provenance),
    )) {
      try {
        const file = readFileSync(join(root, source.path));
        const bytes =
          source.provenance === 'installed-file-excerpt'
            ? file.subarray(source.startByte, source.endByte)
            : file;
        if (
          sha256(bytes) !== source.sha256 ||
          (source.sourceFileSha256 && sha256(file) !== source.sourceFileSha256)
        )
          errors.push(`Installed legal source changed: ${source.path}`);
      } catch {
        errors.push(`Installed legal source missing: ${source.path}`);
      }
    }
  }
  const lock = readJSON(join(root, 'package-lock.json'));
  const currentClosure = npmClosure(lock);
  if (json(currentClosure) !== json(receipt.npmClosure))
    errors.push('Pinned npm dependency graph changed');
  const expectedNpm = currentClosure.paths;
  const recordedNpm = sorted(
    receipt.components
      .filter(item => item.id.startsWith('npm:'))
      .map(item => item.lockPath),
  );
  if (json(expectedNpm) !== json(recordedNpm))
    errors.push('Npm dependency closure coverage changed');
  for (const item of receipt.components.filter(entry =>
    entry.id.startsWith('npm:'),
  )) {
    const locked = lock.packages[item.lockPath];
    if (
      locked?.version !== item.version ||
      (locked?.integrity ?? null) !== item.integrity
    )
      errors.push(`Npm version/integrity mismatch: ${item.id}`);
    if (
      item.upstream?.publishedVersion &&
      (item.upstream.publishedVersion !== item.version ||
        item.upstream.integrity !== item.integrity ||
        item.upstream.publishedPackage !== item.name)
    ) {
      errors.push(`Upstream npm publication binding changed: ${item.id}`);
    }
    if (installed && existsSync(join(root, item.lockPath))) {
      const pkg = readJSON(join(root, item.lockPath, 'package.json'));
      if (pkg.version !== item.version || pkg.name !== item.name)
        errors.push(`Installed package identity changed: ${item.id}`);
      const evidence = item.sourceIds.map(id =>
        receipt.sources.find(source => source.id === id),
      );
      for (const path of walkFiles(join(root, item.lockPath)).filter(file =>
        LEGAL_FILE.test(posix.basename(file)),
      )) {
        if (
          !evidence.some(source => source?.path === `${item.lockPath}/${path}`)
        )
          errors.push(
            `Installed LICENSE/NOTICE coverage missing: ${item.lockPath}/${path}`,
          );
      }
    }
  }
  for (const item of receipt.components.filter(
    entry => entry.role === 'bundled-font',
  )) {
    if (installed || !item.fontPath.startsWith('ios/Pods/')) {
      try {
        const font = readFileSync(join(root, item.fontPath));
        if (
          sha256(font) !== item.fontSha256 ||
          json(fontNames(font)) !== json(item.nameTable)
        )
          errors.push(`Font identity/name table changed: ${item.id}`);
      } catch {
        errors.push(`Pinned font input missing or invalid: ${item.fontPath}`);
      }
    }
    for (const text of new Set(
      item.nameTable
        .filter(name => [0, 7, 13, 14].includes(name.nameID))
        .map(name => name.text),
    )) {
      if (!item.sourceIds.includes(`font-name:${sha256(Buffer.from(text))}`))
        errors.push(`Embedded font notice missing: ${item.id}`);
    }
  }
  const expectedPods = parsePodVersions(
    readFileSync(join(root, 'ios/Podfile.lock'), 'utf8'),
  );
  const recordedPods = receipt.components
    .filter(item => item.id.startsWith('pod:'))
    .map(item => [item.name, item.version])
    .sort(([a], [b]) => cmp(a, b));
  if (json(expectedPods) !== json(recordedPods))
    errors.push('CocoaPods version/coverage changed');
  const swiftPins = readJSON(join(root, SWIFT_LOCK))
    .pins.map(pin => [pin.identity, pin.state.version, pin.state.revision])
    .sort(([a], [b]) => cmp(a, b));
  const recordedSwift = receipt.components
    .filter(item => item.id.startsWith('swiftpm:'))
    .map(item => [item.name, item.version, item.revision])
    .sort(([a], [b]) => cmp(a, b));
  if (json(swiftPins) !== json(recordedSwift))
    errors.push('SwiftPM revision/coverage changed');
  if (!receipt.privacyResource || !ids.has(receipt.privacyResource.sourceId))
    errors.push('Vendor Sentry privacy resource is missing');
  for (const artifact of receipt.artifactEvidence ?? [])
    errors.push(...artifactProblems(receipt, artifact));
  if (receipt.noticeMembershipArtifactId && !candidateArtifact(receipt))
    errors.push('Selected notice membership artifact is missing');
  return sorted(new Set(errors));
}

export function renderNotices(
  receipt,
  { artifact = candidateArtifact(receipt) } = {},
) {
  const problems = coverageProblems(receipt, { artifact });
  const selected = selectedNpmPaths(receipt, artifact);
  const chunks = [
    Buffer.from(
      [
        'Pickle Sensei — Third-party license and notice texts',
        'Notice source schema: 1',
        problems.length
          ? 'INCOMPLETE CANDIDATE — NOT CLEARED FOR RELEASE'
          : 'NOTICE CANDIDATE — SOURCE TEXT COVERAGE COMPLETE FOR SELECTED MEMBERSHIP',
        'Full source texts below are retained verbatim; surrounding headings are generated.',
        'Dependency presence is not proof of linked-binary inclusion or a rights certification.',
        receipt.components.some(
          item =>
            item.role === 'build-tool-only' && selected?.has(item.lockPath),
        )
          ? 'Host tooling is observed in this map: do not substitute SDK licenses for its separate redistribution obligations.'
          : 'Host-only tools (including Sentry CLI/FSL) are not represented as shipped SDKs.',
        'Final application membership and resource delivery require a fresh matching map/bundle check.',
        ...(artifact
          ? [
              `Membership reference: ${artifact.kind}; ${artifact.npmMembers.length} npm package members in this exact map.`,
              `Reference bundle SHA-256: ${artifact.bundle.sha256}`,
              `Reference source-map SHA-256: ${artifact.sourceMap.sha256}`,
              'This reference does not certify a newer binary. Native Pod/SwiftPM notices remain conservative candidates.',
            ]
          : [
              'No artifact membership reference: npm closure rows are conservative candidates, not a delivery inventory.',
            ]),
        `Current SwiftPM pin candidates: ${receipt.components.filter(item => item.id.startsWith('swiftpm:')).length}.`,
        ...(receipt.historicalSwiftPM
          ? [
              'Historical SwiftPM source receipts are excluded from this candidate; no past or current native delivery is inferred.',
            ]
          : []),
        ...(receipt.historicalHostTools
          ? [
              'Reviewed host-tool-only maintenance after the reference: qs 6.15.3 -> 6.16.0; xcode-scoped uuid 7.0.3 -> 11.1.1.',
              'Original reference hashes are retained. These updates are not exclusions from any future artifact.',
            ]
          : []),
        ...receipt.inputs.map(
          input => `Input: ${input.path} SHA-256 ${input.sha256}`,
        ),
        ...(problems.length
          ? [
              'Unresolved source/coverage items:',
              ...problems.map(problem => `- ${problem}`),
            ]
          : []),
        '',
        '',
      ].join('\n'),
    ),
  ];
  const sources = new Map(receipt.sources.map(source => [source.id, source]));
  for (const item of [...receipt.components].sort((a, b) => cmp(a.id, b.id))) {
    if (item.id.startsWith('npm:') && selected && !selected.has(item.lockPath))
      continue;
    if (
      item.role === 'first-party-outside-third-party-notices' ||
      (item.role === 'build-tool-only' && !selected?.has(item.lockPath))
    )
      continue;
    const classification =
      item.id.startsWith('npm:') && selected
        ? 'member of the exact reference JS bundle; not a future-artifact claim'
        : item.role;
    chunks.push(
      Buffer.from(
        `\n${'='.repeat(78)}\n${item.name} — ${item.version}\nComponent: ${item.id}\nEvidence: ${classification}\n`,
      ),
    );
    for (const id of sorted(new Set(item.sourceIds))) {
      const source = sources.get(id);
      if (!source || source.kind === 'vendor-privacy-resource') continue;
      chunks.push(
        Buffer.from(
          `\n--- BEGIN UNMODIFIED SOURCE: ${id}\nSHA-256: ${source.sha256}\n`,
        ),
      );
      chunks.push(Buffer.from(source.text, 'utf8'));
      chunks.push(Buffer.from(`\n--- END UNMODIFIED SOURCE: ${id}\n`));
    }
  }
  return Buffer.concat(chunks);
}

export function resourceBytes(receipt) {
  const source = receipt.sources.find(
    item => item.id === receipt.privacyResource?.sourceId,
  );
  if (
    !source ||
    source.kind !== 'vendor-privacy-resource' ||
    source.version !== SENTRY_VERSION
  )
    throw new Error('Missing matching vendor Sentry resource');
  const bytes = Buffer.from(source.text);
  if (
    sha256(bytes) !== source.sha256 ||
    source.sha256 !== VENDOR_PRIVACY_SHA256
  )
    throw new Error('Sentry vendor privacy resource hash mismatch');
  return bytes;
}

function writeResources(receipt, root) {
  mkdirSync(join(root, PRIVACY_DIR), { recursive: true });
  writeFileSync(join(root, OUTPUT), renderNotices(receipt));
  writeFileSync(
    join(root, PRIVACY_DIR, 'PrivacyInfo.xcprivacy'),
    resourceBytes(receipt),
  );
  writeFileSync(join(root, PRIVACY_DIR, 'Info.plist'), PRIVACY_WRAPPER);
}

export function checkResources(receipt, root = ROOT, app = false) {
  const entries = [
    [app ? 'ThirdPartyNotices.txt' : OUTPUT, renderNotices(receipt)],
    [
      app
        ? 'SentryPrivacy.bundle/PrivacyInfo.xcprivacy'
        : `${PRIVACY_DIR}/PrivacyInfo.xcprivacy`,
      resourceBytes(receipt),
    ],
    [
      app ? 'SentryPrivacy.bundle/Info.plist' : `${PRIVACY_DIR}/Info.plist`,
      Buffer.from(PRIVACY_WRAPPER),
    ],
  ];
  return entries.flatMap(([path, bytes]) => {
    try {
      return readFileSync(join(root, path)).equals(bytes)
        ? []
        : [`Delivered resource differs: ${path}`];
    } catch {
      return [`Delivered resource missing: ${path}`];
    }
  });
}

function artifactInput(receipt, args, bundlePath) {
  const value = name => args[args.indexOf(name) + 1];
  const required = [
    '--source-map',
    '--expected-bundle-sha256',
    '--expected-map-sha256',
    ...(!bundlePath ? ['--bundle'] : []),
  ];
  for (const name of required) {
    if (!args.includes(name) || !value(name) || value(name).startsWith('--'))
      throw new Error(`Fresh artifact verification requires ${name}`);
  }
  const mapBytes = readFileSync(value('--source-map'));
  if (
    !/^[a-f0-9]{64}$/.test(value('--expected-map-sha256')) ||
    sha256(mapBytes) !== value('--expected-map-sha256')
  )
    throw new Error(
      'Explicit expected source-map SHA-256 does not match the supplied map',
    );
  return inspectArtifact(
    receipt,
    mapBytes,
    readFileSync(bundlePath ?? value('--bundle')),
    value('--expected-bundle-sha256'),
  );
}

async function main(args) {
  const modes = args.filter(arg =>
    [
      '--capture',
      '--capture-artifact',
      '--capture-manrope',
      '--inspect-artifact',
      '--inspect-manrope',
      '--check',
      '--generate',
      '--write-candidate',
      '--check-app',
    ].includes(arg),
  );
  if (modes.length !== 1)
    throw new Error(
      'Choose exactly one: --capture, --capture-artifact, --capture-manrope, --inspect-artifact, --inspect-manrope, --check, --generate, --write-candidate, --check-app PATH',
    );
  const mode = modes[0];
  if (mode === '--capture-artifact' || mode === '--capture-manrope') {
    const receipt = readJSON(join(ROOT, RECEIPT));
    const invalid = validateReceipt(receipt);
    if (invalid.length) throw new Error(invalid.join('; '));
    if (mode === '--capture-manrope') {
      if (!args.includes('--fetch-public'))
        throw new Error('Font source capture requires explicit --fetch-public');
      recordManropeProof(receipt, await inspectManrope(receipt));
    } else {
      if (args.includes('--fetch-public'))
        throw new Error('Artifact membership capture is offline');
      const kind = args[args.indexOf('--artifact-kind') + 1];
      if (
        !args.includes('--artifact-kind') ||
        !['historical-reference', 'current-build'].includes(kind)
      )
        throw new Error(
          '--artifact-kind historical-reference|current-build is required',
        );
      const label = args.includes('--label')
        ? args[args.indexOf('--label') + 1]
        : kind;
      recordArtifactEvidence(receipt, artifactInput(receipt, args), {
        kind,
        label,
      });
    }
    const after = validateReceipt(receipt);
    if (after.length) throw new Error(after.join('; '));
    writeFileSync(join(ROOT, RECEIPT), json(receipt));
    const problems = coverageProblems(receipt);
    console.log(
      `Recorded ${mode.slice(2)} evidence; ${problems.length} selected-membership source issue(s). Final .app verification is separate.`,
    );
    for (const problem of problems) console.error(`UNRESOLVED ${problem}`);
    if (problems.length) process.exitCode = 1;
    return;
  }
  if (mode === '--inspect-artifact') {
    const value = name => args[args.indexOf(name) + 1];
    for (const name of [
      '--source-map',
      '--bundle',
      '--expected-bundle-sha256',
    ]) {
      if (!args.includes(name) || !value(name))
        throw new Error(`Missing ${name}`);
    }
    const observed = inspectArtifact(
      readJSON(join(ROOT, RECEIPT)),
      readFileSync(value('--source-map')),
      readFileSync(value('--bundle')),
      value('--expected-bundle-sha256'),
    );
    console.log(
      json({
        bundle: observed.bundle,
        sourceMap: observed.sourceMap,
        sourceCount: observed.sourceCount,
        npmMemberCount: observed.npmMembers.length,
        unknownSources: observed.unknownSources,
        unresolvedPackages: observed.unresolvedPackages,
      }),
    );
    return;
  }
  if (mode === '--inspect-manrope') {
    if (!args.includes('--fetch-public'))
      throw new Error(
        'Manrope release inspection requires explicit --fetch-public',
      );
    const proof = await inspectManrope(readJSON(join(ROOT, RECEIPT)));
    const { licenseText, ...summary } = proof;
    console.log(
      json({ ...summary, licenseBytes: Buffer.byteLength(licenseText) }),
    );
    return;
  }
  if (mode === '--capture') {
    const at = args.indexOf('--swift-checkouts');
    const result = await capture({
      checkouts: at < 0 ? undefined : args[at + 1],
      fetchPublic: args.includes('--fetch-public'),
    });
    writeFileSync(join(ROOT, RECEIPT), json(result));
    const problems = coverageProblems(result);
    console.log(
      `Captured ${result.components.length} components, ${result.sources.length} raw texts; ${problems.length} unresolved items.`,
    );
    for (const problem of problems) console.error(`UNRESOLVED ${problem}`);
    if (problems.length) process.exitCode = 1;
    return;
  }
  if (args.includes('--fetch-public'))
    throw new Error(
      'Network reads are allowed only for explicit source capture, never generation/validation',
    );
  const receipt = readJSON(join(ROOT, RECEIPT));
  const invalid = validateReceipt(receipt, {
    installed: args.includes('--check-installed'),
  });
  const incomplete = coverageProblems(receipt);
  const problems = [...invalid, ...incomplete];
  let verifiedArtifact;
  if (mode === '--check') problems.push(...checkResources(receipt));
  if (mode === '--check-app') {
    const appPath = args[args.indexOf('--check-app') + 1];
    if (!appPath || !appPath.endsWith('.app'))
      throw new Error('--check-app requires an explicit .app directory');
    verifiedArtifact = makeArtifactEvidence(
      receipt,
      artifactInput(receipt, args, join(resolve(appPath), 'main.jsbundle')),
      { kind: 'current-build', label: 'explicit-current-app-verification' },
    );
    problems.push(
      ...freshArtifactProblems(receipt, verifiedArtifact),
      ...coverageProblems(receipt, { artifact: verifiedArtifact }),
    );
    problems.push(...checkResources(receipt, resolve(appPath), true));
  }
  if (mode === '--generate' && !problems.length) writeResources(receipt, ROOT);
  if (mode === '--write-candidate' && !invalid.length)
    writeResources(receipt, ROOT);
  for (const problem of sorted(new Set(problems)))
    console.error(`FAIL ${problem}`);
  if (problems.length) {
    console.error(
      `NOT RELEASE-CLEARED: ${new Set(problems).size} issue(s).${mode === '--write-candidate' && !invalid.length ? ' Incomplete candidate resources written; validation still fails.' : ''}`,
    );
    process.exitCode = 1;
  } else
    console.log(
      verifiedArtifact
        ? `Resources and membership verified only for bundle ${verifiedArtifact.bundle.sha256} / map ${verifiedArtifact.sourceMap.sha256}; not a rights, signature, or App Store certification.`
        : 'Portable notice candidate source coverage and vendor resource validated. Final .app membership/delivery still requires a fresh Release map/bundle pair; no current-binary clearance is claimed.',
    );
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`FAIL ${error.message}`);
    process.exitCode = 1;
  });
}
