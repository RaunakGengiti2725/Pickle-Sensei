/**
 * Seeded failure-injection plans for `drainOutbox()` (unit mod-sync-outbox).
 *
 * A plan is a pure function of a 32-bit seed: the queue contents (valid rows,
 * poison rows, other-owner rows, exhausted rows), one fault per transport
 * method (throw / reject / HTTP class / malformed / partial / slow / never
 * resolves), an optional SQLite fault (statement class × occurrence × mode),
 * and an optional owner switch mid-drain. `expectedOutcome()` is an
 * independent model of the documented contract (sync.ts header comments +
 * the repo's server-response-matrix oracle) — the campaign compares the real
 * SQLite state against it and against structural invariants.
 */
import type { ShotAnalysis } from '@pickle/shared-types';
import { ApiError } from '../../src/data/api';
import type { SyncTransport } from '../../src/data/sync';
import { OUTBOX_MAX_ATTEMPTS } from '../../src/data/sync';
import {
  DB_FAULT_MODES,
  STATEMENT_CLASSES,
  type DbFault,
  type DbFaultMode,
  type OutboxRowSnapshot,
  type ReceiptSnapshot,
  type SqliteStressDb,
  type StatementClass,
} from './sqliteLocalDb';

declare const setTimeout: (callback: () => void, ms: number) => unknown;

// ─── seeded randomness ───────────────────────────────────────────────────────

/** mulberry32 — matches xc-harness/lifecycle-persistence/seeds.ts. */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: () => number, items: readonly T[]): T {
  const index = Math.floor(rng() * items.length);
  return items[Math.min(index, items.length - 1)] as T;
}

function chance(rng: () => number, probability: number): boolean {
  return rng() < probability;
}

function intBetween(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

// ─── queue rows ──────────────────────────────────────────────────────────────

export type RowKind =
  | 'session_create_ok'
  | 'session_finalize_ok'
  | 'session_finalize_null'
  | 'session_corrupt_json'
  | 'unknown_kind'
  | 'shot_ok'
  | 'shot_duplicate'
  | 'shot_no_permit'
  | 'shot_corrupt_json'
  | 'shot_null_payload'
  | 'shot_no_checkpoints'
  | 'trial_ok'
  | 'trial_missing_id'
  | 'trial_corrupt_json';

export const ROW_KINDS: readonly RowKind[] = [
  'session_create_ok',
  'session_finalize_ok',
  'session_finalize_null',
  'session_corrupt_json',
  'unknown_kind',
  'shot_ok',
  'shot_duplicate',
  'shot_no_permit',
  'shot_corrupt_json',
  'shot_null_payload',
  'shot_no_checkpoints',
  'trial_ok',
  'trial_missing_id',
  'trial_corrupt_json',
];

/** Sampling weights: valid rows dominate so most iterations exercise the
 * network path; every poison kind still appears in a few percent of seeds. */
const ROW_WEIGHTS: Record<RowKind, number> = {
  session_create_ok: 14,
  session_finalize_ok: 10,
  session_finalize_null: 3,
  session_corrupt_json: 3,
  unknown_kind: 3,
  shot_ok: 30,
  shot_duplicate: 4,
  shot_no_permit: 4,
  shot_corrupt_json: 3,
  shot_null_payload: 3,
  shot_no_checkpoints: 3,
  trial_ok: 12,
  trial_missing_id: 3,
  trial_corrupt_json: 3,
};

export interface QueueRow {
  /** Stable label inside the plan (r0, r1, …). */
  label: string;
  kind: RowKind;
  /** The outbox `kind` column. */
  outboxKind: string;
  payload: string;
  /** Entity id the server would acknowledge (shot id / trial id / session id). */
  entityId: string | null;
  /** Row starts at this attempts value. */
  attempts: number;
}

const ANALYSIS_BASE: ShotAnalysis = {
  id: '00000000-0000-4000-8000-000000000000',
  sessionId: null,
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
    modelBundleVersion: 'test-native-1',
    poseModelVersion: 'test-pose-1',
    paddleModelVersion: 'test-paddle-1',
    strokeDetectorVersion: 'test-stroke-1',
    phaseModelVersion: 'test-phase-1',
    scoringModelVersion: 'sm-v1',
    shotConfigVersion: 'forehand_drive@1',
  },
  source: 'real',
};

function uuidFrom(rng: () => number, tag: string): string {
  const hex = () => Math.floor(rng() * 16).toString(16);
  const block = (n: number) => Array.from({ length: n }, hex).join('');
  return `${block(8)}-${block(4)}-4${block(3)}-8${block(3)}-${tag.padEnd(4, '0').slice(0, 4)}${block(8)}`;
}

