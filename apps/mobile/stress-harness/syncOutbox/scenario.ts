import type { ShotAnalysis } from '@pickle/shared-types';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { getDb, type LocalDb } from '../../src/data/db';
import { saveAnalysis } from '../../src/data/repository';
import { OUTBOX_MAX_ATTEMPTS, drainOutbox } from '../../src/data/sync';
import type { SqlInputValue } from '../../xc-harness/lifecycle-persistence/nodeShim';
import {
  FakeServer,
  SERVER_PROFILES,
  type ServerCallRecord,
  type VerdictClass,
} from './fakeServer';
import { chance, int, makePrng, pick, uuid, weighted, type Prng } from './prng';
import { Scheduler, withDeadline, type SchedulerProfile } from './scheduler';
import { seam } from './sqliteSeam';

/**
 * One seeded concurrency scenario against the PRODUCTION `drainOutbox` on a
 * real SQLite database (see sqliteSeam.ts) with a seeded fake server.
 *
 * Shape (all drawn from the seed):
 *   - 1..16 outbox rows across two account owners (+ poison rows, duplicate
 *     rows for the same shot, rows at/near the attempt budget, created_at
 *     skewed days into the past/future),
 *   - 2..6 concurrent `drainOutbox` actors on the SAME connection with
 *     staggered starts (duplicate call, call-during-call),
 *   - owner flips between actor starts (sign-out / sign-in as another
 *     account while an earlier drain is still in flight), optionally
 *     revoking the previous owner's bearer mid-request,
 *   - 0..2 concurrent `saveAnalysis` writers (the capture flow persisting a
 *     rating while a drain runs),
 *   - the fake server drawing its failure class per request (2xx, partial
 *     accept/reject/omit, 4xx/5xx/429, network error, timeout, malformed
 *     body, revoked bearer).
 * After the burst settles, a healthy convergence phase drains sequentially
 * so "eventually every durable row reaches the server exactly once" can be
 * asserted as well as the mid-burst invariants.
 */

export type RowKind =
  'shot.sync' | 'session.create' | 'session.finalize' | 'evaluation.trial';

export type PoisonKind =
  | 'invalid_json'
  | 'json_null'
  | 'shot_missing_permit'
  | 'shot_empty_permit'
  | 'unknown_kind'
  | 'trial_missing_id'
  | 'session_invalid_json';

export interface SeedRow {
  index: number;
  owner: string;
  kind: string;
  entityId: string;
  poison: PoisonKind | null;
  attempts: number;
  createdAt: string;
  payload: string;
  /** Another seeded row carries the same entity (duplicate outbox row). */
  duplicateOf: number | null;
}

interface RowSnapshot {
  id: number;
  owner_key: string;
  kind: string;
  payload: string;
  attempts: number;
  last_error: string | null;
}

export interface ActorPlan {
  name: string;
  type: 'drain' | 'writer';
  startHops: number;
  /** Owner to activate right before this actor starts (null = no flip). */
  flipTo: string | null;
  /** Revoke the previously active owner's bearer when flipping. */
  revokePrevious: boolean;
  /** Writers: the shot they persist. */
  shotId?: string;
  permitId?: string;
}

export interface ScenarioPlan {
  seed: number;
  ownerA: string;
  ownerB: string;
  serverProfile: string;
  schedulerProfile: SchedulerProfile;
  rows: SeedRow[];
  actors: ActorPlan[];
  transportHasTrials: boolean;
}

export interface ScenarioMetrics {
  drains: number;
  writers: number;
  ownerFlips: number;
  revocations: number;
  serverCalls: number;
  statements: number;
  statementErrors: number;
  nestedTransactionErrors: number;
  rollbackWithoutTransaction: number;
  duplicateSends: number;
  overlappingDuplicateSends: number;
  drainRejections: string[];
  writerRejections: string[];
  /** `<holder>-><victim>` per nested-transaction abort (actor types). */
  transactionCollisions: string[];
  attemptsOvershoot: number;
  hops: number;
  convergencePasses: number;
  wallMs: number;
}

export interface ScenarioResult {
  seed: number;
  /** No invariant failed other than KNOWN_DEFECT_INVARIANTS. */
  ok: boolean;
  failed: string[];
  knownDefects: string[];
  invariants: Record<string, boolean>;
  metrics: ScenarioMetrics;
  plan: ScenarioPlan;
  /** Populated only when an invariant failed (keeps the table small). */
  detail?: {
    violations: string[];
    finalOutbox: RowSnapshot[];
    finalReceipts: Array<Record<string, unknown>>;
    serverCalls: ServerCallRecord[];
    statementLog: Array<{
      seq: number;
      actor: string;
      sql: string;
      ok: boolean;
      error?: string;
    }>;
  };
}

