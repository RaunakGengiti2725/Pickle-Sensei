/**
 * Concurrency stress harness for `data/repository.ts` + `data/accountScope.ts`.
 *
 * Model. Production `LocalDb` is ONE op-sqlite connection whose async
 * `execute` calls run on a single worker thread in FIFO order (vendored
 * `@op-engineering/op-sqlite/cpp/OPThreadPool.cpp`: `number_of_threads = 1`).
 * The harness reproduces that with a real SQLite database (`node:sqlite`,
 * Node >= 22.13) behind a scheduler: every `execute` becomes a pending
 * statement, and a seeded RNG decides which pending statement runs next
 * (`fifo` = the real driver's order, `random` = any interleaving). Repository
 * calls are launched as `Promise.all` bursts with seeded start offsets, so
 * duplicate calls, call-during-call, two actors on one row, owner rotation /
 * logout mid-request, cancelled (driver-failed) statements and clock skew all
 * fall out of the schedule. Every iteration is replayable from its seed.
 *
 * Env flags
 *   STRESS_ITER    iterations per family (default 12; campaign: 100+)
 *   STRESS_SEED    base seed (default 1)
 *   STRESS_SEEDS   comma list of exact iteration seeds to replay
 *   STRESS_ORDER   fifo | random | mixed (default mixed)
 *   STRESS_REPORT  path; when set, the seed → outcome JSON table is written
 *   STRESS_TOLERATE_NESTED_BEGIN=1  diagnostic: accept SQLite's nested-BEGIN
 *                  error so the other invariants can be measured (default off)
 */
import type { ShotAnalysis, ShotTypeSlug } from '@pickle/shared-types';
import type { CapturedClip } from '../../src/camera/capture';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import type { LocalDb } from '../../src/data/db';
import {
  finishSession,
  getAnalysis,
  getKv,
  getPendingCapture,
  getShotOutboxStatus,
  hasShotSyncReceipt,
  listActivityShots,
  listPendingCaptures,
  listRealAnalysisFacts,
  listShots,
  markCaptureAnalyzed,
  OWNER_SCOPED_KV_NAMESPACES,
  purgeOwnerData,
  recentScores,
  saveAnalysis,
  saveLocalOnlyAnalysis,
  savePendingCapture,
  saveSession,
  setDeclaredStroke,
  setKv,
} from '../../src/data/repository';
import { drainOutbox, type SyncTransport } from '../../src/data/sync';

// The mobile tsconfig types only `jest`, so Node built-ins are required with
// the same hand-typed shapes the other Node-backed suites use.
declare const process: {
  env: Record<string, string | undefined>;
  version: string;
};
declare const require: (id: string) => unknown;

type SqlParam = null | number | bigint | string | Uint8Array;
type Row = Record<string, unknown>;

interface SqliteStatement {
  all(...params: SqlParam[]): unknown[];
  run(...params: SqlParam[]): unknown;
}
interface SqliteDatabase {
  readonly isTransaction: boolean;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (location: string) => SqliteDatabase;
};
const { mkdirSync, writeFileSync } = require('node:fs') as {
  mkdirSync(path: string, options: { recursive: boolean }): void;
  writeFileSync(path: string, data: string): void;
};
const { dirname } = require('node:path') as { dirname(path: string): string };

// ───────────────────────────── configuration ─────────────────────────────

const ITER = Math.max(1, Number(process.env.STRESS_ITER ?? 12) || 12);
const BASE_SEED = Number(process.env.STRESS_SEED ?? 1) || 1;
const ONLY_SEEDS = (process.env.STRESS_SEEDS ?? '')
  .split(',')
  .map(s => Number(s.trim()))
  .filter(n => Number.isSafeInteger(n) && n > 0);
const ORDER_MODE = (process.env.STRESS_ORDER ?? 'mixed') as
  'fifo' | 'random' | 'mixed';
const REPORT_PATH = process.env.STRESS_REPORT ?? '';
/**
 * Diagnostic mode only: treat SQLite's "cannot start a transaction within a
 * transaction" as an expected error so the REMAINING invariants (row
 * integrity, scoping, idempotency) can still be measured on the same seeds.
 * The default run keeps it a violation.
 */
const TOLERATE_NESTED_BEGIN = process.env.STRESS_TOLERATE_NESTED_BEGIN === '1';
/** Per-iteration wall budget: a burst that does not settle is a hang. */
const WALL_BUDGET_MS = 10_000;
const VOLUME_ROWS = 10_000;

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';
type Owner =
  | typeof OWNER_A
  | typeof OWNER_B
  | typeof GUEST_DATA_OWNER
  | typeof SIGNED_OUT_DATA_OWNER;

// ───────────────────────────── seeded RNG ─────────────────────────────

class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }
  /** mulberry32 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  range(min: number, maxInclusive: number): number {
    return min + this.int(maxInclusive - min + 1);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }
  uuid(): string {
    const hex = () => this.int(16).toString(16);
    const seg = (n: number) => Array.from({ length: n }, hex).join('');
    return `${seg(8)}-${seg(4)}-4${seg(3)}-8${seg(3)}-${seg(12)}`;
  }
}

/** Iteration seed derived from (base, family, index) — stable across runs. */
function iterationSeed(base: number, family: number, index: number): number {
  let h = (base ^ 0x811c9dc5) >>> 0;
  for (const v of [family, index]) {
    h = Math.imul(h ^ v, 0x01000193) >>> 0;
  }
  return (h % 2_000_000_000) + 1;
}

// ───────────────────────────── SQLite schema ─────────────────────────────

/** Mirrors db.ts LOCAL_MIGRATIONS + ensureAccountScopedSchema column adds. */
const SCHEMA = [
  `CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE local_shot (
     owner_key TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT,
     shot_type TEXT NOT NULL, captured_at TEXT NOT NULL, overall_score REAL,
     confidence REAL NOT NULL, result_kind TEXT NOT NULL, source TEXT NOT NULL,
     favorite INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL,
     PRIMARY KEY (owner_key, id))`,
  `CREATE TABLE local_session (
     owner_key TEXT NOT NULL, id TEXT NOT NULL, mode TEXT NOT NULL,
     shot_type TEXT, focus_checkpoint TEXT, started_at TEXT NOT NULL,
     ended_at TEXT, completed INTEGER NOT NULL DEFAULT 0, summary TEXT,
     PRIMARY KEY (owner_key, id))`,
  `CREATE TABLE local_capture (
     owner_key TEXT NOT NULL, id TEXT NOT NULL, uri TEXT NOT NULL,
     shot_type TEXT NOT NULL, captured_at TEXT NOT NULL,
     duration_ms INTEGER NOT NULL, fps REAL NOT NULL, width INTEGER NOT NULL,
     height INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('awaiting_model','analyzed')),
     payload TEXT, declared_stroke TEXT, target_seed TEXT,
     training_consent TEXT NOT NULL DEFAULT 'not_asked',
     PRIMARY KEY (owner_key, id), UNIQUE (owner_key, uri))`,
  `CREATE TABLE outbox (
     id INTEGER PRIMARY KEY AUTOINCREMENT, owner_key TEXT NOT NULL,
     kind TEXT NOT NULL, payload TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (datetime('now')), last_error TEXT)`,
  `CREATE TABLE sync_receipt (
     owner_key TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
     accepted_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (owner_key, kind, entity_id))`,
  `CREATE TABLE local_analysis_record (
     owner_key TEXT NOT NULL, id TEXT NOT NULL, capture_id TEXT NOT NULL,
     created_at TEXT NOT NULL, engine_version TEXT NOT NULL,
     scoring_model_version TEXT NOT NULL, record TEXT NOT NULL,
     PRIMARY KEY (owner_key, id))`,
  `CREATE INDEX idx_local_analysis_capture
     ON local_analysis_record (owner_key, capture_id, created_at DESC)`,
  `CREATE INDEX idx_local_shot_owner_time ON local_shot (owner_key, captured_at DESC)`,
  `CREATE INDEX idx_local_capture_owner_time ON local_capture (owner_key, captured_at DESC)`,
  `CREATE INDEX idx_outbox_owner_created ON outbox (owner_key, created_at, id)`,
];

const OWNER_TABLES = [
  'local_shot',
  'local_session',
  'local_capture',
  'local_analysis_record',
  'outbox',
  'sync_receipt',
] as const;

function toParam(value: unknown, sql: string): SqlParam {
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'string' ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  throw new Error(
    `unbindable parameter ${typeof value} (${String(value)}) for: ${sql.slice(0, 60)}`,
  );
}

// ───────────────────────────── scheduler ─────────────────────────────

interface PendingStmt {
  opId: number;
  sql: string;
  params: unknown[];
  resolve: (result: { rows: Row[] }) => void;
  reject: (error: unknown) => void;
}

