/**
 * H09-01 adversarial attack — did the type move preserve the contract?
 *
 * On BASE_SHA the persisted recap cue carried `category: SpokenCueCategory`
 * (the `LiveCueCategory | 'SESSION_START' | 'SESSION_END'` union). The
 * candidate re-homes the type in `liveSessionSummary.ts` as `LiveCoachCue`.
 * A faithful move keeps an out-of-vocabulary category a compile error; a
 * widening to `string` silently accepts any text as a cue category.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import ts from 'typescript';

const MOBILE_ROOT = join(__dirname, '..', '..');

function probeDiagnostics(probeSource: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'h09-type-probe-'));
  try {
    const probe = join(dir, 'probe.ts');
    writeFileSync(probe, probeSource);
    const parsed = ts.getParsedCommandLineOfConfigFile(
      join(MOBILE_ROOT, 'tsconfig.json'),
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: diagnostic => {
          throw new Error(
            ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
          );
        },
      },
    );
    if (!parsed) throw new Error('tsconfig.json could not be parsed');
    const program = ts.createProgram([probe], {
      ...parsed.options,
      noEmit: true,
    });
    const source = program.getSourceFile(probe);
    if (!source) throw new Error('probe not in program');
    return program
      .getSemanticDiagnostics(source)
      .map(diagnostic =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const summaryModule = join(MOBILE_ROOT, 'src', 'flow', 'liveSessionSummary')
  .split('\\')
  .join('/');

describe('H09-01 attack: LiveCoachCue keeps the cue-category vocabulary it replaced', () => {
  it('a vocabulary category still type-checks after the move', () => {
    const diagnostics = probeDiagnostics(`
      import type { LiveCoachCue } from '${summaryModule}';
      export const cue: LiveCoachCue = {
        eventId: null,
        category: 'SESSION_START',
        text: 'Session started.',
        targetCheckpoint: null,
        atMs: 0,
        spoken: true,
      };
    `);
    expect(diagnostics).toEqual([]);
  });

  it('an out-of-vocabulary category is still a compile error after the move', () => {
    const diagnostics = probeDiagnostics(`
      import type { LiveCoachCue } from '${summaryModule}';
      export const cue: LiveCoachCue = {
        eventId: null,
        category: 'NOT_A_LIVE_CUE_CATEGORY',
        text: 'anything',
        targetCheckpoint: null,
        atMs: 0,
        spoken: true,
      };
    `);
    expect(diagnostics.length).toBeGreaterThan(0);
  });
});
