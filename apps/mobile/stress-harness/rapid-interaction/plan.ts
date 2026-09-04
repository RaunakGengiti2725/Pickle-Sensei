/**
 * Seeded burst planner for the SignInScreen rapid-interaction stress lens.
 *
 * A burst is a short, adversarial interaction script against the sign-in
 * surface: double/triple taps delivered in the SAME tick (before React can
 * re-render the disabled state), simultaneous provider + Back presses, taps
 * while a provider/bootstrap request is in flight, Back during async work,
 * and navigation spam (leave / re-enter the screen). Everything below is a
 * pure function of a 32-bit seed, so any row of the emitted JSON table is
 * replayable from its seed alone.
 */
import { makePrng, pick } from '../../xc-harness/lifecycle-persistence/seeds';

export type Target = 'apple' | 'google' | 'back' | 'dismiss' | 'enter';

export type ProviderOutcome =
  'success' | 'cancel' | 'fail' | 'missing-module' | 'play-services';

export type BootstrapOutcome =
  'ok-session' | 'ok-no-session' | 'malformed' | '401' | '500' | 'network';

export type Op =
  /** `times` presses of one control inside ONE act() tick (double/triple tap). */
  | { kind: 'tap'; target: Target; times: 1 | 2 | 3 }
  /** Every listed control pressed once, all in ONE act() tick. */
  | { kind: 'simul'; targets: Target[] }
  /** Settle the oldest pending provider call with its planned outcome. */
  | { kind: 'resolve-provider' }
  /** Settle the oldest pending bootstrap request with its planned outcome. */
  | { kind: 'resolve-bootstrap' }
  /** Advance the fake clock (drains timers + microtasks). */
  | { kind: 'advance'; ms: number }
  /** Rapid leave/re-enter of the screen, alternating back/enter. */
  | { kind: 'spam-nav'; times: number };

export interface BurstPlan {
  seed: number;
  /** Consumed in order by successive provider calls; cycles when exhausted. */
  providerOutcomes: ProviderOutcome[];
  /** Consumed in order by successive bootstrap requests; cycles. */
  bootstrapOutcomes: BootstrapOutcome[];
  /**
   * `deferred`: provider/bootstrap promises stay pending until an explicit
   * resolve op (or the terminal drain), so taps land mid-flight.
   * `immediate`: they settle on the next microtask.
   */
  latency: 'deferred' | 'immediate';
  /** Whether the canonical account already has a coaching profile stored. */
  profiled: boolean;
  ops: Op[];
}

const TARGETS: readonly Target[] = [
  'apple',
  'google',
  'back',
  'dismiss',
  'enter',
];
const PROVIDER_OUTCOMES: readonly ProviderOutcome[] = [
  'success',
  'success',
  'success',
  'cancel',
  'fail',
  'missing-module',
  'play-services',
];
const BOOTSTRAP_OUTCOMES: readonly BootstrapOutcome[] = [
  'ok-session',
  'ok-session',
  'ok-session',
  'ok-no-session',
  'malformed',
  '401',
  '500',
  'network',
];

function planOp(rng: () => number): Op {
  const roll = rng();
  if (roll < 0.22) {
    return {
      kind: 'tap',
      target: pick(rng, ['apple', 'google', 'apple', 'google', 'back']),
      times: pick(rng, [1, 2, 3, 2, 3]),
    };
  }
  if (roll < 0.34) {
    return { kind: 'tap', target: pick(rng, TARGETS), times: 1 };
  }
  if (roll < 0.48) {
    const count = pick(rng, [2, 2, 3]);
    const targets: Target[] = [];
    for (let i = 0; i < count; i += 1) {
      targets.push(pick(rng, ['apple', 'google', 'back', 'dismiss', 'enter']));
    }
    return { kind: 'simul', targets };
  }
  if (roll < 0.62) return { kind: 'resolve-provider' };
  if (roll < 0.74) return { kind: 'resolve-bootstrap' };
  if (roll < 0.9) {
    return {
      kind: 'advance',
      ms: pick(rng, [0, 0, 16, 50, 250, 1_000, 5_000]),
    };
  }
  return { kind: 'spam-nav', times: pick(rng, [2, 3, 4, 6]) };
}

export function planBurst(seed: number): BurstPlan {
  const rng = makePrng(seed);
  const opCount = 4 + Math.floor(rng() * 9); // 4..12
  const ops: Op[] = [];
  // Every burst opens with a provider intent so the single-request invariant
  // is always exercised at least once.
  ops.push({
    kind: 'tap',
    target: pick(rng, ['apple', 'google']),
    times: pick(rng, [1, 2, 3]),
  });
  for (let i = 1; i < opCount; i += 1) ops.push(planOp(rng));

  const providerOutcomes: ProviderOutcome[] = [];
  const providerCount = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < providerCount; i += 1) {
    providerOutcomes.push(pick(rng, PROVIDER_OUTCOMES));
  }
  const bootstrapOutcomes: BootstrapOutcome[] = [];
  const bootstrapCount = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < bootstrapCount; i += 1) {
    bootstrapOutcomes.push(pick(rng, BOOTSTRAP_OUTCOMES));
  }

  return {
    seed,
    providerOutcomes,
    bootstrapOutcomes,
    latency: rng() < 0.7 ? 'deferred' : 'immediate',
    profiled: rng() < 0.5,
    ops,
  };
}

/** Compact, greppable rendering of a plan for the JSON table / failure text. */
export function describePlan(plan: BurstPlan): string {
  const ops = plan.ops
    .map(op => {
      switch (op.kind) {
        case 'tap':
          return `${op.target}x${op.times}`;
        case 'simul':
          return `[${op.targets.join('+')}]`;
        case 'resolve-provider':
          return 'rp';
        case 'resolve-bootstrap':
          return 'rb';
        case 'advance':
          return `t+${op.ms}`;
        case 'spam-nav':
          return `nav*${op.times}`;
      }
    })
    .join(' ');
  return `seed=${plan.seed} lat=${plan.latency} prof=${plan.profiled} prov=${plan.providerOutcomes.join(',')} boot=${plan.bootstrapOutcomes.join(',')} ops: ${ops}`;
}

/** Seeds for a campaign: STRESS_SEED_FILTER replays exactly one seed. */
export function campaignSeeds(env: {
  STRESS_ITER?: string;
  STRESS_SEED_BASE?: string;
  STRESS_SEED_FILTER?: string;
}): number[] {
  if (env.STRESS_SEED_FILTER) {
    return env.STRESS_SEED_FILTER.split(',').map(value => Number(value) >>> 0);
  }
  const iterations = Math.max(1, Number(env.STRESS_ITER ?? 12) || 12);
  const base = Number(env.STRESS_SEED_BASE ?? 1_000) >>> 0;
  const seeds: number[] = [];
  for (let i = 0; i < iterations; i += 1) seeds.push((base + i) >>> 0);
  return seeds;
}
