/**
 * App Store compliance sweep — static iOS/runtime configuration.
 *
 * Pins the release invariants App Review checks before any screen renders:
 * usage-description strings for every sensitive capability the native layer
 * touches, the export-compliance declaration, the Sign in with Apple
 * entitlement (Google sign-in is offered, App Review 4.8), the privacy
 * manifest's required-reason API declarations with valid reason codes, and
 * the public legal endpoints the paywall links to (App Review 3.1.2).
 */
import { getRuntimePublicConfig } from '../../src/config/runtimeConfig';

// The mobile tsconfig has no Node types (matches importedRealFootageAnalysis).
declare const require: (id: string) => unknown;
declare const __dirname: string;
type Fs = {
  readFileSync: (path: string, encoding: 'utf8') => string;
  readdirSync: (path: string) => string[];
  statSync: (path: string) => { isDirectory(): boolean };
};
const { readFileSync, readdirSync, statSync } = require('fs') as Fs;
const { join } = require('path') as { join: (...parts: string[]) => string };

const MOBILE_ROOT = join(__dirname, '..', '..');
const IOS_APP = join(MOBILE_ROOT, 'ios', 'PickleSensei');

function read(relativePath: string): string {
  return readFileSync(join(MOBILE_ROOT, relativePath), 'utf8');
}

function plistString(plist: string, key: string): string | null {
  const match = new RegExp(
    `<key>${key}</key>\\s*<string>([^<]*)</string>`,
  ).exec(plist);
  return match?.[1] ?? null;
}

function plistBool(plist: string, key: string): boolean | null {
  const match = new RegExp(`<key>${key}</key>\\s*<(true|false)/>`).exec(plist);
  return match ? match[1] === 'true' : null;
}

const pbxproj = read('ios/PickleSensei.xcodeproj/project.pbxproj');

function pbxSection(name: string): string {
  const match = new RegExp(
    `/\\* Begin ${name} section \\*/([\\s\\S]*?)/\\* End ${name} section \\*/`,
  ).exec(pbxproj);
  if (!match) throw new Error(`pbxproj: no ${name} section`);
  return match[1]!;
}

/** buildSettings of the app target's configurations (the ones carrying
 * PRODUCT_BUNDLE_IDENTIFIER), keyed by configuration name. */
function appBuildConfigurations(): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  const block =
    /isa = XCBuildConfiguration;\s*(?:baseConfigurationReference = [^;]*;\s*)?buildSettings = \{([\s\S]*?)\n\t\t\t\};\s*name = (\w+);/g;
  for (const m of pbxSection('XCBuildConfiguration').matchAll(block)) {
    const settings: Record<string, string> = {};
    for (const line of m[1]!.split('\n')) {
      const kv = /^\s*([A-Z_][A-Z0-9_]*) = (.*);$/.exec(line);
      if (kv) settings[kv[1]!] = kv[2]!;
    }
    if (settings.PRODUCT_BUNDLE_IDENTIFIER) out.set(m[2]!, settings);
  }
  return out;
}

/** PBXBuildFile ids listed in the (single) PBXResourcesBuildPhase. */
function resourcesPhaseFileIds(): string[] {
  const files = /files = \(([\s\S]*?)\);/.exec(
    pbxSection('PBXResourcesBuildPhase'),
  )?.[1];
  if (files === undefined) throw new Error('pbxproj: no Resources phase');
  return Array.from(files.matchAll(/([0-9A-F]{24})/g), m => m[1]!);
}

describe('Info.plist usage descriptions and export compliance', () => {
  const plist = readFileSync(join(IOS_APP, 'Info.plist'), 'utf8');

  it.each([
    'NSCameraUsageDescription',
    'NSMicrophoneUsageDescription',
    'NSPhotoLibraryUsageDescription',
  ])('%s is a real sentence, not a placeholder', key => {
    const value = plistString(plist, key);
    expect(value).not.toBeNull();
    expect(value!.length).toBeGreaterThan(40);
    expect(value).toMatch(/Pickle Sensei/);
    expect(value).not.toMatch(/TODO|lorem|placeholder|coming soon/i);
  });

  it('declares ITSAppUsesNonExemptEncryption=false', () => {
    expect(plistBool(plist, 'ITSAppUsesNonExemptEncryption')).toBe(false);
  });

  it('keeps App Transport Security strict (no arbitrary loads)', () => {
    expect(plistBool(plist, 'NSAllowsArbitraryLoads')).toBe(false);
  });

  it('registers the reversed Google iOS client id as a URL scheme', () => {
    const { googleIosClientId } = getRuntimePublicConfig();
    expect(googleIosClientId).toMatch(/\.apps\.googleusercontent\.com$/);
    const reversed = googleIosClientId!.split('.').reverse().join('.');
    expect(plist).toContain(`<string>${reversed}</string>`);
  });
});

