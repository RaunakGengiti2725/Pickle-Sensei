import {
  OFFLINE_PRO_LEASE_MAX_SECONDS,
  validateOfflineExecutionGrantMetadata,
  validateOfflineSignedGrantShape,
  type OfflineExecutionGrantClaims,
  type OfflineFreeTicketReference,
} from '@pickle/shared-types';
import { sha256Hex } from '@pickle/swing-domain';
import { makeUuid } from '../util/uuid';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  captureDataOwnerContext,
  getActiveDataOwner,
  type DataOwnerContext,
} from './accountScope';
import type { IssuedOfflineGrant, OfflineGrantClient } from './api';
import type { LocalDb } from './db';
import { OUTBOX_MAX_ATTEMPTS } from './sync';
import { forDataOwner, withTransaction } from './transactions';
import {
  evaluateLease,
  type TrustedTimeLeaseVerdict,
  type TrustedTimeReading,
} from './trustedTime';

/**
 * OFFLINE / WEAK-NETWORK CAPABILITY MAP (workstream i28).
 *
 * Every user-facing capability is classified by where it actually executes,
 * so offline behavior is a typed, testable fact instead of folklore:
 *
 *   ON-DEVICE        — runs entirely on the phone; a dead radio changes
 *                      nothing.
 *   SERVER-DEPENDENT — cannot produce its result without the API; offline it
 *                      either queues durably (outbox) or is honestly
 *                      unavailable. It never spins forever: every API request
 *                      is bounded by API_REQUEST_TIMEOUT_MS (src/data/api.ts).
 *   HYBRID           — the core work is on-device but one server interaction
 *                      gates or enriches it (e.g. the analysis permit).
 *
 * The map is descriptive of the code as it exists today — each entry names
 * the module that implements the behavior. It must never promise offline
 * behavior the code does not have.
 *
 * HONEST LIMIT: this classification and the jest suites over the sync/state
 * machines are logic-level evidence. Real network-loss testing on a physical
 * device (airplane mode mid-upload, radio flapping during capture) is
 * BLOCKED_EXTERNAL until a device build exists — see
 * REAL_DEVICE_NETWORK_TESTING.
 */

export type NetworkDependency = 'on-device' | 'server-dependent' | 'hybrid';

/** What the capability does when the network is down or unusable. */
export type OfflineDegradation =
  /** Fully functional offline. */
  | 'works_offline'
  /** Reads previously-persisted local/cached state; no new server data. */
  | 'reads_local_state'
  /** Work persists to the durable outbox and uploads later, idempotently. */
  | 'queues_durably'
  /** Honestly unavailable offline — surfaced as a typed error, not a spinner. */
  | 'unavailable_offline';

export type CapabilityId =
  | 'capture.recordClip'
  | 'capture.envelopeGate'
  | 'capture.poseSidecar'
  | 'analysis.strokeScoring'
  | 'analysis.permitReservation'
  | 'analysis.offlineGrant'
  | 'session.livePlay'
  | 'history.browse'
  | 'progress.trends'
  | 'sync.shotUpload'
  | 'sync.sessionUpload'
  | 'sync.evaluationTrialUpload'
  | 'auth.signIn'
  | 'billing.entitlement';

export interface CapabilityClassification {
  readonly id: CapabilityId;
  readonly dependency: NetworkDependency;
  readonly degradation: OfflineDegradation;
  /** Module that implements the behavior this entry describes. */
  readonly implementedBy: string;
  /** What actually happens on a dead/flaky network. */
  readonly offlineBehavior: string;
}

export const OFFLINE_CAPABILITY_MAP_V1: Readonly<
  Record<CapabilityId, CapabilityClassification>
