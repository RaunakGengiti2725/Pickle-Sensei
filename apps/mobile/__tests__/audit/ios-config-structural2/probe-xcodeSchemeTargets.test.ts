/**
 * AUDIT PROBE (mobile-ios-config, structural pass 1 / auditor #2).
 *
 * Suspected defect: the shared Xcode scheme's TestAction references a
 * `PickleSenseiTests` testable whose BlueprintIdentifier does not exist in
 * project.pbxproj (the RN template test target was removed but the scheme
 * still points at it). Every BuildableReference in the shared scheme must
 * resolve to a native target in the project.
 */
// Module scope (no imports otherwise) so the declarations below stay local.
export {};

// Node built-ins typed by hand: the RN tsconfig ships no node types.
declare const require: (id: string) => unknown;
declare const __dirname: string;
const fs = require('fs') as {
  readFileSync: (p: string, encoding: 'utf8') => string;
};
const path = require('path') as {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
};

const iosDir = path.resolve(__dirname, '../../../ios');
const scheme = fs.readFileSync(
  path.join(
    iosDir,
    'PickleSensei.xcodeproj/xcshareddata/xcschemes/PickleSensei.xcscheme',
  ),
  'utf8',
);
const pbxproj = fs.readFileSync(
  path.join(iosDir, 'PickleSensei.xcodeproj/project.pbxproj'),
  'utf8',
);

function buildableReferences(): Array<{ id: string; name: string }> {
  return [
    ...scheme.matchAll(
      /BlueprintIdentifier\s*=\s*"([^"]+)"[\s\S]*?BlueprintName\s*=\s*"([^"]+)"/g,
    ),
  ].map(m => ({ id: m[1] ?? '', name: m[2] ?? '' }));
}

describe('audit probe: shared scheme references only existing targets', () => {
  const refs = buildableReferences();

  test('precondition: the scheme declares buildable references', () => {
    expect(refs.length).toBeGreaterThan(0);
  });

  test.each(refs)(
    'scheme BuildableReference %p resolves to a PBXNativeTarget',
    ({ id, name }) => {
      expect(pbxproj).toContain(`${id} /* ${name} */`);
      expect(pbxproj).toMatch(
        new RegExp(`${id} /\\* ${name} \\*/ = \\{\\s*isa = PBXNativeTarget;`),
      );
    },
  );
});