export function buildRow(
  rng: () => number,
  label: string,
  kind: RowKind,
  previousShotId: string | null,
): QueueRow {
  const attempts = chance(rng, 0.25)
    ? intBetween(rng, 1, OUTBOX_MAX_ATTEMPTS - 1)
    : 0;
  const base = { label, kind, attempts };
  switch (kind) {
    case 'session_create_ok': {
      const id = uuidFrom(rng, 'sess');
      return {
        ...base,
        outboxKind: 'session.create',
        payload: JSON.stringify({ id, startedAt: ANALYSIS_BASE.capturedAtIso }),
        entityId: id,
      };
    }
    case 'session_finalize_ok': {
      const id = uuidFrom(rng, 'sess');
      return {
        ...base,
        outboxKind: 'session.finalize',
        payload: JSON.stringify({ id }),
        entityId: id,
      };
    }
    case 'session_finalize_null':
      return {
        ...base,
        outboxKind: 'session.finalize',
        payload: 'null',
        entityId: null,
      };
    case 'session_corrupt_json':
      return {
        ...base,
        outboxKind: pick(rng, ['session.create', 'session.finalize']),
        payload: pick(rng, ['{"id":', '', 'not json', '{id: 1}']),
        entityId: null,
      };
    case 'unknown_kind':
      return {
        ...base,
        outboxKind: pick(rng, [
          'shot.legacy',
          'session.delete',
          '',
          'SHOT.SYNC',
        ]),
        payload: '{}',
        entityId: null,
      };
    case 'shot_ok': {
      const id = uuidFrom(rng, 'shot');
      return {
        ...base,
        outboxKind: 'shot.sync',
        payload: JSON.stringify({
          ...ANALYSIS_BASE,
          id,
          analysisPermitId: uuidFrom(rng, 'perm'),
        }),
        entityId: id,
      };
    }
    case 'shot_duplicate': {
      const id = previousShotId ?? uuidFrom(rng, 'shot');
      return {
        ...base,
        outboxKind: 'shot.sync',
        payload: JSON.stringify({
          ...ANALYSIS_BASE,
          id,
          analysisPermitId: uuidFrom(rng, 'perm'),
        }),
        entityId: id,
      };
    }
    case 'shot_no_permit': {
      const id = uuidFrom(rng, 'shot');
      const variant = pick(rng, ['absent', 'null', 'number']);
      const analysis: Record<string, unknown> = { ...ANALYSIS_BASE, id };
      if (variant === 'null') analysis['analysisPermitId'] = null;
      if (variant === 'number') analysis['analysisPermitId'] = 42;
      return {
        ...base,
        outboxKind: 'shot.sync',
        payload: JSON.stringify(analysis),
        entityId: id,
      };
    }
    case 'shot_corrupt_json':
      return {
        ...base,
        outboxKind: 'shot.sync',
        payload: pick(rng, ['{"id":"x"', '', '\u0000', '{"a":NaN}']),
        entityId: null,
      };
    case 'shot_null_payload':
      return {
        ...base,
        outboxKind: 'shot.sync',
        payload: pick(rng, ['null', '1', '"shot"', '[]']),
        entityId: null,
      };
    case 'shot_no_checkpoints': {
      const id = uuidFrom(rng, 'shot');
      const analysis: Record<string, unknown> = {
        ...ANALYSIS_BASE,
        id,
        analysisPermitId: uuidFrom(rng, 'perm'),
      };
      delete analysis['checkpoints'];
      return {
        ...base,
        outboxKind: 'shot.sync',
        payload: JSON.stringify(analysis),
        entityId: id,
      };
    }
    case 'trial_ok': {
      const id = uuidFrom(rng, 'tria');
      return {
        ...base,
        outboxKind: 'evaluation.trial',
        payload: JSON.stringify({ trialId: id, shotType: 'forehand_drive' }),
        entityId: id,
      };
    }
    case 'trial_missing_id':
      return {
        ...base,
        outboxKind: 'evaluation.trial',
        payload: pick(rng, ['{}', '{"trialId":7}', 'null', '{"trialId":null}']),
        entityId: null,
      };
    case 'trial_corrupt_json':
      return {
        ...base,
        outboxKind: 'evaluation.trial',
        payload: pick(rng, ['{"trialId":', '', 'x']),
        entityId: null,
      };
  }
}

function weightedRowKind(rng: () => number): RowKind {
  const total = ROW_KINDS.reduce((sum, kind) => sum + ROW_WEIGHTS[kind], 0);
  let roll = rng() * total;
  for (const kind of ROW_KINDS) {
    roll -= ROW_WEIGHTS[kind];
    if (roll < 0) return kind;
  }
  return 'shot_ok';
}

// ─── transport faults ────────────────────────────────────────────────────────

export type TransportMethod =
  'createSession' | 'finalizeSession' | 'syncShots' | 'uploadEvaluationTrials';

export const TRANSPORT_METHODS: readonly TransportMethod[] = [
  'createSession',
  'finalizeSession',
  'syncShots',
  'uploadEvaluationTrials',
];

export type TransportFault =
  | 'ok'
  | 'slow_ok'
  | 'throw_sync'
  | 'reject_error'
  | 'reject_network_typeerror'
  | 'reject_non_error'
  | 'api_400'
  | 'api_401'
  | 'api_403'
  | 'api_404'
  | 'api_408'
  | 'api_409'
  | 'api_413'
  | 'api_422'
  | 'api_429'
  | 'api_500'
  | 'api_502'
  | 'api_503'
  | 'api_504'
  | 'never_resolves'
  | 'resolve_null'
  | 'resolve_string'
  | 'resolve_empty_object'
  | 'resolve_no_accepted'
  | 'resolve_no_rejected'
  | 'resolve_accepted_string'
  | 'resolve_accepted_null'
  | 'unacknowledged_all'
  | 'accept_unknown_ids'
  | 'partial_accept'
  | 'reject_all_transient'
  | 'reject_all_contract'
  | 'reject_missing_code';

export const TRANSPORT_FAULTS: readonly TransportFault[] = [
  'ok',
  'slow_ok',
  'throw_sync',
  'reject_error',
  'reject_network_typeerror',
  'reject_non_error',
  'api_400',
  'api_401',
  'api_403',
  'api_404',
  'api_408',
  'api_409',
  'api_413',
  'api_422',
  'api_429',
  'api_500',
  'api_502',
  'api_503',
  'api_504',
  'never_resolves',
  'resolve_null',
  'resolve_string',
  'resolve_empty_object',
  'resolve_no_accepted',
  'resolve_no_rejected',
  'resolve_accepted_string',
  'resolve_accepted_null',
  'unacknowledged_all',
  'accept_unknown_ids',
  'partial_accept',
  'reject_all_transient',
  'reject_all_contract',
  'reject_missing_code',
];

/** Faults that only make sense for the batch methods (they return a body). */
const BATCH_ONLY_FAULTS: ReadonlySet<TransportFault> = new Set([
  'resolve_no_accepted',
  'resolve_no_rejected',
  'resolve_accepted_string',
  'resolve_accepted_null',
  'unacknowledged_all',
  'accept_unknown_ids',
  'partial_accept',
  'reject_all_transient',
  'reject_all_contract',
  'reject_missing_code',
]);

export const TRANSIENT_REJECTION_CODES = [
  'shot.write_failed',
  'evaluation.trial_write_failed',
  'auth.required',
  'shot.session_not_found',
] as const;

export const CONTRACT_REJECTION_CODES = [
  'shot.invalid_payload',
  'shot.permit_not_reserved',
  'shot.permit_expired',
  'evaluation.trial_invalid',
  'validation.failed',
] as const;

export interface TransportPlan {
  createSession: TransportFault;
  finalizeSession: TransportFault;
  syncShots: TransportFault;
  uploadEvaluationTrials: TransportFault;
  /** Transport built without `uploadEvaluationTrials` at all. */
  trialsUnsupported: boolean;
  /** For partial_accept: which entity ids (by position, modulo) are accepted. */
  partialMask: number;
}

