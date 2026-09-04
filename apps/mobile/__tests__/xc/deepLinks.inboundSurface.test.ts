/**
 * xc/journey-deep-links-urls — INBOUND URL surface census.
 *
 * Enumerates every way a URL can ENTER the iOS app (custom URL schemes,
 * universal links, the native openURL/continueUserActivity delegate hooks,
 * React Native `Linking` inbound listeners, React Navigation `linking`
 * config) by reading the shipped native project files and the JS sources,
 * writes the census as a JSON table (artifact), and pins the exact expected
 * surface:
 *
 *   - exactly ONE CFBundleURLTypes entry: the Google Sign-In reversed client
 *     id (the OAuth return scheme), whose scheme string equals the reversed
 *     `googleIosClientId` from runtimeConfig;
 *   - no universal links (no `applinks:` / associated-domains entitlement);
 *   - no `LSApplicationQueriesSchemes` (the app never probes other apps);
 *   - the AppDelegate does not implement `application(_:open:options:)` or
 *     `continue userActivity` — there is NO app-level URL handler; the OAuth
 *     return is consumed by the GoogleSignIn SDK's own ASWebAuthenticationSession
 *     (react-native-google-signin documents the AppDelegate override as
 *     optional and only needed with multiple openURL listeners);
 *   - the JS bundle registers no `Linking.getInitialURL` /
 *     `Linking.addEventListener('url')` / navigation `linking` handler.
 *
 * Any NEW inbound handler makes this suite fail so it gets audited (a
 * handler that lands without validation is exactly the finding class this
 * suite exists to catch early).
 */

import { getRuntimePublicConfig } from '../../src/config/runtimeConfig';

// Node built-ins, typed the way __tests__/wf/be-mobile-security-secrets.test.ts
// does (the RN tsconfig ships no node types).
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
interface DirEntry {
  name: string;
  isDirectory(): boolean;
}
const fs = require('fs') as {
  readFileSync: (p: string, encoding: 'utf8') => string;
  writeFileSync: (p: string, data: string) => void;
  mkdirSync: (p: string, options: { recursive: true }) => void;
  existsSync: (p: string) => boolean;
  readdirSync: {
    (p: string): string[];
    (p: string, options: { withFileTypes: true }): DirEntry[];
  };
};
const path = require('path') as {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
  relative: (from: string, to: string) => string;
};
const os = require('os') as { tmpdir: () => string };

const MOBILE_ROOT = path.resolve(__dirname, '..', '..');
const IOS_APP_DIR = path.join(MOBILE_ROOT, 'ios', 'PickleSensei');
const ARTIFACT_DIR =
  process.env.XC_DEEP_LINKS_ARTIFACT_DIR ??
  path.join(os.tmpdir(), 'xc-deep-links');

function read(relative: string): string {
  return fs.readFileSync(path.join(MOBILE_ROOT, relative), 'utf8');
}

function listSources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listSources(full, out);
    else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Minimal plist reader: the `<array>` of `<string>`s that follows a key. */
function plistStringArraysAfterKey(plist: string, key: string): string[][] {
  const results: string[][] = [];
  const keyRe = new RegExp(
    `<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`,
    'g',
  );
  let match: RegExpExecArray | null;
  while ((match = keyRe.exec(plist)) !== null) {
    const body = match[1] ?? '';
    results.push(
      [...body.matchAll(/<string>([^<]*)<\/string>/g)].map(m => m[1] ?? ''),
    );
  }
  return results;
}

function reversedClientId(clientId: string): string {
  return clientId.split('.').reverse().join('.');
}

interface InboundHandlerRow {
  surface: string;
  location: string;
  present: boolean;
  detail: string;
  validation: string;
  verdict: 'no-handler' | 'sdk-owned' | 'app-handler';
}

