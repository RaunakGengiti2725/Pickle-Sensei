/**
 * Adversarial suite for scripts/check-ios-distribution.mjs (attack on 333de233).
 *
 * 1. Xcode CONDITIONAL build settings — `"SETTING[sdk=iphoneos*]" = value;`
 *    (also `[arch=...]`, `[config=...]`) — override the plain setting for
 *    matching builds; `sdk=iphoneos*` is exactly the device/App Store
 *    archive. project.pbxproj already uses this form
 *    (`"CODE_SIGN_IDENTITY[sdk=iphoneos*]"`). The gate's pbxSettingValues only
 *    matches the unconditional spelling, so a device-only bundle id / team /
 *    device-family override passes while the archive would ship it.
 * 2. Fastfile safety flags are only recognised in `key: literal` form; the
 *    equivalent Ruby hash-rocket `:key => true` is not seen, so a lane that
 *    turns external distribution / review submission on that way passes as
 *    long as some other hash still carries `key: false`.
 */

export {};

// The mobile tsconfig has no Node types (matches flow-ios-distribution-gate).
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { execPath: string };

type Fs = {
  readFileSync: (path: string, encoding: 'utf8') => string;
  writeFileSync: (path: string, data: string) => void;
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  mkdtempSync: (prefix: string) => string;
  cpSync: (src: string, dst: string) => void;
  rmSync: (
    path: string,
    options: { recursive: boolean; force: boolean },
  ) => void;
};
type Path = {
  join: (...parts: string[]) => string;
  dirname: (p: string) => string;
};
type Os = { tmpdir: () => string };
type SpawnResult = { status: number | null; stdout: string; stderr: string };
type ChildProcess = {
  spawnSync: (
    cmd: string,
    args: string[],
    options: { cwd: string; encoding: 'utf8' },
  ) => SpawnResult;
};

const fs = require('fs') as Fs;
const { join, dirname } = require('path') as Path;
const { tmpdir } = require('os') as Os;
const { spawnSync } = require('child_process') as ChildProcess;

const MOBILE_ROOT = join(__dirname, '..', '..');
const SCRIPT = 'scripts/check-ios-distribution.mjs';
const PBX = 'ios/PickleSensei.xcodeproj/project.pbxproj';
const FASTFILE = 'ios/fastlane/Fastfile';
const FILES = [
  SCRIPT,
  PBX,
  'ios/PickleSensei/Info.plist',
  'ios/PickleSensei/PrivacyInfo.xcprivacy',
  'ios/PickleSensei/PickleSensei.entitlements',
  'ios/Podfile.lock',
  FASTFILE,
  'ios/fastlane/Appfile',
];

const scratchRoots: string[] = [];
afterAll(() => {
  for (const root of scratchRoots)
    fs.rmSync(root, { recursive: true, force: true });
});

type Mutation = (text: string) => string;

function runGate(mutations: Record<string, Mutation> = {}): SpawnResult & {
  failLines: string[];
} {
  const root = fs.mkdtempSync(join(tmpdir(), 'dist-gate-attack-'));
  scratchRoots.push(root);
  for (const rel of FILES) {
    const dst = join(root, rel);
    fs.mkdirSync(dirname(dst), { recursive: true });
    fs.cpSync(join(MOBILE_ROOT, rel), dst);
  }
  for (const [rel, mutate] of Object.entries(mutations)) {
    const dst = join(root, rel);
    const before = fs.readFileSync(dst, 'utf8');
    const after = mutate(before);
    if (after === before) throw new Error(`${rel}: mutation was a no-op`);
    fs.writeFileSync(dst, after);
  }
  const result = spawnSync(process.execPath, [join(root, SCRIPT)], {
    cwd: root,
    encoding: 'utf8',
  });
  const failLines = `${result.stdout}${result.stderr}`
    .split('\n')
    .filter(line => /^FAIL /.test(line));
  return { ...result, failLines };
}

function replaceNth(
  text: string,
  needle: string,
  replacement: string,
  n: number,
): string {
  let idx = -1;
  for (let i = 0; i <= n; i += 1) {
    idx = text.indexOf(needle, idx + 1);
    if (idx < 0) throw new Error(`occurrence ${n} of ${needle} not found`);
  }
  return text.slice(0, idx) + replacement + text.slice(idx + needle.length);
}

