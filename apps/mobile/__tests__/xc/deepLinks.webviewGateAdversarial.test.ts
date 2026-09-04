/**
 * xc/journey-deep-links-urls — adversarial matrix + seeded fuzz against the
 * DrillVideoPlayer navigation gate (`shouldLoadInPlayer`).
 *
 * The gate is the only place where a URL that did NOT come from our server
 * can be evaluated by app code: the provider's WebView (YouTube / Vimeo
 * pages, their ads, their player chrome) can navigate anywhere it likes and
 * the gate decides whether that navigation loads in-app. `react-native-webview`
 * would otherwise hand anything outside its `originWhitelist` to
 * `Linking.openURL`, so a fail-OPEN in this gate is the path from a hostile
 * page to an arbitrary scheme launch or a top-frame phishing swap.
 *
 * Oracle: the WHATWG URL parser (Node's `URL`, the same grammar WebKit's
 * `URL` follows for special schemes). A payload is a fail-open divergence when
 * the gate admits it while the oracle says "not https on an allowed host".
 *
 *   - hand-written corpus: 90+ payloads across scheme smuggling, userinfo
 *     confusion, backslash/whitespace/control-character tricks, percent
 *     encoding, IDN/unicode, IPv6/IPv4 literals, port games, suffix/prefix
 *     host confusion, case games, very long inputs (ReDoS check);
 *   - seeded fuzz: FUZZ_COUNT grammar-generated URLs (xorshift32 PRNG; seed
 *     and index recorded for every divergence so any row is replayable).
 *
 * KNOWN DIVERGENCE CLASSES (pinned, not silenced):
 *   A. backslash-authority — the gate's regex reads the authority as
 *      everything up to the first `/`, `?` or `#`, while WHATWG also
 *      terminates it at `\`. So `https://evil.example\@www.youtube.com/`
 *      parses to host `evil.example` per WHATWG but the gate reads
 *      `www.youtube.com`. Whether WebKit can ever deliver such an
 *      un-normalised string through `decidePolicyFor` is an Apple-runtime
 *      question this Linux suite cannot answer (see the audit report).
 *   B. oracle-unparseable — the gate admits a string WHATWG rejects outright
 *      (port > 65535, forbidden host code point after percent-decoding, IDNA
 *      failure). There is no navigable target, so the admitted load fails.
 * The suite asserts that EVERY fail-open divergence found belongs to one of
 * these two classes; any new class (a parseable https URL on a foreign host
 * that the gate admits) fails the suite.
 */
// The native WebView module does not exist under jest; only the pure gate is
// exercised here.
jest.mock('react-native-webview', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const MockWebView = (props: Record<string, unknown>) =>
    ReactModule.createElement(View, props);
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});

import {
  shouldLoadInPlayer,
  VIDEO_EMBED_REFERER,
} from '../../src/components/DrillVideoPlayer';
import type { InstructionalMedia } from '../../src/training/types';

// Node built-ins, typed the way __tests__/wf/be-mobile-security-secrets.test.ts
// does (the RN tsconfig ships no node types).
declare const require: (id: string) => unknown;
declare const process: { env: Record<string, string | undefined> };
const fs = require('fs') as {
  writeFileSync: (p: string, data: string) => void;
  mkdirSync: (p: string, options: { recursive: true }) => void;
};
const path = require('path') as { join: (...parts: string[]) => string };
const os = require('os') as { tmpdir: () => string };

const ARTIFACT_DIR =
  process.env.XC_DEEP_LINKS_ARTIFACT_DIR ??
  path.join(os.tmpdir(), 'xc-deep-links');
const FUZZ_SEED = Number(process.env.XC_DEEP_LINKS_FUZZ_SEED ?? 20260904);
const FUZZ_COUNT = Number(process.env.XC_DEEP_LINKS_FUZZ_COUNT ?? 40_000);

