/**
 * Failure-injection campaign for `src/data/repository.ts` + `accountScope.ts`.
 *
 * One iteration = one seeded (operation, owner state, pre-seeded world,
 * fault) tuple run against real SQLite through the production `getDb()`:
 *
 *   1. open a fresh migrated DB, seed it from the iteration's PRNG, snapshot
 *      `pre`, run the operation WITHOUT a fault → `cleanResult`, `post`
 *      snapshot, statement count; close.
 *   2. open a second fresh DB, seed IDENTICALLY, arm the fault at a seeded
 *      statement index, run the operation → outcome; evaluate invariants
 *      against `pre` / `post` / `cleanResult`.
 *
 * Invariants (every one is a HELD/BROKEN classification):
 *   settled            the promise settled (60 s of fake time allowed)
 *   honestOutcome      a fired throw/reject fault ⇒ the op rejected (no fake
 *                      success); an unfired fault ⇒ the op resolved
 *   errorSurfaced      the rejection IS the injected error (not swallowed or
 *                      replaced), or the op's own validation error
 *   stateIntact        persisted state after the op is exactly `pre` or
 *                      exactly `post` — never a torn mixture
 *   noTornWrite        referential invariants across tables hold
 *   autocommitAfter    the connection is not left inside a transaction
 *   otherOwnerUntouched owner B's bucket is byte-identical to before
 *   ownerScoped        every id a read returned belongs to the active owner
 *   noFabrication      read results carry no NaN / 'undefined' / non-string id
 *   resultMatchesClean an op that resolved returned the clean result (reads
 *                      under delete-during may return a subset)
 *   usableAfter        after the fault, a clean write + read on the same
 *                      connection succeeds (recoverable state)
 */
import type { ShotAnalysis } from '@pickle/shared-types';
import type { LocalDb } from '../../src/data/db';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import * as repo from '../../src/data/repository';
import type { SqliteDatabaseSync } from '../../xc-harness/lifecycle-persistence/nodeShim';
import { makePrng, pick } from '../../xc-harness/lifecycle-persistence/seeds';
import type { MatrixRow } from '../../xc-harness/lifecycle-persistence/artifacts';
import {
  FAULT_KINDS,
  FaultyLocalDb,
  InjectedSqliteError,
  SQLITE_ERROR_CODES,
  statementVerbs,
  type Fault,
  type FaultKind,
} from './faultyDb';
import {
  OWNER_A,
  OWNER_B,
  OWNER_GUEST,
  PAYLOAD_CORRUPTION_NAMES,
  int,
  isoAt,
  makeAnalysis,
  makeClip,
  makePermitId,
  makeSession,
  plantCorruptAnalysisRecord,
  plantCorruptCapture,
  plantCorruptShot,
  seedShots,
  uuid,
  type Rng,
  type SeededShot,
} from './fixtures';
import {
  countRows,
  forceAutocommit,
  inAutocommit,
  openMigratedDb,
  opSqliteShim,
  sameSnapshot,
  snapshotAll,
  snapshotOwner,
  tornWrites,
  type RealDbHandle,
  type TableSnapshot,
} from './realSqlite';

// ─── World ───────────────────────────────────────────────────────────────────

export interface World {
  seed: number;
  activeOwner: string;
  shotsA: SeededShot[];
  shotsB: SeededShot[];
  captureIdsA: string[];
  captureIdsB: string[];
  sessionIdsA: string[];
  outboxShotIdsA: string[];
  corruptShotIds: string[];
  corruptCaptureIds: string[];
  corruptions: string[];
}

/** Deterministic world for a seed: same seed ⇒ byte-identical rows. */
export function buildWorld(
  raw: SqliteDatabaseSync,
  db: LocalDb,
  seed: number,
  scale: { maxShots: number },
): Promise<World> {
  return buildWorldWith(raw, db, seed, scale);
}

