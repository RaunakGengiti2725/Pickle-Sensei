/**
 * H09-01 adversarial attack — can the retirement contract be evaded?
 *
 * The candidate's `__tests__/liveCourt.test.ts` promises to fail when a
 * retired module returns, when a mobile source imports
 * `@pickle/audio-coach-core`, or when a dormant engine module becomes
 * reachable from `index.js`/`App.tsx`. This suite runs THAT contract file,
 * byte for byte, against replica trees that Metro/Babel would bundle exactly
 * like the mutation describes, and asserts the contract goes red. Every
 * `it` whose nested run stays green is a confirmed evasion.
 */

import { execFileSync } from 'child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

const MOBILE_ROOT = join(__dirname, '..', '..');
const CONTRACT = join(MOBILE_ROOT, '__tests__', 'liveCourt.test.ts');
const DORMANT = [
  'src/flow/session.ts',
  'src/flow/sessionNative.ts',
  'src/flow/sessionProgress.ts',
  'src/flow/liveSessionSummary.ts',
  'src/progress/gameplayProgression.ts',
];

type Replica = { root: string; write: (rel: string, body: string) => void };

function buildReplica(): Replica {
  const root = mkdtempSync(join(tmpdir(), 'h09-attack-'));
  const write = (rel: string, body: string) => {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  };
  mkdirSync(join(root, '__tests__'), { recursive: true });
  copyFileSync(CONTRACT, join(root, '__tests__', 'liveCourt.test.ts'));
  write('index.js', "import './App';\n");
  write('App.tsx', "import './src/navigation/RootNavigator';\nexport {};\n");
  write('src/navigation/RootNavigator.tsx', 'export {};\n');
  for (const module of DORMANT) write(module, 'export {};\n');
  for (let i = 0; i < 110; i += 1) write(`src/filler/f${i}.ts`, 'export {};\n');
  return { root, write };
}

/** Runs the candidate contract inside the replica; returns the jest exit code. */
function runContract(root: string): { code: number; output: string } {
  const config = JSON.stringify({
    rootDir: root,
    testEnvironment: 'node',
    testMatch: ['**/__tests__/liveCourt.test.ts'],
    transform: {
      '\\.[jt]sx?$': [
        require.resolve('babel-jest'),
        {
          babelrc: false,
          configFile: false,
          presets: [require.resolve('@react-native/babel-preset')],
        },
      ],
    },
  });
  try {
    const output = execFileSync(
      process.execPath,
      [require.resolve('jest/bin/jest'), '--ci', '--config', config],
      { cwd: MOBILE_ROOT, encoding: 'utf8', stdio: 'pipe' },
    );
    return { code: 0, output };
  } catch (error) {
    const failure = error as { status: number | null; stderr?: string };
    return { code: failure.status ?? -1, output: failure.stderr ?? '' };
  }
}

describe('H09-01 attack: retirement contract evasion', () => {
  const replicas: string[] = [];
  const replica = (): Replica => {
    const r = buildReplica();
    replicas.push(r.root);
    return r;
  };
  afterAll(() => {
    for (const root of replicas) rmSync(root, { recursive: true, force: true });
  });

  it('baseline: the unmodified replica satisfies the candidate contract', () => {
    const { code, output } = runContract(replica().root);
    expect({ code, output }).toEqual({ code: 0, output: expect.any(String) });
  });

  it('retired LiveCourtEngine returning as a directory module (src/flow/liveCourt/index.ts) is caught', () => {
    const r = replica();
    r.write('src/flow/liveCourt/index.ts', 'export class LiveCourtEngine {}\n');
    expect(runContract(r.root).code).not.toBe(0);
  });

  it('retired voice adapter returning as a platform file (liveSessionCoach.ios.ts) is caught', () => {
    const r = replica();
    r.write(
      'src/flow/liveSessionCoach.ios.ts',
      'export class LiveSessionCoach {}\n',
    );
    expect(runContract(r.root).code).not.toBe(0);
  });

  it('a mobile source importing the cue engine through a subpath is caught', () => {
    const r = replica();
    r.write(
      'src/flow/cuePolicy.ts',
      "import { LiveSessionCuePolicy } from '@pickle/audio-coach-core/src/liveSession';\nexport { LiveSessionCuePolicy };\n",
    );
    expect(runContract(r.root).code).not.toBe(0);
  });

  it('mounting the dormant engine behind an apostrophe in a trailing comment is caught', () => {
    const r = replica();
    r.write(
      'App.tsx',
      "import './src/navigation/RootNavigator';\nimport { LiveSessionFlow } from './src/flow/session'; // the coach's engine\nexport { LiveSessionFlow };\n",
    );
    expect(runContract(r.root).code).not.toBe(0);
  });

  it('mounting the dormant engine via a template-literal dynamic import is caught', () => {
    const r = replica();
    r.write(
      'App.tsx',
      "import './src/navigation/RootNavigator';\nexport const load = () => import(`./src/flow/session`);\n",
    );
    expect(runContract(r.root).code).not.toBe(0);
  });

  it('mounting the dormant engine through a platform-specific screen (Foo.ios.tsx) is caught', () => {
    const r = replica();
    r.write(
      'App.tsx',
      "import './src/navigation/RootNavigator';\nimport './src/screens/LiveCourtScreen';\nexport {};\n",
    );
    r.write(
      'src/screens/LiveCourtScreen.ios.tsx',
      "import { LiveSessionFlow } from '../flow/session';\nexport { LiveSessionFlow };\n",
    );
    expect(runContract(r.root).code).not.toBe(0);
  });

  it('a Metro-valid import with no whitespace before the specifier is caught', () => {
    const r = replica();
    r.write(
      'App.tsx',
      "import './src/navigation/RootNavigator';\nimport {LiveSessionFlow}from'./src/flow/session';\nexport { LiveSessionFlow };\n",
    );
    expect(runContract(r.root).code).not.toBe(0);
  });

  it('sanity: a plain relative import of the dormant engine IS caught', () => {
    const r = replica();
    r.write(
      'App.tsx',
      "import './src/navigation/RootNavigator';\nimport { LiveSessionFlow } from './src/flow/session';\nexport { LiveSessionFlow };\n",
    );
    expect(runContract(r.root).code).not.toBe(0);
  });
});
