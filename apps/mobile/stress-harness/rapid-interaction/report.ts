/**
 * JSON artifacts for a rapid-interaction campaign: the full row table (seed →
 * outcome, inputs included so every row replays from itself) and a compact
 * summary. Default dir: `<repo>/artifacts/stress-signin-rapid-interaction/`
 * (gitignored); override with STRESS_ARTIFACT_DIR.
 */
import {
  fs,
  nodeProcess,
  path,
} from '../../xc-harness/lifecycle-persistence/nodeShim';
import type { BurstRow } from './runner';

declare const __dirname: string;

export function campaignEnv(): {
  STRESS_ITER?: string;
  STRESS_SEED_BASE?: string;
  STRESS_SEED_FILTER?: string;
} {
  return {
    STRESS_ITER: nodeProcess.env['STRESS_ITER'],
    STRESS_SEED_BASE: nodeProcess.env['STRESS_SEED_BASE'],
    STRESS_SEED_FILTER: nodeProcess.env['STRESS_SEED_FILTER'],
  };
}

export function artifactDir(): string {
  const configured = nodeProcess.env['STRESS_ARTIFACT_DIR'];
  const dir =
    configured && configured.length > 0
      ? configured
      : path.resolve(
          __dirname,
          '../../../../artifacts/stress-signin-rapid-interaction',
        );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function summarize(rows: BurstRow[]): Record<string, unknown> {
  const failed = rows.filter(row => !row.ok);
  const byInvariant: Record<string, { checked: number; failed: number }> = {};
  let opsExecuted = 0;
  let taps = 0;
  let providerCalls = 0;
  let bootstrapCalls = 0;
  for (const row of rows) {
    opsExecuted += Number(row.observed['opsExecuted'] ?? 0);
    taps += Number(row.observed['taps'] ?? 0);
    providerCalls += (row.observed['providerCalls'] as unknown[]).length;
    bootstrapCalls += (row.observed['bootstrapCalls'] as unknown[]).length;
    for (const [name, held] of Object.entries(row.invariants)) {
      const slot = (byInvariant[name] ??= { checked: 0, failed: 0 });
      slot.checked += 1;
      if (!held) slot.failed += 1;
    }
  }
  return {
    suite: rows[0]?.suite ?? null,
    node: nodeProcess.version,
    bursts: rows.length,
    passed: rows.length - failed.length,
    failed: failed.length,
    opsExecuted,
    taps,
    providerCalls,
    bootstrapCalls,
    seeds: rows.map(row => row.seed),
    byInvariant,
    failedSeeds: failed.map(row => ({
      seed: row.seed,
      failed: row.failed,
      failures: row.failures,
      plan: row.plan,
    })),
    wallMs: rows.reduce((sum, row) => sum + row.durationMs, 0),
  };
}

export function writeCampaignArtifacts(
  name: string,
  rows: BurstRow[],
): { rowsFile: string; summaryFile: string } {
  const dir = artifactDir();
  const rowsFile = path.join(dir, `${name}.rows.json`);
  const summaryFile = path.join(dir, `${name}.summary.json`);
  fs.writeFileSync(rowsFile, JSON.stringify(rows, null, 2) + '\n');
  fs.writeFileSync(
    summaryFile,
    JSON.stringify(summarize(rows), null, 2) + '\n',
  );
  return { rowsFile, summaryFile };
}
