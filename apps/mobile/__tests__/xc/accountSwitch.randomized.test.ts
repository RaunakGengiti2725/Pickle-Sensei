/**
 * xc-journey-account-switch — randomized, seeded interleaving of owner
 * switches and repository operations against ONE real SQLite database.
 *
 * A shadow model (plain Maps, one bucket per owner) predicts what every
 * reader must return for the ACTIVE owner after each operation. Any
 * divergence is a failure record carrying the seed, the operation index and
 * the full operation list up to that point — enough to replay it with
 * `XC_REPLAY_SEED=<seed>`. Scale: `XC_SEEDS` seeds × `XC_OPS` operations
 * (defaults 64 × 80 = 5 120 operations, every one followed by a full
 * read-back of the active owner's bucket + a physical ownership matrix).
 *
 * Operation alphabet (weights in `nextOp`):
 *   switch(owner)          A | B | device-guest | signed-out
 *   save(shotId, score)    saveAnalysis — ids are drawn from a pool of SIX so
 *                          the same id lands under several owners
 *   profile(name)          owner-scoped kv write
 *   drain(mode)            drainOutbox with accept / permanent / transient
 *   delayedDrain           drain STARTED as owner X, response parked; switch
 *                          to Y; Y saves a shot; release → X's receipt lands
 *                          under X, Y's row untouched
 *   purge(owner)           purgeOwnerData
 */
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  profileKeyForOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { getDb } from '../../src/data/db';
import {
  getAnalysis,
  getKv,
  getShotOutboxStatus,
  hasShotSyncReceipt,
  listShots,
  purgeOwnerData,
  saveAnalysis,
  setKv,
} from '../../src/data/repository';
import {
  OUTBOX_MAX_ATTEMPTS,
  drainOutbox,
  type SyncTransport,
} from '../../src/data/sync';
import {
  OWNER_A,
  OWNER_B,
  PERMIT_A,
  PERMIT_B,
  buildAnalysis,
  heapNumbers,
  mulberry32,
  ownershipMatrix,
  writeEvidence,
  type Rng,
} from '../../testing/xc-account-switch/fixtures';
import {
  openRealSqlite,
  type RealSqliteHandle,
} from '../../testing/xc-account-switch/realSqlite';

let mockHandle: RealSqliteHandle | null = null;
jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    if (!mockHandle) throw new Error('real sqlite handle not opened');
    return mockHandle;
  },
}));

// ─── Configuration ───────────────────────────────────────────────────────────

const SEEDS = Number(process.env['XC_SEEDS'] ?? 64);
const OPS = Number(process.env['XC_OPS'] ?? 80);
const REPLAY = process.env['XC_REPLAY_SEED'];
const OWNERS = [OWNER_A, OWNER_B, GUEST_DATA_OWNER, SIGNED_OUT_DATA_OWNER];
const WRITABLE = [OWNER_A, OWNER_B, GUEST_DATA_OWNER];
const SHOT_POOL = [
  'rnd-shot-01',
  'rnd-shot-02',
  'rnd-shot-03',
  'rnd-shot-04',
  'rnd-shot-05',
  'rnd-shot-06',
];
const SIGNED_OUT_WRITE_ERROR =
  'Sign in or continue locally before saving product data.';

// ─── Operations ──────────────────────────────────────────────────────────────

type DrainMode = 'accept' | 'permanent' | 'transient';

type Op =
  | { kind: 'switch'; owner: string }
  | { kind: 'save'; shotId: string; score: number; capturedAt: string }
  | { kind: 'profile'; name: string }
  | { kind: 'drain'; mode: DrainMode }
  | {
      kind: 'delayedDrain';
      startAs: string;
      switchTo: string;
      shotId: string;
      score: number;
      capturedAt: string;
    }
  | { kind: 'purge'; owner: string };

function nextOp(rng: Rng, opIndex: number): Op {
  const roll = rng.next();
  const capturedAt = new Date(
    Date.UTC(2026, 7, 1, 0, 0, 0) + opIndex * 60_000,
  ).toISOString();
  if (roll < 0.28) return { kind: 'switch', owner: rng.pick(OWNERS) };
  if (roll < 0.58) {
    return {
      kind: 'save',
      shotId: rng.pick(SHOT_POOL),
      score: Math.round(rng.next() * 100) / 10,
      capturedAt,
    };
  }
  if (roll < 0.68) return { kind: 'profile', name: `name-${rng.int(1000)}` };
  if (roll < 0.84) {
    return {
      kind: 'drain',
      mode: rng.pick(['accept', 'accept', 'permanent', 'transient'] as const),
    };
  }
  if (roll < 0.94) {
    return {
      kind: 'delayedDrain',
      startAs: rng.pick(WRITABLE),
      switchTo: rng.pick(OWNERS),
      shotId: rng.pick(SHOT_POOL),
      score: Math.round(rng.next() * 100) / 10,
      capturedAt,
    };
  }
  return { kind: 'purge', owner: rng.pick(WRITABLE) };
}

