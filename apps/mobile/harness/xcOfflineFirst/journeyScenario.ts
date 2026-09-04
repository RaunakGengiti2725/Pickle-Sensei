/**
 * XC journey-offline-first harness: seeded scenario generator + runner.
 *
 * One scenario = one signed-in owner who scores shots while ONLINE (permits
 * are server-reserved; fully-offline scoring is `unavailable_offline` by
 * design — see `src/data/offlineCapabilities.ts` `analysis.strokeScoring`),
 * loses connectivity before the outbox drains, keeps working locally, then
 * reconnects to a server that accepts some rows and rejects others. The
 * runner drives the PRODUCTION repository (`saveAnalysis`, `saveSession`,
 * `finishSession`), the PRODUCTION engine (`drainOutbox`) and the PRODUCTION
 * transport (`createTransport` → `fetch`) over a real SQLite database and a
 * fetch-level server model, then checks the journey invariants:
 *
 *  I1 no local data loss — every local_shot / local_session row survives
 *     byte-for-byte across offline drains, faults and reconciliation;
 *  I2 outbox ⊕ receipt — every scored shot is either still queued or has a
 *     durable receipt, and a receipt exists iff the server holds the row;
 *  I3 transient failures never spend the attempt budget;
 *  I4 permanent rejections spend exactly one attempt per delivered verdict
 *     and stop being sent once exhausted;
 *  I5 sessions reach the server before the shots that reference them are
 *     accepted, and every finalize follows its create;
 *  I6 low-confidence (local-only) analyses are never transmitted;
 *  I7 the queue status derived from durable rows matches the row states;
 *  I8 a committed-then-dropped response is reconciled by idempotent replay
 *     (server holds exactly one row, receipt lands on the next flush).
 */
import type {
  CheckpointKey,
  CheckpointScore,
  PhaseKey,
  PhaseSpan,
  ShotAnalysis,
} from '@pickle/shared-types';
import { setActiveDataOwner } from '../../src/data/accountScope';
import { createTransport } from '../../src/data/api';
import {
  deriveUploadQueueStatus,
  type UploadQueueStatus,
} from '../../src/data/offlineCapabilities';
import {
  finishSession,
  getShotOutboxStatus,
  hasShotSyncReceipt,
  saveAnalysis,
  saveLocalOnlyAnalysis,
  saveSession,
} from '../../src/data/repository';
import { drainOutbox, OUTBOX_MAX_ATTEMPTS } from '../../src/data/sync';
import {
  FakeSyncServer,
  type PermanentRejectionCode,
  type ServerMode,
} from './fakeSyncServer';
import {
  openSqliteLocalDb,
  snapshotLocalState,
  type SqliteLocalDb,
} from './sqliteLocalDb';

// ─── Deterministic PRNG (mulberry32) ────────────────────────────────────────

export interface Rng {
  next(): number;
  int(minInclusive: number, maxInclusive: number): number;
  pick<T>(items: readonly T[]): T;
  chance(probability: number): boolean;
  uuid(): string;
}

export function makeRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) =>
    lo + Math.floor(next() * (hi - lo + 1));
  const hex = (n: number) =>
    Array.from({ length: n }, () => int(0, 15).toString(16)).join('');
  return {
    next,
    int,
    pick: items => {
      const item = items[int(0, items.length - 1)];
      if (item === undefined) throw new Error('pick from empty list');
      return item;
    },
    chance: p => next() < p,
    // RFC 4122 v4 layout (version nibble 4, variant 8..b) — the server model
    // and the Edge Function both validate ids with a v1-v5 UUID regex.
    uuid: () =>
      `${hex(8)}-${hex(4)}-4${hex(3)}-${['8', '9', 'a', 'b'][int(0, 3)]}${hex(3)}-${hex(12)}`,
  };
}

// ─── Analysis fixtures ──────────────────────────────────────────────────────

