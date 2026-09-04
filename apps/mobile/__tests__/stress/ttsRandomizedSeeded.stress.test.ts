/**
 * STRESS / mod-tts / lens `randomized-seeded` — `src/audio/tts.ts`.
 *
 * Seeded, replayable random walks over the bridge's public API
 * (`available()`, `speak(text)`, `stop()`) against a recording fake of the
 * native `PickleAudioCoach` module, in four engine modes:
 *
 *  - `full`    — native module exports `speak` and `stop` (the shipping iOS
 *                shape, see ios/LocalPods/PickleNative/Sources/PickleAudioCoachBridge.m);
 *  - `missing` — no native module at all (the documented "unavailable
 *                engine" case in tts.ts: cues are shown, not spoken);
 *  - `noSpeak` / `noStop` — NEAR-LEGAL partial module shapes (one method
 *                absent). Not producible by the iOS bridge, exercised to
 *                probe the "explicit availability, never a silent fake"
 *                contract from the module's doc comment.
 *
 * Invariants model-checked after EVERY step (derived from the tts.ts doc
 * comment and the Swift module's comments — the Swift side itself is only
 * MODELLED here, never executed; Apple behaviour is Mac-runner truth):
 *  I1 `available()` is constant for a module instance and equals
 *     "the native module exports a `speak` function".
 *  I2 The native call trace equals the projected JS trace 1:1 in order —
 *     no dropped, duplicated, reordered or coalesced cues, including
 *     rapid bursts and speak/stop interleavings.
 *  I3 Every forwarded `speak` carries the fixed rate 0.5.
 *  I4 A native throw propagates unchanged (same Error object) and a JS call
 *     never throws when the native side did not.
 *  I5 A JS-side model of AVSpeechSynthesizer under the Swift policy
 *     (`speak` = interrupt-immediately then speak, latest cue wins; `stop`
 *     silences; blank text is ignored) agrees with the replayed trace.
 *  I6 When `available()` is false, `speak()`/`stop()` are harmless no-ops
 *     (never throw, never reach the native side) — the caller was told.
 *  D  Determinism: the same seed replayed twice yields a byte-identical
 *     trace.
 *
 * Knobs (env): STRESS_ITER (sequences, default 300), STRESS_SEED_BASE
 * (default 20260904), STRESS_SEED (replay ONE seed verbosely),
 * STRESS_OUT (write the seed → outcome JSON table to this path).
 * Campaign: `STRESS_ITER=2500 STRESS_OUT=/tmp/tts-stress.json npx jest --ci
 * __tests__/stress/ttsRandomizedSeeded.stress.test.ts`.
 */
import { writeFileSync } from 'node:fs';
import {
  CORRECTION_PHRASES,
  NO_READ_VARIANTS,
  PRAISE_VARIANTS,
  REPEAT_PREFIX,
  sessionStartLine,
} from '@pickle/audio-coach-core';
import type { tts as TtsBridge } from '../../src/audio/tts';

type Tts = typeof TtsBridge;

// ───────────────────────────── seeded RNG ─────────────────────────────

/** mulberry32 — same generator family the repo's visibility matrix uses. */
class SeededRng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  intBetween(lo: number, hi: number): number {
    return lo + this.int(hi - lo + 1);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error('pick() on an empty list');
    return item;
  }
}

// ───────────────────────────── cue corpus ─────────────────────────────

const REAL_CUES: readonly string[] = [
  ...Object.values(CORRECTION_PHRASES).flatMap(byDirection =>
    Object.values(byDirection ?? {}),
  ),
  ...PRAISE_VARIANTS,
  ...NO_READ_VARIANTS,
  sessionStartLine(),
  `${REPEAT_PREFIX}paddle up in ready.`,
  'Paddle up',
  '7.5',
];

