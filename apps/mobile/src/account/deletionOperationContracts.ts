import type { DataOwnerContext } from '../data/accountScope';

export const DELETION_FOUNDATION_LIMITS = Object.freeze({
  journalEntries: 32,
  journalBytes: 393_216,
  secretBytes: 8192,
  responseBytes: 16_384,
  ownershipReferences: 16,
  ownershipReferenceBytes: 16_384,
  reviewMilliseconds: 3000,
});

export const DELETION_SERVER_POLICY = Object.freeze({
  statusCapabilityLifetimeSeconds: 86_400,
  operationRetentionSeconds: 604_800,
  legallyApproved: false,
  deploymentApproved: false,
});

export const DELETION_PHASES = [
  'request_pending',
  'request_unknown',
  'securing',
  'ready',
  'confirm_pending',
  'observing',
  'receipt_pending',
  'receipt_verified',
  'cleanup_pending',
  'cleanup_complete',
] as const;

export const DELETION_SERVER_STATES = [
  'pending',
  'in_progress',
  'completed',
  'superseded',
  'expired',
  'blocked',
] as const;

export const DELETION_CLEANUP_STEPS = [
  'owned_media',
  'owner_local_data',
] as const;

export const DELETION_ISSUES = [
  'raw_transactional_db_required',
  'journal_schema_invalid',
  'journal_unavailable',
  'journal_invalid',
  'journal_unsupported',
  'journal_capacity',
  'journal_conflict',
  'invalid_ownership_draft',
  'invalid_binding',
  'invalid_response',
  'stale_handler',
  'session_required',
  'origin_unavailable',
  'request_unknown',
  'confirmation_unknown',
  'confirmation_expired',
  'review_required',
  'status_expired',
  'retry_later',
  'unknown',
  'in_progress',
  'rate_limited',
  'blocked',
  'rejected',
  'capability_missing',
  'capability_unavailable',
  'capability_invalid',
  'capability_unsupported',
  'capability_conflict',
  'capability_write_ambiguous',
  'receipt_required',
  'receipt_conflict',
  'maintenance_required',
  'cleanup_unknown',
] as const;

export type DeletionIssue = (typeof DELETION_ISSUES)[number];
export type DeletionPhase = (typeof DELETION_PHASES)[number];
export type DeletionServerState = (typeof DELETION_SERVER_STATES)[number];
export type DeletionCleanupStep = (typeof DELETION_CLEANUP_STEPS)[number];
export type DeletionAppleOutcome =
  'revoked' | 'not_applicable' | 'manual_action_required';

export class DeletionFoundationError extends Error {
  constructor(readonly code: DeletionIssue) {
    super(`Account deletion foundation: ${code}`);
    this.name = 'DeletionFoundationError';
  }
}

export interface DeletionScope {
  readonly ownerId: string;
  readonly apiOrigin: string;
}

export interface DeletionBinding extends DeletionScope {
  readonly jobId: string;
  readonly operationId: string;
}

export interface DeletionReceipt {
  readonly completedAt: string;
  readonly appleAuthorizationRevocation: DeletionAppleOutcome;
}

export interface DeletionRequestWire {
  readonly challenge: string;
  readonly expiresAt: string;
  readonly operationId: string;
  readonly statusCapability: string;
  readonly statusExpiresAt: string;
}

export interface DeletionStatusWire {
  readonly state: DeletionServerState;
  readonly completionReceipt: { readonly completedAt: string } | null;
  readonly appleAuthorizationRevocation: DeletionAppleOutcome | null;
}

export interface DeletionSecretRecord
  extends DeletionBinding, DeletionRequestWire {
  readonly version: 1;
  readonly receipt: DeletionReceipt | null;
}

export interface DeletionOwnershipDraft {
  readonly references: readonly string[];
  readonly legacyMedia: 'unverified';
}

export interface DeletionJournalEntry extends DeletionScope {
  readonly version: 1;
  readonly jobId: string;
  readonly operationId: string | null;
  readonly revision: number;
  readonly phase: DeletionPhase;
  readonly expiresAt: string | null;
  readonly statusExpiresAt: string | null;
  readonly reviewAfterMs: number | null;
  readonly createdAtMs: number;
  readonly nextAttemptAtMs: number;
  readonly retryCount: number;
  readonly serverState: DeletionServerState | 'unknown' | null;
  readonly lastIssue: DeletionIssue | null;
  readonly receipt: DeletionReceipt | null;
  readonly cleanup: {
    readonly completed: readonly DeletionCleanupStep[];
    readonly pending: DeletionCleanupStep | null;
  };
  readonly ownership: DeletionOwnershipDraft;
}

