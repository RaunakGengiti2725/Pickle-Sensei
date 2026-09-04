import type { LocalDb } from '../../src/data/db';

/**
 * Latency- and fault-injectable in-memory LocalDb for the ProgressScreen
 * lifecycle stress campaign.
 *
 * Understands the statements the signed-in app issues on the way to and on
 * the Progress tab: kv reads/writes, owner-scoped `local_shot` and
 * `local_capture` reads. Unknown statements resolve to zero rows (the
 * launch-order matrix relies on the same contract). Every statement is
 * recorded with the owner it was scoped to, the dataset snapshot it observed
 * and the fake-clock instants it was issued/settled at, so the suite can
 * reason about WHICH read a rendered value must have come from.
 *
 * Latency is realised with `setTimeout` so the harness controls it through
 * Jest's fake clock — a slow read is "in flight" for exactly as many fake
 * milliseconds as the scenario scheduled.
 */

export interface StressFactSeed {
  ownerKey: string;
  id: string;
  shotType: string;
  capturedAt: string;
  overallScore: number;
}

export interface DbReadRecord {
  seq: number;
  table: 'local_shot' | 'local_capture' | 'kv' | 'other';
  owner: string | null;
  /** number of scored facts of `owner` at issue time (local_shot only) */
  snapshotCount: number | null;
  issuedAt: number;
  settledAt: number | null;
  outcome: 'pending' | 'ok' | 'fault';
  sql: string;
}

export interface DbPolicy {
  /** ms a statement stays in flight (null → resolve on the next macrotask) */
  latencyMs: (record: DbReadRecord) => number;
  /** throw SQLITE_IOERR for this statement */
  faults: (record: DbReadRecord) => boolean;
}

const DEFAULT_POLICY: DbPolicy = {
  latencyMs: () => 0,
  faults: () => false,
};

export class StressLocalDb {
  readonly kv = new Map<string, string>();
  readonly facts: StressFactSeed[] = [];
  readonly reads: DbReadRecord[] = [];
  policy: DbPolicy = DEFAULT_POLICY;
  private seq = 0;

  scoredCount(owner: string): number {
    return this.facts.filter(fact => fact.ownerKey === owner).length;
  }

  addFact(owner: string, capturedAt: string, shotType: string): StressFactSeed {
    const fact: StressFactSeed = {
      ownerKey: owner,
      id: `fact-${owner.slice(0, 8)}-${this.facts.length + 1}`,
      shotType,
      capturedAt,
      overallScore: 6.5,
    };
    this.facts.push(fact);
    return fact;
  }

  /** Reads of `table` issued at or after fake-clock instant `sinceMs`. */
  readsSince(table: DbReadRecord['table'], sinceMs: number): DbReadRecord[] {
    return this.reads.filter(r => r.table === table && r.issuedAt >= sinceMs);
  }

  pending(): DbReadRecord[] {
    return this.reads.filter(r => r.outcome === 'pending');
  }

  handle(): LocalDb {
    return {
      execute: (sql: string, params: unknown[] = []) =>
        this.execute(sql, params),
      close: () => {},
    };
  }

  private classify(statement: string): DbReadRecord['table'] {
    if (/FROM local_shot\b/.test(statement)) return 'local_shot';
    if (/FROM local_capture\b/.test(statement)) return 'local_capture';
    if (/\bkv\b/.test(statement)) return 'kv';
    return 'other';
  }

  private async execute(
    sql: string,
    params: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }> {
    const statement = sql.trim().replace(/\s+/g, ' ');
    const table = this.classify(statement);
    const ownerScoped = /WHERE owner_key = \?/.test(statement);
    const owner = ownerScoped ? String(params[0]) : null;
    const record: DbReadRecord = {
      seq: (this.seq += 1),
      table,
      owner,
      snapshotCount:
        table === 'local_shot' && owner !== null
          ? this.scoredCount(owner)
          : null,
      issuedAt: Date.now(),
      settledAt: null,
      outcome: 'pending',
      sql: statement,
    };
    this.reads.push(record);
    const latency = this.policy.latencyMs(record);
    if (latency > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, latency));
    } else {
      await Promise.resolve();
    }
    record.settledAt = Date.now();
    if (this.policy.faults(record)) {
      record.outcome = 'fault';
      throw new Error(`SQLITE_IOERR (simulated) for: ${statement}`);
    }
    record.outcome = 'ok';

    if (statement.startsWith('SELECT value FROM kv')) {
      const value = this.kv.get(String(params[0]));
      return { rows: value === undefined ? [] : [{ value }] };
    }
    if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
      this.kv.set(String(params[0]), String(params[1]));
      return { rows: [] };
    }
    if (/^DELETE FROM kv WHERE key/.test(statement)) {
      for (const param of params) this.kv.delete(String(param));
      return { rows: [] };
    }
    if (table === 'local_shot' && owner !== null) {
      // The snapshot the statement observed at issue time is what a real
      // SQLite read would return (the row set is fixed when the cursor opens).
      const rows = this.facts
        .filter(fact => fact.ownerKey === owner)
        .slice(0, record.snapshotCount ?? undefined)
        .map(fact => ({
          id: fact.id,
          session_id: null,
          shot_type: fact.shotType,
          captured_at: fact.capturedAt,
          overall_score: fact.overallScore,
          confidence: 0.92,
          result_kind: 'scored',
          source: 'real',
          favorite: 0,
          payload: JSON.stringify({
            id: fact.id,
            source: 'real',
            shotType: fact.shotType,
            capturedAtIso: fact.capturedAt,
            overallScore: fact.overallScore,
            analysisConfidence: 0.92,
            resultKind: 'scored',
            versionVector: {
              scoringModelVersion: 'stress-v1',
              shotConfigVersion: 'stress-v1',
            },
            sessionId: null,
            priorityFix: { checkpoint: 'paddle_prep' },
            checkpoints: [
              { key: 'paddle_prep', applicable: true, score: 6.0 },
              { key: 'contact_point', applicable: true, score: 7.0 },
            ],
          }),
        }));
      return { rows };
    }
    return { rows: [] };
  }
}
