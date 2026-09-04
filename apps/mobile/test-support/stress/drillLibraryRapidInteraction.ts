/**
 * Seeded rapid-interaction harness for DrillLibraryScreen.
 *
 * Everything the campaign needs to replay one iteration from its seed lives
 * here: the PRNG, the scripted training server (stands in for `fetch` only —
 * `createTrainingApi` and its parsers run for real), the op generator and the
 * result-table types. The test file owns rendering and assertions.
 */

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  chance(probability: number): boolean;
}

/** mulberry32 — small, fast, and identical on every platform. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: items => {
      if (items.length === 0) throw new Error('pick from empty list');
      return items[Math.floor(next() * items.length)] as (typeof items)[number];
    },
    chance: probability => next() < probability,
  };
}

/** Derives the per-iteration seed from the campaign seed (splitmix-style). */
export function iterationSeed(campaignSeed: number, iteration: number): number {
  let z = (campaignSeed + iteration * 0x9e3779b9) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return (z ^ (z >>> 16)) >>> 0;
}

// ---------------------------------------------------------------------------
// Catalog fixture (wire shape of GET /v1/catalog/drills)
// ---------------------------------------------------------------------------

export interface WireDrill {
  id: string;
  slug: string;
  title: string;
  description: string;
  coach_name: string;
  equipment: string[];
  difficulty_min: string | null;
  difficulty_max: string | null;
  families: string[];
  validation_state: 'UNVALIDATED';
}

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

export const CATALOG: readonly WireDrill[] = [
  {
    id: uuid(1),
    slug: 'dink-target-ladder',
    title: 'Dink target ladder',
    description: 'Soft dinks to progressively smaller kitchen targets.',
    coach_name: 'Coach A',
    equipment: ['paddle', 'cones'],
    difficulty_min: '2.5',
    difficulty_max: '3.5',
    families: ['dink'],
    validation_state: 'UNVALIDATED',
  },
  {
    id: uuid(2),
    slug: 'volley-wall-reflex',
    title: 'Volley wall reflex',
    description: 'Rapid volleys against a wall to sharpen paddle readiness.',
    coach_name: 'Coach B',
    equipment: ['paddle', 'wall'],
    difficulty_min: '3.0',
    difficulty_max: '4.0',
    families: ['volley'],
    validation_state: 'UNVALIDATED',
  },
  {
    id: uuid(3),
    slug: 'drive-lane-pressure',
    title: 'Drive lane pressure',
    description: 'Topspin drives down the sideline lanes with a partner.',
    coach_name: 'Coach C',
    equipment: ['paddle', 'balls'],
    difficulty_min: null,
    difficulty_max: null,
    families: ['drive'],
    validation_state: 'UNVALIDATED',
  },
  {
    id: uuid(4),
    slug: 'serve-depth-boxes',
    title: 'Serve depth boxes',
    description: 'Deep serves into taped boxes near the baseline.',
    coach_name: 'Coach D',
    equipment: ['paddle', 'tape'],
    difficulty_min: '2.0',
    difficulty_max: '2.0',
    families: ['serve'],
    validation_state: 'UNVALIDATED',
  },
  {
    id: uuid(5),
    slug: 'return-split-step',
    title: 'Return split step',
    description: 'Split step timing on every return of serve.',
    coach_name: 'Coach E',
    equipment: ['paddle'],
    difficulty_min: '2.5',
    difficulty_max: '3.0',
    families: ['return', 'global'],
    validation_state: 'UNVALIDATED',
  },
  {
    id: uuid(6),
    slug: 'reset-block-rally',
    title: 'Reset block rally',
    description: 'Absorb pace and reset the ball softly into the kitchen.',
    coach_name: 'Coach F',
    equipment: ['paddle', 'balls'],
    difficulty_min: '3.5',
    difficulty_max: '4.5',
    families: ['drop_reset'],
    validation_state: 'UNVALIDATED',
  },
  {
    id: uuid(7),
    slug: 'shadow-swing-mirror',
    title: 'Shadow swing mirror',
    description: 'Slow-motion shadow swings in front of a mirror.',
    coach_name: 'Coach G',
    equipment: ['mirror'],
    difficulty_min: null,
    difficulty_max: null,
    families: ['global'],
    validation_state: 'UNVALIDATED',
  },
  {
    id: uuid(8),
    slug: 'dink-crosscourt-clock',
    title: 'Dink crosscourt clock',
    description: 'Crosscourt dinks around the clock face positions.',
    coach_name: 'Coach H',
    equipment: ['paddle', 'cones'],
    difficulty_min: '3.0',
    difficulty_max: '3.5',
    families: ['dink', 'global'],
    validation_state: 'UNVALIDATED',
  },
];

