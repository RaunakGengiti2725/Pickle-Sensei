/**
 * ADVERSARIAL PASS 3 — mobile-ios-config — extra static pins
 *
 * The mutation harness (scripts/attack/ios-config-3/mutation-harness.mjs)
 * showed that NO existing Linux guard notices when the Release configuration
 * of project.pbxproj drifts from Debug (bundle id, MARKETING_VERSION), gains
 * DEBUG compilation conditions, or re-enables NS assertions. This file pins
 * those invariants directly against the checked-in project so that class of
 * drift becomes visible on Linux. Everything here is static file inspection;
 * no Apple runtime behaviour is claimed.
 */
export {};

// The mobile tsconfig has no Node types (matches flow-app-store-compliance-ios-config).
declare const require: (id: string) => unknown;
declare const __dirname: string;
type Fs = {
  readFileSync: (p: string, encoding: 'utf8') => string;
  readdirSync: (p: string) => string[];
  existsSync: (p: string) => boolean;
  statSync: (p: string) => {
    isDirectory(): boolean;
    isFile(): boolean;
    size: number;
  };
};
type Path = {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
};
const fs = require('fs') as Fs;
const path = require('path') as Path;

const MOBILE = path.resolve(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(MOBILE, rel), 'utf8');

const pbxproj = read('ios/PickleSensei.xcodeproj/project.pbxproj');
const infoPlist = read('ios/PickleSensei/Info.plist');
const runtimeConfig = read('src/config/runtimeConfig.ts');
const indexJs = read('index.js');
const appJson = JSON.parse(read('app.json')) as {
  name: string;
  displayName: string;
};

type Settings = Record<string, string>;

function buildSettings(configId: string): Settings {
  const start = pbxproj.indexOf(`\t\t${configId} /*`);
  if (start < 0) throw new Error(`config ${configId} not found`);
  const settingsStart = pbxproj.indexOf('buildSettings = {', start);
  const settingsEnd = pbxproj.indexOf('\n\t\t\t};', settingsStart);
  const body = pbxproj.slice(settingsStart, settingsEnd);
  const out: Settings = {};
  // single-line `KEY = value;` and multi-line `KEY = ( ... );`
  for (const m of body.matchAll(
    /^\t{4}([A-Z0-9_]+) = (\([\s\S]*?\n\t{4}\)|[^\n]*?);$/gm,
  )) {
    out[m[1] ?? ''] = (m[2] ?? '').replace(/\s+/g, ' ').trim();
  }
  return out;
}

// XCConfigurationList → the two configurations of the app target and project
const TARGET_DEBUG = '13B07F941A680F5B00A75B9A';
const TARGET_RELEASE = '13B07F951A680F5B00A75B9A';
const PROJECT_DEBUG = '83CBBA201A601CBA00E9B192';
const PROJECT_RELEASE = '83CBBA211A601CBA00E9B192';

const targetDebug = buildSettings(TARGET_DEBUG);
const targetRelease = buildSettings(TARGET_RELEASE);
const projectDebug = buildSettings(PROJECT_DEBUG);
const projectRelease = buildSettings(PROJECT_RELEASE);

