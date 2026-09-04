/**
 * Shared harness for the `cmp-progress-charts` RAPID/CONCURRENT INTERACTION
 * stress suites (`__tests__/stress/progressCharts*.stress.test.tsx`).
 *
 * Everything an iteration does derives from ONE 32-bit seed through
 * `mulberry32`, so any row of the JSON table can be replayed with
 *   STRESS_ONLY=<seed> npx jest __tests__/stress/<suite>
 * Campaign size is `STRESS_ITER` (default small so the suites stay cheap in
 * the normal run); the table lands at `STRESS_OUT` (default
 * `artifacts/stress/<suite>.json`, gitignored via artifacts/).
 *
 * The guards below are the lens's invariants: no React `act()` warning, no
 * console.error/warn of any kind, no unhandled promise rejection, and no
 * timer left armed once the tree is gone (an animation that outlives its
 * component is the RN equivalent of an orphan loading state).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  ScoredReadPoint,
  ScoreTrendBucket,
} from '../../src/progress/techniqueDashboard';
import type { PracticeHistoryChartBucket } from '../../src/progress/practiceHistory';
import type {
  PracticeSetAttempt,
  PracticeSetSummary,
} from '../../src/progress/practiceSetProgress';

// ─── Seeded RNG ──────────────────────────────────────────────────────────────

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private readonly next: () => number;
  constructor(public readonly seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  /** Integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick() on empty list');
    return items[this.int(0, items.length - 1)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
}

// ─── Campaign configuration ─────────────────────────────────────────────────

export interface CampaignConfig {
  suite: string;
  /** Number of seeded iterations (bursts) to run. */
  iterations: number;
  /** Explicit replay list; when set, `iterations` is ignored. */
  only: number[] | null;
  outFile: string;
  baseSeed: number;
}

export function campaignConfig(
  suite: string,
  defaultIterations: number,
): CampaignConfig {
  const iterRaw = process.env.STRESS_ITER;
  const iterations =
    iterRaw && /^\d+$/.test(iterRaw) ? Number(iterRaw) : defaultIterations;
  const onlyRaw = process.env.STRESS_ONLY;
  const only =
    onlyRaw && onlyRaw.trim().length > 0
      ? onlyRaw
          .split(',')
          .map(part => Number(part.trim()))
          .filter(n => Number.isInteger(n))
      : null;
  const baseRaw = process.env.STRESS_SEED;
  const baseSeed =
    baseRaw && /^\d+$/.test(baseRaw) ? Number(baseRaw) : 0x5eed0000;
  const outDir = process.env.STRESS_OUT
    ? resolve(process.env.STRESS_OUT)
    : resolve(__dirname, '../../artifacts/stress');
  return {
    suite,
    iterations,
    only,
    outFile: resolve(outDir, `${suite}.json`),
    baseSeed,
  };
}

export function seedsFor(config: CampaignConfig): number[] {
  if (config.only) return config.only;
  return Array.from(
    { length: config.iterations },
    (_, i) => (config.baseSeed + i) >>> 0,
  );
}

// ─── Result table ───────────────────────────────────────────────────────────

export interface IterationRow {
  seed: number;
  scenario: string;
  outcome: 'HELD' | 'BROKEN';
  /** Interaction primitives (taps, rerenders, layouts, timer steps…) fired. */
  actions: number;
  /** Side effects observed vs intended, when the scenario has one. */
  intents?: number;
  effects?: number;
  detail?: string;
  failures: string[];
}

export class ResultTable {
  readonly rows: IterationRow[] = [];
  constructor(private readonly config: CampaignConfig) {}

  push(row: IterationRow): void {
    this.rows.push(row);
  }

  write(): { file: string; broken: number; held: number; actions: number } {
    const broken = this.rows.filter(r => r.outcome === 'BROKEN').length;
    const held = this.rows.length - broken;
    const actions = this.rows.reduce((sum, r) => sum + r.actions, 0);
    const byScenario: Record<string, { held: number; broken: number }> = {};
    for (const row of this.rows) {
      const cell = (byScenario[row.scenario] ??= { held: 0, broken: 0 });
      if (row.outcome === 'HELD') cell.held += 1;
      else cell.broken += 1;
    }
    const payload = {
      suite: this.config.suite,
      generatedAt: new Date().toISOString(),
      baseSeed: this.config.baseSeed,
      iterations: this.rows.length,
      actions,
      held,
      broken,
      byScenario,
      replay: `STRESS_ONLY=<seed> npx jest __tests__/stress/${this.config.suite}.stress.test.tsx`,
      rows: this.rows,
    };
    mkdirSync(dirname(this.config.outFile), { recursive: true });
    writeFileSync(this.config.outFile, JSON.stringify(payload, null, 2));
    return { file: this.config.outFile, broken, held, actions };
  }
}

