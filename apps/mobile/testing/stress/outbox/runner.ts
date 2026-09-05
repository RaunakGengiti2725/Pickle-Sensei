/**
 * Executes a seeded action sequence against the REAL `drainOutbox()` and
 * model-checks the invariants after EVERY action.
 *
 * Invariants (each violation names its id):
 *
 *   I1  no-unacknowledged-delete — a row leaves `outbox` only if the server
 *       acknowledged its entity in this action (session call resolved,
 *       shot id ∈ acceptedIds, trial id ∈ acceptedTrialIds).
 *   I2  receipt-atomicity — every deleted shot row has a sync_receipt for
 *       its shot id, and every NEW receipt belongs to a shot id the server
 *       accepted in this action, for the active owner.
 *   I3  no-open-transaction — no transaction is left open after the drains
 *       settle (also when the local DB threw mid-transaction).
 *   I4  owner-isolation — rows and receipts of every non-active owner are
 *       byte-identical before/after, and no transport call carries another
 *       owner's entity id.
 *   I5  dead-rows-frozen — rows with attempts ≥ OUTBOX_MAX_ATTEMPTS are
 *       never sent and never change.
 *   I6  bounded-attempts — attempts never decrease and grow by at most one
 *       per drain that ran; a locally valid row whose every transport
 *       outcome in this action was transient keeps its attempts.
 *   I7  batch-shape — ≤ 50 ids per batch call; every id sent was eligible
 *       (active owner, attempts < max); within one drain, session calls
 *       precede the shot batch which precedes the trial upload; at most one
 *       shot batch and one trial upload per drain.
 *   I8  reference-model — for an isolated, fault-free drain the durable
 *       state, receipts, transport calls and `{synced, failed, remaining}`
 *       equal the model in model.ts exactly.
 *   I9  fault-containment — a drain aborted by a local-database fault
 *       rejects (never resolves with fabricated counts) or resolves; either
 *       way I1–I7 hold and durable rows only move to states the model allows
 *       (deleted-with-receipt, attempts +0/+1).
 *   I10 determinism — the same seed yields a byte-identical trace.
 *
 * Test-only harness; never imported by production code.
 */
import { drainOutbox, OUTBOX_MAX_ATTEMPTS } from '../../../src/data/sync';
import { seededRandom } from '../../xcBehavioral/evidence';
import type {
  Action,
  DrainPolicy,
  EnqueueAction,
  Owner,
  Sequence,
} from './actions';
import {
  OWNER_A,
  behaviorMayConsumeAttempt,
  endpointMayConsumeAttempt,
  uuidFrom,
} from './actions';
import type { OutboxRowState, ReceiptState, StressDb } from './backends';
import { buildPayload, expectDrain, matchesError } from './model';
import type { TransportCall } from './transport';
import { createScriptedTransport } from './transport';

export interface Violation {
  invariant: string;
  step: number;
  action: Action;
  detail: string;
}

export interface DrainOutcome {
  drain: number;
  resolved: boolean;
  result?: { synced: number; failed: number; remaining: number };
  error?: string;
}

export interface StepTrace {
  step: number;
  action: Action;
  drains: DrainOutcome[];
  calls: TransportCall[];
  rows: OutboxRowState[];
  receipts: ReceiptState[];
  faultFired?: boolean;
}

export interface RunResult {
  seed: number;
  length: number;
  backend: StressDb['name'];
  violations: Violation[];
  trace: StepTrace[];
  drainsRun: number;
  /** Which states the sequence actually reached (aggregated into the artifact). */
  coverage: Record<string, number>;
}

const rowKey = (row: OutboxRowState): string => JSON.stringify(row);

const isDrainActionType = (type: Action['type']): boolean =>
  type === 'drain' || type === 'concurrentDrain' || type === 'faultDrain';

