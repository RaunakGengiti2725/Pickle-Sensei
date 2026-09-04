import { createTrainingApi } from '../src/training/api';
import type { TrainingError } from '../src/training/types';

/**
 * ADVERSARIAL PASS 3 / tester #4 — parser surface of the training API
 * (`src/training/api.ts`). Every test feeds a hostile server payload through
 * the REAL client (fake fetch only) and records what the parser does. Tests
 * whose name starts with `RECORD:` pin the OBSERVED behaviour at 4d812e1a so
 * a later change is visible; they are not endorsements of that behaviour.
 *
 * Scenarios covered here: #2 (UUID version nibble / case), #4 (`saved_at`
 * strings that are not ISO but satisfy `Date.parse`), #5 (embed URL / videoId
 * hostility), #6 (degenerate `https://` playback URL), #7 (mappings object +
 * `instructionalMedia: null`), plus `Number()` coercion of `target_sets`.
 */

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const UPPER_UUID = '0B96363E-4A11-47C5-9D2C-3F5B8E6F2A17';
const LOWER_UUID = '0b96363e-4a11-47c5-9d2c-3f5b8e6f2a17';
const MEDIA_UUID = '6c8f2a4e-9b31-4f0d-8a57-2e9d4b7c1f03';

const catalogItem = {
  id: LOWER_UUID,
  slug: 'dink-target-ladder',
  title: 'Dink Target Ladder',
  description:
    'Land four consecutive cross-court dinks per kitchen zone, then move up.',
  coach_name: 'Engineering draft — not coach-validated',
  equipment: ['paddle', 'balls'],
  difficulty_min: '2.0',
  difficulty_max: '3.5',
  families: ['dink'],
  validation_state: 'UNVALIDATED',
  saved: false,
};

const savedItem = {
  id: LOWER_UUID,
  slug: 'dink-target-ladder',
  title: 'Dink Target Ladder',
  description: 'Land four consecutive cross-court dinks per kitchen zone.',
  coach_name: 'Pickle Sensei Training Library',
  equipment: ['paddle'],
  difficulty_min: null,
  difficulty_max: null,
  saved_at: '2026-08-30T10:00:00.000Z',
};

const youtubeEmbed = {
  id: MEDIA_UUID,
  kind: 'embed',
  provider: 'youtube',
  videoId: 'abc',
  embedUrl: 'https://www.youtube-nocookie.com/embed/abc',
  sourceUrl: 'https://www.youtube.com/watch?v=abc',
  creatorName: 'Third Shot Sports',
  licenseName: 'YouTube Terms of Service',
  licenseUrl: 'https://www.youtube.com/t/terms',
  attribution: 'Video by Third Shot Sports on YouTube',
};

const hostedMedia = {
  id: MEDIA_UUID,
  kind: 'hosted',
  playbackUrl: 'https://cdn.example.com/drills/dink.mp4?sig=abc',
  expiresAt: '2099-01-01T00:00:00.000Z',
  sourceUrl: 'https://example.com/drills/dink',
  creatorName: 'Pickle Sensei Coaching',
  licenseName: 'Licensed to Pickle Sensei',
  licenseUrl: null,
  attribution: 'Video licensed for Pickle Sensei',
};

const validMapping = {
  checkpoint: 'contact_height',
  shot_type: 'dink',
  plan_role: 'targeted',
  fault_directions: ['high'],
  cue_text: 'Contact the ball below your waist.',
  target_sets: 3,
  target_repetitions_per_set: 10,
  target_duration_seconds: null,
  rest_seconds: 30,
};

function detailPayload(overrides: {
  mappings?: unknown;
  instructionalMedia?: unknown;
  drill?: Record<string, unknown>;
}) {
  return {
    drill: { ...savedItem, saved: true, ...(overrides.drill ?? {}) },
    mappings: 'mappings' in overrides ? overrides.mappings : [],
    instructionalMedia:
      'instructionalMedia' in overrides ? overrides.instructionalMedia : [],
  };
}

function response(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => payload,
  } as Response;
}

function clientFor(payload: unknown) {
  return createTrainingApi({
    baseUrl: 'https://api.pickle.test',
    token: 'signed-token',
    fetchFn: jest.fn(async () => response(200, payload)),
  });
}

const invalidResponse = {
  code: 'training.invalid_response',
  retryable: true,
} satisfies Partial<TrainingError>;