/** Adversarial text: blanks, control chars, unicode, length extremes. */
const EDGE_CUES: readonly string[] = [
  '',
  ' ',
  '   \n\t  ',
  '\r\n',
  '\u0000',
  'a',
  '🏓 Paddle up!',
  'Ünïcödé — “smart” quotes',
  'مرحبا',
  '日本語のキュー',
  '\u200b',
  'x'.repeat(5000),
  'Paddle up. '.repeat(200),
  '<script>alert(1)</script>',
  '%s %d %@',
];

// ───────────────────────────── native fake ─────────────────────────────

type NativeCall =
  { kind: 'speak'; text: string; rate: number } | { kind: 'stop' };

/**
 * Recording fake of the native module PLUS a JS model of the Swift
 * AVSpeechSynthesizer policy (INFERRED from PickleAudioCoach.swift; not
 * Apple truth): `speak` interrupts immediately and the latest cue wins,
 * `stop` silences, blank text is dropped before reaching the synthesizer.
 */
class FakeNativeEngine {
  calls: NativeCall[] = [];
  speaking: string | null = null;
  faultNext: 'speak' | 'stop' | null = null;
  lastThrown: Error | null = null;

  reset(): void {
    this.calls = [];
    this.speaking = null;
    this.faultNext = null;
    this.lastThrown = null;
  }

  speak(text: string, rate: number): void {
    this.calls.push({ kind: 'speak', text, rate });
    if (this.faultNext === 'speak') {
      this.faultNext = null;
      this.lastThrown = new Error(`native speak fault #${this.calls.length}`);
      throw this.lastThrown;
    }
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    this.speaking = trimmed;
  }

  stop(): void {
    this.calls.push({ kind: 'stop' });
    if (this.faultNext === 'stop') {
      this.faultNext = null;
      this.lastThrown = new Error(`native stop fault #${this.calls.length}`);
      throw this.lastThrown;
    }
    this.speaking = null;
  }
}

const engine = new FakeNativeEngine();

type EngineMode = 'full' | 'missing' | 'noSpeak' | 'noStop';
const LEGAL_MODES: readonly EngineMode[] = ['full', 'missing'];
const NEAR_LEGAL_MODES: readonly EngineMode[] = ['noSpeak', 'noStop'];

const hasSpeak = (mode: EngineMode): boolean =>
  mode === 'full' || mode === 'noStop';
const hasStop = (mode: EngineMode): boolean =>
  mode === 'full' || mode === 'noSpeak';

/**
 * `tts.ts` captures `NativeModules.PickleAudioCoach` at import time, so each
 * engine mode gets its own isolated module instance whose native object
 * delegates to the shared, resettable fake.
 */
const ttsByMode = new Map<EngineMode, Tts>();
function loadTts(mode: EngineMode): Tts {
  const cached = ttsByMode.get(mode);
  if (cached) return cached;
  let loaded: Tts | undefined;
  jest.isolateModules(() => {
    const rn = jest.requireActual<{
      NativeModules: Record<string, unknown>;
    }>('react-native');
    const nativeModule: Record<string, unknown> = {};
    if (hasSpeak(mode)) {
      nativeModule.speak = (text: string, rate: number) =>
        engine.speak(text, rate);
    }
    if (hasStop(mode)) {
      nativeModule.stop = () => engine.stop();
    }
    rn.NativeModules.PickleAudioCoach =
      mode === 'missing' ? undefined : nativeModule;
    loaded = jest.requireActual<typeof import('../../src/audio/tts')>(
      '../../src/audio/tts',
    ).tts;
  });
  if (!loaded) throw new Error('tts module failed to load');
  ttsByMode.set(mode, loaded);
  return loaded;
}

// ───────────────────────────── actions ─────────────────────────────

type Action =
  | { op: 'speak'; text: string }
  | { op: 'stop' }
  | { op: 'available' }
  | { op: 'burst'; texts: string[] }
  | { op: 'interleave'; texts: string[] }
  | { op: 'faultNext'; target: 'speak' | 'stop' };

function randomText(rng: SeededRng): string {
  return rng.chance(0.2) ? rng.pick(EDGE_CUES) : rng.pick(REAL_CUES);
}