function writeArtifact(name: string, value: unknown): string {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const file = path.join(ARTIFACT_DIR, name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

describe('xc deep links — inbound URL surface census', () => {
  const infoPlist = read('ios/PickleSensei/Info.plist');
  const entitlements = read('ios/PickleSensei/PickleSensei.entitlements');
  const appDelegate = read('ios/PickleSensei/AppDelegate.swift');
  const jsFiles = [
    ...listSources(path.join(MOBILE_ROOT, 'src')),
    path.join(MOBILE_ROOT, 'App.tsx'),
    path.join(MOBILE_ROOT, 'index.js'),
  ];
  const jsSources = jsFiles.map(file => ({
    file: path.relative(MOBILE_ROOT, file),
    text: fs.readFileSync(file, 'utf8'),
  }));
  const config = getRuntimePublicConfig();

  const urlTypes = plistStringArraysAfterKey(infoPlist, 'CFBundleURLSchemes');
  const registeredSchemes = urlTypes.flat();
  const queriesSchemes = plistStringArraysAfterKey(
    infoPlist,
    'LSApplicationQueriesSchemes',
  ).flat();
  const associatedDomains = plistStringArraysAfterKey(
    entitlements,
    'com.apple.developer.associated-domains',
  ).flat();

  const nativeOpenUrl = /func\s+application\([^)]*open\s+url/.test(appDelegate);
  const nativeContinueActivity = /continue\s+userActivity/.test(appDelegate);
  const nativeLinkingManager = /RCTLinkingManager/.test(appDelegate);
  const nativeGidHandle = /GIDSignIn[\s\S]*?handle\(/.test(appDelegate);

  const jsInboundListeners = jsSources.flatMap(({ file, text }) => {
    const hits: string[] = [];
    if (/Linking\.getInitialURL/.test(text)) hits.push('Linking.getInitialURL');
    if (/Linking\.addEventListener\(\s*['"]url['"]/.test(text)) {
      hits.push("Linking.addEventListener('url')");
    }
    if (/Linking\.useURL|useLinkTo|useLinkProps|createURL\(/.test(text)) {
      hits.push('expo/navigation url hook');
    }
    if (/\blinking\s*=\s*\{|\bprefixes\s*:\s*\[/.test(text)) {
      hits.push('react-navigation linking config');
    }
    return hits.map(hit => `${file}: ${hit}`);
  });

  const census: InboundHandlerRow[] = [
    {
      surface: 'CFBundleURLTypes (custom URL schemes)',
      location: 'ios/PickleSensei/Info.plist',
      present: registeredSchemes.length > 0,
      detail: registeredSchemes.join(', '),
      validation:
        'No app code handles this scheme (AppDelegate has no openURL override, ' +
        'no RCTLinkingManager, no JS listener). INFERRED from vendor docs: the ' +
        'GoogleSignIn 9.x / AppAuth flow consumes the return URL itself; ' +
        'iOS-runtime behaviour is not established on Linux.',
      verdict: 'sdk-owned',
    },
    {
      surface: 'LSApplicationQueriesSchemes',
      location: 'ios/PickleSensei/Info.plist',
      present: queriesSchemes.length > 0,
      detail: queriesSchemes.join(', '),
      validation: 'n/a — no outbound scheme probing declared',
      verdict: 'no-handler',
    },
    {
      surface: 'Universal links (associated-domains applinks:)',
      location: 'ios/PickleSensei/PickleSensei.entitlements',
      present: associatedDomains.length > 0,
      detail: associatedDomains.join(', '),
      validation: 'n/a — no universal links registered',
      verdict: 'no-handler',
    },
    {
      surface: 'AppDelegate application(_:open:options:)',
      location: 'ios/PickleSensei/AppDelegate.swift',
      present: nativeOpenUrl,
      detail: nativeOpenUrl
        ? 'app-level openURL override present'
        : 'no override; GIDSignIn.handle not called from app code',
      validation: nativeOpenUrl
        ? 'MUST be audited'
        : 'n/a — no app-level URL entry point',
      verdict: nativeOpenUrl ? 'app-handler' : 'no-handler',
    },
    {
      surface: 'AppDelegate application(_:continue:restorationHandler:)',
      location: 'ios/PickleSensei/AppDelegate.swift',
      present: nativeContinueActivity,
      detail: nativeContinueActivity ? 'present' : 'absent',
      validation: 'n/a — no universal-link continuation',
      verdict: nativeContinueActivity ? 'app-handler' : 'no-handler',
    },
    {
      surface: 'RCTLinkingManager forwarding',
      location: 'ios/PickleSensei/AppDelegate.swift',
      present: nativeLinkingManager,
      detail: nativeLinkingManager ? 'present' : 'absent',
      validation: 'n/a — JS never receives inbound URLs',
      verdict: nativeLinkingManager ? 'app-handler' : 'no-handler',
    },
    {
      surface: 'JS inbound Linking listeners / navigation linking config',
      location: 'src/**, App.tsx, index.js',
      present: jsInboundListeners.length > 0,
      detail: jsInboundListeners.join('; '),
      validation: 'n/a — none registered',
      verdict: jsInboundListeners.length > 0 ? 'app-handler' : 'no-handler',
    },
  ];

  it('writes the inbound handler census artifact', () => {
    const file = writeArtifact('inbound-surface.json', {
      generatedAt: new Date().toISOString(),
      googleIosClientId: config.googleIosClientId,
      registeredSchemes,
      queriesSchemes,
      associatedDomains,
      nativeGidHandle,
      census,
    });
    expect(fs.existsSync(file)).toBe(true);
  });

  it('registers exactly one URL scheme: the Google Sign-In reversed iOS client id', () => {
    expect(urlTypes).toHaveLength(1);
    expect(registeredSchemes).toHaveLength(1);
    const scheme = registeredSchemes[0] ?? '';
    expect(config.googleIosClientId).toBeTruthy();
    expect(scheme).toBe(reversedClientId(config.googleIosClientId ?? ''));
    expect(scheme.startsWith('com.googleusercontent.apps.')).toBe(true);
    // Reversed client ids are long and app-specific; a short vanity scheme
    // (e.g. `picklesensei://`) would be squattable by any other app.
    expect(scheme.length).toBeGreaterThan(40);
    expect(infoPlist).toMatch(
      /<key>CFBundleURLName<\/key>\s*<string>GoogleSignInReturn<\/string>/,
    );
  });

  it('registers no universal links and probes no foreign schemes', () => {
    expect(associatedDomains).toEqual([]);
    expect(entitlements).not.toMatch(/applinks:|associated-domains/);
    expect(infoPlist).not.toMatch(/applinks:|associated-domains/);
    expect(queriesSchemes).toEqual([]);
  });

  it('has no app-level native URL entry point (OAuth return is SDK-owned)', () => {
    expect(nativeOpenUrl).toBe(false);
    expect(nativeContinueActivity).toBe(false);
    expect(nativeLinkingManager).toBe(false);
    expect(nativeGidHandle).toBe(false);
    // Nothing else in the native app dir handles URLs either.
    for (const entry of fs.readdirSync(IOS_APP_DIR)) {
      if (!/\.(swift|m|mm|h)$/.test(entry)) continue;
      const text = fs.readFileSync(path.join(IOS_APP_DIR, entry), 'utf8');
      expect({ entry, hasOpenUrl: /open\s+url|openURL/.test(text) }).toEqual({
        entry,
        hasOpenUrl: false,
      });
    }
  });

  it('registers no JS inbound URL listener or navigation deep-link config', () => {
    expect(jsInboundListeners).toEqual([]);
  });

  it('every census row is either no-handler or sdk-owned (an app-handler row demands an audit)', () => {
    const appHandlers = census.filter(row => row.verdict === 'app-handler');
    expect(appHandlers).toEqual([]);
    const sdkOwned = census.filter(row => row.verdict === 'sdk-owned');
    expect(sdkOwned.map(row => row.surface)).toEqual([
      'CFBundleURLTypes (custom URL schemes)',
    ]);
  });
});
