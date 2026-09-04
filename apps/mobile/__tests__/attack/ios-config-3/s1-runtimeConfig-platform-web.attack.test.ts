/**
 * ADVERSARIAL PASS 3 — mobile-ios-config — S1
 *
 * Attack: load `src/config/runtimeConfig` in an isolated module registry with
 * `Platform.OS` forced to a non-mobile value and confirm the RevenueCat key
 * selection fails CLOSED (null) while every API-derived URL still derives
 * from the checked-in HTTPS `API_BASE_URL`.
 *
 * Extra edges: rapid isolated re-loads (registry leakage), Platform.OS
 * mutated AFTER import (the selector must read the live value, not a cached
 * one), whitespace / unicode look-alikes of "ios", and the two shipping
 * platforms as controls.
 *
 * Read-only: no production file is touched.
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

const MOBILE_ROOT = path.resolve(__dirname, '../../..');
const RUNTIME_CONFIG_PATH = path.join(
  MOBILE_ROOT,
  'src/config/runtimeConfig.ts',
);

type RuntimeConfigModule = typeof import('../../../src/config/runtimeConfig');

/** Load runtimeConfig with a fresh `react-native` mock whose Platform.OS is
 * `os`. Returns the module plus the mutable Platform object so a test can
 * flip the OS after import. */
function loadWithPlatform(os: unknown): {
  mod: RuntimeConfigModule;
  platform: { OS: unknown };
} {
  let mod: RuntimeConfigModule | undefined;
  const platform = { OS: os };
  jest.isolateModules(() => {
    jest.doMock('react-native', () => ({ Platform: platform }));
    mod = require('../../../src/config/runtimeConfig') as RuntimeConfigModule;
  });
  if (!mod) throw new Error('runtimeConfig failed to load in isolation');
  return { mod, platform };
}

const checkedInApiBaseUrl = (() => {
  const text = fs.readFileSync(RUNTIME_CONFIG_PATH, 'utf8');
  const match = /const API_BASE_URL[^=]*=\s*'([^']+)'/.exec(text);
  if (!match?.[1]) throw new Error('API_BASE_URL literal not found');
  return match[1];
})();

afterEach(() => {
  jest.dontMock('react-native');
  jest.resetModules();
});

describe('S1 — Platform.OS=web runtime config (attack)', () => {
  it('web: revenueCatPublicSdkKey is null and legal URLs still derive from API_BASE_URL', () => {
    const { mod } = loadWithPlatform('web');
    const config = mod.getRuntimePublicConfig();
    expect(config.revenueCatPublicSdkKey).toBeNull();
    expect(config.apiBaseUrl).toBe(checkedInApiBaseUrl);
    expect(config.apiBaseUrl).toMatch(/^https:\/\//);
    expect(config.legalPrivacyUrl).toBe(`${checkedInApiBaseUrl}/privacy`);
    expect(config.legalTermsUrl).toBe(`${checkedInApiBaseUrl}/terms`);
    expect(config.appStoreWriteReviewUrl).toMatch(
      /^https:\/\/apps\.apple\.com\/app\/id\d+\?action=write-review$/,
    );
  });

  it.each([
    ['macos'],
    ['windows'],
    ['tvos'],
    ['visionos'],
    [''],
    [' ios'],
    ['ios '],
    ['IOS'],
    ['iOS'],
    ['ｉｏｓ'], // fullwidth look-alike
    ['ios\u200b'], // zero-width space
    ['android\u0000'],
    [undefined],
    [null],
    [42],
  ])('non-mobile / look-alike OS %p selects NO RevenueCat key', os => {
    const { mod } = loadWithPlatform(os);
    const config = mod.getRuntimePublicConfig();
    expect(config.revenueCatPublicSdkKey).toBeNull();
    expect(config.legalPrivacyUrl).toBe(`${checkedInApiBaseUrl}/privacy`);
  });

  it('controls: ios selects the App Store public key, android the test-store key', () => {
    const ios = loadWithPlatform('ios').mod.getRuntimePublicConfig();
    const android = loadWithPlatform('android').mod.getRuntimePublicConfig();
    expect(ios.revenueCatPublicSdkKey).toMatch(/^appl_/);
    expect(android.revenueCatPublicSdkKey).toMatch(/^test_/);
    expect(ios.revenueCatPublicSdkKey).not.toBe(android.revenueCatPublicSdkKey);
  });

  it('selection is evaluated per call: flipping Platform.OS after import changes the key', () => {
    const { mod, platform } = loadWithPlatform('ios');
    expect(mod.getRuntimePublicConfig().revenueCatPublicSdkKey).toMatch(
      /^appl_/,
    );
    platform.OS = 'web';
    expect(mod.getRuntimePublicConfig().revenueCatPublicSdkKey).toBeNull();
    platform.OS = 'android';
    expect(mod.getRuntimePublicConfig().revenueCatPublicSdkKey).toMatch(
      /^test_/,
    );
  });

  it('rapid isolated reloads never leak a previous platform selection (seeded order)', () => {
    // Seeded LCG so the interleaving is reproducible: seed 0x1a2b3c.
    let seed = 0x1a2b3c;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    const platforms = ['ios', 'android', 'web', 'macos', undefined] as const;
    for (let i = 0; i < 40; i += 1) {
      const os = platforms[next() % platforms.length];
      const config = loadWithPlatform(os).mod.getRuntimePublicConfig();
      if (os === 'ios') {
        expect(config.revenueCatPublicSdkKey).toMatch(/^appl_/);
      } else if (os === 'android') {
        expect(config.revenueCatPublicSdkKey).toMatch(/^test_/);
      } else {
        expect(config.revenueCatPublicSdkKey).toBeNull();
      }
      expect(config.legalTermsUrl).toBe(`${checkedInApiBaseUrl}/terms`);
    }
  });

  it('every call returns a fresh object (callers cannot poison a shared config)', () => {
    const { mod } = loadWithPlatform('web');
    const first = mod.getRuntimePublicConfig();
    (first as { apiBaseUrl: string | null }).apiBaseUrl = 'http://evil.test';
    (
      first as { revenueCatPublicSdkKey: string | null }
    ).revenueCatPublicSdkKey = 'appl_forged';
    const second = mod.getRuntimePublicConfig();
    expect(second).not.toBe(first);
    expect(second.apiBaseUrl).toBe(checkedInApiBaseUrl);
    expect(second.revenueCatPublicSdkKey).toBeNull();
  });
});
