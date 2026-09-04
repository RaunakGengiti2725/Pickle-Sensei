/**
 * STRESS / failure-injection harness support for `mod-telemetry`
 * (stabilityTelemetry + usabilityTelemetry) and the production emitters
 * that feed the two recorders.
 *
 * Every campaign iteration is derived from ONE integer seed, so any line of
 * the evidence table replays with `STRESS_SEED=<seed> npx jest <suite>`.
 *
 * Scale knobs:
 *   STRESS_ITER   seeds per fuzzed scenario (default: small, suite-friendly)
 *   STRESS_SEED   pin a single seed (replay mode)
 *   STRESS_RUN_ID evidence directory name (default `local`)
 *
 * Evidence sink: `artifacts/stress/mod-telemetry/<STRESS_RUN_ID>/events.ndjson`
 * (repo-root relative, gitignored) — one line per executed iteration with
 * the seed-derived plan, the observed outcome, the verdict and heap numbers.
 */
import {
  STABILITY_EVENT_KINDS,
  type StabilitySloEvent,
} from '@pickle/shared-types';
import {
  USABILITY_FUNNEL_STEPS,
  type UsabilityFunnelEvent,
} from '../../src/analysis/usabilityTelemetry';

// Node built-ins for the evidence sink; the mobile tsconfig excludes node
// typings so the shims stay local (same convention as
// testing/xcBehavioral/evidence.ts).
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  memoryUsage(): { heapUsed: number; rss: number };
  hrtime: { bigint(): bigint };
};
const fs = require('fs') as {
  mkdirSync: (dir: string, options: { recursive: boolean }) => void;
  appendFileSync: (file: string, data: string) => void;
};
const path = require('path') as {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
};

// ─── Fault vocabulary ────────────────────────────────────────────────────────

export const FAULT_MODES = [
  'throw',
  'reject',
  'timeout',
  'malformed',
  'partial',
  'slow',
  'never',
] as const;
export type FaultMode = (typeof FAULT_MODES)[number];

/** Fake-timer budget every "no infinite spinner" assertion advances. */
export const SPINNER_BUDGET_MS = 60_000;
/** A "slow" dependency answers inside the budget; a "timeout" one answers
 * after it (the caller's own deadline, if any, must have fired first). */
export const SLOW_LATENCY_MS = 45_000;
export const TIMEOUT_LATENCY_MS = 90_000;

// ─── Seeded randomness ───────────────────────────────────────────────────────

/** mulberry32 — the same generator the xc-behavioral matrix uses. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomInt(random: () => number, min: number, max: number) {
  return min + Math.floor(random() * (max - min + 1));
}

export function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

export function chance(random: () => number, probability: number): boolean {
  return random() < probability;
}

/** Seeds for a fuzzed scenario: one pinned seed in replay mode, otherwise
 * `STRESS_ITER` (or `defaultCount`) deterministic seeds derived from the
 * scenario name so every run at the same scale covers the same plans. */
export function stressSeeds(scenario: string, defaultCount: number): number[] {
  const pinned = process.env['STRESS_SEED'];
  if (pinned !== undefined && pinned !== '') return [Number(pinned)];
  const raw = process.env['STRESS_ITER'];
  const scale =
    raw !== undefined && raw !== '' && Number.isFinite(Number(raw))
      ? Math.max(1, Math.floor(Number(raw)))
      : defaultCount;
  let hash = 2166136261;
  for (const ch of scenario) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const seeds: number[] = [];
  for (let i = 0; i < scale; i += 1) seeds.push((hash + i * 7919) >>> 0);
  return seeds;
}

// ─── Evidence sink ───────────────────────────────────────────────────────────

export type StressVerdict = 'held' | 'broken' | 'error';

export interface StressEvidence {
  suite: string;
  scenario: string;
  seed: number;
  /** Seed-derived plan — enough to replay by hand. */
  plan: Record<string, unknown>;
  observed: Record<string, unknown>;
  verdict: StressVerdict;
  durationMs: number;
  heapUsedMb: number;
  rssMb: number;
  atIso: string;
}

const RUN_ID = process.env['STRESS_RUN_ID'] ?? 'local';

function repoRoot(): string {
  // apps/mobile/testing/stress → repo root
  return path.resolve(__dirname, '..', '..', '..', '..');
}

export function stressEvidenceDir(): string {
  return path.join(repoRoot(), 'artifacts', 'stress', 'mod-telemetry', RUN_ID);
}

export function stressEvidenceFile(): string {
  return path.join(stressEvidenceDir(), 'events.ndjson');
}

export function appendStressEvidence(record: StressEvidence): void {
  fs.mkdirSync(stressEvidenceDir(), { recursive: true });
  fs.appendFileSync(stressEvidenceFile(), `${JSON.stringify(record)}\n`);
}

export function mb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

export function heapUsedMb(): number {
  return mb(process.memoryUsage().heapUsed);
}