export interface DeletionRuntimePort {
  originSnapshot(): {
    readonly apiOrigin: string | null;
    readonly generation: number;
  };
  ownerSnapshot(): DataOwnerContext;
  bearerFor(owner: DataOwnerContext): string | null;
}

export interface DeletionHttpRequest extends RequestInit {
  readonly redirect: 'error';
  readonly credentials: 'omit';
  readonly cache: 'no-store';
  readonly referrerPolicy: 'no-referrer';
}

export interface DeletionHttpPort {
  fetchNoRedirect(input: string, init: DeletionHttpRequest): Promise<Response>;
}

export interface DeletionMaintenanceRequest {
  readonly binding: DeletionBinding;
  readonly activeOwner: DataOwnerContext;
  readonly originGeneration: number;
  readonly mutationScope: 'original-owner-only';
  readonly globalSessionMutation: 'forbidden';
  readonly globalProfileMutation: 'forbidden';
}

export interface DeletionMaintenanceLease {
  readonly binding: DeletionBinding;
  isCurrent(): boolean;
  release(): Promise<void>;
}

export interface DeletionMaintenancePort {
  acquire(
    request: DeletionMaintenanceRequest,
  ): Promise<DeletionMaintenanceLease | null>;
}

export interface DeletionCleanupWork extends DeletionMaintenanceRequest {
  readonly receipt: DeletionReceipt;
  readonly step: DeletionCleanupStep;
  readonly idempotencyKey: string;
  readonly ownership: DeletionOwnershipDraft;
  readonly nativeOwnershipVerified: false;
  isCurrent(): boolean;
}

export type DeletionCleanupContinuation = (
  work: DeletionCleanupWork,
) => Promise<'checkpointed' | 'pending'>;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CAPABILITY = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/;

export function deletionUuid(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 && UUID.test(value);
}

export function deletionCapability(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length === 43 && CAPABILITY.test(value)
  );
}

export function deletionInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function deletionRecord(
  value: unknown,
): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function deletionExact(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!deletionRecord(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(value).length !== keys.length
  )
    return false;
  return keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && Object.hasOwn(descriptor, 'value');
  });
}

export function deletionMember<T extends string>(
  value: unknown,
  values: readonly T[],
): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

export function deletionOrigin(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length > 512 ||
    /[\s\\?#%]/.test(value)
  )
    return false;
  try {
    const url = new URL(value);
    const path = url.pathname === '/' ? '' : url.pathname;
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.hostname.endsWith('.') &&
      ['', '/api', '/functions/v1/api'].includes(path) &&
      value === `${url.origin}${path}`
    );
  } catch {
    return false;
  }
}

export function deletionTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 32) return false;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)$/.exec(
      value,
    );
  if (!match) return false;
  const date = new Date(value);
  return (
    Number.isFinite(date.getTime()) &&
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() + 1 === Number(match[2]) &&
    date.getUTCDate() === Number(match[3]) &&
    date.getUTCHours() === Number(match[4]) &&
    date.getUTCMinutes() === Number(match[5]) &&
    date.getUTCSeconds() === Number(match[6])
  );
}

export function deletionAppleOutcome(
  value: unknown,
): value is DeletionAppleOutcome {
  return (
    value === 'revoked' ||
    value === 'not_applicable' ||
    value === 'manual_action_required'
  );
}

export function parseDeletionReceipt(value: unknown): DeletionReceipt | null {
  try {
    if (
      !deletionExact(value, ['completedAt', 'appleAuthorizationRevocation']) ||
      !deletionTimestamp(value.completedAt) ||
      !deletionAppleOutcome(value.appleAuthorizationRevocation)
    )
      return null;
    return Object.freeze({
      completedAt: value.completedAt,
      appleAuthorizationRevocation: value.appleAuthorizationRevocation,
    });
  } catch {
    return null;
  }
}

export function parseDeletionRequest(
  value: unknown,
): DeletionRequestWire | null {
  try {
    if (
      !deletionExact(value, [
        'challenge',
        'expiresAt',
        'operationId',
        'statusCapability',
        'statusExpiresAt',
      ]) ||
      !deletionUuid(value.challenge) ||
      !deletionUuid(value.operationId) ||
      !deletionCapability(value.statusCapability) ||
      !deletionTimestamp(value.expiresAt) ||
      !deletionTimestamp(value.statusExpiresAt) ||
      Date.parse(value.statusExpiresAt) <= Date.parse(value.expiresAt)
    )
      return null;
    return Object.freeze({
      challenge: value.challenge,
      expiresAt: value.expiresAt,
      operationId: value.operationId,
      statusCapability: value.statusCapability,
      statusExpiresAt: value.statusExpiresAt,
    });
  } catch {
    return null;
  }
}

