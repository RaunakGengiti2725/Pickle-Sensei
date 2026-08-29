import { createTrainingApi } from '../src/training/api';
import { TrainingError } from '../src/training/types';

const savedDrill = {
  id: '80184be3-3e97-4eaf-8d8e-55fa214fe6de',
  slug: 'contact-shadow',
  title: 'Contact Shadow Reps',
  description: 'A coach-reviewed contact prescription.',
  coach_name: 'Coach Rivera',
  equipment: ['paddle'],
  difficulty_min: '2.5',
  difficulty_max: '4.5',
  saved_at: '2026-08-27T18:00:00.000Z',
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
  items: [
    {
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
    },
    {
      id: '391b4bf2-c9d6-45bb-b471-250651e4e226',
      position: 4,
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
};

function response(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => payload,
  } as Response;
}

describe('real training API client', () => {
  it('fails closed when the authenticated API is not configured', async () => {
    const client = createTrainingApi({ baseUrl: null, token: null });
    await expect(client.getCurrentPlan()).rejects.toMatchObject({
      code: 'training.unconfigured',
      retryable: false,
    } satisfies Partial<TrainingError>);
  });

  it('parses server-backed saved drills and only reviewed detail payloads', async () => {
    const fetchFn = jest.fn(async (input: string) => {
      if (input.endsWith('/v1/me/saved-drills')) {
        return response(200, { items: [savedDrill] });
      }
      return response(200, {
        drill: {
          ...savedDrill,
          saved: true,
        },
        mappings: [
          {
            checkpoint: 'contact_position',
            shot_type: 'forehand_drive',
            plan_role: 'targeted',
            fault_directions: ['late'],
            cue_text: 'Meet the ball comfortably in front.',
            target_sets: 3,
            target_repetitions_per_set: 8,
            target_duration_seconds: null,
            rest_seconds: 20,
          },
        ],
        instructionalMedia: [
          {
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
          },
        ],
      });
    });
    const client = createTrainingApi({
      baseUrl: 'https://api.pickle.test',
      token: 'signed-token',
      fetchFn,
    });
    await expect(client.listSavedDrills()).resolves.toMatchObject([
      { slug: 'contact-shadow', coachName: 'Coach Rivera' },
    ]);
    await expect(client.getDrill('contact-shadow')).resolves.toMatchObject({
      saved: true,
      mappings: [{ targetSets: 3 }],
      instructionalMedia: [
        { kind: 'embed', provider: 'youtube', creatorName: 'Coach Rivera' },
      ],
    });
  });

  it('rejects an unsafe playable URL instead of rendering it', async () => {
    const client = createTrainingApi({
      baseUrl: 'https://api.pickle.test',
      token: 'signed-token',
      fetchFn: async () =>
        response(200, {
          drill: { ...savedDrill, saved: true },
          mappings: [],
          instructionalMedia: [
            {
              id: '4ecbd9d8-c2d6-4663-8561-3dbf81961a64',
              kind: 'embed',
              provider: 'youtube',
              videoId: 'abcDEF12345',
              embedUrl: 'http://example.com/not-reviewed',
              sourceUrl: 'https://www.youtube.com/watch?v=abcDEF12345',
              creatorName: 'Coach Rivera',
              licenseName: 'Permission',
              licenseUrl: null,
              attribution: 'Coach Rivera',
            },
          ],
        }),
    });
    await expect(client.getDrill('contact-shadow')).rejects.toMatchObject({
      code: 'training.invalid_response',
    });
  });

  it('sends actual completion evidence and parses server-derived streak credit', async () => {
    const fetchFn = jest.fn<Promise<Response>, [string, RequestInit?]>(
      async () =>
        response(200, {
          completion: {
            id: 'a666cd6d-afaf-48e2-897e-654702a0fc25',
            completedAt: '2026-08-27T19:00:00.000Z',
            actualRepetitions: 24,
            actualDurationSeconds: null,
            evidenceKind: 'user_confirmed',
            qualifiesForStreak: true,
          },
        }),
    );
    const client = createTrainingApi({
      baseUrl: 'https://api.pickle.test',
      token: 'signed-token',
      fetchFn,
    });
    await expect(
      client.completeDrill({
        id: 'a666cd6d-afaf-48e2-897e-654702a0fc25',
        drillSlug: 'contact-shadow',
        trainingPlanItemId: 'd32bb05c-d72c-42dd-8075-3af93a63e700',
        completedAt: '2026-08-27T19:00:00.000Z',
        actualRepetitions: 24,
        actualDurationSeconds: null,
      }),
    ).resolves.toMatchObject({ qualifiesForStreak: true });
    expect(JSON.parse(fetchFn.mock.calls[0]![1]!.body as string)).toMatchObject(
      {
        drillSlug: 'contact-shadow',
        actualRepetitions: 24,
      },
    );
  });

  it('parses a plan only from the canonical plan response', async () => {
    const client = createTrainingApi({
      baseUrl: 'https://api.pickle.test',
      token: 'signed-token',
      fetchFn: async () => response(200, { plan }),
    });
    await expect(client.getCurrentPlan()).resolves.toMatchObject({
      sourceShotId: plan.sourceShotId,
      items: [{ drill: { slug: 'contact-shadow' } }, { kind: 'reassessment' }],
    });
  });
});
