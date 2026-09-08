/**
 * H09-01 adversarial attack — independent reachability enumeration.
 *
 * The candidate pins "unreachable" with a hand-written regex walker. This
 * suite re-derives the shipping import graph with the TypeScript compiler's
 * own import scanner (`ts.preProcessFile`) plus Metro's platform-extension
 * resolution, and checks the candidate's claims against it:
 *  - the five dormant engine modules are off-graph, RootNavigator is on it;
 *  - nothing on the graph imports `@pickle/audio-coach-core` (any subpath);
 *  - the candidate regex misses no relative specifier TypeScript finds;
 *  - D-044 accounts for EVERY off-graph module (the H09 objective is to
 *    enumerate unreachable paths and retire or document each of them).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import ts from 'typescript';

const MOBILE_ROOT = join(__dirname, '..', '..');
const REPO_ROOT = join(MOBILE_ROOT, '..', '..');
const ENTRYPOINTS = ['index.js', 'App.tsx'];
const DORMANT = [
  'src/flow/session.ts',
  'src/flow/sessionNative.ts',
  'src/flow/sessionProgress.ts',
  'src/flow/liveSessionSummary.ts',
  'src/progress/gameplayProgression.ts',
];
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];
const PLATFORM_TAGS = ['.ios', '.native', ''];

/** Same regex the candidate contract uses, copied verbatim for comparison. */
const CANDIDATE_IMPORT_SPECIFIER =
  /(?:import|export)\s+(?:type\s+)?[^;'"]*?\s+from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;

function candidateSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(CANDIDATE_IMPORT_SPECIFIER)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (specifier) out.push(specifier);
  }
  return out;
}

function tsSpecifiers(source: string): string[] {
  return ts
    .preProcessFile(source, true, true)
    .importedFiles.map(file => file.fileName);
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

function resolveRelative(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(from), specifier);
  const candidates: string[] = [];
  for (const tag of PLATFORM_TAGS) {
    for (const ext of [...SOURCE_EXTENSIONS, '.json']) {
      candidates.push(`${base}${tag}${ext}`);
      candidates.push(join(base, `index${tag}${ext}`));
    }
  }
  candidates.push(base);
  return candidates.find(isFile) ?? null;
}

function walk(): {
  reachable: Set<string>;
  externals: Set<string>;
  missed: string[];
} {
  const reachable = new Set<string>();
  const externals = new Set<string>();
  const missed: string[] = [];
  const queue = ENTRYPOINTS.map(entry => join(MOBILE_ROOT, entry));
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (reachable.has(next)) continue;
    reachable.add(next);
    if (!SOURCE_EXTENSIONS.some(ext => next.endsWith(ext))) continue;
    const source = readFileSync(next, 'utf8');
    const fromTs = tsSpecifiers(source);
    const fromRegex = new Set(candidateSpecifiers(source));
    for (const specifier of fromTs) {
      if (specifier.startsWith('.') && !fromRegex.has(specifier)) {
        missed.push(`${relative(MOBILE_ROOT, next)} -> ${specifier}`);
      }
      const resolved = resolveRelative(next, specifier);
      if (resolved === null) {
        if (!specifier.startsWith('.')) externals.add(specifier);
        continue;
      }
      if (!reachable.has(resolved)) queue.push(resolved);
    }
  }
  return { reachable, externals, missed };
}

function sourceFiles(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (entry === '__tests__' || entry === '__mocks__') continue;
    const file = join(directory, entry);
    if (statSync(file).isDirectory()) sourceFiles(file, out);
    else if (SOURCE_EXTENSIONS.some(ext => entry.endsWith(ext))) out.push(file);
  }
  return out;
}

const rel = (path: string) => relative(MOBILE_ROOT, path).split('\\').join('/');

describe('H09-01 attack: independent reachability (TypeScript scanner + Metro platform resolution)', () => {
  const graph = walk();
  const allSources = sourceFiles(join(MOBILE_ROOT, 'src')).map(rel).sort();
  const offGraph = allSources.filter(
    file => !graph.reachable.has(join(MOBILE_ROOT, file)),
  );

  it('the candidate regex misses no relative specifier the TypeScript scanner finds on the shipping graph', () => {
    expect(graph.missed).toEqual([]);
  });

  it('RootNavigator is reachable and the five dormant engine modules are not', () => {
    expect(
      graph.reachable.has(
        join(MOBILE_ROOT, 'src/navigation/RootNavigator.tsx'),
      ),
    ).toBe(true);
    expect(
      DORMANT.filter(module => graph.reachable.has(join(MOBILE_ROOT, module))),
    ).toEqual([]);
    expect(
      DORMANT.filter(module => !isFile(join(MOBILE_ROOT, module))),
    ).toEqual([]);
  });

  it('nothing on the shipping graph imports @pickle/audio-coach-core (any subpath)', () => {
    const cueEngine = [...graph.externals].filter(spec =>
      spec.startsWith('@pickle/audio-coach-core'),
    );
    expect(cueEngine).toEqual([]);
  });

  it('matches the D-044 enumeration: 15 of 161 src files off-graph after the two retirements (17 of 163 on f250acd7)', () => {
    expect({ total: allSources.length, offGraph: offGraph.length }).toEqual({
      total: 161,
      offGraph: 15,
    });
    expect(offGraph).toEqual(expect.arrayContaining(DORMANT));
  });

  it('D-044 names every off-graph module it claims to have enumerated (retired or documented)', () => {
    const decisions = readFileSync(
      join(REPO_ROOT, 'docs', 'DECISIONS.md'),
      'utf8',
    );
    const d044 = decisions.slice(
      decisions.indexOf('D-044: Live Court dead paths'),
    );
    const undocumented = offGraph.filter(file => {
      const segments = file.split('/');
      const baseName = segments[segments.length - 1] ?? file;
      const stem = baseName.replace(/\.[jt]sx?$/, '');
      const dirAndBase = segments.slice(-2).join('/');
      return (
        !d044.includes(file) &&
        !d044.includes(dirAndBase) &&
        !(
          stem !== 'index' &&
          (d044.includes(baseName) || d044.includes(`\`${stem}\``))
        )
      );
    });
    expect(undocumented).toEqual([]);
  });
});
