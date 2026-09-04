/**
 * Minimal structural reader for an Xcode project.pbxproj (old-style plist).
 *
 * The Linux release gates used to grep the whole file for strings such as
 * `MARKETING_VERSION = 1.0;`, which is satisfied by the Debug configuration
 * alone and says nothing about what a Release archive ships. These helpers
 * resolve the real object graph instead: app target → configuration list →
 * per-configuration build settings, and app target → build phases → build
 * files → file references / SwiftPM products.
 *
 * Build settings are resolved the way Xcode evaluates them, not by reading
 * one block: a target's configuration inherits every project-level setting
 * of the same configuration it does not override, `$(inherited)` in a value
 * pulls the lower level in, and a conditional definition
 * `KEY[sdk=iphoneos*] = …` replaces the unconditional value whenever the
 * build matches its condition (a device archive always does for
 * `sdk=iphoneos*`). `effectiveSettings()` therefore reports EVERY definition
 * a configuration can evaluate to, and gates assert all of them.
 *
 * CommonJS on purpose: the `.mjs` gates import it natively and the Jest
 * suites (babel, no ESM transform for .mjs) `require()` the same code.
 */
'use strict';

const OBJECT_ID = /^[0-9A-F]{24}$/;
const CONDITIONAL_KEY = /^([A-Za-z_][A-Za-z0-9_]*)((?:\[[^\]]*\])+)$/;

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

/** Object ids inside a `( id, … )` list value. Inline comments are
 * tolerated and the last element may omit its trailing comma (Xcode always
 * writes one, a hand edit need not — the list must never silently shrink). */
function idsOf(listValue) {
  if (!listValue) return [];
  const body = /^\s*\(([\s\S]*)\)\s*$/.exec(listValue)?.[1] ?? listValue;
  const withoutComments = body.replace(/\/\*.*?\*\//g, ' ');
  return withoutComments
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      if (!OBJECT_ID.test(part))
        throw new Error(
          `pbxproj: unexpected list element ${JSON.stringify(part)}`,
        );
      return part;
    });
}

/** `KEY[sdk=iphoneos*][arch=*]` → { key: 'KEY', condition: 'sdk=iphoneos*][arch=*' };
 * unconditional keys get `condition: null`. */
function splitConditionalKey(rawKey) {
  const m = CONDITIONAL_KEY.exec(rawKey);
  if (!m) return { key: rawKey, condition: null };
  return { key: m[1], condition: m[2].slice(1, -1) };
}

/** Every definition of `key` in one buildSettings map, conditional ones
 * included, most specific first. */
function definitionsIn(settings, key) {
  const out = [];
  for (const [rawKey, value] of Object.entries(settings)) {
    const split = splitConditionalKey(rawKey);
    if (split.key === key) out.push({ condition: split.condition, value });
  }
  return out.sort((a, b) => (a.condition === null) - (b.condition === null));
}

const INHERITED = /"?\$\(inherited\)"?/g;
const mentionsInherited = value => /\$\(inherited\)/.test(value);

function buildSettingsOf(config) {
  const settingsBody = /buildSettings = \{\n([\s\S]*?)\n\t\t\t\};/.exec(
    `${config.body}\n`,
  );
  return parseFields(`${settingsBody?.[1] ?? ''}\n`);
}

