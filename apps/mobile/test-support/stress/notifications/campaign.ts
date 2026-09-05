import type { NotificationPlanContext } from '../../../src/notifications/plan';
import {
  NOTIFICATION_ID_PREFIX,
  type PlannedNotification,
} from '../../../src/notifications/types';
import {
  DEPENDENCY_TIMEOUT_MS,
  runFault,
  type FaultJournal,
  type FaultMode,
} from './faults';
import type { SeededRng } from './seededRng';

/**
 * Campaign plumbing shared by the notification stress suites: iteration
 * budget (STRESS_ITER), single-seed replay (STRESS_ONLY), JSON result
 * tables (STRESS_OUT), a fault-injected context loader and the plan
 * sanity check every applied plan must pass.
 */

// Node built-ins for the raw artifacts. The mobile tsconfig excludes node
// typings (see __tests__/matrix/networkAuthMatrix.test.ts), so the shims
// stay local.
declare const require: (id: string) => unknown;
declare const process: { env: Record<string, string | undefined> };
declare const __dirname: string;
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { join, resolve } = require('path') as {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
};

export const DEFAULT_ITERATIONS = 48;
/** Fake-time budget after which an unsettled action counts as a hang. */
export const NO_SPINNER_BUDGET_MS = 60_000;
/**
 * A store action awaits at most four dependencies in sequence (two kv reads,
 * a permission read, a schedule reconcile) and each may legitimately take
 * DEPENDENCY_TIMEOUT_MS before it rejects. When nothing is `never`, an
 * action that is still pending at 60 s is granted this dependency-bound
 * extension before it counts as an infinite spinner.
 */
export const CHAINED_DEPENDENCY_BUDGET_MS =
  NO_SPINNER_BUDGET_MS + 4 * DEPENDENCY_TIMEOUT_MS;

export function iterationBudget(
  defaultIterations = DEFAULT_ITERATIONS,
): number {
  const raw = process.env.STRESS_ITER;
  if (raw === undefined || raw === '') return defaultIterations;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`STRESS_ITER must be a positive integer, got ${raw}`);
  }
  return parsed;
}

/** Seeds for this run: STRESS_ONLY=<seed> replays one, else 1..budget. */
export function campaignSeeds(
  defaultIterations = DEFAULT_ITERATIONS,
): number[] {
  const only = process.env.STRESS_ONLY;
  if (only !== undefined && only !== '') {
    const seeds = only.split(',').map(Number);
    if (seeds.some(seed => !Number.isInteger(seed) || seed < 0)) {
      throw new Error(`STRESS_ONLY must be comma-separated seeds, got ${only}`);
    }
    return seeds;
  }
  const budget = iterationBudget(defaultIterations);
  return Array.from({ length: budget }, (_, index) => index + 1);
}

export function replayCommand(suite: string, seed: number): string {
  return `cd apps/mobile && STRESS_ONLY=${seed} npx jest --ci --silent ${suite}`;
}

export function outputDir(): string {
  const configured = process.env.STRESS_OUT;
  if (configured) return resolve(configured);
  // apps/mobile/artifacts/stress/notifications (gitignored via artifacts/).
  return resolve(
    __dirname,
    '..',
    '..',
    '..',
    'artifacts',
    'stress',
    'notifications',
  );
}

export function writeResultTable(fileName: string, table: unknown): string {
  const dir = outputDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, fileName);
  writeFileSync(path, JSON.stringify(table, null, 2));
  return path;
}

export interface Violation {
  invariant: string;
  step: number;
  action: string;
  detail: string;
}

export type Outcome = 'HELD' | 'BROKEN' | 'HUNG';

/**
 * Product defects the campaigns reproduce on the current code. Each entry
 * is pinned by a minimized `it.failing` repro in
 * `__tests__/stress/notificationFailureInjectionRepros.stress.test.ts`;
 * when a fix lands that repro starts passing (so Jest fails it) and the
 * entry here must be removed, at which point the campaigns enforce the
 * invariant again. Violations matching an entry keep the row BROKEN in the
 * JSON table but do not fail the campaign; anything else does.
 */
export interface KnownFinding {
  id: string;
  invariant: string;
  detail: RegExp;
  /** Restricts the match to violations raised by these actions. */
  action?: RegExp;
  summary: string;
}

