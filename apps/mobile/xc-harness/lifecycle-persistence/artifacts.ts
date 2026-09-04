import { fs, nodeProcess, path } from './nodeShim';

declare const __dirname: string;

/**
 * Raw-output sink for the matrix runs. Every suite writes its full JSON row
 * table (one object per executed scenario, inputs included) plus a compact
 * summary next to it, so a failure can be replayed from the row alone.
 *
 * Default location: `<repo>/artifacts/xc-lifecycle-persistence/` (the
 * `artifacts/` tree is gitignored). Override with XC_ARTIFACT_DIR.
 */
export function artifactDir(): string {
  const configured = nodeProcess.env['XC_ARTIFACT_DIR'];
  const dir =
    configured && configured.length > 0
      ? configured
      : path.resolve(
          __dirname,
          '../../../../artifacts/xc-lifecycle-persistence',
        );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeJsonArtifact(name: string, value: unknown): string {
  const file = path.join(artifactDir(), name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return file;
}

export function writeTextArtifact(name: string, text: string): string {
  const file = path.join(artifactDir(), name);
  fs.writeFileSync(file, text);
  return file;
}

export interface MatrixRow {
  suite: string;
  scenario: string;
  seed: number | null;
  inputs: Record<string, unknown>;
  observed: Record<string, unknown>;
  invariants: Record<string, boolean>;
  ok: boolean;
  /** Invariant names that failed — the replay key together with `inputs`. */
  failed: string[];
  durationMs: number;
}

export function heapSnapshot(): Record<string, number> {
  const usage = nodeProcess.memoryUsage();
  return {
    rssMb: round(usage.rss / 1048576),
    heapUsedMb: round(usage.heapUsed / 1048576),
    heapTotalMb: round(usage.heapTotal / 1048576),
    externalMb: round(usage.external / 1048576),
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function summarize(rows: MatrixRow[]): Record<string, unknown> {
  const failed = rows.filter(row => !row.ok);
  const byInvariant: Record<string, { checked: number; failed: number }> = {};
  for (const row of rows) {
    for (const [name, held] of Object.entries(row.invariants)) {
      const slot = (byInvariant[name] ??= { checked: 0, failed: 0 });
      slot.checked += 1;
      if (!held) slot.failed += 1;
    }
  }
  return {
    scenarios: rows.length,
    passed: rows.length - failed.length,
    failed: failed.length,
    byInvariant,
    failedScenarios: failed.map(row => ({
      scenario: row.scenario,
      seed: row.seed,
      failed: row.failed,
      inputs: row.inputs,
      observed: row.observed,
    })),
    totalDurationMs: rows.reduce((sum, row) => sum + row.durationMs, 0),
    heap: heapSnapshot(),
    node: nodeProcess.version,
    generatedAt: new Date().toISOString(),
  };
}

/** Markdown matrix: rows = scenarios, columns = invariants. */
export function matrixMarkdown(rows: MatrixRow[]): string {
  const invariantNames = Array.from(
    new Set(rows.flatMap(row => Object.keys(row.invariants))),
  );
  const header = `| scenario | seed | ${invariantNames.join(' | ')} |`;
  const divider = `|---|---|${invariantNames.map(() => '---').join('|')}|`;
  const body = rows.map(row => {
    const cells = invariantNames.map(name => {
      const held = row.invariants[name];
      return held === undefined ? '·' : held ? 'ok' : 'FAIL';
    });
    return `| ${row.scenario} | ${row.seed ?? ''} | ${cells.join(' | ')} |`;
  });
  return [header, divider, ...body].join('\n') + '\n';
}
