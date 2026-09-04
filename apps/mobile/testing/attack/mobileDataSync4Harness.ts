/**
 * Shared harness for the mobile-data-sync adversarial pass #4
 * (__tests__/attack/mobileDataSync4). Test-only.
 *
 * Every suite in that folder mocks `@op-engineering/op-sqlite` with
 * `createOpSqliteModuleMock()` (see nodeSqliteOpAdapter.ts) so the REAL
 * `getDb()` — production LOCAL_MIGRATIONS + ensureAccountScopedSchema —
 * runs against a genuine in-memory SQLite engine. Nothing here touches
 * production code.
 */
import type { LocalDb } from '../../src/data/db';
import type { SyncTransport } from '../../src/data/sync';

/** Deterministic v4-shaped UUIDs (pass the client + server UUID regexes). */
export function uuidAt(prefix: number, n: number): string {
  const p = prefix.toString(16).padStart(8, '0').slice(0, 8);
  const tail = n.toString(16).padStart(12, '0').slice(-12);
  return `${p}-0000-4000-8000-${tail}`;
}

export const SESSION_S = 'aaaaaaaa-5e55-4000-8000-000000000001';
export const SESSION_T = 'bbbbbbbb-5e55-4000-8000-000000000002';

/** mulberry32 — small seeded PRNG so jittered schedules are reproducible. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Loads the real db module in isolation so `instance` starts null. */
export function loadRealGetDb(): () => LocalDb {
  let getDb: (() => LocalDb) | null = null;
  jest.isolateModules(() => {
    getDb =
      jest.requireActual<typeof import('../../src/data/db')>(
        '../../src/data/db',
      ).getDb;
  });
  if (!getDb) throw new Error('db module did not load');
  return getDb;
}

export interface OutboxRowView {
  id: number;
  owner_key: string;
  kind: string;
  attempts: number;
  last_error: string | null;
  entity: string | null;
}

export async function outboxRows(db: LocalDb): Promise<OutboxRowView[]> {
  const { rows } = await db.execute(
    `SELECT id, owner_key, kind, attempts, last_error,
            json_extract(payload, '$.id') AS entity
       FROM outbox ORDER BY id ASC`,
  );
  return rows.map(r => ({
    id: Number(r['id']),
    owner_key: String(r['owner_key']),
    kind: String(r['kind']),
    attempts: Number(r['attempts']),
    last_error: r['last_error'] == null ? null : String(r['last_error']),
    entity: r['entity'] == null ? null : String(r['entity']),
  }));
}

export async function countRows(
  db: LocalDb,
  table: string,
  owner?: string,
): Promise<number> {
  const { rows } =
    owner === undefined
      ? await db.execute(`SELECT count(*) AS n FROM ${table}`)
      : await db.execute(
          `SELECT count(*) AS n FROM ${table} WHERE owner_key = ?`,
          [owner],
        );
  return Number(rows[0]?.['n'] ?? 0);
}

export async function receiptRows(
  db: LocalDb,
): Promise<Array<{ owner_key: string; entity_id: string }>> {
  const { rows } = await db.execute(
    'SELECT owner_key, entity_id FROM sync_receipt ORDER BY owner_key, entity_id',
  );
  return rows.map(r => ({
    owner_key: String(r['owner_key']),
    entity_id: String(r['entity_id']),
  }));
}

/**
 * Transport that mirrors the server's session rule: a shot whose sessionId
 * has not been created is rejected with `shot.session_not_found`
 * (apply_synced_shot); everything else is accepted. `createSession` can be
 * made to fail with a supplied error to model permanent server verdicts.
 */
export function createSessionAwareTransport(
  options: {
    createSessionError?: () => unknown;
  } = {},
): SyncTransport & {
  sessions: Set<string>;
  syncShotsCalls: unknown[][];
  createSessionCalls: unknown[];
  finalizeSessionCalls: string[];
} {
  const sessions = new Set<string>();
  const syncShotsCalls: unknown[][] = [];
  const createSessionCalls: unknown[] = [];
  const finalizeSessionCalls: string[] = [];
  return {
    sessions,
    syncShotsCalls,
    createSessionCalls,
    finalizeSessionCalls,
    async syncShots(shots) {
      syncShotsCalls.push(shots);
      const acceptedIds: string[] = [];
      const rejected: Array<{ id: string; code: string; message: string }> = [];
      for (const raw of shots as Array<Record<string, unknown>>) {
        const id = String(raw.id);
        const sessionId = raw.sessionId;
        if (sessionId !== null && !sessions.has(String(sessionId))) {
          rejected.push({
            id,
            code: 'shot.session_not_found',
            message: 'Session not found or not yours.',
          });
          continue;
        }
        acceptedIds.push(id);
      }
      return { acceptedIds, rejected };
    },
    async createSession(session) {
      createSessionCalls.push(session);
      if (options.createSessionError) throw options.createSessionError();
      sessions.add(String((session as { id: unknown }).id));
    },
    async finalizeSession(id) {
      finalizeSessionCalls.push(id);
    },
  };
}

export interface FakeResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export function jsonResponse(status: number, body: unknown): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : `HTTP ${status}`,
    headers: { get: () => null },
    json: async () => body,
  };
}

export interface RecordedFetch {
  atMs: number;
  url: string;
  authorization: string | undefined;
  body: unknown;
  respond: Deferred<FakeResponse>;
}

/**
 * Installs a controllable global fetch: every call is recorded and answered
 * by a deferred the test resolves explicitly (or automatically through
 * `autoRespond`). Returns the log plus an uninstall function.
 */
export function installControlledFetch(
  options: {
    autoRespond?: (call: RecordedFetch) => FakeResponse | null;
  } = {},
): { calls: RecordedFetch[]; uninstall: () => void } {
  const calls: RecordedFetch[] = [];
  const previous = (globalThis as { fetch?: unknown }).fetch;
  (globalThis as { fetch?: unknown }).fetch = jest.fn(
    (url: string, init: { headers: Record<string, string>; body?: string }) => {
      const call: RecordedFetch = {
        atMs: Date.now(),
        url,
        authorization: init.headers['authorization'],
        body: init.body === undefined ? undefined : JSON.parse(init.body),
        respond: deferred<FakeResponse>(),
      };
      calls.push(call);
      const auto = options.autoRespond?.(call) ?? null;
      if (auto) call.respond.resolve(auto);
      return call.respond.promise;
    },
  );
  return {
    calls,
    uninstall: () => {
      if (previous === undefined) {
        delete (globalThis as { fetch?: unknown }).fetch;
      } else {
        (globalThis as { fetch?: unknown }).fetch = previous;
      }
    },
  };
}

export function flushMicrotasks(): Promise<void> {
  return new Promise<void>(resolve => {
    setImmediate(resolve);
  });
}

/** Flushes the drain's promise chain while setTimeout/Date stay fake. */
export async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await flushMicrotasks();
}