export const KNOWN_FINDINGS: readonly KnownFinding[] = [
  {
    id: 'NF-1',
    invariant: 'memory-disk-coherent',
    detail: /persistFailed=false/,
    summary:
      'notificationStore.hydrate swallows a kv read failure into DEFAULT prefs ' +
      'with no flag: the OS schedule is cancelled and the next setPrefs ' +
      'overwrites the saved preferences (notificationStore.ts:183-187).',
  },
  {
    id: 'NF-1',
    invariant: 'persist-flag-truthful',
    action: /^hydrate$/,
    detail: /did not land but persistFailed=false/,
    summary:
      'Same catch-all: when hydrate applies a pending onboarding choice and ' +
      'that persistPrefs write fails, the store reports defaults with ' +
      'persistFailed=false (notificationStore.ts:169-187).',
  },
  {
    id: 'NF-2',
    invariant: 'schedule-flag-truthful',
    detail: /owner=signed-out/,
    summary:
      'Signed-out hydrate ignores a failed cancelAllPlanned and reports ' +
      'scheduleFailed=false (notificationStore.ts:148-157).',
  },
  {
    id: 'NF-3',
    invariant: 'no-fake-permission',
    detail: /malformed native authorizationStatus/,
    summary:
      'toPermissionState maps every non -1/0 value (NaN, undefined, strings, ' +
      'out-of-range) to granted (service.ts:46-51).',
  },
  {
    id: 'NF-4',
    invariant: 'press-routing',
    detail: /foreground press handler threw/,
    summary:
      'The foreground PRESS listener reads event.detail.notification without ' +
      'a detail guard (service.ts:172-176).',
  },
  {
    id: 'NF-5',
    invariant: 'no-infinite-spinner',
    detail: /still busy after 60 s/,
    summary:
      'A requestPermission promise that never settles leaves the priming card ' +
      '("Asking…", Not now disabled) and the settings "Turn on reminders" ' +
      'button busy for the rest of the process (NotificationPrimingCard.tsx, ' +
      'NotificationSettingsScreen.tsx turnOnReminders).',
  },
  {
    id: 'NF-5',
    invariant: 'recovered',
    detail: /controls still busy after recovery/,
    summary: 'Consequence of NF-5: the stuck control never recovers.',
  },
];

export function knownFindingFor(violation: Violation): KnownFinding | null {
  return (
    KNOWN_FINDINGS.find(
      finding =>
        finding.invariant === violation.invariant &&
        finding.detail.test(violation.detail) &&
        (finding.action === undefined || finding.action.test(violation.action)),
    ) ?? null
  );
}

/** Violations no KNOWN_FINDINGS entry explains: these fail the campaign. */
export function unexplainedViolations(
  violations: readonly Violation[],
): Violation[] {
  return violations.filter(violation => knownFindingFor(violation) === null);
}

export function knownFindingIds(violations: readonly Violation[]): string[] {
  const ids = new Set<string>();
  for (const violation of violations) {
    const finding = knownFindingFor(violation);
    if (finding) ids.add(finding.id);
  }
  return [...ids].sort();
}

export function describeCampaignFailure<S>(row: IterationRow<S>): string {
  return (
    `seed ${row.seed} BROKEN — ${unexplainedViolations(row.violations)
      .map(v => `[step ${v.step} ${v.action}] ${v.invariant}: ${v.detail}`)
      .join('\n')}` +
    (row.knownFindings.length
      ? `\nalso reproduces known: ${row.knownFindings.join(',')}`
      : '') +
    `\nscenario: ${JSON.stringify(row.scenario)}\ntrace: ${row.faultTrace.join(' ')}\nreplay: ${row.replay}`
  );
}

export interface IterationRow<Scenario> {
  seed: number;
  outcome: Outcome;
  /** KNOWN_FINDINGS ids this iteration reproduced. */
  knownFindings: string[];
  scenario: Scenario;
  faultsInjected: number;
  faultsByMode: Record<string, number>;
  /** Every dependency call in order: `<dependency>.<op>:<mode>@<fake ms>`. */
  faultTrace: string[];
  violations: Violation[];
  /** Actions that never settled inside the 60 s budget (and the fault). */
  hangs: Array<{ step: number; action: string; pendingFault: string }>;
  replay: string;
}

export function summarizeRows<S>(
  suite: string,
  rows: ReadonlyArray<IterationRow<S>>,
  extra: Record<string, unknown> = {},
) {
  const byInvariant: Record<string, number> = {};
  const byMode: Record<string, number> = {};
  const byKnownFinding: Record<string, number[]> = {};
  for (const row of rows) {
    for (const violation of row.violations) {
      byInvariant[violation.invariant] =
        (byInvariant[violation.invariant] ?? 0) + 1;
    }
    for (const id of row.knownFindings) {
      (byKnownFinding[id] ??= []).push(row.seed);
    }
    for (const [mode, count] of Object.entries(row.faultsByMode)) {
      byMode[mode] = (byMode[mode] ?? 0) + count;
    }
  }
  return {
    suite,
    generatedAt: new Date().toISOString(),
    iterationsExecuted: rows.length,
    held: rows.filter(row => row.outcome === 'HELD').length,
    broken: rows.filter(row => row.outcome === 'BROKEN').length,
    hung: rows.filter(row => row.outcome === 'HUNG').length,
    faultsInjected: rows.reduce((sum, row) => sum + row.faultsInjected, 0),
    faultsByMode: byMode,
    violationsByInvariant: byInvariant,
    seedsByKnownFinding: byKnownFinding,
    unexplainedSeeds: rows
      .filter(row => unexplainedViolations(row.violations).length > 0)
      .map(r => r.seed),
    brokenSeeds: rows.filter(row => row.outcome === 'BROKEN').map(r => r.seed),
    hungSeeds: rows.filter(row => row.outcome === 'HUNG').map(r => r.seed),
    ...extra,
    rows,
  };
}

