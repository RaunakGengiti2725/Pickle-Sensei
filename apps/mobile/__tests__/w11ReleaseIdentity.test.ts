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
 *     (`infra/release/release-manifest.json`), `project.pbxproj`, `Info.plist`,
 *     `app.json`, `AppDelegate.swift` and `runtimeConfig.ts` agree, and refuses
 *     (exit 1, no JSON) when any of them drifts;
 *   - `--assert-version/--assert-build` refuse an archive whose identity differs
 *     from the verified manifest (the upload gate);
 *   - `--latest-uploaded N` refuses a build number that is not greater than the
 *     newest build already on App Store Connect WITHOUT choosing a replacement
 *     (the next build number is an owner decision);
 *   - the Fastfile builds from the committed identity, never increments, and
 *     verifies the archive before either upload action;
 *   - docs/DISTRIBUTION.md documents the flow and keeps the builds 1–3 history.
 *
 * Static + subprocess tests only: nothing here needs Xcode, signing or Apple
 * credentials, and nothing here uploads anything.
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

interface ReleaseIdentity {
  marketingVersion: string;
  buildNumber: number;
  bundleIdentifier: string;
  moduleName: string;
  displayName: string;
  gitSha: string | null;
  committed: boolean;
  identityFiles: string[];
}

function runScript(args: string[], cwd: string = MOBILE_ROOT) {
  const result = childProcess.spawnSync(execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20_000,
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`spawn failed: ${JSON.stringify(result.error)}`);
  }
  return result;
}

function git(args: string[]): string {
  const result = childProcess.spawnSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 20_000,
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
  });
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
 * and applies the given mutations. Returns the fixture's mobile root.
 */
