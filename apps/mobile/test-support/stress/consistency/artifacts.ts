import {
  fs,
  nodeProcess,
  path,
} from '../../../xc-harness/lifecycle-persistence/nodeShim';

declare const __dirname: string;

/**
 * JSON row sink for the consistency stress campaigns.
 *
 * Default location: `<repo>/artifacts/stress/consistency/` (gitignored).
 * Override with STRESS_ARTIFACT_DIR. One row per executed scenario; the
 * row carries the seed and every injected fault so it can be replayed.
 */
export function artifactDir(): string {
  const configured = nodeProcess.env['STRESS_ARTIFACT_DIR'];
  const dir =
    configured && configured.length > 0
      ? configured
      : path.resolve(__dirname, '../../../../../artifacts/stress/consistency');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeJsonArtifact(name: string, value: unknown): string {
  const file = path.join(artifactDir(), name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return file;
}

export interface StressRow {
  suite: string;
  seed: number;
  scenario: string;
  /** Injected faults, in order (dependency, kind, extra detail). */
  faults: string[];
  inputs: Record<string, unknown>;
  observed: Record<string, unknown>;
  invariants: Record<string, boolean>;
  ok: boolean;
  failed: string[];
  durationMs: number;
}

export function summarizeRows(
  suite: string,
  rows: StressRow[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const failed = rows.filter(row => !row.ok);
  const byInvariant: Record<string, { checked: number; failed: number }> = {};
  const byFault: Record<string, { injected: number; rowsFailed: number }> = {};
  for (const row of rows) {
    for (const [name, held] of Object.entries(row.invariants)) {
      const slot = (byInvariant[name] ??= { checked: 0, failed: 0 });
      slot.checked += 1;
      if (!held) slot.failed += 1;
    }
    for (const fault of row.faults) {
      const kind = fault.split(' ')[0] ?? fault;
      const slot = (byFault[kind] ??= { injected: 0, rowsFailed: 0 });
      slot.injected += 1;
      if (!row.ok) slot.rowsFailed += 1;
    }
  }
  return {
    suite,
    scenarios: rows.length,
    faultsInjected: rows.reduce((sum, row) => sum + row.faults.length, 0),
    passed: rows.length - failed.length,
    failed: failed.length,
    failedSeeds: failed.map(row => row.seed),
    byInvariant,
    byFault,
    failedScenarios: failed.map(row => ({
      seed: row.seed,
      scenario: row.scenario,
      failed: row.failed,
      faults: row.faults,
      observed: row.observed,
    })),
    totalDurationMs: rows.reduce((sum, row) => sum + row.durationMs, 0),
    node: nodeProcess.version,
    tz: nodeProcess.env['TZ'] ?? null,
    generatedAt: new Date().toISOString(),
    ...extra,
  };
}
