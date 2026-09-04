/**
 * AUDIT PROBE (mobile-ios-config / auditor #2).
 *
 * Suspected defect: the workspace root pins `engines.node = ">=20 <21"` while
 * apps/mobile (React Native 0.87) requires `">= 22.11.0"`. No single Node
 * version satisfies both, yet AGENTS.md says root `eslint .` lints
 * apps/mobile and the Xcode "Bundle React Native code and images" phase
 * resolves `node` from PATH via ios/.xcode.env. The two declarations
 * contradict each other; one of them is stale.
 *
 * The probe evaluates both ranges against every Node major/minor a developer
 * or the Mac runner could plausibly run (18.0 .. 26.99) and requires at least
 * one version to satisfy both.
 */
// Module scope (no imports otherwise) so the declarations below stay local.
export {};

// Node built-ins typed by hand: the RN tsconfig ships no node types.
declare const require: (id: string) => unknown;
declare const __dirname: string;
const fs = require('fs') as {
  readFileSync: (p: string, encoding: 'utf8') => string;
};
const path = require('path') as {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
};

const mobileDir = path.resolve(__dirname, '../../..');
const repoRoot = path.resolve(mobileDir, '../..');

type Version = [number, number, number];

function enginesNode(pkgDir: string): string {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'),
  ) as { engines?: { node?: string } };
  return pkg.engines?.node ?? '*';
}

function parseVersion(text: string): Version {
  const parts = text.split('.').map(p => Number(p));
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) {
      return d;
    }
  }
  return 0;
}

/** Supports the comparator subset used by this repo: `>=`, `>`, `<=`, `<`, `=`. */
function satisfies(version: Version, range: string): boolean {
  const comparators = range
    .trim()
    .replace(/(>=|<=|>|<|=)\s+/g, '$1')
    .split(/\s+/)
    .filter(Boolean);
  return comparators.every(c => {
    const m = c.match(/^(>=|<=|>|<|=)?\s*(\d+(?:\.\d+){0,2})$/);
    if (!m) {
      throw new Error(`unsupported comparator in engines.node: ${c}`);
    }
    const op = m[1] ?? '=';
    const target = parseVersion(m[2] ?? '0');
    const cmp = compare(version, target);
    switch (op) {
      case '>=':
        return cmp >= 0;
      case '>':
        return cmp > 0;
      case '<=':
        return cmp <= 0;
      case '<':
        return cmp < 0;
      default:
        return cmp === 0;
    }
  });
}

describe('audit probe: root and apps/mobile agree on a Node range', () => {
  const rootRange = enginesNode(repoRoot);
  const mobileRange = enginesNode(mobileDir);
  const candidates: Version[] = [];
  for (let major = 18; major <= 26; major += 1) {
    for (let minor = 0; minor <= 99; minor += 1) {
      candidates.push([major, minor, 0]);
    }
  }

  test('precondition: each range is individually satisfiable', () => {
    expect(candidates.some(v => satisfies(v, rootRange))).toBe(true);
    expect(candidates.some(v => satisfies(v, mobileRange))).toBe(true);
  });

  test(`some Node version satisfies both "${rootRange}" and "${mobileRange}"`, () => {
    const both = candidates.filter(
      v => satisfies(v, rootRange) && satisfies(v, mobileRange),
    );
    expect(both.length).toBeGreaterThan(0);
  });
});
