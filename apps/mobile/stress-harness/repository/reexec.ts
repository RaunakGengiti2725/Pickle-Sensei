/**
 * `node:sqlite` is behind `--experimental-sqlite` on Node 22.5–22.12. When the
 * flag is missing, a stress suite re-executes ITSELF under jest with the flag
 * set, so a plain `npx jest` still runs (never skips) the campaign, and the
 * child's exit status + tail becomes the parent's single assertion.
 */
import {
  childProcess,
  nodeProcess,
  path,
  resolveModule,
} from '../../xc-harness/lifecycle-persistence/nodeShim';
import { sqlite } from './realSqlite';

export const STRESS_CHILD_ENV = 'STRESS_SQLITE_CHILD';

export function describeUnderSqlite(
  testFile: string,
  title: string,
  body: () => void,
): void {
  if (sqlite !== null) {
    describe(title, body);
    return;
  }
  describe(`${title} (re-exec under --experimental-sqlite)`, () => {
    it(
      'runs the whole file under node --experimental-sqlite',
      () => {
        if (nodeProcess.env[STRESS_CHILD_ENV] === '1') {
          throw new Error(
            'node:sqlite is unavailable even with --experimental-sqlite; Node >= 22.5 is required for this suite',
          );
        }
        const jestBin = resolveModule('jest/bin/jest');
        const result = childProcess.spawnSync(
          nodeProcess.execPath,
          [
            jestBin,
            '--ci',
            '--runInBand',
            '--silent',
            '--runTestsByPath',
            testFile,
          ],
          {
            cwd: path.resolve(__dirname, '../..'),
            env: {
              ...nodeProcess.env,
              [STRESS_CHILD_ENV]: '1',
              NODE_OPTIONS:
                `${nodeProcess.env['NODE_OPTIONS'] ?? ''} --experimental-sqlite`.trim(),
            },
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
          },
        );
        const tail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.slice(
          -6000,
        );
        expect({ status: result.status, tail }).toEqual({ status: 0, tail });
      },
      15 * 60_000,
    );
  });
}

declare const __dirname: string;
