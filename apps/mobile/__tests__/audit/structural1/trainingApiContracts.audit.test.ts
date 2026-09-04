/**
 * STRUCTURAL AUDIT #1 — training API client contracts
 * (apps/mobile/src/training/api.ts).
 *
 * Each test states the contract the client SHOULD enforce. A failing test is
 * a reproduced defect on the audited commit, not a broken test.
 */
jest.mock('react-native-webview', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const MockWebView = (props: Record<string, unknown>) =>
    ReactModule.createElement(View, props);
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});

import { createTrainingApi } from '../../../src/training/api';
import { TrainingError } from '../../../src/training/types';
import { shouldLoadInPlayer } from '../../../src/components/DrillVideoPlayer';

const drill = {
  id: '80184be3-3e97-4eaf-8d8e-55fa214fe6de',
  slug: 'contact-shadow',
  title: 'Contact Shadow Reps',
  description: 'A coach-reviewed contact prescription.',
  coach_name: 'Coach Rivera',
  equipment: ['paddle'],
  difficulty_min: '2.5',
  difficulty_max: '4.5',
};

const mapping = {
  checkpoint: 'contact_position',
  shot_type: 'forehand_drive',
  plan_role: 'targeted',
  fault_directions: ['late'],
  cue_text: 'Meet the ball comfortably in front.',
  target_sets: 3,
  target_repetitions_per_set: 8,
  target_duration_seconds: null,
  rest_seconds: 20,
};

const youtubeMedia = {
  id: '4ecbd9d8-c2d6-4663-8561-3dbf81961a64',
  kind: 'embed',
  provider: 'youtube',
  videoId: 'abcDEF12345',
  embedUrl: 'https://www.youtube-nocookie.com/embed/abcDEF12345',
  sourceUrl: 'https://www.youtube.com/watch?v=abcDEF12345',
  creatorName: 'Coach Rivera',
  licenseName: 'Published with permission',
  licenseUrl: null,
  attribution: 'Coach Rivera instructional video',
};

const planItem = {
  id: 'd32bb05c-d72c-42dd-8075-3af93a63e700',
  position: 1,
  kind: 'targeted',
  drill: {
    slug: 'contact-shadow',
    title: 'Contact Shadow Reps',
    description: 'A coach-reviewed contact prescription.',
    coachName: 'Coach Rivera',
    equipment: ['paddle'],
    saved: true,
  },
  cueText: 'Meet the ball comfortably in front.',
  targetSets: 3,
  targetRepetitionsPerSet: 8,
  targetDurationSeconds: null,
  restSeconds: 20,
  completion: null,
};

const plan = {
  id: '78a7815a-176a-4487-a736-66eb2cc04455',
  status: 'active',
  algorithmVersion: 'reviewed-plan-v1',
  sourceShotId: 'b8aece05-d9dc-49eb-af98-54fe0b6e8db7',
  shotType: 'forehand_drive',
  priorityCheckpoint: 'contact_position',
  priorityDirection: 'late',
  baselineScore: 7.4,
  baselineCheckpointScore: 58,
  reassessmentShotId: null,
  scoreDelta: null,
  createdAt: '2026-08-27T18:00:00.000Z',
  completedAt: null,
  items: [planItem],
};

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => payload,
  } as Response;
}

/** A gateway/WAF/CDN answer: HTML or text body, no JSON. */
function nonJsonResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'Error',
    json: async (): Promise<unknown> => {
      throw new SyntaxError('Unexpected token < in JSON at position 0');
    },
  } as Response;
}

function client(
  fetchFn: (input: string, init?: RequestInit) => Promise<Response>,
) {
  return createTrainingApi({
    baseUrl: 'https://api.pickle.test',
    token: 'signed-token',
    fetchFn,
  });
}

async function captureError(promise: Promise<unknown>): Promise<TrainingError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TrainingError) return error;
    throw error;
  }
  throw new Error('expected the request to reject');
}

describe('training API — HTTP status survives a non-JSON error body (api.ts readJson before !response.ok)', () => {
  it('a 502 gateway HTML page keeps its 5xx semantics (status + generic request_failed)', async () => {
    const error = await captureError(
      client(async () => nonJsonResponse(502)).listSavedDrills(),
    );
    expect({
      code: error.code,
      status: error.status,
      retryable: error.retryable,
    }).toEqual({
      code: 'training.request_failed',
      status: 502,
      retryable: true,
    });
  });

  it('a 403 WAF/HTML block is NOT presented as a retryable invalid response', async () => {
    const error = await captureError(
      client(async () => nonJsonResponse(403)).getCurrentPlan(),
    );
    expect({ status: error.status, retryable: error.retryable }).toEqual({
      status: 403,
      retryable: false,
    });
  });

  it('a 429 with a non-JSON body still carries status 429 for backoff', async () => {
    const error = await captureError(
      client(async () => nonJsonResponse(429)).saveDrill('contact-shadow'),
    );
    expect(error.status).toBe(429);
  });
});

