/**
 * W11-08 adversarial suite — attacks on the immutable release identity gate
 * (candidate cfdfb2e1dd4c4da35dc88ebb79390d87e256057a).
 *
 * Every test here encodes what the gate MUST do at a failure boundary the
 * candidate's own suite does not visit. A failing test is a confirmed break of
 * the candidate; a passing test is an attack that did not land. Nothing here
 * edits the candidate's production code or its regression suite.
 *
 * Attack classes:
 *   A1  Xcode conditional build settings (`SETTING[sdk=iphoneos*]`) shadow the
 *       unconditional CURRENT_PROJECT_VERSION / MARKETING_VERSION /
 *       INFOPLIST_FILE the script reads — the device archive would carry a
 *       different identity than `--check` reports.
 *   A2  Duplicate CURRENT_PROJECT_VERSION inside ONE configuration body
 *       (ambiguous source; the script silently takes the first).
 *   A3  Info.plist whose `$(CURRENT_PROJECT_VERSION)` reference is inside an
 *       XML comment while the live key hardcodes a build.
 *   A4  A run-script build phase that rewrites CFBundleVersion after copy
 *       (`PlistBuddy` / `agvtool`) — the classic post-verify increment moved
 *       into the project file.
 *   A5  Project-level (PBXProject) settings shadowing — must NOT fool the check
 *       (target-level settings win in Xcode); control case.
 *   A6  Corrupt / partial persisted state: CRLF pbxproj, UTF-8 BOM manifest,
 *       duplicate JSON keys, manifest build as float-integer.
 *   A7  Boundary values on the upload bound and archive assertions.
 *   A8  Documentation replay: repository docs that still describe the removed
 *       `latest_testflight_build_number + 1` bump.
 *
 * Static + subprocess tests only (throwaway trees under the OS tmpdir): no
 * Xcode, signing, Apple credentials or uploads. Whether Xcode really resolves
 * a `[sdk=iphoneos*]` conditional over the unconditional setting is INFERRED
 * from Xcode's documented build-setting conditions, not proven on Linux.
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
type ExtraFiles = Record<string, string>;

interface ReleaseIdentity {
  marketingVersion: string;
  buildNumber: number;
  configurations: string[];
  gitSha: string | null;
  committed: boolean;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runScript(args: string[], cwd: string = MOBILE_ROOT): RunResult {
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

function readIdentityFile(name: IdentityFile): string {
  return fs.readFileSync(path.join(MOBILE_ROOT, name), 'utf8');
}

const manifest = JSON.parse(
  readIdentityFile('../../infra/release/release-manifest.json'),
) as { versionScheme: { marketingVersion: string; buildNumber: number } };
const VERSION = manifest.versionScheme.marketingVersion;
const BUILD = manifest.versionScheme.buildNumber;
const OTHER_BUILD = BUILD + 6;
const OTHER_VERSION = `${VERSION}.9`;

const fixtures: string[] = [];
/**
 * Copies the real identity files into a throwaway tree (repo layout, so the
 * script's `--mobile-root` path resolution works), applies `mutations`, writes
 * `extra` files (relative to the mobile root). Returns the tree's mobile root.
 */
