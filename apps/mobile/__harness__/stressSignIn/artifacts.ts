import {
  fs,
  nodeProcess,
  path,
} from '../../xc-harness/lifecycle-persistence/nodeShim';

declare const __dirname: string;

/**
 * Raw-output sink for the SignIn stress campaigns: the full JSON row table
 * (seed → inputs → observed → invariants) plus a summary, so any failing
 * row replays from its seed alone.
 *
 * Default: `<repo>/artifacts/stress-signin/` (gitignored). Override with
 * STRESS_ARTIFACT_DIR.
 */
export function stressArtifactDir(): string {
  const configured = nodeProcess.env['STRESS_ARTIFACT_DIR'];
  const dir =
    configured && configured.length > 0
      ? configured
      : path.resolve(__dirname, '../../../../artifacts/stress-signin');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeStressJson(name: string, value: unknown): string {
  const file = path.join(stressArtifactDir(), name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return file;
}

export function writeStressText(name: string, text: string): string {
  const file = path.join(stressArtifactDir(), name);
  fs.writeFileSync(file, text);
  return file;
}

/** STRESS_ITER: number of seeded random-combination iterations to run on top
 * of the fixed catalog. Small by default so the suite stays fast. */
export function stressIterations(defaultCount: number): number {
  const raw = nodeProcess.env['STRESS_ITER'];
  if (!raw) return defaultCount;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultCount;
}

/** STRESS_SEED: replay exactly one seeded scenario (skips the catalog). */
export function stressReplaySeed(): number | null {
  const raw = nodeProcess.env['STRESS_SEED'];
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed >>> 0 : null;
}

/** STRESS_ONLY: substring filter on catalog scenario ids. */
export function stressOnlyFilter(): string | null {
  const raw = nodeProcess.env['STRESS_ONLY'];
  return raw && raw.length > 0 ? raw : null;
}

/** STRESS_SEED_START: first seed of the seeded campaign (default 1). */
export function stressSeedStart(): number {
  const raw = nodeProcess.env['STRESS_SEED_START'];
  if (!raw) return 1;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed >>> 0 : 1;
}
