// Extractors: turn the repository on disk into a structured architecture model.
// Every fact carries the file (and where cheap, the line) it was read from so
// the JSON is auditable. Pure reads — nothing here writes to the repo.
import fsSync from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  exists,
  isDir,
  readText,
  readJson,
  walk,
  countLines,
  lineOf,
  sortedUnique,
  sortByKey,
} from "./fsutil.mjs";

const TS_EXTS = [".ts", ".tsx", ".mts", ".cts"];
const CODE_EXTS = [...TS_EXTS, ".js", ".mjs", ".cjs"];

// ── Workspaces ──────────────────────────────────────────────────────────────

/** Parse pnpm-workspace.yaml `packages:` globs (only the `- "..."` list form). */
export function parseWorkspaceGlobs(yamlText) {
  const globs = [];
  for (const raw of yamlText.split("\n")) {
    const m = /^\s*-\s*["']?([^"'#]+?)["']?\s*(#.*)?$/.exec(raw);
    if (m) globs.push(m[1].trim());
  }
  return globs;
}

export function expandWorkspaceGlobs(repoRoot, globs) {
  const include = [];
  const exclude = new Set();
  for (const g of globs) {
    const neg = g.startsWith("!");
    const pattern = neg ? g.slice(1) : g;
    const dirs = [];
    if (pattern.endsWith("/*")) {
      const base = pattern.slice(0, -2);
      if (isDir(path.join(repoRoot, base))) {
        for (const d of walk(repoRoot, base, { maxDepth: 1, exts: [".json"] })) {
          if (path.basename(d) === "package.json") dirs.push(path.dirname(d));
        }
      }
    } else if (exists(path.join(repoRoot, pattern, "package.json"))) {
      dirs.push(pattern);
    }
    if (neg) for (const d of dirs) exclude.add(d);
    else include.push(...dirs);
  }
  return sortedUnique(include.filter((d) => !exclude.has(d)));
}

function kindForDir(dir) {
  if (dir.startsWith("apps/")) return "app";
  if (dir.startsWith("services/")) return "service";
  if (dir.startsWith("packages/")) return "package";
  if (dir.startsWith("tools/")) return "tool";
  return "other";
}

export function extractWorkspaces(repoRoot) {
  const wsYaml = readText(path.join(repoRoot, "pnpm-workspace.yaml"));
  const globs = parseWorkspaceGlobs(wsYaml);
  const dirs = expandWorkspaceGlobs(repoRoot, globs);
  const nodes = {};
  for (const dir of dirs) {
    const pkg = readJson(path.join(repoRoot, dir, "package.json"));
    nodes[pkg.name ?? dir] = describePackage(dir, pkg, "pnpm");
  }
  // apps/mobile is intentionally outside the pnpm workspace (npm + lockfile).
  const mobileDir = "apps/mobile";
  if (exists(path.join(repoRoot, mobileDir, "package.json"))) {
    const pkg = readJson(path.join(repoRoot, mobileDir, "package.json"));
    const node = describePackage(mobileDir, pkg, "npm");
    node.workspaceExcluded = globs.includes("!apps/mobile");
    nodes[pkg.name ?? mobileDir] = node;
  }
  const rootPkg = readJson(path.join(repoRoot, "package.json"));
  return {
    globs,
    root: {
      name: rootPkg.name,
      packageManager: rootPkg.packageManager ?? null,
      engines: rootPkg.engines ?? null,
      scripts: Object.keys(rootPkg.scripts ?? {}).sort(),
    },
    nodes: sortByKey(nodes),
  };
}

function describePackage(dir, pkg, manager) {
  const deps = { ...(pkg.dependencies ?? {}) };
  const devDeps = { ...(pkg.devDependencies ?? {}) };
  const peerDeps = { ...(pkg.peerDependencies ?? {}) };
  const workspaceDeps = {};
  const workspaceDepKinds = {};
  const isWs = (name, spec) => String(spec).startsWith("workspace:") || name.startsWith("@pickle/");
  for (const [kind, table] of [
    ["dependencies", deps],
    ["peerDependencies", peerDeps],
    ["devDependencies", devDeps],
  ]) {
    for (const [name, spec] of Object.entries(table)) {
      if (!isWs(name, spec)) continue;
      workspaceDeps[name] = spec;
      workspaceDepKinds[name] ??= kind;
    }
  }
  return {
    dir,
    kind: kindForDir(dir),
    manager,
    private: pkg.private ?? false,
    version: pkg.version ?? null,
    scripts: Object.keys(pkg.scripts ?? {}).sort(),
    hasTestScript: Boolean(pkg.scripts?.test),
    hasTypecheckScript: Boolean(pkg.scripts?.typecheck),
    workspaceDeps: sortByKey(workspaceDeps),
    workspaceDepKinds: sortByKey(workspaceDepKinds),
    externalDeps: sortedUnique(
      Object.keys({ ...deps, ...devDeps, ...peerDeps }).filter((n) => !(n in workspaceDeps)),
    ),
  };
}

// ── Import edges ────────────────────────────────────────────────────────────

const IMPORT_RE =
  /(?:import|export)\s+(type\s+)?(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]|(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Every import/export/require specifier with its offset; `typeOnly` marks `import type`. */
export function importSpecifiers(source) {
  const out = [];
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(source)) !== null) {
    out.push({ spec: m[2] ?? m[3], offset: m.index, typeOnly: Boolean(m[1]) });
  }
  return out;
}

/** Files under these directory names are test/bench/eval only, not runtime. */
const NON_RUNTIME_DIR_RE = /(^|\/)(test|tests|__tests__|eval|bench|benches|fixtures|scripts)\//;
export function isRuntimeSourceFile(rel) {
  return !NON_RUNTIME_DIR_RE.test(rel) && !/\.(test|spec|eval|bench)\.[cm]?[jt]sx?$/.test(rel);
}

function packageOfSpecifier(spec) {
  if (!spec.startsWith("@pickle/")) return null;
  const parts = spec.split("/");
  return `${parts[0]}/${parts[1]}`;
}

/**
 * For every workspace node, scan its TS/JS sources for `@pickle/*` imports and
 * relative imports that escape the package directory (`../../packages/x/...`).
 * Returns per-node {imports: {pkgName: [file:line,...]}, crossDirImports: [...]}.
 */
export function extractImportEdges(repoRoot, workspaces) {
  const dirToName = new Map(Object.entries(workspaces.nodes).map(([n, v]) => [v.dir, n]));
  const result = {};
  for (const [name, node] of Object.entries(workspaces.nodes)) {
    const files = walk(repoRoot, node.dir, { exts: CODE_EXTS, ignoreDirs: ["ios", "android"] });
    const imports = {};
    const runtimeImports = {};
    const crossDir = [];
    const nativeBridges = [];
    for (const f of files) {
      const text = readText(path.join(repoRoot, f));
      const runtimeFile = isRuntimeSourceFile(f.slice(node.dir.length + 1));
      for (const { spec, offset, typeOnly } of importSpecifiers(text)) {
        const pkgName = packageOfSpecifier(spec);
        const where = `${f}:${lineOf(text, offset)}`;
        if (pkgName) {
          if (pkgName !== name) {
            (imports[pkgName] ??= []).push(where);
            if (runtimeFile && !typeOnly) (runtimeImports[pkgName] ??= []).push(where);
          }
        } else if (spec.startsWith(".")) {
          const abs = path.posix.normalize(path.posix.join(path.posix.dirname(f), spec));
          if (!abs.startsWith(node.dir + "/") && abs !== node.dir) {
            const targetDir = [...dirToName.keys()].find((d) => abs.startsWith(d + "/"));
            crossDir.push({
              where,
              spec,
              resolves: abs,
              targetPackage: targetDir ? dirToName.get(targetDir) : null,
            });
          }
        }
      }
      if (
        /NativeModules\.|TurboModuleRegistry|requireNativeComponent|codegenNativeComponent/.test(
          text,
        )
      ) {
        nativeBridges.push(f);
      }
    }
    for (const k of Object.keys(imports)) imports[k].sort();
    for (const k of Object.keys(runtimeImports)) runtimeImports[k].sort();
    result[name] = {
      fileCount: files.length,
      imports: sortByKey(imports),
      runtimeImports: sortByKey(runtimeImports),
      crossDirImports: crossDir.sort((a, b) => (a.where < b.where ? -1 : 1)),
      nativeBridgeFiles: nativeBridges.sort(),
    };
  }
  return result;
}