> = {
  'capture.recordClip': {
    id: 'capture.recordClip',
    dependency: 'on-device',
    degradation: 'works_offline',
    implementedBy: 'src/camera/capture.ts',
    offlineBehavior:
      'Recording, clip finalization and durable capture rows are fully local.',
  },
  'capture.envelopeGate': {
    id: 'capture.envelopeGate',
    dependency: 'on-device',
    degradation: 'works_offline',
    implementedBy: 'src/camera/captureEnvelope.ts',
    offlineBehavior:
      'Envelope quality gating evaluates recorded evidence locally.',
  },
  'capture.poseSidecar': {
    id: 'capture.poseSidecar',
    dependency: 'on-device',
    degradation: 'works_offline',
    implementedBy: 'src/camera/capture.ts (hash-addressed native sidecar)',
    offlineBehavior:
      'Pose extraction writes the sidecar on-device at capture time.',
  },
  'analysis.strokeScoring': {
    id: 'analysis.strokeScoring',
    dependency: 'hybrid',
    degradation: 'unavailable_offline',
    implementedBy: 'src/analysis/runCaptureAnalysis.ts',
    offlineBehavior:
      'Inference and scoring run on-device, but a server-reserved analysis ' +
      'permit gates each rated run. Offline, the permit reservation fails ' +
      'with a typed ApiError inside the bounded request timeout; the capture ' +
      'stays durably persisted as awaiting_model and is re-analyzable later. ' +
      'No attempt is lost and nothing spins indefinitely.',
  },
  'analysis.permitReservation': {
    id: 'analysis.permitReservation',
    dependency: 'server-dependent',
    degradation: 'unavailable_offline',
    implementedBy: 'src/data/api.ts (createAnalysisPermitClient)',
    offlineBehavior:
      'Reservation requires the entitlement server. Offline it fails fast ' +
      '(bounded timeout → ApiError 408); no permit is burned.',
  },
  'analysis.offlineGrant': {
    id: 'analysis.offlineGrant',
    dependency: 'hybrid',
    degradation: 'reads_local_state',
    implementedBy:
      'src/data/offlineCapabilities.ts (holdOfflineGrant, ' +
      'consumeOfflineAllocation)',
    offlineBehavior:
      'A signed execution grant is requested from the server while online ' +
      'and held in local SQLite. Offline, a rated run spends one ticket of ' +
      'the held allocation under trusted time and queues its consumption ' +
      'receipt in the same transaction. Allocation is not consumption: a ' +
      'lost connection, a restart or an expired lease never returns a ' +
      'ticket; only the server settles receipts.',
  },
  'session.livePlay': {
    id: 'session.livePlay',
    dependency: 'on-device',
    degradation: 'works_offline',
    implementedBy: 'src/flow/session.ts (LiveSessionFlow)',
    offlineBehavior:
      'The session event engine consumes on-device wrist-motion samples; ' +
      'event detection, timeline and distribution need no network. Per-event ' +
      'analysis outcomes follow analysis.strokeScoring.',
  },
  'history.browse': {
    id: 'history.browse',
    dependency: 'on-device',
    degradation: 'works_offline',
    implementedBy: 'src/data/repository.ts over local SQLite',
    offlineBehavior:
      'History reads the local database; every analysis persists offline ' +
      'first (directive §32).',
  },
  'progress.trends': {
    id: 'progress.trends',
    dependency: 'on-device',
    degradation: 'works_offline',
    implementedBy: 'src/progress over local SQLite rows',
    offlineBehavior: 'Trends aggregate locally persisted real analyses.',
  },
  'sync.shotUpload': {
    id: 'sync.shotUpload',
    dependency: 'server-dependent',
    degradation: 'queues_durably',
    implementedBy: 'src/data/sync.ts (drainOutbox) + src/data/syncRuntime.ts',
    offlineBehavior:
      'Rated shots enter the durable outbox with client-generated UUIDs. ' +
      'Transient failures (offline, timeout, 5xx, 401, 429) never consume ' +
      'the bounded attempt budget; server-side idempotent upserts make ' +
      'retries duplicate-safe.',
  },
  'sync.sessionUpload': {
    id: 'sync.sessionUpload',
    dependency: 'server-dependent',
    degradation: 'queues_durably',
    implementedBy: 'src/data/sync.ts (session.create / session.finalize)',
    offlineBehavior:
      'Session create/finalize rows drain from the same durable outbox with ' +
      'the same transient/permanent failure split.',
  },
  'sync.evaluationTrialUpload': {
    id: 'sync.evaluationTrialUpload',
    dependency: 'server-dependent',
    degradation: 'queues_durably',
    implementedBy: 'src/data/sync.ts (uploadEvaluationTrials)',
    offlineBehavior:
      'Consent-gated trials stay queued when the transport lacks the upload ' +
      'or the network is down; evidence is never dropped.',
  },
  'auth.signIn': {
    id: 'auth.signIn',
    dependency: 'server-dependent',
    degradation: 'unavailable_offline',
    implementedBy: 'src/auth + src/account/apiSession.ts',
    offlineBehavior:
      'Sign-in needs the identity provider and API. Offline it fails with a ' +
      'typed error; existing local data remains readable under its owner key.',
  },
  'billing.entitlement': {
    id: 'billing.entitlement',
    dependency: 'hybrid',
    degradation: 'reads_local_state',
    implementedBy: 'src/billing + src/state/accessStore.ts',
    offlineBehavior:
      'Entitlement refresh needs the billing backend; the last known access ' +
      'state persists locally and is read offline. New purchases are ' +
      'unavailable offline.',
  },
};

export function capabilityDependency(id: CapabilityId): NetworkDependency {
  return OFFLINE_CAPABILITY_MAP_V1[id].dependency;
}

export function capabilitiesByDependency(
  dependency: NetworkDependency,
): CapabilityClassification[] {
  return Object.values(OFFLINE_CAPABILITY_MAP_V1).filter(
    entry => entry.dependency === dependency,
  );
}

// ─── Upload queue status (derived from durable rows, never from promises) ──

/** The durable outbox columns the status derivation reads. */
export interface OutboxRowStatus {
  readonly kind: string;
  readonly attempts: number;
  readonly lastError: string | null;
}