/**
 * Runs one iteration body, records evidence whether it passes or throws,
 * and re-throws so Jest still reports the failure. The body returns the
 * observed record; `verdict` defaults to `held` for a body that returned and
 * `error` for one that threw. A body may report `broken` explicitly by
 * returning `{ ...observed, verdict: 'broken' }`; an `it.failing`
 * reproduction of a known defect passes `options.knownBroken` so its
 * expected assertion failure is filed as `broken`, not `error`. The body
 * receives `note(partial)` to stash observations that must survive a throw.
 */
export async function recordStress(
  suite: string,
  scenario: string,
  seed: number,
  plan: Record<string, unknown>,
  body: (
    note: (partial: Record<string, unknown>) => void,
  ) => Promise<Record<string, unknown>>,
  options: { knownBroken?: boolean } = {},
): Promise<Record<string, unknown>> {
  // hrtime is never faked by jest.useFakeTimers, so wall time stays honest
  // in suites that advance the fake clock by minutes.
  const started = process.hrtime.bigint();
  let noted: Record<string, unknown> = {};
  let observed: Record<string, unknown> = {};
  let verdict: StressVerdict = 'held';
  const note = (partial: Record<string, unknown>) => {
    noted = { ...noted, ...partial };
  };
  try {
    const returned = await body(note);
    observed = { ...noted, ...returned };
    if (observed['verdict'] === 'broken') verdict = 'broken';
    return observed;
  } catch (error) {
    verdict = options.knownBroken ? 'broken' : 'error';
    observed = {
      ...noted,
      error: error instanceof Error ? error.message : String(error),
    };
    throw error;
  } finally {
    const mem = process.memoryUsage();
    appendStressEvidence({
      suite,
      scenario,
      seed,
      plan,
      observed,
      verdict,
      durationMs: Number(
        (process.hrtime.bigint() - started) / BigInt(1_000_000),
      ),
      heapUsedMb: mb(mem.heapUsed),
      rssMb: mb(mem.rss),
      atIso: new Date().toISOString(),
    });
  }
}

// ─── Deferred / fault-shaped async dependencies ─────────────────────────────

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  settled: boolean;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const d: Deferred<T> = {
    promise: new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    }),
    resolve: value => {
      d.settled = true;
      resolve(value);
    },
    reject: error => {
      d.settled = true;
      reject(error);
    },
    settled: false,
  };
  return d;
}

/** A promise that never settles — the "never-resolves" dependency. */
export function neverResolves<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

/**
 * Shapes an async dependency call according to a fault mode. `good` is the
 * healthy value, `malformed`/`partial` the corrupted shapes the dependency
 * could hand back. Timer-based modes need Jest fake timers in the caller.
 */
export function faultedAsync<T>(
  mode: FaultMode | 'ok',
  shapes: { good: T; malformed: unknown; partial: unknown; error: Error },
): () => Promise<T> {
  switch (mode) {
    case 'ok':
      return () => Promise.resolve(shapes.good);
    case 'throw':
      return () => {
        throw shapes.error;
      };
    case 'reject':
      return () => Promise.reject(shapes.error);
    case 'malformed':
      return () => Promise.resolve(shapes.malformed as T);
    case 'partial':
      return () => Promise.resolve(shapes.partial as T);
    case 'slow':
      return () =>
        new Promise<T>(resolve =>
          setTimeout(() => resolve(shapes.good), SLOW_LATENCY_MS),
        );
    case 'timeout':
      return () =>
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(shapes.error), TIMEOUT_LATENCY_MS),
        );
    case 'never':
      return () => neverResolves<T>();
  }
}

/** Observes whether a promise has settled without awaiting it. */
export function settlementProbe<T>(promise: Promise<T>): {
  settled: () => boolean;
  outcome: () => 'pending' | 'resolved' | 'rejected';
  value: () => T | undefined;
  error: () => unknown;
} {
  let state: 'pending' | 'resolved' | 'rejected' = 'pending';
  let value: T | undefined;
  let error: unknown;
  promise.then(
    v => {
      state = 'resolved';
      value = v;
    },
    e => {
      state = 'rejected';
      error = e;
    },
  );
  return {
    settled: () => state !== 'pending',
    outcome: () => state,
    value: () => value,
    error: () => error,
  };
}

/** Drains microtasks (and the macrotask queue when setImmediate is real). */
export async function flushMicrotasks(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

// ─── Telemetry integrity checks (the unit's own contract) ───────────────────

const STABILITY_KINDS: ReadonlySet<string> = new Set(STABILITY_EVENT_KINDS);
const USABILITY_STEPS: ReadonlySet<string> = new Set(USABILITY_FUNNEL_STEPS);

function isIsoTimestamp(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !Number.isNaN(Date.parse(value))
  );
}

/**
 * Returns every violation of the StabilitySloEvent shape in `events`. A
 * recorder that survived a fault must hold ONLY complete, typed events —
 * no half-written record, no fabricated field.
 */