async function buildWorldWith(
  raw: SqliteDatabaseSync,
  db: LocalDb,
  seed: number,
  scale: { maxShots: number },
): Promise<World> {
  const rng = makePrng(seed ^ 0x5eed);
  const activeOwner = pick(rng, [OWNER_A, OWNER_A, OWNER_A, OWNER_GUEST]);
  const countA = int(rng, 0, scale.maxShots);
  const countB = int(rng, 0, Math.max(1, Math.floor(scale.maxShots / 2)));
  const sessionIdsA = [uuid(rng), uuid(rng)];
  const shotsA = seedShots(raw, activeOwner, countA, rng, {
    duplicateEvery: rng() < 0.3 ? int(rng, 3, 9) : undefined,
    sessionIds: rng() < 0.5 ? sessionIdsA : undefined,
  });
  const shotsB = seedShots(raw, OWNER_B, countB, rng);

  // Owner-scoped rows the single-statement operations need to exist.
  setActiveDataOwner(activeOwner);
  const captureIdsA: string[] = [];
  for (let i = 0; i < int(rng, 1, 3); i++) {
    const id = uuid(rng);
    await repo.savePendingCapture(
      db,
      id,
      pick(rng, ['dink', 'serve']),
      makeClip(rng),
    );
    captureIdsA.push(id);
  }
  await repo.saveSession(db, {
    ...makeSession(rng, 'practice_set'),
    id: sessionIdsA[0] as string,
  });
  await repo.saveSession(db, {
    ...makeSession(rng, 'live_court'),
    id: sessionIdsA[1] as string,
  });
  await repo.finishSession(db, sessionIdsA[1] as string, {
    points: int(rng, 0, 11),
  });
  const outboxShotIdsA: string[] = [];
  const outboxCount = int(rng, 0, 2);
  for (let i = 0; i < outboxCount; i++) {
    const analysis = makeAnalysis(rng, { resultKind: 'scored' });
    await repo.saveAnalysis(db, analysis, makePermitId(rng));
    outboxShotIdsA.push(analysis.id);
  }
  await repo.setKv(db, `profile:${activeOwner}`, JSON.stringify({ name: 'A' }));

  setActiveDataOwner(OWNER_B);
  const captureIdsB: string[] = [];
  const idB = uuid(rng);
  await repo.savePendingCapture(db, idB, 'dink', makeClip(rng));
  captureIdsB.push(idB);
  await repo.setKv(db, `profile:${OWNER_B}`, JSON.stringify({ name: 'B' }));

  // Persisted corruption (owner A) — realistic: torn writes, older builds.
  const corruptShotIds: string[] = [];
  const corruptCaptureIds: string[] = [];
  const corruptions: string[] = [];
  const corruptCount = int(rng, 0, 2);
  for (let i = 0; i < corruptCount; i++) {
    const name = pick(rng, PAYLOAD_CORRUPTION_NAMES);
    if (name === 'huge-1mb' || name === 'deep-nesting') continue;
    const id = uuid(rng);
    plantCorruptShot(
      raw,
      activeOwner,
      id,
      name,
      rng() < 0.7 ? 'scored' : 'low_confidence',
    );
    corruptShotIds.push(id);
    corruptions.push(`shot:${name}`);
    if (rng() < 0.3) {
      const captureId = uuid(rng);
      plantCorruptCapture(
        raw,
        activeOwner,
        captureId,
        rng() < 0.3 ? 'null-payload' : name,
      );
      corruptCaptureIds.push(captureId);
      corruptions.push(`capture:${name}`);
    }
    if (rng() < 0.3) {
      plantCorruptAnalysisRecord(
        raw,
        activeOwner,
        captureIdsA[0] as string,
        name,
        uuid(rng),
      );
      corruptions.push(`record:${name}`);
    }
  }
  setActiveDataOwner(activeOwner);
  return {
    seed,
    activeOwner,
    shotsA,
    shotsB,
    captureIdsA,
    captureIdsB,
    sessionIdsA,
    outboxShotIdsA,
    corruptShotIds,
    corruptCaptureIds,
    corruptions,
  };
}

// ─── Operations ──────────────────────────────────────────────────────────────

export type OpKind = 'read' | 'write' | 'validation';

export interface Operation {
  name: string;
  kind: OpKind;
  transactional: boolean;
  /** Seeded arguments; must not touch the DB. */
  args(rng: Rng, world: World): unknown[];
  run(db: LocalDb, args: unknown[]): Promise<unknown>;
  /** Ids a read returned, for the ownerScoped invariant. */
  idsOf?(result: unknown): string[];
  /** Shape check of a resolved result. Returns problems. */
  validate?(result: unknown): string[];
}

const finiteOrNull = (v: unknown): boolean =>
  v === null || (typeof v === 'number' && Number.isFinite(v));
const realId = (v: unknown): boolean =>
  typeof v === 'string' && v.length > 0 && v !== 'undefined' && v !== 'null';

function validateShotRows(result: unknown): string[] {
  const problems: string[] = [];
  for (const row of result as repo.LocalShotRow[]) {
    if (!realId(row.id)) problems.push(`id=${String(row.id)}`);
    if (!finiteOrNull(row.overallScore))
      problems.push(`overallScore=${String(row.overallScore)}`);
    if (!Number.isFinite(row.confidence))
      problems.push(`confidence=${String(row.confidence)}`);
    if (row.source !== 'real') problems.push(`source=${row.source}`);
  }
  return problems;
}

function validateFacts(result: unknown): string[] {
  const problems: string[] = [];
  for (const fact of result as repo.RealAnalysisFact[]) {
    if (!realId(fact.id)) problems.push(`fact.id=${String(fact.id)}`);
    if (!realId(fact.shotType))
      problems.push(`fact.shotType=${String(fact.shotType)}`);
    if (!finiteOrNull(fact.overallScore))
      problems.push(`fact.overallScore=${String(fact.overallScore)}`);
    if (
      typeof fact.confidence !== 'number' ||
      !Number.isFinite(fact.confidence)
    )
      problems.push(`fact.confidence=${String(fact.confidence)}`);
    if (fact.resultKind !== 'scored' && fact.resultKind !== 'low_confidence')
      problems.push(`fact.resultKind=${String(fact.resultKind)}`);
    if (typeof fact.scoringModelVersion !== 'string')
      problems.push(
        `fact.scoringModelVersion=${String(fact.scoringModelVersion)}`,
      );
    for (const [key, score] of Object.entries(fact.checkpointScores)) {
      if (!Number.isFinite(score))
        problems.push(`checkpoint ${key}=${String(score)}`);
    }
  }
  return problems;
}

