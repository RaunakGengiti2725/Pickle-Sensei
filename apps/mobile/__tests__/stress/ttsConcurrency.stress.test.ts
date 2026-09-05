/**
 * mod-tts × CONCURRENCY stress harness — `src/audio/tts.ts`.
 *
 * The unit is the JS bridge to the native AVSpeechSynthesizer module
 * (`NativeModules.PickleAudioCoach`). It is synchronous and stateless, so the
 * concurrency surface is the CALLER side: several actors (live coach, form
 * review, mute toggle, screen exit) share the one synthesizer and fire cues
 * from interleaved async contexts. Every iteration is a seeded schedule run
 * under `Promise.all`, replayable from its seed.
 *
 * Invariants (any violation = BROKEN row, recorded with the seed):
 *  I1 completeness  — with a full engine every issued speak/stop reaches the
 *                     native module exactly once (no lost, no duplicated call).
 *  I2 order         — the native module observes calls in issue order (the
 *                     wrapper adds no reordering/deferral).
 *  I3 fidelity      — text arrives byte-identical (whitespace, unicode, long
 *                     strings) and the legacy rate is always 0.5.
 *  I4 latest-wins   — replaying the native log through a synthesizer model
 *                     ends in the same state as replaying the issue log.
 *  I5 availability  — `available()` is stable within an iteration and true
 *                     iff the engine exposes a callable `speak`.
 *  I6 no throw      — with a full OR missing engine no call throws.
 *  I7 bounded time  — every iteration finishes inside the wall-time budget
 *                     (no deadlock / unresolved Promise.all).
 *  I8 no growth     — heap does not trend upward across the campaign.
 *
 * Partial / throwing engine shapes (`speakOnly`, `stopOnly`, `throwingSpeak`,
 * `throwingStop`) are CHARACTERIZED: the harness records whether the wrapper
 * propagates the native-layer throw, checks I5/I7 only, and never pins the
 * observed behaviour as correct. See the stress report for the classification.
 *
 * Knobs:
 *   STRESS_ITER=<n>        iterations (default 200 — well under 1 s in the suite)
 *   STRESS_SEED=<seed>     replay exactly one seed
 *   STRESS_SEED_BASE=<n>   first seed of the campaign (default 20260905)
 *   STRESS_REPEAT=<n>      run every seed n times (flakiness check, default 1)
 *   STRESS_OUT=<dir>       JSON table destination
 *                          (default <repo>/artifacts/stress/mod-tts-concurrency)
 */
import type { CoachVoicePort } from '../../src/flow/liveSessionCoach';

/** Node globals the RN tsconfig does not declare (same pattern as
 * xcMatrixNetworkAuth2.keeper.test.ts). */
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  version: string;
  memoryUsage: () => { heapUsed: number; rss: number };
};
declare function setImmediate(callback: () => void): unknown;
const fs = require('fs') as {
  mkdirSync: (p: string, options: { recursive: true }) => void;
  writeFileSync: (p: string, data: string) => void;
};
const path = require('path') as {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
};

// ─── Seeded PRNG ─────────────────────────────────────────────────────────────

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

function int(rng: () => number, min: number, maxInclusive: number): number {
  return min + Math.floor(rng() * (maxInclusive - min + 1));
}

// ─── Engine shapes ───────────────────────────────────────────────────────────

type EngineShape =
  | 'full'
  | 'missing'
  | 'speakOnly'
  | 'stopOnly'
  | 'throwingSpeak'
  | 'throwingStop';

/** Weighted: the concurrency lens lives on the full engine, the documented
 * "module missing" path comes next, partial/throwing shapes are probes. */
function pickShape(rng: () => number): EngineShape {
  const roll = rng();
  if (roll < 0.5) return 'full';
  if (roll < 0.65) return 'missing';
  if (roll < 0.74) return 'speakOnly';
  if (roll < 0.83) return 'stopOnly';
  if (roll < 0.92) return 'throwingSpeak';
  return 'throwingStop';
}

/** Shapes whose contract is documented in tts.ts (asserted end to end). */
const CONTRACT_SHAPES: ReadonlySet<EngineShape> = new Set(['full', 'missing']);

interface NativeCall {
  op: 'speak' | 'stop';
  text: string | null;
  rate: number | null;
  /** Global issue sequence observed at the moment native received the call. */
  seq: number;
}

interface FakeEngine {
  module: Record<string, unknown> | undefined;
  log: NativeCall[];
  speakCueCalls: number;
}

