/**
 * Failure-injection support for the LibraryScreen stress harness.
 *
 * Everything the screen depends on that crosses a native or network boundary
 * is modelled here as a fault-injectable fake:
 *
 *   - `@op-engineering/op-sqlite` (native SQLite driver) → `FakeSqliteDriver`.
 *     The production `getDb()` (migrations included) and the production
 *     repository parsers run unmodified on top of it; faults are injected at
 *     the driver's `open` / `executeSync` / `execute` surface.
 *   - `globalThis.fetch` (training API transport) → `FakeTrainingServer`.
 *     The production `createTrainingApi` + training store run unmodified.
 *   - `Linking` (native URL opener) → spies configured per scenario.
 *
 * Fault shapes follow the lens: throw / reject / timeout(never) / malformed /
 * partial / slow / never-resolves.
 */

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) — every random campaign iteration is replayable from
// its 32-bit seed.
// ---------------------------------------------------------------------------

export class Rng {
  private state: number;

  constructor(readonly seed: number) {
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

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }
}

// ---------------------------------------------------------------------------
// Fault shapes
// ---------------------------------------------------------------------------

export type Row = Record<string, unknown>;

export type TableFault =
  | { mode: 'ok' }
  | { mode: 'throw'; message: string }
  | { mode: 'reject'; message: string }
  | { mode: 'never' }
  | { mode: 'slow'; delayMs: number }
  | { mode: 'slow-reject'; delayMs: number; message: string }
  /** Resolve with an arbitrary (possibly malformed) driver result. */
  | { mode: 'result'; result: unknown };

export type OpenMode = 'ok' | 'throw' | 'migrate-throw';

export interface FakeSqliteDriverState {
  openMode: OpenMode;
  shots: TableFault;
  captures: TableFault;
  shotRows: Row[];
  captureRows: Row[];
  /** Every statement seen by the driver (sync and async). */
  statements: string[];
  /** Statements that would mutate persisted state. */
  writes: string[];
  openCount: number;
  /** Resolvers for 'never' faults so a scenario can settle them late. */
  pending: Array<{
    table: 'shots' | 'captures';
    settle: (ok: boolean) => void;
  }>;
}

const WRITE_PATTERN = /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE)\b/i;