function validateCheckpointFacts(result: unknown): string[] {
  const problems: string[] = [];
  for (const fact of result as Array<{
    id: string;
    shotType: string;
    checkpoints: { key: string; score: number | null; applicable: boolean }[];
  }>) {
    if (!realId(fact.id)) problems.push(`cp.id=${String(fact.id)}`);
    if (!realId(fact.shotType))
      problems.push(`cp.shotType=${String(fact.shotType)}`);
    for (const cp of fact.checkpoints) {
      if (!realId(cp.key)) problems.push(`cp.key=${String(cp.key)}`);
      if (!finiteOrNull(cp.score))
        problems.push(`cp.score=${String(cp.score)}`);
    }
  }
  return problems;
}

function validateCaptures(result: unknown): string[] {
  const problems: string[] = [];
  const list = Array.isArray(result) ? result : result === null ? [] : [result];
  for (const cap of list as repo.PendingCapture[]) {
    if (!realId(cap.id)) problems.push(`capture.id=${String(cap.id)}`);
    if (!Number.isFinite(cap.durationMs))
      problems.push(`durationMs=${String(cap.durationMs)}`);
    if (cap.evidenceStatus === 'valid' && cap.clip === null)
      problems.push('valid without clip');
    if (cap.evidenceStatus !== 'valid' && cap.clip !== null)
      problems.push('clip without valid');
  }
  return problems;
}

function validateAnalysis(result: unknown): string[] {
  if (result === null) return [];
  const a = result as ShotAnalysis;
  const problems: string[] = [];
  if (typeof a !== 'object') return [`analysis is ${typeof a}`];
  if (!realId(a.id)) problems.push(`analysis.id=${String(a.id)}`);
  if (a.source !== 'real') problems.push(`analysis.source=${String(a.source)}`);
  return problems;
}

const idsOfRows = (result: unknown): string[] =>
  (result as { id: string }[]).map(r => r.id);