/** Append a conditional override after the 2nd (Release) unconditional line. */
function addConditional(
  setting: string,
  value: string,
  condition: string,
  override: string,
): Mutation {
  return pbx =>
    replaceNth(
      pbx,
      `${setting} = ${value};`,
      `${setting} = ${value};\n\t\t\t\t"${setting}[${condition}]" = ${override};`,
      1,
    );
}

function expectGateFails(
  result: SpawnResult & { failLines: string[] },
  labelPattern: RegExp,
) {
  expect(result.failLines.some(line => labelPattern.test(line))).toBe(true);
  expect(result.status).toBe(1);
}

describe('precondition', () => {
  it('the committed pbxproj already uses "SETTING[sdk=iphoneos*]" conditional settings', () => {
    const pbx = fs.readFileSync(join(MOBILE_ROOT, PBX), 'utf8');
    expect(pbx).toMatch(/"[A-Z_]+\[sdk=iphoneos\*\]" = /);
  });

  it('a same-value conditional override still passes', () => {
    const result = runGate({
      [PBX]: addConditional(
        'PRODUCT_BUNDLE_IDENTIFIER',
        'com.picklesensei',
        'sdk=iphoneos*',
        'com.picklesensei',
      ),
    });
    expect(result.failLines).toEqual([]);
    expect(result.status).toBe(0);
  });
});

describe('conditional build-setting overrides must fail the pbxproj pins', () => {
  it('"PRODUCT_BUNDLE_IDENTIFIER[sdk=iphoneos*]" = com.picklesensei.staging; -> FAIL', () => {
    const result = runGate({
      [PBX]: addConditional(
        'PRODUCT_BUNDLE_IDENTIFIER',
        'com.picklesensei',
        'sdk=iphoneos*',
        'com.picklesensei.staging',
      ),
    });
    expectGateFails(result, /PRODUCT_BUNDLE_IDENTIFIER/);
  });

  it('"TARGETED_DEVICE_FAMILY[sdk=iphoneos*]" = "1,2"; -> FAIL', () => {
    const result = runGate({
      [PBX]: addConditional(
        'TARGETED_DEVICE_FAMILY',
        '1',
        'sdk=iphoneos*',
        '"1,2"',
      ),
    });
    expectGateFails(result, /TARGETED_DEVICE_FAMILY/);
  });

  it('"DEVELOPMENT_TEAM[sdk=iphoneos*]" = ZZZZZZZZZZ; -> FAIL', () => {
    const result = runGate({
      [PBX]: addConditional(
        'DEVELOPMENT_TEAM',
        'H26U6W4K6V',
        'sdk=iphoneos*',
        'ZZZZZZZZZZ',
      ),
    });
    expectGateFails(result, /DEVELOPMENT_TEAM/);
  });

  it('"PRODUCT_BUNDLE_IDENTIFIER[config=Release]" = com.picklesensei.staging; -> FAIL', () => {
    const result = runGate({
      [PBX]: addConditional(
        'PRODUCT_BUNDLE_IDENTIFIER',
        'com.picklesensei',
        'config=Release',
        'com.picklesensei.staging',
      ),
    });
    expectGateFails(result, /PRODUCT_BUNDLE_IDENTIFIER/);
  });
});

describe('Fastfile hash-rocket spellings of the safety flags', () => {
  const DIST_FALSE =
    'distribute_external: false, # internal testers only; external needs App Review';
  const REVIEW_FALSE =
    'submit_for_review: false, # review submission is a human decision';

  it(':distribute_external => true (stale distribute_external: false elsewhere) -> FAIL', () => {
    const result = runGate({
      [FASTFILE]: text =>
        text
          .replace(DIST_FALSE, ':distribute_external => true,')
          .replace(
            'lane :beta do\n',
            'lane :beta do\n    defaults = { distribute_external: false }\n',
          ),
    });
    expectGateFails(result, /distribute_external/);
  });

  it(':submit_for_review => true (stale submit_for_review: false elsewhere) -> FAIL', () => {
    const result = runGate({
      [FASTFILE]: text =>
        text
          .replace(REVIEW_FALSE, ':submit_for_review => true,')
          .replace(
            'lane :release do\n',
            'lane :release do\n    defaults = { submit_for_review: false }\n',
          ),
    });
    expectGateFails(result, /submit_for_review/);
  });
});
