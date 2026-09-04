import {
  makeResponse,
  type RouteKind,
  type ServerModel,
} from './failureInjectionHarness';

/**
 * Wire-format model of the training routes the mobile client consumes
 * (`supabase/functions/api` shapes as pinned by `__tests__/trainingApi.test.ts`):
 * healthy bodies, plus catalogues of single-field corruptions that the strict
 * parser in `src/training/api.ts` MUST reject. Every mutation here is invalid
 * by contract — none of them is a merely-unusual-but-legal value — so an
 * accepted mutation is a parser hole, not a harness false positive.
 */

export const IDS = {
  plan: '78a7815a-176a-4487-a736-66eb2cc04455',
  sourceShot: 'b8aece05-d9dc-49eb-af98-54fe0b6e8db7',
  reassessShot: '6ce6b1c5-3b73-4a8a-9d2f-0c2c5f9d5f11',
  item1: 'd32bb05c-d72c-42dd-8075-3af93a63e700',
  item2: '391b4bf2-c9d6-45bb-b471-250651e4e226',
  item3: 'aa4a8f2c-2b1e-4d1b-9f2c-5e3d7a1b2c3d',
  completion: '0c1f0a4e-1b2c-4d3e-8f90-a1b2c3d4e5f6',
  media: '13b7e0f4-6c2a-4f0e-9a1d-2b3c4d5e6f70',
} as const;

export const DRILLS = [
  {
    id: '80184be3-3e97-4eaf-8d8e-55fa214fe6de',
    slug: 'contact-shadow',
    title: 'Contact Shadow Reps',
    description: 'A coach-reviewed contact prescription.',
    coachName: 'Coach Rivera',
  },
  {
    id: 'a2e6f9d0-1111-4222-8333-444455556666',
    slug: 'dink-target-ladder',
    title: 'Dink Target Ladder',
    description: 'Land four consecutive cross-court dinks per kitchen zone.',
    coachName: 'Pickle Sensei Training Library',
  },
  {
    id: '5f0b3c2d-9e8f-4a7b-8c6d-1e2f3a4b5c6d',
    slug: 'split-step-timer',
    title: 'Split Step Timer',
    description: 'Land the split step before the opponent contacts the ball.',
    coachName: 'Coach Okafor',
  },
] as const;

export type DrillSeed = (typeof DRILLS)[number];

export function drillBySlug(slug: string): DrillSeed {
  const found = DRILLS.find(drill => drill.slug === slug);
  if (!found) throw new Error(`unknown drill slug ${slug}`);
  return found;
}

export function savedDrillBody(drill: DrillSeed) {
  return {
    id: drill.id,
    slug: drill.slug,
    title: drill.title,
    description: drill.description,
    coach_name: drill.coachName,
    equipment: ['paddle'],
    difficulty_min: '2.5',
    difficulty_max: '4.5',
    saved_at: '2026-08-27T18:00:00.000Z',
  };
}

export function catalogDrillBody(drill: DrillSeed, saved: boolean) {
  return {
    id: drill.id,
    slug: drill.slug,
    title: drill.title,
    description: drill.description,
    coach_name: drill.coachName,
    equipment: ['paddle', 'balls'],
    difficulty_min: null,
    difficulty_max: '4.0',
    families: ['dink'],
    validation_state: 'UNVALIDATED',
    saved,
  };
}