/**
 * User-facing upload-queue status. Derived ONLY from durable outbox rows —
 * never from an in-flight request — so a hung or lost network call can never
 * pin the UI in a perpetual "uploading" state: there is no 'uploading'
 * variant at all. Rows below the attempt cap are 'queued' (will retry);
 * rows at the cap failed permanently and need attention.
 */
export type UploadQueueStatus =
  | { readonly state: 'idle' }
  | { readonly state: 'queued'; readonly pending: number }
  | {
      readonly state: 'needs_attention';
      readonly pending: number;
      readonly exhausted: number;
    };

export function deriveUploadQueueStatus(
  rows: readonly OutboxRowStatus[],
): UploadQueueStatus {
  if (rows.length === 0) return { state: 'idle' };
  const exhausted = rows.filter(
    row => row.attempts >= OUTBOX_MAX_ATTEMPTS,
  ).length;
  const pending = rows.length - exhausted;
  if (exhausted > 0) return { state: 'needs_attention', pending, exhausted };
  return { state: 'queued', pending };
}

// ─── Honest external blocker ───────────────────────────────────────────────

/**
 * BLOCKED_EXTERNAL: everything above is logic-level evidence over fakes and
 * the real sync/state-machine code. Verifying behavior under REAL network
 * loss — airplane mode mid-upload, radio flapping during capture, OS-level
 * request cancellation — requires a physical device build, which does not
 * exist in this environment. Nothing here may be reported as device-verified.
 */
export const REAL_DEVICE_NETWORK_TESTING = {
  status: 'BLOCKED_EXTERNAL',
  detail:
    'Real network-loss testing (airplane mode, radio flapping) requires a ' +
    'physical device build; jest evidence covers the sync engine and session ' +
    'state machine logic only.',
} as const;

/**
 * OFFLINE EXECUTION GRANTS (W04-05): allocation ≠ consumption.
 *
 * The server issues a signed execution grant (`POST /v1/offline/grants`) whose
 * free tickets are already counted against the identity's lifetime budget in
 * the server ledger. The device HOLDS that grant in local SQLite and spends
 * ONE ticket per rated run — under trusted time, inside the same transaction
 * that queues the consumption receipt. Nothing on the device ever adds a
 * ticket back: disconnect, process death, reinstall, key replacement and
 * lease expiry all leave the local allocation exactly as the last consumption
 * left it. The server alone settles receipts, and settled receipts stay as
 * history. Unreadable wallet state is a typed failure, never an empty wallet.
 */

