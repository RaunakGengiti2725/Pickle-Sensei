import type { LocalDb } from '../../../src/data/db';

/**
 * Persisted-world double for the consistency store's SQLite reads/writes.
 *
 * Serves exactly the statements `src/consistency/store.ts` and
 * `src/state/appStore.ts` issue through `src/data/repository.ts`:
 *   SELECT … FROM local_shot WHERE owner_key = ? AND source = 'real'
 *   SELECT value FROM kv WHERE key = ?
 *   INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)
 *
 * Lifecycle knobs:
 *   latencyMs   — every statement resolves after a fake-timer delay so the
 *                 schedule can interrupt a refresh mid-flight.
 *   fault       — storage "revoked" (the closest analog of a permission
 *                 revoked after grant for a screen that only reads device
 *                 storage): 'all' rejects every statement; 'shots' rejects
 *                 only the shot-table read (profile kv still works, so the
 *                 navigator stays up and the screen's error card is the
 *                 visible outcome).
 *   kill()      — process death: every statement in flight, and every one
 *                 the dying process still issues, fails instead of
 *                 completing (their continuations belong to a process that
 *                 no longer exists; the harness drains them and then resets
 *                 every in-memory store so nothing they did can reach the
 *                 relaunched process). Writes in flight at the kill are
 *                 lost, as an uncommitted write would be.
 *   relaunch()  — the next process starts issuing statements again.
 */
export interface ShotRow {
  id: string;
  sessionId: string | null;
  shotType: string;
  capturedAt: string;
  overallScore: number | null;
  resultKind: string;
}

export interface Statement {
  sql: string;
  params: unknown[];
  generation: number;
  atMs: number;
}

export class StressLocalDb implements LocalDb {
  readonly kv = new Map<string, string>();
  readonly shots = new Map<string, ShotRow[]>();
  readonly statements: Statement[] = [];
  latencyMs = 0;
  fault: false | 'all' | 'shots' = false;
  generation = 0;
  dead = false;
  private readonly inFlight = new Map<number, number>();
  /** Statements orphaned by a kill (they failed instead of completing). */
  orphaned = 0;

  /** Statements issued by the live process and not yet settled. */
  get pending(): number {
    return this.inFlight.get(this.generation) ?? 0;
  }

  /** Statements not yet settled from any generation (drain target). */
  get inFlightAll(): number {
    let total = 0;
    for (const n of this.inFlight.values()) total += n;
    return total;
  }

  async execute(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: Record<string, unknown>[] }> {
    const generation = this.generation;
    this.statements.push({ sql, params, generation, atMs: Date.now() });
    if (this.statements.length > 2000) this.statements.splice(0, 1000);
    if (this.dead) {
      this.orphaned += 1;
      throw new Error('stress: statement issued by a killed process');
    }
    this.inFlight.set(generation, (this.inFlight.get(generation) ?? 0) + 1);
    if (this.latencyMs > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, this.latencyMs));
    }
    this.inFlight.set(generation, (this.inFlight.get(generation) ?? 1) - 1);
    if (this.dead || generation !== this.generation) {
      this.orphaned += 1;
      throw new Error('stress: process killed before statement completed');
    }
    if (this.fault === 'all') {
      throw new Error('stress: storage unavailable');
    }
    if (sql.startsWith('SELECT id, session_id, shot_type')) {
      if (this.fault === 'shots') {
        throw new Error('stress: shot table unavailable');
      }
      const owner = String(params[0]);
      const rows = this.shots.get(owner) ?? [];
      return {
        rows: rows.map(r => ({
          id: r.id,
          session_id: r.sessionId,
          shot_type: r.shotType,
          captured_at: r.capturedAt,
          overall_score: r.overallScore,
          result_kind: r.resultKind,
        })),
      };
    }
    if (sql.startsWith('SELECT value FROM kv')) {
      const value = this.kv.get(String(params[0]));
      return { rows: value === undefined ? [] : [{ value }] };
    }
    if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
      this.kv.set(String(params[0]), String(params[1]));
      return { rows: [] };
    }
    return { rows: [] };
  }

  close(): void {}

  /** Kill the process: outstanding statements fail instead of completing. */
  kill(): void {
    this.dead = true;
  }

  /** Cold relaunch: a new process starts talking to the same database. */
  relaunch(): void {
    this.dead = false;
    this.generation += 1;
  }

  kvSnapshot(): Record<string, string> {
    return Object.fromEntries([...this.kv.entries()].sort());
  }
}