/** Global issue counter: stamped by the actor right before it calls tts.* and
 * read again by the fake native — equality proves the wrapper is synchronous
 * and in-order. */
let issueSeq = 0;

function buildEngine(shape: EngineShape): FakeEngine {
  const engine: FakeEngine = { module: undefined, log: [], speakCueCalls: 0 };
  if (shape === 'missing') return engine;
  const speak = (text: string, rate: number) => {
    if (shape === 'throwingSpeak') {
      throw new TypeError('native speak rejected the call');
    }
    engine.log.push({ op: 'speak', text, rate, seq: issueSeq });
  };
  const stop = () => {
    if (shape === 'throwingStop') {
      throw new TypeError('native stop rejected the call');
    }
    engine.log.push({ op: 'stop', text: null, rate: null, seq: issueSeq });
  };
  const module: Record<string, unknown> = {
    speakCue: () => {
      engine.speakCueCalls += 1;
    },
    listVoices: () => Promise.resolve([]),
  };
  if (shape !== 'stopOnly') module.speak = speak;
  if (shape !== 'speakOnly') module.stop = stop;
  engine.module = module;
  return engine;
}

type Tts = typeof import('../../src/audio/tts').tts;

/** Fresh import of the wrapper against the given engine (tts.ts captures the
 * native module once at import time, like the app does at bundle load). */
function loadTts(engine: FakeEngine): Tts {
  let loaded: Tts | null = null;
  jest.isolateModules(() => {
    jest.doMock('react-native', () => ({
      NativeModules: { PickleAudioCoach: engine.module },
    }));
    loaded = (require('../../src/audio/tts') as { tts: Tts }).tts;
  });
  jest.dontMock('react-native');
  if (!loaded) throw new Error('tts module did not load');
  return loaded;
}

// ─── Synthesizer model (latest-wins, stop silences) ──────────────────────────

interface SynthState {
  current: string | null;
  speakCount: number;
  stopCount: number;
}

function replay(
  calls: ReadonlyArray<{ op: 'speak' | 'stop'; text: string | null }>,
): SynthState {
  const state: SynthState = { current: null, speakCount: 0, stopCount: 0 };
  for (const call of calls) {
    if (call.op === 'speak') {
      state.current = call.text;
      state.speakCount += 1;
    } else {
      state.current = null;
      state.stopCount += 1;
    }
  }
  return state;
}

// ─── Scenario generation ─────────────────────────────────────────────────────

const ACTORS = ['liveCoach', 'formReview', 'muteToggle', 'screenExit'] as const;
type Actor = (typeof ACTORS)[number];

type Yield =
  | { kind: 'sync' }
  | { kind: 'micro'; depth: number }
  | { kind: 'immediate'; depth: number };

interface Op {
  actor: Actor;
  kind: 'speak' | 'stop' | 'available';
  text: string;
  before: Yield;
}

const CUE_TEXTS = [
  'Paddle up',
  'Bend your knees',
  'Contact out front',
  'Nice — keep that follow-through',
  'Reset to ready',
  '',
  '   ',
  '\n\tPaddle up\n',
  'Élan — sürpriz — 準備',
  '👍 Great dink',
  'Paddle up. '.repeat(400),
  'x'.repeat(10_000),
] as const;

interface Scenario {
  seed: number;
  shape: EngineShape;
  actors: Actor[];
  ops: Op[];
}

function buildScenario(seed: number): Scenario {
  const rng = mulberry32(seed);
  const shape = pickShape(rng);
  const actorCount = int(rng, 1, ACTORS.length);
  const actors = [...ACTORS].slice(0, actorCount);
  const ops: Op[] = [];
  for (const actor of actors) {
    const count = int(rng, 1, 32);
    for (let i = 0; i < count; i += 1) {
      const roll = rng();
      const kind: Op['kind'] =
        actor === 'muteToggle' || actor === 'screenExit'
          ? roll < 0.7
            ? 'stop'
            : roll < 0.85
              ? 'speak'
              : 'available'
          : roll < 0.75
            ? 'speak'
            : roll < 0.9
              ? 'stop'
              : 'available';
      const yieldRoll = rng();
      const before: Yield =
        yieldRoll < 0.4
          ? { kind: 'sync' }
          : yieldRoll < 0.8
            ? { kind: 'micro', depth: int(rng, 1, 6) }
            : { kind: 'immediate', depth: int(rng, 1, 3) };
      ops.push({ actor, kind, text: pick(rng, CUE_TEXTS), before });
    }
  }
  return { seed, shape, actors, ops };
}