// ── apps/mobile alias tables (tsconfig paths / metro / jest) ────────────────

export function extractMobileAliases(repoRoot) {
  const dir = "apps/mobile";
  const out = { tsconfigPaths: {}, metroAliases: {}, jestMappers: {} };
  const tsconfigPath = path.join(repoRoot, dir, "tsconfig.json");
  if (exists(tsconfigPath)) {
    const paths = readJson(tsconfigPath).compilerOptions?.paths ?? {};
    for (const [k, v] of Object.entries(paths)) out.tsconfigPaths[k] = v[0] ?? null;
  }
  const aliasRe = /['"](@pickle\/[a-z0-9-]+)['"]\s*:/g;
  for (const [file, key] of [
    ["metro.config.js", "metroAliases"],
    ["jest.config.js", "jestMappers"],
  ]) {
    const p = path.join(repoRoot, dir, file);
    if (!exists(p)) continue;
    const text = readText(p);
    let m;
    while ((m = aliasRe.exec(text)) !== null) {
      const name = m[1].replace(/^\^/, "").replace(/\$$/, "");
      out[key][name] = `${dir}/${file}:${lineOf(text, m.index)}`;
    }
    // jest moduleNameMapper keys look like '^@pickle/x$'
    const jestRe = /['"]\^(@pickle\/[a-z0-9-]+)\$['"]\s*:/g;
    while ((m = jestRe.exec(text)) !== null) {
      out[key][m[1]] = `${dir}/${file}:${lineOf(text, m.index)}`;
    }
  }
  for (const k of Object.keys(out)) out[k] = sortByKey(out[k]);
  return out;
}

// ── Native targets (SwiftPM, CocoaPods local pod, Xcode SwiftPM refs) ───────

export function extractNative(repoRoot) {
  const targets = [];
  for (const pkgFile of walk(repoRoot, "native", { exts: [".swift"], maxDepth: 2 })) {
    if (path.basename(pkgFile) !== "Package.swift") continue;
    const text = readText(path.join(repoRoot, pkgFile));
    const dir = path.posix.dirname(pkgFile);
    const name = /name:\s*"([^"]+)"/.exec(text)?.[1] ?? dir;
    const localDeps = [...text.matchAll(/\.package\(path:\s*"([^"]+)"\)/g)].map((m) =>
      path.posix.normalize(path.posix.join(dir, m[1])),
    );
    const remoteDeps = [...text.matchAll(/\.package\(url:\s*"([^"]+)"/g)].map((m) => m[1]);
    const products = [...text.matchAll(/\.(library|executable)\(name:\s*"([^"]+)"/g)].map((m) => ({
      type: m[1],
      name: m[2],
    }));
    const testTargets = [...text.matchAll(/\.testTarget\(\s*name:\s*"([^"]+)"/g)].map((m) => m[1]);
    const sources = walk(repoRoot, dir, { exts: [".swift"] }).filter(
      (f) => path.basename(f) !== "Package.swift",
    );
    targets.push({
      kind: "swiftpm",
      name,
      dir,
      manifest: pkgFile,
      localDeps,
      remoteDeps,
      products,
      testTargets,
      sourceFiles: sources.filter((f) => !/\/Tests?\//.test(f)),
      testFiles: sources.filter((f) => /\/Tests?\//.test(f)),
      loc: sources.reduce((n, f) => n + countLines(readText(path.join(repoRoot, f))), 0),
    });
  }
  // Source-only native dirs without a Package.swift (consumed via symlinks).
  for (const d of walk(repoRoot, "native", { exts: [".swift"], maxDepth: 3 })) {
    const top = d.split("/").slice(0, 2).join("/");
    if (!targets.some((t) => t.dir === top || t.dir.startsWith(top))) {
      if (!targets.some((t) => t.dir === top)) {
        const sources = walk(repoRoot, top, { exts: [".swift"] });
        targets.push({
          kind: "swift-sources",
          name: path.posix.basename(top),
          dir: top,
          manifest: null,
          localDeps: [],
          remoteDeps: [],
          products: [],
          testTargets: [],
          sourceFiles: sources,
          testFiles: [],
          loc: sources.reduce((n, f) => n + countLines(readText(path.join(repoRoot, f))), 0),
        });
      }
    }
  }
  targets.sort((a, b) => (a.dir < b.dir ? -1 : 1));

  // CocoaPods local pod: parse podspec source_files and resolve symlinks.
  const podspecs = walk(repoRoot, "apps/mobile/ios/LocalPods", { exts: [".podspec"] });
  const pods = [];
  for (const spec of podspecs) {
    const text = readText(path.join(repoRoot, spec));
    const podDir = path.posix.dirname(spec);
    const name = /s\.name\s*=\s*"([^"]+)"/.exec(text)?.[1] ?? path.posix.basename(podDir);
    const sourceGlobs = [...text.matchAll(/"([^"]*\.(?:swift|h|m|\{[^}]*\}))"/g)].map((m) => m[1]);
    const deps = [...text.matchAll(/s\.dependency\s+"([^"]+)"/g)].map((m) => m[1]);
    const symlinks = [];
    const linkDir = path.join(repoRoot, podDir, "Sources", "Core");
    if (isDir(linkDir)) {
      for (const entry of readdirSorted(linkDir)) {
        const abs = path.join(linkDir, entry);
        let target = null;
        let resolvedExists = false;
        try {
          const st = fsSync.lstatSync(abs);
          if (st.isSymbolicLink()) {
            target = fsSync.readlinkSync(abs);
            const resolved = path.resolve(linkDir, target);
            resolvedExists = exists(resolved);
            target = path.posix.normalize(
              path.relative(repoRoot, resolved).split(path.sep).join("/"),
            );
          }
        } catch {
          target = null;
        }
        symlinks.push({ file: `${podDir}/Sources/Core/${entry}`, target, resolvedExists });
      }
    }
    pods.push({ kind: "cocoapod", name, dir: podDir, podspec: spec, sourceGlobs, deps, symlinks });
  }
  // Xcode project SwiftPM remote refs.
  const pbx = walk(repoRoot, "apps/mobile/ios", { exts: [".pbxproj"], maxDepth: 2 });
  const xcodeRemotePackages = [];
  for (const p of pbx) {
    const text = readText(path.join(repoRoot, p));
    for (const m of text.matchAll(/repositoryURL\s*=\s*"([^"]+)"/g)) xcodeRemotePackages.push(m[1]);
  }
  const podfile = path.join(repoRoot, "apps/mobile/ios/Podfile");
  const podfileLocalPods = exists(podfile)
    ? [...readText(podfile).matchAll(/pod\s+'([^']+)',\s*:path\s*=>\s*'([^']+)'/g)].map((m) => ({
        pod: m[1],
        path: m[2],
      }))
    : [];
  return {
    swiftTargets: targets,
    pods,
    podfileLocalPods,
    xcodeProjects: pbx,
    xcodeRemotePackages: sortedUnique(xcodeRemotePackages),
  };
}

function readdirSorted(dir) {
  return fsSync.readdirSync(dir).sort();
}

