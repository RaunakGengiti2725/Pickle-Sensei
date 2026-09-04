/**
 * ADVERSARIAL PASS 3 — mobile-ios-config — extra static scenario
 *
 * The Xcode project declares ONE remote SwiftPM dependency (supabase-swift,
 * upToNextMajor from 2.5.1) and the WORKSPACE carries the resolved pin set at
 * `PickleSensei.xcworkspace/xcshareddata/swiftpm/Package.resolved`. Nothing
 * pins those versions at the PROJECT level, so `xcodebuild -list -project`
 * (project-only resolution) is free to float transitive versions — the Mac
 * baseline artifact (run 33841813597) shows exactly that: the project-only
 * list resolved swift-asn1 1.7.2 / swift-crypto 4.5.2 / swift-http-types 1.7.0
 * while the workspace build used the committed pins 1.7.1 / 4.5.1 / 1.6.0.
 * The shipping build goes through the workspace, so what must hold from Linux
 * is: the resolved file is well-formed, every pin has a revision, the pinned
 * supabase-swift version satisfies the pbxproj requirement, and the transitive
 * closure is the one supabase-swift actually needs (no orphan/duplicate pins).
 * Apple-side resolution itself is NOT claimed from this plane.
 */
export {};

// The mobile tsconfig has no Node types (matches flow-app-store-compliance-ios-config).
declare const require: (id: string) => unknown;
declare const __dirname: string;
type Fs = {
  readFileSync: (p: string, encoding: 'utf8') => string;
  existsSync: (p: string) => boolean;
};
type Path = {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
};
const fs = require('fs') as Fs;
const path = require('path') as Path;

const IOS = path.resolve(__dirname, '../../../ios');
const RESOLVED = path.join(
  IOS,
  'PickleSensei.xcworkspace/xcshareddata/swiftpm/Package.resolved',
);
const PBXPROJ = path.join(IOS, 'PickleSensei.xcodeproj/project.pbxproj');

type Pin = {
  identity: string;
  kind: string;
  location: string;
  state: { revision?: string; version?: string; branch?: string };
};
type Resolved = { originHash?: string; version?: number; pins: Pin[] };

function parseVersion(v: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new Error(`not a semver triple: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function readResolved(): Resolved {
  return JSON.parse(fs.readFileSync(RESOLVED, 'utf8')) as Resolved;
}

describe('attack/ios-config-3 extra: SwiftPM Package.resolved coherence (static)', () => {
  it('the workspace ships a committed Package.resolved and the project has exactly one remote package reference', () => {
    expect(fs.existsSync(RESOLVED)).toBe(true);
    const pbxproj = fs.readFileSync(PBXPROJ, 'utf8');
    const refs = Array.from(
      pbxproj.matchAll(/isa = XCRemoteSwiftPackageReference;/g),
    );
    expect(refs).toHaveLength(1);
    expect(pbxproj).toMatch(
      /repositoryURL = "https:\/\/github\.com\/supabase\/supabase-swift";/,
    );
    // No PROJECT-level resolved file exists, so `-project` resolution floats.
    expect(
      fs.existsSync(
        path.join(
          IOS,
          'PickleSensei.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved',
        ),
      ),
    ).toBe(false);
  });

  it('every pin is a remoteSourceControl pin with a 40-hex revision AND an exact version (no branch/floating pins)', () => {
    const resolved = readResolved();
    expect(resolved.pins.length).toBeGreaterThan(0);
    const identities = resolved.pins.map(p => p.identity);
    expect(new Set(identities).size).toBe(identities.length);
    for (const pin of resolved.pins) {
      expect(pin.kind).toBe('remoteSourceControl');
      expect(pin.location).toMatch(/^https:\/\/github\.com\//);
      expect(pin.state.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(pin.state.branch).toBeUndefined();
      expect(() => parseVersion(pin.state.version ?? '')).not.toThrow();
    }
  });

  it('the pinned supabase-swift version satisfies the pbxproj upToNextMajor requirement', () => {
    const pbxproj = fs.readFileSync(PBXPROJ, 'utf8');
    const req =
      /requirement = \{\s*kind = upToNextMajorVersion;\s*minimumVersion = ([0-9.]+);\s*\};/.exec(
        pbxproj,
      );
    expect(req).not.toBeNull();
    const [minMajor, minMinor, minPatch] = parseVersion(req?.[1] ?? '');
    const supabase = readResolved().pins.find(
      p => p.identity === 'supabase-swift',
    );
    expect(supabase).toBeDefined();
    const [major, minor, patch] = parseVersion(supabase?.state.version ?? '');
    expect(major).toBe(minMajor);
    const atLeastMin =
      minor > minMinor || (minor === minMinor && patch >= minPatch);
    expect(atLeastMin).toBe(true);
  });

  it('the pin set is exactly the supabase-swift transitive closure (no orphan or missing transitive pins)', () => {
    const identities = readResolved()
      .pins.map(p => p.identity)
      .sort();
    expect(identities).toEqual(
      [
        'supabase-swift',
        'swift-asn1',
        'swift-clocks',
        'swift-concurrency-extras',
        'swift-crypto',
        'swift-http-types',
        'xctest-dynamic-overlay',
      ].sort(),
    );
  });

  it('the product dependencies wired into the app target all come from the single supabase-swift reference', () => {
    const pbxproj = fs.readFileSync(PBXPROJ, 'utf8');
    const products = Array.from(
      pbxproj.matchAll(
        /isa = XCSwiftPackageProductDependency;\s*package = ([0-9A-F]{24}) \/\* XCRemoteSwiftPackageReference "([^"]+)" \*\/;\s*productName = ([A-Za-z]+);/g,
      ),
    );
    expect(products.length).toBeGreaterThan(0);
    const refIds = new Set(products.map(m => m[1]));
    expect(refIds.size).toBe(1);
    for (const m of products) expect(m[2]).toBe('supabase-swift');
    expect(products.map(m => m[3]).sort()).toEqual(
      [
        'Auth',
        'Functions',
        'PostgREST',
        'Realtime',
        'Storage',
        'Supabase',
      ].sort(),
    );
  });
});
