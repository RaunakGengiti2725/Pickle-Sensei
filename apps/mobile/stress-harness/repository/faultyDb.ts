/**
 * Fault-injecting `LocalDb` proxy in front of a real SQLite connection.
 *
 * Every statement the repository issues passes through `execute`, which can
 * be armed with exactly one fault that fires on the N-th statement matching a
 * pattern. Faults model what a native SQLite driver can actually do to a
 * caller:
 *
 *   throw-sync          execute() throws synchronously (bridge/argument error)
 *   reject              rejects BEFORE the statement applies (SQLITE_BUSY,
 *                       SQLITE_IOERR, SQLITE_FULL, SQLITE_CORRUPT, …)
 *   reject-after-apply  the statement applies, then the promise rejects —
 *                       a lost acknowledgement (COMMIT reported as failed
 *                       although durable, INSERT applied but error surfaced)
 *   slow                resolves after `delayMs` on the timer (fake timers
 *                       drive it); the statement applies on time
 *   never               never settles; the statement does not apply
 *   owner-swap          the active data owner changes while the statement is
 *                       in flight (sign-out / account switch mid-operation)
 *   delete-during       another actor deletes rows of the active owner from
 *                       the real connection while the statement is in flight
 *   close-during        the connection is closed while the statement is in
 *                       flight; the statement then fails
 *
 * Every `execute` also yields to the microtask queue a seeded number of times
 * before running, so two operations running concurrently on the same proxy
 * interleave their statements the way an async native driver lets them.
 */
import type { LocalDb } from '../../src/data/db';
import type { SqliteDatabaseSync } from '../../xc-harness/lifecycle-persistence/nodeShim';

export const FAULT_KINDS = [
  'throw-sync',
  'reject',
  'reject-after-apply',
  'slow',
  'never',
  'owner-swap',
  'delete-during',
  'close-during',
] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];

export const SQLITE_ERROR_CODES = [
  'SQLITE_BUSY',
  'SQLITE_IOERR',
  'SQLITE_FULL',
  'SQLITE_CORRUPT',
  'SQLITE_READONLY',
  'SQLITE_NOMEM',
  'SQLITE_LOCKED',
  'SQLITE_INTERRUPT',
] as const;
export type SqliteErrorCode = (typeof SQLITE_ERROR_CODES)[number];

export class InjectedSqliteError extends Error {
  readonly code: SqliteErrorCode;
  readonly injected = true as const;
  constructor(code: SqliteErrorCode, statement: string) {
    super(`[${code}] injected on ${statement.trim().slice(0, 40)}`);
    this.name = 'InjectedSqliteError';
    this.code = code;
  }
}

export interface Fault {
  kind: FaultKind;
  /** Regex a statement must match to be a candidate; null = every statement. */
  match: RegExp | null;
  /** Zero-based index among matching statements at which the fault fires. */
  atMatch: number;
  code: SqliteErrorCode;
  /** `slow` only. */
  delayMs: number;
  /** `owner-swap` only: the owner to switch to mid-flight. */
  swapTo?: string;
  /** `delete-during` only: SQL run on the raw connection mid-flight. */
  deleteSql?: string[];
  /** Armed automatically once this fault fires (double faults, e.g. the
   * ROLLBACK issued after a failed INSERT also failing). */
  then?: Fault;
}

export interface StatementRecord {
  index: number;
  sql: string;
  params: unknown[];
  outcome: 'ok' | 'threw' | 'rejected' | 'faulted' | 'pending';
  fault: FaultKind | null;
}

export interface FaultyDbHooks {
  setOwner(owner: string): void;
}

export class FaultyLocalDb implements LocalDb {
  readonly statements: StatementRecord[] = [];
  fault: Fault | null = null;
  /** Set once the armed fault has actually fired. */
  fired: { statementIndex: number; sql: string } | null = null;
  /** Total faults fired (primary + chained). */
  firedCount = 0;
  /** Number of `await Promise.resolve()` yields before each statement runs. */
  yieldsBeforeExecute: () => number = () => 0;
  closeCalls = 0;
  private matches = 0;
  private closed = false;

