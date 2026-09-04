/**
 * STRESS (lens: randomized-seeded) — unit `mod-sync-runtime`, pure surface.
 *
 * Seeded property campaign over the two pure functions of the unit's public
 * API: `nextSyncRetryDelayMs` (syncRuntime.ts) and `deriveUploadQueueStatus`
 * (offlineCapabilities.ts). Each iteration is one seed, replayable with
 * STRESS_SEED=<seed>; failing seeds are recorded in results.json alongside the
 * generated input so the coordinator can replay without re-deriving it.
 *
 * Invariants (R = retry delay, Q = queue status):
 *   R1 integer          — the delay is a finite non-negative integer.
 *   R2 jitter_band      — base*(1-j) <= delay <= base*(1+j) (rounded), where
 *                         base = min(BASE * 2^clamp(n,0,10), MAX).
 *   R3 cap              — delay never exceeds MAX*(1+j) for any n (incl. huge,
 *                         negative, fractional and non-finite n).
 *   R4 floor            — delay is never below BASE*(1-j): a failure storm can
 *                         never turn into a tight retry loop.
 *   R5 monotone_base    — for a fixed random draw, delay(n+1) >= delay(n).
 *   R6 deterministic    — same (n, draw) → same delay.
 *   R7 nan_input        — a NaN failure count still yields a finite delay.
 *                         KNOWN OPEN (finding F2): Math.max/min propagate
 *                         NaN, so the function returns NaN; setTimeout(NaN)
 *                         would fire immediately. Unreachable today — the
 *                         only caller passes syncRuntime's own integer
 *                         counter (VERIFIED by reading syncRuntime.ts) — so
 *                         it is pinned by `test.failing` and excluded from
 *                         the gate, not from the campaign.
 *   Q1 partition        — pending + exhausted === rows.length.
 *   Q2 state_shape      — idle ⇔ no rows; needs_attention ⇔ some row has
 *                         attempts >= OUTBOX_MAX_ATTEMPTS; queued otherwise.
 *   Q3 order_invariant  — shuffling rows does not change the result.
 *   Q4 monotone_attempt — bumping one row's attempts never reduces exhausted.
 *   Q5 kind_agnostic    — kind/lastError do not influence the status.
 *
 * STRESS_ITER (default 2000 — the surface is pure so the full campaign is
 * cheap), STRESS_SEED_BASE, STRESS_SEED, STRESS_RUN_ID as in the runtime
 * harness. Results: artifacts/stress/mod-sync-runtime-randomized-seeded/
 * <run-id>/pure-results.json.
 */
import { OUTBOX_MAX_ATTEMPTS } from '../../src/data/sync';
import {
  SYNC_RETRY_BASE_MS,
  SYNC_RETRY_JITTER_RATIO,
  SYNC_RETRY_MAX_MS,
  nextSyncRetryDelayMs,
} from '../../src/data/syncRuntime';
import {
  deriveUploadQueueStatus,
  type OutboxRowStatus,
  type UploadQueueStatus,
} from '../../src/data/offlineCapabilities';
import { randomInt, seededRandom } from '../../testing/xcBehavioral/evidence';

// syncRuntime imports the native SQLite binding through data/db; the pure
// functions under test never touch it.
jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));

declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const fs = require('fs') as {
  mkdirSync: (dir: string, options: { recursive: boolean }) => void;
  writeFileSync: (file: string, data: string) => void;
};
const path = require('path') as {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
};

const ENV = process.env;
const ITER = Math.max(1, Number(ENV['STRESS_ITER'] ?? '2000') || 2000);
const SEED_BASE = Number(ENV['STRESS_SEED_BASE'] ?? '20260904') || 20260904;
const ONLY_SEED =
  ENV['STRESS_SEED'] !== undefined ? Number(ENV['STRESS_SEED']) : null;
const RUN_ID = ENV['STRESS_RUN_ID'] ?? 'local';

const MIN_DELAY = Math.round(
  SYNC_RETRY_BASE_MS * (1 - SYNC_RETRY_JITTER_RATIO),
);
const MAX_DELAY = Math.round(SYNC_RETRY_MAX_MS * (1 + SYNC_RETRY_JITTER_RATIO));