describe('Sign in with Apple entitlement (Google sign-in is offered)', () => {
  it('declares com.apple.developer.applesignin in the entitlements file', () => {
    const entitlements = readFileSync(
      join(IOS_APP, 'PickleSensei.entitlements'),
      'utf8',
    );
    expect(entitlements).toMatch(
      /<key>com\.apple\.developer\.applesignin<\/key>\s*<array>\s*<string>Default<\/string>/,
    );
  });

  it('wires the entitlements file into every build configuration', () => {
    const configurations = appBuildConfigurations();
    expect(Array.from(configurations.keys()).sort()).toEqual([
      'Debug',
      'Release',
    ]);
    for (const [name, settings] of configurations) {
      expect([name, settings.CODE_SIGN_ENTITLEMENTS]).toEqual([
        name,
        'PickleSensei/PickleSensei.entitlements',
      ]);
    }
  });

  it('the sign-in screen offers Apple on iOS alongside Google', () => {
    const source = read('src/screens/SignInScreen.tsx');
    expect(source).toContain('label="Continue with Apple"');
    expect(source).toContain('label="Continue with Google"');
    expect(source).toMatch(
      /Platform\.OS === 'ios'\s*\?\s*\(\s*<ProviderButton/,
    );
  });
});

describe('PrivacyInfo.xcprivacy required-reason APIs', () => {
  const manifest = readFileSync(join(IOS_APP, 'PrivacyInfo.xcprivacy'), 'utf8');

  // Apple's approved reason codes per accessed-API category.
  const APPROVED_REASONS: Record<string, string[]> = {
    NSPrivacyAccessedAPICategoryUserDefaults: ['CA92.1', '1C8F.1', 'C56D.1'],
    NSPrivacyAccessedAPICategoryFileTimestamp: [
      'DDA9.1',
      'C617.1',
      '3B52.1',
      '0A2A.1',
    ],
    NSPrivacyAccessedAPICategorySystemBootTime: ['35F9.1', '8FFB.1', '3D61.1'],
    NSPrivacyAccessedAPICategoryDiskSpace: [
      '85F4.1',
      'E174.1',
      '7D9E.1',
      'B728.1',
    ],
    NSPrivacyAccessedAPICategoryActiveKeyboards: ['3EC4.1', '54BD.1'],
  };

  function declaredCategories(): Array<{ type: string; reasons: string[] }> {
    const entries: Array<{ type: string; reasons: string[] }> = [];
    const dictPattern =
      /<key>NSPrivacyAccessedAPIType<\/key>\s*<string>([^<]+)<\/string>\s*<key>NSPrivacyAccessedAPITypeReasons<\/key>\s*<array>([\s\S]*?)<\/array>/g;
    let match: RegExpExecArray | null;
    while ((match = dictPattern.exec(manifest)) !== null) {
      const reasons = Array.from(
        match[2]!.matchAll(/<string>([^<]+)<\/string>/g),
        m => m[1]!,
      );
      entries.push({ type: match[1]!, reasons });
    }
    return entries;
  }

  it('declares the categories React Native core touches', () => {
    const types = declaredCategories().map(entry => entry.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'NSPrivacyAccessedAPICategoryUserDefaults',
        'NSPrivacyAccessedAPICategoryFileTimestamp',
        'NSPrivacyAccessedAPICategorySystemBootTime',
      ]),
    );
  });

  it('every declared category carries at least one approved reason code', () => {
    const entries = declaredCategories();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const approved = APPROVED_REASONS[entry.type];
      expect(approved).toBeDefined();
      expect(entry.reasons.length).toBeGreaterThan(0);
      for (const reason of entry.reasons) {
        expect(approved).toContain(reason);
      }
    }
  });

  it('declares no tracking and is bundled as an app resource', () => {
    expect(manifest).toMatch(/<key>NSPrivacyTracking<\/key>\s*<false\/>/);
    // The PBXBuildFile entry alone ships nothing: its id must be listed in the
    // Resources build phase's `files` for Xcode to copy the manifest.
    const fileRef =
      /([0-9A-F]{24}) \/\* PrivacyInfo\.xcprivacy \*\/ = \{isa = PBXFileReference;/.exec(
        pbxSection('PBXFileReference'),
      )?.[1];
    expect(fileRef).toBeDefined();
    const buildFile = new RegExp(
      `([0-9A-F]{24}) /\\* [^*]* \\*/ = \\{isa = PBXBuildFile; fileRef = ${fileRef} `,
    ).exec(pbxSection('PBXBuildFile'))?.[1];
    expect(buildFile).toBeDefined();
    expect(resourcesPhaseFileIds()).toContain(buildFile);
  });

  it('declares RevenueCat purchase history and linked user id for functionality and analytics', () => {
    const entryFor = (type: string) => {
      const match = new RegExp(
        `<string>${type}</string>[\\s\\S]*?<key>NSPrivacyCollectedDataTypePurposes</key>\\s*<array>([\\s\\S]*?)</array>`,
      ).exec(manifest);
      expect(match).not.toBeNull();
      return match![1]!;
    };
    for (const type of [
      'NSPrivacyCollectedDataTypeUserID',
      'NSPrivacyCollectedDataTypePurchaseHistory',
    ]) {
      const purposes = entryFor(type);
      expect(purposes).toContain(
        'NSPrivacyCollectedDataTypePurposeAppFunctionality',
      );
      expect(purposes).toContain('NSPrivacyCollectedDataTypePurposeAnalytics');
    }
  });
});

