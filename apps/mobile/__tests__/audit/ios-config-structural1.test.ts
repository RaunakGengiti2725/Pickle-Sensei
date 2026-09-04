/**
 * Structural audit — subsystem `mobile-ios-config` (pass 1 of 3).
 *
 * Static, Linux-runnable coherence checks over the iOS project files, the
 * shared Xcode scheme, the SwiftPM/CocoaPods dependency declarations, the
 * runtime public config, and the release manifest. Every `DEFECT` block pins a
 * contract the shipped tree violates at the audited commit; every `GUARD`
 * block pins an invariant that was verified to hold so a later change cannot
 * silently break it.
 *
 * Nothing here claims Xcode/Swift/iOS runtime behaviour — those facts come
 * from the Mac artifacts (mac-full-verify run 33841813597 on 4d812e1a) and
 * are cited in the audit report, not asserted from Linux.
 */
import { getRuntimePublicConfig } from '../../src/config/runtimeConfig';

// The mobile tsconfig ships no Node types (same pattern as the wf/ suites).
declare const require: (id: string) => unknown;
declare const __dirname: string;
interface DirEntry {
  name: string;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}
const fs = require('fs') as {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string, encoding: 'utf8') => string;
  readdirSync: (p: string, options: { withFileTypes: true }) => DirEntry[];
  statSync: (p: string) => { isDirectory(): boolean; isFile(): boolean };
};
const path = require('path') as {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
  basename: (p: string, ext?: string) => string;
};
const crypto = require('crypto') as {
  createHash: (algorithm: string) => {
    update: (data: string) => { digest: (encoding: 'hex') => string };
  };
};

const MOBILE_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(MOBILE_ROOT, '..', '..');
const IOS_ROOT = path.join(MOBILE_ROOT, 'ios');
const APP_DIR = path.join(IOS_ROOT, 'PickleSensei');
const POD_SOURCES = path.join(IOS_ROOT, 'LocalPods', 'PickleNative', 'Sources');

const read = (abs: string): string => fs.readFileSync(abs, 'utf8');
const readMobile = (rel: string): string => read(path.join(MOBILE_ROOT, rel));
const readRepo = (rel: string): string => read(path.join(REPO_ROOT, rel));

const pbxproj = readMobile('ios/PickleSensei.xcodeproj/project.pbxproj');
const scheme = readMobile(
  'ios/PickleSensei.xcodeproj/xcshareddata/xcschemes/PickleSensei.xcscheme',
);
const infoPlist = readMobile('ios/PickleSensei/Info.plist');
const appDelegate = readMobile('ios/PickleSensei/AppDelegate.swift');
const podspec = readMobile('ios/LocalPods/PickleNative/PickleNative.podspec');
const podfile = readMobile('ios/Podfile');
const podfileLock = readMobile('ios/Podfile.lock');
const packageResolved = readMobile(
  'ios/PickleSensei.xcworkspace/xcshareddata/swiftpm/Package.resolved',
);
const entitlements = readMobile('ios/PickleSensei/PickleSensei.entitlements');
const appJson = JSON.parse(readMobile('app.json')) as {
  name: string;
  displayName: string;
};
const indexJs = readMobile('index.js');
const dossier = readRepo('docs/APP_STORE_SUBMISSION.md');
const releaseManifest = JSON.parse(
  readRepo('infra/release/release-manifest.json'),
) as {
  versionScheme: { marketingVersion: string; buildNumber: number };
  environments: Record<
    string,
    { apiOrigin: string | null; mobileConfig?: string }
  >;
};

// ─── pbxproj / plist parsing helpers ─────────────────────────────────────────

function pbxSection(name: string): string {
  const match = new RegExp(
    `/\\* Begin ${name} section \\*/([\\s\\S]*?)/\\* End ${name} section \\*/`,
  ).exec(pbxproj);
  expect(match).not.toBeNull();
  return match![1]!;
}

