import { OUTBOX_MAX_ATTEMPTS, isSessionOrphanedVerdict } from './sync';

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
 * rows at the cap failed permanently and need attention. A PARKED shot
 * (`shot.session_orphaned:` verdict) is neither: it waits for its practice
 * set to be accepted and is offered again then, whatever its attempt count,
 * so it counts as pending.
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
    row =>
      row.attempts >= OUTBOX_MAX_ATTEMPTS &&
      !isSessionOrphanedVerdict(row.lastError),
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
