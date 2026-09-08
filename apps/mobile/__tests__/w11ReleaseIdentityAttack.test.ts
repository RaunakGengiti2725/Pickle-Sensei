/**
 * W11-08 adversarial suite — attacks on the immutable release identity gate
 * (`scripts/release-identity.mjs` + `ios/fastlane/Fastfile`) at its failure
 * boundaries. Every test states the behaviour the package promises; a failing
 * test is a confirmed break of that promise on the attacked revision.
 *
 * Static + subprocess only: throwaway git repositories under the OS tmpdir,
 * no Xcode, no signing, no upload.
 */

// Module scope on purpose: the `declare const` shims below must stay local to
// this file rather than becoming global declarations.
export {};

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

const IDENTITY_FILES = [
  'infra/release/release-manifest.json',
  'apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj',
  'apps/mobile/ios/PickleSensei/Info.plist',
  'apps/mobile/ios/PickleSensei/AppDelegate.swift',
  'apps/mobile/app.json',
  'apps/mobile/src/config/runtimeConfig.ts',
] as const;
type IdentityFile = (typeof IDENTITY_FILES)[number];

interface ReleaseIdentity {
  marketingVersion: string;
  buildNumber: number;
  gitSha: string | null;
  committed: boolean;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runScript(
  args: string[],
  cwd: string,
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

function git(cwd: string, args: string[]): string {
  const result = childProcess.spawnSync(
    'git',
    [
      '-c',
      'user.name=w11-attack',
      '-c',
      'user.email=w11@example.invalid',
      ...args,
    ],
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

const manifest = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, IDENTITY_FILES[0]), 'utf8'),
) as { versionScheme: { marketingVersion: string; buildNumber: number } };
const VERSION = manifest.versionScheme.marketingVersion;
const BUILD = manifest.versionScheme.buildNumber;

const fixtures: string[] = [];
afterAll(() => {
  for (const root of fixtures) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** Copies the real identity files into a throwaway repo-shaped tree. */
function tree(
  mutations: Partial<Record<IdentityFile, (content: string) => string>> = {},
): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w11-attack-'));
  fixtures.push(root);
  writeIdentity(root, mutations);
  return root;
}

function writeIdentity(
  root: string,
  mutations: Partial<Record<IdentityFile, (content: string) => string>>,
) {
  for (const name of IDENTITY_FILES) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const mutate = mutations[name];
    const content = fs.readFileSync(path.join(REPO_ROOT, name), 'utf8');
    fs.writeFileSync(target, mutate ? mutate(content) : content, 'utf8');
  }
}

/** Mutations that move the whole coherent identity to build `n`. */
function withBuild(
  n: number | string,
): Partial<Record<IdentityFile, (content: string) => string>> {
  return {
    'infra/release/release-manifest.json': content =>
      content.replace(`"buildNumber": ${BUILD},`, `"buildNumber": ${n},`),
    'apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj': content =>
      content
        .split(`CURRENT_PROJECT_VERSION = ${BUILD};`)
        .join(`CURRENT_PROJECT_VERSION = ${n};`),
  };
}

/** A throwaway git repository whose HEAD commits the given identity tree. */
function committedRepo(
  mutations: Partial<Record<IdentityFile, (content: string) => string>> = {},
): string {
  const root = tree(mutations);
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'identity']);
  return root;
}

