/**
 * Adversarial tester — attack on candidate 3825a8ad (cluster
 * mobile-ios-config IOSCFG-1+2+3). Each spec applies ONE Release-relevant
 * drift to a throwaway copy of the gate inputs and runs the real fixed gate
 * (scripts/check-ios-distribution.mjs). Every spec below is a FALSE GREEN on
 * 3825a8ad: the gate exits 0 although the shipped Release archive differs
 * from what the gate's own label pins.
 *
 *   A1/A2  `-DDEBUG` reaches the compilers through OTHER_SWIFT_FLAGS /
 *          OTHER_CFLAGS — the gate labelled "no DEBUG preprocessor definition
 *          or Swift compilation condition" reads only
 *          GCC_PREPROCESSOR_DEFINITIONS and SWIFT_ACTIVE_COMPILATION_CONDITIONS
 *          (scripts/check-ios-distribution.mjs:141-152). `-D DEBUG` in
 *          OTHER_SWIFT_FLAGS is the same M7 class expressed as a flag.
 *   A3     a duplicated key inside one buildSettings block: pbxproj.js
 *          `parseFields` keeps the LAST definition (scripts/pbxproj.js:33-40),
 *          so `CURRENT_PROJECT_VERSION = 7;` followed by `= 1;` reads as 1.
 *          Which value Xcode's plist reader keeps is not verifiable from
 *          Linux; a gate that pins a value must reject the ambiguity instead
 *          of picking one.
 *   A4     the Resources build phase copies a PrivacyInfo.xcprivacy whose
 *          PBXFileReference path is NOT ios/PickleSensei/PrivacyInfo.xcprivacy
 *          (the file the gate validates). `resourcePaths` is compared by
 *          basename only (scripts/check-ios-distribution.mjs:271-275), so the
 *          validated manifest and the bundled manifest can be different files.
 *   A5     Info.plist CFBundleShortVersionString is a literal while the
 *          `$(MARKETING_VERSION)` token survives only in a comment — the
 *          "version pulled from build settings" check is a whole-file
 *          `includes` (scripts/check-ios-distribution.mjs:256-260), the same
 *          any-occurrence class IOSCFG-3 was about. Pre-existing at 4d812e1a.
 *
 * Static, Linux-runnable; asserts what the gate reads, not an Xcode build.
 */

export {};

// The mobile tsconfig ships no Node types (same pattern as the wf/ suites).
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { execPath: string };
const fs = require('fs') as {
  cpSync: (
    src: string,
    dest: string,
    options: {
      recursive: true;
      filter?: (src: string, dest: string) => boolean;
    },
  ) => void;
  mkdirSync: (p: string, options: { recursive: true }) => void;
  mkdtempSync: (prefix: string) => string;
  readFileSync: (p: string, encoding: 'utf8') => string;
  rmSync: (p: string, options: { recursive: true; force: true }) => void;
  writeFileSync: (p: string, data: string) => void;
};
const os = require('os') as { tmpdir: () => string };
const path = require('path') as {
  basename: (p: string) => string;
  dirname: (p: string) => string;
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
};
const childProcess = require('child_process') as {
  spawnSync: (
    cmd: string,
    args: string[],
    options: { cwd: string; encoding: 'utf8' },
  ) => { status: number | null; stdout: string; stderr: string };
};

const MOBILE_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(MOBILE_ROOT, '..', '..');
const PBXPROJ = 'apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj';
const INFO_PLIST = 'apps/mobile/ios/PickleSensei/Info.plist';

const GATE_INPUTS = [
  'apps/mobile/ios',
  'apps/mobile/scripts',
  'apps/mobile/android/app/build.gradle',
  'apps/mobile/src/config/runtimeConfig.ts',
  'docs/APP_STORE_SUBMISSION.md',
  'infra/release/release-manifest.json',
];

function makeFixtureRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ioscfg-attack-'));
  for (const rel of GATE_INPUTS) {
    const dest = path.join(root, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(path.join(REPO_ROOT, rel), dest, {
      recursive: true,
      filter: src => {
        const name = path.basename(src);
        return name !== 'Pods' && name !== 'build';
      },
    });
  }
  return root;
}

const pristinePbxproj = fs.readFileSync(path.join(REPO_ROOT, PBXPROJ), 'utf8');
const pristinePlist = fs.readFileSync(path.join(REPO_ROOT, INFO_PLIST), 'utf8');

function objectText(text: string, id: string): string {
  const start = text.indexOf(`\t\t${id} `);
  if (start < 0) throw new Error(`pbxproj: object ${id} not found`);
  const end = text.indexOf('\n\t\t};', start);
  return text.slice(start, end);
}

function ids(listValue: string): string[] {
  return Array.from(listValue.matchAll(/[0-9A-F]{24}/g), m => m[0]);
}

function configurationId(text: string, listId: string, name: string): string {
  const list = objectText(text, listId);
  const configs = /buildConfigurations = \(([\s\S]*?)\);/.exec(list)?.[1] ?? '';
  for (const id of ids(configs)) {
    if (
      new RegExp(`^\\t\\t\\tname = ${name};$`, 'm').test(objectText(text, id))
    )
      return id;
  }
  throw new Error(`pbxproj: no ${name} configuration in ${listId}`);
}

