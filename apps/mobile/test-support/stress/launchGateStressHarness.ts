/**
 * Seeded randomized long-run harness for `src/flow/launchGate.ts`.
 *
 * The unit under test is the pre-auth launch gate: three argument-less pure
 * functions that App.tsx wires into its `preAuthStage` state
 * (welcome → onboarding → signin). This harness drives the REAL gate
 * functions through a model of exactly that wiring (App.tsx `Gate()`):
 *
 *   welcome:    onGetStarted → setStage(stageAfterGetStarted())
 *               onSignIn     → setStage('signin')            (explicit link)
 *   onboarding: onFinished   → setStage(stageAfterOnboarding())
 *               onBack       → setStage(stageWhenLeavingOnboarding())
 *   signin:     onBack       → setStage('welcome')
 *
 * A screen's handler can only fire while that screen is mounted, so a legal
 * action fired in another stage is a no-op. Near-legal actions cover what a
 * device can still produce: a STALE handler firing after the stage moved
 * (double tap / in-flight press), a caller handing the gate fabricated
 * device-history flags (the gate must ignore them — it takes no input), and
 * device-history mutations between taps (prior account, questionnaire
 * already answered, stashed answers) that must never change the routing.
 *
 * Invariants (launchGate.ts header, AGENTS.md "Launch flow", REVIEW.md
 * "Launch flow & copy": onboarding before sign-in, non-skippable, primary CTA
 * never consults device history) are model-checked after EVERY step:
 *
 *   I1 domain          stage ∈ {welcome, onboarding, signin}
 *   I2 no-skip         a step that lands on signin was caused by finishing the
 *                      questionnaire or by the explicit "already have an
 *                      account" link — never by getStarted, never by back
 *   I3 cta-onboarding  every getStarted (any stage history, any fabricated
 *                      argument) yields onboarding
 *   I4 onboarding-exit from onboarding the only moves are back → welcome and
 *                      finished → signin
 *   I5 gate-constant   each gate fn returns the same value as on its first
 *                      call, has .length === 0, returns a string, never throws
 *   I6 leave≠finish    stageWhenLeavingOnboarding() !== stageAfterOnboarding()
 *   I7 history-blind   gate outputs are identical for every device-history
 *                      combination seen in the run
 *   I8 render-total    App.tsx's render ternary maps the stage to exactly one
 *                      pre-auth screen, injectively
 *
 * Every sequence is derived from its seed alone (mulberry32), so a failing
 * seed replays exactly; `minimizeSequence` shrinks a failing action list to a
 * 1-minimal one that still fails.
 */
import type { PreAuthStage } from '../../src/flow/launchGate';

export interface LaunchGateApi {
  stageAfterGetStarted: () => PreAuthStage;
  stageAfterOnboarding: () => PreAuthStage;
  stageWhenLeavingOnboarding: () => PreAuthStage;
}

/** A gate, or a factory producing a fresh gate per run (lets stateful mutants
 * start from the same state on every replay, so shrinking stays sound). */
export type GateSource = LaunchGateApi | (() => LaunchGateApi);

function resolveGate(source: GateSource): LaunchGateApi {
  return typeof source === 'function' ? source() : source;
}

export const STAGES: readonly PreAuthStage[] = [
  'welcome',
  'onboarding',
  'signin',
] as const;

/** Legal (screen-wired) actions — fire only while their screen is mounted. */
export const LEGAL_ACTIONS = [
  'welcome.getStarted',
  'welcome.alreadyHaveAccount',
  'onboarding.finished',
  'onboarding.back',
  'signin.back',
] as const;

/** Near-legal: a previously mounted screen's handler firing after the stage
 * moved. App.tsx handlers are `() => setPreAuthStage(<constant>)`, so a stale
 * handler applies its transition regardless of the current stage. */
export const STALE_ACTIONS = [
  'stale.getStarted',
  'stale.alreadyHaveAccount',
  'stale.onboardingFinished',
  'stale.onboardingBack',
  'stale.signinBack',
] as const;

