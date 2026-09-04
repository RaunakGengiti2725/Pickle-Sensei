import type { LocalDb } from '../../src/data/db';

/**
 * Fault-injectable in-memory LocalDb for the mocked-store matrix.
 *
 * Understands exactly the statements the stores issue at launch (kv reads and
 * writes, owner-scoped local_shot reads) and records EVERY statement so the
 * suite can prove hydrate() never deleted or rewrote product rows. Any
 * statement can be made to throw (a simulated SQLITE_IOERR / SQLITE_BUSY) by
 * key or by SQL pattern, and the whole database can be made unopenable.
 */

export interface LocalShotSeed {
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

export interface DbFaults {
  /** getDb() itself throws (open / migration failure). */
  openThrows?: string | null;
  /** kv reads of these keys throw. */
  kvGetThrows?: Set<string>;
  /** kv writes of these keys throw. */
  kvSetThrows?: Set<string>;
  /** Every statement whose normalized SQL matches throws. */
  sqlThrows?: RegExp | null;
  /** Every statement throws (database gone mid-run). */
  allThrow?: string | null;
}

export class FakeLocalDb {
  readonly kv = new Map<string, string>();
  readonly shots: LocalShotSeed[] = [];
  readonly statements: { sql: string; params: unknown[] }[] = [];
  faults: DbFaults = {};
  closeCalls = 0;

  seedShots(ownerKey: string, count: number, prefix = 'shot'): void {
    for (let i = 0; i < count; i += 1) {
      const id = `${prefix}-${ownerKey}-${i}`;
      this.shots.push({
        ownerKey,
        id,
        sessionId:
          i % 3 === 0 ? `session-${ownerKey}-${Math.floor(i / 3)}` : null,
        shotType: 'forehand_drive',
        capturedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        overallScore: i % 5 === 0 ? null : 5 + (i % 5),
        confidence: 0.9,
        resultKind: i % 5 === 0 ? 'low_confidence' : 'scored',
        source: 'real',
        favorite: 0,
        payload: JSON.stringify({ id, source: 'real' }),
      });
    }
  }

  shotFingerprint(): string {
    return JSON.stringify(
      [...this.shots]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map(shot => [shot.ownerKey, shot.id, shot.payload]),
    );
  }

  destructiveStatements(): string[] {
    return this.statements
      .map(entry => entry.sql)
      .filter(
        sql =>
          /^(DELETE|DROP|UPDATE|ALTER|TRUNCATE)\b/i.test(sql) ||
          /INTO\s+local_shot\b/i.test(sql),
      );
  }

  kvWrites(): { key: string; value: string }[] {
    return this.statements
      .filter(entry => entry.sql.startsWith('INSERT OR REPLACE INTO kv'))
      .map(entry => ({
        key: String(entry.params[0]),
        value: String(entry.params[1]),
      }));
  }

  /** The LocalDb handed to production code. */
  handle(options: { ignoreOpenFault?: boolean } = {}): LocalDb {
    if (this.faults.openThrows && !options.ignoreOpenFault) {
      throw new Error(this.faults.openThrows);
    }
    return {
      execute: async (sql: string, params: unknown[] = []) => {
        const statement = sql.trim().replace(/\s+/g, ' ');
        this.statements.push({ sql: statement, params });
        if (this.faults.allThrow) throw new Error(this.faults.allThrow);
        if (this.faults.sqlThrows?.test(statement)) {
          throw new Error(`SQLITE_IOERR (simulated) for: ${statement}`);
        }
        if (statement.startsWith('SELECT value FROM kv')) {
          const key = String(params[0]);
          if (this.faults.kvGetThrows?.has(key)) {
            throw new Error(`SQLITE_IOERR (simulated) reading kv ${key}`);
          }
          const value = this.kv.get(key);
          return { rows: value === undefined ? [] : [{ value }] };
        }
        if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
          const key = String(params[0]);
          if (this.faults.kvSetThrows?.has(key)) {
            throw new Error(`SQLITE_IOERR (simulated) writing kv ${key}`);
          }
          this.kv.set(key, String(params[1]));
          return { rows: [] };
        }
        if (/FROM local_shot WHERE owner_key = \?/.test(statement)) {
          const owner = String(params[0]);
          const rows = this.shots
            .filter(shot => shot.ownerKey === owner)
            .filter(
              shot =>
                !/source = 'real'/.test(statement) || shot.source === 'real',
            )
            .map(shot => ({
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
          return { rows };
        }
        if (/^DELETE FROM (\w+) WHERE owner_key = \?/.test(statement)) {
          const table = /^DELETE FROM (\w+)/.exec(statement)?.[1];
          if (table === 'local_shot') {
            const owner = String(params[0]);
            for (let i = this.shots.length - 1; i >= 0; i -= 1) {
              if (this.shots[i]?.ownerKey === owner) this.shots.splice(i, 1);
            }
          }
          return { rows: [] };
        }
        if (/^DELETE FROM kv WHERE key/.test(statement)) {
          for (const param of params) this.kv.delete(String(param));
          return { rows: [] };
        }
        return { rows: [] };
      },
      close: () => {
        this.closeCalls += 1;
      },
    };
  }
}
