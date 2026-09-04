/**
 * Adversarial regression suite for scripts/check-ios-distribution.mjs,
 * written against 22851ac9 (RCD-03 fix). Same scratch-tree harness as
 * flow-ios-distribution-gate.test.ts; every case here is a mutation the
 * candidate gate lets through (exit 0) although the effective Fastfile /
 * project.pbxproj violates the rule the gate claims to pin.
 *
 * 1. Ruby string blanking is quote-parity based (`blankRubyStrings`): an
 *    apostrophe that is NOT a string delimiter — inside a heredoc `desc`,
 *    a `%q()` literal, a regex, a `?'` char literal — flips the parser into
 *    "inside a string" for the rest of the file, so a literal
 *    `distribute_external: true` / `submit_for_review: true` /
 *    `key_content: "<literal>"` / `key_filepath: "<literal>"` written after it
 *    is invisible to `rubyArgValues`. The `# comment` stripper cannot help:
 *    the apostrophe is not in a comment.
 * 2. `rubyAssignments` only sees `name = expr`; a `||=` fallback that pins a
 *    committed .p8 path is not an assignment to it, so
 *    `key_filepath` "comes from ENV" while the effective value is a literal.
 * 3. `hash[:distribute_external] = true` is a spelling of the flag that no
 *    `rubyArgValues` pattern recognises, so `distribute_external: false` in
 *    the same hash is the only value seen.
 * 4. The `entitlements wired` rule is still one raw-source regex test: the
 *    Release configuration can drop `CODE_SIGN_ENTITLEMENTS` (or shadow it in
 *    a comment) while Debug keeps it — the very "pins only one configuration"
 *    defect RCD-03 fixed for the three neighbouring settings.
 *
 * Run: cd apps/mobile && npx jest __tests__/wf/flow-ios-distribution-gate-attack.test.ts
 */

export {};

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

function expectGateFails(
  result: SpawnResult & { failLines: string[] },
  labelPattern: RegExp,
) {
  expect(result.status).toBe(1);
  expect(result.failLines.some(line => labelPattern.test(line))).toBe(true);
}

/** Appends `body` as the last lane of `platform :ios do … end`. */
function appendLane(body: string): Mutation {
  return text => {
    if (!text.endsWith('  end\nend\n'))
      throw new Error('Fastfile: platform block end anchor not found');
    return text.slice(0, -'end\n'.length) + '\n' + body + '\nend\n';
  };
}

const HEREDOC_DESC = `  desc <<~TEXT
    Upload to external testers. Don't wait for processing.
  TEXT
`;

describe('Fastfile: a literal flag flip after a non-delimiter apostrophe is still seen', () => {
  it('distribute_external: true in a lane documented by a heredoc desc containing an apostrophe fails', () => {
    const result = runGate({
      [FASTFILE]: appendLane(`${HEREDOC_DESC}  lane :beta_external do
    api_key = asc_api_key
    upload_to_testflight(api_key: api_key, distribute_external: true)
  end`),
    });
    expectGateFails(result, /distribute_external/);
  });

  it('submit_for_review: true in a lane documented by a heredoc desc containing an apostrophe fails', () => {
    const result = runGate({
      [FASTFILE]: appendLane(`  desc <<~TEXT
    Ship it. Don't ask.
  TEXT
  lane :ship do
    api_key = asc_api_key
    upload_to_app_store(api_key: api_key, submit_for_review: true)
  end`),
    });
    expectGateFails(result, /submit_for_review/);
  });

  it('key_content: "<literal>" after a heredoc apostrophe fails', () => {
    const result = runGate({
      [FASTFILE]: appendLane(`  desc <<~TEXT
    Don't commit keys.
  TEXT
  private_lane :asc_api_key_inline do
    app_store_connect_api_key(key_id: "K", issuer_id: "I", key_content: "MIIEvQIBADANBg")
  end`),
    });
    expectGateFails(result, /key_content/);
  });

  it('key_filepath: "<literal>" after a heredoc apostrophe fails', () => {
    const result = runGate({
      [FASTFILE]: appendLane(`  desc <<~TEXT
    Don't commit key paths.
  TEXT
  private_lane :asc_api_key_path do
    app_store_connect_api_key(key_id: "K", issuer_id: "I", key_filepath: "/Users/ci/AuthKey.p8")
  end`),
    });
    expectGateFails(result, /key_filepath/);
  });

  it("distribute_external: true after a %q(don't) literal fails", () => {
    const result = runGate({
      [FASTFILE]: appendLane(`  lane :beta_external do
    note = %q(don't wait)
    upload_to_testflight(api_key: asc_api_key, distribute_external: true)
  end`),
    });
    expectGateFails(result, /distribute_external/);
  });

  it("distribute_external: true after a regex literal /'/ fails", () => {
    const result = runGate({
      [FASTFILE]: appendLane(`  lane :beta_external do
    quoted = ENV.fetch("NOTE", "").match?(/'/)
    upload_to_testflight(api_key: asc_api_key, distribute_external: true)
  end`),
    });
    expectGateFails(result, /distribute_external/);
  });

  it("distribute_external: true after a ?' character literal fails", () => {
    const result = runGate({
      [FASTFILE]: appendLane(`  lane :beta_external do
    quote = ?'
    upload_to_testflight(api_key: asc_api_key, distribute_external: true)
  end`),
    });
    expectGateFails(result, /distribute_external/);
  });
});

describe('Fastfile: key_filepath that is effectively a committed literal', () => {
  it('a local read from ENV then `||=` a literal path is not "from ENV"', () => {
    const result = runGate({
      [FASTFILE]: appendLane(`  private_lane :asc_api_key_fallback do
    kp = ENV["APP_STORE_CONNECT_API_KEY_KEY_FILEPATH"]
    kp ||= "/Users/ci/AuthKey.p8"
    app_store_connect_api_key(key_id: "K", issuer_id: "I", key_filepath: kp)
  end`),
    });
    expectGateFails(result, /key_filepath/);
  });
});

describe('Fastfile: the flag is set through an index assignment on the options hash', () => {
  it('opts[:distribute_external] = true after distribute_external: false fails', () => {
    const result = runGate({
      [FASTFILE]: appendLane(`  lane :beta_external do
    opts = { api_key: asc_api_key, distribute_external: false }
    opts[:distribute_external] = true
    upload_to_testflight(**opts)
  end`),
    });
    expectGateFails(result, /distribute_external/);
  });
});

describe('pbxproj: CODE_SIGN_ENTITLEMENTS is pinned in every build configuration', () => {
  const ENTITLEMENTS =
    'CODE_SIGN_ENTITLEMENTS = PickleSensei/PickleSensei.entitlements;';

  it('precondition: the committed pbxproj wires the entitlements in >= 2 configurations', () => {
    const pbx = fs.readFileSync(join(MOBILE_ROOT, PBX), 'utf8');
    expect(pbx.split(ENTITLEMENTS).length - 1).toBeGreaterThanOrEqual(2);
  });

  it('Release-only CODE_SIGN_ENTITLEMENTS = "" (Debug still wired) fails', () => {
    const result = runGate({
      [PBX]: t =>
        replaceNth(t, ENTITLEMENTS, 'CODE_SIGN_ENTITLEMENTS = "";', 1),
    });
    expectGateFails(result, /entitlements/);
  });

  it('Release-only CODE_SIGN_ENTITLEMENTS shadowed in a /* comment */ fails', () => {
    const result = runGate({
      [PBX]: t => replaceNth(t, ENTITLEMENTS, `/* ${ENTITLEMENTS} */`, 1),
    });
    expectGateFails(result, /entitlements/);
  });
});
