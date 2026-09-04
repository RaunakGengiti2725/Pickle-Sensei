import {
  fs,
  nodeProcess,
  path,
} from '../../xc-harness/lifecycle-persistence/nodeShim';

declare const __dirname: string;

/**
 * Row table sink for the app-root stress campaigns. Every executed scenario
 * writes one row (inputs + observed + invariants) so a failure can be replayed
 * from the row alone (`STRESS_SEED=<seed>` / `STRESS_CASE=<name>`).
 *
 * Default location: `<repo>/artifacts/stress-app-root/` (gitignored).
 * Override with STRESS_ARTIFACT_DIR.
 */
export function artifactDir(): string {
  const configured = nodeProcess.env['STRESS_ARTIFACT_DIR'];
  const dir =
    configured && configured.length > 0
      ? configured
      : path.resolve(__dirname, '../../../../artifacts/stress-app-root');
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
  scenario: string;
  seed: number | null;
  inputs: Record<string, unknown>;
  observed: Record<string, unknown>;
  invariants: Record<string, boolean>;
  /** Fault keys that actually fired during the run (dependency:op:mode → n). */
  hits: Record<string, number>;
  ok: boolean;
  failed: string[];
  /** Which of the armed faults fired at least once (dep:mode → fired). */
  faultsFired: Record<string, boolean>;
  /**
   * HELD/BROKEN for a launch in which every armed fault fired; UNREACHED when
   * one armed fault never fired (an earlier fault short-circuited the path),
   * so the row is a replayable record but not an executed injection.
   */
  verdict: 'HELD' | 'BROKEN' | 'UNREACHED';
  /** Deviation ids explaining a BROKEN row (empty for HELD / untriaged). */
  deviations: string[];
  durationMs: number;
}

export function summarize(allRows: StressRow[]): Record<string, unknown> {
  const rows = allRows.filter(row => row.verdict !== 'UNREACHED');
  const unreached = allRows.filter(row => row.verdict === 'UNREACHED');
  const byInvariant: Record<string, { pass: number; fail: number }> = {};
  const byFault: Record<string, { held: number; broken: number }> = {};
  const byDeviation: Record<
    string,
    { rows: number; seeds: (number | string)[] }
  > = {};
  for (const row of rows) {
    for (const id of row.deviations) {
      const bucket = (byDeviation[id] ??= { rows: 0, seeds: [] });
      bucket.rows += 1;
      if (bucket.seeds.length < 12) bucket.seeds.push(row.seed ?? row.scenario);
    }
    for (const [name, ok] of Object.entries(row.invariants)) {
      const bucket = (byInvariant[name] ??= { pass: 0, fail: 0 });
      if (ok) bucket.pass += 1;
      else bucket.fail += 1;
    }
    const faults = row.inputs['faults'];
    if (Array.isArray(faults)) {
      for (const fault of faults as { dep: string; mode: string }[]) {
        const key = `${fault.dep}:${fault.mode}`;
        const bucket = (byFault[key] ??= { held: 0, broken: 0 });
        if (row.ok) bucket.held += 1;
        else bucket.broken += 1;
      }
    }
  }
  const distinctFaultsFired = new Set(
    rows.flatMap(row => Object.keys(row.hits)),
  );
  return {
    executed: rows.length,
    held: rows.filter(row => row.ok).length,
    broken: rows.filter(row => !row.ok).length,
    brokenTriaged: rows.filter(row => !row.ok && row.deviations.length > 0)
      .length,
    brokenUntriaged: rows.filter(row => !row.ok && row.deviations.length === 0)
      .length,
    unreached: unreached.length,
    unreachedScenarios: unreached.map(row => row.scenario),
    distinctFaultKeysFired: distinctFaultsFired.size,
    failingSeeds: rows
      .filter(row => !row.ok)
      .map(row => ({
        scenario: row.scenario,
        seed: row.seed,
        failed: row.failed,
        deviations: row.deviations,
      })),
    byDeviation,
    byInvariant,
    byFault,
  };
}

export function envInt(name: string, fallback: number): number {
  const raw = nodeProcess.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function envString(name: string): string | null {
  const raw = nodeProcess.env[name];
  return raw && raw.length > 0 ? raw : null;
}
