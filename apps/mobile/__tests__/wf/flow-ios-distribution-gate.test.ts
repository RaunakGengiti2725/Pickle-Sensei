/**
 * `npm run check:distribution` gate — mutation coverage.
 *
 * Copies scripts/check-ios-distribution.mjs plus every file it reads into a
 * scratch apps/mobile root, applies ONE mutation, and runs the real CLI. A
 * correct gate rejects every mutated tree with exit 1 and a `FAIL <label>`
 * line, and accepts the committed tree with exit 0. Pins the release
 * invariants the Fastfile and project.pbxproj carry: every build
 * configuration ships bundle id com.picklesensei, iPhone-only, the one
 * development team; the effective (comment-stripped) lanes never distribute
 * externally or submit for review; the ASC key comes from the environment.
 */

// The mobile tsconfig has no Node types (matches flow-app-store-compliance).
declare const require: (id: string) => unknown;
declare const __dirname: string;
type Fs = {
  readFileSync: (path: string, encoding: 'utf8') => string;
  writeFileSync: (path: string, data: string) => void;
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  mkdtempSync: (prefix: string) => string;
  rmSync: (
    path: string,
    options: { recursive: boolean; force: boolean },
  ) => void;
  copyFileSync: (src: string, dst: string) => void;
};
type Path = {
  join: (...parts: string[]) => string;
  dirname: (path: string) => string;
};
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
const { tmpdir } = require('os') as { tmpdir: () => string };
const { spawnSync } = require('child_process') as ChildProcess;

const MOBILE_ROOT = join(__dirname, '..', '..');
const CHECKER = 'scripts/check-ios-distribution.mjs';
const PBX = 'ios/PickleSensei.xcodeproj/project.pbxproj';
const FASTFILE = 'ios/fastlane/Fastfile';
const INPUTS = [
  PBX,
  'ios/PickleSensei/Info.plist',
  'ios/PickleSensei/PrivacyInfo.xcprivacy',
  'ios/PickleSensei/PickleSensei.entitlements',
  'ios/Podfile.lock',
  FASTFILE,
  'ios/fastlane/Appfile',
];

type Mutation = Record<string, (text: string) => string>;

function replaceNth(
  text: string,
  needle: string,
  replacement: string,
  n: number,
): string {
  let idx = -1;
  for (let i = 0; i <= n; i += 1) {
    idx = text.indexOf(needle, idx + 1);
    if (idx < 0) {
      throw new Error(`occurrence ${n} of ${JSON.stringify(needle)} not found`);
    }
  }
  return text.slice(0, idx) + replacement + text.slice(idx + needle.length);
}

function mustReplace(text: string, from: string, to: string): string {
  if (!text.includes(from)) {
    throw new Error(`${JSON.stringify(from)} not found — fixture drifted`);
  }
  return text.replace(from, to);
}

