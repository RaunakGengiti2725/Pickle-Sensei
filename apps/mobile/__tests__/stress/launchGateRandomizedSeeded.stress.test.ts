/**
 * STRESS — flow/launchGate, lens `randomized-seeded`.
 *
 * Seeded randomized long-run over the launch gate's public API through the
 * App.tsx wiring model (test-support/stress/launchGateStressHarness.ts):
 * legal taps, stale handlers, fabricated device-history arguments and
 * device-history churn, invariants I1–I8 checked after every step, every
 * sequence replayable from its seed, failing seeds shrunk to a 1-minimal
 * action list.
 *
 * Scale:   STRESS_ITER=<n>        random sequences (default 2000, length 5–60)
 *          STRESS_SEED_BASE=<n>   first seed (default 1)
 *          STRESS_LONG_LEN=<n>    one long single sequence (default 5000 steps)
 *          STRESS_STORM=<n>       calls per gate fn in the call storm (default 300000)
 * Replay:  STRESS_ONLY=<seed>
 * Output:  STRESS_OUT=<dir>       JSON tables (default artifacts/stress)
 *
 * Replay one seed:
 *   STRESS_ONLY=<seed> npx jest __tests__/stress/launchGateRandomizedSeeded.stress.test.ts
 */
import * as launchGate from '../../src/flow/launchGate';
import type { PreAuthStage } from '../../src/flow/launchGate';
import {
  ALL_ACTIONS,
  FRESH_HISTORY,
  STAGES,
  generateSequence,
  hashTrace,
  minimizeSequence,
  runActions,
  runSeed,
  screenFor,
  summarizeResult,
  type Action,
  type Failure,
  type LaunchGateApi,
  type SequenceResult,
} from '../../test-support/stress/launchGateStressHarness';

// Node built-ins for the raw artifacts. The mobile tsconfig excludes node
// typings (see matrix/networkAuthMatrix.test.ts), so the shims stay local.
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  memoryUsage(): { heapUsed: number; rss: number; external: number };
};
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

const ITER = Number(process.env.STRESS_ITER ?? 2000);
const SEED_BASE = Number(process.env.STRESS_SEED_BASE ?? 1);
const LONG_LEN = Number(process.env.STRESS_LONG_LEN ?? 5000);
const STORM = Number(process.env.STRESS_STORM ?? 300_000);
const ONLY = process.env.STRESS_ONLY ?? null;
const OUT_DIR =
  process.env.STRESS_OUT ?? join(__dirname, '..', '..', 'artifacts', 'stress');

const REAL_GATE: LaunchGateApi = {
  stageAfterGetStarted: launchGate.stageAfterGetStarted,
  stageAfterOnboarding: launchGate.stageAfterOnboarding,
  stageWhenLeavingOnboarding: launchGate.stageWhenLeavingOnboarding,
};

function seeds(): number[] {
  if (ONLY !== null) {
    const seed = Number(ONLY);
    if (!Number.isInteger(seed)) {
      throw new Error(`STRESS_ONLY must be an integer seed, got ${ONLY}`);
    }
    return [seed];
  }
  return Array.from({ length: ITER }, (_, i) => SEED_BASE + i);
}

function failureLines(seed: number, failures: readonly Failure[]): string[] {
  return [
    `STRESS FAILURE seed=${seed}`,
    `replay: STRESS_ONLY=${seed} npx jest __tests__/stress/launchGateRandomizedSeeded.stress.test.ts`,
    ...failures.map(
      f =>
        `  [${f.invariant}] step=${f.step} ${f.action} ${f.before}→${f.after}: ${f.detail}`,
    ),
  ];
}

// ─── Artifact collection ─────────────────────────────────────────────────────

