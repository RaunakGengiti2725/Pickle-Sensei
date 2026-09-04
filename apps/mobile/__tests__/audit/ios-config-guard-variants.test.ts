/**
 * Adversarial variants of the IOSCFG-3 mutations (adjudication of candidate
 * 20c0e0c1, area `mobile-ios-config`).
 *
 * The fixed gates (scripts/check-ios-distribution.mjs, tools/release/
 * check-release-manifest.mjs, __tests__/audit/ios-config-guards.test.ts)
 * resolve the app target's Debug and Release XCBuildConfiguration objects
 * and pin their buildSettings. They read ONLY the target's own block and ONLY
 * unconditional keys, while Xcode evaluates a Release archive from:
 *   - the project-level Release configuration, inherited by every key the
 *     target does not set itself (Apple, "Build Configurations": target
 *     values take precedence over project values — so a project value with
 *     no target override IS the effective value), and
 *   - conditional definitions `KEY[sdk=iphoneos*] = …`, which replace the
 *     unconditional value whenever the condition matches (Apple, "Build
 *     Settings" → Conditional build setting definitions); a device archive
 *     always builds with the iphoneos SDK.
 *
 * Every spec below copies the gate inputs into a throwaway repo layout,
 * applies ONE such mutation to project.pbxproj and runs the real gate. Each
 * mutation ships a Release archive that differs from what the gate pinned
 * (DEBUG code, -Onone, build 7, version 2.0, a staging bundle id, iPad
 * support) — exactly the M1/M2/M3/M4/M7 classes of IOSCFG-3, expressed in
 * the other two places Xcode reads them from. The gate must exit non-zero.
 *
 * V7 and V8 (round 2) pin two more fail-open paths of the same parser: a
 * target value of `$(inherited)` that pulls the project-level definition in,
 * and an object-id list whose last element has no trailing comma (Xcode
 * always writes one; a hand edit need not) hiding a linked SwiftPM product
 * from the "every linked product is imported" guard.
 *
 * Static, Linux-runnable. It asserts what Xcode would evaluate per Apple's
 * documented precedence; it does not build.
 */

export {};

// The mobile tsconfig ships no Node types (same pattern as the wf/ suites).
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { execPath: string };
const fs = require('fs') as {
  cpSync: (
    src: string,
    dest: string,
    options: {
      recursive: true;
      filter?: (src: string, dest: string) => boolean;
    },
  ) => void;
  mkdirSync: (p: string, options: { recursive: true }) => void;
  mkdtempSync: (prefix: string) => string;
  readFileSync: (p: string, encoding: 'utf8') => string;
  rmSync: (p: string, options: { recursive: true; force: true }) => void;
  writeFileSync: (p: string, data: string) => void;
};
const os = require('os') as { tmpdir: () => string };
const path = require('path') as {
  basename: (p: string) => string;
  dirname: (p: string) => string;
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
};
const childProcess = require('child_process') as {
  spawnSync: (
    cmd: string,
    args: string[],
    options: { cwd: string; encoding: 'utf8' },
  ) => { status: number | null; stdout: string; stderr: string };
};

const MOBILE_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(MOBILE_ROOT, '..', '..');
const PBXPROJ = 'apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj';

// Everything the two gates read, relative to the repo root.
const GATE_INPUTS = [
  'apps/mobile/ios',
  'apps/mobile/scripts',
  'apps/mobile/android/app/build.gradle',
  'apps/mobile/src/config/runtimeConfig.ts',
  'docs/APP_STORE_SUBMISSION.md',
  'infra/release/release-manifest.json',
];

function makeFixtureRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ioscfg-variant-'));
  for (const rel of GATE_INPUTS) {
    const dest = path.join(root, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(path.join(REPO_ROOT, rel), dest, {
      recursive: true,
      filter: src => {
        const name = path.basename(src);
        return name !== 'Pods' && name !== 'build';
      },
    });
  }
  return root;
}

const pristine = fs.readFileSync(path.join(REPO_ROOT, PBXPROJ), 'utf8');

/** `\t\tID /* name *\/ = {` … `\n\t\t};` — the object's full text. */
function objectText(text: string, id: string): string {
  const start = text.indexOf(`\t\t${id} `);
  if (start < 0) throw new Error(`pbxproj: object ${id} not found`);
  const end = text.indexOf('\n\t\t};', start);
  return text.slice(start, end);
}

function ids(listValue: string): string[] {
  return Array.from(listValue.matchAll(/[0-9A-F]{24}/g), m => m[0]);
}

