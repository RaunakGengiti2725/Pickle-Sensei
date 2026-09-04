import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import {
  GUEST_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import type { LocalDb } from '../../src/data/db';
import {
  loadAnalysisRecordById,
  loadStrokeResultEvidence,
} from '../../src/components/strokeResultData';

/**
 * STRESS — unit `cmp-stroke-result` (data layer), lens `rapid-interaction`.
 *
 * "Spam navigation" / "back during async" against `strokeResultData`: every
 * Result route mount fires `loadStrokeResultEvidence(db, analysisId)`, and a
 * user hammering attempt chips (or backing out mid-load) leaves several of
 * those in flight at once over a store whose rows may be absent, corrupt or
 * failing. The loader must:
 *  - never reject (every store read is caught into an explicit null/[]);
 *  - be order-independent: a burst of concurrent loads yields, per id,
 *    exactly what a sequential load of that id yields over the same store;
 *  - keep every read owner-scoped (the active owner is the first bound
 *    parameter of every query, even when the owner changes mid-burst —
 *    each call binds the owner it started with per statement);
 *  - surface evidence honestly: a record without a captureId, a missing
 *    capture row or a zero-duration capture never fabricates a clip; a
 *    session-less analysis lists only itself; attempts never cross sessions;
 *  - leave no unhandled rejection when the caller abandons the promise.
 *
 * The fake store is a pure function of (seed, table, bound params) so the
 * concurrent and sequential runs see identical rows regardless of timing;
 * interleaving comes from a seeded per-query microtask delay.
 *
 * Replay:  STRESS_SEED=<seed> STRESS_ITER=1 npx jest --ci strokeResultDataConcurrency
 * Scale:   STRESS_ITER=<n> (default 40). STRESS_REPORT=<path> writes the
 *          seed→outcome JSON table.
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const ITER = Math.max(1, Number(process.env['STRESS_ITER'] ?? '') || 40);
const SEED_BASE = Number(process.env['STRESS_SEED'] ?? '') || 1;
const REPORT = process.env['STRESS_REPORT'];

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';
const IDS = ['a1', 'a2', 'a3', 'a4', 'missing'] as const;
const SESSIONS: Record<string, string | null> = {
  a1: 's1',
  a2: 's1',
  a3: 's2',
  a4: null,
};

// ─── Deterministic store ──────────────────────────────────────────────────

type RecordShape = 'valid' | 'no-capture' | 'empty' | 'corrupt' | 'absent';
type ShotShape = 'valid' | 'corrupt' | 'absent';
type CaptureShape = 'valid' | 'zero-duration' | 'corrupt-payload' | 'absent';

interface StoreScript {
  seed: number;
  /** Fraction of queries that throw (per table+params, deterministic). */
  failRate: number;
  ownerFlipAt: number | null;
}

function pickShape<T extends string>(roll: number, shapes: readonly T[]): T {
  return shapes[Math.floor(roll * shapes.length)]!;
}

function shot(id: string, corrupt: boolean): string {
  if (corrupt) return '{not json';
  return JSON.stringify({
    id,
    sessionId: SESSIONS[id] ?? null,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: `2026-08-30T10:0${id.charCodeAt(1) - 48}:00.000Z`,
    timestamps: { startMs: 200, contactMs: null, endMs: 700 },
    phases: [],
    measurements: [],
    checkpoints: [],
    overallScore: 7.1,
    analysisConfidence: 0.8,
    resultKind: 'scored',
    guidance: null,
    priorityFix: null,
    versionVector: {},
    source: 'real',
  });
}

function recordRow(id: string, shape: RecordShape): string | null {
  switch (shape) {
    case 'absent':
      return null;
    case 'empty':
      return '';
    case 'corrupt':
      return '{"id":';
    case 'no-capture':
      return JSON.stringify({ id, result: null });
    case 'valid':
      return JSON.stringify({ id, captureId: `cap-${id}`, result: null });
  }
}

function captureRow(
  id: string,
  shape: CaptureShape,
): Record<string, unknown> | null {
  if (shape === 'absent') return null;
  return {
    id,
    uri: 'file:///private/clip.mov',
    shot_type: 'unrecognized',
    declared_stroke: null,
    captured_at: '2026-08-30T10:00:00.000Z',
    duration_ms: shape === 'zero-duration' ? 0 : 4200,
    fps: 59.94,
    width: 720,
    height: 1280,
    payload: shape === 'corrupt-payload' ? '{"captureMode":' : null,
  };
}

