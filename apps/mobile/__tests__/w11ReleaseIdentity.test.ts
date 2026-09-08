/**
 * W11-08 — immutable release identity.
 *
 * The release candidate's version/build identity is COMMITTED before
 * verification and must be the identity that ships. On the base revision the
 * fastlane `beta`/`release` lanes computed `latest_testflight_build_number + 1`
 * after every gate had run and injected it as a CURRENT_PROJECT_VERSION build
 * setting, so the verified candidate and the uploaded binary could carry
 * different build numbers. This suite pins the replacement:
 *
 *   - `scripts/release-identity.mjs --check` proves that the verified manifest
 *     (`infra/release/release-manifest.json`), `project.pbxproj`, the plist the
 *     pbxproj really points at, `app.json`, `AppDelegate.swift` and
 *     `runtimeConfig.ts` agree, and refuses (exit 1, no JSON) when any of them
 *     drifts;
 *   - `--require-committed` means "byte-identical to HEAD" for every identity
 *     file — a quiet `git status` (skip-worktree, assume-unchanged, ignored
 *     files) is not proof;
 *   - `--assert-version/--assert-build/--assert-git-sha` refuse an archive
 *     whose identity differs from the verified manifest (the upload gate),
 *     comparing build numbers exactly (no double rounding);
 *   - `--latest-uploaded N` refuses a build number that is not greater than the
 *     newest build already on App Store Connect WITHOUT choosing a replacement
 *     (the next build number is an owner decision);
 *   - repeated or malformed flags are refused, never silently resolved;
 *   - the Fastfile builds from the committed identity, never increments, and
 *     re-applies every pre-build refusal — against the identity captured
 *     BEFORE build_app — at the archive gate, before either upload action;
 *   - every comment present on the base Fastfile whose code survives is kept
 *     verbatim (work-package hard rule);
 *   - docs/DISTRIBUTION.md documents the flow and keeps the builds 1–3 history.
 *
 * Static + subprocess tests only (throwaway git repositories under the OS
 * tmpdir): nothing here needs Xcode, signing or Apple credentials, and nothing
 * here uploads anything.
 */

// Module scope on purpose: the `declare const` shims below must stay local to
// this file rather than becoming global declarations.
export {};

// Node built-ins, typed the same way be-mobile-security-secrets.test.ts does
// (the RN tsconfig ships no node types).
declare const require: (id: string) => unknown;
declare const __dirname: string;
const fs = require('fs') as {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string, encoding: 'utf8') => string;
  mkdtempSync: (prefix: string) => string;
  mkdirSync: (p: string, options: { recursive: true }) => void;
  writeFileSync: (p: string, data: string, encoding: 'utf8') => void;
  rmSync: (p: string, options: { recursive: true; force: true }) => void;
};
const path = require('path') as {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
  dirname: (p: string) => string;
};
const os = require('os') as { tmpdir: () => string };
const { execPath } = require('node:process') as { execPath: string };
const childProcess = require('child_process') as {
  spawnSync: (
    executable: string,
    args: string[],
    options: {
      cwd: string;
      encoding: 'utf8';
      timeout: number;
      killSignal: 'SIGKILL';
      maxBuffer: number;
      env?: Record<string, string>;
    },
  ) => {
    status: number | null;
    signal: string | null;
    error?: { code?: string };
    stdout: string;
    stderr: string;
  };
};

const MOBILE_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(MOBILE_ROOT, '..', '..');
const SCRIPT = path.join(MOBILE_ROOT, 'scripts', 'release-identity.mjs');
const FASTFILE = path.join(MOBILE_ROOT, 'ios', 'fastlane', 'Fastfile');
const DISTRIBUTION_DOC = path.join(REPO_ROOT, 'docs', 'DISTRIBUTION.md');

// Every file that carries (or sources) the shipped identity, relative to the
// mobile root. The manifest lives two directories up, at the repo root.
const IDENTITY_FILES = [
  '../../infra/release/release-manifest.json',
  'ios/PickleSensei.xcodeproj/project.pbxproj',
  'ios/PickleSensei/Info.plist',
  'ios/PickleSensei/AppDelegate.swift',
  'app.json',
  'src/config/runtimeConfig.ts',
] as const;
type IdentityFile = (typeof IDENTITY_FILES)[number];
type Mutations = Partial<Record<IdentityFile, (content: string) => string>>;

interface ReleaseIdentity {
  marketingVersion: string;
  buildNumber: number;
  bundleIdentifier: string;
  moduleName: string;
  displayName: string;
  configurations: string[];
  gitSha: string | null;
  committed: boolean;
  identityFiles: string[];
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runScript(
  args: string[],
  cwd: string = MOBILE_ROOT,
  env?: Record<string, string>,
): RunResult {
  const result = childProcess.spawnSync(execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20_000,
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
    ...(env ? { env } : {}),
  });
  if (result.error) {
    throw new Error(`spawn failed: ${JSON.stringify(result.error)}`);
  }
  return result;
}

