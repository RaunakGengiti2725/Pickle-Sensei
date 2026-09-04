/**
 * Real-SQLite stand-in for `@op-engineering/op-sqlite` in jest.
 *
 * `getDb()` in src/data/db.ts runs its migrations through the native
 * op-sqlite handle (`executeSync` / `execute` / `close`). Jest cannot load
 * the native module, and a hand-written fake `LocalDb` cannot enforce
 * PRIMARY KEY / UNIQUE / CHECK constraints, so tests that need the REAL
 * schema semantics route the same three calls into Node's built-in SQLite
 * engine (`node:sqlite`, in-memory). The production migrations and every
 * repository statement then execute against a genuine SQLite database.
 *
 * Engine resolution (both paths are the same real SQLite engine):
 *  1. `require('node:sqlite')` in-process — Node >= 22.13 (unflagged) or any
 *     22.5+ started with `NODE_OPTIONS=--experimental-sqlite`.
 *  2. Otherwise a `worker_threads` Worker started with
 *     `execArgv: ['--experimental-sqlite']` hosts the database and the main
 *     thread drives it synchronously (Atomics.wait + receiveMessageOnPort),
 *     so plain `npx jest --ci --silent` works on 22.11/22.12 too.
 * If neither works the adapter throws a descriptive error instead of
 * silently degrading.
 */

// The mobile tsconfig deliberately carries no @types/node (types: ["jest"]);
// like the other node-touching suites, the built-ins are required through a
// locally declared `require` and typed structurally to exactly what is used.
declare const require: (id: string) => unknown;
declare const process: { version: string };

type Row = Record<string, unknown>;
type Param = string | number | bigint | null | Uint8Array;

interface StatementLike {
  all(...params: Param[]): unknown[];
}
interface DatabaseSyncLike {
  prepare(sql: string): StatementLike;
  close(): void;
}
type DatabaseSyncCtor = new (path: string) => DatabaseSyncLike;

interface MessagePortLike {
  postMessage(value: unknown): void;
  unref(): void;
  close(): void;
}
interface WorkerLike {
  on(event: 'error', listener: (error: unknown) => void): unknown;
  unref(): void;
  terminate(): Promise<number>;
}
interface WorkerThreadsLike {
  MessageChannel: new () => { port1: MessagePortLike; port2: MessagePortLike };
  Worker: new (
    source: string,
    options: {
      eval: boolean;
      execArgv: string[];
      workerData: unknown;
      transferList: unknown[];
    },
  ) => WorkerLike;
  receiveMessageOnPort(port: MessagePortLike): { message: unknown } | undefined;
}

function errorMessage(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }
  return String(error);
}

