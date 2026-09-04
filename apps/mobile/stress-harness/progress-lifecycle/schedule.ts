import { makePrng } from './prng';

/**
 * Seeded lifecycle schedule for one ProgressScreen stress iteration.
 *
 * A schedule is a fixed environment (latency/fault policies, initial data)
 * plus an ordered list of interruptions. Everything is derived from the seed,
 * so `STRESS_SEED=<seed>` replays the identical interleaving.
 */

export type StepKind =
  /** let the fake clock run for `ms` */
  | 'settle'
  /** AppState → background */
  | 'background'
  /** AppState → active (a background is inserted first when needed) */
  | 'foreground'
  /** press another bottom tab (ProgressScreen loses focus) */
  | 'tab-away'
  /** press the Progress tab again */
  | 'tab-back'
  /** unmount the tree, drop every in-memory singleton, remount, re-hydrate */
  | 'kill-relaunch'
  /** sign out and sign in as the OTHER account */
  | 'switch-account'
  /** server revokes every session of the current account */
  | 'revoke-server'
  /** rotate the bearer right now (what an API 401 triggers) */
  | 'rotate-token'
  /** the NEXT local_shot read of the current owner fails with SQLITE_IOERR */
  | 'db-fault-next'
  /** press "Try again" on the error state if it is showing */
  | 'retry'
  /** a new scored fact for the current owner lands in SQLite */
  | 'add-fact'
  /** signal_owner API answers 500 for the next progress fetch */
  | 'api-500-next'
  /** signal_owner API loses the network for the next progress fetch */
  | 'api-network-next';

export interface Step {
  kind: StepKind;
  /** fake ms to advance immediately after the action (0..maxSettleMs) */
  thenMs: number;
}

export interface Schedule {
  seed: number;
  /** ms a `/v1/progress` request stays in flight */
  progressLatencyMs: number;
  /** ms an owner-scoped `local_shot` read stays in flight */
  dbLatencyMs: number;
  /** ms every other API route stays in flight */
  apiLatencyMs: number;
  /** ms a `local_capture` read stays in flight */
  captureLatencyMs: number;
  /** scored facts seeded for account A / B before launch */
  factsA: number;
  factsB: number;
  /** account signed in first */
  firstAccount: 'a' | 'b';
  steps: Step[];
}

const STEP_MENU: readonly StepKind[] = [
  'settle',
  'settle',
  'background',
  'foreground',
  'tab-away',
  'tab-back',
  'tab-back',
  'kill-relaunch',
  'switch-account',
  'revoke-server',
  'rotate-token',
  'db-fault-next',
  'retry',
  'add-fact',
  'api-500-next',
  'api-network-next',
];

const LATENCIES = [0, 10, 60, 250, 900, 2_500, 6_000] as const;

const STEP_KINDS = new Set<string>(STEP_MENU);

/** Minimisation aid: `STRESS_STEPS="rotate-token+77,kill-relaunch+50"`
 * replaces the seed's step list (latencies/facts still come from the seed).
 * Formatted exactly like the schedule line printed on failure. */
export function parseSteps(spec: string): Step[] {
  return spec
    .split(/[,›]/)
    .map(part => part.trim())
    .filter(part => part.length > 0)
    .map(part => {
      const match = /^([a-z0-9-]+)\+(\d+)$/.exec(part);
      if (!match || !STEP_KINDS.has(match[1]!)) {
        throw new Error(`STRESS_STEPS: cannot parse step "${part}"`);
      }
      return { kind: match[1] as StepKind, thenMs: Number(match[2]) };
    });
}

export function buildSchedule(seed: number): Schedule {
  const rng = makePrng(seed);
  const stepCount = rng.int(5, 12);
  const steps: Step[] = [];
  for (let i = 0; i < stepCount; i += 1) {
    const kind = rng.pick(STEP_MENU);
    if (kind === 'foreground' && steps.at(-1)?.kind !== 'background') {
      steps.push({ kind: 'background', thenMs: rng.int(0, 400) });
    }
    // Short settles interleave the action with in-flight work; long ones let
    // it land. Both are needed to hit stale-response windows.
    const thenMs = rng.chance(0.5) ? rng.int(0, 120) : rng.int(120, 4_000);
    steps.push({ kind, thenMs });
  }
  return {
    seed,
    progressLatencyMs: rng.pick(LATENCIES),
    dbLatencyMs: rng.pick(LATENCIES),
    apiLatencyMs: rng.pick([0, 10, 60, 250]),
    captureLatencyMs: rng.pick([0, 10, 60, 250, 900]),
    factsA: rng.int(1, 6),
    factsB: rng.int(0, 4),
    firstAccount: rng.chance(0.75) ? 'a' : 'b',
    steps,
  };
}