export interface InjectionPlan {
  seed: number;
  owner: string;
  rows: QueueRow[];
  otherOwnerRows: QueueRow[];
  exhaustedRows: QueueRow[];
  transport: TransportPlan;
  dbFault: DbFault | null;
  /** Owner switches to this value after the Nth transport call (or never). */
  ownerSwitch: { afterCall: number; to: string } | null;
  /** Number of injected faults this plan carries (transport + db + owner). */
  injectedFaults: number;
}

function pickTransportFault(
  rng: () => number,
  method: TransportMethod,
  allowHang: boolean,
  okChance: number,
): TransportFault {
  if (chance(rng, okChance)) return 'ok';
  for (;;) {
    const fault = pick(rng, TRANSPORT_FAULTS);
    if (fault === 'never_resolves' && !allowHang) continue;
    if (
      BATCH_ONLY_FAULTS.has(fault) &&
      (method === 'createSession' || method === 'finalizeSession')
    ) {
      continue;
    }
    return fault;
  }
}

export interface PlanOptions {
  owner?: string;
  /** Emit `never_resolves` transport faults (needs a deadline-raced drain). */
  allowHang?: boolean;
  /** Emit SQLite faults. */
  allowDbFaults?: boolean;
  /** Emit owner switches mid-drain. */
  allowOwnerSwitch?: boolean;
  minRows?: number;
  maxRows?: number;
  /** Probability that a transport method is healthy (default 0.4). */
  okChance?: number;
}

export function buildPlan(
  seed: number,
  options: PlanOptions = {},
): InjectionPlan {
  const rng = makeRng(seed);
  const owner = options.owner ?? 'device-guest';
  const rowCount = intBetween(rng, options.minRows ?? 1, options.maxRows ?? 10);
  const rows: QueueRow[] = [];
  let previousShotId: string | null = null;
  for (let index = 0; index < rowCount; index += 1) {
    const kind = weightedRowKind(rng);
    const row = buildRow(rng, `r${index}`, kind, previousShotId);
    if (kind === 'shot_ok') previousShotId = row.entityId;
    rows.push(row);
  }
  const otherOwnerRows: QueueRow[] = [];
  const otherOwnerCount = chance(rng, 0.5) ? intBetween(rng, 1, 3) : 0;
  for (let index = 0; index < otherOwnerCount; index += 1) {
    otherOwnerRows.push(
      buildRow(
        rng,
        `o${index}`,
        pick(rng, ['shot_ok', 'session_create_ok', 'trial_ok']),
        null,
      ),
    );
  }
  const exhaustedRows: QueueRow[] = [];
  const exhaustedCount = chance(rng, 0.4) ? intBetween(rng, 1, 2) : 0;
  for (let index = 0; index < exhaustedCount; index += 1) {
    const row = buildRow(
      rng,
      `x${index}`,
      pick(rng, ['shot_ok', 'session_finalize_ok']),
      null,
    );
    exhaustedRows.push({
      ...row,
      attempts: OUTBOX_MAX_ATTEMPTS + intBetween(rng, 0, 2),
    });
  }

  const allowHang = options.allowHang ?? false;
  const okChance = options.okChance ?? 0.4;
  const transport: TransportPlan = {
    createSession: pickTransportFault(
      rng,
      'createSession',
      allowHang,
      okChance,
    ),
    finalizeSession: pickTransportFault(
      rng,
      'finalizeSession',
      allowHang,
      okChance,
    ),
    syncShots: pickTransportFault(rng, 'syncShots', allowHang, okChance),
    uploadEvaluationTrials: pickTransportFault(
      rng,
      'uploadEvaluationTrials',
      allowHang,
      okChance,
    ),
    trialsUnsupported: chance(rng, 0.1),
    partialMask: intBetween(rng, 1, 0xffff),
  };

  let dbFault: DbFault | null = null;
  if ((options.allowDbFaults ?? true) && chance(rng, 0.55)) {
    const statement = pick(rng, STATEMENT_CLASSES);
    let mode: DbFaultMode = pick(rng, DB_FAULT_MODES);
    if (allowHang && chance(rng, 0.12)) mode = 'hang';
    if (
      mode === 'malformed_rows' &&
      statement !== 'select_batch' &&
      statement !== 'count_remaining'
    ) {
      mode = 'throw';
    }
    // A BEGIN that succeeded but was reported as failed has no driver
    // analogue (the statement either ran or it did not); keep it a plain throw.
    if (mode === 'throw_after' && statement === 'begin') mode = 'throw';
    // Most plans issue each statement class only a few times; bias to the
    // first occurrence so the fault actually fires.
    const nth = chance(rng, 0.65) ? 1 : intBetween(rng, 2, 3);
    dbFault = { statement, mode, nth };
  }

  let ownerSwitch: InjectionPlan['ownerSwitch'] = null;
  if ((options.allowOwnerSwitch ?? true) && chance(rng, 0.15)) {
    ownerSwitch = {
      afterCall: intBetween(rng, 1, 3),
      to: chance(rng, 0.5)
        ? 'signed-out'
        : '11111111-2222-4333-8444-555555555555',
    };
  }

  const injectedFaults =
    TRANSPORT_METHODS.filter(method => transport[method] !== 'ok').length +
    (transport.trialsUnsupported ? 1 : 0) +
    (dbFault ? 1 : 0) +
    (ownerSwitch ? 1 : 0);

  return {
    seed,
    owner,
    rows,
    otherOwnerRows,
    exhaustedRows,
    transport,
    dbFault,
    ownerSwitch,
    injectedFaults,
  };
}

// ─── transport realisation ───────────────────────────────────────────────────

export interface TransportCall {
  method: TransportMethod;
  /** Entity ids the call carried (shot ids / trial ids / session id). */
  ids: string[];
  fault: TransportFault;
}

export interface FaultyTransport {
  transport: SyncTransport;
  calls: TransportCall[];
  /** Ids the fake server ACCEPTED (idempotent: a set across calls). */
  accepted: Set<string>;
}

class NonErrorRejection {
  readonly reason = 'rejected with a plain object';
}

function apiErrorFor(fault: TransportFault): ApiError {
  const status = Number(fault.slice('api_'.length));
  return new ApiError(status, `http.${status}`, `injected HTTP ${status}`);
}

function isAccepted(mask: number, index: number): boolean {
  return ((mask >> (index % 16)) & 1) === 1;
}