/** Near-legal: the gate is handed device-history flags it must ignore. */
export const PROBE_ACTIONS = [
  'probe.getStartedWithHistory',
  'probe.finishedWithHistory',
  'probe.backWithHistory',
  'probe.detachedCalls',
] as const;

/** Device-history mutations between taps (no stage change by themselves). */
export const HISTORY_ACTIONS = [
  'history.priorAccount',
  'history.questionnaireDone',
  'history.stashAnswers',
  'history.reset',
  'history.rerender',
] as const;

export type Action =
  | (typeof LEGAL_ACTIONS)[number]
  | (typeof STALE_ACTIONS)[number]
  | (typeof PROBE_ACTIONS)[number]
  | (typeof HISTORY_ACTIONS)[number];

export const ALL_ACTIONS: readonly Action[] = [
  ...LEGAL_ACTIONS,
  ...STALE_ACTIONS,
  ...PROBE_ACTIONS,
  ...HISTORY_ACTIONS,
];

export interface DeviceHistory {
  priorAccountOnDevice: boolean;
  questionnaireCompletedBefore: boolean;
  stashedAnswers: number;
  returningPlayerHint: boolean;
}

export const FRESH_HISTORY: DeviceHistory = {
  priorAccountOnDevice: false,
  questionnaireCompletedBefore: false,
  stashedAnswers: 0,
  returningPlayerHint: false,
};

export type PreAuthScreen =
  'WelcomeScreen' | 'OnboardingScreen[preauth]' | 'SignInScreen';

/** Mirrors App.tsx's render ternary for the signed-out branch. */
export function screenFor(stage: PreAuthStage): PreAuthScreen {
  return stage === 'signin'
    ? 'SignInScreen'
    : stage === 'onboarding'
      ? 'OnboardingScreen[preauth]'
      : 'WelcomeScreen';
}

export type Invariant =
  | 'I1.domain'
  | 'I2.no-skip'
  | 'I3.cta-onboarding'
  | 'I4.onboarding-exit'
  | 'I5.gate-constant'
  | 'I6.leave-ne-finish'
  | 'I7.history-blind'
  | 'I8.render-total';

export interface Failure {
  invariant: Invariant;
  step: number;
  action: Action;
  before: string;
  after: string;
  detail: string;
}

export interface TraceStep {
  step: number;
  action: Action;
  before: PreAuthStage;
  after: PreAuthStage;
  screen: PreAuthScreen;
  history: DeviceHistory;
  gate: { getStarted: string; finished: string; leaving: string };
}

export interface SequenceResult {
  seed: number;
  length: number;
  actions: Action[];
  ok: boolean;
  failures: Failure[];
  finalStage: PreAuthStage;
  signinVisits: number;
  onboardingVisits: number;
  /** Stale Welcome link handler firing while onboarding was mounted. */
  staleLinkFromOnboarding: number;
  actionCounts: Record<string, number>;
  traceHash: string;
  trace: TraceStep[];
}

// ─── Seeded RNG ─────────────────────────────────────────────────────────────

/** mulberry32 — small, fast, fully determined by its 32-bit seed. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, list: readonly T[]): T {
  const index = Math.floor(rng() * list.length);
  const item = list[index];
  if (item === undefined) throw new Error('empty pick list');
  return item;
}

export interface GeneratorOptions {
  minLength: number;
  maxLength: number;
}

export const DEFAULT_GENERATOR: GeneratorOptions = {
  minLength: 5,
  maxLength: 60,
};

/** Action alphabet weights: mostly legal taps, a real share of stale
 * handlers, history churn and argument probes. */
