/**
 * Seeded lifecycle schedules for the HomeScreen stress campaign. Everything
 * here is a pure function of a 32-bit seed, so any row of the emitted result
 * table replays from its seed alone. The generator tracks a coarse model of
 * the app (mounted? who is signed in?) so it only emits steps that make sense
 * in context, while still interleaving them at arbitrary points inside
 * pending local-database and network work.
 */

import type { RouteMode } from './scriptedApi';

/** mulberry32 — tiny, deterministic, good enough for scenario sampling. */
export function makePrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: () => number, items: readonly T[]): T {
  const index = Math.floor(rng() * items.length);
  return items[Math.min(index, items.length - 1)] as T;
}

function weighted<T extends string>(
  rng: () => number,
  table: Record<T, number>,
): T {
  const entries = Object.entries(table) as [T, number][];
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rng() * total;
  for (const [key, weight] of entries) {
    roll -= weight;
    if (roll <= 0) return key;
  }
  return entries[entries.length - 1]![0];
}

function intBetween(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export type AccountKey = 'A' | 'B';

export type StartState =
  | 'persisted-A'
  | 'persisted-A-slow-refresh'
  | 'persisted-A-hung-refresh'
  | 'guest'
  | 'signed-out';

export interface StressWorld {
  start: StartState;
  /** ms per statement kind; `shotsHold` holds the FIRST local_shot read of
   * each process until a `releaseDb` step (or the final settle). */
  dbLatency: { kvGet: number; kvSet: number; shots: number };
  shotsHold: boolean;
  progressMode: RouteMode;
  rankMode: RouteMode;
  apiLatencyMs: number;
  /** short TTLs make the session keeper rotate during the schedule */
  bearerTtlSec: number;
  shotsA: number;
  shotsB: number;
  shotsGuest: number;
}

export type StressStep =
  | { kind: 'advance'; ms: number }
  /** advance in slices until the gate/Home stop loading, or `maxMs` elapse */
  | { kind: 'settle'; maxMs: number }
  | { kind: 'background' }
  | { kind: 'foreground' }
  | { kind: 'tab'; tab: 'Library' | 'Progress' | 'Settings' | 'Home' }
  | { kind: 'pushStreak' }
  | { kind: 'back' }
  | { kind: 'pullRefresh' }
  | { kind: 'kill' }
  | { kind: 'relaunch' }
  | { kind: 'rotateNow' }
  | { kind: 'serverRevoke' }
  | { kind: 'signOut' }
  | { kind: 'signIn'; account: AccountKey }
  | { kind: 'switchAccount'; to: AccountKey }
  | { kind: 'permission'; state: 'denied' | 'granted' }
  | { kind: 'releaseDb' }
  | { kind: 'dbFault'; on: boolean }
  | { kind: 'pressRetry' };

export interface StressSchedule {
  seed: number;
  world: StressWorld;
  steps: StressStep[];
}

const DB_LATENCIES = [0, 0, 5, 30, 120, 400, 900] as const;
const API_LATENCIES = [5, 20, 60, 250, 800] as const;
const TTLS = [3_600, 3_600, 120, 75, 61] as const;

export function generateSchedule(seed: number): StressSchedule {
  const rng = makePrng(seed);
  const start = weighted<StartState>(rng, {
    'persisted-A': 6,
    'persisted-A-slow-refresh': 2,
    'persisted-A-hung-refresh': 1,
    guest: 2,
    'signed-out': 2,
  });
  const world: StressWorld = {
    start,
    dbLatency: {
      kvGet: pick(rng, DB_LATENCIES),
      kvSet: pick(rng, DB_LATENCIES),
      shots: pick(rng, DB_LATENCIES),
    },
    shotsHold: rng() < 0.3,
    progressMode: weighted<RouteMode>(rng, {
      ok: 6,
      slow: 2,
      hang: 1,
      'error-500': 1,
      network: 1,
      'malformed-200': 1,
    }),
    rankMode: weighted<RouteMode>(rng, {
      ok: 6,
      slow: 2,
      hang: 1,
      'error-500': 1,
      network: 1,
      'malformed-200': 1,
    }),
    apiLatencyMs: pick(rng, API_LATENCIES),
    bearerTtlSec: pick(rng, TTLS),
    shotsA: intBetween(rng, 0, 7),
    shotsB: intBetween(rng, 1, 6),
    shotsGuest: intBetween(rng, 0, 4),
  };

  // Coarse model used only to keep the schedule meaningful.
  let mounted = true;
  let signedIn: AccountKey | 'guest' | null =
    start === 'guest' ? 'guest' : start === 'signed-out' ? null : 'A';
  let background = false;
  let pushed = false;
  let onHome = true;
  let faulted = false;
  let held = world.shotsHold;

  const steps: StressStep[] = [];
  const settle = () =>
    steps.push({ kind: 'settle', maxMs: pick(rng, [2_000, 9_000, 12_000]) });
  // Most seeds reach a steady Home before the interruptions start; the rest
  // interrupt the very first launch.
  if (rng() < 0.7) settle();
  const count = intBetween(rng, 8, 18);
  for (let i = 0; i < count; i += 1) {
    if (!mounted) {
      // A killed process either relaunches now or after a pause.
      if (rng() < 0.5)
        steps.push({ kind: 'advance', ms: intBetween(rng, 0, 30_000) });
      steps.push({ kind: 'relaunch' });
      mounted = true;
      background = false;
      pushed = false;
      onHome = true;
      held = world.shotsHold;
      if (rng() < 0.6) settle();
      continue;
    }
    const table: Record<StressStep['kind'], number> = {
      advance: 6,
      settle: 3,
      background: background ? 0 : 3,
      foreground: background ? 6 : 0,
      tab: signedIn ? 3 : 0,
      pushStreak: signedIn && onHome && !pushed ? 2 : 0,
      back: pushed ? 4 : 0,
      pullRefresh: signedIn && onHome && !pushed ? 2 : 0,
      kill: 3,
      relaunch: 0,
      rotateNow: signedIn === 'A' || signedIn === 'B' ? 2 : 0,
      serverRevoke: signedIn === 'A' || signedIn === 'B' ? 1 : 0,
      signOut: signedIn ? 2 : 0,
      signIn: signedIn ? 0 : 5,
      switchAccount: signedIn === 'A' || signedIn === 'B' ? 2 : 0,
      permission: 2,
      releaseDb: held ? 3 : 0,
      dbFault: 1,
      pressRetry: faulted ? 2 : 0,
    };
    const kind = weighted(rng, table);
    // A user taps only what is on screen: most interactions wait for the
    // current load to finish first, some deliberately land mid-load.
    const interaction =
      kind === 'tab' ||
      kind === 'pushStreak' ||
      kind === 'pullRefresh' ||
      kind === 'signOut' ||
      kind === 'signIn' ||
      kind === 'switchAccount' ||
      kind === 'pressRetry';
    if (interaction && rng() < 0.7) settle();
    switch (kind) {
      case 'advance':
        steps.push({
          kind,
          ms: pick(
            rng,
            [0, 1, 10, 50, 150, 400, 1_000, 3_000, 9_000, 20_000, 70_000],
          ),
        });
        break;
      case 'settle':
        settle();
        break;
      case 'background':
        steps.push({ kind });
        background = true;
        break;
      case 'foreground':
        steps.push({ kind });
        background = false;
        break;
      case 'tab': {
        const tab: 'Library' | 'Progress' | 'Settings' | 'Home' = onHome
          ? pick(rng, ['Library', 'Progress', 'Settings'] as const)
          : 'Home';
        steps.push({ kind, tab });
        onHome = tab === 'Home';
        break;
      }
      case 'pushStreak':
        steps.push({ kind });
        pushed = true;
        break;
      case 'back':
        steps.push({ kind });
        pushed = false;
        break;
      case 'pullRefresh':
        steps.push({ kind });
        break;
      case 'kill':
        steps.push({ kind });
        mounted = false;
        break;
      case 'rotateNow':
      case 'serverRevoke':
        steps.push({ kind });
        if (kind === 'serverRevoke') {
          // The next keeper refresh lands the ONE implicit sign-out; the
          // model only knows the account is doomed, not when.
        }
        break;
      case 'signOut':
        steps.push({ kind });
        signedIn = null;
        pushed = false;
        onHome = true;
        break;
      case 'signIn': {
        const account = pick(rng, ['A', 'B'] as const);
        steps.push({ kind, account });
        signedIn = account;
        onHome = true;
        if (rng() < 0.6) settle();
        break;
      }
      case 'switchAccount': {
        const to: AccountKey = signedIn === 'A' ? 'B' : 'A';
        steps.push({ kind, to });
        signedIn = to;
        pushed = false;
        onHome = true;
        if (rng() < 0.6) settle();
        break;
      }
      case 'permission':
        steps.push({ kind, state: rng() < 0.6 ? 'denied' : 'granted' });
        break;
      case 'releaseDb':
        steps.push({ kind });
        held = false;
        break;
      case 'dbFault':
        faulted = !faulted;
        steps.push({ kind, on: faulted });
        break;
      case 'pressRetry':
        steps.push({ kind });
        break;
      case 'relaunch':
        break;
    }
  }
  if (!mounted) steps.push({ kind: 'relaunch' });
  if (faulted)
    steps.push({ kind: 'dbFault', on: false }, { kind: 'pressRetry' });
  return { seed, world, steps };
}

export function describeStep(step: StressStep): string {
  switch (step.kind) {
    case 'advance':
      return `advance(${step.ms}ms)`;
    case 'settle':
      return `settle(${step.maxMs}ms)`;
    case 'tab':
      return `tab(${step.tab})`;
    case 'signIn':
      return `signIn(${step.account})`;
    case 'switchAccount':
      return `switchAccount(${step.to})`;
    case 'permission':
      return `permission(${step.state})`;
    case 'dbFault':
      return `dbFault(${step.on ? 'on' : 'off'})`;
    default:
      return step.kind;
  }
}
