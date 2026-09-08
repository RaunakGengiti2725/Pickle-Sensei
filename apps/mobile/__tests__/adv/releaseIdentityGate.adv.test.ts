/**
 * INT-release-config adversary — the release gates as processes.
 *
 * Attacked head: 30a4065036a917514fb4984fde73f87867f38619.
 *
 * Drives `apps/mobile/scripts/release-identity.mjs` (the fastlane pre-archive
 * and archive gate) and `tools/release/check-release-manifest.mjs`
 * (`pnpm release:check`) as subprocesses against the committed tree and
 * against throwaway copies mutated the way a broken release would be:
 *
 *   - the documented App Store Connect state (newest uploaded build) fed to
 *     the gate exactly as the `beta`/`release` lanes feed it;
 *   - a manifest that claims no production origin is committed while
 *     runtimeConfig.ts commits one;
 *   - a plist with two CFBundleVersion keys (first sourced, second hardcoded);
 *   - identity files truncated mid-write (process death during an edit);
 *   - the same gate run twice (double action) — must be idempotent and
 *     must not write.
 *
 * Nothing here needs Xcode, signing or Apple credentials; nothing uploads.
 *
 *   cd apps/mobile && npx jest --ci __tests__/adv/releaseIdentityGate.adv.test.ts
 */

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
  cpSync: (src: string, dest: string, options: { recursive: true }) => void;
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
    error?: { code?: string };
    stdout: string;
    stderr: string;
  };
};

const MOBILE_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(MOBILE_ROOT, '..', '..');
const IDENTITY_SCRIPT = path.join(
  MOBILE_ROOT,
  'scripts',
  'release-identity.mjs',
);

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(executable: string, args: string[], cwd: string): RunResult {
  const result = childProcess.spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    timeout: 20_000,
    killSignal: 'SIGKILL',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`spawn failed: ${JSON.stringify(result.error)}`);
  }
  return result;
}

const identityGate = (args: string[], cwd: string = MOBILE_ROOT) =>
  run(execPath, [IDENTITY_SCRIPT, ...args], cwd);
// check-release-manifest.mjs resolves the repo root from its own location, so
// a fixture tree gets a byte-identical copy of the script at the same path.
const manifestGate = (root: string = REPO_ROOT) =>
  run(
    execPath,
    [path.join(root, 'tools', 'release', 'check-release-manifest.mjs')],
    root,
  );
const git = (args: string[], cwd: string = REPO_ROOT) =>
  run('git', args, cwd).stdout;

// Files the two gates read, relative to the repo root.
const GATE_FILES = [
  'infra/release/release-manifest.json',
  'apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj',
  'apps/mobile/ios/PickleSensei/Info.plist',
  'apps/mobile/ios/PickleSensei/AppDelegate.swift',
  'apps/mobile/app.json',
  'apps/mobile/src/config/runtimeConfig.ts',
  'apps/mobile/android/app/build.gradle',
  'tools/release/check-release-manifest.mjs',
] as const;
type GateFile = (typeof GATE_FILES)[number];
type Mutations = Partial<Record<GateFile, (content: string) => string>>;

