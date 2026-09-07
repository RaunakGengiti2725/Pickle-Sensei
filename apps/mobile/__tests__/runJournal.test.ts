import type { Scalar, Transaction } from '@op-engineering/op-sqlite';
import type { LocalDb } from '../src/data/db';
import {
  captureDataOwnerContext,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../src/data/accountScope';
import {
  createTransactionalDb,
  forDataOwner,
  withTransaction,
} from '../src/data/transactions';
import {
  runJournal,
  analysisAttemptJournal,
  RunJournalError,
  type RunJournalIdentity,
  type RunJournalPermitPort,
  type RunJournalReleaseOutcome,
  type RunJournalScope,
} from '../src/analysis/runJournal';
import { RUN_JOURNAL_DDL } from '../src/analysis/runJournalSchema';

interface TestSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    columns(): unknown[];
    all(...params: unknown[]): Record<string, Scalar>[];
    get(...params: unknown[]): Record<string, Scalar> | undefined;
    run(...params: unknown[]): { changes: number | bigint };
  };
  close(): void;
}

const { DatabaseSync } = jest.requireActual<{
  DatabaseSync: new (path: string) => TestSqliteDatabase;
}>('node:sqlite');

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';
const ORIGIN = 'https://api.example.test/functions/v1/api';
const NOW = 1_783_382_400_000;
const scope: RunJournalScope = { ownerKey: OWNER_A, apiOrigin: ORIGIN };

function id(value: number): string {
  return `aaaaaaaa-aaaa-4aaa-8aaa-${String(value).padStart(12, '0')}`;
}

