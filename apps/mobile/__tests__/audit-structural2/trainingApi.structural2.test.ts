// Structural audit #2 (pass 1) — training API client: error-status handling
// and payload-validator strictness. `REPRO:` cases assert the behaviour the
// client SHOULD have and fail on 4d812e1a; `VERIFY:` cases hold.
jest.mock('react-native-webview', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const MockWebView = (props: Record<string, unknown>) =>
    ReactModule.createElement(View, props);
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});

import { createTrainingApi } from '../../src/training/api';
import { shouldLoadInPlayer } from '../../src/components/DrillVideoPlayer';
import type { TrainingError } from '../../src/training/types';

const savedDrill = {
  id: '80184be3-3e97-4eaf-8d8e-55fa214fe6de',
  slug: 'contact-shadow',
  title: 'Contact Shadow Reps',
  description: 'A coach-reviewed contact prescription.',
  coach_name: 'Coach Rivera',
  equipment: ['paddle'],
  difficulty_min: '2.5',
  difficulty_max: '4.5',
};

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => payload,
  } as unknown as Response;
}

/** A gateway/CDN error page: non-JSON body, so response.json() rejects. */
function htmlResponse(status: number): Response {
  return {
    ok: false,
    status,
    statusText: 'Error',
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON at position 0');
    },
  } as unknown as Response;
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

async function rejection(promise: Promise<unknown>): Promise<TrainingError> {
  try {
    await promise;
  } catch (error) {
    return error as TrainingError;
  }
  throw new Error('expected the request to reject');
}

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

function detailWithMedia(media: unknown) {
  return jsonResponse(200, {
    drill: { ...savedDrill, saved: true },
    mappings: [],
    instructionalMedia: [media],
  });
}

