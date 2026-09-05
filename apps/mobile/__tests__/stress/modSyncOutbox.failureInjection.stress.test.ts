/**
 * STRESS — unit mod-sync-outbox, lens failure-injection (campaign A: one drain).
 *
 * Every iteration: a seeded plan (queue of valid + poison + other-owner +
 * exhausted rows, one fault per transport method, an optional SQLite fault on
 * a specific statement, an optional owner switch mid-drain), executed by the
 * REAL `drainOutbox()` against a REAL in-memory SQLite (`node:sqlite`), then
 * judged against (a) structural invariants that hold under any fault and (b)
 * an independent model of the documented contract.
 *
 * Fault classes injected (all seeded, all replayable):
 *   transport  throw · reject (Error / TypeError / non-Error) · HTTP 400 401
 *              403 404 408 409 413 422 429 500 502 503 504 · slow · never
 *              resolves · malformed 2xx (null / string / {} / missing or
 *              mistyped acceptedIds / missing rejected) · partial acceptance ·
 *              unacknowledged · unknown ids echoed · transient and contract
 *              rejection codes · missing rejection code · transport without
 *              uploadEvaluationTrials
 *   sqlite     throw · throw-after-apply · SQLITE_BUSY once · malformed rows ·
 *              slow, on SELECT / UPDATE / DELETE / BEGIN / INSERT receipt /
 *              COMMIT / ROLLBACK / count
 *   rows       corrupt JSON · unknown kind · null payload · missing permit ·
 *              missing checkpoints · missing trial id · duplicate shot id ·
 *              other-owner rows · attempts ≥ OUTBOX_MAX_ATTEMPTS
 *   identity   active data owner switched mid-drain
 *
 * Known deviations are pinned as `test.failing` (they flip to failures once
 * fixed, so the fix must also update the model):
 *   F1  session.finalize row with payload `null` → TypeError inside the
 *       transport try → classified TRANSIENT → never burns an attempt, never
 *       leaves the queue.
 *   F2  2xx body whose `rejected` is an array but `acceptedIds` is missing /
 *       null / a string → every shot "unacknowledged" → PERMANENT (+1
 *       attempt), while the same class of wrong-shape body with `rejected`
 *       missing is TRANSIENT (repo oracle: wrong-shape 2xx = transient).
 *
 * Scale: STRESS_ITER (default 120) iterations from STRESS_SEED_BASE (default
 * 0x5eed0000). Replay one seed: STRESS_SEED=<n>. Row table:
 * artifacts/stress/mod-sync-outbox-failure-injection/<STRESS_RUN_ID|latest>/campaignA.rows.json
 */
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { drainOutbox, OUTBOX_MAX_ATTEMPTS } from '../../src/data/sync';
import {
  envInt,
  replaySeed,
  runSingleDrainIteration,
  STRESS_ITER_DEFAULT,
  writeArtifact,
  type IterationRow,
} from '../../__harness__/stress/campaign';
import {
  buildPlan,
  buildRow,
  buildTransport,
  expectedOutcome,
  loadQueue,
  makeRng,
  TRANSPORT_FAULTS,
  type TransportFault,
} from '../../__harness__/stress/faultInjection';
import { SqliteStressDb } from '../../__harness__/stress/sqliteLocalDb';

const ITER = envInt('STRESS_ITER', STRESS_ITER_DEFAULT);
const SEED_BASE = envInt('STRESS_SEED_BASE', 0x5eed0000);
const REPLAY = replaySeed();
const SEEDS =
  REPLAY !== null
    ? [REPLAY]
    : Array.from({ length: ITER }, (_, i) => SEED_BASE + i);

const rows: IterationRow[] = [];