const fixtures: string[] = [];
/** Copies the gate inputs into a throwaway repo-shaped tree, mutated. */
function tree(mutations: Mutations = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-release-config-'));
  fixtures.push(root);
  for (const name of GATE_FILES) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const content = fs.readFileSync(path.join(REPO_ROOT, name), 'utf8');
    const mutate = mutations[name];
    fs.writeFileSync(target, mutate ? mutate(content) : content, 'utf8');
  }
  return root;
}
const mobile = (root: string) => path.join(root, 'apps', 'mobile');
afterAll(() => {
  for (const root of fixtures) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const manifest = JSON.parse(
  fs.readFileSync(
    path.join(REPO_ROOT, 'infra/release/release-manifest.json'),
    'utf8',
  ),
) as { versionScheme: { marketingVersion: string; buildNumber: number } };
const VERSION = manifest.versionScheme.marketingVersion;
const BUILD = manifest.versionScheme.buildNumber;
const distributionDoc = fs.readFileSync(
  path.join(REPO_ROOT, 'docs/DISTRIBUTION.md'),
  'utf8',
);
const NEWEST_UPLOADED = distributionDoc.match(
  /build number\s+greater than (\d+)/i,
)?.[1];

function expectRefusal(result: RunResult, ...fragments: string[]) {
  expect(result.status).toBe(1);
  expect(result.stdout.trim()).toBe('');
  for (const fragment of fragments) {
    expect(result.stderr).toContain(fragment);
  }
}

// ─── G1: the gates on the committed tree ─────────────────────────────────────

describe('G1 gates on the committed tree', () => {
  test('release-identity.mjs --check --json accepts the committed identity', () => {
    const result = identityGate(['--check', '--json']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const identity = JSON.parse(result.stdout) as {
      marketingVersion: string;
      buildNumber: number;
      gitSha: string | null;
    };
    expect(identity.marketingVersion).toBe(VERSION);
    expect(identity.buildNumber).toBe(BUILD);
    expect(identity.gitSha).toBe(git(['rev-parse', 'HEAD']).trim());
  });

  test('check-release-manifest.mjs passes on the committed tree', () => {
    const result = manifestGate();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('All release-manifest checks passed.');
  });
});

// ─── G2: the documented App Store Connect state ──────────────────────────────

describe('G2 the beta/release lanes with the documented newest uploaded build', () => {
  test('docs/DISTRIBUTION.md documents the newest uploaded build (evidence input)', () => {
    expect(NEWEST_UPLOADED).toMatch(/^\d+$/);
  });

  test('the pre-archive gate accepts the committed identity against the documented newest uploaded build', () => {
    // `lane :beta` / `lane :release` run exactly this with
    // latest_testflight_build_number as --latest-uploaded. A refusal here
    // means this revision cannot produce an uploadable archive.
    const result = identityGate([
      '--check',
      '--require-committed',
      '--json',
      '--latest-uploaded',
      NEWEST_UPLOADED ?? '0',
    ]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  test('the gate never picks the next build number when it refuses (refusal wording)', () => {
    const result = identityGate([
      '--check',
      '--latest-uploaded',
      String(BUILD + 7),
    ]);
    expectRefusal(result, `greater than ${BUILD + 7}`);
    expect(result.stderr).not.toMatch(new RegExp(`\\b${BUILD + 8}\\b`));
  });
});

// ─── G3: manifest environment claims vs the committed runtimeConfig ──────────

describe('G3 check-release-manifest.mjs validates the manifest against the committed runtimeConfig, not against strings', () => {
  const runtimeConfig = fs.readFileSync(
    path.join(REPO_ROOT, 'apps/mobile/src/config/runtimeConfig.ts'),
    'utf8',
  );
  const apiBaseUrl = runtimeConfig.match(
    /^const API_BASE_URL: string \| null =\s*'([^']*)';/m,
  )?.[1];

  test('runtimeConfig.ts commits a production API origin (evidence input)', () => {
    expect(apiBaseUrl).toMatch(/^https:\/\//);
  });

  test('the manifest gate does not certify "no real URL committed" while runtimeConfig.ts commits the production origin', () => {
    // `ok environments: production origin/bucket still "tbd" (... no real URL
    // committed)` is a statement about the tree; runtimeConfig.ts commits
    // the production URL, so a truthful gate cannot print it as `ok`.
    const result = manifestGate();
    expect(result.stdout).not.toContain(
      'ok   environments: production origin/bucket still "tbd" (BLOCKED_EXTERNAL — no real URL committed)',
    );
  });

  test('the manifest gate hard-requires the placeholder: a manifest naming the committed origin is refused (contract pin)', () => {
    // The manifest's own $comment: '"tbd" is asserted by release:check so a
    // real production URL cannot land here silently.' — so the manifest can
    // never be made to agree with runtimeConfig.ts without changing the gate.
    const root = tree({
      'infra/release/release-manifest.json': content =>
        content.replace(
          '"production": {\n      "apiOrigin": "tbd"',
          `"production": {\n      "apiOrigin": "${apiBaseUrl ?? ''}"`,
        ),
    });
    const mutated = fs.readFileSync(
      path.join(root, 'infra/release/release-manifest.json'),
      'utf8',
    );
    expect(mutated).toContain(`"apiOrigin": "${apiBaseUrl ?? ''}"`);
    const result = manifestGate(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      'FAIL environments: production origin/bucket still "tbd"',
    );
    expect(result.stderr).toContain('1 release-manifest check(s) failed.');
  });
});

// ─── G4: duplicate CFBundleVersion key in the plist the pbxproj points at ────

describe('G4 pre-archive gate vs a plist with two CFBundleVersion keys', () => {
  // release-identity.mjs reads the FIRST <string> after the key; a plist
  // carrying a second, hardcoded copy still passes `--check`. The Fastfile's
  // post-archive `--assert-build` (Mac-only) is the only remaining catch.
  test('a second, hardcoded CFBundleVersion after the sourced one is refused before the archive', () => {
    const root = tree({
      'apps/mobile/ios/PickleSensei/Info.plist': content =>
        content.replace(
          '\t<key>CFBundleVersion</key>\n\t<string>$(CURRENT_PROJECT_VERSION)</string>\n',
          `\t<key>CFBundleVersion</key>\n\t<string>$(CURRENT_PROJECT_VERSION)</string>\n\t<key>CFBundleVersion</key>\n\t<string>${BUILD + 99}</string>\n`,
        ),
    });
    const mutated = fs.readFileSync(
      path.join(root, 'apps/mobile/ios/PickleSensei/Info.plist'),
      'utf8',
    );
    expect(mutated.match(/<key>CFBundleVersion<\/key>/g)?.length).toBe(2);
    const result = identityGate(
      ['--check', '--mobile-root', mobile(root)],
      mobile(root),
    );
    expectRefusal(result, 'CFBundleVersion');
  });

  test('a second, hardcoded CFBundleShortVersionString after the sourced one is refused before the archive', () => {
    const root = tree({
      'apps/mobile/ios/PickleSensei/Info.plist': content =>
        content.replace(
          '\t<key>CFBundleShortVersionString</key>\n\t<string>$(MARKETING_VERSION)</string>\n',
          '\t<key>CFBundleShortVersionString</key>\n\t<string>$(MARKETING_VERSION)</string>\n\t<key>CFBundleShortVersionString</key>\n\t<string>9.9</string>\n',
        ),
    });
    const result = identityGate(
      ['--check', '--mobile-root', mobile(root)],
      mobile(root),
    );
    expectRefusal(result, 'CFBundleShortVersionString');
  });
});

// ─── G5: process death mid-edit (truncated identity inputs) ──────────────────

describe('G5 truncated identity inputs are refused, never partially accepted', () => {
  test('a manifest truncated mid-write', () => {
    const root = tree({
      'infra/release/release-manifest.json': content =>
        content.slice(0, Math.floor(content.length / 2)),
    });
    const result = identityGate(
      ['--check', '--mobile-root', mobile(root)],
      mobile(root),
    );
    expectRefusal(result, 'release-manifest.json');
    const manifestResult = manifestGate(root);
    expect(manifestResult.status).not.toBe(0);
  });

  test('a pbxproj truncated inside the Release configuration', () => {
    const root = tree({
      'apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj': content => {
        const cut = content.lastIndexOf(`CURRENT_PROJECT_VERSION = ${BUILD};`);
        return content.slice(0, cut);
      },
    });
    const result = identityGate(
      ['--check', '--mobile-root', mobile(root)],
      mobile(root),
    );
    expect(result.status).toBe(1);
    expect(result.stdout.trim()).toBe('');
  });

  test('an empty runtimeConfig.ts', () => {
    const root = tree({ 'apps/mobile/src/config/runtimeConfig.ts': () => '' });
    const result = identityGate(
      ['--check', '--mobile-root', mobile(root)],
      mobile(root),
    );
    expectRefusal(result, 'APP_VERSION');
    const manifestResult = manifestGate(root);
    expect(manifestResult.status).toBe(1);
  });

  test('an Info.plist truncated before CFBundleVersion', () => {
    const root = tree({
      'apps/mobile/ios/PickleSensei/Info.plist': content =>
        content.slice(0, content.indexOf('<key>CFBundleVersion</key>')),
    });
    const result = identityGate(
      ['--check', '--mobile-root', mobile(root)],
      mobile(root),
    );
    expectRefusal(result, 'CFBundleVersion');
  });
});

// ─── G6: double action — gates are idempotent and never write ────────────────

describe('G6 running each gate twice is idempotent and leaves the tree untouched', () => {
  test('release-identity.mjs twice: identical JSON, clean status', () => {
    const before = git(['status', '--porcelain', '--', 'apps/mobile', 'infra']);
    const first = identityGate(['--check', '--json']);
    const second = identityGate(['--check', '--json']);
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    expect(git(['status', '--porcelain', '--', 'apps/mobile', 'infra'])).toBe(
      before,
    );
  });

  test('check-release-manifest.mjs twice: identical output, clean status', () => {
    const before = git(['status', '--porcelain', '--', 'apps/mobile', 'infra']);
    const first = manifestGate();
    const second = manifestGate();
    expect(first.status).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    expect(git(['status', '--porcelain', '--', 'apps/mobile', 'infra'])).toBe(
      before,
    );
  });
});

// ─── G7: the scope of the manifest gate ──────────────────────────────────────

describe('G7 what the manifest gate does not prove is stated, not implied', () => {
  test('the gate prints its Mac-only exclusions on success', () => {
    const result = manifestGate();
    expect(result.stdout).toContain(
      'NOT validated here (external/Mac-only): signing, archive, TestFlight upload, store submission, live monitoring wiring.',
    );
  });

  test('the identity gate refuses to run against a tree without the Android gradle file only in the manifest gate, never the identity gate', () => {
    // release-identity.mjs (what ships) must not depend on Android inputs;
    // check-release-manifest.mjs still reads build.gradle.
    const root = tree();
    fs.rmSync(path.join(root, 'apps/mobile/android'), {
      recursive: true,
      force: true,
    });
    const identity = identityGate(
      ['--check', '--mobile-root', mobile(root)],
      mobile(root),
    );
    expect(identity.status).toBe(0);
    const manifestResult = manifestGate(root);
    expect(manifestResult.status).toBe(1);
  });
});