function parsePbxproj(text) {
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

  /** The PBXProject object (`rootObject`). */
  function projectObject() {
    const root = /^\trootObject = ([0-9A-F]{24})/m.exec(text)?.[1];
    const project = root ? objects.get(root) : undefined;
    if (!project || stripComment(project.isa ?? '') !== 'PBXProject')
      throw new Error('pbxproj: rootObject is not a PBXProject');
    return project;
  }

  /** XCBuildConfiguration objects of `owner` (target or project), keyed by name. */
  function configurationObjects(owner) {
    const list = ref(owner.buildConfigurationList);
    if (!list) throw new Error('pbxproj: owner has no XCConfigurationList');
    const out = new Map();
    for (const id of idsOf(list.buildConfigurations)) {
      const config = objects.get(id);
      if (!config) throw new Error(`pbxproj: dangling configuration ${id}`);
      out.set(stripComment(config.name ?? ''), config);
    }
    return out;
  }

  /** The target's OWN buildSettings per configuration, keyed by name. Only
   * for structural assertions (which configurations exist, which keys the
   * target itself pins); shipping values must go through effectiveSettings(). */
  function buildConfigurations(target) {
    const out = new Map();
    for (const [name, config] of configurationObjects(target))
      out.set(name, buildSettingsOf(config));
    return out;
  }

  /** Path of the xcconfig a configuration is based on (undefined when none). */
  function baseConfigurationPath(config) {
    const file = ref(config.baseConfigurationReference);
    if (!file) return undefined;
    return stripComment(file.path ?? '').replace(/^"|"$/g, '');
  }

  /**
   * Effective build settings of `target` per configuration, resolved across
   * the levels Xcode consults (target buildSettings, then the project-level
   * configuration of the same name). Each resolver reports every definition
   * of a key that can take effect — the target's own, conditional variants
   * such as `KEY[sdk=iphoneos*]`, and project-level definitions whenever the
   * target does not define the key unconditionally or its value says
   * `$(inherited)`. xcconfig files (`baseConfigurationReference`) are not
   * read; their paths are reported so a gate can pin which ones are allowed.
   */
  function effectiveSettings(target) {
    const projectConfigs = configurationObjects(projectObject());
    const out = new Map();
    for (const [name, targetConfig] of configurationObjects(target)) {
      const projectConfig = projectConfigs.get(name);
      const levels = [
        { level: 'target', settings: buildSettingsOf(targetConfig) },
        ...(projectConfig
          ? [{ level: 'project', settings: buildSettingsOf(projectConfig) }]
          : []),
      ];
      const baseConfigurations = [
        { level: 'target', path: baseConfigurationPath(targetConfig) },
        ...(projectConfig
          ? [{ level: 'project', path: baseConfigurationPath(projectConfig) }]
          : []),
      ].filter(entry => entry.path !== undefined);

      /** All definitions of `key` that Xcode may evaluate, most specific first. */
      function definitions(key) {
        const found = [];
        for (const { level, settings } of levels) {
          const here = definitionsIn(settings, key);
          for (const def of here) found.push({ level, ...def });
          const shadowsLowerLevels =
            here.some(def => def.condition === null) &&
            !here.some(def => mentionsInherited(def.value));
          if (shadowsLowerLevels) break;
        }
        return found;
      }

      /** Unquoted scalar values of every definition, `$(inherited)` tokens
       * removed; definitions that were nothing but `$(inherited)` are dropped. */
      function values(key) {
        return definitions(key)
          .map(def => settingValue(def.value.replace(INHERITED, '').trim()))
          .map(v => v?.trim())
          .filter(v => v !== undefined && v !== '');
      }

      /** Human-readable `level[condition] = value` list for failure messages. */
      function describe(key) {
        const defs = definitions(key);
        if (defs.length === 0) return `${key} undefined`;
        return defs
          .map(
            d =>
              `${d.level}:${key}${d.condition === null ? '' : `[${d.condition}]`} = ${d.value}`,
          )
          .join('; ');
      }

      out.set(name, {
        name,
        baseConfigurations,
        definitions,
        values,
        describe,
      });
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
    projectObject,
    buildConfigurations,
    effectiveSettings,
    buildPhase,
    resourcePaths,
    linkedPackageProducts,
    remotePackageUrls,
  };
}

/** Unquoted scalar form of a build-setting value (`"1,2"` → `1,2`). */
function settingValue(value) {
  if (value === undefined) return undefined;
  return value.replace(/^"([\s\S]*)"$/, '$1');
}

module.exports = { parsePbxproj, settingValue };
