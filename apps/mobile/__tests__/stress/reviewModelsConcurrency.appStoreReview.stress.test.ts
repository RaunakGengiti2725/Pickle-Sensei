import { NativeModules } from 'react-native';
import * as fs from 'fs';
import * as path from 'path';

/**
 * STRESS / concurrency — `review/appStoreReview`.
 *
 * Seeded interleavings of every public entry point (scored-analysis report,
 * explicit completion, Settings "Rate" with a working / failing / absent
 * store page) against a kv mock whose reads and writes complete after a
 * seeded number of event-loop hops and may fail. Each seed is replayable:
 *
 *   STRESS_SEED=<seed> STRESS_ITER=1 npx jest --ci __tests__/stress/reviewModelsConcurrency.appStoreReview
 *
 * STRESS_ITER (default 24) sets the campaign size, STRESS_SEED the first
 * seed, STRESS_OUT_DIR writes a seed → outcome JSON table.
 *
 * Invariants asserted per interleaving (module writes only):
 *   no double spend  — StoreKit asks made on behalf of scored analyses equal
 *                      the durable increments (one ask per counted score)
 *   idempotency      — promptedCount === scoredAnalyses at every write
 *   no lost update   — every write derives from the latest successful read
 *   sticky review    — once reviewedAtIso is set no later write clears it and
 *                      no later scored analysis asks again
 *   monotone         — counters never go backwards
 *   no deadlock      — the whole burst settles within a wall-time bound and
 *                      every call resolves (never rejects)
 *   clock skew       — a wall clock jumping around never changes any of the
 *                      above (timestamps are recorded, never compared)
 */

type KvOp =
  | { kind: 'read'; ok: boolean; value: string | null; t: number }
  | { kind: 'write'; ok: boolean; value: string; t: number; actor: 'module' };