const PHASES: PhaseKey[] = [
  'ready',
  'prepare',
  'accelerate',
  'contact',
  'follow_through',
  'recover',
];
const CHECKPOINTS: CheckpointKey[] = [
  'ready_position',
  'athletic_base',
  'preparation',
  'paddle_set',
  'swing_length',
  'sequencing',
  'paddle_path',
  'contact_position',
  'face_wrist_stability',
  'follow_through',
  'recovery',
];
const SHOT_TYPES = [
  'forehand_drive',
  'backhand_drive',
  'dink',
  'serve',
  'volley',
] as const;

function phase(key: PhaseKey, startMs: number, endMs: number): PhaseSpan {
  return {
    key,
    startMs,
    representativeMs: startMs + (endMs - startMs) / 2,
    endMs,
    confidence: 0.8,
  };
}

function checkpoint(key: CheckpointKey, score: number | null): CheckpointScore {
  return {
    key,
    score,
    confidence: 0.8,
    band:
      score === null
        ? 'unscored'
        : score >= 80
          ? 'green'
          : score >= 60
            ? 'yellow'
            : 'red',
    direction: 'none',
    severity: score === null ? 0 : (100 - score) / 100,
    applicable: true,
  };
}

export function makeAnalysis(
  rng: Rng,
  input: {
    id: string;
    sessionId: string | null;
    capturedAtIso: string;
    resultKind: 'scored' | 'low_confidence';
  },
): ShotAnalysis {
  const shotType = rng.pick(SHOT_TYPES);
  const scored = input.resultKind === 'scored';
  const spans = PHASES.map((key, index) =>
    phase(key, index * 500, index * 500 + 500),
  );
  return {
    id: input.id,
    sessionId: input.sessionId,
    shotType,
    cameraView: rng.pick(['side', 'rear'] as const),
    handedness: 'right',
    capturedAtIso: input.capturedAtIso,
    timestamps: { startMs: 0, contactMs: 1750, endMs: 3000 },
    phases: spans,
    measurements: [],
    checkpoints: CHECKPOINTS.map(key =>
      checkpoint(key, scored ? rng.int(30, 98) : null),
    ),
    overallScore: scored ? Math.round(rng.int(30, 98)) / 10 : null,
    analysisConfidence: scored
      ? 0.7 + rng.next() * 0.29
      : 0.2 + rng.next() * 0.3,
    resultKind: input.resultKind,
    guidance: null,
    priorityFix: null,
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'on-device-fusion-1',
      poseModelVersion: 'apple-vision-bodypose-1',
      paddleModelVersion: 'none',
      strokeDetectorVersion: 'temporal-stroke-heuristic-2',
      phaseModelVersion: 'phase-geometry-1',
      scoringModelVersion: 'sm-v1',
      shotConfigVersion: `${shotType}@1`,
    },
    source: 'real',
  } as ShotAnalysis;
}

// ─── Scenario plan ──────────────────────────────────────────────────────────

export type PlannedOutcome =
  | { kind: 'accept' }
  | { kind: 'write_failed'; times: number }
  | { kind: 'permanent'; code: PermanentRejectionCode }
  | { kind: 'permit_expired' };

export interface PlannedShot {
  id: string;
  permitId: string;
  sessionId: string | null;
  resultKind: 'scored' | 'low_confidence';
  outcome: PlannedOutcome;
}

export interface PlannedSet {
  sessionId: string;
  shots: PlannedShot[];
  finalize: boolean;
}

export interface ScenarioPlan {
  seed: number;
  owner: string;
  premium: boolean;
  sets: PlannedSet[];
  /** Shots captured outside any practice set (sessionId null). */
  loose: PlannedShot[];
  /** Server modes for reconnect drains, by drain index; `online` after. */
  reconnectModes: ServerMode[];
  offlineDrains: number;
}

const PERMANENT_CODES: PermanentRejectionCode[] = [
  'access.permit_not_found',
  'access.permit_not_reserved',
  'access.paywall_required',
  'shot.id_conflict',
];

