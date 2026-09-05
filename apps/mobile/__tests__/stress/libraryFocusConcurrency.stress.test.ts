import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CHECKPOINTS, RANK_FORM_WINDOW } from '@pickle/shared-types';
import {
  MIN_FOCUS_SAMPLES,
  SHOT_FAMILY,
  computeLibraryFocus,
  recommendDrills,
  type LibraryFocus,
  type ScoredCheckpointFact,
} from '../../src/library/libraryFocus';

/**
 * CONCURRENCY STRESS for library/libraryFocus.
 *
 * The engine is pure and synchronous, so the interesting concurrency lives in
 * how it is driven: bursts of simultaneous calls over shared rows, writers
 * mutating the rows between calls, and the screen's async
 * `read facts → computeLibraryFocus → setFocus` loader racing against
 * refreshes, writers, sign-out and unmount.
 *
 * Every iteration is replayable from its seed: a seeded scheduler decides the
 * interleaving of every pending continuation, so a failing seed reproduces
 * the exact interleaving. Results are written as a JSON seed table when
 * STRESS_OUT is set.
 *
 *   STRESS_ITER=2000 STRESS_OUT=/tmp/focus.json npx jest --ci stress/libraryFocusConcurrency
 *   STRESS_SEED=1234 npx jest --ci stress/libraryFocusConcurrency   # replay one seed
 *
 * Invariants:
 *  - idempotency: identical inputs → identical output regardless of how many
 *    calls interleave, and never a torn/partial read;
 *  - purity: deeply frozen inputs are never written (a write would throw);
 *  - no lost update when the backing read completes in issue order (FIFO —
 *    op-sqlite runs one worker thread per connection, so `execute` promises
 *    settle in call order), and none with a request-id guard when reads
 *    complete out of order; the unguarded out-of-order miss rate is measured;
 *  - no cross-owner focus after a sign-out/sign-in rotation;
 *  - no deadlock: every burst settles inside a bounded number of scheduler
 *    steps and bounded wall time;
 *  - clock skew (non-monotonic capture clocks, far-future, sub-second
 *    collisions) never breaks determinism or the evidence gate.
 */

// ─── Configuration ─────────────────────────────────────────────────────────

const ITERATIONS = Math.max(
  1,
  Number.parseInt(process.env.STRESS_ITER ?? '120', 10) || 120,
);
const REPLAY_SEED = process.env.STRESS_SEED
  ? Number.parseInt(process.env.STRESS_SEED, 10)
  : null;
const OUT_PATH = process.env.STRESS_OUT ?? null;
const SEED_BASE = 0x5f0c05;
const MAX_STEPS = 4_000;
const MAX_ITERATION_MS = 5_000;

// ─── Seeded PRNG (mulberry32) ──────────────────────────────────────────────

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

function int(rng: Rng, min: number, maxInclusive: number): number {
  return min + Math.floor(rng() * (maxInclusive - min + 1));
}

// ─── Seeded scheduler ──────────────────────────────────────────────────────

/**
 * Every `await sched.step()` parks the caller; `drive()` releases parked
 * continuations one at a time in seeded-random order, flushing microtasks
 * between releases so newly parked continuations join the pool. This yields
 * an exhaustive-in-the-limit exploration of interleavings, each reproducible
 * from the seed.
 */
class SeededScheduler {
  private pending: Array<() => void> = [];
  steps = 0;

  constructor(private readonly rng: Rng) {}

  step(): Promise<void> {
    return new Promise<void>(resolve => {
      this.pending.push(resolve);
    });
  }

  async drive(
    maxSteps: number,
  ): Promise<{ steps: number; exhausted: boolean }> {
    for (;;) {
      await flushMicrotasks();
      if (this.pending.length === 0) {
        await flushMicrotasks();
        if (this.pending.length === 0) break;
      }
      if (this.steps >= maxSteps) return { steps: this.steps, exhausted: true };
      const index = Math.floor(this.rng() * this.pending.length);
      const [release] = this.pending.splice(index, 1);
      release!();
      this.steps += 1;
    }
    return { steps: this.steps, exhausted: false };
  }
}

function flushMicrotasks(): Promise<void> {
  return new Promise<void>(resolve => {
    setImmediate(resolve);
  });
}

