/**
 * Payload factory + reference model of a single, uninterrupted
 * `drainOutbox()` call, written from the contract documented in
 * src/data/sync.ts (comments on drainOutbox / recordRowFailure /
 * isPermanentSyncFailure / TRANSIENT_SYNC_REJECTION_CODES) and pinned by
 * __tests__/sync.test.ts and __tests__/serverResponseMatrix.outbox.test.ts:
 *
 *   M1  Only the active owner's rows with attempts < OUTBOX_MAX_ATTEMPTS are
 *       eligible, in id order, at most 50 per drain.
 *   M2  Session rows go first (each its own call), then every valid shot in
 *       ONE syncShots call, then evaluation trials in ONE upload call —
 *       and only when the transport implements uploadEvaluationTrials.
 *   M3  A row that cannot be parsed/encoded locally (bad JSON, null, no
 *       permit, missing fields, unknown kind) fails ALONE and permanently
 *       (attempts += 1) — it never poisons its neighbours.
 *   M4  Transport rejections: 4xx (except 401/408/429) → permanent for every
 *       row in the call; 401/408/429/5xx/non-ApiError throws → transient
 *       (last_error only, attempts unchanged).
 *   M5  Per-item verdicts: accepted → receipt + delete; rejected with a
 *       transient code (TRANSIENT_SYNC_REJECTION_CODES) → transient;
 *       rejected with any other code, or unacknowledged (neither list) →
 *       permanent. Acknowledgement is keyed by id: if the server both
 *       accepts and rejects an id, accept wins.
 *   M6  Malformed 2xx bodies: a body whose fields cannot be iterated throws
 *       inside the call → transient for every row; a well-shaped body that
 *       acknowledges nothing → permanent (unacknowledged).
 *   M7  Result counts: synced = rows deleted, failed = rows that recorded a
 *       failure, remaining = every row of the active owner afterwards
 *       (including dead rows and rows beyond the 50-row window).
 *
 * Test-only harness; never imported by production code.
 */
import { OUTBOX_MAX_ATTEMPTS } from '../../../src/data/sync';
import type { ShotAnalysis } from '@pickle/shared-types';
import type {
  BatchBehavior,
  DrainPolicy,
  EnqueueAction,
  EndpointBehavior,
  Thrown,
} from './actions';
import { TRANSIENT_REJECTION_CODES } from './actions';
import type { OutboxRowState, ReceiptState } from './backends';
import { FOREIGN_ID, serverVerdicts } from './transport';

const baseAnalysis: Omit<ShotAnalysis, 'id' | 'sessionId'> = {
  shotType: 'forehand_drive',
  cameraView: 'side',
  handedness: 'right',
  capturedAtIso: '2026-08-26T18:00:00.000Z',
  timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
  phases: [],
  measurements: [],
  checkpoints: [],
  overallScore: 7.4,
  analysisConfidence: 0.9,
  resultKind: 'scored',
  guidance: null,
  priorityFix: null,
  versionVector: {
    appVersion: '0.1.0',
    modelBundleVersion: 'stress-native-1',
    poseModelVersion: 'stress-pose-1',
    paddleModelVersion: 'stress-paddle-1',
    strokeDetectorVersion: 'stress-stroke-1',
    phaseModelVersion: 'stress-phase-1',
    scoringModelVersion: 'sm-v1',
    shotConfigVersion: 'forehand_drive@1',
  },
  source: 'real',
};

export interface PayloadContext {
  /** Fresh UUID-shaped id from the sequence's RNG. */
  uuid(): string;
  /** A session id already enqueued for this owner (or null). */
  knownSessionId(): string | null;
  /** A shot id already enqueued for this owner (or null). */
  knownShotId(): string | null;
}

export interface BuiltPayload {
  payload: string;
  /** Entity id the row carries (shot id / session id / trial id) if any. */
  entityId: string | null;
}

