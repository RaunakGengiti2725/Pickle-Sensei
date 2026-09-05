/**
 * Async "gates" the LibraryScreen stress harness sits between the real
 * product code and its two I/O edges:
 *
 *   DbGate     backs the `@op-engineering/op-sqlite` jest mock with a real
 *              in-memory `node:sqlite` database. Writes and migrations run
 *              immediately; every SELECT the screen issues (listShots /
 *              listPendingCaptures via the REAL repository + getDb) is
 *              executed against SQLite at issue time but its promise is
 *              parked until the generator decides to deliver or fail it.
 *              That is what lets a seed interleave focus/blur/retry with
 *              late-settling repository reads in every order.
 *
 *   FetchGate  is the `fetchFn` handed to the REAL `createTrainingApi`.
 *              Every request is parked the same way; the generator settles
 *              it as 200 (from the fake server's CURRENT state), 404/500,
 *              401, or a network failure.
 *
 * Neither gate uses Math.random or timers: all ordering comes from the seed.
 */
declare const require: (id: string) => unknown;

type SqlValue = null | number | bigint | string | Uint8Array;

interface SqliteStatement {
  all(...params: SqlValue[]): unknown[];
  run(...params: SqlValue[]): unknown;
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

interface NodeSqlite {
  DatabaseSync: new (location: string) => SqliteDatabase;
}

const nodeSqlite = require('node:sqlite') as NodeSqlite;

export interface DbReadEntry {
  id: number;
  table: 'local_shot' | 'local_capture';
  rows: Record<string, unknown>[];
  settled: 'pending' | 'ok' | 'fail';
  resolve: (rows: Record<string, unknown>[]) => void;
  reject: (error: Error) => void;
}

function readTable(sql: string): DbReadEntry['table'] | null {
  if (!/^\s*SELECT/i.test(sql)) return null;
  if (/FROM\s+local_shot\b/i.test(sql)) return 'local_shot';
  if (/FROM\s+local_capture\b/i.test(sql)) return 'local_capture';
  return null;
}

export class DbGate {
  private real: SqliteDatabase | null = null;
  private nextId = 1;
  readonly pending: DbReadEntry[] = [];
  /** Every read ever issued in the current sequence, in issue order. */
  readonly issued: DbReadEntry[] = [];
  opens = 0;

  /** Called by the op-sqlite mock's `open`. */
  open(): {
    executeSync(sql: string): { rows: unknown[] };
    execute(
      sql: string,
      params?: unknown[],
    ): Promise<{ rows: Record<string, unknown>[] }>;
    close(): void;
  } {
    if (!this.real) this.real = new nodeSqlite.DatabaseSync(':memory:');
    const real = this.real;
    this.opens += 1;
    return {
      executeSync: (sql: string) => {
        const stmt = real.prepare(sql);
        if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return { rows: stmt.all() };
        stmt.run();
        return { rows: [] };
      },
      execute: async (sql: string, params: unknown[] = []) => {
        const table = readTable(sql);
        const stmt = real.prepare(sql);
        if (table === null) {
          if (/^\s*(SELECT|PRAGMA)/i.test(sql)) {
            return {
              rows: stmt.all(...(params as SqlValue[])) as Record<
                string,
                unknown
              >[],
            };
          }
          stmt.run(...(params as SqlValue[]));
          return { rows: [] };
        }
        const rows = stmt.all(...(params as SqlValue[])) as Record<
          string,
          unknown
        >[];
        return new Promise<{ rows: Record<string, unknown>[] }>(
          (resolve, reject) => {
            const entry: DbReadEntry = {
              id: this.nextId++,
              table,
              rows,
              settled: 'pending',
              resolve: delivered => resolve({ rows: delivered }),
              reject,
            };
            this.pending.push(entry);
            this.issued.push(entry);
          },
        );
      },
      close: () => {
        // The product closes through getDb().close(); the next open() gets a
        // fresh in-memory database (a new sequence starts from an empty store).
        real.close();
        this.real = null;
      },
    };
  }