export const ITERATION_DEADLINE_MS = 15_000;

/**
 * Invariants reproduced as BROKEN on the reviewed commit. They are still
 * evaluated and reported per seed (summary.knownDefectSeeds) but do not fail
 * the campaign, because each one is pinned by a `test.failing` reproduction
 * in __tests__/stress/syncOutboxSharedConnection.stress.test.ts that flips
 * red the moment the defect is fixed — remove the entry here and the
 * `.failing` there together.
 */
export const KNOWN_DEFECT_INVARIANTS: ReadonlySet<string> = new Set([
  'writerNeverFails',
]);

function actorType(actor: string): string {
  return actor.replace(/-\d+$/, '');
}

/** Attribute every failed BEGIN to the actor whose transaction was open. */
export function classifyCollisions(
  log: ReadonlyArray<{
    actor: string;
    sql: string;
    ok: boolean;
    error?: string;
  }>,
): string[] {
  const out: string[] = [];
  let holder: string | null = null;
  for (const entry of log) {
    const sql = entry.sql.trim().toUpperCase();
    if (sql.startsWith('BEGIN')) {
      if (entry.ok) holder = entry.actor;
      else if (/within a transaction/i.test(entry.error ?? '')) {
        out.push(
          `${actorType(holder ?? 'unknown')}->${actorType(entry.actor)}`,
        );
      }
    } else if ((sql === 'COMMIT' || sql === 'ROLLBACK') && entry.ok) {
      holder = null;
    }
  }
  return out;
}

const SHOT_TYPES = ['forehand_drive', 'backhand_drive', 'dink', 'serve'];

export function buildAnalysis(
  rng: Prng,
  id: string,
  sessionId: string | null,
): ShotAnalysis {
  return {
    id,
    sessionId,
    shotType: pick(rng, SHOT_TYPES) as ShotAnalysis['shotType'],
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: new Date(
      Date.UTC(2026, 7, 26, 18, 0, 0) +
        int(rng, -86_400_000 * 30, 86_400_000 * 30),
    ).toISOString(),
    timestamps: { startMs: 0, contactMs: int(rng, 400, 1600), endMs: 2000 },
    phases: [],
    measurements: [],
    checkpoints: [],
    overallScore: int(rng, 30, 99) / 10,
    analysisConfidence: int(rng, 70, 99) / 100,
    resultKind: 'scored',
    guidance: null,
    priorityFix: null,
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'stress-bundle-1',
      poseModelVersion: 'pose-1',
      paddleModelVersion: 'paddle-1',
      strokeDetectorVersion: 'stroke-1',
      phaseModelVersion: 'phase-1',
      scoringModelVersion: 'sm-v1',
      shotConfigVersion: 'forehand_drive@1',
    },
    source: 'real',
  } as ShotAnalysis;
}

/** SQLite `datetime('now')`-shaped timestamp skewed by `skewDays`. */
function skewedCreatedAt(rng: Prng): string {
  const base = Date.UTC(2026, 8, 5, 1, 0, 0);
  const skewMs =
    int(rng, -400, 400) * 86_400_000 + int(rng, -3_600_000, 3_600_000);
  return new Date(base + skewMs).toISOString().replace('T', ' ').slice(0, 19);
}