function genAction(rng: SeededRng): Action {
  const roll = rng.next();
  if (roll < 0.45) return { op: 'speak', text: randomText(rng) };
  if (roll < 0.65) return { op: 'stop' };
  if (roll < 0.75) return { op: 'available' };
  if (roll < 0.85) {
    const n = rng.intBetween(2, 50);
    return {
      op: 'burst',
      texts: Array.from({ length: n }, () => randomText(rng)),
    };
  }
  if (roll < 0.93) {
    const n = rng.intBetween(2, 12);
    return {
      op: 'interleave',
      texts: Array.from({ length: n }, () => randomText(rng)),
    };
  }
  return { op: 'faultNext', target: rng.chance(0.5) ? 'speak' : 'stop' };
}

interface Scenario {
  seed: number;
  mode: EngineMode;
  actions: Action[];
}

function genScenario(seed: number, modes: readonly EngineMode[]): Scenario {
  const rng = new SeededRng(seed);
  const mode = rng.pick(modes);
  const length = rng.intBetween(5, 60);
  const actions = Array.from({ length }, () => genAction(rng));
  return { seed, mode, actions };
}

// ───────────────────────────── model checker ─────────────────────────────

interface Violation {
  step: number;
  action: Action;
  invariant: 'I1' | 'I2' | 'I3' | 'I4' | 'I5' | 'I6';
  observed: string;
  expected: string;
}

interface RunResult {
  violations: Violation[];
  trace: NativeCall[];
  steps: number;
  nativeCalls: number;
}

/** Expected-state model of the bridge contract. */
class BridgeSpec {
  expectedCalls: NativeCall[] = [];
  speaking: string | null = null;
  armedFault: 'speak' | 'stop' | null = null;

  constructor(readonly mode: EngineMode) {}

  /** Returns the error the JS call is expected to surface, if any. */
  speak(text: string): 'throws' | 'ok' {
    if (!hasSpeak(this.mode)) return 'ok';
    this.expectedCalls.push({ kind: 'speak', text, rate: 0.5 });
    if (this.armedFault === 'speak') {
      this.armedFault = null;
      return 'throws';
    }
    const trimmed = text.trim();
    if (trimmed.length > 0) this.speaking = trimmed;
    return 'ok';
  }

  stop(): 'throws' | 'ok' {
    if (!hasStop(this.mode)) return 'ok';
    this.expectedCalls.push({ kind: 'stop' });
    if (this.armedFault === 'stop') {
      this.armedFault = null;
      return 'throws';
    }
    this.speaking = null;
    return 'ok';
  }
}

function invokeOne(
  tts: Tts,
  spec: BridgeSpec,
  call: { kind: 'speak'; text: string } | { kind: 'stop' },
): CallOutcome {
  const forwarded =
    call.kind === 'speak' ? hasSpeak(spec.mode) : hasStop(spec.mode);
  const expectation =
    call.kind === 'speak' ? spec.speak(call.text) : spec.stop();
  let thrown: unknown;
  let didThrow = false;
  try {
    if (call.kind === 'speak') tts.speak(call.text);
    else tts.stop();
  } catch (error) {
    didThrow = true;
    thrown = error;
  }
  return { kind: call.kind, forwarded, expectation, thrown, didThrow };
}

interface CallOutcome {
  kind: 'speak' | 'stop';
  forwarded: boolean;
  expectation: 'throws' | 'ok';
  thrown: unknown;
  didThrow: boolean;
}