// ─── Guards (act warnings, console noise, unhandled rejections, timers) ─────

export interface GuardReport {
  consoleErrors: string[];
  consoleWarns: string[];
  actWarnings: string[];
  unhandledRejections: string[];
}

function stringify(args: unknown[]): string {
  return args
    .map(a => {
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

const ACT_PATTERN =
  /not wrapped in act\(|inside a test was not wrapped|act\(\.\.\.\)/i;

/**
 * Installs the console/rejection guards for the duration of `body`. Returns
 * the report; the caller decides which categories fail the iteration.
 */
export function withGuards<T>(body: () => T): {
  value: T;
  report: GuardReport;
} {
  const report: GuardReport = {
    consoleErrors: [],
    consoleWarns: [],
    actWarnings: [],
    unhandledRejections: [],
  };
  const errorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      const text = stringify(args);
      if (ACT_PATTERN.test(text)) report.actWarnings.push(text);
      else report.consoleErrors.push(text);
    });
  const warnSpy = jest
    .spyOn(console, 'warn')
    .mockImplementation((...args: unknown[]) => {
      report.consoleWarns.push(stringify(args));
    });
  const onRejection = (reason: unknown) => {
    report.unhandledRejections.push(stringify([reason]));
  };
  process.on('unhandledRejection', onRejection);
  try {
    const value = body();
    return { value, report };
  } finally {
    process.off('unhandledRejection', onRejection);
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  }
}

export function guardFailures(report: GuardReport): string[] {
  const failures: string[] = [];
  for (const w of report.actWarnings)
    failures.push(`act-warning: ${w.slice(0, 200)}`);
  for (const e of report.consoleErrors)
    failures.push(`console.error: ${e.slice(0, 200)}`);
  for (const w of report.consoleWarns)
    failures.push(`console.warn: ${w.slice(0, 200)}`);
  for (const r of report.unhandledRejections)
    failures.push(`unhandledRejection: ${r.slice(0, 200)}`);
  return failures;
}

// ─── Fixture generators (all seeded) ────────────────────────────────────────

const SHOT_TYPES = [
  'forehand_drive',
  'backhand_drive',
  'dink',
  'third_shot_drop',
  'serve',
  'overhead',
] as const;

const DAY0 = Date.UTC(2026, 7, 1); // 2026-08-01

export function dayKey(offset: number): string {
  return new Date(DAY0 + offset * 86_400_000).toISOString().slice(0, 10);
}

function dayLabel(offset: number): string {
  const d = new Date(DAY0 + offset * 86_400_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/** 0–10 with one decimal, the domain contract for scores. */
export function tenthScore(rng: Rng): number {
  return rng.int(0, 100) / 10;
}

export function genScoreTrendBuckets(
  rng: Rng,
  count = rng.pick([1, 3, 7, 7, 7, 14, 28, 30, 90]),
): ScoreTrendBucket[] {
  return Array.from({ length: count }, (_, i) => {
    const n = rng.chance(0.35) ? 0 : rng.int(1, 4);
    return {
      key: dayKey(i),
      label: dayLabel(i),
      avg: n === 0 ? null : tenthScore(rng),
      count: n,
    };
  });
}

export function genReads(
  rng: Rng,
  buckets: readonly ScoreTrendBucket[],
  count = rng.int(0, 16),
): ScoredReadPoint[] {
  const reads: ScoredReadPoint[] = [];
  let t = DAY0;
  for (let i = 0; i < count; i += 1) {
    const bucketIndex = rng.int(0, Math.max(0, buckets.length - 1));
    // Occasionally a read that matches no bucket (must be dropped, not parked).
    const day = rng.chance(0.08)
      ? dayKey(buckets.length + 5)
      : (buckets[bucketIndex]?.key ?? dayKey(bucketIndex));
    t += rng.int(1, 3_600_000);
    reads.push({
      id: `read-${rng.seed.toString(16)}-${i}`,
      shotType: rng.pick(SHOT_TYPES),
      capturedAtMs: t,
      day,
      score: tenthScore(rng),
    });
  }
  return reads;
}

export function genPracticeBuckets(
  rng: Rng,
  count = rng.pick([1, 7, 7, 14, 28, 30, 52, 90]),
): PracticeHistoryChartBucket[] {
  return Array.from({ length: count }, (_, i) => ({
    key: dayKey(i),
    label: dayLabel(i),
    count: rng.chance(0.4) ? 0 : rng.int(1, 12),
  }));
}

export function genAttempt(rng: Rng, index: number): PracticeSetAttempt {
  const cps = ['contact_point', 'paddle_path', 'stance', 'follow_through'];
  return {
    id: `att-${rng.seed.toString(16)}-${index}`,
    capturedAt: new Date(DAY0 + index * 90_000).toISOString(),
    overallScore: tenthScore(rng),
    priorityCheckpoint: rng.chance(0.5) ? rng.pick(cps) : null,
    checkpointScores: Object.fromEntries(
      cps.map(cp => [cp, rng.int(0, 100)] as const),
    ),
  };
}

const TREND_THRESHOLD_TENTHS = 3;

export function genPracticeSetSummary(
  rng: Rng,
  attemptCount = rng.int(2, 9),
): PracticeSetSummary {
  const attempts = Array.from({ length: attemptCount }, (_, i) =>
    genAttempt(rng, i),
  );
  const first = attempts[0]!;
  const latest = attempts[attempts.length - 1]!;
  let best = first;
  for (const a of attempts) {
    if (Math.round(a.overallScore * 10) >= Math.round(best.overallScore * 10))
      best = a;
  }
  const deltaTenths =
    Math.round(latest.overallScore * 10) - Math.round(first.overallScore * 10);
  return {
    sessionId: `set-${rng.seed.toString(16)}`,
    shotType: rng.pick(SHOT_TYPES),
    attempts,
    first,
    latest,
    best,
    deltaTenths,
    trend:
      deltaTenths >= TREND_THRESHOLD_TENTHS
        ? 'improved'
        : deltaTenths <= -TREND_THRESHOLD_TENTHS
          ? 'slipped'
          : 'held',
    fixedCheckpoints: rng.chance(0.3) ? ['contact_point'] : [],
    stillOpen: latest.priorityCheckpoint,
    excludedCount: rng.chance(0.2) ? rng.int(1, 3) : 0,
    startedAt: first.capturedAt,
    endedAt: latest.capturedAt,
  };
}

/** A summary that shares the id space but is a different set (spam navigation
 * between practice sets swaps the whole card's data). */
export function mutateSummary(
  rng: Rng,
  base: PracticeSetSummary,
): PracticeSetSummary {
  const mode = rng.pick([
    'append',
    'drop-first',
    'rescore',
    'swap-set',
  ] as const);
  if (mode === 'swap-set') return genPracticeSetSummary(rng);
  let attempts = base.attempts.map(a => ({ ...a }));
  if (mode === 'append')
    attempts.push(genAttempt(rng, attempts.length + rng.int(10, 99)));
  if (mode === 'drop-first' && attempts.length > 2)
    attempts = attempts.slice(1);
  if (mode === 'rescore') {
    const target = rng.int(0, attempts.length - 1);
    attempts[target] = { ...attempts[target]!, overallScore: tenthScore(rng) };
  }
  const first = attempts[0]!;
  const latest = attempts[attempts.length - 1]!;
  const deltaTenths =
    Math.round(latest.overallScore * 10) - Math.round(first.overallScore * 10);
  let best = first;
  for (const a of attempts) {
    if (Math.round(a.overallScore * 10) >= Math.round(best.overallScore * 10))
      best = a;
  }
  return {
    ...base,
    attempts,
    first,
    latest,
    best,
    deltaTenths,
    trend:
      deltaTenths >= TREND_THRESHOLD_TENTHS
        ? 'improved'
        : deltaTenths <= -TREND_THRESHOLD_TENTHS
          ? 'slipped'
          : 'held',
    stillOpen: latest.priorityCheckpoint,
    startedAt: first.capturedAt,
    endedAt: latest.capturedAt,
  };
}