export const OPERATIONS: Operation[] = [
  // ── transactional writes ──
  {
    name: 'saveAnalysis(scored)',
    kind: 'write',
    transactional: true,
    args: rng => [
      makeAnalysis(rng, { resultKind: 'scored' }),
      makePermitId(rng),
    ],
    run: (db, [a, p]) => repo.saveAnalysis(db, a as ShotAnalysis, p as string),
  },
  {
    name: 'saveAnalysis(low_confidence)',
    kind: 'write',
    transactional: true,
    args: rng => [
      makeAnalysis(rng, { resultKind: 'low_confidence' }),
      makePermitId(rng),
    ],
    run: (db, [a, p]) => repo.saveAnalysis(db, a as ShotAnalysis, p as string),
  },
  {
    name: 'saveAnalysis(duplicate-id)',
    kind: 'write',
    transactional: true,
    args: (rng, world) => [
      makeAnalysis(rng, {
        resultKind: 'scored',
        id:
          world.shotsA.length > 0
            ? (pick(rng, world.shotsA) as SeededShot).analysis.id
            : uuid(rng),
      }),
      makePermitId(rng),
    ],
    run: (db, [a, p]) => repo.saveAnalysis(db, a as ShotAnalysis, p as string),
  },
  {
    name: 'saveSession',
    kind: 'write',
    transactional: true,
    args: rng => [makeSession(rng)],
    run: (db, [s]) => repo.saveSession(db, s as ReturnType<typeof makeSession>),
  },
  {
    name: 'finishSession',
    kind: 'write',
    transactional: true,
    args: (rng, world) => [world.sessionIdsA[0], { shots: int(rng, 0, 20) }],
    run: (db, [id, s]) =>
      repo.finishSession(db, id as string, s as Record<string, unknown>),
  },
  {
    name: 'purgeOwnerData(active)',
    kind: 'write',
    transactional: true,
    args: (_rng, world) => [world.activeOwner],
    run: (db, [o]) => repo.purgeOwnerData(db, o as string),
  },
  // ── single-statement writes ──
  {
    name: 'saveLocalOnlyAnalysis',
    kind: 'write',
    transactional: false,
    args: rng => [makeAnalysis(rng, { resultKind: 'low_confidence' })],
    run: (db, [a]) => repo.saveLocalOnlyAnalysis(db, a as ShotAnalysis),
  },
  {
    name: 'savePendingCapture',
    kind: 'write',
    transactional: false,
    args: rng => [uuid(rng), pick(rng, ['dink', 'serve']), makeClip(rng)],
    run: (db, [id, t, c]) =>
      repo.savePendingCapture(
        db,
        id as string,
        t as string,
        c as ReturnType<typeof makeClip>,
      ),
  },
  {
    name: 'saveAnalysisRecord',
    kind: 'write',
    transactional: false,
    args: (rng, world) => [
      {
        schemaVersion: 1,
        id: uuid(rng),
        captureId: world.captureIdsA[0],
        createdAtIso: isoAt(int(rng, 0, 1000)),
        engineVersion: 'engine-1',
        result: null,
      },
    ],
    run: (db, [r]) =>
      repo.saveAnalysisRecord(
        db,
        r as unknown as Parameters<typeof repo.saveAnalysisRecord>[1],
      ),
  },
  {
    name: 'setDeclaredStroke',
    kind: 'write',
    transactional: false,
    args: (rng, world) => [
      pick(rng, world.captureIdsA),
      pick(rng, ['dink', 'serve'] as const),
    ],
    run: (db, [id, s]) => repo.setDeclaredStroke(db, id as string, s as 'dink'),
  },
  {
    name: 'setCaptureTargetSeed',
    kind: 'write',
    transactional: false,
    args: (rng, world) => [
      pick(rng, world.captureIdsA),
      { point: { x: rng(), y: rng() }, selectedAtIso: isoAt(1) },
    ],
    run: (db, [id, s]) =>
      repo.setCaptureTargetSeed(db, id as string, s as repo.CaptureTargetSeed),
  },
  {
    name: 'updateCaptureClipPayload',
    kind: 'write',
    transactional: false,
    args: (rng, world) => [pick(rng, world.captureIdsA), makeClip(rng)],
    run: (db, [id, c]) =>
      repo.updateCaptureClipPayload(
        db,
        id as string,
        c as ReturnType<typeof makeClip>,
      ),
  },
  {
    name: 'markCaptureAnalyzed',
    kind: 'write',
    transactional: false,
    args: (rng, world) => [pick(rng, world.captureIdsA)],
    run: (db, [id]) => repo.markCaptureAnalyzed(db, id as string),
  },
  {
    name: 'setKv',
    kind: 'write',
    transactional: false,
    args: (rng, world) => [
      `consistency:${world.activeOwner}`,
      JSON.stringify({ n: int(rng, 0, 9) }),
    ],
    run: (db, [k, v]) => repo.setKv(db, k as string, v as string),
  },
  // ── validation rejections (must fail before any statement) ──
  {
    name: 'saveAnalysis(fixture-source)',
    kind: 'validation',
    transactional: true,
    args: rng => [makeAnalysis(rng, { source: 'fixture' }), makePermitId(rng)],
    run: (db, [a, p]) => repo.saveAnalysis(db, a as ShotAnalysis, p as string),
  },
  {
    name: 'saveAnalysis(blank-permit)',
    kind: 'validation',
    transactional: true,
    args: rng => [makeAnalysis(rng), pick(rng, ['', '   ', '\n'])],
    run: (db, [a, p]) => repo.saveAnalysis(db, a as ShotAnalysis, p as string),
  },
  {
    name: 'saveLocalOnlyAnalysis(scored)',
    kind: 'validation',
    transactional: false,
    args: rng => [makeAnalysis(rng, { resultKind: 'scored' })],
    run: (db, [a]) => repo.saveLocalOnlyAnalysis(db, a as ShotAnalysis),
  },
  {
    name: 'listRealAnalysisFacts(bad-limit)',
    kind: 'validation',
    transactional: false,
    args: rng => [
      pick(rng, [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]),
    ],
    run: (db, [l]) => repo.listRealAnalysisFacts(db, l as number),
  },
  {
    name: 'listCaptureHistory(bad-limit)',
    kind: 'validation',
    transactional: false,
    args: rng => [pick(rng, [0, -5, 2.5, Number.POSITIVE_INFINITY])],
    run: (db, [l]) => repo.listCaptureHistory(db, l as number),
  },
  // ── reads ──
  {
    name: 'listShots',
    kind: 'read',
    transactional: false,
    args: rng => [pick(rng, [1, 5, 50, 10_000])],
    run: (db, [l]) => repo.listShots(db, l as number),
    idsOf: idsOfRows,
    validate: validateShotRows,
  },
  {
    name: 'listActivityShots',
    kind: 'read',
    transactional: false,
    args: () => [],
    run: db => repo.listActivityShots(db),
    idsOf: idsOfRows,
    validate: result => {
      const problems: string[] = [];
      for (const row of result as repo.ActivityShotRow[]) {
        if (!realId(row.id)) problems.push(`id=${String(row.id)}`);
        if (!finiteOrNull(row.overallScore))
          problems.push(`overallScore=${String(row.overallScore)}`);
      }
      return problems;
    },
  },
  {
    name: 'getAnalysis',
    kind: 'read',
    transactional: false,
    args: (rng, world) => [
      world.shotsA.length > 0 && rng() < 0.7
        ? (pick(rng, world.shotsA) as SeededShot).analysis.id
        : world.shotsB.length > 0 && rng() < 0.5
          ? (pick(rng, world.shotsB) as SeededShot).analysis.id
          : uuid(rng),
    ],
    run: (db, [id]) => repo.getAnalysis(db, id as string),
    idsOf: result => (result ? [(result as ShotAnalysis).id] : []),
    validate: validateAnalysis,
  },
  {
    name: 'recentScores',
    kind: 'read',
    transactional: false,
    args: rng => [
      rng() < 0.5 ? null : pick(rng, ['dink', 'serve', 'forehand_drive']),
      int(rng, 1, 40),
    ],
    run: (db, [t, l]) => repo.recentScores(db, t as string | null, l as number),
    validate: result =>
      (result as number[])
        .filter(v => !Number.isFinite(v))
        .map(v => `score=${String(v)}`),
  },
  {
    name: 'listRealAnalysisFacts',
    kind: 'read',
    transactional: false,
    args: rng => [pick(rng, [null, 10, 1000])],
    run: (db, [l]) => repo.listRealAnalysisFacts(db, l as number | null),
    idsOf: idsOfRows,
    validate: validateFacts,
  },
  {
    name: 'listScoredCheckpointFacts',
    kind: 'read',
    transactional: false,
    args: rng => [int(rng, 1, 200)],
    run: (db, [l]) => repo.listScoredCheckpointFacts(db, l as number),
    idsOf: idsOfRows,
    validate: validateCheckpointFacts,
  },
  {
    name: 'getPendingCapture',
    kind: 'read',
    transactional: false,
    args: (rng, world) => [
      rng() < 0.8 ? pick(rng, world.captureIdsA) : pick(rng, world.captureIdsB),
    ],
    run: (db, [id]) => repo.getPendingCapture(db, id as string),
    idsOf: result => (result ? [(result as repo.PendingCapture).id] : []),
    validate: validateCaptures,
  },
  {
    name: 'listPendingCaptures',
    kind: 'read',
    transactional: false,
    args: rng => [pick(rng, [null, 1, 100])],
    run: (db, [l]) => repo.listPendingCaptures(db, l as number | null),
    idsOf: idsOfRows,
    validate: validateCaptures,
  },
  {
    name: 'listCaptureHistory',
    kind: 'read',
    transactional: false,
    args: rng => [pick(rng, [null, 2, 50])],
    run: (db, [l]) => repo.listCaptureHistory(db, l as number | null),
    idsOf: idsOfRows,
    validate: validateCaptures,
  },
  {
    name: 'listAnalysisRecords',
    kind: 'read',
    transactional: false,
    args: (rng, world) => [pick(rng, world.captureIdsA)],
    run: (db, [id]) => repo.listAnalysisRecords(db, id as string),
    validate: result =>
      (result as unknown[])
        .filter(r => r === null || typeof r !== 'object')
        .map(r => `record=${String(r)}`),
  },
  {
    name: 'getCaptureTargetSeed',
    kind: 'read',
    transactional: false,
    args: (rng, world) => [pick(rng, world.captureIdsA)],
    run: (db, [id]) => repo.getCaptureTargetSeed(db, id as string),
  },
  {
    name: 'listLiveSessionHistory',
    kind: 'read',
    transactional: false,
    args: rng => [int(rng, 1, 60)],
    run: (db, [l]) => repo.listLiveSessionHistory(db, l as number),
    idsOf: idsOfRows,
  },
  {
    name: 'hasShotSyncReceipt',
    kind: 'read',
    transactional: false,
    args: (rng, world) => [
      world.shotsA.length > 0
        ? (pick(rng, world.shotsA) as SeededShot).analysis.id
        : uuid(rng),
    ],
    run: (db, [id]) => repo.hasShotSyncReceipt(db, id as string),
  },
  {
    name: 'getShotOutboxStatus',
    kind: 'read',
    transactional: false,
    args: (rng, world) => [
      world.outboxShotIdsA.length > 0 && rng() < 0.7
        ? pick(rng, world.outboxShotIdsA)
        : uuid(rng),
    ],
    run: (db, [id]) => repo.getShotOutboxStatus(db, id as string),
    validate: result => {
      const status = result as repo.ShotOutboxStatus;
      if (status.state === 'absent') return [];
      return Number.isFinite(status.attempts)
        ? []
        : [`attempts=${String(status.attempts)}`];
    },
  },
  {
    name: 'getKv',
    kind: 'read',
    transactional: false,
    args: (rng, world) => [
      pick(rng, [
        `profile:${world.activeOwner}`,
        `profile:${OWNER_B}`,
        'missing',
      ]),
    ],
    run: (db, [k]) => repo.getKv(db, k as string),
  },
];