export function generateSequence(
  seed: number,
  options: GeneratorOptions = DEFAULT_GENERATOR,
): Action[] {
  const rng = createRng(seed);
  const span = options.maxLength - options.minLength + 1;
  const length = options.minLength + Math.floor(rng() * span);
  const actions: Action[] = [];
  for (let i = 0; i < length; i += 1) {
    const roll = rng();
    if (roll < 0.6) actions.push(pick(rng, LEGAL_ACTIONS));
    else if (roll < 0.78) actions.push(pick(rng, STALE_ACTIONS));
    else if (roll < 0.9) actions.push(pick(rng, HISTORY_ACTIONS));
    else actions.push(pick(rng, PROBE_ACTIONS));
  }
  return actions;
}

// ─── Model ──────────────────────────────────────────────────────────────────

type HistoryCaller = (...args: unknown[]) => PreAuthStage;
type Cause = 'getStarted' | 'link' | 'finished' | 'back' | 'none';

interface ModelState {
  stage: PreAuthStage;
  history: DeviceHistory;
}

/** Applies one action to the App.tsx wiring model; returns the new stage and
 * the cause class the no-skip invariant reasons about. */
function applyAction(
  gate: LaunchGateApi,
  state: ModelState,
  action: Action,
  rng: () => number,
): {
  stage: PreAuthStage;
  cause: Cause;
  /** Set when a detached/foreign-`this` call disagreed with the direct call. */
  probeMismatch?: string;
} {
  const { stage, history } = state;
  const asHistoryCaller = (fn: () => PreAuthStage): HistoryCaller =>
    fn as unknown as HistoryCaller;
  switch (action) {
    case 'welcome.getStarted':
      return stage === 'welcome'
        ? { stage: gate.stageAfterGetStarted(), cause: 'getStarted' }
        : { stage, cause: 'none' };
    case 'welcome.alreadyHaveAccount':
      return stage === 'welcome'
        ? { stage: 'signin', cause: 'link' }
        : { stage, cause: 'none' };
    case 'onboarding.finished':
      return stage === 'onboarding'
        ? { stage: gate.stageAfterOnboarding(), cause: 'finished' }
        : { stage, cause: 'none' };
    case 'onboarding.back':
      return stage === 'onboarding'
        ? { stage: gate.stageWhenLeavingOnboarding(), cause: 'back' }
        : { stage, cause: 'none' };
    case 'signin.back':
      return stage === 'signin'
        ? { stage: 'welcome', cause: 'back' }
        : { stage, cause: 'none' };
    case 'stale.getStarted':
      return { stage: gate.stageAfterGetStarted(), cause: 'getStarted' };
    case 'stale.alreadyHaveAccount':
      return { stage: 'signin', cause: 'link' };
    case 'stale.onboardingFinished':
      return { stage: gate.stageAfterOnboarding(), cause: 'finished' };
    case 'stale.onboardingBack':
      return { stage: gate.stageWhenLeavingOnboarding(), cause: 'back' };
    case 'stale.signinBack':
      return { stage: 'welcome', cause: 'back' };
    case 'probe.getStartedWithHistory':
      return stage === 'welcome'
        ? {
            stage: asHistoryCaller(gate.stageAfterGetStarted)(
              history,
              history.priorAccountOnDevice,
              'signin',
            ),
            cause: 'getStarted',
          }
        : { stage, cause: 'none' };
    case 'probe.finishedWithHistory':
      return stage === 'onboarding'
        ? {
            stage: asHistoryCaller(gate.stageAfterOnboarding)(
              history,
              'welcome',
            ),
            cause: 'finished',
          }
        : { stage, cause: 'none' };
    case 'probe.backWithHistory':
      return stage === 'onboarding'
        ? {
            stage: asHistoryCaller(gate.stageWhenLeavingOnboarding)(
              history,
              history.questionnaireCompletedBefore,
              'signin',
            ),
            cause: 'back',
          }
        : { stage, cause: 'none' };
    case 'probe.detachedCalls': {
      // Detached references, foreign `this`, and `.call`/`.apply` with junk —
      // the module must behave identically (I5 verifies the outputs).
      const detached = {
        getStarted: gate.stageAfterGetStarted,
        finished: gate.stageAfterOnboarding,
        leaving: gate.stageWhenLeavingOnboarding,
      };
      const foreignThis = {
        stageAfterGetStarted: () => 'signin' as PreAuthStage,
      };
      const expected = [
        gate.stageAfterGetStarted(),
        gate.stageAfterOnboarding(),
        gate.stageWhenLeavingOnboarding(),
      ];
      const observed = [
        [detached.getStarted(), expected[0]],
        [detached.finished(), expected[1]],
        [detached.leaving(), expected[2]],
        [gate.stageAfterGetStarted.call(foreignThis), expected[0]],
        [gate.stageAfterOnboarding.call(null), expected[1]],
        [gate.stageWhenLeavingOnboarding.apply(undefined, []), expected[2]],
        [
          asHistoryCaller(gate.stageAfterGetStarted).apply(history, [
            rng(),
            history,
          ]),
          expected[0],
        ],
      ] as const;
      const mismatch = observed.findIndex(([got, want]) => got !== want);
      // Detached calls are probes only: they never move the stage.
      return mismatch === -1
        ? { stage, cause: 'none' }
        : {
            stage,
            cause: 'none',
            probeMismatch: `detached call #${mismatch} returned ${String(observed[mismatch]?.[0])}, direct call ${String(observed[mismatch]?.[1])}`,
          };
    }
    case 'history.priorAccount':
      state.history = {
        ...history,
        priorAccountOnDevice: true,
        returningPlayerHint: rng() < 0.5,
      };
      return { stage, cause: 'none' };
    case 'history.questionnaireDone':
      state.history = { ...history, questionnaireCompletedBefore: true };
      return { stage, cause: 'none' };
    case 'history.stashAnswers':
      state.history = { ...history, stashedAnswers: 1 + Math.floor(rng() * 3) };
      return { stage, cause: 'none' };
    case 'history.reset':
      state.history = { ...FRESH_HISTORY };
      return { stage, cause: 'none' };
    case 'history.rerender':
      return { stage, cause: 'none' };
    default: {
      const never: never = action;
      throw new Error(`unknown action ${String(never)}`);
    }
  }
}