export function buildPayload(
  action: EnqueueAction,
  ctx: PayloadContext,
): BuiltPayload {
  const shot = (
    id: string,
    sessionId: string | null,
    permit: string | null,
  ) => {
    const analysis: ShotAnalysis & { analysisPermitId?: string } = {
      ...baseAnalysis,
      id,
      sessionId,
    };
    if (permit !== null) analysis.analysisPermitId = permit;
    return analysis;
  };
  switch (action.kind) {
    case 'shot.sync': {
      const id =
        action.variant === 'duplicate_id'
          ? (ctx.knownShotId() ?? ctx.uuid())
          : ctx.uuid();
      const permit = ctx.uuid();
      switch (action.variant) {
        case 'valid':
        case 'duplicate_id':
          return {
            payload: JSON.stringify(shot(id, null, permit)),
            entityId: id,
          };
        case 'valid_with_session':
          return {
            payload: JSON.stringify(
              shot(id, ctx.knownSessionId() ?? ctx.uuid(), permit),
            ),
            entityId: id,
          };
        case 'orphan_session':
          return {
            payload: JSON.stringify(shot(id, ctx.uuid(), permit)),
            entityId: id,
          };
        case 'missing_permit':
          return {
            payload: JSON.stringify(shot(id, null, null)),
            entityId: id,
          };
        case 'blank_permit':
          return {
            payload: JSON.stringify(shot(id, null, '   ')),
            entityId: id,
          };
        case 'corrupt_json':
          return { payload: '{"id":"' + id + '","truncated', entityId: id };
        case 'json_null':
          return { payload: 'null', entityId: null };
        case 'json_string':
          return { payload: JSON.stringify(id), entityId: null };
        case 'no_id': {
          const { id: _dropped, ...rest } = shot(id, null, permit);
          return { payload: JSON.stringify(rest), entityId: null };
        }
        case 'no_checkpoints': {
          const { checkpoints: _dropped, ...rest } = shot(id, null, permit);
          return { payload: JSON.stringify(rest), entityId: id };
        }
        case 'fixture_source':
          return {
            payload: JSON.stringify({
              ...shot(id, null, permit),
              source: 'fixture',
            }),
            entityId: id,
          };
      }
      break;
    }
    case 'session.create':
    case 'session.finalize': {
      const id = ctx.uuid();
      switch (action.variant) {
        case 'valid':
          return {
            payload: JSON.stringify({
              id,
              startedAt: '2026-08-26T18:00:00.000Z',
            }),
            entityId: id,
          };
        case 'corrupt_json':
          return { payload: '{"id":', entityId: id };
        case 'no_id':
          return {
            payload: JSON.stringify({ startedAt: 'x' }),
            entityId: null,
          };
      }
      break;
    }
    case 'evaluation.trial': {
      const trialId = ctx.uuid();
      switch (action.variant) {
        case 'valid':
          return {
            payload: JSON.stringify({
              trialId,
              datasetId: 'stress',
              outcome: 'pass',
            }),
            entityId: trialId,
          };
        case 'corrupt_json':
          return { payload: '[1,2', entityId: trialId };
        case 'json_null':
          return { payload: 'null', entityId: null };
        case 'missing_trial_id':
          return {
            payload: JSON.stringify({ datasetId: 'stress' }),
            entityId: null,
          };
      }
      break;
    }
    case 'unknown':
      return {
        payload:
          action.variant === 'valid'
            ? JSON.stringify({ id: ctx.uuid() })
            : '{{',
        entityId: null,
      };
  }
  throw new Error('unreachable payload variant');
}

/** Expected `last_error` for a row: exact text or a class prefix. */
export type ErrorExpectation =
  { exact: string } | { prefix: string } | { unchanged: true };

export interface ExpectedRow {
  id: number;
  attempts: number;
  lastError: ErrorExpectation;
}

export interface ExpectedCall {
  endpoint:
    | 'createSession'
    | 'finalizeSession'
    | 'syncShots'
    | 'uploadEvaluationTrials';
  ids: unknown[];
}

export interface ExpectedDrain {
  result: { synced: number; failed: number; remaining: number };
  deleted: number[];
  rows: ExpectedRow[];
  newReceipts: ReceiptState[];
  calls: ExpectedCall[];
}

const isTransientCode = (code: string): boolean =>
  (TRANSIENT_REJECTION_CODES as readonly string[]).includes(code);

function thrownExpectation(behavior: Thrown): {
  permanent: boolean;
  error: ErrorExpectation;
} {
  switch (behavior.throw) {
    case 'api':
      return {
        permanent:
          behavior.status >= 400 &&
          behavior.status < 500 &&
          behavior.status !== 401 &&
          behavior.status !== 408 &&
          behavior.status !== 429,
        error: { exact: `Error: ${behavior.message}` },
      };
    case 'error':
      return {
        permanent: false,
        error: { exact: `Error: ${behavior.message}` },
      };
    case 'type_error':
      return {
        permanent: false,
        error: { exact: `TypeError: ${behavior.message}` },
      };
    case 'string':
      return { permanent: false, error: { exact: behavior.value } };
  }
}