function idsOf(items: unknown[], key: 'id' | 'trialId'): string[] {
  return items.map(item => {
    if (typeof item === 'object' && item !== null) {
      const value = (item as Record<string, unknown>)[key];
      return typeof value === 'string' ? value : String(value);
    }
    return String(item);
  });
}

/**
 * Builds the transport a plan describes. `rng` drives partial-acceptance
 * codes and slow delays; `onCall` fires after every call settles or is
 * about to hang (used for the owner switch).
 */
export function buildTransport(
  plan: InjectionPlan,
  rng: () => number,
  onCall?: (callIndex: number) => void,
): FaultyTransport {
  const calls: TransportCall[] = [];
  const accepted = new Set<string>();

  const respond = <T>(
    method: TransportMethod,
    ids: string[],
    okBody: () => T,
    partialBody: (acceptedIds: string[], rejectedIds: string[]) => T,
    rejectedBody: (ids: string[], codes: readonly string[]) => T,
    shapeBody: (fault: TransportFault, ids: string[]) => T,
  ): Promise<T> => {
    const fault = plan.transport[method];
    calls.push({ method, ids, fault });
    const callIndex = calls.length;
    const settle = <R>(value: R): R => {
      onCall?.(callIndex);
      return value;
    };
    const fail = (error: unknown): Promise<T> => {
      onCall?.(callIndex);
      return Promise.reject(error);
    };
    const voidMethod =
      method === 'createSession' || method === 'finalizeSession';
    switch (fault) {
      case 'ok':
        for (const id of ids) accepted.add(id);
        return Promise.resolve(settle(okBody()));
      case 'slow_ok':
        return new Promise<T>(resolve => {
          setTimeout(
            () => {
              for (const id of ids) accepted.add(id);
              resolve(settle(okBody()));
            },
            1 + Math.floor(rng() * 12),
          );
        });
      case 'throw_sync':
        onCall?.(callIndex);
        throw new Error(`injected synchronous throw in ${method}`);
      case 'reject_error':
        return fail(new Error(`injected rejection in ${method}`));
      case 'reject_network_typeerror':
        return fail(new TypeError('Network request failed'));
      case 'reject_non_error':
        return fail(new NonErrorRejection());
      case 'api_400':
      case 'api_401':
      case 'api_403':
      case 'api_404':
      case 'api_408':
      case 'api_409':
      case 'api_413':
      case 'api_422':
      case 'api_429':
      case 'api_500':
      case 'api_502':
      case 'api_503':
      case 'api_504':
        return fail(apiErrorFor(fault));
      case 'never_resolves':
        onCall?.(callIndex);
        return new Promise<T>(() => {});
      case 'resolve_null':
        // The request reached the server; a void call completes on ANY 2xx.
        if (voidMethod) for (const id of ids) accepted.add(id);
        return Promise.resolve(settle(null as unknown as T));
      case 'resolve_string':
        if (voidMethod) for (const id of ids) accepted.add(id);
        return Promise.resolve(settle('ok' as unknown as T));
      case 'resolve_empty_object':
        if (voidMethod) for (const id of ids) accepted.add(id);
        return Promise.resolve(settle({} as unknown as T));
      case 'resolve_no_accepted':
      case 'resolve_no_rejected':
      case 'resolve_accepted_string':
      case 'resolve_accepted_null':
        return Promise.resolve(settle(shapeBody(fault, ids)));
      case 'unacknowledged_all':
        return Promise.resolve(settle(partialBody([], [])));
      case 'accept_unknown_ids': {
        for (const id of ids) accepted.add(id);
        return Promise.resolve(
          settle(
            partialBody(
              [...ids, 'ffffffff-ffff-4fff-8fff-ffffffffffff', ''],
              [],
            ),
          ),
        );
      }
      case 'partial_accept': {
        const acceptedIds = ids.filter((_, index) =>
          isAccepted(plan.transport.partialMask, index),
        );
        const rejectedIds = ids.filter(
          (_, index) => !isAccepted(plan.transport.partialMask, index),
        );
        for (const id of acceptedIds) accepted.add(id);
        return Promise.resolve(settle(partialBody(acceptedIds, rejectedIds)));
      }
      case 'reject_all_transient':
        return Promise.resolve(
          settle(rejectedBody(ids, TRANSIENT_REJECTION_CODES)),
        );
      case 'reject_all_contract':
        return Promise.resolve(
          settle(rejectedBody(ids, CONTRACT_REJECTION_CODES)),
        );
      case 'reject_missing_code':
        return Promise.resolve(settle(rejectedBody(ids, [''])));
    }
  };

  const shotShape = (fault: TransportFault, ids: string[]) => {
    switch (fault) {
      case 'resolve_no_accepted':
        return { rejected: [] } as unknown as ShotResponse;
      case 'resolve_no_rejected':
        return { acceptedIds: ids } as unknown as ShotResponse;
      case 'resolve_accepted_string':
        return {
          acceptedIds: ids.join(','),
          rejected: [],
        } as unknown as ShotResponse;
      default:
        return { acceptedIds: null, rejected: [] } as unknown as ShotResponse;
    }
  };
  const trialShape = (fault: TransportFault, ids: string[]) => {
    switch (fault) {
      case 'resolve_no_accepted':
        return { rejected: [] } as unknown as TrialResponse;
      case 'resolve_no_rejected':
        return { acceptedTrialIds: ids } as unknown as TrialResponse;
      case 'resolve_accepted_string':
        return {
          acceptedTrialIds: ids.join(','),
          rejected: [],
        } as unknown as TrialResponse;
      default:
        return {
          acceptedTrialIds: null,
          rejected: [],
        } as unknown as TrialResponse;
    }
  };

  const transport: SyncTransport = {
    createSession: session =>
      respond<void>(
        'createSession',
        idsOf([session], 'id'),
        () => undefined,
        () => undefined,
        () => undefined,
        () => undefined,
      ),
    finalizeSession: id =>
      respond<void>(
        'finalizeSession',
        [id],
        () => undefined,
        () => undefined,
        () => undefined,
        () => undefined,
      ),
    syncShots: shots => {
      const ids = idsOf(shots, 'id');
      return respond<ShotResponse>(
        'syncShots',
        ids,
        () => ({ acceptedIds: ids, rejected: [] }),
        (acceptedIds, rejectedIds) => ({
          acceptedIds,
          rejected: rejectedIds.map((id, index) => ({
            id,
            code: pick(
              rng,
              index % 2 === 0
                ? TRANSIENT_REJECTION_CODES
                : CONTRACT_REJECTION_CODES,
            ),
            message: 'partial',
          })),
        }),
        (rejectedIds, codes) => ({
          acceptedIds: [],
          rejected: rejectedIds.map((id, index) => ({
            id,
            code: codes[index % codes.length] ?? '',
            message: 'rejected',
          })),
        }),
        shotShape,
      );
    },
  };
  if (!plan.transport.trialsUnsupported) {
    transport.uploadEvaluationTrials = trials => {
      const ids = idsOf(trials, 'trialId');
      return respond<TrialResponse>(
        'uploadEvaluationTrials',
        ids,
        () => ({ acceptedTrialIds: ids, rejected: [] }),
        (acceptedIds, rejectedIds) => ({
          acceptedTrialIds: acceptedIds,
          rejected: rejectedIds.map((trialId, index) => ({
            trialId,
            code: pick(
              rng,
              index % 2 === 0
                ? TRANSIENT_REJECTION_CODES
                : CONTRACT_REJECTION_CODES,
            ),
            message: 'partial',
          })),
        }),
        (rejectedIds, codes) => ({
          acceptedTrialIds: [],
          rejected: rejectedIds.map((trialId, index) => ({
            trialId,
            code: codes[index % codes.length] ?? '',
            message: 'rejected',
          })),
        }),
        trialShape,
      );
    };
  }
  return { transport, calls, accepted };
}