async function pause(y: Yield): Promise<void> {
  if (y.kind === 'sync') return;
  for (let i = 0; i < y.depth; i += 1) {
    if (y.kind === 'micro') {
      await Promise.resolve();
    } else {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
}

// ─── Scenario execution ──────────────────────────────────────────────────────

interface IssuedCall {
  op: 'speak' | 'stop';
  text: string | null;
  seq: number;
  actor: Actor;
}

interface Throw {
  actor: Actor;
  op: Op['kind'];
  seq: number;
  error: string;
}

type Outcome = 'HELD' | 'BROKEN' | 'CHARACTERIZED';

interface SeedRow {
  seed: number;
  shape: EngineShape;
  contractShape: boolean;
  actors: number;
  opsScheduled: number;
  callsIssued: number;
  availableCalls: number;
  nativeSpeaks: number;
  nativeStops: number;
  speakCueCalls: number;
  availableValue: boolean | null;
  availableStable: boolean;
  throws: Throw[];
  orderViolations: number;
  fidelityViolations: number;
  expectedFinal: string | null;
  observedFinal: string | null;
  durationMs: number;
  timedOut: boolean;
  violations: string[];
  outcome: Outcome;
}

const ITERATION_BUDGET_MS = 2_000;

async function runScenario(scenario: Scenario): Promise<SeedRow> {
  const engine = buildEngine(scenario.shape);
  const tts = loadTts(engine);
  const port: CoachVoicePort = tts;
  const issued: IssuedCall[] = [];
  const throws: Throw[] = [];
  const availableSeen = new Set<boolean>();
  let availableCalls = 0;
  const start = Date.now();

  const actorRuns = scenario.actors.map(async actor => {
    for (const op of scenario.ops) {
      if (op.actor !== actor) continue;
      await pause(op.before);
      issueSeq += 1;
      const seq = issueSeq;
      try {
        if (op.kind === 'available') {
          availableCalls += 1;
          availableSeen.add(port.available());
        } else if (op.kind === 'speak') {
          issued.push({ op: 'speak', text: op.text, seq, actor });
          port.speak(op.text, { category: 'CORRECTION' });
        } else {
          issued.push({ op: 'stop', text: null, seq, actor });
          port.stop();
        }
      } catch (error) {
        throws.push({ actor, op: op.kind, seq, error: String(error) });
      }
    }
  });

  let timedOut = false;
  let timer: unknown = null;
  await Promise.race([
    Promise.all(actorRuns),
    new Promise<void>(resolve => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, ITERATION_BUDGET_MS);
    }),
  ]);
  if (timer !== null) clearTimeout(timer as ReturnType<typeof setTimeout>);
  const durationMs = Date.now() - start;

  const contractShape = CONTRACT_SHAPES.has(scenario.shape);
  const nativeSpeaks = engine.log.filter(c => c.op === 'speak').length;
  const nativeStops = engine.log.filter(c => c.op === 'stop').length;
  const issuedSpeaks = issued.filter(c => c.op === 'speak');
  const issuedStops = issued.filter(c => c.op === 'stop');

  let orderViolations = 0;
  let fidelityViolations = 0;
  for (let i = 1; i < engine.log.length; i += 1) {
    const prev = engine.log[i - 1];
    const cur = engine.log[i];
    if (prev && cur && cur.seq <= prev.seq) orderViolations += 1;
  }
  const issuedBySeq = new Map(issued.map(c => [c.seq, c]));
  for (const call of engine.log) {
    const source = issuedBySeq.get(call.seq);
    if (!source || source.op !== call.op) {
      orderViolations += 1;
      continue;
    }
    if (
      call.op === 'speak' &&
      (call.text !== source.text || call.rate !== 0.5)
    ) {
      fidelityViolations += 1;
    }
  }

  const expectedFinal =
    scenario.shape === 'missing' ? null : replay(issued).current;
  const observedFinal = replay(engine.log).current;
  const availableValue =
    availableSeen.size === 1 ? ([...availableSeen][0] ?? null) : null;
  const availableStable = availableSeen.size <= 1;
  const speakIsCallable =
    typeof engine.module?.speak === 'function' ? true : false;

  const violations: string[] = [];
  if (timedOut) violations.push('I7 iteration exceeded wall-time budget');
  if (!availableStable)
    violations.push('I5 available() flipped within iteration');
  if (availableSeen.size === 1 && availableValue !== speakIsCallable) {
    violations.push('I5 available() disagrees with engine.speak callability');
  }
  if (contractShape) {
    if (throws.length > 0)
      violations.push('I6 wrapper threw on a contract shape');
    if (scenario.shape === 'full') {
      if (nativeSpeaks !== issuedSpeaks.length) {
        violations.push(
          `I1 speak count native=${nativeSpeaks} issued=${issuedSpeaks.length}`,
        );
      }
      if (nativeStops !== issuedStops.length) {
        violations.push(
          `I1 stop count native=${nativeStops} issued=${issuedStops.length}`,
        );
      }
      if (orderViolations > 0)
        violations.push(`I2 ${orderViolations} order violations`);
      if (fidelityViolations > 0) {
        violations.push(`I3 ${fidelityViolations} fidelity violations`);
      }
      if (expectedFinal !== observedFinal)
        violations.push('I4 final synth state diverged');
    } else if (engine.log.length !== 0) {
      violations.push('I1 missing engine received calls');
    }
  }

  let outcome: Outcome;
  if (violations.length > 0) outcome = 'BROKEN';
  else if (contractShape) outcome = 'HELD';
  else outcome = 'CHARACTERIZED';

  return {
    seed: scenario.seed,
    shape: scenario.shape,
    contractShape,
    actors: scenario.actors.length,
    opsScheduled: scenario.ops.length,
    callsIssued: issued.length,
    availableCalls,
    nativeSpeaks,
    nativeStops,
    speakCueCalls: engine.speakCueCalls,
    availableValue,
    availableStable,
    throws,
    orderViolations,
    fidelityViolations,
    expectedFinal:
      expectedFinal === null
        ? null
        : `${expectedFinal.length}:${expectedFinal.slice(0, 24)}`,
    observedFinal:
      observedFinal === null
        ? null
        : `${observedFinal.length}:${observedFinal.slice(0, 24)}`,
    durationMs,
    timedOut,
    violations,
    outcome,
  };
}