let mockKvTable = new Map<string, string>();
let mockKvLog: KvOp[] = [];
let mockKvTick = 0;
let mockReadFailP = 0;
let mockWriteFailP = 0;
let mockKvRng: () => number = () => 0;
let mockHop: () => Promise<void> = async () => {};

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      await mockHop();
      const t = mockKvTick++;
      if (sql.startsWith('SELECT value FROM kv')) {
        if (mockKvRng() < mockReadFailP) {
          mockKvLog.push({ kind: 'read', ok: false, value: null, t });
          throw new Error('kv read unavailable');
        }
        const value = mockKvTable.get(String(params[0])) ?? null;
        mockKvLog.push({ kind: 'read', ok: true, value, t });
        return { rows: value === null ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        const value = String(params[1]);
        if (mockKvRng() < mockWriteFailP) {
          mockKvLog.push({
            kind: 'write',
            ok: false,
            value,
            t,
            actor: 'module',
          });
          throw new Error('kv write unavailable');
        }
        mockKvTable.set(String(params[0]), value);
        mockKvLog.push({ kind: 'write', ok: true, value, t, actor: 'module' });
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

import {
  REVIEW_PROMPT_KV_KEY,
  markStoreReviewCompleted,
  parseReviewPromptState,
  rateAppFromSettings,
  reportScoredAnalysisForReview,
  type ReviewPromptState,
  type SettingsRateOutcome,
} from '../../src/review/appStoreReview';

// ---------------------------------------------------------------- seeded rng

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

function pick<T>(rng: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error('pick from empty list');
  return item;
}

/** Yield to the event loop: 0..n microtask hops, sometimes a macrotask. */
async function hop(rng: () => number): Promise<void> {
  const r = rng();
  if (r < 0.25) return;
  if (r < 0.85) {
    const n = 1 + Math.floor(rng() * 4);
    for (let i = 0; i < n; i += 1) await Promise.resolve();
    return;
  }
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}

// ------------------------------------------------------------------ scenario

type ActionKind =
  'report' | 'mark' | 'rateOk' | 'rateFail' | 'rateNoUrl' | 'skewClock';

interface ActionResult {
  kind: ActionKind;
  outcome: SettingsRateOutcome | 'void' | `rejected:${string}`;
}

interface Iteration {
  seed: number;
  cls: 'healthy' | 'flakyKv' | 'noStoreKit' | 'skew';
  actions: number;
  readFailP: number;
  writeFailP: number;
  wallMs: number;
  outcome: 'HELD' | 'BROKEN';
  violations: string[];
  finalState: ReviewPromptState;
  requestReviewCalls: number;
  kvWrites: number;
  kvFailedOps: number;
}

const WALL_BOUND_MS = 4_000;

function classFor(seed: number): Iteration['cls'] {
  switch (seed % 4) {
    case 0:
      return 'healthy';
    case 1:
      return 'flakyKv';
    case 2:
      return 'noStoreKit';
    default:
      return 'skew';
  }
}

const native = NativeModules as { PickleStoreReview?: unknown };
const realToISOString = Date.prototype.toISOString;

async function runIteration(seed: number): Promise<Iteration> {
  const rng = mulberry32(seed);
  const cls = classFor(seed);
  const violations: string[] = [];

  mockKvTable = new Map();
  mockKvLog = [];
  mockKvTick = 0;
  mockKvRng = mulberry32(seed ^ 0x9e3779b9);
  mockReadFailP = cls === 'flakyKv' ? pick(rng, [0.1, 0.3, 0.5]) : 0;
  mockWriteFailP = cls === 'flakyKv' ? pick(rng, [0.1, 0.3, 0.5]) : 0;
  const hopRng = mulberry32(seed ^ 0x51ed270b);
  mockHop = () => hop(hopRng);

  // Native StoreKit bridge: present (resolving true or throwing) or absent.
  const nativeRng = mulberry32(seed ^ 0x2545f491);
  const requestReview = jest.fn(async () => {
    await hop(nativeRng);
    if (nativeRng() < 0.2) throw new Error('StoreKit refused');
    return true;
  });
  if (cls === 'noStoreKit') delete native.PickleStoreReview;
  else native.PickleStoreReview = { requestReview };

  // Clock skew: the wall clock the module stamps into kv jumps around.
  let skewMs = 0;
  if (cls === 'skew') {
    Date.prototype.toISOString = function skewed(this: Date) {
      return realToISOString.call(new Date(this.getTime() + skewMs));
    };
  }

  const actionCount = 4 + Math.floor(rng() * 28);
  const weights: readonly ActionKind[] =
    cls === 'skew'
      ? [
          'report',
          'report',
          'report',
          'mark',
          'rateOk',
          'rateFail',
          'rateNoUrl',
          'skewClock',
          'skewClock',
        ]
      : [
          'report',
          'report',
          'report',
          'report',
          'mark',
          'rateOk',
          'rateFail',
          'rateNoUrl',
        ];
  const plan: ActionKind[] = [];
  for (let i = 0; i < actionCount; i += 1) plan.push(pick(rng, weights));

  const started = Date.now();
  let directAsks = 0;
  const results: ActionResult[] = [];
  const actionRng = mulberry32(seed ^ 0x7f4a7c15);

  const runAction = async (
    kind: ActionKind,
    index: number,
  ): Promise<ActionResult> => {
    // Staggered start: some actions begin immediately (true Promise.all
    // burst), others after a few hops (call-during-call).
    if (index > 0 && actionRng() < 0.6) await hop(actionRng);
    try {
      switch (kind) {
        case 'report':
          await reportScoredAnalysisForReview({
            delayMs: Math.floor(actionRng() * 3),
          });
          return { kind, outcome: 'void' };
        case 'mark':
          await markStoreReviewCompleted();
          return { kind, outcome: 'void' };
        case 'rateOk': {
          const outcome = await rateAppFromSettings({
            writeReviewUrl:
              'https://apps.apple.com/app/id0?action=write-review',
            openUrl: async () => {
              await hop(actionRng);
              return true;
            },
          });
          return { kind, outcome };
        }
        case 'rateFail': {
          if (cls !== 'noStoreKit') directAsks += 1;
          const outcome = await rateAppFromSettings({
            writeReviewUrl:
              'https://apps.apple.com/app/id0?action=write-review',
            openUrl: async () => {
              await hop(actionRng);
              throw new Error('cannot open store page');
            },
          });
          return { kind, outcome };
        }
        case 'rateNoUrl': {
          if (cls !== 'noStoreKit') directAsks += 1;
          const outcome = await rateAppFromSettings({ writeReviewUrl: null });
          return { kind, outcome };
        }
        case 'skewClock':
          skewMs = Math.floor((actionRng() - 0.5) * 4 * 365 * 24 * 3600 * 1000);
          return { kind, outcome: 'void' };
      }
    } catch (error) {
      return { kind, outcome: `rejected:${String(error)}` };
    }
  };

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), WALL_BOUND_MS);
  });
  const burst = Promise.all(plan.map((kind, index) => runAction(kind, index)));
  const settled = await Promise.race([burst, timeout]);
  clearTimeout(timer);
  if (settled === 'timeout') {
    timedOut = true;
    violations.push(`deadlock: burst did not settle within ${WALL_BOUND_MS}ms`);
  } else {
    results.push(...settled);
  }
  const wallMs = Date.now() - started;

  // Restore globals before asserting.
  Date.prototype.toISOString = realToISOString;

  // ---------------------------------------------------------- invariants
  for (const r of results) {
    if (typeof r.outcome === 'string' && r.outcome.startsWith('rejected:')) {
      violations.push(`call rejected: ${r.kind} → ${r.outcome}`);
    }
  }

  const writes = mockKvLog.filter(
    (op): op is Extract<KvOp, { kind: 'write' }> =>
      op.kind === 'write' && op.ok,
  );
  const reads = mockKvLog.filter(
    (op): op is Extract<KvOp, { kind: 'read' }> => op.kind === 'read' && op.ok,
  );

  let increments = 0;
  let reviewedSeen = false;
  let prevCount = 0;
  for (const w of writes) {
    const state = parseReviewPromptState(w.value);
    if (state.promptedCount !== state.scoredAnalyses) {
      violations.push(
        `counter split at t=${w.t}: prompted=${state.promptedCount} scored=${state.scoredAnalyses}`,
      );
    }
    if (state.promptedCount < prevCount) {
      violations.push(
        `counter went backwards at t=${w.t}: ${prevCount} → ${state.promptedCount}`,
      );
    }
    // Lost update: the write must derive from the latest successful read.
    const lastRead = reads.filter(r => r.t < w.t).at(-1);
    const base = parseReviewPromptState(lastRead?.value ?? null);
    const isIncrement =
      state.promptedCount === base.promptedCount + 1 &&
      state.scoredAnalyses === base.scoredAnalyses + 1 &&
      state.reviewedAtIso === base.reviewedAtIso;
    const isReviewed =
      state.promptedCount === base.promptedCount &&
      state.scoredAnalyses === base.scoredAnalyses &&
      state.reviewedAtIso !== null;
    if (!isIncrement && !isReviewed) {
      violations.push(
        `lost update at t=${w.t}: base=${JSON.stringify(base)} write=${JSON.stringify(state)}`,
      );
    }
    if (isIncrement) increments += 1;
    if (reviewedSeen && state.reviewedAtIso === null) {
      violations.push(`review cleared at t=${w.t}`);
    }
    if (reviewedSeen && isIncrement) {
      violations.push(`asked again after review at t=${w.t}`);
    }
    if (state.reviewedAtIso !== null) reviewedSeen = true;
    prevCount = state.promptedCount;
  }

  const askedForScores = requestReview.mock.calls.length - directAsks;
  if (cls === 'noStoreKit') {
    if (requestReview.mock.calls.length !== 0) {
      violations.push('StoreKit asked while bridge absent');
    }
    if (increments !== 0) {
      violations.push(`counted ${increments} scored analyses without StoreKit`);
    }
  } else if (askedForScores !== increments) {
    violations.push(
      `double spend: ${askedForScores} StoreKit asks for ${increments} counted scores`,
    );
  }

  for (const r of results) {
    if (r.kind === 'rateOk' && r.outcome !== 'store_page') {
      violations.push(`rateOk returned ${r.outcome}`);
    }
    if (r.kind === 'rateFail' || r.kind === 'rateNoUrl') {
      if (r.outcome !== 'native_prompt' && r.outcome !== 'unavailable') {
        violations.push(`${r.kind} returned ${r.outcome}`);
      }
      if (cls === 'noStoreKit' && r.outcome !== 'unavailable') {
        violations.push(`${r.kind} returned ${r.outcome} without StoreKit`);
      }
    }
  }

  const finalState = parseReviewPromptState(
    mockKvTable.get(REVIEW_PROMPT_KV_KEY) ?? null,
  );
  const lastWrite = writes.at(-1);
  if (lastWrite && lastWrite.value !== mockKvTable.get(REVIEW_PROMPT_KV_KEY)) {
    violations.push('final kv row is not the last successful write');
  }
  if (timedOut) {
    // Let the stuck burst drain before the next iteration touches the mocks.
    await burst.catch(() => undefined);
  }

  return {
    seed,
    cls,
    actions: actionCount,
    readFailP: mockReadFailP,
    writeFailP: mockWriteFailP,
    wallMs,
    outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
    violations,
    finalState,
    requestReviewCalls: requestReview.mock.calls.length,
    kvWrites: writes.length,
    kvFailedOps: mockKvLog.filter(op => !op.ok).length,
  };
}

