import type { LocalDb } from '../../src/data/db';
import { makePrng, pick } from '../lifecycle-persistence/seeds';

/**
 * Everything one LibraryScreen mount/unmount iteration needs, derived purely
 * from a 32-bit seed: the local rows the screen reads through the REAL
 * repository, the training server the REAL training store/api talk to over
 * a fake `fetch`, the account shape, and the interaction script.
 */

export const STRESS_OWNER = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const DRILL_ID_BASE = '2f1c0b3a-6d4e-4f8a-9b1c-0000000000';
const PLAN_ID = 'a5d1f0e2-3b4c-4d5e-8f90-1234567890ab';
const SHOT_ID_BASE = 'c3d2e1f0-9a8b-4c7d-8e6f-00000000';

const SHOT_TYPES = [
  'serve',
  'return',
  'forehand_drive',
  'backhand_drive',
  'third_shot_drop',
  'dink',
  'volley',
  'overhead',
] as const;

export type ReadsMode = 'ok' | 'fail-then-retry' | 'slow' | 'never-settles';
export type SavedServer =
  | 'unconfigured'
  | 'ok'
  | 'ok-no-details'
  | 'empty'
  | 'offline'
  | 'http-500'
  | 'http-401'
  | 'slow';

export type Interaction =
  | 'tab-saved'
  | 'tab-reads'
  | 'open-first-read'
  | 'browse-drills'
  | 'connect-account'
  | 'retry-reads'
  | 'retry-saved'
  | 'unsave-first'
  | 'dismiss-mutation-error'
  | 'open-media'
  | 'open-plan'
  | 'blur-home-and-back'
  | 'analyze-cta';

export interface LibraryScenario {
  seed: number;
  shots: number;
  pendingCaptures: number;
  captureEvidence: ('valid' | 'legacy' | 'corrupt' | 'metadata_mismatch')[];
  readsMode: ReadsMode;
  localOnly: boolean;
  savedServer: SavedServer;
  savedDrills: number;
  plan: boolean;
  mediaOpens: boolean;
  unsaveFails: boolean;
  unmountMidFlight: boolean;
  interactions: Interaction[];
}

export function scenarioFromSeed(seed: number): LibraryScenario {
  const rng = makePrng(seed);
  const shots = pick(rng, [0, 0, 1, 3, 12, 40, 100]);
  const pendingCaptures = pick(rng, [0, 0, 1, 2, 5, 10]);
  const captureEvidence: LibraryScenario['captureEvidence'] = [];
  for (let i = 0; i < pendingCaptures; i += 1) {
    captureEvidence.push(
      pick(rng, ['valid', 'valid', 'legacy', 'corrupt', 'metadata_mismatch']),
    );
  }
  const readsMode = pick<ReadsMode>(rng, [
    'ok',
    'ok',
    'ok',
    'fail-then-retry',
    'slow',
    'never-settles',
  ]);
  const localOnly = rng() < 0.3;
  const savedServer = localOnly
    ? 'unconfigured'
    : pick<SavedServer>(rng, [
        'ok',
        'ok',
        'ok-no-details',
        'empty',
        'offline',
        'http-500',
        'http-401',
        'slow',
        'unconfigured',
      ]);
  const savedDrills =
    savedServer === 'ok' ||
    savedServer === 'ok-no-details' ||
    savedServer === 'slow'
      ? pick(rng, [1, 2, 4, 8])
      : 0;
  const plan = savedServer !== 'unconfigured' && rng() < 0.5;
  const mediaOpens = rng() < 0.5;
  const unsaveFails = rng() < 0.5;
  const unmountMidFlight = readsMode !== 'ok' && rng() < 0.4;
  const steps = pick(rng, [0, 1, 2, 3, 4, 6, 8]);
  const interactions: Interaction[] = [];
  const menu: Interaction[] = [
    'tab-saved',
    'tab-reads',
    'open-first-read',
    'browse-drills',
    'connect-account',
    'retry-reads',
    'retry-saved',
    'unsave-first',
    'dismiss-mutation-error',
    'open-media',
    'open-plan',
    'blur-home-and-back',
    'analyze-cta',
  ];
  for (let i = 0; i < steps; i += 1) interactions.push(pick(rng, menu));
  return {
    seed,
    shots,
    pendingCaptures,
    captureEvidence,
    readsMode,
    localOnly,
    savedServer,
    savedDrills,
    plan,
    mediaOpens,
    unsaveFails,
    unmountMidFlight,
    interactions,
  };
}

/** A promise the harness resolves by hand (mid-flight unmount cases). */
export interface Gate {
  open(): void;
  readonly promise: Promise<void>;
  readonly opened: boolean;
}