export function planScenario(seed: number): ScenarioPlan {
  const rng = makePrng(seed);
  const ownerA = uuid(rng);
  const ownerB = chance(rng, 0.2) ? GUEST_DATA_OWNER : uuid(rng);
  const serverProfile = pick(rng, SERVER_PROFILES).name;
  const schedulerProfile: SchedulerProfile = {
    dbMaxHops: int(rng, 0, 3),
    netMinHops: int(rng, 0, 4),
    netMaxHops: int(rng, 4, 14),
    actorStartMaxHops: int(rng, 0, 12),
    macroChance: pick(rng, [0, 0.1, 0.35]),
  };

  const rows: SeedRow[] = [];
  const rowCount = int(rng, 1, 16);
  const shotRows: SeedRow[] = [];
  for (let i = 0; i < rowCount; i += 1) {
    const owner = chance(rng, 0.75) ? ownerA : ownerB;
    const attempts = weighted<number>(rng, [
      [0, 70],
      [int(rng, 1, 6), 15],
      [OUTBOX_MAX_ATTEMPTS - 1, 10],
      [OUTBOX_MAX_ATTEMPTS + int(rng, 0, 2), 5],
    ]);
    const createdAt = skewedCreatedAt(rng);
    const roll = weighted<RowKind | 'poison' | 'duplicate'>(rng, [
      ['shot.sync', 50],
      ['session.create', 10],
      ['session.finalize', 8],
      ['evaluation.trial', 10],
      ['poison', 14],
      ['duplicate', 8],
    ]);
    if (roll === 'duplicate' && shotRows.length > 0) {
      const candidates = shotRows.filter(r => r.owner === owner);
      const source = candidates.length > 0 ? pick(rng, candidates) : null;
      if (source) {
        rows.push({
          ...source,
          index: i,
          attempts,
          createdAt,
          duplicateOf: source.index,
        });
        continue;
      }
    }
    if (roll === 'poison') {
      const poison = pick<PoisonKind>(rng, [
        'invalid_json',
        'json_null',
        'shot_missing_permit',
        'shot_empty_permit',
        'unknown_kind',
        'trial_missing_id',
        'session_invalid_json',
      ]);
      const entityId = uuid(rng);
      let kind = 'shot.sync';
      let payload = '';
      switch (poison) {
        case 'invalid_json':
          payload = '{"id":"' + entityId + '", not json';
          break;
        case 'json_null':
          payload = 'null';
          break;
        case 'shot_missing_permit': {
          const { analysisPermitId: _omit, ...rest } = {
            ...buildAnalysis(rng, entityId, null),
            analysisPermitId: 'x',
          };
          void _omit;
          payload = JSON.stringify(rest);
          break;
        }
        case 'shot_empty_permit':
          payload = JSON.stringify({
            ...buildAnalysis(rng, entityId, null),
            analysisPermitId: '   ',
          });
          break;
        case 'unknown_kind':
          kind = pick(rng, ['profile.sync', 'shot.delete', '']);
          payload = JSON.stringify({ id: entityId });
          break;
        case 'trial_missing_id':
          kind = 'evaluation.trial';
          payload = JSON.stringify({ captureId: entityId });
          break;
        case 'session_invalid_json':
          kind = pick(rng, ['session.create', 'session.finalize']);
          payload = '<html>not json</html>';
          break;
      }
      rows.push({
        index: i,
        owner,
        kind,
        entityId,
        poison,
        attempts,
        createdAt,
        payload,
        duplicateOf: null,
      });
      continue;
    }
    const kind: RowKind = roll === 'duplicate' ? 'shot.sync' : roll;
    const entityId = uuid(rng);
    let payload: string;
    switch (kind) {
      case 'shot.sync':
        payload = JSON.stringify({
          ...buildAnalysis(rng, entityId, chance(rng, 0.3) ? uuid(rng) : null),
          analysisPermitId: uuid(rng),
        });
        break;
      case 'session.create':
        payload = JSON.stringify({
          id: entityId,
          startedAt: new Date(Date.UTC(2026, 7, 26)).toISOString(),
          shotType: pick(rng, SHOT_TYPES),
        });
        break;
      case 'session.finalize':
        payload = JSON.stringify({ id: entityId });
        break;
      case 'evaluation.trial':
        payload = JSON.stringify({ trialId: entityId, captureId: uuid(rng) });
        break;
    }
    const row: SeedRow = {
      index: i,
      owner,
      kind,
      entityId,
      poison: null,
      attempts,
      createdAt,
      payload,
      duplicateOf: null,
    };
    rows.push(row);
    if (kind === 'shot.sync') shotRows.push(row);
  }

  const actors: ActorPlan[] = [];
  const drains = int(rng, 2, 6);
  const writers = weighted<number>(rng, [
    [0, 55],
    [1, 30],
    [2, 15],
  ]);
  let current = ownerA;
  for (let i = 0; i < drains; i += 1) {
    let flipTo: string | null = null;
    let revokePrevious = false;
    if (i > 0 && chance(rng, 0.25)) {
      flipTo = pick(
        rng,
        [ownerA, ownerB, SIGNED_OUT_DATA_OWNER].filter(o => o !== current),
      );
      revokePrevious = chance(rng, 0.5);
      current = flipTo;
    }
    actors.push({
      name: `drain-${i}`,
      type: 'drain',
      startHops: int(rng, 0, schedulerProfile.actorStartMaxHops),
      flipTo,
      revokePrevious,
    });
  }
  for (let i = 0; i < writers; i += 1) {
    actors.push({
      name: `writer-${i}`,
      type: 'writer',
      startHops: int(rng, 0, schedulerProfile.actorStartMaxHops + 6),
      flipTo: null,
      revokePrevious: false,
      shotId: uuid(rng),
      permitId: uuid(rng),
    });
  }

  return {
    seed,
    ownerA,
    ownerB,
    serverProfile,
    schedulerProfile,
    rows,
    actors,
    transportHasTrials: chance(rng, 0.8),
  };
}