export const OFFLINE_WALLET_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS offline_grant (
    owner_key TEXT NOT NULL,
    grant_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    installation_key_id TEXT NOT NULL,
    entitlement_source TEXT NOT NULL,
    key_id TEXT NOT NULL,
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    entitlement_expires_at INTEGER,
    allocation_id TEXT,
    compact_jws TEXT NOT NULL,
    grant_jws_sha256 TEXT NOT NULL,
    allocated_ticket_ids TEXT NOT NULL,
    remaining_ticket_ids TEXT NOT NULL,
    lifecycle_sequence INTEGER NOT NULL,
    held_at TEXT NOT NULL,
    PRIMARY KEY (owner_key, grant_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_offline_grant_owner_generation
    ON offline_grant (owner_key, generation DESC, issued_at DESC)`,
  `CREATE TABLE IF NOT EXISTS offline_receipt (
    owner_key TEXT NOT NULL,
    receipt_id TEXT NOT NULL,
    grant_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    lifecycle_sequence INTEGER NOT NULL,
    receipt TEXT NOT NULL,
    queued_at TEXT NOT NULL,
    settlement TEXT,
    settled_at TEXT,
    PRIMARY KEY (owner_key, receipt_id),
    UNIQUE (owner_key, operation_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_offline_receipt_owner_pending
    ON offline_receipt (owner_key, settled_at, queued_at, lifecycle_sequence)`,
];

export type OfflineGrantErrorCode =
  | 'offline.owner_unsigned'
  | 'offline.grant_invalid'
  | 'offline.grant_not_held'
  | 'offline.grant_expired'
  | 'offline.time_reconcile_required'
  | 'offline.allocation_exhausted'
  | 'offline.result_invalid'
  | 'offline.receipt_unknown'
  | 'offline.receipt_settled'
  | 'offline.wallet_corrupt';

export class OfflineGrantError extends Error {
  constructor(
    readonly code: OfflineGrantErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OfflineGrantError';
  }
}

export type OfflineEntitlementSource =
  'identity_lifetime_free' | 'verified_store';

export interface OfflineGrantBindingInput {
  /** The exact issuer the signed grant's `iss` must equal. */
  readonly issuer: string;
  /** This installation's registered key id (`installationKeyId` claim). */
  readonly installationKeyId: string;
}

export interface HeldOfflineGrant {
  readonly grantId: string;
  readonly generation: number;
  readonly entitlementSource: OfflineEntitlementSource;
  readonly installationKeyId: string;
  readonly keyId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly entitlementExpiresAt: number | null;
  readonly grantJwsSha256: string;
  /** Tickets the server allocated to this grant (0 for a Pro lease). */
  readonly allocated: number;
  /** Tickets not yet spent locally. Only consumption lowers it. */
  readonly remaining: number;
  /** Tickets spent locally, each backed by a queued receipt. */
  readonly consumed: number;
  /** Count of every result this grant has paid for, tickets or lease. */
  readonly lifecycleSequence: number;
}

export interface HeldOfflineGrantView extends HeldOfflineGrant {
  readonly execution: TrustedTimeLeaseVerdict;
}

export interface OfflineAllocationSnapshot {
  readonly grants: readonly HeldOfflineGrantView[];
  readonly pendingReceipts: number;
}

export type OfflineReceiptSettlement = 'accepted' | 'held' | 'refused';

export interface OfflineConsumptionReceipt {
  readonly receiptId: string;
  readonly ownerId: string;
  readonly installationKeyId: string;
  readonly grantId: string;
  readonly grantJwsSha256: string;
  readonly lifecycleSequence: number;
  readonly ticket: OfflineFreeTicketReference | null;
  readonly operationId: string;
  readonly resultId: string;
  readonly fullOutputSha256: string;
  readonly billingDisposition: 'joint_verification_required';
  readonly queuedAt: string;
  readonly settlement: OfflineReceiptSettlement | null;
  readonly settledAt: string | null;
}

export interface OfflineConsumptionInput {
  /** Idempotency key of the rated run; a replay returns the first receipt. */
  readonly operationId: string;
  readonly resultId: string;
  readonly fullOutputSha256: string;
  /** Spend from this grant only; default is the newest executable grant. */
  readonly grantId?: string;
}

export interface OfflineConsumption {
  readonly receipt: OfflineConsumptionReceipt;
  readonly grant: HeldOfflineGrantView;
  readonly replayed: boolean;
}

interface StoredOfflineGrant extends HeldOfflineGrant {
  readonly allocationId: string | null;
  readonly compactJws: string;
  readonly allocatedTicketIds: readonly string[];
  readonly remainingTicketIds: readonly string[];
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:/+=-]{1,128}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function corrupt(detail: string): OfflineGrantError {
  return new OfflineGrantError(
    'offline.wallet_corrupt',
    `Offline grant state on this device is unreadable (${detail}). It is kept as-is for reconciliation and is not treated as an empty allocation.`,
  );
}

function invalidGrant(detail: string): OfflineGrantError {
  return new OfflineGrantError(
    'offline.grant_invalid',
    `The offline grant does not bind to this account and installation (${detail}).`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value);
}

function isUnixSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isUniqueIdentifierList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every(isIdentifier) &&
    new Set(value).size === value.length
  );
}

function sameIdentifierList(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function decodeJwsSegment(segment: string): unknown {
  const bytes: number[] = [];
  let bits = 0;
  let accumulator = 0;
  for (const char of segment) {
    const index = BASE64_ALPHABET.indexOf(
      char === '-' ? '+' : char === '_' ? '/' : char,
    );
    if (index < 0) return undefined;
    accumulator = (accumulator << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 0xff);
      accumulator &= (1 << bits) - 1;
    }
  }
  try {
    return JSON.parse(
      decodeURIComponent(
        bytes.map(byte => `%${byte.toString(16).padStart(2, '0')}`).join(''),
      ),
    );
  } catch {
    return undefined;
  }
}

function signedInOwner(): DataOwnerContext {
  const owner = getActiveDataOwner();
  if (owner === GUEST_DATA_OWNER || owner === SIGNED_OUT_DATA_OWNER) {
    throw new OfflineGrantError(
      'offline.owner_unsigned',
      'Offline ratings need a signed-in account; the server issues grants to an identity, not to a device.',
    );
  }
  return captureDataOwnerContext();
}

/** Bind the server's clear-text answer to the signed claims it carries. The
 * signature itself is verified server-side on settlement; the device refuses
 * to hold anything whose claims disagree with the restated facts, this owner,
 * this installation, the configured issuer or the seven-day lease bound. */
function bindIssuedGrant(
  issued: IssuedOfflineGrant,
  binding: OfflineGrantBindingInput,
  ownerId: string,
): OfflineExecutionGrantClaims {
  const shape = validateOfflineSignedGrantShape(issued.grant);
  if (!shape.ok) throw invalidGrant(shape.failure.code);
  const [headerSegment, payloadSegment] = shape.value.compactJws.split('.');
  const metadata = validateOfflineExecutionGrantMetadata(
    decodeJwsSegment(headerSegment ?? ''),
    decodeJwsSegment(payloadSegment ?? ''),
    {
      issuer: binding.issuer,
      allowedKeyIds: [issued.keyId],
      ownerId,
      installationKeyId: binding.installationKeyId,
    },
  );
  if (!metadata.ok) throw invalidGrant(metadata.failure.code);
  const claims = metadata.value;
  if (
    claims.jti !== issued.grantId ||
    claims.iat !== issued.issuedAt ||
    claims.exp !== issued.expiresAt ||
    claims.entitlementSource !== issued.entitlementSource ||
    claims.exp - claims.iat > OFFLINE_PRO_LEASE_MAX_SECONDS
  ) {
    throw invalidGrant('grant_restatement');
  }
  if (claims.entitlementSource === 'identity_lifetime_free') {
    if (
      claims.allocation.generation !== issued.generation ||
      issued.entitlementExpiresAt !== null ||
      !sameIdentifierList(claims.allocation.ticketIds, issued.ticketIds)
    ) {
      throw invalidGrant('allocation_restatement');
    }
  } else if (
    issued.ticketIds.length !== 0 ||
    claims.lease.verifiedEntitlementExpiresAt !== issued.entitlementExpiresAt
  ) {
    throw invalidGrant('lease_restatement');
  }
  return claims;
}

function parseTicketList(value: unknown): readonly string[] | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isUniqueIdentifierList(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseGrantRow(row: Record<string, unknown>): StoredOfflineGrant {
  const grantId = row['grant_id'];
  const generation = row['generation'];
  const installationKeyId = row['installation_key_id'];
  const entitlementSource = row['entitlement_source'];
  const keyId = row['key_id'];
  const issuedAt = row['issued_at'];
  const expiresAt = row['expires_at'];
  const entitlementExpiresAt = row['entitlement_expires_at'] ?? null;
  const allocationId = row['allocation_id'] ?? null;
  const compactJws = row['compact_jws'];
  const grantJwsSha256 = row['grant_jws_sha256'];
  const lifecycleSequence = row['lifecycle_sequence'];
  const allocatedTicketIds = parseTicketList(row['allocated_ticket_ids']);
  const remainingTicketIds = parseTicketList(row['remaining_ticket_ids']);
  if (
    !isIdentifier(grantId) ||
    !isUnixSeconds(generation) ||
    generation < 1 ||
    !isIdentifier(installationKeyId) ||
    (entitlementSource !== 'identity_lifetime_free' &&
      entitlementSource !== 'verified_store') ||
    !isIdentifier(keyId) ||
    !isUnixSeconds(issuedAt) ||
    !isUnixSeconds(expiresAt) ||
    expiresAt <= issuedAt ||
    (entitlementExpiresAt !== null && !isUnixSeconds(entitlementExpiresAt)) ||
    (allocationId !== null && !isIdentifier(allocationId)) ||
    typeof compactJws !== 'string' ||
    typeof grantJwsSha256 !== 'string' ||
    sha256Hex(compactJws) !== grantJwsSha256 ||
    !isUnixSeconds(lifecycleSequence) ||
    allocatedTicketIds === null ||
    remainingTicketIds === null ||
    !remainingTicketIds.every(ticket => allocatedTicketIds.includes(ticket))
  ) {
    throw corrupt(`grant ${String(grantId)}`);
  }
  const consumed = allocatedTicketIds.length - remainingTicketIds.length;
  if (
    entitlementSource === 'identity_lifetime_free'
      ? lifecycleSequence !== consumed || allocationId === null
      : allocatedTicketIds.length !== 0
  ) {
    throw corrupt(`grant ${grantId} ledger`);
  }
  return {
    grantId,
    generation,
    entitlementSource,
    installationKeyId,
    keyId,
    issuedAt,
    expiresAt,
    entitlementExpiresAt,
    allocationId,
    compactJws,
    grantJwsSha256,
    allocated: allocatedTicketIds.length,
    remaining: remainingTicketIds.length,
    consumed,
    lifecycleSequence,
    allocatedTicketIds,
    remainingTicketIds,
  };
}

function heldGrant(grant: StoredOfflineGrant): HeldOfflineGrant {
  return {
    grantId: grant.grantId,
    generation: grant.generation,
    entitlementSource: grant.entitlementSource,
    installationKeyId: grant.installationKeyId,
    keyId: grant.keyId,
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    entitlementExpiresAt: grant.entitlementExpiresAt,
    grantJwsSha256: grant.grantJwsSha256,
    allocated: grant.allocated,
    remaining: grant.remaining,
    consumed: grant.consumed,
    lifecycleSequence: grant.lifecycleSequence,
  };
}

function viewGrant(
  grant: StoredOfflineGrant,
  reading: TrustedTimeReading,
): HeldOfflineGrantView {
  return {
    ...heldGrant(grant),
    execution: evaluateLease(
      {
        issuedAtMs: grant.issuedAt * 1000,
        expiresAtMs: grant.expiresAt * 1000,
      },
      reading,
    ),
  };
}

async function loadGrants(
  db: LocalDb,
  owner: string,
): Promise<StoredOfflineGrant[]> {
  const { rows } = await db.execute(
    `SELECT * FROM offline_grant WHERE owner_key = ?
     ORDER BY generation DESC, issued_at DESC, grant_id ASC`,
    [owner],
  );
  return rows.map(parseGrantRow);
}

function parseTicketReference(
  value: unknown,
): OfflineFreeTicketReference | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const allocationId = value['allocationId'];
  const generation = value['generation'];
  const ticketId = value['ticketId'];
  if (
    !isIdentifier(allocationId) ||
    !isUnixSeconds(generation) ||
    !isIdentifier(ticketId)
  ) {
    return undefined;
  }
  return { allocationId, generation, ticketId };
}

function parseReceiptRow(
  row: Record<string, unknown>,
): OfflineConsumptionReceipt {
  const raw = row['receipt'];
  const settlement = row['settlement'] ?? null;
  const settledAt = row['settled_at'] ?? null;
  let parsed: unknown;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : undefined;
  } catch {
    parsed = undefined;
  }
  if (
    !isRecord(parsed) ||
    !isIdentifier(parsed['receiptId']) ||
    parsed['receiptId'] !== row['receipt_id'] ||
    typeof parsed['ownerId'] !== 'string' ||
    parsed['ownerId'] !== row['owner_key'] ||
    !isIdentifier(parsed['installationKeyId']) ||
    !isIdentifier(parsed['grantId']) ||
    parsed['grantId'] !== row['grant_id'] ||
    typeof parsed['grantJwsSha256'] !== 'string' ||
    !SHA256_HEX_PATTERN.test(parsed['grantJwsSha256']) ||
    !isUnixSeconds(parsed['lifecycleSequence']) ||
    parsed['lifecycleSequence'] !== row['lifecycle_sequence'] ||
    !isIdentifier(parsed['operationId']) ||
    parsed['operationId'] !== row['operation_id'] ||
    !isIdentifier(parsed['resultId']) ||
    typeof parsed['fullOutputSha256'] !== 'string' ||
    !SHA256_HEX_PATTERN.test(parsed['fullOutputSha256']) ||
    parsed['billingDisposition'] !== 'joint_verification_required' ||
    typeof parsed['queuedAt'] !== 'string' ||
    (settlement !== 'accepted' &&
      settlement !== 'held' &&
      settlement !== 'refused' &&
      settlement !== null) ||
    (settledAt !== null && typeof settledAt !== 'string') ||
    (settlement === null) !== (settledAt === null)
  ) {
    throw corrupt(`receipt ${String(row['receipt_id'])}`);
  }
  const ticket = parseTicketReference(parsed['ticket'] ?? null);
  if (ticket === undefined) {
    throw corrupt(`receipt ${parsed['receiptId']} ticket`);
  }
  return {
    receiptId: parsed['receiptId'],
    ownerId: parsed['ownerId'],
    installationKeyId: parsed['installationKeyId'],
    grantId: parsed['grantId'],
    grantJwsSha256: parsed['grantJwsSha256'],
    lifecycleSequence: parsed['lifecycleSequence'],
    ticket,
    operationId: parsed['operationId'],
    resultId: parsed['resultId'],
    fullOutputSha256: parsed['fullOutputSha256'],
    billingDisposition: 'joint_verification_required',
    queuedAt: parsed['queuedAt'],
    settlement,
    settledAt,
  };
}

/** Hold a server-issued grant for the active signed-in owner. Holding is
 * idempotent per grant id; holding the same grant twice never refills what
 * consumption already spent, and a different grant reusing an id is refused. */
export async function holdOfflineGrant(
  rawDb: LocalDb,
  issued: IssuedOfflineGrant,
  binding: OfflineGrantBindingInput,
): Promise<HeldOfflineGrant> {
  const context = signedInOwner();
  const claims = bindIssuedGrant(issued, binding, context.ownerKey);
  const compactJws = issued.grant.compactJws;
  const grantJwsSha256 = sha256Hex(compactJws);
  const db = forDataOwner(rawDb, context);
  return withTransaction(db, async transaction => {
    const { rows } = await transaction.execute(
      `SELECT * FROM offline_grant WHERE owner_key = ? AND grant_id = ?`,
      [context.ownerKey, issued.grantId],
    );
    const existingRow = rows[0];
    if (existingRow) {
      const existing = parseGrantRow(existingRow);
      if (existing.grantJwsSha256 !== grantJwsSha256) {
        throw invalidGrant('grant_id_reused');
      }
      return heldGrant(existing);
    }
    const ticketIds = [...issued.ticketIds];
    const allocationId =
      claims.entitlementSource === 'identity_lifetime_free'
        ? claims.allocation.allocationId
        : null;
    await transaction.execute(
      `INSERT INTO offline_grant (
        owner_key, grant_id, generation, installation_key_id,
        entitlement_source, key_id, issued_at, expires_at,
        entitlement_expires_at, allocation_id, compact_jws, grant_jws_sha256,
        allocated_ticket_ids, remaining_ticket_ids, lifecycle_sequence, held_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        context.ownerKey,
        issued.grantId,
        issued.generation,
        binding.installationKeyId,
        issued.entitlementSource,
        issued.keyId,
        issued.issuedAt,
        issued.expiresAt,
        issued.entitlementExpiresAt,
        allocationId,
        compactJws,
        grantJwsSha256,
        JSON.stringify(ticketIds),
        JSON.stringify(ticketIds),
        new Date().toISOString(),
      ],
    );
    return {
      grantId: issued.grantId,
      generation: issued.generation,
      entitlementSource: issued.entitlementSource,
      installationKeyId: binding.installationKeyId,
      keyId: issued.keyId,
      issuedAt: issued.issuedAt,
      expiresAt: issued.expiresAt,
      entitlementExpiresAt: issued.entitlementExpiresAt,
      grantJwsSha256,
      allocated: ticketIds.length,
      remaining: ticketIds.length,
      consumed: 0,
      lifecycleSequence: 0,
    };
  });
}

