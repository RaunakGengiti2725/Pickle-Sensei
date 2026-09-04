/**
 * XC journey-history-library-delete — `node:sqlite` behind a worker thread.
 *
 * Node 22.5–22.12 ship `node:sqlite` only behind `--experimental-sqlite`, and a
 * plain `npx jest` on those versions cannot enable it in-process. A worker
 * thread CAN carry its own `execArgv`, so this module runs the real SQLite
 * engine inside `new Worker(..., { execArgv: ['--experimental-sqlite'] })`
 * and exposes the SAME synchronous `DatabaseSync`-shaped surface the driver
 * needs, using a SharedArrayBuffer + `Atomics.wait` request/response channel.
 * The engine is still the genuine SQLite build bundled with Node — only the
 * thread it runs on differs.
 *
 * Used automatically by `realSqlite.ts` when `require('node:sqlite')` fails;
 * Node >= 22.13 (unflagged) never touches this file.
 */

declare const require: (id: string) => unknown;
declare const process: { version: string };
declare const TextEncoder: new () => { encode(text: string): Uint8Array };
declare const TextDecoder: new () => { decode(bytes: Uint8Array): string };

type SqlInput = null | number | bigint | string | Uint8Array;

interface WorkerLike {
  unref(): void;
  terminate(): Promise<number>;
}

interface WorkerThreadsModule {
  Worker: new (
    source: string,
    options: {
      eval: boolean;
      execArgv: string[];
      workerData: unknown;
    },
  ) => WorkerLike;
}

const CTRL_REQ = 0;
const CTRL_RES = 1;
const CTRL_LEN = 2;
const DATA_BYTES = 32 * 1024 * 1024;
const RESPONSE_TIMEOUT_MS = 60_000;

type WireParam =
  null | number | string | { __bigint: string } | { __u8: number[] };

type Request =
  | { op: 'exec'; sql: string }
  | { op: 'all'; sql: string; params: WireParam[] }
  | { op: 'run'; sql: string; params: WireParam[] }
  | { op: 'close' };

type Response =
  | { ok: true; rows?: unknown[]; changes?: number }
  | {
      ok: false;
      error: {
        message: string;
        code?: string;
        errcode?: number;
        errstr?: string;
      };
    };

// Plain JavaScript on purpose: it is evaluated inside the worker, which has
// no TypeScript transform.
const WORKER_SOURCE = `
const { workerData } = require('worker_threads');
const { DatabaseSync } = require('node:sqlite');
const ctrl = new Int32Array(workerData.ctrl);
const data = new Uint8Array(workerData.data);
const db = new DatabaseSync(workerData.path);
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const decodeParam = p =>
  p !== null && typeof p === 'object'
    ? '__bigint' in p ? BigInt(p.__bigint) : Uint8Array.from(p.__u8)
    : p;
const replacer = (_k, v) => (typeof v === 'bigint' ? Number(v) : v);
let seen = 0;
for (;;) {
  Atomics.wait(ctrl, ${CTRL_REQ}, seen);
  const seq = Atomics.load(ctrl, ${CTRL_REQ});
  if (seq === seen) continue;
  seen = seq;
  const req = JSON.parse(decoder.decode(data.subarray(0, ctrl[${CTRL_LEN}])));
  let res;
  try {
    if (req.op === 'exec') {
      db.exec(req.sql);
      res = { ok: true };
    } else if (req.op === 'all') {
      res = { ok: true, rows: db.prepare(req.sql).all(...req.params.map(decodeParam)) };
    } else if (req.op === 'run') {
      const r = db.prepare(req.sql).run(...req.params.map(decodeParam));
      res = { ok: true, changes: Number(r.changes) };
    } else if (req.op === 'close') {
      db.close();
      res = { ok: true };
    } else {
      res = { ok: false, error: { message: 'unknown op ' + String(req.op) } };
    }
  } catch (e) {
    res = {
      ok: false,
      error: { message: e.message, code: e.code, errcode: e.errcode, errstr: e.errstr },
    };
  }
  let bytes = encoder.encode(JSON.stringify(res, replacer));
  if (bytes.length > data.length) {
    bytes = encoder.encode(JSON.stringify({
      ok: false,
      error: { message: 'worker sqlite: response of ' + bytes.length + ' bytes exceeds the shared buffer' },
    }));
  }
  data.set(bytes);
  ctrl[${CTRL_LEN}] = bytes.length;
  Atomics.store(ctrl, ${CTRL_RES}, seq);
  Atomics.notify(ctrl, ${CTRL_RES});
  if (req.op === 'close') break;
}
`;