export function makeGate(): Gate {
  let open: () => void = () => undefined;
  let opened = false;
  const promise = new Promise<void>(resolve => {
    open = () => {
      opened = true;
      resolve();
    };
  });
  return {
    open: () => open(),
    promise,
    get opened() {
      return opened;
    },
  };
}

function shotId(i: number): string {
  return `${SHOT_ID_BASE}${String(i).padStart(4, '0')}`;
}

function importedClip(uri: string, capturedAtIso: string) {
  return {
    captureMode: 'imported_video',
    uri,
    durationMs: 4200,
    width: 720,
    height: 1280,
    fps: 60,
    capturedAtIso,
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
  };
}

/**
 * Minimal LocalDb over the two statements LibraryScreen issues (listShots and
 * listPendingCaptures). Records every statement; the read gate lets a
 * scenario hold the first read open until the harness releases it.
 */
export class StressLocalDb implements LocalDb {
  readonly statements: string[] = [];
  private failuresLeft: number;
  readonly gate: Gate | null;

  constructor(
    private readonly scenario: LibraryScenario,
    options: { failFirstReads: number; gated: boolean },
  ) {
    this.failuresLeft = options.failFirstReads;
    this.gate = options.gated ? makeGate() : null;
  }

  async execute(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: Record<string, unknown>[] }> {
    const statement = sql.trim().replace(/\s+/g, ' ');
    this.statements.push(statement);
    if (this.gate && !this.gate.opened) await this.gate.promise;
    if (this.scenario.readsMode === 'slow') {
      await new Promise<void>(resolve => setTimeout(resolve, 120));
    }
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw new Error('SQLITE_IOERR (simulated) reading library rows');
    }
    const owner = String(params[0]);
    if (owner !== STRESS_OWNER) return { rows: [] };
    if (/FROM local_shot WHERE owner_key = \?/.test(statement)) {
      const limit = Number(params[1]);
      const rows: Record<string, unknown>[] = [];
      for (let i = 0; i < Math.min(limit, this.scenario.shots); i += 1) {
        const lowConfidence = i % 4 === 3;
        rows.push({
          id: shotId(i),
          session_id: i % 3 === 0 ? `session-${Math.floor(i / 3)}` : null,
          shot_type: SHOT_TYPES[i % SHOT_TYPES.length],
          captured_at: new Date(Date.UTC(2026, 7, 30, 12, 0, i)).toISOString(),
          overall_score: lowConfidence ? null : 5 + (i % 5) + 0.4,
          confidence: lowConfidence ? 0.42 : 0.91,
          result_kind: lowConfidence ? 'low_confidence' : 'scored',
          source: 'real',
          favorite: i % 5 === 0 ? 1 : 0,
        });
      }
      return { rows };
    }
    if (/FROM local_capture WHERE owner_key = \?/.test(statement)) {
      const rows: Record<string, unknown>[] = [];
      this.scenario.captureEvidence.forEach((status, i) => {
        const uri = `file:///clips/cap-${i}.mov`;
        const capturedAt = new Date(
          Date.UTC(2026, 7, 28, 10, 0, i),
        ).toISOString();
        let payload: string | null;
        switch (status) {
          case 'legacy':
            payload = null;
            break;
          case 'corrupt':
            payload = '{"captureMode":"imported_video"';
            break;
          case 'metadata_mismatch':
            payload = JSON.stringify(
              importedClip('file:///clips/other.mov', capturedAt),
            );
            break;
          case 'valid':
            payload = JSON.stringify(importedClip(uri, capturedAt));
            break;
        }
        rows.push({
          id: `cap-${i}`,
          uri,
          shot_type: i % 2 === 0 ? 'unrecognized' : 'dink',
          declared_stroke: i % 3 === 0 ? 'third_shot_drop' : null,
          captured_at: capturedAt,
          duration_ms: 4200,
          fps: 60,
          width: 720,
          height: 1280,
          payload,
        });
      });
      return { rows };
    }
    return { rows: [] };
  }

  close(): void {}
}

function drillId(i: number): string {
  return `${DRILL_ID_BASE}${String(i).padStart(2, '0')}`;
}

function savedDrillJson(i: number) {
  return {
    id: drillId(i),
    slug: `stress-drill-${i}`,
    title: `Stress drill ${i}`,
    description: 'Reviewed drill fixture for the long-run leak campaign.',
    coach_name: 'Coach Fixture',
    equipment: ['paddle', 'balls'],
    difficulty_min: 'beginner',
    difficulty_max: 'intermediate',
    saved_at: '2026-08-31T12:00:00.000Z',
  };
}