describe('scenario 2 — catalog UUID version nibble and case', () => {
  it('rejects the nil UUID (version nibble 0) as training.invalid_response', async () => {
    const client = clientFor({ items: [{ ...catalogItem, id: NIL_UUID }] });
    await expect(client.listCatalogDrills({})).rejects.toMatchObject(
      invalidResponse,
    );
  });

  it('parses an uppercase UUID verbatim (case-insensitive pattern)', async () => {
    const client = clientFor({ items: [{ ...catalogItem, id: UPPER_UUID }] });
    const [drill] = await client.listCatalogDrills({});
    expect(drill?.id).toBe(UPPER_UUID);
  });

  it('rejects the nil UUID and accepts uppercase on the saved-drills and detail parsers too', async () => {
    await expect(
      clientFor({ items: [{ ...savedItem, id: NIL_UUID }] }).listSavedDrills(),
    ).rejects.toMatchObject(invalidResponse);
    await expect(
      clientFor(detailPayload({ drill: { id: NIL_UUID } })).getDrill(
        'dink-target-ladder',
      ),
    ).rejects.toMatchObject(invalidResponse);
    const [saved] = await clientFor({
      items: [{ ...savedItem, id: UPPER_UUID }],
    }).listSavedDrills();
    expect(saved?.id).toBe(UPPER_UUID);
    const detail = await clientFor(
      detailPayload({ drill: { id: UPPER_UUID } }),
    ).getDrill('dink-target-ladder');
    expect(detail.id).toBe(UPPER_UUID);
  });

  it('rejects a version-9 nibble and a variant nibble outside 8-b', async () => {
    for (const id of [
      '0b96363e-4a11-97c5-9d2c-3f5b8e6f2a17',
      '0b96363e-4a11-47c5-cd2c-3f5b8e6f2a17',
      '0b96363e-4a11-47c5-9d2c-3f5b8e6f2a1',
      '{0b96363e-4a11-47c5-9d2c-3f5b8e6f2a17}',
    ]) {
      await expect(
        clientFor({ items: [{ ...catalogItem, id }] }).listCatalogDrills({}),
      ).rejects.toMatchObject(invalidResponse);
    }
  });
});

describe('scenario 4 — saved_at strings that are not ISO 8601', () => {
  const savedWith = (savedAt: unknown) =>
    clientFor({ items: [{ ...savedItem, saved_at: savedAt }] });

  it("RECORD: '2024' passes isIso (Date.parse accepts a bare year) and is kept verbatim", async () => {
    const [drill] = await savedWith('2024').listSavedDrills();
    expect(drill?.savedAt).toBe('2024');
  });

  it("RECORD: 'Jan 1 2024' passes isIso (engine-specific legacy date syntax) and is kept verbatim", async () => {
    const [drill] = await savedWith('Jan 1 2024').listSavedDrills();
    expect(drill?.savedAt).toBe('Jan 1 2024');
  });

  it("'2024-13-45T00:00:00Z' (month 13, day 45) is rejected as training.invalid_response", async () => {
    await expect(
      savedWith('2024-13-45T00:00:00Z').listSavedDrills(),
    ).rejects.toMatchObject(invalidResponse);
  });

  it("RECORD: '2024-02-30T00:00:00Z' (impossible day, valid shape) passes isIso and is kept verbatim", async () => {
    const [drill] = await savedWith('2024-02-30T00:00:00Z').listSavedDrills();
    expect(drill?.savedAt).toBe('2024-02-30T00:00:00Z');
    // Date.parse rolls it forward instead of rejecting it.
    expect(new Date(drill!.savedAt).toISOString()).toBe(
      '2024-03-01T00:00:00.000Z',
    );
  });

  it('rejects a numeric epoch, an empty string, and a whitespace-padded date', async () => {
    for (const value of [1704067200000, '', 'not a date', null, undefined]) {
      await expect(savedWith(value).listSavedDrills()).rejects.toMatchObject(
        invalidResponse,
      );
    }
  });
});