// ─── Campaign ────────────────────────────────────────────────────────────────

const ITERATIONS = Number(process.env.STRESS_ITER ?? 200);
const SEED_BASE = Number(process.env.STRESS_SEED_BASE ?? 20260905);
const ONLY_SEED = process.env.STRESS_SEED
  ? Number(process.env.STRESS_SEED)
  : null;
const REPEAT = Number(process.env.STRESS_REPEAT ?? 1);
const OUT_DIR =
  process.env.STRESS_OUT ??
  path.resolve(__dirname, '../../../../artifacts/stress/mod-tts-concurrency');

const REAL_NOW: () => number = Date.now.bind(Date);

describe('mod-tts × concurrency: seeded Promise.all bursts against src/audio/tts.ts', () => {
  afterEach(() => {
    jest.dontMock('react-native');
  });

  it('holds I1–I8 on every contract-shape seed and characterizes partial engines', async () => {
    const seeds =
      ONLY_SEED !== null
        ? [ONLY_SEED]
        : Array.from({ length: ITERATIONS }, (_, i) => SEED_BASE + i);

    const rows: SeedRow[] = [];
    const heapSamples: Array<{
      afterRows: number;
      heapUsed: number;
      rss: number;
    }> = [];
    const wallStart = REAL_NOW();
    for (const seed of seeds) {
      for (let r = 0; r < REPEAT; r += 1) {
        rows.push(await runScenario(buildScenario(seed)));
        if (rows.length % 100 === 0) {
          const m = process.memoryUsage();
          heapSamples.push({
            afterRows: rows.length,
            heapUsed: m.heapUsed,
            rss: m.rss,
          });
        }
      }
    }
    const wallMs = REAL_NOW() - wallStart;

    const byOutcome = { HELD: 0, BROKEN: 0, CHARACTERIZED: 0 };
    const byShape: Record<EngineShape, number> = {
      full: 0,
      missing: 0,
      speakOnly: 0,
      stopOnly: 0,
      throwingSpeak: 0,
      throwingStop: 0,
    };
    let callsIssued = 0;
    for (const row of rows) {
      byOutcome[row.outcome] += 1;
      byShape[row.shape] += 1;
      callsIssued += row.callsIssued + row.availableCalls;
    }
    const throwingRows = rows.filter(row => row.throws.length > 0);
    const brokenSeeds = rows
      .filter(row => row.outcome === 'BROKEN')
      .map(row => row.seed);

    // I8: heap must not trend upward across the campaign (first vs last sample).
    const firstHeap = heapSamples[0]?.heapUsed ?? null;
    const lastHeap = heapSamples[heapSamples.length - 1]?.heapUsed ?? null;
    const heapGrowthRatio =
      firstHeap !== null && lastHeap !== null && firstHeap > 0
        ? lastHeap / firstHeap
        : null;

    const summary = {
      unit: 'mod-tts',
      lens: 'concurrency',
      target: 'apps/mobile/src/audio/tts.ts',
      node: process.version,
      seedBase: SEED_BASE,
      onlySeed: ONLY_SEED,
      repeat: REPEAT,
      iterations: rows.length,
      callsIssued,
      wallMs,
      iterationBudgetMs: ITERATION_BUDGET_MS,
      byOutcome,
      byShape,
      brokenSeeds,
      throwingSeeds: throwingRows.map(row => ({
        seed: row.seed,
        shape: row.shape,
        throws: row.throws.length,
        first: row.throws[0]?.error ?? null,
      })),
      heapSamples,
      heapGrowthRatio,
      rows,
    };
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const file = path.join(
      OUT_DIR,
      ONLY_SEED !== null
        ? `seed-${ONLY_SEED}-x${REPEAT}.json`
        : `campaign-${rows.length}.json`,
    );
    fs.writeFileSync(file, JSON.stringify(summary, null, 2));

    expect(rows.length).toBe(seeds.length * REPEAT);
    expect(brokenSeeds).toEqual([]);
    expect(rows.filter(row => row.timedOut)).toEqual([]);
    // A partial/throwing engine may propagate a throw (characterized, see the
    // stress report); a full or missing engine never may.
    expect(throwingRows.filter(row => row.contractShape)).toEqual([]);
    if (heapGrowthRatio !== null) expect(heapGrowthRatio).toBeLessThan(3);
  });

  it('survives a 2,000-cue rapid burst with a full engine in issue order (single actor)', () => {
    const engine = buildEngine('full');
    const tts = loadTts(engine);
    const start = REAL_NOW();
    for (let i = 0; i < 2_000; i += 1) {
      issueSeq += 1;
      if (i % 50 === 25) tts.stop();
      else tts.speak(`cue ${i}`);
    }
    const elapsed = REAL_NOW() - start;
    expect(engine.log).toHaveLength(2_000);
    expect(engine.log.filter(c => c.op === 'stop')).toHaveLength(40);
    expect(
      engine.log.every(
        (c, i, all) => i === 0 || c.seq > (all[i - 1]?.seq ?? -1),
      ),
    ).toBe(true);
    expect(replay(engine.log).current).toBe('cue 1999');
    expect(elapsed).toBeLessThan(ITERATION_BUDGET_MS);
  });

  it('never throws and reports unavailable when the native module is absent (rapid burst)', async () => {
    const engine = buildEngine('missing');
    const tts = loadTts(engine);
    expect(tts.available()).toBe(false);
    const results = await Promise.all(
      Array.from({ length: 500 }, (_, i) =>
        Promise.resolve().then(() => {
          if (i % 3 === 0) tts.stop();
          else tts.speak(`cue ${i}`);
          return tts.available();
        }),
      ),
    );
    expect(results.every(v => v === false)).toBe(true);
    expect(engine.log).toEqual([]);
  });

  it('resolves availability once at import (late registration / removal is not observed)', () => {
    const late = buildEngine('missing');
    const ttsLate = loadTts(late);
    late.module = buildEngine('full').module;
    expect(ttsLate.available()).toBe(false);
    ttsLate.speak('after registration');
    expect(late.log).toEqual([]);

    const removed = buildEngine('full');
    const ttsRemoved = loadTts(removed);
    const captured = removed.module;
    removed.module = undefined;
    expect(ttsRemoved.available()).toBe(true);
    ttsRemoved.speak('after removal');
    expect(removed.log.map(c => c.text)).toEqual(['after removal']);
    expect(captured).not.toBeUndefined();
  });

  it('as a CoachVoicePort it forwards text + rate 0.5 through the legacy speak path only', () => {
    const engine = buildEngine('full');
    const port: CoachVoicePort = loadTts(engine);
    issueSeq += 1;
    port.speak('Paddle up', { category: 'CORRECTION' });
    issueSeq += 1;
    port.speak('Great session', { category: 'SESSION_END' });
    expect(engine.log.map(c => [c.op, c.text, c.rate])).toEqual([
      ['speak', 'Paddle up', 0.5],
      ['speak', 'Great session', 0.5],
    ]);
  });
});