/** Random but realistic training facts for the planner. */
export function randomContext(
  rng: SeededRng,
  nowMs: number,
): NotificationPlanContext {
  const streakDays = rng.weighted<number>([
    [0, 3],
    [rng.int(1, 6), 4],
    [rng.int(7, 60), 2],
    [rng.int(61, 400), 1],
  ]);
  return {
    nowMs,
    streakDays,
    practicedToday: rng.chance(0.4),
    hasAnyHistory: streakDays > 0 || rng.chance(0.5),
    shieldsAvailable: rng.int(0, 3),
    milestoneEve: rng.chance(0.3)
      ? { title: 'Week one', days: streakDays + 1 }
      : null,
  };
}

const MALFORMED_CONTEXTS: ReadonlyArray<
  (nowMs: number) => NotificationPlanContext
> = [
  nowMs => ({
    nowMs,
    streakDays: Number.NaN,
    practicedToday: false,
    hasAnyHistory: true,
  }),
  nowMs => ({
    nowMs,
    streakDays: -4,
    practicedToday: true,
    hasAnyHistory: true,
    shieldsAvailable: -1,
  }),
  nowMs => ({
    nowMs,
    streakDays: 3,
    practicedToday: false,
    hasAnyHistory: true,
    milestoneEve: { title: '', days: Number.NaN },
  }),
  nowMs =>
    ({
      nowMs,
      streakDays: 2,
      practicedToday: undefined,
      hasAnyHistory: undefined,
    }) as unknown as NotificationPlanContext,
  nowMs => ({
    nowMs,
    streakDays: Number.POSITIVE_INFINITY,
    practicedToday: false,
    hasAnyHistory: true,
    shieldsAvailable: Number.POSITIVE_INFINITY,
  }),
];

export interface ContextLoaderLog {
  contexts: Array<{ mode: FaultMode; context: NotificationPlanContext | null }>;
}

/**
 * `deps.loadContext` double. Healthy calls return fresh random facts stamped
 * with the CURRENT fake time so the plan it yields is recomputable later.
 */
export function makeFaultContextLoader(
  journal: FaultJournal,
  rng: SeededRng,
  modeFor: () => FaultMode,
): { load: () => Promise<NotificationPlanContext>; log: ContextLoaderLog } {
  const log: ContextLoaderLog = { contexts: [] };
  const load = () => {
    const mode = modeFor();
    const entry: ContextLoaderLog['contexts'][number] = { mode, context: null };
    log.contexts.push(entry);
    return runFault(
      journal,
      'context',
      'load',
      mode,
      () => {
        entry.context = randomContext(rng, Date.now());
        return entry.context;
      },
      {
        slowMs: rng.int(500, 5_000),
        malformed: () => {
          entry.context = rng.pick(MALFORMED_CONTEXTS)(Date.now());
          return entry.context;
        },
        partial: () => {
          // Half the facts: streak known, everything else missing.
          entry.context = {
            nowMs: Date.now(),
            streakDays: rng.int(1, 9),
          } as unknown as NotificationPlanContext;
          return entry.context;
        },
      },
    );
  };
  return { load, log };
}

export const VALID_TARGETS = new Set(['Home', 'Performance']);
export const MIN_LEAD_MS = 90_000;

/** Structural sanity every plan handed to the OS must satisfy. */
export function planDefects(
  plan: readonly PlannedNotification[],
  issuedAtMs: number,
): string[] {
  const defects: string[] = [];
  const ids = new Set<string>();
  for (const item of plan) {
    if (!item.id.startsWith(NOTIFICATION_ID_PREFIX))
      defects.push(`id without prefix: ${item.id}`);
    if (ids.has(item.id)) defects.push(`duplicate id: ${item.id}`);
    ids.add(item.id);
    if (!Number.isFinite(item.timestampMs))
      defects.push(`${item.id}: non-finite timestamp ${item.timestampMs}`);
    else if (item.timestampMs < issuedAtMs + MIN_LEAD_MS)
      defects.push(
        `${item.id}: fires ${issuedAtMs + MIN_LEAD_MS - item.timestampMs} ms inside the 90 s lead`,
      );
    if (!VALID_TARGETS.has(item.screen))
      defects.push(`${item.id}: invalid screen ${String(item.screen)}`);
    if (!item.title || !item.body) defects.push(`${item.id}: empty copy`);
    if (/\bNaN\b|undefined/.test(`${item.title} ${item.body}`))
      defects.push(`${item.id}: copy leaks NaN/undefined`);
  }
  return defects;
}
