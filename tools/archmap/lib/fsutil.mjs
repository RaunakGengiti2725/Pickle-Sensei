// Small filesystem helpers shared by the archmap extractors. No dependencies.
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  ".build",
  "build",
  "Pods",
  "DerivedData",
  ".venv",
  ".venv-pose",
  "__pycache__",
  ".turbo",
  "artifacts",
  "macos-ci-artifacts",
]);

export function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function readText(p) {
  return fs.readFileSync(p, "utf8");
}

export function readJson(p) {
  return JSON.parse(readText(p));
}

export function toPosix(p) {
  return p.split(path.sep).join("/");
}

/**
 * Recursively list files under `root` (absolute), returning repo-relative POSIX
 * paths. `opts.exts` filters by extension (with dot); `opts.ignoreDirs`
 * extends the default ignore set; `opts.maxDepth` bounds recursion.
 * Results are sorted for determinism.
 */
export function walk(repoRoot, rel, opts = {}) {
  const exts = opts.exts ? new Set(opts.exts) : null;
  const ignore = new Set([...DEFAULT_IGNORED_DIRS, ...(opts.ignoreDirs ?? [])]);
  const maxDepth = opts.maxDepth ?? Infinity;
  const out = [];
  const start = path.join(repoRoot, rel);
  if (!isDir(start)) return out;
  const visit = (dirAbs, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const abs = path.join(dirAbs, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (ignore.has(e.name)) continue;
        if (depth + 1 > maxDepth) continue;
        visit(abs, depth + 1);
      } else if (e.isFile()) {
        if (exts && !exts.has(path.extname(e.name))) continue;
        out.push(toPosix(path.relative(repoRoot, abs)));
      }
    }
  };
  visit(start, 0);
  return out;
}

export function countLines(text) {
  if (text.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith("\n") ? n : n + 1;
}

/** Line number (1-based) of a character offset within `text`. */
export function lineOf(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export function sortedUnique(arr) {
  return [...new Set(arr)].sort();
}

export function sortByKey(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}
