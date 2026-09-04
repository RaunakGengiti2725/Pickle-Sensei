// Shared helpers for the static-health harness: workspace discovery and
// a tiny file walker that respects the repo's ignore conventions.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

export const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  "artifacts",
  "macos-ci-artifacts",
  ".expo",
  "Pods",
  "DerivedData",
  "__pycache__",
  ".venv",
  "venv",
  ".pnpm-store",
]);

export function* walk(dir, { extensions, skipDirs = IGNORED_DIRS } = {}) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      yield* walk(full, { extensions, skipDirs });
    } else if (entry.isFile()) {
      if (!extensions || extensions.has(path.extname(entry.name))) yield full;
    }
  }
}

export function rel(p) {
  return path.relative(REPO_ROOT, p).split(path.sep).join("/");
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// pnpm-workspace.yaml is a flat list of globs; the only glob shape used is
// `<dir>/*` or a literal path, with `!` for exclusions. apps/mobile is
// npm-managed and excluded from the pnpm workspace but still CONSUMES
// @pickle/* via tsconfig/metro/jest aliases, so it is added as a consumer.
export function loadWorkspacePackages() {
  const yaml = fs.readFileSync(path.join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8");
  const includes = [];
  const excludes = [];
  for (const raw of yaml.split("\n")) {
    const m = raw.match(/^\s*-\s*"?([^"#]+?)"?\s*(#.*)?$/);
    if (!m) continue;
    const pattern = m[1].trim();
    if (pattern.startsWith("!")) excludes.push(pattern.slice(1));
    else includes.push(pattern);
  }
  const dirs = new Set();
  for (const pattern of includes) {
    if (pattern.endsWith("/*")) {
      const parent = path.join(REPO_ROOT, pattern.slice(0, -2));
      if (!fs.existsSync(parent)) continue;
      for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.add(path.join(parent, entry.name));
      }
    } else {
      dirs.add(path.join(REPO_ROOT, pattern));
    }
  }
  for (const ex of excludes) dirs.delete(path.join(REPO_ROOT, ex));

  const packages = [];
  for (const dir of [...dirs].sort()) {
    const pkgPath = path.join(dir, "package.json");
    if (!fs.existsSync(pkgPath)) continue;
    const pkg = readJson(pkgPath);
    packages.push(describePackage(dir, pkg, "pnpm-workspace"));
  }
  const mobileDir = path.join(REPO_ROOT, "apps", "mobile");
  if (fs.existsSync(path.join(mobileDir, "package.json"))) {
    packages.push(
      describePackage(
        mobileDir,
        readJson(path.join(mobileDir, "package.json")),
        "npm (apps/mobile)",
      ),
    );
  }
  return packages;
}

function describePackage(dir, pkg, manager) {
  const pick = (obj) => Object.entries(obj ?? {}).map(([name, spec]) => ({ name, spec }));
  return {
    name: pkg.name,
    dir,
    relDir: rel(dir),
    manager,
    private: pkg.private === true,
    scripts: pkg.scripts ?? {},
    dependencies: pick(pkg.dependencies),
    devDependencies: pick(pkg.devDependencies),
    peerDependencies: pick(pkg.peerDependencies),
    optionalDependencies: pick(pkg.optionalDependencies),
  };
}

export const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