function checkAfterStep(
  step: number,
  action: Action,
  tts: Tts,
  spec: BridgeSpec,
  outcomes: readonly CallOutcome[],
  violations: Violation[],
): void {
  const push = (
    invariant: Violation['invariant'],
    observed: string,
    expected: string,
  ) => violations.push({ step, action, invariant, observed, expected });

  const available = tts.available();
  if (available !== hasSpeak(spec.mode)) {
    push(
      'I1',
      `available()=${available}`,
      `available()=${hasSpeak(spec.mode)}`,
    );
  }

  const traceJson = JSON.stringify(engine.calls);
  const expectedJson = JSON.stringify(spec.expectedCalls);
  if (traceJson !== expectedJson) {
    push(
      'I2',
      `native trace (${engine.calls.length} calls) ${traceJson.slice(0, 400)}`,
      `projected trace (${spec.expectedCalls.length} calls) ${expectedJson.slice(0, 400)}`,
    );
  }

  const badRate = engine.calls.find(c => c.kind === 'speak' && c.rate !== 0.5);
  if (badRate) push('I3', `speak rate ${JSON.stringify(badRate)}`, 'rate 0.5');

  outcomes.forEach((outcome, index) => {
    if (outcome.expectation === 'throws') {
      if (!outcome.didThrow) {
        push('I4', `call ${index}: native threw but JS swallowed`, 'propagate');
      } else if (outcome.thrown !== engine.lastThrown) {
        push(
          'I4',
          `call ${index}: JS threw ${String(outcome.thrown)}`,
          `the native Error object ${String(engine.lastThrown)}`,
        );
      }
    } else if (outcome.didThrow) {
      push(
        outcome.forwarded ? 'I4' : 'I6',
        `${outcome.kind}() call ${index}: JS threw ${String(outcome.thrown)} (available()=${available})`,
        outcome.forwarded
          ? 'no throw when native did not throw'
          : `harmless no-op — native module lacks ${outcome.kind}()`,
      );
    }
  });

  if (engine.speaking !== spec.speaking) {
    push(
      'I5',
      `model speaking=${JSON.stringify(engine.speaking)}`,
      `speaking=${JSON.stringify(spec.speaking)}`,
    );
  }
}

function runScenario(scenario: Scenario): RunResult {
  engine.reset();
  const tts = loadTts(scenario.mode);
  const spec = new BridgeSpec(scenario.mode);
  const violations: Violation[] = [];
  let steps = 0;

  scenario.actions.forEach((action, step) => {
    const outcomes: CallOutcome[] = [];
    switch (action.op) {
      case 'speak':
        outcomes.push(
          invokeOne(tts, spec, { kind: 'speak', text: action.text }),
        );
        break;
      case 'stop':
        outcomes.push(invokeOne(tts, spec, { kind: 'stop' }));
        break;
      case 'available':
        break;
      case 'burst':
        for (const text of action.texts) {
          outcomes.push(invokeOne(tts, spec, { kind: 'speak', text }));
        }
        break;
      case 'interleave':
        for (const text of action.texts) {
          outcomes.push(invokeOne(tts, spec, { kind: 'speak', text }));
          outcomes.push(invokeOne(tts, spec, { kind: 'stop' }));
        }
        break;
      case 'faultNext':
        // Arm the fake so its NEXT native call of that kind throws. When the
        // module is absent the arm is unreachable and stays armed harmlessly.
        engine.faultNext = action.target;
        spec.armedFault = action.target;
        break;
    }
    steps += 1;
    checkAfterStep(step, action, tts, spec, outcomes, violations);
  });

  return {
    violations,
    trace: engine.calls.slice(),
    steps,
    nativeCalls: engine.calls.length,
  };
}

/**
 * Shrink a failing scenario: cut to the prefix ending at the first violating
 * step, then greedy one-at-a-time removal while the failure persists.
 */
function minimize(scenario: Scenario): Scenario {
  const stillFails = (actions: Action[]) =>
    runScenario({ ...scenario, actions }).violations.length > 0;
  const firstStep = runScenario(scenario).violations[0]?.step;
  let actions = scenario.actions.slice(
    0,
    firstStep === undefined ? scenario.actions.length : firstStep + 1,
  );
  let changed = true;
  while (changed && actions.length > 1) {
    changed = false;
    for (let i = 0; i < actions.length; i += 1) {
      const candidate = [...actions.slice(0, i), ...actions.slice(i + 1)];
      if (stillFails(candidate)) {
        actions = candidate;
        changed = true;
        break;
      }
    }
  }
  return { ...scenario, actions };
}