describe('training API — schema strictness (api.ts isIso / isHttpsUrl / Number coercion)', () => {
  it('rejects saved_at values that are not ISO-8601 (Date.parse accepts "Jan 1 2024" and "2024")', async () => {
    const results = await Promise.all(
      ['Jan 1 2024', '2024', '12/31/2099'].map(async saved_at => {
        try {
          await client(async () =>
            jsonResponse(200, { items: [{ ...drill, saved_at }] }),
          ).listSavedDrills();
          return `${saved_at} → accepted`;
        } catch {
          return `${saved_at} → rejected`;
        }
      }),
    );
    expect(results).toEqual([
      'Jan 1 2024 → rejected',
      '2024 → rejected',
      '12/31/2099 → rejected',
    ]);
  });

  it('rejects hosted media whose playbackUrl is "https://" with no host', async () => {
    await expect(
      client(async () =>
        jsonResponse(200, {
          drill: { ...drill, saved: false },
          mappings: [],
          instructionalMedia: [
            {
              ...youtubeMedia,
              kind: 'hosted',
              playbackUrl: 'https://',
              expiresAt: '2099-01-01T00:00:00.000Z',
            },
          ],
        }),
      ).getDrill('contact-shadow'),
    ).rejects.toMatchObject({ code: 'training.invalid_response' });
  });

  it('a youtube embed cannot carry a sourceUrl on an arbitrary host that the player then whitelists in its top frame', async () => {
    const detail = await client(async () =>
      jsonResponse(200, {
        drill: { ...drill, saved: false },
        mappings: [],
        instructionalMedia: [
          { ...youtubeMedia, sourceUrl: 'https://not-youtube.example/landing' },
        ],
      }),
    ).getDrill('contact-shadow');
    const media = detail.instructionalMedia[0]!;
    // Either the parser rejects it (throws above) or the player gate refuses
    // a top-frame navigation to that host. Neither happening = whitelisted.
    expect(
      shouldLoadInPlayer(media, {
        url: 'https://not-youtube.example/anything',
        isTopFrame: true,
      }),
    ).toBe(false);
  });

  it('rejects non-numeric target_sets instead of coercing (true → 1, "3" → 3, [2] → 2)', async () => {
    const results = await Promise.all(
      [true, '3', [2]].map(async target_sets => {
        try {
          const detail = await client(async () =>
            jsonResponse(200, {
              drill: { ...drill, saved: false },
              mappings: [{ ...mapping, target_sets }],
              instructionalMedia: [],
            }),
          ).getDrill('contact-shadow');
          return `${JSON.stringify(target_sets)} → accepted as ${detail.mappings[0]!.targetSets}`;
        } catch {
          return `${JSON.stringify(target_sets)} → rejected`;
        }
      }),
    );
    expect(results).toEqual([
      'true → rejected',
      '"3" → rejected',
      '[2] → rejected',
    ]);
  });

  it('rejects a plan item whose position is null/boolean instead of coercing to 0/1', async () => {
    const results = await Promise.all(
      [null, false, ''].map(async position => {
        try {
          const parsed = await client(async () =>
            jsonResponse(200, {
              plan: { ...plan, items: [{ ...planItem, position }] },
            }),
          ).getCurrentPlan();
          return `${JSON.stringify(position)} → accepted as ${parsed!.items[0]!.position}`;
        } catch {
          return `${JSON.stringify(position)} → rejected`;
        }
      }),
    );
    expect(results).toEqual([
      'null → rejected',
      'false → rejected',
      '"" → rejected',
    ]);
  });

  it('getDrill(slug) rejects a detail payload for a different slug', async () => {
    await expect(
      client(async () =>
        jsonResponse(200, {
          drill: { ...drill, slug: 'some-other-drill', saved: false },
          mappings: [],
          instructionalMedia: [],
        }),
      ).getDrill('contact-shadow'),
    ).rejects.toMatchObject({ code: 'training.invalid_response' });
  });
});
