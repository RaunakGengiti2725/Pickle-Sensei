// Sandbox helpers for the release-config-docs adversarial pass (pass 3).
//
// The checker (tools/release/check-release-manifest.mjs) resolves the repo root
// from its own location, so every probe copies the checker plus the exact five
// files it reads into a throwaway directory, mutates the COPY, and runs the
// copied checker. Production files are never touched.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const CHECKER = "tools/release/check-release-manifest.mjs";
export const MANIFEST = "infra/release/release-manifest.json";
export const PBXPROJ = "apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj";
export const GRADLE = "apps/mobile/android/app/build.gradle";
export const RUNTIME_CONFIG = "apps/mobile/src/config/runtimeConfig.ts";
export const XCPRIVACY = "apps/mobile/ios/PickleSensei/PrivacyInfo.xcprivacy";

const CHECKER_INPUTS = [CHECKER, MANIFEST, PBXPROJ, GRADLE, RUNTIME_CONFIG];

export function readRepo(rel) {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

export function readManifest() {
  return JSON.parse(readRepo(MANIFEST));
}

/** Copy the checker and its inputs into a fresh temp tree; returns its root. */
export function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), "attack-release-config-"));
  for (const rel of CHECKER_INPUTS) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    cpSync(join(REPO_ROOT, rel), join(root, rel));
  }
  return root;
}

export function writeSandbox(root, rel, content) {
  writeFileSync(join(root, rel), content);
}

export function readSandbox(root, rel) {
  return readFileSync(join(root, rel), "utf8");
}

/** Mutate the sandbox manifest via `mutate(manifestObject) -> void|object`. */
export function mutateManifest(root, mutate) {
  const manifest = JSON.parse(readSandbox(root, MANIFEST));
  const replaced = mutate(manifest);
  const next = replaced === undefined ? manifest : replaced;
  writeSandbox(root, MANIFEST, typeof next === "string" ? next : JSON.stringify(next, null, 2));
}

/** Run the sandboxed checker. Never throws; returns exit code + parsed output. */
export function runChecker(root) {
  const proc = spawnSync(process.execPath, [join(root, CHECKER)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  const stdout = proc.stdout ?? "";
  const stderr = proc.stderr ?? "";
  const lines = stdout.split("\n");
  return {
    code: proc.status,
    signal: proc.signal,
    stdout,
    stderr,
    okLines: lines.filter((l) => l.startsWith("ok")),
    failLines: lines.filter((l) => l.startsWith("FAIL")),
    crashed: /TypeError|SyntaxError|RangeError|ReferenceError/.test(stderr),
  };
}

export function destroySandbox(root) {
  rmSync(root, { recursive: true, force: true });
}

/** Run mutate+checker in a throwaway sandbox and clean up. */
export function attack(mutateFiles) {
  const root = makeSandbox();
  try {
    mutateFiles(root);
    return runChecker(root);
  } finally {
    destroySandbox(root);
  }
}

/** Deterministic PRNG (mulberry32) so fuzz cases are reproducible from a seed. */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