function git(args: string[], cwd: string = REPO_ROOT): string {
  const result = childProcess.spawnSync(
    'git',
    ['-c', 'user.name=w11', '-c', 'user.email=w11@example.invalid', ...args],
    {
      cwd,
      encoding: 'utf8',
      timeout: 20_000,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function readIdentityFile(name: IdentityFile): string {
  return fs.readFileSync(path.join(MOBILE_ROOT, name), 'utf8');
}

const manifest = JSON.parse(
  readIdentityFile('../../infra/release/release-manifest.json'),
) as { versionScheme: { marketingVersion: string; buildNumber: number } };
const VERSION = manifest.versionScheme.marketingVersion;
const BUILD = manifest.versionScheme.buildNumber;
const pbxproj = readIdentityFile('ios/PickleSensei.xcodeproj/project.pbxproj');

function pbxValues(setting: string): string[] {
  const pattern = new RegExp(`^\\s*${setting} = ([^;]+);`, 'gm');
  const values: string[] = [];
  for (const match of pbxproj.matchAll(pattern)) {
    values.push((match[1] ?? '').trim());
  }
  return values;
}

/**
 * Copies the real identity files into a throwaway tree (same layout as the
 * repo, so the script's default path resolution works from `--mobile-root`)
 * and applies the given mutations. Returns the tree's repo root.
 */
const fixtures: string[] = [];
function tree(mutations: Mutations = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w11-release-identity-'));
  fixtures.push(root);
  writeIdentity(root, mutations);
  return root;
}
function writeIdentity(root: string, mutations: Mutations) {
  const mobileRoot = path.join(root, 'apps', 'mobile');
  for (const name of IDENTITY_FILES) {
    const target = path.resolve(mobileRoot, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const mutate = mutations[name];
    const content = readIdentityFile(name);
    fs.writeFileSync(target, mutate ? mutate(content) : content, 'utf8');
  }
}
const mobile = (root: string) => path.join(root, 'apps', 'mobile');
/** Same as `tree`, returning the fixture's mobile root. */
function fixture(mutations: Mutations = {}): string {
  return mobile(tree(mutations));
}
/** Mutations that move the whole coherent identity to build `n`. */
function withBuild(n: number | string): Mutations {
  return {
    '../../infra/release/release-manifest.json': content =>
      content.replace(`"buildNumber": ${BUILD},`, `"buildNumber": ${n},`),
    'ios/PickleSensei.xcodeproj/project.pbxproj': content =>
      content
        .split(`CURRENT_PROJECT_VERSION = ${BUILD};`)
        .join(`CURRENT_PROJECT_VERSION = ${n};`),
  };
}
/** A throwaway git repository whose HEAD commits the given identity tree. */
function committedRepo(mutations: Mutations = {}): string {
  const root = tree(mutations);
  git(['init', '-q', '-b', 'main'], root);
  git(['add', '-A'], root);
  git(['commit', '-q', '-m', 'identity'], root);
  return root;
}
afterAll(() => {
  for (const root of fixtures) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function expectRefusal(result: RunResult, ...fragments: string[]) {
  expect(result.status).toBe(1);
  // No identity JSON may reach a consumer when the check refused.
  expect(result.stdout.trim()).toBe('');
  for (const fragment of fragments) {
    expect(result.stderr).toContain(fragment);
  }
}

function expectAccepted(result: RunResult): ReleaseIdentity {
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as ReleaseIdentity;
}

// ─── The committed identity on this revision ─────────────────────────────────

describe('committed release identity (manifest ↔ pbxproj ↔ app.json)', () => {
  test('the verified manifest carries a well-formed version and build', () => {
    expect(VERSION).toMatch(/^\d+\.\d+(\.\d+)?$/);
    expect(Number.isSafeInteger(BUILD)).toBe(true);
    expect(BUILD).toBeGreaterThan(0);
  });

  test('every Xcode configuration carries exactly the manifest identity', () => {
    const versions = pbxValues('MARKETING_VERSION');
    const builds = pbxValues('CURRENT_PROJECT_VERSION');
    expect(versions.length).toBeGreaterThan(0);
    expect(builds.length).toBe(versions.length);
    expect(new Set(versions)).toEqual(new Set([VERSION]));
    expect(new Set(builds)).toEqual(new Set([String(BUILD)]));
  });

  test('`release-identity.mjs --check` passes on this revision', () => {
    const result = runScript(['--check']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(VERSION);
    expect(result.stdout).toContain(String(BUILD));
  });

  test('`--check --json` emits exactly one JSON identity that matches the committed files', () => {
    const identity = expectAccepted(runScript(['--check', '--json']));
    expect(identity.marketingVersion).toBe(VERSION);
    expect(identity.buildNumber).toBe(BUILD);
    expect(identity.bundleIdentifier).toBe('com.picklesensei');
    expect(identity.moduleName).toBe('PickleSensei');
    expect(identity.displayName).toBe('Pickle Sensei');
    expect(identity.configurations).toEqual(['Debug', 'Release']);
    expect(identity.gitSha).toBe(git(['rev-parse', 'HEAD']).trim());
    expect(identity.identityFiles).toEqual(
      IDENTITY_FILES.map(name => path.resolve(MOBILE_ROOT, name)),
    );
    // Committed ⇔ every identity file is tracked and byte-identical to HEAD.
    const identical = identity.identityFiles.every(file => {
      const relative = git(['ls-files', '--full-name', '--', file]).trim();
      return (
        relative !== '' &&
        git(['rev-parse', `HEAD:${relative}`]).trim() ===
          git(['hash-object', '--', file]).trim()
      );
    });
    expect(identity.committed).toBe(identical);
  });

  test('`--require-committed` follows the HEAD state of the identity files', () => {
    const probe = expectAccepted(runScript(['--check', '--json']));
    const result = runScript(['--check', '--require-committed', '--json']);
    if (probe.committed) {
      expect(expectAccepted(result).committed).toBe(true);
    } else {
      expectRefusal(result, 'uncommitted');
    }
  });

  test('`--require-committed` refuses outside a git checkout (identity cannot be proven committed)', () => {
    const mobileRoot = fixture();
    const result = runScript(
      ['--check', '--require-committed', '--mobile-root', mobileRoot],
      mobileRoot,
    );
    expectRefusal(result, 'committed');
  });
});

// ─── "committed" means byte-identical to HEAD ────────────────────────────────

describe('--require-committed proves the identity is the one at HEAD', () => {
  const requireCommitted = (root: string, ...extra: string[]) =>
    runScript(
      [
        '--check',
        '--require-committed',
        '--json',
        '--mobile-root',
        mobile(root),
        ...extra,
      ],
      mobile(root),
    );

  test('accepts a tree whose identity files are tracked and identical to HEAD', () => {
    const root = committedRepo(withBuild(BUILD + 3));
    const identity = expectAccepted(requireCommitted(root));
    expect(identity.committed).toBe(true);
    expect(identity.buildNumber).toBe(BUILD + 3);
    expect(identity.gitSha).toBe(git(['rev-parse', 'HEAD'], root).trim());
  });

  test('a tracked identity file edited under skip-worktree is refused (HEAD still says the old build)', () => {
    const root = committedRepo();
    writeIdentity(root, withBuild(BUILD + 3));
    git(
      [
        'update-index',
        '--skip-worktree',
        'infra/release/release-manifest.json',
        'apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj',
      ],
      root,
    );
    expect(git(['status', '--porcelain'], root).trim()).toBe('');
    expectRefusal(
      requireCommitted(root, '--latest-uploaded', String(BUILD + 2)),
      'uncommitted',
      'HEAD',
      'release-manifest.json',
    );
  });

  test('a tracked identity file edited under assume-unchanged is refused', () => {
    const root = committedRepo();
    writeIdentity(root, withBuild(BUILD + 3));
    git(
      [
        'update-index',
        '--assume-unchanged',
        'infra/release/release-manifest.json',
        'apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj',
      ],
      root,
    );
    expectRefusal(requireCommitted(root), 'uncommitted', 'HEAD');
  });

  test('identity files that git ignores (never tracked, no commit holds them) are refused', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'w11-release-identity-'),
    );
    fixtures.push(root);
    fs.writeFileSync(path.join(root, '.gitignore'), 'infra/\napps/\n', 'utf8');
    git(['init', '-q', '-b', 'main'], root);
    git(['add', '.gitignore'], root);
    git(['commit', '-q', '-m', 'ignore everything'], root);
    writeIdentity(root, withBuild(BUILD + 3));
    expect(git(['ls-files', '--', 'infra', 'apps'], root).trim()).toBe('');
    expectRefusal(requireCommitted(root), 'uncommitted', 'not tracked');
  });

  test('a staged-but-uncommitted identity edit is refused', () => {
    const root = committedRepo();
    writeIdentity(root, withBuild(BUILD + 3));
    git(['add', '-A'], root);
    expectRefusal(requireCommitted(root), 'uncommitted', 'HEAD');
  });

  test('an untracked identity that git status can see is refused', () => {
    const root = committedRepo();
    // Dropping the index makes every file untracked: git status reports `??`.
    fs.rmSync(path.join(root, '.git', 'index'), {
      recursive: true,
      force: true,
    });
    expectRefusal(requireCommitted(root), 'uncommitted', 'not tracked');
  });

  test('a git binary that cannot run fails closed', () => {
    const root = committedRepo();
    const emptyBin = path.join(root, 'empty-bin');
    fs.mkdirSync(emptyBin, { recursive: true });
    const result = runScript(
      [
        '--check',
        '--require-committed',
        '--json',
        '--mobile-root',
        mobile(root),
      ],
      mobile(root),
      { PATH: emptyBin },
    );
    expectRefusal(result, 'committed');
  });

  test('`--assert-git-sha` pins HEAD to the sha captured before the build', () => {
    const root = committedRepo();
    const head = git(['rev-parse', 'HEAD'], root).trim();
    expect(
      expectAccepted(requireCommitted(root, '--assert-git-sha', head)).gitSha,
    ).toBe(head);

    writeIdentity(root, withBuild(BUILD + 3));
    git(['add', '-A'], root);
    git(['commit', '-q', '-m', 'moved'], root);
    expectRefusal(
      requireCommitted(root, '--assert-git-sha', head),
      'HEAD',
      head,
    );
  });

  test('`--assert-git-sha` refuses a malformed sha and refuses when no HEAD is readable', () => {
    const root = committedRepo();
    expectRefusal(
      requireCommitted(root, '--assert-git-sha', 'HEAD'),
      '--assert-git-sha',
    );
    const plain = tree();
    const result = runScript(
      [
        '--check',
        '--assert-git-sha',
        '0123456789abcdef0123456789abcdef01234567',
        '--mobile-root',
        mobile(plain),
      ],
      mobile(plain),
    );
    expectRefusal(result, 'HEAD');
  });
});

// ─── Drift refusals ──────────────────────────────────────────────────────────

describe('release-identity.mjs refuses a drifted identity', () => {
  test('CURRENT_PROJECT_VERSION differing from the manifest in ONE configuration', () => {
    const mobileRoot = fixture({
      'ios/PickleSensei.xcodeproj/project.pbxproj': content =>
        content.replace(
          `CURRENT_PROJECT_VERSION = ${BUILD};`,
          `CURRENT_PROJECT_VERSION = ${BUILD + 41};`,
        ),
    });
    const result = runScript(['--check', '--mobile-root', mobileRoot]);
    expectRefusal(
      result,
      'CURRENT_PROJECT_VERSION',
      String(BUILD + 41),
      String(BUILD),
    );
  });

  test('CURRENT_PROJECT_VERSION missing from one configuration (not merely different)', () => {
    const mobileRoot = fixture({
      'ios/PickleSensei.xcodeproj/project.pbxproj': content =>
        content.replace(`\t\t\t\tCURRENT_PROJECT_VERSION = ${BUILD};\n`, ''),
    });
    const mutated = fs.readFileSync(
      path.join(mobileRoot, 'ios/PickleSensei.xcodeproj/project.pbxproj'),
      'utf8',
    );
    expect(mutated.match(/CURRENT_PROJECT_VERSION = /g)?.length).toBe(1);
    const result = runScript(['--check', '--mobile-root', mobileRoot]);
    expectRefusal(result, 'CURRENT_PROJECT_VERSION');
  });

  test('a pbxproj without an application target cannot be verified', () => {
    const mobileRoot = fixture({
      'ios/PickleSensei.xcodeproj/project.pbxproj': content =>
        content
          .split('productType = "com.apple.product-type.application";')
          .join('productType = "com.apple.product-type.framework";'),
    });
    const result = runScript(['--check', '--mobile-root', mobileRoot]);
    expectRefusal(result, 'application target');
  });

  test('manifest buildNumber moved without the Xcode project', () => {
    const mobileRoot = fixture({
      '../../infra/release/release-manifest.json': content =>
        content.replace(
          `"buildNumber": ${BUILD},`,
          `"buildNumber": ${BUILD + 1},`,
        ),
    });
    const result = runScript(['--check', '--mobile-root', mobileRoot]);
    expectRefusal(result, 'CURRENT_PROJECT_VERSION', String(BUILD + 1));
  });

  test('MARKETING_VERSION differing from the manifest', () => {
    const mobileRoot = fixture({
      'ios/PickleSensei.xcodeproj/project.pbxproj': content =>
        content
          .split(`MARKETING_VERSION = ${VERSION};`)
          .join('MARKETING_VERSION = 9.9;'),
    });
    const result = runScript(['--check', '--mobile-root', mobileRoot]);
    expectRefusal(result, 'MARKETING_VERSION', '9.9', VERSION);
  });

  test.each(['0', '-1', '"1"', '1.5', '9007199254740992', '1e20'])(
    'manifest build number %s (not a positive, exactly representable integer)',
    bad => {
      const mobileRoot = fixture({
        '../../infra/release/release-manifest.json': content =>
          content.replace(`"buildNumber": ${BUILD},`, `"buildNumber": ${bad},`),
      });
      const result = runScript(['--check', '--mobile-root', mobileRoot]);
      expectRefusal(result, 'buildNumber');
    },
  );

  test('Info.plist hardcoding CFBundleVersion instead of sourcing $(CURRENT_PROJECT_VERSION)', () => {
    const mobileRoot = fixture({
      'ios/PickleSensei/Info.plist': content =>
        content.replace(
          '<string>$(CURRENT_PROJECT_VERSION)</string>',
          `<string>${BUILD}</string>`,
        ),
    });
    const result = runScript(['--check', '--mobile-root', mobileRoot]);
    expectRefusal(result, 'CFBundleVersion', '$(CURRENT_PROJECT_VERSION)');
  });

  test('Info.plist hardcoding CFBundleShortVersionString instead of $(MARKETING_VERSION)', () => {
    const mobileRoot = fixture({
      'ios/PickleSensei/Info.plist': content =>
        content.replace(
          '<string>$(MARKETING_VERSION)</string>',
          `<string>${VERSION}</string>`,
        ),
    });
    const result = runScript(['--check', '--mobile-root', mobileRoot]);
    expectRefusal(result, 'CFBundleShortVersionString', '$(MARKETING_VERSION)');
  });

  test('INFOPLIST_FILE re-pointed at a plist that hardcodes CFBundleVersion is refused (the plist Xcode ships from is the one checked)', () => {
    const mobileRoot = fixture({
      'ios/PickleSensei.xcodeproj/project.pbxproj': content =>
        content
          .split('INFOPLIST_FILE = PickleSensei/Info.plist;')
          .join('INFOPLIST_FILE = PickleSensei/Release.plist;'),
    });
    fs.writeFileSync(
      path.join(mobileRoot, 'ios/PickleSensei/Release.plist'),
      readIdentityFile('ios/PickleSensei/Info.plist').replace(
        '<string>$(CURRENT_PROJECT_VERSION)</string>',
        `<string>${BUILD + 98}</string>`,
      ),
      'utf8',
    );
    const result = runScript(['--check', '--mobile-root', mobileRoot]);
    expectRefusal(result, 'CFBundleVersion', 'Release.plist');
  });

  test('app.json naming a module the native app does not start', () => {
    const mobileRoot = fixture({
      'app.json': content =>
        content.replace('"name": "PickleSensei"', '"name": "PickleSense"'),
    });
    const result = runScript(['--check', '--mobile-root', mobileRoot]);
    expectRefusal(result, 'app.json', 'PickleSense', 'PickleSensei');
  });

  test('app.json displayName naming a different app than the Info.plist display name', () => {
    const mobileRoot = fixture({
      'app.json': content =>
        content.replace(
          '"displayName": "PickleSensei"',
          '"displayName": "Pickle Sensei Pro"',
        ),
    });
    const result = runScript(['--check', '--mobile-root', mobileRoot]);
    expectRefusal(result, 'app.json', 'displayName', 'Pickle Sensei Pro');
  });

  test('runtimeConfig APP_VERSION differing from the manifest', () => {
    const mobileRoot = fixture({
      'src/config/runtimeConfig.ts': content =>
        content.replace(
          `const APP_VERSION = '${VERSION}';`,
          "const APP_VERSION = '9.9';",
        ),
    });
    const result = runScript(['--check', '--mobile-root', mobileRoot]);
    expectRefusal(result, 'APP_VERSION', '9.9', VERSION);
  });

  test('a missing identity file', () => {
    const mobileRoot = fixture();
    fs.rmSync(path.join(mobileRoot, 'app.json'), {
      recursive: true,
      force: true,
    });
    const result = runScript(['--check', '--mobile-root', mobileRoot]);
    expectRefusal(result, 'app.json');
  });
});

// ─── Upload gate: archive identity vs verified manifest ──────────────────────

describe('archive identity assertion (the upload gate)', () => {
  test('accepts an archive that carries exactly the verified identity', () => {
    const result = runScript([
      '--check',
      '--assert-version',
      VERSION,
      '--assert-build',
      String(BUILD),
    ]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  test('refuses an archive whose CFBundleVersion differs from the verified manifest', () => {
    const result = runScript([
      '--check',
      '--assert-version',
      VERSION,
      '--assert-build',
      String(BUILD + 1),
    ]);
    expectRefusal(result, 'CFBundleVersion', String(BUILD + 1), String(BUILD));
  });

  test('refuses an archive whose CFBundleShortVersionString differs from the verified manifest', () => {
    const result = runScript([
      '--check',
      '--assert-version',
      '9.9',
      '--assert-build',
      String(BUILD),
    ]);
    expectRefusal(result, 'CFBundleShortVersionString', '9.9', VERSION);
  });

  test('build numbers are compared exactly, never through a rounded double', () => {
    // 2^53 + 1 and 2^53 round to the same double; the manifest build is exact
    // and the archive value must differ from it as a decimal string.
    const result = runScript([
      '--check',
      '--assert-version',
      VERSION,
      '--assert-build',
      `${BUILD}9007199254740993`,
    ]);
    expectRefusal(result, 'CFBundleVersion', `${BUILD}9007199254740993`);
    const big = '100000000000000000000';
    const mobileRoot = fixture(withBuild(big));
    expectRefusal(
      runScript(
        [
          '--check',
          '--assert-version',
          VERSION,
          '--assert-build',
          '100000000000000000001',
          '--mobile-root',
          mobileRoot,
        ],
        mobileRoot,
      ),
      'buildNumber',
      'CFBundleVersion',
    );
  });

  test.each([
    'abc',
    '0',
    '-1',
    '+1',
    '1e0',
    '01',
    ' 1',
    '1 ',
    '',
    '１',
    'NaN',
    'Infinity',
  ])(
    'malformed archive build %j is refused, never treated as a match',
    value => {
      const result = runScript([
        '--check',
        '--assert-version',
        VERSION,
        '--assert-build',
        value,
      ]);
      expectRefusal(result, '--assert-build');
    },
  );

  test('a repeated --assert-build cannot downgrade a mismatch into a match', () => {
    const result = runScript([
      '--check',
      '--assert-build',
      String(BUILD + 1),
      '--assert-build',
      String(BUILD),
    ]);
    expectRefusal(result, '--assert-build', 'more than once');
  });

  test.each([
    ['--assert-version', VERSION],
    ['--latest-uploaded', '0'],
    ['--assert-git-sha', '0123456789abcdef0123456789abcdef01234567'],
    ['--mobile-root', MOBILE_ROOT],
    ['--check'],
    ['--json'],
    ['--require-committed'],
  ])('a repeated %s flag is refused', (...flag) => {
    const result = runScript(['--check', ...flag, ...flag]);
    expectRefusal(result, flag[0], 'more than once');
  });
});

// ─── Historical uploads: refuse, never choose ────────────────────────────────

describe('already-uploaded build numbers', () => {
  test('refuses when the committed build is not greater than the newest uploaded build', () => {
    for (const latest of [BUILD, BUILD + 2]) {
      const result = runScript([
        '--check',
        '--latest-uploaded',
        String(latest),
      ]);
      expectRefusal(result, `greater than ${latest}`, String(BUILD));
      // Refusal must not pick the next number for the owner.
      expect(result.stderr).not.toMatch(new RegExp(`\\b${latest + 1}\\b`));
    }
  });

  test('refuses a newest uploaded build beyond double precision without rounding it', () => {
    const latest = '99999999999999999999';
    const result = runScript(['--check', '--latest-uploaded', latest]);
    expectRefusal(result, `greater than ${latest}`, String(BUILD));
  });

  test('accepts when the committed build is greater than the newest uploaded build', () => {
    const result = runScript([
      '--check',
      '--latest-uploaded',
      String(BUILD - 1),
      '--json',
    ]);
    expect(expectAccepted(result).buildNumber).toBe(BUILD);
  });

  test.each(['none', '3.1', '-1', '+1', '１', '', ' 1'])(
    'a dotted or malformed newest-uploaded value %j (what fastlane returns for non-integer CFBundleVersions) is refused',
    value => {
      const result = runScript(['--check', '--latest-uploaded', value]);
      expectRefusal(result, '--latest-uploaded');
    },
  );

  test('rejects unknown flags', () => {
    const result = runScript(['--check', '--bump']);
    expectRefusal(result, '--bump');
  });
});

// ─── Gate ordering: what was verified is what is uploaded ────────────────────

describe('the archive gate re-applies every pre-build refusal', () => {
  test('a tree that moves to an already-uploaded build between the pre-build gate and the archive gate is refused before upload', () => {
    const latestUploaded = BUILD + 2;
    const root = committedRepo(withBuild(BUILD + 3));

    // Gate 1 exactly as `release_identity` runs it: committed build > newest uploaded.
    const gate1 = expectAccepted(
      runScript(
        [
          '--check',
          '--require-committed',
          '--json',
          '--latest-uploaded',
          String(latestUploaded),
          '--mobile-root',
          mobile(root),
        ],
        mobile(root),
      ),
    );
    expect(gate1.buildNumber).toBe(BUILD + 3);

    // xcodebuild runs for many minutes; the checkout moves to a commit whose
    // identity is a build App Store Connect already holds.
    writeIdentity(root, withBuild(BUILD + 1));
    git(['add', '-A'], root);
    git(['commit', '-q', '-m', 'older identity'], root);

    // Gate 2 exactly as `verify_archive_identity` runs it for the archive that
    // xcodebuild produced from that tree: the captured bound, build and sha all
    // travel with it.
    const gate2 = runScript(
      [
        '--check',
        '--require-committed',
        '--latest-uploaded',
        String(latestUploaded),
        '--assert-version',
        VERSION,
        '--assert-build',
        String(BUILD + 1),
        '--assert-git-sha',
        String(gate1.gitSha),
        '--mobile-root',
        mobile(root),
      ],
      mobile(root),
    );
    expectRefusal(
      gate2,
      `greater than ${latestUploaded}`,
      String(gate1.gitSha),
    );
  });
});

// ─── Fastfile wiring ─────────────────────────────────────────────────────────

describe('Fastfile builds from the committed identity and cannot increment', () => {
  const fastfile = fs.readFileSync(FASTFILE, 'utf8');

  function lane(name: string): string {
    const match = fastfile.match(
      new RegExp(`^  (?:private_)?lane :${name} do.*?^  end$`, 'ms'),
    );
    if (!match) {
      throw new Error(`lane :${name} not found in Fastfile`);
    }
    return match[0];
  }

  test('no lane increments or overrides the build number', () => {
    expect(fastfile).not.toMatch(
      /latest_testflight_build_number\([^)]*\)\s*\+/,
    );
    expect(fastfile).not.toMatch(/increment_build_number/);
    expect(fastfile).not.toMatch(/increment_version_number/);
    expect(fastfile).not.toMatch(/CURRENT_PROJECT_VERSION=/);
    expect(fastfile).not.toMatch(/MARKETING_VERSION=/);
    // `build(build_number: …)` (the old override); `initial_build_number:` is
    // the App Store Connect query's floor, not a build number we choose.
    expect(fastfile).not.toMatch(/(?<!initial_)build_number:/);
    expect(fastfile).not.toMatch(/agvtool/);
  });

  test('the build lane verifies the committed identity before archiving and the archive after, passing the captured identity and bound through', () => {
    const build = lane('build');
    const gate = build.indexOf('release_identity(');
    const archive = build.indexOf('build_app(');
    const verify = build.indexOf('verify_archive_identity(');
    expect(gate).toBeGreaterThan(-1);
    expect(archive).toBeGreaterThan(gate);
    expect(verify).toBeGreaterThan(archive);
    expect(build.slice(verify)).toMatch(/identity: identity/);
    expect(build.slice(verify)).toMatch(
      /latest_uploaded: options\[:latest_uploaded\]/,
    );
  });

  test('the identity gate runs scripts/release-identity.mjs --check on the committed files', () => {
    const gate = lane('release_identity');
    expect(gate).toContain('scripts/release-identity.mjs');
    expect(gate).toContain('"--check"');
    expect(gate).toContain('"--require-committed"');
    expect(gate).toContain('"--json"');
    expect(gate).toContain('"--latest-uploaded"');
  });

  test('the archive verification reads CFBundleVersion/CFBundleShortVersionString from the archive and asserts them against the identity captured BEFORE the build', () => {
    const verify = lane('verify_archive_identity');
    expect(verify).toContain('XCODEBUILD_ARCHIVE');
    expect(verify).toContain('CFBundleVersion');
    expect(verify).toContain('CFBundleShortVersionString');
    // The captured identity takes part in the decision, not only in a message.
    expect(verify).toMatch(/expected\["buildNumber"\]\.to_s\s*!=/);
    expect(verify).toMatch(/expected\["marketingVersion"\]\s*!=/);
    expect(verify).toMatch(/expected\["gitSha"\]/);
    expect(verify).toContain('UI.user_error!');
    // …and the script re-applies every pre-build refusal for the same bound.
    expect(verify).toContain('"--require-committed"');
    expect(verify).toContain('"--assert-build"');
    expect(verify).toContain('"--assert-version"');
    expect(verify).toContain('"--assert-git-sha"');
    expect(verify).toContain('"--latest-uploaded"');
  });

  test('both upload lanes build through the gated lane with the newest uploaded build as refusal input, then upload', () => {
    for (const [name, upload] of [
      ['beta', 'upload_to_testflight('],
      ['release', 'upload_to_app_store('],
    ] as const) {
      const text = lane(name);
      const latest = text.indexOf('latest_testflight_build_number(');
      const build = text.indexOf('build(latest_uploaded:');
      const uploadAt = text.indexOf(upload);
      expect(latest).toBeGreaterThan(-1);
      expect(build).toBeGreaterThan(-1);
      expect(uploadAt).toBeGreaterThan(build);
      expect(text).not.toMatch(/build_app\(/);
    }
  });

  test('the human approval boundary is preserved', () => {
    expect(fastfile).toContain('submit_for_review: false');
    expect(fastfile).toContain('distribute_external: false');
    expect(fastfile).toContain('skip_metadata: true');
    expect(fastfile).toContain('ENV.fetch("APP_STORE_CONNECT_API_KEY_KEY_ID")');
    expect(fastfile).not.toMatch(/FASTLANE_PASSWORD|-----BEGIN/);
  });

  // Every comment on the base revision (55d80326) whose code survives, kept
  // verbatim: "do not modify existing code comments" is a hard rule of the
  // work package. Only the block describing the removed
  // `CURRENT_PROJECT_VERSION=` xcargs override goes with its code.
  test.each([
    '# Fastfile — TestFlight internal distribution for PickleSensei.',
    '# HONESTY BOUNDARY: every lane here requires a Mac with Xcode and Apple',
    '# credentials. None of it can run — or be claimed to have run — on Linux.',
    '# What IS validated on Linux: the static distribution preconditions',
    '# (`npm run check:distribution` in apps/mobile) and the JS/TS gates.',
    '# Prerequisites on the Mac (see docs/DISTRIBUTION.md at the repo root):',
    '#   - Xcode installed, `bundle install` done in apps/mobile',
    '#   - `bundle exec pod install` done in apps/mobile/ios',
    '#   - App Store Connect API key exported as',
    "#     APP_STORE_CONNECT_API_KEY_KEY_ID / _ISSUER_ID / _KEY (or fastlane's",
    '#     app_store_connect_api_key file); never committed.',
    '    # Keep profile acquisition and export in the same lane context. Fastlane',
    '    # then reads the exact profile returned by sigh and supplies its real name',
    '    # to ExportOptions. Apple may suffix a replacement profile name when an',
    '    # expired profile still owns the canonical name, so a hardcoded profile',
    '    # specifier eventually breaks release builds.',
    '    # With the ASC API key in the environment, let xcodebuild do automatic',
    '    # (cloud-managed) signing headlessly: it can mint/refresh the Apple',
    '    # Distribution certificate and App Store profile without an Apple ID',
    '    # signed into Xcode. gym forwards these auth flags to -exportArchive on',
    '    # its own — do NOT also pass export_xcargs or the flags duplicate and',
    '    # xcodebuild aborts with "may only be provided once".',
    '      # The export re-signs with the Apple Distribution identity and exact',
    '      # profile that prep_signing installed. get_provisioning_profile records',
    '      # that profile in lane_context, and build_app adds the matching bundle-id',
    '      # mapping. Manual style avoids cloud-managed signing, which requires an',
    '      # Admin ASC key; the repo intentionally uses an App Manager key.',
    '  # Reads the App Store Connect API key from the environment: either the raw',
    '  # key content (APP_STORE_CONNECT_API_KEY_KEY) or a path to the .p8 file',
    '  # (APP_STORE_CONNECT_API_KEY_KEY_FILEPATH). Never committed.',
    '      development: false, # Apple Distribution',
    '    # initial_build_number 0 → the very first upload becomes build 1.',
    '      distribute_external: false, # internal testers only; external needs App Review',
    '      precheck_include_in_app_purchases: false, # precheck cannot use API keys for IAP',
    '      submit_for_review: false, # review submission is a human decision',
  ])('keeps the base comment %j verbatim', comment => {
    expect(fastfile.split('\n')).toContain(comment);
  });
});

// ─── Documentation ───────────────────────────────────────────────────────────

describe('docs/DISTRIBUTION.md', () => {
  const doc = fs.readFileSync(DISTRIBUTION_DOC, 'utf8');

  test('documents the committed identity flow and its refusal', () => {
    expect(doc).toContain('node scripts/release-identity.mjs --check');
    expect(doc).toContain('infra/release/release-manifest.json');
    expect(doc).toContain('--require-committed');
    expect(doc).toContain('--latest-uploaded');
    expect(doc).toContain('--assert-build');
    expect(doc).toMatch(/refuse/i);
    expect(doc).not.toMatch(/bumps? the build number/i);
  });

  test('preserves the historical builds 1–3 note and leaves the next build number to the owner', () => {
    expect(doc).toMatch(/builds 1, 2 and 3/);
    expect(doc).toMatch(/greater than 3/);
    expect(doc).toMatch(/owner/i);
  });
});
