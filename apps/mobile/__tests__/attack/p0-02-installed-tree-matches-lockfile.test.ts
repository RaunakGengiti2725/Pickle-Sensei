/**
 * P0-02 adversarial attack: installed dependency tree vs. package-lock.json.
 *
 * The continuation head's only failing mobile suites were caused by a
 * node_modules tree that predated the lockfile (qs 6.15.3 instead of 6.16.0,
 * @sentry/react-native missing). Those failures surfaced indirectly as four
 * unrelated-looking suites (a GHSA guard child asserting a version literal and
 * three diagnostics suites failing module resolution). This test pins the
 * root cause directly: every guarded literal in the security guard suite must
 * equal the lockfile, and every locked top-level dependency must be the one
 * that is actually installed. On a stale tree it fails with the exact
 * package/version pair instead of 15 opaque child-process failures.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const MOBILE_ROOT = path.resolve(__dirname, '..', '..');
const mobileRequire = createRequire(path.join(MOBILE_ROOT, 'package.json'));

type LockPackages = Record<
  string,
  { version?: string; dev?: boolean; optional?: boolean; link?: boolean }
>;

function lockfile(): { lockfileVersion: number; packages: LockPackages } {
  return JSON.parse(
    fs.readFileSync(path.join(MOBILE_ROOT, 'package-lock.json'), 'utf8'),
  ) as { lockfileVersion: number; packages: LockPackages };
}

function installedVersion(name: string): string | null {
  const pkgPath = path.join(MOBILE_ROOT, 'node_modules', name, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  return (JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string })
    .version;
}

/** Literal `<x>Require('<pkg>/package.json').version, '<v>'` assertions in
 * the GHSA guard suite (the ones that broke on the stale tree). */
function guardedVersionLiterals(): Array<{ name: string; version: string }> {
  const source = fs.readFileSync(
    path.join(
      MOBILE_ROOT,
      '__tests__',
      'wf',
      'be-mobile-security-secrets.test.ts',
    ),
    'utf8',
  );
  const pattern =
    /[rR]equire\('((?:@[^/']+\/)?[^/']+)\/package\.json'\)\.version,\s*'([^']+)'/g;
  const found: Array<{ name: string; version: string }> = [];
  for (const match of source.matchAll(pattern)) {
    const [, name, version] = match;
    if (name !== undefined && version !== undefined) {
      found.push({ name, version });
    }
  }
  return found;
}

describe('P0-02 attack: installed tree matches package-lock.json', () => {
  it('the GHSA guard suite pins at least the qs / image-size / uuid literals', () => {
    const literals = guardedVersionLiterals();
    expect(literals.map(entry => entry.name).sort()).toEqual(
      expect.arrayContaining(['image-size', 'qs', 'uuid']),
    );
  });

  it('every guard literal equals the lockfile AND the installed package', () => {
    const { packages } = lockfile();
    const mismatches: string[] = [];
    for (const { name, version } of guardedVersionLiterals()) {
      const locked = packages[`node_modules/${name}`]?.version;
      const installed = installedVersion(name);
      if (locked !== version) {
        mismatches.push(
          `${name}: guard literal ${version} != locked ${locked}`,
        );
      }
      if (installed !== version) {
        mismatches.push(
          `${name}: guard literal ${version} != installed ${installed ?? '(absent)'} — run npm ci`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('every top-level lockfile entry is installed at exactly its locked version', () => {
    const { lockfileVersion, packages } = lockfile();
    expect(lockfileVersion).toBeGreaterThanOrEqual(2);
    const drift: string[] = [];
    let checked = 0;
    for (const [key, entry] of Object.entries(packages)) {
      // Top-level, non-nested, non-linked entries only: `node_modules/<name>`.
      const match = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key);
      const name = match?.[1];
      if (name === undefined || entry.link || !entry.version) continue;
      const installed = installedVersion(name);
      if (installed === null && entry.optional) continue;
      checked += 1;
      if (installed !== entry.version) {
        drift.push(
          `${name}: locked ${entry.version}, installed ${installed ?? '(absent)'}`,
        );
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(drift).toEqual([]);
  });

  it('the modules the failing suites need resolve from apps/mobile', () => {
    for (const specifier of [
      'qs/package.json',
      'body-parser/package.json',
      '@sentry/react-native/package.json',
      '@sentry/react-native/metro',
      'image-size/package.json',
      'uuid/package.json',
    ]) {
      expect(() => mobileRequire.resolve(specifier)).not.toThrow();
    }
  });
});
