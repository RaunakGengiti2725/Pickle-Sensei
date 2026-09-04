/**
 * STRESS — unit `mod-repository`, lens `boundary-malformed`.
 *
 * Drives the REAL repository (src/data/repository.ts) and account scope
 * (src/data/accountScope.ts) against a REAL SQLite database opened through
 * the production `getDb()` migrations (node:sqlite behind the op-sqlite seam),
 * with seeded malformed / boundary inputs at every trust boundary the module
 * has:
 *
 *   payload-read     corrupt/truncated/hostile JSON already in local_shot →
 *                    every reader settles, no write, no prototype pollution,
 *                    facts are strictly shaped.
 *   write-malformed  wrong-typed / hostile ShotAnalysis objects into
 *                    saveAnalysis → typed rejection with ZERO rows written
 *                    (atomic), or an accepted row whose columns agree with
 *                    its payload; signed-out never reaches SQLite.
 *   capture-rows     corrupt local_capture payloads + hostile clip objects →
 *                    evidenceStatus is exactly the independent oracle's
 *                    verdict, duplicate URIs reject atomically.
 *   limits           NaN/±Infinity/-0/2^53+1/strings/bigint as `limit` →
 *                    bounded result or typed rejection, never "all rows".
 *   account-scope    homoglyphs, NFC/NFD pairs, zero-width, NUL, version /
 *                    variant nibbles, traversal, wrong types → accept iff
 *                    the strict ASCII UUID rule says so; rejection leaves
 *                    the active owner untouched.
 *   isolation-10k    10 000 rows across 3 owners with duplicate ids, purge
 *                    of one owner racing reads of another, SQLite faults
 *                    mid-purge → reads never see foreign rows, purge is
 *                    all-or-nothing, integrity_check ok.
 *   kv-session-json  hostile kv values / session summaries round-trip as
 *                    opaque text or reject; never a throw out of the store.
 *   outbox-torn      a torn outbox payload beside valid rows → shot sync
 *                    status must still be answerable.
 *   analysis-record  corrupt analysis_record payloads → readers settle.
 *
 * Deterministic: every row is `<family>:<seed>`; replay a single scenario with
 * STRESS_ONLY=<family>:<seed>. Scale with STRESS_ITER (default 300, campaign
 * ≥ 3000). Rows + summary are written under
 * artifacts/stress/mod-repository-boundary-malformed/ (gitignored).
 *
 * Needs node:sqlite — on Node 22.5–22.12 run with
 * NODE_OPTIONS=--experimental-sqlite. When unavailable the suite FAILS
 * (a skipped stage is not a pass).
 */
import type { ShotAnalysis } from '@pickle/shared-types';
import type { CapturedClip } from '../../src/camera/capture';
import { assertCapturedClip } from '../../src/camera/capture';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import type { LocalDb } from '../../src/data/db';
import { getDb } from '../../src/data/db';
import {
  finishSession,
  getAnalysis,
  getCaptureTargetSeed,
  getKv,
  getPendingCapture,
  getShotOutboxStatus,
  hasShotSyncReceipt,
  listActivityShots,
  listAnalysisRecords,
  listCaptureHistory,
  listLiveSessionHistory,
  listPendingCaptures,
  listRealAnalysisFacts,
  listScoredCheckpointFacts,
  listShots,
  purgeOwnerData,
  recentScores,
  saveAnalysis,
  savePendingCapture,
  saveSession,
  setKv,
} from '../../src/data/repository';
import {
  loadNodeSqlite,
  nodeProcess,
  type SqlInputValue,
} from '../../xc-harness/lifecycle-persistence/nodeShim';
import { pick } from '../../xc-harness/lifecycle-persistence/seeds';
import {
  LIMIT_VALUES,
  LIMIT_VALUE_NAMES,
  OWNER_A,
  OWNER_B,
  OWNER_C,
  PAYLOAD_TEXTS,
  PAYLOAD_TEXT_NAMES,
  RUNTIME_VALUES,
  RUNTIME_VALUE_NAMES,
  STRICT_UUID,
  TEXT_CORRUPTIONS,
  compactForJson,
  corruptText,
  finishRow,
  looseStringify,
  mutateAnalysis,
  ownerCandidate,
  replayTarget,
  seededRng,
  setPath,
  stressIterations,
  summarize,
  validAnalysis,
  writeJsonArtifact,
  type StressRow,
} from '../../xc-harness/stress/repositoryBoundaryMalformed';

const sqlite = loadNodeSqlite();

// ─── op-sqlite seam: statement log + fault injection ─────────────────────────

const mockSqlite = {
  statements: [] as Array<{ sql: string; params: unknown[]; ok: boolean }>,
  /** When set, a statement matching the predicate throws instead of running. */
  fault: null as ((sql: string, params: unknown[]) => Error | null) | null,
  open() {
    if (!sqlite) throw new Error('node:sqlite unavailable');
    const inner = new sqlite.DatabaseSync(':memory:');
    const run = (sql: string, params: unknown[]) => {
      const entry = { sql, params, ok: false };
      mockSqlite.statements.push(entry);
      const injected = mockSqlite.fault?.(sql, params) ?? null;
      if (injected) throw injected;
      const rows = inner
        .prepare(sql)
        .all(...(params as SqlInputValue[])) as Record<string, unknown>[];
      entry.ok = true;
      return { rows };
    };
    return {
      executeSync: (sql: string, params: unknown[] = []) => run(sql, params),
      execute: async (sql: string, params: unknown[] = []) => run(sql, params),
      close: () => inner.close(),
    };
  },
};

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => mockSqlite.open(),
}));

// ─── helpers ─────────────────────────────────────────────────────────────────

const WRITE_SQL =
  /^\s*(INSERT|UPDATE|DELETE|REPLACE|BEGIN|COMMIT|ROLLBACK|CREATE|DROP|ALTER)/i;

/** Write statements that actually EXECUTED since `mark` (a bind/constraint
 * failure before execution is a rejection, not a write). */
function writesSince(mark: number): string[] {
  return mockSqlite.statements
    .slice(mark)
    .filter(s => s.ok && WRITE_SQL.test(s.sql))
    .map(s => s.sql);
}

/** What the SQLite driver itself hands back for `text` (node:sqlite reads
 * TEXT as a C string — truncates at NUL — and replaces lone surrogates with
 * U+FFFD). The repository must lose nothing BEYOND the driver. */
async function driverEcho(db: LocalDb, text: string): Promise<unknown> {
  const { rows } = await db.execute(`SELECT ? AS v`, [text]);
  return rows[0]?.['v'];
}

async function settle<T>(
  run: () => Promise<T>,
): Promise<
  | { kind: 'ok'; value: T }
  | { kind: 'error'; error: Error }
  | { kind: 'non-error-throw'; thrown: unknown }
> {
  try {
    return { kind: 'ok', value: await run() };
  } catch (thrown) {
    return isErrorLike(thrown)
      ? { kind: 'error', error: thrown }
      : { kind: 'non-error-throw', thrown };
  }
}

/** `instanceof Error` is realm-bound: node:sqlite raises its SQLITE_* /
 * ERR_INVALID_ARG_TYPE errors in the host realm, outside jest's vm context.
 * A typed error is anything with the Error shape + tag. */
function isErrorLike(thrown: unknown): thrown is Error {
  return (
    thrown instanceof Error ||
    (Object.prototype.toString.call(thrown) === '[object Error]' &&
      typeof (thrown as { message?: unknown }).message === 'string')
  );
}

function errorSummary(
  outcome: Awaited<ReturnType<typeof settle>>,
): Record<string, unknown> {
  if (outcome.kind === 'ok') return { kind: 'ok' };
  if (outcome.kind === 'error') {
    return {
      kind: 'error',
      name: outcome.error.constructor.name,
      message: outcome.error.message.slice(0, 160),
    };
  }
  return { kind: 'non-error-throw', thrown: outcome.thrown };
}