const youtubeMedia: InstructionalMedia = {
  id: '6c8f2a4e-9b31-4f0d-8a57-2e9d4b7c1f03',
  kind: 'embed',
  provider: 'youtube',
  videoId: 'dnk101xyz',
  embedUrl: 'https://www.youtube-nocookie.com/embed/dnk101xyz',
  sourceUrl: 'https://www.youtube.com/watch?v=dnk101xyz',
  creatorName: 'Third Shot Sports',
  licenseName: 'YouTube Terms of Service',
  licenseUrl: 'https://www.youtube.com/t/terms',
  attribution: 'Video by Third Shot Sports on YouTube',
};

const vimeoMedia: InstructionalMedia = {
  ...youtubeMedia,
  id: '4d1e8b2a-7c53-49f6-b0e8-9a2c6d4f1b58',
  provider: 'vimeo',
  videoId: '76543210',
  embedUrl: 'https://player.vimeo.com/video/76543210',
  sourceUrl: 'https://vimeo.com/76543210',
};

const hostedMedia: InstructionalMedia = {
  id: '9d0a1c9e-2f65-4b7a-8c3d-6e5f4a3b2c1d',
  kind: 'hosted',
  playbackUrl: 'https://cdn.example.com/drills/dink.mp4',
  expiresAt: '2999-01-01T00:00:00.000Z',
  sourceUrl: 'https://example.com/drills/dink',
  creatorName: 'Pickle Sensei',
  licenseName: 'Licensed',
  licenseUrl: null,
  attribution: 'Pickle Sensei',
};

/** Mirrors the production allow-list semantics (exact host or subdomain). */
function oracleAllowedHosts(media: InstructionalMedia): string[] {
  const hosts = [
    new URL(VIDEO_EMBED_REFERER).hostname,
    new URL(media.sourceUrl).hostname,
    new URL(media.kind === 'embed' ? media.embedUrl : media.playbackUrl)
      .hostname,
  ];
  if (media.kind === 'embed') {
    hosts.push(
      ...(media.provider === 'youtube'
        ? [
            'youtube.com',
            'youtube-nocookie.com',
            'googlevideo.com',
            'ytimg.com',
          ]
        : ['vimeo.com', 'vimeocdn.com']),
    );
  }
  return hosts;
}

interface OracleVerdict {
  parses: boolean;
  protocol: string | null;
  hostname: string | null;
  allowed: boolean;
}

