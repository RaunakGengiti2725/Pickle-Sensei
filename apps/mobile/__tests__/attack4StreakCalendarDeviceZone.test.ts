/**
 * Adversarial pass 3 (#4) — device-zone runner.
 *
 * Jest cannot change the process time zone after start-up (V8 caches it), so
 * `attack/attack4StreakCalendarDeviceZone.tzcase.tsx` must run in a CHILD
 * jest process started with `TZ=Pacific/Auckland`. This wrapper does exactly
 * that and fails when the child fails, so the attack participates in the
 * default `npx jest --ci` run without any manual step.
 *
 * Manual equivalent:
 *   cd apps/mobile && TZ=Pacific/Auckland node node_modules/jest/bin/jest.js \
 *     --ci --testMatch '** /attack/*.tzcase.tsx' \
 *     --runTestsByPath attack/attack4StreakCalendarDeviceZone.tzcase.tsx
 */

interface SpawnSyncResult {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

interface ChildProcessLike {
  spawnSync(
    command: string,
    args: readonly string[],
    options: {
      cwd: string;
      env: Record<string, string | undefined>;
      encoding: 'utf8';
      timeout: number;
      maxBuffer: number;
    },
  ): SpawnSyncResult;
}

interface NodeProcessLike {
  execPath: string;
  env: Record<string, string | undefined>;
}

const { spawnSync } = jest.requireActual<ChildProcessLike>('child_process');
const nodeProcess = (globalThis as unknown as { process: NodeProcessLike })
  .process;

const ZONE = 'Pacific/Auckland';
const CASE_FILE = 'attack/attack4StreakCalendarDeviceZone.tzcase.tsx';

function mobileRoot(): string {
  const testPath = expect.getState().testPath ?? '';
  const marker = '/__tests__/';
  const idx = testPath.lastIndexOf(marker);
  if (idx < 0) throw new Error(`unexpected test path ${testPath}`);
  return testPath.slice(0, idx);
}

describe('attack4: StreakCalendar/Achievements labels in a UTC+13 device zone', () => {
  jest.setTimeout(240_000);

  it(`runs ${CASE_FILE} under TZ=${ZONE} and every case passes`, () => {
    const cwd = mobileRoot();
    const result = spawnSync(
      nodeProcess.execPath,
      [
        'node_modules/jest/bin/jest.js',
        '--ci',
        '--testMatch',
        '**/attack/*.tzcase.tsx',
        '--runTestsByPath',
        CASE_FILE,
      ],
      {
        cwd,
        env: { ...nodeProcess.env, TZ: ZONE, FORCE_COLOR: '0' },
        encoding: 'utf8',
        timeout: 220_000,
        maxBuffer: 64 * 1024 * 1024,
      },
    );

    if (result.error) throw result.error;
    const report = result.stderr + result.stdout;
    // The child must actually have executed the cases (not "0 total").
    expect(report).toMatch(/Tests:\s+.*\b3 total/);
    expect({
      status: result.status,
      signal: result.signal,
      failing: report
        .split('\n')
        .filter(line => /^\s+✕/.test(line))
        .map(line => line.trim()),
    }).toEqual({ status: 0, signal: null, failing: [] });
  });
});