/** The XCBuildConfiguration id named `name` in the configuration list `listId`. */
function configurationId(text: string, listId: string, name: string): string {
  const list = objectText(text, listId);
  const configs = /buildConfigurations = \(([\s\S]*?)\);/.exec(list)?.[1] ?? '';
  for (const id of ids(configs)) {
    if (
      new RegExp(`^\\t\\t\\tname = ${name};$`, 'm').test(objectText(text, id))
    )
      return id;
  }
  throw new Error(`pbxproj: no ${name} configuration in ${listId}`);
}

function listRef(text: string, ownerId: string): string {
  const owner = objectText(text, ownerId);
  const ref = /^\t\t\tbuildConfigurationList = ([0-9A-F]{24})/m.exec(owner);
  if (!ref)
    throw new Error(`pbxproj: ${ownerId} has no buildConfigurationList`);
  return ref[1]!;
}

const projectId = /^\t\t([0-9A-F]{24}) \/\* Project object \*\/ = \{$/m.exec(
  pristine,
)?.[1];
const appTargetId =
  /^\t\t([0-9A-F]{24}) \/\* PickleSensei \*\/ = \{\n\t\t\tisa = PBXNativeTarget;/m.exec(
    pristine,
  )?.[1];
if (!projectId || !appTargetId)
  throw new Error('pbxproj: project or app target not found');

const PROJECT_RELEASE = configurationId(
  pristine,
  listRef(pristine, projectId),
  'Release',
);
const TARGET_RELEASE = configurationId(
  pristine,
  listRef(pristine, appTargetId),
  'Release',
);

/** Insert `lines` at the top of a configuration's buildSettings block. */
function withSettings(text: string, configId: string, lines: string[]): string {
  const start = text.indexOf(`\t\t${configId} `);
  const marker = 'buildSettings = {\n';
  const at = text.indexOf(marker, start) + marker.length;
  return (
    text.slice(0, at) +
    lines.map(line => `\t\t\t\t${line}\n`).join('') +
    text.slice(at)
  );
}

/** Link a SwiftPM product nothing imports, as the SOLE element of the app
 * target's `packageProductDependencies` list WITHOUT a trailing comma. */
function withUnimportedPackageProduct(text: string): string {
  const productId = 'ADJ0DEADBEEF000000000001';
  const productName = 'NeverImportedProduct';
  const object =
    `/* Begin XCSwiftPackageProductDependency section */\n` +
    `\t\t${productId} /* ${productName} */ = {\n` +
    `\t\t\tisa = XCSwiftPackageProductDependency;\n` +
    `\t\t\tproductName = ${productName};\n` +
    `\t\t};\n` +
    `/* End XCSwiftPackageProductDependency section */\n`;
  const sectionsEnd = text.lastIndexOf('\t};\n\trootObject = ');
  if (sectionsEnd < 0) throw new Error('pbxproj: objects end not found');
  let out = text.slice(0, sectionsEnd) + object + text.slice(sectionsEnd);
  const targetStart = out.indexOf(`\t\t${appTargetId} `);
  const nameLine = '\t\t\tname = PickleSensei;\n';
  const at = out.indexOf(nameLine, targetStart) + nameLine.length;
  out =
    out.slice(0, at) +
    `\t\t\tpackageProductDependencies = (\n` +
    `\t\t\t\t${productId} /* ${productName} */\n` +
    `\t\t\t);\n` +
    out.slice(at);
  return out;
}

interface Gate {
  name: string;
  run: (root: string) => {
    status: number | null;
    stdout: string;
    stderr: string;
  };
}
const checkDistribution: Gate = {
  name: 'scripts/check-ios-distribution.mjs',
  run: root =>
    childProcess.spawnSync(
      process.execPath,
      ['scripts/check-ios-distribution.mjs'],
      { cwd: path.join(root, 'apps', 'mobile'), encoding: 'utf8' },
    ),
};
const releaseCheck: Gate = {
  name: 'tools/release/check-release-manifest.mjs',
  run: root =>
    childProcess.spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, 'tools', 'release', 'check-release-manifest.mjs')],
      { cwd: root, encoding: 'utf8' },
    ),
};

interface Variant {
  title: string;
  /** Which gate is responsible for this class of drift (per its own labels). */
  gates: Gate[];
  mutate: (text: string) => string;
}

