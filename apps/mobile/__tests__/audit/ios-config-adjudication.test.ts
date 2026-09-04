/**
 * Adjudication pins — area `mobile-ios-config`, confirmed finding
 * IOSCFG-1: supabase-swift (declared minimum iOS 16) is linked into the
 * iOS 15.1 app while no Swift source compiled into the app imports any of
 * its products.
 *
 * Every test here fails at 4d812e1a by design and must pass once the fix
 * lands. Static, Linux-runnable; Apple-side effects (the eight
 * "built for newer iOS-simulator version (16.0) than being linked (15.1)"
 * ld warnings) are read from the same-SHA Mac artifact, not asserted here.
 */

export {};

// The mobile tsconfig ships no Node types (same pattern as the wf/ suites).
declare const require: (id: string) => unknown;
declare const __dirname: string;
interface DirEntry {
  name: string;
}
const fs = require('fs') as {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string, encoding: 'utf8') => string;
  readdirSync: (p: string, options: { withFileTypes: true }) => DirEntry[];
  statSync: (p: string) => { isDirectory(): boolean; isFile(): boolean };
};
const path = require('path') as {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
  basename: (p: string, ext?: string) => string;
};

const MOBILE_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(MOBILE_ROOT, '..', '..');
const IOS_ROOT = path.join(MOBILE_ROOT, 'ios');

const read = (abs: string): string => fs.readFileSync(abs, 'utf8');

const pbxproj = read(
  path.join(IOS_ROOT, 'PickleSensei.xcodeproj', 'project.pbxproj'),
);
const dossier = read(path.join(REPO_ROOT, 'docs', 'APP_STORE_SUBMISSION.md'));
const PACKAGE_RESOLVED = path.join(
  IOS_ROOT,
  'PickleSensei.xcworkspace',
  'xcshareddata',
  'swiftpm',
  'Package.resolved',
);

function pbxSection(name: string): string {
  const match = new RegExp(
    `/\\* Begin ${name} section \\*/([\\s\\S]*?)/\\* End ${name} section \\*/`,
  ).exec(pbxproj);
  return match ? match[1]! : '';
}

function walkSwift(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    // statSync follows the LocalPods/PickleNative/Sources/Core → native/
    // symlinks exactly as CocoaPods does when it compiles the pod.
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walkSwift(full, out);
    else if (stat.isFile() && entry.name.endsWith('.swift')) out.push(full);
  }
  return out;
}

/** Module names imported by a Swift source (`import X`, `import class X.Y`,
 * `@testable import X`, `@_exported import X`). */
function swiftImports(source: string): string[] {
  return Array.from(
    source.matchAll(
      /^\s*(?:@\w+\s+)*import\s+(?:(?:class|struct|enum|protocol|func|var|let|typealias)\s+)?(\w+)/gm,
    ),
    m => m[1]!,
  );
}

const importedModules = new Set(
  [
    ...walkSwift(path.join(IOS_ROOT, 'PickleSensei')),
    ...walkSwift(path.join(IOS_ROOT, 'LocalPods', 'PickleNative', 'Sources')),
  ].flatMap(file => swiftImports(read(file))),
);

const spmProducts = Array.from(
  pbxSection('XCSwiftPackageProductDependency').matchAll(
    /productName = (\w+);/g,
  ),
  m => m[1]!,
);
const spmPackageUrls = Array.from(
  pbxSection('XCRemoteSwiftPackageReference').matchAll(
    /repositoryURL = "([^"]+)";/g,
  ),
  m => m[1]!,
);
const repoName = (url: string): string =>
  path.basename(url.replace(/\.git$/, '')).toLowerCase();

describe('IOSCFG-1: SwiftPM dependencies of the PickleSensei app target', () => {
  it('links no SwiftPM product that no compiled Swift source imports', () => {
    const unused = spmProducts.filter(p => !importedModules.has(p));
    expect(unused).toEqual([]);
  });

  it('declares no remote SwiftPM package whose minimum iOS exceeds the 15.1 deployment target', () => {
    // supabase-swift's Package.swift declares `.iOS(.v16)` (2.55.1);
    // the app ships IPHONEOS_DEPLOYMENT_TARGET 15.1 (dossier: iOS 15.1+).
    expect(pbxproj).toMatch(/IPHONEOS_DEPLOYMENT_TARGET = 15\.1;/);
    expect(spmPackageUrls.map(repoName)).not.toContain('supabase-swift');
  });

  it('keeps Package.resolved coherent with the packages the project references', () => {
    if (!fs.existsSync(PACKAGE_RESOLVED)) {
      expect(spmPackageUrls).toEqual([]);
      return;
    }
    const resolved = JSON.parse(read(PACKAGE_RESOLVED)) as {
      pins: Array<{ identity: string; location: string }>;
    };
    const pinned = resolved.pins.map(p => p.identity.toLowerCase());
    if (spmPackageUrls.length === 0) {
      // No remote packages → a stale lock would still make xcodebuild resolve
      // and fetch them on every build.
      expect(pinned).toEqual([]);
      return;
    }
    for (const url of spmPackageUrls) {
      expect(pinned).toContain(repoName(url));
    }
    expect(pinned).not.toContain('supabase-swift');
  });

  it('lists every remote SwiftPM package in the dossier "Third-party SDKs in binary" row', () => {
    const row = /\| Third-party SDKs in binary\s*\|([^|]*)\|/.exec(dossier);
    expect(row).not.toBeNull();
    const inventory = row![1]!.toLowerCase();
    const undeclared = spmPackageUrls
      .map(repoName)
      .filter(repo => !inventory.includes(repo));
    expect(undeclared).toEqual([]);
  });
});