function toWire(value: SqlInput): WireParam {
  if (typeof value === 'bigint') return { __bigint: value.toString() };
  if (value instanceof Uint8Array) return { __u8: Array.from(value) };
  return value;
}

export class WorkerSqliteError extends Error {
  code?: string;
  errcode?: number;
  errstr?: string;
}

/** Synchronous `DatabaseSync` look-alike whose engine lives on a worker. */
export class WorkerDatabaseSync {
  private readonly ctrl: Int32Array;
  private readonly data: Uint8Array;
  private readonly worker: WorkerLike;
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private seq = 0;
  private closed = false;

  constructor(path: string) {
    const { Worker } = require('worker_threads') as WorkerThreadsModule;
    const ctrlBuffer = new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT);
    const dataBuffer = new SharedArrayBuffer(DATA_BYTES);
    this.ctrl = new Int32Array(ctrlBuffer);
    this.data = new Uint8Array(dataBuffer);
    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      execArgv: ['--experimental-sqlite'],
      workerData: { ctrl: ctrlBuffer, data: dataBuffer, path },
    });
    this.worker.unref();
    // Fail fast (with the worker's own error) if the engine cannot start.
    this.call({ op: 'exec', sql: 'SELECT 1' });
  }

  private call(request: Request): Response {
    if (this.closed) {
      throw new WorkerSqliteError('worker sqlite: database is closed');
    }
    const bytes = this.encoder.encode(JSON.stringify(request));
    if (bytes.length > this.data.length) {
      throw new WorkerSqliteError(
        `worker sqlite: request of ${bytes.length} bytes exceeds the shared buffer`,
      );
    }
    this.data.set(bytes);
    this.ctrl[CTRL_LEN] = bytes.length;
    const seq = ++this.seq;
    Atomics.store(this.ctrl, CTRL_REQ, seq);
    Atomics.notify(this.ctrl, CTRL_REQ);
    const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
    while (Atomics.load(this.ctrl, CTRL_RES) !== seq) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new WorkerSqliteError(
          `worker sqlite: no response within ${RESPONSE_TIMEOUT_MS}ms ` +
            `(does this Node build ship node:sqlite? ${process.version})`,
        );
      }
      Atomics.wait(this.ctrl, CTRL_RES, seq - 1, remaining);
    }
    const text = this.decoder.decode(
      this.data.subarray(0, this.ctrl[CTRL_LEN]),
    );
    return JSON.parse(text) as Response;
  }

  private unwrap(response: Response): Extract<Response, { ok: true }> {
    if (response.ok) return response;
    const error = new WorkerSqliteError(response.error.message);
    error.code = response.error.code;
    error.errcode = response.error.errcode;
    error.errstr = response.error.errstr;
    throw error;
  }

  exec(sql: string): void {
    this.unwrap(this.call({ op: 'exec', sql }));
  }

  prepare(sql: string): {
    all(...params: SqlInput[]): unknown[];
    run(...params: SqlInput[]): { changes: number };
  } {
    return {
      all: (...params) =>
        this.unwrap(this.call({ op: 'all', sql, params: params.map(toWire) }))
          .rows ?? [],
      run: (...params) => ({
        changes:
          this.unwrap(this.call({ op: 'run', sql, params: params.map(toWire) }))
            .changes ?? 0,
      }),
    };
  }

  close(): void {
    if (this.closed) return;
    try {
      this.unwrap(this.call({ op: 'close' }));
    } finally {
      this.closed = true;
      void this.worker.terminate();
    }
  }
}
