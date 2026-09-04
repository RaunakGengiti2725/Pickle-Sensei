import { makePrng, pick } from '../../xc-harness/lifecycle-persistence/seeds';
import type { BearerPolicy, PutMode } from './server';

/**
 * Seeded lifecycle schedules for the OnboardingScreen stress suite. A
 * scenario is a pure function of its 32-bit seed: the install state, the
 * answers each account gives, the fault modes of the account API, and the
 * interruptions injected at specific points of the questionnaire.
 */

export type InstallMode =
  /** fresh device: Welcome → pre-auth questionnaire → sign-in → adoption */
  | 'preauth'
  /** persisted session for account A whose server profile is still pending */
  | 'account';

export interface Answers {
  name: string;
  gender: string;
  level: string;
  handedness: string;
  goal: string;
  problem: string;
  finish: 'enable' | 'not_now';
}

/** Interruptions fired BEFORE the driver's n-th UI action. */
export type LifecycleEventKind =
  | 'background-foreground'
  | 'remount'
  | 'kill-relaunch'
  | 'back'
  | 'token-rotation'
  | 'revoke-session'
  | 'account-switch'
  | 'permission-revoke-later';

export interface LifecycleEvent {
  beforeAction: number;
  kind: LifecycleEventKind;
  /** ms the app stays backgrounded (background-foreground only) */
  gapMs?: number;
}

/** Interruption fired shortly after the finish tap while the request is
 * still in flight. */
export type FinishInterrupt =
  | 'none'
  | 'unmount-remount'
  | 'kill-relaunch'
  | 'background-foreground'
  | 'account-switch'
  | 'revoke-session'
  | 'token-rotation';

export interface Scenario {
  seed: number;
  install: InstallMode;
  answersA: Answers;
  answersB: Answers;
  /** OS answer to the reminder permission prompt */
  permission: 'granted' | 'denied';
  latencyMs: number;
  putLatencyMs: number;
  putMode: PutMode;
  bearerPolicy: BearerPolicy;
  bearerTtlSec: number;
  events: LifecycleEvent[];
  finishInterrupt: FinishInterrupt;
  finishInterruptAfterMs: number;
  /** interruptions fired once the app has landed on the main navigator */
  postEvents: LifecycleEventKind[];
  /** fake-clock delay between two driver actions */
  humanDelayMs: number;
}

export const GENDER_VALUES = [
  'female',
  'male',
  'nonbinary',
  'prefer_not_to_say',
] as const;
export const LEVEL_VALUES = [
  'Beginner',
  '2.5',
  '3.0',
  '3.5',
  '4.0',
  '4.5',
  '5.0+',
] as const;
export const HANDEDNESS_VALUES = ['right', 'left'] as const;
export const GOAL_VALUES = [
  'dinks',
  'drives',
  'drops',
  'serve',
  'volleys',
  'footwork',
  'all-around',
] as const;
export const PROBLEM_VALUES = [
  'consistency',
  'control',
  'power',
  'contact',
  'footwork',
  'placement',
  'not sure',
] as const;

const NAMES_A = ['Dana', 'Pat', 'Morgan', 'Alex', 'Riley'] as const;
const NAMES_B = ['Bea', 'Casey', 'Jordan', 'Sam', 'Quinn'] as const;

function answers(rng: () => number, names: readonly string[]): Answers {
  return {
    name: pick(rng, names),
    gender: pick(rng, GENDER_VALUES),
    level: pick(rng, LEVEL_VALUES),
    handedness: pick(rng, HANDEDNESS_VALUES),
    goal: pick(rng, GOAL_VALUES),
    problem: pick(rng, PROBLEM_VALUES),
    finish: pick(rng, ['enable', 'not_now'] as const),
  };
}

function shifted<T>(values: readonly T[], current: T, by: number): T {
  const index = Math.max(0, values.indexOf(current));
  return values[(index + by) % values.length]!;
}

/**
 * The answers a player gives when they have to redo the questionnaire
 * (attempt 0 = the original answers). Every field differs from the previous
 * attempt, so a stale completion from an earlier walk that lands late is
 * visible in the persisted profile instead of being masked by equal values.
 * The name is kept: it identifies the account across attempts.
 */
export function reanswer(base: Answers, attempt: number): Answers {
  if (attempt <= 0) return base;
  return {
    name: base.name,
    gender: shifted(GENDER_VALUES, base.gender, attempt),
    level: shifted(LEVEL_VALUES, base.level, attempt),
    handedness: shifted(HANDEDNESS_VALUES, base.handedness, attempt),
    goal: shifted(GOAL_VALUES, base.goal, attempt),
    problem: shifted(PROBLEM_VALUES, base.problem, attempt),
    finish:
      attempt % 2 === 1
        ? base.finish === 'enable'
          ? 'not_now'
          : 'enable'
        : base.finish,
  };
}