function listRef(text: string, ownerId: string): string {
  const owner = objectText(text, ownerId);
  const ref = /^\t\t\tbuildConfigurationList = ([0-9A-F]{24})/m.exec(owner);
  if (!ref)
    throw new Error(`pbxproj: ${ownerId} has no buildConfigurationList`);
  return ref[1]!;
}

const appTargetId =
  /^\t\t([0-9A-F]{24}) \/\* PickleSensei \*\/ = \{\n\t\t\tisa = PBXNativeTarget;/m.exec(
    pristinePbxproj,
  )?.[1];
if (!appTargetId) throw new Error('pbxproj: app target not found');

const TARGET_RELEASE = configurationId(
  pristinePbxproj,
  listRef(pristinePbxproj, appTargetId),
  'Release',
);

/** Insert `lines` at the top of a configuration's buildSettings block. */
function withSettings(text: string, configId: string, lines: string[]): string {
  const start = text.indexOf(`\t\t${configId} `);
  const marker = 'buildSettings = {\n';
  const at = text.indexOf(marker, start) + marker.length;
  return (
    text.slice(0, at) +
    lines.map(line => `\t\t\t\t${line}\n`).join('') +
    text.slice(at)
  );
}

function replaceOnce(text: string, from: string, to: string): string {
  if (!text.includes(from)) throw new Error(`anchor not found: ${from}`);
  return text.replace(from, to);
}

function runCheckDistribution(root: string) {
  return childProcess.spawnSync(
    process.execPath,
    ['scripts/check-ios-distribution.mjs'],
    { cwd: path.join(root, 'apps', 'mobile'), encoding: 'utf8' },
  );
}

interface Attack {
  title: string;
  pbxproj?: (text: string) => string;
  plist?: (text: string) => string;
}

const ATTACKS: Attack[] = [
  {
    title:
      'A1 target Release OTHER_SWIFT_FLAGS = "$(inherited) -DDEBUG" (Swift DEBUG condition via a compiler flag)',
    pbxproj: t =>
      withSettings(t, TARGET_RELEASE, [
        'OTHER_SWIFT_FLAGS = "$(inherited) -DDEBUG";',
      ]),
  },
  {
    title:
      'A2 target Release OTHER_CFLAGS = ("$(inherited)", "-DDEBUG=1") (C/ObjC DEBUG macro via a compiler flag)',
    pbxproj: t =>
      withSettings(t, TARGET_RELEASE, [
        'OTHER_CFLAGS = (',
        '\t"$(inherited)",',
        '\t"-DDEBUG=1",',
        ');',
      ]),
  },
  {
    title:
      'A3 target Release defines CURRENT_PROJECT_VERSION twice (7, then the pinned 1) — ambiguous input must not pass',
    pbxproj: t =>
      withSettings(t, TARGET_RELEASE, ['CURRENT_PROJECT_VERSION = 7;']),
  },
  {
    title:
      'A4 PrivacyInfo.xcprivacy PBXFileReference path points outside ios/PickleSensei (the validated file is not the bundled one)',
    pbxproj: t =>
      replaceOnce(
        t,
        'name = PrivacyInfo.xcprivacy; path = PickleSensei/PrivacyInfo.xcprivacy; sourceTree = "<group>";',
        'name = PrivacyInfo.xcprivacy; path = ../PrivacyInfo.xcprivacy; sourceTree = "<group>";',
      ),
  },
  {
    title:
      'A5 Info.plist CFBundleShortVersionString = literal 2.0 while $(MARKETING_VERSION) survives only in a comment',
    plist: t =>
      replaceOnce(
        t,
        '\t<key>CFBundleShortVersionString</key>\n\t<string>$(MARKETING_VERSION)</string>\n',
        '\t<!-- previously $(MARKETING_VERSION) -->\n\t<key>CFBundleShortVersionString</key>\n\t<string>2.0</string>\n',
      ),
  },
];

describe('attack 3825a8ad: Release drift the fixed check:distribution gate still passes', () => {
  let root: string;
  beforeAll(() => {
    root = makeFixtureRepo();
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('control: the unmodified project passes the gate in the fixture layout', () => {
    fs.writeFileSync(path.join(root, PBXPROJ), pristinePbxproj);
    fs.writeFileSync(path.join(root, INFO_PLIST), pristinePlist);
    const result = runCheckDistribution(root);
    expect([result.status, result.stderr]).toEqual([0, '']);
  });

  it.each(ATTACKS.map(a => [a.title, a] as const))(
    '%s → check:distribution exits non-zero',
    (_title, attack) => {
      const pbxproj = attack.pbxproj?.(pristinePbxproj) ?? pristinePbxproj;
      const plist = attack.plist?.(pristinePlist) ?? pristinePlist;
      expect(pbxproj !== pristinePbxproj || plist !== pristinePlist).toBe(true);
      fs.writeFileSync(path.join(root, PBXPROJ), pbxproj);
      fs.writeFileSync(path.join(root, INFO_PLIST), plist);
      const result = runCheckDistribution(root);
      // On failure the gate's own report is the diagnostic.
      expect({
        status: result.status,
        report: result.stdout,
      }).not.toMatchObject({ status: 0 });
    },
  );
});