// ── Edge function ───────────────────────────────────────────────────────────

export function extractEdgeFunction(repoRoot) {
  const dir = "supabase/functions/api";
  const files = walk(repoRoot, dir, { exts: [".ts"], ignoreDirs: ["__wf__"] });
  const modules = {};
  const externalImports = new Set();
  for (const f of files) {
    const text = readText(path.join(repoRoot, f));
    const local = [];
    for (const { spec } of importSpecifiers(text)) {
      if (spec.startsWith("."))
        local.push(path.posix.normalize(path.posix.join(path.posix.dirname(f), spec)));
      else externalImports.add(spec);
    }
    modules[f] = { loc: countLines(text), localImports: sortedUnique(local) };
  }
  const tests = walk(repoRoot, `${dir}/__wf__`, { exts: [".ts", ".sh", ".sql"] });
  const denoJson = path.join(repoRoot, dir, "__wf__", "deno.json");
  return {
    dir,
    entrypoint: `${dir}/index.ts`,
    modules: sortByKey(modules),
    externalImports: [...externalImports].sort(),
    testFiles: tests,
    denoTasks: exists(denoJson) ? Object.keys(readJson(denoJson).tasks ?? {}).sort() : [],
  };
}

// ── Routes: edge fn, legacy Fastify API, mobile client calls ────────────────

function regexRouteToPath(re) {
  // /^\/v1\/analysis-permits\/([^/]+)\/finalize$/ -> /v1/analysis-permits/:param/finalize
  return re
    .replace(/^\^/, "")
    .replace(/\$$/, "")
    .replace(/\\\//g, "/")
    .replace(/\(\[\^\/\]\+\)/g, ":param")
    .replace(/\([^)]*\)/g, ":param");
}

export function extractEdgeRoutes(repoRoot, file = "supabase/functions/api/index.ts") {
  const text = readText(path.join(repoRoot, file));
  const routes = [];
  const push = (method, p, offset, how) =>
    routes.push({ method, path: p, where: `${file}:${lineOf(text, offset)}`, how });
  for (const m of text.matchAll(/case\s+"(GET|POST|PUT|PATCH|DELETE)\s+(\/v1\/[^"]+)"/g)) {
    push(m[1], m[2], m.index, "switch-case");
  }
  for (const m of text.matchAll(/route\s*===\s*"(GET|POST|PUT|PATCH|DELETE)\s+(\/v1\/[^"]+)"/g)) {
    push(m[1], m[2], m.index, "route-equality");
  }
  for (const m of text.matchAll(/\/(\^\\\/v1\\\/[^\n]*?\$)\/\.exec\(path\)/g)) {
    // Method comes from the nearest preceding `request.method === "X"` guard.
    const before = text.slice(0, m.index);
    const guards = [...before.matchAll(/request\.method\s*===\s*"(GET|POST|PUT|PATCH|DELETE)"/g)];
    const guard = guards.length ? guards[guards.length - 1] : null;
    const orGuard = guard
      ? /request\.method\s*===\s*"(GET|POST|PUT|PATCH|DELETE)"\s*\|\|\s*request\.method\s*===\s*"(GET|POST|PUT|PATCH|DELETE)"/.exec(
          text.slice(Math.max(0, guard.index - 60), guard.index + 120),
        )
      : null;
    const methods = orGuard ? [orGuard[1], orGuard[2]] : guard ? [guard[1]] : ["ANY"];
    for (const method of methods) push(method, regexRouteToPath(m[1]), m.index, "regex");
  }
  for (const m of text.matchAll(/path\s*===\s*"(\/v1\/[^"]+)"/g)) {
    const before = text.slice(0, m.index);
    const guards = [...before.matchAll(/request\.method\s*===\s*"(GET|POST|PUT|PATCH|DELETE)"/g)];
    const method = guards.length ? guards[guards.length - 1][1] : "ANY";
    push(method, m[1], m.index, "path-equality");
  }
  const publicRoutes = [];
  for (const m of text.matchAll(/url\.pathname\.endsWith\("(\/[a-z/]+)"\)/g)) {
    publicRoutes.push({
      path: m[1],
      where: `${file}:${lineOf(text, m.index)}`,
      method: /request\.method\s*===\s*"POST"/.test(text.slice(Math.max(0, m.index - 80), m.index))
        ? "POST"
        : "GET",
    });
  }
  const rateLimitFamilies = [
    ...text.matchAll(
      /match:\s*\(m,\s*p\)\s*=>\s*m\s*===\s*"([A-Z]+)"\s*&&\s*p(?:\.startsWith\(|\s*===\s*)"([^"]+)"/g,
    ),
  ].map((m) => ({ method: m[1], path: m[2], where: `${file}:${lineOf(text, m.index)}` }));
  return {
    routes: dedupeRoutes(routes),
    publicRoutes,
    rateLimitFamilies,
  };
}

function dedupeRoutes(routes) {
  const seen = new Map();
  for (const r of routes) {
    const key = `${r.method} ${r.path}`;
    if (!seen.has(key)) seen.set(key, { ...r, where: [r.where], how: [r.how] });
    else {
      seen.get(key).where.push(r.where);
      seen.get(key).how.push(r.how);
    }
  }
  return [...seen.values()]
    .map((r) => ({ ...r, where: sortedUnique(r.where), how: sortedUnique(r.how) }))
    .sort((a, b) => (`${a.path} ${a.method}` < `${b.path} ${b.method}` ? -1 : 1));
}

export function extractFastifyRoutes(repoRoot, dir = "services/api/src") {
  const routes = [];
  for (const f of walk(repoRoot, dir, { exts: [".ts"] })) {
    const text = readText(path.join(repoRoot, f));
    for (const m of text.matchAll(
      /\b(?:app|fastify|server|instance)\.(get|post|put|patch|delete)\(\s*"(\/[^"]+)"/g,
    )) {
      routes.push({
        method: m[1].toUpperCase(),
        path: m[2].replace(/:[a-zA-Z0-9_]+/g, ":param"),
        where: `${f}:${lineOf(text, m.index)}`,
        how: "fastify",
      });
    }
  }
  return dedupeRoutes(routes);
}

/**
 * `/v1/x/${encodeURIComponent(id)}/finalize` → `/v1/x/:param/finalize`.
 * A `${…}` that does not follow a `/` is a query/suffix interpolation
 * (`/v1/catalog/drills${query}`) and is dropped along with anything after it.
 */
export function normalizeClientPath(raw) {
  return raw
    .replace(/\?.*$/, "")
    .replace(/(?<=\/)\$\{[^}]*\}/g, ":param")
    .replace(/\$\{.*$/, "")
    .replace(/[`'"].*$/, "");
}

// `'/v1/x'`, `` `/v1/x/${id}` `` or `` `${session.apiBaseUrl}/v1/x` ``.
const CLIENT_PATH_RE = /['"`](?:\$\{[^}]*\})?(\/v1\/(?:[A-Za-z0-9_:.\-/?=&]|\$\{[^}]*\})+)/g;