export function createSqliteState(): FakeSqliteDriverState {
  return {
    openMode: 'ok',
    shots: { mode: 'ok' },
    captures: { mode: 'ok' },
    shotRows: [],
    captureRows: [],
    statements: [],
    writes: [],
    openCount: 0,
    pending: [],
  };
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function applyTableFault(
  state: FakeSqliteDriverState,
  table: 'shots' | 'captures',
  fault: TableFault,
  rows: Row[],
): Promise<{ rows: Row[] }> {
  switch (fault.mode) {
    case 'ok':
      return Promise.resolve({ rows: rows.map(row => ({ ...row })) });
    case 'throw':
      throw new Error(fault.message);
    case 'reject':
      return Promise.reject(new Error(fault.message));
    case 'never':
      return new Promise((resolve, reject) => {
        state.pending.push({
          table,
          settle: ok =>
            ok
              ? resolve({ rows: rows.map(row => ({ ...row })) })
              : reject(new Error('SQLITE_IOERR: disk I/O error (late)')),
        });
      });
    case 'slow':
      return wait(fault.delayMs).then(() => ({
        rows: rows.map(row => ({ ...row })),
      }));
    case 'slow-reject':
      return wait(fault.delayMs).then(() => {
        throw new Error(fault.message);
      });
    case 'result':
      return Promise.resolve(fault.result as { rows: Row[] });
  }
}

export interface FakeOpSqliteModule {
  open(options: { name: string }): {
    executeSync(sql: string): { rows: Row[] };
    execute(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
    close(): void;
  };
}

/**
 * The op-sqlite surface `src/data/db.ts` uses. Migration statements run
 * through `executeSync` and are accepted as no-ops (PRAGMA table_info reports
 * no columns, so the account-scope migration takes its create-and-copy path
 * — every statement is recorded, so a scenario can prove the screen never
 * issued a write).
 */
export function createFakeOpSqlite(
  state: FakeSqliteDriverState,
): FakeOpSqliteModule {
  return {
    open: () => {
      state.openCount += 1;
      if (state.openMode === 'throw') {
        throw new Error('unable to open database file (SQLITE_CANTOPEN)');
      }
      const migrateThrows = state.openMode === 'migrate-throw';
      return {
        executeSync: (sql: string) => {
          state.statements.push(sql);
          if (
            migrateThrows &&
            /CREATE TABLE IF NOT EXISTS local_shot/i.test(sql)
          ) {
            throw new Error(
              'database disk image is malformed (SQLITE_CORRUPT)',
            );
          }
          return { rows: [] };
        },
        execute: (sql: string) => {
          state.statements.push(sql);
          if (WRITE_PATTERN.test(sql)) state.writes.push(sql);
          if (/FROM\s+local_shot\b/i.test(sql)) {
            return applyTableFault(state, 'shots', state.shots, state.shotRows);
          }
          if (/FROM\s+local_capture\b/i.test(sql)) {
            return applyTableFault(
              state,
              'captures',
              state.captures,
              state.captureRows,
            );
          }
          return Promise.resolve({ rows: [] });
        },
        close: () => {},
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Training API transport (fetch) fake
// ---------------------------------------------------------------------------

export type RouteFault =
  | { mode: 'ok' }
  | { mode: 'reject'; message: string }
  | { mode: 'never' }
  | { mode: 'slow'; delayMs: number }
  | { mode: 'slow-reject'; delayMs: number; message: string }
  | { mode: 'status'; status: number; body?: unknown }
  /** `response.json()` rejects (HTML error page, truncated body). */
  | { mode: 'malformed-json'; status?: number }
  /** 2xx with a body the parser must refuse. */
  | { mode: 'body'; body: unknown };

export type RouteKey =
  'savedDrills' | 'drillDetail' | 'currentPlan' | 'unsaveDrill';

export interface FetchCall {
  method: string;
  path: string;
  route: RouteKey | 'unknown';
}

export interface FakeTrainingServerState {
  routes: Record<RouteKey, RouteFault>;
  /** Per-slug override for drill detail (partial failures). */
  drillDetailBySlug: Record<string, RouteFault>;
  savedDrillsBody: () => unknown;
  drillDetailBody: (slug: string) => unknown;
  currentPlanBody: () => unknown;
  calls: FetchCall[];
  /** Resolvers for 'never' faults so a scenario can settle them late. */
  pending: Array<{ route: RouteKey; settle: (ok: boolean) => void }>;
}

export const SAVED_SLUGS = ['kitchen-line-dinks', 'third-shot-drop'] as const;

export const UUIDS = {
  shot: '5b1f4c6e-0f7e-4d9a-9a4e-3f1c2b7d8e90',
  capture: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
  drillA: '11111111-1111-4111-8111-111111111111',
  drillB: '22222222-2222-4222-8222-222222222222',
  mediaA: '33333333-3333-4333-8333-333333333333',
  mediaB: '44444444-4444-4444-8444-444444444444',
  plan: '55555555-5555-4555-8555-555555555555',
  planItem: '66666666-6666-4666-8666-666666666666',
  planItem2: '77777777-7777-4777-8777-777777777777',
} as const;

export function savedDrillItem(slug: string, id: string): Row {
  return {
    id,
    slug,
    title: slug === SAVED_SLUGS[0] ? 'Kitchen line dinks' : 'Third shot drop',
    description: 'Reviewed catalog entry.',
    coach_name: 'Coach Reviewed',
    equipment: ['paddle', 'balls'],
    difficulty_min: 'beginner',
    difficulty_max: 'intermediate',
    saved_at: '2026-08-30T12:00:00.000Z',
  };
}

export function drillDetailBody(slug: string): Row {
  const id = slug === SAVED_SLUGS[0] ? UUIDS.drillA : UUIDS.drillB;
  const mediaId = slug === SAVED_SLUGS[0] ? UUIDS.mediaA : UUIDS.mediaB;
  const videoId = slug === SAVED_SLUGS[0] ? 'dQw4w9WgXcQ' : 'oHg5SJYRHA0';
  return {
    drill: {
      ...savedDrillItem(slug, id),
      saved: true,
    },
    mappings: [
      {
        checkpoint: 'paddle_face',
        shot_type: 'dink',
        plan_role: 'targeted',
        fault_directions: ['open'],
        cue_text: 'Keep the paddle face steady.',
        target_sets: 2,
        target_repetitions_per_set: 10,
        target_duration_seconds: null,
        rest_seconds: 30,
      },
    ],
    instructionalMedia: [
      {
        id: mediaId,
        kind: 'embed',
        provider: 'youtube',
        videoId,
        embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}`,
        sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
        creatorName: 'Reviewed Coach',
        licenseName: 'Standard YouTube License',
        licenseUrl: null,
        attribution: 'Reviewed Coach on YouTube',
      },
    ],
  };
}

export function currentPlanBody(): Row {
  return {
    plan: {
      id: UUIDS.plan,
      status: 'active',
      algorithmVersion: 'plan-v1',
      sourceShotId: UUIDS.shot,
      shotType: 'dink',
      priorityCheckpoint: 'paddle_face',
      priorityDirection: 'too_open',
      baselineScore: 61.5,
      baselineCheckpointScore: 40,
      reassessmentShotId: null,
      scoreDelta: null,
      createdAt: '2026-08-30T12:00:00.000Z',
      completedAt: null,
      items: [
        {
          id: UUIDS.planItem,
          position: 1,
          kind: 'targeted',
          drill: {
            slug: SAVED_SLUGS[0],
            title: 'Kitchen line dinks',
            description: 'Reviewed catalog entry.',
            coachName: 'Coach Reviewed',
            equipment: [],
            saved: true,
          },
          cueText: 'Keep the paddle face steady.',
          targetSets: 2,
          targetRepetitionsPerSet: 10,
          targetDurationSeconds: null,
          restSeconds: 30,
          completion: null,
        },
        {
          id: UUIDS.planItem2,
          position: 2,
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
  };
}

export function createServerState(): FakeTrainingServerState {
  return {
    routes: {
      savedDrills: { mode: 'ok' },
      drillDetail: { mode: 'ok' },
      currentPlan: { mode: 'ok' },
      unsaveDrill: { mode: 'ok' },
    },
    drillDetailBySlug: {},
    savedDrillsBody: () => ({
      items: [
        savedDrillItem(SAVED_SLUGS[0], UUIDS.drillA),
        savedDrillItem(SAVED_SLUGS[1], UUIDS.drillB),
      ],
    }),
    drillDetailBody,
    currentPlanBody: () => ({ plan: null }),
    calls: [],
    pending: [],
  };
}

function classify(method: string, path: string): RouteKey | 'unknown' {
  if (method === 'GET' && path === '/v1/me/saved-drills') return 'savedDrills';
  if (method === 'GET' && path.startsWith('/v1/catalog/drills/')) {
    return 'drillDetail';
  }
  if (method === 'GET' && path === '/v1/training-plans/current') {
    return 'currentPlan';
  }
  if (method === 'DELETE' && path.startsWith('/v1/me/saved-drills/')) {
    return 'unsaveDrill';
  }
  return 'unknown';
}

function fakeResponse(status: number, body: unknown, jsonThrows = false) {
  const response = {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 500 ? 'Internal Server Error' : 'Error',
    json: () =>
      jsonThrows
        ? Promise.reject(new SyntaxError('Unexpected token < in JSON'))
        : Promise.resolve(body),
  };
  return response as unknown as Response;
}

export function createFakeFetch(
  state: FakeTrainingServerState,
): (input: string, init?: RequestInit) => Promise<Response> {
  return (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const url = new URL(input);
    const path = url.pathname;
    const route = classify(method, path);
    state.calls.push({ method, path, route });
    if (route === 'unknown') {
      return Promise.resolve(
        fakeResponse(404, { error: { code: 'not_found' } }),
      );
    }
    const okBody = (): unknown => {
      switch (route) {
        case 'savedDrills':
          return state.savedDrillsBody();
        case 'drillDetail':
          return state.drillDetailBody(
            decodeURIComponent(path.slice('/v1/catalog/drills/'.length)),
          );
        case 'currentPlan':
          return state.currentPlanBody();
        case 'unsaveDrill':
          return null;
      }
    };
    const okStatus = route === 'unsaveDrill' ? 204 : 200;
    let fault: RouteFault = state.routes[route];
    if (route === 'drillDetail') {
      const slug = decodeURIComponent(path.slice('/v1/catalog/drills/'.length));
      fault = state.drillDetailBySlug[slug] ?? fault;
    }
    switch (fault.mode) {
      case 'ok':
        return Promise.resolve(fakeResponse(okStatus, okBody()));
      case 'reject':
        return Promise.reject(new TypeError(fault.message));
      case 'never':
        return new Promise<Response>((resolve, reject) => {
          state.pending.push({
            route,
            settle: ok =>
              ok
                ? resolve(fakeResponse(okStatus, okBody()))
                : reject(new TypeError('Network request failed')),
          });
        });
      case 'slow': {
        const { delayMs } = fault;
        return wait(delayMs).then(() => fakeResponse(okStatus, okBody()));
      }
      case 'slow-reject': {
        const { delayMs, message } = fault;
        return wait(delayMs).then(() => {
          throw new TypeError(message);
        });
      }
      case 'status':
        return Promise.resolve(
          fakeResponse(
            fault.status,
            fault.body === undefined
              ? {
                  error: {
                    code: `http.${fault.status}`,
                    message: `Injected HTTP ${fault.status}.`,
                  },
                }
              : fault.body,
          ),
        );
      case 'malformed-json':
        return Promise.resolve(fakeResponse(fault.status ?? 200, null, true));
      case 'body':
        return Promise.resolve(fakeResponse(200, fault.body));
    }
  };
}

// ---------------------------------------------------------------------------
// Ground-truth local rows
// ---------------------------------------------------------------------------

export function realShotRow(overrides: Row = {}): Row {
  return {
    id: UUIDS.shot,
    session_id: null,
    shot_type: 'dink',
    captured_at: '2026-08-30T15:04:05.000Z',
    overall_score: 71.2,
    confidence: 0.91,
    result_kind: 'scored',
    source: 'real',
    favorite: 0,
    ...overrides,
  };
}

export function legacyCaptureRow(overrides: Row = {}): Row {
  return {
    id: UUIDS.capture,
    uri: 'file:///var/mobile/clips/clip-1.mov',
    shot_type: 'dink',
    declared_stroke: 'dink',
    captured_at: '2026-08-31T09:30:00.000Z',
    duration_ms: 4200,
    fps: 60,
    width: 1080,
    height: 1920,
    payload: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Result table
// ---------------------------------------------------------------------------

export interface OutcomeRow {
  scenario: string;
  seed: number | null;
  dependency: string;
  shape: string;
  outcome: 'HELD' | 'BROKEN';
  detail: string;
  script?: string[];
  rendered?: string;
  trainingStore?: { savedStatus: string; planStatus: string; mutation: string };
}

export class OutcomeTable {
  readonly rows: OutcomeRow[] = [];

  record(row: OutcomeRow): void {
    this.rows.push(row);
  }
}
