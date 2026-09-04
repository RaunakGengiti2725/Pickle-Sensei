/**
 * ADVERSARIAL PASS 3 — mobile-ios-config — S7 (structural pin)
 *
 * The existing compliance guard asserts only that the STRING
 * "PrivacyInfo.xcprivacy in Resources" appears somewhere in project.pbxproj.
 * That string also lives in the PBXBuildFile comment, so deleting the entry
 * from the PBXResourcesBuildPhase `files` list (the manifest is then on disk
 * but never copied into the .app) passes the guard — see
 * scripts/attack/ios-config-3/mutation-harness.mjs
 * (`s7-privacy-manifest-out-of-resources-phase`, `s7-privacy-manifest-renamed-in-phase`).
 *
 * This file pins the real chain: file reference → PBXBuildFile → entry inside
 * the app target's PBXResourcesBuildPhase `files` list.
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
const pbxproj = fs.readFileSync(
  path.join(IOS, 'PickleSensei.xcodeproj/project.pbxproj'),
  'utf8',
);

function sectionBody(name: string): string {
  const start = pbxproj.indexOf(`/* Begin ${name} section */`);
  const end = pbxproj.indexOf(`/* End ${name} section */`);
  if (start < 0 || end < 0) throw new Error(`no ${name} section`);
  return pbxproj.slice(start, end);
}

function fileReferenceIdFor(fileName: string): string {
  const refs = Array.from(
    sectionBody('PBXFileReference').matchAll(
      /^\t\t([0-9A-F]{24}) \/\* ([^*]+) \*\/ = \{isa = PBXFileReference;([^\n]*)\};$/gm,
    ),
  ).filter(m =>
    new RegExp(`path = "?(?:[^";]*/)?${fileName.replace('.', '\\.')}"?;`).test(
      m[3] ?? '',
    ),
  );
  const ids = refs.map(m => m[1] ?? '');
  expect(ids).toHaveLength(1);
  return ids[0] ?? '';
}

function buildFileIdsFor(fileRefId: string): string[] {
  return Array.from(
    sectionBody('PBXBuildFile').matchAll(
      new RegExp(
        `^\\t\\t([0-9A-F]{24}) /\\* [^*]+ \\*/ = \\{isa = PBXBuildFile; fileRef = ${fileRefId} /\\*`,
        'gm',
      ),
    ),
    m => m[1] ?? '',
  );
}

function resourcesPhaseFilesOf(targetName: string): string[] {
  const target = sectionBody('PBXNativeTarget');
  const t = new RegExp(
    `\\t\\t([0-9A-F]{24}) /\\* ${targetName} \\*/ = \\{[\\s\\S]*?buildPhases = \\(([\\s\\S]*?)\\);`,
  ).exec(target);
  if (!t) throw new Error(`target ${targetName} not found`);
  const phaseIds = Array.from(
    (t[2] ?? '').matchAll(/([0-9A-F]{24}) \/\* ([^*]+) \*\//g),
    m => ({
      id: m[1] ?? '',
      name: (m[2] ?? '').trim(),
    }),
  );
  const resources = phaseIds.filter(p => p.name === 'Resources');
  expect(resources).toHaveLength(1);
  const resourcesPhaseId = resources[0]?.id ?? '';
  const phases = sectionBody('PBXResourcesBuildPhase');
  const phase = new RegExp(
    `\\t\\t${resourcesPhaseId} /\\* Resources \\*/ = \\{[\\s\\S]*?files = \\(([\\s\\S]*?)\\);`,
  ).exec(phases);
  if (!phase) throw new Error('Resources phase body not found');
  return Array.from(
    (phase[1] ?? '').matchAll(/([0-9A-F]{24}) \/\*/g),
    m => m[1] ?? '',
  );
}

describe('S7 — PrivacyInfo.xcprivacy is structurally bundled into the app target', () => {
  const manifestRef = fileReferenceIdFor('PrivacyInfo.xcprivacy');
  const buildFiles = buildFileIdsFor(manifestRef);
  const resourceFiles = resourcesPhaseFilesOf('PickleSensei');

  it('the manifest file reference exists once and points at PickleSensei/PrivacyInfo.xcprivacy on disk', () => {
    expect(manifestRef).toMatch(/^[0-9A-F]{24}$/);
    expect(
      fs.existsSync(path.join(IOS, 'PickleSensei/PrivacyInfo.xcprivacy')),
    ).toBe(true);
  });

  it('exactly one PBXBuildFile wraps the manifest', () => {
    expect(buildFiles).toHaveLength(1);
  });

  it('that PBXBuildFile is listed in the app target Resources build phase (not just mentioned in a comment)', () => {
    expect(resourceFiles).toContain(buildFiles[0]);
  });

  it('the Resources phase does not also drag in Info.plist (not a bundle resource) and the entitlements are wired only through CODE_SIGN_ENTITLEMENTS', () => {
    const infoRef = fileReferenceIdFor('Info.plist');
    for (const bf of buildFileIdsFor(infoRef)) {
      expect(resourceFiles).not.toContain(bf);
    }
    expect(sectionBody('PBXFileReference')).not.toMatch(
      /PickleSensei\.entitlements/,
    );
    expect(sectionBody('PBXBuildFile')).not.toMatch(/entitlements/);
    expect(
      pbxproj.match(
        /CODE_SIGN_ENTITLEMENTS = PickleSensei\/PickleSensei\.entitlements;/g,
      ),
    ).toHaveLength(2);
    expect(
      fs.existsSync(path.join(IOS, 'PickleSensei/PickleSensei.entitlements')),
    ).toBe(true);
  });

  it('every Resources phase entry has a PBXBuildFile whose fileRef resolves to a PBXFileReference', () => {
    const buildFileSection = sectionBody('PBXBuildFile');
    const fileRefSection = sectionBody('PBXFileReference');
    for (const id of resourceFiles) {
      const m = new RegExp(
        `^\\t\\t${id} /\\* [^*]+ \\*/ = \\{isa = PBXBuildFile; fileRef = ([0-9A-F]{24}) /\\*`,
        'm',
      ).exec(buildFileSection);
      expect(m).not.toBeNull();
      expect(fileRefSection).toMatch(new RegExp(`^\\t\\t${m?.[1]} /\\*`, 'm'));
    }
  });

  it('LaunchScreen, asset catalog and the Manrope fonts ride in the same Resources phase (bundling wiring is complete)', () => {
    const names = Array.from(
      sectionBody('PBXBuildFile').matchAll(
        /^\t\t([0-9A-F]{24}) \/\* ([^*]+) in Resources \*\//gm,
      ),
    )
      .filter(m => resourceFiles.includes(m[1] ?? ''))
      .map(m => (m[2] ?? '').trim());
    expect(names).toEqual(
      expect.arrayContaining([
        'PrivacyInfo.xcprivacy',
        'LaunchScreen.storyboard',
        'Images.xcassets',
        'Manrope_400Regular.ttf',
      ]),
    );
  });
});
