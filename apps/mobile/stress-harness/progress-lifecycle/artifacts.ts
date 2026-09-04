import {
  fs,
  nodeProcess,
  path,
} from '../../xc-harness/lifecycle-persistence/nodeShim';

declare const __dirname: string;

/**
 * Raw-output sink for the ProgressScreen lifecycle stress campaign: one JSON
 * row per executed seed (schedule + observations + invariant verdicts), so a
 * failing row is replayable from the seed alone.
 *
 * Default location: `<repo>/artifacts/stress-progress-lifecycle/` (the
 * `artifacts/` tree is gitignored). Override with STRESS_ARTIFACT_DIR.
 */
export function artifactDir(): string {
  const configured = nodeProcess.env['STRESS_ARTIFACT_DIR'];
  const dir =
    configured && configured.length > 0
      ? configured
      : path.resolve(
          __dirname,
          '../../../../artifacts/stress-progress-lifecycle',
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
