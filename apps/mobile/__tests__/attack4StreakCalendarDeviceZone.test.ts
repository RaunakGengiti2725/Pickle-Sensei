/**
 * Runs attack/attack4StreakCalendarDeviceZone.tzcase.tsx in a child jest whose
 * process zone is pinned to a device zone at or beyond UTC+12. A JS engine's
 * default zone is fixed at process start, so the only faithful way to render
 * the screen "on a phone in Auckland" from a UTC CI box is a separate process
 * with TZ set — this suite is that harness. The day labels under test must
 * name the tapped / earned calendar day in every zone; a +13/+14 zone is
 * where a naive noon-UTC round-trip through the device zone names day+1.
 */

// The mobile tsconfig has no Node types (matches the __tests__/wf suites).
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  execPath: string;
  env: Record<string, string | undefined>;
};

export {};

const path = require('path') as {
  resolve: (...parts: string[]) => string;
  relative: (from: string, to: string) => string;
};
const childProcess = require('child_process') as {
  spawnSync: (
    command: string,
    args: string[],
    options: {
      cwd: string;
      encoding: 'utf8';
      env: Record<string, string | undefined>;
      timeout: number;
    },
  ) => {
    status: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    error?: Error;
  };
};

const MOBILE_ROOT = path.resolve(__dirname, '..');
const JEST_BIN = path.resolve(
  MOBILE_ROOT,
  'node_modules',
  'jest',
  'bin',
  'jest.js',
);
const TZCASE = path.resolve(
  MOBILE_ROOT,
  'attack',
  'attack4StreakCalendarDeviceZone.tzcase.tsx',
);
const CHILD_TIMEOUT_MS = 240_000;

/** Zones whose civil day is ahead of UTC by 13-14 hours at 2026-03-10: the
 * southern-summer NZDT offset and the largest offset in the tz database. */
const DEVICE_ZONES = ['Pacific/Auckland', 'Pacific/Kiritimati'] as const;

function runTzCase(timeZone: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    TZ: timeZone,
    CI: 'true',
  };
  // The child is its own jest; it must not think it is one of our workers.
  delete env.JEST_WORKER_ID;
  return childProcess.spawnSync(
    process.execPath,
    [JEST_BIN, '--ci', '--runTestsByPath', TZCASE],
    { cwd: MOBILE_ROOT, encoding: 'utf8', env, timeout: CHILD_TIMEOUT_MS },
  );
}

describe('StreakCalendar day labels rendered in a UTC+13/+14 device zone', () => {
  it.each(DEVICE_ZONES)(
    'every tzcase passes under TZ=%s',
    timeZone => {
      const result = runTzCase(timeZone);
      const report = [
        `TZ=${timeZone} node ${path.relative(MOBILE_ROOT, JEST_BIN)} --ci --runTestsByPath ${path.relative(MOBILE_ROOT, TZCASE)}`,
        `status=${result.status} signal=${result.signal}${
          result.error ? ` error=${result.error.message}` : ''
        }`,
        result.stderr,
        result.stdout,
      ].join('\n');
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      if (result.status !== 0) {
        throw new Error(report);
      }
      // A run that found no tests exits 1 without --passWithNoTests, so a zero
      // status already proves the cases ran; pin the count anyway.
      expect(result.stderr).toMatch(/Tests:\s+4 passed, 4 total/);
    },
    CHILD_TIMEOUT_MS + 10_000,
  );
});