function expectRefusal(result: RunResult, ...fragments: string[]) {
  expect(result.status).toBe(1);
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

const mobile = (root: string) => path.join(root, 'apps', 'mobile');

// ─── ATTACK 1: "committed" must mean "identical to HEAD", not "git status is quiet"

describe('ATTACK --require-committed: the identity must be provably the one at HEAD', () => {
  test('a tracked identity file edited under skip-worktree is refused (HEAD still says the old build)', () => {
    const root = committedRepo();
    writeIdentity(root, withBuild(BUILD + 3));
    git(root, [
      'update-index',
      '--skip-worktree',
      IDENTITY_FILES[0],
      IDENTITY_FILES[1],
    ]);
    const result = runScript(
      [
        '--check',
        '--require-committed',
        '--json',
        '--mobile-root',
        mobile(root),
        '--latest-uploaded',
        String(BUILD + 2),
      ],
      mobile(root),
    );
    // HEAD commits build BUILD; the working tree carries BUILD + 3. Nothing at
    // HEAD carries the identity that would ship, so it is not committed.
    expect(
      git(root, ['show', `HEAD:${IDENTITY_FILES[0]}`]).includes(
        `"buildNumber": ${BUILD},`,
      ),
    ).toBe(true);
    expectRefusal(result, 'committed');
  });

  test('a tracked identity file edited under assume-unchanged is refused', () => {
    const root = committedRepo();
    writeIdentity(root, withBuild(BUILD + 3));
    git(root, [
      'update-index',
      '--assume-unchanged',
      IDENTITY_FILES[0],
      IDENTITY_FILES[1],
    ]);
    const result = runScript(
      [
        '--check',
        '--require-committed',
        '--json',
        '--mobile-root',
        mobile(root),
      ],
      mobile(root),
    );
    expectRefusal(result, 'committed');
  });

  test('identity files that git ignores (never tracked, no commit holds them) are refused', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w11-attack-'));
    fixtures.push(root);
    fs.writeFileSync(path.join(root, '.gitignore'), 'infra/\napps/\n', 'utf8');
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['add', '.gitignore']);
    git(root, ['commit', '-q', '-m', 'ignore everything']);
    writeIdentity(root, withBuild(BUILD + 3));
    expect(git(root, ['ls-files', '--', 'infra', 'apps']).trim()).toBe('');
    const result = runScript(
      [
        '--check',
        '--require-committed',
        '--json',
        '--mobile-root',
        mobile(root),
      ],
      mobile(root),
    );
    expectRefusal(result, 'committed');
  });

  test('control: an untracked identity that git status can see is refused', () => {
    const root = committedRepo();
    // Dropping the index makes every file untracked: git status reports `??`.
    fs.rmSync(path.join(root, '.git', 'index'), {
      recursive: true,
      force: true,
    });
    const result = runScript(
      [
        '--check',
        '--require-committed',
        '--json',
        '--mobile-root',
        mobile(root),
      ],
      mobile(root),
    );
    expectRefusal(result, 'uncommitted');
  });
});

// ─── ATTACK 2: the two Mac gates are not one atomic decision

describe('ATTACK gate ordering: the archive gate must re-apply every pre-build refusal', () => {
  test('a tree that moves to an already-uploaded build between the pre-build gate and the archive gate is refused before upload', () => {
    const latestUploaded = BUILD + 2;
    const root = committedRepo(withBuild(BUILD + 3));

    // Gate 1 exactly as `release_identity` runs it: committed build > newest uploaded.
    const gate1 = runScript(
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
    );
    expect(expectAccepted(gate1).buildNumber).toBe(BUILD + 3);

    // xcodebuild runs for many minutes; the checkout moves to a commit whose
    // identity is a build App Store Connect already holds.
    writeIdentity(root, withBuild(BUILD + 1));
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'older identity']);

    // Gate 2 exactly as `verify_archive_identity` runs it for the archive that
    // xcodebuild produced from that tree.
    const gate2 = runScript(
      [
        '--check',
        '--require-committed',
        '--assert-version',
        VERSION,
        '--assert-build',
        String(BUILD + 1),
        '--mobile-root',
        mobile(root),
      ],
      mobile(root),
    );
    // Build BUILD + 1 <= newest uploaded BUILD + 2: the package promises the
    // lane refuses to upload it. Nothing in the archive gate re-checks that.
    expectRefusal(gate2, `greater than ${latestUploaded}`);
  });
});

// ─── ATTACK 3: numeric boundaries of the archive assertion

describe('ATTACK --assert-build boundaries', () => {
  test('an archive build that differs from the manifest only beyond double precision is still refused', () => {
    const big = '100000000000000000000';
    const bigPlusOne = '100000000000000000001';
    const root = tree(withBuild(big));
    const result = runScript(
      [
        '--check',
        '--assert-version',
        VERSION,
        '--assert-build',
        bigPlusOne,
        '--mobile-root',
        mobile(root),
      ],
      mobile(root),
    );
    expectRefusal(result, 'CFBundleVersion');
  });

  test.each([
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
      const result = runScript(
        ['--check', '--assert-version', VERSION, '--assert-build', value],
        MOBILE_ROOT,
      );
      expectRefusal(result, '--assert-build');
    },
  );

  test.each(['3.1', '-1', '１', '', 'none'])(
    'a dotted or malformed newest-uploaded value %j (what fastlane returns for non-integer CFBundleVersions) is refused',
    value => {
      const result = runScript(
        ['--check', '--latest-uploaded', value],
        MOBILE_ROOT,
      );
      expectRefusal(result, '--latest-uploaded');
    },
  );

  test('a repeated --assert-build cannot downgrade a mismatch into a match', () => {
    const result = runScript(
      [
        '--check',
        '--assert-build',
        String(BUILD + 1),
        '--assert-build',
        String(BUILD),
      ],
      MOBILE_ROOT,
    );
    expectRefusal(result);
  });
});

