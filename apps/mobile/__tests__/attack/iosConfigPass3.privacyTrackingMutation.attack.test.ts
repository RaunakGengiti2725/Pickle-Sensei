/**
 * ADVERSARIAL PASS 3 / mobile-ios-config — S3: does the guard suite actually
 * fail when PrivacyInfo.xcprivacy stops declaring NSPrivacyTracking=false?
 *
 * The two guards under attack read the manifest from disk at module load:
 *   __tests__/wf/fix-9-privacyManifestCollectedData.test.ts
 *   __tests__/wf/flow-app-store-compliance-ios-config.test.ts
 * so each mutation is applied to the real file, the two suites are run in a
 * CHILD jest process, and the file is restored byte-for-byte in `finally`
 * (verified against the original buffer after every case). Nothing else is
 * touched; a failing restore fails the test loudly.
 *
 * Mutations:
 *   flip     <false/> → <true/>              (must FAIL)
 *   delete   remove key + value              (must FAIL)
 *   retype   <false/> → <string>false</string> (must FAIL)
 *   dup-last append a 2nd NSPrivacyTracking=true AFTER the false (oracle probe)
 * plus a control run on the untouched file (must PASS), so a red child run is
 * attributable to the mutation and not to the environment.
 */
// Module scope, so the ambient declarations below stay file-local.
export {};

// The mobile tsconfig has no Node types (matches
// flow-app-store-compliance-ios-config.test.ts).
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  execPath: string;
  env: Record<string, string | undefined>;
};

interface Bytes {
  toString(encoding: 'utf8'): string;
  equals(other: Bytes): boolean;
}

const { readFileSync, writeFileSync } = require('fs') as {
  readFileSync: (path: string) => Bytes;
  writeFileSync: (path: string, data: Bytes | string) => void;
};
const { join } = require('path') as { join: (...parts: string[]) => string };
const { spawnSync } = require('child_process') as {
  spawnSync: (
    command: string,
    args: string[],
    options: {
      cwd: string;
      encoding: 'utf8';
      env: Record<string, string | undefined>;
    },
  ) => { status: number | null; stdout: string; stderr: string };
};

const MOBILE_ROOT = join(__dirname, '..', '..');
const MANIFEST_PATH = join(
  MOBILE_ROOT,
  'ios',
  'PickleSensei',
  'PrivacyInfo.xcprivacy',
);
const JEST_BIN = join(MOBILE_ROOT, 'node_modules', 'jest', 'bin', 'jest.js');
const GUARD_SUITES = [
  '__tests__/wf/fix-9-privacyManifestCollectedData.test.ts',
  '__tests__/wf/flow-app-store-compliance-ios-config.test.ts',
];
const TRACKING_LINE = /<key>NSPrivacyTracking<\/key>\s*<false\/>/;
const CHILD_TIMEOUT_MS = 180_000;

const original = readFileSync(MANIFEST_PATH);
const originalText = original.toString('utf8');

type ChildRun = {
  status: number | null;
  failedSuites: string[];
  passedSuites: string[];
  output: string;
};

function runGuards(): ChildRun {
  const env = { ...process.env };
  delete env.JEST_WORKER_ID;
  const result = spawnSync(
    process.execPath,
    [JEST_BIN, '--ci', '--runInBand', ...GUARD_SUITES],
    { cwd: MOBILE_ROOT, encoding: 'utf8', env },
  );
  const output = `${result.stdout}\n${result.stderr}`;
  const failedSuites = GUARD_SUITES.filter(suite =>
    new RegExp(`FAIL\\s+${suite.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`).test(
      output,
    ),
  );
  const passedSuites = GUARD_SUITES.filter(suite =>
    new RegExp(`PASS\\s+${suite.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`).test(
      output,
    ),
  );
  return { status: result.status, failedSuites, passedSuites, output };
}

function withMutatedManifest<T>(mutated: string, body: () => T): T {
  expect(mutated).not.toBe(originalText);
  writeFileSync(MANIFEST_PATH, mutated);
  try {
    return body();
  } finally {
    writeFileSync(MANIFEST_PATH, original);
  }
}