type ShotResponse = Awaited<ReturnType<SyncTransport['syncShots']>>;
type TrialResponse = Awaited<
  ReturnType<NonNullable<SyncTransport['uploadEvaluationTrials']>>
>;

// ─── queue loading ───────────────────────────────────────────────────────────

export interface LoadedQueue {
  /** plan label → outbox row id */
  ids: Map<string, number>;
  /** outbox row id → plan row (all three groups) */
  byId: Map<number, QueueRow & { group: 'active' | 'other' | 'exhausted' }>;
  otherOwner: string;
}

export function loadQueue(
  db: SqliteStressDb,
  plan: InjectionPlan,
): LoadedQueue {
  const ids = new Map<string, number>();
  const byId: LoadedQueue['byId'] = new Map();
  const otherOwner =
    plan.owner === 'device-guest'
      ? 'aaaaaaaa-0000-4000-8000-000000000001'
      : 'device-guest';
  type Entry = {
    row: QueueRow;
    owner: string;
    group: 'active' | 'other' | 'exhausted';
  };
  const entries: Entry[] = [
    ...plan.rows.map(row => ({
      row,
      owner: plan.owner,
      group: 'active' as const,
    })),
    ...plan.otherOwnerRows.map(row => ({
      row,
      owner: otherOwner,
      group: 'other' as const,
    })),
    ...plan.exhaustedRows.map(row => ({
      row,
      owner: plan.owner,
      group: 'exhausted' as const,
    })),
  ];
  // Shuffle the insertion order (so other-owner / exhausted rows sit between
  // active rows) while keeping the active rows' relative order — the model
  // relies on ORDER BY id matching `plan.rows` order.
  const rng = makeRng(plan.seed ^ 0x9e3779b9);
  for (let index = entries.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    const a = entries[index] as Entry;
    const b = entries[swap] as Entry;
    entries[index] = b;
    entries[swap] = a;
  }
  let activeCursor = 0;
  for (const slot of entries) {
    const entry: Entry =
      slot.group === 'active'
        ? {
            row: plan.rows[activeCursor++] as QueueRow,
            owner: plan.owner,
            group: 'active',
          }
        : slot;
    const id = db.insertOutboxRow({
      owner: entry.owner,
      kind: entry.row.outboxKind,
      payload: entry.row.payload,
      attempts: entry.row.attempts,
    });
    ids.set(entry.row.label, id);
    byId.set(id, { ...entry.row, group: entry.group });
  }
  return { ids, byId, otherOwner };
}

// ─── contract model ──────────────────────────────────────────────────────────

export interface ExpectedRow {
  label: string;
  /** Row still present after the drain. */
  present: boolean;
  /** Attempts after the drain (when present). */
  attempts: number;
  /** last_error must be non-null (when present and touched). */
  errorRecorded: boolean;
}

export interface ExpectedOutcome {
  /** 'resolved' | 'rejected' (a SQLite fault escaping the drain) | 'hung'. */
  settlement: 'resolved' | 'rejected' | 'hung';
  rows: Map<string, ExpectedRow>;
  receipts: Set<string>;
  synced: number;
  failed: number;
  /** Which finding ids the model expects the CURRENT code to violate. */
  knownDeviations: string[];
  /** The model cannot predict exact per-row state (malformed SELECT rows or
   * a malformed remaining-count); only invariants apply. */
  unmodeled: boolean;
}

function isPermanentFault(fault: TransportFault): boolean {
  if (!fault.startsWith('api_')) return false;
  const status = Number(fault.slice(4));
  return (
    status >= 400 &&
    status < 500 &&
    status !== 401 &&
    status !== 408 &&
    status !== 429
  );
}

function failsCall(fault: TransportFault): boolean {
  return (
    fault === 'throw_sync' ||
    fault === 'reject_error' ||
    fault === 'reject_network_typeerror' ||
    fault === 'reject_non_error' ||
    fault.startsWith('api_')
  );
}

/** Wrong-shape 2xx bodies the implementation classifies as transient. */
const SHAPE_TRANSIENT: ReadonlySet<TransportFault> = new Set([
  'resolve_null',
  'resolve_string',
  'resolve_empty_object',
  'resolve_no_rejected',
]);

/** Wrong-shape 2xx bodies whose `rejected` is iterable but whose accepted ids
 * are missing/mistyped: same contract class as SHAPE_TRANSIENT, but the
 * implementation reads them as "unacknowledged" and burns an attempt (F2). */
const SHAPE_UNACKNOWLEDGED: ReadonlySet<TransportFault> = new Set([
  'resolve_no_accepted',
  'resolve_accepted_string',
  'resolve_accepted_null',
]);

class Escape extends Error {}
class Hang extends Error {}
class BatchAbort extends Error {}

