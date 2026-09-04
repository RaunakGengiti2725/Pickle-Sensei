/**
 * ADVERSARIAL PASS 3 — mobile-ios-config — S5 (Linux-verifiable half)
 *
 * The assigned scenario (upload `git diff apps/mobile/ios/Podfile.lock` after
 * `pod install` on the Mac) belongs to the Mac owner agent; this role must not
 * trigger a Mac run. What CAN be proved from Linux is whether the committed
 * Podfile.lock is internally coherent with the committed Podfile, Gemfile.lock,
 * local pod and npm dependency tree — i.e. whether any drift is already
 * visible without CocoaPods. Everything else about the ` M Podfile.lock` line
 * in pod-install.log is UNKNOWN from this plane.
 */
export {};

// The mobile tsconfig has no Node types (matches flow-app-store-compliance-ios-config).
declare const require: (id: string) => unknown;
declare const __dirname: string;
type Fs = {
  readFileSync: (p: string, encoding: 'utf8') => string;
  readdirSync: (p: string) => string[];
  existsSync: (p: string) => boolean;
  statSync: (p: string) => {
    isDirectory(): boolean;
    isFile(): boolean;
    size: number;
  };
};
type Path = {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
};
const fs = require('fs') as Fs;
const path = require('path') as Path;
type Crypto = {
  createHash: (alg: string) => {
    update: (data: string) => { digest: (enc: 'hex') => string };
  };
};
const crypto = require('crypto') as Crypto;

const MOBILE = path.resolve(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(MOBILE, rel), 'utf8');

