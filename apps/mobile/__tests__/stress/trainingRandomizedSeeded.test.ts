/**
 * SEEDED RANDOMIZED LONG-RUN stress for the training unit
 * (src/training/api.ts + src/training/store.ts + src/training/types.ts).
 *
 * The real `createTrainingApi` client is wired to a deterministic in-memory
 * fake server (catalog, saved drills, current plan, completions,
 * reassessment) whose responses can be delivered in any order and faulted
 * (HTTP errors, 401, network failure, unparsable JSON, type-corrupted
 * payloads). Every sequence is a SCRIPT derived from its seed — all
 * randomness is resolved up front — so any seed replays exactly, failing
 * scripts can be delta-minimised, and the same seed run twice must produce
 * an identical trace.
 *
 * Model-checked invariants (see `checkStepInvariants` / `checkSettledOp` /
 * `checkSettledModel`):
 *  I1  no store operation ever rejects or throws, nothing hangs;
 *  I2  every status/mutation value is a member of its declared union;
 *  I3  status/error coherence (ready ⇒ no error; error/unconfigured ⇒ error
 *      present and empty data; unconfigured ⇔ code training.unconfigured;
 *      no duplicate saved slugs; reassessment ⇔ no drill);
 *  I4  no usable API ⇒ no request leaves the device and every op reports
 *      training.unconfigured;
 *  I5  mutations are mutually exclusive — a busy store rejects a second
 *      mutation with `false`, issues no request and leaves state untouched;
 *  I6  `mutation` names the in-flight mutation exactly and is idle otherwise;
 *  I7  every request carries the bearer + JSON headers and a known,
 *      URL-encoded route; only POSTs carry bodies;
 *  I8  each op's boolean result and resulting error state follow from the
 *      primary response (code, retryable, HTTP status; server error codes
 *      pass through verbatim; 401 ⇒ onUnauthorized exactly once; a
 *      completion sends the prescribed totals and lands on the right item);
 *  I9  a type-corrupted payload is never accepted;
 *  I10 a response released after reconfiguration/sign-out never touches
 *      state; configure/clear/reset leave exactly the defaults;
 *  I11 finished drills reach the consistency ledger iff the server says they
 *      qualify, with the server completion id/time;
 *  I12 model agreement: whenever a load reports `ready`, saved drills, plan
 *      and drill details equal the server's truth (asserted strictly for
 *      sequential scripts; observed and classified for interleaved ones).
 *
 * Every seed is run twice (determinism) and every non-HELD seed is
 * delta-minimised; with STRESS_OUT set, a JSON table (seed → outcome, trace
 * hash, violations, divergences, minimised script) is written per mode plus
 * a per-step trace for every minimised failing script.
 *
 * Run (default STRESS_ITER=120 per mode is fast; the campaign that produced
 * the pinned findings below was STRESS_ITER=1500 per mode = 3000 sequences):
 *   cd apps/mobile && STRESS_ITER=1500 STRESS_OUT=/tmp/stress \
 *     npx jest --ci __tests__/stress/trainingRandomizedSeeded.test.ts
 * Replay one seed: STRESS_SEED=<n> [STRESS_MODE=sequential|concurrent].
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTrainingApi } from '../../src/training/api';
import {
  clearTrainingStoreConfiguration,
  configureTrainingStore,
  useTrainingStore,
  type TrainingStoreState,
} from '../../src/training/store';
import type {
  DrillCompletion,
  DrillDetail,
  SavedDrill,
  TrainingApi,
  TrainingErrorState,
  TrainingPlan,
  TrainingPlanItem,
} from '../../src/training/types';

// ─── deterministic doubles for the store's two nondeterministic inputs ──────
const mockUuidState = {
  next: (): string => '00000000-0000-4000-8000-000000000000',
};
jest.mock('../../src/util/uuid', () => ({
  makeUuid: () => mockUuidState.next(),
}));

const mockLedger: { calls: unknown[] } = { calls: [] };
jest.mock('../../src/consistency/store', () => ({
  useConsistencyStore: {
    getState: () => ({
      recordDrillCompletion: async (entry: unknown) => {
        mockLedger.calls.push(entry);
      },
    }),
  },
}));

// ─── seeded RNG (mulberry32) ────────────────────────────────────────────────
class Rng {
  state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  range(min: number, maxInclusive: number): number {
    return min + this.int(maxInclusive - min + 1);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]!;
  }
  weighted<T extends string>(weights: Record<T, number>): T {
    const entries = Object.entries(weights) as [T, number][];
    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    let roll = this.next() * total;
    for (const [key, w] of entries) {
      roll -= w;
      if (roll < 0) return key;
    }
    return entries[entries.length - 1]![0];
  }
  uuid(): string {
    const bytes: number[] = [];
    for (let i = 0; i < 16; i++) bytes.push(this.int(256));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.map(b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
}

// ─── fake server model ──────────────────────────────────────────────────────
type Profile = 'full' | 'production-shape';

type Outcome =
  | { kind: 'ok' }
  | { kind: 'http'; status: number; body: number }
  | { kind: 'unauthorized' }
  | { kind: 'netfail' }
  | { kind: 'badjson' }
  | { kind: 'malformed'; variant: number; leaf: number };

type Delivery =
  | { kind: 'json'; status: number; payload: unknown }
  | { kind: 'netfail' }
  | { kind: 'badjson' };

interface CatalogEntry {
  id: string;
  slug: string;
  title: string;
  description: string;
  coachName: string;
  equipment: string[];
  difficultyMin: string | null;
  difficultyMax: string | null;
  mappings: Record<string, unknown>[];
  media: Record<string, unknown>[];
}

interface ServerItem {
  id: string;
  position: number;
  kind: 'warmup' | 'targeted' | 'reassessment';
  drillSlug: string | null;
  cueText: string | null;
  targetSets: number | null;
  targetRepetitionsPerSet: number | null;
  targetDurationSeconds: number | null;
  restSeconds: number | null;
  completion: DrillCompletion | null;
}

interface ServerPlan {
  id: string;
  status: 'active' | 'completed' | 'superseded';
  sourceShotId: string;
  reassessmentShotId: string | null;
  scoreDelta: number | null;
  createdAt: string;
  completedAt: string | null;
  items: ServerItem[];
}

const DRILL_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,119}$/i;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE_URL = 'https://training.test';
const TOKEN = 'stress-bearer-token';
const EPOCH = Date.UTC(2026, 7, 27, 18, 0, 0);

const CATALOG: CatalogEntry[] = [
  'contact-shadow',
  'split-step-reset',
  'kitchen-dink-ladder',
  'third-shot-drop',
  'reset_block_wall',
  'paddle-up-transition',
].map((slug, index) => ({
  id: `a0000000-0000-4000-8000-00000000000${index}`,
  slug,
  title: `Drill ${index + 1}: ${slug}`,
  description: `Coach-reviewed prescription ${index + 1}.`,
  coachName: index % 2 === 0 ? 'Coach Rivera' : 'Coach Okafor',
  equipment: index % 3 === 0 ? ['paddle'] : ['paddle', 'balls'],
  difficultyMin: index % 2 === 0 ? '2.5' : null,
  difficultyMax: index % 2 === 0 ? '4.5' : null,
  mappings: [
    {
      checkpoint: 'contact_position',
      shot_type: 'forehand_drive',
      plan_role: index === 0 ? 'warmup' : 'targeted',
      fault_directions: ['late'],
      cue_text: 'Meet the ball comfortably in front.',
      target_sets: 3,
      target_repetitions_per_set: index % 2 === 0 ? 8 : null,
      target_duration_seconds: index % 2 === 0 ? null : 45,
      rest_seconds: 20,
    },
  ],
  media:
    index % 2 === 0
      ? [
          {
            id: `b0000000-0000-4000-8000-00000000000${index}`,
            kind: 'embed',
            provider: 'youtube',
            videoId: `vid${index}ABCDE`,
            embedUrl: `https://www.youtube-nocookie.com/embed/vid${index}ABCDE`,
            sourceUrl: `https://www.youtube.com/watch?v=vid${index}ABCDE`,
            creatorName: 'Coach Rivera',
            licenseName: 'Published with permission',
            licenseUrl: null,
            attribution: 'Coach Rivera instructional video',
          },
        ]
      : [
          {
            id: `b0000000-0000-4000-8000-00000000000${index}`,
            kind: 'hosted',
            playbackUrl: `https://cdn.training.test/${slug}.m3u8`,
            expiresAt: '2027-01-01T00:00:00.000Z',
            sourceUrl: `https://cdn.training.test/${slug}`,
            creatorName: 'Coach Okafor',
            licenseName: 'CC BY 4.0',
            licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
            attribution: 'Coach Okafor',
          },
        ],
}));
const CATALOG_SLUGS = CATALOG.map(d => d.slug);
const UNPUBLISHED_SLUG = 'unpublished-drill';
const INVALID_SLUG = 'Bad Slug!';
const SLUG_CHOICES = [...CATALOG_SLUGS, UNPUBLISHED_SLUG, INVALID_SLUG];

const HTTP_STATUSES = [400, 403, 404, 409, 422, 429, 500, 502, 503];
const HTTP_BODIES: unknown[] = [
  { error: { code: 'training.plan_unavailable', message: 'Not published.' } },
  { error: { code: 'validation.saved_drill', message: 'Invalid drill slug.' } },
  { error: { message: 'Unknown endpoint.' } },
  { error: 'string-error' },
  {},
  'plain text',
  null,
  { error: { code: 42, message: ['not', 'a', 'string'] } },
  { error: { code: '   ', message: '' } },
];

function iso(offsetMinutes: number): string {
  return new Date(EPOCH + offsetMinutes * 60_000).toISOString();
}

interface PendingRequest {
  seq: number;
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
  outcome: Outcome['kind'];
  delivery: Delivery;
  configVersion: number;
  opId: number;
  releasedAtVersion: number | null;
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
}

interface Attribution {
  opId: number;
  configVersion: number;
  outcome: Outcome;
}

class FakeServer {
  saved = new Map<string, string>();
  plan: ServerPlan | null = null;
  clock = 0;
  private readonly rng: Rng;

  constructor(
    readonly profile: Profile,
    seed: number,
    private readonly queue: PendingRequest[],
    private readonly nextSeq: () => number,
    private readonly attribution: () => Attribution,
  ) {
    this.rng = new Rng(seed);
  }

  private tick(): string {
    this.clock += 1;
    return iso(this.clock);
  }

  private catalog(slug: string): CatalogEntry | null {
    return CATALOG.find(d => d.slug === slug) ?? null;
  }

  private savedWire(slug: string): Record<string, unknown> {
    const entry = this.catalog(slug);
    return {
      id:
        entry?.id ??
        `c0000000-0000-4000-8000-${slug.length.toString().padStart(12, '0')}`,
      slug,
      title: entry?.title ?? slug,
      description: entry?.description ?? 'Unpublished drill.',
      coach_name: entry?.coachName ?? 'Unknown coach',
      equipment: entry?.equipment ?? [],
      difficulty_min: entry?.difficultyMin ?? null,
      difficulty_max: entry?.difficultyMax ?? null,
      saved_at: this.saved.get(slug),
    };
  }

  /** Server order: newest bookmark first (saved_at desc), like the edge fn. */
  savedSlugsOrdered(): string[] {
    return [...this.saved.entries()]
      .sort((a, b) =>
        a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : a[0] < b[0] ? -1 : 1,
      )
      .map(([slug]) => slug);
  }

  /** Client-shaped truth the store must agree with after a successful load. */
  savedView(): SavedDrill[] {
    return this.savedSlugsOrdered().map(slug => {
      const wire = this.savedWire(slug);
      return {
        id: wire['id'] as string,
        slug,
        title: wire['title'] as string,
        description: wire['description'] as string,
        coachName: wire['coach_name'] as string,
        equipment: wire['equipment'] as string[],
        difficultyMin: wire['difficulty_min'] as string | null,
        difficultyMax: wire['difficulty_max'] as string | null,
        savedAt: wire['saved_at'] as string,
      };
    });
  }

  detailView(slug: string): DrillDetail | null {
    const entry = this.catalog(slug);
    if (!entry) return null;
    return {
      id: entry.id,
      slug: entry.slug,
      title: entry.title,
      description: entry.description,
      coachName: entry.coachName,
      equipment: entry.equipment,
      difficultyMin: entry.difficultyMin,
      difficultyMax: entry.difficultyMax,
      saved: this.saved.has(slug),
      mappings: entry.mappings.map(m => ({
        checkpoint: m['checkpoint'] as string,
        shotType: m['shot_type'] as string,
        planRole: m['plan_role'] as 'warmup' | 'targeted',
        faultDirections: m['fault_directions'] as string[],
        cueText: m['cue_text'] as string,
        targetSets: m['target_sets'] as number,
        targetRepetitionsPerSet: m['target_repetitions_per_set'] as
          number | null,
        targetDurationSeconds: m['target_duration_seconds'] as number | null,
        restSeconds: m['rest_seconds'] as number | null,
      })),
      instructionalMedia: entry.media.map(media => {
        const common = {
          id: media['id'] as string,
          sourceUrl: media['sourceUrl'] as string,
          creatorName: media['creatorName'] as string,
          licenseName: media['licenseName'] as string,
          licenseUrl: media['licenseUrl'] as string | null,
          attribution: media['attribution'] as string,
        };
        return media['kind'] === 'embed'
          ? {
              ...common,
              kind: 'embed' as const,
              provider: media['provider'] as 'youtube' | 'vimeo',
              videoId: media['videoId'] as string,
              embedUrl: media['embedUrl'] as string,
            }
          : {
              ...common,
              kind: 'hosted' as const,
              playbackUrl: media['playbackUrl'] as string,
              expiresAt: media['expiresAt'] as string,
            };
      }),
    };
  }

  private itemView(item: ServerItem): TrainingPlanItem {
    const entry = item.drillSlug ? this.catalog(item.drillSlug) : null;
    return {
      id: item.id,
      position: item.position,
      kind: item.kind,
      drill:
        item.drillSlug && entry
          ? {
              slug: entry.slug,
              title: entry.title,
              description: entry.description,
              coachName: entry.coachName,
              equipment: entry.equipment,
              saved: this.saved.has(entry.slug),
            }
          : null,
      cueText: item.cueText,
      targetSets: item.targetSets,
      targetRepetitionsPerSet: item.targetRepetitionsPerSet,
      targetDurationSeconds: item.targetDurationSeconds,
      restSeconds: item.restSeconds,
      completion: item.completion ? { ...item.completion } : null,
    };
  }

  planView(): TrainingPlan | null {
    const plan = this.plan;
    if (!plan) return null;
    return {
      id: plan.id,
      status: plan.status,
      algorithmVersion: 'reviewed-plan-v1',
      sourceShotId: plan.sourceShotId,
      shotType: 'forehand_drive',
      priorityCheckpoint: 'contact_position',
      priorityDirection: 'late',
      baselineScore: 7.4,
      baselineCheckpointScore: 58,
      reassessmentShotId: plan.reassessmentShotId,
      scoreDelta: plan.scoreDelta,
      createdAt: plan.createdAt,
      completedAt: plan.completedAt,
      items: plan.items.map(item => this.itemView(item)),
    };
  }

  /** The wire plan is the client shape (camelCase) — same as the edge fn. */
  private planWire(): unknown {
    return JSON.parse(JSON.stringify(this.planView())) as unknown;
  }

  private detailWire(slug: string): unknown {
    const entry = this.catalog(slug)!;
    return {
      drill: {
        id: entry.id,
        slug: entry.slug,
        title: entry.title,
        description: entry.description,
        coach_name: entry.coachName,
        equipment: entry.equipment,
        difficulty_min: entry.difficultyMin,
        difficulty_max: entry.difficultyMax,
        saved: this.saved.has(slug),
      },
      mappings: entry.mappings.map(m => ({ ...m })),
      instructionalMedia: entry.media.map(m => ({ ...m })),
    };
  }

  private coded(status: number, code: string, message: string): Delivery {
    return { kind: 'json', status, payload: { error: { code, message } } };
  }

  private notFoundEndpoint(): Delivery {
    return {
      kind: 'json',
      status: 404,
      payload: { error: { message: 'Unknown endpoint.' } },
    };
  }

  /** Processes a request on arrival exactly like the real edge function
   * would (state committed now), returning the delivery released later. */
  private handle(method: string, path: string, body: unknown): Delivery {
    const savedMatch = /^\/v1\/me\/saved-drills\/([^/]+)$/.exec(path);
    const detailMatch = /^\/v1\/catalog\/drills\/([^/]+)$/.exec(path);
    const reassessMatch = /^\/v1\/training-plans\/([^/]+)\/reassessment$/.exec(
      path,
    );
    const record = (value: unknown): Record<string, unknown> | null =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    if (method === 'GET' && path === '/v1/me/saved-drills') {
      return {
        kind: 'json',
        status: 200,
        payload: {
          items: this.savedSlugsOrdered().map(slug => this.savedWire(slug)),
        },
      };
    }
    if (method === 'GET' && detailMatch) {
      const slug = decodeURIComponent(detailMatch[1]!);
      if (!this.catalog(slug)) {
        return this.coded(404, 'catalog.drill_not_found', 'Unknown drill.');
      }
      return { kind: 'json', status: 200, payload: this.detailWire(slug) };
    }
    if (method === 'PUT' && savedMatch) {
      const slug = decodeURIComponent(savedMatch[1]!);
      if (!DRILL_SLUG_RE.test(slug)) {
        return this.coded(400, 'validation.saved_drill', 'Invalid drill slug.');
      }
      if (!this.saved.has(slug)) this.saved.set(slug, this.tick());
      return {
        kind: 'json',
        status: 200,
        payload: { slug, saved: true, savedAt: this.saved.get(slug) },
      };
    }
    if (method === 'DELETE' && savedMatch) {
      this.saved.delete(decodeURIComponent(savedMatch[1]!));
      return { kind: 'json', status: 204, payload: null };
    }
    if (method === 'GET' && path === '/v1/training-plans/current') {
      return { kind: 'json', status: 200, payload: { plan: this.planWire() } };
    }
    if (method === 'POST' && path === '/v1/training-plans') {
      const shotId = record(body)?.['sourceShotId'];
      if (typeof shotId !== 'string' || !UUID_RE.test(shotId)) {
        return this.coded(
          400,
          'validation.training_plan',
          'sourceShotId must be a UUID.',
        );
      }
      if (this.profile === 'production-shape') {
        return this.coded(
          409,
          'training.plan_unavailable',
          'Training plans require coach-validated drill content, which has not been published yet.',
        );
      }
      if (this.plan && this.plan.status === 'active') {
        this.plan.status = 'superseded';
      }
      const pickTargeted = () =>
        CATALOG_SLUGS[1 + this.rng.int(CATALOG_SLUGS.length - 1)]!;
      const planId = this.rng.uuid();
      const items: ServerItem[] = [
        {
          id: this.rng.uuid(),
          position: 1,
          kind: 'warmup',
          drillSlug: CATALOG_SLUGS[0]!,
          cueText: 'Loosen up.',
          targetSets: 2,
          targetRepetitionsPerSet: 10,
          targetDurationSeconds: null,
          restSeconds: 15,
          completion: null,
        },
        {
          id: this.rng.uuid(),
          position: 2,
          kind: 'targeted',
          drillSlug: pickTargeted(),
          cueText: 'Meet the ball comfortably in front.',
          targetSets: 3,
          targetRepetitionsPerSet: 8,
          targetDurationSeconds: null,
          restSeconds: 20,
          completion: null,
        },
        {
          id: this.rng.uuid(),
          position: 3,
          kind: 'targeted',
          drillSlug: pickTargeted(),
          cueText: 'Hold the finish.',
          targetSets: 2,
          targetRepetitionsPerSet: null,
          targetDurationSeconds: 45,
          restSeconds: 30,
          completion: null,
        },
        {
          id: this.rng.uuid(),
          position: 4,
          kind: 'reassessment',
          drillSlug: null,
          cueText: null,
          targetSets: null,
          targetRepetitionsPerSet: null,
          targetDurationSeconds: null,
          restSeconds: null,
          completion: null,
        },
      ];
      this.plan = {
        id: planId,
        status: 'active',
        sourceShotId: shotId,
        reassessmentShotId: null,
        scoreDelta: null,
        createdAt: this.tick(),
        completedAt: null,
        items,
      };
      return { kind: 'json', status: 200, payload: { plan: this.planWire() } };
    }
    if (method === 'POST' && path === '/v1/drill-completions') {
      if (this.profile === 'production-shape') return this.notFoundEndpoint();
      const evidence = record(body);
      const itemId = evidence?.['trainingPlanItemId'];
      const evidenceId = evidence?.['id'];
      if (
        typeof evidenceId !== 'string' ||
        !UUID_RE.test(evidenceId) ||
        typeof evidence?.['completedAt'] !== 'string' ||
        Number.isNaN(Date.parse(evidence['completedAt']))
      ) {
        return this.coded(
          400,
          'validation.drill_completion',
          'Invalid evidence.',
        );
      }
      const plan = this.plan;
      const item = plan?.items.find(candidate => candidate.id === itemId);
      if (!plan || !item) {
        return this.coded(
          404,
          'training.plan_item_not_found',
          'Unknown plan item.',
        );
      }
      if (plan.status !== 'active') {
        return this.coded(
          409,
          'training.plan_not_active',
          'Plan is not active.',
        );
      }
      if (
        item.completion ||
        item.kind === 'reassessment' ||
        item.drillSlug !== evidence['drillSlug']
      ) {
        return this.coded(
          409,
          'training.completion_conflict',
          'Already completed.',
        );
      }
      const reps = evidence['actualRepetitions'];
      const seconds = evidence['actualDurationSeconds'];
      item.completion = {
        id: evidenceId,
        completedAt: this.tick(),
        actualRepetitions: typeof reps === 'number' ? reps : null,
        actualDurationSeconds: typeof seconds === 'number' ? seconds : null,
        qualifiesForStreak: item.kind === 'targeted',
      };
      return {
        kind: 'json',
        status: 200,
        payload: { completion: { ...item.completion } },
      };
    }
    if (method === 'POST' && reassessMatch) {
      if (this.profile === 'production-shape') return this.notFoundEndpoint();
      const planId = decodeURIComponent(reassessMatch[1]!);
      const shotId = record(body)?.['shotId'];
      if (typeof shotId !== 'string' || !UUID_RE.test(shotId)) {
        return this.coded(
          400,
          'validation.reassessment',
          'shotId must be a UUID.',
        );
      }
      const plan = this.plan;
      if (!plan || plan.id !== planId) {
        return this.coded(404, 'training.plan_not_found', 'Unknown plan.');
      }
      if (plan.status !== 'active') {
        return this.coded(
          409,
          'training.plan_not_active',
          'Plan is not active.',
        );
      }
      plan.status = 'completed';
      plan.reassessmentShotId = shotId;
      plan.scoreDelta = 0.7;
      plan.completedAt = this.tick();
      return { kind: 'json', status: 200, payload: { plan: this.planWire() } };
    }
    return {
      kind: 'json',
      status: 404,
      payload: { error: { message: `Unknown endpoint: ${method} ${path}.` } },
    };
  }

  /** Runs `handle` without committing anything (state + rng restored). */
  private preview(method: string, path: string, body: unknown): Delivery {
    const saved = new Map(this.saved);
    const plan = JSON.parse(JSON.stringify(this.plan)) as ServerPlan | null;
    const clock = this.clock;
    const rngState = this.rng.state;
    const delivery = this.handle(method, path, body);
    this.saved = saved;
    this.plan = plan;
    this.clock = clock;
    this.rng.state = rngState;
    return delivery;
  }

  private deliveryFor(
    method: string,
    path: string,
    body: unknown,
    outcome: Outcome,
  ): Delivery {
    switch (outcome.kind) {
      case 'ok':
        return this.handle(method, path, body);
      case 'http':
        return {
          kind: 'json',
          status: HTTP_STATUSES[outcome.status % HTTP_STATUSES.length]!,
          payload: HTTP_BODIES[outcome.body % HTTP_BODIES.length],
        };
      case 'unauthorized':
        return {
          kind: 'json',
          status: 401,
          payload: { error: { message: 'Unauthorized.' } },
        };
      case 'netfail':
        return { kind: 'netfail' };
      case 'badjson':
        return { kind: 'badjson' };
      case 'malformed': {
        // Faults never reach the handler (gateway-level failure), so the
        // model stays honest.
        const honest = this.preview(method, path, body);
        if (honest.kind !== 'json' || honest.status >= 300) return honest;
        return {
          kind: 'json',
          status: 200,
          payload: corrupt(honest.payload, outcome.variant, outcome.leaf),
        };
      }
    }
  }

  readonly fetch = (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    if (!input.startsWith(BASE_URL)) {
      return Promise.reject(new Error(`request escaped base url: ${input}`));
    }
    const path = input.slice(BASE_URL.length);
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as unknown)
        : undefined;
    const { opId, configVersion, outcome: drawn } = this.attribution();
    // A DELETE has no parsed body (the client ignores whatever comes back
    // after a 2xx), so payload corruption is meaningless there: serve honestly.
    const outcome: Outcome =
      drawn.kind === 'malformed' && method === 'DELETE'
        ? { kind: 'ok' }
        : drawn;
    const delivery = this.deliveryFor(method, path, body, outcome);
    return new Promise<Response>((resolve, reject) => {
      this.queue.push({
        seq: this.nextSeq(),
        method,
        path,
        body,
        headers: {
          ...((init?.headers as Record<string, string> | undefined) ?? {}),
        },
        outcome: outcome.kind,
        delivery,
        configVersion,
        opId,
        releasedAtVersion: null,
        resolve,
        reject,
      });
    });
  };
}