describe('X — project.pbxproj Debug/Release coherence', () => {
  it('parses both configurations of the app target and the project', () => {
    expect(targetDebug.PRODUCT_NAME).toBe('PickleSensei');
    expect(targetRelease.PRODUCT_NAME).toBe('PickleSensei');
    expect(projectDebug.IPHONEOS_DEPLOYMENT_TARGET).toBeDefined();
    expect(projectRelease.IPHONEOS_DEPLOYMENT_TARGET).toBeDefined();
    expect(
      /name = Debug;/.test(pbxproj.slice(pbxproj.indexOf(TARGET_DEBUG))),
    ).toBe(true);
  });

  it.each([
    'PRODUCT_BUNDLE_IDENTIFIER',
    'MARKETING_VERSION',
    'CURRENT_PROJECT_VERSION',
    'DEVELOPMENT_TEAM',
    'CODE_SIGN_ENTITLEMENTS',
    'INFOPLIST_FILE',
    'IPHONEOS_DEPLOYMENT_TARGET',
    'TARGETED_DEVICE_FAMILY',
    'SUPPORTED_PLATFORMS',
    'SWIFT_VERSION',
    'VERSIONING_SYSTEM',
    'ASSETCATALOG_COMPILER_APPICON_NAME',
  ])('%s is identical in the Debug and Release target configurations', key => {
    expect(targetRelease[key]).toBeDefined();
    expect(targetRelease[key]).toBe(targetDebug[key]);
  });

  it('release identity is the App Store bundle id, iPhone-only, team-signed', () => {
    expect(targetRelease.PRODUCT_BUNDLE_IDENTIFIER).toBe('com.picklesensei');
    expect(targetRelease.TARGETED_DEVICE_FAMILY).toBe('1');
    expect(targetRelease.DEVELOPMENT_TEAM).toMatch(/^[A-Z0-9]{10}$/);
    expect(targetRelease.CODE_SIGN_ENTITLEMENTS).toBe(
      'PickleSensei/PickleSensei.entitlements',
    );
  });

  it('MARKETING_VERSION matches runtimeConfig APP_VERSION (what the app reports to the server)', () => {
    const appVersion = /const APP_VERSION = '([^']+)';/.exec(
      runtimeConfig,
    )?.[1];
    expect(appVersion).toBeDefined();
    expect(targetRelease.MARKETING_VERSION).toBe(appVersion);
    expect(targetRelease.CURRENT_PROJECT_VERSION).toMatch(/^\d+$/);
    expect(infoPlist).toMatch(
      /<key>CFBundleShortVersionString<\/key>\s*<string>\$\(MARKETING_VERSION\)<\/string>/,
    );
    expect(infoPlist).toMatch(
      /<key>CFBundleVersion<\/key>\s*<string>\$\(CURRENT_PROJECT_VERSION\)<\/string>/,
    );
  });

  it('Release carries no DEBUG preprocessor define or Swift compilation condition (target or project level)', () => {
    for (const settings of [targetRelease, projectRelease]) {
      expect(settings.GCC_PREPROCESSOR_DEFINITIONS ?? '').not.toMatch(/DEBUG/);
      expect(settings.SWIFT_ACTIVE_COMPILATION_CONDITIONS ?? '').not.toMatch(
        /DEBUG/,
      );
      expect(settings.OTHER_SWIFT_FLAGS ?? '').not.toMatch(/-DDEBUG/);
    }
    // and Debug DOES carry them — otherwise the pins above test nothing
    expect(projectDebug.GCC_PREPROCESSOR_DEFINITIONS).toMatch(/DEBUG=1/);
    expect(projectDebug.SWIFT_ACTIVE_COMPILATION_CONDITIONS).toMatch(/DEBUG/);
  });

  it('Release is a shipping configuration: assertions off, debug info off, product validated, optimized', () => {
    expect(projectRelease.ENABLE_NS_ASSERTIONS).toBe('NO');
    expect(projectRelease.MTL_ENABLE_DEBUG_INFO).toBe('NO');
    expect(projectRelease.VALIDATE_PRODUCT).toBe('YES');
    expect(projectRelease.COPY_PHASE_STRIP).toBe('YES');
    expect(projectRelease.ONLY_ACTIVE_ARCH ?? 'NO').toBe('NO');
    expect(projectRelease.ENABLE_TESTABILITY ?? 'NO').toBe('NO');
    expect(
      targetRelease.SWIFT_OPTIMIZATION_LEVEL ??
        projectRelease.SWIFT_OPTIMIZATION_LEVEL ??
        '-O',
    ).not.toBe('"-Onone"');
    expect(targetDebug.SWIFT_OPTIMIZATION_LEVEL).toBe('"-Onone"');
    expect(projectDebug.ONLY_ACTIVE_ARCH).toBe('YES');
  });

  it('the app target has exactly two configurations and Release is the default for archives', () => {
    const listStart = pbxproj.indexOf(
      '/* Begin XCConfigurationList section */',
    );
    const listEnd = pbxproj.indexOf('/* End XCConfigurationList section */');
    const lists = pbxproj.slice(listStart, listEnd);
    expect(lists.match(/defaultConfigurationName = Release;/g)?.length).toBe(2);
    expect(lists).not.toMatch(/defaultConfigurationName = Debug;/);
    expect(lists.match(/\/\* Debug \*\/,\n/g)?.length).toBe(2);
    expect(lists.match(/\/\* Release \*\/,\n/g)?.length).toBe(2);
  });

  it('no per-config Info.plist or entitlements override slips a different privacy surface into Release', () => {
    expect(targetRelease.INFOPLIST_FILE).toBe('PickleSensei/Info.plist');
    expect(pbxproj.match(/INFOPLIST_FILE = /g)?.length).toBe(2);
    expect(pbxproj.match(/CODE_SIGN_ENTITLEMENTS = /g)?.length).toBe(2);
    expect(pbxproj).not.toMatch(/INFOPLIST_KEY_NS[A-Za-z]+UsageDescription/);
  });
});

describe('X — debug-only code paths are excluded from Release at the JS entry point', () => {
  it('index.js registers exactly the app.json component name', () => {
    expect(appJson.name).toBe('PickleSensei');
    expect(indexJs).toMatch(
      /AppRegistry\.registerComponent\(appName, \(\) => App\);/,
    );
    expect(indexJs).toMatch(
      /import \{ name as appName \} from '\.\/app\.json';/,
    );
  });

  it('promise-rejection tracking is gated on !__DEV__ and no dev-only tooling is imported unconditionally', () => {
    expect(indexJs).toMatch(
      /function installPromiseRejectionTracking\(\) \{\n\s+if \(__DEV__\) return;/,
    );
    for (const banned of [
      'react-devtools',
      'reactotron',
      'flipper',
      'why-did-you-render',
      'storybook',
      '@welldone-software',
    ]) {
      expect(indexJs.toLowerCase()).not.toContain(banned);
    }
    expect(indexJs).not.toMatch(/console\.log\(/);
    expect(indexJs).not.toMatch(/LogBox\.ignore/);
  });

  it('Info.plist has no development-only transport or scheme leftovers', () => {
    expect(infoPlist).not.toMatch(
      /NSAllowsArbitraryLoadsInWebContent<\/key>\s*<true\/>/,
    );
    expect(infoPlist).not.toMatch(/localhost|127\.0\.0\.1|10\.0\.2\.2/);
    expect(infoPlist).not.toMatch(/<key>NSExceptionDomains<\/key>/);
    expect(infoPlist).not.toMatch(/UIFileSharingEnabled<\/key>\s*<true\/>/);
    expect(infoPlist).not.toMatch(
      /LSSupportsOpeningDocumentsInPlace<\/key>\s*<true\/>/,
    );
  });
});
