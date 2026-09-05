import type { LocalDb } from '../../../src/data/db';
import { getActiveDataOwner } from '../../../src/data/accountScope';
import {
  InjectedFaultError,
  runFault,
  type FaultJournal,
  type FaultMode,
} from './faults';
import type { SeededRng } from './seededRng';

/**
 * SQLite `kv` table stand-in with per-call fault injection. Only the two
 * statements the notification store issues (`getKv` / `setKv`) are
 * modelled; anything else resolves empty like the existing test doubles.
 *
 * `malformed` reads hand back a row outside the contract (wrong type, no
 * `value` column, truncated / wrong-version JSON). `malformed` writes are
 * bit-rot: the row is acknowledged but stored corrupted. `partial` writes
 * are torn: half the value lands, then the statement rejects.
 */

export type KvOp = 'read' | 'write';

export interface KvWriteRecord {
  key: string;
  /** Value the store asked to persist. */
  requested: string;
  /** Value actually on disk after the call (null = row untouched). */
  stored: string | null;
  /** The dependency reported success. */
  acknowledged: boolean;
  /** Owner active when the write was issued. */
  activeOwner: string;
  mode: FaultMode;
  atMs: number;
}

export interface KvReadRecord {
  key: string;
  mode: FaultMode;
  /** What the store's `getKv` will see (null for rejected/never). */
  delivered: string | null;
  atMs: number;
}

const MALFORMED_ROWS: ReadonlyArray<() => { rows: Record<string, unknown>[] }> =
  [
    () => ({ rows: [{ value: 42 }] }),
    () => ({ rows: [{}] }),
    () => ({ rows: [{ value: '{"enabled":' }] }),
    () => ({ rows: [{ value: 'null' }] }),
    () => ({ rows: [{ value: '[]' }] }),
    () => ({ rows: [{ value: '"enabled"' }] }),
    () => ({
      rows: [
        {
          value:
            '{"version":2,"enabled":"yes","practiceReminderMinutes":1440,"comeback":1}',
        },
      ],
    }),
    () => ({ rows: [{ value: { enabled: true } }] }),
    () => ({ rows: [{ value: '' }] }),
    () => ({ rows: [{ value: 'x'.repeat(65_536) }] }),
  ];

export class FaultKv implements LocalDb {
  readonly table = new Map<string, string>();
  readonly writes: KvWriteRecord[] = [];
  readonly reads: KvReadRecord[] = [];
  /** Decides the fault for each statement; default is healthy. */
  modeFor: (op: KvOp, key: string) => FaultMode = () => 'ok';

  constructor(
    private readonly journal: FaultJournal,
    private readonly rng: SeededRng,
  ) {}

  execute(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: Record<string, unknown>[] }> {
    const key = String(params[0]);
    if (sql.startsWith('SELECT value FROM kv')) {
      const mode = this.modeFor('read', key);
      const current = this.table.get(key);
      const read: KvReadRecord = {
        key,
        mode,
        delivered: null,
        atMs: Date.now(),
      };
      this.reads.push(read);
      const healthy = () => {
        read.delivered = current ?? null;
        return { rows: current === undefined ? [] : [{ value: current }] };
      };
      return runFault(this.journal, 'sqlite', 'read', mode, healthy, {
        slowMs: this.rng.int(500, 5_000),
        malformed: () => {
          const row = this.rng.pick(MALFORMED_ROWS)();
          const value = row.rows[0]?.['value'];
          read.delivered = value ? String(value) : null;
          return row;
        },
        partial: () => {
          // Truncated row: the reader sees half the stored JSON.
          const half =
            current === undefined
              ? undefined
              : current.slice(0, Math.floor(current.length / 2));
          read.delivered = half ?? null;
          return { rows: half === undefined ? [] : [{ value: half }] };
        },
      });
    }
    if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
      const mode = this.modeFor('write', key);
      const requested = String(params[1]);
      const record: KvWriteRecord = {
        key,
        requested,
        stored: this.table.get(key) ?? null,
        acknowledged: false,
        activeOwner: getActiveDataOwner(),
        mode,
        atMs: Date.now(),
      };
      this.writes.push(record);
      const healthy = () => {
        this.table.set(key, requested);
        record.stored = requested;
        record.acknowledged = true;
        return { rows: [] };
      };
      return runFault(this.journal, 'sqlite', 'write', mode, healthy, {
        slowMs: this.rng.int(500, 5_000),
        malformed: () => {
          // Bit-rot: acknowledged, but the row holds garbage.
          const rotten = requested.replace(/true/g, 'tru').slice(1);
          this.table.set(key, rotten);
          record.stored = rotten;
          record.acknowledged = true;
          return { rows: [] };
        },
        partial: () => {
          const torn = requested.slice(0, Math.floor(requested.length / 2));
          this.table.set(key, torn);
          record.stored = torn;
          throw new InjectedFaultError('sqlite', 'write', 'partial');
        },
      });
    }
    return Promise.resolve({ rows: [] });
  }

  close(): void {}

  /** Writes the store believes succeeded (`acknowledged`) for `key`. */
  lastWrite(key: string): KvWriteRecord | null {
    for (let i = this.writes.length - 1; i >= 0; i--) {
      const record = this.writes[i];
      if (record && record.key === key) return record;
    }
    return null;
  }
}
