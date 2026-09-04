/// <reference types="node" />
/**
 * XC journey harness — a REAL SQLite engine behind the `@op-engineering/op-sqlite`
 * seam so `src/data/db.ts` (migrations included), the repository layer, the
 * outbox and every screen's evidence loader run against durable rows instead
 * of a recording stub.
 *
 * Engine: Node's built-in `node:sqlite`, hosted in a worker thread and driven
 * synchronously (Atomics.wait + receiveMessageOnPort). The worker exists for
 * one reason: `node:sqlite` is flag-gated on Node 22.5–22.12
 * (`--experimental-sqlite`) and Jest cannot add flags to its own process —
 * a worker CAN carry its own execArgv, so the canonical
 * `npx jest --ci --silent` works on every Node this repo supports.
 *
 * Only the op-sqlite surface `src/data/db.ts` touches is implemented:
 * `open()`, `executeSync()`, `execute()`, `close()`. Statement-level fault
 * injection lets a scenario make targeted statements throw (e.g. the
 * analysis-record insert) to prove the screens recover from storage failure.
 */
import {
  MessageChannel,
  Worker,
  receiveMessageOnPort,
  type MessagePort,
} from 'node:worker_threads';

export interface SqliteFault {
  /** Substring the statement must contain to trigger. */
  match: string;
  /** How many matching statements throw before the fault clears. */
  remaining: number;
  error: () => Error;
}

export interface SqliteJournalEntry {
  sql: string;
  params: unknown[];
  sync: boolean;
  ok: boolean;
  rows: number;
  error?: string;
}

interface Registry {
  faults: SqliteFault[];
  journal: SqliteJournalEntry[];
  opened: number;
}

const registry: Registry = { faults: [], journal: [], opened: 0 };

export function injectSqliteFault(fault: SqliteFault): void {
  registry.faults.push(fault);
}

export function clearSqliteFaults(): void {
  registry.faults.length = 0;
}

export function sqliteJournal(): readonly SqliteJournalEntry[] {
  return registry.journal;
}

export function resetSqliteJournal(): void {
  registry.journal.length = 0;
}

export function sqliteOpenCount(): number {
  return registry.opened;
}

type SqlValue = null | number | string | Uint8Array;

function bind(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Uint8Array) return value;
  return JSON.stringify(value);
}

function takeFault(sql: string): Error | null {
  for (let i = 0; i < registry.faults.length; i += 1) {
    const fault = registry.faults[i];
    if (fault && sql.includes(fault.match)) {
      fault.remaining -= 1;
      if (fault.remaining <= 0) registry.faults.splice(i, 1);
      return fault.error();
    }
  }
  return null;
}

// ─── Worker-hosted engine ────────────────────────────────────────────────────

type BridgeRequest =
  | { op: 'open'; id: number }
  | { op: 'close'; id: number }
  | { op: 'exec'; id: number; sql: string; params: SqlValue[] };

type BridgeReply =
  | { ok: true; rows: Record<string, unknown>[]; changes: number }
  | { ok: false; message: string };

const WORKER_SOURCE = `
const { DatabaseSync } = require('node:sqlite');
const { workerData } = require('node:worker_threads');
const port = workerData.port;
const signal = new Int32Array(workerData.signal);
const dbs = new Map();
port.on('message', (msg) => {
  let reply;
  try {
    if (msg.op === 'open') {
      dbs.set(msg.id, new DatabaseSync(':memory:'));
      reply = { ok: true, rows: [], changes: 0 };
    } else if (msg.op === 'close') {
      const db = dbs.get(msg.id);
      if (db) db.close();
      dbs.delete(msg.id);
      reply = { ok: true, rows: [], changes: 0 };
    } else {
      const db = dbs.get(msg.id);
      if (!db) throw new Error('sqlite bridge: database ' + msg.id + ' is closed');
      // all() steps every statement kind to completion (DML yields []), so
      // one path serves SELECT/PRAGMA and writes alike.
      const rows = db.prepare(msg.sql).all(...msg.params);
      const changed = db.prepare('SELECT changes() AS c').get();
      reply = { ok: true, rows, changes: Number(changed ? changed.c : 0) };
    }
  } catch (error) {
    reply = { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  port.postMessage(reply);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
});
`;

