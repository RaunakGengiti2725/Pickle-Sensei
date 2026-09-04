// Audit probe helpers for tools/release/check-release-manifest.mjs.
//
// The checker resolves its inputs relative to its own location
// (tools/release/../..), so each probe copies the checker plus the four
// files it reads into a throwaway repo root, applies one mutation, and runs
// the copy. Nothing in the real repo is touched.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const CHECKER = "tools/release/check-release-manifest.mjs";
export const MANIFEST = "infra/release/release-manifest.json";
export const PBXPROJ = "apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj";
export const GRADLE = "apps/mobile/android/app/build.gradle";
export const RUNTIME_CONFIG = "apps/mobile/src/config/runtimeConfig.ts";

const FIXTURE_FILES = [CHECKER, MANIFEST, PBXPROJ, GRADLE, RUNTIME_CONFIG];

export function readRepoFile(relPath) {
  return readFileSync(join(repoRoot, relPath), "utf8");
}

export function readManifest() {
  return JSON.parse(readRepoFile(MANIFEST));
}

/**
 * Builds a fixture root, lets `mutate(root)` edit files inside it, runs the
 * copied checker, and returns { status, stdout, stderr }.
 */
export function runCheckerWith(mutate) {
  const root = mkdtempSync(join(tmpdir(), "release-audit-"));
  try {
    for (const rel of FIXTURE_FILES) {
      const dest = join(root, rel);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(join(repoRoot, rel), dest);
    }
    mutate(root);
    const result = spawnSync(process.execPath, [join(root, CHECKER)], {
      encoding: "utf8",
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function writeFixture(root, relPath, content) {
  const dest = join(root, relPath);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, content);
}

export function readFixture(root, relPath) {
  return readFileSync(join(root, relPath), "utf8");
}

export function writeManifest(root, manifest) {
  writeFixture(root, MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
}

/** Replaces the Nth (0-based) occurrence of `needle` in `text`. */
export function replaceNth(text, needle, replacement, n) {
  let index = -1;
  for (let i = 0; i <= n; i += 1) {
    index = text.indexOf(needle, index + 1);
    if (index === -1) throw new Error(`occurrence ${n} of ${JSON.stringify(needle)} not found`);
  }
  return text.slice(0, index) + replacement + text.slice(index + needle.length);
}