export function mappingBody() {
  return {
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
}

export function mediaBody() {
  return {
    id: IDS.media,
    kind: 'embed',
    provider: 'youtube',
    videoId: 'abc123XYZ',
    embedUrl: 'https://www.youtube-nocookie.com/embed/abc123XYZ',
    sourceUrl: 'https://www.youtube.com/watch?v=abc123XYZ',
    creatorName: 'Coach Rivera',
    licenseName: 'YouTube Standard License',
    licenseUrl: null,
    attribution: 'Coach Rivera on YouTube',
  };
}

export function detailBody(drill: DrillSeed, saved: boolean) {
  return {
    drill: {
      id: drill.id,
      slug: drill.slug,
      title: drill.title,
      description: drill.description,
      coach_name: drill.coachName,
      equipment: ['paddle'],
      difficulty_min: '2.5',
      difficulty_max: '4.5',
      saved,
    },
    mappings: [mappingBody()],
    instructionalMedia: [mediaBody()],
  };
}

export function completionBody(input: {
  id: string;
  completedAt: string;
  actualRepetitions: number | null;
  actualDurationSeconds: number | null;
  qualifiesForStreak?: boolean;
}) {
  return {
    id: input.id,
    completedAt: input.completedAt,
    actualRepetitions: input.actualRepetitions,
    actualDurationSeconds: input.actualDurationSeconds,
    qualifiesForStreak: input.qualifiesForStreak ?? true,
  };
}

export function planItemBody(
  id: string,
  position: number,
  drill: DrillSeed | null,
  kind: 'warmup' | 'targeted' | 'reassessment',
  saved = false,
) {
  return {
    id,
    position,
    kind,
    drill: drill
      ? {
          slug: drill.slug,
          title: drill.title,
          description: drill.description,
          coachName: drill.coachName,
          equipment: ['paddle'],
          saved,
        }
      : null,
    cueText: drill ? 'Meet the ball comfortably in front.' : null,
    targetSets: drill ? 3 : null,
    targetRepetitionsPerSet: drill ? 8 : null,
    targetDurationSeconds: null,
    restSeconds: drill ? 20 : null,
    completion: null,
  };
}

export function planBody(
  options: {
    status?: 'active' | 'completed' | 'superseded';
    savedSlugs?: readonly string[];
  } = {},
) {
  const saved = new Set(options.savedSlugs ?? []);
  return {
    id: IDS.plan,
    status: options.status ?? 'active',
    algorithmVersion: 'reviewed-plan-v1',
    sourceShotId: IDS.sourceShot,
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
      planItemBody(
        IDS.item1,
        1,
        DRILLS[0],
        'warmup',
        saved.has(DRILLS[0].slug),
      ),
      planItemBody(
        IDS.item2,
        2,
        DRILLS[1],
        'targeted',
        saved.has(DRILLS[1].slug),
      ),
      planItemBody(IDS.item3, 3, null, 'reassessment'),
    ],
  };
}

type Json = Record<string, unknown>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Named single-field corruptions per route; each MUST be rejected. */
const SAVED_ITEM_MUTATIONS: ReadonlyArray<[string, (item: Json) => void]> = [
  ['id:not-uuid', item => (item['id'] = 'not-a-uuid')],
  ['id:number', item => (item['id'] = 42)],
  ['slug:missing', item => delete item['slug']],
  ['title:null', item => (item['title'] = null)],
  ['description:object', item => (item['description'] = { text: 'x' })],
  ['coach_name:array', item => (item['coach_name'] = ['x'])],
  ['difficulty_min:number', item => (item['difficulty_min'] = 2.5)],
  ['saved_at:not-iso', item => (item['saved_at'] = 'yesterday')],
  ['saved_at:number', item => (item['saved_at'] = 1756317600000)],
  ['item:string', () => undefined],
];

const CATALOG_ITEM_MUTATIONS: ReadonlyArray<[string, (item: Json) => void]> = [
  ['id:not-uuid', item => (item['id'] = '80184be3')],
  ['equipment:mixed', item => (item['equipment'] = ['paddle', 3])],
  ['families:string', item => (item['families'] = 'dink')],
  ['validation_state:missing', item => delete item['validation_state']],
  ['saved:string', item => (item['saved'] = 'true')],
  ['saved:missing', item => delete item['saved']],
  ['title:null', item => (item['title'] = null)],
];

