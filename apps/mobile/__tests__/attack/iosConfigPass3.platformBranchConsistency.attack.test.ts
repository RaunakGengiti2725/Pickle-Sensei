/**
 * ADVERSARIAL PASS 3 / mobile-ios-config — S7: platform-branch consistency of
 * the checked-in public runtime configuration.
 *
 * `runtimeConfig.getRuntimePublicConfig()` branches on `Platform.OS` for the
 * RevenueCat public SDK key only; the Google iOS OAuth client id is a fixed
 * value re-exported by `authConfig` (evaluated once at module load). The
 * attack flips Platform.OS (android / web / bogus / undefined) — both before
 * `authConfig` first evaluates and per call afterwards — and checks that:
 *   - android → the `test_…` RevenueCat key (AGENTS.md: Android still on the
 *     Test Store key), iOS → the `appl_…` production key, anything else → null;
 *   - `GOOGLE_IOS_CLIENT_ID` never changes with the platform and still equals
 *     the id whose reversed form is the CFBundleURLSchemes entry in Info.plist.
 */
import { Platform } from 'react-native';

// The mobile tsconfig has no Node types (matches
// flow-app-store-compliance-ios-config.test.ts).
declare const require: (id: string) => unknown;
declare const __dirname: string;

const { readFileSync } = require('fs') as {
  readFileSync: (path: string, encoding: 'utf8') => string;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

type RuntimeConfigModule = typeof import('../../src/config/runtimeConfig');
type AuthConfigModule = typeof import('../../src/config/authConfig');

const INFO_PLIST = readFileSync(
  join(__dirname, '..', '..', 'ios', 'PickleSensei', 'Info.plist'),
  'utf8',
);
const IOS_CLIENT_ID =
  '278019487172-ku9j3985cijj4e636t7s7efn8r1vsu8m.apps.googleusercontent.com';

/** Loads BOTH config modules fresh while Platform.OS reads `os`. */
function loadWithPlatform(os: unknown): {
  runtime: RuntimeConfigModule;
  auth: AuthConfigModule;
} {
  const replaced = jest.replaceProperty(
    Platform as unknown as { OS: unknown },
    'OS',
    os,
  );
  try {
    let runtime!: RuntimeConfigModule;
    let auth!: AuthConfigModule;
    jest.isolateModules(() => {
      runtime =
        require('../../src/config/runtimeConfig') as RuntimeConfigModule;
      auth = require('../../src/config/authConfig') as AuthConfigModule;
    });
    return { runtime, auth };
  } finally {
    replaced.restore();
  }
}

function withPlatform<T>(os: unknown, fn: () => T): T {
  const replaced = jest.replaceProperty(
    Platform as unknown as { OS: unknown },
    'OS',
    os,
  );
  try {
    return fn();
  } finally {
    replaced.restore();
  }
}

function reversedClientId(id: string): string {
  const [local, ...rest] = id.split('.apps.googleusercontent.com');
  expect(rest).toEqual(['']);
  return `com.googleusercontent.apps.${local}`;
}

describe('S7 — Platform.OS branch consistency (runtimeConfig × authConfig)', () => {
  it('precondition: the Jest RN preset reports ios', () => {
    expect(Platform.OS).toBe('ios');
  });

  it('Platform.OS="android": revenueCatPublicSdkKey is the test_ key while GOOGLE_IOS_CLIENT_ID stays the iOS id', () => {
    const { runtime, auth } = loadWithPlatform('android');
    const config = withPlatform('android', () =>
      runtime.getRuntimePublicConfig(),
    );
    expect(config.revenueCatPublicSdkKey).toMatch(/^test_[A-Za-z0-9]+$/);
    expect(config.revenueCatPublicSdkKey).not.toMatch(/^appl_/);
    expect(auth.GOOGLE_IOS_CLIENT_ID).toBe(IOS_CLIENT_ID);
    expect(config.googleIosClientId).toBe(IOS_CLIENT_ID);
    expect(auth.GOOGLE_WEB_CLIENT_ID).toBe(config.googleWebClientId);
  });

  it('Platform.OS="ios": revenueCatPublicSdkKey is the appl_ production key and the same iOS id', () => {
    const { runtime, auth } = loadWithPlatform('ios');
    const config = runtime.getRuntimePublicConfig();
    expect(config.revenueCatPublicSdkKey).toMatch(/^appl_[A-Za-z0-9]+$/);
    expect(auth.GOOGLE_IOS_CLIENT_ID).toBe(IOS_CLIENT_ID);
  });

  it('unknown / corrupt Platform.OS values yield revenueCatPublicSdkKey=null (explicit not-configured), never the iOS key', () => {
    for (const os of [
      'web',
      'windows',
      'macos',
      'IOS',
      'Android',
      '',
      undefined,
      null,
      42,
    ]) {
      const { runtime, auth } = loadWithPlatform(os);
      const config = withPlatform(os, () => runtime.getRuntimePublicConfig());
      expect(config.revenueCatPublicSdkKey).toBeNull();
      expect(auth.GOOGLE_IOS_CLIENT_ID).toBe(IOS_CLIENT_ID);
      expect(config.apiBaseUrl).toMatch(/^https:\/\//);
    }
  });

  it('platform flip at runtime (ios → android → ios) is observed per call; id, API origin and review URL are identical across all three', () => {
    const { runtime, auth } = loadWithPlatform('ios');
    const snapshots = ['ios', 'android', 'ios'].map(os =>
      withPlatform(os, () => runtime.getRuntimePublicConfig()),
    );
    expect(snapshots.map(s => s.revenueCatPublicSdkKey?.slice(0, 5))).toEqual([
      'appl_',
      'test_',
      'appl_',
    ]);
    expect(new Set(snapshots.map(s => s.googleIosClientId)).size).toBe(1);
    expect(new Set(snapshots.map(s => s.apiBaseUrl)).size).toBe(1);
    expect(new Set(snapshots.map(s => s.appStoreWriteReviewUrl)).size).toBe(1);
    expect(auth.GOOGLE_IOS_CLIENT_ID).toBe(IOS_CLIENT_ID);
  });

  it('the iOS id is wired: its reversed form is the ONLY CFBundleURLSchemes entry in Info.plist and Info.plist never carries a RevenueCat key', () => {
    const { auth, runtime } = loadWithPlatform('ios');
    const schemesBlock =
      /<key>CFBundleURLSchemes<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(
        INFO_PLIST,
      )?.[1] ?? '';
    const schemes = [
      ...schemesBlock.matchAll(/<string>([^<]*)<\/string>/g),
    ].map(m => m[1]);
    expect(schemes).toEqual([reversedClientId(auth.GOOGLE_IOS_CLIENT_ID!)]);
    const iosKey = runtime.getRuntimePublicConfig().revenueCatPublicSdkKey!;
    expect(INFO_PLIST).not.toContain(iosKey);
    expect(INFO_PLIST).not.toContain('test_');
  });

  it('the android test_ key never appears in iOS project files (Info.plist, entitlements, pbxproj, Podfile)', () => {
    const { runtime } = loadWithPlatform('android');
    const androidKey = withPlatform(
      'android',
      () => runtime.getRuntimePublicConfig().revenueCatPublicSdkKey!,
    );
    expect(androidKey).toMatch(/^test_/);
    const iosRoot = join(__dirname, '..', '..', 'ios');
    for (const rel of [
      'PickleSensei/Info.plist',
      'PickleSensei/PickleSensei.entitlements',
      'PickleSensei.xcodeproj/project.pbxproj',
      'Podfile',
    ]) {
      expect(readFileSync(join(iosRoot, rel), 'utf8')).not.toContain(
        androidKey,
      );
    }
  });
});