/** Invariant codes with an open finding on the baseline (see header). */
const KNOWN_OPEN_FINDINGS: ReadonlySet<string> = new Set(['R7']);

function invariantCode(violation: string): string {
  return violation.split(' ')[0] ?? violation;
}

function seedList(): number[] {
  if (ONLY_SEED !== null) return [ONLY_SEED];
  return Array.from({ length: ITER }, (_, i) => (SEED_BASE + i) >>> 0);
}

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[
    Math.min(items.length - 1, Math.floor(random() * items.length))
  ]!;
}

// ─── Retry delay ─────────────────────────────────────────────────────────────

interface RetryCase {
  consecutiveFailures: number;
  draw: number;
}

const RETRY_EDGE_FAILURES = [
  -1e9,
  -1,
  -0.5,
  0,
  0.5,
  1,
  2,
  9,
  10,
  11,
  63,
  1e6,
  Number.MAX_SAFE_INTEGER,
  Number.POSITIVE_INFINITY,
  Number.NaN,
];
const RETRY_EDGE_DRAWS = [
  0,
  Number.EPSILON,
  0.25,
  0.5,
  0.75,
  1 - Number.EPSILON,
];

function generateRetryCase(random: () => number): RetryCase {
  const shape = random();
  const consecutiveFailures =
    shape < 0.2
      ? pick(random, RETRY_EDGE_FAILURES)
      : shape < 0.6
        ? randomInt(random, 0, 12)
        : shape < 0.8
          ? randomInt(random, 13, 200)
          : random() * 40 - 10;
  const draw = random() < 0.2 ? pick(random, RETRY_EDGE_DRAWS) : random();
  return { consecutiveFailures, draw };
}

function expectedBase(consecutiveFailures: number): number {
  const exponent = Math.max(0, Math.min(consecutiveFailures, 10));
  return Math.min(SYNC_RETRY_BASE_MS * 2 ** exponent, SYNC_RETRY_MAX_MS);
}

function checkRetry(c: RetryCase): string[] {
  const violations: string[] = [];
  const delay = nextSyncRetryDelayMs(c.consecutiveFailures, () => c.draw);
  if (Number.isNaN(c.consecutiveFailures)) {
    if (!(delay >= MIN_DELAY && delay <= MAX_DELAY)) {
      violations.push(`R7 nan_input: ${delay}`);
    }
    return violations;
  }
  if (!Number.isInteger(delay) || delay < 0) {
    violations.push(`R1 integer: ${delay}`);
  }
  const base = expectedBase(c.consecutiveFailures);
  const lo = Math.round(base * (1 - SYNC_RETRY_JITTER_RATIO));
  const hi = Math.round(base * (1 + SYNC_RETRY_JITTER_RATIO));
  if (delay < lo - 1 || delay > hi + 1) {
    violations.push(`R2 jitter_band: ${delay} not in [${lo}, ${hi}]`);
  }
  if (delay > MAX_DELAY) violations.push(`R3 cap: ${delay} > ${MAX_DELAY}`);
  if (delay < MIN_DELAY) violations.push(`R4 floor: ${delay} < ${MIN_DELAY}`);
  if (Number.isFinite(c.consecutiveFailures)) {
    const next = nextSyncRetryDelayMs(c.consecutiveFailures + 1, () => c.draw);
    if (next < delay) {
      violations.push(
        `R5 monotone_base: f(${c.consecutiveFailures + 1})=${next} < ${delay}`,
      );
    }
  }
  const again = nextSyncRetryDelayMs(c.consecutiveFailures, () => c.draw);
  if (again !== delay)
    violations.push(`R6 deterministic: ${again} vs ${delay}`);
  return violations;
}

// ─── Queue status ────────────────────────────────────────────────────────────

const KINDS = [
  'shot.sync',
  'session.create',
  'session.finalize',
  'evaluation.trial',
  'unknown.kind',
  '',
];
const ERRORS = [
  null,
  'network.timeout',
  'shot.write_failed',
  '',
  'x'.repeat(200),
];