const fixtures: string[] = [];
function fixture(
  mutations: Partial<Record<IdentityFile, (content: string) => string>>,
): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w11-release-identity-'));
  fixtures.push(root);
  const mobileRoot = path.join(root, 'apps', 'mobile');
  for (const name of IDENTITY_FILES) {
    const target = path.resolve(mobileRoot, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const mutate = mutations[name];
    const content = readIdentityFile(name);
    fs.writeFileSync(target, mutate ? mutate(content) : content, 'utf8');
  }
  return mobileRoot;
}
afterAll(() => {
  for (const root of fixtures) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function expectRefusal(
  result: { status: number | null; stdout: string; stderr: string },
  ...fragments: string[]
) {
  expect(result.status).toBe(1);
  // No identity JSON may reach a consumer when the check refused.
  expect(result.stdout.trim()).toBe('');
  for (const fragment of fragments) {
    expect(result.stderr).toContain(fragment);
  }
}

// ─── The committed identity on this revision ─────────────────────────────────

describe('committed release identity (manifest ↔ pbxproj ↔ app.json)', () => {
  test('the verified manifest carries a well-formed version and build', () => {
    expect(manifest.versionScheme.marketingVersion).toMatch(
      /^\d+\.\d+(\.\d+)?$/,
    );
    expect(Number.isInteger(manifest.versionScheme.buildNumber)).toBe(true);
    expect(manifest.versionScheme.buildNumber).toBeGreaterThan(0);
  });

  test('every Xcode configuration carries exactly the manifest identity', () => {
    const versions = pbxValues('MARKETING_VERSION');
    const builds = pbxValues('CURRENT_PROJECT_VERSION');
    expect(versions.length).toBeGreaterThan(0);
    expect(builds.length).toBe(versions.length);
    expect(new Set(versions)).toEqual(
      new Set([manifest.versionScheme.marketingVersion]),
    );
    expect(new Set(builds)).toEqual(
      new Set([String(manifest.versionScheme.buildNumber)]),
    );
  });

  test('`release-identity.mjs --check` passes on this revision', () => {
    const result = runScript(['--check']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(manifest.versionScheme.marketingVersion);
    expect(result.stdout).toContain(String(manifest.versionScheme.buildNumber));
  });

  test('`--check --json` emits exactly one JSON identity that matches the committed files', () => {
    const result = runScript(['--check', '--json']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const identity = JSON.parse(result.stdout) as ReleaseIdentity;
    expect(identity.marketingVersion).toBe(
      manifest.versionScheme.marketingVersion,
    );
    expect(identity.buildNumber).toBe(manifest.versionScheme.buildNumber);
    expect(identity.bundleIdentifier).toBe('com.picklesensei');
    expect(identity.moduleName).toBe('PickleSensei');
    expect(identity.displayName).toBe('Pickle Sensei');
    expect(identity.gitSha).toBe(git(['rev-parse', 'HEAD']).trim());
    expect(identity.identityFiles).toEqual(
      IDENTITY_FILES.map(name => path.resolve(MOBILE_ROOT, name)),
    );
    // Committed ⇔ none of the identity files has uncommitted modifications.
    const dirty = git([
      'status',
      '--porcelain',
      '--',
      ...identity.identityFiles,
    ]);
    expect(identity.committed).toBe(dirty.trim() === '');
  });

  test('`--require-committed` follows the working tree state of the identity files', () => {
    const dirty = git([
      'status',
      '--porcelain',
      '--',
      ...IDENTITY_FILES.map(name => path.resolve(MOBILE_ROOT, name)),
    ]);
    const result = runScript(['--check', '--require-committed', '--json']);
    if (dirty.trim() === '') {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    } else {
      expectRefusal(result, 'uncommitted');
    }
  });

  test('`--require-committed` refuses outside a git checkout (identity cannot be proven committed)', () => {
    const mobileRoot = fixture({});
    const result = runScript(
      ['--check', '--require-committed', '--mobile-root', mobileRoot],
      mobileRoot,
    );
    expectRefusal(result, 'committed');
  });
});

// ─── Drift refusals ──────────────────────────────────────────────────────────

describe('release-identity.mjs refuses a drifted identity', () => {
  const version = manifest.versionScheme.marketingVersion;
  const build = manifest.versionScheme.buildNumber;

  test('CURRENT_PROJECT_VERSION differing from the manifest in ONE configuration', () => {
    const mobileRoot = fixture({
      'ios/PickleSensei.xcodeproj/project.pbxproj': content =>
        content.replace(
          `CURRENT_PROJECT_VERSION = ${build};`,
          `CURRENT_PROJECT_VERSION = ${build + 41};`,
        ),
    });
    const result = runScript(['--check', '--mobile-root', mobileRoot]);
    expectRefusal(
      result,
      'CURRENT_PROJECT_VERSION',
      String(build + 41),
      String(build),
    );
  });

  test('manifest buildNumber moved without the Xcode project', () => {
    const mobileRoot = fixture({
      '../../infra/release/release-manifest.json': content =>
        content.replace(
          `"buildNumber": ${build},`,
          `"buildNumber": ${build + 1},`,
        ),
    });
    const result = runScript(['--check', '--mobile-root', mobileRoot]);
    expectRefusal(result, 'CURRENT_PROJECT_VERSION', String(build + 1));
  });

  test('MARKETING_VERSION differing from the manifest', () => {
    const mobileRoot = fixture({
      'ios/PickleSensei.xcodeproj/project.pbxproj': content =>
        content
          .split(`MARKETING_VERSION = ${version};`)
          .join('MARKETING_VERSION = 9.9;'),
    });
    const result = runScript(['--check', '--mobile-root', mobileRoot]);
    expectRefusal(result, 'MARKETING_VERSION', '9.9', version);
  });

  test('a non-integer or non-positive manifest build number', () => {
    for (const bad of ['0', '-1', '"1"', '1.5']) {
      const mobileRoot = fixture({
        '../../infra/release/release-manifest.json': content =>
          content.replace(`"buildNumber": ${build},`, `"buildNumber": ${bad},`),
      });
      const result = runScript(['--check', '--mobile-root', mobileRoot]);
      expectRefusal(result, 'buildNumber');
    }
  });

  test('Info.plist hardcoding CFBundleVersion instead of sourcing $(CURRENT_PROJECT_VERSION)', () => {
    const mobileRoot = fixture({
      'ios/PickleSensei/Info.plist': content =>
        content.replace(
          '<string>$(CURRENT_PROJECT_VERSION)</string>',
          `<string>${build}</string>`,
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
          `<string>${version}</string>`,
        ),
    });
    const result = runScript(['--check', '--mobile-root', mobileRoot]);
    expectRefusal(result, 'CFBundleShortVersionString', '$(MARKETING_VERSION)');
  });

  test('app.json naming a module the native app does not start', () => {
    const mobileRoot = fixture({
      'app.json': content =>
        content.replace('"name": "PickleSensei"', '"name": "PickleSense"'),
    });
    const result = runScript(['--check', '--mobile-root', mobileRoot]);
    expectRefusal(result, 'app.json', 'PickleSense', 'PickleSensei');
  });

  test('app.json displayName differing from the Info.plist display name', () => {
    const mobileRoot = fixture({
      'app.json': content =>
        content.replace(
          '"displayName": "PickleSensei"',
          '"displayName": "Pickle  Sensei"',
        ),
    });
    const result = runScript(['--check', '--mobile-root', mobileRoot]);
    expectRefusal(result, 'app.json', 'displayName');
  });

  test('runtimeConfig APP_VERSION differing from the manifest', () => {
    const mobileRoot = fixture({
      'src/config/runtimeConfig.ts': content =>
        content.replace(
          `const APP_VERSION = '${version}';`,
          "const APP_VERSION = '9.9';",
        ),
    });
    const result = runScript(['--check', '--mobile-root', mobileRoot]);
    expectRefusal(result, 'APP_VERSION', '9.9', version);
  });

  test('a missing identity file', () => {
    const mobileRoot = fixture({});
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
  const version = manifest.versionScheme.marketingVersion;
  const build = manifest.versionScheme.buildNumber;

  test('accepts an archive that carries exactly the verified identity', () => {
    const result = runScript([
      '--check',
      '--assert-version',
      version,
      '--assert-build',
      String(build),
    ]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  test('refuses an archive whose CFBundleVersion differs from the verified manifest', () => {
    const result = runScript([
      '--check',
      '--assert-version',
      version,
      '--assert-build',
      String(build + 1),
    ]);
    expectRefusal(result, 'CFBundleVersion', String(build + 1), String(build));
  });

  test('refuses an archive whose CFBundleShortVersionString differs from the verified manifest', () => {
    const result = runScript([
      '--check',
      '--assert-version',
      '9.9',
      '--assert-build',
      String(build),
    ]);
    expectRefusal(result, 'CFBundleShortVersionString', '9.9', version);
  });

  test('refuses a malformed assertion instead of treating it as a match', () => {
    const result = runScript(['--check', '--assert-build', 'abc']);
    expectRefusal(result, '--assert-build');
  });
});

// ─── Historical uploads: refuse, never choose ────────────────────────────────

describe('already-uploaded build numbers', () => {
  const build = manifest.versionScheme.buildNumber;

  test('refuses when the committed build is not greater than the newest uploaded build', () => {
    for (const latest of [build, build + 2]) {
      const result = runScript([
        '--check',
        '--latest-uploaded',
        String(latest),
      ]);
      expectRefusal(result, `greater than ${latest}`, String(build));
      // Refusal must not pick the next number for the owner.
      expect(result.stderr).not.toContain(`${latest + 1}`);
    }
  });

  test('accepts when the committed build is greater than the newest uploaded build', () => {
    const result = runScript([
      '--check',
      '--latest-uploaded',
      String(build - 1),
      '--json',
    ]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect((JSON.parse(result.stdout) as ReleaseIdentity).buildNumber).toBe(
      build,
    );
  });

  test('refuses a malformed latest-uploaded value', () => {
    const result = runScript(['--check', '--latest-uploaded', 'none']);
    expectRefusal(result, '--latest-uploaded');
  });

  test('rejects unknown flags', () => {
    const result = runScript(['--check', '--bump']);
    expectRefusal(result, '--bump');
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
    expect(fastfile).not.toMatch(/build_number:/);
    expect(fastfile).not.toMatch(/agvtool/);
  });

  test('the build lane verifies the committed identity before archiving and the archive after', () => {
    const build = lane('build');
    const gate = build.indexOf('release_identity(');
    const archive = build.indexOf('build_app(');
    const verify = build.indexOf('verify_archive_identity');
    expect(gate).toBeGreaterThan(-1);
    expect(archive).toBeGreaterThan(gate);
    expect(verify).toBeGreaterThan(archive);
  });

  test('the identity gate runs scripts/release-identity.mjs --check on the committed files', () => {
    const gate = lane('release_identity');
    expect(gate).toContain('scripts/release-identity.mjs');
    expect(gate).toContain('"--check"');
    expect(gate).toContain('"--require-committed"');
    expect(gate).toContain('"--json"');
    expect(gate).toContain('"--latest-uploaded"');
  });

  test('the archive verification reads CFBundleVersion/CFBundleShortVersionString from the archive and asserts them', () => {
    const verify = lane('verify_archive_identity');
    expect(verify).toContain('XCODEBUILD_ARCHIVE');
    expect(verify).toContain('CFBundleVersion');
    expect(verify).toContain('CFBundleShortVersionString');
    expect(verify).toContain('"--assert-build"');
    expect(verify).toContain('"--assert-version"');
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
});

// ─── Documentation ───────────────────────────────────────────────────────────

describe('docs/DISTRIBUTION.md', () => {
  const doc = fs.readFileSync(DISTRIBUTION_DOC, 'utf8');

  test('documents the committed identity flow and its refusal', () => {
    expect(doc).toContain('node scripts/release-identity.mjs --check');
    expect(doc).toContain('infra/release/release-manifest.json');
    expect(doc).toMatch(/refuse/i);
    expect(doc).not.toMatch(/bumps? the build number/i);
  });

  test('preserves the historical builds 1–3 note and leaves the next build number to the owner', () => {
    expect(doc).toMatch(/builds 1, 2 and 3/);
    expect(doc).toMatch(/greater than 3/);
    expect(doc).toMatch(/owner/i);
  });
});