interface Bridge {
  worker: Worker;
  port: MessagePort;
  signal: Int32Array;
}

let bridge: Bridge | null = null;
let nextDbId = 1;

/** `node:sqlite` needs `--experimental-sqlite` before 22.13 / 23.4. */
export function sqliteExecArgv(
  nodeVersion: string = process.versions.node,
): string[] {
  const [major = 0, minor = 0] = nodeVersion.split('.').map(Number);
  const unflagged =
    major >= 24 ||
    (major === 23 && minor >= 4) ||
    (major === 22 && minor >= 13);
  return unflagged ? [] : ['--experimental-sqlite'];
}

function openBridge(): Bridge {
  if (bridge) return bridge;
  const channel = new MessageChannel();
  const shared = new SharedArrayBuffer(4);
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    execArgv: sqliteExecArgv(),
    workerData: { port: channel.port2, signal: shared },
    transferList: [channel.port2],
  });
  worker.unref();
  channel.port1.unref();
  bridge = { worker, port: channel.port1, signal: new Int32Array(shared) };
  return bridge;
}

const BRIDGE_TIMEOUT_MS = 30_000;

function callSync(request: BridgeRequest): BridgeReply {
  const active = openBridge();
  Atomics.store(active.signal, 0, 0);
  active.port.postMessage(request);
  const waited = Atomics.wait(active.signal, 0, 0, BRIDGE_TIMEOUT_MS);
  if (waited === 'timed-out') {
    throw new Error(
      `sqlite bridge: no reply within ${BRIDGE_TIMEOUT_MS}ms for ${request.op}`,
    );
  }
  const received = receiveMessageOnPort(active.port);
  if (!received) {
    throw new Error('sqlite bridge: signalled without a message');
  }
  return received.message as BridgeReply;
}

/** Terminates the engine thread (call from afterAll). */
export async function shutdownSqliteBridge(): Promise<void> {
  if (!bridge) return;
  const active = bridge;
  bridge = null;
  active.port.close();
  await active.worker.terminate();
}

/** Minimal op-sqlite `DB` shape used by src/data/db.ts. */
export interface NodeBackedDb {
  executeSync(
    sql: string,
    params?: unknown[],
  ): { rows: Record<string, unknown>[]; rowsAffected: number };
  execute(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowsAffected: number }>;
  close(): void;
}

export function createNodeBackedDb(): NodeBackedDb {
  const id = nextDbId;
  nextDbId += 1;
  const opened = callSync({ op: 'open', id });
  if (!opened.ok) throw new Error(opened.message);
  registry.opened += 1;
  const run = (sql: string, params: unknown[], sync: boolean) => {
    const entry: SqliteJournalEntry = { sql, params, sync, ok: true, rows: 0 };
    registry.journal.push(entry);
    const fault = takeFault(sql);
    if (fault) {
      entry.ok = false;
      entry.error = fault.message;
      throw fault;
    }
    const reply = callSync({ op: 'exec', id, sql, params: params.map(bind) });
    if (!reply.ok) {
      entry.ok = false;
      entry.error = reply.message;
      throw new Error(reply.message);
    }
    entry.rows = reply.rows.length;
    return { rows: reply.rows, rowsAffected: reply.changes };
  };
  return {
    executeSync: (sql, params = []) => run(sql, params, true),
    execute: async (sql, params = []) => run(sql, params, false),
    close: () => {
      callSync({ op: 'close', id });
    },
  };
}

/** Drop-in for `jest.mock('@op-engineering/op-sqlite', ...)`. */
export const opSqliteMockModule = {
  open: (_options: { name: string }) => createNodeBackedDb(),
};
