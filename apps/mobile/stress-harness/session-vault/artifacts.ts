/**
 * Raw-output sink for the sessionVault stress campaign: the full seed → outcome
 * table plus a summary, so any row replays from its seed alone.
 *
 * Default location: `<repo>/artifacts/stress-session-vault/` (the `artifacts/`
 * tree is gitignored). Override with STRESS_ARTIFACT_DIR.
 */
import {
  fs,
  nodeProcess,
  path,
} from '../../xc-harness/lifecycle-persistence/nodeShim';

declare const __dirname: string;

export function stressArtifactDir(): string {
  const configured = nodeProcess.env['STRESS_ARTIFACT_DIR'];
  const dir =
    configured && configured.length > 0
      ? configured
      : path.resolve(__dirname, '../../../../artifacts/stress-session-vault');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeStressArtifact(name: string, value: unknown): string {
  const file = path.join(stressArtifactDir(), name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return file;
}
