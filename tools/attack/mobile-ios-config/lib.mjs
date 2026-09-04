/**
 * Shared helpers for the mobile-ios-config mutation harness.
 *
 * Everything here is deliberately dependency-free (node:* only) so it runs in
 * a bare checkout without a workspace install.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export function git(args, cwd = REPO_ROOT) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Deterministic PRNG (mulberry32) so "random" mutations are replayable. */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Creates a detached worktree of `sha` at `dir` and symlinks every installed
 * node_modules directory from the source checkout into it (depth <= 3) so
 * jest / node scripts resolve dependencies without a fresh install.
 */
export function createWorktree(sha, dir) {
  mkdirSync(dirname(dir), { recursive: true });
  git(["worktree", "add", "--quiet", "--detach", dir, sha]);
  for (const nm of findNodeModules(REPO_ROOT, 3)) {
    const rel = relative(REPO_ROOT, nm);
    const target = join(dir, rel);
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(nm, target, "dir");
  }
}

export function removeWorktree(dir) {
  if (!existsSync(dir)) return;
  git(["worktree", "remove", "--force", dir]);
}

function findNodeModules(root, depth, out = []) {
  if (depth < 0) return out;
  for (const entry of readdirSync(root)) {
    if (entry.startsWith(".")) continue;
    const full = join(root, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    if (entry === "node_modules") {
      out.push(full);
      continue;
    }
    findNodeModules(full, depth - 1, out);
  }
  return out;
}

export function readText(root, rel) {
  return readFileSync(join(root, rel), "utf8");
}

export function writeText(root, rel, text) {
  writeFileSync(join(root, rel), text);
}

/** Exact single-occurrence replacement; throws if the anchor is absent or
 * ambiguous so a mutation can never silently become a no-op. */
export function replaceOnce(text, from, to) {
  const first = text.indexOf(from);
  if (first < 0) throw new Error(`anchor not found: ${JSON.stringify(from)}`);
  if (text.indexOf(from, first + from.length) >= 0) {
    throw new Error(`anchor is ambiguous: ${JSON.stringify(from)}`);
  }
  return text.slice(0, first) + to + text.slice(first + from.length);
}

export function replaceAll(text, from, to) {
  if (!text.includes(from)) {
    throw new Error(`anchor not found: ${JSON.stringify(from)}`);
  }
  return text.split(from).join(to);
}

/**
 * Applies `edit` to the buildSettings of ONE target-level build configuration
 * (Debug or Release) of the PickleSensei app target in project.pbxproj. The
 * target-level configs are the ones that reference the CocoaPods xcconfig.
 */
export function editTargetConfig(pbxproj, configuration, edit) {
  const lower = configuration.toLowerCase();
  const pattern = new RegExp(
    `(Pods-PickleSensei\\.${lower}\\.xcconfig \\*/;\\s*buildSettings = \\{)([\\s\\S]*?)(\\};\\s*name = ${configuration};)`,
  );
  const match = pattern.exec(pbxproj);
  if (!match) throw new Error(`target-level ${configuration} config not found`);
  const edited = edit(match[2]);
  if (edited === match[2]) {
    throw new Error(`edit for ${configuration} config changed nothing`);
  }
  return (
    pbxproj.slice(0, match.index) +
    match[1] +
    edited +
    match[3] +
    pbxproj.slice(match.index + match[0].length)
  );
}

/** Runs a command, never throws; returns exit code + combined output. */
export function run(cmd, args, cwd, env = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "1", FORCE_COLOR: "0", ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return {
    command: [cmd, ...args].join(" "),
    cwd,
    exitCode: result.status ?? (result.error ? 127 : 1),
    output,
    error: result.error ? String(result.error) : null,
  };
}