type StatementResult = 'ok' | 'throw' | 'throw_after';

/**
 * Replays `drainOutbox()`'s documented behaviour against the plan. The model
 * consults the same fault plan the real db does (statement class + nth) so a
 * SQLite fault lands on the same logical statement in both. Where the
 * documented contract and the current implementation disagree the model
 * follows the CONTRACT and lists the finding id in `knownDeviations`.
 */
export function expectedOutcome(plan: InjectionPlan): ExpectedOutcome {
  const rows = new Map<string, ExpectedRow>();
  const receipts = new Set<string>();
  const knownDeviations: string[] = [];
  let synced = 0;
  let failed = 0;
  let settlement: ExpectedOutcome['settlement'] = 'resolved';
  const counts = new Map<StatementClass, number>();
  let dbFaultConsumed = false;
  let unmodeled = false;

  for (const row of plan.rows) {
    rows.set(row.label, {
      label: row.label,
      present: true,
      attempts: row.attempts,
      errorRecorded: false,
    });
  }

  const statement = (statementClass: StatementClass): StatementResult => {
    const nth = (counts.get(statementClass) ?? 0) + 1;
    counts.set(statementClass, nth);
    const fault = plan.dbFault;
    if (
      !fault ||
      fault.statement !== statementClass ||
      fault.nth !== nth ||
      dbFaultConsumed
    ) {
      return 'ok';
    }
    switch (fault.mode) {
      case 'throw':
        return 'throw';
      case 'throw_after':
        return 'throw_after';
      case 'busy_once':
        dbFaultConsumed = true;
        return 'throw';
      case 'hang':
        throw new Hang();
      case 'slow':
        return 'ok';
      case 'malformed_rows':
        unmodeled = true;
        return 'ok';
    }
  };

  /** recordRowFailure(): an UPDATE that fails escapes the caller. */
  const recordFailure = (label: string, permanent: boolean) => {
    const outcome = statement('update_row');
    if (outcome === 'throw') throw new Escape();
    const row = rows.get(label);
    if (row?.present) {
      row.errorRecorded = true;
      if (permanent) row.attempts += 1;
    }
    if (outcome === 'throw_after') throw new Escape();
  };

  /** Inside a batch `try`, a failing UPDATE is caught by the batch's catch. */
  const recordFailureInBatch = (label: string, permanent: boolean) => {
    try {
      recordFailure(label, permanent);
    } catch (error) {
      if (error instanceof Escape) throw new BatchAbort();
      throw error;
    }
  };

  const transportCall = (fault: TransportFault): void => {
    if (fault === 'never_resolves') throw new Hang();
  };

  const remove = (label: string) => {
    const state = rows.get(label);
    if (state) state.present = false;
  };

  try {
    const select = statement('select_batch');
    if (select !== 'ok') throw new Escape();
    if (unmodeled) {
      return {
        settlement,
        rows,
        receipts,
        synced,
        failed,
        knownDeviations,
        unmodeled,
      };
    }
    const active = plan.rows.slice(0, 50);

    // Phase 1: sessions.
    for (const row of active) {
      if (
        row.outboxKind === 'shot.sync' ||
        row.outboxKind === 'evaluation.trial'
      )
        continue;
      if (row.kind === 'session_corrupt_json' || row.kind === 'unknown_kind') {
        recordFailure(row.label, true);
        failed += 1;
        continue;
      }
      if (row.kind === 'session_finalize_null') {
        // Contract: a row whose payload can never become a request fails
        // permanently. Implementation: the TypeError is raised inside the
        // transport try → classified transient (finding F1).
        knownDeviations.push('F1');
        recordFailure(row.label, true);
        failed += 1;
        continue;
      }
      const method: TransportMethod =
        row.outboxKind === 'session.create'
          ? 'createSession'
          : 'finalizeSession';
      const fault = plan.transport[method];
      transportCall(fault);
      if (failsCall(fault)) {
        recordFailure(row.label, isPermanentFault(fault));
        failed += 1;
        continue;
      }
      // Any resolution completes a void call; then the row is deleted.
      const del = statement('delete_row');
      if (del === 'throw_after') remove(row.label);
      if (del !== 'ok') {
        recordFailure(row.label, false);
        failed += 1;
        continue;
      }
      remove(row.label);
      synced += 1;
    }

    // Phase 2: shots.
    const shotEntries: QueueRow[] = [];
    for (const row of active) {
      if (row.outboxKind !== 'shot.sync') continue;
      if (row.kind === 'shot_ok' || row.kind === 'shot_duplicate') {
        shotEntries.push(row);
      } else {
        recordFailure(row.label, true);
        failed += 1;
      }
    }
    if (shotEntries.length > 0) {
      const fault = plan.transport.syncShots;
      transportCall(fault);
      const wholeBatchFailure = (permanent: boolean) => {
        for (const row of shotEntries) {
          recordFailure(row.label, permanent);
          failed += 1;
        }
      };
      if (failsCall(fault)) {
        wholeBatchFailure(isPermanentFault(fault));
      } else if (SHAPE_TRANSIENT.has(fault)) {
        wholeBatchFailure(false);
      } else if (SHAPE_UNACKNOWLEDGED.has(fault)) {
        knownDeviations.push('F2');
        wholeBatchFailure(false);
      } else {
        const acceptedIds = new Set<string>();
        const rejectedCodes = new Map<string, string>();
        const ids = shotEntries.map(row => row.entityId as string);
        switch (fault) {
          case 'ok':
          case 'slow_ok':
          case 'accept_unknown_ids':
            for (const id of ids) acceptedIds.add(id);
            break;
          case 'partial_accept':
            ids.forEach((id, index) => {
              if (isAccepted(plan.transport.partialMask, index))
                acceptedIds.add(id);
              else
                rejectedCodes.set(
                  id,
                  index % 2 === 0 ? 'transient' : 'contract',
                );
            });
            break;
          case 'reject_all_transient':
            for (const id of ids) rejectedCodes.set(id, 'transient');
            break;
          case 'reject_all_contract':
          case 'reject_missing_code':
            for (const id of ids) rejectedCodes.set(id, 'contract');
            break;
          default:
            break;
        }
        try {
          for (const row of shotEntries) {
            const id = row.entityId as string;
            if (acceptedIds.has(id)) {
              if (statement('begin') !== 'ok') throw new BatchAbort();
              const insert = statement('insert_receipt');
              if (insert !== 'ok') {
                statement('rollback');
                throw new BatchAbort();
              }
              const del = statement('delete_row');
              if (del !== 'ok') {
                statement('rollback');
                throw new BatchAbort();
              }
              const commit = statement('commit');
              if (commit === 'throw') {
                statement('rollback');
                throw new BatchAbort();
              }
              receipts.add(id);
              remove(row.label);
              if (commit === 'throw_after') {
                // COMMIT applied, driver reported failure: ROLLBACK is issued
                // against no transaction (fails, swallowed), error rethrown.
                statement('rollback');
                throw new BatchAbort();
              }
              synced += 1;
              continue;
            }
            const code = rejectedCodes.get(id);
            recordFailureInBatch(row.label, code !== 'transient');
            failed += 1;
          }
        } catch (error) {
          if (!(error instanceof BatchAbort)) throw error;
          // A SQLite failure inside the batch is transient for every entry
          // (already-deleted rows are untouched by the UPDATE).
          for (const row of shotEntries) {
            recordFailure(row.label, false);
            failed += 1;
          }
        }
      }
    }

    // Phase 3: trials.
    const trialRows = active.filter(
      row => row.outboxKind === 'evaluation.trial',
    );
    if (trialRows.length > 0 && !plan.transport.trialsUnsupported) {
      const entries: QueueRow[] = [];
      for (const row of trialRows) {
        if (row.kind === 'trial_ok') entries.push(row);
        else {
          recordFailure(row.label, true);
          failed += 1;
        }
      }
      if (entries.length > 0) {
        const fault = plan.transport.uploadEvaluationTrials;
        transportCall(fault);
        const wholeBatchFailure = (permanent: boolean) => {
          for (const row of entries) {
            recordFailure(row.label, permanent);
            failed += 1;
          }
        };
        if (failsCall(fault)) {
          wholeBatchFailure(isPermanentFault(fault));
        } else if (SHAPE_TRANSIENT.has(fault)) {
          wholeBatchFailure(false);
        } else if (SHAPE_UNACKNOWLEDGED.has(fault)) {
          knownDeviations.push('F2');
          wholeBatchFailure(false);
        } else {
          const acceptedIds = new Set<string>();
          const rejectedCodes = new Map<string, string>();
          const ids = entries.map(row => row.entityId as string);
          switch (fault) {
            case 'ok':
            case 'slow_ok':
            case 'accept_unknown_ids':
              for (const id of ids) acceptedIds.add(id);
              break;
            case 'partial_accept':
              ids.forEach((id, index) => {
                if (isAccepted(plan.transport.partialMask, index))
                  acceptedIds.add(id);
                else
                  rejectedCodes.set(
                    id,
                    index % 2 === 0 ? 'transient' : 'contract',
                  );
              });
              break;
            case 'reject_all_transient':
              for (const id of ids) rejectedCodes.set(id, 'transient');
              break;
            case 'reject_all_contract':
            case 'reject_missing_code':
              for (const id of ids) rejectedCodes.set(id, 'contract');
              break;
            default:
              break;
          }
          try {
            for (const row of entries) {
              const id = row.entityId as string;
              if (acceptedIds.has(id)) {
                const del = statement('delete_row');
                if (del === 'throw_after') remove(row.label);
                if (del !== 'ok') throw new BatchAbort();
                remove(row.label);
                synced += 1;
                continue;
              }
              recordFailureInBatch(
                row.label,
                rejectedCodes.get(id) !== 'transient',
              );
              failed += 1;
            }
          } catch (error) {
            if (!(error instanceof BatchAbort)) throw error;
            for (const row of entries) {
              recordFailure(row.label, false);
              failed += 1;
            }
          }
        }
      }
    }

    if (statement('count_remaining') !== 'ok') throw new Escape();
    if (unmodeled) {
      return {
        settlement,
        rows,
        receipts,
        synced,
        failed,
        knownDeviations,
        unmodeled,
      };
    }
  } catch (error) {
    if (error instanceof Hang) settlement = 'hung';
    else if (error instanceof Escape) settlement = 'rejected';
    else throw error;
  }

  return {
    settlement,
    rows,
    receipts,
    synced,
    failed,
    knownDeviations,
    unmodeled,
  };
}

