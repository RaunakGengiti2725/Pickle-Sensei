/**
 * Cross-cutting security harness: Release attack surface of the shipping
 * iOS app, checked against the real files that ship (Info.plist,
 * entitlements, runtimeConfig, every production TS/TSX/JS module).
 *
 * Fails on anything that would widen the Release surface:
 *   - a debug/dev hook in production code (`__DEV__`, DevSettings,
 *     process.env, console.*) outside the single vetted entry point
 *     (index.js installs the Release crash/rejection tracker);
 *   - a plaintext `http://` origin or a local-development host reachable
 *     from a Release module (the bootstrap URL normalizer is the one
 *     allowlisted mention, and only fires when the compiled API URL is local);
 *   - a compiled API base URL that is not HTTPS on a non-local host;
 *   - ATS: arbitrary loads, exception domains, insecure web content;
 *   - document/file exposure: UIFileSharingEnabled, open-in-place;
 *   - URL schemes other than the reversed Google iOS client id;
 *   - entitlements other than Sign in with Apple (no push=development,
 *     no get-task-allow, no app groups, no iCloud);
 *   - secret-shaped literals (private keys, `sk_live_`/`sk_test_`, AWS,
 *     JWTs, Slack, Google API keys, service_role) anywhere in shipped source.
 *
 * Hardening observations that are NOT hard failures (a Release build still
 * behaves safely) are written to the JSON artifact so the audit report can
 * cite them at file:line without weakening the gate:
 *   - `NSAllowsLocalNetworking=true` (Metro dev convenience carried into
 *     the Release plist).
 *
 * Artifact: `${XC_ARTIFACT_DIR ?? os.tmpdir()}/xc-release-surface-audit.json`.
 */
import { getRuntimePublicConfig } from '../../src/config/runtimeConfig';

// Node built-ins, typed the same way be-mobile-security-secrets.test.ts does
// (the RN tsconfig ships no node types).
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
interface DirEntry {
  name: string;
  isDirectory(): boolean;
}
const fs = require('fs') as {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string, encoding: 'utf8') => string;
  readdirSync: (p: string, options: { withFileTypes: true }) => DirEntry[];
  mkdirSync: (p: string, options: { recursive: true }) => void;
  writeFileSync: (p: string, data: string) => void;
};
const os = require('os') as { tmpdir: () => string };
const path = require('path') as {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
  relative: (from: string, to: string) => string;
};

const MOBILE_ROOT = path.resolve(__dirname, '..', '..');
const IOS_ROOT = path.join(MOBILE_ROOT, 'ios', 'PickleSensei');
const INFO_PLIST = fs.readFileSync(path.join(IOS_ROOT, 'Info.plist'), 'utf8');
const ENTITLEMENTS = fs.readFileSync(
  path.join(IOS_ROOT, 'PickleSensei.entitlements'),
  'utf8',
);
const ARTIFACT_DIR = process.env.XC_ARTIFACT_DIR ?? os.tmpdir();

interface Hit {
  file: string;
  line: number;
  rule: string;
  excerpt: string;
}

const report: {
  filesScanned: number;
  failures: Hit[];
  hardeningObservations: Hit[];
  allowedPublicIdentifiers: Hit[];
} = {
  filesScanned: 0,
  failures: [],
  hardeningObservations: [],
  allowedPublicIdentifiers: [],
};

afterAll(() => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(ARTIFACT_DIR, 'xc-release-surface-audit.json'),
    JSON.stringify({ harness: 'xcReleaseSurfaceAudit', ...report }, null, 2),
  );
});

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (
      /\.(ts|tsx|js)$/.test(entry.name) &&
      !/\.test\./.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

const PRODUCTION_FILES = [
  ...walk(path.join(MOBILE_ROOT, 'src')),
  path.join(MOBILE_ROOT, 'App.tsx'),
  path.join(MOBILE_ROOT, 'index.js'),
].filter(f => fs.existsSync(f));

const rel = (file: string) => path.relative(MOBILE_ROOT, file);

/** Redact anything that could be a credential before it lands in a report. */
function redact(line: string): string {
  return line
    .replace(
      /(appl_|test_|goog_|sk_live_|sk_test_|ghp_|AIza|AKIA)[A-Za-z0-9_-]+/g,
      '$1<redacted>',
    )
    .replace(/eyJ[A-Za-z0-9_-]{8,}/g, 'eyJ<redacted>')
    .replace(/\d{12}-[a-z0-9]{32}/g, '<oauth-client>')
    .trim()
    .slice(0, 160);
}

function scan(
  rule: string,
  pattern: RegExp,
  opts: { allowFiles?: string[]; allowLine?: (line: string) => boolean } = {},
): Hit[] {
  const hits: Hit[] = [];
  for (const file of PRODUCTION_FILES) {
    if (opts.allowFiles?.includes(rel(file))) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line: string, index: number) => {
      if (!pattern.test(line)) return;
      if (opts.allowLine?.(line)) return;
      hits.push({
        file: rel(file),
        line: index + 1,
        rule,
        excerpt: redact(line),
      });
    });
  }
  return hits;
}