type LocalParse =
  | { ok: true; id: unknown; payload: unknown }
  | { ok: false; error: ErrorExpectation };

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function parseShotRow(row: OutboxRowState): LocalParse {
  const parsed = parseJson(row.payload);
  if (!parsed.ok) return { ok: false, error: { prefix: 'SyntaxError: ' } };
  const analysis = parsed.value;
  if (analysis === null || typeof analysis !== 'object') {
    // `analysis.analysisPermitId` on null throws TypeError; on a string it is
    // undefined → missing permit.
    return analysis === null
      ? { ok: false, error: { prefix: 'TypeError: ' } }
      : {
          ok: false,
          error: { exact: 'Error: shot.sync_missing_analysis_permit' },
        };
  }
  const record = analysis as Record<string, unknown>;
  const permit = record['analysisPermitId'];
  if (typeof permit !== 'string' || permit.trim().length === 0) {
    return {
      ok: false,
      error: { exact: 'Error: shot.sync_missing_analysis_permit' },
    };
  }
  if (!Array.isArray(record['checkpoints'])) {
    return { ok: false, error: { prefix: 'TypeError: ' } };
  }
  return { ok: true, id: record['id'], payload: analysis };
}

function parseTrialRow(row: OutboxRowState): LocalParse {
  const parsed = parseJson(row.payload);
  if (!parsed.ok) return { ok: false, error: { prefix: 'SyntaxError: ' } };
  const trial = parsed.value;
  if (trial === null || typeof trial !== 'object') {
    return trial === null
      ? { ok: false, error: { prefix: 'TypeError: ' } }
      : { ok: false, error: { exact: 'Error: evaluation.trial_missing_id' } };
  }
  const trialId = (trial as Record<string, unknown>)['trialId'];
  if (typeof trialId !== 'string') {
    return {
      ok: false,
      error: { exact: 'Error: evaluation.trial_missing_id' },
    };
  }
  return { ok: true, id: trialId, payload: trial };
}

interface Acknowledgement {
  accepted: Set<string>;
  rejected: Map<string, string>;
}

/**
 * What the client derives from a 2xx body, or `{ threw }` when reading the
 * body throws inside the try (malformed shapes) — mirrors the stub in
 * transport.ts and the reading code in sync.ts.
 */
function acknowledge(
  behavior: Exclude<BatchBehavior, Thrown>,
  ids: unknown[],
): Acknowledgement | { threw: ErrorExpectation } {
  if (behavior.kind === 'malformed') {
    const strings = ids.filter((id): id is string => typeof id === 'string');
    switch (behavior.shape) {
      case 'empty_object':
      case 'null':
      case 'rejected_null':
        return { threw: { prefix: 'TypeError: ' } };
      case 'string_ids':
        return { accepted: new Set(['a', 'b', 'c']), rejected: new Map() };
      case 'foreign_ids':
        return { accepted: new Set([FOREIGN_ID]), rejected: new Map() };
      case 'dup_ids':
        return { accepted: new Set(strings), rejected: new Map() };
      case 'accept_and_reject':
        return {
          accepted: new Set(strings),
          rejected: new Map(strings.map(id => [id, 'shot.invalid_payload'])),
        };
    }
  }
  const verdicts = serverVerdicts(behavior, ids);
  return {
    accepted: new Set(verdicts.accepted),
    rejected: new Map(verdicts.rejected.map(({ id, code }) => [id, code])),
  };
}

