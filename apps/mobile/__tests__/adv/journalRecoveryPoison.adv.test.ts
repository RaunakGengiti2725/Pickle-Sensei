/**
 * INT-sync-outbox-persistence adversary — permit journal recovery under
 * corrupt neighbours, release-commit failures and account switches.
 *
 * A stuck reservation is a user's free rating or a Pro allocation held on the
 * server; recovery must keep working for every healthy run no matter what a
 * single corrupt row looks like, and must never invent a release.
 */
import {
  recoverAnalysisJournals,
  runJournal,
  type RunJournalPermitPort,
} from '../../src/analysis/runJournal';
import { ApiError } from '../../src/data/api';
import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';
import {
  createSqliteTestDb,
  closeSqliteTestDatabases,
} from '../../testSupport/sqlite';

const OWNER = '11111111-1111-4111-8111-111111111111';
const ORIGIN = 'https://api.test';
const HASH = 'a'.repeat(64);
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

type JournalRow = {
  operationId: string;
  captureId?: string;
  analysisId: string;
  reservationKey: string;
  permitId: string | null;
  state: string;
  releaseOutcome?: string | null;
  createdAtMs: number;
  attemptCount?: number;
};

function fixture() {
  const store = createSqliteTestDb();
  const insert = (row: JournalRow) => {
    store.native
      .prepare(
        `INSERT INTO analysis_run_journal
         (owner_key, operation_id, owner_generation, capture_id, analysis_id, request_hash,
          api_origin, reservation_key, permit_id, state, release_outcome, attempt_count,
          created_at_ms, updated_at_ms)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        OWNER,
        row.operationId,
        row.captureId ?? id(row.analysisId === id(1) ? 901 : 902),
        row.analysisId,
        HASH,
        ORIGIN,
        row.reservationKey,
        row.permitId,
        row.state,
        row.releaseOutcome ?? null,
        row.attemptCount ?? 0,
        row.createdAtMs,
        row.createdAtMs,
      );
  };
  const journal = () =>
    store.native
      .prepare(
        `SELECT operation_id, state, permit_id, release_outcome, terminal_reason, attempt_count
         FROM analysis_run_journal WHERE owner_key = ? ORDER BY created_at_ms`,
      )
      .all(OWNER);
  const port: RunJournalPermitPort & {
    reserve: jest.Mock;
    release: jest.Mock;
  } = {
    ownerKey: OWNER,
    apiOrigin: ORIGIN,
    reserve: jest.fn(async (key: string) => ({
      permit: { id: key, status: 'reserved' },
    })),
    release: jest.fn(async () => {}),
  };
  const scope = runJournal.scope({ ownerKey: OWNER, apiOrigin: ORIGIN });
  return { store, insert, journal, port, scope };
}

const healthyPending: JournalRow = {
  operationId: id(2),
  analysisId: id(2),
  reservationKey: id(22),
  permitId: id(32),
  state: 'release_pending',
  releaseOutcome: 'low_confidence',
  createdAtMs: 2_000,
};

beforeEach(() => setActiveDataOwner(OWNER));
afterEach(() => {
  closeSqliteTestDatabases();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('ADV-13 a corrupt journal row ahead of a healthy pending release', () => {
  it('control: the healthy release is delivered when the journal is clean', async () => {
    const { store, insert, journal, port, scope } = fixture();
    insert(healthyPending);
    const recovered = await recoverAnalysisJournals(store.db, scope, port);
    expect(recovered.unknownStorage).toBe(false);
    expect(recovered.items).toEqual([{ operationId: id(2), kind: 'released' }]);
    expect(port.release).toHaveBeenCalledWith(id(32), 'low_confidence');
    expect(journal()[0]).toMatchObject({ state: 'released' });
  });

  const poisons: Array<[string, JournalRow]> = [
    [
      'permit_id is not a UUID',
      {
        operationId: id(1),
        analysisId: id(1),
        reservationKey: id(21),
        permitId: 'not-a-permit',
        state: 'reserved',
        createdAtMs: 1_000,
      },
    ],
    [
      'capture_id is not a UUID',
      {
        operationId: id(1),
        captureId: 'capture',
        analysisId: id(1),
        reservationKey: id(21),
        permitId: null,
        state: 'reserve_pending',
        createdAtMs: 1_000,
      },
    ],
    [
      'reservation_key is not a UUID',
      {
        operationId: id(1),
        analysisId: id(1),
        reservationKey: 'reservation',
        permitId: null,
        state: 'reserve_pending',
        createdAtMs: 1_000,
      },
    ],
  ];

  it.each(poisons)(
    '%s: the corrupt row is reported UNKNOWN, but the healthy run behind it still recovers',
    async (_name, poison) => {
      const { store, insert, journal, port, scope } = fixture();
      insert(poison);
      insert(healthyPending);
      const recovered = await recoverAnalysisJournals(store.db, scope, port);
      // The corrupt row must not be silently "recovered" or rewritten.
      expect(journal()[0]).toMatchObject({
        operation_id: id(1),
        state: poison.state,
        permit_id: poison.permitId,
      });
      expect(port.reserve).not.toHaveBeenCalledWith(poison.reservationKey);
      // But it must not hold every other run's permit hostage either.
      expect(port.release).toHaveBeenCalledWith(id(32), 'low_confidence');
      expect(journal()[1]).toMatchObject({
        operation_id: id(2),
        state: 'released',
      });
      expect(recovered.items).toContainEqual({
        operationId: id(2),
        kind: 'released',
      });
    },
  );
});

describe('ADV-14 release delivered but the local "released" write fails', () => {
  it('stays release_pending and the next recovery re-releases idempotently', async () => {
    const { store, insert, journal, port, scope } = fixture();
    insert(healthyPending);
    store.failStatementOnce("SET state = 'released'");
    const first = await recoverAnalysisJournals(store.db, scope, port);
    expect(first.items).toEqual([{ operationId: id(2), kind: 'held' }]);
    expect(first.unknownStorage).toBe(false);
    expect(journal()[0]).toMatchObject({
      state: 'release_pending',
      attempt_count: 1,
    });
    expect(port.release).toHaveBeenCalledTimes(1);
    // Server answers the replayed release as already finalized.
    port.release.mockRejectedValueOnce(
      new ApiError(409, 'access.permit_already_finalized', 'done'),
    );
    const second = await recoverAnalysisJournals(store.db, scope, port);
    expect(second.items).toEqual([{ operationId: id(2), kind: 'terminal' }]);
    expect(journal()[0]).toMatchObject({
      state: 'terminal',
      terminal_reason: 'permit_already_finalized',
      attempt_count: 2,
    });
    expect(port.release).toHaveBeenCalledTimes(2);
  });

  it('a 5xx / timeout / 429 on release keeps the run pending with the same permit', async () => {
    const { store, insert, journal, port, scope } = fixture();
    insert(healthyPending);
    for (const error of [
      new ApiError(503, 'service.unavailable', 'down'),
      new ApiError(408, 'network.timeout', 'slow'),
      new ApiError(429, 'rate_limit.exceeded', 'later'),
      new TypeError('Network request failed'),
    ]) {
      port.release.mockRejectedValueOnce(error);
      const recovered = await recoverAnalysisJournals(store.db, scope, port);
      expect(recovered.items).toEqual([
        { operationId: id(2), kind: 'pending' },
      ]);
      expect(journal()[0]).toMatchObject({
        state: 'release_pending',
        permit_id: id(32),
        terminal_reason: null,
      });
    }
    expect(journal()[0]).toMatchObject({ attempt_count: 4 });
    expect(port.reserve).not.toHaveBeenCalled();
  });
});

describe('ADV-15 account switch during a reserve_pending recovery', () => {
  it('a port bound to another owner is refused before any network call', async () => {
    const { store, insert, journal, port, scope } = fixture();
    insert({
      operationId: id(1),
      analysisId: id(1),
      reservationKey: id(21),
      permitId: null,
      state: 'reserve_pending',
      createdAtMs: 1_000,
    });
    const foreignPort = {
      ...port,
      ownerKey: '22222222-2222-4222-8222-222222222222',
    };
    const recovered = await recoverAnalysisJournals(
      store.db,
      scope,
      foreignPort,
    );
    expect(recovered.unknownStorage).toBe(true);
    expect(recovered.items).toEqual([]);
    expect(port.reserve).not.toHaveBeenCalled();
    expect(port.release).not.toHaveBeenCalled();
    expect(journal()[0]).toMatchObject({ state: 'reserve_pending' });
  });

  it('a reservation answered with status=finalized is terminal, never a second reservation', async () => {
    const { store, insert, journal, port, scope } = fixture();
    insert({
      operationId: id(1),
      analysisId: id(1),
      reservationKey: id(21),
      permitId: null,
      state: 'reserve_pending',
      createdAtMs: 1_000,
    });
    port.reserve.mockResolvedValueOnce({
      permit: { id: id(31), status: 'finalized' },
    });
    const recovered = await recoverAnalysisJournals(store.db, scope, port);
    expect(recovered.items).toEqual([{ operationId: id(1), kind: 'terminal' }]);
    expect(journal()[0]).toMatchObject({
      state: 'terminal',
      permit_id: id(31),
      terminal_reason: 'permit_not_reserved',
    });
    expect(port.release).not.toHaveBeenCalled();
    // Recovery is not re-run for a terminal row.
    await recoverAnalysisJournals(store.db, scope, port);
    expect(port.reserve).toHaveBeenCalledTimes(1);
  });
});