// ─── Shadow model ────────────────────────────────────────────────────────────

interface ShadowRow {
  id: number;
  shotId: string;
  attempts: number;
}

interface Bucket {
  shots: Map<string, number>;
  profile: string | null;
  outbox: ShadowRow[];
  receipts: Set<string>;
}

class Shadow {
  readonly buckets = new Map<string, Bucket>();
  private nextRowId = 1;

  bucket(owner: string): Bucket {
    let b = this.buckets.get(owner);
    if (!b) {
      b = { shots: new Map(), profile: null, outbox: [], receipts: new Set() };
      this.buckets.set(owner, b);
    }
    return b;
  }

  save(owner: string, shotId: string, score: number): void {
    const b = this.bucket(owner);
    b.shots.set(shotId, score);
    b.outbox.push({ id: this.nextRowId++, shotId, attempts: 0 });
  }

  /** The rows drainOutbox SELECTs at its start (captured owner, ≤50). */
  selectForDrain(owner: string): ShadowRow[] {
    return this.bucket(owner)
      .outbox.filter(r => r.attempts < OUTBOX_MAX_ATTEMPTS)
      .sort((x, y) => x.id - y.id)
      .slice(0, 50);
  }

  /** Mirrors drainOutbox for `owner` with the given transport behaviour. */
  drain(
    owner: string,
    mode: DrainMode,
    eligible: ShadowRow[] = this.selectForDrain(owner),
  ): void {
    const b = this.bucket(owner);
    if (mode === 'accept') {
      const gone = new Set(eligible.map(r => r.id));
      for (const r of eligible) b.receipts.add(r.shotId);
      b.outbox = b.outbox.filter(r => !gone.has(r.id));
    } else if (mode === 'permanent') {
      for (const r of eligible) r.attempts += 1;
    }
    // transient: attempts unchanged (only last_error is written)
  }

  purge(owner: string): void {
    this.buckets.delete(owner);
  }

  outboxStatus(owner: string, shotId: string): string {
    const rows = this.bucket(owner)
      .outbox.filter(r => r.shotId === shotId)
      .sort((x, y) => y.id - x.id);
    const latest = rows[0];
    if (!latest) return 'absent';
    if (latest.attempts >= OUTBOX_MAX_ATTEMPTS) return 'exhausted';
    if (latest.attempts > 0) return 'rejected';
    return 'queued';
  }

  expectedView(owner: string): View {
    const b = this.bucket(owner);
    return {
      owner,
      shots: [...b.shots.entries()].sort(([x], [y]) => x.localeCompare(y)),
      profile: b.profile,
      outbox: Object.fromEntries(
        SHOT_POOL.map(id => [id, this.outboxStatus(owner, id)]),
      ),
      receipts: [...b.receipts].sort(),
    };
  }

  counts(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {
      local_shot: {},
      outbox: {},
      sync_receipt: {},
    };
    for (const [owner, b] of this.buckets) {
      if (b.shots.size) out['local_shot']![owner] = b.shots.size;
      if (b.outbox.length) out['outbox']![owner] = b.outbox.length;
      if (b.receipts.size) out['sync_receipt']![owner] = b.receipts.size;
    }
    return out;
  }
}

interface View {
  owner: string;
  shots: Array<[string, number]>;
  profile: string | null;
  outbox: Record<string, string>;
  receipts: string[];
}

// ─── Real side ───────────────────────────────────────────────────────────────

function permitFor(owner: string): string {
  return owner === OWNER_B ? PERMIT_B : PERMIT_A;
}

function transportFor(mode: DrainMode): SyncTransport {
  return {
    async syncShots(shots) {
      const ids = shots.map(s => String((s as { id: string }).id));
      if (mode === 'accept') return { acceptedIds: ids, rejected: [] };
      const code =
        mode === 'permanent' ? 'shot.invalid_payload' : 'shot.write_failed';
      return {
        acceptedIds: [],
        rejected: ids.map(id => ({ id, code, message: `${mode} rejection` })),
      };
    },
    async createSession() {},
    async finalizeSession() {},
  };
}

