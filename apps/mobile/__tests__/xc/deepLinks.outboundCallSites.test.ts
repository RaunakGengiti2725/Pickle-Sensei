/**
 * xc/journey-deep-links-urls — OUTBOUND `Linking` call-site census.
 *
 * Every `Linking.openURL` / `Linking.canOpenURL` / `Linking.openSettings`
 * in the shipped JS is enumerated from source and matched against an
 * audited table that records WHERE the URL comes from and WHAT validates it.
 * A new call site (or a moved one whose argument expression changed) fails
 * the suite until it is classified here — the point is that nothing reaches
 * `openURL` without a known, reviewed URL provenance.
 *
 * Provenance classes:
 *   constant       — literal https URL in the bundle
 *   runtime-config — derived from runtimeConfig.ts constants (https literal)
 *   server-media   — InstructionalMedia from the training API; every URL field
 *                    passed `isHttpsUrl` in parseInstructionalMedia
 *   user-text      — free text from the user, percent-encoded into a fixed
 *                    https://www.youtube.com/results?search_query= prefix
 *   none           — no URL argument (openSettings)
 *
 * The suite also pins the concrete https targets of every constant /
 * runtime-config source with the WHATWG URL parser (host, scheme, no
 * userinfo), so a typo such as a `http://` or a stray `@` cannot ship.
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
  readdirSync: (p: string, options: { withFileTypes: true }) => DirEntry[];
};
const path = require('path') as {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
  relative: (from: string, to: string) => string;
  sep: string;
};
const os = require('os') as { tmpdir: () => string };

const MOBILE_ROOT = path.resolve(__dirname, '..', '..');
const ARTIFACT_DIR =
  process.env.XC_DEEP_LINKS_ARTIFACT_DIR ??
  path.join(os.tmpdir(), 'xc-deep-links');

type Provenance =
  'constant' | 'runtime-config' | 'server-media' | 'user-text' | 'none';

interface CallSite {
  file: string;
  method: 'openURL' | 'canOpenURL' | 'openSettings';
  argument: string;
}

interface AuditedCallSite extends CallSite {
  provenance: Provenance;
  validation: string;
  preflightCanOpen: boolean;
}

/** The audited table. Line numbers are deliberately NOT part of the key so
 * unrelated edits above a call site do not churn this file; the (file,
 * method, argument-expression) triple is. */
const AUDITED: AuditedCallSite[] = [
  {
    file: 'src/screens/LibraryScreen.tsx',
    method: 'canOpenURL',
    argument: 'url',
    provenance: 'server-media',
    validation:
      'mediaUrl(media) = playbackUrl|sourceUrl; both passed isHttpsUrl in parseInstructionalMedia',
    preflightCanOpen: true,
  },
  {
    file: 'src/screens/LibraryScreen.tsx',
    method: 'openURL',
    argument: 'url',
    provenance: 'server-media',
    validation:
      'mediaUrl(media) = playbackUrl|sourceUrl; both passed isHttpsUrl in parseInstructionalMedia; canOpenURL preflight',
    preflightCanOpen: true,
  },
  {
    file: 'src/screens/DrillLibraryScreen.tsx',
    method: 'openURL',
    argument: 'url',
    provenance: 'user-text',
    validation:
      "youtubeSearchUrl(topic): fixed 'https://www.youtube.com/results?search_query=' + encodeURIComponent(topic + ' pickleball drill')",
    preflightCanOpen: false,
  },
  {
    file: 'src/screens/SettingsScreen.tsx',
    method: 'openURL',
    argument: 'url',
    provenance: 'runtime-config',
    validation:
      'openLegalPage(label, url) receives legalPrivacyUrl/legalTermsUrl from getRuntimePublicConfig()',
    preflightCanOpen: false,
  },
  {
    file: 'src/screens/ResultScreen.tsx',
    method: 'canOpenURL',
    argument: 'url',
    provenance: 'server-media',
    validation:
      'mediaUrl(media) = playbackUrl|sourceUrl; both passed isHttpsUrl in parseInstructionalMedia',
    preflightCanOpen: true,
  },
  {
    file: 'src/screens/ResultScreen.tsx',
    method: 'openURL',
    argument: 'url',
    provenance: 'server-media',
    validation:
      'mediaUrl(media) = playbackUrl|sourceUrl; both passed isHttpsUrl in parseInstructionalMedia; canOpenURL preflight',
    preflightCanOpen: true,
  },
  {
    file: 'src/screens/ManageAccountScreen.tsx',
    method: 'openURL',
    argument: 'SUBSCRIPTION_MANAGEMENT.url',
    provenance: 'constant',
    validation: 'https://apps.apple.com/account/subscriptions literal (iOS)',
    preflightCanOpen: false,
  },
  {
    file: 'src/review/appStoreReview.ts',
    method: 'openURL',
    argument: 'target',
    provenance: 'runtime-config',
    validation:
      'rateAppFromSettings: appStoreWriteReviewUrl = https://apps.apple.com/app/id<APP_STORE_ID>?action=write-review',
    preflightCanOpen: false,
  },
  {
    file: 'src/notifications/service.ts',
    method: 'openSettings',
    argument: '',
    provenance: 'none',
    validation: 'no URL argument',
    preflightCanOpen: false,
  },
  {
    file: 'src/navigation/RootNavigator.tsx',
    method: 'openURL',
    argument: 'url',
    provenance: 'runtime-config',
    validation:
      'paywall openLegalPage(label, url) receives legalPrivacyUrl/legalTermsUrl from getRuntimePublicConfig()',
    preflightCanOpen: false,
  },
  {
    file: 'src/components/DrillVideoPlayer.tsx',
    method: 'openURL',
    argument: 'media.sourceUrl',
    provenance: 'server-media',
    validation: 'sourceUrl passed isHttpsUrl in parseInstructionalMedia',
    preflightCanOpen: false,
  },
];