export const OPERATIONS_BY_NAME = new Map(OPERATIONS.map(op => [op.name, op]));

// ─── Faults ──────────────────────────────────────────────────────────────────

export interface FaultSpec {
  kind: FaultKind;
  /** Statement index the fault targets (may equal the clean statement count
   * ⇒ control iteration where the fault never fires). */
  atStatement: number;
  code: (typeof SQLITE_ERROR_CODES)[number];
  delayMs: number;
  /** Also fail the ROLLBACK the repository issues after the primary fault. */
  rollbackAlsoFails: boolean;
  swapTo?: string;
}

export function faultFromSpec(spec: FaultSpec, world: World): Fault {
  const primary: Fault = {
    kind: spec.kind,
    match: null,
    atMatch: spec.atStatement,
    code: spec.code,
    delayMs: spec.delayMs,
    swapTo: spec.swapTo,
    deleteSql: [
      `DELETE FROM local_shot WHERE owner_key = '${world.activeOwner}'`,
      `DELETE FROM local_capture WHERE owner_key = '${world.activeOwner}'`,
      `DELETE FROM outbox WHERE owner_key = '${world.activeOwner}'`,
    ],
  };
  if (spec.rollbackAlsoFails) {
    primary.then = {
      kind: 'reject',
      match: /^\s*ROLLBACK/i,
      atMatch: 0,
      code: 'SQLITE_LOCKED',
      delayMs: 0,
    };
  }
  return primary;
}

export function seededFault(rng: Rng, cleanStatements: number): FaultSpec {
  const kind = pick(
    rng,
    FAULT_KINDS.filter(k => k !== 'never' && k !== 'slow'),
  );
  return {
    kind,
    atStatement: int(rng, 0, cleanStatements),
    code: pick(rng, SQLITE_ERROR_CODES),
    delayMs: 0,
    rollbackAlsoFails: rng() < 0.25,
    swapTo:
      kind === 'owner-swap'
        ? pick(rng, [OWNER_B, SIGNED_OUT_DATA_OWNER, GUEST_DATA_OWNER])
        : undefined,
  };
}