async function actualView(): Promise<View> {
  const db = getDb();
  const owner = getActiveDataOwner();
  const shots = await listShots(db, 200);
  const outbox: Record<string, string> = {};
  const receipts: string[] = [];
  for (const id of SHOT_POOL) {
    outbox[id] = (await getShotOutboxStatus(db, id)).state;
    if (await hasShotSyncReceipt(db, id)) receipts.push(id);
    // getAnalysis must agree with listShots for every pooled id.
    const analysis = await getAnalysis(db, id);
    const listed = shots.find(s => s.id === id);
    if ((analysis === null) !== (listed === undefined)) {
      throw new Error(`getAnalysis/listShots disagree for ${id} as ${owner}`);
    }
    if (analysis && listed && analysis.overallScore !== listed.overallScore) {
      throw new Error(`getAnalysis score differs from listShots for ${id}`);
    }
  }
  return {
    owner,
    shots: shots
      .map(s => [s.id, s.overallScore as number] as [string, number])
      .sort(([x], [y]) => x.localeCompare(y)),
    profile: await getKv(db, profileKeyForOwner(owner)),
    outbox,
    receipts: receipts.sort(),
  };
}

async function wipeAll(): Promise<void> {
  const db = getDb();
  for (const table of [
    'local_shot',
    'local_session',
    'local_capture',
    'local_analysis_record',
    'outbox',
    'sync_receipt',
  ]) {
    await db.execute(`DELETE FROM ${table}`);
  }
  await db.execute('DELETE FROM kv');
}

interface Failure {
  seed: number;
  opIndex: number;
  op: Op;
  opsSoFar: Op[];
  expected: unknown;
  observed: unknown;
  message: string;
}

interface SeedResult {
  seed: number;
  ops: number;
  opCounts: Record<string, number>;
  signedOutWritesRejected: number;
  collidingIds: number;
  finalMatrix: Record<string, Record<string, number>>;
  failures: number;
}

async function applyOp(
  op: Op,
  shadow: Shadow,
  stats: SeedResult,
): Promise<void> {
  const db = getDb();
  switch (op.kind) {
    case 'switch':
      setActiveDataOwner(op.owner);
      return;
    case 'save': {
      const owner = getActiveDataOwner();
      const analysis = buildAnalysis({
        id: op.shotId,
        overallScore: op.score,
        capturedAtIso: op.capturedAt,
      });
      if (owner === SIGNED_OUT_DATA_OWNER) {
        await expect(saveAnalysis(db, analysis, PERMIT_A)).rejects.toThrow(
          SIGNED_OUT_WRITE_ERROR,
        );
        stats.signedOutWritesRejected += 1;
        return;
      }
      await saveAnalysis(db, analysis, permitFor(owner));
      shadow.save(owner, op.shotId, op.score);
      return;
    }
    case 'profile': {
      const owner = getActiveDataOwner();
      if (owner === SIGNED_OUT_DATA_OWNER) return;
      await setKv(db, profileKeyForOwner(owner), op.name);
      shadow.bucket(owner).profile = op.name;
      return;
    }
    case 'drain': {
      const owner = getActiveDataOwner();
      await drainOutbox(db, transportFor(op.mode));
      shadow.drain(owner, op.mode);
      return;
    }
    case 'delayedDrain': {
      setActiveDataOwner(op.startAs);
      let release: () => void = () => {};
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      const parked: SyncTransport = {
        async syncShots(shots) {
          await gate;
          return {
            acceptedIds: shots.map(s => String((s as { id: string }).id)),
            rejected: [],
          };
        },
        async createSession() {},
        async finalizeSession() {},
      };
      const selected = shadow.selectForDrain(op.startAs);
      const drain = drainOutbox(db, parked);
      // Let the drain reach its (parked) network call before switching.
      await new Promise<void>(resolve => setImmediate(resolve));
      setActiveDataOwner(op.switchTo);
      const analysis = buildAnalysis({
        id: op.shotId,
        overallScore: op.score,
        capturedAtIso: op.capturedAt,
      });
      if (op.switchTo === SIGNED_OUT_DATA_OWNER) {
        await expect(saveAnalysis(db, analysis, PERMIT_A)).rejects.toThrow(
          SIGNED_OUT_WRITE_ERROR,
        );
        stats.signedOutWritesRejected += 1;
      } else {
        await saveAnalysis(db, analysis, permitFor(op.switchTo));
        shadow.save(op.switchTo, op.shotId, op.score);
      }
      release();
      await drain;
      // The drain acts on the rows it SELECTED as startAs, under startAs —
      // a row saved after the SELECT (even by the same owner) stays queued.
      shadow.drain(op.startAs, 'accept', selected);
      return;
    }
    case 'purge':
      await purgeOwnerData(db, op.owner);
      shadow.purge(op.owner);
      return;
  }
}

/** Key-order-independent serialization for model ↔ database comparison. */
function canon(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        )
      : v,
  );
}