// ─── ATTACK 4: the static gate must check the files Xcode actually ships from

describe('ATTACK static coherence: what the pbxproj really points at', () => {
  test('INFOPLIST_FILE re-pointed at a plist that hardcodes CFBundleVersion is refused', () => {
    const root = tree({
      'apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj': content =>
        content
          .split('INFOPLIST_FILE = PickleSensei/Info.plist;')
          .join('INFOPLIST_FILE = PickleSensei/Release.plist;'),
    });
    const infoPlist = fs.readFileSync(
      path.join(REPO_ROOT, 'apps/mobile/ios/PickleSensei/Info.plist'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(root, 'apps/mobile/ios/PickleSensei/Release.plist'),
      infoPlist.replace(
        '<string>$(CURRENT_PROJECT_VERSION)</string>',
        `<string>${BUILD + 98}</string>`,
      ),
      'utf8',
    );
    const result = runScript(
      ['--check', '--mobile-root', mobile(root)],
      mobile(root),
    );
    expectRefusal(result, 'CFBundleVersion');
  });

  test('CURRENT_PROJECT_VERSION missing from one configuration (not merely different) is refused', () => {
    const root = tree({
      'apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj': content =>
        content.replace(`\t\t\t\tCURRENT_PROJECT_VERSION = ${BUILD};\n`, ''),
    });
    const pbxproj = fs.readFileSync(path.join(root, IDENTITY_FILES[1]), 'utf8');
    expect(pbxproj.match(/CURRENT_PROJECT_VERSION = /g)?.length).toBe(1);
    expect(pbxproj.match(/MARKETING_VERSION = /g)?.length).toBe(2);
    const result = runScript(
      ['--check', '--mobile-root', mobile(root)],
      mobile(root),
    );
    expectRefusal(result, 'CURRENT_PROJECT_VERSION');
  });

  test('a git binary that cannot run fails closed under --require-committed', () => {
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

  test('a staged-but-uncommitted identity edit is refused', () => {
    const root = committedRepo();
    writeIdentity(root, withBuild(BUILD + 3));
    git(root, ['add', '-A']);
    const result = runScript(
      [
        '--check',
        '--require-committed',
        '--json',
        '--mobile-root',
        mobile(root),
      ],
      mobile(root),
    );
    expectRefusal(result, 'uncommitted');
  });
});

// ─── ATTACK 5: Fastfile hard rules — existing comments must survive the change

describe('ATTACK Fastfile: existing code comments are not modified', () => {
  const fastfile = fs.readFileSync(FASTFILE, 'utf8');

  // Comments present on BASE_SHA 55d80326 whose code is still present on the
  // attacked revision. "Do not modify existing code comments" is a hard rule
  // of the work package.
  test.each([
    'HONESTY BOUNDARY: every lane here requires a Mac with Xcode and Apple',
    'Keep profile acquisition and export in the same lane context.',
    'do NOT also pass export_xcargs or the flags duplicate and',
    'Manual style avoids cloud-managed signing, which requires an',
    'Reads the App Store Connect API key from the environment: either the raw',
    'development: false, # Apple Distribution',
    'distribute_external: false, # internal testers only; external needs App Review',
    'precheck_include_in_app_purchases: false, # precheck cannot use API keys for IAP',
    'submit_for_review: false, # review submission is a human decision',
  ])('keeps the base comment %j', comment => {
    expect(fastfile).toContain(comment);
  });

  test('the archive gate asserts against the identity captured BEFORE the build, not only against files re-read after it', () => {
    const verify = fastfile.match(
      /^ {2}private_lane :verify_archive_identity do.*?^ {2}end$/ms,
    );
    expect(verify).not.toBeNull();
    const text = verify ? verify[0] : '';
    // The captured identity must take part in a decision (a comparison or a
    // user_error), not only in a UI.message.
    expect(text).toMatch(
      /expected\[['"](buildNumber|gitSha)['"]\][^\n]*(==|!=)|(==|!=)[^\n]*expected\[['"](buildNumber|gitSha)['"]\]/,
    );
  });
});
