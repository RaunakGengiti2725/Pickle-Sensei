import { fs, nodeProcess, path } from '../lifecycle-persistence/nodeShim';

declare const __dirname: string;

/**
 * Output sink for the LibraryScreen stress campaign: the seed → outcome JSON
 * table, per-failure rendered-tree evidence and a compact summary.
 * Default `<repo>/artifacts/stress-libraryscreen/` (gitignored); override
 * with STRESS_ARTIFACT_DIR.
 */
export function stressArtifactDir(): string {
  const configured = nodeProcess.env['STRESS_ARTIFACT_DIR'];
  const dir =
    configured && configured.length > 0
      ? configured
      : path.resolve(__dirname, '../../../../artifacts/stress-libraryscreen');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeStressJson(name: string, value: unknown): string {
  const file = path.join(stressArtifactDir(), name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return file;
}

/** Campaign size: STRESS_ITER (default 12 so the suite stays quick), or a
 * single replay via STRESS_SEED. */
export function campaignSeeds(): number[] {
  const replay = nodeProcess.env['STRESS_SEED'];
  if (replay && replay.length > 0) {
    return replay
      .split(',')
      .map(s => Number.parseInt(s.trim(), 10))
      .filter(n => Number.isSafeInteger(n));
  }
  const raw = nodeProcess.env['STRESS_ITER'];
  const count = raw ? Number.parseInt(raw, 10) : 12;
  const base = Number.parseInt(nodeProcess.env['STRESS_BASE_SEED'] ?? '1', 10);
  return Array.from({ length: Math.max(1, count) }, (_, i) => base + i);
}

export function repeatCount(): number {
  const raw = nodeProcess.env['STRESS_REPEAT'];
  const n = raw ? Number.parseInt(raw, 10) : 1;
  return Number.isSafeInteger(n) && n > 0 ? n : 1;
}