interface ExecutedStmt {
  seq: number;
  opId: number;
  sql: string;
  params: unknown[];
  outcome: 'ok' | 'error' | 'injected_fault';
  error?: string;
}

type OrderMode = 'fifo' | 'random';

class ScheduledDb {
  readonly raw: SqliteDatabase = new DatabaseSync(':memory:');
  readonly pending: PendingStmt[] = [];
  readonly executed: ExecutedStmt[] = [];
  private seq = 0;

  constructor() {
    for (const sql of SCHEMA) this.raw.exec(sql);
  }

  /** A LocalDb handle whose statements are attributed to `opId`. */
  view(opId: number): LocalDb {
    return {
      execute: (sql, params = []) =>
        new Promise<{ rows: Row[] }>((resolve, reject) => {
          this.pending.push({ opId, sql, params, resolve, reject });
        }),
      close: () => {},
    };
  }

  /** Runs a statement immediately on the shared connection (fixture setup). */
  direct(sql: string, params: unknown[] = []): Row[] {
    const stmt = this.raw.prepare(sql);
    const bound = params.map(p => toParam(p, sql));
    if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql)) {
      return stmt.all(...bound) as Row[];
    }
    stmt.run(...bound);
    return [];
  }

  runPending(index: number, injectFault: boolean): ExecutedStmt {
    const stmt = this.pending.splice(index, 1)[0];
    if (!stmt) throw new Error('no pending statement');
    const record: ExecutedStmt = {
      seq: ++this.seq,
      opId: stmt.opId,
      sql: stmt.sql,
      params: stmt.params,
      outcome: 'ok',
    };
    if (injectFault) {
      record.outcome = 'injected_fault';
      record.error = 'injected driver failure';
      this.executed.push(record);
      stmt.reject(new Error('injected driver failure'));
      return record;
    }
    try {
      const rows = this.direct(stmt.sql, stmt.params);
      this.executed.push(record);
      stmt.resolve({ rows });
    } catch (error) {
      record.outcome = 'error';
      record.error = error instanceof Error ? error.message : String(error);
      this.executed.push(record);
      stmt.reject(error);
    }
    return record;
  }

  /** True when no transaction is left open on the shared connection. */
  isIdle(): boolean {
    return !this.raw.isTransaction;
  }

  close(): void {
    this.raw.close();
  }
}

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

// ───────────────────────────── operations ─────────────────────────────

type OpKind =
  | 'saveAnalysis'
  | 'saveLocalOnlyAnalysis'
  | 'saveSession'
  | 'finishSession'
  | 'savePendingCapture'
  | 'setDeclaredStroke'
  | 'markCaptureAnalyzed'
  | 'setKv'
  | 'purgeOwnerData'
  | 'drainOutbox'
  | 'rotateOwner'
  | 'getAnalysis'
  | 'listShots'
  | 'listActivityShots'
  | 'listRealAnalysisFacts'
  | 'recentScores'
  | 'listPendingCaptures'
  | 'getPendingCapture'
  | 'getShotOutboxStatus'
  | 'hasShotSyncReceipt'
  | 'getKv';

interface OpSpec {
  kind: OpKind;
  /** Statements that must have executed before this op is launched. */
  startAfter: number;
  /** Entity id the op targets (shot / session / capture / kv key). */
  target?: string;
  /** Distinguishes competing payload versions on the same row. */
  version?: string;
  /** Owner the op explicitly names (purge / rotate). */
  namedOwner?: Owner;
  run: (view: LocalDb) => Promise<unknown>;
}

interface OpResult {
  kind: OpKind;
  target?: string;
  version?: string;
  namedOwner?: Owner;
  /** Active owner when the repository call was issued. */
  ownerAtStart: string;
  state: 'ok' | 'error' | 'unstarted' | 'pending';
  error?: string;
  value?: unknown;
  startSeq: number;
}

const SHOT_TYPES_FOR_STRESS: readonly ShotTypeSlug[] = [
  'forehand_drive',
  'dink',
  'third_shot_drop',
  'serve',
];

function makeAnalysis(
  rng: Rng,
  id: string,
  ownerTag: string,
  version: string,
  options: {
    resultKind?: ShotAnalysis['resultKind'];
    capturedAtIso?: string;
    sessionId?: string | null;
  } = {},
): ShotAnalysis {
  const resultKind = options.resultKind ?? 'scored';
  return {
    id,
    sessionId: options.sessionId ?? null,
    shotType: rng.pick(SHOT_TYPES_FOR_STRESS),
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: options.capturedAtIso ?? isoAt(rng, 0),
    timestamps: { startMs: 0, contactMs: 900, endMs: 1800 },
    phases: [],
    measurements: [],
    checkpoints: [],
    overallScore: resultKind === 'scored' ? rng.range(10, 99) / 10 : null,
    analysisConfidence: resultKind === 'scored' ? 0.91 : 0.31,
    resultKind,
    guidance: null,
    priorityFix: null,
    versionVector: {
      // Owner + version tags ride along in the payload so a read can prove
      // which actor's row (and which owner's bucket) it came back from.
      appVersion: `owner:${ownerTag}`,
      modelBundleVersion: `version:${version}`,
      poseModelVersion: 'pose-1',
      paddleModelVersion: 'paddle-1',
      strokeDetectorVersion: 'stroke-1',
      phaseModelVersion: 'phase-1',
      scoringModelVersion: 'score-1',
      shotConfigVersion: 'forehand_drive@1',
    },
    source: 'real',
  };
}

const EPOCH_MS = Date.parse('2026-08-27T18:00:00.000Z');

/** Clock skew: timestamps up to ±30 days around the epoch, ms granularity. */
function isoAt(rng: Rng, skewDays: number): string {
  const skew = skewDays === 0 ? 0 : rng.range(-skewDays, skewDays) * 86_400_000;
  return new Date(EPOCH_MS + skew + rng.int(3_600_000)).toISOString();
}

function makeClip(id: string, capturedAtIso: string): CapturedClip {
  return {
    uri: `file:///private/captures/${id}.mov`,
    durationMs: 3900,
    fps: 59.94,
    width: 720,
    height: 1280,
    capturedAtIso,
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: 1800,
      endMs: 2450,
      peakMotionMs: 2220,
      confidence: 0.84,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    captureEvidence: {
      schemaVersion: 1,
      window: 'detected_motion',
      poseSource: 'mediapipe_pose_landmarker',
      poseModelVersion: 'mediapipe-pose-landmarker-full-1',
      triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
      motionUnit: 'normalized_image_units_per_second',
      analysisInputFrameCount: 8,
      poseFrameCount: 7,
      poseMissingFrameCount: 1,
      trackedDurationMs: 600,
      meanCanonicalJointVisibility: 0.86,
      meanJointCoverage: 0.93,
      minimumJointCoverage: 0.83,
      fullBodyVisibleFrameCount: 5,
      jointMotion: [
        {
          joint: 'left_wrist',
          sampleCount: 6,
          meanNormalizedPerSecond: 1.2,
          peakNormalizedPerSecond: 2.1,
        },
      ],
    },
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    preRollMs: 1800,
    postRollMs: 1450,
  };
}

class RecordingTransport implements SyncTransport {
  readonly acceptedShotIds: string[] = [];
  readonly createdSessionIds: string[] = [];
  readonly finalizedSessionIds: string[] = [];
  async syncShots(shots: unknown[]) {
    const ids = shots.map(shot => String((shot as { id: unknown }).id));
    this.acceptedShotIds.push(...ids);
    return { acceptedIds: ids, rejected: [] };
  }
  async createSession(session: unknown) {
    this.createdSessionIds.push(String((session as { id: unknown }).id));
  }
  async finalizeSession(id: string) {
    this.finalizedSessionIds.push(id);
  }
}

// ───────────────────────────── burst runner ─────────────────────────────

interface BurstOutcome {
  results: OpResult[];
  stmtCount: number;
  durationMs: number;
  hung: boolean;
}