// ─── invariants ──────────────────────────────────────────────────────────────

export interface DrainObservation {
  settlement: 'resolved' | 'rejected' | 'hung';
  result: { synced: number; failed: number; remaining: number } | null;
  error: string | null;
}

export interface Violation {
  /** Machine-readable class, e.g. `row_deleted_without_ack`. */
  code: string;
  detail: string;
  /** Finding id when the violation is a known, pinned deviation. */
  finding?: string;
}

const RECEIPT_KIND = 'shot.sync';

/**
 * Structural invariants that hold for ANY interleaving / fault, independent
 * of the exact-state model:
 *  - rows of other owners and exhausted rows are byte-identical afterwards
 *  - a deleted row was acknowledged by the server (no row lost without an ack)
 *  - a deleted shot row has a receipt; a receipt names an accepted shot
 *  - attempts never decrease and never grow by more than `drains`
 *  - the connection is left outside any transaction; integrity_check = ok
 */
export function structuralViolations(input: {
  before: OutboxRowSnapshot[];
  after: OutboxRowSnapshot[];
  receipts: ReceiptSnapshot[];
  queue: LoadedQueue;
  owner: string;
  accepted: Set<string>;
  drains: number;
  /** A drain issued `ROLLBACK` while another drain was running (F3 window). */
  concurrentRollback?: boolean;
  inTransaction: boolean;
  integrity: string;
}): Violation[] {
  const violations: Violation[] = [];
  const afterById = new Map(input.after.map(row => [row.id, row] as const));
  for (const before of input.before) {
    const meta = input.queue.byId.get(before.id);
    const after = afterById.get(before.id);
    if (!meta) continue;
    if (meta.group !== 'active') {
      if (!after) {
        violations.push({
          code: 'untouchable_row_deleted',
          detail: `${meta.group} row ${meta.label} (id ${before.id}) was deleted`,
        });
      } else if (
        after.attempts !== before.attempts ||
        after.last_error !== before.last_error ||
        after.payload !== before.payload
      ) {
        violations.push({
          code: 'untouchable_row_modified',
          detail: `${meta.group} row ${meta.label} (id ${before.id}) changed: ${JSON.stringify(after)}`,
        });
      }
      continue;
    }
    if (!after) {
      if (!meta.entityId || !input.accepted.has(meta.entityId)) {
        violations.push({
          code: 'row_deleted_without_ack',
          detail: `${meta.label} (${meta.kind}, id ${before.id}) deleted but the server never accepted ${meta.entityId ?? '<no id>'}`,
        });
      }
      if (meta.outboxKind === 'shot.sync' && meta.entityId) {
        const receipt = input.receipts.find(
          candidate =>
            candidate.owner_key === input.owner &&
            candidate.kind === RECEIPT_KIND &&
            candidate.entity_id === meta.entityId,
        );
        if (!receipt) {
          violations.push({
            code: 'shot_deleted_without_receipt',
            detail: `${meta.label} shot ${meta.entityId} deleted from outbox with no sync_receipt`,
            // Known deviation F3: one drain's error-path ROLLBACK discarded
            // another drain's receipt INSERT, whose DELETE then autocommitted.
            ...(input.drains > 1 && input.concurrentRollback
              ? { finding: 'F3' }
              : {}),
          });
        }
      }
      continue;
    }
    if (after.attempts < before.attempts) {
      violations.push({
        code: 'attempts_decreased',
        detail: `${meta.label}: ${before.attempts} → ${after.attempts}`,
      });
    }
    if (after.attempts > before.attempts + input.drains) {
      violations.push({
        code: 'attempts_overburned',
        detail: `${meta.label}: ${before.attempts} → ${after.attempts} across ${input.drains} drain(s)`,
      });
    }
    if (after.payload !== before.payload || after.kind !== before.kind) {
      violations.push({
        code: 'row_payload_mutated',
        detail: `${meta.label}: payload/kind changed`,
      });
    }
  }
  for (const receipt of input.receipts) {
    if (receipt.owner_key !== input.owner) {
      violations.push({
        code: 'receipt_for_other_owner',
        detail: `receipt ${receipt.entity_id} written under ${receipt.owner_key}`,
      });
      continue;
    }
    if (!input.accepted.has(receipt.entity_id)) {
      violations.push({
        code: 'receipt_without_ack',
        detail: `receipt ${receipt.entity_id} exists but the server never accepted it`,
      });
    }
  }
  if (input.inTransaction) {
    violations.push({
      code: 'transaction_left_open',
      detail: 'connection still inside a transaction after every drain settled',
    });
  }
  if (input.integrity !== 'ok') {
    violations.push({
      code: 'integrity_check_failed',
      detail: input.integrity,
    });
  }
  return violations;
}

