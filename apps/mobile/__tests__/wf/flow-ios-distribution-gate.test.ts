/**
 * Distribution gate regression suite — scripts/check-ios-distribution.mjs.
 *
 * Copies the gate plus every file it reads into a scratch apps/mobile tree,
 * applies ONE mutation, runs the gate as a child process, and asserts the
 * verdict. Pins: every build configuration in project.pbxproj carries the
 * shipping bundle id, iPhone-only device family and the release team, and the
 * effective (comment-stripped) Fastfile keeps external distribution and review
 * submission off with the ASC key sourced from the environment.
 */

export {};

// The mobile tsconfig has no Node types (matches flow-app-store-compliance).
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
  const root = fs.mkdtempSync(join(tmpdir(), 'dist-gate-'));
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

function expectGateFails(
  result: SpawnResult & { failLines: string[] },
  labelPattern: RegExp,
) {
  expect(result.status).toBe(1);
  expect(result.failLines.some(line => labelPattern.test(line))).toBe(true);
}

describe('check:distribution baseline', () => {
  it('D0: the unmodified tree passes', () => {
    const result = runGate();
    expect(result.failLines).toEqual([]);
    expect(result.status).toBe(0);
  });

  it('the committed pbxproj pins each setting in >= 2 build configurations', () => {
    const pbx = fs.readFileSync(join(MOBILE_ROOT, PBX), 'utf8');
    for (const setting of [
      'PRODUCT_BUNDLE_IDENTIFIER = com.picklesensei;',
      'TARGETED_DEVICE_FAMILY = 1;',
      'DEVELOPMENT_TEAM = H26U6W4K6V;',
    ]) {
      expect(pbx.split(setting).length - 1).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('RCD-03: every pbxproj build configuration is pinned', () => {
  it('D1: Release-only TARGETED_DEVICE_FAMILY = 2 fails', () => {
    const result = runGate({
      [PBX]: t =>
        replaceNth(
          t,
          'TARGETED_DEVICE_FAMILY = 1;',
          'TARGETED_DEVICE_FAMILY = 2;',
          1,
        ),
    });
    expectGateFails(result, /TARGETED_DEVICE_FAMILY/);
  });

  it('D2: Release-only PRODUCT_BUNDLE_IDENTIFIER drift fails', () => {
    const result = runGate({
      [PBX]: t =>
        replaceNth(
          t,
          'PRODUCT_BUNDLE_IDENTIFIER = com.picklesensei;',
          'PRODUCT_BUNDLE_IDENTIFIER = com.picklesensei.staging;',
          1,
        ),
    });
    expectGateFails(result, /PRODUCT_BUNDLE_IDENTIFIER/);
  });

  it('D3: Release-only DEVELOPMENT_TEAM drift fails', () => {
    const result = runGate({
      [PBX]: t =>
        replaceNth(
          t,
          'DEVELOPMENT_TEAM = H26U6W4K6V;',
          'DEVELOPMENT_TEAM = ZZZZZZZZZZ;',
          1,
        ),
    });
    expectGateFails(result, /DEVELOPMENT_TEAM/);
  });

  it('a setting present in only one configuration fails', () => {
    const result = runGate({
      [PBX]: t => replaceNth(t, 'TARGETED_DEVICE_FAMILY = 1;', '', 1),
    });
    expectGateFails(result, /TARGETED_DEVICE_FAMILY/);
  });

  it('the expected value inside a /* comment */ does not satisfy the check', () => {
    const result = runGate({
      [PBX]: t =>
        t
          .split('PRODUCT_BUNDLE_IDENTIFIER = com.picklesensei;')
          .join(
            'PRODUCT_BUNDLE_IDENTIFIER = com.picklesensei.dev; /* PRODUCT_BUNDLE_IDENTIFIER = com.picklesensei; */',
          ),
    });
    expectGateFails(result, /PRODUCT_BUNDLE_IDENTIFIER/);
  });
});

describe('RCD-03: Fastfile safety flags are read comment-stripped', () => {
  it('D4: distribute_external: true with the old value in a # comment fails', () => {
    const result = runGate({
      [FASTFILE]: t =>
        t.replace(
          'distribute_external: false, # internal testers only; external needs App Review',
          'distribute_external: true, # was distribute_external: false',
        ),
    });
    expectGateFails(result, /distribut/);
  });

  it('D5: submit_for_review: true with the old value in a # comment fails', () => {
    const result = runGate({
      [FASTFILE]: t =>
        t.replace(
          'submit_for_review: false, # review submission is a human decision',
          'submit_for_review: true, # was submit_for_review: false',
        ),
    });
    expectGateFails(result, /submit/);
  });

  it('D6: key_content sourced from a literal instead of ENV fails', () => {
    const result = runGate({
      [FASTFILE]: t =>
        t.replace(
          'key_content: ENV.fetch("APP_STORE_CONNECT_API_KEY_KEY")',
          'key_content: Base64.decode64("TUlJR0hBSUJBQUtDQVFFQXdvcGZha2Vwcml2YXRla2V5")',
        ),
    });
    expectGateFails(result, /key_content|credentials/);
  });

  it('a commented-out distribute_external: false with no live flag fails', () => {
    const result = runGate({
      [FASTFILE]: t =>
        t.replace(
          'distribute_external: false, # internal testers only; external needs App Review',
          '# distribute_external: false,',
        ),
    });
    expectGateFails(result, /distribut/);
  });

  it('a "#" inside a Ruby string is not treated as a comment (positive fixture)', () => {
    const result = runGate({
      [FASTFILE]: t =>
        t.replace(
          'distribute_external: false, # internal testers only; external needs App Review',
          'changelog: "build #{ENV.fetch(\'BUILD\')}",\n      distribute_external: false,',
        ),
    });
    expect(result.failLines).toEqual([]);
    expect(result.status).toBe(0);
  });
});
