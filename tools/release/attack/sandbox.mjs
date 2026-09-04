/**
 * Sandbox runner for the release-config checkers.
 *
 * Copies the exact set of committed files that `tools/release/check-release-manifest.mjs`
 * (`pnpm release:check`) and `apps/mobile/scripts/check-ios-distribution.mjs`
 * (`npm run check:distribution`) read into a throwaway directory, applies a mutation,
 * and runs both checkers there. The real repo is never modified.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const FILES = {
  manifest: "infra/release/release-manifest.json",
  releaseChecker: "tools/release/check-release-manifest.mjs",
  distributionChecker: "apps/mobile/scripts/check-ios-distribution.mjs",
  pbxproj: "apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj",
  gradle: "apps/mobile/android/app/build.gradle",
  runtimeConfig: "apps/mobile/src/config/runtimeConfig.ts",
  infoPlist: "apps/mobile/ios/PickleSensei/Info.plist",
  privacy: "apps/mobile/ios/PickleSensei/PrivacyInfo.xcprivacy",
  entitlements: "apps/mobile/ios/PickleSensei/PickleSensei.entitlements",
  podfileLock: "apps/mobile/ios/Podfile.lock",
  fastfile: "apps/mobile/ios/fastlane/Fastfile",
  appfile: "apps/mobile/ios/fastlane/Appfile",
};

export function createSandbox() {
  const root = mkdtempSync(join(tmpdir(), "pickle-release-attack-"));
  for (const rel of Object.values(FILES)) {
    const dest = join(root, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(repoRoot, rel), dest);
  }
  return root;
}

export function destroySandbox(root) {
  rmSync(root, { recursive: true, force: true });
}

export function readSandbox(root, rel) {
  return readFileSync(join(root, rel), "utf8");
}

export function writeSandbox(root, rel, text) {
  writeFileSync(join(root, rel), text);
}

/** Replace exactly `count` occurrences (default: all) of `from` with `to`; throws if absent. */
export function replaceIn(root, rel, from, to, count = Infinity) {
  const text = readSandbox(root, rel);
  if (!text.includes(from)) throw new Error(`${rel}: expected to find ${JSON.stringify(from)}`);
  let out = "";
  let rest = text;
  let n = 0;
  while (n < count) {
    const idx = rest.indexOf(from);
    if (idx < 0) break;
    out += rest.slice(0, idx) + to;
    rest = rest.slice(idx + from.length);
    n += 1;
  }
  writeSandbox(root, rel, out + rest);
  return n;
}

export function editManifest(root, mutate) {
  const manifest = JSON.parse(readSandbox(root, FILES.manifest));
  const next = mutate(manifest) ?? manifest;
  writeSandbox(root, FILES.manifest, JSON.stringify(next, null, 2));
}

function run(cwd, script) {
  const res = spawnSync(process.execPath, [script], {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  return {
    exitCode: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    failLines: (res.stdout ?? "")
      .split("\n")
      .filter((line) => line.startsWith("FAIL"))
      .map((line) => line.trim()),
  };
}

export function runReleaseCheck(root) {
  return run(root, join(root, FILES.releaseChecker));
}

export function runDistributionCheck(root) {
  return run(join(root, "apps/mobile"), join(root, FILES.distributionChecker));
}

export function runBoth(root) {
  return { releaseCheck: runReleaseCheck(root), distributionCheck: runDistributionCheck(root) };
}