// ─── Iteration ───────────────────────────────────────────────────────────────

export interface IterationInputs {
  seed: number;
  operation: string;
  args: unknown[];
  fault: FaultSpec;
  world: {
    activeOwner: string;
    shotsA: number;
    shotsB: number;
    corruptions: string[];
  };
}

export interface CleanRun {
  statements: number;
  verbs: string[];
  result: unknown;
  rejected: string | null;
  pre: TableSnapshot;
  post: TableSnapshot;
  preB: TableSnapshot;
}

/** Timestamp defaults (`datetime('now')`) differ across the two DB opens of
 * one iteration; mask them so snapshots compare structurally. */
export function maskTimestamps(snapshot: TableSnapshot): TableSnapshot {
  const masked: TableSnapshot = {};
  for (const [table, rows] of Object.entries(snapshot)) {
    masked[table] = rows
      .map(row =>
        row.replace(
          /\["(created_at|accepted_at|ended_at)","[^"]*"\]/g,
          '["$1","<ts>"]',
        ),
      )
      .sort();
  }
  return masked;
}

/** Same masking for read results: `finishSession` stamps `ended_at` with
 * `datetime('now')`, so the clean and faulted worlds differ by the wall clock
 * whenever a second boundary falls between their builds. */
export function maskClockFields(value: unknown): string {
  return JSON.stringify(value).replace(
    /"(endedAt|acceptedAt|createdAt)":"[^"]*"/g,
    '"$1":"<ts>"',
  );
}

export function snapshotDiff(
  a: TableSnapshot,
  b: TableSnapshot,
): Record<string, { onlyA: string[]; onlyB: string[] }> {
  const diff: Record<string, { onlyA: string[]; onlyB: string[] }> = {};
  for (const table of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const rowsA = new Set(a[table] ?? []);
    const rowsB = new Set(b[table] ?? []);
    const onlyA = [...rowsA].filter(r => !rowsB.has(r)).slice(0, 2);
    const onlyB = [...rowsB].filter(r => !rowsA.has(r)).slice(0, 2);
    if (onlyA.length > 0 || onlyB.length > 0) diff[table] = { onlyA, onlyB };
  }
  return diff;
}

