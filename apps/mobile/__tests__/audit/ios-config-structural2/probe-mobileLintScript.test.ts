/**
 * AUDIT PROBE (mobile-ios-config / auditor #2).
 *
 * Suspected defect: `apps/mobile/package.json` still ships `"lint": "eslint ."`
 * and `apps/mobile/.eslintrc.js` (ESLint 8 legacy config), but the workspace
 * root now uses ESLint 9 flat config and root `eslint .` is the lint
 * authority (AGENTS.md). Invoking the mobile-local script picks the ESLint 8
 * binary in apps/mobile/node_modules, which loads the root flat config and
 * crashes while loading `@typescript-eslint/no-unused-expressions`. A script
 * that a package advertises must at least run.
 *
 * The probe lints a single file with the mobile-local binary and asserts the
 * process does not crash (exit 0 or 1 = lint ran; 2 = ESLint crashed).
 */
// Module scope (no imports otherwise) so the declarations below stay local.
export {};

// Node built-ins typed by hand: the RN tsconfig ships no node types.
declare const require: (id: string) => unknown;
declare const __dirname: string;
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
    options: { cwd: string; encoding: 'utf8'; timeout: number },
  ) => SpawnResult;
};
const path = require('path') as {
  resolve: (...parts: string[]) => string;
};

const mobileDir = path.resolve(__dirname, '../../..');

describe('audit probe: apps/mobile `npm run lint` is runnable', () => {
  const run = spawnSync('npx', ['--no-install', 'eslint', 'App.tsx'], {
    cwd: mobileDir,
    encoding: 'utf8',
    timeout: 180_000,
  });

  test('the mobile-local eslint binary does not crash on the repo config', () => {
    expect(run.error).toBeUndefined();
    expect(run.stderr).not.toMatch(/TypeError|Error while loading rule/);
    expect([0, 1]).toContain(run.status);
  });
});
