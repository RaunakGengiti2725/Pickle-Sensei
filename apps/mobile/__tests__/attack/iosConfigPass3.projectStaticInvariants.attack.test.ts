/**
 * ADVERSARIAL PASS 3 / mobile-ios-config — extra static invariants across the
 * iOS project files the assigned scenarios did not already cover:
 * pbxproj versions and Release-vs-Debug exclusion, deployment target vs the
 * React Native minimum the Podfile inherits, ATS, entitlements, iPhone-only
 * portrait posture, bundle identity coherence (pbxproj ↔ app.json ↔ index.js),
 * privacy-string copy hygiene, and hidden-Unicode poisoning of the plists.
 *
 * Linux read-only checks only (no Xcode, no Mac run): these pin the checked-in
 * text, not Apple runtime behaviour.
 */
import { getRuntimePublicConfig } from '../../src/config/runtimeConfig';

// The mobile tsconfig has no Node types (matches
// flow-app-store-compliance-ios-config.test.ts).
declare const require: (id: string) => unknown;
declare const __dirname: string;

const { readFileSync, existsSync } = require('fs') as {
  readFileSync: (path: string, encoding: 'utf8') => string;
  existsSync: (path: string) => boolean;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

const MOBILE = join(__dirname, '..', '..');
const IOS = join(MOBILE, 'ios');
const APP = join(IOS, 'PickleSensei');

const pbxproj = readFileSync(
  join(IOS, 'PickleSensei.xcodeproj', 'project.pbxproj'),
  'utf8',
);
const infoPlist = readFileSync(join(APP, 'Info.plist'), 'utf8');
const entitlements = readFileSync(
  join(APP, 'PickleSensei.entitlements'),
  'utf8',
);
const privacyManifest = readFileSync(
  join(APP, 'PrivacyInfo.xcprivacy'),
  'utf8',
);
const podfile = readFileSync(join(IOS, 'Podfile'), 'utf8');
const appJson = JSON.parse(readFileSync(join(MOBILE, 'app.json'), 'utf8')) as {
  name: string;
  displayName: string;
};
const indexJs = readFileSync(join(MOBILE, 'index.js'), 'utf8');
const rnHelpers = readFileSync(
  join(
    MOBILE,
    'node_modules',
    'react-native',
    'scripts',
    'cocoapods',
    'helpers.rb',
  ),
  'utf8',
);

interface BuildConfiguration {
  name: string;
  settings: Record<string, string>;
}

/** Every XCBuildConfiguration block → { name, flattened buildSettings }. */
function buildConfigurations(): BuildConfiguration[] {
  const blocks = pbxproj.matchAll(
    /isa = XCBuildConfiguration;\s*(?:baseConfigurationReference[^\n]*\n\s*)?buildSettings = \{([\s\S]*?)\n\t\t\t\};\s*name = (\w+);/g,
  );
  const out: BuildConfiguration[] = [];
  for (const match of blocks) {
    const settings: Record<string, string> = {};
    const body = match[1]!;
    // Multi-line list values (`KEY = (\n item,\n );`) are joined to one line.
    const lines: string[] = [];
    let open: string | null = null;
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (open !== null) {
        open += ` ${line}`;
        if (line === ');') {
          lines.push(open);
          open = null;
        }
        continue;
      }
      if (/ = \($/.test(line)) open = line;
      else lines.push(line);
    }
    for (const line of lines) {
      const kv = /^("?[^=]+?"?) = (.*);$/.exec(line);
      if (kv) settings[kv[1]!.replace(/"/g, '')] = kv[2]!;
    }
    out.push({ name: match[2]!, settings });
  }
  return out;
}

const configs = buildConfigurations();
const appTargetConfigs = configs.filter(
  c => c.settings.PRODUCT_BUNDLE_IDENTIFIER !== undefined,
);
const projectConfigs = configs.filter(
  c => c.settings.PRODUCT_BUNDLE_IDENTIFIER === undefined,
);

function plistString(source: string, key: string): string | null {
  const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(
    source,
  );
  return m ? m[1]! : null;
}

function plistArray(source: string, key: string): string[] | null {
  const m = new RegExp(`<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`).exec(
    source,
  );
  if (!m) return null;
  return [...m[1]!.matchAll(/<string>([^<]*)<\/string>/g)].map(x => x[1]!);
}

/** APP_STORE_SUBMISSION.md hard rules for any user-visible copy. */
const FORBIDDEN_COPY =
  /android|google play|guest mode|live court|dupr|swingvision|pb vision|selkirk|joola|\d+\s?%|best|#1|most accurate|as good as a coach|replaces? (a|your) coach/i;

describe('parser sanity', () => {
  it('finds two app-target configurations (Debug, Release) and two project-level ones', () => {
    expect(appTargetConfigs.map(c => c.name).sort()).toEqual([
      'Debug',
      'Release',
    ]);
    expect(projectConfigs.map(c => c.name).sort()).toEqual([
      'Debug',
      'Release',
    ]);
  });
});

describe('pbxproj versions', () => {
  it('MARKETING_VERSION equals runtimeConfig.appVersion in every app-target configuration', () => {
    const { appVersion } = getRuntimePublicConfig();
    for (const c of appTargetConfigs) {
      expect(c.settings.MARKETING_VERSION).toBe(appVersion);
    }
  });

  it('CURRENT_PROJECT_VERSION is a positive integer identical across configurations', () => {
    const values = new Set(
      appTargetConfigs.map(c => c.settings.CURRENT_PROJECT_VERSION),
    );
    expect(values.size).toBe(1);
    expect([...values][0]).toMatch(/^[1-9]\d*$/);
  });

  it('Info.plist derives CFBundleShortVersionString / CFBundleVersion from the pbxproj (no hard-coded drift)', () => {
    expect(plistString(infoPlist, 'CFBundleShortVersionString')).toBe(
      '$(MARKETING_VERSION)',
    );
    expect(plistString(infoPlist, 'CFBundleVersion')).toBe(
      '$(CURRENT_PROJECT_VERSION)',
    );
  });

  it('IPHONEOS_DEPLOYMENT_TARGET is uniform and not below the React Native minimum the Podfile inherits', () => {
    const rnMin =
      /def self\.min_ios_version_supported\s*return '([\d.]+)'/.exec(
        rnHelpers,
      )?.[1];
    expect(rnMin).toBeDefined();
    expect(podfile).toMatch(/^platform :ios, min_ios_version_supported$/m);
    const targets = new Set(
      configs.map(c => c.settings.IPHONEOS_DEPLOYMENT_TARGET),
    );
    expect(targets.size).toBe(1);
    const [target] = [...targets];
    expect(parseFloat(target!)).toBeGreaterThanOrEqual(parseFloat(rnMin!));
  });
});

describe('Release excludes debug', () => {
  const release = projectConfigs.find(c => c.name === 'Release')!;
  const debug = projectConfigs.find(c => c.name === 'Debug')!;

  it('Debug carries DEBUG=1 / SWIFT DEBUG (so the negative below is meaningful)', () => {
    expect(debug.settings.GCC_PREPROCESSOR_DEFINITIONS).toContain('DEBUG=1');
    expect(debug.settings.SWIFT_ACTIVE_COMPILATION_CONDITIONS).toMatch(
      /\bDEBUG\b/,
    );
    expect(debug.settings.MTL_ENABLE_DEBUG_INFO).toBe('YES');
  });

  it('Release has no DEBUG preprocessor/Swift condition, strips symbols, validates product, no debug Metal info', () => {
    expect(release.settings.GCC_PREPROCESSOR_DEFINITIONS ?? '').not.toMatch(
      /DEBUG/,
    );
    expect(
      release.settings.SWIFT_ACTIVE_COMPILATION_CONDITIONS ?? '',
    ).not.toMatch(/\bDEBUG\b/);
    expect(release.settings.MTL_ENABLE_DEBUG_INFO).toBe('NO');
    expect(release.settings.COPY_PHASE_STRIP).toBe('YES');
    expect(release.settings.VALIDATE_PRODUCT).toBe('YES');
    expect(release.settings.ONLY_ACTIVE_ARCH).toBeUndefined();
  });

  it('the app-target Release configuration does not force -Onone', () => {
    const appRelease = appTargetConfigs.find(c => c.name === 'Release')!;
    expect(appRelease.settings.SWIFT_OPTIMIZATION_LEVEL ?? '').not.toBe(
      '"-Onone"',
    );
  });

  it('index.js gates the Hermes rejection tracker on __DEV__ exactly once and registers app.json.name', () => {
    expect(indexJs.match(/__DEV__/g)).toHaveLength(1);
    expect(indexJs).toContain("import { name as appName } from './app.json';");
    expect(indexJs).toMatch(
      /AppRegistry\.registerComponent\(appName, \(\) => App\)/,
    );
  });
});

describe('ATS', () => {
  it('NSAllowsArbitraryLoads=false, no NSExceptionDomains, and the API origin is https', () => {
    expect(infoPlist).toMatch(/<key>NSAllowsArbitraryLoads<\/key>\s*<false\/>/);
    expect(infoPlist).not.toContain('NSExceptionDomains');
    expect(infoPlist).not.toContain('NSAllowsArbitraryLoadsInWebContent');
    expect(infoPlist).not.toContain('NSAllowsArbitraryLoadsForMedia');
    const {
      apiBaseUrl,
      legalPrivacyUrl,
      legalTermsUrl,
      appStoreWriteReviewUrl,
    } = getRuntimePublicConfig();
    for (const url of [
      apiBaseUrl,
      legalPrivacyUrl,
      legalTermsUrl,
      appStoreWriteReviewUrl,
    ]) {
      expect(url).toMatch(/^https:\/\//);
    }
  });

  it('BASELINE BEHAVIOUR: NSAllowsLocalNetworking=true ships in the Release Info.plist (single plist, no per-configuration split)', () => {
    // React Native templates set this for the Metro dev server. There is one
    // Info.plist for both configurations, so the relaxation is present in the
    // App Store build too. Pinned so a future per-configuration split (or
    // removal) is a deliberate change.
    expect(infoPlist).toMatch(/<key>NSAllowsLocalNetworking<\/key>\s*<true\/>/);
    const infoPlistFiles = new Set(
      appTargetConfigs.map(c => c.settings.INFOPLIST_FILE),
    );
    expect(infoPlistFiles.size).toBe(1);
  });
});

describe('entitlements and capabilities', () => {
  it('declares exactly Sign in with Apple (Default) — no push, no associated domains, no iCloud', () => {
    const keys = [...entitlements.matchAll(/<key>([^<]+)<\/key>/g)].map(
      m => m[1],
    );
    expect(keys).toEqual(['com.apple.developer.applesignin']);
    expect(plistArray(entitlements, 'com.apple.developer.applesignin')).toEqual(
      ['Default'],
    );
  });

  it('no UIBackgroundModes are requested (nothing runs in the background)', () => {
    expect(infoPlist).not.toContain('UIBackgroundModes');
  });
});

describe('iPhone-only, portrait-only posture', () => {
  it('TARGETED_DEVICE_FAMILY=1 in every app-target configuration', () => {
    for (const c of appTargetConfigs) {
      expect(c.settings.TARGETED_DEVICE_FAMILY).toBe('1');
    }
  });

  it('UISupportedInterfaceOrientations is portrait only; arm64 required', () => {
    expect(plistArray(infoPlist, 'UISupportedInterfaceOrientations')).toEqual([
      'UIInterfaceOrientationPortrait',
    ]);
    expect(plistArray(infoPlist, 'UIRequiredDeviceCapabilities')).toEqual([
      'arm64',
    ]);
  });
});

describe('bundle identity coherence', () => {
  it('PRODUCT_BUNDLE_IDENTIFIER is com.picklesensei in every app-target configuration', () => {
    for (const c of appTargetConfigs) {
      expect(c.settings.PRODUCT_BUNDLE_IDENTIFIER).toBe('com.picklesensei');
    }
  });

  it('app.json name matches the Xcode target/product and the display name is "Pickle Sensei"', () => {
    expect(appJson.name).toBe('PickleSensei');
    expect(pbxproj).toContain('PRODUCT_NAME = PickleSensei;');
    expect(plistString(infoPlist, 'CFBundleDisplayName')).toBe('Pickle Sensei');
    expect(plistString(infoPlist, 'CFBundleName')).toBe('$(PRODUCT_NAME)');
  });

  it('apps/mobile is npm-managed: package-lock.json present, no pnpm/yarn lockfile', () => {
    expect(existsSync(join(MOBILE, 'package-lock.json'))).toBe(true);
    expect(existsSync(join(MOBILE, 'pnpm-lock.yaml'))).toBe(false);
    expect(existsSync(join(MOBILE, 'yarn.lock'))).toBe(false);
  });
});

describe('privacy strings', () => {
  const usageKeys = [
    ...infoPlist.matchAll(/<key>(NS\w+UsageDescription)<\/key>/g),
  ].map(m => m[1]!);

  it('only the three capabilities the app uses have purpose strings (camera, microphone, photo library)', () => {
    expect(usageKeys.sort()).toEqual([
      'NSCameraUsageDescription',
      'NSMicrophoneUsageDescription',
      'NSPhotoLibraryUsageDescription',
    ]);
  });

  it('every purpose string is App Store copy-clean and speaks to on-device/private handling', () => {
    for (const key of usageKeys) {
      const value = plistString(infoPlist, key)!;
      expect(value).not.toMatch(FORBIDDEN_COPY);
      expect(value).toMatch(
        /private|on-device|this device|the video you choose/,
      );
      expect(value).toMatch(/[.]$/);
    }
  });

  it('the camera purpose string and the native permission-denied sentence describe the same job', () => {
    const swift = readFileSync(
      join(
        IOS,
        'LocalPods',
        'PickleNative',
        'Sources',
        'PickleVideoCapture.swift',
      ),
      'utf8',
    );
    const denied =
      /code: "camera\.permission_denied",\s*message: "([^"]+)"/.exec(
        swift,
      )?.[1];
    expect(denied).toBeDefined();
    expect(denied).toMatch(/Settings/);
    expect(denied).not.toMatch(FORBIDDEN_COPY);
    const camera = plistString(infoPlist, 'NSCameraUsageDescription')!;
    for (const stem of ['stroke', 'analy']) {
      expect(denied!.toLowerCase()).toContain(stem);
      expect(camera.toLowerCase()).toContain(stem);
    }
  });
});

describe('hidden-Unicode / encoding poisoning of the checked-in plists', () => {
  const files: Array<[string, string]> = [
    ['Info.plist', infoPlist],
    ['PickleSensei.entitlements', entitlements],
    ['PrivacyInfo.xcprivacy', privacyManifest],
  ];

  it.each(files)(
    '%s has no BOM, zero-width, bidi-override, or C0/C1 control characters',
    (_name, text) => {
      expect(text.charCodeAt(0)).not.toBe(0xfeff);
      expect(text).not.toMatch(
        // eslint-disable-next-line no-control-regex
        /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/,
      );
      expect(text).not.toMatch(
        /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/,
      );
    },
  );

  it.each(files)(
    '%s keys are pure ASCII (no confusable look-alikes)',
    (_name, text) => {
      for (const m of text.matchAll(/<key>([^<]*)<\/key>/g)) {
        expect(m[1]).toMatch(/^[\x20-\x7E]+$/);
      }
    },
  );

  it('CFBundleURLSchemes and Google client ids are ASCII and lower-case dotted', () => {
    const schemes = plistArray(infoPlist, 'CFBundleURLSchemes')!;
    for (const s of schemes) expect(s).toMatch(/^[a-z0-9.-]+$/);
    const { googleIosClientId, googleWebClientId } = getRuntimePublicConfig();
    for (const id of [googleIosClientId, googleWebClientId]) {
      expect(id).toMatch(/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/);
    }
  });
});