const VARIANTS: Variant[] = [
  {
    title:
      'V1 DEBUG=1 / SWIFT DEBUG condition in the PROJECT-level Release configuration (target Release sets neither key)',
    gates: [checkDistribution],
    mutate: t =>
      withSettings(t, PROJECT_RELEASE, [
        'GCC_PREPROCESSOR_DEFINITIONS = (',
        '\t"DEBUG=1",',
        '\t"$(inherited)",',
        ');',
        'SWIFT_ACTIVE_COMPILATION_CONDITIONS = "$(inherited) DEBUG";',
      ]),
  },
  {
    title:
      'V2 SWIFT_OPTIMIZATION_LEVEL = -Onone in the PROJECT-level Release configuration (target Release does not set it)',
    gates: [checkDistribution],
    mutate: t =>
      withSettings(t, PROJECT_RELEASE, [
        'SWIFT_OPTIMIZATION_LEVEL = "-Onone";',
      ]),
  },
  {
    title:
      'V3 "CURRENT_PROJECT_VERSION[sdk=iphoneos*]" = 7 in the app target Release configuration (device archive ships build 7)',
    gates: [checkDistribution, releaseCheck],
    mutate: t =>
      withSettings(t, TARGET_RELEASE, [
        '"CURRENT_PROJECT_VERSION[sdk=iphoneos*]" = 7;',
      ]),
  },
  {
    title:
      'V4 "MARKETING_VERSION[sdk=iphoneos*]" = 2.0 in the app target Release configuration (device archive ships 2.0)',
    gates: [checkDistribution, releaseCheck],
    mutate: t =>
      withSettings(t, TARGET_RELEASE, [
        '"MARKETING_VERSION[sdk=iphoneos*]" = 2.0;',
      ]),
  },
  {
    title:
      'V5 "PRODUCT_BUNDLE_IDENTIFIER[sdk=iphoneos*]" = com.picklesensei.staging in the app target Release configuration',
    gates: [checkDistribution],
    mutate: t =>
      withSettings(t, TARGET_RELEASE, [
        '"PRODUCT_BUNDLE_IDENTIFIER[sdk=iphoneos*]" = com.picklesensei.staging;',
      ]),
  },
  {
    title:
      'V6 "TARGETED_DEVICE_FAMILY[sdk=iphoneos*]" = "1,2" in the app target Release configuration (device archive is iPhone+iPad)',
    gates: [checkDistribution],
    mutate: t =>
      withSettings(t, TARGET_RELEASE, [
        '"TARGETED_DEVICE_FAMILY[sdk=iphoneos*]" = "1,2";',
      ]),
  },
  {
    title:
      'V7 target Release GCC_PREPROCESSOR_DEFINITIONS = $(inherited) while the PROJECT-level Release configuration defines DEBUG=1',
    gates: [checkDistribution],
    mutate: t =>
      withSettings(
        withSettings(t, PROJECT_RELEASE, [
          'GCC_PREPROCESSOR_DEFINITIONS = (',
          '\t"DEBUG=1",',
          '\t"$(inherited)",',
          ');',
        ]),
        TARGET_RELEASE,
        ['GCC_PREPROCESSOR_DEFINITIONS = "$(inherited)";'],
      ),
  },
  {
    title:
      'V8 a SwiftPM product no Swift source imports is linked as the sole packageProductDependencies element without a trailing comma',
    gates: [checkDistribution],
    mutate: withUnimportedPackageProduct,
  },
];

describe('IOSCFG-3 variants: Release drift Xcode evaluates but the fixed Linux gates do not read', () => {
  let root: string;
  beforeAll(() => {
    root = makeFixtureRepo();
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('control: the unmodified project passes both gates in the fixture layout', () => {
    fs.writeFileSync(path.join(root, PBXPROJ), pristine);
    for (const gate of [checkDistribution, releaseCheck]) {
      const result = gate.run(root);
      expect([gate.name, result.status, result.stderr]).toEqual([
        gate.name,
        0,
        '',
      ]);
    }
  });

  it.each(VARIANTS.map(v => [v.title, v] as const))(
    '%s → a gate exits non-zero',
    (_title, variant) => {
      const mutated = variant.mutate(pristine);
      expect(mutated).not.toBe(pristine);
      fs.writeFileSync(path.join(root, PBXPROJ), mutated);
      const results = variant.gates.map(gate => ({
        gate: gate.name,
        status: gate.run(root).status,
      }));
      expect(results.some(r => r.status !== 0)).toBe(true);
    },
  );
});