describe('scenario 5 — embed media URL and videoId hostility', () => {
  const detailWithMedia = (media: Record<string, unknown>) =>
    clientFor(detailPayload({ instructionalMedia: [media] })).getDrill(
      'dink-target-ladder',
    );

  it("rejects embedUrl 'https://www.youtube-nocookie.com/embed/abc?autoplay=1' when videoId is 'abc'", async () => {
    await expect(
      detailWithMedia({
        ...youtubeEmbed,
        embedUrl: 'https://www.youtube-nocookie.com/embed/abc?autoplay=1',
      }),
    ).rejects.toMatchObject(invalidResponse);
  });

  it("rejects videoId 'abc<script>' when embedUrl is the canonical embed for 'abc'", async () => {
    await expect(
      detailWithMedia({ ...youtubeEmbed, videoId: 'abc<script>' }),
    ).rejects.toMatchObject(invalidResponse);
  });

  it("RECORD: videoId 'abc<script>' PASSES when the server also sends the matching embedUrl (videoId charset is not validated)", async () => {
    const detail = await detailWithMedia({
      ...youtubeEmbed,
      videoId: 'abc<script>',
      embedUrl: 'https://www.youtube-nocookie.com/embed/abc<script>',
    });
    const media = detail.instructionalMedia[0];
    expect(media?.kind).toBe('embed');
    if (media?.kind === 'embed') {
      expect(media.videoId).toBe('abc<script>');
      expect(media.embedUrl).toBe(
        'https://www.youtube-nocookie.com/embed/abc<script>',
      );
    }
  });

  it("RECORD: a query string smuggled through videoId ('abc?autoplay=1') PASSES the embedUrl equality check", async () => {
    const detail = await detailWithMedia({
      ...youtubeEmbed,
      videoId: 'abc?autoplay=1',
      embedUrl: 'https://www.youtube-nocookie.com/embed/abc?autoplay=1',
    });
    const media = detail.instructionalMedia[0];
    expect(media?.kind).toBe('embed');
    if (media?.kind === 'embed') {
      expect(media.embedUrl).toBe(
        'https://www.youtube-nocookie.com/embed/abc?autoplay=1',
      );
    }
  });

  it('RECORD: the same smuggling works for Vimeo, whose embedUrl is loaded as a WebView uri', async () => {
    const detail = await detailWithMedia({
      ...youtubeEmbed,
      provider: 'vimeo',
      videoId: '76543210?autoplay=1&muted=1#t=0',
      embedUrl:
        'https://player.vimeo.com/video/76543210?autoplay=1&muted=1#t=0',
      sourceUrl: 'https://vimeo.com/76543210',
    });
    const media = detail.instructionalMedia[0];
    expect(media?.kind).toBe('embed');
    if (media?.kind === 'embed') {
      expect(media.embedUrl).toBe(
        'https://player.vimeo.com/video/76543210?autoplay=1&muted=1#t=0',
      );
    }
  });

  // BROKEN at 4d812e1a: `videoId` is only checked to be a non-empty string,
  // so the embedUrl equality check is satisfiable by any videoId the server
  // chooses to echo. `.failing` pins the expected rejection; remove the
  // marker once the parser constrains the id charset.
  it.failing(
    'BROKEN: a videoId carrying "?", "#", "/" or "<" is rejected even when embedUrl echoes it',
    async () => {
      for (const videoId of [
        'abc<script>',
        'abc?autoplay=1',
        'abc#t=1',
        '../x',
      ]) {
        await expect(
          detailWithMedia({
            ...youtubeEmbed,
            videoId,
            embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}`,
          }),
        ).rejects.toMatchObject(invalidResponse);
      }
    },
  );

  it('rejects an http:// embedUrl, an unknown provider, and an empty videoId', async () => {
    await expect(
      detailWithMedia({
        ...youtubeEmbed,
        embedUrl: 'http://www.youtube-nocookie.com/embed/abc',
      }),
    ).rejects.toMatchObject(invalidResponse);
    await expect(
      detailWithMedia({ ...youtubeEmbed, provider: 'dailymotion' }),
    ).rejects.toMatchObject(invalidResponse);
    await expect(
      detailWithMedia({
        ...youtubeEmbed,
        videoId: '',
        embedUrl: 'https://www.youtube-nocookie.com/embed/',
      }),
    ).rejects.toMatchObject(invalidResponse);
  });
});

describe('scenario 6 — hosted media with a degenerate playback URL', () => {
  it("RECORD: playbackUrl 'https://' (scheme only) and sourceUrl 'https://evil.example/x' parse", async () => {
    const detail = await clientFor(
      detailPayload({
        instructionalMedia: [
          {
            ...hostedMedia,
            playbackUrl: 'https://',
            sourceUrl: 'https://evil.example/x',
          },
        ],
      }),
    ).getDrill('dink-target-ladder');
    const media = detail.instructionalMedia[0];
    expect(media?.kind).toBe('hosted');
    if (media?.kind === 'hosted') {
      expect(media.playbackUrl).toBe('https://');
      expect(media.sourceUrl).toBe('https://evil.example/x');
    }
  });

  it("RECORD: 'https://user@evil.example:443/x' and 'https:// spaces' also satisfy isHttpsUrl", async () => {
    for (const playbackUrl of [
      'https://user:pw@evil.example:443/x',
      'https:// not a url',
      'https://\u0000',
    ]) {
      const detail = await clientFor(
        detailPayload({
          instructionalMedia: [{ ...hostedMedia, playbackUrl }],
        }),
      ).getDrill('dink-target-ladder');
      const media = detail.instructionalMedia[0];
      expect(media?.kind === 'hosted' && media.playbackUrl).toBe(playbackUrl);
    }
  });

  // BROKEN at 4d812e1a: `isHttpsUrl` is `startsWith('https://')`, so a URL
  // with no host at all is accepted and later handed to a WebView.
  it.failing(
    "BROKEN: a playbackUrl with no host ('https://', 'https:///x') is rejected",
    async () => {
      for (const playbackUrl of ['https://', 'https:///x', 'https://?x']) {
        await expect(
          clientFor(
            detailPayload({
              instructionalMedia: [{ ...hostedMedia, playbackUrl }],
            }),
          ).getDrill('dink-target-ladder'),
        ).rejects.toMatchObject(invalidResponse);
      }
    },
  );

  it('rejects http://, javascript:, protocol-relative and case-variant schemes', async () => {
    for (const playbackUrl of [
      'http://cdn.example.com/x.mp4',
      'javascript:alert(1)',
      '//cdn.example.com/x.mp4',
      'HTTPS://cdn.example.com/x.mp4',
      ' https://cdn.example.com/x.mp4',
    ]) {
      await expect(
        clientFor(
          detailPayload({
            instructionalMedia: [{ ...hostedMedia, playbackUrl }],
          }),
        ).getDrill('dink-target-ladder'),
      ).rejects.toMatchObject(invalidResponse);
    }
  });
});

describe('scenario 7 — detail payload shape', () => {
  it('rejects mappings served as an object together with instructionalMedia: null', async () => {
    await expect(
      clientFor(
        detailPayload({
          mappings: { 0: validMapping },
          instructionalMedia: null,
        }),
      ).getDrill('dink-target-ladder'),
    ).rejects.toMatchObject(invalidResponse);
  });

  it('rejects each malformation on its own', async () => {
    await expect(
      clientFor(detailPayload({ mappings: { 0: validMapping } })).getDrill(
        'dink-target-ladder',
      ),
    ).rejects.toMatchObject(invalidResponse);
    await expect(
      clientFor(detailPayload({ instructionalMedia: null })).getDrill(
        'dink-target-ladder',
      ),
    ).rejects.toMatchObject(invalidResponse);
    await expect(
      clientFor(detailPayload({ mappings: null })).getDrill(
        'dink-target-ladder',
      ),
    ).rejects.toMatchObject(invalidResponse);
    await expect(
      clientFor(detailPayload({ instructionalMedia: 'none' })).getDrill(
        'dink-target-ladder',
      ),
    ).rejects.toMatchObject(invalidResponse);
  });

  it('still parses the well-formed payload (control)', async () => {
    const detail = await clientFor(
      detailPayload({
        mappings: [validMapping],
        instructionalMedia: [youtubeEmbed],
      }),
    ).getDrill('dink-target-ladder');
    expect(detail.mappings).toHaveLength(1);
    expect(detail.instructionalMedia).toHaveLength(1);
  });
});

describe('extra — Number() coercion in parseMapping.target_sets', () => {
  const mappingWith = (targetSets: unknown) =>
    clientFor(
      detailPayload({
        mappings: [{ ...validMapping, target_sets: targetSets }],
      }),
    ).getDrill('dink-target-ladder');

  it('RECORD: target_sets true → 1, "3" → 3, ["3"] → 3 are all accepted', async () => {
    expect((await mappingWith(true)).mappings[0]?.targetSets).toBe(1);
    expect((await mappingWith('3')).mappings[0]?.targetSets).toBe(3);
    expect((await mappingWith(['3'])).mappings[0]?.targetSets).toBe(3);
  });

  it('rejects 0, null, false, 1.5, "abc", and Infinity', async () => {
    for (const value of [0, null, false, 1.5, 'abc', Infinity, -1]) {
      await expect(mappingWith(value)).rejects.toMatchObject(invalidResponse);
    }
  });
});