afterAll(() => {
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  const byOutcome = new Map<string, number>();
  const byViolation = new Map<string, number>();
  for (const row of rows) {
    byOutcome.set(row.outcome, (byOutcome.get(row.outcome) ?? 0) + 1);
    for (const violation of row.violations) {
      const key = `${violation.finding ?? 'unknown'}:${violation.code}`;
      byViolation.set(key, (byViolation.get(key) ?? 0) + 1);
    }
  }
  writeArtifact('campaignA.rows.json', rows);
  writeArtifact('campaignA.summary.json', {
    suite: 'mod-sync-outbox/failure-injection/campaignA',
    iterations: rows.length,
    injectedFaults: rows.reduce((sum, row) => sum + row.injectedFaults, 0),
    settlements: {
      resolved: rows.filter(row => row.settlement === 'resolved').length,
      rejected: rows.filter(row => row.settlement === 'rejected').length,
      hung: rows.filter(row => row.settlement === 'hung').length,
    },
    outcomes: Object.fromEntries(byOutcome),
    violations: Object.fromEntries(byViolation),
    seedsWithUnknownViolations: rows
      .filter(row => row.unknownViolations.length > 0)
      .map(row => row.seed),
    seedsWithKnownDeviations: rows
      .filter(row => row.violations.some(violation => violation.finding))
      .map(row => ({
        seed: row.seed,
        findings: [...new Set(row.violations.map(v => v.finding))],
      })),
    seedBase: SEED_BASE,
    yieldModes: Object.fromEntries(
      ['none', 'micro', 'macro', 'mixed'].map(mode => [
        mode,
        rows.filter(row => row.yieldMode === mode).length,
      ]),
    ),
  });
});

describe(`campaign A — ${SEEDS.length} seeded single-drain failure injections`, () => {
  test(
    'every iteration ran, and no invariant failed outside the pinned findings',
    async () => {
      for (const seed of SEEDS) {
        rows.push(await runSingleDrainIteration(seed));
      }
      expect(rows).toHaveLength(SEEDS.length);
      const unknown = rows.filter(row => row.unknownViolations.length > 0);
      expect(
        unknown.map(row => ({
          seed: row.seed,
          replay: row.replay,
          violations: row.unknownViolations,
        })),
      ).toEqual([]);
    },
    // Hung iterations wait for the event loop to drain (≈50ms each).
    Math.max(30_000, SEEDS.length * 250),
  );

  test('the campaign injected at least 60 faults and covered every transport fault class', () => {
    if (REPLAY !== null) return;
    const injected = rows.reduce((sum, row) => sum + row.injectedFaults, 0);
    // ≥60 at the default scale; a deliberately small STRESS_ITER scales down.
    expect(injected).toBeGreaterThanOrEqual(Math.min(60, SEEDS.length * 2));
    const seen = new Set<TransportFault>();
    for (const row of rows) {
      for (const method of [
        'createSession',
        'finalizeSession',
        'syncShots',
        'uploadEvaluationTrials',
      ] as const) {
        seen.add(row.plan.transport[method]);
      }
    }
    const missing = TRANSPORT_FAULTS.filter(fault => !seen.has(fault));
    expect(missing).toEqual([]);
  });

  test('no drain hung except when the transport itself never resolved or SQLite never answered', () => {
    const unexpectedHangs = rows.filter(
      row =>
        row.settlement === 'hung' &&
        !row.transportCalls.some(call => call.endsWith('→never_resolves')) &&
        row.plan.dbFault?.mode !== 'hang',
    );
    expect(unexpectedHangs.map(row => row.seed)).toEqual([]);
  });
});

// ─── pinned findings (minimal seeds) ─────────────────────────────────────────

describe('pinned deviations from the documented contract', () => {
  beforeEach(() => setActiveDataOwner(GUEST_DATA_OWNER));
  afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

  test.failing(
    'F1: a session.finalize row whose payload is `null` is a poison row that can never succeed, so it must burn an attempt (currently classified transient: attempts stay 0 forever)',
    async () => {
      const db = new SqliteStressDb();
      try {
        const id = db.insertOutboxRow({
          owner: GUEST_DATA_OWNER,
          kind: 'session.finalize',
          payload: 'null',
        });
        const finalizeSession = jest.fn(async () => {});
        for (let drain = 0; drain < OUTBOX_MAX_ATTEMPTS + 1; drain += 1) {
          await drainOutbox(db, {
            syncShots: async () => ({ acceptedIds: [], rejected: [] }),
            createSession: async () => {},
            finalizeSession,
          });
        }
        const row = db.outboxRows().find(candidate => candidate.id === id);
        expect(finalizeSession).not.toHaveBeenCalled();
        expect(row?.last_error).toMatch(/TypeError/);
        // Contract (sync.ts:187-189, 64-66): a row that cannot become a
        // request fails permanently and leaves the drain window after
        // OUTBOX_MAX_ATTEMPTS. Observed: attempts never move.
        expect(row?.attempts).toBeGreaterThanOrEqual(OUTBOX_MAX_ATTEMPTS);
      } finally {
        db.close();
      }
    },
  );

  test.failing(
    'F2: a 2xx body with `rejected: []` but no usable `acceptedIds` is a wrong-shape response and must stay transient (currently burns an attempt as "unacknowledged")',
    async () => {
      const db = new SqliteStressDb();
      try {
        const id = db.insertOutboxRow({
          owner: GUEST_DATA_OWNER,
          kind: 'shot.sync',
          payload: buildRow(makeRng(42), 'r0', 'shot_ok', null).payload,
        });
        const bodies: unknown[] = [
          { rejected: [] },
          { acceptedIds: null, rejected: [] },
          { acceptedIds: 'not-an-array', rejected: [] },
        ];
        for (const body of bodies) {
          await drainOutbox(db, {
            syncShots: async () =>
              body as { acceptedIds: string[]; rejected: [] },
            createSession: async () => {},
            finalizeSession: async () => {},
          });
        }
        const row = db.outboxRows().find(candidate => candidate.id === id);
        expect(row).toBeDefined();
        expect(db.receipts()).toEqual([]);
        // Repo oracle (serverResponseMatrix.outbox.test.ts expectationFor
        // 'wrong_shape_2xx'): "the shot/trial batches must fall back to
        // transient (no receipt, no attempt burned)". Observed: 3 attempts.
        expect(row?.attempts).toBe(0);
      } finally {
        db.close();
      }
    },
  );
});