// ------------------------------------------------------------------ campaign

const ITER = Math.max(1, Number(process.env.STRESS_ITER ?? 24) || 24);
const SEED0 = Number(process.env.STRESS_SEED ?? 1) || 1;
const OUT_DIR = process.env.STRESS_OUT_DIR;

afterAll(() => {
  Date.prototype.toISOString = realToISOString;
  delete native.PickleStoreReview;
});

describe('appStoreReview under seeded concurrent bursts', () => {
  it(
    `holds idempotency / no double spend / no lost update over ${ITER} interleavings from seed ${SEED0}`,
    async () => {
      const table: Iteration[] = [];
      for (let i = 0; i < ITER; i += 1) {
        table.push(await runIteration(SEED0 + i));
      }
      if (OUT_DIR) {
        fs.mkdirSync(OUT_DIR, { recursive: true });
        fs.writeFileSync(
          path.join(
            OUT_DIR,
            `appStoreReview.concurrency.seed${SEED0}.n${ITER}.json`,
          ),
          JSON.stringify(
            {
              suite: 'reviewModelsConcurrency.appStoreReview',
              seed0: SEED0,
              iterations: table.length,
              actionsExecuted: table.reduce((n, it) => n + it.actions, 0),
              broken: table
                .filter(it => it.outcome === 'BROKEN')
                .map(it => it.seed),
              table,
            },
            null,
            2,
          ),
        );
      }
      const broken = table.filter(it => it.outcome === 'BROKEN');
      expect(
        broken.map(it => ({
          seed: it.seed,
          cls: it.cls,
          violations: it.violations,
        })),
      ).toEqual([]);
      expect(table).toHaveLength(ITER);
      for (const it of table) expect(it.wallMs).toBeLessThan(WALL_BOUND_MS);
    },
    Math.max(30_000, ITER * WALL_BOUND_MS),
  );
});
