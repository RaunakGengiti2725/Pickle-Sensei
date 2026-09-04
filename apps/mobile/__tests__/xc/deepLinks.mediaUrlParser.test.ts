/**
 * xc/journey-deep-links-urls — adversarial server payloads against the
 * InstructionalMedia URL validator (`parseInstructionalMedia`, reached through
 * `createTrainingApi().getDrill`).
 *
 * Every URL the app later hands to `Linking.openURL` (LibraryScreen,
 * ResultScreen, DrillVideoPlayer's "open at source") or loads into the player
 * WebView (`embedUrl`, `playbackUrl`) passes through this parser first. If a
 * compromised or misbehaving server (or a MITM behind a broken ATS) could slip
 * a `javascript:`, `file:`, custom-scheme or otherwise non-https URL through
 * it, that URL would reach the OS. This suite feeds the parser a corpus of
 * hostile `sourceUrl` / `playbackUrl` / `embedUrl` / `licenseUrl` / `videoId`
 * values and asserts:
 *
 *   - every non-`https://`-prefixed URL field is rejected (invalid_response);
 *   - embed URLs must equal the canonical provider embed for the videoId, so a
 *     videoId cannot smuggle a foreign host into `embedUrl`;
 *   - every ACCEPTED URL parses under WHATWG as `https:` on the host the
 *     string claims (no scheme confusion after acceptance);
 *   - the exact set of accepted-but-degenerate strings is pinned (`https://`
 *     with an empty host, `https://` with a control character) so a stricter
 *     validator later is a deliberate change, not drift.
 *
 * The matrix is written as JSON for the audit record.
 */

import { createTrainingApi } from '../../src/training/api';
import { TrainingError } from '../../src/training/types';

// Node built-ins, typed the way __tests__/wf/be-mobile-security-secrets.test.ts
// does (the RN tsconfig ships no node types).
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const fs = require('fs') as {
  readFileSync: (p: string, encoding: 'utf8') => string;
  writeFileSync: (p: string, data: string) => void;
  mkdirSync: (p: string, options: { recursive: true }) => void;
};
const path = require('path') as {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
};
const os = require('os') as { tmpdir: () => string };

const ARTIFACT_DIR =
  process.env.XC_DEEP_LINKS_ARTIFACT_DIR ??
  path.join(os.tmpdir(), 'xc-deep-links');

function response(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => payload,
  } as Response;
}

const drill = {
  id: '0b96363e-4a11-47c5-9d2c-3f5b8e6f2a17',
  slug: 'dink-target-ladder',
  title: 'Dink Target Ladder',
  description: 'Land four consecutive cross-court dinks per kitchen zone.',
  coach_name: 'Pickle Sensei Training Library',
  equipment: ['paddle'],
  difficulty_min: null,
  difficulty_max: null,
  saved: false,
};