function fixture(mutations: Mutations = {}, extra: ExtraFiles = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w11-attack-'));
  fixtures.push(root);
  const mobileRoot = path.join(root, 'apps', 'mobile');
  for (const name of IDENTITY_FILES) {
    const target = path.resolve(mobileRoot, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const mutate = mutations[name];
    const content = readIdentityFile(name);
    fs.writeFileSync(target, mutate ? mutate(content) : content, 'utf8');
  }
  for (const [name, content] of Object.entries(extra)) {
    const target = path.resolve(mobileRoot, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
  return mobileRoot;
}
afterAll(() => {
  for (const root of fixtures) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function check(mobileRoot: string, ...args: string[]): RunResult {
  return runScript(['--check', '--json', '--mobile-root', mobileRoot, ...args]);
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

/**
 * Inserts `line` (already indented with four tabs) into the buildSettings of
 * the application target's configuration named `configuration`, right after
 * its unconditional CURRENT_PROJECT_VERSION line.
 */
function addSettingLine(
  pbxproj: string,
  configuration: string,
  line: string,
): string {
  const pattern = new RegExp(
    `(\\t\\t\\t\\tCURRENT_PROJECT_VERSION = ${BUILD};\\n)((?:\\t\\t\\t\\t.*\\n)*?\\t\\t\\t\\tINFOPLIST_FILE = PickleSensei/Info.plist;\\n(?:\\t\\t\\t.*\\n)*?\\t\\t\\tname = ${configuration};)`,
    'm',
  );
  expect(pattern.test(pbxproj)).toBe(true);
  return pbxproj.replace(pattern, `$1${line}\n$2`);
}

const PLIST_HARDCODED_BUILD = readIdentityFile('ios/PickleSensei/Info.plist')
  .replace(
    '<string>$(CURRENT_PROJECT_VERSION)</string>',
    `<string>${OTHER_BUILD}</string>`,
  )
  .replace(
    '<string>$(MARKETING_VERSION)</string>',
    `<string>${OTHER_VERSION}</string>`,
  );

// ─── Sanity: the unmodified candidate tree is accepted ───────────────────────

describe('control: the unmodified identity tree', () => {
  test('is accepted with the manifest identity', () => {
    const identity = expectAccepted(check(fixture()));
    expect(identity.marketingVersion).toBe(VERSION);
    expect(identity.buildNumber).toBe(BUILD);
    expect(identity.configurations).toEqual(['Debug', 'Release']);
  });

  test('the real Info.plist sources both identity keys from build settings exactly once each', () => {
    const plist = readIdentityFile('ios/PickleSensei/Info.plist');
    expect(plist.match(/<key>CFBundleVersion<\/key>/g)).toHaveLength(1);
    expect(plist.match(/<key>CFBundleShortVersionString<\/key>/g)).toHaveLength(
      1,
    );
    for (const comment of plist.match(/<!--[\s\S]*?-->/g) ?? []) {
      expect(comment).not.toMatch(/CFBundleVersion|CFBundleShortVersionString/);
    }
  });

  test('the real pbxproj carries no conditional identity setting and no plist-rewriting script phase', () => {
    const pbxproj = readIdentityFile(
      'ios/PickleSensei.xcodeproj/project.pbxproj',
    );
    expect(pbxproj).not.toMatch(
      /"(CURRENT_PROJECT_VERSION|MARKETING_VERSION|INFOPLIST_FILE)\[/,
    );
    expect(pbxproj).not.toMatch(/PlistBuddy|agvtool|CFBundleVersion/);
  });
});

// ─── A1: conditional build settings shadow the unconditional identity ───────

describe('A1 — Xcode conditional build settings shadowing the identity', () => {
  test('"CURRENT_PROJECT_VERSION[sdk=iphoneos*]" in Release differing from the manifest is refused', () => {
    const result = check(
      fixture({
        'ios/PickleSensei.xcodeproj/project.pbxproj': content =>
          addSettingLine(
            content,
            'Release',
            `\t\t\t\t"CURRENT_PROJECT_VERSION[sdk=iphoneos*]" = ${OTHER_BUILD};`,
          ),
      }),
    );
    expectRefusal(result, 'CURRENT_PROJECT_VERSION', String(OTHER_BUILD));
  });

  test('"CURRENT_PROJECT_VERSION[arch=arm64]" in Release differing from the manifest is refused', () => {
    const result = check(
      fixture({
        'ios/PickleSensei.xcodeproj/project.pbxproj': content =>
          addSettingLine(
            content,
            'Release',
            `\t\t\t\t"CURRENT_PROJECT_VERSION[arch=arm64]" = ${OTHER_BUILD};`,
          ),
      }),
    );
    expectRefusal(result, 'CURRENT_PROJECT_VERSION', String(OTHER_BUILD));
  });

  test('"MARKETING_VERSION[sdk=iphoneos*]" in Release differing from the manifest is refused', () => {
    const result = check(
      fixture({
        'ios/PickleSensei.xcodeproj/project.pbxproj': content =>
          addSettingLine(
            content,
            'Release',
            `\t\t\t\t"MARKETING_VERSION[sdk=iphoneos*]" = ${OTHER_VERSION};`,
          ),
      }),
    );
    expectRefusal(result, 'MARKETING_VERSION', OTHER_VERSION);
  });

  test('"INFOPLIST_FILE[sdk=iphoneos*]" redirecting the device build to a plist that hardcodes the identity is refused', () => {
    const result = check(
      fixture(
        {
          'ios/PickleSensei.xcodeproj/project.pbxproj': content =>
            addSettingLine(
              content,
              'Release',
              '\t\t\t\t"INFOPLIST_FILE[sdk=iphoneos*]" = PickleSensei/Device.plist;',
            ),
        },
        { 'ios/PickleSensei/Device.plist': PLIST_HARDCODED_BUILD },
      ),
    );
    expectRefusal(result, 'CFBundleVersion');
  });
});

// ─── A2: duplicate setting inside one configuration body ────────────────────

describe('A2 — duplicate identity setting inside ONE configuration', () => {
  test('a second CURRENT_PROJECT_VERSION line AFTER the committed one in Release is refused (ambiguous source, not first-wins)', () => {
    const result = check(
      fixture({
        'ios/PickleSensei.xcodeproj/project.pbxproj': content =>
          addSettingLine(
            content,
            'Release',
            `\t\t\t\tCURRENT_PROJECT_VERSION = ${OTHER_BUILD};`,
          ),
      }),
    );
    expectRefusal(result, 'CURRENT_PROJECT_VERSION', String(OTHER_BUILD));
  });

  test('control: a second MARKETING_VERSION line BEFORE the committed one in Debug is refused (the first occurrence is the one read)', () => {
    const result = check(
      fixture({
        'ios/PickleSensei.xcodeproj/project.pbxproj': content =>
          addSettingLine(
            content,
            'Debug',
            `\t\t\t\tMARKETING_VERSION = ${OTHER_VERSION};`,
          ),
      }),
    );
    expectRefusal(result, 'MARKETING_VERSION', OTHER_VERSION);
  });
});

// ─── A3: plist reference hidden in an XML comment ───────────────────────────

describe('A3 — Info.plist whose build-setting reference is commented out', () => {
  test('a commented-out $(CURRENT_PROJECT_VERSION) followed by a hardcoded CFBundleVersion is refused', () => {
    const result = check(
      fixture({
        'ios/PickleSensei/Info.plist': content =>
          content.replace(
            /(\t*)<key>CFBundleVersion<\/key>\s*<string>\$\(CURRENT_PROJECT_VERSION\)<\/string>/,
            `$1<!-- <key>CFBundleVersion</key><string>$(CURRENT_PROJECT_VERSION)</string> -->\n$1<key>CFBundleVersion</key>\n$1<string>${OTHER_BUILD}</string>`,
          ),
      }),
    );
    expectRefusal(result, 'CFBundleVersion');
  });

  test('a commented-out $(MARKETING_VERSION) followed by a hardcoded CFBundleShortVersionString is refused', () => {
    const result = check(
      fixture({
        'ios/PickleSensei/Info.plist': content =>
          content.replace(
            /(\t*)<key>CFBundleShortVersionString<\/key>\s*<string>\$\(MARKETING_VERSION\)<\/string>/,
            `$1<!-- <key>CFBundleShortVersionString</key><string>$(MARKETING_VERSION)</string> -->\n$1<key>CFBundleShortVersionString</key>\n$1<string>${OTHER_VERSION}</string>`,
          ),
      }),
    );
    expectRefusal(result, 'CFBundleShortVersionString');
  });

  test('a duplicate CFBundleVersion key whose second value is hardcoded is refused', () => {
    const result = check(
      fixture({
        'ios/PickleSensei/Info.plist': content =>
          content.replace(
            /(\t*)(<key>CFBundleVersion<\/key>\s*<string>\$\(CURRENT_PROJECT_VERSION\)<\/string>)/,
            `$1$2\n$1<key>CFBundleVersion</key>\n$1<string>${OTHER_BUILD}</string>`,
          ),
      }),
    );
    expectRefusal(result, 'CFBundleVersion');
  });
});

// ─── A4: a run-script phase rewriting the built Info.plist ──────────────────

describe('A4 — run-script build phase that rewrites the shipped CFBundleVersion', () => {
  const PLIST_BUDDY_PHASE = [
    '\t\tA7A7A7A7A7A7A7A7A7A7A7A7 /* Stamp build */ = {',
    '\t\t\tisa = PBXShellScriptBuildPhase;',
    '\t\t\tbuildActionMask = 2147483647;',
    '\t\t\tfiles = (',
    '\t\t\t);',
    '\t\t\tname = "Stamp build";',
    '\t\t\trunOnlyForDeploymentPostprocessing = 0;',
    '\t\t\tshellPath = /bin/sh;',
    `\t\t\tshellScript = "/usr/libexec/PlistBuddy -c \\"Set :CFBundleVersion ${OTHER_BUILD}\\" \\"$TARGET_BUILD_DIR/$INFOPLIST_PATH\\"\\n";`,
    '\t\t};',
    '',
  ].join('\n');

  test('a PlistBuddy "Set :CFBundleVersion" phase in the application target is refused', () => {
    const result = check(
      fixture({
        'ios/PickleSensei.xcodeproj/project.pbxproj': content => {
          expect(content).toContain(
            '/* Begin PBXShellScriptBuildPhase section */\n',
          );
          const withPhase = content.replace(
            '/* Begin PBXShellScriptBuildPhase section */\n',
            `/* Begin PBXShellScriptBuildPhase section */\n${PLIST_BUDDY_PHASE}`,
          );
          // Wire the phase into the application target's buildPhases list.
          const target =
            /(\t\t\tisa = PBXNativeTarget;\n\t\t\tbuildConfigurationList = [0-9A-F]{24} \/\* Build configuration list for PBXNativeTarget "PickleSensei" \*\/;\n\t\t\tbuildPhases = \(\n)/;
          expect(target.test(withPhase)).toBe(true);
          return withPhase.replace(
            target,
            '$1\t\t\t\tA7A7A7A7A7A7A7A7A7A7A7A7 /* Stamp build */,\n',
          );
        },
      }),
    );
    expectRefusal(result, 'CFBundleVersion');
  });

  test('an agvtool bump phase in the application target is refused', () => {
    const result = check(
      fixture({
        'ios/PickleSensei.xcodeproj/project.pbxproj': content => {
          const phase = PLIST_BUDDY_PHASE.replace(
            /shellScript = ".*";/,
            'shellScript = "xcrun agvtool next-version -all\\n";',
          );
          const withPhase = content.replace(
            '/* Begin PBXShellScriptBuildPhase section */\n',
            `/* Begin PBXShellScriptBuildPhase section */\n${phase}`,
          );
          return withPhase.replace(
            /(\t\t\tisa = PBXNativeTarget;\n\t\t\tbuildConfigurationList = [0-9A-F]{24} \/\* Build configuration list for PBXNativeTarget "PickleSensei" \*\/;\n\t\t\tbuildPhases = \(\n)/,
            '$1\t\t\t\tA7A7A7A7A7A7A7A7A7A7A7A7 /* Stamp build */,\n',
          );
        },
      }),
    );
    expectRefusal(result, 'agvtool');
  });
});

// ─── A5: project-level shadowing (control — target-level wins in Xcode) ─────

describe('A5 — PBXProject-level settings cannot fool or break the check', () => {
  test('a project-level CURRENT_PROJECT_VERSION with another value is ignored because every target configuration sets it', () => {
    const identity = expectAccepted(
      check(
        fixture({
          'ios/PickleSensei.xcodeproj/project.pbxproj': content => {
            // The PBXProject configurations are the ones NOT named by the
            // application target's list; add the setting to each of them.
            const projectList = content.match(
              /\t\t([0-9A-F]{24}) \/\* Build configuration list for PBXProject "PickleSensei" \*\/ = \{\n((?:\t\t\t.*\n)*?)\t\t\};/,
            );
            expect(projectList).not.toBeNull();
            const ids = [
              ...(projectList?.[2] ?? '').matchAll(/([0-9A-F]{24}) \/\*/g),
            ].map(m => m[1]);
            expect(ids.length).toBeGreaterThan(0);
            let out = content;
            for (const id of ids) {
              const pattern = new RegExp(
                `(\\t\\t${id} /\\* [^*]* \\*/ = \\{\\n\\t\\t\\tisa = XCBuildConfiguration;\\n(?:\\t\\t\\t.*\\n)*?\\t\\t\\tbuildSettings = \\{\\n)`,
              );
              expect(pattern.test(out)).toBe(true);
              out = out.replace(
                pattern,
                `$1\t\t\t\tCURRENT_PROJECT_VERSION = ${OTHER_BUILD};\n`,
              );
            }
            return out;
          },
        }),
      ),
    );
    expect(identity.buildNumber).toBe(BUILD);
  });
});

// ─── A6: corrupt / partial persisted state ──────────────────────────────────

describe('A6 — corrupt or partially written identity files fail closed', () => {
  test('a pbxproj re-saved with CRLF line endings is refused, never read as "not set" into acceptance', () => {
    const result = check(
      fixture({
        'ios/PickleSensei.xcodeproj/project.pbxproj': content =>
          content.replace(/\n/g, '\r\n'),
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stdout.trim()).toBe('');
  });

  test('a manifest with a UTF-8 BOM is refused as invalid JSON rather than accepted', () => {
    const result = check(
      fixture({
        '../../infra/release/release-manifest.json': content =>
          `\uFEFF${content}`,
      }),
    );
    expectRefusal(result, 'not valid JSON');
  });

  test('a manifest with a duplicate buildNumber key does not let the FIRST value pass while JSON.parse keeps the last', () => {
    const result = check(
      fixture({
        '../../infra/release/release-manifest.json': content =>
          content.replace(
            `"buildNumber": ${BUILD}`,
            `"buildNumber": ${BUILD}, "buildNumber": ${OTHER_BUILD}`,
          ),
      }),
    );
    expectRefusal(result, String(OTHER_BUILD));
  });

  test('a manifest buildNumber written as an integer-valued float literal (1.0) resolves to the same exact integer, never to "1.0"', () => {
    const identity = expectAccepted(
      check(
        fixture({
          '../../infra/release/release-manifest.json': content =>
            content.replace(
              `"buildNumber": ${BUILD}`,
              `"buildNumber": ${BUILD}.0`,
            ),
        }),
      ),
    );
    expect(identity.buildNumber).toBe(BUILD);
    expect(
      check(
        fixture({
          '../../infra/release/release-manifest.json': content =>
            content.replace(
              `"buildNumber": ${BUILD}`,
              `"buildNumber": ${BUILD}.0`,
            ),
        }),
        '--assert-build',
        String(BUILD),
      ).status,
    ).toBe(0);
  });

  test('a truncated pbxproj (application target cut mid-body) is refused', () => {
    const result = check(
      fixture({
        'ios/PickleSensei.xcodeproj/project.pbxproj': content =>
          content.slice(
            0,
            content.indexOf('/* Begin XCBuildConfiguration section */') + 60,
          ),
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stdout.trim()).toBe('');
  });

  test('an empty Info.plist is refused', () => {
    const result = check(fixture({ 'ios/PickleSensei/Info.plist': () => '' }));
    expectRefusal(result, 'CFBundleShortVersionString');
  });
});

// ─── A7: boundary values on the upload bound and archive assertions ─────────

describe('A7 — boundary values', () => {
  test('--latest-uploaded 0 accepts the smallest committed build', () => {
    const identity = expectAccepted(check(fixture(), '--latest-uploaded', '0'));
    expect(identity.buildNumber).toBe(BUILD);
  });

  test('--latest-uploaded equal to the committed build (leading zeros) is still refused', () => {
    expectRefusal(
      check(fixture(), '--latest-uploaded', `000${BUILD}`),
      'is not greater than',
    );
  });

  test('--assert-build with a leading zero is not the committed decimal text and is refused', () => {
    expectRefusal(check(fixture(), '--assert-build', `0${BUILD}`));
  });

  test('--assert-version with a trailing component (1.0.0 vs 1.0) is refused, never normalised into a match', () => {
    expectRefusal(
      check(fixture(), '--assert-version', `${VERSION}.0`),
      'differs from the verified manifest marketingVersion',
    );
  });

  test.each(['1.0\n', '1.0 ', ' 1.0', '1,0', '1.0.0.0', 'v1.0'])(
    '--assert-version %j is malformed and refused',
    value => {
      expectRefusal(
        check(fixture(), '--assert-version', value),
        '--assert-version',
      );
    },
  );

  test.each(['1\n', '1 ', '0x1', '1_000', '1.', '٣'])(
    '--assert-build %j is malformed and refused',
    value => {
      expectRefusal(
        check(fixture(), '--assert-build', value),
        '--assert-build',
      );
    },
  );

  test('--latest-uploaded far beyond any real build (10^30) refuses without rounding', () => {
    expectRefusal(
      check(fixture(), '--latest-uploaded', '1000000000000000000000000000000'),
      'is not greater than 1000000000000000000000000000000',
    );
  });

  test('a flag value that is itself a flag name is refused as a missing value, not consumed', () => {
    expectRefusal(
      check(fixture(), '--assert-build', '--json'),
      'requires a value',
    );
  });

  test('an empty-string argument is an unknown argument, not silently skipped', () => {
    expectRefusal(check(fixture(), ''), 'unknown argument');
  });
});

// ─── A8: documentation replay of the removed bump ───────────────────────────

describe('A8 — repository docs must not still describe the removed automatic bump', () => {
  const STALE_BUMP =
    /latest_testflight_build_number\s*\+\s*1|bumps? (the )?build number|Bump build number/i;
  const DOCS = [
    'docs/DISTRIBUTION.md',
    'docs/RELEASE_OPERATIONS.md',
    'docs/APP_STORE_SUBMISSION.md',
    'apps/mobile/ios/fastlane/README.md',
  ];

  test.each(DOCS)(
    '%s does not describe fastlane bumping or assigning the build number',
    doc => {
      const file = path.join(REPO_ROOT, doc);
      expect(fs.existsSync(file)).toBe(true);
      const content = fs.readFileSync(file, 'utf8');
      const stale = content
        .split('\n')
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => STALE_BUMP.test(line));
      expect(stale).toEqual([]);
    },
  );

  test('the fastlane lane descriptions the README mirrors match the Fastfile (the README is generated from `desc`)', () => {
    const readme = fs.readFileSync(
      path.join(MOBILE_ROOT, 'ios', 'fastlane', 'README.md'),
      'utf8',
    );
    const fastfile = fs.readFileSync(
      path.join(MOBILE_ROOT, 'ios', 'fastlane', 'Fastfile'),
      'utf8',
    );
    const betaDesc = fastfile.match(/desc "([^"]*)"\n\s*lane :beta/);
    expect(betaDesc).not.toBeNull();
    const firstLine = (betaDesc?.[1] ?? '').split('\n')[0].trim();
    expect(readme).toContain(firstLine);
  });
});