function oracle(media: InstructionalMedia, url: string): OracleVerdict {
  if (url.startsWith('about:')) {
    return { parses: true, protocol: 'about:', hostname: null, allowed: true };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { parses: false, protocol: null, hostname: null, allowed: false };
  }
  const allowed =
    parsed.protocol === 'https:' &&
    oracleAllowedHosts(media).some(
      h => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`),
    );
  return {
    parses: true,
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    allowed,
  };
}

interface Row {
  id: string;
  category: string;
  url: string;
  media: 'youtube' | 'vimeo' | 'hosted';
  gate: boolean;
  oracle: OracleVerdict;
  divergence: 'none' | 'fail-open' | 'fail-closed';
  seed?: number;
  index?: number;
}

function evaluate(
  id: string,
  category: string,
  mediaName: Row['media'],
  url: string,
  extra?: { seed: number; index: number },
): Row {
  const media =
    mediaName === 'youtube'
      ? youtubeMedia
      : mediaName === 'vimeo'
        ? vimeoMedia
        : hostedMedia;
  const gate = shouldLoadInPlayer(media, { url, isTopFrame: true });
  const verdict = oracle(media, url);
  const divergence =
    gate === verdict.allowed ? 'none' : gate ? 'fail-open' : 'fail-closed';
  return {
    id,
    category,
    url,
    media: mediaName,
    gate,
    oracle: verdict,
    divergence,
    ...extra,
  };
}

/** The gate reads the authority as `[^/?#]*` after `https://`; the known
 * divergence class is a backslash inside that read. */
function gateAuthority(url: string): string | null {
  const match = /^https:\/\/([^/?#]*)/i.exec(url);
  return match ? (match[1] ?? '') : null;
}

type DivergenceClass =
  'backslash-authority' | 'oracle-unparseable' | 'UNEXPLAINED';

function classify(row: Row): DivergenceClass {
  if (row.divergence !== 'fail-open') return 'UNEXPLAINED';
  const authority = gateAuthority(row.url);
  if (row.oracle.parses && authority !== null && authority.includes('\\')) {
    return 'backslash-authority';
  }
  if (!row.oracle.parses) return 'oracle-unparseable';
  return 'UNEXPLAINED';
}

function isKnownClass(row: Row): boolean {
  return classify(row) !== 'UNEXPLAINED';
}

const CORPUS: { category: string; urls: string[] }[] = [
  {
    category: 'scheme-smuggling',
    urls: [
      'javascript:alert(1)',
      'javascript://www.youtube.com/%0aalert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'data://www.youtube.com/x',
      'blob:https://www.youtube.com/uuid',
      'file:///etc/passwd',
      'file://www.youtube.com/etc/passwd',
      'vbscript:msgbox(1)',
      'intent://scan/#Intent;scheme=zxing;end',
      'itms-services://?action=download-manifest&url=https://evil.example/m.plist',
      'itms-apps://apps.apple.com/app/id6806918402',
      'vnd.youtube://dnk101xyz',
      'youtube://www.youtube.com/watch?v=dnk101xyz',
      'tel:+15555550100',
      'sms:+15555550100&body=hi',
      'mailto:victim@example.com?subject=x',
      'facetime://victim@example.com',
      'app-settings:',
      'prefs:root=General',
      'App-Prefs:root=WIFI',
      'x-apple-health://',
      'shortcuts://run-shortcut?name=x',
      'com.googleusercontent.apps.278019487172-ku9j3985cijj4e636t7s7efn8r1vsu8m:/oauth2redirect?code=x',
      'http://www.youtube.com/watch?v=dnk101xyz',
      'HTTP://www.youtube.com/',
      'https:www.youtube.com',
      'https:/www.youtube.com',
      'https:///www.youtube.com',
      'https://https://www.youtube.com',
      ' https://www.youtube.com/',
      '\thttps://www.youtube.com/',
      'https\u0000://www.youtube.com/',
      'ｈttps://www.youtube.com/',
      '//www.youtube.com/',
      'www.youtube.com',
      '',
      'about:blank',
      'about:srcdoc',
      'about:blank#javascript:alert(1)',
      'aboutx:blank',
    ],
  },
  {
    category: 'userinfo-confusion',
    urls: [
      'https://www.youtube.com@evil.example/',
      'https://www.youtube.com:@evil.example/',
      'https://www.youtube.com:443@evil.example/',
      'https://www.youtube.com:foo@evil.example/',
      'https://www.youtube.com%2F@evil.example/',
      'https://www.youtube.com%23@evil.example/',
      'https://www.youtube.com%3F@evil.example/',
      'https://www.youtube.com@@evil.example/',
      'https://www.youtube.com@evil.example@www.youtube.com/',
      'https://evil.example@www.youtube.com/',
      'https://evil.example:pass@www.youtube.com/',
      'https://user:https://www.youtube.com@evil.example/',
      'https://www.youtube.com#@evil.example/',
      'https://www.youtube.com?@evil.example/',
      'https://www.youtube.com/@evil.example/',
    ],
  },
  {
    category: 'backslash-and-whitespace',
    urls: [
      'https://evil.example\\@www.youtube.com/',
      'https://evil.example\\www.youtube.com/',
      'https://www.youtube.com\\@evil.example/',
      'https://www.youtube.com\\.evil.example/',
      'https://www.youtube.com:443\\@evil.example/',
      'https://evil.example\\\\@www.youtube.com/',
      'https:\\\\www.youtube.com\\',
      'https://www.youtube.com\t.evil.example/',
      'https://www.youtube.com\n.evil.example/',
      'https://www.youtube.com\r.evil.example/',
      'https://www.you\ttube.com/',
      'https://www.youtube.com /',
      'https://www.youtube.com\u00a0.evil.example/',
      'https://www.youtube.com\u0000.evil.example/',
      'https://www.youtube.com\u200b.evil.example/',
      'https://evil.example\u2044www.youtube.com/',
    ],
  },
  {
    category: 'percent-encoding',
    urls: [
      'https://www.youtube.com%2Eevil.example/',
      'https://www.youtube.com%00.evil.example/',
      'https://www.youtube.com%09.evil.example/',
      'https://www.youtube.com%0A.evil.example/',
      'https://%77ww.youtube.com/',
      'https://www.youtube.com%40evil.example/',
      'https://evil.example%2F%2Fwww.youtube.com/',
      'https://evil.example%3A443/',
    ],
  },
  {
    category: 'idn-unicode',
    urls: [
      'https://www.youtubе.com/', // Cyrillic е
      'https://www.yоutube.com/', // Cyrillic о
      'https://xn--youtub-3ib.com/',
      'https://www.youtube.com。evil.example/',
      'https://www.youtube.com．evil.example/',
      'https://ｗｗｗ.youtube.com/',
      'https://www.youtube.com/\u2028evil',
      'https://www.youtube.com\uff0f@evil.example/',
      'https://www.youtube.com\uff20evil.example/',
      'https://www.youtube.com\uff3cevil.example/',
    ],
  },
  {
    category: 'ip-literals',
    urls: [
      'https://[::1]/',
      'https://[::ffff:127.0.0.1]/',
      'https://[www.youtube.com]/',
      'https://[::1]@www.youtube.com/',
      'https://127.0.0.1/',
      'https://0x7f000001/',
      'https://2130706433/',
      'https://127.1/',
      'https://[fe80::1%25en0]/',
      'https://[::1',
    ],
  },
  {
    category: 'port-games',
    urls: [
      'https://www.youtube.com:443/',
      'https://www.youtube.com:/',
      'https://www.youtube.com:0/',
      'https://www.youtube.com:65535/',
      'https://www.youtube.com:65536/',
      'https://www.youtube.com:99999999999/',
      'https://www.youtube.com:abc/',
      'https://www.youtube.com:443:80/',
      'https://www.youtube.com:8080@evil.example/',
      'https://evil.example:443:www.youtube.com/',
    ],
  },
  {
    category: 'host-suffix-prefix',
    urls: [
      'https://evilyoutube.com/',
      'https://youtube.com.evil.example/',
      'https://www.youtube.com.evil.example/',
      'https://www.youtube.com.',
      'https://www.youtube.com../',
      'https://youtube.com/',
      'https://m.youtube.com/',
      'https://notyoutube.com/',
      'https://youtube.co/',
      'https://youtube.com.au/',
      'https://www.youtube.comm/',
      'https://.youtube.com/',
      'https://-youtube.com/',
      'https://youtube-nocookie.com.evil.example/',
      'https://googlevideo.com/',
      'https://r1---sn-abc.googlevideo.com/videoplayback',
      'https://i.ytimg.com/vi/x/hqdefault.jpg',
      'https://accounts.google.com/',
      'https://google.com/',
      'https://com.picklesensei/',
      'https://evil.com.picklesensei/',
      'https://com.picklesensei.evil.example/',
      'https://player.vimeo.com/video/76543210',
      'https://vimeo.com/76543210',
    ],
  },
  {
    category: 'case-games',
    urls: [
      'https://WWW.YOUTUBE.COM/',
      'HTTPS://www.youtube.com/',
      'HtTpS://WwW.YoUtUbE.cOm/',
      'https://www.YouTube.com/watch?v=dnk101xyz',
      'https://www.youtube.COM.evil.example/',
    ],
  },
  {
    category: 'path-query-fragment',
    urls: [
      'https://www.youtube.com/redirect?q=https://evil.example',
      'https://www.youtube.com/../../evil.example/',
      'https://www.youtube.com/?next=javascript:alert(1)',
      'https://www.youtube.com/#https://evil.example',
      'https://www.youtube.com/watch?v=dnk101xyz&feature=youtu.be',
      'https://www.youtube.com/watch?v="><script>alert(1)</script>',
      'https://www.youtube.com/%2F%2Fevil.example/',
      'https://www.youtube.com//evil.example/',
      'https://www.youtube.com/\\evil.example/',
    ],
  },
  {
    category: 'length-redos',
    urls: [
      `https://www.youtube.com/${'a'.repeat(100_000)}`,
      `https://${'a'.repeat(100_000)}.youtube.com/`,
      `https://${'@'.repeat(50_000)}www.youtube.com/`,
      `https://${':'.repeat(50_000)}@www.youtube.com/`,
      `https://www.youtube.com${':1'.repeat(50_000)}/`,
      `https://${'www.youtube.com@'.repeat(5_000)}evil.example/`,
      `https://${'\\'.repeat(50_000)}@www.youtube.com/`,
      `https://www.youtube.com/?${'x='.repeat(100_000)}`,
    ],
  },
];

// ─── Seeded fuzz grammar ────────────────────────────────────────────────────

function xorshift32(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

const HOST_TOKENS = [
  'www.youtube.com',
  'youtube.com',
  'www.youtube-nocookie.com',
  'player.vimeo.com',
  'vimeo.com',
  'com.picklesensei',
  'i.ytimg.com',
  'evil.example',
  'attacker.test',
  '127.0.0.1',
  '[::1]',
  'localhost',
  'www.yоutube.com',
  'youtube.com.evil.example',
  'evilyoutube.com',
];
const SEPARATORS = [
  '@',
  '\\',
  '/',
  '?',
  '#',
  ':',
  ':443',
  ':8080',
  ':abc',
  '%40',
  '%2F',
  '%5C',
  '%00',
  '%09',
  '\t',
  '\n',
  '\r',
  ' ',
  '\u0000',
  '\u00a0',
  '.',
  '..',
  '@@',
  '\\@',
  '\\\\',
  '。',
  '．',
  '\uff20',
  '\uff3c',
  '\uff0f',
  '',
];
const SCHEMES = [
  'https://',
  'https://',
  'https://',
  'https://',
  'http://',
  'HTTPS://',
  'javascript:',
  'data:',
  'file://',
  'vnd.youtube://',
  'about:',
  'https:/',
  'https:\\\\',
  ' https://',
  '//',
];

function generate(rand: () => number): string {
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(rand() * items.length)] as T;
  let url = pick(SCHEMES);
  const parts = 1 + Math.floor(rand() * 5);
  for (let i = 0; i < parts; i += 1) {
    url += pick(HOST_TOKENS);
    if (i < parts - 1 || rand() < 0.5) url += pick(SEPARATORS);
  }
  if (rand() < 0.4)
    url += pick([
      '/',
      '/watch?v=x',
      '/embed/x',
      '/?next=//evil.example',
      '#frag',
    ]);
  return url;
}

function writeArtifact(name: string, value: unknown): void {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(ARTIFACT_DIR, name),
    JSON.stringify(value, null, 2),
  );
}

describe('xc deep links — WebView navigation gate adversarial matrix', () => {
  const corpusRows: Row[] = [];
  for (const group of CORPUS) {
    group.urls.forEach((url, i) => {
      for (const mediaName of ['youtube', 'vimeo', 'hosted'] as const) {
        corpusRows.push(
          evaluate(
            `${group.category}#${i}/${mediaName}`,
            group.category,
            mediaName,
            url,
          ),
        );
      }
    });
  }

  it('writes the corpus matrix artifact', () => {
    writeArtifact('webview-gate-corpus.json', {
      generatedAt: new Date().toISOString(),
      rows: corpusRows.length,
      failOpen: corpusRows.filter(r => r.divergence === 'fail-open').length,
      failClosed: corpusRows.filter(r => r.divergence === 'fail-closed').length,
      matrix: corpusRows.map(r => ({
        ...r,
        url:
          r.url.length > 200
            ? `${r.url.slice(0, 200)}…(${r.url.length} chars)`
            : r.url,
      })),
    });
    expect(corpusRows.length).toBeGreaterThanOrEqual(150 * 3);
  });

  it('never admits a non-https, non-about: scheme in the top frame or a sub-frame', () => {
    const schemeRows = corpusRows.filter(
      r => r.category === 'scheme-smuggling',
    );
    for (const row of schemeRows) {
      const isAbout = row.url.startsWith('about:');
      const isHttps =
        /^https:\/\//i.test(row.url) && !/^https:\/\/\//.test(row.url);
      if (!isAbout && !isHttps) {
        expect({ url: row.url, media: row.media, gate: row.gate }).toEqual({
          url: row.url,
          media: row.media,
          gate: false,
        });
        const media =
          row.media === 'youtube'
            ? youtubeMedia
            : row.media === 'vimeo'
              ? vimeoMedia
              : hostedMedia;
        expect(
          shouldLoadInPlayer(media, { url: row.url, isTopFrame: false }),
        ).toBe(false);
        expect(shouldLoadInPlayer(media, { url: row.url })).toBe(false);
      }
    }
  });

  it('never admits a PARSEABLE https URL on a foreign host (userinfo, percent, IDN, IP, port, suffix, case, path tricks)', () => {
    const categories = new Set([
      'userinfo-confusion',
      'percent-encoding',
      'idn-unicode',
      'ip-literals',
      'port-games',
      'host-suffix-prefix',
      'case-games',
      'path-query-fragment',
    ]);
    const rows = corpusRows.filter(r => categories.has(r.category));
    expect(rows.length).toBeGreaterThan(200);
    const foreignHostAdmitted = rows.filter(
      r => r.divergence === 'fail-open' && r.oracle.parses,
    );
    expect(
      foreignHostAdmitted.map(r => ({
        id: r.id,
        url: r.url,
        oracle: r.oracle,
      })),
    ).toEqual([]);
    // Everything the gate admits from these categories that WHATWG rejects
    // is an unparseable string (no navigable target) — listed for the record.
    const unparseableAdmitted = rows.filter(
      r => r.divergence === 'fail-open' && !r.oracle.parses,
    );
    expect([...new Set(unparseableAdmitted.map(r => r.url))].sort()).toEqual(
      [
        'https://evil.example%2F%2Fwww.youtube.com/',
        'https://www.youtube.com:65536/',
        'https://www.youtube.com:99999999999/',
        'https://evil.example:443:www.youtube.com/',
      ].sort(),
    );
  });

  it('evaluates 100k-character hostile URLs in linear time (no ReDoS)', () => {
    const rows = corpusRows.filter(r => r.category === 'length-redos');
    expect(rows.length).toBeGreaterThan(0);
    const started = Date.now();
    for (const row of rows) {
      const media =
        row.media === 'youtube'
          ? youtubeMedia
          : row.media === 'vimeo'
            ? vimeoMedia
            : hostedMedia;
      for (let i = 0; i < 20; i += 1) {
        shouldLoadInPlayer(media, { url: row.url, isTopFrame: true });
      }
    }
    const elapsedMs = Date.now() - started;
    writeArtifact('webview-gate-redos-timing.json', {
      rows: rows.length,
      iterationsPerRow: 20,
      elapsedMs,
    });
    expect(elapsedMs).toBeLessThan(5_000);
    // No 100k payload is admitted against the oracle except via the known
    // backslash-authority class (asserted as a class below).
    const unexplained = rows.filter(
      r => r.divergence === 'fail-open' && !isKnownClass(r),
    );
    expect(unexplained.map(r => r.id)).toEqual([]);
  });

  it('every fail-open divergence in the corpus is one of the two known classes', () => {
    const failOpen = corpusRows.filter(r => r.divergence === 'fail-open');
    const byClass: Record<DivergenceClass, Row[]> = {
      'backslash-authority': [],
      'oracle-unparseable': [],
      UNEXPLAINED: [],
    };
    for (const row of failOpen) byClass[classify(row)].push(row);
    writeArtifact('webview-gate-corpus-divergences.json', {
      failOpen: failOpen.length,
      backslashAuthority: byClass['backslash-authority'].map(r => ({
        id: r.id,
        url: r.url,
        urlJson: JSON.stringify(r.url),
        oracle: r.oracle,
      })),
      oracleUnparseable: byClass['oracle-unparseable'].map(r => ({
        id: r.id,
        url: r.url.length > 200 ? `${r.url.slice(0, 200)}…` : r.url,
      })),
      unexplained: byClass.UNEXPLAINED.map(r => ({
        id: r.id,
        url: r.url,
        oracle: r.oracle,
      })),
    });
    // Class A exists (this is the audit's reproducible finding input) …
    expect(byClass['backslash-authority'].length).toBeGreaterThan(0);
    // … and nothing outside the two classes does.
    expect(
      byClass.UNEXPLAINED.map(r => ({
        id: r.id,
        url: r.url,
        oracle: r.oracle,
      })),
    ).toEqual([]);
    // The canonical replay input:
    expect(
      shouldLoadInPlayer(youtubeMedia, {
        url: 'https://evil.example\\@www.youtube.com/',
        isTopFrame: true,
      }),
    ).toBe(true);
    expect(new URL('https://evil.example\\@www.youtube.com/').hostname).toBe(
      'evil.example',
    );
  });

  it('fuzz: FUZZ_COUNT grammar URLs — every fail-open divergence is recorded with seed+index and belongs to the known class', () => {
    const rand = xorshift32(FUZZ_SEED);
    const divergences: Row[] = [];
    let admitted = 0;
    let failClosed = 0;
    const categoryCounts: Record<DivergenceClass, number> = {
      'backslash-authority': 0,
      'oracle-unparseable': 0,
      UNEXPLAINED: 0,
    };
    for (let index = 0; index < FUZZ_COUNT; index += 1) {
      const url = generate(rand);
      const mediaName =
        (['youtube', 'vimeo', 'hosted'] as const)[index % 3] ?? 'youtube';
      const row = evaluate(
        `fuzz#${index}/${mediaName}`,
        'fuzz',
        mediaName,
        url,
        {
          seed: FUZZ_SEED,
          index,
        },
      );
      if (row.gate) admitted += 1;
      if (row.divergence === 'fail-closed') failClosed += 1;
      if (row.divergence === 'fail-open') {
        divergences.push(row);
        categoryCounts[classify(row)] += 1;
      }
    }
    writeArtifact('webview-gate-fuzz.json', {
      seed: FUZZ_SEED,
      count: FUZZ_COUNT,
      admitted,
      failClosed,
      failOpen: divergences.length,
      failOpenByClass: categoryCounts,
      replay:
        'XC_DEEP_LINKS_FUZZ_SEED=<seed> XC_DEEP_LINKS_FUZZ_COUNT=<index+1> npx jest __tests__/xc/deepLinks.webviewGateAdversarial.test.ts',
      divergences: divergences.map(r => ({
        seed: r.seed,
        index: r.index,
        media: r.media,
        class: classify(r),
        url: r.url,
        urlJson: JSON.stringify(r.url),
        gate: r.gate,
        oracle: r.oracle,
      })),
    });
    expect(FUZZ_COUNT).toBeGreaterThanOrEqual(10_000);
    const unexplained = divergences.filter(r => !isKnownClass(r));
    expect(
      unexplained.slice(0, 20).map(r => ({
        seed: r.seed,
        index: r.index,
        url: JSON.stringify(r.url),
        oracle: r.oracle,
      })),
    ).toEqual([]);
  });

  it('sub-frame requests: any https loads, nothing else does (documented design)', () => {
    const rand = xorshift32(FUZZ_SEED ^ 0x5bd1e995);
    for (let index = 0; index < 5_000; index += 1) {
      const url = generate(rand);
      const gate = shouldLoadInPlayer(youtubeMedia, { url, isTopFrame: false });
      const httpsShape =
        /^https:\/\/[^/?#]*[^/?#@:\\]/i.test(url) || url.startsWith('about:');
      if (!httpsShape) {
        expect({ index, url: JSON.stringify(url), gate }).toEqual({
          index,
          url: JSON.stringify(url),
          gate: false,
        });
      }
    }
  });
});