function describeDelivery(delivery: Delivery): string {
  if (delivery.kind !== 'json') return delivery.kind;
  return `${delivery.status}`;
}

function deliver(request: PendingRequest, releasedAtVersion: number): void {
  request.releasedAtVersion = releasedAtVersion;
  const delivery = request.delivery;
  if (delivery.kind === 'netfail') {
    request.reject(new TypeError('Network request failed'));
    return;
  }
  if (delivery.kind === 'badjson') {
    request.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    } as unknown as Response);
    return;
  }
  request.resolve({
    ok: delivery.status >= 200 && delivery.status < 300,
    status: delivery.status,
    statusText: delivery.status === 200 ? 'OK' : 'Error',
    json: async () => delivery.payload,
  } as unknown as Response);
}

/** Keys the client deliberately does not parse (or coerces leniently);
 * corrupting them is not a contract violation, so they are never targeted. */
const UNPARSED_KEYS = new Set(['equipment', 'savedAt']);
const MALFORMED_WRAPPERS: unknown[] = [
  {},
  [],
  null,
  'text/html',
  { items: {} },
  { plan: {} },
  { completion: null },
  { items: [null] },
  { plan: { items: 'none' } },
];

function leafPaths(
  value: unknown,
  path: (string | number)[] = [],
  out: (string | number)[][] = [],
): (string | number)[][] {
  if (Array.isArray(value)) {
    if (path.length > 0) out.push(path);
    value.forEach((entry, index) => leafPaths(entry, [...path, index], out));
  } else if (value && typeof value === 'object') {
    if (path.length > 0) out.push(path);
    for (const [key, entry] of Object.entries(value)) {
      if (UNPARSED_KEYS.has(key)) continue;
      leafPaths(entry, [...path, key], out);
    }
  } else if (path.length > 0) {
    out.push(path);
  }
  return out;
}

