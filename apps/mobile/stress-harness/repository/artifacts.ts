/**
 * JSON artifact sink for the repository stress suites. Every suite writes its
 * full row table (seed → inputs → observed → invariants) plus a summary, so
 * any row can be replayed from its seed with STRESS_ONLY_SEED.
 *
 * Default location: `<repo>/artifacts/stress-mod-repository/` (gitignored).
 * Override with STRESS_ARTIFACT_DIR.
 */
import {
  fs,
  nodeProcess,
  path,
} from '../../xc-harness/lifecycle-persistence/nodeShim';
import {
  heapSnapshot,
  summarize,
  type MatrixRow,
} from '../../xc-harness/lifecycle-persistence/artifacts';

declare const __dirname: string;

export function stressArtifactDir(): string {
  const configured = nodeProcess.env['STRESS_ARTIFACT_DIR'];
  const dir =
    configured && configured.length > 0
      ? configured
      : path.resolve(__dirname, '../../../../artifacts/stress-mod-repository');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeStressJson(name: string, value: unknown): string {
  const file = path.join(stressArtifactDir(), name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return file;
}

/** Campaign knobs. `STRESS_ITER` scales the seeded campaigns (small default
 * so the suite stays fast); `STRESS_SEED` shifts the seed base;
 * `STRESS_ONLY_SEED` replays exactly one seed. */
export function campaignConfig(defaultIterations: number): {
  iterations: number;
  seedBase: number;
  onlySeed: number | null;
} {
  const iterEnv = nodeProcess.env['STRESS_ITER'];
  const iterations =
    iterEnv && Number.isSafeInteger(Number(iterEnv)) && Number(iterEnv) > 0
      ? Number(iterEnv)
      : defaultIterations;
  const seedEnv = nodeProcess.env['STRESS_SEED'];
  const seedBase =
    seedEnv && Number.isSafeInteger(Number(seedEnv)) ? Number(seedEnv) : 1;
  const onlyEnv = nodeProcess.env['STRESS_ONLY_SEED'];
  const onlySeed =
    onlyEnv && Number.isSafeInteger(Number(onlyEnv)) ? Number(onlyEnv) : null;
  return { iterations, seedBase, onlySeed };
}

export function seedsFor(config: {
  iterations: number;
  seedBase: number;
  onlySeed: number | null;
}): number[] {
  if (config.onlySeed !== null) return [config.onlySeed];
  return Array.from(
    { length: config.iterations },
    (_, i) => config.seedBase + i,
  );
}

/** Rows whose failed invariants are ALL covered by a documented finding are
 * "known broken" — still recorded as BROKEN in the artifact, but they do not
 * fail the suite (each finding is pinned by its own `it.failing`). */
export interface KnownBroken {
  id: string;
  matches(row: MatrixRow): boolean;
}

export function partitionFailures(
  rows: MatrixRow[],
  known: KnownBroken[],
): { unexpected: MatrixRow[]; knownById: Record<string, number> } {
  const knownById: Record<string, number> = {};
  const unexpected: MatrixRow[] = [];
  for (const row of rows) {
    if (row.ok) continue;
    const hit = known.find(k => k.matches(row));
    if (hit) knownById[hit.id] = (knownById[hit.id] ?? 0) + 1;
    else unexpected.push(row);
  }
  return { unexpected, knownById };
}

export function writeCampaign(
  name: string,
  rows: MatrixRow[],
  extra: Record<string, unknown> = {},
): { rowsFile: string; summaryFile: string } {
  const rowsFile = writeStressJson(`${name}.rows.json`, rows);
  const summaryFile = writeStressJson(`${name}.summary.json`, {
    ...summarize(rows),
    ...extra,
    heap: heapSnapshot(),
  });
  return { rowsFile, summaryFile };
}
