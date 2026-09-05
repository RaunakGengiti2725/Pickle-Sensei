import {
  fs,
  nodeProcess,
  path,
} from '../../xc-harness/lifecycle-persistence/nodeShim';
import type { ScenarioResult } from './scenario';

declare const __dirname: string;

/**
 * Campaign knobs (all env, all optional):
 *   STRESS_ITER        number of seeds to run (default 24 — fast enough for
 *                      the regular suite; the reported campaign used 600+)
 *   STRESS_SEED        first seed of the campaign (default 1)
 *   STRESS_SEED_ONLY   comma-separated seeds to replay instead of a range
 *   STRESS_ARTIFACT_DIR where the seed→outcome JSON table is written
 *                      (default <repo>/artifacts/stress/sync-outbox-concurrency)
 */
export function campaignSeeds(): number[] {
  const only = nodeProcess.env['STRESS_SEED_ONLY'];
  if (only && only.trim().length > 0) {
    return only
      .split(',')
      .map(s => Number.parseInt(s.trim(), 10))
      .filter(n => Number.isFinite(n));
  }
  const iterations = Number.parseInt(
    nodeProcess.env['STRESS_ITER'] ?? '24',
    10,
  );
  const first = Number.parseInt(nodeProcess.env['STRESS_SEED'] ?? '1', 10);
  const out: number[] = [];
  for (let i = 0; i < iterations; i += 1) out.push(first + i);
  return out;
}

export function artifactDir(): string {
  const configured = nodeProcess.env['STRESS_ARTIFACT_DIR'];
  const dir =
    configured && configured.length > 0
      ? configured
      : path.resolve(
          __dirname,
          '../../../../artifacts/stress/sync-outbox-concurrency',
        );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeJsonArtifact(name: string, value: unknown): string {
  const file = path.join(artifactDir(), name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return file;
}

export interface CampaignSummary {
  suite: string;
  node: string;
  seeds: number;
  passed: number;
  failed: number;
  failedSeeds: number[];
  /** Seeds where only KNOWN_DEFECT_INVARIANTS failed (reported, not fatal). */
  knownDefectSeeds: number[];
  collisionClasses: Record<string, number>;
  byInvariant: Record<string, { checked: number; failed: number }>;
  totals: Record<string, number>;
  wallMs: number;
}

export function summarize(
  suite: string,
  rows: ScenarioResult[],
  wallMs: number,
): CampaignSummary {
  const byInvariant: Record<string, { checked: number; failed: number }> = {};
  const totals: Record<string, number> = {};
  for (const row of rows) {
    for (const [name, held] of Object.entries(row.invariants)) {
      const slot = (byInvariant[name] ??= { checked: 0, failed: 0 });
      slot.checked += 1;
      if (!held) slot.failed += 1;
    }
    for (const [name, value] of Object.entries(row.metrics)) {
      if (typeof value === 'number') totals[name] = (totals[name] ?? 0) + value;
      else if (Array.isArray(value))
        totals[name] = (totals[name] ?? 0) + value.length;
    }
  }
  const collisionClasses: Record<string, number> = {};
  for (const row of rows) {
    for (const cls of row.metrics.transactionCollisions) {
      collisionClasses[cls] = (collisionClasses[cls] ?? 0) + 1;
    }
  }
  const failed = rows.filter(r => !r.ok);
  return {
    suite,
    node: nodeProcess.version,
    seeds: rows.length,
    passed: rows.length - failed.length,
    failed: failed.length,
    failedSeeds: failed.map(r => r.seed),
    knownDefectSeeds: rows
      .filter(r => r.knownDefects.length > 0)
      .map(r => r.seed),
    collisionClasses,
    byInvariant,
    totals,
    wallMs,
  };
}

/** Compact seed → outcome row for the JSON table. */
export function tableRow(result: ScenarioResult): Record<string, unknown> {
  return {
    seed: result.seed,
    ok: result.ok,
    failed: result.failed,
    knownDefects: result.knownDefects,
    serverProfile: result.plan.serverProfile,
    rows: result.plan.rows.length,
    poisonRows: result.plan.rows.filter(r => r.poison !== null).length,
    duplicateRows: result.plan.rows.filter(r => r.duplicateOf !== null).length,
    drains: result.metrics.drains,
    writers: result.metrics.writers,
    ownerFlips: result.metrics.ownerFlips,
    revocations: result.metrics.revocations,
    serverCalls: result.metrics.serverCalls,
    statements: result.metrics.statements,
    nestedTransactionErrors: result.metrics.nestedTransactionErrors,
    rollbackWithoutTransaction: result.metrics.rollbackWithoutTransaction,
    duplicateSends: result.metrics.duplicateSends,
    overlappingDuplicateSends: result.metrics.overlappingDuplicateSends,
    drainRejections: result.metrics.drainRejections,
    writerRejections: result.metrics.writerRejections,
    transactionCollisions: result.metrics.transactionCollisions,
    attemptsOvershoot: result.metrics.attemptsOvershoot,
    hops: result.metrics.hops,
    convergencePasses: result.metrics.convergencePasses,
    wallMs: result.metrics.wallMs,
    ...(result.detail ? { violations: result.detail.violations } : {}),
  };
}