function wrongType(value: unknown): unknown {
  if (Array.isArray(value)) return 'not-an-array';
  if (value === null) return { unexpected: true };
  switch (typeof value) {
    case 'string':
      return 7;
    case 'number':
      return 'seven';
    case 'boolean':
      return 'yes';
    default:
      return [];
  }
}

/** Swaps the payload for a wrong shape, or type-corrupts one parsed leaf.
 * Every produced payload MUST be rejected by the client. */
function corrupt(payload: unknown, variant: number, leaf: number): unknown {
  if (variant % 3 === 0) {
    return MALFORMED_WRAPPERS[variant % MALFORMED_WRAPPERS.length];
  }
  const clone = JSON.parse(JSON.stringify(payload)) as unknown;
  const paths = leafPaths(clone);
  if (paths.length === 0) return MALFORMED_WRAPPERS[0];
  const target = paths[leaf % paths.length]!;
  let cursor: unknown = clone;
  for (const key of target.slice(0, -1)) {
    cursor = (cursor as Record<string | number, unknown>)[key];
  }
  const last = target[target.length - 1]!;
  const holder = cursor as Record<string | number, unknown>;
  holder[last] = wrongType(holder[last]);
  return clone;
}

// ─── scripts (all randomness resolved from the seed) ────────────────────────
type Mode = 'sequential' | 'concurrent';

type OpKind =
  | 'loadSaved'
  | 'loadPlan'
  | 'createPlan'
  | 'reassess'
  | 'setSaved'
  | 'complete';

type ItemVariant =
  'store-item' | 'stale-completed' | 'no-drill' | 'zero-sets' | 'unknown-id';

type OpStep =
  | { t: 'op'; op: 'loadSaved' | 'loadPlan'; outcomes: Outcome[] }
  | { t: 'op'; op: 'createPlan'; shotId: string; outcomes: Outcome[] }
  | { t: 'op'; op: 'reassess'; shotId: string; outcomes: Outcome[] }
  | {
      t: 'op';
      op: 'setSaved';
      slug: string;
      saved: boolean;
      outcomes: Outcome[];
    }
  | {
      t: 'op';
      op: 'complete';
      pick: number;
      variant: ItemVariant;
      syntheticId: string;
      outcomes: Outcome[];
    };