// ─── Fact generation (valid, hostile, and clock-skewed) ────────────────────

const TECHNIQUES = [
  'dink',
  'volley',
  'forehand_drive',
  'backhand_drive',
  'serve',
  'return',
  'third_shot_drop',
  'overhead',
  'mystery_shot',
] as const;

const CHECKPOINT_KEYS = [...CHECKPOINTS, 'contact_height'] as const;

const HOSTILE_SCORES = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  -50,
  250,
] as const;

/** Wall-clock model: mostly monotonic, occasionally jumping backwards (NTP
 * correction, manual clock change), occasionally far in the future. */
class SkewedClock {
  private nowMs: number;

  constructor(
    private readonly rng: Rng,
    private readonly skewRate: number,
  ) {
    this.nowMs = Date.UTC(2026, 7, 1, 10, 0, 0);
  }

  next(): string {
    const roll = this.rng();
    if (roll < this.skewRate * 0.5) {
      // Clock jumped backwards by up to a day.
      this.nowMs -= int(this.rng, 1, 86_400) * 1_000;
    } else if (roll < this.skewRate * 0.75) {
      // Clock jumped a year ahead.
      this.nowMs += 365 * 86_400_000;
    } else if (roll < this.skewRate) {
      // Same second as the previous capture (sub-second collision).
    } else {
      this.nowMs += int(this.rng, 1, 3_600) * 1_000;
    }
    // Native ClipMediaStore stamps whole seconds (ISO8601DateFormatter).
    return new Date(this.nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
}

/** Narrow vocabulary so a handful of rows already clear MIN_FOCUS_SAMPLES and
 * every write has a real chance of moving the weakest checkpoint. */
const DENSE_TECHNIQUES = ['dink', 'volley'] as const;
const DENSE_CHECKPOINT_KEYS = CHECKPOINT_KEYS.slice(0, 3);

let factCounter = 0;

function randomFact(
  rng: Rng,
  clock: SkewedClock,
  hostileRate: number,
  dense = false,
): ScoredCheckpointFact {
  factCounter += 1;
  // The engine scores each checkpoint key at most once per read, so keys are
  // unique within a fact (a fact then contributes ≤ 1 sample per key).
  const pool: string[] = [...(dense ? DENSE_CHECKPOINT_KEYS : CHECKPOINT_KEYS)];
  const checkpointCount = dense ? int(rng, 2, 3) : int(rng, 0, 5);
  const checkpoints = Array.from({ length: checkpointCount }, () => {
    const [key] = pool.splice(int(rng, 0, pool.length - 1), 1);
    const roll = rng();
    const score =
      roll < hostileRate * 0.5
        ? null
        : roll < hostileRate
          ? pick(rng, HOSTILE_SCORES)
          : Math.round(rng() * 100);
    return {
      key: key!,
      score,
      applicable: rng() < 0.85,
    };
  });
  return {
    id: `00000000-0000-4000-8000-${String(factCounter).padStart(12, '0')}`,
    shotType: dense ? pick(rng, DENSE_TECHNIQUES) : pick(rng, TECHNIQUES),
    capturedAt: clock.next(),
    checkpoints,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sameFocus(a: LibraryFocus | null, b: LibraryFocus | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function assertWellFormed(focus: LibraryFocus | null): string | null {
  if (focus === null) return null;
  if (!Number.isFinite(focus.averageScore)) return 'non-finite averageScore';
  if (!Number.isInteger(focus.averageScore)) return 'non-integer averageScore';
  if (focus.averageScore < -50 || focus.averageScore > 250) {
    return 'averageScore outside input range';
  }
  if (focus.sampleCount < MIN_FOCUS_SAMPLES) return 'below evidence minimum';
  if (focus.sampleCount > RANK_FORM_WINDOW) return 'sampleCount exceeds window';
  if (focus.family !== (SHOT_FAMILY[focus.shotType] ?? 'global')) {
    return 'family does not match technique';
  }
  return null;
}

// ─── Seed table ────────────────────────────────────────────────────────────

interface SeedRow {
  seed: number;
  scenario: string;
  outcome: 'HELD' | 'BROKEN';
  steps: number;
  wallMs: number;
  detail: string;
  metrics: Record<string, number>;
}

const rows: SeedRow[] = [];

function record(row: SeedRow): void {
  rows.push(row);
}

afterAll(() => {
  if (!OUT_PATH) return;
  const broken = rows.filter(row => row.outcome === 'BROKEN');
  const summary = {
    unit: 'apps/mobile/src/library/libraryFocus.ts',
    lens: 'concurrency',
    iterationsPerScenario: ITERATIONS,
    replaySeed: REPLAY_SEED,
    scenariosExecuted: rows.length,
    interleavingSteps: rows.reduce((sum, row) => sum + row.steps, 0),
    broken: broken.length,
    brokenSeeds: broken.map(row => ({
      seed: row.seed,
      scenario: row.scenario,
    })),
    byScenario: Object.fromEntries(
      [...new Set(rows.map(row => row.scenario))].map(scenario => {
        const subset = rows.filter(row => row.scenario === scenario);
        const metrics: Record<string, number> = {};
        for (const row of subset) {
          for (const [key, value] of Object.entries(row.metrics)) {
            metrics[key] = (metrics[key] ?? 0) + value;
          }
        }
        return [
          scenario,
          {
            iterations: subset.length,
            broken: subset.filter(row => row.outcome === 'BROKEN').length,
            steps: subset.reduce((sum, row) => sum + row.steps, 0),
            maxWallMs: Math.max(...subset.map(row => row.wallMs)),
            metrics,
          },
        ];
      }),
    ),
    rows,
  };
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(summary, null, 2));
});

function seedsFor(scenarioOffset: number): number[] {
  if (REPLAY_SEED !== null) return [REPLAY_SEED];
  return Array.from(
    { length: ITERATIONS },
    (_, i) => SEED_BASE + scenarioOffset * 1_000_000 + i,
  );
}

// ─── Scenario 1: duplicate bursts over frozen shared rows ──────────────────

describe('computeLibraryFocus — concurrent bursts (seeded scheduler)', () => {
  it('duplicate calls in a Promise.all burst are idempotent over frozen rows', async () => {
    for (const seed of seedsFor(1)) {
      const rng = mulberry32(seed);
      const sched = new SeededScheduler(rng);
      const clock = new SkewedClock(rng, 0.1);
      factCounter = 0;
      const facts = deepFreeze(
        Array.from({ length: int(rng, 0, 40) }, () =>
          randomFact(rng, clock, 0.15),
        ),
      );
      const expected = computeLibraryFocus(facts);
      const callers = int(rng, 2, 32);
      const startedAt = Date.now();
      const results: (LibraryFocus | null)[] = [];
      let threw: string | null = null;

      const burst = Promise.all(
        Array.from({ length: callers }, async (_, i) => {
          // Random pre-delay so calls interleave in a seed-determined order.
          for (let hop = int(rng, 0, 3); hop > 0; hop -= 1) await sched.step();
          try {
            results[i] = computeLibraryFocus(facts);
          } catch (error) {
            threw = `caller ${i}: ${String(error)}`;
          }
          await sched.step();
        }),
      );
      const { steps, exhausted } = await sched.drive(MAX_STEPS);
      await burst;
      const wallMs = Date.now() - startedAt;

      const problems: string[] = [];
      if (threw) problems.push(threw);
      if (exhausted) problems.push('scheduler exhausted: possible deadlock');
      if (wallMs > MAX_ITERATION_MS) problems.push(`wall ${wallMs}ms`);
      if (results.length !== callers) problems.push('a caller never returned');
      const malformed = assertWellFormed(expected);
      if (malformed) problems.push(malformed);
      results.forEach((result, i) => {
        if (!sameFocus(result, expected)) {
          problems.push(`caller ${i} diverged: ${JSON.stringify(result)}`);
        }
      });

      record({
        seed,
        scenario: 'burst-duplicate-frozen',
        outcome: problems.length === 0 ? 'HELD' : 'BROKEN',
        steps,
        wallMs,
        detail: problems.join('; '),
        metrics: { callers, facts: facts.length, nonNull: expected ? 1 : 0 },
      });
      expect({ seed, problems }).toEqual({ seed, problems: [] });
    }
  });

  // ─── Scenario 2: two actors on the same rows ────────────────────────────

  it('readers racing a writer on the same rows always see an atomic snapshot', async () => {
    for (const seed of seedsFor(2)) {
      const rng = mulberry32(seed);
      const sched = new SeededScheduler(rng);
      const clock = new SkewedClock(rng, 0.15);
      factCounter = 0;
      const shared: ScoredCheckpointFact[] = Array.from(
        { length: int(rng, 2, 24) },
        () => randomFact(rng, clock, 0.1),
      );
      const readers = int(rng, 2, 16);
      const writes = int(rng, 1, 24);
      const startedAt = Date.now();
      const problems: string[] = [];
      let observed = 0;

      const writer = (async () => {
        for (let w = 0; w < writes; w += 1) {
          await sched.step();
          const op = rng();
          if (op < 0.4) {
            shared.push(randomFact(rng, clock, 0.1));
          } else if (op < 0.6 && shared.length > 0) {
            shared.splice(int(rng, 0, shared.length - 1), 1);
          } else if (shared.length > 0) {
            // In-place edit of one row's checkpoint — the "same row" actor.
            const row = pick(rng, shared);
            const checkpoint = pick(rng, row.checkpoints);
            if (checkpoint) {
              checkpoint.score =
                rng() < 0.2
                  ? pick(rng, HOSTILE_SCORES)
                  : Math.round(rng() * 100);
              checkpoint.applicable = rng() < 0.85;
            }
            if (rng() < 0.3) row.capturedAt = clock.next();
          }
        }
      })();

      const readerBurst = Promise.all(
        Array.from({ length: readers }, async () => {
          for (let hop = int(rng, 0, 4); hop > 0; hop -= 1) await sched.step();
          const snapshot = clone(shared);
          const live = computeLibraryFocus(shared);
          // The read must be atomic: the result equals the result over the
          // snapshot taken synchronously alongside it, and re-running over
          // the snapshot is idempotent.
          const fromSnapshot = computeLibraryFocus(snapshot);
          observed += 1;
          if (!sameFocus(live, fromSnapshot)) {
            problems.push(`torn read: ${JSON.stringify([live, fromSnapshot])}`);
          }
          if (!sameFocus(computeLibraryFocus(snapshot), fromSnapshot)) {
            problems.push('non-idempotent over identical snapshot');
          }
          const malformed = assertWellFormed(live);
          if (malformed) problems.push(malformed);
          await sched.step();
        }),
      );

      const { steps, exhausted } = await sched.drive(MAX_STEPS);
      await Promise.all([writer, readerBurst]);
      const wallMs = Date.now() - startedAt;
      if (exhausted) problems.push('scheduler exhausted: possible deadlock');
      if (wallMs > MAX_ITERATION_MS) problems.push(`wall ${wallMs}ms`);
      if (observed !== readers) problems.push('a reader never returned');

      record({
        seed,
        scenario: 'two-actors-same-rows',
        outcome: problems.length === 0 ? 'HELD' : 'BROKEN',
        steps,
        wallMs,
        detail: problems.join('; '),
        metrics: { readers, writes, finalRows: shared.length },
      });
      expect({ seed, problems }).toEqual({ seed, problems: [] });
    }
  });

  // ─── Scenario 3: clock skew ─────────────────────────────────────────────

  it('non-monotonic capture clocks never break determinism, the window, or the evidence gate', async () => {
    for (const seed of seedsFor(3)) {
      const rng = mulberry32(seed);
      const sched = new SeededScheduler(rng);
      // Aggressive skew: half of the captures land on a jumped clock.
      const clock = new SkewedClock(rng, 0.5);
      factCounter = 0;
      const facts: ScoredCheckpointFact[] = Array.from(
        { length: int(rng, 0, 60) },
        () => randomFact(rng, clock, 0.05),
      );
      const startedAt = Date.now();
      const problems: string[] = [];

      const orderings = int(rng, 2, 8);
      const results: (LibraryFocus | null)[] = [];
      const burst = Promise.all(
        Array.from({ length: orderings }, async (_, i) => {
          await sched.step();
          const permuted = [...facts];
          for (let k = permuted.length - 1; k > 0; k -= 1) {
            const j = Math.floor(rng() * (k + 1));
            [permuted[k], permuted[j]] = [permuted[j]!, permuted[k]!];
          }
          results[i] = computeLibraryFocus(permuted);
        }),
      );
      const { steps, exhausted } = await sched.drive(MAX_STEPS);
      await burst;
      const wallMs = Date.now() - startedAt;

      const baseline = computeLibraryFocus(facts);
      results.forEach((result, i) => {
        if (!sameFocus(result, baseline)) {
          problems.push(`ordering ${i} changed the focus`);
        }
      });
      const malformed = assertWellFormed(baseline);
      if (malformed) problems.push(malformed);

      // Whole-second ISO-8601 UTC stamps sort lexicographically exactly as
      // they sort chronologically — the engine's string comparison is the
      // chronological order for the shipping producer.
      const lexical = [...facts]
        .map(f => f.capturedAt)
        .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
      const chronological = [...facts]
        .map(f => f.capturedAt)
        .sort((a, b) => Date.parse(b) - Date.parse(a));
      if (JSON.stringify(lexical) !== JSON.stringify(chronological)) {
        problems.push('lexicographic order diverged from chronological');
      }

      // The window per technique must be the RANK_FORM_WINDOW newest by the
      // stamp (even when a backwards clock made a later capture "older").
      if (baseline) {
        const perTechnique = facts
          .filter(f => f.shotType === baseline.shotType)
          .sort((a, b) =>
            a.capturedAt === b.capturedAt
              ? a.id < b.id
                ? 1
                : -1
              : a.capturedAt < b.capturedAt
                ? 1
                : -1,
          )
          .slice(0, RANK_FORM_WINDOW);
        const inWindow = perTechnique.reduce(
          (sum, f) =>
            sum +
            f.checkpoints.filter(
              c =>
                c.key === baseline.checkpoint &&
                c.applicable &&
                c.score !== null &&
                Number.isFinite(c.score),
            ).length,
          0,
        );
        if (baseline.sampleCount !== inWindow) {
          problems.push(
            `sampleCount ${baseline.sampleCount} != in-window observations ${inWindow}`,
          );
        }
      }
      if (exhausted) problems.push('scheduler exhausted: possible deadlock');
      if (wallMs > MAX_ITERATION_MS) problems.push(`wall ${wallMs}ms`);

      record({
        seed,
        scenario: 'clock-skew',
        outcome: problems.length === 0 ? 'HELD' : 'BROKEN',
        steps,
        wallMs,
        detail: problems.join('; '),
        metrics: { facts: facts.length, orderings, nonNull: baseline ? 1 : 0 },
      });
      expect({ seed, problems }).toEqual({ seed, problems: [] });
    }
  });
});

// ─── Scenario 4: the screen loader pattern (read → compute → commit) ───────

type ReadOrder = 'fifo' | 'reorder';
type Guard = 'unguarded' | 'requestId';

interface ScreenInstance {
  owner: string;
  mounted: boolean;
  focus: LibraryFocus | null;
  requestId: number;
  commits: number;
  lateCommits: number;
  /** Rows read by the load that completed its read LAST (wall order). */
  lastReadSnapshot: ScoredCheckpointFact[] | null;
  /** Rows read by the most recently ISSUED load (highest request id). */
  newestIssuedSnapshot: ScoredCheckpointFact[] | null;
  newestIssuedSeq: number;
  committedSeq: number;
  /** Commits whose read was issued before an already-committed read. */
  outOfOrderCommits: number;
  /** Out-of-order commits that actually changed the displayed focus. */
  staleOverwrites: number;
  /** Commits that changed the displayed focus at all. */
  focusChanges: number;
}

interface World {
  owners: Record<string, ScoredCheckpointFact[]>;
  activeOwner: string;
  screen: ScreenInstance | null;
  loads: Promise<void>[];
  seq: number;
  fifoTail: Promise<void>;
  /** Loads issued for an owner other than the mounted screen's owner. */
  crossOwnerReads: number;
}

function newScreen(owner: string): ScreenInstance {
  return {
    owner,
    mounted: true,
    focus: null,
    requestId: 0,
    commits: 0,
    lateCommits: 0,
    lastReadSnapshot: null,
    newestIssuedSnapshot: null,
    newestIssuedSeq: -1,
    committedSeq: -1,
    outOfOrderCommits: 0,
    staleOverwrites: 0,
    focusChanges: 0,
  };
}

/**
 * Mirrors DrillLibraryScreen.loadFocus: capture the active owner, await the
 * local read, commit computeLibraryFocus(facts). `guard` optionally adds the
 * request-id check the same screen already applies to its catalog loader.
 */
function issueLoad(
  world: World,
  sched: SeededScheduler,
  order: ReadOrder,
  guard: Guard,
): void {
  const screen = world.screen;
  if (!screen) return;
  const owner = world.activeOwner;
  if (owner !== screen.owner) world.crossOwnerReads += 1;
  const seq = world.seq++;
  const requestId = ++screen.requestId;
  const read =
    order === 'fifo'
      ? (world.fifoTail = world.fifoTail.then(() => sched.step()))
      : sched.step();
  const load = (async () => {
    await read;
    const facts = clone(world.owners[owner] ?? []);
    screen.lastReadSnapshot = facts;
    if (seq > screen.newestIssuedSeq) {
      screen.newestIssuedSeq = seq;
      screen.newestIssuedSnapshot = facts;
    }
    if (order === 'reorder') await sched.step();
    if (!screen.mounted) {
      screen.lateCommits += 1;
      return;
    }
    if (guard === 'requestId' && requestId !== screen.requestId) return;
    const next = computeLibraryFocus(facts);
    if (screen.commits > 0 && !sameFocus(screen.focus, next)) {
      screen.focusChanges += 1;
    }
    if (seq < screen.committedSeq) {
      screen.outOfOrderCommits += 1;
      if (!sameFocus(screen.focus, next)) screen.staleOverwrites += 1;
    }
    screen.focus = next;
    screen.commits += 1;
    screen.committedSeq = Math.max(screen.committedSeq, seq);
  })();
  world.loads.push(load);
}

type Op =
  | 'refresh'
  | 'refresh-burst'
  | 'write'
  | 'mutate-row'
  | 'logout'
  | 'login'
  | 'unmount'
  | 'remount';

const OPS: readonly Op[] = [
  'refresh',
  'refresh',
  'refresh-burst',
  'write',
  'write',
  'mutate-row',
  'logout',
  'login',
  'unmount',
  'remount',
];

async function runLoaderModel(
  seed: number,
  order: ReadOrder,
  guard: Guard,
): Promise<SeedRow> {
  const rng = mulberry32(seed);
  const sched = new SeededScheduler(rng);
  const clock = new SkewedClock(rng, 0.1);
  factCounter = 0;
  const world: World = {
    owners: {
      A: Array.from({ length: int(rng, 0, 12) }, () =>
        randomFact(rng, clock, 0.1, true),
      ),
      B: Array.from({ length: int(rng, 0, 12) }, () =>
        randomFact(rng, clock, 0.1, true),
      ),
    },
    activeOwner: 'A',
    screen: newScreen('A'),
    loads: [],
    seq: 0,
    fifoTail: Promise.resolve(),
    crossOwnerReads: 0,
  };
  const program: Op[] = Array.from({ length: int(rng, 2, 14) }, () =>
    pick(rng, OPS),
  );
  const startedAt = Date.now();
  const problems: string[] = [];
  const instances: ScreenInstance[] = [world.screen!];

  // Mount → initial load.
  issueLoad(world, sched, order, guard);

  const driver = (async () => {
    for (const op of program) {
      for (let hop = int(rng, 0, 2); hop > 0; hop -= 1) await sched.step();
      switch (op) {
        case 'refresh':
          issueLoad(world, sched, order, guard);
          break;
        case 'refresh-burst': {
          const burst = int(rng, 2, 8);
          for (let k = 0; k < burst; k += 1)
            issueLoad(world, sched, order, guard);
          break;
        }
        case 'write':
          world.owners[world.activeOwner]!.push(
            randomFact(rng, clock, 0.1, true),
          );
          break;
        case 'mutate-row': {
          const rowsForOwner = world.owners[world.activeOwner]!;
          if (rowsForOwner.length > 0) {
            const row = pick(rng, rowsForOwner);
            const checkpoint = pick(rng, row.checkpoints);
            if (checkpoint) checkpoint.score = Math.round(rng() * 100);
          }
          break;
        }
        case 'logout':
          if (world.screen) world.screen.mounted = false;
          world.screen = null;
          world.activeOwner = world.activeOwner === 'A' ? 'B' : 'A';
          break;
        case 'login':
          if (!world.screen) {
            world.screen = newScreen(world.activeOwner);
            instances.push(world.screen);
            issueLoad(world, sched, order, guard);
          }
          break;
        case 'unmount':
          if (world.screen) world.screen.mounted = false;
          world.screen = null;
          break;
        case 'remount':
          if (!world.screen) {
            world.screen = newScreen(world.activeOwner);
            instances.push(world.screen);
            issueLoad(world, sched, order, guard);
          }
          break;
      }
    }
  })();

  const { steps, exhausted } = await sched.drive(MAX_STEPS);
  await driver;
  await Promise.all(world.loads);
  const wallMs = Date.now() - startedAt;

  if (exhausted) problems.push('scheduler exhausted: possible deadlock');
  if (wallMs > MAX_ITERATION_MS) problems.push(`wall ${wallMs}ms`);

  let staleFinal = 0;
  let lateCommits = 0;
  let outOfOrderCommits = 0;
  let staleOverwrites = 0;
  let focusChanges = 0;
  let fresherReadDiscarded = 0;
  for (const instance of instances) {
    lateCommits += instance.lateCommits;
    outOfOrderCommits += instance.outOfOrderCommits;
    staleOverwrites += instance.staleOverwrites;
    focusChanges += instance.focusChanges;
    const malformed = assertWellFormed(instance.focus);
    if (malformed) problems.push(malformed);
    if (!instance.mounted || !instance.lastReadSnapshot) continue;
    // The invariant a screen owes its user: what it displays is derived from
    // the rows its most recent read returned — no older read may win.
    //  - fifo: reads complete in issue order, so "last read" = "newest issued".
    //  - requestId: only the newest issued request may commit, whatever order
    //    the reads complete in.
    //  - reorder/unguarded: nothing enforces it; the miss rate is MEASURED.
    const expected = computeLibraryFocus(
      guard === 'requestId'
        ? instance.newestIssuedSnapshot!
        : instance.lastReadSnapshot,
    );
    if (
      guard === 'requestId' &&
      !sameFocus(expected, computeLibraryFocus(instance.lastReadSnapshot))
    ) {
      // The guard keeps the newest REQUEST, which is not always the newest
      // ROWS when reads complete out of order. Measured, not asserted.
      fresherReadDiscarded += 1;
    }
    if (!sameFocus(instance.focus, expected)) {
      staleFinal += 1;
      if (order === 'fifo' || guard === 'requestId') {
        problems.push(
          `lost update: committed seq ${instance.committedSeq} does not reflect the ${
            guard === 'requestId' ? 'newest request' : 'last read'
          } (seq ${instance.newestIssuedSeq})`,
        );
      }
    }
  }
  // Every load reads the owner active when it was issued and sign-out
  // unmounts before the owner rotates, so no mounted screen may ever have
  // read another owner's rows.
  if (world.crossOwnerReads > 0) {
    problems.push(`${world.crossOwnerReads} cross-owner reads`);
  }

  return {
    seed,
    scenario: `loader-${order}-${guard}`,
    outcome: problems.length === 0 ? 'HELD' : 'BROKEN',
    steps,
    wallMs,
    detail: problems.join('; '),
    metrics: {
      programLength: program.length,
      loads: world.loads.length,
      instances: instances.length,
      staleFinal,
      lateCommits,
      outOfOrderCommits,
      staleOverwrites,
      focusChanges,
      fresherReadDiscarded,
      crossOwnerReads: world.crossOwnerReads,
    },
  };
}

describe('screen loader pattern (read → computeLibraryFocus → commit)', () => {
  it('FIFO reads, unguarded (the DrillLibraryScreen.loadFocus shape): no lost update, no cross-owner focus, no deadlock', async () => {
    for (const seed of seedsFor(4)) {
      const row = await runLoaderModel(seed, 'fifo', 'unguarded');
      record(row);
      expect({ seed, detail: row.detail, outcome: row.outcome }).toEqual({
        seed,
        detail: '',
        outcome: 'HELD',
      });
    }
  });

  it('out-of-order reads with a request-id guard (the catalog loader shape): no lost update', async () => {
    for (const seed of seedsFor(5)) {
      const row = await runLoaderModel(seed, 'reorder', 'requestId');
      record(row);
      expect({ seed, detail: row.detail, outcome: row.outcome }).toEqual({
        seed,
        detail: '',
        outcome: 'HELD',
      });
    }
  });

  it('out-of-order reads, unguarded: measures how often a slower older read overwrites a newer one (informational, table only)', async () => {
    let stale = 0;
    let hardProblems = 0;
    for (const seed of seedsFor(6)) {
      const row = await runLoaderModel(seed, 'reorder', 'unguarded');
      // Lost updates are the measured quantity here, not a failure of the
      // engine; anything else (deadlock, malformed focus, cross-owner) is.
      const residual = row.detail
        .split('; ')
        .filter(d => d && !d.startsWith('lost update'));
      const outcome: SeedRow['outcome'] =
        residual.length === 0 ? 'HELD' : 'BROKEN';
      stale += row.metrics.staleFinal ?? 0;
      if (outcome === 'BROKEN') hardProblems += 1;
      record({ ...row, outcome, detail: residual.join('; ') });
      expect({ seed, residual }).toEqual({ seed, residual: [] });
    }
    expect(hardProblems).toBe(0);
    // `stale` is reported in the seed table under
    // byScenario['loader-reorder-unguarded'].metrics.staleFinal.
    expect(Number.isInteger(stale)).toBe(true);
  });
});

// ─── Scenario 7: recommendDrills bursts over a mutating catalog ────────────

describe('recommendDrills — concurrent bursts over a shared catalog', () => {
  it('concurrent callers each get a family-honest, deduplicated, bounded list', async () => {
    const families = [
      'dink',
      'volley',
      'drive',
      'serve',
      'drop_reset',
      'global',
    ];
    for (const seed of seedsFor(7)) {
      const rng = mulberry32(seed);
      const sched = new SeededScheduler(rng);
      const catalog = Array.from({ length: int(rng, 0, 60) }, (_, i) => ({
        slug: `drill-${i}`,
        families: Array.from({ length: int(rng, 0, 2) }, () =>
          pick(rng, families),
        ),
      }));
      const focus: LibraryFocus = {
        shotType: 'dink',
        checkpoint: 'contact_position',
        averageScore: 50,
        sampleCount: 2,
        family: pick(rng, families),
      };
      const callers = int(rng, 2, 16);
      const problems: string[] = [];
      const startedAt = Date.now();
      const writer = (async () => {
        for (let w = int(rng, 0, 10); w > 0; w -= 1) {
          await sched.step();
          if (rng() < 0.5) {
            catalog.push({
              slug: `drill-w${w}`,
              families: [pick(rng, families)],
            });
          } else if (catalog.length > 0) {
            catalog.splice(int(rng, 0, catalog.length - 1), 1);
          }
        }
      })();
      const burst = Promise.all(
        Array.from({ length: callers }, async () => {
          await sched.step();
          const limit = pick(rng, [0, 1, 3, 5, 50]);
          const snapshot = clone(catalog);
          const result = recommendDrills(catalog, focus, limit);
          if (result.length > limit) problems.push('over limit');
          if (new Set(result.map(d => d.slug)).size !== result.length) {
            problems.push('duplicate slug');
          }
          for (const drill of result) {
            const primary = drill.families.includes(focus.family);
            const fill =
              focus.family !== 'global' && drill.families.includes('global');
            if (!primary && !fill) problems.push('unrelated family');
          }
          if (
            JSON.stringify(recommendDrills(snapshot, focus, limit)) !==
            JSON.stringify(result)
          ) {
            problems.push('torn read');
          }
        }),
      );
      const { steps, exhausted } = await sched.drive(MAX_STEPS);
      await Promise.all([writer, burst]);
      const wallMs = Date.now() - startedAt;
      if (exhausted) problems.push('scheduler exhausted: possible deadlock');
      record({
        seed,
        scenario: 'recommend-burst',
        outcome: problems.length === 0 ? 'HELD' : 'BROKEN',
        steps,
        wallMs,
        detail: problems.join('; '),
        metrics: { callers, catalog: catalog.length },
      });
      expect({ seed, problems }).toEqual({ seed, problems: [] });
    }
  });
});
