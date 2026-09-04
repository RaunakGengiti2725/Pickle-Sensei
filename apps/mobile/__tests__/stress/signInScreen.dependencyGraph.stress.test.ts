/**
 * STRESS — scr-signinscreen / failure-injection: dependency reachability.
 *
 * The failure-injection lens names ten dependency families (fetch/api,
 * SQLite, Keychain, camera, Vision provider, TTS, RevenueCat, permissions,
 * clock, navigation). This test walks the STATIC import graph rooted at
 * SignInScreen.tsx and pins which of those the screen can actually reach, so
 * the injected-fault campaign is honest about what it exercised: Vision and
 * TTS are NOT reachable from this screen (`src/vision/*`, `src/audio/tts.ts`
 * never appear in the graph), the camera seam `src/camera/capture.ts` IS
 * reached — only for its `assertCapturedClip` validator via
 * `data/repository.ts`, but that module reads `NativeModules.PickleVideoCapture`
 * at import time, so a camera native-module fault is a MODULE-LOAD fault for
 * the sign-in screen (exercised by signInScreen.moduleLoadFaults.stress) —
 * and the sign-in flow reaches fetch, SQLite, Keychain, the provider SDKs and
 * (lazily, after bootstrap) the RevenueCat client.
 */
import { writeStressJson } from '../../__harness__/stressSignIn/artifacts';

declare const __dirname: string;
declare const require: (id: string) => unknown;

interface GraphFs {
  existsSync(target: string): boolean;
  statSync(target: string): { isFile(): boolean };
  readFileSync(file: string, encoding: 'utf8'): string;
}
interface GraphPath {
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
  dirname(target: string): string;
  relative(from: string, to: string): string;
}
const fs = require('node:fs') as GraphFs;
const path = require('node:path') as GraphPath;

const SRC = path.resolve(__dirname, '../../src');
const ROOT = path.join(SRC, 'screens/SignInScreen.tsx');
const EXTENSIONS = ['.ts', '.tsx', '.ios.ts', '.ios.tsx', '.js'];

const IMPORT_PATTERN =
  /(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function resolveLocal(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    ...EXTENSIONS.map(ext => base + ext),
    ...EXTENSIONS.map(ext => path.join(base, 'index' + ext)),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function walk(root: string): { files: string[]; packages: string[] } {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const queue = [root];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (!specifier) continue;
      if (specifier.startsWith('.')) {
        const resolved = resolveLocal(file, specifier);
        if (resolved) queue.push(resolved);
      } else {
        packages.add(specifier);
      }
    }
  }
  return {
    files: [...seen].map(f => path.relative(SRC, f)).sort(),
    packages: [...packages].sort(),
  };
}

describe('STRESS scr-signinscreen — dependency graph', () => {
  const graph = walk(ROOT);

  afterAll(() => {
    writeStressJson('signin-dependency-graph.json', {
      root: 'src/screens/SignInScreen.tsx',
      reachableSourceFiles: graph.files,
      reachablePackages: graph.packages,
      lens: {
        'fetch/api': graph.files.includes('account/bootstrap.ts'),
        sqlite: graph.files.includes('data/db.ts'),
        keychain: graph.files.includes('account/sessionVault.ts'),
        camera: graph.files.includes('camera/capture.ts'),
        vision: graph.files.some(f => f.startsWith('vision/')),
        tts: graph.files.includes('audio/tts.ts'),
        revenuecat: graph.packages.includes('react-native-purchases'),
        permissions: graph.files.includes('notifications/service.ts'),
        navigation: graph.packages.some(p =>
          p.startsWith('@react-navigation/'),
        ),
      },
    });
  });

  test('reaches fetch/api, SQLite, Keychain, the provider SDKs and RevenueCat', () => {
    expect(graph.files).toEqual(
      expect.arrayContaining([
        'auth/authStore.ts',
        'account/bootstrap.ts',
        'account/sessionVault.ts',
        'data/db.ts',
        'billing/revenueCatClient.ts',
      ]),
    );
    expect(graph.packages).toEqual(
      expect.arrayContaining([
        'react-native-keychain',
        '@react-native-google-signin/google-signin',
        'react-native-purchases',
      ]),
    );
  });

  test('reaches the camera seam only at module load (validator import)', () => {
    expect(graph.files).toContain('camera/capture.ts');
    const repository = fs.readFileSync(
      path.join(SRC, 'data/repository.ts'),
      'utf8',
    );
    expect(repository).toMatch(
      /import \{ assertCapturedClip, type CapturedClip \} from '\.\.\/camera\/capture'/,
    );
    const capture = fs.readFileSync(
      path.join(SRC, 'camera/capture.ts'),
      'utf8',
    );
    expect(capture).toMatch(/^const native = \(NativeModules as/m);
  });

  test('does NOT reach Vision or TTS seams', () => {
    expect(graph.files).not.toContain('audio/tts.ts');
    expect(graph.files.filter(f => f.startsWith('vision/'))).toEqual([]);
    expect(graph.packages).not.toContain('react-native-vision-camera');
  });

  test('does NOT own navigation or notification permissions (App/Gate do)', () => {
    expect(
      graph.packages.filter(p => p.startsWith('@react-navigation/')),
    ).toEqual([]);
    expect(graph.files).not.toContain('notifications/service.ts');
  });
});
