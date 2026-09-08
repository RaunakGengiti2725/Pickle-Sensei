/**
 * Adversarial (P0-02): the package claims the mobile suite is green on a
 * fresh `npm ci` tree. A suite that is only green in ONE environment is a
 * time bomb, so this test re-runs the calendar/streak/session suites that
 * read the wall clock, the time zone or the locale in child jest processes
 * under hostile-but-legal environments: UTC+14, UTC-9 with DST, a German
 * locale, and the real clock shifted one year into the future and one year
 * into the past (through `__harness__/attack/jest.clockShift.config.js`,
 * which only ADDS a setup file to the production config).
 *
 * Every variant must report 0 failed and the same number of executed tests
 * as the untouched baseline — a variant that silently runs fewer tests is
 * not a pass either.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const MOBILE_ROOT = path.resolve(__dirname, '..', '..');
const JEST_BIN = path.join(
  MOBILE_ROOT,
  'node_modules',
  'jest',
  'bin',
  'jest.js',
);
const CLOCK_SHIFT_CONFIG = path.join(
  MOBILE_ROOT,
  '__harness__',
  'attack',
  'jest.clockShift.config.js',
);

/** Suites that read Date.now(), Intl, the zone offset or format dates. */
const CLOCK_SENSITIVE_SUITES = [
  '__tests__/consistencyEngine.test.ts',
  '__tests__/consistencyStore.test.ts',
  '__tests__/practiceHistory.test.ts',
  '__tests__/techniqueDashboard.test.ts',
  '__tests__/techniqueDashboardEdgeCases.test.ts',
  '__tests__/streakCalendarScreen.test.tsx',
  '__tests__/xc/adjudicate/calendarLabelTz.test.tsx',
  '__tests__/sessionKeeperShortLife.test.ts',
  '__tests__/authDurableSession.test.ts',
];

const YEAR_MS = 365 * 24 * 3600 * 1000;

interface Variant {
  name: string;
  env: NodeJS.ProcessEnv;
  config?: string;
}

const VARIANTS: Variant[] = [
  { name: 'TZ=Pacific/Kiritimati (UTC+14)', env: { TZ: 'Pacific/Kiritimati' } },
  {
    name: 'TZ=America/Anchorage (UTC-9, DST)',
    env: { TZ: 'America/Anchorage' },
  },
  {
    name: 'LANG/LC_ALL=de_DE.UTF-8',
    env: { LANG: 'de_DE.UTF-8', LC_ALL: 'de_DE.UTF-8' },
  },
  {
    name: 'wall clock +1 year',
    env: { PICKLE_ATTACK_CLOCK_SHIFT_MS: String(YEAR_MS) },
    config: CLOCK_SHIFT_CONFIG,
  },
  {
    name: 'wall clock -1 year',
    env: { PICKLE_ATTACK_CLOCK_SHIFT_MS: String(-YEAR_MS) },
    config: CLOCK_SHIFT_CONFIG,
  },
];

interface JestSummary {
  status: number | null;
  signal: NodeJS.Signals | null;
  failed: number;
  passed: number;
  total: number;
  tail: string;
}

function runJest(variant: Pick<Variant, 'env' | 'config'>): JestSummary {
  const args = [
    JEST_BIN,
    '--ci',
    '--silent',
    '--runInBand',
    ...(variant.config ? ['--config', variant.config] : []),
    ...CLOCK_SENSITIVE_SUITES,
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: MOBILE_ROOT,
    env: { ...process.env, ...variant.env },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  const tests = /^Tests:\s+(.*)$/m.exec(output)?.[1] ?? '';
  const count = (label: string) =>
    Number(new RegExp(`(\\d+) ${label}`).exec(tests)?.[1] ?? '0');
  return {
    status: result.status,
    signal: result.signal,
    failed: count('failed'),
    passed: count('passed'),
    total: count('total'),
    tail: output.split('\n').slice(-40).join('\n'),
  };
}

describe('clock-shift harness self-check', () => {
  it('shifts Date.now() and `new Date()` by exactly PICKLE_ATTACK_CLOCK_SHIFT_MS', () => {
    const setup = path.join(
      MOBILE_ROOT,
      '__harness__',
      'attack',
      'clockShift.setup.js',
    );
    // Unshifted wall clock even when THIS process runs under the harness.
    const parentShift =
      (globalThis as { __PICKLE_ATTACK_CLOCK_SHIFT_MS__?: number })
        .__PICKLE_ATTACK_CLOCK_SHIFT_MS__ ?? 0;
    const before = Date.now() - parentShift;
    const result = spawnSync(
      process.execPath,
      ['-r', setup, '-e', 'console.log(Date.now(), new Date().getTime())'],
      {
        cwd: MOBILE_ROOT,
        env: { ...process.env, PICKLE_ATTACK_CLOCK_SHIFT_MS: String(YEAR_MS) },
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(0);
    const [now = NaN, constructed = NaN] = result.stdout
      .trim()
      .split(' ')
      .map(Number);
    expect(now - before).toBeGreaterThanOrEqual(YEAR_MS);
    expect(now - before).toBeLessThan(YEAR_MS + 60_000);
    expect(constructed - before).toBeGreaterThanOrEqual(YEAR_MS);
  });

  it('refuses a non-numeric shift instead of silently running unshifted', () => {
    const setup = path.join(
      MOBILE_ROOT,
      '__harness__',
      'attack',
      'clockShift.setup.js',
    );
    const result = spawnSync(process.execPath, ['-r', setup, '-e', '0'], {
      cwd: MOBILE_ROOT,
      env: { ...process.env, PICKLE_ATTACK_CLOCK_SHIFT_MS: 'tomorrow' },
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('PICKLE_ATTACK_CLOCK_SHIFT_MS');
  });
});

describe('P0-02 environment matrix over the clock/zone/locale-sensitive suites', () => {
  let baseline: JestSummary;

  beforeAll(() => {
    baseline = runJest({ env: { TZ: 'UTC' } });
  });

  it('baseline (TZ=UTC) is green and actually executes tests', () => {
    expect(baseline.tail).toBeDefined();
    expect(baseline.signal).toBeNull();
    expect(baseline.status).toBe(0);
    expect(baseline.failed).toBe(0);
    expect(baseline.total).toBeGreaterThan(100);
    expect(baseline.passed).toBe(baseline.total);
  });

  it.each(VARIANTS.map(variant => [variant.name, variant] as const))(
    'stays green with the same executed count under %s',
    (_name, variant) => {
      const summary = runJest(variant);
      const verdict = {
        status: summary.status,
        signal: summary.signal,
        failed: summary.failed,
        total: summary.total,
      };
      expect({ ...verdict, tail: summary.failed ? summary.tail : '' }).toEqual({
        status: 0,
        signal: null,
        failed: 0,
        total: baseline.total,
        tail: '',
      });
    },
  );
});