export interface OpSqliteLike {
  executeSync(sql: string, params?: unknown[]): { rows: Row[] };
  execute(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
  close(): void;
}

/** How the engine was obtained; exposed so tests can record it in evidence. */
export type SqliteEngineMode = 'in-process' | 'worker';

interface Engine {
  mode: SqliteEngineMode;
  run(sql: string, params: Param[]): Row[];
  close(): void;
}

function toParam(value: unknown, index: number, sql: string): Param {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  throw new Error(
    `Unsupported SQLite bind parameter #${index} (${typeof value}) for: ${sql}`,
  );
}

function tryLoadInProcess(): DatabaseSyncCtor | null {
  try {
    const mod = require('node:sqlite') as { DatabaseSync: DatabaseSyncCtor };
    return mod.DatabaseSync;
  } catch {
    return null;
  }
}

function openInProcess(Database: DatabaseSyncCtor): Engine {
  const raw = new Database(':memory:');
  return {
    mode: 'in-process',
    run: (sql, params) => raw.prepare(sql).all(...params) as Row[],
    close: () => raw.close(),
  };
}

// ─── Worker-hosted engine (Node 22.5 – 22.12 without the flag) ─────────────

interface WorkerRequest {
  op: 'run' | 'close';
  sql?: string;
  params?: Param[];
}
type WorkerReply =
  | { ok: true; rows: Row[] }
  | { ok: false; message: string; code?: string; errcode?: number };

// Runs inside the worker. Kept as a string so the worker needs no file on
// disk and no transform; it only uses Node built-ins.
const WORKER_SOURCE = `
const { workerData, parentPort } = require('worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { port, signal } = workerData;
const flag = new Int32Array(signal);
const db = new DatabaseSync(':memory:');
port.on('message', (req) => {
  let reply;
  try {
    if (req.op === 'close') {
      db.close();
      reply = { ok: true, rows: [] };
    } else {
      const rows = db.prepare(req.sql).all(...req.params);
      reply = { ok: true, rows };
    }
  } catch (error) {
    reply = {
      ok: false,
      message: error && error.message ? String(error.message) : String(error),
      code: error && error.code,
      errcode: error && error.errcode,
    };
  }
  port.postMessage(reply);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
  if (req.op === 'close') process.exit(0);
});
parentPort.postMessage('ready');
`;

const WORKER_TIMEOUT_MS = 10_000;

function openInWorker(): Engine {
  const { MessageChannel, Worker, receiveMessageOnPort } =
    require('worker_threads') as WorkerThreadsLike;
  const { port1, port2 } = new MessageChannel();
  const signal = new SharedArrayBuffer(4);
  const flag = new Int32Array(signal);
  const parkCell = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    execArgv: ['--experimental-sqlite', '--no-warnings'],
    workerData: { port: port2, signal },
    transferList: [port2],
  });
  worker.unref();
  const port = port1;
  port.unref();
  let startupError: string | null = null;
  worker.on('error', error => {
    startupError = errorMessage(error);
  });

  const call = (req: WorkerRequest): WorkerReply => {
    if (startupError) {
      throw new Error(`node:sqlite worker failed: ${startupError}`);
    }
    Atomics.store(flag, 0, 0);
    port.postMessage(req);
    const waited = Atomics.wait(flag, 0, 0, WORKER_TIMEOUT_MS);
    if (waited === 'timed-out') {
      throw new Error(
        `node:sqlite worker did not answer within ${WORKER_TIMEOUT_MS}ms ` +
          `(startup error: ${startupError ?? 'none'}) for: ${req.sql ?? req.op}`,
      );
    }
    let received = receiveMessageOnPort(port);
    const deadline = Date.now() + WORKER_TIMEOUT_MS;
    while (!received && Date.now() < deadline) {
      Atomics.wait(parkCell, 0, 0, 1); // 1ms park
      received = receiveMessageOnPort(port);
    }
    if (!received) {
      throw new Error('node:sqlite worker signalled but sent no reply');
    }
    return received.message as WorkerReply;
  };

  return {
    mode: 'worker',
    run: (sql, params) => {
      const reply = call({ op: 'run', sql, params });
      if (!reply.ok) {
        const error = new Error(reply.message) as Error & {
          code?: string;
          errcode?: number;
        };
        if (reply.code !== undefined) error.code = reply.code;
        if (reply.errcode !== undefined) error.errcode = reply.errcode;
        throw error;
      }
      return reply.rows;
    },
    close: () => {
      try {
        call({ op: 'close' });
      } finally {
        port.close();
        void worker.terminate();
      }
    },
  };
}

function openEngine(): Engine {
  const inProcess = tryLoadInProcess();
  if (inProcess) return openInProcess(inProcess);
  try {
    const engine = openInWorker();
    // Prove the worker actually hosts SQLite before handing it out.
    engine.run('SELECT sqlite_version() AS v', []);
    return engine;
  } catch (error) {
    throw new Error(
      `node:sqlite is not available in this Node runtime (${process.version}) ` +
        'in-process, and the --experimental-sqlite worker fallback failed. ' +
        'Run with Node >= 22.13 or NODE_OPTIONS=--experimental-sqlite. ' +
        `Original error: ${String(error)}`,
    );
  }
}

/** Opens an in-memory SQLite database that speaks op-sqlite's handle API. */
export function openNodeSqlite(): OpSqliteLike & { mode: SqliteEngineMode } {
  const engine = openEngine();
  let closed = false;

  const run = (sql: string, params: unknown[] = []): { rows: Row[] } => {
    if (closed) throw new Error('database is closed');
    const bound = params.map((p, i) => toParam(p, i, sql));
    return { rows: engine.run(sql, bound) };
  };

  return {
    mode: engine.mode,
    executeSync: run,
    async execute(sql, params = []) {
      return run(sql, params);
    },
    close() {
      if (closed) return;
      closed = true;
      engine.close();
    },
  };
}

/**
 * Factory for `jest.mock('@op-engineering/op-sqlite', ...)`. Every `open()`
 * yields a fresh in-memory database; handles are kept for out-of-band
 * inspection (raw SQL / engine mode) from the test.
 */
export function createOpSqliteModuleMock(): {
  open: (options: { name: string }) => OpSqliteLike;
  handles: Array<OpSqliteLike & { mode: SqliteEngineMode }>;
} {
  const handles: Array<OpSqliteLike & { mode: SqliteEngineMode }> = [];
  return {
    handles,
    open: () => {
      const handle = openNodeSqlite();
      handles.push(handle);
      return handle;
    },
  };
}
