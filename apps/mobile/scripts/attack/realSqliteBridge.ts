/**
 * Synchronous REAL SQLite for jest, driven over two FIFOs into a
 * `python3 sqlite3` process (sqlite_bridge.py next to this file).
 *
 * Shape-compatible with the subset of `@op-engineering/op-sqlite`'s `DB`
 * that src/data/db.ts uses (`executeSync`, `execute`, `close`), so a test can
 * `jest.mock('@op-engineering/op-sqlite', () => ({ open: () => bridge }))`
 * and run the app's real migrations + repository SQL against a real database
 * file instead of a hand-written fake.
 *
 * The connection is in autocommit mode: BEGIN / COMMIT / ROLLBACK issued by
 * the code under test are the only transaction boundaries.
 */
// apps/mobile's tsconfig has no node types; typed require()s follow the
// pattern of __tests__/importedRealFootageAnalysis.test.ts.
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const Buffer: {
  alloc: (size: number) => BridgeBuffer;
};
interface BridgeBuffer {
  readonly length: number;
  toString: (encoding: 'utf8', start: number, end: number) => string;
}
interface ChildProcess {
  kill: () => boolean;
}
const { execFileSync, spawn } = require('child_process') as {
  execFileSync: (file: string, args: string[]) => unknown;
  spawn: (
    file: string,
    args: string[],
    options: { stdio: [string, string, string] },
  ) => ChildProcess;
};
const fs = require('fs') as {
  mkdtempSync: (prefix: string) => string;
  openSync: (file: string, flags: 'r' | 'w') => number;
  readSync: (
    fd: number,
    buffer: BridgeBuffer,
    offset: number,
    length: number,
    position: null,
  ) => number;
  writeSync: (fd: number, data: string) => number;
  closeSync: (fd: number) => void;
  rmSync: (
    file: string,
    options: { recursive: boolean; force: boolean },
  ) => void;
  mkdirSync: (dir: string, options: { recursive: boolean }) => void;
  writeFileSync: (file: string, data: string) => void;
  existsSync: (file: string) => boolean;
};
const os = require('os') as { tmpdir: () => string };
const path = require('path') as {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
};

export type BridgeRow = Record<string, unknown>;
type BridgeReply =
  | { ok: true; rows?: BridgeRow[]; hello?: string }
  | { ok: false; error: string };

export interface RealSqliteHooks {
  /** Called before every statement; throw to inject a failure. */
  beforeExecute?: (sql: string, params: unknown[]) => void;
}

export class RealSqlite {
  readonly dir: string;
  readonly dbPath: string;
  readonly sqliteVersion: string;
  /** Every SQL string executed, in order (including failed ones). */
  readonly log: string[] = [];
  hooks: RealSqliteHooks = {};
  private readonly child: ChildProcess;
  private readonly reqFd: number;
  private readonly resFd: number;
  private buffer = '';
  private disposed = false;

  constructor(label: string) {
    this.dir = fs.mkdtempSync(
      path.join(os.tmpdir(), `attack-sqlite-${label}-`),
    );
    this.dbPath = path.join(this.dir, 'pickle-sensei.db');
    const reqPath = path.join(this.dir, 'req.fifo');
    const resPath = path.join(this.dir, 'res.fifo');
    execFileSync('mkfifo', [reqPath, resPath]);
    this.child = spawn(
      'python3',
      [path.join(__dirname, 'sqlite_bridge.py'), this.dbPath, reqPath, resPath],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
    this.reqFd = fs.openSync(reqPath, 'w');
    this.resFd = fs.openSync(resPath, 'r');
    const hello = this.readReply();
    if (!hello.ok || typeof hello.hello !== 'string') {
      throw new Error(`bridge handshake failed: ${JSON.stringify(hello)}`);
    }
    this.sqliteVersion = hello.hello;
  }

  private readReply(): BridgeReply {
    const chunk = Buffer.alloc(1 << 20);
    for (;;) {
      const nl = this.buffer.indexOf('\n');
      if (nl >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        return JSON.parse(line) as BridgeReply;
      }
      const n = fs.readSync(this.resFd, chunk, 0, chunk.length, null);
      if (n === 0) throw new Error('bridge closed');
      this.buffer += chunk.toString('utf8', 0, n);
    }
  }

  private send(msg: unknown): BridgeReply {
    fs.writeSync(this.reqFd, `${JSON.stringify(msg)}\n`);
    return this.readReply();
  }

  /** IEEE specials travel as tagged objects (JSON has no NaN/Infinity) and
   * are bound as doubles on the python side — like a native driver would. */
  private static encodeParam(value: unknown): unknown {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      if (Number.isNaN(value)) return { $float: 'nan' };
      return { $float: value > 0 ? 'inf' : '-inf' };
    }
    return value;
  }

  private static decodeValue(value: unknown): unknown {
    if (value && typeof value === 'object' && '$float' in value) {
      const tag = (value as { $float: string }).$float;
      return tag === 'nan' ? NaN : tag === 'inf' ? Infinity : -Infinity;
    }
    return value;
  }

  executeSync(sql: string, params: unknown[] = []): { rows: BridgeRow[] } {
    this.log.push(sql);
    this.hooks.beforeExecute?.(sql, params);
    const reply = this.send({
      op: 'exec',
      sql,
      params: params.map(RealSqlite.encodeParam),
    });
    if (!reply.ok) {
      throw new Error(reply.error);
    }
    const rows = (reply.rows ?? []).map(row =>
      Object.fromEntries(
        Object.entries(row).map(([k, v]) => [k, RealSqlite.decodeValue(v)]),
      ),
    );
    return { rows };
  }

  async execute(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: BridgeRow[] }> {
    return this.executeSync(sql, params);
  }

  /** db.ts calls close() on migration failure / getDb().close(); the process
   * stays alive so the test can still inspect the file — see dispose(). */
  close(): void {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.send({ op: 'close' });
    } catch {
      // already gone
    }
    fs.closeSync(this.reqFd);
    fs.closeSync(this.resFd);
    this.child.kill();
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

/** Shared artifact directory for the adversarial data-sync suites. */
export const ATTACK_ARTIFACT_DIR = path.resolve(
  __dirname,
  '../../../../artifacts/attack/mobile-data-sync-2',
);

export function writeAttackArtifact(name: string, data: unknown): string {
  fs.mkdirSync(ATTACK_ARTIFACT_DIR, { recursive: true });
  const file = path.join(ATTACK_ARTIFACT_DIR, name);
  fs.writeFileSync(
    file,
    JSON.stringify(
      data,
      (_key, value: unknown) =>
        typeof value === 'number' && !Number.isFinite(value)
          ? String(value)
          : value,
      2,
    ),
  );
  return file;
}

export function attackArtifactExists(file: string): boolean {
  return fs.existsSync(file);
}