function identity(
  operation = 1,
  overrides: Partial<RunJournalIdentity> = {},
): RunJournalIdentity {
  return {
    ...scope,
    ownerGeneration: 1,
    operationId: id(operation),
    captureId: id(operation + 100),
    analysisId: id(operation + 200),
    reservationKey: id(operation + 300),
    requestHash: 'a'.repeat(64),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function httpError(status: number, code = 'unavailable'): Error {
  return Object.assign(new Error('Unpersisted transport detail'), {
    status,
    code,
  });
}

function permitService(ownerKey = OWNER_A, apiOrigin = ORIGIN) {
  const reservations = new Map<
    string,
    {
      id: string;
      status: 'reserved' | 'finalized' | 'released';
      outcome: RunJournalReleaseOutcome | 'scored' | null;
      resultId: string | null;
    }
  >();
  const reserveKeys: string[] = [];
  const releaseCalls: Array<{
    permitId: string;
    outcome: RunJournalReleaseOutcome;
  }> = [];
  let used = 1;
  let reserveFailure: unknown = null;
  let releaseFailure: unknown = null;
  let reserveGate: (() => Promise<void>) | null = null;
  let releaseGate: (() => Promise<void>) | null = null;
  let logicalReleases = 0;
  const port: RunJournalPermitPort = {
    ownerKey,
    apiOrigin,
    async reserve(key) {
      reserveKeys.push(key);
      if (reserveGate) await reserveGate();
      if (reserveFailure) throw reserveFailure;
      let permit = reservations.get(key);
      if (!permit) {
        const held = [...reservations.values()].filter(
          value => value.status === 'reserved',
        ).length;
        if (used + held >= 2) {
          throw httpError(402, 'access.paywall_required');
        }
        permit = {
          id: id(1000 + reservations.size),
          status: 'reserved',
          outcome: null,
          resultId: null,
        };
        reservations.set(key, permit);
      }
      return { permit: { id: permit.id, status: permit.status } };
    },
    async release(permitId, outcome) {
      releaseCalls.push({ permitId, outcome });
      if (releaseGate) await releaseGate();
      if (releaseFailure) throw releaseFailure;
      const permit = [...reservations.values()].find(
        value => value.id === permitId,
      );
      if (!permit) throw httpError(404, 'access.permit_not_found');
      if (permit.status !== 'reserved') {
        if (permit.outcome === outcome) return;
        throw httpError(409, 'access.permit_already_finalized');
      }
      permit.status = 'finalized';
      permit.outcome = outcome;
      logicalReleases += 1;
    },
  };
  return {
    port,
    reservations,
    reserveKeys,
    releaseCalls,
    get used() {
      return used;
    },
    get logicalReleases() {
      return logicalReleases;
    },
    failReserve(error: unknown) {
      reserveFailure = error;
    },
    failRelease(error: unknown) {
      releaseFailure = error;
    },
    onReserve(gate: () => Promise<void>) {
      reserveGate = gate;
    },
    onRelease(gate: () => Promise<void>) {
      releaseGate = gate;
    },
    consume(permitId: string, resultId: string) {
      const permit = [...reservations.values()].find(
        value => value.id === permitId,
      );
      if (!permit) throw new Error('Missing test permit');
      if (permit.resultId === resultId) return;
      if (permit.status !== 'reserved') {
        throw new Error('A released permit cannot spend a rating');
      }
      permit.resultId = resultId;
      permit.status = 'finalized';
      permit.outcome = 'scored';
      used += 1;
    },
  };
}

function sqliteStore() {
  const native = new DatabaseSync(':memory:');
  native.exec(`
    CREATE TABLE local_capture (
      owner_key TEXT NOT NULL, id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'awaiting_model',
      PRIMARY KEY (owner_key, id)
    );
    CREATE TABLE local_analysis_record (
      owner_key TEXT NOT NULL, id TEXT NOT NULL,
      PRIMARY KEY (owner_key, id)
    );
    CREATE TABLE local_session (
      owner_key TEXT NOT NULL, id TEXT NOT NULL,
      PRIMARY KEY (owner_key, id)
    );
    CREATE TABLE local_shot (
      owner_key TEXT NOT NULL, id TEXT NOT NULL,
      PRIMARY KEY (owner_key, id)
    );
    CREATE TABLE outbox (
      owner_key TEXT NOT NULL, entity_id TEXT NOT NULL,
      UNIQUE (owner_key, entity_id)
    );
  `);
  for (const sql of RUN_JOURNAL_DDL) native.exec(sql);
  let failStatement: ((sql: string) => boolean) | null = null;
  let commitFault: 'before' | 'after' | null = null;
  let queued = Promise.resolve();
  const statements: string[] = [];
  const driver = {
    transaction(operation: (connection: Transaction) => Promise<void>) {
      const task = queued.then(async () => {
        native.exec('BEGIN IMMEDIATE');
        let open = true;
        const connection: Transaction = {
          async execute(sql, params = []) {
            statements.push(sql);
            if (failStatement?.(sql)) {
              failStatement = null;
              throw new Error('Injected SQLite statement failure');
            }
            const statement = native.prepare(sql);
            if (statement.columns().length > 0) {
              const rows = statement.all(...params);
              return { rows, rowsAffected: rows.length };
            }
            const result = statement.run(...params);
            return { rows: [], rowsAffected: Number(result.changes) };
          },
          async commit() {
            const fault = commitFault;
            commitFault = null;
            if (fault === 'before') {
              throw new Error('Injected failure before physical COMMIT');
            }
            native.exec('COMMIT');
            open = false;
            if (fault === 'after') {
              throw new Error('Injected lost COMMIT acknowledgement');
            }
            return { rows: [], rowsAffected: 0 };
          },
          rollback() {
            if (open) native.exec('ROLLBACK');
            open = false;
            return { rows: [], rowsAffected: 0 };
          },
        };
        try {
          await operation(connection);
        } finally {
          if (open) native.exec('ROLLBACK');
        }
      });
      queued = task.catch(() => {});
      return task;
    },
    close: () => native.close(),
  };
  const db = createTransactionalDb(driver);
  const store = {
    db,
    native,
    statements,
    failNextStatement(predicate: (sql: string) => boolean) {
      failStatement = predicate;
    },
    failCommit(when: 'before' | 'after') {
      commitFault = when;
    },
    async seed(run: RunJournalIdentity) {
      await db.execute(
        'INSERT INTO local_capture (owner_key, id) VALUES (?, ?)',
        [run.ownerKey, run.captureId],
      );
    },
    count(table: string, owner = OWNER_A): number {
      return Number(
        native
          .prepare(`SELECT count(*) AS count FROM ${table} WHERE owner_key = ?`)
          .get(owner)?.count,
      );
    },
  };
  stores.push(store);
  return store;
}

const stores: Array<{ db: LocalDb }> = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.db.close();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

async function beginReserved(
  store: ReturnType<typeof sqliteStore>,
  service = permitService(),
  run = identity(),
) {
  await store.seed(run);
  await runJournal.begin(store.db, run, NOW);
  const response = await service.port.reserve(run.reservationKey);
  await runJournal.reserved(store.db, run, response.permit.id, NOW);
  return { run, permitId: response.permit.id, service };
}

async function publish(db: LocalDb, run: RunJournalIdentity) {
  return withTransaction(db, async transaction => {
    await transaction.execute(
      'INSERT INTO local_analysis_record (owner_key, id) VALUES (?, ?)',
      [run.ownerKey, run.analysisId],
    );
    await transaction.execute(
      "UPDATE local_capture SET status = 'analyzed' WHERE owner_key = ? AND id = ?",
      [run.ownerKey, run.captureId],
    );
    await transaction.execute(
      'INSERT INTO local_session (owner_key, id) VALUES (?, ?)',
      [run.ownerKey, run.operationId],
    );
    await transaction.execute(
      'INSERT INTO local_shot (owner_key, id) VALUES (?, ?)',
      [run.ownerKey, run.analysisId],
    );
    await transaction.execute(
      'INSERT INTO outbox (owner_key, entity_id) VALUES (?, ?)',
      [run.ownerKey, run.analysisId],
    );
    return runJournal.commit(transaction, run, run.analysisId, NOW);
  });
}

describe('legacy online run journal storage', () => {
  it('installs repeatably and stores only immutable public run identity before reserve', async () => {
    const store = sqliteStore();
    for (const sql of RUN_JOURNAL_DDL) store.native.exec(sql);
    const run = identity();
    await store.seed(run);
    const input = {
      ...run,
      accessToken: 'sensitive-access',
      refreshToken: 'sensitive-refresh',
      providerToken: 'sensitive-provider',
    };
    const begun = await runJournal.begin(store.db, input, NOW);
    expect(begun.created).toBe(true);
    expect(begun.run).toMatchObject({
      ...run,
      state: 'reserve_pending',
      permitId: null,
      resultId: null,
      releaseOutcome: null,
      terminalReason: null,
      attemptCount: 0,
      createdAtMs: NOW,
    });
    expect(Object.isFrozen(begun.run)).toBe(true);
    const stored = JSON.stringify(
      store.native.prepare('SELECT * FROM analysis_run_journal').all(),
    );
    expect(stored).not.toMatch(
      /sensitive|accessToken|refreshToken|providerToken/,
    );
    expect(await runJournal.read(store.db, run)).toEqual(begun.run);
    expect(await runJournal.begin(store.db, run, NOW + 1)).toEqual({
      created: false,
      run: begun.run,
    });
  });

  it.each<Partial<RunJournalIdentity>>([
    { ownerGeneration: 2 },
    { captureId: id(987) },
    { analysisId: id(988) },
    { reservationKey: id(989) },
    { requestHash: 'b'.repeat(64) },
    { apiOrigin: 'https://other.example.test/functions/v1/api' },
  ])(
    'rejects a conflicting replay %p without replacing the first identity',
    async change => {
      const store = sqliteStore();
      const run = identity();
      await store.seed(run);
      const original = await runJournal.begin(store.db, run, NOW);
      await expect(
        runJournal.begin(store.db, { ...run, ...change }, NOW),
      ).rejects.toBeInstanceOf(RunJournalError);
      expect(await runJournal.read(store.db, run)).toEqual(original.run);
    },
  );

  it('does not reuse a key, analysis ID, or permit ID for a second operation', async () => {
    const store = sqliteStore();
    const { run, permitId } = await beginReserved(store);
    const next = identity(2);
    await store.seed(next);
    await expect(
      runJournal.begin(store.db, {
        ...next,
        reservationKey: run.reservationKey,
      }),
    ).rejects.toThrow();
    await expect(
      runJournal.begin(store.db, { ...next, analysisId: run.analysisId }),
    ).rejects.toThrow();
    await runJournal.begin(store.db, next);
    await expect(
      runJournal.reserved(store.db, next, permitId),
    ).rejects.toThrow();
    await expect(
      runJournal.reserved(store.db, run, id(991)),
    ).rejects.toBeInstanceOf(RunJournalError);
  });

  it('requires the original owner capture and refuses scoped connections', async () => {
    const store = sqliteStore();
    const run = identity();
    await store.seed({ ...run, ownerKey: OWNER_B });
    await expect(runJournal.begin(store.db, run)).rejects.toBeInstanceOf(
      RunJournalError,
    );
    expect(store.count('analysis_run_journal', OWNER_B)).toBe(0);
    await store.seed(run);
    setActiveDataOwner(OWNER_A);
    const owned = forDataOwner(store.db, captureDataOwnerContext());
    await expect(runJournal.begin(owned, run)).rejects.toBeInstanceOf(
      RunJournalError,
    );
    expect(store.count('analysis_run_journal')).toBe(0);
  });

  it.each([
    'https://user:password@api.example.test',
    'https://api.example.test?access_token=secret',
    'https://api.example.test#refresh_token=secret',
    'file:///private/capture.mov',
    'http://api.example.test',
    'not a URL',
  ])(
    'rejects credential-bearing or invalid API origins: %s',
    async apiOrigin => {
      const store = sqliteStore();
      const run = identity();
      await store.seed(run);
      await expect(
        runJournal.begin(store.db, { ...run, apiOrigin }),
      ).rejects.toBeInstanceOf(RunJournalError);
      expect(store.count('analysis_run_journal')).toBe(0);
    },
  );

  it('normalizes a public base path without discarding the deployment boundary', async () => {
    const store = sqliteStore();
    const validRun = identity(1, { apiOrigin: `${ORIGIN}/` });
    await store.seed(validRun);
    const begun = await runJournal.begin(store.db, validRun);
    expect(begun.run.apiOrigin).toBe(ORIGIN);
    await expect(
      runJournal.read(store.db, {
        ...validRun,
        apiOrigin: 'https://api.example.test',
      }),
    ).rejects.toBeInstanceOf(RunJournalError);
  });

  it('keeps release outcomes immutable and rejects direct SQL identity or state rewinds', async () => {
    const store = sqliteStore();
    const { run } = await beginReserved(store);
    await runJournal.requestRelease(store.db, run, 'low_confidence');
    const repeated = await runJournal.requestRelease(store.db, run, 'failed');
    expect(repeated?.releaseOutcome).toBe('low_confidence');
    for (const assignment of [
      `owner_key = '${OWNER_B}'`,
      `api_origin = 'https://other.example.test'`,
      `capture_id = '${id(900)}'`,
      `analysis_id = '${id(901)}'`,
      `operation_id = '${id(902)}'`,
      `reservation_key = '${id(903)}'`,
      `permit_id = '${id(904)}'`,
      "request_hash = 'changed'",
      "release_outcome = 'cancelled'",
      "state = 'reserve_pending', permit_id = NULL, release_outcome = NULL",
    ]) {
      expect(() =>
        store.native.exec(`UPDATE analysis_run_journal SET ${assignment}`),
      ).toThrow();
    }
  });
});

describe('logical execution-attempt storage boundary', () => {
  it('keeps attempt transitions separate from untouched legacy journal rows', async () => {
    const store = sqliteStore();
    for (const sql of RUN_JOURNAL_DDL)
      store.native.exec(
        sql.replaceAll('analysis_run_journal', 'analysis_execution_attempts'),
      );
    const run = identity();
    await store.seed(run);
    await runJournal.begin(store.db, run, NOW);
    await analysisAttemptJournal.begin(store.db, run, NOW);
    await analysisAttemptJournal.reserved(store.db, run, id(600), NOW + 1);
    expect((await runJournal.read(store.db, run))?.state).toBe(
      'reserve_pending',
    );
    expect((await analysisAttemptJournal.read(store.db, run))?.state).toBe(
      'reserved',
    );
    await analysisAttemptJournal.requestRelease(
      store.db,
      run,
      'failed',
      NOW + 2,
    );
    expect((await runJournal.read(store.db, run))?.releaseOutcome).toBeNull();
    expect((await analysisAttemptJournal.read(store.db, run))?.state).toBe(
      'release_pending',
    );
    store.failNextStatement(sql =>
      sql.includes('FROM analysis_execution_attempts'),
    );
    expect(
      await analysisAttemptJournal.readCommitStatus(store.db, run),
    ).toEqual({ kind: 'unknown' });
  });

  it('shares active execution exclusion across legacy and new attempt storage', () => {
    const run = identity();
    const end = runJournal.startExecution(run);
    try {
      expect(analysisAttemptJournal.activeOperationIds(scope)).toEqual([
        run.operationId,
      ]);
      expect(() => analysisAttemptJournal.startExecution(run)).toThrow(
        'execution_active',
      );
    } finally {
      end();
    }
    expect(analysisAttemptJournal.activeOperationIds(scope)).toEqual([]);
  });
});

describe('crash checkpoints and recovery', () => {
  it('recovers death before reserve by resolving the durable key then releasing it', async () => {
    const store = sqliteStore();
    const service = permitService();
    const run = identity();
    await store.seed(run);
    await runJournal.begin(store.db, run, NOW);
    const recovered = await runJournal.recover(store.db, scope, service.port);
    expect(recovered).toEqual([
      { operationId: run.operationId, kind: 'released' },
    ]);
    expect(service.reserveKeys).toEqual([run.reservationKey]);
    expect(service.releaseCalls).toEqual([
      { permitId: id(1000), outcome: 'cancelled' },
    ]);
    expect(service.used).toBe(1);
    expect(store.count('outbox')).toBe(0);
  });

  it('resolves a lost reservation response using the SAME key, never another allowance', async () => {
    const store = sqliteStore();
    const service = permitService();
    const run = identity();
    await store.seed(run);
    await runJournal.begin(store.db, run);
    const accepted = await service.port.reserve(run.reservationKey);
    expect((await runJournal.read(store.db, run))?.permitId).toBeNull();
    await runJournal.recover(store.db, scope, service.port);
    expect(service.reserveKeys).toEqual([
      run.reservationKey,
      run.reservationKey,
    ]);
    expect(service.reservations.size).toBe(1);
    expect(service.releaseCalls[0]?.permitId).toBe(accepted.permit.id);
    expect(service.logicalReleases).toBe(1);
  });

  it('recovers death during inference without another reservation or any inference port', async () => {
    const store = sqliteStore();
    const { run, service, permitId } = await beginReserved(store);
    await runJournal.recover(store.db, scope, service.port);
    expect(service.reserveKeys).toEqual([run.reservationKey]);
    expect(service.releaseCalls).toEqual([{ permitId, outcome: 'cancelled' }]);
    expect((await runJournal.read(store.db, run))?.state).toBe('released');
    expect(store.count('local_shot')).toBe(0);
  });

  it('replays an acknowledged remote release if the local release write was lost', async () => {
    const store = sqliteStore();
    const { run, service } = await beginReserved(store);
    await runJournal.requestRelease(store.db, run, 'unsupported');
    store.failNextStatement(sql => sql.includes("SET state = 'released'"));
    expect(await runJournal.recover(store.db, scope, service.port)).toEqual([
      { operationId: run.operationId, kind: 'held' },
    ]);
    expect((await runJournal.read(store.db, run))?.state).toBe(
      'release_pending',
    );
    expect(service.logicalReleases).toBe(1);
    await runJournal.recover(store.db, scope, service.port);
    await runJournal.recover(store.db, scope, service.port);
    expect(service.releaseCalls).toHaveLength(2);
    expect(service.releaseCalls[1]).toEqual(service.releaseCalls[0]);
    expect(service.logicalReleases).toBe(1);
    expect(service.used).toBe(1);
    expect((await runJournal.read(store.db, run))?.state).toBe('released');
  });

  it('never releases a committed queued result after death before UI publication or after sync', async () => {
    const store = sqliteStore();
    const { run, service, permitId } = await beginReserved(store);
    await publish(store.db, run);
    expect(await runJournal.readCommitStatus(store.db, run)).toMatchObject({
      kind: 'committed',
      resultId: run.analysisId,
    });
    expect(await runJournal.recover(store.db, scope, service.port)).toEqual([]);
    const replay = await runJournal.begin(store.db, run);
    expect(replay.created).toBe(false);
    expect(replay.run.resultId).toBe(run.analysisId);
    expect(store.count('outbox')).toBe(1);
    expect(service.releaseCalls).toHaveLength(0);
    service.consume(permitId, run.analysisId);
    service.consume(permitId, run.analysisId);
    await runJournal.requestRelease(store.db, run, 'failed');
    await runJournal.recover(store.db, scope, service.port);
    expect(service.used).toBe(2);
    expect(service.releaseCalls).toHaveLength(0);
    expect(service.reserveKeys).toHaveLength(1);
    await expect(service.port.reserve(id(995))).rejects.toMatchObject({
      status: 402,
    });
  });

  it.each([
    'INSERT INTO local_analysis_record',
    'UPDATE local_capture',
    'INSERT INTO local_session',
    'INSERT INTO local_shot',
    'INSERT INTO outbox',
    "SET state = 'committed'",
  ])(
    'physically rolls back all result writes when %s fails',
    async fragment => {
      const store = sqliteStore();
      const { run, service } = await beginReserved(store);
      store.failNextStatement(sql => sql.includes(fragment));
      await expect(publish(store.db, run)).rejects.toThrow('Injected SQLite');
      for (const table of [
        'local_analysis_record',
        'local_session',
        'local_shot',
        'outbox',
      ]) {
        expect(store.count(table)).toBe(0);
      }
      expect(
        store.native.prepare('SELECT status FROM local_capture').get()?.status,
      ).toBe('awaiting_model');
      expect(await runJournal.readCommitStatus(store.db, run)).toMatchObject({
        kind: 'not_committed',
      });
      await runJournal.recover(store.db, scope, service.port);
      expect(service.logicalReleases).toBe(1);
      expect(service.used).toBe(1);
    },
  );

  it('reads the durable marker after a COMMIT acknowledgement throws instead of refunding a queued score', async () => {
    const store = sqliteStore();
    const { run, service } = await beginReserved(store);
    store.failCommit('after');
    await expect(publish(store.db, run)).rejects.toThrow(
      'lost COMMIT acknowledgement',
    );
    expect(store.count('local_shot')).toBe(1);
    expect(store.count('outbox')).toBe(1);
    expect(await runJournal.readCommitStatus(store.db, run)).toMatchObject({
      kind: 'committed',
      resultId: run.analysisId,
    });
    expect(
      (await runJournal.requestRelease(store.db, run, 'failed'))?.state,
    ).toBe('committed');
    await runJournal.recover(store.db, scope, service.port);
    expect(service.releaseCalls).toHaveLength(0);
  });

  it.each(['before', 'after'] as const)(
    'HOLDS an unreadable %s-COMMIT outcome until recovery can establish it',
    async when => {
      const store = sqliteStore();
      const { run, service } = await beginReserved(store);
      store.failCommit(when);
      await expect(publish(store.db, run)).rejects.toThrow();
      store.failNextStatement(
        sql => sql.includes('SELECT') && sql.includes('analysis_run_journal'),
      );
      expect(await runJournal.readCommitStatus(store.db, run)).toEqual({
        kind: 'unknown',
      });
      expect(service.releaseCalls).toHaveLength(0);
      expect((await runJournal.read(store.db, run))?.state).toBe(
        when === 'after' ? 'committed' : 'reserved',
      );
      await runJournal.recover(store.db, scope, service.port);
      expect(service.logicalReleases).toBe(when === 'after' ? 0 : 1);
      expect(store.count('outbox')).toBe(when === 'after' ? 1 : 0);
    },
  );

  it('does not allow a release claim to race a later result transaction into a queued score', async () => {
    const store = sqliteStore();
    const { run, service } = await beginReserved(store);
    await runJournal.requestRelease(store.db, run, 'cancelled');
    await expect(publish(store.db, run)).rejects.toBeInstanceOf(
      RunJournalError,
    );
    expect(store.count('local_shot')).toBe(0);
    expect(store.count('outbox')).toBe(0);
    await runJournal.recover(store.db, scope, service.port);
    expect(service.logicalReleases).toBe(1);
  });

  it('holds rather than contacting the permit service when durable release intent cannot be written', async () => {
    const store = sqliteStore();
    const { run, service } = await beginReserved(store);
    store.failNextStatement(sql =>
      sql.includes("SET state = 'release_pending'"),
    );
    expect(await runJournal.recover(store.db, scope, service.port)).toEqual([
      { operationId: run.operationId, kind: 'held' },
    ]);
    expect(service.releaseCalls).toHaveLength(0);
    expect((await runJournal.read(store.db, run))?.state).toBe('reserved');
  });

  it('a failed begin sends no reserve and a failed permit-ID write remains recoverable by key', async () => {
    const store = sqliteStore();
    const service = permitService();
    const run = identity();
    await store.seed(run);
    store.failNextStatement(sql =>
      sql.includes('INSERT INTO analysis_run_journal'),
    );
    const reserveAfterBegin = async () => {
      await runJournal.begin(store.db, run);
      return service.port.reserve(run.reservationKey);
    };
    await expect(reserveAfterBegin()).rejects.toThrow('Injected SQLite');
    expect(service.reserveKeys).toHaveLength(0);
    const response = await reserveAfterBegin();
    store.failNextStatement(sql => sql.includes('SET permit_id'));
    await expect(
      runJournal.reserved(store.db, run, response.permit.id),
    ).rejects.toThrow('Injected SQLite');
    expect((await runJournal.read(store.db, run))?.state).toBe(
      'reserve_pending',
    );
    await runJournal.recover(store.db, scope, service.port);
    expect(service.reserveKeys).toEqual([
      run.reservationKey,
      run.reservationKey,
    ]);
    expect(service.reservations.size).toBe(1);
  });

  it('does not release when a real result commits after a stale pre-release read', async () => {
    const store = sqliteStore();
    const { run, service } = await beginReserved(store);
    let commitAfterRead = true;
    const racingDb: LocalDb = {
      ...store.db,
      async execute(sql, params) {
        const result = await store.db.execute(sql, params);
        if (
          commitAfterRead &&
          sql.includes('SELECT * FROM analysis_run_journal WHERE owner_key')
        ) {
          commitAfterRead = false;
          await publish(store.db, run);
        }
        return result;
      },
    };
    expect(await runJournal.recover(racingDb, scope, service.port)).toEqual([
      { operationId: run.operationId, kind: 'committed' },
    ]);
    expect(store.count('local_shot')).toBe(1);
    expect(store.count('outbox')).toBe(1);
    expect(service.releaseCalls).toHaveLength(0);
    expect(() =>
      store.native.exec(
        "UPDATE analysis_run_journal SET state = 'reserved', result_id = NULL",
      ),
    ).toThrow();
    await expect(
      runJournal.commit(store.db, run, id(999)),
    ).rejects.toBeInstanceOf(RunJournalError);
  });

  it.each(['SET attempt_count', 'SET permit_id'])(
    'holds failed recovery bookkeeping at %s and retries without another key',
    async fragment => {
      const store = sqliteStore();
      const service = permitService();
      const run = identity();
      await store.seed(run);
      await runJournal.begin(store.db, run);
      store.failNextStatement(sql => sql.includes(fragment));
      expect(await runJournal.recover(store.db, scope, service.port)).toEqual([
        { operationId: run.operationId, kind: 'held' },
      ]);
      expect(service.releaseCalls).toHaveLength(0);
      expect((await runJournal.read(store.db, run))?.state).toBe(
        'release_pending',
      );
      await runJournal.recover(store.db, scope, service.port);
      expect(new Set(service.reserveKeys)).toEqual(
        new Set([run.reservationKey]),
      );
      expect(service.reservations.size).toBe(1);
      expect(service.logicalReleases).toBe(1);
    },
  );
});

describe('owner, origin, and deletion boundaries', () => {
  it('cleans up A after A to B without touching B or borrowing B authentication', async () => {
    const store = sqliteStore();
    setActiveDataOwner(OWNER_A);
    const a = identity(1, {
      ownerGeneration: captureDataOwnerContext().generation,
    });
    const serviceA = permitService();
    await beginReserved(store, serviceA, a);
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    setActiveDataOwner(OWNER_B);
    const b = identity(2, { ownerKey: OWNER_B });
    const serviceB = permitService(OWNER_B);
    await beginReserved(store, serviceB, b);
    const originalB = await runJournal.read(store.db, b);
    await runJournal.requestRelease(store.db, a, 'cancelled');
    serviceA.failRelease(httpError(401, 'auth.required'));
    await runJournal.recover(store.db, scope, serviceA.port);
    expect((await runJournal.read(store.db, a))?.state).toBe('release_pending');
    expect(await runJournal.read(store.db, b)).toEqual(originalB);
    expect(serviceB.releaseCalls).toHaveLength(0);
    serviceA.failRelease(null);
    await runJournal.recover(store.db, scope, serviceA.port);
    expect((await runJournal.read(store.db, a))?.state).toBe('released');
    expect(await runJournal.read(store.db, b)).toEqual(originalB);
  });

  it.each([
    { ownerKey: OWNER_B, apiOrigin: ORIGIN },
    { ownerKey: OWNER_A, apiOrigin: 'https://elsewhere.example.test' },
    {
      ownerKey: OWNER_A,
      apiOrigin: 'https://api.example.test/functions/v1/other',
    },
  ])(
    'rejects a mismatched owner-bound permit port %p before network or writes',
    async wrongScope => {
      const store = sqliteStore();
      const { run } = await beginReserved(store);
      const service = permitService(wrongScope.ownerKey, wrongScope.apiOrigin);
      const before = await runJournal.read(store.db, run);
      await expect(
        runJournal.recover(store.db, scope, service.port),
      ).rejects.toBeInstanceOf(RunJournalError);
      expect(service.reserveKeys).toHaveLength(0);
      expect(service.releaseCalls).toHaveLength(0);
      expect(await runJournal.read(store.db, run)).toEqual(before);
    },
  );

  it('records a late reservation only for A without undoing a cancellation while A signs into B', async () => {
    const store = sqliteStore();
    const service = permitService();
    const run = identity();
    await store.seed(run);
    await runJournal.begin(store.db, run);
    const response = await service.port.reserve(run.reservationKey);
    setActiveDataOwner(OWNER_B);
    await runJournal.requestRelease(store.db, run, 'cancelled');
    expect(
      await runJournal.reserved(store.db, run, response.permit.id),
    ).toMatchObject({
      ownerKey: OWNER_A,
      state: 'release_pending',
      releaseOutcome: 'cancelled',
    });
    await runJournal.recover(store.db, scope, service.port);
    expect(service.reserveKeys).toHaveLength(1);
    expect(service.logicalReleases).toBe(1);
    expect(store.count('analysis_run_journal', OWNER_B)).toBe(0);
  });

  it('holds a response if the permit port changes owner binding during an await', async () => {
    const store = sqliteStore();
    const service = permitService();
    const run = identity();
    await store.seed(run);
    await runJournal.begin(store.db, run);
    let boundOwner = OWNER_A;
    const changingPort: RunJournalPermitPort = {
      apiOrigin: ORIGIN,
      get ownerKey() {
        return boundOwner;
      },
      async reserve(key) {
        const response = await service.port.reserve(key);
        boundOwner = OWNER_B;
        return response;
      },
      release: (permitId, outcome) => service.port.release(permitId, outcome),
    };
    expect(await runJournal.recover(store.db, scope, changingPort)).toEqual([
      { operationId: run.operationId, kind: 'held' },
    ]);
    expect((await runJournal.read(store.db, run))?.permitId).toBeNull();
    expect(service.releaseCalls).toHaveLength(0);
    await runJournal.recover(store.db, scope, service.port);
    expect(service.reservations.size).toBe(1);
    expect(service.logicalReleases).toBe(1);
  });

  it.each(['reserve', 'release'] as const)(
    'does not resurrect a purged A journal after an in-flight %s callback',
    async phase => {
      const store = sqliteStore();
      const service = permitService();
      const run = identity();
      if (phase === 'reserve') {
        await store.seed(run);
        await runJournal.begin(store.db, run);
      } else {
        await beginReserved(store, service, run);
      }
      const b = identity(2, { ownerKey: OWNER_B });
      await store.seed(b);
      await runJournal.begin(store.db, b);
      const beforeB = await runJournal.read(store.db, b);
      const entered = deferred<void>();
      const gate = deferred<void>();
      const hold = async () => {
        entered.resolve();
        await gate.promise;
      };
      if (phase === 'reserve') service.onReserve(hold);
      else service.onRelease(hold);
      const recovery = runJournal.recover(store.db, scope, service.port);
      await entered.promise;
      await withTransaction(store.db, async tx => {
        await tx.execute('DELETE FROM local_capture WHERE owner_key = ?', [
          OWNER_A,
        ]);
        await tx.execute(
          'DELETE FROM analysis_run_journal WHERE owner_key = ?',
          [OWNER_A],
        );
      });
      gate.resolve();
      expect(await recovery).toEqual([
        { operationId: run.operationId, kind: 'missing' },
      ]);
      expect(await runJournal.read(store.db, run)).toBeNull();
      expect(
        await runJournal.requestRelease(store.db, run, 'failed'),
      ).toBeNull();
      expect(await runJournal.reserved(store.db, run, id(1000))).toBeNull();
      expect(await runJournal.readCommitStatus(store.db, run)).toEqual({
        kind: 'missing',
      });
      await expect(runJournal.begin(store.db, run)).rejects.toBeInstanceOf(
        RunJournalError,
      );
      await expect(
        runJournal.commit(store.db, run, run.analysisId),
      ).rejects.toBeInstanceOf(RunJournalError);
      expect(store.count('analysis_run_journal')).toBe(0);
      expect(await runJournal.read(store.db, b)).toEqual(beforeB);
    },
  );
});

describe('bounded, honest permit reconciliation', () => {
  it.each([401, 408, 429, 500, 503, 599])(
    'keeps unknown reservations pending on HTTP %i',
    async status => {
      const store = sqliteStore();
      const service = permitService();
      const run = identity();
      await store.seed(run);
      await runJournal.begin(store.db, run);
      service.failReserve(httpError(status));
      expect(await runJournal.recover(store.db, scope, service.port)).toEqual([
        { operationId: run.operationId, kind: 'pending' },
      ]);
      expect(await runJournal.read(store.db, run)).toMatchObject({
        state: 'release_pending',
        permitId: null,
        lastHttpStatus: status,
        terminalReason: null,
      });
      expect(service.releaseCalls).toHaveLength(0);
    },
  );

  it.each([401, 408, 429, 500, 503, 599])(
    'keeps known releases pending on HTTP %i without a timeout allowance reset',
    async status => {
      const store = sqliteStore();
      const { run, service } = await beginReserved(store);
      service.failRelease(httpError(status));
      await runJournal.recover(store.db, scope, service.port, {
        now: () => NOW + 1000 * 86400000,
      });
      expect(await runJournal.read(store.db, run)).toMatchObject({
        state: 'release_pending',
        lastHttpStatus: status,
        terminalReason: null,
      });
      expect(service.reserveKeys).toEqual([run.reservationKey]);
      expect(service.logicalReleases).toBe(0);
      expect(service.used).toBe(1);
    },
  );

  it.each([
    ['reserve', 402, 'access.paywall_required', 'reservation_rejected'],
    ['reserve', 409, 'access.permit_not_reserved', 'permit_not_reserved'],
    ['reserve', 400, 'validation.analysis_permit', 'reservation_rejected'],
    ['release', 404, 'access.permit_not_found', 'permit_not_found'],
    [
      'release',
      409,
      'access.permit_already_finalized',
      'permit_already_finalized',
    ],
    ['release', 403, 'auth.forbidden', 'release_rejected'],
  ] as const)(
    'classifies terminal %s HTTP %i %s as %s, not a refund',
    async (phase, status, code, terminalReason) => {
      const store = sqliteStore();
      const service = permitService();
      const run = identity();
      if (phase === 'reserve') {
        await store.seed(run);
        await runJournal.begin(store.db, run);
        service.failReserve(httpError(status, code));
      } else {
        await beginReserved(store, service, run);
        service.failRelease(httpError(status, code));
      }
      expect(await runJournal.recover(store.db, scope, service.port)).toEqual([
        { operationId: run.operationId, kind: 'terminal' },
      ]);
      expect(await runJournal.read(store.db, run)).toMatchObject({
        state: 'terminal',
        terminalReason,
        lastHttpStatus: status,
      });
      expect(await runJournal.recover(store.db, scope, service.port)).toEqual(
        [],
      );
      expect(service.logicalReleases).toBe(0);
      expect(service.used).toBe(1);
    },
  );

  it('does not pretend a non-reserved reservation replay was released by this worker', async () => {
    const store = sqliteStore();
    const service = permitService();
    const run = identity();
    await store.seed(run);
    await runJournal.begin(store.db, run);
    const response = await service.port.reserve(run.reservationKey);
    service.consume(response.permit.id, run.analysisId);
    await runJournal.recover(store.db, scope, service.port);
    expect(await runJournal.read(store.db, run)).toMatchObject({
      state: 'terminal',
      permitId: response.permit.id,
      terminalReason: 'permit_not_reserved',
    });
    expect(service.releaseCalls).toHaveLength(0);
    expect(service.used).toBe(2);
  });

  it('preserves malformed or untyped transport responses without storing their contents', async () => {
    const store = sqliteStore();
    const run = identity();
    await store.seed(run);
    await runJournal.begin(store.db, run);
    const port: RunJournalPermitPort = {
      ...scope,
      reserve: async () => ({
        permit: { id: 'secret-token-not-a-permit', status: 'reserved' },
      }),
      release: async () => {
        throw new Error('Must not release invalid identity');
      },
    };
    expect(await runJournal.recover(store.db, scope, port)).toEqual([
      { operationId: run.operationId, kind: 'pending' },
    ]);
    expect((await runJournal.read(store.db, run))?.permitId).toBeNull();
    expect(
      JSON.stringify(
        store.native.prepare('SELECT * FROM analysis_run_journal').all(),
      ),
    ).not.toContain('secret-token');
  });

  it('coalesces duplicate recovery and makes subsequent foreground recovery inert', async () => {
    const store = sqliteStore();
    const { run, service } = await beginReserved(store);
    const entered = deferred<void>();
    const gate = deferred<void>();
    service.onRelease(async () => {
      entered.resolve();
      await gate.promise;
    });
    const first = runJournal.recover(store.db, scope, service.port);
    const duplicate = runJournal.recover(store.db, scope, service.port);
    await entered.promise;
    expect(service.releaseCalls).toHaveLength(1);
    gate.resolve();
    expect(await first).toEqual([
      { operationId: run.operationId, kind: 'released' },
    ]);
    expect(await duplicate).toEqual(await first);
    expect(await runJournal.recover(store.db, scope, service.port)).toEqual([]);
    expect(service.logicalReleases).toBe(1);
  });

  it('remains idempotent if separate raw handles bypass the in-process single flight', async () => {
    const store = sqliteStore();
    const { run, service } = await beginReserved(store);
    const bothEntered = deferred<void>();
    const gate = deferred<void>();
    let entered = 0;
    service.onRelease(async () => {
      entered += 1;
      if (entered === 2) bothEntered.resolve();
      await gate.promise;
    });
    const first = runJournal.recover({ ...store.db }, scope, service.port);
    const second = runJournal.recover({ ...store.db }, scope, service.port);
    await bothEntered.promise;
    gate.resolve();
    await Promise.all([first, second]);
    expect(service.releaseCalls).toHaveLength(2);
    expect(service.releaseCalls[0]).toEqual(service.releaseCalls[1]);
    expect(service.logicalReleases).toBe(1);
    expect((await runJournal.read(store.db, run))?.state).toBe('released');
  });

  it('uses a bounded fair batch and excludes active operations supplied by the caller', async () => {
    const store = sqliteStore();
    const service = permitService();
    const runs = [identity(1), identity(2), identity(3), identity(4)];
    for (const run of runs) {
      await store.seed(run);
      await runJournal.begin(store.db, run, NOW);
    }
    service.failReserve(new Error('Network unavailable'));
    const options = { limit: 2, excludeOperationIds: [id(1)] };
    const first = await runJournal.recover(
      store.db,
      scope,
      service.port,
      options,
    );
    expect(first.map(item => item.operationId)).toEqual([id(2), id(3)]);
    expect(service.reserveKeys).toHaveLength(2);
    const second = await runJournal.recover(
      store.db,
      scope,
      service.port,
      options,
    );
    expect(second[0]?.operationId).toBe(id(4));
    expect(service.reserveKeys).toHaveLength(4);
    expect(await runJournal.read(store.db, identity(1))).toMatchObject({
      state: 'reserve_pending',
      attemptCount: 0,
    });
    for (const limit of [0, -1, 101, Number.NaN, 1.5]) {
      await expect(
        runJournal.recover(store.db, scope, service.port, { limit }),
      ).rejects.toBeInstanceOf(RunJournalError);
    }
  });
});