/** Rows of local_shot for listShots: every id, every session, real source. */
function shotListRows(script: StoreScript): Record<string, unknown>[] {
  return IDS.filter(id => id !== 'missing')
    .filter(id => shapeFor(script, 'shot', id) !== 'absent')
    .map(id => ({
      id,
      session_id: SESSIONS[id],
      shot_type: 'forehand_drive',
      captured_at: `2026-08-30T10:0${id.charCodeAt(1) - 48}:00.000Z`,
      overall_score: 7.1,
      confidence: 0.8,
      result_kind: 'scored',
      source: 'real',
      favorite: 0,
    }));
}

function roll(script: StoreScript, key: string): number {
  return mulberry32(script.seed ^ hashString(key))();
}

function shapeFor(
  script: StoreScript,
  table: 'record',
  id: string,
): RecordShape;
function shapeFor(script: StoreScript, table: 'shot', id: string): ShotShape;
function shapeFor(
  script: StoreScript,
  table: 'capture',
  id: string,
): CaptureShape;
function shapeFor(script: StoreScript, table: string, id: string): string {
  const r = roll(script, `${table}:${id}`);
  if (id === 'missing') return 'absent';
  switch (table) {
    case 'record':
      return pickShape(r, [
        'valid',
        'valid',
        'valid',
        'no-capture',
        'empty',
        'corrupt',
        'absent',
      ]);
    case 'shot':
      return pickShape(r, [
        'valid',
        'valid',
        'valid',
        'valid',
        'corrupt',
        'absent',
      ]);
    default:
      return pickShape(r, [
        'valid',
        'valid',
        'zero-duration',
        'corrupt-payload',
        'absent',
      ]);
  }
}

interface QueryLog {
  table: string;
  owner: unknown;
  ownerAtDispatch: string;
}

function fakeDb(
  script: StoreScript,
  log: QueryLog[],
  delays: boolean,
): LocalDb {
  let dispatched = 0;
  return {
    async execute(sql: string, params: unknown[] = []) {
      const table = sql.includes('FROM local_analysis_record')
        ? 'record'
        : sql.includes('FROM local_capture')
          ? 'capture'
          : sql.includes('id = ?') && sql.includes('FROM local_shot')
            ? 'shot'
            : sql.includes('FROM local_shot')
              ? 'shots'
              : 'other';
      const ownerAtDispatch = getActiveDataOwner();
      log.push({ table, owner: params[0], ownerAtDispatch });
      dispatched += 1;
      if (script.ownerFlipAt !== null && dispatched === script.ownerFlipAt) {
        // Account switch mid-burst (sign-in landing while results load).
        setActiveDataOwner(OWNER_B);
      }
      const id = table === 'shots' ? 'list' : String(params[1]);
      if (delays) {
        const hops = Math.floor(roll(script, `delay:${table}:${id}`) * 4);
        for (let i = 0; i < hops; i += 1) await Promise.resolve();
      }
      if (roll(script, `fail:${table}:${id}`) < script.failRate) {
        throw new Error(`sqlite busy (${table}:${id})`);
      }
      switch (table) {
        case 'record': {
          const row = recordRow(id, shapeFor(script, 'record', id));
          return { rows: row === null ? [] : [{ record: row }] };
        }
        case 'shot': {
          const shape = shapeFor(script, 'shot', id);
          return {
            rows:
              shape === 'absent'
                ? []
                : [{ payload: shot(id, shape === 'corrupt') }],
          };
        }
        case 'capture': {
          const captureId = id.startsWith('cap-') ? id.slice(4) : id;
          const row = captureRow(
            captureId,
            shapeFor(script, 'capture', captureId),
          );
          return { rows: row === null ? [] : [row] };
        }
        case 'shots':
          return { rows: shotListRows(script) };
        default:
          return { rows: [] };
      }
    },
    close() {},
  };
}

// ─── Expectations derived from the store script ───────────────────────────

function expectedEvidence(script: StoreScript, id: string) {
  const shotShape = shapeFor(script, 'shot', id);
  const shotFails = roll(script, `fail:shot:${id}`) < script.failRate;
  const analysisPresent = shotShape === 'valid' && !shotFails;
  const recordShape = shapeFor(script, 'record', id);
  const recordFails = roll(script, `fail:record:${id}`) < script.failRate;
  const recordPresent =
    !recordFails && (recordShape === 'valid' || recordShape === 'no-capture');
  const captureId =
    recordPresent && recordShape === 'valid' ? `cap-${id}` : null;
  let clip: 'present' | 'null' = 'null';
  let review: 'present' | 'null' = 'null';
  if (captureId) {
    const captureFails =
      roll(script, `fail:capture:${captureId}`) < script.failRate;
    const captureShape = shapeFor(script, 'capture', id);
    if (!captureFails && captureShape !== 'absent') {
      review = 'present';
      if (captureShape !== 'zero-duration') clip = 'present';
    }
  }
  let attempts: string[] = [];
  if (analysisPresent) {
    const session = SESSIONS[id] ?? null;
    if (session === null) attempts = [id];
    else if (roll(script, 'fail:shots:list') < script.failRate) attempts = [];
    else {
      attempts = shotListRows(script)
        .filter(row => row['session_id'] === session)
        .map(row => String(row['id']));
    }
  }
  return {
    analysis: analysisPresent ? id : null,
    record: recordPresent ? id : null,
    captureId,
    clip,
    review,
    attempts,
  };
}