/** Exact-state comparison against the contract model (single drain). */
export function modelViolations(input: {
  expected: ExpectedOutcome;
  observation: DrainObservation;
  after: OutboxRowSnapshot[];
  receipts: ReceiptSnapshot[];
  queue: LoadedQueue;
  owner: string;
}): Violation[] {
  const violations: Violation[] = [];
  const { expected, observation } = input;
  const known = new Set(expected.knownDeviations);
  const tag = (violation: Violation, finding: string | undefined): Violation =>
    finding && known.has(finding) ? { ...violation, finding } : violation;

  if (expected.unmodeled) return violations;
  if (observation.settlement !== expected.settlement) {
    violations.push({
      code: 'settlement_mismatch',
      detail: `expected ${expected.settlement}, observed ${observation.settlement}${observation.error ? ` (${observation.error})` : ''}`,
    });
  }

  const afterByLabel = new Map<string, OutboxRowSnapshot>();
  for (const row of input.after) {
    const meta = input.queue.byId.get(row.id);
    if (meta?.group === 'active') afterByLabel.set(meta.label, row);
  }
  for (const [label, expectedRow] of expected.rows) {
    const actual = afterByLabel.get(label);
    const meta = [...input.queue.byId.values()].find(
      row => row.label === label,
    );
    if (expectedRow.present && !actual) {
      violations.push({
        code: 'row_unexpectedly_deleted',
        detail: `${label} (${meta?.kind})`,
      });
      continue;
    }
    if (!expectedRow.present && actual) {
      violations.push({
        code: 'row_unexpectedly_kept',
        detail: `${label} (${meta?.kind}) still present attempts=${actual.attempts} last_error=${actual.last_error}`,
      });
      continue;
    }
    if (!actual) continue;
    if (actual.attempts !== expectedRow.attempts) {
      const finding =
        meta?.kind === 'session_finalize_null'
          ? 'F1'
          : expected.knownDeviations.includes('F2')
            ? 'F2'
            : undefined;
      violations.push(
        tag(
          {
            code: 'attempts_mismatch',
            detail: `${label} (${meta?.kind}): expected ${expectedRow.attempts}, observed ${actual.attempts} (last_error=${actual.last_error})`,
          },
          finding,
        ),
      );
    }
    if (expectedRow.errorRecorded && actual.last_error === null) {
      violations.push({
        code: 'silent_failure',
        detail: `${label} (${meta?.kind}) failed without last_error`,
      });
    }
  }

  const actualReceipts = new Set(
    input.receipts
      .filter(
        receipt =>
          receipt.owner_key === input.owner && receipt.kind === RECEIPT_KIND,
      )
      .map(receipt => receipt.entity_id),
  );
  for (const id of expected.receipts) {
    if (!actualReceipts.has(id)) {
      violations.push({ code: 'receipt_missing', detail: id });
    }
  }
  for (const id of actualReceipts) {
    if (!expected.receipts.has(id)) {
      violations.push({ code: 'receipt_unexpected', detail: id });
    }
  }

  if (observation.settlement === 'resolved' && observation.result) {
    if (observation.result.synced !== expected.synced) {
      violations.push({
        code: 'synced_count_mismatch',
        detail: `expected ${expected.synced}, observed ${observation.result.synced}`,
      });
    }
    if (observation.result.failed !== expected.failed) {
      violations.push({
        code: 'failed_count_mismatch',
        detail: `expected ${expected.failed}, observed ${observation.result.failed}`,
      });
    }
    const remaining = input.after.filter(
      row => row.owner_key === input.owner,
    ).length;
    if (observation.result.remaining !== remaining) {
      violations.push({
        code: 'remaining_count_mismatch',
        detail: `reported ${observation.result.remaining}, table holds ${remaining}`,
      });
    }
  }
  return violations;
}