type Step =
  | OpStep
  | { t: 'release'; pick: number }
  | { t: 'drain'; order: 'fifo' | 'shuffled'; seed: number }
  | {
      t: 'reconfigure';
      profile: Profile | 'unconfigured-client';
      serverSeed: number;
    }
  | { t: 'clearConfig' }
  | { t: 'reset' }
  | { t: 'clearError' };

interface Script {
  seed: number;
  mode: Mode;
  uuidSeed: number;
  steps: Step[];
}

function genOutcome(rng: Rng): Outcome {
  const kind = rng.weighted({
    ok: 68,
    http: 11,
    netfail: 6,
    unauthorized: 3,
    badjson: 4,
    malformed: 8,
  });
  switch (kind) {
    case 'ok':
      return { kind: 'ok' };
    case 'http':
      return { kind: 'http', status: rng.int(1000), body: rng.int(1000) };
    case 'unauthorized':
      return { kind: 'unauthorized' };
    case 'netfail':
      return { kind: 'netfail' };
    case 'badjson':
      return { kind: 'badjson' };
    default:
      return { kind: 'malformed', variant: rng.int(1000), leaf: rng.int(1000) };
  }
}

function genOutcomes(rng: Rng): Outcome[] {
  const count = rng.range(1, 10);
  const outcomes: Outcome[] = [];
  for (let i = 0; i < count; i++) outcomes.push(genOutcome(rng));
  return outcomes;
}

function genShotId(rng: Rng): string {
  return rng.chance(0.9)
    ? rng.uuid()
    : rng.pick(['not-a-uuid', '', 'b8aece05-d9dc-49eb-af98']);
}

function genOpStep(rng: Rng): OpStep {
  const op = rng.weighted<OpKind>({
    loadSaved: 18,
    loadPlan: 16,
    createPlan: 12,
    reassess: 9,
    setSaved: 22,
    complete: 18,
  });
  const outcomes = genOutcomes(rng);
  switch (op) {
    case 'loadSaved':
    case 'loadPlan':
      return { t: 'op', op, outcomes };
    case 'createPlan':
      return { t: 'op', op, shotId: genShotId(rng), outcomes };
    case 'reassess':
      return { t: 'op', op, shotId: genShotId(rng), outcomes };
    case 'setSaved':
      return {
        t: 'op',
        op,
        slug: rng.pick(SLUG_CHOICES),
        saved: rng.chance(0.55),
        outcomes,
      };
    case 'complete':
      return {
        t: 'op',
        op,
        pick: rng.int(1000),
        variant: rng.weighted<ItemVariant>({
          'store-item': 60,
          'stale-completed': 10,
          'no-drill': 8,
          'zero-sets': 8,
          'unknown-id': 14,
        }),
        syntheticId: rng.uuid(),
        outcomes,
      };
  }
}

function genScript(seed: number, mode: Mode): Script {
  const rng = new Rng(
    (Math.imul(seed, 0x9e3779b1) ^ (mode === 'sequential' ? 0x51 : 0xc0)) >>> 0,
  );
  const uuidSeed = rng.int(0xffffffff);
  const length = rng.range(5, 60);
  const steps: Step[] = [];
  const profileOf = (): Profile | 'unconfigured-client' =>
    rng.weighted({
      full: 80,
      'production-shape': 12,
      'unconfigured-client': 8,
    });
  // Most scripts begin configured; some start signed-out on purpose.
  if (rng.chance(0.85)) {
    steps.push({
      t: 'reconfigure',
      profile: profileOf(),
      serverSeed: rng.int(0xffffffff),
    });
  }
  for (let i = steps.length; i < length; i++) {
    const kind =
      mode === 'sequential'
        ? rng.weighted({
            op: 78,
            reconfigure: 6,
            clearConfig: 4,
            reset: 4,
            clearError: 8,
          })
        : rng.weighted({
            op: 45,
            release: 24,
            drain: 8,
            reconfigure: 6,
            clearConfig: 4,
            reset: 4,
            clearError: 9,
          });
    switch (kind) {
      case 'op':
        steps.push(genOpStep(rng));
        break;
      case 'release':
        steps.push({ t: 'release', pick: rng.int(1000) });
        break;
      case 'drain':
        steps.push({
          t: 'drain',
          order: rng.chance(0.5) ? 'fifo' : 'shuffled',
          seed: rng.int(0xffffffff),
        });
        break;
      case 'reconfigure':
        steps.push({
          t: 'reconfigure',
          profile: profileOf(),
          serverSeed: rng.int(0xffffffff),
        });
        break;
      case 'clearConfig':
        steps.push({ t: 'clearConfig' });
        break;
      case 'reset':
        steps.push({ t: 'reset' });
        break;
      case 'clearError':
        steps.push({ t: 'clearError' });
        break;
    }
  }
  return { seed, mode, uuidSeed, steps };
}

// ─── execution + model checking ─────────────────────────────────────────────
type Snapshot = Pick<
  TrainingStoreState,
  | 'savedStatus'
  | 'planStatus'
  | 'mutation'
  | 'savedDrills'
  | 'drillDetails'
  | 'currentPlan'
  | 'savedError'
  | 'planError'
  | 'mutationError'
>;

function snapshot(): Snapshot {
  const s = useTrainingStore.getState();
  return {
    savedStatus: s.savedStatus,
    planStatus: s.planStatus,
    mutation: s.mutation,
    savedDrills: s.savedDrills,
    drillDetails: s.drillDetails,
    currentPlan: s.currentPlan,
    savedError: s.savedError,
    planError: s.planError,
    mutationError: s.mutationError,
  };
}

function defaultsSnapshot(): Snapshot {
  return {
    savedStatus: 'idle',
    planStatus: 'idle',
    mutation: 'idle',
    savedDrills: [],
    drillDetails: {},
    currentPlan: null,
    savedError: null,
    planError: null,
    mutationError: null,
  };
}

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>).sort(([a], [b]) =>
          a < b ? -1 : 1,
        ),
      );
    }
    return entry;
  });

const same = (a: unknown, b: unknown): boolean => stable(a) === stable(b);

interface ExpectedError {
  code: string;
  retryable: boolean;
  status: number | null;
}

function expectedErrorFor(delivery: Delivery): ExpectedError {
  if (delivery.kind === 'netfail') {
    return { code: 'training.unavailable', retryable: true, status: null };
  }
  if (delivery.kind === 'badjson') {
    return { code: 'training.invalid_response', retryable: true, status: null };
  }
  if (delivery.status === 401) {
    return { code: 'training.session_expired', retryable: false, status: 401 };
  }
  const payload = delivery.payload;
  const error =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)['error']
      : undefined;
  const record =
    error && typeof error === 'object' && !Array.isArray(error)
      ? (error as Record<string, unknown>)
      : null;
  const rawCode = record?.['code'];
  const code =
    typeof rawCode === 'string' && rawCode.trim().length > 0
      ? rawCode
      : 'training.request_failed';
  return {
    code,
    retryable: delivery.status >= 500 || delivery.status === 429,
    status: delivery.status,
  };
}

function isSuccessDelivery(delivery: Delivery): boolean {
  return (
    delivery.kind === 'json' && delivery.status >= 200 && delivery.status < 300
  );
}

const INVALID_RESPONSE: ExpectedError = {
  code: 'training.invalid_response',
  retryable: true,
  status: null,
};

interface OpRecord {
  id: number;
  step: OpStep;
  label: string;
  configVersion: number;
  outcomes: Outcome[];
  requests: PendingRequest[];
  classification: 'busy' | 'noapi' | 'precondition' | 'issued';
  preconditionCode: string | null;
  itemUsed: TrainingPlanItem | null;
  settled: boolean;
  result: boolean | null;
  rejection: unknown;
  settledAtVersion: number | null;
  ledgerBefore: number;
  onUnauthorizedBefore: number;
  settledCountBefore: number;
  stateBefore: Snapshot;
  checked: boolean;
}

interface Violation {
  invariant: string;
  step: number;
  detail: string;
}

interface Divergence {
  step: number;
  field: 'savedDrills' | 'currentPlan' | 'drillDetails';
  overlapped: boolean;
  detail: string;
}

interface RunResult {
  seed: number;
  mode: Mode;
  steps: number;
  requests: number;
  ops: number;
  violations: Violation[];
  divergences: Divergence[];
  trace: string;
}

const settle = async (): Promise<void> => {
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
};

const STATUSES = new Set(['idle', 'loading', 'ready', 'unconfigured', 'error']);
const MUTATION_RE =
  /^(idle|creating-plan|reassessing|saving:.+|completing:.+)$/;
const KNOWN_ROUTES: [string, RegExp][] = [
  ['GET', /^\/v1\/me\/saved-drills$/],
  ['GET', /^\/v1\/catalog\/drills\/[^/]+$/],
  ['PUT', /^\/v1\/me\/saved-drills\/[^/]+$/],
  ['DELETE', /^\/v1\/me\/saved-drills\/[^/]+$/],
  ['GET', /^\/v1\/training-plans\/current$/],
  ['POST', /^\/v1\/training-plans$/],
  ['POST', /^\/v1\/drill-completions$/],
  ['POST', /^\/v1\/training-plans\/[^/]+\/reassessment$/],
];

