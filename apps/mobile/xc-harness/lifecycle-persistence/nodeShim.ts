/**
 * Minimal typed access to the Node built-ins the matrix harnesses need.
 *
 * apps/mobile's tsconfig deliberately types only `jest` (no @types/node) so
 * app code cannot lean on Node APIs; tests that need them declare the exact
 * surface they use (see __tests__/wf/be-mobile-security-secrets.test.ts).
 * Everything here is resolved lazily through `require` at call time so a
 * built-in that is missing on this Node (node:sqlite behind a flag) turns
 * into a `null`, never a module-load crash.
 */
declare const require: (id: string) => unknown;
declare const process: NodeProcess;

export interface NodeProcess {
  env: Record<string, string | undefined>;
  version: string;
  execPath: string;
  platform: string;
  memoryUsage(): {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
  };
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
  readFileSync(file: string, encoding: 'utf8'): string;
  existsSync(target: string): boolean;
  chmodSync(target: string, mode: number): void;
}

export interface NodePath {
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
}

export interface NodeOs {
  tmpdir(): string;
}

export interface SpawnSyncResult {
  status: number | null;
  stdout: string | null;
  stderr: string | null;
}

export interface NodeChildProcess {
  spawnSync(
    command: string,
    args: string[],
    options: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      encoding: 'utf8';
      maxBuffer?: number;
    },
  ): SpawnSyncResult;
}

export type SqlInputValue = null | number | bigint | string | Uint8Array;

export interface SqliteStatementSync {
  all(...params: SqlInputValue[]): unknown[];
  get(...params: SqlInputValue[]): unknown;
  run(...params: SqlInputValue[]): unknown;
}

export interface SqliteDatabaseSync {
  prepare(sql: string): SqliteStatementSync;
  exec(sql: string): void;
  close(): void;
}

export interface NodeSqlite {
  DatabaseSync: new (location: string) => SqliteDatabaseSync;
}

export const fs = require('node:fs') as NodeFs;
export const path = require('node:path') as NodePath;
export const os = require('node:os') as NodeOs;
export const childProcess = require('node:child_process') as NodeChildProcess;

/** `node:sqlite` is flag-gated on Node 22.5–22.12 (`--experimental-sqlite`). */
export function loadNodeSqlite(): NodeSqlite | null {
  try {
    return require('node:sqlite') as NodeSqlite;
  } catch {
    return null;
  }
}

/** Absolute path of a module given its `require.resolve`-able id. */
export function resolveModule(id: string): string {
  const resolver = (
    require as unknown as { resolve: (specifier: string) => string }
  ).resolve;
  return resolver(id);
}
