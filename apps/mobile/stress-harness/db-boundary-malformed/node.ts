/**
 * Typed access to the Node built-ins the db boundary/malformed stress harness
 * drives. apps/mobile types only `jest` (no @types/node), so the exact surface
 * used is declared here and resolved through `require` at call time.
 */
declare const require: (id: string) => unknown;
declare const process: NodeProcess;

export interface NodeProcess {
  env: Record<string, string | undefined>;
  version: string;
  cwd(): string;
  getuid?: () => number;
}

export const nodeProcess: NodeProcess = process;

export interface NodeFs {
  mkdirSync(dir: string, options?: { recursive?: boolean }): void;
  rmSync(
    target: string,
    options?: { recursive?: boolean; force?: boolean },
  ): void;
  writeFileSync(file: string, data: string | Uint8Array): void;
  readFileSync(file: string): Uint8Array;
  existsSync(target: string): boolean;
  chmodSync(target: string, mode: number): void;
  mkdtempSync(prefix: string): string;
}

export interface NodePath {
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
}

export interface NodeOs {
  tmpdir(): string;
}

export interface NodeCrypto {
  createHash(algorithm: string): {
    update(data: Uint8Array | string): { digest(encoding: 'hex'): string };
  };
}

export type SqlInputValue = null | number | bigint | string | Uint8Array;

export interface SqliteStatementSync {
  all(...params: SqlInputValue[]): Record<string, unknown>[];
  get(...params: SqlInputValue[]): Record<string, unknown> | undefined;
  run(...params: SqlInputValue[]): unknown;
}

export interface SqliteDatabaseSync {
  prepare(sql: string): SqliteStatementSync;
  exec(sql: string): void;
  close(): void;
}

export interface NodeSqlite {
  DatabaseSync: new (
    location: string,
    options?: { timeout?: number },
  ) => SqliteDatabaseSync;
}

export const fs = require('node:fs') as NodeFs;
export const path = require('node:path') as NodePath;
export const os = require('node:os') as NodeOs;
export const crypto = require('node:crypto') as NodeCrypto;

/**
 * Opens a DatabaseSync and pins every StatementSync it prepares until
 * `close()`. Node 22.23's `DatabaseSync.close()` finalizes statements it
 * still tracks; a statement the GC already collected is a use-after-free
 * there (SIGSEGV in sqlite3_finalize, observed under long jest campaigns),
 * so the harness never lets a statement die before its connection.
 */
export function openSqlite(
  sqlite: NodeSqlite,
  location: string,
  options?: { timeout?: number },
): SqliteDatabaseSync {
  const db = options
    ? new sqlite.DatabaseSync(location, options)
    : new sqlite.DatabaseSync(location);
  const pinned: SqliteStatementSync[] = [];
  return {
    prepare(sql: string): SqliteStatementSync {
      const statement = db.prepare(sql);
      pinned.push(statement);
      return statement;
    },
    exec(sql: string): void {
      db.exec(sql);
    },
    close(): void {
      db.close();
      pinned.length = 0;
    },
  };
}

/** `node:sqlite` needs Node >= 22.13 (flag-gated on 22.5–22.12). */
export function loadNodeSqlite(): NodeSqlite | null {
  try {
    return require('node:sqlite') as NodeSqlite;
  } catch {
    return null;
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex.toUpperCase();
}