export function extractMobileClientCalls(repoRoot, dir = "apps/mobile/src") {
  const calls = [];
  for (const f of walk(repoRoot, dir, { exts: TS_EXTS })) {
    if (/__tests__|\.test\.|\.spec\./.test(f)) continue;
    const text = readText(path.join(repoRoot, f));
    for (const m of text.matchAll(CLIENT_PATH_RE)) {
      const p = normalizeClientPath(m[1]);
      // Method: the adjacent argument — `request('POST', '/v1/x')` or
      // `request('/v1/x', 'POST')`. Anything else is UNKNOWN (no guessing).
      const before = text.slice(Math.max(0, m.index - 80), m.index);
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 400);
      const prev = /['"](GET|POST|PUT|PATCH|DELETE)['"]\s*,\s*$/.exec(before);
      const next = /^['"`]\s*,\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/.exec(after);
      // fetch(`${base}/v1/x`, { method: 'POST', … }) — look inside the init object.
      const fetchInit =
        /^['"`]\s*,\s*\{[^}]*?\bmethod:\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/s.exec(after);
      const method = prev ? prev[1] : next ? next[1] : fetchInit ? fetchInit[1] : "UNKNOWN";
      calls.push({ path: p, method, where: `${f}:${lineOf(text, m.index)}` });
    }
  }
  const byPath = {};
  for (const c of calls) {
    const entry = (byPath[c.path] ??= { methods: [], where: [] });
    entry.methods.push(c.method);
    entry.where.push(c.where);
  }
  for (const k of Object.keys(byPath)) {
    byPath[k] = { methods: sortedUnique(byPath[k].methods), where: sortedUnique(byPath[k].where) };
  }
  return sortByKey(byPath);
}

// ── Environment variables ───────────────────────────────────────────────────

const SECRET_NAME_RE =
  /(SECRET|_KEY\b|_KEY_|TOKEN|PASSWORD|PRIVATE|CREDENTIAL|SERVICE_ACCOUNT|WEBHOOK_AUTH)/;

const ENV_SCAN_ROOTS = [
  "apps/admin-web/src",
  "apps/mobile/src",
  "packages",
  "services",
  "supabase/functions",
  "supabase/tests",
  "tools",
  "scripts",
  "ml/scripts",
  "infra",
];

function runtimeFor(file) {
  if (file.startsWith("supabase/functions/")) return "edge-fn(deno)";
  if (file.startsWith("supabase/tests/")) return "rls-tests(shell)";
  if (file.startsWith("services/")) return "service(node)";
  if (file.startsWith("packages/")) return "package(node)";
  if (file.startsWith("apps/mobile/")) return "mobile(rn)";
  if (file.startsWith("apps/admin-web/")) return "admin-web(vite)";
  if (file.startsWith("scripts/") || file.endsWith(".sh")) return "scripts(shell)";
  if (file.startsWith("ml/")) return "ml(python)";
  if (file.startsWith("tools/")) return "tools";
  if (file.startsWith("infra/")) return "infra";
  return "other";
}

export function extractEnvVars(repoRoot) {
  const consumers = {};
  const add = (name, file, line, viaPattern) => {
    if (!/^[A-Z][A-Z0-9_]{2,}$/.test(name)) return;
    if (
      /^(PATH|HOME|PWD|SHELL|USER|TERM|LANG|TMPDIR|IFS|OLDPWD|RANDOM|LINENO|BASH_SOURCE|OPTARG|OPTIND|PIPESTATUS|GITHUB_[A-Z_]+|RUNNER_[A-Z_]+|NODE_ENV|NODE_OPTIONS|DEBUG|FORCE_COLOR|NO_COLOR|TZ|EDITOR|XDG_[A-Z_]+|LC_[A-Z_]+|HOSTNAME|LOGNAME|UID|EUID|PPID|SECONDS|BASH_[A-Z_]+|FUNCNAME|REPLY|SHLVL|COLUMNS|LINES|ARGS|MAX|MIN|UTC|JSON|HTTP|HTTPS|URL|API|ID|KEY|OK|TODO|POST|GET|PUT|DELETE|PATCH|ANY|ALL|NONE|ERROR|WARN|INFO|GC|IOS|EOF|SIGINT|SIGTERM|TRUE|FALSE|NULL)$/.test(
        name,
      )
    )
      return;
    const entry = (consumers[name] ??= { consumers: [], runtimes: new Set(), patterns: new Set() });
    entry.consumers.push(`${file}:${line}`);
    entry.runtimes.add(runtimeFor(file));
    entry.patterns.add(viaPattern);
  };
  const patterns = [
    [/process\.env\.([A-Z][A-Z0-9_]+)/g, "process.env.X"],
    [/process\.env\[["']([A-Z][A-Z0-9_]+)["']\]/g, 'process.env["X"]'],
    [/\benv\[["']([A-Z][A-Z0-9_]+)["']\]/g, 'env["X"]'],
    [/Deno\.env\.get\(["']([A-Z][A-Z0-9_]+)["']\)/g, "Deno.env.get"],
    [/os\.environ(?:\.get)?\(?\[?["']([A-Z][A-Z0-9_]+)["']/g, "os.environ"],
    [/os\.getenv\(["']([A-Z][A-Z0-9_]+)["']/g, "os.getenv"],
    [/import\.meta\.env\.([A-Z][A-Z0-9_]+)/g, "import.meta.env"],
  ];
  const shellPattern = /\$\{([A-Z][A-Z0-9_]+)(?::[-=?+][^}]*)?\}/g;
  for (const root of ENV_SCAN_ROOTS) {
    const files = walk(repoRoot, root, {
      exts: [...CODE_EXTS, ".py", ".sh", ".sql"],
      ignoreDirs: ["ios", "android", "results"],
    });
    for (const f of files) {
      const text = readText(path.join(repoRoot, f));
      const isShell = f.endsWith(".sh");
      for (const [re, label] of patterns) {
        for (const m of text.matchAll(re)) add(m[1], f, lineOf(text, m.index), label);
      }
      if (isShell) {
        for (const m of text.matchAll(shellPattern))
          add(m[1], f, lineOf(text, m.index), "shell ${X}");
      }
    }
  }
  // Declarations: .env.example, docker-compose, workflows, AGENTS.md secrets list, supabase README.
  const declared = {};
  const declare = (name, source) => {
    if (!/^[A-Z][A-Z0-9_]{2,}$/.test(name)) return;
    (declared[name] ??= new Set()).add(source);
  };
  const envExample = path.join(repoRoot, ".env.example");
  if (exists(envExample)) {
    const text = readText(envExample);
    text.split("\n").forEach((line, i) => {
      const m = /^#?\s*([A-Z][A-Z0-9_]+)=/.exec(line);
      if (m) declare(m[1], `.env.example:${i + 1}`);
    });
  }
  const compose = path.join(repoRoot, "docker-compose.yml");
  if (exists(compose)) {
    const text = readText(compose);
    text.split("\n").forEach((line, i) => {
      const m = /^\s+([A-Z][A-Z0-9_]+):\s/.exec(line);
      if (m) declare(m[1], `docker-compose.yml:${i + 1}`);
    });
  }
  for (const wf of walk(repoRoot, ".github/workflows", { exts: [".yml", ".yaml"] })) {
    const text = readText(path.join(repoRoot, wf));
    text.split("\n").forEach((line, i) => {
      const m = /^\s+([A-Z][A-Z0-9_]+):\s/.exec(line);
      if (m) declare(m[1], `${wf}:${i + 1}`);
      for (const s of line.matchAll(/secrets\.([A-Z][A-Z0-9_]+)/g))
        declare(s[1], `${wf}:${i + 1} (secrets.*)`);
    });
  }
  for (const doc of [
    "AGENTS.md",
    "supabase/README.md",
    "docs/devin/OPERATING_SYSTEM.md",
    "docs/devin/SECURITY_BOUNDARIES.md",
  ]) {
    const p = path.join(repoRoot, doc);
    if (!exists(p)) continue;
    const text = readText(p);
    for (const m of text.matchAll(/`([A-Z][A-Z0-9_]{3,})(?:=[^`]*)?`/g))
      declare(m[1], `${doc}:${lineOf(text, m.index)}`);
  }
  const names = sortedUnique([...Object.keys(consumers), ...Object.keys(declared)]);
  const matrix = {};
  for (const n of names) {
    const c = consumers[n];
    matrix[n] = {
      isSecretLike: SECRET_NAME_RE.test(n),
      consumers: c ? sortedUnique(c.consumers) : [],
      runtimes: c ? [...c.runtimes].sort() : [],
      accessPatterns: c ? [...c.patterns].sort() : [],
      declaredIn: declared[n] ? [...declared[n]].sort() : [],
    };
  }
  return matrix;
}

// ── Workflows ───────────────────────────────────────────────────────────────

/** Minimal GitHub Actions YAML facts without a YAML library. */
export function parseWorkflow(text, file) {
  const lines = text.split("\n");
  const name = /^name:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null;
  const triggers = [];
  const jobs = {};
  let section = null;
  let currentJob = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line) && !line.startsWith("#")) {
      section = /^([a-zA-Z_-]+):/.exec(line)?.[1] ?? null;
      currentJob = null;
      if (section === "on" && /^on:\s*\[(.*)\]/.test(line)) {
        triggers.push(
          ...line
            .replace(/^on:\s*\[|\]\s*$/g, "")
            .split(",")
            .map((s) => s.trim()),
        );
      }
      continue;
    }
    if (section === "on") {
      const m = /^  ([a-z_]+):/.exec(line);
      if (m) triggers.push(m[1]);
      const b = /^\s+branches:\s*\[(.*)\]/.exec(line);
      if (b) triggers.push(`branches=[${b[1].replace(/\s/g, "")}]`);
    }
    if (section === "jobs") {
      const j = /^  ([a-zA-Z0-9_-]+):\s*$/.exec(line);
      if (j) {
        currentJob = j[1];
        jobs[currentJob] = {
          line: i + 1,
          runsOn: null,
          needs: [],
          uses: [],
          scriptRefs: [],
          ifCondition: null,
          timeoutMinutes: null,
        };
        continue;
      }
      if (!currentJob) continue;
      const job = jobs[currentJob];
      const r = /^    runs-on:\s*(.+)$/.exec(line);
      if (r) job.runsOn = r[1].trim();
      const n = /^    needs:\s*(.+)$/.exec(line);
      if (n)
        job.needs = n[1]
          .replace(/[[\]\s]/g, "")
          .split(",")
          .filter(Boolean);
      const ifm = /^    if:\s*(.+)$/.exec(line);
      if (ifm) job.ifCondition = ifm[1].trim();
      const t = /^    timeout-minutes:\s*(\d+)/.exec(line);
      if (t) job.timeoutMinutes = Number(t[1]);
      const u = /^\s+-?\s*uses:\s*(\S+)/.exec(line);
      if (u) job.uses.push(u[1]);
      for (const s of line.matchAll(
        /\b((?:scripts|tools)\/[A-Za-z0-9_./-]+\.(?:sh|mjs|py|js))\b/g,
      )) {
        job.scriptRefs.push({ path: s[1], line: i + 1 });
      }
    }
  }
  const hasPermissions = /^permissions:/m.test(text);
  const permissions = hasPermissions
    ? (() => {
        const m = /^permissions:\s*\n((?:\s{2}[a-z-]+:\s*\S+\n?)+)/m.exec(text);
        return m
          ? m[1]
              .trim()
              .split("\n")
              .map((l) => l.trim())
          : ["(inline)"];
      })()
    : null;
  const concurrency = /^concurrency:\s*\n\s+group:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null;
  const cancelInProgress = /cancel-in-progress:\s*(true|false)/.exec(text)?.[1] ?? null;
  const selfHosted = Object.values(jobs).some((j) => /self-hosted/.test(j.runsOn ?? ""));
  const inlineRunLines = (() => {
    let n = 0;
    let inRun = false;
    for (const l of lines) {
      if (/^\s+(?:-\s+)?run:\s*[|>]/.test(l)) {
        inRun = true;
        continue;
      }
      if (inRun) {
        if (/^\s{6,}\S/.test(l)) n++;
        else inRun = false;
      }
      if (/^\s+(?:-\s+)?run:\s*[^\s|>]/.test(l)) n++;
    }
    return n;
  })();
  return {
    file,
    name,
    triggers: sortedUnique(triggers),
    permissions,
    concurrencyGroup: concurrency,
    cancelInProgress,
    selfHosted,
    jobs,
    inlineRunLines,
  };
}

export function extractWorkflows(repoRoot) {
  const out = {};
  for (const wf of walk(repoRoot, ".github/workflows", { exts: [".yml", ".yaml"] })) {
    const parsed = parseWorkflow(readText(path.join(repoRoot, wf)), wf);
    for (const job of Object.values(parsed.jobs)) {
      for (const ref of job.scriptRefs) ref.exists = exists(path.join(repoRoot, ref.path));
    }
    out[wf] = parsed;
  }
  return out;
}

// ── Scripts (shell entry points) ────────────────────────────────────────────

export function extractScripts(repoRoot) {
  const out = {};
  const files = [
    ...walk(repoRoot, "scripts", { exts: [".sh"] }),
    ...walk(repoRoot, "tools/macos-ci", { exts: [".sh", ".py"] }),
    ...walk(repoRoot, "supabase/tests", { exts: [".sh"] }),
    ...walk(repoRoot, "tools/devin", { exts: [".sh"] }),
  ];
  for (const f of files) {
    const text = readText(path.join(repoRoot, f));
    const refs = [];
    for (const m of text.matchAll(
      /\b((?:scripts|tools|supabase|ml|apps|packages|native|infra)\/[A-Za-z0-9_./-]+\.(?:sh|mjs|py|js|ts|sql|json|yml))\b/g,
    )) {
      if (m[1] === f) continue;
      refs.push({
        path: m[1],
        line: lineOf(text, m.index),
        exists: exists(path.join(repoRoot, m[1])),
      });
    }
    const stageArrays = {};
    for (const m of text.matchAll(/^(ALL_STAGES|PR_STAGES)=\((.*)\)/gm))
      stageArrays[m[1]] = m[2].split(/\s+/).filter(Boolean);
    const stageFns = [...text.matchAll(/^stage_([a-z0-9_]+)\(\)/gm)].map((m) => m[1]);
    // `|| true` is classified by what it suppresses. Failure-masking = the
    // suppressed command is a verdict-bearing tool (test runner, compiler,
    // linter, migration, secret scan). Everything else (cleanup, teardown,
    // best-effort diagnostics, `{ grep … || true; }` output filters, captures
    // whose emptiness is asserted afterwards) is recorded, not failed.
    const orTrue = [];
    const orTrueBenign = [];
    const GATE_CMD_RE =
      /\b(xcodebuild|swift\s+(?:build|test)|pnpm|npm\s+(?:test|run|ci)|npx|deno\s+(?:test|check|task)|python3?|pytest|jest|tsc|psql|eslint|prettier|gitleaks|migrate|verify-[a-z]+\.sh|run_rls_tests|security-scan)\b/;
    for (const m of text.matchAll(/\|\|\s*true\b/g)) {
      const line = lineOf(text, m.index);
      const lineText = text.split("\n")[line - 1] ?? "";
      if (/^\s*#/.test(lineText)) continue;
      if (/\{\s*grep\b[^}]*\|\|\s*true;\s*\}/.test(lineText)) orTrueBenign.push(line);
      else if (/--version|\bcommand -v\b/.test(lineText)) orTrueBenign.push(line);
      // VAR="$(cmd || true)" whose emptiness is asserted afterwards ([ -n "$VAR" ] || die).
      else if (
        /^\s*(?:local\s+)?([A-Za-z_][A-Za-z0-9_]*)="?\$\((?:[^)]*)\|\|\s*true\)/.test(lineText) &&
        new RegExp(
          `\\[\\s+-[nz]\\s+"\\$${/^\s*(?:local\s+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(lineText)[1]}"`,
        ).test(text.slice(m.index))
      )
        orTrueBenign.push(line);
      else if (GATE_CMD_RE.test(lineText.slice(0, lineText.indexOf("||")))) orTrue.push(line);
      else orTrueBenign.push(line);
    }
    const artifactRoots = sortedUnique(
      [...text.matchAll(/\b(artifacts\/[A-Za-z0-9_./$-]+|macos-ci-artifacts)/g)].map((m) => m[1]),
    );
    out[f] = {
      loc: countLines(text),
      language: f.endsWith(".py") ? "python" : "shell",
      errexit: /^set -[a-z]*e[a-z]*\b|set -o errexit/m.test(text),
      nounset: /^set -[a-z]*u[a-z]*\b|set -o nounset/m.test(text),
      usesPipefail: /pipefail/.test(text),
      references: dedupeRefs(refs),
      stageArrays,
      stageFunctions: stageFns,
      orTrueLines: orTrue,
      orTrueBenignLines: orTrueBenign,
      artifactRoots,
    };
  }
  return out;
}

function dedupeRefs(refs) {
  const seen = new Map();
  for (const r of refs) if (!seen.has(r.path)) seen.set(r.path, r);
  return [...seen.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

// ── Migrations ──────────────────────────────────────────────────────────────

export function extractMigrations(repoRoot) {
  const supabase = walk(repoRoot, "supabase/migrations", { exts: [".sql"] }).map((f) =>
    path.posix.basename(f),
  );
  const legacy = walk(repoRoot, "packages/database/migrations", { exts: [".sql"] }).map((f) =>
    path.posix.basename(f),
  );
  const badNames = supabase.filter((n) => !/^\d{14}_[a-z0-9_]+\.sql$/.test(n));
  const stamps = supabase.map((n) => n.slice(0, 14));
  const duplicateStamps = sortedUnique(stamps.filter((s, i) => stamps.indexOf(s) !== i));
  const rpcNames = new Set();
  const tables = new Set();
  const triggers = new Set();
  const cronJobs = [];
  for (const f of walk(repoRoot, "supabase/migrations", { exts: [".sql"] })) {
    const text = readText(path.join(repoRoot, f));
    for (const m of text.matchAll(
      /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z_0-9]+)\s*\(/gi,
    ))
      rpcNames.add(m[1]);
    for (const m of text.matchAll(
      /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_0-9]+)/gi,
    ))
      tables.add(m[1]);
    for (const m of text.matchAll(/create\s+(?:or\s+replace\s+)?trigger\s+([a-z_0-9]+)/gi))
      triggers.add(m[1]);
    for (const m of text.matchAll(/cron\.schedule\(\s*'([^']+)'/gi))
      cronJobs.push({ name: m[1], file: f });
  }
  return {
    supabase: { dir: "supabase/migrations", files: supabase, badNames, duplicateStamps },
    legacyNodeDatabase: { dir: "packages/database/migrations", files: legacy },
    schemaSurface: {
      tables: [...tables].sort(),
      functions: [...rpcNames].sort(),
      triggers: [...triggers].sort(),
      cronJobs: cronJobs.sort((a, b) => (a.name < b.name ? -1 : 1)),
    },
  };
}

// ── Datasets and artifacts ──────────────────────────────────────────────────

export function extractDatasets(repoRoot) {
  const root = "datasets";
  const dirs = {};
  if (isDir(path.join(repoRoot, root))) {
    for (const top of readdirSorted(path.join(repoRoot, root))) {
      const rel = `${root}/${top}`;
      if (!isDir(path.join(repoRoot, rel))) {
        dirs[rel] = {
          files: 1,
          bytes: fsSync.statSync(path.join(repoRoot, rel)).size,
          kind: "file",
        };
        continue;
      }
      const files = walk(repoRoot, rel, {});
      let bytes = 0;
      const byExt = {};
      for (const f of files) {
        bytes += fsSync.statSync(path.join(repoRoot, f)).size;
        const ext = path.extname(f) || "(none)";
        byExt[ext] = (byExt[ext] ?? 0) + 1;
      }
      dirs[rel] = { files: files.length, bytes, byExt: sortByKey(byExt), kind: "dir" };
    }
  }
  // Which code/scripts reference each dataset dir?
  const refRoots = [
    "packages",
    "services",
    "apps/mobile/src",
    "scripts",
    "tools",
    "ml/scripts",
    "supabase",
    ".github/workflows",
  ];
  const references = {};
  for (const r of refRoots) {
    for (const f of walk(repoRoot, r, {
      exts: [...CODE_EXTS, ".py", ".sh", ".yml", ".json"],
      ignoreDirs: ["ios", "android", "results"],
    })) {
      if (f.endsWith("package-lock.json") || f.endsWith("pnpm-lock.yaml")) continue;
      const text = readText(path.join(repoRoot, f));
      for (const m of text.matchAll(/\bdatasets\/([A-Za-z0-9_.-]+)/g)) {
        const key = `datasets/${m[1]}`;
        (references[key] ??= new Set()).add(f);
      }
    }
  }
  const refOut = {};
  for (const k of Object.keys(references).sort()) refOut[k] = [...references[k]].sort();
  const protectedFiles = [
    "datasets/reports/regression/baseline.json",
    "packages/evaluation/regression.tolerances.json",
  ];
  const tolerances = walk(repoRoot, "packages", { exts: [".json"] }).filter((f) =>
    /tolerances/.test(f),
  );
  return {
    dirs: sortByKey(dirs),
    references: refOut,
    protectedFiles: protectedFiles.map((f) => ({
      path: f,
      exists: exists(path.join(repoRoot, f)),
    })),
    toleranceFiles: tolerances,
  };
}

/** True when git would ignore `rel` (a hypothetical file path). Falls back to false when git is unavailable. */
export function isGitIgnored(repoRoot, rel) {
  const r = spawnSync("git", ["-C", repoRoot, "check-ignore", "-q", "--", rel], {
    encoding: "utf8",
  });
  return r.status === 0;
}

function artifactRootWriters(repoRoot, root) {
  const out = [];
  const files = [
    ...walk(repoRoot, "scripts", { exts: [".sh"] }),
    ...walk(repoRoot, ".github/workflows", { exts: [".yml", ".yaml"] }),
  ];
  // `:-` admits shell defaults like `${MAC_ARTIFACTS:-macos-ci-artifacts}`;
  // a bare `-` is excluded so `artifacts` does not match `macos-ci-artifacts`.
  const re = new RegExp(`(^|[^A-Za-z0-9_./-]|:-)${root.replaceAll("/", "\\/")}(/|\\b)`);
  for (const f of files) {
    const text = readText(path.join(repoRoot, f));
    const m = re.exec(text);
    if (m) out.push(`${f}:${lineOf(text, m.index)}`);
  }
  return out.sort();
}

export function extractArtifacts(repoRoot) {
  const manifestPath = "infra/release/release-manifest.json";
  const manifest = exists(path.join(repoRoot, manifestPath))
    ? readJson(path.join(repoRoot, manifestPath))
    : null;
  const referencedPaths = [];
  const visit = (v) => {
    if (typeof v === "string") {
      if (/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/.test(v) && /\//.test(v)) referencedPaths.push(v);
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  if (manifest) visit(manifest);
  return {
    releaseManifest: manifest
      ? {
          path: manifestPath,
          topLevelKeys: Object.keys(manifest).sort(),
          referencedRepoPaths: sortedUnique(referencedPaths).map((p) => ({
            path: p,
            exists: exists(path.join(repoRoot, p)),
          })),
        }
      : null,
    // Roots that verification scripts write into a checkout. Asked of git
    // itself (`git check-ignore`) so nested/negated rules are honoured.
    artifactRootsGitignored: Object.fromEntries(
      ["artifacts", "macos-ci-artifacts", "apps/mobile/artifacts"].map((root) => [
        root,
        {
          gitignored: isGitIgnored(repoRoot, `${root}/summary.json`),
          writtenBy: artifactRootWriters(repoRoot, root),
        },
      ]),
    ),
    checkedInArtifactDirs: [
      "tools/mac-bench/results",
      "tools/latency-bench/artifacts",
      "datasets/reports",
    ].map((d) => ({
      path: d,
      exists: isDir(path.join(repoRoot, d)),
    })),
  };
}

// ── Unverifiable-on-Linux surface ───────────────────────────────────────────

export function extractUnverifiable(repoRoot) {
  const groups = {
    "native/** (Swift)": walk(repoRoot, "native", { exts: [".swift"] }),
    "apps/mobile/ios (Swift/ObjC, excl. Pods/build)": walk(repoRoot, "apps/mobile/ios", {
      exts: [".swift", ".m", ".mm", ".h"],
    }),
    "apps/mobile/android (Kotlin/Java)": walk(repoRoot, "apps/mobile/android", {
      exts: [".kt", ".java"],
    }),
  };
  const out = {};
  for (const [k, files] of Object.entries(groups)) {
    let loc = 0;
    for (const f of files) {
      try {
        loc += countLines(readText(path.join(repoRoot, f)));
      } catch {
        // symlinked pod sources resolve to native/, counted there
      }
    }
    out[k] = { files: files.length, loc, sample: files.slice(0, 12) };
  }
  // Platform branches and skipped tests in TS.
  const platformBranches = [];
  const skippedTests = [];
  const conditionalSkips = [];
  for (const root of [
    "apps/mobile/src",
    "apps/mobile/__tests__",
    "packages",
    "services",
    "supabase/functions",
  ]) {
    for (const f of walk(repoRoot, root, { exts: TS_EXTS })) {
      const text = readText(path.join(repoRoot, f));
      for (const m of text.matchAll(/Platform\.OS\s*===\s*['"](ios|android)['"]/g)) {
        platformBranches.push({ where: `${f}:${lineOf(text, m.index)}`, os: m[1] });
      }
      for (const m of text.matchAll(/\b(describe|it|test)\.skip\(|\bx(it|describe|test)\(/g)) {
        skippedTests.push(`${f}:${lineOf(text, m.index)}`);
      }
      for (const c of conditionalSkipsIn(repoRoot, f, text)) conditionalSkips.push(c);
    }
  }
  const macStages = (() => {
    const p = path.join(repoRoot, "scripts/mac-full-verify.sh");
    if (!exists(p)) return [];
    const m = /^ALL_STAGES=\((.*)\)/m.exec(readText(p));
    return m ? m[1].split(/\s+/).filter(Boolean) : [];
  })();
  return {
    surfaces: out,
    platformBranches: {
      count: platformBranches.length,
      byOs: countBy(platformBranches, (b) => b.os),
      sample: platformBranches.slice(0, 20),
    },
    skippedTests: skippedTests.sort(),
    conditionalSkips: conditionalSkips.sort((a, b) =>
      a.where < b.where ? -1 : a.where > b.where ? 1 : 0,
    ),
    macOnlyStages: macStages,
  };
}

/**
 * Test suites that skip themselves when a precondition is absent:
 *   describe.skipIf(!hasFfmpeg)(...)          (vitest)
 *   const d = cond ? describe : describe.skip  (jest alias)
 *   Deno.test({ ignore: <expr> })             (deno)
 * For each, classify the guard: `env` (reads process.env / Deno.env), `fs`
 * (existsSync on a path), `command` (spawn/which probe), `other`. An `fs`
 * guard whose `join(__dirname, ...)` target is not tracked by git can never
 * run in a clean checkout — that is reported separately as `fsGatedUntracked`.
 */
export function conditionalSkipsIn(repoRoot, rel, text) {
  const out = [];
  const patterns = [
    { re: /\b(?:describe|it|test)\.skipIf\(/g, kind: "skipIf" },
    {
      re: /\b([A-Za-z_$][\w$]*)\s*\?\s*(?:describe|it|test)\s*:\s*(?:describe|it|test)\.skip\b/g,
      kind: "alias",
    },
    { re: /\bignore:\s*([^,}\n]+)/g, kind: "denoIgnore" },
  ];
  for (const { re, kind } of patterns) {
    for (const m of text.matchAll(re)) {
      if (kind === "denoIgnore" && !/Deno\.test/.test(text)) continue;
      const lineStart = text.lastIndexOf("\n", m.index) + 1;
      if (/^\s*(\/\/|\*|\/\*)/.test(text.slice(lineStart, m.index))) continue; // inside a comment
      const guardExpr = (
        kind === "skipIf" ? balancedArg(text, m.index + m[0].length) : m[1]
      ).trim();
      const idents = [...guardExpr.matchAll(/[A-Za-z_$][\w$]*/g)].map((x) => x[0]);
      // Resolve the guard identifiers to their definitions (one level).
      const defs = idents
        .map(
          (id) =>
            new RegExp(`(?:const|let|var)\\s+${id.replace(/\$/g, "\\$")}\\s*=\\s*([^;]+);`).exec(
              text,
            )?.[1] ?? "",
        )
        .join(" ");
      const scope = `${guardExpr} ${defs}`;
      const guard = /process\.env|Deno\.env/.test(scope)
        ? "env"
        : /existsSync|statSync|readFileSync/.test(scope)
          ? "fs"
          : /spawnSync|execSync|which|commandExists|docker|ffmpeg|ffprobe/i.test(scope)
            ? "command"
            : "other";
      const entry = { where: `${rel}:${lineOf(text, m.index)}`, kind, guard, guardExpr };
      if (guard === "fs") {
        const candidates = new Set();
        for (const j of text.matchAll(/join\(\s*__dirname\s*,([^)]*)\)/g)) {
          const segs = [...j[1].matchAll(/['"]([^'"]+)['"]/g)].map((s) => s[1]);
          if (segs.length === 0) continue;
          candidates.add(
            path.relative(repoRoot, path.resolve(repoRoot, path.dirname(rel), ...segs)),
          );
        }
        // Repo-relative literals ("datasets/paddle-bench/runs") joined onto a repo root.
        for (const s of text.matchAll(
          /['"]((?:datasets|artifacts|tools|packages|apps|services|native|ml|supabase|infra)\/[\w./-]+)['"]/g,
        )) {
          candidates.add(s[1]);
        }
        const untracked = [];
        for (const target of [...candidates].sort()) {
          if (target.startsWith("..")) continue;
          const tracked =
            spawnSync("git", ["-C", repoRoot, "ls-files", "--error-unmatch", "--", target], {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "ignore"],
            }).status === 0;
          if (!tracked)
            untracked.push({ path: target, gitignored: isGitIgnored(repoRoot, `${target}/x`) });
        }
        if (untracked.length) entry.fsGatedUntracked = untracked;
      }
      out.push(entry);
    }
  }
  return out;
}

/** Text of the argument list starting right after an opening paren at `from`. */
function balancedArg(text, from) {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return text.slice(from, i);
  }
  return text.slice(from);
}

function countBy(arr, fn) {
  const out = {};
  for (const x of arr) {
    const k = fn(x);
    out[k] = (out[k] ?? 0) + 1;
  }
  return sortByKey(out);
}

// ── Feature flags ───────────────────────────────────────────────────────────

export function extractFeatureFlags(repoRoot) {
  const registryFile = "services/api/src/modules/flags/registry.ts";
  const seedFile = "packages/database/src/seed.ts";
  const flags = [];
  if (exists(path.join(repoRoot, registryFile))) {
    const text = readText(path.join(repoRoot, registryFile));
    for (const m of text.matchAll(
      /flag\(\s*"([a-z0-9_]+)",\s*"([^"]*)",\s*(true|false),\s*(true|false)\s*\)/g,
    )) {
      flags.push({
        key: m[1],
        description: m[2],
        safeDefaultEnabled: m[3] === "true",
        killSwitch: m[4] === "true",
        where: `${registryFile}:${lineOf(text, m.index)}`,
      });
    }
  }
  const seedKeys = [];
  if (exists(path.join(repoRoot, seedFile))) {
    const text = readText(path.join(repoRoot, seedFile));
    const block = /SEEDED_FEATURE_FLAGS[^=]*=\s*\[([\s\S]*?)\n\s*\];/.exec(text);
    if (block) for (const m of block[1].matchAll(/\[\s*"([a-z0-9_]+)"\s*,/g)) seedKeys.push(m[1]);
  }
  // Who serves and who reads flags?
  const servedBy = [];
  for (const f of walk(repoRoot, "services/api/src", { exts: [".ts"] })) {
    const text = readText(path.join(repoRoot, f));
    for (const m of text.matchAll(/["'](\/v1\/flags[^"']*)["']/g))
      servedBy.push(`${f}:${lineOf(text, m.index)} ${m[1]}`);
  }
  const edgeServes = [];
  for (const f of walk(repoRoot, "supabase/functions/api", {
    exts: [".ts"],
    ignoreDirs: ["__wf__"],
  })) {
    const text = readText(path.join(repoRoot, f));
    for (const m of text.matchAll(/["'](\/v1\/flags[^"']*)["']/g))
      edgeServes.push(`${f}:${lineOf(text, m.index)} ${m[1]}`);
  }
  const mobileReads = [];
  for (const f of walk(repoRoot, "apps/mobile/src", { exts: TS_EXTS })) {
    const text = readText(path.join(repoRoot, f));
    for (const m of text.matchAll(/\/v1\/flags|feature_flags|featureFlags/g))
      mobileReads.push(`${f}:${lineOf(text, m.index)}`);
    for (const flag of flags) {
      const re = new RegExp(`["'\`]${flag.key}["'\`]`, "g");
      for (const m of text.matchAll(re))
        (flag.mobileLiteralRefs ??= []).push(`${f}:${lineOf(text, m.index)}`);
    }
  }
  const killSwitchEnv = flags
    .filter((f) => f.killSwitch)
    .map((f) => `FLAG_KILL_${f.key.toUpperCase()}`);
  return {
    registryFile,
    seedFile,
    flags,
    seedKeys: sortedUnique(seedKeys),
    killSwitchEnvVars: killSwitchEnv,
    servedByLegacyApi: sortedUnique(servedBy),
    servedByEdgeFunction: sortedUnique(edgeServes),
    mobileReads: sortedUnique(mobileReads),
  };
}

// ── React Native bridge matrix (JS name ↔ iOS export ↔ Android export) ─────

export function extractNativeBridges(repoRoot) {
  const js = {};
  for (const f of walk(repoRoot, "apps/mobile/src", { exts: TS_EXTS })) {
    const text = readText(path.join(repoRoot, f));
    const add = (name, idx) => (js[name] ??= []).push(`${f}:${lineOf(text, idx)}`);
    for (const m of text.matchAll(/NativeModules\s+as\s+\{\s*([A-Za-z0-9_]+)/g)) add(m[1], m.index);
    for (const m of text.matchAll(/NativeModules\.([A-Za-z0-9_]+)/g)) add(m[1], m.index);
    for (const m of text.matchAll(
      /requireNativeComponent(?:<[^>]*>)?\(\s*['"]([A-Za-z0-9_]+)['"]/g,
    ))
      add(m[1], m.index);
    // requireNativeComponent(CONST) where `const CONST = 'PickleFooView'`.
    for (const m of text.matchAll(
      /requireNativeComponent(?:<[^>]*>)?\(\s*([A-Z_][A-Z0-9_]*)\s*\)/g,
    )) {
      const decl = new RegExp(`const\\s+${m[1]}\\s*=\\s*['"]([A-Za-z0-9_]+)['"]`).exec(text);
      if (decl) add(decl[1], m.index);
    }
  }
  const ios = {};
  for (const f of walk(repoRoot, "apps/mobile/ios/LocalPods", { exts: [".m", ".mm", ".swift"] })) {
    let text;
    try {
      text = readText(path.join(repoRoot, f));
    } catch {
      continue;
    }
    for (const m of text.matchAll(/RCT_EXTERN(?:_REMAP)?_MODULE\(\s*([A-Za-z0-9_]+)\s*,/g)) {
      (ios[m[1]] ??= []).push(`${f}:${lineOf(text, m.index)}`);
    }
  }
  const android = {};
  for (const f of walk(repoRoot, "apps/mobile/android/app/src/main", { exts: [".kt", ".java"] })) {
    const text = readText(path.join(repoRoot, f));
    for (const m of text.matchAll(/getName\(\)(?::\s*String)?\s*=\s*"([A-Za-z0-9_]+)"/g)) {
      (android[m[1]] ??= []).push(`${f}:${lineOf(text, m.index)}`);
    }
    for (const m of text.matchAll(/return\s+"([A-Za-z0-9_]+)"\s*;?\s*\/\/\s*getName/g)) {
      (android[m[1]] ??= []).push(`${f}:${lineOf(text, m.index)}`);
    }
  }
  const names = sortedUnique([...Object.keys(js), ...Object.keys(ios), ...Object.keys(android)]);
  const matrix = {};
  for (const n of names) {
    matrix[n] = {
      js: sortedUnique(js[n] ?? []),
      ios: sortedUnique(ios[n] ?? []),
      android: sortedUnique(android[n] ?? []),
    };
  }
  return matrix;
}

// ── ML tooling ──────────────────────────────────────────────────────────────

export function extractMl(repoRoot) {
  const scripts = walk(repoRoot, "ml/scripts", { exts: [".py"] });
  const tests = scripts.filter((f) => /\/test_[^/]+\.py$/.test(f));
  const thirdParty = new Set();
  const stdlib = new Set([
    "typing",
    "__future__",
    "pathlib",
    "json",
    "os",
    "sys",
    "argparse",
    "dataclasses",
    "math",
    "re",
    "collections",
    "unittest",
    "hashlib",
    "datetime",
    "subprocess",
    "random",
    "csv",
    "statistics",
    "itertools",
    "functools",
    "io",
    "shutil",
    "tempfile",
    "time",
    "enum",
    "copy",
    "glob",
    "logging",
    "struct",
    "textwrap",
    "string",
    "abc",
    "uuid",
    "contextlib",
    "operator",
    "heapq",
    "bisect",
    "fractions",
    "decimal",
    "concurrent",
    "multiprocessing",
    "threading",
    "queue",
    "signal",
    "platform",
    "traceback",
    "warnings",
    "zipfile",
    "tarfile",
    "gzip",
    "base64",
    "binascii",
    "urllib",
    "http",
    "socket",
    "ssl",
    "email",
    "html",
    "xml",
    "sqlite3",
    "pickle",
    "shlex",
    "pprint",
    "inspect",
    "types",
    "numbers",
  ]);
  for (const f of scripts) {
    const text = readText(path.join(repoRoot, f));
    for (const m of text.matchAll(/^(?:from|import)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm)) {
      const mod = m[1];
      if (!stdlib.has(mod) && !scripts.some((s) => path.posix.basename(s, ".py") === mod))
        thirdParty.add(mod);
    }
  }
  return {
    scripts,
    tests,
    thirdPartyImports: [...thirdParty].sort(),
    requirementsFiles: walk(repoRoot, "ml", { exts: [".txt", ".toml"], maxDepth: 2 }).filter((f) =>
      /requirements|pyproject/.test(f),
    ),
    manifests: walk(repoRoot, "ml/manifests", {}),
  };
}
