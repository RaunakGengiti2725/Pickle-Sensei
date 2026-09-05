import type { LocalDb } from '../../../src/data/db';

/**
 * In-memory LocalDb whose every statement completes after a scheduled,
 * seed-derived latency (fake-timer `setTimeout`), so the harness can
 * interleave a HomeScreen load with unmounts, account switches, token
 * rotations and relaunches at deterministic points. Understands exactly the
 * statements the Home surface and the owner-scoped stores issue: kv reads and
 * writes, owner-scoped `local_shot` reads with ORDER BY / LIMIT. Any statement
 * class can be faulted (simulated SQLITE_IOERR) or held open indefinitely.
 */

export interface StressShotSeed {
  ownerKey: string;
  id: string;
  sessionId: string | null;
  shotType: string;
  capturedAt: string;
  overallScore: number | null;
  confidence: number;
  resultKind: string;
  source: string;
  favorite: number;
  payload: string;
}

export type StatementKind =
  'kv-get' | 'kv-set' | 'shots' | 'other' | 'transaction';

export interface StatementRecord {
  seq: number;
  kind: StatementKind;
  sql: string;
  params: unknown[];
  /** fake-clock ms when the statement was issued */
  issuedAt: number;
  /** fake-clock ms when it settled (resolved or rejected) */
  settledAt: number | null;
  /** active data owner at issue time */
  ownerAtIssue: string;
  /** owner row scope the statement targeted (WHERE owner_key = ?), if any */
  ownerParam: string | null;
  outcome: 'pending' | 'ok' | 'fault' | 'released' | 'killed';
  /** process generation (bumped on kill/relaunch) that issued it */
  proc: number;
}

export interface DbFaults {
  openThrows?: boolean;
  /** owner-scoped local_shot reads throw */
  shotsThrow?: boolean;
  /** kv reads of these keys throw */
  kvGetThrows?: Set<string>;
  /** kv writes of these keys throw */
  kvSetThrows?: Set<string>;
}

export interface LatencyPolicy {
  /** ms a statement of this kind takes; may return Infinity to hold it */
  (kind: StatementKind, record: StatementRecord): number;
}

export class GatedLocalDb {
  readonly kv = new Map<string, string>();
  readonly shots: StressShotSeed[] = [];
  readonly statements: StatementRecord[] = [];
  faults: DbFaults = {};
  latency: LatencyPolicy = () => 0;
  proc = 0;
  private seq = 0;
  /** statements held with Infinity latency, releasable by the scheduler */
  private held: { record: StatementRecord; release: () => void }[] = [];
  /** fake-timer handles of in-flight delayed statements (dropped on kill) */
  private inflight = new Map<
    number,
    { record: StatementRecord; timer: ReturnType<typeof setTimeout> }
  >();

  /** `ownerAt` reads the app's active data owner of the CURRENT process. */
  constructor(private readonly ownerAt: () => string = () => 'unknown') {}

  /** Every `kv` write in issue order. */
  kvWrites(): { key: string; value: string; at: number; owner: string }[] {
    return this.statements
      .filter(s => s.kind === 'kv-set' && s.outcome === 'ok')
      .map(s => ({
        key: String(s.params[0]),
        value: String(s.params[1]),
        at: s.issuedAt,
        owner: s.ownerAtIssue,
      }));
  }

  destructiveStatements(): string[] {
    return this.statements
      .map(s => s.sql)
      .filter(
        sql =>
          /^(DELETE|DROP|UPDATE|ALTER|TRUNCATE)\b/i.test(sql) ||
          /INTO\s+local_shot\b/i.test(sql),
      );
  }

  shotFingerprint(): string {
    return JSON.stringify(
      [...this.shots]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map(shot => [shot.ownerKey, shot.id, shot.payload]),
    );
  }

  pendingCount(): number {
    return this.statements.filter(s => s.outcome === 'pending').length;
  }

  /** Release every statement currently held open (a "slow disk" catching up). */
  releaseHeld(): number {
    const count = this.held.length;
    for (const entry of this.held.splice(0)) entry.release();
    return count;
  }

  /**
   * The OS killed the process: every statement still in flight dies with it
   * (its promise never settles — nobody is left to observe it). Persisted
   * rows survive. Returns how many statements were dropped.
   */
  kill(): number {
    let dropped = 0;
    for (const entry of this.inflight.values()) {
      clearTimeout(entry.timer);
      entry.record.outcome = 'killed';
      entry.record.settledAt = Date.now();
      dropped += 1;
    }
    this.inflight.clear();
    for (const entry of this.held) {
      entry.record.outcome = 'killed';
      entry.record.settledAt = Date.now();
      dropped += 1;
    }
    this.held = [];
    this.proc += 1;
    return dropped;
  }

