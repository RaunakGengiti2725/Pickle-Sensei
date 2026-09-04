/**
 * ADVERSARIAL PASS 3 — mobile-ios-config — S4 (Linux-verifiable half)
 *
 * The assigned scenario asks for `xcodebuild -list -project …` and
 * `xcodebuild test -scheme PickleSensei` on the Mac. This role may NOT
 * trigger a Mac run, so this file pins only what can be proved from the
 * checked-in project files: every buildable the shared scheme references
 * must resolve to a real target in project.pbxproj.
 *
 * Apple-side outcome (what xcodebuild actually prints for a scheme whose
 * TestAction points at a missing target) is NOT claimed here — see the
 * evidence note shipped beside this test for what the existing Mac artifact
 * (run 33841813597) does and does not show.
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

const IOS = path.resolve(__dirname, '../../../ios');
const read = (rel: string) => fs.readFileSync(path.join(IOS, rel), 'utf8');

const pbxproj = read('PickleSensei.xcodeproj/project.pbxproj');
const scheme = read(
  'PickleSensei.xcodeproj/xcshareddata/xcschemes/PickleSensei.xcscheme',
);

interface BuildableRef {
  blueprintIdentifier: string;
  buildableName: string;
  blueprintName: string;
}

function buildableRefs(section: string): BuildableRef[] {
  return Array.from(
    section.matchAll(
      /<BuildableReference[\s\S]*?BlueprintIdentifier = "([^"]+)"[\s\S]*?BuildableName = "([^"]+)"[\s\S]*?BlueprintName = "([^"]+)"[\s\S]*?>/g,
    ),
    m => ({
      blueprintIdentifier: m[1] ?? '',
      buildableName: m[2] ?? '',
      blueprintName: m[3] ?? '',
    }),
  );
}

function nativeTargets(): Map<string, string> {
  const targets = new Map<string, string>();
  const section = pbxproj.slice(
    pbxproj.indexOf('/* Begin PBXNativeTarget section */'),
    pbxproj.indexOf('/* End PBXNativeTarget section */'),
  );
  for (const m of section.matchAll(
    /^\t\t([0-9A-F]{24}) \/\* ([^*]+) \*\/ = \{\s*isa = PBXNativeTarget;/gm,
  )) {
    targets.set(m[1] ?? '', (m[2] ?? '').trim());
  }
  return targets;
}

function section(tag: string): string {
  const start = scheme.indexOf(`<${tag}`);
  const end = scheme.indexOf(`</${tag}>`, start);
  if (start < 0 || end < 0) throw new Error(`scheme has no <${tag}>`);
  return scheme.slice(start, end);
}

describe('S4 — shared scheme vs project targets (static, Linux)', () => {
  const targets = nativeTargets();

  it('the project has exactly one native target, the app', () => {
    expect(Array.from(targets.values())).toEqual(['PickleSensei']);
    expect(pbxproj).not.toMatch(/PickleSenseiTests/);
    expect(pbxproj).not.toMatch(/xctest/i);
  });

  it('BuildAction and LaunchAction buildables resolve to real targets', () => {
    for (const tag of ['BuildAction', 'LaunchAction', 'ProfileAction']) {
      const refs = buildableRefs(section(tag));
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) {
        expect(targets.get(ref.blueprintIdentifier)).toBe(ref.blueprintName);
        expect(ref.buildableName).toBe('PickleSensei.app');
      }
    }
  });

  it('TestAction references a test bundle by name and blueprint id', () => {
    const refs = buildableRefs(section('TestAction'));
    expect(refs).toEqual([
      {
        blueprintIdentifier: '00E356ED1AD99517003FC87E',
        buildableName: 'PickleSenseiTests.xctest',
        blueprintName: 'PickleSenseiTests',
      },
    ]);
  });

  // KNOWN BROKEN on 4d812e1a and on origin/main: the shared scheme's
  // TestAction points at blueprint 00E356ED1AD99517003FC87E
  // ("PickleSenseiTests") which does not exist in project.pbxproj. Marked
  // `failing` so the suite is green while the defect is open and turns RED the
  // moment someone either adds the target or drops the TestAction — at which
  // point delete this block and un-`failing` nothing (the passing checks above
  // already pin the healthy state).
  it.failing(
    'every TestAction buildable resolves to a PBXNativeTarget (KNOWN BROKEN: dangling PickleSenseiTests)',
    () => {
      for (const ref of buildableRefs(section('TestAction'))) {
        expect(targets.has(ref.blueprintIdentifier)).toBe(true);
      }
    },
  );

  it('no other scheme file in the project references a test target either', () => {
    const dir = path.join(IOS, 'PickleSensei.xcodeproj/xcshareddata/xcschemes');
    const files = fs.readdirSync(dir);
    expect(files).toEqual(['PickleSensei.xcscheme']);
  });

  it('the Mac verification script never runs `xcodebuild test` against the app scheme (so the dangling target is not exercised by CI)', () => {
    const script = fs.readFileSync(
      path.resolve(__dirname, '../../../../../scripts/mac-full-verify.sh'),
      'utf8',
    );
    const ciScripts = fs
      .readdirSync(path.resolve(__dirname, '../../../../../tools/macos-ci'))
      .map(f =>
        fs.readFileSync(
          path.resolve(__dirname, '../../../../../tools/macos-ci', f),
          'utf8',
        ),
      )
      .join('\n');
    const all = `${script}\n${ciScripts}`;
    const appSchemeTests = Array.from(
      all.matchAll(/xcodebuild[^\n]*\btest\b[^\n]*-scheme\s+PickleSensei\b/g),
    );
    expect(appSchemeTests).toEqual([]);
  });
});
