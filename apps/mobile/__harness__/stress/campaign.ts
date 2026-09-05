/**
 * Iteration runner + artifact sink for the mod-sync-outbox stress campaigns.
 *
 * Every iteration is a pure function of its seed (plan, scheduler, transport
 * randomness). The row table is written under
 * `<repo>/artifacts/stress/mod-sync-outbox-failure-injection/<run>/` (the
 * `artifacts/` tree is gitignored); override the run id with STRESS_RUN_ID.
 */
import {
  GUEST_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  drainOutbox,
  OUTBOX_MAX_ATTEMPTS,
  type SyncTransport,
} from '../../src/data/sync';
import {
  fs,
  nodeProcess,
  path,
} from '../../xc-harness/lifecycle-persistence/nodeShim';
import {
  buildPlan,
  buildTransport,
  expectedOutcome,
  loadQueue,
  makeRng,
  modelViolations,
  pick,
  structuralViolations,
  type DrainObservation,
  type InjectionPlan,
  type LoadedQueue,
  type PlanOptions,
  type RowKind,
  type Violation,
} from './faultInjection';
import {
  SqliteStressDb,
  type OutboxRowSnapshot,
  type ReceiptSnapshot,
  type YieldMode,
} from './sqliteLocalDb';

declare const __dirname: string;
declare const setImmediate: (callback: () => void) => unknown;
declare const setTimeout: (callback: () => void, ms: number) => TimerHandle;
declare const clearTimeout: (handle: TimerHandle) => void;
type TimerHandle = { unref?: () => void } | number;

export const STRESS_ITER_DEFAULT = 120;
export const CONCURRENT_ITER_DEFAULT = 60;