const rows: ReturnType<typeof summarizeResult>[] = [];
const failing: Array<{
  seed: number;
  original: Action[];
  minimized: Action[];
  failures: Failure[];
}> = [];
const determinism: Array<{
  seed: number;
  hashA: string;
  hashB: string;
  same: boolean;
}> = [];
const exhaustive: Array<{
  from: PreAuthStage;
  action: Action;
  history: string;
  to: PreAuthStage;
  expected: PreAuthStage;
  ok: boolean;
}> = [];
const heap: Array<{ index: number; heapUsedMb: number; rssMb: number }> = [];
const storm: {
  calls: number;
  heapBeforeMb: number;
  heapAfterMb: number;
  outputs: string[];
} = { calls: 0, heapBeforeMb: 0, heapAfterMb: 0, outputs: [] };
const mutants: Array<{
  mutant: string;
  seedsRun: number;
  failingSeeds: number;
  firstFailingSeed: number | null;
  originalLength: number | null;
  minimizedLength: number | null;
  minimized: Action[];
  invariants: string[];
}> = [];
let longRun: {
  seed: number;
  length: number;
  ok: boolean;
  finalStage: string;
  hash: string;
} | null = null;
const wallStart = Date.now();

function heapSample() {
  const mem = process.memoryUsage();
  heap.push({
    index: rows.length,
    heapUsedMb: Math.round((mem.heapUsed / 1_048_576) * 10) / 10,
    rssMb: Math.round((mem.rss / 1_048_576) * 10) / 10,
  });
}

