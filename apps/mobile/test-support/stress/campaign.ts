/**
 * Shared bookkeeping for the seeded failure-injection campaigns under
 * __tests__/stress/. Every iteration is identified by (campaign, seed), is
 * replayable with STRESS_ONLY=<campaign>:<seed>, and lands in a JSON table
 * (seed → outcome) under STRESS_OUT (default apps/mobile/artifacts/stress/,
 * git-ignored).
 *
 *   STRESS_ITER=<n>   iterations per campaign (default: the campaign's small
 *                     default so the suite stays fast)
 *   STRESS_ONLY=<campaign>:<seed>   replay one iteration (runs even when
 *                     the campaign is a gated hardening campaign)
 *   STRESS_OUT=<dir>  where the JSON tables are written
 *   STRESS_HARDENING=1  also run the hardening campaigns: inputs no current
 *                     producer can emit (they document known gaps and are
 *                     expected to be red until the module is hardened)
 */
import { campaignSeed } from './seededRng';

// The mobile tsconfig has no node typings; keep the shims local.
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

export type Outcome = 'HELD' | 'BROKEN';

export interface InvariantFailure {
  invariant: string;
  detail: string;
}

export interface ScenarioResult {
  campaign: string;
  seed: number;
  fault: string;
  params: unknown;
  outcome: Outcome;
  failures: InvariantFailure[];
  observed: string;
  replay: string;
  wallMs: number;
}

export interface CampaignPlan {
  name: string;
  seeds: number[];
  replayFor(seed: number): string;
}

const OUT_DIR =
  process.env.STRESS_OUT ?? join(__dirname, '..', '..', 'artifacts', 'stress');

export function planCampaign(
  name: string,
  defaultIterations: number,
  testFile: string,
  options: { hardening?: boolean } = {},
): CampaignPlan {
  const only = process.env.STRESS_ONLY ?? null;
  const replayFor = (seed: number) =>
    `cd apps/mobile && STRESS_ONLY=${name}:${seed} npx jest --ci ${testFile}`;
  if (only) {
    const [campaign, seed] = only.split(':');
    if (campaign !== name) return { name, seeds: [], replayFor };
    if (!Number.isInteger(Number(seed))) {
      throw new Error(`STRESS_ONLY must be <campaign>:<seed>, got ${only}`);
    }
    return { name, seeds: [Number(seed)], replayFor };
  }
  if (options.hardening && process.env.STRESS_HARDENING !== '1') {
    return { name, seeds: [], replayFor };
  }
  const iterations = Number(process.env.STRESS_ITER ?? defaultIterations);
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error(`STRESS_ITER must be a positive integer`);
  }
  const seeds: number[] = [];
  for (let i = 0; i < iterations; i++) seeds.push(campaignSeed(name, i));
  return { name, seeds, replayFor };
}

export class Checker {
  readonly failures: InvariantFailure[] = [];

  check(invariant: string, ok: boolean, detail: () => string): void {
    if (!ok) this.failures.push({ invariant, detail: detail() });
  }

  fail(invariant: string, detail: string): void {
    this.failures.push({ invariant, detail });
  }
}

export class CampaignTable {
  readonly results: ScenarioResult[] = [];
  private readonly startedAt = Date.now();

  constructor(
    readonly plan: CampaignPlan,
    readonly meta: Record<string, unknown> = {},
  ) {}

  record(
    seed: number,
    fault: string,
    params: unknown,
    checker: Checker,
    observed: string,
    wallMs: number,
  ): ScenarioResult {
    const result: ScenarioResult = {
      campaign: this.plan.name,
      seed,
      fault,
      params,
      outcome: checker.failures.length === 0 ? 'HELD' : 'BROKEN',
      failures: checker.failures,
      observed,
      replay: this.plan.replayFor(seed),
      wallMs,
    };
    this.results.push(result);
    return result;
  }

  /** Write the JSON table and return the summary (also embedded in it). */
  flush(): {
    executed: number;
    held: number;
    broken: number;
    byFault: Record<string, { executed: number; broken: number }>;
    byInvariant: Record<string, number>;
  } {
    const byFault: Record<string, { executed: number; broken: number }> = {};
    const byInvariant: Record<string, number> = {};
    for (const r of this.results) {
      byFault[r.fault] ??= { executed: 0, broken: 0 };
      byFault[r.fault]!.executed += 1;
      if (r.outcome === 'BROKEN') byFault[r.fault]!.broken += 1;
      for (const f of r.failures) {
        byInvariant[f.invariant] = (byInvariant[f.invariant] ?? 0) + 1;
      }
    }
    const broken = this.results.filter(r => r.outcome === 'BROKEN');
    const summary = {
      executed: this.results.length,
      held: this.results.length - broken.length,
      broken: broken.length,
      byFault,
      byInvariant,
    };
    const document = {
      campaign: this.plan.name,
      generatedAt: new Date().toISOString(),
      wallMs: Date.now() - this.startedAt,
      env: {
        STRESS_ITER: process.env.STRESS_ITER ?? null,
        STRESS_ONLY: process.env.STRESS_ONLY ?? null,
        STRESS_HARDENING: process.env.STRESS_HARDENING ?? null,
      },
      meta: this.meta,
      summary,
      brokenSeeds: broken.map(r => ({
        seed: r.seed,
        fault: r.fault,
        failures: r.failures,
        replay: r.replay,
      })),
      results: this.results,
    };
    if (this.results.length === 0) return summary;
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
      join(OUT_DIR, `${this.plan.name}.json`),
      JSON.stringify(document, null, 2),
    );
    return summary;
  }
}

/** Stringify anything (including Errors, cycles and bigints) for the table. */
export function describeValue(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function') return '[function]';
  if (typeof value === 'symbol') return value.toString();
  try {
    return (
      JSON.stringify(value, (_key, inner: unknown) =>
        typeof inner === 'number' && !Number.isFinite(inner)
          ? `<${String(inner)}>`
          : inner,
      ) ?? String(value)
    );
  } catch {
    return String(value);
  }
}

/** "9 999 -> 9999.5" etc. must never leak into copy; the substrings that
 * betray a coerced or non-finite value. */
export const FORBIDDEN_COPY_TOKENS = [
  'NaN',
  'undefined',
  'Infinity',
  'null',
  '[object Object]',
] as const;

export function forbiddenToken(text: string): string | null {
  for (const token of FORBIDDEN_COPY_TOKENS) {
    if (text.includes(token)) return token;
  }
  return null;
}