function summarize(
  evidence: Awaited<ReturnType<typeof loadStrokeResultEvidence>>,
) {
  return {
    analysis: evidence.analysis?.id ?? null,
    record: evidence.record?.id ?? null,
    captureId: evidence.record?.captureId ?? null,
    clip: evidence.clip ? ('present' as const) : ('null' as const),
    review: evidence.review ? ('present' as const) : ('null' as const),
    attempts: evidence.attempts.map(attempt => attempt.analysisId),
  };
}

// ─── Result table ─────────────────────────────────────────────────────────

interface Row {
  campaign: string;
  seed: number;
  events: number;
  outcome: 'HELD' | 'BROKEN';
  script: string;
  faults: string[];
}

const table: Row[] = [];
const rejections: string[] = [];
const onRejection = (reason: unknown) => {
  rejections.push(String(reason));
};

beforeEach(() => {
  rejections.length = 0;
  setActiveDataOwner(OWNER_A);
  process.on('unhandledRejection', onRejection);
});

afterEach(() => {
  process.off('unhandledRejection', onRejection);
  setActiveDataOwner(GUEST_DATA_OWNER);
});

afterAll(() => {
  if (!REPORT) return;
  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(
    REPORT,
    JSON.stringify(
      {
        unit: 'cmp-stroke-result/data',
        lens: 'rapid-interaction',
        iterationsPerCampaign: ITER,
        seedBase: SEED_BASE,
        executed: table.length,
        events: table.reduce((sum, row) => sum + row.events, 0),
        broken: table.filter(row => row.outcome === 'BROKEN').length,
        rows: table,
      },
      null,
      2,
    ),
  );
});

function failures(rows: Row[]): string[] {
  return rows
    .filter(row => row.outcome === 'BROKEN')
    .map(
      row =>
        `${row.campaign} seed=${row.seed}: ${row.faults.join('; ')}\n  script: ${row.script}`,
    );
}

async function flushMicrotasks() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

// ─── Campaigns ────────────────────────────────────────────────────────────

async function runConcurrentBurst(seed: number): Promise<Row> {
  const rng = mulberry32(seed);
  const script: StoreScript = {
    seed,
    failRate: [0, 0, 0.15, 0.35][Math.floor(rng() * 4)]!,
    ownerFlipAt: rng() < 0.25 ? 1 + Math.floor(rng() * 12) : null,
  };
  const fanOut = 2 + Math.floor(rng() * 7);
  const ids = Array.from(
    { length: fanOut },
    () => IDS[Math.floor(rng() * IDS.length)]!,
  );
  const abandon = rng() < 0.3;
  const faults: string[] = [];
  const log: QueryLog[] = [];

  setActiveDataOwner(OWNER_A);
  const db = fakeDb(script, log, true);
  const settled = await Promise.allSettled(
    ids.map((id, index) => {
      const promise = loadStrokeResultEvidence(db, id);
      // "Back during async": the host abandons the promise (it also guards
      // with a cancelled flag); the loader must still settle cleanly.
      if (abandon && index % 2 === 1)
        return Promise.resolve('abandoned' as const);
      return promise;
    }),
  );
  await flushMicrotasks();

  // Sequential reference over the SAME store script, no interleaving.
  setActiveDataOwner(OWNER_A);
  const referenceLog: QueryLog[] = [];
  const referenceDb = fakeDb(
    { ...script, ownerFlipAt: null },
    referenceLog,
    false,
  );
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i]!;
    const outcome = settled[i]!;
    if (outcome.status === 'rejected') {
      faults.push(`load(${id}) rejected: ${String(outcome.reason)}`);
      continue;
    }
    if (outcome.value === 'abandoned') continue;
    const actual = summarize(outcome.value);
    const reference = summarize(
      await loadStrokeResultEvidence(referenceDb, id),
    );
    const expected = expectedEvidence(script, id);
    if (JSON.stringify(actual) !== JSON.stringify(reference)) {
      faults.push(
        `load(${id}) concurrent ${JSON.stringify(actual)} != sequential ${JSON.stringify(reference)}`,
      );
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      faults.push(
        `load(${id}) ${JSON.stringify(actual)} != store-derived ${JSON.stringify(expected)}`,
      );
    }
    if (actual.clip === 'present' && actual.captureId === null)
      faults.push(`load(${id}) clip without captureId`);
    if (actual.review === 'null' && actual.clip === 'present')
      faults.push(`load(${id}) clip without review`);
    if (actual.analysis === null && actual.attempts.length)
      faults.push(`load(${id}) attempts without analysis`);
    if (
      actual.analysis !== null &&
      SESSIONS[id] === null &&
      actual.attempts.join() !== id
    ) {
      faults.push(
        `load(${id}) session-less analysis listed ${actual.attempts}`,
      );
    }
    const session = SESSIONS[id];
    if (session && actual.attempts.some(a => SESSIONS[a] !== session)) {
      faults.push(`load(${id}) attempts cross sessions: ${actual.attempts}`);
    }
  }
  for (const entry of log) {
    if (entry.table !== 'other' && entry.owner !== entry.ownerAtDispatch) {
      faults.push(
        `${entry.table} bound owner ${String(entry.owner)} != active ${entry.ownerAtDispatch}`,
      );
      break;
    }
  }
  if (rejections.length)
    faults.push(`unhandledRejection: ${rejections.join(' | ')}`);
  return {
    campaign: 'concurrent-load',
    seed,
    events: ids.length,
    outcome: faults.length ? 'BROKEN' : 'HELD',
    script: `ids=${ids.join(',')} failRate=${script.failRate} ownerFlipAt=${script.ownerFlipAt} abandon=${abandon} queries=${log.length}`,
    faults,
  };
}