describe('Release surface — production JS/TS modules', () => {
  beforeAll(() => {
    report.filesScanned = PRODUCTION_FILES.length;
  });

  it('has no debug/dev hooks outside index.js', () => {
    const hits = [
      ...scan('__DEV__', /\b__DEV__\b/, { allowFiles: ['index.js'] }),
      ...scan('DevSettings', /\bDevSettings\b|NativeModules\.DevMenu/),
      ...scan('process.env', /\bprocess\.env\b/),
      ...scan('console.*', /\bconsole\.(log|info|debug|warn|error|trace)\(/, {
        allowFiles: ['index.js'],
      }),
    ];
    report.failures.push(...hits);
    expect(hits).toEqual([]);
  });

  it('has no plaintext or local-development origins', () => {
    const hits = [
      ...scan('http://', /['"`]http:\/\//),
      ...scan(
        'local host literal',
        /\b(localhost|127\.0\.0\.1|10\.0\.2\.2)\b/,
        { allowFiles: ['src/account/bootstrap.ts'] },
      ),
      ...scan(
        'local / ngrok / staging host',
        /https?:\/\/[a-z0-9.-]+\.local\b|ngrok\.(io|app|dev)|https?:\/\/staging\./i,
      ),
    ];
    report.failures.push(...hits);
    expect(hits).toEqual([]);
  });

  it('compiles an HTTPS, non-local API base URL and public legal URLs', () => {
    const config = getRuntimePublicConfig();
    expect(config.apiBaseUrl).not.toBeNull();
    const url = new URL(config.apiBaseUrl!);
    expect(url.protocol).toBe('https:');
    expect(['localhost', '127.0.0.1', '10.0.2.2']).not.toContain(url.hostname);
    expect(url.hostname.endsWith('.supabase.co')).toBe(true);
    expect(config.legalPrivacyUrl?.startsWith('https://')).toBe(true);
    expect(config.legalTermsUrl?.startsWith('https://')).toBe(true);
  });

  it('contains no secret-shaped literals (only public SDK / OAuth identifiers)', () => {
    const secretHits = [
      ...scan('private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/),
      ...scan(
        'stripe/revenuecat secret key',
        /\bsk_(live|test)_[A-Za-z0-9]{8,}/,
      ),
      ...scan('aws access key', /\bAKIA[0-9A-Z]{16}\b/),
      ...scan('jwt literal', /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\./),
      ...scan('slack token', /\bxox[abpr]-[A-Za-z0-9-]{10,}/),
      ...scan('google api key', /\bAIza[0-9A-Za-z_-]{35}\b/),
      ...scan('github token', /\bgh[pousr]_[A-Za-z0-9]{36}\b/),
      ...scan('supabase service role', /service_role/i),
      ...scan(
        'generic secret assignment',
        /(secret|password|private_key|apiSecret)\s*[:=]\s*['"`][^'"`]{8,}['"`]/i,
        {
          allowLine: line =>
            /placeholder|Type your|label|title|copy|hint/i.test(line),
        },
      ),
    ];
    report.failures.push(...secretHits);
    report.allowedPublicIdentifiers.push(
      ...scan(
        'revenuecat public sdk key',
        /\b(appl|test|goog)_[A-Za-z0-9]{8,}/,
      ),
      ...scan('google oauth client id', /\.apps\.googleusercontent\.com/),
    );
    expect(secretHits).toEqual([]);
    expect(
      report.allowedPublicIdentifiers.every(
        h => h.file === 'src/config/runtimeConfig.ts',
      ),
    ).toBe(true);
  });
});

// ─── Info.plist / entitlements ───────────────────────────────────────────────

function plistBool(xml: string, key: string): boolean | null {
  const match = new RegExp(`<key>${key}</key>\\s*<(true|false)/>`).exec(xml);
  return match ? match[1] === 'true' : null;
}

function plistStringArray(xml: string, key: string): string[] {
  const match = new RegExp(
    `<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`,
  ).exec(xml);
  const inner = match?.[1];
  if (inner === undefined) return [];
  return [...inner.matchAll(/<string>([^<]*)<\/string>/g)].map(m => m[1] ?? '');
}

function plistKeys(xml: string): string[] {
  return [...xml.matchAll(/<key>([^<]+)<\/key>/g)].map(m => m[1] ?? '');
}

describe('Release surface — Info.plist', () => {
  it('ATS: no arbitrary loads, no exception domains, no insecure web content', () => {
    expect(plistBool(INFO_PLIST, 'NSAllowsArbitraryLoads')).toBe(false);
    expect(INFO_PLIST).not.toContain('NSExceptionDomains');
    expect(INFO_PLIST).not.toContain('NSAllowsArbitraryLoadsInWebContent');
    expect(INFO_PLIST).not.toContain('NSAllowsArbitraryLoadsForMedia');
    expect(INFO_PLIST).not.toContain('NSExceptionAllowsInsecureHTTPLoads');
  });

  it('records the local-networking ATS exemption as a hardening observation', () => {
    const local = plistBool(INFO_PLIST, 'NSAllowsLocalNetworking');
    if (local === true) {
      const line = INFO_PLIST.slice(
        0,
        INFO_PLIST.indexOf('NSAllowsLocalNetworking'),
      ).split('\n').length;
      report.hardeningObservations.push({
        file: 'ios/PickleSensei/Info.plist',
        line,
        rule: 'NSAllowsLocalNetworking=true in the Release plist (Metro dev convenience); no Release code path issues a plaintext request, so this is hardening, not a breach',
        excerpt: '<key>NSAllowsLocalNetworking</key><true/>',
      });
    }
    expect([true, false]).toContain(local);
  });

  it('exposes no document/file-sharing surface and no data-protection downgrade', () => {
    const keys = plistKeys(INFO_PLIST);
    expect(keys).not.toContain('UIFileSharingEnabled');
    expect(keys).not.toContain('LSSupportsOpeningDocumentsInPlace');
    expect(keys).not.toContain('UISupportsDocumentBrowser');
    expect(keys).not.toContain('NSUbiquitousContainers');
    expect(keys).not.toContain('UIBackgroundModes');
    expect(plistBool(INFO_PLIST, 'ITSAppUsesNonExemptEncryption')).toBe(false);
  });

  it('registers exactly one URL scheme: the reversed Google iOS OAuth client id', () => {
    const schemes = plistStringArray(INFO_PLIST, 'CFBundleURLSchemes');
    const clientId = getRuntimePublicConfig().googleIosClientId!;
    const reversed = clientId.split('.').reverse().join('.');
    expect(schemes).toEqual([reversed]);
    expect(
      schemes.some(s => !s.startsWith('com.googleusercontent.apps.')),
    ).toBe(false);
    expect(ENTITLEMENTS).not.toContain(
      'com.apple.developer.associated-domains',
    );
  });

  it('privacy strings describe on-device use and never promise upload', () => {
    for (const key of [
      'NSCameraUsageDescription',
      'NSMicrophoneUsageDescription',
      'NSPhotoLibraryUsageDescription',
    ]) {
      const match = new RegExp(
        `<key>${key}</key>\\s*<string>([^<]*)</string>`,
      ).exec(INFO_PLIST);
      const text = match?.[1] ?? '';
      expect(text.length).toBeGreaterThan(20);
      expect(/upload|cloud|server/i.test(text)).toBe(false);
    }
    for (const key of [
      'NSLocationWhenInUseUsageDescription',
      'NSLocationAlwaysAndWhenInUseUsageDescription',
      'NSContactsUsageDescription',
      'NSUserTrackingUsageDescription',
      'NSBluetoothAlwaysUsageDescription',
      'NSHealthShareUsageDescription',
      'NSMotionUsageDescription',
      'NSSpeechRecognitionUsageDescription',
    ]) {
      expect(INFO_PLIST).not.toContain(key);
    }
  });
});

describe('Release surface — entitlements', () => {
  it('grants only Sign in with Apple', () => {
    const keys = plistKeys(ENTITLEMENTS);
    expect(keys).toEqual(['com.apple.developer.applesignin']);
    expect(
      plistStringArray(ENTITLEMENTS, 'com.apple.developer.applesignin'),
    ).toEqual(['Default']);
    expect(ENTITLEMENTS).not.toContain('get-task-allow');
    expect(ENTITLEMENTS).not.toContain('aps-environment');
    expect(ENTITLEMENTS).not.toContain('application-groups');
    expect(ENTITLEMENTS).not.toContain('icloud');
  });
});