  /** Direct (un-gated) write for harness seeding. */
  run(sql: string, params: SqlValue[] = []): void {
    if (!this.real) throw new Error('DbGate.run before the product opened');
    this.real.prepare(sql).run(...params);
  }

  /** Direct (un-gated) read for oracle checks. */
  query(sql: string, params: SqlValue[] = []): Record<string, unknown>[] {
    if (!this.real) throw new Error('DbGate.query before the product opened');
    return this.real.prepare(sql).all(...params) as Record<string, unknown>[];
  }

  settle(entry: DbReadEntry, outcome: 'ok' | 'fail'): void {
    const index = this.pending.indexOf(entry);
    if (index < 0 || entry.settled !== 'pending') {
      throw new Error(`db entry ${entry.id} already settled`);
    }
    this.pending.splice(index, 1);
    entry.settled = outcome;
    if (outcome === 'ok') entry.resolve(entry.rows);
    else entry.reject(new Error(`[stress] sqlite read ${entry.id} failed`));
  }

  resetSequence(): void {
    for (const entry of [...this.pending]) this.settle(entry, 'ok');
    this.pending.length = 0;
    this.issued.length = 0;
    this.nextId = 1;
    this.opens = 0;
  }
}

/* ------------------------------------------------------------------ */
/* Fake training server + fetch gate                                   */
/* ------------------------------------------------------------------ */

export interface FakeMedia {
  id: string;
  kind: 'embed' | 'hosted';
  provider?: 'youtube' | 'vimeo';
  videoId?: string;
  embedUrl?: string;
  playbackUrl?: string;
  expiresAt?: string;
  sourceUrl: string;
  creatorName: string;
  licenseName: string;
  licenseUrl: string | null;
  attribution: string;
}

export interface FakeDrill {
  id: string;
  slug: string;
  title: string;
  description: string;
  coach_name: string;
  equipment: string[];
  difficulty_min: string | null;
  difficulty_max: string | null;
  saved_at: string;
  /** null → GET /v1/catalog/drills/:slug answers 404 (entry "held"). */
  detail: {
    mappings: unknown[];
    instructionalMedia: FakeMedia[];
  } | null;
}

export interface FakePlan {
  id: string;
  sourceShotId: string;
  shotType: string;
  priorityCheckpoint: string;
  priorityDirection: string;
  items: unknown[];
}

export interface FakeServer {
  saved: FakeDrill[];
  plan: FakePlan | null;
}

export type FetchOutcome = 'ok' | '404' | '500' | '401' | 'network' | 'garbage';

export interface FetchEntry {
  id: number;
  method: string;
  path: string;
  /** Training-store configuration version at issue time. */
  configVersion: number;
  settled: 'pending' | FetchOutcome;
  /** For a 200 `GET /v1/me/saved-drills`: the slugs the server answered. */
  listedSlugs: string[] | null;
  /** For a 200 catalog detail: the slug answered. */
  detailSlug: string | null;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

function garbageResponse(status: number): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
  } as unknown as Response;
}

export function drillPayload(drill: FakeDrill): Record<string, unknown> {
  return {
    id: drill.id,
    slug: drill.slug,
    title: drill.title,
    description: drill.description,
    coach_name: drill.coach_name,
    equipment: drill.equipment,
    difficulty_min: drill.difficulty_min,
    difficulty_max: drill.difficulty_max,
    saved_at: drill.saved_at,
  };
}

export class FetchGate {
  private nextId = 1;
  readonly pending: FetchEntry[] = [];
  readonly issued: FetchEntry[] = [];
  configVersion = 0;
  server: FakeServer = { saved: [], plan: null };