function listSources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listSources(full, out);
    else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// Strips line and block comments so documentation mentioning
// `Linking.openURL` does not count as a call site.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, (_m, lead: string) => lead);
}

function enumerateCallSites(): (CallSite & { line: number })[] {
  const found: (CallSite & { line: number })[] = [];
  const files = [
    ...listSources(path.join(MOBILE_ROOT, 'src')),
    path.join(MOBILE_ROOT, 'App.tsx'),
  ];
  for (const file of files) {
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    const re = /Linking\.(openURL|canOpenURL|openSettings)\(([^)]*)\)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const line = text.slice(0, match.index).split('\n').length;
      found.push({
        file: path.relative(MOBILE_ROOT, file).split(path.sep).join('/'),
        method: match[1] as CallSite['method'],
        argument: (match[2] ?? '').trim(),
        line,
      });
    }
  }
  return found.sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file),
  );
}

function key(site: CallSite): string {
  return `${site.file}|${site.method}|${site.argument}`;
}

describe('xc deep links — outbound Linking call-site census', () => {
  const sites = enumerateCallSites();
  const config = getRuntimePublicConfig();

  it('writes the outbound call-site table artifact', () => {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    const rows = sites.map(site => {
      const audited = AUDITED.find(a => key(a) === key(site));
      return {
        ...site,
        location: `${site.file}:${site.line}`,
        provenance: audited?.provenance ?? 'UNAUDITED',
        validation: audited?.validation ?? 'UNAUDITED',
        preflightCanOpen: audited?.preflightCanOpen ?? null,
      };
    });
    fs.writeFileSync(
      path.join(ARTIFACT_DIR, 'outbound-call-sites.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2),
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('every Linking call site in the bundle is in the audited table (and vice versa)', () => {
    const actual = [...new Set(sites.map(key))].sort();
    const expected = [...new Set(AUDITED.map(key))].sort();
    expect(actual).toEqual(expected);
  });

  it('every audited call site has a known URL provenance with a validation note', () => {
    for (const site of AUDITED) {
      expect(site.validation.length).toBeGreaterThan(10);
      expect([
        'constant',
        'runtime-config',
        'server-media',
        'user-text',
        'none',
      ]).toContain(site.provenance);
    }
    // Every server-media consumer that can reach the OS handles rejection.
    const serverMediaOpen = AUDITED.filter(
      s => s.provenance === 'server-media' && s.method === 'openURL',
    );
    expect(serverMediaOpen.map(s => s.file).sort()).toEqual([
      'src/components/DrillVideoPlayer.tsx',
      'src/screens/LibraryScreen.tsx',
      'src/screens/ResultScreen.tsx',
    ]);
  });

  it('no Linking call site passes a raw string concatenation or template literal', () => {
    for (const site of sites) {
      // A template literal or `+` at the call site would mean the URL is
      // assembled inline, outside any validator.
      expect({ ...site, inlineAssembly: /[`+]/.test(site.argument) }).toEqual({
        ...site,
        inlineAssembly: false,
      });
    }
  });

  it('runtime-config / constant targets are well-formed https URLs on the expected hosts with no userinfo', () => {
    const targets: Record<string, string | null> = {
      legalPrivacyUrl: config.legalPrivacyUrl,
      legalTermsUrl: config.legalTermsUrl,
      appStoreWriteReviewUrl: config.appStoreWriteReviewUrl,
      apiBaseUrl: config.apiBaseUrl,
      subscriptionManagement: 'https://apps.apple.com/account/subscriptions',
    };
    const expectedHosts: Record<string, string> = {
      legalPrivacyUrl: 'ucqnaiwqwjtgvlduiuib.supabase.co',
      legalTermsUrl: 'ucqnaiwqwjtgvlduiuib.supabase.co',
      appStoreWriteReviewUrl: 'apps.apple.com',
      apiBaseUrl: 'ucqnaiwqwjtgvlduiuib.supabase.co',
      subscriptionManagement: 'apps.apple.com',
    };
    for (const [name, value] of Object.entries(targets)) {
      expect({ name, value }).toEqual({ name, value: expect.any(String) });
      const parsed = new URL(value ?? '');
      expect({ name, protocol: parsed.protocol }).toEqual({
        name,
        protocol: 'https:',
      });
      expect({ name, host: parsed.host }).toEqual({
        name,
        host: expectedHosts[name],
      });
      expect({
        name,
        username: parsed.username,
        password: parsed.password,
      }).toEqual({ name, username: '', password: '' });
    }
    expect(config.legalPrivacyUrl).toBe(`${config.apiBaseUrl}/privacy`);
    expect(config.legalTermsUrl).toBe(`${config.apiBaseUrl}/terms`);
    expect(config.appStoreWriteReviewUrl).toBe(
      `https://apps.apple.com/app/id${config.appStoreId}?action=write-review`,
    );
    expect(config.appStoreId).toMatch(/^\d+$/);
  });

  it('the ManageAccount subscription constant in source is exactly the App Store subscriptions page', () => {
    const source = fs.readFileSync(
      path.join(MOBILE_ROOT, 'src/screens/ManageAccountScreen.tsx'),
      'utf8',
    );
    expect(source).toMatch(
      /url:\s*'https:\/\/apps\.apple\.com\/account\/subscriptions'/,
    );
  });
});
