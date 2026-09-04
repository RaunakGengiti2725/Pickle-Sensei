/**
 * AUDIT PROBE (mobile-ios-config, plane mac / auditor #2).
 *
 * Suspected defect: `tools/macos-ci/select-simulator.sh` embeds its Python
 * picker in a single-quoted bash string but line 46 contains the Python
 * literal `'.'`, which terminates the bash string. Python therefore receives
 * `{..join(...)}` and dies with a SyntaxError before printing anything; the
 * caller `UDID="$(pick || true)"` swallows the failure, so the script ALWAYS
 * reports "no available iPhone simulator found" and creates a brand-new
 * `PickleSensei-CI` device on the single physical M4 runner — twice per Mac
 * Full Verify run (swift-native + ios-app stages). The same-SHA artifact for
 * 4d812e1a shows exactly this (ios-app.log:109-114, swift-native.log:82-85).
 *
 * The probe runs the real script on Linux with a stub `xcrun` that reports an
 * available, already-booted iPhone and asserts the picker selects it instead
 * of creating a device.
 */
// Module scope (no imports otherwise) so the declarations below stay local.
export {};

// Node built-ins typed by hand: the RN tsconfig ships no node types.
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}
const { spawnSync } = require('child_process') as {
  spawnSync: (
    cmd: string,
    args: string[],
    options: {
      encoding: 'utf8';
      env: Record<string, string | undefined>;
      timeout: number;
    },
  ) => SpawnResult;
};
const fs = require('fs') as {
  mkdtempSync: (prefix: string) => string;
  mkdirSync: (p: string) => void;
  symlinkSync: (target: string, p: string) => void;
  chmodSync: (p: string, mode: number) => void;
  writeFileSync: (p: string, data: string) => void;
  readFileSync: (p: string, encoding: 'utf8') => string;
};
const os = require('os') as { tmpdir: () => string };
const path = require('path') as {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
};

const repoRoot = path.resolve(__dirname, '../../../../..');
const script = path.join(repoRoot, 'tools/macos-ci/select-simulator.sh');
const fixtures = path.join(__dirname, 'fixtures');

describe('audit probe: select-simulator.sh picks an existing iPhone', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'select-sim-probe-'));
  const binDir = path.join(tmp, 'bin');
  const createLog = path.join(tmp, 'created.log');
  fs.mkdirSync(binDir);
  fs.symlinkSync(
    path.join(fixtures, 'xcrun-stub.sh'),
    path.join(binDir, 'xcrun'),
  );
  fs.chmodSync(path.join(fixtures, 'xcrun-stub.sh'), 0o755);
  fs.writeFileSync(createLog, '');

  const run = spawnSync('bash', [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      XCRUN_STUB_LOG: createLog,
    },
    timeout: 30_000,
  });

  test('precondition: the script ran with the stubbed xcrun', () => {
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);
  });

  test('the embedded Python picker does not crash with a SyntaxError', () => {
    expect(run.stderr).not.toMatch(/SyntaxError/);
  });

  test('prints the booted, newest-runtime iPhone instead of creating one', () => {
    expect(run.stdout.trim()).toBe('FIXTURE-BOOTED-IPHONE-17-PRO');
    expect(run.stderr).not.toMatch(/no available iPhone simulator found/);
    expect(fs.readFileSync(createLog, 'utf8')).toBe('');
  });
});