async function runRecordReadBurst(seed: number): Promise<Row> {
  const rng = mulberry32(seed);
  const script: StoreScript = {
    seed,
    failRate: rng() < 0.5 ? 0.3 : 0,
    ownerFlipAt: null,
  };
  const fanOut = 2 + Math.floor(rng() * 7);
  const ids = Array.from(
    { length: fanOut },
    () => IDS[Math.floor(rng() * IDS.length)]!,
  );
  const faults: string[] = [];
  const log: QueryLog[] = [];
  const db = fakeDb(script, log, true);
  const settled = await Promise.allSettled(
    ids.map(id => loadAnalysisRecordById(db, id)),
  );
  await flushMicrotasks();
  ids.forEach((id, index) => {
    const outcome = settled[index]!;
    const storeFails = roll(script, `fail:record:${id}`) < script.failRate;
    const shape = shapeFor(script, 'record', id);
    if (storeFails) {
      // A failing store read propagates (the caller decides); it is never
      // disguised as "no record".
      if (outcome.status !== 'rejected')
        faults.push(
          `record(${id}) store failure returned ${JSON.stringify(outcome.value)}`,
        );
      return;
    }
    if (outcome.status === 'rejected') {
      faults.push(
        `record(${id}) rejected on a readable store: ${String(outcome.reason)}`,
      );
      return;
    }
    const expectNull =
      shape === 'absent' || shape === 'empty' || shape === 'corrupt';
    if (expectNull && outcome.value !== null)
      faults.push(`record(${id}) shape=${shape} returned a record`);
    if (!expectNull && outcome.value?.id !== id)
      faults.push(
        `record(${id}) shape=${shape} returned ${JSON.stringify(outcome.value)}`,
      );
  });
  if (rejections.length)
    faults.push(`unhandledRejection: ${rejections.join(' | ')}`);
  return {
    campaign: 'concurrent-record-read',
    seed,
    events: ids.length,
    outcome: faults.length ? 'BROKEN' : 'HELD',
    script: `ids=${ids.join(',')} failRate=${script.failRate}`,
    faults,
  };
}

describe(`strokeResultData concurrency stress (STRESS_ITER=${ITER}, seed base ${SEED_BASE})`, () => {
  it('concurrent evidence loads are order-independent, owner-scoped, explicit and never reject', async () => {
    const rows: Row[] = [];
    for (let i = 0; i < ITER; i += 1) {
      const row = await runConcurrentBurst(50_000 + SEED_BASE + i);
      rows.push(row);
      table.push(row);
    }
    expect(failures(rows)).toEqual([]);
    expect(rows).toHaveLength(ITER);
  });

  it('concurrent record reads return null only for absent/empty/corrupt rows and propagate store failures', async () => {
    const rows: Row[] = [];
    for (let i = 0; i < ITER; i += 1) {
      const row = await runRecordReadBurst(60_000 + SEED_BASE + i);
      rows.push(row);
      table.push(row);
    }
    expect(failures(rows)).toEqual([]);
    expect(rows).toHaveLength(ITER);
  });
});
