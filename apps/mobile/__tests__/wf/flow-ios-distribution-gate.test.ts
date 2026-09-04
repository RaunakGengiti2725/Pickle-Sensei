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

describe('RCD-03 (round 2): conditional build-setting overrides are effective values', () => {
  /** Append a conditional override right after the n-th unconditional `setting = value;`. */
  function addConditional(
    setting: string,
    value: string,
    condition: string,
    override: string,
    n = 1,
  ): Mutation {
    return pbx =>
      replaceNth(
        pbx,
        `${setting} = ${value};`,
        `${setting} = ${value};\n\t\t\t\t"${setting}[${condition}]" = ${override};`,
        n,
      );
  }

  it('precondition: the committed pbxproj already uses "SETTING[sdk=iphoneos*]" conditional settings', () => {
    const pbx = fs.readFileSync(join(MOBILE_ROOT, PBX), 'utf8');
    expect(pbx).toMatch(/"[A-Z_]+\[sdk=iphoneos\*\]" = /);
  });

  it('a same-value conditional override still passes (positive fixture)', () => {
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

  it('A3: "PRODUCT_BUNDLE_IDENTIFIER[sdk=iphoneos*]" = com.picklesensei.staging; fails', () => {
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

  it('A4: "TARGETED_DEVICE_FAMILY[sdk=iphoneos*]" = "1,2"; fails', () => {
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

  it('A5: "DEVELOPMENT_TEAM[sdk=iphoneos*]" = ZZZZZZZZZZ; fails (pbxproj pin AND Appfile match)', () => {
    const result = runGate({
      [PBX]: addConditional(
        'DEVELOPMENT_TEAM',
        'H26U6W4K6V',
        'sdk=iphoneos*',
        'ZZZZZZZZZZ',
      ),
    });
    expectGateFails(result, /pbxproj: DEVELOPMENT_TEAM/);
    expectGateFails(result, /Appfile team matches DEVELOPMENT_TEAM/);
  });

  it('"PRODUCT_BUNDLE_IDENTIFIER[config=Release]" = com.picklesensei.staging; on Debug fails', () => {
    const result = runGate({
      [PBX]: addConditional(
        'PRODUCT_BUNDLE_IDENTIFIER',
        'com.picklesensei',
        'config=Release',
        'com.picklesensei.staging',
        0,
      ),
    });
    expectGateFails(result, /PRODUCT_BUNDLE_IDENTIFIER/);
  });

  it('"TARGETED_DEVICE_FAMILY[arch=arm64]" = 2; fails', () => {
    const result = runGate({
      [PBX]: addConditional('TARGETED_DEVICE_FAMILY', '1', 'arch=arm64', '2'),
    });
    expectGateFails(result, /TARGETED_DEVICE_FAMILY/);
  });

  it('a conditional MARKETING_VERSION / CURRENT_PROJECT_VERSION that disagrees with the plain value fails', () => {
    const version = runGate({
      [PBX]: t =>
        t.replace(
          /MARKETING_VERSION = ([\d.]+);/,
          (line, v) =>
            `${line}\n\t\t\t\t"MARKETING_VERSION[sdk=iphoneos*]" = ${v}.99;`,
        ),
    });
    expectGateFails(version, /MARKETING_VERSION/);
    const build = runGate({
      [PBX]: t =>
        t.replace(
          /CURRENT_PROJECT_VERSION = (\d+);/,
          (line, v) =>
            `${line}\n\t\t\t\t"CURRENT_PROJECT_VERSION[sdk=iphoneos*]" = ${v}99;`,
        ),
    });
    expectGateFails(build, /CURRENT_PROJECT_VERSION/);
  });
});

describe('RCD-03 (round 2): every Ruby spelling of the Fastfile safety flags is read', () => {
  const DIST_FALSE =
    'distribute_external: false, # internal testers only; external needs App Review';
  const REVIEW_FALSE =
    'submit_for_review: false, # review submission is a human decision';
  const KEY_CONTENT = 'key_content: ENV.fetch("APP_STORE_CONNECT_API_KEY_KEY")';

  it('A6: :distribute_external => true (stale distribute_external: false elsewhere) fails', () => {
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

  it('A7: :submit_for_review => true (stale submit_for_review: false elsewhere) fails', () => {
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

  it('"distribute_external" => true and "distribute_external": true string-key spellings fail', () => {
    const rocket = runGate({
      [FASTFILE]: text =>
        text.replace(DIST_FALSE, '"distribute_external" => true,'),
    });
    expectGateFails(rocket, /distribute_external/);
    const jsonStyle = runGate({
      [FASTFILE]: text =>
        text.replace(REVIEW_FALSE, "'submit_for_review': true,"),
    });
    expectGateFails(jsonStyle, /submit_for_review/);
  });

  it('a non-literal flag value (distribute_external: !false, submit_for_review: ENV[...]) fails', () => {
    expectGateFails(
      runGate({
        [FASTFILE]: text =>
          text.replace(DIST_FALSE, 'distribute_external: !false,'),
      }),
      /distribute_external/,
    );
    expectGateFails(
      runGate({
        [FASTFILE]: text =>
          text.replace(
            REVIEW_FALSE,
            'submit_for_review: ENV["SUBMIT"] == "1",',
          ),
      }),
      /submit_for_review/,
    );
  });

  it('hash-rocket false spellings are accepted as the safeguard (positive fixture)', () => {
    const result = runGate({
      [FASTFILE]: text =>
        text
          .replace(DIST_FALSE, ':distribute_external => false,')
          .replace(REVIEW_FALSE, '"submit_for_review" => false,'),
    });
    expect(result.failLines).toEqual([]);
    expect(result.status).toBe(0);
  });

  it(':key_content => <literal> hash-rocket spelling fails like key_content: <literal>', () => {
    const result = runGate({
      [FASTFILE]: text =>
        text.replace(
          KEY_CONTENT,
          ':key_content => Base64.decode64("TUlJR0hBSUJBQUtDQVFFQXdvcGZha2Vwcml2YXRla2V5")',
        ),
    });
    expectGateFails(result, /key_content|credentials/);
  });

  it('key_content: ENV.fetch(...) wrapped in a transform (e.g. .strip) is not the exact source', () => {
    const result = runGate({
      [FASTFILE]: text =>
        text.replace(
          KEY_CONTENT,
          'key_content: ENV.fetch("APP_STORE_CONNECT_API_KEY_KEY").strip',
        ),
    });
    expectGateFails(result, /key_content|credentials/);
  });

  it('a key_filepath argument that is a string literal (committed key path) fails', () => {
    const result = runGate({
      [FASTFILE]: text =>
        text.replace(
          '{ key_filepath: key_filepath }',
          '{ key_filepath: "fastlane/AuthKey_ABC123.p8" }',
        ),
    });
    expectGateFails(result, /key_filepath|credentials/);
  });

  it('key_filepath sourced from a local assigned from a literal fails; from ENV passes', () => {
    expectGateFails(
      runGate({
        [FASTFILE]: text =>
          text.replace(
            'private_lane :asc_api_key do\n    key_filepath = ENV["APP_STORE_CONNECT_API_KEY_KEY_FILEPATH"]',
            'private_lane :asc_api_key do\n    key_filepath = "fastlane/AuthKey_ABC123.p8"',
          ),
      }),
      /key_filepath|credentials/,
    );
    const viaFetch = runGate({
      [FASTFILE]: text =>
        text.replace(
          '{ key_filepath: key_filepath }',
          '{ key_filepath: ENV.fetch("APP_STORE_CONNECT_API_KEY_KEY_FILEPATH") }',
        ),
    });
    expect(viaFetch.failLines).toEqual([]);
    expect(viaFetch.status).toBe(0);
  });
});

describe('RCD-03 (round 2): Info.plist version keys are read structurally', () => {
  it('a hardcoded CFBundleShortVersionString with $(MARKETING_VERSION) only in an XML comment fails', () => {
    const result = runGate({
      ['ios/PickleSensei/Info.plist']: t =>
        t.replace(
          '<key>CFBundleShortVersionString</key>\n\t<string>$(MARKETING_VERSION)</string>',
          '<key>CFBundleShortVersionString</key>\n\t<string>1.0</string>\n\t<!-- was <string>$(MARKETING_VERSION)</string> -->',
        ),
    });
    expectGateFails(result, /Info\.plist: version/);
  });

  it('a hardcoded CFBundleVersion with $(CURRENT_PROJECT_VERSION) under an unrelated key fails', () => {
    const result = runGate({
      ['ios/PickleSensei/Info.plist']: t =>
        t.replace(
          '<key>CFBundleVersion</key>\n\t<string>$(CURRENT_PROJECT_VERSION)</string>',
          '<key>CFBundleVersion</key>\n\t<string>1</string>\n\t<key>PSBuildNote</key>\n\t<string>$(CURRENT_PROJECT_VERSION)</string>',
        ),
    });
    expectGateFails(result, /Info\.plist: version/);
  });

  it('the committed Info.plist sources both version keys from build settings (positive fixture)', () => {
    const plist = fs.readFileSync(
      join(MOBILE_ROOT, 'ios/PickleSensei/Info.plist'),
      'utf8',
    );
    expect(plist).toContain(
      '<key>CFBundleShortVersionString</key>\n\t<string>$(MARKETING_VERSION)</string>',
    );
    expect(plist).toContain(
      '<key>CFBundleVersion</key>\n\t<string>$(CURRENT_PROJECT_VERSION)</string>',
    );
  });
});