async function runScript(script: Script): Promise<RunResult> {
  const violations: Violation[] = [];
  const divergences: Divergence[] = [];
  const trace: string[] = [];
  const ops: OpRecord[] = [];
  const queue: PendingRequest[] = [];
  const released: PendingRequest[] = [];
  let server: FakeServer | null = null;
  let apiConfigured = false; // an api object is installed …
  let apiUsable = false; // … and it can actually reach the server
  let configVersion = 0;
  let onUnauthorizedCount = 0;
  let seq = 0;
  let settledCount = 0;
  let currentOpId = -1;
  let overlapSeen = false;
  let stepIndex = -1;
  mockLedger.calls = [];

  const uuidRng = new Rng(script.uuidSeed);
  mockUuidState.next = () => uuidRng.uuid();

  const fail = (invariant: string, detail: string) => {
    violations.push({ invariant, step: stepIndex, detail });
  };

  const attribution = (): Attribution => {
    const op = ops[currentOpId];
    return {
      opId: currentOpId,
      configVersion,
      outcome: op?.outcomes.shift() ?? { kind: 'ok' },
    };
  };

  const install = (
    profile: Profile | 'unconfigured-client',
    serverSeed: number,
  ) => {
    configVersion += 1;
    const usable = profile !== 'unconfigured-client';
    server = new FakeServer(
      usable ? profile : 'full',
      serverSeed,
      queue,
      () => ++seq,
      attribution,
    );
    const api: TrainingApi = createTrainingApi({
      baseUrl: usable ? `${BASE_URL}/` : '   ',
      token: usable ? TOKEN : null,
      fetchFn: server.fetch,
      onUnauthorized: () => {
        onUnauthorizedCount += 1;
      },
    });
    configureTrainingStore(api);
    apiConfigured = true;
    apiUsable = usable;
  };

  const inFlight = () => ops.filter(op => !op.settled);
  const mutationLabel = (op: OpRecord): string | null => {
    switch (op.step.op) {
      case 'createPlan':
        return 'creating-plan';
      case 'reassess':
        return 'reassessing';
      case 'setSaved':
        return `saving:${op.step.slug}`;
      case 'complete':
        return op.itemUsed ? `completing:${op.itemUsed.id}` : null;
      default:
        return null;
    }
  };
  const primaryOf = (op: OpRecord): PendingRequest | undefined =>
    op.requests[0];
  /** `mutation` must show the label while the op holds the store's mutation
   * slot: for saves only until the PUT/DELETE answers (the reload runs
   * idle), for the others until the op settles. */
  const holdsMutationSlot = (op: OpRecord): boolean => {
    if (op.settled || op.classification !== 'issued') return false;
    if (op.configVersion !== configVersion) return false;
    if (mutationLabel(op) === null) return false;
    if (op.step.op !== 'setSaved') return true;
    const primary = primaryOf(op);
    return !primary || primary.releasedAtVersion === null;
  };

  const checkStepInvariants = () => {
    const s = snapshot();
    if (!STATUSES.has(s.savedStatus))
      fail('I2', `savedStatus=${s.savedStatus}`);
    if (!STATUSES.has(s.planStatus)) fail('I2', `planStatus=${s.planStatus}`);
    if (!MUTATION_RE.test(s.mutation)) fail('I2', `mutation=${s.mutation}`);
    if (s.savedStatus === 'ready' && s.savedError !== null) {
      fail('I3', 'ready saved with error');
    }
    if (s.planStatus === 'ready' && s.planError !== null) {
      fail('I3', 'ready plan with error');
    }
    if (
      (s.savedStatus === 'error' || s.savedStatus === 'unconfigured') &&
      (s.savedError === null || s.savedDrills.length > 0)
    ) {
      fail(
        'I3',
        `savedStatus=${s.savedStatus} error=${stable(s.savedError)} drills=${s.savedDrills.length}`,
      );
    }
    if (
      (s.planStatus === 'error' || s.planStatus === 'unconfigured') &&
      (s.planError === null || s.currentPlan !== null)
    ) {
      fail(
        'I3',
        `planStatus=${s.planStatus} error=${stable(s.planError)} plan=${s.currentPlan !== null}`,
      );
    }
    if (
      (s.savedStatus === 'unconfigured') !==
      (s.savedError?.code === 'training.unconfigured')
    ) {
      fail(
        'I3',
        `savedStatus=${s.savedStatus} savedError.code=${s.savedError?.code}`,
      );
    }
    if (
      (s.planStatus === 'unconfigured') !==
      (s.planError?.code === 'training.unconfigured')
    ) {
      fail(
        'I3',
        `planStatus=${s.planStatus} planError.code=${s.planError?.code}`,
      );
    }
    const slugs = s.savedDrills.map(d => d.slug);
    if (new Set(slugs).size !== slugs.length) {
      fail('I3', `duplicate saved slugs ${slugs.join(',')}`);
    }
    for (const [slug, detail] of Object.entries(s.drillDetails)) {
      if (detail.slug !== slug) {
        fail('I3', `drillDetails key ${slug} holds ${detail.slug}`);
      }
    }
    for (const item of s.currentPlan?.items ?? []) {
      if ((item.kind === 'reassessment') !== (item.drill === null)) {
        fail('I3', `item ${item.id} kind/drill mismatch`);
      }
    }
    const holders = ops.filter(holdsMutationSlot);
    if (holders.length > 1) {
      fail(
        'I5',
        `two mutations in flight: ${holders.map(h => h.label).join(' | ')}`,
      );
    }
    const expectedMutation =
      holders.length === 1 ? mutationLabel(holders[0]!) : 'idle';
    if (s.mutation !== expectedMutation) {
      fail('I6', `mutation=${s.mutation} expected=${expectedMutation}`);
    }
  };

  const checkErrorState = (
    op: OpRecord,
    actual: TrainingErrorState | null,
    expected: ExpectedError,
    where: string,
  ) => {
    if (!actual) {
      fail('I8', `${op.label}: ${where} is null, expected ${stable(expected)}`);
      return;
    }
    if (
      actual.code !== expected.code ||
      actual.retryable !== expected.retryable ||
      actual.status !== expected.status
    ) {
      fail(
        'I8',
        `${op.label}: ${where}=${stable(actual)} expected ${stable(expected)}`,
      );
    }
    if (typeof actual.message !== 'string' || actual.message.trim() === '') {
      fail('I8', `${op.label}: ${where} has an empty message`);
    }
  };

  /** Expected error for a failed primary: a corrupted 2xx is an
   * invalid_response, everything else follows the HTTP mapping. */
  const expectedFailure = (request: PendingRequest): ExpectedError =>
    request.outcome === 'malformed' && isSuccessDelivery(request.delivery)
      ? INVALID_RESPONSE
      : expectedErrorFor(request.delivery);

  /** Whether the primary response lets the op succeed: a 2xx that was not
   * corrupted. */
  const primarySucceeds = (request: PendingRequest): boolean =>
    isSuccessDelivery(request.delivery) && request.outcome !== 'malformed';

  /** Runs once, right after an op's promise settles. Only the op owning the
   * just-released request can settle, so the store state is its result. */
  const checkSettledOp = (op: OpRecord) => {
    op.checked = true;
    const s = snapshot();
    // `alone`: nothing else settled between this op's fire and its settle;
    // `isolated`: additionally nothing else was fired — only then may the
    // observed state be attributed to this op alone.
    const alone = settledCount - op.settledCountBefore === 1;
    const isolated = alone && ops.length === op.id + 1;
    if (op.rejection !== undefined) {
      fail('I1', `${op.label} rejected: ${String(op.rejection)}`);
      return;
    }
    if (op.classification === 'busy') {
      if (op.result !== false)
        fail('I5', `${op.label} busy but returned ${op.result}`);
      if (op.requests.length > 0) {
        fail(
          'I5',
          `${op.label} busy but issued ${op.requests.length} requests`,
        );
      }
      if (isolated && !same(s, op.stateBefore)) {
        fail('I5', `${op.label} busy but state changed`);
      }
      return;
    }
    if (op.classification === 'noapi') {
      if (op.result !== false) {
        fail('I4', `${op.label} unconfigured but returned ${op.result}`);
      }
      if (op.requests.length > 0) {
        fail(
          'I4',
          `${op.label} unconfigured but issued ${op.requests.length} requests`,
        );
      }
      const expected: ExpectedError = {
        code: 'training.unconfigured',
        retryable: false,
        status: null,
      };
      if (op.step.op === 'loadSaved') {
        if (s.savedStatus !== 'unconfigured') {
          fail('I4', `${op.label} savedStatus=${s.savedStatus}`);
        }
        checkErrorState(op, s.savedError, expected, 'savedError');
      } else if (op.step.op === 'loadPlan') {
        if (s.planStatus !== 'unconfigured') {
          fail('I4', `${op.label} planStatus=${s.planStatus}`);
        }
        checkErrorState(op, s.planError, expected, 'planError');
      } else {
        checkErrorState(op, s.mutationError, expected, 'mutationError');
      }
      return;
    }
    if (op.classification === 'precondition') {
      if (op.result !== false) {
        fail(
          'I8',
          `${op.label} precondition-rejected but returned ${op.result}`,
        );
      }
      if (op.requests.length > 0) {
        fail('I8', `${op.label} precondition-rejected but issued requests`);
      }
      if (
        s.mutationError?.code !== op.preconditionCode ||
        s.mutationError.retryable !== false
      ) {
        fail(
          'I8',
          `${op.label} mutationError=${stable(s.mutationError)} expected code ${op.preconditionCode}`,
        );
      }
      return;
    }
    // issued
    const primary = primaryOf(op);
    if (!primary) {
      fail('I8', `${op.label} issued but no request recorded`);
      return;
    }
    const superseded = op.settledAtVersion !== op.configVersion;
    const primaryStale = primary.releasedAtVersion !== op.configVersion;
    const primaryOk = primarySucceeds(primary);
    if (
      primary.outcome === 'malformed' &&
      isSuccessDelivery(primary.delivery)
    ) {
      if (op.result === true && !superseded) {
        fail(
          'I9',
          `${op.label} accepted a type-corrupted payload: ${stable(primary.delivery)}`,
        );
      }
    }
    if (
      alone &&
      primary.delivery.kind === 'json' &&
      primary.delivery.status === 401
    ) {
      const calls = onUnauthorizedCount - op.onUnauthorizedBefore;
      if (calls !== 1)
        fail('I8', `${op.label} 401 but onUnauthorized called ${calls}×`);
    }
    if (op.step.op === 'setSaved') {
      const expected = primaryOk && !primaryStale;
      if (op.result !== expected) {
        fail(
          'I8',
          `${op.label} returned ${op.result}, expected ${expected} (primary ${describeDelivery(primary.delivery)} stale=${primaryStale})`,
        );
      }
      if (primaryStale) return;
      if (!primaryOk) {
        checkErrorState(
          op,
          s.mutationError,
          expectedFailure(primary),
          'mutationError',
        );
        return;
      }
      if (superseded) return;
      // The reload runs with the mutation slot released, so another mutation
      // may already have failed in between; only judge when nothing else did.
      if (isolated && s.mutationError !== null) {
        fail(
          'I8',
          `${op.label} succeeded but mutationError=${stable(s.mutationError)}`,
        );
      }
      const reload = op.requests.find(
        r => r.method === 'GET' && r.path === '/v1/me/saved-drills',
      );
      if (!reload) {
        fail('I8', `${op.label} succeeded without reloading saved drills`);
        return;
      }
      if (reload.releasedAtVersion !== op.configVersion) return;
      if (primarySucceeds(reload)) {
        if (s.savedStatus !== 'ready') {
          fail('I8', `${op.label} reload ok but savedStatus=${s.savedStatus}`);
        }
      } else {
        if (s.savedStatus !== 'error') {
          fail(
            'I8',
            `${op.label} reload failed but savedStatus=${s.savedStatus}`,
          );
        }
        checkErrorState(
          op,
          s.savedError,
          expectedFailure(reload),
          'savedError',
        );
      }
      if (!isolated) return;
      const slug = op.step.slug;
      if (
        s.drillDetails[slug] &&
        s.drillDetails[slug]!.saved !== op.step.saved
      ) {
        fail('I8', `${op.label} detail.saved=${s.drillDetails[slug]!.saved}`);
      }
      for (const item of s.currentPlan?.items ?? []) {
        if (item.drill?.slug === slug && item.drill.saved !== op.step.saved) {
          fail(
            'I8',
            `${op.label} plan item ${item.id} drill.saved=${item.drill.saved}`,
          );
        }
      }
      if (!op.step.saved && s.savedDrills.some(d => d.slug === slug)) {
        fail('I8', `${op.label} unsaved slug still listed`);
      }
      return;
    }
    const expected = primaryOk && !superseded;
    if (op.result !== expected) {
      fail(
        'I8',
        `${op.label} returned ${op.result}, expected ${expected} (primary ${describeDelivery(primary.delivery)} superseded=${superseded})`,
      );
    }
    if (superseded) return;
    const expectedError = primaryOk ? null : expectedFailure(primary);
    switch (op.step.op) {
      case 'loadSaved':
        if (primaryOk) {
          if (s.savedStatus !== 'ready' || s.savedError !== null) {
            fail('I8', `${op.label} ok but savedStatus=${s.savedStatus}`);
          }
        } else {
          if (s.savedStatus !== 'error' || s.savedDrills.length !== 0) {
            fail('I8', `${op.label} failed but savedStatus=${s.savedStatus}`);
          }
          checkErrorState(op, s.savedError, expectedError!, 'savedError');
        }
        break;
      case 'loadPlan':
        if (primaryOk) {
          if (s.planStatus !== 'ready' || s.planError !== null) {
            fail('I8', `${op.label} ok but planStatus=${s.planStatus}`);
          }
        } else {
          if (s.planStatus !== 'error' || s.currentPlan !== null) {
            fail('I8', `${op.label} failed but planStatus=${s.planStatus}`);
          }
          checkErrorState(op, s.planError, expectedError!, 'planError');
        }
        break;
      case 'createPlan':
      case 'reassess':
        if (primaryOk) {
          if (
            s.planStatus !== 'ready' ||
            s.mutationError !== null ||
            s.currentPlan === null
          ) {
            fail(
              'I8',
              `${op.label} ok but planStatus=${s.planStatus} plan=${s.currentPlan !== null}`,
            );
          }
        } else {
          checkErrorState(op, s.mutationError, expectedError!, 'mutationError');
          if (alone && !same(s.currentPlan, op.stateBefore.currentPlan)) {
            fail('I8', `${op.label} failed but plan changed`);
          }
        }
        break;
      case 'complete': {
        const item = op.itemUsed!;
        const ledgerCalls = mockLedger.calls.length - op.ledgerBefore;
        if (primaryOk) {
          if (s.mutationError !== null)
            fail('I8', `${op.label} ok but mutationError set`);
          const body = primary.body as Record<string, unknown>;
          const sets = item.targetSets!;
          const expectedReps =
            item.targetRepetitionsPerSet === null
              ? null
              : sets * item.targetRepetitionsPerSet;
          const expectedSecs =
            item.targetDurationSeconds === null
              ? null
              : sets * item.targetDurationSeconds;
          if (
            body['drillSlug'] !== item.drill!.slug ||
            body['trainingPlanItemId'] !== item.id
          ) {
            fail('I8', `${op.label} evidence targets ${stable(body)}`);
          }
          if (
            body['actualRepetitions'] !== expectedReps ||
            body['actualDurationSeconds'] !== expectedSecs
          ) {
            fail(
              'I8',
              `${op.label} evidence totals ${stable(body)} expected reps=${expectedReps} secs=${expectedSecs}`,
            );
          }
          if (typeof body['id'] !== 'string' || !UUID_RE.test(body['id'])) {
            fail('I8', `${op.label} evidence id ${String(body['id'])}`);
          }
          if (
            typeof body['completedAt'] !== 'string' ||
            Number.isNaN(Date.parse(body['completedAt']))
          ) {
            fail(
              'I8',
              `${op.label} evidence completedAt ${String(body['completedAt'])}`,
            );
          }
          const completion = (
            (primary.delivery as Extract<Delivery, { kind: 'json' }>)
              .payload as {
              completion: DrillCompletion;
            }
          ).completion;
          const stored = s.currentPlan?.items.find(c => c.id === item.id);
          if (stored && !same(stored.completion, completion)) {
            fail(
              'I8',
              `${op.label} stored completion ${stable(stored.completion)} ≠ server ${stable(completion)}`,
            );
          }
          if (alone) {
            for (const other of s.currentPlan?.items ?? []) {
              if (other.id === item.id) continue;
              const before = op.stateBefore.currentPlan?.items.find(
                c => c.id === other.id,
              );
              if (before && !same(before.completion, other.completion)) {
                fail('I8', `${op.label} touched item ${other.id}`);
              }
            }
          }
          const expectedLedger = completion.qualifiesForStreak ? 1 : 0;
          if (ledgerCalls !== expectedLedger) {
            fail(
              'I11',
              `${op.label} ledger calls=${ledgerCalls} expected=${expectedLedger}`,
            );
          } else if (expectedLedger === 1) {
            const entry = mockLedger.calls[
              mockLedger.calls.length - 1
            ] as Record<string, unknown>;
            if (
              entry['id'] !== completion.id ||
              entry['slug'] !== item.drill!.slug ||
              entry['title'] !== item.drill!.title ||
              entry['completedAtIso'] !== completion.completedAt
            ) {
              fail('I11', `${op.label} ledger entry ${stable(entry)}`);
            }
          }
        } else {
          checkErrorState(op, s.mutationError, expectedError!, 'mutationError');
          if (ledgerCalls !== 0)
            fail('I11', `${op.label} failed but ledger called`);
          if (alone && !same(s.currentPlan, op.stateBefore.currentPlan)) {
            fail('I8', `${op.label} failed but plan changed`);
          }
        }
        break;
      }
      default:
        break;
    }
  };

  const checkAllRequests = () => {
    for (const request of released) {
      const where = `${request.method} ${request.path}`;
      if (request.headers['Authorization'] !== `Bearer ${TOKEN}`) {
        fail('I7', `${where} bearer=${request.headers['Authorization']}`);
      }
      if (
        request.headers['Accept'] !== 'application/json' ||
        request.headers['Content-Type'] !== 'application/json'
      ) {
        fail('I7', `${where} headers ${stable(request.headers)}`);
      }
      if (typeof request.headers['X-Client-Version'] !== 'string') {
        fail('I7', `${where} missing X-Client-Version`);
      }
      if (
        !KNOWN_ROUTES.some(
          ([m, re]) => m === request.method && re.test(request.path),
        )
      ) {
        fail('I7', `unknown route ${where}`);
      }
      if (request.method === 'POST' && request.body === undefined) {
        fail('I7', `${where} POST without body`);
      }
      if (request.method !== 'POST' && request.body !== undefined) {
        fail('I7', `${where} carries a body`);
      }
      // encodeURIComponent leaves RFC 3986 unreserved + `!'()*` untouched.
      if (/[^A-Za-z0-9\-_.~%/!'()*]/.test(request.path)) {
        fail('I7', `${where} not URL-encoded`);
      }
    }
  };

  const checkSettledModel = (overlapped: boolean) => {
    if (!server || !apiUsable) return;
    const s = snapshot();
    if (s.savedStatus === 'ready' && !same(s.savedDrills, server.savedView())) {
      divergences.push({
        step: stepIndex,
        field: 'savedDrills',
        overlapped,
        detail: `store=${stable(s.savedDrills.map(d => d.slug))} server=${stable(server.savedSlugsOrdered())}`,
      });
    }
    if (s.planStatus === 'ready' && !same(s.currentPlan, server.planView())) {
      divergences.push({
        step: stepIndex,
        field: 'currentPlan',
        overlapped,
        detail: `store=${stable(s.currentPlan)} server=${stable(server.planView())}`,
      });
    }
    for (const [slug, detail] of Object.entries(s.drillDetails)) {
      const truth = server.detailView(slug);
      if (!truth || !same(detail, truth)) {
        divergences.push({
          step: stepIndex,
          field: 'drillDetails',
          overlapped,
          detail: `${slug}: store=${stable(detail)} server=${stable(truth)}`,
        });
      }
    }
  };

  const synthetic = (id: string): TrainingPlanItem => ({
    id,
    position: 1,
    kind: 'targeted',
    drill: {
      slug: CATALOG_SLUGS[1]!,
      title: CATALOG[1]!.title,
      description: CATALOG[1]!.description,
      coachName: CATALOG[1]!.coachName,
      equipment: CATALOG[1]!.equipment,
      saved: false,
    },
    cueText: 'Synthetic',
    targetSets: 3,
    targetRepetitionsPerSet: 8,
    targetDurationSeconds: null,
    restSeconds: 20,
    completion: null,
  });

  const pickItem = (
    step: Extract<OpStep, { op: 'complete' }>,
  ): TrainingPlanItem => {
    const items = useTrainingStore.getState().currentPlan?.items ?? [];
    const eligible = items.filter(
      item => item.drill && !item.completion && item.targetSets,
    );
    const base: TrainingPlanItem =
      eligible.length > 0
        ? eligible[step.pick % eligible.length]!
        : items.length > 0
          ? items[step.pick % items.length]!
          : synthetic(step.syntheticId);
    switch (step.variant) {
      case 'store-item':
        return base;
      case 'stale-completed':
        return {
          ...base,
          completion: {
            id: step.syntheticId,
            completedAt: iso(0),
            actualRepetitions: 1,
            actualDurationSeconds: null,
            qualifiesForStreak: true,
          },
        };
      case 'no-drill':
        return { ...base, drill: null };
      case 'zero-sets':
        return { ...base, targetSets: 0 };
      case 'unknown-id':
        return { ...base, id: step.syntheticId };
    }
  };

  const fire = (step: OpStep) => {
    const state = useTrainingStore.getState();
    const before = snapshot();
    const args =
      'slug' in step
        ? `(${step.slug},${String(step.saved)})`
        : 'shotId' in step
          ? `(${step.shotId})`
          : 'variant' in step
            ? `[${step.variant}]`
            : '';
    const record: OpRecord = {
      id: ops.length,
      step,
      label: `#${stepIndex} ${step.op}${args}`,
      configVersion,
      outcomes: [...step.outcomes],
      requests: [],
      classification: 'issued',
      preconditionCode: null,
      itemUsed: null,
      settled: false,
      result: null,
      rejection: undefined,
      settledAtVersion: null,
      ledgerBefore: mockLedger.calls.length,
      onUnauthorizedBefore: onUnauthorizedCount,
      settledCountBefore: settledCount,
      stateBefore: before,
      checked: false,
    };
    ops.push(record);
    if (step.op === 'complete') record.itemUsed = pickItem(step);
    const isMutation = step.op !== 'loadSaved' && step.op !== 'loadPlan';
    // Mirror the store's own guard order so the oracle is exact.
    if (isMutation && state.mutation !== 'idle') {
      record.classification = 'busy';
    } else if (!apiConfigured) {
      record.classification = 'noapi';
    } else if (
      step.op === 'reassess' &&
      (!state.currentPlan || state.currentPlan.status !== 'active')
    ) {
      record.classification = 'precondition';
      record.preconditionCode = 'training.request_failed';
    } else if (step.op === 'complete') {
      const item = record.itemUsed!;
      if (
        !item.drill ||
        item.completion ||
        !item.targetSets ||
        (item.targetRepetitionsPerSet === null &&
          item.targetDurationSeconds === null)
      ) {
        record.classification = 'precondition';
        record.preconditionCode = 'training.invalid_completion';
      }
    }
    if (record.classification === 'issued' && !apiUsable) {
      record.classification = 'noapi';
    }
    if (inFlight().length > 1) overlapSeen = true;
    currentOpId = record.id;
    const onSettled = (result: boolean | null, rejection: unknown) => {
      record.settled = true;
      record.result = result;
      record.rejection = rejection;
      record.settledAtVersion = configVersion;
      settledCount += 1;
    };
    let promise: Promise<boolean>;
    try {
      switch (step.op) {
        case 'loadSaved':
          promise = state.loadSavedDrills();
          break;
        case 'loadPlan':
          promise = state.loadCurrentPlan();
          break;
        case 'createPlan':
          promise = state.createPlan(step.shotId);
          break;
        case 'reassess':
          promise = state.reassessCurrentPlan(step.shotId);
          break;
        case 'setSaved':
          promise = state.setDrillSaved(step.slug, step.saved);
          break;
        case 'complete':
          promise = state.completePlanItem(record.itemUsed!);
          break;
      }
    } catch (error) {
      onSettled(null, error ?? new Error('thrown undefined'));
      currentOpId = -1;
      return;
    }
    currentOpId = -1;
    promise.then(
      value => onSettled(value, undefined),
      error => onSettled(null, error ?? new Error('rejected undefined')),
    );
  };

  const collectAttribution = () => {
    for (const request of queue) {
      const owner = ops[request.opId];
      if (owner && !owner.requests.includes(request))
        owner.requests.push(request);
    }
  };

  const checkNewlySettled = () => {
    for (const op of ops) {
      if (op.settled && !op.checked) checkSettledOp(op);
    }
  };

  const afterAction = () => {
    currentOpId = -1;
    collectAttribution();
    checkNewlySettled();
    checkStepInvariants();
  };

  const release = async (pick: number) => {
    if (queue.length === 0) return;
    const index = pick % queue.length;
    const request = queue.splice(index, 1)[0]!;
    released.push(request);
    const stale = request.configVersion !== configVersion;
    const before = stale ? snapshot() : null;
    currentOpId = request.opId;
    deliver(request, configVersion);
    await settle();
    if (before && !same(before, snapshot())) {
      fail(
        'I10',
        `stale response ${request.method} ${request.path} (v${request.configVersion} → v${configVersion}) changed state`,
      );
    }
    afterAction();
  };

  const drain = async (order: 'fifo' | 'shuffled', seed: number) => {
    const rng = new Rng(seed);
    let guard = 0;
    while (queue.length > 0 || inFlight().length > 0) {
      guard += 1;
      if (guard > 2000) {
        fail(
          'I1',
          `drain did not converge: pending=${queue.length} inflight=${inFlight()
            .map(op => op.label)
            .join(',')}`,
        );
        break;
      }
      if (queue.length === 0) {
        await settle();
        afterAction();
        if (inFlight().length > 0 && queue.length === 0) {
          fail(
            'I1',
            `ops hung with no pending request: ${inFlight()
              .map(op => op.label)
              .join(',')}`,
          );
          break;
        }
        continue;
      }
      await release(order === 'fifo' ? 0 : rng.int(queue.length));
    }
  };

  const traceStep = (
    step: Step | { t: 'final-drain' } | { t: 'reset-skipped' },
  ) => {
    trace.push(
      stable({
        step: stepIndex,
        action: step,
        pending: queue.map(r => `${r.seq}:${r.method} ${r.path}`),
        released: released.map(r => `${r.seq}:${describeDelivery(r.delivery)}`),
        state: snapshot(),
        results: ops.map(op =>
          op.settled ? `${op.id}:${String(op.result)}` : `${op.id}:…`,
        ),
        ledger: mockLedger.calls,
        unauthorized: onUnauthorizedCount,
        server: server
          ? { saved: server.savedSlugsOrdered(), plan: server.planView() }
          : null,
      }),
    );
  };

  clearTrainingStoreConfiguration();
  configVersion += 1;

  for (const step of script.steps) {
    stepIndex += 1;
    let traced: Parameters<typeof traceStep>[0] = step;
    switch (step.t) {
      case 'op': {
        fire(step);
        await settle();
        afterAction();
        if (script.mode === 'sequential') {
          await drain('fifo', 0);
          checkSettledModel(false);
        }
        break;
      }
      case 'release':
        await release(step.pick);
        break;
      case 'drain':
        await drain(step.order, step.seed);
        checkSettledModel(overlapSeen);
        break;
      case 'reconfigure': {
        install(step.profile, step.serverSeed);
        await settle();
        if (!same(snapshot(), defaultsSnapshot())) {
          fail('I10', `reconfigure left state ${stable(snapshot())}`);
        }
        afterAction();
        break;
      }
      case 'clearConfig': {
        configVersion += 1;
        clearTrainingStoreConfiguration();
        apiConfigured = false;
        apiUsable = false;
        await settle();
        if (!same(snapshot(), defaultsSnapshot())) {
          fail('I10', `clearConfig left state ${stable(snapshot())}`);
        }
        afterAction();
        break;
      }
      case 'reset': {
        // `reset()` is only reachable through configure/clear in the app
        // (both bump the owner version first); a bare reset under an
        // in-flight op is not an app path, so it is only exercised idle.
        if (inFlight().length > 0) {
          traced = { t: 'reset-skipped' };
          break;
        }
        useTrainingStore.getState().reset();
        await settle();
        if (!same(snapshot(), defaultsSnapshot())) {
          fail('I10', `reset left state ${stable(snapshot())}`);
        }
        afterAction();
        break;
      }
      case 'clearError': {
        const before = snapshot();
        useTrainingStore.getState().clearMutationError();
        await settle();
        const after = snapshot();
        if (
          after.mutationError !== null ||
          !same({ ...before, mutationError: null }, after)
        ) {
          fail('I3', 'clearMutationError changed more than mutationError');
        }
        afterAction();
        break;
      }
    }
    traceStep(traced);
  }
  // Every script ends drained so no promise leaks into the next seed.
  stepIndex += 1;
  await drain('fifo', script.seed);
  checkSettledModel(overlapSeen);
  checkAllRequests();
  for (const op of ops) {
    if (!op.settled) fail('I1', `${op.label} never settled`);
  }
  traceStep({ t: 'final-drain' });
  clearTrainingStoreConfiguration();
  await settle();

  return {
    seed: script.seed,
    mode: script.mode,
    steps: script.steps.length,
    requests: released.length,
    ops: ops.length,
    violations,
    divergences,
    trace: trace.join('\n'),
  };
}

// ─── ddmin over script steps ────────────────────────────────────────────────
async function minimise(
  script: Script,
  failing: (result: RunResult) => boolean,
): Promise<Script> {
  let steps = script.steps;
  let n = 2;
  const stillFails = async (candidate: Step[]) =>
    failing(await runScript({ ...script, steps: candidate }));
  while (steps.length >= 2) {
    const chunk = Math.ceil(steps.length / n);
    let reduced = false;
    for (let i = 0; i < steps.length; i += chunk) {
      const complement = [...steps.slice(0, i), ...steps.slice(i + chunk)];
      if (complement.length > 0 && (await stillFails(complement))) {
        steps = complement;
        n = Math.max(n - 1, 2);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (n >= steps.length) break;
      n = Math.min(steps.length, n * 2);
    }
  }
  return { ...script, steps };
}

// ─── campaign ───────────────────────────────────────────────────────────────
const ITER = Number(process.env['STRESS_ITER'] ?? '120');
const OUT = process.env['STRESS_OUT'];
const ONLY_SEED = process.env['STRESS_SEED']
  ? Number(process.env['STRESS_SEED'])
  : null;
const ONLY_MODE = (process.env['STRESS_MODE'] as Mode | undefined) ?? null;

interface CampaignRow {
  seed: number;
  mode: Mode;
  steps: number;
  requests: number;
  ops: number;
  outcome: 'HELD' | 'BROKEN' | 'DIVERGED';
  /** sha256 of the full trace; the replay must reproduce it exactly. */
  traceHash: string;
  replayIdentical: boolean;
  violations: string[];
  divergences: string[];
  minimisedSteps?: number;
  minimisedScript?: Step[];
}

async function campaign(mode: Mode, seeds: number[]) {
  const rows: CampaignRow[] = [];
  let totalRequests = 0;
  let totalOps = 0;
  let totalSteps = 0;
  const determinism: { seed: number; identical: boolean }[] = [];
  for (const seed of seeds) {
    const script = genScript(seed, mode);
    const result = await runScript(script);
    // Determinism: every seed replays byte-identically (state, requests,
    // deliveries, ledger, server truth).
    const again = await runScript(script);
    const identical = again.trace === result.trace;
    determinism.push({ seed, identical });
    totalRequests += result.requests;
    totalOps += result.ops;
    totalSteps += result.steps;
    const row: CampaignRow = {
      seed,
      mode,
      steps: result.steps,
      requests: result.requests,
      ops: result.ops,
      traceHash: createHash('sha256').update(result.trace).digest('hex'),
      replayIdentical: identical,
      outcome:
        result.violations.length > 0
          ? 'BROKEN'
          : result.divergences.length > 0
            ? 'DIVERGED'
            : 'HELD',
      violations: result.violations.map(
        v => `${v.invariant}@${v.step}: ${v.detail}`,
      ),
      divergences: result.divergences.map(
        d =>
          `${d.field}@${d.step} overlapped=${d.overlapped}: ${d.detail.slice(0, 600)}`,
      ),
    };
    if (row.outcome !== 'HELD') {
      const minimal = await minimise(script, r =>
        row.outcome === 'BROKEN'
          ? r.violations.length > 0
          : r.divergences.length > 0,
      );
      row.minimisedSteps = minimal.steps.length;
      row.minimisedScript = minimal.steps;
      if (OUT) {
        mkdirSync(OUT, { recursive: true });
        const replay = await runScript(minimal);
        writeFileSync(
          join(OUT, `trace-${mode}-${seed}.jsonl`),
          `${replay.trace}\n`,
        );
      }
    }
    rows.push(row);
  }
  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(
      join(OUT, `training-seeded-${mode}.json`),
      JSON.stringify(
        {
          unit: 'mod-training',
          lens: 'randomized-seeded',
          mode,
          sequences: rows.length,
          totalSteps,
          totalOps,
          totalRequests,
          held: rows.filter(r => r.outcome === 'HELD').length,
          broken: rows.filter(r => r.outcome === 'BROKEN').length,
          diverged: rows.filter(r => r.outcome === 'DIVERGED').length,
          determinism,
          rows,
        },
        null,
        2,
      ),
    );
  }
  return { rows, totalOps, totalRequests, totalSteps, determinism };
}

const seedsFor = (mode: Mode): number[] => {
  if (ONLY_SEED !== null) {
    return ONLY_MODE === null || ONLY_MODE === mode ? [ONLY_SEED] : [];
  }
  const base = mode === 'sequential' ? 1 : 100_000;
  return Array.from({ length: ITER }, (_, i) => base + i);
};

jest.setTimeout(30 * 60 * 1000);

afterAll(() => {
  clearTrainingStoreConfiguration();
});

describe('training store + api — seeded randomized long-run', () => {
  test('sequential scripts: every invariant incl. server-model agreement holds', async () => {
    const seeds = seedsFor('sequential');
    if (seeds.length === 0) return;
    const { rows, determinism } = await campaign('sequential', seeds);
    const broken = rows.filter(r => r.outcome !== 'HELD');
    expect(
      broken.map(r => ({
        seed: r.seed,
        violations: r.violations.slice(0, 5),
        divergences: r.divergences.slice(0, 3),
        minimisedSteps: r.minimisedSteps,
      })),
    ).toEqual([]);
    expect(determinism.filter(d => !d.identical)).toEqual([]);
    expect(rows.length).toBe(seeds.length);
  });

  test('interleaved scripts: safety invariants I1–I11 hold under any delivery order', async () => {
    const seeds = seedsFor('concurrent');
    if (seeds.length === 0) return;
    const { rows, determinism } = await campaign('concurrent', seeds);
    const broken = rows.filter(r => r.outcome === 'BROKEN');
    expect(
      broken.map(r => ({
        seed: r.seed,
        violations: r.violations.slice(0, 5),
        minimisedSteps: r.minimisedSteps,
      })),
    ).toEqual([]);
    expect(determinism.filter(d => !d.identical)).toEqual([]);
    expect(rows.length).toBe(seeds.length);
  });

  /**
   * KNOWN GAP (stress finding, concurrent seed 100050, delta-minimised to the
   * 7 steps below): `loadSavedDrills` / `loadCurrentPlan` carry no
   * per-request sequence guard, only the account-configuration guard. A list
   * read that the server answered BEFORE a later save, but whose response
   * arrives AFTER that save's own reload, overwrites the fresher list with
   * the stale snapshot — the store reports `ready` with `savedDrills` missing
   * the drill the user just saved (server has it) until the next load.
   * Sequence: save A → PUT ok, reload GET#2 in flight → two more list reads
   * (GET#3, GET#4, all answered with [A]) → save B → PUT ok, reload GET#6
   * answered with [B, A] → responses delivered 5,2,3,6,…,4 → final store
   * `[A]`, server `[B, A]`. Asserts the EXPECTED behaviour (newest read wins)
   * and is inverted with `test.failing`; flip it to `test` once the store
   * gains a newest-read-wins guard.
   */
  test.failing(
    'interleaved: a later save is not overwritten by an older in-flight list read (seed 100050, minimised)',
    async () => {
      const pinned: Script = {
        seed: 100_050,
        mode: 'concurrent',
        uuidSeed: 0,
        steps: [
          { t: 'reconfigure', profile: 'full', serverSeed: 993921165 },
          {
            t: 'op',
            op: 'setSaved',
            slug: 'contact-shadow',
            saved: true,
            outcomes: [{ kind: 'ok' }, { kind: 'ok' }],
          },
          { t: 'release', pick: 383 },
          {
            t: 'op',
            op: 'loadSaved',
            outcomes: [{ kind: 'ok' }, { kind: 'ok' }],
          },
          {
            t: 'op',
            op: 'loadSaved',
            outcomes: [{ kind: 'ok' }, { kind: 'ok' }],
          },
          {
            t: 'op',
            op: 'setSaved',
            slug: 'reset_block_wall',
            saved: true,
            outcomes: [{ kind: 'ok' }, { kind: 'ok' }],
          },
          { t: 'drain', order: 'shuffled', seed: 3347346264 },
        ],
      };
      const result = await runScript(pinned);
      expect(result.violations).toEqual([]);
      expect(result.divergences).toEqual([]);
    },
  );

  /**
   * KNOWN GAP, same root cause, IN-ORDER delivery (pinned verbatim from the
   * delta-minimised campaign script; the generator has since been retuned so
   * the seed alone no longer reproduces it): `loadCurrentPlan` snapshots the
   * plan (store.ts `await
   * api.getCurrentPlan()`), then fetches drill details, then commits the
   * snapshot. A `completePlanItem` that succeeds while the details are still
   * loading patches `completion` into `currentPlan` — and the commit then
   * replaces it with the pre-completion snapshot. The store reports `ready`
   * with the just-completed item back at `completion: null` (server has the
   * completion), so the UI offers the drill again and a second tap would
   * post a duplicate completion. No network reordering is needed: responses
   * arrive strictly FIFO here.
   */
  test.failing(
    'interleaved, FIFO: a completion recorded during a plan refresh survives the refresh (pinned minimised script)',
    async () => {
      const pinned: Script = {
        seed: 0,
        mode: 'concurrent',
        uuidSeed: 0,
        steps: [
          { t: 'reconfigure', profile: 'full', serverSeed: 2244679355 },
          {
            t: 'op',
            op: 'createPlan',
            shotId: '3d6cd9c9-3dcf-4d0c-9ee1-aa826b3fd19b',
            outcomes: [{ kind: 'ok' }],
          },
          { t: 'drain', order: 'fifo', seed: 1690281486 },
          { t: 'op', op: 'loadPlan', outcomes: [{ kind: 'ok' }] },
          {
            t: 'op',
            op: 'complete',
            pick: 105,
            variant: 'store-item',
            syntheticId: '0c750d4b-95ca-4fc2-8d32-ad2f0d064ace',
            outcomes: [{ kind: 'ok' }],
          },
          { t: 'drain', order: 'fifo', seed: 0 },
        ],
      };
      const result = await runScript(pinned);
      expect(result.violations).toEqual([]);
      expect(result.divergences).toEqual([]);
    },
  );
});
