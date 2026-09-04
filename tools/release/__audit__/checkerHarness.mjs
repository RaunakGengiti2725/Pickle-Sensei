// Audit harness: runs tools/release/check-release-manifest.mjs against a
// throwaway copy of the files it reads, after an optional mutation. The real
// repo is never modified. Returns the checker's exit status and output so a
// test can assert "this mutation MUST make the checker FAIL".
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export const CHECKER = "tools/release/check-release-manifest.mjs";
export const MANIFEST = "infra/release/release-manifest.json";
export const PBXPROJ = "apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj";
export const GRADLE = "apps/mobile/android/app/build.gradle";
export const RUNTIME_CONFIG = "apps/mobile/src/config/runtimeConfig.ts";

const INPUTS = [CHECKER, MANIFEST, PBXPROJ, GRADLE, RUNTIME_CONFIG];

export function readRepo(rel) {
  return readFileSync(join(repoRoot, rel), "utf8");
}

export function readManifest() {
  return JSON.parse(readRepo(MANIFEST));
}

/**
 * @param {(fs: {read(rel:string):string, write(rel:string, content:string):void, remove(rel:string):void, writeManifest(obj:unknown):void}) => void} mutate
 */
export function runChecker(mutate = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "release-audit-"));
  try {
    for (const rel of INPUTS) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      cpSync(join(repoRoot, rel), join(dir, rel));
    }
    mutate({
      read: (rel) => readFileSync(join(dir, rel), "utf8"),
      write: (rel, content) => writeFileSync(join(dir, rel), content),
      remove: (rel) => rmSync(join(dir, rel), { force: true }),
      writeManifest: (obj) => writeFileSync(join(dir, MANIFEST), JSON.stringify(obj, null, 2)),
    });
    const res = spawnSync(process.execPath, [join(dir, CHECKER)], { encoding: "utf8" });
    return {
      status: res.status,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      failLines: (res.stdout ?? "").split("\n").filter((l) => l.startsWith("FAIL")),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Replace only the n-th (0-based) occurrence of `needle` in `text`. */
export function replaceNth(text, needle, replacement, n) {
  let idx = -1;
  for (let i = 0; i <= n; i += 1) {
    idx = text.indexOf(needle, idx + 1);
    if (idx === -1) throw new Error(`occurrence ${n} of ${JSON.stringify(needle)} not found`);
  }
  return text.slice(0, idx) + replacement + text.slice(idx + needle.length);
}

export function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}