function snapshotOutbox(): RowSnapshot[] {
  return seam
    .raw()
    .prepare(
      'SELECT id, owner_key, kind, payload, attempts, last_error FROM outbox ORDER BY id',
    )
    .all() as unknown as RowSnapshot[];
}

function snapshotReceipts(): Array<Record<string, unknown>> {
  return seam
    .raw()
    .prepare(
      'SELECT owner_key, kind, entity_id FROM sync_receipt ORDER BY rowid',
    )
    .all() as Array<Record<string, unknown>>;
}

function hasOpenTransaction(): boolean {
  const raw = seam.raw();
  try {
    raw.exec('BEGIN');
  } catch {
    return true;
  }
  raw.exec('ROLLBACK');
  return false;
}

function seedRows(rows: SeedRow[]): Map<number, RowSnapshot> {
  const raw = seam.raw();
  const insert = raw.prepare(
    `INSERT INTO outbox (owner_key, kind, payload, attempts, created_at)
     VALUES (?, ?, ?, ?, ?) RETURNING id`,
  );
  const byIndex = new Map<number, RowSnapshot>();
  for (const row of rows) {
    const params: SqlInputValue[] = [
      row.owner,
      row.kind,
      row.payload,
      row.attempts,
      row.createdAt,
    ];
    const inserted = insert.get(...params) as { id: number };
    byIndex.set(row.index, {
      id: inserted.id,
      owner_key: row.owner,
      kind: row.kind,
      payload: row.payload,
      attempts: row.attempts,
      last_error: null,
    });
  }
  return byIndex;
}

function entityIdOf(snapshot: RowSnapshot): string | null {
  try {
    const parsed = JSON.parse(snapshot.payload) as {
      id?: unknown;
      trialId?: unknown;
    } | null;
    if (!parsed || typeof parsed !== 'object') return null;
    if (snapshot.kind === 'evaluation.trial') {
      return typeof parsed.trialId === 'string' ? parsed.trialId : null;
    }
    return typeof parsed.id === 'string' ? parsed.id : null;
  } catch {
    return null;
  }
}