export const SLUGS: readonly string[] = CATALOG.map(drill => drill.slug);

/** Mirrors the screen's client-side `matchesQuery` so the oracle is exact. */
export function matchesQuery(drill: WireDrill, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [drill.title, drill.description, ...drill.equipment]
    .join(' ')
    .toLowerCase()
    .includes(needle);
}

export function expectedVisible(
  query: string,
  family: string | null,
): string[] {
  return CATALOG.filter(
    drill =>
      (family === null || drill.families.includes(family)) &&
      matchesQuery(drill, query),
  ).map(drill => drill.slug);
}

const MEDIA_BY_SLUG: Record<string, unknown[]> = {
  'dink-target-ladder': [
    {
      id: uuid(101),
      kind: 'embed',
      provider: 'youtube',
      videoId: 'dinkladder01',
      embedUrl: 'https://www.youtube-nocookie.com/embed/dinkladder01',
      sourceUrl: 'https://www.youtube.com/watch?v=dinkladder01',
      creatorName: 'Creator One',
      licenseName: 'YouTube Standard License',
      licenseUrl: null,
      attribution: 'Video by Creator One',
    },
  ],
  'volley-wall-reflex': [
    {
      id: uuid(102),
      kind: 'hosted',
      playbackUrl: 'https://media.example.com/volley.mp4',
      expiresAt: '2099-01-01T00:00:00.000Z',
      sourceUrl: 'https://media.example.com/volley',
      creatorName: 'Creator Two',
      licenseName: 'CC BY 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
      attribution: 'Video by Creator Two (CC BY 4.0)',
    },
    {
      id: uuid(103),
      kind: 'embed',
      provider: 'vimeo',
      videoId: '77',
      embedUrl: 'https://player.vimeo.com/video/77',
      sourceUrl: 'https://vimeo.com/77',
      creatorName: 'Creator Three',
      licenseName: 'CC BY 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
      attribution: 'Video by Creator Three (CC BY 4.0)',
    },
  ],
  'dink-crosscourt-clock': [
    {
      id: uuid(104),
      kind: 'embed',
      provider: 'youtube',
      videoId: 'clockdink02',
      embedUrl: 'https://www.youtube-nocookie.com/embed/clockdink02',
      sourceUrl: 'https://www.youtube.com/watch?v=clockdink02',
      creatorName: 'Creator Four',
      licenseName: 'YouTube Standard License',
      licenseUrl: null,
      attribution: 'Video by Creator Four',
    },
  ],
};

/** Slugs whose detail exposes at least one playable media row. */
export const MEDIA_SLUGS: readonly string[] = Object.keys(MEDIA_BY_SLUG);

function detailPayload(drill: WireDrill, saved: boolean): unknown {
  return {
    drill: { ...drill, saved },
    mappings: [
      {
        checkpoint: 'paddle_ready',
        shot_type: drill.families[0] === 'dink' ? 'dink' : 'volley',
        plan_role: 'targeted',
        fault_directions: ['low'],
        cue_text: `Cue for ${drill.title}`,
        target_sets: 3,
        target_repetitions_per_set: 10,
        target_duration_seconds: null,
        rest_seconds: 30,
      },
    ],
    instructionalMedia: MEDIA_BY_SLUG[drill.slug] ?? [],
  };
}