describe('runtime config: paywall legal links (App Review 3.1.2)', () => {
  it('points Terms and Privacy at the public legal API endpoints', () => {
    const config = getRuntimePublicConfig();
    expect(config.apiBaseUrl).toMatch(/^https:\/\//);
    expect(config.legalTermsUrl).toBe(`${config.apiBaseUrl}/terms`);
    expect(config.legalPrivacyUrl).toBe(`${config.apiBaseUrl}/privacy`);
  });

  it('the API function serves GET /privacy and GET /terms without auth', () => {
    const legal = readFileSync(
      join(MOBILE_ROOT, '..', '..', 'supabase', 'functions', 'api', 'legal.ts'),
      'utf8',
    );
    expect(legal).toMatch(/privacy/i);
    expect(legal).toMatch(/terms/i);
    const index = readFileSync(
      join(MOBILE_ROOT, '..', '..', 'supabase', 'functions', 'api', 'index.ts'),
      'utf8',
    );
    expect(index).toMatch(/\/privacy/);
    expect(index).toMatch(/\/terms/);
  });

  it('the RootNavigator Paywall route passes both legal handlers', () => {
    const source = read('src/navigation/RootNavigator.tsx');
    expect(source).toMatch(
      /onOpenTerms: \(\) =>\s*void openLegalPage\('Terms of use', legalTermsUrl\)/,
    );
    expect(source).toMatch(
      /onOpenPrivacy: \(\) =>\s*void openLegalPage\('Privacy policy', legalPrivacyUrl\)/,
    );
    // The helper actually opens the URL and explains a failure instead of
    // swallowing it.
    expect(source).toMatch(/await Linking\.openURL\(url\)/);
    expect(source).toMatch(/could not be opened/);
  });
});

describe('no Live Court remnants or placeholder UI in the shipped tree', () => {
  it('RootNavigator registers no Live Court routes', () => {
    const source = read('src/navigation/RootNavigator.tsx');
    expect(source).not.toMatch(/LiveCourt|LiveSummary|GameplayProgress/);
    const params = read('src/navigation/params.ts');
    expect(params).not.toMatch(/LiveCourt|LiveSummary|GameplayProgress/);
  });

  it('the Add tab route is only ever handled by the custom tab bar', () => {
    // The tab bar swaps the Add slot for the Coach FAB and never navigates
    // to it, so its empty portal component is unreachable by users.
    const tabBar = read('src/navigation/PremiumTabBar.tsx');
    expect(tabBar).toMatch(/if \(name === 'Add'\) \{/);
    expect(tabBar).not.toMatch(/navigate\(\s*'Add'/);
    const navigator = read('src/navigation/RootNavigator.tsx');
    expect(navigator).not.toMatch(/linking=|initialState=/);
  });

  it('no screen ships "coming soon" or dead-handler copy', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry)) files.push(full);
      }
    };
    walk(join(MOBILE_ROOT, 'src'));
    const offenders = files.filter(file => {
      const text = readFileSync(file, 'utf8');
      return (
        /coming soon|under construction|lorem ipsum/i.test(text) ||
        /onPress=\{\(\) => \{\}\}/.test(text)
      );
    });
    expect(offenders).toEqual([]);
  });
});
