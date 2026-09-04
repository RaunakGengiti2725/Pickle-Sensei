/**
 * xc/journey-deep-links-urls — OAuth return-path configuration coherence.
 *
 * The only inbound URL the app registers is Google Sign-In's reversed
 * iOS-client-ID scheme. This suite pins the static facts that make that
 * return path safe and coherent, all of which can be established on Linux:
 *
 *   - the scheme is exactly the reversed live `GOOGLE_IOS_CLIENT_ID` (a
 *     rotated client ID without a plist update would strand the sign-in
 *     round trip on the old scheme);
 *   - the web client ID (the ID-token audience the backend verifies) is a
 *     DIFFERENT client in the SAME Google Cloud project as the iOS client;
 *   - the RN Google Sign-In native module (the installed version) exposes no
 *     `application:openURL:` forwarding of its own, and AppDelegate registers
 *     none — i.e. the app does not add an app-level URL handler that could
 *     be reached by a third party launching the scheme;
 *   - ATS arbitrary loads are OFF, so the WebView / fetch paths cannot be
 *     downgraded to http by a hostile network (relevant to every https-only
 *     check in the URL validators);
 *   - the CocoaPods lock pins GoogleSignIn ≥ 7 (the SDK generation whose
 *     sign-in flow presents through ASWebAuthenticationSession).
 *
 * NOT established here (Apple-runtime; see the audit report): that the live
 * GoogleSignIn 9.2 flow completes without an explicit
 * `application(_:open:options:)` forwarder in AppDelegate.
 */

import { getRuntimePublicConfig } from '../../src/config/runtimeConfig';

// Node built-ins, typed the way __tests__/wf/be-mobile-security-secrets.test.ts
// does (the RN tsconfig ships no node types).
declare const require: (id: string) => unknown;
declare const __dirname: string;
const fs = require('fs') as {
  readFileSync: (p: string, encoding: 'utf8') => string;
  readdirSync: (p: string) => string[];
};
const path = require('path') as {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
};

const MOBILE_ROOT = path.resolve(__dirname, '..', '..');
const IOS_APP_DIR = path.join(MOBILE_ROOT, 'ios', 'PickleSensei');

function read(rel: string): string {
  return fs.readFileSync(path.join(MOBILE_ROOT, rel), 'utf8');
}

function reversedClientId(clientId: string): string {
  return clientId.split('.').reverse().join('.');
}

function plistSchemes(plist: string): string[] {
  const block =
    /<key>CFBundleURLSchemes<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist);
  if (!block) return [];
  return [...(block[1] ?? '').matchAll(/<string>([^<]*)<\/string>/g)].map(m =>
    (m[1] ?? '').trim(),
  );
}

describe('xc deep links — OAuth return-path configuration coherence', () => {
  const config = getRuntimePublicConfig();
  const plist = fs.readFileSync(path.join(IOS_APP_DIR, 'Info.plist'), 'utf8');
  const appDelegate = fs.readFileSync(
    path.join(IOS_APP_DIR, 'AppDelegate.swift'),
    'utf8',
  );

  it('registers exactly the reversed live Google iOS client ID as the return scheme', () => {
    expect(config.googleIosClientId).toEqual(expect.any(String));
    const iosClientId = config.googleIosClientId ?? '';
    expect(iosClientId).toMatch(
      /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/,
    );
    expect(plistSchemes(plist)).toEqual([reversedClientId(iosClientId)]);
  });

  it('web client (token audience) is a distinct client in the same Google Cloud project', () => {
    const ios = config.googleIosClientId ?? '';
    const web = config.googleWebClientId ?? '';
    expect(web).toMatch(/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/);
    expect(web).not.toBe(ios);
    const project = (id: string) => id.split('-')[0];
    expect(project(web)).toBe(project(ios));
    // The web client must never be what the plist scheme points at: the
    // return URL belongs to the iOS client only.
    expect(plistSchemes(plist)).not.toContain(reversedClientId(web));
  });

  it('neither AppDelegate nor the installed RN Google Sign-In module adds an app-level URL handler', () => {
    expect(appDelegate).not.toMatch(/func\s+application\([^)]*open\s+url/);
    expect(appDelegate).not.toMatch(/RCTLinkingManager/);
    expect(appDelegate).not.toMatch(/GIDSignIn/);
    const nativeDir = path.join(
      MOBILE_ROOT,
      'node_modules/@react-native-google-signin/google-signin/ios',
    );
    const nativeSources = fs
      .readdirSync(nativeDir)
      .filter(f => /\.(m|mm|h|swift)$/.test(f))
      .map(f => fs.readFileSync(path.join(nativeDir, f), 'utf8'))
      .join('\n');
    expect(nativeSources.length).toBeGreaterThan(1_000);
    expect(nativeSources).not.toMatch(/handleURL|openURL|application:openURL/);
    // The module drives GIDSignIn's presenting-view-controller flow only.
    expect(nativeSources).toMatch(/signInWithPresentingViewController/);
  });

  it('ATS arbitrary loads are disabled (no http downgrade behind the https-only validators)', () => {
    const ats =
      /<key>NSAppTransportSecurity<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(
        plist,
      );
    expect(ats).not.toBeNull();
    const body = ats?.[1] ?? '';
    expect(body).toMatch(/<key>NSAllowsArbitraryLoads<\/key>\s*<false\/>/);
    expect(body).not.toMatch(
      /NSAllowsArbitraryLoadsInWebContent|NSExceptionDomains/,
    );
  });

  it('CocoaPods lock pins the GoogleSignIn 7+ generation and the RN module version in package-lock agrees', () => {
    const podfileLock = read('ios/Podfile.lock');
    const pod = /^\s*- GoogleSignIn \((\d+)\.(\d+)\.(\d+)\)/m.exec(podfileLock);
    expect(pod).not.toBeNull();
    expect(Number(pod?.[1])).toBeGreaterThanOrEqual(7);
    const packageLock = JSON.parse(read('package-lock.json')) as {
      packages: Record<string, { version?: string }>;
    };
    const installed =
      packageLock.packages[
        'node_modules/@react-native-google-signin/google-signin'
      ]?.version;
    expect(installed).toMatch(/^\d+\.\d+\.\d+$/);
    const pkg = JSON.parse(
      read(
        'node_modules/@react-native-google-signin/google-signin/package.json',
      ),
    ) as { version: string };
    expect(pkg.version).toBe(installed);
  });

  it('no LSApplicationQueriesSchemes, so canOpenURL cannot probe foreign apps (and no foreign scheme is ever opened)', () => {
    expect(plist).not.toMatch(/LSApplicationQueriesSchemes/);
  });
});