function generateRows(random: () => number): OutboxRowStatus[] {
  const shape = random();
  const count =
    shape < 0.1
      ? 0
      : shape < 0.7
        ? randomInt(random, 1, 12)
        : randomInt(random, 13, 120);
  const rows: OutboxRowStatus[] = [];
  for (let i = 0; i < count; i += 1) {
    const a = random();
    const attempts =
      a < 0.5
        ? randomInt(random, 0, OUTBOX_MAX_ATTEMPTS - 1)
        : a < 0.8
          ? OUTBOX_MAX_ATTEMPTS
          : a < 0.9
            ? randomInt(random, OUTBOX_MAX_ATTEMPTS + 1, 1000)
            : pick(random, [-1, 0.5, OUTBOX_MAX_ATTEMPTS - 0.001, 1e9]);
    rows.push({
      kind: pick(random, KINDS),
      attempts,
      lastError: pick(random, ERRORS),
    });
  }
  return rows;
}

function shuffled<T>(random: () => number, items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomInt(random, 0, i);
    const tmp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = tmp;
  }
  return copy;
}

function exhaustedCount(status: UploadQueueStatus): number {
  return status.state === 'needs_attention' ? status.exhausted : 0;
}

function pendingCount(status: UploadQueueStatus): number {
  return status.state === 'idle' ? 0 : status.pending;
}

function checkQueue(random: () => number, rows: OutboxRowStatus[]): string[] {
  const violations: string[] = [];
  const status = deriveUploadQueueStatus(rows);
  const expectedExhausted = rows.filter(
    r => r.attempts >= OUTBOX_MAX_ATTEMPTS,
  ).length;
  if (pendingCount(status) + exhaustedCount(status) !== rows.length) {
    violations.push(
      `Q1 partition: ${JSON.stringify(status)} for ${rows.length} rows`,
    );
  }
  const expectedState =
    rows.length === 0
      ? 'idle'
      : expectedExhausted > 0
        ? 'needs_attention'
        : 'queued';
  if (
    status.state !== expectedState ||
    exhaustedCount(status) !== expectedExhausted
  ) {
    violations.push(
      `Q2 state_shape: ${JSON.stringify(status)} expected ${expectedState}/${expectedExhausted}`,
    );
  }
  const permuted = deriveUploadQueueStatus(shuffled(random, rows));
  if (JSON.stringify(permuted) !== JSON.stringify(status)) {
    violations.push(
      `Q3 order_invariant: ${JSON.stringify(permuted)} vs ${JSON.stringify(status)}`,
    );
  }
  if (rows.length > 0) {
    const idx = randomInt(random, 0, rows.length - 1);
    const bumped = rows.map((r, i) =>
      i === idx ? { ...r, attempts: r.attempts + randomInt(random, 1, 10) } : r,
    );
    const after = deriveUploadQueueStatus(bumped);
    if (exhaustedCount(after) < exhaustedCount(status)) {
      violations.push(
        `Q4 monotone_attempt: ${exhaustedCount(after)} < ${exhaustedCount(status)}`,
      );
    }
    const relabelled = rows.map(r => ({
      ...r,
      kind: pick(random, KINDS),
      lastError: pick(random, ERRORS),
    }));
    const relabelledStatus = deriveUploadQueueStatus(relabelled);
    if (JSON.stringify(relabelledStatus) !== JSON.stringify(status)) {
      violations.push(
        `Q5 kind_agnostic: ${JSON.stringify(relabelledStatus)} vs ${JSON.stringify(status)}`,
      );
    }
  }
  return violations;
}

// ─── Campaign ────────────────────────────────────────────────────────────────

interface PureSeedResult {
  seed: number;
  outcome: 'HELD' | 'BROKEN';
  knownOpenOnly: boolean;
  retryCase: RetryCase;
  retryDelay: number;
  rows: number;
  queueStatus: UploadQueueStatus;
  violations: string[];
  input: { rows: OutboxRowStatus[] } | null;
}