afterEach(() => {
  // Belt and braces: whatever a case did, the working tree is byte-identical.
  expect(readFileSync(MANIFEST_PATH).equals(original)).toBe(true);
});

afterAll(() => {
  writeFileSync(MANIFEST_PATH, original);
  expect(readFileSync(MANIFEST_PATH).equals(original)).toBe(true);
});

describe('S3 — NSPrivacyTracking mutations against the fix-9 + compliance guards', () => {
  jest.setTimeout(CHILD_TIMEOUT_MS * 2);

  it('precondition: the committed manifest declares NSPrivacyTracking=false exactly once', () => {
    expect(originalText).toMatch(TRACKING_LINE);
    expect(originalText.match(/<key>NSPrivacyTracking<\/key>/g)).toHaveLength(
      1,
    );
  });

  it('control: both guard suites PASS on the untouched manifest', () => {
    const run = runGuards();
    expect(run.status).toBe(0);
    expect(run.passedSuites).toEqual(GUARD_SUITES);
    expect(run.failedSuites).toEqual([]);
  });

  it('flip <false/> → <true/>: both guard suites FAIL', () => {
    const mutated = originalText.replace(
      TRACKING_LINE,
      '<key>NSPrivacyTracking</key>\n\t<true/>',
    );
    withMutatedManifest(mutated, () => {
      const run = runGuards();
      expect(run.status).not.toBe(0);
      expect(run.failedSuites).toEqual(GUARD_SUITES);
      expect(run.output).toMatch(/NSPrivacyTracking/);
    });
  });

  it('delete the NSPrivacyTracking key+value entirely: both guard suites FAIL', () => {
    const mutated = originalText.replace(TRACKING_LINE, '');
    expect(mutated).not.toMatch(/NSPrivacyTracking</);
    withMutatedManifest(mutated, () => {
      const run = runGuards();
      expect(run.status).not.toBe(0);
      expect(run.failedSuites).toEqual(GUARD_SUITES);
    });
  });

  it('retype <false/> → <string>false</string> (truthy-looking, wrong plist type): both guard suites FAIL', () => {
    const mutated = originalText.replace(
      TRACKING_LINE,
      '<key>NSPrivacyTracking</key>\n\t<string>false</string>',
    );
    withMutatedManifest(mutated, () => {
      const run = runGuards();
      expect(run.status).not.toBe(0);
      expect(run.failedSuites).toEqual(GUARD_SUITES);
    });
  });

  it('unicode look-alike key (Cyrillic "а" in NSPrivаcyTracking): both guard suites FAIL', () => {
    const mutated = originalText.replace(
      TRACKING_LINE,
      '<key>NSPriv\u0430cyTracking</key>\n\t<false/>',
    );
    withMutatedManifest(mutated, () => {
      const run = runGuards();
      expect(run.status).not.toBe(0);
      expect(run.failedSuites).toEqual(GUARD_SUITES);
    });
  });

  it('BASELINE BEHAVIOUR (oracle probe): a SECOND NSPrivacyTracking=true appended after the false is NOT caught by either guard', () => {
    // Both guards locate the FIRST `<key>NSPrivacyTracking</key>` by regex,
    // so a duplicate key later in the dict (which plist consumers may resolve
    // last-wins) slips through. This pins the observed gap; flip the
    // expectations below if the guards are hardened to reject duplicate keys.
    const mutated = originalText.replace(
      /<\/dict>\s*<\/plist>\s*$/,
      '\t<key>NSPrivacyTracking</key>\n\t<true/>\n</dict>\n</plist>\n',
    );
    expect(mutated.match(/<key>NSPrivacyTracking<\/key>/g)).toHaveLength(2);
    expect(mutated).toMatch(/<key>NSPrivacyTracking<\/key>\s*<true\/>/);
    withMutatedManifest(mutated, () => {
      const run = runGuards();
      expect(run.status).toBe(0);
      expect(run.passedSuites).toEqual(GUARD_SUITES);
    });
  });
});