const DETAIL_MUTATIONS: ReadonlyArray<[string, (body: Json) => void]> = [
  ['drill:null', body => (body['drill'] = null)],
  ['drill.saved:missing', body => delete (body['drill'] as Json)['saved']],
  ['drill.id:not-uuid', body => ((body['drill'] as Json)['id'] = 'x')],
  ['mappings:object', body => (body['mappings'] = {})],
  [
    'mapping.plan_role:invalid',
    body => ((body['mappings'] as Json[])[0]!['plan_role'] = 'cooldown'),
  ],
  [
    'mapping.target_sets:0',
    body => ((body['mappings'] as Json[])[0]!['target_sets'] = 0),
  ],
  [
    'mapping.target_sets:float',
    body => ((body['mappings'] as Json[])[0]!['target_sets'] = 1.5),
  ],
  [
    'mapping.reps:string',
    body =>
      ((body['mappings'] as Json[])[0]!['target_repetitions_per_set'] = '8'),
  ],
  [
    'mapping.fault_directions:mixed',
    body =>
      ((body['mappings'] as Json[])[0]!['fault_directions'] = ['late', 1]),
  ],
  [
    'mapping.cue_text:missing',
    body => delete (body['mappings'] as Json[])[0]!['cue_text'],
  ],
  ['media:string', body => (body['instructionalMedia'] = 'none')],
  [
    'media.sourceUrl:http',
    body =>
      ((body['instructionalMedia'] as Json[])[0]!['sourceUrl'] =
        'http://www.youtube.com/watch?v=abc123XYZ'),
  ],
  [
    'media.sourceUrl:javascript',
    body =>
      ((body['instructionalMedia'] as Json[])[0]!['sourceUrl'] =
        'javascript:alert(1)'),
  ],
  [
    'media.embedUrl:mismatch',
    body =>
      ((body['instructionalMedia'] as Json[])[0]!['embedUrl'] =
        'https://www.youtube-nocookie.com/embed/other'),
  ],
  [
    'media.embedUrl:foreign-host',
    body =>
      ((body['instructionalMedia'] as Json[])[0]!['embedUrl'] =
        'https://evil.example/embed/abc123XYZ'),
  ],
  [
    'media.provider:unknown',
    body =>
      ((body['instructionalMedia'] as Json[])[0]!['provider'] = 'dailymotion'),
  ],
  [
    'media.kind:unknown',
    body => ((body['instructionalMedia'] as Json[])[0]!['kind'] = 'file'),
  ],
  [
    'media.licenseUrl:http',
    body =>
      ((body['instructionalMedia'] as Json[])[0]!['licenseUrl'] =
        'http://example.com/license'),
  ],
  [
    'media.id:not-uuid',
    body => ((body['instructionalMedia'] as Json[])[0]!['id'] = 'media-1'),
  ],
  [
    'media.attribution:missing',
    body => delete (body['instructionalMedia'] as Json[])[0]!['attribution'],
  ],
  [
    'media.hosted:expiresAt-invalid',
    body => {
      const media = (body['instructionalMedia'] as Json[])[0]!;
      media['kind'] = 'hosted';
      media['playbackUrl'] = 'https://cdn.example/clip.m3u8';
      media['expiresAt'] = 'soon';
    },
  ],
  [
    'media.hosted:playbackUrl-http',
    body => {
      const media = (body['instructionalMedia'] as Json[])[0]!;
      media['kind'] = 'hosted';
      media['playbackUrl'] = 'http://cdn.example/clip.m3u8';
      media['expiresAt'] = '2026-09-01T00:00:00.000Z';
    },
  ],
];