const results: PureSeedResult[] = [];

function runSeed(seed: number): PureSeedResult {
  const random = seededRandom(seed);
  const retryCase = generateRetryCase(random);
  const rows = generateRows(random);
  const violations = [...checkRetry(retryCase), ...checkQueue(random, rows)];
  return {
    seed,
    outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
    knownOpenOnly:
      violations.length > 0 &&
      violations.every(v => KNOWN_OPEN_FINDINGS.has(invariantCode(v))),
    retryCase,
    retryDelay: nextSyncRetryDelayMs(
      retryCase.consecutiveFailures,
      () => retryCase.draw,
    ),
    rows: rows.length,
    queueStatus: deriveUploadQueueStatus(rows),
    violations,
    input: violations.length > 0 ? { rows } : null,
  };
}

describe('stress: pure sync-runtime surface under seeded random inputs', () => {
  const seeds = seedList();

  afterAll(() => {
    if (results.length === 0) return;
    const root = path.resolve(__dirname, '..', '..', '..', '..');
    const dir = path.join(
      root,
      'artifacts',
      'stress',
      'mod-sync-runtime-randomized-seeded',
      RUN_ID,
    );
    fs.mkdirSync(dir, { recursive: true });
    const broken = results.filter(r => r.outcome === 'BROKEN');
    fs.writeFileSync(
      path.join(dir, 'pure-results.json'),
      JSON.stringify(
        {
          unit: 'mod-sync-runtime (pure surface)',
          lens: 'randomized-seeded',
          runId: RUN_ID,
          seedBase: SEED_BASE,
          iterations: results.length,
          held: results.length - broken.length,
          broken: broken.length,
          brokenSeeds: broken.map(r => r.seed),
          brokenKnownOpenOnly: broken.filter(r => r.knownOpenOnly).length,
          brokenNew: broken.filter(r => !r.knownOpenOnly).map(r => r.seed),
          knownOpenFindings: [...KNOWN_OPEN_FINDINGS],
          replay:
            'STRESS_SEED=<seed> npx jest __tests__/stress/syncRetryAndQueueStatus',
          results,
        },
        null,
        1,
      ),
    );
  });

  it(`seeds ${seeds[0]}..${seeds[seeds.length - 1]} (${seeds.length}) hold R1-R6 and Q1-Q5`, () => {
    const broken: string[] = [];
    for (const seed of seeds) {
      const result = runSeed(seed);
      results.push(result);
      if (result.outcome === 'BROKEN' && !result.knownOpenOnly) {
        broken.push(`seed ${seed}: ${result.violations.join(' || ')}`);
      }
    }
    expect(broken).toEqual([]);
  });

  // Finding F2 (known open, P3): NaN in, NaN out. Promote to `it` and remove
  // 'R7' from KNOWN_OPEN_FINDINGS once nextSyncRetryDelayMs guards its input.
  test.failing(
    'F2 (known open): NaN consecutiveFailures still yields a bounded delay',
    () => {
      const delay = nextSyncRetryDelayMs(Number.NaN, () => 0.5);
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeGreaterThanOrEqual(MIN_DELAY);
      expect(delay).toBeLessThanOrEqual(MAX_DELAY);
    },
  );

  it('every finite failure count, including negative/huge/fractional, stays in the band', () => {
    for (const n of RETRY_EDGE_FAILURES.filter(v => Number.isFinite(v))) {
      for (const draw of RETRY_EDGE_DRAWS) {
        expect(checkRetry({ consecutiveFailures: n, draw })).toEqual([]);
      }
    }
    for (const draw of RETRY_EDGE_DRAWS) {
      expect(
        checkRetry({ consecutiveFailures: Number.POSITIVE_INFINITY, draw }),
      ).toEqual([]);
    }
  });

  it('same seed twice → identical generated inputs and outputs (D1)', () => {
    for (const seed of seeds.slice(0, Math.min(seeds.length, 200))) {
      expect(JSON.stringify(runSeed(seed))).toBe(JSON.stringify(runSeed(seed)));
    }
  });
});