// Object headers (`<24-hex id> <comment> = {`) inside one pbxproj section.
function pbxObjects(section: string): Array<{ id: string; comment: string }> {
  return Array.from(
    section.matchAll(/^\s*([0-9A-F]{24}) \/\* ([^*]+?) \*\/ = \{/gm),
    m => ({ id: m[1]!, comment: m[2]!.trim() }),
  );
}

function plistArray(plist: string, key: string): string[] | null {
  const match = new RegExp(
    `<key>${key.replace(/~/g, '~')}</key>\\s*<array>([\\s\\S]*?)</array>`,
  ).exec(plist);
  if (!match) return null;
  return Array.from(
    match[1]!.matchAll(/<string>([^<]*)<\/string>/g),
    m => m[1]!,
  );
}

function plistKeys(plist: string): string[] {
  return Array.from(plist.matchAll(/<key>([^<]+)<\/key>/g), m => m[1]!);
}

function walkSwift(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    // Symlinks (LocalPods/PickleNative/Sources/Core → native/…) resolve
    // through statSync, exactly as CocoaPods reads them.
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walkSwift(full, out);
    else if (stat.isFile() && entry.name.endsWith('.swift')) out.push(full);
  }
  return out;
}

/** Module names imported by a Swift source (`import X`, `import class X.Y`,
 * `@testable import X`, `@_exported import X`). */
function swiftImports(source: string): string[] {
  return Array.from(
    source.matchAll(
      /^\s*(?:@\w+\s+)*import\s+(?:(?:class|struct|enum|protocol|func|var|let|typealias)\s+)?(\w+)/gm,
    ),
    m => m[1]!,
  );
}

const nativeTargets = pbxObjects(pbxSection('PBXNativeTarget'));
const appTarget = nativeTargets.find(t => t.comment === 'PickleSensei');

/** All Swift sources the app binary is built from: the app target's own
 * sources plus the local PickleNative pod (its podspec lists every file). */
const appSwiftSources = [...walkSwift(APP_DIR), ...walkSwift(POD_SOURCES)].map(
  file => ({ file, imports: swiftImports(read(file)) }),
);

// ═════════════════════════════════════════════════════════════════════════════
// DEFECT 1 — shared scheme references a test target the project does not have
// ═════════════════════════════════════════════════════════════════════════════