  readonly fetchFn = (input: string, init?: RequestInit): Promise<Response> => {
    const path = input.replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
    return new Promise<Response>((resolve, reject) => {
      const entry: FetchEntry = {
        id: this.nextId++,
        method: init?.method ?? 'GET',
        path,
        configVersion: this.configVersion,
        settled: 'pending',
        listedSlugs: null,
        detailSlug: null,
        resolve,
        reject,
      };
      this.pending.push(entry);
      this.issued.push(entry);
    });
  };

  /** The response the fake server gives for `entry` from its CURRENT state. */
  private respond(entry: FetchEntry): Response {
    const { method, path } = entry;
    if (method === 'GET' && path === '/v1/me/saved-drills') {
      entry.listedSlugs = this.server.saved.map(d => d.slug);
      return jsonResponse(200, {
        items: this.server.saved.map(drillPayload),
      });
    }
    const detail = /^\/v1\/catalog\/drills\/([^/]+)$/.exec(path);
    if (method === 'GET' && detail) {
      const slug = decodeURIComponent(detail[1]!);
      const drill = this.server.saved.find(d => d.slug === slug);
      if (!drill || !drill.detail) {
        entry.settled = '404';
        return jsonResponse(404, {
          error: { code: 'catalog.not_found', message: 'Drill not found.' },
        });
      }
      entry.detailSlug = slug;
      return jsonResponse(200, {
        drill: {
          ...drillPayload(drill),
          saved: true,
        },
        mappings: drill.detail.mappings,
        instructionalMedia: drill.detail.instructionalMedia,
      });
    }
    const unsave = /^\/v1\/me\/saved-drills\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && unsave) {
      const slug = decodeURIComponent(unsave[1]!);
      this.server.saved = this.server.saved.filter(d => d.slug !== slug);
      return jsonResponse(204, null);
    }
    if (method === 'GET' && path === '/v1/training-plans/current') {
      const plan = this.server.plan;
      return jsonResponse(200, {
        plan: plan
          ? {
              id: plan.id,
              status: 'active',
              algorithmVersion: 'stress-v1',
              sourceShotId: plan.sourceShotId,
              shotType: plan.shotType,
              priorityCheckpoint: plan.priorityCheckpoint,
              priorityDirection: plan.priorityDirection,
              baselineScore: 5.5,
              baselineCheckpointScore: null,
              reassessmentShotId: null,
              scoreDelta: null,
              createdAt: '2026-08-30T10:00:00.000Z',
              completedAt: null,
              items: plan.items,
            }
          : null,
      });
    }
    return jsonResponse(404, {
      error: { code: 'not_found', message: `No route ${method} ${path}` },
    });
  }

  settle(entry: FetchEntry, outcome: FetchOutcome): void {
    const index = this.pending.indexOf(entry);
    if (index < 0 || entry.settled !== 'pending') {
      throw new Error(`fetch entry ${entry.id} already settled`);
    }
    this.pending.splice(index, 1);
    entry.settled = outcome;
    switch (outcome) {
      case 'ok':
        entry.resolve(this.respond(entry));
        return;
      case '404':
        entry.resolve(
          jsonResponse(404, {
            error: { code: 'not_found', message: 'Not found.' },
          }),
        );
        return;
      case '500':
        entry.resolve(
          jsonResponse(500, {
            error: {
              code: 'internal',
              message: 'Stress fake server: simulated upstream failure.',
            },
          }),
        );
        return;
      case '401':
        entry.resolve(jsonResponse(401, {}));
        return;
      case 'garbage':
        entry.resolve(garbageResponse(200));
        return;
      case 'network':
        entry.reject(new TypeError('Network request failed'));
        return;
    }
  }

  resetSequence(): void {
    for (const entry of [...this.pending]) this.settle(entry, 'network');
    this.pending.length = 0;
    this.issued.length = 0;
    this.nextId = 1;
    this.server = { saved: [], plan: null };
  }
}

/** Process-wide singletons the jest.mock factories reach for. */
export const dbGate = new DbGate();
export const fetchGate = new FetchGate();