function historyKey(history: DeviceHistory): string {
  return `${history.priorAccountOnDevice ? 1 : 0}${history.questionnaireCompletedBefore ? 1 : 0}${history.stashedAnswers}${history.returningPlayerHint ? 1 : 0}`;
}

function safeCall(fn: () => PreAuthStage): {
  value: string;
  threw: string | null;
} {
  try {
    const value = fn();
    return {
      value: typeof value === 'string' ? value : `<${typeof value}>`,
      threw: null,
    };
  } catch (error) {
    return {
      value: '<throw>',
      threw: error instanceof Error ? error.message : String(error),
    };
  }
}

/** FNV-1a over the JSON trace — identical seeds must produce identical hashes. */
export function hashTrace(trace: readonly TraceStep[]): string {
  const text = JSON.stringify(trace);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Runs one explicit action list against the gate, model-checking every
 * invariant after each step. */
export function runActions(
  source: GateSource,
  seed: number,
  actions: readonly Action[],
): SequenceResult {
  const gate = resolveGate(source);
  const rng = createRng(seed ^ 0x9e3779b9);
  const state: ModelState = { stage: 'welcome', history: { ...FRESH_HISTORY } };
  const failures: Failure[] = [];
  const trace: TraceStep[] = [];
  const actionCounts: Record<string, number> = {};
  let signinVisits = 0;
  let onboardingVisits = 0;
  let staleLinkFromOnboarding = 0;
  let firstOutputs: {
    getStarted: string;
    finished: string;
    leaving: string;
  } | null = null;
  const outputsByHistory = new Map<string, string>();

  const fail = (
    invariant: Invariant,
    step: number,
    action: Action,
    before: string,
    after: string,
    detail: string,
  ) => failures.push({ invariant, step, action, before, after, detail });

  for (let step = 0; step < actions.length; step += 1) {
    const action = actions[step];
    if (action === undefined) break;
    actionCounts[action] = (actionCounts[action] ?? 0) + 1;
    const before = state.stage;

    let after: PreAuthStage;
    let cause: Cause;
    try {
      const result = applyAction(gate, state, action, rng);
      after = result.stage;
      cause = result.cause;
      if (result.probeMismatch !== undefined) {
        fail(
          'I5.gate-constant',
          step,
          action,
          before,
          after,
          result.probeMismatch,
        );
      }
    } catch (error) {
      fail(
        'I5.gate-constant',
        step,
        action,
        before,
        '<throw>',
        `gate threw: ${error instanceof Error ? error.message : String(error)}`,
      );
      after = before;
      cause = 'none';
    }
    state.stage = after;

    // I1 domain
    if (!STAGES.includes(after)) {
      fail(
        'I1.domain',
        step,
        action,
        before,
        String(after),
        'stage left the PreAuthStage domain',
      );
    }
    // I2 no-skip
    if (after === 'signin' && before !== 'signin') {
      if (cause !== 'finished' && cause !== 'link') {
        fail(
          'I2.no-skip',
          step,
          action,
          before,
          after,
          `reached signin via cause=${cause} (only finished/link may)`,
        );
      }
    }
    if (after === 'signin' && (cause === 'back' || cause === 'getStarted')) {
      fail(
        'I2.no-skip',
        step,
        action,
        before,
        after,
        `cause=${cause} landed on signin`,
      );
    }
    // I3 cta-onboarding
    if (cause === 'getStarted' && after !== 'onboarding') {
      fail(
        'I3.cta-onboarding',
        step,
        action,
        before,
        after,
        'getStarted did not yield onboarding',
      );
    }
    // I4 onboarding-exit
    if (before === 'onboarding' && after !== 'onboarding') {
      // `link` covers a stale Welcome "already have an account" handler: it
      // is the explicit returning-player route, not a gate transition, and is
      // counted separately (staleLinkFromOnboarding) rather than failed.
      const legal =
        (cause === 'back' && after === 'welcome') ||
        (cause === 'finished' && after === 'signin') ||
        (cause === 'link' && after === 'signin');
      if (cause === 'link') staleLinkFromOnboarding += 1;
      if (!legal) {
        fail(
          'I4.onboarding-exit',
          step,
          action,
          before,
          after,
          `left onboarding via cause=${cause} to ${after}`,
        );
      }
    }

    // I5 gate-constant + I6 + I7 (probe all three gate fns after every step)
    const g = safeCall(gate.stageAfterGetStarted);
    const f = safeCall(gate.stageAfterOnboarding);
    const l = safeCall(gate.stageWhenLeavingOnboarding);
    const outputs = {
      getStarted: g.value,
      finished: f.value,
      leaving: l.value,
    };
    for (const [name, probe] of [
      ['stageAfterGetStarted', g],
      ['stageAfterOnboarding', f],
      ['stageWhenLeavingOnboarding', l],
    ] as const) {
      if (probe.threw !== null) {
        fail(
          'I5.gate-constant',
          step,
          action,
          before,
          after,
          `${name} threw: ${probe.threw}`,
        );
      } else if (!STAGES.includes(probe.value as PreAuthStage)) {
        fail(
          'I5.gate-constant',
          step,
          action,
          before,
          after,
          `${name} returned ${probe.value} (not a PreAuthStage)`,
        );
      }
    }
    if (
      gate.stageAfterGetStarted.length !== 0 ||
      gate.stageAfterOnboarding.length !== 0 ||
      gate.stageWhenLeavingOnboarding.length !== 0
    ) {
      fail(
        'I5.gate-constant',
        step,
        action,
        before,
        after,
        'a gate fn declares parameters',
      );
    }
    if (firstOutputs === null) {
      firstOutputs = outputs;
    } else if (
      firstOutputs.getStarted !== outputs.getStarted ||
      firstOutputs.finished !== outputs.finished ||
      firstOutputs.leaving !== outputs.leaving
    ) {
      fail(
        'I5.gate-constant',
        step,
        action,
        before,
        after,
        `outputs drifted: first=${JSON.stringify(firstOutputs)} now=${JSON.stringify(outputs)}`,
      );
    }
    if (outputs.leaving === outputs.finished) {
      fail(
        'I6.leave-ne-finish',
        step,
        action,
        before,
        after,
        `leaving and finishing both yield ${outputs.finished}`,
      );
    }
    const key = historyKey(state.history);
    const serialized = `${outputs.getStarted}|${outputs.finished}|${outputs.leaving}`;
    const seen = outputsByHistory.get(key);
    if (seen === undefined) outputsByHistory.set(key, serialized);
    else if (seen !== serialized) {
      fail(
        'I7.history-blind',
        step,
        action,
        before,
        after,
        `history ${key}: ${seen} → ${serialized}`,
      );
    }
    for (const other of outputsByHistory.values()) {
      if (other !== serialized) {
        fail(
          'I7.history-blind',
          step,
          action,
          before,
          after,
          `outputs differ across histories: ${other} vs ${serialized}`,
        );
        break;
      }
    }

    // I8 render-total
    const screen = screenFor(after);
    const screens = new Set(STAGES.map(screenFor));
    if (screens.size !== STAGES.length) {
      fail(
        'I8.render-total',
        step,
        action,
        before,
        after,
        'render mapping is not injective',
      );
    }

    if (after === 'signin' && before !== 'signin') signinVisits += 1;
    if (after === 'onboarding' && before !== 'onboarding')
      onboardingVisits += 1;

    trace.push({
      step,
      action,
      before,
      after,
      screen,
      history: { ...state.history },
      gate: outputs,
    });
  }

  return {
    seed,
    length: actions.length,
    actions: [...actions],
    ok: failures.length === 0,
    failures,
    finalStage: state.stage,
    signinVisits,
    onboardingVisits,
    staleLinkFromOnboarding,
    actionCounts,
    traceHash: hashTrace(trace),
    trace,
  };
}

/** Generates the sequence for `seed` and runs it. */
export function runSeed(
  source: GateSource,
  seed: number,
  options: GeneratorOptions = DEFAULT_GENERATOR,
): SequenceResult {
  return runActions(source, seed, generateSequence(seed, options));
}

/** Greedy 1-minimal shrink: drop any single action whose removal keeps the
 * same invariant failing. Deterministic given the input. */
export function minimizeSequence(
  gate: GateSource,
  seed: number,
  actions: readonly Action[],
): { actions: Action[]; failures: Failure[] } {
  const initial = runActions(gate, seed, actions);
  if (initial.ok) return { actions: [...actions], failures: [] };
  const target = new Set(initial.failures.map(f => f.invariant));
  const stillFails = (candidate: readonly Action[]) => {
    const r = runActions(gate, seed, candidate);
    return !r.ok && r.failures.some(f => target.has(f.invariant));
  };
  let current = [...actions];
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < current.length; i += 1) {
      const candidate = [...current.slice(0, i), ...current.slice(i + 1)];
      if (candidate.length > 0 && stillFails(candidate)) {
        current = candidate;
        changed = true;
        i -= 1;
      }
    }
  }
  return {
    actions: current,
    failures: runActions(gate, seed, current).failures,
  };
}

/** Compact per-seed row for the results table. */
export function summarizeResult(result: SequenceResult): {
  seed: number;
  length: number;
  ok: boolean;
  finalStage: PreAuthStage;
  signinVisits: number;
  onboardingVisits: number;
  staleLinkFromOnboarding: number;
  traceHash: string;
  failures: Failure[];
} {
  return {
    seed: result.seed,
    length: result.length,
    ok: result.ok,
    finalStage: result.finalStage,
    signinVisits: result.signinVisits,
    onboardingVisits: result.onboardingVisits,
    staleLinkFromOnboarding: result.staleLinkFromOnboarding,
    traceHash: result.traceHash,
    failures: result.failures,
  };
}