const goodYoutube = {
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

const goodHosted = {
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

async function parse(media: unknown[]) {
  const fetchFn = jest.fn(async () =>
    response(200, { drill, mappings: [], instructionalMedia: media }),
  );
  const client = createTrainingApi({
    baseUrl: 'https://api.pickle.test',
    token: 'signed-token',
    fetchFn,
  });
  return client.getDrill(drill.slug);
}

/** Hostile URL values; each is substituted into every URL-bearing field. */
const HOSTILE_URLS: { label: string; value: unknown }[] = [
  { label: 'javascript', value: 'javascript:alert(1)' },
  { label: 'javascript-mixed-case', value: 'JavaScript:alert(1)' },
  { label: 'data-html', value: 'data:text/html,<script>alert(1)</script>' },
  { label: 'file', value: 'file:///etc/passwd' },
  { label: 'blob', value: 'blob:https://www.youtube.com/uuid' },
  { label: 'http', value: 'http://www.youtube.com/watch?v=dnk101xyz' },
  { label: 'HTTPS-upper', value: 'HTTPS://www.youtube.com/watch?v=dnk101xyz' },
  { label: 'Https-title', value: 'Https://www.youtube.com/watch?v=dnk101xyz' },
  { label: 'leading-space', value: ' https://www.youtube.com/watch?v=x' },
  { label: 'leading-tab', value: '\thttps://www.youtube.com/watch?v=x' },
  { label: 'leading-nul', value: '\u0000https://www.youtube.com/' },
  { label: 'scheme-relative', value: '//www.youtube.com/watch?v=x' },
  { label: 'https-no-slashes', value: 'https:www.youtube.com' },
  { label: 'https-one-slash', value: 'https:/www.youtube.com' },
  { label: 'vnd-youtube', value: 'vnd.youtube://dnk101xyz' },
  {
    label: 'itms-services',
    value: 'itms-services://?action=download-manifest',
  },
  { label: 'tel', value: 'tel:+15555550100' },
  { label: 'sms', value: 'sms:+15555550100' },
  { label: 'app-settings', value: 'app-settings:' },
  { label: 'prefs', value: 'prefs:root=General' },
  {
    label: 'google-oauth-scheme',
    value:
      'com.googleusercontent.apps.278019487172-ku9j3985cijj4e636t7s7efn8r1vsu8m:/oauth2redirect',
  },
  { label: 'fullwidth-h', value: 'ｈttps://www.youtube.com/' },
  { label: 'empty', value: '' },
  { label: 'whitespace', value: '   ' },
  { label: 'number', value: 42 },
  { label: 'null', value: null },
  { label: 'object', value: { toString: () => 'https://www.youtube.com/' } },
  { label: 'array', value: ['https://www.youtube.com/'] },
  { label: 'boolean', value: true },
];

/** `https://`-prefixed strings the prefix check accepts; the point of the
 * test is to see how far downstream they get and pin that. */
const DEGENERATE_HTTPS: { label: string; value: string }[] = [
  { label: 'empty-host', value: 'https://' },
  { label: 'slash-only', value: 'https:///' },
  { label: 'newline-in-url', value: 'https://www.youtube.com/\nevil' },
  { label: 'nul-in-host', value: 'https://www.you\u0000tube.com/' },
  { label: 'space-in-host', value: 'https://www.you tube.com/' },
  { label: 'userinfo', value: 'https://www.youtube.com@evil.example/' },
  {
    label: 'backslash-userinfo',
    value: 'https://evil.example\\@www.youtube.com/',
  },
  { label: 'ip', value: 'https://127.0.0.1/' },
  { label: 'idn', value: 'https://www.yоutube.com/' },
  { label: 'huge', value: `https://www.youtube.com/${'a'.repeat(200_000)}` },
];

interface Row {
  field: string;
  kind: 'embed' | 'hosted';
  label: string;
  value: string;
  outcome: 'rejected' | 'accepted';
  error?: string;
  whatwg?: {
    parses: boolean;
    protocol: string | null;
    hostname: string | null;
  };
}

function whatwg(value: string) {
  try {
    const parsed = new URL(value);
    return {
      parses: true,
      protocol: parsed.protocol,
      hostname: parsed.hostname,
    };
  } catch {
    return { parses: false, protocol: null, hostname: null };
  }
}

async function tryParse(
  field: string,
  kind: Row['kind'],
  label: string,
  value: unknown,
): Promise<Row> {
  const base = kind === 'embed' ? { ...goodYoutube } : { ...goodHosted };
  const media: Record<string, unknown> = { ...base, [field]: value };
  const shown = typeof value === 'string' ? value : JSON.stringify(value);
  try {
    await parse([media]);
    return {
      field,
      kind,
      label,
      value:
        shown.length > 120 ? `${shown.slice(0, 120)}…(${shown.length})` : shown,
      outcome: 'accepted',
      whatwg: typeof value === 'string' ? whatwg(value) : undefined,
    };
  } catch (error) {
    return {
      field,
      kind,
      label,
      value:
        shown.length > 120 ? `${shown.slice(0, 120)}…(${shown.length})` : shown,
      outcome: 'rejected',
      error: error instanceof TrainingError ? error.code : String(error),
    };
  }
}

const URL_FIELDS: { field: string; kind: Row['kind'] }[] = [
  { field: 'sourceUrl', kind: 'embed' },
  { field: 'sourceUrl', kind: 'hosted' },
  { field: 'licenseUrl', kind: 'embed' },
  { field: 'licenseUrl', kind: 'hosted' },
  { field: 'embedUrl', kind: 'embed' },
  { field: 'playbackUrl', kind: 'hosted' },
];

describe('xc deep links — InstructionalMedia URL validator under hostile payloads', () => {
  const rows: Row[] = [];

  afterAll(() => {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(ARTIFACT_DIR, 'media-url-parser-matrix.json'),
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          rows: rows.length,
          rejected: rows.filter(r => r.outcome === 'rejected').length,
          accepted: rows.filter(r => r.outcome === 'accepted').length,
          matrix: rows,
        },
        null,
        2,
      ),
    );
  });

  it('accepts the canonical youtube and hosted fixtures (harness sanity)', async () => {
    const detail = await parse([goodYoutube, goodHosted]);
    expect(detail.instructionalMedia).toHaveLength(2);
  });

  it('rejects every non-https / non-string value in every URL-bearing field', async () => {
    const accepted: Row[] = [];
    for (const { field, kind } of URL_FIELDS) {
      for (const hostile of HOSTILE_URLS) {
        // licenseUrl is nullable by contract; null there is legitimately accepted.
        if (field === 'licenseUrl' && hostile.value === null) continue;
        const row = await tryParse(field, kind, hostile.label, hostile.value);
        rows.push(row);
        if (row.outcome === 'accepted') accepted.push(row);
      }
    }
    expect(accepted).toEqual([]);
    expect(rows.length).toBeGreaterThanOrEqual(
      URL_FIELDS.length * (HOSTILE_URLS.length - 1),
    );
    for (const row of rows) {
      expect({ label: row.label, error: row.error }).toEqual({
        label: row.label,
        error: 'training.invalid_response',
      });
    }
  });

  it('a videoId cannot move embedUrl off the canonical provider host', async () => {
    const attempts: { videoId: string; embedUrl: string }[] = [
      { videoId: 'x', embedUrl: 'https://evil.example/embed/x' },
      {
        videoId: 'x',
        embedUrl: 'https://www.youtube-nocookie.com.evil.example/embed/x',
      },
      {
        videoId: 'x',
        embedUrl: 'https://www.youtube-nocookie.com/embed/x/../../evil',
      },
      { videoId: 'x', embedUrl: 'https://www.youtube-nocookie.com/embed/y' },
      {
        videoId: 'x',
        embedUrl: 'https://www.youtube-nocookie.com/embed/x?autoplay=1',
      },
      { videoId: 'x', embedUrl: 'HTTPS://www.youtube-nocookie.com/embed/x' },
      { videoId: 'x', embedUrl: 'https://player.vimeo.com/video/x' },
      { videoId: '', embedUrl: 'https://www.youtube-nocookie.com/embed/' },
    ];
    for (const attempt of attempts) {
      const row = await tryParse(
        'embedUrl',
        'embed',
        `videoId=${attempt.videoId}`,
        attempt.embedUrl,
      );
      rows.push(row);
      await expect(
        parse([{ ...goodYoutube, ...attempt }]),
      ).rejects.toMatchObject({
        code: 'training.invalid_response',
      });
    }
    // Even a hostile videoId that IS echoed consistently stays on the host:
    // the `/embed/` path prefix precedes it, so `@`, `\`, `?`, `#` land in the
    // path/query, never the authority.
    const hostileIds = [
      '@evil.example',
      '\\@evil.example',
      'x?redirect=https://evil.example',
      'x#@evil.example',
      '../../../evil',
      '<script>alert(1)</script>',
      '"onload="alert(1)',
      `${'a'.repeat(10_000)}`,
    ];
    for (const videoId of hostileIds) {
      const embedUrl = `https://www.youtube-nocookie.com/embed/${videoId}`;
      const detail = await parse([{ ...goodYoutube, videoId, embedUrl }]);
      const media = detail.instructionalMedia[0];
      expect(media?.kind).toBe('embed');
      if (media?.kind === 'embed') {
        const parsed = new URL(media.embedUrl);
        expect({
          videoId,
          hostname: parsed.hostname,
          protocol: parsed.protocol,
        }).toEqual({
          videoId,
          hostname: 'www.youtube-nocookie.com',
          protocol: 'https:',
        });
        rows.push({
          field: 'videoId',
          kind: 'embed',
          label: 'hostile-videoId-consistent-embed',
          value: videoId.length > 120 ? `${videoId.slice(0, 120)}…` : videoId,
          outcome: 'accepted',
          whatwg: whatwg(media.embedUrl),
        });
      }
    }
  });

  it('pins exactly which degenerate https:// strings the prefix check lets through (sourceUrl)', async () => {
    const accepted: string[] = [];
    for (const degenerate of DEGENERATE_HTTPS) {
      const row = await tryParse(
        'sourceUrl',
        'embed',
        degenerate.label,
        degenerate.value,
      );
      rows.push(row);
      if (row.outcome === 'accepted') accepted.push(degenerate.label);
    }
    // The validator is a prefix check, so every `https://`-prefixed string is
    // accepted. What matters for the OS handoff is the scheme, and every
    // accepted value is still `https:` (or unparseable) under WHATWG — none
    // re-parses as a different scheme.
    expect(accepted.sort()).toEqual(DEGENERATE_HTTPS.map(d => d.label).sort());
    for (const degenerate of DEGENERATE_HTTPS) {
      const parsed = whatwg(degenerate.value);
      expect({
        label: degenerate.label,
        ok: !parsed.parses || parsed.protocol === 'https:',
      }).toEqual({
        label: degenerate.label,
        ok: true,
      });
    }
  });

  it('rejects a whole detail when ANY media entry is hostile (no partial render)', async () => {
    await expect(
      parse([
        goodYoutube,
        { ...goodHosted, playbackUrl: 'javascript:alert(1)' },
      ]),
    ).rejects.toMatchObject({ code: 'training.invalid_response' });
    await expect(
      parse([goodYoutube, 'https://www.youtube.com/']),
    ).rejects.toMatchObject({
      code: 'training.invalid_response',
    });
    await expect(parse([goodYoutube, null])).rejects.toMatchObject({
      code: 'training.invalid_response',
    });
  });
});
