/**
 * Minimal structural reader for an Xcode project.pbxproj (old-style plist).
 *
 * The Linux release gates used to grep the whole file for strings such as
 * `MARKETING_VERSION = 1.0;`, which is satisfied by the Debug configuration
 * alone and says nothing about what a Release archive ships. These helpers
 * resolve the real object graph instead: app target → configuration list →
 * per-configuration build settings, and app target → build phases → build
 * files → file references / SwiftPM products.
 */

const OBJECT_ID = /^[0-9A-F]{24}$/;

function stripComment(token) {
  return token.replace(/\s*\/\*.*?\*\/\s*$/, '').trim();
}

/** `key = value;` pairs of one object body; array values keep their `( … )`. */
function parseFields(body) {
  const fields = {};
  const pair = /^\s*("[^"\n]+"|[^"=\s]+) = (\([\s\S]*?\)|[^\n]*?);\n/gm;
  for (const m of body.matchAll(pair)) {
    fields[m[1].replace(/^"|"$/g, '')] = m[2];
  }
  return fields;
}

/** Object ids inside a `( id, … )` list value (inline comments tolerated). */
function idsOf(listValue) {
  if (!listValue) return [];
  return Array.from(
    listValue.matchAll(/([0-9A-F]{24})(?=\s*(?:\/\*.*?\*\/)?\s*,)/g),
    m => m[1],
  );
}

export function parsePbxproj(text) {
  const objects = new Map();
  // Multi-line objects: `\t\tID /* name */ = {\n … \n\t\t};`
  const multi =
    /^\t\t([0-9A-F]{24}) (?:\/\*.*?\*\/ )?= \{\n([\s\S]*?)\n\t\t\};$/gm;
  for (const m of text.matchAll(multi)) {
    objects.set(m[1], { id: m[1], body: m[2], ...parseFields(`${m[2]}\n`) });
  }
  // Single-line objects (PBXBuildFile, PBXFileReference):
  // `\t\tID /* name */ = {isa = X; key = value; …};`
  const single = /^\t\t([0-9A-F]{24}) (?:\/\*.*?\*\/ )?= \{(.*)\};$/gm;
  for (const m of text.matchAll(single)) {
    if (objects.has(m[1])) continue;
    const fields = {};
    for (const part of m[2].split(/;\s*/)) {
      const kv = /^([^=\s]+) = (.*)$/.exec(part.trim());
      if (kv) fields[kv[1]] = kv[2];
    }
    objects.set(m[1], { id: m[1], body: m[2], ...fields });
  }

  const byIsa = isa =>
    Array.from(objects.values()).filter(o => stripComment(o.isa ?? '') === isa);
  const ref = value => {
    const id = stripComment(value ?? '');
    return OBJECT_ID.test(id) ? objects.get(id) : undefined;
  };

  /** The application target (`productType = com.apple.product-type.application`). */
  function appTarget(name) {
    const targets = byIsa('PBXNativeTarget').filter(
      t =>
        stripComment(t.productType ?? '').replace(/"/g, '') ===
          'com.apple.product-type.application' &&
        (name === undefined || stripComment(t.name ?? '') === name),
    );
    if (targets.length !== 1) {
      throw new Error(
        `pbxproj: expected exactly one application target${name ? ` named ${name}` : ''}, found ${targets.length}`,
      );
    }
    return targets[0];
  }

  /** buildSettings of every configuration of `target`, keyed by name. */
  function buildConfigurations(target) {
    const list = ref(target.buildConfigurationList);
    if (!list) throw new Error('pbxproj: target has no XCConfigurationList');
    const out = new Map();
    for (const id of idsOf(list.buildConfigurations)) {
      const config = objects.get(id);
      if (!config) throw new Error(`pbxproj: dangling configuration ${id}`);
      const settingsBody = /buildSettings = \{\n([\s\S]*?)\n\t\t\t\};/.exec(
        `${config.body}\n`,
      );
      out.set(
        stripComment(config.name ?? ''),
        parseFields(`${settingsBody?.[1] ?? ''}\n`),
      );
    }
    return out;
  }

  /** The build phase of `isa` owned by `target` (undefined when absent). */
  function buildPhase(target, isa) {
    return idsOf(target.buildPhases)
      .map(id => objects.get(id))
      .find(phase => phase && stripComment(phase.isa ?? '') === isa);
  }

  /** PBXFileReference paths copied by the target's Resources phase. */
  function resourcePaths(target) {
    const phase = buildPhase(target, 'PBXResourcesBuildPhase');
    return idsOf(phase?.files)
      .map(id => ref(objects.get(id)?.fileRef))
      .filter(Boolean)
      .map(file => stripComment(file.path ?? '').replace(/^"|"$/g, ''));
  }

  /** SwiftPM product names linked by the target (Frameworks phase or
   * packageProductDependencies). */
  function linkedPackageProducts(target) {
    const names = new Set();
    const frameworks = buildPhase(target, 'PBXFrameworksBuildPhase');
    for (const id of idsOf(frameworks?.files)) {
      const product = ref(objects.get(id)?.productRef);
      if (product?.productName) names.add(stripComment(product.productName));
    }
    for (const id of idsOf(target.packageProductDependencies)) {
      const product = objects.get(id);
      if (product?.productName) names.add(stripComment(product.productName));
    }
    return Array.from(names).sort();
  }

  /** Remote SwiftPM repository URLs referenced by the project. */
  function remotePackageUrls() {
    return byIsa('XCRemoteSwiftPackageReference').map(pkg =>
      stripComment(pkg.repositoryURL ?? '').replace(/^"|"$/g, ''),
    );
  }

  return {
    objects,
    appTarget,
    buildConfigurations,
    buildPhase,
    resourcePaths,
    linkedPackageProducts,
    remotePackageUrls,
  };
}

/** Unquoted scalar form of a build-setting value (`"1,2"` → `1,2`). */
export function settingValue(value) {
  if (value === undefined) return undefined;
  return value.replace(/^"([\s\S]*)"$/, '$1');
}