// ---------------------------------------------------------------------------
// Scripted training server (replaces fetch only)
// ---------------------------------------------------------------------------

export type RequestKind = 'catalog' | 'detail' | 'save' | 'unsave' | 'other';
export type Outcome = 'ok' | 'server_error' | 'network' | 'invalid' | 'expired';
export type LatencyProfile = 'instant' | 'short' | 'mixed' | 'held';

export interface ServerOptions {
  rng: Rng;
  /** Base URL the api client was configured with; stripped from paths. */
  baseUrl: string;
  /** Probability that a request fails (spread across the failure outcomes). */
  failureRate: number;
  latency: LatencyProfile;
  /** When the catalog read observes saved flags: as the request arrives
   * (a fast DB read behind a slow response) or when the response is sent. */
  snapshotAt: 'arrival' | 'response';
}

export interface RequestRecord {
  seq: number;
  kind: RequestKind;
  method: string;
  path: string;
  slug: string | null;
  q: string;
  family: string | null;
  bearer: string | null;
  outcome: Outcome;
  latencyMs: number | 'held';
  /** Virtual time (ms of fake-timer advance) at arrival. */
  arrivedAt: number;
  completedAt: number | null;
  /** True when a save/unsave arrived while another mutation for the same
   * slug was still open — the single-flight guard failed. */
  overlappedSave: boolean;
  /** True when the mutation verb did not change server state (PUT while
   * already saved, DELETE while not saved). */
  redundantMutation: boolean;
  /** True when the bearer was not the newest token at arrival time. */
  staleBearer: boolean;
}

interface PendingRequest {
  record: RequestRecord;
  complete: () => void;
}

interface FetchResponseLike {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}

export class FakeTrainingServer {
  readonly log: RequestRecord[] = [];
  readonly saved = new Set<string>();
  /** Bearer tokens the server considers current, newest last. */
  readonly tokenHistory: string[] = [];
  private pending: PendingRequest[] = [];
  private seq = 0;
  private now = 0;
  private readonly openSavesBySlug = new Map<string, number>();
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;

  constructor(private readonly options: ServerOptions) {
    this.fetch = (input, init) =>
      this.handle(input, init) as unknown as Promise<Response>;
  }