function runGate(mutate: Mutation) {
  const root = fs.mkdtempSync(join(tmpdir(), 'check-distribution-'));
  try {
    for (const rel of [CHECKER, ...INPUTS]) {
      const dst = join(root, rel);
      fs.mkdirSync(dirname(dst), { recursive: true });
      fs.copyFileSync(join(MOBILE_ROOT, rel), dst);
    }
    for (const [rel, fn] of Object.entries(mutate)) {
      const dst = join(root, rel);
      const before = fs.readFileSync(dst, 'utf8');
      const after = fn(before);
      if (after === before) {
        throw new Error(`mutation of ${rel} was a no-op`);
      }
      fs.writeFileSync(dst, after);
    }
    const r = spawnSync('node', [join(root, CHECKER)], {
      cwd: root,
      encoding: 'utf8',
    });
    const output = r.stdout + r.stderr;
    return {
      exit: r.status,
      output,
      failLines: output.split('\n').filter(line => line.startsWith('FAIL ')),
      threw: /^\s+at .*\.mjs:\d+|TypeError|SyntaxError/m.test(r.stderr),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function expectRejected(mutate: Mutation, label: RegExp) {
  const r = runGate(mutate);
  expect(r.threw).toBe(false);
  expect(r.exit).toBe(1);
  expect(r.failLines.length).toBeGreaterThan(0);
  expect(r.failLines.some(line => label.test(line))).toBe(true);
}

describe('check:distribution baseline', () => {
  it('accepts the committed tree', () => {
    const r = runGate({});
    expect(r.failLines).toEqual([]);
    expect(r.exit).toBe(0);
  });
});

describe('project.pbxproj: every build configuration is pinned', () => {
  it('rejects a Release-only TARGETED_DEVICE_FAMILY change (iPad-only)', () => {
    expectRejected(
      {
        [PBX]: t =>
          replaceNth(
            t,
            'TARGETED_DEVICE_FAMILY = 1;',
            'TARGETED_DEVICE_FAMILY = 2;',
            1,
          ),
      },
      /TARGETED_DEVICE_FAMILY/,
    );
  });

  it('rejects a Release-only universal TARGETED_DEVICE_FAMILY = "1,2"', () => {
    expectRejected(
      {
        [PBX]: t =>
          replaceNth(
            t,
            'TARGETED_DEVICE_FAMILY = 1;',
            'TARGETED_DEVICE_FAMILY = "1,2";',
            1,
          ),
      },
      /TARGETED_DEVICE_FAMILY/,
    );
  });

  it('rejects a Release-only PRODUCT_BUNDLE_IDENTIFIER change', () => {
    expectRejected(
      {
        [PBX]: t =>
          replaceNth(
            t,
            'PRODUCT_BUNDLE_IDENTIFIER = com.picklesensei;',
            'PRODUCT_BUNDLE_IDENTIFIER = com.picklesensei.staging;',
            1,
          ),
      },
      /PRODUCT_BUNDLE_IDENTIFIER/,
    );
  });

  it('rejects a Release-only DEVELOPMENT_TEAM change', () => {
    expectRejected(
      {
        [PBX]: t =>
          replaceNth(
            t,
            'DEVELOPMENT_TEAM = H26U6W4K6V;',
            'DEVELOPMENT_TEAM = ZZZZZZZZZZ;',
            1,
          ),
      },
      /DEVELOPMENT_TEAM/,
    );
  });

  it('rejects a Debug-only DEVELOPMENT_TEAM change (all occurrences, not any)', () => {
    expectRejected(
      {
        [PBX]: t =>
          replaceNth(
            t,
            'DEVELOPMENT_TEAM = H26U6W4K6V;',
            'DEVELOPMENT_TEAM = ZZZZZZZZZZ;',
            0,
          ),
      },
      /DEVELOPMENT_TEAM/,
    );
  });

  it('rejects the correct value surviving only inside a /* comment */', () => {
    expectRejected(
      {
        [PBX]: t =>
          t
            .split('PRODUCT_BUNDLE_IDENTIFIER = com.picklesensei;')
            .join(
              'PRODUCT_BUNDLE_IDENTIFIER = com.other; /* PRODUCT_BUNDLE_IDENTIFIER = com.picklesensei; */',
            ),
      },
      /PRODUCT_BUNDLE_IDENTIFIER/,
    );
  });

  it('rejects a single remaining configuration (fewer than two occurrences)', () => {
    expectRejected(
      {
        [PBX]: t => {
          // Drop every pinned setting from the second (Release) configuration.
          let out = t;
          for (const line of [
            'PRODUCT_BUNDLE_IDENTIFIER = com.picklesensei;',
            'TARGETED_DEVICE_FAMILY = 1;',
            'DEVELOPMENT_TEAM = H26U6W4K6V;',
          ]) {
            out = replaceNth(out, line, '', 1);
          }
          return out;
        },
      },
      /PRODUCT_BUNDLE_IDENTIFIER|TARGETED_DEVICE_FAMILY|DEVELOPMENT_TEAM/,
    );
  });

  it('rejects version fields that disagree between configurations', () => {
    expectRejected(
      {
        [PBX]: t =>
          replaceNth(
            t,
            'MARKETING_VERSION = 1.0;',
            'MARKETING_VERSION = 1.1;',
            1,
          ),
      },
      /MARKETING_VERSION/,
    );
  });
});

describe('Fastfile: effective (comment-stripped) safety flags', () => {
  it('rejects distribute_external: true even with the old value in a # comment', () => {
    expectRejected(
      {
        [FASTFILE]: t =>
          mustReplace(
            t,
            'distribute_external: false, # internal testers only; external needs App Review',
            'distribute_external: true, # was distribute_external: false',
          ),
      },
      /distribute_external/,
    );
  });

  it('rejects submit_for_review: true even with the old value in a # comment', () => {
    expectRejected(
      {
        [FASTFILE]: t =>
          mustReplace(
            t,
            'submit_for_review: false, # review submission is a human decision',
            'submit_for_review: true, # was submit_for_review: false',
          ),
      },
      /submit_for_review/,
    );
  });

  it('rejects the safety flags being commented out entirely', () => {
    expectRejected(
      {
        [FASTFILE]: t =>
          mustReplace(
            t,
            'distribute_external: false,',
            '# distribute_external: false,',
          ),
      },
      /distribute_external/,
    );
  });

  it('rejects a key_content literal (no -----BEGIN marker)', () => {
    expectRejected(
      {
        [FASTFILE]: t =>
          mustReplace(
            t,
            'key_content: ENV.fetch("APP_STORE_CONNECT_API_KEY_KEY")',
            'key_content: Base64.decode64("TUlJR0hBSUJBQUtDQVFFQXdvcGZha2Vwcml2YXRla2V5")',
          ),
      },
      /key_content/,
    );
  });

  it('rejects key_content read from a different environment variable', () => {
    expectRejected(
      {
        [FASTFILE]: t =>
          mustReplace(
            t,
            'key_content: ENV.fetch("APP_STORE_CONNECT_API_KEY_KEY")',
            'key_content: ENV.fetch("SOME_OTHER_KEY")',
          ),
      },
      /key_content/,
    );
  });

  it('still accepts the Ruby "#{...}" interpolations the lanes rely on', () => {
    // A `#` inside a double-quoted string is not a comment; the committed
    // Fastfile uses several and must keep passing (see baseline). An
    // interpolation on the same line, ahead of a pinned flag, must not hide it.
    const r = runGate({
      [FASTFILE]: t =>
        mustReplace(
          t,
          'distribute_external: false, # internal testers only; external needs App Review',
          'changelog: "build #{number}", distribute_external: false, # internal only',
        ),
    });
    expect(r.failLines).toEqual([]);
    expect(r.exit).toBe(0);
  });
});
