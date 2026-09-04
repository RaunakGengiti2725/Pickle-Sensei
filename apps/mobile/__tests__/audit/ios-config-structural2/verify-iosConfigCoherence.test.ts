/**
 * AUDIT VERIFICATION (mobile-ios-config / auditor #2).
 *
 * Mapper hints that were checked and HOLD on 4d812e1a. Each test pins one
 * previously untested invariant so the coordinator has an executable record
 * of what was verified; none of these is a finding.
 */
// Module scope (no imports otherwise) so the declarations below stay local.
export {};

// Node built-ins typed by hand: the RN tsconfig ships no node types.
declare const require: (id: string) => unknown;
declare const __dirname: string;
interface DirEntry {
  name: string;
  isDirectory(): boolean;
}
const fs = require('fs') as {
  readFileSync: (p: string, encoding: 'utf8') => string;
  readdirSync: ((p: string, options: { withFileTypes: true }) => DirEntry[]) &
    ((p: string) => string[]);
};
const path = require('path') as {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
};

const mobileDir = path.resolve(__dirname, '../../..');
const iosDir = path.join(mobileDir, 'ios');
const read = (rel: string) =>
  fs.readFileSync(path.join(mobileDir, rel), 'utf8');

const infoPlist = read('ios/PickleSensei/Info.plist');
const appDelegate = read('ios/PickleSensei/AppDelegate.swift');
const indexJs = read('index.js');
const appJson = JSON.parse(read('app.json')) as {
  name: string;
  displayName: string;
};
const pbxproj = read('ios/PickleSensei.xcodeproj/project.pbxproj');
const podspec = read('ios/LocalPods/PickleNative/PickleNative.podspec');
const runtimeConfigSource = read('src/config/runtimeConfig.ts');

describe('runtimeConfig: unsupported platform never falls back to demo values', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('react-native');
  });

  test.each(['web', 'windows', 'macos'])(
    'Platform.OS=%p -> revenueCatPublicSdkKey null, HTTPS API origin kept',
    platform => {
      jest.doMock('react-native', () => ({ Platform: { OS: platform } }));
      const { getRuntimePublicConfig } =
        require('../../../src/config/runtimeConfig') as typeof import('../../../src/config/runtimeConfig');
      const cfg = getRuntimePublicConfig();
      expect(cfg.revenueCatPublicSdkKey).toBeNull();
      expect(cfg.apiBaseUrl).toMatch(/^https:\/\//);
      expect(JSON.stringify(cfg)).not.toMatch(
        /demo|localhost|127\.0\.0\.1|example\.com/i,
      );
    },
  );

  test('no demo/localhost origins exist in any runtimeConfig.ts string literal', () => {
    const literals = [
      ...runtimeConfigSource.matchAll(/'([^'\n]*)'|`([^`\n]*)`/g),
    ].map(m => m[1] ?? m[2] ?? '');
    expect(literals.length).toBeGreaterThan(0);
    for (const literal of literals) {
      expect(literal).not.toMatch(/localhost|127\.0\.0\.1|demo/i);
    }
  });
});

describe('app name coherence: app.json <-> AppDelegate <-> AppRegistry', () => {
  test('AppDelegate.withModuleName equals app.json name', () => {
    const m = appDelegate.match(/withModuleName:\s*"([^"]+)"/);
    expect(m?.[1]).toBe(appJson.name);
  });

  test('index.js registers the component under app.json name', () => {
    expect(indexJs).toMatch(
      /import \{ name as appName \} from '\.\/app\.json'/,
    );
    expect(indexJs).toMatch(/AppRegistry\.registerComponent\(appName,/);
  });

  test('Info.plist display name is the dossier in-app name "Pickle Sensei"', () => {
    expect(appJson.displayName).toBe('PickleSensei');
    expect(infoPlist).toMatch(
      /<key>CFBundleDisplayName<\/key>\s*<string>Pickle Sensei<\/string>/,
    );
  });
});