/** Online path: ask the server for a grant and hold it. The issuer is the
 * API base the client talks to, so a grant from anywhere else is refused. */
export async function requestOfflineGrant(
  db: LocalDb,
  client: OfflineGrantClient,
  input: { installationKeyId: string; requestedTickets: 0 | 1 | 2 },
): Promise<HeldOfflineGrant> {
  const issued = await client.issueGrant(input);
  return holdOfflineGrant(db, issued, {
    issuer: client.issuer,
    installationKeyId: input.installationKeyId,
  });
}

/** Every grant the active owner holds, newest generation first, with the
 * execution verdict under the given trusted-time reading. Expired or
 * unreconciled grants keep their remaining count: an execution verdict is not
 * a ledger event. */
export async function readOfflineAllocation(
  rawDb: LocalDb,
  reading: TrustedTimeReading,
): Promise<OfflineAllocationSnapshot> {
  const context = captureDataOwnerContext();
  const db = forDataOwner(rawDb, context);
  const grants = (await loadGrants(db, context.ownerKey)).map(grant =>
    viewGrant(grant, reading),
  );
  const { rows } = await db.execute(
    `SELECT COUNT(*) AS pending FROM offline_receipt
     WHERE owner_key = ? AND settled_at IS NULL`,
    [context.ownerKey],
  );
  const pending = rows[0]?.['pending'];
  if (!isUnixSeconds(pending)) throw corrupt('receipt count');
  return { grants, pendingReceipts: pending };
}