async function runBurst(
  db: ScheduledDb,
  rng: Rng,
  specs: OpSpec[],
  order: OrderMode,
  faultRate: number,
): Promise<BurstOutcome> {
  const results: OpResult[] = specs.map(spec => ({
    kind: spec.kind,
    target: spec.target,
    version: spec.version,
    namedOwner: spec.namedOwner,
    ownerAtStart: '',
    state: 'unstarted',
    startSeq: -1,
  }));
  let unsettled = specs.length;
  const started = new Set<number>();
  const launch = (index: number) => {
    const spec = specs[index];
    const result = results[index];
    if (!spec || !result) return;
    started.add(index);
    result.ownerAtStart = getActiveDataOwner();
    result.startSeq = db.executed.length;
    result.state = 'pending';
    spec
      .run(db.view(index))
      .then(
        value => {
          result.state = 'ok';
          result.value = value;
        },
        (error: unknown) => {
          result.state = 'error';
          result.error = error instanceof Error ? error.message : String(error);
        },
      )
      .finally(() => {
        unsettled -= 1;
      });
  };
  const launchDue = () => {
    specs.forEach((spec, index) => {
      if (!started.has(index) && spec.startAfter <= db.executed.length) {
        launch(index);
      }
    });
  };

  const startedAt = Date.now();
  let idle = 0;
  let hung = false;
  launchDue();
  while (unsettled > 0) {
    await tick();
    launchDue();
    if (Date.now() - startedAt > WALL_BUDGET_MS) {
      hung = true;
      break;
    }
    if (db.pending.length === 0) {
      // Every in-flight op is quiet; if a later-start op is still waiting for
      // a statement count the burst can no longer reach, launch it now.
      const next = specs
        .map((spec, index) => ({ spec, index }))
        .filter(entry => !started.has(entry.index))
        .sort((a, b) => a.spec.startAfter - b.spec.startAfter)[0];
      if (next) {
        launch(next.index);
        continue;
      }
      idle += 1;
      // Nothing queued, nothing left to start and nothing settling: an op
      // awaits something that can never arrive (a hang in the unit under test).
      if (idle > 200) {
        hung = true;
        break;
      }
      continue;
    }
    idle = 0;
    const index = order === 'fifo' ? 0 : rng.int(db.pending.length);
    const sql = db.pending[index]?.sql ?? '';
    // A failed ROLLBACK is not a driver fault worth modelling here: the
    // repository deliberately swallows it, so injecting it only leaves the
    // connection inside a transaction for reasons unrelated to the unit.
    const inject =
      faultRate > 0 && rng.chance(faultRate) && !/^\s*ROLLBACK/i.test(sql);
    db.runPending(index, inject);
  }
  if (hung) {
    // Release everything still queued so the promise graph settles and the
    // failure is attributed to the iteration instead of leaking.
    while (db.pending.length > 0) {
      db.pending.shift()?.reject(new Error('harness: burst abandoned (hang)'));
    }
    await tick();
  }
  return {
    results,
    stmtCount: db.executed.length,
    durationMs: Date.now() - startedAt,
    hung,
  };
}

// ───────────────────────────── invariants ─────────────────────────────

/** Error classes the repository legitimately raises under this schedule. */
const EXPECTED_ERRORS = [
  'Sign in or continue locally before saving product data.',
  'injected driver failure',
  'UNIQUE constraint failed',
  'harness: burst abandoned (hang)',
];

const NESTED_BEGIN_ERROR = 'cannot start a transaction within a transaction';

function isExpectedError(message: string | undefined): boolean {
  if (message === undefined) return false;
  if (TOLERATE_NESTED_BEGIN && message.includes(NESTED_BEGIN_ERROR))
    return true;
  return EXPECTED_ERRORS.some(e => message.includes(e));
}

function stmtSeq(
  db: ScheduledDb,
  opId: number,
  pattern: RegExp,
  which: 'first' | 'last' = 'last',
): number | null {
  const matches = db.executed.filter(
    s => s.opId === opId && s.outcome === 'ok' && pattern.test(s.sql),
  );
  const hit = which === 'first' ? matches[0] : matches[matches.length - 1];
  return hit ? hit.seq : null;
}

function count(db: ScheduledDb, sql: string, params: unknown[]): number {
  return Number(db.direct(sql, params)[0]?.['n'] ?? 0);
}

interface IterationContext {
  db: ScheduledDb;
  results: OpResult[];
  transport: RecordingTransport;
  violations: string[];
  /** Owners whose purge op ran to a successful COMMIT: owner → COMMIT seq. */
  purgeCommitSeq: Map<string, number>;
}

function violate(ctx: IterationContext, message: string): void {
  ctx.violations.push(message);
}

/**
 * I-isolation: a call that reported success must not have had its statements
 * silently absorbed into ANOTHER caller's transaction that later rolled back
 * (its write is gone although it resolved), and a read must not observe a
 * foreign transaction's uncommitted writes.
 */
function checkTransactionIsolation(ctx: IterationContext): void {
  const { db, results } = ctx;
  let txOwner: number | null = null;
  let txStart = -1;
  for (const stmt of db.executed) {
    if (stmt.outcome !== 'ok') continue;
    if (/^\s*BEGIN/i.test(stmt.sql)) {
      txOwner = stmt.opId;
      txStart = stmt.seq;
      continue;
    }
    if (/^\s*COMMIT/i.test(stmt.sql)) {
      txOwner = null;
      continue;
    }
    if (/^\s*ROLLBACK/i.test(stmt.sql)) {
      if (txOwner !== null) {
        const window = db.executed.filter(
          s => s.seq > txStart && s.seq < stmt.seq && s.outcome === 'ok',
        );
        const ownerWroteBefore = (seq: number) =>
          window.some(
            s =>
              s.opId === txOwner &&
              s.seq < seq &&
              /^\s*(INSERT|UPDATE|DELETE)/i.test(s.sql),
          );
        for (const s of window) {
          if (s.opId === txOwner) continue;
          const op = results[s.opId];
          if (!op || op.state !== 'ok') continue;
          if (/^\s*(INSERT|UPDATE|DELETE)/i.test(s.sql)) {
            violate(
              ctx,
              `write_lost_to_foreign_rollback:op${s.opId}:${op.kind}:inside_tx_of_op${txOwner}`,
            );
          } else if (/^\s*SELECT/i.test(s.sql) && ownerWroteBefore(s.seq)) {
            violate(
              ctx,
              `dirty_read_of_rolled_back_tx:op${s.opId}:${op.kind}:inside_tx_of_op${txOwner}`,
            );
          }
        }
      }
      txOwner = null;
    }
  }
}