function collidingIds(shadow: Shadow): number {
  const seen = new Map<string, number>();
  for (const b of shadow.buckets.values()) {
    for (const id of b.shots.keys()) seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  return [...seen.values()].filter(n => n > 1).length;
}

async function runSeed(seed: number, failures: Failure[]): Promise<SeedResult> {
  const rng = mulberry32(seed);
  const shadow = new Shadow();
  const ops: Op[] = [];
  const stats: SeedResult = {
    seed,
    ops: 0,
    opCounts: {},
    signedOutWritesRejected: 0,
    collidingIds: 0,
    finalMatrix: {},
    failures: 0,
  };
  await wipeAll();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  for (let i = 0; i < OPS; i += 1) {
    const op = nextOp(rng, i);
    ops.push(op);
    stats.opCounts[op.kind] = (stats.opCounts[op.kind] ?? 0) + 1;
    stats.ops += 1;
    try {
      await applyOp(op, shadow, stats);
      const expected = shadow.expectedView(getActiveDataOwner());
      const observed = await actualView();
      if (canon(expected) !== canon(observed)) {
        failures.push({
          seed,
          opIndex: i,
          op,
          opsSoFar: [...ops],
          expected,
          observed,
          message: 'active-owner read-back diverged from shadow model',
        });
        stats.failures += 1;
      }
      // Physical rows per owner must match the shadow exactly.
      const matrix = ownershipMatrix(handle());
      const physical = {
        local_shot: matrix['local_shot'] ?? {},
        outbox: matrix['outbox'] ?? {},
        sync_receipt: matrix['sync_receipt'] ?? {},
      };
      const predicted = shadow.counts();
      if (canon(physical) !== canon(predicted)) {
        failures.push({
          seed,
          opIndex: i,
          op,
          opsSoFar: [...ops],
          expected: predicted,
          observed: physical,
          message: 'physical ownership matrix diverged from shadow model',
        });
        stats.failures += 1;
      }
    } catch (error) {
      failures.push({
        seed,
        opIndex: i,
        op,
        opsSoFar: [...ops],
        expected: 'operation completes',
        observed: error instanceof Error ? error.message : String(error),
        message: 'operation threw',
      });
      stats.failures += 1;
    }
  }
  stats.collidingIds = collidingIds(shadow);
  stats.finalMatrix = ownershipMatrix(handle());
  return stats;
}

function handle(): RealSqliteHandle {
  if (!mockHandle) throw new Error('handle missing');
  return mockHandle;
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const evidence: {
  engine: string | null;
  config: { seeds: number; ops: number; replay: string | null };
  seedResults: SeedResult[];
  failures: Failure[];
  totals: Record<string, number>;
  heap: Record<string, unknown>;
} = {
  engine: null,
  config: { seeds: SEEDS, ops: OPS, replay: REPLAY ?? null },
  seedResults: [],
  failures: [],
  totals: {},
  heap: {},
};

beforeAll(() => {
  mockHandle = openRealSqlite();
  evidence.engine = mockHandle.engine;
  evidence.heap['start'] = heapNumbers();
});

afterAll(() => {
  evidence.heap['end'] = heapNumbers();
  const path = writeEvidence('randomized-interleaving.json', evidence);
  console.log(`[xc] randomized interleaving evidence → ${path}`);
  try {
    getDb().close();
  } catch {
    // best effort
  }
  mockHandle?.close();
});

describe('xc account switch — seeded random interleaving vs shadow model', () => {
  const seeds = REPLAY
    ? [Number(REPLAY)]
    : Array.from({ length: SEEDS }, (_, i) => 1000 + i);

  it(`runs ${seeds.length} seed(s) × ${OPS} ops with zero divergences`, async () => {
    const failures: Failure[] = [];
    for (const seed of seeds) {
      evidence.seedResults.push(await runSeed(seed, failures));
    }
    evidence.failures = failures;
    const totals: Record<string, number> = {
      ops: 0,
      signedOutWritesRejected: 0,
    };
    for (const r of evidence.seedResults) {
      totals['ops'] = (totals['ops'] ?? 0) + r.ops;
      totals['signedOutWritesRejected'] =
        (totals['signedOutWritesRejected'] ?? 0) + r.signedOutWritesRejected;
      totals['collidingIdsAtEnd'] =
        (totals['collidingIdsAtEnd'] ?? 0) + r.collidingIds;
      for (const [k, v] of Object.entries(r.opCounts)) {
        totals[`op.${k}`] = (totals[`op.${k}`] ?? 0) + v;
      }
    }
    totals['failures'] = failures.length;
    evidence.totals = totals;
    // The alphabet must actually have exercised every hazard.
    expect(totals['op.delayedDrain']).toBeGreaterThan(0);
    expect(totals['op.purge']).toBeGreaterThan(0);
    expect(totals['signedOutWritesRejected']).toBeGreaterThan(0);
    expect(totals['collidingIdsAtEnd']).toBeGreaterThan(0);
    expect(
      failures.map(f => ({
        seed: f.seed,
        opIndex: f.opIndex,
        message: f.message,
        op: f.op,
      })),
    ).toEqual([]);
  }, 600_000);
});