/** Number of driver actions in one uninterrupted questionnaire walk:
 * name, 5 questions × (select + continue), reveal continue, finish. */
export const WALK_ACTIONS = 1 + 1 + 5 * 2 + 1 + 1;

const EVENT_KINDS: readonly LifecycleEventKind[] = [
  'background-foreground',
  'background-foreground',
  'remount',
  'kill-relaunch',
  'back',
  'token-rotation',
  'revoke-session',
  'account-switch',
];

const FINISH_INTERRUPTS: readonly FinishInterrupt[] = [
  'none',
  'none',
  'unmount-remount',
  'kill-relaunch',
  'background-foreground',
  'account-switch',
  'revoke-session',
  'token-rotation',
];

const PUT_MODES: readonly PutMode[] = [
  'ok',
  'ok',
  'ok',
  'fail-500-once',
  'fail-network-once',
  'hang-then-ok',
  'slow',
];

export function seededScenario(seed: number): Scenario {
  const rng = makePrng(seed);
  const install = pick(rng, ['preauth', 'account'] as const);
  const answersA = answers(rng, NAMES_A);
  const answersB = answers(rng, NAMES_B);
  const permission = pick(rng, ['granted', 'granted', 'denied'] as const);
  const latencyMs = pick(rng, [0, 20, 80, 250]);
  const putLatencyMs = pick(rng, [50, 200, 600, 1500]);
  const putMode = pick(rng, PUT_MODES);
  const bearerPolicy = pick(rng, [
    'until-expiry',
    'until-expiry',
    'invalidate-on-rotate',
  ] as const);
  const bearerTtlSec = pick(rng, [3600, 3600, 120]);
  const eventCount = 1 + Math.floor(rng() * 4);
  const events: LifecycleEvent[] = [];
  for (let i = 0; i < eventCount; i += 1) {
    const kind = pick(rng, EVENT_KINDS);
    if (install === 'preauth' && kind !== 'account-switch') {
      // pre-auth there is no session to rotate or revoke: the same slot
      // becomes a plain lifecycle interruption.
      const preAuthKind: LifecycleEventKind =
        kind === 'token-rotation' || kind === 'revoke-session'
          ? pick(rng, ['background-foreground', 'remount', 'kill-relaunch'])
          : kind;
      events.push({
        beforeAction: Math.floor(rng() * WALK_ACTIONS),
        kind: preAuthKind,
        ...(preAuthKind === 'background-foreground'
          ? { gapMs: pick(rng, [100, 2_000, 30_000, 10 * 60_000]) }
          : {}),
      });
      continue;
    }
    if (install === 'preauth' && kind === 'account-switch') {
      // pre-auth an account switch is meaningless before sign-in; sign in
      // happens after the walk, so skip it here (post events cover it).
      continue;
    }
    events.push({
      beforeAction: Math.floor(rng() * WALK_ACTIONS),
      kind,
      ...(kind === 'background-foreground'
        ? { gapMs: pick(rng, [100, 2_000, 30_000, 10 * 60_000]) }
        : {}),
    });
  }
  events.sort((a, b) => a.beforeAction - b.beforeAction);
  let finishInterrupt = pick(rng, FINISH_INTERRUPTS);
  if (
    install === 'preauth' &&
    (finishInterrupt === 'account-switch' ||
      finishInterrupt === 'revoke-session' ||
      finishInterrupt === 'token-rotation')
  ) {
    finishInterrupt = pick(rng, [
      'unmount-remount',
      'kill-relaunch',
      'background-foreground',
    ] as const);
  }
  const finishInterruptAfterMs = pick(rng, [10, 60, 150]);
  const postCount = Math.floor(rng() * 3);
  const postEvents: LifecycleEventKind[] = [];
  for (let i = 0; i < postCount; i += 1) {
    postEvents.push(
      pick(rng, [
        'permission-revoke-later',
        'background-foreground',
        'kill-relaunch',
        'account-switch',
        'token-rotation',
      ] as const),
    );
  }
  const humanDelayMs = pick(rng, [30, 120, 400]);
  return {
    seed,
    install,
    answersA,
    answersB,
    permission,
    latencyMs,
    putLatencyMs,
    putMode,
    bearerPolicy,
    bearerTtlSec,
    events,
    finishInterrupt,
    finishInterruptAfterMs,
    postEvents,
    humanDelayMs,
  };
}