  constructor(
    private readonly inner: LocalDb,
    private readonly raw: SqliteDatabaseSync,
    private readonly hooks: FaultyDbHooks,
  ) {}

  arm(fault: Fault): void {
    this.fault = fault;
    this.fired = null;
    this.firedCount = 0;
    this.matches = 0;
  }

  disarm(): void {
    this.fault = null;
  }

  execute(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: Record<string, unknown>[] }> {
    const record: StatementRecord = {
      index: this.statements.length,
      sql,
      params,
      outcome: 'pending',
      fault: null,
    };
    this.statements.push(record);
    const fault = this.candidateFault(sql);
    if (fault) {
      record.fault = fault.kind;
      if (!this.fired) this.fired = { statementIndex: record.index, sql };
      this.firedCount += 1;
      this.fault = fault.then ?? null;
      this.matches = 0;
    }
    if (fault?.kind === 'throw-sync') {
      record.outcome = 'threw';
      throw new InjectedSqliteError(fault.code, sql);
    }
    return this.run(sql, params, fault, record);
  }

  private candidateFault(sql: string): Fault | null {
    const fault = this.fault;
    if (!fault) return null;
    if (fault.match && !fault.match.test(sql)) return null;
    const index = this.matches;
    this.matches += 1;
    return index === fault.atMatch ? fault : null;
  }

  private async run(
    sql: string,
    params: unknown[],
    fault: Fault | null,
    record: StatementRecord,
  ): Promise<{ rows: Record<string, unknown>[] }> {
    const yields = this.yieldsBeforeExecute();
    for (let i = 0; i < yields; i++) await Promise.resolve();
    if (!fault) return this.apply(sql, params, record);
    switch (fault.kind) {
      case 'reject':
        record.outcome = 'faulted';
        throw new InjectedSqliteError(fault.code, sql);
      case 'reject-after-apply':
        await this.apply(sql, params, record);
        record.outcome = 'faulted';
        throw new InjectedSqliteError(fault.code, sql);
      case 'slow':
        await new Promise<void>(resolve => setTimeout(resolve, fault.delayMs));
        return this.apply(sql, params, record);
      case 'never':
        record.outcome = 'faulted';
        return new Promise<never>(() => undefined);
      case 'owner-swap':
        this.hooks.setOwner(fault.swapTo ?? 'signed-out');
        return this.apply(sql, params, record);
      case 'delete-during':
        for (const statement of fault.deleteSql ?? []) this.raw.exec(statement);
        return this.apply(sql, params, record);
      case 'close-during':
        this.close();
        record.outcome = 'faulted';
        throw new InjectedSqliteError(fault.code, sql);
      case 'throw-sync':
        // Handled synchronously in execute(); unreachable here.
        throw new InjectedSqliteError(fault.code, sql);
    }
  }

  private async apply(
    sql: string,
    params: unknown[],
    record: StatementRecord,
  ): Promise<{ rows: Record<string, unknown>[] }> {
    if (this.closed) {
      record.outcome = 'rejected';
      throw new Error('database is closed');
    }
    try {
      const result = await this.inner.execute(sql, params);
      if (record.outcome === 'pending') record.outcome = 'ok';
      return result;
    } catch (error) {
      record.outcome = 'rejected';
      throw error;
    }
  }

  close(): void {
    this.closeCalls += 1;
    if (this.closed) return;
    this.closed = true;
    this.inner.close();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

/** Compact view of the SQL verbs an operation issued, for artifacts. */
export function statementVerbs(statements: StatementRecord[]): string[] {
  return statements.map(s => {
    const verb = s.sql.trim().split(/\s+/).slice(0, 3).join(' ');
    const suffix = s.fault
      ? `!${s.fault}`
      : s.outcome === 'ok'
        ? ''
        : `?${s.outcome}`;
    return `${verb}${suffix}`;
  });
}