afterAll(() => {
  const executed =
    rows.length +
    exhaustive.length +
    mutants.reduce((n, m) => n + m.seedsRun, 0) +
    (longRun ? 1 : 0);
  const stepsExecuted = rows.reduce((n, r) => n + r.length, 0);
  const byInvariant: Record<string, number> = {};
  for (const r of rows) {
    for (const f of r.failures) {
      byInvariant[f.invariant] = (byInvariant[f.invariant] ?? 0) + 1;
    }
  }
  const finalStages: Record<string, number> = {};
  for (const r of rows)
    finalStages[r.finalStage] = (finalStages[r.finalStage] ?? 0) + 1;
  const summary = {
    unit: 'apps/mobile/src/flow/launchGate.ts',
    lens: 'randomized-seeded',
    generatedAt: new Date().toISOString(),
    config: { ITER, SEED_BASE, LONG_LEN, STORM, ONLY },
    randomized: {
      sequences: rows.length,
      steps: stepsExecuted,
      minLength: rows.length ? Math.min(...rows.map(r => r.length)) : null,
      maxLength: rows.length ? Math.max(...rows.map(r => r.length)) : null,
      passed: rows.filter(r => r.ok).length,
      failed: rows.filter(r => !r.ok).length,
      signinVisits: rows.reduce((n, r) => n + r.signinVisits, 0),
      onboardingVisits: rows.reduce((n, r) => n + r.onboardingVisits, 0),
      staleLinkFromOnboarding: rows.reduce(
        (n, r) => n + r.staleLinkFromOnboarding,
        0,
      ),
      finalStages,
      byInvariant,
    },
    determinism: {
      checked: determinism.length,
      mismatches: determinism.filter(d => !d.same).length,
    },
    exhaustive: {
      combos: exhaustive.length,
      mismatches: exhaustive.filter(e => !e.ok).length,
    },
    longRun,
    storm,
    mutants,
    heap: {
      samples: heap.length,
      maxHeapUsedMb: Math.max(0, ...heap.map(h => h.heapUsedMb)),
      maxRssMb: Math.max(0, ...heap.map(h => h.rssMb)),
      first: heap[0] ?? null,
      last: heap[heap.length - 1] ?? null,
    },
    scenariosExecuted: executed,
    wallMs: Date.now() - wallStart,
    failing,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const suffix = ONLY !== null ? `-seed${ONLY}` : '';
  writeFileSync(
    join(OUT_DIR, `launch-gate-summary${suffix}.json`),
    JSON.stringify(summary, null, 2),
  );
  writeFileSync(
    join(OUT_DIR, `launch-gate-seeds${suffix}.json`),
    JSON.stringify(rows, null, 2),
  );
  writeFileSync(
    join(OUT_DIR, `launch-gate-determinism${suffix}.json`),
    JSON.stringify(determinism, null, 2),
  );
  writeFileSync(
    join(OUT_DIR, `launch-gate-exhaustive${suffix}.json`),
    JSON.stringify(exhaustive, null, 2),
  );
  writeFileSync(
    join(OUT_DIR, `launch-gate-heap${suffix}.json`),
    JSON.stringify(heap, null, 2),
  );
});

// ─── 1. Exhaustive state × action × history table ────────────────────────────

/** The specification, written independently of the gate: what App.tsx's
 * wiring must do for every (stage, action). */
function expectedNext(from: PreAuthStage, action: Action): PreAuthStage {
  switch (action) {
    case 'welcome.getStarted':
    case 'probe.getStartedWithHistory':
      return from === 'welcome' ? 'onboarding' : from;
    case 'welcome.alreadyHaveAccount':
      return from === 'welcome' ? 'signin' : from;
    case 'onboarding.finished':
    case 'probe.finishedWithHistory':
      return from === 'onboarding' ? 'signin' : from;
    case 'onboarding.back':
    case 'probe.backWithHistory':
      return from === 'onboarding' ? 'welcome' : from;
    case 'signin.back':
      return from === 'signin' ? 'welcome' : from;
    case 'stale.getStarted':
      return 'onboarding';
    case 'stale.alreadyHaveAccount':
    case 'stale.onboardingFinished':
      return 'signin';
    case 'stale.onboardingBack':
    case 'stale.signinBack':
      return 'welcome';
    case 'probe.detachedCalls':
    case 'history.priorAccount':
    case 'history.questionnaireDone':
    case 'history.stashAnswers':
    case 'history.reset':
    case 'history.rerender':
      return from;
    default: {
      const never: never = action;
      throw new Error(`unknown action ${String(never)}`);
    }
  }
}

const STAGE_PREFIX: Record<PreAuthStage, Action[]> = {
  welcome: [],
  onboarding: ['welcome.getStarted'],
  signin: ['welcome.alreadyHaveAccount'],
};

const HISTORY_PRESETS: Array<{ name: string; actions: Action[] }> = [
  { name: 'fresh', actions: [] },
  { name: 'priorAccount', actions: ['history.priorAccount'] },
  { name: 'questionnaireDone', actions: ['history.questionnaireDone'] },
  {
    name: 'everything',
    actions: [
      'history.priorAccount',
      'history.questionnaireDone',
      'history.stashAnswers',
    ],
  },
];

describe('launch gate — exhaustive (stage × action × device history)', () => {
  const combos: Array<[PreAuthStage, Action, string]> = [];
  for (const from of STAGES) {
    for (const action of ALL_ACTIONS) {
      for (const preset of HISTORY_PRESETS)
        combos.push([from, action, preset.name]);
    }
  }

  it.each(combos)('%s + %s (history=%s)', (from, action, historyName) => {
    const preset = HISTORY_PRESETS.find(p => p.name === historyName);
    if (!preset) throw new Error(`unknown preset ${historyName}`);
    const actions: Action[] = [
      ...preset.actions,
      ...STAGE_PREFIX[from],
      action,
    ];
    const result = runActions(REAL_GATE, 0xc0ffee, actions);
    const setupSteps = preset.actions.length + STAGE_PREFIX[from].length;
    const last = result.trace[result.trace.length - 1];
    if (!last) throw new Error('empty trace');
    const expected = expectedNext(from, action);
    exhaustive.push({
      from,
      action,
      history: historyName,
      to: last.after,
      expected,
      ok: last.before === from && last.after === expected && result.ok,
    });
    expect(last.step).toBe(setupSteps);
    expect(last.before).toBe(from);
    expect(last.after).toBe(expected);
    expect(result.failures).toEqual([]);
  });

  it('covers every stage, every action and 4 history presets', () => {
    expect(exhaustive.length).toBe(
      STAGES.length * ALL_ACTIONS.length * HISTORY_PRESETS.length,
    );
    expect(exhaustive.length).toBeGreaterThanOrEqual(228);
  });

  it('render mapping is total and injective over the stage domain', () => {
    const screens = STAGES.map(screenFor);
    expect(new Set(screens).size).toBe(STAGES.length);
    expect(screenFor('onboarding')).toBe('OnboardingScreen[preauth]');
    expect(screenFor('signin')).toBe('SignInScreen');
    expect(screenFor('welcome')).toBe('WelcomeScreen');
  });
});

// ─── 2. Seeded randomized campaign ───────────────────────────────────────────

describe('launch gate — seeded randomized long-run', () => {
  const campaign = seeds();

  it.each(campaign.map(s => [s] as const))('seed=%i', seed => {
    const result: SequenceResult = runSeed(REAL_GATE, seed);
    rows.push(summarizeResult(result));
    if (rows.length % 250 === 0 || rows.length === 1) heapSample();

    // Determinism: the same seed must produce byte-identical traces.
    const again = runSeed(REAL_GATE, seed);
    determinism.push({
      seed,
      hashA: result.traceHash,
      hashB: again.traceHash,
      same: result.traceHash === again.traceHash,
    });
    expect(again.traceHash).toBe(result.traceHash);
    expect(JSON.stringify(again.trace)).toBe(JSON.stringify(result.trace));

    if (!result.ok) {
      const shrunk = minimizeSequence(REAL_GATE, seed, result.actions);
      failing.push({
        seed,
        original: result.actions,
        minimized: shrunk.actions,
        failures: shrunk.failures,
      });
      throw new Error(
        [
          ...failureLines(seed, result.failures),
          `minimized (${shrunk.actions.length} steps): ${JSON.stringify(shrunk.actions)}`,
        ].join('\n'),
      );
    }
  });

  it('executed the required scale with lengths in [5, 60]', () => {
    heapSample();
    expect(rows.length).toBe(campaign.length);
    if (ONLY === null) expect(rows.length).toBeGreaterThanOrEqual(ITER);
    for (const r of rows) {
      expect(r.length).toBeGreaterThanOrEqual(5);
      expect(r.length).toBeLessThanOrEqual(60);
    }
    // The generator must actually exercise the gate, not just history churn.
    const visits = rows.reduce(
      (n, r) => n + r.onboardingVisits + r.signinVisits,
      0,
    );
    expect(visits).toBeGreaterThan(rows.length);
    if (ONLY === null && rows.length >= 100) {
      const finals = new Set(rows.map(r => r.finalStage));
      expect(finals).toEqual(new Set(STAGES));
    }
  });

  it('same seed → identical generated action list (generator determinism)', () => {
    for (const seed of campaign.slice(0, 200)) {
      expect(generateSequence(seed)).toEqual(generateSequence(seed));
    }
    // Distinct seeds must not collapse onto one sequence (≥95% unique).
    const sample = campaign.slice(0, 200);
    const distinct = new Set(
      sample.map(s => JSON.stringify(generateSequence(s))),
    );
    expect(distinct.size).toBeGreaterThanOrEqual(
      Math.ceil(sample.length * 0.95),
    );
  });

  it('one long single sequence holds every invariant', () => {
    const seed = SEED_BASE + 0x51ab;
    const actions = generateSequence(seed, {
      minLength: LONG_LEN,
      maxLength: LONG_LEN,
    });
    const result = runActions(REAL_GATE, seed, actions);
    longRun = {
      seed,
      length: actions.length,
      ok: result.ok,
      finalStage: result.finalStage,
      hash: result.traceHash,
    };
    expect(actions.length).toBe(LONG_LEN);
    if (!result.ok)
      throw new Error(failureLines(seed, result.failures).join('\n'));
    expect(hashTrace(result.trace)).toBe(result.traceHash);
  });
});

// ─── 3. Call storm (constancy + no unbounded allocation) ─────────────────────

describe('launch gate — call storm', () => {
  it(`${STORM} calls per gate fn return the same constant and stay flat on heap`, () => {
    const before = process.memoryUsage().heapUsed;
    const seen = new Set<string>();
    for (let i = 0; i < STORM; i += 1) {
      seen.add(
        `${launchGate.stageAfterGetStarted()}|${launchGate.stageAfterOnboarding()}|${launchGate.stageWhenLeavingOnboarding()}`,
      );
    }
    const after = process.memoryUsage().heapUsed;
    storm.calls = STORM * 3;
    storm.heapBeforeMb = Math.round((before / 1_048_576) * 10) / 10;
    storm.heapAfterMb = Math.round((after / 1_048_576) * 10) / 10;
    storm.outputs = [...seen];
    expect(seen).toEqual(new Set(['onboarding|signin|welcome']));
    // Three interned string literals: nothing should accumulate. 64 MB is a
    // generous ceiling that still catches a per-call allocation leak.
    expect(after - before).toBeLessThan(64 * 1_048_576);
  });
});

// ─── 4. Mutant sensitivity (the harness must have teeth) ────────────────────

/** Each mutant is a factory so stateful mutants (M2, M5) restart from the
 * same state on every run — replay and shrinking stay sound. */
type Mutant = {
  name: string;
  gate: () => LaunchGateApi;
  expectInvariants: string[];
};

function mutantSet(): Mutant[] {
  return [
    {
      name: 'M1 back-from-step-one goes to signin (skip affordance)',
      gate: () => ({
        ...REAL_GATE,
        stageWhenLeavingOnboarding: () => 'signin',
      }),
      expectInvariants: ['I2.no-skip', 'I6.leave-ne-finish'],
    },
    {
      name: 'M2 CTA short-circuits to signin once the questionnaire was ever finished',
      gate: () => {
        let finished = false;
        return {
          stageAfterGetStarted: () => (finished ? 'signin' : 'onboarding'),
          stageAfterOnboarding: () => {
            finished = true;
            return 'signin';
          },
          stageWhenLeavingOnboarding: () => 'welcome',
        };
      },
      expectInvariants: ['I3.cta-onboarding', 'I5.gate-constant'],
    },
    {
      name: 'M3 finishing the questionnaire loops back to Welcome',
      gate: () => ({ ...REAL_GATE, stageAfterOnboarding: () => 'welcome' }),
      expectInvariants: ['I4.onboarding-exit', 'I6.leave-ne-finish'],
    },
    {
      name: 'M4 gate consults its (fabricated) argument',
      gate: () => ({
        ...REAL_GATE,
        stageAfterGetStarted: ((history?: {
          priorAccountOnDevice?: boolean;
        }) =>
          history?.priorAccountOnDevice
            ? 'signin'
            : 'onboarding') as () => PreAuthStage,
      }),
      expectInvariants: ['I5.gate-constant'],
    },
    {
      name: 'M5 gate throws intermittently',
      gate: () => {
        let calls = 0;
        return {
          ...REAL_GATE,
          stageAfterOnboarding: () => {
            calls += 1;
            if (calls % 7 === 0) throw new Error('boom');
            return 'signin';
          },
        };
      },
      expectInvariants: ['I5.gate-constant'],
    },
    {
      name: 'M6 gate leaves the stage domain',
      gate: () => ({
        ...REAL_GATE,
        stageAfterOnboarding: () => 'app' as PreAuthStage,
      }),
      expectInvariants: ['I1.domain', 'I4.onboarding-exit', 'I5.gate-constant'],
    },
  ];
}

describe('launch gate — mutant sensitivity', () => {
  const MUTANT_SEEDS = 200;

  it.each(mutantSet().map(m => [m.name, m] as const))(
    '%s is caught',
    (_name, mutant) => {
      const hits: SequenceResult[] = [];
      for (let seed = SEED_BASE; seed < SEED_BASE + MUTANT_SEEDS; seed += 1) {
        const result = runSeed(mutant.gate, seed);
        if (!result.ok) hits.push(result);
      }
      const first = hits[0];
      const shrunk = first
        ? minimizeSequence(mutant.gate, first.seed, first.actions)
        : null;
      const invariants = new Set(
        hits.flatMap(h => h.failures.map(f => f.invariant)),
      );
      mutants.push({
        mutant: mutant.name,
        seedsRun: MUTANT_SEEDS,
        failingSeeds: hits.length,
        firstFailingSeed: first?.seed ?? null,
        originalLength: first?.length ?? null,
        minimizedLength: shrunk?.actions.length ?? null,
        minimized: shrunk?.actions ?? [],
        invariants: [...invariants],
      });
      expect(hits.length).toBeGreaterThan(0);
      for (const inv of mutant.expectInvariants)
        expect(invariants).toContain(inv);
      if (!first || !shrunk) throw new Error('unreachable');
      expect(shrunk.actions.length).toBeGreaterThan(0);
      expect(shrunk.actions.length).toBeLessThanOrEqual(first.length);
      expect(shrunk.failures.length).toBeGreaterThan(0);
      // The minimized list still fails the same invariant class.
      const targets = new Set(first.failures.map(f => f.invariant));
      expect(shrunk.failures.some(f => targets.has(f.invariant))).toBe(true);
    },
  );

  it('the real gate passes every mutant seed', () => {
    for (let seed = SEED_BASE; seed < SEED_BASE + MUTANT_SEEDS; seed += 1) {
      expect(runSeed(REAL_GATE, seed).ok).toBe(true);
    }
    expect(FRESH_HISTORY.stashedAnswers).toBe(0);
  });
});