  addShot(seed: StressShotSeed): void {
    const index = this.shots.findIndex(
      s => s.ownerKey === seed.ownerKey && s.id === seed.id,
    );
    if (index >= 0) this.shots[index] = seed;
    else this.shots.push(seed);
  }

  handle(): LocalDb {
    if (this.faults.openThrows) {
      throw new Error('Local database could not be opened (simulated).');
    }
    return {
      execute: async (sql: string, params: unknown[] = []) =>
        this.execute(sql, params),
      close: () => {},
    };
  }

  private classify(statement: string): StatementKind {
    if (statement.startsWith('SELECT value FROM kv')) return 'kv-get';
    if (statement.startsWith('INSERT OR REPLACE INTO kv')) return 'kv-set';
    if (/FROM local_shot WHERE owner_key = \?/.test(statement)) return 'shots';
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(statement)) return 'transaction';
    return 'other';
  }

  private async execute(
    sql: string,
    params: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }> {
    const statement = sql.trim().replace(/\s+/g, ' ');
    const kind = this.classify(statement);
    this.seq += 1;
    const record: StatementRecord = {
      seq: this.seq,
      kind,
      sql: statement,
      params,
      issuedAt: Date.now(),
      settledAt: null,
      ownerAtIssue: this.ownerAt(),
      ownerParam:
        /WHERE owner_key = \?/.test(statement) && typeof params[0] === 'string'
          ? params[0]
          : null,
      outcome: 'pending',
      proc: this.proc,
    };
    this.statements.push(record);
    const wait = this.latency(kind, record);
    if (wait === Infinity) {
      await new Promise<void>(resolve => {
        this.held.push({
          record,
          release: () => {
            record.outcome = 'released';
            resolve();
          },
        });
      });
    } else if (wait > 0) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          this.inflight.delete(record.seq);
          resolve();
        }, wait);
        this.inflight.set(record.seq, { record, timer });
      });
    }
    try {
      const rows = this.answer(kind, statement, params);
      if (record.outcome === 'pending') record.outcome = 'ok';
      return { rows };
    } catch (error) {
      record.outcome = 'fault';
      throw error;
    } finally {
      record.settledAt = Date.now();
    }
  }

  private answer(
    kind: StatementKind,
    statement: string,
    params: unknown[],
  ): Record<string, unknown>[] {
    switch (kind) {
      case 'kv-get': {
        const key = String(params[0]);
        if (this.faults.kvGetThrows?.has(key)) {
          throw new Error(`SQLITE_IOERR (simulated) reading kv ${key}`);
        }
        const value = this.kv.get(key);
        return value === undefined ? [] : [{ value }];
      }
      case 'kv-set': {
        const key = String(params[0]);
        if (this.faults.kvSetThrows?.has(key)) {
          throw new Error(`SQLITE_IOERR (simulated) writing kv ${key}`);
        }
        this.kv.set(key, String(params[1]));
        return [];
      }
      case 'shots': {
        if (this.faults.shotsThrow) {
          throw new Error('SQLITE_IOERR (simulated) reading local_shot');
        }
        const owner = String(params[0]);
        let rows = this.shots
          .filter(shot => shot.ownerKey === owner)
          .filter(
            shot =>
              !/source = 'real'/.test(statement) || shot.source === 'real',
          );
        if (/ORDER BY captured_at DESC/.test(statement)) {
          rows = [...rows].sort((a, b) =>
            a.capturedAt < b.capturedAt
              ? 1
              : a.capturedAt > b.capturedAt
                ? -1
                : 0,
          );
        } else if (/ORDER BY captured_at ASC/.test(statement)) {
          rows = [...rows].sort((a, b) =>
            a.capturedAt < b.capturedAt
              ? -1
              : a.capturedAt > b.capturedAt
                ? 1
                : 0,
          );
        }
        if (/LIMIT \?$/.test(statement)) {
          const limit = Number(params[params.length - 1]);
          if (Number.isFinite(limit)) rows = rows.slice(0, limit);
        }
        return rows.map(shot => ({
          id: shot.id,
          session_id: shot.sessionId,
          shot_type: shot.shotType,
          captured_at: shot.capturedAt,
          overall_score: shot.overallScore,
          confidence: shot.confidence,
          result_kind: shot.resultKind,
          source: shot.source,
          favorite: shot.favorite,
          payload: shot.payload,
        }));
      }
      case 'transaction':
      case 'other':
        return [];
    }
  }
}
