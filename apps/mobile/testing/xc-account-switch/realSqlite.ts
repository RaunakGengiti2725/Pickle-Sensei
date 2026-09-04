/**
 * A REAL SQLite engine behind the `@op-engineering/op-sqlite` `open()` seam,
 * so `src/data/db.ts` runs its actual migrations and `src/data/repository.ts`
 * runs its actual SQL against real tables, primary keys and indexes — not a
 * hand-written fake that records parameters.
 *
 * Engine: Node's built-in `node:sqlite` (SQLite 3.47 on the Node 22 line the
 * mobile CI uses). On Node ≥ 22.13 it is available unflagged in-process; on
 * 22.12 (this repo's pinned toolchain) it needs `--experimental-sqlite`, which
 * a Jest worker cannot be given after the fact. The fallback runs the engine
 * in a `worker_threads` Worker started WITH the flag and bridges every call
 * synchronously over a SharedArrayBuffer + MessagePort — the only way to keep
 * `executeSync` (used by the migration path) genuinely synchronous.
 *
 * Nothing here touches the device, the network or the hosted platform: every
 * database is `:memory:` and dies with the test process.
 */

/// <reference types="node" />
import { createRequire } from 'node:module';
import {
  MessageChannel,
  Worker,
  receiveMessageOnPort,
  type MessagePort as BridgePort,
} from 'node:worker_threads';

export type SqlRow = Record<string, unknown>;

export interface RealSqliteHandle {
  /** Synchronous — op-sqlite's `DB.executeSync` shape used by migrations. */
  executeSync(sql: string, params?: unknown[]): { rows: SqlRow[] };
  /** Asynchronous — op-sqlite's `DB.execute` shape used by `LocalDb`. */
  execute(sql: string, params?: unknown[]): Promise<{ rows: SqlRow[] }>;
  close(): void;
  /** Which engine path served this handle (recorded in evidence). */
  readonly engine: 'in-process' | 'worker-bridge';
  /** Raw, owner-agnostic read used ONLY by the harness to inspect the
   * physical table state (the code under test never sees this). */
  dumpTable(table: string): SqlRow[];
  /** Every statement executed, in order (for evidence / replay). */
  readonly statementLog: Array<{ sql: string; params: unknown[] }>;
}

interface SqliteBinding {
  all(sql: string, params: unknown[]): SqlRow[];
  close(): void;
}

function bindable(params: unknown[]): unknown[] {
  // op-sqlite binds booleans/undefined; node:sqlite refuses them. The
  // repository never relies on either, but a mismatch here would surface as
  // a bogus "isolation" failure, so normalise exactly like a SQLite driver.
  return params.map(value => {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
  });
}

interface NodeSqliteModule {
  DatabaseSync: new (location: string) => {
    prepare(sql: string): { all(...params: unknown[]): unknown[] };
    close(): void;
  };
}

function tryInProcess(): SqliteBinding | null {
  try {
    // Bypass Jest's module registry: `node:sqlite` is absent from
    // `module.builtinModules` on 22.x even when the flag is on, so Jest's
    // resolver would try (and fail) to find it on disk.
    const nativeRequire = createRequire(__filename);
    const { DatabaseSync } = nativeRequire('node:sqlite') as NodeSqliteModule;
    const db = new DatabaseSync(':memory:');
    return {
      all(sql, params) {
        return db.prepare(sql).all(...bindable(params)) as SqlRow[];
      },
      close() {
        db.close();
      },
    };
  } catch {
    return null;
  }
}

const WORKER_SOURCE = `
const { workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(':memory:');
const { port, signal } = workerData;
const reply = (message) => {
  port.postMessage(message);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
};
port.on('message', (msg) => {
  try {
    if (msg.op === 'close') {
      db.close();
      reply({ ok: true, rows: [] });
      return;
    }
    const rows = db.prepare(msg.sql).all(...msg.params);
    reply({ ok: true, rows: rows.map((row) => ({ ...row })) });
  } catch (error) {
    reply({ ok: false, error: String((error && error.message) || error) });
  }
});
reply({ ok: true, rows: [] });
`;

const BRIDGE_TIMEOUT_MS = 20_000;

function startWorkerBridge(): SqliteBinding {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    execArgv: ['--experimental-sqlite', '--no-warnings'],
    workerData: { port: port2, signal },
    transferList: [port2],
  });
  let workerError: unknown = null;
  worker.on('error', (error: unknown) => {
    workerError = error;
  });
  worker.unref();

  const awaitReply = (port: BridgePort): SqlRow[] => {
    const outcome = Atomics.wait(signal, 0, 0, BRIDGE_TIMEOUT_MS);
    if (outcome === 'timed-out') {
      throw new Error(
        `real-sqlite worker bridge timed out${
          workerError ? `: ${String(workerError)}` : ''
        }`,
      );
    }
    const received = receiveMessageOnPort(port);
    if (!received) throw new Error('real-sqlite worker bridge: empty reply');
    const message = received.message as
      { ok: true; rows: SqlRow[] } | { ok: false; error: string };
    if (!message.ok) throw new Error(message.error);
    return message.rows;
  };

  // Ready handshake: the worker posts once its engine is open.
  awaitReply(port1);

  return {
    all(sql, params) {
      Atomics.store(signal, 0, 0);
      port1.postMessage({ sql, params: bindable(params) });
      return awaitReply(port1);
    },
    close() {
      Atomics.store(signal, 0, 0);
      port1.postMessage({ op: 'close' });
      try {
        awaitReply(port1);
      } finally {
        void worker.terminate();
        port1.close();
      }
    },
  };
}

export function openRealSqlite(): RealSqliteHandle {
  const inProcess = tryInProcess();
  const binding = inProcess ?? startWorkerBridge();
  const engine = inProcess ? 'in-process' : 'worker-bridge';
  const statementLog: Array<{ sql: string; params: unknown[] }> = [];
  let closed = false;
  const run = (sql: string, params: unknown[]): { rows: SqlRow[] } => {
    if (closed) throw new Error('real-sqlite handle is closed');
    statementLog.push({ sql, params });
    return { rows: binding.all(sql, params) };
  };
  return {
    engine,
    statementLog,
    executeSync(sql, params = []) {
      return run(sql, params);
    },
    async execute(sql, params = []) {
      return run(sql, params);
    },
    close() {
      if (closed) return;
      closed = true;
      binding.close();
    },
    dumpTable(table) {
      if (!/^[a-z_]+$/.test(table)) throw new Error(`bad table ${table}`);
      return binding.all(`SELECT * FROM ${table} ORDER BY rowid`, []);
    },
  };
}