function checkCommonInvariants(ctx: IterationContext): void {
  const { db, results } = ctx;

  checkTransactionIsolation(ctx);

  // I-signedout: no writes ever land in the signed-out bucket.
  for (const table of OWNER_TABLES) {
    const n = count(
      db,
      `SELECT count(*) AS n FROM ${table} WHERE owner_key = ?`,
      [SIGNED_OUT_DATA_OWNER],
    );
    if (n > 0) violate(ctx, `signed_out_rows:${table}:${n}`);
  }

  // I-errors: every failed op failed for an expected reason.
  results.forEach((r, i) => {
    if (r.state === 'error' && !isExpectedError(r.error)) {
      violate(ctx, `unexpected_error:op${i}:${r.kind}:${r.error ?? ''}`);
    }
    if (r.state === 'pending') violate(ctx, `never_settled:op${i}:${r.kind}`);
  });

  // I-purge: a purge that committed removed the owner's whole bucket, except
  // rows a later successful write recreated.
  results.forEach((r, i) => {
    if (r.kind !== 'purgeOwnerData' || r.state !== 'ok' || !r.namedOwner) {
      return;
    }
    const commit = stmtSeq(db, i, /^COMMIT$/);
    if (commit === null) {
      violate(ctx, `purge_ok_without_commit:op${i}`);
      return;
    }
    ctx.purgeCommitSeq.set(r.namedOwner, commit);
    const owner = r.namedOwner;
    for (const table of OWNER_TABLES) {
      const rows = db.direct(
        `SELECT ${table === 'outbox' ? "json_extract(payload, '$.id')" : table === 'sync_receipt' ? 'entity_id' : 'id'} AS id FROM ${table} WHERE owner_key = ?`,
        [owner],
      );
      for (const row of rows) {
        const id = String(row['id']);
        const recreated = results.some(
          (w, j) =>
            w.state === 'ok' &&
            w.ownerAtStart === owner &&
            w.target === id &&
            (stmtSeq(db, j, /INSERT/) ?? -1) > commit,
        );
        if (!recreated) violate(ctx, `purge_survivor:${table}:${owner}:${id}`);
      }
    }
    for (const namespace of OWNER_SCOPED_KV_NAMESPACES) {
      const key = `${namespace}:${owner}`;
      const present = count(db, `SELECT count(*) AS n FROM kv WHERE key = ?`, [
        key,
      ]);
      const recreated = results.some(
        (w, j) =>
          w.kind === 'setKv' &&
          w.state === 'ok' &&
          w.target === key &&
          (stmtSeq(db, j, /INSERT/) ?? -1) > commit,
      );
      if (present > 0 && !recreated) violate(ctx, `purge_survivor:kv:${key}`);
    }
  });

  // I-scope: every stored row belongs to an actor that targeted that exact
  // (owner, id); rows never migrate to the owner active at commit time.
  for (const table of ['local_shot', 'local_session', 'local_capture']) {
    const rows = db.direct(`SELECT owner_key, id FROM ${table}`);
    for (const row of rows) {
      const owner = String(row['owner_key']);
      const id = String(row['id']);
      if (id.startsWith('seed-') || id.startsWith('fixture-')) continue;
      const intended = results.some(
        r => r.target === id && r.ownerAtStart === owner,
      );
      if (!intended) violate(ctx, `owner_leak:${table}:${owner}:${id}`);
    }
  }

  // I-shot-atomicity: for every (owner, shot) key touched by saveAnalysis /
  // saveLocalOnlyAnalysis, the durable state matches the set of calls that
  // reported success — no torn writes, no phantom outbox rows, no lost rows.
  const shotKeys = new Map<string, number[]>();
  results.forEach((r, i) => {
    if (
      (r.kind === 'saveAnalysis' || r.kind === 'saveLocalOnlyAnalysis') &&
      r.target
    ) {
      const key = `${r.ownerAtStart}|${r.target}`;
      shotKeys.set(key, [...(shotKeys.get(key) ?? []), i]);
    }
  });
  for (const [key, opIds] of shotKeys) {
    const [owner, id] = key.split('|') as [string, string];
    const purgeSeq = ctx.purgeCommitSeq.get(owner) ?? -1;
    const okWriters = opIds.filter(i => results[i]?.state === 'ok');
    const okAfterPurge = okWriters.filter(
      i =>
        (stmtSeq(db, i, /INSERT OR REPLACE INTO local_shot/) ?? -1) > purgeSeq,
    );
    const shotRows = db.direct(
      `SELECT payload FROM local_shot WHERE owner_key = ? AND id = ?`,
      [owner, id],
    );
    const okSaveAnalysis = okWriters.filter(
      i => results[i]?.kind === 'saveAnalysis',
    );
    const outboxRows = count(
      db,
      `SELECT count(*) AS n FROM outbox WHERE owner_key = ? AND kind = 'shot.sync' AND json_extract(payload, '$.id') = ?`,
      [owner, id],
    );
    const receipt = count(
      db,
      `SELECT count(*) AS n FROM sync_receipt WHERE owner_key = ? AND kind = 'shot.sync' AND entity_id = ?`,
      [owner, id],
    );
    if (shotRows.length > 1) violate(ctx, `duplicate_shot_rows:${key}`);
    if (okAfterPurge.length > 0 && shotRows.length === 0) {
      violate(ctx, `lost_shot_row:${key}:ok_writers=${okAfterPurge.length}`);
    }
    if (okWriters.length === 0 && purgeSeq < 0 && shotRows.length > 0) {
      violate(ctx, `torn_write_shot_row_from_failed_call:${key}`);
    }
    if (shotRows.length === 1 && okWriters.length > 0) {
      // Last-writer-wins by execution order: the visible payload must be the
      // one whose INSERT ran last among the successful writers.
      const last = okWriters
        .map(i => ({
          i,
          seq: stmtSeq(db, i, /INSERT OR REPLACE INTO local_shot/) ?? -1,
        }))
        .sort((a, b) => b.seq - a.seq)[0];
      const payload = JSON.parse(
        String(shotRows[0]?.['payload']),
      ) as ShotAnalysis;
      const visible = payload.versionVector.modelBundleVersion;
      const expected = `version:${results[last?.i ?? -1]?.version ?? ''}`;
      if (last && visible !== expected) {
        violate(
          ctx,
          `lost_update_shot:${key}:visible=${visible}:expected=${expected}`,
        );
      }
      if (payload.versionVector.appVersion !== `owner:${owner}`) {
        violate(
          ctx,
          `owner_leak_payload:${key}:${payload.versionVector.appVersion}`,
        );
      }
    }
    if (okSaveAnalysis.length > 0 && purgeSeq < 0) {
      // No double spend / no lost permit: each successful call is represented
      // exactly once — still queued or already receipted — never more.
      if (outboxRows > okSaveAnalysis.length) {
        violate(
          ctx,
          `phantom_outbox_rows:${key}:rows=${outboxRows}:ok=${okSaveAnalysis.length}`,
        );
      }
      if (outboxRows === 0 && receipt === 0) {
        violate(ctx, `lost_outbox_row:${key}:ok=${okSaveAnalysis.length}`);
      }
    }
    if (okSaveAnalysis.length === 0 && purgeSeq < 0 && outboxRows > 0) {
      violate(
        ctx,
        `torn_write_outbox_from_failed_call:${key}:rows=${outboxRows}`,
      );
    }
  }

  // I-session-atomicity / lost update on finishSession.
  const sessionKeys = new Map<string, number[]>();
  results.forEach((r, i) => {
    if ((r.kind === 'saveSession' || r.kind === 'finishSession') && r.target) {
      const key = `${r.ownerAtStart}|${r.target}`;
      sessionKeys.set(key, [...(sessionKeys.get(key) ?? []), i]);
    }
  });
  for (const [key, opIds] of sessionKeys) {
    const [owner, id] = key.split('|') as [string, string];
    if (ctx.purgeCommitSeq.has(owner)) continue;
    const okSaves = opIds.filter(
      i => results[i]?.kind === 'saveSession' && results[i]?.state === 'ok',
    );
    const okFinishes = opIds.filter(
      i => results[i]?.kind === 'finishSession' && results[i]?.state === 'ok',
    );
    const rows = db.direct(
      `SELECT completed, summary FROM local_session WHERE owner_key = ? AND id = ?`,
      [owner, id],
    );
    const createRows = count(
      db,
      `SELECT count(*) AS n FROM outbox WHERE owner_key = ? AND kind = 'session.create' AND json_extract(payload, '$.id') = ?`,
      [owner, id],
    );
    const finalizeRows = count(
      db,
      `SELECT count(*) AS n FROM outbox WHERE owner_key = ? AND kind = 'session.finalize' AND json_extract(payload, '$.id') = ?`,
      [owner, id],
    );
    const drainedCreates = ctx.transport.createdSessionIds.filter(
      s => s === id,
    ).length;
    const drainedFinalizes = ctx.transport.finalizedSessionIds.filter(
      s => s === id,
    ).length;
    if (okSaves.length > 0 && rows.length === 0) {
      violate(ctx, `lost_session_row:${key}`);
    }
    if (okSaves.length === 0 && rows.length > 0) {
      violate(ctx, `torn_write_session_row_from_failed_call:${key}`);
    }
    // No phantom rows from failed calls; no successful call's row lost
    // (a drained row may legitimately survive when its DELETE was faulted).
    if (
      createRows > okSaves.length ||
      createRows + drainedCreates < okSaves.length
    ) {
      violate(
        ctx,
        `session_create_outbox_mismatch:${key}:rows=${createRows}:drained=${drainedCreates}:ok=${okSaves.length}`,
      );
    }
    if (
      finalizeRows > okFinishes.length ||
      finalizeRows + drainedFinalizes < okFinishes.length
    ) {
      violate(
        ctx,
        `session_finalize_outbox_mismatch:${key}:rows=${finalizeRows}:drained=${drainedFinalizes}:ok=${okFinishes.length}`,
      );
    }
    // The finalize UPDATE only has a row to hit once the create's INSERT ran;
    // a burst may legitimately order finish before save, so the completed /
    // summary expectation applies to finishes that executed after the last
    // successful create.
    const lastCreateSeq = okSaves
      .map(i => stmtSeq(db, i, /INSERT OR REPLACE INTO local_session/) ?? -1)
      .sort((a, b) => b - a)[0];
    const orderedFinishes = okFinishes
      .map(i => ({ i, seq: stmtSeq(db, i, /UPDATE local_session/) ?? -1 }))
      .filter(f => lastCreateSeq !== undefined && f.seq > lastCreateSeq)
      .sort((a, b) => b.seq - a.seq);
    if (orderedFinishes.length > 0 && rows.length === 1) {
      const row = rows[0];
      const last = orderedFinishes[0];
      const expectedSummary = JSON.stringify({
        version: results[last?.i ?? -1]?.version,
      });
      if (Number(row?.['completed']) !== 1) {
        violate(ctx, `lost_update_session_completed:${key}`);
      }
      if (row?.['summary'] !== expectedSummary) {
        violate(
          ctx,
          `lost_update_session_summary:${key}:visible=${String(row?.['summary'])}:expected=${expectedSummary}`,
        );
      }
    }
  }

  // I-capture: exactly one capture row per (owner, id); declared stroke and
  // status reflect the last successful setter.
  const captureKeys = new Map<string, number[]>();
  results.forEach((r, i) => {
    if (
      (r.kind === 'savePendingCapture' ||
        r.kind === 'setDeclaredStroke' ||
        r.kind === 'markCaptureAnalyzed') &&
      r.target
    ) {
      const key = `${r.ownerAtStart}|${r.target}`;
      captureKeys.set(key, [...(captureKeys.get(key) ?? []), i]);
    }
  });
  for (const [key, opIds] of captureKeys) {
    const [owner, id] = key.split('|') as [string, string];
    if (ctx.purgeCommitSeq.has(owner)) continue;
    const okSaves = opIds.filter(
      i =>
        results[i]?.kind === 'savePendingCapture' && results[i]?.state === 'ok',
    );
    const rows = db.direct(
      `SELECT declared_stroke, status FROM local_capture WHERE owner_key = ? AND id = ?`,
      [owner, id],
    );
    if (rows.length > 1) violate(ctx, `duplicate_capture_rows:${key}`);
    if (okSaves.length > 1) {
      violate(ctx, `duplicate_capture_insert_accepted_twice:${key}`);
    }
    if (okSaves.length === 1 && rows.length === 0) {
      violate(ctx, `lost_capture_row:${key}`);
    }
    if (okSaves.length === 0 && rows.length > 0) {
      violate(ctx, `torn_write_capture_from_failed_call:${key}`);
    }
    if (rows.length !== 1) continue;
    const saveSeq = stmtSeq(db, okSaves[0] ?? -1, /INSERT INTO local_capture/);
    const strokes = opIds
      .filter(
        i =>
          results[i]?.kind === 'setDeclaredStroke' &&
          results[i]?.state === 'ok',
      )
      .map(i => ({ i, seq: stmtSeq(db, i, /UPDATE local_capture/) ?? -1 }))
      .filter(s => saveSeq !== null && s.seq > saveSeq)
      .sort((a, b) => b.seq - a.seq);
    const lastStroke = strokes[0];
    if (lastStroke) {
      const expected = results[lastStroke.i]?.version;
      if (rows[0]?.['declared_stroke'] !== expected) {
        violate(
          ctx,
          `lost_update_declared_stroke:${key}:visible=${String(rows[0]?.['declared_stroke'])}:expected=${String(expected)}`,
        );
      }
    }
    const analyzedAfterSave = opIds.some(
      i =>
        results[i]?.kind === 'markCaptureAnalyzed' &&
        results[i]?.state === 'ok' &&
        saveSeq !== null &&
        (stmtSeq(db, i, /UPDATE local_capture/) ?? -1) > saveSeq,
    );
    const status = rows[0]?.['status'];
    if (analyzedAfterSave && status !== 'analyzed') {
      violate(ctx, `lost_update_capture_status:${key}`);
    }
  }

  // I-kv: last successful setter wins.
  const kvKeys = new Map<string, number[]>();
  results.forEach((r, i) => {
    if (r.kind === 'setKv' && r.target) {
      kvKeys.set(r.target, [...(kvKeys.get(r.target) ?? []), i]);
    }
  });
  for (const [key, opIds] of kvKeys) {
    const owner = key.split(':')[1] ?? '';
    const purgeSeq = ctx.purgeCommitSeq.get(owner) ?? -1;
    const ok = opIds
      .filter(i => results[i]?.state === 'ok')
      .map(i => ({ i, seq: stmtSeq(db, i, /INSERT OR REPLACE INTO kv/) ?? -1 }))
      .filter(s => s.seq > purgeSeq)
      .sort((a, b) => b.seq - a.seq);
    const last = ok[0];
    if (!last) continue;
    const rows = db.direct(`SELECT value FROM kv WHERE key = ?`, [key]);
    const expected = results[last.i]?.version;
    if (rows[0]?.['value'] !== expected) {
      violate(
        ctx,
        `lost_update_kv:${key}:visible=${String(rows[0]?.['value'])}:expected=${String(expected)}`,
      );
    }
  }

  // I-read-scope: every read returned only the reader's owner bucket.
  results.forEach((r, i) => {
    if (r.state !== 'ok') return;
    const tag = `owner:${r.ownerAtStart}`;
    if (r.kind === 'getAnalysis' && r.value) {
      const analysis = r.value as ShotAnalysis;
      if (analysis.versionVector.appVersion !== tag) {
        violate(
          ctx,
          `read_leak:getAnalysis:op${i}:${analysis.versionVector.appVersion}`,
        );
      }
    }
    if (
      r.kind === 'listShots' ||
      r.kind === 'listActivityShots' ||
      r.kind === 'listRealAnalysisFacts'
    ) {
      const rows = r.value as Array<{ id: string }>;
      for (const row of rows) {
        const ownersForId = results
          .filter(w => w.target === row.id && w.state === 'ok')
          .map(w => w.ownerAtStart);
        const seeded = row.id.startsWith('seed-');
        if (seeded || ownersForId.includes(r.ownerAtStart)) continue;
        const sameOwnerAttempted = results.some(
          w => w.target === row.id && w.ownerAtStart === r.ownerAtStart,
        );
        // Same owner, but no successful writer: the reader saw a row from a
        // call that failed/rolled back. Different owner: cross-account leak.
        violate(
          ctx,
          sameOwnerAttempted
            ? `phantom_read_of_uncommitted_row:${r.kind}:op${i}:${row.id}`
            : `cross_owner_read_leak:${r.kind}:op${i}:${row.id}`,
        );
      }
      const ids = rows.map(row => row.id);
      if (new Set(ids).size !== ids.length) {
        violate(ctx, `duplicate_rows_in_read:${r.kind}:op${i}`);
      }
    }
  });
}