describe('DEFECT: PickleSensei.xcscheme ⇄ project.pbxproj target coherence', () => {
  const buildables = Array.from(
    scheme.matchAll(
      /<BuildableReference\s[^>]*?BlueprintIdentifier = "([^"]+)"[^>]*?BuildableName = "([^"]+)"[^>]*?BlueprintName = "([^"]+)"[^>]*>/g,
    ),
    m => ({ blueprintId: m[1]!, buildableName: m[2]!, blueprintName: m[3]! }),
  );

  it('the scheme has at least the app buildable and the project has exactly one native target', () => {
    expect(appTarget).toBeDefined();
    expect(nativeTargets.map(t => t.comment)).toEqual(['PickleSensei']);
    // BuildAction, LaunchAction and ProfileAction each reference the app target.
    expect(buildables.filter(b => b.blueprintId === appTarget!.id).length).toBe(
      3,
    );
  });

  it('every BuildableReference in the shared scheme points at a native target declared in project.pbxproj', () => {
    const declaredIds = new Set(nativeTargets.map(t => t.id));
    const dangling = buildables.filter(b => !declaredIds.has(b.blueprintId));
    // Fails on 4d812e1a: TestAction → PickleSenseiTests
    // (00E356ED1AD99517003FC87E) which no longer exists in the project, so
    // `xcodebuild test -scheme PickleSensei` has no testable to run and Xcode
    // shows a missing-target testable in the scheme editor.
    expect(dangling).toEqual([]);
  });

  it('every BlueprintName the scheme names appears in project.pbxproj at all', () => {
    const missing = buildables
      .map(b => b.blueprintName)
      .filter(name => !pbxproj.includes(name));
    expect(missing).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// DEFECT 2 — SwiftPM products linked into the app that no Swift source uses
// ═════════════════════════════════════════════════════════════════════════════

describe('DEFECT: SwiftPM products linked into the app target are actually imported', () => {
  const spmProducts = Array.from(
    pbxSection('XCSwiftPackageProductDependency').matchAll(
      /productName = (\w+);/g,
    ),
    m => m[1]!,
  );
  const spmPackages = Array.from(
    pbxSection('XCRemoteSwiftPackageReference').matchAll(
      /repositoryURL = "([^"]+)";/g,
    ),
    m => m[1]!,
  );
  const frameworksPhase = pbxSection('PBXFrameworksBuildPhase');

  it('declares the SwiftPM products under audit and links them in the Frameworks phase', () => {
    expect(spmProducts.length).toBeGreaterThan(0);
    for (const product of spmProducts) {
      expect(frameworksPhase).toMatch(
        new RegExp(`/\\* ${product} in Frameworks \\*/`),
      );
    }
  });

  it('every linked SwiftPM product is imported by at least one Swift source compiled into the app', () => {
    const imported = new Set(appSwiftSources.flatMap(s => s.imports));
    const unused = spmProducts.filter(product => !imported.has(product));
    // Fails on 4d812e1a: Auth, Functions, PostgREST, Realtime, Storage and
    // Supabase (supabase-swift 2.55.1 + swift-crypto, swift-asn1,
    // swift-clocks, swift-http-types, swift-concurrency-extras,
    // xctest-dynamic-overlay) are linked into the Release binary while zero
    // Swift sources import them (the app talks to Supabase only through
    // fetch() in JS). Mac evidence: xcodebuild-build.log
    // 16914-16921 — ld links Supabase.o/Auth.o/… "built for newer
    // 'iOS-simulator' version (16.0) than being linked (15.1)", and
    // xcodebuild-resolve.log resolves 7 remote packages per build.
    expect(unused).toEqual([]);
  });

  it('every remote SwiftPM package linked into the binary is listed in the dossier "Third-party SDKs in binary" row', () => {
    const row = /\| Third-party SDKs in binary\s*\|([^|]*)\|/.exec(dossier);
    expect(row).not.toBeNull();
    const inventory = row![1]!.toLowerCase();
    const undeclared = spmPackages.filter(url => {
      const repo = path.basename(url.replace(/\.git$/, '')).toLowerCase();
      return !inventory.includes(repo);
    });
    // Fails on 4d812e1a: the dossier inventory is built from Podfile.lock +
    // package.json and never mentions supabase-swift, so the App Review
    // answer key under-reports what is in the binary.
    expect(undeclared).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// DEFECT 3 — iPad orientation list contradicts the iPhone-only, portrait-only
//            product decision (dossier §1: "iPhone-only, portrait-only")
// ═════════════════════════════════════════════════════════════════════════════

describe('DEFECT: Info.plist orientation declarations vs TARGETED_DEVICE_FAMILY = 1', () => {
  const base = plistArray(infoPlist, 'UISupportedInterfaceOrientations');
  const ipad = plistArray(infoPlist, 'UISupportedInterfaceOrientations~ipad');

  it('the app target is iPhone-only and portrait-only on iPhone', () => {
    expect(pbxproj).toMatch(/TARGETED_DEVICE_FAMILY = 1;/);
    expect(pbxproj).not.toMatch(/TARGETED_DEVICE_FAMILY = "1,2";/);
    expect(base).toEqual(['UIInterfaceOrientationPortrait']);
  });

  it('no ~ipad orientation variant widens the orientation set beyond the iPhone list', () => {
    // Fails on 4d812e1a: the RN template's ~ipad array (landscape left/right,
    // portrait upside-down) is still shipped in the built Info.plist
    // (Mac artifact PickleSensei-Info.plist) although the product is
    // iPhone-only and portrait-only. Dead today under device family 1, but
    // it is the ONE place a future "1,2" flip would silently ship landscape.
    const widened = (ipad ?? []).filter(o => !(base ?? []).includes(o));
    expect(widened).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// DEFECT 4 — release manifest describes an environment separation and build
//            numbering that runtimeConfig / fastlane / the dossier do not follow
// ═════════════════════════════════════════════════════════════════════════════

describe('DEFECT: infra/release/release-manifest.json ⇄ runtimeConfig.ts ⇄ dossier', () => {
  const config = getRuntimePublicConfig();

  it('the committed production API origin in runtimeConfig is the origin the manifest records for production', () => {
    expect(config.apiBaseUrl).toMatch(/^https:\/\//);
    const origin = new URL(config.apiBaseUrl!).origin;
    // Fails on 4d812e1a: production.apiOrigin is "tbd" (and release:check
    // ASSERTS it stays "tbd" so "a real production URL cannot land here
    // silently") while runtimeConfig.ts hardcodes the real production origin
    // that ships in every build. The control guards the wrong file.
    expect(releaseManifest.environments.production?.apiOrigin).toBe(origin);
  });

  it('the manifest does not describe runtimeConfig defaults as "all null" when they are production values', () => {
    const development = releaseManifest.environments.development;
    expect(development).toBeDefined();
    const claimsAllNull = /all null/i.test(development!.mobileConfig ?? '');
    const configured =
      config.apiBaseUrl !== null &&
      config.revenueCatPublicSdkKey !== null &&
      config.googleIosClientId !== null;
    // Fails on 4d812e1a: development.mobileConfig says
    // "runtimeConfig.ts defaults (all null; explicit not-configured state)".
    expect(claimsAllNull && configured).toBe(false);
  });

  it('the manifest buildNumber is the build the dossier records as validated on TestFlight', () => {
    const validated = /Build (\d+) was validated/.exec(dossier);
    expect(validated).not.toBeNull();
    // Fails on 4d812e1a: the manifest rule says buildNumber "MUST equal iOS
    // CURRENT_PROJECT_VERSION … never reused or reset", the committed value
    // is 1, and fastlane overrides CURRENT_PROJECT_VERSION at archive time
    // with latest_testflight_build_number + 1 — the dossier records build 3.
    // release:check passes because it compares two stale copies of "1".
    expect(releaseManifest.versionScheme.buildNumber).toBe(
      Number(validated![1]),
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GUARD — invariants verified to hold at 4d812e1a
// ═════════════════════════════════════════════════════════════════════════════

describe('GUARD: JS module name ⇄ AppDelegate ⇄ AppRegistry', () => {
  it('app.json name is the module AppDelegate starts and the one index.js registers', () => {
    expect(appJson.name).toBe('PickleSensei');
    expect(appDelegate).toContain(`withModuleName: "${appJson.name}"`);
    expect(indexJs).toMatch(
      /import \{ name as appName \} from '\.\/app\.json';/,
    );
    expect(indexJs).toMatch(/AppRegistry\.registerComponent\(appName, /);
  });

  it('the user-visible name is the dossier display name, sourced from Info.plist not app.json', () => {
    const display =
      /<key>CFBundleDisplayName<\/key>\s*<string>([^<]*)<\/string>/.exec(
        infoPlist,
      );
    expect(display?.[1]).toBe('Pickle Sensei');
  });
});

describe('GUARD: AppDelegate bundle source is Debug-only Metro, Release-only embedded bundle', () => {
  it('RCTBundleURLProvider is reachable only inside #if DEBUG and Release reads main.jsbundle', () => {
    const block = /#if DEBUG([\s\S]*?)#else([\s\S]*?)#endif/.exec(appDelegate);
    expect(block).not.toBeNull();
    const [, debugBranch, releaseBranch] = block!;
    expect(debugBranch).toContain('RCTBundleURLProvider');
    expect(releaseBranch).toContain(
      'Bundle.main.url(forResource: "main", withExtension: "jsbundle")',
    );
    const outside = appDelegate.replace(block![0], '');
    expect(outside).not.toContain('RCTBundleURLProvider');
    expect(outside).not.toContain('jsbundle');
  });

  it('the app never handles inbound URLs natively (no openURL / continue userActivity / scene delegate)', () => {
    expect(appDelegate).not.toMatch(/open url|openURL|continue userActivity/);
    expect(appDelegate).not.toMatch(
      /UISceneDelegate|configurationForConnecting/,
    );
    expect(infoPlist).not.toMatch(/UIApplicationSceneManifest/);
  });
});

describe('GUARD: runtimeConfig on an unsupported platform', () => {
  it('returns null for the RevenueCat key (never a demo origin) and still derives HTTPS legal/store URLs', () => {
    jest.isolateModules(() => {
      jest.doMock('react-native', () => ({ Platform: { OS: 'web' } }));
      const { getRuntimePublicConfig: getConfig } = jest.requireActual<
        typeof import('../../src/config/runtimeConfig')
      >('../../src/config/runtimeConfig');
      const cfg = getConfig();
      expect(cfg.revenueCatPublicSdkKey).toBeNull();
      expect(cfg.apiBaseUrl).toMatch(/^https:\/\//);
      expect(cfg.apiBaseUrl).not.toMatch(/localhost|127\.0\.0\.1|demo|example/);
      expect(cfg.legalPrivacyUrl).toBe(`${cfg.apiBaseUrl}/privacy`);
      expect(cfg.legalTermsUrl).toBe(`${cfg.apiBaseUrl}/terms`);
      expect(cfg.appStoreWriteReviewUrl).toBe(
        `https://apps.apple.com/app/id${cfg.appStoreId}?action=write-review`,
      );
      jest.dontMock('react-native');
    });
  });

  it('on iOS ships exactly the App Store public key and the dossier App Store id', () => {
    const cfg = getRuntimePublicConfig();
    expect(cfg.revenueCatPublicSdkKey).toMatch(/^appl_/);
    expect(cfg.appStoreId).toBe('6806918402');
    expect(cfg.appVersion).toBe(releaseManifest.versionScheme.marketingVersion);
  });
});

describe('GUARD: version and identity coherence', () => {
  it('MARKETING_VERSION / CURRENT_PROJECT_VERSION are identical in Debug and Release and sourced by Info.plist', () => {
    const marketing = new Set(
      Array.from(pbxproj.matchAll(/MARKETING_VERSION = ([\d.]+);/g), m => m[1]),
    );
    const build = new Set(
      Array.from(
        pbxproj.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g),
        m => m[1],
      ),
    );
    expect([...marketing]).toEqual([
      releaseManifest.versionScheme.marketingVersion,
    ]);
    expect([...build]).toEqual([
      String(releaseManifest.versionScheme.buildNumber),
    ]);
    expect(infoPlist).toMatch(
      /<key>CFBundleShortVersionString<\/key>\s*<string>\$\(MARKETING_VERSION\)<\/string>/,
    );
    expect(infoPlist).toMatch(
      /<key>CFBundleVersion<\/key>\s*<string>\$\(CURRENT_PROJECT_VERSION\)<\/string>/,
    );
  });

  it('bundle id, team and deployment target agree across pbxproj, Appfile, podspec and dossier', () => {
    const appfile = readMobile('ios/fastlane/Appfile');
    expect(appfile).toContain('app_identifier("com.picklesensei")');
    expect(appfile).toContain('team_id("H26U6W4K6V")');
    expect(
      new Set(pbxproj.match(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)),
    ).toEqual(new Set(['PRODUCT_BUNDLE_IDENTIFIER = com.picklesensei;']));
    expect(new Set(pbxproj.match(/DEVELOPMENT_TEAM = (\w+);/g))).toEqual(
      new Set(['DEVELOPMENT_TEAM = H26U6W4K6V;']),
    );
    const targets = new Set(
      Array.from(
        pbxproj.matchAll(/IPHONEOS_DEPLOYMENT_TARGET = ([\d.]+);/g),
        m => m[1],
      ),
    );
    expect([...targets]).toEqual(['15.1']);
    expect(podspec).toMatch(/s\.platforms\s*=\s*\{ :ios => "15\.1" \}/);
    expect(dossier).toMatch(/\| Minimum iOS\s*\|\s*15\.1\s*\|/);
  });

  it('Swift language mode agrees between the app target (SWIFT_VERSION) and the local pod (swift_version)', () => {
    const appSwift = new Set(
      Array.from(pbxproj.matchAll(/SWIFT_VERSION = ([\d.]+);/g), m => m[1]),
    );
    const podSwift = /s\.swift_version\s*=\s*"([\d.]+)"/.exec(podspec)?.[1];
    expect(appSwift.size).toBe(1);
    expect(podSwift).toBeDefined();
    // Both are Swift 5 language mode; 5.0 vs 5.9 select the same -swift-version 5.
    expect([...appSwift][0]!.split('.')[0]).toBe(podSwift!.split('.')[0]);
  });
});

describe('GUARD: CocoaPods / SwiftPM lock coherence (Linux-checkable part)', () => {
  it('Podfile.lock PODFILE CHECKSUM is the SHA-1 of the committed Podfile', () => {
    const recorded = /PODFILE CHECKSUM: ([0-9a-f]{40})/.exec(podfileLock)?.[1];
    const actual = crypto.createHash('sha1').update(podfile).digest('hex');
    expect(recorded).toBe(actual);
  });

  it('Podfile.lock records the local PickleNative pod and pins CocoaPods 1.15.2', () => {
    expect(podfileLock).toMatch(
      /PickleNative \(from `LocalPods\/PickleNative`\)/,
    );
    expect(podfileLock).toMatch(/^COCOAPODS: 1\.15\.2$/m);
  });

  it('every podspec source file (including the symlinked native/ Core sources) resolves to a real file', () => {
    const listed = Array.from(
      podspec.matchAll(/"Sources\/Core\/([\w]+\.swift)"/g),
      m => path.join(POD_SOURCES, 'Core', m[1]!),
    );
    expect(listed.length).toBeGreaterThan(0);
    const missing = listed.filter(
      f => !fs.existsSync(f) || !fs.statSync(f).isFile(),
    );
    expect(missing).toEqual([]);
    const linked = fs
      .readdirSync(path.join(POD_SOURCES, 'Core'), { withFileTypes: true })
      .filter(e => e.isSymbolicLink())
      .map(e => path.join(POD_SOURCES, 'Core', e.name))
      .sort();
    expect(linked).toEqual([...listed].sort());
  });

  it('Package.resolved pins every SwiftPM dependency to an exact revision', () => {
    const resolved = JSON.parse(packageResolved) as {
      pins: Array<{
        identity: string;
        state: { revision: string; version?: string };
      }>;
    };
    expect(resolved.pins.length).toBeGreaterThan(0);
    for (const pin of resolved.pins) {
      expect(pin.state.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(pin.state.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});

describe('GUARD: entitlements, ATS and resources', () => {
  it('the entitlements file declares exactly Sign in with Apple and nothing else', () => {
    expect(plistKeys(entitlements)).toEqual([
      'com.apple.developer.applesignin',
    ]);
  });

  it('ATS declares only the two documented keys: arbitrary loads off, local networking on (Metro in Debug)', () => {
    const ats =
      /<key>NSAppTransportSecurity<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(
        infoPlist,
      );
    expect(ats).not.toBeNull();
    expect(plistKeys(ats![1]!)).toEqual([
      'NSAllowsArbitraryLoads',
      'NSAllowsLocalNetworking',
    ]);
    expect(ats![1]).toMatch(/NSAllowsArbitraryLoads<\/key>\s*<false\/>/);
  });

  it('every UIAppFonts entry and the privacy manifest are copied by the Resources build phase', () => {
    const fonts = plistArray(infoPlist, 'UIAppFonts');
    expect(fonts?.length).toBe(4);
    const resources = pbxSection('PBXResourcesBuildPhase');
    for (const font of fonts!) {
      expect(resources).toContain(`/* ${font} in Resources */`);
    }
    expect(resources).toContain('/* PrivacyInfo.xcprivacy in Resources */');
  });

  it('the app requires arm64 only and declares no background modes', () => {
    expect(plistArray(infoPlist, 'UIRequiredDeviceCapabilities')).toEqual([
      'arm64',
    ]);
    expect(infoPlist).not.toMatch(/UIBackgroundModes/);
  });
});

describe('GUARD: index.js global error handling contract (static)', () => {
  it('installs handlers before registering the component and tolerates a missing ErrorUtils / HermesInternal', () => {
    const install = indexJs.indexOf('installGlobalErrorHandler();');
    const register = indexJs.indexOf('AppRegistry.registerComponent(');
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(register);
    expect(indexJs).toMatch(
      /if \(!errorUtils \|\| typeof errorUtils\.setGlobalHandler !== 'function'\) return;/,
    );
    expect(indexJs).toMatch(
      /if \(!hermes \|\| typeof hermes\.enablePromiseRejectionTracker !== 'function'\)/,
    );
  });

  it('the Hermes rejection-tracker API index.js relies on is the one React Native itself calls', () => {
    const polyfill = readMobile(
      'node_modules/react-native/Libraries/Core/polyfillPromise.js',
    );
    expect(polyfill).toContain('enablePromiseRejectionTracker');
    expect(indexJs).toContain('hermes.enablePromiseRejectionTracker({');
    expect(indexJs).toMatch(/allRejections: true/);
  });
});