export function planScenario(seed: number): ScenarioPlan {
  const rng = makeRng(seed);
  const owner = rng.uuid();
  const outcomeFor = (): PlannedOutcome => {
    const roll = rng.next();
    if (roll < 0.62) return { kind: 'accept' };
    if (roll < 0.8) return { kind: 'write_failed', times: rng.int(1, 3) };
    if (roll < 0.94)
      return { kind: 'permanent', code: rng.pick(PERMANENT_CODES) };
    return { kind: 'permit_expired' };
  };
  const shot = (sessionId: string | null): PlannedShot => {
    const scored = rng.chance(0.85);
    return {
      id: rng.uuid(),
      permitId: rng.uuid(),
      sessionId,
      resultKind: scored ? 'scored' : 'low_confidence',
      outcome: scored ? outcomeFor() : { kind: 'accept' },
    };
  };
  const sets: PlannedSet[] = [];
  const setCount = rng.int(1, 4);
  for (let s = 0; s < setCount; s++) {
    const sessionId = rng.uuid();
    const shots = Array.from({ length: rng.int(1, 9) }, () => shot(sessionId));
    sets.push({ sessionId, shots, finalize: rng.chance(0.7) });
  }
  const loose = Array.from({ length: rng.int(0, 3) }, () => shot(null));
  const reconnectModes: ServerMode[] = [];
  const flaky = rng.int(0, 4);
  for (let i = 0; i < flaky; i++) {
    reconnectModes.push(
      rng.pick([
        'http500',
        'http429',
        'http401',
        'offline',
        'commit_then_drop',
      ] as const),
    );
  }
  return {
    seed,
    owner,
    premium: true,
    sets,
    loose,
    reconnectModes,
    offlineDrains: rng.int(1, 4),
  };
}

// ─── Runner ─────────────────────────────────────────────────────────────────

export interface InvariantResult {
  id: string;
  ok: boolean;
  detail: string;
}

export interface ShotOutcomeRow {
  shotId: string;
  sessionId: string | null;
  resultKind: string;
  planned: string;
  serverHolds: boolean;
  receipt: boolean;
  outbox: string;
  attempts: number;
  lastError: string | null;
  requestsCarrying: number;
}

export interface ScenarioResult {
  seed: number;
  owner: string;
  plan: ScenarioPlan;
  scoredShots: number;
  localOnlyShots: number;
  sessions: number;
  offlineDrains: number;
  reconnectDrains: number;
  drainsToQuiescence: number;
  totalRequests: number;
  invariants: InvariantResult[];
  allOk: boolean;
  queueStatusBeforeReconnect: UploadQueueStatus;
  queueStatusFinal: UploadQueueStatus;
  shots: ShotOutcomeRow[];
  statementsExecuted: number;
}

export const API_BASE_URL = 'https://xc-offline-first.invalid';

const MAX_RECONNECT_DRAINS = 60;

async function outboxRows(db: SqliteLocalDb, owner: string) {
  const { rows } = await db.execute(
    'SELECT id, kind, payload, attempts, last_error FROM outbox WHERE owner_key = ? ORDER BY id',
    [owner],
  );
  return rows;
}

function queueRows(outbox: Record<string, unknown>[]) {
  return outbox.map(row => ({
    kind: String(row['kind']),
    attempts: Number(row['attempts']),
    lastError: typeof row['last_error'] === 'string' ? row['last_error'] : null,
  }));
}

function payloadIdOf(row: Record<string, unknown>): string {
  const parsed = JSON.parse(String(row['payload'])) as { id?: unknown };
  return typeof parsed.id === 'string' ? parsed.id : '';
}