function drillDetailJson(i: number) {
  return {
    drill: {
      id: drillId(i),
      slug: `stress-drill-${i}`,
      title: `Stress drill ${i}`,
      description: 'Reviewed drill fixture for the long-run leak campaign.',
      coach_name: 'Coach Fixture',
      equipment: ['paddle', 'balls'],
      difficulty_min: 'beginner',
      difficulty_max: 'intermediate',
      saved: true,
    },
    mappings: [
      {
        checkpoint: 'contact_point',
        shot_type: 'dink',
        plan_role: 'targeted',
        fault_directions: ['late'],
        cue_text: 'Meet the ball out front.',
        target_sets: 3,
        target_repetitions_per_set: 10,
        target_duration_seconds: null,
        rest_seconds: 30,
      },
    ],
    instructionalMedia: [
      {
        id: `9b8a7c6d-5e4f-4a3b-8c2d-0000000000${String(i).padStart(2, '0')}`,
        kind: 'embed',
        provider: 'youtube',
        videoId: `stress${i}`,
        embedUrl: `https://www.youtube-nocookie.com/embed/stress${i}`,
        sourceUrl: `https://www.youtube.com/watch?v=stress${i}`,
        creatorName: 'Fixture Creator',
        licenseName: 'CC BY 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
        attribution: 'Fixture Creator, CC BY 4.0',
      },
    ],
  };
}

function planJson() {
  return {
    plan: {
      id: PLAN_ID,
      status: 'active',
      algorithmVersion: 'plan-v1',
      sourceShotId: shotId(0),
      shotType: 'dink',
      priorityCheckpoint: 'contact_point',
      priorityDirection: 'late',
      baselineScore: 6.1,
      baselineCheckpointScore: 54,
      reassessmentShotId: null,
      scoreDelta: null,
      createdAt: '2026-08-31T12:00:00.000Z',
      completedAt: null,
      items: [
        {
          id: 'e1d2c3b4-a596-4877-8695-abcdefabcdef',
          position: 1,
          kind: 'targeted',
          drill: {
            slug: 'stress-drill-0',
            title: 'Stress drill 0',
            description: 'Reviewed drill fixture.',
            coachName: 'Coach Fixture',
            equipment: ['paddle'],
            saved: true,
          },
          cueText: 'Meet the ball out front.',
          targetSets: 3,
          targetRepetitionsPerSet: 10,
          targetDurationSeconds: null,
          restSeconds: 30,
          completion: null,
        },
      ],
    },
  };
}

export interface StressServer {
  fetch(input: string, init?: RequestInit): Promise<Response>;
  readonly requests: { method: string; path: string }[];
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

/** Seeded stand-in for the training API reached through `fetch`. */
export function makeStressServer(scenario: LibraryScenario): StressServer {
  const requests: { method: string; path: string }[] = [];
  return {
    requests,
    async fetch(input: string, init?: RequestInit): Promise<Response> {
      const method = (init?.method ?? 'GET').toUpperCase();
      const path = input.replace(/^https?:\/\/[^/]+/, '');
      requests.push({ method, path });
      if (scenario.savedServer === 'offline') {
        throw new TypeError('Network request failed');
      }
      if (scenario.savedServer === 'http-500') {
        return jsonResponse(500, {
          error: { code: 'training.upstream', message: 'Upstream failed.' },
        });
      }
      if (scenario.savedServer === 'http-401') {
        return jsonResponse(401, {});
      }
      if (scenario.savedServer === 'slow') {
        await new Promise<void>(resolve => setTimeout(resolve, 150));
      }
      if (method === 'GET' && path === '/v1/me/saved-drills') {
        const items = [];
        for (let i = 0; i < scenario.savedDrills; i += 1) {
          items.push(savedDrillJson(i));
        }
        return jsonResponse(200, { items });
      }
      const detail = /^\/v1\/catalog\/drills\/stress-drill-(\d+)$/.exec(path);
      if (method === 'GET' && detail) {
        if (scenario.savedServer === 'ok-no-details') {
          return jsonResponse(404, {
            error: { code: 'training.not_found', message: 'No such drill.' },
          });
        }
        return jsonResponse(200, drillDetailJson(Number(detail[1])));
      }
      if (method === 'GET' && path === '/v1/training-plans/current') {
        return jsonResponse(200, scenario.plan ? planJson() : { plan: null });
      }
      if (method === 'DELETE' && path.startsWith('/v1/me/saved-drills/')) {
        if (scenario.unsaveFails) {
          return jsonResponse(503, {
            error: {
              code: 'training.unavailable',
              message: 'Saving is temporarily unavailable.',
            },
          });
        }
        return jsonResponse(204, null);
      }
      if (method === 'PUT' && path.startsWith('/v1/me/saved-drills/')) {
        const slug = decodeURIComponent(path.split('/').pop() ?? '');
        return jsonResponse(200, { slug, saved: true });
      }
      return jsonResponse(404, {
        error: { code: 'training.not_found', message: 'Unknown route.' },
      });
    },
  };
}