const PLAN_MUTATIONS: ReadonlyArray<[string, (plan: Json) => void]> = [
  ['plan:string', () => undefined],
  ['id:not-uuid', plan => (plan['id'] = 'plan-1')],
  ['status:invalid', plan => (plan['status'] = 'paused')],
  ['status:missing', plan => delete plan['status']],
  ['sourceShotId:not-uuid', plan => (plan['sourceShotId'] = 'shot')],
  ['baselineScore:string', plan => (plan['baselineScore'] = '7.4')],
  ['baselineScore:NaN-null', plan => (plan['baselineScore'] = null)],
  [
    'baselineCheckpointScore:string',
    plan => (plan['baselineCheckpointScore'] = '58'),
  ],
  [
    'reassessmentShotId:not-uuid',
    plan => (plan['reassessmentShotId'] = 'later'),
  ],
  ['scoreDelta:string', plan => (plan['scoreDelta'] = '+1')],
  ['createdAt:not-iso', plan => (plan['createdAt'] = 'today')],
  ['completedAt:not-iso', plan => (plan['completedAt'] = 'done')],
  ['items:object', plan => (plan['items'] = {})],
  ['algorithmVersion:missing', plan => delete plan['algorithmVersion']],
  [
    'item.id:not-uuid',
    plan => ((plan['items'] as Json[])[0]!['id'] = 'item-1'),
  ],
  [
    'item.kind:invalid',
    plan => ((plan['items'] as Json[])[0]!['kind'] = 'stretch'),
  ],
  [
    'item.position:float',
    plan => ((plan['items'] as Json[])[0]!['position'] = 1.5),
  ],
  [
    'item.position:string-word',
    plan => ((plan['items'] as Json[])[0]!['position'] = 'first'),
  ],
  [
    'item.targetSets:string',
    plan => ((plan['items'] as Json[])[0]!['targetSets'] = '3'),
  ],
  [
    'item.cueText:number',
    plan => ((plan['items'] as Json[])[0]!['cueText'] = 5),
  ],
  [
    'item.drill.saved:missing',
    plan => delete ((plan['items'] as Json[])[0]!['drill'] as Json)['saved'],
  ],
  [
    'item.drill.slug:null',
    plan => (((plan['items'] as Json[])[0]!['drill'] as Json)['slug'] = null),
  ],
  [
    'item.reassessment-with-drill',
    plan =>
      ((plan['items'] as Json[])[2]!['drill'] = (plan['items'] as Json[])[0]![
        'drill'
      ]),
  ],
  [
    'item.targeted-without-drill',
    plan => ((plan['items'] as Json[])[1]!['drill'] = null),
  ],
  [
    'item.drill:string',
    plan => ((plan['items'] as Json[])[0]!['drill'] = 'contact-shadow'),
  ],
  [
    'item.completion:invalid',
    plan =>
      ((plan['items'] as Json[])[0]!['completion'] = {
        id: IDS.completion,
        completedAt: 'now',
        actualRepetitions: 24,
        actualDurationSeconds: null,
        qualifiesForStreak: true,
      }),
  ],
  [
    'item.completion:qualifies-string',
    plan =>
      ((plan['items'] as Json[])[0]!['completion'] = {
        id: IDS.completion,
        completedAt: '2026-08-28T18:00:00.000Z',
        actualRepetitions: 24,
        actualDurationSeconds: null,
        qualifiesForStreak: 'yes',
      }),
  ],
];

const COMPLETION_MUTATIONS: ReadonlyArray<[string, (body: Json) => void]> = [
  ['completion:null', body => (body['completion'] = null)],
  ['completion:missing', body => delete body['completion']],
  ['id:not-uuid', body => ((body['completion'] as Json)['id'] = 'c1')],
  [
    'completedAt:not-iso',
    body => ((body['completion'] as Json)['completedAt'] = 'now'),
  ],
  [
    'actualRepetitions:string',
    body => ((body['completion'] as Json)['actualRepetitions'] = '24'),
  ],
  [
    'actualDurationSeconds:NaN-string',
    body => ((body['completion'] as Json)['actualDurationSeconds'] = 'NaN'),
  ],
  [
    'qualifiesForStreak:string',
    body => ((body['completion'] as Json)['qualifiesForStreak'] = 'true'),
  ],
  [
    'qualifiesForStreak:missing',
    body => delete (body['completion'] as Json)['qualifiesForStreak'],
  ],
];