describe('AppDelegate.bundleURL(): Debug uses Metro, Release uses embedded main.jsbundle', () => {
  test('exclusion is compile-time (#if DEBUG) not runtime', () => {
    expect(appDelegate).toMatch(
      /override func bundleURL\(\) -> URL\? \{\s*#if DEBUG\s*RCTBundleURLProvider\.sharedSettings\(\)\.jsBundleURL\(forBundleRoot: "index"\)\s*#else\s*Bundle\.main\.url\(forResource: "main", withExtension: "jsbundle"\)\s*#endif/,
    );
  });

  test('Release build phase bundles JS ("Bundle React Native code and images")', () => {
    expect(pbxproj).toMatch(/Bundle React Native code and images/);
    expect(pbxproj).toMatch(/react-native-xcode\.sh/);
  });
});

describe('ATS: only the local-networking relaxation is present', () => {
  test('NSAllowsArbitraryLoads=false, NSAllowsLocalNetworking=true, nothing else', () => {
    const ats = infoPlist.match(
      /<key>NSAppTransportSecurity<\/key>\s*<dict>([\s\S]*?)<\/dict>/,
    );
    expect(ats?.[1]).toBeDefined();
    const keys = [...(ats?.[1] ?? '').matchAll(/<key>([^<]+)<\/key>/g)].map(
      m => m[1],
    );
    expect(keys.sort()).toEqual([
      'NSAllowsArbitraryLoads',
      'NSAllowsLocalNetworking',
    ]);
    expect(ats?.[1]).toMatch(/<key>NSAllowsArbitraryLoads<\/key>\s*<false\/>/);
    expect(ats?.[1]).toMatch(/<key>NSAllowsLocalNetworking<\/key>\s*<true\/>/);
  });
});

describe('microphone: string declared, capture pipeline has no audio input', () => {
  const sources = path.join(iosDir, 'LocalPods/PickleNative/Sources');
  const swiftFiles = fs
    .readdirSync(sources, { withFileTypes: true })
    .flatMap((d: DirEntry) => {
      const p = path.join(sources, d.name);
      if (d.isDirectory()) {
        return fs.readdirSync(p).map((f: string) => path.join(p, f));
      }
      return [p];
    })
    .filter((f: string) => f.endsWith('.swift'));

  test('no AVCaptureDevice audio input / AVAudioRecorder / AVAudioEngine in native sources', () => {
    for (const file of swiftFiles) {
      const src = fs.readFileSync(file, 'utf8');
      expect({
        file,
        hit: /AVMediaType\.audio|builtInMicrophone|AVAudioRecorder|AVAudioEngine|AVCaptureAudioDataOutput/.test(
          src,
        ),
      }).toEqual({ file, hit: false });
    }
  });

  test('dossier discloses the declared-but-never-requested microphone string', () => {
    const dossier = fs.readFileSync(
      path.resolve(mobileDir, '../../docs/APP_STORE_SUBMISSION.md'),
      'utf8',
    );
    expect(dossier).toMatch(
      /microphone string is declared but never triggered/i,
    );
  });
});

describe('ClipMediaStore: persisted captures live outside temporaryDirectory', () => {
  const store = read('ios/LocalPods/PickleNative/Sources/ClipMediaStore.swift');

  test('only the transient observation URL uses temporaryDirectory', () => {
    const tempUses = [...store.matchAll(/temporaryDirectory/g)].length;
    expect(tempUses).toBe(1);
    expect(store).toMatch(
      /static func makeObservationURL\(\) throws -> URL \{\s*let directory = FileManager\.default\.temporaryDirectory/,
    );
  });

  test('imported / recorded clips go to capturesDirectory (Application Support)', () => {
    expect(store).toMatch(/persistImportedVideo[\s\S]*?capturesDirectory/);
    expect(store).toMatch(/applicationSupportDirectory/);
  });
});

describe('Swift language version: pbxproj 5.0 and podspec 5.9 are both Swift-5 mode', () => {
  test('both declare a Swift 5.x language version (same major)', () => {
    const appVersions = [
      ...pbxproj.matchAll(/SWIFT_VERSION = ([0-9.]+);/g),
    ].map(m => m[1]);
    expect(appVersions.length).toBeGreaterThan(0);
    const podVersion = podspec.match(/s\.swift_version\s*=\s*"([0-9.]+)"/)?.[1];
    expect(podVersion).toBeDefined();
    for (const v of appVersions) {
      expect(v?.split('.')[0]).toBe(podVersion?.split('.')[0]);
    }
  });
});

describe('index.js: promise rejection tracking is Release-only by design', () => {
  test('installPromiseRejectionTracking returns early under __DEV__', () => {
    expect(indexJs).toMatch(
      /function installPromiseRejectionTracking\(\) \{\s*if \(__DEV__\) (\{\s*)?return;/,
    );
  });
});