function fnv1a(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

interface TableRow {
  seed: number;
  mode: EngineMode;
  length: number;
  steps: number;
  nativeCalls: number;
  traceHash: string;
  deterministic: boolean;
  outcome: 'HELD' | 'BROKEN';
  violations: Violation[];
  minimized?: { length: number; actions: Action[]; violation: Violation };
}

function campaign(
  seeds: readonly number[],
  modes: readonly EngineMode[],
): TableRow[] {
  return seeds.map(seed => {
    const scenario = genScenario(seed, modes);
    const first = runScenario(scenario);
    const second = runScenario(scenario);
    const firstTrace = JSON.stringify(first.trace);
    const deterministic =
      firstTrace === JSON.stringify(second.trace) &&
      JSON.stringify(first.violations) === JSON.stringify(second.violations);
    const row: TableRow = {
      seed,
      mode: scenario.mode,
      length: scenario.actions.length,
      steps: first.steps,
      nativeCalls: first.nativeCalls,
      traceHash: fnv1a(firstTrace),
      deterministic,
      outcome:
        first.violations.length === 0 && deterministic ? 'HELD' : 'BROKEN',
      violations: first.violations.slice(0, 3),
    };
    if (first.violations.length > 0) {
      const small = minimize(scenario);
      const violation = runScenario(small).violations[0];
      if (violation) {
        row.minimized = {
          length: small.actions.length,
          actions: small.actions,
          violation,
        };
      }
    }
    return row;
  });
}

// ───────────────────────────── knobs ─────────────────────────────

const ITER = Number(process.env.STRESS_ITER ?? 300);
const SEED_BASE = Number(process.env.STRESS_SEED_BASE ?? 20260904);
const REPLAY_SEED = process.env.STRESS_SEED
  ? Number(process.env.STRESS_SEED)
  : null;
const OUT = process.env.STRESS_OUT;

const seedsFrom = (offset: number, count: number): number[] =>
  Array.from({ length: count }, (_, i) => SEED_BASE + offset + i);

const written: Record<string, unknown> = {};
afterAll(() => {
  if (!OUT) return;
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        unit: 'apps/mobile/src/audio/tts.ts',
        lens: 'randomized-seeded',
        seedBase: SEED_BASE,
        iter: ITER,
        node: process.version,
        ...written,
      },
      null,
      2,
    ),
  );
});

// ───────────────────────────── suites ─────────────────────────────