function protoClean(): boolean {
  const probe: Record<string, unknown> = {};
  return (
    probe['polluted'] === undefined &&
    Object.keys(Object.prototype).length === 0 &&
    !('polluted' in Object.prototype) &&
    !('polluted' in Array.prototype)
  );
}

async function rowCount(db: LocalDb, table: string): Promise<number> {
  const { rows } = await db.execute(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(rows[0]?.['n']);
}

async function rawInsertShot(
  db: LocalDb,
  owner: string,
  id: string,
  capturedAt: string,
  payload: string,
  options: { source?: string; overallScore?: number | null } = {},
): Promise<void> {
  await db.execute(
    `INSERT OR REPLACE INTO local_shot
     (owner_key,id,session_id,shot_type,captured_at,overall_score,confidence,result_kind,source,favorite,payload)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      owner,
      id,
      null,
      'dink',
      capturedAt,
      options.overallScore === undefined ? 7.2 : options.overallScore,
      0.86,
      'scored',
      options.source ?? 'real',
      0,
      payload,
    ],
  );
}

function isoAt(index: number): string {
  return new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString();
}

const FAMILY_WEIGHTS: Record<string, number> = {
  'payload-read': 0.22,
  'write-malformed': 0.18,
  'capture-rows': 0.12,
  limits: 0.08,
  'account-scope': 0.14,
  'isolation-10k': 0.06,
  'kv-session-json': 0.1,
  'outbox-torn': 0.05,
  'analysis-record': 0.05,
};

const TOTAL_ITER = stressIterations();
const REPLAY = replayTarget();

function seedsFor(family: string): number[] {
  if (REPLAY) return REPLAY.family === family ? [REPLAY.seed] : [];
  const n = Math.max(1, Math.round(TOTAL_ITER * (FAMILY_WEIGHTS[family] ?? 0)));
  return Array.from({ length: n }, (_, i) => i + 1);
}

const allRows: StressRow[] = [];

function record(rows: StressRow[]): void {
  allRows.push(...rows);
}

function failures(rows: StressRow[]): string[] {
  return rows
    .filter(row => !row.ok)
    .map(
      row =>
        `${row.family}:${row.seed} failed=[${row.failed.join(',')}] inputs=${JSON.stringify(row.inputs)} observed=${JSON.stringify(row.observed)}`,
    );
}

function freshDb(): LocalDb {
  mockSqlite.fault = null;
  mockSqlite.statements = [];
  const db = getDb();
  return db;
}

async function clearAll(db: LocalDb): Promise<void> {
  for (const table of [
    'local_shot',
    'local_session',
    'local_capture',
    'outbox',
    'sync_receipt',
    'local_analysis_record',
    'kv',
  ]) {
    await db.execute(`DELETE FROM ${table}`);
  }
}

// Strict shape oracles for what the readers promise their consumers.
function isFiniteOrNull(value: unknown): boolean {
  return (
    value === null || (typeof value === 'number' && Number.isFinite(value))
  );
}

function factWellFormed(fact: Record<string, unknown>): boolean {
  const scores = fact['checkpointScores'];
  return (
    typeof fact['id'] === 'string' &&
    typeof fact['shotType'] === 'string' &&
    typeof fact['capturedAt'] === 'string' &&
    isFiniteOrNull(fact['overallScore']) &&
    typeof fact['confidence'] === 'number' &&
    Number.isFinite(fact['confidence']) &&
    (fact['resultKind'] === 'scored' ||
      fact['resultKind'] === 'low_confidence') &&
    typeof fact['scoringModelVersion'] === 'string' &&
    typeof fact['shotConfigVersion'] === 'string' &&
    (fact['sessionId'] === null || typeof fact['sessionId'] === 'string') &&
    (fact['priorityCheckpoint'] === null ||
      typeof fact['priorityCheckpoint'] === 'string') &&
    scores !== null &&
    typeof scores === 'object' &&
    !Array.isArray(scores) &&
    Object.entries(scores as Record<string, unknown>).every(
      ([key, score]) =>
        key !== '__proto__' &&
        key !== 'undefined' &&
        key !== '[object Object]' &&
        typeof score === 'number' &&
        Number.isFinite(score),
    )
  );
}

function checkpointFactWellFormed(fact: Record<string, unknown>): boolean {
  const checkpoints = fact['checkpoints'];
  return (
    typeof fact['id'] === 'string' &&
    typeof fact['shotType'] === 'string' &&
    typeof fact['capturedAt'] === 'string' &&
    Array.isArray(checkpoints) &&
    checkpoints.every(
      cp =>
        cp !== null &&
        typeof cp === 'object' &&
        typeof (cp as Record<string, unknown>)['key'] === 'string' &&
        (cp as Record<string, unknown>)['key'] !== 'undefined' &&
        (cp as Record<string, unknown>)['key'] !== '[object Object]' &&
        isFiniteOrNull((cp as Record<string, unknown>)['score']) &&
        typeof (cp as Record<string, unknown>)['applicable'] === 'boolean',
    )
  );
}

function shotRowWellFormed(shot: Record<string, unknown>): boolean {
  return (
    typeof shot['id'] === 'string' &&
    typeof shot['shotType'] === 'string' &&
    typeof shot['capturedAt'] === 'string' &&
    isFiniteOrNull(shot['overallScore']) &&
    typeof shot['confidence'] === 'number' &&
    Number.isFinite(shot['confidence']) &&
    typeof shot['favorite'] === 'boolean' &&
    (shot['sessionId'] === null || typeof shot['sessionId'] === 'string')
  );
}

const CLIP_BASE: CapturedClip = {
  uri: 'file:///private/captures/real.mov',
  durationMs: 3900,
  fps: 59.94,
  width: 720,
  height: 1280,
  capturedAtIso: '2026-08-27T18:00:00.000Z',
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

const CLIP_FIELD_PATHS: readonly string[] = [
  'uri',
  'durationMs',
  'fps',
  'width',
  'height',
  'capturedAtIso',
  'captureMode',
  'recognition',
  'recognition.status',
  'trigger',
  'trigger.confidence',
  'captureEvidence',
  'captureEvidence.schemaVersion',
  'captureEvidence.jointMotion',
  'ballSpeed',
  'preRollMs',
  'postRollMs',
  'posterUri',
  '__proto__',
  'extraUnknownField',
];

/** Independent oracle for `evidenceStatus` (mirrors the documented contract:
 * NULL payload → legacy, unparsable/invalid → corrupt, metadata drift →
 * metadata_mismatch, else valid). */
function expectedEvidenceStatus(
  payload: string | null,
  columns: {
    uri: string;
    capturedAt: string;
    durationMs: number;
    fps: number;
    width: number;
    height: number;
  },
): 'legacy' | 'valid' | 'corrupt' | 'metadata_mismatch' {
  if (payload === null) return 'legacy';
  try {
    const clip = assertCapturedClip(JSON.parse(payload));
    const matches =
      clip.uri === columns.uri &&
      clip.capturedAtIso === columns.capturedAt &&
      clip.durationMs === columns.durationMs &&
      clip.fps === columns.fps &&
      clip.width === columns.width &&
      clip.height === columns.height;
    return matches ? 'valid' : 'metadata_mismatch';
  } catch {
    return 'corrupt';
  }
}

// ─── suite ───────────────────────────────────────────────────────────────────

describe('STRESS mod-repository boundary-malformed', () => {
  beforeAll(() => {
    if (!sqlite) {
      throw new Error(
        `node:sqlite unavailable on ${nodeProcess.version}; run with NODE_OPTIONS=--experimental-sqlite (Node 22.5–22.12) or Node >= 22.13`,
      );
    }
  });

  afterEach(() => {
    mockSqlite.fault = null;
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  });

  afterAll(() => {
    if (allRows.length === 0) return;
    const summary: Record<string, unknown> = {
      unit: 'mod-repository',
      lens: 'boundary-malformed',
      node: nodeProcess.version,
      stressIter: TOTAL_ITER,
      replay: REPLAY,
      ...summarize(allRows),
    };
    const rowsFile = writeJsonArtifact('rows.json', allRows);
    const summaryFile = writeJsonArtifact('summary.json', summary);
    console.log(
      `[stress mod-repository/boundary-malformed] scenarios=${allRows.length} failed=${summary.failed} rows=${rowsFile} summary=${summaryFile}`,
    );
  });

  // ── payload-read ──────────────────────────────────────────────────────────
  it('payload-read: corrupt local_shot payloads never escape a reader or write', async () => {
    const family = 'payload-read';
    const db = freshDb();
    const rows: StressRow[] = [];
    for (const seed of seedsFor(family)) {
      const rng = seededRng(family, seed);
      const startedAt = Date.now();
      setActiveDataOwner(OWNER_A);
      await clearAll(db);

      // 3 healthy rows + 1 corrupted row (+ an alien-owner row that must never leak).
      const healthy: ShotAnalysis[] = [0, 1, 2].map(i =>
        validAnalysis(`healthy-${i}`, isoAt(i)),
      );
      for (const analysis of healthy) {
        await rawInsertShot(
          db,
          OWNER_A,
          analysis.id,
          analysis.capturedAtIso,
          JSON.stringify(analysis),
        );
      }
      await rawInsertShot(
        db,
        OWNER_B,
        'alien',
        isoAt(50),
        JSON.stringify(validAnalysis('alien', isoAt(50))),
      );

      let payloadText: string;
      const inputs: Record<string, unknown> = {};
      if (rng() < 0.4) {
        const name = pick(rng, PAYLOAD_TEXT_NAMES);
        payloadText = PAYLOAD_TEXTS[name] as string;
        inputs['payload'] = name;
      } else {
        const mutationCount = 1 + Math.floor(rng() * 3);
        const { analysis, mutations } = mutateAnalysis(
          rng,
          validAnalysis('corrupt', isoAt(10)),
          mutationCount,
        );
        const corruption = pick(rng, TEXT_CORRUPTIONS);
        payloadText = corruptText(rng, looseStringify(analysis), corruption);
        inputs['mutations'] = mutations;
        inputs['corruption'] = corruption;
      }
      const corruptSource = rng() < 0.85 ? 'real' : 'fixture';
      inputs['sourceColumn'] = corruptSource;
      await rawInsertShot(db, OWNER_A, 'corrupt', isoAt(10), payloadText, {
        source: corruptSource,
      });

      const mark = mockSqlite.statements.length;
      const [
        shots,
        activity,
        corrupt,
        scores,
        facts,
        cpFacts,
        receipt,
        outbox,
      ] = await Promise.all([
        settle(() => listShots(db, 100)),
        settle(() => listActivityShots(db)),
        settle(() => getAnalysis(db, 'corrupt')),
        settle(() => recentScores(db, 'dink', 10)),
        settle(() => listRealAnalysisFacts(db, null)),
        settle(() => listScoredCheckpointFacts(db, 10)),
        settle(() => hasShotSyncReceipt(db, 'corrupt')),
        settle(() => getShotOutboxStatus(db, 'corrupt')),
      ]);
      const writes = writesSince(mark);

      const factRows =
        facts.kind === 'ok'
          ? (facts.value as unknown as Record<string, unknown>[])
          : [];
      const cpRows =
        cpFacts.kind === 'ok'
          ? (cpFacts.value as unknown as Record<string, unknown>[])
          : [];
      const shotRows =
        shots.kind === 'ok'
          ? (shots.value as unknown as Record<string, unknown>[])
          : [];

      const invariants: Record<string, boolean> = {
        listShotsSettles: shots.kind === 'ok',
        listActivitySettles: activity.kind === 'ok',
        // getAnalysis is documented as parse-or-throw (its one consumer
        // catches); the invariant is a TYPED throw, never a foreign value.
        getAnalysisTyped: corrupt.kind !== 'non-error-throw',
        recentScoresSettles: scores.kind === 'ok',
        realFactsSettles: facts.kind === 'ok',
        checkpointFactsSettles: cpFacts.kind === 'ok',
        receiptSettles: receipt.kind === 'ok',
        outboxStatusSettles: outbox.kind === 'ok',
        noWrites: writes.length === 0,
        protoClean: protoClean(),
        healthyFactsPreserved:
          facts.kind === 'ok' &&
          healthy.every(h => factRows.some(f => f['id'] === h.id)),
        factsStrictlyShaped: factRows.every(factWellFormed),
        checkpointFactsStrictlyShaped: cpRows.every(checkpointFactWellFormed),
        shotRowsStrictlyShaped: shotRows.every(shotRowWellFormed),
        noForeignOwnerLeak:
          !shotRows.some(s => s['id'] === 'alien') &&
          !factRows.some(f => f['id'] === 'alien'),
        recentScoresFinite:
          scores.kind === 'ok' &&
          (scores.value as number[]).every(n => Number.isFinite(n)),
      };

      rows.push(
        finishRow(
          family,
          seed,
          startedAt,
          inputs,
          {
            listShots: errorSummary(shots),
            getAnalysis: errorSummary(corrupt),
            getAnalysisValueType:
              corrupt.kind === 'ok' ? typeof corrupt.value : undefined,
            facts: errorSummary(facts),
            factsFromCorrupt: factRows.filter(f => f['id'] === 'corrupt'),
            cpFromCorrupt: cpRows.filter(f => f['id'] === 'corrupt'),
            shotsFromCorrupt: shotRows.filter(s => s['id'] === 'corrupt'),
            recentScores: scores.kind === 'ok' ? scores.value : undefined,
            outbox: errorSummary(outbox),
            writes,
          },
          invariants,
        ),
      );
    }
    db.close();
    record(rows);
    expect(failures(rows)).toEqual([]);
  });

  // ── write-malformed ───────────────────────────────────────────────────────
  it('write-malformed: hostile ShotAnalysis objects reject atomically or land consistently', async () => {
    const family = 'write-malformed';
    const db = freshDb();
    const rows: StressRow[] = [];
    for (const seed of seedsFor(family)) {
      const rng = seededRng(family, seed);
      const startedAt = Date.now();
      await clearAll(db);
      mockSqlite.fault = null;

      // Pre-existing data for two owners (must be untouched by a failed write).
      setActiveDataOwner(OWNER_B);
      await saveAnalysis(db, validAnalysis('b-existing', isoAt(1)), 'permit-b');
      setActiveDataOwner(OWNER_A);
      await saveAnalysis(db, validAnalysis('a-existing', isoAt(2)), 'permit-a');

      const signedOut = rng() < 0.08;
      if (signedOut) setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
      const permitName =
        rng() < 0.75 ? 'valid' : pick(rng, RUNTIME_VALUE_NAMES);
      const permitId =
        permitName === 'valid'
          ? 'permit-candidate'
          : RUNTIME_VALUES[permitName];

      const mutationCount = rng() < 0.1 ? 0 : 1 + Math.floor(rng() * 3);
      const { analysis, mutations } = mutateAnalysis(
        rng,
        validAnalysis('candidate', isoAt(5)),
        mutationCount,
      );
      const injectFault = !signedOut && rng() < 0.1;
      const faultStage = pick(rng, ['outbox', 'commit'] as const);
      if (injectFault) {
        mockSqlite.fault = sql =>
          (faultStage === 'outbox' && /INSERT INTO outbox/i.test(sql)) ||
          (faultStage === 'commit' && /^COMMIT/i.test(sql))
            ? new Error(`injected SQLITE_BUSY at ${faultStage}`)
            : null;
      }

      const shotsBefore = await rowCount(db, 'local_shot');
      const outboxBefore = await rowCount(db, 'outbox');
      const mark = mockSqlite.statements.length;
      const outcome = await settle(() =>
        saveAnalysis(db, analysis, permitId as string),
      );
      mockSqlite.fault = null;
      const statementsDuring = mockSqlite.statements.slice(mark);
      const writesDuring = writesSince(mark);

      const shotsAfter = await rowCount(db, 'local_shot');
      const outboxAfter = await rowCount(db, 'outbox');
      const candidateId = (analysis as unknown as Record<string, unknown>)[
        'id'
      ];

      const invariants: Record<string, boolean> = {
        settlesTyped: outcome.kind !== 'non-error-throw',
        protoClean: protoClean(),
      };
      const observed: Record<string, unknown> = {
        outcome: errorSummary(outcome),
        shotsBefore,
        shotsAfter,
        outboxBefore,
        outboxAfter,
        writes: writesDuring,
      };

      if (signedOut) {
        invariants['signedOutRejectsBeforeSqlite'] =
          outcome.kind === 'error' && statementsDuring.length === 0;
        invariants['signedOutNoRows'] =
          shotsAfter === shotsBefore && outboxAfter === outboxBefore;
      } else if (outcome.kind !== 'ok') {
        // Rejected: nothing may have landed, in either table, for any owner.
        invariants['rejectedIsAtomic'] =
          shotsAfter === shotsBefore && outboxAfter === outboxBefore;
        invariants['rejectedRolledBack'] =
          writesDuring.length === 0 ||
          writesDuring.some(sql => /^ROLLBACK/i.test(sql));
        const { rows: stray } = await db.execute(
          `SELECT COUNT(*) AS n FROM local_shot WHERE id = ?`,
          [typeof candidateId === 'string' ? candidateId : String(candidateId)],
        );
        invariants['rejectedNoStrayRow'] = Number(stray[0]?.['n']) === 0;
      } else {
        setActiveDataOwner(OWNER_A);
        invariants['acceptedWroteExactlyOne'] =
          shotsAfter === shotsBefore + 1 && outboxAfter === outboxBefore + 1;
        invariants['acceptedCommitted'] =
          writesDuring.some(sql => /^BEGIN/i.test(sql)) &&
          writesDuring.some(sql => /^COMMIT/i.test(sql));
        const shots = await settle(() => listShots(db, 100));
        const facts = await settle(() => listRealAnalysisFacts(db, null));
        // The one row that is not the pre-existing sibling is the candidate
        // (an id mutated to a number / lone surrogate lands under whatever
        // text the driver stored for it).
        const stored =
          shots.kind === 'ok'
            ? (shots.value as unknown as Record<string, unknown>[]).find(
                s => s['id'] !== 'a-existing',
              )
            : undefined;
        invariants['acceptedReadableRows'] =
          shots.kind === 'ok' && facts.kind === 'ok';
        invariants['acceptedRowStrictlyShaped'] =
          stored !== undefined && shotRowWellFormed(stored);
        // Column ↔ payload agreement: what the row says must be what the
        // payload says (a reader trusting either must not disagree).
        const stringPayload = JSON.parse(JSON.stringify(analysis)) as Record<
          string,
          unknown
        >;
        const scoreAgrees =
          stored !== undefined &&
          (stored['overallScore'] === stringPayload['overallScore'] ||
            (stored['overallScore'] === null &&
              (stringPayload['overallScore'] === null ||
                stringPayload['overallScore'] === undefined)));
        invariants['acceptedColumnsAgreeWithPayload'] = scoreAgrees;
        invariants['acceptedFactsStrictlyShaped'] =
          facts.kind === 'ok' &&
          (facts.value as unknown as Record<string, unknown>[]).every(
            factWellFormed,
          );
        const other = await settle(() => getAnalysis(db, 'a-existing'));
        invariants['acceptedSiblingIntact'] =
          other.kind === 'ok' &&
          (other.value as ShotAnalysis | null)?.id === 'a-existing';
        observed['stored'] = stored;
        observed['payloadOverallScore'] = stringPayload['overallScore'];
      }
      // Foreign owner never affected either way.
      setActiveDataOwner(OWNER_B);
      const bShots = await settle(() => listShots(db, 100));
      invariants['foreignOwnerUntouched'] =
        bShots.kind === 'ok' &&
        (bShots.value as unknown as Record<string, unknown>[]).length === 1 &&
        (bShots.value as unknown as Record<string, unknown>[])[0]?.['id'] ===
          'b-existing';

      rows.push(
        finishRow(
          family,
          seed,
          startedAt,
          {
            signedOut,
            mutations,
            permit: permitName,
            fault: injectFault ? faultStage : null,
          },
          observed,
          invariants,
        ),
      );
    }
    db.close();
    record(rows);
    expect(failures(rows)).toEqual([]);
  });

  // ── capture-rows ──────────────────────────────────────────────────────────
  it('capture-rows: corrupt clip payloads are labelled exactly, never thrown', async () => {
    const family = 'capture-rows';
    const db = freshDb();
    const rows: StressRow[] = [];
    for (const seed of seedsFor(family)) {
      const rng = seededRng(family, seed);
      const startedAt = Date.now();
      await clearAll(db);
      setActiveDataOwner(OWNER_A);

      const inputs: Record<string, unknown> = {};
      const invariants: Record<string, boolean> = {};
      const observed: Record<string, unknown> = {};

      // Healthy pending capture through the real writer.
      await savePendingCapture(db, 'healthy-capture', 'dink', {
        ...CLIP_BASE,
        uri: 'file:///private/captures/healthy.mov',
      });

      const mode = pick(rng, [
        'raw-row',
        'raw-row',
        'hostile-clip',
        'dupe-uri',
      ]);
      inputs['mode'] = mode;

      if (mode === 'raw-row') {
        // A row whose payload text is corrupt / drifted / legacy.
        let payload: string | null;
        const choice = rng();
        if (choice < 0.15) {
          payload = null;
          inputs['payload'] = 'NULL';
        } else if (choice < 0.5) {
          const name = pick(rng, PAYLOAD_TEXT_NAMES);
          payload = PAYLOAD_TEXTS[name] as string;
          inputs['payload'] = name;
        } else {
          const clone = JSON.parse(JSON.stringify(CLIP_BASE)) as Record<
            string,
            unknown
          >;
          const count = 1 + Math.floor(rng() * 2);
          const mutations: unknown[] = [];
          for (let i = 0; i < count; i += 1) {
            const fieldPath = pick(rng, CLIP_FIELD_PATHS);
            const valueName = pick(rng, RUNTIME_VALUE_NAMES);
            setPath(clone, fieldPath, RUNTIME_VALUES[valueName]);
            mutations.push({ path: fieldPath, valueName });
          }
          const corruption = pick(rng, TEXT_CORRUPTIONS);
          payload = corruptText(rng, looseStringify(clone), corruption);
          inputs['mutations'] = mutations;
          inputs['corruption'] = corruption;
        }
        const declared = pick(rng, [
          null,
          'dink',
          'serve',
          'not-a-stroke',
          '',
          '../serve',
          'DINK',
        ]);
        inputs['declaredStroke'] = declared;
        const columns = {
          uri: 'file:///private/captures/real.mov',
          capturedAt: CLIP_BASE.capturedAtIso,
          durationMs: CLIP_BASE.durationMs,
          fps: CLIP_BASE.fps,
          width: CLIP_BASE.width,
          height: CLIP_BASE.height,
        };
        await db.execute(
          `INSERT INTO local_capture
           (owner_key,id,uri,shot_type,captured_at,duration_ms,fps,width,height,status,payload,declared_stroke)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            OWNER_A,
            'corrupt-capture',
            columns.uri,
            'dink',
            columns.capturedAt,
            columns.durationMs,
            columns.fps,
            columns.width,
            columns.height,
            'awaiting_model',
            payload,
            declared,
          ],
        );
        const mark = mockSqlite.statements.length;
        const [pending, history, single] = await Promise.all([
          settle(() => listPendingCaptures(db, null)),
          settle(() => listCaptureHistory(db, null)),
          settle(() => getPendingCapture(db, 'corrupt-capture')),
        ]);
        const writes = writesSince(mark);
        const expected = expectedEvidenceStatus(payload, columns);
        const got =
          single.kind === 'ok'
            ? (single.value as Record<string, unknown> | null)
            : null;
        invariants['listPendingSettles'] = pending.kind === 'ok';
        invariants['listHistorySettles'] = history.kind === 'ok';
        invariants['getPendingSettles'] = single.kind === 'ok';
        invariants['noWrites'] = writes.length === 0;
        invariants['protoClean'] = protoClean();
        invariants['rowReturned'] = got !== null;
        invariants['evidenceStatusMatchesOracle'] =
          got !== null && got['evidenceStatus'] === expected;
        invariants['clipOnlyWhenValid'] =
          got !== null &&
          (expected === 'valid' ? got['clip'] !== null : got['clip'] === null);
        invariants['declaredStrokeValidated'] =
          got !== null &&
          (got['declaredStroke'] === null ||
            ['dink', 'serve'].includes(got['declaredStroke'] as string));
        invariants['healthySiblingListed'] =
          pending.kind === 'ok' &&
          (pending.value as unknown as Record<string, unknown>[]).some(
            c => c['uri'] === 'file:///private/captures/healthy.mov',
          );
        observed['expected'] = expected;
        observed['evidenceStatus'] = got?.['evidenceStatus'];
        observed['declaredStroke'] = got?.['declaredStroke'];
        observed['errors'] = {
          pending: errorSummary(pending),
          history: errorSummary(history),
          single: errorSummary(single),
        };
      } else if (mode === 'hostile-clip') {
        // savePendingCapture is typed CapturedClip but the object can be
        // hostile at runtime; whatever lands must read back consistently.
        const clone = JSON.parse(JSON.stringify(CLIP_BASE)) as Record<
          string,
          unknown
        >;
        clone['uri'] = 'file:///private/captures/hostile.mov';
        const count = 1 + Math.floor(rng() * 2);
        const mutations: unknown[] = [];
        for (let i = 0; i < count; i += 1) {
          const fieldPath = pick(rng, CLIP_FIELD_PATHS);
          const valueName = pick(rng, RUNTIME_VALUE_NAMES);
          setPath(clone, fieldPath, RUNTIME_VALUES[valueName]);
          mutations.push({ path: fieldPath, valueName });
        }
        inputs['mutations'] = mutations;
        const before = await rowCount(db, 'local_capture');
        const mark = mockSqlite.statements.length;
        const outcome = await settle(() =>
          savePendingCapture(
            db,
            'hostile-capture',
            'dink',
            clone as unknown as CapturedClip,
          ),
        );
        const after = await rowCount(db, 'local_capture');
        const reads = await Promise.all([
          settle(() => listPendingCaptures(db, null)),
          settle(() => listCaptureHistory(db, null)),
          settle(() => getPendingCapture(db, 'hostile-capture')),
          settle(() => getCaptureTargetSeed(db, 'hostile-capture')),
        ]);
        invariants['settlesTyped'] = outcome.kind !== 'non-error-throw';
        invariants['protoClean'] = protoClean();
        invariants['readersSettle'] = reads.every(r => r.kind === 'ok');
        if (outcome.kind === 'ok') {
          invariants['acceptedWroteOne'] = after === before + 1;
          const listed =
            reads[0].kind === 'ok'
              ? (reads[0].value as unknown as Record<string, unknown>[]).find(
                  c => c['id'] === 'hostile-capture',
                )
              : undefined;
          invariants['acceptedReadable'] = listed !== undefined;
          invariants['acceptedNumericColumnsFinite'] =
            listed !== undefined &&
            ['durationMs', 'fps', 'width', 'height'].every(k =>
              Number.isFinite(listed[k] as number),
            );
          // Whatever landed, the reader's verdict must equal the oracle's.
          const stored = (
            await db.execute(
              `SELECT uri, captured_at, duration_ms, fps, width, height, payload
               FROM local_capture WHERE owner_key = ? AND id = ?`,
              [OWNER_A, 'hostile-capture'],
            )
          ).rows[0];
          const expected =
            stored === undefined
              ? null
              : expectedEvidenceStatus(
                  stored['payload'] === null ? null : String(stored['payload']),
                  {
                    uri: String(stored['uri']),
                    capturedAt: String(stored['captured_at']),
                    durationMs: Number(stored['duration_ms']),
                    fps: Number(stored['fps']),
                    width: Number(stored['width']),
                    height: Number(stored['height']),
                  },
                );
          invariants['acceptedEvidenceStatusMatchesOracle'] =
            listed !== undefined && listed['evidenceStatus'] === expected;
          observed['listed'] = listed;
          observed['expected'] = expected;
        } else {
          invariants['rejectedNoRow'] = after === before;
          invariants['rejectedRolledBackOrNoWrite'] =
            writesSince(mark).every(sql => !/^INSERT/i.test(sql)) ||
            writesSince(mark).some(sql => /^ROLLBACK/i.test(sql));
        }
        observed['outcome'] = errorSummary(outcome);
      } else {
        // Duplicate uri (or id) for the same owner must reject atomically.
        const dupeKey = pick(rng, ['uri', 'id'] as const);
        inputs['dupeKey'] = dupeKey;
        const before = await rowCount(db, 'local_capture');
        const outcome = await settle(() =>
          savePendingCapture(
            db,
            dupeKey === 'id' ? 'healthy-capture' : 'second-capture',
            'serve',
            {
              ...CLIP_BASE,
              uri:
                dupeKey === 'uri'
                  ? 'file:///private/captures/healthy.mov'
                  : 'file:///private/captures/second.mov',
            },
          ),
        );
        const after = await rowCount(db, 'local_capture');
        invariants['dupeRejectsTyped'] = outcome.kind === 'error';
        invariants['dupeNoRow'] = after === before;
        // A different owner with the same uri/id is fine (owner-partitioned).
        setActiveDataOwner(OWNER_B);
        const cross = await settle(() =>
          savePendingCapture(db, 'healthy-capture', 'serve', {
            ...CLIP_BASE,
            uri: 'file:///private/captures/healthy.mov',
          }),
        );
        invariants['crossOwnerSameUriAccepted'] = cross.kind === 'ok';
        setActiveDataOwner(OWNER_A);
        const mine = await settle(() => listPendingCaptures(db, null));
        invariants['ownerSeesOnlyOwnRows'] =
          mine.kind === 'ok' &&
          (mine.value as unknown as Record<string, unknown>[]).length === 1;
        observed['outcome'] = errorSummary(outcome);
        observed['cross'] = errorSummary(cross);
      }

      rows.push(
        finishRow(family, seed, startedAt, inputs, observed, invariants),
      );
    }
    db.close();
    record(rows);
    expect(failures(rows)).toEqual([]);
  });

  // ── limits ────────────────────────────────────────────────────────────────
  it('limits: NaN / ±Infinity / -0 / 2^53+1 / strings / bigint bound or reject', async () => {
    const family = 'limits';
    const db = freshDb();
    setActiveDataOwner(OWNER_A);
    const TOTAL = 40;
    for (let i = 0; i < TOTAL; i += 1) {
      await saveAnalysis(
        db,
        validAnalysis(`row-${i}`, isoAt(i)),
        `permit-${i}`,
      );
    }
    for (let i = 0; i < 6; i += 1) {
      await savePendingCapture(db, `limit-${i}`, 'dink', {
        ...CLIP_BASE,
        uri: `file:///private/captures/limit-${i}.mov`,
      });
    }
    const readers: Record<
      string,
      {
        run: (limit: unknown) => Promise<unknown[]>;
        total: number;
        acceptsNull: boolean;
      }
    > = {
      listShots: {
        run: limit => listShots(db, limit as number),
        total: TOTAL,
        acceptsNull: false,
      },
      recentScores: {
        run: limit => recentScores(db, 'dink', limit as number),
        total: TOTAL,
        acceptsNull: false,
      },
      listRealAnalysisFacts: {
        run: limit => listRealAnalysisFacts(db, limit as number | null),
        total: TOTAL,
        acceptsNull: true,
      },
      listScoredCheckpointFacts: {
        run: limit => listScoredCheckpointFacts(db, limit as number),
        total: TOTAL,
        acceptsNull: false,
      },
      listPendingCaptures: {
        run: limit => listPendingCaptures(db, limit as number | null),
        total: 6,
        acceptsNull: true,
      },
      listCaptureHistory: {
        run: limit => listCaptureHistory(db, limit as number | null),
        total: 6,
        acceptsNull: true,
      },
      listLiveSessionHistory: {
        run: limit => listLiveSessionHistory(db, limit as number),
        total: 0,
        acceptsNull: false,
      },
    };
    const readerNames = Object.keys(readers);
    const rows: StressRow[] = [];
    for (const seed of seedsFor(family)) {
      const rng = seededRng(family, seed);
      const startedAt = Date.now();
      const readerName = pick(rng, readerNames);
      const limitName = pick(rng, LIMIT_VALUE_NAMES);
      const limit = LIMIT_VALUES[limitName];
      const reader = readers[readerName]!;
      const mark = mockSqlite.statements.length;
      const outcome = await settle(() => reader.run(limit));
      const writes = writesSince(mark);
      const length = outcome.kind === 'ok' ? outcome.value.length : null;
      // Accepted only when the limit is a real non-negative number and the
      // result honours it (SQLite casts 2**53/2**63 to an integer LIMIT, so
      // huge finite values are still "bounded"). Negative, NaN, ±Infinity,
      // strings, booleans and objects must be rejected — never coerced.
      const numericLimit =
        typeof limit === 'number' && Number.isFinite(limit) && limit >= 0;
      const boundedOrRejected =
        outcome.kind === 'error' ||
        (outcome.kind === 'ok' &&
          length !== null &&
          ((numericLimit &&
            length <= Math.min(limit as number, reader.total)) ||
            (limit === undefined && length <= reader.total) ||
            (limit === null && reader.acceptsNull && length === reader.total)));
      rows.push(
        finishRow(
          family,
          seed,
          startedAt,
          { reader: readerName, limit: limitName },
          { outcome: errorSummary(outcome), length, writes },
          {
            settlesTyped: outcome.kind !== 'non-error-throw',
            boundedOrRejected,
            noWrites: writes.length === 0,
            resultIsArray:
              outcome.kind !== 'ok' || Array.isArray(outcome.value),
          },
        ),
      );
    }
    db.close();
    record(rows);
    expect(failures(rows)).toEqual([]);
  });

  // ── account-scope ─────────────────────────────────────────────────────────
  it('account-scope: owner identifiers accept iff the strict ASCII UUID rule says so', () => {
    const family = 'account-scope';
    const rows: StressRow[] = [];
    for (const seed of seedsFor(family)) {
      const rng = seededRng(family, seed);
      const startedAt = Date.now();
      const candidate = ownerCandidate(rng);
      const value = candidate.value;

      // canonicalDataOwner(): trims + lowercases, then strict UUID.
      const canonicalOracle =
        typeof value === 'string' &&
        STRICT_UUID.test(value.trim().toLowerCase());
      let canonicalResult: unknown;
      let canonicalError: unknown;
      let canonicalThrew = false;
      try {
        canonicalResult = canonicalDataOwner(value as string);
      } catch (error) {
        canonicalThrew = true;
        canonicalError = error;
      }

      // setActiveDataOwner(): exact guest/signed-out or case-insensitive UUID,
      // NO trimming; rejection must leave the active owner untouched.
      setActiveDataOwner(OWNER_C);
      const setOracle =
        value === GUEST_DATA_OWNER ||
        value === SIGNED_OUT_DATA_OWNER ||
        (typeof value === 'string' && STRICT_UUID.test(value.toLowerCase()));
      let setThrew = false;
      let setError: unknown;
      try {
        setActiveDataOwner(value as string);
      } catch (error) {
        setThrew = true;
        setError = error;
      }
      const activeAfter = getActiveDataOwner();

      const invariants: Record<string, boolean> = {
        canonicalMatchesOracle: canonicalOracle
          ? !canonicalThrew
          : canonicalThrew,
        canonicalThrowTyped: !canonicalThrew || canonicalError instanceof Error,
        canonicalResultStrict:
          !canonicalOracle ||
          (typeof canonicalResult === 'string' &&
            STRICT_UUID.test(canonicalResult) &&
            canonicalResult === (value as string).trim().toLowerCase()),
        setMatchesOracle: setOracle ? !setThrew : setThrew,
        setThrowTyped: !setThrew || setError instanceof Error,
        setRejectionLeavesOwner: setOracle || activeAfter === OWNER_C,
        setAcceptedIsStrict:
          !setOracle ||
          activeAfter === GUEST_DATA_OWNER ||
          activeAfter === SIGNED_OUT_DATA_OWNER ||
          STRICT_UUID.test(activeAfter),
        activeOwnerAlwaysStrict:
          activeAfter === GUEST_DATA_OWNER ||
          activeAfter === SIGNED_OUT_DATA_OWNER ||
          STRICT_UUID.test(activeAfter),
      };
      rows.push(
        finishRow(
          family,
          seed,
          startedAt,
          { recipe: candidate.recipe, value },
          {
            canonical: canonicalThrew
              ? errorSummary({ kind: 'error', error: canonicalError as Error })
              : canonicalResult,
            set: setThrew
              ? errorSummary({ kind: 'error', error: setError as Error })
              : 'accepted',
            activeAfter,
            canonicalOracle,
            setOracle,
          },
          invariants,
        ),
      );
    }
    record(rows);
    expect(failures(rows)).toEqual([]);
  });

  // ── isolation-10k ─────────────────────────────────────────────────────────
  it('isolation-10k: 10k rows, duplicate ids, purges racing reads, faults mid-purge', async () => {
    const family = 'isolation-10k';
    const seeds = seedsFor(family);
    if (seeds.length === 0) return;
    const db = freshDb();
    const owners = [OWNER_A, OWNER_B, OWNER_C];
    const PER_OWNER = 3334; // ≈10k rows total incl. duplicate ids
    const DUPE_EVERY = 10;

    const distinctIds = (owner: string): number => {
      // ids 0..PER_OWNER-1 where every DUPE_EVERY-th id repeats the previous.
      let n = 0;
      for (let i = 0; i < PER_OWNER; i += 1) {
        if (i % DUPE_EVERY !== DUPE_EVERY - 1) n += 1;
      }
      void owner;
      return n;
    };

    async function seedOwner(
      owner: string,
      corruptEvery: number,
    ): Promise<void> {
      await db.execute('BEGIN IMMEDIATE');
      for (let i = 0; i < PER_OWNER; i += 1) {
        const id =
          i % DUPE_EVERY === DUPE_EVERY - 1
            ? `${owner.slice(0, 8)}-shot-${i - 1}`
            : `${owner.slice(0, 8)}-shot-${i}`;
        const payload =
          corruptEvery > 0 && i % corruptEvery === 0
            ? (PAYLOAD_TEXTS[
                PAYLOAD_TEXT_NAMES[i % PAYLOAD_TEXT_NAMES.length] as string
              ] as string)
            : JSON.stringify(validAnalysis(id, isoAt(i)));
        await rawInsertShot(db, owner, id, isoAt(i), payload);
      }
      await db.execute('COMMIT');
    }

    await clearAll(db);
    for (const owner of owners) await seedOwner(owner, 97);
    const totalRows = await rowCount(db, 'local_shot');

    const rows: StressRow[] = [];
    for (const seed of seeds) {
      const rng = seededRng(family, seed);
      const startedAt = Date.now();
      const victimIndex = Math.floor(rng() * owners.length);
      const victim = owners[victimIndex] as string;
      const reader = owners[
        (victimIndex + 1 + Math.floor(rng() * 2)) % 3
      ] as string;
      const faultPurge = rng() < 0.3;
      const faultReader = !faultPurge && rng() < 0.15;

      const victimBefore = (
        await db.execute(
          `SELECT COUNT(*) AS n FROM local_shot WHERE owner_key = ?`,
          [victim],
        )
      ).rows[0]?.['n'];
      const readerBefore = (
        await db.execute(
          `SELECT COUNT(*) AS n FROM local_shot WHERE owner_key = ?`,
          [reader],
        )
      ).rows[0]?.['n'];

      if (faultPurge) {
        let seen = 0;
        mockSqlite.fault = sql => {
          if (/^DELETE FROM/i.test(sql)) {
            seen += 1;
            if (seen === 3) return new Error('injected SQLITE_BUSY mid-purge');
          }
          return null;
        };
      } else if (faultReader) {
        mockSqlite.fault = sql =>
          /^SELECT payload FROM local_shot/i.test(sql)
            ? new Error('injected SQLITE_IOERR during read')
            : null;
      }

      // Reader and purge interleave on the same connection (as the app does).
      setActiveDataOwner(reader);
      const readerShots = settle(() => listShots(db, 5000));
      const readerFacts = settle(() => listRealAnalysisFacts(db, null));
      const purge = settle(() => purgeOwnerData(db, victim));
      const [shots, facts, purged] = await Promise.all([
        readerShots,
        readerFacts,
        purge,
      ]);
      mockSqlite.fault = null;

      const victimAfter = (
        await db.execute(
          `SELECT COUNT(*) AS n FROM local_shot WHERE owner_key = ?`,
          [victim],
        )
      ).rows[0]?.['n'];
      const readerAfter = (
        await db.execute(
          `SELECT COUNT(*) AS n FROM local_shot WHERE owner_key = ?`,
          [reader],
        )
      ).rows[0]?.['n'];
      const integrity = (await db.execute('PRAGMA integrity_check')).rows[0];
      const inTx = await settle(() => db.execute('BEGIN IMMEDIATE'));
      if (inTx.kind === 'ok') await db.execute('ROLLBACK');

      const shotRows =
        shots.kind === 'ok'
          ? (shots.value as unknown as Record<string, unknown>[])
          : [];
      const factRows =
        facts.kind === 'ok'
          ? (facts.value as unknown as Record<string, unknown>[])
          : [];
      const prefix = reader.slice(0, 8);

      const invariants: Record<string, boolean> = {
        readerSettlesTyped:
          shots.kind !== 'non-error-throw' && facts.kind !== 'non-error-throw',
        readerOkUnlessFaulted:
          faultReader || (shots.kind === 'ok' && facts.kind === 'ok'),
        purgeSettlesTyped: purged.kind !== 'non-error-throw',
        readerSeesOnlyOwnRows:
          shotRows.every(s => String(s['id']).startsWith(prefix)) &&
          factRows.every(f => String(f['id']).startsWith(prefix)),
        readerCountExact:
          shots.kind !== 'ok' || shotRows.length === distinctIds(reader),
        readerUntouchedByPurge: readerAfter === readerBefore,
        purgeAllOrNothing: faultPurge
          ? purged.kind === 'error' && victimAfter === victimBefore
          : purged.kind === 'ok' && victimAfter === 0,
        noDanglingTransaction: inTx.kind === 'ok',
        integrityOk: integrity?.['integrity_check'] === 'ok',
        totalRowsConsistent:
          (await rowCount(db, 'local_shot')) ===
          totalRows - (Number(victimBefore) - Number(victimAfter)),
      };
      rows.push(
        finishRow(
          family,
          seed,
          startedAt,
          { victim, reader, faultPurge, faultReader },
          {
            shots: errorSummary(shots),
            facts: errorSummary(facts),
            purge: errorSummary(purged),
            shotRows: shotRows.length,
            factRows: factRows.length,
            victimBefore,
            victimAfter,
            readerBefore,
            readerAfter,
            integrity: integrity?.['integrity_check'],
          },
          invariants,
        ),
      );

      // Re-seed the victim so the next iteration starts from ≈10k rows again.
      if (Number(victimAfter) === 0) {
        await seedOwner(victim, 97);
      }
    }
    db.close();
    record(rows);
    expect(failures(rows)).toEqual([]);
  });

  // ── kv-session-json ───────────────────────────────────────────────────────
  it('kv-session-json: hostile kv values and session summaries never escape the store', async () => {
    const family = 'kv-session-json';
    const db = freshDb();
    const rows: StressRow[] = [];
    for (const seed of seedsFor(family)) {
      const rng = seededRng(family, seed);
      const startedAt = Date.now();
      await clearAll(db);
      setActiveDataOwner(OWNER_A);
      const inputs: Record<string, unknown> = {};
      const observed: Record<string, unknown> = {};
      const invariants: Record<string, boolean> = {};

      const mode = pick(rng, ['kv', 'kv', 'session', 'session-raw']);
      inputs['mode'] = mode;
      if (mode === 'kv') {
        const keyName = pick(rng, RUNTIME_VALUE_NAMES);
        const valueName = pick(rng, RUNTIME_VALUE_NAMES);
        const key = RUNTIME_VALUES[keyName];
        const value = RUNTIME_VALUES[valueName];
        inputs['key'] = keyName;
        inputs['value'] = valueName;
        const set = await settle(() =>
          setKv(db, key as string, value as string),
        );
        const get = await settle(() => getKv(db, key as string));
        invariants['setSettlesTyped'] = set.kind !== 'non-error-throw';
        invariants['getSettlesTyped'] = get.kind !== 'non-error-throw';
        invariants['protoClean'] = protoClean();
        if (
          set.kind === 'ok' &&
          typeof key === 'string' &&
          typeof value === 'string'
        ) {
          const echoed = await driverEcho(db, value);
          observed['driverEcho'] = compactForJson(echoed);
          invariants['stringRoundTripExact'] =
            get.kind === 'ok' && get.value === echoed;
        }
        if (set.kind !== 'ok') {
          const n = await rowCount(db, 'kv');
          invariants['rejectedNoRow'] = n === 0;
        }
        observed['set'] = errorSummary(set);
        observed['get'] = errorSummary(get);
        observed['gotType'] = get.kind === 'ok' ? typeof get.value : undefined;
      } else if (mode === 'session') {
        const summaryName = pick(rng, RUNTIME_VALUE_NAMES);
        const shotTypeName = pick(rng, RUNTIME_VALUE_NAMES);
        inputs['summary'] = summaryName;
        inputs['shotType'] = shotTypeName;
        const started = await settle(() =>
          saveSession(db, {
            id: `session-${seed}`,
            mode: 'live_court',
            shotType: RUNTIME_VALUES[shotTypeName] as never,
            focusCheckpoint: null,
            startedAt: isoAt(0),
          }),
        );
        const finalized = await settle(() =>
          finishSession(
            db,
            `session-${seed}`,
            RUNTIME_VALUES[summaryName] as never,
          ),
        );
        const listed = await settle(() => listLiveSessionHistory(db, 10));
        invariants['startSettlesTyped'] = started.kind !== 'non-error-throw';
        invariants['finalizeSettlesTyped'] =
          finalized.kind !== 'non-error-throw';
        invariants['listSettles'] = listed.kind === 'ok';
        invariants['protoClean'] = protoClean();
        invariants['listedRowsShaped'] =
          listed.kind !== 'ok' ||
          (listed.value as unknown as Record<string, unknown>[]).every(
            s =>
              typeof s['id'] === 'string' &&
              typeof s['startedAt'] === 'string' &&
              (s['summary'] === null || typeof s['summary'] === 'string'),
          );
        const outboxN = await rowCount(db, 'outbox');
        const sessionN = await rowCount(db, 'local_session');
        invariants['outboxAndSessionAgree'] =
          (started.kind === 'ok' ? 1 : 0) +
            (finalized.kind === 'ok' ? 1 : 0) ===
            outboxN && (started.kind === 'ok' ? 1 : 0) === sessionN;
        observed['started'] = errorSummary(started);
        observed['finalized'] = errorSummary(finalized);
        observed['outboxN'] = outboxN;
        observed['sessionN'] = sessionN;
      } else {
        // Corrupt summary text already on disk.
        const name = pick(rng, PAYLOAD_TEXT_NAMES);
        inputs['summary'] = name;
        await db.execute(
          `INSERT INTO local_session (owner_key,id,mode,shot_type,focus_checkpoint,started_at,ended_at,completed,summary)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [
            OWNER_A,
            'raw',
            'live_court',
            'dink',
            null,
            isoAt(0),
            isoAt(1),
            1,
            PAYLOAD_TEXTS[name] as string,
          ],
        );
        const mark = mockSqlite.statements.length;
        const listed = await settle(() => listLiveSessionHistory(db, 10));
        const first =
          listed.kind === 'ok'
            ? (listed.value as unknown as Record<string, unknown>[])[0]
            : undefined;
        invariants['listSettles'] = listed.kind === 'ok';
        invariants['noWrites'] = writesSince(mark).length === 0;
        invariants['protoClean'] = protoClean();
        // Contract: summary is returned RAW, byte-exact, for the strict
        // downstream parser — never coerced, never dropped.
        const echoed = await driverEcho(db, PAYLOAD_TEXTS[name] as string);
        invariants['summaryReturnedRaw'] =
          first !== undefined && first['summary'] === echoed;
        observed['listed'] = errorSummary(listed);
        observed['summaryType'] =
          first === undefined ? undefined : typeof first['summary'];
      }
      rows.push(
        finishRow(family, seed, startedAt, inputs, observed, invariants),
      );
    }
    db.close();
    record(rows);
    expect(failures(rows)).toEqual([]);
  });

  // ── outbox-torn ───────────────────────────────────────────────────────────
  it('outbox-torn: a torn outbox payload beside valid rows keeps sync status answerable', async () => {
    const family = 'outbox-torn';
    const db = freshDb();
    const rows: StressRow[] = [];
    for (const seed of seedsFor(family)) {
      const rng = seededRng(family, seed);
      const startedAt = Date.now();
      await clearAll(db);
      setActiveDataOwner(OWNER_A);
      const healthy = validAnalysis('healthy', isoAt(1));
      await saveAnalysis(db, healthy, 'permit-healthy');

      const name = pick(rng, PAYLOAD_TEXT_NAMES);
      const tornOwner = rng() < 0.2 ? OWNER_B : OWNER_A;
      const tornKind = pick(rng, ['shot.sync', 'shot.sync', 'session.create']);
      await db.execute(
        `INSERT INTO outbox (owner_key, kind, payload, attempts, last_error) VALUES (?,?,?,?,?)`,
        [tornOwner, tornKind, PAYLOAD_TEXTS[name], 8, 'stuck'],
      );
      const mark = mockSqlite.statements.length;
      const status = await settle(() => getShotOutboxStatus(db, 'healthy'));
      const missing = await settle(() => getShotOutboxStatus(db, 'nope'));
      const receipt = await settle(() => hasShotSyncReceipt(db, 'healthy'));
      const writes = writesSince(mark);
      let jsonValid: unknown = null;
      try {
        jsonValid = (
          await db.execute('SELECT json_valid(?) AS v', [
            PAYLOAD_TEXTS[name] as string,
          ])
        ).rows[0]?.['v'];
      } catch {
        jsonValid = 'error';
      }
      rows.push(
        finishRow(
          family,
          seed,
          startedAt,
          { tornPayload: name, tornOwner, tornKind },
          {
            status: errorSummary(status),
            statusValue: status.kind === 'ok' ? status.value : undefined,
            missing: errorSummary(missing),
            receipt: errorSummary(receipt),
            jsonValid,
            writes,
          },
          {
            statusAnswerable:
              status.kind === 'ok' &&
              (status.value as { state: string }).state === 'queued',
            missingAnswerable:
              missing.kind === 'ok' &&
              (missing.value as { state: string }).state === 'absent',
            receiptSettles: receipt.kind === 'ok',
            noWrites: writes.length === 0,
          },
        ),
      );
    }
    db.close();
    record(rows);
    expect(failures(rows)).toEqual([]);
  });

  // ── analysis-record ───────────────────────────────────────────────────────
  it('analysis-record: corrupt analysis_record payloads never escape a reader', async () => {
    const family = 'analysis-record';
    const db = freshDb();
    const rows: StressRow[] = [];
    for (const seed of seedsFor(family)) {
      const rng = seededRng(family, seed);
      const startedAt = Date.now();
      await clearAll(db);
      setActiveDataOwner(OWNER_A);
      const name = pick(rng, PAYLOAD_TEXT_NAMES);
      const corruption = pick(rng, TEXT_CORRUPTIONS);
      const text = corruptText(rng, PAYLOAD_TEXTS[name] as string, corruption);
      const captureId = pick(rng, [
        'cap',
        '../cap',
        'cap\u0000',
        "cap' OR 1=1 --",
        '',
      ]);
      await db.execute(
        `INSERT INTO local_analysis_record
         (owner_key,id,capture_id,created_at,engine_version,scoring_model_version,record)
         VALUES (?,?,?,?,?,?,?)`,
        [OWNER_A, 'rec', captureId, isoAt(0), 'engine-v1', 'score-v1', text],
      );
      await db.execute(
        `INSERT INTO local_analysis_record
         (owner_key,id,capture_id,created_at,engine_version,scoring_model_version,record)
         VALUES (?,?,?,?,?,?,?)`,
        [
          OWNER_B,
          'rec',
          captureId,
          isoAt(0),
          'engine-v1',
          'score-v1',
          '{"id":"alien"}',
        ],
      );
      const mark = mockSqlite.statements.length;
      const listed = await settle(() => listAnalysisRecords(db, captureId));
      const other = await settle(() =>
        listAnalysisRecords(db, 'other-capture'),
      );
      const writes = writesSince(mark);
      // Oracle parses exactly the bytes the driver hands back (NUL-truncated).
      let parses = true;
      try {
        JSON.parse(String(await driverEcho(db, text)));
      } catch {
        parses = false;
      }
      const listedRecords =
        listed.kind === 'ok'
          ? (listed.value as unknown as Record<string, unknown>[])
          : [];
      rows.push(
        finishRow(
          family,
          seed,
          startedAt,
          { payload: name, corruption, captureId },
          {
            listed: errorSummary(listed),
            listedCount: listed.kind === 'ok' ? listed.value.length : undefined,
            listedTypes: listedRecords.map(r => typeof r),
            other: errorSummary(other),
            parses,
            writes,
          },
          {
            listSettles: listed.kind === 'ok',
            otherCaptureEmpty: other.kind === 'ok' && other.value.length === 0,
            corruptRowSkippedExactly:
              listed.kind === 'ok' && listed.value.length === (parses ? 1 : 0),
            noForeignOwnerLeak: !listedRecords.some(
              r => r !== null && typeof r === 'object' && r['id'] === 'alien',
            ),
            noWrites: writes.length === 0,
            protoClean: protoClean(),
          },
        ),
      );
    }
    db.close();
    record(rows);
    expect(failures(rows)).toEqual([]);
  });
});
