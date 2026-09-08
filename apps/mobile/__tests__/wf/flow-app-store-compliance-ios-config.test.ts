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

describe('mobile lockfile toolchain metadata', () => {
  it('keeps the app, root lock record, and locked React Native engine ranges aligned', () => {
    const manifest = JSON.parse(read('package.json'));
    const lock = JSON.parse(read('package-lock.json'));
    expect(manifest.engines.node).toBe(lock.packages[''].engines.node);
    expect(manifest.engines.node).toBe(
      lock.packages['node_modules/react-native'].engines.node,
    );
  });

  it('records the CocoaPods version selected by the Ruby bundle', () => {
    const gemVersion = read('Gemfile.lock').match(
      /^ {4}cocoapods \(([^)]+)\)$/m,
    )?.[1];
    const podVersion =
      read('ios/Podfile.lock').match(/^COCOAPODS: (.+)$/m)?.[1];
    expect(gemVersion).toBeDefined();
    expect(podVersion).toBe(gemVersion);
  });
});

describe('iOS native dependency and redistribution resource configuration', () => {
  type Reference = string | { value: string };
  type PbxObject = {
    isa: string;
    name?: string;
    path?: string;
    sourceTree?: string;
    lastKnownFileType?: string;
    fileRef?: string;
    productRef?: string;
    mainGroup?: string;
    children?: Reference[];
    files?: Reference[];
    buildPhases?: Reference[];
    buildConfigurationList?: string;
    buildConfigurations?: Reference[];
    baseConfigurationReference?: string;
    packageReferences?: Reference[];
    packageProductDependencies?: Reference[];
    runOnlyForDeploymentPostprocessing?: number;
    shellScript?: string;
    buildSettings?: {
      IPHONEOS_DEPLOYMENT_TARGET?: string;
      OTHER_LDFLAGS?: string[];
    };
  };
  const { parse } = require('xcode/lib/parser/pbxproj') as {
    parse(source: string): {
      project: {
        objects: Record<string, Record<string, PbxObject | string>>;
      };
    };
  };
  const pbxproj = read('ios/PickleSensei.xcodeproj/project.pbxproj');
  const sections = parse(pbxproj).project.objects;
  const objects = (isa: string) =>
    Object.entries(sections[isa] ?? {}).flatMap(([id, value]) =>
      typeof value === 'string' ? [] : [{ id, ...value }],
    );
  const ids = (values: Reference[] = []) =>
    values.map(value => (typeof value === 'string' ? value : value.value));
  const unquote = (value: string | undefined) => value?.replace(/^"|"$/g, '');
  const object = (isa: string, id: string | undefined) => {
    const result = objects(isa).find(value => value.id === id);
    if (!result) throw new Error(`Missing ${isa} reference: ${id}`);
    expect(result.isa).toBe(isa);
    return result;
  };
  const app = () => {
    const targets = objects('PBXNativeTarget');
    expect(targets).toHaveLength(1);
    expect(targets[0]?.name).toBe('PickleSensei');
    return targets[0]!;
  };
  const project = () => {
    const projects = objects('PBXProject');
    expect(projects).toHaveLength(1);
    return projects[0]!;
  };
  const phaseFiles = (isa: string) => {
    const phases = objects(isa).filter(phase =>
      ids(app().buildPhases).includes(phase.id),
    );
    expect(phases).toHaveLength(1);
    expect(phases[0]?.runOnlyForDeploymentPostprocessing).toBe(0);
    return ids(phases[0]!.files).map(id => {
      const buildFile = object('PBXBuildFile', id);
      expect(buildFile.productRef).toBeUndefined();
      return object('PBXFileReference', buildFile.fileRef);
    });
  };

  it('has no native Supabase package, product object, or framework link', () => {
    // CocoaPods removes an empty optional list when normalizing the project.
    // Both representations mean no package references; the object and link
    // assertions below still reject every native SwiftPM dependency.
    expect(project().packageReferences ?? []).toEqual([]);
    expect(app().packageProductDependencies ?? []).toEqual([]);
    expect(objects('XCRemoteSwiftPackageReference')).toEqual([]);
    expect(objects('XCLocalSwiftPackageReference')).toEqual([]);
    expect(objects('XCSwiftPackageProductDependency')).toEqual([]);
    expect(objects('PBXBuildFile').filter(file => file.productRef)).toEqual([]);
    expect(pbxproj).not.toMatch(
      /supabase-swift|\b(?:Auth|Functions|PostgREST|Realtime|Storage|Supabase)\b/,
    );
    expect(
      phaseFiles('PBXFrameworksBuildPhase').map(file => unquote(file.path)),
    ).toEqual(['libPods-PickleSensei.a']);
  });

  it('retains a valid empty SwiftPM lockfile instead of stale transitive pins', () => {
    const resolved = JSON.parse(
      read(
        'ios/PickleSensei.xcworkspace/xcshareddata/swiftpm/Package.resolved',
      ),
    );
    expect(resolved.version).toBe(3);
    expect(resolved.originHash).toEqual(expect.any(String));
    expect(resolved.pins).toEqual([]);
  });

  it('keeps all project and app configurations at iOS 15.1 with CocoaPods linker settings', () => {
    expect(objects('XCBuildConfiguration')).toHaveLength(4);
    for (const owner of [project(), app()]) {
      const list = object('XCConfigurationList', owner.buildConfigurationList);
      const configurations = ids(list.buildConfigurations).map(id =>
        object('XCBuildConfiguration', id),
      );
      expect(configurations.map(config => config.name).sort()).toEqual([
        'Debug',
        'Release',
      ]);
      for (const config of configurations) {
        expect(config.buildSettings?.IPHONEOS_DEPLOYMENT_TARGET).toBe('15.1');
        if (owner.isa === 'PBXNativeTarget') {
          expect(config.buildSettings?.OTHER_LDFLAGS?.map(unquote)).toEqual([
            '$(inherited)',
            '-ObjC',
            '-lc++',
          ]);
          const base = object(
            'PBXFileReference',
            config.baseConfigurationReference,
          );
          expect(unquote(base.path)).toBe(
            `Target Support Files/Pods-PickleSensei/Pods-PickleSensei.${config.name!.toLowerCase()}.xcconfig`,
          );
        }
      }
    }
    expect(read('ios/Podfile')).toMatch(
      /^platform :ios, min_ios_version_supported$/m,
    );
    expect(
      read('node_modules/react-native/scripts/cocoapods/helpers.rb'),
    ).toMatch(/def self\.min_ios_version_supported\s+return '15\.1'/);
    expect(read('ios/LocalPods/PickleNative/PickleNative.podspec')).toMatch(
      /s\.platforms\s*=\s*\{ :ios => "15\.1" \}/,
    );
  });

  it('retains the static native bridges including Google AppAuth, Keychain, RevenueCat, and dormant Sentry', () => {
    const podfile = read('ios/Podfile');
    expect(podfile).toContain("ENV['RCT_NEW_ARCH_ENABLED'] = '1'");
    expect(podfile).toContain(
      "pod 'PickleNative', :path => 'LocalPods/PickleNative'",
    );
    expect(podfile).toContain('config = use_native_modules!');
    expect(podfile).toContain('use_react_native!(');
    expect(podfile).toContain("linkage = ENV['USE_FRAMEWORKS']");
    expect(podfile).toContain('if linkage != nil');
    expect(podfile).toContain('use_frameworks! :linkage => linkage.to_sym');
    for (const name of ['GoogleUtilities', 'RecaptchaInterop']) {
      expect(podfile).toContain(`pod '${name}', :modular_headers => true`);
    }
    const pods = read('ios/Podfile.lock');
    for (const name of [
      'PickleNative',
      'RNGoogleSignin',
      'GoogleSignIn',
      'AppAuth',
      'GTMAppAuth',
      'RNKeychain',
      'RNPurchases',
      'PurchasesHybridCommon',
      'RevenueCat',
      'RNSentry',
      'op-sqlite',
      'RNNotifee',
      'RNScreens',
      'RNReanimated',
      'RNWorklets',
      'hermes-engine',
    ]) {
      expect(pods).toMatch(new RegExp(`^ {2}- ${name} \\([^)]+\\)`, 'm'));
    }
    expect(pods).not.toMatch(
      /^ {2}- (?:Supabase|Auth|Functions|PostgREST|Realtime|Storage)(?:\/|\s|\()/m,
    );
  });

  it.each([
    ['ThirdPartyNotices.txt', 'text', false],
    ['SentryPrivacy.bundle', 'wrapper.cfbundle', true],
  ] as const)(
    'binds %s from the legal assets to the app resource phase',
    (name, type, directory) => {
      const path = `../assets/legal/${name}`;
      const files = objects('PBXFileReference').filter(
        file => unquote(file.path) === path,
      );
      expect(files).toHaveLength(1);
      const file = files[0]!;
      expect(file.lastKnownFileType).toBe(type);
      expect(unquote(file.sourceTree)).toBe('<group>');
      expect(file.children).toBeUndefined();
      const groups = objects('PBXGroup').filter(
        group => group.name === 'Resources',
      );
      expect(groups).toHaveLength(1);
      const group = groups[0]!;
      expect(group.path).toBeUndefined();
      expect(unquote(group.sourceTree)).toBe('<group>');
      expect(ids(object('PBXGroup', project().mainGroup).children)).toContain(
        group.id,
      );
      expect(ids(group.children).filter(id => id === file.id)).toHaveLength(1);
      expect(
        phaseFiles('PBXResourcesBuildPhase').filter(ref => ref.id === file.id),
      ).toHaveLength(1);
      expect(
        objects('PBXBuildFile').filter(ref => ref.fileRef === file.id),
      ).toHaveLength(1);
      expect(
        statSync(join(MOBILE_ROOT, 'assets', 'legal', name)).isDirectory(),
      ).toBe(directory);
    },
  );

  it('preserves the app privacy, launch, and font resources without bundling audit metadata or sources', () => {
    expect(
      phaseFiles('PBXResourcesBuildPhase')
        .map(file => unquote(file.path))
        .sort(),
    ).toEqual(
      [
        'PickleSensei/LaunchScreen.storyboard',
        'PickleSensei/Images.xcassets',
        'PickleSensei/PrivacyInfo.xcprivacy',
        '../assets/fonts/Manrope_400Regular.ttf',
        '../assets/fonts/Manrope_500Medium.ttf',
        '../assets/fonts/Manrope_600SemiBold.ttf',
        '../assets/fonts/Manrope_700Bold.ttf',
        '../assets/legal/ThirdPartyNotices.txt',
        '../assets/legal/SentryPrivacy.bundle',
      ].sort(),
    );
    expect(
      phaseFiles('PBXSourcesBuildPhase').map(file => unquote(file.path)),
    ).toEqual(['PickleSensei/AppDelegate.swift']);
    expect(pbxproj).not.toMatch(/sources\.json|generate-third-party-notices/);
    expect(
      objects('PBXFileReference')
        .map(file => unquote(file.path))
        .filter(path => path?.endsWith('PrivacyInfo.xcprivacy')),
    ).toEqual(['PickleSensei/PrivacyInfo.xcprivacy']);
  });

  it('keeps the vendor privacy manifest inside an intact bundle, separate from the app manifest', () => {
    expect(
      readdirSync(
        join(MOBILE_ROOT, 'assets/legal/SentryPrivacy.bundle'),
      ).sort(),
    ).toEqual(['Info.plist', 'PrivacyInfo.xcprivacy']);
    expect(
      plistString(
        read('assets/legal/SentryPrivacy.bundle/Info.plist'),
        'CFBundlePackageType',
      ),
    ).toBe('BNDL');
    const vendor = read(
      'assets/legal/SentryPrivacy.bundle/PrivacyInfo.xcprivacy',
    );
    const appPrivacy = read('ios/PickleSensei/PrivacyInfo.xcprivacy');
    for (const category of [
      'NSPrivacyCollectedDataTypeCrashData',
      'NSPrivacyCollectedDataTypePerformanceData',
      'NSPrivacyCollectedDataTypeOtherDiagnosticData',
    ]) {
      expect(vendor).toContain(`<string>${category}</string>`);
      expect(appPrivacy).not.toContain(`<string>${category}</string>`);
    }
  });

  it('adds no build-time network phase and leaves Sentry collection and uploads disabled', () => {
    const scripts = objects('PBXShellScriptBuildPhase');
    expect(scripts.map(script => unquote(script.name)).sort()).toEqual(
      [
        '[CP] Check Pods Manifest.lock',
        '[CP] Embed Pods Frameworks',
        '[CP] Copy Pods Resources',
        'Bundle React Native code and images',
        'Sentry symbols (upload blocked)',
      ].sort(),
    );
    for (const script of scripts) {
      expect(ids(app().buildPhases)).toContain(script.id);
      expect(script.shellScript).not.toMatch(
        /\bcurl\b|\bwget\b|sentry-cli|upload-dsym|https?:\/\//,
      );
    }
    const symbols = scripts.find(
      script => unquote(script.name) === 'Sentry symbols (upload blocked)',
    );
    const bundleScript = read('src/diagnostics/bundle-xcode.sh');
    for (const setting of [
      'SENTRY_DISABLE_AUTO_UPLOAD',
      'SENTRY_DISABLE_XCODE_DEBUG_UPLOAD',
    ]) {
      expect(symbols?.shellScript).toContain(`export ${setting}=true`);
      expect(bundleScript).toContain(`export ${setting}=true`);
    }
    expect(getRuntimePublicConfig().diagnostics).toMatchObject({
      transportEnabled: false,
      providerApproved: false,
      disclosuresApproved: false,
      nativePrivacyApproved: false,
      dsn: null,
    });
    expect(read('ios/PickleSensei/AppDelegate.swift')).not.toMatch(/Sentry/);
  });
});

describe('V1 analysis boundary', () => {
  it('excludes future 3D analysis and review entry points from the v1 sources', () => {
    const violations: string[] = [];
    let inspected = 0;
    const forbidden =
      /\b(?:motion_3d|PickleMotion3D|PickleMotionReviewView|AppleMotion3DReconstructor|Experimental3DComparison|VNDetectHumanBodyPose3DRequest)\b/;
    const inspect = (directory: string) => {
      for (const entry of readdirSync(directory)) {
        const file = join(directory, entry);
        if (statSync(file).isDirectory()) {
          inspect(file);
        } else if (/\.(?:tsx?|swift|[mh])$/.test(entry)) {
          inspected += 1;
          if (forbidden.test(readFileSync(file, 'utf8'))) violations.push(file);
        }
      }
    };
    for (const directory of [
      join(MOBILE_ROOT, 'src'),
      join(MOBILE_ROOT, 'ios', 'LocalPods', 'PickleNative', 'Sources'),
      join(MOBILE_ROOT, '..', '..', 'native', 'vision-core', 'Sources'),
      join(MOBILE_ROOT, '..', '..', 'packages', 'analysis-pipeline', 'src'),
    ])
      inspect(directory);
    expect(inspected).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});

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
    const pbxproj = read('ios/PickleSensei.xcodeproj/project.pbxproj');
    const wired = pbxproj.match(
      /CODE_SIGN_ENTITLEMENTS = PickleSensei\/PickleSensei\.entitlements;/g,
    );
    expect(wired?.length ?? 0).toBeGreaterThanOrEqual(2);
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

  it('declares local disk-space checks used to refuse imports that cannot be saved', () => {
    const mediaStore = read(
      'ios/LocalPods/PickleNative/Sources/ClipMediaStore.swift',
    );
    expect(mediaStore).toContain('volumeAvailableCapacityForImportantUsage');
    const diskSpace = declaredCategories().find(
      entry => entry.type === 'NSPrivacyAccessedAPICategoryDiskSpace',
    );
    expect(diskSpace?.reasons).toEqual(['E174.1']);
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
    const pbxproj = read('ios/PickleSensei.xcodeproj/project.pbxproj');
    expect(pbxproj).toMatch(/PrivacyInfo\.xcprivacy in Resources/);
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