// ─── never-resolves at the SyncTransport seam (by design) ────────────────────

describe('never-resolving transport (fake timers, 60s)', () => {
  afterEach(() => {
    jest.useRealTimers();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  });

  test('a SyncTransport method that never settles leaves the drain pending after 60s with the queue untouched (timeouts belong to the transport layer — see the api.ts stress test)', async () => {
    jest.useFakeTimers();
    setActiveDataOwner(GUEST_DATA_OWNER);
    const plan = buildPlan(7, {
      allowHang: false,
      allowDbFaults: false,
      allowOwnerSwitch: false,
    });
    const rng = makeRng(7);
    const hung = {
      ...plan,
      rows: [
        buildRow(rng, 'r0', 'shot_ok', null),
        buildRow(rng, 'r1', 'shot_ok', null),
        buildRow(rng, 'r2', 'trial_ok', null),
      ],
      transport: { ...plan.transport, syncShots: 'never_resolves' as const },
    };
    const db = new SqliteStressDb({ yieldMode: 'micro' });
    try {
      loadQueue(db, hung);
      const before = db.outboxRows();
      const server = buildTransport(hung, makeRng(7));
      let settled = false;
      const drain = drainOutbox(db, server.transport).then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await jest.advanceTimersByTimeAsync(60_000);
      expect(settled).toBe(false);
      const shotRows = before.filter(
        row => row.kind === 'shot.sync' && row.owner_key === plan.owner,
      );
      const after = db.outboxRows();
      for (const row of shotRows) {
        expect(after.find(candidate => candidate.id === row.id)).toEqual(row);
      }
      expect(db.isInTransaction()).toBe(false);
      void drain;
    } finally {
      db.close();
    }
  });

  test('every other transport fault class settles within one fake-timer minute', async () => {
    jest.useFakeTimers();
    setActiveDataOwner(GUEST_DATA_OWNER);
    for (const fault of TRANSPORT_FAULTS) {
      if (fault === 'never_resolves') continue;
      const plan = buildPlan(11, {
        allowHang: false,
        allowDbFaults: false,
        allowOwnerSwitch: false,
      });
      const forced = {
        ...plan,
        transport: {
          createSession: fault,
          finalizeSession: fault,
          syncShots: fault,
          uploadEvaluationTrials: fault,
          trialsUnsupported: false,
          partialMask: plan.transport.partialMask,
        },
      };
      const db = new SqliteStressDb({ yieldMode: 'micro' });
      try {
        loadQueue(db, forced);
        const server = buildTransport(forced, makeRng(11));
        let settlement: 'pending' | 'resolved' | 'rejected' = 'pending';
        const drain = drainOutbox(db, server.transport).then(
          () => {
            settlement = 'resolved';
          },
          () => {
            settlement = 'rejected';
          },
        );
        await jest.advanceTimersByTimeAsync(60_000);
        await drain.catch(() => {});
        expect({ fault, settlement }).toEqual({
          fault,
          settlement: 'resolved',
        });
        expect(db.isInTransaction()).toBe(false);
        expect(db.integrityCheck()).toBe('ok');
        expect(expectedOutcome(forced).settlement).toBe('resolved');
      } finally {
        db.close();
      }
    }
  });
});