  /** Advance the server's notion of virtual time (mirrors fake timers). */
  tick(ms: number): void {
    this.now += ms;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** Requests currently open for one slug (saves), used by the oracle. */
  openSaves(slug: string): number {
    return this.openSavesBySlug.get(slug) ?? 0;
  }

  /** Completes one held/pending request chosen by the RNG. */
  releaseOne(): boolean {
    if (this.pending.length === 0) return false;
    const index = this.options.rng.int(0, this.pending.length - 1);
    const [request] = this.pending.splice(index, 1);
    request?.complete();
    return true;
  }

  releaseAll(): void {
    while (this.releaseOne()) {
      // drain in RNG order so out-of-order completion is exercised
    }
  }

  private decideOutcome(): Outcome {
    const { rng, failureRate } = this.options;
    if (!rng.chance(failureRate)) return 'ok';
    return rng.pick<Outcome>([
      'server_error',
      'server_error',
      'network',
      'invalid',
      'expired',
    ]);
  }

  private decideLatency(): number | 'held' {
    const { rng, latency } = this.options;
    switch (latency) {
      case 'instant':
        return 0;
      case 'short':
        return rng.int(0, 120);
      case 'mixed':
        return rng.chance(0.3) ? 0 : rng.int(1, 900);
      case 'held':
        return rng.chance(0.5) ? 'held' : rng.int(0, 300);
    }
  }

  private classify(
    method: string,
    path: string,
  ): {
    kind: RequestKind;
    slug: string | null;
    q: string;
    family: string | null;
  } {
    const [rawPath, rawQuery = ''] = path.split('?');
    const params = new Map<string, string>();
    for (const part of rawQuery.split('&')) {
      if (!part) continue;
      const [key, value = ''] = part.split('=');
      params.set(
        decodeURIComponent(key ?? ''),
        decodeURIComponent(value.replace(/\+/g, ' ')),
      );
    }
    const detail = /^\/v1\/catalog\/drills\/([^/]+)$/.exec(rawPath ?? '');
    const savedDrill = /^\/v1\/me\/saved-drills\/([^/]+)$/.exec(rawPath ?? '');
    if (method === 'GET' && rawPath === '/v1/catalog/drills') {
      return {
        kind: 'catalog',
        slug: null,
        q: params.get('q') ?? '',
        family: params.get('family') ?? null,
      };
    }
    if (method === 'GET' && detail) {
      return {
        kind: 'detail',
        slug: decodeURIComponent(detail[1] ?? ''),
        q: '',
        family: null,
      };
    }
    if (savedDrill && (method === 'PUT' || method === 'DELETE')) {
      return {
        kind: method === 'PUT' ? 'save' : 'unsave',
        slug: decodeURIComponent(savedDrill[1] ?? ''),
        q: '',
        family: null,
      };
    }
    return { kind: 'other', slug: null, q: '', family: null };
  }

  private catalogItems(q: string, family: string | null): unknown[] {
    return CATALOG.filter(
      drill =>
        (family === null || drill.families.includes(family)) &&
        matchesQuery(drill, q),
    ).map(drill => ({ ...drill, saved: this.saved.has(drill.slug) }));
  }

  private handle(input: string, init?: RequestInit): Promise<unknown> {
    const method = (init?.method ?? 'GET').toUpperCase();
    const url = new URL(input);
    const base = new URL(this.options.baseUrl);
    const path = `${url.pathname.startsWith(base.pathname) ? url.pathname.slice(base.pathname.length) : url.pathname}${url.search}`;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const authorization = headers['Authorization'] ?? headers['authorization'];
    const bearer = authorization?.replace(/^Bearer\s+/, '') ?? null;
    const meta = this.classify(method, path);
    const outcome = this.decideOutcome();
    const latencyMs = this.decideLatency();
    const record: RequestRecord = {
      seq: ++this.seq,
      kind: meta.kind,
      method,
      path,
      slug: meta.slug,
      q: meta.q,
      family: meta.family,
      bearer,
      outcome,
      latencyMs,
      arrivedAt: this.now,
      completedAt: null,
      overlappedSave: false,
      redundantMutation: false,
      staleBearer:
        this.tokenHistory.length > 0 &&
        bearer !== this.tokenHistory[this.tokenHistory.length - 1],
    };
    this.log.push(record);

    // Mutations are applied on arrival and only when the server will answer
    // successfully; a failed request leaves server state untouched.
    let payload: unknown = null;
    let status = 200;
    if (meta.kind === 'save' || meta.kind === 'unsave') {
      const slug = meta.slug ?? '';
      const open = this.openSavesBySlug.get(slug) ?? 0;
      record.overlappedSave = open > 0;
      this.openSavesBySlug.set(slug, open + 1);
      if (outcome === 'ok') {
        const wasSaved = this.saved.has(slug);
        if (meta.kind === 'save') {
          record.redundantMutation = wasSaved;
          this.saved.add(slug);
          payload = { slug, saved: true };
        } else {
          record.redundantMutation = !wasSaved;
          this.saved.delete(slug);
          status = 204;
        }
      }
    } else if (meta.kind === 'catalog') {
      if (this.options.snapshotAt === 'arrival') {
        payload = { items: this.catalogItems(meta.q, meta.family) };
      }
    } else if (meta.kind === 'detail') {
      const drill = CATALOG.find(item => item.slug === meta.slug);
      payload = drill ? detailPayload(drill, this.saved.has(drill.slug)) : null;
      if (!drill) status = 404;
    } else {
      status = 404;
    }

    return new Promise<unknown>((resolve, reject) => {
      const complete = () => {
        record.completedAt = this.now;
        if (meta.kind === 'save' || meta.kind === 'unsave') {
          const slug = meta.slug ?? '';
          const open = this.openSavesBySlug.get(slug) ?? 1;
          this.openSavesBySlug.set(slug, Math.max(0, open - 1));
        }
        if (
          meta.kind === 'catalog' &&
          this.options.snapshotAt === 'response' &&
          outcome === 'ok'
        ) {
          payload = { items: this.catalogItems(meta.q, meta.family) };
        }
        switch (outcome) {
          case 'network':
            reject(new TypeError('Network request failed'));
            return;
          case 'server_error':
            resolve(this.response(500, { error: { code: 'server.error' } }));
            return;
          case 'invalid':
            resolve(this.response(200, { items: 'not-a-list', drill: 7 }));
            return;
          case 'expired':
            resolve(this.response(401, { error: { code: 'auth.expired' } }));
            return;
          case 'ok':
            resolve(
              this.response(status, status === 204 ? undefined : payload),
            );
        }
      };
      if (latencyMs === 'held') {
        this.pending.push({ record, complete });
        return;
      }
      if (latencyMs === 0) {
        const entry = { record, complete };
        this.pending.push(entry);
        void Promise.resolve().then(() => this.finish(entry));
        return;
      }
      const entry = { record, complete };
      this.pending.push(entry);
      setTimeout(() => this.finish(entry), latencyMs);
    });
  }

  private finish(entry: PendingRequest): void {
    const index = this.pending.indexOf(entry);
    if (index === -1) return; // already released by releaseOne()
    this.pending.splice(index, 1);
    entry.complete();
  }

  private response(status: number, body: unknown): FetchResponseLike {
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => {
        if (body === undefined) throw new SyntaxError('Unexpected end');
        return body;
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Local SQLite stand-in (native module boundary: @op-engineering/op-sqlite)
// ---------------------------------------------------------------------------

export interface FakeSqliteOptions {
  /** Rows returned for the local_shot evidence read (JSON payload strings). */
  scoredShotPayloads: string[];
  /** When true the evidence read rejects like a corrupt store would. */
  failReads: boolean;
}

export function createFakeSqlite(options: FakeSqliteOptions) {
  return {
    executeSync: () => ({ rows: [] as Record<string, unknown>[] }),
    execute: async (sql: string) => {
      if (options.failReads)
        throw new Error('database disk image is malformed');
      if (/FROM local_shot/i.test(sql)) {
        return {
          rows: options.scoredShotPayloads.map(payload => ({ payload })),
        };
      }
      return { rows: [] as Record<string, unknown>[] };
    },
    close: () => {},
  };
}

/** Two scored dink analyses with a weak `paddle_ready` checkpoint: enough
 * evidence for the library to compute a focus and a recommended section. */
export function focusEvidencePayloads(): string[] {
  const shot = (id: string, capturedAt: string, score: number) =>
    JSON.stringify({
      id,
      shotType: 'dink',
      capturedAtIso: capturedAt,
      source: 'real',
      resultKind: 'scored',
      checkpoints: [
        { key: 'paddle_ready', score, applicable: true },
        { key: 'contact_point', score: 82, applicable: true },
        { key: 'follow_through', score: 78, applicable: true },
      ],
    });
  return [
    shot(uuid(201), '2026-09-01T10:00:00.000Z', 41),
    shot(uuid(202), '2026-09-02T10:00:00.000Z', 44),
  ];
}

// ---------------------------------------------------------------------------
// Scenario generator
// ---------------------------------------------------------------------------

export type Spacing = 'sameTick' | 'microtask' | 'ms';

export type Op =
  | { kind: 'save'; slug: string; taps: number; spacing: Spacing }
  | { kind: 'expand'; slug: string; taps: number; spacing: Spacing }
  | { kind: 'type'; text: string; gapMs: number }
  | { kind: 'clearSearch'; taps: number }
  | { kind: 'family'; family: string | null; taps: number }
  | { kind: 'refresh'; taps: number }
  | { kind: 'openMedia'; taps: number; spacing: Spacing }
  | { kind: 'closeMedia'; taps: number }
  | { kind: 'browse'; taps: number; spacing: Spacing }
  | { kind: 'searchYoutube'; taps: number; spacing: Spacing }
  | { kind: 'retryDetail'; taps: number }
  | { kind: 'dismissError'; taps: number }
  | { kind: 'retryCatalog'; taps: number }
  | { kind: 'rotateToken' }
  | { kind: 'signIn'; taps: number }
  | { kind: 'connectAccount'; taps: number }
  | { kind: 'release'; count: number }
  | { kind: 'advance'; ms: number }
  | { kind: 'back'; taps: number; spacing: Spacing };

export type Profile = 'signedIn' | 'signedOut';

export interface Scenario {
  seed: number;
  profile: Profile;
  /** Presses of the "open library" control on the previous screen. */
  openTaps: number;
  /** Let the first catalog load land before interacting (else the bursts
   * hit the loading state and the catalog arrives mid-sequence). */
  waitForCatalog: boolean;
  failureRate: number;
  latency: LatencyProfile;
  snapshotAt: 'arrival' | 'response';
  localEvidence: 'none' | 'focus' | 'corrupt';
  ops: Op[];
}

const SEARCH_TEXTS = [
  'dink',
  'vol',
  'wall',
  'd',
  'zzz',
  'cones',
  'Dink',
  ' ',
  'reset',
  '(',
];
const FAMILY_VALUES: readonly (string | null)[] = [
  null,
  'dink',
  'volley',
  'drive',
  'serve',
  'return',
  'drop_reset',
  'global',
];

function taps(rng: Rng): number {
  const roll = rng.next();
  return roll < 0.4 ? 1 : roll < 0.75 ? 2 : 3;
}

function spacing(rng: Rng): Spacing {
  return rng.pick<Spacing>(['sameTick', 'sameTick', 'microtask', 'ms']);
}

export function generateScenario(seed: number): Scenario {
  const rng = createRng(seed);
  const profile: Profile = rng.chance(0.08) ? 'signedOut' : 'signedIn';
  const scenario: Scenario = {
    seed,
    profile,
    openTaps: taps(rng),
    waitForCatalog: rng.chance(0.75),
    failureRate: rng.pick([0, 0, 0.1, 0.25]),
    latency: rng.pick<LatencyProfile>(['instant', 'short', 'mixed', 'held']),
    snapshotAt: rng.pick(['arrival', 'response']),
    localEvidence: rng.pick(['none', 'focus', 'focus', 'corrupt']),
    ops: [],
  };
  const count = rng.int(4, 14);
  let backed = false;
  for (let i = 0; i < count && !backed; i += 1) {
    const roll = rng.next();
    let op: Op;
    if (profile === 'signedOut' && i === 0) {
      op = rng.chance(0.6)
        ? { kind: 'connectAccount', taps: taps(rng) }
        : { kind: 'signIn', taps: taps(rng) };
    } else if (roll < 0.17) {
      op = {
        kind: 'save',
        slug: rng.pick(SLUGS),
        taps: taps(rng),
        spacing: spacing(rng),
      };
    } else if (roll < 0.34) {
      op = {
        kind: 'expand',
        slug: rng.chance(0.5) ? rng.pick(MEDIA_SLUGS) : rng.pick(SLUGS),
        taps: taps(rng),
        spacing: spacing(rng),
      };
    } else if (roll < 0.44) {
      op = {
        kind: 'type',
        text: rng.pick(SEARCH_TEXTS),
        gapMs: rng.pick([0, 0, 40, 120, 249, 251]),
      };
    } else if (roll < 0.48) {
      op = { kind: 'clearSearch', taps: taps(rng) };
    } else if (roll < 0.56) {
      op = { kind: 'family', family: rng.pick(FAMILY_VALUES), taps: taps(rng) };
    } else if (roll < 0.61) {
      op = { kind: 'refresh', taps: taps(rng) };
    } else if (roll < 0.68) {
      op = { kind: 'openMedia', taps: taps(rng), spacing: spacing(rng) };
    } else if (roll < 0.72) {
      op = { kind: 'closeMedia', taps: taps(rng) };
    } else if (roll < 0.75) {
      op = { kind: 'browse', taps: taps(rng), spacing: spacing(rng) };
    } else if (roll < 0.77) {
      op = { kind: 'searchYoutube', taps: taps(rng), spacing: spacing(rng) };
    } else if (roll < 0.8) {
      op = { kind: 'retryDetail', taps: taps(rng) };
    } else if (roll < 0.82) {
      op = { kind: 'dismissError', taps: taps(rng) };
    } else if (roll < 0.84) {
      op = { kind: 'retryCatalog', taps: taps(rng) };
    } else if (roll < 0.87) {
      op = { kind: 'rotateToken' };
    } else if (roll < 0.92) {
      op = { kind: 'release', count: rng.int(1, 3) };
    } else if (roll < 0.97) {
      op = {
        kind: 'advance',
        ms: rng.pick([1, 16, 100, 250, 300, 1000, 2600]),
      };
    } else {
      op = { kind: 'back', taps: taps(rng), spacing: spacing(rng) };
      backed = true;
    }
    scenario.ops.push(op);
    // Let some of the work land before the next burst so later bursts find
    // expanded details, media rows and settled save toggles to hit.
    if (
      (op.kind === 'save' || op.kind === 'expand' || op.kind === 'type') &&
      rng.chance(0.5)
    ) {
      scenario.ops.push(
        rng.chance(0.5)
          ? { kind: 'release', count: rng.int(1, 3) }
          : { kind: 'advance', ms: rng.pick([16, 300, 1000]) },
      );
    }
  }
  // Roughly one iteration in five leaves the screen while work is in flight.
  if (!backed && rng.chance(0.2)) {
    scenario.ops.push({ kind: 'back', taps: taps(rng), spacing: spacing(rng) });
  }
  return scenario;
}

// ---------------------------------------------------------------------------
// Result table
// ---------------------------------------------------------------------------

export interface IterationMetrics {
  opsExecuted: number;
  tapsDelivered: number;
  tapsBlockedByDisabled: number;
  tapsWithoutTarget: number;
  requests: number;
  catalogRequests: number;
  detailRequests: number;
  saveRequests: number;
  overlappedSaves: number;
  redundantMutations: number;
  retryDetailIntents: number;
  retryDetailExcessRequests: number;
  externalOpenIntents: number;
  externalOpens: number;
  /** openURL calls beyond one per external-open intent. */
  externalOpenExcess: number;
  refreshIntents: number;
  refreshRequests: number;
  staleBearerRequests: number;
  goBackDevWarnings: number;
  consoleErrors: number;
  unhandledRejections: number;
}

export interface IterationResult {
  seed: number;
  iteration: number;
  outcome: 'held' | 'broken';
  violations: string[];
  softViolations: string[];
  scenario: Scenario;
  metrics: IterationMetrics;
  finalRoutes: string[];
  durationMs: number;
  /** Server-side request timeline, kept only for iterations with a
   * (soft) violation so the results table stays readable. */
  requestLog?: RequestLogEntry[];
}

export type RequestLogEntry = Pick<
  RequestRecord,
  | 'seq'
  | 'kind'
  | 'slug'
  | 'q'
  | 'family'
  | 'outcome'
  | 'arrivedAt'
  | 'completedAt'
>;