// ───────────────────────────── families ─────────────────────────────

interface Family {
  name: string;
  build: (rng: Rng, db: ScheduledDb, transport: RecordingTransport) => OpSpec[];
  /** Family-specific checks run after the common invariants. */
  check?: (ctx: IterationContext) => void;
  /** Whether `random` scheduling order is meaningful for the family. */
  allowRandom: boolean;
}

function writerOps(
  rng: Rng,
  ownerTag: string,
  shotId: string,
  n: number,
  options: {
    skewDays?: number;
    startSpread?: number;
    samePermit?: boolean;
  } = {},
): OpSpec[] {
  const permit = rng.uuid();
  return Array.from({ length: n }, (_, k) => {
    const version = `v${k}`;
    const analysis = makeAnalysis(rng, shotId, ownerTag, version, {
      capturedAtIso: isoAt(rng, options.skewDays ?? 0),
    });
    const permitId = options.samePermit ? permit : rng.uuid();
    return {
      kind: 'saveAnalysis' as const,
      target: shotId,
      version,
      startAfter: rng.int((options.startSpread ?? 0) + 1),
      run: view => saveAnalysis(view, analysis, permitId),
    };
  });
}

function readerOps(
  rng: Rng,
  shotId: string,
  n: number,
  spread: number,
): OpSpec[] {
  const kinds: OpKind[] = [
    'getAnalysis',
    'listShots',
    'listActivityShots',
    'listRealAnalysisFacts',
    'recentScores',
    'getShotOutboxStatus',
    'hasShotSyncReceipt',
  ];
  return Array.from({ length: n }, () => {
    const kind = rng.pick(kinds);
    const startAfter = rng.int(spread + 1);
    switch (kind) {
      case 'getAnalysis':
        return {
          kind,
          target: shotId,
          startAfter,
          run: v => getAnalysis(v, shotId),
        };
      case 'listShots':
        return { kind, startAfter, run: v => listShots(v, 100) };
      case 'listActivityShots':
        return { kind, startAfter, run: v => listActivityShots(v) };
      case 'listRealAnalysisFacts':
        return { kind, startAfter, run: v => listRealAnalysisFacts(v, null) };
      case 'recentScores':
        return { kind, startAfter, run: v => recentScores(v, null, 30) };
      case 'getShotOutboxStatus':
        return {
          kind,
          target: shotId,
          startAfter,
          run: v => getShotOutboxStatus(v, shotId),
        };
      default:
        return {
          kind: 'hasShotSyncReceipt',
          target: shotId,
          startAfter,
          run: v => hasShotSyncReceipt(v, shotId),
        };
    }
  });
}