describe('training API client — structural audit #2', () => {
  describe('non-JSON error bodies (api.ts:454-470)', () => {
    it('REPRO: a non-JSON 503 keeps its HTTP status instead of degrading to invalid_response', async () => {
      const error = await rejection(
        client(async () => htmlResponse(503)).listCatalogDrills({}),
      );
      expect(error.retryable).toBe(true);
      expect(error.status).toBe(503);
      expect(error.code).not.toBe('training.invalid_response');
    });

    it('REPRO: a non-JSON 403 is a non-retryable client failure, not a retryable invalid_response', async () => {
      const error = await rejection(
        client(async () => htmlResponse(403)).saveDrill('contact-shadow'),
      );
      expect(error.status).toBe(403);
      expect(error.retryable).toBe(false);
    });

    it('VERIFY: a JSON 503 keeps status + retryable, a JSON 429 is retryable, a JSON 409 is not', async () => {
      const c503 = await rejection(
        client(async () =>
          jsonResponse(503, {
            error: { message: 'Drill catalog unavailable.' },
          }),
        ).listCatalogDrills({}),
      );
      expect(c503).toMatchObject({
        code: 'training.request_failed',
        status: 503,
        retryable: true,
      });
      const c429 = await rejection(
        client(async () =>
          jsonResponse(429, {
            error: { code: 'rate.limited', message: 'Slow down.' },
          }),
        ).listSavedDrills(),
      );
      expect(c429).toMatchObject({
        code: 'rate.limited',
        status: 429,
        retryable: true,
      });
      const c409 = await rejection(
        client(async () =>
          jsonResponse(409, {
            error: {
              code: 'training.plan_unavailable',
              message: 'Training plans require coach-validated drill content.',
            },
          }),
        ).createPlan('b8aece05-d9dc-49eb-af98-54fe0b6e8db7'),
      );
      expect(c409).toMatchObject({
        code: 'training.plan_unavailable',
        status: 409,
        retryable: false,
      });
    });

    it('VERIFY: a 2xx non-JSON body is an invalid_response (retryable) and a thrown fetch is training.unavailable', async () => {
      const bad = await rejection(
        client(
          async () =>
            ({
              ok: true,
              status: 200,
              statusText: 'OK',
              json: async () => {
                throw new SyntaxError('bad json');
              },
            }) as unknown as Response,
        ).listCatalogDrills({}),
      );
      expect(bad).toMatchObject({
        code: 'training.invalid_response',
        retryable: true,
      });
      const offline = await rejection(
        client(async () => {
          throw new TypeError('Network request failed');
        }).listCatalogDrills({}),
      );
      expect(offline).toMatchObject({
        code: 'training.unavailable',
        retryable: true,
      });
    });
  });

  describe('payload validators (api.ts:76-82, 219, 292)', () => {
    it('REPRO: saved_at must be an ISO-8601 timestamp, not anything Date.parse tolerates', async () => {
      for (const savedAt of ['2024', 'Jan 1 2024', '0', 'Tue Aug 27 2026']) {
        const result = await client(async () =>
          jsonResponse(200, { items: [{ ...savedDrill, saved_at: savedAt }] }),
        )
          .listSavedDrills()
          .then(
            () => 'accepted',
            (e: TrainingError) => e.code,
          );
        expect({ savedAt, result }).toEqual({
          savedAt,
          result: 'training.invalid_response',
        });
      }
    });

    it('REPRO: an embed whose sourceUrl is on a foreign https host is rejected — otherwise the player gate whitelists that host in the top frame', async () => {
      const foreign = {
        ...youtubeMedia,
        sourceUrl: 'https://not-youtube.example/phish?v=abcDEF12345',
      };
      const result = await client(async () => detailWithMedia(foreign))
        .getDrill('contact-shadow')
        .then(
          detail => ({
            accepted: true,
            topFrameAllowed: shouldLoadInPlayer(detail.instructionalMedia[0]!, {
              url: 'https://not-youtube.example/anything',
              isTopFrame: true,
            }),
          }),
          (e: TrainingError) => ({ accepted: false, code: e.code }),
        );
      expect(result).toEqual({
        accepted: false,
        code: 'training.invalid_response',
      });
    });

    it('REPRO: a bare "https://" passes isHttpsUrl and reaches the media model as a sourceUrl', async () => {
      const bare = { ...youtubeMedia, sourceUrl: 'https://' };
      const result = await client(async () => detailWithMedia(bare))
        .getDrill('contact-shadow')
        .then(
          () => 'accepted',
          (e: TrainingError) => e.code,
        );
      expect(result).toBe('training.invalid_response');
    });

    it('REPRO: mapping target_sets / plan-item position are validated as numbers, not coerced with Number()', async () => {
      const mappingResult = await client(async () =>
        jsonResponse(200, {
          drill: { ...savedDrill, saved: true },
          mappings: [
            {
              checkpoint: 'contact_position',
              shot_type: 'forehand_drive',
              plan_role: 'targeted',
              fault_directions: ['late'],
              cue_text: 'Meet the ball comfortably in front.',
              target_sets: true, // Number(true) === 1
              target_repetitions_per_set: 8,
              target_duration_seconds: null,
              rest_seconds: 20,
            },
          ],
          instructionalMedia: [],
        }),
      )
        .getDrill('contact-shadow')
        .then(
          d => ({ accepted: true, targetSets: d.mappings[0]?.targetSets }),
          (e: TrainingError) => ({
            accepted: false,
            code: e.code,
          }),
        );
      expect(mappingResult).toEqual({
        accepted: false,
        code: 'training.invalid_response',
      });
    });

    it('REPRO: a plan item with position: null is rejected rather than coerced to position 0', async () => {
      const planResult = await client(async () =>
        jsonResponse(200, {
          plan: {
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
            items: [
              {
                id: '391b4bf2-c9d6-45bb-b471-250651e4e226',
                position: null, // Number(null) === 0
                kind: 'reassessment',
                drill: null,
                cueText: null,
                targetSets: null,
                targetRepetitionsPerSet: null,
                targetDurationSeconds: null,
                restSeconds: null,
                completion: null,
              },
            ],
          },
        }),
      )
        .getCurrentPlan()
        .then(
          p => ({ accepted: true, position: p?.items[0]?.position }),
          (e: TrainingError) => ({
            accepted: false,
            code: e.code,
          }),
        );
      expect(planResult).toEqual({
        accepted: false,
        code: 'training.invalid_response',
      });
    });

    it('VERIFY: the embed URL is still pinned exactly per provider and http:// sources are rejected', async () => {
      const wrongEmbed = {
        ...youtubeMedia,
        embedUrl: 'https://www.youtube.com/embed/abcDEF12345',
      };
      await expect(
        client(async () => detailWithMedia(wrongEmbed)).getDrill(
          'contact-shadow',
        ),
      ).rejects.toMatchObject({ code: 'training.invalid_response' });
      const httpSource = {
        ...youtubeMedia,
        sourceUrl: 'http://www.youtube.com/watch?v=abcDEF12345',
      };
      await expect(
        client(async () => detailWithMedia(httpSource)).getDrill(
          'contact-shadow',
        ),
      ).rejects.toMatchObject({ code: 'training.invalid_response' });
      // The canonical media passes and the gate keeps the top frame on YouTube.
      const detail = await client(async () =>
        detailWithMedia(youtubeMedia),
      ).getDrill('contact-shadow');
      const media = detail.instructionalMedia[0]!;
      expect(
        shouldLoadInPlayer(media, {
          url: 'https://www.youtube.com/watch?v=x',
          isTopFrame: true,
        }),
      ).toBe(true);
      expect(
        shouldLoadInPlayer(media, {
          url: 'https://not-youtube.example/',
          isTopFrame: true,
        }),
      ).toBe(false);
      expect(
        shouldLoadInPlayer(media, {
          url: 'http://www.youtube.com/',
          isTopFrame: true,
        }),
      ).toBe(false);
    });
  });
});