export function envInt(name: string, fallback: number): number {
  const raw = nodeProcess.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

export function replaySeed(): number | null {
  const raw = nodeProcess.env['STRESS_SEED'];
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value >>> 0 : null;
}

export function artifactDir(): string {
  const runId = nodeProcess.env['STRESS_RUN_ID'] ?? 'latest';
  const dir = path.resolve(
    __dirname,
    '../../../../artifacts/stress/mod-sync-outbox-failure-injection',
    runId,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeArtifact(name: string, value: unknown): string {
  const file = path.join(artifactDir(), name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return file;
}

// ─── deadline-raced drain ────────────────────────────────────────────────────

const HUNG = Symbol('hung');
export const HARD_DEADLINE_MS = 5_000;

function flush(macrotasks: number): Promise<void> {
  let chain = Promise.resolve();
  for (let index = 0; index < macrotasks; index += 1) {
    chain = chain.then(
      () => new Promise<void>(resolve => setImmediate(resolve)),
    );
  }
  return chain.then(
    () => new Promise<void>(resolve => setTimeout(resolve, 25)),
  );
}

/**
 * Runs one drain. A `hang` signal (transport `never_resolves` / db `hang`)
 * short-circuits the wait: once the event loop has drained a few times after
 * the signal with no settlement, the drain is classified `hung`. A hard
 * wall-clock deadline backs that up so a genuinely stuck drain cannot stall
 * the suite.
 */
export async function drainWithDeadline(
  db: SqliteStressDb,
  transport: SyncTransport,
  hangSignal: Promise<void>,
  hardDeadlineMs = HARD_DEADLINE_MS,
): Promise<DrainObservation> {
  let timer: TimerHandle | null = null;
  const deadline = new Promise<typeof HUNG>(resolve => {
    timer = setTimeout(() => resolve(HUNG), hardDeadlineMs);
    if (typeof timer === 'object' && timer.unref) timer.unref();
  });
  const afterHang = hangSignal.then(() => flush(4)).then(() => HUNG);
  const drain = drainOutbox(db, transport).then(
    result => ({ settlement: 'resolved' as const, result, error: null }),
    (error: unknown) => ({
      settlement: 'rejected' as const,
      result: null,
      error: describeError(error),
    }),
  );
  try {
    const outcome = await Promise.race([drain, afterHang, deadline]);
    if (typeof outcome === 'symbol') {
      return { settlement: 'hung', result: null, error: null };
    }
    return outcome;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

// ─── single-drain iteration ──────────────────────────────────────────────────

export const YIELD_MODES: readonly YieldMode[] = [
  'none',
  'micro',
  'macro',
  'mixed',
];

export interface IterationRow {
  seed: number;
  yieldMode: YieldMode;
  injectedFaults: number;
  plan: {
    rows: string[];
    otherOwnerRows: number;
    exhaustedRows: number;
    transport: InjectionPlan['transport'];
    dbFault: InjectionPlan['dbFault'];
    ownerSwitch: InjectionPlan['ownerSwitch'];
  };
  settlement: DrainObservation['settlement'];
  result: DrainObservation['result'];
  error: string | null;
  /** The hung drain was parked inside BEGIN; the harness rolled it back. */
  abortedTransaction: boolean;
  transportCalls: string[];
  statements: string[];
  firedDbFaults: number;
  outboxAfter: Array<{
    id: number;
    owner: string;
    kind: string;
    attempts: number;
    last_error: string | null;
  }>;
  receipts: string[];
  expected: {
    settlement: string;
    synced: number;
    failed: number;
    unmodeled: boolean;
    knownDeviations: string[];
  };
  /** Healthy re-drain after the faults were lifted (null when the faulty
   * drain is parked inside its own transaction). */
  recovery: {
    settlement: string;
    result: DrainObservation['result'];
    error: string | null;
    outboxAfter: Array<{
      id: number;
      kind: string;
      attempts: number;
      last_error: string | null;
    }>;
    receipts: string[];
  } | null;
  violations: Violation[];
  /** Violations not attributed to a pinned finding — the campaign fails on these. */
  unknownViolations: Violation[];
  /** HELD | BROKEN(<finding ids>) | BROKEN(unknown) */
  outcome: string;
  durationMs: number;
  replay: string;
}

export function summarizeOutcome(violations: Violation[]): string {
  if (violations.length === 0) return 'HELD';
  const findings = [
    ...new Set(violations.map(violation => violation.finding ?? 'unknown')),
  ].sort();
  return `BROKEN(${findings.join(',')})`;
}

export async function runSingleDrainIteration(
  seed: number,
  options: PlanOptions = {},
  testFile = '__tests__/stress/modSyncOutbox.failureInjection.stress.test.ts',
): Promise<IterationRow> {
  const started = Date.now();
  const plan = buildPlan(seed, { allowHang: true, ...options });
  const scheduler = makeRng(seed ^ 0x51ab5eed);
  const yieldMode = pick(scheduler, YIELD_MODES);
  let signalHang: () => void = () => {};
  const hangSignal = new Promise<void>(resolve => {
    signalHang = resolve;
  });
  const db = new SqliteStressDb({
    rng: scheduler,
    yieldMode,
    faults: plan.dbFault ? [plan.dbFault] : [],
    onHang: () => signalHang(),
  });
  try {
    const queue = loadQueue(db, plan);
    const before = db.outboxRows();
    setActiveDataOwner(plan.owner);
    const server = buildTransport(plan, makeRng(seed ^ 0x7a1e5), callIndex => {
      const call = server.calls[callIndex - 1];
      if (call?.fault === 'never_resolves') signalHang();
      if (plan.ownerSwitch && callIndex === plan.ownerSwitch.afterCall) {
        setActiveDataOwner(plan.ownerSwitch.to);
      }
    });
    const observation = await drainWithDeadline(
      db,
      server.transport,
      hangSignal,
    );
    // Let any detached continuation land before reading the tables.
    await new Promise<void>(resolve => setImmediate(resolve));
    // A drain parked forever inside its own BEGIN (SQLite never answered the
    // INSERT/DELETE/COMMIT) is what a process death mid-transaction looks
    // like: the uncommitted writes must vanish. Roll them back the way the
    // engine would on reopen, then judge the durable state.
    const abortedTransaction =
      observation.settlement === 'hung' && plan.dbFault?.mode === 'hang'
        ? db.abortOpenTransaction()
        : false;
    const after = db.outboxRows();
    const receipts = db.receipts();
    const expected = expectedOutcome(plan);
    const violations = [
      ...structuralViolations({
        before,
        after,
        receipts,
        queue,
        owner: plan.owner,
        accepted: server.accepted,
        drains: 1,
        inTransaction: db.isInTransaction(),
        integrity: db.integrityCheck(),
      }),
      ...modelViolations({
        expected,
        observation,
        after,
        receipts,
        queue,
        owner: plan.owner,
      }),
    ];

    // Recovery: faults lifted, a healthy drain must converge the queue.
    let recovery: IterationRow['recovery'] = null;
    {
      setActiveDataOwner(plan.owner);
      db.clearFaults();
      const healthy = buildTransport(
        {
          ...plan,
          transport: {
            createSession: 'ok',
            finalizeSession: 'ok',
            syncShots: 'ok',
            uploadEvaluationTrials: 'ok',
            trialsUnsupported: false,
            partialMask: 0xffff,
          },
        },
        makeRng(seed ^ 0x4ea1),
      );
      const recovered = await drainWithDeadline(
        db,
        healthy.transport,
        new Promise(() => {}),
      );
      await new Promise<void>(resolve => setImmediate(resolve));
      const finalRows = db.outboxRows();
      const finalReceipts = db.receipts();
      const acceptedByEither = new Set([
        ...server.accepted,
        ...healthy.accepted,
      ]);
      const recoveryViolations = [
        ...structuralViolations({
          before,
          after: finalRows,
          receipts: finalReceipts,
          queue,
          owner: plan.owner,
          accepted: acceptedByEither,
          drains: 2,
          inTransaction: db.isInTransaction(),
          integrity: db.integrityCheck(),
        }).map(violation => ({
          ...violation,
          code: `recovery_${violation.code}`,
        })),
        ...convergenceViolations(
          plan,
          queue,
          finalRows,
          finalReceipts,
          recovered,
        ),
      ];
      violations.push(...recoveryViolations);
      recovery = {
        settlement: recovered.settlement,
        result: recovered.result,
        error: recovered.error,
        outboxAfter: finalRows
          .filter(row => row.owner_key === plan.owner)
          .map(row => ({
            id: row.id,
            kind: row.kind,
            attempts: row.attempts,
            last_error: row.last_error,
          })),
        receipts: finalReceipts.map(
          receipt => `${receipt.owner_key}/${receipt.entity_id}`,
        ),
      };
    }
    const unknownViolations = violations.filter(
      violation => !violation.finding,
    );
    // Count a planned SQLite fault only when the drain actually reached it.
    const injectedFaults =
      plan.injectedFaults -
      (plan.dbFault && db.firedFaults.length === 0 ? 1 : 0);
    return {
      seed,
      yieldMode,
      injectedFaults,
      plan: {
        rows: plan.rows.map(row => `${row.label}:${row.kind}@${row.attempts}`),
        otherOwnerRows: plan.otherOwnerRows.length,
        exhaustedRows: plan.exhaustedRows.length,
        transport: plan.transport,
        dbFault: plan.dbFault,
        ownerSwitch: plan.ownerSwitch,
      },
      settlement: observation.settlement,
      result: observation.result,
      error: observation.error,
      abortedTransaction,
      transportCalls: server.calls.map(
        call => `${call.method}[${call.ids.length}]→${call.fault}`,
      ),
      statements: db.classes(),
      firedDbFaults: db.firedFaults.length,
      outboxAfter: after.map(row => ({
        id: row.id,
        owner: row.owner_key,
        kind: row.kind,
        attempts: row.attempts,
        last_error: row.last_error,
      })),
      receipts: receipts.map(
        receipt => `${receipt.owner_key}/${receipt.entity_id}`,
      ),
      expected: {
        settlement: expected.settlement,
        synced: expected.synced,
        failed: expected.failed,
        unmodeled: expected.unmodeled,
        knownDeviations: expected.knownDeviations,
      },
      recovery,
      violations,
      unknownViolations,
      outcome: summarizeOutcome(violations),
      durationMs: Date.now() - started,
      replay: `cd apps/mobile && STRESS_SEED=${seed} npx jest --ci ${testFile}`,
    };
  } finally {
    setActiveDataOwner(GUEST_DATA_OWNER);
    db.close();
  }
}

const VALID_ROW_KINDS: ReadonlySet<RowKind> = new Set<RowKind>([
  'session_create_ok',
  'session_finalize_ok',
  'shot_ok',
  'shot_duplicate',
  'trial_ok',
]);

/**
 * After the healthy drain: every valid row still inside the attempt window
 * is gone (shots with a receipt), every poison row is still there with at
 * least one attempt burned and an error recorded. F1 rows never burn.
 */
function convergenceViolations(
  plan: InjectionPlan,
  queue: LoadedQueue,
  finalRows: OutboxRowSnapshot[],
  finalReceipts: ReceiptSnapshot[],
  recovered: DrainObservation,
): Violation[] {
  const violations: Violation[] = [];
  if (recovered.settlement !== 'resolved') {
    violations.push({
      code: 'recovery_drain_did_not_resolve',
      detail: `${recovered.settlement}${recovered.error ? ` (${recovered.error})` : ''}`,
    });
  }
  const receiptIds = new Set(
    finalReceipts.filter(r => r.owner_key === plan.owner).map(r => r.entity_id),
  );
  for (const row of plan.rows) {
    const id = queue.ids.get(row.label);
    const present = finalRows.find(candidate => candidate.id === id);
    if (VALID_ROW_KINDS.has(row.kind)) {
      if (present && present.attempts < OUTBOX_MAX_ATTEMPTS) {
        violations.push({
          code: 'recovery_valid_row_not_drained',
          detail: `${row.label} (${row.kind}) attempts=${present.attempts} last_error=${present.last_error}`,
        });
      }
      if (
        !present &&
        row.outboxKind === 'shot.sync' &&
        !receiptIds.has(row.entityId ?? '')
      ) {
        violations.push({
          code: 'recovery_shot_deleted_without_receipt',
          detail: `${row.label} (${row.kind})`,
        });
      }
      continue;
    }
    if (!present) {
      violations.push({
        code: 'recovery_poison_row_lost',
        detail: `${row.label} (${row.kind}) disappeared`,
      });
      continue;
    }
    if (present.attempts < 1 || present.last_error === null) {
      violations.push({
        code: 'recovery_poison_row_not_burned',
        detail: `${row.label} (${row.kind}) attempts=${present.attempts} last_error=${present.last_error}`,
        ...(row.kind === 'session_finalize_null' ? { finding: 'F1' } : {}),
      });
    }
  }
  return violations;
}

// ─── concurrent-drain iteration ──────────────────────────────────────────────

export interface ConcurrentIterationRow {
  seed: number;
  drains: number;
  injectedFaults: number;
  plan: {
    rows: string[];
    transport: InjectionPlan['transport'];
    dbFault: InjectionPlan['dbFault'];
  };
  settlements: Array<{
    settlement: string;
    result: DrainObservation['result'];
    error: string | null;
  }>;
  transportCalls: string[];
  statements: string[];
  /** Errors raised by SQLite itself (not injected). */
  engineErrors: string[];
  /** SQLite refused a nested BEGIN — the only way two drains can collide. */
  nestedBeginRefusals: number;
  syncedReported: number;
  rowsDeleted: number;
  outboxAfter: Array<{
    id: number;
    kind: string;
    attempts: number;
    last_error: string | null;
  }>;
  receipts: string[];
  violations: Violation[];
  outcome: string;
  durationMs: number;
  replay: string;
}

export async function runConcurrentIteration(
  seed: number,
  options: PlanOptions = {},
  testFile = '__tests__/stress/modSyncOutbox.concurrentDrains.stress.test.ts',
): Promise<ConcurrentIterationRow> {
  const started = Date.now();
  const plan = buildPlan(seed, {
    allowHang: false,
    allowOwnerSwitch: false,
    minRows: 2,
    maxRows: 12,
    // Healthy transport most of the time so the drains actually reach the
    // receipt transaction and collide there (a failing request never does).
    okChance: 0.75,
    ...options,
  });
  const scheduler = makeRng(seed ^ 0xc0c0c0);
  const drains = 2 + Math.floor(scheduler() * 3);
  const db = new SqliteStressDb({
    rng: scheduler,
    yieldMode: 'mixed',
    faults: plan.dbFault ? [plan.dbFault] : [],
  });
  try {
    const queue = loadQueue(db, plan);
    const before = db.outboxRows();
    setActiveDataOwner(plan.owner);
    const server = buildTransport(plan, makeRng(seed ^ 0x7a1e5));
    const never = new Promise<void>(() => {});
    const settlements = await Promise.all(
      Array.from({ length: drains }, () =>
        drainWithDeadline(db, server.transport, never),
      ),
    );
    await new Promise<void>(resolve => setImmediate(resolve));
    const after = db.outboxRows();
    const receipts = db.receipts();
    const violations = structuralViolations({
      before,
      after,
      receipts,
      queue,
      owner: plan.owner,
      accepted: server.accepted,
      drains,
      concurrentRollback: db.classes().includes('rollback'),
      inTransaction: db.isInTransaction(),
      integrity: db.integrityCheck(),
    });
    for (const settlement of settlements) {
      if (settlement.settlement === 'hung') {
        violations.push({
          code: 'drain_hung',
          detail: 'a concurrent drain never settled',
        });
      }
    }
    const rowsDeleted = before.filter(
      row =>
        queue.byId.get(row.id)?.group === 'active' &&
        !after.some(a => a.id === row.id),
    ).length;
    const syncedReported = settlements.reduce(
      (sum, settlement) => sum + (settlement.result?.synced ?? 0),
      0,
    );
    const nestedBeginRefusals = db.engineErrors.filter(error =>
      error.includes('within a transaction'),
    ).length;
    return {
      seed,
      drains,
      injectedFaults: plan.injectedFaults,
      plan: {
        rows: plan.rows.map(row => `${row.label}:${row.kind}@${row.attempts}`),
        transport: plan.transport,
        dbFault: plan.dbFault,
      },
      settlements: settlements.map(settlement => ({
        settlement: settlement.settlement,
        result: settlement.result,
        error: settlement.error,
      })),
      transportCalls: server.calls.map(
        call => `${call.method}[${call.ids.length}]→${call.fault}`,
      ),
      statements: db.classes(),
      engineErrors: [...db.engineErrors],
      nestedBeginRefusals,
      syncedReported,
      rowsDeleted,
      outboxAfter: after
        .filter(row => row.owner_key === plan.owner)
        .map(row => ({
          id: row.id,
          kind: row.kind,
          attempts: row.attempts,
          last_error: row.last_error,
        })),
      receipts: receipts.map(
        receipt => `${receipt.owner_key}/${receipt.entity_id}`,
      ),
      violations,
      outcome: summarizeOutcome(violations),
      durationMs: Date.now() - started,
      replay: `cd apps/mobile && STRESS_SEED=${seed} npx jest --ci ${testFile}`,
    };
  } finally {
    setActiveDataOwner(GUEST_DATA_OWNER);
    db.close();
  }
}
