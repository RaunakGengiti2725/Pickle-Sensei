import {
  fs,
  nodeProcess,
  path,
} from '../../xc-harness/lifecycle-persistence/nodeShim';

declare const __dirname: string;

/**
 * JSON sink for the WelcomeScreen failure-injection matrix. Every executed
 * scenario becomes one row (inputs + observations + invariant verdicts) so a
 * failure replays from the row alone; a compact summary sits next to it.
 *
 * Default location: `<repo>/artifacts/stress-welcome-failure-injection/`
 * (gitignored). Override with STRESS_WFI_ARTIFACT_DIR.
 */
export function artifactDir(): string {
  const configured = nodeProcess.env.STRESS_WFI_ARTIFACT_DIR;
  const dir =
    configured && configured.length > 0
      ? configured
      : path.resolve(
          __dirname,
          '../../../../artifacts/stress-welcome-failure-injection',
        );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeJsonArtifact(name: string, value: unknown): string {
  const file = path.join(artifactDir(), name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return file;
}

export interface Row {
  suite: string;
  scenario: string;
  seed: number;
  inputs: Record<string, unknown>;
  observed: Record<string, unknown>;
  invariants: Record<string, boolean>;
  ok: boolean;
  failed: string[];
  /** Known-deviation id when the failure set is exactly explained. */
  deviation: string | null;
  durationMs: number;
}

export function summarize(rows: Row[]): Record<string, unknown> {
  const failed = rows.filter(row => !row.ok);
  const byInvariant: Record<string, { checked: number; failed: number }> = {};
  const byDeviation: Record<string, number> = {};
  const byFault: Record<
    string,
    { runs: number; failed: number; exercised: number }
  > = {};
  for (const row of rows) {
    for (const [name, held] of Object.entries(row.invariants)) {
      const slot = (byInvariant[name] ??= { checked: 0, failed: 0 });
      slot.checked += 1;
      if (!held) slot.failed += 1;
    }
    if (row.deviation)
      byDeviation[row.deviation] = (byDeviation[row.deviation] ?? 0) + 1;
    const faults = row.inputs.faults as string[];
    const exercised = row.observed.faultsExercised as Record<string, boolean>;
    for (const id of faults) {
      const slot = (byFault[id] ??= { runs: 0, failed: 0, exercised: 0 });
      slot.runs += 1;
      if (!row.ok) slot.failed += 1;
      if (exercised[id]) slot.exercised += 1;
    }
  }
  return {
    scenarios: rows.length,
    passed: rows.length - failed.length,
    failed: failed.length,
    unexplained: failed.filter(row => row.deviation === null).length,
    byInvariant,
    byDeviation,
    byFault,
    failedScenarios: failed.map(row => ({
      scenario: row.scenario,
      seed: row.seed,
      failed: row.failed,
      deviation: row.deviation,
      faults: row.inputs.faults,
      install: row.inputs.install,
    })),
  };
}