function entityIdOf(row: OutboxRowState): string | null {
  try {
    const parsed = JSON.parse(row.payload) as unknown;
    if (parsed === null || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    const id =
      row.kind === 'evaluation.trial' ? record['trialId'] : record['id'];
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}

function policyIsAllTransient(policy: DrainPolicy): boolean {
  return (
    !policy.session.some(endpointMayConsumeAttempt) &&
    !behaviorMayConsumeAttempt(policy.shots) &&
    (policy.trials === 'absent' || !behaviorMayConsumeAttempt(policy.trials))
  );
}

function rowLocallyValid(row: OutboxRowState): boolean {
  try {
    const parsed = JSON.parse(row.payload) as unknown;
    if (parsed === null || typeof parsed !== 'object') return false;
    const record = parsed as Record<string, unknown>;
    switch (row.kind) {
      case 'shot.sync': {
        const permit = record['analysisPermitId'];
        return (
          typeof permit === 'string' &&
          permit.trim().length > 0 &&
          Array.isArray(record['checkpoints']) &&
          typeof record['id'] === 'string'
        );
      }
      case 'evaluation.trial':
        return typeof record['trialId'] === 'string';
      case 'session.create':
      case 'session.finalize':
        return true;
      default:
        return false;
    }
  } catch {
    return false;
  }
}

export interface RunOptions {
  backend: StressDb;
  /** Called with the owner the sequence activates; wires accountScope.setActiveDataOwner. */
  setOwner: (owner: string) => void;
}

export async function runSequence(
  sequence: Sequence,
  options: RunOptions,
): Promise<RunResult> {
  const { backend } = options;
  const random = seededRandom(sequence.seed ^ 0x5bd1e995);
  const violations: Violation[] = [];
  const trace: StepTrace[] = [];
  let activeOwner: Owner = OWNER_A;
  options.setOwner(activeOwner);
  let drainCounter = 0;
  let drainsRun = 0;
  const knownSessions = new Map<string, string[]>();
  const knownShots = new Map<string, string[]>();
  const coverage: Record<string, number> = {};
  const cover = (key: string, by = 1) => {
    coverage[key] = (coverage[key] ?? 0) + by;
  };

  const violate = (
    invariant: string,
    step: number,
    action: Action,
    detail: string,
  ) => {
    violations.push({ invariant, step, action, detail });
  };

  const enqueueOne = (action: EnqueueAction) => {
    const owner = action.owner === 'active' ? activeOwner : action.owner;
    const built = buildPayload(action, {
      uuid: () => uuidFrom(random),
      knownSessionId: () => {
        const list = knownSessions.get(owner) ?? [];
        return list.length ? list[Math.floor(random() * list.length)]! : null;
      },
      knownShotId: () => {
        const list = knownShots.get(owner) ?? [];
        return list.length ? list[Math.floor(random() * list.length)]! : null;
      },
    });
    backend.insert(owner, action.kind, built.payload, action.attempts);
    cover(`enqueue.${action.kind}.${action.variant}`);
    if (built.entityId !== null) {
      if (action.kind === 'session.create') {
        knownSessions.set(owner, [
          ...(knownSessions.get(owner) ?? []),
          built.entityId,
        ]);
      } else if (action.kind === 'shot.sync') {
        knownShots.set(owner, [
          ...(knownShots.get(owner) ?? []),
          built.entityId,
        ]);
      }
    }
  };

  for (let step = 0; step < sequence.actions.length; step += 1) {
    const action = sequence.actions[step]!;
    const rowsBefore = backend.rows();
    const receiptsBefore = backend.receipts();
    const calls: TransportCall[] = [];
    const drains: DrainOutcome[] = [];
    let faultFired: boolean | undefined;
    let policiesInAction: DrainPolicy[] = [];

    if (action.type === 'switchOwner') {
      activeOwner = action.owner;
      options.setOwner(activeOwner);
      cover(`switchOwner.${action.owner}`);
    } else if (action.type === 'enqueue') {
      enqueueOne(action);
    } else if (action.type === 'enqueueBurst') {
      for (const row of action.rows) enqueueOne(row);
      cover('enqueueBurst');
    } else {
      const eligibleNow = rowsBefore.filter(
        row =>
          row.owner_key === activeOwner && row.attempts < OUTBOX_MAX_ATTEMPTS,
      ).length;
      cover(`drain.${action.type}`);
      if (eligibleNow === 0) cover('drain.emptyOutbox');
      if (eligibleNow > 50) cover('drain.windowOverflow');
      if (rowsBefore.some(row => row.attempts >= OUTBOX_MAX_ATTEMPTS)) {
        cover('drain.withDeadRows');
      }
      policiesInAction =
        action.type === 'concurrentDrain' ? action.policies : [action.policy];
      if (action.type === 'faultDrain') {
        backend.failNext(action.fault.needle, new Error(action.fault.message));
      }
      const runOne = async (policy: DrainPolicy): Promise<DrainOutcome> => {
        drainCounter += 1;
        const drain = drainCounter;
        const transport = createScriptedTransport(drain, policy, calls);
        try {
          const result = await drainOutbox(backend.db, transport);
          return { drain, resolved: true, result };
        } catch (error) {
          return { drain, resolved: false, error: String(error) };
        }
      };
      const outcomes = await Promise.all(policiesInAction.map(runOne));
      drains.push(...outcomes);
      drainsRun += outcomes.length;
      if (action.type === 'faultDrain') {
        faultFired = backend.pendingFaults() === 0;
        backend.clearFaults();
        cover(
          faultFired
            ? `fault.fired.${action.fault.needle}`
            : 'fault.notReached',
        );
      }
      for (const outcome of outcomes) {
        cover(outcome.resolved ? 'drain.resolved' : 'drain.rejected');
        if (outcome.result && outcome.result.synced > 0)
          cover('drain.syncedSome');
        if (outcome.result && outcome.result.failed > 0)
          cover('drain.failedSome');
      }
      for (const call of calls) {
        cover(`call.${call.endpoint}.${call.outcome}`);
        if (call.outcome === 'threw' || call.outcome === 'malformed') {
          cover(`call.detail.${call.detail}`);
        }
      }
    }

    const rowsAfter = backend.rows();
    const receiptsAfter = backend.receipts();
    if (isDrainActionType(action.type)) {
      const beforeIds = new Set(rowsBefore.map(row => row.id));
      const deleted =
        rowsBefore.length -
        rowsAfter.filter(row => beforeIds.has(row.id)).length;
      if (deleted > 0) cover('rows.deleted', deleted);
      for (const row of rowsAfter) {
        const prior = rowsBefore.find(candidate => candidate.id === row.id);
        if (!prior) continue;
        if (row.attempts > prior.attempts) cover('rows.attemptSpent');
        else if (row.last_error !== prior.last_error)
          cover('rows.transientRetry');
        if (
          action.type === 'concurrentDrain' &&
          row.last_error !== prior.last_error &&
          row.last_error?.includes('within a transaction')
        ) {
          cover('concurrent.nestedBeginObserved');
        }
        if (
          row.attempts >= OUTBOX_MAX_ATTEMPTS &&
          prior.attempts < OUTBOX_MAX_ATTEMPTS
        ) {
          cover('rows.becameDead');
        }
      }
    }
    const beforeById = new Map(rowsBefore.map(row => [row.id, row]));
    const afterById = new Map(rowsAfter.map(row => [row.id, row]));
    const isDrainAction = policiesInAction.length > 0;

    if (isDrainAction) {
      const acceptedShots = new Set<string>();
      const acceptedTrials = new Set<string>();
      const resolvedSessions = new Set<string>();
      for (const call of calls) {
        if (call.endpoint === 'syncShots')
          call.accepted.forEach(id => acceptedShots.add(id));
        else if (call.endpoint === 'uploadEvaluationTrials')
          call.accepted.forEach(id => acceptedTrials.add(id));
        else if (call.outcome === 'resolved') {
          for (const id of call.ids) resolvedSessions.add(String(id));
        }
      }

      // I1 + I2 (deleted side)
      const receiptKeys = new Set(
        receiptsAfter.map(r => `${r.owner_key}|${r.entity_id}`),
      );
      for (const before of rowsBefore) {
        if (afterById.has(before.id)) continue;
        const entity = entityIdOf(before);
        if (before.owner_key !== activeOwner) {
          violate(
            'I4',
            step,
            action,
            `row ${before.id} of ${before.owner_key} deleted while ${activeOwner} active`,
          );
          continue;
        }
        if (before.kind === 'shot.sync') {
          if (entity === null || !acceptedShots.has(entity)) {
            violate(
              'I1',
              step,
              action,
              `shot row ${before.id} (${entity}) deleted without acceptance`,
            );
          }
          if (entity !== null && !receiptKeys.has(`${activeOwner}|${entity}`)) {
            violate(
              'I2',
              step,
              action,
              `shot row ${before.id} deleted but no receipt for ${entity}`,
            );
          }
        } else if (before.kind === 'evaluation.trial') {
          if (entity === null || !acceptedTrials.has(entity)) {
            violate(
              'I1',
              step,
              action,
              `trial row ${before.id} (${entity}) deleted without acceptance`,
            );
          }
        } else if (
          before.kind === 'session.create' ||
          before.kind === 'session.finalize'
        ) {
          const sessionId = (() => {
            try {
              const parsed = JSON.parse(before.payload) as Record<
                string,
                unknown
              > | null;
              return String(parsed?.['id']);
            } catch {
              return null;
            }
          })();
          if (sessionId === null || !resolvedSessions.has(sessionId)) {
            violate(
              'I1',
              step,
              action,
              `session row ${before.id} deleted without a resolved call`,
            );
          }
        } else {
          violate('I1', step, action, `unknown-kind row ${before.id} deleted`);
        }
      }
      // I2 (receipt side)
      const beforeReceiptKeys = new Set(
        receiptsBefore.map(r => `${r.owner_key}|${r.entity_id}`),
      );
      for (const receipt of receiptsAfter) {
        const key = `${receipt.owner_key}|${receipt.entity_id}`;
        if (beforeReceiptKeys.has(key)) continue;
        if (receipt.owner_key !== activeOwner) {
          violate(
            'I4',
            step,
            action,
            `receipt for ${receipt.owner_key} written while ${activeOwner} active`,
          );
        } else if (!acceptedShots.has(receipt.entity_id)) {
          violate(
            'I2',
            step,
            action,
            `receipt ${receipt.entity_id} written without acceptance`,
          );
        }
      }
      // I3
      if (backend.inTransaction()) {
        violate(
          'I3',
          step,
          action,
          'transaction still open after drains settled',
        );
      }
      // I4 rows of other owners + transport ids
      const foreignBefore = rowsBefore
        .filter(r => r.owner_key !== activeOwner)
        .map(rowKey);
      const foreignAfter = rowsAfter
        .filter(r => r.owner_key !== activeOwner)
        .map(rowKey);
      if (JSON.stringify(foreignBefore) !== JSON.stringify(foreignAfter)) {
        violate('I4', step, action, 'non-active owner rows changed');
      }
      const eligibleEntities = new Set<string>();
      const eligibleIds = new Set<number>();
      for (const row of rowsBefore) {
        if (
          row.owner_key === activeOwner &&
          row.attempts < OUTBOX_MAX_ATTEMPTS
        ) {
          eligibleIds.add(row.id);
          const entity = entityIdOf(row);
          if (entity !== null) eligibleEntities.add(entity);
        }
      }
      // rows another concurrent drain enqueued cannot appear mid-action, so
      // the eligible set is exactly rowsBefore-derived.
      for (const call of calls) {
        if (
          call.endpoint === 'syncShots' ||
          call.endpoint === 'uploadEvaluationTrials'
        ) {
          if (call.ids.length > 50) {
            violate(
              'I7',
              step,
              action,
              `${call.endpoint} carried ${call.ids.length} ids`,
            );
          }
        }
        for (const id of call.ids) {
          if (typeof id !== 'string' || id === 'undefined') continue;
          if (!eligibleEntities.has(id)) {
            const foreign = rowsBefore.find(
              row => entityIdOf(row) === id && row.owner_key !== activeOwner,
            );
            if (foreign) {
              violate(
                'I4',
                step,
                action,
                `${call.endpoint} carried ${id} owned by ${foreign.owner_key}`,
              );
            } else {
              violate(
                'I7',
                step,
                action,
                `${call.endpoint} carried ineligible id ${id}`,
              );
            }
          }
        }
      }
      // I7 ordering per drain
      const rank = {
        createSession: 0,
        finalizeSession: 0,
        syncShots: 1,
        uploadEvaluationTrials: 2,
      } as const;
      const perDrain = new Map<number, TransportCall[]>();
      for (const call of calls) {
        perDrain.set(call.drain, [...(perDrain.get(call.drain) ?? []), call]);
      }
      for (const [drain, drainCalls] of perDrain) {
        let last = -1;
        let shotBatches = 0;
        let trialBatches = 0;
        for (const call of drainCalls) {
          if (rank[call.endpoint] < last) {
            violate(
              'I7',
              step,
              action,
              `drain ${drain}: ${call.endpoint} after a later stage`,
            );
          }
          last = Math.max(last, rank[call.endpoint]);
          if (call.endpoint === 'syncShots') shotBatches += 1;
          if (call.endpoint === 'uploadEvaluationTrials') trialBatches += 1;
        }
        if (shotBatches > 1 || trialBatches > 1) {
          violate(
            'I7',
            step,
            action,
            `drain ${drain}: ${shotBatches} shot batches, ${trialBatches} trial batches`,
          );
        }
      }
      // I5 + I6
      const allTransient = policiesInAction.every(policyIsAllTransient);
      for (const before of rowsBefore) {
        const after = afterById.get(before.id);
        if (!after) continue;
        if (before.owner_key !== activeOwner) continue;
        if (before.attempts >= OUTBOX_MAX_ATTEMPTS) {
          if (rowKey(before) !== rowKey(after)) {
            violate('I5', step, action, `dead row ${before.id} changed`);
          }
          const entity = entityIdOf(before);
          if (
            entity !== null &&
            !eligibleEntities.has(entity) &&
            calls.some(call => call.ids.includes(entity))
          ) {
            violate('I5', step, action, `dead row ${before.id} was sent`);
          }
          continue;
        }
        const delta = after.attempts - before.attempts;
        if (delta < 0 || delta > policiesInAction.length) {
          violate(
            'I6',
            step,
            action,
            `row ${before.id} attempts ${before.attempts}→${after.attempts} across ${policiesInAction.length} drains`,
          );
        }
        if (
          delta > 0 &&
          allTransient &&
          rowLocallyValid(before) &&
          before.kind !== 'unknown' &&
          action.type !== 'faultDrain'
        ) {
          violate(
            'I6',
            step,
            action,
            `row ${before.id} spent an attempt under all-transient outcomes (${after.last_error})`,
          );
        }
      }
      // I8 exact reference model for isolated fault-free drains
      if (action.type === 'drain') {
        const expected = expectDrain(activeOwner, rowsBefore, action.policy);
        const outcome = drains[0]!;
        if (!outcome.resolved) {
          violate('I8', step, action, `drain rejected: ${outcome.error}`);
        } else if (
          JSON.stringify(outcome.result) !== JSON.stringify(expected.result)
        ) {
          violate(
            'I8',
            step,
            action,
            `result ${JSON.stringify(outcome.result)} ≠ model ${JSON.stringify(expected.result)}`,
          );
        }
        const expectedIds = expected.rows.map(r => r.id);
        const actualIds = rowsAfter.map(r => r.id);
        if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds)) {
          violate(
            'I8',
            step,
            action,
            `surviving rows ${JSON.stringify(actualIds)} ≠ model ${JSON.stringify(expectedIds)}`,
          );
        } else {
          for (const expectedRow of expected.rows) {
            const before = beforeById.get(expectedRow.id)!;
            const after = afterById.get(expectedRow.id)!;
            if (after.attempts !== expectedRow.attempts) {
              violate(
                'I8',
                step,
                action,
                `row ${after.id} attempts ${after.attempts} ≠ model ${expectedRow.attempts}`,
              );
            }
            if (
              !matchesError(
                after.last_error,
                expectedRow.lastError,
                before.last_error,
              )
            ) {
              violate(
                'I8',
                step,
                action,
                `row ${after.id} last_error ${JSON.stringify(after.last_error)} ≠ model ${JSON.stringify(expectedRow.lastError)}`,
              );
            }
            if (
              after.payload !== before.payload ||
              after.kind !== before.kind ||
              after.owner_key !== before.owner_key
            ) {
              violate(
                'I8',
                step,
                action,
                `row ${after.id} payload/kind/owner mutated`,
              );
            }
          }
        }
        const expectedReceiptKeys = new Set([
          ...receiptsBefore.map(r => `${r.owner_key}|${r.entity_id}`),
          ...expected.newReceipts.map(r => `${r.owner_key}|${r.entity_id}`),
        ]);
        const actualReceiptKeys = new Set(
          receiptsAfter.map(r => `${r.owner_key}|${r.entity_id}`),
        );
        if (
          expectedReceiptKeys.size !== actualReceiptKeys.size ||
          [...expectedReceiptKeys].some(key => !actualReceiptKeys.has(key))
        ) {
          violate(
            'I8',
            step,
            action,
            `receipts ${JSON.stringify([...actualReceiptKeys])} ≠ model ${JSON.stringify([...expectedReceiptKeys])}`,
          );
        }
        const actualCalls = calls.map(call => ({
          endpoint: call.endpoint,
          ids: call.ids,
        }));
        if (JSON.stringify(actualCalls) !== JSON.stringify(expected.calls)) {
          violate(
            'I8',
            step,
            action,
            `calls ${JSON.stringify(actualCalls)} ≠ model ${JSON.stringify(expected.calls)}`,
          );
        }
      }
      // I9 fault containment: every surviving row is either unchanged, or
      // changed like a recorded failure (attempts +0/+1, last_error set).
      if (action.type === 'faultDrain' || action.type === 'concurrentDrain') {
        for (const before of rowsBefore) {
          const after = afterById.get(before.id);
          if (!after || before.owner_key !== activeOwner) continue;
          if (rowKey(before) === rowKey(after)) continue;
          if (after.payload !== before.payload || after.kind !== before.kind) {
            violate(
              'I9',
              step,
              action,
              `row ${before.id} payload/kind mutated`,
            );
          }
          if (
            after.attempts !== before.attempts &&
            after.last_error === before.last_error &&
            after.last_error === null
          ) {
            violate(
              'I9',
              step,
              action,
              `row ${before.id} attempts moved without last_error`,
            );
          }
        }
        for (const outcome of drains) {
          if (outcome.resolved && outcome.result) {
            const { synced, failed, remaining } = outcome.result;
            const ownerRows = rowsAfter.filter(
              r => r.owner_key === activeOwner,
            ).length;
            if (synced < 0 || failed < 0 || remaining < 0) {
              violate(
                'I9',
                step,
                action,
                `negative counts ${JSON.stringify(outcome.result)}`,
              );
            }
            if (action.type === 'faultDrain' && remaining !== ownerRows) {
              violate(
                'I9',
                step,
                action,
                `remaining ${remaining} ≠ owner rows ${ownerRows}`,
              );
            }
          }
        }
      }
    } else {
      // enqueue / switchOwner must not touch receipts or other rows
      if (JSON.stringify(receiptsBefore) !== JSON.stringify(receiptsAfter)) {
        violate('I4', step, action, 'receipts changed without a drain');
      }
    }

    trace.push({
      step,
      action,
      drains,
      calls,
      rows: rowsAfter,
      receipts: receiptsAfter,
      ...(faultFired === undefined ? {} : { faultFired }),
    });
  }

  return {
    seed: sequence.seed,
    length: sequence.actions.length,
    backend: backend.name,
    violations,
    trace,
    drainsRun,
    coverage,
  };
}

export function traceDigest(result: RunResult): string {
  return JSON.stringify(result.trace);
}

/**
 * Greedy 1-minimal reduction: repeatedly drop single actions while the
 * reduced sequence still violates the same invariant.
 */
export async function minimizeSequence(
  sequence: Sequence,
  invariant: string,
  run: (candidate: Sequence) => Promise<RunResult>,
): Promise<{ sequence: Sequence; runs: number }> {
  let current = sequence.actions;
  let runs = 0;
  let progress = true;
  while (progress && current.length > 1) {
    progress = false;
    for (let index = 0; index < current.length; index += 1) {
      const candidate = [
        ...current.slice(0, index),
        ...current.slice(index + 1),
      ];
      runs += 1;
      const result = await run({ seed: sequence.seed, actions: candidate });
      if (result.violations.some(v => v.invariant === invariant)) {
        current = candidate;
        progress = true;
        index -= 1;
      }
    }
  }
  return { sequence: { seed: sequence.seed, actions: current }, runs };
}
