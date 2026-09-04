import {
  fs,
  nodeProcess,
  path,
} from '../../xc-harness/lifecycle-persistence/nodeShim';

declare const __dirname: string;
/** Captured before any suite installs fake timers (module evaluation runs
 * ahead of the test body), so it keeps reporting real wall-clock time. */
const realDateNow: () => number = Date.now;

/** Real elapsed milliseconds — immune to jest fake timers / setSystemTime. */
export function wallMs(): number {
  return realDateNow();
}

/**
 * JSON sink for the onboarding lifecycle stress suite: one row per executed
 * seed (inputs, observed facts, per-invariant verdicts) plus a summary, so a
 * failing row is replayable by seed alone.
 *
 * Default location: `<repo>/artifacts/stress-onboarding-lifecycle/` (the
 * `artifacts/` tree is gitignored). Override with STRESS_ARTIFACT_DIR.
 */
export function artifactDir(): string {
  const configured = nodeProcess.env['STRESS_ARTIFACT_DIR'];
  const dir =
    configured && configured.length > 0
      ? configured
      : path.resolve(
          __dirname,
          '../../../../artifacts/stress-onboarding-lifecycle',
        );
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
  inputs: Record<string, unknown>;
  observed: Record<string, unknown>;
  invariants: Record<string, boolean>;
  ok: boolean;
  failed: string[];
  durationMs: number;
}

export function summarize(rows: StressRow[]): Record<string, unknown> {
  const byInvariant: Record<string, { held: number; failed: number }> = {};
  for (const row of rows) {
    for (const [name, held] of Object.entries(row.invariants)) {
      const slot = (byInvariant[name] ??= { held: 0, failed: 0 });
      if (held) slot.held += 1;
      else slot.failed += 1;
    }
  }
  return {
    executed: rows.length,
    ok: rows.filter(r => r.ok).length,
    failed: rows
      .filter(r => !r.ok)
      .map(r => ({ seed: r.seed, failed: r.failed })),
    byInvariant,
    node: nodeProcess.version,
  };
}