describe('mod-tts randomized seeded stress', () => {
  it(`legal engines (full|missing): ${ITER} seeded sequences, every invariant HELD`, () => {
    const seeds = REPLAY_SEED !== null ? [REPLAY_SEED] : seedsFrom(0, ITER);
    const rows = campaign(seeds, LEGAL_MODES);
    written.legal = {
      modes: LEGAL_MODES,
      sequences: rows.length,
      steps: rows.reduce((n, r) => n + r.steps, 0),
      nativeCalls: rows.reduce((n, r) => n + r.nativeCalls, 0),
      held: rows.filter(r => r.outcome === 'HELD').length,
      broken: rows.filter(r => r.outcome === 'BROKEN').length,
      rows,
    };
    if (REPLAY_SEED !== null) {
      console.log(JSON.stringify(rows[0], null, 2));
    }
    const broken = rows.filter(r => r.outcome === 'BROKEN');
    expect(broken.map(r => ({ seed: r.seed, v: r.minimized }))).toEqual([]);
    expect(rows.every(r => r.deterministic)).toBe(true);
    expect(rows.length).toBe(seeds.length);
  });

  it(`near-legal partial modules (noSpeak|noStop): ${ITER} seeded sequences, observed contract recorded`, () => {
    const seeds =
      REPLAY_SEED !== null ? [REPLAY_SEED] : seedsFrom(1_000_000, ITER);
    const rows = campaign(seeds, NEAR_LEGAL_MODES);
    written.nearLegal = {
      modes: NEAR_LEGAL_MODES,
      sequences: rows.length,
      steps: rows.reduce((n, r) => n + r.steps, 0),
      nativeCalls: rows.reduce((n, r) => n + r.nativeCalls, 0),
      held: rows.filter(r => r.outcome === 'HELD').length,
      broken: rows.filter(r => r.outcome === 'BROKEN').length,
      brokenByInvariant: rows
        .flatMap(r => r.violations)
        .reduce<Record<string, number>>((acc, v) => {
          acc[v.invariant] = (acc[v.invariant] ?? 0) + 1;
          return acc;
        }, {}),
      rows,
    };
    // Determinism and the trace/rate/model invariants must hold even here;
    // only I6 (no-op when unavailable) is under investigation.
    expect(rows.every(r => r.deterministic)).toBe(true);
    const nonI6 = rows
      .flatMap(r => r.violations)
      .filter(v => v.invariant !== 'I6');
    expect(nonI6).toEqual([]);
    expect(rows.length).toBe(seeds.length);
  });

  // Pinned as a KNOWN failure (flips to a real failure once fixed): with a
  // native object that lacks `speak`, `available()` reports false yet
  // `speak()` throws a TypeError instead of being the documented no-op
  // (tts.ts:22 `native?.speak(...)` only guards the object, not the method).
  // Same shape for a missing `stop` at tts.ts:25.
  it.failing(
    'I6 — partial native module: available()===false implies speak()/stop() are no-ops',
    () => {
      for (const mode of NEAR_LEGAL_MODES) {
        const rows = campaign(seedsFrom(2_000_000, 50), [mode]);
        const i6 = rows
          .flatMap(r => r.violations)
          .filter(v => v.invariant === 'I6');
        expect({ mode, i6: i6.length }).toEqual({ mode, i6: 0 });
      }
    },
  );

  it('determinism — a fixed seed replays to a byte-identical trace 10×', () => {
    const scenario = genScenario(SEED_BASE + 77, LEGAL_MODES);
    const reference = JSON.stringify(runScenario(scenario).trace);
    for (let i = 0; i < 10; i += 1) {
      expect(JSON.stringify(runScenario(scenario).trace)).toBe(reference);
    }
    written.determinism10x = {
      seed: SEED_BASE + 77,
      traceHash: fnv1a(reference),
    };
  });

  it('rapid cues — 100k back-to-back speak/stop calls forward 1:1 without retained state', () => {
    engine.reset();
    const tts = loadTts('full');
    const spec = new BridgeSpec('full');
    const rounds = 5;
    const perRound = 20_000;
    const heap: number[] = [];
    const callsPerRound: number[] = [];
    const gc = (globalThis as { gc?: () => void }).gc;
    for (let round = 0; round < rounds; round += 1) {
      for (let i = 0; i < perRound; i += 1) {
        const text = i % 7 === 0 ? '' : REAL_CUES[i % REAL_CUES.length]!;
        spec.speak(text);
        tts.speak(text);
        if (i % 3 === 0) {
          spec.stop();
          tts.stop();
        }
      }
      expect(JSON.stringify(engine.calls)).toBe(
        JSON.stringify(spec.expectedCalls),
      );
      expect(engine.speaking).toBe(spec.speaking);
      callsPerRound.push(engine.calls.length);
      // The fakes' recordings are the only things that grow; drop them so
      // heap growth would have to come from the module under test.
      engine.calls = [];
      spec.expectedCalls = [];
      gc?.();
      heap.push(process.memoryUsage().heapUsed);
    }
    written.rapid = {
      rounds,
      perRound,
      callsPerRound,
      gcExposed: typeof gc === 'function',
      heapUsedMB: heap.map(h => Number((h / 1_048_576).toFixed(2))),
    };
    expect(callsPerRound).toEqual(
      Array.from({ length: rounds }, () => perRound + Math.ceil(perRound / 3)),
    );
    if (typeof gc === 'function') {
      const growth = heap[heap.length - 1]! - heap[0]!;
      expect(growth).toBeLessThan(8 * 1_048_576);
    }
  });
});