export async function runScenario(seed: number): Promise<ScenarioResult> {
  const plan = planScenario(seed);
  // Independent stream for runtime decisions so the plan is stable even if
  // the run consumes a different number of draws.
  const runRng = makePrng((seed ^ 0x9e3779b9) >>> 0);
  const scheduler = new Scheduler(runRng, plan.schedulerProfile);
  const profile = SERVER_PROFILES.find(p => p.name === plan.serverProfile)!;
  const server = new FakeServer(runRng, scheduler, profile);

  seam.attach(scheduler);
  seam.resetLog();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  let db: LocalDb = getDb();
  db.close();
  db = getDb();
  const byIndex = seedRows(plan.rows);
  const initialById = new Map<number, RowSnapshot>();
  for (const snap of byIndex.values()) initialById.set(snap.id, snap);
  const initialRowCount = initialById.size;

  const activatedOwners = new Set<string>([plan.ownerA]);
  /** Owners for which at least one drainOutbox actually started. */
  const drainedOwners = new Set<string>();
  setActiveDataOwner(plan.ownerA);
  const drainRejections: string[] = [];
  const writerRejections: string[] = [];
  const writerSucceeded: Array<{ owner: string; shotId: string }> = [];
  let ownerFlips = 0;
  let revocations = 0;
  const started = Date.now();

  const transports = new Map<string, ReturnType<FakeServer['transportFor']>>();
  const transportFor = (owner: string, actor: string) => {
    const key = `${owner}|${actor}`;
    let t = transports.get(key);
    if (!t) {
      t = server.transportFor(owner, actor);
      if (!plan.transportHasTrials) delete t.uploadEvaluationTrials;
      transports.set(key, t);
    }
    return t;
  };

  const runActor = async (actor: ActorPlan): Promise<void> => {
    await scheduler.hop(actor.startHops);
    if (actor.flipTo !== null) {
      const previous = getActiveDataOwner();
      ownerFlips += 1;
      if (actor.revokePrevious && previous !== SIGNED_OUT_DATA_OWNER) {
        server.revoke(previous);
        revocations += 1;
      }
      setActiveDataOwner(actor.flipTo);
      if (actor.flipTo !== SIGNED_OUT_DATA_OWNER) {
        server.restore(actor.flipTo);
        activatedOwners.add(actor.flipTo);
      }
    }
    const owner = getActiveDataOwner();
    const actorDb: LocalDb = {
      execute: (sql, params) => {
        seam.currentActor = actor.name;
        return db.execute(sql, params);
      },
      close: () => {},
    };
    if (actor.type === 'drain') {
      if (owner !== SIGNED_OUT_DATA_OWNER) drainedOwners.add(owner);
      try {
        await drainOutbox(actorDb, transportFor(owner, actor.name));
      } catch (error) {
        drainRejections.push(
          `${actor.name}@${owner.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
    }
    if (owner === SIGNED_OUT_DATA_OWNER) return;
    try {
      await saveAnalysis(
        actorDb,
        buildAnalysis(runRng, actor.shotId!, null),
        actor.permitId!,
      );
      writerSucceeded.push({ owner, shotId: actor.shotId! });
    } catch (error) {
      writerRejections.push(
        `${actor.name}@${owner.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const invariants: Record<string, boolean> = {};
  const violations: string[] = [];
  const check = (name: string, held: boolean, detail?: string) => {
    invariants[name] = (invariants[name] ?? true) && held;
    if (!held) violations.push(`${name}: ${detail ?? ''}`);
  };

  let deadlocked = false;
  try {
    await withDeadline(
      Promise.all(plan.actors.map(runActor)),
      ITERATION_DEADLINE_MS,
      `seed ${seed} burst`,
    );
  } catch (error) {
    deadlocked = true;
    violations.push(`boundedWallTime: ${String(error)}`);
  }
  invariants['boundedWallTime'] = !deadlocked;
  const burstStatements = seam.log.length;
  const burstStatementErrors = seam.log.filter(e => !e.ok);
  const burstNestedErrors = burstStatementErrors.filter(e =>
    /within a transaction/i.test(e.error ?? ''),
  ).length;
  const burstDrainRejected = drainRejections.length > 0;

  // ── Mid-burst invariants (after every actor settled) ─────────────────────
  const afterBurst = snapshotOutbox();
  const afterBurstById = new Map(afterBurst.map(r => [r.id, r] as const));
  const receipts = snapshotReceipts();
  const receiptKeys = new Set(
    receipts.map(r => `${String(r['owner_key'])}|${String(r['entity_id'])}`),
  );

  check('noOpenTransaction', !hasOpenTransaction(), 'a BEGIN was left open');

  const verdictsFor = (owner: string, id: string): VerdictClass[] =>
    server.calls
      .filter(c => c.owner === owner && c.verdicts[id] !== undefined)
      .map(c => c.verdicts[id] as VerdictClass);
  const sentIds = new Set(
    server.calls.map(c => c.ids.map(id => `${c.owner}|${id}`)).flat(),
  );

  for (const initial of initialById.values()) {
    const now = afterBurstById.get(initial.id);
    const seedRow = plan.rows.find(
      r => byIndex.get(r.index)?.id === initial.id,
    )!;
    const entityId = entityIdOf(initial);
    const key = `${initial.owner_key}|${entityId ?? ''}`;
    const touchedOwner = drainedOwners.has(initial.owner_key);

    if (!touchedOwner) {
      check(
        'ownerIsolation',
        now !== undefined &&
          now.attempts === initial.attempts &&
          now.last_error === null &&
          now.payload === initial.payload,
        `row ${initial.id} of never-active owner ${initial.owner_key} changed`,
      );
      check(
        'ownerIsolation',
        !sentIds.has(key) ||
          server.calls.every(
            c =>
              c.owner !== initial.owner_key || !c.ids.includes(entityId ?? ''),
          ),
        `row ${initial.id} of never-active owner reached the server`,
      );
    }

    if (seedRow.poison !== null) {
      check(
        'poisonNeverSent',
        entityId === null || !sentIds.has(key),
        `poison row ${initial.id} (${seedRow.poison}) was sent`,
      );
      check(
        'poisonNeverDeleted',
        now !== undefined,
        `poison row ${initial.id} (${seedRow.poison}) was deleted`,
      );
      if (
        now &&
        touchedOwner &&
        initial.attempts < OUTBOX_MAX_ATTEMPTS &&
        !burstDrainRejected &&
        (initial.kind !== 'evaluation.trial' || plan.transportHasTrials)
      ) {
        check(
          'poisonBurnsBudget',
          now.attempts > initial.attempts && now.last_error !== null,
          `poison row ${initial.id} attempts ${initial.attempts}→${now.attempts}`,
        );
      }
      continue;
    }

    const siblingEligible = plan.rows.some(
      r =>
        r.index !== seedRow.index &&
        r.entityId === entityId &&
        r.owner === initial.owner_key &&
        r.attempts < OUTBOX_MAX_ATTEMPTS,
    );
    if (initial.attempts >= OUTBOX_MAX_ATTEMPTS) {
      if (!siblingEligible) {
        check(
          'exhaustedNeverSent',
          !sentIds.has(key),
          `exhausted row ${initial.id} was sent`,
        );
      }
      check(
        'exhaustedUntouched',
        now !== undefined &&
          now.attempts === initial.attempts &&
          now.payload === initial.payload &&
          (siblingEligible || now.last_error === null),
        `exhausted row ${initial.id} changed`,
      );
      continue;
    }

    const verdicts = verdictsFor(initial.owner_key, entityId ?? '');
    const permanentVerdicts = verdicts.filter(
      v =>
        v === 'rejected_permanent' ||
        v === 'request_permanent' ||
        v === 'omitted',
    ).length;

    if (now === undefined) {
      // Row deleted ⇒ the server accepted this exact entity for this owner.
      if (initial.kind === 'shot.sync') {
        check(
          'deletedShotHasReceipt',
          receiptKeys.has(key),
          `shot row ${initial.id} deleted without sync_receipt`,
        );
        check(
          'deletedShotServerAccepted',
          server.accepted(initial.owner_key, entityId ?? ''),
          `shot row ${initial.id} deleted but server never accepted ${entityId}`,
        );
      } else if (initial.kind === 'session.create') {
        check(
          'deletedSessionServerAccepted',
          server.sessionsCreated.has(key),
          `session.create row ${initial.id} deleted but server never created ${entityId}`,
        );
      } else if (initial.kind === 'session.finalize') {
        check(
          'deletedSessionServerAccepted',
          server.sessionsFinalized.has(key),
          `session.finalize row ${initial.id} deleted but server never finalized ${entityId}`,
        );
      } else if (initial.kind === 'evaluation.trial') {
        check(
          'deletedTrialServerAccepted',
          server.trialsAccepted.has(key),
          `trial row ${initial.id} deleted but server never accepted ${entityId}`,
        );
      }
    } else {
      // Row survived ⇒ its attempt budget moved by exactly the permanent
      // verdicts it received (atomic `attempts = attempts + 1`, no lost
      // update) and never by a transient one.
      const delta = now.attempts - initial.attempts;
      const duplicates = plan.rows.filter(
        r => r.entityId === entityId && r.owner === initial.owner_key,
      ).length;
      check(
        'attemptsNeverOvercounted',
        delta <= permanentVerdicts,
        `row ${initial.id} (${initial.kind}) attempts Δ=${delta} > permanent verdicts=${permanentVerdicts} [${verdicts.join(',')}]`,
      );
      check(
        'transientNeverBurnsBudget',
        permanentVerdicts > 0 || delta === 0,
        `row ${initial.id} attempts Δ=${delta} with only transient verdicts [${verdicts.join(',')}]`,
      );
      if (duplicates === 1 && burstNestedErrors === 0 && !burstDrainRejected) {
        // Without a nested-transaction abort every permanent verdict must
        // have landed exactly once (no lost update between actors).
        check(
          'attemptsExactWithoutTxAbort',
          delta === permanentVerdicts,
          `row ${initial.id} (${initial.kind}) attempts Δ=${delta} but permanent verdicts=${permanentVerdicts} [${verdicts.join(',')}]`,
        );
      }
      if (initial.kind === 'shot.sync' && duplicates === 1) {
        check(
          'survivingShotHasNoReceipt',
          !receiptKeys.has(key) ||
            verdicts.some(v => v === 'accepted' || v === 'replay_accepted'),
          `shot row ${initial.id} still queued but has a receipt without any acceptance`,
        );
      }
    }
  }

  // Receipts only for shots the server accepted under that owner; never for
  // foreign ids the server slipped into acceptedIds.
  for (const receipt of receipts) {
    const owner = String(receipt['owner_key']);
    const entityId = String(receipt['entity_id']);
    check(
      'receiptOnlyForServerAccepted',
      server.accepted(owner, entityId),
      `receipt (${owner.slice(0, 8)}, ${entityId}) without server acceptance`,
    );
    check(
      'noForeignReceipt',
      !entityId.startsWith('foreign-'),
      `receipt for foreign id ${entityId}`,
    );
  }

  // Server-side spend: one permit → one shot, one shot charged once.
  const permitShots = new Map<string, Set<string>>();
  for (const [permitKey, shotId] of server.permits) {
    const set = permitShots.get(permitKey) ?? new Set<string>();
    set.add(shotId);
    permitShots.set(permitKey, set);
  }
  check(
    'noDoubleSpend',
    [...permitShots.values()].every(s => s.size === 1),
    'a permit was consumed by two shots',
  );

  // Writers: a rating persisted while drains ran must be on disk afterwards.
  for (const write of writerSucceeded) {
    const shot = seam
      .raw()
      .prepare(
        'SELECT count(*) AS n FROM local_shot WHERE owner_key = ? AND id = ?',
      )
      .get(write.owner, write.shotId) as { n: number };
    const queued = afterBurst.some(
      r => r.owner_key === write.owner && entityIdOf(r) === write.shotId,
    );
    const synced = receiptKeys.has(`${write.owner}|${write.shotId}`);
    check(
      'writerNoLostUpdate',
      shot.n === 1 && (queued || synced),
      `saveAnalysis(${write.shotId}) resolved but local_shot=${shot.n} queued=${queued} synced=${synced}`,
    );
  }
  const transactionCollisions = classifyCollisions(seam.log);
  check(
    'writerNeverFails',
    writerRejections.length === 0,
    `${writerRejections.join('; ')} [collisions: ${transactionCollisions.join(',')}]`,
  );
  check(
    'drainNeverRejects',
    drainRejections.length === 0,
    drainRejections.join('; '),
  );

  // Every outbox row that is new after the burst came from a writer that
  // resolved (no phantom rows), and every resolved writer left exactly one.
  const newRows = afterBurst.filter(r => !initialById.has(r.id));
  const newRowsUnsynced = newRows.length;
  const writerRowsSynced = writerSucceeded.filter(w =>
    receiptKeys.has(`${w.owner}|${w.shotId}`),
  ).length;
  check(
    'noPhantomRows',
    newRowsUnsynced + writerRowsSynced === writerSucceeded.length,
    `new rows=${newRowsUnsynced} synced writer rows=${writerRowsSynced} writers resolved=${writerSucceeded.length} (initial ${initialRowCount})`,
  );

  // ── Convergence: healthy server, sequential drains per activated owner ────
  server.forceHealthy = true;
  for (const owner of activatedOwners) server.restore(owner);
  let convergencePasses = 0;
  seam.currentActor = 'converge';
  if (!deadlocked) {
    for (const owner of activatedOwners) {
      setActiveDataOwner(owner);
      for (let pass = 0; pass < 12; pass += 1) {
        convergencePasses += 1;
        let result: { synced: number; failed: number; remaining: number };
        try {
          result = await withDeadline(
            drainOutbox(db, transportFor(owner, `converge-${pass}`)),
            ITERATION_DEADLINE_MS,
            `seed ${seed} convergence ${owner}`,
          );
        } catch (error) {
          check('convergenceDrainSettles', false, String(error));
          break;
        }
        const eligible = seam
          .raw()
          .prepare(
            'SELECT count(*) AS n FROM outbox WHERE owner_key = ? AND attempts < ?',
          )
          .get(owner, OUTBOX_MAX_ATTEMPTS) as { n: number };
        if (eligible.n === 0 || result.synced === 0) break;
      }
    }
  }
  const finalOutbox = snapshotOutbox();
  const finalReceipts = snapshotReceipts();
  const finalReceiptKeys = new Set(
    finalReceipts.map(
      r => `${String(r['owner_key'])}|${String(r['entity_id'])}`,
    ),
  );
  for (const row of finalOutbox) {
    if (!activatedOwners.has(row.owner_key)) continue;
    const seedRow = plan.rows.find(r => byIndex.get(r.index)?.id === row.id);
    const poison = seedRow?.poison !== null && seedRow !== undefined;
    const exhausted = row.attempts >= OUTBOX_MAX_ATTEMPTS;
    const trialWithoutTransport =
      row.kind === 'evaluation.trial' && !plan.transportHasTrials;
    check(
      'converges',
      poison || exhausted || trialWithoutTransport,
      `row ${row.id} (${row.kind}, attempts ${row.attempts}) still queued after healthy drains: ${row.last_error ?? ''}`,
    );
    if (poison) {
      check(
        'poisonStaysWithBoundedAttempts',
        row.attempts <= OUTBOX_MAX_ATTEMPTS + plan.actors.length,
        `poison row ${row.id} attempts ${row.attempts}`,
      );
    }
  }
  for (const seedRow of plan.rows) {
    if (seedRow.kind !== 'shot.sync' || seedRow.poison !== null) continue;
    if (!activatedOwners.has(seedRow.owner)) continue;
    const snap = byIndex.get(seedRow.index)!;
    const stillQueued = finalOutbox.find(r => r.id === snap.id);
    if (stillQueued) continue; // exhausted by permanent verdicts — by design
    check(
      'everyDrainedShotHasReceipt',
      finalReceiptKeys.has(`${seedRow.owner}|${seedRow.entityId}`),
      `shot ${seedRow.entityId} drained without receipt`,
    );
    check(
      'everyDrainedShotOnServer',
      server.accepted(seedRow.owner, seedRow.entityId),
      `shot ${seedRow.entityId} drained but not on server`,
    );
  }
  check(
    'integrityOk',
    (
      seam.raw().prepare('PRAGMA integrity_check').get() as {
        integrity_check: string;
      }
    ).integrity_check === 'ok',
    'PRAGMA integrity_check failed',
  );
  check(
    'noOpenTransactionAtEnd',
    !hasOpenTransaction(),
    'a BEGIN was left open',
  );

  const statementErrors = seam.log.filter(e => !e.ok);
  const nested = statementErrors.filter(e =>
    /within a transaction/i.test(e.error ?? ''),
  ).length;
  const rollbackNoTx = statementErrors.filter(e =>
    /no transaction is active/i.test(e.error ?? ''),
  ).length;
  let overshoot = 0;
  for (const row of finalOutbox) {
    overshoot = Math.max(overshoot, row.attempts - OUTBOX_MAX_ATTEMPTS);
  }

  const metrics: ScenarioMetrics = {
    drains: plan.actors.filter(a => a.type === 'drain').length,
    writers: plan.actors.filter(a => a.type === 'writer').length,
    ownerFlips,
    revocations,
    serverCalls: server.calls.length,
    statements: burstStatements,
    statementErrors: statementErrors.length,
    nestedTransactionErrors: nested,
    rollbackWithoutTransaction: rollbackNoTx,
    duplicateSends: server.duplicateSends(),
    overlappingDuplicateSends: server.overlappingDuplicateSends,
    drainRejections,
    writerRejections,
    transactionCollisions,
    attemptsOvershoot: Math.max(0, overshoot),
    hops: scheduler.hops,
    convergencePasses,
    wallMs: Date.now() - started,
  };

  const failed = Object.entries(invariants)
    .filter(([, held]) => !held)
    .map(([name]) => name);
  const knownDefects = failed.filter(name => KNOWN_DEFECT_INVARIANTS.has(name));
  const result: ScenarioResult = {
    seed,
    ok: failed.length === knownDefects.length,
    failed,
    knownDefects,
    invariants,
    metrics,
    plan,
  };
  if (failed.length > 0) {
    result.detail = {
      violations,
      finalOutbox,
      finalReceipts,
      serverCalls: server.calls,
      statementLog: seam.log.map(e => ({
        seq: e.seq,
        actor: e.actor,
        sql: e.sql.replace(/\s+/g, ' ').trim().slice(0, 120),
        ok: e.ok,
        ...(e.error ? { error: e.error } : {}),
      })),
    };
  }
  db.close();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  return result;
}