function selectExecutableGrant(
  grants: readonly StoredOfflineGrant[],
  requestedGrantId: string | undefined,
  reading: TrustedTimeReading,
): StoredOfflineGrant {
  const candidates =
    requestedGrantId === undefined
      ? grants
      : grants.filter(grant => grant.grantId === requestedGrantId);
  if (candidates.length === 0) {
    throw new OfflineGrantError(
      'offline.grant_not_held',
      'This device holds no offline grant for the signed-in account. Connect once to request one.',
    );
  }
  let firstBlocked: OfflineGrantError | null = null;
  for (const grant of candidates) {
    const verdict = evaluateLease(
      {
        issuedAtMs: grant.issuedAt * 1000,
        expiresAtMs: grant.expiresAt * 1000,
      },
      reading,
    );
    let blocked: OfflineGrantError | null = null;
    if (verdict.kind === 'expired') {
      blocked = new OfflineGrantError(
        'offline.grant_expired',
        'The offline grant has expired. Its unspent tickets stay allocated until the server reconciles them.',
      );
    } else if (verdict.kind === 'reconcile_required') {
      blocked = new OfflineGrantError(
        'offline.time_reconcile_required',
        `Trusted time is unavailable (${verdict.reason}); connect to reconcile before rating offline.`,
      );
    } else if (
      grant.entitlementSource === 'identity_lifetime_free' &&
      grant.remaining === 0
    ) {
      blocked = new OfflineGrantError(
        'offline.allocation_exhausted',
        'Every ticket of the held offline grant has been spent on this device.',
      );
    }
    if (blocked === null) return grant;
    firstBlocked ??= blocked;
  }
  throw firstBlocked ?? corrupt('grant selection');
}

