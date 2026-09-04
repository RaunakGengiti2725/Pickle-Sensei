import type { OwnerTag } from './fixtures';
import { int, makePrng, pick, weighted } from './prng';

/**
 * One lifecycle interruption. Every step is something the OS, the user, or
 * the account layer can do to a running app while StreakCalendarScreen may
 * be mounted with a refresh in flight.
 */
export type FaultScope = 'all' | 'shots';

export type Step =
  | { kind: 'open' } // Home → StreakCalendar (real navigation.navigate)
  | { kind: 'back' } // header Back → navigation.goBack()
  | { kind: 'background' } // AppState 'background'
  | { kind: 'foreground' } // AppState 'active' (bootstrap refresh)
  | { kind: 'kill_relaunch' } // process death, cold relaunch, re-hydrate
  | { kind: 'switch_owner'; to: Exclude<OwnerTag, 'signed-out'> }
  | { kind: 'sign_out' }
  | { kind: 'rotate_token' } // same account, new bearer
  // storage revoked / restored. scope 'all' rejects every statement (the
  // profile read too, so the gate shows its own error); 'shots' rejects only
  // the shot-table read the consistency engine depends on, which is the path
  // that surfaces StreakCalendarScreen's error card + "Try again".
  | { kind: 'storage_fault'; on: boolean; scope: FaultScope }
  | { kind: 'record_drill' } // store write mid-flight
  | { kind: 'rehydrate' } // extra hydrate() (idempotency)
  | { kind: 'tap_day' }
  | { kind: 'prev_month' }
  | { kind: 'next_month' }
  | { kind: 'try_again' }
  | { kind: 'clock_jump'; hours: number } // past midnight while mounted
  | { kind: 'wait'; ms: number };

export interface Scenario {
  seed: number;
  /** Fake-timer latency of every SQLite statement. */
  latencyMs: number;
  /** Account the device launches with. */
  initialOwner: Exclude<OwnerTag, 'signed-out'>;
  steps: Step[];
}

export const LATENCIES = [0, 5, 40, 250, 900] as const;
const OWNERS: readonly Exclude<OwnerTag, 'signed-out'>[] = [
  'alpha',
  'bravo',
  'guest',
];

export function generateScenario(seed: number): Scenario {
  const rng = makePrng(seed);
  const latencyMs = pick(rng, LATENCIES);
  const initialOwner = pick(rng, OWNERS);
  const count = int(rng, 8, 22);
  const steps: Step[] = [{ kind: 'open' }];
  let faulted = false;
  let faultScope: FaultScope = 'all';
  let backgrounded = false;
  for (let i = 0; i < count; i += 1) {
    const kind = weighted<Step['kind']>(rng, [
      ['open', 12],
      ['back', 9],
      ['background', 7],
      ['foreground', 7],
      ['kill_relaunch', 5],
      ['switch_owner', 8],
      ['sign_out', 3],
      ['rotate_token', 4],
      ['storage_fault', 4],
      ['record_drill', 4],
      ['rehydrate', 4],
      ['tap_day', 5],
      ['prev_month', 3],
      ['next_month', 3],
      ['try_again', 3],
      ['clock_jump', 2],
      ['wait', 14],
    ]);
    switch (kind) {
      case 'switch_owner':
        steps.push({ kind, to: pick(rng, OWNERS) });
        break;
      case 'storage_fault':
        faulted = !faulted;
        if (faulted) faultScope = pick(rng, ['all', 'shots', 'shots']);
        steps.push({ kind, on: faulted, scope: faultScope });
        break;
      case 'foreground':
        // AppState realism: a foreground follows a background.
        if (!backgrounded) steps.push({ kind: 'background' });
        backgrounded = false;
        steps.push({ kind });
        break;
      case 'background':
        backgrounded = true;
        steps.push({ kind });
        break;
      case 'clock_jump':
        steps.push({ kind, hours: pick(rng, [10, 25, 49]) });
        break;
      case 'wait':
        // Fixed gaps plus latency-relative ones so a wait can land before,
        // between and after the two statements of a refresh.
        steps.push({
          kind,
          ms: pick(rng, [
            1,
            10,
            60,
            300,
            1200,
            5000,
            Math.max(1, latencyMs >> 1),
            latencyMs + 1,
            latencyMs * 2 + 1,
          ]),
        });
        break;
      case 'kill_relaunch':
        backgrounded = false;
        steps.push({ kind });
        break;
      default:
        steps.push({ kind } as Step);
    }
  }
  if (faulted)
    steps.push({ kind: 'storage_fault', on: false, scope: faultScope });
  return { seed, latencyMs, initialOwner, steps };
}

export function describeStep(step: Step): string {
  switch (step.kind) {
    case 'switch_owner':
      return `switch_owner:${step.to}`;
    case 'storage_fault':
      return `storage_fault:${step.on ? 'on' : 'off'}:${step.scope}`;
    case 'clock_jump':
      return `clock_jump:+${step.hours}h`;
    case 'wait':
      return `wait:${step.ms}ms`;
    default:
      return step.kind;
  }
}

/**
 * Greedy one-at-a-time delta debugging: drop any step whose removal keeps
 * the scenario failing with the SAME invariant. Runs `stillFails` at most
 * O(steps²) times; scenarios are 9–24 steps long so this stays cheap.
 */
export async function minimizeSteps(
  scenario: Scenario,
  stillFails: (candidate: Scenario) => Promise<boolean>,
): Promise<Scenario> {
  let current = scenario;
  let progress = true;
  while (progress) {
    progress = false;
    for (let i = 0; i < current.steps.length; i += 1) {
      const candidate: Scenario = {
        ...current,
        steps: current.steps.filter((_, index) => index !== i),
      };
      if (candidate.steps.length === 0) continue;
      if (await stillFails(candidate)) {
        current = candidate;
        progress = true;
        break;
      }
    }
  }
  return current;
}