export interface Harness {
  getDb: () => LocalDb;
  /** Advances fake timers when the iteration uses `slow`/`never`. */
  advance?: (ms: number) => Promise<void>;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

async function settle<T>(
  promise: Promise<T>,
  harness: Harness,
  needsTimers: boolean,
): Promise<{
  settled: boolean;
  resolved: boolean;
  value?: T;
  error?: unknown;
}> {
  let outcome: {
    settled: boolean;
    resolved: boolean;
    value?: T;
    error?: unknown;
  } = {
    settled: false,
    resolved: false,
  };
  const tracked = promise.then(
    value => {
      outcome = { settled: true, resolved: true, value };
    },
    error => {
      outcome = { settled: true, resolved: false, error };
    },
  );
  if (needsTimers && harness.advance) {
    await harness.advance(60_000);
  }
  // Let every chained microtask of the operation run to completion.
  for (let i = 0; i < 512 && !outcome.settled; i++) await Promise.resolve();
  if (!needsTimers) await tracked;
  return outcome;
}

export async function runClean(
  harness: Harness,
  seed: number,
  op: Operation,
  scale: { maxShots: number },
): Promise<{ clean: CleanRun; args: unknown[]; world: World }> {
  const handle = openMigratedDb(harness.getDb);
  try {
    const world = await buildWorld(handle.raw, handle.db, seed, scale);
    const args = op.args(makePrng(seed ^ 0xa465), world);
    const pre = snapshotAll(handle.raw);
    const preB = snapshotOwner(handle.raw, OWNER_B);
    const proxy = new FaultyLocalDb(handle.db, handle.raw, {
      setOwner: setActiveDataOwner,
    });
    let result: unknown = undefined;
    let rejected: string | null = null;
    try {
      result = await op.run(proxy, args);
    } catch (error) {
      rejected = errorText(error);
    }
    const post = snapshotAll(handle.raw);
    return {
      clean: {
        statements: proxy.statements.length,
        verbs: statementVerbs(proxy.statements),
        result,
        rejected,
        pre,
        post,
        preB,
      },
      args,
      world,
    };
  } finally {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    handle.close();
  }
}

export interface IterationOptions {
  scale: { maxShots: number };
  faultFor: (rng: Rng, clean: CleanRun) => FaultSpec;
  operation?: Operation;
}

export async function runIteration(
  harness: Harness,
  seed: number,
  options: IterationOptions,
): Promise<MatrixRow> {
  const startedAt = Date.now();
  const rng = makePrng(seed);
  const op = options.operation ?? pick(rng, OPERATIONS);
  const { clean, args, world } = await runClean(
    harness,
    seed,
    op,
    options.scale,
  );
  const fault = options.faultFor(makePrng(seed ^ 0xfa17), clean);
  const inputs: IterationInputs = {
    seed,
    operation: op.name,
    args,
    fault,
    world: {
      activeOwner: world.activeOwner,
      shotsA: world.shotsA.length,
      shotsB: world.shotsB.length,
      corruptions: world.corruptions,
    },
  };

  const handle: RealDbHandle = openMigratedDb(harness.getDb);
  const invariants: Record<string, boolean> = {};
  const observed: Record<string, unknown> = {};
  try {
    const world2 = await buildWorld(handle.raw, handle.db, seed, options.scale);
    const pre2 = snapshotAll(handle.raw);
    invariants['deterministicWorld'] = sameSnapshot(
      maskTimestamps(pre2),
      maskTimestamps(clean.pre),
    );
    if (!invariants['deterministicWorld']) {
      observed['worldDiff'] = snapshotDiff(
        maskTimestamps(clean.pre),
        maskTimestamps(pre2),
      );
    }
    setActiveDataOwner(world2.activeOwner);

    const proxy = new FaultyLocalDb(handle.db, handle.raw, {
      setOwner: setActiveDataOwner,
    });
    proxy.arm(faultFromSpec(fault, world2));

    const needsTimers = fault.kind === 'slow' || fault.kind === 'never';
    const outcome = await settle(op.run(proxy, args), harness, needsTimers);
    const fired = proxy.fired !== null;
    const rollbackFailed = fault.rollbackAlsoFails && proxy.firedCount > 1;
    // "BEGIN applied but reported failed" cannot happen with an in-process
    // SQLite driver (BEGIN is atomic and its return code IS the outcome);
    // recorded as an observation like a failed ROLLBACK, not judged.
    const beginLostAck =
      fired &&
      fault.kind === 'reject-after-apply' &&
      /^\s*BEGIN/i.test(proxy.fired?.sql ?? '');
    const lowRealism = rollbackFailed || beginLostAck;
    // After close-during the primary connection is gone; inspect the file
    // through a second connection (what a relaunch would see).
    const inspect = proxy.isClosed ? handle.reopen() : handle.raw;
    const after = snapshotAll(inspect);
    const afterB = snapshotOwner(inspect, OWNER_B);
    const torn = tornWrites(inspect);
    const rejectionIsInjected =
      outcome.error instanceof InjectedSqliteError &&
      !/ROLLBACK/.test(outcome.error.message);

    observed['fired'] = fired;
    observed['rollbackFailed'] = rollbackFailed;
    observed['beginLostAck'] = beginLostAck;
    observed['firedOn'] =
      proxy.fired?.sql.trim().split(/\s+/).slice(0, 3).join(' ') ?? null;
    observed['statements'] = statementVerbs(proxy.statements);
    observed['cleanStatements'] = clean.verbs;
    observed['settled'] = outcome.settled;
    observed['resolved'] = outcome.resolved;
    observed['error'] =
      outcome.error === undefined ? null : errorText(outcome.error);
    observed['cleanRejected'] = clean.rejected;
    observed['torn'] = torn;
    const afterMasked = maskTimestamps(after);
    const equalsPre = sameSnapshot(afterMasked, maskTimestamps(pre2));
    const equalsPost = sameSnapshot(afterMasked, maskTimestamps(clean.post));
    observed['stateEquals'] =
      equalsPre && equalsPost
        ? 'pre=post'
        : equalsPre
          ? 'pre'
          : equalsPost
            ? 'post'
            : 'neither';

    // ── invariants ──
    invariants['settled'] = fault.kind === 'never' ? true : outcome.settled;
    if (fault.kind === 'never') {
      // Recorded as an observation (the repository has no timeout); the
      // never-resolves class is asserted once in the dedicated test.
      observed['hungAfter60s'] = !outcome.settled;
    }

    if (op.kind === 'validation') {
      invariants['honestOutcome'] = outcome.settled && !outcome.resolved;
      invariants['errorSurfaced'] =
        outcome.error instanceof Error && !rejectionIsInjected;
      invariants['noStatementBeforeValidation'] = proxy.statements.length === 0;
    } else if (!fired) {
      invariants['honestOutcome'] =
        outcome.settled && outcome.resolved === (clean.rejected === null);
      invariants['errorSurfaced'] = true;
    } else {
      const failingKinds: FaultKind[] = [
        'throw-sync',
        'reject',
        'reject-after-apply',
        'close-during',
      ];
      if (failingKinds.includes(fault.kind)) {
        invariants['honestOutcome'] = outcome.settled && !outcome.resolved;
        invariants['errorSurfaced'] = rejectionIsInjected;
      } else if (fault.kind === 'never') {
        invariants['honestOutcome'] = !outcome.settled;
        invariants['errorSurfaced'] = true;
      } else {
        // slow / owner-swap / delete-during: the statement applied.
        invariants['honestOutcome'] =
          outcome.settled && outcome.resolved === (clean.rejected === null);
        invariants['errorSurfaced'] =
          outcome.error === undefined || !rejectionIsInjected;
      }
    }

    if (lowRealism) {
      // Double fault (statement AND the recovery ROLLBACK failed) or a BEGIN
      // lost-ack. SQLite does not fail ROLLBACK on a healthy connection and
      // BEGIN cannot both apply and fail, so the resulting open transaction
      // is recorded, not judged; the invariant that matters is that the
      // ORIGINAL error reached the caller (checked above).
      invariants['stateIntact'] = true;
      observed['stateAfterLowRealismFault'] = observed['stateEquals'];
      observed['autocommitAfterLowRealismFault'] = inAutocommit(inspect);
      forceAutocommit(inspect);
    } else if (op.kind === 'write') {
      if (fault.kind === 'delete-during') {
        // Another actor deleted owner rows mid-operation; the final state is
        // a legitimate third outcome. Only torn-write and isolation apply.
        invariants['stateIntact'] = true;
      } else if (fault.kind === 'never') {
        invariants['stateIntact'] = true;
        observed['stateAtHang'] = observed['stateEquals'];
      } else {
        invariants['stateIntact'] = equalsPre || equalsPost;
        if (fired && (fault.kind === 'reject' || fault.kind === 'throw-sync')) {
          // Nothing applied at the fault ⇒ transactional ops roll back to
          // pre; a single-statement op has nothing to roll back either.
          invariants['rolledBackToPre'] =
            equalsPre || (equalsPost && clean.rejected !== null);
        }
        if (fired && fault.kind === 'reject-after-apply') {
          observed['lostAck'] = equalsPost && !outcome.resolved;
        }
      }
    } else {
      invariants['stateIntact'] =
        fault.kind === 'delete-during' ? true : equalsPre;
    }
    invariants['noTornWrite'] = lowRealism || torn.length === 0;
    invariants['autocommitAfter'] =
      lowRealism || fault.kind === 'close-during' || fault.kind === 'never'
        ? true
        : inAutocommit(inspect);
    if (!invariants['autocommitAfter']) forceAutocommit(inspect);
    invariants['otherOwnerUntouched'] =
      world2.activeOwner === OWNER_B
        ? true
        : sameSnapshot(maskTimestamps(afterB), maskTimestamps(clean.preB));

    if (op.kind === 'read' && outcome.resolved) {
      const ids = op.idsOf ? op.idsOf(outcome.value) : [];
      const ownIds = new Set([
        ...world2.shotsA.map(s => s.analysis.id),
        ...world2.captureIdsA,
        ...world2.sessionIdsA,
        ...world2.outboxShotIdsA,
        ...world2.corruptShotIds,
        ...world2.corruptCaptureIds,
      ]);
      const foreign = ids.filter(id => !ownIds.has(id));
      invariants['ownerScoped'] = foreign.length === 0;
      if (foreign.length > 0) observed['foreignIds'] = foreign.slice(0, 5);
      const problems = op.validate ? op.validate(outcome.value) : [];
      invariants['noFabrication'] = problems.length === 0;
      if (problems.length > 0) observed['fabrication'] = problems.slice(0, 8);
      const same =
        maskClockFields(outcome.value) === maskClockFields(clean.result);
      if (fault.kind === 'delete-during') {
        const cleanIds = new Set(op.idsOf ? op.idsOf(clean.result) : []);
        invariants['resultMatchesClean'] = ids.every(id => cleanIds.has(id));
      } else {
        invariants['resultMatchesClean'] = same;
      }
      if (!same)
        observed['resultDiff'] = {
          clean: clean.result,
          faulted: outcome.value,
        };
    }

    // ── recoverability: same connection, fault disarmed ──
    if (fault.kind !== 'close-during' && fault.kind !== 'never') {
      proxy.disarm();
      setActiveDataOwner(world2.activeOwner);
      try {
        const probe = makeAnalysis(makePrng(seed ^ 0x9e), {
          resultKind: 'scored',
        });
        await repo.saveAnalysis(proxy, probe, 'permit-probe');
        const readBack = await repo.getAnalysis(proxy, probe.id);
        await repo.setKv(
          proxy,
          `consistency:${world2.activeOwner}`,
          '{"ok":true}',
        );
        invariants['usableAfter'] =
          readBack !== null &&
          readBack.id === probe.id &&
          inAutocommit(handle.raw);
      } catch (error) {
        invariants['usableAfter'] = false;
        observed['usableAfterError'] = errorText(error);
      }
    } else if (fault.kind === 'close-during') {
      // Recovery from a closed connection is a relaunch: getDb() re-runs the
      // production migrations on the SAME file and reads it back.
      try {
        opSqliteShim.reopenFile = handle.file;
        const relaunched = openMigratedDb(harness.getDb);
        setActiveDataOwner(world2.activeOwner);
        const rows = await repo.listShots(relaunched.db, 100_000);
        const persisted = countRows(inspect, 'local_shot', world2.activeOwner);
        invariants['usableAfter'] = rows.length === persisted;
        observed['relaunchRows'] = rows.length;
        relaunched.close();
      } catch (error) {
        invariants['usableAfter'] = false;
        observed['usableAfterError'] = errorText(error);
      }
    }
  } finally {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    handle.close();
  }

  const failed = Object.entries(invariants)
    .filter(([, held]) => !held)
    .map(([name]) => name);
  return {
    suite: 'repository-failure-injection',
    scenario: `${op.name} × ${fault.kind}@${fault.atStatement}${fault.rollbackAlsoFails ? '+rollback-fails' : ''}`,
    seed,
    inputs: inputs as unknown as Record<string, unknown>,
    observed,
    invariants,
    ok: failed.length === 0,
    failed,
    durationMs: Date.now() - startedAt,
  };
}

export function activeOwnerForReport(): string {
  return getActiveDataOwner();
}
