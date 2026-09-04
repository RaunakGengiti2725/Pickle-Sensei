/**
 * Static memo-boundary / list-virtualization matrix for the four tab screens.
 *
 * Walks each screen file plus every local component it imports (one level,
 * `../` / `./` specifiers under src/) and records, with file:line, every
 * `React.memo` / `memo(` boundary, `FlatList` / `SectionList` / `FlashList`
 * usage, `ScrollView` usage, `.map(` inside JSX, whole-store Zustand hooks
 * (`useXStore()` with no selector — re-renders on every store write), and
 * selector hooks. This is source evidence (INFERRED), complementing the
 * executed render counts in the sibling harnesses.
 * Replay: `cd apps/mobile && npx jest __tests__/perf/memoBoundaries`.
 * Raw table: artifacts/perf-mobile-render/memo-boundaries.json.
 */
import { writeArtifact } from '../../perf/fixtures';

declare const require: (id: string) => unknown;
declare const __dirname: string;
const fs = require('fs') as {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string, encoding: 'utf8') => string;
};
const path = require('path') as {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
  dirname: (p: string) => string;
  relative: (from: string, to: string) => string;
};

const SRC = path.resolve(__dirname, '../../src');
const SCREENS = {
  HomeScreen: 'screens/HomeScreen.tsx',
  ProgressScreen: 'screens/ProgressScreen.tsx',
  LibraryScreen: 'screens/LibraryScreen.tsx',
  AnalyzeScreen: 'screens/AnalyzeScreen.tsx',
} as const;

type Hit = { file: string; line: number; text: string };
type FileReport = {
  file: string;
  memoBoundaries: Hit[];
  virtualizedLists: Hit[];
  scrollViews: Hit[];
  jsxMaps: Hit[];
  wholeStoreHooks: Hit[];
  selectorHooks: Hit[];
  useMemo: number;
  useCallback: number;
};

const RE = {
  memo: /\b(React\.memo|memo)\s*\(/,
  virtualized: /<(FlatList|SectionList|FlashList|VirtualizedList)\b/,
  scrollView: /<ScrollView\b/,
  jsxMap: /(\{\s*[\w.]+\.map\(|^\s*[\w.]+\.map\(\s*\w+\s*=>\s*\(?\s*<?$)/,
  wholeStore: /\buse[A-Z]\w*Store\(\s*\)/,
  selector: /\buse[A-Z]\w*Store\(\s*(\(?\w+\)?|\w+)\s*=>/,
  useMemo: /\buseMemo\(/g,
  useCallback: /\buseCallback\(/g,
};

function resolveLocal(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [
    `${base}.tsx`,
    `${base}.ts`,
    path.join(base, 'index.tsx'),
    path.join(base, 'index.ts'),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function localImports(file: string): string[] {
  const src = fs.readFileSync(file, 'utf8');
  const out: string[] = [];
  const re = /from\s+'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const resolved = resolveLocal(file, m[1]!);
    if (resolved && resolved.endsWith('.tsx')) out.push(resolved);
  }
  return out;
}

function scan(file: string): FileReport {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const rel = path.relative(path.resolve(SRC, '..'), file);
  const hits = (re: RegExp): Hit[] =>
    lines
      .map((text: string, i: number): Hit => ({
        file: rel,
        line: i + 1,
        text: text.trim(),
      }))
      .filter((h: Hit) => re.test(h.text));
  const src = lines.join('\n');
  return {
    file: rel,
    memoBoundaries: hits(RE.memo),
    virtualizedLists: hits(RE.virtualized),
    scrollViews: hits(RE.scrollView),
    jsxMaps: hits(RE.jsxMap),
    wholeStoreHooks: hits(RE.wholeStore),
    selectorHooks: hits(RE.selector),
    useMemo: (src.match(RE.useMemo) ?? []).length,
    useCallback: (src.match(RE.useCallback) ?? []).length,
  };
}

describe('perf: memo boundary + virtualization matrix (source evidence)', () => {
  const matrix: Record<
    string,
    {
      screen: FileReport;
      components: FileReport[];
      totals: Record<string, number>;
    }
  > = {};

  afterAll(() => {
    const file = writeArtifact('memo-boundaries.json', {
      label: 'INFERRED (static source scan)',
      matrix,
    });
    console.log(`[perf] memo/virtualization matrix -> ${file}`);
  });

  for (const [name, relPath] of Object.entries(SCREENS)) {
    it(`scans ${name} and its local components`, () => {
      const screenFile = path.join(SRC, relPath);
      expect(fs.existsSync(screenFile)).toBe(true);
      const screen = scan(screenFile);
      const components = localImports(screenFile)
        .filter(f => !f.includes('/screens/'))
        .map(scan);
      const all = [screen, ...components];
      const totals = {
        files: all.length,
        memoBoundaries: all.reduce((n, r) => n + r.memoBoundaries.length, 0),
        virtualizedLists: all.reduce(
          (n, r) => n + r.virtualizedLists.length,
          0,
        ),
        scrollViews: all.reduce((n, r) => n + r.scrollViews.length, 0),
        jsxMaps: all.reduce((n, r) => n + r.jsxMaps.length, 0),
        wholeStoreHooks: all.reduce((n, r) => n + r.wholeStoreHooks.length, 0),
        selectorHooks: all.reduce((n, r) => n + r.selectorHooks.length, 0),
        useMemo: all.reduce((n, r) => n + r.useMemo, 0),
        useCallback: all.reduce((n, r) => n + r.useCallback, 0),
      };
      matrix[name] = { screen, components, totals };
      // No screen may subscribe to a whole store without a selector.
      expect(totals.wholeStoreHooks).toBe(0);
    });
  }
});
