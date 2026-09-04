import type { ShotAnalysis } from '@pickle/shared-types';
import {
  canonicalDataOwner,
  GUEST_DATA_OWNER,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';
import { API_REQUEST_TIMEOUT_MS, createTransport } from '../../src/data/api';
import {
  deriveUploadQueueStatus,
  type OutboxRowStatus,
} from '../../src/data/offlineCapabilities';
import {
  finishSession,
  getShotOutboxStatus,
  hasShotSyncReceipt,
  purgeOwnerData,
  saveAnalysis,
  saveLocalOnlyAnalysis,
  saveSession,
} from '../../src/data/repository';
import {
  drainOutbox,
  OUTBOX_MAX_ATTEMPTS,
  type SyncTransport,
} from '../../src/data/sync';
import { enqueueEvaluationTrial } from '../../src/evaluation/trialCapture';
import type { EvaluationTrialRecord } from '@pickle/shared-types';
import {
  canonicalSnapshot,
  type DurableSnapshot,
  type HarnessDb,
  type OutboxRowSnapshot,
} from './durableStore';
import {
  FAULT_MESSAGES,
  withFaults,
  type FaultPlan,
  type FaultTarget,
} from './faults';
import { heapUsed, nowMs } from './nodeEnv';
import {
  healthyProfile,
  isPermanentOutcome,
  NETWORK_PROFILES,
  NetworkOracle,
  type NetworkProfile,
  type RequestLogEntry,
  type RequestOutcome,
  type ShotFate,
} from './oracle';
import { deriveSequenceSeed, Rng } from './prng';

/**
 * Seeded randomized state machine over the REAL repository + sync engine.
 *
 * Every step applies one operation through the production code paths
 * (saveAnalysis, saveSession, finishSession, enqueueEvaluationTrial,
 * purgeOwnerData, drainOutbox via createTransport + a fetch oracle) against a
 * durable store, then checks the outbox invariants against the model's
 * knowledge of what was committed and what the server actually stored.
 */

export type OwnerRole = 'guest' | 'userA' | 'userB' | 'signedOut';

export const OWNER_KEYS: Record<OwnerRole, string> = {
  guest: GUEST_DATA_OWNER,
  userA: canonicalDataOwner('0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a'),
  userB: canonicalDataOwner('0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b'),
  signedOut: SIGNED_OUT_DATA_OWNER,
};

const BEARERS: Record<OwnerRole, string | null> = {
  guest: null,
  userA: 'bearer-userA',
  userB: 'bearer-userB',
  signedOut: null,
};

export type Operation =
  | { op: 'save_shot'; shotId: string; permitId: string; fate: ShotFate }
  | {
      op: 'save_shot_in_set';
      shotId: string;
      permitId: string;
      sessionId: string;
      order: 'session_first' | 'shot_first' | 'orphan';
      newSet: boolean;
      fate: ShotFate;
    }
  | { op: 'save_shot_duplicate'; shotId: string }
  | { op: 'save_abstention'; shotId: string }
  | { op: 'start_set'; sessionId: string }
  | { op: 'finish_session'; sessionId: string; known: boolean }
  | {
      op: 'enqueue_trial';
      trialId: string;
      fate: 'accept' | 'permanent' | 'transient';
    }
  | {
      op: 'drain';
      profile: string;
      fault: FaultPlan | null;
      midFlight: MidFlightEvent | null;
      trialsSupported: boolean;
      forced: RequestOutcome | null;
    }
  | { op: 'drain_concurrent'; profile: string }
  | { op: 'switch_owner'; to: OwnerRole }
  | { op: 'write_signed_out'; what: 'shot' | 'session' | 'finish' | 'trial' }
  | { op: 'purge_owner'; role: OwnerRole }
  | {
      op: 'corrupt_row';
      rowId: number;
      how: 'garbage' | 'no_permit' | 'no_id' | 'wrong_kind';
    }
  | { op: 'healthy_convergence'; maxDrains: number };

export type MidFlightEvent =
  | { kind: 'switch_owner'; to: OwnerRole }
  | { kind: 'purge_owner'; role: OwnerRole }
  | { kind: 'save_shot'; shotId: string; permitId: string };

export interface Violation {
  invariant: string;
  step: number;
  detail: string;
}

export interface Observation {
  kind: string;
  step: number;
  detail: string;
}

export interface StepRecord {
  step: number;
  owner: OwnerRole;
  operation: Operation;
  result: string;
  requests: RequestLogEntry[];
}

export interface SequenceMetrics {
  steps: number;
  drains: number;
  requests: number;
  shotsSaved: number;
  abstentions: number;
  sessionsStarted: number;
  trialsQueued: number;
  faultsFired: number;
  receipts: number;
  serverStoredShots: number;
  idempotentReplays: number;
  resendAfterReceipt: number;
  orphanShotsStuck: number;
  statusThrowsOnCorruptRow: number;
  concurrentDoubleAttempts: number;
  exhaustedRows: number;
  maxOutboxDepth: number;
  statements: number;
  outcomeMatrix: Record<string, number>;
  opMatrix: Record<string, number>;
}

export interface SequenceResult {
  seed: number;
  index: number;
  sequenceSeed: number;
  backend: string;
  ok: boolean;
  violations: Violation[];
  observations: Observation[];
  metrics: SequenceMetrics;
  trace: StepRecord[];
  finalSnapshot: DurableSnapshot;
  heapUsedBefore: number;
  heapUsedAfter: number;
  durationMs: number;
}

export interface Clock {
  /** Advance fake time so a hung request reaches the client-side timeout. */
  advance(ms: number): Promise<void>;
}

export interface SequenceOptions {
  seed: number;
  index: number;
  createDb: () => HarnessDb;
  clock: Clock;
  /** Steps per sequence; drawn from [minSteps, maxSteps] when absent. */
  steps?: number;
  minSteps?: number;
  maxSteps?: number;
  keepTrace?: boolean;
}

interface ShotModel {
  id: string;
  role: OwnerRole;
  sessionId: string | null;
  scored: boolean;
  fate: ShotFate;
  rowIds: number[];
}

interface SessionModel {
  id: string;
  role: OwnerRole;
}

const SHOT_TYPES = [
  'forehand_drive',
  'backhand_drive',
  'dink',
  'third_shot_drop',
  'serve',
  'volley',
] as const;

function isoAt(rng: Rng): string {
  return new Date(
    1_790_000_000_000 + rng.int(0, 10_000_000) * 1000,
  ).toISOString();
}

function baseAnalysis(
  rng: Rng,
  id: string,
  sessionId: string | null,
  scored: boolean,
): ShotAnalysis {
  return {
    id,
    sessionId,
    shotType: rng.pick(SHOT_TYPES),
    cameraView: 'side',
    handedness: rng.chance(0.85) ? 'right' : 'left',
    capturedAtIso: isoAt(rng),
    timestamps: { startMs: 0, contactMs: 1000 + rng.int(0, 400), endMs: 2000 },
    phases: [],
    measurements: [],
    checkpoints: [],
    overallScore: scored ? Math.round(rng.next() * 100) / 10 : null,
    analysisConfidence: scored ? 0.6 + rng.next() * 0.4 : rng.next() * 0.5,
    resultKind: scored ? 'scored' : 'low_confidence',
    guidance: null,
    priorityFix: null,
    versionVector: {
      appVersion: '1.0.0',
      modelBundleVersion: 'harness-1',
      poseModelVersion: 'harness-pose-1',
      paddleModelVersion: 'harness-paddle-1',
      strokeDetectorVersion: 'harness-stroke-1',
      phaseModelVersion: 'harness-phase-1',
      scoringModelVersion: 'sm-v1',
      shotConfigVersion: 'forehand_drive@1',
    },
    source: 'real',
  } as unknown as ShotAnalysis;
}

function trialRecord(trialId: string): EvaluationTrialRecord {
  return {
    schemaVersion: 'evaluation-trial-v1',
    trialId,
    captureId: `capture-${trialId.slice(0, 8)}`,
    analysisId: null,
    capturedAtIso: '2026-09-01T00:00:00.000Z',
    recordedAtIso: '2026-09-01T00:00:01.000Z',
    outcomeKind: 'unavailable',
    outcomeReason: 'harness',
    envelopeOverall: null,
    latencyMs: 10,
    appVersion: '1.0.0',
    engineVersion: null,
    modelBundleVersion: null,
    declaredStroke: null,
    claims: {
      targetLock: { status: 'not_measured' },
      eventSelection: { status: 'abstained', startMs: null, endMs: null },
      strokeLabel: { status: 'abstained', label: null, confidence: null },
      contactMarker: {
        status: 'not_measured',
        estimatedContactMs: null,
        ballConfirmed: false,
        paddleConfirmed: false,
      },
      phaseRender: { status: 'abstained', contactMs: null },
    },
    limitingFactors: [],
    userFlags: [],
    dims: { cohort: 'harness', device: 'harness', appVersion: '1.0.0' },
    consent: { scope: 'evaluation_telemetry', consentVersion: 'harness' },
  } as unknown as EvaluationTrialRecord;
}

function drawFate(rng: Rng): ShotFate {
  return rng.weighted<ShotFate>([
    [{ kind: 'accept' }, 70],
    [{ kind: 'reject_permanent', code: 'access.permit_expired' }, 8],
    [{ kind: 'reject_permanent', code: 'shot.id_conflict' }, 3],
    [
      {
        kind: 'reject_transient_then_accept',
        code: 'shot.write_failed',
        times: rng.int(1, 3),
      },
      12,
    ],
    [{ kind: 'unacknowledged_then_accept', times: rng.int(1, 2) }, 7],
  ]);
}

const TRANSIENT_CODES = [
  'shot.write_failed',
  'evaluation.trial_write_failed',
  'auth.required',
  'shot.session_not_found',
];

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function payloadShotId(row: OutboxRowSnapshot): string | null {
  if (row.kind !== 'shot.sync') return null;
  try {
    const parsed = JSON.parse(row.payload) as { id?: unknown };
    return typeof parsed.id === 'string' ? parsed.id : null;
  } catch {
    return null;
  }
}

function eligibleWindow(
  snapshot: DurableSnapshot,
  owner: string,
): OutboxRowSnapshot[] {
  return snapshot.outbox
    .filter(r => r.owner_key === owner && r.attempts < OUTBOX_MAX_ATTEMPTS)
    .sort((x, y) => x.id - y.id)
    .slice(0, 50);
}

function rowsToStatuses(rows: OutboxRowSnapshot[]): OutboxRowStatus[] {
  return rows.map(r => ({
    kind: r.kind,
    attempts: r.attempts,
    lastError: r.last_error,
  }));
}

export async function runSequence(
  options: SequenceOptions,
): Promise<SequenceResult> {
  const started = nowMs();
  const sequenceSeed = deriveSequenceSeed(options.seed, options.index);
  const rng = new Rng(sequenceSeed);
  const oracleRng = new Rng(sequenceSeed ^ 0x0ac1e);
  const steps =
    options.steps ?? rng.int(options.minSteps ?? 20, options.maxSteps ?? 60);
  const heapUsedBefore = heapUsed();

  const store = options.createDb();
  const injector = withFaults(store.db);
  const db = injector.db;
  const oracle = new NetworkOracle(oracleRng, rng.pick(NETWORK_PROFILES));

  const violations: Violation[] = [];
  const observations: Observation[] = [];
  const trace: StepRecord[] = [];
  const shots = new Map<string, ShotModel>();
  const sessions = new Map<string, SessionModel>();
  const trials = new Map<string, OwnerRole>();
  const sessionQueued = new Set<string>();
  const purgedRoles = new Set<OwnerRole>();
  let role: OwnerRole = rng.weighted<OwnerRole>([
    ['userA', 45],
    ['userB', 35],
    ['guest', 20],
  ]);
  setActiveDataOwner(OWNER_KEYS[role]);
  let maxOutboxIdSeen = 0;
  const knownOutboxIds = new Set<number>();
  let maxOutboxDepth = 0;
  let duplicateSaves = 0;
  let concurrentDrains = 0;
  let drains = 0;
  let faultsFired = 0;
  let resendAfterReceipt = 0;
  let orphanShotsStuck = 0;
  let statusThrowsOnCorruptRow = 0;
  let concurrentDoubleAttempts = 0;
  const opMatrix: Record<string, number> = {};

  // Mirrors syncRuntime.ts: the transport is bound to ONE account and resolves
  // its bearer per request through the bearerTokenFor() rule — once another
  // owner is current the getter yields null, so an in-flight drain can never
  // upload the previous owner's rows under the new bearer.
  const transportFor = (
    bound: OwnerRole,
    trialsSupported: boolean,
  ): SyncTransport => {
    const full = createTransport({
      baseUrl: 'https://harness.invalid',
      get token() {
        return role === bound ? BEARERS[bound] : null;
      },
    });
    if (trialsSupported) return full;
    return {
      syncShots: shots => full.syncShots(shots),
      createSession: session => full.createSession(session),
      finalizeSession: id => full.finalizeSession(id),
    };
  };

  const switchOwner = (to: OwnerRole) => {
    role = to;
    setActiveDataOwner(OWNER_KEYS[to]);
  };

  const violate = (step: number, invariant: string, detail: string) => {
    violations.push({ invariant, step, detail });
  };
  const observe = (step: number, kind: string, detail: string) => {
    observations.push({ kind, step, detail });
  };

  const rolesWithData = (): OwnerRole[] =>
    (['guest', 'userA', 'userB'] as OwnerRole[]).filter(r =>
      [...shots.values()].some(s => s.role === r),
    );

  const receiptsAtRequest = (owner: string, ids: string[]) => {
    const snap = store.snapshot();
    for (const id of ids) {
      const has = snap.receipts.some(
        r =>
          r.owner_key === owner && r.kind === 'shot.sync' && r.entity_id === id,
      );
      if (has) resendAfterReceipt += 1;
    }
  };

  const shotsOfRole = (r: OwnerRole) =>
    [...shots.values()].filter(s => s.role === r && s.scored);
  const sessionsOfRole = (r: OwnerRole) =>
    [...sessions.values()].filter(s => s.role === r);

  // ── invariant checks on a snapshot ────────────────────────────────────
  const checkStructural = (step: number, snapshot: DurableSnapshot) => {
    const ids = snapshot.outbox.map(r => r.id);
    for (let i = 1; i < ids.length; i++) {
      const prev = ids[i - 1];
      const cur = ids[i];
      if (prev !== undefined && cur !== undefined && cur <= prev) {
        violate(
          step,
          'I-MONOTONE-IDS',
          `outbox ids not strictly increasing: ${prev} then ${cur}`,
        );
      }
    }
    const maxId = ids.length ? Math.max(...ids) : 0;
    if (snapshot.outboxSequence < maxOutboxIdSeen) {
      violate(
        step,
        'I-MONOTONE-IDS',
        `sequence ${snapshot.outboxSequence} fell below max seen ${maxOutboxIdSeen}`,
      );
    }
    for (const id of ids) {
      if (knownOutboxIds.has(id)) continue;
      if (id <= maxOutboxIdSeen) {
        violate(
          step,
          'I-MONOTONE-IDS',
          `new outbox row id ${id} is not above the historical max ${maxOutboxIdSeen} (id reuse)`,
        );
      }
      knownOutboxIds.add(id);
    }
    maxOutboxIdSeen = Math.max(maxOutboxIdSeen, maxId, snapshot.outboxSequence);
    maxOutboxDepth = Math.max(maxOutboxDepth, snapshot.outbox.length);

    for (const row of snapshot.outbox) {
      if (row.attempts > OUTBOX_MAX_ATTEMPTS) {
        if (concurrentDrains > 0 && row.attempts <= OUTBOX_MAX_ATTEMPTS + 1) {
          observe(
            step,
            'O-CAP-OVERSHOOT-CONCURRENT',
            `row ${row.id} attempts ${row.attempts} > ${OUTBOX_MAX_ATTEMPTS} after overlapping drains (still excluded by attempts >= cap)`,
          );
        } else {
          violate(
            step,
            'I-ATTEMPT-CAP',
            `row ${row.id} attempts ${row.attempts} > ${OUTBOX_MAX_ATTEMPTS}`,
          );
        }
      }
      if (row.attempts < 0)
        violate(step, 'I-ATTEMPT-CAP', `row ${row.id} negative attempts`);
      if (!Object.values(OWNER_KEYS).includes(row.owner_key)) {
        violate(
          step,
          'I-OWNER',
          `row ${row.id} has unknown owner ${row.owner_key}`,
        );
      }
    }

    // No loss: every committed scored shot is locally present and either
    // receipted or still queued — unless its owner was purged.
    for (const shot of shots.values()) {
      const owner = OWNER_KEYS[shot.role];
      const localRow = snapshot.shots.find(
        s => s.owner_key === owner && s.id === shot.id,
      );
      const receipt = snapshot.receipts.some(
        r =>
          r.owner_key === owner &&
          r.kind === 'shot.sync' &&
          r.entity_id === shot.id,
      );
      const queued = snapshot.outbox.some(
        r =>
          r.owner_key === owner &&
          r.kind === 'shot.sync' &&
          payloadShotId(r) === shot.id,
      );

      if (!localRow)
        violate(
          step,
          'I-NO-LOSS',
          `local_shot missing for ${shot.id} (${shot.role})`,
        );
      if (shot.scored && !receipt && !queued) {
        violate(
          step,
          'I-NO-LOSS',
          `scored shot ${shot.id} (${shot.role}) neither receipted nor queued`,
        );
      }
      if (!shot.scored && queued) {
        violate(
          step,
          'I-ABSTENTION-NEVER-QUEUED',
          `abstention ${shot.id} found in outbox`,
        );
      }
      if (!shot.scored && receipt) {
        violate(
          step,
          'I-ABSTENTION-NEVER-QUEUED',
          `abstention ${shot.id} has a receipt`,
        );
      }
    }

    // Receipt truth: a receipt exists only for a shot the server stored for
    // that bearer. A fabricated receipt would silently drop a rating.
    for (const receipt of snapshot.receipts) {
      const roleOf = (Object.keys(OWNER_KEYS) as OwnerRole[]).find(
        r => OWNER_KEYS[r] === receipt.owner_key,
      );
      const bearer = roleOf ? BEARERS[roleOf] : null;
      if (!bearer || !oracle.hasStoredShot(bearer, receipt.entity_id)) {
        violate(
          step,
          'I-RECEIPT-TRUTH',
          `receipt for ${receipt.entity_id} (${receipt.owner_key}) without server acceptance`,
        );
      }
    }

    // No duplicate accepted shots server-side (idempotent store holds one
    // record per id; acceptCount > 1 is a replay, tallied separately).
    const seen = new Set<string>();
    for (const [bearer, id] of oracle.storedShots()) {
      const key = `${bearer}|${id}`;
      if (seen.has(key))
        violate(
          step,
          'I-NO-DUP-ACCEPT',
          `server stores ${id} twice for ${bearer}`,
        );
      seen.add(key);
    }
  };

  const checkDerivedStatus = async (
    step: number,
    snapshot: DurableSnapshot,
  ) => {
    const owner = OWNER_KEYS[role];
    const rows = snapshot.outbox.filter(r => r.owner_key === owner);
    const derived = deriveUploadQueueStatus(rowsToStatuses(rows));
    const exhausted = rows.filter(
      r => r.attempts >= OUTBOX_MAX_ATTEMPTS,
    ).length;
    const expected =
      rows.length === 0 ? 'idle' : exhausted > 0 ? 'needs_attention' : 'queued';
    if (derived.state !== expected) {
      violate(
        step,
        'I-QUEUE-STATUS',
        `deriveUploadQueueStatus=${derived.state} expected ${expected}`,
      );
    }
    if (
      derived.state === 'needs_attention' &&
      (derived.exhausted !== exhausted ||
        derived.pending !== rows.length - exhausted)
    ) {
      violate(
        step,
        'I-QUEUE-STATUS',
        `needs_attention counts ${JSON.stringify(derived)} vs exhausted=${exhausted} rows=${rows.length}`,
      );
    }
    if (derived.state === 'queued' && derived.pending !== rows.length) {
      violate(
        step,
        'I-QUEUE-STATUS',
        `queued pending=${derived.pending} vs rows=${rows.length}`,
      );
    }
    if (role === 'signedOut') return;
    const garbageRows = rows.filter(
      r => r.kind === 'shot.sync' && !isJson(r.payload),
    );
    for (const shot of shotsOfRole(role).slice(-6)) {
      let status: Awaited<ReturnType<typeof getShotOutboxStatus>>;
      try {
        status = await getShotOutboxStatus(db, shot.id);
      } catch (error) {
        if (garbageRows.length > 0) {
          statusThrowsOnCorruptRow += 1;
          observe(
            step,
            'O-STATUS-THROWS-ON-CORRUPT-ROW',
            `getShotOutboxStatus(${shot.id}) threw "${String(error)}" because outbox row(s) ${garbageRows.map(r => `${r.id}(attempts=${r.attempts})`).join(',')} hold non-JSON payloads; json_extract fails the whole query for every shot of owner ${owner}`,
          );
          continue;
        }
        violate(
          step,
          'I-SHOT-STATUS',
          `getShotOutboxStatus(${shot.id}) threw ${String(error)}`,
        );
        continue;
      }
      const matching = rows
        .filter(r => r.kind === 'shot.sync' && payloadShotId(r) === shot.id)
        .sort((x, y) => y.id - x.id);
      const top = matching[0];
      const expectedState = !top
        ? 'absent'
        : top.attempts >= OUTBOX_MAX_ATTEMPTS
          ? 'exhausted'
          : top.attempts > 0
            ? 'rejected'
            : 'queued';
      if (status.state !== expectedState) {
        violate(
          step,
          'I-SHOT-STATUS',
          `getShotOutboxStatus(${shot.id})=${status.state} expected ${expectedState}`,
        );
      }
      const receipt = await hasShotSyncReceipt(db, shot.id);
      const expectReceipt = snapshot.receipts.some(
        r => r.owner_key === owner && r.entity_id === shot.id,
      );
      if (receipt !== expectReceipt) {
        violate(
          step,
          'I-SHOT-STATUS',
          `hasShotSyncReceipt(${shot.id})=${receipt} expected ${expectReceipt}`,
        );
      }
    }
  };

  /** Strict per-row expectation for an uninterrupted drain. */
  const checkDrainEffects = (
    step: number,
    before: DurableSnapshot,
    after: DurableSnapshot,
    owner: string,
    bearer: string | null,
    requests: RequestLogEntry[],
    trialsSupported: boolean,
    result: { synced: number; failed: number; remaining: number },
  ) => {
    const window = eligibleWindow(before, owner);
    const expectations = new Map<
      number,
      { deleted: boolean; delta: number; receipt: string | null }
    >();
    let cursor = 0;
    const nextRequest = (path: RegExp): RequestLogEntry | null => {
      const entry = requests[cursor];
      if (!entry) return null;
      if (!path.test(entry.path)) return null;
      cursor += 1;
      return entry;
    };
    const parse = (payload: string): Record<string, unknown> | null => {
      try {
        const v = JSON.parse(payload) as unknown;
        return typeof v === 'object' && v !== null
          ? (v as Record<string, unknown>)
          : null;
      } catch {
        return null;
      }
    };

    // Sessions first (one request per row), in id order.
    for (const row of window.filter(
      r => r.kind !== 'shot.sync' && r.kind !== 'evaluation.trial',
    )) {
      const parsed = parse(row.payload);
      if (
        !parsed ||
        (row.kind !== 'session.create' && row.kind !== 'session.finalize')
      ) {
        expectations.set(row.id, { deleted: false, delta: 1, receipt: null });
        continue;
      }
      const entry = nextRequest(/^\/v1\/sessions/);
      if (!entry) {
        violate(
          step,
          'I-DRAIN-EFFECT',
          `no request logged for session row ${row.id}`,
        );
        continue;
      }
      if (
        entry.outcome === 'ok' ||
        entry.outcome === 'malformed_body' ||
        entry.outcome === 'wrong_shape'
      ) {
        if (entry.status === 200 || (bearer === null && entry.status === 401)) {
          expectations.set(row.id, {
            deleted: entry.status === 200,
            delta: 0,
            receipt: null,
          });
        } else {
          expectations.set(row.id, {
            deleted: false,
            delta:
              entry.status >= 400 &&
              entry.status < 500 &&
              ![401, 408, 429].includes(entry.status)
                ? 1
                : 0,
            receipt: null,
          });
        }
      } else {
        expectations.set(row.id, {
          deleted: false,
          delta: isPermanentOutcome(entry.outcome) ? 1 : 0,
          receipt: null,
        });
      }
    }

    // Shots: one request for every parseable row.
    const shotRows = window.filter(r => r.kind === 'shot.sync');
    const sendable = shotRows.filter(r => {
      const parsed = parse(r.payload);
      return (
        parsed !== null &&
        typeof parsed['analysisPermitId'] === 'string' &&
        (parsed['analysisPermitId'] as string).trim() !== ''
      );
    });
    for (const row of shotRows) {
      if (!sendable.includes(row))
        expectations.set(row.id, { deleted: false, delta: 1, receipt: null });
    }
    if (sendable.length > 0) {
      const entry = nextRequest(/^\/v1\/shots:sync$/);
      if (!entry) {
        violate(
          step,
          'I-DRAIN-EFFECT',
          `no shots request logged for ${sendable.length} rows`,
        );
      } else {
        const sentIds = sendable.map(r => payloadShotId(r) ?? '');
        if (JSON.stringify(sentIds) !== JSON.stringify(entry.shotIds)) {
          violate(
            step,
            'I-DRAIN-EFFECT',
            `sent ids ${JSON.stringify(entry.shotIds)} != window ${JSON.stringify(sentIds)}`,
          );
        }
        if (sentIds.includes('')) {
          observe(
            step,
            'O-IDLESS-ROW-SENT',
            `drainOutbox shipped ${sentIds.filter(id => id === '').length} shot.sync row(s) whose payload has no id; the server cannot acknowledge them so they burn one permanent attempt per drain`,
          );
        }
        const clientSawResponse =
          entry.outcome === 'ok' && entry.status === 200;
        for (const row of sendable) {
          const shotId = payloadShotId(row) ?? '';
          if (!clientSawResponse) {
            const permanent =
              entry.outcome === 'ok'
                ? entry.status >= 400 &&
                  entry.status < 500 &&
                  ![401, 408, 429].includes(entry.status)
                : isPermanentOutcome(entry.outcome);
            expectations.set(row.id, {
              deleted: false,
              delta: permanent ? 1 : 0,
              receipt: null,
            });
            continue;
          }
          if (entry.acceptedIds.includes(shotId)) {
            expectations.set(row.id, {
              deleted: true,
              delta: 0,
              receipt: shotId,
            });
            continue;
          }
          const rejection = entry.rejected.find(r => r.id === shotId);
          const transient =
            rejection !== undefined && TRANSIENT_CODES.includes(rejection.code);
          expectations.set(row.id, {
            deleted: false,
            delta: transient ? 0 : 1,
            receipt: null,
          });
        }
      }
    }

    // Trials: one request when the transport supports them.
    const trialRows = window.filter(r => r.kind === 'evaluation.trial');
    if (trialRows.length > 0 && trialsSupported) {
      const sendableTrials = trialRows.filter(r => {
        const parsed = parse(r.payload);
        return parsed !== null && typeof parsed['trialId'] === 'string';
      });
      for (const row of trialRows) {
        if (!sendableTrials.includes(row))
          expectations.set(row.id, { deleted: false, delta: 1, receipt: null });
      }
      if (sendableTrials.length > 0) {
        const entry = nextRequest(/^\/v1\/me\/evaluation\/trials$/);
        if (!entry) {
          violate(
            step,
            'I-DRAIN-EFFECT',
            `no trials request logged for ${sendableTrials.length} rows`,
          );
        } else {
          const clientSawResponse =
            entry.outcome === 'ok' && entry.status === 200;
          for (const row of sendableTrials) {
            const trialId = String(parse(row.payload)?.['trialId']);
            if (!clientSawResponse) {
              const permanent =
                entry.outcome === 'ok'
                  ? entry.status >= 400 &&
                    entry.status < 500 &&
                    ![401, 408, 429].includes(entry.status)
                  : isPermanentOutcome(entry.outcome);
              expectations.set(row.id, {
                deleted: false,
                delta: permanent ? 1 : 0,
                receipt: null,
              });
              continue;
            }
            if (entry.acceptedIds.includes(trialId)) {
              expectations.set(row.id, {
                deleted: true,
                delta: 0,
                receipt: null,
              });
              continue;
            }
            const rejection = entry.rejected.find(r => r.id === trialId);
            const transient =
              rejection !== undefined &&
              TRANSIENT_CODES.includes(rejection.code);
            expectations.set(row.id, {
              deleted: false,
              delta: transient ? 0 : 1,
              receipt: null,
            });
          }
        }
      }
    }

    if (cursor !== requests.length) {
      violate(
        step,
        'I-DRAIN-EFFECT',
        `${requests.length - cursor} unexplained requests in drain`,
      );
    }

    let deletedCount = 0;
    for (const row of window) {
      const expectation = expectations.get(row.id);
      const afterRow = after.outbox.find(r => r.id === row.id);
      if (!expectation) {
        if (!afterRow) deletedCount += 1;
        continue;
      }
      if (expectation.deleted) {
        deletedCount += 1;
        if (afterRow)
          violate(
            step,
            'I-DRAIN-EFFECT',
            `row ${row.id} (${row.kind}) should have been deleted`,
          );
        if (expectation.receipt) {
          const receipt = after.receipts.some(
            r => r.owner_key === owner && r.entity_id === expectation.receipt,
          );
          if (!receipt)
            violate(
              step,
              'I-DRAIN-EFFECT',
              `accepted shot ${expectation.receipt} has no receipt`,
            );
        }
        continue;
      }
      if (!afterRow) {
        violate(
          step,
          'I-NO-LOSS',
          `row ${row.id} (${row.kind}) vanished without acceptance`,
        );
        continue;
      }
      if (afterRow.attempts !== row.attempts + expectation.delta) {
        violate(
          step,
          'I-ATTEMPT-ACCOUNTING',
          `row ${row.id} (${row.kind}) attempts ${row.attempts}->${afterRow.attempts}, expected +${expectation.delta}`,
        );
      }
      if (afterRow.last_error === null) {
        violate(
          step,
          'I-ATTEMPT-ACCOUNTING',
          `row ${row.id} (${row.kind}) failed but last_error is null`,
        );
      }
    }
    // Trial rows are untouched when the transport cannot upload them.
    if (!trialsSupported) {
      for (const row of trialRows) {
        const afterRow = after.outbox.find(r => r.id === row.id);
        if (
          !afterRow ||
          afterRow.attempts !== row.attempts ||
          afterRow.last_error !== row.last_error
        ) {
          violate(
            step,
            'I-DRAIN-SCOPE',
            `trial row ${row.id} was modified by a transport without uploadEvaluationTrials`,
          );
        }
      }
    }
    // Rows outside the window must be untouched.
    for (const row of before.outbox) {
      if (window.includes(row)) continue;
      const afterRow = after.outbox.find(r => r.id === row.id);
      if (
        !afterRow ||
        afterRow.attempts !== row.attempts ||
        afterRow.last_error !== row.last_error
      ) {
        violate(
          step,
          'I-DRAIN-SCOPE',
          `row ${row.id} (${row.owner_key}, attempts ${row.attempts}) outside the drain window was modified`,
        );
      }
    }
    const remaining = after.outbox.filter(r => r.owner_key === owner).length;
    if (result.remaining !== remaining) {
      violate(
        step,
        'I-DRAIN-REPORT',
        `drain reported remaining=${result.remaining}, store has ${remaining}`,
      );
    }
    if (result.synced !== deletedCount) {
      violate(
        step,
        'I-DRAIN-REPORT',
        `drain reported synced=${result.synced}, ${deletedCount} rows were removed`,
      );
    }
  };

  /** Relaxed check when a fault / interleaving makes strict accounting moot. */
  const checkDrainSafety = (
    step: number,
    before: DurableSnapshot,
    after: DurableSnapshot,
    overlappingDrains = 1,
  ) => {
    for (const row of before.outbox) {
      const afterRow = after.outbox.find(r => r.id === row.id);
      if (afterRow) {
        const jump = afterRow.attempts - row.attempts;
        if (jump < 0)
          violate(
            step,
            'I-ATTEMPT-ACCOUNTING',
            `row ${row.id} attempts decreased`,
          );
        if (jump > overlappingDrains)
          violate(
            step,
            'I-ATTEMPT-ACCOUNTING',
            `row ${row.id} attempts jumped by ${jump}`,
          );
        else if (jump > 1) {
          concurrentDoubleAttempts += 1;
          observe(
            step,
            'O-CONCURRENT-DOUBLE-ATTEMPT',
            `row ${row.id} (${row.kind}) attempts ${row.attempts}->${afterRow.attempts}: ${overlappingDrains} overlapping drains each charged the retry budget for one permanent failure`,
          );
        }
        continue;
      }
      if (row.kind !== 'shot.sync') continue;
      const shotId = payloadShotId(row);
      const roleOf = (Object.keys(OWNER_KEYS) as OwnerRole[]).find(
        r => OWNER_KEYS[r] === row.owner_key,
      );
      if (roleOf && purgedRoles.has(roleOf)) continue;
      const receipt =
        shotId !== null &&
        after.receipts.some(
          r => r.owner_key === row.owner_key && r.entity_id === shotId,
        );
      if (!receipt)
        violate(
          step,
          'I-NO-LOSS',
          `shot row ${row.id} (${shotId}) deleted without a receipt`,
        );
    }
  };

  const runDrain = async (
    transport: SyncTransport,
  ): Promise<{
    result: { synced: number; failed: number; remaining: number } | null;
    error: unknown;
    requests: RequestLogEntry[];
  }> => {
    const logStart = oracle.log.length;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = oracle.fetch as typeof fetch;
    let settled = false;
    let result: { synced: number; failed: number; remaining: number } | null =
      null;
    let error: unknown = null;
    const pending = drainOutbox(db, transport).then(
      r => {
        result = r;
        settled = true;
      },
      e => {
        error = e;
        settled = true;
      },
    );
    try {
      let guard = 0;
      while (!settled) {
        await options.clock.advance(API_REQUEST_TIMEOUT_MS + 1);
        guard += 1;
        if (guard > 200)
          throw new Error('drain did not settle after 200 clock advances');
      }
      await pending;
    } finally {
      globalThis.fetch = originalFetch;
    }
    drains += 1;
    return { result, error, requests: oracle.log.slice(logStart) };
  };

  const record = (
    step: number,
    operation: Operation,
    result: string,
    requests: RequestLogEntry[] = [],
  ) => {
    opMatrix[operation.op] = (opMatrix[operation.op] ?? 0) + 1;
    if (options.keepTrace !== false)
      trace.push({ step, owner: role, operation, result, requests });
  };

  const snapshotUnchanged = (a: DurableSnapshot, b: DurableSnapshot) =>
    JSON.stringify(canonicalSnapshot(a)) ===
    JSON.stringify(canonicalSnapshot(b));

  // ── operation generator ────────────────────────────────────────────────
  const chooseOperation = (): Operation => {
    const writable = role !== 'signedOut';
    const ownerShots = writable ? shotsOfRole(role) : [];
    const ownerSessions = writable ? sessionsOfRole(role) : [];
    const snapshot = store.snapshot();
    const outboxRows = snapshot.outbox;
    type Weighted = readonly [() => Operation, number];
    const choices: Weighted[] = [];
    if (writable) {
      choices.push([
        () => ({
          op: 'save_shot',
          shotId: rng.uuid(),
          permitId: rng.uuid(),
          fate: drawFate(rng),
        }),
        22,
      ]);
      choices.push([
        () => {
          const reuse = ownerSessions.length > 0 && rng.chance(0.5);
          const session = reuse ? rng.pick(ownerSessions) : null;
          return {
            op: 'save_shot_in_set',
            shotId: rng.uuid(),
            permitId: rng.uuid(),
            sessionId: session ? session.id : rng.uuid(),
            order: session
              ? 'session_first'
              : rng.weighted([
                  ['shot_first', 6],
                  ['session_first', 3],
                  ['orphan', 2],
                ] as const),
            newSet: session === null,
            fate: drawFate(rng),
          };
        },
        14,
      ]);
      if (ownerShots.length > 0) {
        choices.push([
          () => ({
            op: 'save_shot_duplicate',
            shotId: rng.pick(ownerShots).id,
          }),
          2,
        ]);
      }
      choices.push([() => ({ op: 'save_abstention', shotId: rng.uuid() }), 5]);
      choices.push([() => ({ op: 'start_set', sessionId: rng.uuid() }), 4]);
      choices.push([
        () => {
          const known = ownerSessions.length > 0 && rng.chance(0.8);
          return {
            op: 'finish_session',
            sessionId: known ? rng.pick(ownerSessions).id : rng.uuid(),
            known,
          };
        },
        4,
      ]);
      choices.push([
        () => ({
          op: 'enqueue_trial',
          trialId: rng.uuid(),
          fate: rng.weighted([
            ['accept', 7],
            ['transient', 2],
            ['permanent', 1],
          ] as const),
        }),
        5,
      ]);
    }
    const drainOp = (withFault: boolean, withMidFlight: boolean): Operation => {
      const profile = rng.chance(0.15)
        ? rng.pick(NETWORK_PROFILES)
        : oracle.profile;
      const fault: FaultPlan | null = withFault
        ? {
            target: rng.pick<FaultTarget>([
              'begin',
              'commit',
              'insert_receipt',
              'delete_outbox',
              'update_outbox',
              'select_outbox',
            ]),
            nth: rng.int(1, 3),
            message: rng.pick(FAULT_MESSAGES),
          }
        : null;
      const midFlight: MidFlightEvent | null = withMidFlight
        ? rng.weighted<MidFlightEvent>([
            [
              {
                kind: 'switch_owner',
                to: rng.pick(['guest', 'userA', 'userB', 'signedOut']),
              },
              4,
            ],
            [
              {
                kind: 'purge_owner',
                role: role === 'signedOut' ? 'userA' : role,
              },
              2,
            ],
            [
              { kind: 'save_shot', shotId: rng.uuid(), permitId: rng.uuid() },
              3,
            ],
          ])
        : null;
      return {
        op: 'drain',
        profile: profile.name,
        fault,
        midFlight,
        trialsSupported: rng.chance(0.8),
        forced: rng.chance(0.1)
          ? rng.pick<RequestOutcome>([
              'timeout',
              'response_lost',
              'malformed_body',
              'wrong_shape',
              'http_401',
            ])
          : null,
      };
    };
    choices.push([() => drainOp(false, false), 25]);
    choices.push([() => drainOp(true, false), 4]);
    choices.push([() => drainOp(false, true), 3]);
    choices.push([
      () => ({ op: 'drain_concurrent', profile: oracle.profile.name }),
      2,
    ]);
    choices.push([
      () => ({
        op: 'switch_owner',
        to: rng.pick(['guest', 'userA', 'userB', 'signedOut']),
      }),
      5,
    ]);
    if (role === 'signedOut') {
      choices.push([
        () => ({
          op: 'write_signed_out',
          what: rng.pick(['shot', 'session', 'finish', 'trial']),
        }),
        12,
      ]);
    }
    const dataRoles = rolesWithData();
    if (dataRoles.length > 0) {
      choices.push([
        () => ({ op: 'purge_owner', role: rng.pick(dataRoles) }),
        1.5,
      ]);
    }
    if (outboxRows.length > 0) {
      choices.push([
        () => ({
          op: 'corrupt_row',
          rowId: rng.pick(outboxRows).id,
          how: rng.pick(['garbage', 'no_permit', 'no_id', 'wrong_kind']),
        }),
        1.5,
      ]);
    }
    if (outboxRows.length > 0 && writable) {
      choices.push([() => ({ op: 'healthy_convergence', maxDrains: 12 }), 3]);
    }
    return rng.weighted(choices)();
  };

  // ── operation executor ─────────────────────────────────────────────────
  const saveShot = async (
    shotId: string,
    permitId: string,
    sessionId: string | null,
    fate: ShotFate,
  ) => {
    const analysis = baseAnalysis(rng, shotId, sessionId, true);
    oracle.setShotFate(shotId, fate);
    await saveAnalysis(db, analysis, permitId);
    shots.set(shotId, {
      id: shotId,
      role,
      sessionId,
      scored: true,
      fate,
      rowIds: [],
    });
  };

  for (let step = 1; step <= steps; step++) {
    const operation = chooseOperation();
    const before = store.snapshot();
    purgedRoles.clear();
    try {
      switch (operation.op) {
        case 'save_shot': {
          await saveShot(
            operation.shotId,
            operation.permitId,
            null,
            operation.fate,
          );
          record(step, operation, 'saved');
          break;
        }
        case 'save_shot_in_set': {
          const startedAt = isoAt(rng);
          const start = async () => {
            await saveSession(db, {
              id: operation.sessionId,
              mode: 'practice_set',
              shotType: 'forehand_drive',
              focusCheckpoint: null,
              startedAt,
            });
            sessions.set(operation.sessionId, {
              id: operation.sessionId,
              role,
            });
            sessionQueued.add(`${role}|${operation.sessionId}`);
          };
          if (operation.newSet && operation.order === 'session_first')
            await start();
          await saveShot(
            operation.shotId,
            operation.permitId,
            operation.sessionId,
            operation.fate,
          );
          if (operation.newSet && operation.order === 'shot_first')
            await start();
          record(
            step,
            operation,
            operation.order === 'orphan'
              ? 'saved (session never queued)'
              : 'saved',
          );
          break;
        }
        case 'save_shot_duplicate': {
          const shot = shots.get(operation.shotId);
          if (!shot) throw new Error('model: duplicate of unknown shot');
          const analysis = baseAnalysis(rng, shot.id, shot.sessionId, true);
          await saveAnalysis(db, analysis, rng.uuid());
          duplicateSaves += 1;
          record(step, operation, 'saved duplicate row');
          break;
        }
        case 'save_abstention': {
          const analysis = baseAnalysis(rng, operation.shotId, null, false);
          await saveLocalOnlyAnalysis(db, analysis);
          shots.set(operation.shotId, {
            id: operation.shotId,
            role,
            sessionId: null,
            scored: false,
            fate: { kind: 'accept' },
            rowIds: [],
          });
          record(step, operation, 'saved locally');
          break;
        }
        case 'start_set': {
          await saveSession(db, {
            id: operation.sessionId,
            mode: 'practice_set',
            shotType: null,
            focusCheckpoint: null,
            startedAt: isoAt(rng),
          });
          sessions.set(operation.sessionId, { id: operation.sessionId, role });
          sessionQueued.add(`${role}|${operation.sessionId}`);
          record(step, operation, 'queued session.create');
          break;
        }
        case 'finish_session': {
          await finishSession(db, operation.sessionId, {
            shots: rng.int(0, 9),
          });
          record(step, operation, 'queued session.finalize');
          break;
        }
        case 'enqueue_trial': {
          oracle.setTrialFate(operation.trialId, operation.fate);
          await enqueueEvaluationTrial(db, trialRecord(operation.trialId));
          trials.set(operation.trialId, role);
          record(step, operation, 'queued evaluation.trial');
          break;
        }
        case 'drain': {
          const profile =
            NETWORK_PROFILES.find(p => p.name === operation.profile) ??
            healthyProfile();
          oracle.profile = profile;
          if (operation.forced) oracle.forcedOutcome = operation.forced;
          if (operation.fault) injector.arm(operation.fault);
          const drainRole = role;
          const owner = OWNER_KEYS[drainRole];
          const bearer = BEARERS[drainRole];
          oracle.hooks.onShotsRequest = (_bearer, ids) =>
            receiptsAtRequest(owner, ids);
          let midFlightFired = false;
          if (operation.midFlight) {
            const event = operation.midFlight;
            oracle.hooks.midFlight = async () => {
              if (midFlightFired) return;
              midFlightFired = true;
              if (event.kind === 'switch_owner') switchOwner(event.to);
              else if (event.kind === 'purge_owner') {
                await purgeOwnerData(store.db, OWNER_KEYS[event.role]);
                purgedRoles.add(event.role);
                for (const s of [...shots.values()])
                  if (s.role === event.role) shots.delete(s.id);
                for (const s of [...sessions.values()])
                  if (s.role === event.role) sessions.delete(s.id);
              } else if (role !== 'signedOut') {
                await saveShot(event.shotId, event.permitId, null, {
                  kind: 'accept',
                });
              }
            };
          }
          const { result, error, requests } = await runDrain(
            transportFor(drainRole, operation.trialsSupported),
          );
          oracle.hooks = {};
          const fired = injector.fired();
          injector.clear();
          if (fired) faultsFired += 1;
          const after = store.snapshot();
          if (fired || operation.midFlight) {
            checkDrainSafety(step, before, after);
            if (
              fired &&
              error === null &&
              result &&
              operation.midFlight?.kind !== 'purge_owner'
            ) {
              // A storage fault inside the receipt transaction must leave the
              // shot queued (rollback) or receipted+deleted — never half.
              for (const row of before.outbox) {
                const shotId = payloadShotId(row);
                if (!shotId) continue;
                const afterRow = after.outbox.find(r => r.id === row.id);
                const receipt = after.receipts.some(
                  r => r.owner_key === row.owner_key && r.entity_id === shotId,
                );
                if (!afterRow && !receipt)
                  violate(
                    step,
                    'I-TXN-ATOMIC',
                    `row ${row.id} deleted without receipt after fault ${fired.target}`,
                  );
              }
            }
            record(
              step,
              operation,
              `drain(${profile.name}) fault=${fired ? fired.target : 'none'} midFlight=${operation.midFlight?.kind ?? 'none'} ${error ? `threw ${String(error)}` : JSON.stringify(result)}`,
              requests,
            );
          } else if (error !== null) {
            violate(
              step,
              'I-DRAIN-THROWS',
              `drainOutbox threw without an injected fault: ${String(error)}`,
            );
            record(step, operation, `threw ${String(error)}`, requests);
          } else if (result) {
            checkDrainEffects(
              step,
              before,
              after,
              owner,
              bearer,
              requests,
              operation.trialsSupported,
              result,
            );
            record(
              step,
              operation,
              `drain(${profile.name}) ${JSON.stringify(result)}`,
              requests,
            );
          }
          break;
        }
        case 'drain_concurrent': {
          // Two drains for the same owner overlap at the network boundary
          // (sign-out/sign-in mid-request creates a second runtime generation).
          const owner = OWNER_KEYS[role];
          oracle.hooks.onShotsRequest = (_bearer, ids) =>
            receiptsAtRequest(owner, ids);
          const originalFetch = globalThis.fetch;
          globalThis.fetch = oracle.fetch as typeof fetch;
          const logStart = oracle.log.length;
          let settledCount = 0;
          const outcomes: Array<{
            result?: { synced: number; failed: number; remaining: number };
            error?: unknown;
          }> = [];
          const boundTransport = transportFor(role, true);
          const first = drainOutbox(db, boundTransport).then(
            r => {
              outcomes.push({ result: r });
              settledCount++;
            },
            e => {
              outcomes.push({ error: e });
              settledCount++;
            },
          );
          const second = drainOutbox(db, boundTransport).then(
            r => {
              outcomes.push({ result: r });
              settledCount++;
            },
            e => {
              outcomes.push({ error: e });
              settledCount++;
            },
          );
          try {
            let guard = 0;
            while (settledCount < 2) {
              await options.clock.advance(API_REQUEST_TIMEOUT_MS + 1);
              if (++guard > 200)
                throw new Error('concurrent drains did not settle');
            }
            await Promise.all([first, second]);
          } finally {
            globalThis.fetch = originalFetch;
            oracle.hooks = {};
          }
          drains += 2;
          concurrentDrains += 1;
          const after = store.snapshot();
          checkDrainSafety(step, before, after, 2);
          for (const outcome of outcomes) {
            if (outcome.error)
              violate(
                step,
                'I-DRAIN-THROWS',
                `concurrent drain threw: ${String(outcome.error)}`,
              );
          }
          record(
            step,
            operation,
            `concurrent drains ${JSON.stringify(outcomes)}`,
            oracle.log.slice(logStart),
          );
          break;
        }
        case 'switch_owner': {
          switchOwner(operation.to);
          record(step, operation, `owner=${OWNER_KEYS[operation.to]}`);
          break;
        }
        case 'write_signed_out': {
          let threw = false;
          try {
            if (operation.what === 'shot')
              await saveAnalysis(
                db,
                baseAnalysis(rng, rng.uuid(), null, true),
                rng.uuid(),
              );
            else if (operation.what === 'session')
              await saveSession(db, {
                id: rng.uuid(),
                mode: 'practice_set',
                shotType: null,
                focusCheckpoint: null,
                startedAt: isoAt(rng),
              });
            else if (operation.what === 'finish')
              await finishSession(db, rng.uuid(), {});
            else await enqueueEvaluationTrial(db, trialRecord(rng.uuid()));
          } catch {
            threw = true;
          }
          const after = store.snapshot();
          if (operation.what === 'trial') {
            if (!threw) {
              const row = after.outbox.find(
                r => r.owner_key === SIGNED_OUT_DATA_OWNER,
              );
              observe(
                step,
                'O-SIGNED-OUT-TRIAL-QUEUED',
                `enqueueEvaluationTrial accepted a write under owner "${SIGNED_OUT_DATA_OWNER}" (row ${row?.id ?? '?'}); saveAnalysis/saveSession refuse the same owner`,
              );
            }
          } else {
            if (!threw)
              violate(
                step,
                'I-SIGNED-OUT-REFUSES-WRITES',
                `${operation.what} write succeeded while signed out`,
              );
            if (!snapshotUnchanged(before, after))
              violate(
                step,
                'I-TXN-ATOMIC',
                `signed-out ${operation.what} write changed the store`,
              );
          }
          record(step, operation, threw ? 'refused' : 'ACCEPTED');
          break;
        }
        case 'purge_owner': {
          await purgeOwnerData(db, OWNER_KEYS[operation.role]);
          purgedRoles.add(operation.role);
          for (const s of [...shots.values()])
            if (s.role === operation.role) shots.delete(s.id);
          for (const s of [...sessions.values()])
            if (s.role === operation.role) sessions.delete(s.id);
          for (const [id, r] of [...trials.entries()])
            if (r === operation.role) trials.delete(id);
          const after = store.snapshot();
          const owner = OWNER_KEYS[operation.role];
          const leftover = [
            ...after.outbox.filter(r => r.owner_key === owner),
            ...after.receipts.filter(r => r.owner_key === owner),
            ...after.shots.filter(r => r.owner_key === owner),
            ...after.sessions.filter(r => r.owner_key === owner),
          ];
          if (leftover.length > 0)
            violate(
              step,
              'I-PURGE',
              `${leftover.length} rows survived purge of ${owner}`,
            );
          const otherBefore = before.outbox.filter(
            r => r.owner_key !== owner,
          ).length;
          const otherAfter = after.outbox.filter(
            r => r.owner_key !== owner,
          ).length;
          if (otherBefore !== otherAfter)
            violate(
              step,
              'I-OWNER',
              `purge of ${owner} changed other owners' outbox (${otherBefore}->${otherAfter})`,
            );
          record(step, operation, 'purged');
          break;
        }
        case 'corrupt_row': {
          const target = before.outbox.find(r => r.id === operation.rowId);
          if (!target) throw new Error('model: corrupt target vanished');
          let payload: string;
          if (operation.how === 'garbage' || !isJson(target.payload))
            payload = '{not json';
          else if (operation.how === 'no_permit') {
            const parsed = JSON.parse(target.payload) as Record<
              string,
              unknown
            >;
            delete parsed['analysisPermitId'];
            payload = JSON.stringify(parsed);
          } else if (operation.how === 'no_id') {
            const parsed = JSON.parse(target.payload) as Record<
              string,
              unknown
            >;
            delete parsed['id'];
            delete parsed['trialId'];
            payload = JSON.stringify(parsed);
          } else payload = JSON.stringify({ unexpected: true });
          store.corruptOutboxPayload(operation.rowId, payload);
          // The model forgets shots whose payload can no longer name them.
          const shotId = payloadShotId(target);
          if (
            shotId &&
            (operation.how === 'garbage' ||
              operation.how === 'no_id' ||
              operation.how === 'wrong_kind')
          ) {
            const shot = shots.get(shotId);
            if (shot) shots.delete(shotId);
          }
          record(step, operation, `payload replaced (${operation.how})`);
          break;
        }
        case 'healthy_convergence': {
          oracle.profile = healthyProfile();
          const owner = OWNER_KEYS[role];
          const bearer = BEARERS[role];
          oracle.hooks.onShotsRequest = (_bearer, ids) =>
            receiptsAtRequest(owner, ids);
          const requestsAll: RequestLogEntry[] = [];
          let lastResult: {
            synced: number;
            failed: number;
            remaining: number;
          } | null = null;
          for (let i = 0; i < operation.maxDrains; i++) {
            const pre = store.snapshot();
            const { result, error, requests } = await runDrain(
              transportFor(role, true),
            );
            requestsAll.push(...requests);
            if (error !== null) {
              violate(
                step,
                'I-DRAIN-THROWS',
                `healthy drain threw: ${String(error)}`,
              );
              break;
            }
            if (!result) break;
            lastResult = result;
            checkDrainEffects(
              step,
              pre,
              store.snapshot(),
              owner,
              bearer,
              requests,
              true,
              result,
            );
            if (result.failed === 0 && result.synced === 0) break;
          }
          oracle.hooks = {};
          const after = store.snapshot();
          const leftover = after.outbox.filter(r => r.owner_key === owner);
          for (const row of leftover) {
            if (row.attempts >= OUTBOX_MAX_ATTEMPTS) continue;
            if (bearer === null) continue; // guest / signed-out cannot sync at all (401 auth.required)
            const shotId = payloadShotId(row);
            const shot = shotId ? shots.get(shotId) : undefined;
            if (
              shot &&
              shot.sessionId &&
              !oracle.hasSession(bearer, shot.sessionId) &&
              !sessionQueued.has(`${role}|${shot.sessionId}`)
            ) {
              orphanShotsStuck += 1;
              observe(
                step,
                'O-ORPHAN-SHOT-STUCK',
                `shot ${shotId} (sessionId ${shot.sessionId} never queued) still queued after ${operation.maxDrains} healthy drains: attempts=${row.attempts}, last_error=${row.last_error ?? 'null'}, status stays "queued"`,
              );
              continue;
            }
            if (
              shot &&
              shot.sessionId &&
              !oracle.hasSession(bearer, shot.sessionId)
            ) {
              const sessionRow = after.outbox.find(
                r =>
                  r.owner_key === owner &&
                  r.kind === 'session.create' &&
                  r.payload.includes(shot.sessionId ?? '\u0000'),
              );
              observe(
                step,
                'O-SHOT-BEHIND-FAILED-SESSION',
                `shot ${shotId} waits on session ${shot.sessionId} whose session.create row ${sessionRow ? `${sessionRow.id} has attempts=${sessionRow.attempts} (${sessionRow.last_error ?? 'null'})` : 'is gone'}; shot attempts=${row.attempts}`,
              );
              continue;
            }
            const eligible = eligibleWindow(after, owner);
            if (!eligible.includes(row)) {
              observe(
                step,
                'O-HEAD-OF-LINE',
                `row ${row.id} (${row.kind}) never reached the 50-row drain window behind ${eligible.length} retryable rows`,
              );
              continue;
            }
            violate(
              step,
              'I-CONVERGENCE',
              `row ${row.id} (${row.kind}, attempts=${row.attempts}, last_error=${row.last_error ?? 'null'}) still queued after ${operation.maxDrains} healthy drains`,
            );
          }
          record(
            step,
            operation,
            `converged: ${JSON.stringify(lastResult)}; leftover=${leftover.length}`,
            requestsAll,
          );
          break;
        }
        default: {
          const never: never = operation;
          throw new Error(`unknown operation ${JSON.stringify(never)}`);
        }
      }
    } catch (error) {
      const after = store.snapshot();
      const message = String(error);
      const isModelError = message.startsWith('Error: model:');
      if (isModelError) throw error;
      // A production write that throws must leave the store untouched.
      if (!snapshotUnchanged(before, after)) {
        violate(
          step,
          'I-TXN-ATOMIC',
          `${operation.op} threw (${message}) and left a partial write`,
        );
      } else {
        violate(
          step,
          'I-UNEXPECTED-THROW',
          `${operation.op} threw: ${message}`,
        );
      }
      record(step, operation, `threw ${message}`);
    }

    const snapshot = store.snapshot();
    checkStructural(step, snapshot);
    await checkDerivedStatus(step, snapshot);
  }

  if (
    resendAfterReceipt > 0 &&
    duplicateSaves === 0 &&
    concurrentDrains === 0
  ) {
    violate(
      steps,
      'I-NO-RESEND-AFTER-RECEIPT',
      `${resendAfterReceipt} shot submissions carried an id that already had a receipt`,
    );
  }
  const finalSnapshot = store.snapshot();
  const outcomeMatrix: Record<string, number> = {};
  for (const [k, v] of oracle.outcomeMatrix) outcomeMatrix[k] = v;
  const result: SequenceResult = {
    seed: options.seed,
    index: options.index,
    sequenceSeed,
    backend: store.backend,
    ok: violations.length === 0,
    violations,
    observations,
    metrics: {
      steps,
      drains,
      requests: oracle.log.length,
      shotsSaved: [...shots.values()].filter(s => s.scored).length,
      abstentions: [...shots.values()].filter(s => !s.scored).length,
      sessionsStarted: sessions.size,
      trialsQueued: trials.size,
      faultsFired,
      receipts: finalSnapshot.receipts.length,
      serverStoredShots: oracle.storedShots().length,
      idempotentReplays: oracle.idempotentReplays,
      resendAfterReceipt,
      orphanShotsStuck,
      statusThrowsOnCorruptRow,
      concurrentDoubleAttempts,
      exhaustedRows: finalSnapshot.outbox.filter(
        r => r.attempts >= OUTBOX_MAX_ATTEMPTS,
      ).length,
      maxOutboxDepth,
      statements: store.statementCount(),
      outcomeMatrix,
      opMatrix,
    },
    trace,
    finalSnapshot,
    heapUsedBefore,
    heapUsedAfter: heapUsed(),
    durationMs: Math.round(nowMs() - started),
  };
  store.close();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  return result;
}

export function pickProfile(name: string): NetworkProfile {
  return NETWORK_PROFILES.find(p => p.name === name) ?? healthyProfile();
}