export function expectDrain(
  owner: string,
  rowsBefore: OutboxRowState[],
  policy: DrainPolicy,
): ExpectedDrain {
  const eligible = rowsBefore
    .filter(
      row => row.owner_key === owner && row.attempts < OUTBOX_MAX_ATTEMPTS,
    )
    .sort((a, b) => a.id - b.id)
    .slice(0, 50);
  const calls: ExpectedCall[] = [];
  const deleted: number[] = [];
  const failures = new Map<
    number,
    { permanent: boolean; error: ErrorExpectation }
  >();
  const newReceipts: ReceiptState[] = [];
  let synced = 0;
  let failed = 0;

  const fail = (
    row: OutboxRowState,
    permanent: boolean,
    error: ErrorExpectation,
  ) => {
    failures.set(row.id, { permanent, error });
    failed += 1;
  };

  let sessionCursor = 0;
  const nextSession = (): EndpointBehavior => {
    const behavior =
      policy.session[Math.min(sessionCursor, policy.session.length - 1)]!;
    sessionCursor += 1;
    return behavior;
  };

  for (const row of eligible) {
    if (row.kind === 'shot.sync' || row.kind === 'evaluation.trial') continue;
    const parsed = parseJson(row.payload);
    if (!parsed.ok) {
      fail(row, true, { prefix: 'SyntaxError: ' });
      continue;
    }
    if (row.kind !== 'session.create' && row.kind !== 'session.finalize') {
      fail(row, true, { exact: `Error: unknown outbox kind ${row.kind}` });
      continue;
    }
    const value = parsed.value;
    const id =
      value !== null && typeof value === 'object'
        ? (value as Record<string, unknown>)['id']
        : undefined;
    calls.push({
      endpoint:
        row.kind === 'session.create' ? 'createSession' : 'finalizeSession',
      ids: [row.kind === 'session.create' ? id : String(id)],
    });
    const behavior = nextSession();
    if ('throw' in behavior) {
      const { permanent, error } = thrownExpectation(behavior);
      fail(row, permanent, error);
    } else {
      deleted.push(row.id);
      synced += 1;
    }
  }

  const shotEntries: Array<{ row: OutboxRowState; id: unknown }> = [];
  for (const row of eligible) {
    if (row.kind !== 'shot.sync') continue;
    const parsed = parseShotRow(row);
    if (!parsed.ok) fail(row, true, parsed.error);
    else shotEntries.push({ row, id: parsed.id });
  }
  if (shotEntries.length > 0) {
    const ids = shotEntries.map(entry => entry.id);
    calls.push({ endpoint: 'syncShots', ids });
    if ('throw' in policy.shots) {
      const { permanent, error } = thrownExpectation(policy.shots);
      for (const { row } of shotEntries) fail(row, permanent, error);
    } else {
      const ack = acknowledge(policy.shots, ids);
      if ('threw' in ack) {
        for (const { row } of shotEntries) fail(row, false, ack.threw);
      } else {
        for (const { row, id } of shotEntries) {
          if (typeof id === 'string' && ack.accepted.has(id)) {
            if (
              !newReceipts.some(
                r => r.owner_key === owner && r.entity_id === id,
              )
            ) {
              newReceipts.push({
                owner_key: owner,
                kind: 'shot.sync',
                entity_id: id,
              });
            }
            deleted.push(row.id);
            synced += 1;
            continue;
          }
          const code =
            typeof id === 'string' ? ack.rejected.get(id) : undefined;
          if (code !== undefined) {
            fail(row, !isTransientCode(code), {
              exact: `${code}: msg:${code}`,
            });
          } else {
            fail(row, true, { exact: 'shot.sync_unacknowledged' });
          }
        }
      }
    }
  }

  if (policy.trials !== 'absent') {
    const trialEntries: Array<{ row: OutboxRowState; id: string }> = [];
    for (const row of eligible) {
      if (row.kind !== 'evaluation.trial') continue;
      const parsed = parseTrialRow(row);
      if (!parsed.ok) fail(row, true, parsed.error);
      else trialEntries.push({ row, id: String(parsed.id) });
    }
    if (trialEntries.length > 0) {
      const ids = trialEntries.map(entry => entry.id);
      calls.push({ endpoint: 'uploadEvaluationTrials', ids });
      if ('throw' in policy.trials) {
        const { permanent, error } = thrownExpectation(policy.trials);
        for (const { row } of trialEntries) fail(row, permanent, error);
      } else {
        const ack = acknowledge(policy.trials, ids);
        if ('threw' in ack) {
          for (const { row } of trialEntries) fail(row, false, ack.threw);
        } else {
          for (const { row, id } of trialEntries) {
            if (ack.accepted.has(id)) {
              deleted.push(row.id);
              synced += 1;
              continue;
            }
            const code = ack.rejected.get(id);
            if (code !== undefined) {
              fail(row, !isTransientCode(code), {
                exact: `${code}: msg:${code}`,
              });
            } else {
              fail(row, true, { exact: 'evaluation.trial_unacknowledged' });
            }
          }
        }
      }
    }
  }

  const deletedSet = new Set(deleted);
  const rows: ExpectedRow[] = rowsBefore
    .filter(row => !deletedSet.has(row.id))
    .map(row => {
      const failure = failures.get(row.id);
      if (!failure)
        return {
          id: row.id,
          attempts: row.attempts,
          lastError: { unchanged: true },
        };
      return {
        id: row.id,
        attempts: row.attempts + (failure.permanent ? 1 : 0),
        lastError: failure.error,
      };
    });
  const remaining = rows.filter(expected => {
    const before = rowsBefore.find(row => row.id === expected.id);
    return before?.owner_key === owner;
  }).length;

  return {
    result: { synced, failed, remaining },
    deleted,
    rows,
    newReceipts,
    calls,
  };
}

export function matchesError(
  actual: string | null,
  expected: ErrorExpectation,
  before: string | null,
): boolean {
  if ('unchanged' in expected) return actual === before;
  if ('exact' in expected) return actual === expected.exact;
  return actual !== null && actual.startsWith(expected.prefix);
}