const FAMILIES: Family[] = [
  {
    // Duplicate calls: the same saveAnalysis fired 2–6× at once (same id,
    // same permit), plus readers racing the writes.
    name: 'duplicate-save-burst',
    allowRandom: true,
    build(rng) {
      setActiveDataOwner(OWNER_A);
      const shotId = rng.uuid();
      const n = rng.range(2, 6);
      return [
        ...writerOps(rng, OWNER_A, shotId, n, {
          samePermit: true,
          startSpread: rng.int(6),
        }),
        ...readerOps(rng, shotId, rng.range(1, 3), 12),
      ];
    },
  },
  {
    // Two actors on one row: distinct payloads/permits for the same shot id,
    // call-during-call (staggered starts), clock skew on capturedAt.
    name: 'same-row-two-actors',
    allowRandom: true,
    build(rng) {
      setActiveDataOwner(rng.pick([OWNER_A, OWNER_B, GUEST_DATA_OWNER]));
      const owner = getActiveDataOwner();
      const shotId = rng.uuid();
      const ops = writerOps(rng, owner, shotId, 2, {
        skewDays: 30,
        startSpread: 8,
      });
      if (rng.chance(0.5)) {
        const abstained = makeAnalysis(rng, shotId, owner, 'abstain', {
          resultKind: 'low_confidence',
          capturedAtIso: isoAt(rng, 30),
        });
        ops.push({
          kind: 'saveLocalOnlyAnalysis',
          target: shotId,
          version: 'abstain',
          startAfter: rng.int(9),
          run: v => saveLocalOnlyAnalysis(v, abstained),
        });
      }
      ops.push(...readerOps(rng, shotId, rng.range(1, 4), 12));
      return ops;
    },
  },
  {
    // Owner rotation / logout while requests are in flight. Writes issued
    // before the switch must land under the owner that issued them; writes
    // issued after logout must be refused; nothing may cross buckets.
    name: 'rotation-logout-during-request',
    allowRandom: true,
    build(rng) {
      setActiveDataOwner(OWNER_A);
      const ops: OpSpec[] = [];
      const sharedShot = rng.uuid();
      const nWriters = rng.range(2, 5);
      for (let k = 0; k < nWriters; k++) {
        const version = `w${k}`;
        const target = rng.chance(0.5) ? sharedShot : rng.uuid();
        const permitId = rng.uuid();
        ops.push({
          kind: 'saveAnalysis',
          target,
          version,
          startAfter: rng.int(12),
          run: view => {
            // The owner is bound when the call is issued (what the repository
            // is supposed to capture), so the payload's owner tag is read at
            // that same moment.
            const owner = getActiveDataOwner();
            return saveAnalysis(
              view,
              makeAnalysis(rng, target, owner, version),
              permitId,
            );
          },
        });
      }
      const sessionId = rng.uuid();
      ops.push({
        kind: 'saveSession',
        target: sessionId,
        version: 's0',
        startAfter: rng.int(12),
        run: v =>
          saveSession(v, {
            id: sessionId,
            mode: 'practice_set',
            shotType: 'dink',
            focusCheckpoint: null,
            startedAt: isoAt(rng, 1),
          }),
      });
      const kvKey = `profile:${OWNER_A}`;
      ops.push({
        kind: 'setKv',
        target: kvKey,
        version: 'profile-a',
        startAfter: rng.int(12),
        run: v => setKv(v, kvKey, 'profile-a'),
      });
      // Rotation actors: each waits for a scheduler-chosen statement to run,
      // then flips the global owner (rotate to B, back to A, or sign out).
      const nRotations = rng.range(1, 3);
      for (let k = 0; k < nRotations; k++) {
        const next: Owner = rng.pick([
          OWNER_B,
          GUEST_DATA_OWNER,
          SIGNED_OUT_DATA_OWNER,
          OWNER_A,
        ]);
        ops.push({
          kind: 'rotateOwner',
          namedOwner: next,
          startAfter: rng.int(12),
          run: async view => {
            await view.execute('SELECT 1');
            setActiveDataOwner(next);
          },
        });
      }
      ops.push(...readerOps(rng, sharedShot, rng.range(1, 3), 16));
      return ops;
    },
  },
  {
    // Cancel-during-call: the driver fails a random statement of an
    // in-flight call (rejected promise mid-transaction). Failed calls must
    // leave nothing behind, and must not take a neighbour's committed rows
    // with them.
    name: 'cancel-during-call',
    allowRandom: true,
    build(rng, _db, transport) {
      setActiveDataOwner(rng.pick([OWNER_A, OWNER_B]));
      const owner = getActiveDataOwner();
      const ops: OpSpec[] = [];
      const shots = Array.from({ length: rng.range(1, 3) }, () => rng.uuid());
      for (const shotId of shots) {
        ops.push(
          ...writerOps(rng, owner, shotId, rng.range(1, 3), {
            startSpread: 10,
          }),
        );
      }
      const sessionId = rng.uuid();
      ops.push({
        kind: 'saveSession',
        target: sessionId,
        version: 's0',
        startAfter: rng.int(10),
        run: v =>
          saveSession(v, {
            id: sessionId,
            mode: 'practice_set',
            shotType: 'dink',
            focusCheckpoint: null,
            startedAt: isoAt(rng, 0),
          }),
      });
      for (let k = 0; k < rng.range(1, 2); k++) {
        const version = `f${k}`;
        ops.push({
          kind: 'finishSession',
          target: sessionId,
          version,
          startAfter: rng.range(4, 16),
          run: v => finishSession(v, sessionId, { version }),
        });
      }
      if (rng.chance(0.5)) {
        ops.push({
          kind: 'drainOutbox',
          startAfter: rng.range(2, 14),
          run: v => drainOutbox(v, transport),
        });
      }
      ops.push(...readerOps(rng, shots[0] ?? '', rng.range(1, 3), 16));
      return ops;
    },
  },
  {
    // Mixed call-during-call: every repository write family plus the sync
    // drain (the realistic background transaction partner) interleaved.
    name: 'mixed-call-during-call',
    allowRandom: true,
    build(rng, _db, transport) {
      setActiveDataOwner(rng.pick([OWNER_A, OWNER_B]));
      const owner = getActiveDataOwner();
      const ops: OpSpec[] = [];
      const shotId = rng.uuid();
      const sessionId = rng.uuid();
      const captureId = rng.uuid();
      const clipTime = isoAt(rng, 2);
      ops.push(
        ...writerOps(rng, owner, shotId, rng.range(1, 2), { startSpread: 12 }),
      );
      ops.push({
        kind: 'saveSession',
        target: sessionId,
        version: 's0',
        startAfter: rng.int(12),
        run: v =>
          saveSession(v, {
            id: sessionId,
            mode: 'practice_set',
            shotType: 'serve',
            focusCheckpoint: null,
            startedAt: isoAt(rng, 0),
          }),
      });
      for (let k = 0; k < rng.range(1, 3); k++) {
        const version = `f${k}`;
        ops.push({
          kind: 'finishSession',
          target: sessionId,
          version,
          startAfter: rng.range(3, 20),
          run: v => finishSession(v, sessionId, { version }),
        });
      }
      for (let k = 0; k < rng.range(1, 2); k++) {
        ops.push({
          kind: 'savePendingCapture',
          target: captureId,
          version: `c${k}`,
          startAfter: rng.int(12),
          run: v =>
            savePendingCapture(
              v,
              captureId,
              'dink',
              makeClip(captureId, clipTime),
            ),
        });
      }
      for (let k = 0; k < rng.range(1, 3); k++) {
        const stroke = rng.pick(SHOT_TYPES_FOR_STRESS);
        ops.push({
          kind: 'setDeclaredStroke',
          target: captureId,
          version: stroke,
          startAfter: rng.range(2, 20),
          run: v => setDeclaredStroke(v, captureId, stroke),
        });
      }
      if (rng.chance(0.6)) {
        ops.push({
          kind: 'markCaptureAnalyzed',
          target: captureId,
          startAfter: rng.range(2, 20),
          run: v => markCaptureAnalyzed(v, captureId),
        });
      }
      const kvKey = `${rng.pick(OWNER_SCOPED_KV_NAMESPACES)}:${owner}`;
      for (let k = 0; k < rng.range(1, 3); k++) {
        const value = `kv${k}`;
        ops.push({
          kind: 'setKv',
          target: kvKey,
          version: value,
          startAfter: rng.int(20),
          run: v => setKv(v, kvKey, value),
        });
      }
      for (let k = 0; k < rng.range(1, 2); k++) {
        ops.push({
          kind: 'drainOutbox',
          startAfter: rng.int(20),
          run: v => drainOutbox(v, transport),
        });
      }
      ops.push(
        {
          kind: 'listPendingCaptures',
          startAfter: rng.int(20),
          run: v => listPendingCaptures(v, 100),
        },
        {
          kind: 'getPendingCapture',
          target: captureId,
          startAfter: rng.int(20),
          run: v => getPendingCapture(v, captureId),
        },
        {
          kind: 'getKv',
          target: kvKey,
          startAfter: rng.int(20),
          run: v => getKv(v, kvKey),
        },
      );
      ops.push(...readerOps(rng, shotId, rng.range(1, 3), 20));
      return ops;
    },
  },
  {
    // Account purge racing another account's writes and this account's
    // reads/writes: deletion must be atomic and never bleed across owners.
    name: 'purge-vs-other-owner',
    allowRandom: true,
    build(rng, db, transport) {
      // Seed a small bucket for both owners directly (fixture rows are
      // outside the burst; ids prefixed `seed-` are excluded from actor
      // attribution).
      for (const owner of [OWNER_A, OWNER_B]) {
        for (let k = 0; k < 20; k++) {
          const id = `seed-${owner.slice(0, 4)}-${k}`;
          const analysis = makeAnalysis(rng, id, owner, 'seed');
          db.direct(
            `INSERT INTO local_shot (owner_key, id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, payload)
             VALUES (?, ?, NULL, ?, ?, ?, ?, 'scored', 'real', ?)`,
            [
              owner,
              id,
              analysis.shotType,
              analysis.capturedAtIso,
              analysis.overallScore,
              0.9,
              JSON.stringify(analysis),
            ],
          );
          db.direct(
            `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', ?)`,
            [
              owner,
              JSON.stringify({ ...analysis, analysisPermitId: rng.uuid() }),
            ],
          );
        }
        for (const namespace of OWNER_SCOPED_KV_NAMESPACES) {
          db.direct(`INSERT INTO kv (key, value) VALUES (?, ?)`, [
            `${namespace}:${owner}`,
            'seeded',
          ]);
        }
      }
      db.direct(`INSERT INTO kv (key, value) VALUES ('device.flag', 'keep')`);
      const victim: Owner = rng.pick([OWNER_A, OWNER_B]);
      const survivor: Owner = victim === OWNER_A ? OWNER_B : OWNER_A;
      setActiveDataOwner(survivor);
      const ops: OpSpec[] = [];
      ops.push({
        kind: 'purgeOwnerData',
        namedOwner: victim,
        startAfter: rng.int(10),
        run: v => purgeOwnerData(v, victim),
      });
      if (rng.chance(0.3)) {
        ops.push({
          kind: 'purgeOwnerData',
          namedOwner: victim,
          startAfter: rng.int(14),
          run: v => purgeOwnerData(v, victim),
        });
      }
      const shotId = rng.uuid();
      ops.push(
        ...writerOps(rng, survivor, shotId, rng.range(1, 3), {
          startSpread: 14,
        }),
      );
      const kvKey = `profile:${survivor}`;
      ops.push({
        kind: 'setKv',
        target: kvKey,
        version: 'survivor-profile',
        startAfter: rng.int(14),
        run: v => setKv(v, kvKey, 'survivor-profile'),
      });
      if (rng.chance(0.5)) {
        ops.push({
          kind: 'drainOutbox',
          startAfter: rng.int(14),
          run: v => drainOutbox(v, transport),
        });
      }
      ops.push(...readerOps(rng, shotId, rng.range(2, 4), 16));
      return ops;
    },
    check(ctx) {
      const { db, results } = ctx;
      const victimPurges = results.filter(r => r.kind === 'purgeOwnerData');
      const victim = victimPurges[0]?.namedOwner;
      if (!victim) return;
      const survivor = victim === OWNER_A ? OWNER_B : OWNER_A;
      // Survivor's seeded bucket must be intact regardless of purge outcome.
      const survivorShots = count(
        db,
        `SELECT count(*) AS n FROM local_shot WHERE owner_key = ? AND id LIKE 'seed-%'`,
        [survivor],
      );
      if (survivorShots !== 20)
        violate(ctx, `purge_collateral_shots:${survivor}:${survivorShots}`);
      const survivorKv = count(
        db,
        `SELECT count(*) AS n FROM kv WHERE key IN (${OWNER_SCOPED_KV_NAMESPACES.map(() => '?').join(',')})`,
        OWNER_SCOPED_KV_NAMESPACES.map(ns => `${ns}:${survivor}`),
      );
      if (survivorKv !== OWNER_SCOPED_KV_NAMESPACES.length)
        violate(ctx, `purge_collateral_kv:${survivor}:${survivorKv}`);
      if (
        count(
          db,
          `SELECT count(*) AS n FROM kv WHERE key = 'device.flag'`,
          [],
        ) !== 1
      ) {
        violate(ctx, 'purge_collateral_device_kv');
      }
      // Atomicity: if every purge failed, the victim bucket is untouched.
      if (victimPurges.every(p => p.state === 'error')) {
        const victimShots = count(
          db,
          `SELECT count(*) AS n FROM local_shot WHERE owner_key = ?`,
          [victim],
        );
        if (victimShots !== 20)
          violate(ctx, `purge_partial_after_failure:${victim}:${victimShots}`);
      }
    },
  },
  {
    // Volume: 10k rows per owner with duplicated ids ACROSS owners, plus
    // fixture-source rows that must never surface; deletes (purge) run while
    // unbounded reads are in flight.
    name: 'volume-10k-deletes-during-reads',
    allowRandom: true,
    build(rng, db, transport) {
      const insert = db.raw.prepare(
        `INSERT OR REPLACE INTO local_shot (owner_key, id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, payload)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      );
      db.raw.exec('BEGIN');
      for (let k = 0; k < VOLUME_ROWS; k++) {
        const id = `seed-${k}`;
        for (const owner of [OWNER_A, OWNER_B]) {
          const analysis = makeAnalysis(rng, id, owner, 'seed', {
            resultKind: k % 7 === 0 ? 'low_confidence' : 'scored',
            capturedAtIso: new Date(
              EPOCH_MS - k * 61_000 + (k % 5) * 86_400_000,
            ).toISOString(),
          });
          insert.run(
            owner,
            id,
            analysis.shotType,
            analysis.capturedAtIso,
            analysis.overallScore,
            analysis.analysisConfidence,
            analysis.resultKind,
            'real',
            JSON.stringify(analysis),
          );
        }
        if (k % 100 === 0) {
          // Duplicate write of the same id (INSERT OR REPLACE) — must not add rows.
          const dupe = makeAnalysis(rng, id, OWNER_A, 'seed');
          insert.run(
            OWNER_A,
            id,
            dupe.shotType,
            dupe.capturedAtIso,
            dupe.overallScore,
            0.9,
            'scored',
            'real',
            JSON.stringify(dupe),
          );
        }
        if (k % 250 === 0) {
          // Legacy fixture-source rows: filtered by every read.
          const fixture = makeAnalysis(rng, `fixture-${k}`, OWNER_A, 'fixture');
          insert.run(
            OWNER_A,
            `fixture-${k}`,
            fixture.shotType,
            fixture.capturedAtIso,
            5,
            0.9,
            'scored',
            'fixture',
            JSON.stringify(fixture),
          );
        }
      }
      db.raw.exec('COMMIT');
      setActiveDataOwner(OWNER_A);
      const ops: OpSpec[] = [];
      const spread = 6;
      ops.push(
        {
          kind: 'listActivityShots',
          startAfter: rng.int(spread),
          run: v => listActivityShots(v),
        },
        {
          kind: 'listRealAnalysisFacts',
          startAfter: rng.int(spread),
          run: v => listRealAnalysisFacts(v, null),
        },
        {
          kind: 'listShots',
          startAfter: rng.int(spread),
          run: v => listShots(v, VOLUME_ROWS + 100),
        },
        {
          kind: 'recentScores',
          startAfter: rng.int(spread),
          run: v => recentScores(v, null, VOLUME_ROWS),
        },
      );
      const victim: Owner = rng.chance(0.7) ? OWNER_A : OWNER_B;
      ops.push({
        kind: 'purgeOwnerData',
        namedOwner: victim,
        startAfter: rng.int(spread),
        run: v => purgeOwnerData(v, victim),
      });
      const shotId = rng.uuid();
      ops.push(...writerOps(rng, OWNER_A, shotId, 1, { startSpread: spread }));
      if (rng.chance(0.4)) {
        ops.push({
          kind: 'drainOutbox',
          startAfter: rng.int(spread),
          run: v => drainOutbox(v, transport),
        });
      }
      return ops;
    },
    check(ctx) {
      const { db, results } = ctx;
      const purgeIndex = results.findIndex(r => r.kind === 'purgeOwnerData');
      const purge = results[purgeIndex];
      const purgeDeleteSeq =
        purge?.state === 'ok'
          ? stmtSeq(db, purgeIndex, /DELETE FROM local_shot/, 'first')
          : null;
      const purgeCommitSeq =
        purge?.state === 'ok' ? stmtSeq(db, purgeIndex, /^COMMIT$/) : null;
      const victim = purge?.namedOwner;
      const expectedRealRows = VOLUME_ROWS; // one per id under OWNER_A (dupes replaced, fixtures filtered)
      // Every 7th seed row abstains, except where the every-100th duplicate
      // write replaced it with a scored payload.
      let expectedScored = 0;
      for (let k = 0; k < VOLUME_ROWS; k++) {
        if (k % 7 !== 0 || k % 100 === 0) expectedScored += 1;
      }
      // recentScores returns bare numbers, so the burst writer's own scored
      // row (if it landed) is indistinguishable from a seed row.
      const okScoredWriters = results.filter(
        r => r.state === 'ok' && r.kind === 'saveAnalysis',
      ).length;
      results.forEach((r, i) => {
        if (r.state !== 'ok') return;
        if (
          ![
            'listActivityShots',
            'listRealAnalysisFacts',
            'listShots',
            'recentScores',
          ].includes(r.kind)
        )
          return;
        const selectSeq = stmtSeq(db, i, /SELECT/);
        if (selectSeq === null) return;
        const afterDelete =
          victim === OWNER_A &&
          purgeDeleteSeq !== null &&
          selectSeq > purgeDeleteSeq;
        const rows = r.value as unknown[];
        const seedRows = rows.filter(row => {
          if (typeof row === 'number') return true;
          return String((row as { id: string }).id).startsWith('seed-');
        }).length;
        const expected =
          r.kind === 'recentScores'
            ? afterDelete
              ? 0
              : expectedScored
            : afterDelete
              ? 0
              : expectedRealRows;
        // recentScores also excludes low_confidence; listRealAnalysisFacts
        // may additionally drop malformed rows (none here).
        const tolerated =
          r.kind === 'recentScores' && !afterDelete
            ? seedRows >= expected && seedRows <= expected + okScoredWriters
            : seedRows === expected;
        if (!tolerated) {
          violate(
            ctx,
            `volume_read_count:${r.kind}:op${i}:got=${seedRows}:expected=${expected}:afterDelete=${afterDelete}`,
          );
        }
        if (r.kind !== 'recentScores') {
          const ids = rows.map(row => String((row as { id: string }).id));
          if (ids.some(id => id.startsWith('fixture-')))
            violate(ctx, `fixture_leak:${r.kind}:op${i}`);
          if (new Set(ids).size !== ids.length)
            violate(ctx, `duplicate_rows_in_read:${r.kind}:op${i}`);
        }
        if (r.kind === 'listShots' || r.kind === 'listActivityShots') {
          const stamps = (rows as Array<{ capturedAt: string }>).map(
            row => row.capturedAt,
          );
          const sorted = [...stamps].sort();
          if (
            r.kind === 'listActivityShots' &&
            stamps.join('|') !== sorted.join('|')
          ) {
            violate(ctx, `order_violation:listActivityShots:op${i}`);
          }
          if (
            r.kind === 'listShots' &&
            stamps.join('|') !== sorted.reverse().join('|')
          ) {
            violate(ctx, `order_violation:listShots:op${i}`);
          }
        }
      });
      // Other owner's 10k rows survive a purge of the victim.
      const other = victim === OWNER_A ? OWNER_B : OWNER_A;
      const otherRows = count(
        db,
        `SELECT count(*) AS n FROM local_shot WHERE owner_key = ? AND id LIKE 'seed-%'`,
        [other],
      );
      if (otherRows !== VOLUME_ROWS)
        violate(ctx, `purge_collateral_volume:${other}:${otherRows}`);
      if (purgeCommitSeq !== null && victim) {
        const victimSeed = count(
          db,
          `SELECT count(*) AS n FROM local_shot WHERE owner_key = ? AND id LIKE 'seed-%'`,
          [victim],
        );
        if (victimSeed !== 0)
          violate(ctx, `purge_incomplete_volume:${victim}:${victimSeed}`);
      }
    },
  },
];

// ───────────────────────────── driver ─────────────────────────────

interface IterationRecord {
  seed: number;
  family: string;
  order: OrderMode;
  faultRate: number;
  ops: number;
  okOps: number;
  errorOps: number;
  errorClasses: string[];
  statements: number;
  durationMs: number;
  outcome: 'HELD' | 'BROKEN';
  violations: string[];
  /** Statement-level schedule (BROKEN iterations only): `seq:opN:outcome:sql`. */
  trace?: string[];
  opResults?: string[];
}

const report: IterationRecord[] = [];

function traceOf(db: ScheduledDb): string[] {
  return db.executed.map(
    s =>
      `${s.seq}:op${s.opId}:${s.outcome}${s.error ? `(${s.error})` : ''}:${s.sql
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 72)}`,
  );
}

async function runIteration(
  family: Family,
  seed: number,
): Promise<IterationRecord> {
  const rng = new Rng(seed);
  const order: OrderMode =
    ORDER_MODE === 'mixed'
      ? family.allowRandom && rng.chance(0.5)
        ? 'random'
        : 'fifo'
      : ORDER_MODE;
  const faultRate =
    family.name === 'cancel-during-call'
      ? rng.pick([0.05, 0.1, 0.2])
      : rng.chance(0.25)
        ? rng.pick([0.02, 0.05])
        : 0;
  const db = new ScheduledDb();
  const transport = new RecordingTransport();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  try {
    const specs = family.build(rng, db, transport);
    const outcome = await runBurst(db, rng, specs, order, faultRate);
    const ctx: IterationContext = {
      db,
      results: outcome.results,
      transport,
      violations: [],
      purgeCommitSeq: new Map(),
    };
    if (outcome.hung)
      violate(ctx, `hang:wall_budget_or_idle:${outcome.durationMs}ms`);
    if (!db.isIdle()) violate(ctx, 'transaction_left_open_after_burst');
    checkCommonInvariants(ctx);
    family.check?.(ctx);
    const errorClasses = Array.from(
      new Set(
        outcome.results
          .filter(r => r.state === 'error')
          .map(r =>
            (r.error ?? '').replace(/[0-9a-f-]{36}/g, '<id>').slice(0, 90),
          ),
      ),
    );
    return {
      seed,
      family: family.name,
      order,
      faultRate,
      ops: specs.length,
      okOps: outcome.results.filter(r => r.state === 'ok').length,
      errorOps: outcome.results.filter(r => r.state === 'error').length,
      errorClasses,
      statements: outcome.stmtCount,
      durationMs: outcome.durationMs,
      outcome: ctx.violations.length === 0 ? 'HELD' : 'BROKEN',
      violations: ctx.violations,
      ...(ctx.violations.length > 0
        ? {
            trace: traceOf(db).slice(0, 400),
            opResults: outcome.results.map(
              (r, i) =>
                `op${i}:${r.kind}:${r.state}:owner=${r.ownerAtStart}${r.target ? `:target=${r.target}` : ''}${r.error ? `:${r.error}` : ''}`,
            ),
          }
        : {}),
    };
  } finally {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    db.close();
  }
}

function seedsFor(familyIndex: number): number[] {
  if (ONLY_SEEDS.length > 0) return ONLY_SEEDS;
  return Array.from({ length: ITER }, (_, i) =>
    iterationSeed(BASE_SEED, familyIndex, i),
  );
}

describe('repository concurrency stress (seeded scheduler)', () => {
  afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

  afterAll(() => {
    if (!REPORT_PATH) return;
    const summary = {
      config: {
        ITER,
        BASE_SEED,
        ORDER_MODE,
        ONLY_SEEDS,
        TOLERATE_NESTED_BEGIN,
        WALL_BUDGET_MS,
        VOLUME_ROWS,
        node: process.version,
      },
      totals: {
        iterations: report.length,
        held: report.filter(r => r.outcome === 'HELD').length,
        broken: report.filter(r => r.outcome === 'BROKEN').length,
        statements: report.reduce((sum, r) => sum + r.statements, 0),
        ops: report.reduce((sum, r) => sum + r.ops, 0),
      },
      byFamily: FAMILIES.map(f => {
        const rows = report.filter(r => r.family === f.name);
        return {
          family: f.name,
          iterations: rows.length,
          held: rows.filter(r => r.outcome === 'HELD').length,
          broken: rows.filter(r => r.outcome === 'BROKEN').length,
          violationKinds: Array.from(
            new Set(
              rows.flatMap(r => r.violations.map(v => v.split(':')[0] ?? v)),
            ),
          ),
        };
      }),
      iterations: report,
    };
    mkdirSync(dirname(REPORT_PATH), { recursive: true });
    writeFileSync(REPORT_PATH, JSON.stringify(summary, null, 2));
  });

  it('replays deterministically from a seed', async () => {
    const family = FAMILIES[1];
    if (!family) throw new Error('family missing');
    const a = await runIteration(family, 424242);
    const b = await runIteration(family, 424242);
    expect({ ...b, durationMs: 0 }).toEqual({ ...a, durationMs: 0 });
  });

  it('models the single-connection driver: a nested BEGIN fails in SQLite', () => {
    const db = new ScheduledDb();
    db.direct('BEGIN IMMEDIATE');
    expect(() => db.direct('BEGIN IMMEDIATE')).toThrow(/within a transaction/);
    db.direct('ROLLBACK');
    db.close();
  });

  describe.each(
    FAMILIES.map((family, index) => [family.name, family, index] as const),
  )('%s', (_name, family, familyIndex) => {
    const seeds = seedsFor(familyIndex);
    it(`holds every invariant across ${seeds.length} seeded interleavings`, async () => {
      const broken: IterationRecord[] = [];
      for (const seed of seeds) {
        const record = await runIteration(family, seed);
        report.push(record);
        if (record.outcome === 'BROKEN') broken.push(record);
      }
      expect(
        broken.map(r => ({
          seed: r.seed,
          order: r.order,
          faultRate: r.faultRate,
          violations: r.violations.slice(0, 6),
          errorClasses: r.errorClasses,
        })),
      ).toEqual([]);
    }, 600_000);
  });
});