export function parseDeletionStatus(value: unknown): DeletionStatusWire | null {
  try {
    if (
      !deletionExact(value, [
        'state',
        'completionReceipt',
        'appleAuthorizationRevocation',
      ]) ||
      !deletionMember(value.state, DELETION_SERVER_STATES)
    )
      return null;
    if (value.state !== 'completed') {
      return value.completionReceipt === null &&
        value.appleAuthorizationRevocation === null
        ? Object.freeze({
            state: value.state,
            completionReceipt: null,
            appleAuthorizationRevocation: null,
          })
        : null;
    }
    if (
      !deletionExact(value.completionReceipt, ['completedAt']) ||
      !deletionTimestamp(value.completionReceipt.completedAt) ||
      !deletionAppleOutcome(value.appleAuthorizationRevocation)
    )
      return null;
    return Object.freeze({
      state: value.state,
      completionReceipt: Object.freeze({
        completedAt: value.completionReceipt.completedAt,
      }),
      appleAuthorizationRevocation: value.appleAuthorizationRevocation,
    });
  } catch {
    return null;
  }
}

export function validDeletionBinding(value: DeletionBinding): boolean {
  return (
    deletionUuid(value.jobId) &&
    deletionUuid(value.ownerId) &&
    deletionUuid(value.operationId) &&
    deletionOrigin(value.apiOrigin)
  );
}

export function sameDeletionBinding(
  a: DeletionBinding,
  b: DeletionBinding,
): boolean {
  return (
    a.jobId === b.jobId &&
    a.ownerId === b.ownerId &&
    a.apiOrigin === b.apiOrigin &&
    a.operationId === b.operationId
  );
}

export function sameDeletionReceipt(
  a: DeletionReceipt | null,
  b: DeletionReceipt | null,
): boolean {
  return a === null || b === null
    ? a === b
    : a.completedAt === b.completedAt &&
        a.appleAuthorizationRevocation === b.appleAuthorizationRevocation;
}

export function parseDeletionSecret(
  value: unknown,
): DeletionSecretRecord | null {
  try {
    if (
      !deletionExact(value, [
        'version',
        'jobId',
        'ownerId',
        'apiOrigin',
        'operationId',
        'challenge',
        'expiresAt',
        'statusCapability',
        'statusExpiresAt',
        'receipt',
      ]) ||
      value.version !== 1 ||
      !deletionUuid(value.jobId) ||
      !deletionUuid(value.ownerId) ||
      !deletionOrigin(value.apiOrigin)
    )
      return null;
    const request = parseDeletionRequest({
      challenge: value.challenge,
      expiresAt: value.expiresAt,
      operationId: value.operationId,
      statusCapability: value.statusCapability,
      statusExpiresAt: value.statusExpiresAt,
    });
    const receipt =
      value.receipt === null ? null : parseDeletionReceipt(value.receipt);
    if (!request || (value.receipt !== null && receipt === null)) return null;
    const record = Object.freeze({
      version: 1 as const,
      jobId: value.jobId,
      ownerId: value.ownerId,
      apiOrigin: value.apiOrigin,
      ...request,
      receipt,
    });
    return JSON.stringify(record).length <=
      DELETION_FOUNDATION_LIMITS.secretBytes
      ? record
      : null;
  } catch {
    return null;
  }
}

export function parseDeletionOwnership(
  value: unknown,
): DeletionOwnershipDraft | null {
  try {
    if (
      !deletionExact(value, ['references', 'legacyMedia']) ||
      value.legacyMedia !== 'unverified' ||
      !Array.isArray(value.references) ||
      value.references.length > DELETION_FOUNDATION_LIMITS.ownershipReferences
    )
      return null;
    const references: string[] = [];
    for (const reference of value.references) {
      if (
        typeof reference !== 'string' ||
        reference.length < 4 ||
        reference.length > 21_848 ||
        !BASE64.test(reference)
      )
        return null;
      const bytes =
        (reference.length / 4) * 3 -
        (reference.endsWith('==') ? 2 : reference.endsWith('=') ? 1 : 0);
      if (
        bytes > DELETION_FOUNDATION_LIMITS.ownershipReferenceBytes ||
        references.includes(reference)
      )
        return null;
      references.push(reference);
    }
    return Object.freeze({
      references: Object.freeze(references),
      legacyMedia: 'unverified',
    });
  } catch {
    return null;
  }
}