const podfile = read('ios/Podfile');
const lock = read('ios/Podfile.lock');
const gemfileLock = read('Gemfile.lock');
const pkg = JSON.parse(read('package.json')) as {
  dependencies: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function lockSection(name: string): string {
  const start = lock.indexOf(`${name}:`);
  if (start < 0) throw new Error(`Podfile.lock has no ${name} section`);
  const rest = lock.slice(start + name.length + 1);
  const end = rest.search(/\n[A-Z][A-Z ]+:\n/);
  return end < 0 ? rest : rest.slice(0, end);
}

function podVersionInLock(pod: string): string | null {
  const m = new RegExp(
    `^  - ${pod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(([^)]+)\\)`,
    'm',
  ).exec(lockSection('PODS'));
  return m?.[1] ?? null;
}

describe('S5 — Podfile.lock coherence (static, Linux)', () => {
  it('PODFILE CHECKSUM equals sha1(Podfile) — the Podfile itself has not drifted from the lock', () => {
    const recorded = /^PODFILE CHECKSUM: ([0-9a-f]{40})$/m.exec(lock)?.[1];
    expect(recorded).toBeDefined();
    expect(crypto.createHash('sha1').update(podfile).digest('hex')).toBe(
      recorded,
    );
  });

  it('lockfile CocoaPods version equals the Gemfile.lock pin used by pod-install.sh', () => {
    const lockVersion = /^COCOAPODS: (.+)$/m.exec(lock)?.[1];
    const gemVersion = /^ {4}cocoapods \(([^)]+)\)$/m.exec(gemfileLock)?.[1];
    expect(lockVersion).toBe('1.15.2');
    expect(gemVersion).toBe(lockVersion);
  });

  it('PickleNative is a :path pod rooted inside ios/ and its podspec exists with every declared source file', () => {
    expect(lockSection('EXTERNAL SOURCES')).toMatch(
      /PickleNative:\n {4}:path: LocalPods\/PickleNative/,
    );
    expect(podfile).toMatch(
      /pod 'PickleNative', :path => 'LocalPods\/PickleNative'/,
    );
    const podspecPath = path.join(
      MOBILE,
      'ios/LocalPods/PickleNative/PickleNative.podspec',
    );
    const podspec = fs.readFileSync(podspecPath, 'utf8');
    expect(podVersionInLock('PickleNative')).toBe(
      /s\.version\s*=\s*"([^"]+)"/.exec(podspec)?.[1],
    );
    const globs = Array.from(podspec.matchAll(/"Sources\/[^"]+"/g), m =>
      m[0].slice(1, -1),
    );
    expect(globs.length).toBeGreaterThan(1);
    for (const g of globs.filter(x => !x.includes('*'))) {
      const file = path.join(MOBILE, 'ios/LocalPods/PickleNative', g);
      // symlinks into native/vision-core must resolve — a dangling link is
      // exactly the sort of change that makes pod install rewrite the lock
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.statSync(file).isFile()).toBe(true);
    }
  });

  it('every npm native module autolinked into the Podfile.lock is still an npm dependency at the SAME version', () => {
    // React Native's autolinking writes `:path: "../node_modules/<pkg>"`.
    const external = lockSection('EXTERNAL SOURCES');
    const nodeModulePods = Array.from(
      external.matchAll(
        /^ {2}([^\n:]+):\n {4}:path: "\.\.\/node_modules\/((?:@[^/"]+\/)?[^/"]+)/gm,
      ),
      m => ({ pod: m[1] ?? '', npm: m[2] ?? '' }),
    ).filter(
      ({ npm }) => !npm.startsWith('react-native/') && npm !== 'react-native',
    );
    expect(nodeModulePods.length).toBeGreaterThan(3);
    const installed = new Set([
      ...Object.keys(pkg.dependencies),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);
    const mismatches: string[] = [];
    for (const { pod, npm } of nodeModulePods) {
      if (!installed.has(npm)) {
        mismatches.push(`${pod}: ${npm} not in package.json`);
        continue;
      }
      const pkgJsonPath = path.join(
        MOBILE,
        'node_modules',
        npm,
        'package.json',
      );
      if (!fs.existsSync(pkgJsonPath)) {
        mismatches.push(`${pod}: ${npm} not installed under node_modules`);
        continue;
      }
      const { version } = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as {
        version: string;
      };
      const locked = podVersionInLock(pod);
      if (locked !== null && locked !== version) {
        mismatches.push(`${pod}: lock ${locked} vs node_modules ${version}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('react-native version in Podfile.lock matches the installed react-native', () => {
    const rn = JSON.parse(read('node_modules/react-native/package.json')) as {
      version: string;
    };
    expect(podVersionInLock('React-Core')).toBe(rn.version);
    expect(podVersionInLock('React')).toBe(rn.version);
    expect(pkg.dependencies['react-native']).toBeDefined();
  });

  it('new architecture + hermes are the locked configuration (Podfile does not silently toggle them)', () => {
    expect(podfile).toMatch(/ENV\['RCT_NEW_ARCH_ENABLED'\]\s*=\s*'1'/);
    expect(podfile).not.toMatch(/hermes_enabled\s*=>\s*false/);
    expect(podVersionInLock('hermes-engine')).not.toBeNull();
    expect(podVersionInLock('React-Fabric')).not.toBeNull();
  });

  const podInstallScript = fs.readFileSync(
    path.resolve(MOBILE, '../../tools/macos-ci/pod-install.sh'),
    'utf8',
  );
  const macVerifyScript = fs.readFileSync(
    path.resolve(MOBILE, '../../scripts/mac-full-verify.sh'),
    'utf8',
  );

  it('pod-install.sh prints the lockfile git status after pod install (this is where the artifact\'s " M Podfile.lock" line comes from)', () => {
    expect(podInstallScript).toMatch(
      /pod install complete; Podfile\.lock status/,
    );
    expect(podInstallScript).toMatch(
      /git -C "\$IOS_DIR" status --short Podfile\.lock/,
    );
  });

  // KNOWN BROKEN on 4d812e1a: the Mac stage only PRINTS the lockfile status
  // (`git status --short Podfile.lock || true`) and never fails when pod
  // install rewrote Podfile.lock — so the committed lock is not proven to
  // reproduce the Mac build even though the stage reports ok. Marked `failing`
  // so this suite stays green until a `git diff --exit-code`-style assertion
  // (or an upload of the diff) is added; then delete this block.
  it.failing(
    'the Mac pipeline fails (or uploads the diff) when pod install modifies Podfile.lock (KNOWN BROKEN: status is printed and swallowed)',
    () => {
      const all = `${podInstallScript}\n${macVerifyScript}`;
      const asserts =
        /git[^\n]*diff[^\n]*--exit-code[^\n]*Podfile\.lock/.test(all) ||
        /git[^\n]*diff[^\n]*Podfile\.lock[^\n]*>\s*"?\$ARTIFACTS/.test(all) ||
        /Podfile\.lock[^\n]*(modified|drift|dirty)[^\n]*exit 1/.test(all);
      expect(asserts).toBe(true);
    },
  );
});