const SAVE_MUTATIONS: ReadonlyArray<
  [string, (body: Json, slug: string) => void]
> = [
  ['saved:false', body => (body['saved'] = false)],
  ['saved:string', body => (body['saved'] = 'true')],
  ['slug:other', body => (body['slug'] = 'some-other-drill')],
  ['slug:missing', body => delete body['slug']],
  ['body:array', () => undefined],
];

export interface MalformedVariant {
  body: unknown;
  mutation: string;
}

/**
 * Every named contract violation for a route, applied to list item
 * `itemIndex` where the payload is a list. Each variant MUST be rejected by
 * the strict parsers with `training.invalid_response`.
 */
export function malformedVariants(
  route: RouteKind,
  url: string,
  itemIndex: number,
  savedSlugs: ReadonlySet<string>,
): MalformedVariant[] {
  switch (route) {
    case 'saved-list':
      return SAVED_ITEM_MUTATIONS.map(([name, mutate]) => {
        const items: unknown[] = [
          ...(savedSlugs.size > 0 ? savedSlugs : [DRILLS[0].slug]),
        ].map(slug => savedDrillBody(drillBySlug(slug)));
        const index = itemIndex % items.length;
        if (name === 'item:string') items[index] = 'contact-shadow';
        else mutate(items[index] as Json);
        return { body: { items }, mutation: `saved[${index}].${name}` };
      });
    case 'catalog':
      return CATALOG_ITEM_MUTATIONS.map(([name, mutate]) => {
        const items = DRILLS.map(
          drill => catalogDrillBody(drill, false) as Json,
        );
        const index = itemIndex % items.length;
        mutate(items[index]!);
        return { body: { items }, mutation: `catalog[${index}].${name}` };
      });
    case 'detail':
      return DETAIL_MUTATIONS.map(([name, mutate]) => {
        const body = clone(
          detailBody(drillBySlug(slugFromUrl(url)), false),
        ) as Json;
        mutate(body);
        return { body, mutation: `detail.${name}` };
      });
    case 'plan-current':
    case 'plan-create':
    case 'plan-reassess':
      return PLAN_MUTATIONS.map(([name, mutate]) => {
        if (name === 'plan:string') {
          return { body: { plan: 'active' }, mutation: `plan.${name}` };
        }
        const plan = clone(planBody()) as Json;
        mutate(plan);
        return { body: { plan }, mutation: `plan.${name}` };
      });
    case 'complete':
      return COMPLETION_MUTATIONS.map(([name, mutate]) => {
        const body = clone({
          completion: completionBody({
            id: IDS.completion,
            completedAt: '2026-09-04T18:00:00.000Z',
            actualRepetitions: 24,
            actualDurationSeconds: null,
          }),
        }) as Json;
        mutate(body);
        return { body, mutation: `completion.${name}` };
      });
    case 'save': {
      const slug = slugFromUrl(url);
      return SAVE_MUTATIONS.map(([name, mutate]) => {
        if (name === 'body:array') {
          return { body: [slug], mutation: `save.${name}` };
        }
        const body: Json = { slug, saved: true };
        mutate(body, slug);
        return { body, mutation: `save.${name}` };
      });
    }
    case 'unsave':
      // DELETE ignores its body; a malformed body is indistinguishable
      // from success, so model the only wire-level corruption there is.
      return [{ body: { deleted: 'maybe' }, mutation: 'unsave.body-ignored' }];
  }
}

function slugFromUrl(url: string): string {
  const match = /\/v1\/(?:catalog\/drills|me\/saved-drills)\/([^/?]+)/.exec(
    url,
  );
  return match ? decodeURIComponent(match[1]!) : DRILLS[0].slug;
}

function planIdFromUrl(url: string): string | null {
  const match = /\/v1\/training-plans\/([^/]+)\/reassessment$/.exec(url);
  return match ? decodeURIComponent(match[1]!) : null;
}

