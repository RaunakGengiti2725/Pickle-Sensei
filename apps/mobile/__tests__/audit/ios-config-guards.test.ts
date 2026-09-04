/**
 * Adjudication pins — area `mobile-ios-config`, confirmed guard gaps
 * IOSCFG-3 / IOSCFG-4 / IOSCFG-5.
 *
 * These pass at 4d812e1a: the configuration itself is correct today. They
 * exist because tools/adjudicate/mobile-ios-config/mutate-guards.sh proved
 * that every existing Linux gate (check:distribution, the wf/ compliance
 * suites, tools/release/check-release-manifest.mjs) stays green when:
 *   IOSCFG-3  only the Release build configuration drifts (bundle id, team,
 *             MARKETING_VERSION, CURRENT_PROJECT_VERSION, device family,
 *             entitlements, DEBUG preprocessor/Swift flags) — in the target's
 *             own block, as a `KEY[sdk=iphoneos*]` conditional, or at the
 *             project level the target inherits from,
 *   IOSCFG-4  PrivacyInfo.xcprivacy is dropped from the PBXResourcesBuildPhase
 *             (its PBXBuildFile entry alone keeps the text-match test green),
 *   IOSCFG-5  app.json `name` no longer matches AppDelegate's withModuleName
 *             (the JS root component is registered under a name the native
 *             host never asks for → red screen at launch).
 * The fix must make each of those mutations fail a Linux gate.
 */

export {};

declare const require: (id: string) => unknown;
declare const __dirname: string;
const fs = require('fs') as {
  readFileSync: (p: string, encoding: 'utf8') => string;
};
const path = require('path') as {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
};

const MOBILE_ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string): string =>
  fs.readFileSync(path.join(MOBILE_ROOT, rel), 'utf8');

// The structural reader the Linux gates (check:distribution, release:check)
// use; the suite asserts the SAME resolution they do.
type EffectiveConfiguration = {
  name: string;
  baseConfigurations: Array<{ level: 'target' | 'project'; path: string }>;
  definitions: (key: string) => Array<{
    level: 'target' | 'project';
    condition: string | null;
    value: string;
  }>;
  values: (key: string) => string[];
  describe: (key: string) => string;
};
type PbxObject = Record<string, string | undefined>;
type Pbxproj = {
  appTarget: (name?: string) => PbxObject;
  effectiveSettings: (target: PbxObject) => Map<string, EffectiveConfiguration>;
};
const { parsePbxproj } = require(
  path.join(MOBILE_ROOT, 'scripts', 'pbxproj.js'),
) as { parsePbxproj: (text: string) => Pbxproj };

const pbxproj = read('ios/PickleSensei.xcodeproj/project.pbxproj');
const appDelegate = read('ios/PickleSensei/AppDelegate.swift');
const appJson = JSON.parse(read('app.json')) as { name: string };

function pbxSection(name: string): string {
  const match = new RegExp(
    `/\\* Begin ${name} section \\*/([\\s\\S]*?)/\\* End ${name} section \\*/`,
  ).exec(pbxproj);
  if (!match) throw new Error(`pbxproj: no ${name} section`);
  return match[1]!;
}

const project = parsePbxproj(pbxproj);
const configurations = project.effectiveSettings(
  project.appTarget('PickleSensei'),
);

describe('IOSCFG-3: Release build configuration is pinned, not just Debug', () => {
  const PINNED: Record<string, string> = {
    PRODUCT_BUNDLE_IDENTIFIER: 'com.picklesensei',
    MARKETING_VERSION: '1.0',
    CURRENT_PROJECT_VERSION: '1',
    DEVELOPMENT_TEAM: 'H26U6W4K6V',
    TARGETED_DEVICE_FAMILY: '1',
    IPHONEOS_DEPLOYMENT_TARGET: '15.1',
    CODE_SIGN_ENTITLEMENTS: 'PickleSensei/PickleSensei.entitlements',
    INFOPLIST_FILE: 'PickleSensei/Info.plist',
  };

  it('has exactly a Debug and a Release configuration for the app target', () => {
    expect(Array.from(configurations.keys()).sort()).toEqual([
      'Debug',
      'Release',
    ]);
  });

  // Every definition Xcode can evaluate for the key — the target's own,
  // any `KEY[…]` conditional variant, and the inherited project-level one —
  // must be the pinned value; a single unconditional match is not enough.
  it.each(['Debug', 'Release'])('%s carries every pinned setting', name => {
    const settings = configurations.get(name)!;
    for (const [key, value] of Object.entries(PINNED)) {
      const distinct = Array.from(new Set(settings.values(key)));
      expect([name, settings.describe(key), distinct]).toEqual([
        name,
        settings.describe(key),
        [value],
      ]);
    }
  });

  it('Release defines no DEBUG preprocessor or Swift compilation condition at any level', () => {
    const release = configurations.get('Release')!;
    const debugDefinitions = [
      ...release
        .values('GCC_PREPROCESSOR_DEFINITIONS')
        .filter(v => /\bDEBUG(=1)?\b/.test(v)),
      ...release
        .values('SWIFT_ACTIVE_COMPILATION_CONDITIONS')
        .filter(v => /\bDEBUG\b/.test(v)),
    ];
    expect(debugDefinitions).toEqual([]);
    expect(release.values('SWIFT_OPTIMIZATION_LEVEL')).not.toContain('-Onone');
  });

  it('only the CocoaPods xcconfig layers on top of the app target', () => {
    for (const [name, settings] of configurations) {
      expect(settings.baseConfigurations).toEqual([
        {
          level: 'target',
          path: `Target Support Files/Pods-PickleSensei/Pods-PickleSensei.${name.toLowerCase()}.xcconfig`,
        },
      ]);
    }
  });
});

describe('IOSCFG-4: PrivacyInfo.xcprivacy is copied by the Resources build phase', () => {
  it('lists the PrivacyInfo build file inside PBXResourcesBuildPhase.files', () => {
    const buildFileId =
      /([0-9A-F]{24}) \/\* PrivacyInfo\.xcprivacy in Resources \*\/ = \{isa = PBXBuildFile;/.exec(
        pbxSection('PBXBuildFile'),
      )?.[1];
    expect(buildFileId).toBeDefined();
    const resources = pbxSection('PBXResourcesBuildPhase');
    const files = /files = \(([\s\S]*?)\);/.exec(resources)?.[1] ?? '';
    expect(files).toContain(
      `${buildFileId} /* PrivacyInfo.xcprivacy in Resources */`,
    );
  });
});

describe('IOSCFG-5: JS root component name matches the native host', () => {
  it('app.json name equals AppDelegate withModuleName', () => {
    const native = /withModuleName:\s*"([^"]+)"/.exec(appDelegate)?.[1];
    expect(native).toBeDefined();
    expect(appJson.name).toBe(native);
  });

  it('index.js registers the app.json name (not a literal)', () => {
    const index = read('index.js');
    expect(index).toMatch(/import \{ name as appName \} from '\.\/app\.json';/);
    expect(index).toMatch(/AppRegistry\.registerComponent\(appName,/);
  });
});
