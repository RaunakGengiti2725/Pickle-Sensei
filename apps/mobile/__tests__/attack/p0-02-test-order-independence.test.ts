/**
 * Adversarial (P0-02): the package objective is "root-cause any mobile Jest
 * suite failing on the continuation head". A suite that is only green when
 * its `it` blocks run in declaration order is one refactor away from failing
 * on that head — and worse, a test that inherits mock state from an earlier
 * test can pass for the wrong reason.
 *
 * `jest --randomize --seed N` (a stock Jest 29 flag, no config change) shuffles
 * the order of tests WITHIN each file. This attack re-runs a small set of
 * suites — three that the full randomized run flagged plus two controls that
 * exercise the same production modules — under three seeds and expects each
 * to stay green with its full executed count. Nothing about the production
 * config is weakened: the child runs the real `jest.config.js`.
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

/** Suspects (flagged by a full `--randomize` run) and order-agnostic controls. */
const SUITES = [
  '__tests__/wf/flow-crash-safety-error-boundaries.test.tsx',
  '__tests__/matrix/networkAuthMatrix.test.ts',
  '__tests__/serverResponseMatrix.callSites.test.ts',
  '__tests__/sessionKeeperShortLife.test.ts',
  '__tests__/authDurableSession.test.ts',
];

const SEEDS = [1, 20260908];

interface Run {
  status: number | null;
  failed: number;
  passed: number;
  total: number;
  failedSuites: string[];
  failedTests: string[];
}

function runJest(suite: string, seed: number | null): Run {
  const args = [
    JEST_BIN,
    '--ci',
    '--silent',
    '--runInBand',
    ...(seed === null ? [] : ['--randomize', '--seed', String(seed)]),
    suite,
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: MOBILE_ROOT,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  const tests = /^Tests:\s+(.*)$/m.exec(output)?.[1] ?? '';
  const count = (label: string) =>
    Number(new RegExp(`(\\d+) ${label}`).exec(tests)?.[1] ?? '0');
  const failedSuites = [...output.matchAll(/^FAIL (\S+)/gm)].map(
    match => match[1] ?? '',
  );
  const failedTests = [...output.matchAll(/^ {2}● (.+)$/gm)].map(
    match => match[1] ?? '',
  );
  return {
    status: result.status,
    failed: count('failed'),
    passed: count('passed'),
    total: count('total'),
    failedSuites: [...new Set(failedSuites)],
    failedTests: [...new Set(failedTests)],
  };
}

describe('P0-02 attack: every suite is green regardless of in-file test order', () => {
  jest.setTimeout(10 * 60_000);

  describe.each(SUITES)('%s', suite => {
    let declared: Run;

    beforeAll(() => {
      declared = runJest(suite, null);
    });

    it('is green in declaration order (precondition)', () => {
      expect(declared.status).toBe(0);
      expect(declared.failed).toBe(0);
      expect(declared.total).toBeGreaterThan(0);
    });

    it.each(SEEDS)(
      'stays green with the same executed count under --randomize --seed %d',
      seed => {
        const shuffled = runJest(suite, seed);
        expect({
          status: shuffled.status,
          failed: shuffled.failed,
          total: shuffled.total,
          failedTests: shuffled.failedTests,
        }).toEqual({
          status: 0,
          failed: 0,
          total: declared.total,
          failedTests: [],
        });
      },
    );
  });
});
