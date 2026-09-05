/**
 * Seeded lifecycle schedules for the ManageAccountScreen stress harness.
 *
 * A scenario is a pure function of its seed (mulberry32), so any row in the
 * results table is replayable with `STRESS_SEED=<seed>`. The schedule decides
 * how the user walks the deletion survey, how the scripted server answers
 * the two deletion calls, how long the bearer lives (which decides whether
 * the session keeper rotates it mid-flow) and which lifecycle interruptions
 * land in which phase of the dialog.
 */
import {
  makePrng,
  pick,
} from '../../../xc-harness/lifecycle-persistence/seeds';

export type FaultMode =
  | 'ok'
  | '401'
  | '429'
  | '500'
  | 'network'
  | 'hang'
  | 'malformed'
  | 'not-deleted';

export type SurveyPath = 'skip-all' | 'q1-only' | 'q1-q2' | 'q1-comment';

/** Where in the deletion dialog an interruption lands. */
export type Phase = 'review' | 'requesting' | 'armed' | 'deleting' | 'after';

export type EventKind =
  /** AppState background → foreground (keeper re-checks expiry). */
  | 'bg-fg'
  /** "Keep my account" — only possible while the dialog is not busy. */
  | 'cancel'
  /** Navigation pops the screen (e.g. reminder routing) — unmounts mid-request. */
  | 'back'
  /** The whole tree unmounts and remounts (Gate-level re-render). */
  | 'remount-tree'
  /** Bearer rotation forced through the keeper mid-request. */
  | 'rotate'
  /** Server revokes the account's tokens; the app learns on next refresh. */
  | 'revoke'
  /** Process death: every in-memory singleton gone, Keychain + SQLite survive. */
  | 'kill-relaunch'
  /** Sign out (if signed in) and sign in as a different account. */
  | 'account-switch'
  /** A second concurrent hydrate() — must be idempotent. */
  | 'double-hydrate'
  /** Nothing but time passing (lets the keeper's own timers fire). */
  | 'wait';

export interface LifecycleEvent {
  phase: Phase;
  /** Offset into the phase, in fake-clock milliseconds. */
  atMs: number;
  kind: EventKind;
}

export interface RouteScript {
  mode: FaultMode;
  latencyMs: number;
  /** When a fault is scripted: does the NEXT call succeed (transient) or
   * does the fault persist for the scenario? */
  recover: boolean;
}

export interface Scenario {
  seed: number;
  provider: 'apple' | 'google';
  survey: SurveyPath;
  /** Server-issued bearer lifetime. 90s makes the keeper rotate inside the
   * flow; 300s makes a foreground re-check rotate; 3600s never rotates. */
  bearerTtlSec: 90 | 300 | 3600;
  refreshLatencyMs: number;
  request: RouteScript;
  confirm: RouteScript;
  appleRevocation: 'revoked' | 'not_applicable' | 'manual_action_required';
  /** Local SQLite purge fails after the server deleted the account. */
  purgeFails: boolean;
  /** Extra dwell in the armed phase before pressing the final button. */
  armedDwellMs: number;
  events: LifecycleEvent[];
}

const PHASE_EVENTS: Record<Phase, readonly EventKind[]> = {
  review: [
    'bg-fg',
    'back',
    'remount-tree',
    'rotate',
    'kill-relaunch',
    'cancel',
    'double-hydrate',
    'wait',
  ],
  requesting: [
    'bg-fg',
    'cancel',
    'back',
    'remount-tree',
    'rotate',
    'revoke',
    'kill-relaunch',
  ],
  armed: [
    'bg-fg',
    'cancel',
    'back',
    'remount-tree',
    'rotate',
    'revoke',
    'kill-relaunch',
    'wait',
  ],
  deleting: [
    'bg-fg',
    'cancel',
    'back',
    'remount-tree',
    'rotate',
    'revoke',
    'kill-relaunch',
  ],
  after: ['kill-relaunch', 'account-switch', 'double-hydrate', 'bg-fg'],
};

const PHASE_SPAN_MS: Record<Phase, number> = {
  review: 2_000,
  requesting: 3_000,
  armed: 6_000,
  deleting: 3_000,
  after: 2_000,
};

const FAULTS: readonly FaultMode[] = [
  'ok',
  'ok',
  'ok',
  'ok',
  '401',
  '429',
  '500',
  'network',
  'hang',
  'malformed',
];

function routeScript(
  rng: () => number,
  faults: readonly FaultMode[],
): RouteScript {
  const mode = pick(rng, faults);
  const latencyMs =
    mode === 'hang' ? 0 : Math.floor(rng() * 3_000) + (rng() < 0.3 ? 0 : 50);
  return { mode, latencyMs, recover: rng() < 0.7 };
}

export function scenarioFromSeed(seed: number): Scenario {
  const rng = makePrng(seed);
  const survey = pick(rng, [
    'skip-all',
    'q1-only',
    'q1-q2',
    'q1-comment',
  ] as const);
  const bearerTtlSec = pick(rng, [90, 300, 3600, 3600] as const);
  const request = routeScript(rng, FAULTS);
  const confirm = routeScript(rng, [...FAULTS, 'not-deleted']);
  const eventCount = 1 + Math.floor(rng() * 4);
  const events: LifecycleEvent[] = [];
  for (let i = 0; i < eventCount; i += 1) {
    const phase = pick(rng, [
      'review',
      'requesting',
      'requesting',
      'armed',
      'armed',
      'deleting',
      'deleting',
      'after',
      'after',
    ] as const);
    const kind = pick(rng, PHASE_EVENTS[phase]);
    const atMs = Math.floor(rng() * PHASE_SPAN_MS[phase]);
    events.push({ phase, atMs, kind });
  }
  const order: Phase[] = ['review', 'requesting', 'armed', 'deleting', 'after'];
  events.sort(
    (a, b) =>
      order.indexOf(a.phase) - order.indexOf(b.phase) || a.atMs - b.atMs,
  );
  return {
    seed,
    provider: rng() < 0.8 ? 'apple' : 'google',
    survey,
    bearerTtlSec,
    refreshLatencyMs: Math.floor(rng() * 800),
    request,
    confirm,
    appleRevocation: pick(rng, [
      'revoked',
      'revoked',
      'not_applicable',
      'manual_action_required',
    ] as const),
    purgeFails: rng() < 0.15,
    armedDwellMs: rng() < 0.25 ? Math.floor(rng() * 40_000) : 0,
    events,
  };
}

export function describeScenario(scenario: Scenario): string {
  const events = scenario.events
    .map(e => `${e.phase}@${e.atMs}:${e.kind}`)
    .join(',');
  return (
    `seed=${scenario.seed} ${scenario.provider} ${scenario.survey} ttl=${scenario.bearerTtlSec}s ` +
    `req=${scenario.request.mode}/${scenario.request.latencyMs}ms${scenario.request.recover ? '+' : '!'} ` +
    `confirm=${scenario.confirm.mode}/${scenario.confirm.latencyMs}ms${scenario.confirm.recover ? '+' : '!'} ` +
    `purgeFails=${scenario.purgeFails} dwell=${scenario.armedDwellMs} [${events}]`
  );
}
