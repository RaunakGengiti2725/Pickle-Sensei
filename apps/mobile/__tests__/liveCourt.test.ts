/**
 * Live Court dead-path retirement contract (docs/DECISIONS.md D-044).
 *
 * Live Court was cut from the v1 launch on 2026-08-31 (AGENTS.md). Two of its
 * modules had no caller left anywhere but their own tests and are retired
 * from the tree: the pre-D-040 `LiveCourtEngine` rep loop
 * (`src/flow/liveCourt.ts`, superseded by `LiveSessionFlow`) and the voice
 * adapter whose TTS / voice-picker surfaces were deleted with the page
 * (`src/flow/liveSessionCoach.ts`). The canonical session engine, its durable
 * summary schema and the progression math stay in-tree, dormant, and are
 * pinned UNREACHABLE from the shipping entrypoints. Re-mounting any of this
 * is a product decision that has to change this file deliberately.
 */

export {};

declare const require: (id: string) => unknown;
declare const __dirname: string;
type Fs = {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: 'utf8') => string;
  readdirSync: (path: string) => string[];
  statSync: (path: string) => { isDirectory(): boolean; isFile(): boolean };
};
const { existsSync, readFileSync, readdirSync, statSync } = require('fs') as Fs;
const { dirname, join, relative, resolve } = require('path') as {
  dirname: (path: string) => string;
  join: (...parts: string[]) => string;
  relative: (from: string, to: string) => string;
  resolve: (...parts: string[]) => string;
};

const MOBILE_ROOT = join(__dirname, '..');
const SHIPPING_ENTRYPOINTS = ['index.js', 'App.tsx'];

/** Retired outright: no shipping caller, no relaunch value (see D-044). */
const RETIRED_LIVE_COURT_MODULES = [
  'src/flow/liveCourt',
  'src/flow/liveSessionCoach',
];

/** Kept in-tree for a possible relaunch; must stay off the shipping graph. */
const DORMANT_LIVE_COURT_ENGINE = [
  'src/flow/session.ts',
  'src/flow/sessionNative.ts',
  'src/flow/sessionProgress.ts',
  'src/flow/liveSessionSummary.ts',
  'src/progress/gameplayProgression.ts',
];

/** A screen every shipping build mounts — proves the graph walk is not empty. */
const KNOWN_SHIPPING_MODULE = 'src/navigation/RootNavigator.tsx';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];
const RESOLVE_EXTENSIONS = [...SOURCE_EXTENSIONS, '.json'];

const IMPORT_SPECIFIER =
  /(?:import|export)\s+(?:type\s+)?[^;'"]*?\s+from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

/** Relative specifiers only: shared `@pickle/*` packages can never import
 * back into apps/mobile, so they cannot make a mobile module reachable. */
function resolveRelative(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(from), specifier);
  const candidates = [
    base,
    ...RESOLVE_EXTENSIONS.map(ext => base + ext),
    ...RESOLVE_EXTENSIONS.map(ext => join(base, `index${ext}`)),
  ];
  return candidates.find(isFile) ?? null;
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

/** Every mobile module the shipping entrypoints import, transitively. */
function reachableFromShippingEntrypoints(): Set<string> {
  const reached = new Set<string>();
  const queue = SHIPPING_ENTRYPOINTS.map(entry => join(MOBILE_ROOT, entry));
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (reached.has(next)) continue;
    reached.add(next);
    if (!SOURCE_EXTENSIONS.some(ext => next.endsWith(ext))) continue;
    for (const specifier of importSpecifiers(readFileSync(next, 'utf8'))) {
      const resolved = resolveRelative(next, specifier);
      if (resolved !== null && !reached.has(resolved)) queue.push(resolved);
    }
  }
  return new Set(
    [...reached].map(path => relative(MOBILE_ROOT, path).split('\\').join('/')),
  );
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

describe('Live Court dead-path retirement', () => {
  it('retired the superseded LiveCourtEngine and the Live Court voice adapter', () => {
    const present = RETIRED_LIVE_COURT_MODULES.flatMap(module =>
      SOURCE_EXTENSIONS.map(ext => `${module}${ext}`).filter(candidate =>
        isFile(join(MOBILE_ROOT, candidate)),
      ),
    );
    expect(present).toEqual([]);
  });

  it('no mobile source module imports the Live Court cue engine (@pickle/audio-coach-core)', () => {
    const files = [
      ...SHIPPING_ENTRYPOINTS.map(entry => join(MOBILE_ROOT, entry)),
      ...sourceFiles(join(MOBILE_ROOT, 'src')),
    ];
    expect(files.length).toBeGreaterThan(100);
    const importers = files
      .filter(file =>
        importSpecifiers(readFileSync(file, 'utf8')).includes(
          '@pickle/audio-coach-core',
        ),
      )
      .map(file => relative(MOBILE_ROOT, file).split('\\').join('/'));
    expect(importers).toEqual([]);
  });

  it('keeps the dormant session engine in-tree but off the shipping import graph', () => {
    for (const module of DORMANT_LIVE_COURT_ENGINE) {
      expect(isFile(join(MOBILE_ROOT, module))).toBe(true);
    }
    const reachable = reachableFromShippingEntrypoints();
    expect(reachable.has(KNOWN_SHIPPING_MODULE)).toBe(true);
    const mounted = DORMANT_LIVE_COURT_ENGINE.filter(module =>
      reachable.has(module),
    );
    expect(mounted).toEqual([]);
  });
});
