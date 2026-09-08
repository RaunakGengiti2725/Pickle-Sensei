/**
 * H09-01 adversarial attack — documentation coherence.
 *
 * AGENTS.md is the repository's authoritative engineering contract and its
 * "Live Court — REMOVED" section enumerates the dormant engine modules and
 * the suites that "still run". After the retirement every module and suite
 * that section names must still exist, or the contract points readers (and
 * agents that treat AGENTS.md as binding) at files that are gone.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const MOBILE_ROOT = join(REPO_ROOT, 'apps', 'mobile');

function liveCourtSection(): string {
  const agents = readFileSync(join(REPO_ROOT, 'AGENTS.md'), 'utf8');
  const start = agents.indexOf('## Live Court');
  expect(start).toBeGreaterThan(-1);
  const rest = agents.slice(start + 1);
  const end = rest.search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('H09-01 attack: AGENTS.md Live Court section vs the retired tree', () => {
  it('every `src/flow/*.ts` module the dormant-engine list names still exists', () => {
    const section = liveCourtSection();
    const engineParagraph = section.slice(
      section.indexOf('The ENGINE stays in-tree'),
    );
    const named = [
      ...engineParagraph.matchAll(/`((?:src\/[\w/]+\/)?[A-Za-z]+\.ts)`/g),
    ]
      .map(match => match[1])
      .filter((name): name is string => name !== undefined);
    expect(named.length).toBeGreaterThan(3);
    const missing = named.filter(
      name =>
        !existsSync(
          join(
            MOBILE_ROOT,
            name.startsWith('src/') ? name : `src/flow/${name}`,
          ),
        ),
    );
    expect(missing).toEqual([]);
  });

  it('every engine suite AGENTS.md says "still run[s]" still exists', () => {
    const section = liveCourtSection();
    const suitesSentence = section.slice(
      section.indexOf('Engine suites still run'),
    );
    const suites = [
      'liveCourt',
      'liveSessionCoach',
      'sessionFlow',
      'sessionNative',
      'sessionProgress',
      'sessionUiMapping',
      'sessionRealAnalysisE2E',
      'gameplayProgression',
    ].filter(name => suitesSentence.includes(name));
    expect(suites.length).toBe(8);
    const missing = suites.filter(
      name => !existsSync(join(MOBILE_ROOT, '__tests__', `${name}.test.ts`)),
    );
    expect(missing).toEqual([]);
  });
});