export function parseDeletionJournalEntry(
  value: unknown,
): DeletionJournalEntry | null {
  try {
    if (
      !deletionExact(value, [
        'version',
        'jobId',
        'ownerId',
        'apiOrigin',
        'operationId',
        'revision',
        'phase',
        'expiresAt',
        'statusExpiresAt',
        'reviewAfterMs',
        'createdAtMs',
        'nextAttemptAtMs',
        'retryCount',
        'serverState',
        'lastIssue',
        'receipt',
        'cleanup',
        'ownership',
      ]) ||
      value.version !== 1 ||
      !deletionUuid(value.jobId) ||
      !deletionUuid(value.ownerId) ||
      !deletionOrigin(value.apiOrigin) ||
      !deletionInteger(value.revision) ||
      !deletionMember(value.phase, DELETION_PHASES) ||
      !deletionInteger(value.createdAtMs) ||
      !deletionInteger(value.nextAttemptAtMs) ||
      !deletionInteger(value.retryCount) ||
      value.retryCount > 20 ||
      (value.lastIssue !== null &&
        !deletionMember(value.lastIssue, DELETION_ISSUES)) ||
      (value.serverState !== null &&
        value.serverState !== 'unknown' &&
        !deletionMember(value.serverState, DELETION_SERVER_STATES))
    )
      return null;
    const ownership = parseDeletionOwnership(value.ownership);
    const receipt =
      value.receipt === null ? null : parseDeletionReceipt(value.receipt);
    if (
      !ownership ||
      (value.receipt !== null && !receipt) ||
      !deletionExact(value.cleanup, ['completed', 'pending']) ||
      !Array.isArray(value.cleanup.completed) ||
      value.cleanup.completed.length > DELETION_CLEANUP_STEPS.length ||
      !Array.from(value.cleanup.completed).every(
        (step, index) => step === DELETION_CLEANUP_STEPS[index],
      ) ||
      (value.cleanup.pending !== null &&
        value.cleanup.pending !==
          DELETION_CLEANUP_STEPS[value.cleanup.completed.length])
    )
      return null;
    if (value.operationId === null) {
      if (
        (value.phase !== 'request_pending' &&
          value.phase !== 'request_unknown') ||
        value.expiresAt !== null ||
        value.statusExpiresAt !== null ||
        value.reviewAfterMs !== null ||
        receipt !== null ||
        (value.serverState !== null && value.serverState !== 'unknown')
      )
        return null;
    } else if (
      !deletionUuid(value.operationId) ||
      !deletionTimestamp(value.expiresAt) ||
      !deletionTimestamp(value.statusExpiresAt) ||
      Date.parse(value.statusExpiresAt) <= Date.parse(value.expiresAt) ||
      !deletionInteger(value.reviewAfterMs) ||
      value.reviewAfterMs < value.createdAtMs ||
      value.phase === 'request_pending' ||
      value.phase === 'request_unknown'
    )
      return null;
    const receiptPhase = [
      'receipt_pending',
      'receipt_verified',
      'cleanup_pending',
      'cleanup_complete',
    ].includes(value.phase);
    if (
      receiptPhase !== (receipt !== null) ||
      (value.serverState === 'completed') !== (receipt !== null)
    )
      return null;
    if (value.phase === 'cleanup_complete') {
      if (
        value.cleanup.completed.length !== DELETION_CLEANUP_STEPS.length ||
        value.cleanup.pending !== null
      )
        return null;
    } else if (value.phase === 'cleanup_pending') {
      if (value.cleanup.completed.length === DELETION_CLEANUP_STEPS.length)
        return null;
    } else if (
      value.cleanup.completed.length !== 0 ||
      value.cleanup.pending !== null
    )
      return null;
    const entry = Object.freeze({
      version: 1 as const,
      jobId: value.jobId,
      ownerId: value.ownerId,
      apiOrigin: value.apiOrigin,
      operationId: value.operationId as string | null,
      revision: value.revision,
      phase: value.phase,
      expiresAt: value.expiresAt as string | null,
      statusExpiresAt: value.statusExpiresAt as string | null,
      reviewAfterMs: value.reviewAfterMs as number | null,
      createdAtMs: value.createdAtMs,
      nextAttemptAtMs: value.nextAttemptAtMs,
      retryCount: value.retryCount,
      serverState: value.serverState,
      lastIssue: value.lastIssue,
      receipt,
      cleanup: Object.freeze({
        completed: Object.freeze([
          ...value.cleanup.completed,
        ] as DeletionCleanupStep[]),
        pending: value.cleanup.pending as DeletionCleanupStep | null,
      }),
      ownership,
    });
    return JSON.stringify(entry).length <=
      DELETION_FOUNDATION_LIMITS.journalBytes
      ? entry
      : null;
  } catch {
    return null;
  }
}

export function deletionBindingFor(
  entry: DeletionJournalEntry,
): DeletionBinding | null {
  return entry.operationId === null
    ? null
    : Object.freeze({
        jobId: entry.jobId,
        ownerId: entry.ownerId,
        apiOrigin: entry.apiOrigin,
        operationId: entry.operationId,
      });
}