/** Spend one ticket (or one lease execution) for a durably delivered result
 * and queue its receipt in the same transaction. A repeated operation id
 * returns the original receipt without spending again. */
export async function consumeOfflineAllocation(
  rawDb: LocalDb,
  input: OfflineConsumptionInput,
  reading: TrustedTimeReading,
): Promise<OfflineConsumption> {
  if (
    !isIdentifier(input.operationId) ||
    !isIdentifier(input.resultId) ||
    !SHA256_HEX_PATTERN.test(input.fullOutputSha256) ||
    (input.grantId !== undefined && !isIdentifier(input.grantId))
  ) {
    throw new OfflineGrantError(
      'offline.result_invalid',
      'A consumption needs an operation id, a result id and the full output hash.',
    );
  }
  const context = signedInOwner();
  const owner = context.ownerKey;
  const db = forDataOwner(rawDb, context);
  return withTransaction(db, async transaction => {
    const grants = await loadGrants(transaction, owner);
    const replay = await transaction.execute(
      `SELECT * FROM offline_receipt WHERE owner_key = ? AND operation_id = ?`,
      [owner, input.operationId],
    );
    const replayRow = replay.rows[0];
    if (replayRow) {
      const receipt = parseReceiptRow(replayRow);
      const grant = grants.find(held => held.grantId === receipt.grantId);
      if (!grant) throw corrupt(`receipt ${receipt.receiptId} grant`);
      return { receipt, grant: viewGrant(grant, reading), replayed: true };
    }
    const grant = selectExecutableGrant(grants, input.grantId, reading);
    const ticketId = grant.remainingTicketIds[0] ?? null;
    const remainingTicketIds =
      ticketId === null
        ? grant.remainingTicketIds
        : grant.remainingTicketIds.slice(1);
    const lifecycleSequence = grant.lifecycleSequence + 1;
    const receipt: OfflineConsumptionReceipt = {
      receiptId: makeUuid(),
      ownerId: owner,
      installationKeyId: grant.installationKeyId,
      grantId: grant.grantId,
      grantJwsSha256: grant.grantJwsSha256,
      lifecycleSequence,
      ticket:
        ticketId === null || grant.allocationId === null
          ? null
          : {
              allocationId: grant.allocationId,
              generation: grant.generation,
              ticketId,
            },
      operationId: input.operationId,
      resultId: input.resultId,
      fullOutputSha256: input.fullOutputSha256,
      billingDisposition: 'joint_verification_required',
      queuedAt: new Date(reading.wallClockMs).toISOString(),
      settlement: null,
      settledAt: null,
    };
    const { settlement: _settlement, settledAt: _settledAt, ...body } = receipt;
    const updated = await transaction.execute(
      `UPDATE offline_grant
       SET remaining_ticket_ids = ?, lifecycle_sequence = ?
       WHERE owner_key = ? AND grant_id = ? AND lifecycle_sequence = ?`,
      [
        JSON.stringify(remainingTicketIds),
        lifecycleSequence,
        owner,
        grant.grantId,
        grant.lifecycleSequence,
      ],
    );
    if (updated.rowsAffected !== undefined && updated.rowsAffected !== 1) {
      throw corrupt(`grant ${grant.grantId} sequence`);
    }
    await transaction.execute(
      `INSERT INTO offline_receipt (
        owner_key, receipt_id, grant_id, operation_id, lifecycle_sequence,
        receipt, queued_at, settlement, settled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      [
        owner,
        receipt.receiptId,
        grant.grantId,
        input.operationId,
        lifecycleSequence,
        JSON.stringify(body),
        receipt.queuedAt,
      ],
    );
    return {
      receipt,
      grant: viewGrant(
        {
          ...grant,
          remaining: remainingTicketIds.length,
          consumed: grant.allocated - remainingTicketIds.length,
          lifecycleSequence,
          remainingTicketIds,
        },
        reading,
      ),
      replayed: false,
    };
  });
}

/** Receipts the server has not yet settled, oldest first. They survive
 * disconnects, restarts and lease expiry until `settleOfflineReceipt`. */
export async function pendingOfflineReceipts(
  rawDb: LocalDb,
): Promise<OfflineConsumptionReceipt[]> {
  const context = captureDataOwnerContext();
  const db = forDataOwner(rawDb, context);
  const { rows } = await db.execute(
    `SELECT * FROM offline_receipt
     WHERE owner_key = ? AND settled_at IS NULL
     ORDER BY queued_at ASC, grant_id ASC, lifecycle_sequence ASC`,
    [context.ownerKey],
  );
  return rows.map(parseReceiptRow);
}

/** Record the server's explicit verdict on a queued receipt. This is the only
 * path that changes what the device reports as pending; the receipt row stays
 * as history and the grant's remaining count is untouched. */
export async function settleOfflineReceipt(
  rawDb: LocalDb,
  receiptId: string,
  settlement: OfflineReceiptSettlement,
  reading: TrustedTimeReading,
): Promise<OfflineConsumptionReceipt> {
  const context = captureDataOwnerContext();
  const db = forDataOwner(rawDb, context);
  return withTransaction(db, async transaction => {
    const { rows } = await transaction.execute(
      `SELECT * FROM offline_receipt WHERE owner_key = ? AND receipt_id = ?`,
      [context.ownerKey, receiptId],
    );
    const row = rows[0];
    if (!row) {
      throw new OfflineGrantError(
        'offline.receipt_unknown',
        'No queued offline receipt matches that id for this account.',
      );
    }
    const receipt = parseReceiptRow(row);
    if (receipt.settledAt !== null) {
      throw new OfflineGrantError(
        'offline.receipt_settled',
        `Receipt ${receiptId} was already settled as ${String(receipt.settlement)}.`,
      );
    }
    const settledAt = new Date(reading.wallClockMs).toISOString();
    await transaction.execute(
      `UPDATE offline_receipt SET settlement = ?, settled_at = ?
       WHERE owner_key = ? AND receipt_id = ? AND settled_at IS NULL`,
      [settlement, settledAt, context.ownerKey, receiptId],
    );
    return { ...receipt, settlement, settledAt };
  });
}