export interface TrainingServerOptions {
  /** Slugs the server currently reports as saved (mutated by PUT/DELETE). */
  savedSlugs: Set<string>;
  /** Whether GET /v1/training-plans/current has a plan. */
  hasPlan: boolean;
}

/**
 * A stateful healthy server: PUT/DELETE saved-drills mutate `savedSlugs`, so
 * the refresh after a save reflects the mutation exactly like production.
 */
export function createTrainingServerModel(
  options: TrainingServerOptions,
): ServerModel & { state: TrainingServerOptions } {
  const state = options;
  return {
    state,
    healthy: (route, url, body) => {
      switch (route) {
        case 'saved-list':
          return makeResponse(200, {
            items: [...state.savedSlugs].map(slug =>
              savedDrillBody(drillBySlug(slug)),
            ),
          });
        case 'detail': {
          const slug = slugFromUrl(url);
          return makeResponse(
            200,
            detailBody(drillBySlug(slug), state.savedSlugs.has(slug)),
          );
        }
        case 'plan-current':
          return makeResponse(200, {
            plan: state.hasPlan
              ? planBody({ savedSlugs: [...state.savedSlugs] })
              : null,
          });
        case 'plan-create':
          state.hasPlan = true;
          return makeResponse(200, {
            plan: planBody({ savedSlugs: [...state.savedSlugs] }),
          });
        case 'plan-reassess': {
          const planId = planIdFromUrl(url);
          if (planId !== IDS.plan) return makeResponse(404, errorFor(404));
          const plan = planBody({
            status: 'completed',
            savedSlugs: [...state.savedSlugs],
          });
          const shotId = (body as Json | undefined)?.['shotId'];
          return makeResponse(200, {
            plan: {
              ...plan,
              reassessmentShotId:
                typeof shotId === 'string' ? shotId : IDS.reassessShot,
              scoreDelta: 0.6,
              completedAt: '2026-09-04T18:00:00.000Z',
            },
          });
        }
        case 'save': {
          const slug = slugFromUrl(url);
          state.savedSlugs.add(slug);
          return makeResponse(200, { slug, saved: true });
        }
        case 'unsave':
          state.savedSlugs.delete(slugFromUrl(url));
          return makeResponse(204, null);
        case 'complete': {
          const evidence = body as Json;
          return makeResponse(200, {
            completion: completionBody({
              id: String(evidence['id']),
              completedAt: String(evidence['completedAt']),
              actualRepetitions:
                typeof evidence['actualRepetitions'] === 'number'
                  ? evidence['actualRepetitions']
                  : null,
              actualDurationSeconds:
                typeof evidence['actualDurationSeconds'] === 'number'
                  ? evidence['actualDurationSeconds']
                  : null,
            }),
          });
        }
        case 'catalog':
          return makeResponse(200, {
            items: DRILLS.map(drill =>
              catalogDrillBody(drill, state.savedSlugs.has(drill.slug)),
            ),
          });
      }
    },

    malformed: (route, url, rng) =>
      rng.pick(
        malformedVariants(route, url, rng.int(DRILLS.length), state.savedSlugs),
      ),

    wrongEcho: (route, url) => {
      switch (route) {
        case 'saved-list':
        case 'catalog':
          return { plan: planBody() };
        case 'detail':
          return { items: [savedDrillBody(drillBySlug(slugFromUrl(url)))] };
        case 'plan-current':
        case 'plan-create':
        case 'plan-reassess':
          return { items: [savedDrillBody(DRILLS[0])] };
        case 'complete':
          return { plan: planBody() };
        case 'save':
          return { slug: 'a-different-drill', saved: true };
        case 'unsave':
          return { slug: slugFromUrl(url), saved: true };
      }
    },
  };
}

function errorFor(status: number) {
  return {
    error: { code: `server.${status}`, message: `Injected ${status}.` },
  };
}