export function stabilityEventViolations(
  events: readonly StabilitySloEvent[],
  options: { requireParsableAt?: boolean } = {},
): string[] {
  const violations: string[] = [];
  if (!Array.isArray(events)) return ['events() did not return an array'];
  events.forEach((event, index) => {
    const at = `#${index}`;
    if (typeof event !== 'object' || event === null) {
      violations.push(`${at} not an object`);
      return;
    }
    if (typeof event.userKey !== 'string' || event.userKey.length === 0)
      violations.push(`${at} userKey not a non-empty string`);
    if (!(event.sessionKey === null || typeof event.sessionKey === 'string'))
      violations.push(`${at} sessionKey not string|null`);
    if (typeof event.at !== 'string')
      violations.push(`${at} at is not a string`);
    else if (options.requireParsableAt && !isIsoTimestamp(event.at))
      violations.push(`${at} at is not a parsable timestamp`);
    if (!STABILITY_KINDS.has(String(event.kind)))
      violations.push(`${at} unknown kind ${String(event.kind)}`);
    switch (event.kind) {
      case 'crash':
        if (typeof event.fatal !== 'boolean')
          violations.push(`${at} crash.fatal not boolean`);
        if (typeof event.fingerprint !== 'string')
          violations.push(`${at} crash.fingerprint not string`);
        break;
      case 'analysis_failed':
        if (typeof event.failureKind !== 'string')
          violations.push(`${at} analysis_failed.failureKind not string`);
        break;
      case 'camera_startup_failed':
      case 'try_again_failed':
      case 'session_flow_failed':
        if (typeof event.reason !== 'string')
          violations.push(`${at} ${event.kind}.reason not string`);
        break;
      default:
        break;
    }
  });
  return violations;
}

/** Returns every violation of the UsabilityFunnelEvent shape. `allowNonFinite`
 * accepts a stored NaN/Infinity tMs (a faulted clock is stored verbatim; the
 * derivation must still cope). */
export function usabilityEventViolations(
  events: readonly UsabilityFunnelEvent[],
  options: { allowNonFiniteT?: boolean } = {},
): string[] {
  const violations: string[] = [];
  if (!Array.isArray(events)) return ['events() did not return an array'];
  events.forEach((event, index) => {
    const at = `#${index}`;
    if (typeof event !== 'object' || event === null) {
      violations.push(`${at} not an object`);
      return;
    }
    if (!USABILITY_STEPS.has(String(event.step)))
      violations.push(`${at} unknown step ${String(event.step)}`);
    if (typeof event.tMs !== 'number')
      violations.push(`${at} tMs not a number`);
    else if (!options.allowNonFiniteT && !Number.isFinite(event.tMs))
      violations.push(`${at} tMs not finite`);
    if ('detail' in event && typeof event.detail !== 'string')
      violations.push(`${at} detail present but not a string`);
  });
  return violations;
}

// ─── Privacy scan (REVIEW.md telemetry rules) ───────────────────────────────

/**
 * Patterns REVIEW.md forbids in telemetry: filesystem paths / media URIs,
 * emails, base64 blobs, pose payload markers, device identifiers.
 */
const SENSITIVE_PATTERNS: ReadonlyArray<{
  label: string;
  re: RegExp;
  /** Cheap literal pre-check so a multi-megabyte payload never sends a
   * backtracking pattern into quadratic time. */
  needle?: string;
}> = [
  { label: 'file_uri', re: /file:\/\//i, needle: 'file:' },
  {
    label: 'fs_path',
    re: /\/(var|private|Users|data|tmp|Documents)\//i,
    needle: '/',
  },
  { label: 'media_ext', re: /\.(mov|mp4|m4v|json|sqlite|db)\b/i, needle: '.' },
  {
    label: 'email',
    re: /[\w.+-]{1,64}@[\w-]{1,63}\.[\w.-]{1,63}/,
    needle: '@',
  },
  { label: 'base64_blob', re: /(?:[A-Za-z0-9+/]{4}){16,}={1,2}/, needle: '=' },
  { label: 'pose_payload', re: /keypoints|"joints"|\bwrist\b/i },
  { label: 'device_id', re: /idfv|idfa|identifierForVendor|udid/i },
];

export interface SensitiveHit {
  index: number;
  field: string;
  pattern: string;
  sample: string;
}

/**
 * Scans every string-valued field of every event (except the enum-like
 * `kind`/`step` and the pseudonymous keys) for forbidden content.
 */
export function sensitiveHits(
  events: ReadonlyArray<Record<string, unknown>>,
  skipFields: ReadonlySet<string> = new Set([
    'kind',
    'step',
    'userKey',
    'sessionKey',
    'at',
  ]),
): SensitiveHit[] {
  const hits: SensitiveHit[] = [];
  events.forEach((event, index) => {
    for (const [field, value] of Object.entries(event)) {
      if (skipFields.has(field) || typeof value !== 'string') continue;
      for (const { label, re, needle } of SENSITIVE_PATTERNS) {
        if (needle !== undefined && !value.includes(needle)) continue;
        if (re.test(value)) {
          hits.push({
            index,
            field,
            pattern: label,
            sample: value.slice(0, 120),
          });
        }
      }
    }
  });
  return hits;
}

/** Count of events per kind/step — compact outcome fingerprint for tables. */
export function tally<T extends object>(
  events: ReadonlyArray<T>,
  field?: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const event of events) {
    const record = event as Record<string, unknown>;
    const key = String(
      field ? record[field] : (record['kind'] ?? record['step']),
    );
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}