export async function runScenario(
  plan: ScenarioPlan,
  options: { db?: SqliteLocalDb; keepDb?: boolean } = {},
): Promise<ScenarioResult> {
  const rng = makeRng(plan.seed ^ 0x9e3779b9);
  const db = options.db ?? openSqliteLocalDb();
  const server = new FakeSyncServer({
    userId: plan.owner,
    premium: plan.premium,
  });
  const restoreFetch = server.install();
  setActiveDataOwner(plan.owner);
  const transport = createTransport({
    baseUrl: API_BASE_URL,
    token: 'xc-token',
  });
  const invariants: InvariantResult[] = [];
  const check = (id: string, ok: boolean, detail: string) => {
    invariants.push({ id, ok, detail });
  };

  try {
    // ── Phase A: ONLINE scoring session, permits reserved server-side ──
    const allShots: PlannedShot[] = [];
    const capturedBase = Date.parse('2026-09-04T12:00:00.000Z');
    let captureIndex = 0;
    const persistShot = async (shot: PlannedShot) => {
      const analysis = makeAnalysis(rng, {
        id: shot.id,
        sessionId: shot.sessionId,
        capturedAtIso: new Date(
          capturedBase + captureIndex++ * 15_000,
        ).toISOString(),
        resultKind: shot.resultKind,
      });
      if (shot.resultKind === 'scored') {
        server.reservePermit(shot.permitId);
        switch (shot.outcome.kind) {
          case 'write_failed':
            server.faults.set(shot.id, {
              kind: 'write_failed',
              remaining: shot.outcome.times,
            });
            break;
          case 'permanent':
            server.faults.set(shot.id, {
              kind: 'permanent',
              code: shot.outcome.code,
            });
            break;
          case 'permit_expired':
            server.faults.set(shot.id, { kind: 'permit_expired' });
            break;
          case 'accept':
            break;
        }
        await saveAnalysis(db, analysis, shot.permitId);
      } else {
        await saveLocalOnlyAnalysis(db, analysis);
      }
      allShots.push(shot);
    };
    for (const set of plan.sets) {
      const [first, ...rest] = set.shots;
      if (first) await persistShot(first);
      // Mirrors practiceSet.commitPracticeSet: the session row is written
      // AFTER the first scored analysis that references it.
      await saveSession(db, {
        id: set.sessionId,
        mode: 'practice_set',
        shotType: first?.resultKind === 'scored' ? 'forehand_drive' : null,
        focusCheckpoint: null,
        startedAt: new Date(capturedBase).toISOString(),
      });
      for (const shot of rest) await persistShot(shot);
      if (set.finalize) {
        await finishSession(db, set.sessionId, { shots: set.shots.length });
      }
    }
    for (const shot of plan.loose) await persistShot(shot);

    const scored = allShots.filter(s => s.resultKind === 'scored');
    const localOnly = allShots.filter(s => s.resultKind === 'low_confidence');
    const before = snapshotLocalState(db);
    const expectedOutboxRows =
      scored.length +
      plan.sets.length +
      plan.sets.filter(s => s.finalize).length;
    check(
      'A.queued',
      before.outbox.length === expectedOutboxRows,
      `outbox rows ${before.outbox.length} expected ${expectedOutboxRows}`,
    );

    // ── Phase B: connectivity lost before any flush; repeated drains ──
    server.setModeFor(() => 'offline');
    for (let i = 0; i < plan.offlineDrains; i++) {
      const result = await drainOutbox(db, transport);
      check(
        `B.offline_drain_${i}`,
        result.synced === 0 && result.remaining === expectedOutboxRows,
        `synced=${result.synced} failed=${result.failed} remaining=${result.remaining}`,
      );
    }
    const afterOffline = snapshotLocalState(db);
    check(
      'I1.offline_no_loss',
      JSON.stringify(afterOffline.localShots) ===
        JSON.stringify(before.localShots) &&
        JSON.stringify(afterOffline.localSessions) ===
          JSON.stringify(before.localSessions),
      'local_shot/local_session identical after offline drains',
    );
    check(
      'I3.offline_attempts_zero',
      afterOffline.outbox.every(row => Number(row['attempts']) === 0) &&
        afterOffline.outbox.length === expectedOutboxRows,
      `attempts=${afterOffline.outbox.map(r => r['attempts']).join(',')}`,
    );
    const queueStatusBeforeReconnect = deriveUploadQueueStatus(
      queueRows(afterOffline.outbox),
    );
    check(
      'I7.offline_status_queued',
      expectedOutboxRows === 0
        ? queueStatusBeforeReconnect.state === 'idle'
        : queueStatusBeforeReconnect.state === 'queued' &&
            queueStatusBeforeReconnect.pending === expectedOutboxRows,
      JSON.stringify(queueStatusBeforeReconnect),
    );

    // ── Phase C: reconnect through a flaky edge, then flush to quiescence ──
    let drainIndex = 0;
    server.setModeFor(() => plan.reconnectModes[drainIndex] ?? 'online');
    let reconnectDrains = 0;
    let quiescentAt = -1;
    let previousFingerprint = '';
    for (; reconnectDrains < MAX_RECONNECT_DRAINS; reconnectDrains++) {
      drainIndex = reconnectDrains;
      await drainOutbox(db, transport);
      const rows = await outboxRows(db, plan.owner);
      // Durable client state plus the model's remaining transient faults: a
      // `shot.write_failed` row looks identical drain after drain (no budget
      // spent) while the server is still one retry away from accepting it.
      const fingerprint = JSON.stringify([
        rows.map(r => [r['id'], r['attempts'], r['last_error']]),
        [...server.faults.entries()].map(([id, fault]) => [
          id,
          fault.kind === 'write_failed' ? fault.remaining : fault.kind,
        ]),
      ]);
      const online = (plan.reconnectModes[drainIndex] ?? 'online') === 'online';
      if (online && fingerprint === previousFingerprint) {
        quiescentAt = reconnectDrains;
        break;
      }
      previousFingerprint = fingerprint;
    }
    check(
      'C.quiescent',
      quiescentAt >= 0,
      `quiescent after ${quiescentAt} drains (max ${MAX_RECONNECT_DRAINS})`,
    );

    // ── Invariants over the final durable state ──
    const final = snapshotLocalState(db);
    check(
      'I1.reconnect_no_loss',
      JSON.stringify(final.localShots) === JSON.stringify(before.localShots) &&
        JSON.stringify(final.localSessions) ===
          JSON.stringify(before.localSessions),
      'local_shot/local_session identical after reconciliation',
    );
    check(
      'I6.local_only_never_sent',
      localOnly.every(s => server.requestsFor(s.id).length === 0),
      `${localOnly.length} low-confidence analyses, none transmitted`,
    );

    const shots: ShotOutcomeRow[] = [];
    for (const shot of scored) {
      const status = await getShotOutboxStatus(db, shot.id);
      const receipt = await hasShotSyncReceipt(db, shot.id);
      const serverHolds = server.shots.has(shot.id);
      const carrying = server.requestsFor(shot.id);
      shots.push({
        shotId: shot.id,
        sessionId: shot.sessionId,
        resultKind: shot.resultKind,
        planned: JSON.stringify(shot.outcome),
        serverHolds,
        receipt,
        outbox: status.state,
        attempts: status.state === 'absent' ? 0 : status.attempts,
        lastError: status.state === 'absent' ? null : status.lastError,
        requestsCarrying: carrying.length,
      });
      const queued = status.state !== 'absent';
      check(
        `I2.${shot.id}`,
        queued !== receipt && receipt === serverHolds,
        `outbox=${status.state} receipt=${receipt} server=${serverHolds}`,
      );
      switch (shot.outcome.kind) {
        case 'accept':
        case 'write_failed':
          check(
            `I3.${shot.id}`,
            serverHolds && receipt && status.state === 'absent',
            `expected eventual acceptance without spending budget; ${JSON.stringify(status)}`,
          );
          break;
        case 'permanent':
        case 'permit_expired': {
          const delivered = carrying.filter(
            entry =>
              entry.status === 200 &&
              entry.rejected?.some(item => item.id === shot.id),
          ).length;
          const attempts = status.state === 'absent' ? 0 : status.attempts;
          const expectedState =
            attempts >= OUTBOX_MAX_ATTEMPTS ? 'exhausted' : 'rejected';
          check(
            `I4.${shot.id}`,
            !serverHolds &&
              !receipt &&
              status.state === expectedState &&
              attempts === Math.min(delivered, OUTBOX_MAX_ATTEMPTS) &&
              delivered <= OUTBOX_MAX_ATTEMPTS,
            `delivered=${delivered} attempts=${attempts} state=${status.state}`,
          );
          break;
        }
      }
    }

    // I5: ordering. Every accepted shot with a sessionId was accepted in a
    // request numbered AFTER the session.create request that succeeded.
    for (const set of plan.sets) {
      const createOk = server.requests.find(
        r =>
          r.path === '/v1/sessions' &&
          r.entityIds.includes(set.sessionId) &&
          (r.status === 200 || r.mode === 'commit_then_drop'),
      );
      const finalizeOk = server.requests.find(
        r =>
          r.path === `/v1/sessions/${set.sessionId}/finalize` &&
          r.status === 200,
      );
      const acceptedShotRequests = server.requests.filter(
        r =>
          r.path === '/v1/shots:sync' &&
          r.acceptedIds?.some(id => set.shots.some(s => s.id === id)),
      );
      check(
        `I5.${set.sessionId}`,
        server.sessions.has(set.sessionId) &&
          createOk !== undefined &&
          acceptedShotRequests.every(r => r.n > createOk.n) &&
          (!set.finalize ||
            (finalizeOk !== undefined && finalizeOk.n > createOk.n)),
        `create=${createOk?.n ?? 'none'} finalize=${finalizeOk?.n ?? 'none'} shotAccepts=${acceptedShotRequests.map(r => r.n).join(',')}`,
      );
    }
    check(
      'I5.session_rows_drained',
      final.outbox.every(row => row['kind'] === 'shot.sync'),
      `non-shot rows left: ${final.outbox.filter(r => r['kind'] !== 'shot.sync').length}`,
    );

    // I8: commit_then_drop never duplicates and always reconciles.
    const droppedShotIds = server.requests
      .filter(r => r.mode === 'commit_then_drop' && r.path === '/v1/shots:sync')
      .flatMap(r => r.acceptedIds ?? []);
    check(
      'I8.replay_reconciled',
      droppedShotIds.every(id => {
        const receipt = final.receipts.some(r => r['entity_id'] === id);
        return receipt && server.shots.has(id);
      }),
      `${droppedShotIds.length} accepted-but-dropped shots all receipted`,
    );

    const queueStatusFinal = deriveUploadQueueStatus(queueRows(final.outbox));
    const exhaustedRows = final.outbox.filter(
      r => Number(r['attempts']) >= OUTBOX_MAX_ATTEMPTS,
    ).length;
    check(
      'I7.final_status',
      final.outbox.length === 0
        ? queueStatusFinal.state === 'idle'
        : exhaustedRows > 0
          ? queueStatusFinal.state === 'needs_attention' &&
            queueStatusFinal.exhausted === exhaustedRows &&
            queueStatusFinal.pending === final.outbox.length - exhaustedRows
          : queueStatusFinal.state === 'queued' &&
            queueStatusFinal.pending === final.outbox.length,
      JSON.stringify(queueStatusFinal),
    );
    // Every remaining outbox row must correspond to a shot the server rejected
    // permanently — nothing else may linger after quiescence.
    check(
      'C.remaining_are_permanent_rejections',
      final.outbox.every(row => {
        const shot = scored.find(s => s.id === payloadIdOf(row));
        return (
          shot !== undefined &&
          (shot.outcome.kind === 'permanent' ||
            shot.outcome.kind === 'permit_expired')
        );
      }),
      `${final.outbox.length} rows remain`,
    );

    return {
      seed: plan.seed,
      owner: plan.owner,
      plan,
      scoredShots: scored.length,
      localOnlyShots: localOnly.length,
      sessions: plan.sets.length,
      offlineDrains: plan.offlineDrains,
      reconnectDrains,
      drainsToQuiescence: quiescentAt,
      totalRequests: server.requests.length,
      invariants,
      allOk: invariants.every(i => i.ok),
      queueStatusBeforeReconnect,
      queueStatusFinal,
      shots,
      statementsExecuted: db.statementCount(),
    };
  } finally {
    restoreFetch();
    if (!options.keepDb) db.close();
  }
}
